// Deterministic post-processing for deep-review.
//
// Four modes (options.mode):
//   "dedup"     — sources: reviewer foreach outputs ({ lens, findings, ... }).
//                 Flattens findings, normalizes shape, and drops duplicates
//                 only after concrete production-location overlap plus exact
//                 title/quote corroboration, so each distinct defect is verified
//                 once instead of once per lens.
//   "partition" — sources: dedup output + devil-advocate foreach outputs
//                 ({ finding, verdict, ... }). Normalizes verdict enums,
//                 partitions findings into keep/weaken/drop/needsHuman in code,
//                 and joins reviewer severity back onto KEEP findings so the
//                 report stage cannot silently drop findings or drift severity.
//   "report-packet" — sources: partition output. Copies only the mechanically
//                 bounded report packet into an isolated support artifact so
//                 model synthesis never receives the canonical full ledger.
//   "batch-devil-advocate" — opt-in only. Plans deterministic batches of
//                 deduped findings for a batched devil-advocate foreach. The
//                 default deep-review workflow still uses one verifier per
//                 finding.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const VERDICTS = ["KEEP", "WEAKEN", "DROP", "NEEDS_HUMAN"];
const SEVERITIES = ["critical", "high", "medium", "low", "info", "unknown"];
const SEVERITY_ALIASES = {
	blocker: "critical",
	major: "high",
	minor: "low",
	warning: "medium",
};

function canonicalSeverity(value) {
	const raw = String(value ?? "").trim().toLowerCase();
	return SEVERITIES.includes(raw) ? raw : SEVERITY_ALIASES[raw] ?? "unknown";
}

function conservativeSeverity(left, right) {
	const a = canonicalSeverity(left);
	const b = canonicalSeverity(right);
	return SEVERITIES.indexOf(a) <= SEVERITIES.indexOf(b) ? a : b;
}

const REPORT_PACKET_SCHEMA = "deep-review-report-packet-v1";
const REPORT_PACKET_MAX_CHARS = 15_000;
const REPORT_PACKET_LIMITS = Object.freeze({
	findingsPerPartition: 4,
	findingIdChars: 64,
	findingTitleChars: 220,
	severityChars: 32,
	recommendedActionChars: 220,
	partialFailures: 4,
	partialFailureSourceChars: 128,
	partialFailureStatusChars: 32,
	partialFailureDetailChars: 160,
	supportNotes: 4,
	supportNoteTitleChars: 160,
	supportNoteReasonChars: 140,
	supportingFindingChars: 96,
	normalizationNotes: 4,
	normalizationNoteChars: 200,
});

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
	const file = canonicalFilePath(raw.file);
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

function verifierEvidenceRowsOf(value) {
	const input = Array.isArray(value) ? value : [];
	const rows = [];
	const issues = [];
	if (!Array.isArray(value)) issues.push("verifier evidence was not an array");
	for (const [index, raw] of input.entries()) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			issues.push(`verifier evidence row ${index} was not an object`);
			continue;
		}
		const allowedKeys = new Set(["file", "line", "lineEnd", "symbol", "quote"]);
		if (Object.keys(raw).some((key) => !allowedKeys.has(key))) {
			issues.push(`verifier evidence row ${index} had unexpected fields`);
			continue;
		}
		if (
			typeof raw.file !== "string" ||
			typeof raw.line !== "number" ||
			typeof raw.quote !== "string" ||
			(raw.lineEnd !== undefined && typeof raw.lineEnd !== "number") ||
			(raw.symbol !== undefined && typeof raw.symbol !== "string")
		) {
			issues.push(`verifier evidence row ${index} had invalid primitive types`);
			continue;
		}
		const file = raw.file.trim();
		const quote = raw.quote.trim();
		const line = raw.line;
		const lineEnd = raw.lineEnd;
		const symbol = raw.symbol?.trim() ?? "";
		if (!file || quote.length < 8 || !Number.isInteger(line) || line < 1) {
			issues.push(`verifier evidence row ${index} had invalid file, line, or quote`);
			continue;
		}
		if (
			lineEnd !== undefined &&
			(!Number.isInteger(lineEnd) || lineEnd < line)
		) {
			issues.push(`verifier evidence row ${index} had an invalid lineEnd`);
			continue;
		}
		rows.push({
			file,
			line,
			...(lineEnd === undefined ? {} : { lineEnd }),
			...(symbol ? { symbol } : {}),
			quote,
		});
	}
	return { rows, issues };
}

function verifierEvidenceGroundingIssues(rows, context = {}) {
	if (rows.length === 0) return ["verifier supplied no structured evidence rows"];
	const issues = [];
	const repoRoot = repoRootFromContext(context);
	for (const row of rows) {
		const source = readRepoText(
			row.file,
			repoRoot,
			MAX_SOURCE_COVERAGE_FILE_BYTES,
		);
		if (!source.exists || source.tooLarge) {
			issues.push(`${row.file}:${row.line} could not be read safely`);
			continue;
		}
		const lines = source.text.split(/\r?\n/u);
		const lineEnd = row.lineEnd ?? row.line;
		if (row.line > lines.length || lineEnd > lines.length) {
			issues.push(`${row.file}:${row.line}-${lineEnd} is outside the file`);
			continue;
		}
		const scopedText = lines.slice(row.line - 1, lineEnd).join("\n");
		if (
			!scopedText
				.replace(/\r\n/gu, "\n")
				.includes(row.quote.replace(/\r\n/gu, "\n"))
		) {
			issues.push(`${row.file}:${row.line}-${lineEnd} did not contain the exact verifier quote`);
		}
	}
	return issues;
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
		...(status.sourcePath ? { sourcePath: String(status.sourcePath) } : {}),
		...(status.coverageStatus
			? { coverageStatus: String(status.coverageStatus) }
			: {}),
		...(status.extractionArtifact
			? { extractionArtifact: String(status.extractionArtifact) }
			: {}),
		...(status.itemIdentity !== undefined
			? { itemIdentity: String(status.itemIdentity) }
			: {}),
		...(status.placeholderSpecId
			? { placeholderSpecId: String(status.placeholderSpecId) }
			: {}),
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

function applySourceCoverageFailures(summary, failures) {
	const coverageFailures = asObjects(failures).map(slimSourceStatus);
	if (coverageFailures.length === 0) return summary;
	const failedSources = new Set(
		coverageFailures.map((failure) => failure.source).filter(Boolean),
	);
	const partialFailures = mergePartialFailures(
		summary?.partialFailures,
		coverageFailures,
	);
	const completed = Math.max(
		0,
		Number(summary?.completed ?? 0) - failedSources.size,
	);
	return {
		total: Math.max(
			Number(summary?.total ?? 0),
			completed + partialFailures.length,
		),
		completed,
		nonCompleted: partialFailures.length,
		partialFailures,
	};
}

// `evidence` is reviewer/verifier prose. It is intentionally not promoted to
// `evidenceQuotes`: only the explicit quote fields may participate in exact
// identity corroboration or be rendered as source evidence.
function evidenceQuotesOf(finding) {
	return dedupeEvidenceQuotes([
		...quoteStrings(finding?.evidenceQuotes),
		...quoteStrings(finding?.evidenceQuote),
	]);
}

function canonicalIdentityText(value) {
	return String(value ?? "")
		.normalize("NFKC")
		.replace(/\\r\\n?/g, "\\n")
		.replace(/\\s+/g, " ")
		.trim();
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

function canonicalFilePath(value) {
	return String(value ?? "")
		.trim()
		.replace(/\\\\/g, "/")
		.replace(/^\.\//, "");
}

function isProductionLocationFile(file) {
	const normalized = canonicalFilePath(file);
	return Boolean(
		normalized &&
		!isTestPath(normalized) &&
		!/(^|\/)(?:docs?|examples?|fixtures?|\.harness)(?:\/|$)/i.test(
			normalized,
		),
	);
}

function authorityTitle(value) {
	// This is deliberately not a display/token normalizer. Authority retains the
	// original Unicode string; exact equality is only corroboration after concrete
	// location/evidence identity, never a fuzzy identity key.
	return String(value ?? "");
}

function normalizeFinding(finding, index, provenance = {}) {
	const explicitId =
		typeof finding.findingId === "string" && finding.findingId.trim()
			? finding.findingId.trim()
			: typeof finding.id === "string" && finding.id.trim()
				? finding.id.trim()
				: `finding-${String(index + 1).padStart(3, "0")}`;
	const source = String(provenance.source ?? finding.source ?? "").trim();
	const sourceLineage = dedupeStrings([
		...(Array.isArray(finding.sourceLineage) ? finding.sourceLineage : []),
		...(source ? [source] : []),
	]);
	const explicitRootCauseId =
		typeof finding.rootCauseId === "string" && finding.rootCauseId.trim()
			? finding.rootCauseId.trim()
			: "";
	const id = explicitId;
	return {
		id,
		findingId: id,
		originalFindingId: explicitId,
		rootCauseId:
			explicitRootCauseId || `root-${String(index + 1).padStart(3, "0")}`,
		// This internal marker prevents a generated root-N fallback from being
		// mistaken for reviewer-supplied provenance during support association.
		...(explicitRootCauseId
			? { explicitRootCauseId }
			: { generatedRootCauseId: true }),
		...(typeof finding.classification === "string"
			? { classification: finding.classification.trim() }
			: {}),
		...(typeof finding.supportClassification === "string"
			? { supportClassification: finding.supportClassification.trim() }
			: {}),
		...(typeof finding.supportingFindingId === "string" && finding.supportingFindingId.trim()
			? { supportingFindingId: finding.supportingFindingId.trim() }
			: {}),
		severity: canonicalSeverity(finding.severity),
		originalSeverity: String(finding.severity ?? "unknown"),
		title: String(finding.title ?? "").trim(),
		file: canonicalFilePath(finding.file) || undefined,
		locations: locationsOf({ ...finding, file: canonicalFilePath(finding.file) }),
		evidence: finding.evidence ?? "",
		evidenceQuotes: evidenceQuotesOf(finding),
		rationale: finding.rationale ?? "",
		recommendedAction: contractText(finding.recommendedAction),
		confidence: finding.confidence ?? "unknown",
		...(finding.verifierEvidence
			? { verifierEvidence: quoteStrings(finding.verifierEvidence) }
			: {}),
		...(source ? { source } : {}),
		...(sourceLineage.length > 0 ? { sourceLineage } : {}),
	};
}

function dedupLocationOf(finding) {
	const explicitFile = canonicalFilePath(finding.file);
	if (explicitFile) return explicitFile;
	const locations = locationsOf(finding);
	const production = locations.find((location) =>
		isProductionLocationFile(location.file),
	);
	return canonicalFilePath((production ?? locations[0])?.file);
}

function concreteDedupIdentity(a, b) {
	// The reporter-selected `file` is only a hint. Identity requires a shared
	// canonical production location with numeric lines; a file field alone can
	// never make two findings duplicates.
	const rangesA = locationsOf(a)
		.map((location) => ({
			file: canonicalFilePath(location.file),
			line: Number(location.line),
			lineEnd: Number(location.lineEnd ?? location.line),
		}))
		.filter(
			(location) =>
				isProductionLocationFile(location.file) &&
				Number.isInteger(location.line) &&
				location.line > 0 &&
				Number.isInteger(location.lineEnd) &&
				location.lineEnd >= location.line,
			);
	const rangesB = locationsOf(b)
		.map((location) => ({
			file: canonicalFilePath(location.file),
			line: Number(location.line),
			lineEnd: Number(location.lineEnd ?? location.line),
		}))
		.filter(
			(location) =>
				isProductionLocationFile(location.file) &&
				Number.isInteger(location.line) &&
				location.line > 0 &&
				Number.isInteger(location.lineEnd) &&
				location.lineEnd >= location.line,
			);
	const overlaps = rangesA.some((left) =>
		rangesB.some(
			(right) =>
				left.file === right.file &&
				left.line <= right.lineEnd &&
				right.line <= left.lineEnd,
		),
	);
	if (!overlaps) return false;
	const titleA = canonicalIdentityText(a.title);
	const titleB = canonicalIdentityText(b.title);
	const exactTitle = Boolean(titleA && titleA === titleB);
	const exactQuote = evidenceQuotesOf(a).some((left) => {
		const canonicalLeft = canonicalIdentityText(left);
		return Boolean(
			canonicalLeft &&
			evidenceQuotesOf(b).some(
				(right) => canonicalLeft === canonicalIdentityText(right),
			),
		);
	});
	// A fuzzy title or prose fragment is never an identity key. Exact title or
	// explicit exact-quote corroboration is required after concrete location
	// overlap; otherwise retain both findings and their provenance.
	return exactTitle || exactQuote;
}

function ensureUniqueFindingIds(findings) {
	const counts = new Map();
	return findings.map((finding) => {
		const base = finding.findingId;
		const occurrence = (counts.get(base) ?? 0) + 1;
		counts.set(base, occurrence);
		if (occurrence === 1) return finding;
		const id = `${base}~${occurrence}`;
		return { ...finding, id, findingId: id };
	});
}

function mergeDedupFinding(primary, duplicate) {
	const incomingEvidence = String(duplicate.evidence ?? "");
	if (incomingEvidence.length > String(primary.evidence ?? "").length)
		primary.evidence = duplicate.evidence;
	primary.locations = dedupeLocations([
		...(primary.locations ?? []),
		...(duplicate.locations ?? []),
	]);
	primary.evidenceQuotes = dedupeEvidenceQuotes([
		...(primary.evidenceQuotes ?? []),
		...(duplicate.evidenceQuotes ?? []),
	]);
	primary.sourceLineage = dedupeStrings([
		...(primary.sourceLineage ?? []),
		...(duplicate.sourceLineage ?? []),
	]);
	primary.counterEvidence = dedupeStrings([
		...quoteStrings(primary.counterEvidence),
		...quoteStrings(duplicate.counterEvidence),
	]);
	primary.rationale = dedupeStrings([primary.rationale, duplicate.rationale]).join(" ");
	primary.recommendedAction = primary.recommendedAction || duplicate.recommendedAction;
	primary.sourceCoverageComplete = Boolean(
		primary.sourceCoverageComplete && duplicate.sourceCoverageComplete,
	);
	primary.sourceCoverageIssuePaths = dedupeStrings([
		...(primary.sourceCoverageIssuePaths ?? []),
		...(duplicate.sourceCoverageIssuePaths ?? []),
	]);
	if (duplicate.reviewerIdentity) primary.reviewerIdentities = dedupeOwners([
		...(primary.reviewerIdentities ?? (primary.reviewerIdentity ? [primary.reviewerIdentity] : [])),
		duplicate.reviewerIdentity,
	]);
	primary.severity = conservativeSeverity(primary.severity, duplicate.severity);
	const existingIds = new Set([
		primary.findingId,
		...(primary.mergedFindings ?? []).map((entry) => entry.findingId),
	]);
	const appendedLineage = mergedFindingLineage(duplicate).map((entry, index) => {
		const base = String(entry.findingId ?? `merged-${index + 1}`);
		let id = base;
		let suffix = 2;
		while (existingIds.has(id)) id = `${base}~merged-${suffix++}`;
		existingIds.add(id);
		return id === base ? entry : { ...entry, findingId: id };
	});
	primary.mergedFindings = [
		...(primary.mergedFindings ?? []),
		...appendedLineage,
	];
	return primary;
}

function nonBlankStringArray(value) {
	return Array.isArray(value)
		? value.filter((entry) => typeof entry === "string" && entry.trim())
		: [];
}

const USABLE_SOURCE_COVERAGE = new Set(["read", "ocr-extracted"]);
const OCR_BINDING_SCHEMA = "deep-review-ocr-binding-v1";
const TRUSTED_OCR_ARTIFACT_ROOT = ".pi/ocr-artifacts/";
const MAX_SOURCE_COVERAGE_FILE_BYTES = 20_000_000;
const MAX_OCR_BINDING_FILE_BYTES = 20_000;

function coveragePathLabel(value) {
	const raw = String(value ?? "");
	if (!raw) return "(missing path)";
	return raw.trim() ? raw : JSON.stringify(raw);
}

function parseSourceCoveragePointer(value) {
	const raw = String(value ?? "");
	if (!raw || raw !== raw.trim()) return null;
	const match = /^(.*):(\d+)(?:-(\d+))?$/u.exec(raw);
	if (!match) return { file: raw };
	const file = match[1];
	const line = Number(match[2]);
	const lineEnd = Number(match[3] ?? match[2]);
	if (
		!file ||
		file !== file.trim() ||
		!Number.isInteger(line) ||
		!Number.isInteger(lineEnd) ||
		line < 1 ||
		lineEnd < line
	) {
		return null;
	}
	return { file, line, lineEnd };
}

function trustedOcrArtifactPathIssue(artifactPath, repoRoot) {
	const relative = safeRepoRelativePath(artifactPath, repoRoot);
	if (!relative || !relative.startsWith(TRUSTED_OCR_ARTIFACT_ROOT)) {
		return "OCR artifact is outside the trusted control-plane root";
	}
	try {
		const rootSegments = TRUSTED_OCR_ARTIFACT_ROOT.split("/").filter(Boolean);
		let current = path.resolve(repoRoot);
		for (const segment of rootSegments) {
			current = path.join(current, segment);
			const stat = fs.lstatSync(current);
			if (stat.isSymbolicLink() || !stat.isDirectory()) {
				return "trusted OCR root contains a symlink or non-directory component";
			}
		}
		const trustedRoot = current;
		const realTrustedRoot = fs.realpathSync(trustedRoot);
		const absolute = path.resolve(repoRoot, relative);
		const realArtifact = fs.realpathSync(absolute);
		if (!pathIsInsideRoot(realTrustedRoot, realArtifact)) {
			return "OCR artifact resolves outside the trusted control-plane root";
		}
		const nested = path.relative(trustedRoot, absolute).split(path.sep);
		current = trustedRoot;
		for (const segment of nested.slice(0, -1)) {
			current = path.join(current, segment);
			const stat = fs.lstatSync(current);
			if (stat.isSymbolicLink() || !stat.isDirectory()) {
				return "OCR artifact path contains a symlinked directory";
			}
		}
		return "";
	} catch {
		return "trusted OCR artifact path is unavailable";
	}
}

function trustedOcrFileIssue(file) {
	if (file.nlink !== 1) return "trusted OCR file must have exactly one link";
	if ((file.mode & 0o022) !== 0) {
		return "trusted OCR file must not be group- or world-writable";
	}
	if (typeof process.getuid === "function" && file.uid !== process.getuid()) {
		return "trusted OCR file must be owned by the current user";
	}
	return "";
}

function ocrBindingIssue(row, path, source, artifact, repoRoot) {
	const bindingPath = `${row.artifact}.binding.json`;
	const bindingFile = readRepoText(
		bindingPath,
		repoRoot,
		MAX_OCR_BINDING_FILE_BYTES,
	);
	if (!bindingFile.exists || bindingFile.tooLarge) {
		return "OCR source binding is unavailable";
	}
	const bindingTrustIssue = trustedOcrFileIssue(bindingFile);
	if (bindingTrustIssue) return bindingTrustIssue;
	let binding;
	try {
		binding = JSON.parse(bindingFile.text);
	} catch {
		return "OCR source binding is not valid JSON";
	}
	if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
		return "OCR source binding has invalid shape";
	}
	const expected = {
		schema: OCR_BINDING_SCHEMA,
		sourcePath: path,
		sourceSha256: source.sha256,
		artifactPath: row.artifact,
		artifactSha256: artifact.sha256,
	};
	const expectedKeys = Object.keys(expected).sort();
	const actualKeys = Object.keys(binding).sort();
	if (
		expectedKeys.length !== actualKeys.length ||
		expectedKeys.some((key, index) => key !== actualKeys[index])
	) {
		return "OCR source binding has invalid fields";
	}
	for (const [key, value] of Object.entries(expected)) {
		if (binding[key] !== value) return `OCR source binding mismatched ${key}`;
	}
	return "";
}

function exactSourceQuoteIssue(row, path, context) {
	if (!row.evidence) return "content quote missing";
	const pointer = parseSourceCoveragePointer(path);
	if (!pointer) return "required source pointer is invalid";
	const repoRoot = repoRootFromContext(context);
	const source = readRepoText(
		pointer.file,
		repoRoot,
		MAX_SOURCE_COVERAGE_FILE_BYTES,
	);
	if (!source.exists) return "required source file is unavailable";
	if (row.status === "ocr-extracted") {
		if (source.tooLarge) return "required OCR source is too large to bind";
		if (!row.artifact) return "OCR artifact missing";
		if (row.artifact !== row.artifact.trim()) return "OCR artifact path is invalid";
		const artifactPathIssue = trustedOcrArtifactPathIssue(
			row.artifact,
			repoRoot,
		);
		if (artifactPathIssue) return artifactPathIssue;
		const artifact = readRepoText(
			row.artifact,
			repoRoot,
			MAX_SOURCE_COVERAGE_FILE_BYTES,
		);
		if (!artifact.exists || artifact.tooLarge) {
			return "OCR artifact is unavailable";
		}
		const artifactTrustIssue = trustedOcrFileIssue(artifact);
		if (artifactTrustIssue) return artifactTrustIssue;
		const bindingIssue = ocrBindingIssue(
			row,
			path,
			source,
			artifact,
			repoRoot,
		);
		if (bindingIssue) return bindingIssue;
		return artifact.text.replace(/\r\n/gu, "\n").includes(row.evidence.replace(/\r\n/gu, "\n"))
			? ""
			: "OCR quote was not found in artifact";
	}
	if (source.tooLarge) return "required source is too large to verify";
	let scopedText = source.text;
	if (pointer.line !== undefined) {
		const lines = source.text.split(/\r?\n/u);
		if (pointer.line > lines.length) return "required source range is unavailable";
		const end = Math.min(pointer.lineEnd, lines.length);
		scopedText = lines.slice(pointer.line - 1, end).join("\n");
	}
	return scopedText.replace(/\r\n/gu, "\n").includes(row.evidence.replace(/\r\n/gu, "\n"))
		? ""
		: "content quote was not found in required source range";
}

function assessSourceCoverage(requiredValue, coverageValue, context = {}) {
	const issues = [];
	const requiredPaths = [];
	const seenRequired = new Set();
	for (const value of Array.isArray(requiredValue) ? requiredValue : []) {
		const path = typeof value === "string" ? value : String(value ?? "");
		if (!path || path !== path.trim()) {
			issues.push({
				path: coveragePathLabel(path),
				status: "invalid",
				reason: "planned coverage path is blank or whitespace-padded",
			});
			continue;
		}
		if (seenRequired.has(path)) {
			issues.push({
				path,
				status: "duplicate",
				reason: "planned coverage path is duplicated",
			});
			continue;
		}
		seenRequired.add(path);
		requiredPaths.push(path);
	}
	if (requiredPaths.length === 0 && issues.length === 0) {
		return { issues: [], rows: [] };
	}
	const rows = asObjects(coverageValue).map((row) => ({
		path: typeof row.path === "string" ? row.path : String(row.path ?? ""),
		status: String(row.status ?? "").trim(),
		evidence: String(row.evidence ?? "").trim(),
		artifact:
			typeof row.artifact === "string"
				? row.artifact
				: String(row.artifact ?? ""),
		reason: String(row.reason ?? "").trim(),
	}));
	const requiredSet = new Set(requiredPaths);
	for (const path of requiredPaths) {
		const matches = rows.filter((row) => row.path === path);
		if (matches.length === 0) {
			issues.push({ path, status: "missing", reason: "coverage row missing" });
			continue;
		}
		if (matches.length > 1) {
			issues.push({ path, status: "duplicate", reason: "coverage row duplicated" });
			continue;
		}
		const row = matches[0];
		if (!USABLE_SOURCE_COVERAGE.has(row.status)) {
			issues.push({
				path,
				status: row.status || "invalid",
				reason: row.reason || "required source content was not read",
			});
			continue;
		}
		const evidenceIssue = exactSourceQuoteIssue(row, path, context);
		if (evidenceIssue) {
			issues.push({ path, status: row.status, reason: evidenceIssue });
		}
	}
	for (const row of rows) {
		if (!row.path || !requiredSet.has(row.path)) {
			issues.push({
				path: coveragePathLabel(row.path),
				status: row.status || "invalid",
				reason: "unexpected coverage row",
			});
		}
	}
	return { issues, rows };
}

function sourceCoverageFailure(sourceId, reviewerId, assessment) {
	const issuePaths = dedupeStrings(
		assessment.issues.map((issue) => coveragePathLabel(issue.path)),
	);
	const statuses = dedupeStrings(
		assessment.issues.map((issue) => issue.status).filter(Boolean),
	);
	const rawIssuePathSet = new Set(
		assessment.issues.map((issue) => String(issue.path ?? "")),
	);
	const extractionArtifacts = dedupeStrings(
		assessment.rows
			.filter((row) => rawIssuePathSet.has(row.path))
			.map((row) => row.artifact)
			.filter(Boolean),
	);
	const details = assessment.issues
		.map(
			(issue) =>
				`${coveragePathLabel(issue.path)}: ${issue.status} (${issue.reason})`,
		)
		.join("; ")
		.slice(0, 500);
	return {
		source: sourceId,
		displayName: sourceId,
		specId: sourceId,
		stageId: String(sourceId).split(".")[0],
		status: "source_coverage_incomplete",
		statusDetail: `${reviewerId || "unknown reviewer"}: ${details}`.slice(0, 500),
		errorType: "source_coverage",
		sourcePath: (issuePaths.join(", ") || "(unknown source)").slice(0, 500),
		coverageStatus: (statuses.join(", ") || "invalid").slice(0, 120),
		...(extractionArtifacts.length > 0
			? { extractionArtifact: extractionArtifacts.join(", ").slice(0, 500) }
			: {}),
	};
}

function idArray(value) {
	return dedupeStrings(
		Array.isArray(value)
			? value.filter((entry) => typeof entry === "string")
			: [],
	);
}

function reviewerFindingShapeIsValid(finding) {
	return Boolean(
		finding &&
		typeof finding === "object" &&
		typeof finding.title === "string" &&
		finding.title.trim() &&
		typeof finding.file === "string" &&
		finding.file.trim() &&
		Array.isArray(finding.locations) &&
		finding.locations.length > 0 &&
		finding.locations.every(
			(location) =>
				location &&
				typeof location === "object" &&
				typeof location.file === "string" &&
				location.file.trim(),
		) &&
		typeof finding.evidence === "string" &&
		finding.evidence.trim() &&
		Array.isArray(finding.evidenceQuotes) &&
		finding.evidenceQuotes.length > 0 &&
		finding.evidenceQuotes.every(
			(quote) => typeof quote === "string" && quote.trim(),
		) &&
		typeof finding.rationale === "string" &&
		finding.rationale.trim() &&
		typeof finding.recommendedAction === "string" &&
		finding.recommendedAction.trim() &&
		typeof finding.confidence === "string" &&
		["high", "medium", "low", "unknown"].includes(finding.confidence)
	);
}

function sourceStatusesForAlias(statuses, sourceId) {
	return statuses.filter(
		(status) => status.source === sourceId || status.specId === sourceId,
	);
}

function ownerFromStatus(status) {
	return {
		source: String(status.source ?? ""),
		specId: String(status.specId ?? ""),
		taskId: String(status.taskId ?? ""),
		itemIdentity: String(status.itemIdentity ?? ""),
		placeholderSpecId: String(status.placeholderSpecId ?? ""),
	};
}

function ownerComplete(owner) {
	return Boolean(
		owner &&
		owner.source &&
		owner.specId &&
		owner.taskId &&
		owner.itemIdentity &&
		owner.placeholderSpecId,
	);
}

function dedupeOwners(owners) {
	const seen = new Set();
	return owners.filter((owner) => {
		const key = `${owner.source}|${owner.specId}|${owner.taskId}|${owner.itemIdentity}|${owner.placeholderSpecId}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function reviewerStatusesForAlias(statuses, sourceId) {
	// Keep contradictory rows in the candidate set. Filtering wrong-stage rows
	// out would turn an owned-but-corrupt result into an apparently unowned one.
	return sourceStatusesForAlias(statuses, sourceId);
}

function exactReviewerStatus(status, sourceId, lens) {
	const expectedSpec = sourceId === "reviewers"
		? status?.specId === `reviewers.${lens}`
		: status?.specId === sourceId;
	return Boolean(
		status &&
		status.source === sourceId &&
		expectedSpec &&
		status.stageId === "reviewers" &&
		status.status === "completed" &&
		status.itemIdentity === lens &&
		status.placeholderSpecId === "reviewers.item" &&
		typeof status.taskId === "string" &&
		status.taskId.trim(),
	);
}

function verifierStatusesForAlias(statuses, sourceId) {
	// Do not filter by the claimed verifier domain here. A status with a
	// swapped/wrong stage must remain visible to the exact-owner gate instead
	// of disappearing and allowing the result to join without an owner.
	return sourceStatusesForAlias(statuses, sourceId);
}

function exactDevilAdvocateStatus(status, identity, sourceId = "") {
	const expectedSpecId = sourceId && sourceId.startsWith("devil-advocate.")
		? sourceId
		: `devil-advocate.${identity}`;
	return Boolean(
		status &&
		status.status === "completed" &&
		status.source === sourceId &&
		status.stageId === "devil-advocate" &&
		status.specId === expectedSpecId &&
		status.itemIdentity === identity &&
		status.placeholderSpecId === "devil-advocate.item" &&
		typeof status.taskId === "string" &&
		status.taskId.trim(),
	);
}

function canonicalTriageSourceEntries(sources) {
	return Object.entries(sources ?? {}).filter(([sourceId]) =>
		sourceId === "triage" || sourceId.startsWith("triage."),
	);
}

function findCanonicalTriageSource(sources) {
	const matches = canonicalTriageSourceEntries(sources);
	if (matches.length > 1) {
		throw new Error(
			`deep-review: ambiguous triage source (${matches.map(([sourceId]) => sourceId).join(", ")})`,
		);
	}
	return matches[0] ?? null;
}

function isTriageSource(sourceId) {
	return sourceId === "triage" || sourceId.startsWith("triage.");
}

function reviewerCoverageLedger(sources, context, coverageIssues) {
	const rawStatuses = sourceStatusesOf(context);
	const statuses = rawStatuses.map(slimSourceStatus);
	const triageSource = findCanonicalTriageSource(sources);
	const plannedLensIds = idArray(
		triageSource?.[1]?.reviewLenses?.map((lens) => lens?.id),
	);
	const contextPlan = idArray(context?.plannedLensIds);
	for (const id of contextPlan) if (!plannedLensIds.includes(id)) plannedLensIds.push(id);

	const triageLenses = asObjects(triageSource?.[1]?.reviewLenses);
	const lensById = new Map(
		triageLenses.map((lens) => [String(lens.id ?? "").trim(), lens]),
	);
	const reviewerEntries = Object.entries(sources ?? {}).filter(
		([sourceId, source]) => !isTriageSource(sourceId, source),
	);
	const materializedReviewerIds = [];
	const attestedLensIds = [];
	const materializedReviewerSourceIds = [];
	const validAttestationSourceIds = [];
	const ownerMap = [];
	const sourceCoverageFailures = [];
	let ownerBindingValid = true;
	for (const [sourceId, source] of reviewerEntries) {
		const owners = reviewerStatusesForAlias(rawStatuses, sourceId);
		const owner = owners.length === 1 ? ownerFromStatus(owners[0]) : null;
		const findings = findingsOf(source);
		const evidenceChecked = nonBlankStringArray(source?.evidenceChecked);
		const noIssueNotes = nonBlankStringArray(source?.noIssueNotes);
		const reasons = [];
		if (owners.length !== 1) {
			ownerBindingValid = false;
			if (owners.length > 1) reasons.push("reviewer_alias_not_bound_to_exactly_one_status");
		}
		if (owner && !owner.itemIdentity)
			reasons.push("reviewer_materialized_identity_missing");
		else if (owner && (!ownerComplete(owner) || !exactReviewerStatus(owners[0], sourceId, String(source?.lens ?? "").trim())))
			reasons.push("reviewer_materialized_status_identity_mismatch");
		if (owner && (owner.placeholderSpecId !== "reviewers.item" || owner.itemIdentity !== String(source?.lens ?? "").trim()))
			reasons.push("reviewer_lens_identity_mismatch");
		if (!Array.isArray(source?.findings)) reasons.push("reviewer_control_missing_findings_array");
		if (evidenceChecked.length === 0) reasons.push("reviewer_control_missing_evidenceChecked_attestation");
		if (findings.length === 0 && noIssueNotes.length === 0)
			reasons.push("empty_reviewer_output_missing_noIssueNotes_attestation");
		const lensId = String(source?.lens ?? "").trim();
		if (!lensId) reasons.push("reviewer_control_missing_materialized_lens");
		const sourceCoverage = assessSourceCoverage(
			lensById.get(lensId)?.evidenceToInspect,
			source?.sourceCoverage,
			context,
		);
		if (sourceCoverage.issues.length > 0) {
			sourceCoverageFailures.push(
				sourceCoverageFailure(sourceId, lensId, sourceCoverage),
			);
		}
		if (owner) {
			materializedReviewerIds.push(owner.itemIdentity);
			materializedReviewerSourceIds.push(sourceId);
			ownerMap.push(owner);
			if (owners[0].status === "completed" && reasons.length === 0) attestedLensIds.push(owner.itemIdentity);
		}
		if (reasons.length === 0) validAttestationSourceIds.push(sourceId);
		else coverageIssues.push({ source: sourceId, reason: reasons[0], reasons });
	}
	for (const status of rawStatuses) {
		const isReviewer = status.stageId === "reviewers" || String(status.specId ?? "").startsWith("reviewers.");
		if (!isReviewer) continue;
		const identity = String(status.itemIdentity ?? "").trim();
		if (status.status === "completed" && !reviewerEntries.some(([id]) => id === status.source || id === status.specId))
			coverageIssues.push({ source: status.source ?? status.specId, reason: "materialized_reviewer_missing_control_output" });
	}
	const materializedSet = new Set(materializedReviewerIds);
	const plannedSet = new Set(plannedLensIds);
	const attestedSet = new Set(attestedLensIds);
	const missingPlannedLensIds = plannedLensIds.filter((id) => !materializedSet.has(id));
	const unexpectedMaterializedReviewerIds = materializedReviewerIds.filter((id) => !plannedSet.has(id));
	const duplicateMaterializedReviewerIds = materializedReviewerIds.filter((id, index) => materializedReviewerIds.indexOf(id) !== index);
	const missingAttestedLensIds = plannedLensIds.filter((id) => !attestedSet.has(id));
	const unexpectedAttestedLensIds = attestedLensIds.filter((id) => !plannedSet.has(id));
	if (missingPlannedLensIds.length) coverageIssues.push({ source: "reviewers", reason: "planned_lens_missing_materialized_reviewer", missingLensIds: missingPlannedLensIds });
	if (missingAttestedLensIds.length) coverageIssues.push({ source: "reviewers", reason: "materialized_reviewer_missing_attestation", missingLensIds: missingAttestedLensIds });
	if (unexpectedMaterializedReviewerIds.length) coverageIssues.push({ source: "reviewers", reason: "materialized_reviewer_not_in_planned_lenses", unexpectedReviewerIds: unexpectedMaterializedReviewerIds });
	if (unexpectedAttestedLensIds.length) coverageIssues.push({ source: "reviewers", reason: "attested_lens_not_in_planned_lenses", unexpectedLensIds: unexpectedAttestedLensIds });
	if (duplicateMaterializedReviewerIds.length) coverageIssues.push({ source: "reviewers", reason: "duplicate_materialized_reviewer_identity", duplicateReviewerIds: [...new Set(duplicateMaterializedReviewerIds)] });
	const uniqueIssues = [];
	const seen = new Set();
	for (const issue of coverageIssues) {
		const key = `${issue.source ?? ""}|${issue.reason ?? ""}`;
		if (!seen.has(key)) { seen.add(key); uniqueIssues.push(issue); }
	}
	coverageIssues.splice(0, coverageIssues.length, ...uniqueIssues);
	return {
		plannedLensIds,
		materializedReviewerIds: idArray(materializedReviewerIds),
		attestedLensIds: idArray(attestedLensIds),
		materializedReviewerSourceIds: idArray(materializedReviewerSourceIds),
		validAttestationSourceIds: idArray(validAttestationSourceIds),
		ownerMap,
		invalidAttestations: uniqueIssues.map((issue) => ({ ...issue })),
		missingPlannedLensIds,
		missingAttestedLensIds,
		unexpectedMaterializedReviewerIds,
		unexpectedAttestedLensIds,
		duplicateMaterializedReviewerIds: [...new Set(duplicateMaterializedReviewerIds)],
		setEquality: ownerBindingValid && sameSet(plannedLensIds, materializedReviewerIds) && sameSet(plannedLensIds, attestedLensIds),
		sourceStatuses: statuses,
		sourceCoverageFailures,
	};
}

function sameSet(left, right) {
	const a = new Set(left);
	const b = new Set(right);
	return a.size === b.size && [...a].every((value) => b.has(value));
}

function dedupFindings(sources, context = {}) {
	// Resolve canonical triage before folding reviewer rows; multiple aliases are
	// ambiguous even when their lens lists happen to agree.
	findCanonicalTriageSource(sources);
	const normalized = [];
	const findingValidity = [];
	const coverageIssues = [];
	for (const [sourceId, source] of Object.entries(sources ?? {})) {
		if (isTriageSource(sourceId, source)) continue;
		const findings = findingsOf(source);
		for (const finding of findings) {
			findingValidity.push({
				source: sourceId,
				valid: reviewerFindingShapeIsValid(finding),
			});
			normalized.push(normalizeFinding(finding, normalized.length, { source: sourceId }));
		}
	}
	const reviewerCoverage = reviewerCoverageLedger(sources, context, coverageIssues);
	const sourceCoverageFailuresBySource = new Map();
	for (const failure of reviewerCoverage.sourceCoverageFailures) {
		const failures = sourceCoverageFailuresBySource.get(failure.source) ?? [];
		failures.push(failure);
		sourceCoverageFailuresBySource.set(failure.source, failures);
	}
	for (const finding of normalized) {
		const failures = sourceCoverageFailuresBySource.get(finding.source) ?? [];
		finding.sourceCoverageComplete = failures.length === 0;
		finding.sourceCoverageIssuePaths = dedupeStrings(
			failures.map((failure) => failure.sourcePath),
		);
	}
	// Allocate occurrence-safe IDs before any deduplication. This makes raw IDs a
	// lossless multiset rather than allowing duplicate reviewer echoes to cancel.
	const occurrenceSafe = ensureUniqueFindingIds(normalized);
	normalized.splice(0, normalized.length, ...occurrenceSafe);
	const ownerBySource = new Map(
		reviewerCoverage.ownerMap.map((owner) => [owner.source, owner]),
	);
	for (const finding of normalized) {
		const owner = ownerBySource.get(finding.source);
		if (owner) finding.reviewerIdentity = { ...owner };
	}
	const invalidFindingIndexesBySource = new Map();
	for (const [index, validity] of findingValidity.entries()) {
		if (validity.valid) continue;
		const indexes = invalidFindingIndexesBySource.get(validity.source) ?? [];
		indexes.push(index);
		invalidFindingIndexesBySource.set(validity.source, indexes);
	}
	for (const [source, indexes] of invalidFindingIndexesBySource) {
		coverageIssues.push({
			source,
			reason: "reviewer_control_invalid_finding_shape",
			findingIndexes: indexes,
		});
	}
	const reviewerCoverageIssuesBySource = new Map();
	for (const issue of coverageIssues) {
		const existing = reviewerCoverageIssuesBySource.get(issue.source);
		if (existing) {
			existing.reasons = dedupeStrings([
				...(existing.reasons ?? [existing.reason]),
				issue.reason,
			]);
			continue;
		}
		reviewerCoverageIssuesBySource.set(issue.source, { ...issue });
	}
	coverageIssues.splice(
		0,
		coverageIssues.length,
		...reviewerCoverageIssuesBySource.values(),
	);
	const statusSummary = applySourceCoverageFailures(
		sourceStatusSummary(sourceStatusesOf(context)),
		reviewerCoverage.sourceCoverageFailures,
	);
	const kept = [];
	const duplicates = [];
	for (const finding of normalized) {
		const existing = kept.find((candidate) =>
			concreteDedupIdentity(candidate, finding),
		);
		if (!existing) {
			kept.push(finding);
			continue;
		}
		const previousTitle = existing.title;
		mergeDedupFinding(existing, finding);
		duplicates.push({
			file: dedupLocationOf(existing),
			keptFindingId: existing.findingId,
			keptTitle: previousTitle,
			droppedFindingId: finding.findingId,
			droppedTitle: finding.title,
		});
	}
	const findings = ensureUniqueFindingIds(kept);
	const rawFindingIds = normalized.map((finding) => finding.findingId);
	const dedupFindingIds = findings.map((finding) => finding.findingId);
	const reviewerLedger = {
		...reviewerCoverage,
		complete: coverageIssues.length === 0 && reviewerCoverage.setEquality,
		invalidAttestations: coverageIssues.map((issue) => ({ ...issue })),
		rawFindingIds,
		dedupFindingIds,
		validFindingIds: normalized
			.filter((_, index) => findingValidity[index]?.valid)
			.map((finding) => finding.findingId)
			.filter((id) => typeof id === "string" && id.trim()),
		invalidFindingIds: normalized
			.filter((_, index) => !findingValidity[index]?.valid)
			.map((finding) => finding.findingId)
			.filter((id) => typeof id === "string" && id.trim()),
	};
	return {
		findings,
		coverageIssues,
		reviewerLedger,
		rawFindingIds,
		dedupFindingIds,
		digest: `dedup: raw=${normalized.length}, unique=${findings.length}, duplicates=${duplicates.length}, partialFailures=${statusSummary.nonCompleted}`,
		sourceStatusSummary: statusSummary,
		dedupSummary: {
			complete: coverageIssues.length === 0 && reviewerCoverage.setEquality,
			rawCount: normalized.length,
			uniqueCount: findings.length,
			duplicateCount: duplicates.length,
			rawFindingIds,
			dedupFindingIds,
			dispositionFindingIds: dedupFindingIds,
			supportFindingIds: [],
			lineageFindingIds: findings.flatMap((finding) => mergedFindingLineage(finding).slice(1).map(findingIdOf)),
			duplicates,
		},
	};
}

function findSource(sources, stageId) {
	const matches = Object.entries(sources ?? {}).filter(
		([specId]) => specId === stageId || specId.startsWith(`${stageId}.`),
	);
	if (matches.length > 1) {
		throw new Error(
			`deep-review: ambiguous ${stageId} source (${matches.map(([specId]) => specId).join(", ")})`,
		);
	}
	return matches[0]?.[1] ?? null;
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

function readRepoText(file, repoRoot = process.cwd(), maxBytes = Infinity) {
	const relative = safeRepoRelativePath(file, repoRoot);
	if (!relative) return { relative: null, exists: false, text: "" };
	const root = path.resolve(repoRoot);
	const absolute = path.resolve(root, relative);
	let descriptor;
	try {
		const realRoot = fs.realpathSync(root);
		const initialRealAbsolute = fs.realpathSync(absolute);
		if (!pathIsInsideRoot(realRoot, initialRealAbsolute)) {
			return { relative, exists: false, text: "" };
		}
		descriptor = fs.openSync(
			absolute,
			fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
		);
		const openedStat = fs.fstatSync(descriptor);
		const currentRealAbsolute = fs.realpathSync(absolute);
		if (!pathIsInsideRoot(realRoot, currentRealAbsolute)) {
			return { relative, exists: false, text: "" };
		}
		const currentStat = fs.statSync(currentRealAbsolute);
		if (
			!openedStat.isFile() ||
			openedStat.dev !== currentStat.dev ||
			openedStat.ino !== currentStat.ino
		) {
			return { relative, exists: false, text: "" };
		}
		const finiteLimit = Number.isFinite(maxBytes)
			? Math.max(0, Math.floor(maxBytes))
			: Infinity;
		if (openedStat.size > finiteLimit) {
			return { relative, exists: true, text: "", tooLarge: true };
		}
		const chunks = [];
		let totalBytes = 0;
		while (true) {
			const remaining = Number.isFinite(finiteLimit)
				? finiteLimit - totalBytes + 1
				: 64 * 1024;
			if (remaining <= 0) {
				return { relative, exists: true, text: "", tooLarge: true };
			}
			const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
			const bytesRead = fs.readSync(
				descriptor,
				buffer,
				0,
				buffer.length,
				null,
			);
			if (bytesRead === 0) break;
			totalBytes += bytesRead;
			if (totalBytes > finiteLimit) {
				return { relative, exists: true, text: "", tooLarge: true };
			}
			chunks.push(buffer.subarray(0, bytesRead));
		}
		const finalStat = fs.fstatSync(descriptor);
		const finalRealAbsolute = fs.realpathSync(absolute);
		if (!pathIsInsideRoot(realRoot, finalRealAbsolute)) {
			return { relative, exists: false, text: "" };
		}
		const finalPathStat = fs.statSync(finalRealAbsolute);
		if (
			finalStat.dev !== openedStat.dev ||
			finalStat.ino !== openedStat.ino ||
			finalPathStat.dev !== openedStat.dev ||
			finalPathStat.ino !== openedStat.ino ||
			finalStat.size !== openedStat.size ||
			finalStat.size !== totalBytes ||
			finalStat.mtimeMs !== openedStat.mtimeMs ||
			finalStat.ctimeMs !== openedStat.ctimeMs
		) {
			return { relative, exists: false, text: "" };
		}
		const bytes = Buffer.concat(chunks, totalBytes);
		return {
			relative,
			exists: true,
			text: bytes.toString("utf8"),
			sha256: createHash("sha256").update(bytes).digest("hex"),
			mode: finalStat.mode,
			uid: finalStat.uid,
			nlink: finalStat.nlink,
		};
	} catch {
		return { relative, exists: false, text: "" };
	} finally {
		if (descriptor !== undefined) {
			try {
				fs.closeSync(descriptor);
			} catch {
				// The read result already failed closed if descriptor state drifted.
			}
		}
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
	try {
		return JSON.parse(JSON.stringify(packet));
	} catch (error) {
		throw error;
	}
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
	if (typeof value === "string" && VERDICTS.includes(value))
		return { verdict: value, normalized: false };
	return {
		verdict: "NEEDS_HUMAN",
		normalized: false,
		invalid: value,
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

function isTestPath(file) {
	return (
		/(^|\/)tests?\//.test(file) ||
		/(^|\/)test\//.test(file) ||
		/\.test\.[cm]?[jt]sx?$/.test(file)
	);
}

const SUPPORT_CLASSIFICATIONS = new Set(["support", "support-only"]);
const MATERIAL_CLASSIFICATIONS = new Set(["behavioral", "material"]);

function explicitClassificationOf(item) {
	const values = [item?.classification, item?.supportClassification]
		.filter((value) => typeof value === "string" && value.trim())
		.map((value) => value.trim().toLowerCase());
	if (values.length === 0) return null;
	if (values.some((value) => !SUPPORT_CLASSIFICATIONS.has(value) && !MATERIAL_CLASSIFICATIONS.has(value))) return "ambiguous";
	const classifications = new Set(values.map((value) =>
		SUPPORT_CLASSIFICATIONS.has(value) ? "support" : "material",
	));
	return classifications.size === 1 ? [...classifications][0] : "ambiguous";
}

function supportOnlyPathOf(item) {
	const files = [
		item?.file,
		...asObjects(item?.locations).map((location) => location.file),
	]
		.map(canonicalFilePath)
		.filter(Boolean);
	return files.length > 0 && files.every((file) => !isProductionLocationFile(file));
}

// Classification is deliberately structural. Do not infer support status from
// words in a title, prose, or quote: a production defect may be described as
// stale/dead/fallback/test/docs and must remain reportable.
function supportReasonOf(item) {
	const classification = explicitClassificationOf(item);
	if (classification === "support")
		return supportOnlyPathOf(item) ? "explicit support classification" : null;
	if (classification === "material" || classification === "ambiguous") return null;
	if (supportOnlyPathOf(item)) return "support-only repository path";
	return null;
}

function supportNoteFromItem(item, reason, relatedRoot) {
	return {
		findingId: item.findingId ?? item.id,
		originalFindingId: item.originalFindingId ?? item.findingId ?? item.id,
		rootCauseId: item.rootCauseId ?? item.findingId ?? item.id,
		title: item.title,
		severity: item.severity,
		file: item.file,
		locations: item.locations,
		source: item.source ?? "unknown",
		...(item.classification ? { classification: item.classification } : {}),
		...(item.supportClassification ? { supportClassification: item.supportClassification } : {}),
		...(item.reviewerIdentity ? { reviewerIdentity: { ...item.reviewerIdentity } } : {}),
		...(item.verifierOwner ? { verifierOwner: { ...item.verifierOwner } } : {}),
		sourceLineage: Array.isArray(item.sourceLineage) && item.sourceLineage.length > 0
			? [...item.sourceLineage]
			: [item.source ?? "unknown"],
		mergedLineage: Array.isArray(item.mergedFindings)
			? structuredClone(item.mergedFindings)
			: Array.isArray(item.mergedLineage)
				? structuredClone(item.mergedLineage)
				: [],
		mergedFindings: Array.isArray(item.mergedFindings)
			? structuredClone(item.mergedFindings)
			: Array.isArray(item.mergedLineage)
				? structuredClone(item.mergedLineage)
				: [],
		evidenceQuotes: item.evidenceQuotes,
		reason,
		supportingFindingId:
			(typeof item.supportingFindingId === "string" && item.supportingFindingId.trim()
				? item.supportingFindingId.trim()
				: relatedRoot?.findingId ?? relatedRoot?.id),
		...(relatedRoot ? { supportingFindingOf: relatedRoot.title } : {}),
		evidence: item.evidence,
		counterEvidence: item.counterEvidence,
		recommendedAction: contractText(item.recommendedAction),
	};
}

function supportNeedsHumanItem(item, reason) {
	// The rejected target is not provenance. Do not carry it into a first-class
	// NEEDS_HUMAN row where a renderer could mistake it for a validated link.
	const { supportingFindingId: _rejectedTarget, ...unassociated } = item;
	return {
		...unassociated,
		verdict: "NEEDS_HUMAN",
		supportAssociation: "unassociated",
		note: `Support-only finding could not be conservatively associated with a material behavioral root (${reason}); review it as a first-class item.`,
	};
}

function isBehavioralRoot(item) {
	const classification = explicitClassificationOf(item);
	const files = [item.file, ...asObjects(item.locations).map((location) => location.file)]
		.map(canonicalFilePath)
		.filter(Boolean);
	return supportReasonOf(item) === null &&
		classification !== "support" &&
		classification !== "ambiguous" &&
		files.some(isProductionLocationFile);
}

function supportsRoot(item, root) {
	const supportingId = typeof item.supportingFindingId === "string"
		? item.supportingFindingId.trim()
		: "";
	// A support reference may name only the surviving behavioral row. A root
	// cause reference is accepted only when it was explicitly supplied by the
	// reviewer; generated fallback root ids are not association authority.
	if (supportingId && [root.findingId, root.id].includes(supportingId)) return true;
	const rootCauseId = String(root.rootCauseId ?? "").trim();
	const explicitRootCauseId = String(root.explicitRootCauseId ?? "").trim();
	const rootCauseIsValidated =
		(explicitRootCauseId && explicitRootCauseId === rootCauseId) ||
		(!explicitRootCauseId && root.generatedRootCauseId !== true);
	if (supportingId && rootCauseIsValidated && supportingId === rootCauseId) return true;
	return Boolean(rootCauseIsValidated && explicitRootCauseId && explicitRootCauseId === rootCauseId);
}

function demoteSupportFindings(partitions, normalizationNotes) {
	const roots = [...partitions.keep, ...partitions.weaken].filter(isBehavioralRoot);
	const supportNotes = [];
	const demoteFrom = (items) => {
		const next = [];
		for (const item of items) {
			const reason = supportReasonOf(item);
			if (!reason) {
				next.push(item);
				continue;
			}
			const relatedRoot = roots.find((root) => supportsRoot(item, root));
			if (relatedRoot) {
				supportNotes.push(supportNoteFromItem(item, reason, relatedRoot));
				normalizationNotes.push(
					`support finding "${item.title}" moved out of findings (${reason}) under "${relatedRoot.title}"`,
				);
				continue;
			}
			// Never attach to an arbitrary root. An unassociated support finding remains a
			// first-class NEEDS_HUMAN row with its own ID and evidence.
			partitions.needsHuman.push(supportNeedsHumanItem(item, reason));
			normalizationNotes.push(
				`support finding "${item.title}" routed to NEEDS_HUMAN (${reason}); no proven root association`,
			);
		}
		return next;
	};
	partitions.keep = demoteFrom(partitions.keep);
	partitions.weaken = demoteFrom(partitions.weaken);
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

function evidenceQuoteOverlapCount(a, b) {
	const quotesA = normalizedEvidenceQuotesOf(a);
	const quotesB = normalizedEvidenceQuotesOf(b);
	if (quotesA.length === 0 || quotesB.length === 0) return 0;
	return quotesA.filter((left) =>
		quotesB.some(
			(right) => left === right || left.includes(right) || right.includes(left),
		),
	).length;
}

function evidenceQuotesOverlap(a, b) {
	return evidenceQuoteOverlapCount(a, b) > 0;
}

function locationRangesOf(item) {
	return asObjects(item?.locations)
		.map((location) => ({
			file: canonicalFilePath(location.file ?? primaryFileOf(item)),
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

function primaryLocationsOverlapOrTouch(a, b) {
	const primaryFile = primaryFileOf(a);
	if (!primaryFile || primaryFile !== primaryFileOf(b)) return false;
	const rangesA = locationRangesOf(a).filter(
		(location) => location.file === primaryFile,
	);
	const rangesB = locationRangesOf(b).filter(
		(location) => location.file === primaryFile,
	);
	if (rangesA.length === 0 || rangesB.length === 0) return null;
	return rangesA.some((left) =>
		rangesB.some((right) => rangesOverlapOrTouch(left, right)),
	);
}

function productionLocationFilesOverlap(a, b) {
	const isProduction = (file) =>
		!isTestPath(file) &&
		!/(^|\/)(?:docs?|examples?|fixtures?|\.harness)(?:\/|$)/i.test(file);
	const filesA = new Set(
		locationRangesOf(a)
			.map((location) => canonicalFilePath(location.file))
			.filter(isProduction),
	);
	const filesB = new Set(
		locationRangesOf(b)
			.map((location) => canonicalFilePath(location.file))
			.filter(isProduction),
	);
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
	// Cross-file lifecycle collapsing is allowed only when both reports pin the
	// same production file. Shared prose/quotes are not lifecycle identity.
	return productionLocationFilesOverlap(a, b);
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
	const locationOverlap = primaryLocationsOverlapOrTouch(a, b);
	if (locationOverlap === false && !crossFileProtocol) return false;
	const quoteOverlapCount = evidenceQuoteOverlapCount(a, b);
	const titleOverlap = tokenOverlap(titleTokens(a), titleTokens(b));
	if (crossFileProtocol) return true;
	// Partition merges must be conservative: shared helper lines and broad
	// evidence prose can describe distinct defects in the same function.
	return (
		locationOverlap === true &&
		(titleOverlap >= 0.6 ||
			(quoteOverlapCount > 0 &&
				(titleOverlap >= 0.18 || quoteOverlapCount >= 2)))
	);
}

function mergedFindingLineage(item) {
	const current = {
		findingId: item.findingId ?? item.id,
		originalFindingId: item.originalFindingId ?? item.findingId ?? item.id,
		rootCauseId: item.rootCauseId,
		title: item.title,
		verdict: item.verdict ?? item.originalVerdict ?? "unknown",
		originalVerdict: item.originalVerdict ?? item.verdict ?? "unknown",
		severity: canonicalSeverity(item.severity),
		originalSeverity: String(item.originalSeverity ?? item.severity ?? "unknown"),
		file: item.file,
		locations: item.locations,
		evidenceQuotes: item.evidenceQuotes,
		evidence: item.evidence,
		rationale: item.rationale,
		verifierEvidence: item.verifierEvidence,
		counterEvidence: item.counterEvidence,
		recommendedAction: contractText(item.recommendedAction),
		confidence: item.confidence,
		...(item.classification ? { classification: item.classification } : {}),
		...(item.supportClassification ? { supportClassification: item.supportClassification } : {}),
		...(item.supportingFindingId ? { supportingFindingId: item.supportingFindingId } : {}),
		...(item.explicitRootCauseId ? { explicitRootCauseId: item.explicitRootCauseId } : {}),
		...(item.generatedRootCauseId === true ? { generatedRootCauseId: true } : {}),
		...(item.source ? { source: item.source } : {}),
		...(item.reviewerIdentity ? { reviewerIdentity: { ...item.reviewerIdentity } } : {}),
		...(item.verifierOwner ? { verifierOwner: { ...item.verifierOwner } } : {}),
		...(Array.isArray(item.reviewerIdentities)
			? { reviewerIdentities: item.reviewerIdentities.map((owner) => ({ ...owner })) }
			: {}),
		...(Array.isArray(item.sourceLineage)
			? { sourceLineage: [...item.sourceLineage] }
			: {}),
	};
	const declaredLineage = Array.isArray(item.mergedFindings) && item.mergedFindings.length > 0
		? item.mergedFindings
		: item.mergedLineage;
	return [
		current,
		...asObjects(declaredLineage).flatMap(mergedFindingLineage),
	];
}

function mergedFindingLineageKey(item) {
	return String(
		item.findingId ??
			`${item.rootCauseId ?? ""}\u0000${item.title ?? ""}\u0000${item.file ?? ""}`,
	);
}

function mergeFindingItems(primary, duplicate) {
	primary.originalSeverity = primary.originalSeverity ?? primary.severity;
	primary.originalVerdict = primary.originalVerdict ?? primary.verdict;
	primary.severity = conservativeSeverity(primary.severity, duplicate.severity);
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
	const lineage = [
		...asObjects(primary.mergedFindings).flatMap(mergedFindingLineage),
		...mergedFindingLineage(duplicate),
	];
	const seen = new Set();
	primary.mergedFindings = lineage.filter((item) => {
		const key = mergedFindingLineageKey(item);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	primary.originalSeverity = primary.originalSeverity ?? primary.severity;
	primary.originalVerdict = primary.originalVerdict ?? primary.verdict;
	primary.counterEvidence = dedupeStrings([
		...quoteStrings(primary.counterEvidence),
		...quoteStrings(duplicate.counterEvidence),
	]);
	primary.rationale = dedupeStrings([
		primary.rationale,
		duplicate.rationale,
	]).join(" ");
	primary.sourceLineage = dedupeStrings([
		...(primary.sourceLineage ?? []),
		...(duplicate.sourceLineage ?? []),
	]);
	return primary;
}

function relatedRootFinding(a, b) {
	const fileA = primaryFileOf(a);
	const fileB = primaryFileOf(b);
	if (fileA && fileB && fileA !== fileB) return false;
	const locationOverlap = primaryLocationsOverlapOrTouch(a, b);
	if (locationOverlap !== true) return false;
	return (
		evidenceQuotesOverlap(a, b) ||
		tokenOverlap(titleTokens(a), titleTokens(b)) >= 0.18
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

function rootComparisonItem(item) {
	return {
		title: item.title,
		claim: item.claim,
		file: item.file,
		locations: item.locations,
		evidenceQuotes: item.evidenceQuotes,
	};
}

function mergeEquivalentRootFindings(partitions, normalizationNotes) {
	let mergedCount = 0;
	const comparisonByItem = new Map();
	for (const bucketName of ["keep", "weaken"]) {
		const merged = [];
		for (const item of partitions[bucketName]) {
			const comparison = rootComparisonItem(item);
			const existing = merged.find((candidate) =>
				sameRootFinding(comparisonByItem.get(candidate), comparison),
			);
			if (!existing) {
				merged.push(item);
				comparisonByItem.set(item, comparison);
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
		const comparison = comparisonByItem.get(item) ?? rootComparisonItem(item);
		const keepRoot = partitions.keep.find((candidate) =>
			sameRootFinding(comparisonByItem.get(candidate), comparison),
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
	const recommendedAction = contractText(item.recommendedAction);
	return {
		...(item.findingId ? { findingId: item.findingId } : {}),
		...(item.rootCauseId ? { rootCauseId: item.rootCauseId } : {}),
		title: item.title,
		severity: item.severity,
		...(recommendedAction ? { recommendedAction } : {}),
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
		drop: partitions.drop.map(compactFindingForReport),
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

function canonicalJsonValue(value) {
	if (Array.isArray(value)) {
		return value.map((item) =>
			item === undefined ? null : canonicalJsonValue(item),
		);
	}
	if (!value || typeof value !== "object") {
		return typeof value === "number" && !Number.isFinite(value) ? null : value;
	}
	const canonical = {};
	for (const key of Object.keys(value).sort()) {
		if (value[key] !== undefined) canonical[key] = canonicalJsonValue(value[key]);
	}
	return canonical;
}

function contractText(value) {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return "";
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	try {
		return JSON.stringify(canonicalJsonValue(value)) ?? "";
	} catch {
		return "";
	}
}

function evidenceLedgerDigest(value) {
	return createHash("sha256")
		.update(JSON.stringify(canonicalJsonValue(value)))
		.digest("hex");
}

function exactReportCount(value, field) {
	const count = Number(value ?? 0);
	if (!Number.isSafeInteger(count) || count < 0) {
		throw new Error(
			`finding-pipeline: report packet ${field} must be a non-negative safe integer`,
		);
	}
	return count;
}

function boundedReportText(value, maxChars, truncation, fallback) {
	const text = contractText(value) || contractText(fallback);
	const rawLimit = Math.min(text.length, maxChars);
	if (
		text.length <= maxChars &&
		JSON.stringify(text).length - 2 <= maxChars
	) {
		return text;
	}
	let low = 0;
	let high = rawLimit;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (JSON.stringify(text.slice(0, middle)).length - 2 <= maxChars) {
			low = middle;
		} else {
			high = middle - 1;
		}
	}
	truncation.truncatedStrings += 1;
	truncation.omittedStringChars += text.length - low;
	return text.slice(0, low);
}

function boundedOptionalReportText(value, maxChars, truncation) {
	const text = String(value ?? "");
	if (!text.trim()) return undefined;
	return boundedReportText(text, maxChars, truncation, "");
}

function compactFindingForReportPacket(item, truncation) {
	const recommendedAction = boundedOptionalReportText(
		item.recommendedAction,
		REPORT_PACKET_LIMITS.recommendedActionChars,
		truncation,
	);
	return {
		findingId: boundedReportText(
			item.findingId ?? item.id,
			REPORT_PACKET_LIMITS.findingIdChars,
			truncation,
			"unknown-finding",
		),
		title: boundedReportText(
			item.title,
			REPORT_PACKET_LIMITS.findingTitleChars,
			truncation,
			"Untitled finding",
		),
		severity: boundedReportText(
			item.severity,
			REPORT_PACKET_LIMITS.severityChars,
			truncation,
			"unknown",
		),
		...(recommendedAction ? { recommendedAction } : {}),
	};
}

function compactSupportNoteForReportPacket(note, truncation) {
	const severity = boundedOptionalReportText(
		note.severity,
		REPORT_PACKET_LIMITS.severityChars,
		truncation,
	);
	const reason = boundedOptionalReportText(
		note.reason,
		REPORT_PACKET_LIMITS.supportNoteReasonChars,
		truncation,
	);
	const supportingFindingOf = boundedOptionalReportText(
		note.supportingFindingOf,
		REPORT_PACKET_LIMITS.supportingFindingChars,
		truncation,
	);
	return {
		title: boundedReportText(
			note.title,
			REPORT_PACKET_LIMITS.supportNoteTitleChars,
			truncation,
			"Untitled supporting observation",
		),
		...(severity ? { severity } : {}),
		...(reason ? { reason } : {}),
		...(supportingFindingOf ? { supportingFindingOf } : {}),
	};
}

function compactPartialFailureForReportPacket(status, truncation) {
	const source =
		status.source ??
		status.specId ??
		status.taskId ??
		status.displayName ??
		"unknown-source";
	const statusDetail = boundedOptionalReportText(
		status.statusDetail ?? status.errorType ?? status.lastMessage,
		REPORT_PACKET_LIMITS.partialFailureDetailChars,
		truncation,
	);
	return {
		source: boundedReportText(
			source,
			REPORT_PACKET_LIMITS.partialFailureSourceChars,
			truncation,
			"unknown-source",
		),
		status: boundedReportText(
			status.status,
			REPORT_PACKET_LIMITS.partialFailureStatusChars,
			truncation,
			"unknown",
		),
		...(statusDetail ? { statusDetail } : {}),
	};
}

function finalizeReportPacketCharCount(packet) {
	for (let iteration = 0; iteration < 8; iteration += 1) {
		const measured = JSON.stringify(packet).length;
		if (packet.actualChars === measured) break;
		packet.actualChars = measured;
	}
	const actualChars = JSON.stringify(packet).length;
	if (packet.actualChars !== actualChars) {
		throw new Error(
			"finding-pipeline: report packet character count did not stabilize",
		);
	}
	if (actualChars > REPORT_PACKET_MAX_CHARS) {
		throw new Error(
			`finding-pipeline: report packet exceeded ${REPORT_PACKET_MAX_CHARS} characters (${actualChars})`,
		);
	}
	return packet;
}

function buildReportPacket({
	partitions,
	supportNotes,
	sourceStatusSummary: statusSummary,
	partitionSummary,
	normalizationNotes,
}) {
	const truncation = { truncatedStrings: 0, omittedStringChars: 0 };
	const keep = partitions.keep
		.slice(0, REPORT_PACKET_LIMITS.findingsPerPartition)
		.map((item) => compactFindingForReportPacket(item, truncation));
	const weaken = partitions.weaken
		.slice(0, REPORT_PACKET_LIMITS.findingsPerPartition)
		.map((item) => compactFindingForReportPacket(item, truncation));
	const drop = partitions.drop
		.slice(0, REPORT_PACKET_LIMITS.findingsPerPartition)
		.map((item) => compactFindingForReportPacket(item, truncation));
	const needsHuman = partitions.needsHuman
		.slice(0, REPORT_PACKET_LIMITS.findingsPerPartition)
		.map((item) => compactFindingForReportPacket(item, truncation));
	const supportNoteSummaries = supportNotes
		.slice(0, REPORT_PACKET_LIMITS.supportNotes)
		.map((note) => compactSupportNoteForReportPacket(note, truncation));
	const allPartialFailures = asObjects(statusSummary.partialFailures);
	const partialFailures = allPartialFailures
		.slice(0, REPORT_PACKET_LIMITS.partialFailures)
		.map((status) => compactPartialFailureForReportPacket(status, truncation));
	const boundedNormalizationNotes = normalizationNotes
		.slice(0, REPORT_PACKET_LIMITS.normalizationNotes)
		.map((note) =>
			boundedReportText(
				note,
				REPORT_PACKET_LIMITS.normalizationNoteChars,
				truncation,
				"Unspecified normalization note",
			),
		);
	const exactPartitionSummary = {
		keep: partitions.keep.length,
		weaken: partitions.weaken.length,
		drop: partitions.drop.length,
		needsHuman: partitions.needsHuman.length,
		supportNotes: supportNotes.length,
		mergedFindings: exactReportCount(
			partitionSummary.mergedFindings,
			"partitionSummary.mergedFindings",
		),
		verdictsReceived: exactReportCount(
			partitionSummary.verdictsReceived,
			"partitionSummary.verdictsReceived",
		),
		batchIntegrityIssues: exactReportCount(
			partitionSummary.batchIntegrityIssues,
			"partitionSummary.batchIntegrityIssues",
		),
		verdictIntegrityIssues: exactReportCount(
			partitionSummary.verdictIntegrityIssues ?? 0,
			"partitionSummary.verdictIntegrityIssues",
		),
		reviewerCoverageIssues: exactReportCount(
			partitionSummary.reviewerCoverageIssues ?? 0,
			"partitionSummary.reviewerCoverageIssues",
		),
		reviewerFindings: exactReportCount(
			partitionSummary.reviewerFindings,
			"partitionSummary.reviewerFindings",
		),
		missingVerdicts: exactReportCount(
			partitionSummary.missingVerdicts,
			"partitionSummary.missingVerdicts",
		),
		partialFailures: allPartialFailures.length,
	};
	const exactSourceStatusSummary = {
		total: exactReportCount(statusSummary.total, "sourceStatusSummary.total"),
		completed: exactReportCount(
			statusSummary.completed,
			"sourceStatusSummary.completed",
		),
		nonCompleted: exactReportCount(
			statusSummary.nonCompleted,
			"sourceStatusSummary.nonCompleted",
		),
		partialFailureCount: allPartialFailures.length,
		partialFailures,
	};
	const digest = evidenceLedgerDigest({
		partitions,
		supportNotes,
		sourceStatusSummary: statusSummary,
		partitionSummary,
		normalizationNotes,
	});
	const packet = {
		schema: REPORT_PACKET_SCHEMA,
		digest,
		maxChars: REPORT_PACKET_MAX_CHARS,
		actualChars: 0,
		partitionSummary: exactPartitionSummary,
		sourceStatusSummary: exactSourceStatusSummary,
		reportContext: {
			keep,
			weaken,
			drop,
			needsHuman,
			supportNoteSummaries,
		},
		normalizationNotes: boundedNormalizationNotes,
		overflowCounts: {
			keep: partitions.keep.length - keep.length,
			weaken: partitions.weaken.length - weaken.length,
			drop: partitions.drop.length - drop.length,
			needsHuman: partitions.needsHuman.length - needsHuman.length,
			supportNotes: supportNotes.length - supportNoteSummaries.length,
			partialFailures: allPartialFailures.length - partialFailures.length,
			normalizationNotes:
				normalizationNotes.length - boundedNormalizationNotes.length,
			truncatedStrings: truncation.truncatedStrings,
			omittedStringChars: truncation.omittedStringChars,
		},
	};
	return finalizeReportPacketCharCount(packet);
}

function isolateReportPacket(sources, options) {
	const partitionStage = String(
		options.partitionStage ?? "partition-verdicts",
	).trim();
	const partition = findSource(sources, partitionStage);
	if (!partition || typeof partition !== "object") {
		throw new Error(
			`finding-pipeline: report-packet mode requires ${partitionStage} control source`,
		);
	}
	const packet = partition.reportPacket;
	if (!packet || typeof packet !== "object" || Array.isArray(packet)) {
		throw new Error(
			"finding-pipeline: partition source is missing reportPacket",
		);
	}
	const serialized = JSON.stringify(packet);
	if (packet.schema !== REPORT_PACKET_SCHEMA) {
		throw new Error(
			`finding-pipeline: report packet schema must be ${REPORT_PACKET_SCHEMA}`,
		);
	}
	if (packet.maxChars !== REPORT_PACKET_MAX_CHARS) {
		throw new Error(
			`finding-pipeline: report packet maxChars must be ${REPORT_PACKET_MAX_CHARS}`,
		);
	}
	if (serialized.length > REPORT_PACKET_MAX_CHARS) {
		throw new Error(
			`finding-pipeline: copied report packet exceeded ${REPORT_PACKET_MAX_CHARS} characters (${serialized.length})`,
		);
	}
	if (packet.actualChars !== serialized.length) {
		throw new Error(
			`finding-pipeline: copied report packet actualChars ${String(packet.actualChars)} did not match ${serialized.length}`,
		);
	}
	return packet;
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
	sourceStatuses,
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
	const owners = verifierStatusesForAlias(sourceStatuses, sourceId);
	const owner = owners.length === 1 ? ownerFromStatus(owners[0]) : null;
	const statusAvailable = owners.length > 0;
	const statusValid = Boolean(
		expectedMembers &&
		(!statusAvailable || (owners.length === 1 && exactDevilAdvocateStatus(owners[0], batchId, sourceId))),
	);
	if (!statusValid && statusAvailable) {
		issues.push({
			sourceId,
			batchId,
			findingId: "",
			title: "Batch verifier source status is not bound to its exact materialized batch",
			reason: owners.length !== 1
				? "batch_source_status_not_unique"
				: "batch_source_status_identity_mismatch",
			expectedFindingIds: expectedMembers ? [...expectedMembers.keys()] : [],
			rowCount: expectedMembers?.size ?? 0,
		});
	}
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
		if (!statusValid) {
			issues.push({
				...base,
				findingId,
				title,
				reason: "batch_row_source_status_invalid",
				entry: result,
			});
			continue;
		}
		rows.push({
			...base,
			findingId,
			title,
			...(owner ? { owner: { ...owner } } : {}),
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
		...(Array.isArray(reviewerFinding?.sourceLineage)
			? { sourceLineage: [...reviewerFinding.sourceLineage] }
			: {}),
		...(Array.isArray(reviewerFinding?.mergedFindings)
			? { mergedFindings: structuredClone(reviewerFinding.mergedFindings) }
			: {}),
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

const SINGLETON_VERDICT_KEYS = new Set([
	"schema",
	"digest",
	"findingId",
	"finding",
	"verdict",
	"evidence",
	"counterEvidence",
	"recommendedAction",
]);

function singletonVerdictMalformedReason(entry) {
	if (!entry || typeof entry !== "object" || Array.isArray(entry))
		return "malformed_devil_advocate_control";
	if (
		Object.keys(entry).some((key) => !SINGLETON_VERDICT_KEYS.has(key))
	)
		return "malformed_devil_advocate_extra_fields";
	if ("schema" in entry && entry.schema !== "stage-control-v1")
		return "malformed_devil_advocate_schema";
	if (!Array.isArray(entry.evidence))
		return "malformed_devil_advocate_evidence_array";
	const legacyStringEvidence = entry.evidence.every(
		(value) => typeof value === "string" && value.trim(),
	);
	const structuredEvidence = entry.evidence.every(
		(value) => value && typeof value === "object" && !Array.isArray(value),
	);
	if (!legacyStringEvidence && !structuredEvidence)
		return "malformed_devil_advocate_evidence_item";
	if (!Array.isArray(entry.counterEvidence))
		return "malformed_devil_advocate_counterEvidence_array";
	if (
		entry.counterEvidence.some(
			(value) => typeof value !== "string" || !value.trim(),
		)
	)
		return "malformed_devil_advocate_counterEvidence_item";
	if (
		entry.recommendedAction === undefined ||
		entry.recommendedAction === null ||
		(typeof entry.recommendedAction === "string" && !entry.recommendedAction.trim())
	)
		return "malformed_devil_advocate_recommendedAction";
	return null;
}

function verdictIntegrityNeedsHumanItem(issue, reviewerFinding, fallbackId) {
	const entry = issue.entry && typeof issue.entry === "object" ? issue.entry : {};
	const useReviewer = Boolean(reviewerFinding && issue.preserveFindingId);
	const findingId = useReviewer
		? findingIdOf(reviewerFinding)
		: fallbackId;
	const sourceFinding =
		entry.finding && typeof entry.finding === "object" ? entry.finding : {};
	return {
		findingId,
		rootCauseId:
			(useReviewer ? reviewerFinding.rootCauseId : undefined) ??
			(useReviewer ? findingIdOf(reviewerFinding) : undefined) ??
			fallbackId,
		title: useReviewer
			? String(reviewerFinding.title ?? "")
			: findingTitleOf(entry) || "Malformed devil-advocate verdict",
		verdict: "NEEDS_HUMAN",
		severity: useReviewer
			? canonicalSeverity(reviewerFinding.severity)
			: canonicalSeverity(sourceFinding.severity),
		file: useReviewer ? reviewerFinding.file : sourceFinding.file,
		locations: useReviewer
			? reviewerFinding.locations ?? locationsOf(reviewerFinding)
			: locationsOf(sourceFinding),
		evidenceQuotes: useReviewer
			? reviewerFinding.evidenceQuotes ?? evidenceQuotesOf(reviewerFinding)
			: evidenceQuotesOf(sourceFinding),
		evidence: Array.isArray(entry.evidence) ? entry.evidence : [],
		counterEvidence: Array.isArray(entry.counterEvidence)
			? entry.counterEvidence
			: [],
		recommendedAction: contractText(entry.recommendedAction),
		...(Array.isArray(reviewerFinding?.sourceLineage)
			? { sourceLineage: [...reviewerFinding.sourceLineage] }
			: {}),
		...(Array.isArray(reviewerFinding?.mergedFindings)
			? { mergedFindings: structuredClone(reviewerFinding.mergedFindings) }
			: {}),
		note: `devil-advocate integrity issue: ${issue.reason}`,
		verdictIntegrityIssue: {
			reason: issue.reason,
			...(issue.sourceId ? { sourceId: issue.sourceId } : {}),
			...(issue.findingId ? { suppliedFindingId: issue.findingId } : {}),
			...(issue.expectedFindingIds
				? { expectedFindingIds: issue.expectedFindingIds }
				: {}),
			...(Number.isInteger(issue.rowCount) ? { rowCount: issue.rowCount } : {}),
		},
	};
}

function invalidReviewerLedger() {
	return {
		complete: false,
		plannedLensIds: [],
		materializedReviewerIds: [],
		attestedLensIds: [],
		materializedReviewerSourceIds: [],
		validAttestationSourceIds: [],
		ownerMap: [],
		invalidAttestations: [{ source: "reviewers", reason: "missing_reviewer_ledger" }],
		missingPlannedLensIds: [],
		missingAttestedLensIds: [],
		unexpectedMaterializedReviewerIds: [],
		unexpectedAttestedLensIds: [],
		duplicateMaterializedReviewerIds: [],
		setEquality: false,
		sourceStatuses: [],
		rawFindingIds: [],
		dedupFindingIds: [],
		validFindingIds: [],
		invalidFindingIds: [],
	};
}

function invalidDedupSummary() {
	return {
		complete: false,
		rawCount: 0,
		uniqueCount: 0,
		duplicateCount: 0,
		rawFindingIds: [],
		dedupFindingIds: [],
		dispositionFindingIds: [],
		supportFindingIds: [],
		lineageFindingIds: [],
		duplicates: [],
	};
}

function partitionVerdicts(sources, options = {}, context = {}) {
	const dedupStageId = String(options.dedupStage ?? "dedup-findings");
	const directStatusSummary = sourceStatusSummary(sourceStatusesOf(context));
	let partialFailures = mergePartialFailures(
		directStatusSummary.partialFailures,
		...Object.values(sources ?? {}).map(partialFailuresFromSource),
	);
	let reviewerFindings = [];
	let reviewerCoverageIssues = [];
	let reviewerLedger = null;
	let dedupSummary = null;
	const verdictRows = [];
	const batchIssues = [];
	const devilAdvocateBatchStage = String(
		options.devilAdvocateBatchStage ?? "devil-advocate-batches",
	);
	for (const [specId, source] of Object.entries(sources ?? {})) {
		if (specId.startsWith(`${dedupStageId}.`) || specId === dedupStageId) {
			reviewerFindings = findingsOf(source);
			reviewerCoverageIssues = asObjects(source?.coverageIssues);
			reviewerLedger = source?.reviewerLedger ?? invalidReviewerLedger();
			dedupSummary = source?.dedupSummary ?? invalidDedupSummary();
		}
	}
	if (!reviewerLedger) reviewerLedger = invalidReviewerLedger();
	if (!dedupSummary) dedupSummary = invalidDedupSummary();

	const byFindingId = new Map();
	for (const finding of reviewerFindings) {
		const findingId = findingIdOf(finding);
		if (findingId && !byFindingId.has(findingId))
			byFindingId.set(findingId, finding);
	}
	const singletonIntegrityIssues = [];
	const singletonRows = [];

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
				sourceStatuses: sourceStatusesOf(context),
			});
			for (const row of collected.rows)
				verdictRows.push({ ...row, batched: true });
			batchIssues.push(...collected.issues);
			continue;
		}
		const entry = verdictEntryOf(source);
		if (entry) {
			const row = {
				entry,
				batched: false,
				sourceId: specId,
				index: verdictRows.length,
			};
			verdictRows.push(row);
			singletonRows.push(row);
		}
	}

	const singletonIdCounts = new Map();
	for (const row of singletonRows) {
		const suppliedId =
			typeof row.entry.findingId === "string" ? row.entry.findingId.trim() : "";
		if (suppliedId)
			singletonIdCounts.set(suppliedId, (singletonIdCounts.get(suppliedId) ?? 0) + 1);
	}
	for (const row of singletonRows) {
		const suppliedId =
			typeof row.entry.findingId === "string" ? row.entry.findingId.trim() : "";
		const title = findingTitleOf(row.entry);
		const issue = {
			sourceId: row.sourceId,
			findingId: suppliedId || undefined,
			title,
			entry: row.entry,
		};
		const reviewerFinding = suppliedId ? byFindingId.get(suppliedId) : null;
		const owners = verifierStatusesForAlias(sourceStatusesOf(context), row.sourceId);
		const owner = owners.length === 1 ? ownerFromStatus(owners[0]) : null;
		const malformedReason = singletonVerdictMalformedReason(row.entry);
		if (malformedReason) {
			issue.preserveFindingId = Boolean(reviewerFinding);
			issue.reason = malformedReason;
			singletonIntegrityIssues.push(issue);
			continue;
		}
		if (!suppliedId) {
			issue.reason = "missing_devil_advocate_findingId";
			singletonIntegrityIssues.push(issue);
			continue;
		}
		if (owners.length > 0 && owners.length !== 1) {
			issue.reason = "verifier_alias_not_bound_to_exactly_one_materialized_status";
			issue.expectedFindingIds = [suppliedId];
			singletonIntegrityIssues.push(issue);
			continue;
		}
		if (owners.length > 0 && !exactDevilAdvocateStatus(owners[0], suppliedId, row.sourceId)) {
			issue.reason = "verifier_source_status_identity_mismatch";
			issue.expectedFindingIds = [suppliedId];
			singletonIntegrityIssues.push(issue);
			continue;
		}
		if (!reviewerFinding) {
			issue.reason = "unknown_devil_advocate_findingId";
			singletonIntegrityIssues.push(issue);
			continue;
		}
		if ((singletonIdCounts.get(suppliedId) ?? 0) > 1) {
			issue.reason = "duplicate_devil_advocate_findingId";
			issue.rowCount = singletonIdCounts.get(suppliedId);
			issue.preserveFindingId =
				singletonRows.find(
					(candidate) =>
						String(candidate.entry.findingId ?? "").trim() === suppliedId,
				) === row;
			singletonIntegrityIssues.push(issue);
			continue;
		}
		if (typeof row.entry.finding !== "string" || row.entry.finding !== reviewerFinding.title) {
			issue.preserveFindingId = true;
			issue.reason = "findingId_title_mismatch_or_legacy_shape";
			singletonIntegrityIssues.push(issue);
			continue;
		}
		row.reviewerFinding = reviewerFinding;
		if (owner) row.owner = { ...owner };
	}

	const partitions = { keep: [], weaken: [], drop: [], needsHuman: [] };
	const normalizationNotes = [];
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

	let integrityIssueIndex = 0;
	for (const issue of [
		...batchIssues,
		...singletonIntegrityIssues,
	]) {
		integrityIssueIndex += 1;
		const reviewerFinding = issue.findingId
			? byFindingId.get(issue.findingId)
			: null;
		if (reviewerFinding) {
			const id = findingIdOf(reviewerFinding);
			if (id) issueCoveredFindingIds.add(id);
		}
		const fallbackId = `${issue.batchId ? "batch-verdict" : "verdict-integrity"}-${String(integrityIssueIndex).padStart(3, "0")}`;
		partitions.needsHuman.push(
			issue.batchId
				? batchIssueNeedsHumanItem(issue, reviewerFinding, fallbackId)
				: verdictIntegrityNeedsHumanItem(issue, reviewerFinding, fallbackId),
		);
		normalizationNotes.push(
			`devil-advocate integrity issue ${issue.reason} for "${issue.title ?? issue.findingId ?? "unknown"}" routed to NEEDS_HUMAN`,
		);
	}

	let verdictIndex = 0;
	for (const row of verdictRows) {
		if (row.batched && duplicateBatchKeys.has(row.batchKey)) continue;
		if (row.batched && issueCoveredFindingIds.has(row.findingId)) continue;
		verdictIndex += 1;
		const entry = row.entry;
		if (!row.batched && !row.reviewerFinding) continue;
		const title = row.batched ? row.title : row.reviewerFinding.title;
		const reviewerFinding = row.batched
			? byFindingId.get(row.findingId)
			: row.reviewerFinding;
		if (reviewerFinding) {
			const findingId = findingIdOf(reviewerFinding);
			if (findingId) matchedFindingIds.add(findingId);
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
		const structuredVerifierEvidence =
			Array.isArray(entry.evidence) &&
			entry.evidence.length > 0 &&
			entry.evidence.every(
				(value) => value && typeof value === "object" && !Array.isArray(value),
			);
		const verifierEvidenceResult = structuredVerifierEvidence
			? verifierEvidenceRowsOf(entry.evidence)
			: { rows: [], issues: [] };
		const verifierEvidenceRows = verifierEvidenceResult.rows;
		const verifierEvidenceQuotes = structuredVerifierEvidence
			? verifierEvidenceRows.map((row) => row.quote)
			: dedupeStrings(quoteStrings(entry.evidence));
		const recommendedAction = contractText(entry.recommendedAction);
		if (typeof entry.recommendedAction !== "string" && recommendedAction) {
			const valueType = Array.isArray(entry.recommendedAction)
				? "array"
				: typeof entry.recommendedAction;
			normalizationNotes.push(
				`legacy recommendedAction for ${JSON.stringify(String(title))} normalized from ${valueType} to canonical JSON text`,
			);
		}
		const item = {
			findingId:
				reviewerFinding?.findingId ?? reviewerFinding?.id ?? fallbackId,
			originalFindingId:
				reviewerFinding?.findingId ?? reviewerFinding?.id ?? fallbackId,
			rootCauseId:
				reviewerFinding?.rootCauseId ??
				reviewerFinding?.findingId ??
				reviewerFinding?.id ??
				fallbackId,
			title: reviewerFinding?.title ?? title,
			originalSeverity: reviewerFinding?.originalSeverity ?? reviewerFinding?.severity ?? "unknown",
			...(reviewerFinding?.source ? { source: reviewerFinding.source } : {}),
			...(reviewerFinding?.reviewerIdentity
				? { reviewerIdentity: { ...reviewerFinding.reviewerIdentity } }
				: {}),
			...(Array.isArray(reviewerFinding?.reviewerIdentities)
				? { reviewerIdentities: reviewerFinding.reviewerIdentities.map((owner) => ({ ...owner })) }
				: {}),
				...(Array.isArray(reviewerFinding?.sourceLineage)
				? { sourceLineage: [...reviewerFinding.sourceLineage] }
				: {}),
			...(reviewerFinding?.classification
				? { classification: reviewerFinding.classification }
				: {}),
			...(reviewerFinding?.supportClassification
				? { supportClassification: reviewerFinding.supportClassification }
				: {}),
			...(reviewerFinding?.supportingFindingId
				? { supportingFindingId: reviewerFinding.supportingFindingId }
				: {}),
			...(reviewerFinding?.explicitRootCauseId
				? { explicitRootCauseId: reviewerFinding.explicitRootCauseId }
				: {}),
			...(reviewerFinding?.generatedRootCauseId === true
				? { generatedRootCauseId: true }
				: {}),
			...(Array.isArray(reviewerFinding?.mergedFindings)
				? { mergedFindings: structuredClone(reviewerFinding.mergedFindings) }
				: {}),
			verdict,
			originalVerdict: verdict,
			// KEEP findings carry the reviewer severity from the normalized reviewer control;
			// merges retain the original severity in their lineage and use a conservative canonical top-level value.
			// WEAKEN severity reduction is the report stage's job, with cited counter-evidence.
			severity: reviewerFinding
				? canonicalSeverity(reviewerFinding.severity)
				: entry.finding && typeof entry.finding === "object"
					? canonicalSeverity(entry.finding.severity)
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
				...verifierEvidenceRows.map((row) => row.quote),
			]),
			evidence: structuredVerifierEvidence
				? verifierEvidenceRows
				: (entry.evidence ?? reviewerFinding?.evidence ?? []),
			rationale: reviewerFinding?.rationale ?? "",
			verifierEvidence: verifierEvidenceQuotes,
			counterEvidence: dedupeStrings(quoteStrings(entry.counterEvidence)),
			recommendedAction,
			sourceCoverageComplete:
				reviewerFinding?.sourceCoverageComplete !== false,
			sourceCoverageIssuePaths: dedupeStrings(
				reviewerFinding?.sourceCoverageIssuePaths ?? [],
			),
			...(row.owner ? { verifierOwner: { ...row.owner } } : {}),
			...(row.batched
				? { evidenceSourceType: batchEvidenceSourceType(entry) }
				: {}),
		};
		if (
			item.sourceCoverageComplete === false ||
			item.sourceCoverageIssuePaths.length > 0
		) {
			const issuePaths = item.sourceCoverageIssuePaths;
			const note = `originating reviewer did not complete required source coverage${
				issuePaths.length > 0 ? `: ${issuePaths.join(", ")}` : ""
			}`;
			partitions.needsHuman.push({
				...item,
				verdict: "NEEDS_HUMAN",
				note,
			});
			normalizationNotes.push(
				`verdict for "${title}" came from incomplete source coverage; routed to NEEDS_HUMAN instead of ${verdict}`,
			);
			continue;
		}
		const verifierEvidenceIssues =
			!row.batched && structuredVerifierEvidence
				? [
						...verifierEvidenceResult.issues,
						...verifierEvidenceGroundingIssues(
							verifierEvidenceRows,
							context,
						),
					]
				: [];
		if (verifierEvidenceIssues.length > 0) {
			const failure = {
				source: row.sourceId ?? "unknown-verifier",
				specId: row.sourceId ?? "unknown-verifier",
				stageId: "devil-advocate",
				status: "verifier_evidence_unverified",
				statusDetail: `verifier evidence was not grounded: ${verifierEvidenceIssues[0]}`,
				errorType: "verifier_evidence",
			};
			partialFailures = mergePartialFailures(partialFailures, [failure]);
			partitions.needsHuman.push({
				...item,
				verdict: "NEEDS_HUMAN",
				note: failure.statusDetail,
			});
			normalizationNotes.push(
				`verdict for "${title}" had ungrounded verifier evidence; routed to NEEDS_HUMAN instead of ${verdict}`,
			);
			continue;
		}
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
		const lacksVerifierEvidence =
			!isSupportItem &&
			((verdict === "KEEP" && verifierEvidenceQuotes.length === 0) ||
				(verdict === "WEAKEN" &&
					verifierEvidenceQuotes.length === 0 &&
					dedupeStrings(quoteStrings(entry.counterEvidence)).length === 0) ||
				(verdict === "DROP" &&
					verifierEvidenceQuotes.length === 0 &&
					dedupeStrings(quoteStrings(entry.counterEvidence)).length === 0));
		if (lacksIdentityEvidence || lacksVerifierEvidence) {
			partitions.needsHuman.push({
				...item,
				verdict: "NEEDS_HUMAN",
				note: lacksIdentityEvidence
					? "verdict lacked code-preserved locations or evidenceQuotes required for a reportable disposition"
					: "verdict lacked independent verifier evidence required for a reportable disposition",
			});
			normalizationNotes.push(
				`verdict for "${title}" lacked grounding evidence; routed to NEEDS_HUMAN instead of ${verdict}`,
			);
			continue;
		}
		if (verdict === "KEEP") partitions.keep.push(item);
		else if (verdict === "WEAKEN") partitions.weaken.push(item);
		else if (verdict === "DROP") partitions.drop.push(item);
		else partitions.needsHuman.push(item);
	}

	for (const [index, issue] of reviewerCoverageIssues.entries()) {
		partitions.needsHuman.push({
			findingId: `reviewer-coverage-${String(index + 1).padStart(3, "0")}`,
			rootCauseId: "reviewer-coverage",
			title: String(issue.source ?? "Reviewer coverage").trim(),
			verdict: "NEEDS_HUMAN",
			severity: "unknown",
			locations: [],
			evidenceQuotes: [],
			note: String(issue.reason ?? "reviewer coverage was not attestable"),
		});
		normalizationNotes.push(
			`reviewer coverage issue for "${issue.source ?? "unknown"}" routed to NEEDS_HUMAN`,
		);
	}

	// Findings the devil-advocate stage never returned a verdict for must not
	// vanish silently: route them to needsHuman using exact IDs only.
	for (const finding of reviewerFindings) {
		const findingId = findingIdOf(finding);
		if (
			findingId &&
			(matchedFindingIds.has(findingId) || issueCoveredFindingIds.has(findingId))
		) {
			continue;
		}
		missingVerdicts += 1;
		partitions.needsHuman.push({
			findingId: finding.findingId ?? finding.id,
			rootCauseId: finding.rootCauseId ?? finding.findingId ?? finding.id,
			title: String(finding.title ?? ""),
			verdict: "NEEDS_HUMAN",
			severity: canonicalSeverity(finding.severity),
			originalSeverity: finding.originalSeverity ?? finding.severity ?? "unknown",
			file: finding.file,
			locations: finding.locations ?? locationsOf(finding),
			evidenceQuotes: finding.evidenceQuotes ?? evidenceQuotesOf(finding),
			...(Array.isArray(finding.sourceLineage)
				? { sourceLineage: [...finding.sourceLineage] }
				: {}),
			...(Array.isArray(finding.mergedFindings)
				? { mergedFindings: structuredClone(finding.mergedFindings) }
				: {}),
			evidence: [],
			counterEvidence: [],
			recommendedAction: "",
			note: "no devil-advocate verdict received for this finding",
		});
		normalizationNotes.push(
			`reviewer finding "${String(finding.title ?? "")}" had no verdict; routed to NEEDS_HUMAN`,
		);
	}

	// Normalize equivalent behavioral roots before resolving support targets. This
	// ensures a support reference cannot point at a root that is about to become
	// only a merged lineage member.
	mergeEquivalentRootFindings(partitions, normalizationNotes);
	const supportNotes = demoteSupportFindings(partitions, normalizationNotes);
	// This is an occurrence count, not a unique-id count. Every recursive
	// merged member is emitted in the ledger, including members nested under
	// DROP/NEEDS_HUMAN rows and first-class support rows.
	const mergedFindings = [
		...partitions.keep,
		...partitions.weaken,
		...partitions.drop,
		...partitions.needsHuman,
		...supportNotes,
	].reduce(
		(total, finding) => total + mergedFindingLineage(finding).slice(1).length,
		0,
	);

	const expectedFindingIds = reviewerFindings
		.map(findingIdOf)
		.filter(Boolean);
	const suppliedVerifierRows = [
		...verdictRows.map((row) => ({
			sourceId: row.sourceId,
			...(row.batchId ? { batchId: row.batchId } : {}),
			...(Number.isInteger(row.index) ? { index: row.index } : {}),
			findingId: row.findingId ?? String(row.entry?.findingId ?? "").trim(),
			...(row.owner ? { owner: { ...row.owner }, ownerSource: row.owner.source, ownerSpecId: row.owner.specId, ownerTaskId: row.owner.taskId, ownerItemIdentity: row.owner.itemIdentity } : {}),
			valid: !singletonIntegrityIssues.some(
				(issue) => issue.sourceId === row.sourceId && issue.entry === row.entry,
			),
		})),

		...batchIssues.map((issue) => ({
			sourceId: issue.sourceId,
			...(issue.batchId ? { batchId: issue.batchId } : {}),
			...(Number.isInteger(issue.index) ? { index: issue.index } : {}),
			findingId: issue.findingId ?? "",
			valid: false,
			reason: issue.reason,
		})),
		...singletonIntegrityIssues.map((issue) => ({
			sourceId: issue.sourceId,
			findingId: issue.findingId ?? "",
			valid: false,
			reason: issue.reason,
		})),
	];
	for (const row of suppliedVerifierRows) {
		if (row.owner) continue;
		const owners = verifierStatusesForAlias(sourceStatusesOf(context), row.sourceId);
		row.owner = owners.length === 1
			? ownerFromStatus(owners[0])
			: { source: row.sourceId ?? "", specId: "", taskId: "", itemIdentity: "", placeholderSpecId: "" };
		row.ownerSource = row.owner.source;
		row.ownerSpecId = row.owner.specId;
		row.ownerTaskId = row.owner.taskId;
		row.ownerItemIdentity = row.owner.itemIdentity;
	}
	const verifierOwnerIssues = suppliedVerifierRows.filter((row) => {
		const owners = verifierStatusesForAlias(
			sourceStatusesOf(context),
			row.sourceId,
		);
		if (owners.length !== 1 || !ownerComplete(row.owner)) return true;
		const identity = row.batchId ?? row.findingId;
		if (!exactDevilAdvocateStatus(owners[0], identity, row.sourceId)) return true;
		const expectedOwner = ownerFromStatus(owners[0]);
		return ["source", "specId", "taskId", "itemIdentity", "placeholderSpecId"]
			.some((key) => row.owner[key] !== expectedOwner[key]);
	});
	const verdictFindingIds = suppliedVerifierRows
		.map((row) => row.findingId)
		.filter(Boolean);
	const expectedIdSet = new Set(expectedFindingIds);
	const verdictIdSet = new Set(verdictFindingIds);
	const missingVerifierFindingIds = expectedFindingIds.filter(
		(id) => !verdictIdSet.has(id),
	);
	const orphanVerifierFindingIds = verdictFindingIds.filter(
		(id) => !expectedIdSet.has(id),
	);
	const duplicateVerifierFindingIds = verdictFindingIds.filter(
		(id, index) => verdictFindingIds.indexOf(id) !== index,
	);
	const verifierStatusIssues = sourceStatusesOf(context)
		.filter((status) =>
			status?.stageId === "devil-advocate" ||
			String(status?.specId ?? "").startsWith("devil-advocate.") ||
			String(status?.source ?? "").startsWith("devil-advocate."),
		)
		.filter((status) => {
			const identity = String(status.itemIdentity ?? "").trim();
			return !identity ||
				!((expectedIdSet.has(identity) || batchMembershipById.has(identity)) &&
					exactDevilAdvocateStatus(status, identity, status.source ?? ""));
		})
		.map((status) => ({
			sourceId: status.source ?? status.specId ?? "",
			itemIdentity: status.itemIdentity ?? "",
			reason: "verifier status is not an exact completed devil-advocate owner",
		}));
	const verifierCoverage = {
		// This is the count of received verifier source rows before partitioning;
		// the renderer reconciles it with partitionSummary.verdictsReceived.
		verdictsReceived: verdictRows.length,
		complete: missingVerifierFindingIds.length === 0 && orphanVerifierFindingIds.length === 0 && duplicateVerifierFindingIds.length === 0 && verifierOwnerIssues.length === 0 && verifierStatusIssues.length === 0,
		expectedFindingIds,
		verdictFindingIds,
		missingFindingIds: [...new Set(missingVerifierFindingIds)],
		orphanFindingIds: [...new Set(orphanVerifierFindingIds)],
		duplicateFindingIds: [...new Set(duplicateVerifierFindingIds)],
		ownerIssues: verifierOwnerIssues.map((row) => ({ sourceId: row.sourceId, findingId: row.findingId ?? "" })),
		statusIssues: verifierStatusIssues,
		exactSetEquality:
			missingVerifierFindingIds.length === 0 &&
			orphanVerifierFindingIds.length === 0 &&
			duplicateVerifierFindingIds.length === 0,
		rows: suppliedVerifierRows,
		sourceStatuses: sourceStatusesOf(context).map(slimSourceStatus),
		digest: evidenceLedgerDigest({
			expectedFindingIds,
			verdictFindingIds,
			rows: suppliedVerifierRows,
		}),
	};
	const partitionSummary = {
		keep: partitions.keep.length,
		weaken: partitions.weaken.length,
		drop: partitions.drop.length,
		needsHuman: partitions.needsHuman.length,
		supportNotes: supportNotes.length,
		mergedFindings,
		verdictsReceived: verdictRows.length,
		batchIntegrityIssues: batchIssues.length,
		verdictIntegrityIssues: singletonIntegrityIssues.length,
		reviewerCoverageIssues: reviewerCoverageIssues.length,
		reviewerFindings: reviewerFindings.length,
		missingVerdicts,
		partialFailures: partialFailures.length,
	};
	const reportContext = buildReportContext(
		partitions,
		supportNotes,
		partialFailures,
	);
	const mergedSourceStatusSummary = mergeSourceStatusSummary(
		directStatusSummary,
		partialFailures,
	);
	const topLevelDispositionIds = [
		...partitions.keep,
		...partitions.weaken,
		...partitions.drop,
		...partitions.needsHuman,
	].map((finding) => findingIdOf(finding)).filter(Boolean);
	const supportFindingIds = supportNotes.map((note) => findingIdOf(note)).filter(Boolean);
	const lineageFindingIds = [
		...partitions.keep,
		...partitions.weaken,
		...partitions.drop,
		...partitions.needsHuman,
	].flatMap((finding) => mergedFindingLineage(finding).slice(1).map(findingIdOf))
		.concat(supportNotes.flatMap((note) => mergedFindingLineage(note).slice(1).map(findingIdOf)))
		.filter(Boolean);
	const sourceRawIds = idArray(dedupSummary.rawFindingIds);
	const sourceDedupIds = idArray(dedupSummary.dedupFindingIds);
	const conservedIds = new Set([
		...topLevelDispositionIds,
		...supportFindingIds,
		...lineageFindingIds,
	]);
	const conservationOk = sourceRawIds.every((id) => conservedIds.has(id));
	dedupSummary = {
		...dedupSummary,
		dispositionFindingIds: topLevelDispositionIds,
		supportFindingIds,
		lineageFindingIds,
		complete: Boolean(dedupSummary.complete !== false && conservationOk),
	};
	reviewerLedger = {
		...reviewerLedger,
		rawFindingIds: sourceRawIds,
		dedupFindingIds: sourceDedupIds,
		dispositionFindingIds: topLevelDispositionIds,
		supportFindingIds,
		lineageFindingIds,
		provenanceOwnerFindingIds: [
			...topLevelDispositionIds,
			...supportFindingIds,
			...lineageFindingIds,
		],
		complete: Boolean(reviewerLedger.complete !== false && conservationOk),
	};
	const reportPacket = buildReportPacket({
		partitions,
		supportNotes,
		sourceStatusSummary: mergedSourceStatusSummary,
		partitionSummary,
		normalizationNotes,
	});

	return {
		partitions,
		supportNotes,
		reportContext,
		reportPacket,
		dedupSummary,
		reviewerLedger,
		verifierCoverage,
		digest: `partition: keep=${partitionSummary.keep}, weaken=${partitionSummary.weaken}, drop=${partitionSummary.drop}, needsHuman=${partitionSummary.needsHuman}, missingVerdicts=${missingVerdicts}, partialFailures=${partialFailures.length}, supportNotes=${supportNotes.length}, ledgerDigest=${reportPacket.digest}`,
		sourceStatusSummary: mergedSourceStatusSummary,
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
	if (mode === "report-packet") return isolateReportPacket(sources, options);
	throw new Error(
		`finding-pipeline: unknown mode "${mode}" (expected "dedup", "batch-devil-advocate", "partition", or "report-packet")`,
	);
}
