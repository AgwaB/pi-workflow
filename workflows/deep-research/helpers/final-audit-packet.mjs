// Deterministic compact input packet for deep-research final-audit.
//
// This helper performs mechanical joins only: it copies plan metadata,
// normalize-claims ledgers, and audit-claims verdict partitions into a compact
// packet. It does not choose truth, promote/downgrade claims, or write final
// recommendations. The final-audit LLM remains responsible for synthesis while
// consuming these code-computed ledgers as ground truth for counts and buckets.

const SCHEMA = "deep-research-final-audit-packet-v1";

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

function asArray(value) {
	return Array.isArray(value) ? value : [];
}

function asObject(value) {
	return value && typeof value === "object" && !Array.isArray(value)
		? value
		: {};
}

function stringOf(value) {
	return typeof value === "string" ? value : undefined;
}

function idOf(value) {
	return stringOf(value?.id) ?? stringOf(value?.claimId) ?? null;
}

function compactStrings(values, limit = 5) {
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

function truncateText(value, limit = 240) {
	const text = stringOf(value);
	if (!text) return undefined;
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= limit) return normalized;
	return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

const EVIDENCE_FIELDS = [
	"source",
	"url",
	"sourceRef",
	"file",
	"repo",
	"line",
	"lineStart",
	"lineEnd",
	"lines",
	"excerptLocation",
	"dateOrYear",
	"quote",
	"relevance",
	"matchType",
	"matchedTerms",
	"missingTerms",
	"coverageRatio",
	"candidateOnly",
];

function compactEvidenceRow(row) {
	const item = asObject(row);
	const result = {};
	for (const field of EVIDENCE_FIELDS) {
		const value = item[field];
		if (typeof value === "string" && value.trim()) result[field] = value;
		else if (typeof value === "number" && Number.isFinite(value))
			result[field] = value;
		else if (typeof value === "boolean") result[field] = value;
		else if (Array.isArray(value)) result[field] = compactStrings(value, 12);
	}
	return result;
}

function compactEvidenceRows(rows) {
	return asArray(rows).slice(0, 5).map(compactEvidenceRow);
}

function compactClaimDigest(claim) {
	const digest = asObject(claim);
	const evidence = compactEvidenceRows(digest.evidence);
	return {
		id: idOf(digest),
		claim: stringOf(digest.claim),
		status: stringOf(digest.status ?? digest.verdict),
		confidence: stringOf(digest.confidence),
		factSlotIds: compactStrings(digest.factSlotIds, 12),
		sourceRefs: compactStrings(digest.sourceRefs, Infinity),
		sourceUrls: compactStrings(digest.sourceUrls, Infinity),
		...(digest.verifierOwner
			? { verifierOwner: compactOwner(digest.verifierOwner) }
			: {}),
		support: stringOf(
			digest.verdictDigest?.support ??
				digest.verdictDigest?.summary ??
				digest.verdictDigest,
		),
		caveat: stringOf(digest.verdictDigest?.caveat ?? digest.caveat),
		correctionOrCounterclaim: stringOf(digest.correctionOrCounterclaim),
		...(evidence.length > 0 ? { evidence } : {}),
		...(Array.isArray(digest.localQuoteGate)
			? { localQuoteGate: digest.localQuoteGate }
			: {}),
		...(digest.evidenceGate ? { evidenceGate: digest.evidenceGate } : {}),
	};
}

function compactSlot(slot) {
	const item = asObject(slot);
	return {
		slotId: stringOf(item.slotId ?? item.id),
		label: stringOf(item.label),
		status: stringOf(item.status),
		bestValue: item.bestValue,
		sourceUrls: compactStrings(item.sourceUrls, Infinity),
		sourceRefs: compactStrings(item.sourceRefs, Infinity),
		sourceQuality: stringOf(item.sourceQuality),
		verificationCandidateIds: compactStrings(item.verificationCandidateIds, 64),
		gapReason: stringOf(item.gapReason),
		parentImpact: stringOf(item.parentImpact),
	};
}

function reconcileFactSlotCoverageWithAudit(
	factSlots,
	claimDigests,
	candidateIds = [],
) {
	const claimsBySlot = new Map();
	const slotById = new Map(factSlots.map((slot) => [slot.slotId, slot]));
	const candidateSet = new Set(candidateIds);
	const addedReverseBindings = [];
	const invalidCanonicalMemberships = [];
	const canonicalBindings = new Set();
	for (const claim of claimDigests) {
		const claimId = idOf(claim);
		if (!claimId || (candidateSet.size > 0 && !candidateSet.has(claimId)))
			continue;
		for (const slotId of compactStrings(claim.factSlotIds, 12)) {
			const slot = slotById.get(slotId);
			if (!slot) {
				invalidCanonicalMemberships.push({ claimId, slotId });
				continue;
			}
			canonicalBindings.add(`${slotId}\u0000${claimId}`);
			const current = Array.isArray(slot.verificationCandidateIds)
				? slot.verificationCandidateIds
				: [];
			if (!current.includes(claimId)) {
				slot.verificationCandidateIds = [...current, claimId];
				addedReverseBindings.push({ claimId, slotId });
			}
		}
	}
	const preservedReverseBindings = [];
	for (const slot of factSlots) {
		for (const candidateId of Array.isArray(slot.verificationCandidateIds)
			? slot.verificationCandidateIds
			: []) {
			if (!canonicalBindings.has(`${slot.slotId}\u0000${candidateId}`))
				preservedReverseBindings.push({
					slotId: slot.slotId,
					candidateId,
					reason: "reverse hint is absent from canonical claim factSlotIds",
				});
		}
	}

	for (const claim of claimDigests) {
		for (const slotId of compactStrings(claim.factSlotIds, 12)) {
			const claims = claimsBySlot.get(slotId) ?? [];
			claims.push(claim);
			claimsBySlot.set(slotId, claims);
		}
	}
	const reconciledFactSlots = factSlots.map((slot) => {
		const claims = claimsBySlot.get(slot.slotId) ?? [];
		if (claims.length === 0) {
			return slot.status === "filled"
				? {
						...slot,
						status: "partial",
						gapReason:
							slot.gapReason || "no audited claim was available for this filled slot",
					}
				: slot;
		}
		const statuses = new Set(claims.map((claim) => stringOf(claim.status)));
		const claimIds = compactStrings(claims.map(idOf), 12);
		if (statuses.has("conflicting")) {
			const corrections = compactStrings(
				claims.map((claim) => claim.correctionOrCounterclaim),
				4,
			);
			const reason = `audited claim status is conflicting${claimIds.length ? ` (${claimIds.join(", ")})` : ""}`;
			return {
				...slot,
				status: "conflicting",
				// Preserve the audited correction for final-report consumers; status,
				// rather than bestValue presence, remains the coverage authority.
				bestValue:
					corrections.join(" | ") ||
					"Verifier evidence conflicts with the normalized value; see claim ledger.",
				gapReason: slot.gapReason ? `${slot.gapReason}; ${reason}` : reason,
			};
		}
		if (
			!statuses.has("verified") &&
			slot.status === "filled" &&
			["partially_supported", "unsupported", "verification_blocked"].some(
				(status) => statuses.has(status),
			)
		) {
			const reason = `no audited verified claim${claimIds.length ? ` (${claimIds.join(", ")})` : ""}`;
			return {
				...slot,
				status: "partial",
				gapReason: slot.gapReason ? `${slot.gapReason}; ${reason}` : reason,
			};
		}
		return slot;
	});
	return {
		factSlots: reconciledFactSlots,
		reconciliation: {
			source: "canonical normalized claim factSlotIds",
			addedReverseBindings,
			preservedReverseBindings,
			invalidCanonicalMemberships,
		},
	};
}

function compactGap(gap) {
	const item = asObject(gap);
	return {
		id: stringOf(item.id ?? item.gapId),
		claimId: stringOf(item.claimId),
		slotId: stringOf(item.slotId),
		evidenceState: stringOf(item.evidenceState),
		reason: stringOf(item.reason ?? item.gapReason),
		nextStep: stringOf(item.nextStep),
		sourceUrls: compactStrings(item.sourceUrls, Infinity),
		sourceRefs: compactStrings(item.sourceRefs, Infinity),
		relatedFactSlotIds: compactStrings(item.relatedFactSlotIds, 8),
		scopeItem: stringOf(item.scopeItem),
		whyItMatters: stringOf(item.whyItMatters),
	};
}

function compactVerifierIssue(issue) {
	const item = asObject(issue);
	return {
		sourceId: stringOf(item.sourceId),
		claimId: stringOf(item.claimId),
		reason: stringOf(item.reason),
		status: stringOf(item.status),
		nextStep: stringOf(item.nextStep),
	};
}

function compactInvalidNormalizedCandidate(row) {
	const item = asObject(row);
	return {
		index: Number.isSafeInteger(Number(item.index))
			? Number(item.index)
			: undefined,
		claimId: stringOf(item.claimId),
		reason: stringOf(item.reason),
		nextStep: stringOf(item.nextStep),
	};
}

function compactOwner(owner) {
	const item = asObject(owner);
	return {
		source: stringOf(item.source),
		stageId: stringOf(item.stageId),
		specId: stringOf(item.specId),
		taskId: stringOf(item.taskId),
		itemIdentity: stringOf(item.itemIdentity),
		placeholderSpecId: stringOf(item.placeholderSpecId),
		...(stringOf(item.batchId) ? { batchId: stringOf(item.batchId) } : {}),
		status: stringOf(item.status),
	};
}

function compactDuplicateVerifierRow(row) {
	const item = asObject(row);
	return {
		claimId: stringOf(item.claimId),
		rowCount: Number.isFinite(Number(item.rowCount))
			? Number(item.rowCount)
			: undefined,
		sourceIds: compactStrings(item.sourceIds, 8),
		statusInputs: compactStrings(item.statusInputs, 8),
		selectedStatus: stringOf(item.selectedStatus),
		statusConflict: item.statusConflict === true,
		sourceRefs: compactStrings(item.sourceRefs, Infinity),
		sourceUrls: compactStrings(item.sourceUrls, Infinity),
		action: stringOf(item.action),
	};
}

function compactReadinessBlocker(blocker) {
	const item = asObject(blocker);
	return {
		reason: stringOf(item.reason),
		count: Number.isFinite(Number(item.count)) ? Number(item.count) : undefined,
	};
}

function compactBatchAdoptionReadiness(readiness) {
	const item = asObject(readiness);
	const blockers = asArray(item.blockers).map(compactReadinessBlocker);
	if (!stringOf(item.status) && blockers.length === 0) return {};
	return {
		status: stringOf(item.status),
		...(typeof item.adopted === "boolean" ? { adopted: item.adopted } : {}),
		...(typeof item.canaryRequired === "boolean"
			? { canaryRequired: item.canaryRequired }
			: {}),
		reason: stringOf(item.reason),
		blockers,
	};
}

function countByStatus(slots) {
	const counts = {};
	for (const slot of slots) {
		const status = stringOf(slot.status) ?? "unknown";
		counts[status] = (counts[status] ?? 0) + 1;
	}
	return counts;
}

function withGeneratedIds(items, prefix) {
	return items.map((item, index) => ({
		...item,
		id: stringOf(item.id) ?? `${prefix}-${String(index + 1).padStart(3, "0")}`,
	}));
}

function synthesisClaimDigest(claim) {
	const item = compactClaimDigest(claim);
	return {
		id: item.id,
		claim: truncateText(item.claim, 260),
		status: item.status,
		confidence: item.confidence,
		factSlotIds: compactStrings(item.factSlotIds, 8),
		support: truncateText(item.support, 240),
		caveat: truncateText(item.caveat, 180),
		correctionOrCounterclaim: truncateText(item.correctionOrCounterclaim, 180),
		...(item.evidence ? { evidence: item.evidence } : {}),
		...(item.localQuoteGate ? { localQuoteGate: item.localQuoteGate } : {}),
		hasSourceUrls: compactStrings(item.sourceUrls, 1).length > 0,
		hasSourceRefs: compactStrings(item.sourceRefs, 1).length > 0,
	};
}

function synthesisFactSlot(slot) {
	const item = asObject(slot);
	return {
		slotId: stringOf(item.slotId),
		label: truncateText(item.label, 120),
		status: stringOf(item.status),
		gapReason: truncateText(item.gapReason, 120),
		parentImpact: truncateText(item.parentImpact, 120),
	};
}

function synthesisGap(gap) {
	const item = asObject(gap);
	return {
		id: stringOf(item.id),
		kind: stringOf(item.kind),
		claimId: stringOf(item.claimId),
		slotId: stringOf(item.slotId),
		evidenceState: stringOf(item.evidenceState),
		reason: truncateText(item.reason, 220),
		nextStep: truncateText(item.nextStep, 180),
		sourceRefs: compactStrings(item.sourceRefs, Infinity),
		sourceUrls: compactStrings(item.sourceUrls, Infinity),
		scopeItem: truncateText(item.scopeItem, 160),
		whyItMatters: truncateText(item.whyItMatters, 180),
	};
}

function synthesisScopeCoverage(row) {
	const item = asObject(row);
	return {
		scopeItem: truncateText(item.scopeItem ?? item.item ?? item.topic, 160),
		status: stringOf(item.status ?? item.coverageStatus),
		evidenceState: stringOf(item.evidenceState),
		summary: truncateText(item.summary ?? item.reason, 220),
		whyItMatters: truncateText(item.whyItMatters, 180),
	};
}

function synthesisQuestionCoverage(row) {
	const item = asObject(row);
	return {
		// Question/source identities are never truncated in the projection. If
		// hostile valid identities make the projection too large, the typed budget
		// block below is emitted rather than presenting a partial identity as exact.
		questionId: stringOf(item.questionId),
		status: stringOf(item.status),
		failureStatus: stringOf(item.failureStatus),
		sourceIds: compactStrings(item.sourceIds, 4),
	};
}

function synthesisQuestionIntegrity(coverage) {
	const item = asObject(coverage);
	const issueIds = (value) => compactStrings(value, 64);
	return {
		passed: item.passed === true,
		plannedCount: asArray(item.plannedIds).length,
		completedCount: asArray(item.completedIds).length,
		missingIds: issueIds(item.missingIds),
		duplicateIds: issueIds(item.duplicateIds),
		extraIds: issueIds(item.extraIds),
		failedIds: issueIds(item.failedIds),
		invalidPlannedQuestionCount: Number(item.invalidPlannedQuestionCount ?? 0),
		plannedDuplicateIds: issueIds(item.plannedDuplicateIds),
		invalidOutputSourceIds: issueIds(item.invalidOutputSourceIds),
	};
}

const SYNTHESIS_READ_MAX_CHARS = 24000;

function codePointLength(value) {
	return [...String(value ?? "")].length;
}

function truncateCodePoints(value, limit) {
	const text = stringOf(value);
	if (!text) return undefined;
	const points = [...text];
	return points.length <= limit
		? text
		: `${points.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

function compactSynthesisForBudget(
	input,
	maxChars = SYNTHESIS_READ_MAX_CHARS,
) {
	const compact = structuredClone(input);
	const projectionLosses = [];
	const textFields = [
		["claims", ["claim", "support", "caveat", "correctionOrCounterclaim"], 120],
		["factSlots", ["label", "gapReason", "parentImpact"], 80],
		["preservedClaims", ["claim", "whyItMatters"], 100],
		["gaps", ["reason", "nextStep", "scopeItem", "whyItMatters"], 100],
		["researchScopeCoverage", ["scopeItem", "summary", "whyItMatters"], 90],
	];
	for (const [collection, fields, limit] of textFields) {
		for (const row of compact[collection] ?? []) {
			for (const field of fields)
				row[field] = truncateCodePoints(row[field], limit);
		}
	}
	const serializedLength = (value) => JSON.stringify(value).length;
	const budgetFor = (blocked = false) => ({
		maxChars,
		claimRowsPreserved: asArray(compact.claims).length,
		gapRowsPreserved: asArray(compact.gaps).length,
		textCompacted: serializedLength(compact) < serializedLength(input),
		codePointTelemetry: {
			maxCodePoints: 22000,
			codePoints: 0,
		},
		utf16Chars: 0,
		...(projectionLosses.length > 0 ? { projectionLosses } : {}),
		...(blocked
			? {
					budgetBlock: {
						status: "blocked",
						reason:
							"synthesis input cannot preserve its required projection within the serialized read budget",
						action:
							"Do not synthesize from this projection; use the canonical packet ledger and increase the supported projection budget only through an owner-approved contract change.",
						canonicalLedgerPreserved: true,
					},
				}
			: {}),
	});
	const withBudget = (blocked = false) => {
		const result = { ...compact, inputBudget: budgetFor(blocked) };
		// The consumer uses String.length, so publish telemetry measured from the
		// exact JSON serialization, including this metadata. Iterate because the
		// telemetry digits are part of that serialization too.
		for (let attempt = 0; attempt < 12; attempt += 1) {
			const encoded = JSON.stringify(result);
			const nextChars = encoded.length;
			const nextCodePoints = codePointLength(encoded);
			const stable =
				result.inputBudget.utf16Chars === nextChars &&
				result.inputBudget.codePointTelemetry.codePoints === nextCodePoints;
			result.inputBudget.utf16Chars = nextChars;
			result.inputBudget.codePointTelemetry.codePoints = nextCodePoints;
			if (stable) break;
		}
		return result;
	};
	const measure = () => serializedLength(withBudget(false));
	if (measure() > maxChars) {
		for (const row of compact.claims ?? []) {
			row.claim = truncateCodePoints(row.claim, 48);
			row.support = truncateCodePoints(row.support, 48);
			row.caveat = truncateCodePoints(row.caveat, 48);
			row.correctionOrCounterclaim = truncateCodePoints(
				row.correctionOrCounterclaim,
				48,
			);
		}
		for (const row of compact.gaps ?? []) {
			row.reason = truncateCodePoints(row.reason, 48);
			row.nextStep = truncateCodePoints(row.nextStep, 48);
		}
	}
	// Claims and fact-slot rows are the supported synthesis ledgers. Optional
	// narrative rows may be omitted only with an auditable projection loss.
	if (measure() > maxChars) {
		for (const field of ["researchScopeCoverage", "preservedClaims", "gaps"]) {
			const count = asArray(compact[field]).length;
			if (count === 0) continue;
			projectionLosses.push({
				path: `$.${field}`,
				omittedCount: count,
				reason: "optional narrative projection omitted to preserve core ledgers",
			});
			compact[field] = [];
			if (measure() <= maxChars) break;
		}
	}
	// If even the core projection cannot fit (for example, hostile identity
	// strings), fail closed with a typed budget block. Never truncate an
	// authoritative claim id or silently lower the supported claim count.
	if (measure() > maxChars) {
		for (const field of ["claims", "factSlots", "researchQuestionCoverage"]) {
			const count = asArray(compact[field]).length;
			if (count === 0) continue;
			projectionLosses.push({
				path: `$.${field}`,
				omittedCount: count,
				reason:
					"core projection omitted because authoritative identities cannot fit; canonical packet remains authoritative",
			});
			compact[field] = [];
		}
		return withBudget(true);
	}
	return withBudget(false);
}

function buildSynthesisInput({
	plan,
	factSlotCoverage,
	claimDigests,
	preservedClaims,
	coverageGaps,
	remainingGaps,
	sourceRefJoinFailures,
	researchScopeCoverage,
	integritySummary,
	audit,
	researchQuestionCoverage,
}) {
	return {
		researchMetadata: {
			depth: stringOf(plan.depth),
			taskType: stringOf(plan.taskType),
			expectedFinalShape: stringOf(plan.expectedFinalShape),
			researchQuestions: asArray(plan.researchQuestions).length,
			plannedFactSlots: asArray(plan.factSlots).length,
		},
		researchQuestionCoverage: asArray(researchQuestionCoverage?.rows).map(
			synthesisQuestionCoverage,
		),
		verdictCounts: asObject(audit.verdictCounts),
		factSlotStatusCounts: countByStatus(factSlotCoverage),
		integritySummary: {
			...integritySummary,
			...(researchQuestionCoverage
				? {
						researchQuestionIntegrity: synthesisQuestionIntegrity(
							researchQuestionCoverage,
						),
					}
				: {}),
		},
		researchScopeCoverage: asArray(researchScopeCoverage)
			.slice(0, 24)
			.map(synthesisScopeCoverage),
		factSlots: factSlotCoverage.map(synthesisFactSlot),
		claims: claimDigests.map(synthesisClaimDigest),
		preservedClaims: preservedClaims.slice(0, 12).map((claim) => ({
			id: idOf(claim),
			claim: truncateText(claim.claim, 240),
			factSlotIds: compactStrings(claim.factSlotIds, 8),
			whyItMatters: truncateText(claim.whyItMatters ?? claim.reason, 180),
		})),
		gaps: [
			...remainingGaps.map((gap) => synthesisGap({ ...gap, kind: "remaining" })),
			...coverageGaps.map((gap) => synthesisGap({ ...gap, kind: "coverage" })),
			...sourceRefJoinFailures.map((gap) =>
				synthesisGap({ ...gap, kind: "sourceRefJoinFailure" }),
			),
		],
	};
}

export default async function finalAuditPacket({ sources }) {
	const plan = asObject(findSource(sources, "plan"));
	const normalizeClaims = asObject(findSource(sources, "normalize-claims"));
	const sanitizedCandidates = asObject(findSource(sources, "sanitize-claims"));
	const normalized =
		Object.keys(sanitizedCandidates).length > 0
			? sanitizedCandidates
			: normalizeClaims;
	const sanitizerDiagnostics = asObject(normalized.sanitizerDiagnostics);
	const auditSource = findSource(sources, "audit-claims");
	if (
		!auditSource ||
		typeof auditSource !== "object" ||
		Array.isArray(auditSource)
	) {
		throw new Error(
			"deep-research final-audit-packet: missing audit-claims control source; refusing to emit an empty packet",
		);
	}
	const audit = auditSource;
	const inputPacket = asObject(findSource(sources, "normalize-input-packet"));
	const questionCoverageInput = inputPacket.packet?.researchQuestionCoverage;
	const researchQuestionCoverage =
		questionCoverageInput &&
		typeof questionCoverageInput === "object" &&
		!Array.isArray(questionCoverageInput) &&
		typeof questionCoverageInput.passed === "boolean"
			? questionCoverageInput
			: null;
	// These fields establish that the audit stage actually ran and produced an
	// auditable ledger. Do not turn an absent/incomplete audit into a valid empty packet.
	const incompleteAuditFields = [
		["claimDigests", Array.isArray(audit.claimDigests)],
		[
			"gateSummary",
			audit.gateSummary &&
				typeof audit.gateSummary === "object" &&
				!Array.isArray(audit.gateSummary),
		],
	]
		.filter(([, present]) => !present)
		.map(([field]) => field);
	const hasAuditLedger =
		Object.keys(audit.gateSummary ?? {}).length > 0 ||
		(audit.verdictCounts &&
			typeof audit.verdictCounts === "object" &&
			!Array.isArray(audit.verdictCounts) &&
			Object.keys(audit.verdictCounts).length > 0) ||
		(audit.statusPartitions &&
			typeof audit.statusPartitions === "object" &&
			!Array.isArray(audit.statusPartitions) &&
			Object.keys(audit.statusPartitions).length > 0);
	if (
		incompleteAuditFields.length === 0 &&
		audit.claimDigests.length === 0 &&
		!hasAuditLedger
	)
		incompleteAuditFields.push("audit ledgers");
	if (incompleteAuditFields.length > 0) {
		throw new Error(
			`deep-research final-audit-packet: incomplete audit-claims control (${incompleteAuditFields.join(", ")}); refusing to emit a valid empty packet`,
		);
	}
	const claimInventory = asObject(normalized.claimInventory);
	const verificationCandidates = asArray(claimInventory.verificationCandidates);
	const preservedClaims = asArray(claimInventory.preservedClaims);
	const auditedClaimsById = new Map(
		asArray(audit.auditedClaims)
			.map((claim) => [idOf(claim), claim])
			.filter(([id]) => id),
	);
	const claimDigests = asArray(audit.claimDigests).map((digest) => {
		const audited = auditedClaimsById.get(idOf(digest));
		return compactClaimDigest({
			...digest,
			...(audited?.evidence ? { evidence: audited.evidence } : {}),
			...(Array.isArray(audited?.localQuoteGate)
				? { localQuoteGate: audited.localQuoteGate }
				: {}),
		});
	});
	const auditedIds = new Set(claimDigests.map(idOf).filter(Boolean));
	const candidateIds = verificationCandidates.map(idOf).filter(Boolean);
	const omittedCandidateIds = candidateIds.filter((id) => !auditedIds.has(id));
	const factSlotReconciliation = reconcileFactSlotCoverageWithAudit(
		asArray(normalized.factSlotCoverage).map(compactSlot),
		claimDigests,
		candidateIds,
	);
	const factSlotCoverage = factSlotReconciliation.factSlots;
	const coverageGaps = withGeneratedIds(
		asArray(normalized.coverageGaps).map(compactGap),
		"gap-coverage",
	);
	const remainingGaps = withGeneratedIds(
		asArray(audit.remainingGaps).map(compactGap),
		"gap-remaining",
	);
	const sourceRefJoinFailures = withGeneratedIds(
		asArray(audit.sourceRefJoinFailures).map(compactGap),
		"gap-source-ref",
	);
	const invalidVerifierRows = asArray(audit.invalidVerifierRows).map(
		compactVerifierIssue,
	);
	const duplicateVerifierRows = asArray(audit.duplicateVerifierRows).map(
		compactDuplicateVerifierRow,
	);
	const invalidNormalizedCandidateRows = asArray(
		audit.invalidNormalizedCandidates,
	).map(compactInvalidNormalizedCandidate);
	const verifierOwnerLedger = asArray(audit.verifierOwnerLedger).map(
		compactOwner,
	);
	const verifierOwnerIssues = asArray(audit.verifierOwnerIssues).map(
		compactVerifierIssue,
	);
	const gateSummary = asObject(audit.gateSummary);
	const batchAdoptionReadiness = compactBatchAdoptionReadiness(
		audit.batchAdoptionReadiness,
	);
	const zeroCandidateFloorBlockerInput = Number(
		gateSummary.zeroCandidateFloorBlockers ?? 0,
	);
	const zeroCandidateFloorBlockers = Number.isFinite(
		zeroCandidateFloorBlockerInput,
	)
		? zeroCandidateFloorBlockerInput
		: 0;
	const precisionGuardDiagnostics = asObject(audit.precisionGuardDiagnostics);
	const sourceRefCoverage = {
		verificationCandidatesWithSourceRefs: verificationCandidates.filter(
			(candidate) => compactStrings(candidate?.sourceRefs, 1).length > 0,
		).length,
		auditedClaimsWithSourceRefs: claimDigests.filter(
			(claim) => compactStrings(claim?.sourceRefs, 1).length > 0,
		).length,
		sourceRefJoinFailures: sourceRefJoinFailures.length,
	};
	const integritySummary = {
		...(researchQuestionCoverage
			? { researchQuestionIntegrity: researchQuestionCoverage }
			: {}),
		omittedVerificationCandidateCount: omittedCandidateIds.length,
		sourceRefJoinFailures: sourceRefJoinFailures.length,
		invalidVerifierRows: invalidVerifierRows.length,
		duplicateVerifierRows: duplicateVerifierRows.length,
		verifierOwnerIssues: verifierOwnerIssues.length,
		invalidNormalizedCandidateCount: invalidNormalizedCandidateRows.length,
		invalidNormalizedCandidateRows,
		missingVerifierResults: Number(gateSummary.missingVerifierResults ?? 0),
		zeroCandidateFloorBlockers,
		batchAdoptionStatus: stringOf(batchAdoptionReadiness.status),
		batchAdoptionBlockers: asArray(batchAdoptionReadiness.blockers),
		sourceRefCoverage,
	};
	const synthesisInput = compactSynthesisForBudget(
		buildSynthesisInput({
			plan,
			factSlotCoverage,
			claimDigests,
			preservedClaims,
			coverageGaps,
			remainingGaps,
			sourceRefJoinFailures,
			researchScopeCoverage: normalized.researchScopeCoverage,
			integritySummary,
			audit,
			researchQuestionCoverage,
		}),
		SYNTHESIS_READ_MAX_CHARS,
	);

	return {
		schema: SCHEMA,
		digest: `Prepared final-audit packet with ${claimDigests.length} audited claim(s), ${factSlotCoverage.length} fact slot(s), and ${remainingGaps.length + coverageGaps.length + sourceRefJoinFailures.length} gap row(s).`,
		packet: {
			synthesisInput,
			researchMetadataSeed: {
				depth: stringOf(plan.depth),
				taskType: stringOf(plan.taskType),
				expectedFinalShape: stringOf(plan.expectedFinalShape),
				researchQuestions: asArray(plan.researchQuestions).length,
				sourcePolicy: asObject(plan.sourcePolicy),
				plannedFactSlots: asArray(plan.factSlots).length,
				filledFactSlots: factSlotCoverage.filter((slot) => slot.status === "filled")
					.length,
				partialFactSlots: factSlotCoverage.filter(
					(slot) => slot.status === "partial",
				).length,
				missingOnlyFactSlots: factSlotCoverage.filter(
					(slot) => slot.status === "missing",
				).length,
				// Keep the legacy unresolved total backward-complete. The explicit
				// fields make its overlap with conflictingFactSlots machine-readable.
				missingFactSlots: factSlotCoverage.filter((slot) =>
					["missing", "conflicting"].includes(slot.status),
				).length,
				missingFactSlotsIncludesConflicting: true,
				conflictingFactSlots: factSlotCoverage.filter(
					(slot) => slot.status === "conflicting",
				).length,
			},
			verdictCounts: asObject(audit.verdictCounts),
			statusPartitions: asObject(audit.statusPartitions),
			factSlotCoverage,
			factSlotStatusCounts: countByStatus(factSlotCoverage),
			coverageGaps,
			remainingGaps,
			sourceRefJoinFailures,
			claimVerdictLedger: claimDigests,
			verifierIntegrity: {
				gateSummary,
				researchQuestionIntegrity: researchQuestionCoverage,
				invalidVerifierRows,
				duplicateVerifierRows,
				invalidNormalizedCandidateCount: invalidNormalizedCandidateRows.length,
				invalidNormalizedCandidateRows,
				verifierOwnerLedger,
				verifierOwnerIssues,
				...(stringOf(batchAdoptionReadiness.status)
					? { batchAdoptionReadiness }
					: {}),
			},
			normalizerDiagnostics: {
				precisionGuard: precisionGuardDiagnostics,
				sanitizer: sanitizerDiagnostics,
			},
			preservedClaims: preservedClaims.map((claim) => ({
				id: idOf(claim),
				claim: stringOf(claim.claim),
				factSlotIds: compactStrings(claim.factSlotIds, 8),
				sourceRefs: compactStrings(claim.sourceRefs, Infinity),
				sourceUrls: compactStrings(claim.sourceUrls, Infinity),
				whyItMatters: stringOf(claim.whyItMatters ?? claim.reason),
			})),
			researchScopeCoverage: asArray(normalized.researchScopeCoverage),
			researchQuestionCoverage: asArray(researchQuestionCoverage?.rows),
			factSlotReconciliation: factSlotReconciliation.reconciliation,
			invariantChecks: {
				candidateCount: verificationCandidates.length,
				factSlotReconciliation: factSlotReconciliation.reconciliation,
				auditedClaimCount: claimDigests.length,
				candidateIds,
				auditedClaimIds: claimDigests.map(idOf),
				statusPartitionIds: asObject(audit.statusPartitions),
				omittedCandidateIds,
				droppedSlotIds: asArray(audit.slotCoverageCheck?.droppedSlotIds),
				researchQuestionIntegrity: researchQuestionCoverage,
				sourceRefCoverage,
				verifierIntegrity: {
					invalidVerifierRows: invalidVerifierRows.length,
					researchQuestionIntegrity: researchQuestionCoverage,
					duplicateVerifierRows: duplicateVerifierRows.length,
					invalidNormalizedCandidateCount: invalidNormalizedCandidateRows.length,
					verifierOwnerIssues: verifierOwnerIssues.length,
					missingVerifierResults: Number(gateSummary.missingVerifierResults ?? 0),
					zeroCandidateFloorBlockers,
					batchAdoptionStatus: stringOf(batchAdoptionReadiness.status),
				},
			},
			overflowLedger: {
				preservedClaimCount: preservedClaims.length,
				coverageGapCount: coverageGaps.length,
				remainingGapCount: remainingGaps.length,
				omittedVerificationCandidateCount: omittedCandidateIds.length,
				invalidVerifierRowCount: invalidVerifierRows.length,
				duplicateVerifierRowCount: duplicateVerifierRows.length,
				invalidNormalizedCandidateCount: invalidNormalizedCandidateRows.length,
				verifierOwnerIssueCount: verifierOwnerIssues.length,
			},
		},
	};
}
