import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
import type { JsonSchema } from "./json-schema.js";
import {
	buildRunSourceContext,
	readOutputText,
	sourceContextOptions,
	workflowBundleSpecPath,
} from "./workflow-source-context-runtime.js";
import { readSimpleJsonPath } from "./workflow-runtime.js";
import {
	fromProjectPath,
	readJson,
	setTaskTerminal,
	workflowRunDir,
	writeJsonAtomic,
	writeRunRecord,
} from "./store.js";
import type {
	CompiledTask,
	CompiledWorkflow,
	WorkflowRunRecord,
	WorkflowTaskRunRecord,
} from "./types.js";

export async function executeSupportTask(
	cwd: string,
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	compiledTask: CompiledWorkflow["tasks"][number],
): Promise<boolean> {
	if (!compiledTask.support) {
		throw new Error("support metadata is missing");
	}
	task.status = "running";
	task.statusDetail = "running";
	task.startedAt = task.startedAt ?? new Date().toISOString();
	await writeRunRecord(cwd, run);

	const sources = compiledTask.artifactGraph?.enabled
		? await readArtifactGraphSupportSources(
				cwd,
				run,
				compiledTask.dependsOn ?? [],
			)
		: await readSupportSources(cwd, run, compiledTask.dependsOn ?? []);
	const helperSpecPath = await workflowBundleSpecPath(cwd, run);
	const helper = await loadWorkflowHelper(
		compiledTask.support.uses,
		helperSpecPath,
	);
	const structuredOutput = await helper({
		sources,
		options: compiledTask.support.options,
		context: {
			specPath: helperSpecPath,
			originalSpecPath: run.specPath,
			stageId: task.stageId,
			taskId: task.taskId,
			runId: run.runId,
			cwd,
			...(compiledTask.artifactGraph?.enabled
				? {
						sourceStatuses: buildArtifactGraphSupportSourceStatuses(
							run,
							compiledTask.dependsOn ?? [],
						),
					}
				: {}),
		},
	});

	if (compiledTask.artifactGraph?.enabled) {
		await writeArtifactGraphSupportResult(cwd, task, structuredOutput);
		setTaskTerminal(task, "completed", "support_completed", {
			lastMessage: "support completed",
		});
		await writeRunRecord(cwd, run);
		return true;
	}

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
): Promise<Record<string, unknown>> {
	const sources: Record<string, unknown> = {};
	const sourceNames = supportSourceNamesForDependencies(run, dependsOn);
	for (const specId of dependsOn) {
		const source = run.tasks.find((candidate) => candidate.specId === specId);
		if (!source || source.status !== "completed") continue;
		sources[sourceNames.get(source.specId) ?? source.specId] =
			await readArtifactGraphControl(cwd, source);
	}
	return sources;
}

function buildArtifactGraphSupportSourceStatuses(
	run: WorkflowRunRecord,
	dependsOn: readonly string[],
): Array<Record<string, unknown>> {
	const statuses: Array<Record<string, unknown>> = [];
	const sourceNames = supportSourceNamesForDependencies(run, dependsOn);
	for (const specId of dependsOn) {
		const source = run.tasks.find((candidate) => candidate.specId === specId);
		if (!source) continue;
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
} {
	const lastMessage = sanitizeSourceLastMessage(task.lastMessage);
	return {
		status: task.status,
		...(task.statusDetail ? { statusDetail: task.statusDetail } : {}),
		...(lastMessage ? { lastMessage } : {}),
		...(task.status !== "completed"
			? { errorType: sourceErrorType(task) }
			: {}),
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

export async function writeArtifactGraphSupportResult(
	cwd: string,
	task: WorkflowTaskRunRecord,
	structuredOutput: unknown,
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
): Promise<CompiledWorkflow["tasks"][number]> {
	const compiledTask = compiledFlow.tasks[index]!;
	const task = run.tasks[index]!;
	const contextDependsOn =
		compiledTask.contextDependsOn ?? compiledTask.dependsOn ?? [];
	if (compiledTask.artifactGraph?.enabled) {
		return await prepareArtifactGraphTask(
			cwd,
			run,
			compiledTask,
			task,
			contextDependsOn,
		);
	}
	if (contextDependsOn.length === 0) return compiledTask;

	const bySpecId = new Map(
		run.tasks.map((sourceTask) => [sourceTask.specId, sourceTask]),
	);
	const sourceTasks = contextDependsOn
		.map((dep) => bySpecId.get(dep))
		.filter((sourceTask): sourceTask is WorkflowTaskRunRecord =>
			Boolean(sourceTask),
		);
	const missing = contextDependsOn.filter((dep) => !bySpecId.has(dep));
	const context = await buildRunSourceContext(
		cwd,
		run,
		sourceTasks,
		sourceContextOptions(compiledTask),
	);

	return {
		...compiledTask,
		cwd: task.cwd,
		compiledPrompt: [
			compiledTask.compiledPrompt,
			"# Source Stage Context",
			"Use this deterministic source context packet. Prefer structuredOutput over outputPreview. Do not assume dependencies beyond this explicit packet.",
			stringifyPromptJson({ ...context, missingDependencies: missing }),
		].join("\n\n"),
	};
}

async function prepareArtifactGraphTask(
	cwd: string,
	run: WorkflowRunRecord,
	compiledTask: CompiledTask,
	task: WorkflowTaskRunRecord,
	contextDependsOn: readonly string[],
): Promise<CompiledTask> {
	if (compiledTask.artifactGraph?.artifactAccess === "none") {
		return { ...compiledTask, cwd: task.cwd };
	}

	const taskDir = dirname(fromProjectPath(cwd, task.files.result));
	const manifestPath = join(taskDir, "source-manifest.json");
	const ledgerPath = join(taskDir, "read-ledger.jsonl");
	const wrapperPath = join(taskDir, "workflow-artifact-extension.ts");
	const sources = await buildArtifactGraphSourceManifestSources(
		cwd,
		run,
		contextDependsOn,
		compiledTask.artifactGraph?.sourceProjection,
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
	const requiredReadContext = formatRequiredArtifactReadReferences({
		sources,
		requiredReads,
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
			formatArtifactGraphSourceContext(sources, requiredReads),
			requiredReadContext || undefined,
		]
			.filter(Boolean)
			.join("\n\n"),
	};
}

function formatRequiredArtifactReadReferences(options: {
	sources: WorkflowSourceManifestSource[];
	requiredReads: readonly string[];
}): string {
	if (options.requiredReads.length === 0) return "";
	const sections = options.requiredReads.map((required) => {
		const parsed = parseRequiredArtifactRead(required);
		if (!parsed) {
			return `- ${required}: invalid required read name; expected source.artifact.`;
		}
		const source = options.sources.find(
			(candidate) => candidate.source === parsed.source,
		);
		const artifact = source?.artifacts?.[parsed.artifact];
		if (!source || !artifact?.path) {
			return `- ${required}: required artifact is not available in the source manifest.`;
		}
		return `- ${required}: available via workflow_artifact read with source=${JSON.stringify(parsed.source)}, artifact=${JSON.stringify(parsed.artifact)}.`;
	});
	return [
		"# Required Workflow Artifact Reads",
		"The workflow runtime does not preload requiredReads into this prompt. To satisfy the required-read gate, call workflow_artifact for each listed source/artifact before producing the final answer. The read ledger, not this prompt, proves access.",
		...sections,
	].join("\n");
}

function parseRequiredArtifactRead(value: string): {
	source: string;
	artifact: keyof WorkflowSourceManifestSource["artifacts"];
} | null {
	const match = String(value).match(
		/^([A-Za-z0-9_.-]+)\.(control|analysis|refs|raw)$/,
	);
	if (!match) return null;
	return {
		source: match[1] ?? "",
		artifact: match[2] as keyof WorkflowSourceManifestSource["artifacts"],
	};
}

export async function buildArtifactGraphSourceManifestSources(
	cwd: string,
	run: WorkflowRunRecord,
	contextDependsOn: readonly string[],
	projection?: NonNullable<CompiledTask["artifactGraph"]>["sourceProjection"],
): Promise<WorkflowSourceManifestSource[]> {
	const bySpecId = new Map(
		run.tasks.map((sourceTask) => [sourceTask.specId, sourceTask]),
	);
	const sources: WorkflowSourceManifestSource[] = [];
	const usedNames = new Set<string>();
	for (const dep of contextDependsOn) {
		const sourceTask = bySpecId.get(dep);
		if (!sourceTask) continue;
		const source = sourceNameForTask(sourceTask, usedNames);
		const status = sourceStatusForTask(sourceTask);
		if (sourceTask.status !== "completed") {
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
		});
	}
	return sources;
}

export async function appendDynamicOutputSources(input: {
	cwd: string;
	run: WorkflowRunRecord;
	controllerTask: WorkflowTaskRunRecord;
	control: unknown;
	projection?: NonNullable<CompiledTask["artifactGraph"]>["sourceProjection"];
	sources: WorkflowSourceManifestSource[];
	usedNames: Set<string>;
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
	const projected: Record<string, unknown> = {};
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
	const tokens = path
		.replace(/^\$\.?/, "")
		.split(".")
		.map((token) => token.trim())
		.filter(Boolean);
	let current = target;
	for (const [index, token] of tokens.entries()) {
		if (index === tokens.length - 1) {
			current[token] = value;
			return;
		}
		const existing = current[token];
		if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
			current[token] = {};
		}
		current = current[token] as Record<string, unknown>;
	}
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

export function formatArtifactGraphSourceContext(
	sources: readonly WorkflowSourceManifestSource[],
	requiredReads: readonly string[],
): string {
	return [
		"# Workflow Artifact Inputs",
		"Use workflow_artifact to list/read upstream workflow artifacts. Inline controlProjection fields are authoritative for the projected data they contain; use artifact reads for declared requiredReads, missing fields, or debug detail.",
		'Projected reads must include a JSON path when using maxItems or maxChars, for example {"action":"read","source":"plan","artifact":"control","path":"$.factSlots","maxItems":8,"maxChars":2000}. For a whole artifact read, omit maxItems/maxChars.',
		requiredReads.length > 0
			? [
					"Required reads before final output:",
					...requiredReads.map((read) => `- ${read}`),
				].join("\n")
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

	return {
		...preparedTask,
		cwd: task.cwd,
		compiledPrompt: [
			preparedTask.compiledPrompt,
			"# Workflow Output Retry Instructions",
			issueText,
			"Return the final answer again using exactly <control>, <analysis>, and <refs> sections. The first byte must be '<' in <control>; do not include apologies, status text, Markdown headings, or prose outside the required sections.",
			"If the retry is for missing required workflow_artifact reads, use workflow_artifact before the final answer. Prefer projected reads with path/maxItems/maxChars when only a JSON slice is needed.",
			"# Previous Attempt Preview",
			previousOutput.slice(0, 4000) || "(empty or unavailable)",
		].join("\n\n"),
	};
}
