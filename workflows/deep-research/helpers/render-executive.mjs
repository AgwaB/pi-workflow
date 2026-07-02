// Deterministic evidence-backed renderer for deep-research.
//
// Input: final-audit.control.json from the full deep-research final stage.
// Output: a parent-facing research report in executiveMarkdown plus sidecars.
//
// This intentionally treats final-audit.control.json as the source of truth and
// renders a bounded view. It does not re-verify or invent evidence.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

function findSource(sources, stageId) {
	const entries = Object.entries(sources ?? {});
	const exact = entries.find(([specId]) => specId === stageId);
	if (exact) return exact[1];
	const dotted = entries.find(([specId]) => specId.startsWith(`${stageId}.`));
	return dotted?.[1] ?? null;
}

function asArray(value) {
	return Array.isArray(value) ? value : [];
}

function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function flattenItems(value) {
	if (Array.isArray(value)) return value.flatMap((item) => flattenItems(item));
	if (typeof value === "string") return value.trim() ? [value] : [];
	if (!isRecord(value)) return [];
	const renderFields = [
		"gap",
		"finding",
		"claim",
		"note",
		"reason",
		"nextStep",
		"evidenceState",
		"whyItMatters",
		"parentImpact",
		"recommendation",
		"action",
		"step",
	];
	if (
		renderFields.some(
			(field) => typeof value[field] === "string" && value[field].trim(),
		)
	) {
		return [value];
	}
	if (
		value.id ||
		value.gapId ||
		value.slotId ||
		Array.isArray(value.relatedFactSlotIds) ||
		Array.isArray(value.sourceUrls) ||
		Array.isArray(value.sourceRefs)
	) {
		return [value];
	}
	return Object.values(value).flatMap((item) => flattenItems(item));
}

function words(text) {
	return (
		String(text ?? "")
			.trim()
			.match(/\S+/g) ?? []
	);
}

function countWords(text) {
	return words(text).length;
}

function cleanText(value) {
	return String(value ?? "")
		.replace(/\s+/g, " ")
		.replace(/\s+([,.;:!?])/g, "$1")
		.trim();
}

function escapeTableCell(value) {
	return cleanText(value).replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

function stringifyItem(item) {
	if (typeof item === "string") return cleanText(item) || "(empty string)";
	try {
		const json = JSON.stringify(item);
		if (json) return cleanText(json);
	} catch {
		// Fall through to String below.
	}
	return cleanText(String(item)) || "(empty item)";
}

function summaryText(report, fallback) {
	const summary = report?.summary;
	if (typeof summary === "string" && summary.trim()) return cleanText(summary);
	if (isRecord(summary)) {
		const parts = [
			summary.directAnswer,
			summary.answer,
			summary.summary,
			summary.finding,
		]
			.filter((value) => typeof value === "string" && value.trim())
			.map(cleanText);
		const confidence = cleanText(summary.confidence ?? "");
		const caveat = cleanText(summary.keyCaveat ?? summary.caveat ?? "");
		return (
			[
				parts[0],
				confidence ? `Confidence: ${confidence}.` : undefined,
				caveat ? `Key caveat: ${caveat}.` : undefined,
			]
				.filter(Boolean)
				.join(" ") || stringifyItem(summary)
		);
	}
	return cleanText(fallback ?? "Research completed with audited evidence.");
}

function hasObjectSerializationArtifact(text) {
	return /\[object Object\]/.test(String(text ?? ""));
}

function truncateWords(text, maxWords) {
	const items = words(text);
	if (items.length <= maxWords) return cleanText(text);
	return `${items
		.slice(0, maxWords)
		.join(" ")
		.replace(/[,:;]$/, "")}…`;
}

function hostOf(url) {
	try {
		return new URL(url).host.replace(/^www\./, "");
	} catch {
		return "source";
	}
}

function normalizeUrl(url) {
	if (typeof url !== "string") return null;
	const trimmed = url.trim().replace(/[.,;:]+$/, "");
	if (!/^https?:\/\//i.test(trimmed)) return null;
	try {
		const parsed = new URL(trimmed);
		parsed.hash = "";
		return parsed.toString();
	} catch {
		return trimmed;
	}
}

function collectStructuredUrls(value, urls = []) {
	if (!value || typeof value !== "object") return urls;
	if (Array.isArray(value)) {
		for (const item of value) collectStructuredUrls(item, urls);
		return urls;
	}
	for (const [key, item] of Object.entries(value)) {
		if (
			/^(sourceUrls?|evidenceUrls?|urls?|url|uri|href|links?|references?|refs?|basis|sources)$/i.test(
				key,
			)
		) {
			for (const candidate of asArray(item).length ? item : [item]) {
				const normalized = normalizeUrl(candidate);
				if (normalized) urls.push(normalized);
				else if (candidate && typeof candidate === "object") {
					collectStructuredUrls(candidate, urls);
				}
			}
			continue;
		}
		if (item && typeof item === "object") collectStructuredUrls(item, urls);
	}
	return urls;
}

function uniqueStructuredUrls(...values) {
	const out = [];
	const seen = new Set();
	for (const value of values) {
		for (const url of collectStructuredUrls(value, [])) {
			if (seen.has(url)) continue;
			seen.add(url);
			out.push(url);
		}
	}
	return out;
}

function urlsOf(item, limit = 3) {
	return uniqueStructuredUrls(item).slice(0, limit);
}

function normalizeLocalRef(value) {
	if (typeof value !== "string") return null;
	const text = value.trim();
	if (!text || /^https?:\/\//i.test(text) || isWorkflowSourceRefText(text))
		return null;
	const stripped = text.replace(/^(?:file|repo):/i, "");
	if (!/[\w./-]+\.[\w]+(?:#L\d+(?:-L?\d+)?)?$/i.test(stripped)) return null;
	return stripped;
}

function isWorkflowSourceRefText(value) {
	return /^wsrc_[a-z0-9]{16,}$/i.test(String(value ?? "").trim());
}

function collectLocalRefs(value, refs = []) {
	if (!value || typeof value !== "object") return refs;
	if (Array.isArray(value)) {
		for (const item of value) collectLocalRefs(item, refs);
		return refs;
	}
	for (const [key, item] of Object.entries(value)) {
		if (/^(files?|paths?|sourceRefs?|sourceUrls?|sources?)$/i.test(key)) {
			for (const candidate of asArray(item).length ? item : [item]) {
				const ref = normalizeLocalRef(candidate);
				if (ref) refs.push(ref);
				else if (candidate && typeof candidate === "object")
					collectLocalRefs(candidate, refs);
			}
			continue;
		}
		if (item && typeof item === "object") collectLocalRefs(item, refs);
	}
	return refs;
}

function localRefsOf(item, limit = 3) {
	const out = [];
	const seen = new Set();
	for (const ref of collectLocalRefs(item, [])) {
		if (seen.has(ref)) continue;
		seen.add(ref);
		out.push(ref);
		if (out.length >= limit) break;
	}
	return out;
}

function referenceList(item, limit = 3) {
	const urls = markdownLinkList(urlsOf(item, limit), limit);
	const localRefs = localRefsOf(item, limit)
		.map((ref) => `\`${ref}\``)
		.join(", ");
	return [urls, localRefs].filter(Boolean).join("; ");
}

function markdownLinkList(urls, maxItems = 3) {
	return urls
		.slice(0, maxItems)
		.map((url) => `[${hostOf(url)}](${url})`)
		.join(", ");
}

function itemText(item, fields, fallback = "") {
	if (typeof item === "string") return cleanText(item) || fallback;
	if (!item || typeof item !== "object") return fallback;
	for (const field of fields) {
		if (typeof item[field] === "string" && item[field].trim()) {
			return cleanText(item[field]);
		}
	}
	return fallback;
}

function evidenceStatusOf(item) {
	if (!item || typeof item !== "object") return "not specified";
	return cleanText(
		item.evidenceStatus ??
			item.status ??
			item.confidence ??
			item.sourceQuality ??
			"not specified",
	);
}

function confidenceOf(item) {
	if (!item || typeof item !== "object") return "";
	return cleanText(item.confidence ?? item.evidenceStatus ?? "");
}

function finiteNumber(value) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeClaimStatus(status) {
	const text = cleanText(status).toLowerCase();
	if (!text) return "";
	if (text.includes("conflict")) return "conflicting";
	if (text.includes("unsupported")) return "unsupported";
	if (text.includes("partial")) return "partially_supported";
	if (text.includes("verified")) return "verified";
	return text;
}

function coverageCounts(coverage, fallback) {
	if (!coverage || typeof coverage !== "object") return null;
	const counts = {
		total: finiteNumber(coverage.verificationCandidates) ?? fallback.total,
		verified: finiteNumber(coverage.verified) ?? fallback.verified,
		partially_supported:
			finiteNumber(coverage.partiallySupported) ??
			finiteNumber(coverage.partially_supported) ??
			fallback.partially_supported,
		unsupported: finiteNumber(coverage.unsupported) ?? fallback.unsupported,
		conflicting: finiteNumber(coverage.conflicting) ?? fallback.conflicting,
	};
	if (counts.total == null) {
		counts.total =
			counts.verified +
			counts.partially_supported +
			counts.unsupported +
			counts.conflicting;
	}
	return counts;
}

function packetVerdictCounts(packet, fallback) {
	const verdicts = packet?.verdictCounts;
	if (!isRecord(verdicts)) return null;
	const counts = coverageCounts(verdicts, fallback);
	if (!counts) return null;
	counts.total =
		finiteNumber(packet?.invariantChecks?.candidateCount) ??
		finiteNumber(verdicts.total) ??
		counts.verified +
			counts.partially_supported +
			counts.unsupported +
			counts.conflicting;
	return counts;
}

function claimCounts(control, packet) {
	const claims = asArray(control?.claimVerdictIndex?.claims);
	const counts = {
		total: claims.length,
		verified: 0,
		partially_supported: 0,
		unsupported: 0,
		conflicting: 0,
	};
	for (const claim of claims) {
		const status = normalizeClaimStatus(claim?.status);
		if (status && Object.hasOwn(counts, status)) counts[status] += 1;
	}
	const packetCounts = packetVerdictCounts(packet, counts);
	if (packetCounts) return packetCounts;

	const coverage = coverageCounts(
		control?.finalReport?.coverageSummary,
		counts,
	);
	if (claims.length === 0 && coverage) return coverage;
	if (!coverage) return counts;

	const mismatches = [];
	for (const key of [
		"total",
		"verified",
		"partially_supported",
		"unsupported",
		"conflicting",
	]) {
		if (coverage[key] !== counts[key]) {
			mismatches.push({
				field: key,
				claimVerdictIndex: counts[key],
				coverageSummary: coverage[key],
			});
		}
	}
	return mismatches.length > 0
		? { ...counts, coverageSummaryMismatch: mismatches }
		: counts;
}

function factSlotSummary(factSlots) {
	return {
		total: factSlots.length,
		filled: factSlots.filter((slot) => slot?.status === "filled").length,
		partial: factSlots.filter((slot) => slot?.status === "partial").length,
		missingOrConflicting: factSlots.filter((slot) =>
			["missing", "gap", "conflicting"].includes(slot?.status),
		).length,
	};
}

function stringArray(value, limit = Infinity) {
	const out = [];
	const seen = new Set();
	for (const item of asArray(value)) {
		if (typeof item !== "string") continue;
		const text = item.trim();
		if (!text || seen.has(text)) continue;
		seen.add(text);
		out.push(text);
		if (out.length >= limit) break;
	}
	return out;
}

function uniqueStrings(values, limit = Infinity) {
	const out = [];
	const seen = new Set();
	for (const value of values) {
		if (typeof value !== "string") continue;
		const text = value.trim();
		if (!text || seen.has(text)) continue;
		seen.add(text);
		out.push(text);
		if (out.length >= limit) break;
	}
	return out;
}

function packetOf(packetSource) {
	return isRecord(packetSource?.packet) ? packetSource.packet : {};
}

function claimIdOf(row) {
	return cleanText(row?.id ?? row?.claimId ?? "");
}

function gapIdOf(row) {
	return cleanText(row?.id ?? row?.gapId ?? "");
}

function claimLedger(packet, control) {
	const packetLedger = asArray(packet?.claimVerdictLedger);
	return packetLedger.length
		? packetLedger
		: asArray(control?.claimVerdictIndex?.claims);
}

function mapById(rows, idFn) {
	const out = new Map();
	for (const row of rows) {
		const id = idFn(row);
		if (id && !out.has(id)) out.set(id, row);
	}
	return out;
}

function numberedId(prefix, index) {
	return `${prefix}-${String(index + 1).padStart(3, "0")}`;
}

function packetGapRows(packet) {
	const remaining = asArray(packet?.remainingGaps).map((gap, index) => ({
		id: gapIdOf(gap) || numberedId("gap-remaining", index),
		kind: "Gap",
		...gap,
	}));
	const coverage = asArray(packet?.coverageGaps).map((gap, index) => ({
		id: gapIdOf(gap) || numberedId("gap-coverage", index),
		kind: "Coverage gap",
		...gap,
	}));
	return [...remaining, ...coverage];
}

function rowsForIds(ids, rowById, warnings, label) {
	const rows = [];
	for (const id of ids) {
		const row = rowById.get(id);
		if (row) {
			rows.push(row);
			continue;
		}
		warnings.push({
			section: "references",
			label,
			total: 1,
			rendered: 0,
			missingId: id,
		});
	}
	return rows;
}

function claimSourceUrls(rows, limit = 8) {
	return uniqueStrings(
		rows.flatMap((row) => [...asArray(row?.sourceUrls), ...urlsOf(row, limit)]),
		limit,
	);
}

function claimSourceRefs(rows, limit = 8) {
	return uniqueStrings(
		rows.flatMap((row) => asArray(row?.sourceRefs)),
		limit,
	);
}

function evidenceStrength(status) {
	switch (normalizeClaimStatus(status)) {
		case "verified":
			return 3;
		case "partially_supported":
			return 2;
		case "unsupported":
			return 1;
		case "conflicting":
			return 0;
		default:
			return -1;
	}
}

function evidenceStatusFromRows(rows, fallback) {
	if (rows.length === 0) return cleanText(fallback) || "not specified";
	let weakest = "verified";
	let weakestScore = Infinity;
	for (const row of rows) {
		const status = normalizeClaimStatus(row?.status ?? row?.verdict);
		const score = evidenceStrength(status);
		if (score >= 0 && score < weakestScore) {
			weakest = status;
			weakestScore = score;
		}
	}
	return weakestScore === Infinity
		? cleanText(fallback) || "not specified"
		: weakest;
}

function claimToFinding(row) {
	return {
		id: claimIdOf(row),
		finding: cleanText(row?.claim ?? row?.support ?? stringifyItem(row)),
		evidenceStatus: normalizeClaimStatus(row?.status) || row?.status,
		confidence: row?.confidence,
		sourceUrls: asArray(row?.sourceUrls),
		sourceRefs: asArray(row?.sourceRefs),
		rationale: row?.support,
		caveat: row?.caveat,
		correctionOrCounterclaim: row?.correctionOrCounterclaim,
	};
}

function supportingClaimIds(item) {
	return uniqueStrings([
		...asArray(item?.supportingClaimIds),
		...asArray(item?.claimIds),
		...asArray(item?.relatedClaimIds),
	]);
}

function withSupportingEvidence(item, claimRows) {
	return {
		...item,
		evidenceStatus: evidenceStatusFromRows(claimRows, item?.evidenceStatus),
		sourceUrls: uniqueStrings(
			[...asArray(item?.sourceUrls), ...claimSourceUrls(claimRows)],
			8,
		),
		sourceRefs: uniqueStrings(
			[...asArray(item?.sourceRefs), ...claimSourceRefs(claimRows)],
			8,
		),
	};
}

function coverageSummaryFromPacket(packet, fallback = {}) {
	const counts = packetVerdictCounts(packet, {
		total: 0,
		verified: 0,
		partially_supported: 0,
		unsupported: 0,
		conflicting: 0,
	});
	if (!counts) return fallback;
	return {
		...fallback,
		verified: counts.verified,
		partiallySupported: counts.partially_supported,
		unsupported: counts.unsupported,
		conflicting: counts.conflicting,
		verificationCandidates: counts.total,
		depth: packet?.researchMetadataSeed?.depth ?? fallback.depth,
		researchQuestions:
			packet?.researchMetadataSeed?.researchQuestions ??
			fallback.researchQuestions,
		preserved:
			packet?.overflowLedger?.preservedClaimCount ?? fallback.preserved,
		coverageGaps:
			packet?.overflowLedger?.coverageGapCount ?? fallback.coverageGaps,
	};
}

function composeResearchReport(control, packetSource) {
	const packet = packetOf(packetSource);
	const legacyReport = control?.finalReport ?? {};
	const synthesis = isRecord(control?.synthesis) ? control.synthesis : null;
	const ledger = claimLedger(packet, control);
	const claimById = mapById(ledger, claimIdOf);
	const gapRows = packetGapRows(packet);
	const gapById = mapById(gapRows, gapIdOf);
	const warnings = [];

	if (!synthesis) {
		const report = { ...legacyReport };
		if (asArray(packet.factSlotCoverage).length > 0)
			report.factSlotCoverage = packet.factSlotCoverage;
		if (isRecord(packet.researchMetadataSeed))
			report.researchMetadata = packet.researchMetadataSeed;
		if (isRecord(packet.verdictCounts))
			report.coverageSummary = coverageSummaryFromPacket(
				packet,
				report.coverageSummary,
			);
		if (asArray(report.remainingGaps).length === 0 && gapRows.length > 0)
			report.remainingGaps = gapRows;
		if (
			asArray(report.researchScopeCoverage).length === 0 &&
			asArray(packet.researchScopeCoverage).length > 0
		) {
			report.researchScopeCoverage = packet.researchScopeCoverage;
		}
		return { report, packet, ledger, warnings };
	}

	const keyFindingIds = stringArray(synthesis.keyFindingIds, 12);
	const keyFindingRows = keyFindingIds.length
		? rowsForIds(keyFindingIds, claimById, warnings, "key findings")
		: ledger
				.filter((row) => normalizeClaimStatus(row?.status) === "verified")
				.slice(0, 8);
	const mapOverlayItems = (items, textField) =>
		asArray(items).map((item) => {
			const ids = supportingClaimIds(item);
			const rows = rowsForIds(ids, claimById, warnings, textField);
			return withSupportingEvidence(item, rows);
		});
	const caveatNotes = asArray(synthesis.caveatNotes).map((item) => {
		const rows = rowsForIds(
			supportingClaimIds(item),
			claimById,
			warnings,
			"caveat notes",
		);
		const gaps = rowsForIds(
			stringArray(item?.gapIds, 12),
			gapById,
			warnings,
			"gap notes",
		);
		return withSupportingEvidence(
			{
				...item,
				relatedGaps: gaps,
			},
			rows,
		);
	});
	const optionalUnsupported = rowsForIds(
		stringArray(synthesis.notableUnsupportedClaimIds, 12),
		claimById,
		warnings,
		"unsupported claims",
	).map(claimToFinding);
	const optionalContested = rowsForIds(
		stringArray(synthesis.contestedClaimIds, 12),
		claimById,
		warnings,
		"contested claims",
	).map(claimToFinding);
	const derivedUnsupported = ledger
		.filter((row) => normalizeClaimStatus(row?.status) === "unsupported")
		.map(claimToFinding);
	const derivedContested = ledger
		.filter((row) => normalizeClaimStatus(row?.status) === "conflicting")
		.map(claimToFinding);

	return {
		report: {
			summary: synthesis.bottomLine ?? control?.digest,
			researchMetadata: packet.researchMetadataSeed ?? {},
			coverageSummary: coverageSummaryFromPacket(packet, {}),
			factSlotCoverage: asArray(packet.factSlotCoverage),
			mainFindings: keyFindingRows.map(claimToFinding),
			recommendations: mapOverlayItems(
				synthesis.recommendations,
				"recommendations",
			),
			actionPlan: mapOverlayItems(synthesis.actionPlan, "action plan"),
			caveatedFindings: caveatNotes,
			contestedAreas: optionalContested.length
				? optionalContested
				: derivedContested,
			notableUnsupportedClaims: optionalUnsupported.length
				? optionalUnsupported
				: derivedUnsupported,
			unverifiedButRelevant: asArray(packet.preservedClaims),
			parentDecisionNotes: mapOverlayItems(
				synthesis.parentDecisionNotes,
				"decision notes",
			),
			researchScopeCoverage: asArray(packet.researchScopeCoverage),
			remainingGaps: gapRows,
		},
		packet,
		ledger,
		warnings,
	};
}

function statusRank(item) {
	const status =
		`${item?.evidenceStatus ?? item?.status ?? item?.confidence ?? ""}`.toLowerCase();
	if (
		status.includes("missing") ||
		status.includes("gap") ||
		status.includes("conflict")
	) {
		return 0;
	}
	if (status.includes("unsupported")) return 1;
	if (status.includes("partial")) return 2;
	if (status.includes("verified") && !status.includes("partial")) return 3;
	if (status.includes("filled") || status.includes("high")) return 4;
	return 5;
}

function sortedFactSlots(report) {
	return asArray(report.factSlotCoverage)
		.slice()
		.sort(
			(a, b) =>
				statusRank(a) - statusRank(b) ||
				cleanText(a?.slotId ?? a?.label).localeCompare(
					cleanText(b?.slotId ?? b?.label),
				),
		);
}

function renderEvidenceStrength(report) {
	const slots = sortedFactSlots(report);
	const rows = slots.map((slot) => {
		const area = escapeTableCell(
			slot.label ?? slot.slotId ?? slot.bestValue ?? "Evidence area",
		);
		const status = escapeTableCell(evidenceStatusOf(slot));
		const evidence = escapeTableCell(referenceList(slot, 2) || "—");
		const impact = escapeTableCell(
			slot.parentImpact ?? slot.whyItMatters ?? slot.notes ?? "",
		);
		return `| ${area || "Evidence area"} | ${status || "—"} | ${evidence} | ${impact || "—"} |`;
	});
	if (rows.length === 0) return [];
	return [
		"## Evidence strength",
		"",
		"| Area | Status | Evidence | Why it matters |",
		"|---|---|---|---|",
		...rows,
		"",
	];
}

function mainFindingEntries(report) {
	return asArray(report.mainFindings).map((item) => ({
		item,
		text: itemText(
			item,
			["finding", "summary", "bestValue", "claim"],
			stringifyItem(item),
		),
	}));
}

function recommendationEntries(report) {
	return asArray(report.recommendations).map((item) => ({
		item,
		text: itemText(
			item,
			["recommendation", "action", "step", "note"],
			stringifyItem(item),
		),
	}));
}

function actionEntries(report) {
	return asArray(report.actionPlan).map((item) => ({
		item,
		text:
			itemText(item, ["action", "recommendation", "note"]) ||
			(typeof item?.step === "string" && cleanText(item.step)) ||
			stringifyItem(item),
	}));
}

function renderMainFindings(report) {
	const findings = mainFindingEntries(report);
	if (findings.length === 0) return [];
	const out = ["## Main findings", ""];
	findings.forEach(({ item: finding, text }, index) => {
		const status = evidenceStatusOf(finding);
		const confidence = confidenceOf(finding);
		const urls = referenceList(finding, 4);
		out.push(`### ${index + 1}. ${text}`);
		out.push("");
		out.push(
			`Evidence status: **${status || "not specified"}**${confidence && confidence !== status ? `  \nConfidence: **${confidence}**` : ""}`,
		);
		if (urls) out.push(`Sources: ${urls}`);
		const explanation = itemText(finding, [
			"rationale",
			"explanation",
			"details",
			"notes",
		]);
		if (explanation && explanation !== text) out.push("", explanation);
		out.push("");
	});
	return out;
}

function renderRecommendations(report) {
	const recommendations = recommendationEntries(report);
	if (recommendations.length === 0) return [];
	const out = ["## Recommendations", ""];
	recommendations.forEach(({ item, text }, index) => {
		const status = evidenceStatusOf(item);
		const urls = referenceList(item, 4);
		out.push(`${index + 1}. **${text}**`);
		out.push(`   - Evidence status: ${status || "not specified"}`);
		if (urls) out.push(`   - Sources: ${urls}`);
		out.push("");
	});
	return out;
}

function renderActionPlan(report) {
	const actions = actionEntries(report);
	if (actions.length === 0) return [];
	const out = ["## Action plan", ""];
	actions.forEach(({ item, text }, index) => {
		const numericStep = Number(item?.step);
		const step = Number.isFinite(numericStep) ? numericStep : index + 1;
		const urls = referenceList(item, 3);
		const evidence = evidenceStatusOf(item);
		out.push(`${step}. ${text}`);
		if (evidence && evidence !== "not specified")
			out.push(`   - Evidence: ${evidence}`);
		if (urls) out.push(`   - Sources: ${urls}`);
		out.push("");
	});
	return out;
}

function fallbackCaveatText(item) {
	if (!isRecord(item)) return stringifyItem(item);
	const id = cleanText(item.id ?? item.gapId ?? "");
	const slotIds = uniqueStrings([
		item.slotId,
		...asArray(item.relatedFactSlotIds),
	]).join(", ");
	const kind = cleanText(item.kind ?? "gap");
	return (
		[kind, id, slotIds ? `related slots: ${slotIds}` : undefined]
			.filter(Boolean)
			.join(" — ") || stringifyItem(item)
	);
}

function caveatText(item) {
	return itemText(
		item,
		[
			"gap",
			"finding",
			"claim",
			"note",
			"reason",
			"nextStep",
			"evidenceState",
			"whyItMatters",
			"parentImpact",
		],
		fallbackCaveatText(item),
	);
}

function caveatCategories(report) {
	return [
		{ kind: "Gap", items: flattenItems(report.remainingGaps) },
		{
			kind: "Unsupported",
			items: flattenItems(report.notableUnsupportedClaims),
		},
		{ kind: "Contested", items: flattenItems(report.contestedAreas) },
		{ kind: "Caveat", items: flattenItems(report.caveatedFindings) },
		{
			kind: "Unverified lead",
			items: flattenItems(report.unverifiedButRelevant),
		},
		{ kind: "Decision note", items: flattenItems(report.parentDecisionNotes) },
	]
		.map((category) => ({
			kind: category.kind,
			entries: category.items
				.map((item) => ({ item, text: caveatText(item) }))
				.filter((entry) => entry.text),
		}))
		.filter((category) => category.entries.length > 0);
}

function selectCaveats(report) {
	const categories = caveatCategories(report);
	const selected = [];
	for (const category of categories) {
		for (const entry of category.entries) {
			selected.push({ kind: category.kind, ...entry });
		}
	}
	return {
		selected,
		total: selected.length,
	};
}

function renderCaveats(report) {
	const selection = selectCaveats(report);
	if (selection.total === 0) return [];
	const out = ["## Caveats and remaining gaps", ""];
	for (const { kind, item, text } of selection.selected) {
		const urls = referenceList(item, 3);
		out.push(`- **${kind}:** ${text}${urls ? ` (${urls})` : ""}`);
	}
	out.push("");
	return out;
}

function renderSourceIndex(sourceIndex) {
	if (sourceIndex.length === 0) return [];
	const grouped = new Map();
	for (const url of sourceIndex) {
		const host = hostOf(url);
		if (!grouped.has(host)) grouped.set(host, []);
		grouped.get(host).push(url);
	}
	const out = ["## Source index", ""];
	for (const [host, urls] of grouped) {
		out.push(
			`- **${host}**: ${urls.map((url) => `[${url}](${url})`).join(", ")}`,
		);
	}
	out.push("");
	return out;
}

function renderAuditSummary(report, claimSummary, slots) {
	const coverage = report?.coverageSummary ?? {};
	const mismatches = asArray(claimSummary.coverageSummaryMismatch);
	return [
		"## Audit summary",
		"",
		`- Claims: ${claimSummary.verified} verified, ${claimSummary.partially_supported} partially supported, ${claimSummary.unsupported} unsupported, ${claimSummary.conflicting} conflicting.`,
		`- Fact slots: ${slots.filled} filled, ${slots.partial} partial, ${slots.missingOrConflicting} missing/conflicting, ${slots.total} total.`,
		...(mismatches.length > 0
			? [
					`- Coverage summary mismatch: displayed claim counts come from \`claimVerdictIndex\`; model coverageSummary disagreed on ${mismatches
						.map((mismatch) => mismatch.field)
						.join(", ")}.`,
				]
			: []),
		...(coverage.researchQuestions != null
			? [`- Research questions: ${coverage.researchQuestions}.`]
			: []),
		"- Audit artifact: `audit.md`.",
		"",
	];
}

function renderWarnings(sectionCounts) {
	const checks = [
		["findings", "renderedFindings", "findings"],
		["recommendations", "renderedRecommendations", "recommendations"],
		["actionItems", "renderedActionItems", "action items"],
		["caveatsAndGaps", "renderedCaveatsAndGaps", "caveats/gaps"],
		["factSlots", "renderedFactSlots", "fact slots"],
		["sourceUrls", "renderedSourceUrls", "source URLs"],
	];
	return checks
		.filter(([totalKey, renderedKey]) => {
			const total = Number(sectionCounts[totalKey] ?? 0);
			const rendered = Number(sectionCounts[renderedKey] ?? 0);
			return total !== rendered;
		})
		.map(([totalKey, renderedKey, label]) => ({
			section: totalKey,
			label,
			total: sectionCounts[totalKey],
			rendered: sectionCounts[renderedKey],
		}));
}

function renderResearchMarkdown(control, packetSource, options = {}) {
	const composed = composeResearchReport(control, packetSource);
	const report = composed.report;
	const claimSummary = claimCounts(control, composed.packet);
	const factSlots = sortedFactSlots(report);
	const slots = factSlotSummary(asArray(report.factSlotCoverage));
	const findings = mainFindingEntries(report);
	const recommendations = recommendationEntries(report);
	const actions = actionEntries(report);
	const caveats = selectCaveats(report);
	const allSourceIndex = uniqueStructuredUrls(
		report.factSlotCoverage,
		report.mainFindings,
		report.recommendations,
		report.actionPlan,
		report.caveatedFindings,
		report.contestedAreas,
		report.notableUnsupportedClaims,
		report.remainingGaps,
		report.parentDecisionNotes,
		report.unverifiedButRelevant,
		composed.ledger,
	);
	const maxUrls = Number.isFinite(Number(options.maxUrls))
		? Math.max(0, Number(options.maxUrls))
		: Infinity;
	const sourceIndex = Number.isFinite(maxUrls)
		? allSourceIndex.slice(0, maxUrls)
		: allSourceIndex;
	const sectionCounts = {
		findings: asArray(report.mainFindings).length,
		renderedFindings: findings.length,
		recommendations: asArray(report.recommendations).length,
		renderedRecommendations: recommendations.length,
		actionItems: asArray(report.actionPlan).length,
		renderedActionItems: actions.length,
		caveatsAndGaps:
			flattenItems(report.remainingGaps).length +
			flattenItems(report.notableUnsupportedClaims).length +
			flattenItems(report.contestedAreas).length +
			flattenItems(report.caveatedFindings).length +
			flattenItems(report.unverifiedButRelevant).length +
			flattenItems(report.parentDecisionNotes).length,
		renderedCaveatsAndGaps: caveats.selected.length,
		factSlots: asArray(report.factSlotCoverage).length,
		renderedFactSlots: factSlots.length,
		sourceUrls: allSourceIndex.length,
		renderedSourceUrls: sourceIndex.length,
	};
	const warnings = [...renderWarnings(sectionCounts), ...composed.warnings];

	const sections = [
		"# Research report",
		"",
		"## Bottom line",
		"",
		summaryText(report, control.digest),
		"",
		...renderEvidenceStrength(report),
		...renderMainFindings(report),
		...renderRecommendations(report),
		...renderActionPlan(report),
		...renderCaveats(report),
		...renderSourceIndex(sourceIndex),
		...renderAuditSummary(report, claimSummary, slots),
	];

	const markdown = sections
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return {
		markdown,
		sourceIndex,
		allSourceIndex,
		claimSummary,
		factSlotSummary: slots,
		sectionCounts,
		renderWarnings: warnings,
	};
}

function stripLeadingHeading(markdown) {
	return String(markdown ?? "").replace(/^#\s+[^\n]+\n*/i, "");
}

function synthesisClaimRows(control, rows) {
	const synthesis = isRecord(control?.synthesis) ? control.synthesis : null;
	if (!synthesis) return asArray(control?.claimVerdictIndex?.claims);
	const rowById = mapById(rows, claimIdOf);
	const ids = uniqueStrings([
		...asArray(synthesis.keyFindingIds),
		...asArray(synthesis.notableUnsupportedClaimIds),
		...asArray(synthesis.contestedClaimIds),
		...asArray(synthesis.recommendations).flatMap(supportingClaimIds),
		...asArray(synthesis.actionPlan).flatMap(supportingClaimIds),
		...asArray(synthesis.caveatNotes).flatMap(supportingClaimIds),
		...asArray(synthesis.parentDecisionNotes).flatMap(supportingClaimIds),
	]);
	return ids.map((id) => rowById.get(id)).filter(Boolean);
}

function renderAuditMarkdown(control, packetSource, rendered) {
	const packet = packetSource?.packet ?? {};
	const report = control?.finalReport ?? {};
	const ledger = asArray(packet.claimVerdictLedger);
	const claims = synthesisClaimRows(control, ledger);
	const gaps = asArray(packet.remainingGaps).length
		? asArray(packet.remainingGaps)
		: asArray(report.remainingGaps);
	const sourceRefJoinFailures = asArray(packet.sourceRefJoinFailures).filter(
		(failure) => uniqueStructuredUrls(failure).length > 0,
	);
	const factSlots = asArray(packet.factSlotCoverage).length
		? asArray(packet.factSlotCoverage)
		: asArray(report.factSlotCoverage);
	const rows = ledger.length ? ledger : claims;
	const out = [
		"# Research audit",
		"",
		"This artifact preserves the detailed claim/gap/source ledger behind `executive.md`.",
		"",
		"## Claim verdict ledger",
		"",
	];
	if (rows.length > 0) {
		out.push(
			"| ID | Status | Claim/support | Caveat/source |",
			"|---|---|---|---|",
		);
		for (const row of rows) {
			const id = escapeTableCell(row.id ?? row.claimId ?? "—");
			const status = escapeTableCell(row.status ?? row.confidence ?? "—");
			const support = escapeTableCell(
				row.claim ??
					row.support ??
					row.verdictDigest?.support ??
					stringifyItem(row),
			);
			const caveat = escapeTableCell(
				row.caveat ??
					row.correctionOrCounterclaim ??
					markdownLinkList(urlsOf(row, 3), 3) ??
					"—",
			);
			out.push(`| ${id} | ${status} | ${support} | ${caveat || "—"} |`);
		}
	} else {
		out.push("No compact claim ledger was provided.");
	}
	out.push("", "## Fact slot coverage", "");
	if (factSlots.length > 0) {
		out.push(
			"| Slot | Status | Best value | Gap/impact |",
			"|---|---|---|---|",
		);
		for (const slot of factSlots) {
			out.push(
				`| ${escapeTableCell(slot.slotId ?? slot.label ?? "—")} | ${escapeTableCell(slot.status ?? "—")} | ${escapeTableCell(isRecord(slot.bestValue) ? stringifyItem(slot.bestValue) : (slot.bestValue ?? "—"))} | ${escapeTableCell(slot.gapReason || slot.parentImpact || "—")} |`,
			);
		}
	} else {
		out.push("No fact-slot ledger was provided.");
	}
	out.push("", "## Remaining gaps", "");
	if (gaps.length > 0) {
		for (const gap of gaps)
			out.push(`- ${caveatText(gap) || stringifyItem(gap)}`);
	} else {
		out.push("No remaining gaps were reported.");
	}
	if (claims.length > 0 && ledger.length > 0) {
		out.push("", "## Claims used in executive synthesis", "");
		for (const claim of claims) {
			out.push(
				`- **${cleanText(claim.id ?? "claim")}** (${cleanText(claim.status ?? "unknown")}): ${cleanText(claim.claim ?? claim.support ?? stringifyItem(claim))}`,
			);
		}
	}
	if (sourceRefJoinFailures.length > 0) {
		out.push("", "## Source reference join failures", "");
		for (const failure of sourceRefJoinFailures)
			out.push(`- ${caveatText(failure) || stringifyItem(failure)}`);
	}
	out.push(
		"",
		"## Renderer diagnostics",
		"",
		`- Executive word count: ${countWords(rendered.markdown)}.`,
		`- Rendered source URLs: ${rendered.sourceIndex.length}/${rendered.allSourceIndex.length}.`,
		`- Render warnings: ${rendered.renderWarnings.length}.`,
		"",
	);
	return out
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export default async function renderExecutive({
	sources,
	options = {},
	context = {},
}) {
	const control =
		findSource(sources, "final-audit") ??
		sources?.[Object.keys(sources ?? {})[0]];
	const auditPacket = findSource(sources, "final-audit-packet");
	if (!control || typeof control !== "object") {
		return {
			schema: "deep-research-executive-render-v1",
			digest:
				"Research report rendering failed: missing final-audit control source.",
			status: "blocked",
			blockers: ["missing final-audit control source"],
			executiveMarkdown: "",
			reportMarkdown: "",
			auditMarkdown: "",
			wordCount: 0,
			sourceUrlCount: 0,
			totalSourceUrlCount: 0,
			sourceUrls: [],
			sourceIndex: [],
			claimSummary: {
				total: 0,
				verified: 0,
				partially_supported: 0,
				unsupported: 0,
				conflicting: 0,
			},
			factSlotSummary: {
				total: 0,
				filled: 0,
				partial: 0,
				missingOrConflicting: 0,
			},
			sectionCounts: {},
			renderWarnings: [],
			gates: {
				renderedAllStructuredItems: false,
				passed: false,
			},
			auditArtifact: "final-audit.control.json",
		};
	}

	const opts = {
		maxWords: Number.isFinite(Number(options.maxWords))
			? Math.max(0, Number(options.maxWords))
			: Infinity,
		maxUrls: Number.isFinite(Number(options.maxUrls))
			? Math.max(0, Number(options.maxUrls))
			: Infinity,
		maxFindings: Number.isFinite(Number(options.maxFindings))
			? Math.max(0, Number(options.maxFindings))
			: undefined,
		maxRecommendations: Number.isFinite(Number(options.maxRecommendations))
			? Math.max(0, Number(options.maxRecommendations))
			: undefined,
		maxGaps: Number.isFinite(Number(options.maxGaps))
			? Math.max(0, Number(options.maxGaps))
			: undefined,
	};
	const rendered = renderResearchMarkdown(control, auditPacket, opts);
	let markdown = rendered.markdown;
	let truncated = false;
	if (Number.isFinite(opts.maxWords) && countWords(markdown) > opts.maxWords) {
		truncated = true;
		markdown = truncateWords(markdown, opts.maxWords);
	}
	const auditMarkdown = renderAuditMarkdown(control, auditPacket, rendered);
	const serializationArtifact =
		hasObjectSerializationArtifact(markdown) ||
		hasObjectSerializationArtifact(auditMarkdown);
	const wordCount = countWords(markdown);
	const sourceUrlCount = rendered.sourceIndex.length;
	const substantiveRenderWarnings = rendered.renderWarnings.filter(
		(warning) => warning.section !== "sourceUrls",
	);
	const renderedAllStructuredItems = substantiveRenderWarnings.length === 0;
	const truncatedWithOpenGaps =
		truncated && Number(rendered.sectionCounts.caveatsAndGaps ?? 0) > 0;
	const passed =
		renderedAllStructuredItems &&
		!truncatedWithOpenGaps &&
		!serializationArtifact;

	let executiveSidecarPath;
	let reportSidecarPath;
	let auditSidecarPath;
	try {
		if (context.cwd && context.runId && context.taskId) {
			const taskDir = join(
				context.cwd,
				".pi",
				"workflows",
				context.runId,
				"tasks",
				context.taskId,
			);
			await mkdir(taskDir, { recursive: true });
			executiveSidecarPath = join(taskDir, "executive.md");
			reportSidecarPath = join(taskDir, "report.md");
			auditSidecarPath = join(taskDir, "audit.md");
			await writeFile(executiveSidecarPath, `${markdown}\n`, "utf8");
			await writeFile(reportSidecarPath, `${markdown}\n`, "utf8");
			await writeFile(auditSidecarPath, `${auditMarkdown}\n`, "utf8");
		}
	} catch {
		// Sidecars are non-authoritative; keep control output deterministic.
	}

	return {
		schema: "deep-research-executive-render-v1",
		digest: truncateWords(stripLeadingHeading(markdown), 45),
		status: passed ? "passed" : "failed",
		renderMode: "evidence-backed-report",
		executiveMarkdown: markdown,
		reportMarkdown: markdown,
		auditMarkdown,
		wordCount,
		sourceUrlCount,
		totalSourceUrlCount: rendered.allSourceIndex.length,
		sourceUrls: rendered.sourceIndex,
		sourceIndex: rendered.sourceIndex.map((url) => ({
			url,
			host: hostOf(url),
		})),
		claimSummary: rendered.claimSummary,
		factSlotSummary: rendered.factSlotSummary,
		sectionCounts: rendered.sectionCounts,
		renderWarnings: rendered.renderWarnings,
		gates: {
			renderedAllStructuredItems,
			maxWords: Number.isFinite(opts.maxWords) ? opts.maxWords : null,
			maxUrls: Number.isFinite(opts.maxUrls) ? opts.maxUrls : null,
			maxFindings: opts.maxFindings,
			maxRecommendations: opts.maxRecommendations,
			maxGaps: opts.maxGaps,
			truncated,
			truncatedWithOpenGaps,
			serializationArtifact,
			passed,
		},
		auditArtifact: auditSidecarPath ? "audit.md" : "final-audit.control.json",
		...(executiveSidecarPath ? { sidecarPath: "executive.md" } : {}),
		...(reportSidecarPath ? { reportSidecarPath: "report.md" } : {}),
		...(auditSidecarPath ? { auditSidecarPath: "audit.md" } : {}),
	};
}
