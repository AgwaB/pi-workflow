import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { runWorkflow } from "../../.tmp/unit/engine.js";
import {
	parseWorkflowDynamicArgs,
	parseWorkflowRunArgs,
} from "../../.tmp/unit/extension.js";
import { readIndex, readRunRecord } from "../../.tmp/unit/store.js";
import { setSubagentApiForTests } from "../../.tmp/unit/subagent-backend.js";
import {
	executeRoutedWorkflowRequest,
	parseWorkflowRouterOutput,
} from "../../.tmp/unit/workflow-router.js";

const UNIT_TEST_HOME = mkdtempSync(join(tmpdir(), "workflow-router-home-"));
process.env.HOME = UNIT_TEST_HOME;
process.env.USERPROFILE = UNIT_TEST_HOME;

after(() => {
	rmSync(UNIT_TEST_HOME, { recursive: true, force: true });
});

const ROUTER_CORRELATION_ID = "workflow-router-pass";
const DIRECT_CORRELATION_ID = "workflow-router-direct";

function makeProject() {
	return mkdtempSync(join(tmpdir(), "workflow-router-"));
}

function writeAgent(cwd, name) {
	const dir = join(cwd, ".pi", "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${name}.md`),
		`---\ndescription: ${name}\ntools: ["read"]\nreadOnly: true\n---\n# ${name}\n\nUse repository evidence.\n`,
	);
}

function writeRoutableWorkflow(cwd) {
	const workflowDir = join(cwd, "workflows", "route-target");
	mkdirSync(workflowDir, { recursive: true });
	writeFileSync(
		join(workflowDir, "spec.json"),
		JSON.stringify({
			schemaVersion: 1,
			name: "route-target",
			input: { depth: "standard" },
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
			"Routed workflow task output.",
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

function installFakeSubagentApi(
	cwd,
	{ routerText, directText = "Direct answer body." } = {},
) {
	const calls = { router: 0, direct: 0, launches: 0 };
	const launches = new Map();

	function oneShotEnvelope(kind, text, seq) {
		const dir = join(cwd, ".pi", "oneshot", `${kind}-${seq}`);
		mkdirSync(dir, { recursive: true });
		const outputPath = join(dir, "output.log");
		writeFileSync(outputPath, text);
		return {
			runId: `run_${kind}_${seq}`,
			attemptId: `attempt_${kind}_${seq}`,
			status: "completed",
			cwd,
			artifacts: [{ type: "output", path: outputPath }],
		};
	}

	setSubagentApiForTests({
		async runSubagent(options) {
			if (options.correlationId === ROUTER_CORRELATION_ID) {
				calls.router += 1;
				if (routerText instanceof Error) throw routerText;
				return oneShotEnvelope("router", routerText, calls.router);
			}
			if (options.correlationId === DIRECT_CORRELATION_ID) {
				calls.direct += 1;
				return oneShotEnvelope("direct", directText, calls.direct);
			}
			calls.launches += 1;
			const runId = `run_task_${calls.launches}`;
			const attemptId = `attempt_task_${calls.launches}`;
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

function routedRequest(cwd, overrides = {}) {
	return {
		cwd,
		task: "Explain how the Node.js test runner is invoked.",
		requestedWorkflow: "route-target",
		...overrides,
	};
}

function readRunDirSpec(cwd, runId) {
	return JSON.parse(
		readFileSync(join(cwd, ".pi", "workflows", runId, "spec.json"), "utf8"),
	);
}

test("--route with high-confidence direct answers without starting a workflow run", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout");
		writeRoutableWorkflow(cwd);
		const calls = installFakeSubagentApi(cwd, {
			routerText: JSON.stringify({
				route: "direct",
				depth: "quick",
				confidence: 0.9,
				reason: "single documented fact",
			}),
		});

		const outcome = await executeRoutedWorkflowRequest(routedRequest(cwd));

		assert.equal(outcome.mode, "direct");
		assert.equal(outcome.answer, "Direct answer body.");
		assert.equal(calls.router, 1);
		assert.equal(calls.direct, 1);
		assert.equal(calls.launches, 0);

		const index = await readIndex(cwd);
		assert.equal(index?.runs?.length ?? 0, 0);

		const logFile = join(cwd, ".pi", "workflows", "routing-log.jsonl");
		assert.ok(existsSync(logFile));
		const entries = readFileSync(logFile, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.equal(entries.length, 1);
		assert.equal(entries[0].mode, "direct");
		assert.equal(entries[0].routing.requested, "route-target");
		assert.equal(entries[0].routing.decided, "direct");
		assert.equal(entries[0].routing.depth, "quick");
		assert.equal(entries[0].routing.confidence, 0.9);
		assert.equal(entries[0].routing.reason, "single documented fact");
		assert.equal(entries[0].routing.routerThinking, "low");
		assert.equal(Number.isInteger(entries[0].routing.routerElapsedMs), true);
		assert.equal(entries[0].routing.routerElapsedMs >= 0, true);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("--route with high-confidence workflow starts the workflow with routed depth input", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout");
		writeRoutableWorkflow(cwd);
		const calls = installFakeSubagentApi(cwd, {
			routerText: JSON.stringify({
				route: "workflow",
				depth: "quick",
				confidence: 0.95,
				reason: "multi-source synthesis is warranted",
			}),
		});

		const outcome = await executeRoutedWorkflowRequest(routedRequest(cwd));

		assert.equal(outcome.mode, "workflow");
		assert.equal(calls.router, 1);
		assert.equal(calls.direct, 0);
		assert.ok(calls.launches >= 1);

		const run = await readRunRecord(cwd, outcome.run.runId);
		assert.equal(run.routing.requested, "route-target");
		assert.equal(run.routing.decided, "workflow");
		assert.equal(run.routing.depth, "quick");
		assert.equal(run.routing.confidence, 0.95);
		assert.equal(run.routing.reason, "multi-source synthesis is warranted");
		assert.equal(run.routing.routerModel, "session-default");
		assert.equal(run.routing.routerThinking, "low");
		assert.equal(Number.isInteger(run.routing.routerElapsedMs), true);
		assert.equal(run.routing.routerElapsedMs >= 0, true);
		assert.equal(readRunDirSpec(cwd, run.runId).input.depth, "quick");
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("--route escalates low-confidence decisions to the requested workflow at standard depth", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout");
		writeRoutableWorkflow(cwd);
		const calls = installFakeSubagentApi(cwd, {
			routerText: JSON.stringify({
				route: "direct",
				depth: "quick",
				confidence: 0.4,
				reason: "probably simple",
			}),
		});

		const outcome = await executeRoutedWorkflowRequest(routedRequest(cwd));

		assert.equal(outcome.mode, "workflow");
		assert.equal(calls.direct, 0);

		const run = await readRunRecord(cwd, outcome.run.runId);
		assert.equal(run.routing.decided, "workflow");
		assert.equal(run.routing.depth, "standard");
		assert.equal(run.routing.confidence, 0.4);
		assert.equal(Number.isInteger(run.routing.routerElapsedMs), true);
		assert.equal(run.routing.routerElapsedMs >= 0, true);
		assert.match(run.routing.reason, /confidence 0\.4 below 0\.6/);
		assert.match(run.routing.reason, /escalated to workflow at standard depth/);
		assert.equal(readRunDirSpec(cwd, run.runId).input.depth, "standard");
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("--route escalates invalid router JSON to the requested workflow at standard depth", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout");
		writeRoutableWorkflow(cwd);
		const calls = installFakeSubagentApi(cwd, {
			routerText: "definitely not control JSON",
		});

		const outcome = await executeRoutedWorkflowRequest(routedRequest(cwd));

		assert.equal(outcome.mode, "workflow");
		assert.equal(calls.direct, 0);

		const run = await readRunRecord(cwd, outcome.run.runId);
		assert.equal(run.routing.decided, "workflow");
		assert.equal(run.routing.depth, "standard");
		assert.equal(run.routing.confidence, 0);
		assert.equal(Number.isInteger(run.routing.routerElapsedMs), true);
		assert.equal(run.routing.routerElapsedMs >= 0, true);
		assert.match(run.routing.reason, /not valid control JSON/);
		assert.equal(readRunDirSpec(cwd, run.runId).input.depth, "standard");

		// Missing-field variants are rejected the same way.
		assert.equal(
			parseWorkflowRouterOutput(
				JSON.stringify({ route: "direct", confidence: 0.9, reason: "x" }),
			),
			undefined,
		);
		assert.equal(
			parseWorkflowRouterOutput(
				JSON.stringify({
					route: "direct",
					depth: "quick",
					confidence: 1.4,
					reason: "x",
				}),
			),
			undefined,
		);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("runs without --route never invoke the router subagent", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout");
		writeRoutableWorkflow(cwd);
		const calls = installFakeSubagentApi(cwd, {
			routerText: JSON.stringify({
				route: "direct",
				depth: "quick",
				confidence: 0.9,
				reason: "unused",
			}),
		});

		assert.equal(
			parseWorkflowRunArgs('run route-target "Task"').route,
			undefined,
		);
		assert.equal(parseWorkflowDynamicArgs('dynamic "Task"').route, undefined);
		assert.equal(
			parseWorkflowRunArgs('run --route route-target "Task"').route,
			true,
		);
		assert.equal(
			parseWorkflowDynamicArgs('dynamic --route "Task"').route,
			true,
		);
		assert.equal(
			parseWorkflowRunArgs('run route-target "Keep literal --route inside"')
				.route,
			undefined,
		);

		const run = await runWorkflow("route-target", cwd, {
			task: "Plain run without routing.",
		});
		assert.equal(run.routing, undefined);
		assert.equal(calls.router, 0);
		assert.equal(calls.direct, 0);
		assert.ok(calls.launches >= 1);

		const persisted = await readRunRecord(cwd, run.runId);
		assert.equal(persisted.routing, undefined);
		assert.equal(readRunDirSpec(cwd, run.runId).input.depth, "standard");
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});
