import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	workflowRunDir,
	writeWorkflowLaunchCommandArtifact,
} from "../../.tmp/unit/store.js";
import { WorkflowView } from "../../.tmp/unit/workflow-view.js";

const theme = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (text) => text,
};

const timestamp = "2026-07-07T00:00:00.000Z";

async function waitFor(predicate, message = "condition did not settle") {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setImmediate(resolve));
	}
	assert.fail(message);
}

function taskSummary(overrides = {}) {
	return {
		total: 1,
		pending: 0,
		running: 0,
		completed: 1,
		blocked: 0,
		failed: 0,
		skipped: 0,
		interrupted: 0,
		...overrides,
	};
}

function taskRecord(usageValues) {
	return {
		taskId: "task-1",
		specId: "task-1",
		displayName: "task-1",
		agent: "worker",
		status: "completed",
		statusDetail: "completed",
		kind: "main",
		stageId: "stage-1",
		runtime: { approvalMode: "never" },
		cwd: "/tmp/workflow-view",
		worktree: {
			enabled: false,
			path: null,
			branch: null,
			baseCwd: null,
			warning: null,
		},
		backendTaskId: "task-1",
		files: {
			output: "",
			stderr: "",
			result: "",
			systemPrompt: "",
			taskPrompt: "",
		},
		usage: {
			source: "pi-subagent",
			capturedAt: timestamp,
			...usageValues,
			aggregate: { attempts: 1, ...usageValues },
			attempts: [],
		},
	};
}

function supportTaskRecord() {
	return {
		taskId: "task-support",
		specId: "support.main",
		displayName: "support.main",
		agent: "support",
		status: "completed",
		statusDetail: "support_completed",
		kind: "support",
		stageId: "support",
		runtime: { approvalMode: "never" },
		cwd: "/tmp/workflow-view",
		worktree: {
			enabled: false,
			path: null,
			branch: null,
			baseCwd: null,
			warning: null,
		},
		backendTaskId: "task-support",
		files: {
			output: "",
			stderr: "",
			result: "",
			systemPrompt: "",
			taskPrompt: "",
		},
	};
}

function dynamicTaskRecord({
	signal = true,
	forced = signal,
	telemetry = "complete",
} = {}) {
	const task = taskRecord({
		inputTokens: 1_000,
		outputTokens: 500,
		totalTokens: 1_500,
		cacheCreationInputTokens: 0,
		cacheReadInputTokens: 0,
	});
	task.dynamicGenerated = {
		controllerSpecId: "dynamic.controller",
		opId: "dynamic.controller:agent:task-1",
		requestHash: "a".repeat(64),
		outputProfile: "generic_summary_v1",
	};
	if (telemetry === "unavailable") return task;
	if (telemetry === "disabled") {
		task.toolResultBudget = {
			attempts: [
				{
					source: "launch-configuration",
					capturedAt: timestamp,
					backendRunId: "run-disabled",
					backendAttemptId: "attempt-disabled",
					terminal: true,
					configured: false,
					configurationSource: "disabled",
				},
			],
		};
		return task;
	}
	task.toolResultBudget = {
		attempts: [
			{
				source: "subagent-result-metadata",
				capturedAt: timestamp,
				backendRunId: "run-budget",
				backendAttemptId: "attempt-budget",
				terminal: true,
				configured: true,
				configurationSource: "default",
				configuredMaxTotalChars: 320_000,
				reported: true,
				enabled: true,
				maxTotalChars: 320_000,
				retainedChars: 160_000,
				toolResults: 12,
				evictableCount: 11,
				evictedCount: signal ? 2 : 0,
				evictedChars: signal ? 48_000 : 0,
				forcedEvictionApplied: forced,
				contextRecovered: signal,
				contextOverflowRecovered: false,
				contextLengthExceeded: false,
			},
		],
	};
	return task;
}

function runRecord(
	tasks = [
		taskRecord({
			inputTokens: 5_958,
			outputTokens: 3_338,
			totalTokens: 17_488,
			cacheCreationInputTokens: 0,
			cacheReadInputTokens: 8_192,
		}),
	],
) {
	const summary = taskSummary({ total: tasks.length, completed: tasks.length });
	return {
		schemaVersion: 1,
		runId: "workflow_view_usage",
		name: "usage-test",
		type: "workflow",
		status: "completed",
		taskSummary: summary,
		cwd: "/tmp/workflow-view",
		backend: { type: "local-pi", mode: "headless" },
		createdAt: timestamp,
		updatedAt: timestamp,
		specPath: "spec.json",
		tasks,
	};
}

test("workflow board compacts run usage while preserving token breakdown", () => {
	const run = runRecord();
	const view = new WorkflowView(
		"/tmp/workflow-view",
		{ requestRender() {} },
		theme,
		() => {},
	);
	view.loading = false;
	view.flows = [
		{
			runId: run.runId,
			name: run.name,
			type: run.type,
			status: run.status,
			createdAt: run.createdAt,
			updatedAt: run.updatedAt,
			taskSummary: run.taskSummary,
		},
	];
	view.detailRun = run;

	const rendered = view.render(120).join("\n");

	assert.match(rendered, /Usage 17\.5k/);
	assert.match(rendered, /in:\s+6\.0k · out:\s+3\.3k/);
	assert.match(rendered, /cache:\s+8\.2k\/0/);
	assert.doesNotMatch(rendered, /tokens:|cache r\/w|task\(s\) without usage/);
});

test("support task detail explains why provider token usage is unavailable", () => {
	const run = runRecord([supportTaskRecord()]);
	const view = new WorkflowView(
		"/tmp/workflow-view",
		{ requestRender() {} },
		theme,
		() => {},
	);
	view.mode = "task";
	view.loading = false;
	view.detailRun = run;
	view.outputLines = [];
	view.promptLines = [];

	const rendered = view.render(120).join("\n");

	assert.match(rendered, /Usage/);
	assert.match(rendered, /tokens:\s+n\/a \(support helper\)/);
});

test("workflow board selected run shows only actionable tool-result budget signals", () => {
	const signaledRun = runRecord([dynamicTaskRecord()]);
	const view = new WorkflowView(
		"/tmp/workflow-view",
		{ requestRender() {} },
		theme,
		() => {},
	);
	view.loading = false;
	view.flows = [
		{
			runId: signaledRun.runId,
			name: signaledRun.name,
			type: signaledRun.type,
			status: signaledRun.status,
			createdAt: signaledRun.createdAt,
			updatedAt: signaledRun.updatedAt,
			taskSummary: signaledRun.taskSummary,
		},
	];
	view.detailRun = signaledRun;

	const signaled = view.render(120).join("\n");
	assert.match(signaled, /Tool-result budget/);
	assert.match(signaled, /cap chars:\s+320,000/);
	assert.match(signaled, /peak:\s+160,000 \(50\.0%\)/);
	assert.match(signaled, /evicted:\s+2 \/ 48,000 chars/);
	assert.match(signaled, /forced:\s+1 attempt/);
	assert.match(signaled, /coverage:\s+complete 1\/1/);

	view.detailRun = runRecord([dynamicTaskRecord({ signal: false })]);
	const quiet = view.render(120).join("\n");
	assert.doesNotMatch(quiet, /Tool-result budget/);

	const disabled = dynamicTaskRecord({ telemetry: "disabled" });
	disabled.taskId = "task-2";
	disabled.specId = "task-2";
	disabled.displayName = "task-2";
	const mixedRun = runRecord([dynamicTaskRecord({ signal: false }), disabled]);
	view.detailRun = mixedRun;
	view.flows[0].taskSummary = mixedRun.taskSummary;
	const mixed = view.render(120).join("\n");
	assert.match(mixed, /coverage:\s+complete 1\/2/);
	assert.match(mixed, /other:\s+disabled 1/);
	assert.match(mixed, /counters:\s+1\/1/);
});

test("dynamic task detail shows cap, retained pressure, evictions, recovery, and coverage", () => {
	const run = runRecord([dynamicTaskRecord()]);
	const view = new WorkflowView(
		"/tmp/workflow-view",
		{ requestRender() {} },
		theme,
		() => {},
	);
	view.mode = "task";
	view.loading = false;
	view.detailRun = run;
	view.outputLines = [];
	view.promptLines = [];

	const rendered = view.render(120).join("\n");
	assert.match(rendered, /Tool-result budget/);
	assert.match(rendered, /cap chars:\s+320,000/);
	assert.match(rendered, /retained chars:\s+160,000 \(50\.0%\)/);
	assert.match(rendered, /evicted:\s+2 results \/ 48,000 chars/);
	assert.match(rendered, /forced:\s+1 attempt/);
	assert.match(rendered, /recovery:\s+1 attempt \(0 overflow\)/);
	assert.match(rendered, /coverage:\s+complete 1\/1 tasks/);
	assert.match(rendered, /telemetry:\s+1\/1\s+·\s+counters:\s+1\/1/);
});

test("dynamic task detail keeps legacy telemetry unavailable and disabled distinct", () => {
	for (const [telemetry, expected] of [
		["unavailable", /coverage:\s+unavailable/],
		["disabled", /coverage:\s+disabled/],
	]) {
		const run = runRecord([dynamicTaskRecord({ telemetry })]);
		const view = new WorkflowView(
			"/tmp/workflow-view",
			{ requestRender() {} },
			theme,
			() => {},
		);
		view.mode = "task";
		view.loading = false;
		view.detailRun = run;
		view.outputLines = [];
		view.promptLines = [];

		const rendered = view.render(80).join("\n");
		assert.match(rendered, /Tool-result budget/);
		assert.match(rendered, expected);
		assert.doesNotMatch(rendered, /evicted:\s+0/);
		if (telemetry === "disabled")
			assert.match(rendered, /telemetry:\s+0\/1\s+·\s+counters:\s+0\/0/);
	}
});

test("workflow board launch summary is structured and never previews command text", () => {
	const run = runRecord();
	run.launch = {
		schema: "pi-workflow-run-launch-v1",
		source: { kind: "slash-command", action: "run" },
		requestKind: "named-workflow",
		routingMode: "default-on",
		profile: { kind: "named", name: "medium" },
		task: { characters: 148, lines: 2 },
		command: {
			state: "captured",
			artifact: "launch-command.txt",
			encoding: "utf-8",
			bytes: 99,
			sha256: "a".repeat(64),
			fidelity: "pi-extension-command-v1",
			sensitivity: "user-input",
			disclosure: "explicit-only",
		},
	};
	run.routing = {
		requested: "secret-workflow-path",
		decided: "workflow",
		depth: "standard",
		confidence: 0.9,
		reason: "secret routing reason",
	};
	const view = new WorkflowView(
		"/tmp/workflow-view",
		{ requestRender() {} },
		theme,
		() => {},
	);
	view.loading = false;
	view.flows = [
		{
			runId: run.runId,
			name: run.name,
			type: run.type,
			status: run.status,
			createdAt: run.createdAt,
			updatedAt: run.updatedAt,
			taskSummary: run.taskSummary,
		},
	];
	view.detailRun = run;

	const rendered = view.render(120).join("\n");
	assert.match(rendered, /Launch/);
	assert.match(rendered, /source: slash · \/workflow/);
	assert.match(rendered, /route: default → workflow/);
	assert.match(rendered, /profile:\s+medium/);
	assert.match(rendered, /148 chars · 2 lines/);
	assert.match(rendered, /available · v view/);
	assert.doesNotMatch(rendered, /secret-workflow-path|secret routing reason/);
});

test("launch summaries render quick, standard, and max routing depths", () => {
	const run = runRecord();
	run.launch = {
		schema: "pi-workflow-run-launch-v1",
		source: { kind: "slash-command", action: "run" },
		requestKind: "named-workflow",
		routingMode: "default-on",
		profile: { kind: "base" },
		task: { characters: 10, lines: 1 },
		command: {
			state: "captured",
			artifact: "launch-command.txt",
			encoding: "utf-8",
			bytes: 10,
			sha256: "0".repeat(64),
			fidelity: "pi-extension-command-v1",
			sensitivity: "user-input",
			disclosure: "explicit-only",
		},
	};
	const view = new WorkflowView(
		"/tmp/workflow-view",
		{ requestRender() {} },
		theme,
		() => {},
	);
	view.loading = false;
	view.flows = [{ ...run, tasks: undefined }];
	view.detailRun = run;

	for (const depth of ["quick", "standard", "max"]) {
		run.routing = {
			requested: "usage-test",
			decided: "workflow",
			depth,
			confidence: 0.82,
			reason: "workflow route",
		};
		assert.match(
			view.launchSummaryLines(run).join("\n"),
			new RegExp(`default → workflow · ${depth} · 82%`),
		);
	}
});

test("launch command viewer verifies on demand, escapes controls, and copies exact text", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "piwf-view-launch-"));
	const run = runRecord();
	run.runId = "workflow_view_launch";
	const exact =
		'/workflow run review "line one\nline two\t\u001b]0;owned\u0007\u202e"';
	const copied = [];
	let copyShouldFail = false;
	try {
		const command = await writeWorkflowLaunchCommandArtifact(
			cwd,
			run.runId,
			exact,
		);
		run.launch = {
			schema: "pi-workflow-run-launch-v1",
			source: { kind: "slash-command", action: "run" },
			requestKind: "named-workflow",
			routingMode: "off",
			profile: { kind: "base" },
			task: { characters: 24, lines: 2 },
			command,
		};
		const view = new WorkflowView(
			cwd,
			{ requestRender() {} },
			theme,
			() => {},
			undefined,
			async (text) => {
				if (copyShouldFail) throw new Error("clipboard failure");
				copied.push(text);
			},
		);
		view.loading = false;
		view.flows = [
			{
				runId: run.runId,
				name: run.name,
				type: run.type,
				status: run.status,
				createdAt: run.createdAt,
				updatedAt: run.updatedAt,
				taskSummary: run.taskSummary,
			},
		];
		view.detailRun = run;

		assert.equal(view.render(100).join("\n").includes("line one"), false);
		view.handleInput("c");
		assert.deepEqual(copied, []);
		view.handleInput("v");
		await waitFor(
			() => view.launchCommandOpen,
			"launch command viewer did not open",
		);
		const rendered = view.render(100).join("\n");
		assert.match(rendered, /Launch Command/);
		assert.match(rendered, /Sensitive user input · control characters escaped/);
		assert.match(rendered, /\\n/);
		assert.match(rendered, /\\t/);
		assert.match(rendered, /\\u001b/);
		assert.match(rendered, /\\u202e/i);
		assert.equal(rendered.includes("\u001b]0;owned"), false);

		view.handleInput("c");
		await waitFor(() => view.message === "Launch command copied");
		assert.deepEqual(copied, [exact]);
		assert.equal(view.message, "Launch command copied");
		copyShouldFail = true;
		view.handleInput("c");
		await waitFor(() => view.message === "Launch command copy failed");
		assert.equal(view.message, "Launch command copy failed");
		assert.equal(view.launchCommandOpen, true);
		assert.deepEqual(copied, [exact]);
		view.handleInput("b");
		assert.equal(view.launchCommandText, "");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("legacy, tool, malformed, and tampered launch commands remain unavailable", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "piwf-view-unavailable-"));
	const run = runRecord();
	run.runId = "workflow_view_unavailable";
	const copied = [];
	try {
		const view = new WorkflowView(
			cwd,
			{ requestRender() {} },
			theme,
			() => {},
			undefined,
			async (text) => copied.push(text),
		);
		view.loading = false;
		view.flows = [{ ...run, tasks: undefined }];
		view.detailRun = run;
		assert.match(view.render(80).join("\n"), /unavailable \(not captured\)/);
		view.handleInput("v");
		assert.match(view.message, /not captured/);

		run.launch = {
			schema: "pi-workflow-run-launch-v1",
			source: { kind: "tool", name: "workflow_dynamic" },
			requestKind: "direct-dynamic",
			routingMode: "off",
			profile: { kind: "not-applicable" },
			task: { characters: 12, lines: 1 },
			command: { state: "unavailable", reason: "not-a-command" },
		};
		assert.match(view.render(80).join("\n"), /unavailable \(tool launch\)/);
		view.handleInput("v");
		assert.match(view.message, /tool launch/);

		const command = await writeWorkflowLaunchCommandArtifact(
			cwd,
			run.runId,
			"/workflow dynamic original",
		);
		run.launch = {
			...run.launch,
			source: { kind: "slash-command", action: "dynamic" },
			command,
		};
		await writeFile(
			join(workflowRunDir(cwd, run.runId), "launch-command.txt"),
			"tampered",
		);
		view.handleInput("v");
		await waitFor(() => /verification failed/.test(view.message));
		assert.match(view.message, /verification failed/);
		const failedRender = view.render(80).join("\n");
		assert.match(failedRender, /unavailable \(verification failed\)/);
		assert.doesNotMatch(failedRender, /available · v view/);
		assert.doesNotMatch(failedRender, /v launch/);
		assert.equal(copied.length, 0);

		const repaired = await writeWorkflowLaunchCommandArtifact(
			cwd,
			run.runId,
			"/workflow dynamic repaired",
		);
		run.launch.command = repaired;
		const repairedRender = view.render(80).join("\n");
		assert.match(repairedRender, /available · v view/);
		assert.match(repairedRender, /v launch/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("missing artifacts and widened run directories stay unavailable after verification", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "piwf-view-fail-closed-"));
	try {
		for (const scenario of ["missing", "wide-run-mode"]) {
			const run = runRecord();
			run.runId = `workflow_view_${scenario.replaceAll("-", "_")}`;
			const command = await writeWorkflowLaunchCommandArtifact(
				cwd,
				run.runId,
				`/workflow run ${scenario}`,
			);
			run.launch = {
				schema: "pi-workflow-run-launch-v1",
				source: { kind: "slash-command", action: "run" },
				requestKind: "named-workflow",
				routingMode: "off",
				profile: { kind: "base" },
				task: { characters: scenario.length, lines: 1 },
				command,
			};
			if (scenario === "missing")
				await rm(join(workflowRunDir(cwd, run.runId), "launch-command.txt"));
			else await chmod(workflowRunDir(cwd, run.runId), 0o755);

			const view = new WorkflowView(
				cwd,
				{ requestRender() {} },
				theme,
				() => {},
			);
			view.loading = false;
			view.flows = [{ ...run, tasks: undefined }];
			view.detailRun = run;
			assert.match(view.render(80).join("\n"), /available · v view/);
			view.handleInput("v");
			await waitFor(() => view.message.startsWith("launch command unavailable:"));
			const rendered = view.render(80).join("\n");
			assert.match(rendered, /command:\s+unavailable \(/);
			assert.doesNotMatch(rendered, /available · v view/);
			assert.doesNotMatch(rendered, /v launch/);
		}
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("closing workflow board forces a full repaint to clear stale panel rows", () => {
	const renderRequests = [];
	let doneCount = 0;
	const view = new WorkflowView(
		"/tmp/workflow-view",
		{ requestRender: (force) => renderRequests.push(force) },
		theme,
		() => {
			doneCount += 1;
		},
	);

	view.handleInput("q");

	assert.equal(doneCount, 1);
	assert.deepEqual(renderRequests, [true]);
});
