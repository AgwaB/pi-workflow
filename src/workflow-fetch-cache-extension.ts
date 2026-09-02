import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { assertPiWebAccessEffectiveConfig } from "./pi-web-access-config.js";
import {
	appendPrivateFile,
	writePrivateFileNoReplace,
	publishPrivateGenerationDirectory,
} from "./secure-atomic-write.js";
import {
	isSensitiveWorkflowQueryKey,
	redactSensitiveWorkflowText,
} from "./workflow-sensitive-query.js";
import {
	isWorkflowAbortError,
	isWorkflowReturnedCancellation,
} from "./workflow-cancellation.js";
import { createSafeProviderOnUpdate } from "./workflow-provider-callback.js";

export const WORKFLOW_FETCH_CONTENT_CACHE_SCHEMA =
	"workflow-fetch-content-cache-v1" as const;
export const WORKFLOW_FETCH_CONTENT_CACHE_EVENT_SCHEMA =
	"workflow-fetch-content-cache-event-v1" as const;
export const WORKFLOW_FETCH_CONTENT_RESPONSE_ALIAS_SCHEMA =
	"workflow-fetch-content-response-alias-v1" as const;

export type WorkflowFetchCachePublicationPhase =
	| "before-object-publication"
	| "after-object-publication";

let workflowFetchCachePublicationHook:
	| ((phase: WorkflowFetchCachePublicationPhase, key: string) => void | Promise<void>)
	| undefined;

/** Test-only hooks around the immutable cache-object commit point. */
export function setWorkflowFetchCachePublicationHookForTests(
	hook:
	| ((phase: WorkflowFetchCachePublicationPhase, key: string) => void | Promise<void>)
	| undefined,
): void {
	workflowFetchCachePublicationHook = hook;
}

export function setWorkflowFetchCachePublicationHooksForTests(
	hooks:
	| {
			beforePublication?: (key: string) => void | Promise<void>;
			afterPublication?: (key: string) => void | Promise<void>;
	  }
	| undefined,
): void {
	workflowFetchCachePublicationHook = hooks
		? async (phase, key) => {
				if (phase === "before-object-publication") await hooks.beforePublication?.(key);
				else await hooks.afterPublication?.(key);
		  }
		: undefined;
}

const CANONICAL_PROVIDER_TOOLS = new Set([
	"web_search",
	"fetch_content",
	"get_search_content",
]);
const RESPONSE_ID_ALIAS_HEX = /^[0-9a-f]{64}$/;

export interface WorkflowFetchCacheConfig {
	runId: string;
	taskId: string;
	cacheDir: string;
	maxInlineChars?: number;
	cacheEnabled?: boolean;
	providerKind?: "pi-web-access" | "extension";
	requiredProviderTools?: string[];
	exposedProviderTools?: string[];
	/** Re-export only these selected tools from the captured provider. */
	passthroughProviderTools?: string[];
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
		ctx?: unknown,
	) => Promise<ToolResult>;
	[key: string]: unknown;
};

type PiLike = Record<string | symbol, unknown> & {
	registerTool(tool: ToolSpec): void;
	appendEntry?(type: string, data: unknown): void;
	on?(...args: unknown[]): void | (() => void);
};

type WebAccessExtension = (pi: PiLike) => void;

type WebAccessStorage = {
	generateId(): string;
	storeResult(id: string, data: Record<string, unknown>): void;
	getResult?(id: string): Record<string, unknown> | undefined;
};

interface CacheableFetchParams {
	urls: string[];
	mode: "readable" | "raw";
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
	result: ToolResult;
	storedData: Record<string, unknown>;
}

interface InvocationCapture {
	active: boolean;
	appended: Record<string, unknown>[];
}

export function registerWorkflowFetchCacheExtension(
	pi: PiLike,
	config: WorkflowFetchCacheConfig,
	webAccessExtension: WebAccessExtension,
	storage: WebAccessStorage,
): void {
	const requiredTools = normalizedCanonicalToolNames(
		config.requiredProviderTools,
		["fetch_content"],
	);
	const exposedTools = new Set(
		normalizedCanonicalToolNames(config.exposedProviderTools, requiredTools),
	);
	const authorizedProviderTools = new Set([
		...requiredTools,
		...exposedTools,
		...(config.passthroughProviderTools ?? []),
	]);
	if (config.providerKind === "pi-web-access") {
		assertPiWebAccessEffectiveConfig(requiredTools);
	}
	const pendingTools = new Map<string, ToolSpec>();
	const pendingHooks: unknown[][] = [];
	const invocationCapture = new AsyncLocalStorage<InvocationCapture>();

	const adapter = new Proxy(pi, {
		get(target, property, receiver) {
			if (property === "registerTool") {
				return (tool: ToolSpec) => {
					if (typeof tool.name !== "string" || !tool.name) return;
					// Authorization is applied before duplicate detection. An
					// unrelated or unselected provider registration cannot turn into
					// a duplicate error or enter the wrapper namespace.
					if (!authorizedProviderTools.has(tool.name)) return;
					if (pendingTools.has(tool.name)) {
						throw new Error(
							`pi-web-access registered duplicate tool ${JSON.stringify(tool.name)}`,
						);
					}
					pendingTools.set(tool.name, tool);
				};
			}
			if (property === "on") {
				return (...args: unknown[]) => {
					pendingHooks.push(args);
					return () => undefined;
				};
			}
			if (property === "registerCommand" || property === "registerShortcut") {
				return () => undefined;
			}
			if (property === "appendEntry") {
				return (type: string, data: unknown) => {
					const capture = invocationCapture.getStore();
					if (type === "web-search-results") {
						if (capture?.active && isRecord(data)) {
							const cloned = cloneJsonObject(data);
							if (cloned) capture.appended.push(cloned);
							// Defer publication until the invocation's cancellation and
							// cache gates have linearized.
						}
						// Provider-owned session records never pass directly through the
						// wrapper. In particular, a callback retained after execute has
						// returned is discarded rather than forwarded raw.
						return undefined;
					}
					return target.appendEntry?.(type, data);
				};
			}
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as PiLike;

	webAccessExtension(adapter);
	assertRequiredProviderTools(pendingTools, requiredTools);

	for (const [name, tool] of pendingTools) {
		if (!exposedTools.has(name) || !CANONICAL_PROVIDER_TOOLS.has(name)) continue;
		const wrapped =
			name === "fetch_content" && tool.execute
				? withFetchCacheExecution(
						pi,
						config,
						tool,
						storage,
						invocationCapture,
					)
				: name === "get_search_content" && tool.execute && config.providerKind !== "extension"
					? withMappedSearchContentExecution(config, wrapProviderToolOnUpdate(tool), storage)
					: wrapProviderToolOnUpdate(tool);
		pi.registerTool(wrapped);
	}
	for (const name of config.passthroughProviderTools ?? []) {
		const tool = pendingTools.get(name);
		if (tool && !CANONICAL_PROVIDER_TOOLS.has(name))
			pi.registerTool(wrapProviderToolOnUpdate(tool));
	}
	for (const args of pendingHooks) pi.on?.(...args);
}

function withFetchCacheExecution(
	pi: PiLike,
	config: WorkflowFetchCacheConfig,
	tool: ToolSpec,
	storage: WebAccessStorage,
	invocationCapture: AsyncLocalStorage<InvocationCapture>,
): ToolSpec {
	const retrievalToolName = (
		config.exposedProviderTools ??
		config.requiredProviderTools ??
		[]
	).includes("get_search_content")
		? "get_search_content"
		: undefined;
	return {
		...tool,
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			const executeOrigin = async () => {
				const updateGate = createSafeProviderOnUpdate(onUpdate);
				try {
					return await tool.execute!(
						toolCallId,
						params,
						signal,
						updateGate.callback,
						ctx,
					);
				} finally {
					// Providers sometimes retain this callback. Closing the gate at
					// provider settlement makes those late updates inert.
					updateGate.close();
				}
			};
			// Extension transports have no stable provider fingerprint contract.
			// They remain functional pass-through tools, but never share the
			// workflow cache namespace or replay provider-owned response IDs.
			const cacheKey =
			config.providerKind === "extension" || config.cacheEnabled === false
				? undefined
				: cacheKeyForParams(params);
			if (!cacheKey) {
				const capture: InvocationCapture = { active: true, appended: [] };
				let result: ToolResult;
				try {
					result = await invocationCapture.run(capture, executeOrigin);
				} catch (error) {
					capture.active = false;
					capture.appended.length = 0;
					return providerFetchFailureResult(error, signal);
				}
				// The provider callback is invocation-owned. Close the capture before
				// inspecting the result so a timer/microtask retained by a provider can
				// never publish after execute has returned.
				capture.active = false;
				try {
					if (signal?.aborted || fetchResultWasCancelled(result))
						return providerFetchCancellationResult();
					publishCapturedFetchRecords(pi, capture, result);
					return capFetchContentInlineResult(
						redactFetchToolResult(result),
						config.maxInlineChars,
						false,
						retrievalToolName,
					);
				} catch (error) {
					return providerFetchFailureResult(error, signal);
				} finally {
					capture.appended.length = 0;
				}
			}

			// The miss recheck, origin call, immutable object commit, and response
			// alias binding are one cross-process transaction.  In particular, a
			// second process must not run the provider against a stale miss.
			throwIfFetchCacheAborted(signal);
			return withFetchCacheKeyLock(config, cacheKey.key, signal, async () => {
				throwIfFetchCacheAborted(signal);
				const lockedHit = await readCacheRecord(config, cacheKey.key);
				if (lockedHit) {
					throwIfFetchCacheAborted(signal);
					await recordCacheEvent(config, "hit", cacheKey);
					throwIfFetchCacheAborted(signal);
					const replayId = await allocateResponseIdAlias(config, storage, cacheKey.key, signal);
					throwIfFetchCacheAborted(signal);
					return capFetchContentInlineResult(
						materializeCacheHit(pi, storage, lockedHit, replayId, signal),
						config.maxInlineChars,
						true,
						retrievalToolName,
					);
				}

				await recordCacheEvent(config, "miss", cacheKey);
				throwIfFetchCacheAborted(signal);
				const capture: InvocationCapture = { active: true, appended: [] };
				let result: ToolResult;
				try {
					result = await invocationCapture.run(capture, executeOrigin);
				} finally {
					capture.active = false;
				}
				try {
					throwIfFetchCacheAborted(signal);
					if (fetchResultWasCancelled(result))
						return providerFetchCancellationResult();
					const responseId = stringValue(result.details?.responseId);
					const storedData = responseId
						? hydrateFetchStoredData(storage, responseId, capture.appended)
						: undefined;
					const safeResult = responseId
						? allowlistToolResult(result, responseId)
						: undefined;
					const writeReason = cacheWriteSkipReason(result, storedData, safeResult);
					if (writeReason) {
						await recordCacheEvent(config, "skip", cacheKey, writeReason);
						throwIfFetchCacheAborted(signal);
						// A skipped cache write has no validated durable identity. Do not
						// replay captured provider records: even a cloned record can contain
						// arbitrary nested provider fields or raw credentials. The origin
						// result below is independently redacted before it is returned.
						capture.appended.length = 0;
						return capFetchContentInlineResult(redactFetchToolResult(result), config.maxInlineChars, false, retrievalToolName);
					}
					const originResponseId = stringValue(result.details?.responseId)!;
					// The no-replace link is the transaction's commit-wins point. Before
					// it, cancellation must leave no replayable object. After it, do not
					// consult the signal: finish the alias/session/event transaction.
					await workflowFetchCachePublicationHook?.("before-object-publication", cacheKey.key);
					const published = await writeCacheRecord(config, {
						schema: WORKFLOW_FETCH_CONTENT_CACHE_SCHEMA,
						key: cacheKey.key,
						createdAt: new Date().toISOString(),
						responseId: originResponseId,
						result: safeResult!,
						storedData: storedData!,
					}, signal);
					// If no-replace lost a race, `published` is the validated durable
					// winner. Never continue with this invocation's losing response.
					try {
						await workflowFetchCachePublicationHook?.("after-object-publication", cacheKey.key);
					} catch (error) {
						if (!signal?.aborted) throw error;
					}
					const canonicalResponseId = published.record.responseId;
					let responseAlias = canonicalResponseId;
					if (!(await bindResponseIdAlias(config, canonicalResponseId, cacheKey.key)))
						responseAlias = await allocateResponseIdAlias(config, storage, cacheKey.key);
					let returned = withCacheDetails(published.record.result, {
						hit: !published.won,
					});
					if (responseAlias !== canonicalResponseId)
						returned = rewriteReplayIdentity(returned, canonicalResponseId, responseAlias);
					const sessionRecord = allowlistFetchStoredData(
						{ ...published.record.storedData, id: responseAlias },
						responseAlias,
					);
					if (!sessionRecord) throw new Error("workflow fetch cache session data became invalid");
					pi.appendEntry?.("web-search-results", sessionRecord);
					await recordCacheEvent(config, published.won ? "write" : "hit", cacheKey);
					return capFetchContentInlineResult(redactFetchToolResult(returned), config.maxInlineChars, true, retrievalToolName);
				} finally {
					capture.appended.length = 0;
				}
			}).catch((error: unknown) => providerFetchFailureResult(error, signal));
		},
	};
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
	await mkdir(dirname(wrapperPath), { recursive: true, mode: 0o700 });
	const content = buildWorkflowFetchCacheExtensionWrapper({
		importPath: options.importPath,
		webAccessExtensionPath: options.webAccessExtensionPath,
		webAccessStoragePath: options.webAccessStoragePath,
		config: options.config,
	});
	await writeFile(wrapperPath, content, { encoding: "utf8", mode: 0o600 });
	return wrapperPath;
}

function normalizedCanonicalToolNames(
	values: string[] | undefined,
	fallback: string[],
): string[] {
	const source = values ?? fallback;
	return [
		...new Set(
			source.filter((name) => CANONICAL_PROVIDER_TOOLS.has(name)).sort(),
		),
	];
}

function assertRequiredProviderTools(
	tools: Map<string, ToolSpec>,
	required: string[],
): void {
	const missing = required.filter((name) => !tools.get(name)?.execute);
	if (missing.length === 0) return;
	throw new Error(
		`pi-web-access canonical tool validation failed; missing required tool(s): ${missing.join(", ")}`,
	);
}

function cacheKeyForParams(
	params: unknown,
): { key: string; params: CacheableFetchParams; urlCount: number } | undefined {
	if (!isRecord(params) || Object.hasOwn(params, "auth")) return undefined;
	const mode = params.mode === undefined ? "readable" : params.mode;
	if (mode !== "readable" && mode !== "raw") return undefined;
	const urls = normalizeCacheableUrls(params);
	if (!urls) return undefined;
	const normalized: CacheableFetchParams = {
		urls,
		mode,
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

function normalizeCacheableUrls(
	params: Record<string, unknown>,
): string[] | undefined {
	let rawUrls: unknown[];
	if (Object.hasOwn(params, "urls")) {
		if (!Array.isArray(params.urls) || params.urls.length === 0) return undefined;
		rawUrls = params.urls;
	} else if (Object.hasOwn(params, "url")) {
		rawUrls = [params.url];
	} else {
		return undefined;
	}
	const urls: string[] = [];
	for (const value of rawUrls) {
		if (typeof value !== "string" || !value.trim()) return undefined;
		const normalized = normalizeCacheableUrl(value);
		if (!normalized) return undefined;
		urls.push(normalized);
	}
	return urls;
}

function normalizeCacheableUrl(value: string): string | undefined {
	let parsed: URL;
	try {
		parsed = new URL(value.trim());
	} catch {
		return undefined;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
		return undefined;
	if (parsed.username || parsed.password || parsed.hash) return undefined;
	for (const key of parsed.searchParams.keys()) {
		if (isSensitiveWorkflowQueryKey(key)) return undefined;
	}
	return parsed.href;
}

async function readCacheRecord(
	config: WorkflowFetchCacheConfig,
	key: string,
): Promise<CacheRecord | undefined> {
	try {
		const directory = resolve(config.cacheDir, "objects");
		const directoryInfo = await lstat(directory);
		const objectPath = cacheObjectPath(config, key);
		const objectInfo = await lstat(objectPath);
		if (
			!directoryInfo.isDirectory() ||
			!objectInfo.isFile() ||
			(process.platform !== "win32" &&
				((directoryInfo.mode & 0o777) !== 0o700 ||
					(objectInfo.mode & 0o777) !== 0o600))
		)
			return undefined;
		const record = JSON.parse(await readFile(objectPath, "utf8")) as unknown;
		return normalizeCacheRecord(record, key);
	} catch {
		return undefined;
	}
}

async function writeCacheRecord(
	config: WorkflowFetchCacheConfig,
	record: CacheRecord,
	signal?: AbortSignal,
): Promise<{ record: CacheRecord; won: boolean }> {
	const target = cacheObjectPath(config, record.key);
	// Cache objects are immutable. The per-key transaction normally makes this
	// exclusive; wx also protects the object if a stale lock is recovered.
	try {
		await writePrivateFileNoReplace(target, `${JSON.stringify(record, null, 2)}\n`, { signal });
		return { record, won: true };
	} catch (error) {
		if (!isFileExistsError(error)) throw error;
		// EEXIST is not a harmless success: another transaction owns the
		// canonical object. Read and validate it before continuing so the losing
		// provider result can never be exposed through an alias/session replay.
		const winner = await readCacheRecord(config, record.key);
		if (!winner)
			throw new Error("workflow fetch cache object publication conflict", { cause: error });
		return { record: winner, won: false };
	}
}

interface ResponseIdAlias {
	schema: typeof WORKFLOW_FETCH_CONTENT_RESPONSE_ALIAS_SCHEMA;
	responseId: string;
	cacheKey: string;
}

type ResponseIdAliasLookup =
	| { kind: "unmapped" }
	| { kind: "mapped"; alias: ResponseIdAlias }
	| { kind: "tampered" };

async function bindResponseIdAlias(
	config: WorkflowFetchCacheConfig,
	responseId: string,
	cacheKey: string,
	signal?: AbortSignal,
): Promise<boolean> {
	if (!RESPONSE_ID_ALIAS_HEX.test(cacheKey))
		throw new Error("workflow fetch cache alias has invalid cache identity");
	const existing = await readResponseIdAlias(config, responseId);
	if (existing.kind === "tampered")
		throw new Error("workflow fetch cache response alias is tampered");
	if (existing.kind === "mapped")
		return existing.alias.cacheKey === cacheKey;
	const alias: ResponseIdAlias = {
		schema: WORKFLOW_FETCH_CONTENT_RESPONSE_ALIAS_SCHEMA,
		responseId,
		cacheKey,
	};
	try {
		throwIfFetchCacheAborted(signal);
		await writePrivateFileNoReplace(
			responseIdAliasPath(config, responseId),
			`${JSON.stringify(alias, null, 2)}\n`,
			{ signal },
		);
		return true;
	} catch (error) {
		if (!isFileExistsError(error)) throw error;
		const raced = await readResponseIdAlias(config, responseId);
		if (raced.kind === "tampered")
			throw new Error("workflow fetch cache response alias is tampered");
		return raced.kind === "mapped" && raced.alias.cacheKey === cacheKey;
	}
}

async function allocateResponseIdAlias(
	config: WorkflowFetchCacheConfig,
	storage: WebAccessStorage,
	cacheKey: string,
	signal?: AbortSignal,
): Promise<string> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		throwIfFetchCacheAborted(signal);
		const responseId = storage.generateId();
		const existing = await readResponseIdAlias(config, responseId);
		if (existing.kind === "tampered")
			throw new Error("workflow fetch cache response alias is tampered");
		if (existing.kind === "mapped" && existing.alias.cacheKey !== cacheKey)
			continue;
		if (await bindResponseIdAlias(config, responseId, cacheKey, signal)) return responseId;
	}
	throw new Error("workflow fetch cache response id allocation failed");
}

async function readResponseIdAlias(
	config: WorkflowFetchCacheConfig,
	responseId: string,
): Promise<ResponseIdAliasLookup> {
	const directory = responseAliasDirectory(config);
	let directoryInfo;
	try {
		directoryInfo = await lstat(directory);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? { kind: "unmapped" }
			: { kind: "tampered" };
	}
	if (
		!directoryInfo.isDirectory() ||
		(process.platform !== "win32" && (directoryInfo.mode & 0o777) !== 0o700)
	)
		return { kind: "tampered" };
	const path = responseIdAliasPath(config, responseId);
	let info;
	try {
		info = await lstat(path);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? { kind: "unmapped" }
			: { kind: "tampered" };
	}
	if (
		!info.isFile() ||
		(process.platform !== "win32" && (info.mode & 0o777) !== 0o600)
	)
		return { kind: "tampered" };
	try {
		const value = JSON.parse(await readFile(path, "utf8")) as unknown;
		if (
			!isRecord(value) ||
			value.schema !== WORKFLOW_FETCH_CONTENT_RESPONSE_ALIAS_SCHEMA ||
			value.responseId !== responseId ||
			typeof value.cacheKey !== "string" ||
			!RESPONSE_ID_ALIAS_HEX.test(value.cacheKey)
		)
			return { kind: "tampered" };
		return {
			kind: "mapped",
			alias: {
				schema: WORKFLOW_FETCH_CONTENT_RESPONSE_ALIAS_SCHEMA,
				responseId,
				cacheKey: value.cacheKey,
			},
		};
	} catch {
		return { kind: "tampered" };
	}
}

const FETCH_CACHE_LOCK_WAIT_MS = 5 * 60_000;
const FETCH_CACHE_LOCK_STALE_MS = 4 * 60_000;

async function withFetchCacheKeyLock<T>(
	config: WorkflowFetchCacheConfig,
	key: string,
	signal: AbortSignal | undefined,
	fn: () => Promise<T>,
): Promise<T> {
	const release = await acquireFetchCacheKeyLock(config, key, signal);
	try {
		return await fn();
	} finally {
		await release();
	}
}

async function acquireFetchCacheKeyLock(
	config: WorkflowFetchCacheConfig,
	key: string,
	signal?: AbortSignal,
): Promise<() => Promise<void>> {
	const lockDir = resolve(config.cacheDir, "locks", `${key}.lock`);
	await mkdir(dirname(lockDir), { recursive: true, mode: 0o700 });
	const started = Date.now();
	for (;;) {
		if (signal?.aborted) throw new Error("aborted");
		const generation = randomUUID();
		const ownerId = `${process.pid}:${generation}`;
		try {
			await publishPrivateGenerationDirectory(
				lockDir,
				"owner.json",
				`${JSON.stringify({ ownerId, generation, pid: process.pid, key })}\n`,
			);
			const fence = await captureCacheLockFence(lockDir, ownerId, generation);
			if (!fence) throw new Error("workflow fetch cache lock owner publication failed");
			return async () => { await removeFencedCacheLock(lockDir, fence); };
		} catch (error) {
			if (!isFileExistsError(error)) throw error;
			await removeStaleCacheKeyLock(lockDir);
			if (Date.now() - started > FETCH_CACHE_LOCK_WAIT_MS)
				throw new Error("workflow fetch cache lock timeout");
			await new Promise((resolveSleep) => setTimeout(resolveSleep, 25));
		}
	}
}

type CacheLockFence = {
	directory: { dev: number; ino: number };
	owner: { dev: number; ino: number };
	ownerId: string;
	generation: string;
};

async function readCacheLockOwner(
	lockDir: string,
): Promise<{ ownerId?: string; generation?: string; pid?: number } | undefined> {
	try {
		const value = JSON.parse(await readFile(resolve(lockDir, "owner.json"), "utf8")) as unknown;
		return isRecord(value)
			? {
					ownerId: typeof value.ownerId === "string" ? value.ownerId : undefined,
					generation: typeof value.generation === "string" ? value.generation : undefined,
					pid: typeof value.pid === "number" ? value.pid : undefined,
				  }
			: undefined;
	} catch {
		return undefined;
	}
}

async function captureCacheLockFence(
	lockDir: string,
	ownerId: string,
	generation: string,
): Promise<CacheLockFence | undefined> {
	try {
		const [directory, owner] = await Promise.all([
			lstat(lockDir),
			lstat(resolve(lockDir, "owner.json")),
		]);
		if (!directory.isDirectory() || !owner.isFile()) return undefined;
		const current = await readCacheLockOwner(lockDir);
		if (current?.ownerId !== ownerId || (current.generation ?? current.ownerId) !== generation) return undefined;
		return {
			directory: { dev: directory.dev, ino: directory.ino },
			owner: { dev: owner.dev, ino: owner.ino },
			ownerId,
			generation,
		};
	} catch {
		return undefined;
	}
}

function sameCacheStat(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

async function removeFencedCacheLock(lockDir: string, fence: CacheLockFence): Promise<void> {
	try {
		const directory = await lstat(lockDir);
		if (!directory.isDirectory() || !sameCacheStat(directory, fence.directory)) return;
		const ownerPath = resolve(lockDir, "owner.json");
		const owner = await lstat(ownerPath);
		if (!owner.isFile() || !sameCacheStat(owner, fence.owner)) return;
		const guardPath = resolve(lockDir, `.remove-${randomUUID()}`);
		let guarded = false;
		let guard: Awaited<ReturnType<typeof open>> | undefined;
		try {
			guard = await open(guardPath, "wx", 0o600);
			guarded = true;
			// The guard serializes releasers/reapers while the owner is unlinked;
			// replacement acquisition cannot enter until rmdir completes.
			const guardedDirectory = await lstat(lockDir);
			const guardedOwner = await lstat(ownerPath);
			const current = await readCacheLockOwner(lockDir);
			if (!guardedDirectory.isDirectory() || !sameCacheStat(guardedDirectory, fence.directory) ||
				!guardedOwner.isFile() || !sameCacheStat(guardedOwner, fence.owner) ||
				current?.ownerId !== fence.ownerId || (current.generation ?? current.ownerId) !== fence.generation) return;
			// Move the fenced generation out of the live lock name in one atomic
			// step. A crash cannot leave an ownerless directory blocking reacquire.
			const tombstone = `${lockDir}.releasing-${randomUUID()}`;
			await rename(lockDir, tombstone);
			guarded = false;
			await rm(tombstone, { recursive: true, force: true });
		} finally {
			await guard?.close().catch(() => undefined);
			if (guarded) await unlink(guardPath).catch(() => undefined);
		}
	} catch {
		// A competing releaser/reaper won, or the lock was replaced.
	}
}

async function removeStaleCacheKeyLock(lockDir: string): Promise<void> {
	try {
		const info = await lstat(lockDir);
		if (!info.isDirectory()) return;
		const owner = await readCacheLockOwner(lockDir);
		if (owner?.pid !== undefined) {
			try {
				process.kill(owner.pid, 0);
				return;
			} catch (error) {
				// EPERM still means a live owner; only ESRCH is reclaimable.
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") return;
			}
		}
		if (Date.now() - info.mtimeMs <= FETCH_CACHE_LOCK_STALE_MS) return;
		const generation = owner?.generation ?? owner?.ownerId;
		const fence = owner?.ownerId && generation
			? await captureCacheLockFence(lockDir, owner.ownerId, generation)
			: undefined;
		if (fence) await removeFencedCacheLock(lockDir, fence);
		// An ownerless directory is left untouched: it may be a freshly created
		// replacement between mkdir and owner publication, and path-based rmdir
		// must never remove that new generation.
	} catch {
		// Another process may have released or replaced the lock.
	}
}

function responseAliasDirectory(config: WorkflowFetchCacheConfig): string {
	return resolve(config.cacheDir, "aliases");
}

function responseIdAliasPath(
	config: WorkflowFetchCacheConfig,
	responseId: string,
): string {
	const identity = createHash("sha256").update(responseId, "utf8").digest("hex");
	return resolve(responseAliasDirectory(config), `${identity}.json`);
}

function wrapProviderToolOnUpdate(tool: ToolSpec): ToolSpec {
	if (!tool.execute) return tool;
	return {
		...tool,
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			const updateGate = createSafeProviderOnUpdate(onUpdate);
			try {
				return await tool.execute!(
					toolCallId,
					params,
					signal,
					updateGate.callback,
					ctx,
				);
			} finally {
				updateGate.close();
			}
		},
	};
}

function withMappedSearchContentExecution(
	config: WorkflowFetchCacheConfig,
	tool: ToolSpec,
	storage: WebAccessStorage,
): ToolSpec {
	return {
		...tool,
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			if (!isRecord(params) || typeof params.responseId !== "string")
				return tool.execute!(toolCallId, params, signal, onUpdate, ctx);
			const lookup = await readResponseIdAlias(config, params.responseId);
			if (lookup.kind === "unmapped")
				return tool.execute!(toolCallId, params, signal, onUpdate, ctx);
			if (lookup.kind === "tampered") return mappedResponseIdFailure();
			const record = await readCacheRecord(config, lookup.alias.cacheKey);
			if (!record) return mappedResponseIdFailure();
			const storedData = cloneJsonObject(record.storedData);
			if (!storedData) return mappedResponseIdFailure();
			// Do not repopulate or consult provider-owned storage here. A custom
			// provider may use a separate Map (and it is commonly empty after a
			// restart); the validated durable object is the source of truth.
			storedData.id = params.responseId;
			storedData.timestamp = Date.now();
			try { storage.storeResult(params.responseId, storedData); } catch { /* optional compatibility warm-up */ }
			return mappedSearchContentFromStoredData(storedData, params);
		},
	};
}

function mappedResponseIdFailure(): ToolResult {
	return {
		content: [{ type: "text", text: "Unable to retrieve stored content." }],
		details: { error: "Workflow response alias unavailable" },
	};
}

const MAPPED_DEFAULT_LIMIT = 30_000;
const MAPPED_MAX_LIMIT = 200_000;

type StoredFetchUrl = { url: string; title: string; content: string; error?: string | null };

function mappedSearchContentFromStoredData(
	storedData: Record<string, unknown>,
	params: Record<string, unknown>,
): ToolResult {
	const responseId = typeof params.responseId === "string" ? params.responseId : "";
	const urls = storedData.urls as StoredFetchUrl[];
	let index = -1;
	if (typeof params.url === "string") index = urls.findIndex((item) => item.url === params.url);
	else if (Number.isInteger(params.urlIndex)) index = params.urlIndex as number;
	else index = urls.length === 1 ? 0 : -1;
	if (index < 0 || !urls[index]) return {
		content: [{ type: "text", text: index < 0 ? "Specify url or urlIndex for the stored response." : "URL index is out of range." }],
		details: { error: index < 0 ? "No URL specified" : "Index out of range", responseId },
	};
	const selected = urls[index]!;
	if (selected.error) return {
		content: [{ type: "text", text: `Error retrieving URL ${JSON.stringify(selected.url)} from responseId ${JSON.stringify(responseId)}: ${selected.error}.` }],
		details: { error: selected.error, url: selected.url, responseId },
	};
	if (params.findText !== undefined && (params.offset !== undefined || params.limit !== undefined))
		return { content: [{ type: "text", text: "findText cannot be combined with offset or limit. Omit offset and limit when using findText." }], details: { error: "Incompatible find options", responseId } };
	if (params.findMode !== undefined && params.findText === undefined)
		return { content: [{ type: "text", text: "findMode requires findText." }], details: { error: "findMode requires findText", responseId } };
	if (params.findText !== undefined) {
		const queries = (Array.isArray(params.findText) ? params.findText : [params.findText]).filter((value): value is string => typeof value === "string" && value.trim() !== "");
		if (!queries.length) return { content: [{ type: "text", text: "findText must contain at least one non-empty string." }], details: { error: "findText must contain at least one non-empty string", responseId } };
		const mode = params.findMode === "exact" || params.findMode === "fuzzy" ? params.findMode : "case-insensitive";
		const found = findStoredContent(selected.content, queries, mode);
		return { content: [{ type: "text", text: `# ${selected.title || selected.url}\n\n${found.text}` }], details: { url: selected.url, title: selected.title, contentLength: selected.content.length, findMode: mode, ...found.details } };
	}
	// The legacy provider returned the unbounded body when no paging selector
	// was supplied. Preserve that pass-through shape; bounded calls below use
	// the v0.24.2 title/continuation contract.
	if (params.offset === undefined && params.limit === undefined)
		return { content: [{ type: "text", text: selected.content }], details: { responseId, url: selected.url, title: selected.title } };
	const offset = params.offset === undefined ? 0 : params.offset;
	const limit = params.limit === undefined ? MAPPED_DEFAULT_LIMIT : params.limit;
	if (!Number.isInteger(offset) || (offset as number) < 0) return { content: [{ type: "text", text: "Invalid offset." }], details: { error: "Invalid offset", offset, responseId } };
	if (!Number.isInteger(limit) || (limit as number) <= 0 || (limit as number) > MAPPED_MAX_LIMIT) return { content: [{ type: "text", text: "Invalid limit." }], details: { error: "Invalid limit", limit, maxLimit: MAPPED_MAX_LIMIT, responseId } };
	if ((offset as number) > selected.content.length) return { content: [{ type: "text", text: `Offset ${offset} is out of range.` }], details: { error: "Offset out of range", offset, contentLength: selected.content.length, responseId } };
	let start = offset as number;
	if (start > 0 && start < selected.content.length && isLowSurrogate(selected.content.charCodeAt(start)) && isHighSurrogate(selected.content.charCodeAt(start - 1))) start += 1;
	let end = Math.min(start + (limit as number), selected.content.length);
	if (end > start && end < selected.content.length && isLowSurrogate(selected.content.charCodeAt(end)) && isHighSurrogate(selected.content.charCodeAt(end - 1))) end = (limit as number) === 1 && isHighSurrogate(selected.content.charCodeAt(start)) ? Math.min(end + 1, selected.content.length) : end - 1;
	const slice = selected.content.slice(start, end);
	const more = end < selected.content.length;
	let text = `# ${selected.title || selected.url}\n\n${slice}`;
	if (more || start > 0) {
		text += `\n\n---\nShowing chars ${start}-${end} of ${selected.content.length}.`;
		if (more) text += ` Use get_search_content({ responseId: "${responseId}", urlIndex: ${index}, offset: ${end}, limit: ${limit} }) for the next slice.`;
	}
	return { content: [{ type: "text", text }], details: { url: selected.url, title: selected.title, contentLength: selected.content.length, offset: start, limit, returnedChars: end - start, nextOffset: more ? end : null, truncated: more } };
}

function findStoredContent(text: string, queries: string[], mode: "exact" | "case-insensitive" | "fuzzy"):
	{ text: string; details: { matchCount: number; returnedMatches: number; queryResults: Array<{ query: string; matchCount: number }> } } {
	type Match = { query: string; start: number; end: number };
	const normalize = (value: string) => value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase();
	const literal = (value: string, query: string, insensitive: boolean): Match[] => {
		const haystack = insensitive ? value.toLocaleLowerCase() : value;
		const needle = insensitive ? query.toLocaleLowerCase() : query;
		const found: Match[] = [];
		for (let start = haystack.indexOf(needle); start >= 0; start = haystack.indexOf(needle, start + Math.max(1, needle.length)))
			found.push({ query, start, end: start + query.length });
		return found;
	};
	const distanceWithin = (left: string, right: string, maximum: number): boolean => {
		if (Math.abs(left.length - right.length) > maximum) return false;
		let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
		for (let i = 1; i <= left.length; i += 1) {
			const current = [i]; let rowMinimum = i;
			for (let j = 1; j <= right.length; j += 1) {
				const value = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + (left[i - 1] === right[j - 1] ? 0 : 1));
				current[j] = value; rowMinimum = Math.min(rowMinimum, value);
			}
			if (rowMinimum > maximum) return false;
			previous = current;
		}
		return (previous[right.length] ?? maximum + 1) <= maximum;
	};
	const fuzzy = (value: string, query: string): Match[] => {
		const tokens = normalize(query).match(/[\p{L}\p{N}]+/gu) ?? [];
		const found: Match[] = [];
		for (const paragraph of value.matchAll(/[^\n]+(?:\n(?!\n)[^\n]+)*/g)) {
			const paragraphText = paragraph[0] ?? "";
			if (!paragraphText.trim() || paragraph.index === undefined) continue;
			const words = [...paragraphText.matchAll(/[\p{L}\p{N}]+/gu)];
			const matched = tokens.filter((token) => words.some((word) => {
				const max = token.length >= 9 ? 2 : token.length >= 5 ? 1 : 0;
				return distanceWithin(token, normalize(word[0]), max);
			}));
			if (matched.length < (tokens.length === 1 ? 1 : Math.ceil(tokens.length * 0.6))) continue;
			const first = words.find((word) => matched.some((token) => distanceWithin(token, normalize(word[0]), token.length >= 9 ? 2 : token.length >= 5 ? 1 : 0)));
			const start = paragraph.index + (first?.index ?? 0);
			found.push({ query, start, end: start + (first?.[0].length ?? query.length) });
		}
		return found;
	};
	const unique = [...new Set(queries.map((query) => query.trim()).filter(Boolean))];
	const matches = unique.flatMap((query) => mode === "fuzzy" ? fuzzy(text, query) : literal(text, query, mode === "case-insensitive"));
	const queryResults = unique.map((query) => ({ query, matchCount: matches.filter((match) => match.query === query).length }));
	const ranges: Array<{ start: number; end: number; matches: Match[] }> = [];
	for (const match of [...matches].sort((a, b) => a.start - b.start)) {
		const range = { start: Math.max(0, match.start - 400), end: Math.min(text.length, match.end + 400), matches: [match] };
		const previous = ranges.at(-1);
		if (previous && range.start <= previous.end) { previous.end = Math.max(previous.end, range.end); previous.matches.push(match); } else ranges.push(range);
	}
	const heading = `Text matches (${mode})${matches.length ? "" : ": no matches"}`;
	const sections = [heading]; let formattedLength = heading.length; let returnedMatches = 0;
	for (const range of ranges) {
		const snippet = `${range.start > 0 ? "…" : ""}${text.slice(range.start, range.end).replace(/\s+/g, " ").trim()}${range.end < text.length ? "…" : ""}`;
		const counts = [...new Set(range.matches.map((match) => match.query))].map((query) => `\\"${query}\\" ×${range.matches.filter((match) => match.query === query).length}`).join(", ");
		const section = `${sections.length}. ${counts}\n${snippet}`;
		if (formattedLength + 2 + section.length > 20_000) break;
		sections.push(section); formattedLength += 2 + section.length; returnedMatches += range.matches.length;
	}
	const missing = queryResults.filter((result) => result.matchCount === 0).map((result) => `\\"${result.query}\\"`);
	for (const section of [...(missing.length ? [`No matches: ${missing.join(", ")}`] : []), ...(returnedMatches < matches.length ? [`Showing ${returnedMatches} of ${matches.length} matches.`] : [])]) {
		if (formattedLength + 2 + section.length > 20_000) break;
		sections.push(section); formattedLength += 2 + section.length;
	}
	return { text: sections.join("\n\n"), details: { matchCount: matches.length, returnedMatches, queryResults } };
}


function materializeCacheHit(
	pi: PiLike,
	storage: WebAccessStorage,
	record: CacheRecord,
	nextId: string,
	signal?: AbortSignal,
): ToolResult {
	throwIfFetchCacheAborted(signal);
	const storedData = cloneJsonObject(record.storedData)!;
	storedData.id = nextId;
	storedData.timestamp = Date.now();
	try { storage.storeResult(nextId, storedData); } catch { /* durable cache remains authoritative */ }
	throwIfFetchCacheAborted(signal);
	const sessionRecord = allowlistFetchStoredData(storedData, nextId);
	if (!sessionRecord) {
		throw new Error("workflow fetch cache hit produced invalid inline session data");
	}
	throwIfFetchCacheAborted(signal);
	pi.appendEntry?.("web-search-results", sessionRecord);
	return withCacheDetails(rewriteReplayIdentity(record.result, record.responseId, nextId), {
		hit: true,
	});
}

function rewriteReplayIdentity(
	result: ToolResult,
	from: string,
	to: string,
): ToolResult {
	const content = Array.isArray(result.content)
		? result.content.map((entry, index) =>
				index === 0 && entry.type === "text" && typeof entry.text === "string"
					? {
							...entry,
							text: rewriteRetrievalInstructionResponseId(
								entry.text,
								result.details,
								from,
								to,
							),
						}
					: entry,
			)
		: result.content;
	return {
		...result,
		...(content === undefined ? {} : { content }),
		details: {
			...(result.details ?? {}),
			responseId: to,
		},
	};
}

/** Rewrite only the exact v0.24.2 retrieval suffix, never fetched evidence. */
function rewriteRetrievalInstructionResponseId(
	text: string,
	details: Record<string, unknown> | undefined,
	from: string,
	to: string,
): string {
	const instruction = fetchRetrievalInstructionPattern(details, from);
	return instruction ? text.replace(instruction, `$1${to}$2`) : text;
}

function fetchRetrievalInstructionPattern(
	details: Record<string, unknown> | undefined,
	responseId: string,
): RegExp | undefined {
	const escaped = escapeRegExp(responseId);
	const toolName = "[A-Za-z][A-Za-z0-9_-]{0,63}";
	if (details?.urlCount === 1 && details.truncated === true) {
		return new RegExp(
			`(\\n\\n---\\nShowing \\d+ of \\d+ chars, \\d+ of \\d+ bytes, and \\d+ of \\d+ lines\\. Use ${toolName}\\(\\{ responseId: ")${escaped}("[,] urlIndex: 0[,] offset: \\d+ \\}\\) for the next slice\\.)$`,
		);
	}
	if (typeof details?.urlCount === "number" && details.urlCount > 1) {
		return new RegExp(
			`(\\n---\\nUse ${toolName}\\(\\{ responseId: ")${escaped}("[,] urlIndex: 0 \\}\\) to retrieve bounded content slices\\.)$`,
		);
	}
	return undefined;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
	recoverable: boolean,
	retrievalToolName: string | undefined,
): ToolResult {
	const maxChars = normalizeInlineCharCap(maxInlineChars);
	// A cap without a durable response cannot be followed and must not claim
	// that the omitted content remains in the workflow cache.
	if (
		maxChars === undefined ||
		!recoverable ||
		!retrievalToolName ||
		!Array.isArray(result.content) ||
		!stringValue(result.details?.responseId)
	)
		return result;

	let truncated = false;
	const content = result.content.map((entry) => {
		if (entry.type !== "text" || typeof entry.text !== "string") return entry;
		const responseId = stringValue(result.details?.responseId)!;
		const instructionPattern = fetchRetrievalInstructionPattern(
			result.details,
			responseId,
		);
		const instruction = instructionPattern
			? entry.text.match(instructionPattern)?.[0]
			: undefined;
		const bodyEnd = instruction
			? entry.text.length - instruction.length
			: entry.text.length;
		const body = entry.text.slice(0, bodyEnd);
		const capEnd = utf16CapEndpoint(body, maxChars);
		const cappedBody = body.slice(0, capEnd);
		if (cappedBody === body) return entry;
		truncated = true;
		const continuation =
			result.details?.urlCount === 1
				? cappedSingleUrlContinuation({
						instruction,
						cappedBody,
						fullBody: body,
						details: result.details,
						responseId,
						retrievalToolName,
					})
				: (instruction ?? "");
		return {
			...entry,
			text:
				cappedBody +
				`\n\n[Workflow inline fetch content capped at ${maxChars} chars; full source content remains in workflow source cache.]` +
				continuation,
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

function utf16CapEndpoint(value: string, maxChars: number): number {
	let endpoint = Math.min(value.length, maxChars);
	if (
		endpoint > 0 &&
		endpoint < value.length &&
		isLowSurrogate(value.charCodeAt(endpoint)) &&
		isHighSurrogate(value.charCodeAt(endpoint - 1))
	) {
		endpoint -= 1;
	}
	return endpoint;
}

function isHighSurrogate(value: number): boolean {
	return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
	return value >= 0xdc00 && value <= 0xdfff;
}

function cappedSingleUrlContinuation(options: {
	instruction: string | undefined;
	cappedBody: string;
	fullBody: string;
	details: Record<string, unknown>;
	responseId: string;
	retrievalToolName: string;
}): string {
	const match = options.instruction?.match(
		/\n\n---\nShowing (\d+) of (\d+) chars, (\d+) of (\d+) bytes, and (\d+) of (\d+) lines\. Use ([A-Za-z][A-Za-z0-9_-]{0,63})\(\{ responseId: "([^"]+)", urlIndex: 0, offset: (\d+) \}\) for the next slice\.$/,
	);
	const totalChars = positiveCount(match?.[2] ?? options.details.totalChars) ?? options.fullBody.length;
	const totalBytes =
		positiveCount(match?.[4] ?? options.details.totalBytes) ??
		Buffer.byteLength(options.fullBody, "utf8");
	const totalLines =
		positiveCount(match?.[6] ?? options.details.totalLines) ??
		(options.fullBody.length === 0 ? 0 : options.fullBody.split(/\r?\n/).length);
	const toolName = match?.[7] ?? options.retrievalToolName;
	const responseId = match?.[8] ?? options.responseId;
	const shownLines =
		options.cappedBody.length === 0
			? 0
			: options.cappedBody.split(/\r?\n/).length;
	return `\n\n---\nShowing ${options.cappedBody.length} of ${totalChars} chars, ${Buffer.byteLength(options.cappedBody, "utf8")} of ${totalBytes} bytes, and ${shownLines} of ${totalLines} lines. Use ${toolName}({ responseId: "${responseId}", urlIndex: 0, offset: ${options.cappedBody.length} }) for the next slice.`;
}

function positiveCount(value: unknown): number | undefined {
	const number = Number(value);
	return Number.isFinite(number) && number >= 0 ? Math.floor(number) : undefined;
}

function normalizeInlineCharCap(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value)) return undefined;
	const cap = Math.floor(value);
	return cap > 0 ? cap : undefined;
}

function hydrateFetchStoredData(
	storage: WebAccessStorage,
	responseId: string,
	appended: Record<string, unknown>[],
): Record<string, unknown> | undefined {
	let hydrated: unknown;
	try {
		hydrated = storage.getResult?.(responseId);
	} catch {
		hydrated = undefined;
	}
	const fromStorage = allowlistFetchStoredData(hydrated, responseId);
	if (fromStorage) return fromStorage;
	for (let index = appended.length - 1; index >= 0; index -= 1) {
		const fallback = allowlistFetchStoredData(appended[index], responseId);
		if (fallback) return fallback;
	}
	return undefined;
}

function publishCapturedFetchRecords(
	pi: PiLike,
	capture: InvocationCapture,
	result: ToolResult,
): void {
	const responseId = stringValue(result.details?.responseId);
	if (!responseId) return;
	// Only the narrow, validated fetch storage shape may cross back into the
	// session. Everything else—including provider-specific search metadata—is
	// intentionally discarded at this boundary.
	for (const appended of capture.appended) {
		const safe = allowlistFetchStoredData(appended, responseId);
		if (safe) pi.appendEntry?.("web-search-results", safe);
	}
}

function providerFetchCancellationResult(): ToolResult {
	return {
		content: [{ type: "text", text: "Fetch cancelled." }],
		details: { error: "aborted" },
	};
}

function providerFetchFailureResult(error: unknown, signal?: AbortSignal): ToolResult {
	if (signal?.aborted || isWorkflowAbortError(error) || isWorkflowReturnedCancellation(error))
		return providerFetchCancellationResult();
	return {
		content: [{ type: "text", text: "Fetch failed." }],
		details: { error: "fetch_failed" },
	};
}

function allowlistFetchStoredData(
	value: unknown,
	responseId: string,
): Record<string, unknown> | undefined {
	if (!isRecord(value)) return undefined;
	if (value.id !== responseId || value.type !== "fetch") return undefined;
	if (!Array.isArray(value.urls) || value.urls.length === 0) return undefined;
	const urls: Record<string, unknown>[] = [];
	for (const item of value.urls) {
		if (!isRecord(item)) return undefined;
		if (
			typeof item.url !== "string" ||
			typeof item.title !== "string" ||
			typeof item.content !== "string" ||
			(item.error !== undefined &&
				item.error !== null &&
				typeof item.error !== "string")
		)
			return undefined;
		if (!normalizeCacheableUrl(item.url)) return undefined;
		urls.push({
			url: item.url,
			title: redactSensitiveWorkflowText(item.title),
			content: redactSensitiveWorkflowText(item.content),
			error: item.error ? "Fetch failed" : null,
			...(typeof item.duration === "number" && Number.isFinite(item.duration)
				? { duration: item.duration }
				: {}),
			...(typeof item.mimeType === "string"
				? { mimeType: item.mimeType }
				: {}),
			...(typeof item.status === "number" && Number.isFinite(item.status)
				? { status: item.status }
				: {}),
		});
	}
	return {
		id: responseId,
		type: "fetch",
		timestamp:
			typeof value.timestamp === "number" && Number.isFinite(value.timestamp)
				? value.timestamp
				: Date.now(),
		urls,
	};
}

const SAFE_DETAIL_KEYS = new Set([
	"urlCount",
	"successful",
	"totalChars",
	"title",
	"truncated",
	"hasImage",
	"imageCount",
	"timestamp",
	"frames",
	"duration",
	"mode",
	"mimeType",
	"status",
	"totalBytes",
	"totalLines",
	"shownBytes",
	"shownLines",
]);

function allowlistToolResult(
	result: ToolResult,
	responseId: string,
): ToolResult | undefined {
	if (!Array.isArray(result.content)) return undefined;
	const content: Array<Record<string, unknown>> = [];
	for (const entry of result.content) {
		if (entry.type !== "text" || typeof entry.text !== "string")
			return undefined;
		content.push({ type: "text", text: redactSensitiveWorkflowText(entry.text) });
	}
	const details: Record<string, unknown> = { responseId };
	for (const [key, value] of Object.entries(result.details ?? {})) {
		if (
			key === "urls" &&
			Array.isArray(value) &&
			value.every(
				(url): url is string =>
					typeof url === "string" && normalizeCacheableUrl(url) !== undefined,
			)
		) {
			details.urls = [...value];
			continue;
		}
		if (!SAFE_DETAIL_KEYS.has(key)) continue;
		if (
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean" ||
			value === null
		)
			details[key] = typeof value === "string" ? redactSensitiveWorkflowText(value) : value;
	}
	return { content, details };
}

function redactFetchToolResult(result: ToolResult): ToolResult {
	const redactValue = (value: unknown, key?: string): unknown => {
		if (key && isSensitiveWorkflowQueryKey(key)) return "REDACTED";
		if (typeof value === "string") return redactSensitiveWorkflowText(value);
		if (Array.isArray(value)) return value.map((item) => redactValue(item));
		if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactValue(item, name)]));
		return value;
	};
	return redactValue(result) as ToolResult;
}

function cacheWriteSkipReason(
	result: ToolResult,
	storedData: Record<string, unknown> | undefined,
	safeResult: ToolResult | undefined,
): string | undefined {
	if (!storedData) return "missing-stored-data";
	if (!safeResult) return "unsupported-result-shape";
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
	const responseId = stringValue(value.responseId);
	if (!responseId || !isRecord(value.result)) return undefined;
	const storedData = allowlistFetchStoredData(value.storedData, responseId);
	const result = allowlistToolResult(value.result as ToolResult, responseId);
	if (!storedData || !result) return undefined;
	return {
		schema: WORKFLOW_FETCH_CONTENT_CACHE_SCHEMA,
		key,
		createdAt:
			typeof value.createdAt === "string"
				? value.createdAt
				: new Date(0).toISOString(),
		responseId,
		result,
		storedData,
	};
}

async function recordCacheEvent(
	config: WorkflowFetchCacheConfig,
	event: "hit" | "miss" | "write" | "skip",
	key: { key: string; urlCount: number },
	reason?: string,
): Promise<void> {
	const cacheDir = resolve(config.cacheDir);
	const eventPath = resolve(cacheDir, "events.jsonl");
	await appendPrivateFile(
		eventPath,
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
	try {
		const cloned: unknown = JSON.parse(JSON.stringify(value));
		return isRecord(cloned) ? cloned : undefined;
	} catch {
		return undefined;
	}
}

function throwIfFetchCacheAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason ?? new Error("aborted");
}

function fetchResultWasCancelled(result: ToolResult): boolean {
	return isWorkflowReturnedCancellation(result);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function isFileExistsError(error: unknown): boolean {
	return isRecord(error) && (error.code === "EEXIST" || error.code === "ENOTEMPTY");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extensionImportSpecifier(importPath: string): string {
	if (isAbsolute(importPath)) return pathToFileURL(resolve(importPath)).href;
	return importPath;
}
