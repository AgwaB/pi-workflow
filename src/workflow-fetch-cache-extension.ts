import { createHash } from "node:crypto";
import {
	appendFile,
	mkdir,
	readFile,
	rename,
	writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const WORKFLOW_FETCH_CONTENT_CACHE_SCHEMA =
	"workflow-fetch-content-cache-v1" as const;
export const WORKFLOW_FETCH_CONTENT_CACHE_EVENT_SCHEMA =
	"workflow-fetch-content-cache-event-v1" as const;

export interface WorkflowFetchCacheConfig {
	runId: string;
	taskId: string;
	cacheDir: string;
	maxInlineChars?: number;
}

export interface WorkflowFetchCacheExtensionWrapperOptions {
	wrapperPath: string;
	importPath: string;
	webAccessExtensionPath: string;
	webAccessStoragePath: string;
	config: WorkflowFetchCacheConfig;
}

type ToolResult = {
	content?: Array<Record<string, unknown>>;
	details?: Record<string, unknown>;
	[key: string]: unknown;
};

type ToolSpec = {
	name?: string;
	execute?: (
		toolCallId: string,
		params: unknown,
		signal?: AbortSignal,
		onUpdate?: unknown,
	) => Promise<ToolResult>;
	[key: string]: unknown;
};

type PiLike = Record<string | symbol, unknown> & {
	registerTool(tool: ToolSpec): void;
	appendEntry?(type: string, data: unknown): void;
};

type WebAccessExtension = (pi: PiLike) => void;

type WebAccessStorage = {
	generateId(): string;
	storeResult(id: string, data: Record<string, unknown>): void;
};

interface CacheableFetchParams {
	url?: string;
	urls?: string[];
	forceClone?: boolean;
	prompt?: string;
	timestamp?: string;
	frames?: number;
	model?: string;
}

interface CacheRecord {
	schema: typeof WORKFLOW_FETCH_CONTENT_CACHE_SCHEMA;
	key: string;
	createdAt: string;
	responseId: string;
	params: CacheableFetchParams;
	result: ToolResult;
	storedData: Record<string, unknown>;
}

export function registerWorkflowFetchCacheExtension(
	pi: PiLike,
	config: WorkflowFetchCacheConfig,
	webAccessExtension: WebAccessExtension,
	storage: WebAccessStorage,
): void {
	const capturedFetchDataByResponseId = new Map<string, Record<string, unknown>>();
	const adapter = new Proxy(pi, {
		get(target, property, receiver) {
			if (property === "registerTool") {
				return (tool: ToolSpec) => {
					if (tool.name !== "fetch_content" || !tool.execute) {
						target.registerTool(tool);
						return;
					}
					target.registerTool({
						...tool,
						execute: async (toolCallId, params, signal, onUpdate) => {
							const cacheKey = cacheKeyForParams(params);
							if (!cacheKey) {
								return capFetchContentInlineResult(
									await tool.execute!(
										toolCallId,
										params,
										signal,
										onUpdate,
									),
									config.maxInlineChars,
								);
							}
							const hit = await readCacheRecord(config, cacheKey.key);
							if (hit) {
								await recordCacheEvent(config, "hit", cacheKey);
								return capFetchContentInlineResult(
									materializeCacheHit(pi, storage, hit),
									config.maxInlineChars,
								);
							}
							await recordCacheEvent(config, "miss", cacheKey);
							const result = await tool.execute!(
								toolCallId,
								params,
								signal,
								onUpdate,
							);
							const responseId = stringValue(result.details?.responseId);
							const storedData = responseId
								? capturedFetchDataByResponseId.get(responseId)
								: undefined;
							if (responseId) capturedFetchDataByResponseId.delete(responseId);
							const writeReason = cacheWriteSkipReason(result, storedData);
							if (writeReason) {
								await recordCacheEvent(config, "skip", cacheKey, writeReason);
								return capFetchContentInlineResult(
									result,
									config.maxInlineChars,
								);
							}
							await writeCacheRecord(config, {
								schema: WORKFLOW_FETCH_CONTENT_CACHE_SCHEMA,
								key: cacheKey.key,
								createdAt: new Date().toISOString(),
								responseId: String(result.details?.responseId),
								params: cacheKey.params,
								result,
								storedData: storedData!,
							});
							await recordCacheEvent(config, "write", cacheKey);
							return capFetchContentInlineResult(
								withCacheDetails(result, { hit: false }),
								config.maxInlineChars,
							);
						},
					});
				};
			}
			if (property === "appendEntry") {
				return (type: string, data: unknown) => {
					if (type === "web-search-results" && isFetchStoredData(data)) {
						const cloned = cloneJsonObject(data);
						const responseId = stringValue(cloned?.id);
						if (responseId && cloned)
							capturedFetchDataByResponseId.set(responseId, cloned);
					}
					return pi.appendEntry?.(type, data);
				};
			}
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as PiLike;

	webAccessExtension(adapter);
}

export function buildWorkflowFetchCacheExtensionWrapper(
	options: Omit<WorkflowFetchCacheExtensionWrapperOptions, "wrapperPath">,
): string {
	return [
		`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`,
		`import webAccessExtension from ${JSON.stringify(extensionImportSpecifier(options.webAccessExtensionPath))};`,
		`import * as webAccessStorage from ${JSON.stringify(extensionImportSpecifier(options.webAccessStoragePath))};`,
		`import { registerWorkflowFetchCacheExtension } from ${JSON.stringify(extensionImportSpecifier(options.importPath))};`,
		"",
		"export default function workflowFetchCacheGeneratedExtension(pi: ExtensionAPI): void {",
		`\tregisterWorkflowFetchCacheExtension(pi as any, ${JSON.stringify(options.config, null, "\t").replace(/\n/g, "\n\t")}, webAccessExtension as any, webAccessStorage as any);`,
		"}",
		"",
	].join("\n");
}

export async function writeWorkflowFetchCacheExtensionWrapper(
	options: WorkflowFetchCacheExtensionWrapperOptions,
): Promise<string> {
	const wrapperPath = resolve(options.wrapperPath);
	await mkdir(dirname(wrapperPath), { recursive: true });
	const content = buildWorkflowFetchCacheExtensionWrapper({
		importPath: options.importPath,
		webAccessExtensionPath: options.webAccessExtensionPath,
		webAccessStoragePath: options.webAccessStoragePath,
		config: options.config,
	});
	await writeFile(wrapperPath, content, "utf8");
	return wrapperPath;
}

function cacheKeyForParams(
	params: unknown,
): { key: string; params: CacheableFetchParams; urlCount: number } | undefined {
	if (!isRecord(params)) return undefined;
	const urls = normalizeUrls(params);
	if (urls.length === 0) return undefined;
	const normalized: CacheableFetchParams = {
		urls,
		...(typeof params.forceClone === "boolean"
			? { forceClone: params.forceClone }
			: {}),
		...(typeof params.prompt === "string" ? { prompt: params.prompt } : {}),
		...(typeof params.timestamp === "string"
			? { timestamp: params.timestamp }
			: {}),
		...(Number.isInteger(params.frames)
			? { frames: params.frames as number }
			: {}),
		...(typeof params.model === "string" ? { model: params.model } : {}),
	};
	const key = createHash("sha256")
		.update(JSON.stringify(normalized))
		.digest("hex");
	return { key, params: normalized, urlCount: urls.length };
}

function normalizeUrls(params: Record<string, unknown>): string[] {
	if (Array.isArray(params.urls)) {
		return params.urls
			.filter((value): value is string => typeof value === "string")
			.map((value) => value.trim())
			.filter(Boolean);
	}
	return typeof params.url === "string" && params.url.trim()
		? [params.url.trim()]
		: [];
}

async function readCacheRecord(
	config: WorkflowFetchCacheConfig,
	key: string,
): Promise<CacheRecord | undefined> {
	try {
		const record = JSON.parse(
			await readFile(cacheObjectPath(config, key), "utf8"),
		) as unknown;
		return normalizeCacheRecord(record, key);
	} catch {
		return undefined;
	}
}

async function writeCacheRecord(
	config: WorkflowFetchCacheConfig,
	record: CacheRecord,
): Promise<void> {
	const target = cacheObjectPath(config, record.key);
	await mkdir(dirname(target), { recursive: true });
	const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
	await rename(tmp, target);
}

function materializeCacheHit(
	pi: PiLike,
	storage: WebAccessStorage,
	record: CacheRecord,
): ToolResult {
	const nextId = storage.generateId();
	const storedData = replaceResponseId(
		record.storedData,
		record.responseId,
		nextId,
	);
	storedData.id = nextId;
	storedData.timestamp = Date.now();
	storage.storeResult(nextId, storedData);
	pi.appendEntry?.("web-search-results", storedData);
	return withCacheDetails(
		replaceResponseId(record.result, record.responseId, nextId) as ToolResult,
		{ hit: true },
	);
}

function replaceResponseId(value: unknown, from: string, to: string): any {
	if (typeof value === "string") return value.split(from).join(to);
	if (Array.isArray(value))
		return value.map((item) => replaceResponseId(item, from, to));
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [
			key,
			replaceResponseId(item, from, to),
		]),
	);
}

function withCacheDetails(
	result: ToolResult,
	options: { hit: boolean },
): ToolResult {
	return {
		...result,
		details: {
			...(result.details ?? {}),
			cache: {
				scope: "workflow-run",
				type: "fetch_content",
				hit: options.hit,
			},
		},
	};
}

function capFetchContentInlineResult(
	result: ToolResult,
	maxInlineChars: number | undefined,
): ToolResult {
	const maxChars = normalizeInlineCharCap(maxInlineChars);
	if (maxChars === undefined || !Array.isArray(result.content)) return result;

	let truncated = false;
	const content = result.content.map((entry) => {
		if (entry.type !== "text" || typeof entry.text !== "string")
			return entry;
		if (entry.text.length <= maxChars) return entry;
		truncated = true;
		return {
			...entry,
			text:
				entry.text.slice(0, maxChars) +
				`\n\n[Workflow inline fetch content capped at ${maxChars} chars; full source content remains in workflow source cache.]`,
		};
	});
	if (!truncated) return result;

	return {
		...result,
		content,
		details: {
			...(result.details ?? {}),
			truncated: true,
			workflowInlineContentCap: {
				type: "fetch_content",
				maxChars,
				truncated: true,
			},
		},
	};
}

function normalizeInlineCharCap(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value)) return undefined;
	const cap = Math.floor(value);
	return cap > 0 ? cap : undefined;
}

function cacheWriteSkipReason(
	result: ToolResult,
	storedData: Record<string, unknown> | undefined,
): string | undefined {
	if (!storedData) return "missing-stored-data";
	if (result.details?.error) return "error-result";
	if (String(result.details?.responseId ?? "") === "")
		return "missing-response-id";
	if (hasNonTextContent(result.content)) return "non-text-content";
	const successful = result.details?.successful;
	if (typeof successful === "number" && successful <= 0) return "no-successes";
	return undefined;
}

function hasNonTextContent(content: ToolResult["content"]): boolean {
	return (content ?? []).some((entry) => entry.type !== "text");
}

function normalizeCacheRecord(
	value: unknown,
	key: string,
): CacheRecord | undefined {
	if (!isRecord(value)) return undefined;
	if (value.schema !== WORKFLOW_FETCH_CONTENT_CACHE_SCHEMA) return undefined;
	if (value.key !== key) return undefined;
	if (typeof value.responseId !== "string" || !value.responseId)
		return undefined;
	if (!isRecord(value.result) || !isRecord(value.storedData)) return undefined;
	return value as unknown as CacheRecord;
}

async function recordCacheEvent(
	config: WorkflowFetchCacheConfig,
	event: "hit" | "miss" | "write" | "skip",
	key: { key: string; urlCount: number },
	reason?: string,
): Promise<void> {
	await mkdir(resolve(config.cacheDir), { recursive: true });
	await appendFile(
		resolve(config.cacheDir, "events.jsonl"),
		`${JSON.stringify({
			schema: WORKFLOW_FETCH_CONTENT_CACHE_EVENT_SCHEMA,
			at: new Date().toISOString(),
			runId: config.runId,
			taskId: config.taskId,
			event,
			key: key.key,
			urlCount: key.urlCount,
			...(reason === undefined ? {} : { reason }),
		})}\n`,
		"utf8",
	);
}

function cacheObjectPath(
	config: WorkflowFetchCacheConfig,
	key: string,
): string {
	return resolve(config.cacheDir, "objects", `${key}.json`);
}

function cloneJsonObject(value: unknown): Record<string, unknown> | undefined {
	if (!isRecord(value)) return undefined;
	return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function isFetchStoredData(value: unknown): value is Record<string, unknown> {
	return isRecord(value) && value.type === "fetch" && Array.isArray(value.urls);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extensionImportSpecifier(importPath: string): string {
	if (isAbsolute(importPath)) return pathToFileURL(resolve(importPath)).href;
	return importPath;
}
