const VERDICTS = new Set(["KEEP", "WEAKEN", "DROP", "NEEDS_HUMAN"]);
const SEVERITIES = new Set(["high", "medium", "low", "info"]);

export default async function specReviewPipeline({ sources, options }) {
	const mode = options?.mode ?? "partition";
	if (mode !== "partition")
		throw new Error(`unknown spec-review pipeline mode: ${mode}`);

	const analysis = findAnalysisOutput(sources);
	const candidateFindings = Array.isArray(analysis?.candidateFindings)
		? analysis.candidateFindings
		: [];
	const requirementCoverage = Array.isArray(analysis?.requirementCoverage)
		? analysis.requirementCoverage
		: [];
	const candidateNeedsHuman = Array.isArray(analysis?.needsHuman)
		? analysis.needsHuman
		: [];
	const noIssueNotes = Array.isArray(analysis?.noIssueNotes)
		? analysis.noIssueNotes
		: [];
	const verifierResults = findVerifierResults(sources);

	const candidatesById = new Map();
	const duplicateCandidateIds = [];
	for (const candidate of candidateFindings) {
		const id = normalizeId(candidate?.id);
		if (!id) continue;
		if (candidatesById.has(id)) duplicateCandidateIds.push(id);
		else candidatesById.set(id, candidate);
	}

	const verifierById = new Map();
	const duplicateVerifierIds = [];
	const invalidVerifierResults = [];
	for (const result of verifierResults) {
		const id = normalizeId(result?.id);
		if (!id) {
			invalidVerifierResults.push({ reason: "missing_id", result });
			continue;
		}
		if (verifierById.has(id)) {
			duplicateVerifierIds.push(id);
			continue;
		}
		verifierById.set(id, result);
	}

	const finalFindings = [];
	const droppedFindings = [];
	const needsHuman = candidateNeedsHuman.map((item) => ({
		source: "candidate-findings",
		...objectOrMessage(item),
	}));
	const missingVerifications = [];

	for (const [id, candidate] of candidatesById.entries()) {
		const verifier = verifierById.get(id);
		if (!verifier) {
			const missing = findingSummary(candidate, {
				id,
				status: "missing_verification",
				reason: "candidate finding did not receive a verifier result",
			});
			missingVerifications.push(missing);
			needsHuman.push({ source: "missing-verification", ...missing });
			continue;
		}

		const verdict = normalizeVerdict(verifier.verdict);
		const severity = normalizeSeverity(verifier.severity, candidate.severity);
		if (!VERDICTS.has(String(verifier.verdict ?? "").toUpperCase())) {
			needsHuman.push({
				source: "invalid-verdict",
				id,
				title: candidate.title ?? id,
				reason: `invalid verifier verdict: ${String(verifier.verdict ?? "")}`,
			});
		}

		if (verdict === "KEEP" || verdict === "WEAKEN") {
			finalFindings.push({
				id,
				verdict,
				severity,
				title: candidate.title ?? verifier.finding?.title ?? id,
				requirementIds: arrayOfStrings(candidate.requirementIds),
				claim: verifier.finalClaim ?? candidate.claim ?? "",
				evidence: Array.isArray(verifier.evidence) ? verifier.evidence : [],
				counterEvidence: Array.isArray(verifier.counterEvidence)
					? verifier.counterEvidence
					: [],
				recommendedAction:
					verifier.recommendedAction ?? candidate.recommendedAction ?? "",
				originalCandidate: candidate,
			});
		} else if (verdict === "DROP") {
			droppedFindings.push({
				id,
				title: candidate.title ?? id,
				reason: summarizeCounterEvidence(verifier),
				originalCandidate: candidate,
			});
		} else {
			needsHuman.push({
				source: "verifier",
				id,
				title: candidate.title ?? id,
				reason:
					verifier.finalClaim ??
					verifier.recommendedAction ??
					"verifier requested human review",
				evidence: Array.isArray(verifier.evidence) ? verifier.evidence : [],
				counterEvidence: Array.isArray(verifier.counterEvidence)
					? verifier.counterEvidence
					: [],
			});
		}
	}

	const orphanVerifierResults = [];
	for (const [id, verifier] of verifierById.entries()) {
		if (!candidatesById.has(id)) {
			orphanVerifierResults.push({ id, verdict: verifier.verdict ?? null });
			needsHuman.push({
				source: "orphan-verifier",
				id,
				reason: "verifier result did not match any candidate finding id",
			});
		}
	}

	const verdictCounts = {
		keep: finalFindings.filter((item) => item.verdict === "KEEP").length,
		weaken: finalFindings.filter((item) => item.verdict === "WEAKEN").length,
		drop: droppedFindings.length,
		needsHuman: needsHuman.length,
		missingVerification: missingVerifications.length,
		invalidVerifier: invalidVerifierResults.length,
		orphanVerifier: orphanVerifierResults.length,
	};

	return {
		schema: "spec-review-partition-v1",
		verifierCoverage: {
			candidateCount: candidateFindings.length,
			uniqueCandidateCount: candidatesById.size,
			verifierCount: verifierResults.length,
			uniqueVerifierCount: verifierById.size,
			verifiedCandidateCount: [...candidatesById.keys()].filter((id) =>
				verifierById.has(id),
			).length,
			missingIds: missingVerifications.map((item) => item.id),
			duplicateCandidateIds,
			duplicateVerifierIds,
			orphanVerifierIds: orphanVerifierResults.map((item) => item.id),
		},
		verdictCounts,
		requirementCoverage,
		finalFindings,
		droppedFindings,
		needsHuman,
		missingVerifications,
		invalidVerifierResults,
		orphanVerifierResults,
		noIssueNotes,
	};
}

function findAnalysisOutput(sources) {
	return (
		sources["analysis.candidate-findings"] ??
		sources["analysis.candidate-findings.main"] ??
		sources["candidate-findings"] ??
		sources["candidate-findings.main"] ??
		Object.entries(sources).find(([key]) =>
			key.includes("candidate-findings"),
		)?.[1] ??
		{}
	);
}

function findVerifierResults(sources) {
	return Object.entries(sources)
		.filter(
			([key]) =>
				key === "verify-findings" || key.startsWith("verify-findings."),
		)
		.map(([, value]) => value)
		.filter((value) => value && typeof value === "object");
}

function normalizeId(value) {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeVerdict(value) {
	const verdict = String(value ?? "")
		.trim()
		.toUpperCase();
	return VERDICTS.has(verdict) ? verdict : "NEEDS_HUMAN";
}

function normalizeSeverity(...values) {
	for (const value of values) {
		const severity = String(value ?? "")
			.trim()
			.toLowerCase();
		if (SEVERITIES.has(severity)) return severity;
	}
	return "medium";
}

function arrayOfStrings(value) {
	return Array.isArray(value)
		? value.filter((item) => typeof item === "string")
		: [];
}

function objectOrMessage(value) {
	return value && typeof value === "object" && !Array.isArray(value)
		? value
		: { message: String(value ?? "") };
}

function findingSummary(candidate, extra) {
	return {
		id: extra.id,
		title: candidate?.title ?? extra.id,
		requirementIds: arrayOfStrings(candidate?.requirementIds),
		claim: candidate?.claim ?? "",
		...extra,
	};
}

function summarizeCounterEvidence(verifier) {
	if (verifier.finalClaim) return verifier.finalClaim;
	if (verifier.recommendedAction) return verifier.recommendedAction;
	if (
		Array.isArray(verifier.counterEvidence) &&
		verifier.counterEvidence.length > 0
	) {
		return JSON.stringify(verifier.counterEvidence[0]);
	}
	return "verifier dropped the finding";
}
