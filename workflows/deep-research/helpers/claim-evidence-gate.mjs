import { readFile } from "node:fs/promises";
import { join } from "node:path";
import localQuoteGate from "./local-quote-gate.mjs";

import {
	VERIFICATION_STATUS,
	VERIFICATION_STATUS_BUCKETS,
	canonicalVerificationStatus,
} from "./verification-ontology.mjs";

// Deterministic claim audit for deep-research.
//
// Sources: plan (optional), normalize-claims (optional), and foreach outputs
// from verify-claims, verify-core-claims, or verify-tail-claims. For every
// verifier result this support helper:
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

function verifierRows(value) {
	if (Array.isArray(value)) return value;
	if (!value || typeof value !== "object") return [];
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

async function addWebSourceCacheSourceRefs(urlToSourceRef, context) {
	const cwd = typeof context?.cwd === "string" ? context.cwd.trim() : "";
	const runId = typeof context?.runId === "string" ? context.runId.trim() : "";
	if (!cwd || !runId) return;
	let parsed;
	try {
		parsed = JSON.parse(
			await readFile(
				join(cwd, ".pi", "workflows", runId, "web-source-cache", "index.json"),
				"utf8",
			),
		);
	} catch {
		return;
	}
	for (const source of asArray(parsed?.sources)) {
		if (!source || typeof source !== "object") continue;
		addUrlSourceRef(urlToSourceRef, source.url, source.sourceRef);
		addUrlSourceRef(urlToSourceRef, source.redactedUrl, source.sourceRef);
	}
}

async function buildUrlSourceRefLookup(normalizeInputPacket, context) {
	const urlToSourceRef = new Map();
	const sourceCards = asArray(normalizeInputPacket?.packet?.research?.sources);
	for (const source of sourceCards) {
		if (!source || typeof source !== "object") continue;
		addUrlSourceRef(urlToSourceRef, source.url, source.sourceRef);
	}
	await addWebSourceCacheSourceRefs(urlToSourceRef, context);
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

function emptySourceIdentities() {
	return { workflowRefs: new Set(), urlKeys: new Set(), localRefs: new Set() };
}

function normalizeLocalSourceRef(value) {
	const text = String(value ?? "")
		.trim()
		.replace(/^(?:file|repo):/i, "")
		.replace(/#L\d+(?:-L?\d+)?$/i, "")
		.replace(/^\.\//u, "");
	return text || null;
}

function addSourceIdentity(identities, value, urlToSourceRef) {
	if (Array.isArray(value)) {
		for (const item of value)
			addSourceIdentity(identities, item, urlToSourceRef);
		return;
	}
	if (typeof value !== "string") return;
	const text = value.trim();
	if (!text) return;
	if (/^https?:\/\//i.test(text)) {
		for (const key of canonicalUrlKeys(text)) identities.urlKeys.add(key);
		for (const sourceRef of sourceRefsForUrls([text], urlToSourceRef))
			identities.workflowRefs.add(sourceRef);
		return;
	}
	if (isWorkflowSourceRef(text)) {
		identities.workflowRefs.add(text);
		return;
	}
	if (looksLikeLocalSourceRef(text)) {
		const local = normalizeLocalSourceRef(text);
		if (local) identities.localRefs.add(local);
	}
}

function collectSourceIdentitiesFromObject(value, identities, urlToSourceRef) {
	if (Array.isArray(value)) {
		for (const item of value)
			collectSourceIdentitiesFromObject(item, identities, urlToSourceRef);
		return identities;
	}
	if (!value || typeof value !== "object") return identities;
	for (const key of [
		"sourceRef",
		"sourceRefs",
		"source",
		"url",
		"sourceUrl",
		"sourceUrls",
		"file",
		"path",
		"repo",
		"repoPath",
		"localPath",
	]) {
		addSourceIdentity(identities, value[key], urlToSourceRef);
	}
	for (const key of ["sourceRead", "sourceCard", "sourceEvidence"])
		collectSourceIdentitiesFromObject(value[key], identities, urlToSourceRef);
	return identities;
}

function candidateSourceIdentities(candidate, urlToSourceRef) {
	const identities = emptySourceIdentities();
	if (!candidate || typeof candidate !== "object") return identities;
	for (const ref of Array.isArray(candidate.sourceRefs)
		? candidate.sourceRefs
		: [])
		addSourceIdentity(identities, ref, urlToSourceRef);
	for (const url of Array.isArray(candidate.sourceUrls)
		? candidate.sourceUrls
		: [])
		addSourceIdentity(identities, url, urlToSourceRef);
	collectSourceIdentitiesFromObject(
		candidate.sourceEvidenceHints,
		identities,
		urlToSourceRef,
	);
	collectSourceIdentitiesFromObject(
		candidate.evidence,
		identities,
		urlToSourceRef,
	);
	for (const key of [
		"sourceRef",
		"sourceRefs",
		"source",
		"url",
		"sourceUrl",
		"sourceUrls",
		"file",
		"path",
		"repo",
		"repoPath",
		"localPath",
	])
		addSourceIdentity(identities, candidate[key], urlToSourceRef);
	return identities;
}

function evidenceRowSourceIdentities(row, urlToSourceRef) {
	const identities = emptySourceIdentities();
	collectSourceIdentitiesFromObject(row, identities, urlToSourceRef);
	return identities;
}

function hasSourceIdentities(identities) {
	return (
		identities.workflowRefs.size > 0 ||
		identities.urlKeys.size > 0 ||
		identities.localRefs.size > 0
	);
}

function identityIntersection(left, right) {
	const matched = { workflowRefs: [], urlKeys: [], localRefs: [] };
	for (const key of Object.keys(matched)) {
		for (const value of left[key]) {
			if (right[key].has(value)) matched[key].push(value);
		}
	}
	return matched;
}

function hasIdentityIntersection(left, right) {
	const matched = identityIntersection(left, right);
	return Object.values(matched).some((values) => values.length > 0);
}

function sourceIdentityHosts(identities) {
	const hosts = new Set();
	for (const key of identities.urlKeys) {
		try {
			const url = new URL(key);
			if (url.hostname) hosts.add(url.hostname.toLowerCase());
		} catch {
			// Ignore malformed keys; exact URL matching already handled them.
		}
	}
	return hosts;
}

function hasHostIntersection(left, right) {
	const leftHosts = sourceIdentityHosts(left);
	if (leftHosts.size === 0) return false;
	for (const host of sourceIdentityHosts(right)) {
		if (leftHosts.has(host)) return true;
	}
	return false;
}

const SOURCE_COMPATIBILITY_STOPWORDS = new Set([
	"about",
	"after",
	"also",
	"and",
	"are",
	"but",
	"can",
	"for",
	"from",
	"has",
	"into",
	"its",
	"not",
	"only",
	"should",
	"that",
	"the",
	"their",
	"then",
	"this",
	"with",
	"without",
]);

function sourceCompatibilityTokens(value) {
	const tokens = String(value ?? "")
		.toLowerCase()
		.match(/[a-z0-9][a-z0-9-]{2,}/gu);
	return new Set(
		(tokens ?? []).filter(
			(token) => !SOURCE_COMPATIBILITY_STOPWORDS.has(token),
		),
	);
}

function evidenceRowText(row) {
	return [row?.quote, row?.excerpt, row?.title, row?.url, row?.source]
		.filter((value) => typeof value === "string" && value.trim())
		.join("\n");
}

function hasClaimEvidenceTokenOverlap(claim, candidate, row) {
	const claimTokens = sourceCompatibilityTokens(
		[candidate?.claim, claim?.claim].filter(Boolean).join("\n"),
	);
	const evidenceTokens = sourceCompatibilityTokens(evidenceRowText(row));
	let overlap = 0;
	for (const token of claimTokens) {
		if (evidenceTokens.has(token)) overlap += 1;
		if (overlap >= 3) return true;
	}
	return false;
}

function summarizeSourceIdentities(identities) {
	return {
		workflowRefs: [...identities.workflowRefs].sort(),
		urlKeys: [...identities.urlKeys].sort(),
		localRefs: [...identities.localRefs].sort(),
	};
}

function evaluateSourceCompatibility({
	claim,
	candidate,
	urlToSourceRef,
	refsNoneMultiClaimBlocked = false,
	allowAdditionalEvidenceSources = false,
}) {
	const candidateIdentities = candidateSourceIdentities(
		candidate,
		urlToSourceRef,
	);
	const strongRows = (
		Array.isArray(claim?.evidence) ? claim.evidence : []
	).filter(hasStrongEvidenceRow);
	if (refsNoneMultiClaimBlocked && !hasSourceIdentities(candidateIdentities)) {
		return {
			decision: "downgrade",
			reasonCode: "refs_none_multi_claim_batch_without_explicit_source_hints",
			reason:
				"verified batch row came from a refs:none multi-claim batch without explicit source hints",
			candidateSources: summarizeSourceIdentities(candidateIdentities),
		};
	}
	if (!hasSourceIdentities(candidateIdentities) || strongRows.length === 0) {
		return { decision: "allow" };
	}
	const compatibleRows = [];
	const unmatchedRows = [];
	const sameHostRows = [];
	for (const [index, row] of strongRows.entries()) {
		const rowIdentities = evidenceRowSourceIdentities(row, urlToSourceRef);
		const rowSummary = summarizeSourceIdentities(rowIdentities);
		if (hasIdentityIntersection(rowIdentities, candidateIdentities)) {
			compatibleRows.push({ index, sources: rowSummary });
		} else {
			unmatchedRows.push({ index, sources: rowSummary });
			if (hasHostIntersection(rowIdentities, candidateIdentities)) {
				sameHostRows.push({ index, sources: rowSummary, row });
			}
		}
	}
	if (compatibleRows.length === 0) {
		if (
			allowAdditionalEvidenceSources &&
			unmatchedRows.length > 0 &&
			sameHostRows.length === unmatchedRows.length &&
			sameHostRows.some(({ row }) =>
				hasClaimEvidenceTokenOverlap(claim, candidate, row),
			)
		) {
			return {
				decision: "allow",
				exception: "same_host_evidence_sources_explicitly_allowed",
				candidateSources: summarizeSourceIdentities(candidateIdentities),
				unmatchedEvidenceSources: unmatchedRows,
			};
		}
		return {
			decision: "downgrade",
			reasonCode: "evidence_source_mismatch",
			reason:
				"verified claim evidence did not overlap the candidate's source refs, URLs, hints, or local refs",
			candidateSources: summarizeSourceIdentities(candidateIdentities),
			unmatchedEvidenceSources: unmatchedRows,
		};
	}
	if (unmatchedRows.length > 0 && !allowAdditionalEvidenceSources) {
		return {
			decision: "downgrade",
			reasonCode: "additional_evidence_source_requires_review",
			reason:
				"verified claim used additional source-backed evidence outside the candidate source set; keep it for human review instead of silently adopting verified",
			candidateSources: summarizeSourceIdentities(candidateIdentities),
			compatibleEvidenceSources: compatibleRows,
			unmatchedEvidenceSources: unmatchedRows,
		};
	}
	return {
		decision: "allow",
		...(unmatchedRows.length > 0
			? {
					exception: "additional_evidence_sources_explicitly_allowed",
					compatibleEvidenceSources: compatibleRows,
					unmatchedEvidenceSources: unmatchedRows,
				}
			: {}),
	};
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

function sanitizeTaskId(value) {
	return String(value ?? "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_.-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

function batchClaimIds(batch) {
	return Array.isArray(batch?.claimIds)
		? batch.claimIds
		: Array.isArray(batch?.claims)
			? batch.claims.map(
					(claim, index) =>
						claimIdOf(claim).id ??
						`candidate-${String(index + 1).padStart(3, "0")}`,
				)
			: [];
}

function normalizedBatchClaimIds(batch) {
	return batchClaimIds(batch)
		.filter((claimId) => typeof claimId === "string")
		.map((claimId) => claimId.trim())
		.filter(Boolean);
}

function buildBatchMembershipById(verificationBatches) {
	const batches = new Map();
	for (const batch of asBatchArray(verificationBatches)) {
		const id = sanitizeTaskId(batch?.id);
		if (!id) continue;
		batches.set(id, new Set(normalizedBatchClaimIds(batch)));
	}
	return batches;
}

function buildBatchInfoByClaimId(verificationBatches) {
	const byClaimId = new Map();
	for (const batch of asBatchArray(verificationBatches)) {
		const batchId = typeof batch?.id === "string" ? batch.id.trim() : "";
		if (!batchId) continue;
		const claimIds = normalizedBatchClaimIds(batch);
		const info = {
			batchId,
			sourceKey: typeof batch?.sourceKey === "string" ? batch.sourceKey : null,
			claimCount: claimIds.length,
		};
		for (const claimId of claimIds) byClaimId.set(claimId, info);
	}
	return byClaimId;
}

function refsNoneMultiClaimBatchIssues({
	verificationBatches,
	candidatesById,
	urlToSourceRef,
}) {
	const issues = [];
	for (const batch of asBatchArray(verificationBatches)) {
		const batchId = typeof batch?.id === "string" ? batch.id.trim() : "";
		const sourceKey =
			typeof batch?.sourceKey === "string" ? batch.sourceKey : "";
		const claimIds = normalizedBatchClaimIds(batch);
		if (!batchId || sourceKey !== "refs:none" || claimIds.length <= 1) continue;
		const claimIdsWithoutExplicitSources = claimIds.filter((claimId) => {
			const candidate = candidatesById?.get(claimId);
			return !hasSourceIdentities(
				candidateSourceIdentities(candidate, urlToSourceRef),
			);
		});
		if (claimIdsWithoutExplicitSources.length === 0) continue;
		issues.push({
			batchId,
			sourceKey,
			claimIds,
			claimIdsWithoutExplicitSources,
			reason: "refs_none_multi_claim_batch_without_explicit_source_hints",
		});
	}
	return issues;
}

function verifierBatchId(sourceId, stageId = "verify-claims") {
	const prefix = `${stageId}.`;
	if (typeof sourceId !== "string" || !sourceId.startsWith(prefix)) return null;
	return sanitizeTaskId(sourceId.slice(prefix.length)) || null;
}

function verifierStageForSource(sourceId) {
	for (const stageId of ["verify-claims", "verify-core-claims", "verify-tail-claims"]) {
		if (sourceId === stageId || sourceId.startsWith(`${stageId}.`)) return stageId;
	}
	return null;
}

function exactVerifierOwner(status, sourceId, claimId, stageId) {
	if (!status || typeof status !== "object" || !stageId) return null;
	const source = typeof status.source === "string" ? status.source.trim() : "";
	const specId = typeof status.specId === "string" ? status.specId.trim() : "";
	const itemIdentity = typeof status.itemIdentity === "string" ? status.itemIdentity.trim() : "";
	const placeholderSpecId = typeof status.placeholderSpecId === "string"
		? status.placeholderSpecId.trim()
		: "";
	const expectedSpecId = `${stageId}.${claimId}`;
	if (
		source !== sourceId ||
		status.stageId !== stageId ||
		status.status !== "completed" ||
		typeof status.taskId !== "string" || !status.taskId.trim() ||
		specId !== expectedSpecId ||
		itemIdentity !== claimId ||
		placeholderSpecId !== `${stageId}.item`
	) return null;
	return {
		source,
		stageId,
		specId,
		taskId: status.taskId.trim(),
		itemIdentity,
		placeholderSpecId,
		status: status.status,
	};
}

function verifierOwnerForRow(sourceStatuses, sourceId, claimId) {
	const stageId = verifierStageForSource(sourceId);
	const owners = (Array.isArray(sourceStatuses) ? sourceStatuses : []).filter(
		(status) => status && typeof status === "object" && status.source === sourceId,
	);
	return {
		stageId,
		owners,
		exact: owners.length === 1
			? exactVerifierOwner(owners[0], sourceId, claimId, stageId)
			: null,
	};
}

function exactVerifierBatchOwner(
	status,
	sourceId,
	stageId,
	batchId,
	batchMembershipById,
) {
	if (!status || typeof status !== "object" || !stageId || !batchId) return null;
	const source = typeof status.source === "string" ? status.source.trim() : "";
	const specId = typeof status.specId === "string" ? status.specId.trim() : "";
	const itemIdentity = typeof status.itemIdentity === "string" ? status.itemIdentity.trim() : "";
	const placeholderSpecId = typeof status.placeholderSpecId === "string"
		? status.placeholderSpecId.trim()
		: "";
	if (
		source !== sourceId ||
		status.stageId !== stageId ||
		status.status !== "completed" ||
		typeof status.taskId !== "string" || !status.taskId.trim() ||
		specId !== `${stageId}.${batchId}` ||
		!batchMembershipById.has(batchId) ||
		itemIdentity !== batchId ||
		placeholderSpecId !== `${stageId}.item`
	) return null;
	return {
		source,
		stageId,
		specId,
		taskId: status.taskId.trim(),
		batchId,
		itemIdentity,
		placeholderSpecId,
		status: status.status,
	};
}

function verifierBatchOwnerForSource(
	sourceStatuses,
	sourceId,
	batchMembershipById,
	batchIdBySourceName,
) {
	const stageId = verifierStageForSource(sourceId);
	const owners = (Array.isArray(sourceStatuses) ? sourceStatuses : []).filter(
		(status) => status && typeof status === "object" && status.source === sourceId,
	);
	const batchId =
		(stageId && verifierBatchId(sourceId, stageId)) ||
		batchIdBySourceName?.get(sourceId) ||
		null;
	return {
		stageId,
		batchId,
		owners,
		exact: owners.length === 1
			? exactVerifierBatchOwner(
					owners[0],
					sourceId,
					stageId,
					batchId,
					batchMembershipById,
				)
			: null,
	};
}

function buildBatchIdBySourceName(sourceStatuses) {
	const bySource = new Map();
	for (const status of Array.isArray(sourceStatuses) ? sourceStatuses : []) {
		const source = typeof status?.source === "string" ? status.source : "";
		const stageId = verifierStageForSource(source);
		const batchId = stageId ? verifierBatchId(status?.specId, stageId) : null;
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
	const stageId = verifierStageForSource(sourceId);
	const batchId =
		(stageId ? verifierBatchId(sourceId, stageId) : null) ??
		batchIdBySourceName?.get(sourceId);
	if (!batchId) {
		return {
			reason: "unknown_verification_batch_id",
			expectedBatchIds: [...batchMembershipById.keys()],
		};
	}
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

const REPO_LOCAL_SIGNAL_RE =
	/\b(?:local[_ -]?repo|repo(?:sitory)?|codebase|source tree|workspace|filesystem|local file|file path|static analysis|static audit)\b/iu;
const COMMON_REPO_PATH_RE =
	/(?:^|[\s"'`()])(?:\.\/|\.\.\/|src\/|test\/|tests\/|workflows\/|internal\/|docs\/|agents\/|skills\/|tools\/|package\.json|tsconfig\.json|README\.md)(?:[\s"'`),.:;]|\/|$)/iu;

function hasRepoLocalSignal(
	value,
	seen = new Set(),
	budget = { remaining: 200 },
) {
	if (budget.remaining <= 0) return false;
	if (typeof value === "string") {
		budget.remaining -= 1;
		const text = value.trim();
		return (
			looksLikeLocalSourceRef(text) ||
			REPO_LOCAL_SIGNAL_RE.test(text) ||
			COMMON_REPO_PATH_RE.test(text)
		);
	}
	if (Array.isArray(value)) {
		if (seen.has(value)) return false;
		seen.add(value);
		for (const item of value) {
			if (hasRepoLocalSignal(item, seen, budget)) return true;
		}
		return false;
	}
	if (!value || typeof value !== "object") return false;
	if (seen.has(value)) return false;
	seen.add(value);
	for (const [key, item] of Object.entries(value)) {
		budget.remaining -= 1;
		if (budget.remaining <= 0) return false;
		if (
			[
				"sourceType",
				"sourceQuality",
				"sourcePriority",
				"expectedSourceTypes",
			].includes(key) &&
			hasRepoLocalSignal(item, seen, budget)
		)
			return true;
		if (
			["file", "path", "repo", "repoPath", "localPath", "sourceRef"].includes(
				key,
			) &&
			(typeof item === "string" || Array.isArray(item)) &&
			hasRepoLocalSignal(item, seen, budget)
		)
			return true;
		if (hasRepoLocalSignal(item, seen, budget)) return true;
	}
	return false;
}

function plannedFactSlotIds(plan) {
	return asArray(plan?.factSlots)
		.map((slot) =>
			slot && typeof slot === "object" && typeof slot.id === "string"
				? slot.id
				: null,
		)
		.filter(Boolean);
}

function factSlotIdsForFloor(plan, normalized) {
	return compactStrings([
		...plannedFactSlotIds(plan),
		...asArray(normalized?.factSlotCoverage).flatMap((slot) =>
			slot && typeof slot === "object" ? [slot.slotId ?? slot.id] : [],
		),
	]);
}

function hasClaimBearingPlan(plan, normalized) {
	return (
		plannedFactSlotIds(plan).length > 0 ||
		asArray(plan?.verificationPriorities).length > 0 ||
		asArray(normalized?.factSlotCoverage).length > 0 ||
		asArray(normalized?.coverageGaps).length > 0 ||
		asArray(normalized?.claimInventory?.preservedClaims).length > 0
	);
}

function collectRepoLocalHints(value, hints = new Set(), seen = new Set()) {
	if (hints.size >= 6) return hints;
	if (typeof value === "string") {
		const text = value.trim();
		if (looksLikeLocalSourceRef(text)) hints.add(text);
		return hints;
	}
	if (Array.isArray(value)) {
		if (seen.has(value)) return hints;
		seen.add(value);
		for (const item of value) collectRepoLocalHints(item, hints, seen);
		return hints;
	}
	if (!value || typeof value !== "object") return hints;
	if (seen.has(value)) return hints;
	seen.add(value);
	for (const item of Object.values(value))
		collectRepoLocalHints(item, hints, seen);
	return hints;
}

function buildZeroCandidateFloorGap({
	plan,
	normalized,
	normalizeInputPacket,
}) {
	const explicitCandidateList = Array.isArray(
		normalized?.claimInventory?.verificationCandidates,
	);
	if (!explicitCandidateList) return null;
	if (!hasClaimBearingPlan(plan, normalized)) return null;
	if (
		!hasRepoLocalSignal(plan) &&
		!hasRepoLocalSignal(normalized) &&
		!hasRepoLocalSignal(normalizeInputPacket?.packet)
	)
		return null;
	return {
		evidenceState: "no_verification_candidates",
		reason:
			"repo-local/static claim-bearing research produced zero verification candidates; the verification floor did not run",
		sourceUrls: compactStrings(
			[...collectRepoLocalHints(plan), ...collectRepoLocalHints(normalized)],
			6,
		),
		relatedFactSlotIds: factSlotIdsForFloor(plan, normalized),
		whyItMatters:
			"Repo-local findings must be backed by verified local file evidence or exposed as an explicit gap.",
		nextStep:
			"Extract at least one source-backed local_repo verification candidate, or explicitly mark the task as non-claim/no-verification with tested justification.",
	};
}

function buildBatchAdoptionReadiness({ gateSummary, candidateCount }) {
	const checks = [
		["invalid_verifier_rows", gateSummary.invalidVerifierRows],
		["verifier_owner_issues", gateSummary.verifierOwnerIssues],
		["missing_verifier_results", gateSummary.missingVerifierResults],
		["duplicate_verifier_rows", gateSummary.duplicateVerifierRows],
		["duplicate_status_conflicts", gateSummary.duplicateStatusConflicts],
		["invalid_normalized_candidates", gateSummary.invalidNormalizedCandidates],
		["source_ref_join_failures", gateSummary.sourceRefJoinFailures],
		["refs_none_multi_claim_batches", gateSummary.refsNoneMultiClaimBatches],
		[
			"source_evidence_compatibility_failures",
			gateSummary.sourceEvidenceCompatibilityFailures,
		],
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
	const batchInfoByClaimId = buildBatchInfoByClaimId(verificationBatches);
	const batchIdBySourceName = buildBatchIdBySourceName(context.sourceStatuses);
	const normalizeInputPacket = findSource(sources, "normalize-input-packet");
	const urlToSourceRef = await buildUrlSourceRefLookup(
		normalizeInputPacket,
		context,
	);
	const rawVerificationCandidates = asArray(
		normalized?.claimInventory?.verificationCandidates,
	);
	const candidateRecords = [];
	const candidatesById = new Map();
	const invalidNormalizedCandidates = [];
	for (const [index, candidate] of rawVerificationCandidates.entries()) {
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
	const refsNoneBatchIssues = refsNoneMultiClaimBatchIssues({
		verificationBatches,
		candidatesById,
		urlToSourceRef,
	});
	const refsNoneMultiClaimBlockedClaimIds = new Set(
		refsNoneBatchIssues.flatMap(
			(issue) => issue.claimIdsWithoutExplicitSources,
		),
	);

	const verifierStageIds = [
		"verify-claims",
		"verify-core-claims",
		"verify-tail-claims",
	];
	const verifierClaims = Object.entries(sources ?? {})
		.filter(([specId]) =>
			verifierStageIds.some(
				(stageId) => specId === stageId || specId.startsWith(`${stageId}.`),
			),
		)
		.flatMap(([sourceId, source]) =>
			verifierRows(source).map((claim, index) => ({ sourceId, claim, index })),
		);

	const auditedClaims = [];
	const remainingGaps = [];
	const identityJoinNotes = [];
	const sourceRefJoinFailures = [];
	const invalidVerifierRows = [];
	const verifierOwnerIssues = [];
	const verifierOwnerLedger = [];
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
		refsNoneMultiClaimBatches: refsNoneBatchIssues.length,
		sourceEvidenceCompatibilityFailures: 0,
		sourceEvidenceCompatibilityMismatches: 0,
		verifierOwnerIssues: 0,
		additionalEvidenceSourceDowngrades: 0,
		zeroCandidateFloorBlockers: 0,
	};
	if (
		candidateRecords.length === 0 &&
		rawVerificationCandidates.length === 0 &&
		verifierClaims.length === 0
	) {
		const gap = buildZeroCandidateFloorGap({
			plan,
			normalized,
			normalizeInputPacket,
		});
		if (gap) {
			remainingGaps.push(gap);
			gateSummary.zeroCandidateFloorBlockers += 1;
		}
	}
	for (const issue of refsNoneBatchIssues) {
		remainingGaps.push({
			evidenceState: issue.reason,
			reason:
				"verification-batches emitted a refs:none multi-claim batch without explicit per-claim source hints",
			batchId: issue.batchId,
			claimIds: issue.claimIds,
			nextStep:
				"Split refs:none candidates into single-claim verifier tasks or preserve sourceRefs/sourceUrls/sourceEvidenceHints/local refs before batching.",
		});
	}
	const verifierRowsById = new Map();
	const legacyVerifierRows = [];
	const batchOwnerBySource = new Map();
	const batchOwnerIssueBySource = new Map();
	const hasMaterializedStatuses = Object.hasOwn(context, "sourceStatuses");
	// A batch carrier is a physical verifier task, not a claim identity. It must
	// nevertheless have one exact completed materialized owner before any of its
	// member rows can enter the audit ledger.
	if (batchMembershipById.size > 0 && hasMaterializedStatuses) {
		for (const [sourceId] of Object.entries(sources ?? {})) {
			const stageId = verifierStageForSource(sourceId);
			if (!stageId) continue;
			const ownerCheck = verifierBatchOwnerForSource(
				context.sourceStatuses,
				sourceId,
				batchMembershipById,
				batchIdBySourceName,
			);
			if (ownerCheck.exact) {
				batchOwnerBySource.set(sourceId, ownerCheck.exact);
				verifierOwnerLedger.push(ownerCheck.exact);
				continue;
			}
			// A bare carrier alias has no batch identity to bind. Leave that case
			// to the normal batch-membership gate, which reports unknown batch
			// identity rather than inventing an owner relationship.
			if (!ownerCheck.batchId) continue;
			const reason = ownerCheck.owners.length === 0
				? "missing_materialized_verifier_batch_owner"
				: ownerCheck.owners.length !== 1
					? "verifier_batch_source_not_bound_to_exactly_one_materialized_owner"
					: "verifier_batch_source_status_identity_mismatch";
			const issue = {
				sourceId,
				batchId: ownerCheck.batchId,
				ownerStageId: ownerCheck.stageId,
				reason,
				nextStep: "Repair the completed batch carrier status before accepting any member verifier row.",
			};
			batchOwnerIssueBySource.set(sourceId, issue);
			verifierOwnerIssues.push(issue);
			gateSummary.verifierOwnerIssues += 1;
		}
	}
	// Batch envelopes have a separate membership/row gate. The exact singleton
	// owner contract applies to the ordinary transparent foreach sources and
	// must not reinterpret a physical batch carrier as one claim owner.
	const strictOwnerMode = hasMaterializedStatuses && batchMembershipById.size === 0;
	for (const { sourceId, claim, index } of verifierClaims) {
		let owner;
		if (batchMembershipById.size > 0) {
			owner = batchOwnerBySource.get(sourceId);
			const ownerIssue = batchOwnerIssueBySource.get(sourceId);
			if (!owner && ownerIssue) {
				// Preserve a more specific batch-membership failure when a row is
				// also outside its carrier's declared batch. The carrier owner issue
				// remains in verifierOwnerIssues, so neither defect is hidden.
				const membershipIssue = batchMembershipIssue({
					sourceId,
					claimId: claimIdOf(claim).id,
					batchMembershipById,
					batchIdBySourceName,
				});
				if (!membershipIssue) {
					const idCheck = claimIdOf(claim);
					const issue = {
						...(idCheck.id ? { claimId: idCheck.id } : {}),
						sourceId,
						...ownerIssue,
					};
					invalidVerifierRows.push({ ...issue, row: index });
					remainingGaps.push(gapForVerifierIssue(issue));
					gateSummary.invalidVerifierRows += 1;
					continue;
				}
			}
		}
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
		if (strictOwnerMode) {
			const ownerCheck = verifierOwnerForRow(
				context.sourceStatuses,
				sourceId,
				idCheck.id,
			);
			owner = ownerCheck.exact;
			if (!owner) {
				const reason = ownerCheck.owners.length === 0
					? "missing_materialized_verifier_owner"
					: ownerCheck.owners.length !== 1
						? "verifier_source_not_bound_to_exactly_one_materialized_owner"
						: "verifier_source_status_identity_mismatch";
				const issue = issueForVerifierRow({
					sourceId,
					claim,
					index,
					claimId: idCheck.id,
					reason,
					ownerStageId: ownerCheck.stageId,
				});
				verifierOwnerIssues.push(issue);
				invalidVerifierRows.push(issue);
				remainingGaps.push(gapForVerifierIssue(issue));
				gateSummary.invalidVerifierRows += 1;
				gateSummary.verifierOwnerIssues += 1;
				continue;
			}
			verifierOwnerLedger.push(owner);
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
			...(owner ? { owner: { ...owner } } : {}),
			claim: {
				...claim,
				[idCheck.field ?? "id"]: idCheck.id,
				...(owner ? { verifierOwner: { ...owner } } : {}),
			},
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

	async function auditClaim({
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
		if (verdictOf(next) === VERIFICATION_STATUS.VERIFIED) {
			const batchInfo = claimId ? batchInfoByClaimId.get(claimId) : null;
			const compatibility = evaluateSourceCompatibility({
				claim: next,
				candidate,
				urlToSourceRef,
				refsNoneMultiClaimBlocked:
					!!claimId && refsNoneMultiClaimBlockedClaimIds.has(claimId),
				allowAdditionalEvidenceSources:
					options.allowAdditionalCorroboratingSourcesForVerified === true,
			});
			if (compatibility.decision === "downgrade") {
				gateSummary.sourceEvidenceCompatibilityFailures += 1;
				if (compatibility.reasonCode === "evidence_source_mismatch")
					gateSummary.sourceEvidenceCompatibilityMismatches += 1;
				if (
					compatibility.reasonCode ===
					"additional_evidence_source_requires_review"
				)
					gateSummary.additionalEvidenceSourceDowngrades += 1;
				next = withVerdict(
					next,
					VERIFICATION_STATUS.PARTIALLY_SUPPORTED,
					compatibility.reason,
					{
						reasonCode: compatibility.reasonCode,
						sourceCompatibility: {
							...compatibility,
							...(batchInfo ? { batchInfo } : {}),
						},
					},
				);
			} else if (compatibility.exception) {
				next.verdictDigest = {
					...(next.verdictDigest ?? {}),
					sourceCompatibility: {
						...compatibility,
						...(batchInfo ? { batchInfo } : {}),
					},
				};
			}
		}

		if (verdictOf(next) === VERIFICATION_STATUS.VERIFIED) {
			const localRows = await localQuoteGate(next.evidence, context, looksLikeLocalSourceRef);
			if (localRows.length > 0) next.localQuoteGate = localRows;
			const failed = localRows.filter((row) => row.status !== "verified");
			if (failed.length > 0) {
				next = withVerdict(next, VERIFICATION_STATUS.PARTIALLY_SUPPORTED,
					"local evidence quote did not match the cited file/range or could not be read",
					{ reasonCode: failed.some((row) => row.status === "unreadable") ? "local_quote_unreadable" : "local_quote_mismatch" });
			}
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
				await auditClaim({
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
			await auditClaim({
				sourceId: merged.sourceId,
				claim: merged.claim,
				candidate,
				claimId: candidate.id,
			});
		}
	} else {
		for (const row of legacyVerifierRows) {
			await auditClaim({
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
		...(claim.verifierOwner ? { verifierOwner: { ...claim.verifierOwner } } : {}),
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
		verifierOwnerLedger,
		verifierOwnerIssues,
		batchAdoptionReadiness,
		remainingGaps,
		sourceRefJoinFailures,
		invalidVerifierRows,
		duplicateVerifierRows,
		invalidNormalizedCandidates,
		refsNoneMultiClaimBatchIssues: refsNoneBatchIssues,
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
