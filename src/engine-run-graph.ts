import {
	createTaskRunRecord,
	isTerminalTaskStatus,
	setTaskTerminal,
} from "./store.js";
import type {
	CompiledTask,
	CompiledWorkflow,
	WorkflowRunRecord,
	WorkflowTaskRunRecord,
} from "./types.js";

export function reconcileLoopTaskRecordsInMemory(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	loopIds: Set<string>,
): boolean {
	const compiledSpecIds = new Set(
		compiledFlow.tasks.map((task) => compiledTaskSpecId(task)),
	);
	const filteredRunTasks: WorkflowTaskRunRecord[] = [];
	const seenLoopSpecIds = new Set<string>();
	let changed = false;

	for (const task of run.tasks) {
		const loopGenerated = isLoopGeneratedRunTask(task, loopIds);
		if (loopGenerated && !compiledSpecIds.has(task.specId)) {
			changed = true;
			continue;
		}
		if (loopGenerated && seenLoopSpecIds.has(task.specId)) {
			changed = true;
			continue;
		}
		if (loopGenerated) seenLoopSpecIds.add(task.specId);
		filteredRunTasks.push(task);
	}

	const runTaskBySpecId = new Map<string, WorkflowTaskRunRecord>();
	for (const task of filteredRunTasks) {
		if (!runTaskBySpecId.has(task.specId))
			runTaskBySpecId.set(task.specId, task);
	}

	const reordered: WorkflowTaskRunRecord[] = [];
	const usedSpecIds = new Set<string>();
	let nextIndex = nextTaskRecordIndex({ ...run, tasks: filteredRunTasks });
	for (const compiledTask of compiledFlow.tasks) {
		const specId = compiledTaskSpecId(compiledTask);
		const existing = runTaskBySpecId.get(specId);
		if (existing) {
			reordered.push(existing);
			usedSpecIds.add(specId);
			continue;
		}
		if (!isLoopGeneratedCompiledTask(compiledTask, loopIds)) continue;
		const created = createTaskRunRecord(
			cwd,
			run.runId,
			compiledTask,
			nextIndex,
		);
		nextIndex += 1;
		reordered.push(created);
		usedSpecIds.add(specId);
		changed = true;
	}

	for (const task of filteredRunTasks) {
		if (!usedSpecIds.has(task.specId)) reordered.push(task);
	}

	if (!sameTaskRecordOrder(filteredRunTasks, reordered)) changed = true;
	if (changed) run.tasks = reordered;
	return changed;
}

export function recoverStaleRunningDynamicControllers(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
): boolean {
	let changed = false;
	for (const [index, task] of run.tasks.entries()) {
		const compiledTask = compiledFlow.tasks[index];
		if (compiledTask?.kind !== "dynamic") continue;
		if (task.status !== "running") continue;
		task.status = "pending";
		task.statusDetail = "recovered_stale_dynamic_controller";
		task.lastMessage =
			"recovered stale in-process dynamic controller after scheduler restart";
		task.pid = undefined;
		task.backendHandle = undefined;
		changed = true;
	}
	return changed;
}

export function reconcileDynamicGeneratedRunRecords(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
): boolean {
	let changed = false;
	for (const [index, compiledTask] of compiledFlow.tasks.entries()) {
		if (!compiledTask.dynamicGenerated) continue;
		const specId = compiledTaskSpecId(compiledTask);
		let runTask = run.tasks.find((task) => task.specId === specId);
		if (!runTask) {
			runTask = createTaskRunRecord(
				cwd,
				run.runId,
				compiledTask,
				nextTaskRecordIndex(run),
			);
			run.tasks.splice(index, 0, runTask);
			changed = true;
			continue;
		}
		const currentIndex = run.tasks.indexOf(runTask);
		if (currentIndex !== index) {
			run.tasks.splice(currentIndex, 1);
			run.tasks.splice(index, 0, runTask);
			changed = true;
		}
	}
	return changed;
}

export function assertRunTaskPositionalAlignment(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
): void {
	const maxLength = Math.max(run.tasks.length, compiledFlow.tasks.length);
	for (let index = 0; index < maxLength; index += 1) {
		const runTask = run.tasks[index];
		const compiledTask = compiledFlow.tasks[index];
		if (!runTask && compiledTask) {
			throw new Error(
				`Workflow task materialization is misaligned at index ${index}: compiled task ${compiledTaskSpecId(compiledTask)} has no run record`,
			);
		}
		if (runTask && !compiledTask) {
			throw new Error(
				`Workflow task materialization is misaligned at index ${index}: run task ${runTask.specId} has no compiled task`,
			);
		}
		if (runTask && compiledTask) {
			const specId = compiledTaskSpecId(compiledTask);
			if (runTask.specId !== specId) {
				throw new Error(
					`Workflow task materialization is misaligned at index ${index}: expected ${specId}, found ${runTask.specId}`,
				);
			}
		}
	}
}

export function assertLoopTaskPositionalAlignment(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	loopIds = loopStageIdSet(compiledFlow),
): void {
	for (const [index, compiledTask] of compiledFlow.tasks.entries()) {
		if (!isLoopGeneratedCompiledTask(compiledTask, loopIds)) continue;
		const runTask = run.tasks[index];
		const specId = compiledTaskSpecId(compiledTask);
		if (!runTask || runTask.specId !== specId) {
			throw new Error(
				`Loop task materialization is misaligned at index ${index}: expected ${specId}, found ${runTask?.specId ?? "(missing)"}`,
			);
		}
	}

	for (const [index, runTask] of run.tasks.entries()) {
		if (!isLoopGeneratedRunTask(runTask, loopIds)) continue;
		const compiledTask = compiledFlow.tasks[index];
		if (!compiledTask || compiledTaskSpecId(compiledTask) !== runTask.specId) {
			throw new Error(
				`Loop task materialization is misaligned at index ${index}: run task ${runTask.specId} has no matching compiled task`,
			);
		}
	}
}

export function upsertCompiledLoopTasksAtInsertion(
	compiledFlow: CompiledWorkflow,
	loopId: string,
	placeholderIndex: number,
	tasks: CompiledTask[],
): void {
	const specIds = new Set(tasks.map((task) => compiledTaskSpecId(task)));
	compiledFlow.tasks = compiledFlow.tasks.filter(
		(task) => !specIds.has(compiledTaskSpecId(task)),
	);
	const currentPlaceholderIndex = compiledFlow.tasks.findIndex(
		(task) => task.loopPlaceholder?.loopId === loopId,
	);
	const insertionIndex = loopInsertionIndex(
		compiledFlow,
		loopId,
		currentPlaceholderIndex === -1 ? placeholderIndex : currentPlaceholderIndex,
	);
	compiledFlow.tasks.splice(insertionIndex, 0, ...tasks);
}

export function compiledTaskSpecId(task: CompiledTask): string {
	const specId = (task as CompiledTask & { specId?: unknown }).specId;
	return typeof specId === "string" && specId.trim() !== "" ? specId : task.id;
}

function isLoopGeneratedCompiledTask(
	task: CompiledTask,
	loopIds: Set<string>,
): boolean {
	return Boolean(
		(task.loopChild?.loopId && loopIds.has(task.loopChild.loopId)) ||
			(task.loopExhausted?.loopId && loopIds.has(task.loopExhausted.loopId)),
	);
}

function isLoopGeneratedRunTask(
	task: WorkflowTaskRunRecord,
	loopIds: Set<string>,
): boolean {
	for (const loopId of loopIds) {
		if (task.specId.startsWith(`${loopId}.onExhausted.`)) return true;
		if (new RegExp(`^${escapeRegExp(loopId)}\\.r\\d{2}\\.`).test(task.specId))
			return true;
		if (task.stageId?.startsWith(`${loopId}.onExhausted`)) return true;
		if (
			new RegExp(`^${escapeRegExp(loopId)}\\.r\\d{2}\\.`).test(
				task.stageId ?? "",
			)
		)
			return true;
	}
	return false;
}

export function loopStageIdSet(compiledFlow: CompiledWorkflow): Set<string> {
	const loopIds = new Set<string>();
	for (const stage of (compiledFlow as any).stages ?? []) {
		if (stage?.type === "loop" && typeof stage.id === "string")
			loopIds.add(stage.id);
	}
	for (const task of compiledFlow.tasks) {
		if (task.loopChild?.loopId) loopIds.add(task.loopChild.loopId);
		if (task.loopExhausted?.loopId) loopIds.add(task.loopExhausted.loopId);
	}
	return loopIds;
}

function sameTaskRecordOrder(
	left: WorkflowTaskRunRecord[],
	right: WorkflowTaskRunRecord[],
): boolean {
	return (
		left.length === right.length &&
		left.every((task, index) => task === right[index])
	);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function loopInsertionIndex(
	compiledFlow: CompiledWorkflow,
	loopId: string,
	placeholderIndex: number,
): number {
	let index = Math.max(0, placeholderIndex + 1);
	while (index < compiledFlow.tasks.length) {
		const task = compiledFlow.tasks[index];
		if (
			task?.loopChild?.loopId === loopId ||
			task?.loopExhausted?.loopId === loopId
		) {
			index += 1;
			continue;
		}
		break;
	}
	return index;
}

export function nextTaskRecordIndex(run: WorkflowRunRecord): number {
	let max = 0;
	for (const task of run.tasks) {
		const match = /^task-(\d+)$/.exec(task.taskId);
		if (match) max = Math.max(max, Number(match[1]));
	}
	return max;
}

export function dependenciesReady(
	compiledTask: CompiledTask,
	bySpecId: Map<string, WorkflowTaskRunRecord>,
	compiledFlow: CompiledWorkflow,
): boolean {
	const deps = compiledTask.dependsOn ?? [];
	if (deps.length === 0) return true;
	const partial =
		stageSourcePolicy(compiledFlow, compiledTask.stageId ?? "") === "partial";
	return deps.every((dep) => {
		const status = bySpecId.get(dep)?.status;
		if (status === "completed") return true;
		if (partial && status && isTerminalTaskStatus(status)) return true;
		return false;
	});
}

export function buildForeachGeneratedTasks(
	template: CompiledTask,
	runtimeTask: string | undefined,
	items: unknown[],
): { tasks: CompiledTask[]; error?: string } {
	const seen = new Set<string>();
	const tasks: CompiledTask[] = [];
	for (const [index, item] of items.entries()) {
		const taskId = foreachItemTaskId(item, index);
		if (seen.has(taskId))
			return {
				tasks: [],
				error: `duplicate foreach generated task id "${taskId}"`,
			};
		seen.add(taskId);
		const specId = `${template.stageId}.${taskId}`;
		const itemText = formatForeachItem(item);
		const instructions = template.foreach!.prompt.replace(
			/\$\{item\}/g,
			escapeReplacementText(itemText),
		);
		const compiledPrompt = [
			template.foreach!.injectRuntimeTask && runtimeTask
				? `# Task\n\n${runtimeTask}`
				: undefined,
			`# Workflow Stage\n\nstage=${template.stageId}\ntype=foreach\nitem=${taskId}`,
			`# Instructions\n\n${instructions}`,
			template.foreach!.roleText || undefined,
		]
			.filter(Boolean)
			.join("\n\n");
		tasks.push({
			...template,
			id: specId,
			key: specId,
			specId,
			taskId,
			task: instructions,
			compiledPrompt,
			dependsOn: [...(template.dependsOn ?? [])],
			foreach: undefined,
		} as CompiledTask);
	}
	return { tasks };
}

function foreachItemTaskId(item: unknown, index: number): string {
	if (
		item &&
		typeof item === "object" &&
		typeof (item as any).id === "string"
	) {
		const sanitized = sanitizeTaskId((item as any).id);
		if (sanitized) return sanitized;
	}
	return `item-${String(index + 1).padStart(3, "0")}`;
}

export function sanitizeTaskId(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_.-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

function formatForeachItem(item: unknown): string {
	return typeof item === "string" ? item : JSON.stringify(item);
}

function escapeReplacementText(value: string): string {
	return value.replace(/\$/g, "$$$$");
}

export function sourceStageIdsForFrom(from: unknown): string[] {
	if (Array.isArray(from))
		return from.filter((item): item is string => typeof item === "string");
	if (typeof from === "string") return [from];
	if (
		from &&
		typeof from === "object" &&
		typeof (from as any).stage === "string"
	)
		return [(from as any).stage];
	return [];
}

export function stageSourcePolicy(
	compiledFlow: CompiledWorkflow,
	stageId: string,
): string {
	return (
		((compiledFlow as any).stages ?? []).find(
			(stage: any) => stage.id === stageId,
		)?.sourcePolicy ?? "require-success"
	);
}

export function updateDownstreamDependencies(
	compiledFlow: CompiledWorkflow,
	placeholderSpecId: string,
	generatedSpecIds: string[],
): void {
	for (const task of compiledFlow.tasks) {
		if (!task.dependsOn) continue;
		task.dependsOn = replaceDependencyList(
			task.dependsOn,
			placeholderSpecId,
			generatedSpecIds,
		);
	}
}

export function replaceDependencyList(
	dependsOn: string[],
	placeholderSpecId: string,
	generatedSpecIds: string[],
): string[] {
	const replaced: string[] = [];
	for (const dep of dependsOn) {
		if (dep === placeholderSpecId) replaced.push(...generatedSpecIds);
		else replaced.push(dep);
	}
	return [...new Set(replaced)];
}

export function markDagDependentsSkipped(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
): boolean {
	const bySpecId = new Map(run.tasks.map((task) => [task.specId, task]));
	let changed = false;
	let passChanged = true;

	while (passChanged) {
		passChanged = false;
		for (const [index, task] of run.tasks.entries()) {
			if (task.status !== "pending") continue;
			const compiledTask = compiledFlow.tasks[index];
			if (!compiledTask) continue;
			const failedDep = (compiledTask.dependsOn ?? []).find((dep) => {
				const status = bySpecId.get(dep)?.status;
				return (
					status === "failed" ||
					status === "interrupted" ||
					status === "skipped"
				);
			});
			if (!failedDep) continue;
			if (
				stageSourcePolicy(compiledFlow, compiledTask.stageId ?? "") ===
				"partial"
			)
				continue;
			setTaskTerminal(task, "skipped", "skipped_after_dependency_failure", {
				lastMessage: `skipped because dependency ${failedDep} did not complete`,
			});
			changed = true;
			passChanged = true;
		}
	}

	return changed;
}
