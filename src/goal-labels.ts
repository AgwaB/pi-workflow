import type { WorkflowRunRecord, WorkflowTaskRunRecord } from "./types.js";

/**
 * Display names for the tasks a Goal generates. The engine names them by
 * internal identity (`goal.$rootPlanner.main`, `goal.generation1.result`,
 * `goal.verify.tests`); people read what they do and in which attempt.
 * Display only: records, logs and commands keep the internal identities.
 */
export function goalTaskLabels(run: Pick<WorkflowRunRecord, "tasks">): Map<string, string> {
	const labels = new Map<string, string>();
	for (const policy of run.tasks.filter((task) => task.kind === "goal")) {
		const prefix = policy.stageId ?? policy.specId;
		labels.set(policy.specId, "Goal controller");
		for (const task of run.tasks)
			if (task.stageId === `${prefix}.$rootPlanner`) labels.set(task.specId, "Plan · attempt 1");
		for (const generation of policy.goalRoot?.generations ?? []) {
			const attempt = `attempt ${generation.generation + 1}`;
			labels.set(generation.plannerSpecId, generation.generation === 0 ? `Plan · ${attempt}` : `Re-plan · ${attempt}`);
			for (const [slot, specId] of Object.entries(generation.slots))
				labels.set(specId, `Work: ${slot} · ${attempt}`);
			for (const [criterion, specId] of Object.entries(generation.verifiers ?? {}))
				labels.set(specId, `Check: ${criterion} · ${attempt}`);
		}
	}
	return labels;
}

const labelCache = new WeakMap<object, Map<string, string>>();

export function goalTaskLabel(
	run: Pick<WorkflowRunRecord, "tasks">,
	task: Pick<WorkflowTaskRunRecord, "specId">,
): string | undefined {
	let labels = labelCache.get(run);
	if (!labels) {
		labels = goalTaskLabels(run);
		labelCache.set(run, labels);
	}
	return labels.get(task.specId);
}

/** Stage names for a Goal run's two stages: its first plan and the Goal itself. */
export function goalStageLabel(run: Pick<WorkflowRunRecord, "tasks">, stageId: string): string | undefined {
	for (const policy of run.tasks.filter((task) => task.kind === "goal")) {
		const prefix = policy.stageId ?? policy.specId;
		if (stageId === `${prefix}.$rootPlanner`) return "Goal: first plan";
		if (stageId === prefix) return "Goal: attempts and checks";
	}
	return undefined;
}
