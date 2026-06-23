import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { loadAgentByName } from "./agents.js";
import { DYNAMIC_OUTPUT_PROFILES } from "./dynamic-profiles.js";
import {
	classifyToolCapability,
	effectiveToolClassification,
	providersForSelectedTools,
	resolveToolSelection,
	TOOL_NAME_PATTERN,
	toolNameForSpec,
	type ToolSelection,
} from "./tool-metadata.js";
import {
	type AgentDefinition,
	type ApprovalMode,
	type ArtifactGraphStageSpec,
	type ArtifactGraphWorkflowSpec,
	type CompiledTask,
	type CompiledTaskSafety,
	type CompiledToolProvider,
	WorkflowValidationError,
	type PermissionPreview,
	WORKFLOW_RUN_TYPE,
	type TaskCapability,
	type ThinkingLevel,
	type ValidationIssue,
	type WorkflowToolObjectSpec,
	type WorkflowToolSpec,
	type WorktreePolicy,
} from "./types.js";

const DELEGATION_TOOLS = new Set([
	"skill_test_subagent",
	"workflow",
	"/workflow",
]);
const TOOL_CLASSIFICATION_VALUES = new Set([
	"read-only",
	"write-capable",
	"mutation-capable",
]);
const DEFAULT_MAX_RUNTIME_MS = 30 * 60 * 1000;
const DEFAULT_MAX_CONCURRENCY = 16;
const DEFAULT_DYNAMIC_MAX_AGENTS = 1000;
const DEFAULT_DYNAMIC_MAX_CONCURRENCY = 16;
const DEFAULT_DYNAMIC_MAX_RUNTIME_MS = 14_400_000;
const DEFAULT_DYNAMIC_MAX_NESTED_WORKFLOW_DEPTH = 3;
const DEFAULT_DYNAMIC_MAX_GRAPH_MUTATIONS = 5000;
const DEFAULT_DYNAMIC_MAX_HELPER_RUNS = 1000;
const DEFAULT_DYNAMIC_DECISION_LOOP_MAX_ROUNDS = 4;
const DEFAULT_DYNAMIC_DECISION_LOOP_MAX_ACTIONS = 6;
const DEFAULT_DYNAMIC_DECISION_LOOP_MAX_STALLS = 3;

interface CompileOptions {
	cwd: string;
	specPath?: string;
}

interface ArtifactGraphCompilePlanBuildResult {
	plan: any;
	stageMetadata: Map<string, NonNullable<CompiledTask["artifactGraph"]>>;
}

function buildArtifactGraphCompilePlan(
	spec: ArtifactGraphWorkflowSpec,
	options: CompileOptions,
): ArtifactGraphCompilePlanBuildResult {
	const stageMetadata = new Map<
		string,
		NonNullable<CompiledTask["artifactGraph"]>
	>();
	const specDir = options.specPath
		? dirname(resolve(options.cwd, options.specPath))
		: options.cwd;
	const defaults =
		spec.artifactGraph.maxConcurrency === undefined
			? spec.defaults
			: {
					...(spec.defaults ?? {}),
					maxConcurrency: spec.artifactGraph.maxConcurrency,
				};
	return {
		plan: {
			schemaVersion: spec.schemaVersion,
			name: spec.name,
			description: spec.description,
			input: spec.input,
			roles: spec.roles,
			defaults,
			stages: lowerArtifactGraphStages(spec.artifactGraph.stages, {
				metadata: stageMetadata,
				specDir,
			}),
		},
		stageMetadata,
	};
}

function lowerArtifactGraphStages(
	stages: readonly ArtifactGraphStageSpec[],
	context: {
		metadata: Map<string, NonNullable<CompiledTask["artifactGraph"]>>;
		specDir: string;
		namespace?: string;
	},
): any[] {
	return stages.map((stage) => lowerArtifactGraphStage(stage, context));
}

function lowerArtifactGraphStage(
	stage: ArtifactGraphStageSpec,
	context: {
		metadata: Map<string, NonNullable<CompiledTask["artifactGraph"]>>;
		specDir: string;
		namespace?: string;
	},
): any {
	const stageId = context.namespace
		? `${context.namespace}.${stage.id}`
		: stage.id;
	const lowered: any = {
		...stage,
		from: lowerArtifactGraphFrom(stage.from),
		prompt: lowerArtifactGraphPrompt(stage),
		artifactGraphOutput: stage.output,
	};
	delete lowered.inputPolicy;
	delete lowered.sourceProjection;
	delete lowered.artifactGraph;
	if (stage.output !== undefined) delete lowered.output;
	if (stage.stages) {
		lowered.stages = lowerArtifactGraphStages(stage.stages, {
			metadata: context.metadata,
			specDir: context.specDir,
			namespace: stageId,
		});
	}
	if (stage.each && typeof stage.each === "object") {
		lowered.each = {
			...stage.each,
			prompt: appendWorkflowOutputInstructions(
				String((stage.each as any).prompt ?? stage.prompt ?? ""),
				stage,
			),
		};
	}
	if (stage.onExhausted) {
		lowered.onExhausted = lowerArtifactGraphStage(stage.onExhausted, {
			metadata: context.metadata,
			specDir: context.specDir,
			namespace: stageId,
		});
	}
	if (runtimeStageKindFor(stage) !== "dag") {
		context.metadata.set(
			stageId,
			artifactGraphTaskMetadata(stage, context.specDir),
		);
	}
	return lowered;
}

function lowerArtifactGraphFrom(from: ArtifactGraphStageSpec["from"]): unknown {
	if (
		from &&
		typeof from === "object" &&
		!Array.isArray(from) &&
		typeof from.source === "string"
	) {
		return { stage: from.source, path: from.path };
	}
	return from;
}

function lowerArtifactGraphPrompt(
	stage: ArtifactGraphStageSpec,
): string | undefined {
	if (stage.type === "dag" || isSupportStage(stage)) return stage.prompt;
	return appendWorkflowOutputInstructions(stage.prompt ?? "", stage);
}

function appendWorkflowOutputInstructions(
	prompt: string,
	stage: ArtifactGraphStageSpec,
): string {
	const controlSchema = stage.output?.controlSchema;
	return [
		prompt,
		"# Workflow Output Protocol",
		"Return your final answer exactly as these three sections, in this order, with no prose outside the tags:",
		"<control>{...}</control>",
		"<analysis>...</analysis>",
		"<refs>[]</refs>",
		"The <control> section must be valid JSON object data for the workflow control plane.",
		"The control object must include a non-empty string `schema` and a concise non-empty string `digest`.",
		controlSchema
			? `Use workflow-local control schema reference: ${controlSchema}`
			: "Use schema `stage-control-v1` unless the workflow asks for a more specific control schema.",
		"Put detailed prose, reasoning, and evidence discussion in <analysis> only.",
		"Put structured evidence pointers in <refs> as a JSON array; use [] if none.",
	]
		.filter(Boolean)
		.join("\n\n");
}

function artifactGraphTaskMetadata(
	stage: ArtifactGraphStageSpec,
	specDir: string,
): NonNullable<CompiledTask["artifactGraph"]> {
	const controlSchema = stage.output?.controlSchema;
	return {
		enabled: true,
		output: {
			analysisRequired: stage.output?.analysis?.required ?? true,
			refsRequired: stage.output?.refs?.required ?? true,
			refsMinItems: stage.output?.refs?.minItems,
			controlSchema,
			controlSchemaPath: controlSchema
				? resolve(specDir, controlSchema)
				: undefined,
			maxDigestChars: stage.output?.maxDigestChars,
		},
		requiredReads: stage.inputPolicy?.requiredReads ?? [],
		sourceProjection: stage.sourceProjection,
	};
}

function annotateArtifactGraphCompiledWorkflow(
	compiled: any,
	metadata: ReadonlyMap<string, NonNullable<CompiledTask["artifactGraph"]>>,
): void {
	compiled.artifactGraph = { enabled: true };
	for (const task of compiled.tasks ?? []) {
		annotateArtifactGraphTask(task, metadata);
	}
	for (const stage of compiled.stages ?? []) {
		if (stage?.type !== "loop" || typeof stage.id !== "string") continue;
		for (const template of stage.childTemplates ?? []) {
			const stageId = taskStageId(template);
			annotateArtifactGraphTask(
				template,
				metadata,
				stageId ? [`${stage.id}.${stageId}`] : [],
			);
		}
		const exhaustedTemplate = stage.onExhausted?.template;
		if (exhaustedTemplate) {
			const stageId = taskStageId(exhaustedTemplate);
			annotateArtifactGraphTask(
				exhaustedTemplate,
				metadata,
				stageId ? [`${stage.id}.${stageId}`] : [],
			);
		}
	}
}

function annotateArtifactGraphTask(
	task: any,
	metadata: ReadonlyMap<string, NonNullable<CompiledTask["artifactGraph"]>>,
	aliases: readonly string[] = [],
): void {
	const ids = [...aliases];
	const stageId = taskStageId(task);
	if (stageId) ids.push(stageId);
	for (const id of ids) {
		const graph = metadata.get(id);
		if (!graph) continue;
		task.artifactGraph = graph;
		return;
	}
}

function taskStageId(task: any): string | undefined {
	return typeof task?.stageId === "string"
		? task.stageId
		: typeof task?.id === "string"
			? task.id
			: undefined;
}

function validateAgentRuntime(
	agent: AgentDefinition,
	issues: ValidationIssue[],
	path: string,
): void {
	if (agent.maxSubagentDepth > 0) {
		issues.push({
			path,
			message: `agent ${agent.displayName} declares maxSubagentDepth > 0, which is invalid in MVP`,
		});
	}

	validateDelegationBoundary(agent.tools, issues, path);
}

function validateToolSubset(
	requestedTools: string[] | undefined,
	agent: AgentDefinition,
	issues: ValidationIssue[],
	path: string,
): void {
	if (!requestedTools) return;
	if (!agent.tools) {
		issues.push({
			path,
			message: `agent ${agent.displayName} does not declare a tools authority ceiling`,
		});
		return;
	}

	const allowed = new Set(agent.tools);
	for (const tool of requestedTools) {
		if (!allowed.has(tool)) {
			issues.push({
				path,
				message: `tool "${tool}" expands agent ${agent.displayName}; allowed tools: ${agent.tools.join(", ")}`,
			});
		}
	}
}

function validateToolSpecs(
	tools: WorkflowToolSpec[] | undefined,
	issues: ValidationIssue[],
	path: string,
): void {
	if (tools === undefined) return;
	if (!Array.isArray(tools)) {
		issues.push({ path, message: "must be an array" });
		return;
	}

	const seen = new Set<string>();
	for (const [index, tool] of tools.entries()) {
		const itemPath = `${path}[${index}]`;
		const name = toolNameForSpec(tool);
		if (name === undefined) {
			issues.push({
				path: itemPath,
				message: "must be a tool name string or object with a name",
			});
			continue;
		}
		validateToolName(
			name,
			typeof tool === "string" ? itemPath : `${itemPath}.name`,
			issues,
		);
		if (seen.has(name))
			issues.push({ path: itemPath, message: `duplicate value "${name}"` });
		seen.add(name);

		if (typeof tool !== "string")
			validateToolObjectMetadata(tool, itemPath, issues);
	}
}

function validateToolObjectMetadata(
	tool: WorkflowToolObjectSpec,
	path: string,
	issues: ValidationIssue[],
): void {
	if (tool.extensions !== undefined)
		validateStringArrayValue(tool.extensions, `${path}.extensions`, issues, {
			validateToolNames: false,
		});
	if (
		tool.classification !== undefined &&
		!TOOL_CLASSIFICATION_VALUES.has(tool.classification)
	) {
		issues.push({
			path: `${path}.classification`,
			message: "must be one of: read-only, write-capable, mutation-capable",
		});
	}
	if (tool.optional !== undefined && typeof tool.optional !== "boolean") {
		issues.push({ path: `${path}.optional`, message: "must be a boolean" });
	}
	if (tool.fallbackTools !== undefined)
		validateStringArrayValue(
			tool.fallbackTools,
			`${path}.fallbackTools`,
			issues,
			{ validateToolNames: true },
		);
}

function validateStringArrayValue(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
	options: { validateToolNames: boolean },
): void {
	if (!Array.isArray(value)) {
		issues.push({ path, message: "must be an array" });
		return;
	}

	const seen = new Set<string>();
	for (const [index, item] of value.entries()) {
		const itemPath = `${path}[${index}]`;
		if (typeof item !== "string" || item.trim() === "") {
			issues.push({ path: itemPath, message: "must be a non-empty string" });
			continue;
		}
		if (options.validateToolNames) validateToolName(item, itemPath, issues);
		if (seen.has(item))
			issues.push({ path: itemPath, message: `duplicate value "${item}"` });
		seen.add(item);
	}
}

function validateToolName(
	tool: string,
	path: string,
	issues: ValidationIssue[],
): void {
	if (tool.trim() === "") {
		issues.push({ path, message: "must be a non-empty string" });
		return;
	}
	if (!TOOL_NAME_PATTERN.test(tool))
		issues.push({ path, message: `invalid tool name "${tool}"` });
}

function filterToolSelection(selection: ToolSelection): ToolSelection {
	const tools = filterDelegationTools(selection.tools);
	return {
		tools,
		toolProviders: providersForSelectedTools(
			tools,
			new Map(Object.entries(selection.toolProviders ?? {})),
		),
	};
}

function validateDelegationBoundary(
	tools: string[] | undefined,
	issues: ValidationIssue[],
	path: string,
): void {
	if (!tools) return;
	for (const tool of tools) {
		if (DELEGATION_TOOLS.has(tool)) {
			issues.push({
				path,
				message: `delegation/orchestration tool "${tool}" is invalid in MVP`,
			});
		}
	}
}

function filterDelegationTools(
	tools: string[] | undefined,
): string[] | undefined {
	if (!tools) return undefined;
	return tools.filter((tool) => !DELEGATION_TOOLS.has(tool));
}

function classifySafety(
	tools: string[] | undefined,
	toolProviders: Record<string, CompiledToolProvider> | undefined,
	readOnlyDeclared: boolean,
	worktreePolicy: WorktreePolicy,
	approvalMode: ApprovalMode,
): CompiledTaskSafety {
	const capability = classifyToolCapability(
		tools,
		toolProviders,
		readOnlyDeclared,
	);
	const sharedCwdSafe = Boolean(
		readOnlyDeclared &&
			tools &&
			tools.every(
				(tool) =>
					effectiveToolClassification(tool, toolProviders) === "read-only",
			),
	);
	const requiresWorktree =
		worktreePolicy === "on" || (worktreePolicy === "auto" && !sharedCwdSafe);

	return {
		readOnlyDeclared,
		capability,
		sharedCwdSafe,
		worktreePolicy,
		requiresWorktree,
		permission: permissionPreview(
			tools,
			toolProviders,
			capability,
			approvalMode,
		),
	};
}

function permissionPreview(
	tools: string[] | undefined,
	toolProviders: Record<string, CompiledToolProvider> | undefined,
	capability: TaskCapability,
	approvalMode: ApprovalMode,
): PermissionPreview {
	if (!tools || tools.length === 0) {
		return {
			status: "blocked",
			statusDetail: "needs_attention",
			reason:
				"effective tools are unspecified; background permission surface is unknown",
		};
	}

	const unknownTools = tools.filter(
		(tool) => effectiveToolClassification(tool, toolProviders) === undefined,
	);
	if (unknownTools.length > 0) {
		return {
			status: "blocked",
			statusDetail: "needs_attention",
			reason: `unknown/custom tools require explicit review: ${unknownTools.join(", ")}`,
		};
	}

	if (approvalMode === "on-request" && capability !== "read-only") {
		return {
			status: "blocked",
			statusDetail: "pending_approval",
			reason: "mutation-capable background task uses on-request approval mode",
		};
	}

	return { status: "pending" };
}

function jsonKey(key: string): string {
	return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

export async function compileWorkflow(
	spec: ArtifactGraphWorkflowSpec,
	options: CompileOptions & {
		task?: string;
		runtimeDefaults?: { model?: string; thinking?: ThinkingLevel };
	},
): Promise<any> {
	const compilePlan = buildArtifactGraphCompilePlan(spec, options);
	const compiled = await compileArtifactGraphPlan(compilePlan.plan, options);
	annotateArtifactGraphCompiledWorkflow(compiled, compilePlan.stageMetadata);
	const foreachSpecDir = options.specPath
		? dirname(resolve(options.cwd, options.specPath))
		: options.cwd;
	compiled.warnings.push(
		...(await collectForeachPathWarnings(
			spec.artifactGraph?.stages ?? [],
			foreachSpecDir,
		)),
	);
	return compiled;
}

// Static check for foreach `from.path`: when the source stage declares an
// output.controlSchema, warn if the path's top-level key is absent from the
// schema properties (a likely typo that would silently fan out over nothing at
// runtime). Conservative by design: only direct task/reduce sources with a
// loadable object schema are checked; dag-container sources, schemas without a
// `properties` map, and unreadable files are skipped to avoid false positives.
async function collectForeachPathWarnings(
	stages: any[],
	specDir: string,
): Promise<string[]> {
	const warnings: string[] = [];
	const stageById = new Map<string, any>();
	for (const stage of stages) {
		if (stage && typeof stage.id === "string") stageById.set(stage.id, stage);
	}
	for (const stage of stages) {
		if (stage?.type !== "foreach") continue;
		const from = stage.from;
		if (!from || typeof from !== "object") continue;
		const sourceId = (from as any).source ?? (from as any).stage;
		const path = (from as any).path;
		if (typeof sourceId !== "string" || typeof path !== "string") continue;
		const source = stageById.get(sourceId);
		// Skip dag containers: the relevant schema is on the outputFrom child.
		if (!source || source.type === "dag") continue;
		const controlSchema = source.output?.controlSchema;
		if (typeof controlSchema !== "string") continue;
		const topKey = path.replace(/^\$\./, "").split(/[.[]/)[0];
		if (!topKey) continue;
		let schema: any;
		try {
			schema = JSON.parse(
				await readFile(resolve(specDir, controlSchema), "utf8"),
			);
		} catch {
			continue; // unreadable/invalid schema: skip rather than false-warn
		}
		const properties = schema?.properties;
		if (!properties || typeof properties !== "object") continue;
		if (!Object.hasOwn(properties, topKey)) {
			warnings.push(
				`foreach stage "${stage.id}" reads "${path}" from "${sourceId}", but "${topKey}" is not a property of ${sourceId}'s control schema (${controlSchema}). This will fan out over an empty list at runtime if the path is wrong.`,
			);
		}
	}
	return warnings;
}

async function compileArtifactGraphPlan(
	spec: any,
	options: CompileOptions & {
		task?: string;
		runtimeDefaults?: { model?: string; thinking?: ThinkingLevel };
	},
): Promise<any> {
	const stages = spec.stages;
	if (!Array.isArray(stages)) {
		throw new WorkflowValidationError([
			{ path: "$.artifactGraph.stages", message: "must be an array" },
		]);
	}

	const specDir = options.specPath
		? dirname(resolve(options.cwd, options.specPath))
		: options.cwd;
	const agentName = spec.defaults?.agent ?? "scout";
	const agentCache = new Map<string, AgentDefinition>();
	let defaultAgent: AgentDefinition | undefined;
	const getDefaultAgent = async (): Promise<AgentDefinition> => {
		defaultAgent ??= await loadWorkflowAgent(
			agentName,
			options.cwd,
			agentCache,
			"$.defaults.agent",
		);
		return defaultAgent;
	};
	const roleEntries = Object.entries(spec.roles ?? {});
	const roles = roleEntries.map(([name, role]: [string, any]) => ({
		name,
		fromAgent: role.fromAgent,
		content: role.prompt ?? "",
		maxChars: role.maxChars ?? 8000,
		truncated: false,
		includedSections: [],
		excludedSections: [],
	}));
	const roleText = roles.length
		? `# Role Context\n\n${roles.map((r) => `## Role: ${r.name}\n${r.content}`).join("\n\n")}`
		: "";
	const workflowInput = (spec as any).input;
	const workflowInputText =
		workflowInput &&
		typeof workflowInput === "object" &&
		!Array.isArray(workflowInput) &&
		Object.keys(workflowInput).length > 0
			? `# Workflow Input\n\n${JSON.stringify(workflowInput, null, 2)}`
			: "";
	const defaultModel = options.runtimeDefaults?.model ?? spec.defaults?.model;
	const defaultThinking =
		options.runtimeDefaults?.thinking ?? spec.defaults?.thinking;
	const tasks: any[] = [];
	const stageRecords: any[] = [];
	const issues: ValidationIssue[] = [];
	const warnings: string[] = [];
	const validatedAgentPaths = new Set<string>();
	validateToolSpecs(spec.defaults?.tools, issues, "$.defaults.tools");
	let previousStageTaskKeys: string[] = [];
	const stageTaskKeys = new Map<string, string[]>();

	const buildTask = async (
		stage: any,
		taskId: string,
		prompt: string,
		dependencyKeys: string[],
		overrides: Partial<CompiledTask> & Record<string, unknown> = {},
	): Promise<any> => {
		const key = `${stage.id}.${taskId}`;
		if (isSupportStage(stage)) {
			return buildSupportTask(
				stage,
				taskId,
				key,
				prompt,
				dependencyKeys,
				options.cwd,
				workflowInputText,
				overrides,
			);
		}
		if (isDynamicStage(stage)) {
			validateToolSpecs(
				stage.tools,
				issues,
				`$.artifactGraph.stages.${jsonKey(stage.id)}.tools`,
			);
			const rawDynamicToolSelection = resolveToolSelection(
				[spec.defaults?.tools, stage.tools],
				undefined,
			);
			const dynamicToolPath =
				stage.tools !== undefined
					? `$.artifactGraph.stages.${jsonKey(stage.id)}.tools`
					: spec.defaults?.tools !== undefined
						? "$.defaults.tools"
						: `$.artifactGraph.stages.${jsonKey(stage.id)}.dynamic`;
			validateDelegationBoundary(
				rawDynamicToolSelection.tools,
				issues,
				dynamicToolPath,
			);
			const dynamicToolSelection = filterToolSelection(rawDynamicToolSelection);
			const dynamicTask = buildDynamicTask(
				stage,
				taskId,
				key,
				prompt,
				dependencyKeys,
				options.cwd,
				specDir,
				workflowInputText,
				options.task,
				defaultModel,
				defaultThinking,
				overrides,
			);
			if (dynamicToolSelection.tools || dynamicToolSelection.toolProviders) {
				dynamicTask.runtime = {
					...dynamicTask.runtime,
					...(dynamicToolSelection.tools
						? { tools: dynamicToolSelection.tools }
						: {}),
					...(dynamicToolSelection.toolProviders
						? { toolProviders: dynamicToolSelection.toolProviders }
						: {}),
				};
			}
			return dynamicTask;
		}

		const stageAgentName = stage.agent ?? agentName;
		const stageAgent =
			stageAgentName === agentName
				? await getDefaultAgent()
				: await loadWorkflowAgent(
						stageAgentName,
						options.cwd,
						agentCache,
						`$.artifactGraph.stages.${stage.id}.agent`,
					);
		if (!validatedAgentPaths.has(stageAgent.sourcePath)) {
			validateAgentRuntime(
				stageAgent,
				issues,
				`$.artifactGraph.stages.${jsonKey(stage.id)}.agent`,
			);
			validatedAgentPaths.add(stageAgent.sourcePath);
		}
		validateToolSpecs(
			stage.tools,
			issues,
			`$.artifactGraph.stages.${jsonKey(stage.id)}.tools`,
		);
		const runtimeStageKind = runtimeStageKindFor(stage) ?? "single";
		// By default only `single` stages receive the runtime task body; foreach
		// and reduce stages operate on upstream item/Source Context instead. A
		// stage may opt in with `injectRuntimeTask: true` when a cross-cutting user
		// constraint (e.g. "review the diff on its own terms") must reach every
		// stage, not just the entry stage.
		const optInInjectRuntimeTask = stage.injectRuntimeTask === true;
		const injectTask = runtimeStageKind === "single" || optInInjectRuntimeTask;
		const injectRuntimeTaskInPrompt =
			(runtimeStageKind !== "foreach" && injectTask) ||
			(runtimeStageKind === "foreach" && optInInjectRuntimeTask);
		const normalizedPrompt = String(prompt ?? "").replace(
			/\$\{item\}/g,
			"the relevant item from the dependency context",
		);
		const compiledPrompt = [
			injectRuntimeTaskInPrompt && options.task
				? `# Task\n\n${options.task}`
				: undefined,
			workflowInputText || undefined,
			`# Workflow Stage\n\nstage=${stage.id}\ntype=${runtimeStageKind}`,
			`# Instructions\n\n${normalizedPrompt}`,
			roleText || undefined,
		]
			.filter(Boolean)
			.join("\n\n");
		const toolSelection = resolveToolSelection(
			[spec.defaults?.tools, stage.tools],
			stageAgent.tools,
		);
		const toolPath =
			stage.tools !== undefined
				? `$.artifactGraph.stages.${jsonKey(stage.id)}.tools`
				: spec.defaults?.tools !== undefined
					? "$.defaults.tools"
					: `$.artifactGraph.stages.${jsonKey(stage.id)}.agent`;
		validateToolSubset(toolSelection.tools, stageAgent, issues, toolPath);
		validateDelegationBoundary(toolSelection.tools, issues, toolPath);
		const filteredToolSelection = filterToolSelection(toolSelection);
		const runtime = {
			approvalMode:
				stage.approvalMode ?? spec.defaults?.approvalMode ?? "non-interactive",
			model: stage.model ?? defaultModel,
			thinking: stage.thinking ?? defaultThinking,
			tools: filteredToolSelection.tools,
			...(filteredToolSelection.toolProviders
				? { toolProviders: filteredToolSelection.toolProviders }
				: {}),
			maxRuntimeMs:
				stage.maxRuntimeMs ??
				spec.defaults?.maxRuntimeMs ??
				DEFAULT_MAX_RUNTIME_MS,
		};
		const readOnlyDeclared =
			stage.readOnly ??
			spec.defaults?.readOnly ??
			spec.readOnly ??
			stageAgent.readOnly ??
			false;
		const worktreePolicy =
			stage.worktreePolicy ??
			spec.defaults?.worktreePolicy ??
			spec.worktreePolicy ??
			"auto";
		const safety = classifySafety(
			runtime.tools,
			runtime.toolProviders,
			readOnlyDeclared,
			worktreePolicy,
			runtime.approvalMode,
		);
		// Warn when a stage declares readOnly: true but its effective tools are
		// still mutation/write-capable (e.g. bash). readOnly only filters tools;
		// it does not isolate the filesystem, so such a stage can still mutate.
		if (readOnlyDeclared && safety.capability !== "read-only") {
			const mutatingTools = (runtime.tools ?? []).filter(
				(tool: string) =>
					effectiveToolClassification(tool, runtime.toolProviders) !==
					"read-only",
			);
			warnings.push(
				`stage "${stage.id}" declares readOnly: true but has ${safety.capability} tools (${mutatingTools.join(", ") || "unknown"}); readOnly filters tools but does not prevent these from mutating. Remove the tool or rely on worktree isolation.`,
			);
		}

		return {
			key,
			id: key,
			specId: key,
			taskId,
			stageId: stage.id,
			agent: stageAgentName,
			agentPath: stageAgent.sourcePath,
			agentDescription: stageAgent.description,
			agentSystemPrompt: stageAgent.body,
			systemPromptMode: stageAgent.systemPromptMode,
			inheritProjectContext: stageAgent.inheritProjectContext,
			inheritSkills: stageAgent.inheritSkills,
			roleNames: roles.map((r) => r.name),
			task: normalizedPrompt,
			cwd: options.cwd,
			explicitCwd: stage.cwd !== undefined,
			explicitWorktreePolicy: stage.worktreePolicy !== undefined,
			runtime,
			safety,
			outputContract: stage.outputContract,
			sourceContext: stage.sourceContext,
			compiledPrompt,
			injectTask,
			kind: runtimeStageKind,
			stageMaxConcurrency: stage.maxConcurrency,
			dependsOn: [...dependencyKeys],
			foreach:
				runtimeStageKind === "foreach"
					? {
							from: stage.from,
							prompt: String(stage.each?.prompt ?? stage.prompt ?? ""),
							maxItems: stage.maxItems,
							injectRuntimeTask: injectTask,
							roleText,
						}
					: undefined,
			...overrides,
		};
	};

	const topLevelSourceStageIds = new Map<string, string>();

	const compileDagContainerStage = async (
		containerStage: any,
		containerDependencyKeys: string[],
		containerContextDependsOn: string[] | undefined,
	): Promise<string[]> => {
		const scopedStageTaskKeys = new Map<string, string[]>();
		const scopedSourceStageIds = new Map<string, string>();

		for (const childStage of containerStage.stages ?? []) {
			const currentChildTaskKeys: string[] = [];
			const childFromDependencyKeys = dependencyKeysForStage(
				childStage,
				scopedStageTaskKeys,
			);
			const childAfterDependencyKeys = afterDependencyKeysForStage(
				childStage,
				scopedStageTaskKeys,
			);
			const siblingDependencyKeys = uniqueDependencyKeys([
				...childFromDependencyKeys,
				...childAfterDependencyKeys,
			]);
			const isRootChild = siblingDependencyKeys.length === 0;
			const childDependencyKeys = isRootChild
				? containerDependencyKeys
				: siblingDependencyKeys;
			const childContextDependsOn = isRootChild
				? containerContextDependsOn
				: childStage.after !== undefined
					? childFromDependencyKeys
					: undefined;
			const childDependencyOverrides: Partial<CompiledTask> =
				childContextDependsOn !== undefined
					? { contextDependsOn: [...childContextDependsOn] }
					: {};
			const namespacedChildStage = rewriteForeachFromStageRefs(
				namespacedDagChildStage(containerStage, childStage),
				scopedSourceStageIds,
			);
			const childStageKind = runtimeStageKindFor(namespacedChildStage);

			if (childStageKind === "dag") {
				currentChildTaskKeys.push(
					...(await compileDagContainerStage(
						namespacedChildStage,
						childDependencyKeys,
						childContextDependsOn,
					)),
				);
				scopedStageTaskKeys.set(childStage.id, currentChildTaskKeys);
				const outputStageId = resolveDagOutputStageId(namespacedChildStage);
				if (outputStageId)
					scopedSourceStageIds.set(childStage.id, outputStageId);
				continue;
			}

			stageRecords.push({
				id: namespacedChildStage.id,
				type: childStageKind,
				sourcePolicy: namespacedChildStage.sourcePolicy ?? "require-success",
			});
			const addChildTask = async (taskId: string, prompt: string) => {
				const task = await buildTask(
					namespacedChildStage,
					taskId,
					prompt,
					childDependencyKeys,
					childDependencyOverrides,
				);
				tasks.push(task);
				currentChildTaskKeys.push(task.id);
			};

			if (childStageKind === "foreach") {
				await addChildTask(
					"item",
					namespacedChildStage.each?.prompt ??
						namespacedChildStage.prompt ??
						"",
				);
			} else if (childStageKind === "support") {
				await addChildTask(
					"main",
					`Run support helper ${namespacedChildStage.support.uses}.`,
				);
			} else if (childStageKind === "dynamic") {
				await addChildTask(
					"controller",
					`Run dynamic controller ${namespacedChildStage.dynamic.uses}.`,
				);
			} else {
				await addChildTask("main", namespacedChildStage.prompt ?? "");
			}

			scopedStageTaskKeys.set(childStage.id, currentChildTaskKeys);
			scopedSourceStageIds.set(childStage.id, namespacedChildStage.id);
		}

		const outputChildId = resolveDagOutputChildId(containerStage);
		return outputChildId ? (scopedStageTaskKeys.get(outputChildId) ?? []) : [];
	};

	for (const stage of stages) {
		const currentStageTaskKeys: string[] = [];
		const fromDependencyKeys = dependencyKeysForStage(stage, stageTaskKeys);
		const afterDependencyKeys = afterDependencyKeysForStage(
			stage,
			stageTaskKeys,
		);
		const explicitDependencyKeys = uniqueDependencyKeys([
			...fromDependencyKeys,
			...afterDependencyKeys,
		]);
		const hasExplicitDependencyIntent =
			stage.from !== undefined || stage.after !== undefined;
		const dependencyKeys = hasExplicitDependencyIntent
			? explicitDependencyKeys
			: previousStageTaskKeys;
		const contextDependencyOverrides: Partial<CompiledTask> =
			stage.after !== undefined
				? { contextDependsOn: [...fromDependencyKeys] }
				: {};

		const stageKind = runtimeStageKindFor(stage);

		if (stageKind === "dag") {
			currentStageTaskKeys.push(
				...(await compileDagContainerStage(
					stage,
					dependencyKeys,
					stage.after !== undefined ? fromDependencyKeys : undefined,
				)),
			);
			previousStageTaskKeys = currentStageTaskKeys;
			stageTaskKeys.set(stage.id, currentStageTaskKeys);
			const outputStageId = resolveDagOutputStageId(stage);
			if (outputStageId) topLevelSourceStageIds.set(stage.id, outputStageId);
			continue;
		}

		if (stageKind === "loop") {
			const placeholderKey = `${stage.id}.loop`;
			const loopTemplates = await compileLoopChildTemplates(stage, buildTask);
			stageRecords.push({
				id: stage.id,
				type: "loop",
				sourcePolicy: stage.sourcePolicy ?? "require-success",
				maxRounds: stage.maxRounds,
				until: stage.until,
				childStageIds: loopTemplates.childStageIds,
				childTemplates: loopTemplates.childTemplates,
				childStageRecords: loopTemplates.childStageRecords,
				onExhausted: loopTemplates.onExhausted,
				progressPath: stage.progressPath,
			});
			tasks.push(
				await buildTask(
					stage,
					"loop",
					stage.prompt ?? "Loop controller placeholder.",
					dependencyKeys,
					{
						...contextDependencyOverrides,
						key: placeholderKey,
						id: placeholderKey,
						specId: placeholderKey,
						taskId: "loop",
						kind: "loop",
						loopPlaceholder: { loopId: stage.id },
						foreach: undefined,
						safety: {
							readOnlyDeclared: true,
							capability: "read-only",
							sharedCwdSafe: true,
							worktreePolicy: "off",
							requiresWorktree: false,
							permission: { status: "pending" },
						},
						compiledPrompt: [
							workflowInputText || undefined,
							`# Workflow Stage\n\nstage=${stage.id}\ntype=loop`,
							"# Instructions\n\nLoop controller placeholder. Child stages are materialized by the workflow engine at runtime.",
							roleText || undefined,
						]
							.filter(Boolean)
							.join("\n\n"),
					},
				),
			);
			currentStageTaskKeys.push(placeholderKey);
			previousStageTaskKeys = currentStageTaskKeys;
			stageTaskKeys.set(stage.id, currentStageTaskKeys);
			continue;
		}

		const runtimeStage = rewriteForeachFromStageRefs(
			stage,
			topLevelSourceStageIds,
		);
		stageRecords.push({
			id: runtimeStage.id,
			type: stageKind,
			sourcePolicy: runtimeStage.sourcePolicy ?? "require-success",
		});
		const addTask = async (taskId: string, prompt: string) => {
			const task = await buildTask(
				runtimeStage,
				taskId,
				prompt,
				dependencyKeys,
				contextDependencyOverrides,
			);
			tasks.push(task);
			currentStageTaskKeys.push(task.id);
		};
		if (stageKind === "foreach") {
			await addTask(
				"item",
				runtimeStage.each?.prompt ?? runtimeStage.prompt ?? "",
			);
		} else if (stageKind === "support") {
			await addTask("main", `Run support helper ${runtimeStage.support.uses}.`);
		} else if (stageKind === "dynamic") {
			await addTask(
				"controller",
				`Run dynamic controller ${runtimeStage.dynamic.uses}.`,
			);
		} else {
			await addTask("main", runtimeStage.prompt ?? "");
		}
		previousStageTaskKeys = currentStageTaskKeys;
		stageTaskKeys.set(stage.id, currentStageTaskKeys);
		topLevelSourceStageIds.set(stage.id, runtimeStage.id);
	}

	const backendOptions = spec.defaults?.backend ?? {};
	if (backendOptions.type !== undefined && backendOptions.type !== "local-pi")
		issues.push({
			path: "$.defaults.backend.type",
			message: 'must be "local-pi"',
		});
	if (backendOptions.mode !== undefined && backendOptions.mode !== "headless")
		issues.push({
			path: "$.defaults.backend.mode",
			message: 'must be "headless"',
		});
	if (spec.fast === "on")
		issues.push({ path: "$.fast", message: "fast:on is not supported" });
	if (spec.defaults?.fast === "on")
		issues.push({
			path: "$.defaults.fast",
			message: "fast:on is not supported",
		});
	for (const [index, stage] of stages.entries()) {
		if (stage?.fast === "on")
			issues.push({
				path: `$.artifactGraph.stages[${index}].fast`,
				message: "fast:on is not supported",
			});
	}
	if (issues.length > 0) throw new WorkflowValidationError(issues);

	return {
		schemaVersion: 1,
		name: spec.name,
		description: spec.description,
		type: WORKFLOW_RUN_TYPE,
		task: options.task,
		cwd: options.cwd,
		backend: { type: "local-pi", mode: "headless" },
		maxConcurrency: spec.defaults?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
		roles,
		stages: stageRecords,
		tasks,
		warnings,
		budget: {
			models: defaultModel ? [{ model: defaultModel }] : [],
			unratedModels: [],
		},
	};
}

function isSupportStage(stage: any): boolean {
	return stage?.support !== undefined && stage?.type === undefined;
}

function isDynamicStage(stage: any): boolean {
	return stage?.type === "dynamic" && stage?.dynamic !== undefined;
}

function runtimeStageKindFor(stage: any): string | undefined {
	return isSupportStage(stage) ? "support" : stage.type;
}

function buildSupportTask(
	stage: any,
	taskId: string,
	key: string,
	prompt: string,
	dependencyKeys: string[],
	cwd: string,
	workflowInputText: string,
	overrides: Partial<CompiledTask> & Record<string, unknown>,
): any {
	const support = stage.support ?? {};
	const uses = String(support.uses);
	const options =
		support.options &&
		typeof support.options === "object" &&
		!Array.isArray(support.options)
			? (support.options as Record<string, unknown>)
			: undefined;
	const normalizedPrompt = String(prompt ?? "").replace(
		/\$\{item\}/g,
		"the relevant item from the dependency context",
	);
	const compiledPrompt = [
		workflowInputText || undefined,
		`# Workflow Stage\n\nstage=${stage.id}\nkind=support`,
		`# Support Helper\n\nuses=${uses}`,
		normalizedPrompt ? `# Instructions\n\n${normalizedPrompt}` : undefined,
	]
		.filter(Boolean)
		.join("\n\n");

	return {
		key,
		id: key,
		specId: key,
		taskId,
		stageId: stage.id,
		agent: "support",
		agentPath: uses,
		agentDescription: "Workflow-local support helper",
		agentSystemPrompt: "",
		roleNames: [],
		task: normalizedPrompt,
		cwd,
		explicitCwd: false,
		explicitWorktreePolicy: false,
		runtime: { approvalMode: "non-interactive" },
		safety: {
			readOnlyDeclared: false,
			capability: "mutation-capable",
			sharedCwdSafe: false,
			worktreePolicy: "off",
			requiresWorktree: false,
			permission: { status: "pending" },
		},
		compiledPrompt,
		injectTask: false,
		kind: "support",
		stageMaxConcurrency: stage.maxConcurrency,
		dependsOn: [...dependencyKeys],
		support: { uses, options },
		...overrides,
	};
}

function buildDynamicTask(
	stage: any,
	taskId: string,
	key: string,
	prompt: string,
	dependencyKeys: string[],
	cwd: string,
	specDir: string,
	workflowInputText: string,
	runtimeTask: string | undefined,
	defaultModel: string | undefined,
	defaultThinking: ThinkingLevel | undefined,
	overrides: Partial<CompiledTask> & Record<string, unknown>,
): any {
	const dynamic = stage.dynamic ?? {};
	const uses = String(dynamic.uses);
	const normalizedPrompt = String(prompt ?? "").replace(
		/\$\{item\}/g,
		"the relevant item from the dependency context",
	);
	const controlSchema =
		stage.artifactGraphOutput?.controlSchema ?? stage.output?.controlSchema;
	const compiledPrompt = [
		workflowInputText || undefined,
		runtimeTask?.trim() ? `# Runtime Task\n\n${runtimeTask.trim()}` : undefined,
		`# Workflow Stage\n\nstage=${stage.id}\nkind=dynamic`,
		`# Dynamic Controller\n\nuses=${uses}\nmode=${dynamic.mode ?? "graph-splice"}`,
		[
			"# Workflow Output Protocol",
			"Dynamic controller return values are normalized into workflow artifact sections: <control>{...}</control>, <analysis>...</analysis>, and <refs>[]</refs>.",
			"The control object must include a non-empty `schema` string and concise `digest`/`summary`.",
			controlSchema
				? `Use workflow-local control schema reference: ${controlSchema}`
				: "Use schema `dynamic-controller-result-v1` unless the workflow asks for a more specific control schema.",
		].join("\n\n"),
		normalizedPrompt ? `# Instructions\n\n${normalizedPrompt}` : undefined,
	]
		.filter(Boolean)
		.join("\n\n");
	const helpers: Record<string, any> = {};
	for (const [helperId, helper] of Object.entries(
		isPlainRecord(dynamic.helpers) ? dynamic.helpers : {},
	)) {
		if (!isPlainRecord(helper)) continue;
		helpers[helperId] = {
			uses: String(helper.uses),
			usesPath: resolve(specDir, String(helper.uses)),
			...(helper.idempotent === true ? { idempotent: true } : {}),
			...(typeof helper.inputSchema === "string"
				? {
						inputSchema: helper.inputSchema,
						inputSchemaPath: resolve(specDir, helper.inputSchema),
					}
				: {}),
			...(typeof helper.outputSchema === "string"
				? {
						outputSchema: helper.outputSchema,
						outputSchemaPath: resolve(specDir, helper.outputSchema),
					}
				: {}),
		};
	}
	const workflows: Record<string, any> = {};
	for (const [workflowId, workflow] of Object.entries(
		isPlainRecord(dynamic.workflows) ? dynamic.workflows : {},
	)) {
		if (!isPlainRecord(workflow)) continue;
		workflows[workflowId] = {
			uses: String(workflow.uses),
			usesPath: resolve(specDir, String(workflow.uses)),
		};
	}
	const decisionLoop = compileDynamicDecisionLoop(
		dynamic.decisionLoop,
		defaultModel,
		defaultThinking,
	);

	return {
		key,
		id: key,
		specId: key,
		taskId,
		stageId: stage.id,
		agent: "dynamic",
		agentPath: uses,
		agentDescription: "Workflow dynamic controller",
		agentSystemPrompt: "",
		roleNames: [],
		task: normalizedPrompt,
		cwd,
		explicitCwd: false,
		explicitWorktreePolicy: false,
		runtime: {
			approvalMode: "non-interactive",
			model: defaultModel,
			thinking: defaultThinking,
			maxRuntimeMs:
				dynamic.budget?.maxRuntimeMs ?? DEFAULT_DYNAMIC_MAX_RUNTIME_MS,
		},
		safety: {
			readOnlyDeclared: false,
			capability: "mutation-capable",
			sharedCwdSafe: false,
			worktreePolicy: "off",
			requiresWorktree: false,
			permission: { status: "pending" },
		},
		compiledPrompt,
		injectTask: false,
		kind: "dynamic",
		stageMaxConcurrency: stage.maxConcurrency,
		dependsOn: [...dependencyKeys],
		dynamic: {
			uses,
			usesPath: resolve(specDir, uses),
			mode: dynamic.mode ?? "graph-splice",
			budget: {
				maxAgents: dynamic.budget?.maxAgents ?? DEFAULT_DYNAMIC_MAX_AGENTS,
				maxConcurrency:
					dynamic.budget?.maxConcurrency ?? DEFAULT_DYNAMIC_MAX_CONCURRENCY,
				maxRuntimeMs:
					dynamic.budget?.maxRuntimeMs ?? DEFAULT_DYNAMIC_MAX_RUNTIME_MS,
				maxNestedWorkflowDepth:
					dynamic.budget?.maxNestedWorkflowDepth ??
					DEFAULT_DYNAMIC_MAX_NESTED_WORKFLOW_DEPTH,
				maxGraphMutations:
					dynamic.budget?.maxGraphMutations ??
					DEFAULT_DYNAMIC_MAX_GRAPH_MUTATIONS,
				maxHelperRuns:
					dynamic.budget?.maxHelperRuns ?? DEFAULT_DYNAMIC_MAX_HELPER_RUNS,
			},
			permissions: {
				approval: dynamic.permissions?.approval ?? "auto",
				allowDynamicRoles: dynamic.permissions?.allowDynamicRoles ?? true,
				allowDynamicTools: dynamic.permissions?.allowDynamicTools ?? true,
			},
			helpers,
			workflows,
			...(decisionLoop ? { decisionLoop } : {}),
		},
		...overrides,
	};
}

function compileDynamicDecisionLoop(
	value: unknown,
	defaultModel?: string,
	defaultThinking?: ThinkingLevel,
): any | undefined {
	if (!isPlainRecord(value)) return undefined;
	const allowedToolSelection = filterToolSelection(
		resolveToolSelection(
			[Array.isArray(value.allowedTools) ? value.allowedTools : undefined],
			undefined,
		),
	);
	const maxFindings = positiveInteger(
		recordValue(value.stateIndex, "maxFindings"),
	);
	const deprecatedRequiredFindingIds = stringArray(
		recordValue(value.stateIndex, "requiredFindingIds"),
	);
	return {
		planner: compileDynamicDecisionLoopProfile(
			value.planner,
			defaultModel,
			defaultThinking,
		),
		workerDefaults: compileDynamicDecisionLoopProfile(
			value.workerDefaults,
			defaultModel,
			defaultThinking,
		),
		verifier: compileDynamicDecisionLoopProfile(
			value.verifier,
			defaultModel,
			defaultThinking,
		),
		synthesis: compileDynamicDecisionLoopProfile(
			value.synthesis,
			defaultModel,
			defaultThinking,
		),
		allowedAgents: stringArray(value.allowedAgents),
		...(allowedToolSelection.tools
			? { allowedTools: allowedToolSelection.tools }
			: {}),
		...(allowedToolSelection.toolProviders
			? { allowedToolProviders: allowedToolSelection.toolProviders }
			: {}),
		allowedOutputProfiles:
			stringArray(value.allowedOutputProfiles).length > 0
				? stringArray(value.allowedOutputProfiles)
				: [...DYNAMIC_OUTPUT_PROFILES],
		maxDecisionRounds:
			positiveInteger(value.maxDecisionRounds) ??
			DEFAULT_DYNAMIC_DECISION_LOOP_MAX_ROUNDS,
		maxActionsPerRound:
			positiveInteger(value.maxActionsPerRound) ??
			DEFAULT_DYNAMIC_DECISION_LOOP_MAX_ACTIONS,
		repair: {
			maxAttempts:
				positiveInteger(recordValue(value.repair, "maxAttempts")) ?? 2,
		},
		stateIndex: {
			...(maxFindings !== undefined ? { maxFindings } : {}),
			// Deprecated/no-op compatibility field: compile it for the public
			// authoring contract, but the Phase 1 runtime intentionally ignores it.
			...(deprecatedRequiredFindingIds.length > 0
				? { requiredFindingIds: deprecatedRequiredFindingIds }
				: {}),
		},
		stopPolicy: {
			// Deprecated/no-op compatibility field: synthesize action shape is
			// enforced by validateDynamicDecision(), not this flag.
			requireSynthesisAction:
				booleanValue(recordValue(value.stopPolicy, "requireSynthesisAction")) ??
				false,
			failOnInvalidDecision:
				booleanValue(recordValue(value.stopPolicy, "failOnInvalidDecision")) ??
				true,
			maxStalls:
				positiveInteger(recordValue(value.stopPolicy, "maxStalls")) ??
				DEFAULT_DYNAMIC_DECISION_LOOP_MAX_STALLS,
			// Deprecated/no-op compatibility field: dropped-branch enforcement is
			// deferred; the runtime surfaces blockers/omissions instead.
			failOnDroppedRequiredBranch:
				booleanValue(
					recordValue(value.stopPolicy, "failOnDroppedRequiredBranch"),
				) ?? true,
		},
	};
}

function compileDynamicDecisionLoopProfile(
	value: unknown,
	defaultModel?: string,
	defaultThinking?: ThinkingLevel,
): any | undefined {
	if (!isPlainRecord(value)) return undefined;
	const toolSelection = filterToolSelection(
		resolveToolSelection(
			[Array.isArray(value.tools) ? value.tools : undefined],
			undefined,
		),
	);
	const model =
		typeof value.model === "string" && value.model.trim()
			? value.model.trim()
			: defaultModel;
	const thinking =
		typeof value.thinking === "string" && value.thinking.trim()
			? value.thinking.trim()
			: defaultThinking;
	return {
		...(typeof value.agent === "string" && value.agent.trim()
			? { agent: value.agent.trim() }
			: {}),
		...(model ? { model } : {}),
		...(thinking ? { thinking } : {}),
		...(toolSelection.tools ? { tools: toolSelection.tools } : {}),
		...(toolSelection.toolProviders
			? { toolProviders: toolSelection.toolProviders }
			: {}),
		...(typeof value.outputProfile === "string" && value.outputProfile.trim()
			? { outputProfile: value.outputProfile.trim() }
			: {}),
		...(positiveInteger(value.maxRuntimeMs) !== undefined
			? { maxRuntimeMs: positiveInteger(value.maxRuntimeMs) }
			: {}),
	};
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0
		? value
		: undefined;
}

function booleanValue(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function recordValue(value: unknown, key: string): unknown {
	return isPlainRecord(value) ? value[key] : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadWorkflowAgent(
	name: string,
	cwd: string,
	cache: Map<string, AgentDefinition>,
	path: string,
): Promise<AgentDefinition> {
	const cached = cache.get(name);
	if (cached) return cached;
	const agent = await loadAgentByName(name, cwd).catch(() => undefined);
	if (!agent)
		throw new WorkflowValidationError([
			{ path, message: `unknown agent "${name}"` },
		]);
	cache.set(name, agent);
	for (const alias of agent.aliases) cache.set(alias, agent);
	return agent;
}

async function compileLoopChildTemplates(
	loopStage: any,
	buildTask: (
		stage: any,
		taskId: string,
		prompt: string,
		dependencyKeys: string[],
		overrides?: Partial<CompiledTask> & Record<string, unknown>,
	) => Promise<any>,
): Promise<{
	childStageIds: string[];
	childTemplates: any[];
	childStageRecords: Array<{
		id: string;
		type?: string;
		sourcePolicy?: string;
	}>;
	onExhausted?: { stageId: string; template: any };
}> {
	const childStageIds: string[] = [];
	const childTemplates: any[] = [];
	const childStageRecords: Array<{
		id: string;
		type?: string;
		sourcePolicy?: string;
	}> = [];
	let previousChildTaskKeys: string[] = [];
	const childTaskKeys = new Map<string, string[]>();

	for (const childStage of loopStage.stages ?? []) {
		childStageIds.push(childStage.id);
		childStageRecords.push({
			id: childStage.id,
			type: childStage.type,
			sourcePolicy: childStage.sourcePolicy ?? "require-success",
		});
		const currentChildTaskKeys: string[] = [];
		const explicitDependencyKeys = dependencyKeysForStage(
			childStage,
			childTaskKeys,
		);
		const dependencyKeys =
			explicitDependencyKeys.length > 0
				? explicitDependencyKeys
				: previousChildTaskKeys;
		const addChildTask = async (taskId: string, prompt: string) => {
			const template = await buildTask(
				childStage,
				taskId,
				prompt,
				dependencyKeys,
			);
			childTemplates.push(template);
			currentChildTaskKeys.push(template.id);
		};

		await addChildTask("main", childStage.prompt ?? "");

		previousChildTaskKeys = currentChildTaskKeys;
		childTaskKeys.set(childStage.id, currentChildTaskKeys);
	}

	const onExhaustedStage = loopStage.onExhausted;
	const onExhausted = onExhaustedStage
		? {
				stageId: onExhaustedStage.id ?? "onExhausted",
				template: await buildTask(
					onExhaustedStage,
					"main",
					onExhaustedStage.prompt ?? "",
					[],
				),
			}
		: undefined;

	return { childStageIds, childTemplates, childStageRecords, onExhausted };
}

function rewriteForeachFromStageRefs(
	stage: any,
	sourceStageIds: Map<string, string>,
): any {
	if (stage?.type !== "foreach") return stage;
	const rewrittenFrom = rewriteFromStageRefs(stage.from, sourceStageIds);
	return rewrittenFrom === stage.from
		? stage
		: { ...stage, from: rewrittenFrom };
}

function rewriteFromStageRefs(
	value: any,
	sourceStageIds: Map<string, string>,
): any {
	if (typeof value === "string") return sourceStageIds.get(value) ?? value;
	if (Array.isArray(value))
		return value.map((item) =>
			typeof item === "string" ? (sourceStageIds.get(item) ?? item) : item,
		);
	if (value && typeof value === "object") {
		return typeof value.stage === "string"
			? { ...value, stage: sourceStageIds.get(value.stage) ?? value.stage }
			: value;
	}
	return value;
}

function resolveDagOutputStageId(stage: any): string | undefined {
	const outputChildId = resolveDagOutputChildId(stage);
	if (!outputChildId) return undefined;
	const outputChild = (stage.stages ?? []).find(
		(childStage: any) => childStage?.id === outputChildId,
	);
	if (!outputChild) return undefined;
	const namespacedOutputChild = namespacedDagChildStage(stage, outputChild);
	return runtimeStageKindFor(outputChild) === "dag"
		? resolveDagOutputStageId(namespacedOutputChild)
		: namespacedOutputChild.id;
}

function namespacedDagChildStage(containerStage: any, childStage: any): any {
	const namespacedStage = {
		...childStage,
		id: `${containerStage.id}.${childStage.id}`,
	};
	if (
		namespacedStage.sourcePolicy === undefined &&
		containerStage.sourcePolicy !== undefined
	) {
		namespacedStage.sourcePolicy = containerStage.sourcePolicy;
	}
	if (
		namespacedStage.maxConcurrency === undefined &&
		containerStage.maxConcurrency !== undefined
	) {
		namespacedStage.maxConcurrency = containerStage.maxConcurrency;
	}
	if (namespacedStage.type === "foreach") {
		namespacedStage.from = namespaceDagStageRefs(
			childStage.from,
			containerStage.id,
		);
	}
	return namespacedStage;
}

function namespaceDagStageRefs(value: any, namespace: string): any {
	if (typeof value === "string") return `${namespace}.${value}`;
	if (Array.isArray(value))
		return value.map((item) =>
			typeof item === "string" ? `${namespace}.${item}` : item,
		);
	if (value && typeof value === "object") {
		return typeof value.stage === "string"
			? { ...value, stage: `${namespace}.${value.stage}` }
			: value;
	}
	return value;
}

function resolveDagOutputChildId(stage: any): string | undefined {
	if (typeof stage.outputFrom === "string" && stage.outputFrom.trim() !== "")
		return stage.outputFrom;
	const sinkIds = dagSinkStageIds(stage.stages ?? []);
	return sinkIds.length === 1 ? sinkIds[0] : undefined;
}

function dagSinkStageIds(stages: any[]): string[] {
	const childStageIds = new Set<string>();
	for (const childStage of stages) {
		if (typeof childStage?.id === "string" && childStage.id.trim() !== "")
			childStageIds.add(childStage.id);
	}
	const dependedOnStageIds = new Set<string>();
	for (const childStage of stages) {
		for (const stageId of [
			...stageIdsFromFrom(childStage?.from),
			...stageIdsFromAfter(childStage?.after),
		]) {
			if (childStageIds.has(stageId)) dependedOnStageIds.add(stageId);
		}
	}
	return [...childStageIds].filter((id) => !dependedOnStageIds.has(id));
}

function dependencyKeysForStage(
	stage: any,
	stageTaskKeys: Map<string, string[]>,
): string[] {
	return dependencyKeysForStageIds(stageIdsFromFrom(stage.from), stageTaskKeys);
}

function afterDependencyKeysForStage(
	stage: any,
	stageTaskKeys: Map<string, string[]>,
): string[] {
	return dependencyKeysForStageIds(
		stageIdsFromAfter(stage.after),
		stageTaskKeys,
	);
}

function dependencyKeysForStageIds(
	stageIds: string[],
	stageTaskKeys: Map<string, string[]>,
): string[] {
	const keys: string[] = [];
	for (const stageId of stageIds)
		keys.push(...(stageTaskKeys.get(stageId) ?? []));
	return uniqueDependencyKeys(keys);
}

function stageIdsFromFrom(from: any): string[] {
	if (!from) return [];
	if (Array.isArray(from))
		return from.filter(
			(stageId): stageId is string => typeof stageId === "string",
		);
	if (typeof from === "string") return [from];
	if (typeof from.stage === "string") return [from.stage];
	return [];
}

function stageIdsFromAfter(after: any): string[] {
	if (after === undefined) return [];
	if (Array.isArray(after))
		return after.filter(
			(stageId): stageId is string => typeof stageId === "string",
		);
	return typeof after === "string" ? [after] : [];
}

function uniqueDependencyKeys(keys: string[]): string[] {
	return [...new Set(keys)];
}
