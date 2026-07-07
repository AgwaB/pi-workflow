import assert from "node:assert/strict";
import test from "node:test";

function repoLocalZeroCandidateSources() {
	return {
		"plan.main": {
			depth: "standard",
			taskType: "implementation_guidance",
			expectedFinalShape: "implementation_checklist",
			researchScope: [
				{
					scopeItem: "workflows/deep-research/helpers/claim-evidence-gate.mjs",
					sourceText: "Inspect the local repo helper implementation.",
					whyIncluded:
						"The task asks for repo-local static evidence about the verification floor.",
				},
			],
			factSlots: [
				{
					id: "slot-local-floor",
					label: "Repo-local verification floor behavior",
					type: "policy",
					required: true,
					sourcePriority: "local_repo",
				},
			],
			verificationPriorities: [
				{
					id: "vp-local-floor",
					targetSlots: ["slot-local-floor"],
					priority: "high",
				},
			],
		},
		"normalize-input-packet.main": {
			packet: {
				research: {
					sources: [
						{
							sourceType: "local_repo",
							file: "workflows/deep-research/helpers/claim-evidence-gate.mjs",
							quote: "Deterministic claim audit for deep-research.",
						},
					],
				},
			},
		},
		"normalize-claims.main": {
			claimInventory: {
				verificationCandidates: [],
				preservedClaims: [],
				duplicates: [],
			},
			factSlotCoverage: [
				{
					slotId: "slot-local-floor",
					label: "Repo-local verification floor behavior",
					status: "filled",
					bestValue: "Helper behavior inferred from local repo files.",
					sourceUrls: [
						"workflows/deep-research/helpers/claim-evidence-gate.mjs",
					],
					sourceQuality: "local_repo",
					verificationCandidateIds: [],
				},
			],
			coverageGaps: [],
		},
	};
}

test("deep-research repo-local zero candidates produce an explicit verification-floor blocker", async () => {
	const { default: claimEvidenceGate } = await import(
		`../../workflows/deep-research/helpers/claim-evidence-gate.mjs?test=${Date.now()}`
	);
	const { default: finalAuditPacket } = await import(
		`../../workflows/deep-research/helpers/final-audit-packet.mjs?test=${Date.now()}`
	);
	const sources = repoLocalZeroCandidateSources();

	const audit = await claimEvidenceGate({ sources, context: {} });
	const zeroGap = audit.remainingGaps.find(
		(gap) => gap.evidenceState === "no_verification_candidates",
	);

	assert.equal(audit.gateSummary.zeroCandidateFloorBlockers, 1);
	assert.equal(audit.verdictCounts.verified, 0);
	assert.equal(audit.verdictCounts.partiallySupported, 0);
	assert(zeroGap, "expected a zero-candidate verification-floor gap");
	assert.deepEqual(zeroGap.relatedFactSlotIds, ["slot-local-floor"]);
	assert.match(zeroGap.reason, /repo-local\/static claim-bearing research/);
	assert.equal(audit.batchAdoptionReadiness.status, "blocked");
	assert(
		audit.batchAdoptionReadiness.blockers.some(
			(blocker) => blocker.reason === "no_verification_candidates",
		),
		"expected batch/readiness blockers to include no_verification_candidates",
	);

	const packet = await finalAuditPacket({
		sources: { ...sources, "audit-claims.main": audit },
	});
	const packetZeroGap = packet.packet.synthesisInput.gaps.find(
		(gap) => gap.evidenceState === "no_verification_candidates",
	);

	assert.equal(packet.packet.invariantChecks.candidateCount, 0);
	assert.equal(
		packet.packet.invariantChecks.verifierIntegrity.zeroCandidateFloorBlockers,
		1,
	);
	assert.equal(
		packet.packet.synthesisInput.integritySummary.zeroCandidateFloorBlockers,
		1,
	);
	assert.equal(
		packet.packet.synthesisInput.integritySummary.batchAdoptionStatus,
		"blocked",
	);
	assert(packetZeroGap, "expected final audit synthesis packet to expose gap");
	assert.equal(packetZeroGap.kind, "remaining");
	assert.deepEqual(
		packet.packet.remainingGaps.find(
			(gap) => gap.evidenceState === "no_verification_candidates",
		)?.relatedFactSlotIds,
		["slot-local-floor"],
	);
	assert(
		packet.packet.verifierIntegrity.batchAdoptionReadiness.blockers.some(
			(blocker) => blocker.reason === "no_verification_candidates",
		),
	);
});

test("deep-research zero-candidate floor is scoped to repo-local claim-bearing plans", async () => {
	const { default: claimEvidenceGate } = await import(
		`../../workflows/deep-research/helpers/claim-evidence-gate.mjs?test=${Date.now()}`
	);

	const audit = await claimEvidenceGate({
		sources: {
			"plan.main": {
				depth: "quick",
				taskType: "other",
				expectedFinalShape: "other",
				factSlots: [],
			},
			"normalize-claims.main": {
				claimInventory: {
					verificationCandidates: [],
					preservedClaims: [],
					duplicates: [],
				},
				factSlotCoverage: [],
				coverageGaps: [],
			},
		},
		context: {},
	});

	assert.equal(audit.gateSummary.zeroCandidateFloorBlockers, 0);
	assert.equal(
		audit.remainingGaps.some(
			(gap) => gap.evidenceState === "no_verification_candidates",
		),
		false,
	);
});
