import { resolve } from "node:path";

/**
 * Terminal ends of backend attempts that this process observed itself, from
 * the backend's own status or cancellation acknowledgement, never read back
 * from run records. Goal resume uses them to accept a worker that ended on its
 * own while the Goal was stopping: a changed run record cannot add an entry.
 */
export interface ObservedAttemptEnd {
	readonly backendAttemptId: string;
	readonly status: "cancelled" | "completed" | "failed";
}

const ends = new Map<string, ObservedAttemptEnd>();

const key = (cwd: string, runId: string, taskId: string, attemptKey: string) =>
	`${resolve(cwd)}\0${runId}\0${taskId}\0${attemptKey}`;

export function recordObservedAttemptEnd(input: {
	cwd: string; runId: string; taskId: string; attemptKey: string;
	backendAttemptId: string | undefined; status: string;
}): void {
	if (!input.backendAttemptId ||
		(input.status !== "cancelled" && input.status !== "completed" && input.status !== "failed")) return;
	ends.set(key(input.cwd, input.runId, input.taskId, input.attemptKey),
		Object.freeze({ backendAttemptId: input.backendAttemptId, status: input.status }));
}

export function observedAttemptEnd(cwd: string, runId: string, taskId: string,
	attemptKey: string): ObservedAttemptEnd | undefined {
	return ends.get(key(cwd, runId, taskId, attemptKey));
}

type AttemptReceipt = { attemptKey: string; phase: string; backendAttemptId?: string;
	cancellation?: { terminalAttemptId?: string; terminalStatus?: string; terminalObservedAt?: string } };

/**
 * A stopped task whose recorded attempt this process saw fail by itself
 * (for example its next model request was refused because the Goal was
 * stopping). It cannot act any more, like a cancelled attempt.
 */
export function attemptEndedOnItsOwnWhileStopping(cwd: string, runId: string,
	task: { taskId: string; status: string; statusDetail?: string }, receipt: AttemptReceipt): boolean {
	if (task.status !== "interrupted" || task.statusDetail !== "workflow_stopped") return false;
	return attemptObservedFailing(cwd, runId, task.taskId, receipt);
}

/**
 * An earlier attempt of a task (the task may since have been resumed) that
 * this process saw fail by itself; its receipt matches that observed end.
 */
export function attemptObservedFailing(cwd: string, runId: string, taskId: string, receipt: AttemptReceipt): boolean {
	if (!receipt.backendAttemptId) return false;
	const observed = observedAttemptEnd(cwd, runId, taskId, receipt.attemptKey);
	if (observed?.status !== "failed" || observed.backendAttemptId !== receipt.backendAttemptId) return false;
	if (receipt.phase === "acknowledged") return true;
	return receipt.phase === "cancellation_acknowledged" && receipt.cancellation?.terminalStatus === "failed" &&
		receipt.cancellation.terminalAttemptId === receipt.backendAttemptId && !!receipt.cancellation.terminalObservedAt;
}
