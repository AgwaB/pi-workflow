import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readRunRecord, writeRunRecord } from "../../.tmp/unit/store.js";

function taskRecord(taskId, usageValues) {
	return {
		taskId,
		specId: taskId,
		displayName: taskId,
		agent: "worker",
		status: "completed",
		statusDetail: "completed",
		kind: "main",
		runtime: { approvalMode: "never" },
		cwd: "/tmp/rollup",
		worktree: {
			enabled: false,
			path: null,
			branch: null,
			baseCwd: null,
			warning: null,
		},
		backendTaskId: taskId,
		files: {
			output: "",
			stderr: "",
			result: "",
			systemPrompt: "",
			taskPrompt: "",
		},
		...(usageValues
			? {
					usage: {
						source: "pi-subagent",
						capturedAt: "2026-07-07T00:00:00.000Z",
						...usageValues,
						aggregate: { attempts: 1, ...usageValues },
						attempts: [],
					},
				}
			: {}),
	};
}

function runRecord(runId, tasks) {
	return {
		schemaVersion: 1,
		runId,
		name: "rollup-test",
		type: "workflow",
		status: "completed",
		taskSummary: {
			total: tasks.length,
			pending: 0,
			running: 0,
			completed: tasks.length,
			blocked: 0,
			failed: 0,
			skipped: 0,
			interrupted: 0,
		},
		cwd: "/tmp/rollup",
		backend: { type: "local-pi", mode: "headless" },
		createdAt: "2026-07-07T00:00:00.000Z",
		updatedAt: "2026-07-07T00:00:00.000Z",
		specPath: "spec.json",
		tasks,
	};
}

test("terminal writeRunRecord persists a task-usage rollup on the run", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "run-usage-rollup-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));

	const run = runRecord("workflow_rollup_1", [
		taskRecord("task-1", {
			inputTokens: 100,
			outputTokens: 200,
			totalTokens: 300,
			costUsd: 0.5,
		}),
		taskRecord("task-2", {
			inputTokens: 10,
			outputTokens: 20,
			totalTokens: 30,
			costUsd: 0.25,
		}),
		taskRecord("task-3", undefined),
	]);
	await writeRunRecord(cwd, run);

	const persisted = await readRunRecord(cwd, "workflow_rollup_1");
	assert.equal(persisted.usage.source, "task-rollup");
	assert.equal(persisted.usage.taskCount, 3);
	assert.equal(persisted.usage.tasksReporting, 2);
	assert.equal(persisted.usage.inputTokens, 110);
	assert.equal(persisted.usage.outputTokens, 220);
	assert.equal(persisted.usage.totalTokens, 330);
	assert.equal(persisted.usage.costUsd, 0.75);
	assert.ok(persisted.usage.capturedAt);
});

test("non-terminal writeRunRecord does not attach a rollup", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "run-usage-rollup-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));

	const tasks = [
		taskRecord("task-1", { totalTokens: 300, costUsd: 0.5 }),
		{ ...taskRecord("task-2", undefined), status: "running", statusDetail: "running" },
	];
	const run = {
		...runRecord("workflow_rollup_2", tasks),
		status: "running",
		taskSummary: {
			total: 2,
			pending: 0,
			running: 1,
			completed: 1,
			blocked: 0,
			failed: 0,
			skipped: 0,
			interrupted: 0,
		},
	};
	await writeRunRecord(cwd, run);

	const persisted = await readRunRecord(cwd, "workflow_rollup_2");
	assert.equal(persisted.status, "running");
	assert.equal(persisted.usage, undefined);
});
