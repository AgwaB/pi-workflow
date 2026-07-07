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
