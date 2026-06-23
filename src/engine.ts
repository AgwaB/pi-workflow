import {
	appendFile,
	mkdir,
	readFile,
	readdir,
	stat,
	writeFile,
} from "node:fs/promises";
import {
	basename,
	dirname,
	extname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { loadAgentByName } from "./agents.js";
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
	makeRunId,
	readIndex,
	readJson,
	readRunRecord,
	resetTaskForResume,
	setTaskTerminal,
	supervisorPath,
	toProjectPath,
	updateIndex,
	withRunLease,
	workflowRunDir,
	writeJsonAtomic,
	writeRunRecord,
	writeCompiledRunArtifact,
	writeStaticRunArtifacts,
} from "./store.js";
import { resolveWorkflowBackend } from "./backend.js";
import { ensureManagedWorktree } from "./worktree.js";
import {
	loadWorkflowHelper,
	resolveWorkflowHelperRef,
} from "./workflow-helpers.js";
import {
	WORKFLOW_ARTIFACT_TOOL_NAME,
	writeWorkflowArtifactExtensionWrapper,
} from "./workflow-artifact-extension.js";
import {
	buildAvailableToolView,
	classifyToolCapability,
	effectiveToolClassification,
	providersForSelectedTools,
} from "./tool-metadata.js";
import {
	WORKFLOW_SOURCE_MANIFEST_SCHEMA,
	type WorkflowSourceManifest,
	type WorkflowSourceManifestSource,
} from "./workflow-artifact-tool.js";
import { writeWorkflowTaskArtifactBundle } from "./workflow-output-artifacts.js";
import { validateJsonSchema, type JsonSchema } from "./json-schema.js";
import {
	buildSourceContextPacket,
	summarizeWorkflowTelemetry,
	type SourceContextPacketOptions,
} from "./workflow-artifacts.js";
import { readSimpleJsonPath } from "./workflow-runtime.js";
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
	validateDynamicDecision,
	writeDynamicDecisionArtifacts,
} from "./dynamic-decision.js";
import {
	isDynamicOutputProfile,
	type DynamicOutputProfile,
} from "./dynamic-profiles.js";
import {
	DIRECT_DYNAMIC_RUNTIME_VERSION,
	ensureDirectDynamicRuntimeBundle,
} from "./dynamic-runtime-bundle.js";
import {
	assembleDynamicStateIndex,
	extractDynamicStateArtifact,
	writeDynamicStateIndexArtifacts,
} from "./dynamic-state-index.js";
import {
	type CompiledDynamicWorkflowTask,
	type CompiledTask,
	type CompiledToolProvider,
	type CompiledWorkflow,
	type LoopResultStatus,
	type LoopStateRecord,
	type LoopUntilCondition,
	type TaskCapability,
	type ThinkingLevel,
	WORKFLOW_RUN_TYPE,
	type WorkflowIndexRecord,
	type WorkflowRunRecord,
	type WorkflowTaskRunRecord,
} from "./types.js";

const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
const MAX_WAIT_TIMEOUT_MS = 14_400_000;
const POLL_INTERVAL_MS = 1_000;
const LOG_LINES_DEFAULT = 80;
const LOG_LINES_MAX = 400;
const MAX_CONCURRENCY = 16;
const LOOP_CARRY_FORWARD_MAX_CHARS = 4000;
const LOOP_SUMMARY_MAX_CHARS = 1200;
const SOURCE_CONTEXT_PREVIEW_CHARS = 1_200;
const SOURCE_CONTEXT_STRUCTURED_CHARS = 6_000;
const SOURCE_CONTEXT_MAX_PACKET_CHARS = 48_000;
const DYNAMIC_APPROVAL_TIMEOUT_MS = 5 * 60_000;
const DYNAMIC_CONTROLLER_ENGINE_CAPABILITIES = Object.freeze({
	decisionLoop: true,
});
const DYNAMIC_CONTROLLER_ENGINE_INTEGRITY_ERROR_MESSAGE =
	"incompatible or stale pi-workflow engine: dynamic controller context is missing runDecisionLoop (rebuild dist / reload workflow engine)";
const DYNAMIC_OUTPUT_MAX_DIGEST_CHARS = 1000;
const DYNAMIC_DELEGATION_TOOLS = new Set([
	"skill_test_subagent",
	"workflow",
	"/workflow",
]);
const supervisorTimers = new Map<string, ReturnType<typeof setInterval>>();

export interface DynamicWorkflowUi {
	hasUI?: boolean;
	confirm?: (
		title: string,
		message: string,
		options?: { timeout?: number; signal?: AbortSignal },
	) => boolean | Promise<boolean>;
}

export interface WorkflowRunOptions {
	task?: string;
	runtimeDefaults?: { model?: string; thinking?: ThinkingLevel };
	dynamicUi?: DynamicWorkflowUi;
	runId?: string;
	parentRunId?: string;
}

interface WorkflowScheduleOptions {
	dynamicUi?: DynamicWorkflowUi;
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
		runtimeDefaults: options.runtimeDefaults,
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

	const scheduled =
		(await scheduleRun(cwd, run.runId, compiled, {
			dynamicUi: options.dynamicUi,
		})) ?? (await readRunRecord(cwd, run.runId));
	if (scheduled.status === "running")
		watchRun(cwd, scheduled.runId, { dynamicUi: options.dynamicUi });
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

export async function waitForRun(
	cwd: string,
	runIdOrPrefix: string,
	timeoutMs?: number,
	options: WorkflowScheduleOptions = {},
): Promise<WorkflowRunRecord> {
	const timeout = clampTimeout(timeoutMs);
	const deadline = Date.now() + timeout;
	let run = await refreshRun(cwd, runIdOrPrefix);

	while (run.status === "running") {
		const beforeScheduleRemaining = deadline - Date.now();
		if (beforeScheduleRemaining <= 0)
			throw new Error(
				`Flow run still running after ${timeout}ms: ${run.runId}`,
			);
		await scheduleRun(cwd, run.runId, undefined, options);
		run = await refreshRun(cwd, run.runId);
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			if (run.status !== "running") return run;
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
	if (scheduled.status === "running") watchRun(cwd, scheduled.runId, options);
	return { run: scheduled, resetTaskIds };
}

export async function resumeSupervisors(
	cwd: string,
	options: WorkflowScheduleOptions = {},
): Promise<void> {
	try {
		const runs = await listRunRecords(cwd);
		for (const run of runs) {
			if (run.status === "running") {
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

export function watchRun(
	cwd: string,
	runId: string,
	options: WorkflowScheduleOptions = {},
): void {
	const key = `${cwd}\0${runId}`;
	if (supervisorTimers.has(key)) return;

	const timer = setInterval(() => {
		void (async () => {
			const refreshed = await refreshRun(cwd, runId);
			if (refreshed.status === "running") {
				await scheduleRun(cwd, runId, undefined, options);
				return;
			}

			const existing = supervisorTimers.get(key);
			if (existing) clearInterval(existing);
			supervisorTimers.delete(key);
		})().catch((error) => {
			void recordSupervisorError(cwd, runId, error);
		});
	}, POLL_INTERVAL_MS);

	timer.unref?.();
	supervisorTimers.set(key, timer);
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
		if (run.taskSummary.blocked > 0 || isTerminalWorkflowStatus(run.status))
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
		if (run.status === "running")
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
		if (run.status === "running")
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
		if (launched) running += 1;
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

async function scheduleLoop(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	placeholderIndex: number,
	placeholder: CompiledTask,
): Promise<boolean> {
	const loopId = placeholder.loopPlaceholder?.loopId ?? placeholder.stageId;
	if (!loopId) return false;
	const loopStage = findLoopStageRecord(compiledFlow, loopId);
	const placeholderRunTask = run.tasks[placeholderIndex];
	if (!loopStage || !placeholderRunTask) return false;

	const state = getLoopState(run, loopId);
	if (state?.awaitingOnExhausted) {
		const exhaustedTask = findLoopExhaustedRunTask(run, compiledFlow, loopId);
		if (exhaustedTask && !isTerminalTaskStatus(exhaustedTask.status))
			return false;
		await finalizeLoop(
			cwd,
			run,
			compiledFlow,
			placeholderRunTask,
			loopStage,
			state.status ?? "exhausted",
			state.round || latestLoopRound(compiledFlow, loopId),
		);
		return true;
	}

	const currentRound = latestLoopRound(compiledFlow, loopId);
	if (currentRound === 0) {
		await materializeLoopRound(
			cwd,
			run,
			compiledFlow,
			placeholderIndex,
			placeholder,
			loopStage,
			1,
		);
		return true;
	}

	const roundTasks = getLoopRoundRunTasks(
		run,
		compiledFlow,
		loopId,
		currentRound,
	);
	if (roundTasks.length === 0) return false;
	if (roundTasks.some((task) => !isTerminalTaskStatus(task.status)))
		return false;

	if (
		await evaluateLoopUntilCondition(
			cwd,
			run,
			compiledFlow,
			loopId,
			currentRound,
			loopStage.until,
		)
	) {
		await finalizeLoop(
			cwd,
			run,
			compiledFlow,
			placeholderRunTask,
			loopStage,
			"completed",
			currentRound,
		);
		return true;
	}

	if (currentRound >= loopStage.maxRounds) {
		await stopLoopOrRunOnExhausted(
			cwd,
			run,
			compiledFlow,
			placeholderRunTask,
			loopStage,
			"exhausted",
			currentRound,
		);
		return true;
	}

	if (
		await loopHasNoProgress(
			cwd,
			run,
			compiledFlow,
			loopStage,
			loopId,
			currentRound,
		)
	) {
		await stopLoopOrRunOnExhausted(
			cwd,
			run,
			compiledFlow,
			placeholderRunTask,
			loopStage,
			"stopped_no_progress",
			currentRound,
		);
		return true;
	}

	await materializeLoopRound(
		cwd,
		run,
		compiledFlow,
		placeholderIndex,
		placeholder,
		loopStage,
		currentRound + 1,
	);
	return true;
}

async function stopLoopOrRunOnExhausted(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	placeholderRunTask: WorkflowTaskRunRecord,
	loopStage: any,
	status: LoopResultStatus,
	round: number,
): Promise<void> {
	if (loopStage.onExhausted) {
		const exhaustedTask = findLoopExhaustedRunTask(
			run,
			compiledFlow,
			loopStage.id,
		);
		if (!exhaustedTask) {
			await materializeLoopOnExhausted(
				cwd,
				run,
				compiledFlow,
				loopStage,
				status,
				round,
			);
			return;
		}
		const state = ensureLoopState(run, loopStage.id);
		state.status = status;
		state.round = round;
		state.awaitingOnExhausted = true;
		state.onExhaustedSpecId = exhaustedTask.specId;
		state.updatedAt = new Date().toISOString();
		if (!isTerminalTaskStatus(exhaustedTask.status)) {
			await writeRunRecord(cwd, run);
			return;
		}
	}

	await finalizeLoop(
		cwd,
		run,
		compiledFlow,
		placeholderRunTask,
		loopStage,
		status,
		round,
	);
}

async function materializeLoopRound(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	placeholderIndex: number,
	placeholder: CompiledTask,
	loopStage: any,
	round: number,
): Promise<void> {
	const childTemplates = (loopStage.childTemplates ?? []) as CompiledTask[];
	const roundTag = `r${String(round).padStart(2, "0")}`;
	const countsByChildStage = new Map<string, number>();
	for (const template of childTemplates) {
		const childStageId =
			template.stageId ?? template.id.split(".")[0] ?? "child";
		countsByChildStage.set(
			childStageId,
			(countsByChildStage.get(childStageId) ?? 0) + 1,
		);
	}

	const localToRoundSpecId = new Map<string, string>();
	for (const template of childTemplates) {
		const childStageId =
			template.stageId ?? template.id.split(".")[0] ?? "child";
		const childTaskId = template.taskId ?? "main";
		const singleTaskChild = (countsByChildStage.get(childStageId) ?? 0) === 1;
		const specId =
			singleTaskChild && childTaskId === "main"
				? `${loopStage.id}.${roundTag}.${childStageId}`
				: `${loopStage.id}.${roundTag}.${childStageId}.${childTaskId}`;
		localToRoundSpecId.set(template.id, specId);
	}

	const entryDependsOn =
		round === 1
			? [...(placeholder.dependsOn ?? [])]
			: getLoopRoundRunTasks(run, compiledFlow, loopStage.id, round - 1).map(
					(task) => task.specId,
				);
	const firstChildStageId = loopStage.childStageIds?.[0];
	const carryForward =
		round > 1
			? await buildLoopCarryForwardContext(
					cwd,
					run,
					compiledFlow,
					loopStage,
					loopStage.id,
					round,
				)
			: "";
	const generatedTasks = childTemplates.map((template) => {
		const childStageId =
			template.stageId ?? template.id.split(".")[0] ?? "child";
		const childTaskId = template.taskId ?? "main";
		const roundStageId = `${loopStage.id}.${roundTag}.${childStageId}`;
		const rawDependsOn = template.dependsOn ?? [];
		const dependsOn =
			rawDependsOn.length > 0
				? rawDependsOn.map((dep) => localToRoundSpecId.get(dep) ?? dep)
				: [...entryDependsOn];
		const sourcePolicy =
			childStageId === firstChildStageId && round > 1
				? "partial"
				: loopChildSourcePolicy(loopStage, childStageId);
		ensureGeneratedStageRecord(
			compiledFlow,
			roundStageId,
			template.kind,
			sourcePolicy,
		);
		const loopRoundPrompt = [
			template.compiledPrompt,
			"# Loop Round",
			`loop=${loopStage.id}`,
			`round=${round}`,
			`childStage=${childStageId}`,
			carryForward && childStageId === firstChildStageId
				? `# Loop Carry-Forward Context\n\n${carryForward}`
				: undefined,
		]
			.filter(Boolean)
			.join("\n\n");
		const specId = localToRoundSpecId.get(template.id)!;
		return {
			...template,
			id: specId,
			key: specId,
			specId,
			taskId: childTaskId,
			stageId: roundStageId,
			dependsOn,
			foreach: undefined,
			compiledPrompt: loopRoundPrompt,
			loopChild: {
				loopId: loopStage.id,
				round,
				roundTag,
				childStageId,
				childTaskId,
				firstChildStage: childStageId === firstChildStageId,
			},
		} as CompiledTask;
	});

	upsertCompiledLoopTasksAtInsertion(
		compiledFlow,
		loopStage.id,
		placeholderIndex,
		generatedTasks,
	);
	reconcileLoopTaskRecordsInMemory(
		cwd,
		run,
		compiledFlow,
		new Set([loopStage.id]),
	);
	assertLoopTaskPositionalAlignment(run, compiledFlow, new Set([loopStage.id]));

	const state = ensureLoopState(run, loopStage.id);
	state.round = round;
	state.awaitingOnExhausted = false;
	state.status = undefined;
	state.onExhaustedSpecId = undefined;
	state.updatedAt = new Date().toISOString();
	run.round = round;

	await writeJsonAtomic(compiledWorkflowPath(cwd, run.runId), compiledFlow);
	await writeRunRecord(cwd, run);
}

async function materializeLoopOnExhausted(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	loopStage: any,
	status: LoopResultStatus,
	round: number,
): Promise<void> {
	const template = loopStage.onExhausted?.template as CompiledTask | undefined;
	if (!template) return;
	const stageId = `${loopStage.id}.onExhausted`;
	const specId = `${stageId}.${loopStage.onExhausted.stageId ?? "summary"}`;
	const dependsOn = getLoopRunTasksThroughRound(
		run,
		compiledFlow,
		loopStage.id,
		round,
	).map((task) => task.specId);
	const context = await buildLoopTerminalContext(
		cwd,
		run,
		compiledFlow,
		loopStage,
		status,
		round,
	);
	const task: CompiledTask = {
		...template,
		id: specId,
		key: specId,
		specId,
		taskId: loopStage.onExhausted.stageId ?? "summary",
		stageId,
		dependsOn,
		compiledPrompt: [
			template.compiledPrompt,
			"# Loop Exhaustion Context",
			context,
		].join("\n\n"),
		loopExhausted: { loopId: loopStage.id, status },
	} as CompiledTask;

	ensureGeneratedStageRecord(compiledFlow, stageId, "reduce", "partial");
	const placeholderIndex = compiledFlow.tasks.findIndex(
		(candidate) => candidate.loopPlaceholder?.loopId === loopStage.id,
	);
	upsertCompiledLoopTasksAtInsertion(
		compiledFlow,
		loopStage.id,
		placeholderIndex,
		[task],
	);
	reconcileLoopTaskRecordsInMemory(
		cwd,
		run,
		compiledFlow,
		new Set([loopStage.id]),
	);
	assertLoopTaskPositionalAlignment(run, compiledFlow, new Set([loopStage.id]));

	const state = ensureLoopState(run, loopStage.id);
	state.round = round;
	state.status = status;
	state.awaitingOnExhausted = true;
	state.onExhaustedSpecId = specId;
	state.updatedAt = new Date().toISOString();

	await writeJsonAtomic(compiledWorkflowPath(cwd, run.runId), compiledFlow);
	await writeRunRecord(cwd, run);
}

async function finalizeLoop(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	placeholderRunTask: WorkflowTaskRunRecord,
	loopStage: any,
	status: LoopResultStatus,
	round: number,
): Promise<void> {
	const finalCheck = await readLoopStageStructuredOutput(
		cwd,
		run,
		compiledFlow,
		loopStage.id,
		round,
		loopDesignatedCheckStageId(loopStage),
	);
	const worktreePath = findLoopWorktreePath(run, loopStage.id);
	const summary = buildLoopResultSummary(
		status,
		round,
		worktreePath,
		finalCheck,
	);
	upsertLoopResult(run, {
		loopId: loopStage.id,
		status,
		roundsUsed: round,
		worktreePath,
		finalCheck,
		summary,
	});
	const state = ensureLoopState(run, loopStage.id);
	state.round = round;
	state.status = status;
	state.awaitingOnExhausted = false;
	state.updatedAt = new Date().toISOString();
	setTaskTerminal(placeholderRunTask, "completed", `loop_${status}`, {
		lastMessage: summary,
	});
	await writeRunRecord(cwd, run);
}

export async function evaluateLoopUntilCondition(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	loopId: string,
	round: number,
	condition: LoopUntilCondition,
): Promise<boolean> {
	const candidate = condition as any;
	if (Array.isArray(candidate.all)) {
		for (const item of candidate.all) {
			if (
				!(await evaluateLoopUntilCondition(
					cwd,
					run,
					compiledFlow,
					loopId,
					round,
					item,
				))
			)
				return false;
		}
		return true;
	}
	if (Array.isArray(candidate.any)) {
		for (const item of candidate.any) {
			if (
				await evaluateLoopUntilCondition(
					cwd,
					run,
					compiledFlow,
					loopId,
					round,
					item,
				)
			)
				return true;
		}
		return false;
	}

	const stageId =
		typeof candidate.stage === "string"
			? candidate.stage
			: typeof candidate.source === "string"
				? candidate.source
				: undefined;
	if (stageId === undefined || typeof candidate.path !== "string") return false;
	const output = await readLoopStageStructuredOutput(
		cwd,
		run,
		compiledFlow,
		loopId,
		round,
		stageId,
	);
	const value =
		output === undefined
			? undefined
			: readSimpleJsonPath(output, candidate.path);
	if (Object.hasOwn(candidate, "exists")) {
		return candidate.exists === (value !== undefined);
	}
	if (value === undefined) return false;
	if (Object.hasOwn(candidate, "equals"))
		return Object.is(value, candidate.equals);
	if (Object.hasOwn(candidate, "notEquals"))
		return !Object.is(value, candidate.notEquals);
	if (Object.hasOwn(candidate, "lengthEquals"))
		return valueLength(value) === candidate.lengthEquals;
	return false;
}

async function loopHasNoProgress(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	loopStage: any,
	loopId: string,
	round: number,
): Promise<boolean> {
	if (round <= 1) return false;
	const current = await readLoopProgressMetric(
		cwd,
		run,
		compiledFlow,
		loopStage,
		loopId,
		round,
	);
	const previous = await readLoopProgressMetric(
		cwd,
		run,
		compiledFlow,
		loopStage,
		loopId,
		round - 1,
	);
	return current !== undefined && previous !== undefined && current >= previous;
}

async function readLoopProgressMetric(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	loopStage: any,
	loopId: string,
	round: number,
): Promise<number | undefined> {
	const checkStageId = loopDesignatedCheckStageId(loopStage);
	const output = await readLoopStageStructuredOutput(
		cwd,
		run,
		compiledFlow,
		loopId,
		round,
		checkStageId,
	);
	if (output === undefined) return undefined;
	const progressPath = loopStage.progressPath ?? "$.blockingFailures";
	const value = readSimpleJsonPath(output, progressPath);
	const length = valueLength(value);
	if (length !== undefined) return length;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (value !== undefined || loopStage.progressPath !== undefined) {
		warnInvalidLoopProgressMetric(
			run,
			compiledFlow,
			loopId,
			round,
			checkStageId,
			progressPath,
			value,
		);
	}
	return undefined;
}

function warnInvalidLoopProgressMetric(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	loopId: string,
	round: number,
	childStageId: string,
	progressPath: string,
	value: unknown,
): void {
	const entry = getLatestLoopStageTaskEntry(
		run,
		compiledFlow,
		loopId,
		round,
		childStageId,
	);
	if (!entry || entry.runTask.status !== "completed") return;
	entry.runTask.lastMessage = `loop progressPath ${progressPath} resolved to unsupported ${describeLoopProgressValue(value)}; no-progress comparison skipped`;
}

function getLatestLoopStageTaskEntry(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	loopId: string,
	round: number,
	childStageId: string,
): { compiledTask: CompiledTask; runTask: WorkflowTaskRunRecord } | undefined {
	return getLoopRoundTaskEntries(run, compiledFlow, loopId, round)
		.filter(
			(item) => item.compiledTask.loopChild?.childStageId === childStageId,
		)
		.at(-1);
}

function describeLoopProgressValue(value: unknown): string {
	if (value === undefined) return "undefined";
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (typeof value === "number" && !Number.isFinite(value))
		return "non-finite number";
	return typeof value;
}

async function readLoopStageStructuredOutput(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	loopId: string,
	round: number,
	childStageId: string,
): Promise<unknown> {
	const entry = getLatestLoopStageTaskEntry(
		run,
		compiledFlow,
		loopId,
		round,
		childStageId,
	);
	if (!entry || entry.runTask.status !== "completed") return undefined;
	try {
		if (entry.compiledTask.artifactGraph?.enabled) {
			return await readArtifactGraphControl(cwd, entry.runTask);
		}
		const result = JSON.parse(
			await readFile(fromProjectPath(cwd, entry.runTask.files.result), "utf8"),
		);
		return result?.structuredOutput;
	} catch (error) {
		entry.runTask.lastMessage = `completed loop task result unreadable: ${error instanceof Error ? error.message : String(error)}`;
		return undefined;
	}
}

async function buildLoopCarryForwardContext(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	loopStage: any,
	loopId: string,
	nextRound: number,
): Promise<string> {
	const previousRound = nextRound - 1;
	const checkStageId = loopDesignatedCheckStageId(loopStage);
	const latestCheck = await readLoopStageStructuredOutput(
		cwd,
		run,
		compiledFlow,
		loopId,
		previousRound,
		checkStageId,
	);
	const metric = await readLoopProgressMetric(
		cwd,
		run,
		compiledFlow,
		loopStage,
		loopId,
		previousRound,
	);
	const summary = [
		`Previous round: ${previousRound}`,
		`Designated check stage: ${checkStageId}`,
		metric !== undefined
			? `Progress metric (${loopStage.progressPath ?? "$.blockingFailures"} length/value): ${metric}`
			: undefined,
		"Latest check structured output:",
		compactJson(latestCheck, Math.floor(LOOP_CARRY_FORWARD_MAX_CHARS * 0.7)),
		"Rolling summary:",
		await buildLoopRollingSummary(
			cwd,
			run,
			compiledFlow,
			loopStage,
			loopId,
			previousRound,
		),
	]
		.filter(Boolean)
		.join("\n");
	return truncate(summary, LOOP_CARRY_FORWARD_MAX_CHARS);
}

async function buildLoopRollingSummary(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	loopStage: any,
	loopId: string,
	latestRound: number,
): Promise<string> {
	const start = Math.max(1, latestRound - 2);
	const lines: string[] = [];
	for (let round = start; round <= latestRound; round += 1) {
		const metric = await readLoopProgressMetric(
			cwd,
			run,
			compiledFlow,
			loopStage,
			loopId,
			round,
		);
		lines.push(
			`round ${round}: ${metric === undefined ? "progress metric unavailable" : `progress=${metric}`}`,
		);
	}
	return lines.join("\n");
}

async function buildLoopTerminalContext(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	loopStage: any,
	status: LoopResultStatus,
	round: number,
): Promise<string> {
	const checkStageId = loopDesignatedCheckStageId(loopStage);
	const finalCheck = await readLoopStageStructuredOutput(
		cwd,
		run,
		compiledFlow,
		loopStage.id,
		round,
		checkStageId,
	);
	const roundChecks = await buildLoopRoundCheckContext(
		cwd,
		run,
		compiledFlow,
		loopStage,
		loopStage.id,
		round,
		checkStageId,
	);
	return truncate(
		[
			`loop=${loopStage.id}`,
			`status=${status}`,
			`roundsUsed=${round}`,
			`worktreePath=${findLoopWorktreePath(run, loopStage.id) ?? "(none)"}`,
			"Round check outputs (bounded, most recent retained):",
			roundChecks,
			"Final check structured output:",
			compactJson(finalCheck, LOOP_SUMMARY_MAX_CHARS),
		].join("\n"),
		LOOP_CARRY_FORWARD_MAX_CHARS,
	);
}

async function buildLoopRoundCheckContext(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	loopStage: any,
	loopId: string,
	latestRound: number,
	checkStageId: string,
): Promise<string> {
	const sections: string[] = [];
	for (let round = latestRound; round >= 1; round -= 1) {
		const output = await readLoopStageStructuredOutput(
			cwd,
			run,
			compiledFlow,
			loopId,
			round,
			checkStageId,
		);
		const metric = await readLoopProgressMetric(
			cwd,
			run,
			compiledFlow,
			loopStage,
			loopId,
			round,
		);
		const section = [
			`Round ${round}`,
			metric !== undefined
				? `progress=${metric}`
				: "progress metric unavailable",
			compactJson(output, 900),
		].join("\n");
		const candidate = [section, ...sections].join("\n\n");
		if (candidate.length > LOOP_CARRY_FORWARD_MAX_CHARS && sections.length > 0)
			break;
		sections.unshift(section);
	}
	return truncate(
		sections.join("\n\n") || "(unavailable)",
		LOOP_CARRY_FORWARD_MAX_CHARS,
	);
}

function buildLoopResultSummary(
	status: LoopResultStatus,
	round: number,
	worktreePath: string | null,
	finalCheck: unknown,
): string {
	const statusText =
		status === "completed"
			? "Loop completed"
			: status === "exhausted"
				? "Loop exhausted before until condition passed"
				: "Loop stopped because the progress metric did not strictly decrease";
	return truncate(
		[
			`${statusText} after ${round} round${round === 1 ? "" : "s"}.`,
			`worktree=${worktreePath ?? "(none)"}`,
			`finalCheck=${compactJson(finalCheck, 700)}`,
		].join("\n"),
		LOOP_SUMMARY_MAX_CHARS,
	);
}

function findLoopStageRecord(
	compiledFlow: CompiledWorkflow,
	loopId: string,
): any | undefined {
	return ((compiledFlow as any).stages ?? []).find(
		(stage: any) => stage?.id === loopId && stage?.type === "loop",
	);
}

function latestLoopRound(
	compiledFlow: CompiledWorkflow,
	loopId: string,
): number {
	let latest = 0;
	for (const task of compiledFlow.tasks) {
		if (task.loopChild?.loopId === loopId)
			latest = Math.max(latest, task.loopChild.round);
	}
	return latest;
}

function getLoopRoundRunTasks(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	loopId: string,
	round: number,
): WorkflowTaskRunRecord[] {
	return getLoopRoundTaskEntries(run, compiledFlow, loopId, round).map(
		(entry) => entry.runTask,
	);
}

function getLoopRunTasksThroughRound(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	loopId: string,
	latestRound: number,
): WorkflowTaskRunRecord[] {
	const tasks: WorkflowTaskRunRecord[] = [];
	for (let round = 1; round <= latestRound; round += 1)
		tasks.push(...getLoopRoundRunTasks(run, compiledFlow, loopId, round));
	return tasks;
}

function getLoopRoundTaskEntries(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	loopId: string,
	round: number,
): Array<{
	runTask: WorkflowTaskRunRecord;
	compiledTask: CompiledTask;
	index: number;
}> {
	const entries: Array<{
		runTask: WorkflowTaskRunRecord;
		compiledTask: CompiledTask;
		index: number;
	}> = [];
	const runTaskBySpecId = new Map<
		string,
		{ task: WorkflowTaskRunRecord; index: number }
	>();
	for (const [index, task] of run.tasks.entries())
		runTaskBySpecId.set(task.specId, { task, index });
	for (const compiledTask of compiledFlow.tasks) {
		if (
			compiledTask.loopChild?.loopId !== loopId ||
			compiledTask.loopChild.round !== round
		)
			continue;
		const runEntry = runTaskBySpecId.get(compiledTaskSpecId(compiledTask));
		if (runEntry)
			entries.push({
				runTask: runEntry.task,
				compiledTask,
				index: runEntry.index,
			});
	}
	return entries;
}

async function reconcileLoopTaskMaterialization(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
): Promise<boolean> {
	const loopIds = loopStageIdSet(compiledFlow);
	if (loopIds.size === 0) return false;
	const changed = reconcileLoopTaskRecordsInMemory(
		cwd,
		run,
		compiledFlow,
		loopIds,
	);
	if (!changed) return false;
	assertLoopTaskPositionalAlignment(run, compiledFlow, loopIds);
	await writeRunRecord(cwd, run);
	return true;
}

function reconcileLoopTaskRecordsInMemory(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	loopIds: Set<string>,
): boolean {
	const compiledSpecIds = new Set(
		compiledFlow.tasks.map((task) => compiledTaskSpecId(task)),
	);
	const filteredRunTasks: WorkflowTaskRunRecord[] = [];
	const seenLoopSpecIds = new Set<string>();
	let changed = false;

	for (const task of run.tasks) {
		const loopGenerated = isLoopGeneratedRunTask(task, loopIds);
		if (loopGenerated && !compiledSpecIds.has(task.specId)) {
			changed = true;
			continue;
		}
		if (loopGenerated && seenLoopSpecIds.has(task.specId)) {
			changed = true;
			continue;
		}
		if (loopGenerated) seenLoopSpecIds.add(task.specId);
		filteredRunTasks.push(task);
	}

	const runTaskBySpecId = new Map<string, WorkflowTaskRunRecord>();
	for (const task of filteredRunTasks) {
		if (!runTaskBySpecId.has(task.specId))
			runTaskBySpecId.set(task.specId, task);
	}

	const reordered: WorkflowTaskRunRecord[] = [];
	const usedSpecIds = new Set<string>();
	let nextIndex = nextTaskRecordIndex({ ...run, tasks: filteredRunTasks });
	for (const compiledTask of compiledFlow.tasks) {
		const specId = compiledTaskSpecId(compiledTask);
		const existing = runTaskBySpecId.get(specId);
		if (existing) {
			reordered.push(existing);
			usedSpecIds.add(specId);
			continue;
		}
		if (!isLoopGeneratedCompiledTask(compiledTask, loopIds)) continue;
		const created = createTaskRunRecord(
			cwd,
			run.runId,
			compiledTask,
			nextIndex,
		);
		nextIndex += 1;
		reordered.push(created);
		usedSpecIds.add(specId);
		changed = true;
	}

	for (const task of filteredRunTasks) {
		if (!usedSpecIds.has(task.specId)) reordered.push(task);
	}

	if (!sameTaskRecordOrder(filteredRunTasks, reordered)) changed = true;
	if (changed) run.tasks = reordered;
	return changed;
}

function recoverStaleRunningDynamicControllers(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
): boolean {
	let changed = false;
	for (const [index, task] of run.tasks.entries()) {
		const compiledTask = compiledFlow.tasks[index];
		if (compiledTask?.kind !== "dynamic") continue;
		if (task.status !== "running") continue;
		task.status = "pending";
		task.statusDetail = "recovered_stale_dynamic_controller";
		task.lastMessage =
			"recovered stale in-process dynamic controller after scheduler restart";
		task.pid = undefined;
		task.backendHandle = undefined;
		changed = true;
	}
	return changed;
}

function reconcileDynamicGeneratedRunRecords(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
): boolean {
	let changed = false;
	for (const [index, compiledTask] of compiledFlow.tasks.entries()) {
		if (!compiledTask.dynamicGenerated) continue;
		const specId = compiledTaskSpecId(compiledTask);
		let runTask = run.tasks.find((task) => task.specId === specId);
		if (!runTask) {
			runTask = createTaskRunRecord(
				cwd,
				run.runId,
				compiledTask,
				nextTaskRecordIndex(run),
			);
			run.tasks.splice(index, 0, runTask);
			changed = true;
			continue;
		}
		const currentIndex = run.tasks.indexOf(runTask);
		if (currentIndex !== index) {
			run.tasks.splice(currentIndex, 1);
			run.tasks.splice(index, 0, runTask);
			changed = true;
		}
	}
	return changed;
}

function assertRunTaskPositionalAlignment(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
): void {
	const maxLength = Math.max(run.tasks.length, compiledFlow.tasks.length);
	for (let index = 0; index < maxLength; index += 1) {
		const runTask = run.tasks[index];
		const compiledTask = compiledFlow.tasks[index];
		if (!runTask && compiledTask) {
			throw new Error(
				`Workflow task materialization is misaligned at index ${index}: compiled task ${compiledTaskSpecId(compiledTask)} has no run record`,
			);
		}
		if (runTask && !compiledTask) {
			throw new Error(
				`Workflow task materialization is misaligned at index ${index}: run task ${runTask.specId} has no compiled task`,
			);
		}
		if (runTask && compiledTask) {
			const specId = compiledTaskSpecId(compiledTask);
			if (runTask.specId !== specId) {
				throw new Error(
					`Workflow task materialization is misaligned at index ${index}: expected ${specId}, found ${runTask.specId}`,
				);
			}
		}
	}
}

function assertLoopTaskPositionalAlignment(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	loopIds = loopStageIdSet(compiledFlow),
): void {
	for (const [index, compiledTask] of compiledFlow.tasks.entries()) {
		if (!isLoopGeneratedCompiledTask(compiledTask, loopIds)) continue;
		const runTask = run.tasks[index];
		const specId = compiledTaskSpecId(compiledTask);
		if (!runTask || runTask.specId !== specId) {
			throw new Error(
				`Loop task materialization is misaligned at index ${index}: expected ${specId}, found ${runTask?.specId ?? "(missing)"}`,
			);
		}
	}

	for (const [index, runTask] of run.tasks.entries()) {
		if (!isLoopGeneratedRunTask(runTask, loopIds)) continue;
		const compiledTask = compiledFlow.tasks[index];
		if (!compiledTask || compiledTaskSpecId(compiledTask) !== runTask.specId) {
			throw new Error(
				`Loop task materialization is misaligned at index ${index}: run task ${runTask.specId} has no matching compiled task`,
			);
		}
	}
}

function upsertCompiledLoopTasksAtInsertion(
	compiledFlow: CompiledWorkflow,
	loopId: string,
	placeholderIndex: number,
	tasks: CompiledTask[],
): void {
	const specIds = new Set(tasks.map((task) => compiledTaskSpecId(task)));
	compiledFlow.tasks = compiledFlow.tasks.filter(
		(task) => !specIds.has(compiledTaskSpecId(task)),
	);
	const currentPlaceholderIndex = compiledFlow.tasks.findIndex(
		(task) => task.loopPlaceholder?.loopId === loopId,
	);
	const insertionIndex = loopInsertionIndex(
		compiledFlow,
		loopId,
		currentPlaceholderIndex === -1 ? placeholderIndex : currentPlaceholderIndex,
	);
	compiledFlow.tasks.splice(insertionIndex, 0, ...tasks);
}

function compiledTaskSpecId(task: CompiledTask): string {
	const specId = (task as CompiledTask & { specId?: unknown }).specId;
	return typeof specId === "string" && specId.trim() !== "" ? specId : task.id;
}

function isLoopGeneratedCompiledTask(
	task: CompiledTask,
	loopIds: Set<string>,
): boolean {
	return Boolean(
		(task.loopChild?.loopId && loopIds.has(task.loopChild.loopId)) ||
			(task.loopExhausted?.loopId && loopIds.has(task.loopExhausted.loopId)),
	);
}

function isLoopGeneratedRunTask(
	task: WorkflowTaskRunRecord,
	loopIds: Set<string>,
): boolean {
	for (const loopId of loopIds) {
		if (task.specId.startsWith(`${loopId}.onExhausted.`)) return true;
		if (new RegExp(`^${escapeRegExp(loopId)}\\.r\\d{2}\\.`).test(task.specId))
			return true;
		if (task.stageId?.startsWith(`${loopId}.onExhausted`)) return true;
		if (
			new RegExp(`^${escapeRegExp(loopId)}\\.r\\d{2}\\.`).test(
				task.stageId ?? "",
			)
		)
			return true;
	}
	return false;
}

function loopStageIdSet(compiledFlow: CompiledWorkflow): Set<string> {
	const loopIds = new Set<string>();
	for (const stage of (compiledFlow as any).stages ?? []) {
		if (stage?.type === "loop" && typeof stage.id === "string")
			loopIds.add(stage.id);
	}
	for (const task of compiledFlow.tasks) {
		if (task.loopChild?.loopId) loopIds.add(task.loopChild.loopId);
		if (task.loopExhausted?.loopId) loopIds.add(task.loopExhausted.loopId);
	}
	return loopIds;
}

function sameTaskRecordOrder(
	left: WorkflowTaskRunRecord[],
	right: WorkflowTaskRunRecord[],
): boolean {
	return (
		left.length === right.length &&
		left.every((task, index) => task === right[index])
	);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function loopInsertionIndex(
	compiledFlow: CompiledWorkflow,
	loopId: string,
	placeholderIndex: number,
): number {
	let index = Math.max(0, placeholderIndex + 1);
	while (index < compiledFlow.tasks.length) {
		const task = compiledFlow.tasks[index];
		if (
			task?.loopChild?.loopId === loopId ||
			task?.loopExhausted?.loopId === loopId
		) {
			index += 1;
			continue;
		}
		break;
	}
	return index;
}

function loopChildSourcePolicy(loopStage: any, childStageId: string): string {
	const record = (loopStage.childStageRecords ?? []).find(
		(stage: any) => stage.id === childStageId,
	);
	return record?.sourcePolicy ?? "require-success";
}

function ensureGeneratedStageRecord(
	compiledFlow: CompiledWorkflow,
	id: string,
	type: string | undefined,
	sourcePolicy: string,
): void {
	const stages = ((compiledFlow as any).stages ??= []);
	const existing = stages.find((stage: any) => stage.id === id);
	if (existing) {
		existing.sourcePolicy = existing.sourcePolicy ?? sourcePolicy;
		return;
	}
	stages.push({ id, type: type ?? "single", sourcePolicy });
}

function getLoopState(
	run: WorkflowRunRecord,
	loopId: string,
): LoopStateRecord | undefined {
	return run.loopStates?.find((state) => state.loopId === loopId);
}

function ensureLoopState(
	run: WorkflowRunRecord,
	loopId: string,
): LoopStateRecord {
	run.loopStates ??= [];
	let state = getLoopState(run, loopId);
	if (!state) {
		state = { loopId, round: 0 };
		run.loopStates.push(state);
	}
	return state;
}

function findLoopExhaustedRunTask(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	loopId: string,
): WorkflowTaskRunRecord | undefined {
	const compiledTask = compiledFlow.tasks.find(
		(task) => task.loopExhausted?.loopId === loopId,
	);
	return compiledTask
		? run.tasks.find((task) => task.specId === compiledTaskSpecId(compiledTask))
		: undefined;
}

function loopDesignatedCheckStageId(loopStage: any): string {
	const refs = new Set<string>();
	collectUntilStageRefs(loopStage.until, refs);
	if (refs.size === 1) return [...refs][0]!;
	const childStageIds = loopStage.childStageIds ?? [];
	return childStageIds[childStageIds.length - 1] ?? "check";
}

function collectUntilStageRefs(condition: unknown, refs: Set<string>): void {
	if (!condition || typeof condition !== "object") return;
	const candidate = condition as any;
	if (typeof candidate.stage === "string") refs.add(candidate.stage);
	else if (typeof candidate.source === "string") refs.add(candidate.source);
	for (const item of candidate.all ?? []) collectUntilStageRefs(item, refs);
	for (const item of candidate.any ?? []) collectUntilStageRefs(item, refs);
}

function valueLength(value: unknown): number | undefined {
	if (Array.isArray(value) || typeof value === "string") return value.length;
	return undefined;
}

function upsertLoopResult(
	run: WorkflowRunRecord,
	result: NonNullable<WorkflowRunRecord["loopResults"]>[number],
): void {
	run.loopResults ??= [];
	const index = run.loopResults.findIndex(
		(item) => item.loopId === result.loopId,
	);
	if (index === -1) run.loopResults.push(result);
	else run.loopResults[index] = result;
}

function findLoopWorktreePath(
	run: WorkflowRunRecord,
	loopId: string,
): string | null {
	const recorded = run.loopWorktrees?.find(
		(item) => item.loopId === loopId,
	)?.path;
	if (recorded) return recorded;
	return (
		run.tasks.find(
			(task) =>
				task.specId.startsWith(`${loopId}.r`) &&
				task.worktree.enabled &&
				task.worktree.path,
		)?.worktree.path ?? null
	);
}

function compactJson(value: unknown, maxChars: number): string {
	if (value === undefined) return "(unavailable)";
	try {
		return truncate(JSON.stringify(value), maxChars);
	} catch {
		return truncate(String(value), maxChars);
	}
}

function truncate(value: string, maxChars: number): string {
	return value.length > maxChars
		? `${value.slice(0, Math.max(0, maxChars - 1))}…`
		: value;
}

function nextTaskRecordIndex(run: WorkflowRunRecord): number {
	let max = 0;
	for (const task of run.tasks) {
		const match = /^task-(\d+)$/.exec(task.taskId);
		if (match) max = Math.max(max, Number(match[1]));
	}
	return max;
}

function dependenciesReady(
	compiledTask: CompiledTask,
	bySpecId: Map<string, WorkflowTaskRunRecord>,
	compiledFlow: CompiledWorkflow,
): boolean {
	const deps = compiledTask.dependsOn ?? [];
	if (deps.length === 0) return true;
	const partial =
		stageSourcePolicy(compiledFlow, compiledTask.stageId ?? "") === "partial";
	return deps.every((dep) => {
		const status = bySpecId.get(dep)?.status;
		if (status === "completed") return true;
		if (partial && status && isTerminalTaskStatus(status)) return true;
		return false;
	});
}

function buildForeachGeneratedTasks(
	template: CompiledTask,
	runtimeTask: string | undefined,
	items: unknown[],
): { tasks: CompiledTask[]; error?: string } {
	const seen = new Set<string>();
	const tasks: CompiledTask[] = [];
	for (const [index, item] of items.entries()) {
		const taskId = foreachItemTaskId(item, index);
		if (seen.has(taskId))
			return {
				tasks: [],
				error: `duplicate foreach generated task id "${taskId}"`,
			};
		seen.add(taskId);
		const specId = `${template.stageId}.${taskId}`;
		const itemText = formatForeachItem(item);
		const instructions = template.foreach!.prompt.replace(
			/\$\{item\}/g,
			itemText,
		);
		const compiledPrompt = [
			template.foreach!.injectRuntimeTask && runtimeTask
				? `# Task\n\n${runtimeTask}`
				: undefined,
			`# Workflow Stage\n\nstage=${template.stageId}\ntype=foreach\nitem=${taskId}`,
			`# Instructions\n\n${instructions}`,
			template.foreach!.roleText || undefined,
		]
			.filter(Boolean)
			.join("\n\n");
		tasks.push({
			...template,
			id: specId,
			key: specId,
			specId,
			taskId,
			task: instructions,
			compiledPrompt,
			dependsOn: [...(template.dependsOn ?? [])],
			foreach: undefined,
		} as CompiledTask);
	}
	return { tasks };
}

function foreachItemTaskId(item: unknown, index: number): string {
	if (
		item &&
		typeof item === "object" &&
		typeof (item as any).id === "string"
	) {
		const sanitized = sanitizeTaskId((item as any).id);
		if (sanitized) return sanitized;
	}
	return `item-${String(index + 1).padStart(3, "0")}`;
}

function sanitizeTaskId(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_.-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

function formatForeachItem(item: unknown): string {
	return typeof item === "string" ? item : JSON.stringify(item);
}

function sourceStageIdsForFrom(from: unknown): string[] {
	if (Array.isArray(from))
		return from.filter((item): item is string => typeof item === "string");
	if (typeof from === "string") return [from];
	if (
		from &&
		typeof from === "object" &&
		typeof (from as any).stage === "string"
	)
		return [(from as any).stage];
	return [];
}

function stageSourcePolicy(
	compiledFlow: CompiledWorkflow,
	stageId: string,
): string {
	return (
		((compiledFlow as any).stages ?? []).find(
			(stage: any) => stage.id === stageId,
		)?.sourcePolicy ?? "require-success"
	);
}

function updateDownstreamDependencies(
	compiledFlow: CompiledWorkflow,
	placeholderSpecId: string,
	generatedSpecIds: string[],
): void {
	for (const task of compiledFlow.tasks) {
		if (!task.dependsOn) continue;
		task.dependsOn = replaceDependencyList(
			task.dependsOn,
			placeholderSpecId,
			generatedSpecIds,
		);
	}
}

function replaceDependencyList(
	dependsOn: string[],
	placeholderSpecId: string,
	generatedSpecIds: string[],
): string[] {
	const replaced: string[] = [];
	for (const dep of dependsOn) {
		if (dep === placeholderSpecId) replaced.push(...generatedSpecIds);
		else replaced.push(dep);
	}
	return [...new Set(replaced)];
}

function markDagDependentsSkipped(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
): boolean {
	const bySpecId = new Map(run.tasks.map((task) => [task.specId, task]));
	let changed = false;
	let passChanged = true;

	while (passChanged) {
		passChanged = false;
		for (const [index, task] of run.tasks.entries()) {
			if (task.status !== "pending") continue;
			const compiledTask = compiledFlow.tasks[index];
			if (!compiledTask) continue;
			const failedDep = (compiledTask.dependsOn ?? []).find((dep) => {
				const status = bySpecId.get(dep)?.status;
				return (
					status === "failed" ||
					status === "interrupted" ||
					status === "skipped"
				);
			});
			if (!failedDep) continue;
			if (
				stageSourcePolicy(compiledFlow, compiledTask.stageId ?? "") ===
				"partial"
			)
				continue;
			setTaskTerminal(task, "skipped", "skipped_after_dependency_failure", {
				lastMessage: `skipped because dependency ${failedDep} did not complete`,
			});
			changed = true;
			passChanged = true;
		}
	}

	return changed;
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

	let launchTask = await prepareDagTask(cwd, run, compiledFlow, index);
	if (task.outputRetry) {
		launchTask = await prepareArtifactGraphRetryTask(cwd, task, launchTask);
	}

	try {
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
		const statusDetail =
			launchTask.kind === "support"
				? "support_failed"
				: launchTask.safety.requiresWorktree
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
		});
		await assertDynamicGeneratedTasksSettled({
			cwd,
			run,
			compiledFlow,
			controllerIndex,
			controllerTask: task,
			controllerCompiledTask: compiledTask,
			dynamic: compiledTask.dynamic,
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

async function runDynamicDecisionPersistCall(input: {
	cwd: string;
	run: WorkflowRunRecord;
	controllerTask: WorkflowTaskRunRecord;
	opId: string;
	callIndex: number;
	rawDecision: unknown;
	context: unknown;
}): Promise<Record<string, unknown>> {
	const context = isPlainDynamicRecord(input.context) ? input.context : {};
	const validation = validateDynamicDecision(input.rawDecision, context);
	const stateIndexDigest = optionalDynamicStringField(context.stateIndexDigest);
	const requestHash = hashDynamicRequest({
		rawDecision: input.rawDecision,
		context,
		validationHash: validation.hash,
		stateIndexDigest,
	});
	const alreadyRecorded = await assertDynamicControlOpRequestStable({
		cwd: input.cwd,
		runId: input.run.runId,
		opId: input.opId,
		type: "decision.persisted",
		requestHash,
		errorPrefix: "dynamic decision persist request changed",
	});
	const written = await writeDynamicDecisionArtifacts({
		cwd: input.cwd,
		runId: input.run.runId,
		controllerSpecId: input.controllerTask.specId,
		rawDecision: input.rawDecision,
		validation,
		stateIndexDigest,
	});
	if (!alreadyRecorded)
		await recordDynamicEventAndUpdateState(input.cwd, input.run.runId, {
			controllerSpecId: input.controllerTask.specId,
			type: "decision.persisted",
			opId: input.opId,
			requestHash,
			payload: {
				callIndex: input.callIndex,
				ok: validation.ok,
				errors: validation.errors,
				decisionHash: validation.hash,
				stateIndexDigest,
				paths: {
					raw: toProjectPath(input.cwd, written.rawPath),
					validation: toProjectPath(input.cwd, written.validationPath),
					...(written.acceptedPath
						? { accepted: toProjectPath(input.cwd, written.acceptedPath) }
						: {}),
				},
			},
		});
	return {
		ok: validation.ok,
		errors: validation.errors,
		decision: validation.decision,
		decisionHash: validation.hash,
		stateIndexDigest,
		artifacts: {
			raw: toProjectPath(input.cwd, written.rawPath),
			validation: toProjectPath(input.cwd, written.validationPath),
			...(written.acceptedPath
				? { accepted: toProjectPath(input.cwd, written.acceptedPath) }
				: {}),
		},
	};
}

async function runDynamicFanoutPlanPersistCall(input: {
	cwd: string;
	run: WorkflowRunRecord;
	controllerTask: WorkflowTaskRunRecord;
	opId: string;
	callIndex: number;
	request: NormalizedDynamicFanoutPlanRequest;
}): Promise<Record<string, unknown>> {
	const controllerStageId =
		input.controllerTask.stageId ??
		input.controllerTask.specId.replace(/\.controller$/, "");
	const branches = input.request.branches.map((branch) => ({
		branchId: branch.branchId,
		actionId: branch.actionId,
		requestId: branch.requestId,
		type: branch.type,
		outputProfile: branch.outputProfile,
		...(branch.dependsOn && branch.dependsOn.length > 0
			? { dependsOn: branch.dependsOn }
			: {}),
		requestHash: hashDynamicRequest(branch.agentRequest),
		status: "planned" as const,
		targetSpecId: `${controllerStageId}.${branch.requestId}`,
	}));
	// requestId/targetSpecId are derived audit fields; keep the fanout
	// stability hash tied to the pre-existing branch request identity.
	const requestHashBranches = branches.map(
		({ requestId: _requestId, targetSpecId: _targetSpecId, ...branch }) =>
			branch,
	);
	const payload = {
		callIndex: input.callIndex,
		round: input.request.round,
		decisionHash: input.request.decisionHash,
		branches,
	};
	const requestHash = hashDynamicRequest({
		round: input.request.round,
		decisionHash: input.request.decisionHash,
		branches: requestHashBranches,
	});
	const alreadyRecorded = await assertDynamicControlOpRequestStable({
		cwd: input.cwd,
		runId: input.run.runId,
		opId: input.opId,
		type: "fanout.planned",
		requestHash,
		errorPrefix: "dynamic fanout plan request changed",
	});
	if (!alreadyRecorded) {
		await recordDynamicEventAndUpdateState(input.cwd, input.run.runId, {
			controllerSpecId: input.controllerTask.specId,
			type: "fanout.planned",
			opId: input.opId,
			requestHash,
			payload,
		});
		return payload;
	}
	const previous = (await readDynamicEvents(input.cwd, input.run.runId))
		.filter(
			(event) => event.opId === input.opId && event.type === "fanout.planned",
		)
		.at(-1);
	return isPlainDynamicRecord(previous?.payload) ? previous.payload : payload;
}

async function runDynamicStateIndexPersistCall(input: {
	cwd: string;
	run: WorkflowRunRecord;
	controllerTask: WorkflowTaskRunRecord;
	controllerCompiledTask: CompiledTask;
	opId: string;
	callIndex: number;
	request: unknown;
}): Promise<Record<string, unknown>> {
	const request = normalizeDynamicStateIndexRequest(input.request);
	const extracts = await Promise.all(
		request.tasks.map(async (taskRequest) => {
			const task = resolveDynamicRunTask(input.run, taskRequest.taskId);
			assertDynamicReadableTask(
				task,
				input.controllerTask,
				input.controllerCompiledTask,
			);
			const result = await readWorkflowTaskStructuredResult(input.cwd, task, {
				allowFailed: true,
			});
			return extractDynamicStateArtifact({
				taskId: task.specId,
				outputProfile: taskRequest.outputProfile,
				control: isPlainDynamicRecord(result.control)
					? result.control
					: undefined,
				analysis:
					typeof result.analysis === "string" ? result.analysis : undefined,
				refs: result.refs,
				artifactRef: { taskId: task.specId, artifact: "control" },
				status: result.status === "completed" ? "completed" : "failed",
				maxFindings: request.maxFindings,
			});
		}),
	);
	const index = assembleDynamicStateIndex(extracts, {
		// requiredFindingIds is accepted on ctx.stateIndex requests for
		// compatibility, but is a deprecated/no-op Phase 1 runtime field.
		maxFindings: request.maxFindings,
	});
	const requestHash = hashDynamicRequest({ request, digest: index.digest });
	const alreadyRecorded = await assertDynamicControlOpRequestStable({
		cwd: input.cwd,
		runId: input.run.runId,
		opId: input.opId,
		type: "state-index.persisted",
		requestHash,
		errorPrefix: "dynamic state index request changed",
	});
	const written = await writeDynamicStateIndexArtifacts({
		cwd: input.cwd,
		runId: input.run.runId,
		controllerSpecId: input.controllerTask.specId,
		round: request.round,
		extracts,
		index,
	});
	if (!alreadyRecorded)
		await recordDynamicEventAndUpdateState(input.cwd, input.run.runId, {
			controllerSpecId: input.controllerTask.specId,
			type: "state-index.persisted",
			opId: input.opId,
			requestHash,
			payload: {
				callIndex: input.callIndex,
				round: request.round,
				digest: index.digest,
				tasks: request.tasks,
				paths: {
					extracts: toProjectPath(input.cwd, written.extractsPath),
					index: toProjectPath(input.cwd, written.indexPath),
				},
			},
		});
	return {
		digest: index.digest,
		index,
		artifacts: {
			extracts: toProjectPath(input.cwd, written.extractsPath),
			index: toProjectPath(input.cwd, written.indexPath),
		},
	};
}

async function runDynamicDecisionLoopStatusPersistCall(input: {
	cwd: string;
	run: WorkflowRunRecord;
	controllerTask: WorkflowTaskRunRecord;
	opId: string;
	callIndex: number;
	request: unknown;
}): Promise<Record<string, unknown>> {
	const decisionLoop = normalizeDynamicDecisionLoopStatusRequest(input.request);
	const payload = {
		callIndex: input.callIndex,
		status: "running",
		decisionLoop,
	};
	const requestHash = hashDynamicRequest(payload);
	const alreadyRecorded = await assertDynamicControlOpRequestStable({
		cwd: input.cwd,
		runId: input.run.runId,
		opId: input.opId,
		type: "controller.status",
		requestHash,
		errorPrefix: "dynamic decision-loop status request changed",
	});
	if (!alreadyRecorded) {
		await recordDynamicEventAndUpdateState(input.cwd, input.run.runId, {
			controllerSpecId: input.controllerTask.specId,
			type: "controller.status",
			opId: input.opId,
			requestHash,
			payload,
		});
		return payload;
	}
	const previous = (await readDynamicEvents(input.cwd, input.run.runId))
		.filter(
			(event) =>
				event.opId === input.opId && event.type === "controller.status",
		)
		.at(-1);
	return isPlainDynamicRecord(previous?.payload) ? previous.payload : payload;
}

async function runDynamicResultReadCall(input: {
	cwd: string;
	run: WorkflowRunRecord;
	controllerTask: WorkflowTaskRunRecord;
	controllerCompiledTask: CompiledTask;
	opId: string;
	callIndex: number;
	request: unknown;
}): Promise<Record<string, unknown>> {
	const request = normalizeDynamicResultReadRequest(input.request);
	const task = resolveDynamicRunTask(input.run, request.taskId);
	assertDynamicReadableTask(
		task,
		input.controllerTask,
		input.controllerCompiledTask,
	);
	const result = await readWorkflowTaskScopedResult(input.cwd, task, {
		allowFailed: request.allowFailed,
		include: request.include,
	});
	const resultDigest = hashDynamicRequest(result);
	const requestHash = hashDynamicRequest({
		request,
		status: result.status,
		resultDigest,
	});
	const alreadyRecorded = await assertDynamicControlOpRequestStable({
		cwd: input.cwd,
		runId: input.run.runId,
		opId: input.opId,
		type: "result.read",
		requestHash,
		errorPrefix: "dynamic result read request changed",
	});
	if (!alreadyRecorded)
		await recordDynamicEventAndUpdateState(input.cwd, input.run.runId, {
			controllerSpecId: input.controllerTask.specId,
			type: "result.read",
			opId: input.opId,
			requestHash,
			payload: {
				callIndex: input.callIndex,
				taskId: task.specId,
				status: result.status,
				resultDigest,
			},
		});
	return result;
}

async function assertDynamicControlOpRequestStable(input: {
	cwd: string;
	runId: string;
	opId: string;
	type:
		| "decision.persisted"
		| "fanout.planned"
		| "state-index.persisted"
		| "controller.status"
		| "result.read";
	requestHash: string;
	errorPrefix: string;
}): Promise<boolean> {
	const previous = (await readDynamicEvents(input.cwd, input.runId)).filter(
		(event) => event.opId === input.opId && event.type === input.type,
	);
	const divergent = previous.find(
		(event) => event.requestHash !== input.requestHash,
	);
	if (divergent) {
		throw new Error(
			`${input.errorPrefix} for ${input.opId}; previous hash ${divergent.requestHash}, new hash ${input.requestHash}`,
		);
	}
	return previous.length > 0;
}

interface NormalizedDynamicFanoutPlanRequest {
	round: number;
	decisionHash: string;
	branches: Array<{
		branchId: string;
		actionId: string;
		requestId: string;
		type: "add_work_item" | "verify";
		outputProfile: DynamicOutputProfile;
		dependsOn?: string[];
		agentRequest: DynamicAgentRequest;
	}>;
}

function normalizeDynamicFanoutPlanRequest(
	value: unknown,
): NormalizedDynamicFanoutPlanRequest {
	if (!isPlainDynamicRecord(value)) {
		throw new Error("ctx.fanout.plan() input must be an object");
	}
	const round = requiredDynamicNonNegativeInteger(
		value.round,
		"round",
		"ctx.fanout.plan()",
	);
	const decisionHash = requiredDynamicString(
		value.decisionHash,
		"decisionHash",
		"ctx.fanout.plan()",
	);
	if (!Array.isArray(value.branches)) {
		throw new Error("ctx.fanout.plan() branches must be an array");
	}
	const branches = value.branches.map((item, index) => {
		if (!isPlainDynamicRecord(item)) {
			throw new Error(`ctx.fanout.plan() branches[${index}] must be an object`);
		}
		const branchId = requiredDynamicString(
			item.branchId,
			`branches[${index}].branchId`,
			"ctx.fanout.plan()",
		);
		const actionId = requiredDynamicString(
			item.actionId,
			`branches[${index}].actionId`,
			"ctx.fanout.plan()",
		);
		const type = requiredDynamicString(
			item.type,
			`branches[${index}].type`,
			"ctx.fanout.plan()",
		);
		if (type !== "add_work_item" && type !== "verify") {
			throw new Error(
				`ctx.fanout.plan() branches[${index}].type must be add_work_item or verify`,
			);
		}
		const branchType: "add_work_item" | "verify" = type;
		const outputProfile = requiredDynamicOutputProfile(
			item.outputProfile,
			`branches[${index}].outputProfile`,
			"ctx.fanout.plan()",
		);
		const dependsOn = optionalDynamicStringArray(
			item.dependsOn,
			`branches[${index}].dependsOn`,
		);
		const agentRequest = normalizeDynamicAgentRequest(item.agentRequest);
		if (agentRequest.branchId && agentRequest.branchId !== branchId) {
			throw new Error(
				`ctx.fanout.plan() branches[${index}].agentRequest.branchId must match branchId`,
			);
		}
		const requestId = agentRequest.id;
		const declaredRequestId = optionalDynamicString(
			item.requestId,
			`branches[${index}].requestId`,
		);
		if (declaredRequestId && declaredRequestId !== requestId) {
			throw new Error(
				`ctx.fanout.plan() branches[${index}].requestId must match agentRequest.id`,
			);
		}
		return {
			branchId,
			actionId,
			requestId,
			type: branchType,
			outputProfile,
			dependsOn,
			agentRequest: { ...agentRequest, branchId },
		};
	});
	return { round, decisionHash, branches };
}

function normalizeDynamicStateIndexRequest(value: unknown): {
	round: number;
	tasks: Array<{ taskId: string; outputProfile: DynamicOutputProfile }>;
	maxFindings?: number;
} {
	if (!isPlainDynamicRecord(value)) {
		throw new Error(
			"ctx.stateIndex.extractAndPersist() input must be an object",
		);
	}
	const round = requiredDynamicNonNegativeInteger(
		value.round,
		"round",
		"ctx.stateIndex.extractAndPersist()",
	);
	if (!Array.isArray(value.tasks)) {
		throw new Error(
			"ctx.stateIndex.extractAndPersist() tasks must be an array",
		);
	}
	const tasks = value.tasks.map((item, index) => {
		if (!isPlainDynamicRecord(item)) {
			throw new Error(
				`ctx.stateIndex.extractAndPersist() tasks[${index}] must be an object`,
			);
		}
		return {
			taskId: requiredDynamicString(
				item.taskId ?? item.specId,
				`tasks[${index}].taskId`,
				"ctx.stateIndex.extractAndPersist()",
			),
			outputProfile: requiredDynamicOutputProfile(
				item.outputProfile,
				`tasks[${index}].outputProfile`,
				"ctx.stateIndex.extractAndPersist()",
			),
		};
	});
	// Deprecated/no-op compatibility field: validate accepted shape, then drop
	// it so Phase 1 runtime state-index assembly and replay hashes ignore it.
	optionalDynamicStringArray(value.requiredFindingIds, "requiredFindingIds");
	return {
		round,
		tasks,
		maxFindings: optionalDynamicPositiveInteger(
			value.maxFindings,
			"maxFindings",
		),
	};
}

function normalizeDynamicDecisionLoopStatusRequest(value: unknown): {
	stallCount: number;
	replanCount: number;
} {
	if (!isPlainDynamicRecord(value)) {
		throw new Error(
			"ctx.dynamic.recordDecisionLoopStatus() input must be an object",
		);
	}
	return {
		stallCount: requiredDynamicNonNegativeInteger(
			value.stallCount,
			"stallCount",
			"ctx.dynamic.recordDecisionLoopStatus()",
		),
		replanCount: requiredDynamicNonNegativeInteger(
			value.replanCount,
			"replanCount",
			"ctx.dynamic.recordDecisionLoopStatus()",
		),
	};
}

const DEFAULT_DYNAMIC_RESULT_INCLUDE = ["$.schema", "$.digest"];

function normalizeDynamicResultReadRequest(value: unknown): {
	taskId: string;
	allowFailed: boolean;
	include: string[];
} {
	if (typeof value === "string") {
		return {
			taskId: value,
			allowFailed: false,
			include: [...DEFAULT_DYNAMIC_RESULT_INCLUDE],
		};
	}
	if (!isPlainDynamicRecord(value)) {
		throw new Error("ctx.result() input must be a task id string or object");
	}
	return {
		taskId: requiredDynamicString(
			value.taskId ?? value.specId,
			"taskId",
			"ctx.result()",
		),
		allowFailed: value.allowFailed === true,
		include: normalizeDynamicResultInclude(value.include) ?? [
			...DEFAULT_DYNAMIC_RESULT_INCLUDE,
		],
	};
}

function resolveDynamicRunTask(
	run: WorkflowRunRecord,
	taskIdOrSpecId: string,
): WorkflowTaskRunRecord {
	const task = run.tasks.find(
		(candidate) =>
			candidate.taskId === taskIdOrSpecId ||
			candidate.specId === taskIdOrSpecId,
	);
	if (!task)
		throw new Error(`dynamic task result not found: ${taskIdOrSpecId}`);
	return task;
}

function assertDynamicReadableTask(
	task: WorkflowTaskRunRecord,
	controllerTask: WorkflowTaskRunRecord,
	controllerCompiledTask: CompiledTask,
): void {
	if (task.dynamicGenerated?.controllerSpecId === controllerTask.specId) return;
	const allowed = new Set([
		...(controllerCompiledTask.dependsOn ?? []),
		...(controllerCompiledTask.contextDependsOn ?? []),
	]);
	if (allowed.has(task.specId)) return;
	throw new Error(
		`dynamic result read is limited to generated tasks and upstream dependencies; ${task.specId} is not readable by ${controllerTask.specId}`,
	);
}

async function readWorkflowTaskStructuredResult(
	cwd: string,
	task: WorkflowTaskRunRecord,
	options: { allowFailed?: boolean } = {},
): Promise<Record<string, unknown>> {
	if (task.status === "completed") {
		const output = await readTaskOutputArtifacts(cwd, task);
		return {
			status: task.status,
			statusDetail: task.statusDetail,
			taskId: task.taskId,
			specId: task.specId,
			...output,
		};
	}
	if (!isTerminalTaskStatus(task.status)) {
		throw new DynamicControllerSuspended(
			`waiting for dynamic task result ${task.specId} (${task.status})`,
		);
	}
	if (!options.allowFailed) {
		throw new Error(
			`dynamic task result ${task.specId} ended with ${task.status}: ${task.lastMessage ?? task.statusDetail}`,
		);
	}
	const output = await readTaskOutputArtifacts(cwd, task).catch(() => ({}));
	return {
		status: task.status,
		statusDetail: task.statusDetail,
		taskId: task.taskId,
		specId: task.specId,
		lastMessage: task.lastMessage,
		...output,
	};
}

async function readTaskOutputArtifacts(
	cwd: string,
	task: WorkflowTaskRunRecord,
): Promise<Record<string, unknown>> {
	if (task.artifactGraph?.enabled) {
		const taskDir = dirname(fromProjectPath(cwd, task.files.result));
		return {
			control: await readArtifactGraphControl(cwd, task).catch(() => undefined),
			analysis: await readFile(join(taskDir, "analysis.md"), "utf8").catch(
				() => undefined,
			),
			refs: await readJson(join(taskDir, "refs.json")).catch(() => undefined),
		};
	}
	return {
		result: await readJson(fromProjectPath(cwd, task.files.result)).catch(
			() => undefined,
		),
	};
}

async function readWorkflowTaskScopedResult(
	cwd: string,
	task: WorkflowTaskRunRecord,
	options: { allowFailed?: boolean; include: readonly string[] },
): Promise<Record<string, unknown>> {
	if (task.status === "completed") {
		return {
			...dynamicTaskResultMetadata(task),
			...(await readScopedTaskOutput(cwd, task, options.include)),
		};
	}
	if (!isTerminalTaskStatus(task.status)) {
		throw new DynamicControllerSuspended(
			`waiting for dynamic task result ${task.specId} (${task.status})`,
		);
	}
	if (!options.allowFailed) {
		throw new Error(
			`dynamic task result ${task.specId} ended with ${task.status}: ${task.lastMessage ?? task.statusDetail}`,
		);
	}
	const output = await readScopedTaskOutput(cwd, task, options.include).catch(
		() => ({}),
	);
	return {
		...dynamicTaskResultMetadata(task),
		lastMessage: task.lastMessage,
		...output,
	};
}

function dynamicTaskResultMetadata(
	task: WorkflowTaskRunRecord,
): Record<string, unknown> {
	return {
		status: task.status,
		statusDetail: task.statusDetail,
		taskId: task.taskId,
		specId: task.specId,
		...(task.dynamicGenerated?.outputProfile
			? { outputProfile: task.dynamicGenerated.outputProfile }
			: {}),
	};
}

async function readScopedTaskOutput(
	cwd: string,
	task: WorkflowTaskRunRecord,
	include: readonly string[],
): Promise<Record<string, unknown>> {
	if (task.artifactGraph?.enabled) {
		const control = await readArtifactGraphControl(cwd, task).catch(
			() => undefined,
		);
		const projection = projectArtifactGraphControl(control, {
			include: [...include],
		});
		const scopedControl = projection.value ?? {};
		const digest = controlDigest(control);
		return {
			control: scopedControl,
			artifacts: dynamicResultArtifactRefs(
				task,
				await artifactRefsForTask(cwd, task),
				digest,
			),
			scope: dynamicResultScope({
				taskId: task.specId,
				artifact: "control",
				include,
				content: scopedControl,
				contentDigest: digest,
				missingPaths: projection.missingPaths,
			}),
		};
	}
	const result = await readJson(fromProjectPath(cwd, task.files.result)).catch(
		() => undefined,
	);
	const projection = projectArtifactGraphControl(result, {
		include: [...include],
	});
	const scopedResult = projection.value ?? {};
	const digest = hashDynamicRequest(result);
	return {
		result: scopedResult,
		artifacts: { result: { taskId: task.specId, artifact: "result", digest } },
		scope: dynamicResultScope({
			taskId: task.specId,
			artifact: "result",
			include,
			content: scopedResult,
			contentDigest: digest,
			missingPaths: projection.missingPaths,
		}),
	};
}

function dynamicResultArtifactRefs(
	task: WorkflowTaskRunRecord,
	artifacts: WorkflowSourceManifestSource["artifacts"],
	controlDigestValue: string | undefined,
): Record<string, unknown> {
	const refs: Record<string, unknown> = {};
	for (const artifact of Object.keys(artifacts)) {
		refs[artifact] = {
			taskId: task.specId,
			artifact,
			...(artifact === "control" && controlDigestValue
				? { digest: controlDigestValue }
				: {}),
		};
	}
	return refs;
}

function dynamicResultScope(input: {
	taskId: string;
	artifact: string;
	include: readonly string[];
	content: unknown;
	contentDigest?: string;
	missingPaths: readonly string[];
}): Record<string, unknown> {
	const base = {
		taskId: input.taskId,
		artifact: input.artifact,
		include: [...input.include],
		contentDigest: input.contentDigest,
		missingPaths: [...input.missingPaths],
		content: input.content,
	};
	return {
		taskId: input.taskId,
		artifact: input.artifact,
		include: [...input.include],
		...(input.contentDigest ? { contentDigest: input.contentDigest } : {}),
		...(input.missingPaths.length > 0
			? { missingPaths: [...input.missingPaths] }
			: {}),
		scopeHash: hashDynamicRequest(base),
	};
}

function normalizeDynamicResultInclude(value: unknown): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new Error("ctx.result() include must be an array of strings");
	}
	return value.map((item, index) =>
		normalizeDynamicResultPath(
			requiredDynamicString(item, `include[${index}]`, "ctx.result()"),
		),
	);
}

function normalizeDynamicResultPath(path: string): string {
	let normalized = path.trim();
	if (normalized === "$" || normalized.includes("*")) {
		throw new Error("ctx.result() include paths must name explicit fields");
	}
	if (!normalized.startsWith("$.")) {
		normalized = `$.${normalized.replace(/^\.+/, "")}`;
	}
	if (normalized === "$.") {
		throw new Error("ctx.result() include paths must name explicit fields");
	}
	return normalized;
}

function requiredDynamicOutputProfile(
	value: unknown,
	field: string,
	api: string,
): DynamicOutputProfile {
	const profile = requiredDynamicString(value, field, api);
	if (!isDynamicOutputProfile(profile)) {
		throw new Error(`${api} ${field} has an unsupported output profile`);
	}
	return profile;
}

function requiredDynamicNonNegativeInteger(
	value: unknown,
	field: string,
	api: string,
): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new Error(`${api} ${field} must be a non-negative integer`);
	}
	return value;
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

function optionalDynamicStringField(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalDynamicOutputProfile(
	value: unknown,
): DynamicOutputProfile | undefined {
	if (value === undefined) return undefined;
	return requiredDynamicOutputProfile(value, "outputProfile", "ctx.agent()");
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

async function ensureDynamicControllerApproval(input: {
	cwd: string;
	run: WorkflowRunRecord;
	task: WorkflowTaskRunRecord;
	dynamic: CompiledDynamicWorkflowTask;
	taskText?: string;
	ui?: DynamicWorkflowUi;
}): Promise<
	{ allowed: true } | { allowed: false; statusDetail: string; message: string }
> {
	const opId = `${input.task.specId}:approval:controller`;
	const approvalRequest = await dynamicApprovalRequestPayload(input);
	const requestHash = hashDynamicRequest(approvalRequest);
	const approvalEvents = (
		await readDynamicEvents(input.cwd, input.run.runId)
	).filter(
		(event) =>
			event.opId === opId &&
			(event.type === "approval.pending" || event.type === "approval.resolved"),
	);
	const divergent = approvalEvents.find(
		(event) => event.requestHash !== requestHash,
	);
	if (divergent) {
		const message = `dynamic approval request changed since the pending prompt; previous hash ${divergent.requestHash}, new hash ${requestHash}. Resolve the workflow bundle/spec scope change, then start a new workflow run to approve the updated scope.`;
		await recordDynamicControllerStatus(input.cwd, input.run.runId, {
			controllerSpecId: input.task.specId,
			status: "policy_blocked",
			message,
		}).catch(() => undefined);
		return {
			allowed: false,
			statusDetail: "dynamic_approval_changed",
			message,
		};
	}
	const resolved = approvalEvents
		.filter((event) => event.type === "approval.resolved")
		.at(-1);
	const approvalMessage = await dynamicApprovalPromptMessage(
		input,
		requestHash,
	);
	const hasPendingApproval = approvalEvents.some(
		(event) =>
			event.type === "approval.pending" && event.requestHash === requestHash,
	);
	if (resolved) {
		if (resolved.payload.approved === true) return { allowed: true };
		const message =
			"dynamic controller approval was rejected; this run will not re-prompt on resume. Start a new workflow run if you want to approve it later.";
		await recordDynamicControllerStatus(input.cwd, input.run.runId, {
			controllerSpecId: input.task.specId,
			status: "policy_blocked",
			message,
		}).catch(() => undefined);
		return {
			allowed: false,
			statusDetail: "dynamic_approval_rejected",
			message,
		};
	}
	if (typeof input.ui?.confirm !== "function" || input.ui.hasUI === false) {
		if (!hasPendingApproval) {
			await recordDynamicEventAndUpdateState(input.cwd, input.run.runId, {
				controllerSpecId: input.task.specId,
				type: "approval.pending",
				opId,
				requestHash,
				payload: {
					message: approvalMessage,
					approvalScope: approvalRequest,
				},
			});
		}
		const message = `dynamic approval mode "ask" requires an interactive Pi UI; this scheduler has no approval UI. Open an interactive Pi session and run /workflow resume ${input.run.runId} to approve or reject.`;
		await recordDynamicControllerStatus(input.cwd, input.run.runId, {
			controllerSpecId: input.task.specId,
			status: "awaiting_ui_unavailable",
			message,
		});
		return {
			allowed: false,
			statusDetail: "dynamic_ui_unavailable",
			message,
		};
	}
	if (!hasPendingApproval) {
		await recordDynamicEventAndUpdateState(input.cwd, input.run.runId, {
			controllerSpecId: input.task.specId,
			type: "approval.pending",
			opId,
			requestHash,
			payload: {
				message: approvalMessage,
				approvalScope: approvalRequest,
			},
		});
	}
	let approved: boolean;
	try {
		approved = await confirmDynamicControllerApproval(
			input.ui,
			approvalMessage,
		);
	} catch {
		const message = `dynamic controller approval timed out or was unavailable. Open an interactive Pi session and run /workflow resume ${input.run.runId} to approve or reject.`;
		await recordDynamicControllerStatus(input.cwd, input.run.runId, {
			controllerSpecId: input.task.specId,
			status: "awaiting_ui_unavailable",
			message,
		});
		return {
			allowed: false,
			statusDetail: "dynamic_approval_timeout",
			message,
		};
	}
	await recordDynamicEventAndUpdateState(input.cwd, input.run.runId, {
		controllerSpecId: input.task.specId,
		type: "approval.resolved",
		opId,
		requestHash,
		payload: { approved, approvalScope: approvalRequest },
	});
	if (!approved) {
		const message =
			"dynamic controller approval was rejected; this run will not re-prompt on resume. Start a new workflow run if you want to approve it later.";
		await recordDynamicControllerStatus(input.cwd, input.run.runId, {
			controllerSpecId: input.task.specId,
			status: "policy_blocked",
			message,
		});
		return {
			allowed: false,
			statusDetail: "dynamic_approval_rejected",
			message,
		};
	}
	return { allowed: true };
}

async function dynamicApprovalRequestPayload(input: {
	cwd: string;
	run: WorkflowRunRecord;
	task: WorkflowTaskRunRecord;
	dynamic: CompiledDynamicWorkflowTask;
	taskText?: string;
}): Promise<Record<string, unknown>> {
	return {
		controllerSpecId: input.task.specId,
		bundle: await workflowBundleFingerprint(input.cwd, input.run),
		uses: input.dynamic.uses,
		mode: input.dynamic.mode,
		taskText: dynamicApprovalTaskFingerprint(input.taskText),
		budget: input.dynamic.budget,
		permissions: input.dynamic.permissions,
		helpers: Object.fromEntries(
			Object.entries(input.dynamic.helpers).map(([id, helper]) => [
				id,
				{
					uses: helper.uses,
					inputSchema: helper.inputSchema,
					outputSchema: helper.outputSchema,
					idempotent: helper.idempotent === true,
				},
			]),
		),
		workflows: Object.fromEntries(
			Object.entries(input.dynamic.workflows).map(([id, workflow]) => [
				id,
				{ uses: workflow.uses },
			]),
		),
	};
}

function dynamicApprovalTaskFingerprint(
	value: string | undefined,
): { preview: string; length: number; hash: string } | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	return {
		preview: truncateDynamicTaskText(trimmed),
		length: trimmed.length,
		hash: hashDynamicRequest(trimmed),
	};
}

function truncateDynamicTaskText(value: string | undefined): string {
	if (!value) return "";
	const trimmed = value.trim();
	return trimmed.length > 1_000 ? `${trimmed.slice(0, 1_000)}…` : trimmed;
}

async function confirmDynamicControllerApproval(
	ui: DynamicWorkflowUi,
	message: string,
): Promise<boolean> {
	const controller = new AbortController();
	let timeout: NodeJS.Timeout | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeout = setTimeout(() => {
			controller.abort();
			reject(new Error("dynamic approval timed out"));
		}, DYNAMIC_APPROVAL_TIMEOUT_MS);
	});
	const confirmPromise = Promise.resolve(
		ui.confirm!("Run dynamic workflow controller?", message, {
			timeout: DYNAMIC_APPROVAL_TIMEOUT_MS,
			signal: controller.signal,
		}),
	);
	confirmPromise.catch(() => undefined);
	try {
		return await Promise.race([confirmPromise, timeoutPromise]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

async function dynamicApprovalPromptMessage(
	input: {
		cwd: string;
		run: WorkflowRunRecord;
		task: WorkflowTaskRunRecord;
		dynamic: CompiledDynamicWorkflowTask;
		taskText?: string;
	},
	approvalRequestHash: string,
): Promise<string> {
	const helpers = Object.entries(input.dynamic.helpers).map(
		([id, helper]) => `${id} -> ${helper.uses}`,
	);
	const workflows = Object.entries(input.dynamic.workflows).map(
		([id, workflow]) => `${id} -> ${workflow.uses}`,
	);
	const taskFingerprint = dynamicApprovalTaskFingerprint(input.taskText);
	const resolvedBundleSpec = await workflowBundleSpecPath(
		input.cwd,
		input.run,
		{
			required: true,
		},
	).catch(() => undefined);
	const bundleSpec = resolvedBundleSpec
		? relative(input.cwd, resolvedBundleSpec).replaceAll("\\", "/")
		: `.pi/workflows/${input.run.runId}/bundle/${basename(input.run.specPath)}`;
	return [
		`Workflow run ${input.run.runId} (${input.run.name ?? "unnamed workflow"}) requests approval to run dynamic controller ${input.task.specId}.`,
		`Original spec: ${input.run.specPath}`,
		`Run bundle spec: ${bundleSpec}`,
		`Approval request digest: ${approvalRequestHash}`,
		...(taskFingerprint
			? [
					`Task: ${taskFingerprint.preview}`,
					`Task digest: ${taskFingerprint.hash} (length=${taskFingerprint.length})`,
				]
			: []),
		`Controller helper: ${input.dynamic.uses}`,
		`Mode: ${input.dynamic.mode}`,
		`Generated agents may request dynamic roles/tools: roles=${input.dynamic.permissions.allowDynamicRoles ? "allowed" : "blocked"}, tools=${input.dynamic.permissions.allowDynamicTools ? "allowed" : "blocked"}.`,
		"Approving this controller authorizes this controller's generated agents to run without later approval prompts. Generated agents run non-interactively within the allowed roles/tools and budgets shown here; read-only generated agents use the shared workspace, while mutation-capable agents and agents using Pi-default tools use managed worktrees. Nested workflows keep their own approval policy and may still block for approval.",
		`Budget: maxAgents=${input.dynamic.budget.maxAgents}, maxConcurrency=${input.dynamic.budget.maxConcurrency}, maxRuntimeMs=${input.dynamic.budget.maxRuntimeMs}, maxGraphMutations=${input.dynamic.budget.maxGraphMutations}, maxHelperRuns=${input.dynamic.budget.maxHelperRuns}, maxNestedWorkflowDepth=${input.dynamic.budget.maxNestedWorkflowDepth}.`,
		helpers.length > 0
			? `Declared helpers: ${helpers.join(", ")}`
			: "Declared helpers: none",
		workflows.length > 0
			? `Declared nested workflows: ${workflows.join(", ")}`
			: "Declared nested workflows: none",
		"Approve only if this workflow bundle and its helper code are trusted.",
	].join("\n");
}

class DynamicControllerSuspended extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DynamicControllerSuspended";
	}
}

class DynamicControllerNestedApprovalBlocked extends Error {
	constructor(
		message: string,
		public readonly nestedRunId: string,
	) {
		super(message);
		this.name = "DynamicControllerNestedApprovalBlocked";
	}
}

class DynamicControllerBudgetBlocked extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DynamicControllerBudgetBlocked";
	}
}

async function assertDynamicRuntimeBudgetAvailable(input: {
	cwd: string;
	runId: string;
	controllerSpecId: string;
	dynamic: CompiledDynamicWorkflowTask;
}): Promise<void> {
	const message = await dynamicRuntimeBudgetExceededMessageForController(
		input.cwd,
		input.runId,
		input.controllerSpecId,
		input.dynamic,
	);
	if (message) throw new DynamicControllerBudgetBlocked(message);
}

async function dynamicRuntimeBudgetExceededMessageForController(
	cwd: string,
	runId: string,
	controllerSpecId: string,
	dynamic: CompiledDynamicWorkflowTask,
): Promise<string | undefined> {
	const state = await readOrRebuildDynamicState(cwd, runId);
	const runtimeMs =
		state.controllers[controllerSpecId]?.counters.runtimeMs ?? 0;
	return dynamicRuntimeBudgetExceededMessage(dynamic, runtimeMs);
}

function dynamicRuntimeBudgetExceededMessage(
	dynamic: CompiledDynamicWorkflowTask,
	consumedRuntimeMs: number,
): string | undefined {
	if (consumedRuntimeMs >= dynamic.budget.maxRuntimeMs) {
		return `dynamic runtime budget exhausted: runtimeMs=${consumedRuntimeMs} maxRuntimeMs=${dynamic.budget.maxRuntimeMs}`;
	}
	return undefined;
}

async function recordDynamicRuntimeUsage(
	cwd: string,
	runId: string,
	controllerSpecId: string,
	elapsedMs: number,
): Promise<void> {
	await recordDynamicEventAndUpdateState(cwd, runId, {
		controllerSpecId,
		type: "budget.used",
		opId: `${controllerSpecId}:budget:runtime`,
		requestHash: hashDynamicRequest({ controllerSpecId, elapsedMs }),
		payload: { counters: { runtimeMs: elapsedMs } },
	});
}

interface DynamicArtifactInput {
	kind: "workflow-artifact-ref";
	name: string;
	options?: Record<string, unknown>;
	required: boolean;
}

interface DynamicAgentRequest {
	id: string;
	agent?: string;
	profile?: string;
	prompt: string;
	outputProfile?: string;
	tools?: string[];
	branchId?: string;
	readOnly?: boolean;
	model?: string;
	thinking?: ThinkingLevel;
	maxRuntimeMs?: number;
	inputs: DynamicArtifactInput[];
	requiredReads: string[];
	dependsOn?: string[];
	compact: boolean;
}

interface DynamicHelperCallInput {
	sources: Record<string, unknown>;
	options?: Record<string, unknown>;
}

interface DynamicNestedWorkflowInput {
	task: string;
	wait: boolean;
}

async function runDynamicNestedWorkflowCall(input: {
	cwd: string;
	run: WorkflowRunRecord;
	controllerTask: WorkflowTaskRunRecord;
	helperSpecPath: string;
	dynamic: CompiledDynamicWorkflowTask;
	dynamicUi?: DynamicWorkflowUi;
	workflowId: string;
	callIndex: number;
	workflowInput: unknown;
	isSettled?: () => boolean;
}): Promise<unknown> {
	await assertDynamicRuntimeBudgetAvailable({
		cwd: input.cwd,
		runId: input.run.runId,
		controllerSpecId: input.controllerTask.specId,
		dynamic: input.dynamic,
	});
	const workflowId = requiredDynamicString(
		input.workflowId,
		"workflow name",
		"ctx.workflow()",
	);
	const workflowSpec = input.dynamic.workflows[workflowId];
	if (!workflowSpec) {
		throw new Error(
			`dynamic nested workflow is not declared in spec.json: ${workflowId}`,
		);
	}
	const normalizedInput = normalizeDynamicNestedWorkflowInput(
		input.workflowInput,
	);
	const nestedSpecPath = resolveDynamicNestedWorkflowSpecPath(
		input.helperSpecPath,
		workflowSpec.uses,
	);
	const opId = `${input.controllerTask.specId}:workflow:${workflowId}:${String(input.callIndex).padStart(3, "0")}`;
	const request = {
		workflowId,
		uses: workflowSpec.uses,
		specHash: hashDynamicRequest(await readFile(nestedSpecPath, "utf8")),
		input: normalizedInput,
	};
	const requestHash = hashDynamicRequest(request);
	const events = await readDynamicEvents(input.cwd, input.run.runId);
	const previousStarts = events.filter(
		(event) => event.opId === opId && event.type === "workflow.started",
	);
	const divergent = previousStarts.find(
		(event) => event.requestHash !== requestHash,
	);
	if (divergent) {
		throw new Error(
			`dynamic workflow request changed for ${workflowId} call ${input.callIndex}; previous hash ${divergent.requestHash}, new hash ${requestHash}`,
		);
	}
	const previousCompleted = events.find(
		(event) => event.opId === opId && event.type === "workflow.completed",
	);
	const previousNonWaitingSnapshot = [...previousStarts]
		.reverse()
		.map((event) => event.payload.result)
		.find((result) => result !== undefined);
	if (!normalizedInput.wait && previousNonWaitingSnapshot !== undefined) {
		return previousNonWaitingSnapshot;
	}
	if (previousCompleted) return previousCompleted.payload.result;
	let nestedRunId = optionalEventString(
		[...previousStarts]
			.reverse()
			.find((event) => optionalEventString(event.payload.runId))?.payload.runId,
	);
	if (!nestedRunId) {
		await assertDynamicNestedWorkflowBudgetAvailable({
			cwd: input.cwd,
			runId: input.run.runId,
			controllerSpecId: input.controllerTask.specId,
			dynamic: input.dynamic,
		});
		nestedRunId = makeRunId();
		await recordDynamicEventAndUpdateState(input.cwd, input.run.runId, {
			controllerSpecId: input.controllerTask.specId,
			type: "workflow.started",
			opId,
			requestHash,
			payload: {
				workflowId,
				uses: workflowSpec.uses,
				runId: nestedRunId,
				wait: normalizedInput.wait,
				status: "starting",
			},
		});
	}
	let nestedRun = await readRunRecord(input.cwd, nestedRunId).catch(
		() => undefined,
	);
	if (!nestedRun) {
		nestedRun = await runWorkflowSpec(nestedSpecPath, input.cwd, {
			task: normalizedInput.task,
			dynamicUi: input.dynamicUi,
			runId: nestedRunId,
			parentRunId: input.run.runId,
		});
		if (input.isSettled?.()) return undefined;
		const result = !normalizedInput.wait
			? await buildNestedWorkflowResult(input.cwd, nestedRun)
			: undefined;
		await recordDynamicEventAndUpdateState(input.cwd, input.run.runId, {
			controllerSpecId: input.controllerTask.specId,
			type: "workflow.started",
			opId,
			requestHash,
			payload: {
				workflowId,
				uses: workflowSpec.uses,
				runId: nestedRunId,
				wait: normalizedInput.wait,
				status: nestedRun.status,
				...(result !== undefined ? { result } : {}),
			},
		});
		if (result !== undefined) return result;
	}
	nestedRun = await refreshRun(input.cwd, nestedRunId);
	if (!normalizedInput.wait) {
		const result = await buildNestedWorkflowResult(input.cwd, nestedRun);
		if (input.isSettled?.()) return undefined;
		await recordDynamicEventAndUpdateState(input.cwd, input.run.runId, {
			controllerSpecId: input.controllerTask.specId,
			type: "workflow.started",
			opId,
			requestHash,
			payload: {
				workflowId,
				uses: workflowSpec.uses,
				runId: nestedRunId,
				wait: false,
				status: nestedRun.status,
				result,
			},
		});
		return result;
	}
	if (nestedRun.status === "completed") {
		const result = await buildNestedWorkflowResult(input.cwd, nestedRun);
		if (input.isSettled?.()) return undefined;
		await recordDynamicEventAndUpdateState(input.cwd, input.run.runId, {
			controllerSpecId: input.controllerTask.specId,
			type: "workflow.completed",
			opId,
			requestHash,
			payload: { workflowId, runId: nestedRun.runId, result },
		});
		return result;
	}
	if (isResumableDynamicApprovalBlockedRun(nestedRun) && normalizedInput.wait) {
		throw new DynamicControllerNestedApprovalBlocked(
			`dynamic nested workflow ${workflowId} (${nestedRun.runId}) is blocked awaiting approval; run /workflow resume ${nestedRun.runId}, then run /workflow resume ${input.run.runId} after the nested workflow completes to continue the parent workflow`,
			nestedRun.runId,
		);
	}
	if (nestedRun.status === "running" && normalizedInput.wait) {
		throw new DynamicControllerSuspended(
			`waiting for dynamic nested workflow ${workflowId} (${nestedRun.runId})`,
		);
	}
	if (nestedRun.status === "running") {
		return await buildNestedWorkflowResult(input.cwd, nestedRun);
	}
	throw new Error(
		`dynamic nested workflow ${workflowId} ended with ${nestedRun.status}`,
	);
}

async function buildNestedWorkflowResult(
	cwd: string,
	run: WorkflowRunRecord,
): Promise<Record<string, unknown>> {
	const tasks = await Promise.all(
		run.tasks.map(async (task) => {
			const control =
				task.status === "completed" && task.artifactGraph?.enabled
					? await readArtifactGraphControl(cwd, task).catch(() => undefined)
					: undefined;
			return {
				taskId: task.taskId,
				specId: task.specId,
				stageId: task.stageId,
				status: task.status,
				statusDetail: task.statusDetail,
				...(control !== undefined ? { control } : {}),
			};
		}),
	);
	return {
		status: run.status,
		runId: run.runId,
		taskSummary: run.taskSummary,
		tasks,
	};
}

async function assertDynamicNestedWorkflowBudgetAvailable(input: {
	cwd: string;
	runId: string;
	controllerSpecId: string;
	dynamic: CompiledDynamicWorkflowTask;
}): Promise<void> {
	const state = await readOrRebuildDynamicState(input.cwd, input.runId);
	const counters = state.controllers[input.controllerSpecId]?.counters;
	if (
		(counters?.nestedWorkflowDepth ?? 0) >=
		input.dynamic.budget.maxNestedWorkflowDepth
	) {
		throw new DynamicControllerBudgetBlocked(
			`dynamic nested workflow budget exhausted: maxNestedWorkflowDepth=${input.dynamic.budget.maxNestedWorkflowDepth}`,
		);
	}
}

function normalizeDynamicNestedWorkflowInput(
	value: unknown,
): DynamicNestedWorkflowInput {
	if (typeof value === "string") return { task: value, wait: true };
	if (!isPlainDynamicRecord(value)) {
		throw new Error("ctx.workflow() input must be a task string or object");
	}
	return {
		task: requiredDynamicString(value.task, "workflow task", "ctx.workflow()"),
		wait: value.wait === false ? false : true,
	};
}

function resolveDynamicNestedWorkflowSpecPath(
	helperSpecPath: string,
	ref: string,
): string {
	if (
		!ref.startsWith("./") ||
		!ref.endsWith(".json") ||
		isAbsolute(ref) ||
		ref.includes("\\") ||
		ref.includes("://") ||
		/^[A-Za-z][A-Za-z0-9+.-]*:/.test(ref) ||
		ref.split("/").includes("..")
	) {
		throw new Error(
			"dynamic nested workflow must be a bundle-local ./ .json spec",
		);
	}
	const root = dirname(helperSpecPath);
	const resolved = resolve(root, ref);
	const rel = relative(root, resolved);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new Error(
			"dynamic nested workflow must stay inside the workflow bundle",
		);
	}
	return resolved;
}

function optionalEventString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

async function runDynamicHelperCall(input: {
	cwd: string;
	run: WorkflowRunRecord;
	controllerTask: WorkflowTaskRunRecord;
	helperSpecPath: string;
	dynamic: CompiledDynamicWorkflowTask;
	helperId: string;
	callIndex: number;
	helperInput: unknown;
	isSettled?: () => boolean;
}): Promise<unknown> {
	await assertDynamicRuntimeBudgetAvailable({
		cwd: input.cwd,
		runId: input.run.runId,
		controllerSpecId: input.controllerTask.specId,
		dynamic: input.dynamic,
	});
	const helperId = requiredDynamicString(
		input.helperId,
		"helper name",
		"ctx.helper()",
	);
	const helperSpec = input.dynamic.helpers[helperId];
	if (!helperSpec) {
		throw new Error(`dynamic helper is not declared in spec.json: ${helperId}`);
	}
	const normalizedInput = normalizeDynamicHelperCallInput(input.helperInput);
	const opId = `${input.controllerTask.specId}:helper:${helperId}:${String(input.callIndex).padStart(3, "0")}`;
	const request = {
		helperId,
		uses: helperSpec.uses,
		idempotent: helperSpec.idempotent === true,
		inputSchema: await dynamicHelperSchemaFingerprint(
			input.helperSpecPath,
			helperSpec.inputSchema,
		),
		outputSchema: await dynamicHelperSchemaFingerprint(
			input.helperSpecPath,
			helperSpec.outputSchema,
		),
		input: normalizedInput,
	};
	const requestHash = hashDynamicRequest(request);
	const previous = (await readDynamicEvents(input.cwd, input.run.runId)).filter(
		(event) =>
			event.opId === opId &&
			(event.type === "helper.started" || event.type === "helper.completed"),
	);
	const divergent = previous.find((event) => event.requestHash !== requestHash);
	if (divergent) {
		throw new Error(
			`dynamic helper request changed for ${helperId} call ${input.callIndex}; previous hash ${divergent.requestHash}, new hash ${requestHash}`,
		);
	}
	const completed = previous.find((event) => event.type === "helper.completed");
	if (completed) return completed.payload.result;
	const hasDanglingStarted = previous.some(
		(event) => event.type === "helper.started",
	);
	if (hasDanglingStarted && !helperSpec.idempotent) {
		throw new Error(
			`dynamic helper ${helperId} call ${input.callIndex} previously started but did not complete; helper side effects are not replay-safe`,
		);
	}
	if (!hasDanglingStarted) {
		await assertDynamicHelperBudgetAvailable({
			cwd: input.cwd,
			runId: input.run.runId,
			controllerSpecId: input.controllerTask.specId,
			dynamic: input.dynamic,
		});
	}
	await validateDynamicHelperSchema(
		input.helperSpecPath,
		helperSpec.inputSchema,
		normalizedInput,
		`dynamic helper ${helperId} input`,
	);
	if (input.isSettled?.()) return undefined;
	if (!hasDanglingStarted) {
		await recordDynamicEventAndUpdateState(input.cwd, input.run.runId, {
			controllerSpecId: input.controllerTask.specId,
			type: "helper.started",
			opId,
			requestHash,
			payload: {
				helperId,
				uses: helperSpec.uses,
				input: normalizedInput,
			},
		});
	}
	const result = await runDynamicHelperWorker({
		ref: helperSpec.uses,
		specPath: input.helperSpecPath,
		callInput: {
			sources: normalizedInput.sources,
			options: normalizedInput.options,
			context: {
				specPath: input.helperSpecPath,
				originalSpecPath: input.run.specPath,
				stageId: input.controllerTask.stageId,
				taskId: input.controllerTask.taskId,
				runId: input.run.runId,
				cwd: input.cwd,
			},
		},
		timeoutMs: remainingDynamicRuntimeMs(
			input.dynamic,
			(await readOrRebuildDynamicState(input.cwd, input.run.runId)).controllers[
				input.controllerTask.specId
			]?.counters.runtimeMs ?? 0,
		),
	});
	if (input.isSettled?.()) return undefined;
	const serializedResult = toDynamicJsonValue(result);
	await validateDynamicHelperSchema(
		input.helperSpecPath,
		helperSpec.outputSchema,
		serializedResult,
		`dynamic helper ${helperId} output`,
	);
	if (input.isSettled?.()) return undefined;
	await recordDynamicEventAndUpdateState(input.cwd, input.run.runId, {
		controllerSpecId: input.controllerTask.specId,
		type: "helper.completed",
		opId,
		requestHash,
		payload: {
			helperId,
			uses: helperSpec.uses,
			result: serializedResult,
		},
	});
	return serializedResult;
}

async function validateDynamicHelperSchema(
	helperSpecPath: string,
	schemaRef: string | undefined,
	value: unknown,
	label: string,
): Promise<void> {
	if (!schemaRef) return;
	const schemaPath = resolveDynamicHelperSchemaPath(helperSpecPath, schemaRef);
	const schema = JSON.parse(await readFile(schemaPath, "utf8")) as JsonSchema;
	const result = validateJsonSchema(value, schema);
	if (!result.valid) {
		throw new Error(
			`${label} does not match schema ${schemaRef}: ${result.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`,
		);
	}
}

async function dynamicHelperSchemaFingerprint(
	helperSpecPath: string,
	schemaRef: string | undefined,
): Promise<{ ref: string; hash: string } | undefined> {
	if (!schemaRef) return undefined;
	const schemaPath = resolveDynamicHelperSchemaPath(helperSpecPath, schemaRef);
	const schema = JSON.parse(await readFile(schemaPath, "utf8"));
	return { ref: schemaRef, hash: hashDynamicRequest(schema) };
}

function resolveDynamicHelperSchemaPath(
	helperSpecPath: string,
	ref: string,
): string {
	if (ref.includes("#")) {
		throw new Error(
			"dynamic helper schema JSON Pointer fragments are not supported",
		);
	}
	const pathPart = ref;
	if (
		!pathPart.startsWith("./") ||
		!pathPart.endsWith(".json") ||
		isAbsolute(pathPart) ||
		pathPart.includes("\\") ||
		pathPart.includes("://") ||
		/^[A-Za-z][A-Za-z0-9+.-]*:/.test(pathPart) ||
		pathPart.split("/").includes("..")
	) {
		throw new Error(
			"dynamic helper schema must be a bundle-local ./ .json file",
		);
	}
	const root = dirname(helperSpecPath);
	const resolved = resolve(root, pathPart.slice(2));
	const rel = relative(root, resolved);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new Error(
			"dynamic helper schema must stay inside the workflow bundle",
		);
	}
	return resolved;
}

async function assertDynamicHelperBudgetAvailable(input: {
	cwd: string;
	runId: string;
	controllerSpecId: string;
	dynamic: CompiledDynamicWorkflowTask;
}): Promise<void> {
	const state = await readOrRebuildDynamicState(input.cwd, input.runId);
	const counters = state.controllers[input.controllerSpecId]?.counters;
	if ((counters?.helperRuns ?? 0) >= input.dynamic.budget.maxHelperRuns) {
		throw new DynamicControllerBudgetBlocked(
			`dynamic helper budget exhausted: maxHelperRuns=${input.dynamic.budget.maxHelperRuns}`,
		);
	}
}

function normalizeDynamicHelperCallInput(
	value: unknown,
): DynamicHelperCallInput {
	if (value === undefined) return { sources: {} };
	if (!isPlainDynamicRecord(value)) {
		return { sources: {}, options: { value } };
	}
	if ("sources" in value || "options" in value) {
		return {
			sources: isPlainDynamicRecord(value.sources) ? value.sources : {},
			...(isPlainDynamicRecord(value.options)
				? { options: value.options }
				: {}),
		};
	}
	return { sources: {}, options: value };
}

function toDynamicJsonValue(value: unknown): unknown {
	const text = JSON.stringify(value);
	if (text === undefined) return null;
	return JSON.parse(text) as unknown;
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

async function assertDynamicGenerationBudgetAvailable(input: {
	cwd: string;
	runId: string;
	controllerSpecId: string;
	dynamic: CompiledDynamicWorkflowTask;
}): Promise<void> {
	const state = await readOrRebuildDynamicState(input.cwd, input.runId);
	const counters = state.controllers[input.controllerSpecId]?.counters;
	if ((counters?.agents ?? 0) >= input.dynamic.budget.maxAgents) {
		throw new DynamicControllerBudgetBlocked(
			`dynamic agent budget exhausted: maxAgents=${input.dynamic.budget.maxAgents}`,
		);
	}
	if (
		(counters?.graphMutations ?? 0) >= input.dynamic.budget.maxGraphMutations
	) {
		throw new DynamicControllerBudgetBlocked(
			`dynamic graph mutation budget exhausted: maxGraphMutations=${input.dynamic.budget.maxGraphMutations}`,
		);
	}
}

async function buildDynamicGeneratedCompiledTask(input: {
	cwd: string;
	run: WorkflowRunRecord;
	compiledFlow: CompiledWorkflow;
	controllerCompiledTask: CompiledTask;
	controllerSpecId: string;
	controllerStageId: string;
	generatedSpecId: string;
	opId: string;
	requestHash: string;
	branchId?: string;
	request: DynamicAgentRequest;
	dynamic: CompiledDynamicWorkflowTask;
}): Promise<CompiledTask> {
	if (input.dynamic.budget.maxAgents <= 0) {
		throw new Error("dynamic agent budget is exhausted");
	}
	const executionProfile = dynamicDecisionLoopProfile(
		input.dynamic,
		input.request.profile,
	);
	if (executionProfile)
		assertDynamicExecutionProfileRequest(input.request, executionProfile);
	const effectiveOutputProfile =
		input.request.outputProfile ?? executionProfile?.outputProfile;
	if (effectiveOutputProfile) {
		assertDynamicOutputProfileAllowed(input.dynamic, effectiveOutputProfile);
	}
	const requestedAgent = input.request.agent ?? executionProfile?.agent;
	if (!requestedAgent) {
		throw new Error(
			"dynamic agent request must declare an agent or execution profile",
		);
	}
	if (!executionProfile && !input.dynamic.permissions.allowDynamicRoles) {
		throw new Error(
			"dynamic agent role selection is not allowed by workflow permissions",
		);
	}
	if (
		input.request.tools &&
		!executionProfile &&
		!input.dynamic.permissions.allowDynamicTools
	) {
		throw new Error(
			"dynamic agent tool overrides are not allowed by workflow permissions",
		);
	}
	const agentDefinition = await loadAgentByName(requestedAgent, input.cwd);
	if (!agentDefinition) {
		throw new Error(`Agent not found: ${requestedAgent}`);
	}
	if (agentDefinition.maxSubagentDepth > 0) {
		throw new Error(
			`dynamic agent ${agentDefinition.displayName} declares maxSubagentDepth > 0, which is invalid in dynamic generated tasks`,
		);
	}
	const tools =
		executionProfile?.tools ?? input.request.tools ?? agentDefinition.tools;
	if (input.request.tools && !executionProfile && !agentDefinition.tools) {
		throw new Error(
			`dynamic agent ${requestedAgent} does not declare a tools authority ceiling`,
		);
	}
	if (tools && agentDefinition.tools) {
		const missing = tools.filter(
			(tool) => !agentDefinition.tools?.includes(tool),
		);
		if (missing.length > 0) {
			throw new Error(
				`dynamic agent requested tools not declared by ${requestedAgent}: ${missing.join(", ")}`,
			);
		}
	}
	const forbiddenDelegationTools = (tools ?? []).filter((tool) =>
		DYNAMIC_DELEGATION_TOOLS.has(tool),
	);
	if (forbiddenDelegationTools.length > 0) {
		throw new Error(
			`dynamic agent ${requestedAgent} declares invalid delegation/orchestration tools: ${forbiddenDelegationTools.join(", ")}`,
		);
	}
	const toolProviders =
		executionProfile?.toolProviders ??
		providersForSelectedTools(
			tools,
			new Map(
				Object.entries(
					input.controllerCompiledTask.runtime.toolProviders ?? {},
				),
			),
		);
	const unknownTools = (tools ?? []).filter(
		(tool) => effectiveToolClassification(tool, toolProviders) === undefined,
	);
	if (unknownTools.length > 0) {
		throw new Error(
			`dynamic agent requested tools without trusted classification metadata: ${unknownTools.join(", ")}`,
		);
	}
	assertDynamicExecutionPolicy({
		dynamic: input.dynamic,
		agent: requestedAgent,
		tools,
	});
	const capability = dynamicTaskCapability(tools, toolProviders);
	const requiresWorktree = capability !== "read-only";
	const inputDependsOn = dynamicInputDependencySpecIds(
		input.run,
		input.request.inputs,
	);
	const explicitDependsOn = dynamicDependencySpecIds(
		input.run,
		input.request.dependsOn ?? [],
	);
	const defaultDependsOn = input.controllerCompiledTask.dependsOn ?? [];
	const dependsOn = uniqueStrings(
		input.request.inputs.length > 0 || input.request.dependsOn
			? [...inputDependsOn, ...explicitDependsOn]
			: [...defaultDependsOn],
	);
	const defaultContextDependsOn =
		input.controllerCompiledTask.contextDependsOn ?? defaultDependsOn;
	const contextDependsOn = uniqueStrings(
		input.request.inputs.length > 0 || input.request.dependsOn
			? [...inputDependsOn, ...explicitDependsOn]
			: [...defaultContextDependsOn],
	);
	validateDynamicGeneratedDependencies({
		run: input.run,
		compiledFlow: input.compiledFlow,
		controllerSpecId: input.controllerSpecId,
		generatedSpecId: input.generatedSpecId,
		dependsOn,
		contextDependsOn,
	});
	const refsMinItems = dynamicGeneratedTaskRefsMinItems({
		run: input.run,
		outputProfile: effectiveOutputProfile,
	});
	const refsUrlValidation = dynamicGeneratedTaskRefsUrlValidation({
		run: input.run,
		outputProfile: effectiveOutputProfile,
	});
	const compiledPrompt = [
		`# Workflow Stage\n\nstage=${input.controllerStageId}\ntype=dynamic-agent\nitem=${input.request.id}`,
		`# Instructions\n\n${appendDynamicOutputInstructions(input.request.prompt, effectiveOutputProfile, DYNAMIC_OUTPUT_MAX_DIGEST_CHARS, refsMinItems)}`,
		input.request.compact
			? "# Output Scope\n\nReturn compact typed output. Prefer concise control JSON and artifact refs over pasted context."
			: undefined,
	]
		.filter(Boolean)
		.join("\n\n");
	return {
		id: input.generatedSpecId,
		key: input.generatedSpecId,
		specId: input.generatedSpecId,
		taskId: input.request.id,
		stageId: input.controllerStageId,
		agent: requestedAgent,
		agentPath: agentDefinition.sourcePath,
		agentDescription: agentDefinition.description,
		agentSystemPrompt: agentDefinition.body,
		systemPromptMode: agentDefinition.systemPromptMode,
		inheritProjectContext: agentDefinition.inheritProjectContext,
		inheritSkills: agentDefinition.inheritSkills,
		roleNames: [],
		task: input.request.prompt,
		cwd: input.controllerCompiledTask.cwd,
		explicitCwd: false,
		explicitWorktreePolicy: requiresWorktree,
		runtime: {
			approvalMode: "non-interactive",
			model:
				input.request.model ??
				executionProfile?.model ??
				input.controllerCompiledTask.runtime.model ??
				agentDefinition.model,
			thinking:
				input.request.thinking ??
				executionProfile?.thinking ??
				input.controllerCompiledTask.runtime.thinking ??
				agentDefinition.thinking,
			tools,
			...(toolProviders ? { toolProviders } : {}),
			maxRuntimeMs:
				input.request.maxRuntimeMs ??
				executionProfile?.maxRuntimeMs ??
				input.dynamic.budget.maxRuntimeMs,
		},
		safety: {
			readOnlyDeclared: input.request.readOnly ?? capability === "read-only",
			capability,
			sharedCwdSafe: !requiresWorktree,
			worktreePolicy: requiresWorktree ? "on" : "off",
			requiresWorktree,
			permission: { status: "pending" },
		},
		compiledPrompt,
		kind: "dynamic-agent",
		stageMaxConcurrency: input.dynamic.budget.maxConcurrency,
		dependsOn,
		contextDependsOn,
		artifactGraph: {
			enabled: true,
			output: {
				analysisRequired: true,
				refsRequired: true,
				refsMinItems,
				refsUrlValidation,
				maxDigestChars: DYNAMIC_OUTPUT_MAX_DIGEST_CHARS,
			},
			requiredReads: input.request.requiredReads,
			sourceProjection: dynamicInputSourceProjection(input.request.inputs),
		},
		dynamicGenerated: {
			controllerSpecId: input.controllerSpecId,
			opId: input.opId,
			requestHash: input.requestHash,
			...(input.branchId ? { branchId: input.branchId } : {}),
			...(effectiveOutputProfile
				? { outputProfile: effectiveOutputProfile }
				: {}),
		},
	} as CompiledTask;
}

function dynamicGeneratedTaskRefsMinItems(input: {
	run: WorkflowRunRecord;
	outputProfile: string | undefined;
}): number | undefined {
	if (input.outputProfile !== "synthesis_v1") return undefined;
	return input.run.provenance?.mode === "direct-dynamic" ? 1 : undefined;
}

function dynamicGeneratedTaskRefsUrlValidation(input: {
	run: WorkflowRunRecord;
	outputProfile: string | undefined;
}): boolean | undefined {
	if (!input.outputProfile) return undefined;
	return input.run.provenance?.mode === "direct-dynamic" ? true : undefined;
}

function assertDynamicExecutionProfileRequest(
	request: DynamicAgentRequest,
	profile: NonNullable<CompiledDynamicWorkflowTask["decisionLoop"]>["planner"],
): void {
	if (request.agent && profile?.agent && request.agent !== profile.agent) {
		throw new Error(
			`dynamic execution profile agent mismatch: requested ${request.agent}, profile ${profile.agent}`,
		);
	}
	if (request.tools) {
		throw new Error(
			"dynamic execution profile requests cannot override tools; configure tools in dynamic.decisionLoop",
		);
	}
	if (request.model && profile?.model && request.model !== profile.model) {
		throw new Error("dynamic execution profile requests cannot override model");
	}
	if (
		request.thinking &&
		profile?.thinking &&
		request.thinking !== profile.thinking
	) {
		throw new Error(
			"dynamic execution profile requests cannot override thinking",
		);
	}
	if (
		request.maxRuntimeMs &&
		profile?.maxRuntimeMs &&
		request.maxRuntimeMs !== profile.maxRuntimeMs
	) {
		throw new Error(
			"dynamic execution profile requests cannot override maxRuntimeMs",
		);
	}
}

function assertDynamicOutputProfileAllowed(
	dynamic: CompiledDynamicWorkflowTask,
	outputProfile: string,
): void {
	const allowed = dynamic.decisionLoop?.allowedOutputProfiles;
	if (allowed && allowed.length > 0 && !allowed.includes(outputProfile)) {
		throw new Error(
			`dynamic output profile ${outputProfile} is not allowed by decisionLoop policy`,
		);
	}
}

function assertDynamicExecutionPolicy(input: {
	dynamic: CompiledDynamicWorkflowTask;
	agent: string;
	tools?: string[];
}): void {
	const policy = input.dynamic.decisionLoop;
	if (!policy) return;
	if (
		policy.allowedAgents.length > 0 &&
		!policy.allowedAgents.includes(input.agent)
	) {
		throw new Error(
			`dynamic execution agent ${input.agent} is not allowed by decisionLoop policy`,
		);
	}
	const allowedTools = new Set(policy.allowedTools ?? []);
	if (allowedTools.size > 0) {
		const disallowed = (input.tools ?? []).filter(
			(tool) => !allowedTools.has(tool),
		);
		if (disallowed.length > 0) {
			throw new Error(
				`dynamic execution tools not allowed by decisionLoop policy: ${disallowed.join(", ")}`,
			);
		}
	}
}

function dynamicDecisionLoopProfile(
	dynamic: CompiledDynamicWorkflowTask,
	profileId: string | undefined,
):
	| NonNullable<CompiledDynamicWorkflowTask["decisionLoop"]>["planner"]
	| undefined {
	if (!profileId) return undefined;
	const decisionLoop = dynamic.decisionLoop;
	if (!decisionLoop) return undefined;
	if (profileId === "planner") return decisionLoop.planner;
	if (profileId === "worker" || profileId === "workerDefaults")
		return decisionLoop.workerDefaults;
	if (profileId === "verifier") return decisionLoop.verifier;
	if (profileId === "synthesis") return decisionLoop.synthesis;
	throw new Error(
		`unknown dynamic decision-loop execution profile: ${profileId}`,
	);
}

function isDynamicCompiledTaskPayload(value: unknown): value is CompiledTask {
	return (
		!!value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		typeof (value as { id?: unknown }).id === "string" &&
		!!(value as { dynamicGenerated?: unknown }).dynamicGenerated
	);
}

function assertDynamicGeneratedMetadataMatches(
	compiledTask: CompiledTask,
	expected: {
		controllerSpecId: string;
		opId: string;
		requestHash: string;
		requestId: string;
		branchId?: string;
	},
): void {
	const actual = compiledTask.dynamicGenerated;
	if (
		!actual ||
		actual.controllerSpecId !== expected.controllerSpecId ||
		actual.opId !== expected.opId ||
		actual.requestHash !== expected.requestHash ||
		(expected.branchId !== undefined && actual.branchId !== expected.branchId)
	) {
		throw new Error(
			`dynamic agent request changed for id "${expected.requestId}"; generated task metadata does not match replay request`,
		);
	}
}

function validateDynamicGeneratedDependencies(input: {
	run: WorkflowRunRecord;
	compiledFlow: CompiledWorkflow;
	controllerSpecId: string;
	generatedSpecId: string;
	dependsOn: readonly string[];
	contextDependsOn: readonly string[];
}): void {
	for (const dependency of uniqueStrings([
		...input.dependsOn,
		...input.contextDependsOn,
	])) {
		if (dependency === input.controllerSpecId) {
			throw new Error(
				`dynamic generated task cannot depend on its controller (${dependency})`,
			);
		}
		const runTask = input.run.tasks.find((task) => task.specId === dependency);
		const compiledTask = input.compiledFlow.tasks.find(
			(task) => task.id === dependency,
		);
		if (!runTask || !compiledTask) continue;
		if (
			compiledTask.dynamicGenerated?.controllerSpecId !==
				input.controllerSpecId &&
			!isTerminalTaskStatus(runTask.status)
		) {
			throw new Error(
				`dynamic generated task dependency ${dependency} is not completed; dependencies must be completed upstream tasks or generated siblings`,
			);
		}
		if (
			compiledTask.dynamicGenerated?.controllerSpecId !==
				input.controllerSpecId &&
			compiledTaskTransitivelyDependsOn(
				input.compiledFlow,
				compiledTask.id,
				input.controllerSpecId,
			)
		) {
			throw new Error(
				`dynamic generated task dependency ${dependency} depends on controller ${input.controllerSpecId} and would create a controller-child cycle`,
			);
		}
		if (
			compiledTaskTransitivelyDependsOn(
				input.compiledFlow,
				compiledTask.id,
				input.generatedSpecId,
			)
		) {
			throw new Error(
				`dynamic generated task dependency ${dependency} would create a generated-task cycle with ${input.generatedSpecId}`,
			);
		}
	}
}

function compiledTaskTransitivelyDependsOn(
	compiledFlow: CompiledWorkflow,
	fromSpecId: string,
	targetSpecId: string,
	seen = new Set<string>(),
): boolean {
	if (seen.has(fromSpecId)) return false;
	seen.add(fromSpecId);
	const task = compiledFlow.tasks.find(
		(candidate) => candidate.id === fromSpecId,
	);
	if (!task) return false;
	for (const dependency of uniqueStrings([
		...(task.dependsOn ?? []),
		...(task.contextDependsOn ?? []),
	])) {
		if (dependency === targetSpecId) return true;
		if (
			compiledTaskTransitivelyDependsOn(
				compiledFlow,
				dependency,
				targetSpecId,
				seen,
			)
		) {
			return true;
		}
	}
	return false;
}

function dynamicInputSourceProjection(
	inputs: readonly DynamicArtifactInput[],
): NonNullable<CompiledTask["artifactGraph"]>["sourceProjection"] | undefined {
	const include: string[] = [];
	let maxChars: number | undefined;
	for (const input of inputs) {
		const projection = isPlainDynamicRecord(input.options?.projection)
			? input.options?.projection
			: input.options;
		if (!projection) continue;
		const projectionInclude = Array.isArray(projection.include)
			? projection.include.filter(
					(item): item is string => typeof item === "string",
				)
			: [];
		include.push(...projectionInclude);
		if (
			typeof projection.maxChars === "number" &&
			Number.isInteger(projection.maxChars) &&
			projection.maxChars > 0
		) {
			maxChars =
				maxChars === undefined
					? projection.maxChars
					: Math.min(maxChars, projection.maxChars);
		}
	}
	const uniqueInclude = uniqueStrings(include);
	if (uniqueInclude.length === 0 && maxChars === undefined) return undefined;
	return {
		...(uniqueInclude.length > 0 ? { include: uniqueInclude } : {}),
		...(maxChars !== undefined ? { maxChars } : {}),
	};
}

function dynamicInputDependencySpecIds(
	run: WorkflowRunRecord,
	inputs: readonly DynamicArtifactInput[],
): string[] {
	const specIds: string[] = [];
	for (const input of inputs) {
		const source = splitDynamicArtifactName(input.name).source;
		const task = resolveDynamicSourceTask(run, source, {
			required: input.required,
		});
		if (task) specIds.push(task.specId);
	}
	return uniqueStrings(specIds);
}

function dynamicDependencySpecIds(
	run: WorkflowRunRecord,
	refs: readonly string[],
): string[] {
	const specIds: string[] = [];
	for (const ref of refs) {
		const task = resolveDynamicSourceTask(run, ref);
		if (task) specIds.push(task.specId);
	}
	return uniqueStrings(specIds);
}

function splitDynamicArtifactName(name: string): {
	source: string;
	artifact?: string;
} {
	const parts = name.split(".").filter(Boolean);
	const artifact = parts.at(-1);
	if (
		artifact === "control" ||
		artifact === "analysis" ||
		artifact === "refs" ||
		artifact === "raw"
	) {
		const source = parts.slice(0, -1).join(".");
		if (source) return { source, artifact };
	}
	return { source: name };
}

function resolveDynamicSourceTask(
	run: WorkflowRunRecord,
	ref: string,
	options: { required?: boolean } = {},
): WorkflowTaskRunRecord | undefined {
	const exact = run.tasks.find((task) => task.specId === ref);
	if (exact) return exact;
	const byStage = run.tasks.filter((task) => task.stageId === ref);
	if (byStage.length === 1) return byStage[0];
	if (byStage.length > 1) {
		throw new Error(
			`dynamic artifact source "${ref}" is ambiguous; use an exact task specId`,
		);
	}
	if (options.required === false) return undefined;
	throw new Error(`dynamic artifact source not found: ${ref}`);
}

function dynamicGeneratedInsertIndex(
	compiledFlow: CompiledWorkflow,
	controllerIndex: number,
	controllerSpecId: string,
): number {
	let index = controllerIndex + 1;
	while (
		index < compiledFlow.tasks.length &&
		compiledFlow.tasks[index].dynamicGenerated?.controllerSpecId ===
			controllerSpecId
	) {
		index += 1;
	}
	return index;
}

async function readDynamicGeneratedTaskResult(
	cwd: string,
	task: WorkflowTaskRunRecord,
): Promise<Record<string, unknown>> {
	if (task.artifactGraph?.enabled) {
		return {
			status: "completed",
			taskId: task.taskId,
			specId: task.specId,
			control: await readArtifactGraphControl(cwd, task),
		};
	}
	const result = await readJson<Record<string, unknown>>(
		fromProjectPath(cwd, task.files.result),
	);
	return {
		status: "completed",
		taskId: task.taskId,
		specId: task.specId,
		result,
	};
}

function normalizeDynamicAgentRequest(value: unknown): DynamicAgentRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("ctx.agent() request must be an object");
	}
	const record = value as Record<string, unknown>;
	const id = sanitizeTaskId(requiredDynamicString(record.id, "id"));
	if (!id) throw new Error("ctx.agent() id must contain letters or numbers");
	if (id === "controller") {
		throw new Error('ctx.agent() id "controller" is reserved');
	}
	const inputs = normalizeDynamicArtifactInputs(record.inputs);
	return {
		id,
		agent: optionalDynamicString(record.agent ?? record.role, "agent"),
		profile: optionalDynamicString(record.profile, "profile"),
		prompt: requiredDynamicString(record.prompt, "prompt"),
		outputProfile: optionalDynamicOutputProfile(record.outputProfile),
		tools: optionalDynamicStringArray(record.tools, "tools"),
		branchId: optionalDynamicString(record.branchId, "branchId"),
		readOnly: optionalDynamicBoolean(record.readOnly, "readOnly"),
		model: optionalDynamicString(record.model, "model"),
		thinking: optionalDynamicThinking(record.thinking),
		maxRuntimeMs: optionalDynamicPositiveInteger(
			record.maxRuntimeMs,
			"maxRuntimeMs",
		),
		inputs,
		requiredReads:
			optionalDynamicStringArray(record.requiredReads, "requiredReads") ??
			inputs
				.filter((input) => input.required)
				.map((input) => input.name)
				.filter(
					(name) => splitDynamicArtifactName(name).artifact !== undefined,
				),
		dependsOn: optionalDynamicStringArray(record.dependsOn, "dependsOn"),
		compact: record.compact !== false,
	};
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

function optionalDynamicString(
	value: unknown,
	field: string,
): string | undefined {
	if (value === undefined) return undefined;
	return requiredDynamicString(value, field);
}

function optionalDynamicStringArray(
	value: unknown,
	field: string,
): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new Error(`ctx.agent() ${field} must be an array of strings`);
	}
	return value.map((item) => item.trim()).filter(Boolean);
}

function normalizeDynamicArtifactInputs(
	value: unknown,
): DynamicArtifactInput[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		throw new Error("ctx.agent() inputs must be an array");
	}
	return value.map((item, index) => normalizeDynamicArtifactInput(item, index));
}

function normalizeDynamicArtifactInput(
	value: unknown,
	index: number,
): DynamicArtifactInput {
	if (typeof value === "string") {
		return {
			kind: "workflow-artifact-ref",
			name: requiredDynamicString(value, `inputs[${index}]`),
			required: true,
		};
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`ctx.agent() inputs[${index}] must be an artifact ref`);
	}
	const record = value as Record<string, unknown>;
	if (record.kind !== "workflow-artifact-ref") {
		throw new Error(
			`ctx.agent() inputs[${index}] must be a workflow artifact ref`,
		);
	}
	const options = isPlainDynamicRecord(record.options)
		? record.options
		: undefined;
	return {
		kind: "workflow-artifact-ref",
		name: requiredDynamicString(record.name, `inputs[${index}].name`),
		...(options ? { options } : {}),
		required: options?.required === false ? false : true,
	};
}

function isPlainDynamicRecord(
	value: unknown,
): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalDynamicBoolean(
	value: unknown,
	field: string,
): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") {
		throw new Error(`ctx.agent() ${field} must be a boolean`);
	}
	return value;
}

function optionalDynamicPositiveInteger(
	value: unknown,
	field: string,
): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new Error(`ctx.agent() ${field} must be a positive integer`);
	}
	return value;
}

function optionalDynamicThinking(value: unknown): ThinkingLevel | undefined {
	if (value === undefined) return undefined;
	if (
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh"
	) {
		return value;
	}
	throw new Error("ctx.agent() thinking has an unsupported value");
}

function dynamicTaskCapability(
	tools: string[] | undefined,
	toolProviders: Record<string, CompiledToolProvider> | undefined,
): TaskCapability {
	return classifyToolCapability(tools, toolProviders, true, {
		unspecifiedToolsCapability: "mutation-capable",
		emptyToolsCapability: "read-only",
	});
}

function appendDynamicOutputInstructions(
	prompt: string,
	outputProfile?: string,
	maxDigestChars = DYNAMIC_OUTPUT_MAX_DIGEST_CHARS,
	refsMinItems?: number,
): string {
	const refsExample =
		refsMinItems !== undefined && refsMinItems > 0
			? "<refs>[...]</refs>"
			: "<refs>[]</refs>";
	return [
		prompt,
		"# Workflow Output Protocol",
		"Return your final answer exactly as these three sections, in this order, with no prose outside the tags:",
		"<control>{...}</control>",
		"<analysis>...</analysis>",
		refsExample,
		"The <control> section must be valid JSON object data with non-empty string `schema` and `digest` fields.",
		`The control.digest string must be at most ${maxDigestChars} characters; prefer one short sentence.`,
		"Use schema `dynamic-task-result-v1` unless the dynamic controller asks for a more specific control schema.",
		refsMinItems !== undefined && refsMinItems > 0
			? `The <refs> JSON array must include at least ${refsMinItems} item${refsMinItems === 1 ? "" : "s"}. Include URLs or local file paths used by the analysis. Verify external URLs with fetch_content before including them; do not include stale, guessed, or unreachable URLs.`
			: undefined,
		dynamicOutputProfileInstructions(outputProfile),
	]
		.filter(Boolean)
		.join("\n\n");
}

function dynamicOutputProfileInstructions(
	outputProfile: string | undefined,
): string | undefined {
	if (!outputProfile) return undefined;
	if (outputProfile === "candidate_findings_v1") {
		return [
			"# Dynamic Output Profile: candidate_findings_v1",
			"Your <control> JSON should include `findings` as an array of candidate findings.",
			"Each finding should include stable `id`, `title` or `summary`, `severity`, `confidence`, and `evidenceRefs` when evidence exists.",
			"When using URL evidence, verify the URL with available tools before adding it to <refs> or evidenceRefs; put unreachable or uncertain sources in gaps instead of refs.",
			"Use `gaps`, `blockers`, `conflicts`, or `omissions` arrays for incomplete work instead of hiding it.",
		].join("\n");
	}
	if (outputProfile === "verification_result_v1") {
		return [
			"# Dynamic Output Profile: verification_result_v1",
			"Your <control> JSON must include `findingId` and `verdict`.",
			"`verdict` must be one of verified, rejected, weakened, or inconclusive.",
			"Check cited URL/source refs with available tools before returning verified or weakened; use inconclusive when source availability or support cannot be established.",
			"Include `confidence`, `evidenceRefs`, concise `notes`, and a `claimSupports` array when sources support or contradict the finding.",
			"Each `claimSupports` entry should include `claim`, `status` (supports, partial, contradicts, unsupported, inconclusive), `sourceLocators` with verified URL/path refs, and a short `excerpt` or `notes` explaining the support.",
		].join("\n");
	}
	if (outputProfile === "coverage_assessment_v1") {
		return [
			"# Dynamic Output Profile: coverage_assessment_v1",
			"Your <control> JSON should include `criteriaCoverage` or `coverage` as an array.",
			"Each entry should include `criterionId`, `status`, `evidenceRefs`, and `notes` when useful.",
		].join("\n");
	}
	if (outputProfile === "synthesis_v1") {
		return "# Dynamic Output Profile: synthesis_v1\nYour <control> JSON should include a compact final synthesis summary, caveats, and any remaining blockers or omissions. Final refs must come from verified upstream source ledgers; prefer sources with positive claimSupports and do not introduce new URL refs in synthesis.";
	}
	if (outputProfile === "generic_summary_v1") {
		return "# Dynamic Output Profile: generic_summary_v1\nYour <control> JSON may be a compact summary, but include gaps/blockers/omissions if the result needs manual review.";
	}
	return `# Dynamic Output Profile: ${outputProfile}\nEmit control JSON suitable for this output profile and surface gaps/blockers explicitly.`;
}

async function executeSupportTask(
	cwd: string,
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	compiledTask: CompiledWorkflow["tasks"][number],
): Promise<boolean> {
	if (!compiledTask.support) {
		throw new Error("support metadata is missing");
	}
	task.status = "running";
	task.statusDetail = "running";
	task.startedAt = task.startedAt ?? new Date().toISOString();
	await writeRunRecord(cwd, run);

	const sources = compiledTask.artifactGraph?.enabled
		? await readArtifactGraphSupportSources(
				cwd,
				run,
				compiledTask.dependsOn ?? [],
			)
		: await readSupportSources(cwd, run, compiledTask.dependsOn ?? []);
	const helperSpecPath = await workflowBundleSpecPath(cwd, run);
	const helper = await loadWorkflowHelper(
		compiledTask.support.uses,
		helperSpecPath,
	);
	const structuredOutput = await helper({
		sources,
		options: compiledTask.support.options,
		context: {
			specPath: helperSpecPath,
			originalSpecPath: run.specPath,
			stageId: task.stageId,
			taskId: task.taskId,
			runId: run.runId,
			cwd,
			...(compiledTask.artifactGraph?.enabled
				? {
						sourceStatuses: buildArtifactGraphSupportSourceStatuses(
							run,
							compiledTask.dependsOn ?? [],
						),
					}
				: {}),
		},
	});

	if (compiledTask.artifactGraph?.enabled) {
		await writeArtifactGraphSupportResult(cwd, task, structuredOutput);
		setTaskTerminal(task, "completed", "support_completed", {
			lastMessage: "support completed",
		});
		await writeRunRecord(cwd, run);
		return true;
	}

	await mkdir(dirname(fromProjectPath(cwd, task.files.output)), {
		recursive: true,
	});
	await writeFile(
		fromProjectPath(cwd, task.files.output),
		`${JSON.stringify(structuredOutput, null, 2)}\n`,
		"utf8",
	);
	await writeFile(fromProjectPath(cwd, task.files.stderr), "", "utf8");
	await writeJsonAtomic(fromProjectPath(cwd, task.files.result), {
		status: "completed",
		structuredOutput,
	});
	setTaskTerminal(task, "completed", "support_completed", {
		lastMessage: "support completed",
	});
	await writeRunRecord(cwd, run);
	return true;
}

async function workflowBundleFingerprint(
	cwd: string,
	run: WorkflowRunRecord,
): Promise<{ files: Array<{ path: string; hash: string }> } | undefined> {
	const bundleDir = join(workflowRunDir(cwd, run.runId), "bundle");
	const files = await listWorkflowBundleFiles(bundleDir).catch((error) => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	});
	if (!files) return undefined;
	return {
		files: await Promise.all(
			files.map(async (path) => ({
				path,
				hash: hashDynamicRequest(await readFile(join(bundleDir, path), "utf8")),
			})),
		),
	};
}

async function listWorkflowBundleFiles(
	root: string,
	dir = root,
): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await listWorkflowBundleFiles(root, path)));
		} else if (entry.isFile()) {
			files.push(relative(root, path).replaceAll("\\", "/"));
		}
	}
	return files.sort();
}

async function workflowBundleSpecPath(
	cwd: string,
	run: WorkflowRunRecord,
	options: { required?: boolean } = {},
): Promise<string> {
	const bundleDir = join(workflowRunDir(cwd, run.runId), "bundle");
	const candidateSpecPaths = [
		join(bundleDir, basename(run.specPath)),
		join(bundleDir, "spec.json"),
	];
	for (const artifactSpecPath of candidateSpecPaths) {
		try {
			if ((await stat(artifactSpecPath)).isFile()) return artifactSpecPath;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	if (options.required) {
		throw new Error(
			`workflow run bundle is required for dynamic workflow replay: ${run.runId}`,
		);
	}
	return run.specPath;
}

async function readSupportSources(
	cwd: string,
	run: WorkflowRunRecord,
	dependsOn: string[],
): Promise<Record<string, unknown>> {
	const sources: Record<string, unknown> = {};
	for (const specId of dependsOn) {
		const source = run.tasks.find((candidate) => candidate.specId === specId);
		if (!source || source.status !== "completed") continue;
		const result = await readJson<{ structuredOutput?: unknown }>(
			fromProjectPath(cwd, source.files.result),
		).catch(() => undefined);
		if (result && Object.hasOwn(result, "structuredOutput")) {
			sources[source.specId] = result.structuredOutput;
		} else {
			sources[source.specId] = (
				await readOutputText(cwd, source.files.output)
			).text;
		}
	}
	return sources;
}

function supportSourceNamesForDependencies(
	run: WorkflowRunRecord,
	dependsOn: readonly string[],
): Map<string, string> {
	const names = new Map<string, string>();
	const usedNames = new Set<string>();
	for (const specId of dependsOn) {
		const source = run.tasks.find((candidate) => candidate.specId === specId);
		if (!source) continue;
		names.set(source.specId, sourceNameForTask(source, usedNames));
	}
	return names;
}

async function readArtifactGraphSupportSources(
	cwd: string,
	run: WorkflowRunRecord,
	dependsOn: string[],
): Promise<Record<string, unknown>> {
	const sources: Record<string, unknown> = {};
	const sourceNames = supportSourceNamesForDependencies(run, dependsOn);
	for (const specId of dependsOn) {
		const source = run.tasks.find((candidate) => candidate.specId === specId);
		if (!source || source.status !== "completed") continue;
		sources[sourceNames.get(source.specId) ?? source.specId] =
			await readArtifactGraphControl(cwd, source);
	}
	return sources;
}

function buildArtifactGraphSupportSourceStatuses(
	run: WorkflowRunRecord,
	dependsOn: readonly string[],
): Array<Record<string, unknown>> {
	const statuses: Array<Record<string, unknown>> = [];
	const sourceNames = supportSourceNamesForDependencies(run, dependsOn);
	for (const specId of dependsOn) {
		const source = run.tasks.find((candidate) => candidate.specId === specId);
		if (!source) continue;
		statuses.push({
			source: sourceNames.get(source.specId) ?? source.specId,
			displayName: source.displayName,
			taskId: source.taskId,
			specId: source.specId,
			stageId: source.stageId,
			...sourceStatusForTask(source),
		});
	}
	return statuses;
}

function sourceStatusForTask(task: WorkflowTaskRunRecord): {
	status: string;
	statusDetail?: string;
	lastMessage?: string;
	errorType?: string;
} {
	const lastMessage = sanitizeSourceLastMessage(task.lastMessage);
	return {
		status: task.status,
		...(task.statusDetail ? { statusDetail: task.statusDetail } : {}),
		...(lastMessage ? { lastMessage } : {}),
		...(task.status !== "completed"
			? { errorType: sourceErrorType(task) }
			: {}),
	};
}

function sanitizeSourceLastMessage(
	value: string | undefined,
): string | undefined {
	const text = String(value ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return text ? text.slice(0, 500) : undefined;
}

function sourceErrorType(task: WorkflowTaskRunRecord): string {
	const detail = String(task.statusDetail ?? "").toLowerCase();
	const message = String(task.lastMessage ?? "").toLowerCase();
	if (/timeout|timed out/.test(detail) || /timeout|timed out/.test(message))
		return "timeout";
	if (
		/schema|validation|invalid/.test(detail) ||
		/schema|validation|invalid/.test(message)
	)
		return "schema_violation";
	if (/model|subagent/.test(detail) || /model|subagent/.test(message))
		return "model_failure";
	if (/skip|skipped/.test(task.status) || /skip|skipped/.test(detail))
		return "skipped";
	return task.status === "failed" ? "failed" : task.status;
}

async function writeArtifactGraphDynamicResult(
	cwd: string,
	task: WorkflowTaskRunRecord,
	structuredOutput: unknown,
	lifecycleStatus: "completed" | "failed" = "completed",
): Promise<void> {
	const { control, analysis, refs } =
		normalizeDynamicControllerOutput(structuredOutput);
	const rawOutput = [
		"<control>",
		JSON.stringify(control, null, 2),
		"</control>",
		"<analysis>",
		analysis,
		"</analysis>",
		"<refs>",
		JSON.stringify(refs, null, 2),
		"</refs>",
	].join("\n");
	await mkdir(dirname(fromProjectPath(cwd, task.files.output)), {
		recursive: true,
	});
	await writeFile(fromProjectPath(cwd, task.files.output), rawOutput, "utf8");
	await writeFile(fromProjectPath(cwd, task.files.stderr), "", "utf8");
	const written = await writeWorkflowTaskArtifactBundle({
		taskDir: dirname(fromProjectPath(cwd, task.files.result)),
		rawOutput,
		completedAt: new Date().toISOString(),
		lifecycleStatus,
		analysisRequired: task.artifactGraph?.output.analysisRequired ?? true,
		refsRequired: task.artifactGraph?.output.refsRequired ?? true,
		refsMinItems: task.artifactGraph?.output.refsMinItems,
		refsUrlValidation: task.artifactGraph?.output.refsUrlValidation,
		maxDigestChars: task.artifactGraph?.output.maxDigestChars,
		controlJsonSchema: await readTaskControlJsonSchema(task),
	});
	if (!written.valid) {
		throw new Error(
			`dynamic controller output failed workflow validation: ${written.parsed.issues
				.map((issue) => issue.message)
				.join("; ")}`,
		);
	}
}

async function writeArtifactGraphSupportResult(
	cwd: string,
	task: WorkflowTaskRunRecord,
	structuredOutput: unknown,
): Promise<void> {
	const control = normalizeSupportControl(structuredOutput);
	const analysis = supportOutputAnalysis(structuredOutput, control);
	const refs = supportOutputRefs(structuredOutput, control);
	const rawOutput = [
		"<control>",
		JSON.stringify(control, null, 2),
		"</control>",
		"<analysis>",
		analysis,
		"</analysis>",
		"<refs>",
		JSON.stringify(refs, null, 2),
		"</refs>",
	].join("\n");
	await mkdir(dirname(fromProjectPath(cwd, task.files.output)), {
		recursive: true,
	});
	await writeFile(fromProjectPath(cwd, task.files.output), rawOutput, "utf8");
	await writeFile(fromProjectPath(cwd, task.files.stderr), "", "utf8");
	const written = await writeWorkflowTaskArtifactBundle({
		taskDir: dirname(fromProjectPath(cwd, task.files.result)),
		rawOutput,
		completedAt: new Date().toISOString(),
		analysisRequired: task.artifactGraph?.output.analysisRequired ?? true,
		refsRequired: task.artifactGraph?.output.refsRequired ?? true,
		refsMinItems: task.artifactGraph?.output.refsMinItems,
		refsUrlValidation: task.artifactGraph?.output.refsUrlValidation,
		maxDigestChars: task.artifactGraph?.output.maxDigestChars,
		controlJsonSchema: await readTaskControlJsonSchema(task),
	});
	if (!written.valid) {
		throw new Error(
			`support control failed workflow output validation: ${written.parsed.issues
				.map((issue) => issue.message)
				.join("; ")}`,
		);
	}
}

async function readTaskControlJsonSchema(
	task: WorkflowTaskRunRecord,
): Promise<JsonSchema | undefined> {
	const schemaPath = task.artifactGraph?.output.controlSchemaPath;
	if (!schemaPath) return undefined;
	return JSON.parse(await readFile(schemaPath, "utf8")) as JsonSchema;
}

function normalizeDynamicControllerOutput(value: unknown): {
	control: Record<string, unknown>;
	analysis: string;
	refs: unknown[];
} {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const record = value as Record<string, unknown>;
		const rawControl =
			record.control &&
			typeof record.control === "object" &&
			!Array.isArray(record.control)
				? (record.control as Record<string, unknown>)
				: record;
		const analysis =
			typeof record.analysis === "string"
				? record.analysis
				: typeof rawControl.summary === "string"
					? rawControl.summary
					: "Dynamic controller completed.";
		return {
			control: {
				schema:
					typeof rawControl.schema === "string"
						? rawControl.schema
						: "dynamic-controller-result-v1",
				digest:
					typeof rawControl.digest === "string"
						? rawControl.digest
						: typeof rawControl.summary === "string"
							? rawControl.summary
							: "Dynamic controller completed.",
				...rawControl,
			},
			analysis,
			refs: Array.isArray(record.refs) ? record.refs : [],
		};
	}
	return {
		control: {
			schema: "dynamic-controller-result-v1",
			digest: "Dynamic controller completed.",
			value,
		},
		analysis: "Dynamic controller completed.",
		refs: [],
	};
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

function normalizeSupportControl(value: unknown): Record<string, unknown> {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const record = value as Record<string, unknown>;
		return {
			schema:
				typeof record.schema === "string" ? record.schema : "stage-control-v1",
			digest:
				typeof record.digest === "string"
					? record.digest
					: "Support helper completed.",
			...record,
		};
	}
	return {
		schema: "stage-control-v1",
		digest: "Support helper completed.",
		value,
	};
}

function supportOutputAnalysis(
	value: unknown,
	control: Record<string, unknown>,
): string {
	const record =
		value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	for (const candidate of [
		record?.analysis,
		record?.executiveMarkdown,
		record?.markdown,
		control.summary,
	]) {
		if (typeof candidate === "string" && candidate.trim()) {
			return candidate.trim();
		}
	}
	return "Support helper completed deterministically.";
}

function supportOutputRefs(
	value: unknown,
	control: Record<string, unknown>,
): unknown[] {
	const record =
		value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	if (Array.isArray(record?.refs)) return record.refs;
	if (Array.isArray(control.refs)) return control.refs;
	const urls = Array.isArray(record?.sourceUrls)
		? record.sourceUrls
		: Array.isArray(control.sourceUrls)
			? control.sourceUrls
			: [];
	return urls.filter((url): url is string => typeof url === "string");
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

async function prepareDagTask(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	index: number,
): Promise<CompiledWorkflow["tasks"][number]> {
	const compiledTask = compiledFlow.tasks[index]!;
	const task = run.tasks[index]!;
	const contextDependsOn =
		compiledTask.contextDependsOn ?? compiledTask.dependsOn ?? [];
	if (compiledTask.artifactGraph?.enabled) {
		return await prepareArtifactGraphTask(
			cwd,
			run,
			compiledTask,
			task,
			contextDependsOn,
		);
	}
	if (contextDependsOn.length === 0) return compiledTask;

	const bySpecId = new Map(
		run.tasks.map((sourceTask) => [sourceTask.specId, sourceTask]),
	);
	const sourceTasks = contextDependsOn
		.map((dep) => bySpecId.get(dep))
		.filter((sourceTask): sourceTask is WorkflowTaskRunRecord =>
			Boolean(sourceTask),
		);
	const missing = contextDependsOn.filter((dep) => !bySpecId.has(dep));
	const context = await buildRunSourceContext(
		cwd,
		run,
		sourceTasks,
		sourceContextOptions(compiledTask),
	);

	return {
		...compiledTask,
		cwd: task.cwd,
		compiledPrompt: [
			compiledTask.compiledPrompt,
			"# Source Stage Context",
			"Use this deterministic source context packet. Prefer structuredOutput over outputPreview. Do not assume dependencies beyond this explicit packet.",
			JSON.stringify({ ...context, missingDependencies: missing }, null, 2),
		].join("\n\n"),
	};
}

async function prepareArtifactGraphTask(
	cwd: string,
	run: WorkflowRunRecord,
	compiledTask: CompiledTask,
	task: WorkflowTaskRunRecord,
	contextDependsOn: readonly string[],
): Promise<CompiledTask> {
	const taskDir = dirname(fromProjectPath(cwd, task.files.result));
	const manifestPath = join(taskDir, "source-manifest.json");
	const ledgerPath = join(taskDir, "read-ledger.jsonl");
	const wrapperPath = join(taskDir, "workflow-artifact-extension.ts");
	const sources = await buildArtifactGraphSourceManifestSources(
		cwd,
		run,
		contextDependsOn,
		compiledTask.artifactGraph?.sourceProjection,
	);
	const manifest: WorkflowSourceManifest = {
		schema: WORKFLOW_SOURCE_MANIFEST_SCHEMA,
		runId: run.runId,
		taskId: task.taskId,
		sources,
		policy: { accessMode: "workflow-task" },
	};
	await writeJsonAtomic(manifestPath, manifest);
	await writeWorkflowArtifactExtensionWrapper({
		wrapperPath,
		importPath: workflowArtifactExtensionImportPath(),
		config: {
			runId: run.runId,
			taskId: task.taskId,
			manifestPath,
			ledgerPath,
			accessMode: "workflow-task",
			runDir: workflowRunDir(cwd, run.runId),
		},
	});

	const requiredReads = compiledTask.artifactGraph?.requiredReads ?? [];
	const requiredReadContext = formatRequiredArtifactReadReferences({
		sources,
		requiredReads,
	});
	return {
		...compiledTask,
		cwd: task.cwd,
		runtime: {
			...compiledTask.runtime,
			tools: uniqueStrings([
				...(compiledTask.runtime.tools ?? []),
				WORKFLOW_ARTIFACT_TOOL_NAME,
			]),
			toolProviders: {
				...(compiledTask.runtime.toolProviders ?? {}),
				[WORKFLOW_ARTIFACT_TOOL_NAME]: {
					classification: "read-only",
					extensions: [wrapperPath],
				},
			},
		},
		compiledPrompt: [
			compiledTask.compiledPrompt,
			formatArtifactGraphSourceContext(sources, requiredReads),
			requiredReadContext || undefined,
		]
			.filter(Boolean)
			.join("\n\n"),
	};
}

function formatRequiredArtifactReadReferences(options: {
	sources: WorkflowSourceManifestSource[];
	requiredReads: readonly string[];
}): string {
	if (options.requiredReads.length === 0) return "";
	const sections = options.requiredReads.map((required) => {
		const parsed = parseRequiredArtifactRead(required);
		if (!parsed) {
			return `- ${required}: invalid required read name; expected source.artifact.`;
		}
		const source = options.sources.find(
			(candidate) => candidate.source === parsed.source,
		);
		const artifact = source?.artifacts?.[parsed.artifact];
		if (!source || !artifact?.path) {
			return `- ${required}: required artifact is not available in the source manifest.`;
		}
		return `- ${required}: available via workflow_artifact read with source=${JSON.stringify(parsed.source)}, artifact=${JSON.stringify(parsed.artifact)}.`;
	});
	return [
		"# Required Workflow Artifact Reads",
		"The workflow runtime does not preload requiredReads into this prompt. To satisfy the required-read gate, call workflow_artifact for each listed source/artifact before producing the final answer. The read ledger, not this prompt, proves access.",
		...sections,
	].join("\n");
}

function parseRequiredArtifactRead(value: string): {
	source: string;
	artifact: keyof WorkflowSourceManifestSource["artifacts"];
} | null {
	const match = String(value).match(
		/^([A-Za-z0-9_.-]+)\.(control|analysis|refs|raw)$/,
	);
	if (!match) return null;
	return {
		source: match[1] ?? "",
		artifact: match[2] as keyof WorkflowSourceManifestSource["artifacts"],
	};
}

async function buildArtifactGraphSourceManifestSources(
	cwd: string,
	run: WorkflowRunRecord,
	contextDependsOn: readonly string[],
	projection?: NonNullable<CompiledTask["artifactGraph"]>["sourceProjection"],
): Promise<WorkflowSourceManifestSource[]> {
	const bySpecId = new Map(
		run.tasks.map((sourceTask) => [sourceTask.specId, sourceTask]),
	);
	const sources: WorkflowSourceManifestSource[] = [];
	const usedNames = new Set<string>();
	for (const dep of contextDependsOn) {
		const sourceTask = bySpecId.get(dep);
		if (!sourceTask) continue;
		const source = sourceNameForTask(sourceTask, usedNames);
		const status = sourceStatusForTask(sourceTask);
		if (sourceTask.status !== "completed") {
			sources.push({
				source,
				displayName: sourceTask.displayName,
				taskId: sourceTask.taskId,
				specId: sourceTask.specId,
				stageId: sourceTask.stageId,
				...status,
				artifacts: {},
			});
			continue;
		}
		const artifacts = await artifactRefsForTask(cwd, sourceTask);
		if (Object.keys(artifacts).length === 0) continue;
		const control = await readArtifactGraphControl(cwd, sourceTask).catch(
			() => undefined,
		);
		const controlProjection = projectArtifactGraphControl(control, projection);
		sources.push({
			source,
			displayName: sourceTask.displayName,
			taskId: sourceTask.taskId,
			specId: sourceTask.specId,
			stageId: sourceTask.stageId,
			...status,
			digest: controlDigest(control),
			...(controlProjection.value !== undefined
				? { controlProjection: controlProjection.value }
				: {}),
			...(controlProjection.missingPaths.length > 0
				? { projectionMissingPaths: controlProjection.missingPaths }
				: {}),
			...(controlProjection.truncated ? { projectionTruncated: true } : {}),
			artifacts,
		});
		await appendDynamicOutputSources({
			cwd,
			run,
			controllerTask: sourceTask,
			control,
			projection,
			sources,
			usedNames,
		});
	}
	return sources;
}

async function appendDynamicOutputSources(input: {
	cwd: string;
	run: WorkflowRunRecord;
	controllerTask: WorkflowTaskRunRecord;
	control: unknown;
	projection?: NonNullable<CompiledTask["artifactGraph"]>["sourceProjection"];
	sources: WorkflowSourceManifestSource[];
	usedNames: Set<string>;
}): Promise<void> {
	if (input.controllerTask.kind !== "dynamic") return;
	const outputTaskIds = dynamicOutputTaskSpecIds(input.control);
	if (outputTaskIds.length === 0) return;
	const bySpecId = new Map(
		input.run.tasks.map((sourceTask) => [sourceTask.specId, sourceTask]),
	);
	let outputIndex = 0;
	for (const outputTaskId of outputTaskIds) {
		const outputTask = bySpecId.get(outputTaskId);
		if (!outputTask) continue;
		const source = dynamicOutputSourceName(
			input.controllerTask,
			outputIndex,
			input.usedNames,
		);
		outputIndex += 1;
		const status = sourceStatusForTask(outputTask);
		if (outputTask.status !== "completed") {
			input.sources.push({
				source,
				displayName: outputTask.displayName,
				taskId: outputTask.taskId,
				specId: outputTask.specId,
				stageId: outputTask.stageId,
				...status,
				artifacts: {},
			});
			continue;
		}
		const artifacts = await artifactRefsForTask(input.cwd, outputTask);
		if (Object.keys(artifacts).length === 0) continue;
		const control = await readArtifactGraphControl(input.cwd, outputTask).catch(
			() => undefined,
		);
		const controlProjection = projectArtifactGraphControl(
			control,
			input.projection,
		);
		input.sources.push({
			source,
			displayName: outputTask.displayName,
			taskId: outputTask.taskId,
			specId: outputTask.specId,
			stageId: outputTask.stageId,
			...status,
			digest: controlDigest(control),
			...(controlProjection.value !== undefined
				? { controlProjection: controlProjection.value }
				: {}),
			...(controlProjection.missingPaths.length > 0
				? { projectionMissingPaths: controlProjection.missingPaths }
				: {}),
			...(controlProjection.truncated ? { projectionTruncated: true } : {}),
			artifacts,
		});
	}
}

function dynamicOutputTaskSpecIds(control: unknown): string[] {
	if (!control || typeof control !== "object" || Array.isArray(control)) {
		return [];
	}
	const record = control as Record<string, unknown>;
	return uniqueStrings([
		...stringArrayValue(record.outputTasks),
		...stringArrayValue(record.outputTaskIds),
		...stringArrayValue(record.exportedTasks),
	]);
}

function stringArrayValue(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function dynamicOutputSourceName(
	controllerTask: WorkflowTaskRunRecord,
	index: number,
	usedNames: Set<string>,
): string {
	const base = `${controllerTask.stageId ?? controllerTask.specId}.output${index === 0 ? "" : `.${index + 1}`}`;
	if (!usedNames.has(base)) {
		usedNames.add(base);
		return base;
	}
	let suffix = 2;
	while (usedNames.has(`${base}.${suffix}`)) suffix += 1;
	const source = `${base}.${suffix}`;
	usedNames.add(source);
	return source;
}

async function artifactRefsForTask(
	cwd: string,
	task: WorkflowTaskRunRecord,
): Promise<WorkflowSourceManifestSource["artifacts"]> {
	const taskDir = dirname(fromProjectPath(cwd, task.files.result));
	const candidates = {
		control: {
			path: join(taskDir, "control.json"),
			mediaType: "application/json",
		},
		analysis: {
			path: join(taskDir, "analysis.md"),
			mediaType: "text/markdown",
		},
		refs: { path: join(taskDir, "refs.json"), mediaType: "application/json" },
		raw: { path: join(taskDir, "raw.md"), mediaType: "text/markdown" },
	} as const;
	const artifacts: WorkflowSourceManifestSource["artifacts"] = {};
	for (const [kind, ref] of Object.entries(candidates)) {
		try {
			if ((await stat(ref.path)).isFile()) (artifacts as any)[kind] = ref;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return artifacts;
}

function controlDigest(control: unknown): string | undefined {
	return control && typeof (control as any).digest === "string"
		? (control as any).digest
		: undefined;
}

function projectArtifactGraphControl(
	control: unknown,
	projection:
		| NonNullable<CompiledTask["artifactGraph"]>["sourceProjection"]
		| undefined,
): { value?: unknown; missingPaths: string[]; truncated: boolean } {
	if (!projection?.include || projection.include.length === 0) {
		return { missingPaths: [], truncated: false };
	}
	const projected: Record<string, unknown> = {};
	const missingPaths: string[] = [];
	for (const path of projection.include) {
		const resolved = readSimpleJsonPath(control, path);
		if (resolved === undefined) {
			missingPaths.push(path);
			continue;
		}
		setProjectedJsonPath(projected, path, resolved);
	}
	const value = Object.keys(projected).length > 0 ? projected : undefined;
	return capArtifactGraphProjection(value, missingPaths, projection.maxChars);
}

function capArtifactGraphProjection(
	value: unknown,
	missingPaths: string[],
	maxChars: number | undefined,
): { value?: unknown; missingPaths: string[]; truncated: boolean } {
	if (value === undefined || maxChars === undefined) {
		return { value, missingPaths, truncated: false };
	}
	const serialized = JSON.stringify(value);
	if (serialized.length <= maxChars) {
		return { value, missingPaths, truncated: false };
	}
	return {
		value: {
			truncated: true,
			originalChars: serialized.length,
			preview: serialized.slice(0, Math.max(0, maxChars - 1)) + "…",
		},
		missingPaths,
		truncated: true,
	};
}

function setProjectedJsonPath(
	target: Record<string, unknown>,
	path: string,
	value: unknown,
): void {
	const tokens = path
		.replace(/^\$\.?/, "")
		.split(".")
		.map((token) => token.trim())
		.filter(Boolean);
	let current = target;
	for (const [index, token] of tokens.entries()) {
		if (index === tokens.length - 1) {
			current[token] = value;
			return;
		}
		const existing = current[token];
		if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
			current[token] = {};
		}
		current = current[token] as Record<string, unknown>;
	}
}

function sourceNameForTask(
	task: WorkflowTaskRunRecord,
	usedNames: Set<string>,
): string {
	const preferred = task.dynamicGenerated
		? task.specId
		: (task.stageId ?? task.specId);
	if (!usedNames.has(preferred)) {
		usedNames.add(preferred);
		return preferred;
	}
	usedNames.add(task.specId);
	return task.specId;
}

function formatArtifactGraphSourceContext(
	sources: readonly WorkflowSourceManifestSource[],
	requiredReads: readonly string[],
): string {
	return [
		"# Workflow Artifact Inputs",
		"Use workflow_artifact to list/read upstream workflow artifacts. Inline controlProjection fields are authoritative for the projected data they contain; use artifact reads for declared requiredReads, missing fields, or debug detail.",
		requiredReads.length > 0
			? [
					"Required reads before final output:",
					...requiredReads.map((read) => `- ${read}`),
				].join("\n")
			: "No hard requiredReads are declared for this stage.",
		"Available sources:",
		JSON.stringify(
			sources.map((source) => ({
				source: source.source,
				taskId: source.taskId,
				specId: source.specId,
				stageId: source.stageId,
				status: source.status,
				statusDetail: source.statusDetail,
				lastMessage: source.lastMessage,
				errorType: source.errorType,
				digest: source.digest,
				controlProjection: source.controlProjection,
				projectionMissingPaths: source.projectionMissingPaths,
				projectionTruncated: source.projectionTruncated,
				availableArtifacts: Object.keys(source.artifacts),
			})),
			null,
			2,
		),
	].join("\n\n");
}

function uniqueStrings(values: readonly string[]): string[] {
	return [...new Set(values.filter((value) => value.trim().length > 0))];
}

async function readArtifactGraphControl(
	cwd: string,
	task: WorkflowTaskRunRecord,
): Promise<unknown> {
	const taskDir = dirname(fromProjectPath(cwd, task.files.result));
	return await readJson(join(taskDir, "control.json"));
}

function workflowArtifactExtensionImportPath(): string {
	const current = fileURLToPath(import.meta.url);
	return fileURLToPath(
		new URL(
			`./workflow-artifact-extension${extname(current)}`,
			import.meta.url,
		),
	);
}

async function prepareArtifactGraphRetryTask(
	cwd: string,
	task: WorkflowTaskRunRecord,
	preparedTask: CompiledWorkflow["tasks"][number],
): Promise<CompiledWorkflow["tasks"][number]> {
	const invalidAttempt = task.outputRetry?.attempts
		? `${dirname(fromProjectPath(cwd, task.files.result))}/raw.invalid-attempt-${task.outputRetry.attempts}.md`
		: fromProjectPath(cwd, task.files.output);
	const previousOutput = await readFile(invalidAttempt, "utf8").catch(() => "");
	const issueText = task.outputRetry?.artifacts?.length
		? [
				"Your previous attempt did not read required workflow artifacts:",
				...task.outputRetry.artifacts.map((artifact) => `- ${artifact}`),
				"Use workflow_artifact before producing the final answer.",
			].join("\n")
		: (task.outputRetry?.message ?? "workflow output was invalid");

	return {
		...preparedTask,
		cwd: task.cwd,
		compiledPrompt: [
			preparedTask.compiledPrompt,
			"# Workflow Output Retry Instructions",
			issueText,
			"Return the final answer again using exactly <control>, <analysis>, and <refs> sections. The first byte must be '<' in <control>; do not include apologies, status text, Markdown headings, or prose outside the required sections.",
			"If the retry is for missing required workflow_artifact reads, use workflow_artifact before the final answer. Prefer projected reads with path/maxItems/maxChars when only a JSON slice is needed.",
			"# Previous Attempt Preview",
			previousOutput.slice(0, 4000) || "(empty or unavailable)",
		].join("\n\n"),
	};
}

function sourceContextOptions(
	task: Pick<CompiledTask, "sourceContext">,
): SourceContextPacketOptions {
	const sourceContext = task.sourceContext ?? {};
	return {
		maxPreviewChars:
			sourceContext.maxPreviewChars ?? SOURCE_CONTEXT_PREVIEW_CHARS,
		maxStructuredChars:
			sourceContext.maxStructuredChars ?? SOURCE_CONTEXT_STRUCTURED_CHARS,
		maxStructuredCharsByStage: sourceContext.maxStructuredCharsByStage,
		structuredOutputPathsByStage: sourceContext.structuredOutputPathsByStage,
		maxPacketChars:
			sourceContext.maxPacketChars ?? SOURCE_CONTEXT_MAX_PACKET_CHARS,
	};
}

export async function buildRunSourceContext(
	cwd: string,
	run: Pick<WorkflowRunRecord, "createdAt" | "updatedAt"> & {
		tasks: WorkflowTaskRunRecord[];
	},
	sourceTasks: WorkflowTaskRunRecord[],
	options: Pick<
		SourceContextPacketOptions,
		| "maxPreviewChars"
		| "maxStructuredChars"
		| "maxStructuredCharsByStage"
		| "structuredOutputPathsByStage"
		| "maxPacketChars"
	> = {},
): Promise<{
	telemetry: ReturnType<typeof summarizeWorkflowTelemetry>;
	packet: ReturnType<typeof buildSourceContextPacket>;
}> {
	const maxPreviewChars =
		options.maxPreviewChars ?? SOURCE_CONTEXT_PREVIEW_CHARS;
	const maxStructuredChars =
		options.maxStructuredChars ?? SOURCE_CONTEXT_STRUCTURED_CHARS;
	const maxPacketChars =
		options.maxPacketChars ?? SOURCE_CONTEXT_MAX_PACKET_CHARS;
	const structuredOutputsByTaskId: Record<string, unknown> = {};
	const rawOutputsByTaskId: Record<string, string> = {};
	const outputBytesByTaskId: Record<string, number> = {};

	await Promise.all(
		sourceTasks.map(async (task) => {
			const [result, output] = await Promise.all([
				readJson<{ structuredOutput?: unknown }>(
					fromProjectPath(cwd, task.files.result),
				).catch(() => undefined),
				readOutputText(cwd, task.files.output),
			]);
			if (result && Object.hasOwn(result, "structuredOutput"))
				structuredOutputsByTaskId[task.taskId] = result.structuredOutput;
			rawOutputsByTaskId[task.taskId] = output.text;
			outputBytesByTaskId[task.files.output] = output.bytes;
		}),
	);

	return {
		telemetry: summarizeWorkflowTelemetry(run, { outputBytesByTaskId }),
		packet: buildSourceContextPacket(
			{ tasks: sourceTasks },
			{
				structuredOutputsByTaskId,
				rawOutputsByTaskId,
				maxPreviewChars,
				maxStructuredChars,
				maxStructuredCharsByStage: options.maxStructuredCharsByStage,
				structuredOutputPathsByStage: options.structuredOutputPathsByStage,
				maxPacketChars,
			},
		),
	};
}

async function readOutputText(
	cwd: string,
	projectPath: string,
): Promise<{ text: string; bytes: number }> {
	try {
		const text = await readFile(fromProjectPath(cwd, projectPath), "utf8");
		return { text, bytes: Buffer.byteLength(text, "utf8") };
	} catch {
		return { text: "", bytes: 0 };
	}
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
