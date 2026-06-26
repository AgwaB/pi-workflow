// Deterministic compact input packet for deep-research final-audit.
//
// This helper performs mechanical joins only: it copies plan metadata,
// normalize-claims ledgers, and audit-claims verdict partitions into a compact
// packet. It does not choose truth, promote/downgrade claims, or write final
// recommendations. The final-audit LLM remains responsible for synthesis while
// consuming these code-computed ledgers as ground truth for counts and buckets.

const SCHEMA = "deep-research-final-audit-packet-v1";

function findSource(sources, stageId) {
	for (const [specId, source] of Object.entries(sources ?? {})) {
		if (specId === stageId || specId.startsWith(`${stageId}.`)) return source;
	}
	return null;
}

function asArray(value) {
	return Array.isArray(value) ? value : [];
}

function asObject(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringOf(value) {
	return typeof value === "string" ? value : undefined;
}

function idOf(value) {
	return stringOf(value?.id) ?? stringOf(value?.claimId) ?? null;
}

function compactStrings(values, limit = 5) {
	if (!Array.isArray(values)) return [];
	const seen = new Set();
	const out = [];
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

function compactClaimDigest(claim) {
	const digest = asObject(claim);
	return {
		id: idOf(digest),
		claim: stringOf(digest.claim),
		status: stringOf(digest.status ?? digest.verdict),
		confidence: stringOf(digest.confidence),
		factSlotIds: compactStrings(digest.factSlotIds, 12),
		sourceRefs: compactStrings(digest.sourceRefs, 8),
		sourceUrls: compactStrings(digest.sourceUrls, 8),
		support: stringOf(digest.verdictDigest?.support ?? digest.verdictDigest?.summary ?? digest.verdictDigest),
		caveat: stringOf(digest.verdictDigest?.caveat ?? digest.caveat),
		correctionOrCounterclaim: stringOf(digest.correctionOrCounterclaim),
		...(digest.evidenceGate ? { evidenceGate: digest.evidenceGate } : {}),
	};
}

function compactSlot(slot) {
	const item = asObject(slot);
	return {
		slotId: stringOf(item.slotId ?? item.id),
		label: stringOf(item.label),
		status: stringOf(item.status),
		bestValue: item.bestValue,
		sourceUrls: compactStrings(item.sourceUrls, 6),
		sourceQuality: stringOf(item.sourceQuality),
		verificationCandidateIds: compactStrings(item.verificationCandidateIds, 8),
		gapReason: stringOf(item.gapReason),
		parentImpact: stringOf(item.parentImpact),
	};
}

function compactGap(gap) {
	const item = asObject(gap);
	return {
		claimId: stringOf(item.claimId),
		slotId: stringOf(item.slotId),
		evidenceState: stringOf(item.evidenceState),
		reason: stringOf(item.reason ?? item.gapReason),
		nextStep: stringOf(item.nextStep),
		sourceUrls: compactStrings(item.sourceUrls, 6),
		relatedFactSlotIds: compactStrings(item.relatedFactSlotIds, 8),
		scopeItem: stringOf(item.scopeItem),
		whyItMatters: stringOf(item.whyItMatters),
	};
}

function compactVerifierIssue(issue) {
	const item = asObject(issue);
	return {
		sourceId: stringOf(item.sourceId),
		claimId: stringOf(item.claimId),
		reason: stringOf(item.reason),
		status: stringOf(item.status),
		nextStep: stringOf(item.nextStep),
	};
}

function compactDuplicateVerifierRow(row) {
	const item = asObject(row);
	return {
		claimId: stringOf(item.claimId),
		rowCount: Number.isFinite(Number(item.rowCount)) ? Number(item.rowCount) : undefined,
		sourceIds: compactStrings(item.sourceIds, 8),
		statusInputs: compactStrings(item.statusInputs, 8),
		selectedStatus: stringOf(item.selectedStatus),
		statusConflict: item.statusConflict === true,
		action: stringOf(item.action),
	};
}

function countByStatus(slots) {
	const counts = {};
	for (const slot of slots) {
		const status = stringOf(slot.status) ?? "unknown";
		counts[status] = (counts[status] ?? 0) + 1;
	}
	return counts;
}

export default async function finalAuditPacket({ sources }) {
	const plan = asObject(findSource(sources, "plan"));
	const normalized = asObject(findSource(sources, "normalize-claims"));
	const audit = asObject(findSource(sources, "audit-claims"));
	const claimInventory = asObject(normalized.claimInventory);
	const verificationCandidates = asArray(claimInventory.verificationCandidates);
	const preservedClaims = asArray(claimInventory.preservedClaims);
	const claimDigests = asArray(audit.claimDigests);
	const auditedIds = new Set(claimDigests.map(idOf).filter(Boolean));
	const candidateIds = verificationCandidates.map(idOf).filter(Boolean);
	const omittedCandidateIds = candidateIds.filter((id) => !auditedIds.has(id));
	const factSlotCoverage = asArray(normalized.factSlotCoverage).map(compactSlot);
	const coverageGaps = asArray(normalized.coverageGaps).map(compactGap);
	const remainingGaps = asArray(audit.remainingGaps).map(compactGap);
	const sourceRefJoinFailures = asArray(audit.sourceRefJoinFailures).map(compactGap);
	const invalidVerifierRows = asArray(audit.invalidVerifierRows).map(compactVerifierIssue);
	const duplicateVerifierRows = asArray(audit.duplicateVerifierRows).map(compactDuplicateVerifierRow);
	const gateSummary = asObject(audit.gateSummary);
	const sourceRefCoverage = {
		verificationCandidatesWithSourceRefs: verificationCandidates.filter(
			(candidate) => compactStrings(candidate?.sourceRefs, 1).length > 0,
		).length,
		auditedClaimsWithSourceRefs: claimDigests.filter(
			(claim) => compactStrings(claim?.sourceRefs, 1).length > 0,
		).length,
		sourceRefJoinFailures: sourceRefJoinFailures.length,
	};

	return {
		schema: SCHEMA,
		packet: {
			researchMetadataSeed: {
				depth: stringOf(plan.depth),
				taskType: stringOf(plan.taskType),
				expectedFinalShape: stringOf(plan.expectedFinalShape),
				researchQuestions: asArray(plan.researchQuestions).length,
				sourcePolicy: asObject(plan.sourcePolicy),
				plannedFactSlots: asArray(plan.factSlots).length,
				filledFactSlots: factSlotCoverage.filter((slot) => slot.status === "filled").length,
				partialFactSlots: factSlotCoverage.filter((slot) => slot.status === "partial").length,
				missingFactSlots: factSlotCoverage.filter((slot) => slot.status === "missing").length,
			},
			verdictCounts: asObject(audit.verdictCounts),
			statusPartitions: asObject(audit.statusPartitions),
			factSlotCoverage,
			factSlotStatusCounts: countByStatus(factSlotCoverage),
			coverageGaps,
			remainingGaps,
			sourceRefJoinFailures,
			claimVerdictLedger: claimDigests.map(compactClaimDigest),
			verifierIntegrity: {
				gateSummary,
				invalidVerifierRows,
				duplicateVerifierRows,
			},
			preservedClaims: preservedClaims.map((claim) => ({
				id: idOf(claim),
				claim: stringOf(claim.claim),
				factSlotIds: compactStrings(claim.factSlotIds, 8),
				sourceRefs: compactStrings(claim.sourceRefs, 6),
				sourceUrls: compactStrings(claim.sourceUrls, 6),
				whyItMatters: stringOf(claim.whyItMatters ?? claim.reason),
			})),
			researchScopeCoverage: asArray(normalized.researchScopeCoverage),
			invariantChecks: {
				candidateCount: verificationCandidates.length,
				auditedClaimCount: claimDigests.length,
				omittedCandidateIds,
				droppedSlotIds: asArray(audit.slotCoverageCheck?.droppedSlotIds),
				sourceRefCoverage,
				verifierIntegrity: {
					invalidVerifierRows: invalidVerifierRows.length,
					duplicateVerifierRows: duplicateVerifierRows.length,
					missingVerifierResults: Number(gateSummary.missingVerifierResults ?? 0),
				},
			},
			overflowLedger: {
				preservedClaimCount: preservedClaims.length,
				coverageGapCount: coverageGaps.length,
				remainingGapCount: remainingGaps.length,
				omittedVerificationCandidateCount: omittedCandidateIds.length,
				invalidVerifierRowCount: invalidVerifierRows.length,
				duplicateVerifierRowCount: duplicateVerifierRows.length,
			},
		},
	};
}
