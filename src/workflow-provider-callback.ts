import { redactSensitiveWorkflowText } from "./workflow-sensitive-query.js";

/**
 * Boundary for provider progress callbacks. Provider updates are untrusted,
 * user-visible data: keep only the small ToolResult-shaped surface we support,
 * redact it recursively, and make the callback inert as soon as the provider
 * invocation settles.
 */

const SAFE_UPDATE_KEYS = new Set(["content", "details", "isError"]);
const SAFE_DETAIL_KEYS = new Set([
	"status",
	"phase",
	"message",
	"progress",
	"current",
	"total",
	"provider",
	"providers",
	"queryCount",
	"successfulQueries",
	"totalResults",
	"url",
	"title",
	"truncated",
]);
const MAX_UPDATE_DEPTH = 8;
const MAX_UPDATE_ARRAY_ITEMS = 100;
// These are input-boundary limits, not merely output limits. In particular,
// never hand an unbounded provider string to the redactor.
const MAX_UPDATE_NODES = 512;
const MAX_UPDATE_KEYS = 512;
const MAX_UPDATE_INPUT_STRING_BYTES = 16 * 1024;

type SafeUpdateOptions = {
	/** Maximum visible characters for this callback stream. */
	maxVisibleChars?: number;
	/** Called with the number of characters actually exposed. */
	onVisibleChars?: (count: number) => void;
};

type UpdateBudget = {
	limit: number;
	used: number;
	onVisibleChars?: (count: number) => void;
};

type SanitizationBudget = {
	nodes: number;
	keys: number;
	inputStringBytes: number;
};

export type SafeProviderOnUpdateGate = {
	callback: unknown;
	close: () => void;
};

export function createSafeProviderOnUpdate(
	onUpdate: unknown,
	options: SafeUpdateOptions = {},
): SafeProviderOnUpdateGate {
	let active = typeof onUpdate === "function";
	const budget: UpdateBudget | undefined =
		options.maxVisibleChars === undefined
			? undefined
			: {
				limit: Math.max(0, Math.floor(options.maxVisibleChars)),
				used: 0,
				onVisibleChars: options.onVisibleChars,
			};
	const callback = (update: unknown): void => {
		if (!active || typeof onUpdate !== "function") return;
		const safe = sanitizeProviderUpdate(update, budget);
		if (!safe) return;
		try {
			(onUpdate as (value: unknown) => void)(safe);
		} catch {
			// A host callback is presentation-only. A provider must not turn a
			// late or malformed progress update into a tool execution failure.
		}
	};
	return {
		callback,
		close: () => {
			active = false;
		},
	};
}

function sanitizeProviderUpdate(
	value: unknown,
	budget: UpdateBudget | undefined,
): Record<string, unknown> | undefined {
	if (!isRecord(value)) return undefined;
	const limits: SanitizationBudget = { nodes: 0, keys: 0, inputStringBytes: 0 };
	if (!consumeNode(limits)) return undefined;
	const output: Record<string, unknown> = {};
	for (const key in value) {
		if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
		if (!consumeKey(limits)) break;
		const item = value[key];
		if (!SAFE_UPDATE_KEYS.has(key)) continue;
		if (key === "content") {
			if (!Array.isArray(item)) continue;
			const content: Record<string, unknown>[] = [];
			for (let index = 0; index < item.length && index < MAX_UPDATE_ARRAY_ITEMS; index += 1) {
				const entry = sanitizeContentEntry(item[index], budget, limits);
				if (entry) content.push(entry);
			}
			if (content.length > 0) output.content = content;
			continue;
		}
		if (key === "details") {
			const details = sanitizeDetails(item, budget, 0, limits);
			if (details && Object.keys(details).length > 0) output.details = details;
			continue;
		}
		if (typeof item === "boolean") output.isError = item;
	}
	return Object.keys(output).length > 0 ? output : undefined;
}

function sanitizeContentEntry(
	value: unknown,
	budget: UpdateBudget | undefined,
	limits: SanitizationBudget,
): Record<string, unknown> | undefined {
	if (!isRecord(value) || !consumeNode(limits)) return undefined;
	let type: unknown;
	let textValue: unknown;
	for (const key in value) {
		if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
		if (!consumeKey(limits)) break;
		if (key === "type") type = value[key];
		if (key === "text") textValue = value[key];
	}
	if (type !== "text" || typeof textValue !== "string") return undefined;
	const bounded = boundedInputString(textValue, limits);
	if (bounded === undefined) return undefined;
	const text = visibleString(bounded, budget);
	return text ? { type: "text", text } : undefined;
}

function sanitizeDetails(
	value: unknown,
	budget: UpdateBudget | undefined,
	depth: number,
	limits: SanitizationBudget,
): Record<string, unknown> | undefined {
	if (!isRecord(value) || depth > MAX_UPDATE_DEPTH || !consumeNode(limits)) return undefined;
	const output: Record<string, unknown> = {};
	for (const key in value) {
		if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
		if (!consumeKey(limits)) break;
		if (!SAFE_DETAIL_KEYS.has(key)) continue;
		const sanitized = sanitizeValue(value[key], budget, depth + 1, limits);
		if (sanitized !== undefined) output[key] = sanitized;
	}
	return output;
}

function sanitizeValue(
	value: unknown,
	budget: UpdateBudget | undefined,
	depth: number,
	limits: SanitizationBudget,
): unknown {
	if (depth > MAX_UPDATE_DEPTH || !consumeNode(limits)) return undefined;
	if (typeof value === "string") {
		const bounded = boundedInputString(value, limits);
		return bounded === undefined ? undefined : visibleString(bounded, budget);
	}
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "boolean" || value === null) return value;
	if (Array.isArray(value)) {
		const output: unknown[] = [];
		for (let index = 0; index < value.length && index < MAX_UPDATE_ARRAY_ITEMS; index += 1) {
			const item = sanitizeValue(value[index], budget, depth + 1, limits);
			if (item !== undefined) output.push(item);
		}
		return output;
	}
	if (!isRecord(value)) return undefined;
	const output: Record<string, unknown> = {};
	for (const key in value) {
		if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
		if (!consumeKey(limits)) break;
		if (!SAFE_DETAIL_KEYS.has(key)) continue;
		const sanitized = sanitizeValue(value[key], budget, depth + 1, limits);
		if (sanitized !== undefined) output[key] = sanitized;
	}
	return output;
}

function visibleString(value: string, budget: UpdateBudget | undefined): string {
	const redacted = redactProviderText(value);
	if (!budget) return redacted;
	const remaining = Math.max(0, budget.limit - budget.used);
	const visible = redacted.slice(0, remaining);
	budget.used += visible.length;
	budget.onVisibleChars?.(visible.length);
	return visible;
}

function redactProviderText(value: string): string {
	return redactSensitiveWorkflowText(value);
}

function consumeNode(limits: SanitizationBudget): boolean {
	if (limits.nodes >= MAX_UPDATE_NODES) return false;
	limits.nodes += 1;
	return true;
}

function consumeKey(limits: SanitizationBudget): boolean {
	if (limits.keys >= MAX_UPDATE_KEYS) return false;
	limits.keys += 1;
	return true;
}

/** Bound bytes before invoking the potentially expensive recursive redactor. */
function boundedInputString(
	value: string,
	limits: SanitizationBudget,
): string | undefined {
	const remaining = MAX_UPDATE_INPUT_STRING_BYTES - limits.inputStringBytes;
	if (remaining <= 0) return undefined;
	let bounded = value.slice(0, Math.min(value.length, remaining));
	while (bounded.length > 0 && Buffer.byteLength(bounded, "utf8") > remaining) {
		bounded = bounded.slice(0, Math.floor(bounded.length * 0.75));
	}
	const bytes = Buffer.byteLength(bounded, "utf8");
	if (bytes === 0) return undefined;
	limits.inputStringBytes += bytes;
	return bounded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
