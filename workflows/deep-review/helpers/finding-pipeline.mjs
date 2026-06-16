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
	if (typeof value === "string" && value.trim()) return [value.trim()];
	if (Array.isArray(value)) return value.flatMap(quoteStrings);
	if (value && typeof value === "object") {
		if (typeof value.quote === "string" && value.quote.trim())
			return [value.quote.trim()];
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
		...(status.statusDetail ? { statusDetail: String(status.statusDetail) } : {}),
		...(status.errorType ? { errorType: String(status.errorType) } : {}),
		...(status.lastMessage ? { lastMessage: String(status.lastMessage).slice(0, 500) } : {}),
	};
}

function sourceStatusKey(status) {
	return `${status.specId ?? ""}|${status.taskId ?? ""}|${status.source ?? ""}|${status.status ?? ""}`;
}

function sourceStatusSummary(statuses) {
	const all = sourceStatusesOf({ sourceStatuses: statuses }).map(slimSourceStatus);
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

function evidenceQuotesOf(finding) {
	return dedupeStrings([
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
		findingId: typeof finding.findingId === "string" && finding.findingId ? finding.findingId : id,
		rootCauseId: typeof finding.rootCauseId === "string" && finding.rootCauseId ? finding.rootCauseId : `root-${String(index + 1).padStart(3, "0")}`,
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
		item?.counterEvidence,
		item?.recommendedAction,
		item?.reviewerFinding?.title,
		item?.reviewerFinding?.evidence,
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
	if (isTestPath(file) || /\b(test|tests|coverage)\b/.test(text))
		return "test/coverage support";
	if (/\b(stale|comment|comments|doc|docs|documentation)\b/.test(text))
		return "comment/documentation support";
	if (
		/\bdead\b/.test(text) &&
		/\b(capture|captures|branch|fallback|code|reference|references)\b/.test(
			text,
		)
	)
		return "dead-code support";
	return null;
}

function demoteSupportFindings(partitions, normalizationNotes) {
	const roots = partitions.keep.filter(
		(item) => !supportReasonOf(item) && !isTestPath(primaryFileOf(item)),
	);
	if (roots.length === 0) return [];
	const nextKeep = [];
	const supportNotes = [];
	for (const item of partitions.keep) {
		const reason = supportReasonOf(item);
		if (!reason) {
			nextKeep.push(item);
			continue;
		}
		const file = primaryFileOf(item);
		const relatedRoot =
			roots.find((root) => primaryFileOf(root) === file) ??
			(isTestPath(file) ? roots[0] : undefined);
		if (!relatedRoot) {
			nextKeep.push(item);
			continue;
		}
		supportNotes.push({
			title: item.title,
			severity: item.severity,
			file: item.file,
			locations: item.locations,
			evidenceQuotes: item.evidenceQuotes,
			reason,
			supportingFindingOf: relatedRoot.title,
			evidence: item.evidence,
			counterEvidence: item.counterEvidence,
			recommendedAction: item.recommendedAction,
		});
		normalizationNotes.push(
			`support finding "${item.title}" moved out of findings (${reason}) under "${relatedRoot.title}"`,
		);
	}
	partitions.keep = nextKeep;
	return supportNotes;
}

function rootTextOf(item) {
	return textFragments([
		item?.title,
		item?.evidence,
		item?.counterEvidence,
		item?.recommendedAction,
		item?.reviewerFinding,
	]).join(" ");
}

function rootTokensOf(item) {
	return titleTokens({ title: rootTextOf(item) });
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

function sameRootFinding(a, b) {
	const fileA = primaryFileOf(a);
	const fileB = primaryFileOf(b);
	if (fileA && fileB && fileA !== fileB) return false;
	const locationOverlap = locationsOverlapOrTouch(a, b);
	if (locationOverlap === false) return false;
	const overlap = tokenOverlap(rootTokensOf(a), rootTokensOf(b));
	if (locationOverlap === true) return overlap >= 0.35;
	return overlap >= DUPLICATE_OVERLAP;
}

function mergeFindingItems(primary, duplicate) {
	primary.locations = dedupeLocations([
		...(Array.isArray(primary.locations) ? primary.locations : []),
		...(Array.isArray(duplicate.locations) ? duplicate.locations : []),
	]);
	primary.evidenceQuotes = dedupeStrings([
		...(Array.isArray(primary.evidenceQuotes) ? primary.evidenceQuotes : []),
		...(Array.isArray(duplicate.evidenceQuotes) ? duplicate.evidenceQuotes : []),
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
		partitions[bucketName] = merged;
	}
	return mergedCount;
}

function compactFindingForReport(item) {
	return {
		...(item.findingId ? { findingId: item.findingId } : {}),
		...(item.rootCauseId ? { rootCauseId: item.rootCauseId } : {}),
		title: item.title,
		severity: item.severity,
		...(item.file ? { file: item.file } : {}),
		locations: Array.isArray(item.locations) ? item.locations : [],
		evidenceQuotes: Array.isArray(item.evidenceQuotes) ? item.evidenceQuotes : [],
		...(item.recommendedAction ? { recommendedAction: item.recommendedAction } : {}),
		...(Array.isArray(item.counterEvidence) && item.counterEvidence.length > 0
			? { counterEvidence: item.counterEvidence }
			: {}),
		...(item.note ? { note: item.note } : {}),
		...(Array.isArray(item.mergedFindings) && item.mergedFindings.length > 0
			? {
					mergedFindingIds: item.mergedFindings
						.map((finding) => finding.findingId ?? finding.id)
						.filter(Boolean),
				}
			: {}),
	};
}

function buildReportContext(partitions, supportNotes, partitionSummary, normalizationNotes, partialFailures) {
	return {
		keep: partitions.keep.map(compactFindingForReport),
		weaken: partitions.weaken.map(compactFindingForReport),
		needsHuman: partitions.needsHuman.map(compactFindingForReport),
		supportNoteSummaries: supportNotes.map((note) => ({
			title: note.title,
			...(note.severity ? { severity: note.severity } : {}),
			...(note.file ? { file: note.file } : {}),
			...(note.reason ? { reason: note.reason } : {}),
			...(note.supportingFindingOf ? { supportingFindingOf: note.supportingFindingOf } : {}),
			locations: Array.isArray(note.locations) ? note.locations : [],
			evidenceQuotes: Array.isArray(note.evidenceQuotes) ? note.evidenceQuotes : [],
		})),
		partialFailures,
		partitionSummary,
		normalizationNotes,
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
	const verdictEntries = [];
	for (const [specId, source] of Object.entries(sources ?? {})) {
		if (specId.startsWith(`${dedupStageId}.`) || specId === dedupStageId) {
			reviewerFindings = findingsOf(source);
			continue;
		}
		const entry = verdictEntryOf(source);
		if (entry) verdictEntries.push(entry);
	}

	const byTitle = new Map();
	for (const finding of reviewerFindings) {
		byTitle.set(normalizeText(finding.title), finding);
	}
	const findMatch = (title) => {
		const key = normalizeText(title);
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

	const partitions = { keep: [], weaken: [], drop: [], needsHuman: [] };
	const normalizationNotes = [];
	const matchedTitles = new Set();
	let missingVerdicts = 0;

	for (const entry of verdictEntries) {
		const title = findingTitleOf(entry);
		const { finding: reviewerFinding, key: titleKey } = findMatch(title);
		if (reviewerFinding) matchedTitles.add(titleKey);
		const { verdict, normalized, invalid } = normalizeVerdict(entry.verdict);
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
			findingId: reviewerFinding?.findingId ?? reviewerFinding?.id,
			rootCauseId: reviewerFinding?.rootCauseId ?? reviewerFinding?.findingId ?? reviewerFinding?.id,
			title,
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
			reviewerFinding,
			evidenceQuotes: dedupeStrings([
				...(reviewerFinding?.evidenceQuotes ?? []),
				...quoteStrings(entry.evidenceQuotes),
				...quoteStrings(entry.evidenceQuote),
				...quoteStrings(entry.evidence),
			]),
			evidence: entry.evidence ?? [],
			counterEvidence: entry.counterEvidence ?? [],
			recommendedAction: entry.recommendedAction ?? "",
		};
		if (verdict === "KEEP") partitions.keep.push(item);
		else if (verdict === "WEAKEN") partitions.weaken.push(item);
		else if (verdict === "DROP") partitions.drop.push(item);
		else partitions.needsHuman.push(item);
	}

	// Findings the devil-advocate stage never returned a verdict for must not
	// vanish silently: route them to needsHuman.
	for (const finding of reviewerFindings) {
		const titleKey = normalizeText(finding.title);
		if (matchedTitles.has(titleKey)) continue;
		missingVerdicts += 1;
		partitions.needsHuman.push({
			findingId: finding.findingId ?? finding.id,
			rootCauseId: finding.rootCauseId ?? finding.findingId ?? finding.id,
			title: String(finding.title ?? ""),
			verdict: "NEEDS_HUMAN",
			severity: finding.severity,
			file: finding.file,
			locations: finding.locations ?? locationsOf(finding),
			reviewerFinding: finding,
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
		verdictsReceived: verdictEntries.length,
		reviewerFindings: reviewerFindings.length,
		missingVerdicts,
		partialFailures: partialFailures.length,
	};
	const reportContext = buildReportContext(
		partitions,
		supportNotes,
		partitionSummary,
		normalizationNotes,
		partialFailures,
	);

	return {
		partitions,
		supportNotes,
		reportContext,
		digest: `partition: keep=${partitionSummary.keep}, weaken=${partitionSummary.weaken}, drop=${partitionSummary.drop}, needsHuman=${partitionSummary.needsHuman}, missingVerdicts=${missingVerdicts}, partialFailures=${partialFailures.length}, supportNotes=${supportNotes.length}`,
		sourceStatusSummary: {
			...directStatusSummary,
			partialFailures,
			nonCompleted: partialFailures.length,
		},
		partitionSummary,
		normalizationNotes,
	};
}

export default async function findingPipeline({ sources, options = {}, context = {} }) {
	const mode = String(options.mode ?? "");
	if (mode === "dedup") return dedupFindings(sources, context);
	if (mode === "partition") return partitionVerdicts(sources, options, context);
	throw new Error(
		`finding-pipeline: unknown mode "${mode}" (expected "dedup" or "partition")`,
	);
}
