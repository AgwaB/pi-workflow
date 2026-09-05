import { readFileLinesBounded } from "./workflow-preview.js";

import { formatDynamicAuditSummary } from "./dynamic-audit.js";
import { buildDynamicToolResultBudgetMetrics } from "./dynamic-tool-result-budget-metrics.js";
import {
	hasActiveSchedulerWork,
	isRefreshPollAggregateError,
	recordSupervisorError,
	refreshRun,
} from "./engine-wait.js";
import {
	isMockRunProvenance,
	LEASE_STALE_MS,
	listRunRecords,
	readFreshIndex,
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
const TERMINAL_CAPTURE_LAG_WARNING_MS = 2 * 60_000;

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
	const cached = await readFreshIndex(cwd);
	if (cached) {
		await reconcileIndexedActiveRuns(cwd, cached);
		const refreshed = (await readFreshIndex(cwd).catch(() => cached)) ?? cached;
		if (refreshed.runs.length === 0) return "No workflow runs found.";
		return formatHumanRunList(cwd, refreshed);
	}

	await reconcileActiveRuns(cwd);
	const rebuilt = await updateIndex(cwd).catch(() => readIndex(cwd));
	if (!rebuilt || rebuilt.runs.length === 0) return "No workflow runs found.";
	return formatHumanRunList(cwd, rebuilt);
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
	return prependRefreshWarning(
		formatHumanRunDetails(run, { supervisor }),
		warning,
	);
}

export async function formatRawRunDetails(
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
		formatHumanRunStatus(run, { supervisor }),
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

	const count = Math.max(
		1,
		Math.min(LOG_LINES_MAX, Math.floor(lineCount || LOG_LINES_DEFAULT)),
	);
	const tail = (await readFileLinesBounded(cwd, task.files.output, count)).join("\n").trim();
	return prependRefreshWarning(
		[
			`Logs: ${task.displayName || task.specId}`,
			`Run: ${run.runId}`,
			`Task: ${task.specId || task.taskId}`,
			`Output: ${task.files.output}`,
			"",
			tail || "(empty log)",
		].join("\n"),
		warning,
	);
}

export function formatHumanRunStatus(
	run: WorkflowRunRecord,
	options: { supervisor?: WorkflowSupervisorRecord; nowMs?: number } = {},
): string {
	return formatHumanRunCard(run, { ...options, mode: "status" });
}

export function formatHumanRunDetails(
	run: WorkflowRunRecord,
	options: { supervisor?: WorkflowSupervisorRecord; nowMs?: number } = {},
): string {
	return formatHumanRunCard(run, {
		...options,
		mode: "details",
		includeUsage: true,
	});
}

export function formatHumanRunOutcome(
	run: WorkflowRunRecord,
	options: { supervisor?: WorkflowSupervisorRecord; nowMs?: number } = {},
): string {
	return formatHumanRunCard(run, {
		...options,
		mode: "outcome",
		includeUsage: true,
	});
}

export function formatHumanRunResume(
	run: WorkflowRunRecord,
	resetCount: number,
	options: { supervisor?: WorkflowSupervisorRecord; nowMs?: number } = {},
): string {
	return [
		`Workflow ${run.status === "running" ? "resumed" : "resume result"}: ${workflowName(run)}`,
		`Run: ${run.runId}`,
		"",
		resetCount === 0
			? "No tasks were reset."
			: `Reset ${resetCount} task(s) and scheduled remaining work.`,
		`Progress: ${formatHumanProgress(run)}`,
		...formatWarnings(run, options),
		...taskSections(run),
		"",
		`Open: /workflow ${run.runId}`,
	].join("\n");
}

export function formatHumanRunStop(
	run: WorkflowRunRecord,
	interruptedCount: number,
): string {
	return [
		`Workflow stopped: ${workflowName(run)}`,
		`Run: ${run.runId}`,
		"",
		interruptedCount === 0
			? "Nothing was interrupted."
			: `Interrupted ${interruptedCount} task(s).`,
		`Progress: ${formatHumanProgress(run)}`,
		"",
		`Open: /workflow ${run.runId}`,
		`Resume: /workflow resume ${run.runId}`,
	].join("\n");
}

export function formatHumanRunLaunch(
	run: WorkflowRunRecord,
	options: { supervisor?: WorkflowSupervisorRecord; nowMs?: number } = {},
): string {
	return [
		`Run: ${run.runId}`,
		"",
		`Progress: ${formatHumanProgress(run)}`,
		...formatWarnings(run, options),
		...taskSections(run),
	].join("\n");
}

/**
 * One line per loop stage so status/show expose round count and the loop
 * outcome, which otherwise only appear in run.json `loopStates` or per-round
 * task ids such as `<loop>.r02.<child>`.
 */
export function formatLoopSummaryLines(run: WorkflowRunRecord): string[] {
	const states = run.loopStates ?? [];
	if (states.length === 0) return [];
	return states.map((state) => {
		const rounds = `${state.round} round${state.round === 1 ? "" : "s"}`;
		const outcome =
			state.status === "completed"
				? "stopped: until condition met"
				: state.status === "exhausted"
					? "exhausted: maxRounds reached before the until condition was met"
					: state.status === "stopped_no_progress"
						? "stopped: no progress between rounds"
						: state.awaitingOnExhausted
							? "awaiting onExhausted stage"
							: "in progress";
		return `Loop ${state.loopId}: ${rounds} · ${outcome}`;
	});
}

function formatHumanRunCard(
	run: WorkflowRunRecord,
	options: {
		supervisor?: WorkflowSupervisorRecord;
		nowMs?: number;
		mode: "status" | "details" | "outcome";
		includeUsage?: boolean;
	},
): string {
	const heading =
		options.mode === "outcome"
			? `Workflow ${run.status}: ${workflowName(run)}`
			: `Workflow: ${workflowName(run)}`;
	const lines = [heading, `Run: ${run.runId}`];
	if (options.mode !== "outcome") lines.push(`Status: ${run.status}`);
	if (options.mode === "details") {
		lines.push(`Started: ${friendlyTimestamp(run.createdAt)}`);
		lines.push(`Updated: ${friendlyTimestamp(run.updatedAt)}`);
	}
	lines.push("", `Progress: ${formatHumanProgress(run)}`);
	lines.push(...formatLoopSummaryLines(run));
	const usage = options.includeUsage ? formatHumanUsageLine(run) : undefined;
	if (usage) lines.push(usage);
	lines.push(...formatWarnings(run, options));
	const problem = firstProblemTask(run);
	if (problem)
		lines.push(
			"",
			"Needs attention:",
			`  • ${formatTaskHuman(problem, true)}`,
			`    ${taskReason(problem)}`,
		);
	if (options.mode === "details") {
		const completed = run.tasks
			.filter((task) => task.status === "completed")
			.slice(0, 5);
		if (completed.length > 0) {
			lines.push(
				"",
				"Completed:",
				...completed.map((task) => `  ✓ ${task.displayName || task.specId}`),
			);
		}
	}
	lines.push(...taskSections(run));
	lines.push("", `Open: /workflow ${run.runId}`);
	if (["failed", "blocked", "interrupted"].includes(run.status))
		lines.push(`Resume: /workflow resume ${run.runId}`);
	if (options.mode === "details") {
		lines.push(`Logs: /workflow logs ${run.runId} <task-or-spec-id>`);
		lines.push(`Raw: /workflow show --raw ${run.runId}`);
	}
	return lines.join("\n");
}

function taskSections(run: WorkflowRunRecord): string[] {
	const sections: string[] = [];
	appendTaskSection(
		sections,
		"Now",
		run.tasks.filter((task) => task.status === "running").slice(0, 3),
		true,
	);
	appendTaskSection(sections, "Waiting", waitingTasks(run).slice(0, 3), true);
	appendTaskSection(sections, "Next", nextReadyTasks(run).slice(0, 3), false);
	return sections;
}

function appendTaskSection(
	lines: string[],
	label: string,
	tasks: WorkflowTaskRunRecord[],
	includeRuntime: boolean,
): void {
	if (tasks.length === 0) return;
	lines.push(
		"",
		`${label}:`,
		...tasks.map((task) => `  • ${formatTaskHuman(task, includeRuntime)}`),
	);
}

function waitingTasks(run: WorkflowRunRecord): WorkflowTaskRunRecord[] {
	return run.tasks.filter(isWaitingTask);
}

function nextReadyTasks(run: WorkflowRunRecord): WorkflowTaskRunRecord[] {
	const completed = new Set(
		run.tasks
			.filter((task) => task.status === "completed")
			.map((task) => task.specId),
	);
	return run.tasks.filter((task) => {
		if (task.status !== "pending" || isWaitingTask(task)) return false;
		return (task.dependsOn ?? []).every((dep) => completed.has(dep));
	});
}

function isWaitingTask(task: WorkflowTaskRunRecord): boolean {
	const nextEligibleAt = task.launchRetry?.nextEligibleAt;
	if (
		typeof nextEligibleAt === "string" &&
		Number.isFinite(Date.parse(nextEligibleAt)) &&
		Date.parse(nextEligibleAt) > Date.now()
	)
		return true;
	const text =
		`${task.statusDetail} ${task.lastMessage ?? ""} ${task.launchRetry?.reason ?? ""} ${task.launchRetry?.message ?? ""}`.toLowerCase();
	return (
		text.includes("backoff") ||
		text.includes("waiting until") ||
		text.includes("retry_model_failure") ||
		text.includes("rate-limit")
	);
}

function firstProblemTask(
	run: WorkflowRunRecord,
): WorkflowTaskRunRecord | undefined {
	return run.tasks.find((task) =>
		["failed", "blocked", "interrupted"].includes(task.status),
	);
}

function taskReason(task: WorkflowTaskRunRecord): string {
	return (
		task.lastMessage ||
		task.launchRetry?.message ||
		task.outputRetry?.message ||
		task.statusDetail ||
		task.status
	);
}

function formatTaskHuman(
	task: WorkflowTaskRunRecord,
	includeRuntime: boolean,
): string {
	const reason = isWaitingTask(task) ? ` — ${formatWaitingReason(task)}` : "";
	const runtime = includeRuntime ? ` · ${taskRuntime(task)}` : "";
	return `${task.displayName || task.specId} — ${task.agent}${runtime}${reason}`;
}

function formatWaitingReason(task: WorkflowTaskRunRecord): string {
	const nextEligibleAt = task.launchRetry?.nextEligibleAt;
	if (nextEligibleAt) return `retry at ${friendlyTimestamp(nextEligibleAt)}`;
	return (
		task.lastMessage ||
		task.launchRetry?.message ||
		task.statusDetail ||
		"waiting"
	);
}

function taskRuntime(task: WorkflowTaskRunRecord): string {
	if (task.kind === "support") return "local support";
	const model = task.runtime.model ?? "model unknown";
	const thinking = task.runtime.thinking
		? `${task.runtime.thinking} reasoning`
		: "reasoning unknown";
	return `${model} · ${thinking}`;
}

function formatWarnings(
	run: WorkflowRunRecord,
	options: { supervisor?: WorkflowSupervisorRecord; nowMs?: number },
): string[] {
	const lines: string[] = [];
	if (run.degradation?.summary)
		lines.push(`⚠ Degraded: ${run.degradation.summary}`);
	const captureLag = formatTerminalCaptureLagWarning(run);
	if (captureLag) lines.push(captureLag);
	const toolResultBudget = formatHumanToolResultBudgetSignal(run);
	if (toolResultBudget) lines.push(toolResultBudget);
	const stall = formatRunStallWarning(
		run,
		options.supervisor,
		options.nowMs ?? Date.now(),
	);
	if (stall) lines.push(stall);
	return lines.length > 0 ? ["", ...lines] : [];
}

function formatTerminalCaptureLagWarning(
	run: WorkflowRunRecord,
): string | undefined {
	const metricsByTask = new Map(
		buildWorkflowRunMetrics(run).byTask.map((task) => [task.taskId, task]),
	);
	const lagged = run.tasks
		.map((task) => ({ task, metrics: metricsByTask.get(task.taskId) }))
		.filter(
			(entry) =>
				entry.metrics?.launchTiming.terminalCaptureLagMs !== null &&
				(entry.metrics?.launchTiming.terminalCaptureLagMs ?? 0) >=
					TERMINAL_CAPTURE_LAG_WARNING_MS,
		)
		.sort(
			(left, right) =>
				(right.metrics?.launchTiming.terminalCaptureLagMs ?? 0) -
				(left.metrics?.launchTiming.terminalCaptureLagMs ?? 0),
		);
	if (lagged.length === 0) return undefined;
	const first = lagged[0];
	const lagMs = first.metrics?.launchTiming.terminalCaptureLagMs ?? 0;
	const completedAt = first.task.timing?.executionCompletedAt;
	const capturedAt = first.task.timing?.capturedAt;
	const timing =
		completedAt && capturedAt
			? `; completed ${friendlyTimestamp(completedAt)}, captured ${friendlyTimestamp(capturedAt)}`
			: "";
	return `⚠ terminal capture lag ${formatStallAge(lagMs)} on ${first.task.taskId}/${first.task.specId}${timing} (${lagged.length} task${lagged.length === 1 ? "" : "s"} over 2m; model execution may have completed earlier)`;
}

function hasToolResultBudgetSignal(run: WorkflowRunRecord): boolean {
	const totals = buildDynamicToolResultBudgetMetrics(run).totals;
	return (
		totals.evictionAttempts > 0 ||
		totals.forcedEvictionAttempts > 0 ||
		totals.contextRecoveryAttempts > 0 ||
		totals.contextLengthExceededAttempts > 0 ||
		totals.warningAttempts > 0
	);
}

function formatHumanToolResultBudgetSignal(
	run: WorkflowRunRecord,
): string | undefined {
	if (!hasToolResultBudgetSignal(run)) return undefined;
	const totals = buildDynamicToolResultBudgetMetrics(run).totals;
	const parts: string[] = [];
	if (totals.evictionAttempts > 0) {
		parts.push(
			`${totals.evictionAttempts} eviction attempt${totals.evictionAttempts === 1 ? "" : "s"}`,
			`${totals.observedEvictedCount} observed results / ${totals.observedEvictedChars} observed chars evicted`,
		);
	}
	if (totals.forcedEvictionAttempts > 0) {
		parts.push(`${totals.forcedEvictionAttempts} forced-eviction attempts`);
	}
	if (totals.maxUtilization !== null) {
		parts.push(`peak retained/cap ${Math.round(totals.maxUtilization * 100)}%`);
	}
	if (totals.contextRecoveryAttempts > 0) {
		parts.push(`${totals.contextRecoveryAttempts} context recoveries`);
	}
	if (totals.contextLengthExceededAttempts > 0) {
		parts.push(
			`${totals.contextLengthExceededAttempts} context-limit attempts`,
		);
	}
	if (totals.warningAttempts > 0) {
		parts.push(`${totals.warningAttempts} backend warnings`);
	}
	const telemetryDenominator =
		totals.fullyReportingTasks +
		totals.partiallyReportingTasks +
		totals.unavailableTasks;
	parts.push(
		`telemetry ${totals.fullyReportingTasks}/${telemetryDenominator} complete${totals.partiallyReportingTasks > 0 ? `, ${totals.partiallyReportingTasks} partial` : ""}`,
		`eviction counters ${totals.evictionCounterReportingAttempts}/${totals.evictionCounterExpectedAttempts} attempts`,
	);
	return `⚠ Tool-result budget: ${parts.join(" · ")}`;
}

function formatRawToolResultBudgetSignal(
	run: WorkflowRunRecord,
): string | undefined {
	if (!hasToolResultBudgetSignal(run)) return undefined;
	const totals = buildDynamicToolResultBudgetMetrics(run).totals;
	const telemetryDenominator =
		totals.fullyReportingTasks +
		totals.partiallyReportingTasks +
		totals.unavailableTasks;
	return `toolResultBudget=evictionAttempts=${totals.evictionAttempts}, observedEvictedCount=${totals.observedEvictedCount}, observedEvictedChars=${totals.observedEvictedChars}, forcedEvictionAttempts=${totals.forcedEvictionAttempts}, maxUtilization=${totals.maxUtilization ?? "n/a"}, contextRecoveryAttempts=${totals.contextRecoveryAttempts}, contextLengthExceededAttempts=${totals.contextLengthExceededAttempts}, warningAttempts=${totals.warningAttempts}, tasksFullyReporting=${totals.fullyReportingTasks}/${telemetryDenominator}, tasksPartiallyReporting=${totals.partiallyReportingTasks}, evictionCountersReporting=${totals.evictionCounterReportingAttempts}/${totals.evictionCounterExpectedAttempts}`;
}

function formatHumanProgress(run: WorkflowRunRecord): string {
	const summary = run.taskSummary;
	const parts = [
		`${summary.completed}/${summary.total} completed`,
		`${summary.running} running`,
		`${summary.pending} queued`,
	];
	if (summary.blocked > 0) parts.push(`${summary.blocked} blocked`);
	if (summary.failed > 0) parts.push(`${summary.failed} failed`);
	if (summary.interrupted > 0) parts.push(`${summary.interrupted} interrupted`);
	return parts.join(" · ");
}

function workflowName(run: Pick<WorkflowRunRecord, "name" | "type">): string {
	return run.name ?? run.type;
}

function friendlyTimestamp(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date
		.toISOString()
		.replace("T", " ")
		.replace(/:\d{2}\.\d{3}Z$/, "Z");
}

function formatHumanUsageLine(run: WorkflowRunRecord): string | undefined {
	const usage = buildWorkflowRunMetrics(run).totals.usage.observed;
	if (
		usage.totalTokens === null &&
		usage.inputTokens === null &&
		usage.outputTokens === null
	)
		return undefined;
	const parts = [
		`Usage: ${usage.totalTokens ?? "n/a"} tokens`,
		`in ${usage.inputTokens ?? "n/a"}`,
		`out ${usage.outputTokens ?? "n/a"}`,
	];
	if (
		usage.cacheReadInputTokens !== null ||
		usage.cacheCreationInputTokens !== null
	)
		parts.push(
			`cache r/w ${usage.cacheReadInputTokens ?? "n/a"} / ${usage.cacheCreationInputTokens ?? "n/a"}`,
		);
	parts.push(
		`${usage.contributingTaskIds.length}/${run.tasks.length} tasks reporting`,
	);
	return parts.join(" · ");
}

async function formatHumanRunList(
	cwd: string,
	index: WorkflowIndexRecord,
): Promise<string> {
	const active = index.runs.filter((run) =>
		["running", "blocked", "failed", "interrupted"].includes(run.status),
	);
	const completed = index.runs
		.filter((run) => run.status === "completed")
		.slice(0, 5);
	const mockTags = await mockTagMap(cwd, [...active, ...completed]);
	const lines = ["Workflow runs"];
	appendRunGroup(
		lines,
		"Active",
		active.filter((run) => run.status === "running"),
		mockTags,
	);
	appendRunGroup(
		lines,
		"Needs attention",
		active.filter((run) => run.status !== "running"),
		mockTags,
	);
	appendRunGroup(lines, "Recently completed", completed, mockTags);
	if (lines.length === 1) lines.push("", "No active workflow runs.");
	return lines.join("\n");
}

async function mockTagMap(
	cwd: string,
	runs: WorkflowIndexRecord["runs"],
): Promise<Map<string, string>> {
	const entries = await Promise.all(
		runs.map(async (run) => {
			const fullRun = await readRunRecord(cwd, run.runId).catch(
				() => undefined,
			);
			const mode = isMockRunProvenance(fullRun?.provenance)
				? fullRun?.provenance?.mode
				: undefined;
			return [run.runId, mode ? ` mock(${mode})` : ""] as const;
		}),
	);
	return new Map(entries);
}

function appendRunGroup(
	lines: string[],
	label: string,
	runs: WorkflowIndexRecord["runs"],
	mockTags: Map<string, string>,
): void {
	if (runs.length === 0) return;
	lines.push("", label);
	for (const run of runs) {
		lines.push(
			`  • ${run.name ?? run.type} — ${run.status}${mockTags.get(run.runId) ?? ""} · ${formatSummaryProgress(run.taskSummary)}`,
		);
		lines.push(`    /workflow ${run.runId}`);
	}
}

function formatSummaryProgress(
	summary: WorkflowRunRecord["taskSummary"],
): string {
	const parts = [
		`${summary.completed}/${summary.total} completed`,
		`${summary.running} running`,
		`${summary.pending} queued`,
	];
	if (summary.blocked > 0) parts.push(`${summary.blocked} blocked`);
	if (summary.failed > 0) parts.push(`${summary.failed} failed`);
	if (summary.interrupted > 0) parts.push(`${summary.interrupted} interrupted`);
	return parts.join(" · ");
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
	const captureLagWarning = formatTerminalCaptureLagWarning(run);
	if (captureLagWarning) lines.push(captureLagWarning);
	const toolResultBudgetSignal = formatRawToolResultBudgetSignal(run);
	if (toolResultBudgetSignal) lines.push(toolResultBudgetSignal);
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
	];
	if (
		observed.cacheReadInputTokens !== null ||
		observed.cacheCreationInputTokens !== null
	) {
		parts.push(`cacheRead=${observed.cacheReadInputTokens ?? "n/a"}`);
		parts.push(`cacheWrite=${observed.cacheCreationInputTokens ?? "n/a"}`);
	}
	parts.push(
		`tasksReporting=${observed.contributingTaskIds.length}/${run.tasks.length}`,
	);
	return `usage=${parts.join(", ")}`;
}

async function reconcileActiveRuns(cwd: string): Promise<void> {
	const runs = await listRunRecords(cwd);
	for (const run of runs) {
		if (hasActiveSchedulerWork(run))
			await refreshRunRecordingSupervisorError(cwd, run.runId);
	}
}

async function reconcileIndexedActiveRuns(
	cwd: string,
	index: WorkflowIndexRecord,
): Promise<void> {
	for (const run of index.runs) {
		if (hasActiveSchedulerWork(run))
			await refreshRunRecordingSupervisorError(cwd, run.runId);
	}
}

async function refreshRunRecordingSupervisorError(
	cwd: string,
	runId: string,
): Promise<void> {
	try {
		await refreshRun(cwd, runId);
	} catch (error) {
		await recordSupervisorError(cwd, runId, error);
	}
}

function formatTask(
	task: WorkflowTaskRunRecord,
	detail: "summary" | "full",
): string {
	const elapsed = formatTaskElapsed(task);
	const pid = task.pid ? ` pid=${task.pid}` : "";
	const runtime = formatTaskRuntime(task);
	const full = formatTaskDetail(task, detail);
	const message = task.lastMessage ? `\n  last=${task.lastMessage}` : "";
	const kind = task.kind && task.kind !== "main" ? ` kind=${task.kind}` : "";
	return `- ${task.taskId}${kind} spec=${task.specId} agent=${task.agent} [${task.status}/${task.statusDetail}]${elapsed}${pid} ${runtime}${full}${message}`;
}

function formatTaskElapsed(task: WorkflowTaskRunRecord): string {
	return task.elapsedMs !== undefined
		? ` elapsed=${Math.round(task.elapsedMs / 1000)}s`
		: "";
}

function formatTaskRuntime(task: WorkflowTaskRunRecord): string {
	if (task.kind === "support") return "runtime=local-support";
	return `model=${task.runtime.model ?? "(not recorded)"} thinking=${task.runtime.thinking ?? "(not recorded)"}`;
}

function formatTaskDetail(
	task: WorkflowTaskRunRecord,
	detail: "summary" | "full",
): string {
	if (detail !== "full") return ` output=${task.files.output}`;
	return `\n  agentFile=${task.agentFile}\n  cwd=${task.cwd}${formatTaskWorktree(task)}${formatTaskDependencies(task)}\n  tools=${formatTaskTools(task)}\n  output=${task.files.output}\n  stderr=${task.files.stderr}\n  result=${task.files.result}`;
}

function formatTaskWorktree(task: WorkflowTaskRunRecord): string {
	return task.worktree.enabled ? `\n  worktree=${task.worktree.path}` : "";
}

function formatTaskDependencies(task: WorkflowTaskRunRecord): string {
	return task.dependsOn && task.dependsOn.length > 0
		? `\n  dependsOn=${task.dependsOn.join(",")}`
		: "";
}

function formatTaskTools(task: WorkflowTaskRunRecord): string {
	if (task.kind === "support") return "(support helper; not subagent tools)";
	return task.tools?.join(",") ?? "(Pi default)";
}
