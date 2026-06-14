import type { WorkflowTaskRunRecord } from "./types.js";
import { nowIso, setTaskTerminal } from "./store.js";

export interface TaskResultArtifact {
	resultFile: string;
	result: Record<string, unknown>;
	status: WorkflowTaskRunRecord["status"];
	completedAfterTimeout: boolean;
}

export function isTaskTimedOut(task: WorkflowTaskRunRecord): boolean {
	if (!task.startedAt || !task.runtime.maxRuntimeMs) return false;
	return Date.now() - Date.parse(task.startedAt) > task.runtime.maxRuntimeMs;
}

export function markTaskTimedOut(task: WorkflowTaskRunRecord): void {
	setTaskTerminal(task, "failed", "timeout", {
		exitCode: 124,
		lastMessage: `task exceeded timeout=${task.runtime.maxRuntimeMs}`,
	});
}

export async function applyTaskResultArtifact(
	_cwd: string,
	task: WorkflowTaskRunRecord,
	artifact: TaskResultArtifact,
): Promise<boolean> {
	const rawCompletedAt =
		typeof artifact.result.completedAt === "string"
			? artifact.result.completedAt
			: undefined;
	const completedAt =
		rawCompletedAt && Number.isFinite(Date.parse(rawCompletedAt))
			? rawCompletedAt
			: nowIso();

	if (artifact.completedAfterTimeout && artifact.status !== "completed") {
		markTaskTimedOut(task);
		return true;
	}

	return setTaskTerminal(task, artifact.status, artifact.status, {
		completedAt,
		exitCode:
			typeof artifact.result.exitCode === "number"
				? artifact.result.exitCode
				: undefined,
		lastMessage:
			typeof artifact.result.errorMessage === "string"
				? artifact.result.errorMessage
				: "completed",
	});
}
