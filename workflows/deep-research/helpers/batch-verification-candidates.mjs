// Deterministic verification candidate batch planner for deep-research.
//
// This helper is intentionally planning-only: it groups sanitized verification
// candidates into stable batch records but does not change verifier semantics or
// skip single-claim verification. A later workflow can consume these batches only
// after per-claim result identity and fallback gates pass.

function asArray(value) {
	if (Array.isArray(value)) return value;
	if (value && typeof value === "object") {
		if (Array.isArray(value.claimInventory?.verificationCandidates))
			return value.claimInventory.verificationCandidates;
		if (Array.isArray(value.verificationCandidates))
			return value.verificationCandidates;
		if (Array.isArray(value.claims)) return value.claims;
		if (Array.isArray(value.items)) return value.items;
	}
	return [];
}

function findCandidates(sources) {
	for (const [specId, source] of Object.entries(sources ?? {})) {
		if (specId === "sanitize-claims" || specId.startsWith("sanitize-claims.")) {
			return asArray(source);
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

function explicitId(value) {
	const id = typeof value?.id === "string" ? value.id.trim() : "";
	return id || null;
}

function compactSourceStrings(values) {
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

function looksLikeLocalSourceRef(value) {
	const text = String(value ?? "")
		.trim()
		.replace(/^(?:file|repo):/i, "")
		.replace(/#L\d+(?:-L?\d+)?$/i, "");
	return /^(?:\.?[\w.-]+\/)?[\w./-]+\.(?:md|json|ya?ml|ts|tsx|js|mjs|cjs|py|go|rs|zig|txt|sol|java|kt|swift|rb|php|c|cc|cpp|h|hpp)$/i.test(
		text,
	);
}

function isWorkflowSourceRef(value) {
	return /^wsrc_[a-f0-9]{32}$/.test(String(value ?? "").trim());
}

function addSourceToken(value, tokens) {
	if (Array.isArray(value)) {
		for (const item of value) addSourceToken(item, tokens);
		return;
	}
	if (typeof value !== "string") return;
	const text = value.trim();
	if (!text) return;
	if (isWorkflowSourceRef(text)) tokens.refs.push(text);
	else if (/^https?:\/\//i.test(text)) tokens.urls.push(text);
	else if (looksLikeLocalSourceRef(text)) tokens.local.push(text);
}

function collectHintSourceTokens(value, tokens) {
	if (Array.isArray(value)) {
		for (const item of value) collectHintSourceTokens(item, tokens);
		return tokens;
	}
	if (!value || typeof value !== "object") return tokens;
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
		addSourceToken(value[key], tokens);
	}
	for (const key of [
		"sourceRead",
		"sourceCard",
		"sourceEvidence",
		"sourceEvidenceHints",
		"evidence",
	]) {
		collectHintSourceTokens(value[key], tokens);
	}
	return tokens;
}

export function candidateSourceTokens(candidate) {
	const tokens = { refs: [], urls: [], local: [] };
	for (const ref of Array.isArray(candidate?.sourceRefs)
		? candidate.sourceRefs
		: []) {
		if (typeof ref !== "string") continue;
		const text = ref.trim();
		if (isWorkflowSourceRef(text)) tokens.refs.push(text);
		else if (looksLikeLocalSourceRef(text)) tokens.local.push(text);
	}
	for (const url of Array.isArray(candidate?.sourceUrls)
		? candidate.sourceUrls
		: []) {
		if (typeof url === "string" && /^https?:\/\//i.test(url.trim()))
			tokens.urls.push(url.trim());
	}
	collectHintSourceTokens(candidate?.sourceEvidenceHints, tokens);
	collectHintSourceTokens(candidate?.evidence, tokens);
	collectHintSourceTokens(
		candidate && typeof candidate === "object"
			? {
					sourceRef: candidate.sourceRef,
					sourceRefs: candidate.sourceRefs,
					source: candidate.source,
					url: candidate.url,
					sourceUrl: candidate.sourceUrl,
					sourceUrls: candidate.sourceUrls,
					file: candidate.file,
					path: candidate.path,
					repo: candidate.repo,
					repoPath: candidate.repoPath,
					localPath: candidate.localPath,
				}
			: null,
		tokens,
	);
	return {
		refs: compactSourceStrings(tokens.refs).sort(),
		urls: compactSourceStrings(tokens.urls).sort(),
		local: compactSourceStrings(tokens.local).sort(),
	};
}

export function sourceKey(candidate) {
	const tokens = candidateSourceTokens(candidate);
	if (tokens.refs.length > 0) return `refs:${tokens.refs.join("|")}`;
	if (tokens.urls.length > 0) return `urls:${tokens.urls.join("|")}`;
	if (tokens.local.length > 0) return `local:${tokens.local.join("|")}`;
	return "refs:none";
}

function normalizeMaxBatchSize(value) {
	const parsed = Number(value ?? 2);
	if (!Number.isInteger(parsed) || parsed < 1) return 2;
	return Math.min(parsed, 4);
}

function cloneCandidate(candidate, id) {
	return {
		...candidate,
		id,
		...(Array.isArray(candidate.sourceRefs)
			? { sourceRefs: [...candidate.sourceRefs] }
			: {}),
		...(Array.isArray(candidate.sourceUrls)
			? { sourceUrls: [...candidate.sourceUrls] }
			: {}),
		...(Array.isArray(candidate.sourceEvidenceHints)
			? {
					sourceEvidenceHints: candidate.sourceEvidenceHints.map((hint) => ({
						...hint,
					})),
				}
			: {}),
	};
}

export default async function batchVerificationCandidates({
	sources,
	options = {},
}) {
	const maxBatchSize = normalizeMaxBatchSize(options.maxBatchSize);
	const rawCandidates = findCandidates(sources);
	const usedIds = new Set(
		rawCandidates.map(explicitId).filter((id) => typeof id === "string"),
	);
	const idCounts = new Map();
	const candidates = rawCandidates
		.map((candidate, index) => {
			const id = explicitId(candidate) ?? allocateFallbackId(usedIds, index);
			idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
			return { candidate, id, index };
		})
		.sort((left, right) => left.id.localeCompare(right.id));
	const duplicateCandidateIds = [...idCounts.entries()]
		.filter(([, count]) => count > 1)
		.map(([id, count]) => ({ id, count }));

	const groups = new Map();
	for (const item of candidates) {
		const key = sourceKey(item.candidate);
		// Never create a multi-claim refs:none batch: without explicit source
		// refs/URLs/local hints, the audit gate cannot deterministically prove that
		// a source-backed verifier row belongs to this candidate rather than a
		// neighbour in the batch.
		const groupKey = key === "refs:none" ? `${key}:${item.id}` : key;
		const group = groups.get(groupKey) ?? { sourceKey: key, items: [] };
		group.items.push(item);
		groups.set(groupKey, group);
	}

	const batches = [];
	for (const [groupKey, group] of [...groups.entries()].sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		const { sourceKey: key, items } = group;
		for (let offset = 0; offset < items.length; offset += maxBatchSize) {
			const slice = items.slice(offset, offset + maxBatchSize);
			const claimIds = slice.map((item) => item.id);
			batches.push({
				id: `vbatch-${String(batches.length + 1).padStart(3, "0")}`,
				sourceKey: key,
				claimIds,
				claims: slice.map((item) => cloneCandidate(item.candidate, item.id)),
				compatibilityGate: {
					explicitSourceHints: key !== "refs:none",
					refsNoneMultiClaimBlocked: key === "refs:none" && claimIds.length > 1,
					plannerGroupKey: groupKey,
				},
			});
		}
	}

	return {
		schema: "deep-research-verification-batches-v1",
		digest: `${batches.length} verification batch(es), ${candidates.length} candidate(s), maxBatchSize=${maxBatchSize}`,
		maxBatchSize,
		candidateCount: candidates.length,
		batchCount: batches.length,
		...(duplicateCandidateIds.length > 0 ? { duplicateCandidateIds } : {}),
		batches,
	};
}
