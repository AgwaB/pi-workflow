import { goalHash } from "./goal-json.js";
import {
	compiledWorkflowPath,
	writeJsonAtomic,
	writeRunRecord,
} from "./store.js";
import type { CompiledWorkflow, WorkflowRunRecord } from "./types.js";

const SCHEMA = "goal-generated-materialization-v1" as const;
const DIGEST = /^[a-f0-9]{64}$/u;

type GoalGeneratedMaterializationBoundary = "prepared-run-written" | "compiled-written";
let persistenceHook:
	| ((boundary: GoalGeneratedMaterializationBoundary) => void | Promise<void>)
	| undefined;

export function setGoalGeneratedMaterializationHookForTests(
	hook:
		| ((boundary: GoalGeneratedMaterializationBoundary) => void | Promise<void>)
		| undefined,
): void {
	persistenceHook = hook;
}

interface GoalGeneratedMaterializationJournal {
	readonly schema: typeof SCHEMA;
	readonly beforeCompiledDigest: string;
	readonly afterCompiled: CompiledWorkflow;
	readonly afterCompiledDigest: string;
	readonly afterRunTasksDigest: string;
}

type RunWithGoalGeneratedMaterialization = WorkflowRunRecord & {
	goalGeneratedMaterialization?: GoalGeneratedMaterializationJournal;
};

function journalFor(run: WorkflowRunRecord): GoalGeneratedMaterializationJournal | undefined {
	const value = (run as RunWithGoalGeneratedMaterialization)
		.goalGeneratedMaterialization;
	if (value === undefined) return undefined;
	if (
		!value ||
		typeof value !== "object" ||
		value.schema !== SCHEMA ||
		!DIGEST.test(value.beforeCompiledDigest) ||
		!DIGEST.test(value.afterCompiledDigest) ||
		!DIGEST.test(value.afterRunTasksDigest) ||
		!value.afterCompiled ||
		typeof value.afterCompiled !== "object" ||
		!Array.isArray(value.afterCompiled.tasks) ||
		goalHash(value.afterCompiled) !== value.afterCompiledDigest
	)
		throw new Error("Goal generated materialization journal invalid");
	return value;
}

function persistedClone<T>(value: T): T {
	try {
		return JSON.parse(JSON.stringify(value)) as T;
	} catch {
		throw new Error("Goal generated materialization is not JSON-serializable");
	}
}

export function goalCompiledMaterializationDigest(
	compiledFlow: CompiledWorkflow,
): string {
	return goalHash(persistedClone(compiledFlow));
}

function replaceCompiledWorkflow(
	target: CompiledWorkflow,
	source: CompiledWorkflow,
): void {
	// SAFETY: both values are validated CompiledWorkflow records; mutation preserves
	// the caller's reference while replacing its complete persisted object shape.
	const mutableTarget = target as unknown as Record<string, unknown>;
	for (const key of Object.keys(target)) {
		if (!Object.hasOwn(source, key)) delete mutableTarget[key];
	}
	Object.assign(target, structuredClone(source));
}

/**
 * Persist one already-materialized Goal graph mutation as a recoverable unit.
 * Ordinary workflows retain their historical compiled-then-run write order.
 */
export async function persistGoalGeneratedMaterialization(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	beforeCompiledDigest: string | undefined,
): Promise<void> {
	if (run.goal === undefined) {
		await writeJsonAtomic(compiledWorkflowPath(cwd, run.runId), compiledFlow);
		await writeRunRecord(cwd, run);
		return;
	}
	if (beforeCompiledDigest === undefined || !DIGEST.test(beforeCompiledDigest))
		throw new Error("Goal generated materialization baseline invalid");
	const afterCompiled = persistedClone(compiledFlow);
	const journal: GoalGeneratedMaterializationJournal = Object.freeze({
		schema: SCHEMA,
		beforeCompiledDigest,
		afterCompiled,
		afterCompiledDigest: goalCompiledMaterializationDigest(afterCompiled),
		afterRunTasksDigest: goalHash(run.tasks),
	});
	(run as RunWithGoalGeneratedMaterialization).goalGeneratedMaterialization = journal;
	await writeRunRecord(cwd, run);
	await persistenceHook?.("prepared-run-written");
	await writeJsonAtomic(compiledWorkflowPath(cwd, run.runId), compiledFlow);
	await persistenceHook?.("compiled-written");
	delete (run as RunWithGoalGeneratedMaterialization).goalGeneratedMaterialization;
	await writeRunRecord(cwd, run);
}

/** Recover a prepared or compiled Goal mutation before Goal graph validation. */
export async function recoverGoalGeneratedMaterialization(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
): Promise<boolean> {
	const journal = journalFor(run);
	if (!journal) return false;
	if (run.goal === undefined)
		throw new Error("Goal generated materialization journal on ordinary run");
	if (goalHash(run.tasks) !== journal.afterRunTasksDigest)
		throw new Error("Goal generated materialization run graph changed");
	const currentDigest = goalCompiledMaterializationDigest(compiledFlow);
	if (
		currentDigest !== journal.beforeCompiledDigest &&
		currentDigest !== journal.afterCompiledDigest
	)
		throw new Error("Goal generated materialization compiled graph changed");
	if (currentDigest === journal.beforeCompiledDigest) {
		replaceCompiledWorkflow(compiledFlow, journal.afterCompiled);
		await writeJsonAtomic(compiledWorkflowPath(cwd, run.runId), compiledFlow);
	}
	delete (run as RunWithGoalGeneratedMaterialization).goalGeneratedMaterialization;
	await writeRunRecord(cwd, run);
	return true;
}
