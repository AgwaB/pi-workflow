import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { runWorkflow, waitForRun } from "../../.tmp/unit/engine.js";
import { setSubagentApiForTests } from "../../.tmp/unit/subagent-backend.js";

const UNIT_TEST_HOME = mkdtempSync(join(tmpdir(), "workflow-refresh-home-"));
process.env.HOME = UNIT_TEST_HOME;
process.env.USERPROFILE = UNIT_TEST_HOME;

after(() => {
	rmSync(UNIT_TEST_HOME, { recursive: true, force: true });
});

function makeProject() {
	return mkdtempSync(join(tmpdir(), "workflow-refresh-"));
}

function writeAgent(cwd, name, tools = "read") {
	const dir = join(cwd, ".pi", "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${name}.md`),
		`---\ndescription: ${name}\ntools: [${tools
			.split(/,\s*/)
			.filter(Boolean)
			.map((tool) => JSON.stringify(tool))
			.join(
				", ",
			)}]\nreadOnly: true\n---\n# ${name}\n\nUse repository evidence.\n`,
	);
}

function writeWorkflow(cwd) {
	const workflowDir = join(cwd, "workflows", "wait-refresh");
	mkdirSync(workflowDir, { recursive: true });
	writeFileSync(
		join(workflowDir, "spec.json"),
		JSON.stringify({
			schemaVersion: 1,
			name: "wait-refresh",
			defaults: { agent: "unit-scout", readOnly: true, tools: ["read"] },
			artifactGraph: {
				stages: [
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
			"Completed after transient refresh failure.",
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

test("waitForRun records transient refresh poll failures and continues", async () => {
	const cwd = makeProject();
	const runs = new Map();
	let launchCount = 0;
	let reconcileCalls = 0;
	try {
		writeAgent(cwd, "unit-scout", "read");
		writeWorkflow(cwd);
		setSubagentApiForTests({
			async runSubagent(options) {
				launchCount += 1;
				const runId = `run_wait_refresh_${launchCount}`;
				const attemptId = `attempt_wait_refresh_${launchCount}`;
				const runsDir = String(options.runsDir ?? ".pi/agent/runs");
				const artifactDir = writeCompletedSubagentArtifacts(
					cwd,
					runsDir,
					runId,
					attemptId,
				);
				runs.set(runId, { runId, attemptId, artifactDir });
				return { runId, attemptId, status: "running" };
			},
			async reconcileSubagentRun() {
				reconcileCalls += 1;
				if (reconcileCalls === 1)
					throw new Error("transient provider refresh blip");
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
						{
							type: "output",
							path: "output.log",
							artifactCwd: run.artifactDir,
						},
						{
							type: "stderr",
							path: "stderr.log",
							artifactCwd: run.artifactDir,
						},
						{
							type: "result",
							path: "result.json",
							artifactCwd: run.artifactDir,
						},
					],
					metadata: { contextLengthExceeded: false },
					attempts: [{ attemptId: run.attemptId, status: "completed" }],
				};
			},
			async interruptSubagent() {
				return {};
			},
		});

		const started = await runWorkflow("wait-refresh", cwd, {
			task: "Exercise transient refresh handling.",
		});
		assert.equal(started.status, "running");

		const completed = await waitForRun(cwd, started.runId, 5_000);
		assert.equal(completed.status, "completed");
		assert.equal(completed.tasks[0].status, "completed");
		assert.ok(reconcileCalls >= 2);

		assert.equal(launchCount, 1);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});
