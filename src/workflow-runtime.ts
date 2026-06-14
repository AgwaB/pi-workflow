import { THINKING_LEVELS, type ThinkingLevel } from "./types.js";

export type WorkflowModelThinkingLevelMap = Partial<
	Record<ThinkingLevel, string | null>
>;

export interface WorkflowModelInfo {
	provider: string;
	id: string;
	fullId: string;
	reasoning?: boolean;
	thinkingLevelMap?: WorkflowModelThinkingLevelMap;
}

export interface WorkflowRuntimeDefaults {
	model?: string;
	thinking?: ThinkingLevel;
}

export interface WorkflowRuntimeResolutionInput {
	model?: string;
	thinking?: ThinkingLevel;
}

export interface WorkflowRuntimeResolutionContext {
	taskKey: string;
	stageId: string;
	taskId: string;
	agent: string;
}

export interface WorkflowRuntimePrompt {
	select(title: string, options: string[]): Promise<string | undefined>;
}

export interface ResolveWorkflowRuntimeOptions {
	defaults?: WorkflowRuntimeDefaults;
	availableModels?: WorkflowModelInfo[];
	prompt?: WorkflowRuntimePrompt;
}

export function toWorkflowModelInfo(model: {
	provider: string;
	id: string;
	reasoning?: boolean;
	thinkingLevelMap?: WorkflowModelThinkingLevelMap;
}): WorkflowModelInfo {
	return {
		provider: model.provider,
		id: model.id,
		fullId: `${model.provider}/${model.id}`,
		reasoning: model.reasoning,
		thinkingLevelMap: model.thinkingLevelMap,
	};
}

export async function resolveWorkflowRuntime(
	runtime: WorkflowRuntimeResolutionInput,
	context: WorkflowRuntimeResolutionContext,
	options: ResolveWorkflowRuntimeOptions,
): Promise<WorkflowRuntimeResolutionInput> {
	const requested = runtime.model ?? options.defaults?.model;
	const { baseModel, thinking } = requested
		? splitKnownThinkingSuffix(requested)
		: { baseModel: undefined, thinking: undefined };
	const model = await resolveModel(baseModel, context, options);
	const effectiveThinking =
		runtime.thinking ?? thinking ?? options.defaults?.thinking;
	const resolvedThinking = await resolveThinking(
		model,
		effectiveThinking,
		context,
		options,
	);
	return {
		...(model ? { model } : {}),
		...(resolvedThinking ? { thinking: resolvedThinking } : {}),
	};
}

export function splitKnownThinkingSuffix(model: string): {
	baseModel: string;
	thinking?: ThinkingLevel;
} {
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx === -1) return { baseModel: model };
	const suffix = model.slice(colonIdx + 1);
	if (!isThinkingLevel(suffix)) return { baseModel: model };
	return {
		baseModel: model.slice(0, colonIdx),
		thinking: suffix,
	};
}

export function getSupportedThinkingLevels(
	model: WorkflowModelInfo | undefined,
): ThinkingLevel[] {
	if (!model) return [...THINKING_LEVELS];
	if (model.reasoning === false) return ["off"];
	if (!model.thinkingLevelMap) return [...THINKING_LEVELS];

	return THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh") return mapped !== undefined;
		return true;
	});
}

async function resolveModel(
	requested: string | undefined,
	context: WorkflowRuntimeResolutionContext,
	options: ResolveWorkflowRuntimeOptions,
): Promise<string | undefined> {
	if (!requested) return undefined;
	const available = options.availableModels ?? [];
	if (available.length === 0) return requested;

	if (requested.includes("/")) {
		const exact = available.find((model) => model.fullId === requested);
		if (exact) return exact.fullId;
		return chooseAvailableModelForMissing(
			requested,
			available,
			context,
			options.prompt,
		);
	}

	const exactMatches = available.filter((model) => model.id === requested);
	if (exactMatches.length === 1) return exactMatches[0]!.fullId;
	if (exactMatches.length > 1)
		return chooseAmbiguousModel(
			requested,
			exactMatches,
			context,
			options.prompt,
		);

	const query = requested.toLowerCase();
	const fuzzyMatches = available.filter(
		(model) =>
			model.fullId.toLowerCase().includes(query) ||
			model.id.toLowerCase().includes(query) ||
			model.provider.toLowerCase().includes(query),
	);
	if (fuzzyMatches.length === 1) return fuzzyMatches[0]!.fullId;
	if (fuzzyMatches.length > 1)
		return chooseAmbiguousModel(
			requested,
			fuzzyMatches,
			context,
			options.prompt,
		);

	return chooseAvailableModelForMissing(
		requested,
		available,
		context,
		options.prompt,
	);
}

async function chooseAmbiguousModel(
	requested: string,
	matches: WorkflowModelInfo[],
	context: WorkflowRuntimeResolutionContext,
	prompt: WorkflowRuntimePrompt | undefined,
): Promise<string> {
	const choices = matches.map((model) => model.fullId).sort();
	if (!prompt) {
		throw new Error(
			`Model "${requested}" for ${context.taskKey} is ambiguous in /model: ${choices.join(", ")}`,
		);
	}
	const selected = await prompt.select(
		`Model "${requested}" is ambiguous for ${context.taskKey}. Choose one.`,
		choices,
	);
	if (!selected)
		throw new Error(`Model selection cancelled for ${context.taskKey}`);
	return selected;
}

async function chooseAvailableModelForMissing(
	requested: string,
	available: WorkflowModelInfo[],
	context: WorkflowRuntimeResolutionContext,
	prompt: WorkflowRuntimePrompt | undefined,
): Promise<string> {
	const choices = available.map((model) => model.fullId).sort();
	if (!prompt) {
		throw new Error(
			`Model "${requested}" for ${context.taskKey} did not match any available /model entry`,
		);
	}
	const selected = await prompt.select(
		`Model "${requested}" is not available for ${context.taskKey}. Choose a /model entry.`,
		choices,
	);
	if (!selected)
		throw new Error(`Model selection cancelled for ${context.taskKey}`);
	return selected;
}

async function resolveThinking(
	modelId: string | undefined,
	requested: ThinkingLevel | undefined,
	context: WorkflowRuntimeResolutionContext,
	options: ResolveWorkflowRuntimeOptions,
): Promise<ThinkingLevel | undefined> {
	if (!requested) return undefined;
	const model = findModelInfo(modelId, options.availableModels ?? []);
	const supported = getSupportedThinkingLevels(model);
	if (supported.includes(requested)) return requested;

	if (!options.prompt) {
		const modelLabel = modelId ?? "selected model";
		throw new Error(
			`${modelLabel} does not support reasoning level "${requested}" for ${context.taskKey}. Supported: ${supported.join(", ") || "none"}`,
		);
	}

	if (supported.length === 0) {
		throw new Error(
			`${modelId ?? "selected model"} does not expose any supported reasoning levels for ${context.taskKey}`,
		);
	}

	const selected = await options.prompt.select(
		`${modelId ?? "Selected model"} does not support reasoning "${requested}" for ${context.taskKey}. Choose a supported level.`,
		supported,
	);
	if (!selected)
		throw new Error(`Reasoning selection cancelled for ${context.taskKey}`);
	if (!isThinkingLevel(selected))
		throw new Error(
			`Invalid reasoning selection "${selected}" for ${context.taskKey}`,
		);
	return selected;
}

function findModelInfo(
	modelId: string | undefined,
	available: WorkflowModelInfo[],
): WorkflowModelInfo | undefined {
	if (!modelId) return undefined;
	const { baseModel } = splitKnownThinkingSuffix(modelId);
	return available.find((model) => model.fullId === baseModel);
}

function isThinkingLevel(value: string): value is ThinkingLevel {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}

export function shouldScheduleAfterStageFailure(stage: {
	type?: string;
	sourcePolicy?: string;
}): boolean {
	return stage.type === "foreach" && stage.sourcePolicy === "partial";
}

export function canStageProceedAfterPreviousFailure(
	stage: { sourceStageIds?: string[]; sourcePolicy?: string },
	previous: { id?: string },
): boolean {
	if (!stage.sourceStageIds || stage.sourceStageIds.length === 0) return false;
	if (!stage.sourceStageIds.includes(previous.id ?? "")) return true;
	return stage.sourcePolicy === "partial";
}

export function readSimpleJsonPath(value: unknown, path: string): unknown {
	const parts = path.slice(2).split(".").filter(Boolean);
	let current = value as any;
	for (const part of parts) {
		if (current === null || typeof current !== "object" || !(part in current))
			return undefined;
		current = current[part];
	}
	return current;
}
