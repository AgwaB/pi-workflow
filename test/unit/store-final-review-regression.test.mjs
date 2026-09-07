import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
	artifactGraphWorkflowSpec,
	compileWorkflow,
	createRunRecord,
	flushPendingIndexUpdatesForTests,
	makeProject,
	setIndexUpdateDebounceMsForTests,
	withRunLease,
	writeAgent,
	writeRunRecord,
	writeStaticRunArtifacts,
} from "./unit-test-support.mjs";
import { finalStageTasks } from "../../.tmp/unit/store.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("frozen bundles collect decision-loop providers and TypeScript import closure", async () => {
	const cwd = makeProject();
	try {
		const workflowDir = join(cwd, "workflows", "bundle");
		const providerDir = join(workflowDir, "providers");
		mkdirSync(providerDir, { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(providerDir, "planner.ts"),
			'import { marker } from "./planner-helper";\nexport default marker;\n',
		);
		writeFileSync(
			join(providerDir, "planner-helper.mts"),
			'export const marker = "frozen";\n',
		);
		writeFileSync(
			join(providerDir, "allowed.cts"),
			'module.exports = "allowed";\n',
		);

		const plannerProvider = {
			name: "planner_provider",
			extensions: ["./providers/planner.ts"],
			classification: "read-only",
		};
		const allowedProvider = {
			name: "allowed_provider",
			extensions: ["./providers/allowed.cts"],
			classification: "read-only",
		};
		const spec = {
			schemaVersion: 1,
			name: "decision-loop-provider-bundle",
			artifactGraph: {
				stages: [
					{
						id: "controller",
						type: "dynamic",
						dynamic: {
							uses: "./controller.mjs",
							decisionLoop: {
								planner: { tools: [plannerProvider] },
								allowedTools: [allowedProvider],
							},
						},
					},
				],
			},
		};
		writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);
		writeFileSync(join(workflowDir, "controller.mjs"), "export default () => {};\n");

		const runId = "workflow_decision_loop_bundle";
		const run = { runId, specPath, tasks: [] };
		const compiled = {
			name: spec.name,
			tasks: [
				{
					dynamic: {
						decisionLoop: {
							planner: {
								toolProviders: {
									planner_provider: plannerProvider,
								},
							},
							allowedToolProviders: {
								allowed_provider: allowedProvider,
							},
						},
					},
				},
			],
		};
		await writeStaticRunArtifacts(cwd, run, compiled, spec);

		const bundleDir = join(cwd, ".pi", "workflows", runId, "bundle");
		for (const relativePath of [
			"providers/planner.ts",
			"providers/planner-helper.mts",
			"providers/allowed.cts",
		]) {
			assert.equal(
				existsSync(join(bundleDir, relativePath)),
				true,
				`${relativePath} is frozen into the run bundle`,
			);
		}
		const persisted = JSON.parse(
			readFileSync(
				join(cwd, ".pi", "workflows", runId, "compiled.json"),
				"utf8",
			),
		);
		assert.equal(
			persisted.tasks[0].dynamic.decisionLoop.planner.toolProviders
				.planner_provider.extensions[0],
			join(bundleDir, "providers", "planner.ts"),
		);
		assert.equal(
			persisted.tasks[0].dynamic.decisionLoop.allowedToolProviders
				.allowed_provider.extensions[0],
			join(bundleDir, "providers", "allowed.cts"),
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("final stage selection excludes only proven foreach scheduling placeholders", () => {
	const task = (specId, options = {}) => ({
		taskId: `task-${specId}`,
		specId,
		kind: "single",
		status: "completed",
		statusDetail: "completed",
		...options,
	});
	const placeholder = (specId, statusDetail, options = {}) =>
		task(specId, {
			kind: "foreach",
			statusDetail,
			...options,
		});
	const generated = (specId, placeholderSpecId, options = {}) =>
		task(specId, {
			kind: "foreach",
			foreachGenerated: { placeholderSpecId },
			...options,
		});

	// This is the captured deep-review shape: materialized foreach parents are
	// orphaned by dependency replacement, while final.main is authoritative.
	const actualShape = [
		task("triage.main"),
		placeholder("reviewers.item", "foreach_materialized", {
			dependsOn: ["triage.main"],
			dispatchMap: {},
		}),
		generated("reviewers.security", "reviewers.item", {
			dependsOn: ["triage.main"],
		}),
		task("dedup-findings.main", {
			kind: "support",
			dependsOn: ["reviewers.security"],
		}),
		task("report.main", { kind: "reduce", dependsOn: ["dedup-findings.main"] }),
		task("final.main", {
			kind: "support",
			dependsOn: ["report.main"],
		}),
	];
	assert.deepEqual(
		finalStageTasks(actualShape).map((candidate) => candidate.specId),
		["final.main"],
	);

	assert.deepEqual(
		finalStageTasks([
			placeholder("empty.item", "foreach_empty"),
		]).map((candidate) => candidate.specId),
		[],
	);
	assert.deepEqual(
		finalStageTasks([
			placeholder("stream.item", "foreach_streaming_complete"),
			generated("stream.one", "stream.item"),
		]).map((candidate) => candidate.specId),
		["stream.one"],
	);
	assert.deepEqual(
		finalStageTasks([
			placeholder("materialized.item", "completed", {
				dispatchMap: {},
			}),
			task("authoritative.support", { kind: "support" }),
		]).map((candidate) => candidate.specId),
		["authoritative.support"],
	);
	assert.deepEqual(
		finalStageTasks([
			placeholder("child-evidence.item", "completed"),
			generated("child-evidence.one", "child-evidence.item"),
		]).map((candidate) => candidate.specId),
		["child-evidence.one"],
	);

	// A real model foreach leaf and a legacy foreach record without scheduler
	// evidence remain governed by the existing regular-leaf behavior.
	const realModelLeaf = task("model.foreach", { kind: "foreach" });
	const legacyForeach = task("legacy.foreach", {
		kind: "foreach",
		statusDetail: "completed",
	});
	assert.deepEqual(
		finalStageTasks([realModelLeaf, task("trailing.support", { kind: "support" })]).map(
			(candidate) => candidate.specId,
		),
		["model.foreach"],
	);
	assert.deepEqual(
		finalStageTasks([legacyForeach]).map((candidate) => candidate.specId),
		["legacy.foreach"],
	);
	assert.deepEqual(
		finalStageTasks([
			task("partial.model", { status: "failed" }),
			task("interrupted.support", { kind: "support", status: "interrupted" }),
		]).map((candidate) => candidate.specId),
		["partial.model"],
	);
});

test("debounced index writes outlive the run lease that scheduled them", async () => {
	const cwd = makeProject();
	setIndexUpdateDebounceMsForTests(20);
	try {
		writeAgent(cwd, "unit-scout", "read");
		const compiled = await compileWorkflow(artifactGraphWorkflowSpec(), {
			cwd,
			task: "Lease-neutral index debounce",
		});
		const runId = "workflow_lease_neutral_index";
		const { run } = await createRunRecord(
			cwd,
			compiled,
			join(cwd, "lease-neutral-index.json"),
			{ runId },
		);
		await withRunLease(cwd, runId, async () => {
			await writeRunRecord(cwd, run);
			run.name = "updated after first index write";
			await writeRunRecord(cwd, run);
		});

		const indexPath = join(cwd, ".pi", "workflows", "index.json");
		let indexed;
		for (let attempt = 0; attempt < 50; attempt += 1) {
			indexed = JSON.parse(readFileSync(indexPath, "utf8")).runs.find(
				(entry) => entry.runId === runId,
			);
			if (indexed?.name === run.name) break;
			await sleep(10);
		}
		assert.equal(indexed?.name, run.name);
	} finally {
		setIndexUpdateDebounceMsForTests(undefined);
		await flushPendingIndexUpdatesForTests().catch(() => undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});
