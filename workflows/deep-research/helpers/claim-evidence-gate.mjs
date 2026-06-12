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
		for (const value of [row.url, row.source, row.file, row.path]) {
			if (typeof value !== "string") continue;
			if (/^https?:\/\//i.test(value) || looksLikeLocalSourceRef(value))
				refs.add(value.trim());
		}
	}
	return refs;
}

// Structured evidence check: at least one evidence row carrying both a source
// reference (HTTP URL or local repository file path) and a quote/excerpt. Unlike
// a keyword scan over the serialized claim, this cannot be satisfied by merely
// mentioning a URL/path in prose.
function hasFetchedEvidence(claim) {
	const rows = Array.isArray(claim?.evidence) ? claim.evidence : [];
	return rows.some((row) => {
		if (!row || typeof row !== "object") return false;
		const refs = [row.url, row.source, row.file, row.path].filter(
			(value) => typeof value === "string",
		);
		const sourceRef = refs.some(
			(value) => /^https?:\/\//i.test(value) || looksLikeLocalSourceRef(value),
		);
		const quote = typeof row.quote === "string" && row.quote.trim().length > 0;
		return sourceRef && quote;
	});
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
	const candidatesById = new Map();
	for (const candidate of asArray(
		normalized?.claimInventory?.verificationCandidates,
	)) {
		if (
			candidate &&
			typeof candidate === "object" &&
			typeof candidate.id === "string"
		) {
			candidatesById.set(candidate.id, candidate);
		}
	}

	const claims = Object.entries(sources ?? {})
		.filter(
			([specId]) =>
				specId === "verify-claims" || specId.startsWith("verify-claims."),
		)
		.flatMap(([sourceId, source]) =>
			asArray(source).map((claim) => ({ sourceId, claim })),
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
							!specId.startsWith("normalize-claims"),
					)
					.flatMap(([sourceId, source]) =>
						asArray(source).map((claim) => ({ sourceId, claim })),
					);

	const auditedClaims = [];
	const remainingGaps = [];
	const identityJoinNotes = [];
	const gateSummary = {
		total: 0,
		unchanged: 0,
		downgraded: 0,
		identityRejoined: 0,
	};

	for (const { sourceId, claim } of verifierClaims) {
		if (!claim || typeof claim !== "object") continue;
		gateSummary.total += 1;
		const sourceRefs = [...collectEvidenceRefs(claim)];
		const exactQuantitative = hasExactQuantitativeClaim(claim);
		const fetched = hasFetchedEvidence(claim);
		let next = { ...claim, sourceId, sourceUrls: sourceRefs };

		// Identity join: the normalizer's candidate record is authoritative for
		// claim id, claim text, and factSlotIds. Verifier echoes drift.
		const claimId =
			typeof next.id === "string"
				? next.id
				: typeof next.claimId === "string"
					? next.claimId
					: null;
		const candidate = claimId ? candidatesById.get(claimId) : null;
		if (candidate) {
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
			sourceRefs.length === 0
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
				sourceUrls: sourceRefs,
				nextStep:
					"Fetch or inspect primary source evidence for the exact claim before using it as verified.",
			});
		} else {
			gateSummary.unchanged += 1;
		}
		auditedClaims.push(next);
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
		verdictDigest: claim.verdictDigest,
		correctionOrCounterclaim: claim.correctionOrCounterclaim,
	}));

	return {
		auditedClaims,
		claimDigests,
		gateSummary,
		remainingGaps,
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
