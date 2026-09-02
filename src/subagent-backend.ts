import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import {
	copyFile,
	link,
	mkdir,
	readFile,
	readdir,
	rename,
	rm,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import {
	delimiter,
	dirname,
	extname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { availableParallelism, homedir } from "node:os";
import { fileURLToPath } from "node:url";

import type {
	ArtifactGraphRequiredRead,
	CompiledTask,
	CompiledToolProvider,
	RequiredWorkflowArtifactReadPolicy,
	WorkflowRunRecord,
	WorkflowDurableLaunchBarrierRecord,
	WorkflowTaskTimingAttemptRecord,
	WorkflowTaskTimingRecord,
	WorkflowTaskToolResultBudgetAttemptRecord,
	WorkflowTaskToolResultBudgetConfigurationRecord,
	WorkflowTaskToolResultBudgetRecord,
	WorkflowTaskUsageAttemptRecord,
	WorkflowTaskUsageRecord,
	WorkflowTaskUsageValues,
	WorkflowTaskRunRecord,
	WorkflowForeachBatchRecord,
	WorkflowToolResultBudgetConfigurationSource,
} from "./types.js";
import type { JsonSchema } from "./json-schema.js";
import { piAgentDir } from "./pi-agent-dir.js";
import {
	normalizedToolResultBudgetValues,
	summarizeToolResultBudgetAttempts,
} from "./dynamic-tool-result-budget-metrics.js";
import {
	fromProjectPath,
	isTerminalTaskStatus,
	nowIso,
	setTaskTerminal,
	toProjectPath,
	workflowRunDir,
	writeJsonAtomic,
	writeRunRecord,
	writeRunRecordDurable,
} from "./store.js";
import {
	isWorkflowStopRequestedError,
	throwIfWorkflowStopRequested,
} from "./workflow-stop.js";
import {
	retryWorkflowTaskSessionId,
	workflowTaskSessionId,
} from "./launch-session.js";
import {
	assertPreparedLaunchMatchesRecordedProvenance,
	assertRecordedLaunchBootstrapProvenance,
	createLaunchBootstrapProvenance,
	recordLaunchBootstrapProvenance,
} from "./launch-bootstrap-provenance.js";
import {
	assertCurrentWorkflowLaunchAuthority,
	consumeRegisteredWorkflowLaunchAuthority,
	consumeWorkflowLaunchAuthority,
	createWorkflowLaunchAuthority,
	hasNonSpawnableWorkflowLaunchAuthority,
	issueWorkflowLaunchAuthority,
	registerWorkflowLaunchAuthority,
	WorkflowLaunchAuthorityConsumedError,
	WorkflowLaunchAuthorityRegisteredError,
} from "./launch-authority.js";
import {
	applyTaskResultArtifact,
	isTaskTimedOut,
	markTaskTimedOut,
} from "./result.js";
import type {
	BackendLaunchResult,
	PreparedWorkflowTaskLaunch,
} from "./backend.js";
import {
	readWorkflowArtifactReadLedger,
	type WorkflowArtifactReadLedgerRecord,
} from "./workflow-artifact-tool.js";
import {
	buildWorkflowFetchCacheExtensionWrapper,
	writeWorkflowFetchCacheExtensionWrapper,
} from "./workflow-fetch-cache-extension.js";
import {
	buildWorkflowWebSourceExtensionWrapper,
	writeWorkflowWebSourceExtensionWrapper,
} from "./workflow-web-source-extension.js";
import { isWorkflowWebSourceTool } from "./workflow-web-source.js";
import {
	buildWorkflowOutputRetryInstructions,
	parseWorkflowOutputForBundle,
	validateWorkflowOutputForBundle,
	writeValidatedWorkflowTaskArtifactBundle,
	writeWorkflowTaskArtifactBundle,
	type ValidParsedWorkflowOutput,
	type WorkflowTaskFailedToolCallSummary,
} from "./workflow-output-artifacts.js";
import {
	EXPERIMENTAL_LAUNCH_RAMP_ENV,
	EXPERIMENTAL_SAME_SESSION_REPAIR_ENV,
	workflowExperimentalFlagEnabled,
} from "./experimental-speed-flags.js";
import { writeWorkflowPartialOutputLedgerFromFile } from "./workflow-partial-output.js";
import {
	activeForeachBatchRecordForTask,
	applyForeachBatchFallback,
	assertForeachBatchRecord,
	foreachBatchLeaderTask,
	foreachBatchTasks,
	parseForeachBatchEnvelope,
	reconstructForeachBatchItemOutput,
	setForeachBatchPhase,
	sha256Text,
} from "./foreach-batch-runtime.js";
import {
	assertForeachBatchCapability,
	issueForeachBatchCapability,
} from "./foreach-batch-capability.js";
import { PI_WORKFLOW_ROLE_ENV } from "./process-role.js";

const DEFAULT_SUBAGENT_RUNS_ROOT = ".pi/workflow-subagents";
const EXTRA_SUBAGENT_EXTENSIONS_ENV = "PI_WORKFLOW_SUBAGENT_EXTRA_EXTENSIONS";
const SUBAGENT_HEADLESS_BACKEND_ID = "pi-subagent/headless";
const FETCH_CONTENT_CACHE_ENV = "PI_WORKFLOW_FETCH_CONTENT_CACHE";
const LEGACY_FETCH_CACHE_ENV = "PI_WORKFLOW_FETCH_CACHE";
const FETCH_CONTENT_INLINE_CHARS_ENV = "PI_WORKFLOW_FETCH_CONTENT_INLINE_CHARS";
const DEFAULT_WORKFLOW_FETCH_CONTENT_INLINE_CHARS = 12_000;
const DEFAULT_TRANSIENT_MODEL_FAILURE_RETRIES = 5;
const DEFAULT_ARTIFACT_OUTPUT_RETRIES = 2;
export const TRANSIENT_MODEL_FAILURE_RETRIES_ENV =
	"PI_WORKFLOW_TRANSIENT_MODEL_FAILURE_RETRIES";
export const ARTIFACT_OUTPUT_RETRIES_ENV =
	"PI_WORKFLOW_ARTIFACT_OUTPUT_RETRIES";
const MAX_FAILED_TOOL_CALL_RECORDS = 20;
const MAX_CONCURRENT_LAUNCHES_ENV = "PI_WORKFLOW_MAX_CONCURRENT_LAUNCHES";
const MAX_LIVE_MODEL_WORKERS_ENV = "PI_WORKFLOW_MAX_LIVE_MODEL_WORKERS";
const ADAPTIVE_LIVE_MODEL_WORKERS_ENV = "PI_WORKFLOW_ADAPTIVE_LIVE_WORKERS";
const ADAPTIVE_LIVE_MODEL_WORKER_FLOOR = 4;
const ADAPTIVE_LIVE_MODEL_WORKER_DEFAULT_CEILING = 16;
const ADAPTIVE_LIVE_MODEL_WORKER_GROW_STEP = 2;
const ADAPTIVE_LIVE_MODEL_WORKER_WINDOW_SIZE = 20;
const ADAPTIVE_LIVE_MODEL_WORKER_BASELINE_SAMPLES = 5;
const ADAPTIVE_LIVE_MODEL_WORKER_GROW_RATIO = 1.5;
const ADAPTIVE_LIVE_MODEL_WORKER_SHRINK_RATIO = 2.5;
const LAUNCH_SLOT_RELEASE_DELAY_MS_ENV =
	"PI_WORKFLOW_LAUNCH_SLOT_RELEASE_DELAY_MS";
const PARENT_SUBAGENT_CWD_ENV = "PI_WORKFLOW_PARENT_SUBAGENT_CWD";
const PARENT_SUBAGENT_RUNS_DIR_ENV = "PI_WORKFLOW_PARENT_SUBAGENT_RUNS_DIR";
const PARENT_SUBAGENT_RUN_ID_ENV = "PI_WORKFLOW_PARENT_SUBAGENT_RUN_ID";
const PARENT_SUBAGENT_ATTEMPT_ID_ENV = "PI_WORKFLOW_PARENT_SUBAGENT_ATTEMPT_ID";
const DEFAULT_LAUNCH_SLOT_RELEASE_DELAY_MS = 3_000;
const EXPERIMENTAL_LAUNCH_RAMP_RELEASE_DELAY_MS = 250;
const STALE_LAUNCH_CLAIM_GRACE_MS = 30_000;
const REFRESH_STATUS_RECONCILE_CONCURRENCY = 8;
const SUBAGENT_LAUNCH_ACK_TIMEOUT_MS = 30_000;
const SUBAGENT_REFRESH_OPERATION_TIMEOUT_MS = 10_000;
const SUBAGENT_INTERRUPT_TIMEOUT_MS = 10_000;
const MIN_TRANSIENT_RETRY_JITTER_MS = 1_000;
const MAX_TRANSIENT_RETRY_JITTER_MS = 5_000;
// Transcript hygiene for dynamically generated children (June-22 evidence:
// children died on context overflow from accumulated tool results). Applied
// only to dynamic generated tasks; static stages keep their spec-authored
// budgets. Set the env to 0 (or any non-positive value) to disable.
const DYNAMIC_TOOL_RESULT_BUDGET_ENV =
	"PI_WORKFLOW_DYNAMIC_TOOL_RESULT_BUDGET_CHARS";
const DEFAULT_DYNAMIC_TOOL_RESULT_BUDGET_CHARS = 320_000;
const RATE_LIMIT_TRANSIENT_RETRY_BACKOFF_BASE_MS = 60_000;
const RATE_LIMIT_TRANSIENT_RETRY_BACKOFF_MAX_MS = 5 * 60_000;
const OAUTH_RATE_LIMIT_TRANSIENT_RETRY_BACKOFF_BASE_MS = 15 * 60_000;
const OAUTH_RATE_LIMIT_TRANSIENT_RETRY_BACKOFF_MAX_MS = 60 * 60_000;
const MAX_PERSISTED_RATE_LIMIT_BACKOFF_MS =
	OAUTH_RATE_LIMIT_TRANSIENT_RETRY_BACKOFF_MAX_MS;
const WORKFLOW_AUTH_FILE_ENV = "PI_WORKFLOW_AUTH_FILE";
const MODULE_PATH = fileURLToPath(import.meta.url);
const MODULE_DIR = dirname(MODULE_PATH);
const BUNDLED_PI_WEB_ACCESS_EXTENSION = bundledNodeModulePath(
	"pi-web-access",
	"index.ts",
);
const BUNDLED_PI_WEB_ACCESS_STORAGE = bundledNodeModulePath(
	"pi-web-access",
	"storage.ts",
);
const CODE_SEARCH_COMPAT_EXTENSION = resolve(
	MODULE_DIR,
	`code-search-compat-extension${extname(MODULE_PATH)}`,
);
const WORKFLOW_FETCH_CACHE_EXTENSION_IMPORT = resolve(
	MODULE_DIR,
	`workflow-fetch-cache-extension${extname(MODULE_PATH)}`,
);
const WORKFLOW_WEB_SOURCE_EXTENSION_IMPORT = resolve(
	MODULE_DIR,
	`workflow-web-source-extension${extname(MODULE_PATH)}`,
);
const TOOL_PROVIDER_EXTENSIONS: Record<string, string[]> = {
	web_search: [BUNDLED_PI_WEB_ACCESS_EXTENSION],
	code_search: [CODE_SEARCH_COMPAT_EXTENSION],
	fetch_content: [BUNDLED_PI_WEB_ACCESS_EXTENSION],
	get_search_content: [BUNDLED_PI_WEB_ACCESS_EXTENSION],
};

function bundledNodeModulePath(
	packageName: string,
	...parts: string[]
): string {
	const candidates = [
		resolve(MODULE_DIR, "..", "node_modules", packageName, ...parts),
		resolve(MODULE_DIR, "..", "..", "node_modules", packageName, ...parts),
	];
	return (
		candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!
	);
}

interface SubagentBackendHandle extends Record<string, unknown> {
	engine: "pi-subagent";
	backend: "headless";
	runId: string;
	attemptId: string;
	cwd: string;
	runsDir: string;
	display: string;
	sessionId?: string;
}

interface SubagentArtifactRef {
	type: string;
	path: string;
	artifactCwd?: string;
}

type SubagentRunLogRef = SubagentArtifactRef & {
	type: "stdout" | "stderr" | "output" | "result";
};
type SubagentResultArtifactRef = SubagentArtifactRef & {
	type: "tool-calls" | "tool-calls-summary" | SubagentRunLogRef["type"];
};

interface SubagentAttemptSnapshot {
	attemptId: string;
	status: string;
	heartbeatAt?: string;
	pid?: number;
	workerPid?: number;
}

interface SubagentRunStatusSnapshot {
	runId: string;
	attemptId: string;
	backend: string;
	status: string;
	failureKind: string | null;
	startedAt: string;
	completedAt: string | null;
	durationMs?: number | null;
	logs: SubagentRunLogRef[];
	metadata?: { contextLengthExceeded?: boolean; [key: string]: unknown };
	completion?: unknown;
	attempts?: SubagentAttemptSnapshot[];
}

interface SubagentResultEnvelope {
	runId: string;
	attemptId: string;
	status: string;
	artifacts?: SubagentResultArtifactRef[];
	cwd?: string;
}

interface DurableLaunchBarrierDescriptor {
	schema: "pi-subagent-durable-launch-barrier-v2";
	identitySha256: string;
	directory: string;
	readyPath: string;
	decisionPath: string;
	ackPath: string;
	challenge: string;
	decisionNonce: string;
	subjectSha256: string;
	authorityBindingSha256?: string;
	directoryIdentity: { device: number; inode: number; uid?: number };
	timeoutMs: number;
	pollIntervalMs: number;
}

interface DurableLaunchBarrierReady {
	schema: "pi-subagent-durable-launch-barrier-ready-v2";
	barrierIdentitySha256: string;
	challenge: string;
	decisionNonce: string;
	subjectSha256: string;
	authorityBindingSha256?: string;
	runId: string;
	attemptId: string;
	workerPid: number;
	workerProcessGroupId?: number;
	readySha256: string;
	launchPayloadSha256: string;
	executionPlanSha256: string;
}

interface DurableLaunchBarrierReleaseDecision {
	schema: "pi-subagent-durable-launch-barrier-decision-v2";
	kind: "released";
	barrierIdentitySha256: string;
	challenge: string;
	decisionNonce: string;
	subjectSha256: string;
	authorityBindingSha256?: string;
	runId: string;
	attemptId: string;
	readySha256: string;
	releasePayloadSha256: string;
	decisionSha256: string;
}

interface DurableLaunchBarrierRevocationDecision {
	schema: "pi-subagent-durable-launch-barrier-decision-v2";
	kind: "revoked";
	barrierIdentitySha256: string;
	challenge: string;
	decisionNonce: string;
	subjectSha256: string;
	authorityBindingSha256?: string;
	cancellationId: string;
	reasonSha256: string;
	decisionSha256: string;
}

type DurableLaunchBarrierDecision =
	| DurableLaunchBarrierReleaseDecision
	| DurableLaunchBarrierRevocationDecision;

interface DurableLaunchBarrierResolution {
	outcome: DurableLaunchBarrierDecision["kind"];
	decision: DurableLaunchBarrierDecision;
}

interface DurableLaunchBarrierAck {
	schema: "pi-subagent-durable-launch-barrier-ack-v2";
	barrierIdentitySha256: string;
	challenge: string;
	decisionNonce: string;
	runId: string;
	attemptId: string;
	readySha256: string;
	decisionSha256: string;
	ackSha256: string;
}

interface DurableLaunchBarrierState {
	ready?: DurableLaunchBarrierReady;
	decision?: DurableLaunchBarrierDecision;
	ack?: DurableLaunchBarrierAck;
}

interface SubagentInterruptResult {
	status:
		| "interrupt-requested"
		| "not-found"
		| "already-terminal"
		| "unsupported";
	runId: string;
	interruptedAttempts: string[];
	unsupportedAttempts: string[];
	record?: {
		status?: string;
		attempts?: Array<{ attemptId?: string; status?: string }>;
	} | null;
}

interface SubagentApi {
	runSubagent(
		options: Record<string, unknown>,
	): Promise<SubagentResultEnvelope>;
	createDurableLaunchBarrierV2?(options: {
		directory: string;
		subjectSha256: string;
		authorityBindingSha256?: string;
		timeoutMs?: number;
		pollIntervalMs?: number;
	}): Promise<DurableLaunchBarrierDescriptor>;
	durableLaunchBarrierDigest?(value: unknown): string;
	waitForDurableLaunchBarrierV2Ready?(
		descriptor: DurableLaunchBarrierDescriptor,
	): Promise<DurableLaunchBarrierReady>;
	resolveDurableLaunchBarrierV2Release?(
		descriptor: DurableLaunchBarrierDescriptor,
		ready: DurableLaunchBarrierReady,
		releasePayloadSha256: string,
	): Promise<DurableLaunchBarrierResolution>;
	revokeDurableLaunchBarrierV2?(
		descriptor: DurableLaunchBarrierDescriptor,
		options: { cancellationId: string; reasonSha256: string },
	): Promise<DurableLaunchBarrierResolution>;
	readDurableLaunchBarrierV2State?(
		descriptor: DurableLaunchBarrierDescriptor,
	): Promise<DurableLaunchBarrierState>;
	waitForDurableLaunchBarrierV2Ack?(
		descriptor: DurableLaunchBarrierDescriptor,
		decision: DurableLaunchBarrierReleaseDecision,
	): Promise<DurableLaunchBarrierAck>;
	getSubagentStatus(
		options: Record<string, unknown>,
	): Promise<SubagentRunStatusSnapshot | null>;
	interruptSubagent(
		options: Record<string, unknown>,
	): Promise<SubagentInterruptResult>;
	reconcileSubagentRun(options: Record<string, unknown>): Promise<unknown>;
	recordSubagentChildEvent?(options: Record<string, unknown>): Promise<unknown>;
}

type ParentSubagentChildEvent =
	| "started"
	| "completed"
	| "failed"
	| "cancelled";

interface ParentSubagentRef {
	cwd: string;
	runsDir: string;
	runId: string;
	attemptId?: string;
}

const GENERIC_TASK_STATUS_DETAILS = new Set([
	"completed",
	"failed",
	"interrupted",
	"running",
]);

const subagentApiSpecifier = "@agwab/pi-subagent/api";
let cachedSubagentApi: Promise<SubagentApi> | undefined;
let injectedSubagentApi: SubagentApi | undefined;

export function setSubagentApiForTests(api: unknown | undefined): void {
	injectedSubagentApi = api === undefined ? undefined : (api as SubagentApi);
	cachedSubagentApi = undefined;
	if (api === undefined) {
		sharedModelRateLimitBackoffs.clear();
		removePersistedSharedModelRateLimitBackoffsForTests();
	}
}

async function loadSubagentApi(): Promise<SubagentApi> {
	if (injectedSubagentApi) return injectedSubagentApi;
	cachedSubagentApi ??= import(subagentApiSpecifier).then(
		(mod) => mod as SubagentApi,
	);
	return cachedSubagentApi;
}

type DurableLaunchBarrierApi = Required<
	Pick<
		SubagentApi,
		| "createDurableLaunchBarrierV2"
		| "durableLaunchBarrierDigest"
		| "waitForDurableLaunchBarrierV2Ready"
		| "resolveDurableLaunchBarrierV2Release"
		| "revokeDurableLaunchBarrierV2"
		| "readDurableLaunchBarrierV2State"
		| "waitForDurableLaunchBarrierV2Ack"
	>
>;

function hasDurableLaunchBarrierApi(
	api: SubagentApi,
): api is SubagentApi & DurableLaunchBarrierApi {
	return (
		typeof api.createDurableLaunchBarrierV2 === "function" &&
		typeof api.durableLaunchBarrierDigest === "function" &&
		typeof api.waitForDurableLaunchBarrierV2Ready === "function" &&
		typeof api.resolveDurableLaunchBarrierV2Release === "function" &&
		typeof api.revokeDurableLaunchBarrierV2 === "function" &&
		typeof api.readDurableLaunchBarrierV2State === "function" &&
		typeof api.waitForDurableLaunchBarrierV2Ack === "function"
	);
}

function isSha256Digest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

export interface OneShotSubagentEnvelope {
	runId: string;
	attemptId: string;
	status: string;
	cwd?: string;
	artifacts?: Array<{ type: string; path: string; artifactCwd?: string }>;
}

/**
 * Shared entry point for one-off synchronous subagent calls (workflow router
 * pass and routed direct answers). Honors `setSubagentApiForTests`.
 */
export async function runOneShotSubagentCall(
	options: Record<string, unknown>,
): Promise<OneShotSubagentEnvelope> {
	await assertSubagentExtensionsLoadable(options);
	const api = await loadSubagentApi();
	return (await api.runSubagent(options)) as OneShotSubagentEnvelope;
}

interface ExtensionPreflightLoader {
	reload(options?: unknown): Promise<void>;
	getExtensions(): {
		errors: Array<{ path: string; error: string }>;
	};
}

/**
 * Load extension factories in an isolated Pi resource loader before a child
 * backend can make its first model/provider call. Extension factories are
 * intentionally run against the loader's buffered registration runtime.
 */
export async function assertSubagentExtensionsLoadable(
	options: Record<string, unknown>,
): Promise<void> {
	const cwd =
		typeof options.cwd === "string" && options.cwd
			? resolve(options.cwd)
			: process.cwd();
	const extensions = Array.isArray(options.extensions)
		? options.extensions.filter(
				(value): value is string => typeof value === "string" && value.length > 0,
			)
		: undefined;
	const piSdk = await import("@earendil-works/pi-coding-agent");
	const resourceLoader = new piSdk.DefaultResourceLoader({
		cwd,
		agentDir: piSdk.getAgentDir(),
		additionalExtensionPaths: extensions?.length ? extensions : undefined,
		noExtensions: extensions !== undefined && extensions.length === 0,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	}) as ExtensionPreflightLoader;
	await resourceLoader.reload();
	const errors = resourceLoader
		.getExtensions()
		.errors.map(({ path, error }) => ({ path, error }))
		.sort(
			(left, right) =>
				left.path.localeCompare(right.path) || left.error.localeCompare(right.error),
		);
	if (errors.length === 0) return;
	throw new Error(
		[
			"Subagent extension preflight failed before model execution:",
			...errors.map(({ path, error }) => `- ${path}: ${error}`),
		].join("\n"),
	);
}

// @agwab/pi-subagent 0.4.x does not expose a supported per-run env option.
// Scope the process env around its async launch so the durable worker (and the
// Pi process it spawns) inherit worker role without external driver injection.
let workflowWorkerRoleLaunchDepth = 0;
let workflowWorkerRolePreviousValue: string | undefined;
let workflowWorkerRolePreviouslySet = false;

async function runSubagentWithWorkflowWorkerRole(
	api: SubagentApi,
	options: Record<string, unknown>,
): Promise<SubagentResultEnvelope> {
	enterWorkflowWorkerRoleEnv();
	try {
		return await api.runSubagent(options);
	} finally {
		exitWorkflowWorkerRoleEnv();
	}
}

function enterWorkflowWorkerRoleEnv(): void {
	if (workflowWorkerRoleLaunchDepth === 0) {
		workflowWorkerRolePreviouslySet = Object.hasOwn(
			process.env,
			PI_WORKFLOW_ROLE_ENV,
		);
		workflowWorkerRolePreviousValue = process.env[PI_WORKFLOW_ROLE_ENV];
	}
	workflowWorkerRoleLaunchDepth += 1;
	process.env[PI_WORKFLOW_ROLE_ENV] = "worker";
}

function exitWorkflowWorkerRoleEnv(): void {
	workflowWorkerRoleLaunchDepth = Math.max(
		0,
		workflowWorkerRoleLaunchDepth - 1,
	);
	if (workflowWorkerRoleLaunchDepth > 0) {
		process.env[PI_WORKFLOW_ROLE_ENV] = "worker";
		return;
	}
	if (
		workflowWorkerRolePreviouslySet &&
		workflowWorkerRolePreviousValue !== undefined
	)
		process.env[PI_WORKFLOW_ROLE_ENV] = workflowWorkerRolePreviousValue;
	else delete process.env[PI_WORKFLOW_ROLE_ENV];
	workflowWorkerRolePreviouslySet = false;
	workflowWorkerRolePreviousValue = undefined;
}

function nonEmptyEnv(
	env: Record<string, string | undefined>,
	key: string,
): string | undefined {
	const value = env[key]?.trim();
	return value ? value : undefined;
}

function parentSubagentRefFromEnv(
	env: Record<string, string | undefined> = process.env,
): ParentSubagentRef | undefined {
	const cwd = nonEmptyEnv(env, PARENT_SUBAGENT_CWD_ENV);
	const runsDir = nonEmptyEnv(env, PARENT_SUBAGENT_RUNS_DIR_ENV);
	const runId = nonEmptyEnv(env, PARENT_SUBAGENT_RUN_ID_ENV);
	if (!cwd || !runsDir || !runId) return undefined;
	const attemptId = nonEmptyEnv(env, PARENT_SUBAGENT_ATTEMPT_ID_ENV);
	return { cwd, runsDir, runId, ...(attemptId ? { attemptId } : {}) };
}

function terminalChildEventForTaskStatus(
	status: WorkflowTaskRunRecord["status"],
): ParentSubagentChildEvent | undefined {
	if (status === "completed") return "completed";
	if (status === "failed") return "failed";
	if (status === "interrupted") return "cancelled";
	return undefined;
}

function childEventUsageSummary(
	task: WorkflowTaskRunRecord,
): Record<string, number> | undefined {
	const source = task.usage?.aggregate ?? task.usage;
	if (!source) return undefined;
	const summary: Record<string, number> = {};
	for (const key of USAGE_METRIC_KEYS) {
		const value = source[key];
		if (typeof value === "number") summary[key] = value;
	}
	return Object.keys(summary).length > 0 ? summary : undefined;
}

async function recordParentSubagentChildEvent(options: {
	event: ParentSubagentChildEvent;
	childRunId: string;
	run: WorkflowRunRecord;
	task: WorkflowTaskRunRecord;
	failureKind?: string | null;
	message?: string;
}): Promise<void> {
	const parent = parentSubagentRefFromEnv();
	if (!parent) return;
	const api = await loadSubagentApi().catch(() => undefined);
	if (!api?.recordSubagentChildEvent) return;
	// Usage rides along on terminal events so a parent subagent can aggregate
	// nested workflow spend. Engines older than 0.4.8 ignore the extra field.
	const usage =
		options.event === "started"
			? undefined
			: childEventUsageSummary(options.task);
	await api
		.recordSubagentChildEvent({
			...parent,
			event: options.event,
			childRunId: options.childRunId,
			workflowRunId: options.run.runId,
			childTaskId: options.task.taskId,
			...(options.failureKind === undefined
				? {}
				: { failureKind: options.failureKind }),
			...(options.message === undefined ? {} : { message: options.message }),
			...(usage === undefined ? {} : { usage }),
		})
		.catch(() => undefined);
}

async function recordTerminalParentSubagentChildEvent(
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	snapshot: SubagentRunStatusSnapshot,
): Promise<void> {
	const event = terminalChildEventForTaskStatus(task.status);
	if (!event) return;
	const taskFailureKind =
		task.statusDetail && !GENERIC_TASK_STATUS_DETAILS.has(task.statusDetail)
			? task.statusDetail
			: undefined;
	await recordParentSubagentChildEvent({
		event,
		childRunId: snapshot.runId,
		run,
		task,
		failureKind:
			event === "completed"
				? undefined
				: (snapshot.failureKind ?? taskFailureKind ?? task.statusDetail),
		message: task.lastMessage,
	});
}

let launchSlotReleaseDelayMsForTests: number | undefined;
let transientRetryJitterForTests: (() => number) | undefined;
let launchSlotAcquiredHookForTests: (() => void) | undefined;
let beforeRunSubagentHookForTests: (() => void | Promise<void>) | undefined;
let afterLaunchAuthorityRegisteredHookForTests:
	| (() => void | Promise<void>)
	| undefined;
let beforeDurableBarrierReleaseHookForTests:
	| (() => void | Promise<void>)
	| undefined;
let beforeDurableBarrierAckWaitHookForTests:
	| (() => void | Promise<void>)
	| undefined;
let launchSlotReleaseGeneration = 0;

interface SharedModelRateLimitBackoffState {
	nextEligibleAtMs: number;
	retryAfterMs: number;
	updatedAt: string;
}

const sharedModelRateLimitBackoffs = new Map<
	string,
	SharedModelRateLimitBackoffState
>();

// Cross-process persistence for shared rate-limit backoffs. Provider rate
// limits are account-level, so concurrent Pi processes (e.g. parallel eval
// batches) should honor each other's cooldowns. The file is an advisory hint;
// writes serialize through a dedicated lock and merge maxima under that lock.
const SHARED_RATE_LIMIT_BACKOFF_MAX_PERSISTED_KEYS = 32;
const SHARED_RATE_LIMIT_BACKOFF_LOCK_WAIT_MS = 5_000;
const SHARED_RATE_LIMIT_BACKOFF_LOCK_RETRY_MS = 25;
const SHARED_RATE_LIMIT_BACKOFF_LOCK_STALE_MS = 30_000;

interface SharedRateLimitPersistenceTelemetry {
	failures: number;
	lastFailureAt?: string;
	lastError?: string;
	lastFile?: string;
	lastKey?: string;
}

let sharedRateLimitPersistenceTelemetry: SharedRateLimitPersistenceTelemetry = {
	failures: 0,
};

export function sharedRateLimitPersistenceTelemetryForTests(): SharedRateLimitPersistenceTelemetry {
	return { ...sharedRateLimitPersistenceTelemetry };
}

function sharedModelRateLimitBackoffFile(): string {
	return join(piAgentDir(), "model-rate-limit-backoff.json");
}

function validPersistedSharedBackoff(
	value: unknown,
	nowMs: number,
): SharedModelRateLimitBackoffState | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return undefined;
	const record = value as Record<string, unknown>;
	const nextEligibleAtMs = record.nextEligibleAtMs;
	if (
		typeof nextEligibleAtMs !== "number" ||
		!Number.isFinite(nextEligibleAtMs)
	)
		return undefined;
	if (nextEligibleAtMs <= nowMs) return undefined;
	if (nextEligibleAtMs - nowMs > MAX_PERSISTED_RATE_LIMIT_BACKOFF_MS)
		return undefined;
	return {
		nextEligibleAtMs,
		retryAfterMs: Math.max(0, nextEligibleAtMs - nowMs),
		updatedAt:
			typeof record.updatedAt === "string" ? record.updatedAt : nowIso(),
	};
}

async function loadPersistedSharedModelRateLimitBackoffs(): Promise<void> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(
			await readFile(sharedModelRateLimitBackoffFile(), "utf8"),
		);
	} catch {
		return;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
	const nowMs = Date.now();
	for (const [key, value] of Object.entries(
		parsed as Record<string, unknown>,
	)) {
		const state = validPersistedSharedBackoff(value, nowMs);
		if (!state) continue;
		const existing = sharedModelRateLimitBackoffs.get(key);
		if (existing && existing.nextEligibleAtMs >= state.nextEligibleAtMs)
			continue;
		sharedModelRateLimitBackoffs.set(key, state);
	}
}

async function withSharedRateLimitBackoffLock<T>(
	file: string,
	action: () => Promise<T>,
): Promise<T> {
	const lockDir = `${file}.lock`;
	await mkdir(dirname(file), { recursive: true });
	const deadline = Date.now() + SHARED_RATE_LIMIT_BACKOFF_LOCK_WAIT_MS;
	while (true) {
		try {
			await mkdir(lockDir);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const lockStat = await stat(lockDir).catch(() => undefined);
			if (
				lockStat &&
				Date.now() - lockStat.mtimeMs > SHARED_RATE_LIMIT_BACKOFF_LOCK_STALE_MS
			) {
				await rm(lockDir, { recursive: true, force: true });
				continue;
			}
			if (Date.now() >= deadline) {
				throw new Error(
					`timed out acquiring shared rate-limit lock: ${lockDir}`,
				);
			}
			await sleep(SHARED_RATE_LIMIT_BACKOFF_LOCK_RETRY_MS);
		}
	}
	try {
		return await action();
	} finally {
		await rm(lockDir, { recursive: true, force: true });
	}
}

async function persistSharedModelRateLimitBackoffs(
	changedKey: string,
): Promise<void> {
	const file = sharedModelRateLimitBackoffFile();
	try {
		await withSharedRateLimitBackoffLock(file, async () => {
			const nowMs = Date.now();
			const merged = new Map<string, SharedModelRateLimitBackoffState>();
			let onDisk: unknown;
			try {
				onDisk = JSON.parse(await readFile(file, "utf8"));
			} catch {
				onDisk = undefined;
			}
			if (onDisk && typeof onDisk === "object" && !Array.isArray(onDisk)) {
				for (const [key, value] of Object.entries(
					onDisk as Record<string, unknown>,
				)) {
					const state = validPersistedSharedBackoff(value, nowMs);
					if (state) merged.set(key, state);
				}
			}
			for (const [key, state] of sharedModelRateLimitBackoffs) {
				if (state.nextEligibleAtMs <= nowMs) continue;
				const existing = merged.get(key);
				if (!existing || state.nextEligibleAtMs > existing.nextEligibleAtMs)
					merged.set(key, state);
			}
			const entries = [...merged.entries()]
				.sort((a, b) => b[1].nextEligibleAtMs - a[1].nextEligibleAtMs)
				.slice(0, SHARED_RATE_LIMIT_BACKOFF_MAX_PERSISTED_KEYS);
			const tmpFile = `${file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
			try {
				await writeFile(
					tmpFile,
					`${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`,
					"utf8",
				);
				await rename(tmpFile, file);
			} finally {
				await rm(tmpFile, { force: true });
			}
		});
	} catch (error) {
		sharedRateLimitPersistenceTelemetry = {
			failures: sharedRateLimitPersistenceTelemetry.failures + 1,
			lastFailureAt: nowIso(),
			lastError: error instanceof Error ? error.message : String(error),
			lastFile: file,
			lastKey: changedKey,
		};
		// Advisory cross-process hint only: retain the local cooldown and let the
		// caller continue, while exposing structured failure telemetry.
	}
}

function removePersistedSharedModelRateLimitBackoffsForTests(): void {
	try {
		const file = sharedModelRateLimitBackoffFile();
		rmSync(file, { force: true });
		rmSync(`${file}.lock`, { recursive: true, force: true });
		sharedRateLimitPersistenceTelemetry = { failures: 0 };
	} catch {
		// best-effort test hygiene
	}
}

interface WaitQueueEntry {
	resolveWait: () => void;
	rejectWait: (error: Error) => void;
}

const launchWaitQueue: WaitQueueEntry[] = [];
let activeLaunchSlots = 0;
const activeLiveModelWorkerKeys = new Set<string>();

function resolveMaxConcurrentLaunches(): number {
	const override = Number.parseInt(
		process.env[MAX_CONCURRENT_LAUNCHES_ENV] ?? "",
		10,
	);
	if (Number.isFinite(override)) return Math.max(1, Math.floor(override));
	return Math.max(2, Math.floor(availableParallelism() / 2));
}

function isLaunchGateSaturated(): boolean {
	return activeLaunchSlots >= resolveMaxConcurrentLaunches();
}

function abortSignalError(signal: AbortSignal): Error {
	const reason = (signal as AbortSignal & { reason?: unknown }).reason;
	if (reason instanceof Error) return reason;
	return new Error(
		reason === undefined
			? "Lost supervisor lease"
			: `Lost supervisor lease: ${String(reason)}`,
	);
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortSignalError(signal);
}

async function throwIfLaunchStopped(
	cwd: string,
	runId: string,
	leaseSignal?: AbortSignal,
	workflowStopSignal?: AbortSignal,
): Promise<void> {
	throwIfAborted(leaseSignal);
	throwIfAborted(workflowStopSignal);
	await throwIfWorkflowStopRequested(cwd, runId);
	throwIfAborted(leaseSignal);
	throwIfAborted(workflowStopSignal);
}

function combineAbortSignals(
	left?: AbortSignal,
	right?: AbortSignal,
): AbortSignal | undefined {
	if (!left) return right;
	if (!right) return left;
	return AbortSignal.any([left, right]);
}

export class SubagentOperationTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SubagentOperationTimeoutError";
	}
}

export async function awaitSubagentOperation<T>(
	operation: () => Promise<T>,
	options: {
		operation: string;
		context: string;
		timeoutMs: number;
		signal?: AbortSignal;
	},
): Promise<T> {
	throwIfAborted(options.signal);
	const timeoutMs = Math.max(1, Math.floor(options.timeoutMs));
	return new Promise<T>((resolveOperation, rejectOperation) => {
		let settled = false;
		let abortListener: (() => void) | undefined;
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (options.signal && abortListener) {
				options.signal.removeEventListener("abort", abortListener);
			}
			callback();
		};
		const timer = setTimeout(() => {
			finish(() =>
				rejectOperation(
					new SubagentOperationTimeoutError(
						`subagent ${options.operation} timed out after ${timeoutMs}ms (${options.context})`,
					),
				),
			);
		}, timeoutMs);
		if (options.signal) {
			abortListener = () => {
				finish(() => rejectOperation(abortSignalError(options.signal!)));
			};
			options.signal.addEventListener("abort", abortListener, { once: true });
		}
		Promise.resolve()
			.then(operation)
			.then(
				(value) => finish(() => resolveOperation(value)),
				(error: unknown) => finish(() => rejectOperation(error)),
			);
	});
}

function removeWaiter(queue: WaitQueueEntry[], waiter: WaitQueueEntry): void {
	const index = queue.indexOf(waiter);
	if (index >= 0) queue.splice(index, 1);
}

function waitForQueueTurn(
	queue: WaitQueueEntry[],
	signal?: AbortSignal,
): Promise<void> {
	throwIfAborted(signal);
	return new Promise<void>((resolveWait, rejectWait) => {
		const waiter: WaitQueueEntry = {
			resolveWait: () => {
				cleanup();
				resolveWait();
			},
			rejectWait: (error) => {
				cleanup();
				rejectWait(error);
			},
		};
		const cleanup = (): void => {
			if (signal) signal.removeEventListener("abort", onAbort);
		};
		const onAbort = (): void => {
			removeWaiter(queue, waiter);
			waiter.rejectWait(abortSignalError(signal!));
		};
		if (signal) signal.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) {
			onAbort();
			return;
		}
		queue.push(waiter);
	});
}

async function acquireLaunchSlot(signal?: AbortSignal): Promise<() => void> {
	throwIfAborted(signal);
	if (!isLaunchGateSaturated()) {
		activeLaunchSlots += 1;
		return releaseLaunchSlot;
	}
	await waitForQueueTurn(launchWaitQueue, signal);
	if (signal?.aborted) {
		releaseLaunchSlot();
		throw abortSignalError(signal);
	}
	return releaseLaunchSlot;
}

function releaseLaunchSlot(): void {
	const next = launchWaitQueue.shift();
	if (next) {
		// Transfer the occupied slot directly to the queued launcher.
		next.resolveWait();
		return;
	}
	activeLaunchSlots = Math.max(0, activeLaunchSlots - 1);
}

function resolveMaxLiveModelWorkers(): number | undefined {
	const override = Number.parseInt(
		process.env[MAX_LIVE_MODEL_WORKERS_ENV] ?? "",
		10,
	);
	if (!Number.isFinite(override) || override <= 0) return undefined;
	return Math.floor(override);
}

type AdaptiveLiveModelWorkerDecision =
	| "start"
	| "grow"
	| "hold"
	| "shrink"
	| "backoff_shrink";

interface AdaptiveLiveModelWorkerState {
	limit: number;
	recentExecutionMs: number[];
	baselineMs?: number;
	lastDecision: AdaptiveLiveModelWorkerDecision;
}

const adaptiveLiveModelWorkerStates = new Map<
	string,
	AdaptiveLiveModelWorkerState
>();

function adaptiveLiveModelWorkersEnabled(): boolean {
	return workflowExperimentalFlagEnabled(ADAPTIVE_LIVE_MODEL_WORKERS_ENV);
}

function adaptiveLiveModelWorkerCeiling(): number {
	return (
		resolveMaxLiveModelWorkers() ?? ADAPTIVE_LIVE_MODEL_WORKER_DEFAULT_CEILING
	);
}

function adaptiveLiveModelWorkerState(
	providerKey: string,
): AdaptiveLiveModelWorkerState {
	let state = adaptiveLiveModelWorkerStates.get(providerKey);
	if (!state) {
		state = {
			limit: ADAPTIVE_LIVE_MODEL_WORKER_FLOOR,
			recentExecutionMs: [],
			lastDecision: "start",
		};
		adaptiveLiveModelWorkerStates.set(providerKey, state);
	}
	return state;
}

function medianOfDurations(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[middle - 1]! + sorted[middle]!) / 2
		: sorted[middle]!;
}

function halveAdaptiveLiveModelWorkerLimit(
	state: AdaptiveLiveModelWorkerState,
	decision: AdaptiveLiveModelWorkerDecision,
): void {
	state.limit = Math.max(
		ADAPTIVE_LIVE_MODEL_WORKER_FLOOR,
		Math.floor(state.limit / 2),
	);
	state.lastDecision = decision;
}

export function observeLiveModelWorkerCompletion(
	providerKey: string,
	executionMs: number | null | undefined,
): void {
	if (!adaptiveLiveModelWorkersEnabled()) return;
	if (
		typeof executionMs !== "number" ||
		!Number.isFinite(executionMs) ||
		executionMs <= 0
	) {
		return;
	}
	const state = adaptiveLiveModelWorkerState(providerKey);
	state.recentExecutionMs.push(executionMs);
	if (state.recentExecutionMs.length > ADAPTIVE_LIVE_MODEL_WORKER_WINDOW_SIZE) {
		state.recentExecutionMs.shift();
	}
	if (state.baselineMs === undefined) {
		if (
			state.recentExecutionMs.length <
			ADAPTIVE_LIVE_MODEL_WORKER_BASELINE_SAMPLES
		) {
			return;
		}
		state.baselineMs = medianOfDurations(
			state.recentExecutionMs.slice(
				0,
				ADAPTIVE_LIVE_MODEL_WORKER_BASELINE_SAMPLES,
			),
		);
	}
	const recentMedianMs = medianOfDurations(state.recentExecutionMs);
	if (
		recentMedianMs >
		state.baselineMs * ADAPTIVE_LIVE_MODEL_WORKER_SHRINK_RATIO
	) {
		halveAdaptiveLiveModelWorkerLimit(state, "shrink");
		return;
	}
	if (
		recentMedianMs <
		state.baselineMs * ADAPTIVE_LIVE_MODEL_WORKER_GROW_RATIO
	) {
		state.limit = Math.min(
			adaptiveLiveModelWorkerCeiling(),
			state.limit + ADAPTIVE_LIVE_MODEL_WORKER_GROW_STEP,
		);
		state.lastDecision = "grow";
		return;
	}
	state.lastDecision = "hold";
}

function shrinkAdaptiveLiveModelWorkersForBackoff(providerKey: string): void {
	if (!adaptiveLiveModelWorkersEnabled()) return;
	halveAdaptiveLiveModelWorkerLimit(
		adaptiveLiveModelWorkerState(providerKey),
		"backoff_shrink",
	);
}

function resolveEffectiveMaxLiveModelWorkers(
	providerKey: string,
): number | undefined {
	const configured = resolveMaxLiveModelWorkers();
	if (!adaptiveLiveModelWorkersEnabled()) return configured;
	const adaptive = adaptiveLiveModelWorkerState(providerKey).limit;
	return configured === undefined ? adaptive : Math.min(configured, adaptive);
}

function liveModelWorkerKey(
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
): string {
	return `${run.cwd}\0${run.runId}\0${task.taskId}`;
}

function liveModelWorkerKeysForRun(run: WorkflowRunRecord): Set<string> {
	const keys = new Set<string>();
	for (const task of run.tasks) {
		if (isTerminalTaskStatus(task.status)) continue;
		if (!getSubagentHandle(task)) continue;
		keys.add(liveModelWorkerKey(run, task));
	}
	return keys;
}

function releaseLiveModelWorkerSlotForKey(key: string): void {
	activeLiveModelWorkerKeys.delete(key);
}

function releaseLiveModelWorkerSlotForTask(
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
): void {
	releaseLiveModelWorkerSlotForKey(liveModelWorkerKey(run, task));
}

function durableBarrierRecordForTask(
	task: WorkflowTaskRunRecord,
): WorkflowDurableLaunchBarrierRecord | undefined {
	const records = task.durableLaunchBarrier?.records ?? [];
	const handle = getSubagentHandle(task);
	return (
		(handle
			? records.find(
					(record) => record.backendAttemptId === handle.attemptId,
				)
			: undefined) ?? records.at(-1)
	);
}

function durableBarrierCancellationIdentity(
	api: DurableLaunchBarrierApi,
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	record: WorkflowDurableLaunchBarrierRecord,
): { cancellationId: string; reasonSha256: string } {
	return {
		cancellationId:
			record.cancellation?.cancellationId ??
			`workflow:${run.runId}:${task.taskId}:${record.attemptKey}`,
		reasonSha256:
			record.cancellation?.reasonSha256 ??
			api.durableLaunchBarrierDigest({
				schema: "pi-workflow-durable-launch-cancellation-v1",
				runId: run.runId,
				taskId: task.taskId,
				attemptKey: record.attemptKey,
				launchAuthoritySha256: record.launchAuthoritySha256,
			}),
	};
}

async function resolveDurableBarrierReleaseWithCancellation(
	api: DurableLaunchBarrierApi,
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	record: WorkflowDurableLaunchBarrierRecord,
	ready: DurableLaunchBarrierReady,
	releasePayloadSha256: string,
	signal?: AbortSignal,
): Promise<DurableLaunchBarrierResolution> {
	if (!signal)
		return api.resolveDurableLaunchBarrierV2Release(
			record.descriptor,
			ready,
			releasePayloadSha256,
		);
	const cancellation = durableBarrierCancellationIdentity(
		api,
		run,
		task,
		record,
	);
	if (signal.aborted)
		return api.revokeDurableLaunchBarrierV2(
			record.descriptor,
			cancellation,
		);
	let removeAbortListener = (): void => undefined;
	const revokeOnAbort = new Promise<DurableLaunchBarrierResolution>(
		(resolveCancellation, rejectCancellation) => {
			const onAbort = (): void => {
				void api
					.revokeDurableLaunchBarrierV2(
						record.descriptor,
						cancellation,
					)
					.then(resolveCancellation, rejectCancellation);
			};
			signal.addEventListener("abort", onAbort, { once: true });
			removeAbortListener = () =>
				signal.removeEventListener("abort", onAbort);
			if (signal.aborted) onAbort();
		},
	);
	const release = api.resolveDurableLaunchBarrierV2Release(
		record.descriptor,
		ready,
		releasePayloadSha256,
	);
	try {
		const resolution = await Promise.race([release, revokeOnAbort]);
		void release.catch(() => undefined);
		return resolution;
	} finally {
		removeAbortListener();
	}
}

async function decideDurableBarrierCancellation(
	cwd: string,
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	reason: string,
): Promise<WorkflowDurableLaunchBarrierRecord | undefined> {
	const record = durableBarrierRecordForTask(task);
	if (!record || record.phase === "cancellation_acknowledged") return record;
	const api = await loadSubagentApi();
	if (!hasDurableLaunchBarrierApi(api))
		throw new Error(
			"installed @agwab/pi-subagent does not support durable launch barrier v2 cancellation",
		);
	const { cancellationId, reasonSha256 } =
		durableBarrierCancellationIdentity(api, run, task, record);
	record.cancellation ??= {
		cancellationId,
		requestedAt: nowIso(),
		reasonSha256,
		decision: "revoked",
	};
	await writeRunRecordDurable(cwd, run);
	const resolution = await api.revokeDurableLaunchBarrierV2(
		record.descriptor,
		{ cancellationId, reasonSha256 },
	);
	record.decisionSha256 = resolution.decision.decisionSha256;
	if (resolution.outcome === "revoked") {
		record.phase = "revoked";
		record.releaseWinner = false;
		record.cancellation.decision = "revoked";
	} else {
		if (
			resolution.decision.kind !== "released" ||
			(record.backendRunId !== undefined &&
				resolution.decision.runId !== record.backendRunId) ||
			(record.backendAttemptId !== undefined &&
				resolution.decision.attemptId !== record.backendAttemptId)
		)
			throw new Error(
				"durable launch barrier release winner does not match the persisted backend attempt",
			);
		record.phase = "release_won_cancellation_pending";
		record.releaseWinner = true;
		record.cancellation.decision = "released";
	}
	task.statusDetail = "cancellation_pending";
	task.lastMessage = `${reason}; durable barrier decision is ${resolution.outcome}`;
	await writeRunRecordDurable(cwd, run);
	return record;
}

export async function acknowledgeSubagentTaskInterrupted(
	cwd: string,
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	reason: string,
): Promise<void> {
	const barrierRecord = await decideDurableBarrierCancellation(
		cwd,
		run,
		task,
		reason,
	);
	if (barrierRecord?.phase === "cancellation_acknowledged") {
		releaseLiveModelWorkerSlotForTask(run, task);
		return;
	}
	const acknowledgement = await interruptSubagentTask(task, reason);
	if (barrierRecord) {
		if (!acknowledgement)
			throw new Error(
				"durable launch barrier cancellation is pending backend handle recovery",
			);
		if (!barrierRecord.cancellation)
			throw new Error(
				"durable launch barrier cancellation evidence is unavailable",
			);
		barrierRecord.cancellation.interruptStatus =
			acknowledgement.interruptStatus;
		barrierRecord.cancellation.terminalAttemptId = acknowledgement.attemptId;
		barrierRecord.cancellation.terminalStatus = acknowledgement.status;
		barrierRecord.cancellation.terminalObservedAt = acknowledgement.observedAt;
		barrierRecord.phase = "cancellation_acknowledged";
		task.statusDetail = "cancellation_acknowledged";
		task.lastMessage = `exact backend attempt ${acknowledgement.attemptId} reached ${acknowledgement.status}`;
		await writeRunRecordDurable(cwd, run);
	}
	releaseLiveModelWorkerSlotForTask(run, task);
}

function reconcileLiveModelWorkerSlots(run: WorkflowRunRecord): void {
	for (const task of run.tasks) {
		if (!isTerminalTaskStatus(task.status)) continue;
		releaseLiveModelWorkerSlotForTask(run, task);
	}
}

function isLiveModelWorkerGateSaturated(
	run: WorkflowRunRecord,
	maxLiveModelWorkers: number,
): boolean {
	const liveKeys = liveModelWorkerKeysForRun(run);
	for (const key of activeLiveModelWorkerKeys) liveKeys.add(key);
	return liveKeys.size >= maxLiveModelWorkers;
}

type LiveModelWorkerSlotAdmission =
	| { kind: "acquired"; release: () => void }
	| { kind: "deferred"; message: string; retryAfterMs: number };

function liveModelWorkerWaitingMessage(maxLiveModelWorkers: number): string {
	return `waiting for global pi-subagent worker slot (${maxLiveModelWorkers} max)`;
}

function makeLiveModelWorkerSlotRelease(key: string): () => void {
	let released = false;
	return () => {
		if (released) return;
		released = true;
		releaseLiveModelWorkerSlotForKey(key);
	};
}

function tryAcquireLiveModelWorkerSlot(options: {
	run: WorkflowRunRecord;
	task: WorkflowTaskRunRecord;
	compiledTask?: CompiledTask;
}): LiveModelWorkerSlotAdmission {
	const maxLiveModelWorkers = resolveEffectiveMaxLiveModelWorkers(
		modelRateLimitBackoffKey(options.task, options.compiledTask),
	);
	if (maxLiveModelWorkers === undefined) {
		return { kind: "acquired", release: () => undefined };
	}
	reconcileLiveModelWorkerSlots(options.run);
	if (isLiveModelWorkerGateSaturated(options.run, maxLiveModelWorkers)) {
		return {
			kind: "deferred",
			message: liveModelWorkerWaitingMessage(maxLiveModelWorkers),
			retryAfterMs: 0,
		};
	}
	const key = liveModelWorkerKey(options.run, options.task);
	activeLiveModelWorkerKeys.add(key);
	return { kind: "acquired", release: makeLiveModelWorkerSlotRelease(key) };
}

function launchRampEnabled(): boolean {
	return workflowExperimentalFlagEnabled(EXPERIMENTAL_LAUNCH_RAMP_ENV);
}

function resolveLaunchSlotReleaseDelayMs(): number {
	if (launchSlotReleaseDelayMsForTests !== undefined) {
		return launchSlotReleaseDelayMsForTests;
	}
	const override = Number.parseInt(
		process.env[LAUNCH_SLOT_RELEASE_DELAY_MS_ENV] ?? "",
		10,
	);
	if (Number.isFinite(override)) return Math.max(0, Math.floor(override));
	return launchRampEnabled()
		? EXPERIMENTAL_LAUNCH_RAMP_RELEASE_DELAY_MS
		: DEFAULT_LAUNCH_SLOT_RELEASE_DELAY_MS;
}

interface AdaptiveLiveModelWorkerTelemetry {
	limit: number;
	lastDecision: AdaptiveLiveModelWorkerDecision;
	baselineMs?: number;
	samples: number;
}

interface LaunchControlTelemetry {
	maxConcurrentLaunches: number;
	maxLiveModelWorkers?: number;
	launchSlotReleaseDelayMs: number;
	experimentalLaunchRampEnabled?: boolean;
	adaptiveLiveModelWorkersEnabled?: boolean;
	adaptiveLiveModelWorkers?: Record<string, AdaptiveLiveModelWorkerTelemetry>;
}

function adaptiveLiveModelWorkerTelemetry(): Record<
	string,
	AdaptiveLiveModelWorkerTelemetry
> {
	const providers: Record<string, AdaptiveLiveModelWorkerTelemetry> = {};
	for (const [key, state] of adaptiveLiveModelWorkerStates) {
		providers[key] = {
			limit: state.limit,
			lastDecision: state.lastDecision,
			...(state.baselineMs === undefined
				? {}
				: { baselineMs: state.baselineMs }),
			samples: state.recentExecutionMs.length,
		};
	}
	return providers;
}

function launchControlTelemetry(): LaunchControlTelemetry {
	const maxLiveModelWorkers = resolveMaxLiveModelWorkers();
	return {
		maxConcurrentLaunches: resolveMaxConcurrentLaunches(),
		...(maxLiveModelWorkers === undefined ? {} : { maxLiveModelWorkers }),
		launchSlotReleaseDelayMs: resolveLaunchSlotReleaseDelayMs(),
		...(launchRampEnabled() ? { experimentalLaunchRampEnabled: true } : {}),
		...(adaptiveLiveModelWorkersEnabled()
			? {
					adaptiveLiveModelWorkersEnabled: true,
					adaptiveLiveModelWorkers: adaptiveLiveModelWorkerTelemetry(),
				}
			: {}),
	};
}

export function resolveLaunchControlTelemetryForTests(): LaunchControlTelemetry {
	return launchControlTelemetry();
}

function releaseLaunchSlotAfterDelay(
	delayMs: number,
	release: () => void,
): void {
	if (delayMs <= 0) {
		release();
		return;
	}
	const releaseGeneration = launchSlotReleaseGeneration;
	setTimeout(() => {
		if (releaseGeneration !== launchSlotReleaseGeneration) return;
		release();
	}, delayMs);
}

async function runWithLaunchSlot<T>(
	action: () => Promise<T>,
	onAcquired?: () => void,
	signal?: AbortSignal,
): Promise<T> {
	const release = await acquireLaunchSlot(signal);
	if (signal?.aborted) {
		release();
		throw abortSignalError(signal);
	}
	onAcquired?.();
	let holdAfterReturn = false;
	try {
		launchSlotAcquiredHookForTests?.();
		throwIfAborted(signal);
		const result = await action();
		holdAfterReturn = true;
		return result;
	} finally {
		releaseLaunchSlotAfterDelay(
			holdAfterReturn ? resolveLaunchSlotReleaseDelayMs() : 0,
			release,
		);
	}
}

function transientRetryJitterMs(): number {
	if (transientRetryJitterForTests) return transientRetryJitterForTests();
	return (
		MIN_TRANSIENT_RETRY_JITTER_MS +
		Math.floor(
			Math.random() *
				(MAX_TRANSIENT_RETRY_JITTER_MS - MIN_TRANSIENT_RETRY_JITTER_MS + 1),
		)
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

type UsageMetricKey = keyof WorkflowTaskUsageValues;
const USAGE_METRIC_KEYS: UsageMetricKey[] = [
	"inputTokens",
	"outputTokens",
	"totalTokens",
	"cachedInputTokens",
	"cacheCreationInputTokens",
	"cacheReadInputTokens",
	"reasoningTokens",
	"costUsd",
];
const USAGE_FIELD_ALIASES: Record<
	UsageMetricKey,
	readonly (readonly string[])[]
> = {
	inputTokens: [
		["inputTokens"],
		["input_tokens"],
		["input"],
		["promptTokens"],
		["prompt_tokens"],
	],
	outputTokens: [
		["outputTokens"],
		["output_tokens"],
		["output"],
		["completionTokens"],
		["completion_tokens"],
	],
	totalTokens: [["totalTokens"], ["total_tokens"], ["tokens"], ["total"]],
	cachedInputTokens: [
		["cachedInputTokens"],
		["cached_input_tokens"],
		["prompt_tokens_details", "cached_tokens"],
		["input_tokens_details", "cached_tokens"],
	],
	cacheCreationInputTokens: [
		["cacheCreationInputTokens"],
		["cacheCreationTokens"],
		["cacheWriteTokens"],
		["cache_creation_input_tokens"],
		["cache_write_input_tokens"],
		["cacheWrite"],
		["cache_write"],
	],
	cacheReadInputTokens: [
		["cacheReadInputTokens"],
		["cacheReadTokens"],
		["cache_read_input_tokens"],
		["cacheRead"],
		["cache_read"],
	],
	reasoningTokens: [
		["reasoningTokens"],
		["reasoning_tokens"],
		["reasoning"],
		["completion_tokens_details", "reasoning_tokens"],
		["output_tokens_details", "reasoning_tokens"],
	],
	costUsd: [
		["costUsd"],
		["cost_usd"],
		["totalCostUsd"],
		["total_cost_usd"],
		["estimatedCostUsd"],
		["estimated_cost_usd"],
		["cost", "total"],
		["cost", "totalUsd"],
		["cost", "total_usd"],
	],
};

type TimingAggregateKey =
	| "launchWaitMs"
	| "launchDurationMs"
	| "executionMs"
	| "totalMs";
const TIMING_AGGREGATE_KEYS: TimingAggregateKey[] = [
	"launchWaitMs",
	"launchDurationMs",
	"executionMs",
	"totalMs",
];

type TimingTelemetryKey =
	| "refreshReconcileMs"
	| "refreshStatusPollMs"
	| "terminalOutputCopyMs"
	| "terminalStderrCopyMs"
	| "terminalOutputBytes"
	| "terminalStderrBytes"
	| "terminalArtifactMaterializeMs"
	| "terminalArtifactBundleWriteMs";

type TimingTelemetryValues = Partial<Record<TimingTelemetryKey, number>>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwnValue(record: object, key: string): boolean {
	return Object.hasOwn(record, key);
}

function valueAtPath(
	record: Record<string, unknown>,
	path: readonly string[],
): { found: boolean; value: unknown } {
	let current: unknown = record;
	for (const part of path) {
		if (!isPlainRecord(current) || !hasOwnValue(current, part)) {
			return { found: false, value: undefined };
		}
		current = current[part];
	}
	return { found: true, value: current };
}

function usageNumberOrNull(value: unknown): number | null | undefined {
	if (value === null) return null;
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
		return value;
	}
	return undefined;
}

export function normalizedUsageValues(raw: unknown): WorkflowTaskUsageValues {
	const record = isPlainRecord(raw) ? raw : undefined;
	const values: WorkflowTaskUsageValues = {};
	if (!record) return values;
	for (const key of USAGE_METRIC_KEYS) {
		for (const path of USAGE_FIELD_ALIASES[key]) {
			const candidate = valueAtPath(record, path);
			if (!candidate.found) continue;
			const value = usageNumberOrNull(candidate.value);
			if (value === undefined) continue;
			values[key] = value;
			break;
		}
	}
	return values;
}

function firstStringValue(
	records: Array<Record<string, unknown> | undefined>,
	keys: string[],
): string | undefined {
	for (const record of records) {
		if (!record) continue;
		for (const key of keys) {
			const value = record[key];
			if (typeof value === "string" && value.trim()) return value;
		}
	}
	return undefined;
}

function metadataRecord(value: unknown): Record<string, unknown> | undefined {
	if (!isPlainRecord(value)) return undefined;
	return isPlainRecord(value.metadata) ? value.metadata : undefined;
}

function usageObservation(
	subagentResult: Record<string, unknown> | undefined,
	snapshot: SubagentRunStatusSnapshot,
): { source: string; raw: unknown; present: true } | undefined {
	const resultMetadata = metadataRecord(subagentResult);
	if (resultMetadata && hasOwnValue(resultMetadata, "usage")) {
		return {
			source: "subagent-result-metadata",
			raw: resultMetadata.usage,
			present: true,
		};
	}
	const snapshotMetadata = isPlainRecord(snapshot.metadata)
		? snapshot.metadata
		: undefined;
	if (snapshotMetadata && hasOwnValue(snapshotMetadata, "usage")) {
		return {
			source: "subagent-snapshot-metadata",
			raw: snapshotMetadata.usage,
			present: true,
		};
	}
	if (subagentResult && hasOwnValue(subagentResult, "usage")) {
		return {
			source: "subagent-result",
			raw: subagentResult.usage,
			present: true,
		};
	}
	const snapshotRecord = snapshot as unknown as Record<string, unknown>;
	if (hasOwnValue(snapshotRecord, "usage")) {
		return {
			source: "subagent-snapshot",
			raw: snapshotRecord.usage,
			present: true,
		};
	}
	return undefined;
}

function buildTaskUsageAttempt(options: {
	task: WorkflowTaskRunRecord;
	snapshot: SubagentRunStatusSnapshot;
	subagentResult?: Record<string, unknown>;
	capturedAt: string;
}): WorkflowTaskUsageAttemptRecord {
	const resultMetadata = metadataRecord(options.subagentResult);
	const snapshotMetadata = isPlainRecord(options.snapshot.metadata)
		? options.snapshot.metadata
		: undefined;
	const resultRecord = options.subagentResult;
	const snapshotRecord = options.snapshot as unknown as Record<string, unknown>;
	const records = [
		resultMetadata,
		snapshotMetadata,
		resultRecord,
		snapshotRecord,
	];
	const observed = usageObservation(options.subagentResult, options.snapshot);
	const raw = observed?.raw;
	const unavailable = !observed || raw === null || raw === undefined;
	const provider = firstStringValue(records, ["provider"]);
	const model =
		firstStringValue(records, ["model"]) ?? options.task.runtime.model;
	const thinking =
		firstStringValue(records, [
			"thinking",
			"thinkingLevel",
			"reasoningLevel",
		]) ??
		options.task.runtime.thinkingResolution?.resolved ??
		options.task.runtime.thinking;
	return {
		source: observed?.source ?? "subagent-usage-unavailable",
		capturedAt: options.capturedAt,
		backendRunId: options.snapshot.runId,
		backendAttemptId: options.snapshot.attemptId,
		...(provider === undefined ? {} : { provider }),
		...(model === undefined ? {} : { model }),
		...(thinking === undefined ? {} : { thinking }),
		...(unavailable ? { unavailable: true as const } : {}),
		...(observed?.present && raw !== undefined ? { raw } : {}),
		...normalizedUsageValues(raw),
	};
}

function usageAttemptKey(attempt: WorkflowTaskUsageAttemptRecord): string {
	return `${attempt.backendRunId ?? ""}\0${attempt.backendAttemptId ?? ""}`;
}

function upsertUsageAttempt(
	attempts: WorkflowTaskUsageAttemptRecord[],
	attempt: WorkflowTaskUsageAttemptRecord,
): WorkflowTaskUsageAttemptRecord[] {
	const key = usageAttemptKey(attempt);
	const index = attempts.findIndex(
		(candidate) => usageAttemptKey(candidate) === key,
	);
	if (index < 0) return [...attempts, attempt];
	return attempts.map((candidate, candidateIndex) =>
		candidateIndex === index ? attempt : candidate,
	);
}

function aggregateUsageAttempts(attempts: WorkflowTaskUsageAttemptRecord[]): {
	values: WorkflowTaskUsageValues;
	incomplete: boolean;
} {
	const values: WorkflowTaskUsageValues = {};
	let incomplete = attempts.some((attempt) => attempt.unavailable === true);
	for (const key of USAGE_METRIC_KEYS) {
		const anyPresent = attempts.some((attempt) => hasOwnValue(attempt, key));
		if (!anyPresent) continue;
		let total = 0;
		let complete = true;
		for (const attempt of attempts) {
			if (!hasOwnValue(attempt, key)) {
				complete = false;
				break;
			}
			const value = attempt[key];
			if (typeof value !== "number") {
				complete = false;
				break;
			}
			total += value;
		}
		values[key] = complete ? total : null;
		if (!complete) incomplete = true;
	}
	return { values, incomplete };
}

function latestUsageString(
	attempts: WorkflowTaskUsageAttemptRecord[],
	key: "provider" | "model" | "thinking",
): string | undefined {
	for (let index = attempts.length - 1; index >= 0; index -= 1) {
		const value = attempts[index]?.[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

function recordTaskUsageObservation(options: {
	task: WorkflowTaskRunRecord;
	snapshot: SubagentRunStatusSnapshot;
	subagentResult?: Record<string, unknown>;
	capturedAt: string;
}): void {
	const attempt = buildTaskUsageAttempt(options);
	const attempts = upsertUsageAttempt(
		options.task.usage?.attempts ?? [],
		attempt,
	);
	const aggregate = aggregateUsageAttempts(attempts);
	const usage: WorkflowTaskUsageRecord = {
		source: "pi-subagent",
		capturedAt: options.capturedAt,
		...(latestUsageString(attempts, "provider") === undefined
			? {}
			: { provider: latestUsageString(attempts, "provider") }),
		...(latestUsageString(attempts, "model") === undefined
			? {}
			: { model: latestUsageString(attempts, "model") }),
		...(latestUsageString(attempts, "thinking") === undefined
			? {}
			: { thinking: latestUsageString(attempts, "thinking") }),
		...(aggregate.incomplete ? { incomplete: true } : {}),
		...aggregate.values,
		aggregate: {
			attempts: attempts.length,
			...(aggregate.incomplete ? { incomplete: true } : {}),
			...aggregate.values,
		},
		attempts,
	};
	options.task.usage = usage;
}

interface DynamicTaskToolResultBudgetConfiguration {
	configured: boolean;
	source: WorkflowToolResultBudgetConfigurationSource;
	maxTotalChars?: number;
}

function toolResultBudgetObservation(
	subagentResult: Record<string, unknown> | undefined,
	snapshot: SubagentRunStatusSnapshot,
): { source: string; raw: unknown } | undefined {
	const resultMetadata = metadataRecord(subagentResult);
	if (resultMetadata && hasOwnValue(resultMetadata, "toolResultBudget")) {
		return {
			source: "subagent-result-metadata",
			raw: resultMetadata.toolResultBudget,
		};
	}
	const snapshotMetadata = isPlainRecord(snapshot.metadata)
		? snapshot.metadata
		: undefined;
	if (snapshotMetadata && hasOwnValue(snapshotMetadata, "toolResultBudget")) {
		return {
			source: "subagent-snapshot-metadata",
			raw: snapshotMetadata.toolResultBudget,
		};
	}
	if (subagentResult && hasOwnValue(subagentResult, "toolResultBudget")) {
		return {
			source: "subagent-result",
			raw: subagentResult.toolResultBudget,
		};
	}
	const snapshotRecord = snapshot as unknown as Record<string, unknown>;
	if (hasOwnValue(snapshotRecord, "toolResultBudget")) {
		return {
			source: "subagent-snapshot",
			raw: snapshotRecord.toolResultBudget,
		};
	}
	return undefined;
}

function firstBooleanValue(
	records: Array<Record<string, unknown> | undefined>,
	key: string,
): boolean | undefined {
	for (const record of records) {
		if (!record || !hasOwnValue(record, key)) continue;
		const value = record[key];
		if (typeof value === "boolean") return value;
	}
	return undefined;
}

function buildTaskToolResultBudgetAttempt(options: {
	task: WorkflowTaskRunRecord;
	snapshot: SubagentRunStatusSnapshot;
	subagentResult?: Record<string, unknown>;
	capturedAt: string;
}): WorkflowTaskToolResultBudgetAttemptRecord {
	const resultMetadata = metadataRecord(options.subagentResult);
	const snapshotMetadata = isPlainRecord(options.snapshot.metadata)
		? options.snapshot.metadata
		: undefined;
	const resultRecord = options.subagentResult;
	const snapshotRecord = options.snapshot as unknown as Record<string, unknown>;
	const metadataRecords = [
		resultMetadata,
		snapshotMetadata,
		resultRecord,
		snapshotRecord,
	];
	const observed = toolResultBudgetObservation(
		options.subagentResult,
		options.snapshot,
	);
	const reported = observed !== undefined && isPlainRecord(observed.raw);
	const contextLengthExceeded = firstBooleanValue(
		metadataRecords,
		"contextLengthExceeded",
	);
	const contextOverflowRecovered = firstBooleanValue(
		metadataRecords,
		"contextOverflowRecovered",
	);
	const contextRecovered = firstBooleanValue(
		metadataRecords,
		"contextRecovered",
	);
	return {
		source: observed?.source ?? "subagent-tool-result-budget-unavailable",
		capturedAt: options.capturedAt,
		backendRunId: options.snapshot.runId,
		backendAttemptId: options.snapshot.attemptId,
		terminal: true,
		...(reported
			? { reported: true as const }
			: { unavailable: true as const }),
		...normalizedToolResultBudgetValues(observed?.raw),
		...(contextLengthExceeded === undefined ? {} : { contextLengthExceeded }),
		...(contextOverflowRecovered === undefined
			? {}
			: { contextOverflowRecovered }),
		...(contextRecovered === undefined ? {} : { contextRecovered }),
	};
}

function toolResultBudgetAttemptKey(
	attempt: WorkflowTaskToolResultBudgetAttemptRecord,
): string {
	return `${attempt.backendRunId ?? ""}\0${attempt.backendAttemptId ?? ""}`;
}

function configuredAttemptFields(
	configuration: WorkflowTaskToolResultBudgetConfigurationRecord,
): Pick<
	WorkflowTaskToolResultBudgetAttemptRecord,
	"configuredAt" | "configured" | "configurationSource"
> &
	Partial<
		Pick<WorkflowTaskToolResultBudgetAttemptRecord, "configuredMaxTotalChars">
	> {
	return {
		configuredAt: configuration.configuredAt,
		configured: configuration.configured,
		configurationSource: configuration.configurationSource,
		...(configuration.configuredMaxTotalChars === undefined
			? {}
			: {
					configuredMaxTotalChars: configuration.configuredMaxTotalChars,
				}),
	};
}

function normalizedToolResultBudgetAttempt(
	attempt: WorkflowTaskToolResultBudgetAttemptRecord,
): WorkflowTaskToolResultBudgetAttemptRecord {
	const normalized = { ...attempt };
	if (normalized.reported === true) delete normalized.unavailable;
	if (normalized.configured === false && normalized.reported !== true) {
		delete normalized.unavailable;
		normalized.source = "pi-workflow-budget-disabled";
	}
	return normalized;
}

function upsertToolResultBudgetAttempt(
	attempts: WorkflowTaskToolResultBudgetAttemptRecord[],
	attempt: WorkflowTaskToolResultBudgetAttemptRecord,
): WorkflowTaskToolResultBudgetAttemptRecord[] {
	const key = toolResultBudgetAttemptKey(attempt);
	const index = attempts.findIndex(
		(candidate) => toolResultBudgetAttemptKey(candidate) === key,
	);
	if (index < 0) {
		return [...attempts, normalizedToolResultBudgetAttempt(attempt)];
	}
	return attempts.map((candidate, candidateIndex) => {
		if (candidateIndex !== index) return candidate;
		if (attempt.terminal !== true) {
			return normalizedToolResultBudgetAttempt({ ...candidate, ...attempt });
		}
		const configuration: Partial<WorkflowTaskToolResultBudgetAttemptRecord> = {
			...(candidate.configuredAt === undefined
				? {}
				: { configuredAt: candidate.configuredAt }),
			...(candidate.configured === undefined
				? {}
				: { configured: candidate.configured }),
			...(candidate.configurationSource === undefined
				? {}
				: { configurationSource: candidate.configurationSource }),
			...(candidate.configuredMaxTotalChars === undefined
				? {}
				: {
						configuredMaxTotalChars: candidate.configuredMaxTotalChars,
					}),
		};
		return normalizedToolResultBudgetAttempt({
			...configuration,
			...attempt,
		});
	});
}

function writeTaskToolResultBudgetRecord(options: {
	task: WorkflowTaskRunRecord;
	attempts: WorkflowTaskToolResultBudgetAttemptRecord[];
	capturedAt: string;
	pendingConfiguration?: WorkflowTaskToolResultBudgetConfigurationRecord;
}): void {
	const aggregate = summarizeToolResultBudgetAttempts(options.attempts);
	const record: WorkflowTaskToolResultBudgetRecord = {
		source: "pi-subagent",
		capturedAt: options.capturedAt,
		...(aggregate.incomplete ? { incomplete: true } : {}),
		...(options.pendingConfiguration === undefined
			? {}
			: { pendingConfiguration: options.pendingConfiguration }),
		aggregate,
		attempts: options.attempts,
	};
	options.task.toolResultBudget = record;
}

function updateTaskToolResultBudget(options: {
	task: WorkflowTaskRunRecord;
	attempt: WorkflowTaskToolResultBudgetAttemptRecord;
	clearPendingConfiguration?: boolean;
}): void {
	const attempts = upsertToolResultBudgetAttempt(
		options.task.toolResultBudget?.attempts ?? [],
		options.attempt,
	);
	writeTaskToolResultBudgetRecord({
		task: options.task,
		attempts,
		capturedAt: options.attempt.capturedAt,
		...(options.clearPendingConfiguration
			? {}
			: {
					pendingConfiguration:
						options.task.toolResultBudget?.pendingConfiguration,
				}),
	});
}

function recordTaskToolResultBudgetPendingConfiguration(options: {
	task: WorkflowTaskRunRecord;
	configuration: DynamicTaskToolResultBudgetConfiguration;
	capturedAt: string;
}): void {
	const pendingConfiguration: WorkflowTaskToolResultBudgetConfigurationRecord =
		{
			configuredAt: options.capturedAt,
			configured: options.configuration.configured,
			configurationSource: options.configuration.source,
			...(options.configuration.maxTotalChars === undefined
				? {}
				: { configuredMaxTotalChars: options.configuration.maxTotalChars }),
		};
	writeTaskToolResultBudgetRecord({
		task: options.task,
		attempts: options.task.toolResultBudget?.attempts ?? [],
		capturedAt: options.capturedAt,
		pendingConfiguration,
	});
}

function bindTaskToolResultBudgetPendingConfiguration(options: {
	task: WorkflowTaskRunRecord;
	backendRunId: string;
	backendAttemptId: string;
	capturedAt: string;
}): void {
	const pendingConfiguration =
		options.task.toolResultBudget?.pendingConfiguration;
	if (!pendingConfiguration) return;
	updateTaskToolResultBudget({
		task: options.task,
		attempt: {
			source: "pi-workflow-launch",
			capturedAt: options.capturedAt,
			backendRunId: options.backendRunId,
			backendAttemptId: options.backendAttemptId,
			...configuredAttemptFields(pendingConfiguration),
		},
		clearPendingConfiguration: true,
	});
}

function clearTaskToolResultBudgetPendingConfiguration(
	task: WorkflowTaskRunRecord,
): void {
	const record = task.toolResultBudget;
	if (!record?.pendingConfiguration) return;
	if (record.attempts.length === 0) {
		delete task.toolResultBudget;
		return;
	}
	writeTaskToolResultBudgetRecord({
		task,
		attempts: record.attempts,
		capturedAt: nowIso(),
	});
}

function recordTaskToolResultBudgetObservation(options: {
	task: WorkflowTaskRunRecord;
	snapshot: SubagentRunStatusSnapshot;
	subagentResult?: Record<string, unknown>;
	capturedAt: string;
}): void {
	const observed = toolResultBudgetObservation(
		options.subagentResult,
		options.snapshot,
	);
	if (
		!options.task.dynamicGenerated &&
		options.task.toolResultBudget === undefined &&
		observed === undefined
	) {
		return;
	}
	const pendingConfiguration =
		options.task.toolResultBudget?.pendingConfiguration;
	const attempt = buildTaskToolResultBudgetAttempt(options);
	updateTaskToolResultBudget({
		task: options.task,
		attempt:
			pendingConfiguration === undefined
				? attempt
				: {
						...configuredAttemptFields(pendingConfiguration),
						...attempt,
					},
		clearPendingConfiguration: pendingConfiguration !== undefined,
	});
}

function isoTimestampMs(timestamp: string | undefined): number | undefined {
	if (!timestamp) return undefined;
	const parsed = Date.parse(timestamp);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function durationBetween(
	startedAt: string | undefined,
	completedAt: string | undefined,
): number | undefined {
	const startedAtMs = isoTimestampMs(startedAt);
	const completedAtMs = isoTimestampMs(completedAt);
	if (startedAtMs === undefined || completedAtMs === undefined)
		return undefined;
	return Math.max(0, completedAtMs - startedAtMs);
}

function durationNumber(value: unknown): number | null | undefined {
	if (value === null) return null;
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
		return value;
	}
	return undefined;
}

function elapsedSince(startedAtMs: number): number {
	return Math.max(0, Date.now() - startedAtMs);
}

function recordTaskTimingTelemetry(
	task: WorkflowTaskRunRecord,
	values: TimingTelemetryValues,
): void {
	const sanitized = Object.fromEntries(
		Object.entries(values).filter(
			(entry): entry is [TimingTelemetryKey, number] =>
				typeof entry[1] === "number" &&
				Number.isFinite(entry[1]) &&
				entry[1] >= 0,
		),
	) as TimingTelemetryValues;
	if (Object.keys(sanitized).length === 0) return;
	task.timing = {
		...(task.timing ?? {
			source: "pi-workflow" as const,
			capturedAt: nowIso(),
		}),
		source: "pi-workflow",
		capturedAt: nowIso(),
		...sanitized,
	};
}

function taskTimingTelemetry(
	timing: WorkflowTaskTimingRecord | undefined,
): TimingTelemetryValues {
	if (!timing) return {};
	return {
		...(timing.refreshReconcileMs === undefined
			? {}
			: { refreshReconcileMs: timing.refreshReconcileMs }),
		...(timing.refreshStatusPollMs === undefined
			? {}
			: { refreshStatusPollMs: timing.refreshStatusPollMs }),
		...(timing.terminalOutputCopyMs === undefined
			? {}
			: { terminalOutputCopyMs: timing.terminalOutputCopyMs }),
		...(timing.terminalStderrCopyMs === undefined
			? {}
			: { terminalStderrCopyMs: timing.terminalStderrCopyMs }),
		...(timing.terminalOutputBytes === undefined
			? {}
			: { terminalOutputBytes: timing.terminalOutputBytes }),
		...(timing.terminalStderrBytes === undefined
			? {}
			: { terminalStderrBytes: timing.terminalStderrBytes }),
		...(timing.terminalArtifactMaterializeMs === undefined
			? {}
			: {
					terminalArtifactMaterializeMs: timing.terminalArtifactMaterializeMs,
				}),
		...(timing.terminalArtifactBundleWriteMs === undefined
			? {}
			: {
					terminalArtifactBundleWriteMs: timing.terminalArtifactBundleWriteMs,
				}),
	};
}

function recordTaskLaunchTiming(
	task: WorkflowTaskRunRecord,
	observation: {
		launchQueuedAt: string;
		launchStartedAt?: string;
		launchCompletedAt?: string;
		waitingForGlobalWorkerSlot?: boolean;
	},
): void {
	const capturedAt = observation.launchCompletedAt ?? nowIso();
	const launchWaitMs = durationBetween(
		observation.launchQueuedAt,
		observation.launchStartedAt,
	);
	const launchDurationMs = durationBetween(
		observation.launchStartedAt,
		observation.launchCompletedAt,
	);
	const launchControls = launchControlTelemetry();
	task.timing = {
		source: "pi-workflow",
		capturedAt,
		launchQueuedAt: observation.launchQueuedAt,
		...(observation.launchStartedAt === undefined
			? {}
			: { launchStartedAt: observation.launchStartedAt }),
		...(observation.launchCompletedAt === undefined
			? {}
			: { launchCompletedAt: observation.launchCompletedAt }),
		...(launchWaitMs === undefined ? {} : { launchWaitMs }),
		...(launchDurationMs === undefined ? {} : { launchDurationMs }),
		...(observation.waitingForGlobalWorkerSlot ||
		task.timing?.waiting_for_global_worker_slot
			? { waiting_for_global_worker_slot: true }
			: {}),
		launchSlotReleaseDelayMs: launchControls.launchSlotReleaseDelayMs,
		maxConcurrentLaunches: launchControls.maxConcurrentLaunches,
		...(launchControls.maxLiveModelWorkers === undefined
			? {}
			: { maxLiveModelWorkers: launchControls.maxLiveModelWorkers }),
		...(launchControls.experimentalLaunchRampEnabled
			? { experimentalLaunchRampEnabled: true }
			: {}),
		...(launchControls.adaptiveLiveModelWorkersEnabled
			? {
					adaptiveLiveModelWorkersEnabled: true,
					...(launchControls.adaptiveLiveModelWorkers === undefined
						? {}
						: {
								adaptiveLiveModelWorkers:
									launchControls.adaptiveLiveModelWorkers,
							}),
				}
			: {}),
		...(task.timing?.aggregate === undefined
			? {}
			: { aggregate: task.timing.aggregate }),
		...(task.timing?.attempts === undefined
			? {}
			: { attempts: task.timing.attempts }),
	};
}

function buildTaskTimingAttempt(options: {
	task: WorkflowTaskRunRecord;
	snapshot: SubagentRunStatusSnapshot;
	subagentResult?: Record<string, unknown>;
	startedAt?: string;
	completedAt?: string;
	capturedAt: string;
}): WorkflowTaskTimingAttemptRecord {
	const resultDuration = options.subagentResult?.durationMs;
	let executionMs = durationNumber(
		resultDuration === undefined ? options.snapshot.durationMs : resultDuration,
	);
	if (executionMs === undefined || executionMs === null) {
		executionMs =
			durationBetween(options.startedAt, options.completedAt) ?? executionMs;
	}
	const totalMs = durationBetween(
		options.task.startedAt ?? options.task.timing?.launchQueuedAt,
		options.completedAt,
	);
	return {
		source: "pi-subagent",
		capturedAt: options.capturedAt,
		backendRunId: options.snapshot.runId,
		backendAttemptId: options.snapshot.attemptId,
		...(options.task.timing?.launchQueuedAt === undefined
			? {}
			: { launchQueuedAt: options.task.timing.launchQueuedAt }),
		...(options.task.timing?.launchStartedAt === undefined
			? {}
			: { launchStartedAt: options.task.timing.launchStartedAt }),
		...(options.task.timing?.launchCompletedAt === undefined
			? {}
			: { launchCompletedAt: options.task.timing.launchCompletedAt }),
		...(options.task.timing?.launchWaitMs === undefined
			? {}
			: { launchWaitMs: options.task.timing.launchWaitMs }),
		...(options.task.timing?.launchDurationMs === undefined
			? {}
			: { launchDurationMs: options.task.timing.launchDurationMs }),
		...(options.task.timing?.waiting_for_global_worker_slot === undefined
			? {}
			: {
					waiting_for_global_worker_slot:
						options.task.timing.waiting_for_global_worker_slot,
				}),
		...(options.startedAt === undefined
			? {}
			: { executionStartedAt: options.startedAt }),
		...(options.completedAt === undefined
			? {}
			: { executionCompletedAt: options.completedAt }),
		...(executionMs === undefined ? {} : { executionMs }),
		...(totalMs === undefined ? {} : { totalMs }),
	};
}

function timingAttemptKey(attempt: WorkflowTaskTimingAttemptRecord): string {
	return `${attempt.backendRunId ?? ""}\0${attempt.backendAttemptId ?? ""}`;
}

function upsertTimingAttempt(
	attempts: WorkflowTaskTimingAttemptRecord[],
	attempt: WorkflowTaskTimingAttemptRecord,
): WorkflowTaskTimingAttemptRecord[] {
	const key = timingAttemptKey(attempt);
	const index = attempts.findIndex(
		(candidate) => timingAttemptKey(candidate) === key,
	);
	if (index < 0) return [...attempts, attempt];
	return attempts.map((candidate, candidateIndex) =>
		candidateIndex === index ? attempt : candidate,
	);
}

function aggregateTimingAttempts(
	attempts: WorkflowTaskTimingAttemptRecord[],
): NonNullable<WorkflowTaskTimingRecord["aggregate"]> {
	const aggregate: NonNullable<WorkflowTaskTimingRecord["aggregate"]> = {
		attempts: attempts.length,
	};
	let incomplete = false;
	for (const key of TIMING_AGGREGATE_KEYS) {
		const anyPresent = attempts.some((attempt) => hasOwnValue(attempt, key));
		if (!anyPresent) continue;
		let total = 0;
		let complete = true;
		for (const attempt of attempts) {
			if (!hasOwnValue(attempt, key)) {
				complete = false;
				break;
			}
			const value = attempt[key];
			if (typeof value !== "number") {
				complete = false;
				break;
			}
			total += value;
		}
		aggregate[key] = complete ? total : null;
		if (!complete) incomplete = true;
	}
	if (incomplete) aggregate.incomplete = true;
	return aggregate;
}

function recordTaskTerminalTiming(options: {
	task: WorkflowTaskRunRecord;
	snapshot: SubagentRunStatusSnapshot;
	subagentResult?: Record<string, unknown>;
	startedAt?: string;
	completedAt?: string;
	capturedAt: string;
}): void {
	const attempt = buildTaskTimingAttempt(options);
	const attempts = upsertTimingAttempt(
		options.task.timing?.attempts ?? [],
		attempt,
	);
	options.task.timing = {
		source: "pi-workflow",
		capturedAt: options.capturedAt,
		...(attempt.launchQueuedAt === undefined
			? {}
			: { launchQueuedAt: attempt.launchQueuedAt }),
		...(attempt.launchStartedAt === undefined
			? {}
			: { launchStartedAt: attempt.launchStartedAt }),
		...(attempt.launchCompletedAt === undefined
			? {}
			: { launchCompletedAt: attempt.launchCompletedAt }),
		...(attempt.launchWaitMs === undefined
			? {}
			: { launchWaitMs: attempt.launchWaitMs }),
		...(attempt.launchDurationMs === undefined
			? {}
			: { launchDurationMs: attempt.launchDurationMs }),
		...(options.task.timing?.launchSlotReleaseDelayMs === undefined
			? {}
			: {
					launchSlotReleaseDelayMs:
						options.task.timing.launchSlotReleaseDelayMs,
				}),
		...(options.task.timing?.maxConcurrentLaunches === undefined
			? {}
			: { maxConcurrentLaunches: options.task.timing.maxConcurrentLaunches }),
		...(options.task.timing?.maxLiveModelWorkers === undefined
			? {}
			: { maxLiveModelWorkers: options.task.timing.maxLiveModelWorkers }),
		...(options.task.timing?.experimentalLaunchRampEnabled
			? { experimentalLaunchRampEnabled: true }
			: {}),
		...(options.task.timing?.adaptiveLiveModelWorkersEnabled
			? { adaptiveLiveModelWorkersEnabled: true }
			: {}),
		...(options.task.timing?.adaptiveLiveModelWorkers === undefined
			? {}
			: {
					adaptiveLiveModelWorkers:
						options.task.timing.adaptiveLiveModelWorkers,
				}),
		...taskTimingTelemetry(options.task.timing),
		...(attempt.executionStartedAt === undefined
			? {}
			: { executionStartedAt: attempt.executionStartedAt }),
		...(attempt.executionCompletedAt === undefined
			? {}
			: { executionCompletedAt: attempt.executionCompletedAt }),
		...(attempt.executionMs === undefined
			? {}
			: { executionMs: attempt.executionMs }),
		...(attempt.totalMs === undefined ? {} : { totalMs: attempt.totalMs }),
		aggregate: aggregateTimingAttempts(attempts),
		attempts,
	};
}

function recordTerminalTaskObservability(options: {
	task: WorkflowTaskRunRecord;
	snapshot: SubagentRunStatusSnapshot;
	subagentResult?: Record<string, unknown>;
	startedAt?: string;
	completedAt?: string;
}): void {
	const capturedAt = nowIso();
	recordTaskUsageObservation({ ...options, capturedAt });
	recordTaskToolResultBudgetObservation({ ...options, capturedAt });
	recordTaskTerminalTiming({ ...options, capturedAt });
}

export function setSubagentLaunchControlsForTests(options?: {
	releaseDelayMs?: number;
	retryJitterMs?: number | (() => number);
	onLaunchSlotAcquired?: () => void;
	beforeRunSubagent?: () => void | Promise<void>;
	afterLaunchAuthorityRegistered?: () => void | Promise<void>;
	beforeDurableBarrierRelease?: () => void | Promise<void>;
	beforeDurableBarrierAckWait?: () => void | Promise<void>;
}): void {
	launchSlotReleaseDelayMsForTests =
		options?.releaseDelayMs === undefined
			? undefined
			: Math.max(0, Math.floor(options.releaseDelayMs));
	transientRetryJitterForTests =
		options?.retryJitterMs === undefined
			? undefined
			: typeof options.retryJitterMs === "function"
				? options.retryJitterMs
				: () => Math.max(0, Math.floor(options.retryJitterMs as number));
	launchSlotAcquiredHookForTests = options?.onLaunchSlotAcquired;
	beforeRunSubagentHookForTests = options?.beforeRunSubagent;
	afterLaunchAuthorityRegisteredHookForTests =
		options?.afterLaunchAuthorityRegistered;
	beforeDurableBarrierReleaseHookForTests =
		options?.beforeDurableBarrierRelease;
	beforeDurableBarrierAckWaitHookForTests =
		options?.beforeDurableBarrierAckWait;
	launchSlotReleaseGeneration += 1;
	activeLaunchSlots = 0;
	activeLiveModelWorkerKeys.clear();
	sharedModelRateLimitBackoffs.clear();
	adaptiveLiveModelWorkerStates.clear();
	while (launchWaitQueue.length > 0) launchWaitQueue.shift()?.resolveWait();
}

export async function recordSharedModelRateLimitBackoffForTests(
	model: string | undefined,
	backoffMs: number | undefined,
): Promise<void> {
	await recordSharedModelRateLimitBackoff(
		{ runtime: { model } } as WorkflowTaskRunRecord,
		backoffMs,
	);
}

export async function cleanupSubagentRun(
	cwd: string,
	run: WorkflowRunRecord,
): Promise<void> {
	const errors: unknown[] = [];
	for (const task of run.tasks) {
		if (task.status !== "running") continue;
		const batch = activeForeachBatchRecordForTask(run, task);
		if (batch && task.foreachBatch?.role === "member") continue;
		try {
			await acknowledgeSubagentTaskInterrupted(
				cwd,
				run,
				task,
				"workflow cleanup",
			);
			task.statusDetail = "cancellation_acknowledged";
			task.lastMessage = "backend cancellation acknowledged";
		} catch (error) {
			task.statusDetail = "cancellation_failed";
			task.lastMessage = `backend cancellation failed: ${error instanceof Error ? error.message : String(error)}`;
			errors.push(error);
		}
	}
	if (errors.length > 0) {
		throw new AggregateError(
			errors,
			"one or more backend cancellations failed",
		);
	}
}

interface SubagentCancellationAcknowledgement {
	attemptId: string;
	status: "cancelled" | "completed" | "failed";
	observedAt: string;
	interruptStatus: "interrupt-requested" | "already-terminal";
}

const TERMINAL_SUBAGENT_ATTEMPT_STATUSES = new Set([
	"cancelled",
	"completed",
	"failed",
]);

function exactTerminalAttempt(
	attempts: Array<{ attemptId?: string; status?: string }> | undefined,
	attemptId: string,
): "cancelled" | "completed" | "failed" | undefined {
	const status = attempts?.find(
		(attempt) => attempt.attemptId === attemptId,
	)?.status;
	return TERMINAL_SUBAGENT_ATTEMPT_STATUSES.has(status ?? "")
		? (status as "cancelled" | "completed" | "failed")
		: undefined;
}

export async function interruptSubagentTask(
	task: WorkflowTaskRunRecord,
	reason: string,
): Promise<SubagentCancellationAcknowledgement | undefined> {
	const handle = getSubagentHandle(task);
	if (!handle) return undefined;
	const api = await loadSubagentApi();
	const context = `task ${task.taskId} (${task.specId}) subagent run ${handle.runId}/${handle.attemptId}`;
	const result = await awaitSubagentOperation(
		() =>
			api.interruptSubagent({
				cwd: handle.cwd,
				runsDir: handle.runsDir,
				runId: handle.runId,
				attemptId: handle.attemptId,
				reason,
			}),
		{
			operation: "interrupt",
			context,
			timeoutMs: SUBAGENT_INTERRUPT_TIMEOUT_MS,
		},
	);
	if (result?.runId !== handle.runId)
		throw new Error(
			`subagent interruption result run ${result?.runId ?? "missing"} does not match ${handle.runId}`,
		);
	if (
		result.status !== "interrupt-requested" &&
		result.status !== "already-terminal"
	)
		throw new Error(
			`subagent interruption was not acknowledged for exact attempt ${handle.attemptId}: ${result?.status ?? "invalid-result"}`,
		);
	if (
		result.status === "interrupt-requested" &&
		!result.interruptedAttempts?.includes(handle.attemptId)
	)
		throw new Error(
			`subagent interruption acknowledged a different attempt instead of ${handle.attemptId}`,
		);

	const deadline = Date.now() + SUBAGENT_INTERRUPT_TIMEOUT_MS;
	let terminalStatus = exactTerminalAttempt(
		result.record?.attempts,
		handle.attemptId,
	);
	while (terminalStatus === undefined && Date.now() < deadline) {
		const remainingMs = Math.max(1, deadline - Date.now());
		const snapshot = await awaitSubagentOperation(
			() =>
				api.getSubagentStatus({
					cwd: handle.cwd,
					runsDir: handle.runsDir,
					runId: handle.runId,
				}),
			{
				operation: "cancellation acknowledgement status",
				context,
				timeoutMs: Math.min(
					SUBAGENT_REFRESH_OPERATION_TIMEOUT_MS,
					remainingMs,
				),
			},
		);
		if (snapshot !== null && snapshot.runId !== handle.runId)
			throw new Error(
				`subagent cancellation status run ${snapshot.runId} does not match ${handle.runId}`,
			);
		terminalStatus = exactTerminalAttempt(
			snapshot?.attempts,
			handle.attemptId,
		);
		if (terminalStatus === undefined)
			await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
	}
	if (terminalStatus === undefined)
		throw new Error(
			`subagent exact attempt ${handle.attemptId} did not reach a terminal state after interruption`,
		);
	return {
		attemptId: handle.attemptId,
		status: terminalStatus,
		observedAt: nowIso(),
		interruptStatus: result.status,
	};
}

export async function launchSubagentTask(
	cwd: string,
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	compiledTask: CompiledTask,
	leaseSignal?: AbortSignal,
	workflowStopSignal?: AbortSignal,
	preparedLaunch?: PreparedWorkflowTaskLaunch,
): Promise<BackendLaunchResult> {
	if (task.status !== "pending") return { kind: "launched" };
	if (task.backendHandle || task.pid) return { kind: "launched" };

	if ((compiledTask.runtime.fast as string | undefined) === "on") {
		return {
			kind: "fatal",
			message: "fast:on is not supported for pi-workflow execution.",
		};
	}

	await throwIfLaunchStopped(cwd, run.runId, leaseSignal, workflowStopSignal);

	const taskHasRateLimitRetry =
		(task.launchRetry?.attempts ?? 0) > 0 &&
		(task.launchRetry?.reason ?? "").startsWith("model_rate_limit");
	if ((task.launchRetry?.attempts ?? 0) > 0) {
		const backoffRemainingMs = launchRetryBackoffRemainingMs(task);
		if (backoffRemainingMs !== undefined && backoffRemainingMs > 0) {
			const message = `waiting until ${task.launchRetry?.nextEligibleAt} before retrying transient-model launch after rate-limit backoff`;
			const shouldWriteBackoffState =
				task.statusDetail !== "retry_model_failure" ||
				task.lastMessage !== message;
			task.statusDetail = "retry_model_failure";
			task.lastMessage = message;
			if (shouldWriteBackoffState) await writeRunRecord(cwd, run);
			return {
				kind: "capacity",
				message,
				retryAfterMs: backoffRemainingMs,
			};
		}
		if (backoffRemainingMs !== undefined && task.launchRetry) {
			delete task.launchRetry.nextEligibleAt;
			delete task.launchRetry.retryAfterMs;
		}
		const jitterMs = transientRetryJitterMs();
		task.statusDetail = "retry_model_failure";
		task.lastMessage = `waiting ${jitterMs}ms before retrying transient-model launch`;
		await writeRunRecord(cwd, run);
		await throwIfLaunchStopped(cwd, run.runId, leaseSignal, workflowStopSignal);
		if (jitterMs > 0) {
			await sleep(jitterMs);
			await throwIfLaunchStopped(
				cwd,
				run.runId,
				leaseSignal,
				workflowStopSignal,
			);
		}
	}

	const sharedRateLimitBackoff = taskHasRateLimitRetry
		? undefined
		: await sharedModelRateLimitBackoffRemaining(
				modelRateLimitBackoffKey(task, compiledTask),
			);
	await throwIfLaunchStopped(cwd, run.runId, leaseSignal, workflowStopSignal);
	if (sharedRateLimitBackoff) {
		const message = sharedModelRateLimitBackoffWaitingMessage(
			sharedRateLimitBackoff.key,
			sharedRateLimitBackoff.nextEligibleAt,
		);
		const shouldWriteBackoffState =
			task.status !== "pending" ||
			task.statusDetail !== "pending" ||
			task.startedAt !== undefined ||
			task.lastMessage !== message;
		task.status = "pending";
		task.statusDetail = "pending";
		task.startedAt = undefined;
		task.lastMessage = message;
		if (shouldWriteBackoffState) await writeRunRecord(cwd, run);
		return {
			kind: "capacity",
			message,
			retryAfterMs: sharedRateLimitBackoff.remainingMs,
		};
	}

	const systemPromptFile = fromProjectPath(cwd, task.files.systemPrompt);
	const taskPromptFile = fromProjectPath(cwd, task.files.taskPrompt);
	const outputFile = fromProjectPath(cwd, task.files.output);
	const stderrFile = fromProjectPath(cwd, task.files.stderr);
	const resultFile = fromProjectPath(cwd, task.files.result);
	const runsDir = subagentRunsDir(run, task);
	const correlationId = `${run.runId}:${task.taskId}`;
	const sessionId = workflowTaskSessionId(run, task);

	let launched: SubagentResultEnvelope;
	const basePreparedLaunch =
		preparedLaunch ??
		(await prepareSubagentTaskLaunch(cwd, run, task, compiledTask));
	let sealedLaunch = basePreparedLaunch;
	if (!basePreparedLaunch.authority) {
		const provenance = await createLaunchBootstrapProvenance(
			cwd,
			run,
			task,
			compiledTask,
			SUBAGENT_HEADLESS_BACKEND_ID,
			basePreparedLaunch,
		);
		recordLaunchBootstrapProvenance(task, provenance);
		const authority = createWorkflowLaunchAuthority(
			run,
			task,
			SUBAGENT_HEADLESS_BACKEND_ID,
			provenance,
		);
		issueWorkflowLaunchAuthority(task, authority);
		sealedLaunch = { ...basePreparedLaunch, authority };
		await writeRunRecord(cwd, run);
	}
	const launchAuthority = sealedLaunch.authority;
	if (!launchAuthority)
		throw new Error("workflow launch authority is unavailable");
	const launchBootstrap = assertRecordedLaunchBootstrapProvenance(
		task,
		launchAuthority.launchBootstrapSha256,
	);
	const authorityBindingSha256 =
		launchBootstrap.effectivePolicy.externalLaunchGrantSha256;
	const toolResultBudgetConfiguration = sealedLaunch.toolResultBudget;
	let releaseLiveModelWorkerSlot: (() => void) | undefined;
	let launchApi: SubagentApi | undefined;
	let durableBarrierDescriptor: DurableLaunchBarrierDescriptor | undefined;
	let durableBarrierRecord: WorkflowDurableLaunchBarrierRecord | undefined;
	const hardenedBatchRecord = task.foreachBatch
		? (run.foreachBatches ?? []).find(
				(record) => record.batchId === task.foreachBatch?.batchId,
			)
		: undefined;
	try {
		await throwIfLaunchStopped(cwd, run.runId, leaseSignal, workflowStopSignal);
		const launchAbortSignal = combineAbortSignals(
			leaseSignal,
			workflowStopSignal,
		);
		const liveModelWorkerAdmission = tryAcquireLiveModelWorkerSlot({
			run,
			task,
			compiledTask,
		});
		if (liveModelWorkerAdmission.kind === "deferred") {
			const launchQueuedAt = task.timing?.launchQueuedAt ?? nowIso();
			task.status = "pending";
			task.statusDetail = "pending";
			task.startedAt = undefined;
			task.lastMessage = liveModelWorkerAdmission.message;
			recordTaskLaunchTiming(task, {
				launchQueuedAt,
				waitingForGlobalWorkerSlot: true,
			});
			await writeRunRecord(cwd, run).catch(() => undefined);
			return {
				kind: "capacity",
				message: liveModelWorkerAdmission.message,
				retryAfterMs: liveModelWorkerAdmission.retryAfterMs,
			};
		}
		releaseLiveModelWorkerSlot = liveModelWorkerAdmission.release;

		await mkdir(dirname(systemPromptFile), { recursive: true });
		await throwIfLaunchStopped(cwd, run.runId, leaseSignal, workflowStopSignal);
		await rm(resultFile, { force: true });
		await throwIfLaunchStopped(cwd, run.runId, leaseSignal, workflowStopSignal);
		await writeFile(systemPromptFile, buildSystemPrompt(compiledTask), "utf8");
		await throwIfLaunchStopped(cwd, run.runId, leaseSignal, workflowStopSignal);
		await writeFile(taskPromptFile, compiledTask.compiledPrompt, "utf8");
		await throwIfLaunchStopped(cwd, run.runId, leaseSignal, workflowStopSignal);
		await writeFile(outputFile, "", "utf8");
		await throwIfLaunchStopped(cwd, run.runId, leaseSignal, workflowStopSignal);
		await writeFile(stderrFile, "", "utf8");
		await throwIfLaunchStopped(cwd, run.runId, leaseSignal, workflowStopSignal);

		if (toolResultBudgetConfiguration) {
			recordTaskToolResultBudgetPendingConfiguration({
				task,
				configuration: toolResultBudgetConfiguration,
				capturedAt: nowIso(),
			});
		}
		task.status = "running";
		task.statusDetail = "launching";
		task.startedAt = nowIso();
		task.backendFiles = {
			runsDir: toProjectPath(task.cwd, resolve(task.cwd, runsDir)),
			correlationId,
			...(sessionId === undefined ? {} : { sessionId }),
		};
		task.lastMessage = "pi-subagent launch claim recorded";
		await writeRunRecord(cwd, run);
		await throwIfLaunchStopped(cwd, run.runId, leaseSignal, workflowStopSignal);

		const api = await loadSubagentApi();
		launchApi = api;
		await throwIfLaunchStopped(cwd, run.runId, leaseSignal, workflowStopSignal);
		const durableBarrierAvailable = hasDurableLaunchBarrierApi(api);
		if (
			!durableBarrierAvailable &&
			injectedSubagentApi === undefined &&
			hardenedBatchRecord &&
			(hardenedBatchRecord.stateRootSha256 ||
				hardenedBatchRecord.capabilitySubjectSha256)
		)
			throw new Error(
				`foreach batch ${hardenedBatchRecord.batchId} requires the durable launch barrier API`,
			);
		if (!durableBarrierAvailable && injectedSubagentApi === undefined) {
			throw new Error(
				"installed @agwab/pi-subagent does not support the required durable launch barrier",
			);
		}
		if (durableBarrierAvailable) {
			const history = task.durableLaunchBarrier ?? { version: 2, records: [] };
			durableBarrierRecord = history.records.find(
				(record) => record.attemptKey === launchAuthority.attemptKey,
			);
			if (durableBarrierRecord === undefined) {
				durableBarrierDescriptor = await api.createDurableLaunchBarrierV2({
					directory: join(
						workflowRunDir(cwd, run.runId),
						"tasks",
						task.taskId,
						`.launch-barrier-${launchAuthority.identitySha256.slice(0, 16)}-${randomBytes(8).toString("hex")}`,
					),
					subjectSha256: launchAuthority.identitySha256,
					...(authorityBindingSha256 === undefined
						? {}
						: { authorityBindingSha256 }),
					timeoutMs: Math.min(
						120_000,
						Math.max(30_000, compiledTask.runtime.maxRuntimeMs ?? 30_000),
					),
				});
				if (
					durableBarrierDescriptor.authorityBindingSha256 !==
					authorityBindingSha256
				)
					throw new Error(
						"durable launch barrier authority binding does not match external launch grant",
					);
				durableBarrierRecord = {
					attemptKey: launchAuthority.attemptKey,
					launchAuthoritySha256: launchAuthority.identitySha256,
					...(authorityBindingSha256 === undefined
						? {}
						: { authorityBindingSha256 }),
					descriptor: durableBarrierDescriptor,
					phase: "created",
				};
				history.records.push(durableBarrierRecord);
				task.durableLaunchBarrier = history;
				await writeRunRecordDurable(cwd, run);
			} else {
				durableBarrierDescriptor = durableBarrierRecord.descriptor;
				if (
					durableBarrierRecord.launchAuthoritySha256 !==
						launchAuthority.identitySha256 ||
					durableBarrierDescriptor.subjectSha256 !==
						launchAuthority.identitySha256 ||
					durableBarrierDescriptor.authorityBindingSha256 !==
						authorityBindingSha256 ||
					durableBarrierRecord.authorityBindingSha256 !==
						authorityBindingSha256
				) {
					throw new Error(
						"durable launch barrier binding does not match launch authority",
					);
				}
			}
		}
		await throwIfLaunchStopped(cwd, run.runId, leaseSignal, workflowStopSignal);
		const subagentOptions: Record<string, unknown> = {
			cwd: task.cwd,
			backend: "headless",
			task: compiledTask.compiledPrompt,
			systemPrompt: buildSystemPrompt(compiledTask),
			model: compiledTask.runtime.model,
			thinking: compiledTask.runtime.thinking,
			async: true,
			onComplete: "detach",
			asyncDependency: "needed-before-final",
			workspace: "shared",
			worktreePolicy: "never",
			timeoutMs: compiledTask.runtime.maxRuntimeMs,
			runsDir,
			correlationId,
			...(sessionId === undefined ? {} : { sessionId }),
			...(durableBarrierDescriptor === undefined
				? {}
				: { durableLaunchBarrier: durableBarrierDescriptor }),
		};
		const launchQueuedAt = nowIso();
		let launchStartedAt: string | undefined;
		recordTaskLaunchTiming(task, { launchQueuedAt });
		if (isLaunchGateSaturated()) {
			task.lastMessage = `waiting for pi-subagent launch slot (${resolveMaxConcurrentLaunches()} max)`;
			await writeRunRecord(cwd, run).catch(() => undefined);
			await throwIfLaunchStopped(
				cwd,
				run.runId,
				leaseSignal,
				workflowStopSignal,
			);
		}
		launched = await runWithLaunchSlot(
			async () => {
				await beforeRunSubagentHookForTests?.();
				await assertPreparedSubagentTaskLaunch(sealedLaunch);
				await throwIfWorkflowStopRequested(cwd, run.runId);
				throwIfAborted(leaseSignal);
				throwIfAborted(workflowStopSignal);
				assertCurrentWorkflowLaunchAuthority(
					run,
					task,
					launchAuthority,
					SUBAGENT_HEADLESS_BACKEND_ID,
				);
				await assertPreparedLaunchMatchesRecordedProvenance(
					cwd,
					run,
					task,
					compiledTask,
					SUBAGENT_HEADLESS_BACKEND_ID,
					sealedLaunch,
					launchAuthority.launchBootstrapSha256,
				);
				subagentOptions.tools =
					compiledTask.runtime.tools === undefined
						? undefined
						: [...compiledTask.runtime.tools];
				subagentOptions.extensions = [...sealedLaunch.extensions];
				if (sealedLaunch.captureToolCalls)
					subagentOptions.captureToolCalls = true;
				if (injectedSubagentApi === undefined)
					await assertSubagentExtensionsLoadable(subagentOptions);
				if (toolResultBudgetConfiguration?.maxTotalChars !== undefined) {
					subagentOptions.toolResultBudget = {
						maxTotalChars: toolResultBudgetConfiguration.maxTotalChars,
					};
				}
				registerWorkflowLaunchAuthority(
					run,
					task,
					launchAuthority,
					SUBAGENT_HEADLESS_BACKEND_ID,
				);
				await writeRunRecord(cwd, run);
				await afterLaunchAuthorityRegisteredHookForTests?.();
				await throwIfWorkflowStopRequested(cwd, run.runId);
				throwIfAborted(leaseSignal);
				throwIfAborted(workflowStopSignal);
				return awaitSubagentOperation(
					async () => {
						await throwIfWorkflowStopRequested(cwd, run.runId);
						throwIfAborted(leaseSignal);
						throwIfAborted(workflowStopSignal);
						return runSubagentWithWorkflowWorkerRole(api, subagentOptions);
					},
					{
						operation: "launch acknowledgement",
						context: `workflow run ${run.runId} task ${task.taskId} (${task.specId})`,
						timeoutMs: SUBAGENT_LAUNCH_ACK_TIMEOUT_MS,
						signal: leaseSignal,
					},
				);
			},
			() => {
				launchStartedAt = nowIso();
				recordTaskLaunchTiming(task, { launchQueuedAt, launchStartedAt });
			},
			launchAbortSignal,
		);
		recordTaskLaunchTiming(task, {
			launchQueuedAt,
			launchStartedAt,
			launchCompletedAt: nowIso(),
		});
	} catch (error) {
		if (
			error instanceof WorkflowLaunchAuthorityRegisteredError ||
			error instanceof WorkflowLaunchAuthorityConsumedError
		) {
			releaseLiveModelWorkerSlot?.();
			task.status = "running";
			task.statusDetail = "launch_ack_pending";
			task.lastMessage =
				error instanceof WorkflowLaunchAuthorityConsumedError
					? "launch authority is already consumed; awaiting handle recovery"
					: "launch authority is already registered; awaiting correlation recovery";
			await writeRunRecord(cwd, run).catch(() => undefined);
			return {
				kind: "capacity",
				message: task.lastMessage,
				retryAfterMs: STALE_LAUNCH_CLAIM_GRACE_MS,
			};
		}
		if (workflowStopSignal?.aborted || isWorkflowStopRequestedError(error)) {
			releaseLiveModelWorkerSlot?.();
			clearTaskToolResultBudgetPendingConfiguration(task);
			throw error;
		}
		if (leaseSignal?.aborted) {
			task.status = "running";
			task.statusDetail = "launch_ack_aborted";
			task.lastMessage =
				"launch acknowledgement wait aborted; retaining claim for correlation-based recovery";
			await writeRunRecord(cwd, run).catch(() => undefined);
			throw error;
		}
		if (error instanceof SubagentOperationTimeoutError) {
			task.status = "running";
			task.statusDetail = "launch_ack_timeout";
			task.lastMessage = `${error.message}; retaining launch claim for correlation-based recovery`;
			await writeRunRecord(cwd, run).catch(() => undefined);
			return {
				kind: "capacity",
				message: task.lastMessage,
				retryAfterMs: STALE_LAUNCH_CLAIM_GRACE_MS,
			};
		}
		releaseLiveModelWorkerSlot?.();
		clearTaskToolResultBudgetPendingConfiguration(task);
		task.status = "pending";
		task.statusDetail = "pending";
		task.startedAt = undefined;
		task.lastMessage =
			"pi-subagent launch failed before backend handle was recorded";
		await writeRunRecord(cwd, run).catch(() => undefined);
		throw error;
	}

	const handle = makeSubagentHandle(
		task,
		launched.runId,
		launched.attemptId,
		runsDir,
		sessionId,
	);
	if (durableBarrierDescriptor !== undefined) {
		task.backendHandle = handle;
		task.backendTaskId = launched.runId;
		task.statusDetail = "launch_barrier_pending";
		task.lastMessage = "backend handle recorded; awaiting durable launch barrier";
		const launchAbortSignal = combineAbortSignals(
			leaseSignal,
			workflowStopSignal,
		);
		try {
			await writeRunRecordDurable(cwd, run);
			if (launchApi === undefined || !hasDurableLaunchBarrierApi(launchApi)) {
				throw new Error("durable launch barrier API became unavailable");
			}
			const ready = await awaitSubagentOperation(
				() =>
					launchApi.waitForDurableLaunchBarrierV2Ready(
						durableBarrierDescriptor,
					),
				{
					operation: "durable launch barrier READY",
					context: `workflow run ${run.runId} task ${task.taskId} (${task.specId})`,
					timeoutMs: durableBarrierDescriptor.timeoutMs + 5_000,
					signal: launchAbortSignal,
				},
			);
			if (
				ready.schema !== "pi-subagent-durable-launch-barrier-ready-v2" ||
				ready.barrierIdentitySha256 !==
					durableBarrierDescriptor.identitySha256 ||
				ready.challenge !== durableBarrierDescriptor.challenge ||
				ready.decisionNonce !== durableBarrierDescriptor.decisionNonce ||
				ready.subjectSha256 !== durableBarrierDescriptor.subjectSha256 ||
				ready.authorityBindingSha256 !== authorityBindingSha256 ||
				ready.runId !== launched.runId ||
				ready.attemptId !== launched.attemptId ||
				!isSha256Digest(ready.readySha256) ||
				!isSha256Digest(ready.launchPayloadSha256) ||
				!isSha256Digest(ready.executionPlanSha256)
			) {
				throw new Error(
					"durable launch barrier READY does not match the authorized launch",
				);
			}
			if (durableBarrierRecord === undefined)
				throw new Error("durable launch barrier record is unavailable");
			durableBarrierRecord.phase = "ready";
			durableBarrierRecord.readySha256 = ready.readySha256;
			durableBarrierRecord.launchPayloadSha256 = ready.launchPayloadSha256;
			durableBarrierRecord.executionPlanSha256 = ready.executionPlanSha256;
			durableBarrierRecord.backendRunId = launched.runId;
			durableBarrierRecord.backendAttemptId = launched.attemptId;
			consumeWorkflowLaunchAuthority(
				task,
				launchAuthority,
				launched.runId,
				launched.attemptId,
			);
			const releasePayloadSha256 = launchApi.durableLaunchBarrierDigest({
				schema: "pi-workflow-consumed-launch-release-v1",
				runId: run.runId,
				taskId: task.taskId,
				attemptKey: launchAuthority.attemptKey,
				launchAuthoritySha256: launchAuthority.identitySha256,
				launchBootstrapSha256: launchAuthority.launchBootstrapSha256,
				backendRunId: launched.runId,
				backendAttemptId: launched.attemptId,
				readySha256: ready.readySha256,
				launchPayloadSha256: ready.launchPayloadSha256,
				executionPlanSha256: ready.executionPlanSha256,
				authorityPhase: "consumed",
				...(authorityBindingSha256 === undefined
					? {}
					: {
							authorityBindingSha256,
							externalLaunchGrantSha256: authorityBindingSha256,
						}),
			});
			durableBarrierRecord.phase = "consumed";
			durableBarrierRecord.releasePayloadSha256 = releasePayloadSha256;
			if (
				hardenedBatchRecord &&
				task.foreachBatch?.role === "leader" &&
				(hardenedBatchRecord.stateRootSha256 ||
					hardenedBatchRecord.capabilitySubjectSha256)
			) {
				const capability = await issueForeachBatchCapability(
					cwd,
					hardenedBatchRecord,
				);
				await assertForeachBatchCapability(
					cwd,
					hardenedBatchRecord,
					capability,
				);
				const reservationSha256 = launchApi.durableLaunchBarrierDigest({
					schema: "workflow-foreach-batch-dispatch-reservation-v1",
					batchId: hardenedBatchRecord.batchId,
					attemptKey: launchAuthority.attemptKey,
					capabilitySubjectSha256:
						hardenedBatchRecord.capabilitySubjectSha256,
					stateRootSha256: hardenedBatchRecord.stateRootSha256,
					releasePayloadSha256,
				});
				if (
					hardenedBatchRecord.dispatch &&
					(hardenedBatchRecord.dispatch.attemptKey !==
						launchAuthority.attemptKey ||
						hardenedBatchRecord.dispatch.reservationSha256 !==
							reservationSha256)
				)
					throw new Error(
						`foreach batch ${hardenedBatchRecord.batchId} dispatch reservation drift`,
					);
				hardenedBatchRecord.dispatch ??= {
					schema: "workflow-foreach-batch-dispatch-v1",
					state: "reserved",
					attemptKey: launchAuthority.attemptKey,
					reservationSha256,
					reservedAt: nowIso(),
				};
			}
			await writeRunRecordDurable(cwd, run);
			await beforeDurableBarrierReleaseHookForTests?.();
			let preReleaseStopError: unknown;
			let resolution: DurableLaunchBarrierResolution | undefined;
			try {
				await throwIfLaunchStopped(
					cwd,
					run.runId,
					leaseSignal,
					workflowStopSignal,
				);
			} catch (error) {
				preReleaseStopError = error;
				const cancellation = durableBarrierCancellationIdentity(
					launchApi,
					run,
					task,
					durableBarrierRecord,
				);
				resolution = await launchApi.revokeDurableLaunchBarrierV2(
					durableBarrierDescriptor,
					cancellation,
				);
			}
			resolution ??= await resolveDurableBarrierReleaseWithCancellation(
				launchApi,
				run,
				task,
				durableBarrierRecord,
				ready,
				releasePayloadSha256,
				launchAbortSignal,
			);
			durableBarrierRecord.decisionSha256 =
				resolution.decision.decisionSha256;
			if (resolution.outcome === "revoked") {
				const cancellation = durableBarrierCancellationIdentity(
					launchApi,
					run,
					task,
					durableBarrierRecord,
				);
				durableBarrierRecord.phase = "revoked";
				durableBarrierRecord.releaseWinner = false;
				durableBarrierRecord.cancellation ??= {
					...cancellation,
					requestedAt: nowIso(),
					decision: "revoked",
				};
				await writeRunRecordDurable(cwd, run);
				if (preReleaseStopError !== undefined) throw preReleaseStopError;
				if (launchAbortSignal?.aborted)
					throw abortSignalError(launchAbortSignal);
				throw new Error(
					"durable launch barrier was revoked before release",
				);
			}
			const release = resolution.decision;
			if (
				release.kind !== "released" ||
				release.schema !==
					"pi-subagent-durable-launch-barrier-decision-v2" ||
				release.barrierIdentitySha256 !==
					durableBarrierDescriptor.identitySha256 ||
				release.challenge !== durableBarrierDescriptor.challenge ||
				release.decisionNonce !== durableBarrierDescriptor.decisionNonce ||
				release.subjectSha256 !== durableBarrierDescriptor.subjectSha256 ||
				release.authorityBindingSha256 !== authorityBindingSha256 ||
				release.runId !== ready.runId ||
				release.attemptId !== ready.attemptId ||
				release.readySha256 !== ready.readySha256 ||
				release.releasePayloadSha256 !== releasePayloadSha256 ||
				!isSha256Digest(release.decisionSha256)
			)
				throw new Error(
					"durable launch barrier release decision does not match the authorized READY receipt",
				);
			durableBarrierRecord.phase = "released";
			durableBarrierRecord.releaseWinner = true;
			durableBarrierRecord.decisionSha256 = release.decisionSha256;
			await writeRunRecordDurable(cwd, run);
			if (preReleaseStopError !== undefined) throw preReleaseStopError;
			if (launchAbortSignal?.aborted)
				throw abortSignalError(launchAbortSignal);
			await beforeDurableBarrierAckWaitHookForTests?.();
			await throwIfLaunchStopped(
				cwd,
				run.runId,
				leaseSignal,
				workflowStopSignal,
			);
			const ack = await awaitSubagentOperation(
				() =>
					launchApi.waitForDurableLaunchBarrierV2Ack(
						durableBarrierDescriptor,
						release,
					),
				{
					operation: "durable launch barrier ACK",
					context: `workflow run ${run.runId} task ${task.taskId} (${task.specId})`,
					timeoutMs: durableBarrierDescriptor.timeoutMs + 5_000,
					signal: launchAbortSignal,
				},
			);
			if (
				ack.schema !== "pi-subagent-durable-launch-barrier-ack-v2" ||
				ack.barrierIdentitySha256 !==
					durableBarrierDescriptor.identitySha256 ||
				ack.challenge !== durableBarrierDescriptor.challenge ||
				ack.decisionNonce !== durableBarrierDescriptor.decisionNonce ||
				ack.runId !== release.runId ||
				ack.attemptId !== release.attemptId ||
				ack.readySha256 !== release.readySha256 ||
				ack.decisionSha256 !== release.decisionSha256 ||
				!isSha256Digest(ack.ackSha256)
			)
				throw new Error(
					"durable launch barrier ACK does not match the authorized release",
				);
			durableBarrierRecord.phase = "acknowledged";
			durableBarrierRecord.ackSha256 = ack.ackSha256;
			await writeRunRecordDurable(cwd, run);
			await throwIfLaunchStopped(
				cwd,
				run.runId,
				leaseSignal,
				workflowStopSignal,
			);
		} catch (error) {
			const cancelled =
				leaseSignal?.aborted === true ||
				workflowStopSignal?.aborted === true ||
				isWorkflowStopRequestedError(error);
			task.statusDetail = cancelled
				? "launch_barrier_cancelled"
				: "launch_barrier_failed";
			task.lastMessage = cancelled
				? "durable launch barrier cancelled; interrupting provisional worker"
				: `durable launch barrier failed; interrupting provisional worker: ${error instanceof Error ? error.message : String(error)}`;
			await writeRunRecordDurable(cwd, run).catch(() => undefined);
			let interruptionError: unknown;
			try {
				await acknowledgeSubagentTaskInterrupted(
					cwd,
					run,
					task,
					cancelled
						? "workflow launch cancelled before durable barrier completion"
						: "durable launch barrier failed closed",
				);
			} catch (interruptError) {
				interruptionError = interruptError;
				task.statusDetail = "cancellation_failed";
				task.lastMessage = `provisional worker interruption failed: ${interruptError instanceof Error ? interruptError.message : String(interruptError)}`;
				await writeRunRecordDurable(cwd, run).catch(() => undefined);
			}
			if (interruptionError !== undefined)
				throw new AggregateError(
					[error, interruptionError],
					"durable launch barrier failed and provisional worker interruption was not acknowledged",
				);
			throw error;
		}
	} else {
		consumeWorkflowLaunchAuthority(
			task,
			launchAuthority,
			launched.runId,
			launched.attemptId,
		);
	}
	task.backendHandle = handle;
	task.backendTaskId = launched.runId;
	if (toolResultBudgetConfiguration) {
		bindTaskToolResultBudgetPendingConfiguration({
			task,
			backendRunId: launched.runId,
			backendAttemptId: launched.attemptId,
			capturedAt: nowIso(),
		});
	}
	task.backendFiles = {
		runsDir: toProjectPath(task.cwd, resolve(task.cwd, runsDir)),
		correlationId,
		...(sessionId === undefined ? {} : { sessionId }),
	};
	task.statusDetail = "running";
	task.lastMessage = "launched via pi-subagent/headless";
	await writeRunRecord(cwd, run).catch(() => undefined);
	await recordParentSubagentChildEvent({
		event: "started",
		childRunId: launched.runId,
		run,
		task,
		message: task.lastMessage,
	});
	return { kind: "launched" };
}

function assertRecoveredBarrierField(
	label: string,
	persisted: string | undefined,
	observed: string,
): void {
	if (persisted !== undefined && persisted !== observed)
		throw new Error(`durable launch barrier recovered ${label} drift`);
}

function barrierRecoveryIsStale(
	task: WorkflowTaskRunRecord,
	descriptor: DurableLaunchBarrierDescriptor,
): boolean {
	const startedAtMs = timestampMs(task.startedAt);
	return (
		startedAtMs !== undefined &&
		Date.now() - startedAtMs > descriptor.timeoutMs + 5_000
	);
}

async function reconcileDurableLaunchBarrierTask(
	cwd: string,
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
): Promise<boolean> {
	const record = durableBarrierRecordForTask(task);
	if (!record) return false;
	const api = await loadSubagentApi();
	if (!hasDurableLaunchBarrierApi(api))
		throw new Error(
			"installed @agwab/pi-subagent cannot reconcile durable launch barrier v2",
		);
	const state = await api.readDurableLaunchBarrierV2State(record.descriptor);
	let changed = false;
	let handle = getSubagentHandle(task);
	if (state.ready) {
		const ready = state.ready;
		if (
			ready.barrierIdentitySha256 !== record.descriptor.identitySha256 ||
			ready.challenge !== record.descriptor.challenge ||
			ready.decisionNonce !== record.descriptor.decisionNonce ||
			ready.subjectSha256 !== record.descriptor.subjectSha256 ||
			ready.authorityBindingSha256 !== record.authorityBindingSha256
		)
			throw new Error(
				"durable launch barrier recovered READY does not match persisted authority",
			);
		assertRecoveredBarrierField(
			"ready digest",
			record.readySha256,
			ready.readySha256,
		);
		assertRecoveredBarrierField(
			"launch payload digest",
			record.launchPayloadSha256,
			ready.launchPayloadSha256,
		);
		assertRecoveredBarrierField(
			"execution plan digest",
			record.executionPlanSha256,
			ready.executionPlanSha256,
		);
		assertRecoveredBarrierField(
			"backend run id",
			record.backendRunId,
			ready.runId,
		);
		assertRecoveredBarrierField(
			"backend attempt id",
			record.backendAttemptId,
			ready.attemptId,
		);
		if (handle && (handle.runId !== ready.runId || handle.attemptId !== ready.attemptId))
			throw new Error(
				"durable launch barrier recovered handle does not match READY",
			);
		if (!handle) {
			handle = makeSubagentHandle(
				task,
				ready.runId,
				ready.attemptId,
				subagentRunsDir(run, task),
				workflowTaskSessionId(run, task),
			);
			task.backendHandle = handle;
			task.backendTaskId = ready.runId;
			changed = true;
		}
		record.readySha256 = ready.readySha256;
		record.launchPayloadSha256 = ready.launchPayloadSha256;
		record.executionPlanSha256 = ready.executionPlanSha256;
		record.backendRunId = ready.runId;
		record.backendAttemptId = ready.attemptId;
		if (record.phase === "created") record.phase = "ready";
		if (
			consumeRegisteredWorkflowLaunchAuthority(
				run,
				task,
				SUBAGENT_HEADLESS_BACKEND_ID,
				ready.runId,
				ready.attemptId,
			)
		)
			changed = true;
		changed = true;
	} else if (
		record.readySha256 !== undefined ||
		(record.phase !== "created" && state.decision?.kind !== "revoked")
	) {
		throw new Error(
			"durable launch barrier persisted phase has no recoverable READY receipt",
		);
	}

	if (state.decision) {
		assertRecoveredBarrierField(
			"decision digest",
			record.decisionSha256,
			state.decision.decisionSha256,
		);
		record.decisionSha256 = state.decision.decisionSha256;
		if (state.decision.kind === "released") {
			assertRecoveredBarrierField(
				"release payload digest",
				record.releasePayloadSha256,
				state.decision.releasePayloadSha256,
			);
			record.releasePayloadSha256 = state.decision.releasePayloadSha256;
			record.releaseWinner = true;
			if (
				record.phase !== "acknowledged" &&
				record.phase !== "cancellation_acknowledged" &&
				record.phase !== "release_won_cancellation_pending"
			)
				record.phase = "released";
		} else {
			record.releaseWinner = false;
			if (record.phase !== "cancellation_acknowledged")
				record.phase = "revoked";
		}
		changed = true;
	} else if (
		record.decisionSha256 !== undefined ||
		[
			"released",
			"acknowledged",
			"revoked",
			"release_won_cancellation_pending",
			"cancellation_acknowledged",
		].includes(record.phase)
	) {
		throw new Error(
			"durable launch barrier persisted decision has no recoverable decision receipt",
		);
	}

	if (state.ack) {
		assertRecoveredBarrierField(
			"acknowledgement digest",
			record.ackSha256,
			state.ack.ackSha256,
		);
		if (
			state.decision?.kind !== "released" ||
			state.ack.decisionSha256 !== state.decision.decisionSha256
		)
			throw new Error(
				"durable launch barrier recovered ACK does not match release decision",
			);
		record.ackSha256 = state.ack.ackSha256;
		if (
			record.phase !== "release_won_cancellation_pending" &&
			record.phase !== "cancellation_acknowledged"
		)
			record.phase = "acknowledged";
		changed = true;
	} else if (
		record.ackSha256 !== undefined ||
		record.phase === "acknowledged"
	) {
		throw new Error(
			"durable launch barrier persisted acknowledgement has no recoverable ACK receipt",
		);
	}

	if (changed) await writeRunRecordDurable(cwd, run);
	const cancellationPending =
		record.phase === "revoked" ||
		record.phase === "release_won_cancellation_pending";
	if (
		cancellationPending ||
		(state.ack === undefined &&
			barrierRecoveryIsStale(task, record.descriptor))
	) {
		await acknowledgeSubagentTaskInterrupted(
			cwd,
			run,
			task,
			"reconciling incomplete durable launch barrier after supervisor interruption",
		);
		changed = true;
	}
	return changed;
}

export async function reconcileDurableLaunchBarrierTaskForTests(
	cwd: string,
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
): Promise<boolean> {
	return reconcileDurableLaunchBarrierTask(cwd, run, task);
}

interface RefreshPollItem {
	order: number;
	workflowRunId: string;
	task: WorkflowTaskRunRecord;
	handle: SubagentBackendHandle;
}

interface RefreshPollResult extends RefreshPollItem {
	snapshot: SubagentRunStatusSnapshot | null;
	reconcileMs: number;
	statusPollMs: number;
}

type RefreshPollOperation = "reconcile" | "status";

export async function refreshRunFromSubagentArtifacts(
	cwd: string,
	run: WorkflowRunRecord,
): Promise<WorkflowRunRecord> {
	let changed = await recoverForeachBatchRuntime(cwd, run);
	let telemetryChanged = false;
	const pollItems: RefreshPollItem[] = [];
	reconcileLiveModelWorkerSlots(run);

	for (const [order, task] of run.tasks.entries()) {
		if (isTerminalTaskStatus(task.status) || task.status !== "running")
			continue;
		const activeBatch = activeForeachBatchRecordForTask(run, task);
		if (activeBatch && task.foreachBatch?.role === "member") continue;
		if (
			activeBatch &&
			activeBatch.phase !== "launching" &&
			activeBatch.phase !== "running"
		)
			continue;
		let handle = getSubagentHandle(task);
		if (!handle) {
			handle = await recoverSubagentHandle(run, task);
			if (handle) {
				task.backendHandle = handle;
				task.backendTaskId = handle.runId;
				task.backendFiles = {
					runsDir: toProjectPath(task.cwd, resolve(task.cwd, handle.runsDir)),
					correlationId: `${run.runId}:${task.taskId}`,
					...(handle.sessionId === undefined
						? {}
						: { sessionId: handle.sessionId }),
				};
				task.statusDetail = "running";
				task.lastMessage = `adopted pi-subagent run ${handle.runId}/${handle.attemptId}`;
				changed = true;
			}
		}
		if (task.durableLaunchBarrier) {
			if (await reconcileDurableLaunchBarrierTask(cwd, run, task))
				changed = true;
			handle = getSubagentHandle(task);
		}
		if (
			handle &&
			!task.durableLaunchBarrier &&
			consumeRegisteredWorkflowLaunchAuthority(
				run,
				task,
				SUBAGENT_HEADLESS_BACKEND_ID,
				handle.runId,
				handle.attemptId,
			)
		) {
			changed = true;
		}
		if (handle && task.toolResultBudget?.pendingConfiguration) {
			bindTaskToolResultBudgetPendingConfiguration({
				task,
				backendRunId: handle.runId,
				backendAttemptId: handle.attemptId,
				capturedAt: nowIso(),
			});
			changed = true;
		}
		if (!handle) {
			if (isStaleLaunchClaim(task)) {
				if (
					hasNonSpawnableWorkflowLaunchAuthority(
						run,
						task,
						SUBAGENT_HEADLESS_BACKEND_ID,
					)
				) {
					if (activeBatch) {
						await fallbackForeachBatchAfterTerminal(
							cwd,
							run,
							activeBatch,
							"batch launch authority could not be correlated",
						);
					} else {
					setTaskTerminal(
						task,
						"failed",
						"launch_authority_recovery_failed",
						{
							exitCode: 1,
							lastMessage:
								"registered launch authority could not be correlated; refusing duplicate spawn",
						},
					);
					}
				} else {
					resetStaleLaunchClaim(task);
					if (activeBatch) {
						const [, member] = foreachBatchTasks(run, activeBatch);
						setForeachBatchPhase(run, activeBatch, "prepared");
						member.status = "pending";
						member.statusDetail = "pending";
						member.startedAt = undefined;
						member.lastMessage =
							"foreach batch leader launch claim expired; retrying exact prepared pair";
					}
				}
				releaseLiveModelWorkerSlotForTask(run, task);
				changed = true;
				continue;
			}
			if (isTaskTimedOut(task)) {
				markSubagentTaskTimedOut(task);
				releaseLiveModelWorkerSlotForTask(run, task);
				if (activeBatch)
					await fallbackForeachBatchAfterTerminal(
						cwd,
						run,
						activeBatch,
						"batch leader timed out before a backend handle was recovered",
					);
				changed = true;
			}
			continue;
		}
		pollItems.push({ order, workflowRunId: run.runId, task, handle });
	}

	const api = pollItems.length > 0 ? await loadSubagentApi() : undefined;
	const pollResults = api
		? await allSettledBounded(
				pollItems,
				REFRESH_STATUS_RECONCILE_CONCURRENCY,
				(item) => pollSubagentForRefresh(api, item),
			)
		: [];
	const refreshErrors: unknown[] = [];

	for (const [pollIndex, pollResult] of pollResults.entries()) {
		if (pollResult.status === "rejected") {
			refreshErrors.push(pollResult.reason);
			const item = pollItems[pollIndex];
			if (item && isTaskTimedOut(item.task)) {
				try {
					await interruptTimedOutSubagent(cwd, run, item.task);
					markSubagentTaskTimedOut(item.task);
					releaseLiveModelWorkerSlotForTask(run, item.task);
					const batch = activeForeachBatchRecordForTask(run, item.task);
					if (batch) {
						await fallbackForeachBatchAfterTerminal(
							cwd,
							run,
							batch,
							"batch leader timed out after backend refresh failure",
						);
					}
				} catch (error) {
					markCancellationFailed(item.task, "timeout", error);
					refreshErrors.push(error);
				}
				changed = true;
			}
			continue;
		}
		const { task, handle, snapshot, reconcileMs, statusPollMs } =
			pollResult.value;
		recordTaskTimingTelemetry(task, {
			refreshReconcileMs: reconcileMs,
			refreshStatusPollMs: statusPollMs,
		});
		telemetryChanged = true;

		if (snapshot === null) {
			if (isTaskTimedOut(task)) {
				try {
					await interruptTimedOutSubagent(cwd, run, task);
					markSubagentTaskTimedOut(task);
					releaseLiveModelWorkerSlotForTask(run, task);
					const batch = activeForeachBatchRecordForTask(run, task);
					if (batch)
						await fallbackForeachBatchAfterTerminal(
							cwd,
							run,
							batch,
							"batch leader timed out while backend status was unavailable",
						);
				} catch (error) {
					markCancellationFailed(task, "timeout", error);
					refreshErrors.push(error);
				}
				changed = true;
			}
			continue;
		}

		const activeAttempt =
			snapshot.attempts?.find(
				(attempt) => attempt.attemptId === handle.attemptId,
			) ?? snapshot.attempts?.at(-1);
		const nextPid = activeAttempt?.workerPid ?? activeAttempt?.pid ?? task.pid;
		if (task.pid !== nextPid) {
			task.pid = nextPid;
			changed = true;
		}
		if (snapshot.status === "running" || snapshot.status === "pending") {
			await refreshRunningArtifactGraphPartialOutput(cwd, task, snapshot).catch(
				() => undefined,
			);
			if (task.statusDetail !== "running") {
				task.statusDetail = "running";
				changed = true;
			}
			const nextLastMessage = activeAttempt?.heartbeatAt
				? `pi-subagent heartbeat ${activeAttempt.heartbeatAt}`
				: "pi-subagent running";
			if (task.lastMessage !== nextLastMessage) {
				task.lastMessage = nextLastMessage;
				changed = true;
			}
			if (isTaskTimedOut(task)) {
				try {
					await interruptTimedOutSubagent(cwd, run, task);
					markSubagentTaskTimedOut(task);
					releaseLiveModelWorkerSlotForTask(run, task);
					const batch = activeForeachBatchRecordForTask(run, task);
					if (batch)
						await fallbackForeachBatchAfterTerminal(
							cwd,
							run,
							batch,
							"batch leader timed out",
						);
				} catch (error) {
					markCancellationFailed(task, "timeout", error);
					refreshErrors.push(error);
				}
				changed = true;
			}
			continue;
		}

		if (await materializeTerminalSubagentResult(cwd, run, task, snapshot)) {
			releaseLiveModelWorkerSlotForTask(run, task);
			changed = true;
		}
	}

	if (changed || telemetryChanged) await writeRunRecord(cwd, run);
	if (refreshErrors.length > 0) {
		throw new AggregateError(
			refreshErrors,
			"one or more subagent refresh polls failed",
		);
	}
	return run;
}

async function pollSubagentForRefresh(
	api: SubagentApi,
	item: RefreshPollItem,
): Promise<RefreshPollResult> {
	const { handle } = item;
	const reconcileStartedAtMs = Date.now();
	try {
		await awaitSubagentOperation(
			() =>
				api.reconcileSubagentRun({
					cwd: handle.cwd,
					runsDir: handle.runsDir,
					runId: handle.runId,
				}),
			{
				operation: "reconcile",
				context: `workflow run ${item.workflowRunId} task ${item.task.taskId} subagent run ${handle.runId}/${handle.attemptId}`,
				timeoutMs: SUBAGENT_REFRESH_OPERATION_TIMEOUT_MS,
			},
		);
	} catch (error) {
		throw refreshPollError(item, "reconcile", error);
	}
	const reconcileMs = elapsedSince(reconcileStartedAtMs);
	const statusPollStartedAtMs = Date.now();
	let snapshot: SubagentRunStatusSnapshot | null;
	try {
		snapshot = await awaitSubagentOperation(
			() =>
				api.getSubagentStatus({
					cwd: handle.cwd,
					runsDir: handle.runsDir,
					runId: handle.runId,
					attemptId: handle.attemptId,
				}),
			{
				operation: "status",
				context: `workflow run ${item.workflowRunId} task ${item.task.taskId} subagent run ${handle.runId}/${handle.attemptId}`,
				timeoutMs: SUBAGENT_REFRESH_OPERATION_TIMEOUT_MS,
			},
		);
	} catch (error) {
		throw refreshPollError(item, "status", error);
	}
	const statusPollMs = elapsedSince(statusPollStartedAtMs);
	return { ...item, snapshot, reconcileMs, statusPollMs };
}

function refreshPollError(
	item: RefreshPollItem,
	operation: RefreshPollOperation,
	error: unknown,
): Error {
	const { task, handle } = item;
	return new Error(
		`subagent refresh ${operation} failed for workflow run ${item.workflowRunId} task ${task.taskId} (${task.specId}) subagent run ${handle.runId}/${handle.attemptId}`,
		{ cause: error },
	);
}

async function allSettledBounded<T, R>(
	items: readonly T[],
	limit: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
	const results = new Array<PromiseSettledResult<R>>(items.length);
	let nextIndex = 0;
	const workerCount = Math.min(Math.max(1, Math.floor(limit)), items.length);
	await Promise.all(
		Array.from({ length: workerCount }, async () => {
			while (true) {
				const index = nextIndex;
				nextIndex += 1;
				if (index >= items.length) return;
				try {
					results[index] = {
						status: "fulfilled",
						value: await worker(items[index]!, index),
					};
				} catch (reason) {
					results[index] = { status: "rejected", reason };
				}
			}
		}),
	);
	return results;
}

async function refreshRunningArtifactGraphPartialOutput(
	cwd: string,
	task: WorkflowTaskRunRecord,
	snapshot: SubagentRunStatusSnapshot,
): Promise<void> {
	const partial = task.artifactGraph?.output.partial;
	if (!partial || partial.paths.length === 0) return;
	const outputRef = findLog(snapshot, "output");
	const outputFile = fromProjectPath(cwd, task.files.output);
	const artifactRoot = task.backendFiles?.runsDir
		? fromProjectPath(task.cwd, task.backendFiles.runsDir)
		: undefined;
	await copyLogOrEmpty(snapshot, outputRef, outputFile, artifactRoot);
	await writeWorkflowPartialOutputLedgerFromFile({
		taskDir: dirname(fromProjectPath(cwd, task.files.result)),
		outputFile,
		allowedPaths: partial.paths,
	});
}

async function interruptTimedOutSubagent(
	cwd: string,
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
): Promise<void> {
	await acknowledgeSubagentTaskInterrupted(
		cwd,
		run,
		task,
		"workflow timeout",
	);
}

function markCancellationFailed(
	task: WorkflowTaskRunRecord,
	reason: string,
	error: unknown,
): void {
	task.statusDetail = "cancellation_failed";
	task.lastMessage = `${reason} cancellation failed; backend handle preserved: ${error instanceof Error ? error.message : String(error)}`;
}

function markSubagentTaskTimedOut(task: WorkflowTaskRunRecord): void {
	markTaskTimedOut(task);
	task.backendHandle = undefined;
	task.backendTaskId = task.taskId;
	task.pid = undefined;
}

function isStaleLaunchClaim(task: WorkflowTaskRunRecord): boolean {
	if (
		(task.statusDetail !== "launching" &&
			task.statusDetail !== "launch_ack_pending" &&
			task.statusDetail !== "launch_ack_timeout" &&
			task.statusDetail !== "launch_ack_aborted") ||
		!task.startedAt
	)
		return false;
	const startedAtMs = Date.parse(task.startedAt);
	return (
		Number.isFinite(startedAtMs) &&
		Date.now() - startedAtMs > STALE_LAUNCH_CLAIM_GRACE_MS
	);
}

function resetStaleLaunchClaim(task: WorkflowTaskRunRecord): void {
	clearTaskToolResultBudgetPendingConfiguration(task);
	task.status = "pending";
	task.statusDetail = "pending";
	task.startedAt = undefined;
	task.backendHandle = undefined;
	task.backendFiles = undefined;
	task.backendTaskId = task.taskId;
	task.pid = undefined;
	task.lastMessage = "stale pi-subagent launch claim reset";
}

async function materializeTerminalSubagentResult(
	cwd: string,
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	snapshot: SubagentRunStatusSnapshot,
): Promise<boolean> {
	const outputRef = findLog(snapshot, "output");
	const stderrRef = findLog(snapshot, "stderr");
	const resultRef = findLog(snapshot, "result");
	const outputFile = fromProjectPath(cwd, task.files.output);
	const stderrFile = fromProjectPath(cwd, task.files.stderr);
	const resultFile = fromProjectPath(cwd, task.files.result);
	const artifactRoot = task.backendFiles?.runsDir
		? fromProjectPath(task.cwd, task.backendFiles.runsDir)
		: undefined;

	await mkdir(dirname(outputFile), { recursive: true });
	const [outputCopy, stderrCopy] = await Promise.all([
		copyLogOrEmptyMeasured(snapshot, outputRef, outputFile, artifactRoot),
		copyLogOrEmptyMeasured(snapshot, stderrRef, stderrFile, artifactRoot),
	]);
	recordTaskTimingTelemetry(task, {
		terminalOutputCopyMs: outputCopy.durationMs,
		terminalStderrCopyMs: stderrCopy.durationMs,
		terminalOutputBytes: outputCopy.bytes,
		terminalStderrBytes: stderrCopy.bytes,
	});

	const subagentResult = resultRef
		? await readJsonLoose<Record<string, unknown>>(
				safeArtifactPath(snapshot, resultRef, artifactRoot),
			)
		: undefined;
	const toolCalls = await readToolCallsSummary(
		snapshot,
		subagentResult,
		artifactRoot,
	);
	const failedToolCalls = await readFailedToolCalls(
		snapshot,
		subagentResult,
		artifactRoot,
	);
	const [outputText, stderrText] = await Promise.all([
		readFile(outputFile, "utf8").catch(() => ""),
		readFile(stderrFile, "utf8").catch(() => ""),
	]);
	const outputBytes = Buffer.byteLength(outputText, "utf8");
	let statusInfo = workflowStatusFromSubagent(
		snapshot,
		subagentResult,
		outputBytes,
	);
	const deterministicBootFailure = classifyDeterministicBootFailure({
		statusInfo,
		stderrText,
		outputBytes,
		contextLengthExceeded: Boolean(
			(subagentResult?.metadata as any)?.contextLengthExceeded ??
				snapshot.metadata?.contextLengthExceeded,
		),
	});
	if (deterministicBootFailure) {
		statusInfo = {
			status: "failed",
			failureKind: "deterministic_boot",
			errorMessage: deterministicBootFailure,
		};
	}
	const completedAt =
		typeof subagentResult?.completedAt === "string"
			? subagentResult.completedAt
			: (snapshot.completedAt ?? nowIso());
	const startedAt =
		typeof subagentResult?.startedAt === "string"
			? subagentResult.startedAt
			: snapshot.startedAt;
	const exitCode =
		typeof subagentResult?.exitCode === "number"
			? subagentResult.exitCode
			: statusInfo.status === "completed"
				? 0
				: 1;
	let errorMessage =
		statusInfo.errorMessage ??
		(typeof subagentResult?.errorMessage === "string"
			? subagentResult.errorMessage
			: undefined);
	const contextLengthExceeded = Boolean(
		(subagentResult?.metadata as any)?.contextLengthExceeded ??
			snapshot.metadata?.contextLengthExceeded,
	);
	const permanentModelFailure = classifyPermanentModelFailure({
		statusInfo,
		errorMessage,
		stderrText,
		outputBytes,
		contextLengthExceeded,
		subagentResult,
		snapshotMetadata: snapshot.metadata,
	});
	if (permanentModelFailure) {
		statusInfo = {
			status: "failed",
			failureKind: "permanent_model_failure",
			errorMessage: permanentModelFailure,
		};
		errorMessage = permanentModelFailure;
	}
	recordTerminalTaskObservability({
		task,
		snapshot,
		subagentResult,
		startedAt,
		completedAt,
	});
	const activeForeachBatch = activeForeachBatchRecordForTask(run, task);
	if (activeForeachBatch && task.foreachBatch?.role === "leader") {
		activeForeachBatch.physicalExecution = {
			leaderTaskId: task.taskId,
			...(task.usage === undefined ? {} : { usage: task.usage }),
			...(task.timing === undefined ? {} : { timing: task.timing }),
		};
		const changed = await materializeTerminalForeachBatchResult({
			cwd,
			run,
			task,
			record: activeForeachBatch,
			rawOutput: outputText,
			stderr: stderrText,
			snapshot,
			status: terminalForeachBatchStatus(statusInfo.status),
			completedAt,
			startedAt,
			exitCode,
		});
		await recordTerminalParentSubagentChildEvent(run, task, snapshot);
		return changed;
	}
	if (statusInfo.status === "completed") {
		observeLiveModelWorkerCompletion(
			modelRateLimitBackoffKey(task),
			task.timing?.executionMs,
		);
	}
	if (task.artifactGraph?.enabled && statusInfo.status === "completed") {
		const changed = await materializeTerminalArtifactGraphResult(
			cwd,
			run,
			task,
			{
				outputFile,
				stderrFile,
				resultFile,
				completedAt,
				startedAt,
				exitCode,
				subagentResult,
				subagentToolCalls: failedToolCalls,
				subagentToolCallsSummary: toolCalls,
			},
		);
		await recordTerminalParentSubagentChildEvent(run, task, snapshot);
		return changed;
	}
	if (
		shouldAttemptArtifactGraphSalvage({
			task,
			statusInfo,
			outputBytes,
			outputText,
			exitCode,
			contextLengthExceeded,
			subagentResult,
			snapshot,
		})
	) {
		const changed = await materializeTerminalArtifactGraphResult(
			cwd,
			run,
			task,
			{
				outputFile,
				stderrFile,
				resultFile,
				completedAt,
				startedAt,
				exitCode,
				subagentResult,
				subagentToolCalls: failedToolCalls,
				subagentToolCallsSummary: toolCalls,
				salvage: {
					failureKind:
						statusInfo.failureKind ?? snapshot.failureKind ?? "model",
					subagentStatus: snapshot.status,
					subagentFailureKind: snapshot.failureKind,
				},
			},
		);
		await recordTerminalParentSubagentChildEvent(run, task, snapshot);
		return changed;
	}
	const workflowResult = {
		status: statusInfo.status,
		failureKind: statusInfo.failureKind,
		exitCode,
		completedAt,
		startedAt,
		errorMessage,
		noFinalOutput: outputBytes === 0,
		contextLengthExceeded,
		subagent: {
			runId: snapshot.runId,
			attemptId: snapshot.attemptId,
			backend: snapshot.backend,
			failureKind: snapshot.failureKind,
			resultPath: resultRef?.path,
			artifactCwd: resultRef?.artifactCwd,
			metadata: snapshot.metadata,
			completion: snapshot.completion,
			toolsConfigured: task.tools,
			toolCalls: toolCalls?.summary,
			toolCallsPath: failedToolCalls?.ref.path,
			toolCallsSummaryPath: toolCalls?.ref.path,
			toolCallsArtifactCwd:
				failedToolCalls?.ref.artifactCwd ?? toolCalls?.ref.artifactCwd,
			failedToolCalls: failedToolCalls?.records,
		},
	};
	if (
		shouldRetryTransientModelFailure(statusInfo, workflowResult, outputBytes)
	) {
		const retryAttempt = (task.launchRetry?.attempts ?? 0) + 1;
		const rateLimitBackoffMs = transientModelRateLimitBackoffMs({
			attempt: retryAttempt,
			modelBackoffKey: modelRateLimitBackoffKey(task),
			errorMessage,
			stderrText,
			subagentResult,
			snapshotMetadata: snapshot.metadata,
		});
		await recordSharedModelRateLimitBackoff(task, rateLimitBackoffMs);
		await writeJson(
			transientFailureAttemptPath(resultFile, retryAttempt),
			workflowResult,
		);
		const changed = retryOrFailTransientSubagentFailure(task, {
			reason:
				rateLimitBackoffMs === undefined
					? (statusInfo.failureKind ?? "model")
					: "model_rate_limit",
			message: errorMessage ?? "pi-subagent run failed before producing output",
			backoffMs: rateLimitBackoffMs,
		});
		await recordTerminalParentSubagentChildEvent(run, task, snapshot);
		return changed;
	}
	await writeJson(resultFile, workflowResult);

	const completedAfterTimeout = resultCompletedAfterTimeout(task, completedAt);
	const changed = await applyTaskResultArtifact(cwd, task, {
		resultFile,
		result: workflowResult,
		status: statusInfo.status,
		completedAfterTimeout,
	});
	if (isTerminalTaskStatus(task.status)) {
		delete task.backendHandle;
		delete task.backendFiles;
	}
	await recordTerminalParentSubagentChildEvent(run, task, snapshot);
	return changed;
}

type TerminalForeachBatchMaterializationInput = {
	cwd: string;
	run: WorkflowRunRecord;
	task: WorkflowTaskRunRecord;
	record: WorkflowForeachBatchRecord;
	rawOutput: string;
	stderr: string;
	snapshot: SubagentRunStatusSnapshot;
	status: "completed" | "failed" | "interrupted";
	completedAt: string;
	startedAt?: string;
	exitCode: number;
};

function terminalForeachBatchStatus(
	status: string,
): "completed" | "failed" | "interrupted" {
	if (status === "completed") return "completed";
	return status === "interrupted" ? "interrupted" : "failed";
}

function foreachBatchArtifactDirectory(
	cwd: string,
	run: WorkflowRunRecord,
	record: WorkflowForeachBatchRecord,
): string {
	// The digest prevents a corrupt persisted batch id from becoming a path.
	return join(
		workflowRunDir(cwd, run.runId),
		"foreach-batches",
		sha256Text(record.batchId),
	);
}

async function writeForeachBatchTextAtomic(
	file: string,
	value: string,
): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
	await writeFile(temporary, value, "utf8");
	await rename(temporary, file);
}

async function persistTerminalForeachBatchEvidence(
	input: TerminalForeachBatchMaterializationInput,
): Promise<void> {
	const directory = foreachBatchArtifactDirectory(
		input.cwd,
		input.run,
		input.record,
	);
	const rawFile = join(directory, `raw-attempt-${input.record.attempt}.md`);
	const receiptFile = join(
		directory,
		`receipt-attempt-${input.record.attempt}.json`,
	);
	await writeForeachBatchTextAtomic(rawFile, input.rawOutput);
	await writeJsonAtomic(receiptFile, {
		schema: "workflow-foreach-batch-receipt-v1",
		batchId: input.record.batchId,
		attempt: input.record.attempt,
		phase: "terminal_received",
		members: input.record.members.map((member) => ({
			taskId: member.taskId,
			specId: member.specId,
			role: member.role,
		})),
		status: input.status,
		completedAt: input.completedAt,
		startedAt: input.startedAt,
		exitCode: input.exitCode,
		backend: {
			runId: input.snapshot.runId,
			attemptId: input.snapshot.attemptId,
			backend: input.snapshot.backend,
			failureKind: input.snapshot.failureKind,
		},
		rawSha256: sha256Text(input.rawOutput),
	});
	const receivedAt = nowIso();
	input.record.terminal = {
		receivedAt,
		rawPath: toProjectPath(input.cwd, rawFile),
		receiptPath: toProjectPath(input.cwd, receiptFile),
		rawSha256: sha256Text(input.rawOutput),
		backendRunId: input.snapshot.runId,
		backendAttemptId: input.snapshot.attemptId,
		status: input.status,
		completedAt: input.completedAt,
		...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
		exitCode: input.exitCode,
	};
	if (input.record.dispatch) {
		input.record.dispatch.state = "terminal_received";
		input.record.dispatch.terminalReceivedAt = receivedAt;
	}
	setForeachBatchPhase(input.run, input.record, "terminal_received");
	await writeRunRecord(input.cwd, input.run);
}

async function fallbackForeachBatchAfterTerminal(
	cwd: string,
	run: WorkflowRunRecord,
	record: WorkflowForeachBatchRecord,
	reason: string,
): Promise<void> {
	const directory = foreachBatchArtifactDirectory(cwd, run, record);
	const diagnosticFile = join(
		directory,
		`fallback-attempt-${record.attempt}.json`,
	);
	await writeJsonAtomic(diagnosticFile, {
		schema: "workflow-foreach-batch-fallback-v1",
		batchId: record.batchId,
		attempt: record.attempt,
		reason,
		terminal: record.terminal,
	});
	setForeachBatchPhase(run, record, "fallback_prepared");
	record.fallback = {
		preparedAt: nowIso(),
		reason,
		diagnosticsPath: toProjectPath(cwd, diagnosticFile),
	};
	await writeRunRecord(cwd, run);
	applyForeachBatchFallback(run, record, reason);
	await writeRunRecord(cwd, run);
}

async function foreachBatchMemberParseOptions(
	cwd: string,
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
) {
	const artifactOptions = task.artifactGraph?.output;
	return {
		analysisRequired: artifactOptions?.analysisRequired ?? true,
		refsRequired: artifactOptions?.refsRequired ?? true,
		refsMinItems: artifactOptions?.refsMinItems,
		refsUrlValidation: artifactOptions?.refsUrlValidation,
		refsAllowedLocators: await directDynamicSynthesisAllowedRefLocators(
			cwd,
			run,
			task,
		),
		maxDigestChars: artifactOptions?.maxDigestChars,
		controlJsonSchema: await readTaskControlJsonSchema(task),
		outputProfile: task.dynamicGenerated?.outputProfile,
	};
}

async function commitTerminalForeachBatch(
	input: Omit<TerminalForeachBatchMaterializationInput, "snapshot" | "status">,
): Promise<boolean> {
	const {
		cwd,
		run,
		record,
		rawOutput,
		stderr,
		completedAt,
		startedAt,
		exitCode,
	} = input;
	if (record.stateRootSha256 || record.capabilitySubjectSha256) {
		const capability = await issueForeachBatchCapability(cwd, record);
		await assertForeachBatchCapability(cwd, record, capability);
	}
	const tasks = foreachBatchTasks(run, record);
	setForeachBatchPhase(run, record, "committing");
	record.commit ??= { startedAt: nowIso() };
	await writeRunRecord(cwd, run);

	const expectedTaskIds = record.members.map((member) => member.taskId);
	const envelope = parseForeachBatchEnvelope(rawOutput, expectedTaskIds);
	if (!envelope.valid) {
		await fallbackForeachBatchAfterTerminal(
			cwd,
			run,
			record,
			`invalid foreach batch envelope: ${envelope.reason}`,
		);
		return true;
	}
	const itemByTaskId = new Map(envelope.items.map((item) => [item.id, item]));
	let validated: Array<{
		task: WorkflowTaskRunRecord;
		rawOutput: string;
		parsed: ValidParsedWorkflowOutput;
		parseOptions: Awaited<ReturnType<typeof foreachBatchMemberParseOptions>>;
	}>;
	try {
		validated = await Promise.all(
			tasks.map(async (task) => {
				const item = itemByTaskId.get(task.taskId);
				if (!item)
					throw new Error(
						`batch item ${task.taskId} is missing after envelope validation`,
					);
				const itemRawOutput = reconstructForeachBatchItemOutput(item);
				const parseOptions = await foreachBatchMemberParseOptions(
					cwd,
					run,
					task,
				);
				const parsed = await validateWorkflowOutputForBundle(
					itemRawOutput,
					parseOptions,
				);
				if (!parsed.valid) {
					throw new Error(
						`batch item ${task.taskId} is invalid: ${parsed.issues
							.map((issue) => issue.message)
							.join("; ")}`,
					);
				}
				return {
					task,
					rawOutput: itemRawOutput,
					parsed: parsed as ValidParsedWorkflowOutput,
					parseOptions,
				};
			}),
		);
	} catch (error) {
		await fallbackForeachBatchAfterTerminal(
			cwd,
			run,
			record,
			`invalid foreach batch member output: ${error instanceof Error ? error.message : String(error)}`,
		);
		return true;
	}

	// All controls/schemas/refs are now valid in memory. No child bundle has
	// been written before this point, so an invalid sibling cannot be accepted.
	await Promise.all(
		validated.map(async (candidate) => {
			const taskDirectory = dirname(
				fromProjectPath(cwd, candidate.task.files.result),
			);
			await mkdir(taskDirectory, { recursive: true });
			const itemStderr =
				candidate.task.foreachBatch?.role === "leader" ? stderr : "";
			await Promise.all([
				writeForeachBatchTextAtomic(
					fromProjectPath(cwd, candidate.task.files.output),
					candidate.rawOutput,
				),
				writeForeachBatchTextAtomic(
					fromProjectPath(cwd, candidate.task.files.stderr),
					itemStderr,
				),
			]);
			await writeValidatedWorkflowTaskArtifactBundle(
				{
					taskDir: taskDirectory,
					rawOutput: candidate.rawOutput,
					startedAt,
					completedAt,
					exitCode,
					stderr: itemStderr,
					...candidate.parseOptions,
				},
				candidate.parsed,
			);
		}),
	);

	setForeachBatchPhase(run, record, "completed");
	if (record.dispatch) {
		record.dispatch.state = "reconciled";
		record.dispatch.reconciledAt = nowIso();
	}
	record.commit = {
		startedAt: record.commit.startedAt,
		completedAt: nowIso(),
	};
	for (const task of tasks) {
		setTaskTerminal(task, "completed", "completed", {
			completedAt,
			exitCode,
			lastMessage: "completed from foreach batch demux",
		});
		delete task.backendHandle;
		delete task.backendFiles;
		if (task.foreachBatch?.role === "member") task.backendTaskId = task.taskId;
	}
	await writeRunRecord(cwd, run);
	return true;
}

async function materializeTerminalForeachBatchResult(
	input: TerminalForeachBatchMaterializationInput,
): Promise<boolean> {
	await persistTerminalForeachBatchEvidence(input);
	if (input.status !== "completed") {
		await fallbackForeachBatchAfterTerminal(
			input.cwd,
			input.run,
			input.record,
			`batch backend terminal ${input.status}`,
		);
		return true;
	}
	return await commitTerminalForeachBatch(input);
}

/** Recover durable terminal/fallback boundaries without recomputing membership. */
export async function recoverForeachBatchRuntime(
	cwd: string,
	run: WorkflowRunRecord,
): Promise<boolean> {
	let changed = false;
	for (const record of run.foreachBatches ?? []) {
		assertForeachBatchRecord(record);
		if (record.stateRootSha256 || record.capabilitySubjectSha256) {
			const capability = await issueForeachBatchCapability(cwd, record);
			await assertForeachBatchCapability(cwd, record, capability);
		}
		foreachBatchTasks(run, record);
		if (record.phase === "fallback_prepared") {
			const reason =
				record.fallback?.reason ?? "incomplete foreach batch fallback";
			applyForeachBatchFallback(run, record, reason);
			changed = true;
			continue;
		}
		if (record.phase === "terminal_received" || record.phase === "committing") {
			const terminal = record.terminal;
			if (!terminal) {
				throw new Error(
					`foreach batch ${record.batchId} has no terminal receipt for ${record.phase}`,
				);
			}
			if (terminal.status !== "completed") {
				await fallbackForeachBatchAfterTerminal(
					cwd,
					run,
					record,
					record.fallback?.reason ??
						`batch backend terminal ${terminal.status}`,
				);
				changed = true;
				continue;
			}
			const rawOutput = await readFile(
				fromProjectPath(cwd, terminal.rawPath),
				"utf8",
			);
			if (sha256Text(rawOutput) !== terminal.rawSha256) {
				throw new Error(
					`foreach batch ${record.batchId} terminal raw evidence integrity failed`,
				);
			}
			const leader = foreachBatchLeaderTask(run, record);
			const stderr = await readFile(
				fromProjectPath(cwd, leader.files.stderr),
				"utf8",
			).catch(() => "");
			await commitTerminalForeachBatch({
				cwd,
				run,
				task: leader,
				record,
				rawOutput,
				stderr,
				completedAt: terminal.completedAt ?? nowIso(),
				startedAt: terminal.startedAt,
				exitCode: terminal.exitCode ?? 0,
			});
			changed = true;
			continue;
		}
		if (record.phase !== "launching") continue;
		const [leader, member] = foreachBatchTasks(run, record);
		if (leader.status === "pending" && !leader.backendHandle) {
			if (record.dispatch?.state === "reserved") {
				const reason =
					"dispatch reservation has no durable terminal receipt; refusing reuse";
				setForeachBatchPhase(run, record, "non_reusable");
				record.dispatch.state = "non_reusable";
				record.dispatch.reason = reason;
				for (const task of [leader, member]) {
					setTaskTerminal(task, "failed", "batch_dispatch_unresolved", {
						exitCode: 1,
						lastMessage: reason,
					});
				}
			} else {
				setForeachBatchPhase(run, record, "prepared");
				member.status = "pending";
				member.statusDetail = "pending";
				member.startedAt = undefined;
				member.lastMessage =
					"foreach batch launch was not claimed; retrying exact prepared pair";
			}
			changed = true;
		}
	}
	if (changed) await writeRunRecord(cwd, run);
	return changed;
}

export async function recoverForeachBatchRuntimeForTests(
	cwd: string,
	run: WorkflowRunRecord,
): Promise<boolean> {
	return await recoverForeachBatchRuntime(cwd, run);
}

function artifactGraphRetrySession(
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	subagentResult: Record<string, unknown> | undefined,
	attempt: number,
): { repairMode: "same_session" | "new_session"; sessionId: string } {
	if (task.outputRetry?.repairMode === "same_session") {
		return {
			repairMode: "new_session",
			sessionId: retryWorkflowTaskSessionId(run, task, attempt),
		};
	}
	const expectedSessionId = workflowTaskSessionId(run, task);
	const metadata = subagentResult?.metadata;
	const metadataRecord =
		metadata && typeof metadata === "object" && !Array.isArray(metadata)
			? (metadata as Record<string, unknown>)
			: undefined;
	const actualSessionId = metadataRecord?.sessionId;
	const session = metadataRecord?.session;
	const sessionRecord =
		session && typeof session === "object" && !Array.isArray(session)
			? (session as Record<string, unknown>)
			: undefined;
	const sessionDisposition = sessionRecord?.disposition;
	const sessionId = sessionRecord?.id;
	const sessionRequested = sessionRecord?.requested;
	if (
		workflowExperimentalFlagEnabled(EXPERIMENTAL_SAME_SESSION_REPAIR_ENV) &&
		typeof actualSessionId === "string" &&
		actualSessionId === expectedSessionId &&
		(typeof sessionId !== "string" || sessionId === expectedSessionId) &&
		sessionRequested !== false &&
		(sessionDisposition === "created" || sessionDisposition === "resumed")
	) {
		return { repairMode: "same_session", sessionId: expectedSessionId };
	}
	return {
		repairMode: "new_session",
		sessionId: retryWorkflowTaskSessionId(run, task, attempt),
	};
}

async function measureTerminalArtifactBundleWrite<T>(
	task: WorkflowTaskRunRecord,
	write: () => Promise<T>,
): Promise<T> {
	const startedAtMs = Date.now();
	try {
		return await write();
	} finally {
		recordTaskTimingTelemetry(task, {
			terminalArtifactBundleWriteMs: elapsedSince(startedAtMs),
		});
	}
}

async function materializeTerminalArtifactGraphResult(
	cwd: string,
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	options: {
		outputFile: string;
		stderrFile: string;
		resultFile: string;
		completedAt: string;
		startedAt?: string;
		exitCode: number;
		subagentResult?: Record<string, unknown>;
		subagentToolCalls?: {
			ref: SubagentArtifactRef;
			records: WorkflowTaskFailedToolCallSummary[];
		};
		subagentToolCallsSummary?: { ref: SubagentArtifactRef; summary: unknown };
		salvage?: {
			failureKind: string;
			subagentStatus: string;
			subagentFailureKind: string | null;
		};
	},
): Promise<boolean> {
	const startedAtMs = Date.now();
	try {
		return await materializeTerminalArtifactGraphResultInner(
			cwd,
			run,
			task,
			options,
		);
	} finally {
		recordTaskTimingTelemetry(task, {
			terminalArtifactMaterializeMs: elapsedSince(startedAtMs),
		});
	}
}

async function materializeTerminalArtifactGraphResultInner(
	cwd: string,
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	options: {
		outputFile: string;
		stderrFile: string;
		resultFile: string;
		completedAt: string;
		startedAt?: string;
		exitCode: number;
		subagentResult?: Record<string, unknown>;
		subagentToolCalls?: {
			ref: SubagentArtifactRef;
			records: WorkflowTaskFailedToolCallSummary[];
		};
		subagentToolCallsSummary?: { ref: SubagentArtifactRef; summary: unknown };
		salvage?: {
			failureKind: string;
			subagentStatus: string;
			subagentFailureKind: string | null;
		};
	},
): Promise<boolean> {
	const rawOutput = await readFile(options.outputFile, "utf8").catch(() => "");
	const artifactOptions = task.artifactGraph?.output;
	if (artifactOptions?.partial && artifactOptions.partial.paths.length > 0) {
		await writeWorkflowPartialOutputLedgerFromFile({
			taskDir: dirname(options.resultFile),
			outputFile: options.outputFile,
			allowedPaths: artifactOptions.partial.paths,
		}).catch(() => undefined);
	}
	let controlJsonSchema: JsonSchema | undefined;
	try {
		controlJsonSchema = await readTaskControlJsonSchema(task);
	} catch (error) {
		return failArtifactGraphTask(task, {
			statusDetail: "control_schema_unavailable",
			message: error instanceof Error ? error.message : String(error),
		});
	}
	const refsAllowedLocators = await directDynamicSynthesisAllowedRefLocators(
		cwd,
		run,
		task,
	);
	const parseOptions = {
		analysisRequired: artifactOptions?.analysisRequired ?? true,
		refsRequired: artifactOptions?.refsRequired ?? true,
		refsMinItems: artifactOptions?.refsMinItems,
		refsUrlValidation: artifactOptions?.refsUrlValidation,
		refsAllowedLocators,
		maxDigestChars: artifactOptions?.maxDigestChars,
		controlJsonSchema,
		outputProfile: task.dynamicGenerated?.outputProfile,
	};
	const parsed = parseWorkflowOutputForBundle(rawOutput, parseOptions);
	const attempt = (task.outputRetry?.attempts ?? 0) + 1;
	const retrySession = artifactGraphRetrySession(
		run,
		task,
		options.subagentResult,
		attempt,
	);
	if (!parsed.valid) {
		await measureTerminalArtifactBundleWrite(task, () =>
			writeWorkflowTaskArtifactBundle({
				taskDir: dirname(options.resultFile),
				rawOutput,
				attempt,
				completedAt: options.completedAt,
				...parseOptions,
			}),
		);
		return retryOrFailArtifactGraphTask(task, {
			reason: "workflow_output_invalid",
			attempt,
			message: buildWorkflowOutputRetryInstructions(parsed.issues),
			...retrySession,
		});
	}

	const readCheck = await checkRequiredArtifactReads(
		dirname(options.resultFile),
		task.artifactGraph?.requiredReads ?? [],
		task.artifactGraph?.requiredReadPolicy ?? [],
		{ startedAt: options.startedAt },
	);
	if (
		readCheck.missing.length > 0 ||
		readCheck.projectionFailures.length > 0 ||
		readCheck.ledgerError
	) {
		const reason = readCheck.ledgerError
			? "required_reads_ledger_unavailable"
			: readCheck.projectionFailures.length > 0
				? "required_read_projection_failed"
				: "required_reads_missing";
		const artifacts = readCheck.ledgerError
			? [
					...(task.artifactGraph?.requiredReads ?? []).map(
						formatRequiredArtifactRead,
					),
					...(task.artifactGraph?.requiredReadPolicy ?? []).map(
						formatRequiredReadPolicyName,
					),
				]
			: [...readCheck.missing, ...readCheck.projectionFailures];
		const message = readCheck.ledgerError
			? `required workflow artifact read ledger was unavailable or corrupt: ${readCheck.ledgerError}; required reads could not be verified: ${artifacts.join(", ")}`
			: formatRequiredReadFailureMessage(readCheck);
		await measureTerminalArtifactBundleWrite(task, () =>
			writeArtifactGraphMissingReadsAttempt(
				dirname(options.resultFile),
				rawOutput,
				attempt,
				readCheck.missing,
				options.completedAt,
				{
					failureKind: reason,
					errorMessage: message,
					projectionFailures: readCheck.projectionFailures,
				},
			),
		);
		return retryOrFailArtifactGraphTask(task, {
			reason,
			attempt,
			message,
			artifacts,
			...retrySession,
		});
	}

	const stderr = await readFile(options.stderrFile, "utf8").catch(() => "");
	const written = await measureTerminalArtifactBundleWrite(task, () =>
		writeWorkflowTaskArtifactBundle({
			taskDir: dirname(options.resultFile),
			rawOutput,
			startedAt: options.startedAt,
			completedAt: options.completedAt,
			exitCode: options.exitCode,
			stderr,
			subagentToolCallsPath: options.subagentToolCalls?.ref.path,
			subagentToolCallsSummaryPath: options.subagentToolCallsSummary?.ref.path,
			subagentToolCallsArtifactCwd:
				options.subagentToolCalls?.ref.artifactCwd ??
				options.subagentToolCallsSummary?.ref.artifactCwd,
			subagentFailedToolCalls: options.subagentToolCalls?.records,
			...(options.salvage
				? {
						salvagedFromFailureKind: options.salvage.failureKind,
						subagentWarning:
							"pi-subagent reported failure before a valid final workflow output was salvaged",
						subagentStatus: options.salvage.subagentStatus,
						subagentFailureKind: options.salvage.subagentFailureKind,
					}
				: {}),
			...parseOptions,
		}),
	);
	if (!written.valid) {
		return retryOrFailArtifactGraphTask(task, {
			reason: "workflow_output_invalid",
			attempt,
			message: buildWorkflowOutputRetryInstructions(written.parsed.issues),
			...retrySession,
		});
	}
	const completedAfterTimeout = resultCompletedAfterTimeout(
		task,
		written.result.completedAt,
	);
	const changed = await applyTaskResultArtifact(cwd, task, {
		resultFile: options.resultFile,
		result: written.result as unknown as Record<string, unknown>,
		status: "completed",
		completedAfterTimeout,
	});
	if (isTerminalTaskStatus(task.status)) {
		delete task.backendHandle;
		delete task.backendFiles;
	}
	return changed;
}

async function readTaskControlJsonSchema(
	task: WorkflowTaskRunRecord,
): Promise<JsonSchema | undefined> {
	const schemaPath = task.artifactGraph?.output.controlSchemaPath;
	if (!schemaPath) return undefined;
	return JSON.parse(await readFile(schemaPath, "utf8")) as JsonSchema;
}

async function directDynamicSynthesisAllowedRefLocators(
	cwd: string,
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
): Promise<string[] | undefined> {
	if (run.provenance?.mode !== "direct-dynamic") return undefined;
	if (task.dynamicGenerated?.outputProfile !== "synthesis_v1") return undefined;
	const currentIndex = run.tasks.findIndex(
		(candidate) => candidate.specId === task.specId,
	);
	const artifactLocators = new Set<string>();
	const sourceLocators = new Set<string>();
	const supportedSourceLocators = new Set<string>();
	for (const [index, candidate] of run.tasks.entries()) {
		if (candidate.specId === task.specId) continue;
		if (currentIndex >= 0 && index > currentIndex) continue;
		if (
			candidate.dynamicGenerated?.controllerSpecId !==
			task.dynamicGenerated.controllerSpecId
		)
			continue;
		if (candidate.status !== "completed") continue;
		addTaskArtifactRefLocators(artifactLocators, candidate);
		for (const locator of await readTaskRefsLocators(cwd, candidate)) {
			sourceLocators.add(locator);
		}
		for (const locator of await readTaskPositiveClaimSupportLocators(
			cwd,
			candidate,
		)) {
			supportedSourceLocators.add(locator);
		}
	}
	const allowed = new Set([
		...artifactLocators,
		...(supportedSourceLocators.size > 0
			? supportedSourceLocators
			: sourceLocators),
	]);
	return [...allowed].sort();
}

function addTaskArtifactRefLocators(
	allowed: Set<string>,
	task: WorkflowTaskRunRecord,
): void {
	for (const id of [task.specId, task.taskId]) {
		if (!id) continue;
		allowed.add(id);
		allowed.add(`workflow_artifact:${id}`);
		for (const artifact of ["control", "analysis", "refs", "raw"]) {
			allowed.add(`${id}.${artifact}`);
			allowed.add(`workflow_artifact:${id}.${artifact}`);
		}
	}
}

async function readTaskRefsLocators(
	cwd: string,
	task: WorkflowTaskRunRecord,
): Promise<string[]> {
	try {
		const refsPath = join(
			dirname(fromProjectPath(cwd, task.files.result)),
			"refs.json",
		);
		const parsed = JSON.parse(await readFile(refsPath, "utf8"));
		if (!Array.isArray(parsed)) return [];
		return parsed.flatMap((ref) => {
			const locator = workflowRefLocator(ref);
			return locator ? [locator] : [];
		});
	} catch {
		return [];
	}
}

async function readTaskPositiveClaimSupportLocators(
	cwd: string,
	task: WorkflowTaskRunRecord,
): Promise<string[]> {
	if (task.dynamicGenerated?.outputProfile !== "verification_result_v1") {
		return [];
	}
	try {
		const controlPath = join(
			dirname(fromProjectPath(cwd, task.files.result)),
			"control.json",
		);
		const parsed = JSON.parse(await readFile(controlPath, "utf8"));
		return positiveClaimSupportLocators(parsed);
	} catch {
		return [];
	}
}

function positiveClaimSupportLocators(control: unknown): string[] {
	if (!control || typeof control !== "object" || Array.isArray(control)) {
		return [];
	}
	const record = control as Record<string, unknown>;
	const entries = claimSupportEntries(record);
	return [
		...new Set(
			entries.flatMap((entry) =>
				claimSupportLocators(entry, record.verdict ?? record.status),
			),
		),
	]
		.filter(Boolean)
		.sort();
}

function claimSupportEntries(
	control: Record<string, unknown>,
): Record<string, unknown>[] {
	const raw =
		control.claimSupports ??
		control.sourceSupports ??
		control.claimSourceSupport ??
		control.sourceSupport;
	if (Array.isArray(raw)) {
		return raw.filter(
			(item): item is Record<string, unknown> =>
				!!item && typeof item === "object" && !Array.isArray(item),
		);
	}
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		return [raw as Record<string, unknown>];
	}
	return hasTopLevelClaimSupportFields(control) ? [control] : [];
}

function hasTopLevelClaimSupportFields(
	control: Record<string, unknown>,
): boolean {
	return [
		"claim",
		"sourceLocators",
		"locators",
		"sources",
		"sourceRefs",
		"excerpt",
		"quote",
	].some((key) => control[key] !== undefined);
}

function claimSupportLocators(
	entry: Record<string, unknown>,
	fallbackStatus: unknown,
): string[] {
	if (
		!isPositiveClaimSupportStatus(
			entry.status ??
				entry.supportStatus ??
				entry.support ??
				entry.verdict ??
				fallbackStatus,
		)
	) {
		return [];
	}
	return [
		...refLocatorsField(entry.sourceLocators),
		...refLocatorsField(entry.locators),
		...refLocatorsField(entry.sources),
		...refLocatorsField(entry.refs),
		...refLocatorsField(entry.urls),
		...(workflowRefLocator(entry) ? [workflowRefLocator(entry)!] : []),
	];
}

function isPositiveClaimSupportStatus(value: unknown): boolean {
	return (
		value === "supports" ||
		value === "partial" ||
		value === "verified" ||
		value === "weakened"
	);
}

function refLocatorsField(value: unknown): string[] {
	if (typeof value === "string" && value.trim()) return [value.trim()];
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		const locator = workflowRefLocator(item);
		return locator ? [locator] : [];
	});
}

function workflowRefLocator(ref: unknown): string | undefined {
	if (typeof ref === "string") return ref;
	if (!ref || typeof ref !== "object" || Array.isArray(ref)) return undefined;
	const record = ref as Record<string, unknown>;
	for (const key of ["url", "ref", "path", "taskId", "source"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

export interface RequiredArtifactReadCheckResult {
	missing: string[];
	projectionFailures: string[];
	ledgerError?: string;
}

export async function checkRequiredArtifactReads(
	taskDir: string,
	requiredReads: readonly ArtifactGraphRequiredRead[],
	requiredReadPolicy: readonly RequiredWorkflowArtifactReadPolicy[] = [],
	options: { startedAt?: string } = {},
): Promise<RequiredArtifactReadCheckResult> {
	if (requiredReads.length === 0 && requiredReadPolicy.length === 0) {
		return { missing: [], projectionFailures: [] };
	}
	let ledger: WorkflowArtifactReadLedgerRecord[];
	try {
		ledger = await readWorkflowArtifactReadLedger(
			join(taskDir, "read-ledger.jsonl"),
		);
	} catch (error) {
		return {
			missing: [
				...requiredReads.map(formatRequiredArtifactRead),
				...requiredReadPolicy.map(formatRequiredReadPolicyName),
			],
			projectionFailures: [],
			ledgerError: error instanceof Error ? error.message : String(error),
		};
	}
	const attemptStartedAt =
		options.startedAt === undefined ? NaN : Date.parse(options.startedAt);
	const attemptLedger = Number.isFinite(attemptStartedAt)
		? ledger.filter((entry) => {
				const readAt = Date.parse(entry.at);
				return Number.isFinite(readAt) && readAt >= attemptStartedAt;
			})
		: ledger;
	const missing = requiredReads
		.filter(
			(required) => !requiredArtifactReadSatisfied(required, attemptLedger),
		)
		.map(formatRequiredArtifactRead);
	const projectionFailures: string[] = [];
	for (const policy of requiredReadPolicy) {
		const name = `${policy.source}.${policy.artifact}`;
		const sourceArtifactRows = attemptLedger.filter(
			(entry) =>
				entry.source === policy.source && entry.artifact === policy.artifact,
		);
		if (sourceArtifactRows.length === 0) {
			if (!missing.includes(name)) missing.push(name);
			continue;
		}
		if (
			!sourceArtifactRows.some((entry) =>
				requiredReadPolicyMatches(entry, policy),
			)
		) {
			projectionFailures.push(formatRequiredReadPolicyName(policy));
		}
	}
	return { missing, projectionFailures };
}

function requiredArtifactReadSatisfied(
	required: ArtifactGraphRequiredRead,
	ledger: readonly WorkflowArtifactReadLedgerRecord[],
): boolean {
	const normalized = normalizeRequiredArtifactRead(required);
	if (!normalized) return false;
	const matches = ledger.filter(
		(entry) =>
			entry.source === normalized.source &&
			entry.artifact === normalized.artifact &&
			requiredArtifactReadPathSatisfied(normalized, entry.path) &&
			(normalized.maxChars === undefined ||
				entry.maxChars === normalized.maxChars) &&
			(normalized.maxItems === undefined ||
				entry.maxItems === normalized.maxItems),
	);
	return normalized.count === undefined
		? matches.length > 0
		: matches.length === normalized.count;
}

function requiredArtifactReadPathSatisfied(
	required: {
		source: string;
		artifact: string;
		path?: string;
	},
	entryPath: string | undefined,
): boolean {
	if (required.path === undefined) return true;
	if (entryPath === undefined) return false;
	return requiredArtifactReadPathCandidates(
		required.path,
		required.source,
		required.artifact,
	).includes(entryPath);
}

function requiredArtifactReadPathCandidates(
	path: string,
	source: string,
	artifact: string,
): string[] {
	const candidates: string[] = [];
	const seen = new Set<string>();
	const queue = [path];
	for (let index = 0; index < queue.length && index < 32; index += 1) {
		const candidate = queue[index];
		if (candidate === undefined || seen.has(candidate)) continue;
		seen.add(candidate);
		candidates.push(candidate);
		for (const next of [
			stripRequiredReadSourcePathPrefix(candidate, source),
			stripRequiredReadArtifactPathPrefix(candidate, artifact),
			applyRequiredReadJsonPathSegmentAliases(candidate),
		]) {
			if (next !== candidate && !seen.has(next)) queue.push(next);
		}
	}
	return candidates;
}

function stripRequiredReadSourcePathPrefix(
	path: string,
	source: string,
): string {
	const sourcePrefix = `$.${source}.`;
	if (!path.startsWith(sourcePrefix)) return path;
	return `$.${path.slice(sourcePrefix.length)}`;
}

function stripRequiredReadArtifactPathPrefix(
	path: string,
	artifact: string,
): string {
	const artifactPath = `$.${artifact}`;
	if (path === artifactPath) return "$";
	const artifactPrefix = `${artifactPath}.`;
	if (!path.startsWith(artifactPrefix)) return path;
	return `$.${path.slice(artifactPrefix.length)}`;
}

const REQUIRED_READ_JSON_PATH_SEGMENT_ALIASES: Record<string, string> = {
	axes: "researchAxes",
	claimVerdicts: "claimVerdictLedger",
	factSlot: "factSlots",
	gaps: "remainingGaps",
	primarySources: "sourcePolicy",
	priorities: "verificationPriorities",
	questions: "researchQuestions",
	requiredSources: "sourcePolicy",
	scope: "researchScope",
	slots: "factSlots",
	sourceQualityRules: "sourcePolicy",
	sourceRequirements: "sourcePolicy",
	verification: "verificationPriorities",
	verificationPriority: "verificationPriorities",
	verdicts: "claimVerdictLedger",
};

function applyRequiredReadJsonPathSegmentAliases(path: string): string {
	if (path === "$") return path;
	const segments = path.slice(2).split(".");
	const aliased = segments.map(
		(segment) => REQUIRED_READ_JSON_PATH_SEGMENT_ALIASES[segment] ?? segment,
	);
	if (aliased.every((segment, index) => segment === segments[index]))
		return path;
	return `$.${aliased.join(".")}`;
}

function normalizeRequiredArtifactRead(required: ArtifactGraphRequiredRead): {
	source: string;
	artifact: string;
	path?: string;
	maxChars?: number;
	maxItems?: number;
	count?: number;
} | null {
	if (typeof required === "string") {
		const match = required.match(
			/^([A-Za-z0-9_.-]+)\.(control|analysis|refs|raw)$/,
		);
		if (!match) return null;
		return { source: match[1]!, artifact: match[2]! };
	}
	return required;
}

function formatRequiredArtifactRead(
	required: ArtifactGraphRequiredRead,
): string {
	return typeof required === "string"
		? required
		: [
				`${required.source}.${required.artifact}`,
				required.path === undefined ? undefined : `path=${required.path}`,
				required.maxChars === undefined
					? undefined
					: `maxChars=${required.maxChars}`,
				required.maxItems === undefined
					? undefined
					: `maxItems=${required.maxItems}`,
				required.count === undefined ? undefined : `count=${required.count}`,
			]
				.filter(Boolean)
				.join(" ");
}

function requiredReadPolicyMatches(
	entry: WorkflowArtifactReadLedgerRecord,
	policy: RequiredWorkflowArtifactReadPolicy,
): boolean {
	if (entry.truncated) return false;
	if (
		policy.path === undefined &&
		(policy.maxItems !== undefined || policy.maxChars !== undefined)
	) {
		return false;
	}
	if (policy.path !== undefined) {
		if (entry.path === undefined) return false;
		if (
			!requiredArtifactReadPathCandidates(
				policy.path,
				policy.source,
				policy.artifact,
			).includes(entry.path)
		) {
			return false;
		}
	}
	if (policy.maxItems !== undefined && entry.maxItems !== policy.maxItems)
		return false;
	if (policy.maxChars !== undefined && entry.maxChars !== policy.maxChars)
		return false;
	if (
		policy.minReturnedBytes !== undefined &&
		entry.returnedBytes < policy.minReturnedBytes
	) {
		return false;
	}
	return true;
}

function formatRequiredReadPolicyName(
	policy: RequiredWorkflowArtifactReadPolicy,
): string {
	const constraints = [
		policy.path === undefined ? undefined : `path=${policy.path}`,
		policy.maxItems === undefined ? undefined : `maxItems=${policy.maxItems}`,
		policy.maxChars === undefined ? undefined : `maxChars=${policy.maxChars}`,
		policy.mustNotTruncate === undefined
			? undefined
			: `mustNotTruncate=${policy.mustNotTruncate}`,
		policy.minReturnedBytes === undefined
			? undefined
			: `minReturnedBytes=${policy.minReturnedBytes}`,
	].filter(Boolean);
	return constraints.length === 0
		? `${policy.source}.${policy.artifact}`
		: `${policy.source}.${policy.artifact} (${constraints.join(", ")})`;
}

function formatRequiredReadFailureMessage(
	check: RequiredArtifactReadCheckResult,
): string {
	const parts: string[] = [];
	if (check.missing.length > 0) {
		parts.push(
			`missing required workflow artifact reads: ${check.missing.join(", ")}`,
		);
	}
	if (check.projectionFailures.length > 0) {
		parts.push(
			`required workflow artifact read projection policy failures: ${check.projectionFailures.join(", ")}`,
		);
	}
	return parts.join("; ");
}

async function writeArtifactGraphMissingReadsAttempt(
	taskDir: string,
	rawOutput: string,
	attempt: number,
	missingReads: readonly string[],
	completedAt: string,
	options: {
		failureKind?: string;
		errorMessage?: string;
		projectionFailures?: readonly string[];
	} = {},
): Promise<void> {
	await writeFile(
		join(taskDir, `raw.invalid-attempt-${attempt}.md`),
		rawOutput,
		"utf8",
	);
	await writeJson(join(taskDir, `result.invalid-attempt-${attempt}.json`), {
		schema: "workflow-task-result-v1",
		protocol: "workflow-output-sections-v1",
		status: "failed",
		completedAt,
		exitCode: 1,
		failureKind: options.failureKind ?? "required_reads_missing",
		errorMessage:
			options.errorMessage ??
			`missing required workflow artifact reads: ${missingReads.join(", ")}`,
		missingRequiredReads: [...missingReads],
		...(options.projectionFailures && options.projectionFailures.length > 0
			? { requiredReadProjectionFailures: [...options.projectionFailures] }
			: {}),
		outputValidation: { valid: true, issues: [] },
	});
}

function failArtifactGraphTask(
	task: WorkflowTaskRunRecord,
	options: { statusDetail: string; message: string },
): boolean {
	delete task.backendHandle;
	delete task.backendFiles;
	task.pid = undefined;
	task.status = "failed";
	task.statusDetail = options.statusDetail;
	task.exitCode = 1;
	task.completedAt = nowIso();
	task.lastMessage = options.message;
	return true;
}

function classifyDeterministicBootFailure(options: {
	statusInfo: {
		status: WorkflowTaskRunRecord["status"];
		failureKind?: string;
		errorMessage?: string;
	};
	stderrText: string;
	outputBytes: number;
	contextLengthExceeded: boolean;
}): string | undefined {
	if (
		options.statusInfo.status !== "failed" ||
		options.statusInfo.failureKind !== "model" ||
		options.outputBytes !== 0 ||
		options.contextLengthExceeded
	) {
		return undefined;
	}
	const text = options.stderrText;
	const deterministicPattern =
		/(Failed to load extension|Cannot find module|(?:failed to load|invalid|missing) (?:workflow )?config(?:uration)?|config(?:uration)? (?:error|failed|invalid))/i;
	if (!deterministicPattern.test(text)) return undefined;
	const excerpt =
		text
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find((line) => deterministicPattern.test(line)) ?? text.trim();
	return `deterministic-boot failure: ${excerpt.slice(0, 500)}`;
}

function metadataTextValues(metadata: unknown): string[] {
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
		return [];
	}
	const record = metadata as Record<string, unknown>;
	const values: string[] = [];
	for (const key of ["error", "errorMessage", "message", "stopReason"]) {
		const value = record[key];
		if (typeof value === "string") values.push(value);
	}
	const streamErrors = record.streamErrors;
	if (Array.isArray(streamErrors)) {
		for (const value of streamErrors) {
			if (typeof value === "string") values.push(value);
		}
	}
	return values;
}

function providerInputValidationFailure(text: string): boolean {
	const lower = text.toLowerCase();
	if (
		/(?:\b429\b|rate_limit|rate limit|temporar(?:y|ily)|overloaded|timeout|timed out|\b5xx\b|\bhttp(?:\/\d(?:\.\d)?)?[ /]?5\d\d\b|\bstatus(?: code)?[:= ]+5\d\d\b|\b5\d\d\s+(?:internal|bad gateway|service unavailable|gateway timeout|server error)\b)/.test(
			lower,
		)
	) {
		return false;
	}
	return (
		/string_above_max_length|string_below_min_length|string_too_long|string_too_short/.test(
			lower,
		) ||
		/\b(?:invalid|expected)\b.{0,120}(?:prompt_cache_key|max(?:imum)?[ _-]?length)/.test(
			lower,
		) ||
		/(?:invalid_request_error|bad_request|http 400|\b400 bad request\b)/.test(
			lower,
		)
	);
}

function classifyPermanentModelFailure(options: {
	statusInfo: {
		status: WorkflowTaskRunRecord["status"];
		failureKind?: string;
		errorMessage?: string;
	};
	errorMessage?: string;
	stderrText: string;
	outputBytes: number;
	contextLengthExceeded: boolean;
	subagentResult?: Record<string, unknown>;
	snapshotMetadata?: Record<string, unknown> | null;
}): string | undefined {
	if (
		options.statusInfo.status !== "failed" ||
		options.statusInfo.failureKind !== "model" ||
		options.outputBytes !== 0 ||
		options.contextLengthExceeded
	) {
		return undefined;
	}
	const candidates = [
		options.statusInfo.errorMessage,
		options.errorMessage,
		options.stderrText,
		...metadataTextValues(options.subagentResult?.metadata),
		...metadataTextValues(options.snapshotMetadata),
	].filter(
		(value): value is string => typeof value === "string" && value.length > 0,
	);
	const matched = candidates.find(providerInputValidationFailure);
	if (!matched) return undefined;
	return `permanent-model failure: ${matched.trim().slice(0, 500)}`;
}

function modelRateLimitBackoffKeyForModel(model: string | undefined): string {
	const trimmed = model?.trim();
	if (!trimmed) return "default";
	const provider = trimmed.includes("/") ? trimmed.split("/", 1)[0] : trimmed;
	return (provider ?? trimmed).toLowerCase();
}

function modelRateLimitBackoffKey(
	task: WorkflowTaskRunRecord,
	compiledTask?: CompiledTask,
): string {
	return modelRateLimitBackoffKeyForModel(
		compiledTask?.runtime.model ?? task.runtime.model,
	);
}

function sharedModelRateLimitBackoffScope(key: string): string {
	return key === "default" ? "model provider" : `${key} provider`;
}

function sharedModelRateLimitBackoffWaitingMessage(
	key: string,
	nextEligibleAt: string,
): string {
	return `waiting until ${nextEligibleAt} before launching pi-subagent after shared ${sharedModelRateLimitBackoffScope(key)} rate-limit backoff`;
}

async function recordSharedModelRateLimitBackoff(
	task: WorkflowTaskRunRecord,
	backoffMs: number | undefined,
): Promise<void> {
	if (backoffMs === undefined || backoffMs <= 0) return;
	const key = modelRateLimitBackoffKey(task);
	shrinkAdaptiveLiveModelWorkersForBackoff(key);
	const nowMs = Date.now();
	const nextEligibleAtMs = nowMs + Math.max(0, Math.floor(backoffMs));
	const existing = sharedModelRateLimitBackoffs.get(key);
	const boundedNextEligibleAtMs = Math.max(
		existing?.nextEligibleAtMs ?? 0,
		nextEligibleAtMs,
	);
	sharedModelRateLimitBackoffs.set(key, {
		nextEligibleAtMs: boundedNextEligibleAtMs,
		retryAfterMs: Math.max(0, boundedNextEligibleAtMs - nowMs),
		updatedAt: nowIso(),
	});
	await persistSharedModelRateLimitBackoffs(key);
}

async function sharedModelRateLimitBackoffRemaining(key: string): Promise<
	| {
			key: string;
			nextEligibleAt: string;
			remainingMs: number;
			retryAfterMs: number;
	  }
	| undefined
> {
	await loadPersistedSharedModelRateLimitBackoffs();
	const backoff = sharedModelRateLimitBackoffs.get(key);
	if (!backoff) return undefined;
	const remainingMs = Math.max(0, backoff.nextEligibleAtMs - Date.now());
	if (remainingMs <= 0) {
		sharedModelRateLimitBackoffs.delete(key);
		return undefined;
	}
	return {
		key,
		nextEligibleAt: new Date(backoff.nextEligibleAtMs).toISOString(),
		remainingMs,
		retryAfterMs: backoff.retryAfterMs,
	};
}

function isRateLimitModelFailureText(text: string): boolean {
	return /(?:\bhttp(?:\/\d(?:\.\d)?)?[ /]?429\b|\bstatus(?: code)?[:= ]+429\b|\b429\s+(?:too many requests|rate[_ -]?limit)|rate[_ -]?limit|too many requests|quota exceeded)/i.test(
		text,
	);
}

type RateLimitRetryAfterUnit = "millisecond" | "second" | "minute";

function rateLimitRetryAfterUnit(
	unit: string | undefined,
): RateLimitRetryAfterUnit {
	const lower = (unit ?? "").toLowerCase();
	if (lower === "ms" || lower.startsWith("millisecond")) return "millisecond";
	if (lower === "m" || lower.startsWith("min") || lower.startsWith("minute")) {
		return "minute";
	}
	return "second";
}

function boundedRateLimitRetryAfterMs(
	value: number,
	unit: RateLimitRetryAfterUnit,
	modelBackoffKey?: string,
): number | undefined {
	if (!Number.isFinite(value) || value <= 0) return undefined;
	const multiplier =
		unit === "millisecond" ? 1 : unit === "minute" ? 60_000 : 1000;
	return Math.min(
		rateLimitBackoffProfile(modelBackoffKey).maxMs,
		Math.ceil(value * multiplier),
	);
}

function retryAfterMsFromRateLimitText(
	text: string,
	modelBackoffKey?: string,
): number | undefined {
	const retryAfterHeaderMatch = text.match(
		/\bretry[-_ ]?after\b\s*[:=]\s*(\d{1,6})(?:\s*(ms|milliseconds?|s|sec|secs|seconds?|m|min|mins|minutes?))?\b/i,
	);
	if (retryAfterHeaderMatch) {
		return boundedRateLimitRetryAfterMs(
			Number.parseInt(retryAfterHeaderMatch[1] ?? "", 10),
			rateLimitRetryAfterUnit(retryAfterHeaderMatch[2]),
			modelBackoffKey,
		);
	}
	const tryAgainMatch = text.match(
		/\btry again in\s+(\d{1,6})\s*(ms|milliseconds?|s|sec|secs|seconds?|m|min|mins|minutes?)\b/i,
	);
	if (!tryAgainMatch) return undefined;
	return boundedRateLimitRetryAfterMs(
		Number.parseInt(tryAgainMatch[1] ?? "", 10),
		rateLimitRetryAfterUnit(tryAgainMatch[2]),
		modelBackoffKey,
	);
}

function workflowAuthFile(): string {
	const override = process.env[WORKFLOW_AUTH_FILE_ENV]?.trim();
	return override ? override : join(piAgentDir(), "auth.json");
}

function providerAuthType(
	modelBackoffKey: string | undefined,
): string | undefined {
	const key = modelBackoffKey?.trim().toLowerCase();
	if (!key || key === "default") return undefined;
	try {
		const parsed = JSON.parse(readFileSync(workflowAuthFile(), "utf8"));
		const provider = parsed?.[key];
		return typeof provider?.type === "string"
			? provider.type.toLowerCase()
			: undefined;
	} catch {
		return undefined;
	}
}

function rateLimitBackoffProfile(modelBackoffKey: string | undefined): {
	baseMs: number;
	maxMs: number;
} {
	return providerAuthType(modelBackoffKey) === "oauth"
		? {
				baseMs: OAUTH_RATE_LIMIT_TRANSIENT_RETRY_BACKOFF_BASE_MS,
				maxMs: OAUTH_RATE_LIMIT_TRANSIENT_RETRY_BACKOFF_MAX_MS,
			}
		: {
				baseMs: RATE_LIMIT_TRANSIENT_RETRY_BACKOFF_BASE_MS,
				maxMs: RATE_LIMIT_TRANSIENT_RETRY_BACKOFF_MAX_MS,
			};
}

function defaultRateLimitBackoffMs(
	attempt: number,
	modelBackoffKey?: string,
): number {
	const exponent = Math.max(0, Math.min(4, Math.floor(attempt) - 1));
	const profile = rateLimitBackoffProfile(modelBackoffKey);
	return Math.min(profile.maxMs, profile.baseMs * 2 ** exponent);
}

function transientModelRateLimitBackoffMs(options: {
	attempt: number;
	modelBackoffKey?: string;
	errorMessage?: string;
	stderrText: string;
	subagentResult?: Record<string, unknown>;
	snapshotMetadata?: Record<string, unknown> | null;
}): number | undefined {
	const candidates = [
		options.errorMessage,
		options.stderrText,
		...metadataTextValues(options.subagentResult?.metadata),
		...metadataTextValues(options.snapshotMetadata),
	].filter(
		(value): value is string => typeof value === "string" && value.length > 0,
	);
	const matched = candidates.find(isRateLimitModelFailureText);
	if (!matched) return undefined;
	return (
		retryAfterMsFromRateLimitText(matched, options.modelBackoffKey) ??
		defaultRateLimitBackoffMs(options.attempt, options.modelBackoffKey)
	);
}

function launchRetryBackoffRemainingMs(
	task: WorkflowTaskRunRecord,
): number | undefined {
	const nextEligibleAt = task.launchRetry?.nextEligibleAt;
	if (typeof nextEligibleAt !== "string" || nextEligibleAt.length === 0) {
		return undefined;
	}
	const nextEligibleAtMs = Date.parse(nextEligibleAt);
	if (!Number.isFinite(nextEligibleAtMs)) return undefined;
	return Math.max(0, nextEligibleAtMs - Date.now());
}

function shouldRetryTransientModelFailure(
	statusInfo: {
		status: WorkflowTaskRunRecord["status"];
		failureKind?: string;
		errorMessage?: string;
	},
	workflowResult: { contextLengthExceeded?: boolean; noFinalOutput?: boolean },
	outputBytes: number,
): boolean {
	return (
		statusInfo.status === "failed" &&
		statusInfo.failureKind === "model" &&
		outputBytes === 0 &&
		workflowResult.noFinalOutput === true &&
		workflowResult.contextLengthExceeded !== true
	);
}

function transientFailureAttemptPath(
	resultFile: string,
	attempt: number,
): string {
	return join(
		dirname(resultFile),
		`result.transient-model-failure-${attempt}.json`,
	);
}

function dynamicTaskToolResultBudgetConfiguration(
	task: WorkflowTaskRunRecord,
): DynamicTaskToolResultBudgetConfiguration | undefined {
	if (!task.dynamicGenerated) return undefined;
	const raw = process.env[DYNAMIC_TOOL_RESULT_BUDGET_ENV];
	if (raw !== undefined && raw.trim() !== "") {
		const parsed = Number(raw.trim());
		if (!Number.isInteger(parsed) || parsed <= 0) {
			return { configured: false, source: "disabled" };
		}
		return {
			configured: true,
			source: "environment",
			maxTotalChars: Math.floor(parsed),
		};
	}
	return {
		configured: true,
		source: "default",
		maxTotalChars: DEFAULT_DYNAMIC_TOOL_RESULT_BUDGET_CHARS,
	};
}

export function resolveWorkflowRetryLimit(
	envName: string,
	fallback: number,
	env: NodeJS.ProcessEnv = process.env,
): number {
	const raw = env[envName];
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${envName} must be a non-negative safe integer`);
	}
	return value;
}

function retryOrFailTransientSubagentFailure(
	task: WorkflowTaskRunRecord,
	options: { reason: string; message: string; backoffMs?: number },
): boolean {
	const attempt = (task.launchRetry?.attempts ?? 0) + 1;
	const maxAttempts =
		task.launchRetry?.maxAttempts ??
		resolveWorkflowRetryLimit(
			TRANSIENT_MODEL_FAILURE_RETRIES_ENV,
			DEFAULT_TRANSIENT_MODEL_FAILURE_RETRIES,
		);
	const exhausted = attempt > maxAttempts;
	const backoffMs =
		options.backoffMs === undefined
			? undefined
			: Math.max(0, Math.floor(options.backoffMs));
	const nextEligibleAt =
		!exhausted && backoffMs !== undefined && backoffMs > 0
			? new Date(Date.now() + backoffMs).toISOString()
			: undefined;
	task.launchRetry = {
		attempts: attempt,
		maxAttempts,
		reason: exhausted ? `${options.reason}_exhausted` : options.reason,
		message: options.message,
		...(nextEligibleAt === undefined
			? {}
			: { nextEligibleAt, retryAfterMs: backoffMs }),
	};
	delete task.backendHandle;
	delete task.backendFiles;
	task.pid = undefined;
	task.startedAt = undefined;
	task.completedAt = undefined;
	task.exitCode = undefined;
	if (!exhausted) {
		task.status = "pending";
		task.statusDetail = "retry_model_failure";
		task.lastMessage =
			nextEligibleAt === undefined
				? `${options.message}; retrying transient-model failure (${attempt}/${maxAttempts})`
				: `${options.message}; rate-limit backoff until ${nextEligibleAt} before retrying transient-model failure (${attempt}/${maxAttempts})`;
		return true;
	}
	task.status = "failed";
	task.statusDetail = task.launchRetry.reason ?? "model_exhausted";
	task.exitCode = 1;
	task.completedAt = nowIso();
	task.lastMessage = `${options.message}; transient-model failure retries exhausted (${maxAttempts})`;
	return true;
}

function retryOrFailArtifactGraphTask(
	task: WorkflowTaskRunRecord,
	options: {
		reason: string;
		attempt: number;
		message: string;
		artifacts?: string[];
		repairMode?: "same_session" | "new_session";
		sessionId?: string;
	},
): boolean {
	const maxAttempts =
		task.outputRetry?.maxAttempts ??
		resolveWorkflowRetryLimit(
			ARTIFACT_OUTPUT_RETRIES_ENV,
			DEFAULT_ARTIFACT_OUTPUT_RETRIES,
		);
	const exhausted = options.attempt > maxAttempts;
	const outputRetry = {
		attempts: options.attempt,
		maxAttempts,
		reason: exhausted ? `${options.reason}_exhausted` : options.reason,
		message: options.message,
		artifacts: options.artifacts,
		...(options.repairMode === undefined
			? {}
			: { repairMode: options.repairMode }),
		...(options.sessionId === undefined
			? {}
			: { sessionId: options.sessionId }),
	};
	task.outputRetry = outputRetry;
	delete task.backendHandle;
	delete task.backendFiles;
	task.pid = undefined;
	task.startedAt = undefined;
	task.completedAt = undefined;
	task.exitCode = undefined;
	if (!exhausted) {
		task.status = "pending";
		task.statusDetail = "retry_output_invalid";
		task.lastMessage = options.message;
		return true;
	}
	task.status = "failed";
	task.statusDetail = outputRetry.reason ?? "artifact_graph_output_invalid";
	task.exitCode = 1;
	task.completedAt = nowIso();
	task.lastMessage = options.message;
	return true;
}

function shouldAttemptArtifactGraphSalvage(options: {
	task: WorkflowTaskRunRecord;
	statusInfo: {
		status: WorkflowTaskRunRecord["status"];
		failureKind?: string;
		errorMessage?: string;
	};
	outputBytes: number;
	outputText: string;
	exitCode: number;
	contextLengthExceeded: boolean;
	subagentResult: Record<string, unknown> | undefined;
	snapshot: SubagentRunStatusSnapshot;
}): boolean {
	if (!options.task.artifactGraph?.enabled) return false;
	if (options.statusInfo.status !== "failed") return false;
	const failureKind =
		options.statusInfo.failureKind ?? options.snapshot.failureKind;
	if (
		failureKind !== "model" &&
		failureKind !== "context_or_request_too_large"
	) {
		return false;
	}
	if (options.outputBytes <= 0) return false;
	if (options.contextLengthExceeded) {
		return looksLikeWorkflowOutputSections(options.outputText);
	}
	if (options.exitCode !== 0) return false;
	const stopReason =
		(options.subagentResult?.metadata as Record<string, unknown> | undefined)
			?.stopReason ?? options.snapshot.metadata?.stopReason;
	return stopReason === "stop" || stopReason === "end";
}

function looksLikeWorkflowOutputSections(text: string): boolean {
	const trimmed = text.trimStart();
	return (
		trimmed.startsWith("<control>") &&
		text.includes("</control>") &&
		text.includes("<analysis>") &&
		text.includes("</analysis>") &&
		text.includes("<refs>") &&
		text.includes("</refs>")
	);
}

function workflowStatusFromSubagent(
	snapshot: SubagentRunStatusSnapshot,
	result: Record<string, unknown> | undefined,
	outputBytes: number,
): {
	status: WorkflowTaskRunRecord["status"];
	failureKind?: string;
	errorMessage?: string;
} {
	const contextLengthExceeded = Boolean(
		(result?.metadata as any)?.contextLengthExceeded ??
			snapshot.metadata?.contextLengthExceeded,
	);
	if (snapshot.status === "completed" && outputBytes === 0)
		return {
			status: "failed",
			failureKind: "no_final_output",
			errorMessage: "child Pi produced no final assistant output",
		};
	if (snapshot.status === "completed") return { status: "completed" };
	if (
		snapshot.failureKind === "model" &&
		outputBytes > 0 &&
		snapshot.metadata?.stopReason === "stop" &&
		!contextLengthExceeded
	) {
		return { status: "completed" };
	}
	if (contextLengthExceeded)
		return {
			status: "failed",
			failureKind: "context_or_request_too_large",
			errorMessage: "child Pi exceeded the model context window",
		};
	if (snapshot.status === "cancelled")
		return {
			status: "interrupted",
			failureKind: snapshot.failureKind ?? "cancelled",
			errorMessage: "pi-subagent run was cancelled",
		};
	if (snapshot.failureKind === "timeout")
		return {
			status: "failed",
			failureKind: "timeout",
			errorMessage: "pi-subagent run timed out",
		};
	if (
		snapshot.failureKind === "abort" ||
		snapshot.failureKind === "cancelled" ||
		snapshot.failureKind === "stale"
	) {
		return {
			status: "interrupted",
			failureKind: snapshot.failureKind,
			errorMessage: `pi-subagent run ${snapshot.failureKind}`,
		};
	}
	return {
		status: "failed",
		failureKind: snapshot.failureKind ?? "model",
		errorMessage: snapshot.failureKind
			? `pi-subagent run failed: ${snapshot.failureKind}`
			: "pi-subagent run failed",
	};
}

function findLog(
	snapshot: SubagentRunStatusSnapshot,
	type: SubagentRunLogRef["type"],
): SubagentRunLogRef | undefined {
	return snapshot.logs.find((log) => log.type === type);
}

function captureToolCallsEnabled(): boolean {
	const value = process.env.PI_WORKFLOW_CAPTURE_TOOL_CALLS;
	return typeof value === "string" && /^(1|true|yes|on)$/i.test(value.trim());
}

export async function prepareSubagentTaskLaunch(
	cwd: string,
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	compiledTask: CompiledTask,
	requireArtifactBinding = false,
): Promise<PreparedWorkflowTaskLaunch> {
	const tools = compiledTask.runtime.tools;
	const legacyProviderTools = selectedLegacyProviderTools(tools);
	const providerResolutionTools = new Set(legacyProviderTools);
	if (shouldUseWorkflowWebSource(tools)) {
		for (const tool of tools ?? []) {
			if (isWorkflowWebSourceTool(tool) || !LEGACY_PROVIDER_TOOL_NAMES.has(tool))
				providerResolutionTools.add(tool);
		}
		providerResolutionTools.add("web_search");
	}
	const toolProviders = await resolvePreparedToolProviders(
		cwd,
		compiledTask.runtime.toolProviders,
		providerResolutionTools,
	);
	const legacyProvider = resolveLegacyProvider(
		legacyProviderTools,
		toolProviders,
	);
	assertSupportedNormalizedProviderOwnership(tools, toolProviders);
	let extensions = uniqueStrings([
		...providerExtensionsForTools(tools, toolProviders, legacyProvider),
		...extraSubagentExtensionsFromEnv(),
	]);
	const generatedExtensions: PreparedWorkflowTaskLaunch["generatedExtensions"] =
		[];
	const taskDir = dirname(fromProjectPath(cwd, task.files.result));
	const artifactBinding = await sealArtifactBinding(
		task,
		taskDir,
		requireArtifactBinding,
	);

	if (legacyProviderTools.length > 0) {
		const wrapperPath = join(taskDir, "workflow-fetch-cache-extension.ts");
		const config = {
			runId: run.runId,
			taskId: task.taskId,
			cacheDir: resolve(
				cwd,
				".pi",
				"workflows",
				run.runId,
				"source-cache",
				"fetch-content",
			),
			maxInlineChars: fetchContentInlineCharsEnvValue(),
			cacheEnabled: shouldUseFetchContentCache(tools) && legacyProvider.kind !== "extension",
			providerKind: legacyProvider.kind,
			requiredProviderTools: legacyProviderTools,
			exposedProviderTools: legacyProviderTools,
			passthroughProviderTools: selectedLegacyPassthroughTools(tools),
		};
		const providerExtensionPath =
			legacyProvider.extensionPath ?? BUNDLED_PI_WEB_ACCESS_EXTENSION;
		const expectedBytes = buildWorkflowFetchCacheExtensionWrapper({
			importPath: WORKFLOW_FETCH_CACHE_EXTENSION_IMPORT,
			webAccessExtensionPath: providerExtensionPath,
			webAccessStoragePath: BUNDLED_PI_WEB_ACCESS_STORAGE,
			config,
		});
		await writeWorkflowFetchCacheExtensionWrapper({
			wrapperPath,
			importPath: WORKFLOW_FETCH_CACHE_EXTENSION_IMPORT,
			webAccessExtensionPath: providerExtensionPath,
			webAccessStoragePath: BUNDLED_PI_WEB_ACCESS_STORAGE,
			config,
		});
		generatedExtensions.push({
			kind: "fetch-cache",
			path: wrapperPath,
			expectedBytes,
			config,
		});
		const capturedLegacyExtensions = new Set([
			BUNDLED_PI_WEB_ACCESS_EXTENSION,
			...(legacyProvider.extensionPath ? [legacyProvider.extensionPath] : []),
		]);
		extensions = uniqueStrings([
			...extensions.filter(
				(extension) => !capturedLegacyExtensions.has(extension),
			),
			wrapperPath,
		]);
	}

	if (shouldUseWorkflowWebSource(tools)) {
		const providerExtensionPaths = workflowWebSourceProviderExtensions(
			tools,
			toolProviders,
		);
		const providerExtensionPath =
			providerExtensionPaths[0] ?? BUNDLED_PI_WEB_ACCESS_EXTENSION;
		const effectiveProviderExtensionPaths =
			providerExtensionPaths.length > 0
				? providerExtensionPaths
				: [providerExtensionPath];
		const wrapperPath = join(taskDir, "workflow-web-source-extension.ts");
		const config = {
			schema: "workflow-web-source-launch-config-v1" as const,
			runId: run.runId,
			taskId: task.taskId,
			cwd,
			cacheDir: resolve(cwd, ".pi", "workflows", run.runId, "web-source-cache"),
			provider: {
				kind:
					(providerExtensionPaths.length === 0 ||
						providerExtensionPaths.every(
							(path) => resolve(path) === BUNDLED_PI_WEB_ACCESS_EXTENSION,
						))
						? ("pi-web-access" as const)
						: ("extension" as const),
				extensionPath: providerExtensionPath,
				extensionPaths: effectiveProviderExtensionPaths,
				usesPiWebAccess: effectiveProviderExtensionPaths.includes(
					BUNDLED_PI_WEB_ACCESS_EXTENSION,
				),
			},
			providerToolOwnerPaths: normalizedProviderToolOwnerPaths(
				tools,
				toolProviders,
				effectiveProviderExtensionPaths,
			),
			securityPolicy: {
				allowPrivateHosts: false,
				cacheRawProviderPayloads: false,
			},
			directFetchOnly: true,
			exposedWorkflowTools: (tools ?? []).filter((tool) =>
				isWorkflowWebSourceTool(tool),
			),
			passthroughProviderTools: selectedNormalizedPassthroughTools(tools, toolProviders),
			requiredProviderTools: (tools ?? []).includes("workflow_web_search")
				? ["web_search"]
				: [],
		};
		const expectedBytes = buildWorkflowWebSourceExtensionWrapper({
			importPath: WORKFLOW_WEB_SOURCE_EXTENSION_IMPORT,
			providerExtensionPath,
			providerExtensionPaths: effectiveProviderExtensionPaths,
			config,
		});
		await writeWorkflowWebSourceExtensionWrapper({
			wrapperPath,
			importPath: WORKFLOW_WEB_SOURCE_EXTENSION_IMPORT,
			providerExtensionPath,
			providerExtensionPaths: effectiveProviderExtensionPaths,
			config,
		});
		generatedExtensions.push({
			kind: "web-source",
			path: wrapperPath,
			expectedBytes,
			config,
		});
		const capturedProviderExtensions = new Set(effectiveProviderExtensionPaths);
		extensions = uniqueStrings([
			...extensions.filter(
				(extension) => !capturedProviderExtensions.has(extension),
			),
			wrapperPath,
		]);
	}

	const toolResultBudget = dynamicTaskToolResultBudgetConfiguration(task);
	return {
		extensions,
		...(toolProviders
			? { toolProviders: clonePreparedToolProviders(toolProviders) }
			: {}),
		generatedExtensions,
		captureToolCalls: captureToolCallsEnabled(),
		...(toolResultBudget === undefined ? {} : { toolResultBudget }),
		...(artifactBinding === undefined ? {} : { artifactBinding }),
	};
}

async function sealArtifactBinding(
	task: WorkflowTaskRunRecord,
	taskDir: string,
	required: boolean,
): Promise<PreparedWorkflowTaskLaunch["artifactBinding"]> {
	if (
		!task.artifactGraph?.enabled ||
		task.artifactGraph.artifactAccess === "none"
	)
		return undefined;
	const manifestPath = join(taskDir, "source-manifest.json");
	const wrapperPath = join(taskDir, "workflow-artifact-extension.ts");
	if (!required && !existsSync(manifestPath) && !existsSync(wrapperPath))
		return undefined;
	try {
		const [expectedManifestBytes, expectedWrapperBytes] = await Promise.all([
			readFile(manifestPath, "utf8"),
			readFile(wrapperPath, "utf8"),
		]);
		return {
			manifestPath,
			expectedManifestBytes,
			wrapperPath,
			expectedWrapperBytes,
		};
	} catch {
		throw new Error("launch-bootstrap artifact binding is unavailable");
	}
}

async function assertPreparedSubagentTaskLaunch(
	preparedLaunch: PreparedWorkflowTaskLaunch,
): Promise<void> {
	if (preparedLaunch.artifactBinding) {
		let actualManifest: string;
		let actualWrapper: string;
		try {
			[actualManifest, actualWrapper] = await Promise.all([
				readFile(preparedLaunch.artifactBinding.manifestPath, "utf8"),
				readFile(preparedLaunch.artifactBinding.wrapperPath, "utf8"),
			]);
		} catch {
			throw new Error("launch-bootstrap artifact binding is unavailable");
		}
		if (
			actualManifest !== preparedLaunch.artifactBinding.expectedManifestBytes ||
			actualWrapper !== preparedLaunch.artifactBinding.expectedWrapperBytes
		)
			throw new Error("launch-bootstrap artifact binding drift detected");
	}
	for (const extension of preparedLaunch.generatedExtensions) {
		let actual: string;
		try {
			actual = await readFile(extension.path, "utf8");
		} catch {
			throw new Error("launch-bootstrap generated extension is unavailable");
		}
		if (actual !== extension.expectedBytes)
			throw new Error("launch-bootstrap generated extension drift detected");
	}
}

function selectedLegacyProviderTools(
	tools: readonly string[] | undefined,
): string[] {
	const selected = new Set(tools ?? []);
	return ["web_search", "fetch_content", "get_search_content"].filter((tool) =>
		selected.has(tool),
	);
}

interface LegacyProviderResolution {
	kind: "pi-web-access" | "extension";
	extensionPath?: string;
}

function resolveLegacyProvider(
	legacyTools: readonly string[],
	toolProviders: Record<string, CompiledToolProvider> | undefined,
): LegacyProviderResolution {
	const explicit = legacyTools.map((tool) => ({
		tool,
		extensions: toolProviders?.[tool]?.extensions,
	}));
	const owned = explicit.filter((entry) => entry.extensions !== undefined);
	if (owned.length === 0) return { kind: "pi-web-access" };
	if (owned.length !== explicit.length) {
		throw new Error(
			"legacy provider ownership is split; configure one coherent provider extension for all selected legacy web tools",
		);
	}
	const paths = new Set<string>();
	for (const entry of owned) {
		if (
			!entry.extensions ||
			entry.extensions.length !== 1 ||
			typeof entry.extensions[0] !== "string" ||
			entry.extensions[0].trim() === ""
		) {
			throw new Error(
				"legacy provider ownership is incompatible; exactly one provider extension is required",
			);
		}
		paths.add(entry.extensions[0]);
	}
	if (paths.size !== 1) {
		throw new Error(
			"legacy provider ownership is split; selected legacy web tools must share one provider extension",
		);
	}
	const extensionPath = [...paths][0]!;
	if (resolve(extensionPath) === BUNDLED_PI_WEB_ACCESS_EXTENSION)
		return { kind: "pi-web-access" };
	return { kind: "extension", extensionPath };
}

function clonePreparedToolProviders(
	providers: Record<string, CompiledToolProvider>,
): Record<string, CompiledToolProvider> {
	return Object.fromEntries(
		Object.entries(providers).map(([tool, provider]) => [
			tool,
			{
				...provider,
				...(provider.extensions !== undefined
					? { extensions: [...provider.extensions] }
					: {}),
				...(provider.fallbackTools !== undefined
					? { fallbackTools: [...provider.fallbackTools] }
					: {}),
			},
		]),
	);
}

function shouldUseFetchContentCache(
	tools: readonly string[] | undefined,
): boolean {
	if (!(tools ?? []).includes("fetch_content")) return false;
	return !isExplicitlyDisabled(fetchContentCacheEnvValue());
}

function shouldUseWorkflowWebSource(
	tools: readonly string[] | undefined,
): boolean {
	return (tools ?? []).some((tool) => isWorkflowWebSourceTool(tool));
}

const LEGACY_PROVIDER_TOOL_NAMES = new Set([
	"web_search",
	"fetch_content",
	"get_search_content",
]);

function selectedLegacyPassthroughTools(
	tools: readonly string[] | undefined,
): string[] {
	return (tools ?? []).filter(
		(tool) =>
			!LEGACY_PROVIDER_TOOL_NAMES.has(tool) &&
			!isWorkflowWebSourceTool(tool),
	);
}

function selectedNormalizedPassthroughTools(
	tools: readonly string[] | undefined,
	providers?: Record<string, CompiledToolProvider>,
): string[] {
	return (tools ?? []).filter(
		(tool) =>
			!LEGACY_PROVIDER_TOOL_NAMES.has(tool) &&
			!isWorkflowWebSourceTool(tool) &&
			providers !== undefined && Object.hasOwn(providers, tool),
	);
}

function assertSupportedNormalizedProviderOwnership(
	tools: readonly string[] | undefined,
	toolProviders: Record<string, CompiledToolProvider> | undefined,
): void {
	if (!(tools ?? []).includes("workflow_web_fetch_source")) return;
	// A custom search owner is valid. A custom fetch owner is not: the prepared
	// normalized fetch tool is always the generated direct-safe transport.
	for (const tool of ["workflow_web_fetch_source", "fetch_content"]) {
		for (const extension of toolProviders?.[tool]?.extensions ?? []) {
			if (resolve(extension) !== BUNDLED_PI_WEB_ACCESS_EXTENSION)
				throw new Error(
					"unsupported normalized provider ownership: custom fetch_content ownership for workflow_web_fetch_source is not supported; generated safe fetch uses pi-web-access",
				);
		}
	}
}

async function resolvePreparedToolProviders(
	cwd: string,
	providers: Record<string, CompiledToolProvider> | undefined,
	resolveTools: ReadonlySet<string>,
): Promise<Record<string, CompiledToolProvider> | undefined> {
	if (!providers) return undefined;
	const resolved: Record<string, CompiledToolProvider> = {};
	for (const [tool, provider] of Object.entries(providers)) {
		const extensions =
			provider.extensions && resolveTools.has(tool)
				? await Promise.all(
						provider.extensions.map((ref) =>
							resolveProviderExtensionRef(ref, cwd, tool),
						),
					)
				: provider.extensions
					? [...provider.extensions]
					: undefined;
		resolved[tool] = {
			...provider,
			...(extensions ? { extensions } : {}),
			...(provider.fallbackTools
				? { fallbackTools: [...provider.fallbackTools] }
				: {}),
		};
	}
	return resolved;
}

async function resolveProviderExtensionRef(
	ref: string,
	cwd: string,
	tool: string,
): Promise<string> {
	const trimmed = typeof ref === "string" ? ref.trim() : "";
	if (!trimmed)
		throw new Error(`provider extension ownership for ${tool} contains an empty reference`);
	if (/^(?:npm:|git:|github:|https?:|ssh:)/i.test(trimmed)) {
		throw new Error(
			`provider extension reference ${JSON.stringify(ref)} for ${tool} is not a local extension file; package/remote extension sources are unsupported for sealed provider ownership`,
		);
	}
	let local = trimmed;
	if (/^file:\/\//i.test(local)) local = fileURLToPath(local);
	else if (local === "~" || local.startsWith("~/"))
		local = join(homedir(), local.slice(2));
	const resolved = resolve(cwd, local);
	try {
		const info = await stat(resolved);
		if (!info.isFile()) throw new Error("not a file");
	} catch {
		throw new Error(
			`provider extension reference ${JSON.stringify(ref)} for ${tool} is missing or is not a single extension file (resolved ${resolved})`,
		);
	}
	return resolved;
}

function normalizedProviderToolOwnerPaths(
	tools: readonly string[] | undefined,
	toolProviders: Record<string, CompiledToolProvider> | undefined,
	providerPaths: readonly string[],
): Record<string, string[]> {
	const searchOwners = [
		...(toolProviders?.workflow_web_search?.extensions ?? []),
		...(toolProviders?.web_search?.extensions ?? []),
	].filter(
		(path, index, values): path is string =>
			typeof path === "string" &&
			path !== BUNDLED_PI_WEB_ACCESS_EXTENSION &&
			values.indexOf(path) === index,
	);
	const webSearchOwners = searchOwners.length
		? searchOwners
		: providerPaths.includes(BUNDLED_PI_WEB_ACCESS_EXTENSION)
			? [BUNDLED_PI_WEB_ACCESS_EXTENSION]
			: [];
	const owners: Record<string, string[]> = {};
	if (webSearchOwners.length) owners.web_search = webSearchOwners;
	for (const tool of selectedNormalizedPassthroughTools(tools, toolProviders)) {
		const configured = toolProviders?.[tool]?.extensions ?? [];
		const unique = [...new Set(configured.filter((path): path is string => typeof path === "string" && path.trim() !== ""))];
		if (unique.length !== 1 || unique.length !== configured.length) {
			throw new Error(`normalized provider ownership is missing or ambiguous for selected passthrough tool ${tool}`);
		}
		owners[tool] = unique;
	}
	if ((tools ?? []).includes("workflow_web_fetch_source")) {
		owners.fetch_content = [BUNDLED_PI_WEB_ACCESS_EXTENSION];
		owners.get_search_content = [BUNDLED_PI_WEB_ACCESS_EXTENSION];
	}
	return owners;
}

function workflowWebSourceProviderExtensions(
	tools: readonly string[] | undefined,
	toolProviders: Record<string, CompiledToolProvider> | undefined,
): string[] {
	const providers: string[] = [];
	const add = (values: readonly string[] | undefined): void => {
		for (const value of values ?? []) {
			if (typeof value === "string" && value.trim() && !providers.includes(value))
				providers.push(value);
		}
	};
	const selected = tools ?? [];
	for (const tool of selected) {
		// workflow_web_fetch_source has no provider-owned transport. Do not load
		// a custom fetch extension merely because it was attached to that tool;
		// custom search and explicitly selected passthrough tools remain loaded.
		if (
			(tool === "workflow_web_search") ||
			(!LEGACY_PROVIDER_TOOL_NAMES.has(tool) && !isWorkflowWebSourceTool(tool) && tool !== "code_search")
		)
			add(toolProviders?.[tool]?.extensions);
	}
	// A shared provider may own code_search as well as a normalized search
	// tool. Capture it in the generated wrapper so it can be re-exported once.
	if (selected.includes("code_search")) add(toolProviders?.code_search?.extensions);
	if (selected.includes("workflow_web_search"))
		add(toolProviders?.web_search?.extensions);
	// Normalized fetch is always backed by the generated public-host-checked
	// pi-web-access transport. Custom fetch ownership is rejected above rather
	// than being treated as equivalent merely because its URL input is public.
	if (selected.includes("workflow_web_fetch_source"))
		add([BUNDLED_PI_WEB_ACCESS_EXTENSION]);
	return providers;
}

function fetchContentCacheEnvValue(): string | undefined {
	return (
		process.env[FETCH_CONTENT_CACHE_ENV] ?? process.env[LEGACY_FETCH_CACHE_ENV]
	);
}

function fetchContentInlineCharsEnvValue(): number | undefined {
	const raw = process.env[FETCH_CONTENT_INLINE_CHARS_ENV];
	if (raw === undefined || raw.trim() === "")
		return DEFAULT_WORKFLOW_FETCH_CONTENT_INLINE_CHARS;
	if (isExplicitlyDisabled(raw)) return undefined;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed))
		return DEFAULT_WORKFLOW_FETCH_CONTENT_INLINE_CHARS;
	return Math.max(1, Math.floor(parsed));
}

function isExplicitlyDisabled(value: string | undefined): boolean {
	return typeof value === "string" && /^(0|false|no|off)$/i.test(value.trim());
}

function providerExtensionsForTools(
	tools: readonly string[] | undefined,
	toolProviders: Record<string, CompiledToolProvider> | undefined,
	legacyProvider: LegacyProviderResolution,
): string[] {
	const providers = new Set<string>();
	const legacyTools = new Set(["web_search", "fetch_content", "get_search_content"]);
	for (const tool of tools ?? []) {
		const customExtensions = toolProviders?.[tool]?.extensions;
		const legacyOwnedByWrapper =
			legacyTools.has(tool) && legacyProvider.kind === "extension";
		if (
			(!legacyOwnedByWrapper && tool !== "code_search") ||
			(tool === "code_search" && customExtensions === undefined)
		) {
			for (const provider of TOOL_PROVIDER_EXTENSIONS[tool] ?? [])
				providers.add(provider);
		}
		if (tool !== "workflow_web_fetch_source") {
			for (const provider of customExtensions ?? []) providers.add(provider);
		}
	}
	return [...providers];
}

function extraSubagentExtensionsFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	return String(env[EXTRA_SUBAGENT_EXTENSIONS_ENV] ?? "")
		.split(delimiter)
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function uniqueStrings(values: readonly string[]): string[] {
	return [...new Set(values)];
}

async function readToolCallsSummary(
	snapshot: SubagentRunStatusSnapshot,
	subagentResult: Record<string, unknown> | undefined,
	artifactRoot: string | undefined,
): Promise<{ ref: SubagentArtifactRef; summary: unknown } | undefined> {
	const artifactRef = toolCallArtifactRef(subagentResult, "tool-calls-summary");
	if (!artifactRef) return undefined;
	const summary = await readJsonLoose<unknown>(
		safeArtifactPath(snapshot, artifactRef, artifactRoot),
	);
	return summary === undefined ? undefined : { ref: artifactRef, summary };
}

async function readFailedToolCalls(
	snapshot: SubagentRunStatusSnapshot,
	subagentResult: Record<string, unknown> | undefined,
	artifactRoot: string | undefined,
): Promise<
	| { ref: SubagentArtifactRef; records: WorkflowTaskFailedToolCallSummary[] }
	| undefined
> {
	const artifactRef = toolCallArtifactRef(subagentResult, "tool-calls");
	if (!artifactRef) return undefined;
	const text = await readFile(
		safeArtifactPath(snapshot, artifactRef, artifactRoot),
		"utf8",
	).catch(() => "");
	const records: WorkflowTaskFailedToolCallSummary[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (records.length >= MAX_FAILED_TOOL_CALL_RECORDS) break;
		if (line.trim() === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		const record = failedToolCallSummary(parsed);
		if (record) records.push(record);
	}
	return { ref: artifactRef, records };
}

function toolCallArtifactRef(
	subagentResult: Record<string, unknown> | undefined,
	type: "tool-calls" | "tool-calls-summary",
): SubagentArtifactRef | undefined {
	const artifacts = Array.isArray(subagentResult?.artifacts)
		? subagentResult.artifacts
		: [];
	const resultCwd =
		typeof subagentResult?.cwd === "string" ? subagentResult.cwd : undefined;
	const ref = artifacts.find((artifact): artifact is SubagentArtifactRef => {
		return (
			typeof artifact === "object" &&
			artifact !== null &&
			(artifact as SubagentArtifactRef).type === type &&
			typeof (artifact as SubagentArtifactRef).path === "string"
		);
	});
	return ref
		? { ...ref, artifactCwd: ref.artifactCwd ?? resultCwd }
		: undefined;
}

function failedToolCallSummary(
	value: unknown,
): WorkflowTaskFailedToolCallSummary | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return undefined;
	const record = value as Record<string, unknown>;
	const status = stringValue(record.status);
	const isError = record.isError === true;
	if (status !== "failed" && status !== "incomplete" && !isError)
		return undefined;
	return {
		toolCallId: stringValue(record.toolCallId),
		toolName: stringValue(record.toolName),
		category: stringValue(record.category),
		status,
		startedAt: stringValue(record.startedAt),
		completedAt:
			record.completedAt === null ? null : stringValue(record.completedAt),
		durationMs:
			typeof record.durationMs === "number" ? record.durationMs : undefined,
		isError,
		argsSummary: record.argsSummary,
		resultSummary: record.resultSummary,
		failedArgs: record.failedArgs,
		failedResult: record.failedResult,
	};
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export type TaskArtifactLinkTestHook = (source: string, target: string) => void | Promise<void>;

let taskArtifactLinkForTests: TaskArtifactLinkTestHook | undefined;

export function setTaskArtifactLinkForTests(
	hook: TaskArtifactLinkTestHook | undefined,
): void {
	taskArtifactLinkForTests = hook;
}

async function linkTaskArtifact(source: string, target: string): Promise<void> {
	await taskArtifactLinkForTests?.(source, target);
	await unlinkExistingTaskArtifact(target);
	await link(source, target);
}

async function unlinkExistingTaskArtifact(target: string): Promise<void> {
	try {
		await unlink(target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
	}
}

async function copyLogOrEmpty(
	snapshot: SubagentRunStatusSnapshot,
	ref: SubagentRunLogRef | undefined,
	target: string,
	artifactRoot: string | undefined,
): Promise<number> {
	await mkdir(dirname(target), { recursive: true });
	if (!ref) {
		await writeFile(target, "", "utf8");
		return 0;
	}
	let source: string;
	try {
		source = safeArtifactPath(snapshot, ref, artifactRoot);
	} catch {
		await writeFile(target, "", "utf8");
		return 0;
	}
	let copied = true;
	try {
		await linkTaskArtifact(source, target);
	} catch {
		await copyFile(source, target).catch(async () => {
			copied = false;
			await writeFile(target, "", "utf8");
		});
	}
	if (!copied) return 0;
	return stat(target)
		.then((value) => value.size)
		.catch(() => 0);
}

async function copyLogOrEmptyMeasured(
	snapshot: SubagentRunStatusSnapshot,
	ref: SubagentRunLogRef | undefined,
	target: string,
	artifactRoot: string | undefined,
): Promise<{ durationMs: number; bytes: number }> {
	const startedAtMs = Date.now();
	const bytes = await copyLogOrEmpty(snapshot, ref, target, artifactRoot);
	return { durationMs: elapsedSince(startedAtMs), bytes };
}

function safeArtifactPath(
	snapshot: SubagentRunStatusSnapshot,
	artifact: Pick<SubagentRunLogRef, "path" | "artifactCwd">,
	artifactRoot: string | undefined,
): string {
	if (isAbsolute(artifact.path) || artifact.path.split("/").includes(".."))
		throw new Error("subagent artifact path must be relative and safe");
	const artifactCwd = resolve(
		artifact.artifactCwd ??
			snapshot.logs.find((log) => log.artifactCwd)?.artifactCwd ??
			".",
	);
	const artifactPath = resolve(artifactCwd, artifact.path.split("/").join(sep));
	if (artifactRoot && !isInsidePath(resolve(artifactRoot), artifactPath)) {
		throw new Error("subagent artifact path must stay inside the task runsDir");
	}
	return artifactPath;
}

function isInsidePath(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function readJsonLoose<T>(file: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}

async function writeJson(file: string, value: unknown): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

interface SubagentRunRecordLike {
	runId?: string;
	correlationId?: string;
	activeAttemptId?: string | null;
	latestAttemptId?: string | null;
	startedAt?: string;
	updatedAt?: string;
	attempts?: Array<{
		attemptId?: string;
		startedAt?: string;
		updatedAt?: string;
	}>;
}

async function recoverSubagentHandle(
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
): Promise<SubagentBackendHandle | undefined> {
	const runsDir = subagentRunsDir(run, task);
	const absoluteRunsDir = resolve(task.cwd, runsDir);
	const expectedCorrelationId = `${run.runId}:${task.taskId}`;
	const claimStartedAtMs = timestampMs(task.startedAt);
	const entries = await readdir(absoluteRunsDir, { withFileTypes: true }).catch(
		() => [],
	);
	const candidates: Array<{
		handle: SubagentBackendHandle;
		updatedAtMs: number;
	}> = [];

	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith("run_")) continue;
		const record = await readJsonLoose<SubagentRunRecordLike>(
			join(absoluteRunsDir, entry.name, "run.json"),
		);
		if (!record || record.correlationId !== expectedCorrelationId) continue;
		if (isPreClaimSubagentRecord(record, claimStartedAtMs)) continue;
		const attemptId =
			record.activeAttemptId ??
			record.latestAttemptId ??
			record.attempts?.at(-1)?.attemptId;
		if (typeof attemptId !== "string" || attemptId.length === 0) continue;
		candidates.push({
			handle: makeSubagentHandle(
				task,
				record.runId ?? entry.name,
				attemptId,
				runsDir,
				workflowTaskSessionId(run, task),
			),
			updatedAtMs:
				timestampMs(record.updatedAt) ??
				timestampMs(record.startedAt) ??
				timestampMs(record.attempts?.at(-1)?.updatedAt) ??
				timestampMs(record.attempts?.at(-1)?.startedAt) ??
				0,
		});
	}

	candidates.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
	return candidates[0]?.handle;
}

function isPreClaimSubagentRecord(
	record: SubagentRunRecordLike,
	claimStartedAtMs: number | undefined,
): boolean {
	if (claimStartedAtMs === undefined) return false;
	const recordStartedAtMs =
		timestampMs(record.startedAt) ??
		timestampMs(record.attempts?.[0]?.startedAt) ??
		timestampMs(record.updatedAt);
	return (
		recordStartedAtMs !== undefined && recordStartedAtMs < claimStartedAtMs
	);
}

function timestampMs(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const time = Date.parse(value);
	return Number.isFinite(time) ? time : undefined;
}

function makeSubagentHandle(
	task: WorkflowTaskRunRecord,
	runId: string,
	attemptId: string,
	runsDir: string,
	sessionId?: string,
): SubagentBackendHandle {
	return {
		engine: "pi-subagent",
		backend: "headless",
		runId,
		attemptId,
		cwd: task.cwd,
		runsDir,
		display: `pi-subagent/headless ${runId}/${attemptId}`,
		...(sessionId === undefined ? {} : { sessionId }),
	};
}

function getSubagentHandle(
	task: WorkflowTaskRunRecord,
): SubagentBackendHandle | undefined {
	const handle = task.backendHandle;
	if (!handle || typeof handle !== "object") return undefined;
	const candidate = handle as Partial<SubagentBackendHandle>;
	if (candidate.engine !== "pi-subagent" || candidate.backend !== "headless")
		return undefined;
	if (
		typeof candidate.runId !== "string" ||
		typeof candidate.attemptId !== "string" ||
		typeof candidate.cwd !== "string" ||
		typeof candidate.runsDir !== "string"
	)
		return undefined;
	return {
		...(candidate as SubagentBackendHandle),
		...(typeof candidate.sessionId === "string"
			? { sessionId: candidate.sessionId }
			: {}),
	};
}

function subagentRunsDir(
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
): string {
	return `${DEFAULT_SUBAGENT_RUNS_ROOT}/${run.runId}/${task.taskId}`;
}

function buildSystemPrompt(task: CompiledTask): string {
	const workflowMaxDigestChars = task.artifactGraph?.output.maxDigestChars;
	const workflowRefsMinItems = task.artifactGraph?.output.refsMinItems;
	const workflowRefsUrlValidation =
		task.artifactGraph?.output.refsUrlValidation;
	const workflowOutputContract =
		task.foreachBatchSynthetic?.schema === "workflow-foreach-batch-v1"
			? [
					"# Workflow Output Contract",
					"This is a runtime-managed foreach batch. The exact outer control envelope is defined in the task prompt and overrides singleton control requirements.",
					"Your final response must start exactly with <control> and end exactly with </refs>, with no prose outside the three required sections.",
					"Do not add a singleton control.digest field or any other outer-envelope key not required by the batch prompt.",
				]
			: task.artifactGraph?.enabled
		? [
				"# Workflow Output Contract",
				"For this workflow task, the output protocol in the task prompt overrides any direct-response format in the agent definition.",
				"Your final response must start exactly with <control> and end exactly with </refs>.",
				"Do not include preambles, status updates, Markdown headings, or prose outside the required workflow output sections.",
				"Never start with status text such as 'I have enough evidence' or 'Composing output'; put all explanatory prose inside <analysis> only.",
				...(workflowMaxDigestChars !== undefined
					? [
							`The control.digest string is required and must be at most ${workflowMaxDigestChars} characters; prefer one short sentence.`,
						]
					: []),
				...(workflowRefsMinItems !== undefined && workflowRefsMinItems > 0
					? [
							`The <refs> JSON array must include at least ${workflowRefsMinItems} item${workflowRefsMinItems === 1 ? "" : "s"}. Include URLs or local file paths used by the analysis.`,
						]
					: []),
				...(workflowRefsUrlValidation
					? [
							"External URLs in <refs> are validated before completion. Use available workflow web tools to fetch/cache the URL and read exact evidence before citing it; replace stale or unreachable URLs with working canonical URLs or omit them.",
						]
					: []),
			]
		: [
				"When complete, provide a concise final report with findings, changed files if any, and blockers.",
			];
	const enabledTools = task.runtime.tools ?? [];
	const toolPolicy = [
		"# Effective Tool Policy",
		enabledTools.length > 0
			? `Only these tools are enabled for this workflow task: ${enabledTools.join(", ")}.`
			: "No tools are enabled for this workflow task.",
		"If the agent definition below mentions tools that are not in this enabled list, ignore those mentions; unavailable tools cannot be called in this workflow run.",
		enabledTools.includes("workflow_web_fetch_source") ||
		enabledTools.includes("workflow_web_source_read")
			? "Workflow web-source tools return compact source cards. Preserve sourceRef values in structured outputs. Use workflow_web_source_read for exact evidence snippets; when several snippets are needed from the same sourceRef, batch them with queries:[...] or reads:[...] instead of making repeated calls. If the exact quote is unknown, pass claim plus 2-6 distinctive terms to harvest a candidate source window and preserve its match metadata. Do not read workflow cache files directly."
			: !enabledTools.includes("get_search_content") &&
					(enabledTools.includes("web_search") ||
						enabledTools.includes("fetch_content"))
				? "Full cached search-content hydration is unavailable here. Use web_search/fetch_content results and report evidence gaps instead of broad raw document retrieval."
				: undefined,
	].filter((line): line is string => typeof line === "string");
	return [
		`You are Pi workflow subagent '${task.agent}'.`,
		"You were launched by /workflow from a deterministic workflow spec.",
		"Do not assume parent conversation history.",
		"Do not launch other agents or orchestration workflows unless explicitly instructed.",
		...toolPolicy,
		...workflowOutputContract,
		"",
		"# Agent Definition",
		task.agentSystemPrompt.trim(),
		...(task.artifactGraph?.enabled
			? [
					"",
					"# Workflow Output Contract Reminder",
					"Ignore any agent-definition final-answer format that conflicts with the workflow output protocol. The first byte of your final answer must be '<' in <control>; place all prose inside <analysis>; end with </refs>.",
				]
			: []),
	].join("\n");
}

function resultCompletedAfterTimeout(
	task: WorkflowTaskRunRecord,
	completedAt: string,
): boolean {
	if (!task.startedAt || !task.runtime.maxRuntimeMs) return false;
	const startedAtMs = Date.parse(task.startedAt);
	const completedAtMs = Date.parse(completedAt);
	if (!Number.isFinite(startedAtMs) || !Number.isFinite(completedAtMs))
		return false;
	return completedAtMs - startedAtMs > task.runtime.maxRuntimeMs;
}
