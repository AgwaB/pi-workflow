import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
	buildDynamicToolResultBudgetMetrics,
	normalizedToolResultBudgetValues,
} from "../../.tmp/unit/dynamic-tool-result-budget-metrics.js";
import { formatRun } from "../../.tmp/unit/engine.js";
import {
	createPendingSingleTaskRun,
	launchSubagentTask,
	makeProject,
	refreshRunFromSubagentArtifacts,
	setSubagentApiForTests,
} from "./unit-test-support.mjs";

function dynamicMetadata(task, overrides = {}) {
	task.dynamicGenerated = {
		controllerSpecId: "adaptive.controller",
		opId: `op-${task.taskId}`,
		requestHash: `hash-${task.taskId}`,
		...overrides,
	};
}

function writeTerminalArtifacts(cwd, task, result, output = "done") {
	const artifactDir = join(cwd, task.backendFiles.runsDir);
	mkdirSync(artifactDir, { recursive: true });
	writeFileSync(
		join(artifactDir, "output.log"),
		[
			"<control>",
			JSON.stringify({ schema: "stage-control-v1", digest: "ok" }),
			"</control>",
			"<analysis>",
			output,
			"</analysis>",
			"<refs>",
			"[]",
			"</refs>",
		].join("\n"),
	);
	writeFileSync(join(artifactDir, "stderr.log"), "");
	writeFileSync(join(artifactDir, "result.json"), JSON.stringify(result));
	return artifactDir;
}

function statusSnapshot({
	runId,
	attemptId,
	artifactDir,
	status = "completed",
	failureKind = null,
	startedAt,
	completedAt,
	metadata,
}) {
	return {
		runId,
		attemptId,
		backend: "headless",
		status,
		failureKind,
		startedAt,
		completedAt,
		durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
		logs: [
			{ type: "output", path: "output.log", artifactCwd: artifactDir },
			{ type: "stderr", path: "stderr.log", artifactCwd: artifactDir },
			{ type: "result", path: "result.json", artifactCwd: artifactDir },
		],
		...(metadata === undefined ? {} : { metadata }),
		attempts: [{ attemptId, status }],
	};
}

function syntheticTask({
	taskId,
	controllerSpecId = "adaptive.controller",
	status = "completed",
	attempts,
}) {
	return {
		taskId,
		specId: `adaptive.${taskId}`,
		displayName: taskId,
		agent: "worker",
		agentFile: "agents/worker.md",
		roles: [],
		status,
		statusDetail: status,
		runtime: { approvalMode: "never" },
		cwd: "/tmp/dynamic-budget",
		worktree: {
			enabled: false,
			path: null,
			branch: null,
			baseCwd: null,
			warning: null,
		},
		backendTaskId: `backend-${taskId}`,
		files: {
			output: "",
			stderr: "",
			result: "",
			systemPrompt: "",
			taskPrompt: "",
		},
		dynamicGenerated: {
			controllerSpecId,
			opId: `op-${taskId}`,
			requestHash: `hash-${taskId}`,
		},
		...(attempts === undefined
			? {}
			: {
					toolResultBudget: {
						source: "pi-subagent",
						capturedAt: "2026-07-10T00:00:01.000Z",
						aggregate: { attempts: attempts.length },
						attempts,
					},
				}),
	};
}

function syntheticRun(tasks, overrides = {}) {
	const statusCounts = {
		pending: 0,
		running: 0,
		blocked: 0,
		completed: 0,
		failed: 0,
		skipped: 0,
		interrupted: 0,
		total: tasks.length,
	};
	for (const task of tasks) statusCounts[task.status] += 1;
	return {
		schemaVersion: 1,
		runId: overrides.runId ?? "workflow_dynamic_budget_fixture",
		name: "dynamic-budget-fixture",
		type: "artifact-graph",
		status: overrides.status ?? "completed",
		taskSummary: statusCounts,
		cwd: "/tmp/dynamic-budget",
		backend: { type: "local-pi", mode: "headless" },
		createdAt: "2026-07-10T00:00:00.000Z",
		updatedAt: "2026-07-10T00:00:02.000Z",
		specPath: "/tmp/dynamic-budget/spec.json",
		tasks,
		...overrides,
	};
}

test("dynamic child telemetry preserves launch config, result precedence, retries, and idempotence", async () => {
	const cwd = makeProject();
	let snapshot = null;
	try {
		setSubagentApiForTests({
			async runSubagent() {
				return {
					runId: "run_budget_current",
					attemptId: "attempt_budget_current",
					status: "running",
				};
			},
			async getSubagentStatus() {
				return snapshot;
			},
			async reconcileSubagentRun() {
				return {};
			},
			async interruptSubagent() {
				return {};
			},
		});
		const fixture = await createPendingSingleTaskRun(cwd, {
			specName: "dynamic-budget-terminal",
		});
		dynamicMetadata(fixture.task);
		fixture.task.toolResultBudget = {
			source: "pi-subagent",
			capturedAt: "2026-07-09T23:59:59.000Z",
			aggregate: { attempts: 1 },
			attempts: [
				{
					source: "seed",
					capturedAt: "2026-07-09T23:59:59.000Z",
					backendRunId: "run_budget_previous",
					backendAttemptId: "attempt_budget_previous",
					configured: true,
					configuredMaxTotalChars: 320_000,
					terminal: true,
					reported: true,
					enabled: true,
					maxTotalChars: 320_000,
					toolResults: 1,
					retainedChars: 40_000,
					evictedCount: 0,
					evictedChars: 0,
					evictableCount: 0,
				},
			],
		};

		await launchSubagentTask(
			cwd,
			fixture.run,
			fixture.task,
			fixture.compiled.tasks[0],
		);
		assert.equal(fixture.task.toolResultBudget.attempts.length, 2);
		const launchedAttempt = fixture.task.toolResultBudget.attempts.at(-1);
		assert.equal(launchedAttempt.configured, true);
		assert.equal(launchedAttempt.configurationSource, "default");
		assert.equal(launchedAttempt.configuredMaxTotalChars, 320_000);
		assert.equal(launchedAttempt.terminal, undefined);
		const backendHandle = structuredClone(fixture.task.backendHandle);

		const startedAt = fixture.task.startedAt;
		const completedAt = new Date(Date.parse(startedAt) + 250).toISOString();
		const artifactDir = writeTerminalArtifacts(cwd, fixture.task, {
			status: "completed",
			startedAt,
			completedAt,
			durationMs: 250,
			exitCode: 0,
			metadata: {
				contextRecovered: true,
				toolResultBudget: {
					enabled: true,
					maxTotalChars: 320_000,
					toolResults: 7,
					retainedChars: 160_000,
					evictedCount: 2,
					evictedChars: 48_000,
					evictableCount: 3,
					forcedEvictionApplied: false,
				},
			},
		});
		snapshot = statusSnapshot({
			runId: "run_budget_current",
			attemptId: "attempt_budget_current",
			artifactDir,
			startedAt,
			completedAt,
			metadata: {
				contextRecovered: false,
				toolResultBudget: {
					enabled: true,
					maxTotalChars: 1,
					retainedChars: 1,
					evictedCount: 99,
					evictedChars: 99,
				},
			},
		});

		let refreshed = await refreshRunFromSubagentArtifacts(cwd, fixture.run);
		let task = refreshed.tasks[0];
		assert.equal(task.status, "completed");
		assert.equal(task.toolResultBudget.attempts.length, 2);
		const terminalAttempt = task.toolResultBudget.attempts.at(-1);
		assert.equal(terminalAttempt.source, "subagent-result-metadata");
		assert.equal(terminalAttempt.configurationSource, "default");
		assert.equal(terminalAttempt.maxTotalChars, 320_000);
		assert.equal(terminalAttempt.retainedChars, 160_000);
		assert.equal(terminalAttempt.evictedCount, 2);
		assert.equal(terminalAttempt.contextRecovered, true);
		assert.equal(terminalAttempt.unavailable, undefined);
		assert.equal(task.toolResultBudget.aggregate.attempts, 2);
		assert.equal(task.toolResultBudget.aggregate.reportingAttempts, 2);
		assert.equal(task.toolResultBudget.aggregate.observedEvictedCount, 2);
		assert.equal(task.toolResultBudget.aggregate.observedEvictedChars, 48_000);
		assert.equal(task.toolResultBudget.aggregate.maxRetainedChars, 160_000);
		assert.equal(task.toolResultBudget.aggregate.maxUtilization, 0.5);

		// Reprocessing the same backend identity must replace, not append, its row.
		task.status = "running";
		task.statusDetail = "running";
		task.backendHandle = backendHandle;
		task.backendTaskId = backendHandle.runId;
		refreshed = await refreshRunFromSubagentArtifacts(cwd, refreshed);
		task = refreshed.tasks[0];
		assert.equal(task.toolResultBudget.attempts.length, 2);
		assert.deepEqual(
			task.toolResultBudget.attempts.map((attempt) => attempt.backendAttemptId),
			["attempt_budget_previous", "attempt_budget_current"],
		);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
	}
});

test("same-attempt terminal observations replace stale availability and snapshot counters", async () => {
	const cwd = makeProject();
	let snapshot = null;
	try {
		setSubagentApiForTests({
			async runSubagent() {
				return {
					runId: "run_budget_reconcile",
					attemptId: "attempt_budget_reconcile",
					status: "running",
				};
			},
			async getSubagentStatus() {
				return snapshot;
			},
			async reconcileSubagentRun() {
				return {};
			},
			async interruptSubagent() {
				return {};
			},
		});
		const fixture = await createPendingSingleTaskRun(cwd, {
			specName: "dynamic-budget-reconcile",
		});
		dynamicMetadata(fixture.task);
		await launchSubagentTask(
			cwd,
			fixture.run,
			fixture.task,
			fixture.compiled.tasks[0],
		);
		const startedAt = fixture.task.startedAt;
		const backendHandle = structuredClone(fixture.task.backendHandle);
		const completedAt = new Date(Date.parse(startedAt) + 100).toISOString();
		const artifactDir = writeTerminalArtifacts(cwd, fixture.task, {
			status: "completed",
			startedAt,
			completedAt,
			durationMs: 100,
			exitCode: 0,
		});
		snapshot = statusSnapshot({
			runId: "run_budget_reconcile",
			attemptId: "attempt_budget_reconcile",
			artifactDir,
			startedAt,
			completedAt,
		});

		let refreshed = await refreshRunFromSubagentArtifacts(cwd, fixture.run);
		let attempt = refreshed.tasks[0].toolResultBudget.attempts[0];
		assert.equal(attempt.unavailable, true);
		assert.equal(attempt.reported, undefined);

		snapshot.metadata = {
			toolResultBudget: {
				enabled: true,
				maxTotalChars: 320_000,
				toolResults: 5,
				retainedChars: 100_000,
				evictedCount: 1,
				evictedChars: 10_000,
				evictableCount: 2,
			},
		};
		refreshed.tasks[0].status = "running";
		refreshed.tasks[0].statusDetail = "running";
		refreshed.tasks[0].backendHandle = backendHandle;
		refreshed.tasks[0].backendTaskId = backendHandle.runId;
		refreshed = await refreshRunFromSubagentArtifacts(cwd, refreshed);
		attempt = refreshed.tasks[0].toolResultBudget.attempts[0];
		assert.equal(attempt.reported, true);
		assert.equal(attempt.unavailable, undefined);
		assert.equal(attempt.evictedCount, 1);

		writeFileSync(
			join(artifactDir, "result.json"),
			JSON.stringify({
				status: "completed",
				startedAt,
				completedAt,
				durationMs: 100,
				exitCode: 0,
				metadata: {
					toolResultBudget: {
						enabled: true,
						maxTotalChars: 320_000,
					},
				},
			}),
		);
		refreshed.tasks[0].status = "running";
		refreshed.tasks[0].statusDetail = "running";
		refreshed.tasks[0].backendHandle = backendHandle;
		refreshed.tasks[0].backendTaskId = backendHandle.runId;
		refreshed = await refreshRunFromSubagentArtifacts(cwd, refreshed);
		attempt = refreshed.tasks[0].toolResultBudget.attempts[0];
		assert.equal(attempt.source, "subagent-result-metadata");
		assert.equal(attempt.evictedCount, undefined);
		assert.equal(attempt.retainedChars, undefined);
		assert.equal(attempt.unavailable, undefined);
		assert.equal(
			refreshed.tasks[0].toolResultBudget.aggregate.evictionCounterExpectedAttempts,
			1,
		);
		assert.equal(
			refreshed.tasks[0].toolResultBudget.aggregate.evictionCounterReportingAttempts,
			0,
		);
		assert.equal(refreshed.tasks[0].toolResultBudget.incomplete, true);
		const metrics = buildDynamicToolResultBudgetMetrics(refreshed);
		assert.equal(metrics.totals.fullyReportingTasks, 0);
		assert.equal(metrics.totals.partiallyReportingTasks, 1);
		assert.equal(metrics.totals.completeTaskReportingRate, 0);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
	}
});

test("failed dynamic children retain snapshot telemetry and missing metadata is not zero", async () => {
	const cwd = makeProject();
	let snapshot = null;
	try {
		setSubagentApiForTests({
			async runSubagent() {
				return {
					runId: "run_budget_failed",
					attemptId: "attempt_budget_failed",
					status: "running",
				};
			},
			async getSubagentStatus() {
				return snapshot;
			},
			async reconcileSubagentRun() {
				return {};
			},
			async interruptSubagent() {
				return {};
			},
		});
		const fixture = await createPendingSingleTaskRun(cwd, {
			specName: "dynamic-budget-failed",
		});
		dynamicMetadata(fixture.task);
		await launchSubagentTask(
			cwd,
			fixture.run,
			fixture.task,
			fixture.compiled.tasks[0],
		);
		const startedAt = fixture.task.startedAt;
		const completedAt = new Date(Date.parse(startedAt) + 100).toISOString();
		const artifactDir = writeTerminalArtifacts(
			cwd,
			fixture.task,
			{
				status: "failed",
				failureKind: "guard_failure",
				startedAt,
				completedAt,
				durationMs: 100,
				exitCode: 1,
			},
			"failed before final output",
		);
		writeFileSync(join(artifactDir, "output.log"), "");
		writeFileSync(join(artifactDir, "stderr.log"), "guard failed\n");
		snapshot = statusSnapshot({
			runId: "run_budget_failed",
			attemptId: "attempt_budget_failed",
			artifactDir,
			status: "failed",
			failureKind: "guard_failure",
			startedAt,
			completedAt,
			metadata: {
				contextLengthExceeded: true,
				toolResultBudget: {
					enabled: true,
					maxTotalChars: 320_000,
					toolResults: 4,
					retainedChars: 319_000,
					evictedCount: 0,
					evictedChars: 0,
					evictableCount: 2,
				},
			},
		});
		const refreshed = await refreshRunFromSubagentArtifacts(cwd, fixture.run);
		const task = refreshed.tasks[0];
		assert.equal(task.status, "failed");
		assert.equal(
			task.toolResultBudget.attempts[0].source,
			"subagent-snapshot-metadata",
		);
		assert.equal(task.toolResultBudget.attempts[0].contextLengthExceeded, true);
		assert.equal(task.toolResultBudget.aggregate.contextLengthExceededAttempts, 1);
		assert.equal(task.toolResultBudget.aggregate.unavailableAttempts, 0);

		const oldRun = syntheticRun([
			syntheticTask({ taskId: "old-terminal", status: "failed" }),
		]);
		const oldMetrics = buildDynamicToolResultBudgetMetrics(oldRun);
		assert.equal(oldMetrics.totals.reportingTasks, 0);
		assert.equal(oldMetrics.totals.unavailableTasks, 1);
		assert.equal(oldMetrics.totals.observedEvictedCount, 0);
		assert.equal(oldMetrics.totals.incomplete, true);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
	}
});

test("launch-abort correlation recovery binds the pre-ack effective configuration", async () => {
	const cwd = makeProject();
	const controller = new AbortController();
	try {
		setSubagentApiForTests({
			async runSubagent() {
				controller.abort(new Error("unit launch lease lost"));
				return new Promise(() => {});
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
		const fixture = await createPendingSingleTaskRun(cwd, {
			specName: "dynamic-budget-launch-recovery",
		});
		dynamicMetadata(fixture.task);
		await assert.rejects(
			launchSubagentTask(
				cwd,
				fixture.run,
				fixture.task,
				fixture.compiled.tasks[0],
				controller.signal,
			),
			/unit launch lease lost/,
		);
		assert.equal(fixture.task.statusDetail, "launch_ack_aborted");
		assert.equal(
			fixture.task.toolResultBudget.pendingConfiguration
				.configuredMaxTotalChars,
			320_000,
		);
		assert.equal(fixture.task.toolResultBudget.attempts.length, 0);

		const runsRoot = join(cwd, fixture.task.backendFiles.runsDir);
		const recoveredRunId = "run_budget_recovered";
		const recoveredAttemptId = "attempt_budget_recovered";
		const recoveredRunDir = join(runsRoot, recoveredRunId);
		const artifactDir = join(recoveredRunDir, "attempts", recoveredAttemptId);
		mkdirSync(artifactDir, { recursive: true });
		writeFileSync(
			join(recoveredRunDir, "run.json"),
			JSON.stringify({
				runId: recoveredRunId,
				correlationId: `${fixture.run.runId}:${fixture.task.taskId}`,
				activeAttemptId: recoveredAttemptId,
				startedAt: fixture.task.startedAt,
				updatedAt: new Date().toISOString(),
			}),
		);
		const completedAt = new Date(
			Date.parse(fixture.task.startedAt) + 100,
		).toISOString();
		writeFileSync(
			join(artifactDir, "output.log"),
			[
				"<control>",
				JSON.stringify({ schema: "stage-control-v1", digest: "ok" }),
				"</control>",
				"<analysis>",
				"recovered",
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
				startedAt: fixture.task.startedAt,
				completedAt,
				durationMs: 100,
				exitCode: 0,
				metadata: {
					toolResultBudget: {
						enabled: true,
						maxTotalChars: 320_000,
						toolResults: 1,
						retainedChars: 10,
						evictedCount: 0,
						evictedChars: 0,
						evictableCount: 0,
					},
				},
			}),
		);
		const recoveredSnapshot = statusSnapshot({
			runId: recoveredRunId,
			attemptId: recoveredAttemptId,
			artifactDir,
			startedAt: fixture.task.startedAt,
			completedAt,
		});
		setSubagentApiForTests({
			async runSubagent() {
				throw new Error("not expected");
			},
			async getSubagentStatus() {
				return recoveredSnapshot;
			},
			async reconcileSubagentRun() {
				return {};
			},
			async interruptSubagent() {
				return {};
			},
		});

		const refreshed = await refreshRunFromSubagentArtifacts(cwd, fixture.run);
		const attempt = refreshed.tasks[0].toolResultBudget.attempts[0];
		assert.equal(refreshed.tasks[0].status, "completed");
		assert.equal(attempt.backendRunId, recoveredRunId);
		assert.equal(attempt.backendAttemptId, recoveredAttemptId);
		assert.equal(attempt.configurationSource, "default");
		assert.equal(attempt.configuredMaxTotalChars, 320_000);
		assert.equal(
			refreshed.tasks[0].toolResultBudget.pendingConfiguration,
			undefined,
		);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
	}
});

test("disabled dynamic budget configuration remains distinct from unavailable telemetry and static tasks", async () => {
	const cwd = makeProject();
	const previous = process.env.PI_WORKFLOW_DYNAMIC_TOOL_RESULT_BUDGET_CHARS;
	const captured = [];
	try {
		process.env.PI_WORKFLOW_DYNAMIC_TOOL_RESULT_BUDGET_CHARS = "100oops";
		setSubagentApiForTests({
			async runSubagent(options) {
				captured.push(options);
				return {
					runId: `run_budget_disabled_${captured.length}`,
					attemptId: `attempt_budget_disabled_${captured.length}`,
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
		const dynamicFixture = await createPendingSingleTaskRun(cwd, {
			specName: "dynamic-budget-disabled",
		});
		dynamicMetadata(dynamicFixture.task);
		await launchSubagentTask(
			cwd,
			dynamicFixture.run,
			dynamicFixture.task,
			dynamicFixture.compiled.tasks[0],
		);
		assert.equal(captured[0].toolResultBudget, undefined);
		assert.equal(dynamicFixture.task.toolResultBudget.attempts[0].configured, false);
		assert.equal(
			dynamicFixture.task.toolResultBudget.attempts[0].configurationSource,
			"disabled",
		);
		assert.equal(
			dynamicFixture.task.toolResultBudget.aggregate.unavailableAttempts,
			0,
		);

		const staticFixture = await createPendingSingleTaskRun(cwd, {
			specName: "static-budget-disabled",
		});
		await launchSubagentTask(
			cwd,
			staticFixture.run,
			staticFixture.task,
			staticFixture.compiled.tasks[0],
		);
		assert.equal(captured[1].toolResultBudget, undefined);
		assert.equal(staticFixture.task.toolResultBudget, undefined);
	} finally {
		if (previous === undefined) {
			delete process.env.PI_WORKFLOW_DYNAMIC_TOOL_RESULT_BUDGET_CHARS;
		} else {
			process.env.PI_WORKFLOW_DYNAMIC_TOOL_RESULT_BUDGET_CHARS = previous;
		}
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
	}
});

test("budget metrics keep retries separate, group controllers, and use max retained pressure", () => {
	const firstAttempts = [
		{
			source: "result",
			capturedAt: "2026-07-10T00:00:01.000Z",
			backendRunId: "run-1",
			backendAttemptId: "attempt-1",
			configured: true,
			configuredMaxTotalChars: 100,
			terminal: true,
			reported: true,
			enabled: true,
			maxTotalChars: 100,
			toolResults: 2,
			retainedChars: 40,
			evictedCount: 1,
			evictedChars: 10,
			evictableCount: 1,
		},
		{
			source: "result",
			capturedAt: "2026-07-10T00:00:02.000Z",
			backendRunId: "run-2",
			backendAttemptId: "attempt-2",
			configured: true,
			configuredMaxTotalChars: 100,
			terminal: true,
			reported: true,
			enabled: true,
			maxTotalChars: 100,
			toolResults: 5,
			retainedChars: 80,
			evictedCount: 2,
			evictedChars: 20,
			evictableCount: 3,
			forcedEvictionApplied: true,
			contextRecovered: true,
		},
	];
	const disabledAttempt = [
		{
			source: "pi-workflow-disabled",
			capturedAt: "2026-07-10T00:00:02.000Z",
			backendRunId: "run-disabled",
			backendAttemptId: "attempt-disabled",
			configured: false,
			configurationSource: "disabled",
			terminal: true,
		},
	];
	const run = syntheticRun([
		syntheticTask({ taskId: "a", attempts: firstAttempts }),
		syntheticTask({ taskId: "b", attempts: disabledAttempt }),
		syntheticTask({
			taskId: "c",
			controllerSpecId: "second.controller",
			status: "failed",
		}),
	]);

	const metrics = buildDynamicToolResultBudgetMetrics(run);
	assert.equal(metrics.totals.tasks, 3);
	assert.equal(metrics.totals.reportingTasks, 1);
	assert.equal(metrics.totals.disabledTasks, 1);
	assert.equal(metrics.totals.unavailableTasks, 1);
	assert.equal(metrics.totals.attempts, 3);
	assert.equal(metrics.totals.observedEvictedCount, 3);
	assert.equal(metrics.totals.observedEvictedChars, 30);
	assert.equal(metrics.totals.maxRetainedChars, 80);
	assert.equal(metrics.totals.maxUtilization, 0.8);
	assert.deepEqual(metrics.totals.utilizationSamples, [0.4, 0.8]);
	assert.equal(metrics.totals.contextRecoveryAttempts, 1);
	assert.equal(metrics.totals.forcedEvictionAttempts, 1);
	assert.equal(metrics.totals.completeTaskReportingRate, 0.5);
	assert.equal(metrics.byController.length, 2);
	assert.equal(
		metrics.byController.find(
			(controller) => controller.controllerSpecId === "adaptive.controller",
		).tasks,
		2,
	);
	assert.deepEqual(metrics.metadata.unavailableTaskIds, ["c"]);
	assert.deepEqual(metrics.metadata.disabledTaskIds, ["b"]);

	const partialRun = syntheticRun([
		syntheticTask({
			taskId: "partial",
			attempts: [
				firstAttempts[0],
				{
					source: "subagent-tool-result-budget-unavailable",
					capturedAt: "2026-07-10T00:00:03.000Z",
					backendRunId: "run-missing",
					backendAttemptId: "attempt-missing",
					configured: true,
					configuredMaxTotalChars: 100,
					terminal: true,
					unavailable: true,
				},
			],
		}),
	]);
	const partial = buildDynamicToolResultBudgetMetrics(partialRun);
	assert.equal(partial.totals.reportingTasks, 1);
	assert.equal(partial.totals.fullyReportingTasks, 0);
	assert.equal(partial.totals.partiallyReportingTasks, 1);
	assert.equal(partial.totals.unavailableTasks, 0);
	assert.equal(partial.totals.completeTaskReportingRate, 0);
	assert.equal(partial.totals.unavailableAttempts, 1);
	assert.equal(partial.totals.incomplete, true);
});

test("formatRun emits budget telemetry only for eviction, recovery, context, or warning signals", () => {
	const quiet = syntheticRun([
		syntheticTask({
			taskId: "quiet",
			attempts: [
				{
					source: "result",
					capturedAt: "2026-07-10T00:00:01.000Z",
					terminal: true,
					reported: true,
					enabled: true,
					maxTotalChars: 100,
					retainedChars: 50,
					evictedCount: 0,
					evictedChars: 0,
				},
			],
		}),
	]);
	assert.doesNotMatch(formatRun(quiet), /toolResultBudget=/);

	const signal = structuredClone(quiet);
	signal.tasks[0].toolResultBudget.attempts[0].evictedCount = 3;
	signal.tasks[0].toolResultBudget.attempts[0].evictedChars = 25;
	signal.tasks[0].toolResultBudget.attempts[0].contextRecovered = true;
	const formatted = formatRun(signal);
	assert.match(formatted, /toolResultBudget=evictionAttempts=1/);
	assert.match(formatted, /observedEvictedCount=3/);
	assert.match(formatted, /contextRecoveryAttempts=1/);
});

test("normalization rejects invalid counters without treating them as zero", () => {
	assert.deepEqual(
		normalizedToolResultBudgetValues({
			enabled: true,
			maxTotalChars: -1,
			toolResults: Number.NaN,
			retainedChars: -2,
			evictedCount: 0,
			evictedChars: 5,
			evictableCount: "3",
			forcedEvictionApplied: true,
			warning: "  warning  ",
		}),
		{
			enabled: true,
			warning: "warning",
			evictedCount: 0,
			evictedChars: 5,
			forcedEvictionApplied: true,
		},
	);
});
