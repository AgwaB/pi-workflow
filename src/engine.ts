import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { compileWorkflow } from "./compiler.js";
import { loadWorkflowSpec } from "./schema.js";
import {
	createRunRecord,
	createTaskRunRecord,
	compiledWorkflowPath,
	fromProjectPath,
	indexSupervisorErrorPath,
	isTerminalWorkflowStatus,
	isTerminalTaskStatus,
	listRunRecords,
	readIndex,
	readJson,
	readRunRecord,
	resetTaskForResume,
	setTaskTerminal,
	supervisorPath,
	toProjectPath,
	updateIndex,
	withRunLease,
	workflowRunPath,
	writeJsonAtomic,
	writeRunRecord,
	writeCompiledRunArtifact,
	writeStaticRunArtifacts,
} from "./store.js";
import { resolveWorkflowBackend } from "./backend.js";
import { ensureManagedWorktree } from "./worktree.js";
import { resolveWorkflowHelperRef } from "./workflow-helpers.js";
import { buildAvailableToolView } from "./tool-metadata.js";
import {
	workflowBundleFingerprint,
	workflowBundleSpecPath,
} from "./workflow-source-context-runtime.js";
import {
	readSimpleJsonPath,
	type WorkflowModelInfo,
	type WorkflowRuntimeDefaults,
} from "./workflow-runtime.js";
import {
	dynamicRunDir,
	hashDynamicRequest,
	readDynamicEvents,
} from "./dynamic-events.js";
import {
	ensureDynamicControllerInitialized,
	readOrRebuildDynamicState,
	recordDynamicControllerPhase,
	recordDynamicControllerStatus,
	recordDynamicEventAndUpdateState,
	type DynamicControllerStatus,
} from "./dynamic-state.js";
import {
	DynamicControllerBudgetBlocked,
	DynamicControllerNestedApprovalBlocked,
	DynamicControllerSuspended,
} from "./dynamic-controller-errors.js";
import {
	assertDynamicRuntimeBudgetAvailable,
	dynamicRuntimeBudgetExceededMessageForController,
	ensureDynamicControllerApproval,
	recordDynamicRuntimeUsage,
	type DynamicWorkflowUi,
} from "./dynamic-controller-policy.js";
import {
	assertDynamicGeneratedMetadataMatches,
	assertDynamicGenerationBudgetAvailable,
	buildDynamicGeneratedCompiledTask,
	dynamicGeneratedInsertIndex,
	isDynamicCompiledTaskPayload,
	normalizeDynamicAgentRequest,
	readDynamicGeneratedTaskResult,
} from "./dynamic-generated-task-runtime.js";
import {
	optionalEventString,
	runDynamicHelperCall,
	runDynamicNestedWorkflowCall,
} from "./dynamic-controller-calls.js";
import {
	normalizeDynamicFanoutPlanRequest,
	runDynamicDecisionLoopStatusPersistCall,
	runDynamicDecisionPersistCall,
	runDynamicFanoutPlanPersistCall,
	runDynamicResultReadCall,
	runDynamicStateIndexPersistCall,
} from "./dynamic-control-ops.js";
import {
	assertRunTaskPositionalAlignment,
	buildForeachGeneratedTasks,
	dependenciesReady,
	markDagDependentsSkipped,
	nextTaskRecordIndex,
	reconcileDynamicGeneratedRunRecords,
	reconcileForeachGeneratedRunRecords,
	recoverStaleRunningDynamicControllers,
	replaceDependencyList,
	sourceStageIdsForFrom,
	stageSourcePolicy,
	updateDownstreamDependencies,
} from "./engine-run-graph.js";
import {
	reconcileLoopTaskMaterialization,
	scheduleLoop,
} from "./loop-runtime.js";
import {
	executeSupportTask,
	normalizeDynamicControllerOutput,
	prepareArtifactGraphRetryTask,
	prepareDagTask,
	readArtifactGraphControl,
	readArtifactGraphSupportSources,
	readSupportSources,
	writeArtifactGraphDynamicResult,
} from "./artifact-graph-runtime.js";
import {
	DIRECT_DYNAMIC_RUNTIME_VERSION,
	ensureDirectDynamicRuntimeBundle,
} from "./dynamic-runtime-bundle.js";
import {
	type CompiledDynamicWorkflowTask,
	type CompiledTask,
	type CompiledWorkflow,
	WORKFLOW_RUN_TYPE,
	type WorkflowIndexRecord,
	type WorkflowRunRecord,
	type WorkflowTaskRunRecord,
} from "./types.js";

export { buildRunSourceContext } from "./workflow-source-context-runtime.js";
export { evaluateLoopUntilCondition } from "./loop-runtime.js";
export type { DynamicWorkflowUi } from "./dynamic-controller-policy.js";

const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
const MAX_WAIT_TIMEOUT_MS = 14_400_000;
const POLL_INTERVAL_MS = 1_000;
const LOG_LINES_DEFAULT = 80;
const LOG_LINES_MAX = 400;
const MAX_CONCURRENCY = 16;
const DYNAMIC_CONTROLLER_ENGINE_CAPABILITIES = Object.freeze({
	decisionLoop: true,
});
const DYNAMIC_CONTROLLER_ENGINE_INTEGRITY_ERROR_MESSAGE =
	"incompatible or stale pi-workflow engine: dynamic controller context is missing runDecisionLoop (rebuild dist / reload workflow engine)";
const supervisorTimers = new Map<string, ReturnType<typeof setInterval>>();
const supervisorRunMtimes = new Map<string, number>();

export interface WorkflowRunOptions {
	task?: string;
	runtimeOverrides?: WorkflowRuntimeDefaults;
	runtimeDefaults?: WorkflowRuntimeDefaults;
	availableModels?: WorkflowModelInfo[];
	dynamicUi?: DynamicWorkflowUi;
	runId?: string;
	parentRunId?: string;
}

interface WorkflowScheduleOptions {
	dynamicUi?: DynamicWorkflowUi;
	availableModels?: WorkflowModelInfo[];
}

export async function runWorkflowSpec(
	specPath: string,
	cwd: string,
	options: WorkflowRunOptions = {},
): Promise<WorkflowRunRecord> {
	const loaded = await loadWorkflowSpec(specPath, cwd);
	return runLoadedWorkflowSpec(cwd, loaded.specPath, loaded.spec, options);
}

export async function runDynamicTask(
	cwd: string,
	options: WorkflowRunOptions = {},
): Promise<WorkflowRunRecord> {
	if (!options.task || options.task.trim() === "") {
		throw new Error(
			'This dynamic workflow needs a task. Usage: /workflow dynamic "<task>"',
		);
	}
	const specPath = await ensureDirectDynamicRuntimeBundle(cwd);
	const loaded = await loadWorkflowSpec(specPath, cwd);
	return runLoadedWorkflowSpec(cwd, loaded.specPath, loaded.spec, options, {
		mode: "direct-dynamic",
		requestedWorkflow: null,
		specPath: null,
		userSelectedWorkflow: false,
		generatedSpec: false,
		runtimeBundle: toProjectPath(cwd, loaded.specPath),
		runtimeVersion: DIRECT_DYNAMIC_RUNTIME_VERSION,
	});
}

async function runLoadedWorkflowSpec(
	cwd: string,
	specPath: string,
	spec: Parameters<typeof compileWorkflow>[0],
	options: WorkflowRunOptions,
	provenance?: WorkflowRunRecord["provenance"],
): Promise<WorkflowRunRecord> {
	const compiled = await compileWorkflow(spec, {
		cwd,
		specPath,
		task: options.task,
		runtimeOverrides: options.runtimeOverrides,
		runtimeDefaults: options.runtimeDefaults,
		availableModels: options.availableModels,
	});

	const { run } = await createRunRecord(cwd, compiled, specPath, {
		runId: options.runId,
		parentRunId: options.parentRunId,
		rootRunId: options.parentRunId,
	});
	if (provenance) run.provenance = provenance;
	await withRunLease(cwd, run.runId, async () => {
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);
	});

	const scheduleOptions = {
		dynamicUi: options.dynamicUi,
		availableModels: options.availableModels,
	};
	const scheduled =
		(await scheduleRun(cwd, run.runId, compiled, scheduleOptions)) ??
		(await readRunRecord(cwd, run.runId));
	if (shouldWatchRun(scheduled))
		watchRun(cwd, scheduled.runId, scheduleOptions);
	return scheduled;
}

export async function refreshRun(
	cwd: string,
	runIdOrPrefix: string,
): Promise<WorkflowRunRecord> {
	const current = await readRunRecord(cwd, runIdOrPrefix);
	const refreshed = await withRunLease(cwd, current.runId, async () => {
		const run = await readRunRecord(cwd, current.runId);
		return resolveWorkflowBackend(run).refreshRun(cwd, run);
	});
	return refreshed ?? current;
}

function hasActiveSchedulerWork(
	run: Pick<WorkflowRunRecord, "status" | "taskSummary">,
): boolean {
	return (
		run.status === "running" ||
		run.taskSummary.running > 0 ||
		run.taskSummary.pending > 0
	);
}

function shouldWatchRun(
	run: Pick<WorkflowRunRecord, "status" | "taskSummary">,
): boolean {
	return hasActiveSchedulerWork(run);
}

export async function waitForRun(
	cwd: string,
	runIdOrPrefix: string,
	timeoutMs?: number,
	options: WorkflowScheduleOptions = {},
): Promise<WorkflowRunRecord> {
	const timeout = clampTimeout(timeoutMs);
	const deadline = Date.now() + timeout;
	let run = await refreshRun(cwd, runIdOrPrefix);

	while (hasActiveSchedulerWork(run)) {
		const beforeScheduleRemaining = deadline - Date.now();
		if (beforeScheduleRemaining <= 0)
			throw new Error(
				`Flow run still running after ${timeout}ms: ${run.runId}`,
			);
		await scheduleRun(cwd, run.runId, undefined, options);
		run = await refreshRun(cwd, run.runId);
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			if (!hasActiveSchedulerWork(run)) return run;
			throw new Error(
				`Flow run still running after ${timeout}ms: ${run.runId}`,
			);
		}
		await sleep(Math.min(POLL_INTERVAL_MS, remaining));
		run = await refreshRun(cwd, run.runId);
	}

	return run;
}

export interface ResumeRunSummary {
	run: WorkflowRunRecord;
	resetTaskIds: string[];
}

export interface StopRunSummary {
	run: WorkflowRunRecord;
	interruptedTaskIds: string[];
}

export async function stopRun(
	cwd: string,
	runIdOrPrefix: string,
): Promise<StopRunSummary> {
	const current = await readRunRecord(cwd, runIdOrPrefix);
	const stopped = await withRunLease(cwd, current.runId, async () => {
		const run = await readRunRecord(cwd, current.runId);
		if (isTerminalWorkflowStatus(run.status)) {
			throw new Error(`stop requires a non-terminal run; ${run.runId} is ${run.status}`);
		}
		await resolveWorkflowBackend(run).cleanupRun(cwd, run).catch(
			() => undefined,
		);
		const interruptedTaskIds: string[] = [];
		for (const task of run.tasks) {
			if (
				setTaskTerminal(task, "interrupted", "workflow_stopped", {
					exitCode: 130,
					lastMessage: "Workflow stopped by user request",
				})
			) {
				interruptedTaskIds.push(task.taskId);
			}
		}
		await writeRunRecord(cwd, run);
		unwatchRun(cwd, run.runId);
		return { run, interruptedTaskIds };
	});
	if (!stopped)
		throw new Error(`Could not acquire workflow run lease for ${current.runId}`);
	return stopped;
}

export async function resumeRun(
	cwd: string,
	runIdOrPrefix: string,
	options: WorkflowScheduleOptions = {},
): Promise<ResumeRunSummary> {
	const current = await readRunRecord(cwd, runIdOrPrefix);
	if (
		current.status !== "failed" &&
		current.status !== "interrupted" &&
		current.status !== "blocked"
	) {
		throw new Error(
			`resume requires a failed, interrupted, or resumable blocked run; ${current.runId} is ${current.status}`,
		);
	}
	const compiledFlow = await readCompiledWorkflow(cwd, current.runId);
	const hasLoopTasks =
		compiledFlow?.tasks.some(
			(task) =>
				task.kind === "loop" ||
				task.loopPlaceholder !== undefined ||
				task.loopChild !== undefined,
		) ?? false;
	if (hasLoopTasks || (current.loopStates?.length ?? 0) > 0) {
		throw new Error(
			`resume does not support loop workflows yet: ${current.runId}`,
		);
	}

	const resetTaskIds: string[] = [];
	const updated = await withRunLease(cwd, current.runId, async () => {
		const run = await readRunRecord(cwd, current.runId);
		await resolveWorkflowBackend(run).cleanupRun(cwd, run).catch(
			() => undefined,
		);
		for (const task of run.tasks) {
			if (resetTaskForResume(task)) resetTaskIds.push(task.taskId);
		}
		if (resetTaskIds.length > 0) await writeRunRecord(cwd, run);
		return run;
	});
	if (!updated)
		throw new Error(
			`Could not acquire supervisor lease for ${current.runId}; another supervisor may be active`,
		);
	if (resetTaskIds.length === 0)
		throw new Error(
			`No failed, interrupted, skipped, or resumable blocked tasks to resume in ${current.runId}`,
		);

	const scheduled =
		(await scheduleRun(cwd, current.runId, undefined, options)) ??
		(await readRunRecord(cwd, current.runId));
	if (shouldWatchRun(scheduled)) watchRun(cwd, scheduled.runId, options);
	return { run: scheduled, resetTaskIds };
}

export async function resumeSupervisors(
	cwd: string,
	options: WorkflowScheduleOptions = {},
): Promise<void> {
	try {
		const runs = await listRunRecords(cwd);
		for (const run of runs) {
			if (hasActiveSchedulerWork(run)) {
				await scheduleRun(cwd, run.runId, undefined, options).catch((error) =>
					recordSupervisorError(cwd, run.runId, error),
				);
				watchRun(cwd, run.runId, options);
			}
		}
		await updateIndex(cwd).catch((error) =>
			recordSupervisorError(cwd, "index", error),
		);
	} catch (error) {
		await recordSupervisorError(cwd, "index", error);
	}
}

function unwatchRun(cwd: string, runId: string): void {
	const key = `${cwd}\0${runId}`;
	const existing = supervisorTimers.get(key);
	if (existing) clearInterval(existing);
	supervisorTimers.delete(key);
	supervisorRunMtimes.delete(key);
}

export function watchRun(
	cwd: string,
	runId: string,
	options: WorkflowScheduleOptions = {},
): void {
	const key = `${cwd}\0${runId}`;
	if (supervisorTimers.has(key)) return;

	const timer = setInterval(() => {
		void (async () => {
			const previousMtime = supervisorRunMtimes.get(key);
			const beforeMtime = await readRunMtimeMs(cwd, runId);
			const refreshed = await refreshRun(cwd, runId);
			const afterMtime = await readRunMtimeMs(cwd, runId);
			const currentMtime = afterMtime ?? beforeMtime;
			if (currentMtime !== undefined)
				supervisorRunMtimes.set(key, currentMtime);

			if (hasActiveSchedulerWork(refreshed)) {
				const unchanged =
					previousMtime !== undefined &&
					currentMtime !== undefined &&
					currentMtime <= previousMtime;
				if (!unchanged) await scheduleRun(cwd, runId, undefined, options);
				return;
			}

			unwatchRun(cwd, runId);
		})().catch((error) => {
			void recordSupervisorError(cwd, runId, error);
		});
	}, POLL_INTERVAL_MS);

	timer.unref?.();
	supervisorTimers.set(key, timer);
}

async function readRunMtimeMs(
	cwd: string,
	runId: string,
): Promise<number | undefined> {
	try {
		return (await stat(workflowRunPath(cwd, runId))).mtimeMs;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export async function scheduleRun(
	cwd: string,
	runId: string,
	compiled?: CompiledWorkflow,
	options: WorkflowScheduleOptions = {},
): Promise<WorkflowRunRecord | undefined> {
	return withRunLease(cwd, runId, async () => {
		let run = await readRunRecord(cwd, runId);
		run = await resolveWorkflowBackend(run).refreshRun(cwd, run);
		if (isTerminalWorkflowStatus(run.status)) return run;
		if (
			run.taskSummary.blocked > 0 &&
			run.taskSummary.pending === 0 &&
			run.taskSummary.running === 0
		)
			return run;

		const compiledFlow =
			compiled ?? (await readCompiledWorkflow(cwd, run.runId));
		if (!compiledFlow) return run;

		if (compiledFlow.type !== WORKFLOW_RUN_TYPE) {
			throw new Error(
				`unsupported compiled workflow type: ${compiledFlow.type}`,
			);
		}
		await scheduleDag(cwd, run, compiledFlow, options);

		run = await readRunRecord(cwd, run.runId);
		return run;
	});
}

export async function formatStatus(cwd: string): Promise<string> {
	const cached = await readIndex(cwd);
	if (cached) {
		await reconcileIndexedActiveRuns(cwd, cached);
		const refreshed = (await readIndex(cwd).catch(() => cached)) ?? cached;
		if (refreshed.runs.length === 0) return "No workflow runs found.";
		return formatIndex(refreshed);
	}

	await reconcileActiveRuns(cwd);
	const rebuilt = await updateIndex(cwd).catch(() => readIndex(cwd));
	if (!rebuilt || rebuilt.runs.length === 0) return "No workflow runs found.";
	return formatIndex(rebuilt);
}

export async function formatRunDetails(
	cwd: string,
	runIdOrPrefix: string,
): Promise<string> {
	const run = await refreshRun(cwd, runIdOrPrefix);
	return formatRun(run, "full");
}

export async function formatRunStatus(
	cwd: string,
	runIdOrPrefix: string,
): Promise<string> {
	const run = await refreshRun(cwd, runIdOrPrefix);
	return formatRun(run, "summary");
}

export async function formatLogs(
	cwd: string,
	runIdOrPrefix: string,
	taskId = "task-1",
	lineCount = LOG_LINES_DEFAULT,
): Promise<string> {
	const run = await refreshRun(cwd, runIdOrPrefix);
	const task = run.tasks.find(
		(item) => item.taskId === taskId || item.specId === taskId,
	);
	if (!task) throw new Error(`Task not found in ${run.runId}: ${taskId}`);

	const outputFile = fromProjectPath(cwd, task.files.output);
	const count = Math.max(
		1,
		Math.min(LOG_LINES_MAX, Math.floor(lineCount || LOG_LINES_DEFAULT)),
	);
	let text: string;
	try {
		text = await readFile(outputFile, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") text = "";
		else throw error;
	}

	const tail = text.split(/\r?\n/).slice(-count).join("\n").trim();
	return `${run.runId}/${task.taskId} output=${task.files.output}\n${tail || "(empty log)"}`;
}

export function formatRun(
	run: WorkflowRunRecord,
	detail: "summary" | "full" = "summary",
): string {
	const lines = [
		`${run.runId} [${run.status}] type=${run.type} backend=${run.backend.type}/${run.backend.mode}`,
		`created=${run.createdAt} updated=${run.updatedAt}`,
		`tasks=${run.taskSummary.completed}/${run.taskSummary.total} completed, running=${run.taskSummary.running}, pending=${run.taskSummary.pending}, blocked=${run.taskSummary.blocked}, failed=${run.taskSummary.failed}, interrupted=${run.taskSummary.interrupted}`,
	];

	for (const task of run.tasks) {
		lines.push(formatTask(task, detail));
	}

	return lines.join("\n");
}

async function reconcileActiveRuns(cwd: string): Promise<void> {
	const runs = await listRunRecords(cwd);
	for (const run of runs) {
		if (hasActiveSchedulerWork(run))
			await refreshRun(cwd, run.runId).catch((error) =>
				recordSupervisorError(cwd, run.runId, error),
			);
	}
}

async function reconcileIndexedActiveRuns(
	cwd: string,
	index: WorkflowIndexRecord,
): Promise<void> {
	for (const run of index.runs) {
		if (hasActiveSchedulerWork(run))
			await refreshRun(cwd, run.runId).catch((error) =>
				recordSupervisorError(cwd, run.runId, error),
			);
	}
}

async function recordSupervisorError(
	cwd: string,
	runId: string,
	error: unknown,
): Promise<void> {
	const file =
		runId === "index"
			? indexSupervisorErrorPath(cwd)
			: supervisorPath(cwd, runId);
	await writeJsonAtomic(file, {
		schemaVersion: 1,
		status: "error",
		runId,
		pid: process.pid,
		updatedAt: new Date().toISOString(),
		error: error instanceof Error ? error.message : String(error),
	}).catch(() => undefined);
}

async function scheduleDag(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	options: WorkflowScheduleOptions = {},
): Promise<void> {
	if (compiledFlow.type === WORKFLOW_RUN_TYPE) {
		const loopReconciled = await reconcileLoopTaskMaterialization(
			cwd,
			run,
			compiledFlow,
		);
		if (loopReconciled) return;
		const foreachReconciled = reconcileForeachGeneratedRunRecords(
			cwd,
			run,
			compiledFlow,
		);
		if (foreachReconciled) {
			await writeJsonAtomic(compiledWorkflowPath(cwd, run.runId), compiledFlow);
			await writeRunRecord(cwd, run);
			return;
		}
		const dynamicReconciled = reconcileDynamicGeneratedRunRecords(
			cwd,
			run,
			compiledFlow,
		);
		const staleDynamicRecovered = recoverStaleRunningDynamicControllers(
			run,
			compiledFlow,
		);
		if (dynamicReconciled || staleDynamicRecovered)
			await writeRunRecord(cwd, run);
		assertRunTaskPositionalAlignment(run, compiledFlow);
	}

	const changed = markDagDependentsSkipped(run, compiledFlow);
	if (changed) {
		await writeRunRecord(cwd, run);
		run = await readRunRecord(cwd, run.runId);
	}

	const maxConcurrency = Math.max(
		1,
		Math.min(MAX_CONCURRENCY, compiledFlow.maxConcurrency),
	);
	let running = run.tasks.filter((task) => task.status === "running").length;
	const bySpecId = new Map(run.tasks.map((task) => [task.specId, task]));

	for (
		let index = 0;
		index < run.tasks.length && running < maxConcurrency;
		index += 1
	) {
		const task = run.tasks[index];
		const compiledTask = compiledFlow.tasks[index];
		if (!task || !compiledTask || task.status !== "pending") continue;
		if (
			await suspendedDynamicControllerStillWaiting(cwd, run, task, compiledTask)
		) {
			continue;
		}
		if (!dependenciesReady(compiledTask, bySpecId, compiledFlow)) continue;

		if (compiledTask.kind === "loop" && compiledTask.loopPlaceholder) {
			const changed = await scheduleLoop(
				cwd,
				run,
				compiledFlow,
				index,
				compiledTask,
			);
			if (changed) return;
			continue;
		}

		if (compiledTask.kind === "foreach" && compiledTask.foreach) {
			const changed = await materializeForeachTask(
				cwd,
				run,
				compiledFlow,
				index,
				compiledTask,
			);
			if (changed) return;
		}

		if (compiledTask.stageMaxConcurrency !== undefined) {
			const runningInStage = run.tasks.filter(
				(candidate) =>
					candidate.stageId === compiledTask.stageId &&
					candidate.status === "running",
			).length;
			if (
				runningInStage >=
				Math.max(1, Math.min(MAX_CONCURRENCY, compiledTask.stageMaxConcurrency))
			)
				continue;
		}

		const launched = await launchPendingTaskAt(
			cwd,
			run,
			compiledFlow,
			index,
			options,
		);
		if (launched && run.tasks[index]?.status === "running") running += 1;
	}
}

function isResumableDynamicApprovalBlockedRun(run: WorkflowRunRecord): boolean {
	return (
		run.status === "blocked" &&
		run.tasks.some(
			(task) =>
				task.status === "blocked" &&
				(task.statusDetail === "dynamic_ui_unavailable" ||
					task.statusDetail === "dynamic_approval_timeout"),
		)
	);
}

async function suspendedDynamicControllerStillWaiting(
	cwd: string,
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	compiledTask: CompiledTask,
): Promise<boolean> {
	if (compiledTask.kind !== "dynamic") return false;
	if (task.statusDetail !== "suspended_waiting_children") return false;
	const state = await readOrRebuildDynamicState(cwd, run.runId).catch(
		() => undefined,
	);
	const controllerState = state?.controllers[task.specId];
	const generatedTaskIds = controllerState?.generatedTaskIds ?? [];
	if (
		generatedTaskIds.some(
			(specId) => !run.tasks.some((candidate) => candidate.specId === specId),
		)
	) {
		return false;
	}
	const generatedTasks = generatedTaskIds
		.map((specId) => run.tasks.find((candidate) => candidate.specId === specId))
		.filter(
			(candidate): candidate is WorkflowTaskRunRecord =>
				candidate !== undefined,
		);
	let waiting = generatedTasks.some(
		(generated) => !isTerminalTaskStatus(generated.status),
	);
	if (
		(controllerState?.waitingNestedWorkflowRunIds ?? []).length === 0 &&
		generatedTasks.length > 0 &&
		generatedTasks.every((generated) => !isTerminalTaskStatus(generated.status))
	) {
		return true;
	}
	for (const nestedRunId of controllerState?.waitingNestedWorkflowRunIds ??
		[]) {
		const nestedRun = await readRunRecord(cwd, nestedRunId).catch(
			() => undefined,
		);
		if (nestedRun && isResumableDynamicApprovalBlockedRun(nestedRun)) {
			return false;
		}
		if (nestedRun && !isTerminalWorkflowStatus(nestedRun.status)) {
			waiting = true;
		}
	}
	if (!waiting) return false;
	const fingerprint = await dynamicSuspensionFingerprint(cwd, run, task.specId);
	return task.lastMessage?.includes(`[wait=${fingerprint}]`) ?? false;
}

async function dynamicSuspensionMessage(
	cwd: string,
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	message: string,
): Promise<string> {
	return `${message} [wait=${await dynamicSuspensionFingerprint(cwd, run, task.specId)}]`;
}

async function dynamicSuspensionFingerprint(
	cwd: string,
	run: WorkflowRunRecord,
	controllerSpecId: string,
): Promise<string> {
	const state = await readOrRebuildDynamicState(cwd, run.runId).catch(
		() => undefined,
	);
	const controllerState = state?.controllers[controllerSpecId];
	const generated = (controllerState?.generatedTaskIds ?? []).map((specId) => {
		const task = run.tasks.find((candidate) => candidate.specId === specId);
		return {
			specId,
			status: task?.status ?? "missing",
			statusDetail: task?.statusDetail,
		};
	});
	const nested = await Promise.all(
		(controllerState?.waitingNestedWorkflowRunIds ?? []).map(async (runId) => {
			const nestedRun = await readRunRecord(cwd, runId).catch(() => undefined);
			return {
				runId,
				status: nestedRun?.status ?? "missing",
				tasks: nestedRun?.tasks.map((task) => ({
					specId: task.specId,
					status: task.status,
					statusDetail: task.statusDetail,
				})),
			};
		}),
	);
	return hashDynamicRequest({ generated, nested }).slice(0, 16);
}

async function materializeForeachTask(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	index: number,
	template: CompiledTask,
): Promise<boolean> {
	const templateRunTask = run.tasks[index];
	if (!templateRunTask || !template.foreach || !template.stageId) return false;

	const sourceStageIds = sourceStageIdsForFrom(template.foreach.from);
	const sourceTasks = run.tasks.filter((task) =>
		sourceStageIds.includes(task.stageId ?? ""),
	);
	const extracted = await extractArtifactGraphForeachItems(
		cwd,
		{
			from: template.foreach.from,
			sourcePolicy: stageSourcePolicy(compiledFlow, template.stageId),
			maxItems: template.foreach.maxItems,
		},
		sourceTasks,
	);

	if (extracted.error) {
		setTaskTerminal(templateRunTask, "blocked", "foreach_expansion_blocked", {
			lastMessage: extracted.error,
		});
		await writeRunRecord(cwd, run);
		return true;
	}

	const items = extracted.items ?? [];
	const generated = buildForeachGeneratedTasks(
		template,
		compiledFlow.task,
		items,
	);
	if (generated.error) {
		setTaskTerminal(templateRunTask, "blocked", "foreach_expansion_blocked", {
			lastMessage: generated.error,
		});
		await writeRunRecord(cwd, run);
		return true;
	}

	const placeholderSpecId = template.id;
	const generatedSpecIds = generated.tasks.map((task) => task.id);
	compiledFlow.tasks.splice(index, 1, ...generated.tasks);
	updateDownstreamDependencies(
		compiledFlow,
		placeholderSpecId,
		generatedSpecIds,
	);

	const nextIndex = nextTaskRecordIndex(run);
	const generatedRunTasks = generated.tasks.map((task, offset) =>
		createTaskRunRecord(cwd, run.runId, task, nextIndex + offset),
	);
	run.tasks.splice(index, 1, ...generatedRunTasks);
	for (const task of run.tasks) {
		if (!task.dependsOn) continue;
		task.dependsOn = replaceDependencyList(
			task.dependsOn,
			placeholderSpecId,
			generatedSpecIds,
		);
	}

	await writeJsonAtomic(compiledWorkflowPath(cwd, run.runId), compiledFlow);
	await writeRunRecord(cwd, run);
	return true;
}

async function extractArtifactGraphForeachItems(
	cwd: string,
	stage: { from: unknown; sourcePolicy?: string; maxItems?: number },
	sourceTasks: WorkflowTaskRunRecord[],
): Promise<{ items?: unknown[]; error?: string }> {
	const items: unknown[] = [];
	const path = (stage.from as any)?.path;
	if (typeof path !== "string" || !path.startsWith("$.")) {
		return {
			error: "foreach.from.path must be a control JSONPath like $.items",
		};
	}
	for (const task of sourceTasks) {
		if (task.status !== "completed") {
			if (stage.sourcePolicy !== "partial")
				return { error: `${task.taskId} did not complete` };
			continue;
		}
		try {
			const control = await readArtifactGraphControl(cwd, task);
			const value = readSimpleJsonPath(control, path);
			if (!Array.isArray(value)) {
				if (stage.sourcePolicy !== "partial") {
					return {
						error: `${task.taskId} control ${path} did not resolve to an array`,
					};
				}
				continue;
			}
			items.push(...value);
		} catch (error) {
			if (stage.sourcePolicy !== "partial") {
				return {
					error: error instanceof Error ? error.message : String(error),
				};
			}
		}
	}
	if (typeof stage.maxItems === "number" && items.length > stage.maxItems) {
		return {
			error: `foreach extracted ${items.length} items, exceeding maxItems=${stage.maxItems}`,
		};
	}
	return { items };
}

async function launchPendingTaskAt(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	index: number,
	options: WorkflowScheduleOptions = {},
): Promise<boolean> {
	const task = run.tasks[index];
	if (!task || task.status !== "pending") return false;
	if (task.backendHandle || task.pid) return false;

	const compiledTask = compiledFlow.tasks[index];
	if (!compiledTask) {
		setTaskTerminal(task, "failed", "compile_missing", {
			lastMessage: "compiled task is missing",
		});
		await writeRunRecord(cwd, run);
		return false;
	}

	let launchTask: CompiledWorkflow["tasks"][number] | undefined;
	let prepareComplete = false;
	try {
		launchTask = await prepareDagTask(cwd, run, compiledFlow, index);
		if (task.outputRetry) {
			launchTask = await prepareArtifactGraphRetryTask(cwd, task, launchTask);
		}
		prepareComplete = true;

		if (launchTask.kind === "support") {
			return await executeSupportTask(cwd, run, task, launchTask);
		}
		if (launchTask.kind === "dynamic") {
			return await executeDynamicControllerTask(
				cwd,
				run,
				compiledFlow,
				index,
				task,
				launchTask,
				options,
			);
		}
		const worktreeLaunchTask = applyExistingLoopWorktree(run, task, launchTask);
		await ensureManagedWorktree(cwd, run, task, worktreeLaunchTask);
		recordCreatedLoopWorktree(run, task, worktreeLaunchTask);
		await writeRunRecord(cwd, run);
		const launch = await resolveWorkflowBackend(run).launchTask(
			cwd,
			run,
			task,
			worktreeLaunchTask,
		);
		if (launch.kind === "fatal") throw new Error(launch.message);
		return launch.kind === "launched";
	} catch (error) {
		const statusDetail = !prepareComplete
			? "prepare_failed"
			: launchTask?.kind === "support"
				? "support_failed"
				: launchTask?.safety.requiresWorktree
					? "worktree_failed"
					: "launch_failed";
		setTaskTerminal(task, "failed", statusDetail, {
			lastMessage: error instanceof Error ? error.message : String(error),
		});
		await writeRunRecord(cwd, run).catch(() => undefined);
		markDagDependentsSkipped(run, compiledFlow);
		await writeRunRecord(cwd, run).catch(() => undefined);
		return false;
	}
}

async function executeDynamicControllerTask(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	controllerIndex: number,
	task: WorkflowTaskRunRecord,
	compiledTask: CompiledWorkflow["tasks"][number],
	options: WorkflowScheduleOptions = {},
): Promise<boolean> {
	if (!compiledTask.dynamic) {
		throw new Error("dynamic metadata is missing");
	}
	task.status = "running";
	task.statusDetail = "running";
	task.startedAt = task.startedAt ?? new Date().toISOString();
	await writeRunRecord(cwd, run);
	let helperSpecPath: string;

	try {
		helperSpecPath = await workflowBundleSpecPath(cwd, run, {
			required: true,
		});
		await ensureDynamicControllerInitialized(cwd, run.runId, {
			controllerSpecId: task.specId,
			controllerTaskId: task.taskId,
			stageId: task.stageId,
			dynamic: compiledTask.dynamic,
			contentFingerprint: await workflowBundleFingerprint(cwd, run),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await recordDynamicControllerStatus(cwd, run.runId, {
			controllerSpecId: task.specId,
			status: "failed",
			message,
		}).catch(() => undefined);
		setTaskTerminal(task, "failed", "dynamic_failed", {
			lastMessage: message,
		});
		await writeRunRecord(cwd, run);
		return false;
	}
	if (compiledTask.dynamic.permissions.approval === "ask") {
		const approval = await ensureDynamicControllerApproval({
			cwd,
			run,
			task,
			dynamic: compiledTask.dynamic,
			taskText: compiledFlow.task,
			ui: options.dynamicUi,
		});
		if (!approval.allowed) {
			setTaskTerminal(task, "blocked", approval.statusDetail, {
				lastMessage: approval.message,
			});
			await writeRunRecord(cwd, run);
			return false;
		}
	}
	const runtimeBudgetMessage =
		await dynamicRuntimeBudgetExceededMessageForController(
			cwd,
			run.runId,
			task.specId,
			compiledTask.dynamic,
		);
	if (runtimeBudgetMessage) {
		await recordDynamicControllerStatus(cwd, run.runId, {
			controllerSpecId: task.specId,
			status: "budget_blocked",
			message: runtimeBudgetMessage,
		});
		setTaskTerminal(task, "blocked", "dynamic_budget_blocked", {
			lastMessage: runtimeBudgetMessage,
		});
		await writeRunRecord(cwd, run);
		return false;
	}
	await recordDynamicControllerStatus(cwd, run.runId, {
		controllerSpecId: task.specId,
		status: "running",
	});

	const sources = compiledTask.artifactGraph?.enabled
		? await readArtifactGraphSupportSources(
				cwd,
				run,
				compiledTask.dependsOn ?? [],
			)
		: await readSupportSources(cwd, run, compiledTask.dependsOn ?? []);

	const activeRuntimeStartedAt = Date.now();
	let activeRuntimeRecorded = false;
	const recordActiveRuntime = async (): Promise<void> => {
		if (activeRuntimeRecorded) return;
		activeRuntimeRecorded = true;
		const elapsedMs = Math.max(0, Date.now() - activeRuntimeStartedAt);
		if (elapsedMs === 0) return;
		await recordDynamicRuntimeUsage(
			cwd,
			run.runId,
			task.specId,
			elapsedMs,
		).catch(() => undefined);
	};

	try {
		const structuredOutput = await runDynamicControllerWorker({
			cwd,
			run,
			compiledFlow,
			controllerIndex,
			controllerTask: task,
			controllerCompiledTask: compiledTask,
			helperSpecPath,
			sources,
			dynamic: compiledTask.dynamic,
			dynamicUi: options.dynamicUi,
			availableModels: options.availableModels,
		});
		await assertDynamicGeneratedTasksSettled({
			cwd,
			run,
			compiledFlow,
			controllerIndex,
			controllerTask: task,
			controllerCompiledTask: compiledTask,
			dynamic: compiledTask.dynamic,
			availableModels: options.availableModels,
		});
		await recordActiveRuntime();
		const unrunBranchBlockers = await dynamicUnrunBranchBlockers(
			cwd,
			run.runId,
			task.specId,
		);
		const outputForOutcome =
			unrunBranchBlockers.length > 0
				? dynamicControllerOutputWithBranchBlockers(
						structuredOutput,
						unrunBranchBlockers,
					)
				: structuredOutput;
		const outcome = dynamicControllerOutcomeFromOutput(outputForOutcome);
		if (compiledTask.artifactGraph?.enabled) {
			await writeArtifactGraphDynamicResult(
				cwd,
				task,
				outputForOutcome,
				outcome.lifecycleStatus,
			);
		} else {
			await mkdir(dirname(fromProjectPath(cwd, task.files.output)), {
				recursive: true,
			});
			await writeFile(
				fromProjectPath(cwd, task.files.output),
				`${JSON.stringify(outputForOutcome, null, 2)}\n`,
				"utf8",
			);
			await writeFile(fromProjectPath(cwd, task.files.stderr), "", "utf8");
			await writeJsonAtomic(fromProjectPath(cwd, task.files.result), {
				status: outcome.lifecycleStatus,
				structuredOutput: outputForOutcome,
			});
		}
		await recordDynamicControllerStatus(cwd, run.runId, {
			controllerSpecId: task.specId,
			status: outcome.controllerStatus,
			...(outcome.taskStatus === "completed"
				? {}
				: { message: outcome.message }),
			blockers: outcome.blockers,
			omissions: outcome.omissions,
		});
		setTaskTerminal(task, outcome.taskStatus, outcome.statusDetail, {
			lastMessage: outcome.message,
		});
		await writeRunRecord(cwd, run);
		return outcome.taskStatus === "completed";
	} catch (error) {
		await recordActiveRuntime();
		if (error instanceof DynamicControllerSuspended) {
			const message = await dynamicSuspensionMessage(
				cwd,
				run,
				task,
				error.message,
			);
			await recordDynamicControllerStatus(cwd, run.runId, {
				controllerSpecId: task.specId,
				status: "suspended_waiting_children",
				message,
			}).catch(() => undefined);
			task.status = "pending";
			task.statusDetail = "suspended_waiting_children";
			task.lastMessage = message;
			task.backendHandle = undefined;
			task.pid = undefined;
			await writeRunRecord(cwd, run);
			return false;
		}
		if (error instanceof DynamicControllerNestedApprovalBlocked) {
			await recordDynamicControllerStatus(cwd, run.runId, {
				controllerSpecId: task.specId,
				status: "awaiting_ui_unavailable",
				message: error.message,
			}).catch(() => undefined);
			setTaskTerminal(task, "blocked", "dynamic_ui_unavailable", {
				lastMessage: error.message,
			});
			await writeRunRecord(cwd, run);
			return false;
		}
		if (error instanceof DynamicControllerBudgetBlocked) {
			await recordDynamicControllerStatus(cwd, run.runId, {
				controllerSpecId: task.specId,
				status: "budget_blocked",
				message: error.message,
			}).catch(() => undefined);
			setTaskTerminal(task, "blocked", "dynamic_budget_blocked", {
				lastMessage: error.message,
			});
			await writeRunRecord(cwd, run);
			return false;
		}
		const message = error instanceof Error ? error.message : String(error);
		await recordDynamicControllerStatus(cwd, run.runId, {
			controllerSpecId: task.specId,
			status: "failed",
			message,
		}).catch(() => undefined);
		setTaskTerminal(task, "failed", "dynamic_failed", {
			lastMessage: message,
		});
		await writeRunRecord(cwd, run);
		return false;
	}
}

function dynamicDecisionLoopModuleUrl(): string {
	const enginePath = fileURLToPath(import.meta.url);
	if (extname(enginePath) === ".ts") {
		return pathToFileURL(
			resolve(dirname(enginePath), "../dist/dynamic-decision-loop.js"),
		).href;
	}
	return new URL("./dynamic-decision-loop.js", import.meta.url).href;
}

async function runDynamicControllerWorker(input: {
	cwd: string;
	run: WorkflowRunRecord;
	compiledFlow: CompiledWorkflow;
	controllerIndex: number;
	controllerTask: WorkflowTaskRunRecord;
	controllerCompiledTask: CompiledTask;
	helperSpecPath: string;
	sources: Record<string, unknown>;
	dynamic: CompiledDynamicWorkflowTask;
	dynamicUi?: DynamicWorkflowUi;
	availableModels?: WorkflowModelInfo[];
}): Promise<unknown> {
	const resolved = await resolveWorkflowHelperRef(
		input.dynamic.uses,
		input.helperSpecPath,
		{ label: "dynamic controller" },
	);
	const controllerStageId =
		input.controllerTask.stageId ??
		input.controllerTask.specId.replace(/\.controller$/, "");
	const state = await readOrRebuildDynamicState(input.cwd, input.run.runId);
	const controllerState = state.controllers[input.controllerTask.specId];
	const generatedTaskIds = [...(controllerState?.generatedTaskIds ?? [])];
	const generatedBranchTaskIds = (controllerState?.branches ?? [])
		.map((branch) => branch.specId)
		.filter((specId): specId is string => typeof specId === "string");
	const worker = new Worker(DYNAMIC_CONTROLLER_WORKER_SOURCE, {
		eval: true,
		workerData: {
			controllerUrl: pathToFileURL(resolved.path).href,
			decisionLoopModuleUrl: dynamicDecisionLoopModuleUrl(),
			engineCapabilities: DYNAMIC_CONTROLLER_ENGINE_CAPABILITIES,
			task: input.compiledFlow.task ?? input.controllerCompiledTask.task,
			sources: input.sources,
			controllerStageId,
			generatedTaskIds,
			generatedBranchTaskIds,
			budgetRemaining: await currentDynamicBudgetRemaining(input),
			availableTools: buildAvailableToolView(
				input.controllerCompiledTask.runtime.tools,
				input.controllerCompiledTask.runtime.toolProviders,
			),
			decisionLoop: input.dynamic.decisionLoop,
		},
	});
	const helperCallCounts = new Map<string, number>();
	const workflowCallCounts = new Map<string, number>();
	const agentOpIds = new Set<string>();
	const replayedOpIds = new Set<string>();
	const replayPrefix = {
		opIds: await priorDynamicOperationOpIds(input),
		cursor: 0,
	};
	let settled = false;
	let currentGeneratedTaskIds = generatedTaskIds;
	const timeoutMs = remainingDynamicRuntimeMs(
		input.dynamic,
		state.controllers[input.controllerTask.specId]?.counters.runtimeMs ?? 0,
	);

	return await new Promise<unknown>((resolvePromise, rejectPromise) => {
		let opQueue = Promise.resolve();
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			worker.removeAllListeners();
			void worker.terminate().catch(() => undefined);
			callback();
		};
		const timer = setTimeout(
			() => {
				finish(() =>
					rejectPromise(
						new DynamicControllerBudgetBlocked(
							`dynamic runtime budget exhausted: maxRuntimeMs=${input.dynamic.budget.maxRuntimeMs}`,
						),
					),
				);
			},
			Math.max(1, timeoutMs),
		);
		worker.on("message", (message) => {
			const runHandler = async (): Promise<void> => {
				if (settled) return;
				await handleDynamicWorkerMessage(input, message, {
					helperCallCounts,
					workflowCallCounts,
					agentOpIds,
					replayedOpIds,
					replayPrefix,
					getGeneratedTaskIds: () => currentGeneratedTaskIds,
					setGeneratedTaskIds: (ids) => {
						currentGeneratedTaskIds = ids;
					},
					isSettled: () => settled,
					postResult: (id, result) =>
						worker.postMessage({
							type: "opResult",
							id,
							generatedTaskIds: currentGeneratedTaskIds,
							...result,
						}),
					finish,
					resolve: resolvePromise,
					reject: rejectPromise,
				});
			};
			opQueue = opQueue.then(runHandler, runHandler).catch((error) => {
				finish(() => rejectPromise(error));
			});
		});
		worker.on("error", (error) => finish(() => rejectPromise(error)));
		worker.on("exit", (code) => {
			if (!settled && code !== 0) {
				finish(() =>
					rejectPromise(
						new Error(`dynamic controller worker exited with code ${code}`),
					),
				);
			}
		});
	});
}

export async function runDynamicControllerEngineIntegrityCheckForTests(
	input: {
		controllerSource?: string;
		engineCapabilities?: Record<string, unknown>;
	} = {},
): Promise<unknown> {
	const controllerSource =
		input.controllerSource ??
		"export default function controller() { return { ok: true }; }\n";
	const worker = new Worker(DYNAMIC_CONTROLLER_WORKER_SOURCE, {
		eval: true,
		workerData: {
			controllerUrl: `data:text/javascript;charset=utf-8,${encodeURIComponent(controllerSource)}`,
			decisionLoopModuleUrl: dynamicDecisionLoopModuleUrl(),
			engineCapabilities:
				input.engineCapabilities ?? DYNAMIC_CONTROLLER_ENGINE_CAPABILITIES,
			task: "",
			sources: {},
			generatedTaskIds: [],
			generatedBranchTaskIds: [],
			budgetRemaining: {},
			availableTools: [],
			decisionLoop: null,
		},
	});

	return await new Promise<unknown>((resolvePromise, rejectPromise) => {
		let settled = false;
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			worker.removeAllListeners();
			void worker.terminate().catch(() => undefined);
			callback();
		};
		worker.on("message", (message) => {
			if (message?.type === "done") finish(() => resolvePromise(message.value));
			else if (message?.type === "error") {
				finish(() => rejectPromise(dynamicWorkerError(message.error)));
			} else if (message?.type === "op") {
				finish(() =>
					rejectPromise(
						new Error(
							`unexpected dynamic controller test operation: ${String(message.op)}`,
						),
					),
				);
			}
		});
		worker.on("error", (error) => finish(() => rejectPromise(error)));
		worker.on("exit", (code) => {
			if (!settled && code !== 0) {
				finish(() =>
					rejectPromise(
						new Error(`dynamic controller worker exited with code ${code}`),
					),
				);
			}
		});
	});
}

async function handleDynamicWorkerMessage(
	input: {
		cwd: string;
		run: WorkflowRunRecord;
		compiledFlow: CompiledWorkflow;
		controllerIndex: number;
		controllerTask: WorkflowTaskRunRecord;
		controllerCompiledTask: CompiledTask;
		helperSpecPath: string;
		dynamic: CompiledDynamicWorkflowTask;
		dynamicUi?: DynamicWorkflowUi;
	},
	message: any,
	state: {
		helperCallCounts: Map<string, number>;
		workflowCallCounts: Map<string, number>;
		agentOpIds: Set<string>;
		replayedOpIds: Set<string>;
		replayPrefix: { opIds: string[]; cursor: number };
		getGeneratedTaskIds: () => string[];
		setGeneratedTaskIds: (ids: string[]) => void;
		isSettled: () => boolean;
		postResult: (
			id: number,
			result: {
				value?: unknown;
				error?: { name: string; message: string };
				budgetRemaining?: Record<string, number>;
			},
		) => void;
		finish: (callback: () => void) => void;
		resolve: (value: unknown) => void;
		reject: (error: unknown) => void;
	},
): Promise<void> {
	if (state.isSettled()) return;
	if (!message || typeof message !== "object") return;
	if (message.type === "log") {
		await appendDynamicControllerLog(
			input.cwd,
			input.run.runId,
			input.controllerTask.specId,
			Array.isArray(message.args) ? message.args : [],
		);
		return;
	}
	if (message.type === "done") {
		await assertPriorDynamicOpsReplayed(
			input,
			state.replayedOpIds,
			state.replayPrefix,
		);
		state.finish(() => state.resolve(message.value));
		return;
	}
	if (message.type === "error") {
		state.finish(() => state.reject(dynamicWorkerError(message.error)));
		return;
	}
	if (message.type !== "op" || typeof message.id !== "number") return;
	try {
		let value: unknown;
		if (message.op === "phase") {
			if (typeof message.name === "string" && message.name.trim() !== "") {
				await recordDynamicControllerPhase(input.cwd, input.run.runId, {
					controllerSpecId: input.controllerTask.specId,
					phase: message.name,
				});
			}
			value = null;
		} else if (message.op === "agent") {
			const request = normalizeDynamicAgentRequest(message.request);
			const opId = `${input.controllerTask.specId}:agent:${request.id}`;
			if (state.agentOpIds.has(opId)) {
				throw new Error(
					`duplicate dynamic agent id in one controller execution: ${request.id}`,
				);
			}
			state.agentOpIds.add(opId);
			const replayOpId = await dynamicReplayOpIdForAgentRequest({
				cwd: input.cwd,
				runId: input.run.runId,
				controllerSpecId: input.controllerTask.specId,
				opId,
				branchId: request.branchId,
				requestHash: hashDynamicRequest(request),
			});
			assertDynamicReplayPrefix(state.replayPrefix, replayOpId);
			state.replayedOpIds.add(replayOpId);
			value = await runDynamicAgentRequest({
				...input,
				request,
				generatedTaskIds: state.getGeneratedTaskIds(),
				isSettled: state.isSettled,
			});
			state.setGeneratedTaskIds([
				...((await readOrRebuildDynamicState(input.cwd, input.run.runId))
					.controllers[input.controllerTask.specId]?.generatedTaskIds ?? []),
			]);
		} else if (message.op === "decision") {
			const callIndex = requiredDynamicPositiveInteger(
				message.callIndex,
				"decision call index",
				"ctx.decision.validateAndPersist()",
			);
			const opId = `${input.controllerTask.specId}:decision:${String(callIndex).padStart(3, "0")}`;
			assertDynamicReplayPrefix(state.replayPrefix, opId);
			state.replayedOpIds.add(opId);
			value = await runDynamicDecisionPersistCall({
				cwd: input.cwd,
				run: input.run,
				controllerTask: input.controllerTask,
				opId,
				callIndex,
				rawDecision: message.rawDecision,
				context: message.context,
			});
		} else if (message.op === "fanoutPlan") {
			const callIndex = requiredDynamicPositiveInteger(
				message.callIndex,
				"fanout plan call index",
				"ctx.fanout.plan()",
			);
			const request = normalizeDynamicFanoutPlanRequest(message.request);
			const opId = `${input.controllerTask.specId}:fanout:r${request.round}:${request.decisionHash}`;
			assertDynamicReplayPrefix(state.replayPrefix, opId);
			state.replayedOpIds.add(opId);
			value = await runDynamicFanoutPlanPersistCall({
				cwd: input.cwd,
				run: input.run,
				controllerTask: input.controllerTask,
				opId,
				callIndex,
				request,
			});
		} else if (message.op === "stateIndex") {
			const callIndex = requiredDynamicPositiveInteger(
				message.callIndex,
				"state index call index",
				"ctx.stateIndex.extractAndPersist()",
			);
			const opId = `${input.controllerTask.specId}:state-index:${String(callIndex).padStart(3, "0")}`;
			assertDynamicReplayPrefix(state.replayPrefix, opId);
			state.replayedOpIds.add(opId);
			value = await runDynamicStateIndexPersistCall({
				cwd: input.cwd,
				run: input.run,
				controllerTask: input.controllerTask,
				controllerCompiledTask: input.controllerCompiledTask,
				opId,
				callIndex,
				request: message.request,
			});
		} else if (message.op === "controllerStatus") {
			const callIndex = requiredDynamicPositiveInteger(
				message.callIndex,
				"controller status call index",
				"ctx.dynamic.recordDecisionLoopStatus()",
			);
			const opId = `${input.controllerTask.specId}:decision-loop-status:${String(callIndex).padStart(3, "0")}`;
			assertDynamicReplayPrefix(state.replayPrefix, opId);
			state.replayedOpIds.add(opId);
			value = await runDynamicDecisionLoopStatusPersistCall({
				cwd: input.cwd,
				run: input.run,
				controllerTask: input.controllerTask,
				opId,
				callIndex,
				request: message.request,
			});
		} else if (message.op === "result") {
			const callIndex = requiredDynamicPositiveInteger(
				message.callIndex,
				"result call index",
				"ctx.result()",
			);
			const opId = `${input.controllerTask.specId}:result:${String(callIndex).padStart(3, "0")}`;
			assertDynamicReplayPrefix(state.replayPrefix, opId);
			state.replayedOpIds.add(opId);
			value = await runDynamicResultReadCall({
				cwd: input.cwd,
				run: input.run,
				controllerTask: input.controllerTask,
				controllerCompiledTask: input.controllerCompiledTask,
				opId,
				callIndex,
				request: message.request,
			});
		} else if (message.op === "helper") {
			const helperId = requiredDynamicString(
				message.name,
				"helper name",
				"ctx.helper()",
			);
			const count = (state.helperCallCounts.get(helperId) ?? 0) + 1;
			state.helperCallCounts.set(helperId, count);
			const opId = `${input.controllerTask.specId}:helper:${helperId}:${String(count).padStart(3, "0")}`;
			assertDynamicReplayPrefix(state.replayPrefix, opId);
			state.replayedOpIds.add(opId);
			value = await runDynamicHelperCall({
				runDynamicHelperWorker,
				cwd: input.cwd,
				run: input.run,
				controllerTask: input.controllerTask,
				helperSpecPath: input.helperSpecPath,
				dynamic: input.dynamic,
				helperId,
				callIndex: count,
				helperInput: message.input,
				isSettled: state.isSettled,
			});
		} else if (message.op === "workflow") {
			const workflowId = requiredDynamicString(
				message.name,
				"workflow name",
				"ctx.workflow()",
			);
			const count = (state.workflowCallCounts.get(workflowId) ?? 0) + 1;
			state.workflowCallCounts.set(workflowId, count);
			const opId = `${input.controllerTask.specId}:workflow:${workflowId}:${String(count).padStart(3, "0")}`;
			assertDynamicReplayPrefix(state.replayPrefix, opId);
			state.replayedOpIds.add(opId);
			value = await runDynamicNestedWorkflowCall({
				runWorkflowSpec,
				refreshRun,
				isResumableDynamicApprovalBlockedRun,
				cwd: input.cwd,
				run: input.run,
				controllerTask: input.controllerTask,
				helperSpecPath: input.helperSpecPath,
				dynamic: input.dynamic,
				dynamicUi: input.dynamicUi,
				workflowId,
				callIndex: count,
				workflowInput: message.input,
				isSettled: state.isSettled,
			});
		} else {
			throw new Error(`unsupported dynamic controller op: ${message.op}`);
		}
		if (state.isSettled()) return;
		state.postResult(message.id, {
			value,
			budgetRemaining: await currentDynamicBudgetRemaining(input),
		});
	} catch (error) {
		// Ordinary DynamicControllerSuspended operation errors are returned to the
		// worker instead of finishing the parent immediately. This lets ctx.parallel()
		// post and record all sibling generation ops in one scheduling pass before
		// the worker's final suspended error stops the controller.
		if (
			error instanceof DynamicControllerNestedApprovalBlocked ||
			error instanceof DynamicControllerBudgetBlocked ||
			isDynamicReplayInvariantError(error)
		) {
			state.finish(() => state.reject(error));
			return;
		}
		state.postResult(message.id, {
			error: serializeDynamicWorkerError(error),
			budgetRemaining: await currentDynamicBudgetRemaining(input).catch(
				() => undefined,
			),
		});
	}
}

async function dynamicReplayOpIdForAgentRequest(input: {
	cwd: string;
	runId: string;
	controllerSpecId: string;
	opId: string;
	branchId?: string;
	requestHash: string;
}): Promise<string> {
	const events = await readDynamicEvents(input.cwd, input.runId);
	return (
		findDynamicGeneratedTaskEvent(events, {
			controllerSpecId: input.controllerSpecId,
			opId: input.opId,
			branchId: input.branchId,
			requestHash: input.requestHash,
		})?.opId ?? input.opId
	);
}

function findDynamicGeneratedTaskEvent(
	events: Awaited<ReturnType<typeof readDynamicEvents>>,
	input: {
		controllerSpecId: string;
		opId?: string;
		branchId?: string;
		requestHash: string;
	},
) {
	const identityMatches = events.filter(
		(event) =>
			event.controllerSpecId === input.controllerSpecId &&
			event.type === "task.generated" &&
			((input.opId !== undefined && event.opId === input.opId) ||
				(input.branchId !== undefined &&
					optionalEventString(event.payload.branchId) === input.branchId)),
	);
	const divergent = identityMatches.find(
		(event) => event.requestHash !== input.requestHash,
	);
	if (divergent) {
		const identity =
			input.opId !== undefined && divergent.opId === input.opId
				? `opId "${input.opId}"`
				: `branchId "${input.branchId ?? "(missing)"}"`;
		throw new Error(
			`dynamic agent request changed for ${identity}; previous hash ${divergent.requestHash}, new hash ${input.requestHash}`,
		);
	}
	return identityMatches
		.reverse()
		.find((event) => event.requestHash === input.requestHash);
}

async function priorDynamicOperationOpIds(input: {
	cwd: string;
	run: WorkflowRunRecord;
	controllerTask: WorkflowTaskRunRecord;
}): Promise<string[]> {
	const events = await readDynamicEvents(input.cwd, input.run.runId);
	return uniqueStrings(
		events
			.filter(
				(event) =>
					event.controllerSpecId === input.controllerTask.specId &&
					(event.type === "fanout.planned" ||
						event.type === "task.generated" ||
						event.type === "decision.persisted" ||
						event.type === "state-index.persisted" ||
						(event.type === "controller.status" &&
							event.opId.includes(":decision-loop-status:")) ||
						event.type === "result.read" ||
						event.type === "helper.started" ||
						event.type === "helper.completed" ||
						event.type === "workflow.started" ||
						event.type === "workflow.completed"),
			)
			.map((event) => event.opId),
	);
}

function assertDynamicReplayPrefix(
	replayPrefix: { opIds: string[]; cursor: number },
	opId: string,
): void {
	const priorIndex = replayPrefix.opIds.indexOf(opId);
	if (priorIndex >= 0) {
		if (priorIndex !== replayPrefix.cursor) {
			throw new Error(
				`dynamic controller replayed operation out of order: expected ${replayPrefix.opIds[replayPrefix.cursor] ?? "a new operation"} before ${opId}`,
			);
		}
		replayPrefix.cursor += 1;
		return;
	}
	if (replayPrefix.cursor < replayPrefix.opIds.length) {
		throw new Error(
			`dynamic controller omitted previously recorded operation(s): ${replayPrefix.opIds.slice(replayPrefix.cursor).join(", ")}`,
		);
	}
}

async function assertPriorDynamicOpsReplayed(
	input: {
		cwd: string;
		run: WorkflowRunRecord;
		controllerTask: WorkflowTaskRunRecord;
	},
	replayedOpIds: Set<string>,
	replayPrefix: { opIds: string[]; cursor: number },
): Promise<void> {
	const required = await priorDynamicOperationOpIds(input);
	const omitted = required.filter((opId) => !replayedOpIds.has(opId));
	if (omitted.length > 0 || replayPrefix.cursor < replayPrefix.opIds.length) {
		const remaining =
			omitted.length > 0
				? omitted
				: replayPrefix.opIds.slice(replayPrefix.cursor);
		throw new Error(
			`dynamic controller omitted previously recorded operation(s): ${remaining.join(", ")}`,
		);
	}
	const state = await readOrRebuildDynamicState(input.cwd, input.run.runId);
	const controller = state.controllers[input.controllerTask.specId];
	for (const nestedRunId of controller?.waitingNestedWorkflowRunIds ?? []) {
		const nestedRun = await readRunRecord(input.cwd, nestedRunId).catch(
			() => undefined,
		);
		if (
			nestedRun &&
			(!isTerminalWorkflowStatus(nestedRun.status) ||
				isResumableDynamicApprovalBlockedRun(nestedRun))
		) {
			throw new DynamicControllerSuspended(
				`waiting for dynamic nested workflow ${nestedRunId} (${nestedRun.status})`,
			);
		}
	}
}

function isDynamicReplayInvariantError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return (
		/dynamic (agent|helper|workflow|nested workflow|approval) request changed/.test(
			error.message,
		) ||
		error.message.startsWith("dynamic decision persist request changed") ||
		error.message.startsWith("dynamic fanout plan request changed") ||
		error.message.startsWith("dynamic state index request changed") ||
		error.message.startsWith("dynamic decision-loop status request changed") ||
		error.message.startsWith("dynamic result read request changed") ||
		error.message.startsWith(
			"dynamic decision accepted artifact already exists with divergent hash",
		) ||
		error.message.startsWith(
			"dynamic state index artifact already exists with divergent digest",
		) ||
		error.message.startsWith(
			"dynamic controller omitted previously recorded operation",
		) ||
		error.message.startsWith(
			"dynamic controller replayed operation out of order",
		) ||
		/^dynamic helper .+ previously started but did not complete/.test(
			error.message,
		)
	);
}

function requiredDynamicString(
	value: unknown,
	field: string,
	api = "ctx.agent()",
): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${api} ${field} must be a non-empty string`);
	}
	return value.trim();
}

function requiredDynamicPositiveInteger(
	value: unknown,
	field: string,
	api: string,
): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new Error(`${api} ${field} must be a positive integer`);
	}
	return value;
}

async function currentDynamicBudgetRemaining(input: {
	cwd: string;
	run: WorkflowRunRecord;
	controllerTask: WorkflowTaskRunRecord;
	dynamic: CompiledDynamicWorkflowTask;
}): Promise<Record<string, number>> {
	const state = await readOrRebuildDynamicState(input.cwd, input.run.runId);
	const run = await readRunRecord(input.cwd, input.run.runId).catch(
		() => input.run,
	);
	return dynamicBudgetRemaining(
		input.dynamic,
		state.controllers[input.controllerTask.specId]?.counters,
		countRunningDynamicAgents(
			run,
			input.controllerTask.specId,
			state.controllers[input.controllerTask.specId]?.generatedTaskIds ?? [],
		),
	);
}

function countRunningDynamicAgents(
	run: WorkflowRunRecord,
	controllerSpecId: string,
	generatedTaskIds: readonly string[],
): number {
	const generated = new Set(generatedTaskIds);
	return run.tasks.filter(
		(task) =>
			task.status === "running" &&
			(task.dynamicGenerated?.controllerSpecId === controllerSpecId ||
				generated.has(task.specId)),
	).length;
}

async function appendDynamicControllerLog(
	cwd: string,
	runId: string,
	controllerSpecId: string,
	args: unknown[],
): Promise<void> {
	const dir = dynamicRunDir(cwd, runId);
	await mkdir(dir, { recursive: true });
	const line = JSON.stringify({
		timestamp: new Date().toISOString(),
		controllerSpecId,
		args,
	});
	await appendFile(join(dir, "controller.log"), `${line}\n`, "utf8");
}

function dynamicWorkerError(error: any): Error {
	const message =
		typeof error?.message === "string"
			? error.message
			: "dynamic controller failed";
	if (error?.name === "DynamicControllerSuspended") {
		return new DynamicControllerSuspended(message);
	}
	if (error?.name === "DynamicControllerBudgetBlocked") {
		return new DynamicControllerBudgetBlocked(message);
	}
	const next = new Error(message);
	next.name = typeof error?.name === "string" ? error.name : "Error";
	return next;
}

function serializeDynamicWorkerError(error: unknown): {
	name: string;
	message: string;
} {
	return {
		name: error instanceof Error ? error.name : "Error",
		message: error instanceof Error ? error.message : String(error),
	};
}

function dynamicBudgetRemaining(
	dynamic: CompiledDynamicWorkflowTask,
	counters:
		| {
				agents?: number;
				runningAgents?: number;
				graphMutations?: number;
				helperRuns?: number;
				nestedWorkflowDepth?: number;
				runtimeMs?: number;
		  }
		| undefined,
	runningAgents = counters?.runningAgents ?? 0,
): Record<string, number> {
	return {
		maxAgents: Math.max(0, dynamic.budget.maxAgents - (counters?.agents ?? 0)),
		maxConcurrency: Math.max(0, dynamic.budget.maxConcurrency - runningAgents),
		maxRuntimeMs: Math.max(
			0,
			remainingDynamicRuntimeMs(dynamic, counters?.runtimeMs ?? 0),
		),
		maxNestedWorkflowDepth: Math.max(
			0,
			dynamic.budget.maxNestedWorkflowDepth -
				(counters?.nestedWorkflowDepth ?? 0),
		),
		maxGraphMutations: Math.max(
			0,
			dynamic.budget.maxGraphMutations - (counters?.graphMutations ?? 0),
		),
		maxHelperRuns: Math.max(
			0,
			dynamic.budget.maxHelperRuns - (counters?.helperRuns ?? 0),
		),
	};
}

function remainingDynamicRuntimeMs(
	dynamic: CompiledDynamicWorkflowTask,
	consumedRuntimeMs: number,
): number {
	return Math.max(0, dynamic.budget.maxRuntimeMs - consumedRuntimeMs);
}

async function runDynamicHelperWorker(input: {
	ref: string;
	specPath: string;
	callInput: unknown;
	timeoutMs: number;
}): Promise<unknown> {
	const resolved = await resolveWorkflowHelperRef(input.ref, input.specPath);
	const worker = new Worker(DYNAMIC_HELPER_WORKER_SOURCE, {
		eval: true,
		workerData: {
			helperUrl: pathToFileURL(resolved.path).href,
			callInput: input.callInput,
		},
	});
	let settled = false;
	return await new Promise<unknown>((resolvePromise, rejectPromise) => {
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			worker.removeAllListeners();
			void worker.terminate().catch(() => undefined);
			callback();
		};
		const timer = setTimeout(
			() => {
				finish(() =>
					rejectPromise(
						new DynamicControllerBudgetBlocked(
							`dynamic helper runtime budget exhausted: timeoutMs=${input.timeoutMs}`,
						),
					),
				);
			},
			Math.max(1, input.timeoutMs),
		);
		worker.on("message", (message) => {
			if (message?.type === "done") finish(() => resolvePromise(message.value));
			else if (message?.type === "error") {
				finish(() => rejectPromise(dynamicWorkerError(message.error)));
			}
		});
		worker.on("error", (error) => finish(() => rejectPromise(error)));
		worker.on("exit", (code) => {
			if (!settled && code !== 0) {
				finish(() =>
					rejectPromise(
						new Error(`dynamic helper worker exited with code ${code}`),
					),
				);
			}
		});
	});
}

const DYNAMIC_HELPER_WORKER_SOURCE = String.raw`
(async () => {
const { parentPort, workerData } = await import("node:worker_threads");
function toJson(value) {
  const text = JSON.stringify(value);
  return text === undefined ? null : JSON.parse(text);
}
try {
  const imported = await import(workerData.helperUrl);
  if (typeof imported.default !== "function") {
    throw new Error("dynamic helper must default-export a function");
  }
  const value = await imported.default(workerData.callInput);
  parentPort.postMessage({ type: "done", value: toJson(value) });
} catch (error) {
  parentPort.postMessage({ type: "error", error: { name: error && error.name ? error.name : "Error", message: error && error.message ? error.message : String(error) } });
}
})();
`;

const DYNAMIC_CONTROLLER_WORKER_SOURCE = String.raw`
(async () => {
const { parentPort, workerData } = await import("node:worker_threads");
const ENGINE_INTEGRITY_ERROR_MESSAGE = ${JSON.stringify(DYNAMIC_CONTROLLER_ENGINE_INTEGRITY_ERROR_MESSAGE)};
let nextOpId = 1;
const pending = new Map();
let generatedTaskIds = [...(workerData.generatedTaskIds || [])];
let budgetRemaining = { ...(workerData.budgetRemaining || {}) };
function toJson(value) {
  const text = JSON.stringify(value);
  return text === undefined ? null : JSON.parse(text);
}
function safeLogValue(value) {
  try {
    return toJson(value);
  } catch {
    return String(value);
  }
}
function budgetCheck() {
  return Object.values(budgetRemaining).every((value) => typeof value !== "number" || value > 0);
}
function call(op, payload) {
  const id = nextOpId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ type: "op", id, op, ...payload });
  });
}
function inflateError(error) {
  const next = new Error(error && error.message ? error.message : "dynamic operation failed");
  next.name = error && error.name ? error.name : "Error";
  return next;
}
parentPort.on("message", (message) => {
  if (!message || message.type !== "opResult") return;
  const pendingOp = pending.get(message.id);
  if (!pendingOp) return;
  pending.delete(message.id);
  if (Array.isArray(message.generatedTaskIds)) generatedTaskIds = message.generatedTaskIds;
  if (message.budgetRemaining) budgetRemaining = message.budgetRemaining;
  if (message.error) pendingOp.reject(inflateError(message.error));
  else pendingOp.resolve(message.value);
});
(async () => {
  const imported = await import(workerData.controllerUrl);
  if (typeof imported.default !== "function") {
    throw new Error("dynamic controller must default-export a function");
  }
  let decisionLoopModule;
  async function runInjectedDecisionLoop(ctx, options) {
    decisionLoopModule = decisionLoopModule || await import(workerData.decisionLoopModuleUrl);
    const runDynamicDecisionLoop = decisionLoopModule && decisionLoopModule.runDynamicDecisionLoop;
    if (typeof runDynamicDecisionLoop !== "function") {
      throw new Error("dynamic decision-loop module must export runDynamicDecisionLoop");
    }
    return await runDynamicDecisionLoop(ctx, options || {});
  }
  const helperCallCounts = new Map();
  const workflowCallCounts = new Map();
  let decisionCallCount = 0;
  let fanoutPlanCallCount = 0;
  let stateIndexCallCount = 0;
  let decisionLoopStatusCallCount = 0;
  let resultReadCount = 0;
  const dynamicConfig = Object.freeze(toJson(workerData.decisionLoop || null));
  const engineCapabilities = workerData.engineCapabilities || {};
  const supportsDecisionLoop = engineCapabilities.decisionLoop === true;
  const ctx = {
    task: workerData.task || "",
    sources: workerData.sources || {},
    phase(name) {
      if (typeof name === "string" && name.trim()) {
        parentPort.postMessage({ type: "op", id: nextOpId++, op: "phase", name });
      }
    },
    log(...args) {
      parentPort.postMessage({ type: "log", args: args.map(safeLogValue) });
    },
    artifact(name, options) {
      return { kind: "workflow-artifact-ref", name, ...(options ? { options } : {}) };
    },
    graph: {
      generatedTaskIds: () => [...generatedTaskIds],
      generatedBranchTaskIds: () => [...(workerData.generatedBranchTaskIds || [])],
      generatedTaskSpecId: (taskId) => workerData.controllerStageId + "." + taskId,
    },
    budget: { remaining: () => ({ ...budgetRemaining }), check: budgetCheck },
    tools: { available: () => toJson(workerData.availableTools || []) },
    dynamic: {
      config: () => dynamicConfig,
      ...(supportsDecisionLoop ? {
        async runDecisionLoop(options) {
          const generatedAtLoopStart = new Set(workerData.generatedTaskIds || []);
          const loopInitialGeneratedTaskIds = generatedTaskIds.filter((id) => !generatedAtLoopStart.has(id));
          const loopCtx = {
            ...ctx,
            graph: {
              ...ctx.graph,
              generatedTaskIds: () => [...loopInitialGeneratedTaskIds],
              generatedBranchTaskIds: () => [],
            },
          };
          return await runInjectedDecisionLoop(loopCtx, options);
        },
      } : {}),
      async recordDecisionLoopStatus(status) {
        decisionLoopStatusCallCount += 1;
        return await call("controllerStatus", { callIndex: decisionLoopStatusCallCount, request: status });
      },
    },
    decision: {
      async validateAndPersist(rawDecision, context) {
        decisionCallCount += 1;
        return await call("decision", { callIndex: decisionCallCount, rawDecision, context });
      },
    },
    stateIndex: {
      async extractAndPersist(request) {
        stateIndexCallCount += 1;
        return await call("stateIndex", { callIndex: stateIndexCallCount, request });
      },
    },
    fanout: {
      async plan(request) {
        fanoutPlanCallCount += 1;
        return await call("fanoutPlan", { callIndex: fanoutPlanCallCount, request });
      },
    },
    async result(request) {
      resultReadCount += 1;
      return await call("result", { callIndex: resultReadCount, request });
    },
    async helper(name, input) {
      const count = (helperCallCounts.get(name) || 0) + 1;
      helperCallCounts.set(name, count);
      return await call("helper", { name, callIndex: count, input });
    },
    async workflow(name, input) {
      const count = (workflowCallCounts.get(name) || 0) + 1;
      workflowCallCounts.set(name, count);
      return await call("workflow", { name, callIndex: count, input });
    },
    async agent(request) {
      return await call("agent", { request });
    },
    async parallel(thunks) {
      const settled = await Promise.allSettled(thunks.map(async (thunk) => thunk()));
      const failures = settled.filter((result) => result.status === "rejected" && (!result.reason || result.reason.name !== "DynamicControllerSuspended"));
      if (failures.length > 0) {
        throw new AggregateError(failures.map((result) => result.reason), "ctx.parallel dynamic operation failed");
      }
      const suspended = settled.find((result) => result.status === "rejected" && result.reason && result.reason.name === "DynamicControllerSuspended");
      if (suspended) throw suspended.reason;
      return settled;
    },
  };
  if (typeof ctx.dynamic.runDecisionLoop !== "function") {
    throw new Error(ENGINE_INTEGRITY_ERROR_MESSAGE);
  }
  const value = await imported.default(ctx);
  parentPort.postMessage({ type: "done", value: toJson(value) });
})().catch((error) => {
  parentPort.postMessage({ type: "error", error: { name: error && error.name ? error.name : "Error", message: error && error.message ? error.message : String(error) } });
});
})();
`;

async function assertDynamicGeneratedTasksSettled(input: {
	cwd: string;
	run: WorkflowRunRecord;
	compiledFlow: CompiledWorkflow;
	controllerIndex: number;
	controllerTask: WorkflowTaskRunRecord;
	controllerCompiledTask: CompiledTask;
	dynamic: CompiledDynamicWorkflowTask;
	availableModels?: WorkflowModelInfo[];
}): Promise<void> {
	const state = await readOrRebuildDynamicState(input.cwd, input.run.runId);
	const generatedTaskIds =
		state.controllers[input.controllerTask.specId]?.generatedTaskIds ?? [];
	for (const specId of generatedTaskIds) {
		let generated = input.run.tasks.find((task) => task.specId === specId);
		if (!generated) {
			generated = await repairMissingDynamicGeneratedTask(input, specId);
		}
		if (!isTerminalTaskStatus(generated.status)) {
			throw new DynamicControllerSuspended(
				`waiting for dynamic generated task ${specId} (${generated.status})`,
			);
		}
	}
}

async function repairMissingDynamicGeneratedTask(
	input: {
		cwd: string;
		run: WorkflowRunRecord;
		compiledFlow: CompiledWorkflow;
		controllerIndex: number;
		controllerTask: WorkflowTaskRunRecord;
		controllerCompiledTask: CompiledTask;
		dynamic: CompiledDynamicWorkflowTask;
		availableModels?: WorkflowModelInfo[];
	},
	specId: string,
): Promise<WorkflowTaskRunRecord> {
	const event = (await readDynamicEvents(input.cwd, input.run.runId)).find(
		(candidate) =>
			candidate.controllerSpecId === input.controllerTask.specId &&
			candidate.type === "task.generated" &&
			optionalEventString(candidate.payload.taskId) === specId,
	);
	if (!event) {
		throw new Error(
			`dynamic generated task ${specId} is missing from run graph and no task.generated event can repair it`,
		);
	}
	const request = normalizeDynamicAgentRequest(event.payload.request);
	let compiledTask = input.compiledFlow.tasks.find(
		(task) => task.id === specId,
	);
	compiledTask ??= isDynamicCompiledTaskPayload(event.payload.compiledTask)
		? event.payload.compiledTask
		: await buildDynamicGeneratedCompiledTask({
				cwd: input.cwd,
				run: input.run,
				compiledFlow: input.compiledFlow,
				controllerCompiledTask: input.controllerCompiledTask,
				controllerSpecId: input.controllerTask.specId,
				controllerStageId:
					input.controllerTask.stageId ??
					input.controllerCompiledTask.stageId ??
					input.controllerCompiledTask.id,
				generatedSpecId: specId,
				opId: event.opId,
				requestHash: event.requestHash ?? hashDynamicRequest(request),
				branchId: optionalEventString(event.payload.branchId),
				request,
				dynamic: input.dynamic,
				availableModels: input.availableModels,
			});
	assertDynamicGeneratedMetadataMatches(compiledTask, {
		controllerSpecId: input.controllerTask.specId,
		opId: event.opId,
		requestHash: event.requestHash ?? hashDynamicRequest(request),
		requestId: request.id,
		branchId: optionalEventString(event.payload.branchId),
	});
	const existingCompiledIndex = input.compiledFlow.tasks.findIndex(
		(task) => task.id === specId,
	);
	const insertAt =
		existingCompiledIndex >= 0
			? existingCompiledIndex
			: dynamicGeneratedInsertIndex(
					input.compiledFlow,
					input.controllerIndex,
					input.controllerTask.specId,
				);
	if (existingCompiledIndex < 0) {
		input.compiledFlow.tasks.splice(insertAt, 0, compiledTask);
	}
	const runTask = createTaskRunRecord(
		input.cwd,
		input.run.runId,
		compiledTask,
		nextTaskRecordIndex(input.run),
	);
	input.run.tasks.splice(insertAt, 0, runTask);
	await writeCompiledRunArtifact(
		input.cwd,
		input.run.runId,
		input.compiledFlow,
	);
	await writeRunRecord(input.cwd, input.run);
	return runTask;
}

async function runDynamicAgentRequest(input: {
	cwd: string;
	run: WorkflowRunRecord;
	compiledFlow: CompiledWorkflow;
	controllerIndex: number;
	controllerTask: WorkflowTaskRunRecord;
	controllerCompiledTask: CompiledTask;
	dynamic: CompiledDynamicWorkflowTask;
	request: unknown;
	generatedTaskIds: string[];
	isSettled?: () => boolean;
	availableModels?: WorkflowModelInfo[];
}): Promise<unknown> {
	await assertDynamicRuntimeBudgetAvailable({
		cwd: input.cwd,
		runId: input.run.runId,
		controllerSpecId: input.controllerTask.specId,
		dynamic: input.dynamic,
	});
	const request = normalizeDynamicAgentRequest(input.request);
	const controllerStageId =
		input.controllerTask.stageId ??
		input.controllerTask.specId.replace(/\.controller$/, "");
	let generatedSpecId = `${controllerStageId}.${request.id}`;
	const opId = `${input.controllerTask.specId}:agent:${request.id}`;
	const requestHash = hashDynamicRequest(request);
	const branchId = request.branchId;
	const events = await readDynamicEvents(input.cwd, input.run.runId);
	const previousByOpId = events.filter(
		(event) => event.opId === opId && event.type === "task.generated",
	);
	const divergent = previousByOpId.find(
		(event) => event.requestHash !== requestHash,
	);
	if (divergent) {
		throw new Error(
			`dynamic agent request changed for id "${request.id}"; previous hash ${divergent.requestHash}, new hash ${requestHash}`,
		);
	}
	const previousGenerated = findDynamicGeneratedTaskEvent(events, {
		controllerSpecId: input.controllerTask.specId,
		opId,
		branchId,
		requestHash,
	});
	const previousGeneratedSpecId = optionalEventString(
		previousGenerated?.payload.taskId,
	);
	if (previousGeneratedSpecId) generatedSpecId = previousGeneratedSpecId;
	const generationOpId = previousGenerated?.opId ?? opId;
	const generationRequestHash = previousGenerated?.requestHash ?? requestHash;
	const generationBranchId =
		optionalEventString(previousGenerated?.payload.branchId) ?? branchId;
	const generationRequest = previousGenerated?.payload.request
		? normalizeDynamicAgentRequest(previousGenerated.payload.request)
		: request;
	let compiledTask = input.compiledFlow.tasks.find(
		(task) => task.id === generatedSpecId,
	);
	let runTask = input.run.tasks.find((task) => task.specId === generatedSpecId);
	if (!previousGenerated && (compiledTask || runTask)) {
		throw new Error(`dynamic generated task id collision: ${generatedSpecId}`);
	}
	if (compiledTask) {
		assertDynamicGeneratedMetadataMatches(compiledTask, {
			controllerSpecId: input.controllerTask.specId,
			opId: generationOpId,
			requestHash: generationRequestHash,
			requestId: generationRequest.id,
			branchId: generationBranchId,
		});
	}
	if (!compiledTask || !runTask) {
		if (!previousGenerated) {
			await assertDynamicGenerationBudgetAvailable({
				cwd: input.cwd,
				runId: input.run.runId,
				controllerSpecId: input.controllerTask.specId,
				dynamic: input.dynamic,
			});
		}
		const recordedCompiledTask = previousGenerated?.payload.compiledTask;
		compiledTask ??= isDynamicCompiledTaskPayload(recordedCompiledTask)
			? recordedCompiledTask
			: await buildDynamicGeneratedCompiledTask({
					cwd: input.cwd,
					run: input.run,
					compiledFlow: input.compiledFlow,
					controllerCompiledTask: input.controllerCompiledTask,
					controllerSpecId: input.controllerTask.specId,
					controllerStageId,
					generatedSpecId,
					opId: generationOpId,
					requestHash: generationRequestHash,
					branchId: generationBranchId,
					request: generationRequest,
					dynamic: input.dynamic,
					availableModels: input.availableModels,
				});
		assertDynamicGeneratedMetadataMatches(compiledTask, {
			controllerSpecId: input.controllerTask.specId,
			opId: generationOpId,
			requestHash: generationRequestHash,
			requestId: generationRequest.id,
			branchId: generationBranchId,
		});
		if (input.isSettled?.()) return undefined;
		if (!previousGenerated) {
			await recordDynamicEventAndUpdateState(input.cwd, input.run.runId, {
				controllerSpecId: input.controllerTask.specId,
				type: "task.generated",
				opId,
				requestHash,
				payload: {
					taskId: generatedSpecId,
					...(branchId ? { branchId } : {}),
					request,
					compiledTask,
				},
			});
		}
		const existingRunIndex = runTask ? input.run.tasks.indexOf(runTask) : -1;
		const existingCompiledIndex =
			input.compiledFlow.tasks.indexOf(compiledTask);
		const insertAt =
			existingRunIndex >= 0
				? existingRunIndex
				: existingCompiledIndex >= 0
					? existingCompiledIndex
					: dynamicGeneratedInsertIndex(
							input.compiledFlow,
							input.controllerIndex,
							input.controllerTask.specId,
						);
		if (!input.compiledFlow.tasks.includes(compiledTask)) {
			input.compiledFlow.tasks.splice(insertAt, 0, compiledTask);
		}
		if (!runTask) {
			runTask = createTaskRunRecord(
				input.cwd,
				input.run.runId,
				compiledTask,
				nextTaskRecordIndex(input.run),
			);
			input.run.tasks.splice(insertAt, 0, runTask);
		}
		if (!input.generatedTaskIds.includes(generatedSpecId)) {
			input.generatedTaskIds.push(generatedSpecId);
		}
		await writeCompiledRunArtifact(
			input.cwd,
			input.run.runId,
			input.compiledFlow,
		);
		await writeRunRecord(input.cwd, input.run);
	}

	if (runTask.status === "completed") {
		return await readDynamicGeneratedTaskResult(input.cwd, runTask);
	}
	if (isTerminalTaskStatus(runTask.status)) {
		throw new Error(
			`dynamic generated task ${generatedSpecId} ended with ${runTask.status}: ${runTask.lastMessage ?? runTask.statusDetail}`,
		);
	}
	throw new DynamicControllerSuspended(
		`waiting for dynamic generated task ${generatedSpecId} (${runTask.status})`,
	);
}

interface DynamicControllerOutcome {
	taskStatus: "completed" | "blocked" | "failed";
	statusDetail: string;
	message: string;
	lifecycleStatus: "completed" | "failed";
	controllerStatus: DynamicControllerStatus;
	blockers: string[];
	omissions: string[];
}

async function dynamicUnrunBranchBlockers(
	cwd: string,
	runId: string,
	controllerSpecId: string,
): Promise<string[]> {
	const state = await readOrRebuildDynamicState(cwd, runId);
	const branches = state.controllers[controllerSpecId]?.branches ?? [];
	return branches
		.filter((branch) => branch.status === "planned")
		.map((branch) => {
			const details = [
				`branchId=${branch.branchId}`,
				`actionId=${branch.actionId}`,
				`type=${branch.type}`,
			]
				.filter(Boolean)
				.join(" ");
			return `accepted dynamic branch was planned but never generated: ${details}`;
		});
}

function dynamicControllerOutputWithBranchBlockers(
	structuredOutput: unknown,
	blockers: string[],
): { control: Record<string, unknown>; analysis: string; refs: unknown[] } {
	const normalized = normalizeDynamicControllerOutput(structuredOutput);
	return {
		...normalized,
		control: {
			...normalized.control,
			status: "blocked",
			blockers: uniqueStrings([
				...dynamicControlStringArray(normalized.control.blockers),
				...blockers,
			]),
		},
	};
}

function dynamicControllerOutcomeFromOutput(
	structuredOutput: unknown,
): DynamicControllerOutcome {
	const { control } = normalizeDynamicControllerOutput(structuredOutput);
	const status =
		typeof control.status === "string" ? control.status : undefined;
	const blockers = dynamicControlStringArray(control.blockers);
	const omissions = dynamicControlStringArray(control.omissions);

	if (status === "blocked" || (blockers.length > 0 && status !== "stopped")) {
		return {
			taskStatus: "blocked",
			statusDetail: "dynamic_blocked",
			message: dynamicControllerIssueMessage(
				"dynamic controller blocked",
				blockers.length > 0 ? blockers : omissions,
			),
			lifecycleStatus: "failed",
			controllerStatus: "blocked",
			blockers,
			omissions,
		};
	}

	if (omissions.length > 0) {
		return {
			taskStatus: "failed",
			statusDetail: "dynamic_dropped",
			message: dynamicControllerIssueMessage(
				"dynamic controller dropped work",
				omissions,
			),
			lifecycleStatus: "failed",
			controllerStatus: "failed",
			blockers,
			omissions,
		};
	}

	if (status === "stopped") {
		return {
			taskStatus: "completed",
			statusDetail: "dynamic_stopped",
			message:
				blockers.length > 0
					? dynamicControllerIssueMessage(
							"dynamic controller stopped",
							blockers,
						)
					: "dynamic controller stopped",
			lifecycleStatus: "completed",
			controllerStatus: "complete",
			blockers,
			omissions,
		};
	}

	return {
		taskStatus: "completed",
		statusDetail: "dynamic_completed",
		message:
			status === "exhausted"
				? "dynamic controller exhausted decision rounds"
				: "dynamic controller completed",
		lifecycleStatus: "completed",
		controllerStatus: "complete",
		blockers,
		omissions,
	};
}

function dynamicControlStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value
				.filter((item): item is string => typeof item === "string")
				.map((item) => item.trim())
				.filter((item) => item.length > 0)
		: [];
}

function dynamicControllerIssueMessage(
	prefix: string,
	issues: string[],
): string {
	const [first, ...rest] = issues;
	if (!first) return prefix;
	const suffix = rest.length > 0 ? ` (+${rest.length} more)` : "";
	return `${prefix}: ${first}${suffix}`;
}

function applyExistingLoopWorktree(
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	compiledTask: CompiledTask,
): CompiledTask {
	const loopId = compiledTask.loopChild?.loopId;
	if (!loopId) return compiledTask;
	const existing = run.loopWorktrees?.find((item) => item.loopId === loopId);
	if (!existing?.path) return compiledTask;

	task.cwd = existing.path;
	task.worktree = {
		enabled: true,
		path: existing.path,
		branch: existing.branch,
		baseCwd: existing.baseCwd,
		warning: "reused loop managed worktree",
	};
	return {
		...compiledTask,
		cwd: existing.path,
		safety: {
			...compiledTask.safety,
			requiresWorktree: false,
		},
	};
}

function recordCreatedLoopWorktree(
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	compiledTask: CompiledTask,
): void {
	const loopId = compiledTask.loopChild?.loopId;
	if (!loopId || !task.worktree.enabled || !task.worktree.path) return;
	run.loopWorktrees ??= [];
	const record = {
		loopId,
		path: task.worktree.path,
		branch: task.worktree.branch,
		baseCwd: task.worktree.baseCwd,
	};
	const index = run.loopWorktrees.findIndex((item) => item.loopId === loopId);
	if (index === -1) run.loopWorktrees.push(record);
	else run.loopWorktrees[index] = record;
}

function uniqueStrings(values: readonly string[]): string[] {
	return [...new Set(values.filter((value) => value.trim().length > 0))];
}

async function readCompiledWorkflow(
	cwd: string,
	runId: string,
): Promise<CompiledWorkflow | undefined> {
	return readJson<CompiledWorkflow>(compiledWorkflowPath(cwd, runId));
}

function formatIndex(index: WorkflowIndexRecord): string {
	return index.runs
		.map((run) => {
			const lines = [
				`${run.runId} [${run.status}] type=${run.type} updated=${run.updatedAt}`,
				`tasks=${run.taskSummary.completed}/${run.taskSummary.total} completed, running=${run.taskSummary.running}, pending=${run.taskSummary.pending}, blocked=${run.taskSummary.blocked}, failed=${run.taskSummary.failed}, skipped=${run.taskSummary.skipped}, interrupted=${run.taskSummary.interrupted}`,
			];
			for (const task of run.tasks) {
				const message = task.lastMessage ? ` — ${task.lastMessage}` : "";
				const kind = task.kind && task.kind !== "main" ? ` ${task.kind}` : "";
				lines.push(
					`- ${task.taskId}${kind} ${task.agent} [${task.status}/${task.statusDetail}]${message}`,
				);
			}
			return lines.join("\n");
		})
		.join("\n\n");
}

function formatTask(
	task: WorkflowTaskRunRecord,
	detail: "summary" | "full",
): string {
	const elapsed =
		task.elapsedMs !== undefined
			? ` elapsed=${Math.round(task.elapsedMs / 1000)}s`
			: "";
	const pid = task.pid ? ` pid=${task.pid}` : "";
	const runtime =
		task.kind === "support"
			? "runtime=local-support"
			: `model=${task.runtime.model ?? "(not recorded)"} thinking=${task.runtime.thinking ?? "(not recorded)"}`;
	const message = task.lastMessage ? `\n  last=${task.lastMessage}` : "";
	const worktree = task.worktree.enabled
		? `\n  worktree=${task.worktree.path}`
		: "";
	const deps =
		task.dependsOn && task.dependsOn.length > 0
			? `\n  dependsOn=${task.dependsOn.join(",")}`
			: "";
	const tools =
		task.kind === "support"
			? "(support helper; not subagent tools)"
			: (task.tools?.join(",") ?? "(Pi default)");
	const full =
		detail === "full"
			? `\n  agentFile=${task.agentFile}\n  cwd=${task.cwd}${worktree}${deps}\n  tools=${tools}\n  output=${task.files.output}\n  stderr=${task.files.stderr}\n  result=${task.files.result}`
			: ` output=${task.files.output}`;

	const kind = task.kind && task.kind !== "main" ? ` kind=${task.kind}` : "";
	return `- ${task.taskId}${kind} spec=${task.specId} agent=${task.agent} [${task.status}/${task.statusDetail}]${elapsed}${pid} ${runtime}${full}${message}`;
}

function clampTimeout(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value))
		return DEFAULT_WAIT_TIMEOUT_MS;
	return Math.max(
		POLL_INTERVAL_MS,
		Math.min(MAX_WAIT_TIMEOUT_MS, Math.floor(value)),
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runWorkflow(
	specPath: string,
	cwd: string,
	options: WorkflowRunOptions = {},
): Promise<WorkflowRunRecord> {
	if (!options.task || options.task.trim() === "")
		throw new Error("This workflow needs a task");
	return runWorkflowSpec(specPath, cwd, options);
}
