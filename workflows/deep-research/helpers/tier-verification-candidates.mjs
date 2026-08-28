// Deterministic verification tier planner for deep-research.
//
// This helper is intentionally planning-only: it partitions sanitized
// verification candidates into a core tier (verified at high thinking) and a
// tail tier (verified at medium thinking) without changing verifier semantics,
// per-claim identity, evidence requirements, or the audit gate contract. The
// per-item spec schema pins thinking per stage, so tiering is expressed as two
// downstream foreach stages fed by the two arrays this helper emits.
//
// Tier assignment uses the existing normalizer/sanitizer priority signal:
// candidates with verificationNeed "core" go to the core tier, "useful" and
// "optional" go to the tail tier, and candidates without a usable
// verificationNeed fall back to position order (the first coreTierSize
// candidates go to the core tier).

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HELPER_DIR = dirname(fileURLToPath(import.meta.url));
const SANITIZE_SCHEMA_PATH = join(
	HELPER_DIR,
	"..",
	"schemas",
	"deep-research-sanitize-claims-control.schema.json",
);
const FALLBACK_CANDIDATE_CAP = 48;
const DEFAULT_CORE_TIER_SIZE = 8;
const VERIFICATION_NEEDS = new Set(["core", "useful", "optional"]);
let candidateCapCache;

function asObject(value) {
	return value && typeof value === "object" && !Array.isArray(value)
		? value
		: {};
}

function arrayMaxItems(schema) {
	const value = asObject(schema).maxItems;
	return Number.isInteger(value) && value > 0 ? value : undefined;
}

async function loadCandidateCap() {
	if (candidateCapCache) return candidateCapCache;
	try {
		const schema = JSON.parse(await readFile(SANITIZE_SCHEMA_PATH, "utf8"));
		const claimInventory = asObject(asObject(schema.properties).claimInventory);
		candidateCapCache =
			arrayMaxItems(asObject(claimInventory.properties).verificationCandidates) ??
			FALLBACK_CANDIDATE_CAP;
	} catch {
		candidateCapCache = FALLBACK_CANDIDATE_CAP;
	}
	return candidateCapCache;
}

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

function canonicalSource(sources, stageId) {
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

function findCandidates(sources) {
	const sanitized = canonicalSource(sources, "sanitize-claims");
	if (sanitized !== null) return asArray(sanitized);
	return asArray(canonicalSource(sources, "normalize-claims"));
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

function normalizeCoreTierSize(value, candidateCap) {
	const parsed = Number(value ?? DEFAULT_CORE_TIER_SIZE);
	if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_CORE_TIER_SIZE;
	return Math.min(parsed, candidateCap);
}

function cloneCandidate(candidate, id, tier) {
	return {
		...candidate,
		id,
		verifierTier: tier,
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

export function tierForCandidate(candidate, index, coreTierSize) {
	const need =
		typeof candidate?.verificationNeed === "string"
			? candidate.verificationNeed.trim().toLowerCase()
			: "";
	if (VERIFICATION_NEEDS.has(need)) {
		return { tier: need === "core" ? "core" : "tail", mode: "verificationNeed" };
	}
	return { tier: index < coreTierSize ? "core" : "tail", mode: "position" };
}

export default async function tierVerificationCandidates({
	sources,
	options = {},
}) {
	const candidateCap = await loadCandidateCap();
	const coreTierSize = normalizeCoreTierSize(options.coreTierSize, candidateCap);
	const rawCandidates = findCandidates(sources);
	const usedIds = new Set(
		rawCandidates.map(explicitId).filter((id) => typeof id === "string"),
	);
	const idCounts = new Map();
	const candidates = rawCandidates.map((candidate, index) => {
		const id = explicitId(candidate) ?? allocateFallbackId(usedIds, index);
		idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
		return { candidate, id, index };
	});
	const duplicateCandidateIds = [...idCounts.entries()]
		.filter(([, count]) => count > 1)
		.map(([id, count]) => ({ id, count }));

	// Defensive schema-cap clamp mirroring the sanitizer contract: the sanitize
	// schema already caps verificationCandidates, so overflow here means an
	// upstream contract violation. Dropped ids stay visible so the audit gate
	// reports the missing verifier rows instead of silently shrinking coverage.
	const kept = candidates.slice(0, candidateCap);
	const droppedCandidateIds = candidates
		.slice(candidateCap)
		.map((item) => item.id);

	const coreCandidates = [];
	const tailCandidates = [];
	const modeCounts = { verificationNeed: 0, position: 0 };
	for (const item of kept) {
		const { tier, mode } = tierForCandidate(
			item.candidate,
			item.index,
			coreTierSize,
		);
		modeCounts[mode] += 1;
		const cloned = cloneCandidate(item.candidate, item.id, tier);
		if (tier === "core") coreCandidates.push(cloned);
		else tailCandidates.push(cloned);
	}
	const tieringMode =
		modeCounts.verificationNeed > 0 && modeCounts.position > 0
			? "mixed"
			: modeCounts.position > 0
				? "position"
				: "verificationNeed";

	return {
		schema: "deep-research-verification-tiers-v1",
		digest: `${coreCandidates.length} core / ${tailCandidates.length} tail of ${kept.length} candidate(s), coreTierSize=${coreTierSize}, mode=${tieringMode}`,
		coreTierSize,
		candidateCap,
		tieringMode,
		tieringModeCounts: modeCounts,
		candidateCount: kept.length,
		coreCount: coreCandidates.length,
		tailCount: tailCandidates.length,
		...(duplicateCandidateIds.length > 0 ? { duplicateCandidateIds } : {}),
		...(droppedCandidateIds.length > 0
			? { capExceeded: true, droppedCandidateIds }
			: {}),
		coreCandidates,
		tailCandidates,
	};
}
