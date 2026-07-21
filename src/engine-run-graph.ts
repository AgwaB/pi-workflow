import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

import {
	createTaskRunRecord,
	FAIL_FAST_CANCELLED_STATUS_DETAIL,
	fromProjectPath,
	isTerminalTaskStatus,
	setTaskTerminal,
} from "./store.js";
import {
	EXPERIMENTAL_CACHE_STABLE_FOREACH_ENV,
	workflowExperimentalFlagEnabled,
} from "./experimental-speed-flags.js";
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
	assertRunTaskPositionalAlignment(run, compiledFlow);
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

export function recoverStaleRunningSupportTasks(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
): boolean {
	assertRunTaskPositionalAlignment(run, compiledFlow);
	let changed = false;
	for (const [index, task] of run.tasks.entries()) {
		const compiledTask = compiledFlow.tasks[index];
		if (compiledTask?.kind !== "support") continue;
		if (task.status !== "running") continue;
		setTaskTerminal(task, "failed", "recovered_stale_support_task", {
			lastMessage:
				"failed closed: recovered stale in-process support helper after scheduler restart; helper side effects were not replayed",
		});
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

export function reconcileForeachGeneratedRunRecords(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
): boolean {
	let changed = false;
	const compiledOnlyBoundaries = assertExactForeachGeneratedMembership(
		cwd,
		run,
		compiledFlow,
	);
	const compiledSpecIds = new Set(
		compiledFlow.tasks.map((task) => compiledTaskSpecId(task)),
	);
	const compiledTaskBySpecId = new Map(
		compiledFlow.tasks.map((task) => [compiledTaskSpecId(task), task]),
	);
	const placeholderToGeneratedSpecIds = new Map<string, string[]>();
	const streamingPlaceholderSpecIds = new Set<string>();

	for (const compiledTask of compiledFlow.tasks) {
		const specId = compiledTaskSpecId(compiledTask);
		if (compiledTask.foreach && foreachStreamingEnabled(compiledTask)) {
			streamingPlaceholderSpecIds.add(specId);
		}
		const placeholderSpecId = foreachGeneratedPlaceholderSpecId(compiledTask);
		if (!placeholderSpecId) continue;
		if (
			compiledTask.foreachGenerated?.placeholderSpecId !== placeholderSpecId
		) {
			compiledTask.foreachGenerated = {
				...compiledTask.foreachGenerated,
				placeholderSpecId,
			};
			changed = true;
		}
		const generated =
			placeholderToGeneratedSpecIds.get(placeholderSpecId) ?? [];
		generated.push(specId);
		placeholderToGeneratedSpecIds.set(placeholderSpecId, generated);
	}

	assertAuthoritativeForeachDispatchMaps(run, compiledFlow);
	if (placeholderToGeneratedSpecIds.size === 0) {
		return synchronizeTerminalBarrierSourceSpecIds(run, compiledFlow) || changed;
	}

	const filteredRunTasks: WorkflowTaskRunRecord[] = [];
	const seenGeneratedSpecIds = new Set<string>();
	for (const task of run.tasks) {
		const generatedSpecIds = placeholderToGeneratedSpecIds.get(task.specId);
		const placeholderSpecId = foreachGeneratedPlaceholderSpecId(task);
		if (generatedSpecIds && !placeholderSpecId) {
			if (compiledOnlyBoundaries.has(task.specId)) {
				changed = true;
				continue;
			}
			const compiledTask = compiledTaskBySpecId.get(task.specId);
			if (
				compiledTask?.foreach &&
				(streamingPlaceholderSpecIds.has(task.specId) ||
					task.dispatchMap !== undefined)
			) {
				filteredRunTasks.push(task);
				continue;
			}
			throw new Error(
				`Cannot reconcile foreach generated membership: placeholder ${task.specId} conflicts with its compiled child set`,
			);
		}
		if (placeholderSpecId && !compiledSpecIds.has(task.specId)) {
			throw new Error(
				`Cannot reconcile foreach generated membership: child ${task.specId} is missing from compiled state`,
			);
		}
		if (placeholderSpecId && seenGeneratedSpecIds.has(task.specId)) {
			throw new Error(
				`Cannot reconcile foreach generated membership: child ${task.specId} is duplicated`,
			);
		}
		if (placeholderSpecId) seenGeneratedSpecIds.add(task.specId);
		filteredRunTasks.push(task);
	}

	const runTaskBySpecId = new Map<string, WorkflowTaskRunRecord>();
	for (const task of filteredRunTasks) {
		if (runTaskBySpecId.has(task.specId)) {
			throw new Error(
				`Cannot reconcile foreach generated membership: run spec id ${task.specId} is duplicated`,
			);
		}
		runTaskBySpecId.set(task.specId, task);
	}

	const reordered: WorkflowTaskRunRecord[] = [];
	const usedSpecIds = new Set<string>();
	let nextIndex = nextTaskRecordIndex({ ...run, tasks: filteredRunTasks });
	for (const compiledTask of compiledFlow.tasks) {
		const specId = compiledTaskSpecId(compiledTask);
		const existing = runTaskBySpecId.get(specId);
		if (existing) {
			if (
				compiledTask.foreachGenerated &&
				!sameForeachGeneratedTaskTuple(existing, compiledTask)
			) {
				throw new Error(
					`Cannot reconcile foreach generated membership: child ${specId} does not exactly match compiled state`,
				);
			}
			reordered.push(existing);
			usedSpecIds.add(specId);
			continue;
		}
		if (!compiledTask.foreachGenerated) continue;
		const boundary = compiledOnlyBoundaries.get(
			compiledTask.foreachGenerated.placeholderSpecId,
		);
		if (!boundary?.generatedSpecIds.has(specId)) {
			throw new Error(
				`Cannot reconcile foreach generated membership: compiled child ${specId} has no exact recovery boundary`,
			);
		}
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

	if (!sameTaskRecordOrder(run.tasks, reordered)) changed = true;
	for (const task of reordered) {
		if (!task.dependsOn) continue;
		const replaced = replaceForeachGeneratedDependencies(
			task.dependsOn,
			placeholderToGeneratedSpecIds,
			streamingPlaceholderSpecIds,
		);
		if (!sameStringList(task.dependsOn, replaced)) {
			task.dependsOn = replaced;
			changed = true;
		}
	}
	for (const task of compiledFlow.tasks) {
		if (task.dependsOn) {
			const replaced = replaceForeachGeneratedDependencies(
				task.dependsOn,
				placeholderToGeneratedSpecIds,
				streamingPlaceholderSpecIds,
			);
			if (!sameStringList(task.dependsOn, replaced)) {
				task.dependsOn = replaced;
				changed = true;
			}
		}
		if (task.contextDependsOn) {
			const replaced = replaceForeachGeneratedDependencies(
				task.contextDependsOn,
				placeholderToGeneratedSpecIds,
				streamingPlaceholderSpecIds,
			);
			if (!sameStringList(task.contextDependsOn, replaced)) {
				task.contextDependsOn = replaced;
				changed = true;
			}
		}
	}
	if (changed) run.tasks = reordered;
	if (synchronizeTerminalBarrierSourceSpecIds(run, compiledFlow)) changed = true;
	return changed;
}

type CompiledOnlyForeachBoundary = {
	placeholderSpecId: string;
	generatedSpecIds: ReadonlySet<string>;
};

function sameForeachGeneratedTaskTuple(
	runTask: WorkflowTaskRunRecord,
	compiledTask: CompiledTask,
): boolean {
	return (
		runTask.specId === compiledTaskSpecId(compiledTask) &&
		runTask.sourceGeneration === compiledTask.sourceGeneration &&
		sameForeachGeneratedIdentity(
			runTask.foreachGenerated,
			compiledTask.foreachGenerated,
		)
	);
}
function assertExactForeachGeneratedMembership(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
): ReadonlyMap<string, CompiledOnlyForeachBoundary> {
	const compiledBySpecId = new Map<string, CompiledTask>();
	const compiledChildrenByPlaceholder = new Map<string, CompiledTask[]>();
	for (const compiledTask of compiledFlow.tasks) {
		const specId = compiledTaskSpecId(compiledTask);
		if (compiledBySpecId.has(specId)) {
			throw new Error(
				`Cannot reconcile foreach generated membership: compiled spec id ${specId} is duplicated`,
			);
		}
		compiledBySpecId.set(specId, compiledTask);
		const membership = compiledTask.foreachGenerated;
		if (!membership) continue;
		if (
			compiledTask.id !== specId ||
			typeof membership.placeholderSpecId !== "string" ||
			membership.placeholderSpecId === "" ||
			specId === membership.placeholderSpecId
		) {
			throw new Error(
				`Cannot reconcile foreach generated membership: compiled child ${specId} has an invalid placeholder`,
			);
		}
		const children =
			compiledChildrenByPlaceholder.get(membership.placeholderSpecId) ?? [];
		children.push(compiledTask);
		compiledChildrenByPlaceholder.set(membership.placeholderSpecId, children);
	}

	const runBySpecId = new Map<string, WorkflowTaskRunRecord>();
	const runTaskIds = new Set<string>();
	for (const runTask of run.tasks) {
		if (
			typeof runTask.taskId !== "string" ||
			runTask.taskId === "" ||
			runTaskIds.has(runTask.taskId) ||
			runBySpecId.has(runTask.specId)
		) {
			throw new Error(
				`Cannot reconcile foreach generated membership: run task/spec identity is globally ambiguous`,
			);
		}
		runTaskIds.add(runTask.taskId);
		runBySpecId.set(runTask.specId, runTask);
		const membership = runTask.foreachGenerated;
		if (!membership) continue;
		if (
			typeof membership.placeholderSpecId !== "string" ||
			membership.placeholderSpecId === "" ||
			runTask.specId === membership.placeholderSpecId
		) {
			throw new Error(
				`Cannot reconcile foreach generated membership: run child ${runTask.specId} has an invalid placeholder`,
			);
		}
		const compiledTask = compiledBySpecId.get(runTask.specId);
		if (
			!compiledTask?.foreachGenerated ||
			!sameForeachGeneratedTaskTuple(runTask, compiledTask)
		) {
			throw new Error(
				`Cannot reconcile foreach generated membership: run child ${runTask.specId} does not exactly match compiled state`,
			);
		}
	}

	const boundaries = new Map<string, CompiledOnlyForeachBoundary>();
	for (const [placeholderSpecId, compiledChildren] of compiledChildrenByPlaceholder) {
		const missingChildren = compiledChildren.filter(
			(compiledChild) => !runBySpecId.has(compiledTaskSpecId(compiledChild)),
		);
		if (missingChildren.length === 0) continue;
		if (missingChildren.length !== compiledChildren.length) {
			throw new Error(
				`Cannot reconcile foreach generated membership: compiled group ${placeholderSpecId} has a partial run child set`,
			);
		}
		const runPlaceholder = runBySpecId.get(placeholderSpecId);
		if (
			compiledBySpecId.has(placeholderSpecId) ||
			!runPlaceholder ||
			runPlaceholder.kind !== "foreach" ||
			runPlaceholder.foreachGenerated !== undefined ||
			runPlaceholder.dispatchMap !== undefined ||
			run.tasks.some(
				(task) =>
					task.foreachGenerated?.placeholderSpecId === placeholderSpecId,
			)
		) {
			throw new Error(
				`Cannot reconcile foreach generated membership: compiled group ${placeholderSpecId} has no exact recovery boundary`,
			);
		}
		assertPristinePendingForeachPlaceholder(
			cwd,
			runPlaceholder,
			placeholderSpecId,
		);
		boundaries.set(placeholderSpecId, {
			placeholderSpecId,
			generatedSpecIds: new Set(
				compiledChildren.map((task) => compiledTaskSpecId(task)),
			),
		});
	}
	return boundaries;
}
function assertPristinePendingForeachPlaceholder(
	cwd: string,
	task: WorkflowTaskRunRecord,
	placeholderSpecId: string,
): void {
	const worktree = task.worktree;
	const hasWorktreeEvidence = Boolean(
		worktree &&
			(worktree.enabled ||
				worktree.path !== null ||
				worktree.branch !== null ||
				worktree.baseCwd !== null ||
				worktree.warning !== null ||
				worktree.snapshot !== undefined),
	);
	const hasTerminalArtifact = [
		task.files?.output,
		task.files?.stderr,
		task.files?.result,
	]
		.filter((path): path is string => typeof path === "string")
		.some((path) => existsSync(fromProjectPath(cwd, path)));
	const hasPriorSideEffectEvidence =
		task.launchToken !== undefined ||
		task.backendHandle !== undefined ||
		task.pid !== undefined ||
		task.startedAt !== undefined ||
		task.completedAt !== undefined ||
		task.elapsedMs !== undefined ||
		task.exitCode !== undefined ||
		task.usage !== undefined ||
		task.toolResultBudget !== undefined ||
		task.timing !== undefined ||
		task.promptMetadata !== undefined ||
		task.backendFiles !== undefined ||
		task.outputRetry !== undefined ||
		task.launchRetry !== undefined ||
		(task.resumeEvents?.length ?? 0) > 0 ||
		task.lastMessage !== undefined ||
		hasWorktreeEvidence ||
		hasTerminalArtifact;
	if (
		task.status !== "pending" ||
		task.statusDetail !== "pending" ||
		hasPriorSideEffectEvidence
	) {
		throw new Error(
			`Cannot reconcile foreach generated membership: compiled group ${placeholderSpecId} has no durable prepared journal and its placeholder is not pristine pending`,
		);
	}
}
function assertAuthoritativeForeachDispatchMaps(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
): void {
	for (const parent of run.tasks) {
		const dispatchMap = parent.dispatchMap;
		if (!dispatchMap) continue;
		const compiledParent = compiledFlow.tasks.find(
			(task) => compiledTaskSpecId(task) === parent.specId,
		);
		const compiledChildren = compiledFlow.tasks.filter(
			(task) =>
				task.foreachGenerated?.placeholderSpecId === parent.specId,
		);
		if (!compiledParent?.foreach && compiledChildren.length === 0) continue;
		if (!Array.isArray(dispatchMap.entries)) {
			throw new Error(
				`Cannot reconcile foreach dispatch map for ${parent.specId}: entries are invalid`,
			);
		}
		const entryKeys = new Set<string>();
		const entryTaskIds = new Set<string>();
		const entrySpecIds = new Set<string>();
		for (const entry of dispatchMap.entries) {
			if (
				!entry ||
				typeof entry.taskId !== "string" ||
				typeof entry.specId !== "string"
			) {
				throw new Error(
					`Cannot reconcile foreach dispatch map for ${parent.specId}: an entry is invalid`,
				);
			}
			const key = `${entry.taskId}\0${entry.specId}`;
			if (
				entryKeys.has(key) ||
				entryTaskIds.has(entry.taskId) ||
				entrySpecIds.has(entry.specId)
			) {
				throw new Error(
					`Cannot reconcile foreach dispatch map for ${parent.specId}: an entry is duplicated`,
				);
			}
			entryKeys.add(key);
			entryTaskIds.add(entry.taskId);
			entrySpecIds.add(entry.specId);
		}
		const runChildren = run.tasks.filter(
			(task) => task.foreachGenerated?.placeholderSpecId === parent.specId,
		);
		const compiledSpecIds = new Set(
			compiledChildren.map((task) => compiledTaskSpecId(task)),
		);
		if (
			runChildren.length !== entryKeys.size ||
			compiledChildren.length !== entrySpecIds.size ||
			compiledSpecIds.size !== compiledChildren.length ||
			runChildren.some(
				(task) => !entryKeys.has(`${task.taskId}\0${task.specId}`),
			) ||
			[...entrySpecIds].some((specId) => !compiledSpecIds.has(specId))
		) {
			throw new Error(
				`Cannot reconcile foreach dispatch map for ${parent.specId}: children do not exactly match the authoritative map`,
			);
		}
	}
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

function foreachGeneratedPlaceholderSpecId(
	task: CompiledTask | WorkflowTaskRunRecord,
): string | undefined {
	const explicit = task.foreachGenerated?.placeholderSpecId;
	return typeof explicit === "string" && explicit.trim() !== "" ? explicit : undefined;
}

function replaceForeachGeneratedDependencies(
	dependsOn: string[],
	placeholderToGeneratedSpecIds: Map<string, string[]>,
	keepPlaceholderSpecIds = new Set<string>(),
): string[] {
	const replaced: string[] = [];
	for (const dep of dependsOn) {
		const generatedSpecIds = placeholderToGeneratedSpecIds.get(dep);
		if (generatedSpecIds) {
			if (keepPlaceholderSpecIds.has(dep)) replaced.push(dep);
			replaced.push(...generatedSpecIds);
		} else replaced.push(dep);
	}
	return [...new Set(replaced)];
}

function sameStringList(left: string[], right: string[]): boolean {
	return (
		left.length === right.length &&
		left.every((value, index) => value === right[index])
	);
}
function sameForeachGeneratedIdentity(
	left: CompiledTask["foreachGenerated"] | WorkflowTaskRunRecord["foreachGenerated"],
	right: CompiledTask["foreachGenerated"] | WorkflowTaskRunRecord["foreachGenerated"],
): boolean {
	return (
		left?.placeholderSpecId === right?.placeholderSpecId &&
		left?.itemIdentity === right?.itemIdentity &&
		left?.itemHash === right?.itemHash &&
		left?.itemSourceTaskId === right?.itemSourceTaskId &&
		left?.itemSourceSpecId === right?.itemSourceSpecId &&
		left?.itemSourceKind === right?.itemSourceKind &&
		left?.itemRef === right?.itemRef &&
		left?.perItemDispatch === right?.perItemDispatch &&
		left?.sourceLineageDigest === right?.sourceLineageDigest &&
		left?.resolvedTaskId === right?.resolvedTaskId
	);
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

export function synchronizeTerminalBarrierSourceSpecIds(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
): boolean {
	const compiledTaskBySpecId = new Map(
		compiledFlow.tasks.map((task) => [compiledTaskSpecId(task), task]),
	);
	let changed = false;
	for (const runTask of run.tasks) {
		const compiledTask = compiledTaskBySpecId.get(runTask.specId);
		if (!compiledTask || !terminalBarrierEnabled(compiledTask, runTask)) continue;
		const sourceSpecIds = [...new Set(compiledTask.dependsOn ?? [])];
		if (
			runTask.terminalBarrier?.mode === "all-sources" &&
			Array.isArray(runTask.terminalBarrier.sourceSpecIds) &&
			sameStringList(runTask.terminalBarrier.sourceSpecIds, sourceSpecIds)
		) {
			continue;
		}
		runTask.terminalBarrier = {
			mode: "all-sources",
			sourceSpecIds,
		};
		changed = true;
	}
	return changed;
}

function terminalBarrierEnabled(
	compiledTask: CompiledTask,
	_runTask?: WorkflowTaskRunRecord,
): boolean {
	return (
		compiledTask.artifactGraph?.inputPolicy?.terminalBarrier === "all-sources"
	);
}

function terminalBarrierSourceSpecIds(
	compiledTask: CompiledTask,
): readonly string[] {
	return [...new Set(compiledTask.dependsOn ?? [])];
}

export function dependenciesReady(
	compiledTask: CompiledTask,
	bySpecId: Map<string, WorkflowTaskRunRecord>,
	compiledFlow: CompiledWorkflow,
	runTask?: WorkflowTaskRunRecord,
): boolean {
	const deps = compiledTask.dependsOn ?? [];
	if (terminalBarrierEnabled(compiledTask, runTask)) {
		return terminalBarrierSourceSpecIds(compiledTask).every((dep) => {
			const status = bySpecId.get(dep)?.status;
			return status !== undefined && isTerminalTaskStatus(status);
		});
	}
	if (deps.length === 0) return true;
	const partial =
		stageSourcePolicy(compiledFlow, compiledTask.stageId ?? "") === "partial";
	if (foreachStreamingEnabled(compiledTask)) {
		const sourceStageIds = new Set(
			sourceStageIdsForFrom(compiledTask.foreach?.from),
		);
		const tasksBySpecId = new Map(
			compiledFlow.tasks.map((task) => [task.id, task]),
		);
		let hasStreamingSourceDependency = false;
		let completedSourceDependencyReady = false;
		let runningSourceDependencyMayHavePartialItems = false;
		let allKnownSourceDependenciesTerminal = true;
		for (const dep of deps) {
			const status = bySpecId.get(dep)?.status;
			const depTask = tasksBySpecId.get(dep);
			const isStreamingSourceDependency = Boolean(
				depTask?.stageId && sourceStageIds.has(depTask.stageId),
			);
			if (!isStreamingSourceDependency) {
				if (status === "completed") continue;
				if (partial && status && isTerminalTaskStatus(status)) continue;
				return false;
			}
			hasStreamingSourceDependency = true;
			if (status === "completed") {
				completedSourceDependencyReady = true;
				continue;
			}
			if (status && isTerminalTaskStatus(status)) {
				if (!partial) return false;
				continue;
			}
			if (status === "running")
				runningSourceDependencyMayHavePartialItems = true;
			allKnownSourceDependenciesTerminal = false;
		}
		return (
			hasStreamingSourceDependency &&
			(completedSourceDependencyReady ||
				runningSourceDependencyMayHavePartialItems ||
				allKnownSourceDependenciesTerminal)
		);
	}
	return deps.every((dep) => {
		const status = bySpecId.get(dep)?.status;
		if (status === "completed") return true;
		if (partial && status && isTerminalTaskStatus(status)) return true;
		return false;
	});
}

export function foreachStreamingEnabled(compiledTask: CompiledTask): boolean {
	const streaming = (compiledTask.foreach?.from as any)?.streaming;
	return Boolean(
		streaming &&
			typeof streaming === "object" &&
			(streaming as { enabled?: unknown }).enabled === true,
	);
}

export function foreachStreamingMinChunk(compiledTask: CompiledTask): number {
	const value = (compiledTask.foreach?.from as any)?.streaming?.minChunk;
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: 1;
}

export interface ForeachSourceLineage {
	canonical: string;
	digest: string;
}

export function canonicalForeachSourceLineage(
	sourceSpecId: string,
	upstreamLineageDigest?: string,
): ForeachSourceLineage {
	const canonical = JSON.stringify({
		version: 1,
		sourceSpecId,
		...(upstreamLineageDigest ? { upstreamLineageDigest } : {}),
	});
	return {
		canonical,
		digest: createHash("sha256").update(canonical).digest("hex").slice(0, 24),
	};
}

export function resolveForeachSiblingSourceIds(
	legacyTaskIds: readonly string[],
	lineages: readonly ForeachSourceLineage[],
	stageId: string,
	reservedSpecIds: ReadonlySet<string> = new Set(),
): { taskIds?: string[]; error?: string } {
	if (legacyTaskIds.length !== lineages.length)
		return { error: "foreach generated task lineage metadata is incomplete" };
	const groups = new Map<string, number[]>();
	for (const [index, candidate] of legacyTaskIds.entries()) {
		const group = groups.get(candidate) ?? [];
		group.push(index);
		groups.set(candidate, group);
	}
	const resolved = [...legacyTaskIds];
	for (const [candidate, indexes] of groups) {
		const seenLineages = new Set<string>();
		for (const index of indexes) {
			const lineage = lineages[index]!;
			if (seenLineages.has(lineage.canonical))
				return { error: `duplicate foreach generated task id "${candidate}" within the same source lineage` };
			seenLineages.add(lineage.canonical);
		}
		if (indexes.length === 1) continue;
		for (const index of indexes) {
			const suffix = createHash("sha256")
				.update(lineages[index]!.canonical)
				.digest("hex")
				.slice(0, 12);
			resolved[index] = `${candidate}--${suffix}`;
		}
	}
	const finalSpecIds = new Set<string>();
	for (const taskId of resolved) {
		const specId = `${stageId}.${taskId}`;
		if (reservedSpecIds.has(specId) || finalSpecIds.has(specId))
			return { error: `foreach generated task id "${specId}" collides with an existing compiled task` };
		finalSpecIds.add(specId);
	}
	return { taskIds: resolved };
}

export function buildForeachGeneratedTasks(
	template: CompiledTask,
	runtimeTask: string | undefined,
	items: unknown[],
	options?: {
		lineages?: readonly ForeachSourceLineage[];
		reservedSpecIds?: ReadonlySet<string>;
	},
): { tasks: CompiledTask[]; error?: string } {
	const identities = items.map((item, index) => foreachItemIdentity(template, item, index));
	const invalid = identities.find((identity) => identity.error);
	if (invalid?.error) return { tasks: [], error: invalid.error };
	let taskIds = identities.map((identity) => identity.taskId);
	if (options?.lineages) {
		const resolution = resolveForeachSiblingSourceIds(
			taskIds,
			options.lineages,
			template.stageId!,
			options.reservedSpecIds,
		);
		if (resolution.error || !resolution.taskIds)
			return { tasks: [], error: resolution.error };
		taskIds = resolution.taskIds;
	} else if (new Set(taskIds).size !== taskIds.length) {
		const duplicate = taskIds.find((id, index) => taskIds.indexOf(id) !== index)!;
		return { tasks: [], error: `duplicate foreach generated task id "${duplicate}"` };
	}
	const tasks: CompiledTask[] = [];
	for (const [index, item] of items.entries()) {
		const itemIdentity = identities[index]!;
		const taskId = taskIds[index]!;
		const specId = `${template.stageId}.${taskId}`;
		if (specId === template.id) {
			return {
				tasks: [],
				error: `foreach generated task id "${specId}" collides with its placeholder`,
			};
		}
		const itemPayload = foreachItemPromptPayload(template, item, index);
		if (itemPayload.error) return { tasks: [], error: itemPayload.error };
		const itemText = formatForeachItem(itemPayload.value);
		const cacheStableForeach = workflowExperimentalFlagEnabled(
			EXPERIMENTAL_CACHE_STABLE_FOREACH_ENV,
		);
		const instructions = cacheStableForeach
			? template.foreach!.prompt.replace(
					/\$\{item\}/g,
					"the workflow item payload below",
				)
			: template.foreach!.prompt.replace(
					/\$\{item\}/g,
					escapeReplacementText(itemText),
				);
		const itemPayloadSection = cacheStableForeach
			? `# Workflow Item Payload\n\n${itemText}`
			: undefined;
		const stablePromptPrefix = [
			template.foreach!.injectRuntimeTask && runtimeTask
				? `# Task\n\n${runtimeTask}`
				: undefined,
			`# Workflow Stage\n\nstage=${template.stageId}\ntype=foreach`,
			template.foreach!.roleText || undefined,
		];
		const compiledPrompt = [
			...stablePromptPrefix,
			...(cacheStableForeach
				? [
						`# Instructions\n\n${instructions}`,
						`# Workflow Item\n\nitem=${taskId}`,
						itemPayloadSection,
					]
				: [
						`# Workflow Item\n\nitem=${taskId}`,
						`# Instructions\n\n${instructions}`,
					]),
		]
			.filter(Boolean)
			.join("\n\n");
		const compiledPromptError = compiledForeachPromptError(
			template,
			compiledPrompt,
			index,
		);
		if (compiledPromptError) {
			return { tasks: [], error: compiledPromptError };
		}
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
			foreachGenerated: {
				placeholderSpecId: template.id,
				...(itemIdentity.identity &&
				(template.foreach?.itemIdentityPath !== undefined ||
					foreachStreamingEnabled(template))
					? { itemIdentity: itemIdentity.identity }
					: {}),
				...(taskId !== itemIdentity.taskId
					? {
							sourceLineageDigest: options!.lineages![index]!.digest,
							resolvedTaskId: taskId,
						}
					: {}),
			},
		} as CompiledTask);
	}
	return { tasks };
}

function foreachItemIdentity(
	template: CompiledTask,
	item: unknown,
	index: number,
): { taskId: string; identity?: string; error?: string } {
	const identityPath = template.foreach?.itemIdentityPath;
	if (identityPath === undefined) {
		const legacyId =
			item &&
			typeof item === "object" &&
			typeof (item as { id?: unknown }).id === "string"
				? sanitizeTaskId((item as { id: string }).id)
				: "";
		return {
			taskId:
				legacyId || `item-${String(index + 1).padStart(3, "0")}`,
			...(legacyId ? { identity: legacyId } : {}),
		};
	}
	const identity = readForeachItemIdentity(item, identityPath);
	if (identity === undefined) {
		return {
			taskId: "",
			error: `foreach item ${index + 1} has invalid identity at ${identityPath}`,
		};
	}
	const taskId = sanitizeTaskId(identity);
	if (!taskId || taskId !== identity.toLowerCase()) {
		return {
			taskId: "",
			error: `foreach item ${index + 1} has invalid identity at ${identityPath}`,
		};
	}
	return { taskId, identity };
}

function foreachItemPromptPayload(
	template: CompiledTask,
	item: unknown,
	index: number,
): { value: unknown; error?: string } {
	const payloadPath = template.foreach?.itemPayloadPath;
	if (payloadPath === undefined) return { value: item };
	const payload = readForeachItemProperty(item, payloadPath);
	if (payload.error === "unsafe_path") {
		return {
			value: undefined,
			error: `foreach item ${index + 1} has unsafe payload path "${payloadPath}"`,
		};
	}
	if (payload.error === "non_object") {
		return {
			value: undefined,
			error: `foreach item ${index + 1} has non-object payload at ${payloadPath}`,
		};
	}
	if (payload.error === "missing") {
		return {
			value: undefined,
			error: `foreach item ${index + 1} has missing payload at ${payloadPath}`,
		};
	}
	if (!isPlainJsonObject(payload.value)) {
		return {
			value: undefined,
			error: `foreach item ${index + 1} has non-object payload at ${payloadPath}`,
		};
	}
	return { value: payload.value };
}

function compiledForeachPromptError(
	template: CompiledTask,
	compiledPrompt: string,
	index: number,
): string | undefined {
	const maxChars = template.artifactGraph?.inputPolicy?.maxCompiledPromptChars;
	if (maxChars === undefined) return undefined;
	if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
		return `foreach item ${index + 1} has invalid maxCompiledPromptChars`;
	}
	const actualChars = Array.from(compiledPrompt).length;
	return actualChars > maxChars
		? `foreach item ${index + 1} compiled prompt exceeds maxCompiledPromptChars=${maxChars} (actual ${actualChars})`
		: undefined;
}
function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

type ForeachItemProperty =
	| { value: unknown; error?: undefined }
	| { value?: undefined; error: "unsafe_path" | "non_object" | "missing" };

function readForeachItemProperty(
	item: unknown,
	path: string,
): ForeachItemProperty {
	const match = /^\$\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(path);
	const property = match?.[1];
	if (
		!property ||
		property === "__proto__" ||
		property === "constructor" ||
		property === "prototype"
	) {
		return { error: "unsafe_path" };
	}
	if (!item || typeof item !== "object" || Array.isArray(item)) {
		return { error: "non_object" };
	}
	const descriptor = Object.getOwnPropertyDescriptor(item, property);
	if (!descriptor || !("value" in descriptor) || descriptor.value === undefined) {
		return { error: "missing" };
	}
	return { value: descriptor.value };
}

function readForeachItemIdentity(
	item: unknown,
	path: string,
): string | undefined {
	const property = readForeachItemProperty(item, path);
	return typeof property.value === "string" && property.value.trim() !== ""
		? property.value
		: undefined;
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
		if (task.dependsOn) {
			task.dependsOn = replaceDependencyList(
				task.dependsOn,
				placeholderSpecId,
				generatedSpecIds,
			);
		}
		if (task.contextDependsOn) {
			task.contextDependsOn = replaceDependencyList(
				task.contextDependsOn,
				placeholderSpecId,
				generatedSpecIds,
			);
		}
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
export type ForeachGeneratedGroupSnapshot = {
	placeholderSpecId: string;
	compiledChildren: CompiledTask[];
	runChildren: WorkflowTaskRunRecord[];
};

function sameForeachGeneratedGroupSide<T>(
	current: readonly T[],
	expected: readonly T[],
	key: (task: T) => string,
): boolean {
	const orderedCurrent = [...current].sort((left, right) =>
		key(left).localeCompare(key(right)),
	);
	const orderedExpected = [...expected].sort((left, right) =>
		key(left).localeCompare(key(right)),
	);
	return (
		orderedCurrent.length === orderedExpected.length &&
		orderedCurrent.every(
			(task, index) =>
				JSON.stringify(task) === JSON.stringify(orderedExpected[index]),
		)
	);
}

function removeForeachGeneratedTasksFromSnapshots(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	snapshots: readonly ForeachGeneratedGroupSnapshot[],
): boolean {
	const generatedByPlaceholder = new Map<string, string[]>();
	for (const snapshot of snapshots) {
		const currentCompiled = compiledFlow.tasks.filter(
			(task) =>
				task.foreachGenerated?.placeholderSpecId === snapshot.placeholderSpecId,
		);
		const currentRun = run.tasks.filter(
			(task) =>
				task.foreachGenerated?.placeholderSpecId === snapshot.placeholderSpecId,
		);
		const compiledMatches = sameForeachGeneratedGroupSide(
			currentCompiled,
			snapshot.compiledChildren,
			(task) => compiledTaskSpecId(task),
		);
		const runMatches = sameForeachGeneratedGroupSide(
			currentRun,
			snapshot.runChildren,
			(task) => task.specId,
		);
		if (
			(!compiledMatches && currentCompiled.length !== 0) ||
			(!runMatches && currentRun.length !== 0) ||
			(!compiledMatches && !runMatches)
		) {
			throw new Error(
				`Cannot remove foreach generated tasks: group ${snapshot.placeholderSpecId} is partial or cross-bound`,
			);
		}
		generatedByPlaceholder.set(
			snapshot.placeholderSpecId,
			snapshot.compiledChildren.map((task) => compiledTaskSpecId(task)),
		);
	}
	if (generatedByPlaceholder.size === 0) return false;
	const generatedSpecIds = new Set(
		[...generatedByPlaceholder.values()].flat(),
	);
	compiledFlow.tasks = compiledFlow.tasks.filter(
		(task) => !generatedSpecIds.has(compiledTaskSpecId(task)),
	);
	run.tasks = run.tasks.filter((task) => !generatedSpecIds.has(task.specId));
	for (const task of compiledFlow.tasks) {
		task.dependsOn = restoreForeachPlaceholderDependencies(
			task.dependsOn,
			generatedByPlaceholder,
		);
		task.contextDependsOn = restoreForeachPlaceholderDependencies(
			task.contextDependsOn,
			generatedByPlaceholder,
		);
	}
	for (const task of run.tasks) {
		task.dependsOn = restoreForeachPlaceholderDependencies(
			task.dependsOn,
			generatedByPlaceholder,
		);
	}
	synchronizeTerminalBarrierSourceSpecIds(run, compiledFlow);
	return true;
}

export function removeForeachGeneratedTasksForPlaceholders(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	placeholderSpecIds: ReadonlySet<string>,
	snapshots?: readonly ForeachGeneratedGroupSnapshot[],
): boolean {
	if (snapshots) {
		return removeForeachGeneratedTasksFromSnapshots(run, compiledFlow, snapshots);
	}
	const generatedByPlaceholder = new Map<string, string[]>();
	const compiledGeneratedBySpecId = new Map<string, CompiledTask>();
	for (const task of compiledFlow.tasks) {
		const specId = compiledTaskSpecId(task);
		const membership = task.foreachGenerated;
		if (!membership || !placeholderSpecIds.has(membership.placeholderSpecId))
			continue;
		if (
			typeof membership.placeholderSpecId !== "string" ||
			membership.placeholderSpecId === "" ||
			specId === membership.placeholderSpecId ||
			compiledGeneratedBySpecId.has(specId)
		) {
			throw new Error(
				`Cannot remove foreach generated tasks: compiled child ${specId} has ambiguous membership`,
			);
		}
		compiledGeneratedBySpecId.set(specId, task);
		const generated =
			generatedByPlaceholder.get(membership.placeholderSpecId) ?? [];
		generated.push(specId);
		generatedByPlaceholder.set(membership.placeholderSpecId, generated);
	}

	const seenRunGeneratedSpecIds = new Set<string>();
	for (const task of run.tasks) {
		const expected = compiledGeneratedBySpecId.get(task.specId);
		const membership = task.foreachGenerated;
		if (!expected) {
			if (membership && placeholderSpecIds.has(membership.placeholderSpecId)) {
				throw new Error(
					`Cannot remove foreach generated tasks: run child ${task.specId} is absent from its compiled placeholder set`,
				);
			}
			continue;
		}
		if (
			!membership ||
			task.specId !== compiledTaskSpecId(expected) ||
			task.sourceGeneration !== expected.sourceGeneration ||
			task.specId === membership.placeholderSpecId ||
			seenRunGeneratedSpecIds.has(task.specId) ||
			!sameForeachGeneratedIdentity(
				membership,
				expected.foreachGenerated,
			)
		) {
			throw new Error(
				`Cannot remove foreach generated tasks: run child ${task.specId} does not exactly match its compiled placeholder`,
			);
		}
		seenRunGeneratedSpecIds.add(task.specId);
	}
	for (const specId of compiledGeneratedBySpecId.keys()) {
		if (seenRunGeneratedSpecIds.has(specId)) continue;
		throw new Error(
			`Cannot remove foreach generated tasks: compiled child ${specId} has no exact run record`,
		);
	}
	if (generatedByPlaceholder.size === 0) return false;

	const generatedSpecIds = new Set(
		[...generatedByPlaceholder.values()].flat(),
	);
	compiledFlow.tasks = compiledFlow.tasks.filter(
		(task) => !generatedSpecIds.has(compiledTaskSpecId(task)),
	);
	run.tasks = run.tasks.filter((task) => !generatedSpecIds.has(task.specId));

	for (const task of compiledFlow.tasks) {
		task.dependsOn = restoreForeachPlaceholderDependencies(
			task.dependsOn,
			generatedByPlaceholder,
		);
		task.contextDependsOn = restoreForeachPlaceholderDependencies(
			task.contextDependsOn,
			generatedByPlaceholder,
		);
	}
	for (const task of run.tasks) {
		task.dependsOn = restoreForeachPlaceholderDependencies(
			task.dependsOn,
			generatedByPlaceholder,
		);
	}
	synchronizeTerminalBarrierSourceSpecIds(run, compiledFlow);
	return true;
}

function restoreForeachPlaceholderDependencies(
	dependsOn: string[] | undefined,
	generatedByPlaceholder: ReadonlyMap<string, readonly string[]>,
): string[] | undefined {
	if (!dependsOn) return undefined;
	const placeholderByGenerated = new Map<string, string>();
	for (const [placeholderSpecId, generatedSpecIds] of generatedByPlaceholder) {
		for (const generatedSpecId of generatedSpecIds) {
			placeholderByGenerated.set(generatedSpecId, placeholderSpecId);
		}
	}
	return [
		...new Set(
			dependsOn.map(
				(dependsOnSpecId) =>
					placeholderByGenerated.get(dependsOnSpecId) ?? dependsOnSpecId,
			),
		),
	];
}

export interface FailFastCancellationSummary {
	cancelledTaskIds: string[];
	interruptedTaskIds: string[];
}

export function failFastPolicyEnabled(compiledFlow: CompiledWorkflow): boolean {
	const policy = compiledFlow.failurePolicy;
	return (
		policy?.failFast === true &&
		(policy.cancelSiblingsOnFailure === true ||
			policy.cancelDescendantsOnParentFailure === true)
	);
}

export function markFailFastCancellations(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
): FailFastCancellationSummary {
	if (!failFastPolicyEnabled(compiledFlow)) {
		return { cancelledTaskIds: [], interruptedTaskIds: [] };
	}
	const failedSpecIds = new Set(
		run.tasks
			.filter((task) => task.status === "failed")
			.map((task) => task.specId),
	);
	if (failedSpecIds.size === 0) {
		return { cancelledTaskIds: [], interruptedTaskIds: [] };
	}

	const descendantSpecIds = descendantSpecIdsFor(compiledFlow, failedSpecIds);
	const cancelledTaskIds: string[] = [];
	const interruptedTaskIds: string[] = [];
	for (const [index, task] of run.tasks.entries()) {
		if (task.status !== "pending" && task.status !== "running") continue;
		if (
			task.status === "running" &&
			task.statusDetail === "cancellation_failed"
		)
			continue;
		const compiledTask = compiledFlow.tasks[index];
		if (!compiledTask) continue;
		const isDescendant = descendantSpecIds.has(task.specId);
		const eligible = isDescendant
			? compiledFlow.failurePolicy?.cancelDescendantsOnParentFailure === true
			: compiledFlow.failurePolicy?.cancelSiblingsOnFailure === true;
		if (!eligible) continue;
		if (terminalBarrierEnabled(compiledTask, task)) continue;
		const wasRunning = task.status === "running";
		if (wasRunning) {
			task.statusDetail = "cancellation_pending";
			task.lastMessage =
				"awaiting backend fail-fast cancellation acknowledgement";
			cancelledTaskIds.push(task.taskId);
			interruptedTaskIds.push(task.taskId);
			continue;
		}
		if (
			setTaskTerminal(task, "interrupted", FAIL_FAST_CANCELLED_STATUS_DETAIL, {
				exitCode: 130,
				lastMessage: "cancelled by workflow fail-fast policy",
			})
		) {
			cancelledTaskIds.push(task.taskId);
		}
	}
	return { cancelledTaskIds, interruptedTaskIds };
}

function descendantSpecIdsFor(
	compiledFlow: CompiledWorkflow,
	rootSpecIds: ReadonlySet<string>,
): Set<string> {
	const childrenByDependency = new Map<string, string[]>();
	for (const task of compiledFlow.tasks) {
		for (const dependency of task.dependsOn ?? []) {
			const children = childrenByDependency.get(dependency) ?? [];
			children.push(task.id);
			childrenByDependency.set(dependency, children);
		}
	}
	const descendants = new Set<string>();
	const queue = [...rootSpecIds];
	while (queue.length > 0) {
		const specId = queue.shift()!;
		for (const childSpecId of childrenByDependency.get(specId) ?? []) {
			if (rootSpecIds.has(childSpecId) || descendants.has(childSpecId))
				continue;
			descendants.add(childSpecId);
			queue.push(childSpecId);
		}
	}
	return descendants;
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
					status === "skipped" ||
					status === "blocked"
				);
			});
			if (!failedDep) continue;
			if (terminalBarrierEnabled(compiledTask, task)) continue;
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
