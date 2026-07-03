import { existsSync } from "node:fs";
import {
	copyFile,
	mkdir,
	readFile,
	readdir,
	rm,
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
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";

import type {
	CompiledTask,
	CompiledToolProvider,
	WorkflowRunRecord,
	WorkflowTaskRunRecord,
} from "./types.js";
import type { JsonSchema } from "./json-schema.js";
import {
	fromProjectPath,
	isTerminalTaskStatus,
	nowIso,
	toProjectPath,
	writeRunRecord,
} from "./store.js";
import {
	applyTaskResultArtifact,
	isTaskTimedOut,
	markTaskTimedOut,
} from "./result.js";
import type { BackendLaunchResult } from "./backend.js";
import { readWorkflowArtifactReadLedger } from "./workflow-artifact-tool.js";
import { writeWorkflowFetchCacheExtensionWrapper } from "./workflow-fetch-cache-extension.js";
import { writeWorkflowWebSourceExtensionWrapper } from "./workflow-web-source-extension.js";
import { isWorkflowWebSourceTool } from "./workflow-web-source.js";
import {
	buildWorkflowOutputRetryInstructions,
	parseWorkflowOutputForBundle,
	writeWorkflowTaskArtifactBundle,
} from "./workflow-output-artifacts.js";

const DEFAULT_SUBAGENT_RUNS_ROOT = ".pi/workflow-subagents";
const EXTRA_SUBAGENT_EXTENSIONS_ENV = "PI_WORKFLOW_SUBAGENT_EXTRA_EXTENSIONS";
const FETCH_CONTENT_CACHE_ENV = "PI_WORKFLOW_FETCH_CONTENT_CACHE";
const LEGACY_FETCH_CACHE_ENV = "PI_WORKFLOW_FETCH_CACHE";
const DEFAULT_TRANSIENT_MODEL_FAILURE_RETRIES = 5;
const DEFAULT_ARTIFACT_OUTPUT_RETRIES = 2;
const MAX_CONCURRENT_LAUNCHES_ENV = "PI_WORKFLOW_MAX_CONCURRENT_LAUNCHES";
const DEFAULT_LAUNCH_SLOT_RELEASE_DELAY_MS = 3_000;
const MIN_TRANSIENT_RETRY_JITTER_MS = 1_000;
const MAX_TRANSIENT_RETRY_JITTER_MS = 5_000;
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
	code_search: [BUNDLED_PI_WEB_ACCESS_EXTENSION],
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

interface SubagentApi {
	runSubagent(
		options: Record<string, unknown>,
	): Promise<SubagentResultEnvelope>;
	getSubagentStatus(
		options: Record<string, unknown>,
	): Promise<SubagentRunStatusSnapshot | null>;
	interruptSubagent(options: Record<string, unknown>): Promise<unknown>;
	reconcileSubagentRun(options: Record<string, unknown>): Promise<unknown>;
}

const subagentApiSpecifier = "@agwab/pi-subagent/api";
let cachedSubagentApi: Promise<SubagentApi> | undefined;
let injectedSubagentApi: SubagentApi | undefined;

export function setSubagentApiForTests(api: unknown | undefined): void {
	injectedSubagentApi = api === undefined ? undefined : (api as SubagentApi);
	cachedSubagentApi = undefined;
}

async function loadSubagentApi(): Promise<SubagentApi> {
	if (injectedSubagentApi) return injectedSubagentApi;
	cachedSubagentApi ??= import(subagentApiSpecifier).then(
		(mod) => mod as SubagentApi,
	);
	return cachedSubagentApi;
}

let launchSlotReleaseDelayMs = DEFAULT_LAUNCH_SLOT_RELEASE_DELAY_MS;
let transientRetryJitterForTests: (() => number) | undefined;
const launchWaitQueue: Array<() => void> = [];
let activeLaunchSlots = 0;

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

async function acquireLaunchSlot(): Promise<() => void> {
	if (!isLaunchGateSaturated()) {
		activeLaunchSlots += 1;
		return releaseLaunchSlot;
	}
	await new Promise<void>((resolveWait) => launchWaitQueue.push(resolveWait));
	return releaseLaunchSlot;
}

function releaseLaunchSlot(): void {
	const next = launchWaitQueue.shift();
	if (next) {
		// Transfer the occupied slot directly to the queued launcher.
		next();
		return;
	}
	activeLaunchSlots = Math.max(0, activeLaunchSlots - 1);
}

function releaseLaunchSlotAfterDelay(
	delayMs: number,
	release: () => void,
): void {
	if (delayMs <= 0) {
		release();
		return;
	}
	setTimeout(release, delayMs);
}

async function runWithLaunchSlot<T>(action: () => Promise<T>): Promise<T> {
	const release = await acquireLaunchSlot();
	let holdAfterReturn = false;
	try {
		const result = await action();
		holdAfterReturn = true;
		return result;
	} finally {
		releaseLaunchSlotAfterDelay(
			holdAfterReturn ? launchSlotReleaseDelayMs : 0,
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

export function setSubagentLaunchControlsForTests(options?: {
	releaseDelayMs?: number;
	retryJitterMs?: number | (() => number);
}): void {
	launchSlotReleaseDelayMs =
		options?.releaseDelayMs === undefined
			? DEFAULT_LAUNCH_SLOT_RELEASE_DELAY_MS
			: Math.max(0, Math.floor(options.releaseDelayMs));
	transientRetryJitterForTests =
		options?.retryJitterMs === undefined
			? undefined
			: typeof options.retryJitterMs === "function"
				? options.retryJitterMs
				: () => Math.max(0, Math.floor(options.retryJitterMs as number));
	activeLaunchSlots = 0;
	while (launchWaitQueue.length > 0) launchWaitQueue.shift()?.();
}

export async function cleanupSubagentRun(
	_cwd: string,
	run: WorkflowRunRecord,
): Promise<void> {
	for (const task of run.tasks) {
		const handle = getSubagentHandle(task);
		if (!handle) continue;
		const api = await loadSubagentApi();
		await api
			.interruptSubagent({
				cwd: handle.cwd,
				runsDir: handle.runsDir,
				runId: handle.runId,
				attemptId: handle.attemptId,
				reason: "workflow cleanup",
			})
			.catch(() => undefined);
	}
}

export async function launchSubagentTask(
	cwd: string,
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	compiledTask: CompiledTask,
): Promise<BackendLaunchResult> {
	if (task.status !== "pending") return { kind: "launched" };
	if (task.backendHandle || task.pid) return { kind: "launched" };

	if ((compiledTask.runtime.fast as string | undefined) === "on") {
		return {
			kind: "fatal",
			message: "fast:on is not supported for pi-workflow execution.",
		};
	}

	if ((task.launchRetry?.attempts ?? 0) > 0) {
		const jitterMs = transientRetryJitterMs();
		task.statusDetail = "retry_model_failure";
		task.lastMessage = `waiting ${jitterMs}ms before retrying transient-model launch`;
		await writeRunRecord(cwd, run);
		if (jitterMs > 0) await sleep(jitterMs);
	}

	const systemPromptFile = fromProjectPath(cwd, task.files.systemPrompt);
	const taskPromptFile = fromProjectPath(cwd, task.files.taskPrompt);
	const outputFile = fromProjectPath(cwd, task.files.output);
	const stderrFile = fromProjectPath(cwd, task.files.stderr);
	const resultFile = fromProjectPath(cwd, task.files.result);
	await mkdir(dirname(systemPromptFile), { recursive: true });
	await rm(resultFile, { force: true });
	await writeFile(systemPromptFile, buildSystemPrompt(compiledTask), "utf8");
	await writeFile(taskPromptFile, compiledTask.compiledPrompt, "utf8");
	await writeFile(outputFile, "", "utf8");
	await writeFile(stderrFile, "", "utf8");

	const runsDir = subagentRunsDir(run, task);
	const correlationId = `${run.runId}:${task.taskId}`;
	const sessionId = subagentSessionId(run, task);
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

	let launched: SubagentResultEnvelope;
	try {
		const api = await loadSubagentApi();
		const extensions = await workflowTaskExtensions(
			cwd,
			run,
			task,
			compiledTask,
		);
		const subagentOptions: Record<string, unknown> = {
			cwd: task.cwd,
			backend: "headless",
			task: compiledTask.compiledPrompt,
			systemPrompt: buildSystemPrompt(compiledTask),
			model: compiledTask.runtime.model,
			thinking: compiledTask.runtime.thinking,
			tools: compiledTask.runtime.tools,
			async: true,
			onComplete: "detach",
			asyncDependency: "needed-before-final",
			workspace: "shared",
			worktreePolicy: "never",
			timeoutMs: compiledTask.runtime.maxRuntimeMs,
			runsDir,
			correlationId,
			...(sessionId === undefined ? {} : { sessionId }),
		};
		subagentOptions.extensions = extensions;
		if (captureToolCallsEnabled()) subagentOptions.captureToolCalls = true;
		if (isLaunchGateSaturated()) {
			task.lastMessage = `waiting for pi-subagent launch slot (${resolveMaxConcurrentLaunches()} max)`;
			await writeRunRecord(cwd, run).catch(() => undefined);
		}
		launched = await runWithLaunchSlot(() => api.runSubagent(subagentOptions));
	} catch (error) {
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
	task.backendHandle = handle;
	task.backendTaskId = launched.runId;
	task.backendFiles = {
		runsDir: toProjectPath(task.cwd, resolve(task.cwd, runsDir)),
		correlationId,
		...(sessionId === undefined ? {} : { sessionId }),
	};
	task.statusDetail = "running";
	task.lastMessage = "launched via pi-subagent/headless";
	await writeRunRecord(cwd, run).catch(() => undefined);
	return { kind: "launched" };
}

export async function refreshRunFromSubagentArtifacts(
	cwd: string,
	run: WorkflowRunRecord,
): Promise<WorkflowRunRecord> {
	let changed = false;

	for (const task of run.tasks) {
		if (isTerminalTaskStatus(task.status) || task.status !== "running")
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
		if (!handle) {
			if (isTaskTimedOut(task)) {
				markTaskTimedOut(task);
				changed = true;
			}
			continue;
		}

		const api = await loadSubagentApi();
		await api
			.reconcileSubagentRun({
				cwd: handle.cwd,
				runsDir: handle.runsDir,
				runId: handle.runId,
			})
			.catch(() => undefined);
		const snapshot = await api
			.getSubagentStatus({
				cwd: handle.cwd,
				runsDir: handle.runsDir,
				runId: handle.runId,
				attemptId: handle.attemptId,
			})
			.catch(() => null);

		if (snapshot === null) {
			if (isTaskTimedOut(task)) {
				await api
					.interruptSubagent({
						cwd: handle.cwd,
						runsDir: handle.runsDir,
						runId: handle.runId,
						attemptId: handle.attemptId,
						reason: "workflow timeout",
					})
					.catch(() => undefined);
				markTaskTimedOut(task);
				changed = true;
			}
			continue;
		}

		const activeAttempt =
			snapshot.attempts?.find(
				(attempt) => attempt.attemptId === handle.attemptId,
			) ?? snapshot.attempts?.at(-1);
		task.pid = activeAttempt?.workerPid ?? activeAttempt?.pid ?? task.pid;
		if (snapshot.status === "running" || snapshot.status === "pending") {
			task.statusDetail = "running";
			task.lastMessage = activeAttempt?.heartbeatAt
				? `pi-subagent heartbeat ${activeAttempt.heartbeatAt}`
				: "pi-subagent running";
			if (isTaskTimedOut(task)) {
				await api
					.interruptSubagent({
						cwd: handle.cwd,
						runsDir: handle.runsDir,
						runId: handle.runId,
						attemptId: handle.attemptId,
						reason: "workflow timeout",
					})
					.catch(() => undefined);
				markTaskTimedOut(task);
				changed = true;
			}
			continue;
		}

		if (await materializeTerminalSubagentResult(cwd, run, task, snapshot))
			changed = true;
	}

	if (changed) await writeRunRecord(cwd, run);
	return run;
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
	await copyLogOrEmpty(snapshot, outputRef, outputFile, artifactRoot);
	await copyLogOrEmpty(snapshot, stderrRef, stderrFile, artifactRoot);

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
	const outputText = await readFile(outputFile, "utf8").catch(() => "");
	const stderrText = await readFile(stderrFile, "utf8").catch(() => "");
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
	const errorMessage =
		statusInfo.errorMessage ??
		(typeof subagentResult?.errorMessage === "string"
			? subagentResult.errorMessage
			: undefined);
	const contextLengthExceeded = Boolean(
		(subagentResult?.metadata as any)?.contextLengthExceeded ??
			snapshot.metadata?.contextLengthExceeded,
	);
	if (task.artifactGraph?.enabled && statusInfo.status === "completed") {
		return await materializeTerminalArtifactGraphResult(cwd, run, task, {
			outputFile,
			stderrFile,
			resultFile,
			completedAt,
			startedAt,
			exitCode,
			subagentResult,
		});
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
		return await materializeTerminalArtifactGraphResult(cwd, run, task, {
			outputFile,
			stderrFile,
			resultFile,
			completedAt,
			startedAt,
			exitCode,
			subagentResult,
			salvage: {
				failureKind: statusInfo.failureKind ?? snapshot.failureKind ?? "model",
				subagentStatus: snapshot.status,
				subagentFailureKind: snapshot.failureKind,
			},
		});
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
			toolCallsSummaryPath: toolCalls?.ref.path,
			toolCallsArtifactCwd: toolCalls?.ref.artifactCwd,
		},
	};
	if (
		shouldRetryTransientModelFailure(statusInfo, workflowResult, outputBytes)
	) {
		await writeJson(
			transientFailureAttemptPath(
				resultFile,
				(task.launchRetry?.attempts ?? 0) + 1,
			),
			workflowResult,
		);
		return retryOrFailTransientSubagentFailure(task, {
			reason: statusInfo.failureKind ?? "model",
			message: errorMessage ?? "pi-subagent run failed before producing output",
		});
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
	return changed;
}

function artifactGraphRetrySession(
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	subagentResult: Record<string, unknown> | undefined,
	attempt: number,
): { repairMode: "same_session" | "new_session"; sessionId: string } {
	const expectedSessionId = subagentSessionId(run, task);
	const metadata = subagentResult?.metadata;
	const metadataRecord =
		metadata && typeof metadata === "object" && !Array.isArray(metadata)
			? (metadata as Record<string, unknown>)
			: undefined;
	const actualSessionId = metadataRecord?.sessionId;
	const session = metadataRecord?.session;
	const sessionDisposition =
		session && typeof session === "object" && !Array.isArray(session)
			? (session as Record<string, unknown>).disposition
			: undefined;
	if (
		typeof actualSessionId === "string" &&
		actualSessionId === expectedSessionId &&
		sessionDisposition === "resumed"
	) {
		return { repairMode: "same_session", sessionId: expectedSessionId };
	}
	return {
		repairMode: "new_session",
		sessionId: retrySubagentSessionId(run, task, attempt),
	};
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
		salvage?: {
			failureKind: string;
			subagentStatus: string;
			subagentFailureKind: string | null;
		};
	},
): Promise<boolean> {
	const rawOutput = await readFile(options.outputFile, "utf8").catch(() => "");
	const artifactOptions = task.artifactGraph?.output;
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
		await writeWorkflowTaskArtifactBundle({
			taskDir: dirname(options.resultFile),
			rawOutput,
			attempt,
			completedAt: options.completedAt,
			...parseOptions,
		});
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
	);
	if (readCheck.missing.length > 0 || readCheck.ledgerError) {
		const reason = readCheck.ledgerError
			? "required_reads_ledger_unavailable"
			: "required_reads_missing";
		const artifacts = readCheck.ledgerError
			? (task.artifactGraph?.requiredReads ?? [])
			: readCheck.missing;
		const message = readCheck.ledgerError
			? `required workflow artifact read ledger was unavailable or corrupt: ${readCheck.ledgerError}; required reads could not be verified: ${artifacts.join(", ")}`
			: `missing required workflow artifact reads: ${readCheck.missing.join(", ")}`;
		await writeArtifactGraphMissingReadsAttempt(
			dirname(options.resultFile),
			rawOutput,
			attempt,
			artifacts,
			options.completedAt,
			{ failureKind: reason, errorMessage: message },
		);
		return retryOrFailArtifactGraphTask(task, {
			reason,
			attempt,
			message,
			artifacts,
			...retrySession,
		});
	}

	const written = await writeWorkflowTaskArtifactBundle({
		taskDir: dirname(options.resultFile),
		rawOutput,
		startedAt: options.startedAt,
		completedAt: options.completedAt,
		exitCode: options.exitCode,
		stderr: await readFile(options.stderrFile, "utf8").catch(() => ""),
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
	});
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

async function checkRequiredArtifactReads(
	taskDir: string,
	requiredReads: readonly string[],
): Promise<{ missing: string[]; ledgerError?: string }> {
	if (requiredReads.length === 0) return { missing: [] };
	let ledger;
	try {
		ledger = await readWorkflowArtifactReadLedger(
			join(taskDir, "read-ledger.jsonl"),
		);
	} catch (error) {
		return {
			missing: [...requiredReads],
			ledgerError: error instanceof Error ? error.message : String(error),
		};
	}
	const actual = new Set(
		ledger.map((entry) => `${entry.source}.${entry.artifact}`),
	);
	return { missing: requiredReads.filter((required) => !actual.has(required)) };
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

function retryOrFailTransientSubagentFailure(
	task: WorkflowTaskRunRecord,
	options: { reason: string; message: string },
): boolean {
	const attempt = (task.launchRetry?.attempts ?? 0) + 1;
	const maxAttempts =
		task.launchRetry?.maxAttempts ?? DEFAULT_TRANSIENT_MODEL_FAILURE_RETRIES;
	const exhausted = attempt > maxAttempts;
	task.launchRetry = {
		attempts: attempt,
		maxAttempts,
		reason: exhausted ? `${options.reason}_exhausted` : options.reason,
		message: options.message,
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
		task.lastMessage = `${options.message}; retrying transient-model failure (${attempt}/${maxAttempts})`;
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
		task.outputRetry?.maxAttempts ?? DEFAULT_ARTIFACT_OUTPUT_RETRIES;
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

async function workflowTaskExtensions(
	cwd: string,
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	compiledTask: CompiledTask,
): Promise<string[]> {
	const tools = compiledTask.runtime.tools;
	let extensions = uniqueStrings([
		...providerExtensionsForTools(tools, compiledTask.runtime.toolProviders),
		...extraSubagentExtensionsFromEnv(),
	]);
	const taskDir = dirname(fromProjectPath(cwd, task.files.result));

	if (shouldUseFetchContentCache(tools)) {
		const wrapperPath = join(taskDir, "workflow-fetch-cache-extension.ts");
		await writeWorkflowFetchCacheExtensionWrapper({
			wrapperPath,
			importPath: WORKFLOW_FETCH_CACHE_EXTENSION_IMPORT,
			webAccessExtensionPath: BUNDLED_PI_WEB_ACCESS_EXTENSION,
			webAccessStoragePath: BUNDLED_PI_WEB_ACCESS_STORAGE,
			config: {
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
			},
		});
		extensions = uniqueStrings([
			...extensions.filter(
				(extension) => resolve(extension) !== BUNDLED_PI_WEB_ACCESS_EXTENSION,
			),
			wrapperPath,
		]);
	}

	if (shouldUseWorkflowWebSource(tools)) {
		const providerExtensionPath = workflowWebSourceProviderExtension(
			tools,
			compiledTask.runtime.toolProviders,
		);
		const wrapperPath = join(taskDir, "workflow-web-source-extension.ts");
		await writeWorkflowWebSourceExtensionWrapper({
			wrapperPath,
			importPath: WORKFLOW_WEB_SOURCE_EXTENSION_IMPORT,
			providerExtensionPath,
			config: {
				schema: "workflow-web-source-launch-config-v1",
				runId: run.runId,
				taskId: task.taskId,
				cwd,
				cacheDir: resolve(
					cwd,
					".pi",
					"workflows",
					run.runId,
					"web-source-cache",
				),
				provider: {
					kind:
						providerExtensionPath === BUNDLED_PI_WEB_ACCESS_EXTENSION
							? "pi-web-access"
							: "extension",
					extensionPath: providerExtensionPath,
				},
				securityPolicy: {
					allowPrivateHosts: false,
					cacheRawProviderPayloads: false,
				},
			},
		});
		const capturedProviderExtensions = new Set(
			workflowWebSourceProviderExtensions(
				tools,
				compiledTask.runtime.toolProviders,
			),
		);
		extensions = uniqueStrings([
			...extensions.filter(
				(extension) => !capturedProviderExtensions.has(extension),
			),
			wrapperPath,
		]);
	}

	return extensions;
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

function workflowWebSourceProviderExtension(
	tools: readonly string[] | undefined,
	toolProviders: Record<string, CompiledToolProvider> | undefined,
): string {
	return (
		workflowWebSourceProviderExtensions(tools, toolProviders)[0] ??
		BUNDLED_PI_WEB_ACCESS_EXTENSION
	);
}

function workflowWebSourceProviderExtensions(
	tools: readonly string[] | undefined,
	toolProviders: Record<string, CompiledToolProvider> | undefined,
): string[] {
	const providers = new Set<string>();
	for (const tool of tools ?? []) {
		if (!isWorkflowWebSourceTool(tool)) continue;
		for (const provider of toolProviders?.[tool]?.extensions ?? [])
			providers.add(provider);
	}
	return [...providers];
}

function fetchContentCacheEnvValue(): string | undefined {
	return (
		process.env[FETCH_CONTENT_CACHE_ENV] ?? process.env[LEGACY_FETCH_CACHE_ENV]
	);
}

function isExplicitlyDisabled(value: string | undefined): boolean {
	return typeof value === "string" && /^(0|false|no|off)$/i.test(value.trim());
}

function providerExtensionsForTools(
	tools: readonly string[] | undefined,
	toolProviders: Record<string, CompiledToolProvider> | undefined,
): string[] {
	const providers = new Set<string>();
	for (const tool of tools ?? []) {
		for (const provider of TOOL_PROVIDER_EXTENSIONS[tool] ?? [])
			providers.add(provider);
		for (const provider of toolProviders?.[tool]?.extensions ?? [])
			providers.add(provider);
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
	const artifacts = Array.isArray(subagentResult?.artifacts)
		? subagentResult.artifacts
		: [];
	const resultCwd =
		typeof subagentResult?.cwd === "string" ? subagentResult.cwd : undefined;
	const ref = artifacts.find((artifact): artifact is SubagentArtifactRef => {
		return (
			typeof artifact === "object" &&
			artifact !== null &&
			(artifact as SubagentArtifactRef).type === "tool-calls-summary" &&
			typeof (artifact as SubagentArtifactRef).path === "string"
		);
	});
	if (!ref) return undefined;
	const artifactRef = { ...ref, artifactCwd: ref.artifactCwd ?? resultCwd };
	const summary = await readJsonLoose<unknown>(
		safeArtifactPath(snapshot, artifactRef, artifactRoot),
	);
	return summary === undefined ? undefined : { ref: artifactRef, summary };
}

async function copyLogOrEmpty(
	snapshot: SubagentRunStatusSnapshot,
	ref: SubagentRunLogRef | undefined,
	target: string,
	artifactRoot: string | undefined,
): Promise<void> {
	await mkdir(dirname(target), { recursive: true });
	if (!ref) {
		await writeFile(target, "", "utf8");
		return;
	}
	let source: string;
	try {
		source = safeArtifactPath(snapshot, ref, artifactRoot);
	} catch {
		await writeFile(target, "", "utf8");
		return;
	}
	await copyFile(source, target).catch(async () => {
		await writeFile(target, "", "utf8");
	});
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
				subagentSessionId(run, task),
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

function subagentSessionId(
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
): string | undefined {
	if (!task.artifactGraph?.enabled) return undefined;
	const baseSessionId = baseSubagentSessionId(run, task);
	if (task.outputRetry?.sessionId) return task.outputRetry.sessionId;
	const launchAttempt = task.launchRetry?.attempts ?? 0;
	if (launchAttempt > 0)
		return `${baseSessionId}:launch-retry-${launchAttempt}`;
	const resumeAttempt = task.resumeEvents?.length ?? 0;
	if (resumeAttempt > 0) return `${baseSessionId}:resume-${resumeAttempt}`;
	return baseSessionId;
}

function baseSubagentSessionId(
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
): string {
	return `pi-workflow.${run.runId}.${task.taskId}`.replace(
		/[^A-Za-z0-9._-]/g,
		"-",
	);
}

function retrySubagentSessionId(
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	attempt: number,
): string {
	return `${baseSubagentSessionId(run, task)}.retry-${attempt}`;
}

function buildSystemPrompt(task: CompiledTask): string {
	const workflowMaxDigestChars = task.artifactGraph?.output.maxDigestChars;
	const workflowRefsMinItems = task.artifactGraph?.output.refsMinItems;
	const workflowRefsUrlValidation =
		task.artifactGraph?.output.refsUrlValidation;
	const workflowOutputContract = task.artifactGraph?.enabled
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
