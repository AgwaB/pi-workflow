import { THINKING_LEVELS, type ThinkingLevel } from "./types.js";

export type FlowModelThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

export interface FlowModelInfo {
  provider: string;
  id: string;
  fullId: string;
  reasoning?: boolean;
  thinkingLevelMap?: FlowModelThinkingLevelMap;
}

export interface FlowRuntimeDefaults {
  model?: string;
  thinking?: ThinkingLevel;
}

export interface FlowRuntimeResolutionInput {
  model?: string;
  thinking?: ThinkingLevel;
}

export interface FlowRuntimeResolutionContext {
  taskKey: string;
  stageId: string;
  taskId: string;
  agent: string;
}

export type FlowRuntimeResolver = (
  runtime: FlowRuntimeResolutionInput,
  context: FlowRuntimeResolutionContext,
) => Promise<FlowRuntimeResolutionInput>;

export interface FlowRuntimePrompt {
  select(title: string, options: string[]): Promise<string | undefined>;
}

export interface ResolveFlowRuntimeOptions {
  defaults?: FlowRuntimeDefaults;
  availableModels?: FlowModelInfo[];
  prompt?: FlowRuntimePrompt;
}

export function toFlowModelInfo(model: {
  provider: string;
  id: string;
  reasoning?: boolean;
  thinkingLevelMap?: FlowModelThinkingLevelMap;
}): FlowModelInfo {
  return {
    provider: model.provider,
    id: model.id,
    fullId: `${model.provider}/${model.id}`,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
  };
}

export async function resolveFlowRuntime(
  runtime: FlowRuntimeResolutionInput,
  context: FlowRuntimeResolutionContext,
  options: ResolveFlowRuntimeOptions,
): Promise<FlowRuntimeResolutionInput> {
  const requested = runtime.model ?? options.defaults?.model;
  const { baseModel, thinking } = requested ? splitKnownThinkingSuffix(requested) : { baseModel: undefined, thinking: undefined };
  const model = await resolveModel(baseModel, context, options);
  const effectiveThinking = runtime.thinking ?? thinking ?? options.defaults?.thinking;
  const resolvedThinking = await resolveThinking(model, effectiveThinking, context, options);
  return {
    ...(model ? { model } : {}),
    ...(resolvedThinking ? { thinking: resolvedThinking } : {}),
  };
}

export function splitKnownThinkingSuffix(model: string): { baseModel: string; thinking?: ThinkingLevel } {
  const colonIdx = model.lastIndexOf(":");
  if (colonIdx === -1) return { baseModel: model };
  const suffix = model.slice(colonIdx + 1);
  if (!isThinkingLevel(suffix)) return { baseModel: model };
  return {
    baseModel: model.slice(0, colonIdx),
    thinking: suffix,
  };
}

export function getSupportedThinkingLevels(model: FlowModelInfo | undefined): ThinkingLevel[] {
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
  context: FlowRuntimeResolutionContext,
  options: ResolveFlowRuntimeOptions,
): Promise<string | undefined> {
  if (!requested) return undefined;
  const available = options.availableModels ?? [];
  if (available.length === 0) return requested;

  if (requested.includes("/")) {
    const exact = available.find((model) => model.fullId === requested);
    if (exact) return exact.fullId;
    throw new Error(`Model "${requested}" for ${context.taskKey} is not available in /model`);
  }

  const exactMatches = available.filter((model) => model.id === requested);
  if (exactMatches.length === 1) return exactMatches[0]!.fullId;
  if (exactMatches.length > 1) return chooseAmbiguousModel(requested, exactMatches, context, options.prompt);

  const query = requested.toLowerCase();
  const fuzzyMatches = available.filter((model) =>
    model.fullId.toLowerCase().includes(query) ||
    model.id.toLowerCase().includes(query) ||
    model.provider.toLowerCase().includes(query)
  );
  if (fuzzyMatches.length === 1) return fuzzyMatches[0]!.fullId;
  if (fuzzyMatches.length > 1) return chooseAmbiguousModel(requested, fuzzyMatches, context, options.prompt);

  throw new Error(`Model "${requested}" for ${context.taskKey} did not match any available /model entry`);
}

async function chooseAmbiguousModel(
  requested: string,
  matches: FlowModelInfo[],
  context: FlowRuntimeResolutionContext,
  prompt: FlowRuntimePrompt | undefined,
): Promise<string> {
  const choices = matches.map((model) => model.fullId).sort();
  if (!prompt) {
    throw new Error(`Model "${requested}" for ${context.taskKey} is ambiguous in /model: ${choices.join(", ")}`);
  }
  const selected = await prompt.select(`Model "${requested}" is ambiguous for ${context.taskKey}. Choose one.`, choices);
  if (!selected) throw new Error(`Model selection cancelled for ${context.taskKey}`);
  return selected;
}

async function resolveThinking(
  modelId: string | undefined,
  requested: ThinkingLevel | undefined,
  context: FlowRuntimeResolutionContext,
  options: ResolveFlowRuntimeOptions,
): Promise<ThinkingLevel | undefined> {
  if (!requested) return undefined;
  const model = findModelInfo(modelId, options.availableModels ?? []);
  const supported = getSupportedThinkingLevels(model);
  if (supported.includes(requested)) return requested;

  if (!options.prompt) {
    const modelLabel = modelId ?? "selected model";
    throw new Error(`${modelLabel} does not support reasoning level "${requested}" for ${context.taskKey}. Supported: ${supported.join(", ") || "none"}`);
  }

  if (supported.length === 0) {
    throw new Error(`${modelId ?? "selected model"} does not expose any supported reasoning levels for ${context.taskKey}`);
  }

  const selected = await options.prompt.select(
    `${modelId ?? "Selected model"} does not support reasoning "${requested}" for ${context.taskKey}. Choose a supported level.`,
    supported,
  );
  if (!selected) throw new Error(`Reasoning selection cancelled for ${context.taskKey}`);
  if (!isThinkingLevel(selected)) throw new Error(`Invalid reasoning selection "${selected}" for ${context.taskKey}`);
  return selected;
}

function findModelInfo(modelId: string | undefined, available: FlowModelInfo[]): FlowModelInfo | undefined {
  if (!modelId) return undefined;
  const { baseModel } = splitKnownThinkingSuffix(modelId);
  return available.find((model) => model.fullId === baseModel);
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}
