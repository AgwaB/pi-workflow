// Deterministic final-audit scaffold for deep-research.
//
// This helper converts the code-computed final-audit packet into a final-control
// shaped draft. It does not re-verify claims, invent new recommendations, or
// promote lower-confidence statuses. The downstream final-audit model stage can
// perform a short editorial pass over this scaffold instead of rebuilding the
// report from the raw packet.

const SCHEMA = "deep-research-final-audit-scaffold-v1";
const FINAL_SCHEMA = "deep-research-final-control-v1";

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
	return typeof value === "string" ? value.trim() || undefined : undefined;
}

function finiteNumber(value, fallback = 0) {
	const number = Number(value);
	return Number.isFinite(number) ? number : fallback;
}

function compactText(value, maxChars = 220) {
	const text = String(value ?? "")
		.replace(/\s+/g, " ")
		.trim();
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 1)).replace(/[\s,;:.-]+$/, "")}…`;
}

function compactStrings(values, limit = 8) {
	const out = [];
	const seen = new Set();
	for (const value of asArray(values)) {
		if (typeof value !== "string") continue;
		const text = value.trim();
		if (!text || seen.has(text)) continue;
		seen.add(text);
		out.push(text);
		if (out.length >= limit) break;
	}
	return out;
}

function httpUrls(values, limit = 5) {
	return compactStrings(values, limit).filter((value) => /^https?:\/\//i.test(value));
}

function canonicalStatus(status) {
	if (status === "partiallySupported") return "partially_supported";
	return stringOf(status) ?? "unverified";
}

function statusLabel(status) {
	return canonicalStatus(status).replace(/_/g, " ");
}

function statusRank(status) {
	const order = {
		verified: 0,
		partially_supported: 1,
		conflicting: 2,
		unsupported: 3,
		unverified: 4,
	};
	return order[canonicalStatus(status)] ?? 5;
}

function confidenceRank(confidence) {
	const order = { high: 0, medium: 1, low: 2 };
	return order[String(confidence ?? "").toLowerCase()] ?? 3;
}

function sortedClaimRows(rows) {
	return [...rows].sort((a, b) => {
		const status = statusRank(a.status) - statusRank(b.status);
		if (status !== 0) return status;
		const confidence = confidenceRank(a.confidence) - confidenceRank(b.confidence);
		if (confidence !== 0) return confidence;
		return compactStrings(b.sourceUrls, 8).length - compactStrings(a.sourceUrls, 8).length;
	});
}

function claimText(row) {
	return compactText(row.claim ?? row.support ?? row.correctionOrCounterclaim ?? row.id, 260);
}

function evidenceStatus(row) {
	const status = statusLabel(row.status);
	const confidence = stringOf(row.confidence);
	return confidence ? `${status}; confidence ${confidence}` : status;
}

function claimIndexRow(row) {
	return {
		id: stringOf(row.id),
		claim: compactText(row.claim, 260),
		status: canonicalStatus(row.status),
		confidence: stringOf(row.confidence),
		sourceUrls: httpUrls(row.sourceUrls, 6),
		factSlotIds: compactStrings(row.factSlotIds, 12),
		support: compactText(row.support, 220),
		caveat: compactText(row.caveat, 180),
		correctionOrCounterclaim: compactText(row.correctionOrCounterclaim, 180),
	};
}

function findingFromClaim(row) {
	return {
		finding: claimText(row),
		claimId: stringOf(row.id),
		status: canonicalStatus(row.status),
		evidenceStatus: evidenceStatus(row),
		sourceUrls: httpUrls(row.sourceUrls, 4),
		factSlotIds: compactStrings(row.factSlotIds, 8),
		support: compactText(row.support, 220),
		...(stringOf(row.caveat) ? { caveat: compactText(row.caveat, 180) } : {}),
		...(stringOf(row.correctionOrCounterclaim)
			? { correctionOrCounterclaim: compactText(row.correctionOrCounterclaim, 180) }
			: {}),
	};
}

function recommendationFromClaim(row) {
	const status = canonicalStatus(row.status);
	const prefix =
		status === "verified"
			? "Use as a verified input"
			: status === "partially_supported"
				? "Use only with caveat"
				: status === "conflicting"
					? "Resolve before deciding"
					: "Do not rely on without more evidence";
	return {
		recommendation: `${prefix}: ${claimText(row)}`,
		claimId: stringOf(row.id),
		evidenceStatus: evidenceStatus(row),
		sourceUrls: httpUrls(row.sourceUrls, 3),
		whyItMatters: compactText(
			row.support ?? row.caveat ?? row.correctionOrCounterclaim,
			220,
		),
		factSlotIds: compactStrings(row.factSlotIds, 8),
	};
}

function noteFromGap(gap, fallbackStatus = "gap") {
	const item = asObject(gap);
	const claimId = stringOf(item.claimId);
	const slotId = stringOf(item.slotId);
	const reason = compactText(item.reason ?? item.gapReason ?? item.evidenceState, 180);
	const nextStep = compactText(item.nextStep, 180);
	return {
		note: compactText(
			reason || nextStep || `Unresolved ${claimId ? `claim ${claimId}` : slotId ? `slot ${slotId}` : fallbackStatus}.`,
			220,
		),
		whyItMatters: compactText(item.whyItMatters ?? item.parentImpact ?? reason, 220),
		evidenceStatus: stringOf(item.evidenceState) ?? fallbackStatus,
		suggestedParentDecision: nextStep || "Treat this as a caveat until evidence is strengthened.",
		...(claimId ? { claimId } : {}),
		...(slotId ? { slotId } : {}),
		...(item.scopeItem ? { scopeItem: stringOf(item.scopeItem) } : {}),
		...(Array.isArray(item.relatedFactSlotIds)
			? { relatedFactSlotIds: compactStrings(item.relatedFactSlotIds, 8) }
			: {}),
		...(Array.isArray(item.sourceUrls) ? { sourceUrls: httpUrls(item.sourceUrls, 4) } : {}),
	};
}

function preservedItem(claim) {
	const item = asObject(claim);
	return {
		claim: compactText(item.claim, 240),
		claimId: stringOf(item.id),
		factSlotIds: compactStrings(item.factSlotIds, 8),
		sourceUrls: httpUrls(item.sourceUrls, 4),
		evidenceStatus: "unverified preserved material",
		whyItMatters: compactText(item.whyItMatters, 220),
	};
}

function nonEmptyObjects(items, limit) {
	return items
		.filter((item) => Object.values(item).some((value) => value !== undefined && value !== ""))
		.slice(0, limit);
}

function buildCoverageSummary(packet, rows) {
	const metadata = asObject(packet.researchMetadataSeed);
	const counts = asObject(packet.verdictCounts);
	const overflow = asObject(packet.overflowLedger);
	const invariants = asObject(packet.invariantChecks);
	const verified = finiteNumber(counts.verified);
	const partiallySupported = finiteNumber(counts.partiallySupported);
	const unsupported = finiteNumber(counts.unsupported);
	const conflicting = finiteNumber(counts.conflicting);
	return {
		depth: stringOf(metadata.depth),
		taskType: stringOf(metadata.taskType),
		expectedFinalShape: stringOf(metadata.expectedFinalShape),
		researchQuestions: finiteNumber(metadata.researchQuestions),
		verificationCandidates: finiteNumber(invariants.candidateCount, rows.length),
		verified,
		partiallySupported,
		unsupported,
		conflicting,
		preserved: finiteNumber(overflow.preservedClaimCount, asArray(packet.preservedClaims).length),
		unverifiedButRelevant: asArray(packet.preservedClaims).length,
		coverageGaps: asArray(packet.coverageGaps).length + asArray(packet.remainingGaps).length,
		plannedFactSlots: finiteNumber(metadata.plannedFactSlots, asArray(packet.factSlotCoverage).length),
		filledFactSlots: finiteNumber(metadata.filledFactSlots),
		partialFactSlots: finiteNumber(metadata.partialFactSlots),
		missingFactSlots: finiteNumber(metadata.missingFactSlots),
	};
}

function buildSummary(packet, rows, coverageSummary) {
	const metadata = asObject(packet.researchMetadataSeed);
	const depth = stringOf(metadata.depth) ?? "standard";
	const taskType = stringOf(metadata.taskType) ?? "research";
	const topVerified = rows.find((row) => canonicalStatus(row.status) === "verified");
	const counts = `${coverageSummary.verified} verified, ${coverageSummary.partiallySupported} partially supported, ${coverageSummary.unsupported} unsupported, ${coverageSummary.conflicting} conflicting`;
	if (topVerified) {
		return compactText(
			`Audited ${depth} ${taskType} completed with ${counts}. Top verified finding: ${claimText(topVerified)}. Use caveated and unresolved items only with the evidence status shown below.`,
			520,
		);
	}
	return compactText(
		`Audited ${depth} ${taskType} completed with ${counts}. No claim was promoted beyond its verifier status; use remaining gaps and preserved material as follow-up work, not as verified conclusions.`,
		520,
	);
}

export default async function finalAuditScaffold({ sources }) {
	const source = findSource(sources, "final-audit-packet") ?? sources?.[Object.keys(sources ?? {})[0]];
	const packet = asObject(source?.packet ?? source);
	const rows = sortedClaimRows(asArray(packet.claimVerdictLedger).map(claimIndexRow));
	const byStatus = {
		verified: rows.filter((row) => row.status === "verified"),
		partially_supported: rows.filter((row) => row.status === "partially_supported"),
		unsupported: rows.filter((row) => row.status === "unsupported"),
		conflicting: rows.filter((row) => row.status === "conflicting"),
		other: rows.filter(
			(row) => !["verified", "partially_supported", "unsupported", "conflicting"].includes(row.status),
		),
	};
	const coverageSummary = buildCoverageSummary(packet, rows);
	const gapNotes = [
		...asArray(packet.remainingGaps).map((gap) => noteFromGap(gap, "remaining gap")),
		...asArray(packet.coverageGaps).map((gap) => noteFromGap(gap, "coverage gap")),
		...asArray(packet.sourceRefJoinFailures).map((gap) => noteFromGap(gap, "source-ref join failure")),
	];
	const verifierIntegrity = asObject(packet.verifierIntegrity);
	const gateSummary = asObject(verifierIntegrity.gateSummary);
	if (finiteNumber(gateSummary.missingVerifierResults) > 0) {
		gapNotes.push({
			note: `${finiteNumber(gateSummary.missingVerifierResults)} normalized verification candidates were missing verifier results.`,
			whyItMatters: "Missing verifier results prevent treating those claims as supported.",
			evidenceStatus: "missing verifier result",
			suggestedParentDecision: "Rerun or repair claim verification before relying on affected claims.",
		});
	}
	const unverifiedButRelevant = nonEmptyObjects(
		asArray(packet.preservedClaims).map(preservedItem),
		16,
	);
	const parentDecisionNotes = nonEmptyObjects(
		[
			...byStatus.partially_supported.slice(0, 6).map(recommendationFromClaim).map((item) => ({
				note: item.recommendation,
				whyItMatters: item.whyItMatters,
				evidenceStatus: item.evidenceStatus,
				suggestedParentDecision: "Use only with the stated caveat or gather stronger evidence first.",
				claimId: item.claimId,
				sourceUrls: item.sourceUrls,
			})),
			...gapNotes,
		],
		12,
	);
	const finalReport = {
		summary: buildSummary(packet, rows, coverageSummary),
		researchMetadata: {
			...asObject(packet.researchMetadataSeed),
			finalAuditMode: "deterministic-scaffold-with-editorial-pass",
			packetSchema: source?.schema,
		},
		coverageSummary,
		factSlotCoverage: asArray(packet.factSlotCoverage),
		mainFindings: nonEmptyObjects(byStatus.verified.map(findingFromClaim), 12),
		recommendations: nonEmptyObjects(
			[
				...byStatus.verified.slice(0, 8).map(recommendationFromClaim),
				...byStatus.partially_supported.slice(0, 4).map(recommendationFromClaim),
			],
			12,
		),
		actionPlan: nonEmptyObjects(
			[
				{
					step: "Base parent-facing conclusions on verified findings first.",
					evidenceStatus: "verified findings only",
					whyItMatters: "This preserves the verifier/audit boundary and prevents unsupported promotion.",
				},
				...(byStatus.partially_supported.length > 0
					? [
							{
								step: "Keep partially supported claims caveated until the listed evidence gaps are closed.",
								evidenceStatus: "partially supported",
								whyItMatters: "The audit gate found support but not enough evidence for a hard verified conclusion.",
							},
						]
					: []),
				...(byStatus.conflicting.length > 0 || byStatus.unsupported.length > 0
					? [
							{
								step: "Do not use unsupported or conflicting claims as decision thresholds.",
								evidenceStatus: "unsupported/conflicting",
								whyItMatters: "Those claims failed verification or need reconciliation.",
							},
						]
					: []),
			],
			8,
		),
		caveatedFindings: nonEmptyObjects(byStatus.partially_supported.map(findingFromClaim), 12),
		contestedAreas: nonEmptyObjects(byStatus.conflicting.map(findingFromClaim), 12),
		notableUnsupportedClaims: nonEmptyObjects(byStatus.unsupported.map(findingFromClaim), 12),
		unverifiedButRelevant,
		parentDecisionNotes,
		researchScopeCoverage: asArray(packet.researchScopeCoverage),
		remainingGaps: nonEmptyObjects(gapNotes, 24),
	};
	const draft = {
		schema: FINAL_SCHEMA,
		digest: compactText(finalReport.summary, 260),
		finalReport,
		claimVerdictIndex: {
			claims: rows,
		},
	};
	return {
		schema: SCHEMA,
		digest: draft.digest,
		draft,
		guardrails: {
			mustPreserveClaimCounts: true,
			mustPreserveFactSlotCoverage: true,
			claimIndexCount: rows.length,
			factSlotCoverageCount: finalReport.factSlotCoverage.length,
			remainingGapCount: finalReport.remainingGaps.length,
		},
	};
}
