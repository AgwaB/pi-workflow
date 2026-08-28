// Deterministic evidence-backed renderer for deep-research.
//
// Input: final-audit.control.json from the full deep-research final stage.
// Output: a parent-facing research report in executiveMarkdown plus sidecars.
//
// This intentionally treats final-audit.control.json as the source of truth and
// renders a bounded view. It does not re-verify or invent evidence.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalVerificationStatus } from "./verification-ontology.mjs";

function findSource(sources, stageId) {
	const matches = Object.entries(sources ?? {}).filter(
		([specId]) => specId === stageId || specId.startsWith(`${stageId}.`),
	);
	if (matches.length > 1) {
		throw new Error(
			`deep-research: ambiguous ${stageId} source (${matches.map(([specId]) => specId).join(", ")})`,
		);
	}
	return matches[0]?.[1] ?? null;
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

function completionText(value) {
	return cleanText(value)
		.replace(/(?:^|[\\/])\.pi[\\/]workflows(?:[\\/][^\s]*)?/gi, " [artifact omitted]")
		.replace(/\b(?:final-report|executive|audit|review)\.md\b/gi, "[artifact omitted]")
		.replace(/\b(?:refs|control)\.json\b/gi, "[artifact omitted]")
		.replace(/\brelated[\s-]+artifacts\b/gi, "[section title omitted]")
		.replace(/\bworkflow[_-][\w.-]+\b/gi, "[run omitted]")
		.replace(/\btask[_-][\w.-]+\b/gi, "[task omitted]")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/([\\`*_[\]{}#+|])/g, "\\$1");
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
	const canonical = canonicalVerificationStatus(text);
	if (canonical !== "unverified") return canonical;
	if (
		text === "unverified" ||
		text.includes("not verified") ||
		text.includes("not_verified")
	)
		return "unverified";
	if (
		text.includes("verification_blocked") ||
		text.includes("verification blocked")
	)
		return "verification_blocked";
	if (text.includes("conflict")) return "conflicting";
	if (text.includes("unsupported")) return "unsupported";
	if (text.includes("partial")) return "partially_supported";
	if (/\bverified\b/.test(text)) return "verified";
	return canonical;
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
		verification_blocked:
			finiteNumber(coverage.verificationBlocked) ??
			finiteNumber(coverage.verification_blocked) ??
			fallback.verification_blocked,
	};
	if (counts.total == null) {
		counts.total =
			counts.verified +
			counts.partially_supported +
			counts.unsupported +
			counts.conflicting +
			counts.verification_blocked;
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
			counts.conflicting +
			counts.verification_blocked;
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
		verification_blocked: 0,
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
		"verification_blocked",
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

function hasOwn(record, key) {
	return isRecord(record) && Object.prototype.hasOwnProperty.call(record, key);
}

function exactKeys(record, allowed) {
	return (
		isRecord(record) &&
		Object.keys(record).every((key) => allowed.includes(key))
	);
}

function boundedString(value, minLength, maxLength) {
	return (
		typeof value === "string" &&
		value.length >= minLength &&
		value.length <= maxLength
	);
}

function boundedArray(value, maxItems, itemCheck) {
	return (
		Array.isArray(value) &&
		value.length <= maxItems &&
		value.every(itemCheck)
	);
}

function boundedStringArray(value, maxItems) {
	return boundedArray(value, maxItems, (item) => typeof item === "string");
}

function modernRecommendationValid(item) {
	return Boolean(
		isRecord(item) &&
		boundedString(item.recommendation, 1, 1200) &&
		boundedStringArray(item.supportingClaimIds, 8) &&
		(!hasOwn(item, "evidenceStatus") || typeof item.evidenceStatus === "string") &&
		(!hasOwn(item, "rationale") || boundedString(item.rationale, 0, 1200)),
	);
}

function modernActionValid(item) {
	return Boolean(
		isRecord(item) &&
		boundedString(item.action, 1, 1200) &&
		boundedStringArray(item.supportingClaimIds, 8) &&
		(!hasOwn(item, "evidenceStatus") || typeof item.evidenceStatus === "string"),
	);
}

function modernCaveatValid(item) {
	return Boolean(
		isRecord(item) &&
		boundedString(item.note, 1, 1200) &&
		(!hasOwn(item, "relatedClaimIds") ||
			boundedStringArray(item.relatedClaimIds, 8)) &&
		(!hasOwn(item, "gapIds") || boundedStringArray(item.gapIds, 8)),
	);
}

function modernDecisionValid(item) {
	return Boolean(
		isRecord(item) &&
		boundedString(item.note, 1, 1200) &&
		boundedString(item.whyItMatters, 1, 1200) &&
		typeof item.evidenceStatus === "string" &&
		boundedString(item.suggestedParentDecision, 0, 1200) &&
		(!hasOwn(item, "supportingClaimIds") ||
			boundedStringArray(item.supportingClaimIds, 8)),
	);
}

function validModernFinalAudit(control) {
	const synthesis = control?.synthesis;
	const synthesisKeys = [
		"bottomLine",
		"keyFindingIds",
		"recommendations",
		"actionPlan",
		"caveatNotes",
		"parentDecisionNotes",
		"notableUnsupportedClaimIds",
		"contestedClaimIds",
	];
	return Boolean(
		exactKeys(control, ["schema", "digest", "synthesis"]) &&
		control.schema === "deep-research-final-synthesis-v1" &&
		boundedString(control.digest, 1, 1200) &&
		exactKeys(synthesis, synthesisKeys) &&
		boundedString(synthesis.bottomLine, 1, 4000) &&
		boundedStringArray(synthesis.keyFindingIds, 12) &&
		boundedArray(synthesis.recommendations, 12, modernRecommendationValid) &&
		boundedArray(synthesis.actionPlan, 12, modernActionValid) &&
		boundedArray(synthesis.caveatNotes, 16, modernCaveatValid) &&
		boundedArray(synthesis.parentDecisionNotes, 12, modernDecisionValid) &&
		(!hasOwn(synthesis, "notableUnsupportedClaimIds") ||
			boundedStringArray(synthesis.notableUnsupportedClaimIds, 12)) &&
		(!hasOwn(synthesis, "contestedClaimIds") ||
			boundedStringArray(synthesis.contestedClaimIds, 12)),
	);
}

function validLegacyFinalAudit(control) {
	const report = control?.finalReport;
	return Boolean(
		isRecord(control) &&
		boundedString(control.schema, 1, Infinity) &&
		boundedString(control.digest, 1, Infinity) &&
		isRecord(report) &&
		[
			"researchMetadata",
			"coverageSummary",
			"recommendations",
			"actionPlan",
			"remainingGaps",
		].every((field) => hasOwn(report, field)) &&
		boundedArray(report.factSlotCoverage, 64, isRecord) &&
		boundedArray(report.mainFindings, 12, isRecord) &&
		boundedArray(report.parentDecisionNotes, 12, isRecord) &&
		boundedArray(report.unverifiedButRelevant, 16, isRecord) &&
		isRecord(control.claimVerdictIndex) &&
		boundedArray(control.claimVerdictIndex.claims, 64, isRecord),
	);
}

function validFinalAuditPacket(packetSource) {
	const packet = packetSource?.packet;
	const synthesisInput = packet?.synthesisInput;
	return Boolean(
		exactKeys(packetSource, ["schema", "digest", "packet"]) &&
		packetSource.schema === "deep-research-final-audit-packet-v1" &&
		boundedString(packetSource.digest, 1, 1200) &&
		isRecord(packet) &&
		[
			"researchMetadataSeed",
			"verdictCounts",
			"statusPartitions",
			"factSlotStatusCounts",
			"verifierIntegrity",
			"normalizerDiagnostics",
			"invariantChecks",
			"overflowLedger",
		].every((field) => isRecord(packet[field])) &&
		[
			"factSlotCoverage",
			"coverageGaps",
			"remainingGaps",
			"sourceRefJoinFailures",
			"claimVerdictLedger",
			"preservedClaims",
			"researchScopeCoverage",
		].every((field) =>
			boundedArray(packet[field], Infinity, isRecord),
		) &&
		isRecord(synthesisInput) &&
		[
			"researchMetadata",
			"verdictCounts",
			"factSlotStatusCounts",
			"integritySummary",
		].every((field) => isRecord(synthesisInput[field])) &&
		[
			"researchScopeCoverage",
			"factSlots",
			"claims",
			"preservedClaims",
			"gaps",
		].every((field) =>
			boundedArray(synthesisInput[field], Infinity, isRecord),
		),
	);
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

function duplicateIds(rows, idFn) {
	const counts = new Map();
	for (const row of rows) {
		const id = idFn(row);
		if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
	}
	return [...counts.entries()]
		.filter(([, count]) => count > 1)
		.map(([id]) => id);
}

function packetDuplicateIds(packet, control) {
	const ledger = claimLedger(packet, control);
	const gaps = packetGapRows(packet);
	return {
		claimIds: duplicateIds(ledger, claimIdOf),
		gapIds: duplicateIds(gaps, gapIdOf),
	};
}

function duplicateIdRenderResult(duplicates) {
	const blockers = [];
	if (duplicates.claimIds.length > 0)
		blockers.push(`duplicate claim IDs: ${duplicates.claimIds.join(", ")}`);
	if (duplicates.gapIds.length > 0)
		blockers.push(`duplicate gap IDs: ${duplicates.gapIds.join(", ")}`);
	return {
		schema: "deep-research-executive-render-v1",
		digest: `Research report rendering blocked: ${blockers.join("; ")}`,
		status: "failed",
		blockers,
		completionSummaryMarkdown: "",
		executiveMarkdown: "",
		reportMarkdown: "",
		auditMarkdown: "",
		wordCount: 0,
		sourceUrlCount: 0,
		totalSourceUrlCount: 0,
		sourceUrls: [],
		sourceIndex: [],
		claimSummary: { total: 0, verified: 0, partially_supported: 0, unsupported: 0, conflicting: 0, verification_blocked: 0 },
		factSlotSummary: { total: 0, filled: 0, partial: 0, missingOrConflicting: 0 },
		sectionCounts: {},
		renderWarnings: [],
		duplicateClaimIds: duplicates.claimIds,
		duplicateGapIds: duplicates.gapIds,
		gates: {
			renderedAllStructuredItems: false,
			duplicateClaimIds: duplicates.claimIds,
			duplicateGapIds: duplicates.gapIds,
			passed: false,
		},
		auditArtifact: "final-audit.control.json",
	};
}

function sameIdMultiset(left, right) {
	if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length)
		return false;
	const counts = new Map();
	for (const id of left) counts.set(id, (counts.get(id) ?? 0) + 1);
	for (const id of right) {
		const count = counts.get(id) ?? 0;
		if (count === 0) return false;
		if (count === 1) counts.delete(id);
		else counts.set(id, count - 1);
	}
	return counts.size === 0;
}

function packetStatusKey(status) {
	const normalized = normalizeClaimStatus(status);
	return normalized || "unverified";
}

function packetCountMap(rows) {
	const counts = {
		verified: 0,
		partially_supported: 0,
		unsupported: 0,
		conflicting: 0,
		verification_blocked: 0,
		unverified: 0,
	};
	for (const row of rows) {
		const status = packetStatusKey(row?.status ?? row?.verdict);
		if (Object.hasOwn(counts, status)) counts[status] += 1;
	}
	return counts;
}

function packetStatusIds(packet) {
	const partitions = packet?.statusPartitions;
	if (!isRecord(partitions)) return null;
	const result = {};
	for (const [key, value] of Object.entries(partitions)) {
		const status = packetStatusKey(key);
		if (!Array.isArray(value)) return { invalid: true };
		result[status] = [...(result[status] ?? []), ...value.filter((id) => typeof id === "string" && id.trim())];
	}
	return result;
}

function numberMatches(actual, expected) {
	return Number.isSafeInteger(Number(actual)) && Number(actual) >= 0 && Number(actual) === Number(expected);
}

function ownerKey(owner) {
	if (!isRecord(owner)) return "";
	return [
		owner.source,
		owner.stageId,
		owner.specId,
		owner.taskId,
		owner.itemIdentity,
		owner.placeholderSpecId,
		owner.batchId ?? "",
		owner.status,
	].map((value) => String(value ?? "")).join("\u001f");
}

function exactOwnerShape(owner) {
	return isRecord(owner) &&
		["source", "stageId", "specId", "taskId", "itemIdentity", "placeholderSpecId", "status"]
			.every((field) => typeof owner[field] === "string" && owner[field].trim()) &&
		owner.status === "completed" &&
		(typeof owner.batchId === "undefined" || (typeof owner.batchId === "string" && owner.batchId.trim())) &&
		owner.specId === `${owner.stageId}.${owner.batchId ?? owner.itemIdentity}` &&
		owner.placeholderSpecId === `${owner.stageId}.item` &&
		(owner.batchId === undefined || owner.itemIdentity === owner.batchId);
}

function reconcileVerifierOwners(packet, ledger) {
	const owners = asArray(packet?.verifierIntegrity?.verifierOwnerLedger);
	const blockers = [];
	const ownerByKey = new Map();
	for (const owner of owners) {
		const key = ownerKey(owner);
		if (!exactOwnerShape(owner)) blockers.push("verifier owner ledger contains an incomplete or non-completed owner");
		if (!key) continue;
		if (ownerByKey.has(key)) blockers.push("verifier owner ledger contains duplicate owners");
		ownerByKey.set(key, owner);
	}
	const claimOwners = [];
	for (const claim of ledger) {
		if (!isRecord(claim?.verifierOwner)) {
			blockers.push(`claim owner is missing: ${claimIdOf(claim) || "unknown"}`);
			continue;
		}
		const key = ownerKey(claim.verifierOwner);
		claimOwners.push(key);
		if (!ownerByKey.has(key)) blockers.push(`claim owner is absent from owner ledger: ${claimIdOf(claim) || "unknown"}`);
	}
	for (const key of ownerByKey.keys()) {
		if (!claimOwners.includes(key)) blockers.push("verifier owner ledger contains an orphan owner");
	}
	if (ledger.length > 0 && owners.length === 0) blockers.push("verifier owner ledger is missing");
	return {
		passed: blockers.length === 0,
		blockers,
		checks: { ownerRowCount: owners.length, claimOwnerRowCount: claimOwners.length },
	};
}

// A packet emitted by final-audit-packet has all of these ledgers. Older
// final-audit fixtures intentionally provide only a legacy report/claim index;
// retain their rendering behavior while making the real packet contract strict.
function packetHasCompleteContract(packet) {
	return isRecord(packet) &&
		Array.isArray(packet.claimVerdictLedger) &&
		isRecord(packet.verdictCounts) &&
		isRecord(packet.statusPartitions) &&
		Array.isArray(packet.factSlotCoverage) &&
		isRecord(packet.factSlotStatusCounts) &&
		isRecord(packet.verifierIntegrity) &&
		Array.isArray(packet.verifierIntegrity.verifierOwnerLedger) &&
		Array.isArray(packet.verifierIntegrity.verifierOwnerIssues) &&
		Array.isArray(packet.verifierIntegrity.invalidNormalizedCandidateRows) &&
		isRecord(packet.invariantChecks) &&
		Array.isArray(packet.invariantChecks.candidateIds) &&
		Array.isArray(packet.invariantChecks.auditedClaimIds) &&
		isRecord(packet.overflowLedger) &&
		isRecord(packet.synthesisInput?.integritySummary);
}

function reconcileFinalPacket(packet, control) {
	if (!packetHasCompleteContract(packet)) {
		return { strict: false, passed: true, blockers: [], checks: {} };
	}
	const blockers = [];
	const ledger = packet.claimVerdictLedger;
	const ledgerIds = ledger.map(claimIdOf);
	const ownerReconciliation = reconcileVerifierOwners(packet, ledger);
	if (!ownerReconciliation.passed) blockers.push(...ownerReconciliation.blockers);
	const ledgerIdSet = new Set(ledgerIds.filter(Boolean));
	if (ledgerIds.some((id) => !id) || ledgerIdSet.size !== ledgerIds.length)
		blockers.push("packet claim ledger has missing or duplicate IDs");
	const counts = packetCountMap(ledger);
	const packetCounts = packetVerdictCounts(packet, counts) ?? {};
	for (const key of ["verified", "partially_supported", "unsupported", "conflicting", "verification_blocked"]) {
		const packetKey = key === "partially_supported" ? "partiallySupported" : key === "verification_blocked" ? "verificationBlocked" : key;
		if (!numberMatches(packetCounts[key], counts[key])) blockers.push(`packet count mismatch: ${key}`);
	}
	const invariant = packet.invariantChecks;
	const auditedCount = Number(invariant.auditedClaimCount);
	const candidateCount = Number(invariant.candidateCount);
	const omitted = asArray(invariant.omittedCandidateIds).filter((id) => typeof id === "string" && id.trim());
	if (!numberMatches(auditedCount, ledger.length)) blockers.push("audited claim count does not match claim ledger");
	if (!Number.isSafeInteger(candidateCount) || candidateCount < ledger.length || candidateCount !== ledger.length + omitted.length)
		blockers.push("candidate/audited/omitted counts do not reconcile");
	if (Array.isArray(invariant.auditedClaimIds) && !sameIdMultiset(invariant.auditedClaimIds, ledgerIds)) blockers.push("audited claim IDs do not match claim ledger");
	if (Array.isArray(invariant.candidateIds)) {
		if (new Set(invariant.candidateIds).size !== invariant.candidateIds.length) blockers.push("candidate IDs are duplicated");
		if (invariant.candidateIds.length !== candidateCount) blockers.push("candidate ID count does not match candidate count");
		const candidateSet = new Set(invariant.candidateIds);
		if (ledgerIds.some((id) => !candidateSet.has(id))) blockers.push("audited claim is absent from candidate ledger");
	}
	const statusTotal = Object.values(counts).reduce((total, count) => total + count, 0);
	if (statusTotal !== ledger.length) blockers.push("claim status counts do not sum to the claim ledger");
	const partitions = packetStatusIds(packet);
	if (!partitions || partitions.invalid) blockers.push("packet status partitions are malformed");
	else {
		if (isRecord(invariant.statusPartitionIds)) {
			const invariantPartitions = packetStatusIds({ statusPartitions: invariant.statusPartitionIds });
			const partitionKeys = new Set(Object.keys(partitions));
			const invariantKeys = new Set(Object.keys(invariantPartitions ?? {}));
			const sameKeys = partitionKeys.size === invariantKeys.size && [...partitionKeys].every((key) => invariantKeys.has(key));
			if (!invariantPartitions || invariantPartitions.invalid || !sameKeys || [...partitionKeys].some((key) => !sameIdMultiset(invariantPartitions[key], partitions[key]))) blockers.push("invariant status partitions do not match packet partitions");
		}
		const partitionIds = Object.values(partitions).flat();
		if (!sameIdMultiset(partitionIds, ledgerIds)) blockers.push("status partitions do not cover the claim ledger");
		for (const [status, ids] of Object.entries(partitions)) {
			const expected = ledger.filter((claim) => packetStatusKey(claim?.status ?? claim?.verdict) === status).map(claimIdOf);
			if (!sameIdMultiset(ids, expected)) blockers.push(`status partition mismatch: ${status}`);
		}
	}
	const slots = packet.factSlotCoverage;
	const slotIds = slots.map((slot) => cleanText(slot?.slotId ?? slot?.id));
	if (slotIds.some((id) => !id) || new Set(slotIds).size !== slotIds.length) blockers.push("fact-slot ledger has missing or duplicate IDs");
	const slotCounts = {};
	for (const slot of slots) {
		const status = cleanText(slot?.status ?? "unknown") || "unknown";
		slotCounts[status] = (slotCounts[status] ?? 0) + 1;
	}
	for (const [status, count] of Object.entries(slotCounts)) {
		if (Number(packet.factSlotStatusCounts[status] ?? 0) !== count) blockers.push(`fact-slot count mismatch: ${status}`);
	}
	for (const [status, count] of Object.entries(packet.factSlotStatusCounts)) {
		if (Number(count) !== Number(slotCounts[status] ?? 0)) blockers.push(`fact-slot count has extra status: ${status}`);
	}
	const candidateSet = new Set(Array.isArray(invariant.candidateIds) ? invariant.candidateIds : []);
	const slotById = new Map(slots.map((slot) => [cleanText(slot?.slotId ?? slot?.id), slot]));
	for (const slot of slots) {
		for (const candidateId of asArray(slot?.verificationCandidateIds)) {
			if (candidateSet.size > 0 && !candidateSet.has(candidateId)) blockers.push(`fact-slot references unknown candidate: ${candidateId}`);
		}
	}
	for (const claim of ledger) {
		for (const slotId of asArray(claim?.factSlotIds)) {
			const slot = slotById.get(cleanText(slotId));
			if (!slot) blockers.push(`claim references unknown fact slot: ${slotId}`);
			else if (Array.isArray(slot.verificationCandidateIds) && slot.verificationCandidateIds.length > 0 && !slot.verificationCandidateIds.includes(claimIdOf(claim))) blockers.push(`fact-slot candidate mapping omits audited claim: ${claimIdOf(claim)}`);
		}
	}
	const integrity = packet.verifierIntegrity;
	const invalidNormalizedRows = asArray(integrity.invalidNormalizedCandidateRows);
	if (!numberMatches(integrity.invalidNormalizedCandidateCount, invalidNormalizedRows.length)) blockers.push("invalid normalized candidate count does not match rows");
	if (!numberMatches(integrity.gateSummary?.invalidNormalizedCandidates, invalidNormalizedRows.length)) blockers.push("gate invalid normalized candidate count does not match rows");
	if (invalidNormalizedRows.length > 0) blockers.push("invalid normalized candidate rows are present");
	if (!numberMatches(invariant.verifierIntegrity?.invalidNormalizedCandidateCount, invalidNormalizedRows.length)) blockers.push("invariant invalid normalized candidate count does not match rows");
	const overflow = packet.overflowLedger;
	const overflowChecks = [
		["preservedClaimCount", asArray(packet.preservedClaims).length],
		["coverageGapCount", asArray(packet.coverageGaps).length],
		["remainingGapCount", asArray(packet.remainingGaps).length],
		["omittedVerificationCandidateCount", omitted.length],
		["invalidVerifierRowCount", asArray(packet.verifierIntegrity.invalidVerifierRows).length],
		["duplicateVerifierRowCount", asArray(packet.verifierIntegrity.duplicateVerifierRows).length],
		["verifierOwnerIssueCount", asArray(packet.verifierIntegrity.verifierOwnerIssues).length],
		["invalidNormalizedCandidateCount", invalidNormalizedRows.length],
	];
	for (const [field, expected] of overflowChecks) if (!numberMatches(overflow[field], expected)) blockers.push(`overflow mismatch: ${field}`);
	const invIntegrity = isRecord(invariant.verifierIntegrity) ? invariant.verifierIntegrity : {};
	for (const field of ["invalidVerifierRows", "duplicateVerifierRows", "verifierOwnerIssues", "missingVerifierResults", "zeroCandidateFloorBlockers"]) {
		const expected = field === "invalidVerifierRows" ? asArray(integrity.invalidVerifierRows).length : field === "duplicateVerifierRows" ? asArray(integrity.duplicateVerifierRows).length : field === "verifierOwnerIssues" ? asArray(integrity.verifierOwnerIssues).length : Number(integrity.gateSummary?.[field] ?? 0);
		if (!numberMatches(invIntegrity[field], expected)) blockers.push(`verifier integrity mismatch: ${field}`);
	}
	const synthesisClaims = asArray(packet.synthesisInput?.claims);
	if (synthesisClaims.length > 0 && !sameIdMultiset(synthesisClaims.map(claimIdOf), ledgerIds)) blockers.push("synthesis claim ledger does not match packet claim ledger");
	const synthesisCounts = packet.synthesisInput?.verdictCounts;
	if (isRecord(synthesisCounts)) {
		for (const [key, value] of Object.entries(packetCounts)) {
			const synthesisKey = key === "partially_supported" ? "partiallySupported" : key === "verification_blocked" ? "verificationBlocked" : key;
			if (synthesisCounts[synthesisKey] !== undefined && Number(synthesisCounts[synthesisKey]) !== Number(value)) blockers.push(`synthesis count mismatch: ${key}`);
		}
	}
	const synthesisIntegrity = packet.synthesisInput?.integritySummary;
	if (isRecord(synthesisIntegrity)) {
		const packetJoinFailures = Number(integrity.gateSummary?.sourceRefJoinFailures ?? asArray(packet.sourceRefJoinFailures).length);
		if (synthesisIntegrity.sourceRefJoinFailures !== undefined && Number(synthesisIntegrity.sourceRefJoinFailures) !== packetJoinFailures) blockers.push("synthesis integrity source-ref count mismatch");
		if (synthesisIntegrity.invalidVerifierRows !== undefined && Number(synthesisIntegrity.invalidVerifierRows) !== asArray(integrity.invalidVerifierRows).length) blockers.push("synthesis integrity verifier-row count mismatch");
		if (synthesisIntegrity.invalidNormalizedCandidateCount !== undefined && Number(synthesisIntegrity.invalidNormalizedCandidateCount) !== invalidNormalizedRows.length) blockers.push("synthesis integrity invalid normalized candidate count mismatch");
		const synthesisInvalidRows = asArray(synthesisIntegrity.invalidNormalizedCandidateRows);
		if (synthesisInvalidRows.length !== invalidNormalizedRows.length || JSON.stringify(synthesisInvalidRows) !== JSON.stringify(invalidNormalizedRows)) blockers.push("synthesis integrity invalid normalized candidate rows mismatch");
	}
	const finalClaims = asArray(control?.claimVerdictIndex?.claims);
	for (const row of finalClaims) {
		const id = claimIdOf(row);
		const packetRow = ledger.find((claim) => claimIdOf(claim) === id);
		if (!packetRow || packetStatusKey(row?.status ?? row?.verdict) !== packetStatusKey(packetRow?.status ?? packetRow?.verdict)) blockers.push(`final claim ledger mismatch: ${id || "missing id"}`);
	}
	return {
		strict: true,
		passed: blockers.length === 0,
		blockers,
		checks: {
			candidateCount,
			auditedCount,
			omittedCount: omitted.length,
			ledgerCount: ledger.length,
			ownerReconciliation,
			invalidNormalizedCandidateCount: invalidNormalizedRows.length,
		},
	};
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
	const sourceRefJoinFailures = asArray(packet?.sourceRefJoinFailures).map(
		(gap, index) => ({
			id: gapIdOf(gap) || numberedId("gap-source-ref", index),
			kind: "Source reference gap",
			...gap,
		}),
	);
	return [...remaining, ...coverage, ...sourceRefJoinFailures];
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
		case "verification_blocked":
		case "unverified":
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
		verification_blocked: 0,
	});
	if (!counts) return fallback;
	return {
		...fallback,
		verified: counts.verified,
		partiallySupported: counts.partially_supported,
		unsupported: counts.unsupported,
		conflicting: counts.conflicting,
		verificationBlocked: counts.verification_blocked,
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

function renderCompletionSummary(report, claimSummary, slots, fallback) {
	const recommendations = recommendationEntries(report);
	const primaryEntries = (
		recommendations.length > 0 ? recommendations : mainFindingEntries(report)
	).slice(0, 8);
	const categoryOrder = [
		"Decision note",
		"Gap",
		"Caveat",
		"Contested",
		"Unsupported",
		"Unverified lead",
	];
	const categoryRank = new Map(
		categoryOrder.map((category, index) => [category, index]),
	);
	const limitations = caveatCategories(report)
		.flatMap((category) =>
			category.entries.map((entry) => ({ kind: category.kind, ...entry })),
		)
		.sort(
			(left, right) =>
				(categoryRank.get(left.kind) ?? categoryOrder.length) -
				(categoryRank.get(right.kind) ?? categoryOrder.length),
		)
		.slice(0, 6);
	const out = [
		"## Core conclusion",
		"",
		completionText(summaryText(report, fallback)),
		"",
	];
	if (primaryEntries.length > 0) {
		out.push("## Main recommendations", "");
		for (const { item, text } of primaryEntries) {
			const status = evidenceStatusOf(item) || "not specified";
			out.push(
				`- ${completionText(text)} — evidence: ${completionText(status)}`,
			);
		}
		out.push("");
	}
	out.push(
		"## Evidence level",
		"",
		`- Claims: ${claimSummary.verified} verified, ${claimSummary.partially_supported} partially supported, ${claimSummary.unsupported} unsupported, ${claimSummary.conflicting} conflicting, ${claimSummary.verification_blocked} verification blocked.`,
		`- Fact slots: ${slots.filled} filled, ${slots.partial} partial, ${slots.missingOrConflicting} missing/conflicting, ${slots.total} total.`,
		"",
	);
	if (limitations.length > 0) {
		out.push("## Remaining decisions and limits", "");
		for (const { kind, text } of limitations) {
			out.push(`- **${completionText(kind)}:** ${completionText(text)}`);
		}
		out.push("");
	}
	return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function renderResearchScopeAndMethod(report) {
	const metadata = isRecord(report?.researchMetadata)
		? report.researchMetadata
		: {};
	const scopeCoverage = asArray(report?.researchScopeCoverage);
	const scopeCounts = new Map();
	for (const row of scopeCoverage) {
		const status = cleanText(row?.status ?? "unknown") || "unknown";
		scopeCounts.set(status, (scopeCounts.get(status) ?? 0) + 1);
	}
	const rows = [];
	if (cleanText(metadata.taskType))
		rows.push(`- Task type: ${cleanText(metadata.taskType)}.`);
	if (cleanText(metadata.depth))
		rows.push(`- Research depth: ${cleanText(metadata.depth)}.`);
	if (Number.isFinite(Number(metadata.researchQuestions)))
		rows.push(`- Research questions: ${Number(metadata.researchQuestions)}.`);
	if (Number.isFinite(Number(metadata.plannedFactSlots)))
		rows.push(`- Planned fact slots: ${Number(metadata.plannedFactSlots)}.`);
	if (cleanText(metadata.expectedFinalShape))
		rows.push(
			`- Expected output shape: ${cleanText(metadata.expectedFinalShape)}.`,
		);
	if (scopeCoverage.length > 0) {
		rows.push(
			`- Scope coverage: ${[...scopeCounts.entries()]
				.map(([status, count]) => `${status} ${count}`)
				.join(", ")}.`,
		);
	}
	rows.push(
		"- Method: plan research questions, collect source evidence, normalize claims, verify selected claims, apply deterministic audit gates, and synthesize the report.",
	);
	return ["## Research scope and method", "", ...rows, ""];
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
		`- Claims: ${claimSummary.verified} verified, ${claimSummary.partially_supported} partially supported, ${claimSummary.unsupported} unsupported, ${claimSummary.conflicting} conflicting, ${claimSummary.verification_blocked} verification blocked.`,
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
		"",
	];
}

function renderRelatedArtifacts() {
	return [
		"## Related artifacts",
		"",
		"- [Evidence audit](audit.md) — claim verdicts, fact-slot coverage, gaps, and renderer diagnostics.",
		"- [Structured source references](refs.json) — machine-readable source pointers used by the final task.",
		"- [Machine-readable report](control.json) — the structured final report and completion-summary contract.",
		"",
	];
}

function renderWarnings(sectionCounts) {
	const checks = [
		["caveatsAndGaps", "renderedCaveatsAndGaps", "caveats/gaps"],
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
	const completionSummaryMarkdown = renderCompletionSummary(
		report,
		claimSummary,
		slots,
		control.digest,
	);
	const reportExecutiveSummary = completionSummaryMarkdown.replace(
		/^## /gm,
		"### ",
	);

	const sections = [
		"# Research report",
		"",
		"## Executive summary",
		"",
		reportExecutiveSummary,
		"",
		...renderResearchScopeAndMethod(report),
		...renderMainFindings(report),
		...renderRecommendations(report),
		...renderActionPlan(report),
		...renderEvidenceStrength(report),
		...renderCaveats(report),
		...renderSourceIndex(sourceIndex),
		...renderAuditSummary(report, claimSummary, slots),
		...renderRelatedArtifacts(),
	];

	const markdown = sections
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return {
		markdown,
		completionSummaryMarkdown,
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
		"This artifact preserves the detailed claim/gap/source ledger behind `final-report.md`.",
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

function blockedSourceResult(reason) {
	return {
		schema: "deep-research-executive-render-v1",
		digest: `Research report rendering blocked: ${reason}`,
		status: "blocked",
		blockers: [reason],
		completionSummaryMarkdown: "",
		executiveMarkdown: "",
		reportMarkdown: "",
		auditMarkdown: "",
		wordCount: 0,
		sourceUrlCount: 0,
		totalSourceUrlCount: 0,
		sourceUrls: [],
		sourceIndex: [],
		claimSummary: { total: 0, verified: 0, partially_supported: 0, unsupported: 0, conflicting: 0, verification_blocked: 0 },
		factSlotSummary: { total: 0, filled: 0, partial: 0, missingOrConflicting: 0 },
		sectionCounts: {},
		renderWarnings: [],
		gates: { renderedAllStructuredItems: false, passed: false },
		auditArtifact: "final-audit.control.json",
	};
}

export default async function renderExecutive({
	sources,
	options = {},
	context = {},
}) {
	let control;
	let auditPacket;
	try {
		control = findSource(sources, "final-audit");
		auditPacket = findSource(sources, "final-audit-packet");
	} catch (error) {
		return blockedSourceResult(error instanceof Error ? error.message : String(error));
	}
	const modernControl = validModernFinalAudit(control);
	const legacyControl = validLegacyFinalAudit(control);
	let controlBlocker = "";
	if (!control || typeof control !== "object")
		controlBlocker = "missing final-audit control source";
	else if (!modernControl && !legacyControl)
		controlBlocker = "malformed final-audit control source";
	else if (modernControl && !auditPacket)
		controlBlocker = "missing final-audit-packet control source";
	else if (modernControl && !validFinalAuditPacket(auditPacket))
		controlBlocker = "malformed final-audit-packet control source";
	if (controlBlocker) {
		return {
			schema: "deep-research-executive-render-v1",
			digest: `Research report rendering failed: ${controlBlocker}.`,
			status: "blocked",
			blockers: [controlBlocker],
			completionSummaryMarkdown: "",
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
				verification_blocked: 0,
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

	const packet = packetOf(auditPacket);
	const duplicates = packetDuplicateIds(packet, control);
	if (duplicates.claimIds.length > 0 || duplicates.gapIds.length > 0)
		return duplicateIdRenderResult(duplicates);
	const packetReconciliation = reconcileFinalPacket(packet, control);

	const opts = {
		maxWords: Number.isFinite(Number(options.maxWords))
			? Math.max(0, Number(options.maxWords))
			: Infinity,
		maxUrls: Number.isFinite(Number(options.maxUrls))
			? Math.max(0, Number(options.maxUrls))
			: Infinity,
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
		!serializationArtifact &&
		packetReconciliation.passed;

	let finalReportSidecarPath;
	let legacyExecutiveSidecarPath;
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
			finalReportSidecarPath = join(taskDir, "final-report.md");
			legacyExecutiveSidecarPath = join(taskDir, "executive.md");
			auditSidecarPath = join(taskDir, "audit.md");
			await writeFile(finalReportSidecarPath, `${markdown}\n`, "utf8");
			await writeFile(legacyExecutiveSidecarPath, `${markdown}\n`, "utf8");
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
		completionSummaryMarkdown: passed
			? rendered.completionSummaryMarkdown
			: "",
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
		packetReconciliation,
		gates: {
			renderedAllStructuredItems,
			maxWords: Number.isFinite(opts.maxWords) ? opts.maxWords : null,
			maxUrls: Number.isFinite(opts.maxUrls) ? opts.maxUrls : null,
			truncated,
			truncatedWithOpenGaps,
			serializationArtifact,
			packetReconciliationPassed: packetReconciliation.passed,
			packetReconciliationBlockers: packetReconciliation.blockers,
			passed,
		},
		auditArtifact: auditSidecarPath ? "audit.md" : "final-audit.control.json",
		...(finalReportSidecarPath ? { sidecarPath: "final-report.md" } : {}),
		...(auditSidecarPath ? { auditSidecarPath: "audit.md" } : {}),
	};
}
