import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { appendFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
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
	assertValidWorkflowRunLaunchCapture,
	assertWorkflowRunAvailable,
	createRunRecord,
	deriveRunStatus,
	createTaskRunRecord,
	compiledWorkflowPath,
	readCompiledWorkflow,
	FAIL_FAST_CANCELLED_STATUS_DETAIL,
	fromProjectPath,
	initializeRunRecordDirectories,
	isBlockedTaskResumableForResume,
	invalidateTaskForDependencyResume,
	isTerminalWorkflowStatus,
	isTerminalTaskStatus,
	listRunRecords,
	readIndex,
	makeRunId,
	readJson,
	readRunRecord,
	readWorkflowStopIntent,
	requestWorkflowStop,
	prepareWorkflowLaunchCommandArtifactPath,
	resetTaskForResume,
	setTaskTerminal,
	clearWorkflowStopIntent,
	toProjectPath,
	updateIndex,
	withRunLease,
	outsideRunLeaseContext,
	workflowRunPath,
	writeCompiledRunArtifact,
	writeJsonAtomic,
	writeJsonExclusive,
	syncFileAndDirectory,
	writeRunRecord as writeOriginalRunRecord,
	writeStaticRunArtifacts,
	writeWorkflowLaunchCommandArtifact,
} from "./store.js";
import { resolveWorkflowBackend } from "./backend.js";
import { workflowTaskAttemptIdentity, workflowTaskSessionId } from "./launch-session.js";
import { readPublishedWorkflowGoalPolicyControl } from "./goal-workflow-evidence.js";

function retainedPublishedWorkflowGoalEvidenceRefs(input: {
	control: Record<string, unknown>;
	run: WorkflowRunRecord;
	task: WorkflowTaskRunRecord;
	goalId: string;
	contractHash: string;
}): string[] {
	const { control, run, task } = input;
	if (control.schema !== "goal-policy-result-v1" ||
		control.goalId !== input.goalId ||
		control.contractHash !== input.contractHash)
		throw new Error("Goal prior policy publication identity mismatch");
	const directory = `.pi/workflows/${run.runId}/tasks/${task.taskId}/goal-evidence`;
	const scoped = (value: unknown): value is string =>
		typeof value === "string" &&
		new RegExp(`^${directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[a-f0-9]{64}\\.json$`).test(value);
	const current = control.evidenceRefs;
	const retained = control.retainedEvidenceRefs;
	if (!Array.isArray(current) || current.length !== 1 || !current.every(scoped) ||
		!Array.isArray(retained) || retained.length === 0 || !retained.every(scoped) ||
		new Set(retained).size !== retained.length || !retained.includes(current[0]) ||
		!control.oracle || typeof control.oracle !== "object" || Array.isArray(control.oracle))
		throw new Error("Goal prior policy publication references mismatch");
	return [...retained];
}

/** Content-addressed task artifacts are observations, never admission authority. */
export async function persistWorkflowGoalOracleEvidence(input: {
	cwd: string; run: WorkflowRunRecord; task: WorkflowTaskRunRecord;
	evidence: Readonly<Record<string, unknown>>; generation: number | null;
	stopSignal: AbortSignal; assertCurrent: () => Promise<void>;
}): Promise<string> {
	const current = async () => { input.stopSignal.throwIfAborted(); await input.assertCurrent(); input.stopSignal.throwIfAborted(); };
	await current();
	if (resolve(input.cwd) !== resolve(input.run.cwd) || input.evidence.cwd !== resolve(input.cwd) ||
		input.evidence.runId !== input.run.runId || input.evidence.policySpecId !== input.task.specId)
		throw new Error("Goal oracle evidence original execution binding changed");
	const evidence = { ...input.evidence, policyTaskId: input.task.taskId, generation: input.generation,
		policyAttemptKey: workflowTaskAttemptIdentity(input.task, workflowTaskSessionId(input.run, input.task)) };
	const digest = workflowDefinitionFingerprint(evidence);
	const file = join(dirname(fromProjectPath(input.cwd, input.task.files.result)), "goal-evidence", `${digest}.json`);
	await writeJsonExclusive(file, { schema: "goal-oracle-receipt-v1", digest, evidence }, input.stopSignal, current);
	await current();
	const stored = await readJson<{ digest: string; evidence: unknown }>(file);
	await current();
	if (!stored || stored.digest !== digest || workflowDefinitionFingerprint(stored.evidence) !== digest)
		throw new Error("Goal oracle evidence publication mismatch or uncertainty");
	await syncFileAndDirectory(file);
	await current();
	return toProjectPath(input.cwd, file);
}
import {
	assertNoProtectedGoalEngineArtifacts,
	assertNotProtectedGoalEngineRun,
	isProtectedGoalEngineRun,
} from "./goal-protected-legacy.js";
import {
	goalCompiledMaterializationDigest,
	persistGoalGeneratedMaterialization as persistOriginalGoalGeneratedMaterialization,
	recoverGoalGeneratedMaterialization,
} from "./goal-generated-materialization.js";
import { goalHash } from "./goal-json.js";

import { assertHumanFamilyKnown, assertPreparedWorkflowGoalPolicyCurrent, assertWorkflowGoalProfileConfigurationCurrent, beginWorkflowGoalInitializationBindings, bindWorkflowGoalRequestTask, bindWorkflowGoalCandidateWorker, captureWorkflowGoalScopedTaskRuntime, captureWorkflowEngineGoalVerifierTask, observeWorkflowGoalCandidate, applyWorkflowGoalCandidateToOrigin, completeWorkflowGoalInitializationBindings, executeWorkflowEngineGoalPolicy, markWorkflowGoalProfilePublicationUnknown, prepareWorkflowEngineGoalRootPlanner, prepareWorkflowEngineGoalWorkers, prepareWorkflowEngineGoalVerifiers, prepareWorkflowEngineGoalVerifierRequest, prepareWorkflowEngineGoalReplanner, prepareWorkflowEngineGoalResume, prepareWorkflowGoalPolicy, prepareWorkflowGoalRootMaterializationPublication, publishWorkflowGoalProfileConfiguration, revokeWorkflowGoalInitializationBindings, workflowGoalProfileConfiguration, workflowEngineGoalAgentDefinitions, workflowEngineGoalVerifierSnapshot, captureWorkflowGoalHumanReview, consumeWorkflowGoalHumanReview, revokeWorkflowGoalHumanReview, type PreparedWorkflowGoalPolicyAdmission, type PreparedWorkflowGoalVerifierRequest, type WorkflowGoalPolicyHost } from "./goal-workflow-runtime.js";
import type { WorkflowGoalOriginApplyRecord } from "./goal-workflow-origin-apply.js";
import {
	assertWorkflowGoalProfileExceptionCurrent,
	goalPolicyRequest,
	goalWorkerUserGuidance,
	captureWorkflowGoalChildProfileException,
	captureWorkflowGoalProfileException,
	discardWorkflowGoalProfileException,
	previewWorkflowGoalProfileException,
	recheckWorkflowGoalProfileExceptionSources,
	stageWorkflowGoalProfileException,
	workflowGoalChildProfileExceptionOwner,
	workflowGoalProfilePublicationUnknown,
	type PreparedWorkflowGoalProfileException,
	type WorkflowGoalProfileExceptionOption,
	type WorkflowGoalProfileExceptionPreview,
} from "./goal-workflow-runtime.js";
import type { GoalProfileRuntimePatch } from "./goal-types.js";
import { assertWorkflowGoalChildCurrent, observeWorkflowGoalChildCurrent, hasActiveWorkflowGoalChild, bindWorkflowGoalChildCompiled, bindWorkflowGoalChildRun, captureWorkflowGoalChildEffectiveProfiles, recordWorkflowGoalRejectedGeneration, recordWorkflowGoalRejectedPlannerGeneration, assertWorkflowGoalRejectedPlannerProposalProgress,
	prepareWorkflowGoalDerivedPolicy, publishWorkflowGoalChildMaterialization,
	prepareWorkflowGoalChildForeach, assertWorkflowGoalChildForeachCurrent, publishWorkflowGoalChildForeach, failWorkflowGoalChildForeach, failWorkflowGoalChildForeachAdmission, workflowGoalChildForeachPublicationUnknown,
	prepareWorkflowGoalChildAdmission, settledWorkflowGoalChildRequests, settleWorkflowGoalChildStagePredecessors, workflowGoalChildCompilation, workflowGoalChildLineage, workflowGoalChildOutputTask,
	workflowGoalChildStopSignal,
	beginWorkflowGoalChildRecovery, takeWorkflowGoalChildRecovery,
	assertWorkflowEngineGoalCancellation,
	captureWorkflowGoalUnlaunchedStop, retireWorkflowGoalUnlaunched,
	type PreparedWorkflowGoalChildAdmission, type PreparedWorkflowGoalChildRecovery } from "./goal-workflow-runtime.js";
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
import { remainingDynamicNestedWorkflowDepth } from "./dynamic-nested-depth.js";
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
	dynamicGeneratedOutputProfile,
	isDynamicCompiledTaskPayload,
	normalizeDynamicAgentRequest,
	readDynamicGeneratedTaskResult,
	restoreDynamicGeneratedResourceWarnings,
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
	bindWorkflowLaunchSignal,
	createWorkflowStopPendingError,
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
	dynamicOutputTaskSpecIds,
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
	assertWorkflowAutoLaunchBindingCurrent,
	assertWorkflowAutoLaunchBindingFrozen,
	sealWorkflowAutoLaunchBindingCompiled,
	workflowAutoLaunchBindingSettings,
	type WorkflowAutoLaunchBinding,
} from "./workflow-auto-binding.js";
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
	activeForeachBatchRecordForTask,
	applyForeachBatchFallback,
	buildForeachBatchPrompt,
	foreachBatchExecutionSurfaceSha256,
	foreachBatchTasks,
	isActiveForeachBatchPhase,
	markForeachBatchInvalidated,
	markForeachBatchStopped,
	setForeachBatchPhase,
	sha256Text,
} from "./foreach-batch-runtime.js";
import {
	assertForeachBatchCapability,
	foreachBatchCapabilitySubjectSha256,
	issueForeachBatchCapability,
} from "./foreach-batch-capability.js";
import { workflowStateRootIdentity } from "./workflow-state-root.js";
import { prepareWorkflowNativeTaskPolicy } from "./workflow-native-tool-policy.js";
import {
	withResolvedWorkflowNativeHostContext,
	withoutWorkflowNativeHostContext,
} from "./workflow-native-host-context.js";
import {
	applyWorkflowExecutionProfile,
	workflowDefinitionFingerprint,
} from "./execution-profile.js";
import {
	type ArtifactGraphWorkflowSpec,
	type CompiledDynamicWorkflowTask,
	type CompiledTask,
	type AgentDefinition,
	type CompiledWorkflow,
	type WorkflowForeachBatchRecord,
	WORKFLOW_RUN_TYPE,
	type WorkflowRunLaunchCapture,
	type WorkflowRunLaunchMetadata,
	type WorkflowRunRecord,
	type WorkflowCapturedExecutionProfile,
	type WorkflowRunRouting,
	type WorkflowTaskRunRecord,
} from "./types.js";
import {
	clampTimeout,
	hasActiveSchedulerWork,
	isRefreshPollAggregateError,
	POLL_INTERVAL_MS,
	recordSupervisorError,
	refreshRun as refreshOriginalRun,
	refreshRunOrRecordPollError,
	schedulerPollDelayMs,
	shouldWatchRun,
	sleep,
	stillRunningAfterWaitMessage,
} from "./engine-wait.js";

export { buildRunSourceContext } from "./workflow-source-context-runtime.js";
export { evaluateLoopUntilCondition } from "./loop-runtime.js";
export type { DynamicWorkflowUi } from "./dynamic-controller-policy.js";
export async function refreshRun(cwd: string, runIdOrPrefix: string,
	goalChildAdmission?: PreparedWorkflowGoalChildAdmission, onPublicationPending?: () => void): Promise<WorkflowRunRecord> {
	const current = await readRunRecord(cwd, runIdOrPrefix);
	if (current.goalChild) {
		if (!goalChildAdmission) throw new Error("Goal child cold/plain refresh has no original live admission");
		const observed = await observeWorkflowGoalChildCurrent(goalChildAdmission, () => {
			onPublicationPending?.();
			dynamicControllerTestHooks.onSchedulerObservation?.(Object.freeze({
				cwd, runId: current.runId, phase: "watch-refresh", boundary: "publication-join", admissionPresent: true,
			}));
		});
		if (observed.run.runId !== current.runId) throw new Error("Goal child refresh original reservation changed");
		const refreshed = await refreshOriginalRun(cwd, current.runId);
		const settled = await observeWorkflowGoalChildCurrent(goalChildAdmission);
		if (settled.run.runId !== refreshed.runId) throw new Error("Goal child refresh original reservation changed");
		return settled.run;
	}
	return refreshOriginalRun(cwd, runIdOrPrefix);
}
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
	nowMs?: () => number;
	beforeControllerWorkerLaunch?: (
		context: DynamicControllerTestHookContext,
	) => void | Promise<void>;
	beforeDynamicResultCommit?: (
		context: DynamicControllerTestHookContext,
	) => void | Promise<void>;
	onWatcherScheduleResult?: (context: Readonly<{
		cwd: string;
		runId: string;
		mtimeMs: number | undefined;
		scheduled: boolean;
	}>) => void;
	onSchedulerObservation?: (context: Readonly<{
		cwd: string;
		runId: string;
		phase: "pre-schedule" | "watch-refresh" | "watch-schedule" | "schedule-lease" | "dag-eligibility" | "foreach-materialization" | "goal-child-wait";
		boundary?: string;
		error?: string;
		admissionPresent: boolean;
		leaseActive?: boolean;
		running?: number;
		maxConcurrency?: number;
		tasks?: ReadonlyArray<Readonly<{
			specId: string;
			kind: CompiledTask["kind"];
			status: WorkflowTaskRunRecord["status"] | undefined;
			dependsOn: readonly string[];
			dependencyStatuses: readonly (WorkflowTaskRunRecord["status"] | undefined)[];
			ready: boolean;
		}>>;
	}>) => void | Promise<void>;
	onHumanJudgmentPublication?: (context: Readonly<{ cwd: string; runId: string;
		phase: "before-publication-read" | "published-before-ack" }>) => void | Promise<void>;
	onGoalGeneratedPublication?: (context: Readonly<{ cwd: string; runId: string;
		phase: "compiled-written" }>) => void | Promise<void>;
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
	| ((
			boundary: ForeachMaterializationPersistenceBoundary,
	  ) => void | Promise<void>)
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
const supervisorWork = new Map<string, Set<Promise<void>>>();
const liveGoalPolicyHosts = new Map<string, WorkflowGoalPolicyHost>();
const liveGoalChildAdmissions = new Map<string, PreparedWorkflowGoalChildAdmission>();

async function writeRunRecord(...args: Parameters<typeof writeOriginalRunRecord>): Promise<void> {
	const key = `${resolve(args[0])}\0${args[1].runId}`;
	const live = liveGoalPolicyAdmissions.get(key);
	const compiledDigest = live && workflowDefinitionFingerprint(live.compiled);
	const assertCurrent = () => {
		args[3]?.();
		if (workflowGoalChildForeachPublicationUnknown(args[0], args[1].runId))
			throw new Error("Goal child original publication UNKNOWN; durable evidence cannot be rewritten");
		if (liveGoalPolicyAdmissions.get(key) !== live)
			throw new Error("Goal run writer original live admission changed");
		if (!live) return;
		if ([...live.admissions.values()].some(workflowGoalProfilePublicationUnknown))
			throw new Error("Goal root original publication UNKNOWN; durable evidence cannot be rewritten");
		if (live.publicationPending || liveGoalPolicyHosts.get(key) !== live.host ||
			live.host.runtime !== live.runtime ||
			workflowDefinitionFingerprint(live.compiled) !== compiledDigest)
			throw new Error("Goal run writer original publication changed or pending");
		for (const [id, prepared] of live.admissions) {
			const task = args[1].tasks.find(task => task.specId === id);
			const policy = live.compiled.tasks.find(task => task.id === id);
			if (!task || !policy) throw new Error("Goal run writer original policy unavailable");
			assertWorkflowGoalProfileConfigurationCurrent(prepared, task.goalProfileConfiguration, policy);
		}
	};
	assertCurrent();
	const work = writeOriginalRunRecord(args[0], args[1], args[2], assertCurrent);
	// Register before yielding: publication claims the same original owner and
	// drains these promises, including renames already submitted to the filesystem.
	live?.runWrites.add(work);
	try {
		await work;
	} finally {
		live?.runWrites.delete(work);
	}
}
/** Goal-participating runs publish generated tasks through their original live
 * admission; ordinary runs keep the bundle-path-rewriting compiled writer. */
async function persistDynamicGeneratedMaterialization(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	beforeCompiledDigest: string | undefined,
): Promise<void> {
	const key = `${resolve(cwd)}\0${run.runId}`;
	if (run.goalParticipation !== undefined || run.goalChild !== undefined ||
		liveGoalChildAdmissions.has(key) || liveGoalPolicyAdmissions.has(key)) {
		await persistGoalGeneratedMaterialization(cwd, run, compiledFlow, beforeCompiledDigest);
		return;
	}
	await writeCompiledRunArtifact(cwd, run.runId, compiledFlow);
	await writeRunRecord(cwd, run);
}
async function persistGoalGeneratedMaterialization(...args: Parameters<typeof persistOriginalGoalGeneratedMaterialization>) {
	const key = `${resolve(args[0])}\0${args[1].runId}`;
	const admission = liveGoalChildAdmissions.get(key);
	if (admission) return publishWorkflowGoalChildMaterialization(admission, args[2],
		async publication => {
			if (!publication) return persistOriginalGoalGeneratedMaterialization(...args);
			const [cwd, run, compiled, beforeDigest] = args;
			const { beforeRun, beforeCompiled, afterRun, afterCompiled, assertCurrent } = publication;
			const runFingerprint = (record: WorkflowRunRecord) => {
				const { updatedAt, ...stable } = record;
				return workflowDefinitionFingerprint(stable);
			};
			const checkPair = async (expectedRun: WorkflowRunRecord, expectedCompiled: CompiledWorkflow) => {
				await assertCurrent();
				const currentRun = await readRunRecord(cwd, run.runId);
				const currentCompiled = await readCompiledWorkflow(cwd, run.runId);
				if (!currentCompiled || runFingerprint(currentRun) !== runFingerprint(expectedRun) ||
					workflowDefinitionFingerprint(currentCompiled) !== workflowDefinitionFingerprint(expectedCompiled))
					throw new Error("Goal child generated publication durable pair changed");
				await assertCurrent();
			};
			const assertCommitCurrent = async () => {
				await assertCurrent();
				if (runFingerprint(run) !== runFingerprint(afterRun) ||
					workflowDefinitionFingerprint(compiled) !== workflowDefinitionFingerprint(afterCompiled))
					throw new Error("Goal child generated publication in-memory graph changed");
			};
			let preparedRun = beforeRun;
			if (run.goal !== undefined) {
				if (beforeDigest !== goalCompiledMaterializationDigest(beforeCompiled))
					throw new Error("Goal generated materialization baseline changed");
				preparedRun = { ...afterRun, goalGeneratedMaterialization: {
					schema: "goal-generated-materialization-v1", beforeCompiledDigest: beforeDigest,
					afterCompiled, afterCompiledDigest: goalCompiledMaterializationDigest(afterCompiled),
					afterRunTasksDigest: goalHash(afterRun.tasks),
				} } as WorkflowRunRecord;
				await checkPair(beforeRun, beforeCompiled);
				await writeJsonAtomic(workflowRunPath(cwd, run.runId), preparedRun, undefined, assertCommitCurrent);
			}
			await checkPair(preparedRun, beforeCompiled);
			await writeJsonAtomic(compiledWorkflowPath(cwd, run.runId), afterCompiled, undefined, assertCommitCurrent);
			await dynamicControllerTestHooks.onGoalGeneratedPublication?.(Object.freeze({ cwd,
				runId: run.runId, phase: "compiled-written" }));
			await checkPair(preparedRun, afterCompiled);
			await writeJsonAtomic(workflowRunPath(cwd, run.runId), afterRun, undefined, assertCommitCurrent);
			await checkPair(afterRun, afterCompiled);
			if (runFingerprint(run) !== runFingerprint(afterRun) ||
				workflowDefinitionFingerprint(compiled) !== workflowDefinitionFingerprint(afterCompiled))
				throw new Error("Goal child generated publication in-memory graph changed");
		}, args[1]);
	const live = liveGoalPolicyAdmissions.get(key);
	if (!live && args[1].goalParticipation && !isProtectedGoalEngineRun(args[1]))
		throw new Error("Goal generated publication requires original live admission; cold/foreign persistence denied");
	if (live) {
		const [cwd, run, compiled, beforeDigest] = args;
		if (live.publicationPending)
			throw new Error("Goal root generated publication already pending");
		live.publicationPending = true;
		try {
		await Promise.allSettled([...live.runWrites]);
		const assertLiveCurrent = () => {
			if (liveGoalPolicyAdmissions.get(key) !== live ||
				liveGoalPolicyHosts.get(key) !== live.host ||
				live.host.runtime !== live.runtime ||
				run.runId !== args[1].runId || resolve(run.cwd) !== resolve(cwd) ||
				run.rootRunId !== undefined || run.parentRunId !== undefined ||
				!run.goalParticipation || isProtectedGoalEngineRun(run) ||
				live.rootRunId !== run.runId ||
				live.executionProfileHash !== workflowDefinitionFingerprint(run.executionProfile ?? null))
				throw new Error("Goal root generated publication original live host changed");
			for (const [id, prepared] of live.admissions) {
				if (workflowGoalProfilePublicationUnknown(prepared))
					throw new Error("Goal root original publication UNKNOWN; durable evidence cannot be rewritten");
				const policy = live.compiled.tasks.find(task => task.id === id);
				if (!policy) throw new Error("Goal root generated publication original policy unavailable");
				assertWorkflowGoalProfileConfigurationCurrent(prepared,
					run.tasks.find(task => task.specId === id)?.goalProfileConfiguration, policy);
			}
		};
		assertLiveCurrent();
		const beforeRun = await readRunRecord(cwd, run.runId);
		assertLiveCurrent();
		const beforeCompiled = await readCompiledWorkflow(cwd, run.runId);
		assertLiveCurrent();
		if (!beforeCompiled)
			throw new Error("Goal root generated publication original compiled unavailable");
		const durableBeforeDigest = workflowDefinitionFingerprint(beforeCompiled);
		if ((beforeDigest !== undefined && beforeDigest !== goalCompiledMaterializationDigest(beforeCompiled)) ||
			durableBeforeDigest !== workflowDefinitionFingerprint(live.compiled))
			throw new Error("Goal root generated materialization baseline changed");
		const afterRun = JSON.parse(JSON.stringify(deriveRunStatus(run))) as WorkflowRunRecord;
		if (workflowDefinitionFingerprint(compiled) === durableBeforeDigest &&
			workflowDefinitionFingerprint(afterRun) === workflowDefinitionFingerprint(beforeRun)) {
			await throwIfWorkflowStopRequested(cwd, run.runId);
			await assertOrdinaryGoalCommandCurrent(cwd, beforeRun, live.host);
			assertLiveCurrent();
			const currentRun = await readRunRecord(cwd, run.runId);
			assertLiveCurrent();
			const currentCompiled = await readCompiledWorkflow(cwd, run.runId);
			assertLiveCurrent();
			if (!currentCompiled ||
				workflowDefinitionFingerprint(currentRun) !== workflowDefinitionFingerprint(beforeRun) ||
				workflowDefinitionFingerprint(currentCompiled) !== durableBeforeDigest)
				throw new Error("Goal root unchanged publication durable pair changed");
			await assertOrdinaryGoalCommandCurrent(cwd, currentRun, live.host);
			await throwIfWorkflowStopRequested(cwd, run.runId);
			assertLiveCurrent();
			if (workflowDefinitionFingerprint(deriveRunStatus(run)) !== workflowDefinitionFingerprint(afterRun) ||
				workflowDefinitionFingerprint(compiled) !== durableBeforeDigest ||
				workflowDefinitionFingerprint(live.compiled) !== durableBeforeDigest)
				throw new Error("Goal root unchanged publication in-memory graph changed");
			return;
		}
		const afterCompiled = JSON.parse(JSON.stringify(compiled)) as CompiledWorkflow;
		const publication = await prepareWorkflowGoalRootMaterializationPublication({
			cwd, runId: run.runId, admissions: live.admissions, liveCompiled: live.compiled,
			beforeRun, beforeCompiled, proposedRun: afterRun, proposedCompiled: compiled,
		});
		const assertProposedCurrent = () => {
			assertLiveCurrent();
			if (workflowDefinitionFingerprint(deriveRunStatus(run)) !== workflowDefinitionFingerprint(afterRun) ||
				workflowDefinitionFingerprint(compiled) !== workflowDefinitionFingerprint(afterCompiled))
				throw new Error("Goal root generated publication in-memory proposal changed");
		};
		const checkPair = async (expectedRun: WorkflowRunRecord, expectedCompiled: CompiledWorkflow) => {
			assertProposedCurrent();
			await publication.assertCurrent();
			assertProposedCurrent();
			const currentRun = await readRunRecord(cwd, run.runId);
			assertProposedCurrent();
			const currentCompiled = await readCompiledWorkflow(cwd, run.runId);
			assertProposedCurrent();
			if (!currentCompiled || workflowDefinitionFingerprint(currentRun) !== workflowDefinitionFingerprint(expectedRun) ||
				workflowDefinitionFingerprint(currentCompiled) !== workflowDefinitionFingerprint(expectedCompiled))
				throw new Error("Goal root generated publication durable pair changed");
			await publication.assertCurrent();
			assertProposedCurrent();
		};
		let writeStarted = false;
		const assertCommitCurrent = async () => {
			assertProposedCurrent();
			await publication.assertCurrent();
			assertProposedCurrent();
		};
		try {
			await checkPair(beforeRun, beforeCompiled);
			writeStarted = true;
			await writeJsonAtomic(compiledWorkflowPath(cwd, run.runId), afterCompiled, undefined, assertCommitCurrent);
			await dynamicControllerTestHooks.onGoalGeneratedPublication?.(Object.freeze({ cwd,
				runId: run.runId, phase: "compiled-written" }));
			await checkPair(beforeRun, afterCompiled);
			await writeJsonAtomic(workflowRunPath(cwd, run.runId), afterRun, undefined, assertCommitCurrent);
			await checkPair(afterRun, afterCompiled);
			publication.publish();
			assertProposedCurrent();
			return;
		} catch (error) {
			if (writeStarted) publication.fail();
			throw error;
		}
		} finally {
			live.publicationPending = false;
		}
	}
	return persistOriginalGoalGeneratedMaterialization(...args);
}
const liveGoalPolicyAdmissions = new Map<string, {
	readonly host: WorkflowGoalPolicyHost;
	readonly runtime: WorkflowGoalPolicyHost["runtime"];
	readonly rootRunId: string;
	readonly executionProfileHash: string;
	readonly admissions: ReadonlyMap<string, PreparedWorkflowGoalPolicyAdmission>;
	readonly compiled: CompiledWorkflow;
	readonly runWrites: Set<Promise<void>>;
	publicationPending: boolean;
}>();
const MAX_SUPERVISOR_CONSECUTIVE_ERRORS = 3;

export async function assertOrdinaryGoalCommandCurrent(cwd: string, run: WorkflowRunRecord,
	host: WorkflowGoalPolicyHost): Promise<void> {
	const live = liveGoalPolicyAdmissions.get(`${resolve(cwd)}\0${run.runId}`);
	if (!live || !run.goalParticipation || isProtectedGoalEngineRun(run) || resolve(run.cwd) !== resolve(cwd) ||
		host.executionFoundation !== "workflow-engine" || host.runtime !== live.runtime ||
		live.rootRunId !== (run.rootRunId ?? run.runId) ||
		live.executionProfileHash !== workflowDefinitionFingerprint(run.executionProfile ?? null))
		throw new Error("Ordinary Goal command requires original same-live-session host; cold/foreign action denied");
	const compiled = await readCompiledWorkflow(cwd, run.runId);
	if (!compiled) throw new Error("Ordinary Goal original compiled admission unavailable");
	for (const policy of compiled.tasks.filter(task => task.kind === "goal")) {
		const prepared = live.admissions.get(policy.id);
		if (!prepared) throw new Error("Ordinary Goal original admission missing");
		assertPreparedWorkflowGoalPolicyCurrent({ host: live.host, cwd, policy,
			request: goalPolicyRequest(policy, compiled.task), ancestryRootRunId: live.rootRunId,
			parentRunId: run.runId, executionProfileName: run.executionProfile?.name,
			assertCurrent: async () => {} }, prepared);
		assertWorkflowGoalProfileConfigurationCurrent(prepared,
			run.tasks.find(task => task.specId === policy.id)?.goalProfileConfiguration, policy);
	}
}

function humanAcceptancePolicy(policy: CompiledWorkflow["tasks"][number]): boolean {
	return policy.kind === "goal" && policy.goal!.definition.goal.criteria.some((criterion) =>
		criterion.verifier.kind === "human" &&
		criterion.verifier.producerId === "human-acceptance-v1" &&
		criterion.verifier.target === "artifact" &&
		criterion.verifier.subject.artifact === "control" &&
		typeof (criterion.verifier.config as { condition?: { statement?: unknown } }).condition?.statement === "string");
}

async function currentWorkflowGoalHumanReview(
	cwd: string,
	runId: string,
	host: WorkflowGoalPolicyHost,
): Promise<{ run: WorkflowRunRecord; compiled: CompiledWorkflow; policy: CompiledWorkflow["tasks"][number];
	task: WorkflowTaskRunRecord; prepared: PreparedWorkflowGoalPolicyAdmission; live: NonNullable<typeof liveGoalPolicyAdmissions extends Map<string, infer T> ? T : never> }> {
	const run = await readRunRecord(cwd, runId);
	const live = liveGoalPolicyAdmissions.get(`${resolve(cwd)}\0${runId}`);
	if (!live || run.runId !== runId || run.rootRunId !== undefined || run.parentRunId !== undefined || live.rootRunId !== runId ||
		!run.goalParticipation || isProtectedGoalEngineRun(run) || resolve(run.cwd) !== resolve(cwd) ||
		host.executionFoundation !== "workflow-engine" || host.runtime !== live.runtime ||
		live.executionProfileHash !== workflowDefinitionFingerprint(run.executionProfile ?? null))
		throw new Error("Human Goal judgment requires the original live root host and admission.");
	const compiled = await readCompiledWorkflow(cwd, runId);
	if (!compiled) throw new Error("Human Goal judgment requires the original compiled workflow.");
	const matches = compiled.tasks.filter(humanAcceptancePolicy);
	if (matches.length !== 1) throw new Error("Human Goal judgment requires exactly one human-acceptance-v1 artifact/control condition.");
	const policy = matches[0]!;
	const task = run.tasks.find(candidate => candidate.specId === policy.id);
	const prepared = live.admissions.get(policy.id);
	if (prepared) assertHumanFamilyKnown(prepared);
	if (!task || !prepared || task.status !== "running" || task.statusDetail !== "goal_waiting_user")
		throw new Error("Human Goal judgment is not currently waiting on this original policy.");
	await throwIfWorkflowStopRequested(cwd, runId);
	try {
		assertPreparedWorkflowGoalPolicyCurrent({ host: live.host, cwd, policy,
			request: goalPolicyRequest(policy, compiled.task), ancestryRootRunId: runId,
			parentRunId: runId, executionProfileName: run.executionProfile?.name,
			assertCurrent: () => throwIfWorkflowStopRequested(cwd, runId) }, prepared);
	} catch (cause) {
		throw new Error("Human Goal original compiled contract or admission changed; judgment is stale.", { cause });
	}
	return { run, compiled, policy, task, prepared, live };
}

const workflowGoalHumanReviewStops = new WeakMap<object, { dispose(): void }>();

export async function beginWorkflowGoalHumanReview(
	cwd: string,
	runId: string,
	host: WorkflowGoalPolicyHost,
	signal: AbortSignal,
): Promise<{ capability: object; snapshot: Readonly<object> }> {
	signal.throwIfAborted();
	const current = await currentWorkflowGoalHumanReview(cwd, runId, host);
	const stop = createWorkflowStopSignal(cwd, runId);
	try {
		const reviewSignal = AbortSignal.any([signal, stop.signal]);
		reviewSignal.throwIfAborted();
		const input = { host: current.live.host, cwd, policy: current.policy,
			request: goalPolicyRequest(current.policy, current.compiled.task), ancestryRootRunId: runId,
			parentRunId: runId, executionProfileName: current.run.executionProfile?.name,
			stopSignal: reviewSignal, assertCurrent: () => throwIfWorkflowStopRequested(cwd, runId) };
		const review = await captureWorkflowGoalHumanReview(input, current.prepared, reviewSignal);
		await currentWorkflowGoalHumanReview(cwd, runId, host);
		reviewSignal.throwIfAborted();
		workflowGoalHumanReviewStops.set(review.capability, stop);
		return review;
	} catch (error) {
		stop.dispose();
		throw error;
	}
}

export function discardWorkflowGoalHumanReview(capability: object): void {
	revokeWorkflowGoalHumanReview(capability);
	workflowGoalHumanReviewStops.get(capability)?.dispose();
	workflowGoalHumanReviewStops.delete(capability);
}

type WorkflowGoalProfileExceptionCommandState = {
	readonly cwd: string;
	readonly runId: string;
	readonly parentRunId: string;
	readonly child?: PreparedWorkflowGoalChildAdmission;
	readonly host: WorkflowGoalPolicyHost;
	readonly live: NonNullable<ReturnType<typeof liveGoalPolicyAdmissions.get>>;
	readonly captures: readonly {
		readonly capability: PreparedWorkflowGoalProfileException;
		readonly prepared: PreparedWorkflowGoalPolicyAdmission;
		readonly options: readonly WorkflowGoalProfileExceptionOption[];
	}[];
	readonly stop: { dispose(): void; signal: AbortSignal };
	preview?: {
		readonly selection: object;
		readonly value: WorkflowGoalProfileExceptionPreview;
		readonly rendered: string;
	};
};
const workflowGoalProfileExceptions = new WeakMap<object, WorkflowGoalProfileExceptionCommandState>();

async function currentWorkflowGoalProfileException(
	cwd: string,
	runId: string,
	host: WorkflowGoalPolicyHost,
	expected?: WorkflowGoalProfileExceptionCommandState,
): Promise<{ run: WorkflowRunRecord; compiled: CompiledWorkflow; parentRun?: WorkflowRunRecord;
	live: NonNullable<ReturnType<typeof liveGoalPolicyAdmissions.get>> }> {
	const key = `${resolve(cwd)}\0${runId}`;
	const run = await readRunRecord(cwd, runId);
	const child = expected?.child ?? liveGoalChildAdmissions.get(key);
	const owner = child && await workflowGoalChildProfileExceptionOwner(child);
	const parentRunId = owner?.parentRunId ?? runId;
	const parentKey = `${resolve(cwd)}\0${parentRunId}`;
	const live = liveGoalPolicyAdmissions.get(parentKey);
	const parentRun = child ? await readRunRecord(cwd, parentRunId) : undefined;
	if (!live || (expected && (live !== expected.live || child !== expected.child ||
			parentRunId !== expected.parentRunId)) ||
		run.runId !== runId || !(parentRun ?? run).goalParticipation || isProtectedGoalEngineRun(run) ||
		resolve(run.cwd) !== resolve(cwd) ||
		(child
			? run.parentRunId !== parentRunId || run.rootRunId !== owner?.rootRunId ||
				parentRun?.runId !== parentRunId || parentRun.rootRunId !== undefined ||
				parentRun.parentRunId !== undefined || live.rootRunId !== owner?.rootRunId
			: run.rootRunId !== undefined || run.parentRunId !== undefined || live.rootRunId !== runId) ||
		host.executionFoundation !== "workflow-engine" ||
		host.runtime !== live.runtime ||
		live.executionProfileHash !== workflowDefinitionFingerprint((parentRun ?? run).executionProfile ?? null))
		throw new Error("Goal profile exception requires the original retained live root host and exact child admission");
	const durableCompiled = await readCompiledWorkflow(cwd, runId);
	if (liveGoalPolicyAdmissions.get(parentKey) !== live ||
		(child && liveGoalChildAdmissions.get(key) !== child) ||
		!durableCompiled ||
		(!child && workflowDefinitionFingerprint(durableCompiled) !== workflowDefinitionFingerprint(live.compiled)))
		throw new Error("Goal profile exception original compiled inventory changed");
	if (child) await assertWorkflowGoalChildCurrent(child, run, durableCompiled);
	await throwIfWorkflowStopRequested(cwd, runId);
	if (liveGoalPolicyAdmissions.get(parentKey) !== live ||
		(child && liveGoalChildAdmissions.get(key) !== child))
		throw new Error("Goal profile exception original live admission changed");
	for (const policy of live.compiled.tasks.filter(task => task.kind === "goal")) {
		const prepared = live.admissions.get(policy.id);
		const task = (parentRun ?? run).tasks.find(candidate => candidate.specId === policy.id);
		if (!prepared || !task)
			throw new Error("Goal profile exception original policy inventory is incomplete");
		assertPreparedWorkflowGoalPolicyCurrent({ host: live.host, cwd, policy,
			request: goalPolicyRequest(policy, live.compiled.task), ancestryRootRunId: live.rootRunId,
			parentRunId, executionProfileName: (parentRun ?? run).executionProfile?.name,
			assertCurrent: () => throwIfWorkflowStopRequested(cwd, parentRunId) }, prepared);
		assertWorkflowGoalProfileConfigurationCurrent(prepared,
			task.goalProfileConfiguration, policy);
	}
	if (expected) {
		const exceptionCompiled = child ? durableCompiled : live.compiled;
		for (const capture of expected.captures) {
			await recheckWorkflowGoalProfileExceptionSources(
				capture.capability, run, exceptionCompiled, parentRun);
			if (liveGoalPolicyAdmissions.get(parentKey) !== live ||
				(child && liveGoalChildAdmissions.get(key) !== child) ||
				(!child && workflowDefinitionFingerprint(durableCompiled) !== workflowDefinitionFingerprint(live.compiled)))
				throw new Error("Goal profile exception source or inventory changed");
			assertWorkflowGoalProfileExceptionCurrent(capture.capability, run, exceptionCompiled, parentRun);
		}
	}
	return { run, compiled: durableCompiled, ...(parentRun ? { parentRun } : {}), live };
}

export async function beginWorkflowGoalProfileException(
	cwd: string,
	runId: string,
	host: WorkflowGoalPolicyHost,
	signal: AbortSignal,
): Promise<{ capability: object; options: readonly WorkflowGoalProfileExceptionOption[] }> {
	signal.throwIfAborted();
	const current = await currentWorkflowGoalProfileException(cwd, runId, host);
	signal.throwIfAborted();
	const stop = createWorkflowStopSignal(cwd, runId);
	const captures: Array<{
		capability: PreparedWorkflowGoalProfileException;
		prepared: PreparedWorkflowGoalPolicyAdmission;
		options: readonly WorkflowGoalProfileExceptionOption[];
	}> = [];
	try {
		const child = liveGoalChildAdmissions.get(`${resolve(cwd)}\0${runId}`);
		if (child) {
			if (!current.parentRun)
				throw new Error("Goal child profile exception original parent inventory unavailable");
			const capture = await captureWorkflowGoalChildProfileException(
				child, current.parentRun, current.run, current.compiled);
			if (capture) captures.push({ ...capture,
				prepared: current.live.admissions.get(
					capture.options[0]!.policySpecId)! });
		} else {
			for (const policy of current.live.compiled.tasks.filter(task => task.kind === "goal")) {
				const prepared = current.live.admissions.get(policy.id)!;
				const input = { host: current.live.host, cwd, policy,
					request: goalPolicyRequest(policy, current.live.compiled.task), ancestryRootRunId: runId,
					parentRunId: runId, executionProfileName: current.run.executionProfile?.name,
					stopSignal: stop.signal, assertCurrent: () => throwIfWorkflowStopRequested(cwd, runId) };
				const capture = captureWorkflowGoalProfileException(
					input, prepared, current.run, current.live.compiled);
				if (capture) captures.push({ ...capture, prepared });
			}
		}
		if (captures.length === 0)
			throw new Error("Goal profile exception has no actual pending captured root, static child, or exact materialized item scope");
		const capability = Object.freeze({});
		const state: WorkflowGoalProfileExceptionCommandState = {
			cwd: resolve(cwd), runId,
			parentRunId: current.parentRun?.runId ?? runId,
			...(child ? { child } : {}),
			host, live: current.live, captures, stop,
		};
		workflowGoalProfileExceptions.set(capability, state);
		await currentWorkflowGoalProfileException(cwd, runId, host, state);
		signal.throwIfAborted();
		return { capability, options: Object.freeze(captures.flatMap(capture => capture.options)) };
	} catch (error) {
		for (const capture of captures) discardWorkflowGoalProfileException(capture.capability);
		stop.dispose();
		throw error;
	}
}

export async function assertWorkflowGoalProfileExceptionCommandCurrent(
	capability: object,
	signal: AbortSignal,
): Promise<void> {
	const state = workflowGoalProfileExceptions.get(capability);
	if (!state) throw new Error("Goal profile exception one-use capability unavailable");
	signal.throwIfAborted();
	state.stop.signal.throwIfAborted();
	await currentWorkflowGoalProfileException(state.cwd, state.runId, state.host, state);
	signal.throwIfAborted();
	state.stop.signal.throwIfAborted();
}

export function previewWorkflowGoalProfileExceptionCommand(
	capability: object,
	selection: object,
	runtime: GoalProfileRuntimePatch,
	reason: string,
): WorkflowGoalProfileExceptionPreview {
	const state = workflowGoalProfileExceptions.get(capability);
	const capture = state?.captures.find(candidate =>
		candidate.options.some(option => option.selection === selection));
	if (!state || !capture)
		throw new Error("Goal profile exception opaque selection is unavailable");
	const preview = previewWorkflowGoalProfileException(
		capture.capability, selection, runtime, reason);
	if (state.preview)
		throw new Error("Goal profile exception preview capability already bound");
	state.preview = {
		selection,
		value: preview,
		rendered: JSON.stringify(preview, null, 2),
	};
	return preview;
}

export function discardWorkflowGoalProfileExceptionCommand(capability: object): void {
	const state = workflowGoalProfileExceptions.get(capability);
	workflowGoalProfileExceptions.delete(capability);
	if (!state) return;
	for (const capture of state.captures)
		discardWorkflowGoalProfileException(capture.capability);
	state.stop.dispose();
}

export async function submitWorkflowGoalProfileException(
	capability: object,
	selection: object,
	preview: WorkflowGoalProfileExceptionPreview,
	renderedPreview: string,
	signal: AbortSignal,
): Promise<WorkflowRunRecord | undefined> {
	const state = workflowGoalProfileExceptions.get(capability);
	workflowGoalProfileExceptions.delete(capability);
	const selected = state?.captures.find(candidate =>
		candidate.options.some(option => option.selection === selection));
	if (!state || !selected || state.preview?.selection !== selection ||
		state.preview.value !== preview || state.preview.rendered !== renderedPreview ||
		renderedPreview !== JSON.stringify(preview, null, 2))
		throw new Error("Goal profile exception one-use capability unavailable");
	let transition: ReturnType<typeof stageWorkflowGoalProfileException> | undefined;
	let wrote = false;
	let publicationClaimed = false;
	try {
		signal.throwIfAborted();
		state.stop.signal.throwIfAborted();
		await currentWorkflowGoalProfileException(state.cwd, state.runId, state.host, state);
		signal.throwIfAborted();
		state.stop.signal.throwIfAborted();
		const confirmed = await state.live.host.confirm(preview);
		await currentWorkflowGoalProfileException(state.cwd, state.runId, state.host, state);
		signal.throwIfAborted();
		state.stop.signal.throwIfAborted();
		if (!confirmed) return undefined;
		type LeaseContextRunner = ReturnType<typeof AsyncLocalStorage.snapshot>;
		const publishUnderLeases = async (
			parentLeaseSignal: AbortSignal,
			runInParentLeaseContext: LeaseContextRunner,
			childLeaseSignal?: AbortSignal,
			runInChildLeaseContext?: LeaseContextRunner,
		) => {
			const leaseSignal = childLeaseSignal ?? parentLeaseSignal;
			const runInLeaseContext = runInChildLeaseContext ?? runInParentLeaseContext;
			const combined = AbortSignal.any([signal, parentLeaseSignal, leaseSignal, state.stop.signal]);
			const assertLeaseOwnersCurrent = async () => {
				combined.throwIfAborted();
				assertScheduleLeaseActive(parentLeaseSignal);
				assertScheduleLeaseActive(leaseSignal);
				await runInParentLeaseContext(() =>
					assertRunLeaseOwnership(state.cwd, state.parentRunId, parentLeaseSignal));
				if (state.child) {
					await runInLeaseContext(() =>
						assertRunLeaseOwnership(state.cwd, state.runId, leaseSignal));
				}
				combined.throwIfAborted();
				assertScheduleLeaseActive(parentLeaseSignal);
				assertScheduleLeaseActive(leaseSignal);
			};
			const assertOtherLeaseForParentWrite = state.child
				? () => runInLeaseContext(() =>
					assertRunLeaseOwnership(state.cwd, state.runId, leaseSignal))
				: undefined;
			const assertOtherLeaseForChildWrite = state.child
				? () => runInParentLeaseContext(() =>
					assertRunLeaseOwnership(state.cwd, state.parentRunId, parentLeaseSignal))
				: undefined;
			await assertLeaseOwnersCurrent();
			if (liveGoalPolicyAdmissions.get(`${state.cwd}\0${state.parentRunId}`) !== state.live ||
				state.live.publicationPending)
				throw new Error("Goal profile exception original publication owner changed or pending");
			state.live.publicationPending = true;
			publicationClaimed = true;
			await Promise.allSettled([...state.live.runWrites]);
			await assertLeaseOwnersCurrent();
			const current = await currentWorkflowGoalProfileException(
				state.cwd, state.runId, state.host, state);
			await assertLeaseOwnersCurrent();
			const previewHash = workflowDefinitionFingerprint(renderedPreview);
			const transitionCompiled = state.child ? current.compiled : state.live.compiled;
			transition = stageWorkflowGoalProfileException(
				selected.capability, selection, preview, previewHash,
				new Date().toISOString(), current.run, transitionCompiled, current.parentRun);
			for (const capture of state.captures) {
				if (capture !== selected)
					discardWorkflowGoalProfileException(capture.capability);
			}
			const assertTransitionCurrent = async () => {
				await assertLeaseOwnersCurrent();
				if (liveGoalPolicyAdmissions.get(`${state.cwd}\0${state.parentRunId}`) !== state.live ||
					(state.child && liveGoalChildAdmissions.get(`${state.cwd}\0${state.runId}`) !== state.child) ||
					state.host.runtime !== state.live.runtime)
					throw new Error("Goal profile exception original live owner changed");
				await transition!.recheckSources();
				await assertLeaseOwnersCurrent();
				await throwIfWorkflowStopRequested(state.cwd, state.runId);
				await assertLeaseOwnersCurrent();
				const durableRun = await readRunRecord(state.cwd, state.runId);
				await assertLeaseOwnersCurrent();
				const durableCompiled = await readCompiledWorkflow(state.cwd, state.runId);
				await assertLeaseOwnersCurrent();
				if (!durableCompiled)
					throw new Error("Goal profile exception durable compiled inventory unavailable");
				const durableParentRun = state.child
					? await readRunRecord(state.cwd, state.parentRunId) : undefined;
				await assertLeaseOwnersCurrent();
				transition!.assertUnpublished(durableRun, durableCompiled, durableParentRun);
				return durableRun;
			};
			await assertTransitionCurrent();
			transition.activateInFlightRequests();
			wrote = true;
			if (state.child) {
				await runInParentLeaseContext(() => writeJsonAtomic(
					workflowRunPath(state.cwd, state.parentRunId),
					transition!.parentRun!,
					parentLeaseSignal,
					assertOtherLeaseForParentWrite,
				));
				await assertTransitionCurrent();
				await runInLeaseContext(() => writeJsonAtomic(
					compiledWorkflowPath(state.cwd, state.runId),
					transition!.compiled,
					leaseSignal,
					assertOtherLeaseForChildWrite,
				));
				await assertTransitionCurrent();
				await runInLeaseContext(() => writeJsonAtomic(
					workflowRunPath(state.cwd, state.runId),
					transition!.run,
					leaseSignal,
					assertOtherLeaseForChildWrite,
				));
			} else {
				await runInParentLeaseContext(() => writeJsonAtomic(
					compiledWorkflowPath(state.cwd, state.runId),
					transition!.compiled,
					parentLeaseSignal,
				));
				await assertTransitionCurrent();
				await runInParentLeaseContext(() => writeJsonAtomic(
					workflowRunPath(state.cwd, state.runId),
					transition!.run,
					parentLeaseSignal,
				));
			}
			await assertTransitionCurrent();
			await assertLeaseOwnersCurrent();
			transition.publish();
			return transition.run;
		};
		const result = await withRunLease(state.cwd, state.parentRunId, async parentLeaseSignal => {
			const runInParentLeaseContext = AsyncLocalStorage.snapshot();
			if (!state.child) {
				return publishUnderLeases(
					parentLeaseSignal, runInParentLeaseContext);
			}
			const childResult = await withRunLease(state.cwd, state.runId,
				async childLeaseSignal => {
					const runInChildLeaseContext = AsyncLocalStorage.snapshot();
					const published = await publishUnderLeases(
						parentLeaseSignal,
						runInParentLeaseContext,
						childLeaseSignal,
						runInChildLeaseContext,
					);
					await runInParentLeaseContext(() =>
						assertRunLeaseOwnership(state.cwd, state.parentRunId, parentLeaseSignal));
					await runInChildLeaseContext(() =>
						assertRunLeaseOwnership(state.cwd, state.runId, childLeaseSignal));
					return published;
				});
			if (!childResult)
				throw new Error(`Goal profile exception for ${state.runId} denied: original child run lease is busy; no configuration was changed.`);
			await runInParentLeaseContext(() =>
				assertRunLeaseOwnership(state.cwd, state.parentRunId, parentLeaseSignal));
			return childResult;
		});
		if (!result) {
			throw new Error(`Goal profile exception for ${state.runId} denied: original run lease is busy; no configuration was changed.`);
		}
		return result;
	} catch (error) {
		if (wrote) transition?.uncertain();
		throw error;
	} finally {
		if (publicationClaimed) state.live.publicationPending = false;
		for (const capture of state.captures)
			discardWorkflowGoalProfileException(capture.capability);
		state.stop.dispose();
	}
}

export async function submitWorkflowGoalHumanReview(
	cwd: string,
	runId: string,
	host: WorkflowGoalPolicyHost,
	capability: object,
	decision: "accept" | "reject",
	signal: AbortSignal,
): Promise<WorkflowRunRecord> {
	const review = (() => {
		try { return consumeWorkflowGoalHumanReview(capability); }
		finally {
			workflowGoalHumanReviewStops.get(capability)?.dispose();
			workflowGoalHumanReviewStops.delete(capability);
		}
	})();
	signal.throwIfAborted();
	let submission: Awaited<ReturnType<typeof review.stage>> | undefined;
	const result = await withRunLease(cwd, runId, async (leaseSignal) => {
		const stop = createWorkflowStopSignal(cwd, runId);
		try {
			const reviewSignal = AbortSignal.any([signal, leaseSignal, stop.signal]);
			reviewSignal.throwIfAborted();
			const current = await currentWorkflowGoalHumanReview(cwd, runId, host);
			reviewSignal.throwIfAborted();
			assertScheduleLeaseActive(leaseSignal);
			const inventory = workflowDefinitionFingerprint({ compiled: current.compiled, lineage: current.task.goalRoot });
			const input = { host: current.live.host, cwd, policy: current.policy,
				request: goalPolicyRequest(current.policy, current.compiled.task), ancestryRootRunId: runId,
				parentRunId: runId, executionProfileName: current.run.executionProfile?.name,
				stopSignal: reviewSignal, assertCurrent: async () => {
					reviewSignal.throwIfAborted(); assertScheduleLeaseActive(leaseSignal);
					const latest = await currentWorkflowGoalHumanReview(cwd, runId, host);
					reviewSignal.throwIfAborted(); assertScheduleLeaseActive(leaseSignal);
					if (latest.live !== current.live || latest.prepared !== current.prepared ||
						inventory !== workflowDefinitionFingerprint({ compiled: latest.compiled, lineage: latest.task.goalRoot }))
						throw new Error("Goal human original root inventory changed during judgment");
				} };
			await review.validate(input, current.prepared);
			reviewSignal.throwIfAborted();
			submission = await review.stage(input, current.prepared, decision);
			reviewSignal.throwIfAborted();
			assertScheduleLeaseActive(leaseSignal);
			await dynamicControllerTestHooks.onHumanJudgmentPublication?.({ cwd, runId, phase: "before-publication-read" });
			const refreshed = await currentWorkflowGoalHumanReview(cwd, runId, host);
			reviewSignal.throwIfAborted(); assertScheduleLeaseActive(leaseSignal);
			if (inventory !== workflowDefinitionFingerprint({ compiled: refreshed.compiled, lineage: refreshed.task.goalRoot }))
				throw new Error("Goal human original oracle inventory changed before publication");
			refreshed.task.status = "pending";
			refreshed.task.statusDetail = "goal_human_review_decided";
			refreshed.task.lastMessage = "Original human judgment recorded; the policy oracle will publish the decision.";
			await writeRunRecord(cwd, refreshed.run);
			reviewSignal.throwIfAborted(); assertScheduleLeaseActive(leaseSignal);
			let acknowledged = false;
			let publicationError: unknown;
			await scheduleDag(cwd, refreshed.run, refreshed.compiled, {
				goalPolicyHost: refreshed.live.host,
				goalPolicyAdmissions: refreshed.live.admissions,
				goalHumanSubmission: { token: submission.token, acknowledge: async () => {
					try {
						await dynamicControllerTestHooks.onHumanJudgmentPublication?.({ cwd, runId, phase: "published-before-ack" });
						await submission!.commit();
						acknowledged = true;
					} catch (error) {
						publicationError = error;
						submission!.uncertain();
						throw error;
					}
				} },
			}, leaseSignal);
			if (!acknowledged) throw publicationError ?? new Error("Goal human publication UNKNOWN: original oracle acknowledgment unavailable");
			assertScheduleLeaseActive(leaseSignal);
			const published = await readRunRecord(cwd, runId);
			reviewSignal.throwIfAborted(); assertScheduleLeaseActive(leaseSignal);
			return published;
		} catch (error) {
			submission?.uncertain();
			throw error;
		} finally {
			stop.dispose();
		}
	}).catch(error => { submission?.uncertain(); throw error; });
	try { signal.throwIfAborted(); }
	catch (error) { submission?.uncertain(); throw error; }
	if (!result) {
		await currentWorkflowGoalHumanReview(cwd, runId, host);
		signal.throwIfAborted();
		throw new Error(`Goal human judgment for ${runId} denied: original run lease is busy; no judgment or provider action was taken.`);
	}
	return result;
}

export interface WorkflowRunOptions {
	task?: string;
	goalPolicyHost?: WorkflowGoalPolicyHost;
	runtimeOverrides?: WorkflowRuntimeDefaults;
	runtimeDefaults?: WorkflowRuntimeDefaults;
	availableModels?: WorkflowModelInfo[];
	dynamicUi?: DynamicWorkflowUi;
	runId?: string;
	parentRunId?: string;
	/** Optional routing audit record persisted on the run record. */
	routing?: WorkflowRunRouting;
	/** Creation-surface provenance; exact command text is persisted only in a private sidecar. */
	launch?: WorkflowRunLaunchCapture;
	/** In-memory auto-selection snapshot, checked before any substantive dispatch. */
	autoLaunchBinding?: WorkflowAutoLaunchBinding;
	/** Owned foreground cancellation, never persisted with run authority. */
	launchSignal?: AbortSignal;
	/**
	 * Overrides for inputs the workflow spec declares (for example depth).
	 * Keys the spec does not declare are ignored.
	 */
	inputOverrides?: Record<string, unknown>;
	/**
	 * Named execution profile declared in the spec's executionProfiles map.
	 * Applied as per-stage model/thinking/batch metadata at compile time and
	 * recorded on the run record. Unknown names fail closed.
	 */
	executionProfile?: string;
	/**
	 * Pre-resolved user profile captured by an interactive/tool launch surface.
	 * A declared executionProfile takes precedence when both are supplied.
	 */
	executionProfileOverride?: WorkflowCapturedExecutionProfile;
}

export interface WorkflowScheduleOptions {
	/** Same-lease provisional judgment; never persisted or recreated by readers. */
	goalHumanSubmission?: { token: object; acknowledge(): Promise<void> };
	dynamicUi?: DynamicWorkflowUi;
	availableModels?: WorkflowModelInfo[];
	/** Process-local interactive Goal host; persisted graph data cannot recreate it. */
	goalPolicyHost?: WorkflowGoalPolicyHost;
	goalPolicyAdmissions?: ReadonlyMap<string, PreparedWorkflowGoalPolicyAdmission>;
	/** Opaque same-process original reservation, never restored from run.json. */
	goalChildAdmission?: PreparedWorkflowGoalChildAdmission;
	/** One-use original root permission; neither lineage nor admission alone authorizes resume. */
	goalChildRecovery?: PreparedWorkflowGoalChildRecovery;
}

interface WorkflowWaitOptions extends WorkflowScheduleOptions {
	waitSignal?: AbortSignal;
	waitDeadlineMs?: number;
	onWaitProgress?: (run: WorkflowRunRecord) => void;
}

export const WORKFLOW_PROMPT_SCHEMA_DIAGNOSTIC_SINK: unique symbol = Symbol(
	"workflowPromptSchemaDiagnosticSink",
);

type WorkflowRunDiagnosticOptions = WorkflowRunOptions & {
	[WORKFLOW_PROMPT_SCHEMA_DIAGNOSTIC_SINK]?: (
		notice: string,
		digest: string,
	) => void;
	/** Internal trusted Goal entry fields; never inferred by normal launches. */
	goalChildAdmission?: PreparedWorkflowGoalChildAdmission;
};

export async function runWorkflowSpec(
	specPath: string,
	cwd: string,
	options: WorkflowRunDiagnosticOptions = {},
): Promise<WorkflowRunRecord> {
	options.launchSignal?.throwIfAborted();
	const loaded = await loadWorkflowSpec(specPath, cwd);
	options.launchSignal?.throwIfAborted();
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
	if (
		options.launch?.schema === "pi-workflow-run-launch-v2" &&
		options.launch.requestKind === "direct-dynamic" &&
		!options.autoLaunchBinding
	)
		throw new Error(
			"Auto-confirmed dynamic launch is missing its in-memory selection binding. Run /workflow auto again.",
		);
	options.launchSignal?.throwIfAborted();
	const specPath = await ensureDirectDynamicRuntimeBundle(cwd);
	options.launchSignal?.throwIfAborted();
	const loaded = await loadWorkflowSpec(specPath, cwd);
	options.launchSignal?.throwIfAborted();
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

/** Auto selection only admits artifact-graph workflows; Goal definitions are never candidates. */
function autoLaunchArtifactGraphSpec(spec: Parameters<typeof compileWorkflow>[0]): ArtifactGraphWorkflowSpec {
	if (!("artifactGraph" in spec)) throw new Error("Auto-confirmed launches require an artifact-graph workflow");
	return spec;
}

/** A Goal root definition or an artifact graph with an embedded Goal stage. */
function specParticipatesInGoal(spec: unknown): boolean {
	if (!spec || typeof spec !== "object" || Array.isArray(spec)) return false;
	if (Object.hasOwn(spec, "goal")) return true;
	const graph = (spec as Record<string, unknown>).artifactGraph;
	if (!graph || typeof graph !== "object" || Array.isArray(graph)) return false;
	const stages = (graph as Record<string, unknown>).stages;
	return Array.isArray(stages) && stages.some(stage =>
		stage !== null && typeof stage === "object" && !Array.isArray(stage) &&
		(stage as Record<string, unknown>).type === "goal");
}

async function runLoadedWorkflowSpec(
	cwd: string,
	specPath: string,
	spec: Parameters<typeof compileWorkflow>[0],
	options: WorkflowRunDiagnosticOptions,
	diagnosticsPolicy: PromptSchemaDiagnosticsPolicy,
	provenance?: WorkflowRunRecord["provenance"],
): Promise<WorkflowRunRecord> {
	const run = () => runLoadedWorkflowSpecInNativeHostScope(
		cwd, specPath, spec, options, diagnosticsPolicy, provenance,
	);
	// Goal-participating runs keep the legacy tool surface: native host tools
	// (codemode/MCP) would widen the consented Goal authority.
	return options.goalChildAdmission !== undefined || specParticipatesInGoal(spec)
		? withoutWorkflowNativeHostContext(run)
		: withResolvedWorkflowNativeHostContext(cwd, run);
}

async function runLoadedWorkflowSpecInNativeHostScope(
	cwd: string,
	specPath: string,
	spec: Parameters<typeof compileWorkflow>[0],
	options: WorkflowRunDiagnosticOptions,
	diagnosticsPolicy: PromptSchemaDiagnosticsPolicy,
	provenance?: WorkflowRunRecord["provenance"],
): Promise<WorkflowRunRecord> {
	options.launchSignal?.throwIfAborted();
	const childCapture = options.goalChildAdmission
		? await workflowGoalChildCompilation(options.goalChildAdmission) : undefined;
	if (childCapture && (specPath !== childCapture.specPath || options.runId !== childCapture.runId ||
		options.parentRunId !== childCapture.parentRunId || options.task !== childCapture.task ||
		workflowDefinitionFingerprint(spec) !== workflowDefinitionFingerprint(childCapture.definition)))
		throw new Error("Goal child launch differs from original reserved source/request");
	if (options.launch) assertValidWorkflowRunLaunchCapture(options.launch);
	if (options.launch?.schema === "pi-workflow-run-launch-v2") {
		const actualRequestKind =
			diagnosticsPolicy === "excluded-direct-dynamic"
				? "direct-dynamic"
				: "named-workflow";
		if (options.launch.requestKind !== actualRequestKind)
			throw new Error(
				"Auto-confirmed launch metadata does not match the requested execution path. Run /workflow auto again.",
			);
		if (!options.autoLaunchBinding)
			throw new Error(
				options.launch.requestKind === "named-workflow"
					? "Auto-confirmed named launch is missing its in-memory selection binding. Run /workflow auto again."
					: "Auto-confirmed dynamic launch is missing its in-memory selection binding. Run /workflow auto again.",
			);
		if (
			options.launch.requestKind === "direct-dynamic" &&
			options.autoLaunchBinding.runtimeVersion !== DIRECT_DYNAMIC_RUNTIME_VERSION
		)
			throw new Error(
				"Auto selection is stale: direct dynamic runtime changed before launch. Run /workflow auto again.",
			);
		const taskSha256 = createHash("sha256")
			.update(options.task?.trim() ?? "", "utf8")
			.digest("hex");
		if (taskSha256 !== options.launch.selection.taskSha256)
			throw new Error(
				"Auto selection is stale: task changed before launch. Run /workflow auto again.",
			);
		const effectiveFast =
			options.runtimeOverrides?.fast === "on" ||
			options.runtimeOverrides?.fast === "off"
				? options.runtimeOverrides.fast
				: options.runtimeDefaults?.fast === "on" ||
						options.runtimeDefaults?.fast === "off"
					? options.runtimeDefaults.fast
					: undefined;
		const effectiveRuntime = {
			...(options.runtimeDefaults?.model
				? { model: options.runtimeDefaults.model }
				: {}),
			...(options.runtimeDefaults?.thinking
				? { thinking: options.runtimeDefaults.thinking }
				: {}),
			...(options.runtimeOverrides?.model
				? { model: options.runtimeOverrides.model }
				: {}),
			...(options.runtimeOverrides?.thinking
				? { thinking: options.runtimeOverrides.thinking }
				: {}),
			...(effectiveFast ? { fast: effectiveFast } : {}),
		};
		if (
			effectiveRuntime.model !== options.launch.selection.effectiveRuntime.model ||
			effectiveRuntime.thinking !==
				options.launch.selection.effectiveRuntime.thinking ||
			effectiveRuntime.fast !== options.launch.selection.effectiveRuntime.fast
		)
			throw new Error(
				"Auto selection is stale: runtime changed before launch. Run /workflow auto again.",
			);
		if (
			options.autoLaunchBinding &&
			(options.autoLaunchBinding.candidateId !==
				options.launch.selection.candidateId ||
				options.autoLaunchBinding.candidateIdentitySha256 !==
					options.launch.selection.candidateIdentitySha256)
		)
			throw new Error(
				"Auto selection is stale: candidate identity changed before launch. Run /workflow auto again.",
			);
	}
	if (options.autoLaunchBinding)
		await assertWorkflowAutoLaunchBindingCurrent(
			cwd,
			options.autoLaunchBinding,
			autoLaunchArtifactGraphSpec(spec),
			options.task,
			specPath,
			workflowAutoLaunchBindingSettings({
				executionProfile: options.executionProfile,
				executionProfileOverride: options.executionProfileOverride,
				runtimeDefaults: options.runtimeDefaults,
				runtimeOverrides: options.runtimeOverrides,
			}),
		);
	const executionProfile = childCapture?.executionProfile ? undefined : options.executionProfile;
	const executionProfileOverride = childCapture?.executionProfile ?? options.executionProfileOverride;
	const capturedProfile = !executionProfile
		? executionProfileOverride
		: undefined;
	if (capturedProfile) {
		const capturedDefinition = capturedProfile.definitionFingerprint;
		if (
			typeof capturedDefinition !== "string" ||
			!/^[a-f0-9]{64}$/.test(capturedDefinition)
		) {
			throw new Error(
				"pre-resolved execution profile has an invalid definition fingerprint",
			);
		}
		if (capturedDefinition !== workflowDefinitionFingerprint(spec)) {
			throw new Error(
				"Workflow definition changed after the saved profile was resolved; the run was not started. Retry the launch so the profile can be revalidated.",
			);
		}
	}
	spec = applyDeclaredWorkflowInputOverrides(spec, options.inputOverrides);
	const appliedProfile = applyWorkflowExecutionProfile(
		spec,
		executionProfile,
		executionProfileOverride,
	);
	spec = appliedProfile.spec;
	if (childCapture?.embeddedGoalPolicies?.length) {
		if (!("artifactGraph" in spec)) throw new Error("Goal embedded capture requires its original ordinary wrapper");
		spec = { ...spec, artifactGraph: { ...spec.artifactGraph,
			stages: spec.artifactGraph.stages.map(stage => {
				const captured = childCapture.embeddedGoalPolicies.find(policy => policy.stageId === stage.id);
				return captured ? { ...stage, goalDefinition: captured.definition } : stage;
			}),
		} };
	}
	// Nested compilation must follow the parent's persisted host decision. In
	// particular, a legacy parent with no nativeHost stays legacy even when the
	// resumed supervisor currently has an active native host.
	const inheritedNativeHost = options.parentRunId
		? ((await readRunRecord(cwd, options.parentRunId)).nativeHost ?? null)
		: undefined;
	let compiled = await compileWorkflow(spec, {
		cwd,
		specPath,
		task: options.task,
		nativeHost: inheritedNativeHost,
		runtimeOverrides: options.runtimeOverrides,
		runtimeDefaults: options.runtimeDefaults,
		availableModels: options.availableModels,
		agentDefinitions: childCapture?.agents,
	});
	if (options.goalChildAdmission)
		compiled = await captureWorkflowGoalChildEffectiveProfiles(options.goalChildAdmission, compiled);
	if (options.autoLaunchBinding)
		options.autoLaunchBinding = sealWorkflowAutoLaunchBindingCompiled(
			options.autoLaunchBinding,
			compiled,
		);

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

	const launchCapture = options.launch
		? normalizeWorkflowRunLaunchCapture(
				options.launch,
				options.task,
				diagnosticsPolicy === "excluded-direct-dynamic",
				appliedProfile.record?.name,
			)
		: undefined;
	if (launchCapture) assertValidWorkflowRunLaunchCapture(launchCapture);
	const runId = options.runId ?? makeRunId();
	const ancestryRootRunId = childCapture?.rootRunId ?? options.parentRunId ?? runId;
	options.launchSignal?.throwIfAborted();
	await assertWorkflowRunAvailable(cwd, runId);
	options.launchSignal?.throwIfAborted();
	const goalPolicyAdmissions = new Map<string, PreparedWorkflowGoalPolicyAdmission>();
	if (options.goalPolicyHost) {
		for (const policy of compiled.tasks.filter((task: CompiledTask) => task.kind === "goal")) {
			const input = {
				host: options.goalPolicyHost, cwd, policy,
				request: goalPolicyRequest(policy, compiled.task),
				ancestryRootRunId,
				parentRunId: runId,
				executionProfileName: appliedProfile.record?.name,
				assertCurrent: () => throwIfWorkflowStopRequested(cwd, runId),
			};
			const prepared = options.goalChildAdmission
				? await prepareWorkflowGoalDerivedPolicy(options.goalChildAdmission, input)
				: await prepareWorkflowGoalPolicy(input);
			if (!prepared) throw new Error("Goal execution confirmation cancelled; no workflow run was created");
			goalPolicyAdmissions.set(policy.id, prepared);
		}
	}
	if (("goal" in spec || childCapture?.embeddedGoalPolicies?.length) &&
		options.goalPolicyHost?.executionFoundation === "workflow-engine") {
	for (const policy of compiled.tasks.filter((task: CompiledTask) => task.kind === "goal")) {
		const prepared = goalPolicyAdmissions.get(policy.id)!;
		const plannerSpec = prepareWorkflowEngineGoalRootPlanner({
			host: options.goalPolicyHost, cwd, policy,
			request: goalPolicyRequest(policy, compiled.task),
			ancestryRootRunId, parentRunId: runId,
			executionProfileName: appliedProfile.record?.name,
			assertCurrent: () => throwIfWorkflowStopRequested(cwd, runId),
		}, prepared);
		const planning = await compileWorkflow(plannerSpec, { cwd, specPath,
			agentDefinitions: workflowEngineGoalAgentDefinitions({ host: options.goalPolicyHost, cwd, policy,
				request: goalPolicyRequest(policy, compiled.task), ancestryRootRunId,
				parentRunId: runId, executionProfileName: appliedProfile.record?.name,
				assertCurrent: () => throwIfWorkflowStopRequested(cwd, runId) }, prepared),
			availableModels: [...options.goalPolicyHost.availableModels] });
		const predecessors = [...policy.dependsOn];
		for (let index = 0; index < planning.tasks.length; index++) {
			const planner = planning.tasks[index] as CompiledTask;
			planner.dependsOn = [...predecessors];
			planning.tasks[index] = captureWorkflowGoalScopedTaskRuntime({
				host: options.goalPolicyHost, cwd, policy,
				request: goalPolicyRequest(policy, compiled.task), ancestryRootRunId, parentRunId: runId,
				executionProfileName: appliedProfile.record?.name,
				assertCurrent: () => throwIfWorkflowStopRequested(cwd, runId),
			}, prepared, planner, 0, "planning");
		}
		policy.dependsOn = planning.tasks.map((task: CompiledTask) => task.id);
		compiled.tasks.unshift(...planning.tasks);
		compiled.warnings.push(...planning.warnings);
	}
	}
	if (options.goalChildAdmission) {
		await bindWorkflowGoalChildCompiled(options.goalChildAdmission, compiled);
	}
	const { run } = await createRunRecord(cwd, compiled, specPath, {
		runId,
		parentRunId: options.parentRunId,
		rootRunId: childCapture?.rootRunId ?? options.parentRunId,
		initialize: false,
	});
	if (options.goalChildAdmission) {
		run.goalChild = workflowGoalChildLineage(options.goalChildAdmission);
	}
	const goalPaths = compiled.tasks.filter((task: CompiledTask) => task.kind === "goal").map((task: CompiledTask) => task.stageId ?? task.id);
	if (goalPaths.length > 0)
		run.goalParticipation = { schemaVersion: 1, resumeRequired: options.goalPolicyHost === undefined, goalPaths };
	if (provenance) run.provenance = provenance;
	if (options.routing) run.routing = options.routing;
	if (appliedProfile.record) run.executionProfile = appliedProfile.record;
	if (options.goalPolicyHost?.executionFoundation === "workflow-engine") {
		for (const policy of compiled.tasks.filter((value: CompiledTask) => value.kind === "goal")) {
			const prepared = goalPolicyAdmissions.get(policy.id)!;
			const root = run.tasks.find(value => value.specId === policy.id)!;
			root.goalProfileConfiguration = workflowGoalProfileConfiguration(prepared);
		}
	}
	const bindPublishedGoalRequests = () => {
		if (options.goalPolicyHost?.executionFoundation !== "workflow-engine") return;
		for (const policy of compiled.tasks.filter((value: CompiledTask) => value.kind === "goal")) {
			const prepared = goalPolicyAdmissions.get(policy.id)!;
			const root = run.tasks.find(value => value.specId === policy.id)!;
			for (const planner of compiled.tasks.filter((value: CompiledTask) =>
				policy.dependsOn.includes(value.id) && value.id.startsWith(`${policy.stageId ?? policy.id}.$rootPlanner`))) {
				bindWorkflowGoalRequestTask({ host: options.goalPolicyHost, cwd, policy,
					request: goalPolicyRequest(policy, compiled.task), ancestryRootRunId,
					parentRunId: runId, executionProfileName: appliedProfile.record?.name,
					assertCurrent: () => throwIfWorkflowStopRequested(cwd, runId) }, prepared, run, root,
					run.tasks.find(value => value.specId === planner.id)!, planner, 0, "planning");
			}
		}
	};
	let initialized: WorkflowRunRecord | undefined;
	const liveKey = `${resolve(cwd)}\0${runId}`;
	const assertNoInitialLiveBindings = () => {
		if (liveGoalChildAdmissions.has(liveKey) || liveGoalPolicyHosts.has(liveKey) ||
			liveGoalPolicyAdmissions.has(liveKey))
			throw new Error("Goal initialization cannot replace existing live bindings");
	};
	let installedChild: typeof options.goalChildAdmission;
	let installedHost: typeof options.goalPolicyHost;
	let installedAdmission: ReturnType<typeof liveGoalPolicyAdmissions.get>;
	beginWorkflowGoalInitializationBindings(run);
	try {
	assertNoInitialLiveBindings();
	try {
		if (launchCapture?.command.state === "captured")
			await prepareWorkflowLaunchCommandArtifactPath(cwd, runId);
		options.launchSignal?.throwIfAborted();
		initialized = await withRunLease(cwd, run.runId, async (leaseSignal) => {
			options.launchSignal?.throwIfAborted();
			await assertRunLeaseOwnership(cwd, run.runId, leaseSignal);
			if (options.goalChildAdmission) await assertWorkflowGoalChildCurrent(options.goalChildAdmission, run, compiled);
			const existing = await readJson(workflowRunPath(cwd, run.runId));
			if (existing !== undefined) {
				throw new Error(
					`Cannot initialize workflow run ${run.runId}: a persisted run already exists`,
				);
			}
			await assertRunLeaseOwnership(cwd, run.runId, leaseSignal);
			options.launchSignal?.throwIfAborted();
			await initializeRunRecordDirectories(cwd, run);
			await assertRunLeaseOwnership(cwd, run.runId, leaseSignal);
			options.launchSignal?.throwIfAborted();
			if (launchCapture)
				run.launch = await persistWorkflowRunLaunch(cwd, run.runId, launchCapture);
			// Sidecar persistence does not commit permission to execute. Cancellation
			// still prevents publication and the first scheduler dispatch.
			options.launchSignal?.throwIfAborted();
			await assertRunLeaseOwnership(cwd, run.runId, leaseSignal);
			await writeStaticRunArtifacts(cwd, run, compiled, spec);
			options.launchSignal?.throwIfAborted();
			if (options.autoLaunchBinding) {
				// Agent files are not copied into the workflow bundle, so recheck the
				// complete accepted source set before the first scheduler dispatch too.
				await assertWorkflowAutoLaunchBindingCurrent(
					cwd,
					options.autoLaunchBinding,
					autoLaunchArtifactGraphSpec(spec),
					options.task,
					specPath,
					workflowAutoLaunchBindingSettings({
						executionProfile: options.executionProfile,
						executionProfileOverride: options.executionProfileOverride,
						runtimeDefaults: options.runtimeDefaults,
						runtimeOverrides: options.runtimeOverrides,
					}),
				);
				await assertWorkflowAutoLaunchBindingFrozen(
					cwd,
					run.runId,
					options.autoLaunchBinding,
				);
			}
			options.launchSignal?.throwIfAborted();
			await writeRunRecord(cwd, run, leaseSignal);
			const persisted = await readRunRecord(cwd, run.runId);
			const persistedCompiled = await readCompiledWorkflow(cwd, run.runId);
			if (
				persisted.runId !== run.runId ||
				persisted.createdAt !== run.createdAt || !persistedCompiled ||
				workflowDefinitionFingerprint(persistedCompiled) !== workflowDefinitionFingerprint(compiled)
			) {
				throw new Error(
					`Cannot initialize workflow run ${run.runId}: persisted run identity changed`,
				);
			}
			if (options.goalPolicyHost?.executionFoundation === "workflow-engine") {
				for (const policy of compiled.tasks.filter((task: CompiledTask) => task.kind === "goal")) {
					const prepared = goalPolicyAdmissions.get(policy.id);
					const task = persisted.tasks.find(candidate => candidate.specId === policy.id);
					if (!prepared || !task || goalHash(task.goalProfileConfiguration) !==
						goalHash(workflowGoalProfileConfiguration(prepared)))
						throw new Error("Goal initial profile publication readback changed");
					publishWorkflowGoalProfileConfiguration(prepared);
					assertWorkflowGoalProfileConfigurationCurrent(prepared, task.goalProfileConfiguration, policy);
				}
			}
			if (options.goalChildAdmission)
				await bindWorkflowGoalChildRun(options.goalChildAdmission, run, compiled);
			bindPublishedGoalRequests();
			return persisted;
		});
	} catch (error) {
		if (options.autoLaunchBinding)
			await removeUnpublishedAutoRunDirectory(cwd, run.runId);
		throw error;
	}
	if (!initialized) {
		throw new Error(
			`Could not acquire supervisor lease to initialize ${run.runId}; another supervisor may be active`,
		);
	}
	const liveAdmission = options.goalPolicyHost?.executionFoundation === "workflow-engine" && goalPolicyAdmissions.size > 0
		? {
			host: options.goalPolicyHost, rootRunId: ancestryRootRunId,
			runtime: options.goalPolicyHost.runtime,
			executionProfileHash: workflowDefinitionFingerprint(appliedProfile.record ?? null),
			admissions: new Map(goalPolicyAdmissions),
			compiled,
			runWrites: new Set<Promise<void>>(),
			publicationPending: false,
		} : undefined;
	assertNoInitialLiveBindings();
	if (options.goalChildAdmission) {
		liveGoalChildAdmissions.set(liveKey, options.goalChildAdmission);
		installedChild = options.goalChildAdmission;
	}
	if (options.goalPolicyHost && goalPolicyAdmissions.size > 0) {
		liveGoalPolicyHosts.set(liveKey, options.goalPolicyHost);
		installedHost = options.goalPolicyHost;
	}
	if (liveAdmission) {
		liveGoalPolicyAdmissions.set(liveKey, liveAdmission);
		installedAdmission = liveAdmission;
	}
	completeWorkflowGoalInitializationBindings(run);
	await dynamicControllerTestHooks.onSchedulerObservation?.(Object.freeze({
		cwd, runId, phase: "pre-schedule",
		admissionPresent: options.goalChildAdmission !== undefined,
		leaseActive: false,
	}));
	} catch (error) {
		if (installedChild && liveGoalChildAdmissions.get(liveKey) === installedChild)
			liveGoalChildAdmissions.delete(liveKey);
		if (installedHost && liveGoalPolicyHosts.get(liveKey) === installedHost)
			liveGoalPolicyHosts.delete(liveKey);
		if (installedAdmission && liveGoalPolicyAdmissions.get(liveKey) === installedAdmission)
			liveGoalPolicyAdmissions.delete(liveKey);
		for (const prepared of goalPolicyAdmissions.values())
			markWorkflowGoalProfilePublicationUnknown(prepared);
		revokeWorkflowGoalInitializationBindings(run);
		throw error;
	}

	const scheduleOptions: WorkflowScheduleOptions = {
		dynamicUi: options.dynamicUi,
		availableModels: options.availableModels,
		goalPolicyHost: options.goalPolicyHost,
		goalPolicyAdmissions,
		goalChildAdmission: options.goalChildAdmission,
	};
	const unbindLaunchSignal = bindWorkflowLaunchSignal(
		cwd,
		initialized.runId,
		options.launchSignal,
	);
	let launchStop: Promise<void> | undefined;
	const requestLaunchStop = (): Promise<void> => {
		if (!options.launchSignal?.aborted) return Promise.resolve();
		// Persist once; the in-memory signal already fences dispatch while this
		// write is pending. Drain it before removing the launch-owned fence.
		return (launchStop ??= requestWorkflowStop(cwd, initialized.runId).then(
			() => undefined,
		));
	};
	const onLaunchAbort = () => {
		// The stop intent is durable and the scheduler/lease path owns cleanup.
		// Do not report cancellation as success while an already-created run settles.
		void requestLaunchStop().catch(() => undefined);
	};
	options.launchSignal?.addEventListener("abort", onLaunchAbort, { once: true });
	try {
		await requestLaunchStop();
		let scheduled =
			(await scheduleRun(cwd, initialized.runId, compiled, scheduleOptions)) ??
			(await readRunRecord(cwd, initialized.runId));
		if (options.launchSignal?.aborted) {
			await requestLaunchStop();
			// Terminal status alone does not prove the durable intent was cleared.
			// Retry the terminal-capable finalizer under the normal supervisor lease.
			const current = await readRunRecord(cwd, initialized.runId);
			scheduled = (
				await confirmRequestedWorkflowStop(cwd, initialized.runId, current)
			).run;
		}
		if (shouldWatchRun(scheduled))
			watchRun(cwd, scheduled.runId, scheduleOptions);
		return scheduled;
	} finally {
		options.launchSignal?.removeEventListener("abort", onLaunchAbort);
		try {
			await launchStop;
		} finally {
			unbindLaunchSignal();
		}
	}
}

/** A stale auto source must not leave an unregistered run snapshot discoverable as a workflow. */
async function removeUnpublishedAutoRunDirectory(
	cwd: string,
	runId: string,
): Promise<void> {
	const runFile = workflowRunPath(cwd, runId);
	try {
		await stat(runFile);
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
	}
	await rm(dirname(runFile), { recursive: true, force: true }).catch(
		() => undefined,
	);
}

function normalizeWorkflowRunLaunchCapture(
	capture: WorkflowRunLaunchCapture,
	task: string | undefined,
	directDynamic: boolean,
	profileName: string | undefined,
): WorkflowRunLaunchCapture {
	const runtimeTask = task?.trim() ?? "";
	const normalized = {
		profile: directDynamic
			? ({ kind: "not-applicable" } as const)
			: profileName
				? ({ kind: "named", name: profileName } as const)
				: ({ kind: "base" } as const),
		task: {
			characters: Array.from(runtimeTask).length,
			lines: runtimeTask.length === 0 ? 0 : runtimeTask.split(/\r\n|\r|\n/).length,
		},
	};
	return { ...capture, ...normalized };
}

async function persistWorkflowRunLaunch(
	cwd: string,
	runId: string,
	capture: WorkflowRunLaunchCapture,
): Promise<WorkflowRunLaunchMetadata> {
	const command =
		capture.command.state === "captured"
			? await writeWorkflowLaunchCommandArtifact(cwd, runId, capture.command.text)
			: capture.command;
	if (capture.schema === "pi-workflow-run-launch-v2") {
		return {
			schema: capture.schema,
			source: capture.source,
			requestKind: capture.requestKind,
			routingMode: capture.routingMode,
			profile: capture.profile,
			task: capture.task,
			selection: capture.selection,
			command,
		};
	}
	return {
		schema: capture.schema,
		source: capture.source,
		requestKind: capture.requestKind,
		routingMode: capture.routingMode,
		profile: capture.profile,
		task: capture.task,
		command,
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

function workflowWaitAbortError(signal: AbortSignal): Error {
	if (signal.reason instanceof Error) return signal.reason;
	const error = new Error("Workflow wait cancelled");
	error.name = "AbortError";
	return error;
}

export function awaitWithinWorkflowWaitBoundary<T>(
	operation: Promise<T>,
	remainingMs: number,
	signal: AbortSignal | undefined,
	timeoutMessage: string,
): Promise<T> {
	if (signal?.aborted) return Promise.reject(workflowWaitAbortError(signal));
	if (remainingMs <= 0) return Promise.reject(new Error(timeoutMessage));
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			callback();
		};
		const onAbort = () =>
			finish(() => reject(workflowWaitAbortError(signal as AbortSignal)));
		const timer = setTimeout(
			() => finish(() => reject(new Error(timeoutMessage))),
			remainingMs,
		);
		// This timer is the only active handle when the wrapped operation is a
		// pending Promise. Keep it referenced so Node 22 cannot exit before the
		// awaited timeout boundary settles.
		signal?.addEventListener("abort", onAbort, { once: true });
		operation.then(
			(value) => finish(() => resolve(value)),
			(error) => finish(() => reject(error)),
		);
	});
}

export async function waitForRun(
	cwd: string,
	runIdOrPrefix: string,
	timeoutMs?: number,
	options: WorkflowWaitOptions = {},
): Promise<WorkflowRunRecord> {
	return waitForRunWithForegroundSupervisor(cwd, runIdOrPrefix, timeoutMs, options);
}

async function waitForRunWithForegroundSupervisor(
	cwd: string,
	runIdOrPrefix: string,
	timeoutMs?: number,
	options: WorkflowWaitOptions = {},
): Promise<WorkflowRunRecord> {
	const timeout = clampTimeout(timeoutMs);
	const timeoutDeadline = Date.now() + timeout;
	const { waitSignal, waitDeadlineMs, onWaitProgress, ...scheduleOptions } =
		options;
	const deadline = Number.isFinite(waitDeadlineMs)
		? Math.min(timeoutDeadline, waitDeadlineMs as number)
		: timeoutDeadline;
	const initialTimeoutMessage = `Flow run ${runIdOrPrefix} still running after ${timeout}ms wait`;
	if (waitSignal?.aborted) throw workflowWaitAbortError(waitSignal);
	const initialRemaining = deadline - Date.now();
	if (initialRemaining <= 0) throw new Error(initialTimeoutMessage);
	let run = await awaitWithinWorkflowWaitBoundary(
		scheduleOptions.goalChildAdmission !== undefined
			? refreshRun(cwd, runIdOrPrefix, scheduleOptions.goalChildAdmission)
			: refreshRunOrRecordPollError(
			cwd,
			runIdOrPrefix,
			undefined,
		),
		initialRemaining,
		waitSignal,
		initialTimeoutMessage,
	);
	onWaitProgress?.(run);

	while (hasActiveSchedulerWork(run)) {
		const timeoutMessage = await stillRunningAfterWaitMessage(run, timeout);
		const scheduled = await awaitWithinWorkflowWaitBoundary(
			scheduleRun(cwd, run.runId, undefined, scheduleOptions),
			deadline - Date.now(),
			waitSignal,
			timeoutMessage,
		);
		if (scheduled) run = scheduled;
		onWaitProgress?.(run);
		if (!hasActiveSchedulerWork(run)) return run;
		run = await awaitWithinWorkflowWaitBoundary(
			scheduleOptions.goalChildAdmission !== undefined
				? refreshRun(cwd, run.runId, scheduleOptions.goalChildAdmission)
				: refreshRunOrRecordPollError(
				cwd,
				run.runId,
				run,
			),
			deadline - Date.now(),
			waitSignal,
			timeoutMessage,
		);
		onWaitProgress?.(run);
		if (!hasActiveSchedulerWork(run)) return run;
		const remaining = deadline - Date.now();
		await awaitWithinWorkflowWaitBoundary(
			sleep(schedulerPollDelayMs(run, remaining)),
			remaining,
			waitSignal,
			timeoutMessage,
		);
		run = await awaitWithinWorkflowWaitBoundary(
			scheduleOptions.goalChildAdmission !== undefined
				? refreshRun(cwd, run.runId, scheduleOptions.goalChildAdmission)
				: refreshRunOrRecordPollError(
				cwd,
				run.runId,
				run,
			),
			deadline - Date.now(),
			waitSignal,
			timeoutMessage,
		);
		onWaitProgress?.(run);
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
		(task) => task.status === "blocked" && !isBlockedTaskResumableForResume(task),
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
	const stopped = await finalizeStopRunWithLease(
		cwd,
		runId,
		new Set(),
	);
	if (stopped) return { stopped, latest: stopped.run };
	const refreshed = await readRunRecord(cwd, runId).catch(() => latest);
	const intentPending = await readWorkflowStopIntent(cwd, runId);
	if (!hasActiveSchedulerWork(refreshed) && !intentPending) {
		return { latest: refreshed };
	}
	await sleep(STOP_RUN_LEASE_RETRY_MS);
	return confirmStopRunUntil(
		cwd,
		runId,
		deadline,
		refreshed,
	);
}

export async function stopRun(
	cwd: string,
	runIdOrPrefix: string,
	ordinaryGoalHost?: WorkflowGoalPolicyHost,
): Promise<StopRunSummary> {
	const current = await readRunRecord(cwd, runIdOrPrefix);
	if (ordinaryGoalHost) await assertOrdinaryGoalCommandCurrent(cwd, current, ordinaryGoalHost);
	assertNotProtectedGoalEngineRun(current);
	if (
		isTerminalWorkflowStatus(current.status) &&
		!(await readWorkflowStopIntent(cwd, current.runId))
	) {
		throw new Error(
			`stop requires a non-terminal run; ${current.runId} is ${current.status}`,
		);
	}
	await requestWorkflowStop(cwd, current.runId);
	return confirmRequestedWorkflowStop(cwd, current.runId, current);
}

/** Confirm an already-durable exact-run request, including terminal cleanup. */
async function confirmRequestedWorkflowStop(
	cwd: string,
	runId: string,
	current: WorkflowRunRecord,
): Promise<StopRunSummary> {
	const confirmation = await confirmStopRunUntil(
		cwd,
		runId,
		Date.now() + STOP_RUN_LEASE_WAIT_MS,
		current,
	);
	if (confirmation.stopped) return confirmation.stopped;
	const latest = await readRunRecord(cwd, runId).catch(
		() => confirmation.latest,
	);
	if (
		hasActiveSchedulerWork(latest) ||
		(await readWorkflowStopIntent(cwd, runId))
	) {
		throw createWorkflowStopPendingError(
			`Workflow stop requested for ${runId}, but active work or descendant workflow stop could not be confirmed within ${STOP_RUN_LEASE_WAIT_MS}ms; stop intent remains durable and cancellation is still pending. Retry /workflow stop ${runId}`,
		);
	}
	return { run: latest, interruptedTaskIds: workflowStoppedTaskIds(latest) };
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
		if (runId.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) {
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
	const alreadyTerminal = async (runId: string): Promise<boolean> => {
		const record = await readJson<WorkflowRunRecord>(workflowRunPath(cwd, runId));
		if (!record) return false;
		if (record.runId !== runId) throw new Error("Descendant stop run identity changed");
		return isTerminalWorkflowStatus(deriveRunStatus(record).status);
	};
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
			if (await alreadyTerminal(runId)) continue;
			await requestWorkflowStop(cwd, runId);
		} catch (error) {
			// Another original stop owner may have consumed the intent after
			// exclusive publication collided. Never recreate a terminal fence.
			if (await alreadyTerminal(runId)) continue;
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
			if (await alreadyTerminal(run.runId)) continue;
			await requestWorkflowStop(cwd, run.runId);
		} catch (error) {
			if (await alreadyTerminal(run.runId)) continue;
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

async function cleanupWorkflowOwnedRun(
	cwd: string,
	run: WorkflowRunRecord,
): Promise<void> {
	captureWorkflowGoalUnlaunchedStop(run);
	const ordinaryPolicies = run.tasks.filter(task => task.kind === "goal" &&
		task.status === "running" && (!task.goal || task.goal.state.startsWith("engine:")));
	let ordinaryCancellationConfirmed = false;
	let ordinaryBackendMembersCleaned = false;
	if (ordinaryPolicies.length && run.goalParticipation && !isProtectedGoalEngineRun(run)) {
		const key = `${resolve(cwd)}\0${run.runId}`;
		const live = liveGoalPolicyAdmissions.get(key), host = liveGoalPolicyHosts.get(key);
		const compiled = await readCompiledWorkflow(cwd, run.runId);
		const stop = await readWorkflowStopIntent(cwd, run.runId);
		if (!live || !host || host !== live.host || !compiled || !stop || stop.runId !== run.runId)
			throw new Error("Goal cancellation requires original live admission and stop intent; stop remains pending");
		await assertOrdinaryGoalCommandCurrent(cwd, run, host);
		const assertCurrent = async () => {
			await assertOrdinaryGoalCommandCurrent(cwd, run, host);
			if (liveGoalPolicyAdmissions.get(key) !== live || liveGoalPolicyHosts.get(key) !== host ||
				workflowDefinitionFingerprint(await readWorkflowStopIntent(cwd, run.runId) ?? null) !== workflowDefinitionFingerprint(stop) ||
				workflowDefinitionFingerprint(await readCompiledWorkflow(cwd, run.runId) ?? null) !== workflowDefinitionFingerprint(compiled))
				throw new Error("Goal cancellation original stop/admission/profile changed; stop remains pending");
		};
		// Only the source-owned nonprovider policies are withheld here. Every real
		// backend member (and every private Goal) retains original cleanup routing.
		const backendMembers = run.tasks.filter(task => !ordinaryPolicies.includes(task));
		if (backendMembers.some(task => task.status === "running")) {
			await resolveWorkflowBackend(run).cleanupRun(cwd, { ...run, tasks: backendMembers });
			ordinaryBackendMembersCleaned = true;
		}
		await writeRunRecord(cwd, run);
		for (const task of ordinaryPolicies) {
			const policy = compiled.tasks.find(source => source.id === task.specId && source.kind === "goal");
			const prepared = policy && live.admissions.get(policy.id);
			if (!policy?.goal || !prepared)
				throw new Error("Goal cancellation original nonprovider policy missing; stop remains pending");
			await assertWorkflowEngineGoalCancellation({ host, cwd, policy,
				request: goalPolicyRequest(policy, compiled.task), ancestryRootRunId: live.rootRunId,
				parentRunId: run.runId, executionProfileName: run.executionProfile?.name, assertCurrent },
				prepared, run, compiled.tasks);
		}
		await assertCurrent();
		for (const task of ordinaryPolicies)
			setTaskTerminal(task, "interrupted", "workflow_stopped", {
				exitCode: 130, lastMessage: "Workflow stopped by user request",
			});
		ordinaryCancellationConfirmed = true;
	}
	if (run.tasks.some(task => task.kind === "goal" && task.goal && task.status !== "completed" && !task.goal.state.startsWith("engine:")))
		throw new Error("Goal cancellation requires an ordinary workflow-engine Goal; stop intent remains pending");
	if (!ordinaryBackendMembersCleaned) await resolveWorkflowBackend(run).cleanupRun(cwd, run);
	if (ordinaryCancellationConfirmed) await writeRunRecord(cwd, run);
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
		// A failed original publication is not an admitted inventory for cleanup.
		// Leave its exact bytes and durable stop intent intact, including foreign
		// final-write bytes. The parent remains pending/UNKNOWN, never stopped.
		if (workflowGoalChildForeachPublicationUnknown(cwd, runId)) return undefined;
		const run = await readRunRecord(cwd, runId);
		assertNotProtectedGoalEngineRun(run);
		if (isTerminalWorkflowStatus(run.status)) {
			await clearTerminalWorkflowStopIntentIfPresent(cwd, run);
			// Another scheduler may have consumed the durable stop intent before
			// this caller acquired the lease. Preserve the same summary either way.
			return { run, interruptedTaskIds: workflowStoppedTaskIds(run) };
		}
		for (const task of run.tasks) {
			if (task.status !== "running") continue;
			task.statusDetail = "cancellation_pending";
			task.lastMessage = "awaiting backend stop cancellation acknowledgement";
		}
		await writeRunRecord(cwd, run);
		let cleanupError: unknown;
		try {
			await cleanupWorkflowOwnedRun(cwd, run);
		} catch (error) {
			cleanupError = error;
		}
		const cleanupCauses: string[] = [];
		const pendingCauses: unknown[] = cleanupError ? [cleanupError] : [];
		const seenCauses = new Set<unknown>();
		while (pendingCauses.length && cleanupCauses.length < 8) {
			const cause = pendingCauses.shift();
			if (seenCauses.has(cause)) continue;
			seenCauses.add(cause);
			cleanupCauses.push((cause instanceof Error ? cause.message : String(cause)).slice(0, 256));
			if (cause instanceof Error && cause.cause !== undefined) pendingCauses.push(cause.cause);
			if (cause instanceof AggregateError) pendingCauses.push(...cause.errors.slice(0, 8));
		}
		const cleanupDetail = cleanupCauses.length ? `; cleanup cause: ${cleanupCauses.join(" -> ")}` : "";
		if (cleanupError && (isProtectedGoalEngineRun(run) || run.goalParticipation !== undefined || run.goalChild !== undefined)) {
			// Goal cleanup uncertainty retains running/pending state and durable stop
			// intent. A thrown SDK/backend cleanup is never a terminal observation.
			await writeRunRecord(cwd, run);
			throw new Error(
				`Workflow stop could not confirm cancellation for ${run.runId}; Goal effects remain active, pending, or unknown${cleanupDetail}`,
				{ cause: cleanupError },
			);
		}
		const interruptedTaskIds = markRunStopped(run);
		await writeRunRecord(cwd, run);
		if (cleanupError) {
			throw new Error(
				`Workflow stop could not confirm cancellation for ${run.runId}; worker state remains observable${cleanupDetail}`,
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
	await cleanupWorkflowOwnedRun(cwd, run);
	const interruptedTaskIds = markRunStopped(run);
	if (interruptedTaskIds.length > 0) await writeRunRecord(cwd, run);
	await clearWorkflowStopIntent(cwd, run.runId);
	unwatchRun(cwd, run.runId);
	return true;
}

function workflowStoppedTaskIds(run: WorkflowRunRecord): string[] {
	return run.tasks
		.filter(
			(task) =>
				task.status === "interrupted" && task.statusDetail === "workflow_stopped",
		)
		.map((task) => task.taskId);
}

function markRunStopped(run: WorkflowRunRecord): string[] {
	const interruptedTaskIds: string[] = [];
	for (const task of run.tasks) {
		const durableBarrierRecord = task.durableLaunchBarrier?.records.at(-1);
		if (
			task.status === "running" &&
			(task.statusDetail === "cancellation_failed" ||
				(durableBarrierRecord !== undefined &&
					durableBarrierRecord.phase !== "cancellation_acknowledged"))
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
	for (const record of run.foreachBatches ?? []) {
		if (!isActiveForeachBatchPhase(record.phase)) continue;
		markForeachBatchStopped(run, record);
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
	return structuredClone(value);
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
		compiled?.perItemDispatch === persisted?.perItemDispatch &&
		compiled?.batch?.enabled === persisted?.batch?.enabled &&
		compiled?.batch?.groupBy === persisted?.batch?.groupBy &&
		compiled?.batch?.groupKey === persisted?.batch?.groupKey
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
			// A directly resumed generated child keeps its frozen item membership.
			// Only downstream foreach groups need transactional rematerialization.
			if (specId !== sourceSpecId) {
				recordOwnership(
					compiledTask?.foreachGenerated?.placeholderSpecId ??
						runTask?.foreachGenerated?.placeholderSpecId,
					compiledTask,
					runTask,
					sourceSpecId,
				);
			}
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
			(task) => task.foreachGenerated?.placeholderSpecId === placeholderSpecId,
		);
		const runChildren = run.tasks.filter(
			(task) => task.foreachGenerated?.placeholderSpecId === placeholderSpecId,
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
				!sameForeachInvalidationChild(compiledChild, child, placeholderSpecId)
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
			!dependencies.some((dependency) => resumableSourceSpecIds.has(dependency)) ||
			!dependencyResumeInvalidationEnabled(compiledBySpecId.get(task.specId), task)
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
	const foreachAffectedSpecIds = new Set(invalidatedSpecIds);
	const preservedSourceGroupSpecIds = new Set<string>();
	const preservedSourcePlaceholderSpecIds = new Set<string>();
	for (const sourceSpecId of sourceSpecIds) {
		const compiledSource = compiledBySpecId.get(sourceSpecId);
		const runSource = runTaskBySpecId.get(sourceSpecId);
		const generatedPlaceholder =
			compiledSource?.foreachGenerated?.placeholderSpecId ??
			runSource?.foreachGenerated?.placeholderSpecId;
		if (!generatedPlaceholder) {
			foreachAffectedSpecIds.add(sourceSpecId);
			continue;
		}
		preservedSourceGroupSpecIds.add(sourceSpecId);
		preservedSourceGroupSpecIds.add(generatedPlaceholder);
		preservedSourcePlaceholderSpecIds.add(generatedPlaceholder);
	}
	if (preservedSourcePlaceholderSpecIds.size > 0) {
		// Validate frozen membership before preserving the originating group.
		foreachInvalidationGroups(
			run,
			compiledFlow,
			preservedSourceGroupSpecIds,
			preservedSourcePlaceholderSpecIds,
		);
	}
	const foreachGroups = foreachInvalidationGroups(
		run,
		compiledFlow,
		foreachAffectedSpecIds,
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
			(generation) => !Number.isSafeInteger(generation) || generation < 0,
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
		unaffectedRunSignature: unaffectedRunStructureSignature(run, affectedTaskIds),
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
		const parent = run.tasks.find((task) => task.taskId === group.parentTaskId);
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
			throw new Error(
				`resume does not support loop workflow ownership: ${run.runId}`,
			);
		}
	}
	for (const task of run.tasks) {
		if (task.kind === "loop") {
			throw new Error(
				`resume does not support loop workflow ownership: ${run.runId}`,
			);
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
		if (leaseSignal) await assertRunLeaseOwnership(cwd, run.runId, leaseSignal);
		await rename(path.taskDir, path.quarantineDir);
		if (leaseSignal) await assertRunLeaseOwnership(cwd, run.runId, leaseSignal);
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
		idempotencyKey: invalidationIdempotencyKey(generation, taskIds, [], []),
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
	if (plan)
		assertDependencyInvalidationRematerializable(run, compiledFlow, plan);
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
	for (const record of run.foreachBatches ?? []) {
		if (
			isActiveForeachBatchPhase(record.phase) &&
			foreachPlaceholderSpecIds.has(record.placeholderSpecId)
		) {
			markForeachBatchInvalidated(record);
		}
	}
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
		!Array.isArray(journal.foreachGroups) ||
		!journal.foreachGroups.every(isValidForeachInvalidationGroupSnapshot) ||
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
	const affectedTaskIds = new Set([...sourceTaskIds, ...invalidatedTaskIds]);
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
		new Set(journal.invalidatedTaskIds).size !== journal.invalidatedTaskIds.length
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
	let childResumeAdmission: PreparedWorkflowGoalChildAdmission | undefined;
	if (current.goalChild) {
		if (!options.goalChildRecovery)
			throw new Error("Goal child explicit/plain recovery cannot restore original reserved admission");
		childResumeAdmission = await beginWorkflowGoalChildRecovery(options.goalChildRecovery, cwd, current);
		options = { ...options, goalChildAdmission: childResumeAdmission, goalChildRecovery: undefined };
	}
	assertRunResumableForResume(current);
	const ordinaryGoal = current.goalParticipation !== undefined && !isProtectedGoalEngineRun(current);
	const liveAdmission = ordinaryGoal ? liveGoalPolicyAdmissions.get(`${resolve(cwd)}\0${current.runId}`) : undefined;
	if (ordinaryGoal) {
		if (childResumeAdmission && liveAdmission)
			options = { ...options, goalPolicyHost: liveAdmission.host };
		if (!liveAdmission || resolve(current.cwd) !== resolve(cwd) ||
			options.goalPolicyHost?.executionFoundation !== "workflow-engine" ||
			options.goalPolicyHost.runtime !== liveAdmission.runtime ||
			liveAdmission.rootRunId !== (current.rootRunId ?? current.runId))
			throw new Error("Goal explicit resume requires original same-live-session host and admissions; cold/foreign recovery denied");
		options = { ...options, goalPolicyHost: liveAdmission.host, goalPolicyAdmissions: liveAdmission.admissions };
	}
	const assertOrdinaryGoalResume = async (run: WorkflowRunRecord, compiled: CompiledWorkflow) => {
		const permissions: Array<() => void> = [];
		if (childResumeAdmission) {
			if (workflowDefinitionFingerprint(run) !== workflowDefinitionFingerprint(current))
				throw new Error("Goal child recovery interrupted record changed under resume lease");
			await assertWorkflowGoalChildCurrent(childResumeAdmission, run, compiled);
			return permissions;
		}
		if (!liveAdmission) return permissions;
		if (run.status !== "interrupted" || resolve(run.cwd) !== resolve(cwd) || liveAdmission.host !== options.goalPolicyHost ||
			liveAdmission.host.runtime !== liveAdmission.runtime ||
			liveAdmission.rootRunId !== (run.rootRunId ?? run.runId) ||
			liveAdmission.executionProfileHash !== workflowDefinitionFingerprint(run.executionProfile ?? null))
			throw new Error("Goal explicit resume requires original interrupted live run");
		for (const policy of compiled.tasks.filter(task => task.kind === "goal")) {
			const prepared = liveAdmission.admissions.get(policy.id);
			if (!prepared) throw new Error("Goal explicit resume original admission missing");
			permissions.push(await prepareWorkflowEngineGoalResume({ host: liveAdmission.host, cwd, policy,
				request: goalPolicyRequest(policy, compiled.task), ancestryRootRunId: run.rootRunId ?? run.runId,
				parentRunId: run.runId, executionProfileName: run.executionProfile?.name,
				assertCurrent: () => throwIfWorkflowStopRequested(cwd, run.runId) }, prepared, run, compiled.tasks));
		}
		return permissions;
	};
	if (ordinaryGoal) {
		const compiled = await readCompiledWorkflow(cwd, current.runId);
		if (!compiled) throw new Error("Goal explicit resume compiled binding missing");
		await assertOrdinaryGoalResume(current, compiled);
	}
	assertNotProtectedGoalEngineRun(current);

	const resetTaskIds: string[] = [];
	const updated = await withRunLease(cwd, current.runId, async (leaseSignal) => {
		assertResumeLeaseActive(leaseSignal);
		const run = await readRunRecord(cwd, current.runId);
		assertRunResumableForResume(run);
		assertResumeLeaseActive(leaseSignal);

		const activeCompiledFlow = await readCompiledWorkflow(cwd, run.runId);
		assertResumeLeaseActive(leaseSignal);
		if (!activeCompiledFlow) {
			throw new Error(`Cannot resume ${run.runId}: compiled workflow is missing`);
		}
		await assertOrdinaryGoalResume(run, activeCompiledFlow);
		assertResumeLeaseActive(leaseSignal);
		await recoverPreparedForeachMaterialization(cwd, run, activeCompiledFlow);
		await recoverGoalGeneratedMaterialization(cwd, run, activeCompiledFlow);
		assertNoProtectedGoalEngineArtifacts(run, activeCompiledFlow);
		assertUnsupportedLegacyPreparedInvalidation(run, activeCompiledFlow);
		const prepared = preparedInvalidationPlan(run, activeCompiledFlow);
		if (!prepared) assertRunTaskPositionalAlignment(run, activeCompiledFlow);
		assertResumeLoopOwnershipSupported(run, activeCompiledFlow);

		const planned =
			prepared ?? dependencyResumeInvalidationPlan(run, activeCompiledFlow);
		if (childResumeAdmission && planned)
			throw new Error("Goal child recovery cannot invalidate original completed predecessors");
		if (planned) {
			assertDependencyInvalidationRematerializable(
				run,
				activeCompiledFlow,
				planned,
			);
		}
		await resumeLeaseMutation(cwd, run.runId, leaseSignal, () =>
			cleanupWorkflowOwnedRun(cwd, run),
		);
		const resumePermissions = await assertOrdinaryGoalResume(run, activeCompiledFlow);
		assertResumeLeaseActive(leaseSignal);
		if (!planned) {
			await resumeLeaseMutation(cwd, run.runId, leaseSignal, async () => {
				for (const publish of resumePermissions) publish();
				for (const task of run.tasks) {
					if (childResumeAdmission && task.status === "completed") continue;
					if (childResumeAdmission && task.status !== "interrupted")
						throw new Error("Goal child recovery resets only original interrupted attempts");
					if (resetTaskForResume(task)) resetTaskIds.push(task.taskId);
				}
				if (resetTaskIds.length > 0) await writeRunRecord(cwd, run, leaseSignal);
			});
			return run;
		}

		if (!prepared) {
			await resumeLeaseMutation(cwd, run.runId, leaseSignal, async () => {
				for (const publish of resumePermissions) publish();
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
			quarantineDependencyInvalidationArtifacts(cwd, run, planned, leaseSignal),
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
			// Generic startup recovery has no Goal host authority. Goal runs remain
			// durable and require an explicit host rebind through schedule/resume.
			if (isProtectedGoalEngineRun(run) || run.goalParticipation !== undefined || run.goalChild !== undefined) continue;
			if (hasActiveSchedulerWork(run)) {
				await scheduleRun(cwd, run.runId, undefined, options).catch((error) =>
					recordSupervisorError(cwd, run.runId, error),
				);
				watchRun(cwd, run.runId, options);
			}
		}
		// A project that has never run a workflow gets no `.pi/workflows/`
		// state from merely starting Pi; the index is created with the first run.
		if (runs.length === 0 && (await readIndex(cwd)) === undefined) return;
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

/** Test teardown must join owned polling work before deleting its run files. */
export async function stopWorkflowWatchersForTests(cwds: readonly string[]): Promise<number> {
	const roots = new Set(cwds);
	const owns = (key: string): boolean => roots.has(key.slice(0, key.indexOf("\0")));
	let stopped = 0;
	for (;;) {
		for (const key of [...supervisorTimers.keys()].filter(owns)) {
			const separator = key.indexOf("\0");
			unwatchRun(key.slice(0, separator), key.slice(separator + 1));
			stopped += 1;
		}
		const pending = [...supervisorWork.entries()]
			.filter(([key]) => owns(key))
			.flatMap(([, work]) => [...work]);
		if (pending.length === 0) return stopped;
		await Promise.all(pending);
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
		const work = (async () => {
			const previousMtime = supervisorRunMtimes.get(key);
			const beforeMtime = await readRunMtimeMs(cwd, runId);
			dynamicControllerTestHooks.onSchedulerObservation?.(Object.freeze({
				cwd, runId, phase: "watch-refresh", admissionPresent: options.goalChildAdmission !== undefined,
			}));
			const refreshed = await refreshRun(cwd, runId, options.goalChildAdmission);
			const afterMtime = await readRunMtimeMs(cwd, runId);
			const currentMtime = afterMtime ?? beforeMtime;

			if (hasActiveSchedulerWork(refreshed)) {
				const unchanged =
					previousMtime !== undefined &&
					currentMtime !== undefined &&
					currentMtime <= previousMtime;
				// Pending inventory may outlive occupied launch slots without a run-file
				// write. Retry only through the original scheduler and its admission gates.
				if (!unchanged || refreshed.tasks.some(task => task.status === "pending")) {
					dynamicControllerTestHooks.onSchedulerObservation?.(Object.freeze({
						cwd, runId, phase: "watch-schedule", admissionPresent: options.goalChildAdmission !== undefined,
					}));
					const scheduled = await scheduleRun(cwd, runId, undefined, options);
					// A busy original lease is not a handled change. Leave it dirty until
					// an actual scheduling pass obtains custody, even if bytes stay unchanged.
					if (scheduled === undefined) supervisorRunMtimes.delete(key);
					else if (currentMtime !== undefined) supervisorRunMtimes.set(key, currentMtime);
					dynamicControllerTestHooks.onWatcherScheduleResult?.(Object.freeze({
						cwd, runId, mtimeMs: currentMtime, scheduled: scheduled !== undefined,
					}));
				}
				supervisorErrorCounts.delete(key);
				return;
			}

			supervisorErrorCounts.delete(key);
			unwatchRun(cwd, runId);
		})().catch(async (error) => {
			if (isMissingRunError(error)) {
				unwatchRun(cwd, runId);
				return;
			}
			const failures = (supervisorErrorCounts.get(key) ?? 0) + 1;
			supervisorErrorCounts.set(key, failures);
			await recordSupervisorError(cwd, runId, error).finally(() => {
				if (failures >= MAX_SUPERVISOR_CONSECUTIVE_ERRORS)
					unwatchRun(cwd, runId);
			});
		});
		const pending = supervisorWork.get(key) ?? new Set<Promise<void>>();
		supervisorWork.set(key, pending);
		const tracked = work.finally(() => {
			pending.delete(tracked);
			if (pending.size === 0) supervisorWork.delete(key);
		});
		pending.add(tracked);
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
		dynamicControllerTestHooks.onSchedulerObservation?.(Object.freeze({
			cwd, runId, phase: "schedule-lease", admissionPresent: options.goalChildAdmission !== undefined,
			leaseActive: !leaseSignal.aborted,
		}));
		let run = await readRunRecord(cwd, runId);
		if (run.goalChild) {
			if (!options.goalChildAdmission) throw new Error("Goal child cold/foreign scheduling has no live original admission");
			const childCompiled = compiled ?? await readCompiledWorkflow(cwd, runId);
			if (!childCompiled) throw new Error("Goal child compiled inventory unavailable");
			await assertWorkflowGoalChildCurrent(options.goalChildAdmission, run, childCompiled);
		}
		if (run.goalParticipation !== undefined && options.goalPolicyHost === undefined) {
			run.goalParticipation.resumeRequired = true;
			for (const task of run.tasks) {
				if (task.kind !== "goal" || task.status !== "pending") continue;
				setTaskTerminal(task, "blocked", "goal_host_resume_required", { lastMessage: "Goal participation requires an explicit current host rebind; no new effects were scheduled." });
			}
			await writeRunRecord(cwd, run);
			return run;
		}
		let recoveredCompiledFlow = compiled;
		if (run.goalParticipation !== undefined && options.goalPolicyHost) {
			recoveredCompiledFlow ??= await readCompiledWorkflow(cwd, run.runId);
			if (!recoveredCompiledFlow) throw new Error("Goal policy compiled workflow binding is missing");
			try {
				const policies = recoveredCompiledFlow.tasks.filter(policy => policy.kind === "goal");
				for (const record of run.tasks.filter(task => task.goal !== undefined)) {
					if (!policies.some(policy => policy.id === record.specId))
						throw new Error("Goal policy identity has no current compiled binding");
				}
				if (options.goalPolicyHost.executionFoundation === "workflow-engine") {
					for (const policy of policies) {
						const prepared = options.goalPolicyAdmissions?.get(policy.id);
						if (!prepared) throw new Error("Goal normal engine requires fresh current consent; cold recovery cannot replay admission");
						assertPreparedWorkflowGoalPolicyCurrent({
							host: options.goalPolicyHost, cwd, policy,
							request: goalPolicyRequest(policy, recoveredCompiledFlow.task),
							ancestryRootRunId: run.rootRunId ?? run.runId, parentRunId: run.runId,
							executionProfileName: run.executionProfile?.name,
							assertCurrent: () => throwIfWorkflowStopRequested(cwd, run.runId),
						}, prepared);
					}
					for (const record of run.tasks) {
						if (record.kind === "goal" && record.status === "running" && record.statusDetail === "goal_catalog_child_waiting")
							record.status = "pending";
					}
				}
				run.goalParticipation.resumeRequired = false;
				await writeRunRecord(cwd, run);
			} catch (error) {
				run.goalParticipation.resumeRequired = true;
				for (const task of run.tasks) {
					if (task.kind === "goal" && task.status === "pending")
						setTaskTerminal(task, "blocked", "goal_host_resume_required", { lastMessage: error instanceof Error ? error.message : String(error) });
				}
				await writeRunRecord(cwd, run);
				return run;
			}
		}
		assertNotProtectedGoalEngineRun(run);
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
			recoveredCompiledFlow ?? (await readCompiledWorkflow(cwd, run.runId));
		if (!compiledFlow) return run;
		await recoverPreparedForeachMaterialization(cwd, run, compiledFlow);
		await recoverGoalGeneratedMaterialization(cwd, run, compiledFlow);
		assertNoProtectedGoalEngineArtifacts(run, compiledFlow);

		if (compiledFlow.type !== WORKFLOW_RUN_TYPE) {
			throw new Error(`unsupported compiled workflow type: ${compiledFlow.type}`);
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

type ForeachBatchLaunchPlan = {
	leaderIndex: number;
	memberIndex: number;
	record?: WorkflowForeachBatchRecord;
};

type ForeachBatchLaunchOutcome =
	| "launched"
	| "deferred"
	| "changed"
	| "unavailable";

function eligibleForeachBatchChild(
	task: WorkflowTaskRunRecord,
	compiledTask: CompiledTask,
	nativeHost: WorkflowRunRecord["nativeHost"],
): boolean {
	const grouping = compiledTask.foreachGenerated?.batch;
	const safety = prepareWorkflowNativeTaskPolicy(compiledTask, nativeHost).safety;
	return Boolean(
		task.status === "pending" &&
			!task.backendHandle &&
			!task.pid &&
			!task.outputRetry &&
			!task.foreachBatch?.batchingDisabled &&
			grouping?.enabled === true &&
			compiledTask.artifactGraph?.enabled &&
			compiledTask.artifactGraph.artifactAccess === "none" &&
			!safety.requiresWorktree &&
			safety.sharedCwdSafe,
	);
}

function sameForeachBatchGrouping(
	left: CompiledTask,
	right: CompiledTask,
): boolean {
	const leftGrouping = left.foreachGenerated?.batch;
	const rightGrouping = right.foreachGenerated?.batch;
	if (!leftGrouping || !rightGrouping) return false;
	if (leftGrouping.groupBy !== rightGrouping.groupBy) return false;
	if (!leftGrouping.groupBy) return true;
	return (
		leftGrouping.groupKey !== undefined &&
		leftGrouping.groupKey === rightGrouping.groupKey
	);
}

function sameForeachBatchGeneration(
	leftTask: WorkflowTaskRunRecord,
	rightTask: WorkflowTaskRunRecord,
	leftCompiled: CompiledTask,
	rightCompiled: CompiledTask,
): boolean {
	return (
		leftTask.generation === rightTask.generation &&
		leftTask.sourceGeneration === rightTask.sourceGeneration &&
		leftCompiled.generation === rightCompiled.generation &&
		leftCompiled.sourceGeneration === rightCompiled.sourceGeneration &&
		leftTask.generation === leftCompiled.generation &&
		rightTask.generation === rightCompiled.generation &&
		leftTask.sourceGeneration === leftCompiled.sourceGeneration &&
		rightTask.sourceGeneration === rightCompiled.sourceGeneration
	);
}

function newForeachBatchLaunchPlan(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	index: number,
	bySpecId: Map<string, WorkflowTaskRunRecord>,
): ForeachBatchLaunchPlan | undefined {
	const leaderTask = run.tasks[index];
	const leaderCompiled = compiledFlow.tasks[index];
	if (
		!leaderTask ||
		!leaderCompiled ||
		!eligibleForeachBatchChild(leaderTask, leaderCompiled, run.nativeHost) ||
		!dependenciesReady(leaderCompiled, bySpecId, compiledFlow, leaderTask)
	)
		return undefined;
	const memberIndex = index + 1;
	const memberTask = run.tasks[memberIndex];
	const memberCompiled = compiledFlow.tasks[memberIndex];
	if (
		!memberTask ||
		!memberCompiled ||
		!eligibleForeachBatchChild(memberTask, memberCompiled, run.nativeHost) ||
		!dependenciesReady(memberCompiled, bySpecId, compiledFlow, memberTask)
	)
		return undefined;
	if (
		leaderCompiled.foreachGenerated?.placeholderSpecId !==
			memberCompiled.foreachGenerated?.placeholderSpecId ||
		leaderTask.foreachGenerated?.placeholderSpecId !==
			memberTask.foreachGenerated?.placeholderSpecId ||
		leaderCompiled.stageId !== memberCompiled.stageId ||
		leaderTask.stageId !== memberTask.stageId ||
		!sameForeachBatchGeneration(
			leaderTask,
			memberTask,
			leaderCompiled,
			memberCompiled,
		) ||
		!sameForeachBatchGrouping(leaderCompiled, memberCompiled)
	)
		return undefined;
	try {
		if (
			foreachBatchExecutionSurfaceSha256(leaderCompiled) !==
			foreachBatchExecutionSurfaceSha256(memberCompiled)
		)
			return undefined;
	} catch {
		return undefined;
	}
	return { leaderIndex: index, memberIndex };
}

function preparedForeachBatchLaunchPlan(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	index: number,
): ForeachBatchLaunchPlan | undefined {
	const leaderTask = run.tasks[index];
	if (!leaderTask || leaderTask.foreachBatch?.role !== "leader")
		return undefined;
	const record = activeForeachBatchRecordForTask(run, leaderTask);
	if (!record || record.phase !== "prepared") return undefined;
	const [first, second] = foreachBatchTasks(run, record);
	const leaderIndex = run.tasks.indexOf(first);
	const memberIndex = run.tasks.indexOf(second);
	if (leaderIndex !== index || memberIndex < 0) {
		throw new Error(
			`foreach batch ${record.batchId} ownership no longer matches run order`,
		);
	}
	const leaderCompiled = compiledFlow.tasks[leaderIndex];
	const memberCompiled = compiledFlow.tasks[memberIndex];
	if (
		!leaderCompiled ||
		!memberCompiled ||
		!eligibleForeachBatchChild(first, leaderCompiled, run.nativeHost) ||
		!eligibleForeachBatchChild(second, memberCompiled, run.nativeHost)
	) {
		throw new Error(
			`foreach batch ${record.batchId} prepared members are no longer launchable`,
		);
	}
	return { leaderIndex, memberIndex, record };
}

function foreachBatchLogicalCapacityAtLeastTwo(
	compiledTask: CompiledTask,
	maxConcurrency: number,
): boolean {
	if (maxConcurrency < 2) return false;
	if (compiledTask.stageMaxConcurrency === undefined) return true;
	return (
		Math.max(1, Math.min(MAX_CONCURRENCY, compiledTask.stageMaxConcurrency)) >= 2
	);
}

function foreachBatchLogicalSlotsAvailable(
	run: WorkflowRunRecord,
	compiledTask: CompiledTask,
	running: number,
	maxConcurrency: number,
): boolean {
	if (running + 2 > maxConcurrency) return false;
	if (compiledTask.stageMaxConcurrency === undefined) return true;
	const runningInStage = run.tasks.filter(
		(candidate) =>
			candidate.stageId === compiledTask.stageId && candidate.status === "running",
	).length;
	return (
		runningInStage + 2 <=
		Math.max(1, Math.min(MAX_CONCURRENCY, compiledTask.stageMaxConcurrency))
	);
}

function foreachBatchId(
	leader: WorkflowTaskRunRecord,
	member: WorkflowTaskRunRecord,
): string {
	const generation = leader.sourceGeneration ?? leader.generation ?? 0;
	return `foreach-batch-${leader.taskId}-${member.taskId}-g${generation}`;
}

function sameForeachBatchRecordGrouping(
	record: WorkflowForeachBatchRecord,
	compiled: CompiledTask,
): boolean {
	const grouping = compiled.foreachGenerated?.batch;
	return Boolean(
		grouping &&
			grouping.enabled === true &&
			record.grouping.enabled === grouping.enabled &&
			record.grouping.groupBy === grouping.groupBy &&
			record.grouping.groupKey === grouping.groupKey,
	);
}

function sameOptionalForeachMetadata(
	record: WorkflowForeachBatchRecord,
	leaderTask: WorkflowTaskRunRecord,
	memberTask: WorkflowTaskRunRecord,
	leaderCompiled: CompiledTask,
	memberCompiled: CompiledTask,
): boolean {
	return (
		record.placeholderSpecId ===
			leaderCompiled.foreachGenerated?.placeholderSpecId &&
		record.placeholderSpecId ===
			memberCompiled.foreachGenerated?.placeholderSpecId &&
		record.placeholderSpecId === leaderTask.foreachGenerated?.placeholderSpecId &&
		record.placeholderSpecId === memberTask.foreachGenerated?.placeholderSpecId &&
		record.stageId === leaderTask.stageId &&
		record.stageId === memberTask.stageId &&
		record.stageId === leaderCompiled.stageId &&
		record.stageId === memberCompiled.stageId &&
		record.generation === leaderTask.generation &&
		record.generation === memberTask.generation &&
		record.generation === leaderCompiled.generation &&
		record.generation === memberCompiled.generation &&
		record.sourceGeneration === leaderTask.sourceGeneration &&
		record.sourceGeneration === memberTask.sourceGeneration &&
		record.sourceGeneration === leaderCompiled.sourceGeneration &&
		record.sourceGeneration === memberCompiled.sourceGeneration &&
		sameForeachBatchRecordGrouping(record, leaderCompiled) &&
		sameForeachBatchRecordGrouping(record, memberCompiled) &&
		record.grouping.groupBy === leaderTask.foreachGenerated?.batch?.groupBy &&
		record.grouping.groupKey === leaderTask.foreachGenerated?.batch?.groupKey &&
		record.grouping.groupBy === memberTask.foreachGenerated?.batch?.groupBy &&
		record.grouping.groupKey === memberTask.foreachGenerated?.batch?.groupKey
	);
}

async function revalidatePreparedForeachBatch(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	record: WorkflowForeachBatchRecord,
	leaderIndex: number,
	memberIndex: number,
	validationSnapshot: ArtifactGraphRuntimeValidationSnapshot,
): Promise<CompiledTask> {
	const leaderTask = run.tasks[leaderIndex];
	const memberTask = run.tasks[memberIndex];
	const leaderCompiled = compiledFlow.tasks[leaderIndex];
	const memberCompiled = compiledFlow.tasks[memberIndex];
	if (!leaderTask || !memberTask || !leaderCompiled || !memberCompiled)
		throw new Error(
			`foreach batch ${record.batchId} prepared members are missing`,
		);
	if (
		!sameOptionalForeachMetadata(
			record,
			leaderTask,
			memberTask,
			leaderCompiled,
			memberCompiled,
		)
	)
		throw new Error(
			`foreach batch ${record.batchId} prepared generation/grouping metadata drifted`,
		);
	const [preparedLeader, preparedMember] = await Promise.all([
		prepareDagTask(cwd, run, compiledFlow, leaderIndex, validationSnapshot),
		prepareDagTask(cwd, run, compiledFlow, memberIndex, validationSnapshot),
	]);
	const leaderSurface = foreachBatchExecutionSurfaceSha256(preparedLeader);
	const memberSurface = foreachBatchExecutionSurfaceSha256(preparedMember);
	if (
		leaderSurface !== record.executionSurfaceSha256 ||
		memberSurface !== record.executionSurfaceSha256 ||
		leaderSurface !== memberSurface
	)
		throw new Error(
			`foreach batch ${record.batchId} prepared execution surface drifted`,
		);
	return preparedLeader;
}

function batchMemberForTask(
	record: WorkflowForeachBatchRecord,
	task: WorkflowTaskRunRecord,
) {
	const member = record.members.find(
		(candidate) => candidate.taskId === task.taskId,
	);
	if (!member || member.specId !== task.specId)
		throw new Error(
			`foreach batch ${record.batchId} does not own ${task.taskId}/${task.specId}`,
		);
	if (sha256Text(member.preparedPrompt) !== member.preparedPromptSha256)
		throw new Error(
			`foreach batch ${record.batchId} prepared prompt integrity failed`,
		);
	return member;
}

async function fallbackForeachBatch(
	cwd: string,
	run: WorkflowRunRecord,
	record: WorkflowForeachBatchRecord,
	reason: string,
): Promise<void> {
	setForeachBatchPhase(run, record, "fallback_prepared");
	record.fallback = {
		preparedAt: new Date().toISOString(),
		reason,
	};
	await writeRunRecord(cwd, run);
	applyForeachBatchFallback(run, record, reason);
	await writeRunRecord(cwd, run);
}

async function launchForeachBatchAt(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	plan: ForeachBatchLaunchPlan,
	validationSnapshot: ArtifactGraphRuntimeValidationSnapshot,
	leaseSignal?: AbortSignal,
): Promise<ForeachBatchLaunchOutcome> {
	const leaderTask = run.tasks[plan.leaderIndex];
	const memberTask = run.tasks[plan.memberIndex];
	const leaderCompiled = compiledFlow.tasks[plan.leaderIndex];
	const memberCompiled = compiledFlow.tasks[plan.memberIndex];
	if (!leaderTask || !memberTask || !leaderCompiled || !memberCompiled)
		return "unavailable";

	let record = plan.record;
	let leaderLaunchTask: CompiledTask;
	if (record) {
		const leaderMember = batchMemberForTask(record, leaderTask);
		const memberMember = batchMemberForTask(record, memberTask);
		if (
			leaderMember.role !== "leader" ||
			memberMember.role !== "member" ||
			sha256Text(record.batchPrompt) !== record.batchPromptSha256
		) {
			throw new Error(
				`foreach batch ${record.batchId} durable launch integrity failed`,
			);
		}
		try {
			// A prepared record is a replay boundary. Rebuild both singleton
			// preparation surfaces immediately before launch rather than trusting
			// the currently loaded compiled task or adjacency. Any drift disables
			// the batch before a physical backend launch can occur.
			const preparedLeader = await revalidatePreparedForeachBatch(
				cwd,
				run,
				compiledFlow,
				record,
				plan.leaderIndex,
				plan.memberIndex,
				validationSnapshot,
			);
			leaderLaunchTask = {
				...preparedLeader,
				cwd: leaderTask.cwd,
				foreachBatchSynthetic: { schema: "workflow-foreach-batch-v1" },
				compiledPrompt: record.batchPrompt,
			};
		} catch (error) {
			await fallbackForeachBatch(
				cwd,
				run,
				record,
				`prepared batch drift: ${error instanceof Error ? error.message : String(error)}`,
			);
			return "changed";
		}
	} else {
		let preparedLeader: CompiledTask;
		let preparedMember: CompiledTask;
		try {
			preparedLeader = await prepareDagTask(
				cwd,
				run,
				compiledFlow,
				plan.leaderIndex,
				validationSnapshot,
			);
			preparedMember = await prepareDagTask(
				cwd,
				run,
				compiledFlow,
				plan.memberIndex,
				validationSnapshot,
			);
		} catch {
			// A singleton will surface the same preparation failure through its
			// established task-level error path; do not create partial ownership.
			return "unavailable";
		}
		const grouping = leaderCompiled.foreachGenerated?.batch;
		if (!grouping) return "unavailable";
		const leaderSurface = foreachBatchExecutionSurfaceSha256(preparedLeader);
		const memberSurface = foreachBatchExecutionSurfaceSha256(preparedMember);
		if (leaderSurface !== memberSurface) return "unavailable";
		const batchPrompt = buildForeachBatchPrompt({
			leader: preparedLeader,
			items: [
				{ id: leaderTask.taskId, prompt: preparedLeader.compiledPrompt },
				{ id: memberTask.taskId, prompt: preparedMember.compiledPrompt },
			],
		});
		const batchId = foreachBatchId(leaderTask, memberTask);
		if (
			(run.foreachBatches ?? []).some((candidate) => candidate.batchId === batchId)
		)
			throw new Error(`foreach batch ${batchId} already has a durable record`);
		const preparedAt = new Date().toISOString();
		const stateRootIdentity = await workflowStateRootIdentity(cwd);
		record = {
			version: 1,
			batchId,
			placeholderSpecId: leaderCompiled.foreachGenerated!.placeholderSpecId,
			stageId: leaderTask.stageId,
			...(leaderTask.generation === undefined
				? {}
				: { generation: leaderTask.generation }),
			...(leaderTask.sourceGeneration === undefined
				? {}
				: { sourceGeneration: leaderTask.sourceGeneration }),
			grouping: { ...grouping },
			executionSurfaceSha256: leaderSurface,
			stateRootSha256: stateRootIdentity.identitySha256,
			members: [
				{
					taskId: leaderTask.taskId,
					specId: leaderTask.specId,
					role: "leader",
					preparedPrompt: preparedLeader.compiledPrompt,
					preparedPromptSha256: sha256Text(preparedLeader.compiledPrompt),
				},
				{
					taskId: memberTask.taskId,
					specId: memberTask.specId,
					role: "member",
					preparedPrompt: preparedMember.compiledPrompt,
					preparedPromptSha256: sha256Text(preparedMember.compiledPrompt),
				},
			],
			attempt: 1,
			phase: "prepared",
			preparedAt,
			batchPrompt,
			batchPromptSha256: sha256Text(batchPrompt),
		};
		record.capabilitySubjectSha256 = foreachBatchCapabilitySubjectSha256(record);
		run.foreachBatches ??= [];
		run.foreachBatches.push(record);
		leaderTask.foreachBatch = {
			batchId,
			role: "leader",
			phase: "prepared",
			physicalAttempt: 1,
		};
		memberTask.foreachBatch = {
			batchId,
			role: "member",
			phase: "prepared",
			physicalAttempt: 1,
		};
		await persistFinalPromptMetadata(cwd, run, leaderTask, preparedLeader);
		await persistFinalPromptMetadata(cwd, run, memberTask, preparedMember);
		await writeRunRecord(cwd, run);
		leaderLaunchTask = {
			...preparedLeader,
			foreachBatchSynthetic: { schema: "workflow-foreach-batch-v1" },
			compiledPrompt: batchPrompt,
		};
	}

	if (record.stateRootSha256 || record.capabilitySubjectSha256) {
		const capability = await issueForeachBatchCapability(cwd, record);
		await assertForeachBatchCapability(cwd, record, capability);
	}

	try {
		assertFinalCompiledPromptWithinCap(leaderLaunchTask);
	} catch (error) {
		await fallbackForeachBatch(
			cwd,
			run,
			record,
			`batch prompt preparation failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return "changed";
	}

	setForeachBatchPhase(run, record, "launching");
	memberTask.status = "running";
	memberTask.statusDetail = "batch_launching";
	memberTask.startedAt = new Date().toISOString();
	memberTask.lastMessage = `awaiting foreach batch leader ${leaderTask.taskId}`;
	await writeRunRecord(cwd, run);

	const backend = resolveWorkflowBackend(run);
	const stop = createWorkflowStopSignal(cwd, run.runId);
	try {
		await throwIfWorkflowStopRequested(cwd, run.runId);
		const preparedLaunch = await backend.prepareTaskLaunch(
			cwd,
			run,
			leaderTask,
			leaderLaunchTask,
		);
		const provenance = await createLaunchBootstrapProvenance(
			cwd,
			run,
			leaderTask,
			leaderLaunchTask,
			backend.id,
			preparedLaunch,
		);
		recordLaunchBootstrapProvenance(leaderTask, provenance);
		const authority = createWorkflowLaunchAuthority(
			run,
			leaderTask,
			backend.id,
			provenance,
		);
		issueWorkflowLaunchAuthority(leaderTask, authority);
		await writeRunRecord(cwd, run);
		const launch = await backend.launchTask(
			cwd,
			run,
			leaderTask,
			leaderLaunchTask,
			leaseSignal,
			stop.signal,
			{ ...preparedLaunch, authority },
		);
		if (launch.kind === "fatal") {
			await fallbackForeachBatch(
				cwd,
				run,
				record,
				`batch launch failed: ${launch.message}`,
			);
			return "changed";
		}
		if (launch.kind === "capacity" && leaderTask.status !== "running") {
			setForeachBatchPhase(run, record, "prepared");
			memberTask.status = "pending";
			memberTask.statusDetail = "pending";
			memberTask.startedAt = undefined;
			memberTask.lastMessage = launch.message;
			await writeRunRecord(cwd, run);
			return "deferred";
		}
		if (leaderTask.status === "running") {
			setForeachBatchPhase(
				run,
				record,
				launch.kind === "launched" ? "running" : "launching",
			);
			memberTask.status = "running";
			memberTask.statusDetail =
				launch.kind === "launched" ? "batch_running" : "batch_launching";
			memberTask.startedAt ??= leaderTask.startedAt ?? new Date().toISOString();
			memberTask.backendHandle = undefined;
			memberTask.backendFiles = undefined;
			memberTask.backendTaskId = memberTask.taskId;
			memberTask.lastMessage = `owned by foreach batch leader ${leaderTask.taskId}`;
			await writeRunRecord(cwd, run);
			return "launched";
		}
		await fallbackForeachBatch(
			cwd,
			run,
			record,
			"batch launch did not retain a leader claim",
		);
		return "changed";
	} catch (error) {
		if (leaseSignal?.aborted) throw error;
		if (isWorkflowStopRequestedError(error)) {
			const tasks = markForeachBatchStopped(run, record);
			for (const task of tasks) {
				setTaskTerminal(task, "interrupted", "workflow_stopped", {
					exitCode: 130,
					lastMessage: "Workflow stopped by user request",
				});
			}
			await writeRunRecord(cwd, run).catch(() => undefined);
			return "changed";
		}
		await fallbackForeachBatch(
			cwd,
			run,
			record,
			`batch launch failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return "changed";
	} finally {
		stop.dispose();
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
		if (
			await finalizeStopIntentIfRequested(cwd, run)
		)
			return false;
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

	if (await finalizeStopIntentIfRequested(cwd, run))
		return false;

	const changed = markDagDependentsSkipped(run, compiledFlow);
	if (changed) {
		await writeRunRecord(cwd, run);
		run = await readRunRecord(cwd, run.runId);
	}
	if (
		await applyFailFastCancellation(
			cwd,
			run,
			compiledFlow,
		)
	)
		return true;

	const maxConcurrency = Math.max(
		1,
		Math.min(MAX_CONCURRENCY, compiledFlow.maxConcurrency),
	);
	let running = run.tasks.filter((task) => task.status === "running").length;
	const bySpecId = new Map(run.tasks.map((task) => [task.specId, task]));
	const dispatchMapValidationSnapshot =
		createArtifactGraphRuntimeValidationSnapshot(run);
	dynamicControllerTestHooks.onSchedulerObservation?.(Object.freeze({
		cwd, runId: run.runId, phase: "dag-eligibility",
		admissionPresent: options.goalChildAdmission !== undefined,
		leaseActive: leaseSignal !== undefined && !leaseSignal.aborted, running, maxConcurrency,
		tasks: Object.freeze(compiledFlow.tasks.map(task => Object.freeze({
			specId: task.id, kind: task.kind, status: bySpecId.get(task.id)?.status,
			dependsOn: Object.freeze([...(task.dependsOn ?? [])]),
			dependencyStatuses: Object.freeze((task.dependsOn ?? []).map(id => bySpecId.get(id)?.status)),
			ready: dependenciesReady(task, bySpecId, compiledFlow, bySpecId.get(task.id)),
		}))),
	}));

	for (
		let index = 0;
		index < run.tasks.length && running < maxConcurrency;
		index += 1
	) {
		assertScheduleLeaseActive(leaseSignal);
		if (await finalizeStopIntentIfRequested(cwd, run))
			return false;
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
			if (await finalizeStopIntentIfRequested(cwd, run))
				return false;
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
				options.goalChildAdmission,
				leaseSignal,
			);
			if (await finalizeStopIntentIfRequested(cwd, run))
				return false;
			if (changed) return true;
			if (foreachStreamingEnabled(compiledTask)) continue;
		}

		const activeBatch = activeForeachBatchRecordForTask(run, task);
		if (
			activeBatch &&
			(task.foreachBatch?.role !== "leader" || activeBatch.phase !== "prepared")
		)
			continue;
		const batchPlan =
			preparedForeachBatchLaunchPlan(run, compiledFlow, index) ??
			newForeachBatchLaunchPlan(run, compiledFlow, index, bySpecId);
		if (batchPlan) {
			const batchMember = run.tasks[batchPlan.memberIndex];
			const batchMemberCompiled = compiledFlow.tasks[batchPlan.memberIndex];
			if (
				!batchMember ||
				!batchMemberCompiled ||
				!dependenciesReady(batchMemberCompiled, bySpecId, compiledFlow, batchMember)
			)
				continue;
			if (
				!foreachBatchLogicalSlotsAvailable(
					run,
					compiledTask,
					running,
					maxConcurrency,
				)
			) {
				if (foreachBatchLogicalCapacityAtLeastTwo(compiledTask, maxConcurrency))
					return false;
			} else {
				const batchOutcome = await launchForeachBatchAt(
					cwd,
					run,
					compiledFlow,
					batchPlan,
					dispatchMapValidationSnapshot,
					leaseSignal,
				);
				if (batchOutcome === "deferred") return false;
				if (batchOutcome === "changed") return true;
				if (batchOutcome === "launched") {
					running += 2;
					continue;
				}
			}
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
		if (await finalizeStopIntentIfRequested(cwd, run))
			return false;
		if (
			await applyFailFastCancellation(
				cwd,
				run,
				compiledFlow,
			)
		)
			return true;
		if (await finalizeStopIntentIfRequested(cwd, run))
			return false;
		if (launched && run.tasks[index]?.status === "running") running += 1;
	}
	return false;
}

function recoverStaleRunningDynamicControllers(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
): boolean {
	assertRunTaskPositionalAlignment(run, compiledFlow);
	let changed = false;
	for (const [index, task] of run.tasks.entries()) {
		const compiledTask = compiledFlow.tasks[index];
		if (task.status !== "running")
			continue;
		if (compiledTask?.kind !== "dynamic") continue;
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

async function applyFailFastCancellation(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
): Promise<boolean> {
	assertNotProtectedGoalEngineRun(run);
	const summary = markFailFastCancellations(run, compiledFlow);
	if (summary.cancelledTaskIds.length === 0) return false;
	await writeRunRecord(cwd, run);
	const cancellationErrors: unknown[] = [];
	const physicalCancellationTaskIds = new Set<string>();
	for (const taskId of summary.interruptedTaskIds) {
		const task = run.tasks.find((candidate) => candidate.taskId === taskId);
		if (!task) continue;
		const batch = activeForeachBatchRecordForTask(run, task);
		if (batch) {
			const leader = foreachBatchTasks(run, batch).find(
				(candidate) => candidate.foreachBatch?.role === "leader",
			);
			if (!leader)
				throw new Error(
					`foreach batch ${batch.batchId} has no leader for cancellation`,
				);
			physicalCancellationTaskIds.add(leader.taskId);
		} else {
			physicalCancellationTaskIds.add(task.taskId);
		}
	}
	await Promise.all(
		[...physicalCancellationTaskIds].map(async (taskId) => {
			const task = run.tasks.find((candidate) => candidate.taskId === taskId);
			if (!task) return undefined;
			const batch = activeForeachBatchRecordForTask(run, task);
			try {
				await acknowledgeSubagentTaskInterrupted(
					cwd,
					run,
					task,
					"workflow fail-fast cancellation",
				);
				if (batch) {
					for (const member of markForeachBatchStopped(run, batch)) {
						setTaskTerminal(
							member,
							"interrupted",
							FAIL_FAST_CANCELLED_STATUS_DETAIL,
							{
								exitCode: 130,
								lastMessage: "cancelled by workflow fail-fast policy",
							},
						);
					}
				} else {
					setTaskTerminal(task, "interrupted", FAIL_FAST_CANCELLED_STATUS_DETAIL, {
						exitCode: 130,
						lastMessage: "cancelled by workflow fail-fast policy",
					});
				}
			} catch (error) {
				const message = `fail-fast cancellation failed; backend handle preserved: ${error instanceof Error ? error.message : String(error)}`;
				for (const member of batch ? foreachBatchTasks(run, batch) : [task]) {
					member.statusDetail = "cancellation_failed";
					member.lastMessage = message;
				}
				cancellationErrors.push(error);
			}
			return undefined;
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
			(candidate): candidate is WorkflowTaskRunRecord => candidate !== undefined,
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
	for (const nestedRunId of controllerState?.waitingNestedWorkflowRunIds ?? []) {
		let nestedRun = await readRunRecord(cwd, nestedRunId).catch(() => undefined);
		// Reconcile a nested backend before deciding that a suspended controller
		// is still waiting; the child backend may complete without updating this
		// parent run record.
		if (nestedRun && !isTerminalWorkflowStatus(nestedRun.status)) {
			try {
				nestedRun = await refreshRun(cwd, nestedRunId);
			} catch (error) {
				if (!isRefreshPollAggregateError(error)) throw error;
			}
		}
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
		(!Number.isSafeInteger(sourceTask.generation) || sourceTask.generation < 0)
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
		compiled?.perItemDispatch === persisted?.perItemDispatch &&
		compiled?.batch?.enabled === persisted?.batch?.enabled &&
		compiled?.batch?.groupBy === persisted?.batch?.groupBy &&
		compiled?.batch?.groupKey === persisted?.batch?.groupKey
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
			!sameForeachJournalOwnershipTuple(task, runTask, journal.placeholderSpecId)
		) {
			throw new Error(
				`Cannot recover foreach materialization for ${run.runId}: journal task mapping is invalid`,
			);
		}
		const existingRun = run.tasks.find(
			(candidate) => candidate.specId === task.id,
		);
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

	const expectedSpecIds = new Set(journal.generatedTasks.map((task) => task.id));
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
	const expectedSpecIds = new Set(journal.generatedTasks.map((task) => task.id));
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
			compiledFlow.tasks.splice(placeholderIndex, 1, ...journal.generatedTasks);
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
		updateDownstreamDependencies(compiledFlow, journal.placeholderSpecId, [
			...expectedSpecIds,
		]);
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
			run.tasks.splice(runPlaceholderIndex, 1, ...journal.generatedRunTasks);
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
			run.tasks.splice(runPlaceholderIndex + 1, 0, ...journal.generatedRunTasks);
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
			task.specId === journal.placeholderSpecId && task.dispatchMap !== undefined,
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
	if (run.goalChild) throw new Error("Goal child foreach materialization UNKNOWN; disk replay is denied");
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
	if (run.goalChild) throw new Error("Goal child foreach materialization UNKNOWN; disk replay is denied");
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
	observe?: (boundary: string) => void,
	assertCurrent?: () => Promise<void>,
	expectedPublication?: { run: WorkflowRunRecord; compiled: CompiledWorkflow },
	leaseSignal?: AbortSignal,
): Promise<void> {
	const publicationAwait = async (effect: () => Promise<unknown>) => {
		await assertCurrent?.();
		await effect();
		await assertCurrent?.();
	};
	(
		run as WorkflowRunWithForeachMaterializationJournal
	).foreachMaterializationJournal = journal;
	observe?.("journal-write-before");
	await publicationAwait(() => writeRunRecord(cwd, run, leaseSignal));
	observe?.("journal-write-after");
	await publicationAwait(async () => foreachMaterializationPersistenceHookForTests?.("prepared-run-written"));
	if (expectedPublication) {
		Object.assign(run, structuredClone(expectedPublication.run));
		Object.assign(compiledFlow, structuredClone(expectedPublication.compiled));
	} else applyForeachMaterializationJournal(run, compiledFlow, journal);
	observe?.("compiled-write-before");
	await publicationAwait(() => writeJsonAtomic(compiledWorkflowPath(cwd, run.runId), compiledFlow, leaseSignal));
	observe?.("compiled-write-after");
	await publicationAwait(async () => foreachMaterializationPersistenceHookForTests?.("compiled-written"));
	delete (run as WorkflowRunWithForeachMaterializationJournal)
		.foreachMaterializationJournal;
	observe?.("run-write-before");
	await publicationAwait(() => writeRunRecord(cwd, run, leaseSignal));
	observe?.("run-write-after");
	await publicationAwait(async () => foreachMaterializationPersistenceHookForTests?.("run-written"));
}
async function materializeForeachTask(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	index: number,
	template: CompiledTask,
	validationSnapshot: ArtifactGraphRuntimeValidationSnapshot,
	goalChildAdmission?: PreparedWorkflowGoalChildAdmission,
	leaseSignal?: AbortSignal,
): Promise<boolean> {
	try {
		return await materializeForeachTaskUnderLease(cwd, run, compiledFlow, index, template,
			validationSnapshot, goalChildAdmission, leaseSignal);
	} catch (error) {
		if (!goalChildAdmission) throw error;
		failWorkflowGoalChildForeachAdmission(goalChildAdmission);
		throw error;
	}
}

async function materializeForeachTaskUnderLease(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	index: number,
	template: CompiledTask,
	validationSnapshot: ArtifactGraphRuntimeValidationSnapshot,
	goalChildAdmission?: PreparedWorkflowGoalChildAdmission,
	leaseSignal?: AbortSignal,
): Promise<boolean> {
	const templateRunTask = run.tasks[index];
	const observe = (boundary: string, error?: unknown) => dynamicControllerTestHooks.onSchedulerObservation?.(Object.freeze({
		cwd, runId: run.runId, phase: "foreach-materialization", boundary,
		admissionPresent: goalChildAdmission !== undefined,
		leaseActive: leaseSignal !== undefined && !leaseSignal.aborted,
		error: error === undefined ? undefined : error instanceof Error ? error.message : String(error),
	}));
	dynamicControllerTestHooks.onSchedulerObservation?.(Object.freeze({
		cwd, runId: run.runId, phase: "foreach-materialization",
		admissionPresent: goalChildAdmission !== undefined,
		leaseActive: leaseSignal !== undefined && !leaseSignal.aborted,
	}));
	if (!templateRunTask || !template.foreach || !template.stageId) return false;

	const sourceStageIds = sourceStageIdsForFrom(template.foreach.from);
	const sourceTasks = run.tasks.filter((task) =>
		sourceStageIds.includes(task.stageId ?? ""),
	);
	const missingSourceStageIds = sourceStageIds.filter(
		(stageId) => !sourceTasks.some((task) => task.stageId === stageId),
	);
	if (sourceStageIds.length === 0 || missingSourceStageIds.length > 0) {
		setTaskTerminal(templateRunTask, "blocked", "foreach_expansion_blocked", {
			lastMessage: `foreach source is missing from the authoritative run task record: ${missingSourceStageIds.join(", ") || "no source stage declared"}`,
		});
		await writeRunRecord(cwd, run);
		return true;
	}
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
	observe("extract-before");
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
	observe("extract-after");

	if (extracted.error) {
		setTaskTerminal(templateRunTask, "blocked", "foreach_expansion_blocked", {
			lastMessage: extracted.error,
		});
		await writeRunRecord(cwd, run);
		return true;
	}

	const items = extracted.items ?? [];
	const itemMetas = extracted.itemMetas ?? [];
	const sourceTaskBySpecId = new Map(
		sourceTasks.map((task) => [task.specId, task]),
	);
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
								(task) => task.foreachGenerated?.placeholderSpecId !== template.id,
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
			? generatedTasksWithItemMetadata(generated.tasks, extracted.itemMetas ?? [])
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
	const createJournal = (): ForeachMaterializationJournal => ({
		status: "prepared",
		placeholderSpecId,
		replacePlaceholder: !dispatchContext && generatedTasks.length > 0,
		generatedTasks,
		generatedRunTasks,
	});
	let journal: ForeachMaterializationJournal | undefined;
	if (run.goalChild && !goalChildAdmission)
		throw new Error("Goal child foreach requires original live admission");
	if (goalChildAdmission) await assertRunLeaseOwnership(cwd, run.runId, leaseSignal);
	observe("prepare-transition-before");
	let expectedPublication: { run: WorkflowRunRecord; compiled: CompiledWorkflow } | undefined;
	const transition = goalChildAdmission
		? await prepareWorkflowGoalChildForeach(goalChildAdmission, run, compiledFlow,
			template, generatedTasks, generatedRunTasks, items, (originalRun, originalCompiled) => {
				journal = createJournal();
				applyForeachMaterializationJournal(originalRun, originalCompiled, structuredClone(journal));
				expectedPublication = { run: originalRun, compiled: originalCompiled };
			}).catch(error => {
			dynamicControllerTestHooks.onSchedulerObservation?.(Object.freeze({
				cwd, runId: run.runId, phase: "foreach-materialization", boundary: "prepare-transition-error",
				admissionPresent: true, leaseActive: leaseSignal !== undefined && !leaseSignal.aborted,
				error: error instanceof Error ? error.message : String(error),
			}));
			throw error;
		})
		: undefined;
	journal ??= createJournal();
	observe("prepare-transition-after");
	const assertCurrent = transition ? async () => {
		await assertRunLeaseOwnership(cwd, run.runId, leaseSignal);
		await assertWorkflowGoalChildForeachCurrent(transition);
		await assertRunLeaseOwnership(cwd, run.runId, leaseSignal);
	} : undefined;
	try {
		await assertCurrent?.();
		await persistForeachMaterialization(cwd, run, compiledFlow, journal, observe, assertCurrent, expectedPublication, leaseSignal);
		if (transition) {
			await assertCurrent!();
			const persisted = await readRunRecord(cwd, run.runId);
			await assertWorkflowGoalChildForeachCurrent(transition, persisted);
			await assertCurrent!();
			const persistedCompiled = await readCompiledWorkflow(cwd, run.runId);
			await assertWorkflowGoalChildForeachCurrent(transition, persisted, persistedCompiled ?? undefined);
			await assertCurrent!();
			if (!persistedCompiled || workflowDefinitionFingerprint(persistedCompiled) !== workflowDefinitionFingerprint(compiledFlow))
				throw new Error("Goal child foreach materialization UNKNOWN; original compiled publication differs");
			observe("commit-transition-before");
			await publishWorkflowGoalChildForeach(transition, persisted, persistedCompiled);
			observe("commit-transition-after");
		}
	} catch (error) {
		observe("transition-error", error);
		if (transition) failWorkflowGoalChildForeach(transition);
		throw error;
	}
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
		left?.perItemDispatch === right?.perItemDispatch &&
		left?.batch?.enabled === right?.batch?.enabled &&
		left?.batch?.groupBy === right?.batch?.groupBy &&
		left?.batch?.groupKey === right?.batch?.groupKey
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
	const beforeCompiledDigest = input.run.goal === undefined
		? undefined : goalCompiledMaterializationDigest(input.compiledFlow);
	const sourceTaskSpecIdSet = new Set(input.sourceTaskSpecIds);
	const perItemDispatch = workflowExperimentalFlagEnabled(PER_ITEM_DISPATCH_ENV);
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
						contextDependsOn: [...new Set([...dependsOn, itemMeta.sourceSpecId])],
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
	const existingGeneratedSpecIds = existingGeneratedTasks.map((task) => task.id);
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
			existingGeneratedTaskBySpecId.get(task.id) ?? exactPartialMatches.get(task);
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
		input.compiledFlow.tasks.splice(compiledInsertIndex, 0, ...newGeneratedTasks);

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
	if (synchronizeTerminalBarrierSourceSpecIds(input.run, input.compiledFlow)) {
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
	await persistGoalGeneratedMaterialization(
		input.cwd,
		input.run,
		input.compiledFlow,
		beforeCompiledDigest,
	);
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
					partialLedgerPathsBySourceSpecId.set(task.specId, partial.ledgerPaths);
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
	if (
		launchTask.artifactGraph?.inputPolicy?.maxCompiledPromptChars === undefined
	)
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
	retireWorkflowGoalUnlaunched(run, task);
	// A root candidate requiring artifact repair is UNKNOWN, not an original
	// deterministic oracle failure. Ordinary output repair must not spend another
	// provider attempt outside the admitted generation transition.
	if (task.outputRetry && run.tasks.some(root => root.kind === "goal" &&
		root.goalRoot?.generations.some(generation => generation.plannerSpecId === task.specId ||
			Object.values(generation.slots).includes(task.specId) || Object.values(generation.verifiers ?? {}).includes(task.specId)))) {
		setTaskTerminal(task, "blocked", "goal_candidate_artifact_unknown", {
			lastMessage: "Goal candidate terminal artifact is unavailable or invalid; UNKNOWN requires recovery, not automatic provider repair.",
		});
		await writeRunRecord(cwd, run);
		return false;
	}

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
	let launchStopSignal: AbortSignal | undefined;
	const parentStopSignal = options.goalChildAdmission
		? workflowGoalChildStopSignal(options.goalChildAdmission) : undefined;
	try {
		launchTask = await prepareDagTask(
			cwd,
			run,
			compiledFlow,
			index,
			validationSnapshot,
		);
		await throwIfWorkflowStopRequested(cwd, run.runId);
		if (run.nativeHost !== undefined && compiledTask.runtime.nativeToolsEnabled === undefined &&
			launchTask.safety.permission.status === "blocked") {
			setTaskTerminal(task, "blocked", launchTask.safety.permission.statusDetail ?? "needs_attention", {
				lastMessage: launchTask.safety.permission.reason,
			});
			await writeRunRecord(cwd, run);
			return false;
		}
		if (task.outputRetry) {
			launchTask = await prepareArtifactGraphRetryTask(cwd, task, launchTask);
			await throwIfWorkflowStopRequested(cwd, run.runId);
		}
		assertFinalCompiledPromptWithinCap(launchTask);
		prepareComplete = true;
		await throwIfWorkflowStopRequested(cwd, run.runId);
		// Records from the removed protected Goal engine never reach support,
		// dynamic, or backend execution.
		assertNoProtectedGoalEngineArtifacts(run, compiledFlow);
		if (launchTask.kind === "goal") {
			if (!options.goalPolicyHost) {
				setTaskTerminal(task, "blocked", "goal_host_unavailable", { lastMessage: "A confirmed current Goal host is required; a policy node is not a provider task." });
				await writeRunRecord(cwd, run);
				return false;
			}
			task.status = "running";
			task.statusDetail = "goal_policy_running";
			task.startedAt ??= new Date().toISOString();
			await writeRunRecord(cwd, run);
			const stop = createWorkflowStopSignal(cwd, run.runId);
			launchStopSignal = stop.signal;
			let result: Awaited<ReturnType<typeof executeWorkflowEngineGoalPolicy>> | null;
			let originApply: WorkflowGoalOriginApplyRecord | undefined;
			try {
			const policyInput = {
				host: options.goalPolicyHost,
				cwd,
				policy: launchTask,
				existingGoal: task.goal,
				stopSignal: leaseSignal ? AbortSignal.any([stop.signal, leaseSignal]) : stop.signal,
				request: goalPolicyRequest(launchTask, compiledFlow.task),
				preparedAdmission: options.goalPolicyAdmissions?.get(launchTask.id),
				ancestryRootRunId: run.rootRunId ?? run.runId,
				parentRunId: run.runId,
				executionProfileName: run.executionProfile?.name,
				assertCurrent: () => throwIfWorkflowStopRequested(cwd, run.runId),
				registered: async (goalId: string, contractHash: string) => {
					task.goal = { goalId, contractHash, state: "admitted", usage: { requests: null, costMicros: null } };
					await writeRunRecord(cwd, run);
				},
			};
			if (options.goalPolicyHost.executionFoundation === "workflow-engine") {
				const originalCurrent = policyInput.assertCurrent;
				policyInput.assertCurrent = async () => {
					await originalCurrent();
					policyInput.stopSignal.throwIfAborted();
					if (!policyInput.preparedAdmission) throw new Error("Goal engine original admission unavailable");
					assertPreparedWorkflowGoalPolicyCurrent(policyInput, policyInput.preparedAdmission);
				};
				const plannerId = `${launchTask.stageId ?? launchTask.id}.$rootPlanner`;
				const initialPlanner = run.tasks.find(candidate => candidate.stageId === plannerId);
				if (initialPlanner && !task.goalRoot) {
					task.goalRoot = { definitionFingerprint: launchTask.goal!.definitionFingerprint,
						generations: [{ generation: 0, plannerSpecId: initialPlanner.specId,
							workerControllerSpecId: task.specId, slots: {} }] };
					await persistGoalGeneratedMaterialization(cwd, run, compiledFlow, undefined);
				}
				const lineage = task.goalRoot;
				if (lineage && lineage.definitionFingerprint !== launchTask.goal!.definitionFingerprint)
					throw new Error("Root generation immutable definition changed");
				const generation = lineage?.generations.at(-1);
				const childSources: Array<{ taskId: string; control: unknown; identity: unknown }> = [];
				const terminalChildren = new Map<string, () => Promise<number | null>>();
				const planner = generation && run.tasks.find(candidate => candidate.specId === generation.plannerSpecId);
				if (planner) {
					if (planner.status !== "completed") throw new Error("Root planner has no terminal artifact");
					const prepared = policyInput.preparedAdmission;
					if (!prepared) throw new Error("Root workers require fresh admission; recovery cannot replay");
					const control = await readArtifactGraphControl(cwd, planner);
					await policyInput.assertCurrent();
					const planFingerprint = workflowDefinitionFingerprint(control);
					if (generation!.planFingerprint && generation!.planFingerprint !== planFingerprint)
						throw new Error("Root original generation planner control changed");
					if (lineage!.generations.slice(0, -1).some(previous => previous.planFingerprint === planFingerprint))
						throw new Error("Root replan exhausted: unchanged prior plan");
					// A completed, immutable planner artifact with the exact plan
					// envelope but a wrong definition digest is a known producer
					// failure, not authority to repair its claim. Materialize one
					// normal, newly authorized planner attempt; malformed envelopes
					// and every other control failure remain rejected below.
					const malformedPlan = control && typeof control === "object" && !Array.isArray(control) &&
						Object.keys(control).every(key => ["schema", "digest", "proposedTasks"].includes(key)) &&
						(control as Record<string, unknown>).schema === "goal-root-plan-v1" &&
						typeof (control as Record<string, unknown>).digest === "string" &&
						Array.isArray((control as Record<string, unknown>).proposedTasks) &&
						(control as Record<string, unknown>).digest !== launchTask.goal!.definitionFingerprint;
					if (malformedPlan) {
						assertWorkflowGoalRejectedPlannerProposalProgress(policyInput, prepared, control);
						generation!.planFingerprint = planFingerprint;
						generation!.outcome = "not-achieved";
						await recordWorkflowGoalRejectedPlannerGeneration(policyInput, prepared, run, control);
						await policyInput.assertCurrent();
						const next = generation!.generation + 1;
						const correction = prepareWorkflowEngineGoalReplanner(policyInput, prepared, [{
							kind: "planner",
							taskId: planner.specId,
							control,
							definition: launchTask.goal!.definition,
							identity: { runId: run.runId, taskId: planner.taskId, specId: planner.specId,
								generation: generation!.generation },
						}], generation!.generation);
						await policyInput.assertCurrent();
						const ids: string[] = [];
						try {
							await runDynamicAgentRequest({ cwd, run, compiledFlow,
								controllerIndex: compiledFlow.tasks.findIndex(candidate => candidate.id === compiledTask.id),
								controllerTask: { ...task, specId: `${task.specId}.$generation${next}.planner` },
								controllerCompiledTask: compiledTask, dynamic: correction.dynamic,
								request: { id: `$generation${next}.planner`, profile: "planner", prompt: correction.prompt,
									readOnly: true, inputs: [], requiredReads: [], compact: false },
								generatedTaskIds: ids, availableModels: [...options.goalPolicyHost.availableModels], artifactAccess: "none",
								onFreshGeneratedTask: async replacement => captureWorkflowGoalScopedTaskRuntime(
									policyInput, prepared, replacement, next, "planning"),
								agentDefinitions: workflowEngineGoalAgentDefinitions(policyInput, prepared),
								assertCurrent: policyInput.assertCurrent,
								onGeneratedTask: async (replacement, compiledReplacement) => {
									bindWorkflowGoalRequestTask(policyInput, prepared, run, task, replacement, compiledReplacement, next, "planning");
									lineage!.generations.push({ generation: next, plannerSpecId: replacement.specId,
										workerControllerSpecId: `${task.specId}.$generation${next}.workers`, slots: {} });
									compiledTask.dependsOn = [replacement.specId];
									compiledTask.contextDependsOn = [replacement.specId];
									task.dependsOn = [replacement.specId];
									task.status = "pending"; task.statusDetail = "goal_replan_materialized";
									task.lastMessage = "Original immutable planner digest was rejected; captured correction planner receives the failed control.";
								} });
						} catch (error) { if (!(error instanceof DynamicControllerSuspended)) throw error; }
						await policyInput.assertCurrent();
						return true;
					}
					if (await hasActiveWorkflowGoalChild(policyInput, prepared, run)) {
						dynamicControllerTestHooks.onSchedulerObservation?.(Object.freeze({
							cwd, runId: run.runId, phase: "goal-child-wait",
							admissionPresent: true, leaseActive: !leaseSignal?.aborted,
						}));
						task.status = "running";
						task.statusDetail = "goal_catalog_child_waiting";
						task.lastMessage = "Waiting for original admitted Goal child; no parent continuation effects.";
						await policyInput.assertCurrent();
						await writeRunRecord(cwd, run);
						return false;
					}
					const phase = prepareWorkflowEngineGoalWorkers(policyInput, prepared, control);
					generation!.planFingerprint = planFingerprint;
					const admittedChildren = new Map<string, PreparedWorkflowGoalChildAdmission>();
					if (phase.children.length > 0) {
						// Nested depth readers require the original launching controller's
						// budget before workflow.started, including Goal-owned controllers.
						await ensureDynamicControllerInitialized(cwd, run.runId, {
							controllerSpecId: generation!.workerControllerSpecId,
							controllerTaskId: task.taskId, stageId: task.stageId,
							dynamic: phase.dynamic,
							contentFingerprint: workflowDefinitionFingerprint({
								definition: launchTask.goal!.definitionFingerprint, planFingerprint,
							}),
						});
						await policyInput.assertCurrent();
					}
					for (const proposal of phase.children) {
						let childAdmission: PreparedWorkflowGoalChildAdmission | undefined;
						try {
							await runDynamicNestedWorkflowCall({ runWorkflowSpec, refreshRun,
								isResumableDynamicApprovalBlockedRun, cwd, run,
								controllerTask: { ...task, specId: generation!.workerControllerSpecId },
								helperSpecPath: launchTask.goal!.usesPath, dynamic: phase.dynamic,
								workflowId: proposal.workflow, callIndex: 1,
								workflowInput: { task: `${proposal.prompt}\n\n${goalWorkerUserGuidance(
									(phase.dynamic.decisionLoop?.workerDefaults?.tools ?? []).includes("goal_candidate_write"),
									(phase.dynamic.decisionLoop?.workerDefaults?.tools ?? []).includes("goal_candidate_read"),
								)}`, wait: true },
								isSettled: () => stop.signal.aborted,
								prepareGoalNestedWorkflow: async reservation => {
									await policyInput.assertCurrent();
									const previous = generation!.children?.[proposal.id];
									const child = { workflowId: reservation.workflowId, runId: reservation.runId,
										specHash: reservation.specHash, requestHash: reservation.requestHash };
									if (previous && workflowDefinitionFingerprint(previous) !== workflowDefinitionFingerprint(child))
										throw new Error("Goal child generation reserved lineage changed");
									childAdmission = await prepareWorkflowGoalChildAdmission(policyInput, prepared,
										generation!.generation, proposal.id, reservation);
									const admission = childAdmission;
									if (previous) {
										if (generation!.slots[proposal.id] !== reservation.runId)
											throw new Error("Goal child generation reserved slot changed");
									} else {
										generation!.children ??= {};
										generation!.children[proposal.id] = child;
										generation!.slots[proposal.id] = reservation.runId;
										await persistGoalGeneratedMaterialization(cwd, run, compiledFlow, undefined);
										await assertWorkflowGoalChildCurrent(admission);
									}
									return {
										runWorkflowSpec: (path, childCwd, childOptions) => outsideRunLeaseContext(async () => {
											if (path !== reservation.specPath || childCwd !== cwd || childOptions.runId !== reservation.runId ||
												childOptions.parentRunId !== run.runId || childOptions.task !== reservation.task)
												throw new Error("Goal child reserved launch changed");
											const capture = await workflowGoalChildCompilation(admission);
											return runWorkflowSpec(path, childCwd, { ...childOptions, goalChildAdmission: admission,
												goalPolicyHost: options.goalPolicyHost,
												runtimeDefaults: capture.runtimeDefaults, availableModels: capture.availableModels });
										}),
										refreshRun: (childCwd, childId) => outsideRunLeaseContext(async () => {
											if (childCwd !== cwd || childId !== reservation.runId) throw new Error("Goal child reserved refresh changed");
											const recovery = takeWorkflowGoalChildRecovery(admission);
											if (recovery) await resumeRun(childCwd, childId, { goalChildRecovery: recovery });
											return refreshRun(childCwd, childId, admission, () => {
												dynamicControllerTestHooks.onSchedulerObservation?.(Object.freeze({
													cwd: childCwd, runId: childId, phase: "watch-refresh",
													boundary: "root-publication-join", admissionPresent: true,
												}));
											});
										}),
									};
								},
							});
						} catch (error) {
							if (!(error instanceof DynamicControllerSuspended)) {
								const childId = generation!.slots[proposal.id];
								const child = childId ? await outsideRunLeaseContext(() => readRunRecord(cwd, childId)).catch(() => undefined) : undefined;
								if (child?.status === "blocked") {
									const details = child.tasks.filter(value => value.status === "blocked").slice(0, 4)
										.map(value => ({ specId: value.specId, statusDetail: value.statusDetail,
											reason: value.lastMessage?.slice(0, 512) }));
									throw new Error(`Goal child ${childId} blocked: ${JSON.stringify(details).slice(0, 2048)}; ${String(error).slice(0, 512)}`, { cause: error });
								}
								throw error;
							}
							task.status = "running";
							task.statusDetail = "goal_catalog_child_waiting";
							task.lastMessage = error.message;
							await writeRunRecord(cwd, run);
							return false;
						}
						if (!childAdmission) throw new Error("Goal child original admission unavailable after nested result");
						admittedChildren.set(proposal.id, childAdmission);
					}
					if (phase.requests.some(request => !generation!.slots[request.id])) {
					const generatedTaskIds: string[] = [];
					for (const request of phase.requests) {
						const existing = generation!.slots[request.id];
						if (existing) { generatedTaskIds.push(existing); continue; }
						await policyInput.assertCurrent();
						try {
							await runDynamicAgentRequest({ cwd, run, compiledFlow,
								controllerIndex: compiledFlow.tasks.findIndex(candidate => candidate.id === compiledTask.id),
								controllerTask: { ...task, specId: generation!.workerControllerSpecId }, controllerCompiledTask: compiledTask, dynamic: phase.dynamic,
								request: { ...request, id: generation!.generation === 0 ? request.id : `$generation${generation!.generation}.${request.id}` },
								generatedTaskIds, availableModels: [...options.goalPolicyHost.availableModels],
								onFreshGeneratedTask: async worker => captureWorkflowGoalScopedTaskRuntime(
									policyInput, prepared, worker, generation!.generation, "research-execution"),
								agentDefinitions: workflowEngineGoalAgentDefinitions(policyInput, prepared),
								artifactAccess: "none", assertCurrent: policyInput.assertCurrent,
								onGeneratedTask: async (worker, compiledWorker) => {
									bindWorkflowGoalRequestTask(policyInput, prepared, run, task, worker, compiledWorker, generation!.generation, "research-execution");
									bindWorkflowGoalCandidateWorker(policyInput, prepared, run, task, worker, compiledWorker, generation!.generation);
								} });
						} catch (error) {
							if (!(error instanceof DynamicControllerSuspended)) throw error;
						}
						generation!.slots[request.id] = generatedTaskIds.at(-1)!;
					}
					compiledTask.dependsOn = generatedTaskIds;
					compiledTask.contextDependsOn = generatedTaskIds;
					task.dependsOn = [...generatedTaskIds];
					task.status = "pending";
					task.statusDetail = "goal_workers_materialized";
					task.lastMessage = "Validated read-only worker phase materialized; immutable oracle awaits terminal artifacts.";
					await persistGoalGeneratedMaterialization(cwd, run, compiledFlow, undefined);
					return true;
					}
					if (admittedChildren.size && phase.requests.length) {
						const dependencies = phase.requests.map(request => generation!.slots[request.id]);
						const workers = dependencies.map(id => run.tasks.find(worker => worker.specId === id));
						if (workers.some(worker => worker && ["pending", "running"].includes(worker.status))) {
							compiledTask.dependsOn = [...dependencies]; compiledTask.contextDependsOn = [...dependencies];
							task.dependsOn = [...dependencies]; task.status = "pending";
							task.statusDetail = "goal_workers_materialized";
							await policyInput.assertCurrent();
							await persistGoalGeneratedMaterialization(cwd, run, compiledFlow, undefined);
							return true;
						}
						if (workers.some(worker => worker?.status !== "completed"))
							throw new Error("Goal mixed oracle requires original terminal local workers");
					}
					for (const [slot, admission] of admittedChildren) {
						const childId = generation!.slots[slot];
						const readTerminalChild = async () => {
							await policyInput.assertCurrent();
							await assertWorkflowGoalChildCurrent(admission);
							const childRun = await readRunRecord(cwd, childId);
							await assertWorkflowGoalChildCurrent(admission, childRun);
							const childCompiled = await readCompiledWorkflow(cwd, childId);
							if (!childCompiled || childRun.status !== "completed" || childRun.tasks.length !== childCompiled.tasks.length ||
								new Set(childRun.tasks.map(task => task.specId)).size !== childCompiled.tasks.length)
								throw new Error("Goal child original terminal artifact unavailable");
							await assertWorkflowGoalChildCurrent(admission, childRun, childCompiled);
							const settledRequests = await settledWorkflowGoalChildRequests(admission, childRun, childCompiled);
							await assertWorkflowGoalChildCurrent(admission, childRun, childCompiled);
							await policyInput.assertCurrent();
							return { childRun, childCompiled, settledRequests };
						};
						terminalChildren.set(slot, async () => (await readTerminalChild()).settledRequests);
						const { childRun, childCompiled, settledRequests } = await readTerminalChild();
						const output = workflowGoalChildOutputTask(childCompiled);
						const producer = childRun.tasks.find(task => task.specId === output.id);
						if (!producer || producer.status !== "completed")
							throw new Error("Goal child original terminal sink unavailable");
						const candidateSource = output.runtime.tools?.includes("goal_candidate_write") === true;
						const childControl = settledRequests === null ? undefined : candidateSource
							? await observeWorkflowGoalCandidate(policyInput, policyInput.preparedAdmission!, childRun, producer)
							: await readArtifactGraphControl(cwd, producer);
						await assertWorkflowGoalChildCurrent(admission, childRun, childCompiled);
						await policyInput.assertCurrent();
						childSources.push({ taskId: slot, control: childControl, identity: {
							runId: childRun.runId, taskId: producer.taskId, specId: producer.specId,
							generation: generation!.generation,
							attemptKey: workflowTaskAttemptIdentity(producer, workflowTaskSessionId(childRun, producer)),
							backendTaskId: producer.backendTaskId ?? null,
							backendAttemptId: producer.durableLaunchBarrier?.records.find(record => record.attemptKey ===
								workflowTaskAttemptIdentity(producer, workflowTaskSessionId(childRun, producer)))?.backendAttemptId ?? null,
							kind: candidateSource ? "host-candidate-snapshot" : "workflow-control-artifact",
							artifact: toProjectPath(cwd, join(dirname(fromProjectPath(cwd, producer.files.result)), "control.json")),
						} });
					}
				}
				const sources: Array<{ taskId: string; control: unknown; identity: unknown }> = childSources;
				for (const dependency of lineage ? Object.entries(generation!.slots)
					.filter(([slot]) => !generation!.children?.[slot]).map(([, id]) => id) : launchTask.dependsOn ?? []) {
					const producer = run.tasks.find(candidate => candidate.specId === dependency);
					if (lineage && producer && compiledFlow.tasks.find(candidate => candidate.id === producer.specId)
						?.dynamicGenerated?.controllerSpecId !== generation!.workerControllerSpecId)
						throw new Error("Root oracle source has no exact current generation binding");
					if (producer?.status === "completed" && producer.artifactGraph?.enabled)
						sources.push({ taskId: lineage ?
							Object.entries(generation!.slots).find(([, id]) => id === producer.specId)?.[0] ?? "unbound" :
							producer.stageId ?? producer.specId, identity: {
								runId: run.runId, taskId: producer.taskId, specId: producer.specId,
								generation: generation?.generation ?? null,
								attemptKey: workflowTaskAttemptIdentity(producer, workflowTaskSessionId(run, producer)),
								backendTaskId: producer.backendTaskId ?? null,
								backendAttemptId: producer.durableLaunchBarrier?.records.at(-1)?.backendAttemptId ?? null,
								kind: lineage && launchTask.goal!.definition.goal.authority.allowedEffects.includes("candidate-write")
									? "host-candidate-snapshot" : "workflow-control-artifact",
								artifact: toProjectPath(cwd, join(dirname(fromProjectPath(cwd, producer.files.result)), "control.json")),
							}, control: lineage && launchTask.goal!.definition.goal.authority.allowedEffects.includes("candidate-write")
								? await observeWorkflowGoalCandidate(policyInput, policyInput.preparedAdmission!, run, producer)
								: await readArtifactGraphControl(cwd, producer) });
				}
				if (generation && !generation.verifiers && launchTask.goal!.definition.goal.criteria.some(c => c.verifier.kind === "model-rubric")) {
					const prepared = policyInput.preparedAdmission!;
					const verification = await prepareWorkflowEngineGoalVerifiers(policyInput, prepared, generation.generation, sources);
					await policyInput.assertCurrent();
					if (!verification) throw new Error("Goal rubric original verification phase unavailable");
					generation.verifiers = {};
					const ids: string[] = [];
					for (const verifierRequest of verification.requests) {
						const { criterionId } = verifierRequest;
						let verifierPreparation: PreparedWorkflowGoalVerifierRequest | undefined;
						try {
							await runDynamicAgentRequest({ cwd, run, compiledFlow,
								controllerIndex: compiledFlow.tasks.findIndex(candidate => candidate.id === compiledTask.id),
								controllerTask: { ...task, specId: `${task.specId}.$generation${generation.generation}.verifiers` },
								controllerCompiledTask: compiledTask, dynamic: verification.dynamic,
								requestId: verifierRequest.requestId,
								prepareGeneratedRequest: async identity => {
									const preparedRequest = prepareWorkflowEngineGoalVerifierRequest(policyInput, prepared,
										generation!.generation, verification.dynamic, verifierRequest, identity);
									verifierPreparation = preparedRequest.preparation;
									return preparedRequest;
								},
								onFreshGeneratedTask: async verifier => {
									if (!verifierPreparation)
										throw new Error("Goal rubric generated request preparation unavailable");
									return captureWorkflowEngineGoalVerifierTask(policyInput, prepared,
										verifierPreparation, verifier);
								},
								generatedTaskIds: ids,
								availableModels: [...options.goalPolicyHost.availableModels], artifactAccess: "none",
								agentDefinitions: workflowEngineGoalAgentDefinitions(policyInput, prepared), assertCurrent: policyInput.assertCurrent,
								onGeneratedTask: async (verifier, compiledVerifier) => {
									if (!verifierPreparation)
										throw new Error("Goal rubric generated request preparation unavailable");
									bindWorkflowGoalRequestTask(policyInput, prepared, run, task, verifier, compiledVerifier,
										generation!.generation, "verification",
										workflowEngineGoalVerifierSnapshot(verifierPreparation));
								} });
						} catch (error) { if (!(error instanceof DynamicControllerSuspended)) throw error; }
						generation.verifiers[criterionId] = ids.at(-1)!;
					}
					compiledTask.dependsOn = [...ids]; compiledTask.contextDependsOn = [...ids]; task.dependsOn = [...ids];
					task.status = "pending"; task.statusDetail = "goal_verifiers_materialized";
					task.lastMessage = "Original verification tasks consume immutable completed worker subjects; oracle awaits terminal verification.";
					await persistGoalGeneratedMaterialization(cwd, run, compiledFlow, undefined);
					return true;
				}
				result = await executeWorkflowEngineGoalPolicy({ ...policyInput, sources,
					humanSubmission: options.goalHumanSubmission?.token,
					requestAccounting: { run, compiled: compiledFlow } });
				await policyInput.assertCurrent();
				if (result.automatic.waitingUser) {
					if (result.state !== "waiting-user" || result.automatic.recoveryRequired)
						throw new Error("Goal human review waiting result is invalid");
				}
				if (!result.evidence) throw new Error("Goal oracle observation unavailable");
				if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(run.runId) ||
					!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(task.taskId) ||
					task.files.result !== `.pi/workflows/${run.runId}/tasks/${task.taskId}/result.json`)
					throw new Error("Goal policy evidence result path mismatch");
				const expectedEvidenceDirectory =
					`.pi/workflows/${run.runId}/tasks/${task.taskId}/goal-evidence`;
				let evidenceRefs: string[] = [];
				if (task.rawArtifactIntegrity) {
					await policyInput.assertCurrent();
					const previous = await readPublishedWorkflowGoalPolicyControl(cwd, run.runId, task);
					await policyInput.assertCurrent();
					evidenceRefs = retainedPublishedWorkflowGoalEvidenceRefs({
						control: previous,
						run,
						task,
						goalId: result.goalId,
						contractHash: result.contractHash,
					});
				}
				const evidenceRef = await persistWorkflowGoalOracleEvidence({ cwd, run, task, evidence: result.evidence,
					generation: generation?.generation ?? null, stopSignal: stop.signal, assertCurrent: policyInput.assertCurrent });
				await policyInput.assertCurrent();
				if (!new RegExp(`^${expectedEvidenceDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[a-f0-9]{64}\\.json$`)
					.test(evidenceRef))
					throw new Error("Goal current oracle evidence reference scope mismatch");
				if (!evidenceRefs.includes(evidenceRef)) evidenceRefs.push(evidenceRef);
				result = { ...result, evidenceRefs: [evidenceRef] };
				await policyInput.assertCurrent();
				await writeArtifactGraphDynamicResult(cwd, task, {
					control: { schema: "goal-policy-result-v1", digest: `Goal ${result.goalId} exact oracle observations persisted`,
						goalId: result.goalId, contractHash: result.contractHash, evidenceRefs: result.evidenceRefs,
						retainedEvidenceRefs: evidenceRefs,
						oracle: result.evidence },
					analysis: "Exact original-oracle observations are retained in immutable workflow task evidence artifacts; hashes are not authority.",
					refs: evidenceRefs.map(path => ({ id: path, path })),
				});
				await policyInput.assertCurrent();
				stop.signal.throwIfAborted();
				if (options.goalHumanSubmission) {
					// Persist the exact oracle result before accepting its provisional judgment.
					// A failed write/read/ACK latches UNKNOWN, retaining any published bytes.
					task.goal = { goalId: result.goalId, contractHash: result.contractHash,
						state: "engine:waiting-user", usage: { ...result.usage } };
					task.status = "running";
					task.statusDetail = "goal_waiting_user";
					await writeRunRecord(cwd, run);
					const published = await readRunRecord(cwd, run.runId);
					const publishedTask = published.tasks.find(candidate => candidate.taskId === task.taskId);
					if (!publishedTask || publishedTask.statusDetail !== "goal_waiting_user" ||
						workflowDefinitionFingerprint(publishedTask.goal) !== workflowDefinitionFingerprint(task.goal))
						throw new Error("Goal human original oracle run publication changed or uncertain");
					await policyInput.assertCurrent();
					await options.goalHumanSubmission.acknowledge();
				}
				if (lineage && generation && result.state === "not-achieved") {
					if (!Object.values(generation.slots).length)
						throw new Error("Root replan requires exact known terminal workers");
					for (const [slot, id] of Object.entries(generation.slots)) {
						if (generation.children?.[slot]) {
							const terminal = terminalChildren.get(slot);
							if (generation.children[slot].runId !== id || !terminal || await terminal() === null)
								throw new Error("Root replan requires exact known terminal child custody and settlement");
						} else if (run.tasks.find(candidate => candidate.specId === id)?.status !== "completed") {
							throw new Error("Root replan requires exact known terminal workers");
						}
					}
					await policyInput.assertCurrent();
					stop.signal.throwIfAborted();
					// Progress is measured on immutable oracle subjects, not model-authored
					// digests/claims which can vary while the actual candidate is unchanged.
					const candidateFingerprint = workflowDefinitionFingerprint(launchTask.goal!.definition.goal.criteria.map(criterion => {
						const subject = criterion.verifier.subject;
						const control = sources.find(source => source.taskId === subject.resultSlot)!.control;
						return { criterionId: criterion.id, value: subject.path ? readSimpleJsonPath(control, subject.path) : control };
					}));
					if (lineage.generations.some(previous => previous.failedCandidateFingerprint === candidateFingerprint))
						throw new Error("Root replan exhausted: unchanged failed candidate");
					// Commit the original oracle artifact metadata before staging a new
					// graph. Its integrity is not a generated-source publication change.
					await writeRunRecord(cwd, run);
					await policyInput.assertCurrent();
					generation.failedCandidateFingerprint = candidateFingerprint;
					generation.outcome = "not-achieved";
					const next = generation.generation + 1;
					const prepared = policyInput.preparedAdmission!;
					await recordWorkflowGoalRejectedGeneration(policyInput, prepared, run);
					const replan = prepareWorkflowEngineGoalReplanner(policyInput, prepared, sources.map(source => ({
						kind: "oracle" as const, ...source,
					})), generation.generation);
					await policyInput.assertCurrent();
					const ids: string[] = [];
					try {
						await runDynamicAgentRequest({ cwd, run, compiledFlow,
							controllerIndex: compiledFlow.tasks.findIndex(candidate => candidate.id === compiledTask.id),
							controllerTask: { ...task, specId: `${task.specId}.$generation${next}.planner` },
							controllerCompiledTask: compiledTask, dynamic: replan.dynamic,
							request: { id: `$generation${next}.planner`, profile: "planner", prompt: replan.prompt,
								readOnly: true, inputs: [], requiredReads: [], compact: false },
							generatedTaskIds: ids, availableModels: [...options.goalPolicyHost.availableModels], artifactAccess: "none",
							onFreshGeneratedTask: async planner => captureWorkflowGoalScopedTaskRuntime(
								policyInput, prepared, planner, next, "planning"),
							agentDefinitions: workflowEngineGoalAgentDefinitions(policyInput, prepared),
							assertCurrent: policyInput.assertCurrent,
							onGeneratedTask: async (planner, compiledPlanner) => {
								bindWorkflowGoalRequestTask(policyInput, prepared, run, task, planner, compiledPlanner, next, "planning");
								lineage.generations.push({ generation: next, plannerSpecId: planner.specId,
									workerControllerSpecId: `${task.specId}.$generation${next}.workers`, slots: {} });
								compiledTask.dependsOn = [planner.specId];
								compiledTask.contextDependsOn = [planner.specId];
								task.dependsOn = [planner.specId];
								task.status = "pending"; task.statusDetail = "goal_replan_materialized";
								task.lastMessage = "Original oracle rejected known terminal candidate; captured planner receives actual failed evidence.";
							} });
					} catch (error) { if (!(error instanceof DynamicControllerSuspended)) throw error; }
					await policyInput.assertCurrent();
					return true;
				}
				if (generation && result.achieved) generation.outcome = "achieved";
				if (result.achieved && lineage) {
					// Record the achieved Goal first so every application step is durable.
					const goalRecord = { goalId: result.goalId, contractHash: result.contractHash,
						state: `engine:${result.state}`, usage: { ...result.usage } };
					originApply = await applyWorkflowGoalCandidateToOrigin(policyInput, policyInput.preparedAdmission!, {
						signal: policyInput.stopSignal,
						onProgress: async record => {
							task.goal = { ...goalRecord, originApply: structuredClone(record) };
							await writeRunRecord(cwd, run);
						},
					});
				}
				result = { ...result, state: `engine:${result.state}` };
			} else throw new Error("Goal policy host must use the ordinary workflow engine");
			} finally {
				stop.dispose();
			}
			if (!result) {
				setTaskTerminal(task, "blocked", "goal_confirmation_cancelled", { lastMessage: "Goal confirmation cancelled; no Goal execution was admitted." });
			} else {
				task.goal = { goalId: result.goalId, contractHash: result.contractHash, state: result.state, usage: { ...result.usage },
					...(originApply ? { originApply: structuredClone(originApply) } : {}) };
				const originApplied = !originApply || originApply.status === "applied" || originApply.status === "no-changes";
				if (!result.achieved && result.automatic.waitingUser && !result.automatic.recoveryRequired) {
					task.status = "running";
					task.statusDetail = "goal_waiting_user";
					task.completedAt = undefined;
					task.lastMessage = "Goal awaits an explicit original human judgment; no provider or successor was launched.";
				} else if (!result.achieved && !result.automatic.recoveryRequired &&
					(result.automatic.canAutomaticallyContinue || result.automatic.waitingChild)) {
					task.status = "running";
					task.statusDetail = "goal_policy_waiting";
					task.completedAt = undefined;
					task.lastMessage = "Goal policy retains current custody; the downstream success barrier remains closed.";
				} else if (!result.achieved) {
					setTaskTerminal(task, "blocked", "goal_criteria_not_achieved", { lastMessage: `Goal remains ${result.state}; the downstream success barrier is closed.` });
				} else if (!originApplied) {
					setTaskTerminal(task, "blocked", `goal_origin_apply_${originApply!.status}`, {
						lastMessage: `Goal criteria were achieved in the candidate, but origin application ${originApply!.status}: ${originApply!.reason ?? "see originApply paths"}`,
					});
				} else {
					if (!result.evidence) await writeArtifactGraphDynamicResult(cwd, task, {
						control: { schema: "goal-policy-result-v1", digest: `Goal ${result.goalId} achieved with current criteria and known effects`, goalId: result.goalId, contractHash: result.contractHash, evidenceRefs: result.evidenceRefs },
						analysis: `Goal ${result.goalId} achieved. Evidence remains in its existing Goal and workflow journals.`, refs: result.evidenceRefs.map(digest => ({ id: digest, digest })),
					});
					setTaskTerminal(task, "completed", "goal_achieved", { exitCode: 0,
						...(originApply?.status === "applied" ? { lastMessage: `Goal achieved; applied ${originApply.paths.length} candidate path(s) to the working tree.` } : {}) });
				}
			}
			await writeRunRecord(cwd, run);
			return result?.achieved === true && (!originApply || originApply.status === "applied" || originApply.status === "no-changes");
		}

		if (launchTask.kind === "support" || launchTask.kind === "dynamic") {
			await persistFinalPromptMetadata(cwd, run, task, launchTask);
			if (launchTask.kind === "support") {
				return await executeSupportTask(
					cwd,
					run,
					task,
					launchTask,
					validationSnapshot,
				);
			}
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
		recordCreatedLoopWorktree(run, task, worktreeLaunchTask);
		await throwIfWorkflowStopRequested(cwd, run.runId);
		await writeRunRecord(cwd, run);
		const backend = resolveWorkflowBackend(run);
		const stop = createWorkflowStopSignal(cwd, run.runId);
		launchStopSignal = stop.signal;
		let launch;
		try {
			await throwIfWorkflowStopRequested(cwd, run.runId);
			await persistFinalPromptMetadata(cwd, run, task, worktreeLaunchTask);
			if (options.goalChildAdmission)
				await settleWorkflowGoalChildStagePredecessors(options.goalChildAdmission, run, compiledFlow, task);
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
		// Terminal settlement may already have cleared the transient handle. The
		// consumed native grant owns the attempt identity; snapshot it before awaits.
		const originalGrant = task.launchAuthority?.records.at(-1);
		const originalNativeAttempt = originalGrant?.state.phase === "consumed" &&
			originalGrant.grant.backendId === "pi-subagent/headless"
			? {
				grant: originalGrant,
				fingerprint: workflowDefinitionFingerprint(originalGrant),
				backendRunId: originalGrant.state.backendRunId,
				backendAttemptId: originalGrant.state.backendAttemptId,
			}
			: undefined;
		// SDK/provider callbacks may wrap a real stop denial in a generic error.
		// Keep the original observer's evidence even after its timer is disposed.
		let stopRequested = isWorkflowStopRequestedError(error) ||
			launchStopSignal?.aborted === true;
		if (!stopRequested) {
			await assertRunLeaseOwnership(cwd, run.runId, leaseSignal);
			stopRequested = (await readWorkflowStopIntent(cwd, run.runId)) !== undefined;
			if (!stopRequested && options.goalChildAdmission) {
				// The parent's fence can precede the descendant fence. Only the live
				// opaque reservation, not persisted Goal flags, supplies that parent.
				const lineage = workflowGoalChildLineage(options.goalChildAdmission);
				const lineageHash = workflowDefinitionFingerprint(lineage);
				if (lineage.runId === run.runId && lineage.parentRunId === run.parentRunId &&
					workflowDefinitionFingerprint(run.goalChild) === lineageHash) {
					const intent = await readWorkflowStopIntent(cwd, lineage.parentRunId);
					stopRequested = intent !== undefined &&
						workflowDefinitionFingerprint(workflowGoalChildLineage(options.goalChildAdmission)) === lineageHash &&
						lineage.runId === run.runId && lineage.parentRunId === run.parentRunId &&
						workflowDefinitionFingerprint(run.goalChild) === lineageHash;
				}
			}
			await assertRunLeaseOwnership(cwd, run.runId, leaseSignal);
		}
		stopRequested ||= launchStopSignal?.aborted === true;
		const durableBarrierRecord = task.durableLaunchBarrier?.records.at(-1);
		// A genuine child cancellation can outlive its legitimately retired fence.
		// Cleanup also cancels failed launches: its ACK alone does not prove a stop.
		// Require the original live parent's stop observation and consumed attempt.
		if (!stopRequested && options.goalChildAdmission && parentStopSignal?.aborted &&
			isWorkflowStopRequestedError(parentStopSignal.reason) &&
			durableBarrierRecord?.phase === "cancellation_acknowledged") {
			const lineage = workflowGoalChildLineage(options.goalChildAdmission);
			const grant = task.launchAuthority?.records.at(-1);
			stopRequested = lineage.runId === run.runId && lineage.parentRunId === run.parentRunId &&
				workflowDefinitionFingerprint(run.goalChild) === workflowDefinitionFingerprint(lineage) &&
				originalNativeAttempt !== undefined && grant === originalNativeAttempt.grant &&
				workflowDefinitionFingerprint(grant) === originalNativeAttempt.fingerprint &&
				grant?.state.phase === "consumed" && grant.grant.backendId === "pi-subagent/headless" &&
				grant.grant.runId === run.runId && grant.grant.task.taskId === task.taskId &&
				grant.grant.task.specId === task.specId &&
				durableBarrierRecord.releaseWinner === true &&
				durableBarrierRecord.attemptKey === grant.grant.attemptKey &&
				durableBarrierRecord.descriptor.subjectSha256 === grant.grant.identitySha256 &&
				durableBarrierRecord.launchAuthoritySha256 === grant.grant.identitySha256 &&
				!!originalNativeAttempt.backendRunId && !!originalNativeAttempt.backendAttemptId &&
				durableBarrierRecord.backendRunId === originalNativeAttempt.backendRunId &&
				durableBarrierRecord.backendRunId === task.backendTaskId &&
				durableBarrierRecord.backendAttemptId === originalNativeAttempt.backendAttemptId &&
				!!durableBarrierRecord.backendAttemptId &&
				durableBarrierRecord.cancellation?.terminalAttemptId === durableBarrierRecord.backendAttemptId &&
				durableBarrierRecord.cancellation.terminalStatus === "cancelled" &&
				!!durableBarrierRecord.cancellation.terminalObservedAt;
		}
		if (
			task.backendHandle &&
			durableBarrierRecord &&
			durableBarrierRecord.phase !== "cancellation_acknowledged" &&
			task.statusDetail === "cancellation_failed"
		) {
			task.status = "running";
			await writeRunRecord(cwd, run).catch(() => undefined);
			throw error;
		}
		if (stopRequested) {
			if (compiledTask.kind === "goal" &&
				options.goalPolicyHost?.executionFoundation === "workflow-engine") {
				// An aborted policy continuation is not descendant cancellation proof.
				// The existing stop owner must complete source-owned family cleanup.
				task.status = "running";
				task.statusDetail = "cancellation_pending";
				task.lastMessage =
					"workflow stop is waiting for source-owned Goal family cancellation confirmation";
				await writeRunRecord(cwd, run);
				return false;
			}
			if (
				task.backendHandle &&
				durableBarrierRecord &&
				durableBarrierRecord.phase !== "cancellation_acknowledged"
			) {
				task.status = "running";
				task.statusDetail = "cancellation_pending";
				task.lastMessage =
					"workflow stop is waiting for exact backend cancellation acknowledgement";
				await writeRunRecord(cwd, run).catch(() => undefined);
				return false;
			}
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
	const nowMs = dynamicControllerTestHooks.nowMs ?? Date.now;
	if (!compiledTask.dynamic) {
		throw new Error("dynamic metadata is missing");
	}
	assertNotProtectedGoalEngineRun(run);
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
	const attemptStartedAt = Date.now();
	const activeRuntimeStartedAt = nowMs === Date.now ? attemptStartedAt : nowMs();
	let activeRuntimeRecorded = false;
	const recordActiveRuntime = async (): Promise<void> => {
		if (activeRuntimeRecorded) return;
		activeRuntimeRecorded = true;
		const elapsedMs = Math.max(0, nowMs() - activeRuntimeStartedAt);
		if (elapsedMs === 0) return;
		await recordDynamicRuntimeUsage(cwd, run.runId, task.specId, elapsedMs).catch(
			() => undefined,
		);
	};

	const stop = createWorkflowStopSignal(cwd, run.runId);
	try {
		const structuredOutput = await runDynamicControllerWorker({
			attemptStartedAt,
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
		for (const specId of dynamicOutputTaskSpecIds(
			normalizeDynamicControllerOutput(structuredOutput).control,
		)) {
			const exported = run.tasks.find((candidate) => candidate.specId === specId);
			if (
				!exported ||
				exported.status !== "completed" ||
				!exported.artifactGraph?.enabled
			) {
				unrunBranchBlockers.push(
					`dynamic exported output is not a completed artifact task: ${specId}`,
				);
			}
		}
		const outputForOutcome =
			unrunBranchBlockers.length > 0
				? dynamicControllerOutputWithBranchBlockers(
						structuredOutput,
						unrunBranchBlockers,
					)
				: structuredOutput;
		const outcome = dynamicControllerOutcomeFromOutput(outputForOutcome, {
			requireOutput:
				run.provenance?.mode === "direct-dynamic" &&
				run.provenance.runtimeVersion === DIRECT_DYNAMIC_RUNTIME_VERSION,
		});
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
			...(outcome.taskStatus === "completed" ? {} : { message: outcome.message }),
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

async function buildDynamicControllerInvocation(
	input: Pick<Parameters<typeof runDynamicControllerWorker>[0],
		"cwd" | "run" | "compiledFlow" | "controllerTask" | "controllerCompiledTask" |
		"sources" | "dynamic" | "availableModels">,
	state: Awaited<ReturnType<typeof readOrRebuildDynamicState>>,
): Promise<Readonly<{
	task: unknown; sources: Record<string, unknown>; controllerStageId: string;
	generatedTaskIds: readonly string[]; generatedBranchTaskIds: readonly string[];
	budgetRemaining: Record<string, number>; availableTools: unknown;
	decisionLoop: unknown; engineCapabilities: typeof DYNAMIC_CONTROLLER_ENGINE_CAPABILITIES;
}>> {
	const controller = state.controllers[input.controllerTask.specId];
	return Object.freeze({
		task: input.compiledFlow.task ?? input.controllerCompiledTask.task,
		sources: input.sources,
		controllerStageId: input.controllerTask.stageId ??
			input.controllerTask.specId.replace(/\.controller$/, ""),
		generatedTaskIds: Object.freeze([...(controller?.generatedTaskIds ?? [])]),
		generatedBranchTaskIds: Object.freeze((controller?.branches ?? [])
			.map(branch => branch.specId)
			.filter((specId): specId is string => typeof specId === "string")),
		budgetRemaining: Object.freeze(await currentDynamicBudgetRemaining(input)),
		availableTools: buildAvailableToolView(input.controllerCompiledTask.runtime.tools,
			input.controllerCompiledTask.runtime.toolProviders),
		decisionLoop: input.dynamic.decisionLoop ?? null,
		engineCapabilities: DYNAMIC_CONTROLLER_ENGINE_CAPABILITIES,
	});
}

async function runDynamicControllerWorker(input: {
	attemptStartedAt: number;
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
	assertNotProtectedGoalEngineRun(input.run);
	const resolved = await resolveWorkflowHelperRef(
		input.dynamic.uses,
		input.helperSpecPath,
		{ label: "dynamic controller" },
	);
	const state = await readOrRebuildDynamicState(input.cwd, input.run.runId);
	const invocation = await buildDynamicControllerInvocation(input, state);
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
			...invocation,
		},
	});
	const helperCallCounts = new Map<string, number>();
	const workflowCallCounts = new Map<string, number>();
	const agentOpIds = new Set<string>();
	const replayedOpIds = new Set<string>();
	let settled = false;
	let currentGeneratedTaskIds = [...invocation.generatedTaskIds];
	const deadline = input.attemptStartedAt + remainingDynamicRuntimeMs(
		input.dynamic,
		state.controllers[input.controllerTask.specId]?.counters.runtimeMs ?? 0,
	);
	const timeoutMs = Math.max(0, deadline - Date.now());
	const attemptAbort = new AbortController();
	const attemptInput = { ...input, stopSignal: attemptAbort.signal };
	return await new Promise<unknown>((resolvePromise, rejectPromise) => {
		let opQueue = Promise.resolve();
		let handlerFailure: { error: unknown } | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			input.stopSignal?.removeEventListener("abort", abortStop);
			worker.removeAllListeners();
			attemptAbort.abort(
				input.stopSignal?.reason ??
					new DynamicControllerBudgetBlocked(
						"dynamic controller attempt settled; owned helper cancelled",
					),
			);
			// Join the handler's terminal helper event and both worker terminations.
			void Promise.all([worker.terminate(), opQueue]).then(
				() => (handlerFailure ? rejectPromise(handlerFailure.error) : callback()),
				rejectPromise,
			);
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
				await handleDynamicWorkerMessage(attemptInput, message, {
					deadline,
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
				handlerFailure = { error };
				if (!settled) finish(() => rejectPromise(error));
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
		deadline: number;
		helperCallCounts: Map<string, number>;
		workflowCallCounts: Map<string, number>;
		agentOpIds: Set<string>;
		replayedOpIds: Set<string>;
		replayPrefix: { opIds: string[]; cursor: number };
		getGeneratedTaskIds: () => string[];
		setGeneratedTaskIds: (ids: string[]) => void;
		isSettled: () => boolean;
		postResult: (
			id: number | string,
			result: {
				value?: unknown;
				error?: { name: string; message: string };
				budgetRemaining?: Record<string, number>;
			},
		) => void | Promise<void>;
		waitForGeneratedTask?: (task: WorkflowTaskRunRecord) => Promise<unknown>;
		onGeneratedTask?: (task: WorkflowTaskRunRecord, compiledTask: CompiledTask) => Promise<void>;
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
	if (message.type !== "op" || (typeof message.id !== "number" && typeof message.id !== "string")) return;
	let publishingResult = false;
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
				waitForGeneratedTask: state.waitForGeneratedTask,
				onGeneratedTask: state.onGeneratedTask,
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
			assertNotProtectedGoalEngineRun(input.run);
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
				deadline: state.deadline,
				isSettled: state.isSettled,
				stopSignal: input.stopSignal,
			});
		} else if (message.op === "workflow") {
			assertNotProtectedGoalEngineRun(input.run);
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
		const budgetRemaining = await currentDynamicBudgetRemaining(input);
		publishingResult = true;
		await state.postResult(message.id, {
			value,
			budgetRemaining,
		});
	} catch (error) {
		if (publishingResult) throw error;
		if (state.isSettled()) {
			if (
				error === input.stopSignal?.reason ||
				error instanceof DynamicControllerBudgetBlocked
			)
				return;
			throw error;
		}
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
		await state.postResult(message.id, {
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
			omitted.length > 0 ? omitted : replayPrefix.opIds.slice(replayPrefix.cursor);
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
}): Promise<Readonly<{
	maxAgents: number; maxConcurrency: number; maxRuntimeMs: number;
	maxNestedWorkflowDepth: number; maxGraphMutations: number; maxHelperRuns: number;
}>> {
	const state = await readOrRebuildDynamicState(input.cwd, input.run.runId);
	const run = await readRunRecord(input.cwd, input.run.runId).catch(
		() => input.run,
	);
	const remaining = dynamicBudgetRemaining(
		input.dynamic,
		state.controllers[input.controllerTask.specId]?.counters,
		countRunningDynamicAgents(
			run,
			input.controllerTask.specId,
			state.controllers[input.controllerTask.specId]?.generatedTaskIds ?? [],
		),
		await remainingDynamicNestedWorkflowDepth(
			input.cwd,
			input.run.runId,
			input.dynamic.budget.maxNestedWorkflowDepth,
		),
	);
	const budget = {
		maxAgents: remaining.maxAgents,
		maxConcurrency: remaining.maxConcurrency,
		maxRuntimeMs: remaining.maxRuntimeMs,
		maxNestedWorkflowDepth: remaining.maxNestedWorkflowDepth,
		maxGraphMutations: remaining.maxGraphMutations,
		maxHelperRuns: remaining.maxHelperRuns,
	};
	if (Object.values(budget).some(value => !Number.isSafeInteger(value) || value < 0))
		throw new Error("Goal source helper current budget is unavailable");
	return Object.freeze(budget);
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
				runtimeMs?: number;
		  }
		| undefined,
	runningAgents: number,
	nestedDepthRemaining: number,
): Record<string, number> {
	return {
		maxAgents: Math.max(0, dynamic.budget.maxAgents - (counters?.agents ?? 0)),
		maxConcurrency: Math.max(0, dynamic.budget.maxConcurrency - runningAgents),
		maxRuntimeMs: Math.max(
			0,
			remainingDynamicRuntimeMs(dynamic, counters?.runtimeMs ?? 0),
		),
		maxNestedWorkflowDepth: nestedDepthRemaining,
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
			void worker.terminate().then(callback, rejectPromise);
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
					rejectPromise(new Error(`dynamic helper worker exited with code ${code}`)),
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
      generatedTaskSpecId: (taskId) => workerData.controllerStageId + "." + String(taskId).trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64),
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
	const beforeCompiledDigest = input.run.goal === undefined
		? undefined : goalCompiledMaterializationDigest(input.compiledFlow);
	let compiledTask = input.compiledFlow.tasks.find((task) => task.id === specId);
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
		profile: request.profile,
		branchId: optionalEventString(event.payload.branchId),
		outputProfile: dynamicGeneratedOutputProfile(input.dynamic, request),
	});
	restoreDynamicGeneratedResourceWarnings(input.compiledFlow, compiledTask);
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
	await persistDynamicGeneratedMaterialization(input.cwd, input.run, input.compiledFlow, beforeCompiledDigest);
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
	request?: unknown;
	requestId?: unknown;
	prepareGeneratedRequest?: (identity: Readonly<{
		requestId: string;
		generatedSpecId: string;
		opId: string;
		historical: boolean;
	}>) => Promise<Readonly<{
		request: unknown;
		dynamic: CompiledDynamicWorkflowTask;
	}>>;
	generatedTaskIds: string[];
	isSettled?: () => boolean;
	/** Original source-only projection before the NEW materialization is published. */
	onFreshGeneratedTask?: (compiledTask: CompiledTask) => Promise<CompiledTask>;
	availableModels?: WorkflowModelInfo[];
	waitForGeneratedTask?: (task: WorkflowTaskRunRecord) => Promise<unknown>;
	onGeneratedTask?: (task: WorkflowTaskRunRecord, compiledTask: CompiledTask) => Promise<void>;
	artifactAccess?: "enabled" | "none";
	assertCurrent?: () => Promise<void>;
	readonly agentDefinitions?: ReadonlyMap<string, AgentDefinition>;
}): Promise<unknown> {
	await input.assertCurrent?.();
	const controllerStageId =
		input.controllerTask.stageId ??
		input.controllerTask.specId.replace(/\.controller$/, "");
	let effectiveDynamic = input.dynamic;
	let request: ReturnType<typeof normalizeDynamicAgentRequest>;
	let opId: string;
	let generatedSpecId: string;
	let events: Awaited<ReturnType<typeof readDynamicEvents>>;
	let previousByOpId: Awaited<ReturnType<typeof readDynamicEvents>>;
	if (input.prepareGeneratedRequest) {
		if ("request" in input || input.requestId === undefined)
			throw new Error("dynamic prepared agent request route is invalid");
		const requestIdentity = normalizeDynamicAgentRequest({
			id: input.requestId,
			prompt: "dynamic generated request identity",
		});
		opId = `${input.controllerTask.specId}:agent:${requestIdentity.id}`;
		events = await readDynamicEvents(input.cwd, input.run.runId);
		previousByOpId = events.filter(
			(event) => event.opId === opId && event.type === "task.generated",
		);
		const historical = previousByOpId.at(-1);
		generatedSpecId =
			optionalEventString(historical?.payload.taskId) ??
			`${controllerStageId}.${requestIdentity.id}`;
		const preparedRequest = await input.prepareGeneratedRequest({
			requestId: requestIdentity.id,
			generatedSpecId,
			opId,
			historical: historical !== undefined,
		});
		effectiveDynamic = preparedRequest.dynamic;
		request = normalizeDynamicAgentRequest(preparedRequest.request);
		if (request.id !== requestIdentity.id)
			throw new Error("dynamic prepared agent request id changed");
		await assertDynamicRuntimeBudgetAvailable({
			cwd: input.cwd,
			runId: input.run.runId,
			controllerSpecId: input.controllerTask.specId,
			dynamic: effectiveDynamic,
		});
	} else {
		if (input.requestId !== undefined)
			throw new Error("dynamic prepared agent request callback is unavailable");
		await assertDynamicRuntimeBudgetAvailable({
			cwd: input.cwd,
			runId: input.run.runId,
			controllerSpecId: input.controllerTask.specId,
			dynamic: effectiveDynamic,
		});
		request = normalizeDynamicAgentRequest(input.request);
		opId = `${input.controllerTask.specId}:agent:${request.id}`;
		generatedSpecId = `${controllerStageId}.${request.id}`;
		events = await readDynamicEvents(input.cwd, input.run.runId);
		previousByOpId = events.filter(
			(event) => event.opId === opId && event.type === "task.generated",
		);
	}
	const requestHash = hashDynamicRequest(request);
	const branchId = request.branchId;
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
	if (input.prepareGeneratedRequest) {
		if (previousGeneratedSpecId && previousGeneratedSpecId !== generatedSpecId)
			throw new Error("dynamic prepared agent generated task identity changed");
	} else if (previousGeneratedSpecId) generatedSpecId = previousGeneratedSpecId;
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
			profile: generationRequest.profile,
			branchId: generationBranchId,
			outputProfile: dynamicGeneratedOutputProfile(effectiveDynamic, generationRequest),
		});
	}
	const reattachingMaterializedTask = compiledTask !== undefined && runTask !== undefined;
	if (!compiledTask || !runTask) {
		if (!previousGenerated) {
			await assertDynamicGenerationBudgetAvailable({
				cwd: input.cwd,
				runId: input.run.runId,
				controllerSpecId: input.controllerTask.specId,
				dynamic: effectiveDynamic,
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
					dynamic: effectiveDynamic,
					availableModels: input.availableModels,
					artifactAccess: input.artifactAccess,
					agentDefinitions: input.agentDefinitions,
				});
		if (!previousGenerated)
			compiledTask = await input.onFreshGeneratedTask?.(compiledTask) ?? compiledTask;
		assertDynamicGeneratedMetadataMatches(compiledTask, {
			controllerSpecId: input.controllerTask.specId,
			opId: generationOpId,
			requestHash: generationRequestHash,
			requestId: generationRequest.id,
			profile: generationRequest.profile,
			branchId: generationBranchId,
			outputProfile: dynamicGeneratedOutputProfile(effectiveDynamic, generationRequest),
		});
		if (input.isSettled?.()) return undefined;
		restoreDynamicGeneratedResourceWarnings(input.compiledFlow, compiledTask);
		if (!previousGenerated) {
			await input.assertCurrent?.();
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
		const beforeCompiledDigest = input.run.goal === undefined
			? undefined : goalCompiledMaterializationDigest(input.compiledFlow);
		const existingRunIndex = runTask ? input.run.tasks.indexOf(runTask) : -1;
		const existingCompiledIndex = input.compiledFlow.tasks.indexOf(compiledTask);
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
		await input.onGeneratedTask?.(runTask, compiledTask);
		await persistDynamicGeneratedMaterialization(input.cwd, input.run, input.compiledFlow, beforeCompiledDigest);
	}

	await input.assertCurrent?.();
	if (!input.generatedTaskIds.includes(generatedSpecId)) input.generatedTaskIds.push(generatedSpecId);
	if (reattachingMaterializedTask) await input.onGeneratedTask?.(runTask, compiledTask);
	if (runTask.status === "completed") {
		return await readDynamicGeneratedTaskResult(input.cwd, runTask);
	}
	if (isTerminalTaskStatus(runTask.status)) {
		throw new Error(
			`dynamic generated task ${generatedSpecId} ended with ${runTask.status}: ${runTask.lastMessage ?? runTask.statusDetail}`,
		);
	}
	if (input.waitForGeneratedTask !== undefined) return await input.waitForGeneratedTask(runTask);
	throw new DynamicControllerSuspended(
		`waiting for dynamic generated task ${generatedSpecId} (${runTask.status})`,
	);
}

export interface DynamicControllerOutcome {
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

export function dynamicControllerOutcomeFromOutput(
	structuredOutput: unknown,
	options: { requireOutput?: boolean } = {},
): DynamicControllerOutcome {
	const { control } = normalizeDynamicControllerOutput(structuredOutput);
	const status = typeof control.status === "string" ? control.status : undefined;
	const blockers = dynamicControlStringArray(control.blockers);
	const omissions = dynamicControlStringArray(control.omissions);
	const outputTasks = dynamicOutputTaskSpecIds(control);

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

	if (options.requireOutput && outputTasks.length === 0) {
		return {
			taskStatus: "failed",
			statusDetail: "dynamic_incomplete",
			message: "direct dynamic controller produced no final synthesis output",
			lifecycleStatus: "failed",
			controllerStatus: "failed",
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
					? dynamicControllerIssueMessage("dynamic controller stopped", blockers)
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
		const outputTaskIds = new Set(dynamicControlStringArray(control.outputTasks));
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
					join(dirname(fromProjectPath(cwd, candidate.files.result)), "refs.json"),
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

export async function runWorkflow(
	specPath: string,
	cwd: string,
	options: WorkflowRunOptions = {},
): Promise<WorkflowRunRecord> {
	if (!options.task || options.task.trim() === "")
		throw new Error("This workflow needs a task");
	return runWorkflowSpec(specPath, cwd, options);
}
