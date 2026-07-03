import { createHash } from "node:crypto";
import {
	appendFile,
	mkdir,
	readFile,
	readdir,
	rename,
	writeFile,
} from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, resolve } from "node:path";

export const WORKFLOW_WEB_SOURCE_CACHE_SCHEMA =
	"workflow-web-source-cache-v1" as const;
export const WORKFLOW_WEB_SOURCE_INDEX_SCHEMA =
	"workflow-web-source-index-v1" as const;
export const WORKFLOW_WEB_SOURCE_INDEX_EVENT_SCHEMA =
	"workflow-web-source-index-event-v1" as const;
export const WORKFLOW_WEB_SOURCE_EVENT_SCHEMA =
	"workflow-web-source-event-v1" as const;

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

export interface WorkflowWebSource {
	schema: typeof WORKFLOW_WEB_SOURCE_CACHE_SCHEMA;
	sourceRef: string;
	createdAt: string;
	runId: string;
	taskId: string;
	url: string;
	redactedUrl: string;
	urlKey?: string;
	domain: string;
	title?: string;
	provider?: string;
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
	domain: string;
	title?: string;
	contentHash: string;
	textChars: number;
	provider?: string;
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
	domain: string;
	title?: string;
	preview: string;
	textChars: number;
	fullContentCached: boolean;
	duplicate: boolean;
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

const SENSITIVE_QUERY_PARAM_PATTERN =
	/(^|[-_])(access[-_]?token|auth|code|credential|key|password|secret|session|signature|sig|token)([-_]|$)/i;
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

export function isWorkflowWebSourceTool(
	tool: string,
): tool is WorkflowWebSourceTool {
	return (WORKFLOW_WEB_SOURCE_TOOLS as readonly string[]).includes(tool);
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
		if (SENSITIVE_QUERY_PARAM_PATTERN.test(key)) {
			parsed.searchParams.set(key, "REDACTED");
		}
	}
	parsed.hash = redactUrlFragment(parsed.hash);
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
	extractionLossy?: boolean;
	metadata?: WorkflowWebSource["metadata"];
}): WorkflowWebSource {
	const checked = validateWorkflowWebUrl(options.url, {
		...DEFAULT_WORKFLOW_WEB_SECURITY_POLICY,
		allowPrivateHosts: true,
	});
	const domain = checked.ok ? checked.domain : "unknown";
	const redactedUrl = sanitizeUrlForModel(options.url);
	const contentHash = hashString(options.text);
	return {
		schema: WORKFLOW_WEB_SOURCE_CACHE_SCHEMA,
		sourceRef: sourceRefFor(options.url, options.text),
		createdAt: new Date().toISOString(),
		runId: options.config.runId,
		taskId: options.config.taskId,
		url: redactedUrl,
		redactedUrl,
		urlKey: sourceUrlCacheKey(options.url),
		domain,
		...(options.title ? { title: options.title } : {}),
		...(options.provider ? { provider: options.provider } : {}),
		contentHash,
		text: options.text,
		textChars: options.text.length,
		...(options.extractionLossy !== undefined
			? { extractionLossy: options.extractionLossy }
			: {}),
		...(options.metadata ? { metadata: options.metadata } : {}),
	};
}

export async function writeWorkflowWebSource(
	config: WorkflowWebSourceCacheConfig,
	source: WorkflowWebSource,
): Promise<void> {
	await mkdir(resolve(config.cacheDir, "sources"), { recursive: true });
	await writeJsonAtomic(sourceObjectPath(config, source.sourceRef), source);
	const entry = sourceToIndexEntry(source);
	await appendWorkflowWebSourceIndexEvent(config, entry);
	const index = await readWorkflowWebSourceIndex(config);
	const withoutExisting = index.sources.filter(
		(indexEntry) => indexEntry.sourceRef !== source.sourceRef,
	);
	withoutExisting.push(entry);
	await writeJsonAtomic(indexPath(config), {
		...index,
		updatedAt: new Date().toISOString(),
		sources: mergeSourceIndexEntries(withoutExisting),
	});
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
		if (parsed.schema !== WORKFLOW_WEB_SOURCE_CACHE_SCHEMA) return undefined;
		if (parsed.sourceRef !== sourceRef) return undefined;
		if (typeof parsed.text !== "string") return undefined;
		return parsed as unknown as WorkflowWebSource;
	} catch {
		return undefined;
	}
}

export async function readWorkflowWebSourceIndex(
	config: WorkflowWebSourceCacheConfig,
): Promise<WorkflowWebSourceIndex> {
	const base = await readWorkflowWebSourceIndexFile(config);
	const ledgerEntries = await readWorkflowWebSourceIndexLedger(config);
	if (ledgerEntries.length === 0) return base;
	return {
		...base,
		updatedAt: new Date().toISOString(),
		sources: mergeSourceIndexEntries([...base.sources, ...ledgerEntries]),
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
	const existing = [...index.sources].reverse().find((entry) => {
		return sourceIndexEntryMatchesUrl(
			entry,
			url,
			redactedUrl,
			targetKey,
			targetDisplayKey,
		);
	});
	if (existing) {
		const source = await readWorkflowWebSource(config, existing.sourceRef);
		if (source) return source;
	}
	return findWorkflowWebSourceByUrlFromSources(
		config,
		url,
		redactedUrl,
		targetKey,
		targetDisplayKey,
	);
}

function sourceIndexEntryMatchesUrl(
	entry: WorkflowWebSourceIndexEntry,
	url: string,
	redactedUrl: string,
	targetKey: string,
	targetDisplayKey: string,
): boolean {
	if (entry.urlKey) return entry.urlKey === targetKey;
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
	return (
		/REDACTED/.test(url) ||
		/[?&#][^=]*(?:token|secret|password|signature|sig|key|auth|session|credential)[^=]*=/i.test(
			url,
		)
	);
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
		if (source.urlKey) {
			if (source.urlKey === targetKey) return source;
			continue;
		}
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
	await mkdir(resolve(config.cacheDir), { recursive: true });
	await appendFile(
		resolve(config.cacheDir, "events.jsonl"),
		`${JSON.stringify({
			schema: WORKFLOW_WEB_SOURCE_EVENT_SCHEMA,
			at: new Date().toISOString(),
			runId: config.runId,
			taskId: config.taskId,
			event,
			...redactRecordForModel(data),
		})}\n`,
		"utf8",
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
	return {
		sourceRef: options.source.sourceRef,
		url: options.source.redactedUrl,
		domain: options.source.domain,
		...(options.source.title ? { title: options.source.title } : {}),
		preview: preview.text,
		textChars: options.source.textChars,
		fullContentCached: true,
		duplicate: Boolean(options.duplicate),
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
	return content
		.map((entry) => {
			if (!isRecord(entry)) return "";
			const text = entry.text;
			return typeof text === "string" ? text : "";
		})
		.filter(Boolean)
		.join("\n\n");
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

export function extractSearchCandidates(
	result: unknown,
	policy: WorkflowWebSourcePolicy = DEFAULT_WORKFLOW_WEB_SOURCE_POLICY,
): WorkflowWebSearchCandidate[] {
	const text = extractTextFromToolResult(result);
	if (!text.trim()) return [];
	const urls = [...text.matchAll(/https?:\/\/[^\s)\]>"']+/g)].map(
		(match) => match[0],
	);
	if (urls.length === 0) {
		return [
			{
				snippet: redactInlineSecrets(
					text.trim().slice(0, policy.searchSnippetChars),
				),
			},
		];
	}
	return [...new Set(urls)].slice(0, 10).map((url) => {
		const checked = validateWorkflowWebUrl(url, {
			...DEFAULT_WORKFLOW_WEB_SECURITY_POLICY,
			allowPrivateHosts: true,
		});
		return {
			url: sanitizeUrlForModel(url),
			domain: checked.ok ? checked.domain : undefined,
			snippet: redactInlineSecrets(
				nearbySnippet(text, url, policy.searchSnippetChars),
			),
		};
	});
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

function redactUrlFragment(hash: string): string {
	if (!hash) return "";
	const raw = hash.startsWith("#") ? hash.slice(1) : hash;
	if (!raw) return "";
	try {
		const params = new URLSearchParams(raw);
		let changed = false;
		for (const key of [...params.keys()]) {
			if (SENSITIVE_QUERY_PARAM_PATTERN.test(key)) {
				params.set(key, "REDACTED");
				changed = true;
			}
		}
		if (changed) return `#${params.toString()}`;
	} catch {
		// Fall through to inline redaction.
	}
	const redacted = redactInlineSecrets(raw);
	return redacted ? `#${redacted}` : "";
}

function shouldKeepFragmentForCache(hash: string): boolean {
	if (!hash) return false;
	const raw = hash.startsWith("#") ? hash.slice(1) : hash;
	return raw.startsWith("/") || raw.startsWith("!") || raw.includes("?");
}

function sourceToIndexEntry(
	source: WorkflowWebSource,
): WorkflowWebSourceIndexEntry {
	return {
		sourceRef: source.sourceRef,
		createdAt: source.createdAt,
		url: source.url,
		redactedUrl: source.redactedUrl,
		...(source.urlKey ? { urlKey: source.urlKey } : {}),
		domain: source.domain,
		...(source.title ? { title: source.title } : {}),
		contentHash: source.contentHash,
		textChars: source.textChars,
		...(source.provider ? { provider: source.provider } : {}),
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
	const query = options.request.query?.trim() ?? "";
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
		(terms ?? []).map((term) => term.trim()).filter(Boolean),
	);
	if (explicitTerms.length > 0) return explicitTerms.slice(0, 16);
	if (!claim?.trim()) return [];
	return extractClaimTerms(claim).slice(0, 16);
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
	const truncated = status === "truncated" || consumed.truncated;
	return {
		status,
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
	return { normalized: normalized.trim(), map };
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
): Promise<void> {
	await mkdir(resolve(config.cacheDir), { recursive: true });
	await appendFile(
		indexEventsPath(config),
		`${JSON.stringify({
			schema: WORKFLOW_WEB_SOURCE_INDEX_EVENT_SCHEMA,
			at: new Date().toISOString(),
			runId: config.runId,
			taskId: config.taskId,
			entry,
		})}\n`,
		"utf8",
	);
}

async function readWorkflowWebSourceIndexLedger(
	config: WorkflowWebSourceCacheConfig,
): Promise<WorkflowWebSourceIndexEntry[]> {
	let text: string;
	try {
		text = await readFile(indexEventsPath(config), "utf8");
	} catch {
		return [];
	}
	const entries: WorkflowWebSourceIndexEntry[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as unknown;
			if (
				!isRecord(parsed) ||
				parsed.schema !== WORKFLOW_WEB_SOURCE_INDEX_EVENT_SCHEMA
			)
				continue;
			const entry = sourceIndexEntryFromUnknown(parsed.entry);
			if (entry) entries.push(entry);
		} catch {
			// Ignore torn or corrupt ledger lines; source file scan still provides a final fallback.
		}
	}
	return entries;
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
	if (typeof value.redactedUrl !== "string") return undefined;
	if (typeof value.domain !== "string") return undefined;
	if (typeof value.contentHash !== "string") return undefined;
	if (!Number.isFinite(Number(value.textChars))) return undefined;
	return {
		sourceRef: value.sourceRef,
		createdAt: value.createdAt,
		url: value.url,
		redactedUrl: value.redactedUrl,
		...(typeof value.urlKey === "string" ? { urlKey: value.urlKey } : {}),
		domain: value.domain,
		...(typeof value.title === "string" ? { title: value.title } : {}),
		contentHash: value.contentHash,
		textChars: Number(value.textChars),
		...(typeof value.provider === "string" ? { provider: value.provider } : {}),
	};
}

function mergeSourceIndexEntries(
	entries: WorkflowWebSourceIndexEntry[],
): WorkflowWebSourceIndexEntry[] {
	const bySourceRef = new Map<string, WorkflowWebSourceIndexEntry>();
	for (const entry of entries) bySourceRef.set(entry.sourceRef, entry);
	return [...bySourceRef.values()].sort((left, right) =>
		left.createdAt.localeCompare(right.createdAt),
	);
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

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await rename(tmp, path);
}

function hashString(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function isPrivateHostname(host: string): boolean {
	if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(host))) return true;
	return nonPublicIpReason(host) !== undefined;
}

function nonPublicIpReason(address: string): string | undefined {
	const lower = address.toLowerCase().replace(/^\[|\]$/g, "");
	const mappedIpv4 = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
	if (mappedIpv4) return nonPublicIpReason(mappedIpv4);
	const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
	if (hexMapped) {
		const high = Number.parseInt(hexMapped[1]!, 16);
		const low = Number.parseInt(hexMapped[2]!, 16);
		return nonPublicIpReason(
			`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`,
		);
	}
	if (isIP(lower) === 4) {
		const parts = lower.split(".").map((part) => Number(part));
		if (
			parts.length !== 4 ||
			parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
		)
			return "non_public_ip_blocked";
		const [a, b, c, d] = parts as [number, number, number, number];
		if (a === 0 || a === 10 || a === 127 || a >= 224)
			return "non_public_ip_blocked";
		if (a === 100 && b >= 64 && b <= 127) return "non_public_ip_blocked";
		if (a === 169 && b === 254) return "non_public_ip_blocked";
		if (a === 172 && b >= 16 && b <= 31) return "non_public_ip_blocked";
		if (a === 192 && b === 168) return "non_public_ip_blocked";
		if (a === 192 && b === 0 && (c === 0 || c === 2))
			return "non_public_ip_blocked";
		if (a === 198 && (b === 18 || b === 19)) return "non_public_ip_blocked";
		if (a === 198 && b === 51 && c === 100) return "non_public_ip_blocked";
		if (a === 203 && b === 0 && c === 113) return "non_public_ip_blocked";
		if (a === 255 && b === 255 && c === 255 && d === 255)
			return "non_public_ip_blocked";
	}
	if (isIP(lower) === 6) {
		if (lower === "::" || lower === "::1") return "non_public_ip_blocked";
		if (lower.startsWith("fc") || lower.startsWith("fd"))
			return "non_public_ip_blocked";
		if (lower.startsWith("fe80") || lower.startsWith("ff"))
			return "non_public_ip_blocked";
		if (lower.startsWith("2001:db8")) return "non_public_ip_blocked";
	}
	return undefined;
}

function redactRecordForModel(
	value: Record<string, unknown>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [
			key,
			redactValueForModel(item),
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
	const withSanitizedUrls = value.replace(
		/https?:\/\/[^\s)\]}>"']+/gi,
		(match) => {
			const trailing = match.match(/[.,;:!?]+$/)?.[0] ?? "";
			const core = trailing ? match.slice(0, -trailing.length) : match;
			try {
				return `${sanitizeParsedUrlForModel(new URL(core))}${trailing}`;
			} catch {
				return match;
			}
		},
	);
	return redactInlineSecretsNoUrls(withSanitizedUrls);
}

function redactInlineSecretsNoUrls(value: string): string {
	return value
		.replace(/(authorization|cookie|set-cookie):\s*[^\n\r]+/gi, "$1: REDACTED")
		.replace(/(token|secret|password|api[-_]?key)=([^\s&]+)/gi, "$1=REDACTED")
		.replace(/\/Users\/[^\s:'")]+/g, "/Users/REDACTED");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
