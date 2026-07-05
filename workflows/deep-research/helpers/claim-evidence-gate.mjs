import {
	VERIFICATION_STATUS,
	VERIFICATION_STATUS_BUCKETS,
	canonicalVerificationStatus,
} from "./verification-ontology.mjs";

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
		if (
			"status" in value ||
			"verdict" in value ||
			"verdictDigest" in value ||
			"claimId" in value ||
			"id" in value
		)
			return [value];
		if (Array.isArray(value.results)) return value.results;
		if (Array.isArray(value.claims)) return value.claims;
		if (Array.isArray(value.claimVerdicts)) return value.claimVerdicts;
		if (Array.isArray(value.verdicts)) return value.verdicts;
		if (Array.isArray(value.items)) return value.items;
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
	const text = String(value ?? "")
		.trim()
		.replace(/^(?:file|repo):/i, "")
		.replace(/#L\d+(?:-L?\d+)?$/i, "");
	return /^(?:\.?[\w.-]+\/)?[\w./-]+\.(?:md|json|ya?ml|ts|tsx|js|mjs|cjs|py|go|rs|zig|txt|sol|java|kt|swift|rb|php|c|cc|cpp|h|hpp)$/i.test(
		text,
	);
}

function collectEvidenceRefs(claim) {
	const refs = new Set([...collectUrls(claim)]);
	for (const row of Array.isArray(claim?.evidence) ? claim.evidence : []) {
		if (!row || typeof row !== "object") continue;
		for (const value of [
			row.url,
			row.source,
			row.file,
			row.path,
			row.sourceRef,
		]) {
			if (typeof value !== "string") continue;
			if (
				/^https?:\/\//i.test(value) ||
				isWorkflowSourceRef(value) ||
				looksLikeLocalSourceRef(value)
			)
				refs.add(value.trim());
		}
	}
	return refs;
}

function addLocalEvidenceRef(refs, value) {
	if (typeof value !== "string") return;
	const text = value.trim();
	if (!text || /^https?:\/\//i.test(text) || isWorkflowSourceRef(text)) return;
	if (looksLikeLocalSourceRef(text)) refs.add(text);
}

function collectLocalEvidenceRefs(claim) {
	const refs = new Set();
	if (!claim || typeof claim !== "object") return refs;
	for (const key of ["file", "path", "repoPath", "localPath", "sourceRef"]) {
		addLocalEvidenceRef(refs, claim[key]);
	}
	for (const value of Array.isArray(claim.sourceRefs) ? claim.sourceRefs : []) {
		addLocalEvidenceRef(refs, value);
	}
	for (const row of Array.isArray(claim.evidence) ? claim.evidence : []) {
		if (!row || typeof row !== "object") continue;
		for (const key of [
			"file",
			"path",
			"repoPath",
			"localPath",
			"source",
			"sourceRef",
		]) {
			addLocalEvidenceRef(refs, row[key]);
		}
	}
	return refs;
}

function collectWorkflowSourceRefs(value, refs = new Set()) {
	if (typeof value === "string") {
		for (const match of value.matchAll(/\bwsrc_[a-f0-9]{32}\b/g))
			refs.add(match[0]);
		return refs;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectWorkflowSourceRefs(item, refs);
		return refs;
	}
	if (value && typeof value === "object") {
		for (const item of Object.values(value))
			collectWorkflowSourceRefs(item, refs);
	}
	return refs;
}

function isWorkflowSourceRef(value) {
	return /^wsrc_[a-f0-9]{32}$/.test(String(value ?? "").trim());
}

function sourceUrlArray(value) {
	if (!Array.isArray(value)) return [];
	return value
		.filter((item) => typeof item === "string" && item.trim())
		.map((item) => item.trim());
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
		addNpmDocsVersionAgnosticKey(keys, url);
		if (url.pathname !== "/" && url.pathname.endsWith("/")) {
			url.pathname = url.pathname.replace(/\/+$/u, "");
			keys.add(stripCitationUrlPunctuation(url.toString()));
			addNpmDocsVersionAgnosticKey(keys, url);
		}
	} catch {
		// Keep the trimmed raw URL key only; malformed strings should not throw from
		// the evidence gate.
	}
	return [...keys].filter(Boolean);
}

function addNpmDocsVersionAgnosticKey(keys, url) {
	if (url.hostname !== "docs.npmjs.com") return;
	if (!/^\/cli\/(?:v\d+\/)?using-npm\//u.test(url.pathname)) return;
	const versionless = new URL(url.toString());
	versionless.pathname = versionless.pathname.replace(
		/^\/cli\/v\d+\//u,
		"/cli/",
	);
	keys.add(stripCitationUrlPunctuation(versionless.toString()));
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
	return (
		Array.isArray(claim?.evidence) && claim.evidence.some(hasStrongEvidenceRow)
	);
}

function hasStrongEvidenceRow(row) {
	if (!row || typeof row !== "object") return false;
	const refs = [row.url, row.source, row.file, row.path, row.sourceRef].filter(
		(value) => typeof value === "string",
	);
	const hasExternalRef = refs.some(
		(value) => /^https?:\/\//i.test(value) || isWorkflowSourceRef(value),
	);
	const hasLocalRef = refs.some((value) => looksLikeLocalSourceRef(value));
	const hasLocatedLocalRef =
		hasLocalRef &&
		(refs.some(hasLineFragment) || hasLocalEvidenceLocation(row));
	const sourceRef = hasExternalRef || hasLocatedLocalRef;
	const quote = typeof row.quote === "string" && row.quote.trim().length > 0;
	if (!sourceRef || !quote) return false;
	if (isCandidateEvidenceRow(row)) return false;
	return true;
}

function hasLineFragment(value) {
	return /#L\d+(?:-L?\d+)?$/i.test(String(value ?? "").trim());
}

function hasLocalEvidenceLocation(row) {
	return [
		row.line,
		row.lineStart,
		row.lineEnd,
		row.lines,
		row.excerptLocation,
	].some(
		(value) =>
			typeof value === "number" ||
			(typeof value === "string" && value.trim().length > 0),
	);
}

function isCandidateEvidenceRow(row) {
	return (
		row?.candidateOnly === true ||
		row?.matchType === "terms" ||
		row?.sourceRead?.matchType === "terms"
	);
}

function strongEvidenceIssue(claim) {
	const rows = Array.isArray(claim?.evidence) ? claim.evidence : [];
	if (rows.length === 0) return "missing_structured_evidence_rows";
	if (rows.some(isCandidateEvidenceRow))
		return "candidate_only_evidence_not_strong";
	return "evidence_rows_missing_source_or_quote";
}

function hasExactQuantitativeClaim(value) {
	const text = JSON.stringify(value ?? "");
	return /\b\d+(?:\.\d+)?\s*(?:(?:%|×|\$|n\s*=)|(?:percent|ms|s|sec|seconds|minutes|hours|x|usd|k|m|b|tokens?|users?|samples?)\b)/i.test(
		text,
	);
}

function verdictOf(claim) {
	const status =
		claim?.status ??
		claim?.verdict ??
		claim?.verdictDigest?.status ??
		claim?.verdictDigest?.verdict ??
		"unverified";
	return canonicalVerifierStatus(status);
}

function withVerdict(claim, verdict, reason, details = {}) {
	const previous = verdictOf(claim);
	const gate = { previous, verdict, reason, ...details };
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
	return canonicalVerificationStatus(status);
}

function conservativeVerifierStatus(statuses) {
	const normalized = statuses.map(canonicalVerifierStatus);
	for (const status of [
		VERIFICATION_STATUS.CONFLICTING,
		VERIFICATION_STATUS.UNSUPPORTED,
		VERIFICATION_STATUS.VERIFICATION_BLOCKED,
		VERIFICATION_STATUS.PARTIALLY_SUPPORTED,
		VERIFICATION_STATUS.UNVERIFIED,
	]) {
		if (normalized.includes(status)) return status;
	}
	if (normalized.every((status) => status === VERIFICATION_STATUS.VERIFIED))
		return VERIFICATION_STATUS.VERIFIED;
	return (
		normalized.find((status) => typeof status === "string" && status) ??
		VERIFICATION_STATUS.UNVERIFIED
	);
}

function issueForVerifierRow({
	sourceId,
	claim,
	reason,
	claimId,
	index,
	...details
}) {
	return {
		sourceId,
		...(Number.isInteger(index) ? { index } : {}),
		...(claimId ? { claimId } : {}),
		...details,
		reason,
		status: verdictOf(claim),
		nextStep:
			reason === "unknown_claim_id"
				? "Verify-claims output did not match any normalized verification candidate; quarantine it from claim counts."
				: reason === "batch_result_id_not_in_source_batch"
					? "Verifier batch output included a claim id outside the source batch; rerun or repair the batch before counting any row."
					: reason === "unknown_verification_batch_id"
						? "Verifier batch output came from an unknown batch id; rerun or repair the batch before counting any row."
						: "Verifier output is missing a usable string id/claimId; rerun or repair the verifier row before counting it.",
	};
}

function asBatchArray(value) {
	if (Array.isArray(value?.batches)) return value.batches;
	if (Array.isArray(value)) return value;
	return [];
}

function buildBatchMembershipById(verificationBatches) {
	const batches = new Map();
	for (const batch of asBatchArray(verificationBatches)) {
		const id = typeof batch?.id === "string" ? batch.id.trim() : "";
		if (!id) continue;
		const claimIds = Array.isArray(batch.claimIds)
			? batch.claimIds
			: Array.isArray(batch.claims)
				? batch.claims.map(
						(claim, index) =>
							claimIdOf(claim).id ??
							`candidate-${String(index + 1).padStart(3, "0")}`,
					)
				: [];
		batches.set(
			id,
			new Set(
				claimIds
					.filter((claimId) => typeof claimId === "string")
					.map((claimId) => claimId.trim())
					.filter(Boolean),
			),
		);
	}
	return batches;
}

function verifierBatchId(sourceId) {
	const prefix = "verify-claims.";
	if (typeof sourceId !== "string" || !sourceId.startsWith(prefix)) return null;
	const id = sourceId.slice(prefix.length).trim();
	return id || null;
}

function buildBatchIdBySourceName(sourceStatuses) {
	const bySource = new Map();
	for (const status of Array.isArray(sourceStatuses) ? sourceStatuses : []) {
		const source = typeof status?.source === "string" ? status.source : "";
		const batchId = verifierBatchId(status?.specId);
		if (source && batchId) bySource.set(source, batchId);
	}
	return bySource;
}

function batchMembershipIssue({
	sourceId,
	claimId,
	batchMembershipById,
	batchIdBySourceName,
}) {
	if (!(batchMembershipById instanceof Map) || batchMembershipById.size === 0)
		return null;
	const batchId =
		verifierBatchId(sourceId) ?? batchIdBySourceName?.get(sourceId);
	if (!batchId) return null;
	const expectedClaimIds = batchMembershipById.get(batchId);
	if (!expectedClaimIds) {
		return {
			reason: "unknown_verification_batch_id",
			batchId,
			expectedBatchIds: [...batchMembershipById.keys()],
		};
	}
	if (!expectedClaimIds.has(claimId)) {
		return {
			reason: "batch_result_id_not_in_source_batch",
			batchId,
			expectedClaimIds: [...expectedClaimIds],
		};
	}
	return null;
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
	if (rows.length === 1)
		return { sourceId: first.sourceId, claim: first.claim, duplicate: null };
	const sourceIds = rows.map((row) => row.sourceId);
	const statusInputs = rows.map((row) => verdictOf(row.claim));
	const selectedStatus = conservativeVerifierStatus(statusInputs);
	const selectedRow =
		rows.find(
			(row) => canonicalVerifierStatus(verdictOf(row.claim)) === selectedStatus,
		) ?? first;
	const merged = { ...selectedRow.claim };
	const evidence = rows.flatMap((row) =>
		Array.isArray(row.claim?.evidence) ? row.claim.evidence : [],
	);
	if (evidence.length > 0) merged.evidence = evidence;
	for (const field of ["sourceRefs", "sourceUrls", "factSlotIds"]) {
		const values = compactStrings(
			rows.flatMap((row) => row.claim?.[field] ?? []),
		);
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

function buildBatchAdoptionReadiness({ gateSummary, candidateCount }) {
	const checks = [
		["invalid_verifier_rows", gateSummary.invalidVerifierRows],
		["missing_verifier_results", gateSummary.missingVerifierResults],
		["duplicate_verifier_rows", gateSummary.duplicateVerifierRows],
		["duplicate_status_conflicts", gateSummary.duplicateStatusConflicts],
		["invalid_normalized_candidates", gateSummary.invalidNormalizedCandidates],
		["source_ref_join_failures", gateSummary.sourceRefJoinFailures],
	];
	const blockers = checks
		.filter(([, count]) => Number(count ?? 0) > 0)
		.map(([reason, count]) => ({ reason, count }));
	if (candidateCount === 0)
		blockers.push({ reason: "no_verification_candidates", count: 0 });
	return {
		status: blockers.length === 0 ? "eligible_for_canary" : "blocked",
		adopted: false,
		canaryRequired: true,
		reason:
			blockers.length === 0
				? "Verifier identity/sourceRef integrity is clean; batch adoption still requires a non-holdout canary before use."
				: "Batch adoption is blocked until verifier identity/sourceRef integrity issues are resolved.",
		blockers,
	};
}

const STATUS_BUCKETS = VERIFICATION_STATUS_BUCKETS;

function findSource(sources, stageId) {
	for (const [specId, source] of Object.entries(sources ?? {})) {
		if (specId === stageId || specId.startsWith(`${stageId}.`)) return source;
	}
	return null;
}

export default async function claimEvidenceGate({
	sources,
	options = {},
	context = {},
}) {
	const plan = findSource(sources, "plan");
	const normalizeClaims = findSource(sources, "normalize-claims");
	const sanitizedCandidates = findSource(sources, "sanitize-claims");
	const normalized = sanitizedCandidates ?? normalizeClaims;
	const verificationBatches = findSource(sources, "verification-batches");
	const batchMembershipById = buildBatchMembershipById(verificationBatches);
	const batchIdBySourceName = buildBatchIdBySourceName(context.sourceStatuses);
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
	// source. Exclude sanitizer sources because they are canonicalizer inputs, not
	// verifier verdict rows.
	const verifierClaims =
		claims.length > 0
			? claims
			: Object.entries(sources ?? {})
					.filter(
						([specId]) =>
							!specId.startsWith("plan") &&
							!specId.startsWith("normalize-claims") &&
							!specId.startsWith("normalize-input-packet") &&
							!specId.startsWith("sanitize-claims"),
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
		const batchIssue = batchMembershipIssue({
			sourceId,
			claimId: idCheck.id,
			batchMembershipById,
			batchIdBySourceName,
		});
		if (batchIssue) {
			const issue = issueForVerifierRow({
				sourceId,
				claim,
				index,
				claimId: idCheck.id,
				...batchIssue,
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

	function auditClaim({
		sourceId,
		claim,
		candidate,
		claimId,
		missingVerifierResult = false,
	}) {
		if (!claim || typeof claim !== "object") return;
		gateSummary.total += 1;
		const evidenceRefs = [...collectEvidenceRefs(claim)];
		const localEvidenceRefs = new Set([
			...collectLocalEvidenceRefs(claim),
			...collectLocalEvidenceRefs(candidate),
		]);
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
		const httpSourceUrls = [
			...new Set([
				...sourceUrlArray(candidate?.sourceUrls).filter((ref) =>
					/^https?:\/\//i.test(ref),
				),
				...evidenceRefs.filter((ref) => /^https?:\/\//i.test(ref)),
			]),
		];
		if (
			claimId &&
			candidate &&
			workflowSourceRefs.size === 0 &&
			localEvidenceRefs.size === 0 &&
			httpSourceUrls.length > 0
		) {
			const failure = {
				claimId,
				evidenceState: "source_ref_not_available",
				sourceUrls: httpSourceUrls,
				nextStep:
					"Preserve sourceRefs from workflow_web_fetch_source through research and normalization when available.",
			};
			sourceRefJoinFailures.push(failure);
			gateSummary.sourceRefJoinFailures += 1;
		}

		const verdict = verdictOf(next);
		const exactQuantitativeForGate =
			exactQuantitative || hasExactQuantitativeClaim(next);
		if (
			verdict === "verified" &&
			options.requireFetchedEvidenceForVerified !== false &&
			!fetched
		) {
			const reasonCode =
				options.downgradeExactQuantitativeWithoutSource !== false &&
				exactQuantitativeForGate &&
				evidenceRefs.length === 0
					? "exact_quantitative_without_source_reference"
					: strongEvidenceIssue(next);
			next = withVerdict(
				next,
				"partially_supported",
				"verified claim lacked structured evidence rows with both source reference and quote",
				{ reasonCode },
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
				{ reasonCode: "exact_quantitative_without_source_reference" },
			);
		}

		if (verdictOf(next) !== verdict) {
			gateSummary.downgraded += 1;
			remainingGaps.push({
				claimId: next.id ?? next.claimId,
				evidenceState:
					next.evidenceGate?.reasonCode ?? "insufficient_for_verified",
				reason: next.evidenceGate?.reason,
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
				const duplicate = {
					...merged.duplicate,
					statusConflict: hasStatusConflict,
				};
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
		verificationBlocked: [],
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
	const batchAdoptionReadiness = buildBatchAdoptionReadiness({
		gateSummary,
		candidateCount: candidateRecords.length,
	});

	return {
		auditedClaims,
		claimDigests,
		gateSummary,
		batchAdoptionReadiness,
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
		precisionGuardDiagnostics:
			normalizeInputPacket?.packet?.precisionGuard?.summary,
	};
}
