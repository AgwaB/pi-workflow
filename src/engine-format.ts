import { readFile } from "node:fs/promises";

import { formatDynamicAuditSummary } from "./dynamic-audit.js";
import {
	hasActiveSchedulerWork,
	isRefreshPollAggregateError,
	recordSupervisorError,
	refreshRun,
} from "./engine-wait.js";
import {
	fromProjectPath,
	isMockRunProvenance,
	LEASE_STALE_MS,
	listRunRecords,
	readIndex,
	readJson,
	readRunRecord,
	summarizeTaskFailureClasses,
	supervisorPath,
	updateIndex,
} from "./store.js";
import { summarizeWorkflowTelemetry } from "./workflow-artifacts.js";
import { buildWorkflowRunMetrics } from "./workflow-metrics.js";
import type {
	WorkflowIndexRecord,
	WorkflowRunRecord,
	WorkflowSupervisorRecord,
	WorkflowTaskRunRecord,
} from "./types.js";

const LOG_LINES_DEFAULT = 80;
const LOG_LINES_MAX = 400;

/** A running run counts as making no task progress after this long. */
export const TASK_PROGRESS_STALL_MS = 10 * 60_000;
/** Supervisor heartbeat older than 2x the lease-stale threshold is lost. */
const SUPERVISOR_HEARTBEAT_LOST_MS = 2 * LEASE_STALE_MS;

export interface WorkflowRunStallInfo {
	kind: "no-progress" | "heartbeat-lost";
	ageMs: number;
}

/**
 * Detects the two silent-stall shapes of a `running` run:
 * - `heartbeat-lost`: supervisor.json stopped updating (supervisor gone).
 * - `no-progress`: heartbeat is fresh (supervisor alive) but no task status
 *   has transitioned for TASK_PROGRESS_STALL_MS — liveness without progress.
 */
export function detectRunStall(
	run: Pick<WorkflowRunRecord, "status" | "createdAt">,
	supervisor: WorkflowSupervisorRecord | undefined,
	nowMs = Date.now(),
): WorkflowRunStallInfo | undefined {
	if (run.status !== "running" || !supervisor) return undefined;
	const heartbeatMs = parseIsoTimeMs(supervisor.updatedAt);
	if (heartbeatMs === undefined) return undefined;
	const heartbeatAgeMs = Math.max(0, nowMs - heartbeatMs);
	if (heartbeatAgeMs >= SUPERVISOR_HEARTBEAT_LOST_MS)
		return { kind: "heartbeat-lost", ageMs: heartbeatAgeMs };
	const progressCapable =
		supervisor.lastTaskTransitionAt !== undefined ||
		supervisor.taskStatusCounts !== undefined;
	if (!progressCapable) return undefined;
	const transitionMs =
		parseIsoTimeMs(supervisor.lastTaskTransitionAt) ??
		parseIsoTimeMs(run.createdAt);
	if (transitionMs === undefined) return undefined;
	const ageMs = Math.max(0, nowMs - transitionMs);
	if (ageMs < TASK_PROGRESS_STALL_MS) return undefined;
	return { kind: "no-progress", ageMs };
}

export function formatRunStallWarning(
	run: Pick<WorkflowRunRecord, "runId" | "status" | "createdAt">,
	supervisor: WorkflowSupervisorRecord | undefined,
	nowMs = Date.now(),
): string | undefined {
	const stall = detectRunStall(run, supervisor, nowMs);
	if (!stall) return undefined;
	if (stall.kind === "heartbeat-lost")
		return `⚠ supervisor heartbeat lost (last heartbeat ${formatStallAge(stall.ageMs)} ago while run says running; inspect /workflow logs ${run.runId})`;
	return `⚠ no task progress for ${formatStallAge(stall.ageMs)} (heartbeat alive — possible stall; inspect /workflow logs ${run.runId})`;
}

function formatStallAge(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
	if (minutes >= 1) return `${minutes}m`;
	return `${Math.max(0, Math.floor(ms / 1000))}s`;
}

function parseIsoTimeMs(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

async function readRunSupervisor(
	cwd: string,
	runId: string,
): Promise<WorkflowSupervisorRecord | undefined> {
	try {
		return await readJson<WorkflowSupervisorRecord>(supervisorPath(cwd, runId));
	} catch {
		return undefined;
	}
}

export async function formatStatus(cwd: string): Promise<string> {
	const cached = await readIndex(cwd);
	if (cached) {
		await reconcileIndexedActiveRuns(cwd, cached);
		const refreshed = (await readIndex(cwd).catch(() => cached)) ?? cached;
		if (refreshed.runs.length === 0) return "No workflow runs found.";
		return formatIndex(cwd, refreshed);
	}

	await reconcileActiveRuns(cwd);
	const rebuilt = await updateIndex(cwd).catch(() => readIndex(cwd));
	if (!rebuilt || rebuilt.runs.length === 0) return "No workflow runs found.";
	return formatIndex(cwd, rebuilt);
}

interface FormatRefreshResult {
	run: WorkflowRunRecord;
	warning?: string;
}

async function refreshRunForFormat(
	cwd: string,
	runIdOrPrefix: string,
): Promise<FormatRefreshResult> {
	try {
		return { run: await refreshRun(cwd, runIdOrPrefix) };
	} catch (error) {
		if (!isRefreshPollAggregateError(error)) throw error;
		const run = await readRunRecord(cwd, runIdOrPrefix);
		await recordSupervisorError(cwd, run.runId, error);
		return {
			run,
			warning: `Warning: refresh poll failed; showing last cached workflow run state (${error.message}).`,
		};
	}
}

function prependRefreshWarning(text: string, warning?: string): string {
	return warning ? `${warning}\n\n${text}` : text;
}

export async function formatRunDetails(
	cwd: string,
	runIdOrPrefix: string,
): Promise<string> {
	const { run, warning } = await refreshRunForFormat(cwd, runIdOrPrefix);
	const supervisor = await readRunSupervisor(cwd, run.runId);
	return prependRefreshWarning(formatRun(run, "full", { supervisor }), warning);
}

export async function formatRunStatus(
	cwd: string,
	runIdOrPrefix: string,
): Promise<string> {
	const { run, warning } = await refreshRunForFormat(cwd, runIdOrPrefix);
	const supervisor = await readRunSupervisor(cwd, run.runId);
	return prependRefreshWarning(
		formatRun(run, "summary", { supervisor }),
		warning,
	);
}

export async function formatLogs(
	cwd: string,
	runIdOrPrefix: string,
	taskId = "task-1",
	lineCount = LOG_LINES_DEFAULT,
): Promise<string> {
	const { run, warning } = await refreshRunForFormat(cwd, runIdOrPrefix);
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
	return prependRefreshWarning(
		`${run.runId}/${task.taskId} output=${task.files.output}\n${tail || "(empty log)"}`,
		warning,
	);
}

function runFailurePolicyEnabled(run: WorkflowRunRecord): boolean {
	const policy = run.failurePolicy;
	return (
		policy?.failFast === true &&
		(policy.cancelSiblingsOnFailure === true ||
			policy.cancelDescendantsOnParentFailure === true)
	);
}

export function formatRun(
	run: WorkflowRunRecord,
	detail: "summary" | "full" = "summary",
	options: { supervisor?: WorkflowSupervisorRecord; nowMs?: number } = {},
): string {
	const telemetry = summarizeWorkflowTelemetry(run);
	const failureClasses = summarizeTaskFailureClasses(run.tasks);
	const lines = [
		`${run.runId} [${run.status}] type=${run.type} backend=${run.backend.type}/${run.backend.mode}${run.degradation ? ` — degraded: ${run.degradation.summary}` : ""}`,
		`created=${run.createdAt} updated=${run.updatedAt}`,
		`tasks=${run.taskSummary.completed}/${run.taskSummary.total} completed, running=${run.taskSummary.running}, pending=${run.taskSummary.pending}, blocked=${run.taskSummary.blocked}, failed=${run.taskSummary.failed}, interrupted=${run.taskSummary.interrupted}`,
	];
	if (failureClasses.failFastCancelled > 0 || runFailurePolicyEnabled(run)) {
		lines.push(
			`failureClasses=failed=${failureClasses.failed}, failFastCancelled=${failureClasses.failFastCancelled}, otherInterrupted=${failureClasses.otherInterrupted}`,
		);
	}
	lines.push(
		`completion=${telemetry.completion.health}, outputRetries=${telemetry.retryCounts.output}, launchRetries=${telemetry.retryCounts.launch}, resumeEvents=${telemetry.resumeCounts.events}, contextLimitFailures=${telemetry.completion.contextLimitFailures}`,
	);
	const usageLine = formatRunUsageLine(run);
	if (usageLine) lines.push(usageLine);
	if (run.dynamicAudit) lines.push(formatDynamicAuditSummary(run.dynamicAudit));
	const stallWarning = formatRunStallWarning(
		run,
		options.supervisor,
		options.nowMs ?? Date.now(),
	);
	if (stallWarning) lines.push(stallWarning);

	for (const task of run.tasks) {
		lines.push(formatTask(task, detail));
	}

	return lines.join("\n");
}

function formatRunUsageLine(run: WorkflowRunRecord): string | undefined {
	const usage = buildWorkflowRunMetrics(run).totals.usage;
	const observed = usage.observed;
	if (
		observed.totalTokens === null &&
		observed.inputTokens === null &&
		observed.outputTokens === null
	)
		return undefined;
	const parts = [
		`tokens=${observed.totalTokens ?? "n/a"}`,
		`in=${observed.inputTokens ?? "n/a"}`,
		`out=${observed.outputTokens ?? "n/a"}`,
		`tasksReporting=${observed.contributingTaskIds.length}/${run.tasks.length}`,
	];
	return `usage=${parts.join(", ")}`;
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

async function formatIndex(
	cwd: string,
	index: WorkflowIndexRecord,
): Promise<string> {
	const blocks = await Promise.all(
		index.runs.map(async (run) => {
			const fullRun = await readRunRecord(cwd, run.runId).catch(
				() => undefined,
			);
			const mockTag = isMockRunProvenance(fullRun?.provenance)
				? ` mock(${fullRun?.provenance?.mode})`
				: "";
			const lines = [
				`${run.runId} [${run.status}]${mockTag} type=${run.type} updated=${run.updatedAt}`,
				`tasks=${run.taskSummary.completed}/${run.taskSummary.total} completed, running=${run.taskSummary.running}, pending=${run.taskSummary.pending}, blocked=${run.taskSummary.blocked}, failed=${run.taskSummary.failed}, skipped=${run.taskSummary.skipped}, interrupted=${run.taskSummary.interrupted}`,
			];
			const stallWarning =
				run.status === "running"
					? formatRunStallWarning(run, await readRunSupervisor(cwd, run.runId))
					: undefined;
			if (stallWarning) lines.push(stallWarning);
			for (const task of indexTasksForStatus(run, fullRun)) {
				const message = task.lastMessage ? ` — ${task.lastMessage}` : "";
				const kind = task.kind && task.kind !== "main" ? ` ${task.kind}` : "";
				lines.push(
					`- ${task.taskId}${kind} ${task.agent} [${task.status}/${task.statusDetail}]${message}`,
				);
			}
			return lines.join("\n");
		}),
	);
	return blocks.join("\n\n");
}

type WorkflowIndexTaskEntry = NonNullable<
	WorkflowIndexRecord["runs"][number]["tasks"]
>[number];

function indexTasksForStatus(
	run: WorkflowIndexRecord["runs"][number],
	fullRun: WorkflowRunRecord | undefined,
): WorkflowIndexTaskEntry[] {
	if (Array.isArray(run.tasks)) return run.tasks;
	return (
		fullRun?.tasks.map((task) => ({
			taskId: task.taskId,
			displayName: task.displayName,
			agent: task.agent,
			kind: task.kind,
			stageId: task.stageId,
			backendHandle: task.backendHandle,
			status: task.status,
			statusDetail: task.statusDetail,
			lastMessage: task.lastMessage,
		})) ?? []
	);
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
