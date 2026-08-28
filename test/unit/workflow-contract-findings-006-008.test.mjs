import test from "node:test";
import assert from "node:assert/strict";
const load = (relative) => import(new URL(`../${relative}`, import.meta.url));
const specReview = (await import(new URL("../../workflows/spec-review/helpers/spec-review-pipeline.mjs", import.meta.url))).default;
const impactRender = (await import(new URL("../../workflows/impact-review/helpers/render-impact-report.mjs", import.meta.url))).default;
const deepPipeline = (await import(new URL("../../workflows/deep-review/helpers/finding-pipeline.mjs", import.meta.url))).default;
const deepRender = (await import(new URL("../../workflows/deep-review/helpers/render-review-report.mjs", import.meta.url))).default;
const finalAuditPacket = (await import(new URL("../../workflows/deep-research/helpers/final-audit-packet.mjs", import.meta.url))).default;
const researchRender = (await import(new URL("../../workflows/deep-research/helpers/render-executive.mjs", import.meta.url))).default;
const claimGate = (await import(new URL("../../workflows/deep-research/helpers/claim-evidence-gate.mjs", import.meta.url))).default;

const reviewFinding = (id) => ({
  findingId: id,
  rootCauseId: `root-${id}`,
  title: "Same runtime defect",
  severity: "high",
  file: "src/runtime.ts",
  locations: [{ file: "src/runtime.ts", line: 8 }],
  evidence: `Observed ${id}`,
  evidenceQuotes: ["exact runtime quote"],
  rationale: "The behavior is unsafe.",
  recommendedAction: "Fix the runtime behavior.",
  confidence: "high"
});

const statuses = [
  { source: "triage", specId: "triage", taskId: "triage-task", stageId: "triage", status: "completed" },
  { source: "reviewers.runtime", specId: "reviewers.runtime", taskId: "reviewer-task", stageId: "reviewers", itemIdentity: "runtime", placeholderSpecId: "reviewers.item", status: "completed" },
  { source: "devil-advocate.F-001", specId: "devil-advocate.F-001", taskId: "verifier-task", stageId: "devil-advocate", itemIdentity: "F-001", placeholderSpecId: "devil-advocate.item", status: "completed" }
];

test("spec-review batch fallback IDs preserve end-to-end candidate coverage", async () => {
  const plan = await specReview({
    sources: { "candidate-findings": { candidateFindings: [{ title: "Fallback candidate", severity: "high" }] } },
    options: { mode: "batch-candidates", maxBatchSize: 2 }
  });
  assert.deepEqual(plan.batches[0].candidateIds, ["candidate-001"]);
  assert.equal(plan.batches[0].candidates[0].id, "candidate-001");

  const result = await specReview({
    sources: {
      "candidate-findings": { candidateFindings: [{ title: "Fallback candidate", severity: "high" }] },
      "verification-batches": plan,
      "verify-findings": {
        schema: "spec-review-verify-findings-batch-v1",
        results: [{ id: "candidate-001", title: "Fallback candidate", verdict: "KEEP", severity: "high", evidence: [], counterEvidence: [], finalClaim: "The gap is present.", recommendedAction: "Fix it." }]
      }
    },
    context: { sourceStatuses: [{ source: "verify-findings", specId: "verify-findings.vbatch-001", taskId: "batch-task-001", stageId: "verify-findings", itemIdentity: "vbatch-001", placeholderSpecId: "verify-findings.item", status: "completed" }] },
    options: { mode: "partition" }
  });
  assert.equal(result.verifierCoverage.candidateCount, 1);
  assert.equal(result.verifierCoverage.uniqueCandidateCount, 1);
  assert.deepEqual(result.verifierCoverage.missingIds, []);
  assert.deepEqual(result.finalFindings.map((finding) => finding.id), ["candidate-001"]);
});

test("deep-research batch carriers require one exact completed materialized owner", async () => {
  const sources = {
    "normalize-claims": { claimInventory: { verificationCandidates: [
      { id: "claim-a", claim: "A" },
      { id: "claim-b", claim: "B" },
    ] } },
    "verification-batches": { batches: [{ id: "vbatch-001", claimIds: ["claim-a", "claim-b"] }] },
    "verify-claims.vbatch-001": {
      results: [
        { id: "claim-a", status: "unsupported", evidence: [] },
        { id: "claim-b", status: "unsupported", evidence: [] },
      ],
    },
  };
  const owner = {
    source: "verify-claims.vbatch-001", specId: "verify-claims.vbatch-001",
    taskId: "batch-task", stageId: "verify-claims", itemIdentity: "vbatch-001",
    placeholderSpecId: "verify-claims.item", status: "completed",
  };
  const good = await claimGate({ sources, context: { sourceStatuses: [owner] } });
  assert.deepEqual(good.verifierOwnerLedger, [{ ...owner, batchId: "vbatch-001" }]);
  assert.equal(good.gateSummary.verifierOwnerIssues, 0);
  assert.equal(good.gateSummary.validVerifierRows, 2);
  const bad = await claimGate({
    sources,
    context: { sourceStatuses: [{ ...owner, itemIdentity: "vbatch-002" }] },
  });
  assert.equal(bad.gateSummary.verifierOwnerIssues, 1);
  assert.equal(bad.gateSummary.invalidVerifierRows, 2);
  assert.deepEqual(bad.statusPartitions.verified, []);
});

test("deep-research packet exposes invalid normalized candidate rows in synthesis integrity", async () => {
  const packet = await finalAuditPacket({ sources: {
    plan: { factSlots: [] },
    "normalize-claims": { claimInventory: { verificationCandidates: [] } },
    "audit-claims": {
      claimDigests: [],
      gateSummary: { invalidNormalizedCandidates: 1 },
      invalidNormalizedCandidates: [{ index: 2, reason: "duplicate_normalized_candidate_id", nextStep: "repair" }],
    },
  }});
  const integrity = packet.packet.synthesisInput.integritySummary;
  assert.equal(integrity.invalidNormalizedCandidateCount, 1);
  assert.deepEqual(integrity.invalidNormalizedCandidateRows[0], packet.packet.verifierIntegrity.invalidNormalizedCandidateRows[0]);
  assert.equal(packet.packet.overflowLedger.invalidNormalizedCandidateCount, 1);
});

test("spec-review owner reconciliation rejects a vacuous empty join", async () => {
  const result = await specReview({
    sources: { "candidate-findings": { candidateFindings: [{ id: "F-001", title: "Gap", severity: "high" }] } },
    options: { mode: "partition" },
  });
  assert.equal(result.verifierCoverage.complete, false);
  assert.equal(result.verifierCoverage.ownerLedgerReconciliation.cardinalityPassed, false);
  assert.equal(result.verifierCoverage.ownerLedgerReconciliation.passed, false);
  assert.equal(result.verifierCoverage.ownerLedgerReconciliation.ownerRowCount, 0);
  assert.equal(result.verifierCoverage.ownerLedgerReconciliation.verifierRowCount, 0);
});

test("deep-review rejects multiple canonical triage sources before ledger folding", async () => {
  await assert.rejects(
    () => deepPipeline({
      sources: {
        triage: { reviewLenses: [{ id: "runtime" }] },
        "triage.main": { reviewLenses: [{ id: "runtime" }] },
      },
      options: { mode: "dedup" },
    }),
    /ambiguous triage source/u,
  );
});

test("impact renderer rejects contradictory source/spec identity and duplicate task identity", async () => {
  const sources = { "impact-analysis.impact-synthesis.main": {
    schema: "stage-control-v1", digest: "s", summary: "Ready", verdict: "READY", riskLevel: "low",
    blockingIssues: [], nonBlockingIssues: [], confirmedSafeAreas: [], recommendedNextActions: [], validationToRun: [], needsHuman: [],
  }, "impact-analysis.contract-consistency.main": { schema: "stage-control-v1", digest: "c", status: "pass", issues: [], confirmedConsistencies: [] },
  "impact-analysis.regression-risk.main": { schema: "stage-control-v1", digest: "r", riskLevel: "low", risks: [], riskReducers: [] },
  "impact-analysis.ship-readiness.main": { schema: "stage-control-v1", digest: "h", status: "ready", requiredBeforeShip: [], niceToHave: [], assumptions: [] } };
  const statusRows = ["impact-synthesis", "contract-consistency", "regression-risk", "ship-readiness"].map((stage) => ({
    source: `impact-analysis.${stage}`, specId: `impact-analysis.${stage}.main`, stageId: `impact-analysis.${stage}`, taskId: `task-${stage}`, status: "completed",
  }));
  const contradictory = await impactRender({ sources, context: { sourceStatuses: statusRows.map((row) => row.stageId.endsWith("impact-synthesis") ? { ...row, specId: "impact-analysis.other.main" } : row) } });
  assert.equal(contradictory.gates.sourceCoverageComplete, false);
  assert.equal(contradictory.sourceCoverage.missing.length, 1);
  assert.equal(contradictory.sourceCoverage.orphan.length, 1);
  const duplicate = await impactRender({ sources, context: { sourceStatuses: [...statusRows, { ...statusRows[0] }] } });
  assert.equal(duplicate.gates.sourceCoverageComplete, false);
  assert.deepEqual(duplicate.sourceCoverage.duplicateTaskIds, ["task-impact-synthesis"]);
});

test("spec-review partition publishes owner rows and deterministic reconciliation", async () => {
  const owner = { source: "verify-findings.F-001", specId: "verify-findings.F-001", taskId: "task-1", stageId: "verify-findings", itemIdentity: "F-001", placeholderSpecId: "verify-findings.item", status: "completed" };
  const result = await specReview({
    sources: {
      "candidate-findings": { candidateFindings: [{ id: "F-001", title: "Gap", severity: "high" }] },
      "verify-findings.F-001": { id: "F-001", verdict: "DROP", severity: "high", evidence: [], counterEvidence: [], finalClaim: "not present", recommendedAction: "none" },
    },
    context: { sourceStatuses: [owner] },
    options: { mode: "partition" },
  });
  assert.deepEqual(result.verifierCoverage.ownerLedger, [owner]);
  assert.equal(result.verifierCoverage.ownerLedgerReconciliation.passed, true);
  assert.deepEqual(result.verifierCoverage.verifierRows.map((row) => row.id), ["F-001"]);
});

test("spec-review batch owner ledger quarantines rows with swapped materialized ownership", async () => {
  const plan = {
    schema: "spec-review-verification-batches-v1",
    batches: [{ id: "vbatch-001", candidateIds: ["candidate-001"], candidates: [{ id: "candidate-001", title: "Fallback candidate" }] }],
  };
  const result = await specReview({
    sources: {
      "candidate-findings": { candidateFindings: [{ id: "candidate-001", title: "Fallback candidate", severity: "high" }] },
      "verification-batches": plan,
      "verify-findings": { schema: "spec-review-verify-findings-batch-v1", results: [{ id: "candidate-001", title: "Fallback candidate", verdict: "KEEP", severity: "high", evidence: [], counterEvidence: [], finalClaim: "The gap is present.", recommendedAction: "Fix it." }] },
    },
    context: { sourceStatuses: [{ source: "verify-findings", specId: "verify-findings.vbatch-001", taskId: "batch-task-001", stageId: "verify-findings", itemIdentity: "candidate-002", placeholderSpecId: "verify-findings.item", status: "completed" }] },
    options: { mode: "partition" },
  });
  assert.deepEqual(result.finalFindings, []);
  assert.equal(result.verifierCoverage.ownerLedger.length, 1);
  assert.equal(result.verifierCoverage.ownerLedger[0].source, "verify-findings");
  assert.ok(result.batchIntegrityIssues.some((issue) => issue.reason === "verifier_source_status_identity_mismatch"));
  assert.ok(result.needsHuman.some((item) => item.source === "batch-integrity"));
});

test("impact renderer forces UNKNOWN and fails when synthesis risk is unknown", async () => {
  const result = await impactRender({ sources: { "impact-analysis.impact-synthesis.main": { summary: "Ready-looking synthesis", verdict: "READY", riskLevel: "unknown" } } });
  assert.equal(result.verdict, "UNKNOWN");
  assert.equal(result.status, "blocked");
  assert.equal(result.gates.riskGatePassed, false);
  assert.equal(result.gates.passed, false);
});

test("canonical stage source helpers fail closed on ambiguous aliases", async () => {
  await assert.rejects(
    () => specReview({
      sources: {
        "candidate-findings.main": { candidateFindings: [] },
        "candidate-findings.extra": { candidateFindings: [] },
      },
      options: { mode: "batch-candidates" },
    }),
    /ambiguous candidate-findings source/u,
  );
  const deepAmbiguous = await deepRender({
    sources: {
      "partition-verdicts.main": {},
      "partition-verdicts.extra": {},
    },
  });
  assert.equal(deepAmbiguous.status, "blocked");
  assert.match(deepAmbiguous.blockers[0], /ambiguous partition-verdicts/u);
  const impactAmbiguous = await impactRender({
    sources: {
      "impact-synthesis.one": { summary: "a" },
      "impact-synthesis.two": { summary: "b" },
    },
  });
  assert.equal(impactAmbiguous.status, "blocked");
  assert.match(impactAmbiguous.blockers[0], /ambiguous impact-synthesis/u);
});

test("spec-review singleton verifier rejects wrong-stage and swapped materialized owners", async () => {
  const candidate = { id: "F-001", title: "Exact candidate", severity: "high" };
  const base = {
    sources: {
      "candidate-findings": { candidateFindings: [candidate] },
      "verify-findings.F-001": {
        id: "F-001", verdict: "KEEP", severity: "high", evidence: [],
        counterEvidence: [], finalClaim: "kept", recommendedAction: "fix",
      },
    },
    options: { mode: "partition" },
  };
  const wrongStage = await specReview({
    ...base,
    context: { sourceStatuses: [{
      source: "verify-findings.F-001", specId: "verify-findings.F-001",
      taskId: "task-a", stageId: "other-stage", itemIdentity: "F-001",
      placeholderSpecId: "verify-findings.item", status: "completed",
    }] },
  });
  assert.deepEqual(wrongStage.finalFindings, []);
  assert.equal(wrongStage.verdictCounts.needsHuman > 0, true);
  const swapped = await specReview({
    ...base,
    context: { sourceStatuses: [{
      source: "verify-findings.F-001", specId: "verify-findings.F-001",
      taskId: "task-b", stageId: "verify-findings", itemIdentity: "F-002",
      placeholderSpecId: "verify-findings.item", status: "completed",
    }] },
  });
  assert.deepEqual(swapped.finalFindings, []);
  assert.equal(swapped.verdictCounts.needsHuman > 0, true);
});

test("deep-research singleton verifier ownership is exact and order-independent", async () => {
  const sources = {
    "normalize-claims": { claimInventory: { verificationCandidates: [{ id: "claim-001", claim: "Exact claim" }] } },
    "verify-claims": { id: "claim-001", status: "unsupported", evidence: [] },
  };
  const owner = { source: "verify-claims", specId: "verify-claims.claim-001", taskId: "task-claim-001", stageId: "verify-claims", itemIdentity: "claim-001", placeholderSpecId: "verify-claims.item", status: "completed" };
  const good = await claimGate({ sources, context: { sourceStatuses: [owner] } });
  assert.deepEqual(good.verifierOwnerLedger, [{ source: owner.source, stageId: owner.stageId, specId: owner.specId, taskId: owner.taskId, itemIdentity: owner.itemIdentity, placeholderSpecId: owner.placeholderSpecId, status: owner.status }]);
  assert.equal(good.gateSummary.verifierOwnerIssues, 0);
  for (const status of [
    { ...owner, itemIdentity: "claim-002" },
    { ...owner, stageId: "other-stage" },
  ]) {
    const bad = await claimGate({ sources, context: { sourceStatuses: [status] } });
    assert.equal(bad.gateSummary.verifierOwnerIssues, 1);
    assert.equal(bad.verifierOwnerIssues[0].claimId, "claim-001");
    assert.deepEqual(bad.statusPartitions.verified, []);
  }
  const ambiguous = await claimGate({ sources, context: { sourceStatuses: [owner, { ...owner, taskId: "task-claim-001b" }] } });
  assert.equal(ambiguous.verifierOwnerIssues[0].reason, "verifier_source_not_bound_to_exactly_one_materialized_owner");
  assert.equal(ambiguous.gateSummary.invalidVerifierRows, 1);
});

test("deep-research packet reconciliation blocks swapped and inconsistent final packets", async () => {
  const packet = {
    schema: "deep-research-final-audit-packet-v1",
    digest: "packet",
    packet: {
      synthesisInput: {
        researchMetadata: {},
        verdictCounts: { verified: 1, partiallySupported: 0, unsupported: 0, conflicting: 0, verificationBlocked: 0 },
        factSlotStatusCounts: { filled: 1 },
        integritySummary: { invalidNormalizedCandidateCount: 0, invalidNormalizedCandidateRows: [], verifierOwnerIssues: 0 },
        researchScopeCoverage: [],
        factSlots: [{ slotId: "slot-001", status: "filled" }],
        claims: [{ id: "claim-001", status: "verified", verifierOwner: { source: "verify-claims.claim-001", stageId: "verify-claims", specId: "verify-claims.claim-001", taskId: "task-claim-001", itemIdentity: "claim-001", placeholderSpecId: "verify-claims.item", status: "completed" } }],
        preservedClaims: [],
        gaps: [],
      },
      researchMetadataSeed: {},
      verdictCounts: { verified: 1, partiallySupported: 0, unsupported: 0, conflicting: 0, verificationBlocked: 0 },
      statusPartitions: { verified: ["claim-001"], partiallySupported: [], unsupported: [], conflicting: [], verificationBlocked: [] },
      factSlotCoverage: [{ slotId: "slot-001", status: "filled" }],
      factSlotStatusCounts: { filled: 1 },
      coverageGaps: [],
      remainingGaps: [],
      sourceRefJoinFailures: [],
      claimVerdictLedger: [{ id: "claim-001", status: "verified", claim: "Claim", verifierOwner: { source: "verify-claims.claim-001", stageId: "verify-claims", specId: "verify-claims.claim-001", taskId: "task-claim-001", itemIdentity: "claim-001", placeholderSpecId: "verify-claims.item", status: "completed" } }],
      verifierIntegrity: { gateSummary: { missingVerifierResults: 0, zeroCandidateFloorBlockers: 0, invalidNormalizedCandidates: 0 }, invalidVerifierRows: [], duplicateVerifierRows: [], invalidNormalizedCandidateCount: 0, invalidNormalizedCandidateRows: [], verifierOwnerLedger: [{ source: "verify-claims.claim-001", stageId: "verify-claims", specId: "verify-claims.claim-001", taskId: "task-claim-001", itemIdentity: "claim-001", placeholderSpecId: "verify-claims.item", status: "completed" }], verifierOwnerIssues: [] },
      normalizerDiagnostics: {},
      preservedClaims: [],
      researchScopeCoverage: [],
      invariantChecks: { candidateCount: 1, auditedClaimCount: 1, candidateIds: ["claim-001"], auditedClaimIds: ["claim-001"], statusPartitionIds: { verified: ["claim-001"], partiallySupported: [], unsupported: [], conflicting: [], verificationBlocked: [] }, omittedCandidateIds: [], verifierIntegrity: { invalidVerifierRows: 0, duplicateVerifierRows: 0, invalidNormalizedCandidateCount: 0, verifierOwnerIssues: 0, missingVerifierResults: 0, zeroCandidateFloorBlockers: 0 } },
      overflowLedger: { preservedClaimCount: 0, coverageGapCount: 0, remainingGapCount: 0, omittedVerificationCandidateCount: 0, invalidVerifierRowCount: 0, duplicateVerifierRowCount: 0, invalidNormalizedCandidateCount: 0, verifierOwnerIssueCount: 0 },
    },
  };
  const final = { schema: "deep-research-final-synthesis-v1", digest: "final", synthesis: { bottomLine: "Answer", keyFindingIds: ["claim-001"], recommendations: [], actionPlan: [], caveatNotes: [], parentDecisionNotes: [] } };
  const good = await researchRender({ sources: { "final-audit-packet": packet, "final-audit": final } });
  assert.equal(good.status, "passed");
  for (const mutate of [
    (value) => { value.statusPartitions.verified = []; },
    (value) => { value.overflowLedger.remainingGapCount = 1; },
    (value) => { value.invariantChecks.auditedClaimIds = ["claim-swapped"]; },
  ]) {
    const badPacket = structuredClone(packet);
    mutate(badPacket.packet);
    const bad = await researchRender({ sources: { "final-audit-packet": badPacket, "final-audit": final } });
    assert.equal(bad.status, "failed");
    assert.equal(bad.gates.packetReconciliationPassed, false);
    assert.ok(bad.gates.packetReconciliationBlockers.length > 0);
  }
});

test("impact renderer requires a one-to-one canonical source-status stage coverage", async () => {
  const sourceFor = (stage, value) => ({
    [`impact-analysis.${stage}.main`]: value,
  });
  const fullSources = {
    "impact-analysis.impact-synthesis.main": { schema: "stage-control-v1", digest: "s", summary: "Ready", verdict: "READY", riskLevel: "low", blockingIssues: [], nonBlockingIssues: [], confirmedSafeAreas: [], recommendedNextActions: [], validationToRun: [], needsHuman: [] },
    "impact-analysis.contract-consistency.main": { schema: "stage-control-v1", digest: "c", status: "pass", issues: [], confirmedConsistencies: [] },
    "impact-analysis.regression-risk.main": { schema: "stage-control-v1", digest: "r", riskLevel: "low", risks: [], riskReducers: [] },
    "impact-analysis.ship-readiness.main": { schema: "stage-control-v1", digest: "h", status: "ready", requiredBeforeShip: [], niceToHave: [], assumptions: [] },
  };
  const statusesFor = (stage) => ({ source: `impact-analysis.${stage}`, specId: `impact-analysis.${stage}.main`, stageId: `impact-analysis.${stage}`, taskId: `task-${stage}`, status: "completed" });
  const statusRows = ["impact-synthesis", "contract-consistency", "regression-risk", "ship-readiness"].map(statusesFor);
  const good = await impactRender({ sources: fullSources, context: { sourceStatuses: statusRows } });
  assert.equal(good.status, "passed");
  const duplicate = await impactRender({ sources: fullSources, context: { sourceStatuses: [...statusRows, { ...statusRows[0], taskId: "task-b" }] } });
  assert.equal(duplicate.status, "blocked");
  assert.equal(duplicate.gates.sourceCoverageComplete, false);
  const wrongStage = await impactRender({ sources: fullSources, context: { sourceStatuses: statusRows.map((status) => status.stageId === "impact-analysis.impact-synthesis" ? { ...status, stageId: "impact-analysis.contract-consistency" } : status) } });
  assert.equal(wrongStage.status, "blocked");
});

test("deep-review owner mapping rejects contradictory source/spec metadata", async () => {
  const dedup = await deepPipeline({
    sources: {
      triage: { reviewLenses: [{ id: "runtime" }] },
      "reviewers.runtime": { lens: "runtime", findings: [reviewFinding("F-001")], evidenceChecked: ["src/runtime.ts:8"], noIssueNotes: [] }
    },
    context: { sourceStatuses: [{
      source: "reviewers.runtime", specId: "reviewers.other", taskId: "reviewer-task",
      stageId: "reviewers", itemIdentity: "runtime", placeholderSpecId: "reviewers.item", status: "completed",
    }] },
    options: { mode: "dedup" },
  });
  assert.equal(dedup.reviewerLedger.complete, false);

  const partition = await deepPipeline({
    sources: {
      "dedup-findings.main": dedup,
      "devil-advocate.F-001": { findingId: "F-001", finding: "Same runtime defect", verdict: "KEEP", evidence: ["src/runtime.ts:8"], counterEvidence: [], recommendedAction: "Fix it." },
    },
    context: { sourceStatuses: [{
      source: "devil-advocate.F-001", specId: "devil-advocate.other", taskId: "verifier-task",
      stageId: "devil-advocate", itemIdentity: "F-001", placeholderSpecId: "devil-advocate.item", status: "completed",
    }] },
    options: { mode: "partition" },
  });
  assert.equal(partition.verifierCoverage.complete, false);
  assert.equal(partition.partitions.keep.length, 0);
});

test("deep-research packet and renderer reject missing audit and duplicate ledger IDs", async () => {
  await assert.rejects(() => finalAuditPacket({ sources: {} }), /missing audit-claims/u);
  await assert.rejects(() => finalAuditPacket({ sources: {
    "audit-claims.main": { claimDigests: [], remainingGaps: [], sourceRefJoinFailures: [] },
  } }), /incomplete audit-claims/u);
  const legacy = {
    schema: "deep-research-final-control-v1", digest: "audit",
    finalReport: { researchMetadata: {}, coverageSummary: {}, recommendations: [], actionPlan: [], remainingGaps: [], factSlotCoverage: [], mainFindings: [], parentDecisionNotes: [], unverifiedButRelevant: [] },
    claimVerdictIndex: { claims: [{ id: "claim-1" }] },
  };
  const duplicateClaims = await researchRender({ sources: {
    "final-audit.main": legacy,
    "final-audit-packet.main": { packet: { claimVerdictLedger: [{ id: "claim-1" }, { id: "claim-1" }], remainingGaps: [] } },
  } });
  assert.equal(duplicateClaims.status, "failed");
  assert.deepEqual(duplicateClaims.gates.duplicateClaimIds, ["claim-1"]);

  const duplicateGaps = await researchRender({ sources: {
    "final-audit.main": legacy,
    "final-audit-packet.main": { packet: { claimVerdictLedger: [], remainingGaps: [{ id: "gap-1" }, { id: "gap-1" }] } },
  } });
  assert.equal(duplicateGaps.status, "failed");
  assert.deepEqual(duplicateGaps.gates.duplicateGapIds, ["gap-1"]);
});

test("deep-review renderer reconciles duplicate and verifier count ledgers", async () => {
  const dedup = await deepPipeline({
    sources: {
      triage: { reviewLenses: [{ id: "runtime" }] },
      "reviewers.runtime": { lens: "runtime", findings: [reviewFinding("F-001"), reviewFinding("F-002")], evidenceChecked: ["src/runtime.ts:8"], noIssueNotes: [] }
    },
    context: { sourceStatuses: statuses },
    options: { mode: "dedup" }
  });
  const partition = await deepPipeline({
    sources: {
      "dedup-findings.main": dedup,
      "devil-advocate.F-001": { findingId: "F-001", finding: "Same runtime defect", verdict: "KEEP", evidence: ["src/runtime.ts:8"], counterEvidence: [], recommendedAction: "Fix it." }
    },
    context: { sourceStatuses: statuses },
    options: { mode: "partition" }
  });
  const wrongStage = await deepPipeline({
    sources: {
      "dedup-findings.main": dedup,
      "devil-advocate.F-001": { findingId: "F-001", finding: "Same runtime defect", verdict: "KEEP", evidence: ["src/runtime.ts:8"], counterEvidence: [], recommendedAction: "Fix it." }
    },
    context: { sourceStatuses: statuses.map((status) => status.stageId === "devil-advocate" ? { ...status, stageId: "reviewers" } : status) },
    options: { mode: "partition" }
  });
  assert.equal(wrongStage.verifierCoverage.complete, false);
  assert.equal(wrongStage.partitions.keep.length, 0);

  const duplicateMismatch = structuredClone(partition);
  duplicateMismatch.dedupSummary.duplicateCount = 0;
  const duplicateResult = await deepRender({ sources: { "partition-verdicts.main": duplicateMismatch, report: { summary: "work", verdict: "NEEDS_WORK" } } });
  assert.equal(duplicateResult.status, "failed");
  assert.equal(duplicateResult.gates.duplicateCountMismatch, true);

  const verdictMismatch = structuredClone(partition);
  verdictMismatch.partitionSummary.verdictsReceived += 1;
  const verdictResult = await deepRender({ sources: { "partition-verdicts.main": verdictMismatch, report: { summary: "work", verdict: "NEEDS_WORK" } } });
  assert.equal(verdictResult.status, "failed");
  assert.equal(verdictResult.gates.verdictsReceivedMismatch, true);

  const independentDuplicate = structuredClone(partition);
  independentDuplicate.partitions.drop.push({
    findingId: "F-002", rootCauseId: "root-F-002", title: "Same runtime defect",
    severity: "high", locations: [{ file: "src/runtime.ts", line: 8 }],
    evidenceQuotes: ["exact runtime quote"], verdict: "DROP",
  });
  independentDuplicate.partitionSummary.drop += 1;
  const independentResult = await deepRender({
    sources: { "partition-verdicts.main": independentDuplicate, report: { summary: "work", verdict: "NEEDS_WORK" } },
  });
  assert.equal(independentResult.status, "failed");
  assert.deepEqual(independentResult.gates.independentlyDispositionedRawDuplicates, ["F-002"]);
  assert.equal(independentResult.gates.duplicateCountMismatch, true);
});
