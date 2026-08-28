// Deterministic evidence-backed renderer for deep-review.
//
// Finding cards are rendered from partition-verdicts.control.json, the
// deterministic post-processing ledger. The model-authored report stage is used
// only for narrative summary/verdict/risk fields.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info", "unknown"];
const REPORT_VERDICTS = new Set([
	"REVIEW_COMPLETE",
	"NEEDS_WORK",
	"PARTIAL_REVIEW",
]);

function findSource(sources, stageId) {
	const matches = Object.entries(sources ?? {}).filter(
		([specId]) => specId === stageId || specId.startsWith(`${stageId}.`),
	);
	if (matches.length > 1) {
		throw new Error(
			`deep-review renderer: ambiguous ${stageId} source (${matches.map(([specId]) => specId).join(", ")})`,
		);
	}
	return matches[0]?.[1] ?? null;
}

function asArray(value) {
	return Array.isArray(value) ? value : [];
}

function canonicalJsonValue(value) {
	if (Array.isArray(value)) return value.map(canonicalJsonValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, canonicalJsonValue(value[key])]),
	);
}

function sha256Json(value) {
	return createHash("sha256")
		.update(JSON.stringify(canonicalJsonValue(value)))
		.digest("hex");
}

function sameMultiset(left, right) {
	const counts = (values) => {
		const map = new Map();
		for (const value of values) map.set(value, (map.get(value) ?? 0) + 1);
		return map;
	};
	const a = counts(left);
	const b = counts(right);
	return a.size === b.size && [...a].every(([key, count]) => b.get(key) === count);
}

function cleanText(value) {
	return String(value ?? "")
		.replace(/\s+/g, " ")
		.replace(/\s+([,.;:!?])/g, "$1")
		.trim();
}

function evidenceText(value) {
	return String(value ?? "");
}

function escapeHeadingText(value) {
	return cleanText(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/([\\`*_[\]{}#+|])/g, "\\$1");
}

function escapeMarkdownText(value) {
	return escapeHeadingText(value);
}

function escapeTableCell(value) {
	return cleanText(value).replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

function inlineCode(value) {
	const text = escapeTableCell(value);
	const longestRun = Math.max(
		0,
		...[...text.matchAll(/`+/g)].map((match) => match[0].length),
	);
	const fence = "`".repeat(Math.max(1, longestRun + 1));
	const padded = /^`|`$|^\s|\s$/.test(text) ? ` ${text} ` : text;
	return `${fence}${padded}${fence}`;
}

function completionText(value) {
	const withoutArtifactPaths = cleanText(value)
		.replace(/(?:^|[\\/])\.pi[\\/]workflows(?:[\\/][^\s]*)?/gi, " [artifact omitted]")
		.replace(/\b(?:final-report|review|audit)\.md\b/gi, "[artifact omitted]")
		.replace(/\b(?:refs|control|partition-verdicts\.control|report\.control)\.json\b/gi, "[artifact omitted]")
		.replace(/\bworkflow[_-][\w.-]+\b/gi, "[run omitted]")
		.replace(/\btask[_-][\w.-]+\b/gi, "[task omitted]");
	return cleanText(withoutArtifactPaths)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/([\\`*_[\]{}#+|])/g, "\\$1");
}

function severityOf(finding) {
	const raw = cleanText(finding?.severity).toLowerCase();
	if (SEVERITY_ORDER.includes(raw)) return raw;
	return raw || "unknown";
}

function severityRank(severity) {
	const index = SEVERITY_ORDER.indexOf(severityOf({ severity }));
	return index === -1 ? SEVERITY_ORDER.length : index;
}

function titleOf(finding) {
	return cleanText(
		finding?.title ??
			finding?.finding ??
			finding?.summary ??
			"Untitled finding",
	);
}

function findingIdOf(finding, index) {
	return cleanText(
		finding?.findingId ??
			finding?.id ??
			`finding-${String(index + 1).padStart(3, "0")}`,
	);
}

function rootCauseIdOf(finding) {
	return cleanText(finding?.rootCauseId ?? "");
}

function exactDevilAdvocateStatus(status, identity) {
	return Boolean(
		status &&
		status.status === "completed" &&
		status.stageId === "devil-advocate" &&
		typeof status.specId === "string" &&
		status.specId.startsWith("devil-advocate.") &&
		status.itemIdentity === identity &&
		status.placeholderSpecId === "devil-advocate.item" &&
		typeof status.taskId === "string" &&
		status.taskId.trim(),
	);
}

function locationKey(location) {
	return `${location.file ?? ""}|${location.line ?? ""}|${location.lineEnd ?? ""}|${location.symbol ?? ""}`;
}

function normalizeLocation(location) {
	if (!location || typeof location !== "object") return null;
	const file = cleanText(location.file);
	if (!file) return null;
	const line = Number.isFinite(Number(location.line))
		? Number(location.line)
		: undefined;
	const lineEnd = Number.isFinite(Number(location.lineEnd))
		? Number(location.lineEnd)
		: undefined;
	const symbol = cleanText(location.symbol);
	return {
		file,
		...(line !== undefined ? { line } : {}),
		...(lineEnd !== undefined ? { lineEnd } : {}),
		...(symbol ? { symbol } : {}),
	};
}

function locationsOf(finding) {
	const seen = new Set();
	const out = [];
	for (const raw of asArray(finding?.locations)) {
		const location = normalizeLocation(raw);
		if (!location) continue;
		const key = locationKey(location);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(location);
	}
	return out;
}

function evidenceQuotesOf(finding) {
	const seen = new Set();
	const out = [];
	for (const quote of asArray(finding?.evidenceQuotes)) {
		const text = evidenceText(quote);
		if (!text.trim() || seen.has(text)) continue;
		seen.add(text);
		out.push(text);
	}
	return out;
}

function mergedLineageOf(finding) {
	const declared = Array.isArray(finding?.mergedFindings) && finding.mergedFindings.length > 0
		? finding.mergedFindings
		: finding?.mergedLineage;
	return asArray(declared)
		.filter((entry) => entry && typeof entry === "object")
		.flatMap((entry) => [entry, ...mergedLineageOf(entry)]);
}

function ledgerIdAudit(partition) {
	const ledger = partition?.partitions ?? partition?.reportContext;
	const topLevel = [
		...asArray(ledger?.keep),
		...asArray(ledger?.weaken),
		...asArray(ledger?.drop),
		...asArray(ledger?.needsHuman),
	];
	const strictId = (finding) =>
		typeof finding?.findingId === "string" && finding.findingId.trim()
			? finding.findingId.trim()
			: typeof finding?.id === "string" && finding.id.trim()
				? finding.id.trim()
				: "";
	const topLevelIds = topLevel.map(strictId);
	const supportNotes = asArray(partition?.supportNotes);
	const supportIds = supportNotes.map(strictId);
	const lineage = [
		...topLevel.flatMap((finding) => mergedLineageOf(finding)),
		...supportNotes.flatMap((note) => mergedLineageOf(note)),
	];
	const lineageIds = lineage.map(strictId);
	// Support cards are first-class ledger rows. Include their own IDs in the
	// same occurrence ledger as dispositions and recursive merged members.
	const allIds = [...topLevelIds, ...supportIds, ...lineageIds];
	const uniqueIds = new Set(allIds.filter(Boolean));
	const duplicateIds = allIds.filter(
		(id) => !id,
	).concat(allIds.filter(
		(id, index) => id && allIds.indexOf(id) !== index,
	));
	const reviewerLedger = partition?.reviewerLedger;
	const dedupSummary = partition?.dedupSummary;
	const verifier = partition?.verifierCoverage;
	const requiredLedgersPresent = [reviewerLedger, dedupSummary, verifier].every(
		(value) => value && typeof value === "object" && !Array.isArray(value),
	);
	const ledgerCompleteness = requiredLedgersPresent &&
		reviewerLedger.complete === true &&
		dedupSummary.complete === true &&
		verifier.complete === true;
	const duplicateLedger = asArray(dedupSummary?.duplicates);
	const duplicateCount = Number(dedupSummary?.duplicateCount);
	const duplicateLedgerKeys = new Set();
	const duplicateLedgerIssues = [];
	for (const duplicate of duplicateLedger) {
		const keptFindingId = typeof duplicate?.keptFindingId === "string" ? duplicate.keptFindingId.trim() : "";
		const droppedFindingId = typeof duplicate?.droppedFindingId === "string" ? duplicate.droppedFindingId.trim() : "";
		const key = `${keptFindingId}|${droppedFindingId}`;
		if (!keptFindingId || !droppedFindingId || keptFindingId === droppedFindingId)
			duplicateLedgerIssues.push({ duplicate, reason: "duplicate_ledger_row_missing_distinct_finding_ids" });
		else if (duplicateLedgerKeys.has(key))
			duplicateLedgerIssues.push({ duplicate, reason: "duplicate_ledger_row_repeated" });
		else if (!asArray(dedupSummary?.dedupFindingIds).includes(keptFindingId))
			duplicateLedgerIssues.push({ duplicate, reason: "duplicate_ledger_kept_id_not_in_dedup_ledger" });
		else duplicateLedgerKeys.add(key);
	}
	const rawReviewerIdSet = new Set(asArray(reviewerLedger?.rawFindingIds).filter((id) => typeof id === "string" && id.trim()));
	const rawReviewerIdsForAudit = asArray(reviewerLedger?.rawFindingIds).filter(
		(id) => typeof id === "string" && id.trim(),
	);
	const removedRawIds = rawReviewerIdsForAudit.filter((id) => !asArray(reviewerLedger?.dedupFindingIds).includes(id));
	const duplicateLedgerDroppedIds = duplicateLedger
		.map((duplicate) => typeof duplicate?.droppedFindingId === "string" ? duplicate.droppedFindingId.trim() : "")
		.filter(Boolean);
	const rawDuplicateIdsMissing = duplicateLedgerDroppedIds
		.filter((id) => !rawReviewerIdSet.has(id));
	const removedRawIdSet = new Set(removedRawIds);
	const duplicateLineageCounts = new Map();
	for (const id of lineageIds) {
		if (removedRawIdSet.has(id)) duplicateLineageCounts.set(id, (duplicateLineageCounts.get(id) ?? 0) + 1);
	}
	const rawDuplicateLineageIssues = removedRawIds.filter(
		(id) => duplicateLineageCounts.get(id) !== 1,
	);
	const independentlyDispositionedRawDuplicates = removedRawIds.filter(
		(id) => topLevelIds.includes(id) || supportIds.includes(id),
	);
	const duplicateLedgerRawIdsMismatch = !sameMultiset(
		removedRawIds,
		duplicateLedgerDroppedIds,
	);
	const duplicateCountAndShapeReconciled =
		Number.isSafeInteger(duplicateCount) &&
		duplicateCount >= 0 &&
		duplicateCount === duplicateLedger.length &&
		duplicateLedgerIssues.length === 0 &&
		rawDuplicateIdsMissing.length === 0 &&
		!duplicateLedgerRawIdsMismatch &&
		rawDuplicateLineageIssues.length === 0 &&
		independentlyDispositionedRawDuplicates.length === 0;
	const duplicateCountMismatch = !duplicateCountAndShapeReconciled;
	const rawReviewerIds = asArray(reviewerLedger?.rawFindingIds).filter(
		(id) => typeof id === "string" && id.trim(),
	);
	const dedupIds = asArray(reviewerLedger?.dedupFindingIds).filter(
		(id) => typeof id === "string" && id.trim(),
	);
	const sameIdSequence = (left, right) =>
		left.length === right.length && left.every((id, index) => id === right[index]);
	const ledgerRawIds = asArray(reviewerLedger?.rawFindingIds).filter(
		(id) => typeof id === "string" && id.trim(),
	);
	const summaryRawIds = asArray(dedupSummary?.rawFindingIds).filter(
		(id) => typeof id === "string" && id.trim(),
	);
	const ledgerDedupIds = asArray(reviewerLedger?.dedupFindingIds).filter(
		(id) => typeof id === "string" && id.trim(),
	);
	const summaryDedupIds = asArray(dedupSummary?.dedupFindingIds).filter(
		(id) => typeof id === "string" && id.trim(),
	);
	const rawReviewerIdsMismatch = Boolean(reviewerLedger && dedupSummary) &&
		(!Array.isArray(reviewerLedger.rawFindingIds) ||
			!Array.isArray(dedupSummary.rawFindingIds) ||
			!sameIdSequence(ledgerRawIds, summaryRawIds));
	const dedupIdsMismatch = Boolean(reviewerLedger && dedupSummary) &&
		(!Array.isArray(reviewerLedger.dedupFindingIds) ||
			!Array.isArray(dedupSummary.dedupFindingIds) ||
			!sameIdSequence(ledgerDedupIds, summaryDedupIds));
	const rawCountMismatch = dedupSummary &&
		Number.isSafeInteger(Number(dedupSummary.rawCount)) &&
		Number(dedupSummary.rawCount) !== rawReviewerIds.length;
	const uniqueCountMismatch = dedupSummary &&
		Number.isSafeInteger(Number(dedupSummary.uniqueCount)) &&
		Number(dedupSummary.uniqueCount) !== dedupIds.length;
	const dedupDroppedIdSet = new Set(rawReviewerIds.filter((id) => !dedupIds.includes(id)));
	const actualDedupPairs = [
		...topLevel,
		...supportNotes,
	].flatMap((root) => {
		const rootId = strictId(root);
		return rootId
			? mergedLineageOf(root)
				.filter((member) => dedupDroppedIdSet.has(strictId(member)))
				.map((member) => `${rootId}|${strictId(member)}`)
			: [];
	});
	const duplicateLedgerPairs = duplicateLedger
		.map((duplicate) => `${String(duplicate?.keptFindingId ?? "").trim()}|${String(duplicate?.droppedFindingId ?? "").trim()}`);
	const duplicateLedgerPairsMismatch = !sameMultiset(actualDedupPairs, duplicateLedgerPairs);
	const duplicateLedgerReconciled = duplicateCountAndShapeReconciled && !duplicateLedgerPairsMismatch;
	const dispositionIdSet = new Set(allIds.filter(Boolean));
	const rawReviewerIdsMissing = [...new Set(
		rawReviewerIds.filter((id) => !dispositionIdSet.has(id)),
	)];
	const dedupIdsMissing = [...new Set(
		dedupIds.filter((id) => !dispositionIdSet.has(id)),
	)];
	const verifierRows = asArray(verifier?.rows).filter(
		(row) => row && typeof row === "object",
	);
	const verifierRowIds = verifierRows
		.map((row) => (typeof row.findingId === "string" ? row.findingId.trim() : ""))
		.filter(Boolean);
	const expectedVerifierIds = asArray(verifier?.expectedFindingIds).filter(
		(id) => typeof id === "string" && id.trim(),
	);
	const expectedVerifierSet = new Set(expectedVerifierIds);
	const verifierRowSet = new Set(verifierRowIds);
	const verifierMissingIds = expectedVerifierIds.filter(
		(id) => !verifierRowSet.has(id),
	);
	const verifierOrphanIds = verifierRowIds.filter(
		(id) => !expectedVerifierSet.has(id),
	);
	const verifierDuplicateIds = verifierRowIds.filter(
		(id, index) => verifierRowIds.indexOf(id) !== index,
	);
	const verifierOwnershipIssues = verifierRows.filter((row) => {
		const owner = row.owner;
		if (!owner || ![owner.source, owner.specId, owner.taskId, owner.itemIdentity, owner.placeholderSpecId].every((value) => typeof value === "string" && value.trim())) return true;
		const statuses = asArray(verifier?.sourceStatuses).filter(
			(status) => status && (status.source === row.sourceId || status.specId === row.sourceId),
		);
		if (statuses.length !== 1) return true;
		const status = statuses[0];
		const identity = row.batchId ?? row.findingId;
		if (!exactDevilAdvocateStatus(status, identity)) return true;
		return owner.source !== status.source || owner.specId !== status.specId || owner.taskId !== status.taskId || owner.itemIdentity !== status.itemIdentity || owner.placeholderSpecId !== status.placeholderSpecId;
	});
	const verifierExpectedMismatch = !sameMultiset(expectedVerifierIds, dedupIds);
	const verifierStatusIssues = asArray(verifier?.sourceStatuses)
		.filter((status) =>
			status?.stageId === "devil-advocate" ||
			String(status?.specId ?? "").startsWith("devil-advocate.") ||
			String(status?.source ?? "").startsWith("devil-advocate."),
		)
		.filter((status) => {
			const identity = String(status?.itemIdentity ?? "").trim();
			return !identity ||
				!((expectedVerifierIds.includes(identity) || asArray(verifier?.rows).some((row) => row?.batchId === identity)) &&
					exactDevilAdvocateStatus(status, identity));
		})
		.map((status) => ({
			sourceId: status.source ?? status.specId ?? "",
			itemIdentity: status.itemIdentity ?? "",
			reason: "verifier status is not an exact completed devil-advocate owner",
		}));
	const verifierDeclaredRowsMismatch = !sameMultiset(
		asArray(verifier?.verdictFindingIds),
		verifierRowIds,
	);
	const partitionVerdictsReceived = Number(partition?.partitionSummary?.verdictsReceived);
	const verifierVerdictsReceived = Number(verifier?.verdictsReceived);
	const verdictsReceivedMismatch =
		!Number.isSafeInteger(partitionVerdictsReceived) ||
		partitionVerdictsReceived < 0 ||
		!Number.isSafeInteger(verifierVerdictsReceived) ||
		verifierVerdictsReceived < 0 ||
		partitionVerdictsReceived !== verifierVerdictsReceived ||
		verifierVerdictsReceived !== verifierRows.length;
	const reviewerOwnerMapIssues = asArray(reviewerLedger?.ownerMap).filter((owner) => {
		const statuses = asArray(reviewerLedger?.sourceStatuses).filter(
			(status) => status?.source === owner?.source || status?.specId === owner?.source,
		);
		if (statuses.length !== 1) return true;
		const status = statuses[0];
		return !owner || owner.source !== status.source || owner.specId !== status.specId || owner.taskId !== status.taskId || owner.itemIdentity !== status.itemIdentity || owner.placeholderSpecId !== status.placeholderSpecId || status.status !== "completed";
	});
	const verifierDigestMatches =
		requiredLedgersPresent &&
		typeof verifier.digest === "string" &&
		verifier.digest ===
			sha256Json({
				expectedFindingIds: asArray(verifier.expectedFindingIds),
				verdictFindingIds: asArray(verifier.verdictFindingIds),
				rows: verifierRows,
			});
	const verifierCoverageExact =
		requiredLedgersPresent && ledgerCompleteness && !verifierExpectedMismatch &&
		(verifierDigestMatches &&
			!verdictsReceivedMismatch &&
			!verifierDeclaredRowsMismatch &&
			verifierStatusIssues.length === 0 &&
			verifierMissingIds.length === 0 &&
			verifierOrphanIds.length === 0 &&
			verifierDuplicateIds.length === 0 &&
			verifierOwnershipIssues.length === 0);
	const plannedLensIds = asArray(reviewerLedger?.plannedLensIds).filter(
		(id) => typeof id === "string" && id.trim(),
	);
	const materializedReviewerIds = asArray(
		reviewerLedger?.materializedReviewerIds,
	).filter((id) => typeof id === "string" && id.trim());
	const reviewerMissingLensIds = plannedLensIds.filter(
		(id) => !materializedReviewerIds.includes(id),
	);
	const reviewerUnexpectedIds = materializedReviewerIds.filter(
		(id) => plannedLensIds.length > 0 && !plannedLensIds.includes(id),
	);
	const reviewerDuplicateIds = materializedReviewerIds.filter(
		(id, index) => materializedReviewerIds.indexOf(id) !== index,
	);
	const attestedLensIds = asArray(reviewerLedger?.attestedLensIds).filter(
		(id) => typeof id === "string" && id.trim(),
	);
	const reviewerMissingAttestedLensIds = plannedLensIds.filter(
		(id) => !attestedLensIds.includes(id),
	);
	const reviewerUnexpectedAttestedIds = attestedLensIds.filter(
		(id) => !plannedLensIds.includes(id),
	);
	const reviewerCoverageReconciled =
		requiredLedgersPresent && ledgerCompleteness &&
		Array.isArray(reviewerLedger.plannedLensIds) &&
		Array.isArray(reviewerLedger.materializedReviewerIds) &&
		Array.isArray(reviewerLedger.attestedLensIds) &&
		sameMultiset(plannedLensIds, materializedReviewerIds) &&
		sameMultiset(plannedLensIds, attestedLensIds) &&
		reviewerMissingLensIds.length === 0 &&
		reviewerUnexpectedIds.length === 0 &&
		reviewerDuplicateIds.length === 0 &&
		reviewerMissingAttestedLensIds.length === 0 &&
		reviewerUnexpectedAttestedIds.length === 0;
	const supportLedgerIds = asArray(dedupSummary?.supportFindingIds).filter(
		(id) => typeof id === "string" && id.trim(),
	);
	const declaredDispositionIds = asArray(dedupSummary?.dispositionFindingIds).filter(
		(id) => typeof id === "string" && id.trim(),
	);
	const declaredLineageIds = asArray(dedupSummary?.lineageFindingIds).filter(
		(id) => typeof id === "string" && id.trim(),
	);
	const actualSupportIds = supportIds.filter(Boolean);
	const behavioralRoots = [
		...asArray(ledger?.keep),
		...asArray(ledger?.weaken),
	].filter((finding) => {
		const classification = String(
			finding?.classification ?? finding?.supportClassification ?? "",
		).trim().toLowerCase();
		return classification === "" || classification === "behavioral" || classification === "material";
	});
	const behavioralRootIds = new Set(behavioralRoots.map(strictId).filter(Boolean));
	const behavioralRootCauseIds = new Set(
		behavioralRoots
			.filter((finding) =>
				typeof finding?.rootCauseId === "string" && finding.rootCauseId.trim() &&
				((typeof finding.explicitRootCauseId === "string" && finding.explicitRootCauseId.trim() === finding.rootCauseId.trim()) ||
					(!finding.explicitRootCauseId && finding.generatedRootCauseId !== true)),
			)
			.map((finding) => finding.rootCauseId.trim()),
	);
	const supportRelationIssues = supportNotes.filter((note) => {
		const supportingId = typeof note?.supportingFindingId === "string"
			? note.supportingFindingId.trim()
			: "";
		return !supportingId ||
			(!behavioralRootIds.has(supportingId) && !behavioralRootCauseIds.has(supportingId));
	});
	const supportProvenanceIssues = supportNotes.filter((note) => {
		const owner = note?.reviewerIdentity;
		const ownerComplete = owner &&
			[owner.source, owner.specId, owner.taskId, owner.itemIdentity, owner.placeholderSpecId]
				.every((value) => typeof value === "string" && value.trim());
		const verifierOwner = note?.verifierOwner;
		const verifierOwnerComplete = verifierOwner &&
			[verifierOwner.source, verifierOwner.specId, verifierOwner.taskId, verifierOwner.itemIdentity, verifierOwner.placeholderSpecId]
				.every((value) => typeof value === "string" && value.trim());
		const verifierRowsForNote = verifierRows.filter((row) => row.findingId === strictId(note));
		const verifierBindingValid = verifierRowsForNote.length === 1 &&
			verifierOwnerComplete &&
			verifierRowsForNote[0].owner &&
			["source", "specId", "taskId", "itemIdentity", "placeholderSpecId"]
				.every((key) => verifierRowsForNote[0].owner[key] === verifierOwner[key]);
		const declaredMerged = asArray(note?.mergedFindings);
		const declaredMergedLineage = asArray(note?.mergedLineage);
		const mergedDeclarationsAgree =
			!Array.isArray(note?.mergedFindings) || !Array.isArray(note?.mergedLineage) ||
			JSON.stringify(mergedLineageOf({ mergedFindings: declaredMerged }).map(strictId)) ===
				JSON.stringify(mergedLineageOf({ mergedFindings: declaredMergedLineage }).map(strictId));
		const lineageComplete = mergedLineageOf(note).every((member) => {
			const memberOwner = member?.reviewerIdentity;
			return strictId(member) &&
				typeof member?.originalFindingId === "string" && member.originalFindingId.trim() &&
				typeof member?.rootCauseId === "string" && member.rootCauseId.trim() &&
				typeof member?.source === "string" && member.source.trim() &&
				Array.isArray(member?.sourceLineage) && member.sourceLineage.length > 0 &&
				memberOwner &&
				[memberOwner.source, memberOwner.specId, memberOwner.taskId, memberOwner.itemIdentity, memberOwner.placeholderSpecId]
					.every((value) => typeof value === "string" && value.trim());
		});
		return !strictId(note) ||
			typeof note?.originalFindingId !== "string" || !note.originalFindingId.trim() ||
			typeof note?.rootCauseId !== "string" || !note.rootCauseId.trim() ||
			typeof note?.source !== "string" || !note.source.trim() ||
			!Array.isArray(note?.sourceLineage) || note.sourceLineage.length === 0 ||
			!ownerComplete || !verifierOwnerComplete || !verifierBindingValid ||
			!mergedDeclarationsAgree || !lineageComplete;
	});
	const actualLineageIds = lineageIds.filter(Boolean);
	const provenanceOwnerIssues = [
		...topLevel.flatMap((finding) => [finding, ...mergedLineageOf(finding)]),
		...supportNotes.flatMap((note) => [note, ...mergedLineageOf(note)]),
	].filter((finding) => {
		const owner = finding?.reviewerIdentity;
		return owner !== undefined &&
			(!owner || ![owner.source, owner.specId, owner.taskId, owner.itemIdentity, owner.placeholderSpecId].every((value) => typeof value === "string" && value.trim()));
	});
	const reviewerOwnerBySource = new Map(
		asArray(reviewerLedger?.ownerMap).map((owner) => [owner?.source, owner]),
	);
	const reviewerFindingOwnerIssues = [
		...topLevel.flatMap((finding) => [finding, ...mergedLineageOf(finding)]),
		...asArray(partition?.supportNotes).flatMap((note) => [note, ...mergedLineageOf(note)]),
	].filter((finding) => {
		const id = strictId(finding);
		if (!id || !dedupIds.includes(id)) return false;
		const owner = finding?.reviewerIdentity;
		const expectedOwner = reviewerOwnerBySource.get(finding?.source);
		return !owner || !expectedOwner || !sameMultiset(
			[owner.source, owner.specId, owner.taskId, owner.itemIdentity, owner.placeholderSpecId],
			[expectedOwner.source, expectedOwner.specId, expectedOwner.taskId, expectedOwner.itemIdentity, expectedOwner.placeholderSpecId],
		);
	});
	// Raw reviewer rows are conserved by the final top-level rows plus every
	// recursive lineage member. Dedup IDs are a separate boundary: a merged
	// member already represented by the dedup ledger is not counted twice.
	const dedupLineageIds = actualLineageIds.filter((id) => dedupIds.includes(id));
	const idLedgerExact = requiredLedgersPresent &&
		sameMultiset(rawReviewerIds, [...topLevelIds.filter(Boolean), ...actualSupportIds, ...actualLineageIds]) &&
		sameMultiset(dedupIds, [...declaredDispositionIds.filter((id) => dedupIds.includes(id)), ...supportLedgerIds, ...dedupLineageIds]) &&
		sameMultiset(declaredDispositionIds, topLevelIds.filter(Boolean)) &&
		sameMultiset(supportLedgerIds, actualSupportIds) &&
		sameMultiset(declaredLineageIds, actualLineageIds) &&
		sameMultiset(reviewerLedger.dispositionFindingIds, topLevelIds.filter(Boolean)) &&
		sameMultiset(reviewerLedger.supportFindingIds, actualSupportIds) &&
		sameMultiset(reviewerLedger.lineageFindingIds, actualLineageIds) &&
		sameMultiset(reviewerLedger.provenanceOwnerFindingIds, [...topLevelIds.filter(Boolean), ...actualSupportIds, ...actualLineageIds]) &&
		provenanceOwnerIssues.length === 0 &&
		supportRelationIssues.length === 0 &&
		supportProvenanceIssues.length === 0 &&
		reviewerOwnerMapIssues.length === 0 &&
		reviewerFindingOwnerIssues.length === 0;
	const reviewerDedupReconciled =
		requiredLedgersPresent && idLedgerExact &&
		(rawReviewerIdsMissing.length === 0 &&
			dedupIdsMissing.length === 0 &&
			!rawReviewerIdsMismatch &&
			!dedupIdsMismatch &&
			!rawCountMismatch &&
			!uniqueCountMismatch);
	const summary = partition?.partitionSummary;
	const expectedMerged = Number(summary?.mergedFindings);
	const mergedCountMismatch =
		!Number.isSafeInteger(expectedMerged) ||
		expectedMerged < 0 ||
		expectedMerged !== lineage.length;
	const expectedCounts = {
		keep: Number(summary?.keep),
		weaken: Number(summary?.weaken),
		drop: Number(summary?.drop),
		needsHuman: Number(summary?.needsHuman),
	};
	const actualCounts = {
		keep: asArray(ledger?.keep).length,
		weaken: asArray(ledger?.weaken).length,
		drop: asArray(ledger?.drop).length,
		needsHuman: asArray(ledger?.needsHuman).length,
	};
	const topLevelCountMismatch = Object.keys(expectedCounts).some(
		(key) =>
			!Number.isSafeInteger(expectedCounts[key]) ||
			expectedCounts[key] < 0 ||
			expectedCounts[key] !== actualCounts[key],
	);
	return {
		topLevelIds,
		supportIds,
		lineageIds,
		uniqueIds,
		duplicateIds: [...new Set(duplicateIds)],
		mergedCount: lineage.length,
		expectedMerged,
		mergedCountMismatch,
		topLevelCountMismatch,
		rawReviewerIds,
		dedupIds,
		rawReviewerIdsMissing,
		dedupIdsMissing,
		rawReviewerIdsMismatch,
		dedupIdsMismatch,
		rawCountMismatch,
		uniqueCountMismatch,
		duplicateCountMismatch,
		duplicateLedgerReconciled,
		duplicateLedgerPairsMismatch,
		duplicateLedgerIssues,
		rawDuplicateIdsMissing,
		rawDuplicateLineageIssues,
		independentlyDispositionedRawDuplicates,
		duplicateLedgerRawIdsMismatch,
		verdictsReceivedMismatch,
		partitionVerdictsReceived,
		verifierVerdictsReceived,
		reviewerCoverageReconciled,
		reviewerMissingLensIds,
		reviewerUnexpectedIds,
		reviewerDuplicateIds,
		reviewerDedupReconciled,
		verifierCoverageExact,
		verifierDigestMatches,
		expectedVerifierIds,
		verifierDeclaredRowsMismatch,
		verifierStatusIssues,
		reviewerOwnerMapIssues,
		verifierOwnerIssues: verifierOwnershipIssues,
		verifierRowIds,
		verifierMissingIds,
		verifierOrphanIds,
		verifierDuplicateIds,
		verifierOwnershipIssues,
		verifierExpectedMismatch,
		ledgerCompleteness,
		requiredLedgersPresent,
		idLedgerExact,
		provenanceOwnerIssues,
		supportRelationIssues,
		supportProvenanceIssues,
		reviewerFindingOwnerIssues,
		reviewerMissingAttestedLensIds,
		reviewerUnexpectedAttestedIds,
		reviewerFindingOwnerIssues,
	};
}

function markdownFenceInfo(quote) {
	if (
		/^\s*(const|let|var|function|export|import|await|return|if|for|while)\b/.test(
			quote,
		)
	)
		return "ts";
	if (/^\s*(FROM|ENV|RUN|CMD|COPY|WORKDIR|EXPOSE)\b/i.test(quote))
		return "dockerfile";
	if (/^\s*[{}[]/.test(quote)) return "json";
	return "text";
}

function renderLocationsTable(locations) {
	if (locations.length === 0) return ["Locations: _not provided_", ""];
	return [
		"Locations:",
		"",
		"| File | Line | Symbol |",
		"|---|---:|---|",
		...locations.map((location) => {
			const line =
				location.line === undefined
					? "—"
					: location.lineEnd !== undefined && location.lineEnd !== location.line
						? `${location.line}-${location.lineEnd}`
						: `${location.line}`;
			return `| ${inlineCode(location.file)} | ${escapeTableCell(line)} | ${location.symbol ? inlineCode(location.symbol) : "—"} |`;
		}),
		"",
	];
}

function renderEvidenceQuotes(quotes) {
	if (quotes.length === 0) return [];
	const out = ["Evidence:", ""];
	for (const quote of quotes) {
		const info = markdownFenceInfo(quote);
		const runs = String(quote).match(/`+/g) ?? [];
		const fence = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
		out.push(`${fence}${info}`);
		out.push(quote);
		out.push(fence, "");
	}
	return out;
}

function renderMergedProvenance(finding) {
	const lineage = mergedLineageOf(finding);
	if (lineage.length === 0) return [];
	const out = ["Merged provenance:", ""];
	for (const [index, member] of lineage.entries()) {
		const id = findingIdOf(member, index);
		const title = titleOf(member);
		const verdict = cleanText(member.originalVerdict ?? member.verdict ?? "unknown");
		const severity = severityOf(member);
		out.push(`- ${inlineCode(id)} — ${escapeMarkdownText(title)} (original verdict: **${escapeMarkdownText(verdict)}**, original severity: **${escapeMarkdownText(member.originalSeverity ?? severity)}**)`);
		out.push(`  ${exactField("Finding ID", id)}`);
		out.push(`  ${exactField("Original finding ID", member.originalFindingId)}`);
		out.push(`  ${exactField("Root cause ID", member.rootCauseId)}`);
		if (member.reviewerIdentity) {
			out.push(`  Reviewer source: ${inlineCode(member.reviewerIdentity.source)}`);
			out.push(`  Reviewer task: ${inlineCode(member.reviewerIdentity.taskId)}`);
		}
		if (member.source || asArray(member.sourceLineage).length > 0) {
			const lineageSources = asArray(member.sourceLineage).filter((value) => typeof value === "string");
			out.push(`  Source: ${inlineCode(member.source ?? "")}`);
			out.push(`  Source lineage: ${lineageSources.map((value) => inlineCode(value)).join(", ")}`);
		}
		for (const location of locationsOf(member)) {
			const line = location.line === undefined
				? "—"
				: location.lineEnd !== undefined && location.lineEnd !== location.line
					? `${location.line}-${location.lineEnd}`
					: `${location.line}`;
			out.push(`  Location: ${inlineCode(location.file)}:${escapeTableCell(line)}`);
		}
		for (const quote of evidenceQuotesOf(member)) {
			const info = markdownFenceInfo(quote);
			const runs = String(quote).match(/`+/g) ?? [];
			const fence = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
			out.push(`  Evidence (${info}):`, `  ${fence}${info}`, `  ${String(quote).replace(/\n/g, "\n  ")}`, `  ${fence}`);
		}
		const action = cleanText(member.recommendedAction);
		if (action) out.push(`  Action: ${escapeMarkdownText(action)}`);
		for (const counter of asArray(member.counterEvidence)) {
			const text = cleanText(typeof counter === "string" ? counter : JSON.stringify(counter));
			if (text) out.push(`  Counter-evidence: ${escapeMarkdownText(text)}`);
		}
	}
	out.push("");
	return out;
}

function renderCounterEvidence(finding) {
	const counter = asArray(finding?.counterEvidence)
		.map((item) =>
			typeof item === "string"
				? item
				: (item?.evidence ??
					item?.reason ??
					item?.note ??
					JSON.stringify(item)),
		)
		.map((item) => escapeHeadingText(item))
		.filter(Boolean);
	if (counter.length === 0 && !finding?.note) return [];
	return [
		"Caveat / counter-evidence:",
		"",
		...(finding?.note ? [`- ${escapeHeadingText(finding.note)}`] : []),
		...counter.map((item) => `- ${item}`),
		"",
	];
}

function normalizeFinding(finding, index, verdict) {
	return {
		...finding,
		findingId: findingIdOf(finding, index),
		rootCauseId: rootCauseIdOf(finding),
		title: titleOf(finding),
		severity: severityOf(finding),
		verdict,
	};
}

function partitionFindings(partition) {
	const ledger = partition?.partitions ?? partition?.reportContext;
	const keep = asArray(ledger?.keep).map((finding, index) =>
		normalizeFinding(finding, index, "KEEP"),
	);
	const weaken = asArray(ledger?.weaken).map((finding, index) =>
		normalizeFinding(finding, keep.length + index, "WEAKEN"),
	);
	return { keep, weaken, all: [...keep, ...weaken] };
}

function expectedFindingCount(partition, allFindings) {
	const summary = partition?.partitionSummary;
	const keep = Number(summary?.keep);
	const weaken = Number(summary?.weaken);
	if (Number.isFinite(keep) || Number.isFinite(weaken)) {
		return (
			(Number.isFinite(keep) ? keep : 0) +
			(Number.isFinite(weaken) ? weaken : 0)
		);
	}
	return allFindings.length;
}

function groupBySeverity(findings) {
	const grouped = new Map();
	for (const finding of findings) {
		const severity = severityOf(finding);
		if (!grouped.has(severity)) grouped.set(severity, []);
		grouped.get(severity).push(finding);
	}
	return [...grouped.entries()].sort(
		([a], [b]) => severityRank(a) - severityRank(b) || a.localeCompare(b),
	);
}

function severityCounts(findings) {
	const counts = {};
	for (const finding of findings) {
		const severity = severityOf(finding);
		counts[severity] = (counts[severity] ?? 0) + 1;
	}
	return counts;
}

function renderSeveritySummary(findings) {
	const counts = severityCounts(findings);
	if (Object.keys(counts).length === 0) return [];
	return [
		"## Finding summary",
		"",
		"| Severity | Count |",
		"|---|---:|",
		...Object.entries(counts)
			.sort(
				([a], [b]) => severityRank(a) - severityRank(b) || a.localeCompare(b),
			)
			.map(([severity, count]) => `| ${severity} | ${count} |`),
		"",
	];
}

function renderFindingCard(finding) {
	const locations = locationsOf(finding);
	const quotes = evidenceQuotesOf(finding);
	const out = [
		`### ${escapeHeadingText(finding.findingId)} — ${escapeHeadingText(finding.title)}`,
		"",
		`Severity: **${cleanText(finding.severity)}**  `,
		...(finding.rootCauseId
			? [`Root cause: ${inlineCode(finding.rootCauseId)}  `]
			: []),
		...(finding.verdict && finding.verdict !== "KEEP"
			? [`Verifier verdict: **${cleanText(finding.verdict)}**  `]
			: []),
		"",
		...renderLocationsTable(locations),
		...renderEvidenceQuotes(quotes),
		...renderMergedProvenance(finding),
	];
	const action = escapeHeadingText(
		finding.recommendedAction ?? finding.concreteFix ?? "",
	);
	if (action) {
		out.push("Recommended action:", "", action, "");
	}
	out.push(...renderCounterEvidence(finding));
	return out;
}

function renderFindings(findings) {
	if (findings.length === 0)
		return [
			"## Findings",
			"",
			"No kept or weakened findings were present in the partition ledger.",
			"",
		];
	const representedIds = findings.map((finding) => finding.findingId);
	const out = [];
	for (const [severity, group] of groupBySeverity(findings)) {
		out.push(
			`## ${severity[0].toUpperCase()}${severity.slice(1)} findings`,
			"",
		);
		for (const finding of group) out.push(...renderFindingCard(finding));
	}
	return { lines: out, representedIds };
}

function renderDropped(partition) {
	const ledger = partition?.partitions ?? partition?.reportContext;
	const items = asArray(ledger?.drop);
	if (items.length === 0) return { lines: [], representedIds: [] };
	const out = ["## Dropped findings", ""];
	const representedIds = [];
	for (const [index, raw] of items.entries()) {
		const finding = normalizeFinding(raw, index, "DROP");
		representedIds.push(finding.findingId);
		out.push(...renderFindingCard(finding));
	}
	out.push("");
	return { lines: out, representedIds };
}

function renderNeedsHuman(partition) {
	const ledger = partition?.partitions ?? partition?.reportContext;
	const items = asArray(ledger?.needsHuman);
	if (items.length === 0) return { lines: [], representedIds: [] };
	const out = ["## Needs human review", ""];
	const representedIds = [];
	for (const [index, raw] of items.entries()) {
		const finding = normalizeFinding(raw, index, "NEEDS_HUMAN");
		representedIds.push(finding.findingId);
		out.push(...renderFindingCard(finding));
	}
	return { lines: out, representedIds };
}

function needsHumanCounts(partition) {
	const partitionsPresent = Boolean(
		partition?.partitions &&
			typeof partition.partitions === "object" &&
			Array.isArray(partition.partitions.needsHuman),
	);
	const ledger = partition?.partitions ?? partition?.reportContext;
	const actual = asArray(ledger?.needsHuman).length;
	const summary = partition?.partitionSummary;
	const summaryCountPresent = Boolean(
		summary &&
			typeof summary === "object" &&
			Object.hasOwn(summary, "needsHuman") &&
			Number.isFinite(Number(summary.needsHuman)),
	);
	return {
		actual,
		expected: summaryCountPresent ? Number(summary.needsHuman) : actual,
		metadataMissing: !partitionsPresent || !summaryCountPresent,
		incompleteEvidence: asArray(ledger?.needsHuman).filter(
			(finding) =>
				locationsOf(finding).length === 0 ||
				evidenceQuotesOf(finding).length === 0,
		).length,
	};
}

function exactField(label, value) {
	const text = String(value ?? "");
	return `${label}: ${inlineCode(text)}`;
}


function renderReviewerOwner(owner) {
	if (!owner || typeof owner !== "object") return ["Reviewer owner: _not provided_", ""];
	return [
		"Reviewer owner:",
		"",
		exactField("- source", owner.source),
		exactField("- specId", owner.specId),
		exactField("- taskId", owner.taskId),
		exactField("- itemIdentity", owner.itemIdentity),
		exactField("- placeholderSpecId", owner.placeholderSpecId),
		"",
	];
}


function renderSupportProvenance(note) {
	const sourceLineage = asArray(note?.sourceLineage).filter(
		(value) => typeof value === "string",
	);
	return [
		"Support provenance:",
		"",
		exactField("Finding ID", note?.findingId),
		exactField("Original finding ID", note?.originalFindingId),
		exactField("Root cause ID", note?.rootCauseId),
		...renderReviewerOwner(note?.reviewerIdentity),
		...(note?.verifierOwner ? ["Verifier owner:", ...renderReviewerOwner(note.verifierOwner)] : []),
		exactField("Source", note?.source),
		`Source lineage: ${sourceLineage.length > 0 ? sourceLineage.map((value) => inlineCode(value)).join(", ") : "_not provided_"}`,
		exactField("Supporting finding ID", note?.supportingFindingId),
		`Merged lineage: ${mergedLineageOf(note).length > 0 ? mergedLineageOf(note).map((member, index) => inlineCode(findingIdOf(member, index))).join(", ") : "_none_"}`,
		"",
	];
}


function supportEmissionRow(note, index) {
	const id = findingIdOf(note, index);
	return {
		kind: "support",
		id,
		findingId: id,
		originalFindingId: String(note?.originalFindingId ?? ""),
		rootCauseId: String(note?.rootCauseId ?? ""),
		source: String(note?.source ?? ""),
		sourceLineage: asArray(note?.sourceLineage).map(String),
		reviewerIdentity: note?.reviewerIdentity && typeof note.reviewerIdentity === "object"
			? { ...note.reviewerIdentity }
			: null,
		verifierOwner: note?.verifierOwner && typeof note.verifierOwner === "object"
			? { ...note.verifierOwner }
			: null,
		supportingFindingId: String(note?.supportingFindingId ?? ""),
		mergedLineage: mergedLineageOf(note).map((member, memberIndex) => ({
			findingId: findingIdOf(member, memberIndex),
			originalFindingId: String(member?.originalFindingId ?? ""),
			rootCauseId: String(member?.rootCauseId ?? ""),
			source: String(member?.source ?? ""),
			sourceLineage: asArray(member?.sourceLineage).map(String),
			reviewerIdentity: member?.reviewerIdentity && typeof member.reviewerIdentity === "object"
				? { ...member.reviewerIdentity }
				: null,
			verifierOwner: member?.verifierOwner && typeof member.verifierOwner === "object"
				? { ...member.verifierOwner }
				: null,
		})),
	};
}


function renderSupportNotes(partition) {
	const notes = asArray(partition?.supportNotes);
	if (notes.length === 0) return { lines: [], representedRows: 0 };
	const out = ["## Supporting observations", ""];
	let representedRows = 0;
	for (const note of notes) {
		representedRows += 1;
		const noteId = findingIdOf(note, 0);
		out.push(
			`### ${noteId ? `${inlineCode(noteId)} — ` : ""}${escapeMarkdownText(titleOf(note))}`,
			"",
			`Severity: **${severityOf(note)}**  `,
		);
		const reason = cleanText(note?.reason);
		if (reason) out.push(`Reason: ${escapeMarkdownText(reason)}  `);
		const related = cleanText(note?.supportingFindingOf);
		if (related) out.push(`Supports: ${escapeMarkdownText(related)}  `);
		out.push(
			"",
			...renderSupportProvenance(note),
			...renderLocationsTable(locationsOf(note)),
			...renderEvidenceQuotes(evidenceQuotesOf(note)),
			...renderMergedProvenance(note),
		);
		const action = cleanText(note?.recommendedAction);
		if (action) out.push("Recommended action:", "", escapeMarkdownText(action), "");
	}
	return { lines: out, representedRows };
}
function structuredEmissionRows(partition) {
	const ledger = partition?.partitions ?? partition?.reportContext;
	const rows = [];
	for (const [kind, findings] of [["top-level", asArray(ledger?.keep)], ["top-level", asArray(ledger?.weaken)], ["top-level", asArray(ledger?.drop)], ["top-level", asArray(ledger?.needsHuman)]]) {
		for (const [index, finding] of findings.entries()) {
			const id = findingIdOf(finding, index);
			if (id) rows.push({ kind, id });
			for (const member of mergedLineageOf(finding)) {
				const lineageId = findingIdOf(member, index);
				if (lineageId) rows.push({ kind: "lineage", id: lineageId });
			}
		}
	}
	for (const [index, note] of asArray(partition?.supportNotes).entries()) {
		const id = findingIdOf(note, index);
		if (id) rows.push(supportEmissionRow(note, index));
		for (const member of mergedLineageOf(note)) {
			const lineageId = findingIdOf(member, index);
			if (lineageId) rows.push({ kind: "lineage", id: lineageId });
		}
	}
	return rows;
}

function sameEmissionRows(expected, emitted) {
	// IDs are the identity key for ordinary rows, but support rows also carry
	// authoritative provenance. Compare the complete canonical row so a support
	// ID cannot survive while its owner/source/target silently drifts.
	const key = (row) => JSON.stringify(canonicalJsonValue(row));
	return sameMultiset(expected.map(key), emitted.map(key));
}

function supportNoteCounts(partition) {
	const notesPresent = Array.isArray(partition?.supportNotes);
	const notes = asArray(partition?.supportNotes);
	const summary = partition?.partitionSummary;
	const summaryCountPresent = Boolean(
		summary &&
			typeof summary === "object" &&
			Object.hasOwn(summary, "supportNotes") &&
			Number.isFinite(Number(summary.supportNotes)),
	);
	const declared = summaryCountPresent
		? Number(summary.supportNotes)
		: notes.length;
	return {
		actual: notes.length,
		expected: declared,
		metadataMissing: !notesPresent || !summaryCountPresent,
		incompleteEvidence: notes.filter(
			(note) =>
				locationsOf(note).length === 0 || evidenceQuotesOf(note).length === 0,
		).length,
	};
}

function renderRisks(report, partition) {
	const risks = asArray(report?.risks).map((risk) =>
		typeof risk === "string"
			? risk
			: (risk?.risk ?? risk?.note ?? risk?.summary ?? JSON.stringify(risk)),
	);
	const partialFailures = [
		...asArray(partition?.sourceStatusSummary?.partialFailures),
		...asArray(partition?.reportContext?.partialFailures),
	];
	const notes = asArray(partition?.normalizationNotes).map((note) =>
		typeof note === "string" ? note : JSON.stringify(note),
	);
	if (risks.length === 0 && partialFailures.length === 0 && notes.length === 0)
		return [];
	const out = ["## Risks and partial-review limitations", ""];
	for (const risk of risks) out.push(`- ${cleanText(risk)}`);
	for (const failure of partialFailures) {
		out.push(
			`- Partial source: ${cleanText(failure.displayName ?? failure.specId ?? failure.source ?? JSON.stringify(failure))} (${failure.status ?? "unknown"})`,
		);
	}
	for (const note of notes)
		out.push(`- Normalization note: ${cleanText(note)}`);
	out.push("");
	return out;
}

function hasReportSynthesis(report) {
	return Boolean(
		report &&
			typeof report === "object" &&
			cleanText(report.summary) &&
			REPORT_VERDICTS.has(cleanText(report.verdict)),
	);
}

function hasPartialFailures(partition) {
	const summaryCount = Number(partition?.partitionSummary?.partialFailures);
	const sourceStatus = partition?.sourceStatusSummary;
	const nonCompleted = Number(sourceStatus?.nonCompleted);
	const total = Number(sourceStatus?.total);
	const completed = Number(sourceStatus?.completed);
	return Boolean(
		asArray(sourceStatus?.partialFailures).length > 0 ||
			asArray(partition?.reportContext?.partialFailures).length > 0 ||
			(Number.isFinite(summaryCount) && summaryCount > 0) ||
			(Number.isFinite(nonCompleted) && nonCompleted > 0) ||
			(Number.isFinite(total) &&
				Number.isFinite(completed) &&
				completed < total),
	);
}

function requiredReportVerdict(partition, findings) {
	if (hasPartialFailures(partition)) return "PARTIAL_REVIEW";
	const requiredLedgers = [partition?.reviewerLedger, partition?.dedupSummary, partition?.verifierCoverage];
	if (requiredLedgers.some((ledger) => !ledger || typeof ledger !== "object" || ledger.complete !== true))
		return "NEEDS_WORK";
	const ledger = partition?.partitions ?? partition?.reportContext;
	const summary = partition?.partitionSummary;
	const integrityCounts = [
		summary?.batchIntegrityIssues,
		summary?.verdictIntegrityIssues,
		summary?.reviewerCoverageIssues,
		summary?.missingVerdicts,
	].some((value) => Number(value) > 0);
	const reviewer = partition?.reviewerLedger;
	const reviewerGap = reviewer &&
		(asArray(reviewer.missingPlannedLensIds).length > 0 ||
			asArray(reviewer.unexpectedMaterializedReviewerIds).length > 0 ||
			asArray(reviewer.invalidAttestations).length > 0);
	const verifier = partition?.verifierCoverage;
	const verifierGap = verifier &&
		(asArray(verifier.missingFindingIds).length > 0 ||
			asArray(verifier.orphanFindingIds).length > 0 ||
			asArray(verifier.duplicateFindingIds).length > 0);
	if (integrityCounts || reviewerGap || verifierGap) return "NEEDS_WORK";
	if (findings.length > 0 || asArray(ledger?.needsHuman).length > 0)
		return "NEEDS_WORK";
	return "REVIEW_COMPLETE";
}

function deterministicSummary(partition, findings) {
	const ledger = partition?.partitions ?? partition?.reportContext;
	const needsHuman = asArray(ledger?.needsHuman).length;
	if (hasPartialFailures(partition)) {
		return `Review coverage is partial. The deterministic ledger contains ${findings.length} kept or weakened findings and ${needsHuman} needs-human items.`;
	}
	if (findings.length > 0 || needsHuman > 0) {
		return `The deterministic ledger contains ${findings.length} kept or weakened findings and ${needsHuman} needs-human items.`;
	}
	return "The deterministic ledger contains no kept, weakened, or needs-human findings.";
}

function deterministicNextAction(verdict) {
	if (verdict === "PARTIAL_REVIEW")
		return "Complete failed or missing review work, then rerun the review before release.";
	if (verdict === "NEEDS_WORK")
		return "Address kept or weakened findings and resolve needs-human items before release.";
	return "No reportable remediation remains in the deterministic review ledger.";
}

function completionLimitations({
	reportAvailable,
	reportVerdictConsistent,
	partition,
	findingCountMismatch,
	needsHumanCountMismatch,
	needsHumanMetadataMissing,
	needsHumanEvidenceIncomplete,
	supportNoteCountMismatch,
	supportNoteMetadataMissing,
	supportNoteEvidenceIncomplete,
}) {
	const limitations = [];
	if (hasPartialFailures(partition))
		limitations.push("Review coverage is partial because one or more sources did not complete.");
	if (!reportAvailable)
		limitations.push("Executive synthesis was unavailable, so no complete review conclusion can be claimed.");
	else if (!reportVerdictConsistent)
		limitations.push("Executive synthesis contradicted the deterministic verdict and was rejected.");
	if (findingCountMismatch)
		limitations.push("The declared finding count does not match the available finding rows.");
	if (needsHumanMetadataMissing || needsHumanCountMismatch)
		limitations.push("Needs-human metadata or row counts are incomplete or inconsistent.");
	if (needsHumanEvidenceIncomplete)
		limitations.push("At least one needs-human row lacks complete location or quote evidence.");
	if (supportNoteMetadataMissing || supportNoteCountMismatch)
		limitations.push("Supporting-observation metadata or row counts are incomplete or inconsistent.");
	if (supportNoteEvidenceIncomplete)
		limitations.push("At least one supporting observation lacks complete location or quote evidence.");
	return [...new Set(limitations)];
}

function renderCompletionSummary({
	reportAvailable,
	effectiveVerdict,
	partition,
	findings,
	limitations,
}) {
	const ledger = partition?.partitions ?? partition?.reportContext;
	const needsHuman = asArray(ledger?.needsHuman);
	const supportNotes = asArray(partition?.supportNotes);
	const keyRows = [
		...findings.map((finding) => ({
			label: finding.verdict,
			severity: finding.severity,
			title: finding.title,
		})),
		...needsHuman.map((finding) => ({
			label: "NEEDS_HUMAN",
			severity: severityOf(finding),
			title: titleOf(finding),
		})),
	].slice(0, 6);
	const out = [
		"## Core conclusion",
		"",
		`Verdict: **${cleanText(reportAvailable ? effectiveVerdict : "report_synthesis_failed")}**. ${completionText(deterministicSummary(partition, findings))}`,
		"",
		"## Key findings",
		"",
	];
	if (keyRows.length === 0) {
		out.push("- No kept, weakened, or needs-human findings were present.");
	} else {
		for (const row of keyRows) {
			out.push(
				`- **${cleanText(row.severity)} / ${cleanText(row.label)}:** ${completionText(row.title)}`,
			);
		}
		const omitted = findings.length + needsHuman.length - keyRows.length;
		if (omitted > 0) out.push(`- ${omitted} additional finding row(s) are included in the full report.`);
	}
	out.push(
		"",
		"## Evidence level",
		"",
		`- Canonical rows: ${findings.length} kept or weakened findings, ${needsHuman.length} needs-human items, and ${supportNotes.length} supporting observations.`,
		`- Coverage: ${hasPartialFailures(partition) ? "partial" : "complete according to source-status accounting"}.`,
		"",
		"## Important limitations",
		"",
	);
	if (limitations.length === 0) {
		out.push("- No incomplete source coverage or renderer integrity limitation was recorded.");
	} else {
		for (const limitation of limitations.slice(0, 8)) {
			out.push(`- ${completionText(limitation)}`);
		}
		if (limitations.length > 8)
			out.push(`- ${limitations.length - 8} additional limitation(s) are detailed in the full report.`);
	}
	return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function renderEvidenceCoverage(partition, findings) {
	const ledger = partition?.partitions ?? partition?.reportContext;
	return [
		"## Evidence and review coverage",
		"",
		`- Canonical ledger rows rendered: ${findings.length} kept or weakened findings, ${asArray(ledger?.needsHuman).length} needs-human items, and ${asArray(partition?.supportNotes).length} supporting observations.`,
		`- Source coverage: ${hasPartialFailures(partition) ? "partial; see limitations below" : "complete according to deterministic source-status accounting"}.`,
		"- Finding cards preserve ledger locations, evidence quotes, verifier dispositions, counter-evidence, and recommended actions where present.",
		"- Counts, dispositions, and the effective verdict come from deterministic partition state; narrative synthesis cannot override them.",
		"",
	];
}

function renderLimitations(limitations) {
	return [
		"## Limitations",
		"",
		...(limitations.length > 0
			? limitations.map((limitation) => `- ${cleanText(limitation)}`)
			: ["- No incomplete source coverage or renderer integrity limitation was recorded."]),
		"",
	];
}

function renderRelatedArtifacts() {
	return [
		"## Related artifacts",
		"",
		"- [Machine-readable report](control.json) — structured renderer output and completion-summary contract.",
		"- [Structured source references](refs.json) — source pointers retained by the final workflow task.",
		"- [Legacy compatibility report](review.md) — byte-identical copy of this report.",
		"",
	];
}

function renderMarkdown({
	report,
	reportAvailable,
	reportVerdictConsistent,
	effectiveVerdict,
	partition,
	findingCountMismatch,
	needsHumanCountMismatch,
	needsHumanMetadataMissing,
	needsHumanEvidenceIncomplete,
	supportNoteCountMismatch,
	supportNoteMetadataMissing,
	supportNoteEvidenceIncomplete,
}) {
	const { all } = partitionFindings(partition);
	const sortedFindings = all.sort(
		(a, b) =>
			severityRank(a.severity) - severityRank(b.severity) ||
			a.findingId.localeCompare(b.findingId),
	);
	const rendered = renderFindings(sortedFindings);
	const representedIds = rendered.representedIds ?? [];
	const renderedNeedsHuman = renderNeedsHuman(partition);
	const renderedDropped = renderDropped(partition);
	const renderedSupportNotes = renderSupportNotes(partition);
	const limitations = completionLimitations({
		reportAvailable,
		reportVerdictConsistent,
		partition,
		findingCountMismatch,
		needsHumanCountMismatch,
		needsHumanMetadataMissing,
		needsHumanEvidenceIncomplete,
		supportNoteCountMismatch,
		supportNoteMetadataMissing,
		supportNoteEvidenceIncomplete,
	});
	const completionSummaryMarkdown = renderCompletionSummary({
		reportAvailable,
		effectiveVerdict,
		partition,
		findings: sortedFindings,
		limitations,
	});
	const executiveSummary = completionSummaryMarkdown.replace(/^## /gm, "### ");
	const lines = [
		"# Deep review report",
		"",
		"## Executive summary",
		"",
		executiveSummary,
		"",
		...renderSeveritySummary(sortedFindings),
	];
	if (reportAvailable && !reportVerdictConsistent) {
		lines.push(
			"## Renderer warning",
			"",
			`The narrative verdict ${inlineCode(report.verdict)} contradicted the deterministic ledger and was rendered conservatively as ${inlineCode(effectiveVerdict)}.`,
			"",
		);
	}
	if (needsHumanMetadataMissing) {
		lines.push(
			"## Renderer warning",
			"",
			"The canonical partition ledger omitted required needs-human metadata. Inspect the detailed ledger evidence before acting on this report.",
			"",
		);
	}
	if (needsHumanEvidenceIncomplete) {
		lines.push(
			"## Renderer warning",
			"",
			"At least one needs-human finding lacked a usable location or non-blank evidence quote. Inspect the detailed ledger evidence before acting on this report.",
			"",
		);
	}
	if (needsHumanCountMismatch) {
		lines.push(
			"## Renderer warning",
			"",
			"The deterministic renderer found a mismatch between the declared and available needs-human counts. Inspect the detailed ledger evidence before acting on this report.",
			"",
		);
	}
	if (supportNoteMetadataMissing) {
		lines.push(
			"## Renderer warning",
			"",
			"The canonical partition ledger omitted required support-note metadata. Inspect the detailed ledger evidence before acting on this report.",
			"",
		);
	}
	if (supportNoteEvidenceIncomplete) {
		lines.push(
			"## Renderer warning",
			"",
			"At least one supporting observation lacked a usable location or non-blank evidence quote. Inspect the detailed ledger evidence before acting on this report.",
			"",
		);
	}
	if (supportNoteCountMismatch) {
		lines.push(
			"## Renderer warning",
			"",
			"The deterministic renderer found a mismatch between the declared and available support-note counts. Inspect the detailed ledger evidence before acting on this report.",
			"",
		);
	}
	if (findingCountMismatch) {
		lines.push(
			"## Renderer warning",
			"",
			"The deterministic renderer found a mismatch between expected findings and represented finding IDs. Inspect the detailed ledger evidence before acting on this report.",
			"",
		);
	}
	lines.push(...(rendered.lines ?? rendered));
	lines.push(...renderedDropped.lines);
	lines.push(...renderedSupportNotes.lines);
	lines.push(...renderedNeedsHuman.lines);
	const nextAction = deterministicNextAction(effectiveVerdict);
	if (nextAction) {
		lines.push("## Recommended next action", "", nextAction, "");
	}
	lines.push(...renderEvidenceCoverage(partition, sortedFindings));
	lines.push(...renderLimitations(limitations));
	lines.push(...renderRelatedArtifacts());
	return {
		markdown: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
		completionSummaryMarkdown,
		representedIds,
		representedNeedsHumanIds: renderedNeedsHuman.representedIds,
		representedDroppedIds: renderedDropped.representedIds,
		representedSupportRows: renderedSupportNotes.representedRows,
		emissionRows: structuredEmissionRows(partition),
	};
}

function blockedRenderResult(reason) {
	return {
		schema: "deep-review-render-v1",
		digest: `Deep review rendering blocked: ${reason}`,
		status: "blocked",
		blockers: [reason],
		markdown: "",
		completionSummaryMarkdown: "",
		findingSummary: { total: 0, bySeverity: {} },
		renderedFindingIds: [],
		renderedNeedsHumanIds: [],
		sourceArtifacts: [],
		gates: {
			renderedAllFindings: false,
			renderedAllNeedsHuman: false,
			renderedAllSupportNotes: false,
			findingCountMismatch: true,
			needsHumanCountMismatch: true,
			needsHumanMetadataMissing: true,
			needsHumanEvidenceIncomplete: true,
			reportSynthesisAvailable: false,
			reportVerdictConsistent: false,
			supportNoteCountMismatch: true,
			supportNoteMetadataMissing: true,
			supportNoteEvidenceIncomplete: true,
			supportProvenanceValid: false,
			passed: false,
		},
	};
}

export default async function renderReviewReport({ sources, context = {} }) {
	let partition;
	let report;
	try {
		partition = findSource(sources, "partition-verdicts");
		report = findSource(sources, "report");
	} catch (error) {
		return blockedRenderResult(error instanceof Error ? error.message : String(error));
	}
	const reportAvailable = hasReportSynthesis(report);
	if (!partition || typeof partition !== "object") {
		return {
			schema: "deep-review-render-v1",
			digest:
				"Deep review rendering failed: missing partition-verdicts control source.",
			status: "blocked",
			blockers: ["missing partition-verdicts control source"],
			markdown: "",
			completionSummaryMarkdown: "",
			findingSummary: { total: 0, bySeverity: {} },
			renderedFindingIds: [],
			renderedNeedsHumanIds: [],
			sourceArtifacts: [],
			gates: {
				renderedAllFindings: false,
				renderedAllNeedsHuman: false,
				renderedAllSupportNotes: false,
				findingCountMismatch: true,
				needsHumanCountMismatch: true,
				needsHumanMetadataMissing: true,
				needsHumanEvidenceIncomplete: true,
				reportSynthesisAvailable: false,
				reportVerdictConsistent: false,
				supportNoteCountMismatch: true,
				supportNoteMetadataMissing: true,
				supportNoteEvidenceIncomplete: true,
				supportProvenanceValid: false,
				passed: false,
			},
		};
	}

	const { all } = partitionFindings(partition);
	const idAudit = ledgerIdAudit(partition);
	const {
		rawReviewerIds,
		dedupIds,
		rawReviewerIdsMissing,
		dedupIdsMissing,
		rawReviewerIdsMismatch,
		dedupIdsMismatch,
		rawCountMismatch,
		uniqueCountMismatch,
		reviewerCoverageReconciled,
		reviewerMissingLensIds,
		reviewerUnexpectedIds,
		reviewerDuplicateIds,
		verifierCoverageExact,
		verifierDigestMatches,
		verifierRowIds,
		verifierMissingIds,
		verifierOrphanIds,
		verifierDuplicateIds,
		verifierOwnershipIssues,
		duplicateCountMismatch,
		duplicateLedgerReconciled,
		duplicateLedgerPairsMismatch,
		duplicateLedgerIssues,
		rawDuplicateIdsMissing,
		rawDuplicateLineageIssues,
		independentlyDispositionedRawDuplicates,
		duplicateLedgerRawIdsMismatch,
		verdictsReceivedMismatch,
		partitionVerdictsReceived,
		verifierVerdictsReceived,
		reviewerDedupReconciled,
		expectedVerifierIds,
		verifierExpectedMismatch,
		ledgerCompleteness,
		requiredLedgersPresent,
		idLedgerExact,
		provenanceOwnerIssues,
		supportRelationIssues,
		reviewerMissingAttestedLensIds,
		reviewerUnexpectedAttestedIds,
		verifierDeclaredRowsMismatch,
		verifierStatusIssues,
		reviewerOwnerMapIssues,
		reviewerFindingOwnerIssues,
		supportProvenanceIssues,
		supportIds,
	} = idAudit;
	const expected = expectedFindingCount(partition, all);
	const findingCountMismatch = expected !== all.length;
	const needsHuman = needsHumanCounts(partition);
	const needsHumanCountMismatch = needsHuman.expected !== needsHuman.actual;
	const needsHumanMetadataMissing = needsHuman.metadataMissing;
	const needsHumanEvidenceIncomplete = needsHuman.incompleteEvidence > 0;
	const supportNotes = supportNoteCounts(partition);
	const supportNoteCountMismatch = supportNotes.expected !== supportNotes.actual;
	const supportNoteMetadataMissing = supportNotes.metadataMissing;
	const supportNoteEvidenceIncomplete = supportNotes.incompleteEvidence > 0;
	const effectiveVerdict = requiredReportVerdict(partition, all);
	const reportVerdictConsistent =
		reportAvailable && cleanText(report.verdict) === effectiveVerdict;
	const rendered = renderMarkdown({
		report: report ?? {},
		reportAvailable,
		reportVerdictConsistent,
		effectiveVerdict,
		partition,
		findingCountMismatch,
		needsHumanCountMismatch,
		needsHumanMetadataMissing,
		needsHumanEvidenceIncomplete,
		supportNoteCountMismatch,
		supportNoteMetadataMissing,
		supportNoteEvidenceIncomplete,
	});
	const bySeverity = severityCounts(all);
	const renderedAllFindings = rendered.representedIds.length === all.length;
	const renderedAllNeedsHuman =
		rendered.representedNeedsHumanIds.length === needsHuman.actual;
	const renderedAllSupportNotes =
		rendered.representedSupportRows === supportNotes.actual;
	const droppedCount = asArray((partition.partitions ?? partition.reportContext)?.drop).length;
	const renderedAllDropped = rendered.representedDroppedIds.length === droppedCount;
	const renderedDispositionIds = [
		...rendered.representedIds,
		...rendered.representedDroppedIds,
		...rendered.representedNeedsHumanIds,
	];
	const renderedAllTopLevel =
		renderedDispositionIds.length === idAudit.topLevelIds.length &&
		renderedDispositionIds.every((id) => idAudit.topLevelIds.includes(id));
	const renderedLineageIds = idAudit.lineageIds.filter((id) => Boolean(id));
	const expectedEmissionRows = [
		...idAudit.topLevelIds.filter(Boolean).map((id) => ({ kind: "top-level", id })),
		...idAudit.lineageIds.filter(Boolean).map((id) => ({ kind: "lineage", id })),
		...(supportNotes.actual > 0
			? asArray(partition.supportNotes)
				.map((note, index) => supportEmissionRow(note, index))
				.filter((row) => row.id)
			: []),
	];
	const emittedEmissionRows = rendered.emissionRows ?? [];
	const renderedAllLineage = sameEmissionRows(
		expectedEmissionRows.filter((row) => row.kind === "lineage"),
		emittedEmissionRows.filter((row) => row.kind === "lineage"),
	);
	const uniqueLedgerIds =
		idAudit.uniqueIds.size ===
		idAudit.topLevelIds.length +
		idAudit.supportIds.length +
		idAudit.lineageIds.length;
	const passed =
		!findingCountMismatch &&
		!idAudit.topLevelCountMismatch &&
		!idAudit.mergedCountMismatch &&
		!duplicateCountMismatch &&
		!verdictsReceivedMismatch &&
		sameEmissionRows(expectedEmissionRows, emittedEmissionRows) &&
		idAudit.duplicateIds.length === 0 &&
		uniqueLedgerIds &&
		reviewerDedupReconciled &&
		!rawReviewerIdsMismatch &&
		!dedupIdsMismatch &&
		!rawCountMismatch &&
		!uniqueCountMismatch &&
		requiredLedgersPresent &&
		ledgerCompleteness &&
		idLedgerExact &&
		reviewerCoverageReconciled &&
		verifierCoverageExact &&
		renderedAllLineage &&
		renderedAllTopLevel &&
		renderedAllDropped &&
		!needsHumanCountMismatch &&
		!needsHumanMetadataMissing &&
		!needsHumanEvidenceIncomplete &&
		!supportNoteCountMismatch &&
		!supportNoteMetadataMissing &&
		!supportNoteEvidenceIncomplete &&
		supportProvenanceIssues.length === 0 &&
		renderedAllFindings &&
		renderedAllNeedsHuman &&
		renderedAllSupportNotes &&
		reportAvailable &&
		reportVerdictConsistent;

	let sidecarPath;
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
			const payload = `${rendered.markdown}\n`;
			await writeFile(join(taskDir, "final-report.md"), payload, "utf8");
			await writeFile(join(taskDir, "review.md"), payload, "utf8");
			sidecarPath = "final-report.md";
		}
	} catch {
		// Sidecar is non-authoritative; keep control output deterministic.
	}

	return {
		schema: "deep-review-render-v1",
		digest: `Rendered ${all.length} findings: ${
			Object.entries(bySeverity)
				.sort(
					([a], [b]) => severityRank(a) - severityRank(b) || a.localeCompare(b),
				)
				.map(([severity, count]) => `${severity}=${count}`)
				.join(", ") || "none"
		}.`,
		status: passed ? "passed" : "failed",
		completionSummaryMarkdown: passed ? rendered.completionSummaryMarkdown : "",
		markdown: rendered.markdown,
		findingSummary: { total: all.length, bySeverity },
		renderedFindingIds: rendered.representedIds,
		renderedNeedsHumanIds: rendered.representedNeedsHumanIds,
		renderedDroppedIds: rendered.representedDroppedIds,
		renderedLineageIds,
		emissionRows: emittedEmissionRows,
		expectedEmissionRows,
		expectedFindingCount: expected,
		rawReviewerFindingIds: rawReviewerIds,
		dedupFindingIds: dedupIds,
		rawDuplicateLineageIssues,
		independentlyDispositionedRawDuplicates,
		duplicateLedgerRawIdsMismatch,
		verdictsReceived: verifierVerdictsReceived,
		verifierCoverage: {
			expectedFindingIds: expectedVerifierIds,
			verdictFindingIds: verifierRowIds,
			missingFindingIds: [...new Set(verifierMissingIds)],
			orphanFindingIds: [...new Set(verifierOrphanIds)],
			duplicateFindingIds: [...new Set(verifierDuplicateIds)],
			ownershipIssues: verifierOwnershipIssues.map((row) => row.sourceId ?? ""),
			statusIssues: verifierStatusIssues.map((status) => status.source ?? status.specId ?? ""),
		},
		expectedMergedFindingCount: idAudit.expectedMerged,
		mergedFindingCount: idAudit.mergedCount,
		needsHumanSummary: needsHuman,
		supportNoteSummary: supportNotes,
		sourceArtifacts: [
			"partition-verdicts.control.json",
			...(reportAvailable ? ["report.control.json"] : []),
		],
		gates: {
			renderedAllFindings,
			renderedAllNeedsHuman,
			renderedAllSupportNotes,
			findingCountMismatch,
			duplicateCountMismatch,
			duplicateLedgerReconciled,
			duplicateLedgerPairsMismatch,
			duplicateLedgerIssues,
			rawDuplicateIdsMissing,
			rawDuplicateLineageIssues,
			independentlyDispositionedRawDuplicates,
			duplicateLedgerRawIdsMismatch,
			verdictsReceivedMismatch,
			partitionVerdictsReceived,
			verifierVerdictsReceived,
			ledgerTopLevelCountMismatch: idAudit.topLevelCountMismatch,
			uniqueLedgerIds,
			duplicateLedgerIds: idAudit.duplicateIds,
			mergedFindingCountMismatch: idAudit.mergedCountMismatch,
			rawReviewerFindingIdsMissing: rawReviewerIdsMissing,
			dedupFindingIdsMissing: dedupIdsMissing,
			rawReviewerIdsMismatch,
			dedupIdsMismatch,
			rawCountMismatch,
			uniqueCountMismatch,
			reviewerCoverageReconciled,
			requiredLedgersPresent,
			ledgerCompleteness,
			idLedgerExact,
			provenanceOwnerIssues: provenanceOwnerIssues.map((finding) => findingIdOf(finding, 0)),
			supportRelationIssues: supportRelationIssues.map((finding) => findingIdOf(finding, 0)),
			reviewerFindingOwnerIssues: reviewerFindingOwnerIssues.map((finding) => findingIdOf(finding, 0)),
			verifierExpectedMismatch,
			verifierDeclaredRowsMismatch,
			verifierStatusIssues: verifierStatusIssues.map((status) => status.source ?? status.specId ?? ""),
			reviewerOwnerMapIssues: reviewerOwnerMapIssues.map((owner) => owner?.source ?? ""),
			reviewerMissingAttestedLensIds,
			reviewerUnexpectedAttestedIds,
			reviewerMissingLensIds,
			reviewerUnexpectedIds,
			reviewerDuplicateIds,
			verifierCoverageExact,
			verifierDigestMatches,
			verifierExpectedMismatch,
			verifierDeclaredRowsMismatch,
			verifierMissingIds: [...new Set(verifierMissingIds)],
			verifierOrphanIds: [...new Set(verifierOrphanIds)],
			verifierDuplicateIds: [...new Set(verifierDuplicateIds)],
			verifierOwnershipIssues: verifierOwnershipIssues.map((row) => row.sourceId ?? ""),
			renderedAllLineage,
			renderedAllTopLevel,
			renderedAllDropped,
			needsHumanCountMismatch,
			needsHumanMetadataMissing,
			needsHumanEvidenceIncomplete,
			reportSynthesisAvailable: reportAvailable,
			reportVerdictConsistent,
			supportNoteCountMismatch,
			supportNoteMetadataMissing,
			supportNoteEvidenceIncomplete,
			supportProvenanceIssues: supportProvenanceIssues.map((finding) => findingIdOf(finding, 0)),
			supportProvenanceValid: supportProvenanceIssues.length === 0,
			passed,
		},
		...(sidecarPath ? { sidecarPath } : {}),
	};
}
