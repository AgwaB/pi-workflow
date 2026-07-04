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

function stableId(value, fallback) {
	const id = typeof value?.id === "string" ? value.id.trim() : "";
	return id || fallback;
}

function sourceKey(candidate) {
	const refs = Array.isArray(candidate?.sourceRefs)
		? candidate.sourceRefs.filter(
				(ref) => typeof ref === "string" && ref.trim(),
			)
		: [];
	if (refs.length > 0) return `refs:${refs.slice().sort().join("|")}`;
	const urls = Array.isArray(candidate?.sourceUrls)
		? candidate.sourceUrls.filter(
				(url) => typeof url === "string" && url.trim(),
			)
		: [];
	if (urls.length > 0) return `urls:${urls.slice().sort().join("|")}`;
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
	const candidates = rawCandidates
		.map((candidate, index) => ({
			candidate,
			id: stableId(
				candidate,
				`candidate-${String(index + 1).padStart(3, "0")}`,
			),
			index,
		}))
		.sort((left, right) => left.id.localeCompare(right.id));

	const groups = new Map();
	for (const item of candidates) {
		const key = sourceKey(item.candidate);
		const group = groups.get(key) ?? [];
		group.push(item);
		groups.set(key, group);
	}

	const batches = [];
	for (const [key, items] of [...groups.entries()].sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		for (let offset = 0; offset < items.length; offset += maxBatchSize) {
			const slice = items.slice(offset, offset + maxBatchSize);
			const claimIds = slice.map((item) => item.id);
			batches.push({
				id: `vbatch-${String(batches.length + 1).padStart(3, "0")}`,
				sourceKey: key,
				claimIds,
				claims: slice.map((item) => cloneCandidate(item.candidate, item.id)),
			});
		}
	}

	return {
		schema: "deep-research-verification-batches-v1",
		digest: `${batches.length} verification batch(es), ${candidates.length} candidate(s), maxBatchSize=${maxBatchSize}`,
		maxBatchSize,
		candidateCount: candidates.length,
		batchCount: batches.length,
		batches,
	};
}
