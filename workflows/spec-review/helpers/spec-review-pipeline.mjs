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

import { createHash } from "node:crypto";
import { EVIDENCE_PROTOCOL, gateDisposition, gateRequirementCoverage, reconcileRequirementCoverage, isLocalCitation } from "./spec-evidence-gate.mjs";
import { candidateUpstreamFailures } from "./spec-requirement-source.mjs";

const VERDICTS = new Set(["KEEP", "WEAKEN", "DROP", "NEEDS_HUMAN"]);
const SEVERITIES = new Set(["high", "medium", "low", "info"]);
const MAX_PARTIAL_FAILURES = 64;

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

async function partitionFindings(sources, options = {}, context = {}) {
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

	// In batch mode the batch membership is the authoritative join set. In
	// particular, an id-less raw candidate cannot be recovered by title or array
	// position; the planner must have assigned its fallback id and carried it in
	// candidateIds/candidates. This keeps coverage a unique ID set end-to-end.
	const joinCandidates = batchMode
		? new Map(batchMembership.candidatesById)
		: candidatesById;
	if (batchMode) {
		for (const [id] of candidatesById.entries()) {
			if (joinCandidates.has(id)) continue;
			// A raw candidate outside the authoritative batch join set is not
			// silently verified. It is recorded below as an integrity gap.
			batchMembership.issues.push({
				reason: "candidate_missing_from_authoritative_batch_join",
				id,
			});
		}
	}

	const needsHuman = candidateNeedsHuman.map((item) => ({
		source: "candidate-findings",
		...objectOrMessage(item),
	}));
	const sourceStatusSummary = summarizeSourceStatuses(context);
	const candidateStatuses = (Array.isArray(context.sourceStatuses) ? context.sourceStatuses : []).filter(row =>
		row?.stageId === candidateStage && (row.source === candidateStage || row.source?.startsWith(`${candidateStage}.`)) &&
		row.specId === `${candidateStage}.main` && typeof row.taskId === "string" && row.taskId.trim());
	if (candidateStatuses.length !== 1 || candidateStatuses[0].status !== "completed") {
		sourceStatusSummary.total += 1;
		sourceStatusSummary.nonCompleted += 1;
		sourceStatusSummary.partialFailures = [...sourceStatusSummary.partialFailures, {
			source: candidateStage, status: "missing_or_inconsistent_candidate_source_status",
		}].slice(0, MAX_PARTIAL_FAILURES);
	}

	// In a scheduler run, the candidate reducer's runtime-written manifest is
	// the authority for its three required mapping sources. A model cannot
	// hide a failed mapping stage by emitting a clean candidate control.
	let requirementSource = null;
	if (context.runId && candidateStatuses.length === 1) {
		const upstream = await candidateUpstreamFailures(context, candidateStatuses[0]);
		requirementSource = upstream.requirementSource;
		const failures = upstream.failures;
		sourceStatusSummary.total += failures.length;
		sourceStatusSummary.nonCompleted += failures.length;
		sourceStatusSummary.partialFailures = [...sourceStatusSummary.partialFailures, ...failures].slice(0, MAX_PARTIAL_FAILURES);
	}

	const verifierById = new Map();
	const duplicateVerifierIds = [];
	const invalidVerifierResults = [];
	const orphanVerifierResults = [];
	const batchIntegrityIssues = [];
	const issueCoveredIds = new Set();
	let verifierCount = 0;
	let batchOwnerLedgerRows = [];
	const verifierRowLedger = [];

	if (batchMode) {
		const batchIdBySourceName = buildBatchIdBySourceName(
			context?.sourceStatuses,
			verifyStage,
		);
		const collected = collectBatchVerifierRows({
			sources,
			verifyStage,
			batchMembership,
			batchIdBySourceName,
		});
		const ownerAudit = batchSourceStatusIssues(
			sources,
			verifyStage,
			context?.sourceStatuses,
			batchMembership,
		);
		batchOwnerLedgerRows = ownerAudit.ownerLedger;
		collected.issues.unshift(...ownerAudit.issues);
		for (const row of collected.rows) {
			const owner = batchOwnerLedgerRows.find(
				(candidate) => candidate.source === row.sourceId && candidate.batchId === row.batchId,
			);
			verifierRowLedger.push({
				id: row.id,
				verdict: row.entry.verdict,
				severity: row.entry.severity,
				...(owner ? { owner: { ...owner } } : {}),
			});
		}
		// An owner defect invalidates every row carried by that source. Add the
		// row id to the issue so the later fail-closed loop can quarantine the
		// candidate rather than merely recording a generic source warning.
		for (const issue of ownerAudit.issues) {
			for (const row of collected.rows) {
				if (row.sourceId !== issue.sourceId || !normalizeId(row.id)) continue;
				collected.issues.push({
					...issue,
					id: normalizeId(row.id),
					reason: "verifier_source_status_identity_mismatch",
				});
			}
		}
		// Membership defects are planning/join defects, not verifier rows. Keep
		// them in the same fail-closed integrity path so a malformed or
		// unplanned id-less candidate cannot certify a batch.
		collected.issues.unshift(...batchMembership.issues);
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
		const strictMaterializedStatusMode = true;
		for (const { sourceId, value: result } of verifierResults) {
			const id = normalizeId(result?.id);
			if (!id) {
				const invalid = { reason: "missing_id", sourceId, result };
				invalidVerifierResults.push(invalid);
				needsHuman.push({
					source: "verifier-integrity",
					sourceId,
					reason: "verifier result cannot be joined without an id",
				});
				continue;
			}
			// The source alias is only a routing hint. In a real artifact-graph
			// run the result is admissible only after its exact materialized task
			// status proves the stage/spec/placeholder/item/task binding.
			if (strictMaterializedStatusMode) {
				const expectedSpecId = `${verifyStage}.${id}`;
				const owners = singletonVerifierStatuses(
					context.sourceStatuses,
					sourceId,
					expectedSpecId,
				);
				if (
					owners.length !== 1 ||
					!singletonVerifierStatusIsExact(owners[0], verifyStage, id, sourceId)
				) {
					const reason = owners.length !== 1
						? "verifier_alias_not_bound_to_exactly_one_materialized_status"
						: "verifier_source_status_identity_mismatch";
					invalidVerifierResults.push({ reason, sourceId, id, result });
					needsHuman.push({ source: "verifier-integrity", sourceId, id, reason });
					continue;
				}
				const owner = singletonOwnerFromStatus(owners[0]);
				if (verifierById.has(id)) {
					duplicateVerifierIds.push(id);
					continue;
				}
				batchOwnerLedgerRows.push(owner);
				verifierRowLedger.push({ id, verdict: result.verdict, severity: result.severity, owner });
			}
			if (verifierById.has(id)) {
				duplicateVerifierIds.push(id);
				continue;
			}
			verifierById.set(id, result);
		}
	}

	const evidenceFindings = [];
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

		const rawVerdict = String(verifier.verdict ?? "").trim().toUpperCase();
		if (!VERDICTS.has(rawVerdict)) {
			const invalid = {
				reason: "invalid_verdict",
				id,
				verdict: verifier.verdict ?? null,
				result: verifier,
			};
			invalidVerifierResults.push(invalid);
			needsHuman.push({
				source: "invalid-verdict",
				id,
				title: candidate.title ?? id,
				reason: `invalid verifier verdict: ${String(verifier.verdict ?? "")}`,
				invalidVerifierResult: invalid,
			});
			continue;
		}
		const verdict = normalizeVerdict(rawVerdict);
		const severity = normalizeSeverity(verifier.severity, candidate.severity);
		const evidence = Array.isArray(verifier.evidence) ? verifier.evidence : [];
		const counterEvidence = Array.isArray(verifier.counterEvidence) ? verifier.counterEvidence : [];
		const evidenceGate = await gateDisposition(id, verdict, evidence, counterEvidence, context);
		evidenceFindings.push(evidenceGate);
		if (verdict !== "NEEDS_HUMAN" && !evidenceGate.complete) {
			needsHuman.push({
				source: "evidence-gate", id, title: candidate.title ?? id,
				verdict: "NEEDS_HUMAN", originalVerdict: verdict, evidence, counterEvidence,
				reason: `Unverified ${verdict}: exact local byte evidence required${verdict === "DROP" ? " in counterEvidence before removal" : ""}`,
				originalCandidate: candidate, evidenceGate,
			});
			continue;
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
				verdict, evidence, counterEvidence,
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

	const evidenceCoverage = await gateRequirementCoverage(requirementCoverage, context, finalFindings);
	const requirementReconciliation = reconcileRequirementCoverage(analysis.requirementCoverage, evidenceCoverage, finalFindings, requirementSource);
	const ownerLedger = batchOwnerLedgerRows;
	const ownerLedgerReconciliation = reconcileOwnerLedger(
		ownerLedger,
		verifierRowLedger,
	);
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

	const partition = {
		schema: "spec-review-partition-v1",
		evidenceGate: {
			protocol: EVIDENCE_PROTOCOL,
			complete: evidenceFindings.length === joinCandidates.size && evidenceFindings.length > 0 &&
				evidenceFindings.every(row => row.complete) && requirementReconciliation.complete &&
				needsHuman.length === 0 && sourceStatusSummary.metadataAvailable && sourceStatusSummary.total > 0 && sourceStatusSummary.nonCompleted === 0,
			findings: evidenceFindings,
			coverage: evidenceCoverage,
			requirementReconciliation,
		},
		sourceStatusSummary,
		verifierCoverage: {
			// Batch membership, including deterministic fallback IDs, is the
			// authoritative coverage universe. Do not report raw id-less or
			// duplicate candidate rows as independently covered candidates.
			// Empty owner/verifier ledgers are never complete.
			complete: ownerLedgerReconciliation.passed,
			candidateCount: batchMode ? joinCandidates.size : candidateFindings.length,
			uniqueCandidateCount: joinCandidates.size,
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
			ownerLedger,
			batchOwnerLedger: ownerLedger,
			verifierRows: verifierRowLedger,
			ownerLedgerReconciliation,
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
	return {
		...partition,
		digest: `sha256:${createHash("sha256").update(stableStringify(partition)).digest("hex")}`,
	};
}

// --- batched verifier row collection ------------------------------------------

function buildBatchMembership(batchSource) {
	const byBatchId = new Map();
	const candidatesById = new Map();
	const issues = [];
	const candidateBatchIds = new Map();
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
			if (!id) {
				issues.push({
					reason: "batch_membership_candidate_missing_id",
					batchId,
				});
				continue;
			}
			const title =
				typeof candidate.title === "string" ? candidate.title.trim() : "";
			if (members.has(id)) {
				issues.push({
					reason: "duplicate_batch_membership_candidate_id",
					batchId,
					id,
				});
				continue;
			}
			members.set(id, { id, title, titleKey: titleKeyOf(title) });
			if (!candidatesById.has(id)) candidatesById.set(id, candidate);
		}
		const candidateIds = Array.isArray(batch.candidateIds)
			? batch.candidateIds
			: [];
		for (const rawId of candidateIds) {
			const id = normalizeId(rawId);
			if (!id) {
				issues.push({ reason: "batch_membership_candidate_id_missing", batchId });
				continue;
			}
			if (members.has(id)) continue;
			members.set(id, { id, title: "", titleKey: "" });
		}
		for (const id of members.keys()) {
			const batchesForId = candidateBatchIds.get(id) ?? [];
			batchesForId.push(batchId);
			candidateBatchIds.set(id, batchesForId);
		}
		byBatchId.set(batchId, members);
	}
	for (const [id, batchIds] of candidateBatchIds) {
		if (batchIds.length > 1) {
			issues.push({
				reason: "candidate_in_multiple_verification_batches",
				id,
				batchIds,
			});
		}
		// `candidateIds` is the authoritative batch join set. A member that was
		// declared only by id still gets a stub so it cannot disappear from
		// coverage accounting or be replaced by title/array-position matching.
		if (!candidatesById.has(id)) candidatesById.set(id, { id });
	}
	return { byBatchId, candidatesById, issues };
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

function batchOwnerFromStatus(status, sourceId, verifyStage, batchMembership) {
	if (!status || typeof status !== "object") return null;
	const specId = typeof status.specId === "string" ? status.specId.trim() : "";
	const batchId = specId.startsWith(`${verifyStage}.`)
		? specId.slice(verifyStage.length + 1).trim()
		: "";
	const source = typeof status.source === "string" ? status.source.trim() : "";
	const itemIdentity = typeof status.itemIdentity === "string" ? status.itemIdentity.trim() : "";
	const placeholderSpecId = typeof status.placeholderSpecId === "string" ? status.placeholderSpecId.trim() : "";
	if (
		source !== sourceId ||
		status.stageId !== verifyStage ||
		status.status !== "completed" ||
		typeof status.taskId !== "string" || !status.taskId.trim() ||
		!batchId || !batchMembership.byBatchId.has(batchId) ||
		itemIdentity !== batchId ||
		placeholderSpecId !== `${verifyStage}.item`
	) return null;
	return {
		source,
		stageId: verifyStage,
		specId,
		taskId: status.taskId.trim(),
		batchId,
		itemIdentity,
		placeholderSpecId,
		status: status.status,
	};
}

function batchOwnerLedger(sources, verifyStage, sourceStatuses, batchMembership) {
	const statuses = Array.isArray(sourceStatuses) ? sourceStatuses : [];
	return Object.keys(sources ?? {})
		.filter((sourceId) => sourceId === verifyStage || sourceId.startsWith(`${verifyStage}.`))
		.map((sourceId) => {
			const owners = statuses.filter((status) =>
				status && typeof status === "object" && status.source === sourceId,
			);
			const owner = owners.length === 1
				? batchOwnerFromStatus(owners[0], sourceId, verifyStage, batchMembership)
				: null;
			return owner ?? {
				source: sourceId,
				stageId: verifyStage,
				specId: "",
				taskId: "",
				batchId: "",
				itemIdentity: "",
				placeholderSpecId: "",
				status: owners[0]?.status ?? "missing",
			};
		});
}

function batchSourceStatusIssues(sources, verifyStage, sourceStatuses, batchMembership) {
	const statuses = Array.isArray(sourceStatuses) ? sourceStatuses : [];
	const issues = [];
	const ownerLedger = batchOwnerLedger(sources, verifyStage, statuses, batchMembership);
	for (const [index, owner] of ownerLedger.entries()) {
		const owners = statuses.filter((status) =>
			status && typeof status === "object" && status.source === owner.source,
		);
		if (owners.length !== 1 || !batchOwnerFromStatus(owners[0], owner.source, verifyStage, batchMembership)) {
			issues.push({
				reason: owners.length === 0
					? "missing_materialized_verifier_status"
					: owners.length !== 1
						? "verifier_alias_not_bound_to_exactly_one_materialized_status"
						: "verifier_source_status_identity_mismatch",
				sourceId: owner.source,
				batchId: owner.batchId,
				ownerIndex: index,
				expectedBatchIds: [...batchMembership.byBatchId.keys()],
			});
		}
	}
	return { issues, ownerLedger };
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
	for (const [sourceId, source] of Object.entries(sources ?? {}).sort(
		([left], [right]) => left.localeCompare(right),
	)) {
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
	if (row.evidence.some((item) => typeof item !== "string" && !isLocalCitation(item)))
		return "malformed_batch_row_invalid_evidence_item";
	if (!Array.isArray(row.counterEvidence))
		return "malformed_batch_row_missing_counterEvidence_array";
	if (row.counterEvidence.some((item) => typeof item !== "string" && !isLocalCitation(item)))
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
	const matches = Object.entries(sources ?? {}).filter(
		([specId]) => specId === stageId || specId.startsWith(`${stageId}.`),
	);
	if (matches.length > 1) {
		throw new Error(
			`spec-review: ambiguous ${stageId} source (${matches.map(([specId]) => specId).join(", ")})`,
		);
	}
	return matches[0]?.[1] ?? null;
}

function singletonVerifierStatuses(statuses, sourceId, expectedSpecId) {
	// Bind on the exact materialized spec id and canonical verifier stage.
	// A source alias alone must never authorize an unrelated task.
	const verifyStage = sourceId.split(".")[0] ||
		expectedSpecId.slice(0, expectedSpecId.indexOf("."));
	return (Array.isArray(statuses) ? statuses : []).filter(
		(status) => status && typeof status === "object" &&
			typeof status.specId === "string" &&
			status.specId.toLowerCase() === expectedSpecId.toLowerCase() &&
			(status.source === sourceId || status.source === verifyStage),
	);
}

function singletonVerifierStatusIsExact(status, verifyStage, findingId, sourceId) {
	const specItem = typeof status?.specId === "string" &&
		status.specId.startsWith(`${verifyStage}.`)
		? status.specId.slice(verifyStage.length + 1)
		: "";
	return Boolean(
		status &&
		status.status === "completed" &&
		status.stageId === verifyStage &&
		(status.source === sourceId || status.source === verifyStage) &&
		specItem &&
		specItem.toLowerCase() === findingId.toLowerCase() &&
		status.itemIdentity === findingId &&
		status.placeholderSpecId === `${verifyStage}.item` &&
		typeof status.taskId === "string" &&
		status.taskId.trim(),
	);
}

function singletonOwnerFromStatus(status) {
	return {
		source: status.source,
		stageId: status.stageId,
		specId: status.specId,
		taskId: status.taskId.trim(),
		itemIdentity: status.itemIdentity,
		placeholderSpecId: status.placeholderSpecId,
		status: status.status,
	};
}

function ownerKey(owner) {
	return [
		owner?.source,
		owner?.stageId,
		owner?.specId,
		owner?.taskId,
		owner?.itemIdentity,
		owner?.placeholderSpecId,
		owner?.batchId ?? "",
		owner?.status,
	].map((value) => String(value ?? "")).join("\\u001f");
}

function ownerComplete(owner) {
	return Boolean(owner &&
		[owner.source, owner.specId, owner.taskId, owner.itemIdentity, owner.placeholderSpecId]
			.every((value) => typeof value === "string" && value.trim()) &&
		owner.status === "completed");
}

function ownerIdentity(owner) {
	return String(owner?.batchId ?? owner?.itemIdentity ?? "").trim();
}

function verifierIdentity(row) {
	return String(row?.id ?? "").trim();
}

function ownerBindingIdentity(row) {
	return String(row?.batchId ?? row?.id ?? "").trim();
}

function reconcileOwnerLedger(ownerLedger, verifierRows) {
	const ownerKeys = new Set(ownerLedger.map(ownerKey));
	const ownerIds = ownerLedger.map(ownerIdentity);
	const verifierIds = verifierRows.map(verifierIdentity);
	const duplicateOwnerIds = ownerIds.filter(
		(id, index) => !id || ownerIds.indexOf(id) !== index,
	);
	const duplicateVerifierIds = verifierIds.filter(
		(id, index) => !id || verifierIds.indexOf(id) !== index,
	);
	const missingOwnerRows = verifierRows
		.filter((row) =>
			!row.owner ||
			!ownerKeys.has(ownerKey(row.owner)) ||
			ownerIdentity(row.owner) !== ownerBindingIdentity(row),
		)
		.map((row) => row.id);
	const orphanOwnerRows = ownerLedger
		.filter((owner) => !verifierRows.some((row) => row.owner && ownerKey(row.owner) === ownerKey(owner)))
		.map(ownerIdentity);
	const statusMismatches = verifierRows
		.filter((row) => !row.owner || row.owner.status !== "completed")
		.map((row) => row.id);
	const ownerRowsHaveCompleteIds = ownerLedger.every((owner) =>
		ownerComplete(owner) && ownerIdentity(owner),
	);
	const verifierRowsHaveIds = verifierRows.every((row) => verifierIdentity(row));
	// A batch carrier may own multiple verifier rows, but both ledgers must have
	// positive cardinality and unique identities. Empty joins are never complete.
	const cardinalityPassed = ownerLedger.length > 0 && verifierRows.length > 0 &&
		ownerLedger.length <= verifierRows.length && ownerRowsHaveCompleteIds &&
		verifierRowsHaveIds && duplicateOwnerIds.length === 0 &&
		duplicateVerifierIds.length === 0;
	return {
		ownerRowCount: ownerLedger.length,
		verifierRowCount: verifierRows.length,
		ownerIds,
		verifierIds,
		duplicateOwnerIds: [...new Set(duplicateOwnerIds)],
		duplicateVerifierIds: [...new Set(duplicateVerifierIds)],
		missingOwnerRows,
		orphanOwnerRows,
		statusMismatches,
		cardinalityPassed,
		passed: cardinalityPassed && missingOwnerRows.length === 0 &&
			orphanOwnerRows.length === 0 && statusMismatches.length === 0,
	};
}

function findVerifierResults(sources, verifyStage) {
	return Object.entries(sources ?? {})
		.filter(([key]) => key === verifyStage || key.startsWith(`${verifyStage}.`))
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([sourceId, value]) => ({ sourceId, value }))
		.filter(({ value }) => value && typeof value === "object");
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

function summarizeSourceStatuses(context) {
	const metadataAvailable = Array.isArray(context?.sourceStatuses);
	const normalized = metadataAvailable
		? context.sourceStatuses.map((status) => {
				if (!status || typeof status !== "object" || Array.isArray(status)) {
					return {
						status: "invalid_source_status_metadata",
						errorType: "source_status_not_object",
					};
				}
				const slim = slimSourceStatus(status);
				if (!slim.source && !slim.specId && !slim.taskId) {
					return {
						...slim,
						status: "invalid_source_status_metadata",
						errorType: "source_status_missing_identity",
					};
				}
				return slim;
			})
		: [];
	const seen = new Set();
	const statuses = normalized
		.sort((left, right) => sourceStatusKey(left).localeCompare(sourceStatusKey(right)))
		.map((status) => {
			const key = `${status.specId ?? ""}|${status.taskId ?? ""}|${status.source ?? ""}`;
			if (!key.replace(/\|/g, "") || !seen.has(key)) {
				seen.add(key);
				return status;
			}
			return {
				...status,
				status: "inconsistent_duplicate_source_status",
				errorType: "duplicate_source_status_identity",
			};
		});
	const failures = statuses.filter((status) => status.status !== "completed");
	return {
		metadataAvailable,
		total: statuses.length,
		completed: statuses.length - failures.length,
		nonCompleted: failures.length,
		partialFailures: failures.slice(0, MAX_PARTIAL_FAILURES),
		...(failures.length > MAX_PARTIAL_FAILURES
			? { omittedPartialFailures: failures.length - MAX_PARTIAL_FAILURES }
			: {}),
	};
}

function slimSourceStatus(status) {
	const text = (value, max = 500) =>
		typeof value === "string" && value.trim()
			? value.replace(/\s+/g, " ").trim().slice(0, max)
			: undefined;
	return {
		...(text(status.source, 200) ? { source: text(status.source, 200) } : {}),
		...(text(status.specId, 200) ? { specId: text(status.specId, 200) } : {}),
		...(text(status.taskId, 200) ? { taskId: text(status.taskId, 200) } : {}),
		...(text(status.stageId, 200) ? { stageId: text(status.stageId, 200) } : {}),
		status: text(status.status, 100) ?? "unknown",
		...(text(status.statusDetail, 200)
			? { statusDetail: text(status.statusDetail, 200) }
			: {}),
		...(text(status.errorType, 200)
			? { errorType: text(status.errorType, 200) }
			: {}),
		...(text(status.lastMessage) ? { lastMessage: text(status.lastMessage) } : {}),
	};
}

function sourceStatusKey(status) {
	return `${status.specId ?? ""}|${status.taskId ?? ""}|${status.source ?? ""}|${status.status ?? ""}`;
}

function stableStringify(value) {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
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
