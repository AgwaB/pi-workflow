import { readWorkflowStopIntent } from "./store.js";

export const WORKFLOW_STOP_REQUESTED_ERROR_NAME = "WorkflowStopRequested";

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
		const intent = await readWorkflowStopIntent(cwd, runId).catch(
			() => undefined,
		);
		if (intent) controller.abort(createWorkflowStopRequestedError(runId));
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
	if (await readWorkflowStopIntent(cwd, runId)) {
		throw createWorkflowStopRequestedError(runId);
	}
}
