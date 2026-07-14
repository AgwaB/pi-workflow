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
	const thinkingResolution = resolveThinking(model, effectiveThinking, options);
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

// Mirrors pi-ai getSupportedThinkingLevels: a non-reasoning model only
// supports "off", and "xhigh" is opt-in via an explicit thinkingLevelMap
// entry. When no model info is available (model not in the registry), defer
// to the child pi CLI clamp by allowing every level.
export function getSupportedThinkingLevels(
	model: WorkflowModelInfo | undefined,
): ThinkingLevel[] {
	if (!model) return [...THINKING_LEVELS];
	if (!model.reasoning) return ["off"];

	return THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh") return mapped !== undefined;
		return true;
	});
}

// Mirrors pi-ai clampThinkingLevel: nearest supported level scanning up
// from the request first, then down; never throws and never prompts.
export function clampSupportedThinkingLevel(
	supported: ThinkingLevel[],
	requested: ThinkingLevel,
): ThinkingLevel {
	if (supported.includes(requested)) return requested;
	const requestedIndex = THINKING_LEVELS.indexOf(requested);
	if (requestedIndex === -1) return supported[0] ?? "off";
	for (let i = requestedIndex; i < THINKING_LEVELS.length; i += 1) {
		const candidate = THINKING_LEVELS[i]!;
		if (supported.includes(candidate)) return candidate;
	}
	for (let i = requestedIndex - 1; i >= 0; i -= 1) {
		const candidate = THINKING_LEVELS[i]!;
		if (supported.includes(candidate)) return candidate;
	}
	return supported[0] ?? "off";
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

// Follows the pi SDK: unsupported thinking requests are deterministically
// clamped (up first, then down) instead of prompting or throwing, and the
// adjustment is recorded in thinkingResolution.reason.
function resolveThinking(
	modelId: string | undefined,
	requested: ThinkingLevel | undefined,
	options: ResolveWorkflowRuntimeOptions,
): WorkflowRuntimeThinkingResolution | undefined {
	if (!requested) return undefined;
	const model = findModelInfo(modelId, options.availableModels ?? []);
	const supported = getSupportedThinkingLevels(model);
	if (supported.includes(requested)) {
		return { requested, resolved: requested };
	}
	const resolved = clampSupportedThinkingLevel(supported, requested);
	return {
		requested,
		resolved,
		reason: `requested ${requested} is unsupported by ${modelId ?? "selected model"}; using ${resolved}`,
	};
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

type SimpleJsonPathToken =
	| { type: "property"; key: string }
	| { type: "index"; index: number }
	| { type: "slice"; start?: number; end?: number }
	| { type: "wildcard" };

const SIMPLE_JSON_PATH_SELECTION = Symbol("simpleJsonPathSelection");

interface SimpleJsonPathSelection {
	[SIMPLE_JSON_PATH_SELECTION]: true;
	values: unknown[];
}

export function isSimpleJsonPath(path: string): boolean {
	return parseSimpleJsonPath(path) !== undefined;
}

export function readSimpleJsonPath(value: unknown, path: string): unknown {
	const tokens = parseSimpleJsonPath(path);
	if (!tokens) return undefined;
	let current: unknown = value;
	for (const token of tokens) {
		current = applySimpleJsonPathToken(current, token);
		if (current === undefined) return undefined;
	}
	return unwrapJsonPathSelection(current);
}

function parseSimpleJsonPath(path: string): SimpleJsonPathToken[] | undefined {
	if (path === "$" || path.length === 1) return path === "$" ? [] : undefined;
	if (!path.startsWith("$")) return undefined;
	const tokens: SimpleJsonPathToken[] = [];
	let index = 1;
	while (index < path.length) {
		const char = path[index];
		if (char === ".") {
			index += 1;
			const keyStart = index;
			while (index < path.length && isJsonPathKeyChar(path[index]!)) {
				index += 1;
			}
			if (index === keyStart) return undefined;
			const key = path.slice(keyStart, index);
			if (!isSafeJsonPathPart(key)) return undefined;
			tokens.push({ type: "property", key });
			continue;
		}
		if (char === "[") {
			const end = path.indexOf("]", index + 1);
			if (end === -1) return undefined;
			const selector = path.slice(index + 1, end);
			const token = parseSimpleJsonPathArraySelector(selector);
			if (!token) return undefined;
			tokens.push(token);
			index = end + 1;
			continue;
		}
		return undefined;
	}
	return tokens;
}

function parseSimpleJsonPathArraySelector(
	selector: string,
): SimpleJsonPathToken | undefined {
	if (selector === "*") return { type: "wildcard" };
	if (/^\d+$/u.test(selector)) {
		const index = parseSafeJsonPathInteger(selector);
		return index === undefined ? undefined : { type: "index", index };
	}
	const slice = /^(\d*):(\d*)$/u.exec(selector);
	if (!slice) return undefined;
	const start = slice[1] ? parseSafeJsonPathInteger(slice[1]) : undefined;
	const end = slice[2] ? parseSafeJsonPathInteger(slice[2]) : undefined;
	if ((slice[1] && start === undefined) || (slice[2] && end === undefined)) {
		return undefined;
	}
	return {
		type: "slice",
		...(start === undefined ? {} : { start }),
		...(end === undefined ? {} : { end }),
	};
}

function parseSafeJsonPathInteger(value: string): number | undefined {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function applySimpleJsonPathToken(
	value: unknown,
	token: SimpleJsonPathToken,
): unknown {
	if (token.type === "property") return readJsonPathProperty(value, token.key);
	if (token.type === "index") return readJsonPathIndex(value, token.index);
	if (token.type === "wildcard") return readJsonPathSlice(value, 0);
	return readJsonPathSlice(value, token.start ?? 0, token.end);
}

function readJsonPathProperty(value: unknown, key: string): unknown {
	if (isJsonPathSelection(value)) {
		return mapJsonPathSelection(value, (item) =>
			readOwnJsonPathPart(item, key),
		);
	}
	return readOwnJsonPathPart(value, key);
}

function readJsonPathIndex(value: unknown, index: number): unknown {
	if (isJsonPathSelection(value)) {
		return mapJsonPathSelection(value, (item) =>
			readOwnJsonPathIndex(item, index),
		);
	}
	return readOwnJsonPathIndex(value, index);
}

function readJsonPathSlice(
	value: unknown,
	start: number,
	end?: number,
): unknown {
	if (isJsonPathSelection(value)) {
		const values: unknown[] = [];
		for (const item of value.values) {
			const sliced = readOwnJsonPathSlice(item, start, end);
			if (!sliced) return undefined;
			values.push(...sliced);
		}
		return makeJsonPathSelection(values);
	}
	const sliced = readOwnJsonPathSlice(value, start, end);
	return sliced ? makeJsonPathSelection(sliced) : undefined;
}

function readOwnJsonPathPart(value: unknown, part: string): unknown {
	if (!canReadJsonPathPart(value, part)) return undefined;
	return value[part];
}

function readOwnJsonPathIndex(value: unknown, index: number): unknown {
	if (!Array.isArray(value) || index >= value.length) return undefined;
	if (!Object.hasOwn(value, index)) return undefined;
	return value[index];
}

function readOwnJsonPathSlice(
	value: unknown,
	start: number,
	end?: number,
): unknown[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const boundedEnd = Math.min(end ?? value.length, value.length);
	const values: unknown[] = [];
	for (let index = start; index < boundedEnd; index += 1) {
		if (Object.hasOwn(value, index)) values.push(value[index]);
	}
	return values;
}

function mapJsonPathSelection(
	selection: SimpleJsonPathSelection,
	read: (value: unknown) => unknown,
): unknown {
	const values: unknown[] = [];
	for (const item of selection.values) {
		const next = read(item);
		if (next === undefined) return undefined;
		values.push(next);
	}
	return makeJsonPathSelection(values);
}

function makeJsonPathSelection(values: unknown[]): SimpleJsonPathSelection {
	return { [SIMPLE_JSON_PATH_SELECTION]: true, values };
}

function unwrapJsonPathSelection(value: unknown): unknown {
	return isJsonPathSelection(value) ? value.values : value;
}

function isJsonPathSelection(value: unknown): value is SimpleJsonPathSelection {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as Partial<SimpleJsonPathSelection>)[SIMPLE_JSON_PATH_SELECTION] ===
			true &&
		Array.isArray((value as { values?: unknown }).values)
	);
}

function canReadJsonPathPart(
	value: unknown,
	part: string,
): value is Record<string, unknown> {
	return (
		isSafeJsonPathPart(part) && isRecord(value) && Object.hasOwn(value, part)
	);
}

function isJsonPathKeyChar(value: string): boolean {
	return /[A-Za-z0-9_-]/u.test(value);
}

function isSafeJsonPathPart(part: string): boolean {
	return part !== "__proto__" && part !== "prototype" && part !== "constructor";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
