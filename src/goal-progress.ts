import type { WorkflowRunRecord } from "./types.js";

/** Display-only progress of a running root Goal; never authority or evidence. */
export interface WorkflowGoalProgress {
	/** Plan attempts so far (first plan plus replans), including a recovered run's. */
	attempt: number;
	phase: "planning" | "working" | "verifying" | "checking" | "waiting for your judgment" | "waiting";
}

export function summarizeGoalProgress(run: WorkflowRunRecord): WorkflowGoalProgress | undefined {
	if (run.parentRunId) return undefined;
	const root = run.tasks.find((task) => task.kind === "goal" && task.goalRoot !== undefined) ??
		run.tasks.find((task) => task.kind === "goal");
	if (!root) return undefined;
	const generations = root.goalRoot?.generations ?? [];
	const latest = generations.at(-1);
	const attempt = (run.goalRecovery?.priorGenerations ?? 0) + Math.max(1, generations.length);
	const running = new Set(run.tasks.filter((task) => task.status === "running").map((task) => task.specId));
	const has = (ids: Iterable<string> | undefined) => [...(ids ?? [])].some((id) => running.has(id));
	let phase: WorkflowGoalProgress["phase"];
	if (root.statusDetail === "goal_waiting_user") phase = "waiting for your judgment";
	else if (latest ? running.has(latest.plannerSpecId)
		: run.tasks.some((task) => running.has(task.specId) && task.stageId?.endsWith(".$rootPlanner")))
		phase = "planning";
	else if (latest && (has(Object.values(latest.slots)) || Object.keys(latest.children ?? {}).length > 0 &&
		root.statusDetail === "goal_catalog_child_waiting"))
		phase = "working";
	else if (latest && has(Object.values(latest.verifiers ?? {}))) phase = "verifying";
	else if (root.status === "running") phase = "checking";
	else phase = "waiting";
	return { attempt, phase };
}
