import assert from "node:assert/strict";
import test from "node:test";

import { markFailFastCancellations } from "../../.tmp/unit/engine-run-graph.js";
import {
	awaitSubagentOperation,
	cleanupSubagentRun,
	interruptSubagentTask,
	setSubagentApiForTests,
} from "../../.tmp/unit/subagent-backend.js";

function backendHandle() {
	return {
		engine: "pi-subagent",
		backend: "headless",
		runId: "child-run",
		attemptId: "child-attempt",
		cwd: "/tmp/project",
		runsDir: ".pi/runs",
		display: "child-run/child-attempt",
	};
}

function runningTask(overrides = {}) {
	return {
		taskId: "task-running",
		specId: "running",
		status: "running",
		statusDetail: "running",
		backendHandle: backendHandle(),
		...overrides,
	};
}

test("WB-004 bounds a never-settling backend operation with context", async () => {
	const startedAt = Date.now();
	await assert.rejects(
		awaitSubagentOperation(() => new Promise(() => {}), {
			operation: "test-poll",
			context: "workflow run-a task task-a",
			timeoutMs: 25,
		}),
		/error|timed out after 25ms \(workflow run-a task task-a\)/,
	);
	assert.ok(Date.now() - startedAt < 500);
});

test("WB-004 surfaces interrupt rejection and preserves recoverable worker state", async (t) => {
	t.after(() => setSubagentApiForTests(undefined));
	const task = runningTask();
	setSubagentApiForTests({
		interruptSubagent: async () => {
			throw new Error("interrupt unavailable");
		},
	});
	await assert.rejects(
		interruptSubagentTask(task, "unit cancellation"),
		/interrupt unavailable/,
	);
	assert.equal(task.status, "running");
	assert.equal(task.backendHandle.runId, "child-run");
});

test("WB-004 cleanup records cancellation failure and later acknowledgement", async (t) => {
	t.after(() => setSubagentApiForTests(undefined));
	const task = runningTask();
	const run = { runId: "workflow-run", tasks: [task] };
	setSubagentApiForTests({
		interruptSubagent: async () => {
			throw new Error("worker still alive");
		},
	});
	await assert.rejects(cleanupSubagentRun("/tmp/project", run), /cancellations failed/);
	assert.equal(task.status, "running");
	assert.equal(task.statusDetail, "cancellation_failed");
	assert.match(task.lastMessage, /worker still alive/);
	assert.equal(task.backendHandle.runId, "child-run");

	setSubagentApiForTests({ interruptSubagent: async () => ({ acknowledged: true }) });
	await cleanupSubagentRun("/tmp/project", run);
	assert.equal(task.status, "running");
	assert.equal(task.statusDetail, "cancellation_acknowledged");
});

test("WB-004 fail-fast keeps running workers nonterminal until cancellation acknowledgement", () => {
	const failed = {
		taskId: "task-failed",
		specId: "failed",
		status: "failed",
		statusDetail: "failed",
	};
	const running = runningTask();
	const pending = {
		taskId: "task-pending",
		specId: "pending",
		status: "pending",
		statusDetail: "pending",
	};
	const run = { tasks: [failed, running, pending] };
	const compiled = {
		failurePolicy: {
			failFast: true,
			cancelSiblingsOnFailure: true,
			cancelDescendantsOnParentFailure: false,
		},
		tasks: [{ id: "failed" }, { id: "running" }, { id: "pending" }],
	};
	const summary = markFailFastCancellations(run, compiled);
	assert.deepEqual(summary.interruptedTaskIds, ["task-running"]);
	assert.equal(running.status, "running");
	assert.equal(running.statusDetail, "cancellation_pending");
	assert.equal(running.backendHandle.runId, "child-run");
	assert.equal(pending.status, "interrupted");
	assert.equal(pending.statusDetail, "fail_fast_cancelled");
});
