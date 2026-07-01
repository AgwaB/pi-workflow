import { loadAgentByName } from "./agents.js";
import { readArtifactGraphControl } from "./artifact-graph-runtime.js";
import { DynamicControllerBudgetBlocked } from "./dynamic-controller-errors.js";
import {
	isDynamicOutputProfile,
	type DynamicOutputProfile,
} from "./dynamic-profiles.js";
import { readOrRebuildDynamicState } from "./dynamic-state.js";
import { sanitizeTaskId } from "./engine-run-graph.js";
import { fromProjectPath, isTerminalTaskStatus, readJson } from "./store.js";
import {
	classifyToolCapability,
	effectiveToolClassification,
	providersForSelectedTools,
	toolAllowedByAuthorityCeiling,
} from "./tool-metadata.js";
import type {
	CompiledDynamicWorkflowTask,
	CompiledTask,
	CompiledToolProvider,
	CompiledWorkflow,
	TaskCapability,
	ThinkingLevel,
	WorkflowRunRecord,
	WorkflowTaskRunRecord,
} from "./types.js";

const DYNAMIC_OUTPUT_MAX_DIGEST_CHARS = 1000;
const DYNAMIC_DELEGATION_TOOLS = new Set([
	"skill_test_subagent",
	"workflow",
	"/workflow",
]);

export interface DynamicArtifactInput {
	kind: "workflow-artifact-ref";
	name: string;
	options?: Record<string, unknown>;
	required: boolean;
}

export interface DynamicAgentRequest {
	id: string;
	agent?: string;
	profile?: string;
	prompt: string;
	outputProfile?: string;
	tools?: string[];
	branchId?: string;
	readOnly?: boolean;
	model?: string;
	thinking?: ThinkingLevel;
	maxRuntimeMs?: number;
	inputs: DynamicArtifactInput[];
	requiredReads: string[];
	dependsOn?: string[];
	compact: boolean;
}

export async function assertDynamicGenerationBudgetAvailable(input: {
	cwd: string;
	runId: string;
	controllerSpecId: string;
	dynamic: CompiledDynamicWorkflowTask;
}): Promise<void> {
	const state = await readOrRebuildDynamicState(input.cwd, input.runId);
	const counters = state.controllers[input.controllerSpecId]?.counters;
	if ((counters?.agents ?? 0) >= input.dynamic.budget.maxAgents) {
		throw new DynamicControllerBudgetBlocked(
			`dynamic agent budget exhausted: maxAgents=${input.dynamic.budget.maxAgents}`,
		);
	}
	if (
		(counters?.graphMutations ?? 0) >= input.dynamic.budget.maxGraphMutations
	) {
		throw new DynamicControllerBudgetBlocked(
			`dynamic graph mutation budget exhausted: maxGraphMutations=${input.dynamic.budget.maxGraphMutations}`,
		);
	}
}

export async function buildDynamicGeneratedCompiledTask(input: {
	cwd: string;
	run: WorkflowRunRecord;
	compiledFlow: CompiledWorkflow;
	controllerCompiledTask: CompiledTask;
	controllerSpecId: string;
	controllerStageId: string;
	generatedSpecId: string;
	opId: string;
	requestHash: string;
	branchId?: string;
	request: DynamicAgentRequest;
	dynamic: CompiledDynamicWorkflowTask;
}): Promise<CompiledTask> {
	if (input.dynamic.budget.maxAgents <= 0) {
		throw new Error("dynamic agent budget is exhausted");
	}
	const executionProfile = dynamicDecisionLoopProfile(
		input.dynamic,
		input.request.profile,
	);
	if (executionProfile)
		assertDynamicExecutionProfileRequest(input.request, executionProfile);
	const effectiveOutputProfile =
		input.request.outputProfile ?? executionProfile?.outputProfile;
	if (effectiveOutputProfile) {
		assertDynamicOutputProfileAllowed(input.dynamic, effectiveOutputProfile);
	}
	const requestedAgent = input.request.agent ?? executionProfile?.agent;
	if (!requestedAgent) {
		throw new Error(
			"dynamic agent request must declare an agent or execution profile",
		);
	}
	if (!executionProfile && !input.dynamic.permissions.allowDynamicRoles) {
		throw new Error(
			"dynamic agent role selection is not allowed by workflow permissions",
		);
	}
	if (
		input.request.tools &&
		!executionProfile &&
		!input.dynamic.permissions.allowDynamicTools
	) {
		throw new Error(
			"dynamic agent tool overrides are not allowed by workflow permissions",
		);
	}
	const agentDefinition = await loadAgentByName(requestedAgent, input.cwd);
	if (!agentDefinition) {
		throw new Error(`Agent not found: ${requestedAgent}`);
	}
	if (agentDefinition.maxSubagentDepth > 0) {
		throw new Error(
			`dynamic agent ${agentDefinition.displayName} declares maxSubagentDepth > 0, which is invalid in dynamic generated tasks`,
		);
	}
	const tools =
		executionProfile?.tools ?? input.request.tools ?? agentDefinition.tools;
	if (input.request.tools && !executionProfile && !agentDefinition.tools) {
		throw new Error(
			`dynamic agent ${requestedAgent} does not declare a tools authority ceiling`,
		);
	}
	if (tools && agentDefinition.tools) {
		const allowed = new Set(agentDefinition.tools);
		const missing = tools.filter(
			(tool) => !toolAllowedByAuthorityCeiling(tool, allowed),
		);
		if (missing.length > 0) {
			throw new Error(
				`dynamic agent requested tools not declared by ${requestedAgent}: ${missing.join(", ")}`,
			);
		}
	}
	const forbiddenDelegationTools = (tools ?? []).filter((tool) =>
		DYNAMIC_DELEGATION_TOOLS.has(tool),
	);
	if (forbiddenDelegationTools.length > 0) {
		throw new Error(
			`dynamic agent ${requestedAgent} declares invalid delegation/orchestration tools: ${forbiddenDelegationTools.join(", ")}`,
		);
	}
	const toolProviders =
		executionProfile?.toolProviders ??
		providersForSelectedTools(
			tools,
			new Map(
				Object.entries(
					input.controllerCompiledTask.runtime.toolProviders ?? {},
				),
			),
		);
	const unknownTools = (tools ?? []).filter(
		(tool) => effectiveToolClassification(tool, toolProviders) === undefined,
	);
	if (unknownTools.length > 0) {
		throw new Error(
			`dynamic agent requested tools without trusted classification metadata: ${unknownTools.join(", ")}`,
		);
	}
	assertDynamicExecutionPolicy({
		dynamic: input.dynamic,
		agent: requestedAgent,
		tools,
	});
	const capability = dynamicTaskCapability(tools, toolProviders);
	const requiresWorktree = capability !== "read-only";
	const inputDependsOn = dynamicInputDependencySpecIds(
		input.run,
		input.request.inputs,
	);
	const explicitDependsOn = dynamicDependencySpecIds(
		input.run,
		input.request.dependsOn ?? [],
	);
	const defaultDependsOn = input.controllerCompiledTask.dependsOn ?? [];
	const dependsOn = uniqueStrings(
		input.request.inputs.length > 0 || input.request.dependsOn
			? [...inputDependsOn, ...explicitDependsOn]
			: [...defaultDependsOn],
	);
	const defaultContextDependsOn =
		input.controllerCompiledTask.contextDependsOn ?? defaultDependsOn;
	const contextDependsOn = uniqueStrings(
		input.request.inputs.length > 0 || input.request.dependsOn
			? [...inputDependsOn, ...explicitDependsOn]
			: [...defaultContextDependsOn],
	);
	validateDynamicGeneratedDependencies({
		run: input.run,
		compiledFlow: input.compiledFlow,
		controllerSpecId: input.controllerSpecId,
		generatedSpecId: input.generatedSpecId,
		dependsOn,
		contextDependsOn,
	});
	const refsMinItems = dynamicGeneratedTaskRefsMinItems({
		run: input.run,
		outputProfile: effectiveOutputProfile,
	});
	const refsUrlValidation = dynamicGeneratedTaskRefsUrlValidation({
		run: input.run,
		outputProfile: effectiveOutputProfile,
	});
	const compiledPrompt = [
		`# Workflow Stage\n\nstage=${input.controllerStageId}\ntype=dynamic-agent\nitem=${input.request.id}`,
		`# Instructions\n\n${appendDynamicOutputInstructions(input.request.prompt, effectiveOutputProfile, DYNAMIC_OUTPUT_MAX_DIGEST_CHARS, refsMinItems)}`,
		input.request.compact
			? "# Output Scope\n\nReturn compact typed output. Prefer concise control JSON and artifact refs over pasted context."
			: undefined,
	]
		.filter(Boolean)
		.join("\n\n");
	return {
		id: input.generatedSpecId,
		key: input.generatedSpecId,
		specId: input.generatedSpecId,
		taskId: input.request.id,
		stageId: input.controllerStageId,
		agent: requestedAgent,
		agentPath: agentDefinition.sourcePath,
		agentDescription: agentDefinition.description,
		agentSystemPrompt: agentDefinition.body,
		systemPromptMode: agentDefinition.systemPromptMode,
		inheritProjectContext: agentDefinition.inheritProjectContext,
		inheritSkills: agentDefinition.inheritSkills,
		roleNames: [],
		task: input.request.prompt,
		cwd: input.controllerCompiledTask.cwd,
		explicitCwd: false,
		explicitWorktreePolicy: requiresWorktree,
		runtime: {
			approvalMode: "non-interactive",
			model:
				input.request.model ??
				executionProfile?.model ??
				input.controllerCompiledTask.runtime.model ??
				agentDefinition.model,
			thinking:
				input.request.thinking ??
				executionProfile?.thinking ??
				input.controllerCompiledTask.runtime.thinking ??
				agentDefinition.thinking,
			tools,
			...(toolProviders ? { toolProviders } : {}),
			maxRuntimeMs:
				input.request.maxRuntimeMs ??
				executionProfile?.maxRuntimeMs ??
				input.dynamic.budget.maxRuntimeMs,
		},
		safety: {
			readOnlyDeclared: input.request.readOnly ?? capability === "read-only",
			capability,
			sharedCwdSafe: !requiresWorktree,
			worktreePolicy: requiresWorktree ? "on" : "off",
			requiresWorktree,
			permission: { status: "pending" },
		},
		compiledPrompt,
		kind: "dynamic-agent",
		stageMaxConcurrency: input.dynamic.budget.maxConcurrency,
		dependsOn,
		contextDependsOn,
		artifactGraph: {
			enabled: true,
			output: {
				analysisRequired: true,
				refsRequired: true,
				refsMinItems,
				refsUrlValidation,
				maxDigestChars: DYNAMIC_OUTPUT_MAX_DIGEST_CHARS,
			},
			requiredReads: input.request.requiredReads,
			sourceProjection: dynamicInputSourceProjection(input.request.inputs),
		},
		dynamicGenerated: {
			controllerSpecId: input.controllerSpecId,
			opId: input.opId,
			requestHash: input.requestHash,
			...(input.branchId ? { branchId: input.branchId } : {}),
			...(effectiveOutputProfile
				? { outputProfile: effectiveOutputProfile }
				: {}),
		},
	} as CompiledTask;
}

function dynamicGeneratedTaskRefsMinItems(input: {
	run: WorkflowRunRecord;
	outputProfile: string | undefined;
}): number | undefined {
	if (input.outputProfile !== "synthesis_v1") return undefined;
	return input.run.provenance?.mode === "direct-dynamic" ? 1 : undefined;
}

function dynamicGeneratedTaskRefsUrlValidation(input: {
	run: WorkflowRunRecord;
	outputProfile: string | undefined;
}): boolean | undefined {
	if (!input.outputProfile) return undefined;
	return input.run.provenance?.mode === "direct-dynamic" ? true : undefined;
}

function assertDynamicExecutionProfileRequest(
	request: DynamicAgentRequest,
	profile: NonNullable<CompiledDynamicWorkflowTask["decisionLoop"]>["planner"],
): void {
	if (request.agent && profile?.agent && request.agent !== profile.agent) {
		throw new Error(
			`dynamic execution profile agent mismatch: requested ${request.agent}, profile ${profile.agent}`,
		);
	}
	if (request.tools) {
		throw new Error(
			"dynamic execution profile requests cannot override tools; configure tools in dynamic.decisionLoop",
		);
	}
	if (request.model && profile?.model && request.model !== profile.model) {
		throw new Error("dynamic execution profile requests cannot override model");
	}
	if (
		request.thinking &&
		profile?.thinking &&
		request.thinking !== profile.thinking
	) {
		throw new Error(
			"dynamic execution profile requests cannot override thinking",
		);
	}
	if (
		request.maxRuntimeMs &&
		profile?.maxRuntimeMs &&
		request.maxRuntimeMs !== profile.maxRuntimeMs
	) {
		throw new Error(
			"dynamic execution profile requests cannot override maxRuntimeMs",
		);
	}
}

function assertDynamicOutputProfileAllowed(
	dynamic: CompiledDynamicWorkflowTask,
	outputProfile: string,
): void {
	const allowed = dynamic.decisionLoop?.allowedOutputProfiles;
	if (allowed && allowed.length > 0 && !allowed.includes(outputProfile)) {
		throw new Error(
			`dynamic output profile ${outputProfile} is not allowed by decisionLoop policy`,
		);
	}
}

function assertDynamicExecutionPolicy(input: {
	dynamic: CompiledDynamicWorkflowTask;
	agent: string;
	tools?: string[];
}): void {
	const policy = input.dynamic.decisionLoop;
	if (!policy) return;
	if (
		policy.allowedAgents.length > 0 &&
		!policy.allowedAgents.includes(input.agent)
	) {
		throw new Error(
			`dynamic execution agent ${input.agent} is not allowed by decisionLoop policy`,
		);
	}
	const allowedTools = new Set(policy.allowedTools ?? []);
	if (allowedTools.size > 0) {
		const disallowed = (input.tools ?? []).filter(
			(tool) => !allowedTools.has(tool),
		);
		if (disallowed.length > 0) {
			throw new Error(
				`dynamic execution tools not allowed by decisionLoop policy: ${disallowed.join(", ")}`,
			);
		}
	}
}

function dynamicDecisionLoopProfile(
	dynamic: CompiledDynamicWorkflowTask,
	profileId: string | undefined,
):
	| NonNullable<CompiledDynamicWorkflowTask["decisionLoop"]>["planner"]
	| undefined {
	if (!profileId) return undefined;
	const decisionLoop = dynamic.decisionLoop;
	if (!decisionLoop) return undefined;
	if (profileId === "planner") return decisionLoop.planner;
	if (profileId === "worker" || profileId === "workerDefaults")
		return decisionLoop.workerDefaults;
	if (profileId === "verifier") return decisionLoop.verifier;
	if (profileId === "synthesis") return decisionLoop.synthesis;
	throw new Error(
		`unknown dynamic decision-loop execution profile: ${profileId}`,
	);
}

export function isDynamicCompiledTaskPayload(value: unknown): value is CompiledTask {
	return (
		!!value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		typeof (value as { id?: unknown }).id === "string" &&
		!!(value as { dynamicGenerated?: unknown }).dynamicGenerated
	);
}

export function assertDynamicGeneratedMetadataMatches(
	compiledTask: CompiledTask,
	expected: {
		controllerSpecId: string;
		opId: string;
		requestHash: string;
		requestId: string;
		branchId?: string;
	},
): void {
	const actual = compiledTask.dynamicGenerated;
	if (
		!actual ||
		actual.controllerSpecId !== expected.controllerSpecId ||
		actual.opId !== expected.opId ||
		actual.requestHash !== expected.requestHash ||
		(expected.branchId !== undefined && actual.branchId !== expected.branchId)
	) {
		throw new Error(
			`dynamic agent request changed for id "${expected.requestId}"; generated task metadata does not match replay request`,
		);
	}
}

function validateDynamicGeneratedDependencies(input: {
	run: WorkflowRunRecord;
	compiledFlow: CompiledWorkflow;
	controllerSpecId: string;
	generatedSpecId: string;
	dependsOn: readonly string[];
	contextDependsOn: readonly string[];
}): void {
	for (const dependency of uniqueStrings([
		...input.dependsOn,
		...input.contextDependsOn,
	])) {
		if (dependency === input.controllerSpecId) {
			throw new Error(
				`dynamic generated task cannot depend on its controller (${dependency})`,
			);
		}
		const runTask = input.run.tasks.find((task) => task.specId === dependency);
		const compiledTask = input.compiledFlow.tasks.find(
			(task) => task.id === dependency,
		);
		if (!runTask || !compiledTask) continue;
		if (
			compiledTask.dynamicGenerated?.controllerSpecId !==
				input.controllerSpecId &&
			!isTerminalTaskStatus(runTask.status)
		) {
			throw new Error(
				`dynamic generated task dependency ${dependency} is not completed; dependencies must be completed upstream tasks or generated siblings`,
			);
		}
		if (
			compiledTask.dynamicGenerated?.controllerSpecId !==
				input.controllerSpecId &&
			compiledTaskTransitivelyDependsOn(
				input.compiledFlow,
				compiledTask.id,
				input.controllerSpecId,
			)
		) {
			throw new Error(
				`dynamic generated task dependency ${dependency} depends on controller ${input.controllerSpecId} and would create a controller-child cycle`,
			);
		}
		if (
			compiledTaskTransitivelyDependsOn(
				input.compiledFlow,
				compiledTask.id,
				input.generatedSpecId,
			)
		) {
			throw new Error(
				`dynamic generated task dependency ${dependency} would create a generated-task cycle with ${input.generatedSpecId}`,
			);
		}
	}
}

function compiledTaskTransitivelyDependsOn(
	compiledFlow: CompiledWorkflow,
	fromSpecId: string,
	targetSpecId: string,
	seen = new Set<string>(),
): boolean {
	if (seen.has(fromSpecId)) return false;
	seen.add(fromSpecId);
	const task = compiledFlow.tasks.find(
		(candidate) => candidate.id === fromSpecId,
	);
	if (!task) return false;
	for (const dependency of uniqueStrings([
		...(task.dependsOn ?? []),
		...(task.contextDependsOn ?? []),
	])) {
		if (dependency === targetSpecId) return true;
		if (
			compiledTaskTransitivelyDependsOn(
				compiledFlow,
				dependency,
				targetSpecId,
				seen,
			)
		) {
			return true;
		}
	}
	return false;
}

function dynamicInputSourceProjection(
	inputs: readonly DynamicArtifactInput[],
): NonNullable<CompiledTask["artifactGraph"]>["sourceProjection"] | undefined {
	const include: string[] = [];
	let maxChars: number | undefined;
	for (const input of inputs) {
		const projection = isPlainDynamicRecord(input.options?.projection)
			? input.options?.projection
			: input.options;
		if (!projection) continue;
		const projectionInclude = Array.isArray(projection.include)
			? projection.include.filter(
					(item): item is string => typeof item === "string",
				)
			: [];
		include.push(...projectionInclude);
		if (
			typeof projection.maxChars === "number" &&
			Number.isInteger(projection.maxChars) &&
			projection.maxChars > 0
		) {
			maxChars =
				maxChars === undefined
					? projection.maxChars
					: Math.min(maxChars, projection.maxChars);
		}
	}
	const uniqueInclude = uniqueStrings(include);
	if (uniqueInclude.length === 0 && maxChars === undefined) return undefined;
	return {
		...(uniqueInclude.length > 0 ? { include: uniqueInclude } : {}),
		...(maxChars !== undefined ? { maxChars } : {}),
	};
}

function dynamicInputDependencySpecIds(
	run: WorkflowRunRecord,
	inputs: readonly DynamicArtifactInput[],
): string[] {
	const specIds: string[] = [];
	for (const input of inputs) {
		const source = splitDynamicArtifactName(input.name).source;
		const task = resolveDynamicSourceTask(run, source, {
			required: input.required,
		});
		if (task) specIds.push(task.specId);
	}
	return uniqueStrings(specIds);
}

function dynamicDependencySpecIds(
	run: WorkflowRunRecord,
	refs: readonly string[],
): string[] {
	const specIds: string[] = [];
	for (const ref of refs) {
		const task = resolveDynamicSourceTask(run, ref);
		if (task) specIds.push(task.specId);
	}
	return uniqueStrings(specIds);
}

function splitDynamicArtifactName(name: string): {
	source: string;
	artifact?: string;
} {
	const parts = name.split(".").filter(Boolean);
	const artifact = parts.at(-1);
	if (
		artifact === "control" ||
		artifact === "analysis" ||
		artifact === "refs" ||
		artifact === "raw"
	) {
		const source = parts.slice(0, -1).join(".");
		if (source) return { source, artifact };
	}
	return { source: name };
}

function resolveDynamicSourceTask(
	run: WorkflowRunRecord,
	ref: string,
	options: { required?: boolean } = {},
): WorkflowTaskRunRecord | undefined {
	const exact = run.tasks.find((task) => task.specId === ref);
	if (exact) return exact;
	const byStage = run.tasks.filter((task) => task.stageId === ref);
	if (byStage.length === 1) return byStage[0];
	if (byStage.length > 1) {
		throw new Error(
			`dynamic artifact source "${ref}" is ambiguous; use an exact task specId`,
		);
	}
	if (options.required === false) return undefined;
	throw new Error(`dynamic artifact source not found: ${ref}`);
}

export function dynamicGeneratedInsertIndex(
	compiledFlow: CompiledWorkflow,
	controllerIndex: number,
	controllerSpecId: string,
): number {
	let index = controllerIndex + 1;
	while (
		index < compiledFlow.tasks.length &&
		compiledFlow.tasks[index].dynamicGenerated?.controllerSpecId ===
			controllerSpecId
	) {
		index += 1;
	}
	return index;
}

export async function readDynamicGeneratedTaskResult(
	cwd: string,
	task: WorkflowTaskRunRecord,
): Promise<Record<string, unknown>> {
	if (task.artifactGraph?.enabled) {
		return {
			status: "completed",
			taskId: task.taskId,
			specId: task.specId,
			control: await readArtifactGraphControl(cwd, task),
		};
	}
	const result = await readJson<Record<string, unknown>>(
		fromProjectPath(cwd, task.files.result),
	);
	return {
		status: "completed",
		taskId: task.taskId,
		specId: task.specId,
		result,
	};
}

export function normalizeDynamicAgentRequest(value: unknown): DynamicAgentRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("ctx.agent() request must be an object");
	}
	const record = value as Record<string, unknown>;
	const id = sanitizeTaskId(requiredDynamicString(record.id, "id"));
	if (!id) throw new Error("ctx.agent() id must contain letters or numbers");
	if (id === "controller") {
		throw new Error('ctx.agent() id "controller" is reserved');
	}
	const inputs = normalizeDynamicArtifactInputs(record.inputs);
	return {
		id,
		agent: optionalDynamicString(record.agent ?? record.role, "agent"),
		profile: optionalDynamicString(record.profile, "profile"),
		prompt: requiredDynamicString(record.prompt, "prompt"),
		outputProfile: optionalDynamicOutputProfile(record.outputProfile),
		tools: optionalDynamicStringArray(record.tools, "tools"),
		branchId: optionalDynamicString(record.branchId, "branchId"),
		readOnly: optionalDynamicBoolean(record.readOnly, "readOnly"),
		model: optionalDynamicString(record.model, "model"),
		thinking: optionalDynamicThinking(record.thinking),
		maxRuntimeMs: optionalDynamicPositiveInteger(
			record.maxRuntimeMs,
			"maxRuntimeMs",
		),
		inputs,
		requiredReads:
			optionalDynamicStringArray(record.requiredReads, "requiredReads") ??
			inputs
				.filter((input) => input.required)
				.map((input) => input.name)
				.filter(
					(name) => splitDynamicArtifactName(name).artifact !== undefined,
				),
		dependsOn: optionalDynamicStringArray(record.dependsOn, "dependsOn"),
		compact: record.compact !== false,
	};
}

function requiredDynamicString(
	value: unknown,
	field: string,
	api = "ctx.agent()",
): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${api} ${field} must be a non-empty string`);
	}
	return value.trim();
}

function optionalDynamicString(
	value: unknown,
	field: string,
): string | undefined {
	if (value === undefined) return undefined;
	return requiredDynamicString(value, field);
}

function optionalDynamicStringArray(
	value: unknown,
	field: string,
): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new Error(`ctx.agent() ${field} must be an array of strings`);
	}
	return value.map((item) => item.trim()).filter(Boolean);
}

function normalizeDynamicArtifactInputs(
	value: unknown,
): DynamicArtifactInput[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		throw new Error("ctx.agent() inputs must be an array");
	}
	return value.map((item, index) => normalizeDynamicArtifactInput(item, index));
}

function normalizeDynamicArtifactInput(
	value: unknown,
	index: number,
): DynamicArtifactInput {
	if (typeof value === "string") {
		return {
			kind: "workflow-artifact-ref",
			name: requiredDynamicString(value, `inputs[${index}]`),
			required: true,
		};
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`ctx.agent() inputs[${index}] must be an artifact ref`);
	}
	const record = value as Record<string, unknown>;
	if (record.kind !== "workflow-artifact-ref") {
		throw new Error(
			`ctx.agent() inputs[${index}] must be a workflow artifact ref`,
		);
	}
	const options = isPlainDynamicRecord(record.options)
		? record.options
		: undefined;
	return {
		kind: "workflow-artifact-ref",
		name: requiredDynamicString(record.name, `inputs[${index}].name`),
		...(options ? { options } : {}),
		required: options?.required === false ? false : true,
	};
}

function isPlainDynamicRecord(
	value: unknown,
): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalDynamicBoolean(
	value: unknown,
	field: string,
): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") {
		throw new Error(`ctx.agent() ${field} must be a boolean`);
	}
	return value;
}

function optionalDynamicPositiveInteger(
	value: unknown,
	field: string,
): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new Error(`ctx.agent() ${field} must be a positive integer`);
	}
	return value;
}

function optionalDynamicThinking(value: unknown): ThinkingLevel | undefined {
	if (value === undefined) return undefined;
	if (
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh"
	) {
		return value;
	}
	throw new Error("ctx.agent() thinking has an unsupported value");
}

function requiredDynamicOutputProfile(
	value: unknown,
	field: string,
	api: string,
): DynamicOutputProfile {
	const profile = requiredDynamicString(value, field, api);
	if (!isDynamicOutputProfile(profile)) {
		throw new Error(`${api} ${field} has an unsupported output profile`);
	}
	return profile;
}

function optionalDynamicOutputProfile(
	value: unknown,
): DynamicOutputProfile | undefined {
	if (value === undefined) return undefined;
	return requiredDynamicOutputProfile(value, "outputProfile", "ctx.agent()");
}

function dynamicTaskCapability(
	tools: string[] | undefined,
	toolProviders: Record<string, CompiledToolProvider> | undefined,
): TaskCapability {
	return classifyToolCapability(tools, toolProviders, true, {
		unspecifiedToolsCapability: "mutation-capable",
		emptyToolsCapability: "read-only",
	});
}

function appendDynamicOutputInstructions(
	prompt: string,
	outputProfile?: string,
	maxDigestChars = DYNAMIC_OUTPUT_MAX_DIGEST_CHARS,
	refsMinItems?: number,
): string {
	const refsExample =
		refsMinItems !== undefined && refsMinItems > 0
			? "<refs>[...]</refs>"
			: "<refs>[]</refs>";
	return [
		prompt,
		"# Workflow Output Protocol",
		"Return your final answer exactly as these three sections, in this order, with no prose outside the tags:",
		"<control>{...}</control>",
		"<analysis>...</analysis>",
		refsExample,
		"The <control> section must be valid JSON object data with non-empty string `schema` and `digest` fields.",
		`The control.digest string must be at most ${maxDigestChars} characters; prefer one short sentence.`,
		"Use schema `dynamic-task-result-v1` unless the dynamic controller asks for a more specific control schema.",
		refsMinItems !== undefined && refsMinItems > 0
			? `The <refs> JSON array must include at least ${refsMinItems} item${refsMinItems === 1 ? "" : "s"}. Include URLs or local file paths used by the analysis. Verify external URLs with available workflow web fetch/source-read tools before including them; do not include stale, guessed, or unreachable URLs.`
			: undefined,
		dynamicOutputProfileInstructions(outputProfile),
	]
		.filter(Boolean)
		.join("\n\n");
}

function dynamicOutputProfileInstructions(
	outputProfile: string | undefined,
): string | undefined {
	if (!outputProfile) return undefined;
	if (outputProfile === "candidate_findings_v1") {
		return [
			"# Dynamic Output Profile: candidate_findings_v1",
			"Your <control> JSON should include `findings` as an array of candidate findings.",
			"Each finding should include stable `id`, `title` or `summary`, `severity`, `confidence`, and `evidenceRefs` when evidence exists.",
			"When using URL evidence, verify the URL with available tools before adding it to <refs> or evidenceRefs; put unreachable or uncertain sources in gaps instead of refs.",
			"Use `gaps`, `blockers`, `conflicts`, or `omissions` arrays for incomplete work instead of hiding it.",
		].join("\n");
	}
	if (outputProfile === "verification_result_v1") {
		return [
			"# Dynamic Output Profile: verification_result_v1",
			"Your <control> JSON must include `findingId` and `verdict`.",
			"`verdict` must be one of verified, rejected, weakened, or inconclusive.",
			"Check cited URL/source refs with available tools before returning verified or weakened; use inconclusive when source availability or support cannot be established.",
			"Include `confidence`, `evidenceRefs`, concise `notes`, and a `claimSupports` array when sources support or contradict the finding.",
			"Each `claimSupports` entry should include `claim`, `status` (supports, partial, contradicts, unsupported, inconclusive), `sourceLocators` with verified URL/path refs, and a short `excerpt` or `notes` explaining the support.",
		].join("\n");
	}
	if (outputProfile === "coverage_assessment_v1") {
		return [
			"# Dynamic Output Profile: coverage_assessment_v1",
			"Your <control> JSON should include `criteriaCoverage` or `coverage` as an array.",
			"Each entry should include `criterionId`, `status`, `evidenceRefs`, and `notes` when useful.",
		].join("\n");
	}
	if (outputProfile === "synthesis_v1") {
		return "# Dynamic Output Profile: synthesis_v1\nYour <control> JSON should include a compact final synthesis summary, caveats, and any remaining blockers or omissions. Final refs must come from verified upstream source ledgers; prefer sources with positive claimSupports and do not introduce new URL refs in synthesis.";
	}
	if (outputProfile === "generic_summary_v1") {
		return "# Dynamic Output Profile: generic_summary_v1\nYour <control> JSON may be a compact summary, but include gaps/blockers/omissions if the result needs manual review.";
	}
	return `# Dynamic Output Profile: ${outputProfile}\nEmit control JSON suitable for this output profile and surface gaps/blockers explicitly.`;
}

function uniqueStrings(values: readonly string[]): string[] {
	return [...new Set(values.filter((value) => value.trim().length > 0))];
}
