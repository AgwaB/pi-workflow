// Deterministic post-processing for spec-review.
//
// Modes (options.mode):
//   "partition"        — joins verifier outputs back to candidate findings by
//                        id and partitions verdicts into final/dropped/
//                        needs-human buckets. Handles both the default
//                        one-verifier-per-candidate path and the opt-in
//                        batched path: when a verification-batches source is
//                        present, verifier outputs must be strict
//                        { schema, digest, results[] } batch carriers and are
//                        flattened with fail-closed membership, duplicate,
//                        orphan, and title-echo gates before the id join.
//   "batch-candidates" — opt-in only. Plans deterministic batches of candidate
//                        findings for a batched verify-findings foreach. The
//                        default spec-review workflow still verifies one
//                        candidate per task.

const VERDICTS = new Set(["KEEP", "WEAKEN", "DROP", "NEEDS_HUMAN"]);
const SEVERITIES = new Set(["high", "medium", "low", "info"]);

const BATCH_PLAN_SCHEMA = "spec-review-verification-batches-v1";
const BATCH_CONTROL_SCHEMA = "spec-review-verify-findings-batch-v1";
const BATCH_ROW_KEYS = new Set([
	"id",
	"title",
	"verdict",
	"severity",
	"evidence",
	"counterEvidence",
	"finalClaim",
	"recommendedAction",
]);

export default async function specReviewPipeline({
	sources,
	options,
	context,
}) {
	const mode = options?.mode ?? "partition";
	if (mode === "batch-candidates")
		return batchCandidateFindings(sources, options);
	if (mode === "partition") return partitionFindings(sources, options, context);
	throw new Error(`unknown spec-review pipeline mode: ${mode}`);
}

// --- batch planning (opt-in) -------------------------------------------------

function batchCandidateFindings(sources, options = {}) {
	const candidateStage = String(
		options?.candidateStage ?? "candidate-findings",
	);
	const maxBatchSize = normalizeMaxBatchSize(options?.maxBatchSize);
	const analysis = findStageSource(sources, candidateStage) ?? {};
	const rawCandidates = Array.isArray(analysis?.candidateFindings)
		? analysis.candidateFindings.filter(
				(candidate) =>
					candidate &&
					typeof candidate === "object" &&
					!Array.isArray(candidate),
			)
		: [];

	const usedIds = new Set();
	for (const candidate of rawCandidates) {
		const id = normalizeId(candidate?.id);
		if (id) usedIds.add(id);
	}
	// First occurrence wins for duplicate ids, mirroring the partition join;
	// candidates without an id get deterministic fallback ids so they still
	// receive verification coverage instead of vanishing silently.
	const seenIds = new Set();
	const duplicateCandidateIds = [];
	const items = [];
	for (const [index, candidate] of rawCandidates.entries()) {
		const explicitId = normalizeId(candidate?.id);
		if (explicitId && seenIds.has(explicitId)) {
			duplicateCandidateIds.push(explicitId);
			continue;
		}
		const id = explicitId ?? allocateFallbackId(usedIds, index);
		seenIds.add(id);
		items.push({ id, candidate });
	}
	items.sort((left, right) => left.id.localeCompare(right.id));

	const batches = [];
	for (let offset = 0; offset < items.length; offset += maxBatchSize) {
		const slice = items.slice(offset, offset + maxBatchSize);
		batches.push({
			id: `vbatch-${String(batches.length + 1).padStart(3, "0")}`,
			candidateIds: slice.map((item) => item.id),
			candidates: slice.map((item) => ({ ...item.candidate, id: item.id })),
		});
	}

	return {
		schema: BATCH_PLAN_SCHEMA,
		digest: `${batches.length} verification batch(es), ${items.length} candidate(s), maxBatchSize=${maxBatchSize}`,
		maxBatchSize,
		candidateCount: items.length,
		batchCount: batches.length,
		...(duplicateCandidateIds.length > 0 ? { duplicateCandidateIds } : {}),
		batches,
	};
}

function allocateFallbackId(usedIds, index) {
	let next = index + 1;
	while (true) {
		const id = `candidate-${String(next).padStart(3, "0")}`;
		if (!usedIds.has(id)) {
			usedIds.add(id);
			return id;
		}
		next += 1;
	}
}

function normalizeMaxBatchSize(value) {
	const parsed = Number(value ?? 4);
	if (!Number.isInteger(parsed) || parsed < 1) return 4;
	return Math.min(parsed, 8);
}

// --- partition ---------------------------------------------------------------

function partitionFindings(sources, options = {}, context = {}) {
	const candidateStage = String(
		options?.candidateStage ?? "candidate-findings",
	);
	const verifyStage = String(options?.verifyStage ?? "verify-findings");
	const batchStage = String(options?.batchStage ?? "verification-batches");

	const analysis = findStageSource(sources, candidateStage) ?? {};
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

	const candidatesById = new Map();
	const duplicateCandidateIds = [];
	for (const candidate of candidateFindings) {
		const id = normalizeId(candidate?.id);
		if (!id) continue;
		if (candidatesById.has(id)) duplicateCandidateIds.push(id);
		else candidatesById.set(id, candidate);
	}

	const batchMembership = buildBatchMembership(
		findStageSource(sources, batchStage),
	);
	const batchMode = batchMembership.byBatchId.size > 0;

	// In batch mode the planner's cloned candidates are the authoritative join
	// set (they carry deterministic fallback ids for id-less candidates); raw
	// candidate ids that never reached a batch still get missing-verification
	// coverage below.
	const joinCandidates = batchMode
		? new Map(batchMembership.candidatesById)
		: candidatesById;
	if (batchMode) {
		for (const [id, candidate] of candidatesById.entries()) {
			if (!joinCandidates.has(id)) joinCandidates.set(id, candidate);
		}
	}

	const needsHuman = candidateNeedsHuman.map((item) => ({
		source: "candidate-findings",
		...objectOrMessage(item),
	}));

	const verifierById = new Map();
	const duplicateVerifierIds = [];
	const invalidVerifierResults = [];
	const orphanVerifierResults = [];
	const batchIntegrityIssues = [];
	const issueCoveredIds = new Set();
	let verifierCount = 0;

	if (batchMode) {
		const collected = collectBatchVerifierRows({
			sources,
			verifyStage,
			batchMembership,
			batchIdBySourceName: buildBatchIdBySourceName(
				context?.sourceStatuses,
				verifyStage,
			),
		});
		verifierCount = collected.rowCount;

		const rowsById = new Map();
		for (const row of collected.rows) {
			const group = rowsById.get(row.id) ?? [];
			group.push(row);
			rowsById.set(row.id, group);
		}
		for (const [id, group] of rowsById.entries()) {
			if (group.length > 1) {
				duplicateVerifierIds.push(id);
				collected.issues.push({
					reason: "duplicate_batch_row_for_candidate",
					id,
					batchId: group[0].batchId,
					sourceId: group[0].sourceId,
					rowCount: group.length,
				});
				continue;
			}
			verifierById.set(id, group[0].entry);
		}

		for (const issue of collected.issues) {
			batchIntegrityIssues.push(issue);
			const id = normalizeId(issue.id);
			if (id && joinCandidates.has(id)) {
				// Any integrity anomaly touching a candidate id voids its verifier
				// rows: the candidate is routed to NEEDS_HUMAN, never joined.
				issueCoveredIds.add(id);
				verifierById.delete(id);
				needsHuman.push({
					source: "batch-integrity",
					...findingSummary(joinCandidates.get(id), {
						id,
						status: "batch_integrity_issue",
						reason: `verifier batch integrity issue: ${issue.reason}`,
					}),
					batchIntegrityIssue: issue,
				});
			} else if (id) {
				orphanVerifierResults.push({ id, verdict: issue.verdict ?? null });
				needsHuman.push({
					source: "orphan-verifier",
					id,
					reason: `verifier batch row did not match any candidate finding id (${issue.reason})`,
				});
			} else {
				needsHuman.push({
					source: "batch-integrity",
					reason: `verifier batch integrity issue: ${issue.reason}`,
					batchIntegrityIssue: issue,
				});
			}
		}
	} else {
		const verifierResults = findVerifierResults(sources, verifyStage);
		verifierCount = verifierResults.length;
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
	}

	const finalFindings = [];
	const droppedFindings = [];
	const missingVerifications = [];

	for (const [id, candidate] of joinCandidates.entries()) {
		if (issueCoveredIds.has(id)) continue;
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

	if (!batchMode) {
		for (const [id, verifier] of verifierById.entries()) {
			if (!joinCandidates.has(id)) {
				orphanVerifierResults.push({ id, verdict: verifier.verdict ?? null });
				needsHuman.push({
					source: "orphan-verifier",
					id,
					reason: "verifier result did not match any candidate finding id",
				});
			}
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
		...(batchMode ? { batchIntegrity: batchIntegrityIssues.length } : {}),
	};

	return {
		schema: "spec-review-partition-v1",
		verifierCoverage: {
			candidateCount: candidateFindings.length,
			uniqueCandidateCount: candidatesById.size,
			verifierCount,
			uniqueVerifierCount: verifierById.size,
			verifiedCandidateCount: [...joinCandidates.keys()].filter((id) =>
				verifierById.has(id),
			).length,
			missingIds: missingVerifications.map((item) => item.id),
			duplicateCandidateIds,
			duplicateVerifierIds,
			orphanVerifierIds: orphanVerifierResults.map((item) => item.id),
			...(batchMode
				? {
						batch: {
							batchCount: batchMembership.byBatchId.size,
							memberCount: batchMembership.candidatesById.size,
							rowCount: verifierCount,
							integrityIssueCount: batchIntegrityIssues.length,
						},
					}
				: {}),
		},
		verdictCounts,
		requirementCoverage,
		finalFindings,
		droppedFindings,
		needsHuman,
		missingVerifications,
		invalidVerifierResults,
		orphanVerifierResults,
		...(batchMode ? { batchIntegrityIssues } : {}),
		noIssueNotes,
	};
}

// --- batched verifier row collection ------------------------------------------

function buildBatchMembership(batchSource) {
	const byBatchId = new Map();
	const candidatesById = new Map();
	const batches = Array.isArray(batchSource?.batches)
		? batchSource.batches
		: [];
	for (const batch of batches) {
		if (!batch || typeof batch !== "object") continue;
		const batchId = normalizeId(batch.id);
		if (!batchId) continue;
		const members = new Map();
		const candidates = Array.isArray(batch.candidates) ? batch.candidates : [];
		for (const candidate of candidates) {
			if (!candidate || typeof candidate !== "object") continue;
			const id = normalizeId(candidate.id);
			if (!id) continue;
			const title =
				typeof candidate.title === "string" ? candidate.title.trim() : "";
			members.set(id, { id, title, titleKey: titleKeyOf(title) });
			if (!candidatesById.has(id)) candidatesById.set(id, candidate);
		}
		const candidateIds = Array.isArray(batch.candidateIds)
			? batch.candidateIds
			: [];
		for (const rawId of candidateIds) {
			const id = normalizeId(rawId);
			if (!id || members.has(id)) continue;
			members.set(id, { id, title: "", titleKey: "" });
		}
		byBatchId.set(batchId, members);
	}
	return { byBatchId, candidatesById };
}

function buildBatchIdBySourceName(sourceStatuses, verifyStage) {
	const bySource = new Map();
	const statuses = Array.isArray(sourceStatuses) ? sourceStatuses : [];
	for (const status of statuses) {
		if (!status || typeof status !== "object") continue;
		const source = typeof status.source === "string" ? status.source : "";
		const specId = typeof status.specId === "string" ? status.specId : "";
		if (!source || !specId.startsWith(`${verifyStage}.`)) continue;
		const batchId = specId.slice(verifyStage.length + 1).trim();
		if (batchId) bySource.set(source, batchId);
	}
	return bySource;
}

function collectBatchVerifierRows({
	sources,
	verifyStage,
	batchMembership,
	batchIdBySourceName,
}) {
	const rows = [];
	const issues = [];
	let rowCount = 0;
	for (const [sourceId, source] of Object.entries(sources ?? {})) {
		if (sourceId !== verifyStage && !sourceId.startsWith(`${verifyStage}.`))
			continue;
		const suffixBatchId = sourceId.startsWith(`${verifyStage}.`)
			? sourceId.slice(verifyStage.length + 1).trim()
			: "";
		const batchId = suffixBatchId || batchIdBySourceName.get(sourceId) || null;
		if (!source || typeof source !== "object" || Array.isArray(source)) {
			issues.push({
				reason: "malformed_batch_output_not_object",
				sourceId,
				batchId,
			});
			continue;
		}
		if (source.schema !== BATCH_CONTROL_SCHEMA) {
			issues.push({
				reason: "malformed_batch_output_invalid_schema",
				sourceId,
				batchId,
				schema: typeof source.schema === "string" ? source.schema : null,
				expectedSchema: BATCH_CONTROL_SCHEMA,
			});
			continue;
		}
		if (!Array.isArray(source.results)) {
			issues.push({
				reason: "malformed_batch_output_missing_results",
				sourceId,
				batchId,
			});
			continue;
		}
		const members = batchId
			? batchMembership.byBatchId.get(batchId)
			: undefined;
		for (const [index, row] of source.results.entries()) {
			rowCount += 1;
			const base = { sourceId, batchId, index };
			const id = normalizeId(row?.id);
			const verdict =
				typeof row?.verdict === "string" ? row.verdict : undefined;
			const malformed = malformedBatchRowReason(row);
			if (malformed) {
				issues.push({
					...base,
					reason: malformed,
					...(id ? { id } : {}),
					...(verdict ? { verdict } : {}),
				});
				continue;
			}
			if (!batchId || !members) {
				issues.push({
					...base,
					reason: "unknown_verification_batch_id",
					id,
					verdict,
					expectedBatchIds: [...batchMembership.byBatchId.keys()],
				});
				continue;
			}
			const expected = members.get(id);
			if (!expected) {
				issues.push({
					...base,
					reason: "batch_row_candidate_not_in_source_batch",
					id,
					verdict,
					expectedCandidateIds: [...members.keys()],
				});
				continue;
			}
			if (!expected.titleKey) {
				issues.push({
					...base,
					reason: "batch_membership_missing_title",
					id,
					verdict,
				});
				continue;
			}
			if (String(row.title ?? "").trim() !== expected.title) {
				issues.push({
					...base,
					reason: "batch_row_title_mismatch",
					id,
					verdict,
					title: row.title,
					expectedTitle: expected.title,
				});
				continue;
			}
			rows.push({ ...base, id, entry: row });
		}
	}
	return { rows, issues, rowCount };
}

function malformedBatchRowReason(row) {
	if (!row || typeof row !== "object" || Array.isArray(row))
		return "malformed_batch_row_not_object";
	const extraKeys = Object.keys(row).filter((key) => !BATCH_ROW_KEYS.has(key));
	if (extraKeys.length > 0) return "malformed_batch_row_extra_fields";
	if (!normalizeId(row.id)) return "malformed_batch_row_missing_id";
	if (typeof row.title !== "string" || !row.title.trim())
		return "malformed_batch_row_missing_title";
	if (typeof row.verdict !== "string" || !VERDICTS.has(row.verdict))
		return "malformed_batch_row_invalid_verdict";
	if (typeof row.severity !== "string" || !SEVERITIES.has(row.severity))
		return "malformed_batch_row_invalid_severity";
	if (!Array.isArray(row.evidence))
		return "malformed_batch_row_missing_evidence_array";
	if (row.evidence.some((item) => typeof item !== "string"))
		return "malformed_batch_row_invalid_evidence_item";
	if (!Array.isArray(row.counterEvidence))
		return "malformed_batch_row_missing_counterEvidence_array";
	if (row.counterEvidence.some((item) => typeof item !== "string"))
		return "malformed_batch_row_invalid_counterEvidence_item";
	if (typeof row.finalClaim !== "string")
		return "malformed_batch_row_missing_finalClaim";
	if (typeof row.recommendedAction !== "string")
		return "malformed_batch_row_missing_recommendedAction";
	return null;
}

function titleKeyOf(value) {
	return String(value ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

// --- shared helpers ------------------------------------------------------------

function findStageSource(sources, stageId) {
	for (const [specId, source] of Object.entries(sources ?? {})) {
		if (specId === stageId || specId.startsWith(`${stageId}.`)) return source;
	}
	return null;
}

function findVerifierResults(sources, verifyStage) {
	return Object.entries(sources ?? {})
		.filter(([key]) => key === verifyStage || key.startsWith(`${verifyStage}.`))
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
