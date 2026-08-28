import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";

import {
	appendPrivateFile,
	ensurePrivateDirectory,
	writePrivateFileAtomic,
	publishPrivateGenerationDirectory,
} from "./secure-atomic-write.js";
import {
	hasSensitiveWorkflowQueryKey,
	hasUnsafeSensitiveWorkflowQueryKeyEncoding,
	isSensitiveWorkflowQueryKey,
	redactSensitiveWorkflowFragment,
	redactSensitiveWorkflowText,
} from "./workflow-sensitive-query.js";
import { compactStrings } from "./strings.js";
import { nonPublicIpReason } from "./workflow-network-policy.js";

export const WORKFLOW_WEB_SOURCE_CACHE_SCHEMA =
	"workflow-web-source-cache-v1" as const;
export const WORKFLOW_WEB_SOURCE_INDEX_SCHEMA =
	"workflow-web-source-index-v1" as const;
export const WORKFLOW_WEB_SOURCE_INDEX_EVENT_SCHEMA =
	"workflow-web-source-index-event-v1" as const;
export const WORKFLOW_WEB_SOURCE_EVENT_SCHEMA =
	"workflow-web-source-event-v1" as const;
export const WORKFLOW_WEB_SEARCH_CANDIDATE_LIMIT = 10 as const;
export const WORKFLOW_WEB_SEARCH_PROVIDER_LIMIT = 10 as const;
export const WORKFLOW_WEB_SOURCE_TERM_LIMIT = 16 as const;
export const WORKFLOW_WEB_DIRECT_FETCHER =
	"pi-workflow-direct-safe-fetch" as const;
export const WORKFLOW_WEB_DIRECT_FETCH_POLICY =
	"pi-workflow-strict-public-http-v1" as const;

export const WORKFLOW_WEB_SOURCE_TOOLS = [
	"workflow_web_search",
	"workflow_web_fetch_source",
	"workflow_web_source_read",
] as const;

export type WorkflowWebSourceTool = (typeof WORKFLOW_WEB_SOURCE_TOOLS)[number];

export interface WorkflowWebSourcePolicy {
	previewChars: number;
	duplicatePreviewChars: number;
	sourceReadMaxChars: number;
	searchSnippetChars: number;
	perTaskVisibleCharBudget: number;
}

export interface WorkflowWebSecurityPolicy {
	allowPrivateHosts: boolean;
	cacheRawProviderPayloads: boolean;
}

export interface WorkflowWebSourceCacheConfig {
	runId: string;
	taskId: string;
	cacheDir: string;
}

export interface WorkflowWebSourceProvenance {
	fetcher: string;
	policy: string;
}

export interface WorkflowWebSource {
	schema: typeof WORKFLOW_WEB_SOURCE_CACHE_SCHEMA;
	sourceRef: string;
	createdAt: string;
	runId: string;
	taskId: string;
	url: string;
	redactedUrl: string;
	urlKey?: string;
	effectiveUrl?: string;
	aliases?: string[];
	domain: string;
	title?: string;
	provider?: string;
	provenance?: WorkflowWebSourceProvenance;
	contentHash: string;
	text: string;
	textChars: number;
	extractionLossy?: boolean;
	metadata?: Record<string, string | number | boolean | null>;
}

export interface WorkflowWebSourceIndexEntry {
	sourceRef: string;
	createdAt: string;
	url: string;
	redactedUrl: string;
	urlKey?: string;
	effectiveUrl?: string;
	aliases?: string[];
	domain: string;
	title?: string;
	contentHash: string;
	textChars: number;
	provider?: string;
	provenance?: WorkflowWebSourceProvenance;
}

export interface WorkflowWebSourceIndex {
	schema: typeof WORKFLOW_WEB_SOURCE_INDEX_SCHEMA;
	updatedAt: string;
	runId: string;
	sources: WorkflowWebSourceIndexEntry[];
}

export interface WorkflowWebVisibleBudget {
	limit: number;
	used: number;
}

export interface WorkflowWebSourceReadRequest {
	query?: string;
	claim?: string;
	terms?: string[];
	maxChars?: number;
}

export interface WorkflowWebSourceReadResult {
	status: "matched" | "truncated" | "not_found";
	matchType?: "exact" | "normalized" | "terms";
	quote?: string;
	startOffset?: number;
	endOffset?: number;
	visibleChars: number;
	matchedTerms?: string[];
	missingTerms?: string[];
	coverageRatio?: number;
	candidateOnly?: boolean;
	truncated?: boolean;
}

export interface WorkflowWebSourceCard {
	sourceRef: string;
	url: string;
	effectiveUrl?: string;
	aliases?: string[];
	domain: string;
	title?: string;
	preview: string;
	textChars: number;
	fullContentCached: boolean;
	duplicate: boolean;
	provenance?: WorkflowWebSourceProvenance;
	budget: {
		limit: number;
		used: number;
		remaining: number;
		truncated: boolean;
	};
	next: string;
}

export interface WorkflowWebSearchCandidate {
	url?: string;
	title?: string;
	snippet: string;
	domain?: string;
}

export type WorkflowWebSearchStatus =
	| "ok"
	| "partial"
	| "empty"
	| "failed"
	| "cancelled";

export interface WorkflowWebSearchCandidateEnvelope {
	candidates: WorkflowWebSearchCandidate[];
	candidateCountTotal: number;
	candidateCountReturned: number;
	candidateTruncated: boolean;
}

export interface WorkflowWebSearchProvenance {
	adapter: "pi-web-access-formatted-text" | "extension-formatted-text";
	attributionAvailable: boolean;
	searchId?: string;
	providers: string[];
	selectedProviders?: string[];
	providerCountTotal: number;
	providerCountReturned: number;
	truncated: boolean;
}

export interface WorkflowWebSearchPayload
	extends WorkflowWebSearchCandidateEnvelope {
	status: WorkflowWebSearchStatus;
	tool: "workflow_web_search";
	queryCount?: number;
	successfulQueryCount?: number;
	sourceCountReported?: number;
	upstreamTruncated: boolean;
	truncated: boolean;
	provenance: WorkflowWebSearchProvenance;
	budget: unknown;
	next: string;
	code?: "search_failed" | "search_cancelled" | "no_results";
}

export const DEFAULT_WORKFLOW_WEB_SOURCE_POLICY: WorkflowWebSourcePolicy = {
	previewChars: 800,
	duplicatePreviewChars: 160,
	sourceReadMaxChars: 1_200,
	searchSnippetChars: 240,
	perTaskVisibleCharBudget: 12_000,
};

export const DEFAULT_WORKFLOW_WEB_SECURITY_POLICY: WorkflowWebSecurityPolicy = {
	allowPrivateHosts: false,
	cacheRawProviderPayloads: false,
};

const PRIVATE_HOST_PATTERNS = [
	/^localhost$/i,
	/^127\./,
	/^0\./,
	/^10\./,
	/^192\.168\./,
	/^169\.254\./,
	/^metadata\.google\.internal$/i,
];

export function normalizeWorkflowWebSourcePolicy(
	policy: Partial<WorkflowWebSourcePolicy> | undefined,
): WorkflowWebSourcePolicy {
	return {
		...DEFAULT_WORKFLOW_WEB_SOURCE_POLICY,
		...(policy ?? {}),
	};
}

export function normalizeWorkflowWebSecurityPolicy(
	policy: Partial<WorkflowWebSecurityPolicy> | undefined,
): WorkflowWebSecurityPolicy {
	return {
		...DEFAULT_WORKFLOW_WEB_SECURITY_POLICY,
		...(policy ?? {}),
	};
}

export function normalizeWorkflowWebSourceProvenance(
	value: unknown,
): WorkflowWebSourceProvenance | undefined {
	if (!isRecord(value)) return undefined;
	if (!boundedProvenanceIdentifier(value.fetcher)) return undefined;
	if (!boundedProvenanceIdentifier(value.policy)) return undefined;
	return { fetcher: value.fetcher, policy: value.policy };
}

function boundedProvenanceIdentifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length >= 1 &&
		value.length <= 80 &&
		/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
	);
}

export function isWorkflowWebSourceTool(
	tool: string,
): tool is WorkflowWebSourceTool {
	return (WORKFLOW_WEB_SOURCE_TOOLS as readonly string[]).includes(tool);
}

export function countWorkflowWebSourceTerms(
	terms: string[] | undefined,
): number {
	return dedupeStrings((terms ?? []).map((term) => term.trim()).filter(Boolean)).length;
}

export function createWorkflowWebVisibleBudget(
	limit: number,
): WorkflowWebVisibleBudget {
	return { limit: Math.max(0, Math.floor(limit)), used: 0 };
}

export function consumeWorkflowWebVisibleBudget(
	budget: WorkflowWebVisibleBudget,
	text: string,
	maxChars: number,
): { text: string; truncated: boolean; remaining: number; used: number } {
	const remainingBefore = Math.max(0, budget.limit - budget.used);
	const allowed = Math.max(0, Math.min(maxChars, remainingBefore));
	const truncated = text.length > allowed;
	const visible = text.slice(0, allowed);
	budget.used += visible.length;
	return {
		text: visible,
		truncated,
		remaining: Math.max(0, budget.limit - budget.used),
		used: budget.used,
	};
}

export function validateWorkflowWebUrl(
	url: string,
	security: WorkflowWebSecurityPolicy = DEFAULT_WORKFLOW_WEB_SECURITY_POLICY,
):
	| { ok: true; normalizedUrl: string; domain: string }
	| { ok: false; reason: string } {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { ok: false, reason: "invalid_url" };
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return { ok: false, reason: "unsafe_scheme" };
	}
	if (parsed.username || parsed.password) {
		return { ok: false, reason: "sensitive_url_userinfo" };
	}
	if (hasSensitiveWorkflowQueryKey(parsed)) {
		return { ok: false, reason: "sensitive_url_query" };
	}
	const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (!security.allowPrivateHosts && isPrivateHostname(host)) {
		return { ok: false, reason: "private_host_blocked" };
	}
	return { ok: true, normalizedUrl: parsed.href, domain: host };
}

export function sanitizeUrlForModel(url: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return redactInlineSecrets(url);
	}
	return sanitizeParsedUrlForModel(parsed);
}

function sanitizeParsedUrlForModel(parsed: URL): string {
	parsed.username = "";
	parsed.password = "";
	for (const key of [...parsed.searchParams.keys()]) {
		if (isSensitiveWorkflowQueryKey(key)) {
			// Keep the established redaction shape for ordinary names such as
			// token, but hide names that themselves disclose a secret or could not
			// be safely decoded.
			if (hasUnsafeSensitiveWorkflowQueryKeyEncoding(key) || /secret/i.test(key)) {
				parsed.searchParams.delete(key);
				parsed.searchParams.append("REDACTED", "REDACTED");
			} else {
				parsed.searchParams.set(key, "REDACTED");
			}
		}
	}
	parsed.hash = redactSensitiveWorkflowFragment(parsed.hash);
	return redactInlineSecretsNoUrls(parsed.href);
}

export function sourceRefFor(url: string, text: string): string {
	return `wsrc_${hashString(`${sourceUrlCacheKey(url)}\0${text}`).slice(0, 32)}`;
}

export function sourceUrlCacheKey(url: string): string {
	return `urlkey_${hashString(canonicalUrlForCache(url)).slice(0, 32)}`;
}

function sourceUrlDisplayCacheKey(url: string): string {
	let parsed: URL;
	try {
		parsed = new URL(sanitizeUrlForModel(url));
	} catch {
		return sanitizeUrlForModel(url).trim();
	}
	parsed.hash = shouldKeepFragmentForCache(parsed.hash) ? parsed.hash : "";
	parsed.hostname = parsed.hostname.toLowerCase();
	if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
		parsed.pathname = parsed.pathname.slice(0, -1);
	}
	const sortedParams = [...parsed.searchParams.entries()].sort(
		([left], [right]) => left.localeCompare(right),
	);
	parsed.search = "";
	for (const [key, value] of sortedParams) {
		parsed.searchParams.append(key, value);
	}
	return parsed.href;
}

function canonicalUrlForCache(url: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return url.trim();
	}
	parsed.hostname = parsed.hostname.toLowerCase();
	parsed.hash = shouldKeepFragmentForCache(parsed.hash) ? parsed.hash : "";
	if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
		parsed.pathname = parsed.pathname.slice(0, -1);
	}
	const sortedParams = [...parsed.searchParams.entries()].sort(
		([left], [right]) => left.localeCompare(right),
	);
	parsed.search = "";
	for (const [key, value] of sortedParams) {
		parsed.searchParams.append(key, value);
	}
	return parsed.href;
}

export function createWorkflowWebSource(options: {
	config: WorkflowWebSourceCacheConfig;
	url: string;
	text: string;
	title?: string;
	provider?: string;
	provenance?: WorkflowWebSourceProvenance;
	effectiveUrl?: string;
	aliases?: string[];
	extractionLossy?: boolean;
	metadata?: WorkflowWebSource["metadata"];
}): WorkflowWebSource {
	const checked = validateWorkflowWebUrl(options.url, {
		...DEFAULT_WORKFLOW_WEB_SECURITY_POLICY,
		allowPrivateHosts: true,
	});
	const domain = checked.ok ? checked.domain : "unknown";
	const redactedUrl = sanitizeUrlForModel(options.url);
	const safeText = redactSensitiveWorkflowText(options.text);
	const contentHash = hashString(safeText);
	const provenance = normalizeWorkflowWebSourceProvenance(options.provenance);
	const effective = normalizedSafeSourceIdentity(options.effectiveUrl, options.url);
	const aliases = normalizeSourceAliases(
		[...(effective ? [effective] : []), ...(options.aliases ?? [])],
		options.url,
	);
	return {
		schema: WORKFLOW_WEB_SOURCE_CACHE_SCHEMA,
		sourceRef: sourceRefFor(options.url, safeText),
		createdAt: new Date().toISOString(),
		runId: options.config.runId,
		taskId: options.config.taskId,
		url: redactedUrl,
		redactedUrl,
		urlKey: sourceUrlCacheKey(options.url),
		...(effective ? { effectiveUrl: sanitizeUrlForModel(effective) } : {}),
		...(aliases.length ? { aliases } : {}),
		domain,
		...(options.title ? { title: redactInlineSecrets(options.title) } : {}),
		...(options.provider ? { provider: options.provider } : {}),
		...(provenance ? { provenance } : {}),
		contentHash,
		text: safeText,
		textChars: safeText.length,
		...(options.extractionLossy !== undefined
			? { extractionLossy: options.extractionLossy }
			: {}),
		...(options.metadata ? { metadata: redactSourceMetadata(options.metadata) } : {}),
	};
}

function sanitizeWorkflowWebSourceForPersistence(
	source: WorkflowWebSource,
): WorkflowWebSource {
	const safeText = redactSensitiveWorkflowText(source.text);
	// URL identity fields are persisted independently of the object constructor,
	// so sanitize the requested URL and reject unsafe effective/alias identities
	// here rather than trusting a caller-produced source object.
	const sourceUrl = sanitizeUrlForModel(source.url);
	const redactedUrl = sanitizeUrlForModel(sourceUrl);
	const urlKey =
		typeof source.urlKey === "string" &&
		/^urlkey_[a-f0-9]{32}$/.test(source.urlKey) &&
		/REDACTED/.test(sourceUrl)
			? source.urlKey
			: sourceUrlCacheKey(sourceUrl);
	const effective = normalizedSafeSourceIdentity(source.effectiveUrl, sourceUrl);
	const aliases = normalizeSourceAliases(
		[...(effective ? [effective] : []), ...(source.aliases ?? [])],
		sourceUrl,
	);
	const identityUrl = sourceUrl;
	const safeTitle = source.title === undefined
		? undefined
		: redactInlineSecrets(source.title);
	const safeMetadata = source.metadata === undefined
		? undefined
		: redactSourceMetadata(source.metadata);
	const {
		effectiveUrl: _rawEffectiveUrl,
		aliases: _rawAliases,
		...sourceWithoutUrlAliases
	} = source;
	return {
		...sourceWithoutUrlAliases,
		url: sourceUrl,
		redactedUrl,
		urlKey,
		...(effective ? { effectiveUrl: sanitizeUrlForModel(effective) } : {}),
		...(aliases.length ? { aliases } : {}),
		...(safeTitle === undefined ? {} : { title: safeTitle }),
		...(safeMetadata === undefined ? {} : { metadata: safeMetadata }),
		contentHash: hashString(safeText),
		text: safeText,
		textChars: safeText.length,
		// Preserve the opaque identity produced from an original URL (which may
		// already be redacted in a createWorkflowWebSource result), but repair a
		// direct writer's identity when its text was changed at this boundary.
		sourceRef: safeText === source.text
			? source.sourceRef
			: sourceRefFor(identityUrl, safeText),
	};
}

export async function writeWorkflowWebSource(
	config: WorkflowWebSourceCacheConfig,
	source: WorkflowWebSource,
	signal?: AbortSignal,
): Promise<WorkflowWebSource> {
	// Callers may be direct writers rather than createWorkflowWebSource. Make
	// the persistence boundary authoritative so raw provider text cannot enter
	// an object, index merge, or later read through this API.
	const persistedSource = sanitizeWorkflowWebSourceForPersistence(source);
	const release = await acquireSourceIndexLock(config);
	try {
		signal?.throwIfAborted();
		await ensurePrivateDirectory(resolve(config.cacheDir, "sources"));
		const index = await readWorkflowWebSourceIndex(config);
		const requestedKeys = sourceIdentityKeys(persistedSource);
		source = persistedSource;
		const matching = index.sources
			.filter((entry) =>
				sourceIdentityKeys(entry).some((key) => requestedKeys.includes(key)),
		)
			.sort(compareSourceEntries)[0];
		if (matching) {
			const existing = await readWorkflowWebSource(config, matching.sourceRef);
			if (existing && isDirectSafeWorkflowWebSource(source) &&
				!isDirectSafeWorkflowWebSource(existing)) {
				// A direct-safe refetch is an upgrade, not an ordinary equal-content
				// alias merge.  Keeping the weaker record as the base would discard
				// the validated provenance and could return it on a later lookup.
				const upgraded = mergeSourceAliases(source, existing);
				await writeJsonAtomic(sourceObjectPath(config, upgraded.sourceRef), upgraded, signal);
				const upgradedEntry = sourceToIndexEntry(upgraded);
				signal?.throwIfAborted();
				await appendWorkflowWebSourceIndexEvent(config, upgradedEntry, [matching.sourceRef]);
				signal?.throwIfAborted();
				const sources = mergeSourceIndexEntries([
					...index.sources.filter((entry) =>
						entry.sourceRef !== matching.sourceRef &&
						entry.sourceRef !== upgraded.sourceRef,
					),
					upgradedEntry,
				]);
				await writeJsonAtomic(indexPath(config), {
					...index,
					updatedAt: new Date().toISOString(),
					sources,
				}, signal);
				if (matching.sourceRef !== upgraded.sourceRef)
					await rm(sourceObjectPath(config, matching.sourceRef), { force: true }).catch(() => undefined);
				return upgraded;
			}
			if (existing && existing.contentHash === source.contentHash) {
				const merged = mergeSourceAliases(existing, source);
				if (JSON.stringify(merged) !== JSON.stringify(existing))
					await writeJsonAtomic(sourceObjectPath(config, existing.sourceRef), merged, signal);
				const mergedEntry = sourceToIndexEntry(merged);
				signal?.throwIfAborted();
				await appendWorkflowWebSourceIndexEvent(config, mergedEntry);
				signal?.throwIfAborted();
				await writeJsonAtomic(indexPath(config), {
					...index,
					updatedAt: new Date().toISOString(),
					sources: mergeSourceIndexEntries(
						index.sources.map((entry) =>
							entry.sourceRef === existing.sourceRef ? mergedEntry : entry,
						),
					),
				}, signal);
				return merged;
			}
		}
		await writeJsonAtomic(sourceObjectPath(config, source.sourceRef), source, signal);
		const entry = sourceToIndexEntry(source);
		signal?.throwIfAborted();
		await appendWorkflowWebSourceIndexEvent(config, entry);
		signal?.throwIfAborted();
		const withoutExisting = index.sources.filter(
			(indexEntry) => indexEntry.sourceRef !== source.sourceRef,
		);
		withoutExisting.push(entry);
		await writeJsonAtomic(indexPath(config), {
			...index,
			updatedAt: new Date().toISOString(),
			sources: mergeSourceIndexEntries(withoutExisting),
		}, signal);
		return source;
	} finally {
		await release();
	}
}

export async function readWorkflowWebSource(
	config: WorkflowWebSourceCacheConfig,
	sourceRef: string,
): Promise<WorkflowWebSource | undefined> {
	if (!isWorkflowWebSourceRef(sourceRef)) return undefined;
	try {
		const parsed = JSON.parse(
			await readFile(sourceObjectPath(config, sourceRef), "utf8"),
		) as unknown;
		if (!isRecord(parsed)) return undefined;
		return reconstructPersistedWorkflowWebSource(config, parsed, sourceRef);
	} catch {
		return undefined;
	}
}

function reconstructPersistedWorkflowWebSource(
	config: WorkflowWebSourceCacheConfig,
	value: Record<string, unknown>,
	sourceRef: string,
): WorkflowWebSource | undefined {
	if (value.schema !== WORKFLOW_WEB_SOURCE_CACHE_SCHEMA || value.sourceRef !== sourceRef)
		return undefined;
	if (
		typeof value.createdAt !== "string" ||
		typeof value.runId !== "string" ||
		typeof value.taskId !== "string" ||
		typeof value.url !== "string" ||
		typeof value.text !== "string"
	)
		return undefined;
	const safeText = redactSensitiveWorkflowText(value.text);
	const checked = validatePersistedWorkflowWebUrl(value.url);
	if (!checked) return undefined;
	const normalizedUrl = checked.normalizedUrl;
	const redactedUrl = sanitizeUrlForModel(normalizedUrl);
	const redactedIdentity = persistedUrlContainsRedactedSensitiveQuery(normalizedUrl);
	// A persisted source is an immutable identity record. These fields are
	// redundant by design, so a schema-valid edit must fail closed rather than
	// becoming model-visible metadata.
	if (value.redactedUrl !== undefined && value.redactedUrl !== redactedUrl)
		return undefined;
	// Never hydrate a legacy/tampered object while raw sensitive bytes remain
	// persisted. A writer can migrate it by redacting first and recomputing the
	// source identity; reads fail closed instead of silently leaving the unsafe
	// object available on disk.
	if (safeText !== value.text) return undefined;
	const sanitizedSourceRef = sourceRefFor(normalizedUrl, safeText);
	if (!redactedIdentity && sanitizedSourceRef !== sourceRef)
		return undefined;
	if (!isWorkflowWebSourceRef(sourceRef)) return undefined;
	const contentHash = hashString(safeText);
	const textChars = safeText.length;
	const recomputedUrlKey = sourceUrlCacheKey(normalizedUrl);
	if (value.contentHash !== undefined && value.contentHash !== contentHash)
		return undefined;
	if (value.textChars !== undefined && value.textChars !== textChars)
		return undefined;
	if (!redactedIdentity && value.urlKey !== undefined && value.urlKey !== recomputedUrlKey)
		return undefined;
	const urlKey = redactedIdentity && typeof value.urlKey === "string" && /^urlkey_[a-f0-9]{32}$/.test(value.urlKey)
		? value.urlKey
		: recomputedUrlKey;
	if (value.domain !== undefined && value.domain !== checked.domain &&
		!(redactedIdentity && value.domain === "unknown")) return undefined;
	if (typeof value.domain !== "string" && value.domain !== undefined)
		return undefined;
	const effectiveUrl = normalizedPersistedEffectiveUrl(value.effectiveUrl, normalizedUrl);
	const aliases = normalizedPersistedAliases(value.aliases, normalizedUrl);
	const provenance = value.provenance === undefined
		? undefined
		: normalizeWorkflowWebSourceProvenance(value.provenance);
	if (value.provenance !== undefined && !provenance) return undefined;
	const metadata = normalizePersistedSourceMetadata(value.metadata);
	if (value.metadata !== undefined && !metadata) return undefined;
	if (value.title !== undefined && typeof value.title !== "string") return undefined;
	if (value.provider !== undefined && typeof value.provider !== "string") return undefined;
	return {
		schema: WORKFLOW_WEB_SOURCE_CACHE_SCHEMA,
		sourceRef,
		createdAt: value.createdAt,
		runId: value.runId,
		taskId: value.taskId,
		url: redactedUrl,
		redactedUrl,
		urlKey,
		...(effectiveUrl ? { effectiveUrl } : {}),
		...(aliases.length ? { aliases } : {}),
		domain: checked.domain,
		...(typeof value.title === "string"
			? { title: redactInlineSecrets(value.title) }
			: {}),
		...(typeof value.provider === "string" ? { provider: value.provider } : {}),
		...(provenance ? { provenance } : {}),
		contentHash,
		text: safeText,
		textChars,
		...(typeof value.extractionLossy === "boolean"
			? { extractionLossy: value.extractionLossy }
			: {}),
		...(metadata ? { metadata } : {}),
	};
}

function redactSourceMetadata(
	value: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean | null> {
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [
		key,
		isSensitiveWorkflowQueryKey(key)
			? "REDACTED"
			: typeof item === "string" ? redactInlineSecrets(item) : item,
	])) as Record<string, string | number | boolean | null>;
}

function normalizePersistedSourceMetadata(
	value: unknown,
): Record<string, string | number | boolean | null> | undefined {
	if (!isRecord(value)) return value === undefined ? undefined : undefined;
	const metadata: Record<string, string | number | boolean | null> = {};
	for (const [key, item] of Object.entries(value)) {
		if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(key)) return undefined;
		if (isSensitiveWorkflowQueryKey(key)) metadata[key] = "REDACTED";
		else if (typeof item === "string") metadata[key] = redactInlineSecrets(item);
		else if (typeof item === "number" && Number.isFinite(item)) metadata[key] = item;
		else if (typeof item === "boolean" || item === null) metadata[key] = item;
		else return undefined;
	}
	return metadata;
}

export async function readWorkflowWebSourceIndex(
	config: WorkflowWebSourceCacheConfig,
): Promise<WorkflowWebSourceIndex> {
	const base = await readWorkflowWebSourceIndexFile(config);
	const ledger = await readWorkflowWebSourceIndexLedger(config);
	if (ledger.entries.length === 0 && ledger.removedSourceRefs.size === 0) return base;
	return {
		...base,
		updatedAt: new Date().toISOString(),
		sources: mergeSourceIndexEntries([
			...base.sources.filter((entry) => !ledger.removedSourceRefs.has(entry.sourceRef)),
			...ledger.entries,
		]),
	};
}

export async function findWorkflowWebSourceByUrl(
	config: WorkflowWebSourceCacheConfig,
	url: string,
): Promise<WorkflowWebSource | undefined> {
	const redactedUrl = sanitizeUrlForModel(url);
	const targetKey = sourceUrlCacheKey(url);
	const targetDisplayKey = sourceUrlDisplayCacheKey(redactedUrl);
	const index = await readWorkflowWebSourceIndex(config);
	// The index is an accelerator, not an authority: validate the immutable
	// source object before accepting an index match. This prevents a tampered
	// urlKey/URL row from redirecting a lookup to another valid source.
	for (const entry of [...index.sources].reverse()) {
		if (!sourceIndexEntryMatchesUrl(entry, url, redactedUrl, targetKey, targetDisplayKey))
			continue;
		const source = await readWorkflowWebSource(config, entry.sourceRef);
		if (!source) continue;
		if (sourceIdentityKeys(source).includes(targetKey) ||
			(!redactedUrlIdentityUnsafe(redactedUrl) &&
				(source.redactedUrl === redactedUrl ||
					sourceUrlDisplayCacheKey(source.redactedUrl) === targetDisplayKey)))
			return source;
	}
	return findWorkflowWebSourceByUrlFromSources(
		config,
		url,
		redactedUrl,
		targetKey,
		targetDisplayKey,
	);
}

function normalizedSafeSourceIdentity(
	value: string | undefined,
	requestedUrl: string,
): string | undefined {
	if (!value) return undefined;
	const checked = validateWorkflowWebUrl(value, {
		...DEFAULT_WORKFLOW_WEB_SECURITY_POLICY,
		allowPrivateHosts: true,
	});
	if (!checked.ok || sourceUrlCacheKey(checked.normalizedUrl) === sourceUrlCacheKey(requestedUrl)) {
		return undefined;
	}
	// A redacted fragment or query is evidence that the alias was not safe to
	// retain as an identity. Do not persist a lossy alias that cannot be looked
	// up without exposing or guessing a credential.
	if (/REDACTED/.test(sanitizeUrlForModel(checked.normalizedUrl))) return undefined;
	return checked.normalizedUrl;
}

function sourceIdentityKeys(
	entry: Pick<WorkflowWebSource, "urlKey" | "effectiveUrl" | "aliases">,
): string[] {
	const keys = entry.urlKey ? [entry.urlKey] : [];
	for (const value of [entry.effectiveUrl, ...(entry.aliases ?? [])]) {
		if (!value || redactedUrlIdentityUnsafe(value)) continue;
		keys.push(sourceUrlCacheKey(value));
	}
	return [...new Set(keys)];
}

function sourceIndexEntryMatchesUrl(
	entry: WorkflowWebSourceIndexEntry,
	url: string,
	redactedUrl: string,
	targetKey: string,
	targetDisplayKey: string,
): boolean {
	if (sourceIdentityKeys(entry).includes(targetKey)) return true;
	if (
		redactedUrlIdentityUnsafe(redactedUrl) ||
		redactedUrlIdentityUnsafe(entry.redactedUrl) ||
		redactedUrlIdentityUnsafe(entry.url)
	) {
		return false;
	}
	return (
		entry.redactedUrl === redactedUrl ||
		entry.url === url ||
		sourceUrlDisplayCacheKey(entry.redactedUrl) === targetDisplayKey ||
		sourceUrlDisplayCacheKey(entry.url) === targetDisplayKey
	);
}

function redactedUrlIdentityUnsafe(url: string): boolean {
	if (/REDACTED/.test(url)) return true;
	try {
		return hasSensitiveWorkflowQueryKey(new URL(url));
	} catch {
		return true;
	}
}

async function findWorkflowWebSourceByUrlFromSources(
	config: WorkflowWebSourceCacheConfig,
	url: string,
	redactedUrl: string,
	targetKey: string,
	targetDisplayKey: string,
): Promise<WorkflowWebSource | undefined> {
	let entries: string[];
	try {
		entries = await readdir(resolve(config.cacheDir, "sources"));
	} catch {
		return undefined;
	}
	for (const entry of entries.reverse()) {
		if (!entry.endsWith(".json")) continue;
		const sourceRef = entry.slice(0, -".json".length);
		const source = await readWorkflowWebSource(config, sourceRef);
		if (!source) continue;
		if (sourceIdentityKeys(source).includes(targetKey)) return source;
		if (
			redactedUrlIdentityUnsafe(redactedUrl) ||
			redactedUrlIdentityUnsafe(source.redactedUrl) ||
			redactedUrlIdentityUnsafe(source.url)
		) {
			continue;
		}
		if (
			source.redactedUrl === redactedUrl ||
			source.url === url ||
			sourceUrlDisplayCacheKey(source.redactedUrl) === targetDisplayKey ||
			sourceUrlDisplayCacheKey(source.url) === targetDisplayKey
		) {
			return source;
		}
	}
	return undefined;
}

export async function recordWorkflowWebSourceEvent(
	config: WorkflowWebSourceCacheConfig,
	event: string,
	data: Record<string, unknown> = {},
): Promise<void> {
	await appendPrivateFile(
		resolve(config.cacheDir, "events.jsonl"),
		`${JSON.stringify({
			schema: WORKFLOW_WEB_SOURCE_EVENT_SCHEMA,
			at: new Date().toISOString(),
			runId: config.runId,
			taskId: config.taskId,
			event,
			...redactRecordForModel(data),
		})}\n`,
	);
}

export function buildWorkflowWebSourceCard(options: {
	source: WorkflowWebSource;
	policy: WorkflowWebSourcePolicy;
	budget: WorkflowWebVisibleBudget;
	duplicate?: boolean;
}): WorkflowWebSourceCard {
	const previewLimit = options.duplicate
		? options.policy.duplicatePreviewChars
		: options.policy.previewChars;
	const preview = consumeWorkflowWebVisibleBudget(
		options.budget,
		redactInlineSecrets(options.source.text),
		previewLimit,
	);
	const provenance = normalizeWorkflowWebSourceProvenance(
		options.source.provenance,
	);
	const requestedUrl = sanitizeUrlForModel(options.source.url);
	const effectiveUrl = normalizedSafeSourceIdentity(
		options.source.effectiveUrl,
		requestedUrl,
	);
	const aliases = normalizeSourceAliases(
		[...(effectiveUrl ? [effectiveUrl] : []), ...(options.source.aliases ?? [])],
		requestedUrl,
	);
	return {
		sourceRef: options.source.sourceRef,
		url: sanitizeUrlForModel(options.source.redactedUrl || requestedUrl),
		...(effectiveUrl
			? { effectiveUrl: sanitizeUrlForModel(effectiveUrl) }
			: {}),
		...(aliases.length ? { aliases } : {}),
		domain: options.source.domain,
		...(options.source.title ? { title: options.source.title } : {}),
		preview: preview.text,
		textChars: options.source.textChars,
		fullContentCached: true,
		duplicate: Boolean(options.duplicate),
		...(provenance ? { provenance } : {}),
		budget: {
			limit: options.budget.limit,
			used: preview.used,
			remaining: preview.remaining,
			truncated: preview.truncated,
		},
		next: `Use workflow_web_source_read with sourceRef=${options.source.sourceRef} and an exact query for one quote, queries:[...] or reads:[...] to batch several quotes, or claim+terms when the exact quote is unknown. Do not read workflow cache files directly.`,
	};
}

export function readWorkflowWebSourceSnippet(options: {
	source: WorkflowWebSource;
	query?: string;
	claim?: string;
	terms?: string[];
	maxChars: number;
	budget: WorkflowWebVisibleBudget;
}): WorkflowWebSourceReadResult {
	return (
		readWorkflowWebSourceSnippets({
			source: options.source,
			requests: [
				{
					query: options.query,
					claim: options.claim,
					terms: options.terms,
					maxChars: options.maxChars,
				},
			],
			maxChars: options.maxChars,
			budget: options.budget,
		})[0] ?? { status: "not_found", visibleChars: 0 }
	);
}

export function readWorkflowWebSourceSnippets(options: {
	source: WorkflowWebSource;
	requests: WorkflowWebSourceReadRequest[];
	maxChars: number;
	budget: WorkflowWebVisibleBudget;
}): WorkflowWebSourceReadResult[] {
	let normalizedSource: NormalizedSearchText | undefined;
	const getNormalizedSource = () => {
		normalizedSource ??= normalizeForSearch(options.source.text);
		return normalizedSource;
	};
	return options.requests.map((request) =>
		readWorkflowWebSourceSnippetWithCache({
			source: options.source,
			request,
			maxChars: request.maxChars ?? options.maxChars,
			budget: options.budget,
			getNormalizedSource,
		}),
	);
}

export function extractTextFromToolResult(result: unknown): string {
	if (!isRecord(result)) return "";
	const content = result.content;
	if (!Array.isArray(content)) return "";
	return compactStrings(
		content.map((entry) => {
			if (!isRecord(entry)) return "";
			const text = entry.text;
			return typeof text === "string" ? text : "";
		}),
		{ trim: false, unique: false },
	).join("\n\n");
}

export function extractTitleFromToolResult(
	result: unknown,
): string | undefined {
	if (!isRecord(result)) return undefined;
	const details = result.details;
	if (isRecord(details) && typeof details.title === "string")
		return details.title;
	const text = extractTextFromToolResult(result);
	const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
	return heading ? heading.slice(0, 200) : undefined;
}

export function extractSearchCandidateEnvelope(
	result: unknown,
	policy: WorkflowWebSourcePolicy = DEFAULT_WORKFLOW_WEB_SOURCE_POLICY,
): WorkflowWebSearchCandidateEnvelope {
	const text = extractTextFromToolResult(result);
	if (!text.trim()) return emptySearchCandidateEnvelope();
	const details = isRecord(result) && isRecord(result.details)
		? result.details
		: undefined;
	const knownNonCandidateResult = Boolean(
		details &&
			(details.cancelled === true ||
				(typeof details.error === "string" &&
					details.error.trim().length > 0) ||
				nonNegativeInteger(details.successfulQueries) === 0 ||
				nonNegativeInteger(details.totalResults) === 0),
	);
	if (knownNonCandidateResult) return emptySearchCandidateEnvelope();
	const candidatesByUrl = new Map<string, WorkflowWebSearchCandidate>();
	for (const match of text.matchAll(/https?:\/\/[^\s)\]>"']+/g)) {
		const url = match[0];
		const checked = validateWorkflowWebUrl(url, {
			...DEFAULT_WORKFLOW_WEB_SECURITY_POLICY,
			allowPrivateHosts: true,
		});
		if (!checked.ok) continue;
		const sanitizedUrl = sanitizeUrlForModel(url);
		if (candidatesByUrl.has(sanitizedUrl)) continue;
		candidatesByUrl.set(sanitizedUrl, {
			url: sanitizedUrl,
			domain: checked.domain,
			snippet: redactInlineSecrets(
				nearbySnippet(text, url, policy.searchSnippetChars),
			),
		});
	}
	const allCandidates = [...candidatesByUrl.values()];
	if (allCandidates.length === 0) {
		allCandidates.push({
			snippet: redactInlineSecrets(
				text.trim().slice(0, policy.searchSnippetChars),
			),
		});
	}
	const candidates = allCandidates.slice(0, WORKFLOW_WEB_SEARCH_CANDIDATE_LIMIT);
	return {
		candidates,
		candidateCountTotal: allCandidates.length,
		candidateCountReturned: candidates.length,
		candidateTruncated: allCandidates.length > candidates.length,
	};
}

export function extractSearchCandidates(
	result: unknown,
	policy: WorkflowWebSourcePolicy = DEFAULT_WORKFLOW_WEB_SOURCE_POLICY,
): WorkflowWebSearchCandidate[] {
	return extractSearchCandidateEnvelope(result, policy).candidates;
}

function emptySearchCandidateEnvelope(): WorkflowWebSearchCandidateEnvelope {
	return {
		candidates: [],
		candidateCountTotal: 0,
		candidateCountReturned: 0,
		candidateTruncated: false,
	};
}

export function toolResultFromJson(value: unknown): {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
} {
	return {
		content: [{ type: "text", text: `${JSON.stringify(value)}\n` }],
		details: { workflowWebSource: true },
	};
}

export function errorToolResult(
	code: string,
	message: string,
	extra: Record<string, unknown> = {},
): ReturnType<typeof toolResultFromJson> {
	return toolResultFromJson({ status: "blocked", code, message, ...extra });
}

function shouldKeepFragmentForCache(hash: string): boolean {
	if (!hash) return false;
	const raw = hash.startsWith("#") ? hash.slice(1) : hash;
	return raw.startsWith("/") || raw.startsWith("!") || raw.includes("?");
}

function sourceToIndexEntry(
	source: WorkflowWebSource,
): WorkflowWebSourceIndexEntry {
	const provenance = normalizeWorkflowWebSourceProvenance(source.provenance);
	return {
		sourceRef: source.sourceRef,
		createdAt: source.createdAt,
		url: source.url,
		redactedUrl: source.redactedUrl,
		...(source.urlKey ? { urlKey: source.urlKey } : {}),
		...(source.effectiveUrl ? { effectiveUrl: source.effectiveUrl } : {}),
		...(source.aliases?.length ? { aliases: source.aliases } : {}),
		domain: source.domain,
		...(source.title ? { title: redactInlineSecrets(source.title) } : {}),
		contentHash: source.contentHash,
		textChars: source.textChars,
		...(source.provider ? { provider: source.provider } : {}),
		...(provenance ? { provenance } : {}),
	};
}

type NormalizedSearchText = ReturnType<typeof normalizeForSearch>;

function readWorkflowWebSourceSnippetWithCache(options: {
	source: WorkflowWebSource;
	request: WorkflowWebSourceReadRequest;
	maxChars: number;
	budget: WorkflowWebVisibleBudget;
	getNormalizedSource: () => NormalizedSearchText;
}): WorkflowWebSourceReadResult {
	const query = redactSensitiveWorkflowText(options.request.query?.trim() ?? "");
	if (query) {
		const exactIndex = options.source.text.indexOf(query);
		if (exactIndex >= 0) {
			return snippetForMatch({
				text: options.source.text,
				start: exactIndex,
				end: exactIndex + query.length,
				matchType: "exact",
				maxChars: options.maxChars,
				budget: options.budget,
			});
		}
		const sourceNorm = options.getNormalizedSource();
		const queryNorm = normalizeForSearch(query);
		const normalizedIndex = sourceNorm.normalized.indexOf(queryNorm.normalized);
		if (normalizedIndex >= 0) {
			const start = sourceNorm.map[normalizedIndex] ?? 0;
			const endMapIndex = Math.min(
				sourceNorm.map.length - 1,
				normalizedIndex + Math.max(0, queryNorm.normalized.length - 1),
			);
			const end = (sourceNorm.map[endMapIndex] ?? start) + 1;
			return snippetForMatch({
				text: options.source.text,
				start,
				end,
				matchType: "normalized",
				maxChars: options.maxChars,
				budget: options.budget,
			});
		}
	}
	const termNeedles = prepareTermNeedles(
		options.request.terms,
		options.request.claim,
	);
	if (termNeedles.length === 0) return { status: "not_found", visibleChars: 0 };
	return snippetForTerms({
		text: options.source.text,
		normalizedSource: options.getNormalizedSource(),
		terms: termNeedles,
		maxChars: options.maxChars,
		budget: options.budget,
	});
}

function snippetForTerms(options: {
	text: string;
	normalizedSource: NormalizedSearchText;
	terms: string[];
	maxChars: number;
	budget: WorkflowWebVisibleBudget;
}): WorkflowWebSourceReadResult {
	const needles = options.terms
		.map((term) => ({
			raw: term,
			normalized: normalizeForSearch(term).normalized,
		}))
		.filter((term) => term.normalized.length > 0);
	if (needles.length === 0) return { status: "not_found", visibleChars: 0 };
	const candidates: Array<{
		start: number;
		end: number;
		anchorStart: number;
		anchorEnd: number;
		matchedTerms: string[];
		missingTerms: string[];
		score: number;
	}> = [];
	for (const needle of needles) {
		let fromIndex = 0;
		let occurrenceCount = 0;
		while (occurrenceCount < 20) {
			const normalizedIndex = options.normalizedSource.normalized.indexOf(
				needle.normalized,
				fromIndex,
			);
			if (normalizedIndex < 0) break;
			const start = options.normalizedSource.map[normalizedIndex] ?? 0;
			const endMapIndex = Math.min(
				options.normalizedSource.map.length - 1,
				normalizedIndex + Math.max(0, needle.normalized.length - 1),
			);
			const end = (options.normalizedSource.map[endMapIndex] ?? start) + 1;
			candidates.push(
				scoreTermWindow(options.text, start, end, options.maxChars, needles),
			);
			fromIndex = normalizedIndex + Math.max(1, needle.normalized.length);
			occurrenceCount += 1;
		}
	}
	if (candidates.length === 0) return { status: "not_found", visibleChars: 0 };
	const best = candidates.sort((left, right) => {
		if (right.score !== left.score) return right.score - left.score;
		return right.matchedTerms.length - left.matchedTerms.length;
	})[0]!;
	const consumed = consumeAnchoredSnippet({
		text: options.text,
		anchorStart: best.anchorStart,
		anchorEnd: best.anchorEnd,
		maxChars: options.maxChars,
		budget: options.budget,
	});
	const returnedWindowNorm = normalizeForSearch(
		options.text.slice(consumed.sourceStart, consumed.sourceEnd),
	).normalized;
	const matchedTerms = needles
		.filter((term) => returnedWindowNorm.includes(term.normalized))
		.map((term) => term.raw);
	const missingTerms = needles
		.filter((term) => !returnedWindowNorm.includes(term.normalized))
		.map((term) => term.raw);
	return {
		status: consumed.status,
		matchType: "terms",
		quote: consumed.quote || undefined,
		startOffset: consumed.sourceStart,
		endOffset: consumed.sourceEnd,
		visibleChars: consumed.visibleChars,
		matchedTerms,
		missingTerms,
		coverageRatio: matchedTerms.length / Math.max(1, needles.length),
		candidateOnly: true,
		truncated: consumed.truncated || undefined,
	};
}

function scoreTermWindow(
	text: string,
	matchStart: number,
	matchEnd: number,
	maxChars: number,
	terms: Array<{ raw: string; normalized: string }>,
): {
	start: number;
	end: number;
	matchedTerms: string[];
	missingTerms: string[];
	score: number;
	anchorStart: number;
	anchorEnd: number;
} {
	const center = Math.floor((matchStart + matchEnd) / 2);
	const start = Math.max(0, center - Math.floor(maxChars / 2));
	const end = Math.min(text.length, start + maxChars);
	const windowNorm = normalizeForSearch(text.slice(start, end)).normalized;
	const matchedTerms = terms
		.filter((term) => windowNorm.includes(term.normalized))
		.map((term) => term.raw);
	const missingTerms = terms
		.filter((term) => !windowNorm.includes(term.normalized))
		.map((term) => term.raw);
	const occurrenceScore = terms.reduce((score, term) => {
		return (
			score +
			(windowNorm.includes(term.normalized) ? term.normalized.length : 0)
		);
	}, 0);
	return {
		start,
		end,
		anchorStart: matchStart,
		anchorEnd: matchEnd,
		matchedTerms,
		missingTerms,
		score: matchedTerms.length * 1_000 + occurrenceScore,
	};
}

function prepareTermNeedles(
	terms: string[] | undefined,
	claim: string | undefined,
): string[] {
	const explicitTerms = dedupeStrings(
		(terms ?? []).map((term) => redactSensitiveWorkflowText(term.trim())).filter(Boolean),
	);
	if (explicitTerms.length > 0)
		return explicitTerms.slice(0, WORKFLOW_WEB_SOURCE_TERM_LIMIT);
	if (!claim?.trim()) return [];
	return extractClaimTerms(redactSensitiveWorkflowText(claim)).slice(0, WORKFLOW_WEB_SOURCE_TERM_LIMIT);
}

function extractClaimTerms(claim: string): string[] {
	const tokens =
		claim
			.match(/[\p{L}\p{N}][\p{L}\p{N}._/-]{2,}/gu)
			?.map((token) => token.toLowerCase()) ?? [];
	const filtered = tokens.filter((token) => !SOURCE_READ_STOPWORDS.has(token));
	return dedupeStrings(filtered).sort(
		(left, right) => right.length - left.length,
	);
}

function dedupeStrings(values: string[]): string[] {
	const seen = new Set<string>();
	const deduped: string[] = [];
	for (const value of values) {
		const key = normalizeForSearch(value).normalized;
		if (!key || seen.has(key)) continue;
		seen.add(key);
		deduped.push(value);
	}
	return deduped;
}

const SOURCE_READ_STOPWORDS = new Set([
	"about",
	"across",
	"after",
	"against",
	"also",
	"because",
	"before",
	"between",
	"claim",
	"claims",
	"could",
	"does",
	"from",
	"have",
	"into",
	"more",
	"must",
	"only",
	"other",
	"over",
	"should",
	"source",
	"sources",
	"than",
	"that",
	"their",
	"there",
	"these",
	"this",
	"through",
	"under",
	"using",
	"when",
	"where",
	"which",
	"with",
	"without",
]);

function snippetForMatch(options: {
	text: string;
	start: number;
	end: number;
	matchType: "exact" | "normalized";
	maxChars: number;
	budget: WorkflowWebVisibleBudget;
}): WorkflowWebSourceReadResult {
	const consumed = consumeAnchoredSnippet({
		text: options.text,
		anchorStart: options.start,
		anchorEnd: options.end,
		maxChars: options.maxChars,
		budget: options.budget,
	});
	return {
		status: consumed.status,
		matchType: options.matchType,
		quote: consumed.quote || undefined,
		startOffset: options.start,
		endOffset: options.end,
		visibleChars: consumed.visibleChars,
		truncated: consumed.truncated || undefined,
	};
}

type AnchoredSnippetResult = {
	status: "matched" | "truncated";
	quote: string;
	visibleChars: number;
	sourceStart: number;
	sourceEnd: number;
	truncated: boolean;
};

function consumeAnchoredSnippet(options: {
	text: string;
	anchorStart: number;
	anchorEnd: number;
	maxChars: number;
	budget: WorkflowWebVisibleBudget;
}): AnchoredSnippetResult {
	const maxChars = Math.max(0, Math.floor(options.maxChars));
	const remainingBefore = Math.max(
		0,
		options.budget.limit - options.budget.used,
	);
	const visibleLimit = Math.max(0, Math.min(maxChars, remainingBefore));
	const anchorStart = Math.max(
		0,
		Math.min(options.text.length, Math.floor(options.anchorStart)),
	);
	const anchorEnd = Math.max(
		anchorStart,
		Math.min(options.text.length, Math.floor(options.anchorEnd)),
	);
	const anchorLength = Math.max(0, anchorEnd - anchorStart);
	if (visibleLimit <= 0) {
		return {
			status: "truncated",
			quote: "",
			visibleChars: 0,
			sourceStart: anchorStart,
			sourceEnd: anchorStart,
			truncated: true,
		};
	}

	let sourceStart: number;
	let sourceEnd: number;
	let status: "matched" | "truncated" = "matched";
	if (anchorLength > visibleLimit) {
		sourceStart = anchorStart;
		sourceEnd = Math.min(options.text.length, sourceStart + visibleLimit);
		status = "truncated";
	} else {
		const slack = Math.max(0, visibleLimit - anchorLength);
		sourceStart = Math.max(0, anchorStart - Math.floor(slack / 2));
		sourceEnd = Math.min(options.text.length, sourceStart + visibleLimit);
		if (sourceEnd < anchorEnd) {
			sourceEnd = anchorEnd;
			sourceStart = Math.max(0, sourceEnd - visibleLimit);
		} else if (sourceEnd === options.text.length) {
			sourceStart = Math.max(0, sourceEnd - visibleLimit);
		}
	}

	const raw = redactInlineSecrets(options.text.slice(sourceStart, sourceEnd));
	const consumed = consumeWorkflowWebVisibleBudget(
		options.budget,
		raw,
		visibleLimit,
	);
	// Redaction can expand secrets. Promote only when the redacted anchor
	// itself no longer fits; clipping trailing context can remain a match.
	const redactedThroughAnchorLength = consumed.truncated
		? redactInlineSecrets(
				options.text.slice(sourceStart, Math.min(sourceEnd, anchorEnd)),
			).length
		: 0;
	const anchorTruncated =
		status === "truncated" || redactedThroughAnchorLength > visibleLimit;
	const truncated = status === "truncated" || consumed.truncated;
	return {
		status: anchorTruncated ? "truncated" : status,
		quote: consumed.text,
		visibleChars: consumed.text.length,
		sourceStart,
		sourceEnd,
		truncated,
	};
}

function normalizeForSearch(text: string): {
	normalized: string;
	map: number[];
} {
	let normalized = "";
	const map: number[] = [];
	let previousWhitespace = false;
	for (let index = 0; index < text.length; index += 1) {
		const raw = text[index]!;
		let folded = raw.normalize("NFKC").toLowerCase();
		folded = folded
			.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
			.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
			.replace(/[\u2010-\u2015\u2212]/g, "-");
		if (/\s/.test(folded)) {
			if (!previousWhitespace) {
				normalized += " ";
				map.push(index);
			}
			previousWhitespace = true;
			continue;
		}
		previousWhitespace = false;
		for (const char of folded) {
			normalized += char;
			map.push(index);
		}
	}
	while (normalized.startsWith(" ")) {
		normalized = normalized.slice(1);
		map.shift();
	}
	while (normalized.endsWith(" ")) {
		normalized = normalized.slice(0, -1);
		map.pop();
	}
	return { normalized, map };
}

function nearbySnippet(text: string, needle: string, maxChars: number): string {
	const index = text.indexOf(needle);
	if (index < 0) return text.trim().slice(0, maxChars);
	const start = Math.max(0, index - Math.floor(maxChars / 2));
	return text.slice(start, start + maxChars).trim();
}

async function readWorkflowWebSourceIndexFile(
	config: WorkflowWebSourceCacheConfig,
): Promise<WorkflowWebSourceIndex> {
	try {
		const parsed = JSON.parse(
			await readFile(indexPath(config), "utf8"),
		) as unknown;
		if (
			!isRecord(parsed) ||
			parsed.schema !== WORKFLOW_WEB_SOURCE_INDEX_SCHEMA
		) {
			throw new Error("invalid index");
		}
		const sources = Array.isArray(parsed.sources)
			? parsed.sources.flatMap((entry) => {
					const normalized = sourceIndexEntryFromUnknown(entry);
					return normalized ? [normalized] : [];
				})
			: [];
		return {
			schema: WORKFLOW_WEB_SOURCE_INDEX_SCHEMA,
			updatedAt:
				typeof parsed.updatedAt === "string"
					? parsed.updatedAt
					: new Date().toISOString(),
			runId: typeof parsed.runId === "string" ? parsed.runId : config.runId,
			sources: mergeSourceIndexEntries(sources),
		};
	} catch {
		return emptyWorkflowWebSourceIndex(config);
	}
}

async function appendWorkflowWebSourceIndexEvent(
	config: WorkflowWebSourceCacheConfig,
	entry: WorkflowWebSourceIndexEntry,
	removedSourceRefs: readonly string[] = [],
): Promise<void> {
	await appendPrivateFile(
		indexEventsPath(config),
		`${JSON.stringify({
			schema: WORKFLOW_WEB_SOURCE_INDEX_EVENT_SCHEMA,
			at: new Date().toISOString(),
			runId: config.runId,
			taskId: config.taskId,
			...(removedSourceRefs.length ? { removedSourceRefs } : {}),
			entry,
		})}\n`,
	);
}

async function readWorkflowWebSourceIndexLedger(
	config: WorkflowWebSourceCacheConfig,
): Promise<{
	entries: WorkflowWebSourceIndexEntry[];
	removedSourceRefs: ReadonlySet<string>;
}> {
	let text: string;
	try {
		text = await readFile(indexEventsPath(config), "utf8");
	} catch {
		return { entries: [], removedSourceRefs: new Set() };
	}
	const entries = new Map<string, WorkflowWebSourceIndexEntry>();
	const removed = new Set<string>();
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as unknown;
			if (
				!isRecord(parsed) ||
				parsed.schema !== WORKFLOW_WEB_SOURCE_INDEX_EVENT_SCHEMA
			)
				continue;
			if (Array.isArray(parsed.removedSourceRefs)) {
				for (const sourceRef of parsed.removedSourceRefs) {
					if (typeof sourceRef !== "string" || !isWorkflowWebSourceRef(sourceRef)) continue;
					removed.add(sourceRef);
					entries.delete(sourceRef);
				}
			}
			const entry = sourceIndexEntryFromUnknown(parsed.entry);
			if (entry) {
				// An upgrade event may remove and re-add the same sourceRef. The
				// event's entry is authoritative after its removal list.
				removed.delete(entry.sourceRef);
				entries.set(entry.sourceRef, entry);
			}
		} catch {
			// Ignore torn or corrupt ledger lines; source file scan still provides a final fallback.
		}
	}
	return {
		entries: [...entries.values()].filter((entry) => !removed.has(entry.sourceRef)),
		removedSourceRefs: removed,
	};
}

function sourceIndexEntryFromUnknown(
	value: unknown,
): WorkflowWebSourceIndexEntry | undefined {
	if (!isRecord(value)) return undefined;
	if (
		typeof value.sourceRef !== "string" ||
		!isWorkflowWebSourceRef(value.sourceRef)
	)
		return undefined;
	if (typeof value.createdAt !== "string") return undefined;
	if (typeof value.url !== "string") return undefined;
	const checked = validatePersistedWorkflowWebUrl(value.url);
	if (!checked) return undefined;
	const normalizedUrl = checked.normalizedUrl;
	const redactedUrl = sanitizeUrlForModel(normalizedUrl);
	const redactedIdentity = persistedUrlContainsRedactedSensitiveQuery(normalizedUrl);
	if (value.redactedUrl !== undefined && value.redactedUrl !== redactedUrl)
		return undefined;
	if (value.domain !== undefined && value.domain !== checked.domain &&
		!(redactedIdentity && value.domain === "unknown")) return undefined;
	if (typeof value.contentHash !== "string") return undefined;
	if (typeof value.textChars !== "number" || !Number.isSafeInteger(value.textChars) || value.textChars < 0) return undefined;
	const urlKey = sourceUrlCacheKey(normalizedUrl);
	if (!redactedIdentity && value.urlKey !== undefined && value.urlKey !== urlKey) return undefined;
	const provenance = value.provenance === undefined
		? undefined
		: normalizeWorkflowWebSourceProvenance(value.provenance);
	if (value.provenance !== undefined && !provenance) return undefined;
	return {
		sourceRef: value.sourceRef,
		createdAt: value.createdAt,
		url: redactedUrl,
		redactedUrl,
		urlKey,
		...(normalizedPersistedEffectiveUrl(value.effectiveUrl, normalizedUrl)
			? { effectiveUrl: normalizedPersistedEffectiveUrl(value.effectiveUrl, normalizedUrl) }
			: {}),
		...(normalizedPersistedAliases(value.aliases, normalizedUrl).length
			? { aliases: normalizedPersistedAliases(value.aliases, normalizedUrl) }
			: {}),
		domain: checked.domain,
		...(typeof value.title === "string"
			? { title: redactInlineSecrets(value.title) }
			: {}),
		contentHash: value.contentHash,
		textChars: value.textChars as number,
		...(typeof value.provider === "string" ? { provider: value.provider } : {}),
		...(provenance ? { provenance } : {}),
	};
}

function validatePersistedWorkflowWebUrl(
	value: string,
): { normalizedUrl: string; domain: string } | undefined {
	const ordinary = validateWorkflowWebUrl(value, {
		...DEFAULT_WORKFLOW_WEB_SECURITY_POLICY,
		allowPrivateHosts: true,
	});
	if (ordinary.ok) return ordinary;
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return undefined;
	}
	if (
		parsed.protocol !== "http:" &&
		parsed.protocol !== "https:"
	) return undefined;
	if (parsed.username || parsed.password || !persistedUrlContainsRedactedSensitiveQuery(parsed.href))
		return undefined;
	for (const key of [...parsed.searchParams.keys()]) {
		if (isSensitiveWorkflowQueryKey(key) && parsed.searchParams.getAll(key).some((item) => item !== "REDACTED"))
			return undefined;
	}
	const safeQuery = new URL(parsed.href);
	for (const key of [...safeQuery.searchParams.keys()]) {
		if (isSensitiveWorkflowQueryKey(key)) safeQuery.searchParams.delete(key);
	}
	const hostCheck = validateWorkflowWebUrl(safeQuery.href, {
		...DEFAULT_WORKFLOW_WEB_SECURITY_POLICY,
		allowPrivateHosts: true,
	});
	return hostCheck.ok ? { normalizedUrl: parsed.href, domain: hostCheck.domain } : undefined;
}

function persistedUrlContainsRedactedSensitiveQuery(url: string): boolean {
	try {
		const parsed = new URL(url);
		return [...parsed.searchParams.keys()].some((key) =>
			isSensitiveWorkflowQueryKey(key) && parsed.searchParams.getAll(key).every((item) => item === "REDACTED"),
		);
	} catch {
		return false;
	}
}

function normalizedPersistedEffectiveUrl(
	value: unknown,
	requestedUrl: string,
): string | undefined {
	return typeof value === "string"
		? normalizedSafeSourceIdentity(value, requestedUrl)
		: undefined;
}

function normalizedPersistedAliases(value: unknown, requestedUrl: string): string[] {
	if (!Array.isArray(value)) return [];
	const aliases: string[] = [];
	for (const item of value.slice(0, 10)) {
		if (typeof item !== "string") continue;
		const normalized = normalizedSafeSourceIdentity(item, requestedUrl);
		if (normalized) aliases.push(sanitizeUrlForModel(normalized));
	}
	return [...new Set(aliases)];
}

function normalizeSourceAliases(
	values: readonly string[],
	requestedUrl: string,
): string[] {
	const aliases = new Map<string, string>();
	for (const value of values.slice(0, 32)) {
		if (typeof value !== "string") continue;
		const normalized = normalizedSafeSourceIdentity(value, requestedUrl);
		if (!normalized || redactedUrlIdentityUnsafe(normalized)) continue;
		aliases.set(sourceUrlCacheKey(normalized), sanitizeUrlForModel(normalized));
	}
	return [...aliases.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.slice(0, 10)
		.map(([, value]) => value);
}

function isDirectSafeWorkflowWebSource(source: WorkflowWebSource): boolean {
	return source.provenance?.fetcher === WORKFLOW_WEB_DIRECT_FETCHER &&
		source.provenance.policy === WORKFLOW_WEB_DIRECT_FETCH_POLICY;
}

function mergeSourceAliases(
	existing: WorkflowWebSource,
	incoming: WorkflowWebSource,
): WorkflowWebSource {
	// The requested URL is an identity too. When B was written first and a
	// later A→B fetch has equal content, retain A rather than only retaining
	// the redirect target B; otherwise a reload loses the later request alias.
	const aliases = normalizeSourceAliases(
		[
			...(existing.aliases ?? []),
			existing.effectiveUrl ?? "",
			...(incoming.aliases ?? []),
			incoming.effectiveUrl ?? "",
			incoming.url,
		],
		existing.url,
	);
	return {
		...existing,
		...(existing.effectiveUrl || !incoming.effectiveUrl
			? {}
			: { effectiveUrl: incoming.effectiveUrl }),
		...(aliases.length ? { aliases } : {}),
	};
}

function compareSourceEntries(
	left: WorkflowWebSourceIndexEntry,
	right: WorkflowWebSourceIndexEntry,
): number {
	return left.createdAt.localeCompare(right.createdAt) ||
		left.sourceRef.localeCompare(right.sourceRef);
}

function mergeSourceIndexEntries(
	entries: WorkflowWebSourceIndexEntry[],
): WorkflowWebSourceIndexEntry[] {
	const bySourceRef = new Map<string, WorkflowWebSourceIndexEntry>();
	for (const entry of entries) {
		const previous = bySourceRef.get(entry.sourceRef);
		if (!previous) bySourceRef.set(entry.sourceRef, entry);
		else bySourceRef.set(entry.sourceRef, mergeSourceIndexEntry(previous, entry));
	}
	return [...bySourceRef.values()].sort(compareSourceEntries);
}

function mergeSourceIndexEntry(
	left: WorkflowWebSourceIndexEntry,
	right: WorkflowWebSourceIndexEntry,
): WorkflowWebSourceIndexEntry {
	const aliases = normalizeSourceAliases(
		[
			...(left.aliases ?? []),
			...(right.aliases ?? []),
			left.effectiveUrl ?? "",
			right.effectiveUrl ?? "",
			right.url,
		],
		left.url,
	);
	return {
		...left,
		...(left.effectiveUrl || !right.effectiveUrl ? {} : { effectiveUrl: right.effectiveUrl }),
		...(aliases.length ? { aliases } : {}),
	};
}

const SOURCE_INDEX_LOCK_WAIT_MS = 5 * 60_000;

type SourceIndexLockFence = {
	directory: { dev: number; ino: number };
	owner: { dev: number; ino: number };
	ownerId: string;
	generation: string;
};

async function acquireSourceIndexLock(
	config: WorkflowWebSourceCacheConfig,
): Promise<() => Promise<void>> {
	const lockDir = resolve(config.cacheDir, "source-index-lock");
	await ensurePrivateDirectory(config.cacheDir);
	const started = Date.now();
	for (;;) {
		try {
			const generation = randomUUID();
			const ownerId = `${process.pid}:${generation}`;
			await publishPrivateGenerationDirectory(
				lockDir,
				"owner",
				JSON.stringify({ ownerId, generation, pid: process.pid }),
			);
			const [directory, ownerInfo] = await Promise.all([
				lstat(lockDir), lstat(resolve(lockDir, "owner")),
			]);
			const fence: SourceIndexLockFence = {
				directory: { dev: directory.dev, ino: directory.ino },
				owner: { dev: ownerInfo.dev, ino: ownerInfo.ino },
				ownerId, generation,
			};
			return async () => { await releaseSourceIndexLock(lockDir, fence); };
		} catch (error) {
			if (!(["EEXIST", "ENOTEMPTY"] as string[]).includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
			try {
				const info = await lstat(lockDir);
				if (Date.now() - info.mtimeMs > SOURCE_INDEX_LOCK_WAIT_MS)
					await reapStaleSourceIndexLock(lockDir, { dev: info.dev, ino: info.ino });
			} catch { /* another owner released/replaced it */ }
			if (Date.now() - started > SOURCE_INDEX_LOCK_WAIT_MS)
				throw new Error("source_index_lock_timeout");
			await new Promise((resolveSleep) => setTimeout(resolveSleep, 10));
		}
	}
}

async function reapStaleSourceIndexLock(
	lockDir: string,
	observedDirectory: { dev: number; ino: number },
): Promise<void> {
	const ownerPath = resolve(lockDir, "owner");
	try {
		const owner = await lstat(ownerPath);
		const value = JSON.parse(await readFile(ownerPath, "utf8")) as Record<string, unknown>;
		if (!owner.isFile() || typeof value.ownerId !== "string" || typeof value.generation !== "string") return;
		if (typeof value.pid === "number") {
			try { process.kill(value.pid, 0); return; }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") return;
			}
		}
		const guardPath = resolve(lockDir, `.remove-${randomUUID()}`);
		let guard: Awaited<ReturnType<typeof open>> | undefined;
		let guarded = false;
		try {
			guard = await open(guardPath, "wx", 0o600);
			guarded = true;
			const directory = await lstat(lockDir);
			const currentOwner = await lstat(ownerPath);
			const currentValue = JSON.parse(await readFile(ownerPath, "utf8")) as Record<string, unknown>;
			if (directory.dev !== observedDirectory.dev || directory.ino !== observedDirectory.ino ||
				currentOwner.dev !== owner.dev || currentOwner.ino !== owner.ino ||
				currentValue.ownerId !== value.ownerId || currentValue.generation !== value.generation) return;
			const tombstone = `${lockDir}.releasing-${randomUUID()}`;
			await rename(lockDir, tombstone);
			guarded = false;
			await rm(tombstone, { recursive: true, force: true });
		} finally {
			await guard?.close().catch(() => undefined);
			if (guarded) await unlink(guardPath).catch(() => undefined);
		}
	} catch { /* missing, malformed, live, or replaced lock */ }
}

async function releaseSourceIndexLock(
	lockDir: string,
	fence: SourceIndexLockFence,
): Promise<void> {
	try {
		const directory = await lstat(lockDir);
		const ownerPath = resolve(lockDir, "owner");
		const owner = await lstat(ownerPath);
		const contents = await readFile(ownerPath, "utf8");
		const value = JSON.parse(contents) as Record<string, unknown>;
		if (!directory.isDirectory() || directory.dev !== fence.directory.dev || directory.ino !== fence.directory.ino ||
			!owner.isFile() || owner.dev !== fence.owner.dev || owner.ino !== fence.owner.ino ||
			value.ownerId !== fence.ownerId || value.generation !== fence.generation) return;
		const guardPath = resolve(lockDir, `.remove-${randomUUID()}`);
		let guard: Awaited<ReturnType<typeof open>> | undefined;
		let guarded = false;
		try {
			guard = await open(guardPath, "wx", 0o600);
			guarded = true;
			const guardedDirectory = await lstat(lockDir);
			const guardedOwner = await lstat(ownerPath);
			const guardedValue = JSON.parse(await readFile(ownerPath, "utf8")) as Record<string, unknown>;
			if (guardedDirectory.dev !== fence.directory.dev || guardedDirectory.ino !== fence.directory.ino ||
				guardedOwner.dev !== fence.owner.dev || guardedOwner.ino !== fence.owner.ino ||
				guardedValue.ownerId !== fence.ownerId || guardedValue.generation !== fence.generation) return;
			const tombstone = `${lockDir}.releasing-${randomUUID()}`;
			await rename(lockDir, tombstone);
			guarded = false;
			await rm(tombstone, { recursive: true, force: true });
		} finally {
			await guard?.close().catch(() => undefined);
			if (guarded) await unlink(guardPath).catch(() => undefined);
		}
	} catch { /* competing owner/reaper won */ }
}

function emptyWorkflowWebSourceIndex(
	config: WorkflowWebSourceCacheConfig,
): WorkflowWebSourceIndex {
	return {
		schema: WORKFLOW_WEB_SOURCE_INDEX_SCHEMA,
		updatedAt: new Date().toISOString(),
		runId: config.runId,
		sources: [],
	};
}

function indexPath(config: WorkflowWebSourceCacheConfig): string {
	return resolve(config.cacheDir, "index.json");
}

function indexEventsPath(config: WorkflowWebSourceCacheConfig): string {
	return resolve(config.cacheDir, "index-events.jsonl");
}

function sourceObjectPath(
	config: WorkflowWebSourceCacheConfig,
	sourceRef: string,
): string {
	if (!isWorkflowWebSourceRef(sourceRef)) {
		throw new Error("invalid workflow web sourceRef");
	}
	const sourcesDir = resolve(config.cacheDir, "sources");
	const path = resolve(sourcesDir, `${sourceRef}.json`);
	if (!path.startsWith(`${sourcesDir}/`)) {
		throw new Error("workflow web sourceRef escaped source cache");
	}
	return path;
}

function isWorkflowWebSourceRef(sourceRef: string): boolean {
	return /^wsrc_[a-f0-9]{32}$/.test(sourceRef);
}

async function writeJsonAtomic(
	path: string,
	value: unknown,
	signal?: AbortSignal,
): Promise<void> {
	await writePrivateFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, { signal });
}

function hashString(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function isPrivateHostname(host: string): boolean {
	if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(host))) return true;
	return nonPublicIpReason(host) !== undefined;
}

function redactRecordForModel(
	value: Record<string, unknown>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [
			key,
			// Property names are part of the secret policy too.  This matters for
			// nested provider event/metadata objects whose sensitive value is not
			// itself an assignment-shaped string.
			isSensitiveWorkflowQueryKey(key) ? "REDACTED" : redactValueForModel(item),
		]),
	);
}

function redactValueForModel(value: unknown): unknown {
	if (typeof value === "string")
		return redactInlineSecrets(sanitizeUrlMaybe(value));
	if (Array.isArray(value))
		return value.map((item) => redactValueForModel(item));
	if (!isRecord(value)) return value;
	return redactRecordForModel(value);
}

function sanitizeUrlMaybe(value: string): string {
	return /^https?:\/\//i.test(value) ? sanitizeUrlForModel(value) : value;
}

function redactInlineSecrets(value: string): string {
	return redactSensitiveWorkflowText(value);
}

function redactInlineSecretsNoUrls(value: string): string {
	return redactSensitiveWorkflowText(value);
}

function nonNegativeInteger(value: unknown): number | undefined {
	return typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= 0
		? value
		: undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
