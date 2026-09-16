import { readWorkflowStopIntent, workflowRunPath } from "./store.js";

// A foreground abort must fence dispatch synchronously, before its durable stop
// intent finishes writing. Registrations live only for this exact launch owner.
const launchSignals = new Map<string, Set<AbortSignal>>();

export function bindWorkflowLaunchSignal(
	cwd: string,
	runId: string,
	signal: AbortSignal | undefined,
): () => void {
	if (!signal) return () => {};
	const key = workflowRunPath(cwd, runId);
	const signals = launchSignals.get(key) ?? new Set<AbortSignal>();
	signals.add(signal);
	launchSignals.set(key, signals);
	return () => {
		signals.delete(signal);
		if (signals.size === 0 && launchSignals.get(key) === signals)
			launchSignals.delete(key);
	};
}

function launchStopRequested(cwd: string, runId: string): boolean {
	return [...(launchSignals.get(workflowRunPath(cwd, runId)) ?? [])].some(
		(signal) => signal.aborted,
	);
}

export const WORKFLOW_STOP_REQUESTED_ERROR_NAME = "WorkflowStopRequested";
const WORKFLOW_STOP_PENDING_ERROR_NAME = "WorkflowStopPending";

export function createWorkflowStopPendingError(message: string): Error {
	const error = new Error(message);
	error.name = WORKFLOW_STOP_PENDING_ERROR_NAME;
	return error;
}

export function isWorkflowStopPendingError(error: unknown): error is Error {
	return error instanceof Error && error.name === WORKFLOW_STOP_PENDING_ERROR_NAME;
}

export function workflowStopRequestedMessage(runId: string): string {
	return `workflow stop requested for ${runId}`;
}

export function createWorkflowStopRequestedError(runId: string): Error {
	const error = new Error(workflowStopRequestedMessage(runId));
	error.name = WORKFLOW_STOP_REQUESTED_ERROR_NAME;
	return error;
}

export function isWorkflowStopRequestedError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.name === WORKFLOW_STOP_REQUESTED_ERROR_NAME ||
			error.message.startsWith("workflow stop requested"))
	);
}

export function createWorkflowStopSignal(
	cwd: string,
	runId: string,
	options: { pollMs?: number } = {},
): { signal: AbortSignal; dispose: () => void } {
	const controller = new AbortController();
	const pollMs = Math.max(10, options.pollMs ?? 50);
	const check = async (): Promise<void> => {
		if (controller.signal.aborted) return;
		if (launchStopRequested(cwd, runId)) {
			controller.abort(createWorkflowStopRequestedError(runId));
			return;
		}
		const intent = await readWorkflowStopIntent(cwd, runId).catch(
			() => undefined,
		);
		if (intent || launchStopRequested(cwd, runId))
			controller.abort(createWorkflowStopRequestedError(runId));
	};
	void check();
	const timer = setInterval(() => void check(), pollMs);
	timer.unref?.();
	return {
		signal: controller.signal,
		dispose: () => clearInterval(timer),
	};
}

export async function throwIfWorkflowStopRequested(
	cwd: string,
	runId: string,
): Promise<void> {
	if (launchStopRequested(cwd, runId))
		throw createWorkflowStopRequestedError(runId);
	const intent = await readWorkflowStopIntent(cwd, runId);
	// Cancellation may have arrived while the disk read was in flight.
	if (intent || launchStopRequested(cwd, runId))
		throw createWorkflowStopRequestedError(runId);
}
