import assert from "node:assert/strict";
import test from "node:test";

import { WorkflowView } from "../../.tmp/unit/workflow-view.js";

const theme = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (text) => text,
};

const timestamp = "2026-07-07T00:00:00.000Z";

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

test("workflow board run usage shows cache tokens that explain total tokens", () => {
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

	assert.match(rendered, /tokens:\s+17\.5k/);
	assert.match(rendered, /in:\s+6\.0k/);
	assert.match(rendered, /out:\s+3\.3k/);
	assert.match(rendered, /cache r\/w:\s+8\.2k \/ 0/);
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
