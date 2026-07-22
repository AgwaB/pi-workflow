import assert from "node:assert/strict";
import test from "node:test";

import {
	activeTopLevelWorkflowRuns,
	formatActiveWorkflowLines,
	renderActiveWorkflowUi,
	withWorkflowLaunchForeground,
	WORKFLOW_ACTIVE_STATUS_KEY,
	WORKFLOW_ACTIVE_WIDGET_KEY,
	WORKFLOW_LAUNCH_STATUS_KEY,
	WORKFLOW_LAUNCH_WIDGET_KEY,
} from "../../.tmp/unit/workflow-active-ui.js";

function summary(completed, total) {
	return {
		pending: Math.max(0, total - completed),
		running: completed < total ? 1 : 0,
		blocked: 0,
		completed,
		failed: 0,
		skipped: 0,
		interrupted: 0,
		total,
	};
}

function run(overrides = {}) {
	return {
		runId: "workflow_active",
		name: "deep-review",
		type: "artifact-graph",
		status: "running",
		taskSummary: summary(3, 8),
		createdAt: "2026-07-22T00:00:00.000Z",
		updatedAt: "2026-07-22T00:01:00.000Z",
		runJson: ".pi/workflows/workflow_active/run.json",
		...overrides,
	};
}

function index(runs) {
	return {
		schemaVersion: 1,
		updatedAt: "2026-07-22T00:02:00.000Z",
		runs,
	};
}

test("active workflow UI selects recent running top-level runs only", () => {
	const selected = activeTopLevelWorkflowRuns(
		index([
			run({ runId: "workflow_old" }),
			run({
				runId: "workflow_new",
				name: "deep-research",
				updatedAt: "2026-07-22T00:03:00.000Z",
			}),
			run({ runId: "workflow_done", status: "completed" }),
			run({ runId: "workflow_child", parentRunId: "workflow_old" }),
		]),
	);
	assert.deepEqual(
		selected.map((item) => item.runId),
		["workflow_new", "workflow_old"],
	);
});

test("active workflow UI formats bounded progress and elapsed time", () => {
	const runs = Array.from({ length: 7 }, (_, item) =>
		run({
			runId: `workflow_${item}`,
			name:
				item === 0
					? "긴-워크플로-이름-😀-abcdefghijklmnopqrstuvwxyz"
					: `workflow-${item}`,
			updatedAt: `2026-07-22T00:0${item}:00.000Z`,
		}),
	);
	const lines = formatActiveWorkflowLines(
		runs,
		Date.parse("2026-07-22T00:02:00.000Z"),
	);
	assert.equal(lines[0], "Active workflows");
	assert.match(lines[1], /^● 긴-워크플로-이름-😀-/u);
	assert.match(lines[1], /3\/8 running · 2m$/u);
	assert.equal(lines.length, 7);
	assert.equal(lines.at(-1), "… and 2 more");
});

test("active workflow UI renders and clears footer and below-editor widget", () => {
	const statuses = [];
	const widgets = [];
	const ctx = {
		hasUI: true,
		ui: {
			setStatus(key, value) {
				statuses.push({ key, value });
			},
			setWidget(key, value, options) {
				widgets.push({ key, value, options });
			},
		},
	};
	renderActiveWorkflowUi(ctx, index([run()]));
	assert.deepEqual(statuses.at(-1), {
		key: WORKFLOW_ACTIVE_STATUS_KEY,
		value: "● deep-review 3/8",
	});
	assert.equal(widgets.at(-1).key, WORKFLOW_ACTIVE_WIDGET_KEY);
	assert.equal(widgets.at(-1).options.placement, "belowEditor");
	assert.equal(widgets.at(-1).value[0], "Active workflows");

	renderActiveWorkflowUi(ctx, index([]));
	assert.deepEqual(statuses.at(-1), {
		key: WORKFLOW_ACTIVE_STATUS_KEY,
		value: undefined,
	});
	assert.equal(widgets.at(-1).value, undefined);
});

test("foreground workflow launch indicator clears after success and failure", async () => {
	const statuses = [];
	const widgets = [];
	const ctx = {
		hasUI: true,
		ui: {
			setStatus(key, value) {
				statuses.push({ key, value });
			},
			setWidget(key, value, options) {
				widgets.push({ key, value, options });
			},
		},
	};
	const value = await withWorkflowLaunchForeground(ctx, "deep-review", async () => {
		assert.equal(statuses.at(-1).key, WORKFLOW_LAUNCH_STATUS_KEY);
		assert.match(statuses.at(-1).value, /Starting deep-review/u);
		assert.equal(widgets.at(-1).key, WORKFLOW_LAUNCH_WIDGET_KEY);
		return 42;
	});
	assert.equal(value, 42);
	assert.equal(statuses.at(-1).value, undefined);
	assert.equal(widgets.at(-1).value, undefined);

	await assert.rejects(
		withWorkflowLaunchForeground(ctx, "deep-review", async () => {
			throw new Error("launch failed");
		}),
		/launch failed/u,
	);
	assert.equal(statuses.at(-1).value, undefined);
	assert.equal(widgets.at(-1).value, undefined);

	const controller = new AbortController();
	let finishLaunch;
	const pending = withWorkflowLaunchForeground(
		ctx,
		"deep-review",
		() => new Promise((resolve) => (finishLaunch = resolve)),
		controller.signal,
	);
	controller.abort();
	const statusCountAfterAbort = statuses.length;
	assert.equal(statuses.at(-1).value, undefined);
	assert.equal(widgets.at(-1).value, undefined);
	await new Promise((resolve) => setTimeout(resolve, 220));
	assert.equal(statuses.length, statusCountAfterAbort);
	finishLaunch("started");
	assert.equal(await pending, "started");
});
