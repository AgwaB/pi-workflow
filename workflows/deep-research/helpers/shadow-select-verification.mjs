// Shadow-only selective verification reporter for deep-research.
//
// This helper never skips verification. It records which candidates a future
// selector might skip, then joins those shadow decisions to actual audit output
// so adoption can be judged with evidence before any verifier is removed.

function asArray(value) {
	if (Array.isArray(value)) return value;
	if (value && typeof value === "object") {
		if (Array.isArray(value.claimInventory?.verificationCandidates))
			return value.claimInventory.verificationCandidates;
		if (Array.isArray(value.verificationCandidates))
			return value.verificationCandidates;
		if (Array.isArray(value.auditedClaims)) return value.auditedClaims;
		if (Array.isArray(value.claims)) return value.claims;
		if (Array.isArray(value.items)) return value.items;
	}
	return [];
}

function findCandidates(sources) {
	for (const [specId, source] of Object.entries(sources ?? {})) {
		if (specId === "sanitize-claims" || specId.startsWith("sanitize-claims.")) {
			const candidates = asArray(source);
			if (candidates.length > 0) return candidates;
		}
	}
	for (const [specId, source] of Object.entries(sources ?? {})) {
		if (
			specId === "normalize-claims" ||
			specId.startsWith("normalize-claims.")
		) {
			const candidates = asArray(source);
			if (candidates.length > 0) return candidates;
		}
	}
	return [];
}

function findAuditedClaims(sources) {
	for (const [specId, source] of Object.entries(sources ?? {})) {
		if (specId === "audit-claims" || specId.startsWith("audit-claims.")) {
			const claims = asArray(source);
			if (claims.length > 0) return claims;
		}
	}
	return [];
}

function findAuditSource(sources) {
	for (const [specId, source] of Object.entries(sources ?? {})) {
		if (specId === "audit-claims" || specId.startsWith("audit-claims."))
			return source && typeof source === "object" ? source : {};
	}
	return {};
}

function issueCount(audit, field) {
	const fromSummary = Number(audit?.gateSummary?.[field] ?? 0);
	const fromArray = Array.isArray(audit?.[field]) ? audit[field].length : 0;
	return Math.max(Number.isFinite(fromSummary) ? fromSummary : 0, fromArray);
}

function auditIntegrityBlockers(audit) {
	return [
		["audit_invalid_verifier_rows", issueCount(audit, "invalidVerifierRows")],
		[
			"audit_missing_verifier_results",
			issueCount(audit, "missingVerifierResults"),
		],
		[
			"audit_duplicate_verifier_rows",
			issueCount(audit, "duplicateVerifierRows"),
		],
		[
			"audit_duplicate_status_conflicts",
			issueCount(audit, "duplicateStatusConflicts"),
		],
		[
			"audit_invalid_normalized_candidates",
			issueCount(audit, "invalidNormalizedCandidates"),
		],
		[
			"audit_source_ref_join_failures",
			issueCount(audit, "sourceRefJoinFailures"),
		],
	]
		.filter(([, count]) => count > 0)
		.map(([reason, count]) => ({ reason, count }));
}

function candidateId(candidate, index) {
	const id = typeof candidate?.id === "string" ? candidate.id.trim() : "";
	return id || `candidate-${String(index + 1).padStart(3, "0")}`;
}

function hasExactQuantitativeText(candidate) {
	return /\b\d+(?:\.\d+)?\b|\b(v\d+(?:\.\d+)*)\b|\b\d+\s*(?:ms|s|min|hour|day|%|percent|usd|dollars?|tokens?|kb|mb|gb)\b/iu.test(
		String(candidate?.claim ?? ""),
	);
}

function hasCriticalSlots(candidate) {
	const ids = Array.isArray(candidate?.factSlotIds)
		? candidate.factSlotIds
		: [];
	return ids.some((id) =>
		/(price|pricing|cost|ttl|limit|version|date|policy|security|numeric|slot-critical)/iu.test(
			String(id),
		),
	);
}

function hasExactSourceHint(candidate) {
	return (
		Array.isArray(candidate?.sourceEvidenceHints) &&
		candidate.sourceEvidenceHints.some(
			(hint) =>
				typeof hint?.quote === "string" &&
				hint.quote.trim() &&
				(typeof hint.sourceRef === "string" ||
					typeof hint.sourceUrl === "string"),
		)
	);
}

function decide(candidate) {
	const reasonCodes = [];
	if (hasExactQuantitativeText(candidate))
		reasonCodes.push("exact_quantitative");
	if (hasCriticalSlots(candidate)) reasonCodes.push("critical_fact_slot");
	if (!hasExactSourceHint(candidate)) reasonCodes.push("no_exact_source_hint");
	if (reasonCodes.length > 0) {
		return { decision: "would_verify", reasonCodes };
	}
	return {
		decision: "would_skip_shadow_only",
		reasonCodes: ["exact_source_hint_noncritical"],
	};
}

export default async function shadowSelectVerification({ sources }) {
	const audit = findAuditSource(sources);
	const candidates = findCandidates(sources).map((candidate, index) => ({
		candidate,
		id: candidateId(candidate, index),
	}));
	const auditedById = new Map(
		findAuditedClaims(sources).map((claim, index) => [
			candidateId(claim, index),
			claim,
		]),
	);
	const decisions = candidates.map(({ candidate, id }) => {
		const decision = decide(candidate);
		const audited = auditedById.get(id);
		return {
			id,
			decision: decision.decision,
			reasonCodes: decision.reasonCodes,
			actualStatus:
				typeof audited?.status === "string" ? audited.status : undefined,
			actualVerified: audited?.status === "verified",
			factSlotIds: Array.isArray(candidate.factSlotIds)
				? [...candidate.factSlotIds]
				: [],
		};
	});
	const wouldSkip = decisions.filter(
		(decision) => decision.decision === "would_skip_shadow_only",
	);
	const wouldVerify = decisions.filter(
		(decision) => decision.decision === "would_verify",
	);
	const skippedButVerified = wouldSkip.filter(
		(decision) => decision.actualVerified,
	);
	const wouldSkipWithoutAudit = wouldSkip.filter(
		(decision) => typeof decision.actualStatus !== "string",
	);
	const blockers = [];
	if (skippedButVerified.length > 0)
		blockers.push({
			reason: "would_skip_verified_claims",
			count: skippedButVerified.length,
		});
	if (wouldSkipWithoutAudit.length > 0)
		blockers.push({
			reason: "would_skip_without_audit_result",
			count: wouldSkipWithoutAudit.length,
		});
	blockers.push(...auditIntegrityBlockers(audit));
	if (wouldSkip.length === 0)
		blockers.push({ reason: "no_shadow_skip_candidates", count: 0 });
	const realSkipReadiness = {
		status: blockers.length === 0 ? "eligible_for_canary" : "blocked",
		realSkippingEnabled: false,
		adopted: false,
		canaryRequired: true,
		reason:
			blockers.length === 0
				? "Shadow selector found skip candidates with no verified or missing-audit rows; real skipping still requires a non-holdout canary."
				: "Real selective verification is blocked until shadow decisions prove no verified or unaudited claims would be skipped.",
		blockers,
	};
	return {
		schema: "deep-research-verification-shadow-selector-v1",
		digest: `${wouldSkip.length} would-skip shadow candidate(s), ${wouldVerify.length} would-verify candidate(s); real skipping disabled`,
		realSkippingEnabled: false,
		candidateCount: decisions.length,
		summary: {
			wouldSkip: wouldSkip.length,
			wouldVerify: wouldVerify.length,
			skippedButVerified: skippedButVerified.length,
			wouldSkipWithoutAudit: wouldSkipWithoutAudit.length,
			skippedCritical: wouldSkip.filter((decision) =>
				decision.reasonCodes.includes("critical_fact_slot"),
			).length,
			shadowOnly: true,
		},
		realSkipReadiness,
		decisions,
		w8FastProfilePrerequisite: {
			status: "not_met",
			reason:
				"selective verification is shadow-only; no verified cost/speed reduction is available to package as an opt-in fast profile",
		},
	};
}
