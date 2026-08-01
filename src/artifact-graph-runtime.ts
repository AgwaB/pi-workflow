import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { hashDynamicRequest } from "./dynamic-events.js";
import { stringifyPromptJson } from "./prompt-json.js";
import { compactStrings } from "./strings.js";
import { loadWorkflowHelper } from "./workflow-helpers.js";
import {
	WORKFLOW_ARTIFACT_TOOL_NAME,
	writeWorkflowArtifactExtensionWrapper,
} from "./workflow-artifact-extension.js";
import {
	WORKFLOW_SOURCE_MANIFEST_SCHEMA,
	type WorkflowSourceManifest,
	type WorkflowSourceManifestSource,
} from "./workflow-artifact-tool.js";
import { writeWorkflowTaskArtifactBundle } from "./workflow-output-artifacts.js";
import {
	hasFatalPartialOutputIssue,
	readWorkflowPartialOutputLedger,
	writeWorkflowPartialOutputLedgerFromFile,
} from "./workflow-partial-output.js";
import type { JsonSchema } from "./json-schema.js";
import {
	buildRunSourceContext,
	readOutputText,
	sourceContextOptions,
	workflowBundleSpecPath,
} from "./workflow-source-context-runtime.js";
import { isSimpleJsonPath, readSimpleJsonPath } from "./workflow-runtime.js";
import {
	fromProjectPath,
	readJson,
	setTaskTerminal,
	workflowRunDir,
	writeJsonAtomic,
	writeRunRecord,
} from "./store.js";
import {
	createWorkflowStopSignal,
	isWorkflowStopRequestedError,
	throwIfWorkflowStopRequested,
} from "./workflow-stop.js";
import type {
	ArtifactGraphRequiredRead,
	CompiledTask,
	CompiledWorkflow,
	RequiredWorkflowArtifactReadPolicy,
	WorkflowRunRecord,
	WorkflowTaskRunRecord,
} from "./types.js";

let supportHelperPreparedHookForTests: (() => void | Promise<void>) | undefined;

export function setSupportHelperPreparedHookForTests(
	hook: (() => void | Promise<void>) | undefined,
): void {
	supportHelperPreparedHookForTests = hook;
}

export async function executeSupportTask(
	cwd: string,
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	compiledTask: CompiledWorkflow["tasks"][number],
	validationSnapshot: ArtifactGraphRuntimeValidationSnapshot,
): Promise<boolean> {
	if (!compiledTask.support) {
		throw new Error("support metadata is missing");
	}
	task.status = "running";
	task.statusDetail = "running";
	task.startedAt = task.startedAt ?? new Date().toISOString();
	await writeRunRecord(cwd, run);

	const stop = createWorkflowStopSignal(cwd, run.runId);
	let structuredOutput: unknown;
	try {
		await throwIfWorkflowStopRequested(cwd, run.runId);
		const sources = compiledTask.artifactGraph?.enabled
			? await readArtifactGraphSupportSources(
					cwd,
					run,
					compiledTask.dependsOn ?? [],
					validationSnapshot,
				)
			: await readSupportSources(cwd, run, compiledTask.dependsOn ?? []);
		await throwIfWorkflowStopRequested(cwd, run.runId);
		const helperSpecPath = await workflowBundleSpecPath(cwd, run);
		await throwIfWorkflowStopRequested(cwd, run.runId);
		const helper = await loadWorkflowHelper(
			compiledTask.support.uses,
			helperSpecPath,
		);
		await supportHelperPreparedHookForTests?.();
		await throwIfWorkflowStopRequested(cwd, run.runId);
		structuredOutput = await helper({
			sources,
			options: compiledTask.support.options,
			context: {
				specPath: helperSpecPath,
				originalSpecPath: run.specPath,
				stageId: task.stageId,
				taskId: task.taskId,
				runId: run.runId,
				cwd,
				signal: stop.signal,
				...(compiledTask.artifactGraph?.enabled
					? {
							sourceStatuses: buildArtifactGraphSupportSourceStatuses(
								run,
								compiledTask.dependsOn ?? [],
								validationSnapshot,
							),
						}
					: {}),
			},
		});
		if (stop.signal.aborted) {
			throw stop.signal.reason instanceof Error
				? stop.signal.reason
				: new Error("workflow stop requested");
		}

		if (compiledTask.artifactGraph?.enabled) {
			await throwIfWorkflowStopRequested(cwd, run.runId);
			const declaredStatus = supportControlTerminalStatus(structuredOutput);
			await writeArtifactGraphSupportResult(cwd, task, structuredOutput, {
				lifecycleStatus: declaredStatus ? "failed" : "completed",
				exitCode: declaredStatus ? 1 : 0,
			});
			if (declaredStatus) {
				setTaskTerminal(
					task,
					declaredStatus,
					`support_declared_${declaredStatus}`,
					{
						exitCode: 1,
						lastMessage: `support declared ${declaredStatus}`,
					},
				);
				await writeRunRecord(cwd, run);
				return false;
			}
			setTaskTerminal(task, "completed", "support_completed", {
				exitCode: 0,
				lastMessage: "support completed",
			});
			await writeRunRecord(cwd, run);
			return true;
		}

		await throwIfWorkflowStopRequested(cwd, run.runId);
		await mkdir(dirname(fromProjectPath(cwd, task.files.output)), {
			recursive: true,
		});
		await writeFile(
			fromProjectPath(cwd, task.files.output),
			`${JSON.stringify(structuredOutput, null, 2)}\n`,
			"utf8",
		);
		await writeFile(fromProjectPath(cwd, task.files.stderr), "", "utf8");
		await writeJsonAtomic(fromProjectPath(cwd, task.files.result), {
			status: "completed",
			structuredOutput,
		});
		setTaskTerminal(task, "completed", "support_completed", {
			lastMessage: "support completed",
		});
		await writeRunRecord(cwd, run);
		return true;
	} catch (error) {
		if (stop.signal.aborted || isWorkflowStopRequestedError(error)) {
			setTaskTerminal(task, "interrupted", "workflow_stopped", {
				exitCode: 130,
				lastMessage:
					"Workflow stopped by user request (cooperative support cancellation)",
			});
			await writeRunRecord(cwd, run);
			return false;
		}
		throw error;
	} finally {
		stop.dispose();
	}
}

export async function readSupportSources(
	cwd: string,
	run: WorkflowRunRecord,
	dependsOn: string[],
): Promise<Record<string, unknown>> {
	const sources: Record<string, unknown> = {};
	for (const specId of dependsOn) {
		const source = run.tasks.find((candidate) => candidate.specId === specId);
		if (!source || source.status !== "completed") continue;
		const result = await readJson<{ structuredOutput?: unknown }>(
			fromProjectPath(cwd, source.files.result),
		).catch(() => undefined);
		if (result && Object.hasOwn(result, "structuredOutput")) {
			sources[source.specId] = result.structuredOutput;
		} else {
			sources[source.specId] = (
				await readOutputText(cwd, source.files.output)
			).text;
		}
	}
	return sources;
}

function supportSourceNamesForDependencies(
	run: WorkflowRunRecord,
	dependsOn: readonly string[],
): Map<string, string> {
	const names = new Map<string, string>();
	const usedNames = new Set<string>();
	for (const specId of dependsOn) {
		const source = run.tasks.find((candidate) => candidate.specId === specId);
		if (!source) continue;
		names.set(source.specId, sourceNameForTask(source, usedNames));
	}
	return names;
}

export async function readArtifactGraphSupportSources(
	cwd: string,
	run: WorkflowRunRecord,
	dependsOn: string[],
	validationSnapshot: ArtifactGraphRuntimeValidationSnapshot,
): Promise<Record<string, unknown>> {
	const sourceNames = supportSourceNamesForDependencies(run, dependsOn);
	const sources: Record<string, unknown> = {};
	for (const specId of dependsOn) {
		const source = run.tasks.find((candidate) => candidate.specId === specId);
		if (!source) continue;
		assertArtifactGraphSourceRuntimeMetadataCurrent(
			run,
			source,
			validationSnapshot,
		);
		if (source.status !== "completed") continue;
		sources[sourceNames.get(source.specId) ?? source.specId] =
			await readArtifactGraphControl(cwd, source);
	}
	return sources;
}

function buildArtifactGraphSupportSourceStatuses(
	run: WorkflowRunRecord,
	dependsOn: readonly string[],
	validationSnapshot: ArtifactGraphRuntimeValidationSnapshot,
): Array<Record<string, unknown>> {
	const statuses: Array<Record<string, unknown>> = [];
	const sourceNames = supportSourceNamesForDependencies(run, dependsOn);
	for (const specId of dependsOn) {
		const source = run.tasks.find((candidate) => candidate.specId === specId);
		if (!source) continue;
		assertArtifactGraphSourceRuntimeMetadataCurrent(
			run,
			source,
			validationSnapshot,
		);
		statuses.push({
			source: sourceNames.get(source.specId) ?? source.specId,
			displayName: source.displayName,
			taskId: source.taskId,
			specId: source.specId,
			stageId: source.stageId,
			...sourceStatusForTask(source),
		});
	}
	return statuses;
}

function sourceStatusForTask(task: WorkflowTaskRunRecord): {
	status: string;
	statusDetail?: string;
	lastMessage?: string;
	errorType?: string;
	generation?: number;
	sourceGeneration?: number;
	dispatchMap?: NonNullable<WorkflowTaskRunRecord["dispatchMap"]>;
} {
	const lastMessage = sanitizeSourceLastMessage(task.lastMessage);
	return {
		status: task.status,
		...(task.statusDetail ? { statusDetail: task.statusDetail } : {}),
		...(lastMessage ? { lastMessage } : {}),
		...(task.status !== "completed"
			? { errorType: sourceErrorType(task) }
			: {}),
		...artifactGraphSourceRuntimeMetadata(task),
	};
}

function sanitizeSourceLastMessage(
	value: string | undefined,
): string | undefined {
	const text = String(value ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return text ? text.slice(0, 500) : undefined;
}

function sourceErrorType(task: WorkflowTaskRunRecord): string {
	const detail = String(task.statusDetail ?? "").toLowerCase();
	const message = String(task.lastMessage ?? "").toLowerCase();
	if (/timeout|timed out/.test(detail) || /timeout|timed out/.test(message))
		return "timeout";
	if (
		/schema|validation|invalid/.test(detail) ||
		/schema|validation|invalid/.test(message)
	)
		return "schema_violation";
	if (/model|subagent/.test(detail) || /model|subagent/.test(message))
		return "model_failure";
	if (/skip|skipped/.test(task.status) || /skip|skipped/.test(detail))
		return "skipped";
	return task.status === "failed" ? "failed" : task.status;
}
type ArtifactGraphDispatchMap = NonNullable<
	WorkflowTaskRunRecord["dispatchMap"]
>;

type ArtifactGraphValidationDispatchMap = Readonly<{
	version: unknown;
	generation: unknown;
	sourceTaskId: unknown;
	entries: unknown;
	digest: unknown;
}>;

type ArtifactGraphValidationTask = Readonly<{
	taskId: string;
	specId: string;
	generation?: number;
	sourceGeneration?: number;
	foreachGenerated?: Readonly<{
		placeholderSpecId: string;
		itemIdentity?: string;
		itemHash?: string;
		itemSourceTaskId?: string;
		itemSourceSpecId?: string;
		itemSourceKind?: "control" | "partial";
		itemRef?: string;
		perItemDispatch?: true;
	}>;
	dispatchMap?: ArtifactGraphValidationDispatchMap;
}>;

type ArtifactGraphValidatedDispatchMap = {
	entryIdentityByChildKey: ReadonlyMap<string, string>;
};

type ArtifactGraphDispatchMapValidationResult =
	| { kind: "valid"; value: ArtifactGraphValidatedDispatchMap }
	| { kind: "invalid"; error: Error };

export type ArtifactGraphRuntimeValidationSnapshot = {
	readonly run: WorkflowRunRecord;
	readonly taskById: ReadonlyMap<
		string,
		ArtifactGraphValidationTask | undefined
	>;
	readonly parentBySpecId: ReadonlyMap<
		string,
		ArtifactGraphValidationTask | undefined
	>;
	readonly taskByTaskAndSpec: ReadonlyMap<
		string,
		ArtifactGraphValidationTask | undefined
	>;
	readonly validatedDispatchMaps: Map<
		string,
		ArtifactGraphDispatchMapValidationResult
	>;
};

let artifactGraphDispatchMapIndexBuildsForTests = 0;
let artifactGraphFullDispatchMapValidationsForTests = 0;

export function resetArtifactGraphDispatchMapValidationStatsForTests(): void {
	artifactGraphDispatchMapIndexBuildsForTests = 0;
	artifactGraphFullDispatchMapValidationsForTests = 0;
}

export function artifactGraphDispatchMapValidationStatsForTests(): {
	indexBuilds: number;
	fullValidations: number;
} {
	return {
		indexBuilds: artifactGraphDispatchMapIndexBuildsForTests,
		fullValidations: artifactGraphFullDispatchMapValidationsForTests,
	};
}

export function createArtifactGraphRuntimeValidationSnapshot(
	run: WorkflowRunRecord,
): ArtifactGraphRuntimeValidationSnapshot {
	artifactGraphDispatchMapIndexBuildsForTests += 1;
	const taskById = new Map<
		string,
		ArtifactGraphValidationTask | undefined
	>();
	const parentBySpecId = new Map<
		string,
		ArtifactGraphValidationTask | undefined
	>();
	const taskByTaskAndSpec = new Map<
		string,
		ArtifactGraphValidationTask | undefined
	>();
	for (const task of run.tasks) {
		const validationTask = cloneArtifactGraphValidationTask(task);
		setUniqueIndexedTask(taskById, validationTask.taskId, validationTask);
		setUniqueIndexedTask(parentBySpecId, validationTask.specId, validationTask);
		setUniqueIndexedTask(
			taskByTaskAndSpec,
			dispatchMapChildKey(validationTask.taskId, validationTask.specId),
			validationTask,
		);
	}
	return {
		run,
		taskById,
		parentBySpecId,
		taskByTaskAndSpec,
		validatedDispatchMaps: new Map(),
	};
}

function cloneArtifactGraphValidationTask(
	task: WorkflowTaskRunRecord,
): ArtifactGraphValidationTask {
	const dispatchMap = task.dispatchMap
		? Object.freeze({
				version: task.dispatchMap.version,
				generation: task.dispatchMap.generation,
				sourceTaskId: task.dispatchMap.sourceTaskId,
				entries: Array.isArray(task.dispatchMap.entries)
					? Object.freeze(
							task.dispatchMap.entries.map((entry) =>
								Object.freeze({ ...entry }),
							),
						)
					: task.dispatchMap.entries,
				digest: task.dispatchMap.digest,
			})
		: undefined;
	return Object.freeze({
		taskId: task.taskId,
		specId: task.specId,
		...(task.generation === undefined ? {} : { generation: task.generation }),
		...(task.sourceGeneration === undefined
			? {}
			: { sourceGeneration: task.sourceGeneration }),
		...(task.foreachGenerated === undefined
			? {}
			: {
					foreachGenerated: Object.freeze({
						placeholderSpecId: task.foreachGenerated.placeholderSpecId,
						...(task.foreachGenerated.itemIdentity === undefined
							? {}
							: { itemIdentity: task.foreachGenerated.itemIdentity }),
						...(task.foreachGenerated.itemHash === undefined
							? {}
							: { itemHash: task.foreachGenerated.itemHash }),
						...(task.foreachGenerated.itemSourceTaskId === undefined
							? {}
							: { itemSourceTaskId: task.foreachGenerated.itemSourceTaskId }),
						...(task.foreachGenerated.itemSourceSpecId === undefined
							? {}
							: { itemSourceSpecId: task.foreachGenerated.itemSourceSpecId }),
						...(task.foreachGenerated.itemSourceKind === undefined
							? {}
							: { itemSourceKind: task.foreachGenerated.itemSourceKind }),
						...(task.foreachGenerated.itemRef === undefined
							? {}
							: { itemRef: task.foreachGenerated.itemRef }),
						...(task.foreachGenerated.perItemDispatch === undefined
							? {}
							: { perItemDispatch: task.foreachGenerated.perItemDispatch }),
					}),
				}),
		...(dispatchMap === undefined ? {} : { dispatchMap }),
	});
}

function setUniqueIndexedTask(
	index: Map<string, ArtifactGraphValidationTask | undefined>,
	key: string,
	task: ArtifactGraphValidationTask,
): void {
	if (index.has(key)) {
		index.set(key, undefined);
		return;
	}
	index.set(key, task);
}

function artifactGraphSourceRuntimeMetadata(
	task: WorkflowTaskRunRecord,
): {
	generation?: number;
	sourceGeneration?: number;
	dispatchMap?: ArtifactGraphDispatchMap;
} {
	return {
		...(task.generation === undefined ? {} : { generation: task.generation }),
		...(task.sourceGeneration === undefined
			? {}
			: { sourceGeneration: task.sourceGeneration }),
		...(task.dispatchMap === undefined
			? {}
			: {
					dispatchMap: {
						version: task.dispatchMap.version,
						generation: task.dispatchMap.generation,
						sourceTaskId: task.dispatchMap.sourceTaskId,
						entries: task.dispatchMap.entries.map((entry) => ({ ...entry })),
						digest: task.dispatchMap.digest,
					},
				}),
	};
}

export function assertArtifactGraphSourceRuntimeMetadataCurrent(
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	snapshot: ArtifactGraphRuntimeValidationSnapshot,
): void {
	assertValidationSnapshotMatchesRun(run, snapshot);
	const validationTask = snapshot.taskByTaskAndSpec.get(
		dispatchMapChildKey(task.taskId, task.specId),
	);
	if (!validationTask) {
		throw new Error(
			`artifact source ${task.specId} is missing or ambiguous in the validation snapshot`,
		);
	}
	assertTaskGeneration(validationTask.generation, validationTask, "generation");
	if (validationTask.dispatchMap !== undefined) {
		assertDispatchMapCurrent(
			snapshot,
			validationTask,
			validationTask.dispatchMap,
		);
	}
	if (validationTask.sourceGeneration === undefined) return;

	assertTaskGeneration(
		validationTask.sourceGeneration,
		validationTask,
		"sourceGeneration",
	);
	const placeholderSpecId =
		validationTask.foreachGenerated?.placeholderSpecId;
	const itemIdentity = validationTask.foreachGenerated?.itemIdentity;
	if (!placeholderSpecId || !itemIdentity) {
		throw new Error(
			`artifact source ${validationTask.specId} has sourceGeneration without generation-bound foreach identity`,
		);
	}
	const parent = snapshot.parentBySpecId.get(placeholderSpecId);
	if (!parent) {
		throw new Error(
			`artifact source ${validationTask.specId} has ambiguous or missing foreach dispatch-map parent ${placeholderSpecId}`,
		);
	}
	const dispatchMap = parent.dispatchMap;
	if (!dispatchMap) {
		throw new Error(
			`artifact source ${validationTask.specId} references a stale or missing dispatch map`,
		);
	}
	const validatedDispatchMap = assertDispatchMapCurrent(
		snapshot,
		parent,
		dispatchMap,
	);
	if (dispatchMap.generation !== validationTask.sourceGeneration) {
		throw new Error(
			`artifact source ${validationTask.specId} sourceGeneration does not match its dispatch map`,
		);
	}
	if (
		validatedDispatchMap.entryIdentityByChildKey.get(
			dispatchMapChildKey(validationTask.taskId, validationTask.specId),
		) !== itemIdentity
	) {
		throw new Error(
			`artifact source ${validationTask.specId} is absent from its generation-bound dispatch map`,
		);
	}
}

function assertValidationSnapshotMatchesRun(
	run: WorkflowRunRecord,
	snapshot: ArtifactGraphRuntimeValidationSnapshot,
): void {
	if (snapshot.run !== run) {
		throw new Error(
			"artifact graph validation snapshot does not match the current run",
		);
	}
}

function assertTaskGeneration(
	generation: number | undefined,
	task: ArtifactGraphValidationTask,
	field: "generation" | "sourceGeneration",
): void {
	if (
		generation !== undefined &&
		(!Number.isSafeInteger(generation) || generation < 0)
	) {
		throw new Error(
			`artifact source ${task.specId} has invalid ${field} metadata`,
		);
	}
}

function assertDispatchMapCurrent(
	snapshot: ArtifactGraphRuntimeValidationSnapshot,
	parent: ArtifactGraphValidationTask,
	dispatchMap: ArtifactGraphValidationDispatchMap,
): ArtifactGraphValidatedDispatchMap {
	const cacheKey = `${parent.taskId}\0${String(dispatchMap.digest)}`;
	const cached = snapshot.validatedDispatchMaps.get(cacheKey);
	if (cached) {
		if (cached.kind === "valid") return cached.value;
		throw cached.error;
	}

	try {
		artifactGraphFullDispatchMapValidationsForTests += 1;
		const version = dispatchMap.version;
		const generation = dispatchMap.generation;
		if (
			version !== 1 ||
			typeof generation !== "number" ||
			!Number.isSafeInteger(generation) ||
			generation < 0 ||
			typeof dispatchMap.sourceTaskId !== "string" ||
			dispatchMap.sourceTaskId === "" ||
			typeof dispatchMap.digest !== "string" ||
			dispatchMap.digest === "" ||
			!Array.isArray(dispatchMap.entries)
		) {
			throw new Error(
				`artifact source ${parent.specId} has invalid dispatch-map metadata`,
			);
		}
		const expectedDigest = hashDynamicRequest({
			version,
			generation,
			sourceTaskId: dispatchMap.sourceTaskId,
			entries: dispatchMap.entries,
		});
		if (dispatchMap.digest !== expectedDigest) {
			throw new Error(
				`artifact source ${parent.specId} dispatch map digest does not match its current entries`,
			);
		}

		const mapSource = snapshot.taskById.get(dispatchMap.sourceTaskId);
		if (!mapSource) {
			throw new Error(
				`artifact source ${parent.specId} dispatch map has an ambiguous or missing source task`,
			);
		}
		assertTaskGeneration(mapSource.generation, mapSource, "generation");
		if ((mapSource.generation ?? 0) !== generation) {
			throw new Error(
				`artifact source ${parent.specId} dispatch map generation is stale`,
			);
		}

		const itemIdentities = new Set<string>();
		const taskIds = new Set<string>();
		const specIds = new Set<string>();
		const entryIdentityByChildKey = new Map<string, string>();
		for (const entry of dispatchMap.entries) {
			if (
				!entry ||
				typeof entry !== "object" ||
				typeof entry.itemIdentity !== "string" ||
				entry.itemIdentity === "" ||
				typeof entry.taskId !== "string" ||
				entry.taskId === "" ||
				typeof entry.specId !== "string" ||
				entry.specId === "" ||
				typeof entry.itemSourceTaskId !== "string" ||
				entry.itemSourceTaskId !== dispatchMap.sourceTaskId ||
				typeof entry.itemSourceSpecId !== "string" ||
				entry.itemSourceSpecId === "" ||
				(entry.itemSourceKind !== "control" &&
					entry.itemSourceKind !== "partial") ||
				typeof entry.itemRef !== "string" ||
				entry.itemRef === "" ||
				typeof entry.itemHash !== "string" ||
				entry.itemHash === "" ||
				(entry.perItemDispatch !== undefined &&
					entry.perItemDispatch !== true) ||
				itemIdentities.has(entry.itemIdentity) ||
				taskIds.has(entry.taskId) ||
				specIds.has(entry.specId)
			) {
				throw new Error(
					`artifact source ${parent.specId} has invalid dispatch-map entries`,
				);
			}
			itemIdentities.add(entry.itemIdentity);
			taskIds.add(entry.taskId);
			specIds.add(entry.specId);

			const child = snapshot.taskByTaskAndSpec.get(
				dispatchMapChildKey(entry.taskId, entry.specId),
			);
			if (
				!child ||
				snapshot.taskById.get(entry.taskId) !== child ||
				mapSource.taskId !== entry.itemSourceTaskId ||
				mapSource.specId !== entry.itemSourceSpecId
			) {
				throw new Error(
					`artifact source ${parent.specId} dispatch map entry is stale, ambiguous, or bound to the wrong source`,
				);
			}
			if (
				child.sourceGeneration !== generation ||
				child.foreachGenerated?.placeholderSpecId !== parent.specId ||
				child.foreachGenerated?.itemIdentity !== entry.itemIdentity ||
				child.foreachGenerated?.itemHash !== entry.itemHash ||
				child.foreachGenerated?.itemSourceTaskId !== entry.itemSourceTaskId ||
				child.foreachGenerated?.itemSourceSpecId !== entry.itemSourceSpecId ||
				child.foreachGenerated?.itemSourceKind !== entry.itemSourceKind ||
				child.foreachGenerated?.itemRef !== entry.itemRef ||
				child.foreachGenerated?.perItemDispatch !== entry.perItemDispatch
			) {
				throw new Error(
					`artifact source ${parent.specId} dispatch map entry does not match the current child identity tuple`,
				);
			}
			entryIdentityByChildKey.set(
				dispatchMapChildKey(entry.taskId, entry.specId),
				entry.itemIdentity,
			);
		}
		const value = { entryIdentityByChildKey };
		snapshot.validatedDispatchMaps.set(cacheKey, { kind: "valid", value });
		return value;
	} catch (error) {
		const normalized =
			error instanceof Error ? error : new Error(String(error));
		snapshot.validatedDispatchMaps.set(cacheKey, {
			kind: "invalid",
			error: normalized,
		});
		throw normalized;
	}
}

function dispatchMapChildKey(taskId: string, specId: string): string {
	return `${taskId.length}:${taskId}${specId}`;
}
export function finalCompiledPromptMeasurement(task: CompiledTask): {
	chars: number;
	maxChars?: number;
} {
	const maxChars = task.artifactGraph?.inputPolicy?.maxCompiledPromptChars;
	if (maxChars !== undefined && (!Number.isSafeInteger(maxChars) || maxChars < 1)) {
		throw new Error(
			`task ${task.id} has invalid maxCompiledPromptChars=${String(maxChars)}`,
		);
	}
	const chars = Array.from(task.compiledPrompt).length;
	if (maxChars !== undefined && chars > maxChars) {
		throw new Error(
			`task ${task.id} final compiled prompt exceeds maxCompiledPromptChars=${maxChars} (actual ${chars})`,
		);
	}
	return {
		chars,
		...(maxChars === undefined ? {} : { maxChars }),
	};
}

export function assertFinalCompiledPromptWithinCap(task: CompiledTask): void {
	if (task.artifactGraph?.inputPolicy?.maxCompiledPromptChars === undefined)
		return;
	finalCompiledPromptMeasurement(task);
}
export async function writeArtifactGraphDynamicResult(
	cwd: string,
	task: WorkflowTaskRunRecord,
	structuredOutput: unknown,
	lifecycleStatus: "completed" | "failed" = "completed",
): Promise<void> {
	const { control, analysis, refs } =
		normalizeDynamicControllerOutput(structuredOutput);
	const rawOutput = [
		"<control>",
		JSON.stringify(control, null, 2),
		"</control>",
		"<analysis>",
		analysis,
		"</analysis>",
		"<refs>",
		JSON.stringify(refs, null, 2),
		"</refs>",
	].join("\n");
	await mkdir(dirname(fromProjectPath(cwd, task.files.output)), {
		recursive: true,
	});
	await writeFile(fromProjectPath(cwd, task.files.output), rawOutput, "utf8");
	await writeFile(fromProjectPath(cwd, task.files.stderr), "", "utf8");
	const written = await writeWorkflowTaskArtifactBundle({
		taskDir: dirname(fromProjectPath(cwd, task.files.result)),
		rawOutput,
		completedAt: new Date().toISOString(),
		lifecycleStatus,
		analysisRequired: task.artifactGraph?.output.analysisRequired ?? true,
		refsRequired: task.artifactGraph?.output.refsRequired ?? true,
		refsMinItems: task.artifactGraph?.output.refsMinItems,
		refsUrlValidation: task.artifactGraph?.output.refsUrlValidation,
		maxDigestChars: task.artifactGraph?.output.maxDigestChars,
		controlJsonSchema: await readTaskControlJsonSchema(task),
	});
	if (!written.valid) {
		throw new Error(
			`dynamic controller output failed workflow validation: ${written.parsed.issues
				.map((issue) => issue.message)
				.join("; ")}`,
		);
	}
}

function supportControlTerminalStatus(
	structuredOutput: unknown,
): "failed" | "blocked" | undefined {
	const control = normalizeSupportControl(structuredOutput);
	if (control.status === "failed" || control.status === "blocked")
		return control.status;
	const gates = control.gates;
	if (
		gates &&
		typeof gates === "object" &&
		!Array.isArray(gates) &&
		(gates as Record<string, unknown>).passed === false
	)
		return "failed";
	return undefined;
}

export async function writeArtifactGraphSupportResult(
	cwd: string,
	task: WorkflowTaskRunRecord,
	structuredOutput: unknown,
	options: {
		lifecycleStatus?: "completed" | "failed";
		exitCode?: number;
	} = {},
): Promise<void> {
	const control = normalizeSupportControl(structuredOutput);
	const analysis = supportOutputAnalysis(structuredOutput, control);
	const refs = supportOutputRefs(structuredOutput, control);
	const rawOutput = [
		"<control>",
		JSON.stringify(control, null, 2),
		"</control>",
		"<analysis>",
		analysis,
		"</analysis>",
		"<refs>",
		JSON.stringify(refs, null, 2),
		"</refs>",
	].join("\n");
	await mkdir(dirname(fromProjectPath(cwd, task.files.output)), {
		recursive: true,
	});
	await writeFile(fromProjectPath(cwd, task.files.output), rawOutput, "utf8");
	await writeFile(fromProjectPath(cwd, task.files.stderr), "", "utf8");
	const written = await writeWorkflowTaskArtifactBundle({
		taskDir: dirname(fromProjectPath(cwd, task.files.result)),
		rawOutput,
		completedAt: new Date().toISOString(),
		lifecycleStatus: options.lifecycleStatus,
		exitCode: options.exitCode,
		analysisRequired: task.artifactGraph?.output.analysisRequired ?? true,
		refsRequired: task.artifactGraph?.output.refsRequired ?? true,
		refsMinItems: task.artifactGraph?.output.refsMinItems,
		refsUrlValidation: task.artifactGraph?.output.refsUrlValidation,
		maxDigestChars: task.artifactGraph?.output.maxDigestChars,
		controlJsonSchema: await readTaskControlJsonSchema(task),
	});
	if (!written.valid) {
		throw new Error(
			`support control failed workflow output validation: ${written.parsed.issues
				.map((issue) => issue.message)
				.join("; ")}`,
		);
	}
}

async function readTaskControlJsonSchema(
	task: WorkflowTaskRunRecord,
): Promise<JsonSchema | undefined> {
	const schemaPath = task.artifactGraph?.output.controlSchemaPath;
	if (!schemaPath) return undefined;
	return JSON.parse(await readFile(schemaPath, "utf8")) as JsonSchema;
}

export function normalizeDynamicControllerOutput(value: unknown): {
	control: Record<string, unknown>;
	analysis: string;
	refs: unknown[];
} {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const record = value as Record<string, unknown>;
		const rawControl =
			record.control &&
			typeof record.control === "object" &&
			!Array.isArray(record.control)
				? (record.control as Record<string, unknown>)
				: record;
		const analysis =
			typeof record.analysis === "string"
				? record.analysis
				: typeof rawControl.summary === "string"
					? rawControl.summary
					: "Dynamic controller completed.";
		return {
			control: {
				schema:
					typeof rawControl.schema === "string"
						? rawControl.schema
						: "dynamic-controller-result-v1",
				digest:
					typeof rawControl.digest === "string"
						? rawControl.digest
						: typeof rawControl.summary === "string"
							? rawControl.summary
							: "Dynamic controller completed.",
				...rawControl,
			},
			analysis,
			refs: Array.isArray(record.refs) ? record.refs : [],
		};
	}
	return {
		control: {
			schema: "dynamic-controller-result-v1",
			digest: "Dynamic controller completed.",
			value,
		},
		analysis: "Dynamic controller completed.",
		refs: [],
	};
}
export function normalizeSupportControl(
	value: unknown,
): Record<string, unknown> {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const record = value as Record<string, unknown>;
		return {
			schema:
				typeof record.schema === "string" ? record.schema : "stage-control-v1",
			digest:
				typeof record.digest === "string"
					? record.digest
					: "Support helper completed.",
			...record,
		};
	}
	return {
		schema: "stage-control-v1",
		digest: "Support helper completed.",
		value,
	};
}

export function supportOutputAnalysis(
	value: unknown,
	control: Record<string, unknown>,
): string {
	const record =
		value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	for (const candidate of [
		record?.analysis,
		record?.executiveMarkdown,
		record?.markdown,
		control.summary,
	]) {
		if (typeof candidate === "string" && candidate.trim()) {
			return candidate.trim();
		}
	}
	return "Support helper completed deterministically.";
}

export function supportOutputRefs(
	value: unknown,
	control: Record<string, unknown>,
): unknown[] {
	const record =
		value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	if (Array.isArray(record?.refs)) return record.refs;
	if (Array.isArray(control.refs)) return control.refs;
	const urls = Array.isArray(record?.sourceUrls)
		? record.sourceUrls
		: Array.isArray(control.sourceUrls)
			? control.sourceUrls
			: [];
	return urls.filter((url): url is string => typeof url === "string");
}
export async function prepareDagTask(
	cwd: string,
	run: WorkflowRunRecord,
	compiledFlow: CompiledWorkflow,
	index: number,
	validationSnapshot: ArtifactGraphRuntimeValidationSnapshot = createArtifactGraphRuntimeValidationSnapshot(
		run,
	),
): Promise<CompiledWorkflow["tasks"][number]> {
	const compiledTask = compiledFlow.tasks[index]!;
	const task = run.tasks[index]!;
	const contextDependsOn =
		compiledTask.contextDependsOn ?? compiledTask.dependsOn ?? [];
	if (compiledTask.artifactGraph?.enabled) {
		const preparedTask = await prepareArtifactGraphTask(
			cwd,
			run,
			compiledTask,
			task,
			contextDependsOn,
			validationSnapshot,
		);
		assertFinalCompiledPromptWithinCap(preparedTask);
		return preparedTask;
	}
	if (contextDependsOn.length === 0) {
		assertFinalCompiledPromptWithinCap(compiledTask);
		return compiledTask;
	}

	const bySpecId = new Map(
		run.tasks.map((sourceTask) => [sourceTask.specId, sourceTask]),
	);
	const sourceTasks = contextDependsOn
		.map((dep) => bySpecId.get(dep))
		.filter((sourceTask): sourceTask is WorkflowTaskRunRecord =>
			Boolean(sourceTask),
		);
	for (const sourceTask of sourceTasks) {
		assertArtifactGraphSourceRuntimeMetadataCurrent(
			run,
			sourceTask,
			validationSnapshot,
		);
	}
	const missing = contextDependsOn.filter((dep) => !bySpecId.has(dep));
	const context = await buildRunSourceContext(
		cwd,
		run,
		sourceTasks,
		sourceContextOptions(compiledTask),
	);

	const preparedTask = {
		...compiledTask,
		cwd: task.cwd,
		compiledPrompt: [
			compiledTask.compiledPrompt,
			"# Source Stage Context",
			"Use this deterministic source context packet. Prefer structuredOutput over outputPreview. Do not assume dependencies beyond this explicit packet.",
			stringifyPromptJson({ ...context, missingDependencies: missing }),
		].join("\n\n"),
	};
	assertFinalCompiledPromptWithinCap(preparedTask);
	return preparedTask;
}

type PerItemLedgerProjection = {
	placeholderSpecId: string;
	itemIdentity: string;
	itemHash: string;
	itemSourceTaskId: string;
	itemSourceSpecId: string;
	itemRef: string;
};

function perItemLedgerProjectionForPreparation(
	compiledTask: CompiledTask,
	runTask: WorkflowTaskRunRecord,
	contextDependsOn: readonly string[],
): PerItemLedgerProjection | undefined {
	const compiled = compiledTask.foreachGenerated;
	const persisted = runTask.foreachGenerated;
	const requested =
		compiled?.perItemDispatch === true || persisted?.perItemDispatch === true;
	if (!requested) return undefined;
	if (
		!compiled ||
		!persisted ||
		compiled.perItemDispatch !== true ||
		persisted.perItemDispatch !== true ||
		compiled.itemSourceKind !== "partial" ||
		persisted.itemSourceKind !== "partial" ||
		!compiled.placeholderSpecId ||
		!compiled.itemIdentity ||
		!compiled.itemHash ||
		!compiled.itemSourceTaskId ||
		!compiled.itemSourceSpecId ||
		!compiled.itemRef ||
		compiled.placeholderSpecId !== persisted.placeholderSpecId ||
		compiled.itemIdentity !== persisted.itemIdentity ||
		compiled.itemHash !== persisted.itemHash ||
		compiled.itemSourceTaskId !== persisted.itemSourceTaskId ||
		compiled.itemSourceSpecId !== persisted.itemSourceSpecId ||
		compiled.itemSourceKind !== persisted.itemSourceKind ||
		compiled.itemRef !== persisted.itemRef ||
		!contextDependsOn.includes(compiled.itemSourceSpecId)
	) {
		throw new Error(
			`per-item dispatch task ${compiledTask.id} has incomplete or inconsistent persisted foreach identity metadata`,
		);
	}
	return {
		placeholderSpecId: compiled.placeholderSpecId,
		itemIdentity: compiled.itemIdentity,
		itemHash: compiled.itemHash,
		itemSourceTaskId: compiled.itemSourceTaskId,
		itemSourceSpecId: compiled.itemSourceSpecId,
		itemRef: compiled.itemRef,
	};
}

async function prepareArtifactGraphTask(
	cwd: string,
	run: WorkflowRunRecord,
	compiledTask: CompiledTask,
	task: WorkflowTaskRunRecord,
	contextDependsOn: readonly string[],
	validationSnapshot: ArtifactGraphRuntimeValidationSnapshot,
): Promise<CompiledTask> {
	if (compiledTask.artifactGraph?.artifactAccess === "none") {
		const {
			[WORKFLOW_ARTIFACT_TOOL_NAME]: _workflowArtifact,
			...toolProviders
		} = compiledTask.runtime.toolProviders ?? {};
		return {
			...compiledTask,
			cwd: task.cwd,
			runtime: {
				...compiledTask.runtime,
				tools: (compiledTask.runtime.tools ?? []).filter(
					(tool) => tool !== WORKFLOW_ARTIFACT_TOOL_NAME,
				),
				toolProviders,
			},
		};
	}
	assertArtifactGraphSourceRuntimeMetadataCurrent(
		run,
		task,
		validationSnapshot,
	);

	const taskDir = dirname(fromProjectPath(cwd, task.files.result));
	const manifestPath = join(taskDir, "source-manifest.json");
	const ledgerPath = join(taskDir, "read-ledger.jsonl");
	const wrapperPath = join(taskDir, "workflow-artifact-extension.ts");
	const perItemProjection = perItemLedgerProjectionForPreparation(
		compiledTask,
		task,
		contextDependsOn,
	);
	const sources = await buildArtifactGraphSourceManifestSources(
		cwd,
		run,
		contextDependsOn,
		validationSnapshot,
		compiledTask.artifactGraph?.sourceProjection,
		{
			partialLedgerProjection: perItemProjection !== undefined,
			perItemProjection,
		},
	);
	const manifest: WorkflowSourceManifest = {
		schema: WORKFLOW_SOURCE_MANIFEST_SCHEMA,
		runId: run.runId,
		taskId: task.taskId,
		sources,
		policy: { accessMode: "workflow-task" },
	};
	await writeJsonAtomic(manifestPath, manifest);
	await writeWorkflowArtifactExtensionWrapper({
		wrapperPath,
		importPath: workflowArtifactExtensionImportPath(),
		config: {
			runId: run.runId,
			taskId: task.taskId,
			manifestPath,
			ledgerPath,
			accessMode: "workflow-task",
			runDir: workflowRunDir(cwd, run.runId),
		},
	});

	const requiredReads = compiledTask.artifactGraph?.requiredReads ?? [];
	const requiredReadPolicy =
		compiledTask.artifactGraph?.requiredReadPolicy ?? [];
	assertRequiredArtifactsInSourceManifest(
		sources,
		requiredReads,
		requiredReadPolicy,
	);
	const requiredReadContext = formatRequiredArtifactReadReferences({
		sources,
		requiredReads,
		requiredReadPolicy,
	});
	return {
		...compiledTask,
		cwd: task.cwd,
		runtime: {
			...compiledTask.runtime,
			tools: uniqueStrings([
				...(compiledTask.runtime.tools ?? []),
				WORKFLOW_ARTIFACT_TOOL_NAME,
			]),
			toolProviders: {
				...(compiledTask.runtime.toolProviders ?? {}),
				[WORKFLOW_ARTIFACT_TOOL_NAME]: {
					classification: "read-only",
					extensions: [wrapperPath],
				},
			},
		},
		compiledPrompt: [
			compiledTask.compiledPrompt,
			formatArtifactGraphSourceContext(
				sources,
				requiredReads,
				requiredReadPolicy,
			),
			requiredReadContext || undefined,
		]
			.filter(Boolean)
			.join("\n\n"),
	};
}

function assertRequiredArtifactsInSourceManifest(
	sources: WorkflowSourceManifestSource[],
	requiredReads: readonly ArtifactGraphRequiredRead[],
	requiredReadPolicy: readonly RequiredWorkflowArtifactReadPolicy[],
): void {
	const missing: string[] = [];
	for (const required of requiredReads) {
		const parsed = parseRequiredArtifactRead(required);
		if (!parsed) continue;
		const source = sources.find(
			(candidate) => candidate.source === parsed.source,
		);
		if (!source?.artifacts?.[parsed.artifact]?.path) {
			missing.push(formatRequiredArtifactRead(required));
		}
	}
	for (const policy of requiredReadPolicy) {
		const source = sources.find(
			(candidate) => candidate.source === policy.source,
		);
		if (!source?.artifacts?.[policy.artifact]?.path) {
			missing.push(`${policy.source}.${policy.artifact}`);
		}
	}
	if (missing.length > 0) {
		throw new Error(
			`required workflow artifact read is not available in the runtime source manifest: ${[...new Set(missing)].join(", ")}. Add the source to from/input context; after is ordering-only.`,
		);
	}
}

function formatRequiredArtifactReadReferences(options: {
	sources: WorkflowSourceManifestSource[];
	requiredReads: readonly ArtifactGraphRequiredRead[];
	requiredReadPolicy?: readonly RequiredWorkflowArtifactReadPolicy[];
}): string {
	const requiredReadPolicy = options.requiredReadPolicy ?? [];
	if (options.requiredReads.length === 0 && requiredReadPolicy.length === 0)
		return "";
	const sections = options.requiredReads.map((required) => {
		const parsed = parseRequiredArtifactRead(required);
		const label = formatRequiredArtifactRead(required);
		if (!parsed) {
			return `- ${label}: invalid required read; expected source.artifact or {source,artifact}.`;
		}
		const source = options.sources.find(
			(candidate) => candidate.source === parsed.source,
		);
		const artifact = source?.artifacts?.[parsed.artifact];
		if (!source || !artifact?.path) {
			return `- ${label}: required artifact is not available in the source manifest.`;
		}
		const projection = [
			parsed.path === undefined ? undefined : `path=${parsed.path}`,
			parsed.maxItems === undefined ? undefined : `maxItems=${parsed.maxItems}`,
			parsed.maxChars === undefined ? undefined : `maxChars=${parsed.maxChars}`,
			parsed.count === undefined ? undefined : `count=${parsed.count}`,
		]
			.filter(Boolean)
			.join(", ");
		return `- ${label}: available via workflow_artifact read with source=${JSON.stringify(parsed.source)}, artifact=${JSON.stringify(parsed.artifact)}${projection ? ` (${projection})` : ""}.`;
	});
	const structuredSections = requiredReadPolicy.map((policy) =>
		formatRequiredArtifactReadPolicyReference(options.sources, policy),
	);
	return [
		"# Required Workflow Artifact Reads",
		"The workflow runtime does not preload requiredReads into this prompt. To satisfy the required-read gate, call workflow_artifact for each listed source/artifact before producing the final answer. The read ledger, not this prompt, proves access.",
		...sections,
		...structuredSections,
	].join("\n");
}

function formatRequiredArtifactReadPolicyReference(
	sources: WorkflowSourceManifestSource[],
	policy: RequiredWorkflowArtifactReadPolicy,
): string {
	const source = sources.find(
		(candidate) => candidate.source === policy.source,
	);
	const artifact = source?.artifacts?.[policy.artifact];
	const readName = `${policy.source}.${policy.artifact}`;
	if (!source || !artifact?.path) {
		return `- ${readName}: required artifact is not available in the source manifest.`;
	}
	const toolInput = {
		action: "read",
		source: policy.source,
		artifact: policy.artifact,
		...(policy.path === undefined ? {} : { path: policy.path }),
		...(policy.maxItems === undefined ? {} : { maxItems: policy.maxItems }),
		...(policy.maxChars === undefined ? {} : { maxChars: policy.maxChars }),
	};
	const constraints = [
		"must produce a non-truncated ledger row",
		policy.minReturnedBytes === undefined
			? undefined
			: `returnedBytes >= ${policy.minReturnedBytes}`,
	].filter(Boolean);
	return `- ${readName}: call workflow_artifact with ${stringifyPromptJson(toolInput)}; ${constraints.join(", ")}.`;
}

function parseRequiredArtifactRead(value: ArtifactGraphRequiredRead): {
	source: string;
	artifact: keyof WorkflowSourceManifestSource["artifacts"];
	path?: string;
	maxChars?: number;
	maxItems?: number;
	count?: number;
} | null {
	if (typeof value === "string") {
		const match = value.match(
			/^([A-Za-z0-9_.-]+)\.(control|analysis|refs|raw)$/,
		);
		if (!match) return null;
		return {
			source: match[1] ?? "",
			artifact: match[2] as keyof WorkflowSourceManifestSource["artifacts"],
		};
	}
	return {
		source: value.source,
		artifact: value.artifact as keyof WorkflowSourceManifestSource["artifacts"],
		...(value.path === undefined ? {} : { path: value.path }),
		...(value.maxChars === undefined ? {} : { maxChars: value.maxChars }),
		...(value.maxItems === undefined ? {} : { maxItems: value.maxItems }),
		...(value.count === undefined ? {} : { count: value.count }),
	};
}

function formatRequiredArtifactRead(value: ArtifactGraphRequiredRead): string {
	return typeof value === "string"
		? value
		: `${value.source}.${value.artifact}`;
}

export async function buildArtifactGraphSourceManifestSources(
	cwd: string,
	run: WorkflowRunRecord,
	contextDependsOn: readonly string[],
	validationSnapshot: ArtifactGraphRuntimeValidationSnapshot,
	projection?: NonNullable<CompiledTask["artifactGraph"]>["sourceProjection"],
	options?: {
		partialLedgerProjection?: boolean;
		perItemProjection?: PerItemLedgerProjection;
	},
): Promise<WorkflowSourceManifestSource[]> {
	const bySpecId = new Map(
		run.tasks.map((sourceTask) => [sourceTask.specId, sourceTask]),
	);
	const sources: WorkflowSourceManifestSource[] = [];
	const usedNames = new Set<string>();
	let foundPerItemSource = false;
	for (const dep of contextDependsOn) {
		const sourceTask = bySpecId.get(dep);
		if (!sourceTask) {
			if (options?.perItemProjection?.itemSourceSpecId === dep) {
				throw new Error(
					`per-item dispatch source ${dep} is missing from the authoritative run task record`,
				);
			}
			continue;
		}
		assertArtifactGraphSourceRuntimeMetadataCurrent(
			run,
			sourceTask,
			validationSnapshot,
		);
		const source = sourceNameForTask(sourceTask, usedNames);
		const status = sourceStatusForTask(sourceTask);
		const perItemProjection =
			options?.perItemProjection?.itemSourceSpecId === sourceTask.specId
				? options.perItemProjection
				: undefined;
		if (perItemProjection) {
			if (sourceTask.taskId !== perItemProjection.itemSourceTaskId) {
				throw new Error(
					`per-item dispatch source ${sourceTask.specId} does not match the persisted source task identity`,
				);
			}
			foundPerItemSource = true;
			const partialProjection = await partialLedgerSourceProjection(
				cwd,
				sourceTask,
				projection,
				perItemProjection,
			);
			const artifacts =
				sourceTask.status === "completed"
					? await artifactRefsForTask(cwd, sourceTask)
					: {};
			sources.push({
				source,
				displayName: sourceTask.displayName,
				taskId: sourceTask.taskId,
				specId: sourceTask.specId,
				stageId: sourceTask.stageId,
				...status,
				controlProjection: partialProjection.value,
				...(partialProjection.truncated
					? { projectionTruncated: true }
					: {}),
				projectionSource: "partial-ledger",
				artifacts,
			});
			continue;
		}
		if (sourceTask.status !== "completed") {
			if (options?.partialLedgerProjection) {
				throw new Error(
					`partial-ledger source ${sourceTask.specId} is missing persisted per-item identity metadata`,
				);
			}
			sources.push({
				source,
				displayName: sourceTask.displayName,
				taskId: sourceTask.taskId,
				specId: sourceTask.specId,
				stageId: sourceTask.stageId,
				...status,
				artifacts: {},
			});
			continue;
		}
		const artifacts = await artifactRefsForTask(cwd, sourceTask);
		if (Object.keys(artifacts).length === 0) continue;
		const control = await readArtifactGraphControl(cwd, sourceTask).catch(
			() => undefined,
		);
		const controlProjection = projectArtifactGraphControl(control, projection);
		sources.push({
			source,
			displayName: sourceTask.displayName,
			taskId: sourceTask.taskId,
			specId: sourceTask.specId,
			stageId: sourceTask.stageId,
			...status,
			digest: controlDigest(control),
			...(controlProjection.value !== undefined
				? { controlProjection: controlProjection.value }
				: {}),
			...(controlProjection.missingPaths.length > 0
				? { projectionMissingPaths: controlProjection.missingPaths }
				: {}),
			...(controlProjection.truncated ? { projectionTruncated: true } : {}),
			artifacts,
		});
		await appendDynamicOutputSources({
			cwd,
			run,
			controllerTask: sourceTask,
			control,
			projection,
			sources,
			usedNames,
			validationSnapshot,
		});
	}
	if (options?.perItemProjection && !foundPerItemSource) {
		throw new Error(
			`per-item dispatch source ${options.perItemProjection.itemSourceSpecId} is absent from preparation dependencies`,
		);
	}
	return sources;
}

async function partialLedgerSourceProjection(
	cwd: string,
	sourceTask: WorkflowTaskRunRecord,
	projection:
		| NonNullable<CompiledTask["artifactGraph"]>["sourceProjection"]
		| undefined,
	identity: PerItemLedgerProjection,
): Promise<{ value: unknown; truncated: boolean }> {
	const include = projection?.include ?? [];
	if (include.length === 0) {
		throw new Error(
			`per-item dispatch source ${sourceTask.specId} has no projection paths to verify`,
		);
	}
	const allowedPaths = sourceTask.artifactGraph?.output.partial?.paths ?? [];
	if (
		allowedPaths.length === 0 ||
		include.some((path) => !allowedPaths.includes(path))
	) {
		throw new Error(
			`per-item dispatch source ${sourceTask.specId} cannot authoritatively serve every projection path`,
		);
	}
	const taskDir = dirname(fromProjectPath(cwd, sourceTask.files.result));
	let ledger = await readWorkflowPartialOutputLedger(taskDir);
	if (!ledger) {
		ledger = await writeWorkflowPartialOutputLedgerFromFile({
			taskDir,
			outputFile: fromProjectPath(cwd, sourceTask.files.output),
			allowedPaths,
		});
	}
	if (!ledger) {
		throw new Error(
			`per-item dispatch source ${sourceTask.specId} has no durable partial-output ledger`,
		);
	}
	const fatal = hasFatalPartialOutputIssue(ledger);
	if (fatal) {
		throw new Error(
			`per-item dispatch source ${sourceTask.specId} has fatal partial-output evidence: ${fatal.message}`,
		);
	}
	const matchingItems = ledger.items.filter(
		(item) =>
			`${sourceTask.specId}:${item.itemRef}` === identity.itemRef &&
			item.itemHash === identity.itemHash &&
			item.itemId === identity.itemIdentity,
	);
	if (matchingItems.length !== 1) {
		throw new Error(
			`per-item dispatch source ${sourceTask.specId} cannot verify the persisted item ref, hash, and identity tuple`,
		);
	}
	const matchingItem = matchingItems[0]!;
	if (!include.includes(matchingItem.path)) {
		throw new Error(
			`per-item dispatch source ${sourceTask.specId} does not project the authoritative item path ${matchingItem.path}`,
		);
	}
	const partialControl = createProjectionContainer();
	for (const path of include) {
		const items = ledger.items.filter((item) => item.path === path);
		if (items.length === 0) {
			throw new Error(
				`per-item dispatch source ${sourceTask.specId} has no durable evidence for projection path ${path}`,
			);
		}
		setProjectedJsonPath(
			partialControl,
			path,
			path === matchingItem.path
				? [matchingItem.item]
				: items.map((item) => item.item),
		);
	}
	const projected = projectArtifactGraphControl(partialControl, projection);
	if (
		projected.value === undefined ||
		projected.missingPaths.length > 0 ||
		!hasProjectionEvidence(projected.value)
	) {
		throw new Error(
			`per-item dispatch source ${sourceTask.specId} produced missing or empty projection evidence`,
		);
	}
	return { value: projected.value, truncated: projected.truncated };
}

function hasProjectionEvidence(value: unknown): boolean {
	if (typeof value === "string") return value.trim() !== "";
	if (Array.isArray(value)) return value.length > 0;
	if (value && typeof value === "object") return Object.keys(value).length > 0;
	return value !== undefined && value !== null;
}

export async function appendDynamicOutputSources(input: {
	cwd: string;
	run: WorkflowRunRecord;
	controllerTask: WorkflowTaskRunRecord;
	control: unknown;
	projection?: NonNullable<CompiledTask["artifactGraph"]>["sourceProjection"];
	sources: WorkflowSourceManifestSource[];
	usedNames: Set<string>;
	validationSnapshot: ArtifactGraphRuntimeValidationSnapshot;
}): Promise<void> {
	if (input.controllerTask.kind !== "dynamic") return;
	const outputTaskIds = dynamicOutputTaskSpecIds(input.control);
	if (outputTaskIds.length === 0) return;
	const bySpecId = new Map(
		input.run.tasks.map((sourceTask) => [sourceTask.specId, sourceTask]),
	);
	let outputIndex = 0;
	for (const outputTaskId of outputTaskIds) {
		const outputTask = bySpecId.get(outputTaskId);
		if (!outputTask) continue;
		assertArtifactGraphSourceRuntimeMetadataCurrent(
			input.run,
			outputTask,
			input.validationSnapshot,
		);
		const source = dynamicOutputSourceName(
			input.controllerTask,
			outputIndex,
			input.usedNames,
		);
		outputIndex += 1;
		const status = sourceStatusForTask(outputTask);
		if (outputTask.status !== "completed") {
			input.sources.push({
				source,
				displayName: outputTask.displayName,
				taskId: outputTask.taskId,
				specId: outputTask.specId,
				stageId: outputTask.stageId,
				...status,
				artifacts: {},
			});
			continue;
		}
		const artifacts = await artifactRefsForTask(input.cwd, outputTask);
		if (Object.keys(artifacts).length === 0) continue;
		const control = await readArtifactGraphControl(input.cwd, outputTask).catch(
			() => undefined,
		);
		const controlProjection = projectArtifactGraphControl(
			control,
			input.projection,
		);
		input.sources.push({
			source,
			displayName: outputTask.displayName,
			taskId: outputTask.taskId,
			specId: outputTask.specId,
			stageId: outputTask.stageId,
			...status,
			digest: controlDigest(control),
			...(controlProjection.value !== undefined
				? { controlProjection: controlProjection.value }
				: {}),
			...(controlProjection.missingPaths.length > 0
				? { projectionMissingPaths: controlProjection.missingPaths }
				: {}),
			...(controlProjection.truncated ? { projectionTruncated: true } : {}),
			artifacts,
		});
	}
}

export function dynamicOutputTaskSpecIds(control: unknown): string[] {
	if (!control || typeof control !== "object" || Array.isArray(control)) {
		return [];
	}
	const record = control as Record<string, unknown>;
	return uniqueStrings([
		...stringArrayValue(record.outputTasks),
		...stringArrayValue(record.outputTaskIds),
		...stringArrayValue(record.exportedTasks),
	]);
}

function stringArrayValue(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

export function dynamicOutputSourceName(
	controllerTask: WorkflowTaskRunRecord,
	index: number,
	usedNames: Set<string>,
): string {
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

export async function artifactRefsForTask(
	cwd: string,
	task: WorkflowTaskRunRecord,
): Promise<WorkflowSourceManifestSource["artifacts"]> {
	const taskDir = dirname(fromProjectPath(cwd, task.files.result));
	const candidates = {
		control: {
			path: join(taskDir, "control.json"),
			mediaType: "application/json",
		},
		analysis: {
			path: join(taskDir, "analysis.md"),
			mediaType: "text/markdown",
		},
		refs: { path: join(taskDir, "refs.json"), mediaType: "application/json" },
		raw: { path: join(taskDir, "raw.md"), mediaType: "text/markdown" },
	} as const;
	const artifacts: WorkflowSourceManifestSource["artifacts"] = {};
	for (const [kind, ref] of Object.entries(candidates)) {
		try {
			if ((await stat(ref.path)).isFile()) (artifacts as any)[kind] = ref;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return artifacts;
}

export function controlDigest(control: unknown): string | undefined {
	return control && typeof (control as any).digest === "string"
		? (control as any).digest
		: undefined;
}

export function projectArtifactGraphControl(
	control: unknown,
	projection:
		| NonNullable<CompiledTask["artifactGraph"]>["sourceProjection"]
		| undefined,
): { value?: unknown; missingPaths: string[]; truncated: boolean } {
	if (!projection?.include || projection.include.length === 0) {
		return { missingPaths: [], truncated: false };
	}
	const projected = createProjectionContainer();
	const missingPaths: string[] = [];
	for (const path of projection.include) {
		const resolved = readSimpleJsonPath(control, path);
		if (resolved === undefined) {
			missingPaths.push(path);
			continue;
		}
		setProjectedJsonPath(projected, path, resolved);
	}
	const value = Object.keys(projected).length > 0 ? projected : undefined;
	return capArtifactGraphProjection(value, missingPaths, projection.maxChars);
}

export function capArtifactGraphProjection(
	value: unknown,
	missingPaths: string[],
	maxChars: number | undefined,
): { value?: unknown; missingPaths: string[]; truncated: boolean } {
	if (value === undefined || maxChars === undefined) {
		return { value, missingPaths, truncated: false };
	}
	const serialized = JSON.stringify(value);
	if (serialized.length <= maxChars) {
		return { value, missingPaths, truncated: false };
	}
	return {
		value: {
			truncated: true,
			originalChars: serialized.length,
			preview: serialized.slice(0, Math.max(0, maxChars - 1)) + "…",
		},
		missingPaths,
		truncated: true,
	};
}

export function setProjectedJsonPath(
	target: Record<string, unknown>,
	path: string,
	value: unknown,
): void {
	const tokens = projectionContainerPathTokens(path);
	if (!tokens || tokens.length === 0) return;
	let current = target;
	for (const [index, token] of tokens.entries()) {
		if (index === tokens.length - 1) {
			current[token] = value;
			return;
		}
		const existing = Object.hasOwn(current, token) ? current[token] : undefined;
		if (!isProjectionContainer(existing)) {
			current[token] = createProjectionContainer();
		}
		current = current[token] as Record<string, unknown>;
	}
}

const PROJECTION_PATH_TOKEN_PATTERN =
	/^(?:[A-Za-z0-9_-]+)?(?:\[(?:\*|\d+|\d*:\d*)\])*$/u;
const UNSAFE_JSON_PATH_PARTS = new Set([
	"__proto__",
	"prototype",
	"constructor",
]);

function createProjectionContainer(): Record<string, unknown> {
	return Object.create(null) as Record<string, unknown>;
}

function projectionContainerPathTokens(path: string): string[] | undefined {
	if (!isSimpleJsonPath(path)) return undefined;
	if (path === "$") return [];
	const body = path.slice(1).replace(/^\./u, "");
	const tokens = body.split(".");
	if (tokens.length === 0) return undefined;
	for (const token of tokens) {
		if (!token || !PROJECTION_PATH_TOKEN_PATTERN.test(token)) return undefined;
		const key = /^[A-Za-z0-9_-]+/u.exec(token)?.[0];
		if (key && UNSAFE_JSON_PATH_PARTS.has(key)) return undefined;
	}
	return tokens;
}

function isProjectionContainer(
	value: unknown,
): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	if (value === Object.prototype) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === null || prototype === Object.prototype;
}

export function sourceNameForTask(
	task: WorkflowTaskRunRecord,
	usedNames: Set<string>,
): string {
	const preferred = task.dynamicGenerated
		? task.specId
		: (task.stageId ?? task.specId);
	if (!usedNames.has(preferred)) {
		usedNames.add(preferred);
		return preferred;
	}
	usedNames.add(task.specId);
	return task.specId;
}

type ArtifactGraphManifestSourceWithRuntimeMetadata =
	WorkflowSourceManifestSource & {
		generation?: number;
		sourceGeneration?: number;
		dispatchMap?: ArtifactGraphDispatchMap;
	};

function artifactGraphManifestSourceRuntimeMetadata(
	source: WorkflowSourceManifestSource,
): {
	generation?: number;
	sourceGeneration?: number;
	dispatchMap?: ArtifactGraphDispatchMap;
} {
	const runtimeSource =
		source as ArtifactGraphManifestSourceWithRuntimeMetadata;
	return {
		...(runtimeSource.generation === undefined
			? {}
			: { generation: runtimeSource.generation }),
		...(runtimeSource.sourceGeneration === undefined
			? {}
			: { sourceGeneration: runtimeSource.sourceGeneration }),
		...(runtimeSource.dispatchMap === undefined
			? {}
			: { dispatchMap: runtimeSource.dispatchMap }),
	};
}

export function formatArtifactGraphSourceContext(
	sources: readonly WorkflowSourceManifestSource[],
	requiredReads: readonly ArtifactGraphRequiredRead[],
	requiredReadPolicy: readonly RequiredWorkflowArtifactReadPolicy[] = [],
): string {
	const requiredReadLines = [
		...requiredReads.map((read) => `- ${formatRequiredArtifactRead(read)}`),
		...requiredReadPolicy.map(
			(policy) =>
				`- ${policy.source}.${policy.artifact}${policy.path ? ` path=${policy.path}` : ""}`,
		),
	];
	return [
		"# Workflow Artifact Inputs",
		"Use workflow_artifact to list/read upstream workflow artifacts. Inline controlProjection fields are authoritative for the projected data they contain; use artifact reads for declared requiredReads, missing fields, or debug detail.",
		'Projected reads must include a JSON path when using maxItems or maxChars, for example {"action":"read","source":"plan","artifact":"control","path":"$.factSlots","maxItems":8,"maxChars":2000}. For a whole artifact read, omit maxItems/maxChars.',
		requiredReadLines.length > 0
			? ["Required reads before final output:", ...requiredReadLines].join("\n")
			: "No hard requiredReads are declared for this stage.",
		"Available sources:",
		stringifyPromptJson(
			sources.map((source) => ({
				source: source.source,
				taskId: source.taskId,
				specId: source.specId,
				stageId: source.stageId,
				status: source.status,
				statusDetail: source.statusDetail,
				lastMessage: source.lastMessage,
				errorType: source.errorType,
				digest: source.digest,
				controlProjection: source.controlProjection,
				projectionMissingPaths: source.projectionMissingPaths,
				projectionTruncated: source.projectionTruncated,
				projectionSource: source.projectionSource,
				...artifactGraphManifestSourceRuntimeMetadata(source),
				availableArtifacts: Object.keys(source.artifacts),
			})),
		),
	].join("\n\n");
}
function uniqueStrings(values: readonly string[]): string[] {
	return compactStrings(values, { trim: false, dropWhitespaceOnly: true });
}

export async function readArtifactGraphControl(
	cwd: string,
	task: WorkflowTaskRunRecord,
): Promise<unknown> {
	const taskDir = dirname(fromProjectPath(cwd, task.files.result));
	return await readJson(join(taskDir, "control.json"));
}

export function workflowArtifactExtensionImportPath(): string {
	const current = fileURLToPath(import.meta.url);
	return fileURLToPath(
		new URL(
			`./workflow-artifact-extension${extname(current)}`,
			import.meta.url,
		),
	);
}

export async function prepareArtifactGraphRetryTask(
	cwd: string,
	task: WorkflowTaskRunRecord,
	preparedTask: CompiledWorkflow["tasks"][number],
): Promise<CompiledWorkflow["tasks"][number]> {
	const invalidAttempt = task.outputRetry?.attempts
		? `${dirname(fromProjectPath(cwd, task.files.result))}/raw.invalid-attempt-${task.outputRetry.attempts}.md`
		: fromProjectPath(cwd, task.files.output);
	const previousOutput = await readFile(invalidAttempt, "utf8").catch(() => "");
	const issueText = task.outputRetry?.artifacts?.length
		? [
				"Your previous attempt did not read required workflow artifacts:",
				...task.outputRetry.artifacts.map((artifact) => `- ${artifact}`),
				"Use workflow_artifact before producing the final answer.",
			].join("\n")
		: (task.outputRetry?.message ?? "workflow output was invalid");

	const readRetryHint =
		preparedTask.artifactGraph?.artifactAccess === "none"
			? undefined
			: "If the retry is for missing required workflow_artifact reads, use workflow_artifact before the final answer. Prefer projected reads with path/maxItems/maxChars when only a JSON slice is needed.";
	const retrySections = [
		preparedTask.compiledPrompt,
		"# Workflow Output Retry Instructions",
		issueText,
		"Return the final answer again using exactly <control>, <analysis>, and <refs> sections. The first byte must be '<' in <control>; do not include apologies, status text, Markdown headings, or prose outside the required sections.",
		readRetryHint,
		"# Previous Attempt Preview",
	].filter(Boolean) as string[];
	const prefix = retrySections.join("\n\n");
	const previewLimit = remainingPromptChars(
		preparedTask,
		`${prefix}\n\n`,
		"(empty or unavailable)",
	);
	const preview =
		(preparedTask.artifactGraph?.inputPolicy?.maxCompiledPromptChars ===
		undefined
			? previousOutput.slice(0, 4000)
			: truncatePromptToChars(previousOutput, previewLimit)) ||
		"(empty or unavailable)";
	const retryTask = {
		...preparedTask,
		cwd: task.cwd,
		compiledPrompt: [...retrySections, preview].join("\n\n"),
	};
	assertFinalCompiledPromptWithinCap(retryTask);
	return retryTask;
}

function remainingPromptChars(
	task: CompiledTask,
	prefix: string,
	fallback: string,
): number {
	const maxChars = task.artifactGraph?.inputPolicy?.maxCompiledPromptChars;
	if (maxChars === undefined) return 4000;
	if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
		throw new Error(
			`task ${task.id} has invalid maxCompiledPromptChars=${String(maxChars)}`,
		);
	}
	const mandatoryChars =
		Array.from(prefix).length + Array.from(fallback).length;
	if (mandatoryChars > maxChars) {
		throw new Error(
			`task ${task.id} retry instructions exceed maxCompiledPromptChars=${maxChars} before any previous-output preview`,
		);
	}
	return Math.max(0, maxChars - Array.from(prefix).length);
}

function truncatePromptToChars(value: string, maxChars: number): string {
	return Array.from(value).slice(0, Math.max(0, maxChars)).join("");
}
