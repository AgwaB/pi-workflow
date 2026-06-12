import { readFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";

import { loadAgentByName } from "./agents.js";
import { formatOutputTemplateSection } from "./workflow-artifacts.js";
import {
	type AgentDefinition,
	type ApprovalMode,
	type CompiledTask,
	type CompiledTaskSafety,
	type CompiledToolProvider,
	type WorkflowTaskOutputSpec,
	WorkflowValidationError,
	type PermissionPreview,
	STAGE_FIRST_RUN_TYPE,
	type TaskCapability,
	type ThinkingLevel,
	type ValidationIssue,
	type WorkflowToolObjectSpec,
	type WorkflowToolSpec,
	type WorktreePolicy,
} from "./types.js";

const READ_ONLY_TOOLS = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"web_search",
	"fetch_content",
	"get_search_content",
]);
const EXPLICIT_WRITE_TOOLS = new Set(["edit", "write"]);
const MUTATION_CAPABLE_TOOLS = new Set(["bash"]);
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
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:/-]+$/;
const DEFAULT_MAX_RUNTIME_MS = 30 * 60 * 1000;
const DEFAULT_MAX_CONCURRENCY = 16;

interface CompileOptions {
	cwd: string;
	specPath?: string;
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

interface ToolSelection {
	tools?: string[];
	toolProviders?: Record<string, CompiledToolProvider>;
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

function resolveToolSelection(
	scopes: Array<WorkflowToolSpec[] | undefined>,
	fallbackTools: string[] | undefined,
): ToolSelection {
	const metadata = new Map<string, CompiledToolProvider>();
	let selectedTools: string[] | undefined;

	for (const scope of scopes) {
		if (scope === undefined || !Array.isArray(scope)) continue;
		selectedTools = [];
		for (const tool of scope) {
			const name = toolNameForSpec(tool);
			if (name === undefined) continue;
			if (typeof tool !== "string") {
				const provider = providerFromToolObject(tool);
				if (provider)
					metadata.set(name, mergeToolProviders(metadata.get(name), provider));
			}
			selectedTools.push(name);
		}
	}

	const tools = selectedTools ?? fallbackTools;
	return { tools, toolProviders: providersForSelectedTools(tools, metadata) };
}

function toolNameForSpec(tool: WorkflowToolSpec): string | undefined {
	if (typeof tool === "string") return tool;
	if (
		tool &&
		typeof tool === "object" &&
		!Array.isArray(tool) &&
		typeof (tool as { name?: unknown }).name === "string"
	) {
		return (tool as { name: string }).name;
	}
	return undefined;
}

function providerFromToolObject(
	tool: WorkflowToolObjectSpec,
): CompiledToolProvider | undefined {
	const provider: CompiledToolProvider = {};
	if (Array.isArray(tool.extensions))
		provider.extensions = [...tool.extensions];
	if (tool.classification !== undefined)
		provider.classification = tool.classification;
	if (tool.optional !== undefined) provider.optional = tool.optional;
	if (Array.isArray(tool.fallbackTools))
		provider.fallbackTools = [...tool.fallbackTools];
	return hasProviderMetadata(provider) ? provider : undefined;
}

function mergeToolProviders(
	base: CompiledToolProvider | undefined,
	override: CompiledToolProvider,
): CompiledToolProvider {
	const merged: CompiledToolProvider = { ...(base ?? {}) };
	if (override.extensions !== undefined)
		merged.extensions = [...override.extensions];
	if (override.classification !== undefined)
		merged.classification = override.classification;
	if (override.optional !== undefined) merged.optional = override.optional;
	if (override.fallbackTools !== undefined)
		merged.fallbackTools = [...override.fallbackTools];
	return merged;
}

function providersForSelectedTools(
	tools: string[] | undefined,
	metadata: Map<string, CompiledToolProvider>,
): Record<string, CompiledToolProvider> | undefined {
	if (!tools || tools.length === 0) return undefined;
	const providers: Record<string, CompiledToolProvider> = {};
	for (const tool of tools) {
		const provider = metadata.get(tool);
		if (provider && hasProviderMetadata(provider))
			providers[tool] = cloneToolProvider(provider);
	}
	return Object.keys(providers).length > 0 ? providers : undefined;
}

function cloneToolProvider(
	provider: CompiledToolProvider,
): CompiledToolProvider {
	return {
		...(provider.extensions !== undefined
			? { extensions: [...provider.extensions] }
			: {}),
		...(provider.classification !== undefined
			? { classification: provider.classification }
			: {}),
		...(provider.optional !== undefined ? { optional: provider.optional } : {}),
		...(provider.fallbackTools !== undefined
			? { fallbackTools: [...provider.fallbackTools] }
			: {}),
	};
}

function hasProviderMetadata(provider: CompiledToolProvider): boolean {
	return (
		provider.extensions !== undefined ||
		provider.classification !== undefined ||
		provider.optional !== undefined ||
		provider.fallbackTools !== undefined
	);
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
	const capability = classifyCapability(tools, toolProviders, readOnlyDeclared);
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

function classifyCapability(
	tools: string[] | undefined,
	toolProviders: Record<string, CompiledToolProvider> | undefined,
	readOnlyDeclared: boolean,
): TaskCapability {
	if (!tools || tools.length === 0) return "write-capable";
	if (
		tools.some(
			(tool) =>
				effectiveToolClassification(tool, toolProviders) ===
					"mutation-capable" ||
				effectiveToolClassification(tool, toolProviders) === undefined,
		)
	) {
		return "mutation-capable";
	}
	if (
		tools.some(
			(tool) =>
				effectiveToolClassification(tool, toolProviders) === "write-capable",
		)
	)
		return "write-capable";
	return readOnlyDeclared ? "read-only" : "write-capable";
}

function effectiveToolClassification(
	tool: string,
	toolProviders: Record<string, CompiledToolProvider> | undefined,
): TaskCapability | undefined {
	if (READ_ONLY_TOOLS.has(tool)) return "read-only";
	if (EXPLICIT_WRITE_TOOLS.has(tool)) return "write-capable";
	if (MUTATION_CAPABLE_TOOLS.has(tool)) return "mutation-capable";
	return toolProviders?.[tool]?.classification;
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

async function resolveOutputTemplate(
	output: WorkflowTaskOutputSpec | undefined,
	spec: any,
	options: CompileOptions,
	path: string,
	issues: ValidationIssue[],
): Promise<WorkflowTaskOutputSpec | undefined> {
	if (!output) return undefined;
	const requiredPaths = (output.requiredKeys ?? []).map((key) => `$.${key}`);
	const withRequiredKeys =
		requiredPaths.length > 0
			? {
					...output,
					contract: {
						...(output.contract ?? {}),
						requiredPaths: [
							...new Set([
								...(output.contract?.requiredPaths ?? []),
								...requiredPaths,
							]),
						],
					},
				}
			: output;
	if (!withRequiredKeys.templateRef) return withRequiredKeys;
	if (withRequiredKeys.template !== undefined) {
		issues.push({
			path,
			message: "must not specify both template and templateRef",
		});
		return withRequiredKeys;
	}
	const resolved = await loadOutputTemplateRef(
		withRequiredKeys.templateRef,
		spec,
		options,
		path,
		issues,
	);
	return resolved === undefined
		? withRequiredKeys
		: { ...withRequiredKeys, template: resolved, templateRef: undefined };
}

async function loadOutputTemplateRef(
	ref: string,
	spec: any,
	options: CompileOptions,
	path: string,
	issues: ValidationIssue[],
): Promise<unknown | undefined> {
	if (ref.startsWith("#")) {
		const resolved = resolveJsonPointer(spec, ref.slice(1));
		if (!resolved.exists)
			issues.push({
				path: `${path}.templateRef`,
				message: `templateRef not found: ${ref}`,
			});
		return resolved.value;
	}

	const [relativePath, fragment = ""] = ref.split("#", 2);
	if (
		!relativePath ||
		isAbsolute(relativePath) ||
		!relativePath.endsWith(".json")
	) {
		issues.push({
			path: `${path}.templateRef`,
			message: "external templateRef must be a relative .json path",
		});
		return undefined;
	}
	if (!options.specPath) {
		issues.push({
			path: `${path}.templateRef`,
			message: "external templateRef requires a workflow spec path",
		});
		return undefined;
	}

	const baseDir = dirname(resolve(options.specPath));
	const resolvedPath = resolve(baseDir, relativePath);
	const containmentRoot = isPathInside(
		resolve(options.specPath),
		resolve(options.cwd),
	)
		? resolve(options.cwd)
		: baseDir;
	if (!isPathInside(resolvedPath, containmentRoot)) {
		issues.push({
			path: `${path}.templateRef`,
			message:
				"external templateRef must stay within the workflow package or workspace",
		});
		return undefined;
	}
	if (extname(resolvedPath).toLowerCase() !== ".json") {
		issues.push({
			path: `${path}.templateRef`,
			message: "external templateRef must point to a JSON file",
		});
		return undefined;
	}

	try {
		const content = JSON.parse(await readFile(resolvedPath, "utf8"));
		if (!fragment) return content;
		const resolved = resolveJsonPointer(content, fragment);
		if (!resolved.exists)
			issues.push({
				path: `${path}.templateRef`,
				message: `templateRef fragment not found: ${ref}`,
			});
		return resolved.value;
	} catch (error) {
		issues.push({
			path: `${path}.templateRef`,
			message: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

function isPathInside(filePath: string, root: string): boolean {
	const rel = relative(root, filePath);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function resolveJsonPointer(
	value: unknown,
	pointer: string,
): { exists: boolean; value?: unknown } {
	if (pointer === "" || pointer === "/") return { exists: true, value };
	if (!pointer.startsWith("/")) return { exists: false };
	let current = value;
	for (const rawToken of pointer.slice(1).split("/")) {
		const token = rawToken.replace(/~1/g, "/").replace(/~0/g, "~");
		if (
			!current ||
			typeof current !== "object" ||
			Array.isArray(current) ||
			!Object.hasOwn(current, token)
		)
			return { exists: false };
		current = (current as Record<string, unknown>)[token];
	}
	return { exists: true, value: current };
}

export async function compileWorkflow(
	spec: any,
	options: CompileOptions & {
		task?: string;
		runtimeDefaults?: { model?: string; thinking?: ThinkingLevel };
	},
): Promise<any> {
	const stages = spec.workflow?.stages;
	if (!Array.isArray(stages)) {
		throw new WorkflowValidationError([
			{ path: "$.workflow.stages", message: "must be an array" },
		]);
	}

	const agentName = spec.agent ?? spec.defaults?.agent ?? "scout";
	const agentCache = new Map<string, AgentDefinition>();
	let defaultAgent: AgentDefinition | undefined;
	const getDefaultAgent = async (): Promise<AgentDefinition> => {
		defaultAgent ??= await loadStageFirstAgent(
			agentName,
			options.cwd,
			agentCache,
			"$.agent",
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
	const defaultModel =
		options.runtimeDefaults?.model ?? spec.defaults?.model ?? spec.model;
	const defaultThinking =
		options.runtimeDefaults?.thinking ??
		spec.defaults?.thinking ??
		spec.thinking;
	const tasks: any[] = [];
	const stageRecords: any[] = [];
	const issues: ValidationIssue[] = [];
	const validatedAgentPaths = new Set<string>();
	validateToolSpecs(spec.tools, issues, "$.tools");
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

		const stageAgentName = stage.agent ?? agentName;
		const stageAgent =
			stageAgentName === agentName
				? await getDefaultAgent()
				: await loadStageFirstAgent(
						stageAgentName,
						options.cwd,
						agentCache,
						`$.workflow.stages.${stage.id}.agent`,
					);
		if (!validatedAgentPaths.has(stageAgent.sourcePath)) {
			validateAgentRuntime(
				stageAgent,
				issues,
				`$.workflow.stages.${jsonKey(stage.id)}.agent`,
			);
			validatedAgentPaths.add(stageAgent.sourcePath);
		}
		validateToolSpecs(
			stage.tools,
			issues,
			`$.workflow.stages.${jsonKey(stage.id)}.tools`,
		);
		const stageInject = stage.inject;
		const defaultInject = stage.type === "task";
		const injectTask = stageInject ?? defaultInject;
		const injectRuntimeTaskInPrompt =
			stage.type === "foreach" ? false : injectTask;
		const stageOutput = await resolveOutputTemplate(
			stage.output,
			spec,
			options,
			`$.workflow.stages.${jsonKey(stage.id)}.output`,
			issues,
		);
		const normalizedPrompt = String(prompt ?? "").replace(
			/\$\{item\}/g,
			"the relevant item from the dependency context",
		);
		const compiledPrompt = [
			injectRuntimeTaskInPrompt && options.task
				? `# Task\n\n${options.task}`
				: undefined,
			workflowInputText || undefined,
			`# Workflow Stage\n\nstage=${stage.id}\ntype=${stage.type}`,
			`# Instructions\n\n${normalizedPrompt}`,
			formatOutputTemplateSection(stageOutput),
			roleText || undefined,
		]
			.filter(Boolean)
			.join("\n\n");
		const toolSelection = resolveToolSelection(
			[spec.tools, spec.defaults?.tools, stage.tools],
			stageAgent.tools,
		);
		const toolPath =
			stage.tools !== undefined
				? `$.workflow.stages.${jsonKey(stage.id)}.tools`
				: spec.defaults?.tools !== undefined
					? "$.defaults.tools"
					: spec.tools !== undefined
						? "$.tools"
						: `$.workflow.stages.${jsonKey(stage.id)}.agent`;
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
			output: stageOutput,
			outputContract: stage.outputContract,
			sourceContext: stage.sourceContext,
			compiledPrompt,
			injectTask,
			kind: stage.type,
			stageMaxConcurrency: stage.maxConcurrency,
			dependsOn: [...dependencyKeys],
			foreach:
				stage.type === "foreach"
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

	for (const stage of stages) {
		const currentStageTaskKeys: string[] = [];
		const fromDependencyKeys = dependencyKeysForStage(stage, stageTaskKeys);
		const afterDependencyKeys = afterDependencyKeysForStage(stage, stageTaskKeys);
		const explicitDependencyKeys = uniqueDependencyKeys([
			...fromDependencyKeys,
			...afterDependencyKeys,
		]);
		const dependencyKeys =
			explicitDependencyKeys.length > 0
				? explicitDependencyKeys
				: previousStageTaskKeys;
		const contextDependencyOverrides: Partial<CompiledTask> =
			stage.after !== undefined
				? { contextDependsOn: [...fromDependencyKeys] }
				: {};

		const stageKind = stageKindFor(stage);

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

		stageRecords.push({
			id: stage.id,
			type: stageKind,
			sourcePolicy: stage.sourcePolicy ?? "require-success",
		});
		const addTask = async (taskId: string, prompt: string) => {
			const task = await buildTask(
				stage,
				taskId,
				prompt,
				dependencyKeys,
				contextDependencyOverrides,
			);
			tasks.push(task);
			currentStageTaskKeys.push(task.id);
		};
		if (stageKind === "parallel" && Array.isArray(stage.tasks)) {
			for (const item of stage.tasks)
				await addTask(item.id ?? `item-${tasks.length + 1}`, item.prompt ?? "");
		} else if (stageKind === "foreach") {
			await addTask("item", stage.each?.prompt ?? stage.prompt ?? "");
		} else if (stageKind === "support") {
			await addTask("main", `Run support helper ${stage.support.uses}.`);
		} else {
			await addTask("main", stage.prompt ?? "");
		}
		previousStageTaskKeys = currentStageTaskKeys;
		stageTaskKeys.set(stage.id, currentStageTaskKeys);
	}

	const backendOptions = spec.defaults?.backend ?? spec.backend ?? {};
	if (backendOptions.type !== undefined && backendOptions.type !== "local-pi")
		issues.push({ path: "$.backend.type", message: 'must be "local-pi"' });
	if (
		backendOptions.mode !== undefined &&
		backendOptions.mode !== "auto" &&
		backendOptions.mode !== "headless"
	)
		issues.push({
			path: "$.backend.mode",
			message: 'must be "auto" or "headless"',
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
				path: `$.workflow.stages[${index}].fast`,
				message: "fast:on is not supported",
			});
	}
	if (issues.length > 0) throw new WorkflowValidationError(issues);

	return {
		schemaVersion: 1,
		name: spec.name,
		description: spec.description,
		type: STAGE_FIRST_RUN_TYPE,
		task: options.task,
		cwd: options.cwd,
		backend: { type: "local-pi", mode: "headless" },
		maxConcurrency: spec.defaults?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
		roles,
		stages: stageRecords,
		tasks,
		warnings: [],
		budget: {
			models: defaultModel ? [{ model: defaultModel }] : [],
			unratedModels: [],
		},
	};
}

function isSupportStage(stage: any): boolean {
	return Boolean(
		stage?.support &&
			typeof stage.support === "object" &&
			!Array.isArray(stage.support),
	);
}

function stageKindFor(stage: any): string | undefined {
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
		`# Workflow Stage\n\nstage=${stage.id}\ntype=support`,
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
		dependsOn: [...dependencyKeys],
		support: { uses, options },
		...overrides,
	};
}

async function loadStageFirstAgent(
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

		if (childStage.type === "parallel" && Array.isArray(childStage.tasks)) {
			for (const item of childStage.tasks)
				await addChildTask(
					item.id ?? `item-${childTemplates.length + 1}`,
					item.prompt ?? "",
				);
		} else {
			await addChildTask("main", childStage.prompt ?? "");
		}

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
	return dependencyKeysForStageIds(stageIdsFromAfter(stage.after), stageTaskKeys);
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
		return from.filter((stageId): stageId is string => typeof stageId === "string");
	if (typeof from === "string") return [from];
	if (typeof from.stage === "string") return [from.stage];
	return [];
}

function stageIdsFromAfter(after: any): string[] {
	if (after === undefined) return [];
	if (Array.isArray(after))
		return after.filter((stageId): stageId is string => typeof stageId === "string");
	return typeof after === "string" ? [after] : [];
}

function uniqueDependencyKeys(keys: string[]): string[] {
	return [...new Set(keys)];
}
