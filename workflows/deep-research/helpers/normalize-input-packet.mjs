// Deterministic compact input packet for deep-research normalize-claims.
//
// This helper performs mechanical context hygiene before the normalizer LLM:
// it copies plan slots/priorities and compacts research-question observations
// into bounded arrays with overflow ledgers. It does not rank truth, select
// verification candidates, or discard evidence semantically.

const SCHEMA = "deep-research-normalize-input-packet-v1";

function findSource(sources, stageId) {
	for (const [specId, source] of Object.entries(sources ?? {})) {
		if (specId === stageId || specId.startsWith(`${stageId}.`)) return source;
	}
	return null;
}

function researchSources(sources) {
	return Object.entries(sources ?? {})
		.filter(([specId]) => specId === "research-questions" || specId.startsWith("research-questions."))
		.map(([sourceId, source]) => ({ sourceId, source: asObject(source) }));
}

function asArray(value) {
	return Array.isArray(value) ? value : [];
}

function asObject(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringOf(value) {
	return typeof value === "string" ? value : undefined;
}

function compactStrings(values, limit = 8) {
	if (!Array.isArray(values)) return [];
	const seen = new Set();
	const out = [];
	for (const value of values) {
		if (typeof value !== "string") continue;
		const text = value.trim();
		if (!text || seen.has(text)) continue;
		seen.add(text);
		out.push(text);
		if (out.length >= limit) break;
	}
	return out;
}

function compactPlanSlot(slot) {
	const item = asObject(slot);
	return {
		id: stringOf(item.id),
		label: stringOf(item.label),
		type: stringOf(item.type),
		required: item.required === true,
		entities: compactStrings(item.entities, 8),
		sourcePriority: stringOf(item.sourcePriority),
		verificationPriority: stringOf(item.verificationPriority),
	};
}

function compactVerificationPriority(priority) {
	const item = asObject(priority);
	return {
		id: stringOf(item.id),
		targetSlots: compactStrings(item.targetSlots, 12),
		claimFamily: stringOf(item.claimFamily),
		priority: stringOf(item.priority),
		reason: stringOf(item.reason),
		evidenceRequirement: stringOf(item.evidenceRequirement),
	};
}

function compactExtractedFact(fact, sourceId, index) {
	const item = asObject(fact);
	return {
		id: `${sourceId}.fact-${String(index + 1).padStart(3, "0")}`,
		sourceId,
		slotId: stringOf(item.slotId),
		slotLabel: stringOf(item.slotLabel),
		entity: stringOf(item.entity),
		value: item.value,
		factType: stringOf(item.factType),
		sourceUrls: compactStrings(item.sourceUrls, 6),
		sourceRefs: compactStrings(item.sourceRefs, 6),
		sourceTitleOrPublisher: stringOf(item.sourceTitleOrPublisher),
		dateOrYear: stringOf(item.dateOrYear),
		sourceQuality: stringOf(item.sourceQuality),
		confidence: stringOf(item.confidence),
		quote: stringOf(item.quote)?.slice(0, 500),
		notes: stringOf(item.notes)?.slice(0, 300),
	};
}

function compactClaim(claim, sourceId, index) {
	const item = asObject(claim);
	const id = stringOf(item.id);
	return {
		...(id ? { id } : { originLocator: `${sourceId}.claim-${String(index + 1).padStart(3, "0")}` }),
		sourceId,
		claim: stringOf(item.claim)?.slice(0, 600),
		sourceUrls: compactStrings(item.sourceUrls, 6),
		sourceRefs: compactStrings(item.sourceRefs, 6),
		sourceTitleOrPublisher: stringOf(item.sourceTitleOrPublisher),
		dateOrYear: stringOf(item.dateOrYear),
		sourceQuality: stringOf(item.sourceQuality),
		scopeItems: compactStrings(item.scopeItems, 8),
		factSlotIds: compactStrings(item.factSlotIds, 8),
	};
}

function compactSource(source, sourceId, index) {
	const item = asObject(source);
	const id = stringOf(item.id);
	return {
		...(id ? { id } : { originLocator: `${sourceId}.source-${String(index + 1).padStart(3, "0")}` }),
		sourceId,
		url: stringOf(item.url),
		sourceRef: stringOf(item.sourceRef),
		title: stringOf(item.title ?? item.sourceTitleOrPublisher),
		publisher: stringOf(item.publisher),
		sourceQuality: stringOf(item.sourceQuality),
		notes: stringOf(item.notes)?.slice(0, 300),
	};
}

function compactGap(gap, sourceId, index) {
	const item = asObject(gap);
	const id = stringOf(item.id);
	return {
		...(id ? { id } : { originLocator: `${sourceId}.gap-${String(index + 1).padStart(3, "0")}` }),
		sourceId,
		lead: stringOf(item.lead ?? item.claim ?? item.note)?.slice(0, 500),
		sourceUrls: compactStrings(item.sourceUrls, 6),
		sourceRefs: compactStrings(item.sourceRefs, 6),
		factSlotIds: compactStrings(item.factSlotIds, 8),
		reason: stringOf(item.reason ?? item.gapReason),
	};
}

function pushBounded(target, overflow, items, limit, overflowKind) {
	for (const item of items) {
		if (target.length < limit) target.push(item);
		else overflow[overflowKind] = (overflow[overflowKind] ?? 0) + 1;
	}
}

function countBy(values, keyFn) {
	const counts = {};
	for (const value of values) {
		const key = keyFn(value) ?? "unknown";
		counts[key] = (counts[key] ?? 0) + 1;
	}
	return counts;
}

function overflowBySlot({ extractedFacts, claims, evidenceGaps }) {
	return {
		factsBySlot: countBy(extractedFacts, (fact) => fact.slotId),
		claimsBySlot: countBy(claims.flatMap((claim) => claim.factSlotIds.map((slotId) => ({ slotId }))), (item) => item.slotId),
		evidenceGapsBySlot: countBy(evidenceGaps.flatMap((gap) => gap.factSlotIds.map((slotId) => ({ slotId }))), (item) => item.slotId),
	};
}

function sourceRefCoverage(items) {
	return items.filter((item) => compactStrings(item.sourceRefs, 1).length > 0).length;
}

export default async function normalizeInputPacket({ sources }) {
	const plan = asObject(findSource(sources, "plan"));
	const research = researchSources(sources);
	const extractedFacts = [];
	const claims = [];
	const sourceCards = [];
	const evidenceGaps = [];
	const overflow = {};
	const limits = {
		extractedFacts: 240,
		claims: 240,
		sources: 160,
		evidenceGaps: 120,
	};

	for (const { sourceId, source } of research) {
		pushBounded(
			extractedFacts,
			overflow,
			asArray(source.extractedFacts).map((fact, index) => compactExtractedFact(fact, sourceId, index)),
			limits.extractedFacts,
			"omittedExtractedFacts",
		);
		pushBounded(
			claims,
			overflow,
			asArray(source.claims).map((claim, index) => compactClaim(claim, sourceId, index)),
			limits.claims,
			"omittedClaims",
		);
		pushBounded(
			sourceCards,
			overflow,
			asArray(source.sources).map((item, index) => compactSource(item, sourceId, index)),
			limits.sources,
			"omittedSources",
		);
		pushBounded(
			evidenceGaps,
			overflow,
			asArray(source.additionalUnverifiedLeads).map((item, index) => compactGap(item, sourceId, index)),
			limits.evidenceGaps,
			"omittedEvidenceGaps",
		);
	}

	return {
		schema: SCHEMA,
		packet: {
			plan: {
				depth: stringOf(plan.depth),
				taskType: stringOf(plan.taskType),
				expectedFinalShape: stringOf(plan.expectedFinalShape),
				sourcePolicy: plan.sourcePolicy,
				factSlots: asArray(plan.factSlots).map(compactPlanSlot),
				verificationPriorities: asArray(plan.verificationPriorities).map(compactVerificationPriority),
				researchScopeCoverage: asArray(plan.researchScopeCoverage),
			},
			research: {
				sourceCount: research.length,
				extractedFacts,
				claims,
				sources: sourceCards,
				evidenceGaps,
			},
			ledgers: {
				overflow,
				overflowBySlot: overflowBySlot({ extractedFacts, claims, evidenceGaps }),
				slotFactCounts: countBy(extractedFacts, (fact) => fact.slotId),
				claimSlotCounts: countBy(claims.flatMap((claim) => claim.factSlotIds.map((slotId) => ({ slotId }))), (item) => item.slotId),
				sourceRefCoverage: {
					extractedFactsWithSourceRefs: sourceRefCoverage(extractedFacts),
					claimsWithSourceRefs: sourceRefCoverage(claims),
					sourcesWithSourceRefs: sourceCards.filter((source) => typeof source.sourceRef === "string" && source.sourceRef).length,
				},
			},
			instructions: {
				selectionBoundary:
					"Use this packet for mechanical lookup/coverage context only; semantic claim selection and verification priority remain the normalizer responsibility.",
				noSilentLoss:
					"If ledgers.overflow has non-zero counts, summarize omitted material in normalizationNotes instead of implying full coverage.",
			},
		},
	};
}
