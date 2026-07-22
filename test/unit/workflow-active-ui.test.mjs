import assert from "node:assert/strict";
import test from "node:test";

import { initTheme } from "@earendil-works/pi-coding-agent";

import {
	activeTopLevelWorkflowRuns,
	formatActiveWorkflowLines,
	renderActiveWorkflowUi,
	withWorkflowLaunchForeground,
	WORKFLOW_ACTIVE_STATUS_KEY,
	WORKFLOW_ACTIVE_WIDGET_KEY,
	WORKFLOW_LAUNCH_CANCELLED,
} from "../../.tmp/unit/workflow-active-ui.js";

initTheme(undefined, false);

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
			run({
				runId: "workflow_stale",
				taskSummary: { ...summary(3, 8), running: 0 },
			}),
			run({ runId: "workflow_child", parentRunId: "workflow_old" }),
		]),
	);
	assert.deepEqual(
		selected.map((item) => item.runId),
		["workflow_new", "workflow_old"],
	);
});

test("active workflow UI matches panel progress and formats bounded elapsed time", () => {
	const runs = Array.from({ length: 7 }, (_, item) =>
		run({
			runId: `workflow_${item}`,
			name:
				item === 0
					? "긴-워크플로-이름-😀-abcdefghijklmnopqrstuvwxyz"
					: `workflow-${item}`,
			taskSummary: {
				...summary(1, 11),
				pending: 5,
				running: 5,
			},
			updatedAt: `2026-07-22T00:0${item}:00.000Z`,
		}),
	);
	const lines = formatActiveWorkflowLines(
		runs,
		Date.parse("2026-07-22T00:02:00.000Z"),
	);
	assert.equal(lines[0], "Active workflows");
	assert.match(lines[1], /^● 긴-워크플로-이름-😀-/u);
	assert.match(lines[1], /6\/11 running · 2m$/u);
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
		value: "● deep-review 4/8",
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

function foregroundContext() {
	const components = [];
	return {
		components,
		ctx: {
			hasUI: true,
			mode: "tui",
			ui: {
				custom(factory) {
					return new Promise((resolve) => {
						let component;
						const done = (value) => {
							component?.dispose?.();
							resolve(value);
						};
						component = factory(
							{ requestRender() {} },
							{ fg(_role, value) { return value; } },
							undefined,
							done,
						);
						components.push(component);
					});
				},
			},
		},
	};
}

test("foreground workflow launch uses a cancellable custom loader", async () => {
	const { ctx, components } = foregroundContext();
	const value = await withWorkflowLaunchForeground(
		ctx,
		"Starting deep-review…",
		async (signal) => {
			assert.equal(signal.aborted, false);
			await Promise.resolve();
			assert.match(components[0].render(80).join("\n"), /Starting deep-review/u);
			return 42;
		},
	);
	assert.equal(value, 42);

	await assert.rejects(
		withWorkflowLaunchForeground(ctx, "Starting deep-review…", async () => {
			throw new Error("launch failed");
		}),
		/launch failed/u,
	);

	const controller = new AbortController();
	let finishLaunch;
	let sessionOperationSignal;
	const pending = withWorkflowLaunchForeground(
		ctx,
		"Starting deep-review…",
		(signal) => {
			sessionOperationSignal = signal;
			return new Promise((resolve) => (finishLaunch = resolve));
		},
		controller.signal,
	);
	await Promise.resolve();
	controller.abort();
	assert.equal(await pending, WORKFLOW_LAUNCH_CANCELLED);
	assert.equal(sessionOperationSignal.aborted, false);
	finishLaunch("started");

	let finishEscapedLaunch;
	let escapedOperationSignal;
	const escaped = withWorkflowLaunchForeground(
		ctx,
		"Starting deep-review…",
		(signal) => {
			escapedOperationSignal = signal;
			return new Promise((resolve) => (finishEscapedLaunch = resolve));
		},
	);
	await Promise.resolve();
	components.at(-1).handleInput("\u001b");
	assert.equal(await escaped, WORKFLOW_LAUNCH_CANCELLED);
	assert.equal(escapedOperationSignal.aborted, true);
	finishEscapedLaunch("started");
});
