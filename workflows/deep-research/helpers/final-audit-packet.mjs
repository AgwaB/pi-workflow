// Deterministic compact input packet for deep-research final-audit.
//
// This helper performs mechanical joins only: it copies plan metadata,
// normalize-claims ledgers, and audit-claims verdict partitions into a compact
// packet. It does not choose truth, promote/downgrade claims, or write final
// recommendations. The final-audit LLM remains responsible for synthesis while
// consuming these code-computed ledgers as ground truth for counts and buckets.

const SCHEMA = "deep-research-final-audit-packet-v1";

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

function asObject(value) {
	return value && typeof value === "object" && !Array.isArray(value)
		? value
		: {};
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

function truncateText(value, limit = 240) {
	const text = stringOf(value);
	if (!text) return undefined;
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= limit) return normalized;
	return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
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
		...(digest.verifierOwner ? { verifierOwner: compactOwner(digest.verifierOwner) } : {}),
		support: stringOf(
			digest.verdictDigest?.support ??
				digest.verdictDigest?.summary ??
				digest.verdictDigest,
		),
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

function reconcileFactSlotCoverageWithAudit(factSlots, claimDigests) {
	const claimsBySlot = new Map();
	for (const claim of claimDigests) {
		for (const slotId of compactStrings(claim.factSlotIds, 12)) {
			const claims = claimsBySlot.get(slotId) ?? [];
			claims.push(claim);
			claimsBySlot.set(slotId, claims);
		}
	}
	return factSlots.map((slot) => {
		const claims = claimsBySlot.get(slot.slotId) ?? [];
		if (claims.length === 0) return slot;
		const statuses = new Set(claims.map((claim) => stringOf(claim.status)));
		const claimIds = compactStrings(claims.map(idOf), 12);
		if (statuses.has("conflicting")) {
			const corrections = compactStrings(
				claims.map((claim) => claim.correctionOrCounterclaim),
				4,
			);
			const reason = `audited claim status is conflicting${claimIds.length ? ` (${claimIds.join(", ")})` : ""}`;
			return {
				...slot,
				status: "conflicting",
				// Preserve the audited correction for final-report consumers; status,
				// rather than bestValue presence, remains the coverage authority.
				bestValue:
					corrections.join(" | ") ||
					"Verifier evidence conflicts with the normalized value; see claim ledger.",
				gapReason: slot.gapReason
					? `${slot.gapReason}; ${reason}`
					: reason,
			};
		}
		if (
			!statuses.has("verified") &&
			slot.status === "filled" &&
			["partially_supported", "unsupported", "verification_blocked"].some(
				(status) => statuses.has(status),
			)
		) {
			const reason = `no audited verified claim${claimIds.length ? ` (${claimIds.join(", ")})` : ""}`;
			return {
				...slot,
				status: "partial",
				gapReason: slot.gapReason
					? `${slot.gapReason}; ${reason}`
					: reason,
			};
		}
		return slot;
	});
}

function compactGap(gap) {
	const item = asObject(gap);
	return {
		id: stringOf(item.id ?? item.gapId),
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

function compactInvalidNormalizedCandidate(row) {
	const item = asObject(row);
	return {
		index: Number.isSafeInteger(Number(item.index)) ? Number(item.index) : undefined,
		claimId: stringOf(item.claimId),
		reason: stringOf(item.reason),
		nextStep: stringOf(item.nextStep),
	};
}

function compactOwner(owner) {
	const item = asObject(owner);
	return {
		source: stringOf(item.source),
		stageId: stringOf(item.stageId),
		specId: stringOf(item.specId),
		taskId: stringOf(item.taskId),
		itemIdentity: stringOf(item.itemIdentity),
		placeholderSpecId: stringOf(item.placeholderSpecId),
		...(stringOf(item.batchId) ? { batchId: stringOf(item.batchId) } : {}),
		status: stringOf(item.status),
	};
}

function compactDuplicateVerifierRow(row) {
	const item = asObject(row);
	return {
		claimId: stringOf(item.claimId),
		rowCount: Number.isFinite(Number(item.rowCount))
			? Number(item.rowCount)
			: undefined,
		sourceIds: compactStrings(item.sourceIds, 8),
		statusInputs: compactStrings(item.statusInputs, 8),
		selectedStatus: stringOf(item.selectedStatus),
		statusConflict: item.statusConflict === true,
		action: stringOf(item.action),
	};
}

function compactReadinessBlocker(blocker) {
	const item = asObject(blocker);
	return {
		reason: stringOf(item.reason),
		count: Number.isFinite(Number(item.count)) ? Number(item.count) : undefined,
	};
}

function compactBatchAdoptionReadiness(readiness) {
	const item = asObject(readiness);
	const blockers = asArray(item.blockers).map(compactReadinessBlocker);
	if (!stringOf(item.status) && blockers.length === 0) return {};
	return {
		status: stringOf(item.status),
		...(typeof item.adopted === "boolean" ? { adopted: item.adopted } : {}),
		...(typeof item.canaryRequired === "boolean"
			? { canaryRequired: item.canaryRequired }
			: {}),
		reason: stringOf(item.reason),
		blockers,
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

function withGeneratedIds(items, prefix) {
	return items.map((item, index) => ({
		...item,
		id: stringOf(item.id) ?? `${prefix}-${String(index + 1).padStart(3, "0")}`,
	}));
}

function synthesisClaimDigest(claim) {
	const item = compactClaimDigest(claim);
	return {
		id: item.id,
		claim: truncateText(item.claim, 260),
		status: item.status,
		confidence: item.confidence,
		factSlotIds: compactStrings(item.factSlotIds, 8),
		support: truncateText(item.support, 240),
		caveat: truncateText(item.caveat, 180),
		correctionOrCounterclaim: truncateText(item.correctionOrCounterclaim, 180),
		hasSourceUrls: compactStrings(item.sourceUrls, 1).length > 0,
		hasSourceRefs: compactStrings(item.sourceRefs, 1).length > 0,
	};
}

function synthesisFactSlot(slot) {
	const item = asObject(slot);
	return {
		slotId: stringOf(item.slotId),
		label: truncateText(item.label, 120),
		status: stringOf(item.status),
		gapReason: truncateText(item.gapReason, 120),
		parentImpact: truncateText(item.parentImpact, 120),
	};
}

function synthesisGap(gap) {
	const item = asObject(gap);
	return {
		id: stringOf(item.id),
		kind: stringOf(item.kind),
		claimId: stringOf(item.claimId),
		slotId: stringOf(item.slotId),
		evidenceState: stringOf(item.evidenceState),
		reason: truncateText(item.reason, 220),
		nextStep: truncateText(item.nextStep, 180),
		scopeItem: truncateText(item.scopeItem, 160),
		whyItMatters: truncateText(item.whyItMatters, 180),
	};
}

function synthesisScopeCoverage(row) {
	const item = asObject(row);
	return {
		scopeItem: truncateText(item.scopeItem ?? item.item ?? item.topic, 160),
		status: stringOf(item.status ?? item.coverageStatus),
		evidenceState: stringOf(item.evidenceState),
		summary: truncateText(item.summary ?? item.reason, 220),
		whyItMatters: truncateText(item.whyItMatters, 180),
	};
}

function buildSynthesisInput({
	plan,
	factSlotCoverage,
	claimDigests,
	preservedClaims,
	coverageGaps,
	remainingGaps,
	sourceRefJoinFailures,
	researchScopeCoverage,
	integritySummary,
	audit,
}) {
	return {
		researchMetadata: {
			depth: stringOf(plan.depth),
			taskType: stringOf(plan.taskType),
			expectedFinalShape: stringOf(plan.expectedFinalShape),
			researchQuestions: asArray(plan.researchQuestions).length,
			plannedFactSlots: asArray(plan.factSlots).length,
		},
		verdictCounts: asObject(audit.verdictCounts),
		factSlotStatusCounts: countByStatus(factSlotCoverage),
		integritySummary,
		researchScopeCoverage: asArray(researchScopeCoverage)
			.slice(0, 24)
			.map(synthesisScopeCoverage),
		factSlots: factSlotCoverage.map(synthesisFactSlot),
		claims: claimDigests.map(synthesisClaimDigest),
		preservedClaims: preservedClaims.slice(0, 12).map((claim) => ({
			id: idOf(claim),
			claim: truncateText(claim.claim, 240),
			factSlotIds: compactStrings(claim.factSlotIds, 8),
			whyItMatters: truncateText(claim.whyItMatters ?? claim.reason, 180),
		})),
		gaps: [
			...remainingGaps.map((gap) =>
				synthesisGap({ ...gap, kind: "remaining" }),
			),
			...coverageGaps.map((gap) => synthesisGap({ ...gap, kind: "coverage" })),
			...sourceRefJoinFailures.map((gap) =>
				synthesisGap({ ...gap, kind: "sourceRefJoinFailure" }),
			),
		],
	};
}

export default async function finalAuditPacket({ sources }) {
	const plan = asObject(findSource(sources, "plan"));
	const normalizeClaims = asObject(findSource(sources, "normalize-claims"));
	const sanitizedCandidates = asObject(findSource(sources, "sanitize-claims"));
	const normalized =
		Object.keys(sanitizedCandidates).length > 0
			? sanitizedCandidates
			: normalizeClaims;
	const sanitizerDiagnostics = asObject(normalized.sanitizerDiagnostics);
	const auditSource = findSource(sources, "audit-claims");
	if (!auditSource || typeof auditSource !== "object" || Array.isArray(auditSource)) {
		throw new Error(
			"deep-research final-audit-packet: missing audit-claims control source; refusing to emit an empty packet",
		);
	}
	const audit = auditSource;
	// These fields establish that the audit stage actually ran and produced an
	// auditable ledger. Do not turn an absent/incomplete audit into a valid empty packet.
	const incompleteAuditFields = [
		["claimDigests", Array.isArray(audit.claimDigests)],
		["gateSummary", audit.gateSummary && typeof audit.gateSummary === "object" && !Array.isArray(audit.gateSummary)],
	].filter(([, present]) => !present).map(([field]) => field);
	const hasAuditLedger =
		Object.keys(audit.gateSummary ?? {}).length > 0 ||
		(audit.verdictCounts && typeof audit.verdictCounts === "object" && !Array.isArray(audit.verdictCounts) && Object.keys(audit.verdictCounts).length > 0) ||
		(audit.statusPartitions && typeof audit.statusPartitions === "object" && !Array.isArray(audit.statusPartitions) && Object.keys(audit.statusPartitions).length > 0);
	if (incompleteAuditFields.length === 0 && audit.claimDigests.length === 0 && !hasAuditLedger)
		incompleteAuditFields.push("audit ledgers");
	if (incompleteAuditFields.length > 0) {
		throw new Error(
			`deep-research final-audit-packet: incomplete audit-claims control (${incompleteAuditFields.join(", ")}); refusing to emit a valid empty packet`,
		);
	}
	const claimInventory = asObject(normalized.claimInventory);
	const verificationCandidates = asArray(claimInventory.verificationCandidates);
	const preservedClaims = asArray(claimInventory.preservedClaims);
	const claimDigests = asArray(audit.claimDigests).map(compactClaimDigest);
	const auditedIds = new Set(claimDigests.map(idOf).filter(Boolean));
	const candidateIds = verificationCandidates.map(idOf).filter(Boolean);
	const omittedCandidateIds = candidateIds.filter((id) => !auditedIds.has(id));
	const factSlotCoverage = reconcileFactSlotCoverageWithAudit(
		asArray(normalized.factSlotCoverage).map(compactSlot),
		claimDigests,
	);
	const coverageGaps = withGeneratedIds(
		asArray(normalized.coverageGaps).map(compactGap),
		"gap-coverage",
	);
	const remainingGaps = withGeneratedIds(
		asArray(audit.remainingGaps).map(compactGap),
		"gap-remaining",
	);
	const sourceRefJoinFailures = withGeneratedIds(
		asArray(audit.sourceRefJoinFailures).map(compactGap),
		"gap-source-ref",
	);
	const invalidVerifierRows = asArray(audit.invalidVerifierRows).map(
		compactVerifierIssue,
	);
	const duplicateVerifierRows = asArray(audit.duplicateVerifierRows).map(
		compactDuplicateVerifierRow,
	);
	const invalidNormalizedCandidateRows = asArray(
		audit.invalidNormalizedCandidates,
	).map(compactInvalidNormalizedCandidate);
	const verifierOwnerLedger = asArray(audit.verifierOwnerLedger).map(compactOwner);
	const verifierOwnerIssues = asArray(audit.verifierOwnerIssues).map(compactVerifierIssue);
	const gateSummary = asObject(audit.gateSummary);
	const batchAdoptionReadiness = compactBatchAdoptionReadiness(
		audit.batchAdoptionReadiness,
	);
	const zeroCandidateFloorBlockerInput = Number(
		gateSummary.zeroCandidateFloorBlockers ?? 0,
	);
	const zeroCandidateFloorBlockers = Number.isFinite(
		zeroCandidateFloorBlockerInput,
	)
		? zeroCandidateFloorBlockerInput
		: 0;
	const precisionGuardDiagnostics = asObject(audit.precisionGuardDiagnostics);
	const sourceRefCoverage = {
		verificationCandidatesWithSourceRefs: verificationCandidates.filter(
			(candidate) => compactStrings(candidate?.sourceRefs, 1).length > 0,
		).length,
		auditedClaimsWithSourceRefs: claimDigests.filter(
			(claim) => compactStrings(claim?.sourceRefs, 1).length > 0,
		).length,
		sourceRefJoinFailures: sourceRefJoinFailures.length,
	};
	const integritySummary = {
		omittedVerificationCandidateCount: omittedCandidateIds.length,
		sourceRefJoinFailures: sourceRefJoinFailures.length,
		invalidVerifierRows: invalidVerifierRows.length,
		duplicateVerifierRows: duplicateVerifierRows.length,
		verifierOwnerIssues: verifierOwnerIssues.length,
		invalidNormalizedCandidateCount: invalidNormalizedCandidateRows.length,
		invalidNormalizedCandidateRows,
		missingVerifierResults: Number(gateSummary.missingVerifierResults ?? 0),
		zeroCandidateFloorBlockers,
		batchAdoptionStatus: stringOf(batchAdoptionReadiness.status),
		batchAdoptionBlockers: asArray(batchAdoptionReadiness.blockers),
		sourceRefCoverage,
	};
	const synthesisInput = buildSynthesisInput({
		plan,
		factSlotCoverage,
		claimDigests,
		preservedClaims,
		coverageGaps,
		remainingGaps,
		sourceRefJoinFailures,
		researchScopeCoverage: normalized.researchScopeCoverage,
		integritySummary,
		audit,
	});

	return {
		schema: SCHEMA,
		digest: `Prepared final-audit packet with ${claimDigests.length} audited claim(s), ${factSlotCoverage.length} fact slot(s), and ${remainingGaps.length + coverageGaps.length + sourceRefJoinFailures.length} gap row(s).`,
		packet: {
			synthesisInput,
			researchMetadataSeed: {
				depth: stringOf(plan.depth),
				taskType: stringOf(plan.taskType),
				expectedFinalShape: stringOf(plan.expectedFinalShape),
				researchQuestions: asArray(plan.researchQuestions).length,
				sourcePolicy: asObject(plan.sourcePolicy),
				plannedFactSlots: asArray(plan.factSlots).length,
				filledFactSlots: factSlotCoverage.filter(
					(slot) => slot.status === "filled",
				).length,
				partialFactSlots: factSlotCoverage.filter(
					(slot) => slot.status === "partial",
				).length,
				missingOnlyFactSlots: factSlotCoverage.filter(
					(slot) => slot.status === "missing",
				).length,
				// Keep the legacy unresolved total backward-complete. The explicit
				// fields make its overlap with conflictingFactSlots machine-readable.
				missingFactSlots: factSlotCoverage.filter((slot) =>
					["missing", "conflicting"].includes(slot.status),
				).length,
				missingFactSlotsIncludesConflicting: true,
				conflictingFactSlots: factSlotCoverage.filter(
					(slot) => slot.status === "conflicting",
				).length,
			},
			verdictCounts: asObject(audit.verdictCounts),
			statusPartitions: asObject(audit.statusPartitions),
			factSlotCoverage,
			factSlotStatusCounts: countByStatus(factSlotCoverage),
			coverageGaps,
			remainingGaps,
			sourceRefJoinFailures,
			claimVerdictLedger: claimDigests,
			verifierIntegrity: {
				gateSummary,
				invalidVerifierRows,
				duplicateVerifierRows,
				invalidNormalizedCandidateCount: invalidNormalizedCandidateRows.length,
				invalidNormalizedCandidateRows,
				verifierOwnerLedger,
				verifierOwnerIssues,
				...(stringOf(batchAdoptionReadiness.status)
					? { batchAdoptionReadiness }
					: {}),
			},
			normalizerDiagnostics: {
				precisionGuard: precisionGuardDiagnostics,
				sanitizer: sanitizerDiagnostics,
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
				candidateIds,
				auditedClaimIds: claimDigests.map(idOf),
				statusPartitionIds: asObject(audit.statusPartitions),
				omittedCandidateIds,
				droppedSlotIds: asArray(audit.slotCoverageCheck?.droppedSlotIds),
				sourceRefCoverage,
				verifierIntegrity: {
					invalidVerifierRows: invalidVerifierRows.length,
					duplicateVerifierRows: duplicateVerifierRows.length,
					invalidNormalizedCandidateCount: invalidNormalizedCandidateRows.length,
					verifierOwnerIssues: verifierOwnerIssues.length,
					missingVerifierResults: Number(
						gateSummary.missingVerifierResults ?? 0,
					),
					zeroCandidateFloorBlockers,
					batchAdoptionStatus: stringOf(batchAdoptionReadiness.status),
				},
			},
			overflowLedger: {
				preservedClaimCount: preservedClaims.length,
				coverageGapCount: coverageGaps.length,
				remainingGapCount: remainingGaps.length,
				omittedVerificationCandidateCount: omittedCandidateIds.length,
				invalidVerifierRowCount: invalidVerifierRows.length,
				duplicateVerifierRowCount: duplicateVerifierRows.length,
				invalidNormalizedCandidateCount: invalidNormalizedCandidateRows.length,
				verifierOwnerIssueCount: verifierOwnerIssues.length,
			},
		},
	};
}
