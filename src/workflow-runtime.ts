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

export interface WorkflowRuntimeThinkingResolution {
	requested?: ThinkingLevel;
	resolved?: ThinkingLevel;
	reason?: string;
}

export interface WorkflowRuntimeResolutionInput {
	model?: string;
	thinking?: ThinkingLevel;
	thinkingResolution?: WorkflowRuntimeThinkingResolution;
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

export type WorkflowRuntimeLayer = WorkflowRuntimeDefaults | undefined;

export function selectWorkflowRuntime(
	...layers: WorkflowRuntimeLayer[]
): WorkflowRuntimeResolutionInput {
	const modelLayer = layers.find((layer) => modelOf(layer));
	const model = modelOf(modelLayer);
	let thinking: ThinkingLevel | undefined;
	for (const layer of layers) {
		if (!layer) continue;
		if (layer.thinking) {
			thinking = layer.thinking;
			break;
		}
		const layerModel = modelOf(layer);
		const modelThinking = layerModel
			? splitKnownThinkingSuffix(layerModel).thinking
			: undefined;
		if (modelThinking) {
			thinking = modelThinking;
			break;
		}
	}
	return {
		...(model ? { model } : {}),
		...(thinking ? { thinking } : {}),
	};
}

function modelOf(layer: WorkflowRuntimeLayer): string | undefined {
	return typeof layer?.model === "string" && layer.model.trim()
		? layer.model.trim()
		: undefined;
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
	const thinkingResolution = await resolveThinking(
		model,
		effectiveThinking,
		context,
		options,
	);
	return {
		...(model ? { model } : {}),
		...(thinkingResolution?.resolved
			? { thinking: thinkingResolution.resolved }
			: {}),
		...(thinkingResolution ? { thinkingResolution } : {}),
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
): Promise<WorkflowRuntimeThinkingResolution | undefined> {
	if (!requested) return undefined;
	const model = findModelInfo(modelId, options.availableModels ?? []);
	const supported = getSupportedThinkingLevels(model);
	if (supported.includes(requested)) {
		return { requested, resolved: requested };
	}

	if (supported.length === 0) {
		throw new Error(
			`${modelId ?? "selected model"} does not expose any supported reasoning levels for ${context.taskKey}`,
		);
	}

	const downgradeOptions = lowerOrEqualSupportedThinking(requested, supported);
	if (downgradeOptions.length === 0) {
		const modelLabel = modelId ?? "selected model";
		throw new Error(
			`${modelLabel} does not support reasoning level "${requested}" for ${context.taskKey}, and no lower-or-equal fallback is available. Supported: ${supported.join(", ") || "none"}`,
		);
	}

	if (!options.prompt) {
		const resolved = downgradeOptions[downgradeOptions.length - 1]!;
		return {
			requested,
			resolved,
			reason: `requested ${requested} is unsupported by ${modelId ?? "selected model"}; using ${resolved}`,
		};
	}

	const selected = await options.prompt.select(
		`${modelId ?? "Selected model"} does not support reasoning "${requested}" for ${context.taskKey}. Choose a supported lower-or-equal level.`,
		downgradeOptions,
	);
	if (!selected)
		throw new Error(`Reasoning selection cancelled for ${context.taskKey}`);
	if (!isThinkingLevel(selected) || !downgradeOptions.includes(selected))
		throw new Error(
			`Invalid reasoning selection "${selected}" for ${context.taskKey}`,
		);
	return {
		requested,
		resolved: selected,
		reason: `selected supported reasoning ${selected} for unsupported request ${requested}`,
	};
}

function lowerOrEqualSupportedThinking(
	requested: ThinkingLevel,
	supported: ThinkingLevel[],
): ThinkingLevel[] {
	const requestedIndex = THINKING_LEVELS.indexOf(requested);
	if (requestedIndex < 0) return [];
	return THINKING_LEVELS.slice(0, requestedIndex + 1).filter((level) =>
		supported.includes(level),
	);
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
