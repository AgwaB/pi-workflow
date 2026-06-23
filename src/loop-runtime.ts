import { readFile } from "node:fs/promises";

import { readArtifactGraphControl } from "./artifact-graph-runtime.js";
import {
	assertLoopTaskPositionalAlignment,
	compiledTaskSpecId,
	loopStageIdSet,
	nextTaskRecordIndex,
	reconcileLoopTaskRecordsInMemory,
	upsertCompiledLoopTasksAtInsertion,
} from "./engine-run-graph.js";
import {
	compiledWorkflowPath,
	createTaskRunRecord,
	fromProjectPath,
	isTerminalTaskStatus,
	setTaskTerminal,
	writeJsonAtomic,
	writeRunRecord,
} from "./store.js";
import type {
	CompiledTask,
	CompiledWorkflow,
	LoopResultStatus,
	LoopStateRecord,
	LoopUntilCondition,
	WorkflowRunRecord,
	WorkflowTaskRunRecord,
} from "./types.js";
import { readSimpleJsonPath } from "./workflow-runtime.js";

const LOOP_CARRY_FORWARD_MAX_CHARS = 4000;
const LOOP_SUMMARY_MAX_CHARS = 1200;

export async function scheduleLoop(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	placeholderIndex: number,
	placeholder: CompiledTask,
): Promise<boolean> {
	const loopId = placeholder.loopPlaceholder?.loopId ?? placeholder.stageId;
	if (!loopId) return false;
	const loopStage = findLoopStageRecord(compiledFlow, loopId);
	const placeholderRunTask = run.tasks[placeholderIndex];
	if (!loopStage || !placeholderRunTask) return false;

	const state = getLoopState(run, loopId);
	if (state?.awaitingOnExhausted) {
		const exhaustedTask = findLoopExhaustedRunTask(run, compiledFlow, loopId);
		if (exhaustedTask && !isTerminalTaskStatus(exhaustedTask.status))
			return false;
		await finalizeLoop(
			cwd,
			run,
			compiledFlow,
			placeholderRunTask,
			loopStage,
			state.status ?? "exhausted",
			state.round || latestLoopRound(compiledFlow, loopId),
		);
		return true;
	}

	const currentRound = latestLoopRound(compiledFlow, loopId);
	if (currentRound === 0) {
		await materializeLoopRound(
			cwd,
			run,
			compiledFlow,
			placeholderIndex,
			placeholder,
			loopStage,
			1,
		);
		return true;
	}

	const roundTasks = getLoopRoundRunTasks(
		run,
		compiledFlow,
		loopId,
		currentRound,
	);
	if (roundTasks.length === 0) return false;
	if (roundTasks.some((task) => !isTerminalTaskStatus(task.status)))
		return false;

	if (
		await evaluateLoopUntilCondition(
			cwd,
			run,
			compiledFlow,
			loopId,
			currentRound,
			loopStage.until,
		)
	) {
		await finalizeLoop(
			cwd,
			run,
			compiledFlow,
			placeholderRunTask,
			loopStage,
			"completed",
			currentRound,
		);
		return true;
	}

	if (currentRound >= loopStage.maxRounds) {
		await stopLoopOrRunOnExhausted(
			cwd,
			run,
			compiledFlow,
			placeholderRunTask,
			loopStage,
			"exhausted",
			currentRound,
		);
		return true;
	}

	if (
		await loopHasNoProgress(
			cwd,
			run,
			compiledFlow,
			loopStage,
			loopId,
			currentRound,
		)
	) {
		await stopLoopOrRunOnExhausted(
			cwd,
			run,
			compiledFlow,
			placeholderRunTask,
			loopStage,
			"stopped_no_progress",
			currentRound,
		);
		return true;
	}

	await materializeLoopRound(
		cwd,
		run,
		compiledFlow,
		placeholderIndex,
		placeholder,
		loopStage,
		currentRound + 1,
	);
	return true;
}

async function stopLoopOrRunOnExhausted(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	placeholderRunTask: WorkflowTaskRunRecord,
	loopStage: any,
	status: LoopResultStatus,
	round: number,
): Promise<void> {
	if (loopStage.onExhausted) {
		const exhaustedTask = findLoopExhaustedRunTask(
			run,
			compiledFlow,
			loopStage.id,
		);
		if (!exhaustedTask) {
			await materializeLoopOnExhausted(
				cwd,
				run,
				compiledFlow,
				loopStage,
				status,
				round,
			);
			return;
		}
		const state = ensureLoopState(run, loopStage.id);
		state.status = status;
		state.round = round;
		state.awaitingOnExhausted = true;
		state.onExhaustedSpecId = exhaustedTask.specId;
		state.updatedAt = new Date().toISOString();
		if (!isTerminalTaskStatus(exhaustedTask.status)) {
			await writeRunRecord(cwd, run);
			return;
		}
	}

	await finalizeLoop(
		cwd,
		run,
		compiledFlow,
		placeholderRunTask,
		loopStage,
		status,
		round,
	);
}

async function materializeLoopRound(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	placeholderIndex: number,
	placeholder: CompiledTask,
	loopStage: any,
	round: number,
): Promise<void> {
	const childTemplates = (loopStage.childTemplates ?? []) as CompiledTask[];
	const roundTag = `r${String(round).padStart(2, "0")}`;
	const countsByChildStage = new Map<string, number>();
	for (const template of childTemplates) {
		const childStageId =
			template.stageId ?? template.id.split(".")[0] ?? "child";
		countsByChildStage.set(
			childStageId,
			(countsByChildStage.get(childStageId) ?? 0) + 1,
		);
	}

	const localToRoundSpecId = new Map<string, string>();
	for (const template of childTemplates) {
		const childStageId =
			template.stageId ?? template.id.split(".")[0] ?? "child";
		const childTaskId = template.taskId ?? "main";
		const singleTaskChild = (countsByChildStage.get(childStageId) ?? 0) === 1;
		const specId =
			singleTaskChild && childTaskId === "main"
				? `${loopStage.id}.${roundTag}.${childStageId}`
				: `${loopStage.id}.${roundTag}.${childStageId}.${childTaskId}`;
		localToRoundSpecId.set(template.id, specId);
	}

	const entryDependsOn =
		round === 1
			? [...(placeholder.dependsOn ?? [])]
			: getLoopRoundRunTasks(run, compiledFlow, loopStage.id, round - 1).map(
					(task) => task.specId,
				);
	const firstChildStageId = loopStage.childStageIds?.[0];
	const carryForward =
		round > 1
			? await buildLoopCarryForwardContext(
					cwd,
					run,
					compiledFlow,
					loopStage,
					loopStage.id,
					round,
				)
			: "";
	const generatedTasks = childTemplates.map((template) => {
		const childStageId =
			template.stageId ?? template.id.split(".")[0] ?? "child";
		const childTaskId = template.taskId ?? "main";
		const roundStageId = `${loopStage.id}.${roundTag}.${childStageId}`;
		const rawDependsOn = template.dependsOn ?? [];
		const dependsOn =
			rawDependsOn.length > 0
				? rawDependsOn.map((dep) => localToRoundSpecId.get(dep) ?? dep)
				: [...entryDependsOn];
		const sourcePolicy =
			childStageId === firstChildStageId && round > 1
				? "partial"
				: loopChildSourcePolicy(loopStage, childStageId);
		ensureGeneratedStageRecord(
			compiledFlow,
			roundStageId,
			template.kind,
			sourcePolicy,
		);
		const loopRoundPrompt = [
			template.compiledPrompt,
			"# Loop Round",
			`loop=${loopStage.id}`,
			`round=${round}`,
			`childStage=${childStageId}`,
			carryForward && childStageId === firstChildStageId
				? `# Loop Carry-Forward Context\n\n${carryForward}`
				: undefined,
		]
			.filter(Boolean)
			.join("\n\n");
		const specId = localToRoundSpecId.get(template.id)!;
		return {
			...template,
			id: specId,
			key: specId,
			specId,
			taskId: childTaskId,
			stageId: roundStageId,
			dependsOn,
			foreach: undefined,
			compiledPrompt: loopRoundPrompt,
			loopChild: {
				loopId: loopStage.id,
				round,
				roundTag,
				childStageId,
				childTaskId,
				firstChildStage: childStageId === firstChildStageId,
			},
		} as CompiledTask;
	});

	upsertCompiledLoopTasksAtInsertion(
		compiledFlow,
		loopStage.id,
		placeholderIndex,
		generatedTasks,
	);
	reconcileLoopTaskRecordsInMemory(
		cwd,
		run,
		compiledFlow,
		new Set([loopStage.id]),
	);
	assertLoopTaskPositionalAlignment(run, compiledFlow, new Set([loopStage.id]));

	const state = ensureLoopState(run, loopStage.id);
	state.round = round;
	state.awaitingOnExhausted = false;
	state.status = undefined;
	state.onExhaustedSpecId = undefined;
	state.updatedAt = new Date().toISOString();
	run.round = round;

	await writeJsonAtomic(compiledWorkflowPath(cwd, run.runId), compiledFlow);
	await writeRunRecord(cwd, run);
}

async function materializeLoopOnExhausted(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	loopStage: any,
	status: LoopResultStatus,
	round: number,
): Promise<void> {
	const template = loopStage.onExhausted?.template as CompiledTask | undefined;
	if (!template) return;
	const stageId = `${loopStage.id}.onExhausted`;
	const specId = `${stageId}.${loopStage.onExhausted.stageId ?? "summary"}`;
	const dependsOn = getLoopRunTasksThroughRound(
		run,
		compiledFlow,
		loopStage.id,
		round,
	).map((task) => task.specId);
	const context = await buildLoopTerminalContext(
		cwd,
		run,
		compiledFlow,
		loopStage,
		status,
		round,
	);
	const task: CompiledTask = {
		...template,
		id: specId,
		key: specId,
		specId,
		taskId: loopStage.onExhausted.stageId ?? "summary",
		stageId,
		dependsOn,
		compiledPrompt: [
			template.compiledPrompt,
			"# Loop Exhaustion Context",
			context,
		].join("\n\n"),
		loopExhausted: { loopId: loopStage.id, status },
	} as CompiledTask;

	ensureGeneratedStageRecord(compiledFlow, stageId, "reduce", "partial");
	const placeholderIndex = compiledFlow.tasks.findIndex(
		(candidate) => candidate.loopPlaceholder?.loopId === loopStage.id,
	);
	upsertCompiledLoopTasksAtInsertion(
		compiledFlow,
		loopStage.id,
		placeholderIndex,
		[task],
	);
	reconcileLoopTaskRecordsInMemory(
		cwd,
		run,
		compiledFlow,
		new Set([loopStage.id]),
	);
	assertLoopTaskPositionalAlignment(run, compiledFlow, new Set([loopStage.id]));

	const state = ensureLoopState(run, loopStage.id);
	state.round = round;
	state.status = status;
	state.awaitingOnExhausted = true;
	state.onExhaustedSpecId = specId;
	state.updatedAt = new Date().toISOString();

	await writeJsonAtomic(compiledWorkflowPath(cwd, run.runId), compiledFlow);
	await writeRunRecord(cwd, run);
}

async function finalizeLoop(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	placeholderRunTask: WorkflowTaskRunRecord,
	loopStage: any,
	status: LoopResultStatus,
	round: number,
): Promise<void> {
	const finalCheck = await readLoopStageStructuredOutput(
		cwd,
		run,
		compiledFlow,
		loopStage.id,
		round,
		loopDesignatedCheckStageId(loopStage),
	);
	const worktreePath = findLoopWorktreePath(run, loopStage.id);
	const summary = buildLoopResultSummary(
		status,
		round,
		worktreePath,
		finalCheck,
	);
	upsertLoopResult(run, {
		loopId: loopStage.id,
		status,
		roundsUsed: round,
		worktreePath,
		finalCheck,
		summary,
	});
	const state = ensureLoopState(run, loopStage.id);
	state.round = round;
	state.status = status;
	state.awaitingOnExhausted = false;
	state.updatedAt = new Date().toISOString();
	setTaskTerminal(placeholderRunTask, "completed", `loop_${status}`, {
		lastMessage: summary,
	});
	await writeRunRecord(cwd, run);
}

export async function evaluateLoopUntilCondition(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	loopId: string,
	round: number,
	condition: LoopUntilCondition,
): Promise<boolean> {
	const candidate = condition as any;
	if (Array.isArray(candidate.all)) {
		for (const item of candidate.all) {
			if (
				!(await evaluateLoopUntilCondition(
					cwd,
					run,
					compiledFlow,
					loopId,
					round,
					item,
				))
			)
				return false;
		}
		return true;
	}
	if (Array.isArray(candidate.any)) {
		for (const item of candidate.any) {
			if (
				await evaluateLoopUntilCondition(
					cwd,
					run,
					compiledFlow,
					loopId,
					round,
					item,
				)
			)
				return true;
		}
		return false;
	}

	const stageId =
		typeof candidate.stage === "string"
			? candidate.stage
			: typeof candidate.source === "string"
				? candidate.source
				: undefined;
	if (stageId === undefined || typeof candidate.path !== "string") return false;
	const output = await readLoopStageStructuredOutput(
		cwd,
		run,
		compiledFlow,
		loopId,
		round,
		stageId,
	);
	const value =
		output === undefined
			? undefined
			: readSimpleJsonPath(output, candidate.path);
	if (Object.hasOwn(candidate, "exists")) {
		return candidate.exists === (value !== undefined);
	}
	if (value === undefined) return false;
	if (Object.hasOwn(candidate, "equals"))
		return Object.is(value, candidate.equals);
	if (Object.hasOwn(candidate, "notEquals"))
		return !Object.is(value, candidate.notEquals);
	if (Object.hasOwn(candidate, "lengthEquals"))
		return valueLength(value) === candidate.lengthEquals;
	return false;
}

async function loopHasNoProgress(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	loopStage: any,
	loopId: string,
	round: number,
): Promise<boolean> {
	if (round <= 1) return false;
	const current = await readLoopProgressMetric(
		cwd,
		run,
		compiledFlow,
		loopStage,
		loopId,
		round,
	);
	const previous = await readLoopProgressMetric(
		cwd,
		run,
		compiledFlow,
		loopStage,
		loopId,
		round - 1,
	);
	return current !== undefined && previous !== undefined && current >= previous;
}

async function readLoopProgressMetric(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	loopStage: any,
	loopId: string,
	round: number,
): Promise<number | undefined> {
	const checkStageId = loopDesignatedCheckStageId(loopStage);
	const output = await readLoopStageStructuredOutput(
		cwd,
		run,
		compiledFlow,
		loopId,
		round,
		checkStageId,
	);
	if (output === undefined) return undefined;
	const progressPath = loopStage.progressPath ?? "$.blockingFailures";
	const value = readSimpleJsonPath(output, progressPath);
	const length = valueLength(value);
	if (length !== undefined) return length;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (value !== undefined || loopStage.progressPath !== undefined) {
		warnInvalidLoopProgressMetric(
			run,
			compiledFlow,
			loopId,
			round,
			checkStageId,
			progressPath,
			value,
		);
	}
	return undefined;
}

function warnInvalidLoopProgressMetric(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	loopId: string,
	round: number,
	childStageId: string,
	progressPath: string,
	value: unknown,
): void {
	const entry = getLatestLoopStageTaskEntry(
		run,
		compiledFlow,
		loopId,
		round,
		childStageId,
	);
	if (!entry || entry.runTask.status !== "completed") return;
	entry.runTask.lastMessage = `loop progressPath ${progressPath} resolved to unsupported ${describeLoopProgressValue(value)}; no-progress comparison skipped`;
}

function getLatestLoopStageTaskEntry(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	loopId: string,
	round: number,
	childStageId: string,
): { compiledTask: CompiledTask; runTask: WorkflowTaskRunRecord } | undefined {
	return getLoopRoundTaskEntries(run, compiledFlow, loopId, round)
		.filter(
			(item) => item.compiledTask.loopChild?.childStageId === childStageId,
		)
		.at(-1);
}

function describeLoopProgressValue(value: unknown): string {
	if (value === undefined) return "undefined";
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (typeof value === "number" && !Number.isFinite(value))
		return "non-finite number";
	return typeof value;
}

async function readLoopStageStructuredOutput(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	loopId: string,
	round: number,
	childStageId: string,
): Promise<unknown> {
	const entry = getLatestLoopStageTaskEntry(
		run,
		compiledFlow,
		loopId,
		round,
		childStageId,
	);
	if (!entry || entry.runTask.status !== "completed") return undefined;
	try {
		if (entry.compiledTask.artifactGraph?.enabled) {
			return await readArtifactGraphControl(cwd, entry.runTask);
		}
		const result = JSON.parse(
			await readFile(fromProjectPath(cwd, entry.runTask.files.result), "utf8"),
		);
		return result?.structuredOutput;
	} catch (error) {
		entry.runTask.lastMessage = `completed loop task result unreadable: ${error instanceof Error ? error.message : String(error)}`;
		return undefined;
	}
}

async function buildLoopCarryForwardContext(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	loopStage: any,
	loopId: string,
	nextRound: number,
): Promise<string> {
	const previousRound = nextRound - 1;
	const checkStageId = loopDesignatedCheckStageId(loopStage);
	const latestCheck = await readLoopStageStructuredOutput(
		cwd,
		run,
		compiledFlow,
		loopId,
		previousRound,
		checkStageId,
	);
	const metric = await readLoopProgressMetric(
		cwd,
		run,
		compiledFlow,
		loopStage,
		loopId,
		previousRound,
	);
	const summary = [
		`Previous round: ${previousRound}`,
		`Designated check stage: ${checkStageId}`,
		metric !== undefined
			? `Progress metric (${loopStage.progressPath ?? "$.blockingFailures"} length/value): ${metric}`
			: undefined,
		"Latest check structured output:",
		compactJson(latestCheck, Math.floor(LOOP_CARRY_FORWARD_MAX_CHARS * 0.7)),
		"Rolling summary:",
		await buildLoopRollingSummary(
			cwd,
			run,
			compiledFlow,
			loopStage,
			loopId,
			previousRound,
		),
	]
		.filter(Boolean)
		.join("\n");
	return truncate(summary, LOOP_CARRY_FORWARD_MAX_CHARS);
}

async function buildLoopRollingSummary(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	loopStage: any,
	loopId: string,
	latestRound: number,
): Promise<string> {
	const start = Math.max(1, latestRound - 2);
	const lines: string[] = [];
	for (let round = start; round <= latestRound; round += 1) {
		const metric = await readLoopProgressMetric(
			cwd,
			run,
			compiledFlow,
			loopStage,
			loopId,
			round,
		);
		lines.push(
			`round ${round}: ${metric === undefined ? "progress metric unavailable" : `progress=${metric}`}`,
		);
	}
	return lines.join("\n");
}

async function buildLoopTerminalContext(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	loopStage: any,
	status: LoopResultStatus,
	round: number,
): Promise<string> {
	const checkStageId = loopDesignatedCheckStageId(loopStage);
	const finalCheck = await readLoopStageStructuredOutput(
		cwd,
		run,
		compiledFlow,
		loopStage.id,
		round,
		checkStageId,
	);
	const roundChecks = await buildLoopRoundCheckContext(
		cwd,
		run,
		compiledFlow,
		loopStage,
		loopStage.id,
		round,
		checkStageId,
	);
	return truncate(
		[
			`loop=${loopStage.id}`,
			`status=${status}`,
			`roundsUsed=${round}`,
			`worktreePath=${findLoopWorktreePath(run, loopStage.id) ?? "(none)"}`,
			"Round check outputs (bounded, most recent retained):",
			roundChecks,
			"Final check structured output:",
			compactJson(finalCheck, LOOP_SUMMARY_MAX_CHARS),
		].join("\n"),
		LOOP_CARRY_FORWARD_MAX_CHARS,
	);
}

async function buildLoopRoundCheckContext(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	loopStage: any,
	loopId: string,
	latestRound: number,
	checkStageId: string,
): Promise<string> {
	const sections: string[] = [];
	for (let round = latestRound; round >= 1; round -= 1) {
		const output = await readLoopStageStructuredOutput(
			cwd,
			run,
			compiledFlow,
			loopId,
			round,
			checkStageId,
		);
		const metric = await readLoopProgressMetric(
			cwd,
			run,
			compiledFlow,
			loopStage,
			loopId,
			round,
		);
		const section = [
			`Round ${round}`,
			metric !== undefined
				? `progress=${metric}`
				: "progress metric unavailable",
			compactJson(output, 900),
		].join("\n");
		const candidate = [section, ...sections].join("\n\n");
		if (candidate.length > LOOP_CARRY_FORWARD_MAX_CHARS && sections.length > 0)
			break;
		sections.unshift(section);
	}
	return truncate(
		sections.join("\n\n") || "(unavailable)",
		LOOP_CARRY_FORWARD_MAX_CHARS,
	);
}

function buildLoopResultSummary(
	status: LoopResultStatus,
	round: number,
	worktreePath: string | null,
	finalCheck: unknown,
): string {
	const statusText =
		status === "completed"
			? "Loop completed"
			: status === "exhausted"
				? "Loop exhausted before until condition passed"
				: "Loop stopped because the progress metric did not strictly decrease";
	return truncate(
		[
			`${statusText} after ${round} round${round === 1 ? "" : "s"}.`,
			`worktree=${worktreePath ?? "(none)"}`,
			`finalCheck=${compactJson(finalCheck, 700)}`,
		].join("\n"),
		LOOP_SUMMARY_MAX_CHARS,
	);
}

function findLoopStageRecord(
	compiledFlow: CompiledWorkflow,
	loopId: string,
): any | undefined {
	return ((compiledFlow as any).stages ?? []).find(
		(stage: any) => stage?.id === loopId && stage?.type === "loop",
	);
}

function latestLoopRound(
	compiledFlow: CompiledWorkflow,
	loopId: string,
): number {
	let latest = 0;
	for (const task of compiledFlow.tasks) {
		if (task.loopChild?.loopId === loopId)
			latest = Math.max(latest, task.loopChild.round);
	}
	return latest;
}

function getLoopRoundRunTasks(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	loopId: string,
	round: number,
): WorkflowTaskRunRecord[] {
	return getLoopRoundTaskEntries(run, compiledFlow, loopId, round).map(
		(entry) => entry.runTask,
	);
}

function getLoopRunTasksThroughRound(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	loopId: string,
	latestRound: number,
): WorkflowTaskRunRecord[] {
	const tasks: WorkflowTaskRunRecord[] = [];
	for (let round = 1; round <= latestRound; round += 1)
		tasks.push(...getLoopRoundRunTasks(run, compiledFlow, loopId, round));
	return tasks;
}

function getLoopRoundTaskEntries(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	loopId: string,
	round: number,
): Array<{
	runTask: WorkflowTaskRunRecord;
	compiledTask: CompiledTask;
	index: number;
}> {
	const entries: Array<{
		runTask: WorkflowTaskRunRecord;
		compiledTask: CompiledTask;
		index: number;
	}> = [];
	const runTaskBySpecId = new Map<
		string,
		{ task: WorkflowTaskRunRecord; index: number }
	>();
	for (const [index, task] of run.tasks.entries())
		runTaskBySpecId.set(task.specId, { task, index });
	for (const compiledTask of compiledFlow.tasks) {
		if (
			compiledTask.loopChild?.loopId !== loopId ||
			compiledTask.loopChild.round !== round
		)
			continue;
		const runEntry = runTaskBySpecId.get(compiledTaskSpecId(compiledTask));
		if (runEntry)
			entries.push({
				runTask: runEntry.task,
				compiledTask,
				index: runEntry.index,
			});
	}
	return entries;
}

export async function reconcileLoopTaskMaterialization(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
): Promise<boolean> {
	const loopIds = loopStageIdSet(compiledFlow);
	if (loopIds.size === 0) return false;
	const changed = reconcileLoopTaskRecordsInMemory(
		cwd,
		run,
		compiledFlow,
		loopIds,
	);
	if (!changed) return false;
	assertLoopTaskPositionalAlignment(run, compiledFlow, loopIds);
	await writeRunRecord(cwd, run);
	return true;
}

function loopChildSourcePolicy(loopStage: any, childStageId: string): string {
	const record = (loopStage.childStageRecords ?? []).find(
		(stage: any) => stage.id === childStageId,
	);
	return record?.sourcePolicy ?? "require-success";
}

function ensureGeneratedStageRecord(
	compiledFlow: CompiledWorkflow,
	id: string,
	type: string | undefined,
	sourcePolicy: string,
): void {
	const stages = ((compiledFlow as any).stages ??= []);
	const existing = stages.find((stage: any) => stage.id === id);
	if (existing) {
		existing.sourcePolicy = existing.sourcePolicy ?? sourcePolicy;
		return;
	}
	stages.push({ id, type: type ?? "single", sourcePolicy });
}

function getLoopState(
	run: WorkflowRunRecord,
	loopId: string,
): LoopStateRecord | undefined {
	return run.loopStates?.find((state) => state.loopId === loopId);
}

function ensureLoopState(
	run: WorkflowRunRecord,
	loopId: string,
): LoopStateRecord {
	run.loopStates ??= [];
	let state = getLoopState(run, loopId);
	if (!state) {
		state = { loopId, round: 0 };
		run.loopStates.push(state);
	}
	return state;
}

function findLoopExhaustedRunTask(
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	loopId: string,
): WorkflowTaskRunRecord | undefined {
	const compiledTask = compiledFlow.tasks.find(
		(task) => task.loopExhausted?.loopId === loopId,
	);
	return compiledTask
		? run.tasks.find((task) => task.specId === compiledTaskSpecId(compiledTask))
		: undefined;
}

function loopDesignatedCheckStageId(loopStage: any): string {
	const refs = new Set<string>();
	collectUntilStageRefs(loopStage.until, refs);
	if (refs.size === 1) return [...refs][0]!;
	const childStageIds = loopStage.childStageIds ?? [];
	return childStageIds[childStageIds.length - 1] ?? "check";
}

function collectUntilStageRefs(condition: unknown, refs: Set<string>): void {
	if (!condition || typeof condition !== "object") return;
	const candidate = condition as any;
	if (typeof candidate.stage === "string") refs.add(candidate.stage);
	else if (typeof candidate.source === "string") refs.add(candidate.source);
	for (const item of candidate.all ?? []) collectUntilStageRefs(item, refs);
	for (const item of candidate.any ?? []) collectUntilStageRefs(item, refs);
}

function valueLength(value: unknown): number | undefined {
	if (Array.isArray(value) || typeof value === "string") return value.length;
	return undefined;
}

function upsertLoopResult(
	run: WorkflowRunRecord,
	result: NonNullable<WorkflowRunRecord["loopResults"]>[number],
): void {
	run.loopResults ??= [];
	const index = run.loopResults.findIndex(
		(item) => item.loopId === result.loopId,
	);
	if (index === -1) run.loopResults.push(result);
	else run.loopResults[index] = result;
}

function findLoopWorktreePath(
	run: WorkflowRunRecord,
	loopId: string,
): string | null {
	const recorded = run.loopWorktrees?.find(
		(item) => item.loopId === loopId,
	)?.path;
	if (recorded) return recorded;
	return (
		run.tasks.find(
			(task) =>
				task.specId.startsWith(`${loopId}.r`) &&
				task.worktree.enabled &&
				task.worktree.path,
		)?.worktree.path ?? null
	);
}

function compactJson(value: unknown, maxChars: number): string {
	if (value === undefined) return "(unavailable)";
	try {
		return truncate(JSON.stringify(value), maxChars);
	} catch {
		return truncate(String(value), maxChars);
	}
}

function truncate(value: string, maxChars: number): string {
	return value.length > maxChars
		? `${value.slice(0, Math.max(0, maxChars - 1))}…`
		: value;
}
