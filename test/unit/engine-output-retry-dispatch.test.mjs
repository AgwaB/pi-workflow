import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { refreshRun, runWorkflow, waitForRun } from "../../.tmp/unit/engine.js";
import {
	ARTIFACT_OUTPUT_RETRIES_ENV,
	setSubagentApiForTests,
} from "../../.tmp/unit/subagent-backend.js";

const UNIT_TEST_HOME = mkdtempSync(join(tmpdir(), "workflow-retry-dispatch-home-"));
process.env.HOME = UNIT_TEST_HOME;
process.env.USERPROFILE = UNIT_TEST_HOME;

after(() => {
	rmSync(UNIT_TEST_HOME, { recursive: true, force: true });
});

function makeProject() {
	return mkdtempSync(join(tmpdir(), "workflow-retry-dispatch-"));
}

function writeAgent(cwd, name) {
	const dir = join(cwd, ".pi", "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${name}.md`),
		`---\ndescription: ${name}\ntools: ["read"]\nreadOnly: true\n---\n# ${name}\n\nUse repository evidence.\n`,
	);
}

function writeWorkflow(cwd, name, stages) {
	const workflowDir = join(cwd, "workflows", name);
	mkdirSync(workflowDir, { recursive: true });
	writeFileSync(
		join(workflowDir, "spec.json"),
		JSON.stringify({
			schemaVersion: 1,
			name,
			defaults: { agent: "unit-scout", readOnly: true, tools: ["read"] },
			artifactGraph: {
				stages: stages ?? [
					{
						id: "main",
						type: "single",
						output: {
							analysis: { required: true },
							refs: { required: true },
						},
						prompt: "Do the work.",
					},
				],
			},
		}),
	);
}

const TWO_STAGE_SPEC = [
	{
		id: "first",
		type: "single",
		output: { analysis: { required: true }, refs: { required: true } },
		prompt: "Do the first stage.",
	},
	{
		id: "second",
		type: "single",
		after: ["first"],
		output: { analysis: { required: true }, refs: { required: true } },
		prompt: "Do the second stage.",
	},
];

const VALID_OUTPUT = [
	"<control>",
	JSON.stringify({ schema: "stage-control-v1", digest: "done" }),
	"</control>",
	"<analysis>",
	"Completed with a valid workflow output contract.",
	"</analysis>",
	"<refs>",
	"[]",
	"</refs>",
].join("\n");

// Malformed control JSON: process exits 0, but workflow output validation
// must reject it and schedule a bounded output retry (the July-4 signature).
const INVALID_OUTPUT = [
	"<control>",
	'{"schema": "stage-control-v1", "digest": }',
	"</control>",
	"<analysis>",
	"Completed at the process level but the control JSON is malformed.",
	"</analysis>",
	"<refs>",
	"[]",
	"</refs>",
].join("\n");

function writeSubagentArtifacts(cwd, runsDir, runId, attemptId, outputText) {
	const artifactDir = join(cwd, runsDir, runId, "attempts", attemptId);
	mkdirSync(artifactDir, { recursive: true });
	writeFileSync(join(artifactDir, "output.log"), outputText);
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

function makeFakeSubagentApi({ cwd, runs, outputsByLaunch, onLaunch }) {
	return {
		async runSubagent(options) {
			const launchIndex = onLaunch();
			const runId = `run_retry_dispatch_${launchIndex}`;
			const attemptId = `attempt_retry_dispatch_${launchIndex}`;
			const runsDir = String(options.runsDir ?? ".pi/agent/runs");
			const outputText =
				outputsByLaunch[launchIndex - 1] ??
				outputsByLaunch[outputsByLaunch.length - 1];
			const artifactDir = writeSubagentArtifacts(
				cwd,
				runsDir,
				runId,
				attemptId,
				outputText,
			);
			runs.set(runId, { runId, attemptId, artifactDir });
			return { runId, attemptId, status: "running" };
		},
		async reconcileSubagentRun() {
			return {};
		},
		async getSubagentStatus({ runId }) {
			const run = runs.get(runId);
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
	};
}

test("a task whose attempt passed output validation is never re-dispatched by later refreshes", async () => {
	const cwd = makeProject();
	const runs = new Map();
	let launchCount = 0;
	try {
		writeAgent(cwd, "unit-scout");
		writeWorkflow(cwd, "valid-once");
		setSubagentApiForTests(
			makeFakeSubagentApi({
				cwd,
				runs,
				outputsByLaunch: [VALID_OUTPUT],
				onLaunch: () => {
					launchCount += 1;
					return launchCount;
				},
			}),
		);

		const started = await runWorkflow("valid-once", cwd, {
			task: "Exercise the completed-task dispatch invariant.",
		});
		const completed = await waitForRun(cwd, started.runId, 20_000);
		assert.equal(completed.status, "completed");
		assert.equal(completed.tasks[0].status, "completed");
		assert.equal(completed.tasks[0].outputRetry, undefined);
		assert.equal(launchCount, 1);

		// Invariant under test: refresh/reconcile after completion must never
		// launch another subagent run for a task with a valid completed attempt.
		for (let i = 0; i < 3; i += 1) {
			const refreshed = await refreshRun(cwd, started.runId);
			assert.equal(refreshed.status, "completed");
			assert.equal(refreshed.tasks[0].status, "completed");
		}
		assert.equal(launchCount, 1);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a completed upstream task is not re-dispatched while downstream stages still schedule", async () => {
	const cwd = makeProject();
	const runs = new Map();
	let launchCount = 0;
	try {
		writeAgent(cwd, "unit-scout");
		writeWorkflow(cwd, "two-stage", TWO_STAGE_SPEC);
		setSubagentApiForTests(
			makeFakeSubagentApi({
				cwd,
				runs,
				outputsByLaunch: [VALID_OUTPUT, VALID_OUTPUT],
				onLaunch: () => {
					launchCount += 1;
					return launchCount;
				},
			}),
		);

		const started = await runWorkflow("two-stage", cwd, {
			task: "Exercise completed-task invariance across later scheduler ticks.",
		});
		const completed = await waitForRun(cwd, started.runId, 20_000);
		assert.equal(completed.status, "completed");
		for (const task of completed.tasks) {
			assert.equal(task.status, "completed");
		}

		// The scheduler ticks that launch stage "second" must not re-dispatch
		// the already-completed stage "first": exactly one launch per stage.
		assert.equal(launchCount, 2);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("zero output retry override fails the first invalid workflow output", async () => {
	const cwd = makeProject();
	const runs = new Map();
	const previous = process.env[ARTIFACT_OUTPUT_RETRIES_ENV];
	let launchCount = 0;
	process.env[ARTIFACT_OUTPUT_RETRIES_ENV] = "0";
	try {
		writeAgent(cwd, "unit-scout");
		writeWorkflow(cwd, "invalid-no-retry");
		setSubagentApiForTests(
			makeFakeSubagentApi({
				cwd,
				runs,
				outputsByLaunch: [INVALID_OUTPUT],
				onLaunch: () => {
					launchCount += 1;
					return launchCount;
				},
			}),
		);

		const started = await runWorkflow("invalid-no-retry", cwd, {
			task: "Exercise disabled output-invalid retry dispatch.",
		});
		const failed = await waitForRun(cwd, started.runId, 20_000);
		assert.equal(failed.status, "failed");
		assert.equal(failed.tasks[0].status, "failed");
		assert.equal(failed.tasks[0].outputRetry?.attempts, 1);
		assert.equal(failed.tasks[0].outputRetry?.maxAttempts, 0);
		assert.equal(launchCount, 1);
	} finally {
		if (previous === undefined)
			delete process.env[ARTIFACT_OUTPUT_RETRIES_ENV];
		else process.env[ARTIFACT_OUTPUT_RETRIES_ENV] = previous;
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("workflow-invalid output triggers exactly one bounded repair launch, then no further dispatch", async () => {
	const cwd = makeProject();
	const runs = new Map();
	let launchCount = 0;
	try {
		writeAgent(cwd, "unit-scout");
		writeWorkflow(cwd, "invalid-then-valid");
		setSubagentApiForTests(
			makeFakeSubagentApi({
				cwd,
				runs,
				outputsByLaunch: [INVALID_OUTPUT, VALID_OUTPUT],
				onLaunch: () => {
					launchCount += 1;
					return launchCount;
				},
			}),
		);

		const started = await runWorkflow("invalid-then-valid", cwd, {
			task: "Exercise bounded output-invalid retry dispatch.",
		});
		const completed = await waitForRun(cwd, started.runId, 20_000);
		assert.equal(completed.status, "completed");
		const task = completed.tasks[0];
		assert.equal(task.status, "completed");

		// The July-4 evidence signature: the first process-level success failed
		// workflow output validation and was retried as a bounded repair, recorded
		// in outputRetry. This fake subagent does not confirm a resumable session,
		// so it exercises the new-session fallback path.
		assert.equal(launchCount, 2);
		assert.ok(task.outputRetry, "outputRetry record must be preserved");
		assert.equal(task.outputRetry.attempts, 1);
		assert.equal(task.outputRetry.reason, "workflow_output_invalid");
		assert.equal(task.outputRetry.repairMode, "new_session");

		// Once the repair attempt validates, the task is terminal: further
		// refreshes must not dispatch a third run.
		for (let i = 0; i < 3; i += 1) {
			const refreshed = await refreshRun(cwd, started.runId);
			assert.equal(refreshed.status, "completed");
			assert.equal(refreshed.tasks[0].status, "completed");
		}
		assert.equal(launchCount, 2);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});
