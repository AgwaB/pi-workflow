import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";

import { assertPiWebAccessEffectiveConfig } from "./pi-web-access-config.js";
import {
	buildWorkflowWebSourceCard,
	createWorkflowWebSource,
	createWorkflowWebVisibleBudget,
	errorToolResult,
	extractSearchCandidateEnvelope,
	extractTextFromToolResult,
	extractTitleFromToolResult,
	findWorkflowWebSourceByUrl,
	normalizeWorkflowWebSecurityPolicy,
	normalizeWorkflowWebSourcePolicy,
	readWorkflowWebSource,
	readWorkflowWebSourceSnippets,
	recordWorkflowWebSourceEvent,
	sanitizeUrlForModel,
	sourceUrlCacheKey,
	toolResultFromJson,
	validateWorkflowWebUrl,
	writeWorkflowWebSource,
	WORKFLOW_WEB_DIRECT_FETCHER,
	WORKFLOW_WEB_DIRECT_FETCH_POLICY,
	WORKFLOW_WEB_SEARCH_PROVIDER_LIMIT,
	WORKFLOW_WEB_SOURCE_TERM_LIMIT,
	countWorkflowWebSourceTerms,
	type WorkflowWebSearchPayload,
	type WorkflowWebSearchProvenance,
	type WorkflowWebSearchStatus,
	type WorkflowWebSecurityPolicy,
	type WorkflowWebSource,
	type WorkflowWebSourceCacheConfig,
	type WorkflowWebSourcePolicy,
	type WorkflowWebSourceReadRequest,
	type WorkflowWebSourceReadResult,
	type WorkflowWebVisibleBudget,
} from "./workflow-web-source.js";
import { nonPublicIpReason } from "./workflow-network-policy.js";
import {
	isWorkflowAbortError,
	isWorkflowReturnedCancellation,
} from "./workflow-cancellation.js";
import { redactSensitiveWorkflowText } from "./workflow-sensitive-query.js";
import {
	ensurePrivateDirectory,
	publishPrivateGenerationDirectory,
	setSecureAtomicBeforeRenameHookForTests,
	writePrivateFileAtomic,
} from "./secure-atomic-write.js";
import { createSafeProviderOnUpdate } from "./workflow-provider-callback.js";

export const WORKFLOW_WEB_SOURCE_LAUNCH_CONFIG_SCHEMA =
	"workflow-web-source-launch-config-v1" as const;

/** Test hook for the visible-budget rename commit point. */
export function setVisibleBudgetBeforeRenameHookForTests(
	hook: ((path: string, temporaryPath: string) => void | Promise<void>) | undefined,
): void {
	setSecureAtomicBeforeRenameHookForTests(hook);
}

export interface WorkflowWebProviderLaunchConfig {
	kind: "pi-web-access" | "extension" | "none";
	extensionPath?: string;
	extensionPaths?: string[];
	/** True when the wrapper also captures the built-in pi-web-access module. */
	usesPiWebAccess?: boolean;
}

export interface WorkflowWebSourceLaunchConfig
	extends WorkflowWebSourceCacheConfig {
	schema: typeof WORKFLOW_WEB_SOURCE_LAUNCH_CONFIG_SCHEMA;
	workflowName?: string;
	stageId?: string;
	taskKey?: string;
	cwd: string;
	provider: WorkflowWebProviderLaunchConfig;
	webSourcePolicy?: Partial<WorkflowWebSourcePolicy>;
	securityPolicy?: Partial<WorkflowWebSecurityPolicy>;
	exposeLegacyTools?: boolean;
	exposedWorkflowTools?: string[];
	requiredProviderTools?: string[];
	/** Re-export only these selected tools from captured provider extensions. */
	passthroughProviderTools?: string[];
	/** Sealed launches force the generated direct-safe fetch transport. */
	directFetchOnly?: boolean;
	/** Canonical tool owners, keyed by resolved provider module path. */
	providerToolOwnerPaths?: Record<string, string[]>;
}

export interface WorkflowWebSourceExtensionWrapperOptions {
	wrapperPath: string;
	importPath: string;
	providerExtensionPath?: string;
	providerExtensionPaths?: string[];
	config: WorkflowWebSourceLaunchConfig;
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
};

type ProviderExtension = (pi: PiLike) => void;
type ProviderExtensions = ProviderExtension | readonly ProviderExtension[];

type CapturedProviderTools = Map<string, ToolSpec>;

type WorkflowWebFetchFlight = {
	promise: Promise<ToolResult>;
	controller: AbortController;
	waiters: number;
	settled: boolean;
	releaseLock?: () => Promise<void>;
	lastWaiter?: () => Promise<void>;
};

type ProviderSearchCapture = {
	active: boolean;
	providers: Set<string>;
};

type FetchFailure = {
	code: string;
	message: string;
	extra: Record<string, unknown>;
	reason?: string;
	createdAt?: string;
};

class WorkflowWebFetchCancelled extends Error {
	constructor() {
		super("workflow web-source fetch cancelled");
		this.name = "WorkflowWebFetchCancelled";
	}
}

const PROVIDER_TOOL_NAMES = new Set([
	"web_search",
	"code_search",
	"fetch_content",
	"get_search_content",
]);
const DIRECT_FETCH_CANONICAL_TOOL_NAMES = new Set([
	"web_search",
	"fetch_content",
	"get_search_content",
]);
const CAPTURED_SEARCH_PROVIDER_LIMIT = 100;
const CAPTURED_SEARCH_RECORD_LIMIT = 1_000;
const WORKFLOW_WEB_FETCH_SOURCE_MAX_REQUESTS = 20;
const PI_WEB_ACCESS_SEARCH_PROVIDER_IDS = new Set([
	"anysearch",
	"bocha",
	"brave",
	"brightdata",
	"duckduckgo",
	"exa",
	"firecrawl",
	"gemini",
	"jina",
	"kagi",
	"ollama",
	"openai",
	"parallel",
	"parallel-mcp",
	"perplexity",
	"querit",
	"search1api",
	"searchinfinity",
	"searxng",
	"serpbase",
	"serpdive",
	"serper",
	"tavily",
	"tinyfish",
	"valyu",
	"xai",
]);

export function registerWorkflowWebSourceExtension(
	pi: PiLike,
	config: WorkflowWebSourceLaunchConfig,
	providerExtension?: ProviderExtensions,
): void {
	const policy = normalizeWorkflowWebSourcePolicy(config.webSourcePolicy);
	const security = normalizeWorkflowWebSecurityPolicy(config.securityPolicy);
	// Budgets are invocation-local. Durable ledger rebasing below is the only
	// shared state; no concurrent call mutates a registration-wide counter.
	const newBudget = () => createWorkflowWebVisibleBudget(
		policy.perTaskVisibleCharBudget,
	);
	const providerTools: CapturedProviderTools = new Map();
	// Canonical provider tools are captured as implementation dependencies, but
	// direct-safe launches must never expose them as legacy or passthrough tools.
	// In particular, normalized search still needs web_search internally.
	const requiredProviderTools = (config.requiredProviderTools ?? []).filter(
		(name) => !config.directFetchOnly || name === "web_search" || !DIRECT_FETCH_CANONICAL_TOOL_NAMES.has(name),
	);
	const configuredProviderTools = [
		...requiredProviderTools,
		...(config.passthroughProviderTools ?? []),
		...(config.directFetchOnly ? [] : PROVIDER_TOOL_NAMES),
	];
	const authorizedProviderTools = new Set(
		configuredProviderTools.filter(
			(name) =>
				!config.directFetchOnly ||
				name === "web_search" ||
				!DIRECT_FETCH_CANONICAL_TOOL_NAMES.has(name),
		),
	);
	if (config.directFetchOnly) authorizedProviderTools.add("web_search");
	const providerSearchCapture = new AsyncLocalStorage<ProviderSearchCapture>();
	const sourceCache: Map<string, WorkflowWebSource> = new Map();
	const fetchInFlight = new Map<string, WorkflowWebFetchFlight>();
	const fetchFailures: Map<string, FetchFailure> = new Map();
	const exposedWorkflowTools = new Set(
		config.exposedWorkflowTools ?? [
			"workflow_web_search",
			"workflow_web_fetch_source",
			"workflow_web_source_read",
		],
	);
	const registerSelectedWorkflowTool = (tool: ToolSpec): void => {
		if (tool.name && exposedWorkflowTools.has(tool.name)) pi.registerTool(tool);
	};
	if (
		config.provider.kind === "pi-web-access" ||
		config.provider.usesPiWebAccess === true
	) {
		assertPiWebAccessEffectiveConfig(requiredProviderTools);
	}
	if (
		(config.directFetchOnly || config.provider.kind === "pi-web-access") &&
		security.allowPrivateHosts
	) {
		throw new Error(
			"workflow direct-safe-fetch requires public-host enforcement; securityPolicy.allowPrivateHosts must be false",
		);
	}

	for (const name of config.passthroughProviderTools ?? []) {
		if (PROVIDER_TOOL_NAMES.has(name)) continue;
		const owners = config.providerToolOwnerPaths?.[name];
		if (!owners || owners.length !== 1 || !owners[0])
			throw new Error(`workflow web provider ownership is missing or ambiguous for passthrough tool ${name}`);
	}
	if (providerExtension) {
		const providerPaths = config.provider.extensionPaths ??
			(config.provider.extensionPath ? [config.provider.extensionPath] : []);
		for (const [index, extension] of (Array.isArray(providerExtension)
			? providerExtension
			: [providerExtension]).entries()) {
			const capturePi = providerCapturePi(
				pi,
				providerTools,
				providerSearchCapture,
				providerPaths[index],
				config.providerToolOwnerPaths,
				authorizedProviderTools,
			);
			extension(capturePi);
		}

	}
	assertRequiredProviderTools(providerTools, requiredProviderTools);
	if (config.exposeLegacyTools && !config.directFetchOnly) {
		for (const [name, tool] of providerTools) {
			if (PROVIDER_TOOL_NAMES.has(name))
				pi.registerTool(wrapProviderToolOnUpdate(tool));
		}
	}
	for (const name of config.passthroughProviderTools ?? []) {
		// directFetchOnly is a registration boundary as well as a transport
		// choice: canonical tools may be captured for normalized operation, but
		// never become visible legacy tools or passthroughs.
		if (config.directFetchOnly && DIRECT_FETCH_CANONICAL_TOOL_NAMES.has(name)) continue;
		const tool = providerTools.get(name);
		if (tool && !exposedWorkflowTools.has(name))
			pi.registerTool(wrapProviderToolOnUpdate(tool));
	}

	registerSelectedWorkflowTool({
		name: "workflow_web_search",
		description:
			"Search the web through the workflow web-source provider and return compact candidate cards only.",
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({ description: "Single search query." }),
			),
			queries: Type.Optional(
				Type.Array(Type.String(), { description: "Multiple search queries." }),
			),
			numResults: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 20,
					description: "Results per query (1-20).",
				}),
			),
		}),
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			const budget = newBudget();
			const providerTool = providerTools.get("web_search");
			if (!providerTool?.execute) {
				return withDurableWorkflowWebBudget(
					config,
					budget,
					signal,
					async () => {
						const missing = missingProviderStatus(providerTools, "search");
						await recordWorkflowWebSourceEvent(config, "missing_provider", {
							tool: "workflow_web_search",
							code: missing.code,
						});
						return workflowWebSearchFailure(
							"failed",
							"search_failed",
							config.provider.kind,
							budgetSnapshot(budget),
						);
					},
					() => workflowWebBudgetMismatch(),
					() => workflowWebSearchCancelled(config.provider.kind, budget.limit),
				);
			}
			const providerParams = isRecord(params)
				? { ...params, workflow: params.workflow ?? "none" }
				: params;
			let result: ToolResult;
			let capturedProviderNames: readonly string[] = [];
			try {
				const captured = await executeProviderSearchWithAttribution(
					providerTool,
					providerSearchCapture,
					toolCallId,
					providerParams,
					signal,
					onUpdate,
					ctx,
					budget,
				);
				result = captured.result;
				capturedProviderNames = captured.providers;
			} catch (error: unknown) {
				const cancelled = signal?.aborted === true || isAbortError(error);
				const status: WorkflowWebSearchStatus = cancelled
					? "cancelled"
					: "failed";
				const code = cancelled ? "search_cancelled" : "search_failed";
				return withDurableWorkflowWebBudget(
					config,
					budget,
					signal,
					async () => {
						await recordWorkflowWebSourceEvent(config, "search", {
							status,
							code,
							candidateCount: 0,
							visibleChars: budget.used,
						});
						return workflowWebSearchFailure(
							status,
							code,
							config.provider.kind,
							budgetSnapshot(budget),
						);
					},
					() => workflowWebBudgetMismatch(),
					() => workflowWebSearchCancelled(config.provider.kind, budget.limit),
				);
			}
			const normalized = normalizeWorkflowWebSearchResult(
				result,
				config.provider.kind,
				policy,
				signal?.aborted === true,
				capturedProviderNames,
			);
			return withDurableWorkflowWebBudget(
				config,
				budget,
				signal,
				async () => {
					const candidates = normalized.candidates.map((candidate) => {
						const consumed = consumeText(
							budget,
							candidate.snippet,
							policy.searchSnippetChars,
						);
						return {
							...candidate,
							snippet: consumed.text,
							budget: consumed.budget,
						};
					});
					await recordWorkflowWebSourceEvent(config, "search", {
						status: normalized.status,
						...(normalized.code ? { code: normalized.code } : {}),
						candidateCount: normalized.candidateCountReturned,
						candidateCountTotal: normalized.candidateCountTotal,
						truncated: normalized.truncated,
						visibleChars: budget.used,
					});
					return toolResultFromJson({
						...normalized,
						tool: "workflow_web_search",
						candidates,
						budget: budgetSnapshot(
							budget,
							candidates.some((candidate) => candidate.budget.truncated),
						),
						next:
							normalized.status === "cancelled"
								? "Search was cancelled; do not fetch candidates or infer sources from this response."
								: candidates.length === 0
									? "Search returned no usable candidate URL; retry with a different query or report that search evidence is unavailable."
									: "Use workflow_web_fetch_source for a promising URL, then workflow_web_source_read for exact evidence quotes.",
					});
				},
				() => workflowWebBudgetMismatch(),
				() => workflowWebSearchCancelled(config.provider.kind, budget.limit),
			);
		},
		});

	registerSelectedWorkflowTool({
		name: "workflow_web_fetch_source",
		description:
			"Fetch one or more URLs into the workflow web-source cache and return compact source cards with sourceRefs.",
		parameters: Type.Object({
			url: Type.Optional(
				Type.String({
					description:
						"Single URL to fetch into the workflow web-source cache.",
				}),
			),
			urls: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Multiple URLs to fetch in one tool call. Prefer this over repeated fetch calls when caching several promising sources.",
				}),
			),
			sources: Type.Optional(
				Type.Array(
					Type.Object({
						url: Type.String({
							description: "URL to fetch into the workflow web-source cache.",
						}),
						title: Type.Optional(
							Type.String({ description: "Optional source title override." }),
						),
					}),
					{
						description:
							"Multiple URL/title objects to fetch in one tool call.",
					},
				),
			),
			title: Type.Optional(
				Type.String({
					description: "Optional source title override for single-url fetches.",
				}),
			),
			titles: Type.Optional(
				Type.Array(Type.String(), {
					description: "Optional title overrides paired by index with urls.",
				}),
			),
		}),
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			const budget = newBudget();
			if (signal?.aborted) return workflowWebFetchCancelled(budget.limit);
			const batchRequested = fetchSourceBatchRequested(params);
			if (batchRequested) {
				const suppliedRequests = fetchSourceRequestsFromParams(params);
				if (suppliedRequests.length === 0) {
					return errorToolResult(
						"invalid_params",
						"workflow_web_fetch_source requires url, urls, or sources parameters.",
					);
				}
				const checkedRequests = suppliedRequests.map((request) => ({
					request,
					checked: validateWorkflowWebUrl(request.url, security),
				}));
				const sensitiveRequest = checkedRequests.find(
					(entry) =>
						!entry.checked.ok &&
						isSensitiveWorkflowWebUrlReason(entry.checked.reason),
				);
				if (sensitiveRequest && !sensitiveRequest.checked.ok) {
					return errorToolResult(
						"blocked_url",
						"URL blocked by workflow web-source security policy.",
						{
							reason: sensitiveRequest.checked.reason,
							url: sanitizeUrlForModel(sensitiveRequest.request.url),
						},
					);
				}
				if (
					suppliedRequests.length > WORKFLOW_WEB_FETCH_SOURCE_MAX_REQUESTS
				) {
					return errorToolResult(
						"invalid_params",
						`workflow_web_fetch_source accepts at most ${WORKFLOW_WEB_FETCH_SOURCE_MAX_REQUESTS} combined url, urls, and sources entries.`,
						{
							reason: "fetch_source_batch_limit_exceeded",
							maximum: WORKFLOW_WEB_FETCH_SOURCE_MAX_REQUESTS,
							requested: suppliedRequests.length,
						},
					);
				}
				return await withDurableWorkflowWebBudget(
					config,
					budget,
					signal,
					async () => {
				const requests = dedupeFetchSourceRequests(suppliedRequests);
				const results: Array<Record<string, unknown>> = [];
				const cards: Record<string, unknown>[] = [];
				for (const [index, request] of requests.entries()) {
					const result = await fetchWorkflowWebSourceOnce(
						`${toolCallId}-${index}`,
						request,
						budget,
						signal,
						onUpdate,
						ctx,
					);
					if (isWorkflowWebFetchCancelledResult(result)) {
						return workflowWebFetchCancelled(budget.limit);
					}
					const payload = payloadFromToolResult(result);
					const card = isRecord(payload.card) ? payload.card : null;
					if (card) cards.push(card);
					results.push({
						index,
						url: sanitizeUrlForModel(request.url),
						status:
							typeof payload.status === "string" ? payload.status : "unknown",
						...(typeof payload.code === "string" ? { code: payload.code } : {}),
						...(typeof payload.message === "string"
							? { message: payload.message }
							: {}),
						...(typeof card?.sourceRef === "string"
							? { sourceRef: card.sourceRef }
							: {}),
						...(card ? { cardIndex: cards.length - 1 } : {}),
					});
				}
				const status =
					cards.length === results.length
						? "ok"
						: cards.length > 0
							? "partial"
							: "failed";
				await recordWorkflowWebSourceEvent(config, "fetch_batch", {
					requested: requests.length,
					succeeded: cards.length,
					visibleChars: budget.used,
				});
				return toolResultFromJson({
					status,
					tool: "workflow_web_fetch_source",
					cards,
					results,
					budget: budgetSnapshot(budget, cards.some((card) =>
						isRecord(card.budget) && card.budget.truncated === true)),
					next: "Use returned sourceRefs with workflow_web_source_read; batch snippets with reads:[...] or queries:[...] when possible.",
				});
					},
					() => workflowWebBudgetMismatch(),
					() => workflowWebFetchCancelled(budget.limit),
				);
			}
			const singleUrl = urlFromParams(params);
			if (!singleUrl) return errorToolResult(
				"invalid_params",
				"workflow_web_fetch_source requires a url string parameter.",
			);
			const checkedSingle = validateWorkflowWebUrl(singleUrl, security);
			if (signal?.aborted) return workflowWebFetchCancelled(budget.limit);
			if (!checkedSingle.ok) {
				return errorToolResult(
					"blocked_url",
					"URL blocked by workflow web-source security policy.",
					{ reason: checkedSingle.reason, url: sanitizeUrlForModel(singleUrl) },
				);
			}
			return await withDurableWorkflowWebBudget(
				config,
				budget,
				signal,
				() => fetchWorkflowWebSourceOnce(
					toolCallId,
					params,
					budget,
					signal,
					onUpdate,
					ctx,
				),
				() => workflowWebBudgetMismatch(),
				() => workflowWebFetchCancelled(budget.limit),
			);
		},
	});

	async function fetchWorkflowWebSourceOnce(
		toolCallId: string,
		params: unknown,
		budget: WorkflowWebVisibleBudget,
		signal?: AbortSignal,
		onUpdate?: unknown,
		ctx?: unknown,
	): Promise<ToolResult> {
		if (signal?.aborted) throw new WorkflowWebFetchCancelled();
		const url = urlFromParams(params);
		if (!url) {
			return errorToolResult(
				"invalid_params",
				"workflow_web_fetch_source requires a url string parameter.",
			);
		}
		const checked = validateWorkflowWebUrl(url, security);
		if (!checked.ok) {
			if (signal?.aborted) throw new WorkflowWebFetchCancelled();
			if (!isSensitiveWorkflowWebUrlReason(checked.reason)) {
				await recordWorkflowWebSourceEvent(config, "blocked_url", {
					url: sanitizeUrlForModel(url),
					reason: checked.reason,
				});
			}
			return errorToolResult(
				"blocked_url",
				"URL blocked by workflow web-source security policy.",
				{
					reason: checked.reason,
					url: sanitizeUrlForModel(url),
				},
			);
		}
		const fetchUrl = canonicalWorkflowWebFetchUrl(checked.normalizedUrl);
		const existing = await findWorkflowWebSourceByUrl(config, fetchUrl);
		if (signal?.aborted) throw new WorkflowWebFetchCancelled();
		if (existing && (!config.directFetchOnly || await isDirectSafeCachedSource(config, existing))) {
			sourceCache.set(existing.sourceRef, existing);
			const card = buildWorkflowWebSourceCard({
				source: existing,
				policy,
				budget,
				duplicate: true,
			});
			await recordWorkflowWebSourceEvent(config, "fetch_duplicate", {
				sourceRef: existing.sourceRef,
				url: existing.redactedUrl,
				visibleChars: budget.used,
			});
			return toolResultFromJson({
				status: "ok",
				tool: "workflow_web_fetch_source",
				card,
			});
		}
		const fetchKey = sourceUrlCacheKey(fetchUrl);
		const cachedFailure =
			fetchFailures.get(fetchKey) ??
			(await readDurableFetchFailure(config, fetchKey));
		if (signal?.aborted) throw new WorkflowWebFetchCancelled();
		if (cachedFailure) {
			fetchFailures.set(fetchKey, cachedFailure);
			await recordWorkflowWebSourceEvent(config, "fetch_negative_cache_hit", {
				url: sanitizeUrlForModel(fetchUrl),
				code: cachedFailure.code,
			});
			return errorToolResult(
				cachedFailure.code,
				cachedFailure.message,
				cachedFailure.extra,
			);
		}
		let inFlight = fetchInFlight.get(fetchKey);
		// A flight whose operation was aborted is never a valid late-waiter
		// target.  Evict it synchronously with the identity check so a caller
		// arriving after the last waiter cancelled can install a replacement,
		// rather than inheriting the old cancellation result.
		if (inFlight && (inFlight.settled || inFlight.controller.signal.aborted)) {
			if (fetchInFlight.get(fetchKey) === inFlight)
				fetchInFlight.delete(fetchKey);
			inFlight = fetchInFlight.get(fetchKey);
		}
		if (inFlight) {
			const result = await awaitSharedWorkflowWebFetch(inFlight, signal, budget.limit);
			if (isWorkflowWebFetchCancelledResult(result))
				return workflowWebFetchCancelled(budget.limit);
			const source = await findWorkflowWebSourceByUrl(config, fetchUrl);
			if (!source) return result;
			sourceCache.set(source.sourceRef, source);
			const card = buildWorkflowWebSourceCard({
				source,
				policy,
				budget,
				duplicate: true,
			});
			await recordWorkflowWebSourceEvent(config, "fetch_duplicate", {
				sourceRef: source.sourceRef,
				url: source.redactedUrl,
				visibleChars: budget.used,
			});
			return toolResultFromJson({
				status: "ok",
				tool: "workflow_web_fetch_source",
				card,
			});
		}
		const controller = new AbortController();
		let operationLockRelease: (() => Promise<void>) | undefined;
		const fetchPromise = withWorkflowWebFetchLock(
			config,
			fetchKey,
			controller.signal,
			async () => {
				// The operation owns this signal. Caller signals are waiter-local and
				// must never be passed into provider or direct-fetch transport.
				const signal = controller.signal;
				const lockedExisting = await findWorkflowWebSourceByUrl(
					config,
					fetchUrl,
				);
				if (lockedExisting && (!config.directFetchOnly || await isDirectSafeCachedSource(config, lockedExisting))) {
					sourceCache.set(lockedExisting.sourceRef, lockedExisting);
					const card = buildWorkflowWebSourceCard({
						source: lockedExisting,
						policy,
						budget,
						duplicate: true,
					});
					await recordWorkflowWebSourceEvent(config, "fetch_duplicate", {
						sourceRef: lockedExisting.sourceRef,
						url: lockedExisting.redactedUrl,
						visibleChars: budget.used,
					});
					return toolResultFromJson({
						status: "ok",
						tool: "workflow_web_fetch_source",
						card,
					});
				}
				const lockedFailure = await readDurableFetchFailure(config, fetchKey);
				if (signal?.aborted) throw new WorkflowWebFetchCancelled();
				if (lockedFailure) {
					fetchFailures.set(fetchKey, lockedFailure);
					await recordWorkflowWebSourceEvent(
						config,
						"fetch_negative_cache_hit",
						{
							url: sanitizeUrlForModel(fetchUrl),
							code: lockedFailure.code,
						},
					);
					return errorToolResult(
						lockedFailure.code,
						lockedFailure.message,
						lockedFailure.extra,
					);
				}
				let text: string;
				let title = titleFromParams(params);
				let providerKind: string = config.provider.kind;
				let extractionLossy: boolean | undefined;
				let effectiveUrl: string | undefined;
				let providerAliases: string[] = [];
				// Search ownership and fetch transport are deliberately independent.
				// Sealed/prepared launches use direct-safe public HTTP even with custom search.
				if (config.directFetchOnly || config.provider.kind === "pi-web-access") {
				// Even when search comes from a custom extension, source fetching uses
				// the same direct-safe public HTTP transport and redirect/DNS policy.
				const directSecurity = { ...security, allowPrivateHosts: false };
				const safeFetch = await safeFetchWorkflowWebText(
					fetchUrl,
					directSecurity,
					signal,
				);
				if (!safeFetch.ok) {
					if (signal?.aborted || safeFetch.reason === "aborted")
						throw new WorkflowWebFetchCancelled();
					return await cachedFetchFailureResult(
						config,
						fetchFailures,
						fetchKey,
						{
							code: "blocked_url",
							message:
								"URL was blocked by workflow web-source security policy before direct fetch.",
							extra: {
									reason: safeFetch.reason,
									url: sanitizeUrlForModel(safeFetch.url),
							},
							reason: safeFetch.reason,
							event: {
								type: "blocked_provider_url",
								data: { url: sanitizeUrlForModel(safeFetch.url), reason: safeFetch.reason },
							},
						},
						signal,
					);
				}
				text = redactSensitiveWorkflowText(safeFetch.text);
				effectiveUrl = safeFetch.url;
				providerAliases = safeFetch.aliases ?? [];
				title = title ?? safeFetch.title;
				extractionLossy = safeFetch.extractionLossy;
				providerKind = WORKFLOW_WEB_DIRECT_FETCHER;
				} else {
					const providerTool = providerTools.get("fetch_content");
					if (!providerTool?.execute) {
						const missing = missingProviderStatus(providerTools, "fetch");
						await recordWorkflowWebSourceEvent(config, "missing_provider", { tool: "workflow_web_fetch_source", code: missing.code });
						return errorToolResult(missing.code, missing.message);
					}
					const providerHostCheck = await validateResolvedHost(fetchUrl, security, signal);
					if (!providerHostCheck.ok) {
						return await cachedFetchFailureResult(config, fetchFailures, fetchKey, {
							code: "blocked_url",
							message: "URL was blocked by workflow web-source security policy before provider fetch.",
							extra: { reason: providerHostCheck.reason, url: sanitizeUrlForModel(providerHostCheck.url) },
							reason: providerHostCheck.reason,
							event: {
								type: "blocked_provider_url",
								data: { url: sanitizeUrlForModel(providerHostCheck.url), reason: providerHostCheck.reason },
							},
						}, signal);
					}
					const updateGate = createSafeProviderOnUpdate(onUpdate, {
						maxVisibleChars: Math.max(0, budget.limit - budget.used),
						onVisibleChars: (count) => { budget.used += count; },
					});
					let result: ToolResult;
					try {
						result = await providerTool.execute(
							toolCallId,
							{ ...(isRecord(params) ? params : {}), url: fetchUrl },
							signal,
							updateGate.callback,
							ctx,
						);
					} finally {
						updateGate.close();
					}
					if (signal?.aborted || providerResultWasCancelled(result))
						throw new WorkflowWebFetchCancelled();
					const providerUrlCheck = await validateProviderResultUrls(result, security, signal);
					if (!providerUrlCheck.ok) {
						return await cachedFetchFailureResult(config, fetchFailures, fetchKey, {
							code: "blocked_url",
							message: "Provider result URL was blocked by workflow web-source security policy.",
							extra: { reason: providerUrlCheck.reason, url: sanitizeUrlForModel(providerUrlCheck.url) },
							reason: providerUrlCheck.reason,
							event: {
								type: "blocked_provider_url",
								data: { url: sanitizeUrlForModel(providerUrlCheck.url), reason: providerUrlCheck.reason },
							},
						}, signal);
					}
					effectiveUrl = providerUrlCheck.effectiveUrls?.[0];
					providerAliases = providerUrlCheck.effectiveUrls ?? [];
					text = redactSensitiveWorkflowText(extractTextFromToolResult(result));
					title = title ?? extractTitleFromToolResult(result);
				}
				if (signal?.aborted) throw new WorkflowWebFetchCancelled();
				if (!text.trim()) {
					return await cachedFetchFailureResult(
						config,
						fetchFailures,
						fetchKey,
						{
							code: "empty_source",
							message: "Provider returned no extractable text for this URL.",
							extra: { url: sanitizeUrlForModel(fetchUrl) },
							reason: "empty_source",
							event: {
								type: "fetch_empty",
								data: { url: sanitizeUrlForModel(fetchUrl) },
							},
						},
						signal,
					);
				}
				const source = createWorkflowWebSource({
					config,
					url: fetchUrl,
					text,
					title,
					provider: providerKind,
					...(effectiveUrl ? { effectiveUrl } : {}),
					...(providerAliases.length ? { aliases: providerAliases } : {}),
					...(providerKind === WORKFLOW_WEB_DIRECT_FETCHER
						? {
								provenance: {
									fetcher: WORKFLOW_WEB_DIRECT_FETCHER,
									policy: WORKFLOW_WEB_DIRECT_FETCH_POLICY,
								},
							}
						: {}),
					extractionLossy,
				});
				if (providerKind === WORKFLOW_WEB_DIRECT_FETCHER &&
					!(await isDirectSafeCachedSource(config, source)))
					throw new Error("direct-safe source validation failed");
				const canonicalSource = await writeWorkflowWebSource(config, source, signal);
				if (providerKind === WORKFLOW_WEB_DIRECT_FETCHER &&
					!(await isDirectSafeCachedSource(config, canonicalSource)))
					throw new Error("direct-safe canonical source validation failed");
				sourceCache.set(canonicalSource.sourceRef, canonicalSource);
				const card = buildWorkflowWebSourceCard({ source: canonicalSource, policy, budget });
				await recordWorkflowWebSourceEvent(config, "fetch_write", {
					sourceRef: canonicalSource.sourceRef,
					url: canonicalSource.redactedUrl,
					textChars: canonicalSource.textChars,
					visibleChars: budget.used,
				});
				return toolResultFromJson({
					status: "ok",
					tool: "workflow_web_fetch_source",
					card,
				});
			},
			(release) => {
				operationLockRelease = release;
			},
		).catch(async (error: unknown) => {
			const operationSignal = controller.signal;
			if (
				error instanceof WorkflowWebFetchCancelled ||
				operationSignal.aborted ||
				isAbortError(error)
			)
				return workflowWebFetchCancelled(budget.limit);
			const message =
				error instanceof Error ? error.message : "workflow_web_fetch_failed";
			const code =
				message === "fetch_lock_timeout"
					? "fetch_lock_timeout"
					: "workflow_web_fetch_failed";
			await recordWorkflowWebSourceEvent(config, "fetch_failed", {
				url: sanitizeUrlForModel(fetchUrl),
				code,
			});
			return errorToolResult(
				code,
				"Workflow web-source fetch failed before a source could be cached.",
				{
					url: sanitizeUrlForModel(fetchUrl),
				},
			);
		});
		let flight!: WorkflowWebFetchFlight;
		flight = {
			controller,
			waiters: 0,
			settled: false,
			releaseLock: async () => {
				await operationLockRelease?.();
			},
			lastWaiter: async () => {
				// Eviction and operation abort happen in this turn. A replacement
				// must never inherit a generation whose only waiters have left.
				if (fetchInFlight.get(fetchKey) === flight) fetchInFlight.delete(fetchKey);
				if (!controller.signal.aborted) controller.abort();
				// A provider is allowed to ignore AbortSignal. Release the durable
				// fetch lock independently; the lock lease is fenced and idempotent.
				await flight.releaseLock?.();
			},
			promise: fetchPromise.finally(() => {
				flight.settled = true;
				if (fetchInFlight.get(fetchKey) === flight) fetchInFlight.delete(fetchKey);
			}),
		};
		fetchInFlight.set(fetchKey, flight);
		const result = await awaitSharedWorkflowWebFetch(flight, signal, budget.limit);
		return isWorkflowWebFetchCancelledResult(result)
			? workflowWebFetchCancelled(budget.limit)
			: result;
	}

	registerSelectedWorkflowTool({
		name: "workflow_web_source_read",
		description:
			"Read one or more narrow exact/fuzzy/term-matched snippets from a cached workflow web source by sourceRef.",
		parameters: Type.Object({
			sourceRef: Type.String({
				description: "Opaque sourceRef returned by workflow_web_fetch_source.",
			}),
			query: Type.Optional(
				Type.String({
					description: "Exact or fuzzy text to locate in the cached source.",
				}),
			),
			queries: Type.Optional(
				Type.Array(Type.String(), {
					maxItems: WORKFLOW_WEB_FETCH_SOURCE_MAX_REQUESTS,
					description:
						"Multiple exact/fuzzy texts to locate in one cached source (maximum 20). Prefer this over repeated calls when reading several snippets from the same sourceRef.",
				}),
			),
			exact: Type.Optional(
				Type.String({
					description: "Exact text to locate in the cached source.",
				}),
			),
			exactTexts: Type.Optional(
				Type.Array(Type.String(), {
					maxItems: WORKFLOW_WEB_FETCH_SOURCE_MAX_REQUESTS,
					description: "Multiple exact texts to locate in one cached source (maximum 20).",
				}),
			),
			claim: Type.Optional(
				Type.String({
					description:
						"Claim to locate when the exact quote is not known. Use with terms for deterministic quote harvesting.",
				}),
			),
			terms: Type.Optional(
				Type.Array(Type.String(), {
					maxItems: WORKFLOW_WEB_SOURCE_TERM_LIMIT,
					description:
						"Important terms that should co-occur in the returned source window (maximum 16).",
				}),
			),
			reads: Type.Optional(
				Type.Array(
					Type.Object({
						query: Type.Optional(
							Type.String({ description: "Exact or fuzzy text to locate." }),
						),
						exact: Type.Optional(
							Type.String({ description: "Exact text to locate." }),
						),
						exactText: Type.Optional(
							Type.String({ description: "Exact text to locate." }),
						),
						text: Type.Optional(
							Type.String({ description: "Text to locate." }),
						),
						claim: Type.Optional(
							Type.String({
								description: "Claim to locate when exact quote is unknown.",
							}),
						),
						terms: Type.Optional(
							Type.Array(Type.String(), {
								maxItems: WORKFLOW_WEB_SOURCE_TERM_LIMIT,
								description:
									"Important terms for deterministic quote harvesting (maximum 16).",
							}),
						),
						maxChars: Type.Optional(
							Type.Number({
								description:
									"Maximum visible snippet characters for this read.",
							}),
						),
					}),
					{
						maxItems: WORKFLOW_WEB_FETCH_SOURCE_MAX_REQUESTS,
						description:
							"Mixed batch reads for one sourceRef (maximum 20); each item can use query or claim+terms.",
					},
				),
			),
			maxChars: Type.Optional(
				Type.Number({
					description: "Maximum visible snippet characters per query.",
				}),
			),
		}),
		execute: async (_toolCallId, params, signal) => {
			const budget = newBudget();
			const sourceRef =
				stringParam(params, "sourceRef") ?? stringParam(params, "source_ref");
			const requestedReadCount = sourceReadRequestCount(params);
			if (requestedReadCount > WORKFLOW_WEB_FETCH_SOURCE_MAX_REQUESTS) {
				return errorToolResult(
					"invalid_params",
					`workflow_web_source_read accepts at most ${WORKFLOW_WEB_FETCH_SOURCE_MAX_REQUESTS} read requests.`,
					{
						reason: "source_read_batch_limit_exceeded",
						maximum: WORKFLOW_WEB_FETCH_SOURCE_MAX_REQUESTS,
						requested: requestedReadCount,
					},
				);
			}
			const requests = sourceReadRequestsFromParams(params);
			const excessiveTerms = requests.find(
				(request) =>
					countWorkflowWebSourceTerms(request.terms) >
					WORKFLOW_WEB_SOURCE_TERM_LIMIT,
			);
			if (excessiveTerms) {
				return errorToolResult(
					"invalid_params",
					`workflow_web_source_read accepts at most ${WORKFLOW_WEB_SOURCE_TERM_LIMIT} explicit terms per read.`,
					{
						reason: "source_read_term_limit_exceeded",
						maximum: WORKFLOW_WEB_SOURCE_TERM_LIMIT,
						requested: countWorkflowWebSourceTerms(excessiveTerms.terms),
					},
				);
			}
			return withDurableWorkflowWebBudget(
				config,
				budget,
				signal,
				async () => {
			if (!sourceRef || requests.length === 0) {
				return errorToolResult(
					"invalid_params",
					"workflow_web_source_read requires sourceRef and query/exactText, claim/terms, queries/exactTexts, or reads parameters.",
				);
			}
			const source = await readCachedWorkflowWebSource(sourceRef);
			if (!source) {
				await recordWorkflowWebSourceEvent(config, "source_read_missing", {
					sourceRef,
				});
				return errorToolResult(
					"source_not_found",
					"No cached workflow web source exists for sourceRef.",
					{
						sourceRef,
					},
				);
			}
			const maxChars =
				positiveIntParam(params, "maxChars") ?? policy.sourceReadMaxChars;
			const perQueryMaxChars = Math.min(maxChars, policy.sourceReadMaxChars);
			const reads = readWorkflowWebSourceSnippets({
				source,
				requests: requests.map((request) => ({
					...request,
					maxChars: Math.min(
						request.maxChars ?? perQueryMaxChars,
						policy.sourceReadMaxChars,
					),
				})),
				maxChars: perQueryMaxChars,
				budget,
			});
			const results = reads.map((read, index) => {
				const request = requests[index]!;
				const status = sourceReadResponseStatus(read);
				return {
					index,
					...(request.query ? { query: redactSourceReadEcho(request.query) } : {}),
					...(request.claim ? { claim: redactSourceReadEcho(request.claim) } : {}),
					...(request.terms?.length ? { terms: request.terms.map(redactSourceReadEcho) } : {}),
					status,
					matchType: read.matchType,
					matchedTerms: read.matchedTerms?.map(redactSourceReadEcho),
					missingTerms: read.missingTerms?.map(redactSourceReadEcho),
					coverageRatio: read.coverageRatio,
					candidateOnly: read.candidateOnly,
					truncated: read.truncated,
					quote: status === "budget_exhausted" ? undefined : read.quote,
					startOffset: read.startOffset,
					endOffset: read.endOffset,
					visibleChars: read.visibleChars,
				};
			});
			const responseStatus = aggregateSourceReadStatus(
				results.map((result) => result.status),
			);
			const visibleChars = results.reduce(
				(total, result) => total + result.visibleChars,
				0,
			);
			await recordWorkflowWebSourceEvent(config, "source_read", {
				sourceRef,
				status: responseStatus,
				resultCount: results.length,
				visibleChars,
			});
			if (requests.length === 1 && !sourceReadBatchRequested(params)) {
				const result = results[0]!;
				return toolResultFromJson({
					status: result.status,
					tool: "workflow_web_source_read",
					sourceRef,
					url: source.redactedUrl,
					...(result.query ? { query: redactSourceReadEcho(result.query) } : {}),
					...(result.claim ? { claim: redactSourceReadEcho(result.claim) } : {}),
					...(result.terms?.length ? { terms: result.terms.map(redactSourceReadEcho) } : {}),
					matchType: result.matchType,
					matchedTerms: result.matchedTerms?.map(redactSourceReadEcho),
					missingTerms: result.missingTerms?.map(redactSourceReadEcho),
					coverageRatio: result.coverageRatio,
					candidateOnly: result.candidateOnly,
					truncated: result.truncated,
					quote:
						result.status === "budget_exhausted" ? undefined : result.quote,
					startOffset: result.startOffset,
					endOffset: result.endOffset,
					budget: budgetSnapshot(
						budget,
						result.status === "budget_exhausted" ||
							result.status === "truncated",
					),
					next:
						result.status === "budget_exhausted"
							? "Visible web-source budget is exhausted for this task; cite the sourceRef as an evidence gap or use a smaller query in a fresh task."
							: result.status === "truncated"
								? "The matched web-source snippet was truncated by the visible budget or maxChars; use a smaller exact query or a fresh task if the full quote is required."
								: undefined,
				});
			}
			const hasBudgetExhaustedRead = results.some(
				(result) => result.status === "budget_exhausted",
			);
			const hasTruncatedRead = results.some(
				(result) => result.status === "truncated",
			);
			return toolResultFromJson({
				status: responseStatus,
				tool: "workflow_web_source_read",
				sourceRef,
				url: source.redactedUrl,
				results,
				budget: budgetSnapshot(budget, hasBudgetExhaustedRead || hasTruncatedRead),
				next: hasBudgetExhaustedRead
					? "Visible web-source budget is exhausted for this task; cite missing quotes as evidence gaps or use smaller query batches in a fresh task."
					: hasTruncatedRead
						? "One or more matched web-source snippets were truncated by the visible budget or maxChars; use smaller exact queries or a fresh task if full quotes are required."
						: undefined,
			});
				},
				() => workflowWebBudgetMismatch(),
			);
		},
	});

	async function readCachedWorkflowWebSource(
		sourceRef: string,
	): Promise<WorkflowWebSource | undefined> {
		const cached = sourceCache.get(sourceRef);
		if (cached) return cached;
		const source = await readWorkflowWebSource(config, sourceRef);
		if (source) sourceCache.set(sourceRef, source);
		return source;
	}

	function consumeText(budget: WorkflowWebVisibleBudget, text: string, maxChars: number) {
		const remainingBefore = Math.max(0, budget.limit - budget.used);
		const allowed = Math.max(0, Math.min(maxChars, remainingBefore));
		const visible = text.slice(0, allowed);
		budget.used += visible.length;
		return { text: visible, budget: budgetSnapshot(budget, text.length > allowed) };
	}

	function budgetSnapshot(budget: WorkflowWebVisibleBudget, truncated = false) {
		return {
			limit: budget.limit,
			used: budget.used,
			remaining: Math.max(0, budget.limit - budget.used),
			truncated,
		};
	}
}

export function buildWorkflowWebSourceExtensionWrapper(
	options: Omit<WorkflowWebSourceExtensionWrapperOptions, "wrapperPath">,
): string {
	const providerPaths = options.providerExtensionPaths ??
		(options.providerExtensionPath ? [options.providerExtensionPath] : []);
	const providerImports = providerPaths.map((path, index) =>
		`import providerExtension${index} from ${JSON.stringify(extensionImportSpecifier(path))};`,
	);
	const providerValue = providerPaths.length === 0
		? "const providerExtension = undefined;"
		: providerPaths.length === 1
			? "const providerExtension = providerExtension0;"
			: `const providerExtension = [${providerPaths.map((_, index) => `providerExtension${index}`).join(", ")}];`;
	return [
		`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`,
		...providerImports,
		providerValue,
		`import { registerWorkflowWebSourceExtension } from ${JSON.stringify(extensionImportSpecifier(options.importPath))};`,
		"",
		"export default function workflowWebSourceGeneratedExtension(pi: ExtensionAPI): void {",
		`	registerWorkflowWebSourceExtension(pi as any, ${JSON.stringify(options.config, null, "\t").replace(/\n/g, "\n\t")}, providerExtension as any);`,
		"}",
		"",
	].join("\n");
}

export async function writeWorkflowWebSourceExtensionWrapper(
	options: WorkflowWebSourceExtensionWrapperOptions,
): Promise<string> {
	const wrapperPath = resolve(options.wrapperPath);
	await mkdir(dirname(wrapperPath), { recursive: true });
	const content = buildWorkflowWebSourceExtensionWrapper({
		importPath: options.importPath,
		providerExtensionPath: options.providerExtensionPath,
		providerExtensionPaths: options.providerExtensionPaths,
		config: options.config,
	});
	await writeFile(wrapperPath, content, "utf8");
	return wrapperPath;
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) throw new WorkflowWebBudgetCancelled();
	await new Promise<void>((resolveSleep, reject) => {
		const timer = setTimeout(done, ms);
		const onAbort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(new WorkflowWebBudgetCancelled());
		};
		function done() {
			signal?.removeEventListener("abort", onAbort);
			resolveSleep();
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function missingProviderStatus(
	providerTools: CapturedProviderTools,
	capability: "search" | "fetch",
): { code: "no_web_provider" | "missing_web_capability"; message: string } {
	if (providerTools.size === 0) {
		return {
			code: "no_web_provider",
			message:
				"No workflow web provider is configured. Configure a web provider extension or use a workflow without web tools.",
		};
	}
	return {
		code: "missing_web_capability",
		message: `The configured workflow web provider does not expose ${capability} capability. Configure a provider with that capability or report the evidence gap.`,
	};
}

function throwIfWorkflowWebFetchAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new WorkflowWebFetchCancelled();
}

async function cachedFetchFailureResult(
	config: WorkflowWebSourceCacheConfig,
	cache: Map<string, FetchFailure>,
	key: string,
	failure: {
		code: string;
		message: string;
		extra: Record<string, unknown>;
		reason: string;
		event?: {
			type: "blocked_provider_url" | "fetch_empty";
			data: Record<string, unknown>;
		};
	},
	signal?: AbortSignal,
): Promise<ReturnType<typeof toolResultFromJson>> {
	const cached = {
		code: failure.code,
		message: failure.message,
		extra: failure.extra,
		reason: failure.reason,
		createdAt: new Date().toISOString(),
	};
	if (shouldCacheFetchFailure(failure.reason)) {
		// Durable publication is the first commit. Do not leave a memory-only
		// negative result behind if cancellation wins while it is being written.
		throwIfWorkflowWebFetchAborted(signal);
		await writeDurableFetchFailure(config, key, cached);
		throwIfWorkflowWebFetchAborted(signal);
		cache.set(key, cached);
	} else if (shouldCacheFetchFailureInMemory(failure.reason)) {
		throwIfWorkflowWebFetchAborted(signal);
		cache.set(key, cached);
	}
	if (failure.event) {
		throwIfWorkflowWebFetchAborted(signal);
		await recordWorkflowWebSourceEvent(config, failure.event.type, failure.event.data);
	}
	throwIfWorkflowWebFetchAborted(signal);
	return errorToolResult(failure.code, failure.message, failure.extra);
}

const FETCH_LOCK_STALE_MS = 4 * 60_000;
const FETCH_LOCK_WAIT_MS = 5 * 60_000;

async function withWorkflowWebFetchLock<T>(
	config: WorkflowWebSourceCacheConfig,
	key: string,
	signal: AbortSignal | undefined,
	fn: () => Promise<T>,
	onAcquired?: (release: () => Promise<void>) => void,
): Promise<T> {
	const leaseRelease = await acquireWorkflowWebFetchLock(config, key, signal);
	let releaseInFlight: Promise<void> | undefined;
	let released = false;
	const release = async (): Promise<void> => {
		if (released) return;
		if (releaseInFlight) return releaseInFlight;
		releaseInFlight = (async () => {
			try {
				await leaseRelease();
			} finally {
				released = true;
			}
		})();
		await releaseInFlight;
	};
	const onAbort = () => { void release(); };
	signal?.addEventListener("abort", onAbort, { once: true });
	onAcquired?.(release);
	if (signal?.aborted) void release();
	try {
		if (signal?.aborted) throw new WorkflowWebFetchCancelled();
		return await fn();
	} finally {
		signal?.removeEventListener("abort", onAbort);
		await release();
	}
}

async function acquireWorkflowWebFetchLock(
	config: WorkflowWebSourceCacheConfig,
	key: string,
	signal?: AbortSignal,
): Promise<() => Promise<void>> {
	const lockDir = fetchLockPath(config, key);
	await ensurePrivateDirectory(dirname(lockDir));
	const started = Date.now();
	for (;;) {
		if (signal?.aborted) throw new Error("aborted");
		try {
			const generation = createHash("sha256").update(randomLockNonce()).digest("hex");
			const ownerId = `${process.pid}:${generation}`;
			await publishPrivateGenerationDirectory(
				lockDir,
				"owner.json",
				`${JSON.stringify({ ownerId, generation, pid: process.pid, createdAt: new Date().toISOString(), key }, null, 2)}\n`,
			);
			const fence = await captureFetchLockFence(lockDir, ownerId, generation);
			if (!fence) throw new Error("fetch lock owner publication failed");
			return async () => { await releaseWorkflowWebFetchLock(lockDir, fence); };
		} catch (error) {
			if (!isFileExistsError(error)) throw error;
			await removeStaleFetchLock(lockDir);
			if (Date.now() - started > FETCH_LOCK_WAIT_MS) {
				throw new Error("fetch_lock_timeout");
			}
			await sleep(100);
		}
	}
}

type FetchLockFence = {
	directory: { dev: number; ino: number };
	owner: { dev: number; ino: number };
	ownerId: string;
	generation: string;
};

function randomLockNonce(): string {
	return `${process.pid}:${Date.now()}:${Math.random()}:${Math.random()}`;
}

async function captureFetchLockFence(
	lockDir: string,
	ownerId: string,
	generation: string,
): Promise<FetchLockFence | undefined> {
	try {
		const [directory, owner] = await Promise.all([
			lstat(lockDir),
			lstat(resolve(lockDir, "owner.json")),
		]);
		const current = await readFetchLockOwner(lockDir);
		if (!directory.isDirectory() || !owner.isFile() || current?.ownerId !== ownerId || (current.generation ?? current.ownerId) !== generation)
			return undefined;
		return {
			directory: { dev: directory.dev, ino: directory.ino },
			owner: { dev: owner.dev, ino: owner.ino },
			ownerId,
			generation,
		};
	} catch { return undefined; }
}

function sameFetchStat(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

async function releaseWorkflowWebFetchLock(
	lockDir: string,
	fence: FetchLockFence,
): Promise<void> {
	try {
		const directory = await lstat(lockDir);
		const ownerPath = resolve(lockDir, "owner.json");
		const owner = await lstat(ownerPath);
		const current = await readFetchLockOwner(lockDir);
		if (!directory.isDirectory() || !sameFetchStat(directory, fence.directory) ||
			!owner.isFile() || !sameFetchStat(owner, fence.owner) ||
			current?.ownerId !== fence.ownerId || (current.generation ?? current.ownerId) !== fence.generation) return;
		const guardPath = resolve(lockDir, `.remove-${randomLockNonce()}`);
		let guard: Awaited<ReturnType<typeof open>> | undefined;
		let guarded = false;
		try {
			guard = await open(guardPath, "wx", 0o600);
			guarded = true;
			const guardedDirectory = await lstat(lockDir);
			const guardedOwner = await lstat(ownerPath);
			const guardedValue = await readFetchLockOwner(lockDir);
			if (!sameFetchStat(guardedDirectory, fence.directory) ||
				!sameFetchStat(guardedOwner, fence.owner) ||
				guardedValue?.ownerId !== fence.ownerId || (guardedValue.generation ?? guardedValue.ownerId) !== fence.generation) return;
			// Publish release by renaming the fenced generation away from the
			// live name; a crash cannot strand an ownerless live lock directory.
			const tombstone = `${lockDir}.releasing-${randomLockNonce()}`;
			await rename(lockDir, tombstone);
			guarded = false;
			await rm(tombstone, { recursive: true, force: true });
		} finally {
			await guard?.close().catch(() => undefined);
			if (guarded) await unlink(guardPath).catch(() => undefined);
		}
	} catch { /* competing owner/reaper won; never delete recursively */ }
}

async function removeStaleFetchLock(lockDir: string): Promise<void> {
	try {
		const current = await lstat(lockDir);
		if (!current.isDirectory() || Date.now() - current.mtimeMs <= FETCH_LOCK_STALE_MS) return;
		const owner = await readFetchLockOwner(lockDir);
		if (owner?.pid !== undefined) {
			try { process.kill(owner.pid, 0); return; }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") return;
			}
		}
		const generation = owner?.generation ?? owner?.ownerId;
		if (!owner?.ownerId || !generation) return;
		const fence = await captureFetchLockFence(lockDir, owner.ownerId, generation);
		if (!fence) return;
		await releaseWorkflowWebFetchLock(lockDir, fence);
	} catch { /* Missing or replaced lock. */ }
}

async function readFetchLockOwner(
	lockDir: string,
 ): Promise<{ ownerId?: string; generation?: string; pid?: number } | undefined> {
	try {
		const ownerPath = resolve(lockDir, "owner.json");
		const ownerStat = await lstat(ownerPath);
		if (!ownerStat.isFile()) return undefined;
		const owner = await open(
			ownerPath,
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
		);
		let text: string;
		try {
			text = await owner.readFile("utf8");
		} finally {
			await owner.close().catch(() => undefined);
		}
		const parsed = JSON.parse(text) as unknown;
		return isRecord(parsed) && typeof parsed.ownerId === "string"
			? { ownerId: parsed.ownerId, ...(typeof parsed.generation === "string" ? { generation: parsed.generation } : {}), ...(typeof parsed.pid === "number" ? { pid: parsed.pid } : {}) }
			: undefined;
	} catch {
		return undefined;
	}
}

async function readDurableFetchFailure(
	config: WorkflowWebSourceCacheConfig,
	key: string,
): Promise<FetchFailure | undefined> {
	try {
		const parsed = JSON.parse(
			await readFile(fetchFailurePath(config, key), "utf8"),
		) as unknown;
		return normalizeFetchFailure(parsed);
	} catch {
		return undefined;
	}
}

async function writeDurableFetchFailure(
	config: WorkflowWebSourceCacheConfig,
	key: string,
	failure: FetchFailure,
): Promise<void> {
	await writePrivateFileAtomic(
		fetchFailurePath(config, key),
		`${JSON.stringify({ schema: "workflow-web-source-fetch-failure-v1", ...failure }, null, 2)}\n`,
	);
}

function normalizeFetchFailure(value: unknown): FetchFailure | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.code !== "string" || typeof value.message !== "string")
		return undefined;
	const extra = isRecord(value.extra) ? value.extra : {};
	return {
		code: value.code,
		message: value.message,
		extra,
		...(typeof value.reason === "string" ? { reason: value.reason } : {}),
		...(typeof value.createdAt === "string"
			? { createdAt: value.createdAt }
			: {}),
	};
}

function fetchLockPath(
	config: WorkflowWebSourceCacheConfig,
	key: string,
): string {
	return resolve(config.cacheDir, "fetch-locks", fetchCacheFileKey(key));
}

function fetchFailurePath(
	config: WorkflowWebSourceCacheConfig,
	key: string,
): string {
	return resolve(
		config.cacheDir,
		"fetch-negative-cache",
		`${fetchCacheFileKey(key)}.json`,
	);
}

function fetchCacheFileKey(key: string): string {
	return /^urlkey_[a-f0-9]{32}$/.test(key) ? key : "urlkey_invalid";
}

function isFileExistsError(error: unknown): boolean {
	return isRecord(error) && (error.code === "EEXIST" || error.code === "ENOTEMPTY");
}

function shouldCacheFetchFailure(reason: string): boolean {
	return (
		reason === "invalid_url" ||
		reason === "unsafe_scheme" ||
		reason === "private_host_blocked" ||
		reason === "non_public_ip_blocked" ||
		reason === "http_404" ||
		reason === "http_410" ||
		reason === "unsupported_content_type"
	);
}

function shouldCacheFetchFailureInMemory(reason: string): boolean {
	return (
		reason === "empty_source" ||
		reason === "dns_resolution_failed" ||
		reason.includes("ENOTFOUND")
	);
}

const WORKFLOW_WEB_VISIBLE_BUDGET_LEDGER_SCHEMA =
	"workflow-web-visible-budget-ledger-v1" as const;
const VISIBLE_BUDGET_LOCK_WAIT_MS = 5 * 60_000;

class WorkflowWebBudgetCancelled extends Error {
	constructor() {
		super("workflow web budget operation cancelled");
		this.name = "WorkflowWebBudgetCancelled";
	}
}

type WorkflowWebVisibleBudgetLedger = {
	schema: typeof WORKFLOW_WEB_VISIBLE_BUDGET_LEDGER_SCHEMA;
	runId: string;
	taskId: string;
	limit: number;
	used: number;
	updatedAt: string;
};

async function withDurableWorkflowWebBudget<T>(
	config: WorkflowWebSourceCacheConfig,
	budget: import("./workflow-web-source.js").WorkflowWebVisibleBudget,
	signal: AbortSignal | undefined,
	fn: () => Promise<T>,
	onMismatch: () => T,
	onCancelled: () => T = onMismatch,
	onError: (error: unknown) => T = (error) => { throw error; },
): Promise<T> {
	let release: (() => Promise<void>) | undefined;
	let baselineUsed = 0;
	try {
		// Acquisition/network work must never be performed while this lock is
		// held. The lock is only used to read the starting ledger and later to
		// rebase the short render/consume transaction.
		release = await acquireVisibleBudgetLock(config, signal);
		if (signal?.aborted) throw new WorkflowWebBudgetCancelled();
		const ledger = await readVisibleBudgetLedger(config);
		if (ledger === "invalid" || (ledger && ledger !== "error" && ledger.limit !== budget.limit))
			return onMismatch();
		if (ledger === "error") return onError(undefined);
		budget.used = baselineUsed = ledger?.used ?? 0;
		await release();
		release = undefined;

		const result = await fn();
		// Provider-reported cancellation is an explicit no-commit decision; it
		// is different from a successful render that happened to race an abort.
		if (isNoBudgetCommitResult(result)) return result;
		if (signal?.aborted) throw new WorkflowWebBudgetCancelled();

		release = await acquireVisibleBudgetLock(config, signal);
		const current = await readVisibleBudgetLedger(config);
		if (current === "invalid" || (current && current !== "error" && current.limit !== budget.limit))
			return onMismatch();
		if (current === "error") return onError(undefined);
		const delta = Math.max(0, budget.used - baselineUsed);
		const currentUsed = current?.used ?? 0;
		// Do not return a render produced from a stale budget snapshot if another
		// worker consumed the remaining visible allowance first. Returning the
		// mismatch discards that render instead of exposing over-budget text.
		if (currentUsed + delta > budget.limit) return onMismatch();
		budget.used = currentUsed + delta;
		if (signal?.aborted) throw new WorkflowWebBudgetCancelled();
		// writeVisibleBudgetLedger checks the signal immediately before the
		// atomic commit. Once it starts, the commit wins deterministically.
		await writeVisibleBudgetLedger(config, budget, signal);
		return result;
	} catch (error) {
		if (error instanceof WorkflowWebBudgetCancelled || signal?.aborted)
			return onCancelled();
		return onError(error);
	} finally {
		await release?.();
	}
}

function isNoBudgetCommitResult(value: unknown): boolean {
	if (isRecord(value) && isRecord(value.details) && value.details.cancelled === true) return true;
	if (!isRecord(value) || !Array.isArray(value.content)) return false;
	const first = value.content[0];
	if (!isRecord(first) || typeof first.text !== "string") return false;
	try {
		const payload = JSON.parse(first.text) as unknown;
		return isRecord(payload) && payload.status === "cancelled";
	} catch {
		return false;
	}
}

async function readVisibleBudgetLedger(
	config: WorkflowWebSourceCacheConfig,
): Promise<WorkflowWebVisibleBudgetLedger | undefined | "invalid" | "error"> {
	try {
		const path = visibleBudgetLedgerPath(config);
		const file = await open(
			path,
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
		);
		let text: string;
		try {
			text = await file.readFile("utf8");
		} finally {
			await file.close().catch(() => undefined);
		}
		const value = JSON.parse(text) as unknown;
		const limit = isRecord(value) ? value.limit : undefined;
		const used = isRecord(value) ? value.used : undefined;
		if (
			!isRecord(value) ||
			value.schema !== WORKFLOW_WEB_VISIBLE_BUDGET_LEDGER_SCHEMA ||
			value.runId !== config.runId ||
			value.taskId !== config.taskId ||
			typeof limit !== "number" ||
			typeof used !== "number" ||
			!Number.isSafeInteger(limit) ||
			!Number.isSafeInteger(used) ||
			limit < 0 ||
			used < 0 ||
			used > limit
		) {
			return "invalid";
		}
		return {
			schema: WORKFLOW_WEB_VISIBLE_BUDGET_LEDGER_SCHEMA,
			runId: config.runId,
			taskId: config.taskId,
			limit,
			used,
			updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
		};
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return undefined;
		return "error";
	}
}

async function writeVisibleBudgetLedger(
	config: WorkflowWebSourceCacheConfig,
	budget: import("./workflow-web-source.js").WorkflowWebVisibleBudget,
	signal?: AbortSignal,
): Promise<void> {
	if (signal?.aborted) throw new WorkflowWebBudgetCancelled();
	const ledger: WorkflowWebVisibleBudgetLedger = {
		schema: WORKFLOW_WEB_VISIBLE_BUDGET_LEDGER_SCHEMA,
		runId: config.runId,
		taskId: config.taskId,
		limit: budget.limit,
		used: Math.max(0, Math.min(budget.limit, budget.used)),
		updatedAt: new Date().toISOString(),
	};
	// writePrivateFileAtomic checks signal immediately before rename. Rename is
	// the documented visible-budget commit point: cancellation before it wins;
	// cancellation after it observes the committed ledger and success semantics.
	await writePrivateFileAtomic(
		visibleBudgetLedgerPath(config),
		`${JSON.stringify(ledger, null, 2)}\n`,
		{ signal },
	);
}

function visibleBudgetLedgerPath(config: WorkflowWebSourceCacheConfig): string {
	const key = createHash("sha256")
		.update(`${config.runId}\0${config.taskId}`)
		.digest("hex");
	return resolve(
		config.cacheDir,
		"visible-budget-ledger",
		`${key}.json`,
	);
}

async function acquireVisibleBudgetLock(
	config: WorkflowWebSourceCacheConfig,
	signal?: AbortSignal,
): Promise<() => Promise<void>> {
	const lockDir = visibleBudgetLockPath(config);
	await ensurePrivateDirectory(dirname(lockDir));
	const started = Date.now();
	for (;;) {
		if (signal?.aborted) throw new Error("aborted");
		try {
			const generation = createHash("sha256").update(randomLockNonce()).digest("hex");
			const ownerId = `${process.pid}:${generation}`;
			await publishPrivateGenerationDirectory(
				lockDir,
				"owner.json",
				JSON.stringify({ ownerId, generation, pid: process.pid }),
			);
			const fence = await captureFetchLockFence(lockDir, ownerId, generation);
			if (!fence) throw new Error("visible budget lock owner publication failed");
			return async () => { await releaseWorkflowWebFetchLock(lockDir, fence); };
		} catch (error) {
			if (!isFileExistsError(error)) throw error;
			await removeStaleFetchLock(lockDir);
			if (Date.now() - started > VISIBLE_BUDGET_LOCK_WAIT_MS)
				throw new Error("visible_budget_lock_timeout");
			await sleepWithAbort(25, signal);
		}
	}
}

function visibleBudgetLockPath(config: WorkflowWebSourceCacheConfig): string {
	const key = createHash("sha256")
		.update(`${config.runId}\0${config.taskId}`)
		.digest("hex");
	return resolve(config.cacheDir, "visible-budget-locks", key);
}

function workflowWebBudgetMismatch(): ReturnType<typeof toolResultFromJson> {
	return errorToolResult(
		"visible_budget_limit_mismatch",
		"The durable workflow web visible-budget ledger does not match this task's configured limit; refusing to expose more content.",
		{ reason: "visible_budget_ledger_mismatch" },
	);
}

type WorkflowWebSearchBudget = {
	limit: number;
	used: number;
	remaining: number;
	truncated: boolean;
};

function normalizeWorkflowWebSearchResult(
	result: ToolResult,
	providerKind: WorkflowWebProviderLaunchConfig["kind"],
	policy: WorkflowWebSourcePolicy,
	signalAborted = false,
	capturedProviderNames: readonly string[] = [],
): Omit<WorkflowWebSearchPayload, "tool" | "budget" | "next"> {
	const details = isRecord(result.details) ? result.details : {};
	const candidateEnvelope = extractSearchCandidateEnvelope(result, policy);
	const queryCount = nonNegativeInteger(details.queryCount);
	const successfulQueryCount = nonNegativeInteger(details.successfulQueries);
	const sourceCountReported = nonNegativeInteger(details.totalResults);
	const returnedCancellation = isWorkflowReturnedCancellation(result);
	const returnedError =
		typeof details.error === "string" && details.error.trim().length > 0;
	let status: WorkflowWebSearchStatus;
	let code: "search_failed" | "search_cancelled" | "no_results" | undefined;
	if (signalAborted || returnedCancellation) {
		status = "cancelled";
		code = "search_cancelled";
	} else if (returnedError) {
		status = "failed";
		code = "search_failed";
	} else if (successfulQueryCount === 0) {
		status = "failed";
		code = "search_failed";
	} else if (
		successfulQueryCount !== undefined &&
		queryCount !== undefined &&
		successfulQueryCount > 0 &&
		successfulQueryCount < queryCount
	) {
		status = "partial";
	} else if (candidateEnvelope.candidateCountReturned === 0) {
		if ((sourceCountReported ?? 0) > 0) {
			status = "failed";
			code = "search_failed";
		} else {
			status = "empty";
			code = "no_results";
		}
	} else {
		status = "ok";
	}
	if (status === "cancelled") {
		return {
			status,
			code: "search_cancelled",
			candidates: [],
			candidateCountTotal: 0,
			candidateCountReturned: 0,
			candidateTruncated: false,
			...(queryCount !== undefined ? { queryCount } : {}),
			successfulQueryCount: 0,
			sourceCountReported: 0,
			upstreamTruncated: false,
			truncated: false,
			provenance: workflowWebSearchProvenance(
				details,
				providerKind,
				capturedProviderNames,
			),
		};
	}
	const upstreamTruncated =
		sourceCountReported !== undefined &&
		sourceCountReported > candidateEnvelope.candidateCountReturned;
	return {
		status,
		...(code ? { code } : {}),
		...candidateEnvelope,
		...(queryCount !== undefined ? { queryCount } : {}),
		...(successfulQueryCount !== undefined ? { successfulQueryCount } : {}),
		...(sourceCountReported !== undefined ? { sourceCountReported } : {}),
		upstreamTruncated,
		truncated: candidateEnvelope.candidateTruncated || upstreamTruncated,
		provenance: workflowWebSearchProvenance(
			details,
			providerKind,
			capturedProviderNames,
		),
	};
}

function workflowWebSearchFailure(
	status: "failed" | "cancelled",
	code: "search_failed" | "search_cancelled",
	providerKind: WorkflowWebProviderLaunchConfig["kind"],
	budget: WorkflowWebSearchBudget,
): ReturnType<typeof toolResultFromJson> {
	return toolResultFromJson({
		status,
		code,
		tool: "workflow_web_search",
		candidates: [],
		candidateCountTotal: 0,
		candidateCountReturned: 0,
		candidateTruncated: false,
		upstreamTruncated: false,
		truncated: false,
		provenance: emptyWorkflowWebSearchProvenance(providerKind),
		budget,
		next: status === "cancelled"
			? "Search was cancelled; do not fetch candidates or infer sources from this response."
			: "Retry the search or report that web search was unavailable; do not infer sources from the failure.",
	});
}

function workflowWebSearchCancelled(
	providerKind: WorkflowWebProviderLaunchConfig["kind"],
	limit: number,
): ReturnType<typeof toolResultFromJson> {
	return workflowWebSearchFailure("cancelled", "search_cancelled", providerKind, {
		limit,
		used: 0,
		remaining: limit,
		truncated: false,
	});
}

function workflowWebSearchProvenance(
	details: Record<string, unknown>,
	providerKind: WorkflowWebProviderLaunchConfig["kind"],
	capturedProviderNames: readonly string[] = [],
): WorkflowWebSearchProvenance {
	const actualProviders: string[] = [];
	for (const provider of capturedProviderNames) {
		collectProviderName(actualProviders, provider);
	}
	collectProviderName(actualProviders, details.actualProvider);
	if (Array.isArray(details.actualProviders)) {
		for (const provider of details.actualProviders)
			collectProviderName(actualProviders, provider);
	}
	const selectedProviders: string[] = [];
	collectSelectedProviderName(selectedProviders, details.provider);
	if (Array.isArray(details.providers)) {
		for (const provider of details.providers)
			collectSelectedProviderName(selectedProviders, provider);
	}
	const uniqueProviders = [...new Set(actualProviders)];
	const uniqueSelectedProviders = [...new Set(selectedProviders)].slice(
		0,
		WORKFLOW_WEB_SEARCH_PROVIDER_LIMIT,
	);
	const providers = uniqueProviders.slice(0, WORKFLOW_WEB_SEARCH_PROVIDER_LIMIT);
	const searchId = boundedSearchIdentifier(details.searchId);
	return {
		adapter: searchAdapter(providerKind),
		attributionAvailable: uniqueProviders.length > 0,
		...(searchId ? { searchId } : {}),
		providers,
		...(uniqueSelectedProviders.length
			? { selectedProviders: uniqueSelectedProviders }
			: {}),
		providerCountTotal: uniqueProviders.length,
		providerCountReturned: providers.length,
		truncated: uniqueProviders.length > providers.length,
	};
}

function emptyWorkflowWebSearchProvenance(
	providerKind: WorkflowWebProviderLaunchConfig["kind"],
): WorkflowWebSearchProvenance {
	return {
		adapter: searchAdapter(providerKind),
		attributionAvailable: false,
		providers: [],
		providerCountTotal: 0,
		providerCountReturned: 0,
		truncated: false,
	};
}

function searchAdapter(
	providerKind: WorkflowWebProviderLaunchConfig["kind"],
): WorkflowWebSearchProvenance["adapter"] {
	return providerKind === "pi-web-access"
		? "pi-web-access-formatted-text"
		: "extension-formatted-text";
}

function collectProviderName(target: string[], value: unknown): void {
	const provider = validatedProviderName(value);
	if (provider) target.push(provider);
}

function collectSelectedProviderName(target: string[], value: unknown): void {
	const provider = validatedSelectedProviderName(value);
	if (provider) target.push(provider);
}

function validatedProviderName(value: unknown): string | undefined {
	return typeof value === "string" &&
		value.length >= 1 &&
		value.length <= 64 &&
		/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(value) &&
		!RESERVED_PROVIDER_SELECTORS.has(value.toLowerCase())
		? value
		: undefined;
}

function validatedSelectedProviderName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	if (RESERVED_PROVIDER_SELECTORS.has(value.toLowerCase())) return value;
	return validatedProviderName(value);
}

function boundedSearchIdentifier(value: unknown): string | undefined {
	return typeof value === "string" &&
		value.length >= 1 &&
		value.length <= 128 &&
		/^[A-Za-z0-9_-]+$/.test(value)
		? value
		: undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
	return typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= 0
		? value
		: undefined;
}

function isAbortError(error: unknown): boolean {
	return isWorkflowAbortError(error);
}

function providerResultWasCancelled(result: unknown): boolean {
	return isWorkflowReturnedCancellation(result);
}

function workflowWebFetchCancelled(limit: number): ReturnType<typeof toolResultFromJson> {
	return toolResultFromJson({
		status: "cancelled",
		code: "fetch_cancelled",
		tool: "workflow_web_fetch_source",
		budget: { limit, used: 0, remaining: limit, truncated: false },
		next: "Fetch was cancelled; do not infer or cite a source from this response.",
	});
}

function isWorkflowWebFetchCancelledResult(value: unknown): boolean {
	if (!isRecord(value) || !Array.isArray(value.content)) return false;
	const text = value.content.find(
		(item) => isRecord(item) && typeof item.text === "string",
	);
	if (!isRecord(text) || typeof text.text !== "string") return false;
	try {
		const payload = JSON.parse(text.text) as unknown;
		return isRecord(payload) &&
			payload.status === "cancelled" &&
			payload.code === "fetch_cancelled";
	} catch {
		return false;
	}
}

async function awaitSharedWorkflowWebFetch(
	flight: WorkflowWebFetchFlight,
	signal: AbortSignal | undefined,
	limit: number,
): Promise<ToolResult> {
	flight.waiters += 1;
	try {
		return await awaitWorkflowWebFetch(flight.promise, signal);
	} catch (error) {
		if (error instanceof WorkflowWebFetchCancelled || signal?.aborted)
			return workflowWebFetchCancelled(limit);
		throw error;
	} finally {
		flight.waiters = Math.max(0, flight.waiters - 1);
		if (flight.waiters === 0 && !flight.settled) {
			// Do not leave an aborted flight in the map: a late caller must be able
			// to install the next generation without observing this one.
			await flight.lastWaiter?.();
		}
	}
}

async function awaitWorkflowWebFetch<T>(
	promise: Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) throw new WorkflowWebFetchCancelled();
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			signal.removeEventListener("abort", onAbort);
			reject(new WorkflowWebFetchCancelled());
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

const WORKFLOW_WEB_FETCH_TIMEOUT_MS = 30_000;
const WORKFLOW_WEB_FETCH_MAX_CHARS = 1_000_000;

type WorkflowWebFetchRuntimeDependencies = {
	now(): number;
	httpRequest: typeof httpRequest;
	httpsRequest: typeof httpsRequest;
	setDeadlineTimer(
		callback: () => void,
		delayMs: number,
	): ReturnType<typeof setTimeout>;
	clearDeadlineTimer(timer: ReturnType<typeof setTimeout>): void;
};

const DEFAULT_WORKFLOW_WEB_FETCH_RUNTIME: WorkflowWebFetchRuntimeDependencies = {
	now: Date.now,
	httpRequest,
	httpsRequest,
	setDeadlineTimer: (callback, delayMs) => setTimeout(callback, delayMs),
	clearDeadlineTimer: (timer) => clearTimeout(timer),
};

export async function safeFetchWorkflowWebText(
	url: string,
	security: WorkflowWebSecurityPolicy,
	signal?: AbortSignal,
	deadlineMs = WORKFLOW_WEB_FETCH_TIMEOUT_MS,
	runtime: WorkflowWebFetchRuntimeDependencies =
		DEFAULT_WORKFLOW_WEB_FETCH_RUNTIME,
): Promise<
	| {
			ok: true;
			url: string;
			text: string;
			title?: string;
			aliases?: string[];
			extractionLossy?: boolean;
	  }
	| { ok: false; reason: string; url: string }
> {
	const deadlineAt = runtime.now() + Math.max(1, Math.floor(deadlineMs));
	let current = url;
	const hops: string[] = [];
	for (let redirectCount = 0; redirectCount < 6; redirectCount += 1) {
		if (signal?.aborted) return { ok: false, reason: "aborted", url: current };
		if (runtime.now() >= deadlineAt) {
			return { ok: false, reason: "fetch_deadline_exceeded", url: current };
		}
		const checked = validateWorkflowWebUrl(current, security);
		if (!checked.ok) return { ok: false, reason: checked.reason, url: current };
		hops.push(checked.normalizedUrl);
		const response = await safeFetchOnce(
			checked.normalizedUrl,
			security,
			signal,
			deadlineAt,
			runtime,
		);
		if (!response.ok) return response;
		if (signal?.aborted) return { ok: false, reason: "aborted", url: current };
		if (response.status >= 300 && response.status < 400) {
			if (!response.location)
				return {
					ok: false,
					reason: "redirect_without_location",
					url: checked.normalizedUrl,
				};
			try {
				current = new URL(response.location, checked.normalizedUrl).href;
			} catch {
				return {
					ok: false,
					reason: "invalid_redirect_url",
					url: checked.normalizedUrl,
				};
			}
			continue;
		}
		if (response.status < 200 || response.status >= 300) {
			return {
				ok: false,
				reason: `http_${response.status}`,
				url: checked.normalizedUrl,
			};
		}
		const extracted = extractWorkflowWebResponseText(
			response.text,
			response.contentType,
		);
		return {
			ok: true,
			url: checked.normalizedUrl,
			text: extracted.text,
			title: extracted.title,
			...(hops.length > 1 ? { aliases: hops.slice(0, -1) } : {}),
			extractionLossy: extracted.lossy || response.truncated,
		};
	}
	return { ok: false, reason: "too_many_redirects", url: current };
}

function safeFetchOnce(
	url: string,
	security: WorkflowWebSecurityPolicy,
	signal: AbortSignal | undefined,
	deadlineAt: number,
	runtime: WorkflowWebFetchRuntimeDependencies =
		DEFAULT_WORKFLOW_WEB_FETCH_RUNTIME,
): Promise<
	| {
			ok: true;
			status: number;
			location?: string;
			text: string;
			contentType?: string;
			truncated?: boolean;
	  }
	| { ok: false; reason: string; url: string }
> {
	const remainingMs = deadlineAt - runtime.now();
	if (remainingMs <= 0) {
		return Promise.resolve({
			ok: false,
			reason: "fetch_deadline_exceeded",
			url,
		});
	}
	const parsed = new URL(url);
	const request =
		parsed.protocol === "https:" ? runtime.httpsRequest : runtime.httpRequest;
	return new Promise((resolveResult) => {
		let settled = false;
		let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
		let abortListener: (() => void) | undefined;
		const settle = (
			result:
				| {
						ok: true;
						status: number;
						location?: string;
						text: string;
						contentType?: string;
						truncated?: boolean;
				  }
				| { ok: false; reason: string; url: string },
		) => {
			if (settled) return;
			settled = true;
			if (deadlineTimer !== undefined) {
				runtime.clearDeadlineTimer(deadlineTimer);
			}
			if (signal && abortListener) {
				signal.removeEventListener("abort", abortListener);
			}
			resolveResult(result);
		};
		const req = request(
			parsed,
			{
				method: "GET",
				headers: {
					accept:
						"text/plain,text/html,application/json,application/xml;q=0.9,*/*;q=0.1",
					"user-agent": "pi-workflow-web-source/1",
				},
				lookup(hostname, options, callback) {
					lookupPublicAddress(hostname, security)
						.then((address) => {
							if (isLookupAllOptions(options)) {
								callback(null, [
									{ address: address.address, family: address.family },
								]);
								return;
							}
							callback(null, address.address, address.family);
						})
						.catch((error: unknown) => {
							const reason =
								error instanceof Error
									? error.message
									: "dns_resolution_failed";
							callback(new Error(reason), "", 4);
						});
				},
			},
			(res) => {
				res.setEncoding("utf8");
				let text = "";
				let truncated = false;
				const contentType = Array.isArray(res.headers["content-type"])
					? res.headers["content-type"][0]
					: res.headers["content-type"];
				const status = res.statusCode ?? 0;
				if (
					status >= 200 &&
					status < 300 &&
					contentType &&
					!isWorkflowWebTextContentType(contentType)
				) {
					settle({ ok: false, reason: "unsupported_content_type", url });
					req.destroy();
					return;
				}
				res.on("data", (chunk: string) => {
					if (settled) return;
					if (text.length + chunk.length > WORKFLOW_WEB_FETCH_MAX_CHARS) {
						text += chunk.slice(
							0,
							Math.max(0, WORKFLOW_WEB_FETCH_MAX_CHARS - text.length),
						);
						truncated = true;
						req.destroy(new Error("workflow_fetch_truncated"));
						return;
					}
					text += chunk;
				});
				res.on("end", () => {
					const location = Array.isArray(res.headers.location)
						? res.headers.location[0]
						: res.headers.location;
					settle({
						ok: true,
						status,
						...(location ? { location } : {}),
						...(contentType ? { contentType } : {}),
						...(truncated ? { truncated } : {}),
						text,
					});
				});
				res.on("error", (error: Error) => {
					if (!truncated) settle({ ok: false, reason: error.message || "response_aborted", url });
				});
				res.on("aborted", () => {
					if (!truncated) settle({ ok: false, reason: "response_aborted", url });
				});
				res.on("close", () => {
					if (!truncated) {
						settle({ ok: false, reason: "response_aborted", url });
						return;
					}
					settle({
						ok: true,
						status,
						...(contentType ? { contentType } : {}),
						truncated,
						text,
					});
				});
			},
		);
		req.setTimeout(WORKFLOW_WEB_FETCH_TIMEOUT_MS, () => {
			req.destroy(new Error("fetch_timeout"));
		});
		deadlineTimer = runtime.setDeadlineTimer(() => {
			// A previously closed socket may not emit another error on destroy.
			settle({ ok: false, reason: "fetch_deadline_exceeded", url });
			req.destroy(new Error("fetch_deadline_exceeded"));
		}, remainingMs);
		req.on("error", (error: Error) => {
			if (error.message === "workflow_fetch_truncated") return;
			settle({ ok: false, reason: error.message || "url_fetch_failed", url });
		});
		if (signal) {
			abortListener = () => {
				settle({ ok: false, reason: "aborted", url });
				req.destroy(new Error("aborted"));
			};
			if (signal.aborted) abortListener();
			else signal.addEventListener("abort", abortListener, { once: true });
		}
		req.end();
	});
}

async function lookupPublicAddress(
	hostname: string,
	security: WorkflowWebSecurityPolicy,
): Promise<{ address: string; family: number }> {
	const addresses = await lookup(hostname, { all: true, verbatim: true });
	for (const address of addresses) {
		const reason = security.allowPrivateHosts
			? undefined
			: nonPublicIpReason(address.address);
		if (!reason) return address;
	}
	throw new Error(
		addresses.length > 0 ? "private_host_blocked" : "dns_resolution_failed",
	);
}

async function isDirectSafeCachedSource(
	config: WorkflowWebSourceLaunchConfig,
	source: WorkflowWebSource,
): Promise<boolean> {
	if (source.runId !== config.runId || source.taskId !== config.taskId) return false;
	if (source.provenance?.fetcher !== WORKFLOW_WEB_DIRECT_FETCHER ||
		source.provenance.policy !== WORKFLOW_WEB_DIRECT_FETCH_POLICY) return false;
	if (source.urlKey !== sourceUrlCacheKey(source.url)) return false;
	const strict: WorkflowWebSecurityPolicy = { allowPrivateHosts: false, cacheRawProviderPayloads: false };
	for (const candidate of [source.url, source.effectiveUrl, ...(source.aliases ?? [])]) {
		if (!candidate) continue;
		const checked = validateWorkflowWebUrl(candidate, strict);
		if (!checked.ok || !(await validateResolvedHost(checked.normalizedUrl, strict)).ok) return false;
	}
	return true;
}

async function validateResolvedHost(
	url: string,
	security: WorkflowWebSecurityPolicy,
	signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; reason: string; url: string }> {
	throwIfWorkflowWebFetchAborted(signal);
	if (security.allowPrivateHosts) return { ok: true };
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { ok: false, reason: "invalid_url", url };
	}
	try {
		const addresses = await lookupWorkflowHostAddresses(parsed.hostname, signal);
		throwIfWorkflowWebFetchAborted(signal);
		for (const address of addresses) {
			throwIfWorkflowWebFetchAborted(signal);
			const reason = nonPublicIpReason(address.address);
			if (reason) return { ok: false, reason, url };
		}
		return { ok: true };
	} catch (error) {
		if (error instanceof WorkflowWebFetchCancelled) throw error;
		return { ok: false, reason: "dns_resolution_failed", url };
	}
}

async function lookupWorkflowHostAddresses(
	hostname: string,
	signal?: AbortSignal,
): Promise<Array<{ address: string; family: number }>> {
	const pending = lookup(hostname, { all: true, verbatim: true }) as Promise<Array<{ address: string; family: number }>>;
	if (!signal) return pending;
	throwIfWorkflowWebFetchAborted(signal);
	let removeAbortListener: () => void = () => {};
	const aborted = new Promise<never>((_, reject) => {
		const onAbort = () => reject(new WorkflowWebFetchCancelled());
		removeAbortListener = () => signal.removeEventListener("abort", onAbort);
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([pending, aborted]);
	} finally {
		removeAbortListener();
	}
}

function isLookupAllOptions(options: unknown): boolean {
	return isRecord(options) && options.all === true;
}

async function validateProviderResultUrls(
	result: unknown,
	security: WorkflowWebSecurityPolicy,
	signal?: AbortSignal,
): Promise<
	| { ok: true; effectiveUrls?: string[] }
	| { ok: false; reason: string; url: string }
> {
	const effectiveUrls: string[] = [];
	for (const entry of providerResultUrlEntries(result)) {
		throwIfWorkflowWebFetchAborted(signal);
		const checked = validateWorkflowWebUrl(entry.url, security);
		if (!checked.ok) return { ok: false, reason: checked.reason, url: entry.url };
		const resolved = await validateResolvedHost(
			checked.normalizedUrl,
			security,
			signal,
		);
		if (!resolved.ok) return resolved;
		if (entry.effective) effectiveUrls.push(checked.normalizedUrl);
	}
	if (!security.allowPrivateHosts) {
		for (const address of providerResolvedIps(result)) {
			throwIfWorkflowWebFetchAborted(signal);
			const reason = nonPublicIpReason(address);
			if (reason) return { ok: false, reason, url: address };
		}
	}
	return {
		ok: true,
		...(effectiveUrls.length ? { effectiveUrls: [...new Set(effectiveUrls)] } : {}),
	};
}

type ProviderResultUrlEntry = { url: string; effective: boolean };

function providerResultUrlEntries(result: unknown): ProviderResultUrlEntry[] {
	if (!isRecord(result)) return [];
	const details = result.details;
	if (!isRecord(details)) return [];
	const entries: ProviderResultUrlEntry[] = [];
	for (const key of ["finalUrl", "resolvedUrl", "effectiveUrl", "url"]) {
		const value = details[key];
		if (typeof value === "string")
			entries.push({ url: value, effective: key !== "url" });
	}
	const detailsUrls = details.urls;
	if (Array.isArray(detailsUrls)) {
		for (const item of detailsUrls) {
			if (typeof item === "string") entries.push({ url: item, effective: false });
			if (isRecord(item)) {
				for (const key of ["finalUrl", "resolvedUrl", "effectiveUrl", "url"]) {
					const value = item[key];
					if (typeof value === "string")
						entries.push({ url: value, effective: key !== "url" });
				}
			}
		}
	}
	const seen = new Set<string>();
	return entries.filter((entry) => {
		const key = `${entry.effective ? "e" : "u"}:${entry.url}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function providerResolvedIps(result: unknown): string[] {
	if (!isRecord(result)) return [];
	const details = result.details;
	if (!isRecord(details)) return [];
	const values: string[] = [];
	for (const key of ["resolvedIp", "ip", "address"]) {
		const value = details[key];
		if (typeof value === "string") values.push(value);
	}
	const resolvedIps = details.resolvedIps;
	if (Array.isArray(resolvedIps)) {
		for (const value of resolvedIps) {
			if (typeof value === "string") values.push(value);
		}
	}
	return [...new Set(values)];
}

function assertRequiredProviderTools(
	providerTools: CapturedProviderTools,
	requiredProviderTools: string[],
): void {
	const required = [...new Set(requiredProviderTools)].sort();
	const missing = required.filter(
		(name) => !providerTools.get(name)?.execute,
	);
	if (missing.length === 0) return;
	throw new Error(
		`workflow web provider canonical tool validation failed; missing required tool(s): ${missing.join(", ")}`,
	);
}

async function executeProviderSearchWithAttribution(
	providerTool: ToolSpec,
	captureStorage: AsyncLocalStorage<ProviderSearchCapture>,
	toolCallId: string,
	params: unknown,
	signal?: AbortSignal,
	onUpdate?: unknown,
	ctx?: unknown,
	budget?: WorkflowWebVisibleBudget,
): Promise<{ result: ToolResult; providers: readonly string[] }> {
	if (!providerTool.execute) throw new Error("web_search is not executable");
	const updateGate = createSafeProviderOnUpdate(onUpdate, budget ? {
		maxVisibleChars: Math.max(0, budget.limit - budget.used),
		onVisibleChars: (count) => { budget.used += count; },
	} : undefined);
	const capture: ProviderSearchCapture = {
		active: true,
		providers: new Set(),
	};
	try {
		const result = await captureStorage.run(capture, () =>
			providerTool.execute!(toolCallId, params, signal, updateGate.callback, ctx),
		);
		return { result, providers: [...capture.providers] };
	} finally {
		updateGate.close();
		capture.active = false;
		capture.providers.clear();
	}
}

function captureOrdinarySearchProviders(
	capture: ProviderSearchCapture | undefined,
	type: string,
	data: unknown,
): void {
	if (
		!capture?.active ||
		type !== "web-search-results" ||
		!isRecord(data) ||
		data.type !== "search" ||
		!Array.isArray(data.queries)
	) {
		return;
	}
	for (
		let index = 0;
		index < data.queries.length && index < CAPTURED_SEARCH_RECORD_LIMIT;
		index += 1
	) {
		if (capture.providers.size >= CAPTURED_SEARCH_PROVIDER_LIMIT) return;
		const query = data.queries[index];
		if (!isRecord(query)) continue;
		const provider = validatedPiWebAccessProviderId(query.provider);
		if (provider) capture.providers.add(provider);
	}
}

const RESERVED_PROVIDER_SELECTORS = new Set(["auto", "all"]);

function validatedPiWebAccessProviderId(value: unknown): string | undefined {
	return typeof value === "string" &&
		PI_WEB_ACCESS_SEARCH_PROVIDER_IDS.has(value) &&
		!RESERVED_PROVIDER_SELECTORS.has(value)
		? value
		: undefined;
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

function providerCapturePi(
	pi: PiLike,
	providerTools: CapturedProviderTools,
	providerSearchCapture: AsyncLocalStorage<ProviderSearchCapture>,
	currentProviderPath?: string,
	providerToolOwnerPaths?: Record<string, string[]>,
	authorizedProviderTools: ReadonlySet<string> = new Set(),
): PiLike {
	return new Proxy(pi, {
		get(target, property, receiver) {
			if (property === "registerTool") {
				return (tool: ToolSpec) => {
					if (!tool.name || !authorizedProviderTools.has(tool.name)) return;
					if (providerToolOwnerPaths) {
						const owners = providerToolOwnerPaths[tool.name];
						if (owners && (!currentProviderPath || !owners.includes(currentProviderPath))) return;
						// A selected passthrough without an explicit owner is never
						// allowed to enter the wrapper namespace.
						if (!owners && !PROVIDER_TOOL_NAMES.has(tool.name)) return;
					}
					if (providerTools.has(tool.name)) {
						// Multiple ordered search owners commonly expose the same
						// canonical web_search tool. The first owner is authoritative;
						// all other tools remain captured and are never leaked.
						if (tool.name === "web_search") return;
						throw new Error(
							`workflow web provider registered duplicate tool ${JSON.stringify(tool.name)}`,
						);
					}
					providerTools.set(tool.name, tool);
				};
			}
			if (property === "appendEntry") {
				return (type: string, data: unknown) => {
					captureOrdinarySearchProviders(
						providerSearchCapture.getStore(),
						type,
						data,
					);
				};
			}
			if (
				property === "sendMessage" ||
				property === "on" ||
				property === "registerCommand" ||
				property === "registerShortcut"
			) {
				return () => undefined;
			}
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as PiLike;
}

interface WorkflowWebFetchSourceRequest {
	url: string;
	title?: string;
}

function isSensitiveWorkflowWebUrlReason(reason: string): boolean {
	return reason === "sensitive_url_userinfo" || reason === "sensitive_url_query";
}

function fetchSourceBatchRequested(params: unknown): boolean {
	return Boolean(
		isRecord(params) &&
			(Array.isArray(params.urls) || Array.isArray(params.sources)),
	);
}

function canonicalWorkflowWebFetchUrl(url: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return url.trim();
	}
	parsed.hostname = parsed.hostname.toLowerCase();
	if (!shouldKeepWorkflowWebFragment(parsed.hash)) parsed.hash = "";
	if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
		parsed.pathname = parsed.pathname.slice(0, -1);
	}
	const sortedParams = [...parsed.searchParams.entries()].sort(
		([left], [right]) => left.localeCompare(right),
	);
	parsed.search = "";
	for (const [key, value] of sortedParams)
		parsed.searchParams.append(key, value);
	return parsed.href;
}

function shouldKeepWorkflowWebFragment(hash: string): boolean {
	if (!hash) return false;
	const raw = hash.startsWith("#") ? hash.slice(1) : hash;
	return raw.startsWith("/") || raw.startsWith("!") || raw.includes("?");
}

function fetchSourceRequestsFromParams(
	params: unknown,
): WorkflowWebFetchSourceRequest[] {
	if (!isRecord(params)) return [];
	const requests: WorkflowWebFetchSourceRequest[] = [];
	const titles = Array.isArray(params.titles) ? params.titles : [];
	if (Array.isArray(params.sources)) {
		for (const source of params.sources) {
			if (
				!isRecord(source) ||
				typeof source.url !== "string" ||
				!source.url.trim()
			)
				continue;
			requests.push({
				url: source.url.trim(),
				...(typeof source.title === "string" && source.title.trim()
					? { title: source.title.trim() }
					: {}),
			});
		}
	}
	if (Array.isArray(params.urls)) {
		for (const [index, url] of params.urls.entries()) {
			if (typeof url !== "string" || !url.trim()) continue;
			const title = titles[index];
			requests.push({
				url: url.trim(),
				...(typeof title === "string" && title.trim()
					? { title: title.trim() }
					: {}),
			});
		}
	}
	if (typeof params.url === "string" && params.url.trim()) {
		requests.push({
			url: params.url.trim(),
			...(typeof params.title === "string" && params.title.trim()
				? { title: params.title.trim() }
				: {}),
		});
	}
	return requests;
}

function dedupeFetchSourceRequests(
	requests: WorkflowWebFetchSourceRequest[],
): WorkflowWebFetchSourceRequest[] {
	const deduped: WorkflowWebFetchSourceRequest[] = [];
	const seen = new Set<string>();
	for (const request of requests) {
		const key = sourceUrlCacheKey(request.url);
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(request);
	}
	return deduped;
}

function payloadFromToolResult(result: ToolResult): Record<string, unknown> {
	const text = result.content?.find(
		(item) => typeof item.text === "string",
	)?.text;
	if (typeof text !== "string") return {};
	try {
		const payload = JSON.parse(text);
		return isRecord(payload) ? payload : {};
	} catch {
		return {};
	}
}

function urlFromParams(params: unknown): string | undefined {
	if (!isRecord(params)) return undefined;
	if (typeof params.url === "string") return params.url;
	if (Array.isArray(params.urls)) {
		return params.urls.find((item): item is string => typeof item === "string");
	}
	return undefined;
}

function titleFromParams(params: unknown): string | undefined {
	return stringParam(params, "title");
}

function sourceReadRequestCount(params: unknown): number {
	if (!isRecord(params)) return 0;
	let count = 0;
	if (Array.isArray(params.reads)) count += params.reads.length;
	for (const key of ["queries", "exactTexts", "texts"]) {
		if (Array.isArray(params[key])) count += params[key].length;
	}
	const hasScalarRequest =
		["query", "exactText", "exact", "text", "claim"].some(
			(key) => typeof params[key] === "string" && params[key].trim(),
		) || (Array.isArray(params.terms) && params.terms.length > 0);
	if (hasScalarRequest) count += 1;
	return count;
}

function sourceReadRequestsFromParams(
	params: unknown,
): WorkflowWebSourceReadRequest[] {
	const requests: WorkflowWebSourceReadRequest[] = [];
	if (isRecord(params) && Array.isArray(params.reads)) {
		for (const item of params.reads) {
			const request = sourceReadRequestFromRecord(item);
			if (request) requests.push(request);
		}
	}
	for (const query of stringArrayParam(params, "queries"))
		requests.push({ query });
	for (const query of stringArrayParam(params, "exactTexts"))
		requests.push({ query });
	for (const query of stringArrayParam(params, "texts"))
		requests.push({ query });
	const query =
		stringParam(params, "query") ??
		stringParam(params, "exactText") ??
		stringParam(params, "exact") ??
		stringParam(params, "text");
	const claim = stringParam(params, "claim");
	const terms = stringArrayParam(params, "terms");
	if (query || claim || terms.length > 0)
		requests.push({ query, claim, terms });
	return dedupeSourceReadRequests(requests);
}

function sourceReadRequestFromRecord(
	value: unknown,
): WorkflowWebSourceReadRequest | undefined {
	if (!isRecord(value)) return undefined;
	const query =
		stringParam(value, "query") ??
		stringParam(value, "exactText") ??
		stringParam(value, "exact") ??
		stringParam(value, "text");
	const claim = stringParam(value, "claim");
	const terms = stringArrayParam(value, "terms");
	const maxChars = positiveIntParam(value, "maxChars");
	if (!query && !claim && terms.length === 0) return undefined;
	return { query, claim, terms, maxChars };
}

function dedupeSourceReadRequests(
	requests: WorkflowWebSourceReadRequest[],
): WorkflowWebSourceReadRequest[] {
	const deduped: WorkflowWebSourceReadRequest[] = [];
	const seen = new Set<string>();
	for (const request of requests) {
		const key = JSON.stringify({
			query: request.query?.toLowerCase(),
			claim: request.claim?.toLowerCase(),
			terms: request.terms?.map((term) => term.toLowerCase()).sort(),
			maxChars: request.maxChars,
		});
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(request);
	}
	return deduped;
}

function redactSourceReadEcho(value: string): string {
	return redactSensitiveWorkflowText(value).replace(/\s+/gu, " ").trim().slice(0, 500);
}

function sourceReadBatchRequested(params: unknown): boolean {
	return (
		(isRecord(params) &&
			Array.isArray(params.reads) &&
			params.reads.length > 0) ||
		stringArrayParam(params, "queries").length > 0 ||
		stringArrayParam(params, "exactTexts").length > 0 ||
		stringArrayParam(params, "texts").length > 0
	);
}

type SourceReadToolStatus =
	| "ok"
	| "candidate"
	| "truncated"
	| "budget_exhausted"
	| "not_found";

function sourceReadResponseStatus(
	read: WorkflowWebSourceReadResult,
): SourceReadToolStatus {
	if (read.status === "truncated" && !read.quote) return "budget_exhausted";
	if (read.status === "truncated") return "truncated";
	if (read.status === "matched" && !read.quote) return "budget_exhausted";
	if (read.status === "matched" && read.candidateOnly) return "candidate";
	if (read.status === "matched") return "ok";
	return "not_found";
}

function aggregateSourceReadStatus(
	statuses: SourceReadToolStatus[],
):
	| "ok"
	| "candidate"
	| "partial"
	| "truncated"
	| "budget_exhausted"
	| "not_found" {
	if (statuses.every((status) => status === "ok")) return "ok";
	if (statuses.every((status) => status === "candidate")) return "candidate";
	if (statuses.every((status) => status === "truncated")) return "truncated";
	if (statuses.every((status) => status === "not_found")) return "not_found";
	if (statuses.every((status) => status === "budget_exhausted"))
		return "budget_exhausted";
	return "partial";
}

function stringArrayParam(params: unknown, key: string): string[] {
	if (!isRecord(params)) return [];
	const value = params[key];
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter(Boolean);
}

function stringParam(params: unknown, key: string): string | undefined {
	if (!isRecord(params)) return undefined;
	const value = params[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveIntParam(params: unknown, key: string): number | undefined {
	if (!isRecord(params)) return undefined;
	const value = params[key];
	return Number.isInteger(value) && (value as number) > 0
		? (value as number)
		: undefined;
}

function isWorkflowWebTextContentType(contentType: string): boolean {
	return /^(text\/|application\/(json|xml|xhtml\+xml|ld\+json)|[^;]+\+json\b|[^;]+\+xml\b)/i.test(
		contentType.trim(),
	);
}

function extractWorkflowWebResponseText(
	text: string,
	contentType?: string,
): { text: string; title?: string; lossy?: boolean } {
	const looksHtml =
		/html/i.test(contentType ?? "") ||
		/<html[\s>]|<body[\s>]|<title[\s>]/i.test(text);
	if (!looksHtml) {
		return { text, title: titleFromPlainText(text) };
	}
	const title =
		decodeHtmlEntities(
			text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "",
		).slice(0, 200) || undefined;
	const body = text
		.replace(/<script\b[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
		.replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
		.replace(/<[^>]+>/g, " ");
	return {
		text: decodeHtmlEntities(body).replace(/\s+/g, " ").trim(),
		title,
		lossy: true,
	};
}

function titleFromPlainText(text: string): string | undefined {
	const markdownTitle = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
	return markdownTitle ? markdownTitle.slice(0, 200) : undefined;
}

function decodeHtmlEntities(value: string): string {
	return value
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&#(\d+);/g, (_match, code) => {
			const value = Number(code);
			return isValidCodePoint(value) ? String.fromCodePoint(value) : "";
		})
		.replace(/&#x([0-9a-f]+);/gi, (_match, code) => {
			const value = Number.parseInt(code, 16);
			return isValidCodePoint(value) ? String.fromCodePoint(value) : "";
		});
}

function isValidCodePoint(value: number): boolean {
	return Number.isInteger(value) && value >= 0 && value <= 0x10ffff;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extensionImportSpecifier(importPath: string): string {
	if (isAbsolute(importPath)) return pathToFileURL(resolve(importPath)).href;
	return importPath;
}

