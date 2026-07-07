import { resolveWorkflowBackend } from "./backend.js";
import { formatApproxDuration } from "./run-estimates.js";
import {
	indexSupervisorErrorPath,
	readRunRecord,
	supervisorPath,
	withRunLease,
	writeJsonAtomic,
} from "./store.js";
import type { WorkflowRunRecord } from "./types.js";

const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
const MAX_WAIT_TIMEOUT_MS = 14_400_000;
export const POLL_INTERVAL_MS = 1_000;

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

export function hasActiveSchedulerWork(
	run: Pick<WorkflowRunRecord, "status" | "taskSummary">,
): boolean {
	return (
		run.status === "running" ||
		run.taskSummary.running > 0 ||
		run.taskSummary.pending > 0
	);
}

export function shouldWatchRun(
	run: Pick<WorkflowRunRecord, "status" | "taskSummary">,
): boolean {
	return hasActiveSchedulerWork(run);
}

export function isRefreshPollAggregateError(
	error: unknown,
): error is AggregateError {
	return error instanceof AggregateError;
}

export async function refreshRunOrRecordPollError(
	cwd: string,
	runIdOrPrefix: string,
	fallbackRun?: WorkflowRunRecord,
): Promise<WorkflowRunRecord> {
	try {
		return await refreshRun(cwd, runIdOrPrefix);
	} catch (error) {
		if (!isRefreshPollAggregateError(error)) throw error;
		const run = fallbackRun ?? (await readRunRecord(cwd, runIdOrPrefix));
		await recordSupervisorError(cwd, run.runId, error);
		return run;
	}
}

/**
 * Wait-timeout message. Messaging only: the run keeps progressing via the
 * in-session/detached supervisor after this error is thrown. Includes elapsed
 * wall time without deriving expectations from prior runs.
 */
export async function stillRunningAfterWaitMessage(
	cwd: string,
	run: WorkflowRunRecord,
	timeoutMs: number,
): Promise<string> {
	const createdAtMs = Date.parse(run.createdAt);
	const elapsed = formatApproxDuration(
		Number.isFinite(createdAtMs) ? Date.now() - createdAtMs : timeoutMs,
	);
	return `Flow run ${run.runId} still running (${elapsed} elapsed) after ${timeoutMs}ms wait — will keep supervising; check /workflow status ${run.runId}`;
}

export async function recordSupervisorError(
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

export function clampTimeout(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value))
		return DEFAULT_WAIT_TIMEOUT_MS;
	return Math.max(
		POLL_INTERVAL_MS,
		Math.min(MAX_WAIT_TIMEOUT_MS, Math.floor(value)),
	);
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
