// Deterministic claim audit for deep-research.
//
// Sources: plan (optional), normalize-claims (optional), verify-claims foreach
// outputs. For every verifier result this support helper:
//   1. rejoins the original claim text and factSlotIds from
//      normalize-claims.claimInventory.verificationCandidates by id (the
//      verifier echo is not trusted for identity fields),
//   2. applies deterministic evidence gates (verified requires structured,
//      source-backed evidence; exact quantitative claims require a source ref),
//   3. partitions claims by final status and counts them so the synthesis
//      stage consumes code-computed buckets instead of re-deriving them,
//   4. cross-checks plan.factSlots against normalize-claims.factSlotCoverage
//      and reports slots the normalizer silently dropped.

function asArray(value) {
	if (Array.isArray(value)) return value;
	if (value && typeof value === "object") {
		if (Array.isArray(value.auditedClaims)) return value.auditedClaims;
		if (Array.isArray(value.claims)) return value.claims;
		if (Array.isArray(value.claimVerdicts)) return value.claimVerdicts;
		if (Array.isArray(value.verdicts)) return value.verdicts;
		if (Array.isArray(value.items)) return value.items;
		if (
			"status" in value ||
			"verdict" in value ||
			"verdictDigest" in value ||
			"claimId" in value ||
			"id" in value
		)
			return [value];
		return Object.values(value).flatMap(asArray);
	}
	return [];
}

function collectUrls(value, urls = new Set()) {
	if (typeof value === "string") {
		for (const match of value.matchAll(/https?:\/\/[^\s)\]}"]+/g))
			urls.add(match[0]);
		return urls;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectUrls(item, urls);
		return urls;
	}
	if (value && typeof value === "object") {
		for (const item of Object.values(value)) collectUrls(item, urls);
	}
	return urls;
}

function looksLikeLocalSourceRef(value) {
	const text = String(value ?? "").trim();
	return /^(?:\.?[\w.-]+\/)?[\w./-]+\.(?:md|json|ya?ml|ts|tsx|js|mjs|cjs|py|go|rs|zig|txt)$/i.test(
		text,
	);
}

function collectEvidenceRefs(claim) {
	const refs = new Set([...collectUrls(claim)]);
	for (const row of Array.isArray(claim?.evidence) ? claim.evidence : []) {
		if (!row || typeof row !== "object") continue;
		for (const value of [row.url, row.source, row.file, row.path, row.sourceRef]) {
			if (typeof value !== "string") continue;
			if (/^https?:\/\//i.test(value) || isWorkflowSourceRef(value) || looksLikeLocalSourceRef(value))
				refs.add(value.trim());
		}
	}
	return refs;
}

function collectWorkflowSourceRefs(value, refs = new Set()) {
	if (typeof value === "string") {
		for (const match of value.matchAll(/\bwsrc_[a-f0-9]{32}\b/g)) refs.add(match[0]);
		return refs;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectWorkflowSourceRefs(item, refs);
		return refs;
	}
	if (value && typeof value === "object") {
		for (const item of Object.values(value)) collectWorkflowSourceRefs(item, refs);
	}
	return refs;
}

function isWorkflowSourceRef(value) {
	return /^wsrc_[a-f0-9]{32}$/.test(String(value ?? "").trim());
}

function sourceUrlArray(value) {
	if (!Array.isArray(value)) return [];
	return value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim());
}

function stripCitationUrlPunctuation(value) {
	return String(value ?? "")
		.trim()
		.replace(/[.,;:]+$/u, "");
}

function canonicalUrlKeys(value) {
	const raw = stripCitationUrlPunctuation(value);
	if (!/^https?:\/\//i.test(raw)) return [];
	const keys = new Set([raw]);
	try {
		const url = new URL(raw);
		url.protocol = url.protocol.toLowerCase();
		url.hostname = url.hostname.toLowerCase();
		url.hash = "";
		const serialized = stripCitationUrlPunctuation(url.toString());
		keys.add(serialized);
		if (url.pathname !== "/" && url.pathname.endsWith("/")) {
			url.pathname = url.pathname.replace(/\/+$/u, "");
			keys.add(stripCitationUrlPunctuation(url.toString()));
		}
	} catch {
		// Keep the trimmed raw URL key only; malformed strings should not throw from
		// the evidence gate.
	}
	return [...keys].filter(Boolean);
}

function addUrlSourceRef(urlToSourceRef, url, sourceRef) {
	if (!isWorkflowSourceRef(sourceRef)) return;
	for (const key of canonicalUrlKeys(url)) {
		if (!urlToSourceRef.has(key)) urlToSourceRef.set(key, sourceRef.trim());
	}
}

function buildUrlSourceRefLookup(normalizeInputPacket) {
	const urlToSourceRef = new Map();
	const sourceCards = asArray(normalizeInputPacket?.packet?.research?.sources);
	for (const source of sourceCards) {
		if (!source || typeof source !== "object") continue;
		addUrlSourceRef(urlToSourceRef, source.url, source.sourceRef);
	}
	const sourceRefIndex = asArray(normalizeInputPacket?.packet?.research?.sourceRefIndex);
	for (const source of sourceRefIndex) {
		if (!source || typeof source !== "object") continue;
		addUrlSourceRef(urlToSourceRef, source.url, source.sourceRef);
	}
	return urlToSourceRef;
}

function sourceRefsForUrls(urls, urlToSourceRef) {
	const refs = [];
	const seen = new Set();
	for (const url of urls) {
		for (const key of canonicalUrlKeys(url)) {
			const sourceRef = urlToSourceRef.get(key);
			if (!sourceRef || seen.has(sourceRef)) continue;
			seen.add(sourceRef);
			refs.push(sourceRef);
		}
	}
	return refs;
}

// Structured evidence check: at least one evidence row carrying both a source
// reference (HTTP URL or local repository file path) and a quote/excerpt. Unlike
// a keyword scan over the serialized claim, this cannot be satisfied by merely
// mentioning a URL/path in prose.
function hasFetchedEvidence(claim) {
	return Array.isArray(claim?.evidence) && claim.evidence.some(hasStrongEvidenceRow);
}

function hasStrongEvidenceRow(row) {
	if (!row || typeof row !== "object") return false;
	const refs = [row.url, row.source, row.file, row.path, row.sourceRef].filter(
		(value) => typeof value === "string",
	);
	const sourceRef = refs.some(
		(value) =>
			/^https?:\/\//i.test(value) ||
			isWorkflowSourceRef(value) ||
			looksLikeLocalSourceRef(value),
	);
	const quote = typeof row.quote === "string" && row.quote.trim().length > 0;
	if (!sourceRef || !quote) return false;
	if (isCandidateEvidenceRow(row)) return false;
	return true;
}

function isCandidateEvidenceRow(row) {
	return row?.candidateOnly === true || row?.matchType === "terms" || row?.sourceRead?.matchType === "terms";
}

function hasExactQuantitativeClaim(value) {
	const text = JSON.stringify(value ?? "");
	return /\b\d+(?:\.\d+)?\s*(?:%|percent|ms|s|sec|seconds|minutes|hours|x|×|usd|\$|k|m|b|tokens?|users?|samples?|n\s*=)\b/i.test(
		text,
	);
}

function verdictOf(claim) {
	return (
		claim?.status ??
		claim?.verdict ??
		claim?.verdictDigest?.status ??
		claim?.verdictDigest?.verdict ??
		"unverified"
	);
}

function withVerdict(claim, verdict, reason) {
	const previous = verdictOf(claim);
	const gate = { previous, verdict, reason };
	return {
		...claim,
		status: verdict,
		verdict,
		evidenceGate: gate,
		verdictDigest: {
			...(claim?.verdictDigest ?? {}),
			status: verdict,
			verdict,
			evidenceGate: gate,
		},
	};
}

function claimIdOf(claim) {
	if (!claim || typeof claim !== "object")
		return { id: null, reason: "not_an_object" };
	let invalid = null;
	for (const field of ["id", "claimId"]) {
		if (!(field in claim)) continue;
		if (typeof claim[field] !== "string") {
			invalid ??= { id: null, reason: "non_string_claim_id", field };
			continue;
		}
		const id = claim[field].trim();
		if (!id) {
			invalid ??= { id: null, reason: "blank_claim_id", field };
			continue;
		}
		return { id, field };
	}
	return invalid ?? { id: null, reason: "missing_claim_id" };
}

function compactStrings(values) {
	const out = [];
	const seen = new Set();
	for (const value of values) {
		if (typeof value !== "string") continue;
		const text = value.trim();
		if (!text || seen.has(text)) continue;
		seen.add(text);
		out.push(text);
	}
	return out;
}

function canonicalVerifierStatus(status) {
	return status === "partiallySupported" ? "partially_supported" : status;
}

function conservativeVerifierStatus(statuses) {
	const normalized = statuses.map(canonicalVerifierStatus);
	for (const status of [
		"conflicting",
		"unsupported",
		"partially_supported",
		"unverified",
	]) {
		if (normalized.includes(status)) return status;
	}
	if (normalized.every((status) => status === "verified")) return "verified";
	return normalized.find((status) => typeof status === "string" && status) ?? "unverified";
}

function issueForVerifierRow({ sourceId, claim, reason, claimId, index }) {
	return {
		sourceId,
		...(Number.isInteger(index) ? { index } : {}),
		...(claimId ? { claimId } : {}),
		reason,
		status: verdictOf(claim),
		nextStep:
			reason === "unknown_claim_id"
				? "Verify-claims output did not match any normalized verification candidate; quarantine it from claim counts."
				: "Verifier output is missing a usable string id/claimId; rerun or repair the verifier row before counting it.",
	};
}

function gapForVerifierIssue(issue) {
	return {
		...(issue.claimId ? { claimId: issue.claimId } : {}),
		evidenceState: issue.reason,
		reason: issue.reason,
		nextStep: issue.nextStep,
	};
}

function mergeVerifierRows(rows) {
	const first = rows[0];
	if (rows.length === 1) return { sourceId: first.sourceId, claim: first.claim, duplicate: null };
	const sourceIds = rows.map((row) => row.sourceId);
	const statusInputs = rows.map((row) => verdictOf(row.claim));
	const selectedStatus = conservativeVerifierStatus(statusInputs);
	const selectedRow =
		rows.find((row) => canonicalVerifierStatus(verdictOf(row.claim)) === selectedStatus) ??
		first;
	const merged = { ...selectedRow.claim };
	const evidence = rows.flatMap((row) =>
		Array.isArray(row.claim?.evidence) ? row.claim.evidence : [],
	);
	if (evidence.length > 0) merged.evidence = evidence;
	for (const field of ["sourceRefs", "sourceUrls", "factSlotIds"]) {
		const values = compactStrings(rows.flatMap((row) => row.claim?.[field] ?? []));
		if (values.length > 0) merged[field] = values;
	}
	merged.status = selectedStatus;
	merged.verdict = selectedStatus;
	merged.verdictDigest = {
		...(merged.verdictDigest ?? {}),
		status: selectedStatus,
		verdict: selectedStatus,
		duplicateVerifierRows: {
			rowCount: rows.length,
			sourceIds,
			statusInputs,
			selectedStatus,
		},
	};
	return {
		sourceId: selectedRow.sourceId,
		claim: merged,
		duplicate: {
			claimId: first.claimId,
			rowCount: rows.length,
			sourceIds,
			statusInputs,
			selectedStatus,
			action: "merged_evidence_and_selected_conservative_status",
		},
	};
}

const STATUS_BUCKETS = {
	verified: "verified",
	partially_supported: "partiallySupported",
	unsupported: "unsupported",
	conflicting: "conflicting",
};

function findSource(sources, stageId) {
	for (const [specId, source] of Object.entries(sources ?? {})) {
		if (specId === stageId || specId.startsWith(`${stageId}.`)) return source;
	}
	return null;
}

export default async function claimEvidenceGate({ sources, options = {} }) {
	const plan = findSource(sources, "plan");
	const normalized = findSource(sources, "normalize-claims");
	const normalizeInputPacket = findSource(sources, "normalize-input-packet");
	const urlToSourceRef = buildUrlSourceRefLookup(normalizeInputPacket);
	const candidateRecords = [];
	const candidatesById = new Map();
	const invalidNormalizedCandidates = [];
	for (const [index, candidate] of asArray(
		normalized?.claimInventory?.verificationCandidates,
	).entries()) {
		const idCheck = claimIdOf(candidate);
		if (!idCheck.id) {
			invalidNormalizedCandidates.push({
				index,
				reason: idCheck.reason,
				nextStep:
					"normalize-claims emitted a verification candidate without a usable string id; it cannot be deterministically joined.",
			});
			continue;
		}
		if (candidatesById.has(idCheck.id)) {
			invalidNormalizedCandidates.push({
				index,
				claimId: idCheck.id,
				reason: "duplicate_normalized_candidate_id",
				nextStep:
					"normalize-claims emitted duplicate candidate ids; only the first candidate is canonical for verifier joins.",
			});
			continue;
		}
		const normalizedCandidate = { ...candidate, id: idCheck.id };
		candidateRecords.push(normalizedCandidate);
		candidatesById.set(idCheck.id, normalizedCandidate);
	}

	const claims = Object.entries(sources ?? {})
		.filter(
			([specId]) =>
				specId === "verify-claims" || specId.startsWith("verify-claims."),
		)
		.flatMap(([sourceId, source]) =>
			asArray(source).map((claim, index) => ({ sourceId, claim, index })),
		);
	// Legacy layout: when no verify-claims.* source ids exist (for example a
	// single from: string dependency), fall back to every non-plan/non-normalize
	// source.
	const verifierClaims =
		claims.length > 0
			? claims
			: Object.entries(sources ?? {})
					.filter(
						([specId]) =>
							!specId.startsWith("plan") &&
							!specId.startsWith("normalize-claims") &&
							!specId.startsWith("normalize-input-packet"),
					)
					.flatMap(([sourceId, source]) =>
						asArray(source).map((claim, index) => ({ sourceId, claim, index })),
					);

	const auditedClaims = [];
	const remainingGaps = [];
	const identityJoinNotes = [];
	const sourceRefJoinFailures = [];
	const invalidVerifierRows = [];
	const duplicateVerifierRows = [];
	const gateSummary = {
		total: 0,
		unchanged: 0,
		downgraded: 0,
		identityRejoined: 0,
		sourceRefsRejoined: 0,
		sourceRefsBackfilledFromUrls: 0,
		sourceRefJoinFailures: 0,
		verifierRowsTotal: verifierClaims.length,
		validVerifierRows: 0,
		invalidVerifierRows: 0,
		missingVerifierResults: 0,
		duplicateVerifierClaims: 0,
		duplicateVerifierRows: 0,
		duplicateStatusConflicts: 0,
		invalidNormalizedCandidates: invalidNormalizedCandidates.length,
	};
	const verifierRowsById = new Map();
	const legacyVerifierRows = [];
	for (const { sourceId, claim, index } of verifierClaims) {
		const idCheck = claimIdOf(claim);
		if (!idCheck.id) {
			const issue = issueForVerifierRow({
				sourceId,
				claim,
				index,
				reason: idCheck.reason,
			});
			invalidVerifierRows.push(issue);
			remainingGaps.push(gapForVerifierIssue(issue));
			gateSummary.invalidVerifierRows += 1;
			continue;
		}
		if (candidateRecords.length > 0 && !candidatesById.has(idCheck.id)) {
			const issue = issueForVerifierRow({
				sourceId,
				claim,
				index,
				claimId: idCheck.id,
				reason: "unknown_claim_id",
			});
			invalidVerifierRows.push(issue);
			remainingGaps.push(gapForVerifierIssue(issue));
			gateSummary.invalidVerifierRows += 1;
			continue;
		}
		const row = {
			sourceId,
			claimId: idCheck.id,
			claim: { ...claim, [idCheck.field ?? "id"]: idCheck.id },
		};
		gateSummary.validVerifierRows += 1;
		if (candidateRecords.length > 0) {
			const rows = verifierRowsById.get(idCheck.id) ?? [];
			rows.push(row);
			verifierRowsById.set(idCheck.id, rows);
		} else {
			legacyVerifierRows.push(row);
		}
	}

	function auditClaim({ sourceId, claim, candidate, claimId, missingVerifierResult = false }) {
		if (!claim || typeof claim !== "object") return;
		gateSummary.total += 1;
		const evidenceRefs = [...collectEvidenceRefs(claim)];
		const workflowSourceRefs = new Set([...collectWorkflowSourceRefs(claim)]);
		const exactQuantitative = hasExactQuantitativeClaim(claim);
		const fetched = hasFetchedEvidence(claim);
		let next = {
			...claim,
			...(claimId ? { id: claimId } : {}),
			...(sourceId ? { sourceId } : {}),
			sourceUrls: evidenceRefs,
			evidenceRefs,
		};
		if (missingVerifierResult) {
			next = withVerdict(
				next,
				"unverified",
				"normalized verification candidate had no verifier result",
			);
		}

		// Identity join: the normalizer's candidate record is authoritative for
		// claim id, claim text, and factSlotIds. Verifier echoes drift.
		if (candidate) {
			if (claimId) next.id = claimId;
			if (
				typeof candidate.claim === "string" &&
				candidate.claim &&
				next.claim !== candidate.claim
			) {
				if (next.claim)
					identityJoinNotes.push(
						`claim ${claimId}: verifier restated claim text; original restored`,
					);
				next.claim = candidate.claim;
				gateSummary.identityRejoined += 1;
			}
			if (Array.isArray(candidate.factSlotIds))
				next.factSlotIds = [...candidate.factSlotIds];
			const beforeSourceRefCount = workflowSourceRefs.size;
			for (const sourceRef of collectWorkflowSourceRefs(candidate))
				workflowSourceRefs.add(sourceRef);
			if (workflowSourceRefs.size > beforeSourceRefCount)
				gateSummary.sourceRefsRejoined += 1;
		}
		const beforeUrlBackfillSourceRefCount = workflowSourceRefs.size;
		for (const sourceRef of sourceRefsForUrls(
			[
				...sourceUrlArray(candidate?.sourceUrls),
				...evidenceRefs.filter((ref) => /^https?:\/\//i.test(ref)),
			],
			urlToSourceRef,
		))
			workflowSourceRefs.add(sourceRef);
		if (workflowSourceRefs.size > beforeUrlBackfillSourceRefCount) {
			gateSummary.sourceRefsRejoined += 1;
			gateSummary.sourceRefsBackfilledFromUrls +=
				workflowSourceRefs.size - beforeUrlBackfillSourceRefCount;
		}
		if (workflowSourceRefs.size > 0) next.sourceRefs = [...workflowSourceRefs];
		if (
			claimId &&
			candidate &&
			workflowSourceRefs.size === 0 &&
			(sourceUrlArray(candidate.sourceUrls).length > 0 ||
				evidenceRefs.some((ref) => /^https?:\/\//i.test(ref)))
		) {
			const failure = {
				claimId,
				evidenceState: "source_ref_not_available",
				sourceUrls: [
					...new Set([
						...sourceUrlArray(candidate?.sourceUrls),
						...evidenceRefs.filter((ref) => /^https?:\/\//i.test(ref)),
					]),
				],
				nextStep:
					"Preserve sourceRefs from workflow_web_fetch_source through research and normalization when available.",
			};
			sourceRefJoinFailures.push(failure);
			gateSummary.sourceRefJoinFailures += 1;
		}

		const verdict = verdictOf(next);
		if (
			verdict === "verified" &&
			options.requireFetchedEvidenceForVerified !== false &&
			!fetched
		) {
			next = withVerdict(
				next,
				"partially_supported",
				"verified claim lacked structured evidence rows with both source reference and quote",
			);
		}
		if (
			verdictOf(next) === "verified" &&
			options.downgradeExactQuantitativeWithoutSource !== false &&
			exactQuantitative &&
			evidenceRefs.length === 0
		) {
			next = withVerdict(
				next,
				"partially_supported",
				"exact quantitative claim lacked structured source reference evidence",
			);
		}

		if (verdictOf(next) !== verdict) {
			gateSummary.downgraded += 1;
			remainingGaps.push({
				claimId: next.id ?? next.claimId,
				evidenceState: "insufficient_for_verified",
				sourceUrls: evidenceRefs,
				nextStep:
					"Fetch or inspect primary source evidence for the exact claim before using it as verified.",
			});
		} else {
			gateSummary.unchanged += 1;
		}
		auditedClaims.push(next);
	}

	if (candidateRecords.length > 0) {
		for (const candidate of candidateRecords) {
			const rows = verifierRowsById.get(candidate.id) ?? [];
			if (rows.length === 0) {
				gateSummary.missingVerifierResults += 1;
				remainingGaps.push({
					claimId: candidate.id,
					evidenceState: "missing_verifier_result",
					reason: "normalized verification candidate had no verifier result",
					sourceUrls: sourceUrlArray(candidate.sourceUrls),
					relatedFactSlotIds: Array.isArray(candidate.factSlotIds)
						? [...candidate.factSlotIds]
						: [],
					nextStep:
						"Run or repair the verifier for this normalized candidate before treating the claim as supported.",
				});
				auditClaim({
					sourceId: null,
					claim: candidate,
					candidate,
					claimId: candidate.id,
					missingVerifierResult: true,
				});
				continue;
			}
			const merged = mergeVerifierRows(rows);
			if (merged.duplicate) {
				const statuses = merged.duplicate.statusInputs.map((status) =>
					status === "partiallySupported" ? "partially_supported" : status,
				);
				const hasStatusConflict = new Set(statuses).size > 1;
				const duplicate = { ...merged.duplicate, statusConflict: hasStatusConflict };
				duplicateVerifierRows.push(duplicate);
				gateSummary.duplicateVerifierClaims += 1;
				gateSummary.duplicateVerifierRows += rows.length - 1;
				if (hasStatusConflict) {
					gateSummary.duplicateStatusConflicts += 1;
					remainingGaps.push({
						claimId: candidate.id,
						evidenceState: "duplicate_verifier_rows_conflicting",
						reason:
							"multiple verifier rows for the same normalized candidate disagreed; the gate selected a conservative status",
						nextStep:
							"Inspect duplicate verify-claims outputs before using this claim as a hard decision threshold.",
					});
				}
			}
			auditClaim({
				sourceId: merged.sourceId,
				claim: merged.claim,
				candidate,
				claimId: candidate.id,
			});
		}
	} else {
		for (const row of legacyVerifierRows) {
			auditClaim({
				sourceId: row.sourceId,
				claim: row.claim,
				candidate: null,
				claimId: row.claimId,
			});
		}
	}

	// Deterministic status partition + counts for the synthesis stage.
	const statusPartitions = {
		verified: [],
		partiallySupported: [],
		unsupported: [],
		conflicting: [],
		other: [],
	};
	for (const claim of auditedClaims) {
		const bucket = STATUS_BUCKETS[verdictOf(claim)] ?? "other";
		statusPartitions[bucket].push(claim.id ?? claim.claimId ?? null);
	}
	const verdictCounts = Object.fromEntries(
		Object.entries(statusPartitions).map(([bucket, ids]) => [
			bucket,
			ids.length,
		]),
	);

	// Slot coverage cross-check: planned slots that the normalizer dropped.
	const plannedSlotIds = asArray(plan?.factSlots)
		.map((slot) =>
			slot && typeof slot === "object" && typeof slot.id === "string"
				? slot.id
				: null,
		)
		.filter(Boolean);
	const coveredSlotIds = new Set(
		asArray(normalized?.factSlotCoverage)
			.map((slot) =>
				slot && typeof slot === "object" && typeof slot.slotId === "string"
					? slot.slotId
					: null,
			)
			.filter(Boolean),
	);
	const droppedSlotIds = plannedSlotIds.filter((id) => !coveredSlotIds.has(id));
	for (const slotId of droppedSlotIds) {
		remainingGaps.push({
			slotId,
			evidenceState: "slot_missing_from_coverage",
			nextStep:
				"normalize-claims omitted this planned fact slot from factSlotCoverage; treat as a coverage gap.",
		});
	}

	// Compact per-claim digest for the synthesis stage's source-context budget;
	// auditedClaims (with full evidence rows) stays in the artifact as audit trail.
	const claimDigests = auditedClaims.map((claim) => ({
		id: claim.id ?? claim.claimId ?? null,
		claim: claim.claim,
		factSlotIds: claim.factSlotIds,
		status: verdictOf(claim),
		confidence: claim.confidence,
		sourceRefs: claim.sourceRefs,
		sourceUrls: claim.sourceUrls,
		verdictDigest: claim.verdictDigest,
		correctionOrCounterclaim: claim.correctionOrCounterclaim,
	}));

	return {
		auditedClaims,
		claimDigests,
		gateSummary,
		remainingGaps,
		sourceRefJoinFailures,
		invalidVerifierRows,
		duplicateVerifierRows,
		invalidNormalizedCandidates,
		statusPartitions,
		verdictCounts,
		slotCoverageCheck: {
			plannedSlotCount: plannedSlotIds.length,
			coveredSlotCount: coveredSlotIds.size,
			droppedSlotIds,
		},
		identityJoinNotes,
	};
}
