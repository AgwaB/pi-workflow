import type { WorkflowTaskRunRecord } from "./types.js";

/** Shared by manifest emission and bounded raw selection. */
export function sourceNameForTask(task: WorkflowTaskRunRecord, usedNames: Set<string>): string {
	const preferred = task.dynamicGenerated ? task.specId : (task.stageId ?? task.specId);
	if (!usedNames.has(preferred)) {
		usedNames.add(preferred);
		return preferred;
	}
	usedNames.add(task.specId);
	return task.specId;
}

export function dynamicOutputSourceName(controllerTask: WorkflowTaskRunRecord, index: number, usedNames: Set<string>): string {
	const base = `${controllerTask.stageId ?? controllerTask.specId}.output${index === 0 ? "" : `.${index + 1}`}`;
	if (!usedNames.has(base)) {
		usedNames.add(base);
		return base;
	}
	let suffix = 2;
	while (usedNames.has(`${base}.${suffix}`)) suffix += 1;
	const source = `${base}.${suffix}`;
	usedNames.add(source);
	return source;
}

export function dynamicOutputTaskSpecIds(control: unknown): string[] {
	if (!control || typeof control !== "object" || Array.isArray(control)) return [];
	const record = control as Record<string, unknown>;
	return [...new Set([record.outputTasks, record.outputTaskIds, record.exportedTasks]
		.flatMap(value => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []))];
}
