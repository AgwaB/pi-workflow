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
