// Deterministic post-processing for deep-review.
//
// Two modes (options.mode):
//   "dedup"     — sources: reviewer foreach outputs ({ lens, findings, ... }).
//                 Flattens findings, normalizes shape, drops duplicates by
//                 (file, normalized title) so the devil-advocate stage verifies
//                 each distinct defect once instead of once per lens.
//   "partition" — sources: dedup output + devil-advocate foreach outputs
//                 ({ finding, verdict, ... }). Normalizes verdict enums,
//                 partitions findings into keep/weaken/drop/needsHuman in code,
//                 and joins reviewer severity back onto KEEP findings so the
//                 report stage cannot silently drop findings or drift severity.
//   "batch-devil-advocate" — opt-in only. Plans deterministic batches of
//                 deduped findings for a batched devil-advocate foreach. The
//                 default deep-review workflow still uses one verifier per
//                 finding.

import fs from "node:fs";
import path from "node:path";

const VERDICTS = ["KEEP", "WEAKEN", "DROP", "NEEDS_HUMAN"];

function asObjects(value) {
	if (Array.isArray(value))
		return value.filter((item) => item && typeof item === "object");
	return [];
}

function findingsOf(source) {
	if (!source || typeof source !== "object") return [];
	if (Array.isArray(source.findings)) return asObjects(source.findings);
	if (Array.isArray(source.dedupedFindings))
		return asObjects(source.dedupedFindings);
	return [];
}

function normalizeText(value) {
	return String(value ?? "")
		.toLowerCase()
		.replace(/[`"'()[\]{}]/g, " ")
		.replace(/[^a-z0-9.:/_$-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

// Extract the most file-like token from evidence/title so dedup keys do not
// depend on prose phrasing.
function fileKeyOf(finding) {
	const candidates = [finding.file, finding.evidence, finding.title]
		.map((value) => String(value ?? ""))
		.join(" ");
	const match = candidates.match(
		/[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|zig|java|rb|c|h|cpp|hpp|json|yaml|yml|md)\b/,
	);
	return match ? match[0].replace(/^\.\//, "") : "";
}

function titleTokens(finding) {
	const stop = new Set([
		"the",
		"a",
		"an",
		"is",
		"are",
		"was",
		"were",
		"of",
		"in",
		"to",
		"for",
		"and",
		"or",
		"with",
		"from",
		"by",
		"on",
		"its",
		"this",
		"that",
		"now",
		"no",
		"longer",
		"test",
		"tests",
		"would",
		"could",
		"should",
		"fail",
		"fails",
		"failure",
		"removed",
		"dropped",
	]);
	return new Set(
		normalizeText(finding.title)
			.split(" ")
			.filter((token) => token.length > 1 && !stop.has(token)),
	);
}

function tokenOverlap(a, b) {
	if (a.size === 0 || b.size === 0) return 0;
	let shared = 0;
	for (const token of a) if (b.has(token)) shared += 1;
	return shared / Math.min(a.size, b.size);
}

const DUPLICATE_OVERLAP = 0.7;

// Identity evidence (file/line/symbol) must survive the LLM reduce stage
// unchanged, so it is carried as structured `locations` rather than left in
// prose. Locations are normalized from the reviewer's explicit `locations`
// array when present, and otherwise reconstructed deterministically from the
// finding's `file` field plus any "line N"/":N" references in its evidence
// text. A location is { file, line?, lineEnd?, symbol? }, so ranges, symbols,
// and multi-site findings extend the same shape without new top-level fields.
function normalizeLocation(raw) {
	if (!raw || typeof raw !== "object") return null;
	const file = String(raw.file ?? "")
		.trim()
		.replace(/^\.\//, "");
	const line = Number.isFinite(Number(raw.line)) ? Number(raw.line) : undefined;
	const lineEnd = Number.isFinite(Number(raw.lineEnd))
		? Number(raw.lineEnd)
		: undefined;
	const symbol =
		raw.symbol != null && String(raw.symbol).trim()
			? String(raw.symbol).trim()
			: undefined;
	if (!file && line === undefined && !symbol) return null;
	const location = {};
	if (file) location.file = file;
	if (line !== undefined) location.line = line;
	if (lineEnd !== undefined) location.lineEnd = lineEnd;
	if (symbol) location.symbol = symbol;
	return location;
}

function dedupeLocations(locations) {
	const seen = new Set();
	const out = [];
	for (const location of locations) {
		if (!location) continue;
		const key = `${location.file ?? ""}|${location.line ?? ""}|${location.lineEnd ?? ""}|${location.symbol ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(location);
	}
	return out;
}

function quoteStrings(value) {
	if (typeof value === "string" && value.trim()) return [value];
	if (Array.isArray(value)) return value.flatMap(quoteStrings);
	if (value && typeof value === "object") {
		if (typeof value.quote === "string" && value.quote.trim())
			return [value.quote];
		return Object.values(value).flatMap(quoteStrings);
	}
	return [];
}

function dedupeStrings(values) {
	const seen = new Set();
	const out = [];
	for (const value of values) {
		const text = String(value ?? "").trim();
		if (!text || seen.has(text)) continue;
		seen.add(text);
		out.push(text);
	}
	return out;
}

function dedupeEvidenceQuotes(values) {
	const seen = new Set();
	const out = [];
	for (const value of values) {
		const text = String(value ?? "");
		if (!text.trim() || seen.has(text)) continue;
		seen.add(text);
		out.push(text);
	}
	return out;
}

function sourceStatusesOf(context) {
	return asObjects(context?.sourceStatuses);
}

function slimSourceStatus(status) {
	return {
		...(status.source ? { source: String(status.source) } : {}),
		...(status.displayName ? { displayName: String(status.displayName) } : {}),
		...(status.taskId ? { taskId: String(status.taskId) } : {}),
		...(status.specId ? { specId: String(status.specId) } : {}),
		...(status.stageId ? { stageId: String(status.stageId) } : {}),
		status: String(status.status ?? "unknown"),
		...(status.statusDetail
			? { statusDetail: String(status.statusDetail) }
			: {}),
		...(status.errorType ? { errorType: String(status.errorType) } : {}),
		...(status.lastMessage
			? { lastMessage: String(status.lastMessage).slice(0, 500) }
			: {}),
	};
}

function sourceStatusKey(status) {
	return `${status.specId ?? ""}|${status.taskId ?? ""}|${status.source ?? ""}|${status.status ?? ""}`;
}

function sourceStatusSummary(statuses) {
	const all = sourceStatusesOf({ sourceStatuses: statuses }).map(
		slimSourceStatus,
	);
	const partialFailures = [];
	const seen = new Set();
	for (const status of all) {
		if (status.status === "completed") continue;
		const key = sourceStatusKey(status);
		if (seen.has(key)) continue;
		seen.add(key);
		partialFailures.push(status);
	}
	return {
		total: all.length,
		completed: all.filter((status) => status.status === "completed").length,
		nonCompleted: partialFailures.length,
		partialFailures,
	};
}

function partialFailuresFromSource(source) {
	return [
		...asObjects(source?.sourceStatusSummary?.partialFailures),
		...asObjects(source?.reportContext?.partialFailures),
	].map(slimSourceStatus);
}

function mergePartialFailures(...groups) {
	const merged = [];
	const seen = new Set();
	for (const group of groups) {
		for (const status of group ?? []) {
			const slim = slimSourceStatus(status);
			if (slim.status === "completed") continue;
			const key = sourceStatusKey(slim);
			if (seen.has(key)) continue;
			seen.add(key);
			merged.push(slim);
		}
	}
	return merged;
}

function mergeSourceStatusSummary(directStatusSummary, partialFailures) {
	const directFailureKeys = new Set(
		asObjects(directStatusSummary?.partialFailures).map((status) =>
			sourceStatusKey(slimSourceStatus(status)),
		),
	);
	const transitiveOnlyFailures = asObjects(partialFailures).filter(
		(status) =>
			!directFailureKeys.has(sourceStatusKey(slimSourceStatus(status))),
	);
	return {
		total:
			Number(directStatusSummary?.total ?? 0) + transitiveOnlyFailures.length,
		completed: Number(directStatusSummary?.completed ?? 0),
		nonCompleted: asObjects(partialFailures).length,
		partialFailures,
	};
}

function evidenceQuotesOf(finding) {
	return dedupeEvidenceQuotes([
		...quoteStrings(finding.evidenceQuotes),
		...quoteStrings(finding.evidenceQuote),
		...quoteStrings(finding.evidence),
	]);
}

// Pull "line 46", "lines 46-90", "L46", or ":46" references out of evidence prose
// so a reviewer that only mentioned the line in text still yields a structured
// location. Bounded to a small count to avoid sweeping unrelated numbers.
function linesFromEvidence(text) {
	const lines = [];
	const re =
		/(?:\blines?\s+~?(\d{1,6})(?:\s*[–-]\s*(\d{1,6}))?|\bL(\d{1,6})\b|:(\d{1,6})(?:[–-](\d{1,6}))?)/gi;
	let match;
	while ((match = re.exec(String(text ?? ""))) !== null && lines.length < 12) {
		const start = Number(match[1] ?? match[3] ?? match[4]);
		const end = Number(match[2] ?? match[5]);
		if (Number.isFinite(start))
			lines.push({
				line: start,
				lineEnd: Number.isFinite(end) ? end : undefined,
			});
	}
	return lines;
}

function locationsOf(finding) {
	const explicit = Array.isArray(finding.locations)
		? finding.locations.map(normalizeLocation).filter(Boolean)
		: [];
	if (explicit.length > 0) return dedupeLocations(explicit);
	// Reconstruct from file + evidence line references when the reviewer did not
	// emit a structured locations array.
	const file = String(finding.file ?? "")
		.trim()
		.replace(/^\.\//, "");
	if (!file) return [];
	const lineRefs = linesFromEvidence(finding.evidence);
	if (lineRefs.length === 0)
		return dedupeLocations([normalizeLocation({ file })]);
	return dedupeLocations(
		lineRefs.map((ref) =>
			normalizeLocation({ file, line: ref.line, lineEnd: ref.lineEnd }),
		),
	);
}

function normalizeFinding(finding, index) {
	const id =
		typeof finding.id === "string" && finding.id
			? finding.id
			: `finding-${String(index + 1).padStart(3, "0")}`;
	return {
		id,
		findingId:
			typeof finding.findingId === "string" && finding.findingId
				? finding.findingId
				: id,
		rootCauseId:
			typeof finding.rootCauseId === "string" && finding.rootCauseId
				? finding.rootCauseId
				: `root-${String(index + 1).padStart(3, "0")}`,
		severity: String(finding.severity ?? "unknown"),
		title: String(finding.title ?? "").trim(),
		file:
			String(finding.file ?? "")
				.trim()
				.replace(/^\.\//, "") || undefined,
		locations: locationsOf(finding),
		evidence: finding.evidence ?? "",
		evidenceQuotes: evidenceQuotesOf(finding),
		rationale: finding.rationale ?? "",
		recommendedAction: finding.recommendedAction ?? "",
		confidence: finding.confidence ?? "unknown",
	};
}

function dedupFindings(sources, context = {}) {
	const flattened = [];
	for (const source of Object.values(sources ?? {})) {
		for (const finding of findingsOf(source)) flattened.push(finding);
	}
	const statusSummary = sourceStatusSummary(sourceStatusesOf(context));
	// Duplicate when two findings share the same file (or both lack one) and
	// their title tokens largely overlap. Deterministic, order-stable: the first
	// occurrence wins unless a later duplicate carries more evidence text.
	const kept = [];
	const duplicates = [];
	for (const finding of flattened) {
		const file = fileKeyOf(finding);
		const tokens = titleTokens(finding);
		const existing = kept.find(
			(candidate) =>
				candidate.file === file &&
				tokenOverlap(candidate.tokens, tokens) >= DUPLICATE_OVERLAP,
		);
		if (!existing) {
			kept.push({ file, tokens, finding });
			continue;
		}
		const incomingEvidence = String(finding.evidence ?? "").length;
		const existingEvidence = String(existing.finding.evidence ?? "").length;
		const dropped =
			incomingEvidence > existingEvidence ? existing.finding : finding;
		if (incomingEvidence > existingEvidence) {
			existing.finding = finding;
			existing.tokens = tokens;
		}
		duplicates.push({
			file,
			keptTitle: String(existing.finding.title ?? ""),
			droppedTitle: String(dropped.title ?? ""),
		});
	}
	const findings = kept.map((entry, index) =>
		normalizeFinding(entry.finding, index),
	);
	return {
		findings,
		digest: `dedup: raw=${flattened.length}, unique=${findings.length}, duplicates=${duplicates.length}, partialFailures=${statusSummary.nonCompleted}`,
		sourceStatusSummary: statusSummary,
		dedupSummary: {
			rawCount: flattened.length,
			uniqueCount: findings.length,
			duplicateCount: duplicates.length,
			duplicates,
		},
	};
}

function findSource(sources, stageId) {
	for (const [specId, source] of Object.entries(sources ?? {})) {
		if (specId === stageId || specId.startsWith(`${stageId}.`)) return source;
	}
	return null;
}

function findingIdOf(finding) {
	const id =
		typeof finding?.findingId === "string" && finding.findingId.trim()
			? finding.findingId.trim()
			: typeof finding?.id === "string" && finding.id.trim()
				? finding.id.trim()
				: "";
	return id || null;
}

function normalizeMaxBatchSize(value) {
	const parsed = Number(value ?? 4);
	if (!Number.isInteger(parsed) || parsed < 1) return 4;
	return Math.min(parsed, 8);
}

const CONTEXT_PACKET_SCHEMA = "deep-review-finding-context-v1";
const DEFAULT_CONTEXT_MAX_LOCATIONS = 4;
const DEFAULT_CONTEXT_MAX_QUOTES = 10;
const DEFAULT_CONTEXT_MAX_SNIPPETS = 4;
const DEFAULT_CONTEXT_SNIPPET_RADIUS = 3;
const DEFAULT_CONTEXT_SNIPPET_MAX_CHARS = 2000;

function repoRootFromContext(context = {}) {
	const cwd = typeof context.cwd === "string" ? context.cwd.trim() : "";
	return cwd ? path.resolve(cwd) : process.cwd();
}

function pathIsInsideRoot(root, absolute) {
	const relative = path.relative(root, absolute);
	return (
		relative === "" ||
		(!relative.startsWith("..") && !path.isAbsolute(relative))
	);
}

function safeRepoRelativePath(file, repoRoot = process.cwd()) {
	const normalized = String(file ?? "")
		.trim()
		.replace(/^\.\//, "");
	if (!normalized || path.isAbsolute(normalized)) return null;
	const root = path.resolve(repoRoot);
	const absolute = path.resolve(root, normalized);
	if (!pathIsInsideRoot(root, absolute)) return null;
	return path.relative(root, absolute).split(path.sep).join("/");
}

function readRepoText(file, repoRoot = process.cwd()) {
	const relative = safeRepoRelativePath(file, repoRoot);
	if (!relative) return { relative: null, exists: false, text: "" };
	const root = path.resolve(repoRoot);
	const absolute = path.resolve(root, relative);
	try {
		const realRoot = fs.realpathSync(root);
		const realAbsolute = fs.realpathSync(absolute);
		if (!pathIsInsideRoot(realRoot, realAbsolute)) {
			return { relative, exists: false, text: "" };
		}
		const stat = fs.statSync(realAbsolute);
		if (!stat.isFile()) return { relative, exists: false, text: "" };
		return {
			relative,
			exists: true,
			text: fs.readFileSync(realAbsolute, "utf8"),
		};
	} catch {
		return { relative, exists: false, text: "" };
	}
}

function contextRefId(findingId, index) {
	const safeId =
		String(findingId ?? "finding")
			.replace(/[^A-Za-z0-9_-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "finding";
	return `CTX-${safeId}-${index}`;
}

function boundedSnippet(text, line, lineEnd, radius, maxChars) {
	const lines = String(text ?? "").split(/\r?\n/);
	if (lines.length === 0) return null;
	const startLine = Number.isFinite(Number(line))
		? Math.max(1, Number(line))
		: 1;
	const rawEnd = Number.isFinite(Number(lineEnd))
		? Math.max(startLine, Number(lineEnd))
		: startLine;
	const endLine = Math.min(lines.length, rawEnd);
	const start = Math.max(1, startLine - radius);
	const end = Math.min(lines.length, endLine + radius);
	const snippet = lines
		.slice(start - 1, end)
		.map((value, index) => `${start + index}: ${value}`)
		.join("\n");
	return snippet.length > maxChars
		? `${snippet.slice(0, maxChars)}\n...<truncated>`
		: snippet;
}

function lineNumberOfOffset(text, offset) {
	return String(text ?? "")
		.slice(0, offset)
		.split(/\r?\n/).length;
}

function quoteMatchLine(text, quote) {
	const candidate = String(quote ?? "").trim();
	if (!candidate || candidate.length < 8) return null;
	const offset = String(text ?? "").indexOf(candidate);
	return offset >= 0 ? lineNumberOfOffset(text, offset) : null;
}

function cloneExistingContextPacket(packet) {
	if (!packet || typeof packet !== "object" || Array.isArray(packet))
		return null;
	return JSON.parse(JSON.stringify(packet));
}

function buildFindingContextPacket(finding, id, options = {}, context = {}) {
	const existing = cloneExistingContextPacket(finding.contextPacket);
	if (existing) return existing;
	const repoRoot = repoRootFromContext(context);
	const maxLocations = Number.isInteger(options.maxContextLocations)
		? Math.max(1, options.maxContextLocations)
		: DEFAULT_CONTEXT_MAX_LOCATIONS;
	const maxQuotes = Number.isInteger(options.maxContextQuotes)
		? Math.max(1, options.maxContextQuotes)
		: DEFAULT_CONTEXT_MAX_QUOTES;
	const maxSnippets = Number.isInteger(options.maxContextSnippets)
		? Math.max(1, options.maxContextSnippets)
		: DEFAULT_CONTEXT_MAX_SNIPPETS;
	const radius = Number.isInteger(options.contextSnippetRadius)
		? Math.max(0, options.contextSnippetRadius)
		: DEFAULT_CONTEXT_SNIPPET_RADIUS;
	const maxChars = Number.isInteger(options.contextSnippetMaxChars)
		? Math.max(200, options.contextSnippetMaxChars)
		: DEFAULT_CONTEXT_SNIPPET_MAX_CHARS;
	const concreteEvidence = [];
	const missingEvidence = [];
	const files = new Map();
	const quotes = evidenceQuotesOf(finding).slice(0, maxQuotes);
	const addConcreteEvidence = (entry) => {
		if (concreteEvidence.length >= maxSnippets) return;
		concreteEvidence.push({
			ref: contextRefId(id, concreteEvidence.length + 1),
			...entry,
		});
	};
	const readFileOnce = (file) => {
		const relative = safeRepoRelativePath(file, repoRoot);
		if (!relative) return { relative: null, exists: false, text: "" };
		if (!files.has(relative))
			files.set(relative, readRepoText(relative, repoRoot));
		return files.get(relative);
	};
	for (const location of locationsOf(finding).slice(0, maxLocations)) {
		const read = readFileOnce(location.file);
		if (!read.relative || !read.exists) {
			missingEvidence.push({
				type: "repository_file",
				file: location.file,
				reason: "file_not_found_or_outside_repository",
			});
			continue;
		}
		if (!Number.isFinite(Number(location.line))) {
			missingEvidence.push({
				type: "repository_file",
				file: read.relative,
				reason: "line_not_available_for_snippet",
			});
			continue;
		}
		const snippet = boundedSnippet(
			read.text,
			location.line,
			location.lineEnd,
			radius,
			maxChars,
		);
		if (!snippet) continue;
		addConcreteEvidence({
			type: "repository_snippet",
			file: read.relative,
			line: Number(location.line),
			...(Number.isFinite(Number(location.lineEnd))
				? { lineEnd: Number(location.lineEnd) }
				: {}),
			...(location.symbol ? { symbol: location.symbol } : {}),
			snippet,
			matchedQuotes: quotes
				.filter((quote) => snippet.includes(quote))
				.slice(0, 3),
		});
	}
	for (const quote of quotes) {
		if (concreteEvidence.length >= maxSnippets) break;
		let matched = false;
		for (const location of locationsOf(finding).slice(0, maxLocations)) {
			const read = readFileOnce(location.file);
			if (!read.exists) continue;
			const line = quoteMatchLine(read.text, quote);
			if (!line) continue;
			addConcreteEvidence({
				type: "repository_quote_match",
				file: read.relative,
				line,
				quote,
				snippet: boundedSnippet(read.text, line, line, radius, maxChars),
				matchedQuotes: [quote],
			});
			matched = true;
			break;
		}
		if (!matched) {
			missingEvidence.push({
				type: "evidence_quote",
				quote,
				reason: "quote_not_found_in_bounded_location_files",
			});
		}
	}
	return {
		schema: CONTEXT_PACKET_SCHEMA,
		findingId: id,
		title: String(finding.title ?? "").trim(),
		groundingStatus:
			concreteEvidence.length > 0 ? "concrete" : "missing_context",
		locationsChecked: locationsOf(finding).slice(0, maxLocations),
		evidenceQuotesChecked: quotes,
		concreteEvidence,
		missingEvidence,
	};
}

function cloneFindingForBatch(finding, id, options = {}, context = {}) {
	return {
		...finding,
		id: typeof finding.id === "string" && finding.id.trim() ? finding.id : id,
		findingId: id,
		locations: Array.isArray(finding.locations)
			? finding.locations.map((location) => ({ ...location }))
			: [],
		evidenceQuotes: Array.isArray(finding.evidenceQuotes)
			? [...finding.evidenceQuotes]
			: evidenceQuotesOf(finding),
		contextPacket: buildFindingContextPacket(finding, id, options, context),
	};
}

function batchDevilAdvocateFindings(sources, options = {}, context = {}) {
	const dedupStageId = String(options.dedupStage ?? "dedup-findings");
	const maxBatchSize = normalizeMaxBatchSize(options.maxBatchSize);
	const reviewerFindings = findingsOf(findSource(sources, dedupStageId));
	const findings = reviewerFindings
		.map((finding, index) => {
			const id =
				findingIdOf(finding) ?? `finding-${String(index + 1).padStart(3, "0")}`;
			return { id, index, finding };
		})
		.sort((left, right) => left.id.localeCompare(right.id));

	const batches = [];
	for (let offset = 0; offset < findings.length; offset += maxBatchSize) {
		const slice = findings.slice(offset, offset + maxBatchSize);
		const findingIds = slice.map((item) => item.id);
		batches.push({
			id: `dabatch-${String(batches.length + 1).padStart(3, "0")}`,
			findingIds,
			findings: slice.map((item) =>
				cloneFindingForBatch(item.finding, item.id, options, context),
			),
		});
	}

	return {
		schema: "deep-review-devil-advocate-batches-v1",
		digest: `${batches.length} devil-advocate batch(es), ${findings.length} finding(s), maxBatchSize=${maxBatchSize}`,
		maxBatchSize,
		findingCount: findings.length,
		batchCount: batches.length,
		batches,
	};
}

function normalizeVerdict(value) {
	const raw = normalizeText(value)
		.replace(/[\s-]+/g, "_")
		.toUpperCase();
	if (VERDICTS.includes(raw)) return { verdict: raw, normalized: false };
	if (/^KEEP|^KEPT/.test(raw)) return { verdict: "KEEP", normalized: true };
	if (/^WEAK/.test(raw)) return { verdict: "WEAKEN", normalized: true };
	if (/^DROP|^REJECT|^DISCARD/.test(raw))
		return { verdict: "DROP", normalized: true };
	if (/HUMAN|AMBIG|UNCLEAR/.test(raw))
		return { verdict: "NEEDS_HUMAN", normalized: true };
	return {
		verdict: "NEEDS_HUMAN",
		normalized: true,
		invalid: String(value ?? ""),
	};
}

function verdictEntryOf(source) {
	if (!source || typeof source !== "object") return null;
	if (!("verdict" in source) && !("finding" in source)) return null;
	return source;
}

function findingTitleOf(entry) {
	const finding = entry.finding;
	if (finding && typeof finding === "object")
		return String(finding.title ?? "");
	return String(finding ?? entry.title ?? "");
}

function primaryFileOf(item) {
	return String(
		item?.file ??
			item?.locations?.[0]?.file ??
			item?.reviewerFinding?.file ??
			"",
	);
}

function textFragments(value) {
	if (value == null) return [];
	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	)
		return [String(value)];
	if (Array.isArray(value)) return value.flatMap(textFragments);
	if (typeof value === "object")
		return Object.values(value).flatMap(textFragments);
	return [];
}

function supportTextOf(item) {
	return textFragments([
		item?.title,
		item?.evidence,
		item?.evidenceQuotes,
		item?.counterEvidence,
		item?.recommendedAction,
		item?.reviewerFinding?.title,
		item?.reviewerFinding?.evidence,
		item?.reviewerFinding?.evidenceQuotes,
		item?.reviewerFinding?.rationale,
		item?.reviewerFinding?.recommendedAction,
	]).join(" ");
}

function isTestPath(file) {
	return (
		/(^|\/)tests?\//.test(file) ||
		/(^|\/)test\//.test(file) ||
		/\.test\.[cm]?[jt]sx?$/.test(file)
	);
}

function supportReasonOf(item) {
	const file = primaryFileOf(item);
	const text = normalizeText(supportTextOf(item));
	const titleText = normalizeText(
		textFragments([item?.title, item?.reviewerFinding?.title]).join(" "),
	);
	const hasTestSupportLanguage =
		/\b(test|tests|coverage|fixture|fixtures|assertion|assertions)\b/.test(
			titleText,
		) &&
		/\b(gap|missing|lack|lacks|cover|coverage|assert|assertion|fixtures?)\b/.test(
			titleText,
		);
	if ((isTestPath(file) || hasTestSupportLanguage) && hasTestSupportLanguage)
		return "test/coverage support";
	const hasDocSubject = /\b(comment|comments|doc|docs|documentation)\b/.test(
		titleText,
	);
	const hasDocSupportLanguage =
		/\b(stale|outdated|obsolete|mismatch|mismatched|contradict|contradicts|unsupported|advertises?|mentions?|references?|leftover)\b/.test(
			titleText,
		);
	if (hasDocSubject && hasDocSupportLanguage)
		return "comment/documentation support";
	const hasDeadCodeSupportTitle =
		/\b(dead|stale|leftover|orphaned)\b/.test(titleText) &&
		/\b(capture|captures|branch|fallback|code|reference|references|read|reads)\b/.test(
			titleText,
		);
	const hasDeadCodeSupportEvidence =
		/\bdead\b/.test(text) &&
		/\b(capture|captures|branch|fallback|code|reference|references)\b/.test(
			text,
		) &&
		/\b(cleanup|nit|purely|no behavioral|not independent|concedes)\b/.test(
			text,
		) &&
		!/\b(loss|drops?|removed|regression|contract)\b/.test(titleText);
	if (hasDeadCodeSupportTitle || hasDeadCodeSupportEvidence)
		return "dead-code support";
	return null;
}

function supportNoteFromItem(item, reason, relatedRoot) {
	return {
		title: item.title,
		severity: item.severity,
		file: item.file,
		locations: item.locations,
		evidenceQuotes: item.evidenceQuotes,
		reason,
		...(relatedRoot ? { supportingFindingOf: relatedRoot.title } : {}),
		evidence: item.evidence,
		counterEvidence: item.counterEvidence,
		recommendedAction: item.recommendedAction,
	};
}

function supportOnlyNeedsHumanItem(supportNotes) {
	const evidenceQuotes = dedupeStrings(
		supportNotes.flatMap((note) => note.evidenceQuotes ?? []),
	).slice(0, 8);
	const locations = dedupeLocations(
		supportNotes.flatMap((note) =>
			Array.isArray(note.locations) ? note.locations : [],
		),
	);
	return {
		findingId: "needs-human-support-only",
		rootCauseId: "support-only-findings",
		title:
			"Support-only findings need an underlying root-cause review before reporting",
		verdict: "NEEDS_HUMAN",
		severity: "unknown",
		...(locations.length > 0 ? { locations } : {}),
		...(evidenceQuotes.length > 0 ? { evidenceQuotes } : {}),
		note: "All candidate findings were test/coverage, stale comment/docs, or dead-code symptoms. They were moved out of reportable findings because no independent behavioral root finding remained.",
	};
}

function demoteSupportFindings(partitions, normalizationNotes) {
	const roots = [...partitions.keep, ...partitions.weaken].filter(
		(item) => !supportReasonOf(item) && !isTestPath(primaryFileOf(item)),
	);
	const supportNotes = [];
	let supportOnlyDemotions = 0;
	const demoteFrom = (items) => {
		const next = [];
		for (const item of items) {
			const reason = supportReasonOf(item);
			if (!reason) {
				next.push(item);
				continue;
			}
			const file = primaryFileOf(item);
			const relatedRoot =
				roots.find((root) => primaryFileOf(root) === file) ??
				(isTestPath(file) ? roots[0] : undefined);
			if (!relatedRoot && roots.length > 0) {
				next.push(item);
				continue;
			}
			supportNotes.push(supportNoteFromItem(item, reason, relatedRoot));
			if (relatedRoot) {
				normalizationNotes.push(
					`support finding "${item.title}" moved out of findings (${reason}) under "${relatedRoot.title}"`,
				);
			} else {
				supportOnlyDemotions += 1;
				normalizationNotes.push(
					`support-only finding "${item.title}" moved out of findings (${reason}); no independent root finding remained`,
				);
			}
		}
		return next;
	};
	partitions.keep = demoteFrom(partitions.keep);
	partitions.weaken = demoteFrom(partitions.weaken);
	if (
		supportOnlyDemotions > 0 &&
		partitions.keep.length === 0 &&
		partitions.weaken.length === 0
	) {
		partitions.needsHuman.push(supportOnlyNeedsHumanItem(supportNotes));
		normalizationNotes.push(
			`support-only review produced ${supportOnlyDemotions} non-root finding(s); routed to NEEDS_HUMAN instead of reportable findings`,
		);
	}
	return supportNotes;
}

function rootTextOf(item) {
	return textFragments([
		item?.title,
		item?.evidence,
		item?.evidenceQuotes,
		item?.counterEvidence,
		item?.recommendedAction,
	]).join(" ");
}

function rootTokensOf(item) {
	return titleTokens({ title: rootTextOf(item) });
}

const DISTINCT_ROOT_SIGNAL_GROUPS = [
	{
		name: "startup",
		terms: [
			"startup failure",
			"startup error",
			"setupwriter",
			"setup writer",
			"setup failure",
			"setup failures",
			"cannot be opened",
			"cannot open",
			"reports success",
			"report success",
			"start error",
			"start failure",
		],
	},
	{
		name: "tracking",
		terms: [
			"trackall",
			"track all",
			"journal insert",
			"insert",
			"persist",
			"durab",
			"devnull",
			"writer state",
			"writer exists",
			"recovery",
			"recover",
			"load",
			"drop",
			"discard",
			"tracked",
			"tracking",
			"asynchronous",
			"async",
		],
	},
	{
		name: "shutdown",
		terms: [
			"stop",
			"shutdown",
			"close failure",
			"close error",
			"flush",
			"defer",
		],
	},
];

function rootSignalTextOf(item) {
	return textFragments([item?.title, item?.claim]).join(" ");
}

function rootSignalGroupsOf(item) {
	const text = normalizeText(rootSignalTextOf(item));
	return new Set(
		DISTINCT_ROOT_SIGNAL_GROUPS.filter((group) =>
			group.terms.some((term) => text.includes(term)),
		).map((group) => group.name),
	);
}

function sameSignalGroups(left, right) {
	if (left.size !== right.size) return false;
	for (const tag of left) if (!right.has(tag)) return false;
	return true;
}

function normalizedEvidenceQuotesOf(item) {
	return dedupeStrings(quoteStrings(item?.evidenceQuotes))
		.map((quote) => normalizeText(quote))
		.filter((quote) => quote.length >= 24);
}

function evidenceQuotesOverlap(a, b) {
	const quotesA = normalizedEvidenceQuotesOf(a);
	const quotesB = normalizedEvidenceQuotesOf(b);
	if (quotesA.length === 0 || quotesB.length === 0) return false;
	for (const left of quotesA) {
		for (const right of quotesB) {
			if (left === right || left.includes(right) || right.includes(left))
				return true;
		}
	}
	return false;
}

function locationRangesOf(item) {
	return asObjects(item?.locations)
		.map((location) => ({
			file: String(location.file ?? primaryFileOf(item)),
			line: Number(location.line),
			lineEnd: Number(location.lineEnd ?? location.line),
		}))
		.filter(
			(location) =>
				location.file &&
				Number.isFinite(location.line) &&
				Number.isFinite(location.lineEnd),
		);
}

function rangesOverlapOrTouch(a, b, tolerance = 3) {
	return (
		a.file === b.file &&
		a.line <= b.lineEnd + tolerance &&
		b.line <= a.lineEnd + tolerance
	);
}

function locationsOverlapOrTouch(a, b) {
	const rangesA = locationRangesOf(a);
	const rangesB = locationRangesOf(b);
	if (rangesA.length === 0 || rangesB.length === 0) return null;
	return rangesA.some((left) =>
		rangesB.some((right) => rangesOverlapOrTouch(left, right)),
	);
}

function locationFilesOverlap(a, b) {
	const filesA = new Set(locationRangesOf(a).map((location) => location.file));
	const filesB = new Set(locationRangesOf(b).map((location) => location.file));
	if (filesA.size === 0 || filesB.size === 0) return false;
	for (const file of filesA) if (filesB.has(file)) return true;
	return false;
}

function hasGeneratorLifecycleProtocol(item) {
	const text = normalizeText(rootTextOf(item));
	const generatorSignal =
		text.includes("genabort") ||
		text.includes("stopgeneration") ||
		text.includes("snapshot generator") ||
		text.includes("generator goroutine");
	return generatorSignal;
}

function sameLifecycleProtocolFinding(a, b) {
	if (!hasGeneratorLifecycleProtocol(a) || !hasGeneratorLifecycleProtocol(b)) {
		return false;
	}
	return locationFilesOverlap(a, b) || evidenceQuotesOverlap(a, b);
}

function sameRootFinding(a, b) {
	const fileA = primaryFileOf(a);
	const fileB = primaryFileOf(b);
	const crossFileProtocol =
		fileA && fileB && fileA !== fileB && sameLifecycleProtocolFinding(a, b);
	if (fileA && fileB && fileA !== fileB && !crossFileProtocol) return false;
	const signalsA = rootSignalGroupsOf(a);
	const signalsB = rootSignalGroupsOf(b);
	const comparableSignals = signalsA.size > 0 && signalsB.size > 0;
	if (
		comparableSignals &&
		!sameSignalGroups(signalsA, signalsB) &&
		!crossFileProtocol
	)
		return false;
	const locationOverlap = locationsOverlapOrTouch(a, b);
	if (locationOverlap === false && !crossFileProtocol) return false;
	const quoteOverlap = evidenceQuotesOverlap(a, b);
	const overlap = tokenOverlap(rootTokensOf(a), rootTokensOf(b));
	if (crossFileProtocol) return true;
	if (locationOverlap === true && quoteOverlap) return true;
	if (locationOverlap === true && comparableSignals) return overlap >= 0.18;
	if (locationOverlap === true) return overlap >= 0.35;
	if (quoteOverlap) return overlap >= 0.25;
	return overlap >= DUPLICATE_OVERLAP;
}

function mergeFindingItems(primary, duplicate) {
	primary.locations = dedupeLocations([
		...(Array.isArray(primary.locations) ? primary.locations : []),
		...(Array.isArray(duplicate.locations) ? duplicate.locations : []),
	]);
	primary.evidenceQuotes = dedupeEvidenceQuotes([
		...(Array.isArray(primary.evidenceQuotes) ? primary.evidenceQuotes : []),
		...(Array.isArray(duplicate.evidenceQuotes)
			? duplicate.evidenceQuotes
			: []),
	]);
	primary.mergedFindings = [
		...(Array.isArray(primary.mergedFindings) ? primary.mergedFindings : []),
		{
			findingId: duplicate.findingId ?? duplicate.id,
			rootCauseId: duplicate.rootCauseId,
			title: duplicate.title,
			severity: duplicate.severity,
			file: duplicate.file,
			locations: duplicate.locations,
			evidenceQuotes: duplicate.evidenceQuotes,
			evidence: duplicate.evidence,
			counterEvidence: duplicate.counterEvidence,
			recommendedAction: duplicate.recommendedAction,
		},
	];
	return primary;
}

function relatedRootFinding(a, b) {
	const fileA = primaryFileOf(a);
	const fileB = primaryFileOf(b);
	if (fileA && fileB && fileA !== fileB) return false;
	const locationOverlap = locationsOverlapOrTouch(a, b);
	if (locationOverlap === false) return false;
	return (
		locationOverlap === true ||
		evidenceQuotesOverlap(a, b) ||
		tokenOverlap(rootTokensOf(a), rootTokensOf(b)) >= 0.12
	);
}

function mergeCoveredCompoundFindings(items, bucketName, normalizationNotes) {
	const removed = new Set();
	let mergedCount = 0;
	const broadestFirst = [...items].sort(
		(a, b) => rootSignalGroupsOf(b).size - rootSignalGroupsOf(a).size,
	);
	for (const item of broadestFirst) {
		const signals = rootSignalGroupsOf(item);
		if (signals.size <= 1) continue;
		const coveringRoots = [];
		let fullyCovered = true;
		for (const signal of signals) {
			const coveringRoot = items.find((candidate) => {
				if (candidate === item) return false;
				const candidateSignals = rootSignalGroupsOf(candidate);
				return (
					candidateSignals.size < signals.size &&
					candidateSignals.has(signal) &&
					relatedRootFinding(candidate, item)
				);
			});
			if (!coveringRoot) {
				fullyCovered = false;
				break;
			}
			coveringRoots.push(coveringRoot);
		}
		if (!fullyCovered) continue;
		mergeFindingItems(coveringRoots[0], item);
		removed.add(item);
		mergedCount += 1;
		normalizationNotes.push(
			`compound root finding "${item.title}" covered by narrower ${bucketName} roots and merged as provenance`,
		);
	}
	return {
		items: items.filter((item) => !removed.has(item)),
		mergedCount,
	};
}

function mergeEquivalentRootFindings(partitions, normalizationNotes) {
	let mergedCount = 0;
	for (const bucketName of ["keep", "weaken"]) {
		const merged = [];
		for (const item of partitions[bucketName]) {
			const existing = merged.find((candidate) =>
				sameRootFinding(candidate, item),
			);
			if (!existing) {
				merged.push(item);
				continue;
			}
			mergeFindingItems(existing, item);
			mergedCount += 1;
			normalizationNotes.push(
				`equivalent root finding "${item.title}" merged into "${existing.title}" in ${bucketName}`,
			);
		}
		const compoundResult = mergeCoveredCompoundFindings(
			merged,
			bucketName,
			normalizationNotes,
		);
		partitions[bucketName] = compoundResult.items;
		mergedCount += compoundResult.mergedCount;
	}

	const remainingWeaken = [];
	for (const item of partitions.weaken) {
		const keepRoot = partitions.keep.find((candidate) =>
			sameRootFinding(candidate, item),
		);
		if (!keepRoot) {
			remainingWeaken.push(item);
			continue;
		}
		mergeFindingItems(keepRoot, item);
		mergedCount += 1;
		normalizationNotes.push(
			`equivalent weakened root finding "${item.title}" merged into keep finding "${keepRoot.title}"`,
		);
	}
	partitions.weaken = remainingWeaken;
	return mergedCount;
}

function compactFindingForReport(item) {
	return {
		...(item.findingId ? { findingId: item.findingId } : {}),
		...(item.rootCauseId ? { rootCauseId: item.rootCauseId } : {}),
		title: item.title,
		severity: item.severity,
		...(item.recommendedAction
			? { recommendedAction: item.recommendedAction }
			: {}),
		...(Array.isArray(item.mergedFindings) && item.mergedFindings.length > 0
			? {
					mergedFindingIds: item.mergedFindings
						.map((finding) => finding.findingId ?? finding.id)
						.filter(Boolean),
				}
			: {}),
	};
}

function buildReportContext(partitions, supportNotes, partialFailures) {
	return {
		keep: partitions.keep.map(compactFindingForReport),
		weaken: partitions.weaken.map(compactFindingForReport),
		needsHuman: partitions.needsHuman.map(compactFindingForReport),
		supportNoteSummaries: supportNotes.map((note) => ({
			title: note.title,
			...(note.severity ? { severity: note.severity } : {}),
			...(note.reason ? { reason: note.reason } : {}),
			...(note.supportingFindingOf
				? { supportingFindingOf: note.supportingFindingOf }
				: {}),
		})),
		partialFailures,
	};
}

function asBatchArray(value) {
	if (Array.isArray(value?.batches)) return value.batches;
	if (Array.isArray(value)) return value;
	return [];
}

function buildDevilAdvocateBatchMembershipById(batchSource) {
	const batches = new Map();
	for (const batch of asBatchArray(batchSource)) {
		const batchId = typeof batch?.id === "string" ? batch.id.trim() : "";
		if (!batchId) continue;
		const fromIds = Array.isArray(batch.findingIds) ? batch.findingIds : [];
		const fromFindings = Array.isArray(batch.findings) ? batch.findings : [];
		const members = new Map();
		for (const finding of fromFindings) {
			const id = findingIdOf(finding);
			if (!id) continue;
			members.set(id, {
				findingId: id,
				title: String(finding.title ?? "").trim(),
				titleKey: normalizeText(finding.title),
				contextPacket: cloneExistingContextPacket(finding.contextPacket),
			});
		}
		for (const idValue of fromIds) {
			const id = typeof idValue === "string" ? idValue.trim() : "";
			if (!id || members.has(id)) continue;
			members.set(id, { findingId: id, title: "", titleKey: "" });
		}
		batches.set(batchId, members);
	}
	return batches;
}

function hydrateDevilAdvocateBatchMembershipTitles(
	batchMembershipById,
	byFindingId,
) {
	for (const members of batchMembershipById.values()) {
		for (const [findingId, member] of members.entries()) {
			if (member.titleKey) continue;
			const finding = byFindingId.get(findingId);
			const title = String(finding?.title ?? "").trim();
			if (!title) continue;
			members.set(findingId, {
				...member,
				title,
				titleKey: normalizeText(title),
				contextPacket: member.contextPacket,
			});
		}
	}
	return batchMembershipById;
}

function devilAdvocateBatchId(sourceId) {
	const prefix = "devil-advocate.";
	if (typeof sourceId !== "string" || !sourceId.startsWith(prefix)) return null;
	const id = sourceId.slice(prefix.length).trim();
	return id || null;
}

function buildDevilAdvocateBatchIdBySourceName(sourceStatuses) {
	const bySource = new Map();
	for (const status of sourceStatusesOf({ sourceStatuses })) {
		const source = typeof status.source === "string" ? status.source : "";
		const batchId = devilAdvocateBatchId(status.specId);
		if (source && batchId) bySource.set(source, batchId);
	}
	return bySource;
}

const BATCH_CONTROL_SCHEMA = "deep-review-devil-advocate-batch-v2";
// Conservative evidence-source gating is intentionally scoped to the opt-in
// batched devil-advocate path. The default single-finding path keeps its
// existing semantics until a separate policy/default-flip decision is made.

const BATCH_RESULT_KEYS = new Set([
	"findingId",
	"title",
	"verdict",
	"evidenceSourceType",
	"evidence",
	"counterEvidence",
	"recommendedAction",
]);

const BATCH_EVIDENCE_SOURCE_TYPES = new Set([
	"concrete_artifact",
	"repository_context",
	"finding_payload_only",
	"unverified_summary",
	"unknown",
]);
const CONCRETE_BATCH_EVIDENCE_SOURCE_TYPES = new Set([
	"concrete_artifact",
	"repository_context",
]);

function batchEvidenceSourceType(row) {
	return typeof row?.evidenceSourceType === "string"
		? row.evidenceSourceType
		: "";
}

function hasMissingContextCounterEvidence(row) {
	const text = dedupeStrings(quoteStrings(row?.counterEvidence))
		.join("\n")
		.toLowerCase();
	const supportQualityPattern =
		/\b(?:missing|absent|lack(?:s|ing)?|no|does not contain)\b[^\n]{0,80}\b(?:tests?|test coverage|coverage|docs?|documentation)\b|\b(?:tests?|test coverage|coverage|docs?|documentation)\b[^\n]{0,80}\b(?:missing|absent|not found|unavailable)\b/;
	const contextSegments = text
		.split(/\n+|[!?]\s+|\.\s+|;\s+|\s+and\s+|\s+but\s+/)
		.map((segment) => segment.trim())
		.filter(Boolean)
		.filter((segment) => !supportQualityPattern.test(segment));
	if (contextSegments.length === 0) return false;
	return contextSegments.some((segment) =>
		[
			/\bno\b[^\n]{0,100}\b(?:file|diff|patch|repository|repo|artifact|context|source)\b[^\n]{0,100}\b(?:found|inspected|available|exists?|located)\b/,
			/\b(?:file|diff|patch|repository|repo|artifact|context|source|checkout)\b[^\n]{0,100}\b(?:missing|not found|could not be found|could not be inspected|unable to inspect|unavailable)\b/,
			/\b(?:could not be found|not found|could not be inspected|unable to inspect|did not locate)\b[^\n]{0,100}\b(?:file|diff|patch|repository|repo|artifact|context|source)\b/,
			/\b(?:repository search|search)\b[^\n]{0,100}\b(?:did not locate|could not find)\b/,
			/\b(?:repository search|search)\b[^\n]{0,100}\bfound no\b[^\n]{0,100}\b(?:file|diff|patch|repository evidence|repo evidence|artifact|context|source|code)\b/,
			/\b(?:moved|drifted)\b[^\n]{0,80}\b(?:file|function|line|context|symbol)\b/,
			/\b(?:file|function|line|context|symbol)\b[^\n]{0,80}\b(?:moved|drifted)\b/,
		].some((pattern) => pattern.test(segment)),
	);
}

function contextPacketHasConcreteEvidence(contextPacket) {
	return (
		contextPacket?.schema === CONTEXT_PACKET_SCHEMA &&
		contextPacket.groundingStatus === "concrete" &&
		asObjects(contextPacket.concreteEvidence).length > 0
	);
}

function batchEvidenceText(row) {
	return dedupeStrings(quoteStrings(row?.evidence)).join("\n");
}

function batchEvidenceAndCounterEvidenceText(row) {
	return dedupeStrings([
		...quoteStrings(row?.evidence),
		...quoteStrings(row?.counterEvidence),
	]).join("\n");
}

function evidenceCitesContextPacket(
	row,
	contextPacket,
	includeCounterEvidence = false,
) {
	const evidenceText = includeCounterEvidence
		? batchEvidenceAndCounterEvidenceText(row)
		: batchEvidenceText(row);
	const refs = asObjects(contextPacket?.concreteEvidence)
		.map((entry) => String(entry.ref ?? "").trim())
		.filter(Boolean);
	return refs.some((ref) => evidenceText.includes(ref));
}

const REPOSITORY_POINTER_PATTERN =
	/\b([\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|c|h|cpp|hpp|json|ya?ml|md))(?::(\d+)|[^\n]{0,80}\bline\s+(\d+))/gi;

function evidencePointerIsNegativeContext(segment) {
	return /\b(?:no match|not found|could not find|did not find|unable to find|could not locate|did not locate|no evidence|missing context)\b/i.test(
		segment,
	);
}

function repositoryPointersFromEvidence(row, includeCounterEvidence = false) {
	const pointers = [];
	const text = includeCounterEvidence
		? batchEvidenceAndCounterEvidenceText(row)
		: batchEvidenceText(row);
	for (const segment of text.split(/\n+/)) {
		REPOSITORY_POINTER_PATTERN.lastIndex = 0;
		if (evidencePointerIsNegativeContext(segment)) continue;
		for (const match of segment.matchAll(REPOSITORY_POINTER_PATTERN)) {
			pointers.push({ file: match[1], line: Number(match[2] ?? match[3]) });
		}
	}
	return pointers;
}

function repositoryPointerExists(pointer, repoRoot) {
	const read = readRepoText(pointer?.file, repoRoot);
	if (!read.exists) return false;
	if (!Number.isInteger(pointer.line) || pointer.line < 1) return false;
	return pointer.line <= String(read.text ?? "").split(/\r?\n/).length;
}

function evidenceCitesConcreteRepositoryPointer(
	row,
	context = {},
	includeCounterEvidence = false,
) {
	const repoRoot = repoRootFromContext(context);
	return repositoryPointersFromEvidence(row, includeCounterEvidence).some(
		(pointer) => repositoryPointerExists(pointer, repoRoot),
	);
}

function conservativeBatchVerdictDemotionReason(
	row,
	contextPacket = null,
	context = {},
) {
	const verdict = row?.verdict;
	const evidenceSourceType = batchEvidenceSourceType(row);
	const citesAdditionalRepositoryRead = evidenceCitesConcreteRepositoryPointer(
		row,
		context,
	);
	const citesAnyAdditionalRepositoryRead =
		evidenceCitesConcreteRepositoryPointer(row, context, true);
	const hasConcreteContextPacket =
		contextPacketHasConcreteEvidence(contextPacket);
	const citesAnyPlannedContext = evidenceCitesContextPacket(
		row,
		contextPacket,
		true,
	);
	const citesConcreteRepositoryContext =
		citesAnyAdditionalRepositoryRead ||
		(hasConcreteContextPacket && citesAnyPlannedContext);
	if (verdict === "DROP") {
		if (evidenceSourceType === "concrete_artifact") return null;
		if (!CONCRETE_BATCH_EVIDENCE_SOURCE_TYPES.has(evidenceSourceType)) {
			return `batch DROP used non-concrete evidenceSourceType=${evidenceSourceType || "missing"}`;
		}
		if (!hasConcreteContextPacket && !citesAnyAdditionalRepositoryRead) {
			return "batch DROP lacked concrete context to rule out finding";
		}
		if (!citesConcreteRepositoryContext) {
			return "batch DROP did not cite row-local contextPacket evidence";
		}
		return null;
	}
	if (verdict === "WEAKEN") {
		if (!CONCRETE_BATCH_EVIDENCE_SOURCE_TYPES.has(evidenceSourceType)) {
			return `batch WEAKEN used non-concrete evidenceSourceType=${evidenceSourceType || "missing"}`;
		}
		if (
			dedupeStrings([
				...quoteStrings(row?.evidence),
				...quoteStrings(row?.counterEvidence),
			]).length === 0
		) {
			return "batch WEAKEN lacked evidence or counterEvidence";
		}
		if (
			evidenceSourceType !== "concrete_artifact" &&
			hasMissingContextCounterEvidence(row)
		) {
			return "batch WEAKEN had missing-context counterEvidence without concrete_artifact evidence";
		}
		if (evidenceSourceType !== "concrete_artifact") {
			if (!hasConcreteContextPacket && !citesAnyAdditionalRepositoryRead) {
				return "batch WEAKEN lacked planned concrete contextPacket evidence";
			}
			if (!citesConcreteRepositoryContext) {
				return "batch WEAKEN did not cite row-local contextPacket evidence";
			}
		}
		return null;
	}
	if (verdict !== "KEEP") return null;
	if (!CONCRETE_BATCH_EVIDENCE_SOURCE_TYPES.has(evidenceSourceType)) {
		return `batch KEEP used non-concrete evidenceSourceType=${evidenceSourceType || "missing"}`;
	}
	if (dedupeStrings(quoteStrings(row?.evidence)).length === 0) {
		return "batch KEEP lacked non-empty evidence";
	}
	if (
		evidenceSourceType !== "concrete_artifact" &&
		hasMissingContextCounterEvidence(row)
	) {
		return "batch KEEP had missing-context counterEvidence without concrete_artifact evidence";
	}
	if (evidenceSourceType !== "concrete_artifact") {
		const citesPlannedContext = evidenceCitesContextPacket(row, contextPacket);
		if (!hasConcreteContextPacket && !citesAdditionalRepositoryRead) {
			return "batch KEEP lacked planned concrete contextPacket evidence";
		}
		if (!citesPlannedContext && !citesAdditionalRepositoryRead) {
			return "batch KEEP did not cite row-local contextPacket evidence";
		}
	}
	return null;
}

function malformedBatchResultReason(row) {
	if (!row || typeof row !== "object" || Array.isArray(row))
		return "malformed_batch_result_not_object";
	const extraKeys = Object.keys(row).filter(
		(key) => !BATCH_RESULT_KEYS.has(key),
	);
	if (extraKeys.length > 0) return "malformed_batch_result_extra_fields";
	if (typeof row.findingId !== "string" || !row.findingId.trim())
		return "malformed_batch_result_missing_findingId";
	if (typeof row.title !== "string" || !row.title.trim())
		return "malformed_batch_result_missing_title";
	if (typeof row.verdict !== "string" || !row.verdict.trim())
		return "malformed_batch_result_missing_verdict";
	if (!VERDICTS.includes(row.verdict))
		return "malformed_batch_result_invalid_verdict";
	if (!BATCH_EVIDENCE_SOURCE_TYPES.has(batchEvidenceSourceType(row)))
		return "malformed_batch_result_invalid_evidenceSourceType";
	if (!Array.isArray(row.evidence))
		return "malformed_batch_result_missing_evidence_array";
	if (row.evidence.some((item) => typeof item !== "string"))
		return "malformed_batch_result_invalid_evidence_item";
	if (!Array.isArray(row.counterEvidence))
		return "malformed_batch_result_missing_counterEvidence_array";
	if (row.counterEvidence.some((item) => typeof item !== "string"))
		return "malformed_batch_result_invalid_counterEvidence_item";
	if (typeof row.recommendedAction !== "string")
		return "malformed_batch_result_missing_recommendedAction";
	return null;
}

function collectBatchVerdictRows({
	sourceId,
	source,
	batchMembershipById,
	batchIdBySourceName,
}) {
	const batchId =
		devilAdvocateBatchId(sourceId) ?? batchIdBySourceName.get(sourceId);
	const rows = [];
	const issues = [];
	if (!source || typeof source !== "object" || !Array.isArray(source.results)) {
		issues.push({
			sourceId,
			batchId,
			reason: "malformed_batch_output_missing_results",
			title: "Malformed devil-advocate batch output",
		});
		return { rows, issues };
	}
	if (source.schema !== BATCH_CONTROL_SCHEMA) {
		issues.push({
			sourceId,
			batchId,
			reason: "malformed_batch_output_invalid_schema",
			title: "Malformed devil-advocate batch output",
			schema: source.schema,
			expectedSchema: BATCH_CONTROL_SCHEMA,
		});
		return { rows, issues };
	}
	const expectedMembers = batchId ? batchMembershipById.get(batchId) : null;
	for (const [index, result] of source.results.entries()) {
		const base = { sourceId, batchId, index };
		const malformed = malformedBatchResultReason(result);
		if (malformed) {
			issues.push({
				...base,
				reason: malformed,
				findingId:
					typeof result?.findingId === "string" && result.findingId.trim()
						? result.findingId.trim()
						: undefined,
				title:
					typeof result?.title === "string" && result.title.trim()
						? result.title.trim()
						: "Malformed devil-advocate batch result",
				entry: result && typeof result === "object" ? result : {},
			});
			continue;
		}
		const findingId = result.findingId.trim();
		const title = result.title.trim();
		if (!batchId || !expectedMembers) {
			issues.push({
				...base,
				findingId,
				title,
				reason: "unknown_devil_advocate_batch_id",
				expectedBatchIds: [...batchMembershipById.keys()],
				entry: result,
			});
			continue;
		}
		const expected = expectedMembers.get(findingId);
		if (!expected) {
			issues.push({
				...base,
				findingId,
				title,
				reason: "batch_result_finding_not_in_source_batch",
				expectedFindingIds: [...expectedMembers.keys()],
				entry: result,
			});
			continue;
		}
		if (!expected.titleKey) {
			issues.push({
				...base,
				findingId,
				title,
				reason: "batch_membership_missing_title",
				entry: result,
			});
			continue;
		}
		if (String(title ?? "").trim() !== expected.title) {
			issues.push({
				...base,
				findingId,
				title,
				expectedTitle: expected.title,
				reason: "batch_result_title_mismatch",
				entry: result,
			});
			continue;
		}
		rows.push({
			...base,
			findingId,
			title,
			batchKey: `${batchId}|${findingId}|${normalizeText(title)}`,
			contextPacket: expected.contextPacket,
			entry: result,
		});
	}
	return { rows, issues };
}

function batchIssueNeedsHumanItem(issue, reviewerFinding, fallbackId) {
	const entry =
		issue.entry && typeof issue.entry === "object" ? issue.entry : {};
	const findingId =
		reviewerFinding?.findingId ??
		reviewerFinding?.id ??
		issue.findingId ??
		fallbackId;
	return {
		findingId,
		rootCauseId:
			reviewerFinding?.rootCauseId ??
			reviewerFinding?.findingId ??
			reviewerFinding?.id ??
			findingId,
		title: reviewerFinding?.title ?? issue.title ?? findingTitleOf(entry),
		verdict: "NEEDS_HUMAN",
		severity:
			reviewerFinding?.severity ??
			(entry.finding && typeof entry.finding === "object"
				? String(entry.finding.severity ?? "unknown")
				: "unknown"),
		file: reviewerFinding?.file,
		locations: reviewerFinding
			? (reviewerFinding.locations ?? locationsOf(reviewerFinding))
			: [],
		evidenceQuotes: reviewerFinding
			? (reviewerFinding.evidenceQuotes ?? evidenceQuotesOf(reviewerFinding))
			: [],
		evidence: Array.isArray(entry.evidence) ? entry.evidence : [],
		counterEvidence: Array.isArray(entry.counterEvidence)
			? entry.counterEvidence
			: [],
		recommendedAction:
			typeof entry.recommendedAction === "string"
				? entry.recommendedAction
				: "",
		note: `devil-advocate batch integrity issue: ${issue.reason}`,
		batchIntegrityIssue: {
			reason: issue.reason,
			...(issue.sourceId ? { sourceId: issue.sourceId } : {}),
			...(issue.batchId ? { batchId: issue.batchId } : {}),
			...(Number.isInteger(issue.index) ? { index: issue.index } : {}),
			...(Number.isInteger(issue.rowCount) ? { rowCount: issue.rowCount } : {}),
			...(issue.expectedTitle ? { expectedTitle: issue.expectedTitle } : {}),
			...(issue.expectedBatchIds
				? { expectedBatchIds: issue.expectedBatchIds }
				: {}),
			...(issue.expectedFindingIds
				? { expectedFindingIds: issue.expectedFindingIds }
				: {}),
		},
	};
}

function partitionVerdicts(sources, options = {}, context = {}) {
	const dedupStageId = String(options.dedupStage ?? "dedup-findings");
	const directStatusSummary = sourceStatusSummary(sourceStatusesOf(context));
	const partialFailures = mergePartialFailures(
		directStatusSummary.partialFailures,
		...Object.values(sources ?? {}).map(partialFailuresFromSource),
	);
	let reviewerFindings = [];
	const verdictRows = [];
	const batchIssues = [];
	const devilAdvocateBatchStage = String(
		options.devilAdvocateBatchStage ?? "devil-advocate-batches",
	);
	for (const [specId, source] of Object.entries(sources ?? {})) {
		if (specId.startsWith(`${dedupStageId}.`) || specId === dedupStageId)
			reviewerFindings = findingsOf(source);
	}

	const byTitle = new Map();
	const byFindingId = new Map();
	for (const finding of reviewerFindings) {
		byTitle.set(normalizeText(finding.title), finding);
		const findingId = findingIdOf(finding);
		if (findingId) byFindingId.set(findingId, finding);
	}
	const findMatch = (title) => {
		const rawTitle = String(title ?? "");
		const exactId = byFindingId.get(rawTitle);
		if (exactId) return { finding: exactId, key: normalizeText(exactId.title) };
		const key = normalizeText(rawTitle);
		const exact = byTitle.get(key);
		if (exact) return { finding: exact, key: normalizeText(exact.title) };
		const tokens = titleTokens({ title });
		for (const finding of reviewerFindings) {
			if (tokenOverlap(titleTokens(finding), tokens) >= DUPLICATE_OVERLAP) {
				return { finding, key: normalizeText(finding.title) };
			}
		}
		return { finding: null, key };
	};

	const batchMembershipById = hydrateDevilAdvocateBatchMembershipTitles(
		buildDevilAdvocateBatchMembershipById(
			findSource(sources, devilAdvocateBatchStage),
		),
		byFindingId,
	);
	const batchMode = batchMembershipById.size > 0;
	const batchIdBySourceName = buildDevilAdvocateBatchIdBySourceName(
		context.sourceStatuses,
	);
	for (const [specId, source] of Object.entries(sources ?? {})) {
		if (specId.startsWith(`${dedupStageId}.`) || specId === dedupStageId) {
			continue;
		}
		if (
			specId.startsWith(`${devilAdvocateBatchStage}.`) ||
			specId === devilAdvocateBatchStage
		) {
			continue;
		}
		if (
			batchMode &&
			(specId === "devil-advocate" || specId.startsWith("devil-advocate."))
		) {
			const collected = collectBatchVerdictRows({
				sourceId: specId,
				source,
				batchMembershipById,
				batchIdBySourceName,
			});
			for (const row of collected.rows)
				verdictRows.push({ ...row, batched: true });
			batchIssues.push(...collected.issues);
			continue;
		}
		const entry = verdictEntryOf(source);
		if (entry) verdictRows.push({ entry, batched: false });
	}

	const partitions = { keep: [], weaken: [], drop: [], needsHuman: [] };
	const normalizationNotes = [];
	const matchedTitles = new Set();
	const matchedFindingIds = new Set();
	const issueCoveredFindingIds = new Set();
	let missingVerdicts = 0;

	const duplicateBatchKeys = new Set();
	const batchKeyCounts = new Map();
	for (const row of verdictRows.filter((candidate) => candidate.batched)) {
		batchKeyCounts.set(
			row.batchKey,
			(batchKeyCounts.get(row.batchKey) ?? 0) + 1,
		);
	}
	for (const [key, count] of batchKeyCounts) {
		if (count > 1) duplicateBatchKeys.add(key);
	}
	for (const key of duplicateBatchKeys) {
		const rows = verdictRows.filter(
			(candidate) => candidate.batched && candidate.batchKey === key,
		);
		const first = rows[0];
		batchIssues.push({
			sourceId: first.sourceId,
			batchId: first.batchId,
			index: first.index,
			findingId: first.findingId,
			title: first.title,
			reason: "duplicate_batch_result_for_finding",
			rowCount: rows.length,
			entry: first.entry,
		});
	}

	let batchIssueIndex = 0;
	for (const issue of batchIssues) {
		batchIssueIndex += 1;
		const reviewerFinding = issue.findingId
			? byFindingId.get(issue.findingId)
			: null;
		if (reviewerFinding) {
			const id = findingIdOf(reviewerFinding);
			if (id) issueCoveredFindingIds.add(id);
			if (!batchMode) matchedTitles.add(normalizeText(reviewerFinding.title));
		}
		partitions.needsHuman.push(
			batchIssueNeedsHumanItem(
				issue,
				reviewerFinding,
				`batch-verdict-${String(batchIssueIndex).padStart(3, "0")}`,
			),
		);
		normalizationNotes.push(
			`devil-advocate batch integrity issue ${issue.reason} for "${issue.title ?? issue.findingId ?? "unknown"}" routed to NEEDS_HUMAN`,
		);
	}

	let verdictIndex = 0;
	for (const row of verdictRows) {
		if (row.batched && duplicateBatchKeys.has(row.batchKey)) continue;
		if (row.batched && issueCoveredFindingIds.has(row.findingId)) continue;
		verdictIndex += 1;
		const entry = row.entry;
		const title = row.batched ? row.title : findingTitleOf(entry);
		const reviewerFinding = row.batched
			? byFindingId.get(row.findingId)
			: findMatch(title).finding;
		const titleKey = reviewerFinding
			? normalizeText(reviewerFinding.title)
			: normalizeText(title);
		if (reviewerFinding) {
			if (row.batched) {
				const findingId = findingIdOf(reviewerFinding);
				if (findingId) matchedFindingIds.add(findingId);
			} else {
				matchedTitles.add(titleKey);
			}
		}
		const { verdict, normalized, invalid } = normalizeVerdict(entry.verdict);
		const fallbackId = `verdict-${String(verdictIndex).padStart(3, "0")}`;
		if (invalid !== undefined) {
			normalizationNotes.push(
				`unrecognized verdict ${JSON.stringify(invalid)} for "${title}" routed to NEEDS_HUMAN`,
			);
		} else if (normalized) {
			normalizationNotes.push(
				`verdict "${String(entry.verdict)}" normalized to ${verdict} for "${title}"`,
			);
		}
		const item = {
			findingId:
				reviewerFinding?.findingId ?? reviewerFinding?.id ?? fallbackId,
			rootCauseId:
				reviewerFinding?.rootCauseId ??
				reviewerFinding?.findingId ??
				reviewerFinding?.id ??
				fallbackId,
			title: reviewerFinding?.title ?? title,
			verdict,
			// KEEP findings carry the reviewer severity verbatim (code-enforced join);
			// WEAKEN severity reduction is the report stage's job, with cited counter-evidence.
			severity: reviewerFinding
				? reviewerFinding.severity
				: entry.finding && typeof entry.finding === "object"
					? String(entry.finding.severity ?? "unknown")
					: "unknown",
			// Identity evidence is code-preserved the same way severity is, so the
			// reduce stage cannot silently drop file/line/symbol pins.
			file: reviewerFinding?.file,
			locations: reviewerFinding
				? (reviewerFinding.locations ?? locationsOf(reviewerFinding))
				: locationsOf(
						entry.finding && typeof entry.finding === "object"
							? entry.finding
							: {},
					),
			evidenceQuotes: dedupeEvidenceQuotes([
				...(reviewerFinding?.evidenceQuotes ?? []),
				...quoteStrings(entry.evidenceQuotes),
				...quoteStrings(entry.evidenceQuote),
				...quoteStrings(entry.evidence),
			]),
			evidence: entry.evidence ?? [],
			counterEvidence: dedupeStrings(quoteStrings(entry.counterEvidence)),
			recommendedAction: entry.recommendedAction ?? "",
			...(row.batched
				? { evidenceSourceType: batchEvidenceSourceType(entry) }
				: {}),
		};
		const batchDemotionReason = row.batched
			? conservativeBatchVerdictDemotionReason(
					entry,
					row.contextPacket,
					context,
				)
			: null;
		if (batchDemotionReason) {
			partitions.needsHuman.push({
				...item,
				verdict: "NEEDS_HUMAN",
				note: batchDemotionReason,
				batchEvidenceIssue: {
					reason: batchDemotionReason,
					evidenceSourceType: batchEvidenceSourceType(entry),
				},
			});
			normalizationNotes.push(
				`batched ${verdict} for "${title}" routed to NEEDS_HUMAN: ${batchDemotionReason}`,
			);
			continue;
		}
		const isSupportItem = Boolean(supportReasonOf(item));
		const lacksIdentityEvidence =
			!isSupportItem &&
			(verdict === "KEEP" || verdict === "WEAKEN") &&
			(!Array.isArray(item.locations) ||
				item.locations.length === 0 ||
				!Array.isArray(item.evidenceQuotes) ||
				item.evidenceQuotes.length === 0);
		if (lacksIdentityEvidence) {
			partitions.needsHuman.push({
				...item,
				verdict: "NEEDS_HUMAN",
				note: "verdict lacked code-preserved locations or evidenceQuotes required for reportable keep/weaken findings",
			});
			normalizationNotes.push(
				`verdict for "${title}" lacked identity evidence; routed to NEEDS_HUMAN instead of ${verdict}`,
			);
			continue;
		}
		if (verdict === "KEEP") partitions.keep.push(item);
		else if (verdict === "WEAKEN") partitions.weaken.push(item);
		else if (verdict === "DROP") partitions.drop.push(item);
		else partitions.needsHuman.push(item);
	}

	// Findings the devil-advocate stage never returned a verdict for must not
	// vanish silently: route them to needsHuman.
	for (const finding of reviewerFindings) {
		const titleKey = normalizeText(finding.title);
		const findingId = findingIdOf(finding);
		if (batchMode) {
			if (
				findingId &&
				(matchedFindingIds.has(findingId) ||
					issueCoveredFindingIds.has(findingId))
			)
				continue;
		} else if (
			matchedTitles.has(titleKey) ||
			(findingId && issueCoveredFindingIds.has(findingId))
		) {
			continue;
		}
		missingVerdicts += 1;
		partitions.needsHuman.push({
			findingId: finding.findingId ?? finding.id,
			rootCauseId: finding.rootCauseId ?? finding.findingId ?? finding.id,
			title: String(finding.title ?? ""),
			verdict: "NEEDS_HUMAN",
			severity: finding.severity,
			file: finding.file,
			locations: finding.locations ?? locationsOf(finding),
			evidenceQuotes: finding.evidenceQuotes ?? evidenceQuotesOf(finding),
			evidence: [],
			counterEvidence: [],
			recommendedAction: "",
			note: "no devil-advocate verdict received for this finding",
		});
		normalizationNotes.push(
			`reviewer finding "${String(finding.title ?? "")}" had no verdict; routed to NEEDS_HUMAN`,
		);
	}

	const supportNotes = demoteSupportFindings(partitions, normalizationNotes);
	const mergedFindings = mergeEquivalentRootFindings(
		partitions,
		normalizationNotes,
	);

	const partitionSummary = {
		keep: partitions.keep.length,
		weaken: partitions.weaken.length,
		drop: partitions.drop.length,
		needsHuman: partitions.needsHuman.length,
		supportNotes: supportNotes.length,
		mergedFindings,
		verdictsReceived: verdictRows.length,
		batchIntegrityIssues: batchIssues.length,
		reviewerFindings: reviewerFindings.length,
		missingVerdicts,
		partialFailures: partialFailures.length,
	};
	const reportContext = buildReportContext(
		partitions,
		supportNotes,
		partialFailures,
	);

	return {
		partitions,
		supportNotes,
		reportContext,
		digest: `partition: keep=${partitionSummary.keep}, weaken=${partitionSummary.weaken}, drop=${partitionSummary.drop}, needsHuman=${partitionSummary.needsHuman}, missingVerdicts=${missingVerdicts}, partialFailures=${partialFailures.length}, supportNotes=${supportNotes.length}`,
		sourceStatusSummary: mergeSourceStatusSummary(
			directStatusSummary,
			partialFailures,
		),
		partitionSummary,
		normalizationNotes,
	};
}

export default async function findingPipeline({
	sources,
	options = {},
	context = {},
}) {
	const mode = String(options.mode ?? "");
	if (mode === "dedup") return dedupFindings(sources, context);
	if (mode === "batch-devil-advocate")
		return batchDevilAdvocateFindings(sources, options, context);
	if (mode === "partition") return partitionVerdicts(sources, options, context);
	throw new Error(
		`finding-pipeline: unknown mode "${mode}" (expected "dedup", "batch-devil-advocate", or "partition")`,
	);
}
