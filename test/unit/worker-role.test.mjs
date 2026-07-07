import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import workflowExtension from "../../.tmp/unit/extension.js";
import {
	launchSubagentTask,
	setSubagentApiForTests,
	setSubagentLaunchControlsForTests,
} from "../../.tmp/unit/subagent-backend.js";
import { writeRunRecord } from "../../.tmp/unit/store.js";
import { WORKFLOW_RUN_TYPE } from "../../.tmp/unit/types.js";

setSubagentLaunchControlsForTests({ releaseDelayMs: 0, retryJitterMs: 0 });

function makeProject() {
	return mkdtempSync(join(tmpdir(), "workflow-worker-role-"));
}

function cleanupProject(cwd) {
	rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
}

function restoreRole(originalRole) {
	if (originalRole === undefined) delete process.env.PI_WORKFLOW_ROLE;
	else process.env.PI_WORKFLOW_ROLE = originalRole;
}

function makeLaunchFixture(cwd, suffix) {
	const now = new Date().toISOString();
	const runId = `workflow_worker_role_${suffix}`;
	const task = {
		taskId: "task-1",
		specId: `worker-role-${suffix}.main`,
		displayName: `worker-role-${suffix}.main`,
		agent: "unit-scout",
		agentFile: ".pi/agents/unit-scout.md",
		roles: [],
		status: "pending",
		statusDetail: "pending",
		runtime: { approvalMode: "non-interactive" },
		cwd,
		worktree: {
			enabled: false,
			path: null,
			branch: null,
			baseCwd: null,
			warning: null,
		},
		backendTaskId: "",
		files: {
			systemPrompt: `.pi/workflows/${runId}/tasks/task-1/system.md`,
			taskPrompt: `.pi/workflows/${runId}/tasks/task-1/task.md`,
			output: `.pi/workflows/${runId}/tasks/task-1/output.log`,
			stderr: `.pi/workflows/${runId}/tasks/task-1/stderr.log`,
			result: `.pi/workflows/${runId}/tasks/task-1/result.json`,
		},
	};
	const run = {
		schemaVersion: 1,
		runId,
		type: WORKFLOW_RUN_TYPE,
		status: "running",
		taskSummary: {
			pending: 1,
			running: 0,
			blocked: 0,
			completed: 0,
			failed: 0,
			skipped: 0,
			interrupted: 0,
			total: 1,
		},
		cwd,
		backend: { type: "local-pi", mode: "headless" },
		createdAt: now,
		updatedAt: now,
		specPath: "workflow.json",
		tasks: [task],
	};
	const compiledTask = {
		id: `worker-role-${suffix}.main`,
		agent: "unit-scout",
		agentPath: ".pi/agents/unit-scout.md",
		agentSystemPrompt: "Launch agent.",
		roleNames: [],
		task: "Do the work.",
		cwd,
		explicitCwd: false,
		explicitWorktreePolicy: false,
		runtime: {
			fast: "off",
			approvalMode: "non-interactive",
			tools: ["read"],
		},
		safety: { capability: "read-only", reason: "test" },
		compiledPrompt: "Launch prompt.",
	};
	return { run, task, compiledTask };
}

test("workflow child subagent launches inherit worker role and restore the parent role", async () => {
	const cwd = makeProject();
	const originalRole = process.env.PI_WORKFLOW_ROLE;
	const observed = [];
	try {
		process.env.PI_WORKFLOW_ROLE = "supervisor";
		setSubagentApiForTests({
			async runSubagent(options) {
				observed.push({
					role: process.env.PI_WORKFLOW_ROLE,
					options,
				});
				return {
					runId: "run_worker_role_child",
					attemptId: "attempt_worker_role_child",
					status: "running",
				};
			},
			async getSubagentStatus() {
				return null;
			},
			async reconcileSubagentRun() {
				return {};
			},
			async interruptSubagent() {
				return {};
			},
		});

		const { run, task, compiledTask } = makeLaunchFixture(cwd, "launch");
		const result = await launchSubagentTask(cwd, run, task, compiledTask);

		assert.equal(result.kind, "launched");
		assert.equal(observed.length, 1);
		assert.equal(observed[0].role, "worker");
		assert.equal(process.env.PI_WORKFLOW_ROLE, "supervisor");
		assert.equal(Object.hasOwn(observed[0].options, "env"), false);
	} finally {
		setSubagentApiForTests(undefined);
		restoreRole(originalRole);
		cleanupProject(cwd);
	}
});

test("worker role extension startup does not resume workflow supervisors", async () => {
	const cwd = makeProject();
	const originalRole = process.env.PI_WORKFLOW_ROLE;
	let unexpectedLaunches = 0;
	try {
		process.env.PI_WORKFLOW_ROLE = "worker";
		const { run } = makeLaunchFixture(cwd, "session_start");
		await writeRunRecord(cwd, run);
		setSubagentApiForTests({
			async runSubagent() {
				unexpectedLaunches += 1;
				throw new Error(
					"worker session_start must not schedule workflow tasks",
				);
			},
			async getSubagentStatus() {
				return null;
			},
			async reconcileSubagentRun() {
				return {};
			},
			async interruptSubagent() {
				return {};
			},
		});

		const handlers = new Map();
		const registeredTools = [];
		workflowExtension({
			on(event, handler) {
				handlers.set(event, handler);
			},
			registerTool(tool) {
				registeredTools.push(tool.name);
			},
			registerCommand() {},
		});

		assert.deepEqual(registeredTools, []);
		assert.equal(typeof handlers.get("session_start"), "function");
		await handlers.get("session_start")(
			{ reason: "startup" },
			{
				cwd,
				ui: {
					notify() {
						throw new Error(
							"worker session_start must not notify as supervisor",
						);
					},
				},
			},
		);

		assert.equal(unexpectedLaunches, 0);
		assert.equal(
			existsSync(join(cwd, ".pi", "workflows", run.runId, "supervisor.lock")),
			false,
		);
		assert.equal(
			existsSync(join(cwd, ".pi", "workflows", run.runId, "supervisor.json")),
			false,
		);
	} finally {
		setSubagentApiForTests(undefined);
		restoreRole(originalRole);
		cleanupProject(cwd);
	}
});
