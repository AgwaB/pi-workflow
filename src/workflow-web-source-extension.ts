import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";

import {
	buildWorkflowWebSourceCard,
	createWorkflowWebSource,
	createWorkflowWebVisibleBudget,
	errorToolResult,
	extractSearchCandidates,
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
	type WorkflowWebSecurityPolicy,
	type WorkflowWebSource,
	type WorkflowWebSourceCacheConfig,
	type WorkflowWebSourcePolicy,
	type WorkflowWebSourceReadRequest,
	type WorkflowWebSourceReadResult,
} from "./workflow-web-source.js";

export const WORKFLOW_WEB_SOURCE_LAUNCH_CONFIG_SCHEMA =
	"workflow-web-source-launch-config-v1" as const;

export interface WorkflowWebProviderLaunchConfig {
	kind: "pi-web-access" | "extension" | "none";
	extensionPath?: string;
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
}

export interface WorkflowWebSourceExtensionWrapperOptions {
	wrapperPath: string;
	importPath: string;
	providerExtensionPath?: string;
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

type CapturedProviderTools = Map<string, ToolSpec>;

type FetchFailure = {
	code: string;
	message: string;
	extra: Record<string, unknown>;
	reason?: string;
	createdAt?: string;
};

const PROVIDER_TOOL_NAMES = new Set([
	"web_search",
	"code_search",
	"fetch_content",
	"get_search_content",
]);

export function registerWorkflowWebSourceExtension(
	pi: PiLike,
	config: WorkflowWebSourceLaunchConfig,
	providerExtension?: ProviderExtension,
): void {
	const policy = normalizeWorkflowWebSourcePolicy(config.webSourcePolicy);
	const security = normalizeWorkflowWebSecurityPolicy(config.securityPolicy);
	const budget = createWorkflowWebVisibleBudget(
		policy.perTaskVisibleCharBudget,
	);
	const providerTools: CapturedProviderTools = new Map();
	const sourceCache: Map<string, WorkflowWebSource> = new Map();
	const fetchInFlight: Map<
		string,
		Promise<ReturnType<typeof toolResultFromJson>>
	> = new Map();
	const fetchFailures: Map<string, FetchFailure> = new Map();

	if (providerExtension) {
		providerExtension(
			providerCapturePi(pi, providerTools, Boolean(config.exposeLegacyTools)),
		);
	}

	pi.registerTool({
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
				Type.Number({ description: "Results per query." }),
			),
		}),
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			const providerTool = providerTools.get("web_search");
			if (!providerTool?.execute) {
				const missing = missingProviderStatus(providerTools, "search");
				await recordWorkflowWebSourceEvent(config, "missing_provider", {
					tool: "workflow_web_search",
					code: missing.code,
				});
				return errorToolResult(missing.code, missing.message);
			}
			const providerParams = isRecord(params)
				? { ...params, workflow: params.workflow ?? "none" }
				: params;
			const result = await providerTool.execute(
				toolCallId,
				providerParams,
				signal,
				onUpdate,
				ctx,
			);
			const candidates = extractSearchCandidates(result, policy).map(
				(candidate) => {
					const consumed = consumeText(
						candidate.snippet,
						policy.searchSnippetChars,
					);
					return {
						...candidate,
						snippet: consumed.text,
						budget: consumed.budget,
					};
				},
			);
			await recordWorkflowWebSourceEvent(config, "search", {
				candidateCount: candidates.length,
				visibleChars: budget.used,
			});
			return toolResultFromJson({
				status: "ok",
				tool: "workflow_web_search",
				candidates,
				budget: budgetSnapshot(),
				next: "Use workflow_web_fetch_source for a promising URL, then workflow_web_source_read for exact evidence quotes.",
			});
		},
	});

	pi.registerTool({
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
			const batchRequested = fetchSourceBatchRequested(params);
			if (batchRequested) {
				const requests = fetchSourceRequestsFromParams(params);
				if (requests.length === 0) {
					return errorToolResult(
						"invalid_params",
						"workflow_web_fetch_source requires url, urls, or sources parameters.",
					);
				}
				const results: Array<Record<string, unknown>> = [];
				const cards: Record<string, unknown>[] = [];
				for (const [index, request] of requests.entries()) {
					const result = await fetchWorkflowWebSourceOnce(
						`${toolCallId}-${index}`,
						request,
						signal,
						onUpdate,
						ctx,
					);
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
					budget: budgetSnapshot(status !== "ok"),
					next: "Use returned sourceRefs with workflow_web_source_read; batch snippets with reads:[...] or queries:[...] when possible.",
				});
			}
			return await fetchWorkflowWebSourceOnce(
				toolCallId,
				params,
				signal,
				onUpdate,
				ctx,
			);
		},
	});

	async function fetchWorkflowWebSourceOnce(
		toolCallId: string,
		params: unknown,
		signal?: AbortSignal,
		onUpdate?: unknown,
		ctx?: unknown,
	): Promise<ToolResult> {
		const url = urlFromParams(params);
		if (!url) {
			return errorToolResult(
				"invalid_params",
				"workflow_web_fetch_source requires a url string parameter.",
			);
		}
		const checked = validateWorkflowWebUrl(url, security);
		if (!checked.ok) {
			await recordWorkflowWebSourceEvent(config, "blocked_url", {
				url: sanitizeUrlForModel(url),
				reason: checked.reason,
			});
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
		if (existing) {
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
		const inFlight = fetchInFlight.get(fetchKey);
		if (inFlight) {
			const result = await inFlight;
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
		const fetchPromise = withWorkflowWebFetchLock(
			config,
			fetchKey,
			signal,
			async () => {
				const lockedExisting = await findWorkflowWebSourceByUrl(
					config,
					fetchUrl,
				);
				if (lockedExisting) {
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
				if (config.provider.kind === "pi-web-access") {
					const safeFetch = await safeFetchWorkflowWebText(
						fetchUrl,
						security,
						signal,
					);
					if (!safeFetch.ok) {
						await recordWorkflowWebSourceEvent(config, "blocked_provider_url", {
							url: sanitizeUrlForModel(safeFetch.url),
							reason: safeFetch.reason,
						});
						return await cachedFetchFailureResult(
							config,
							fetchFailures,
							fetchKey,
							{
								code: "blocked_url",
								message:
									"URL was blocked by workflow web-source security policy before content fetch.",
								extra: {
									reason: safeFetch.reason,
									url: sanitizeUrlForModel(safeFetch.url),
								},
								reason: safeFetch.reason,
							},
						);
					}
					text = safeFetch.text;
					title = title ?? safeFetch.title;
					extractionLossy = safeFetch.extractionLossy;
					providerKind = "pi-web-access-safe-fetch";
				} else {
					const providerTool = providerTools.get("fetch_content");
					if (!providerTool?.execute) {
						const missing = missingProviderStatus(providerTools, "fetch");
						await recordWorkflowWebSourceEvent(config, "missing_provider", {
							tool: "workflow_web_fetch_source",
							code: missing.code,
						});
						return errorToolResult(missing.code, missing.message);
					}
					if (!security.allowPrivateHosts) {
						await recordWorkflowWebSourceEvent(
							config,
							"blocked_provider_fetch",
							{
								url: sanitizeUrlForModel(fetchUrl),
								reason: "untrusted_provider_fetch",
							},
						);
						return errorToolResult(
							"untrusted_provider_fetch",
							"Custom provider fetch_content is disabled unless securityPolicy.allowPrivateHosts is true; use the default safe fetch provider or a trusted provider configuration.",
							{ url: sanitizeUrlForModel(fetchUrl) },
						);
					}
					const providerHostCheck = await validateResolvedHost(
						fetchUrl,
						security,
					);
					if (!providerHostCheck.ok) {
						await recordWorkflowWebSourceEvent(config, "blocked_provider_url", {
							url: sanitizeUrlForModel(providerHostCheck.url),
							reason: providerHostCheck.reason,
						});
						return await cachedFetchFailureResult(
							config,
							fetchFailures,
							fetchKey,
							{
								code: "blocked_url",
								message:
									"URL was blocked by workflow web-source security policy before provider fetch.",
								extra: {
									reason: providerHostCheck.reason,
									url: sanitizeUrlForModel(providerHostCheck.url),
								},
								reason: providerHostCheck.reason,
							},
						);
					}
					const result = await providerTool.execute(
						toolCallId,
						{ ...(isRecord(params) ? params : {}), url: fetchUrl },
						signal,
						onUpdate,
						ctx,
					);
					const providerUrlCheck = await validateProviderResultUrls(
						result,
						security,
					);
					if (!providerUrlCheck.ok) {
						await recordWorkflowWebSourceEvent(config, "blocked_provider_url", {
							url: sanitizeUrlForModel(providerUrlCheck.url),
							reason: providerUrlCheck.reason,
						});
						return await cachedFetchFailureResult(
							config,
							fetchFailures,
							fetchKey,
							{
								code: "blocked_url",
								message:
									"Provider result URL was blocked by workflow web-source security policy.",
								extra: {
									reason: providerUrlCheck.reason,
									url: sanitizeUrlForModel(providerUrlCheck.url),
								},
								reason: providerUrlCheck.reason,
							},
						);
					}
					text = extractTextFromToolResult(result);
					title = title ?? extractTitleFromToolResult(result);
				}
				if (!text.trim()) {
					await recordWorkflowWebSourceEvent(config, "fetch_empty", {
						url: sanitizeUrlForModel(fetchUrl),
					});
					return await cachedFetchFailureResult(
						config,
						fetchFailures,
						fetchKey,
						{
							code: "empty_source",
							message: "Provider returned no extractable text for this URL.",
							extra: { url: sanitizeUrlForModel(fetchUrl) },
							reason: "empty_source",
						},
					);
				}
				const source = createWorkflowWebSource({
					config,
					url: fetchUrl,
					text,
					title,
					provider: providerKind,
					extractionLossy,
				});
				await writeWorkflowWebSource(config, source);
				sourceCache.set(source.sourceRef, source);
				const card = buildWorkflowWebSourceCard({ source, policy, budget });
				await recordWorkflowWebSourceEvent(config, "fetch_write", {
					sourceRef: source.sourceRef,
					url: source.redactedUrl,
					textChars: source.textChars,
					visibleChars: budget.used,
				});
				return toolResultFromJson({
					status: "ok",
					tool: "workflow_web_fetch_source",
					card,
				});
			},
		).catch(async (error: unknown) => {
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
		fetchInFlight.set(fetchKey, fetchPromise);
		try {
			return await fetchPromise;
		} finally {
			fetchInFlight.delete(fetchKey);
		}
	}

	pi.registerTool({
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
					description:
						"Multiple exact/fuzzy texts to locate in one cached source. Prefer this over repeated calls when reading several snippets from the same sourceRef.",
				}),
			),
			exact: Type.Optional(
				Type.String({
					description: "Exact text to locate in the cached source.",
				}),
			),
			exactTexts: Type.Optional(
				Type.Array(Type.String(), {
					description: "Multiple exact texts to locate in one cached source.",
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
					description:
						"Important terms that should co-occur in the returned source window.",
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
								description:
									"Important terms for deterministic quote harvesting.",
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
						description:
							"Mixed batch reads for one sourceRef; each item can use query or claim+terms.",
					},
				),
			),
			maxChars: Type.Optional(
				Type.Number({
					description: "Maximum visible snippet characters per query.",
				}),
			),
		}),
		execute: async (_toolCallId, params) => {
			const sourceRef =
				stringParam(params, "sourceRef") ?? stringParam(params, "source_ref");
			const requests = sourceReadRequestsFromParams(params);
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
					...(request.query ? { query: request.query } : {}),
					...(request.claim ? { claim: request.claim } : {}),
					...(request.terms?.length ? { terms: request.terms } : {}),
					status,
					matchType: read.matchType,
					matchedTerms: read.matchedTerms,
					missingTerms: read.missingTerms,
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
					...(result.query ? { query: result.query } : {}),
					...(result.claim ? { claim: result.claim } : {}),
					...(result.terms?.length ? { terms: result.terms } : {}),
					matchType: result.matchType,
					matchedTerms: result.matchedTerms,
					missingTerms: result.missingTerms,
					coverageRatio: result.coverageRatio,
					candidateOnly: result.candidateOnly,
					truncated: result.truncated,
					quote:
						result.status === "budget_exhausted" ? undefined : result.quote,
					startOffset: result.startOffset,
					endOffset: result.endOffset,
					budget: budgetSnapshot(
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
				budget: budgetSnapshot(hasBudgetExhaustedRead || hasTruncatedRead),
				next: hasBudgetExhaustedRead
					? "Visible web-source budget is exhausted for this task; cite missing quotes as evidence gaps or use smaller query batches in a fresh task."
					: hasTruncatedRead
						? "One or more matched web-source snippets were truncated by the visible budget or maxChars; use smaller exact queries or a fresh task if full quotes are required."
						: undefined,
			});
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

	function consumeText(text: string, maxChars: number) {
		const remainingBefore = Math.max(0, budget.limit - budget.used);
		const allowed = Math.max(0, Math.min(maxChars, remainingBefore));
		const visible = text.slice(0, allowed);
		budget.used += visible.length;
		return { text: visible, budget: budgetSnapshot(text.length > allowed) };
	}

	function budgetSnapshot(truncated = false) {
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
	const providerImport = options.providerExtensionPath
		? `import providerExtension from ${JSON.stringify(extensionImportSpecifier(options.providerExtensionPath))};`
		: "const providerExtension = undefined;";
	return [
		`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`,
		providerImport,
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
		config: options.config,
	});
	await writeFile(wrapperPath, content, "utf8");
	return wrapperPath;
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
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

async function cachedFetchFailureResult(
	config: WorkflowWebSourceCacheConfig,
	cache: Map<string, FetchFailure>,
	key: string,
	failure: {
		code: string;
		message: string;
		extra: Record<string, unknown>;
		reason: string;
	},
): Promise<ReturnType<typeof toolResultFromJson>> {
	const cached = {
		code: failure.code,
		message: failure.message,
		extra: failure.extra,
		reason: failure.reason,
		createdAt: new Date().toISOString(),
	};
	if (shouldCacheFetchFailure(failure.reason)) {
		cache.set(key, cached);
		await writeDurableFetchFailure(config, key, cached);
	} else if (shouldCacheFetchFailureInMemory(failure.reason)) {
		cache.set(key, cached);
	}
	return errorToolResult(failure.code, failure.message, failure.extra);
}

const FETCH_LOCK_STALE_MS = 60_000;
const FETCH_LOCK_WAIT_MS = 75_000;

async function withWorkflowWebFetchLock<T>(
	config: WorkflowWebSourceCacheConfig,
	key: string,
	signal: AbortSignal | undefined,
	fn: () => Promise<T>,
): Promise<T> {
	const release = await acquireWorkflowWebFetchLock(config, key, signal);
	try {
		return await fn();
	} finally {
		await release();
	}
}

async function acquireWorkflowWebFetchLock(
	config: WorkflowWebSourceCacheConfig,
	key: string,
	signal?: AbortSignal,
): Promise<() => Promise<void>> {
	const lockDir = fetchLockPath(config, key);
	await mkdir(dirname(lockDir), { recursive: true });
	const started = Date.now();
	for (;;) {
		if (signal?.aborted) throw new Error("aborted");
		try {
			await mkdir(lockDir);
			await writeFile(
				resolve(lockDir, "owner.json"),
				`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), key }, null, 2)}\n`,
				"utf8",
			);
			return async () => {
				await rm(lockDir, { recursive: true, force: true });
			};
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

async function removeStaleFetchLock(lockDir: string): Promise<void> {
	try {
		const current = await stat(lockDir);
		if (Date.now() - current.mtimeMs > FETCH_LOCK_STALE_MS) {
			await rm(lockDir, { recursive: true, force: true });
		}
	} catch {
		// Missing or unreadable lock will be retried by the caller.
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
	await mkdir(dirname(fetchFailurePath(config, key)), { recursive: true });
	await writeFile(
		fetchFailurePath(config, key),
		`${JSON.stringify({ schema: "workflow-web-source-fetch-failure-v1", ...failure }, null, 2)}\n`,
		"utf8",
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
	return isRecord(error) && error.code === "EEXIST";
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

const WORKFLOW_WEB_FETCH_TIMEOUT_MS = 30_000;
const WORKFLOW_WEB_FETCH_MAX_CHARS = 1_000_000;

async function safeFetchWorkflowWebText(
	url: string,
	security: WorkflowWebSecurityPolicy,
	signal?: AbortSignal,
): Promise<
	| {
			ok: true;
			url: string;
			text: string;
			title?: string;
			extractionLossy?: boolean;
	  }
	| { ok: false; reason: string; url: string }
> {
	let current = url;
	for (let redirectCount = 0; redirectCount < 6; redirectCount += 1) {
		const checked = validateWorkflowWebUrl(current, security);
		if (!checked.ok) return { ok: false, reason: checked.reason, url: current };
		const response = await safeFetchOnce(
			checked.normalizedUrl,
			security,
			signal,
		);
		if (!response.ok) return response;
		if (response.status >= 300 && response.status < 400) {
			if (!response.location)
				return {
					ok: false,
					reason: "redirect_without_location",
					url: checked.normalizedUrl,
				};
			current = new URL(response.location, checked.normalizedUrl).href;
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
			extractionLossy: extracted.lossy || response.truncated,
		};
	}
	return { ok: false, reason: "too_many_redirects", url: current };
}

function safeFetchOnce(
	url: string,
	security: WorkflowWebSecurityPolicy,
	signal?: AbortSignal,
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
	const parsed = new URL(url);
	const request = parsed.protocol === "https:" ? httpsRequest : httpRequest;
	return new Promise((resolveResult) => {
		let settled = false;
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
					res.resume();
					settle({ ok: false, reason: "unsupported_content_type", url });
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
				res.on("close", () => {
					if (!truncated) return;
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
		req.on("error", (error: Error) => {
			if (error.message === "workflow_fetch_truncated") return;
			settle({ ok: false, reason: error.message || "url_fetch_failed", url });
		});
		if (signal) {
			signal.addEventListener(
				"abort",
				() => {
					req.destroy(new Error("aborted"));
				},
				{ once: true },
			);
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
			: privateIpReason(address.address);
		if (!reason) return address;
	}
	throw new Error(
		addresses.length > 0 ? "private_host_blocked" : "dns_resolution_failed",
	);
}

async function validateResolvedHost(
	url: string,
	security: WorkflowWebSecurityPolicy,
): Promise<{ ok: true } | { ok: false; reason: string; url: string }> {
	if (security.allowPrivateHosts) return { ok: true };
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { ok: false, reason: "invalid_url", url };
	}
	try {
		const addresses = await lookup(parsed.hostname, {
			all: true,
			verbatim: true,
		});
		for (const address of addresses) {
			const reason = privateIpReason(address.address);
			if (reason) return { ok: false, reason, url };
		}
		return { ok: true };
	} catch {
		return { ok: false, reason: "dns_resolution_failed", url };
	}
}

function isLookupAllOptions(options: unknown): boolean {
	return isRecord(options) && options.all === true;
}

function privateIpReason(address: string): string | undefined {
	const lower = address.toLowerCase().replace(/^\[|\]$/g, "");
	const mappedIpv4 = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
	if (mappedIpv4) return privateIpReason(mappedIpv4);
	const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
	if (hexMapped) {
		const high = Number.parseInt(hexMapped[1]!, 16);
		const low = Number.parseInt(hexMapped[2]!, 16);
		return privateIpReason(
			`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`,
		);
	}
	if (isIP(lower) === 4) {
		const parts = lower.split(".").map((part) => Number(part));
		if (
			parts.length !== 4 ||
			parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
		)
			return "private_host_blocked";
		const [a, b, c, d] = parts as [number, number, number, number];
		if (a === 0 || a === 10 || a === 127 || a >= 224)
			return "private_host_blocked";
		if (a === 100 && b >= 64 && b <= 127) return "private_host_blocked";
		if (a === 169 && b === 254) return "private_host_blocked";
		if (a === 172 && b >= 16 && b <= 31) return "private_host_blocked";
		if (a === 192 && b === 168) return "private_host_blocked";
		if (a === 192 && b === 0 && (c === 0 || c === 2))
			return "private_host_blocked";
		if (a === 198 && (b === 18 || b === 19)) return "private_host_blocked";
		if (a === 198 && b === 51 && c === 100) return "private_host_blocked";
		if (a === 203 && b === 0 && c === 113) return "private_host_blocked";
		if (a === 255 && b === 255 && c === 255 && d === 255)
			return "private_host_blocked";
	}
	if (isIP(lower) === 6) {
		if (lower === "::" || lower === "::1") return "private_host_blocked";
		if (lower.startsWith("fc") || lower.startsWith("fd"))
			return "private_host_blocked";
		if (lower.startsWith("fe80") || lower.startsWith("ff"))
			return "private_host_blocked";
		if (lower.startsWith("2001:db8")) return "private_host_blocked";
	}
	return undefined;
}

async function validateProviderResultUrls(
	result: unknown,
	security: WorkflowWebSecurityPolicy,
): Promise<{ ok: true } | { ok: false; reason: string; url: string }> {
	for (const url of providerResultUrls(result)) {
		const checked = validateWorkflowWebUrl(url, security);
		if (!checked.ok) return { ok: false, reason: checked.reason, url };
		const resolved = await validateResolvedHost(
			checked.normalizedUrl,
			security,
		);
		if (!resolved.ok) return resolved;
	}
	if (!security.allowPrivateHosts) {
		for (const address of providerResolvedIps(result)) {
			const reason = privateIpReason(address);
			if (reason) return { ok: false, reason, url: address };
		}
	}
	return { ok: true };
}

function providerResultUrls(result: unknown): string[] {
	if (!isRecord(result)) return [];
	const details = result.details;
	if (!isRecord(details)) return [];
	const urls: string[] = [];
	for (const key of ["finalUrl", "resolvedUrl", "effectiveUrl", "url"]) {
		const value = details[key];
		if (typeof value === "string") urls.push(value);
	}
	const detailsUrls = details.urls;
	if (Array.isArray(detailsUrls)) {
		for (const item of detailsUrls) {
			if (typeof item === "string") urls.push(item);
			if (isRecord(item)) {
				for (const key of ["finalUrl", "resolvedUrl", "effectiveUrl", "url"]) {
					const value = item[key];
					if (typeof value === "string") urls.push(value);
				}
			}
		}
	}
	return [...new Set(urls)];
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

function providerCapturePi(
	pi: PiLike,
	providerTools: CapturedProviderTools,
	exposeLegacyTools: boolean,
): PiLike {
	return new Proxy(pi, {
		get(target, property, receiver) {
			if (property === "registerTool") {
				return (tool: ToolSpec) => {
					if (tool.name && PROVIDER_TOOL_NAMES.has(tool.name)) {
						providerTools.set(tool.name, tool);
						if (!exposeLegacyTools) return;
					}
					target.registerTool(tool);
				};
			}
			if (property === "appendEntry" || property === "sendMessage") {
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
	return dedupeFetchSourceRequests(requests).slice(0, 20);
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
	return dedupeSourceReadRequests(requests).slice(0, 20);
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

export function workflowWebSourceModuleImportPath(modulePath: string): string {
	return resolve(
		dirname(modulePath),
		`workflow-web-source-extension${extname(modulePath)}`,
	);
}
