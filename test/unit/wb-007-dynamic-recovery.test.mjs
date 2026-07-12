import assert from "node:assert/strict";
import test from "node:test";

import {
	recoverStaleRunningDynamicControllers,
	recoverStaleRunningSupportTasks,
} from "../../.tmp/unit/engine-run-graph.js";

function handle(runId) {
	return { engine: "pi-subagent", runId };
}

const compiled = {
	tasks: [
		{ id: "controller", kind: "dynamic" },
		{ id: "worker", kind: "single" },
	],
};

test("WB-007 misalignment throws before stale dynamic recovery mutates any task", () => {
	const run = {
		tasks: [
			{
				taskId: "worker-task",
				specId: "worker",
				status: "running",
				statusDetail: "running",
				backendHandle: handle("worker-child"),
			},
			{
				taskId: "controller-task",
				specId: "controller",
				status: "running",
				statusDetail: "running",
			},
		],
	};
	const before = structuredClone(run);
	assert.throws(
		() => recoverStaleRunningDynamicControllers(run, compiled),
		/misaligned at index 0: expected controller, found worker/,
	);
	assert.deepEqual(run, before);
});

test("WB-007 stale running support recovery fails closed without replay", () => {
	const run = {
		tasks: [
			{
				taskId: "support-task",
				specId: "support",
				status: "running",
				statusDetail: "running",
				pid: 100,
				backendHandle: handle("unexpected-support-child"),
			},
			{
				taskId: "worker-task",
				specId: "worker",
				status: "running",
				statusDetail: "running",
				pid: 200,
				backendHandle: handle("worker-child"),
			},
		],
	};
	const compiled = {
		tasks: [
			{ id: "support", kind: "support" },
			{ id: "worker", kind: "single" },
		],
	};
	assert.equal(recoverStaleRunningSupportTasks(run, compiled), true);
	assert.equal(run.tasks[0].status, "failed");
	assert.equal(run.tasks[0].statusDetail, "recovered_stale_support_task");
	assert.match(run.tasks[0].lastMessage, /failed closed/);
	assert.equal(run.tasks[0].backendHandle, undefined);
	assert.equal(run.tasks[0].pid, undefined);
	assert.equal(run.tasks[1].status, "running");
	assert.equal(run.tasks[1].pid, 200);
});

test("WB-007 aligned recovery resets only the dynamic controller", () => {
	const workerHandle = handle("worker-child");
	const run = {
		tasks: [
			{
				taskId: "controller-task",
				specId: "controller",
				status: "running",
				statusDetail: "running",
				pid: 100,
				backendHandle: handle("unexpected-controller-child"),
			},
			{
				taskId: "worker-task",
				specId: "worker",
				status: "running",
				statusDetail: "running",
				pid: 200,
				backendHandle: workerHandle,
			},
		],
	};
	assert.equal(recoverStaleRunningDynamicControllers(run, compiled), true);
	assert.equal(run.tasks[0].status, "pending");
	assert.equal(run.tasks[0].statusDetail, "recovered_stale_dynamic_controller");
	assert.equal(run.tasks[0].backendHandle, undefined);
	assert.equal(run.tasks[0].pid, undefined);
	assert.equal(run.tasks[1].status, "running");
	assert.equal(run.tasks[1].backendHandle, workerHandle);
	assert.equal(run.tasks[1].pid, 200);
});
