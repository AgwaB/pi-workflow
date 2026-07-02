// Deterministic sanitizer between normalize-claims and verify-claims.
//
// This helper does not decide truth. It only keeps verifier fanout focused on
// source-stated, source-locatable factual claims and preserves demoted material
// as explicit coverage gaps/backlog rows for final synthesis. The goal is to
// avoid spending verifier budget on workflow-context metadata, evidence-gap
// statements, and synthesized recommendations that are better represented as
// gaps or caveated guidance.

const SCHEMA = "deep-research-verification-candidate-sanitizer-v1";
const VERIFIER_INPUT_POLICY =
	"use_sourceRefs_or_sourceUrls_only_do_not_call_workflow_artifact";

function asArray(value) {
	return Array.isArray(value) ? value : [];
}

function asObject(value) {
	return value && typeof value === "object" && !Array.isArray(value)
		? value
		: {};
}

function stringOf(value) {
	return typeof value === "string" ? value.trim() : "";
}

function compactStrings(values, limit = 12) {
	if (!Array.isArray(values)) return [];
	const seen = new Set();
	const out = [];
	for (const value of values) {
		const text = stringOf(value);
		if (!text || seen.has(text)) continue;
		seen.add(text);
		out.push(text);
		if (out.length >= limit) break;
	}
	return out;
}

function findSource(sources, stageId) {
	for (const [specId, source] of Object.entries(sources ?? {})) {
		if (specId === stageId || specId.startsWith(`${stageId}.`)) return source;
	}
	return null;
}

function claimText(candidate) {
	return stringOf(candidate?.claim ?? candidate?.text ?? candidate?.statement);
}

function candidateId(candidate) {
	return stringOf(candidate?.id ?? candidate?.claimId);
}

function sourceRefs(candidate) {
	return compactStrings(candidate?.sourceRefs, 16);
}

function sourceUrls(candidate) {
	return compactStrings(candidate?.sourceUrls, 16);
}

function localEvidenceRefs(candidate) {
	const refs = [];
	for (const key of ["file", "path", "repoPath", "localPath"]) {
		const value = stringOf(candidate?.[key]);
		if (value) refs.push(value);
	}
	for (const row of asArray(candidate?.evidence)) {
		for (const key of ["file", "path", "source", "sourceRef"]) {
			const value = stringOf(row?.[key]);
			if (value && !/^https?:\/\//i.test(value)) refs.push(value);
		}
	}
	return compactStrings(refs, 8);
}

function hasSourceLocator(candidate) {
	return (
		sourceRefs(candidate).length > 0 ||
		sourceUrls(candidate).length > 0 ||
		localEvidenceRefs(candidate).length > 0
	);
}

function matchesAny(text, patterns) {
	return patterns.some((pattern) => pattern.test(text));
}

function tokenSet(value) {
	return new Set(
		String(value ?? "")
			.toLowerCase()
			.match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [],
	);
}

function setIntersectionCount(left, right) {
	let count = 0;
	for (const value of left) if (right.has(value)) count += 1;
	return count;
}

function isSyntheticEvidenceText(value) {
	return /(?:^|[^a-z0-9])(?:synthesis|synthesized|derived|inference)(?:$|[^a-z0-9])/i.test(
		String(value ?? ""),
	);
}

function weakEvidenceHintText(value) {
	return matchesAny(String(value ?? ""), [
		/\bexact\b[^.]{0,80}\b(?:quote|wording|text)\b[^.]{0,80}\b(?:not|unavailable|missing|limited|could not|was not)\b/i,
		/\b(?:quote|wording|text)\b[^.]{0,80}\b(?:not|unavailable|missing|limited|could not|was not)\b/i,
		/\b(?:cite cautiously|requires? assumptions?|implementation[- ]specific|not direct evidence|not direct support)\b/i,
		/\b(?:did not|does not|could not|not found|not confirm|not indicate|budget exhausted)\b/i,
	]);
}

function sufficientlyQuoteBackedValue(valueTokens, quoteTokens) {
	if (valueTokens.size === 0) return false;
	const hits = setIntersectionCount(valueTokens, quoteTokens);
	return hits >= 4 && hits / valueTokens.size >= 0.55;
}

function buildEvidenceHintRows(normalizeInputPacket) {
	const rows = [];
	const facts = asArray(normalizeInputPacket?.packet?.research?.extractedFacts);
	for (const fact of facts) {
		const quote = stringOf(fact?.quote);
		if (!quote) continue;
		const refs = sourceRefs(fact);
		const urls = sourceUrls(fact);
		if (refs.length === 0 && urls.length === 0) continue;
		const sourceTitleOrPublisher = stringOf(fact?.sourceTitleOrPublisher);
		const sourceQuality = stringOf(fact?.sourceQuality);
		const notes = stringOf(fact?.notes);
		if (
			isSyntheticEvidenceText(
				`${sourceTitleOrPublisher} ${sourceQuality} ${notes}`,
			)
		)
			continue;
		const value = stringOf(fact?.value);
		const quoteTokens = tokenSet(quote);
		const valueTokens = tokenSet(value);
		const supportedValue =
			value &&
			!weakEvidenceHintText(`${value} ${notes}`) &&
			sufficientlyQuoteBackedValue(valueTokens, quoteTokens)
				? value
				: "";
		rows.push({
			sourceRef: refs[0],
			sourceRefs: refs,
			url: urls[0],
			sourceUrls: urls,
			sourceTitleOrPublisher: sourceTitleOrPublisher || undefined,
			dateOrYear: stringOf(fact?.dateOrYear) || undefined,
			quote,
			value: supportedValue || undefined,
			factSlotIds: compactStrings(
				[fact?.slotId, ...asArray(fact?.factSlotIds)],
				8,
			),
			sourceQuality: sourceQuality || undefined,
			relevance: notes || supportedValue || undefined,
			_tokens: tokenSet(`${supportedValue} ${quote}`),
		});
	}
	return rows;
}

function canonicalUrl(value) {
	const raw = stringOf(value).replace(/[.,;:]+$/u, "");
	if (!/^https?:\/\//i.test(raw)) return "";
	try {
		const url = new URL(raw);
		url.protocol = url.protocol.toLowerCase();
		url.hostname = url.hostname.toLowerCase();
		url.hash = "";
		return url.toString().replace(/\/$/u, "");
	} catch {
		return raw;
	}
}

function buildUrlSourceRefLookup(normalizeInputPacket) {
	const lookup = new Map();
	const sources = asArray(normalizeInputPacket?.packet?.research?.sources);
	for (const source of sources) {
		const ref = sourceRefs(source)[0] || stringOf(source?.sourceRef);
		if (!ref) continue;
		for (const url of sourceUrls(source).length > 0
			? sourceUrls(source)
			: [source?.url]) {
			const key = canonicalUrl(url);
			if (key && !lookup.has(key)) lookup.set(key, ref);
		}
	}
	return lookup;
}

function backfillSourceRefs(candidate, hints, urlToSourceRef) {
	const refs = sourceRefs(candidate);
	for (const hint of hints) {
		if (hint.sourceRef && !refs.includes(hint.sourceRef))
			refs.push(hint.sourceRef);
	}
	for (const url of sourceUrls(candidate)) {
		const ref = urlToSourceRef.get(canonicalUrl(url));
		if (ref && !refs.includes(ref)) refs.push(ref);
	}
	return refs.slice(0, 16);
}

function evidenceHintsForCandidate(candidate, hintRows) {
	const candidateRefs = new Set(sourceRefs(candidate));
	const candidateUrls = new Set(sourceUrls(candidate));
	const candidateSlots = new Set(compactStrings(candidate?.factSlotIds, 12));
	const candidateTokens = tokenSet(claimText(candidate));
	const scored = [];
	for (const row of hintRows) {
		const refHits = setIntersectionCount(
			new Set(row.sourceRefs),
			candidateRefs,
		);
		const urlHits = setIntersectionCount(
			new Set(row.sourceUrls),
			candidateUrls,
		);
		const slotHits = setIntersectionCount(
			new Set(row.factSlotIds),
			candidateSlots,
		);
		const tokenHits = setIntersectionCount(row._tokens, candidateTokens);
		if (slotHits === 0 && tokenHits < 2) continue;
		const score =
			refHits * 6 + urlHits * 5 + slotHits * 2 + Math.min(tokenHits, 5);
		if (score < 7) continue;
		scored.push({ score, row });
	}
	scored.sort((left, right) => right.score - left.score);
	return scored.slice(0, 3).map(({ row }) => ({
		sourceRef: row.sourceRef || undefined,
		url: row.url || undefined,
		sourceTitleOrPublisher: row.sourceTitleOrPublisher,
		dateOrYear: row.dateOrYear,
		quote: row.quote,
		value: row.value,
		factSlotIds: row.factSlotIds,
		sourceQuality: row.sourceQuality,
		relevance: row.relevance,
	}));
}

function classifyCandidate(candidate, seenIds) {
	const id = candidateId(candidate);
	const claim = claimText(candidate);
	const reasons = [];

	if (!id) reasons.push("missing_candidate_id");
	else if (seenIds.has(id)) reasons.push("duplicate_candidate_id");
	if (!claim) reasons.push("missing_candidate_text");
	if (!hasSourceLocator(candidate)) reasons.push("missing_candidate_source");

	if (claim) {
		if (
			matchesAny(claim, [
				/\b(?:fetched|retrieved|accessed|inspected|collected|reviewed|cached)\b[^.]{0,80}\b20\d{2}-\d{2}-\d{2}\b/i,
				/\b20\d{2}-\d{2}-\d{2}\b[^.]{0,80}\b(?:fetched|retrieved|accessed|inspected|collected|reviewed|cached)\b/i,
			])
		) {
			reasons.push("workflow_context_date_claim");
		}

		if (
			matchesAny(claim, [
				/\b(?:sourceRef|workflow[_ -]?artifact|cached source|artifact read|tool call)\b/i,
				/\b(?:evidence|source|page|doc|documentation)\s+(?:was|were)\s+(?:fetched|retrieved|cached|inspected|reviewed)\b/i,
			])
		) {
			reasons.push("meta_evidence_freshness_claim");
		}

		if (
			matchesAny(claim, [
				/\b(?:no|not|never)\s+(?:direct|exact|primary|source-backed)?\s*(?:evidence|quote|rule|wording|support)\b/i,
				/\bno\s+(?:retrieved|available|visible|primary|cited|supporting)?\s*sources?\s+(?:found|available|visible|retrieved|confirmed|cited|support(?:s|ing)?)\b/i,
				/\b(?:evidence|quote|source|rule|wording|support)\s+(?:was|were|is|are)\s+not\s+(?:found|available|visible|present|exposed|retrieved|confirmed|reliably extracted)\b/i,
				/\b(?:did not|does not|failed to|could not|cannot)\s+(?:find|show|establish|confirm|retrieve|extract|expose|verify|support)\b/i,
				/\bnot\s+reliably\s+(?:extracted|confirmed|established|verified)\b/i,
				/\b(?:gap|missing|unavailable|inconclusive)\s+(?:in|for|from)\s+(?:evidence|source|documentation|retrieval)\b/i,
			])
		) {
			reasons.push("evidence_gap_claim");
		}

		if (
			matchesAny(claim, [
				/\bcan\s+be\s+(?:synthesized|derived|combined)\b/i,
				/\b(?:feasible|pragmatic|low-overhead|small[- ]team|small[- ]SaaS|baseline|tiering|action plan|implementation plan)\b[^.]{0,120}\b(?:use|combine|adopt|implement|separate|prioriti[sz]e|choose|form)\b/i,
				/\b(?:practical|feasible)\s+(?:governance\s+)?baseline\b/i,
				/\b(?:teams|organizations|implementers|small[- ]SaaS)\s+(?:should|can|could|may)\b/i,
				/\b(?:minimum|defensible|lightweight|reporting architecture|control set|runbook|checklist)\b[^.]{0,160}\b(?:should|can|could|may|use|adopt|define|separate|include|treat|cite|retain|review)\b/i,
				/\b(?:should|can|could|may)\s+(?:define|separate|include|treat|use|adopt|prefer|document|retain|review|label|choose)\b/i,
			])
		) {
			reasons.push("synthesized_recommendation_claim");
		}

		if (
			matchesAny(claim, [
				/\b(?:all|every|always|never|none|no)\s+(?:major\s+)?(?:vendors?|providers?|tools?|frameworks?|products?|services?)\b/i,
				/\b(?:vendors?|providers?|tools?|frameworks?|services?)\s+(?:all|always|never|uniformly)\b/i,
				/\b(?:AI\s+coding\s+agents|coding\s+agents|agents)\s+should\b/i,
				/\bapplicable\s+to\b[^.]{0,80}\b(?:agent|agents|small\s+team|small\s+teams)\b/i,
				/\bused\s+for\b[^.]{0,120}\b(?:framing|basis|checklist|guidance|implementation|reporting)\b/i,
			])
		) {
			reasons.push("source_broader_than_evidence_claim");
		}
	}

	return [...new Set(reasons)];
}

function demotionGap(candidate, reasons) {
	const id = candidateId(candidate);
	const claim = claimText(candidate);
	return {
		claimId: id || undefined,
		slotId: compactStrings(candidate?.factSlotIds, 1)[0],
		relatedFactSlotIds: compactStrings(candidate?.factSlotIds, 8),
		evidenceState: "not_sent_to_verifier",
		reason: `sanitized from verifier candidates: ${reasons.join(", ")}`,
		nextStep:
			"Replace with a narrow source-stated factual atom, or keep as an explicit final-report gap/recommendation caveat.",
		sourceUrls: sourceUrls(candidate).slice(0, 6),
		claim: claim || undefined,
	};
}

function preservedClaim(candidate, reasons, fallbackIndex) {
	const id =
		candidateId(candidate) ||
		`candidate-${String(fallbackIndex + 1).padStart(3, "0")}`;
	return {
		...candidate,
		id: `preserved-${id}`,
		originalCandidateId: candidateId(candidate) || undefined,
		claim: claimText(candidate) || undefined,
		status: "preserved_not_sent_to_verifier",
		sanitizerDemotionReasons: reasons,
		whyItMatters:
			stringOf(candidate?.whyItMatters) ||
			stringOf(candidate?.reasonToVerify) ||
			"Demoted by deterministic pre-verifier sanitizer and preserved for final caveats/gaps.",
	};
}

const REWRITEABLE_REASONS = new Set([
	"synthesized_recommendation_claim",
	"source_broader_than_evidence_claim",
]);

function rewrittenCandidate(candidate, reasons, hints, urlToSourceRef) {
	const rewriteReasons = reasons.filter((reason) =>
		REWRITEABLE_REASONS.has(reason),
	);
	if (rewriteReasons.length === 0 || rewriteReasons.length !== reasons.length)
		return null;
	const hint =
		hints.find((item) => item.value) ?? hints.find((item) => item.quote);
	if (!hint) return null;
	const replacement = stringOf(hint.value) || stringOf(hint.quote);
	if (!replacement || replacement === claimText(candidate)) return null;
	return {
		...candidate,
		originalClaim: claimText(candidate),
		claim: replacement,
		sourceRefs: backfillSourceRefs(candidate, [hint], urlToSourceRef),
		sourceUrls: hint.url ? [hint.url] : sourceUrls(candidate),
		sanitizerRewriteReasons: rewriteReasons,
		reasonToVerify: `Deterministically rewritten to a source-backed atom from ${hint.sourceTitleOrPublisher ?? hint.url ?? hint.sourceRef ?? "source evidence"}.`,
	};
}

function sanitizedCandidate(candidate, hints, urlToSourceRef) {
	return {
		...candidate,
		id: candidateId(candidate),
		claim: claimText(candidate),
		sourceRefs: backfillSourceRefs(candidate, hints, urlToSourceRef),
		sourceUrls: sourceUrls(candidate),
		...(hints.length > 0 ? { sourceEvidenceHints: hints } : {}),
		verifierInputPolicy: VERIFIER_INPUT_POLICY,
	};
}

function adjustFactSlotCoverage(rows, demotedBySlot, keptIds) {
	return asArray(rows).map((row) => {
		const slot = { ...asObject(row) };
		const originalIds = compactStrings(slot.verificationCandidateIds, 24);
		const filteredIds = originalIds.filter((id) => keptIds.has(id));
		const demotedIds =
			demotedBySlot.get(stringOf(slot.slotId ?? slot.id)) ?? [];
		if (originalIds.length > 0 || demotedIds.length > 0) {
			slot.verificationCandidateIds = filteredIds;
		}
		if (demotedIds.length > 0 && filteredIds.length === 0) {
			if (slot.status === "filled") slot.status = "partial";
			const prefix = stringOf(slot.gapReason);
			const note = `sanitized verifier candidates: ${demotedIds.join(", ")}`;
			slot.gapReason = prefix ? `${prefix}; ${note}` : note;
		}
		return slot;
	});
}

export default async function sanitizeVerificationCandidates({ sources }) {
	const normalized = asObject(findSource(sources, "normalize-claims"));
	const normalizeInputPacket = asObject(
		findSource(sources, "normalize-input-packet"),
	);
	const evidenceHintRows = buildEvidenceHintRows(normalizeInputPacket);
	const urlToSourceRef = buildUrlSourceRefLookup(normalizeInputPacket);
	const claimInventory = asObject(normalized.claimInventory);
	const originalCandidates = asArray(claimInventory.verificationCandidates);
	const keptCandidates = [];
	const preservedClaims = [...asArray(claimInventory.preservedClaims)];
	const coverageGaps = [...asArray(normalized.coverageGaps)];
	const demotedBySlot = new Map();
	const demotionReasonCounts = {};
	const rewriteReasonCounts = {};
	const demotedCandidateIds = [];
	const rewrittenCandidateIds = [];
	const seenIds = new Set();

	for (const [index, candidate] of originalCandidates.entries()) {
		const id = candidateId(candidate);
		const hints = evidenceHintsForCandidate(candidate, evidenceHintRows);
		const reasons = classifyCandidate(candidate, seenIds);
		if (id) seenIds.add(id);
		if (reasons.length === 0) {
			keptCandidates.push(sanitizedCandidate(candidate, hints, urlToSourceRef));
			continue;
		}
		const rewrite = rewrittenCandidate(
			candidate,
			reasons,
			hints,
			urlToSourceRef,
		);
		if (rewrite) {
			for (const reason of rewrite.sanitizerRewriteReasons) {
				rewriteReasonCounts[reason] = (rewriteReasonCounts[reason] ?? 0) + 1;
			}
			rewrittenCandidateIds.push(id || `index-${index}`);
			preservedClaims.push({
				...preservedClaim(candidate, reasons, index),
				status: "preserved_rewritten_before_verification",
			});
			keptCandidates.push(sanitizedCandidate(rewrite, hints, urlToSourceRef));
			continue;
		}
		for (const reason of reasons) {
			demotionReasonCounts[reason] = (demotionReasonCounts[reason] ?? 0) + 1;
		}
		demotedCandidateIds.push(id || `index-${index}`);
		preservedClaims.push(preservedClaim(candidate, reasons, index));
		coverageGaps.push(demotionGap(candidate, reasons));
		for (const slotId of compactStrings(candidate?.factSlotIds, 12)) {
			const list = demotedBySlot.get(slotId) ?? [];
			list.push(id || `index-${index}`);
			demotedBySlot.set(slotId, list);
		}
	}

	// Web URL-only candidates cannot rejoin the wsrc ledger at audit time
	// (observed as sourceRefJoinFailures on never-fetched URLs), so route them
	// to backlog and refill the pool from source-backed preserved claims.
	const webUrlOnlyDemotedIds = [];
	const promotedCandidateIds = [];
	const promotedBySlot = new Map();
	const retainedCandidates = [];
	for (const [index, candidate] of keptCandidates.entries()) {
		const hasRefs = sourceRefs(candidate).length > 0;
		const hasLocal = localEvidenceRefs(candidate).length > 0;
		if (hasRefs || hasLocal || sourceUrls(candidate).length === 0) {
			retainedCandidates.push(candidate);
			continue;
		}
		const id = candidateId(candidate) || `index-${index}`;
		const reasons = ["web_url_without_source_ref_after_backfill"];
		demotionReasonCounts[reasons[0]] =
			(demotionReasonCounts[reasons[0]] ?? 0) + 1;
		webUrlOnlyDemotedIds.push(id);
		demotedCandidateIds.push(id);
		preservedClaims.push({
			...preservedClaim(candidate, reasons, index),
			status: "preserved_missing_source_ref",
		});
		coverageGaps.push({
			...demotionGap(candidate, reasons),
			nextStep:
				"Reacquire this claim's source with workflow_web_fetch_source so a wsrc_* sourceRef exists, or keep it as an explicit final-report gap.",
		});
		for (const slotId of compactStrings(candidate?.factSlotIds, 12)) {
			const list = demotedBySlot.get(slotId) ?? [];
			list.push(id);
			demotedBySlot.set(slotId, list);
		}
	}
	keptCandidates.length = 0;
	keptCandidates.push(...retainedCandidates);

	if (webUrlOnlyDemotedIds.length > 0) {
		const takenIds = new Set(
			keptCandidates.map((candidate) => candidateId(candidate)),
		);
		const promotable = [];
		for (const [index, preserved] of asArray(
			claimInventory.preservedClaims,
		).entries()) {
			const claim = claimText(preserved);
			if (!claim) continue;
			const id =
				candidateId(preserved) ||
				`promoted-${String(index + 1).padStart(3, "0")}`;
			if (takenIds.has(id)) continue;
			const hints = evidenceHintsForCandidate(preserved, evidenceHintRows);
			const refs = backfillSourceRefs(preserved, hints, urlToSourceRef);
			if (refs.length === 0) continue;
			if (!hints.some((hint) => stringOf(hint.quote))) continue;
			if (classifyCandidate({ ...preserved, id }, new Set()).length > 0) {
				continue;
			}
			const slots = compactStrings(preserved?.factSlotIds, 12);
			if (slots.length === 0) continue;
			const rescuesSlot = slots.some(
				(slotId) => (demotedBySlot.get(slotId) ?? []).length > 0,
			);
			promotable.push({ preserved, id, hints, refs, slots, rescuesSlot });
		}
		promotable.sort(
			(left, right) => Number(right.rescuesSlot) - Number(left.rescuesSlot),
		);
		for (const entry of promotable.slice(0, webUrlOnlyDemotedIds.length)) {
			takenIds.add(entry.id);
			promotedCandidateIds.push(entry.id);
			for (const slotId of entry.slots) {
				const list = promotedBySlot.get(slotId) ?? [];
				list.push(entry.id);
				promotedBySlot.set(slotId, list);
			}
			keptCandidates.push(
				sanitizedCandidate(
					{
						...entry.preserved,
						id: entry.id,
						sourceRefs: entry.refs,
						verificationNeed:
							stringOf(entry.preserved?.verificationNeed) || "useful",
						reasonToVerify:
							stringOf(entry.preserved?.reasonToVerify) ||
							stringOf(entry.preserved?.whyItMatters) ||
							"Promoted source-backed preserved claim to replace a URL-only candidate.",
					},
					entry.hints,
					urlToSourceRef,
				),
			);
		}
	}

	const keptIds = new Set(keptCandidates.map((candidate) => candidate.id));
	const factSlotCoverageRows = adjustFactSlotCoverage(
		normalized.factSlotCoverage,
		demotedBySlot,
		keptIds,
	).map((row) => {
		const slotId = stringOf(row.slotId ?? row.id);
		const promoted = promotedBySlot.get(slotId) ?? [];
		if (promoted.length === 0) return row;
		return {
			...row,
			verificationCandidateIds: compactStrings(
				[...asArray(row.verificationCandidateIds), ...promoted],
				24,
			),
		};
	});
	return {
		schema: SCHEMA,
		claimInventory: {
			verificationCandidates: keptCandidates,
			preservedClaims,
			duplicates: asArray(claimInventory.duplicates),
		},
		factSlotCoverage: factSlotCoverageRows,
		coverageGaps,
		researchScopeCoverage: asArray(normalized.researchScopeCoverage),
		normalizationNotes: normalized.normalizationNotes,
		sanitizerDiagnostics: {
			inputCandidateCount: originalCandidates.length,
			keptCandidateCount: keptCandidates.length,
			demotedCandidateCount: demotedCandidateIds.length,
			rewrittenCandidateCount: rewrittenCandidateIds.length,
			webUrlOnlyDemotedCount: webUrlOnlyDemotedIds.length,
			promotedCandidateCount: promotedCandidateIds.length,
			demotionReasonCounts,
			rewriteReasonCounts,
			keptCandidateIds: keptCandidates.map((candidate) => candidate.id),
			demotedCandidateIds,
			webUrlOnlyDemotedIds,
			promotedCandidateIds,
			rewrittenCandidateIds,
			verifierInputPolicy: VERIFIER_INPUT_POLICY,
			sourceEvidenceHintRows: evidenceHintRows.length,
		},
	};
}
