// Deterministic compact input packet for deep-research normalize-claims.
//
// This helper performs mechanical context hygiene before the normalizer LLM:
// it copies plan slots/priorities and compacts research-question observations
// into bounded arrays with overflow ledgers. It does not rank truth, select
// verification candidates, or discard evidence semantically.

const SCHEMA = "deep-research-normalize-input-packet-v2";

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

const CRITICAL_SLOT_TYPES = new Set([
	"numeric",
	"pricing",
	"ttl",
	"limit",
	"version",
	"date",
	"policy",
	"security-impact",
]);

function planSlotKey(slot) {
	return stringOf(slot?.id) ?? stringOf(slot?.slotId);
}

function isRequiredOrCriticalSlot(slot) {
	return (
		slot?.required === true ||
		CRITICAL_SLOT_TYPES.has(String(slot?.type ?? "").toLowerCase()) ||
		String(slot?.sourcePriority ?? "").toLowerCase() === "primary_required" ||
		String(slot?.verificationPriority ?? "").toLowerCase() === "high"
	);
}

function looksQuantitative(text) {
	return /\b\d+(?:\.\d+)?\s*(?:%|percent|ms|s|sec|seconds|minutes|hours|x|×|usd|\$|k|m|b|tokens?|users?|samples?|n\s*=|gb|mb|tb|requests?|qps|rps|per\s+month|\/month)\b/i.test(
		String(text ?? ""),
	);
}

function includesAny(text, patterns) {
	const value = String(text ?? "");
	return patterns.some((pattern) => pattern.test(value));
}

function entityMentions(text, slots) {
	const value = String(text ?? "").toLowerCase();
	const entities = new Set(slots.flatMap((slot) => asArray(slot.entities)));
	return [...entities].filter((entity) => value.includes(entity.toLowerCase()));
}

function looksRetrievalGapInference(text) {
	return includesAny(text, [
		/\b(?:not|never)\s+(?:established|retrieved|confirmed|found|available|documented)\b/i,
		/\b(?:did not|does not|failed to)\s+(?:yield|show|establish|confirm|retrieve|find)\b/i,
		/\b(?:unverified|no evidence|insufficient evidence|could not confirm|remains? unclear|not clear)\b/i,
	]);
}

function looksDerivedRecommendation(text) {
	return includesAny(text, [
		/\b(?:feasible|minimum|practical|recommended|recommendation|checklist|tiering|implementation guidance|production-ready|turnkey)\b/i,
		/\b(?:small[- ]?saas|api-only proxy logging|implementation tiers?)\b/i,
	]);
}

function precisionIssuesForClaim(claim, slotMetaById) {
	const text = stringOf(claim.claim) ?? "";
	const factSlotIds = compactStrings(claim.factSlotIds, 12);
	const sourceRefs = compactStrings(claim.sourceRefs, 1);
	const sourceUrls = compactStrings(claim.sourceUrls, 1);
	const issues = [];
	if (factSlotIds.length === 0) issues.push("unslotted_claim");
	if (factSlotIds.some((slotId) => !slotMetaById.has(slotId))) issues.push("unknown_slot_id");
	if (factSlotIds.length > 1) issues.push("bundled_slots");
	if (includesAny(text, [/;/, /\b(?:and|plus|while|whereas|but)\b/i]) && factSlotIds.length > 1)
		issues.push("compound_or_bundled_text");
	if (includesAny(text, [/\b(?:should|must|best|ideal|recommended|recommendation|prefer|ought)\b/i]))
		issues.push("normative_language");
	if (includesAny(text, [/\b(?:all|always|never|any|every|guarantees?|proves?|only)\b/i]))
		issues.push("overbroad_quantifier");
	if (
		includesAny(text, [
			/\b(?:guidance|recommend(?:s|ed|ation)?|requires?|should|must|only|safe\s+only|intended\s+only)\b/i,
		]) &&
		includesAny(text, [/;/, /\b(?:and|or|plus|with|while|whereas|but)\b/i])
	)
		issues.push("multi_obligation_claim");
	if (looksQuantitative(text) && sourceRefs.length === 0 && sourceUrls.length === 0)
		issues.push("quantitative_without_visible_source");
	if (looksRetrievalGapInference(text)) issues.push("retrieval_gap_inference");
	if (looksDerivedRecommendation(text)) issues.push("derived_recommendation");
	const mentionedEntities = entityMentions(text, [...slotMetaById.values()]);
	if (mentionedEntities.length > 1 && includesAny(text, [/\b(?:better|cheaper|faster|slower|higher|lower|vs\.?|versus|than)\b/i]))
		issues.push("entity_blend_risk");
	return [...new Set(issues)];
}

function precisionAction(issues, { sourceBacked } = {}) {
	if (issues.includes("quantitative_without_visible_source")) return "preserve_or_gap_until_source_backed";
	if (issues.includes("retrieval_gap_inference"))
		return sourceBacked ? "verify_only_if_doc_scoped_or_replace_with_positive_source_claim" : "preserve_as_gap_not_claim";
	if (issues.includes("derived_recommendation")) return "split_source_atoms_keep_recommendation_caveated";
	if (
		issues.includes("bundled_slots") ||
		issues.includes("compound_or_bundled_text") ||
		issues.includes("multi_obligation_claim") ||
		issues.includes("entity_blend_risk")
	)
		return "split_or_narrow_before_verification";
	if (issues.includes("normative_language") || issues.includes("overbroad_quantifier")) return "narrow_or_demote";
	return "eligible_if_slot_relevant";
}

function buildSlotPreservation({ planSlots, extractedFacts }) {
	const factsBySlot = new Map();
	for (const fact of extractedFacts) {
		const slotId = stringOf(fact.slotId);
		if (!slotId || slotId === "unslotted") continue;
		const facts = factsBySlot.get(slotId) ?? [];
		facts.push(fact);
		factsBySlot.set(slotId, facts);
	}
	const requiredOrCriticalSlots = planSlots.filter(isRequiredOrCriticalSlot).map((slot) => {
		const slotId = planSlotKey(slot);
		const facts = factsBySlot.get(slotId) ?? [];
		return {
			slotId,
			label: stringOf(slot.label),
			type: stringOf(slot.type),
			required: slot.required === true,
			sourcePriority: stringOf(slot.sourcePriority),
			verificationPriority: stringOf(slot.verificationPriority),
			observationCount: facts.length,
			representativeFactIds: compactStrings(facts.map((fact) => fact.id), 4),
			sourceRefs: compactStrings(facts.flatMap((fact) => fact.sourceRefs), 6),
			sourceUrls: compactStrings(facts.flatMap((fact) => fact.sourceUrls), 6),
			preservationNeed: facts.length > 0 ? "select_or_preserve_exact_slot_evidence" : "record_explicit_gap",
		};
	});
	return {
		requiredOrCriticalSlots,
		slotsWithEvidence: requiredOrCriticalSlots.filter((slot) => slot.observationCount > 0).map((slot) => slot.slotId),
		missingRequiredOrCriticalSlots: requiredOrCriticalSlots.filter((slot) => slot.observationCount === 0).map((slot) => slot.slotId),
	};
}

function buildPrecisionGuard({ claims, planSlots }) {
	const slotMetaById = new Map(planSlots.map((slot) => [planSlotKey(slot), slot]).filter(([slotId]) => slotId));
	const guardedClaims = claims.map((claim) => {
		const issues = precisionIssuesForClaim(claim, slotMetaById);
		const sourceBacked = compactStrings(claim.sourceRefs, 1).length > 0 || compactStrings(claim.sourceUrls, 1).length > 0;
		return {
			id: stringOf(claim.id) ?? stringOf(claim.originLocator),
			factSlotIds: compactStrings(claim.factSlotIds, 12),
			issues,
			action: precisionAction(issues, { sourceBacked }),
			sourceBacked,
			claim: stringOf(claim.claim)?.slice(0, 220),
		};
	});
	return {
		schema: "deep-research-precision-guard-v1",
		summary: {
			totalClaims: guardedClaims.length,
			flaggedClaims: guardedClaims.filter((claim) => claim.issues.length > 0).length,
			issueCounts: countBy(guardedClaims.flatMap((claim) => claim.issues.map((issue) => ({ issue }))), (item) => item.issue),
		},
		claims: guardedClaims.filter((claim) => claim.issues.length > 0),
		instructions: {
			split:
				"Claims flagged bundled_slots, compound_or_bundled_text, multi_obligation_claim, or entity_blend_risk should be split into atomic slot/entity-specific candidates before verification, while preserving source-backed measurement atoms needed for required slots.",
			demote:
				"Claims flagged normative_language or overbroad_quantifier should be narrowed to a source-backed factual statement or preserved as unverified context rather than promoted as a core recommendation.",
			sourceGuard:
				"Claims flagged quantitative_without_visible_source should not be promoted to core verification candidates until sourceUrls or sourceRefs are present; keep the slot as partial/missing or preserved evidence.",
			retrievalGap:
				"Claims flagged retrieval_gap_inference should be verification candidates only when framed as doc-scoped evidence about the exact retrieved sourceRefs; otherwise prefer a positive source-backed claim for the same slot or record a coverage gap.",
			derivedRecommendation:
				"Claims flagged derived_recommendation should split source-stated atoms into verificationCandidates and keep the product/design recommendation caveated in preservedClaims or final recommendations.",
		},
	};
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

	const planSlots = asArray(plan.factSlots).map(compactPlanSlot);
	const precisionGuard = buildPrecisionGuard({ claims, planSlots });
	const slotPreservation = buildSlotPreservation({ planSlots, extractedFacts });

	return {
		schema: SCHEMA,
		packet: {
			plan: {
				depth: stringOf(plan.depth),
				taskType: stringOf(plan.taskType),
				expectedFinalShape: stringOf(plan.expectedFinalShape),
				sourcePolicy: plan.sourcePolicy,
				factSlots: planSlots,
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
			slotPreservation,
			precisionGuard,
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
				precisionGuard:
					"Use precisionGuard to split or demote broad, normative, bundled, source-weak, retrieval-gap, or derived-recommendation claims before verification; use slotPreservation so required/critical slot evidence is selected, preserved, or marked as an explicit gap.",
			},
		},
	};
}
