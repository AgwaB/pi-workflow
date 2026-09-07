import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateJsonSchema } from "../../.tmp/unit/json-schema.js";
import claimGate from "../../workflows/deep-research/helpers/claim-evidence-gate.mjs";
import finalPacket from "../../workflows/deep-research/helpers/final-audit-packet.mjs";
import render from "../../workflows/deep-research/helpers/render-executive.mjs";

const packetSchema = JSON.parse(
  await readFile(
    new URL(
      "../../workflows/deep-research/schemas/deep-research-final-audit-packet-control.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

function owner(id) {
  return {
    source: `verify-claims.${id}`,
    stageId: "verify-claims",
    specId: `verify-claims.${id}`,
    taskId: `task-${id}`,
    itemIdentity: id,
    placeholderSpecId: "verify-claims.item",
    status: "completed",
  };
}

test("live research correction reconciles canonical slots and preserves blocked/local evidence", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "deep-research-live-correction-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "facts.md"), "TTL is 30 seconds; reread origin after expiry.\n", "utf8");

  const candidates = [
    {
      id: "claim-010",
      claim: "TTL is 30 seconds and origin is reread after expiry.",
      sourceType: "local_repo",
      sourceRefs: ["facts.md"],
      factSlotIds: ["slot-005", "slot-006"],
    },
    {
      id: "claim-011",
      claim: "The source could not be verified.",
      sourceType: "local_repo",
      sourceRefs: ["facts.md"],
      factSlotIds: ["slot-006"],
    },
    {
      id: "claim-012",
      claim: "TTL is 30 seconds.",
      sourceType: "local_repo",
      sourceRefs: ["facts.md"],
      factSlotIds: ["slot-005"],
    },
  ];
  const result = await claimGate({
    sources: {
      "plan.main": { factSlots: [{ id: "slot-005" }, { id: "slot-006" }] },
      "normalize-claims.main": {
        claimInventory: { verificationCandidates: candidates },
        factSlotCoverage: [
          { slotId: "slot-005", status: "filled", verificationCandidateIds: ["claim-012"] },
          { slotId: "slot-006", status: "filled", verificationCandidateIds: ["claim-011", "claim-010"] },
        ],
      },
      "sanitize-claims.main": {
        claimInventory: { verificationCandidates: candidates },
        factSlotCoverage: [
          { slotId: "slot-005", status: "filled", verificationCandidateIds: ["claim-012", "claim-010"] },
          { slotId: "slot-006", status: "filled", verificationCandidateIds: ["claim-011"] },
        ],
      },
      "verify-claims.claim-010": {
        id: "claim-010",
        status: "verified",
        confidence: "high",
        verifierOwner: owner("claim-010"),
        evidence: [{ file: "facts.md", lineStart: 1, lineEnd: 1, quote: "TTL is 30 seconds; reread origin after expiry." }],
      },
      "verify-claims.claim-011": {
        id: "claim-011",
        status: "verification_blocked",
        confidence: "low",
        verifierOwner: owner("claim-011"),
        evidence: [],
      },
      "verify-claims.claim-012": {
        id: "claim-012",
        status: "verified",
        confidence: "high",
        verifierOwner: owner("claim-012"),
        evidence: [{ file: "facts.md", lineStart: 1, lineEnd: 1, quote: "not the bytes" }],
      },
    },
    context: { cwd },
  });

  for (const row of result.claimDigests) row.verifierOwner = owner(row.id);
  result.verifierOwnerLedger = result.claimDigests.map((row) => row.verifierOwner);
  assert.equal(result.auditedClaims.find((row) => row.id === "claim-012").status, "partially_supported");
  assert.equal(result.verdictCounts.verificationBlocked, 1);
  assert.deepEqual(result.statusPartitions.verificationBlocked, ["claim-011"]);

  const packet = await finalPacket({
    sources: {
      "plan.main": {
        factSlots: [
          { id: "slot-005", label: "TTL" },
          { id: "slot-006", label: "expiry behavior" },
        ],
      },
      "normalize-claims.main": {
        claimInventory: { verificationCandidates: candidates },
        factSlotCoverage: [
          { slotId: "slot-005", status: "filled", verificationCandidateIds: ["claim-012"] },
          { slotId: "slot-006", status: "filled", verificationCandidateIds: ["claim-011", "claim-010"] },
        ],
        coverageGaps: [],
      },
      "sanitize-claims.main": {
        claimInventory: { verificationCandidates: candidates },
        factSlotCoverage: [
          { slotId: "slot-005", status: "filled", verificationCandidateIds: ["claim-012"] },
          { slotId: "slot-006", status: "filled", verificationCandidateIds: ["claim-011", "claim-010"] },
        ],
      },
      "audit-claims.main": result,
    },
  });
  assert.equal(validateJsonSchema(packet, packetSchema).valid, true);
  const encodedProjection = JSON.stringify(packet.packet.synthesisInput);
  assert.equal(packet.packet.synthesisInput.inputBudget.utf16Chars, encodedProjection.length);
  assert(encodedProjection.length < 24000);
  const slots = packet.packet.factSlotCoverage;
  assert.deepEqual(slots.find((slot) => slot.slotId === "slot-005").verificationCandidateIds, ["claim-012", "claim-010"]);
  assert.deepEqual(packet.packet.factSlotReconciliation.addedReverseBindings, [
    { claimId: "claim-010", slotId: "slot-005" },
  ]);
  assert.equal(packet.packet.claimVerdictLedger.find((row) => row.id === "claim-010").evidence[0].lineStart, 1);
  assert.equal(packet.packet.synthesisInput.claims.find((row) => row.id === "claim-010").evidence[0].quote, "TTL is 30 seconds; reread origin after expiry.");

  const rendered = await render({
    sources: {
      "final-audit.main": {
        schema: "deep-research-final-synthesis-v1",
        digest: "synthesis",
        synthesis: {
          bottomLine: "The local policy is grounded with an explicit verification gap.",
          keyFindingIds: ["claim-010"],
          recommendations: [],
          actionPlan: [],
          caveatNotes: [],
          parentDecisionNotes: [],
        },
      },
      "final-audit-packet.main": packet,
    },
  });
  assert.equal(rendered.status, "passed", JSON.stringify(rendered.packetReconciliation));
  assert.match(rendered.reportMarkdown, /Evidence citations:/);
  assert.match(rendered.reportMarkdown, /facts\.md lines 1-1/);
  assert.match(rendered.reportMarkdown, /TTL is 30 seconds; reread origin after expiry/);
  assert.equal(rendered.claimSummary.verification_blocked, 1);

  const makeReferencePacket = (preservedClaims) => finalPacket({
    sources: {
      "plan.main": { factSlots: [{ id: "slot-005" }, { id: "slot-006" }] },
      "normalize-claims.main": { claimInventory: { verificationCandidates: candidates, preservedClaims }, factSlotCoverage: slots },
      "sanitize-claims.main": { claimInventory: { verificationCandidates: candidates, preservedClaims }, factSlotCoverage: slots },
      "audit-claims.main": result,
    },
  });
  const lead = { id: "lead-unverified", claim: "Implementation behavior has not been inspected.", sourceRefs: [], sourceUrls: [], factSlotIds: [], whyItMatters: "Keep the scope limit explicit." };
  const referencePacket = await makeReferencePacket([lead]);
  const referenceSynthesis = {
    schema: "deep-research-final-synthesis-v1", digest: "Preserved lead references",
    synthesis: {
      bottomLine: "Known facts and unverified follow-up remain separate.", keyFindingIds: ["claim-010"],
      recommendations: [{ recommendation: "Investigate implementation behavior.", supportingClaimIds: [lead.id], evidenceStatus: "verified" }],
      actionPlan: [{ action: "Read the implementation before deployment.", supportingClaimIds: [lead.id], evidenceStatus: "verified" }],
      caveatNotes: [{ note: "Implementation remains unverified.", relatedClaimIds: [lead.id] }],
      parentDecisionNotes: [],
    },
  };
  const synthesisSchema = JSON.parse(await readFile(new URL("../../workflows/deep-research/schemas/deep-research-final-synthesis-control.schema.json", import.meta.url), "utf8"));
  assert.equal(validateJsonSchema(referencePacket, packetSchema).valid, true);
  assert.equal(validateJsonSchema(referenceSynthesis, synthesisSchema).valid, true);
  const referenced = await render({ sources: { "final-audit.main": referenceSynthesis, "final-audit-packet.main": referencePacket } });
  assert.equal(referenced.status, "passed", JSON.stringify(referenced.renderWarnings));
  assert.deepEqual(referenced.claimSummary, rendered.claimSummary);
  const recommendationSection = referenced.reportMarkdown.split("## Recommendations")[1].split("## Action plan")[0];
  assert.match(recommendationSection, /Evidence status: unverified/);
  assert.doesNotMatch(recommendationSection, /Evidence status: (verified|derived)/);
  assert.equal(referenced.renderWarnings.length, 0);

  const unknownReference = structuredClone(referenceSynthesis);
  unknownReference.synthesis.actionPlan[0].supportingClaimIds = ["unknown-lead"];
  const unknownRendered = await render({ sources: { "final-audit.main": unknownReference, "final-audit-packet.main": referencePacket } });
  assert.equal(unknownRendered.status, "failed");
  assert(unknownRendered.renderWarnings.some((warning) => warning.missingId === "unknown-lead"));

  const collisionPacket = await makeReferencePacket([lead, { ...lead, id: "lead-0000" }]);
  collisionPacket.packet.preservedClaims[1].id = "claim-010";
  collisionPacket.packet.synthesisInput.preservedClaims[1].id = "claim-010";
  const collisionRendered = await render({ sources: { "final-audit.main": referenceSynthesis, "final-audit-packet.main": collisionPacket } });
  assert.equal(collisionRendered.status, "failed");
  assert(collisionRendered.renderWarnings.some((warning) => warning.label === "ambiguous preserved claim ID"));

  const badQuotePacket = await finalPacket({
    sources: {
      "plan.main": { factSlots: [{ id: "slot-005" }, { id: "slot-006" }] },
      "normalize-claims.main": {
        claimInventory: { verificationCandidates: candidates },
        factSlotCoverage: [
          { slotId: "slot-005", status: "filled", verificationCandidateIds: ["claim-012", "claim-010"] },
          { slotId: "slot-006", status: "filled", verificationCandidateIds: ["claim-011"] },
        ],
      },
      "sanitize-claims.main": {
        claimInventory: { verificationCandidates: candidates },
        factSlotCoverage: [
          { slotId: "slot-005", status: "filled", verificationCandidateIds: ["claim-012", "claim-010"] },
          { slotId: "slot-006", status: "filled", verificationCandidateIds: ["claim-011"] },
        ],
      },
      "audit-claims.main": result,
    },
  });
  const badQuoteRendered = await render({
    sources: {
      "final-audit.main": {
        schema: "deep-research-final-synthesis-v1",
        digest: "synthesis",
        synthesis: {
          bottomLine: "Conservative local evidence.",
          keyFindingIds: ["claim-012"],
          recommendations: [], actionPlan: [], caveatNotes: [], parentDecisionNotes: [],
        },
      },
      "final-audit-packet.main": badQuotePacket,
    },
  });
  assert.doesNotMatch(badQuoteRendered.reportMarkdown, /not the bytes/);

  const unknownHintPacket = await finalPacket({
    sources: {
      "plan.main": { factSlots: [{ id: "slot-005" }, { id: "slot-006" }] },
      "normalize-claims.main": {
        claimInventory: { verificationCandidates: candidates },
        factSlotCoverage: [
          { slotId: "slot-005", status: "filled", verificationCandidateIds: ["claim-012", "claim-extra"] },
          { slotId: "slot-006", status: "filled", verificationCandidateIds: ["claim-011"] },
        ],
      },
      "sanitize-claims.main": {
        claimInventory: { verificationCandidates: candidates },
        factSlotCoverage: [
          { slotId: "slot-005", status: "filled", verificationCandidateIds: ["claim-012", "claim-extra"] },
          { slotId: "slot-006", status: "filled", verificationCandidateIds: ["claim-011"] },
        ],
      },
      "audit-claims.main": result,
    },
  });
  const rejected = await render({
    sources: {
      "final-audit.main": { schema: "deep-research-final-synthesis-v1", digest: "s", synthesis: { bottomLine: "Answer", keyFindingIds: [], recommendations: [], actionPlan: [], caveatNotes: [], parentDecisionNotes: [] } },
      "final-audit-packet.main": unknownHintPacket,
    },
  });
  assert.equal(unknownHintPacket.packet.factSlotReconciliation.preservedReverseBindings[0].candidateId, "claim-extra");
  assert.equal(rejected.status, "failed");
  assert(rejected.packetReconciliation.blockers.some((item) => item.includes("unknown candidate")));
});
