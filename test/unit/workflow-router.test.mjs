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
			executionProfiles: {
				medium: {},
				low: { main: { thinking: "low" } },
			},
			artifactGraph: {
				stages: [
					{
						id: "main",
						type: "single",
						thinking: "high",
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
	{
		routerText,
		directText = "Direct answer body.",
		keepTaskRunning = false,
		routerGate,
	} = {},
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
				if (routerGate) await routerGate;
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
				status: keepTaskRunning ? "running" : "completed",
				failureKind: null,
				startedAt: new Date(Date.now() - 1000).toISOString(),
				completedAt: new Date().toISOString(),
				logs: [
					{ type: "output", path: "output.log", artifactCwd: run.artifactDir },
					{ type: "stderr", path: "stderr.log", artifactCwd: run.artifactDir },
					{ type: "result", path: "result.json", artifactCwd: run.artifactDir },
				],
				metadata: { contextLengthExceeded: false },
				attempts: [
					{
						attemptId: run.attemptId,
						status: keepTaskRunning ? "running" : "completed",
					},
				],
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
	const specPath = join(cwd, ".pi", "workflows", runId, "spec.json");
	try {
		return JSON.parse(readFileSync(specPath, "utf8"));
	} catch (error) {
		throw new Error(`Could not read routed run spec: ${specPath}`, {
			cause: error,
		});
	}
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

test("routed profile resolver runs only after routing selects the named workflow", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout");
		writeRoutableWorkflow(cwd);
		const calls = installFakeSubagentApi(cwd, {
			routerText: JSON.stringify({
				route: "workflow",
				depth: "standard",
				confidence: 0.95,
				reason: "workflow needed",
			}),
		});
		let resolved = 0;
		const outcome = await executeRoutedWorkflowRequest(
			routedRequest(cwd, {
				resolveExecutionProfile: async (workflow) => {
					assert.equal(workflow, "route-target");
					resolved += 1;
					return "low";
				},
			}),
		);
		assert.equal(outcome.mode, "workflow");
		assert.equal(calls.router, 1);
		assert.equal(resolved, 1);
		const run = await readRunRecord(cwd, outcome.run.runId);
		assert.deepEqual(run.executionProfile, {
			name: "low",
			stageOverrides: { main: { thinking: "low" } },
		});
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("direct routing does not ask for a workflow profile", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout");
		writeRoutableWorkflow(cwd);
		installFakeSubagentApi(cwd, {
			routerText: JSON.stringify({
				route: "direct",
				depth: "quick",
				confidence: 0.95,
				reason: "direct is enough",
			}),
		});
		let resolved = 0;
		const outcome = await executeRoutedWorkflowRequest(
			routedRequest(cwd, {
				resolveExecutionProfile: async () => {
					resolved += 1;
					return "low";
				},
			}),
		);
		assert.equal(outcome.mode, "direct");
		assert.equal(resolved, 0);
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
		assert.equal(
			parseWorkflowRunArgs('run --no-route route-target "Task"').route,
			false,
		);
		assert.equal(
			parseWorkflowRunArgs('run route-target "Task" --no-route').route,
			false,
		);
		assert.equal(
			parseWorkflowDynamicArgs('dynamic --no-route "Task"').route,
			false,
		);
		assert.equal(
			parseWorkflowRunArgs('run route-target "Keep literal --no-route inside"')
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

test("/workflow launch finishing after shutdown does not render into the closed session", async () => {
	const { default: workflowExtension } = await import(
		"../../.tmp/unit/extension.js"
	);
	const commands = new Map();
	const handlers = new Map();
	workflowExtension({
		on(event, handler) {
			handlers.set(event, handler);
		},
		registerCommand(name, definition) {
			commands.set(name, definition);
		},
		registerTool() {},
		sendMessage() {},
		getThinkingLevel() {
			return undefined;
		},
	});
	const handler = commands.get("workflow")?.handler;
	assert.ok(handler, "workflow command not registered");

	const cwd = makeProject();
	let releaseRouter;
	const routerGate = new Promise((resolve) => (releaseRouter = resolve));
	try {
		writeAgent(cwd, "unit-scout");
		writeRoutableWorkflow(cwd);
		installFakeSubagentApi(cwd, {
			routerText: JSON.stringify({
				route: "workflow",
				depth: "standard",
				confidence: 0.9,
				reason: "workflow warranted",
			}),
			keepTaskRunning: true,
			routerGate,
		});
		const statuses = [];
		const widgets = [];
		const ctx = {
			cwd,
			hasUI: true,
			ui: {
				notify() {},
				setStatus(key, value) {
					statuses.push({ key, value });
				},
				setWidget(key, value, options) {
					widgets.push({ key, value, options });
				},
				confirm: async () => true,
				select: async (_title, options) =>
					options.find((option) => option === "Profile: medium"),
			},
		};
		const launch = handler(
			'run route-target "Delayed routed launch."',
			ctx,
		);
		for (let attempt = 0; attempt < 50; attempt += 1) {
			if (
				statuses.some(
					(entry) =>
						entry.key === "pi-workflow-launch" &&
						typeof entry.value === "string",
				)
			)
				break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		handlers.get("session_shutdown")?.({}, ctx);
		const widgetCountAfterShutdown = widgets.length;
		releaseRouter();
		await launch;
		await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(widgets.length, widgetCountAfterShutdown);
		assert.equal(
			widgets.some(
				(entry) =>
					entry.key === "pi-workflow-active" && Array.isArray(entry.value),
			),
			false,
		);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/workflow run routes by default and --no-route skips the router", async () => {
	const { default: workflowExtension } = await import(
		"../../.tmp/unit/extension.js"
	);
	function captureHandler() {
		const commands = new Map();
		const handlers = new Map();
		workflowExtension({
			on(event, handler) {
				handlers.set(event, handler);
			},
			registerCommand(name, definition) {
				commands.set(name, definition);
			},
			registerTool() {},
			sendMessage() {},
			getThinkingLevel() {
				return undefined;
			},
		});
		const command = commands.get("workflow");
		assert.ok(command, "workflow command not registered");
		return { handler: command.handler, handlers };
	}

	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout");
		writeRoutableWorkflow(cwd);
		const calls = installFakeSubagentApi(cwd, {
			routerText: JSON.stringify({
				route: "workflow",
				depth: "standard",
				confidence: 0.9,
				reason: "workflow warranted",
			}),
			keepTaskRunning: true,
		});
		const { handler, handlers } = captureHandler();
		const notices = [];
		const statuses = [];
		const widgets = [];
		let profilePrompts = 0;
		const ctx = {
			cwd,
			hasUI: true,
			ui: {
				notify(message, level) {
					notices.push({ message, level });
				},
				setStatus(key, value) {
					statuses.push({ key, value });
				},
				setWidget(key, value, options) {
					widgets.push({ key, value, options });
				},
				confirm: async () => true,
				select: async (_title, options) => {
					profilePrompts += 1;
					return options.find((option) => option === "Profile: medium");
				},
			},
		};

		// Default: run without any routing flag invokes the router pass.
		await handler('run route-target "Routed by default task."', ctx);
		assert.equal(calls.router, 1);

		// --no-route skips the router entirely.
		await handler(
			'run --no-route --force-new route-target "No route task."',
			ctx,
		);
		assert.equal(calls.router, 1);
		assert.equal(profilePrompts, 2);
		assert.ok(calls.launches >= 2);
		assert.equal(
			statuses.some(
				(entry) =>
					entry.key === "pi-workflow-launch" &&
					typeof entry.value === "string" &&
					entry.value.includes("Starting route-target"),
			),
			true,
		);
		assert.deepEqual(
			statuses.filter((entry) => entry.key === "pi-workflow-launch").at(-1),
			{
				key: "pi-workflow-launch",
				value: undefined,
			},
		);
		assert.equal(
			widgets.some(
				(entry) =>
					entry.key === "pi-workflow-launch" &&
					entry.options?.placement === "belowEditor",
			),
			true,
		);
		for (let attempt = 0; attempt < 50; attempt += 1) {
			if (
				widgets.some(
					(entry) =>
						entry.key === "pi-workflow-active" &&
						Array.isArray(entry.value),
				)
			)
				break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(
			widgets.some(
				(entry) =>
					entry.key === "pi-workflow-active" &&
					Array.isArray(entry.value) &&
					entry.value[0] === "Active workflows",
			),
			true,
		);
		handlers.get("session_shutdown")?.({}, ctx);
		await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(
			widgets.filter((entry) => entry.key === "pi-workflow-active").at(-1)
				?.value,
			undefined,
		);
		await handlers.get("session_start")?.(
			{ type: "session_start", reason: "reload" },
			ctx,
		);
		assert.equal(
			Array.isArray(
				widgets.filter((entry) => entry.key === "pi-workflow-active").at(-1)
					?.value,
			),
			true,
		);
		handlers.get("session_shutdown")?.({}, ctx);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});
