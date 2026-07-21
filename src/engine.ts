import { appendFile, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { compileWorkflow } from "./compiler.js";
import {
	assertPromptSchemaDiagnosticsAllowRun,
	buildPromptSchemaDiagnosticNotice,
	promptSchemaDiagnosticsApply,
	workflowPromptSchemaDiagnostics,
	type PromptSchemaDiagnosticsPolicy,
} from "./prompt-schema-diagnostics.js";
import { loadWorkflowSpec } from "./schema.js";
import {
	assertRunLeaseOwnership,
	assertWorkflowRunAvailable,
	createRunRecord,
	createTaskRunRecord,
	compiledWorkflowPath,
	FAIL_FAST_CANCELLED_STATUS_DETAIL,
	fromProjectPath,
	initializeRunRecordDirectories,
	isBlockedTaskResumableForResume,
	invalidateTaskForDependencyResume,
	isTerminalWorkflowStatus,
	isTerminalTaskStatus,
	listRunRecords,
	makeRunId,
	readJson,
	readRunRecord,
	readWorkflowStopIntent,
	requestWorkflowStop,
	resetTaskForResume,
	setTaskTerminal,
	clearWorkflowStopIntent,
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
import {
	createLaunchBootstrapProvenance,
	recordLaunchBootstrapProvenance,
} from "./launch-bootstrap-provenance.js";
import {
	createWorkflowLaunchAuthority,
	issueWorkflowLaunchAuthority,
} from "./launch-authority.js";
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
	auditDynamicClaimSupport,
	type DynamicAuditCollectedRefsInput,
	type DynamicAuditSynthesisInput,
} from "./dynamic-audit.js";
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
	canonicalForeachSourceLineage,
	dependenciesReady,
	foreachStreamingEnabled,
	foreachStreamingMinChunk,
	markDagDependentsSkipped,
	compiledTaskSpecId,
	markFailFastCancellations,
	nextTaskRecordIndex,
	reconcileDynamicGeneratedRunRecords,
	reconcileForeachGeneratedRunRecords,
	recoverStaleRunningDynamicControllers,
	removeForeachGeneratedTasksForPlaceholders,
	recoverStaleRunningSupportTasks,
	replaceDependencyList,
	sourceStageIdsForFrom,
	stageSourcePolicy,
	updateDownstreamDependencies,
	synchronizeTerminalBarrierSourceSpecIds,
} from "./engine-run-graph.js";
import {
	reconcileLoopTaskMaterialization,
	scheduleLoop,
} from "./loop-runtime.js";
import { acknowledgeSubagentTaskInterrupted } from "./subagent-backend.js";
import {
	createWorkflowStopSignal,
	isWorkflowStopRequestedError,
	throwIfWorkflowStopRequested,
} from "./workflow-stop.js";
import {
	assertArtifactGraphSourceRuntimeMetadataCurrent,
	createArtifactGraphRuntimeValidationSnapshot,
	type ArtifactGraphRuntimeValidationSnapshot,
	assertFinalCompiledPromptWithinCap,
	finalCompiledPromptMeasurement,
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
	hasFatalPartialOutputIssue,
	readWorkflowPartialOutputLedger,
	writeWorkflowPartialOutputLedgerFromFile,
	type WorkflowPartialOutputItem,
} from "./workflow-partial-output.js";
import {
	PER_ITEM_DISPATCH_ENV,
	workflowExperimentalFlagEnabled,
} from "./experimental-speed-flags.js";
import {
	type CompiledDynamicWorkflowTask,
	type CompiledTask,
	type CompiledWorkflow,
	WORKFLOW_RUN_TYPE,
	type WorkflowRunRecord,
	type WorkflowRunExecutionProfile,
	type WorkflowRunRouting,
	type WorkflowTaskRunRecord,
} from "./types.js";
import {
	clampTimeout,
	hasActiveSchedulerWork,
	isRefreshPollAggregateError,
	POLL_INTERVAL_MS,
	recordSupervisorError,
	refreshRun,
	refreshRunOrRecordPollError,
	schedulerPollDelayMs,
	shouldWatchRun,
	sleep,
	stillRunningAfterWaitMessage,
} from "./engine-wait.js";

export { buildRunSourceContext } from "./workflow-source-context-runtime.js";
export { evaluateLoopUntilCondition } from "./loop-runtime.js";
export type { DynamicWorkflowUi } from "./dynamic-controller-policy.js";
export { refreshRun } from "./engine-wait.js";
export {
	detectRunStall,
	formatHumanRunLaunch,
	formatHumanRunOutcome,
	formatHumanRunResume,
	formatHumanRunStop,
	formatLogs,
	formatRun,
	formatRunDetails,
	formatRawRunDetails,
	formatRunStallWarning,
	formatRunStatus,
	formatStatus,
	TASK_PROGRESS_STALL_MS,
} from "./engine-format.js";
export type { WorkflowRunStallInfo } from "./engine-format.js";

const MAX_SAME_LEASE_SCHEDULE_RESCANS = 8;
const MAX_CONCURRENCY = 16;
const DYNAMIC_CONTROLLER_ENGINE_CAPABILITIES = Object.freeze({
	decisionLoop: true,
});
const DYNAMIC_CONTROLLER_ENGINE_INTEGRITY_ERROR_MESSAGE =
	"incompatible or stale pi-workflow engine: dynamic controller context is missing runDecisionLoop (rebuild dist / reload workflow engine)";
const STOP_RUN_LEASE_WAIT_MS = 1_500;
const STOP_RUN_LEASE_RETRY_MS = 25;

type DynamicControllerTestHookContext = {
	cwd: string;
	runId: string;
	controllerSpecId: string;
	taskId: string;
};

type DynamicControllerTestHooks = {
	beforeControllerWorkerLaunch?: (
		context: DynamicControllerTestHookContext,
	) => void | Promise<void>;
	beforeDynamicResultCommit?: (
		context: DynamicControllerTestHookContext,
	) => void | Promise<void>;
};

let dynamicControllerTestHooks: DynamicControllerTestHooks = {};

export function setDynamicControllerHooksForTests(
	hooks: DynamicControllerTestHooks = {},
): void {
	dynamicControllerTestHooks = { ...hooks };
}
type ForeachMaterializationPersistenceBoundary =
	| "prepared-run-written"
	| "compiled-written"
	| "run-written";

let foreachMaterializationPersistenceHookForTests:
	| ((boundary: ForeachMaterializationPersistenceBoundary) => void | Promise<void>)
	| undefined;

export function setForeachMaterializationPersistenceHookForTests(
	hook:
		| ((
				boundary: ForeachMaterializationPersistenceBoundary,
		  ) => void | Promise<void>)
		| undefined,
): void {
	foreachMaterializationPersistenceHookForTests = hook;
}

const supervisorTimers = new Map<string, ReturnType<typeof setInterval>>();
const supervisorRunMtimes = new Map<string, number>();
const supervisorErrorCounts = new Map<string, number>();
const MAX_SUPERVISOR_CONSECUTIVE_ERRORS = 3;

export interface WorkflowRunOptions {
	task?: string;
	runtimeOverrides?: WorkflowRuntimeDefaults;
	runtimeDefaults?: WorkflowRuntimeDefaults;
	availableModels?: WorkflowModelInfo[];
	dynamicUi?: DynamicWorkflowUi;
	runId?: string;
	parentRunId?: string;
	/** Router-pass audit record persisted on the run record (opt-in --route). */
	routing?: WorkflowRunRouting;
	/**
	 * Overrides for inputs the workflow spec declares (for example depth).
	 * Keys the spec does not declare are ignored.
	 */
	inputOverrides?: Record<string, unknown>;
	/**
	 * Named execution profile declared in the spec's executionProfiles map.
	 * Applied as per-stage thinking overrides at compile time and recorded on
	 * the run record. Unknown names fail closed.
	 */
	executionProfile?: string;
}

interface WorkflowScheduleOptions {
	dynamicUi?: DynamicWorkflowUi;
	availableModels?: WorkflowModelInfo[];
}

export const WORKFLOW_PROMPT_SCHEMA_DIAGNOSTIC_SINK: unique symbol = Symbol(
	"workflowPromptSchemaDiagnosticSink",
);

type WorkflowRunDiagnosticOptions = WorkflowRunOptions & {
	[WORKFLOW_PROMPT_SCHEMA_DIAGNOSTIC_SINK]?: (
		notice: string,
		digest: string,
	) => void;
};

export async function runWorkflowSpec(
	specPath: string,
	cwd: string,
	options: WorkflowRunDiagnosticOptions = {},
): Promise<WorkflowRunRecord> {
	const loaded = await loadWorkflowSpec(specPath, cwd);
	return runLoadedWorkflowSpec(
		cwd,
		loaded.specPath,
		loaded.spec,
		options,
		"named-workflow",
	);
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
	return runLoadedWorkflowSpec(
		cwd,
		loaded.specPath,
		loaded.spec,
		options,
		"excluded-direct-dynamic",
		{
			mode: "direct-dynamic",
			requestedWorkflow: null,
			specPath: null,
			userSelectedWorkflow: false,
			generatedSpec: false,
			runtimeBundle: toProjectPath(cwd, loaded.specPath),
			runtimeVersion: DIRECT_DYNAMIC_RUNTIME_VERSION,
		},
	);
}

async function runLoadedWorkflowSpec(
	cwd: string,
	specPath: string,
	spec: Parameters<typeof compileWorkflow>[0],
	options: WorkflowRunDiagnosticOptions,
	diagnosticsPolicy: PromptSchemaDiagnosticsPolicy,
	provenance?: WorkflowRunRecord["provenance"],
): Promise<WorkflowRunRecord> {
	spec = applyDeclaredWorkflowInputOverrides(spec, options.inputOverrides);
	const appliedProfile = applyWorkflowExecutionProfile(
		spec,
		options.executionProfile,
	);
	spec = appliedProfile.spec;
	const compiled = await compileWorkflow(spec, {
		cwd,
		specPath,
		task: options.task,
		runtimeOverrides: options.runtimeOverrides,
		runtimeDefaults: options.runtimeDefaults,
		availableModels: options.availableModels,
	});

	// Diagnostics are an explicit named-workflow policy. Direct-dynamic uses its
	// approved runtime bundle and intentionally does not adopt named-spec warnings.
	if (promptSchemaDiagnosticsApply(diagnosticsPolicy)) {
		const diagnostics = workflowPromptSchemaDiagnostics(compiled);
		assertPromptSchemaDiagnosticsAllowRun(diagnostics);
		const notice = buildPromptSchemaDiagnosticNotice(diagnostics);
		if (notice) {
			// The digest is consumed as the stable identity of this one run-start
			// presentation. Resume reads the frozen compiled artifact and never
			// recompiles or re-enters this boundary, so no persistent sidecar is needed.
			const sink = options[WORKFLOW_PROMPT_SCHEMA_DIAGNOSTIC_SINK];
			if (sink) sink(notice.text, notice.digest);
			else process.stderr.write(`${notice.text}\n`);
		}
	}

	const runId = options.runId ?? makeRunId();
	await assertWorkflowRunAvailable(cwd, runId);
	const { run } = await createRunRecord(cwd, compiled, specPath, {
		runId,
		parentRunId: options.parentRunId,
		rootRunId: options.parentRunId,
		initialize: false,
	});
	if (provenance) run.provenance = provenance;
	if (options.routing) run.routing = options.routing;
	if (appliedProfile.record) run.executionProfile = appliedProfile.record;
	const initialized = await withRunLease(cwd, run.runId, async (leaseSignal) => {
		await assertRunLeaseOwnership(cwd, run.runId, leaseSignal);
		const existing = await readJson(workflowRunPath(cwd, run.runId));
		if (existing !== undefined) {
			throw new Error(
				`Cannot initialize workflow run ${run.runId}: a persisted run already exists`,
			);
		}
		await assertRunLeaseOwnership(cwd, run.runId, leaseSignal);
		await initializeRunRecordDirectories(cwd, run);
		await assertRunLeaseOwnership(cwd, run.runId, leaseSignal);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run, leaseSignal);
		const persisted = await readRunRecord(cwd, run.runId);
		if (
			persisted.runId !== run.runId ||
			persisted.createdAt !== run.createdAt
		) {
			throw new Error(
				`Cannot initialize workflow run ${run.runId}: persisted run identity changed`,
			);
		}
		return persisted;
	});
	if (!initialized) {
		throw new Error(
			`Could not acquire supervisor lease to initialize ${run.runId}; another supervisor may be active`,
		);
	}

	const scheduleOptions = {
		dynamicUi: options.dynamicUi,
		availableModels: options.availableModels,
	};
	const scheduled =
		(await scheduleRun(cwd, initialized.runId, compiled, scheduleOptions)) ??
		(await readRunRecord(cwd, initialized.runId));
	if (shouldWatchRun(scheduled))
		watchRun(cwd, scheduled.runId, scheduleOptions);
	return scheduled;
}

/**
 * Resolve a named execution profile into per-stage thinking overrides.
 * Explicit selection only: no profile name means no change; an unknown name
 * or a non-artifact-graph spec fails closed. An empty mapping is valid and
 * means "spec pins as written" (identity), which is still recorded.
 */
function applyWorkflowExecutionProfile<Spec>(
	spec: Spec,
	profileName: string | undefined,
): { spec: Spec; record?: WorkflowRunExecutionProfile } {
	if (!profileName) return { spec };
	const profiles = (
		spec as { executionProfiles?: Record<string, Record<string, string>> }
	).executionProfiles;
	const mapping = profiles?.[profileName];
	if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
		const available = Object.keys(profiles ?? {}).sort();
		throw new Error(
			available.length
				? `unknown execution profile "${profileName}"; spec declares: ${available.join(", ")}`
				: `unknown execution profile "${profileName}"; this workflow declares no executionProfiles`,
		);
	}
	const graph = (spec as { artifactGraph?: { stages?: unknown[] } })
		.artifactGraph;
	if (!graph || !Array.isArray(graph.stages)) {
		throw new Error(
			`execution profile "${profileName}" requires an artifact-graph workflow`,
		);
	}
	const applyToStages = (stages: unknown[]): unknown[] =>
		stages.map((stage) => {
			if (!stage || typeof stage !== "object" || Array.isArray(stage))
				return stage;
			const record = stage as Record<string, unknown>;
			const id = record.id;
			const override =
				typeof id === "string" ? mapping[id] : undefined;
			const nested =
				record.type === "dag" && Array.isArray(record.stages)
					? { stages: applyToStages(record.stages) }
					: {};
			if (override === undefined && !("stages" in nested)) return stage;
			return {
				...record,
				...(override === undefined ? {} : { thinking: override }),
				...nested,
			};
		});
	const nextSpec = {
		...(spec as Record<string, unknown>),
		artifactGraph: {
			...(graph as Record<string, unknown>),
			stages: applyToStages(graph.stages),
		},
	} as Spec;
	return {
		spec: nextSpec,
		record: {
			name: profileName,
			stageThinking: { ...mapping } as WorkflowRunExecutionProfile["stageThinking"],
		},
	};
}

function applyDeclaredWorkflowInputOverrides<Spec>(
	spec: Spec,
	overrides: Record<string, unknown> | undefined,
): Spec {
	if (!overrides) return spec;
	const input = (spec as { input?: unknown }).input;
	if (!input || typeof input !== "object" || Array.isArray(input)) return spec;
	const declared = Object.entries(overrides).filter(
		([key]) => key in (input as Record<string, unknown>),
	);
	if (declared.length === 0) return spec;
	return {
		...spec,
		input: {
			...(input as Record<string, unknown>),
			...Object.fromEntries(declared),
		},
	};
}

export async function waitForRun(
	cwd: string,
	runIdOrPrefix: string,
	timeoutMs?: number,
	options: WorkflowScheduleOptions = {},
): Promise<WorkflowRunRecord> {
	const timeout = clampTimeout(timeoutMs);
	const deadline = Date.now() + timeout;
	let run = await refreshRunOrRecordPollError(cwd, runIdOrPrefix);

	while (hasActiveSchedulerWork(run)) {
		const beforeScheduleRemaining = deadline - Date.now();
		if (beforeScheduleRemaining <= 0)
			throw new Error(await stillRunningAfterWaitMessage(cwd, run, timeout));
		const scheduled = await scheduleRun(cwd, run.runId, undefined, options);
		if (scheduled) run = scheduled;
		if (!hasActiveSchedulerWork(run)) return run;
		run = await refreshRunOrRecordPollError(cwd, run.runId, run);
		if (!hasActiveSchedulerWork(run)) return run;
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			throw new Error(await stillRunningAfterWaitMessage(cwd, run, timeout));
		}
		await sleep(schedulerPollDelayMs(run, remaining));
		run = await refreshRunOrRecordPollError(cwd, run.runId, run);
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

function assertBlockedRunResumable(run: WorkflowRunRecord): void {
	if (run.status !== "blocked") return;
	const blockers = run.tasks.filter(
		(task) =>
			task.status === "blocked" && !isBlockedTaskResumableForResume(task),
	);
	if (blockers.length === 0) return;
	const details = blockers
		.slice(0, 3)
		.map((task) => `${task.specId} statusDetail=${task.statusDetail}`)
		.join(", ");
	throw new Error(
		`Cannot resume blocked run ${run.runId}: non-resumable blocked task(s): ${details}. Resolve the attention/approval blocker before resuming.`,
	);
}

type StopRunConfirmation = {
	stopped?: StopRunSummary;
	latest: WorkflowRunRecord;
};

async function confirmStopRunUntil(
	cwd: string,
	runId: string,
	deadline: number,
	latest: WorkflowRunRecord,
): Promise<StopRunConfirmation> {
	if (Date.now() > deadline) return { latest };
	const stopped = await finalizeStopRunWithLease(cwd, runId);
	if (stopped) return { stopped, latest: stopped.run };
	const refreshed = await readRunRecord(cwd, runId).catch(() => latest);
	const intentPending = await readWorkflowStopIntent(cwd, runId);
	if (!hasActiveSchedulerWork(refreshed) && !intentPending) {
		return { latest: refreshed };
	}
	await sleep(STOP_RUN_LEASE_RETRY_MS);
	return confirmStopRunUntil(cwd, runId, deadline, refreshed);
}

export async function stopRun(
	cwd: string,
	runIdOrPrefix: string,
): Promise<StopRunSummary> {
	const current = await readRunRecord(cwd, runIdOrPrefix);
	if (isTerminalWorkflowStatus(current.status)) {
		throw new Error(
			`stop requires a non-terminal run; ${current.runId} is ${current.status}`,
		);
	}
	await requestWorkflowStop(cwd, current.runId);
	const confirmation = await confirmStopRunUntil(
		cwd,
		current.runId,
		Date.now() + STOP_RUN_LEASE_WAIT_MS,
		current,
	);
	if (confirmation.stopped) return confirmation.stopped;
	const latest = await readRunRecord(cwd, current.runId).catch(
		() => confirmation.latest,
	);
	if (
		hasActiveSchedulerWork(latest) ||
		(await readWorkflowStopIntent(cwd, current.runId))
	) {
		throw new Error(
			`Workflow stop requested for ${current.runId}, but active work or descendant workflow stop could not be confirmed within ${STOP_RUN_LEASE_WAIT_MS}ms; stop intent remains durable and cancellation is still pending`,
		);
	}
	return { run: latest, interruptedTaskIds: [] };
}

type DescendantStopResult = {
	pendingRunIds: string[];
	errors: string[];
};

type DescendantRunRecord = {
	run: WorkflowRunRecord;
	depth: number;
};

async function listRegisteredDynamicChildRunIds(
	cwd: string,
	parentRunId: string,
): Promise<string[]> {
	const runIds = new Set<string>();
	for (const event of await readDynamicEvents(cwd, parentRunId)) {
		if (event.type !== "workflow.started") continue;
		const runId = optionalEventString(event.payload.runId);
		if (!runId) continue;
		if (
			runId.length > 128 ||
			!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)
		) {
			throw new Error(
				`invalid nested workflow run id registered by ${parentRunId}`,
			);
		}
		if (runId !== parentRunId) runIds.add(runId);
	}
	return [...runIds];
}

async function listDescendantRunRecords(
	cwd: string,
	parentRunId: string,
	excludedRunIds: ReadonlySet<string> = new Set([parentRunId]),
): Promise<DescendantRunRecord[]> {
	const records = await listRunRecords(cwd);
	const byParent = new Map<string, WorkflowRunRecord[]>();
	for (const run of records) {
		if (!run.parentRunId || excludedRunIds.has(run.runId)) continue;
		const siblings = byParent.get(run.parentRunId) ?? [];
		siblings.push(run);
		byParent.set(run.parentRunId, siblings);
	}
	const descendants: DescendantRunRecord[] = [];
	const visited = new Set<string>([...excludedRunIds, parentRunId]);
	const queue: Array<{ runId: string; depth: number }> = [
		{ runId: parentRunId, depth: 0 },
	];
	while (queue.length > 0 && visited.size <= records.length + 1) {
		const current = queue.shift();
		if (!current) break;
		for (const child of byParent.get(current.runId) ?? []) {
			if (visited.has(child.runId)) continue;
			visited.add(child.runId);
			const depth = current.depth + 1;
			descendants.push({ run: child, depth });
			queue.push({ runId: child.runId, depth });
		}
	}
	return descendants;
}

async function clearTerminalWorkflowStopIntentIfPresent(
	cwd: string,
	run: WorkflowRunRecord,
): Promise<boolean> {
	if (!isTerminalWorkflowStatus(run.status)) return false;
	if (!(await readWorkflowStopIntent(cwd, run.runId))) return false;
	await clearWorkflowStopIntent(cwd, run.runId);
	return true;
}

async function cascadeWorkflowStopToDescendants(
	cwd: string,
	parentRunId: string,
	excludedRunIds: ReadonlySet<string> = new Set([parentRunId]),
): Promise<DescendantStopResult> {
	const errors: string[] = [];
	const pendingRunIds = new Set<string>();
	const registeredChildRunIds = new Set(
		(await listRegisteredDynamicChildRunIds(cwd, parentRunId)).filter(
			(runId) => !excludedRunIds.has(runId),
		),
	);
	// A workflow.started event durably reserves the child run id before run.json
	// exists. Fence every registered id first so a concurrent nested launch sees
	// its own stop intent during its first scheduler pass.
	for (const runId of registeredChildRunIds) {
		try {
			await requestWorkflowStop(cwd, runId);
		} catch (error) {
			pendingRunIds.add(runId);
			errors.push(
				`${runId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	const descendants = await listDescendantRunRecords(
		cwd,
		parentRunId,
		excludedRunIds,
	);
	const activeDescendants = descendants.filter(
		({ run }) => !isTerminalWorkflowStatus(run.status),
	);
	for (const { run } of activeDescendants) {
		if (registeredChildRunIds.has(run.runId)) continue;
		try {
			await requestWorkflowStop(cwd, run.runId);
		} catch (error) {
			pendingRunIds.add(run.runId);
			errors.push(
				`${run.runId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	for (const { run } of [...activeDescendants].sort(
		(a, b) => b.depth - a.depth,
	)) {
		try {
			const stopped = await finalizeStopRunWithLease(
				cwd,
				run.runId,
				excludedRunIds,
			);
			if (!stopped) pendingRunIds.add(run.runId);
		} catch (error) {
			pendingRunIds.add(run.runId);
			errors.push(
				`${run.runId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	for (const { run } of await listDescendantRunRecords(
		cwd,
		parentRunId,
		excludedRunIds,
	)) {
		if (!isTerminalWorkflowStatus(run.status)) {
			pendingRunIds.add(run.runId);
			continue;
		}
		try {
			await clearTerminalWorkflowStopIntentIfPresent(cwd, run);
		} catch (error) {
			pendingRunIds.add(run.runId);
			errors.push(
				`${run.runId}: terminal stop-intent cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return { pendingRunIds: [...pendingRunIds], errors };
}

function descendantStopPendingMessage(
	runId: string,
	result: DescendantStopResult,
): string {
	const pending = result.pendingRunIds.slice(0, 5).join(", ");
	const suffix = result.pendingRunIds.length > 5 ? ", …" : "";
	const errors =
		result.errors.length > 0 ? `; errors: ${result.errors.join("; ")}` : "";
	return `Workflow stop for ${runId} is waiting for descendant workflow run(s) to stop: ${pending}${suffix}${errors}`;
}

async function finalizeStopRunWithLease(
	cwd: string,
	runId: string,
	stoppingRunIds: ReadonlySet<string> = new Set(),
): Promise<StopRunSummary | undefined> {
	if (stoppingRunIds.has(runId)) return undefined;
	const nextStoppingRunIds = new Set(stoppingRunIds);
	nextStoppingRunIds.add(runId);
	const descendantStop = await cascadeWorkflowStopToDescendants(
		cwd,
		runId,
		nextStoppingRunIds,
	);
	if (descendantStop.errors.length > 0) {
		throw new Error(descendantStopPendingMessage(runId, descendantStop));
	}
	if (descendantStop.pendingRunIds.length > 0) return undefined;
	return await withRunLease(cwd, runId, async () => {
		const run = await readRunRecord(cwd, runId);
		if (isTerminalWorkflowStatus(run.status)) {
			await clearTerminalWorkflowStopIntentIfPresent(cwd, run);
			return { run, interruptedTaskIds: [] };
		}
		for (const task of run.tasks) {
			if (task.status !== "running") continue;
			task.statusDetail = "cancellation_pending";
			task.lastMessage = "awaiting backend stop cancellation acknowledgement";
		}
		await writeRunRecord(cwd, run);
		let cleanupError: unknown;
		try {
			await resolveWorkflowBackend(run).cleanupRun(cwd, run);
		} catch (error) {
			cleanupError = error;
		}
		const interruptedTaskIds = markRunStopped(run);
		await writeRunRecord(cwd, run);
		if (cleanupError) {
			throw new Error(
				`Workflow stop could not confirm cancellation for ${run.runId}; worker state remains observable`,
				{ cause: cleanupError },
			);
		}
		await clearWorkflowStopIntent(cwd, run.runId);
		unwatchRun(cwd, run.runId);
		return { run, interruptedTaskIds };
	});
}

async function finalizeStopIntentIfRequested(
	cwd: string,
	run: WorkflowRunRecord,
): Promise<boolean> {
	if (!(await readWorkflowStopIntent(cwd, run.runId))) return false;
	const descendantStop = await cascadeWorkflowStopToDescendants(cwd, run.runId);
	for (const task of run.tasks) {
		if (task.status !== "running") continue;
		task.statusDetail = "cancellation_pending";
		task.lastMessage = "awaiting backend stop cancellation acknowledgement";
	}
	if (
		descendantStop.pendingRunIds.length > 0 ||
		descendantStop.errors.length > 0
	) {
		await writeRunRecord(cwd, run);
		return true;
	}
	await writeRunRecord(cwd, run);
	await resolveWorkflowBackend(run).cleanupRun(cwd, run);
	const interruptedTaskIds = markRunStopped(run);
	if (interruptedTaskIds.length > 0) await writeRunRecord(cwd, run);
	await clearWorkflowStopIntent(cwd, run.runId);
	unwatchRun(cwd, run.runId);
	return true;
}

function markRunStopped(run: WorkflowRunRecord): string[] {
	const interruptedTaskIds: string[] = [];
	for (const task of run.tasks) {
		if (
			task.status === "running" &&
			task.statusDetail === "cancellation_failed"
		)
			continue;
		if (
			setTaskTerminal(task, "interrupted", "workflow_stopped", {
				exitCode: 130,
				lastMessage: "Workflow stopped by user request",
			})
		) {
			interruptedTaskIds.push(task.taskId);
		}
	}
	return interruptedTaskIds;
}
type ForeachInvalidationGroupSnapshot = {
	placeholderSpecId: string;
	parentTaskId: string;
	dispatchMap: NonNullable<WorkflowTaskRunRecord["dispatchMap"]>;
	compiledChildren: CompiledTask[];
	runChildren: WorkflowTaskRunRecord[];
};

type InvalidationTaskOwnership = {
	taskId: string;
	specId: string;
};

export type ResumeDependencyInvalidationPlan = {
	generation: number;
	idempotencyKey: string;
	sourceTaskIds: string[];
	invalidatedTaskIds: string[];
	foreachGroups: ForeachInvalidationGroupSnapshot[];
	taskOwnership: InvalidationTaskOwnership[];
	unaffectedRunSignature: string;
	unaffectedCompiledSignature: string;
};
function assertResumeLeaseActive(signal: AbortSignal): void {
	if (!signal.aborted) return;
	const reason = (signal as AbortSignal & { reason?: unknown }).reason;
	if (reason instanceof Error) throw reason;
	throw new Error(
		reason === undefined
			? "Lost supervisor lease"
			: `Lost supervisor lease: ${String(reason)}`,
	);
}

async function resumeLeaseMutation<T>(
	cwd: string,
	runId: string,
	signal: AbortSignal,
	mutation: () => Promise<T>,
): Promise<T> {
	assertResumeLeaseActive(signal);
	await assertRunLeaseOwnership(cwd, runId, signal);
	const result = await mutation();
	assertResumeLeaseActive(signal);
	await assertRunLeaseOwnership(cwd, runId, signal);
	return result;
}


function dependencyResumeInvalidationEnabled(
	compiledTask: CompiledTask | undefined,
	runTask: WorkflowTaskRunRecord | undefined,
): boolean {
	return (
		compiledTask?.artifactGraph?.inputPolicy?.invalidateOnDependencyResume ===
			true ||
		runTask?.artifactGraph?.inputPolicy?.invalidateOnDependencyResume === true
	);
}

function hasDurableDependencyInvalidationState(
	task: WorkflowTaskRunRecord,
): boolean {
	return (
		task.status === "running" ||
		task.status === "completed" ||
		task.status === "failed" ||
		task.status === "interrupted"
	);
}

function logicalDependencySpecIdsForResume(
	run: WorkflowRunRecord,
	compiledBySpecId: ReadonlyMap<string, CompiledTask>,
): Map<string, string[]> {
	const runTaskById = new Map<string, WorkflowTaskRunRecord>();
	const runTaskBySpecId = new Map<string, WorkflowTaskRunRecord>();
	for (const task of run.tasks) {
		if (runTaskById.has(task.taskId) || runTaskBySpecId.has(task.specId)) {
			throw new Error(
				`Cannot prepare dependency invalidation for ${run.runId}: task identity is ambiguous`,
			);
		}
		runTaskById.set(task.taskId, task);
		runTaskBySpecId.set(task.specId, task);
	}

	const dependenciesBySpecId = new Map<string, string[]>();
	for (const task of run.tasks) {
		const compiledTask = compiledBySpecId.get(task.specId);
		if (!compiledTask) {
			throw new Error(
				`Cannot prepare dependency invalidation for ${run.runId}: compiled task ${task.specId} is missing`,
			);
		}
		const dependencies = new Set([
			...(compiledTask.dependsOn ?? []),
			...(compiledTask.contextDependsOn ?? []),
			...(task.dependsOn ?? []),
		]);
		const sourceTaskId = task.foreachGenerated?.itemSourceTaskId;
		const sourceSpecId = task.foreachGenerated?.itemSourceSpecId;
		if (sourceTaskId !== undefined || sourceSpecId !== undefined) {
			if (
				typeof sourceTaskId !== "string" ||
				sourceTaskId === "" ||
				typeof sourceSpecId !== "string" ||
				sourceSpecId === ""
			) {
				throw new Error(
					`Cannot prepare dependency invalidation for ${run.runId}: foreach source identity is incomplete for ${task.specId}`,
				);
			}
			const sourceTask = runTaskById.get(sourceTaskId);
			if (!sourceTask || sourceTask.specId !== sourceSpecId) {
				throw new Error(
					`Cannot prepare dependency invalidation for ${run.runId}: foreach source identity is invalid for ${task.specId}`,
				);
			}
			dependencies.add(sourceSpecId);
		}
		dependenciesBySpecId.set(task.specId, [...dependencies]);
	}
	return dependenciesBySpecId;
}
function cloneInvalidationSnapshot<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function sameForeachInvalidationChild(
	compiledTask: CompiledTask,
	runTask: WorkflowTaskRunRecord,
	placeholderSpecId: string,
): boolean {
	const compiled = compiledTask.foreachGenerated;
	const persisted = runTask.foreachGenerated;
	return (
		compiledTask.id === compiledTaskSpecId(compiledTask) &&
		runTask.specId === compiledTask.id &&
		compiledTask.sourceGeneration === runTask.sourceGeneration &&
		compiled?.placeholderSpecId === placeholderSpecId &&
		persisted?.placeholderSpecId === placeholderSpecId &&
		compiled?.itemIdentity === persisted?.itemIdentity &&
		compiled?.itemHash === persisted?.itemHash &&
		compiled?.itemSourceTaskId === persisted?.itemSourceTaskId &&
		compiled?.itemSourceSpecId === persisted?.itemSourceSpecId &&
		compiled?.itemSourceKind === persisted?.itemSourceKind &&
		compiled?.itemRef === persisted?.itemRef &&
		compiled?.sourceLineageDigest === persisted?.sourceLineageDigest &&
		compiled?.resolvedTaskId === persisted?.resolvedTaskId &&
		compiled?.perItemDispatch === persisted?.perItemDispatch
	);
}
type ForeachInvalidationOwnership = {
	placeholderSpecIds: Set<string>;
	sourceSpecIds: Set<string>;
};


function foreachInvalidationOwnership(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	logicalDependenciesBySpecId: ReadonlyMap<string, readonly string[]>,
	resumableSourceSpecIds: ReadonlySet<string>,
): ForeachInvalidationOwnership {
	const compiledBySpecId = new Map<string, CompiledTask>();
	for (const task of compiledFlow.tasks) {
		const specId = compiledTaskSpecId(task);
		if (compiledBySpecId.has(specId)) {
			throw new Error(
				`Cannot prepare dependency invalidation for ${run.runId}: compiled task identity is ambiguous`,
			);
		}
		compiledBySpecId.set(specId, task);
	}
	const runBySpecId = new Map<string, WorkflowTaskRunRecord>();
	for (const task of run.tasks) {
		if (runBySpecId.has(task.specId)) {
			throw new Error(
				`Cannot prepare dependency invalidation for ${run.runId}: task ${task.specId} is ambiguous`,
			);
		}
		runBySpecId.set(task.specId, task);
	}

	const dependenciesBySpecId = new Map<string, Set<string>>();
	for (const [specId, compiledTask] of compiledBySpecId) {
		dependenciesBySpecId.set(
			specId,
			new Set([
				...(compiledTask.dependsOn ?? []),
				...(compiledTask.contextDependsOn ?? []),
				...(typeof compiledTask.foreachGenerated?.itemSourceSpecId === "string"
					? [compiledTask.foreachGenerated.itemSourceSpecId]
					: []),
			]),
		);
	}
	for (const [specId, dependencies] of logicalDependenciesBySpecId) {
		const current = dependenciesBySpecId.get(specId) ?? new Set<string>();
		for (const dependency of dependencies) current.add(dependency);
		dependenciesBySpecId.set(specId, current);
	}
	const dependentsBySpecId = new Map<string, string[]>();
	for (const [specId, dependencies] of dependenciesBySpecId) {
		for (const dependency of dependencies) {
			const dependents = dependentsBySpecId.get(dependency) ?? [];
			dependents.push(specId);
			dependentsBySpecId.set(dependency, dependents);
		}
	}

	const placeholderSpecIds = new Set<string>();
	const sourceSpecIds = new Set<string>();
	const recordOwnership = (
		placeholderSpecId: string | undefined,
		compiledTask: CompiledTask | undefined,
		runTask: WorkflowTaskRunRecord | undefined,
		sourceSpecId: string,
	): void => {
		if (
			!placeholderSpecId ||
			!dependencyResumeInvalidationEnabled(compiledTask, runTask)
		)
			return;
		placeholderSpecIds.add(placeholderSpecId);
		sourceSpecIds.add(sourceSpecId);
	};

	for (const sourceSpecId of resumableSourceSpecIds) {
		const reachable = new Set<string>([sourceSpecId]);
		const pending = [sourceSpecId];
		while (pending.length > 0) {
			const specId = pending.pop()!;
			for (const dependentSpecId of dependentsBySpecId.get(specId) ?? []) {
				if (reachable.has(dependentSpecId)) continue;
				reachable.add(dependentSpecId);
				pending.push(dependentSpecId);
			}
		}
		for (const specId of reachable) {
			const compiledTask = compiledBySpecId.get(specId);
			const runTask = runBySpecId.get(specId);
			if (compiledTask?.foreach) {
				recordOwnership(specId, compiledTask, runTask, sourceSpecId);
			}
			recordOwnership(
				compiledTask?.foreachGenerated?.placeholderSpecId ??
					runTask?.foreachGenerated?.placeholderSpecId,
				compiledTask,
				runTask,
				sourceSpecId,
			);
		}
		const sourceTaskId = runBySpecId.get(sourceSpecId)?.taskId;
		if (!sourceTaskId) continue;
		for (const task of run.tasks) {
			if (task.dispatchMap?.sourceTaskId !== sourceTaskId) continue;
			recordOwnership(
				task.specId,
				compiledBySpecId.get(task.specId),
				task,
				sourceSpecId,
			);
		}
	}
	return { placeholderSpecIds, sourceSpecIds };
}

function foreachInvalidationGroups(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	affectedSpecIds: ReadonlySet<string>,
	ownedPlaceholderSpecIds: ReadonlySet<string> = new Set<string>(),
): ForeachInvalidationGroupSnapshot[] {
	const runBySpecId = new Map<string, WorkflowTaskRunRecord>();
	const runByTaskId = new Map<string, WorkflowTaskRunRecord>();
	for (const task of run.tasks) {
		if (
			runBySpecId.has(task.specId) ||
			runByTaskId.has(task.taskId) ||
			typeof task.taskId !== "string" ||
			task.taskId === ""
		) {
			throw new Error(
				`Cannot prepare dependency invalidation for ${run.runId}: run task identity is ambiguous`,
			);
		}
		runBySpecId.set(task.specId, task);
		runByTaskId.set(task.taskId, task);
	}
	const compiledBySpecId = new Map<string, CompiledTask>();
	for (const task of compiledFlow.tasks) {
		const specId = compiledTaskSpecId(task);
		if (compiledBySpecId.has(specId)) {
			throw new Error(
				`Cannot prepare dependency invalidation for ${run.runId}: compiled task identity is ambiguous`,
			);
		}
		compiledBySpecId.set(specId, task);
	}

	const placeholderSpecIds = new Set<string>(ownedPlaceholderSpecIds);
	for (const [specId, compiledTask] of compiledBySpecId) {
		if (compiledTask.foreach && affectedSpecIds.has(specId))
			placeholderSpecIds.add(specId);
	}
	for (const task of run.tasks) {
		const placeholderSpecId = task.foreachGenerated?.placeholderSpecId;
		if (placeholderSpecId && affectedSpecIds.has(task.specId))
			placeholderSpecIds.add(placeholderSpecId);
	}

	const groups: ForeachInvalidationGroupSnapshot[] = [];
	for (const placeholderSpecId of [...placeholderSpecIds].sort()) {
		const compiledParent = compiledBySpecId.get(placeholderSpecId);
		const parent = runBySpecId.get(placeholderSpecId);
		const compiledChildren = compiledFlow.tasks.filter(
			(task) =>
				task.foreachGenerated?.placeholderSpecId === placeholderSpecId,
		);
		const runChildren = run.tasks.filter(
			(task) =>
				task.foreachGenerated?.placeholderSpecId === placeholderSpecId,
		);
		if (compiledChildren.length === 0 && runChildren.length === 0) continue;
		if (
			!compiledParent?.foreach ||
			!parent ||
			(!affectedSpecIds.has(placeholderSpecId) &&
				!ownedPlaceholderSpecIds.has(placeholderSpecId)) ||
			foreachStreamingEnabled(compiledParent) ||
			compiledParent.foreach.itemIdentityPath === undefined ||
			!parent.dispatchMap
		) {
			throw new Error(
				`Cannot resume dependency invalidation for ${run.runId}: it crosses foreach group ${placeholderSpecId} without transactional rematerialization`,
			);
		}
		if (
			compiledChildren.length !== runChildren.length ||
			compiledChildren.length !== parent.dispatchMap.entries.length
		) {
			throw new Error(
				`Cannot resume dependency invalidation for ${run.runId}: foreach group ${placeholderSpecId} has a partial child set`,
			);
		}
		const runChildBySpecId = new Map(
			runChildren.map((task) => [task.specId, task]),
		);
		if (runChildBySpecId.size !== runChildren.length) {
			throw new Error(
				`Cannot resume dependency invalidation for ${run.runId}: foreach group ${placeholderSpecId} is ambiguous`,
			);
		}
		for (const compiledChild of compiledChildren) {
			const child = runChildBySpecId.get(compiledTaskSpecId(compiledChild));
			if (
				!child ||
				!sameForeachInvalidationChild(
					compiledChild,
					child,
					placeholderSpecId,
				)
			) {
				throw new Error(
					`Cannot resume dependency invalidation for ${run.runId}: foreach group ${placeholderSpecId} does not have exact child membership`,
				);
			}
		}
		assertArtifactGraphSourceRuntimeMetadataCurrent(
			run,
			parent,
			createArtifactGraphRuntimeValidationSnapshot(run),
		);
		groups.push({
			placeholderSpecId,
			parentTaskId: parent.taskId,
			dispatchMap: cloneInvalidationSnapshot(parent.dispatchMap),
			compiledChildren: cloneInvalidationSnapshot(compiledChildren),
			runChildren: cloneInvalidationSnapshot(runChildren),
		});
	}
	return groups;
}

function invalidationIdempotencyKey(
	generation: number,
	sourceTaskIds: readonly string[],
	invalidatedTaskIds: readonly string[],
	foreachGroups: readonly ForeachInvalidationGroupSnapshot[],
): string {
	return hashDynamicRequest({
		version: 2,
		generation,
		sourceTaskIds,
		invalidatedTaskIds,
		foreachGroups,
	});
}
function invalidationTaskOwnership(
	run: WorkflowRunRecord,
	sourceTaskIds: readonly string[],
	invalidatedTaskIds: readonly string[],
): InvalidationTaskOwnership[] {
	const taskById = new Map<string, WorkflowTaskRunRecord>();
	for (const task of run.tasks) {
		if (taskById.has(task.taskId)) {
			throw new Error(
				`Cannot prepare dependency invalidation for ${run.runId}: task identity is ambiguous`,
			);
		}
		taskById.set(task.taskId, task);
	}
	return [...new Set([...sourceTaskIds, ...invalidatedTaskIds])]
		.sort()
		.map((taskId) => {
			const task = taskById.get(taskId);
			if (!task) {
				throw new Error(
					`Cannot prepare dependency invalidation for ${run.runId}: affected task ${taskId} is missing`,
				);
			}
			return { taskId, specId: task.specId };
		});
}

function unaffectedRunStructureSignature(
	run: WorkflowRunRecord,
	affectedTaskIds: ReadonlySet<string>,
): string {
	return hashDynamicRequest(
		run.tasks.filter((task) => !affectedTaskIds.has(task.taskId)),
	);
}

function unaffectedCompiledStructureSignature(
	compiledFlow: CompiledWorkflow,
	affectedSpecIds: ReadonlySet<string>,
): string {
	return hashDynamicRequest(
		compiledFlow.tasks.filter(
			(task) => !affectedSpecIds.has(compiledTaskSpecId(task)),
		),
	);
}

function dependencyResumeInvalidationPlan(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
): ResumeDependencyInvalidationPlan | undefined {
	const resumableSourceSpecIds = new Set(
		run.tasks
			.filter(
				(task) =>
					task.status === "failed" ||
					task.status === "interrupted" ||
					task.status === "skipped" ||
					isBlockedTaskResumableForResume(task),
			)
			.map((task) => task.specId),
	);
	if (resumableSourceSpecIds.size === 0) return undefined;

	const compiledBySpecId = new Map<string, CompiledTask>();
	for (const task of compiledFlow.tasks) {
		const specId = compiledTaskSpecId(task);
		if (compiledBySpecId.has(specId)) {
			throw new Error(
				`Cannot prepare dependency invalidation for ${run.runId}: compiled task ${specId} is ambiguous`,
			);
		}
		compiledBySpecId.set(specId, task);
	}
	const runTaskBySpecId = new Map<string, WorkflowTaskRunRecord>();
	for (const task of run.tasks) {
		if (runTaskBySpecId.has(task.specId)) {
			throw new Error(
				`Cannot prepare dependency invalidation for ${run.runId}: task ${task.specId} is ambiguous`,
			);
		}
		runTaskBySpecId.set(task.specId, task);
	}
	const logicalDependenciesBySpecId = logicalDependencySpecIdsForResume(
		run,
		compiledBySpecId,
	);
	const sourceSpecIds = new Set<string>();
	const invalidatedSpecIds = new Set<string>();
	for (const task of run.tasks) {
		const dependencies = logicalDependenciesBySpecId.get(task.specId) ?? [];
		if (
			!hasDurableDependencyInvalidationState(task) ||
			!dependencies.some((dependency) =>
				resumableSourceSpecIds.has(dependency),
			) ||
			!dependencyResumeInvalidationEnabled(
				compiledBySpecId.get(task.specId),
				task,
			)
		) {
			continue;
		}
		invalidatedSpecIds.add(task.specId);
		for (const dependency of dependencies) {
			if (resumableSourceSpecIds.has(dependency)) sourceSpecIds.add(dependency);
		}
	}
	const foreachOwnership = foreachInvalidationOwnership(
		run,
		compiledFlow,
		logicalDependenciesBySpecId,
		resumableSourceSpecIds,
	);
	if (
		invalidatedSpecIds.size === 0 &&
		foreachOwnership.placeholderSpecIds.size === 0
	)
		return undefined;
	for (const sourceSpecId of foreachOwnership.sourceSpecIds)
		sourceSpecIds.add(sourceSpecId);

	const dependentsBySpecId = new Map<string, string[]>();
	for (const [specId, dependencies] of logicalDependenciesBySpecId) {
		for (const dependency of dependencies) {
			const dependents = dependentsBySpecId.get(dependency) ?? [];
			dependents.push(specId);
			dependentsBySpecId.set(dependency, dependents);
		}
	}
	const pending = [...invalidatedSpecIds].sort();
	while (pending.length > 0) {
		const sourceSpecId = pending.pop()!;
		for (const dependentSpecId of [
			...(dependentsBySpecId.get(sourceSpecId) ?? []),
		].sort()) {
			if (invalidatedSpecIds.has(dependentSpecId)) continue;
			const dependent = runTaskBySpecId.get(dependentSpecId);
			if (!dependent || !hasDurableDependencyInvalidationState(dependent))
				continue;
			invalidatedSpecIds.add(dependentSpecId);
			pending.push(dependentSpecId);
		}
	}
	const foreachGroups = foreachInvalidationGroups(
		run,
		compiledFlow,
		new Set([...sourceSpecIds, ...invalidatedSpecIds]),
		foreachOwnership.placeholderSpecIds,
	);
	for (const group of foreachGroups) {
		invalidatedSpecIds.add(group.placeholderSpecId);
		for (const child of group.runChildren) invalidatedSpecIds.add(child.specId);
	}
	const sourceTaskIds = run.tasks
		.filter((task) => sourceSpecIds.has(task.specId))
		.map((task) => task.taskId)
		.sort();
	const invalidatedTaskIds = run.tasks
		.filter((task) => invalidatedSpecIds.has(task.specId))
		.map((task) => task.taskId)
		.sort();
	const generations = [
		run.invalidationJournal?.generation ?? 0,
		...run.tasks.map((task) => task.generation ?? 0),
	];
	if (
		generations.some(
			(generation) =>
				!Number.isSafeInteger(generation) || generation < 0,
		)
	) {
		throw new Error(
			`Cannot prepare dependency invalidation for ${run.runId}: generation metadata is invalid`,
		);
	}
	const generation = Math.max(...generations) + 1;
	const taskOwnership = invalidationTaskOwnership(
		run,
		sourceTaskIds,
		invalidatedTaskIds,
	);
	const affectedTaskIds = new Set(taskOwnership.map((task) => task.taskId));
	const affectedSpecIds = new Set(taskOwnership.map((task) => task.specId));
	return {
		generation,
		idempotencyKey: invalidationIdempotencyKey(
			generation,
			sourceTaskIds,
			invalidatedTaskIds,
			foreachGroups,
		),
		sourceTaskIds,
		invalidatedTaskIds,
		foreachGroups,
		taskOwnership,
		unaffectedRunSignature: unaffectedRunStructureSignature(
			run,
			affectedTaskIds,
		),
		unaffectedCompiledSignature: unaffectedCompiledStructureSignature(
			compiledFlow,
			affectedSpecIds,
		),
	};
}

function sameInvalidationGroupSide<T extends { specId?: string; id?: string }>(
	current: readonly T[],
	expected: readonly T[],
	specId: (value: T) => string,
): boolean {
	return (
		current.length === expected.length &&
		[...current]
			.sort((left, right) => specId(left).localeCompare(specId(right)))
			.every(
				(value, index) =>
					hashDynamicRequest(value) ===
					hashDynamicRequest(
						[...expected].sort((left, right) =>
							specId(left).localeCompare(specId(right)),
						)[index],
					),
			)
	);
}

function assertDependencyInvalidationRematerializable(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	journal: ResumeDependencyInvalidationPlan,
): void {
	const affectedTaskIds = new Set([
		...journal.sourceTaskIds,
		...journal.invalidatedTaskIds,
	]);
	const taskById = new Map<string, WorkflowTaskRunRecord>();
	for (const task of run.tasks) {
		if (taskById.has(task.taskId)) {
			throw new Error(
				`Cannot recover dependency invalidation for ${run.runId}: run task identity is ambiguous`,
			);
		}
		taskById.set(task.taskId, task);
	}
	const compiledBySpecId = new Map<string, CompiledTask>();
	for (const task of compiledFlow.tasks) {
		const specId = compiledTaskSpecId(task);
		if (compiledBySpecId.has(specId)) {
			throw new Error(
				`Cannot recover dependency invalidation for ${run.runId}: compiled task identity is ambiguous`,
			);
		}
		compiledBySpecId.set(specId, task);
	}
	const missingInvalidatedTaskIds = new Set<string>();
	for (const group of journal.foreachGroups) {
		const parent = run.tasks.find(
			(task) => task.taskId === group.parentTaskId,
		);
		if (!parent || parent.specId !== group.placeholderSpecId) {
			throw new Error(
				`Cannot recover dependency invalidation for ${run.runId}: foreach group ${group.placeholderSpecId} parent changed`,
			);
		}
		const currentCompiledChildren = compiledFlow.tasks.filter(
			(task) =>
				task.foreachGenerated?.placeholderSpecId === group.placeholderSpecId,
		);
		const currentRunChildren = run.tasks.filter(
			(task) =>
				task.foreachGenerated?.placeholderSpecId === group.placeholderSpecId,
		);
		const compiledMatches = sameInvalidationGroupSide(
			currentCompiledChildren,
			group.compiledChildren,
			(task) => compiledTaskSpecId(task),
		);
		const runMatches = sameInvalidationGroupSide(
			currentRunChildren,
			group.runChildren,
			(task) => task.specId,
		);
		if (
			(!compiledMatches && currentCompiledChildren.length !== 0) ||
			(!runMatches && currentRunChildren.length !== 0) ||
			(!compiledMatches && !runMatches)
		) {
			throw new Error(
				`Cannot recover dependency invalidation for ${run.runId}: foreach group ${group.placeholderSpecId} is partial or cross-bound`,
			);
		}
		if (
			hashDynamicRequest(parent.dispatchMap) !==
			hashDynamicRequest(group.dispatchMap)
		) {
			throw new Error(
				`Cannot recover dependency invalidation for ${run.runId}: foreach group ${group.placeholderSpecId} dispatch map changed`,
			);
		}
		if (compiledMatches && currentRunChildren.length === 0) {
			for (const child of group.runChildren)
				missingInvalidatedTaskIds.add(child.taskId);
		}
	}
	for (const taskId of affectedTaskIds) {
		const task = taskById.get(taskId);
		if (!task) {
			if (
				missingInvalidatedTaskIds.has(taskId) &&
				journal.invalidatedTaskIds.includes(taskId)
			)
				continue;
			throw new Error(
				`Cannot recover dependency invalidation for ${run.runId}: affected task ${taskId} is missing`,
			);
		}
		if (
			task.kind === "dynamic" ||
			task.dynamicGenerated !== undefined ||
			compiledBySpecId.get(task.specId)?.kind === "dynamic"
		) {
			throw new Error(
				`Cannot resume dependency invalidation for ${run.runId}: it crosses dynamic controller ownership at ${task.specId}; generational dynamic replay is not supported`,
			);
		}
	}
}
function assertResumeLoopOwnershipSupported(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
): void {
	if ((run.loopStates?.length ?? 0) > 0) {
		throw new Error(`resume does not support loop workflows yet: ${run.runId}`);
	}
	for (const task of compiledFlow.tasks) {
		if (
			task.kind === "loop" ||
			task.loopPlaceholder !== undefined ||
			task.loopChild !== undefined ||
			task.loopExhausted !== undefined
		) {
			throw new Error(`resume does not support loop workflow ownership: ${run.runId}`);
		}
	}
	for (const task of run.tasks) {
		if (task.kind === "loop") {
			throw new Error(`resume does not support loop workflow ownership: ${run.runId}`);
		}
	}
}

function dependencyInvalidationArtifactTasks(
	run: WorkflowRunRecord,
	journal: ResumeDependencyInvalidationPlan,
): WorkflowTaskRunRecord[] {
	const affectedTaskIds = new Set([
		...journal.sourceTaskIds,
		...journal.invalidatedTaskIds,
	]);
	const invalidatedForeachPlaceholders = new Set(
		run.tasks
			.filter(
				(task) =>
					affectedTaskIds.has(task.taskId) && task.dispatchMap !== undefined,
			)
			.map((task) => task.specId),
	);
	for (const task of run.tasks) {
		if (
			invalidatedForeachPlaceholders.has(
				task.foreachGenerated?.placeholderSpecId ?? "",
			)
		) {
			affectedTaskIds.add(task.taskId);
		}
	}
	return run.tasks.filter((task) => affectedTaskIds.has(task.taskId));
}

async function dependencyInvalidationArtifactPathExists(
	path: string,
): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function quarantineDependencyInvalidationArtifacts(
	cwd: string,
	run: WorkflowRunRecord,
	journal: ResumeDependencyInvalidationPlan,
	leaseSignal?: AbortSignal,
): Promise<void> {
	if (leaseSignal) await assertRunLeaseOwnership(cwd, run.runId, leaseSignal);
	const paths = await Promise.all(
		dependencyInvalidationArtifactTasks(run, journal).map(async (task) => {
			const taskDir = dirname(fromProjectPath(cwd, task.files.result));
			return {
				taskId: task.taskId,
				taskDir,
				quarantineDir: `${taskDir}.invalidated-generation-${journal.generation}`,
				active: await dependencyInvalidationArtifactPathExists(taskDir),
				quarantined: await dependencyInvalidationArtifactPathExists(
					`${taskDir}.invalidated-generation-${journal.generation}`,
				),
			};
		}),
	);
	if (leaseSignal) await assertRunLeaseOwnership(cwd, run.runId, leaseSignal);
	const mixedState = paths.some((path) => path.active && path.quarantined);
	if (mixedState) {
		throw new Error(
			`Cannot quarantine dependency-invalidated artifacts for ${run.runId}: an artifact directory is both active and quarantined`,
		);
	}
	const active = paths.filter((path) => path.active);
	if (active.length === 0) return;
	for (const path of active) {
		if (leaseSignal)
			await assertRunLeaseOwnership(cwd, run.runId, leaseSignal);
		await rename(path.taskDir, path.quarantineDir);
		if (leaseSignal)
			await assertRunLeaseOwnership(cwd, run.runId, leaseSignal);
	}
}
export async function quarantineDependencyInvalidationArtifactsForTests(
	cwd: string,
	run: WorkflowRunRecord,
	generation: number,
	taskIds: string[],
): Promise<void> {
	await quarantineDependencyInvalidationArtifacts(cwd, run, {
		generation,
		idempotencyKey: invalidationIdempotencyKey(
			generation,
			taskIds,
			[],
			[],
		),
		sourceTaskIds: taskIds,
		invalidatedTaskIds: [],
		foreachGroups: [],
		taskOwnership: taskIds.map((taskId) => ({
			taskId,
			specId: run.tasks.find((task) => task.taskId === taskId)?.specId ?? "",
		})),
		unaffectedRunSignature: "",
		unaffectedCompiledSignature: "",
	});
}

export function dependencyResumeInvalidationPlanForTests(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
): ResumeDependencyInvalidationPlan | undefined {
	const plan = dependencyResumeInvalidationPlan(run, compiledFlow);
	if (plan) assertDependencyInvalidationRematerializable(run, compiledFlow, plan);
	return plan;
}
export function preparedDependencyInvalidationPlanForTests(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
): ResumeDependencyInvalidationPlan | undefined {
	return preparedInvalidationPlan(run, compiledFlow);
}
function applyDependencyResumeInvalidation(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	journal: ResumeDependencyInvalidationPlan,
): string[] {
	const sourceTaskIds = new Set(journal.sourceTaskIds);
	const invalidatedTaskIds = new Set(journal.invalidatedTaskIds);
	const affectedTaskIds = new Set([
		...journal.sourceTaskIds,
		...journal.invalidatedTaskIds,
	]);
	const taskById = new Map(run.tasks.map((task) => [task.taskId, task]));
	for (const taskId of sourceTaskIds) {
		if (!taskById.has(taskId)) {
			throw new Error(
				`Cannot recover dependency invalidation: source task ${taskId} is missing`,
			);
		}
	}

	const foreachPlaceholderSpecIds = new Set(
		journal.foreachGroups.map((group) => group.placeholderSpecId),
	);
	removeForeachGeneratedTasksForPlaceholders(
		run,
		compiledFlow,
		foreachPlaceholderSpecIds,
		journal.foreachGroups,
	);
	const resetTaskIds: string[] = [];
	for (const task of run.tasks) {
		if (!affectedTaskIds.has(task.taskId)) continue;
		const reset = sourceTaskIds.has(task.taskId)
			? resetTaskForResume(task)
			: invalidatedTaskIds.has(task.taskId)
				? invalidateTaskForDependencyResume(task)
				: false;
		if (task.generation !== journal.generation) {
			task.generation = journal.generation;
		}
		task.dispatchMap = undefined;
		if (reset) resetTaskIds.push(task.taskId);
	}
	return resetTaskIds;
}

function resetRemainingTasksForResume(
	run: WorkflowRunRecord,
	alreadyResetTaskIds: ReadonlySet<string>,
): string[] {
	const resetTaskIds: string[] = [];
	for (const task of run.tasks) {
		if (alreadyResetTaskIds.has(task.taskId)) continue;
		if (resetTaskForResume(task)) resetTaskIds.push(task.taskId);
	}
	return resetTaskIds;
}

type WorkflowInvalidationJournal = NonNullable<
	WorkflowRunRecord["invalidationJournal"]
> & {
	foreachGroups?: ForeachInvalidationGroupSnapshot[];
	taskOwnership?: InvalidationTaskOwnership[];
	unaffectedRunSignature?: string;
	unaffectedCompiledSignature?: string;
};
function isValidForeachInvalidationGroupSnapshot(
	value: unknown,
): value is ForeachInvalidationGroupSnapshot {
	if (!value || typeof value !== "object") return false;
	const group = value as Partial<ForeachInvalidationGroupSnapshot>;
	return (
		typeof group.placeholderSpecId === "string" &&
		group.placeholderSpecId !== "" &&
		typeof group.parentTaskId === "string" &&
		group.parentTaskId !== "" &&
		group.dispatchMap !== undefined &&
		Array.isArray(group.compiledChildren) &&
		Array.isArray(group.runChildren)
	);
}

function isValidInvalidationTaskOwnership(
	value: unknown,
): value is InvalidationTaskOwnership {
	if (!value || typeof value !== "object") return false;
	const ownership = value as Partial<InvalidationTaskOwnership>;
	return (
		typeof ownership.taskId === "string" &&
		ownership.taskId !== "" &&
		typeof ownership.specId === "string" &&
		ownership.specId !== ""
	);
}


function preparedInvalidationPlan(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
): ResumeDependencyInvalidationPlan | undefined {
	const journal = run.invalidationJournal as
		| WorkflowInvalidationJournal
		| undefined;
	if (journal?.status !== "prepared") return undefined;
	if (
		!Number.isSafeInteger(journal.generation) ||
		journal.generation < 1 ||
		typeof journal.idempotencyKey !== "string" ||
		journal.idempotencyKey === "" ||
		(journal.artifactState !== "pending" &&
			journal.artifactState !== "quarantined") ||
		!Array.isArray(journal.sourceTaskIds) ||
		!journal.sourceTaskIds.every((taskId) => typeof taskId === "string") ||
		!Array.isArray(journal.invalidatedTaskIds) ||
		!journal.invalidatedTaskIds.every((taskId) => typeof taskId === "string") ||
		new Set(journal.sourceTaskIds).size !== journal.sourceTaskIds.length ||
		new Set(journal.invalidatedTaskIds).size !==
			journal.invalidatedTaskIds.length ||
		(!Array.isArray(journal.foreachGroups) ||
			!journal.foreachGroups.every(isValidForeachInvalidationGroupSnapshot)) ||
		!Array.isArray(journal.taskOwnership) ||
		!journal.taskOwnership.every(isValidInvalidationTaskOwnership) ||
		new Set(journal.taskOwnership.map((task) => task.taskId)).size !==
			journal.taskOwnership.length ||
		typeof journal.unaffectedRunSignature !== "string" ||
		journal.unaffectedRunSignature === "" ||
		typeof journal.unaffectedCompiledSignature !== "string" ||
		journal.unaffectedCompiledSignature === ""
	) {
		throw new Error(
			`Cannot recover dependency invalidation for ${run.runId}: journal is invalid`,
		);
	}
	const sourceTaskIds = [...journal.sourceTaskIds].sort();
	const invalidatedTaskIds = [...journal.invalidatedTaskIds].sort();
	const taskOwnership = cloneInvalidationSnapshot(journal.taskOwnership);
	const affectedTaskIds = new Set([
		...sourceTaskIds,
		...invalidatedTaskIds,
	]);
	if (
		taskOwnership.length !== affectedTaskIds.size ||
		taskOwnership.some((task) => !affectedTaskIds.has(task.taskId))
	) {
		throw new Error(
			`Cannot recover dependency invalidation for ${run.runId}: journal task ownership is unbound`,
		);
	}
	const foreachGroups = cloneInvalidationSnapshot(journal.foreachGroups);
	const expectedIdempotencyKey = invalidationIdempotencyKey(
		journal.generation,
		sourceTaskIds,
		invalidatedTaskIds,
		foreachGroups,
	);
	if (journal.idempotencyKey !== expectedIdempotencyKey) {
		throw new Error(
			`Cannot recover dependency invalidation for ${run.runId}: journal idempotency token is invalid`,
		);
	}

	const runTasksById = new Map<string, WorkflowTaskRunRecord>();
	for (const task of run.tasks) {
		if (runTasksById.has(task.taskId)) {
			throw new Error(
				`Cannot recover dependency invalidation for ${run.runId}: run task identity is ambiguous`,
			);
		}
		runTasksById.set(task.taskId, task);
	}
	const journalRunChildren = new Map(
		foreachGroups.flatMap((group) =>
			group.runChildren.map((task) => [task.taskId, task.specId] as const),
		),
	);
	const journalCompiledChildren = new Set(
		foreachGroups.flatMap((group) =>
			group.compiledChildren.map((task) => compiledTaskSpecId(task)),
		),
	);
	const compiledSpecIds = new Set(compiledFlow.tasks.map(compiledTaskSpecId));
	for (const ownership of taskOwnership) {
		const currentRunTask = runTasksById.get(ownership.taskId);
		if (
			(currentRunTask && currentRunTask.specId !== ownership.specId) ||
			(!currentRunTask &&
				journalRunChildren.get(ownership.taskId) !== ownership.specId)
		) {
			throw new Error(
				`Cannot recover dependency invalidation for ${run.runId}: affected task ownership changed`,
			);
		}
		if (
			!compiledSpecIds.has(ownership.specId) &&
			!journalCompiledChildren.has(ownership.specId)
		) {
			throw new Error(
				`Cannot recover dependency invalidation for ${run.runId}: affected compiled ownership changed`,
			);
		}
	}
	const affectedSpecIds = new Set(taskOwnership.map((task) => task.specId));
	if (
		unaffectedRunStructureSignature(run, affectedTaskIds) !==
			journal.unaffectedRunSignature ||
		unaffectedCompiledStructureSignature(compiledFlow, affectedSpecIds) !==
			journal.unaffectedCompiledSignature
	) {
		throw new Error(
			`Cannot recover dependency invalidation for ${run.runId}: unaffected task structure or order changed`,
		);
	}
	return {
		generation: journal.generation,
		idempotencyKey: journal.idempotencyKey,
		sourceTaskIds,
		invalidatedTaskIds,
		foreachGroups,
		taskOwnership,
		unaffectedRunSignature: journal.unaffectedRunSignature,
		unaffectedCompiledSignature: journal.unaffectedCompiledSignature,
	};
}
function assertUnsupportedLegacyPreparedInvalidation(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
): void {
	const journal = run.invalidationJournal;
	if (
		journal?.status !== "prepared" ||
		journal.idempotencyKey !== undefined ||
		journal.artifactState !== undefined ||
		!Number.isSafeInteger(journal.generation) ||
		journal.generation < 1 ||
		!Array.isArray(journal.sourceTaskIds) ||
		!journal.sourceTaskIds.every((taskId) => typeof taskId === "string") ||
		!Array.isArray(journal.invalidatedTaskIds) ||
		!journal.invalidatedTaskIds.every((taskId) => typeof taskId === "string") ||
		new Set(journal.sourceTaskIds).size !== journal.sourceTaskIds.length ||
		new Set(journal.invalidatedTaskIds).size !==
			journal.invalidatedTaskIds.length
	) {
		return;
	}
	const affectedSpecIds = new Set(
		[...journal.sourceTaskIds, ...journal.invalidatedTaskIds]
			.map((taskId) => run.tasks.find((task) => task.taskId === taskId)?.specId)
			.filter((specId): specId is string => specId !== undefined),
	);
	foreachInvalidationGroups(run, compiledFlow, affectedSpecIds);
	assertDependencyInvalidationRematerializable(run, compiledFlow, {
		generation: journal.generation,
		idempotencyKey: "legacy-prepared-invalidation",
		sourceTaskIds: journal.sourceTaskIds,
		invalidatedTaskIds: journal.invalidatedTaskIds,
		foreachGroups: [],
		taskOwnership: invalidationTaskOwnership(
			run,
			journal.sourceTaskIds,
			journal.invalidatedTaskIds,
		),
		unaffectedRunSignature: "legacy-prepared-invalidation",
		unaffectedCompiledSignature: "legacy-prepared-invalidation",
	});
}

function assertRunResumableForResume(run: WorkflowRunRecord): void {
	if (
		run.status !== "failed" &&
		run.status !== "interrupted" &&
		run.status !== "blocked"
	) {
		throw new Error(
			`resume requires a failed, interrupted, or resumable blocked run; ${run.runId} is ${run.status}`,
		);
	}
	assertBlockedRunResumable(run);
}

export async function resumeRun(
	cwd: string,
	runIdOrPrefix: string,
	options: WorkflowScheduleOptions = {},
): Promise<ResumeRunSummary> {
	const current = await readRunRecord(cwd, runIdOrPrefix);
	assertRunResumableForResume(current);

	const resetTaskIds: string[] = [];
	const updated = await withRunLease(cwd, current.runId, async (leaseSignal) => {
		assertResumeLeaseActive(leaseSignal);
		const run = await readRunRecord(cwd, current.runId);
		assertRunResumableForResume(run);
		assertResumeLeaseActive(leaseSignal);

		const activeCompiledFlow = await readCompiledWorkflow(cwd, run.runId);
		assertResumeLeaseActive(leaseSignal);
		if (!activeCompiledFlow) {
			throw new Error(
				`Cannot resume ${run.runId}: compiled workflow is missing`,
			);
		}
		assertUnsupportedLegacyPreparedInvalidation(run, activeCompiledFlow);
		const prepared = preparedInvalidationPlan(run, activeCompiledFlow);
		if (!prepared) assertRunTaskPositionalAlignment(run, activeCompiledFlow);
		assertResumeLoopOwnershipSupported(run, activeCompiledFlow);

		const planned =
			prepared ?? dependencyResumeInvalidationPlan(run, activeCompiledFlow);
		if (planned) {
			assertDependencyInvalidationRematerializable(
				run,
				activeCompiledFlow,
				planned,
			);
		}
		await resumeLeaseMutation(cwd, run.runId, leaseSignal, () =>
			resolveWorkflowBackend(run).cleanupRun(cwd, run),
		);
		if (!planned) {
			await resumeLeaseMutation(cwd, run.runId, leaseSignal, async () => {
				for (const task of run.tasks) {
					if (resetTaskForResume(task)) resetTaskIds.push(task.taskId);
				}
				if (resetTaskIds.length > 0)
					await writeRunRecord(cwd, run, leaseSignal);
			});
			return run;
		}

		if (!prepared) {
			await resumeLeaseMutation(cwd, run.runId, leaseSignal, async () => {
				run.invalidationJournal = {
					generation: planned.generation,
					idempotencyKey: planned.idempotencyKey,
					sourceTaskIds: planned.sourceTaskIds,
					invalidatedTaskIds: planned.invalidatedTaskIds,
					foreachGroups: planned.foreachGroups,
					taskOwnership: planned.taskOwnership,
					unaffectedRunSignature: planned.unaffectedRunSignature,
					unaffectedCompiledSignature: planned.unaffectedCompiledSignature,
					artifactState: "pending",
					status: "prepared",
				} as WorkflowInvalidationJournal;
				await writeRunRecord(cwd, run, leaseSignal);
			});
		}
		await resumeLeaseMutation(cwd, run.runId, leaseSignal, () =>
			quarantineDependencyInvalidationArtifacts(
				cwd,
				run,
				planned,
				leaseSignal,
			),
		);
		if (run.invalidationJournal?.artifactState !== "quarantined") {
			await resumeLeaseMutation(cwd, run.runId, leaseSignal, async () => {
				run.invalidationJournal = {
					generation: planned.generation,
					idempotencyKey: planned.idempotencyKey,
					sourceTaskIds: planned.sourceTaskIds,
					invalidatedTaskIds: planned.invalidatedTaskIds,
					foreachGroups: planned.foreachGroups,
					taskOwnership: planned.taskOwnership,
					unaffectedRunSignature: planned.unaffectedRunSignature,
					unaffectedCompiledSignature: planned.unaffectedCompiledSignature,
					artifactState: "quarantined",
					status: "prepared",
				} as WorkflowInvalidationJournal;
				await writeRunRecord(cwd, run, leaseSignal);
			});
		}
		await resumeLeaseMutation(cwd, run.runId, leaseSignal, async () => {
			const invalidatedTaskIds = applyDependencyResumeInvalidation(
				run,
				activeCompiledFlow,
				planned,
			);
			const invalidatedTaskIdSet = new Set([
				...planned.sourceTaskIds,
				...planned.invalidatedTaskIds,
			]);
			resetTaskIds.push(
				...invalidatedTaskIds,
				...resetRemainingTasksForResume(run, invalidatedTaskIdSet),
			);
			await writeJsonAtomic(
				compiledWorkflowPath(cwd, run.runId),
				activeCompiledFlow,
				leaseSignal,
			);
			run.invalidationJournal = {
				generation: planned.generation,
				idempotencyKey: planned.idempotencyKey,
				sourceTaskIds: planned.sourceTaskIds,
				invalidatedTaskIds: planned.invalidatedTaskIds,
				foreachGroups: planned.foreachGroups,
				taskOwnership: planned.taskOwnership,
				unaffectedRunSignature: planned.unaffectedRunSignature,
				unaffectedCompiledSignature: planned.unaffectedCompiledSignature,
				artifactState: "quarantined",
				status: "applied",
			} as WorkflowInvalidationJournal;
			await writeRunRecord(cwd, run, leaseSignal);
		});
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
	supervisorErrorCounts.delete(key);
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
				supervisorErrorCounts.delete(key);
				return;
			}

			supervisorErrorCounts.delete(key);
			unwatchRun(cwd, runId);
		})().catch((error) => {
			if (isMissingRunError(error)) {
				unwatchRun(cwd, runId);
				return;
			}
			const failures = (supervisorErrorCounts.get(key) ?? 0) + 1;
			supervisorErrorCounts.set(key, failures);
			void recordSupervisorError(cwd, runId, error).finally(() => {
				if (failures >= MAX_SUPERVISOR_CONSECUTIVE_ERRORS)
					unwatchRun(cwd, runId);
			});
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
		if (isEnoentError(error)) return undefined;
		throw error;
	}
}

function isEnoentError(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function isMissingRunError(error: unknown): boolean {
	return (
		isEnoentError(error) ||
		(error instanceof Error && /^Flow run not found: /.test(error.message))
	);
}

function assertScheduleLeaseActive(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	const reason = (signal as AbortSignal & { reason?: unknown }).reason;
	if (reason instanceof Error) throw reason;
	throw new Error(
		reason === undefined
			? "Lost supervisor lease"
			: `Lost supervisor lease: ${String(reason)}`,
	);
}

export async function scheduleRun(
	cwd: string,
	runId: string,
	compiled?: CompiledWorkflow,
	options: WorkflowScheduleOptions = {},
): Promise<WorkflowRunRecord | undefined> {
	return withRunLease(cwd, runId, async (leaseSignal) => {
		assertScheduleLeaseActive(leaseSignal);
		let run = await readRunRecord(cwd, runId);
		try {
			run = await resolveWorkflowBackend(run).refreshRun(cwd, run);
		} catch (error) {
			if (!isRefreshPollAggregateError(error)) throw error;
			await recordSupervisorError(cwd, run.runId, error);
		}
		if (isTerminalWorkflowStatus(run.status)) {
			await clearTerminalWorkflowStopIntentIfPresent(cwd, run);
			return run;
		}
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
		await scheduleDag(cwd, run, compiledFlow, options, leaseSignal);
		assertScheduleLeaseActive(leaseSignal);

		run = await readRunRecord(cwd, run.runId);
		return run;
	});
}

async function scheduleDag(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	options: WorkflowScheduleOptions = {},
	leaseSignal?: AbortSignal,
): Promise<void> {
	let currentRun = run;
	let currentCompiledFlow = compiledFlow;
	let rescans = 0;
	for (;;) {
		assertScheduleLeaseActive(leaseSignal);
		const needsRescan = await scheduleDagPass(
			cwd,
			currentRun,
			currentCompiledFlow,
			options,
			leaseSignal,
		);
		if (!needsRescan) return;
		if (rescans >= MAX_SAME_LEASE_SCHEDULE_RESCANS) return;
		rescans += 1;
		assertScheduleLeaseActive(leaseSignal);
		currentRun = await readRunRecord(cwd, currentRun.runId);
		const refreshedCompiledFlow = await readCompiledWorkflow(
			cwd,
			currentRun.runId,
		);
		if (!refreshedCompiledFlow) return;
		currentCompiledFlow = refreshedCompiledFlow;
	}
}

function staleForeachDispatchMapMessage(
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	validationSnapshot: ArtifactGraphRuntimeValidationSnapshot,
): string | undefined {
	try {
		assertArtifactGraphSourceRuntimeMetadataCurrent(
			run,
			task,
			validationSnapshot,
		);
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}
async function scheduleDagPass(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	options: WorkflowScheduleOptions = {},
	leaseSignal?: AbortSignal,
): Promise<boolean> {
	assertScheduleLeaseActive(leaseSignal);
	if (compiledFlow.type === WORKFLOW_RUN_TYPE) {
		const loopReconciled = await reconcileLoopTaskMaterialization(
			cwd,
			run,
			compiledFlow,
		);
		if (loopReconciled) return true;
		if (await recoverPreparedForeachMaterialization(cwd, run, compiledFlow))
			return true;
		const foreachReconciled = reconcileForeachGeneratedRunRecords(
			cwd,
			run,
			compiledFlow,
		);
		if (foreachReconciled) {
			await writeJsonAtomic(compiledWorkflowPath(cwd, run.runId), compiledFlow);
			await writeRunRecord(cwd, run);
			return true;
		}
		const dynamicReconciled = reconcileDynamicGeneratedRunRecords(
			cwd,
			run,
			compiledFlow,
		);
		assertRunTaskPositionalAlignment(run, compiledFlow);
		if (await finalizeStopIntentIfRequested(cwd, run)) return false;
		const staleDynamicRecovered = recoverStaleRunningDynamicControllers(
			run,
			compiledFlow,
		);
		const staleSupportRecovered = recoverStaleRunningSupportTasks(
			run,
			compiledFlow,
		);
		if (dynamicReconciled || staleDynamicRecovered || staleSupportRecovered)
			await writeRunRecord(cwd, run);
	}

	if (await finalizeStopIntentIfRequested(cwd, run)) return false;

	const changed = markDagDependentsSkipped(run, compiledFlow);
	if (changed) {
		await writeRunRecord(cwd, run);
		run = await readRunRecord(cwd, run.runId);
	}
	if (await applyFailFastCancellation(cwd, run, compiledFlow)) return true;

	const maxConcurrency = Math.max(
		1,
		Math.min(MAX_CONCURRENCY, compiledFlow.maxConcurrency),
	);
	let running = run.tasks.filter((task) => task.status === "running").length;
	const bySpecId = new Map(run.tasks.map((task) => [task.specId, task]));
	const dispatchMapValidationSnapshot =
		createArtifactGraphRuntimeValidationSnapshot(run);

	for (
		let index = 0;
		index < run.tasks.length && running < maxConcurrency;
		index += 1
	) {
		assertScheduleLeaseActive(leaseSignal);
		if (await finalizeStopIntentIfRequested(cwd, run)) return false;
		const task = run.tasks[index];
		const compiledTask = compiledFlow.tasks[index];
		if (!task || !compiledTask || task.status !== "pending") continue;
		if (
			await suspendedDynamicControllerStillWaiting(cwd, run, task, compiledTask)
		) {
			continue;
		}
		const staleDispatchMapMessage = staleForeachDispatchMapMessage(
			run,
			task,
			dispatchMapValidationSnapshot,
		);
		if (staleDispatchMapMessage) {
			setTaskTerminal(task, "blocked", "foreach_generation_stale", {
				lastMessage: staleDispatchMapMessage,
			});
			await writeRunRecord(cwd, run);
			continue;
		}
		if (!dependenciesReady(compiledTask, bySpecId, compiledFlow, task)) continue;

		if (compiledTask.kind === "loop" && compiledTask.loopPlaceholder) {
			const changed = await scheduleLoop(
				cwd,
				run,
				compiledFlow,
				index,
				compiledTask,
			);
			if (await finalizeStopIntentIfRequested(cwd, run)) return false;
			if (changed) return true;
			continue;
		}

		if (compiledTask.kind === "foreach" && compiledTask.foreach) {
			const changed = await materializeForeachTask(
				cwd,
				run,
				compiledFlow,
				index,
				compiledTask,
				dispatchMapValidationSnapshot,
			);
			if (await finalizeStopIntentIfRequested(cwd, run)) return false;
			if (changed) return true;
			if (foreachStreamingEnabled(compiledTask)) continue;
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

		const taskCountBeforeLaunch = run.tasks.length;
		const compiledTaskCountBeforeLaunch = compiledFlow.tasks.length;
		assertScheduleLeaseActive(leaseSignal);
		const launched = await launchPendingTaskAt(
			cwd,
			run,
			compiledFlow,
			index,
			dispatchMapValidationSnapshot,
			options,
			leaseSignal,
		);
		if (
			run.tasks.length !== taskCountBeforeLaunch ||
			compiledFlow.tasks.length !== compiledTaskCountBeforeLaunch
		) {
			return true;
		}
		assertScheduleLeaseActive(leaseSignal);
		if (await finalizeStopIntentIfRequested(cwd, run)) return false;
		if (await applyFailFastCancellation(cwd, run, compiledFlow)) return true;
		if (await finalizeStopIntentIfRequested(cwd, run)) return false;
		if (launched && run.tasks[index]?.status === "running") running += 1;
	}
	return false;
}

async function applyFailFastCancellation(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
): Promise<boolean> {
	const summary = markFailFastCancellations(run, compiledFlow);
	if (summary.cancelledTaskIds.length === 0) return false;
	await writeRunRecord(cwd, run);
	const cancellationErrors: unknown[] = [];
	await Promise.all(
		summary.interruptedTaskIds.map(async (taskId) => {
			const task = run.tasks.find((candidate) => candidate.taskId === taskId);
			if (!task) return;
			try {
				await acknowledgeSubagentTaskInterrupted(
					run,
					task,
					"workflow fail-fast cancellation",
				);
				setTaskTerminal(
					task,
					"interrupted",
					FAIL_FAST_CANCELLED_STATUS_DETAIL,
					{
						exitCode: 130,
						lastMessage: "cancelled by workflow fail-fast policy",
					},
				);
			} catch (error) {
				task.statusDetail = "cancellation_failed";
				task.lastMessage = `fail-fast cancellation failed; backend handle preserved: ${error instanceof Error ? error.message : String(error)}`;
				cancellationErrors.push(error);
			}
		}),
	);
	await writeRunRecord(cwd, run);
	if (cancellationErrors.length > 0) {
		throw new AggregateError(
			cancellationErrors,
			"one or more fail-fast backend cancellations failed",
		);
	}
	return true;
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

type ForeachDispatchMapContext = {
	generation: number;
	sourceTaskId: string;
};

function foreachDispatchMapContext(
	template: CompiledTask,
	sourceTasks: WorkflowTaskRunRecord[],
): ForeachDispatchMapContext | { error: string } | undefined {
	if (template.foreach?.itemIdentityPath === undefined) return undefined;
	if (sourceTasks.length !== 1) {
		return {
			error:
				"foreach itemIdentityPath requires exactly one source task for a stable dispatch map",
		};
	}
	const sourceTask = sourceTasks[0];
	if (
		sourceTask.generation !== undefined &&
		(!Number.isSafeInteger(sourceTask.generation) ||
			sourceTask.generation < 0)
	) {
		return {
			error: "foreach source task has invalid generation metadata",
		};
	}
	return {
		generation: sourceTask.generation ?? 0,
		sourceTaskId: sourceTask.taskId,
	};
}

function attachForeachDispatchMap(
	parent: WorkflowTaskRunRecord,
	context: ForeachDispatchMapContext,
	generatedTasks: CompiledTask[],
	generatedRunTasks: WorkflowTaskRunRecord[],
): string | undefined {
	const entries = generatedTasks.map((task, index) => {
		const metadata = task.foreachGenerated;
		const runTask = generatedRunTasks[index];
		if (
			!metadata?.itemIdentity ||
			!metadata.itemSourceTaskId ||
			!metadata.itemSourceSpecId ||
			!metadata.itemSourceKind ||
			!metadata.itemRef ||
			!metadata.itemHash ||
			!runTask ||
			metadata.itemSourceTaskId !== context.sourceTaskId
		) {
			return undefined;
		}
		return {
			itemIdentity: metadata.itemIdentity,
			taskId: runTask.taskId,
			specId: task.id,
			itemSourceTaskId: metadata.itemSourceTaskId,
			itemSourceSpecId: metadata.itemSourceSpecId,
			itemSourceKind: metadata.itemSourceKind,
			itemRef: metadata.itemRef,
			itemHash: metadata.itemHash,
			...(metadata.perItemDispatch ? { perItemDispatch: true as const } : {}),
		};
	});
	if (entries.some((entry) => entry === undefined)) {
		return "foreach dispatch map is missing a complete generated child identity tuple";
	}
	const dispatchMap = {
		version: 1 as const,
		generation: context.generation,
		sourceTaskId: context.sourceTaskId,
		entries: entries as Array<{
			itemIdentity: string;
			taskId: string;
			specId: string;
			itemSourceTaskId: string;
			itemSourceSpecId: string;
			itemSourceKind: "control" | "partial";
			itemRef: string;
			itemHash: string;
			perItemDispatch?: true;
		}>,
		digest: hashDynamicRequest({
			version: 1,
			generation: context.generation,
			sourceTaskId: context.sourceTaskId,
			entries,
		}),
	};
	if (parent.dispatchMap && parent.dispatchMap.digest !== dispatchMap.digest) {
		return "foreach dispatch map changed within the same source generation";
	}
	parent.dispatchMap = dispatchMap;
	return undefined;
}

function generatedTasksWithItemMetadata(
	tasks: CompiledTask[],
	itemMetas: readonly ForeachExtractedItemMeta[],
): { tasks?: CompiledTask[]; error?: string } {
	if (tasks.length !== itemMetas.length) {
		return { error: "foreach generated task metadata is incomplete" };
	}
	return {
		tasks: tasks.map((task, index) => {
			const itemMeta = itemMetas[index];
			if (!itemMeta) return task;
			return {
				...task,
				foreachGenerated: {
					...(task.foreachGenerated ?? { placeholderSpecId: "" }),
					itemHash: itemMeta.itemHash,
					itemSourceTaskId: itemMeta.sourceTaskId,
					itemSourceSpecId: itemMeta.sourceSpecId,
					itemSourceKind: itemMeta.sourceKind,
					itemRef: itemMeta.itemRef,
				},
			};
		}),
	};
}

function generatedTasksWithSourceGeneration(
	tasks: CompiledTask[],
	context: ForeachDispatchMapContext | undefined,
): CompiledTask[] {
	if (!context) return tasks;
	return tasks.map((task) => ({
		...task,
		sourceGeneration: context.generation,
	}));
}
type ForeachMaterializationJournal = {
	status: "prepared";
	placeholderSpecId: string;
	replacePlaceholder: boolean;
	generatedTasks: CompiledTask[];
	generatedRunTasks: WorkflowTaskRunRecord[];
};

type WorkflowRunWithForeachMaterializationJournal = WorkflowRunRecord & {
	foreachMaterializationJournal?: ForeachMaterializationJournal;
};

function sameForeachJournalOwnershipTuple(
	compiledTask: CompiledTask,
	runTask: WorkflowTaskRunRecord,
	placeholderSpecId: string,
): boolean {
	const compiled = compiledTask.foreachGenerated;
	const persisted = runTask.foreachGenerated;
	return (
		compiledTask.id === compiledTaskSpecId(compiledTask) &&
		runTask.specId === compiledTask.id &&
		compiledTask.sourceGeneration === runTask.sourceGeneration &&
		compiled?.placeholderSpecId === placeholderSpecId &&
		persisted?.placeholderSpecId === placeholderSpecId &&
		compiled?.itemIdentity === persisted?.itemIdentity &&
		compiled?.itemHash === persisted?.itemHash &&
		compiled?.itemSourceTaskId === persisted?.itemSourceTaskId &&
		compiled?.itemSourceSpecId === persisted?.itemSourceSpecId &&
		compiled?.itemSourceKind === persisted?.itemSourceKind &&
		compiled?.itemRef === persisted?.itemRef &&
		compiled?.sourceLineageDigest === persisted?.sourceLineageDigest &&
		compiled?.resolvedTaskId === persisted?.resolvedTaskId &&
		compiled?.perItemDispatch === persisted?.perItemDispatch
	);
}

function foreachMaterializationJournal(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
): ForeachMaterializationJournal | undefined {
	const journal = (run as WorkflowRunWithForeachMaterializationJournal)
		.foreachMaterializationJournal;
	if (!journal) return undefined;
	if (
		journal.status !== "prepared" ||
		typeof journal.placeholderSpecId !== "string" ||
		journal.placeholderSpecId === "" ||
		typeof journal.replacePlaceholder !== "boolean" ||
		!Array.isArray(journal.generatedTasks) ||
		!Array.isArray(journal.generatedRunTasks) ||
		journal.generatedTasks.length !== journal.generatedRunTasks.length
	) {
		throw new Error(
			`Cannot recover foreach materialization for ${run.runId}: journal is invalid`,
		);
	}
	const runTaskIds = new Set<string>();
	const runSpecIds = new Set<string>();
	for (const task of run.tasks) {
		if (
			typeof task.taskId !== "string" ||
			task.taskId === "" ||
			runTaskIds.has(task.taskId) ||
			runSpecIds.has(task.specId)
		) {
			throw new Error(
				`Cannot recover foreach materialization for ${run.runId}: global run identity is invalid`,
			);
		}
		runTaskIds.add(task.taskId);
		runSpecIds.add(task.specId);
	}
	const compiledSpecIds = new Set<string>();
	for (const task of compiledFlow.tasks) {
		const specId = compiledTaskSpecId(task);
		if (compiledSpecIds.has(specId)) {
			throw new Error(
				`Cannot recover foreach materialization for ${run.runId}: global compiled identity is invalid`,
			);
		}
		compiledSpecIds.add(specId);
	}
	const journalSpecIds = new Set<string>();
	const journalTaskIds = new Set<string>();
	for (const [index, task] of journal.generatedTasks.entries()) {
		const runTask = journal.generatedRunTasks[index];
		if (
			!task ||
			typeof task.id !== "string" ||
			task.id === "" ||
			!runTask ||
			typeof runTask.taskId !== "string" ||
			runTask.taskId === "" ||
			journalSpecIds.has(task.id) ||
			journalTaskIds.has(runTask.taskId) ||
			!sameForeachJournalOwnershipTuple(
				task,
				runTask,
				journal.placeholderSpecId,
			)
		) {
			throw new Error(
				`Cannot recover foreach materialization for ${run.runId}: journal task mapping is invalid`,
			);
		}
		const existingRun = run.tasks.find((candidate) => candidate.specId === task.id);
		if (existingRun && existingRun.taskId !== runTask.taskId) {
			throw new Error(
				`Cannot recover foreach materialization for ${run.runId}: journal child ${task.id} collides with run state`,
			);
		}
		const existingTaskId = run.tasks.find(
			(candidate) => candidate.taskId === runTask.taskId,
		);
		if (existingTaskId && existingTaskId.specId !== task.id) {
			throw new Error(
				`Cannot recover foreach materialization for ${run.runId}: journal task ${runTask.taskId} collides with run state`,
			);
		}
		journalSpecIds.add(task.id);
		journalTaskIds.add(runTask.taskId);
	}
	return journal;
}

function assertPreparedForeachReplayOwnership(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	journal: ForeachMaterializationJournal,
): void {
	const expectedSpecIdByTaskId = new Map<string, string>();
	for (const task of journal.generatedRunTasks) {
		expectedSpecIdByTaskId.set(task.taskId, task.specId);
	}
	const runByTaskId = new Map<string, WorkflowTaskRunRecord>();
	for (const task of run.tasks) {
		if (runByTaskId.has(task.taskId)) {
			throw new Error(
				`Cannot recover foreach materialization for ${run.runId}: global run identity is invalid`,
			);
		}
		runByTaskId.set(task.taskId, task);
	}
	for (const [taskId, expectedSpecId] of expectedSpecIdByTaskId) {
		const existing = runByTaskId.get(taskId);
		if (existing && existing.specId !== expectedSpecId) {
			throw new Error(
				`Cannot recover foreach materialization for ${run.runId}: journal task ${taskId} is cross-bound to ${existing.specId}`,
			);
		}
	}

	const expectedSpecIds = new Set(
		journal.generatedTasks.map((task) => task.id),
	);
	const compiledOrder = foreachReplayStructuralOrder(
		compiledFlow.tasks,
		(task) => compiledTaskSpecId(task),
		expectedSpecIds,
		journal.placeholderSpecId,
	);
	const runOrder = foreachReplayStructuralOrder(
		run.tasks,
		(task) => task.specId,
		expectedSpecIds,
		journal.placeholderSpecId,
	);
	if (
		compiledOrder.length !== runOrder.length ||
		compiledOrder.some((specId, index) => specId !== runOrder[index])
	) {
		throw new Error(
			`Cannot recover foreach materialization for ${run.runId}: unaffected task alignment changed`,
		);
	}
}

function foreachReplayStructuralOrder<T>(
	tasks: readonly T[],
	specIdForTask: (task: T) => string,
	generatedSpecIds: ReadonlySet<string>,
	placeholderSpecId: string,
): string[] {
	const order: string[] = [];
	const groupMarker = `\0foreach:${placeholderSpecId}`;
	let groupSeen = false;
	let groupClosed = false;
	for (const task of tasks) {
		const specId = specIdForTask(task);
		const inReplayGroup =
			specId === placeholderSpecId || generatedSpecIds.has(specId);
		if (inReplayGroup) {
			if (groupClosed) {
				throw new Error(
					`Cannot recover foreach materialization: replay group ${placeholderSpecId} is not contiguous`,
				);
			}
			if (!groupSeen) order.push(groupMarker);
			groupSeen = true;
			continue;
		}
		if (groupSeen) groupClosed = true;
		order.push(specId);
	}
	return order;
}

function applyForeachMaterializationJournal(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	journal: ForeachMaterializationJournal,
): void {
	const expectedSpecIds = new Set(
		journal.generatedTasks.map((task) => task.id),
	);
	const replacePlaceholder =
		journal.replacePlaceholder && expectedSpecIds.size > 0;
	const expectedRunTaskBySpecId = new Map(
		journal.generatedRunTasks.map((task) => [task.specId, task]),
	);
	assertPreparedForeachReplayOwnership(run, compiledFlow, journal);
	const compiledBySpecId = new Map(
		compiledFlow.tasks.map((task) => [compiledTaskSpecId(task), task]),
	);
	const presentCompiled = journal.generatedTasks.filter((task) =>
		compiledBySpecId.has(task.id),
	);
	if (
		presentCompiled.length > 0 &&
		presentCompiled.length !== journal.generatedTasks.length
	) {
		throw new Error(
			`Cannot recover foreach materialization for ${run.runId}: compiled child set is partial`,
		);
	}
	for (const task of presentCompiled) {
		const existing = compiledBySpecId.get(task.id);
		if (hashDynamicRequest(existing) !== hashDynamicRequest(task)) {
			throw new Error(
				`Cannot recover foreach materialization for ${run.runId}: compiled child ${task.id} changed`,
			);
		}
	}

	const placeholderIndex = compiledFlow.tasks.findIndex(
		(task) => compiledTaskSpecId(task) === journal.placeholderSpecId,
	);
	if (replacePlaceholder) {
		if (placeholderIndex >= 0) {
			if (presentCompiled.length > 0) {
				throw new Error(
					`Cannot recover foreach materialization for ${run.runId}: placeholder and generated children coexist`,
				);
			}
			compiledFlow.tasks.splice(
				placeholderIndex,
				1,
				...journal.generatedTasks,
			);
		} else if (presentCompiled.length !== journal.generatedTasks.length) {
			throw new Error(
				`Cannot recover foreach materialization for ${run.runId}: placeholder is missing`,
			);
		}
	} else {
		if (placeholderIndex < 0) {
			throw new Error(
				`Cannot recover foreach materialization for ${run.runId}: retained placeholder is missing`,
			);
		}
		if (presentCompiled.length === 0) {
			compiledFlow.tasks.splice(
				placeholderIndex + 1,
				0,
				...journal.generatedTasks,
			);
		}
	}
	const retainEmptyPlaceholderDependency =
		!replacePlaceholder && expectedSpecIds.size === 0;
	if (!retainEmptyPlaceholderDependency) {
		updateDownstreamDependencies(
			compiledFlow,
			journal.placeholderSpecId,
			[...expectedSpecIds],
		);
	}

	const runTaskById = new Map(run.tasks.map((task) => [task.taskId, task]));
	for (const task of journal.generatedRunTasks) {
		const existing = runTaskById.get(task.taskId);
		if (existing && existing.specId !== task.specId) {
			throw new Error(
				`Cannot recover foreach materialization for ${run.runId}: task id ${task.taskId} is already bound to ${existing.specId}`,
			);
		}
	}
	const runBySpecId = new Map(run.tasks.map((task) => [task.specId, task]));
	const presentRunTasks = journal.generatedRunTasks.filter((task) =>
		runBySpecId.has(task.specId),
	);
	if (
		presentRunTasks.length > 0 &&
		presentRunTasks.length !== journal.generatedRunTasks.length
	) {
		throw new Error(
			`Cannot recover foreach materialization for ${run.runId}: run child set is partial`,
		);
	}
	for (const task of presentRunTasks) {
		const existing = runBySpecId.get(task.specId);
		const compiledTask = journal.generatedTasks.find(
			(candidate) => candidate.id === task.specId,
		);
		if (
			!existing ||
			existing.taskId !== task.taskId ||
			!compiledTask ||
			!sameForeachJournalOwnershipTuple(
				compiledTask,
				existing,
				journal.placeholderSpecId,
			)
		) {
			throw new Error(
				`Cannot recover foreach materialization for ${run.runId}: run child ${task.specId} changed`,
			);
		}
	}

	const runPlaceholderIndex = run.tasks.findIndex(
		(task) => task.specId === journal.placeholderSpecId,
	);
	let retainedPlaceholder: WorkflowTaskRunRecord | undefined;
	if (replacePlaceholder) {
		if (runPlaceholderIndex >= 0) {
			if (presentRunTasks.length > 0) {
				throw new Error(
					`Cannot recover foreach materialization for ${run.runId}: run placeholder and generated children coexist`,
				);
			}
			run.tasks.splice(
				runPlaceholderIndex,
				1,
				...journal.generatedRunTasks,
			);
		} else if (presentRunTasks.length !== journal.generatedRunTasks.length) {
			throw new Error(
				`Cannot recover foreach materialization for ${run.runId}: run placeholder is missing`,
			);
		}
	} else {
		if (runPlaceholderIndex < 0) {
			throw new Error(
				`Cannot recover foreach materialization for ${run.runId}: retained run placeholder is missing`,
			);
		}
		retainedPlaceholder = run.tasks[runPlaceholderIndex];
		if (presentRunTasks.length === 0) {
			run.tasks.splice(
				runPlaceholderIndex + 1,
				0,
				...journal.generatedRunTasks,
			);
		}
	}
	if (!retainEmptyPlaceholderDependency) {
		for (const task of run.tasks) {
			if (!task.dependsOn) continue;
			task.dependsOn = replaceDependencyList(
				task.dependsOn,
				journal.placeholderSpecId,
				[...expectedSpecIds],
			);
		}
	}
	synchronizeTerminalBarrierSourceSpecIds(run, compiledFlow);
	if (retainedPlaceholder) {
		setTaskTerminal(
			retainedPlaceholder,
			"completed",
			expectedSpecIds.size === 0 ? "foreach_empty" : "foreach_materialized",
			{
				lastMessage:
					expectedSpecIds.size === 0
						? "foreach produced 0 item(s)"
						: `foreach produced ${expectedSpecIds.size} item(s)`,
			},
		);
	}
	for (const task of run.tasks) {
		if (!expectedRunTaskBySpecId.has(task.specId)) continue;
		const expected = expectedRunTaskBySpecId.get(task.specId)!;
		if (task.taskId !== expected.taskId) {
			throw new Error(
				`Cannot recover foreach materialization for ${run.runId}: task mapping changed for ${task.specId}`,
			);
		}
	}
	const dispatchParent = run.tasks.find(
		(task) =>
			task.specId === journal.placeholderSpecId &&
			task.dispatchMap !== undefined,
	);
	if (dispatchParent) {
		assertArtifactGraphSourceRuntimeMetadataCurrent(
			run,
			dispatchParent,
			createArtifactGraphRuntimeValidationSnapshot(run),
		);
	}
}

export function recoverPreparedForeachMaterializationForTests(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
): boolean {
	const journal = foreachMaterializationJournal(run, compiledFlow);
	if (!journal) return false;
	applyForeachMaterializationJournal(run, compiledFlow, journal);
	delete (run as WorkflowRunWithForeachMaterializationJournal)
		.foreachMaterializationJournal;
	return true;
}
async function recoverPreparedForeachMaterialization(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
): Promise<boolean> {
	const journal = foreachMaterializationJournal(run, compiledFlow);
	if (!journal) return false;
	applyForeachMaterializationJournal(run, compiledFlow, journal);
	await writeJsonAtomic(compiledWorkflowPath(cwd, run.runId), compiledFlow);
	delete (run as WorkflowRunWithForeachMaterializationJournal)
		.foreachMaterializationJournal;
	await writeRunRecord(cwd, run);
	return true;
}

async function persistForeachMaterialization(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	journal: ForeachMaterializationJournal,
): Promise<void> {
	(run as WorkflowRunWithForeachMaterializationJournal).foreachMaterializationJournal =
		journal;
	await writeRunRecord(cwd, run);
	await foreachMaterializationPersistenceHookForTests?.("prepared-run-written");
	applyForeachMaterializationJournal(run, compiledFlow, journal);
	await writeJsonAtomic(compiledWorkflowPath(cwd, run.runId), compiledFlow);
	await foreachMaterializationPersistenceHookForTests?.("compiled-written");
	delete (run as WorkflowRunWithForeachMaterializationJournal)
		.foreachMaterializationJournal;
	await writeRunRecord(cwd, run);
	await foreachMaterializationPersistenceHookForTests?.("run-written");
}
async function materializeForeachTask(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	index: number,
	template: CompiledTask,
	validationSnapshot: ArtifactGraphRuntimeValidationSnapshot,
): Promise<boolean> {
	const templateRunTask = run.tasks[index];
	if (!templateRunTask || !template.foreach || !template.stageId) return false;

	const sourceStageIds = sourceStageIdsForFrom(template.foreach.from);
	const sourceTasks = run.tasks.filter((task) =>
		sourceStageIds.includes(task.stageId ?? ""),
	);
	const streaming = foreachStreamingEnabled(template);
	const dispatchContext = foreachDispatchMapContext(template, sourceTasks);
	if (dispatchContext && "error" in dispatchContext) {
		setTaskTerminal(templateRunTask, "blocked", "foreach_expansion_blocked", {
			lastMessage: dispatchContext.error,
		});
		await writeRunRecord(cwd, run);
		return true;
	}
	if (streaming && dispatchContext) {
		setTaskTerminal(templateRunTask, "blocked", "foreach_expansion_blocked", {
			lastMessage:
				"foreach itemIdentityPath does not support streaming materialization",
		});
		await writeRunRecord(cwd, run);
		return true;
	}
	const extracted = await extractArtifactGraphForeachItems(
		cwd,
		run,
		{
			from: template.foreach.from,
			sourcePolicy: stageSourcePolicy(compiledFlow, template.stageId),
			maxItems: template.foreach.maxItems,
			streaming,
		},
		sourceTasks,
		validationSnapshot,
	);

	if (extracted.error) {
		setTaskTerminal(templateRunTask, "blocked", "foreach_expansion_blocked", {
			lastMessage: extracted.error,
		});
		await writeRunRecord(cwd, run);
		return true;
	}

	const items = extracted.items ?? [];
	const itemMetas = extracted.itemMetas ?? [];
	const sourceTaskBySpecId = new Map(sourceTasks.map((task) => [task.specId, task]));
	const lineages = itemMetas.map((meta) => {
		const upstream = sourceTaskBySpecId.get(meta.sourceSpecId)?.foreachGenerated
			?.sourceLineageDigest;
		return canonicalForeachSourceLineage(meta.sourceSpecId, upstream);
	});
	const generated = buildForeachGeneratedTasks(
		template,
		compiledFlow.task,
		items,
		itemMetas.length === items.length
			? {
					lineages,
					reservedSpecIds: new Set(
						compiledFlow.tasks
							.filter(
								(task) =>
									task.foreachGenerated?.placeholderSpecId !== template.id,
							)
							.map((task) => compiledTaskSpecId(task)),
					),
				}
			: undefined,
	);
	if (generated.error) {
		setTaskTerminal(templateRunTask, "blocked", "foreach_expansion_blocked", {
			lastMessage: generated.error,
		});
		await writeRunRecord(cwd, run);
		return true;
	}

	const generatedWithItemMetadata =
		streaming || dispatchContext
			? generatedTasksWithItemMetadata(
					generated.tasks,
					extracted.itemMetas ?? [],
				)
			: { tasks: generated.tasks };
	if (generatedWithItemMetadata.error || !generatedWithItemMetadata.tasks) {
		setTaskTerminal(templateRunTask, "blocked", "foreach_expansion_blocked", {
			lastMessage:
				generatedWithItemMetadata.error ??
				"foreach generated task metadata is incomplete",
		});
		await writeRunRecord(cwd, run);
		return true;
	}
	const generatedTasks = generatedTasksWithSourceGeneration(
		generatedWithItemMetadata.tasks,
		dispatchContext,
	);
	const placeholderSpecId = template.id;
	const existingCompiledTasksBySpecId = new Map(
		compiledFlow.tasks.map((task) => [compiledTaskSpecId(task), task]),
	);
	const generatedSpecCollision = generatedTasks.find((task) => {
		const existing = existingCompiledTasksBySpecId.get(task.id);
		return (
			task.id === placeholderSpecId ||
			(existing !== undefined &&
				(!streaming ||
					existing.foreachGenerated?.placeholderSpecId !== placeholderSpecId))
		);
	});
	if (generatedSpecCollision) {
		setTaskTerminal(templateRunTask, "blocked", "foreach_expansion_blocked", {
			lastMessage: `foreach generated task id "${generatedSpecCollision.id}" collides with an existing compiled task`,
		});
		await writeRunRecord(cwd, run);
		return true;
	}
	if (streaming) {
		return await materializeStreamingForeachTask({
			cwd,
			run,
			compiledFlow,
			index,
			templateRunTask,
			placeholderSpecId,
			sourceTaskSpecIds: sourceTasks.map((task) => task.specId),
			itemMetas: extracted.itemMetas ?? [],
			generatedTasks,
			waitingForSources: extracted.waitingForSources ?? false,
			minChunk: foreachStreamingMinChunk(template),
			partialLedgerPathsBySourceSpecId:
				extracted.partialLedgerPathsBySourceSpecId ?? new Map(),
		});
	}
	const generatedSpecIds = generatedTasks.map((task) => task.id);
	const hasDownstreamDependents = compiledFlow.tasks.some(
		(task, taskIndex) =>
			taskIndex !== index && (task.dependsOn ?? []).includes(placeholderSpecId),
	);
	if (
		!dispatchContext &&
		generatedSpecIds.length === 0 &&
		!hasDownstreamDependents
	) {
		setTaskTerminal(templateRunTask, "completed", "foreach_empty", {
			lastMessage: "foreach produced 0 item(s)",
		});
		await writeRunRecord(cwd, run);
		return true;
	}

function globalForeachDispatchCollision(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	generatedTasks: readonly CompiledTask[],
	generatedRunTasks: readonly WorkflowTaskRunRecord[],
): string | undefined {
	const taskIdOwner = new Map<string, string>();
	for (const task of run.tasks) {
		const owner = taskIdOwner.get(task.taskId);
		if (owner !== undefined) {
			return `workflow task id "${task.taskId}" is globally ambiguous between ${owner} and ${task.specId}`;
		}
		taskIdOwner.set(task.taskId, task.specId);
	}
	for (const task of generatedRunTasks) {
		const owner = taskIdOwner.get(task.taskId);
		if (owner !== undefined) {
			return `foreach generated task id "${task.taskId}" collides with ${owner}`;
		}
		taskIdOwner.set(task.taskId, task.specId);
	}

	const specIdOwner = new Map<string, string>();
	for (const task of compiledFlow.tasks) {
		const specId = compiledTaskSpecId(task);
		const owner = specIdOwner.get(specId);
		if (owner !== undefined) {
			return `compiled task spec id "${specId}" is globally ambiguous`;
		}
		specIdOwner.set(specId, specId);
	}
	for (const task of generatedTasks) {
		const owner = specIdOwner.get(task.id);
		if (owner !== undefined) {
			return `foreach generated spec id "${task.id}" collides with ${owner}`;
		}
		specIdOwner.set(task.id, task.id);
	}
	return undefined;
}

	const nextIndex = nextTaskRecordIndex(run);
	const generatedRunTasks = generatedTasks.map((task, offset) =>
		createTaskRunRecord(cwd, run.runId, task, nextIndex + offset),
	);
	if (dispatchContext) {
		const collision = globalForeachDispatchCollision(
			run,
			compiledFlow,
			generatedTasks,
			generatedRunTasks,
		);
		if (collision) {
			setTaskTerminal(templateRunTask, "blocked", "foreach_expansion_blocked", {
				lastMessage: collision,
			});
			await writeRunRecord(cwd, run);
			return true;
		}
	}
	if (dispatchContext) {
		const dispatchMapError = attachForeachDispatchMap(
			templateRunTask,
			dispatchContext,
			generatedTasks,
			generatedRunTasks,
		);
		if (dispatchMapError) {
			setTaskTerminal(templateRunTask, "blocked", "foreach_expansion_blocked", {
				lastMessage: dispatchMapError,
			});
			await writeRunRecord(cwd, run);
			return true;
		}
	}
	await persistForeachMaterialization(cwd, run, compiledFlow, {
		status: "prepared",
		placeholderSpecId,
		replacePlaceholder: !dispatchContext && generatedTasks.length > 0,
		generatedTasks,
		generatedRunTasks,
	});
	return true;
}

function sameForeachIdentityTuple(
	left: CompiledTask["foreachGenerated"] | undefined,
	right: CompiledTask["foreachGenerated"] | undefined,
): boolean {
	return (
		left?.placeholderSpecId === right?.placeholderSpecId &&
		left?.itemIdentity === right?.itemIdentity &&
		left?.itemHash === right?.itemHash &&
		left?.itemSourceTaskId === right?.itemSourceTaskId &&
		left?.itemSourceSpecId === right?.itemSourceSpecId &&
		left?.itemSourceKind === right?.itemSourceKind &&
		left?.itemRef === right?.itemRef &&
		left?.sourceLineageDigest === right?.sourceLineageDigest &&
		left?.resolvedTaskId === right?.resolvedTaskId &&
		left?.perItemDispatch === right?.perItemDispatch
	);
}

function sameStreamingFinalIdentityAndHash(
	left: CompiledTask["foreachGenerated"] | undefined,
	right: CompiledTask["foreachGenerated"] | undefined,
	leftSpecId: string,
	rightSpecId: string,
): boolean {
	const leftHash = left?.itemHash;
	const rightHash = right?.itemHash;
	return (
		left?.itemSourceKind === "partial" &&
		right?.itemSourceKind === "control" &&
		left?.placeholderSpecId === right?.placeholderSpecId &&
		stableForeachItemIdentity(left, leftSpecId) ===
			stableForeachItemIdentity(right, rightSpecId) &&
		typeof leftHash === "string" &&
		leftHash !== "" &&
		leftHash === rightHash &&
		typeof left?.itemSourceTaskId === "string" &&
		left.itemSourceTaskId !== "" &&
		left.itemSourceTaskId === right?.itemSourceTaskId &&
		typeof left.itemSourceSpecId === "string" &&
		left.itemSourceSpecId !== "" &&
		left.itemSourceSpecId === right?.itemSourceSpecId
	);
}

function stableForeachItemIdentity(
	item: CompiledTask["foreachGenerated"] | undefined,
	specId: string,
): string {
	return item?.itemIdentity ?? specId;
}

function matchStreamingFinalEvidence(
	existingTasks: readonly CompiledTask[],
	finalTasks: readonly CompiledTask[],
	exactMatches: Map<CompiledTask, CompiledTask>,
): string | undefined {
	const finalTasksByIdentity = new Map<string, CompiledTask[]>();
	for (const finalTask of finalTasks) {
		const identity = stableForeachItemIdentity(
			finalTask.foreachGenerated,
			finalTask.id,
		);
		const matches = finalTasksByIdentity.get(identity) ?? [];
		matches.push(finalTask);
		finalTasksByIdentity.set(identity, matches);
	}
	for (const existingTask of existingTasks) {
		if (existingTask.foreachGenerated?.itemSourceKind !== "partial") continue;
		const identity = stableForeachItemIdentity(
			existingTask.foreachGenerated,
			existingTask.id,
		);
		const matches = finalTasksByIdentity.get(identity) ?? [];
		if (matches.length === 0) {
			return `foreach streaming item ${existingTask.id} was published as partial output but is missing from final control`;
		}
		if (matches.length !== 1) {
			return `foreach streaming item ${existingTask.id} has duplicate final control evidence`;
		}
		const finalTask = matches[0]!;
		if (
			!sameStreamingFinalIdentityAndHash(
				existingTask.foreachGenerated,
				finalTask.foreachGenerated,
				existingTask.id,
				finalTask.id,
			)
		) {
			return `foreach streaming item ${existingTask.id} changed after materialization`;
		}
		if (exactMatches.has(finalTask)) {
			return `foreach streaming item ${existingTask.id} has duplicate final control evidence`;
		}
		exactMatches.set(finalTask, existingTask);
	}
	return undefined;
}

export function streamingFinalEvidenceErrorForTests(
	existingTasks: readonly CompiledTask[],
	finalTasks: readonly CompiledTask[],
): string | undefined {
	return matchStreamingFinalEvidence(existingTasks, finalTasks, new Map());
}
async function materializeStreamingForeachTask(input: {
	cwd: string;
	run: WorkflowRunRecord;
	compiledFlow: CompiledWorkflow;
	index: number;
	templateRunTask: WorkflowTaskRunRecord;
	placeholderSpecId: string;
	sourceTaskSpecIds: string[];
	itemMetas: ForeachExtractedItemMeta[];
	generatedTasks: CompiledTask[];
	waitingForSources: boolean;
	minChunk: number;
	partialLedgerPathsBySourceSpecId: Map<string, ReadonlySet<string>>;
}): Promise<boolean> {
	const sourceTaskSpecIdSet = new Set(input.sourceTaskSpecIds);
	const perItemDispatch = workflowExperimentalFlagEnabled(
		PER_ITEM_DISPATCH_ENV,
	);
	const existingGeneratedTasks = input.compiledFlow.tasks.filter(
		(task) =>
			task.foreachGenerated?.placeholderSpecId === input.placeholderSpecId,
	);
	const existingGeneratedTaskBySpecId = new Map(
		existingGeneratedTasks.map((task) => [task.id, task]),
	);
	const ambiguousLegacy = existingGeneratedTasks.find((existing) => {
		if (existing.foreachGenerated?.sourceLineageDigest) return false;
		const legacyIdentity = stableForeachItemIdentity(
			existing.foreachGenerated,
			existing.id,
		);
		return input.generatedTasks.some(
			(candidate) =>
				candidate.foreachGenerated?.resolvedTaskId !== undefined &&
				stableForeachItemIdentity(candidate.foreachGenerated, candidate.id) ===
					legacyIdentity,
		);
	});
	if (ambiguousLegacy) {
		setTaskTerminal(
			input.templateRunTask,
			"blocked",
			"foreach_expansion_blocked",
			{
				lastMessage: `foreach legacy item ${ambiguousLegacy.id} has ambiguous sibling-source lineage`,
			},
		);
		await writeRunRecord(input.cwd, input.run);
		return true;
	}
	const generatedTasksWithItemDeps = input.generatedTasks.map((task, index) => {
		const itemMeta = input.itemMetas[index];
		if (!itemMeta) return task;
		const needsCompletedSourceContext =
			partialGeneratedTaskNeedsCompletedSourceContext(task);
		// Opt-in per-item dispatch: a partial child whose stage needs a
		// sourceProjection of the producer control may still activate before the
		// producer completes, but only when every projection path is already
		// satisfiable from the producer's published partial output ledger.
		// Otherwise the child defers on the completed producer (default W4-safe
		// behavior). The decision is made once at materialization and persisted.
		const existingTask = existingGeneratedTaskBySpecId.get(task.id);
		const perItemActivated =
			existingTask !== undefined
				? existingTask.foreachGenerated?.perItemDispatch === true
				: perItemDispatch &&
					itemMeta.sourceKind === "partial" &&
					itemMeta.itemId === task.foreachGenerated?.itemIdentity &&
					needsCompletedSourceContext &&
					perItemProjectionSatisfiableFromPartials(
						task,
						input.partialLedgerPathsBySourceSpecId.get(itemMeta.sourceSpecId),
					);
		const dependsOn = replaceSourceDependenciesWithItemSource(
			task.dependsOn ?? [],
			sourceTaskSpecIdSet,
			itemMeta,
			{
				keepPartialSourceDependency:
					needsCompletedSourceContext && !perItemActivated,
			},
		);
		return {
			...task,
			dependsOn,
			...(perItemActivated
				? {
						contextDependsOn: [
							...new Set([...dependsOn, itemMeta.sourceSpecId]),
						],
					}
				: {}),
			foreachGenerated: {
				...(task.foreachGenerated ?? {
					placeholderSpecId: input.placeholderSpecId,
				}),
				itemHash: itemMeta.itemHash,
				itemSourceTaskId: itemMeta.sourceTaskId,
				itemSourceSpecId: itemMeta.sourceSpecId,
				itemSourceKind: itemMeta.sourceKind,
				itemRef: itemMeta.itemRef,
				...(perItemActivated ? { perItemDispatch: true as const } : {}),
			},
		};
	});
	const existingGeneratedSpecIds = existingGeneratedTasks.map(
		(task) => task.id,
	);
	const exactPartialMatches = new Map<CompiledTask, CompiledTask>();
	if (!input.waitingForSources) {
		const finalEvidenceError = matchStreamingFinalEvidence(
			existingGeneratedTasks,
			generatedTasksWithItemDeps,
			exactPartialMatches,
		);
		if (finalEvidenceError) {
			setTaskTerminal(
				input.templateRunTask,
				"blocked",
				"foreach_expansion_blocked",
				{ lastMessage: finalEvidenceError },
			);
			await writeRunRecord(input.cwd, input.run);
			return true;
		}
	}
	for (const task of generatedTasksWithItemDeps) {
		const existing =
			existingGeneratedTaskBySpecId.get(task.id) ??
			exactPartialMatches.get(task);
		if (
			existing &&
			!sameForeachIdentityTuple(
				existing.foreachGenerated,
				task.foreachGenerated,
			) &&
			!sameStreamingFinalIdentityAndHash(
				existing.foreachGenerated,
				task.foreachGenerated,
				existing.id,
				task.id,
			)
		) {
			setTaskTerminal(
				input.templateRunTask,
				"blocked",
				"foreach_expansion_blocked",
				{
					lastMessage: `foreach streaming item ${task.id} changed after materialization`,
				},
			);
			await writeRunRecord(input.cwd, input.run);
			return true;
		}
	}
	const newGeneratedTasks = generatedTasksWithItemDeps.filter(
		(task) =>
			!existingGeneratedTaskBySpecId.has(task.id) &&
			!exactPartialMatches.has(task),
	);
	const allGeneratedSpecIds = [
		...existingGeneratedSpecIds,
		...newGeneratedTasks.map((task) => task.id),
	];
	const shouldHoldForMinChunk =
		input.waitingForSources &&
		newGeneratedTasks.length > 0 &&
		newGeneratedTasks.length < input.minChunk;
	if (shouldHoldForMinChunk) return false;

	let changed = false;
	if (newGeneratedTasks.length > 0) {
		let compiledInsertIndex = input.index + 1;
		while (
			input.compiledFlow.tasks[compiledInsertIndex]?.foreachGenerated
				?.placeholderSpecId === input.placeholderSpecId
		) {
			compiledInsertIndex += 1;
		}
		input.compiledFlow.tasks.splice(
			compiledInsertIndex,
			0,
			...newGeneratedTasks,
		);

		let runInsertIndex = input.index + 1;
		while (
			input.run.tasks[runInsertIndex]?.foreachGenerated?.placeholderSpecId ===
			input.placeholderSpecId
		) {
			runInsertIndex += 1;
		}
		const nextIndex = nextTaskRecordIndex(input.run);
		const generatedRunTasks = newGeneratedTasks.map((task, offset) =>
			createTaskRunRecord(input.cwd, input.run.runId, task, nextIndex + offset),
		);
		input.run.tasks.splice(runInsertIndex, 0, ...generatedRunTasks);
		changed = true;
	}

	const dependencyTargets = [input.placeholderSpecId, ...allGeneratedSpecIds];
	for (const task of input.compiledFlow.tasks) {
		if (task.dependsOn) {
			const replaced = replaceDependencyList(
				task.dependsOn,
				input.placeholderSpecId,
				dependencyTargets,
			);
			if (JSON.stringify(task.dependsOn) !== JSON.stringify(replaced)) {
				task.dependsOn = replaced;
				changed = true;
			}
		}
		if (task.contextDependsOn) {
			const replaced = replaceDependencyList(
				task.contextDependsOn,
				input.placeholderSpecId,
				dependencyTargets,
			);
			if (JSON.stringify(task.contextDependsOn) !== JSON.stringify(replaced)) {
				task.contextDependsOn = replaced;
				changed = true;
			}
		}
	}
	for (const task of input.run.tasks) {
		if (!task.dependsOn) continue;
		const replaced = replaceDependencyList(
			task.dependsOn,
			input.placeholderSpecId,
			dependencyTargets,
		);
		if (JSON.stringify(task.dependsOn) !== JSON.stringify(replaced)) {
			task.dependsOn = replaced;
			changed = true;
		}
	}
	if (
		synchronizeTerminalBarrierSourceSpecIds(input.run, input.compiledFlow)
	) {
		changed = true;
	}

	if (!input.waitingForSources) {
		const statusDetail =
			allGeneratedSpecIds.length === 0
				? "foreach_empty"
				: "foreach_streaming_complete";
		const lastMessage =
			allGeneratedSpecIds.length === 0
				? "foreach produced 0 item(s)"
				: `foreach streaming materialized ${allGeneratedSpecIds.length} item(s)`;
		setTaskTerminal(input.templateRunTask, "completed", statusDetail, {
			lastMessage,
		});
		changed = true;
	} else if (newGeneratedTasks.length > 0) {
		input.templateRunTask.statusDetail = "foreach_streaming_waiting";
		input.templateRunTask.lastMessage = `foreach streaming materialized ${allGeneratedSpecIds.length} item(s); waiting for more source tasks`;
		changed = true;
	}

	if (!changed) return false;
	await writeJsonAtomic(
		compiledWorkflowPath(input.cwd, input.run.runId),
		input.compiledFlow,
	);
	await writeRunRecord(input.cwd, input.run);
	return true;
}

function replaceSourceDependenciesWithItemSource(
	dependsOn: string[],
	sourceTaskSpecIds: Set<string>,
	itemMeta: ForeachExtractedItemMeta,
	options: { keepPartialSourceDependency?: boolean } = {},
): string[] {
	const replaced: string[] = [];
	let inserted = false;
	const shouldReplaceWithSource =
		itemMeta.sourceKind !== "partial" ||
		options.keepPartialSourceDependency === true;
	for (const dep of dependsOn) {
		if (!sourceTaskSpecIds.has(dep)) {
			replaced.push(dep);
			continue;
		}
		if (!shouldReplaceWithSource) continue;
		if (!inserted) {
			replaced.push(itemMeta.sourceSpecId);
			inserted = true;
		}
	}
	if (!inserted && shouldReplaceWithSource) {
		replaced.push(itemMeta.sourceSpecId);
	}
	return [...new Set(replaced)];
}

function partialGeneratedTaskNeedsCompletedSourceContext(
	task: CompiledTask,
): boolean {
	const artifactGraph = task.artifactGraph;
	if (artifactGraph?.artifactAccess === "none") return false;
	return Boolean(
		artifactGraph?.sourceProjection !== undefined ||
			(artifactGraph?.requiredReads?.length ?? 0) > 0,
	);
}

// Per-item dispatch eligibility (PI_WORKFLOW_PER_ITEM_DISPATCH only): the
// projection a partial child needs must be fully satisfiable from the
// producer's published partial output ledger. requiredReads can never be
// satisfied before producer completion because the producer artifacts do not
// exist on disk yet, so any required read defers the child to the default
// completed-producer barrier.
function perItemProjectionSatisfiableFromPartials(
	task: CompiledTask,
	publishedPartialPaths: ReadonlySet<string> | undefined,
): boolean {
	const artifactGraph = task.artifactGraph;
	if (!artifactGraph || artifactGraph.artifactAccess === "none") return false;
	if ((artifactGraph.requiredReads?.length ?? 0) > 0) return false;
	if ((artifactGraph.requiredReadPolicy?.length ?? 0) > 0) return false;
	const include = artifactGraph.sourceProjection?.include ?? [];
	if (include.length === 0) return false;
	if (!publishedPartialPaths || publishedPartialPaths.size === 0) return false;
	return include.every((path) => publishedPartialPaths.has(path));
}

interface ForeachExtractedItemMeta {
	sourceTaskId: string;
	sourceSpecId: string;
	sourceKind: "control" | "partial";
	itemHash: string;
	itemRef: string;
	itemId?: string;
}

async function extractArtifactGraphForeachItems(
	cwd: string,
	run: WorkflowRunRecord,
	stage: {
		from: unknown;
		sourcePolicy?: string;
		maxItems?: number;
		streaming?: boolean;
	},
	sourceTasks: WorkflowTaskRunRecord[],
	validationSnapshot: ArtifactGraphRuntimeValidationSnapshot,
): Promise<{
	items?: unknown[];
	itemMetas?: ForeachExtractedItemMeta[];
	error?: string;
	waitingForSources?: boolean;
	partialLedgerPathsBySourceSpecId?: Map<string, ReadonlySet<string>>;
}> {
	const items: unknown[] = [];
	const itemMetas: ForeachExtractedItemMeta[] = [];
	const partialLedgerPathsBySourceSpecId = new Map<
		string,
		ReadonlySet<string>
	>();
	const path = (stage.from as any)?.path;
	if (typeof path !== "string" || !path.startsWith("$.")) {
		return {
			error: "foreach.from.path must be a control JSONPath like $.items",
		};
	}
	let waitingForSources = false;
	for (const task of sourceTasks) {
		assertArtifactGraphSourceRuntimeMetadataCurrent(
			run,
			task,
			validationSnapshot,
		);
		if (task.status !== "completed") {
			if (stage.streaming && !isTerminalTaskStatus(task.status)) {
				const partial = await extractPartialForeachItems(cwd, task, path);
				if (partial.error) return { error: partial.error };
				if (partial.ledgerPaths) {
					partialLedgerPathsBySourceSpecId.set(
						task.specId,
						partial.ledgerPaths,
					);
				}
				for (const item of partial.items) {
					items.push(item.item);
					itemMetas.push({
						sourceTaskId: task.taskId,
						sourceSpecId: task.specId,
						sourceKind: "partial",
						itemHash: item.itemHash,
						itemRef: `${task.specId}:${item.itemRef}`,
						itemId: item.itemId,
					});
				}
				waitingForSources = true;
				continue;
			}
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
			for (const [index, item] of value.entries()) {
				items.push(item);
				itemMetas.push({
					sourceTaskId: task.taskId,
					sourceSpecId: task.specId,
					sourceKind: "control",
					itemHash: hashDynamicRequest(item),
					itemRef: `${task.specId}:control:${path}[${index}]`,
					...(item &&
					typeof item === "object" &&
					typeof (item as { id?: unknown }).id === "string"
						? { itemId: (item as { id: string }).id }
						: {}),
				});
			}
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
	return {
		items,
		itemMetas,
		waitingForSources,
		partialLedgerPathsBySourceSpecId,
	};
}

async function extractPartialForeachItems(
	cwd: string,
	task: WorkflowTaskRunRecord,
	path: string,
): Promise<{
	items: WorkflowPartialOutputItem[];
	ledgerPaths?: ReadonlySet<string>;
	error?: string;
}> {
	const partialPaths = task.artifactGraph?.output.partial?.paths ?? [];
	if (!partialPaths.includes(path)) return { items: [] };
	const taskDir = dirname(fromProjectPath(cwd, task.files.result));
	let ledger = await readWorkflowPartialOutputLedger(taskDir).catch(
		() => undefined,
	);
	if (!ledger) {
		ledger = await writeWorkflowPartialOutputLedgerFromFile({
			taskDir,
			outputFile: fromProjectPath(cwd, task.files.output),
			allowedPaths: partialPaths,
		}).catch(() => undefined);
	}
	if (!ledger) return { items: [] };
	const fatal = hasFatalPartialOutputIssue(ledger);
	if (fatal) return { items: [], error: fatal.message };
	return {
		items: ledger.items.filter((item) => item.path === path),
		ledgerPaths: new Set(ledger.items.map((item) => item.path)),
	};
}

async function persistFinalPromptMetadata(
	cwd: string,
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	launchTask: CompiledTask,
): Promise<void> {
	if (launchTask.artifactGraph?.inputPolicy?.maxCompiledPromptChars === undefined)
		return;
	const measurement = finalCompiledPromptMeasurement(launchTask);
	task.promptMetadata = {
		version: 1,
		chars: measurement.chars,
		...(measurement.maxChars === undefined
			? {}
			: { maxChars: measurement.maxChars }),
		measuredAt: new Date().toISOString(),
	};
	await writeRunRecord(cwd, run);
}

async function launchPendingTaskAt(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	index: number,
	validationSnapshot: ArtifactGraphRuntimeValidationSnapshot,
	options: WorkflowScheduleOptions = {},
	leaseSignal?: AbortSignal,
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
		launchTask = await prepareDagTask(
			cwd,
			run,
			compiledFlow,
			index,
			validationSnapshot,
		);
		await throwIfWorkflowStopRequested(cwd, run.runId);
		if (task.outputRetry) {
			launchTask = await prepareArtifactGraphRetryTask(cwd, task, launchTask);
			await throwIfWorkflowStopRequested(cwd, run.runId);
		}
		assertFinalCompiledPromptWithinCap(launchTask);
		prepareComplete = true;
		await throwIfWorkflowStopRequested(cwd, run.runId);

		if (launchTask.kind === "support") {
			await persistFinalPromptMetadata(cwd, run, task, launchTask);
			return await executeSupportTask(
				cwd,
				run,
				task,
				launchTask,
				validationSnapshot,
			);
		}
		if (launchTask.kind === "dynamic") {
			await persistFinalPromptMetadata(cwd, run, task, launchTask);
			return await executeDynamicControllerTask(
				cwd,
				run,
				compiledFlow,
				index,
				task,
				launchTask,
				options,
				validationSnapshot,
			);
		}
		const worktreeLaunchTask = applyExistingLoopWorktree(run, task, launchTask);
		await ensureManagedWorktree(cwd, run, task, worktreeLaunchTask);
		await throwIfWorkflowStopRequested(cwd, run.runId);
		recordCreatedLoopWorktree(run, task, worktreeLaunchTask);
		await writeRunRecord(cwd, run);
		const backend = resolveWorkflowBackend(run);
		const stop = createWorkflowStopSignal(cwd, run.runId);
		let launch;
		try {
			await throwIfWorkflowStopRequested(cwd, run.runId);
			await persistFinalPromptMetadata(cwd, run, task, worktreeLaunchTask);
			const preparedLaunch = await backend.prepareTaskLaunch(
				cwd,
				run,
				task,
				worktreeLaunchTask,
			);
			const provenance = await createLaunchBootstrapProvenance(
				cwd,
				run,
				task,
				worktreeLaunchTask,
				backend.id,
				preparedLaunch,
			);
			recordLaunchBootstrapProvenance(task, provenance);
			const authority = createWorkflowLaunchAuthority(
				run,
				task,
				backend.id,
				provenance,
			);
			issueWorkflowLaunchAuthority(task, authority);
			const authorizedLaunch = { ...preparedLaunch, authority };
			await writeRunRecord(cwd, run);
			await throwIfWorkflowStopRequested(cwd, run.runId);
			launch = await backend.launchTask(
				cwd,
				run,
				task,
				worktreeLaunchTask,
				leaseSignal,
				stop.signal,
				authorizedLaunch,
			);
		} finally {
			stop.dispose();
		}
		if (launch.kind === "fatal") throw new Error(launch.message);
		if (launch.kind === "capacity") return false;
		return launch.kind === "launched";
	} catch (error) {
		if (leaseSignal?.aborted) throw error;
		if (isWorkflowStopRequestedError(error)) {
			setTaskTerminal(task, "interrupted", "workflow_stopped", {
				exitCode: 130,
				lastMessage: "Workflow stopped by user request",
			});
			await writeRunRecord(cwd, run).catch(() => undefined);
			return false;
		}
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
	validationSnapshot: ArtifactGraphRuntimeValidationSnapshot,
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
		await throwIfWorkflowStopRequested(cwd, run.runId);
		const contentFingerprint = await workflowBundleFingerprint(cwd, run);
		await throwIfWorkflowStopRequested(cwd, run.runId);
		await ensureDynamicControllerInitialized(cwd, run.runId, {
			controllerSpecId: task.specId,
			controllerTaskId: task.taskId,
			stageId: task.stageId,
			dynamic: compiledTask.dynamic,
			contentFingerprint,
		});
		await throwIfWorkflowStopRequested(cwd, run.runId);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (isWorkflowStopRequestedError(error)) {
			await recordDynamicControllerStatus(cwd, run.runId, {
				controllerSpecId: task.specId,
				status: "failed",
				message: "Workflow stopped by user request",
			}).catch(() => undefined);
			setTaskTerminal(task, "interrupted", "workflow_stopped", {
				exitCode: 130,
				lastMessage: "Workflow stopped by user request",
			});
			await writeRunRecord(cwd, run);
			return false;
		}
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
		await throwIfWorkflowStopRequested(cwd, run.runId);
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
	await throwIfWorkflowStopRequested(cwd, run.runId);
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
	await throwIfWorkflowStopRequested(cwd, run.runId);
	await recordDynamicControllerStatus(cwd, run.runId, {
		controllerSpecId: task.specId,
		status: "running",
	});
	await throwIfWorkflowStopRequested(cwd, run.runId);

	const sources = compiledTask.artifactGraph?.enabled
		? await readArtifactGraphSupportSources(
				cwd,
				run,
				compiledTask.dependsOn ?? [],
				validationSnapshot,
			)
		: await readSupportSources(cwd, run, compiledTask.dependsOn ?? []);
	await throwIfWorkflowStopRequested(cwd, run.runId);

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

	const stop = createWorkflowStopSignal(cwd, run.runId);
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
			stopSignal: stop.signal,
		});
		await throwIfWorkflowStopRequested(cwd, run.runId);
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
		await throwIfWorkflowStopRequested(cwd, run.runId);
		await recordActiveRuntime();
		await throwIfWorkflowStopRequested(cwd, run.runId);
		const unrunBranchBlockers = await dynamicUnrunBranchBlockers(
			cwd,
			run.runId,
			task.specId,
		);
		await throwIfWorkflowStopRequested(cwd, run.runId);
		const outputForOutcome =
			unrunBranchBlockers.length > 0
				? dynamicControllerOutputWithBranchBlockers(
						structuredOutput,
						unrunBranchBlockers,
					)
				: structuredOutput;
		const outcome = dynamicControllerOutcomeFromOutput(outputForOutcome);
		await dynamicControllerTestHooks.beforeDynamicResultCommit?.({
			cwd,
			runId: run.runId,
			controllerSpecId: task.specId,
			taskId: task.taskId,
		});
		if (compiledTask.artifactGraph?.enabled) {
			await throwIfWorkflowStopRequested(cwd, run.runId);
			await writeArtifactGraphDynamicResult(
				cwd,
				task,
				outputForOutcome,
				outcome.lifecycleStatus,
			);
		} else {
			await throwIfWorkflowStopRequested(cwd, run.runId);
			await mkdir(dirname(fromProjectPath(cwd, task.files.output)), {
				recursive: true,
			});
			await throwIfWorkflowStopRequested(cwd, run.runId);
			await writeFile(
				fromProjectPath(cwd, task.files.output),
				`${JSON.stringify(outputForOutcome, null, 2)}\n`,
				"utf8",
			);
			await throwIfWorkflowStopRequested(cwd, run.runId);
			await writeFile(fromProjectPath(cwd, task.files.stderr), "", "utf8");
			await throwIfWorkflowStopRequested(cwd, run.runId);
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
		if (
			outcome.taskStatus === "completed" &&
			run.provenance?.mode === "direct-dynamic"
		) {
			run.dynamicAudit = await auditDirectDynamicControllerRun(
				cwd,
				run,
				task,
				outputForOutcome,
			);
		}
		await writeRunRecord(cwd, run);
		return outcome.taskStatus === "completed";
	} catch (error) {
		await recordActiveRuntime();
		if (stop.signal.aborted || isWorkflowStopRequestedError(error)) {
			await recordDynamicControllerStatus(cwd, run.runId, {
				controllerSpecId: task.specId,
				status: "failed",
				message: "Workflow stopped by user request",
			}).catch(() => undefined);
			setTaskTerminal(task, "interrupted", "workflow_stopped", {
				exitCode: 130,
				lastMessage:
					"Workflow stopped by user request (cooperative dynamic cancellation)",
			});
			await writeRunRecord(cwd, run);
			return false;
		}
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
	} finally {
		stop.dispose();
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
	stopSignal?: AbortSignal;
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
	const budgetRemaining = await currentDynamicBudgetRemaining(input);
	const replayPrefix = {
		opIds: await priorDynamicOperationOpIds(input),
		cursor: 0,
	};
	await dynamicControllerTestHooks.beforeControllerWorkerLaunch?.({
		cwd: input.cwd,
		runId: input.run.runId,
		controllerSpecId: input.controllerTask.specId,
		taskId: input.controllerTask.taskId,
	});
	await throwIfWorkflowStopRequested(input.cwd, input.run.runId);
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
			budgetRemaining,
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
	let settled = false;
	let currentGeneratedTaskIds = generatedTaskIds;
	const timeoutMs = remainingDynamicRuntimeMs(
		input.dynamic,
		state.controllers[input.controllerTask.specId]?.counters.runtimeMs ?? 0,
	);

	return await new Promise<unknown>((resolvePromise, rejectPromise) => {
		let opQueue = Promise.resolve();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			input.stopSignal?.removeEventListener("abort", abortStop);
			worker.removeAllListeners();
			void worker.terminate().catch(() => undefined);
			callback();
		};
		const abortStop = (): void => {
			finish(() => rejectPromise(input.stopSignal?.reason));
		};
		if (input.stopSignal?.aborted) {
			abortStop();
			return;
		}
		input.stopSignal?.addEventListener("abort", abortStop, { once: true });
		timer = setTimeout(
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
					postResult: (id, result) => {
						if (settled) return;
						worker.postMessage({
							type: "opResult",
							id,
							generatedTaskIds: currentGeneratedTaskIds,
							...result,
						});
					},
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
		stopSignal?: AbortSignal;
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
				stopSignal: input.stopSignal,
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
		if (state.isSettled()) return;
		if (isWorkflowStopRequestedError(error) || input.stopSignal?.aborted) {
			state.finish(() => state.reject(error));
			return;
		}
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
	cwd?: string;
	runId?: string;
	stopSignal?: AbortSignal;
}): Promise<unknown> {
	if (input.stopSignal?.aborted) throw input.stopSignal.reason;
	const resolved = await resolveWorkflowHelperRef(input.ref, input.specPath);
	if (input.stopSignal?.aborted) throw input.stopSignal.reason;
	if (input.cwd && input.runId) {
		await throwIfWorkflowStopRequested(input.cwd, input.runId);
	}
	if (input.stopSignal?.aborted) throw input.stopSignal.reason;
	const worker = new Worker(DYNAMIC_HELPER_WORKER_SOURCE, {
		eval: true,
		workerData: {
			helperUrl: pathToFileURL(resolved.path).href,
			callInput: input.callInput,
		},
	});
	let settled = false;
	return await new Promise<unknown>((resolvePromise, rejectPromise) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			input.stopSignal?.removeEventListener("abort", abortStop);
			worker.removeAllListeners();
			void worker.terminate().catch(() => undefined);
			callback();
		};
		const abortStop = (): void => {
			finish(() => rejectPromise(input.stopSignal?.reason));
		};
		if (input.stopSignal?.aborted) {
			abortStop();
			return;
		}
		input.stopSignal?.addEventListener("abort", abortStop, { once: true });
		timer = setTimeout(
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

/**
 * Fail-open claim-support audit for the built-in direct dynamic path. Runs
 * after the controller's synthesis result is finalized; errors are recorded
 * as `{ error }` on the run record and never fail the run.
 */
async function auditDirectDynamicControllerRun(
	cwd: string,
	run: WorkflowRunRecord,
	controllerTask: WorkflowTaskRunRecord,
	structuredOutput: unknown,
): Promise<WorkflowRunRecord["dynamicAudit"]> {
	try {
		const { control } = normalizeDynamicControllerOutput(structuredOutput);
		const outputTaskIds = new Set(
			dynamicControlStringArray(control.outputTasks),
		);
		const generated = run.tasks.filter(
			(candidate) =>
				candidate.dynamicGenerated?.controllerSpecId === controllerTask.specId,
		);
		const synthesisTasks = generated.filter((candidate) =>
			outputTaskIds.size > 0
				? outputTaskIds.has(candidate.specId)
				: candidate.dynamicGenerated?.outputProfile === "synthesis_v1",
		);
		const synthesisSpecIds = new Set(
			synthesisTasks.map((candidate) => candidate.specId),
		);
		const synthesis: DynamicAuditSynthesisInput[] = [];
		for (const candidate of synthesisTasks) {
			if (candidate.status !== "completed") continue;
			synthesis.push({
				taskId: candidate.specId,
				control: await readArtifactGraphControl(cwd, candidate).catch(
					() => undefined,
				),
			});
		}
		const collected: DynamicAuditCollectedRefsInput[] = [];
		for (const candidate of generated) {
			if (candidate.status !== "completed") continue;
			if (synthesisSpecIds.has(candidate.specId)) continue;
			collected.push({
				taskId: candidate.taskId,
				specId: candidate.specId,
				refs: await readJson(
					join(
						dirname(fromProjectPath(cwd, candidate.files.result)),
						"refs.json",
					),
				).catch(() => undefined),
			});
		}
		return auditDynamicClaimSupport({ synthesis, collected });
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
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

export async function runWorkflow(
	specPath: string,
	cwd: string,
	options: WorkflowRunOptions = {},
): Promise<WorkflowRunRecord> {
	if (!options.task || options.task.trim() === "")
		throw new Error("This workflow needs a task");
	return runWorkflowSpec(specPath, cwd, options);
}
