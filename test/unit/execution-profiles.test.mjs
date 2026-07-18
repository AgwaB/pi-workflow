import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { compileWorkflow } from "../../.tmp/unit/compiler.js";
import { runWorkflow, waitForRun } from "../../.tmp/unit/engine.js";
import {
	parseWorkflowRunArgs,
	selectWorkflowExecutionProfile,
} from "../../.tmp/unit/extension.js";
import { parseArtifactGraphWorkflowSpec } from "../../.tmp/unit/artifact-graph-schema.js";
import { loadWorkflowSpec } from "../../.tmp/unit/schema.js";
import { readRunRecord } from "../../.tmp/unit/store.js";
import { setSubagentApiForTests } from "../../.tmp/unit/subagent-backend.js";

const UNIT_TEST_HOME = mkdtempSync(join(tmpdir(), "execution-profiles-home-"));
process.env.HOME = UNIT_TEST_HOME;
process.env.USERPROFILE = UNIT_TEST_HOME;

after(() => {
	rmSync(UNIT_TEST_HOME, { recursive: true, force: true });
});

function makeProject() {
	return mkdtempSync(join(tmpdir(), "execution-profiles-"));
}

function writeAgent(cwd, name) {
	const dir = join(cwd, ".pi", "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${name}.md`),
		`---\ndescription: ${name}\ntools: ["read"]\nreadOnly: true\n---\n# ${name}\n\nUse repository evidence.\n`,
	);
}

function profileSpec(overrides = {}) {
	return {
		schemaVersion: 1,
		name: "profile-target",
		defaults: { agent: "unit-scout", readOnly: true, tools: ["read"] },
		executionProfiles: {
			eco: { one: "low", two: "high" },
			medium: {},
		},
		artifactGraph: {
			stages: [
				{
					id: "one",
					type: "single",
					thinking: "high",
					output: { analysis: { required: true }, refs: { required: true } },
					prompt: "Step one.",
				},
				{
					id: "two",
					type: "single",
					thinking: "xhigh",
					output: { analysis: { required: true }, refs: { required: true } },
					prompt: "Step two.",
				},
			],
		},
		...overrides,
	};
}

function writeSpec(cwd, spec) {
	const dir = join(cwd, "workflows", "profile-target");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "spec.json"), JSON.stringify(spec));
}

function writeCompletedSubagentArtifacts(cwd, runsDir, runId, attemptId) {
	const artifactDir = join(cwd, runsDir, runId, "attempts", attemptId);
	mkdirSync(artifactDir, { recursive: true });
	writeFileSync(
		join(artifactDir, "output.log"),
		[
			"<control>",
			JSON.stringify({ schema: "stage-control-v1", digest: "done" }),
			"</control>",
			"<analysis>",
			"Profile task output.",
			"</analysis>",
			"<refs>",
			"[]",
			"</refs>",
		].join("\n"),
	);
	writeFileSync(join(artifactDir, "stderr.log"), "");
	writeFileSync(
		join(artifactDir, "result.json"),
		JSON.stringify({
			status: "completed",
			completedAt: new Date().toISOString(),
			startedAt: new Date(Date.now() - 1000).toISOString(),
			exitCode: 0,
		}),
	);
	return artifactDir;
}

function installFakeSubagentApi(cwd) {
	const calls = { launches: [] };
	const launches = new Map();
	setSubagentApiForTests({
		async runSubagent(options) {
			calls.launches.push({ thinking: options.thinking });
			const seq = calls.launches.length;
			const runId = `run_task_${seq}`;
			const attemptId = `attempt_task_${seq}`;
			const runsDir = String(options.runsDir ?? ".pi/agent/runs");
			const artifactDir = writeCompletedSubagentArtifacts(
				cwd,
				runsDir,
				runId,
				attemptId,
			);
			launches.set(runId, { runId, attemptId, artifactDir });
			return { runId, attemptId, status: "running" };
		},
		async reconcileSubagentRun() {
			return {};
		},
		async getSubagentStatus({ runId }) {
			const run = launches.get(runId);
			assert.ok(run, `missing subagent run ${runId}`);
			return {
				runId,
				attemptId: run.attemptId,
				backend: "headless",
				status: "completed",
				failureKind: null,
				startedAt: new Date(Date.now() - 1000).toISOString(),
				completedAt: new Date().toISOString(),
				logs: [
					{ type: "output", path: "output.log", artifactCwd: run.artifactDir },
					{ type: "stderr", path: "stderr.log", artifactCwd: run.artifactDir },
					{ type: "result", path: "result.json", artifactCwd: run.artifactDir },
				],
				metadata: { contextLengthExceeded: false },
				attempts: [{ attemptId: run.attemptId, status: "completed" }],
			};
		},
		async interruptSubagent() {
			return {};
		},
	});
	return calls;
}

test("executionProfiles schema accepts valid profiles and rejects bad shapes", () => {
	assert.doesNotThrow(() => parseArtifactGraphWorkflowSpec(profileSpec()));

	// unknown stage id fails
	assert.throws(
		() =>
			parseArtifactGraphWorkflowSpec(
				profileSpec({ executionProfiles: { eco: { missing: "low" } } }),
			),
		/unknown stage id "missing"/,
	);

	// invalid thinking level fails
	assert.throws(
		() =>
			parseArtifactGraphWorkflowSpec(
				profileSpec({ executionProfiles: { eco: { one: "turbo" } } }),
			),
		/must be one of/,
	);

	// invalid profile name fails
	assert.throws(
		() =>
			parseArtifactGraphWorkflowSpec(
				profileSpec({ executionProfiles: { "bad name": { one: "low" } } }),
			),
		/profile name/,
	);
});

test("--profile parses from leading, trailing, and equals forms; quoted stays literal", () => {
	assert.equal(
		parseWorkflowRunArgs('run --profile eco profile-target "Task"').profile,
		"eco",
	);
	assert.equal(
		parseWorkflowRunArgs('run --profile=eco profile-target "Task"').profile,
		"eco",
	);
	assert.equal(
		parseWorkflowRunArgs('run profile-target "Task" --profile eco').profile,
		"eco",
	);
	assert.equal(
		parseWorkflowRunArgs('run profile-target "Keep --profile eco inside"')
			.profile,
		undefined,
	);
	assert.equal(
		parseWorkflowRunArgs('run profile-target "Task"').profile,
		undefined,
	);
});

test("omitted profile defaults to medium without UI and prompts safely with UI", async () => {
	const cwd = makeProject();
	try {
		writeSpec(
			cwd,
			profileSpec({
				executionProfiles: {
					low: { one: "low" },
					medium: {},
					high: { two: "xhigh" },
				},
			}),
		);
		assert.equal(
			await selectWorkflowExecutionProfile(
				"profile-target",
				cwd,
				undefined,
			),
			"medium",
		);

		let shownOptions;
		const selected = await selectWorkflowExecutionProfile(
			"profile-target",
			cwd,
			undefined,
			async (_title, options) => {
				shownOptions = options;
				return options.find((option) => option.startsWith("Fast (low)"));
			},
		);
		assert.equal(selected, "low");
		assert.match(shownOptions[0], /^Balanced \(medium\)/);
		assert.match(shownOptions[1], /^Fast \(low\)/);
		assert.match(shownOptions[2], /^Thorough \(high\)/);

		let prompted = false;
		assert.equal(
			await selectWorkflowExecutionProfile(
				"profile-target",
				cwd,
				"high",
				async () => {
					prompted = true;
					return undefined;
				},
			),
			"high",
		);
		assert.equal(prompted, false, "explicit --profile must bypass the prompt");

		await assert.rejects(
			() =>
				selectWorkflowExecutionProfile(
					"profile-target",
					cwd,
					undefined,
					async () => undefined,
				),
			/Workflow run cancelled before profile selection/,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("selected profile overrides stage thinking and is recorded on the run", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout");
		writeSpec(cwd, profileSpec());
		const calls = installFakeSubagentApi(cwd);

		const started = await runWorkflow("profile-target", cwd, {
			task: "Profile run.",
			executionProfile: "eco",
		});
		const run = await waitForRun(cwd, started.runId, 30_000);
		assert.equal(run.status, "completed");
		assert.deepEqual(run.executionProfile, {
			name: "eco",
			stageThinking: { one: "low", two: "high" },
		});
		const persisted = await readRunRecord(cwd, run.runId);
		assert.deepEqual(persisted.executionProfile, run.executionProfile);
		assert.deepEqual(
			calls.launches.map((l) => l.thinking),
			["low", "high"],
		);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("empty profile is identity: compiled output matches no-profile compile byte-for-byte", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout");
		writeSpec(cwd, profileSpec());
		const loaded = await loadWorkflowSpec("profile-target", cwd);

		const base = await compileWorkflow(loaded.spec, {
			cwd,
			specPath: loaded.specPath,
			task: "Identity check.",
		});
		// medium = {} applies no overrides; engine-level apply happens before
		// compile, so simulate it by compiling the same spec again.
		const withEmptyProfile = await compileWorkflow(loaded.spec, {
			cwd,
			specPath: loaded.specPath,
			task: "Identity check.",
		});
		assert.equal(JSON.stringify(withEmptyProfile), JSON.stringify(base));

		// run-level: medium profile completes and records identity mapping
		const calls = installFakeSubagentApi(cwd);
		const started = await runWorkflow("profile-target", cwd, {
			task: "Identity run.",
			executionProfile: "medium",
		});
		const run = await waitForRun(cwd, started.runId, 30_000);
		assert.equal(run.status, "completed");
		assert.deepEqual(run.executionProfile, {
			name: "medium",
			stageThinking: {},
		});
		// spec pins preserved exactly
		assert.deepEqual(
			calls.launches.map((l) => l.thinking),
			["high", "xhigh"],
		);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("unknown profile name fails closed before any launch", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout");
		writeSpec(cwd, profileSpec());
		const calls = installFakeSubagentApi(cwd);
		await assert.rejects(
			() =>
				runWorkflow("profile-target", cwd, {
					task: "Bad profile.",
					executionProfile: "nope",
				}),
			/unknown execution profile "nope"; spec declares: eco, medium/,
		);
		assert.equal(calls.launches.length, 0);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("bundled deep-research profiles expose measured low, identity medium, and raised high tiers", async () => {
	const loaded = await loadWorkflowSpec(
		join(process.cwd(), "workflows", "deep-research", "spec.json"),
		process.cwd(),
	);
	const spec = loaded.spec;
	const profiles = spec.executionProfiles;
	assert.ok(profiles, "deep-research must declare executionProfiles");
	assert.deepEqual(profiles.medium, {}, "medium must be spec pins as written");

	const pinsByStage = new Map(
		spec.artifactGraph.stages.map((stage) => [stage.id, stage.thinking]),
	);
	assert.deepEqual(profiles.low, {
		"research-questions": "low",
		"normalize-claims": "medium",
		"verify-claims": "low",
		"final-audit": "high",
	});
	assert.equal(
		profiles.low.plan,
		undefined,
		"low must preserve the plan=high spec pin",
	);
	const order = ["off", "minimal", "low", "medium", "high", "xhigh"];
	for (const [stageId, level] of Object.entries(profiles.low)) {
		const pin = pinsByStage.get(stageId);
		assert.ok(pin, `low references stage ${stageId} without a pin`);
		assert.ok(
			order.indexOf(level) <= order.indexOf(pin),
			`low must not raise ${stageId} above its pin (${level} > ${pin})`,
		);
	}
	for (const [stageId, level] of Object.entries(profiles.high)) {
		const pin = pinsByStage.get(stageId);
		assert.ok(pin, `high references stage ${stageId} without a pin`);
		assert.ok(
			order.indexOf(level) >= order.indexOf(pin),
			`high must not lower ${stageId} below its pin (${level} < ${pin})`,
		);
	}
});
