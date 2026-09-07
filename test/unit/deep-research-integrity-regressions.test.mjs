import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readWorkflowArtifact } from "../../.tmp/unit/workflow-artifact-tool.js";
import { validateJsonSchema } from "../../.tmp/unit/json-schema.js";
import claimGate from "../../workflows/deep-research/helpers/claim-evidence-gate.mjs";
import finalPacket from "../../workflows/deep-research/helpers/final-audit-packet.mjs";
import localQuoteGate from "../../workflows/deep-research/helpers/local-quote-gate.mjs";
import normalizePacket from "../../workflows/deep-research/helpers/normalize-input-packet.mjs";
import render from "../../workflows/deep-research/helpers/render-executive.mjs";

const researchSchema = JSON.parse(
  await readFile(
    new URL(
      "../../workflows/deep-research/schemas/deep-research-research-questions-control.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

function owner(id = "claim-1") {
  return {
    source: `verify-claims.${id}`,
    stageId: "verify-claims",
    specId: `verify-claims.${id}`,
    taskId: "task-verify",
    itemIdentity: id,
    placeholderSpecId: "verify-claims.item",
    status: "completed",
  };
}

function auditSource({ floor = 0, dropped = [], claimCount = 1 } = {}) {
  const ids = Array.from({ length: claimCount }, (_, i) => `claim-${i + 1}`);
  const rows = ids.map((id) => ({
    id,
    claim: "The feature is disabled.",
    factSlotIds: ["slot-1"],
    status: "verified",
    confidence: "high",
    sourceRefs: [],
    sourceUrls: [],
    verifierOwner: owner(id),
    verdictDigest: { support: "The source supports the claim." },
  }));
  return {
    claimDigests: rows,
    gateSummary: {
      invalidVerifierRows: 0,
      duplicateVerifierRows: 0,
      verifierOwnerIssues: 0,
      missingVerifierResults: 0,
      invalidNormalizedCandidates: 0,
      sourceRefJoinFailures: 0,
      zeroCandidateFloorBlockers: floor,
    },
    verdictCounts: {
      verified: claimCount,
      partiallySupported: 0,
      unsupported: 0,
      conflicting: 0,
      verificationBlocked: 0,
      other: 0,
    },
    statusPartitions: {
      verified: ids,
      partiallySupported: [],
      unsupported: [],
      conflicting: [],
      verificationBlocked: [],
      other: [],
    },
    verifierOwnerLedger: rows.map((row) => row.verifierOwner),
    verifierOwnerIssues: [],
    invalidVerifierRows: [],
    duplicateVerifierRows: [],
    invalidNormalizedCandidates: [],
    remainingGaps: [],
    sourceRefJoinFailures: [],
    slotCoverageCheck: { droppedSlotIds: dropped },
  };
}

function packetSources(questionId, candidate = { id: "claim-1", claim: "A fact." }) {
  return {
    "plan.main": {
      researchQuestions: [{ id: questionId }],
      factSlots: [],
    },
    "normalize-input-packet.main": {
      packet: {
        researchQuestionCoverage: {
          passed: true,
          plannedIds: [questionId],
          completedIds: [questionId],
          missingIds: [],
          duplicateIds: [],
          extraIds: [],
          failedIds: [],
          invalidPlannedQuestionCount: 0,
          plannedDuplicateIds: [],
          invalidOutputSourceIds: [],
          rows: [{ questionId, status: "completed", sourceIds: [] }],
        },
      },
    },
    "normalize-claims.main": {
      claimInventory: { verificationCandidates: [candidate], preservedClaims: [] },
      factSlotCoverage: [],
    },
    "sanitize-claims.main": {
      claimInventory: { verificationCandidates: [candidate], preservedClaims: [] },
      factSlotCoverage: [],
    },
    "audit-claims.main": auditSource(),
  };
}

async function actualSynthesisRead(t, packet) {
  const cwd = await mkdtemp(join(tmpdir(), "deep-research-actual-read-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const producer = join(cwd, "producer");
  const consumer = join(cwd, "consumer");
  await mkdir(producer, { recursive: true });
  await mkdir(consumer, { recursive: true });
  const control = join(producer, "control.json");
  await writeFile(control, JSON.stringify(packet));
  const manifest = {
    schema: "workflow-source-manifest-v1",
    runId: "run",
    taskId: "consumer",
    sources: [{
      source: "final-audit-packet",
      taskId: "producer",
      specId: "final-audit-packet.main",
      stageId: "final-audit-packet",
      generation: 0,
      sourceGeneration: 0,
      artifacts: { control: { path: control } },
    }],
  };
  await writeFile(join(consumer, "source-manifest.json"), JSON.stringify(manifest));
  const projection = await readWorkflowArtifact(
    manifest,
    "final-audit-packet",
    "control",
    { runDir: cwd, path: "$.packet.synthesisInput", maxChars: 24000 },
  );
  return { encoded: JSON.stringify(packet.packet.synthesisInput), projection };
}

test("deep-research production research schema and packet preserve local evidence and question failures", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "deep-research-integrity-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "source.custom"), "enabled = false;\n");
  const output = {
    schema: "stage-control-v1",
    digest: "local",
    questionId: "rq-1",
    question: "What is enabled?",
    extractedFacts: [
      {
        slotId: "slot-1",
        sourceType: "local_repo",
        file: "source.custom",
        lineStart: 1,
        lineEnd: 1,
        symbol: "enabled",
        supports: ["slot-1"],
        quote: "enabled = false;",
      },
    ],
    claims: [
      {
        claim: "The feature is disabled.",
        sourceType: "local_repo",
        file: "source.custom",
        lineStart: 1,
        lineEnd: 1,
        quote: "enabled = false;",
        supports: ["slot-1"],
        factSlotIds: ["slot-1"],
      },
    ],
    sources: [
      {
        sourceType: "local_repo",
        file: "source.custom",
        lineStart: 1,
        lineEnd: 1,
        sourceUrl: "source.custom",
        quote: "enabled = false;",
      },
    ],
  };
  assert.equal(validateJsonSchema(output, researchSchema).valid, true);
  const packet = await normalizePacket({
    sources: {
      "plan.main": {
        factSlots: [
          { id: "slot-1", label: "feature", type: "policy", required: true },
        ],
        researchQuestions: [{ id: "rq-1" }, { id: "rq-2" }],
      },
      "research-questions.rq-1": output,
    },
    context: {
      cwd,
      sourceStatuses: [
        {
          source: "research-questions.rq-2",
          itemIdentity: "rq-2",
          status: "failed",
          statusDetail: "timeout",
        },
      ],
    },
  });
  assert.equal(packet.packet.research.extractedFacts[0].file, "source.custom");
  assert.equal(packet.packet.research.extractedFacts[0].lineEnd, 1);
  assert.equal(packet.packet.research.sources[0].url, "source.custom");
  assert.deepEqual(packet.packet.researchQuestionCoverage.missingIds, ["rq-2"]);
  assert.equal(packet.packet.researchQuestionCoverage.passed, false);
  assert.deepEqual(packet.packet.researchQuestionCoverage.failedIds, ["rq-2"]);
  assert(
    packet.packet.research.evidenceGaps.some(
      (gap) => gap.reason === "research_question_failed",
    ),
  );
});

test("deep-research every local evidence alias reaches the byte gate, including opaque extensionless refs", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "deep-research-local-aliases-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "README"), "actual bytes\n");
  const aliases = [
    "source",
    "sourceRef",
    "file",
    "path",
    "repoPath",
    "localPath",
    "url",
  ];
  const evidence = aliases.map((alias) => ({
    [alias]: "README",
    lineStart: 1,
    lineEnd: 1,
    quote: "fabricated bytes",
  }));
  const result = await localQuoteGate(
    evidence,
    { cwd },
    (value) => value !== "https://example.invalid",
  );
  assert.equal(result.length, aliases.length);
  assert(result.every((row) => row.status === "mismatch"));
  assert(result.every((row) => row.file === "README"));
});

test("deep-research normalizer preserves every per-row source identity alias", async () => {
  const refs = Array.from(
    { length: 8 },
    (_, index) => `wsrc_${String(index + 1).padStart(32, "a")}`,
  );
  const urls = Array.from(
    { length: 8 },
    (_, index) => `https://source-${index}.invalid/doc`,
  );
  const packet = await normalizePacket({
    sources: {
      "plan.main": { researchQuestions: [{ id: "rq-1" }], factSlots: [] },
      "research-questions.rq-1": {
        questionId: "rq-1",
        extractedFacts: [{ sourceRefs: refs, sourceUrls: urls }],
        claims: [{ claim: "A fact.", sourceRefs: refs, sourceUrls: urls }],
        sources: [{ sourceRefs: refs, sourceUrls: urls }],
      },
    },
  });
  assert.deepEqual(packet.packet.research.extractedFacts[0].sourceRefs, refs);
  assert.deepEqual(packet.packet.research.extractedFacts[0].sourceUrls, urls);
  assert.deepEqual(packet.packet.research.claims[0].sourceRefs, refs);
  assert.deepEqual(packet.packet.research.sources[0].sourceRefs, refs);
  assert.deepEqual(packet.packet.ledgers.overflow, {});
});

test("deep-research source identities reject contradictory known sourceRef/url pairs", async () => {
  const refA = `wsrc_${"a".repeat(32)}`;
  const result = await claimGate({
    sources: {
      "plan.main": { factSlots: [{ id: "slot-1" }] },
      "normalize-input-packet.main": {
        packet: {
          research: {
            sources: [{ sourceRef: refA, url: "https://a.invalid/doc" }],
          },
        },
      },
      "normalize-claims.main": {
        claimInventory: {
          verificationCandidates: [
            {
              id: "claim-1",
              claim: "A fact.",
              sourceRefs: [refA],
              sourceUrls: ["https://a.invalid/doc"],
            },
          ],
        },
      },
      "sanitize-claims.main": {
        claimInventory: {
          verificationCandidates: [
            {
              id: "claim-1",
              claim: "A fact.",
              sourceRefs: [refA],
              sourceUrls: ["https://a.invalid/doc"],
            },
          ],
        },
      },
      "verify-claims.claim-1": {
        id: "claim-1",
        status: "verified",
        evidence: [
          { sourceRef: refA, url: "https://b.invalid/doc", quote: "A fact." },
        ],
      },
    },
  });
  assert.equal(result.verdictCounts.verified, 0);
  assert.equal(result.verdictCounts.partiallySupported, 1);
  assert.equal(result.gateSummary.sourceEvidenceCompatibilityMismatches, 1);
  assert.equal(
    result.auditedClaims[0].evidenceGate.reasonCode,
    "evidence_source_identity_mismatch",
  );
});

test("deep-research positive overlays preserve the weakest linked evidence status", async () => {
  const audit = auditSource();
  audit.claimDigests[0].status = "unsupported";
  audit.claimDigests[0].verifierOwner = owner("claim-1");
  audit.verdictCounts = {
    verified: 0,
    partiallySupported: 0,
    unsupported: 1,
    conflicting: 0,
    verificationBlocked: 0,
    other: 0,
  };
  audit.statusPartitions = {
    verified: [],
    partiallySupported: [],
    unsupported: ["claim-1"],
    conflicting: [],
    verificationBlocked: [],
    other: [],
  };
  const packet = await finalPacket({
    sources: {
      "plan.main": { factSlots: [{ id: "slot-1" }] },
      "normalize-claims.main": {
        claimInventory: {
          verificationCandidates: [
            { id: "claim-1", claim: "A fact.", factSlotIds: ["slot-1"] },
          ],
        },
        factSlotCoverage: [
          {
            slotId: "slot-1",
            status: "filled",
            verificationCandidateIds: ["claim-1"],
          },
        ],
      },
      "sanitize-claims.main": {
        claimInventory: {
          verificationCandidates: [
            { id: "claim-1", claim: "A fact.", factSlotIds: ["slot-1"] },
          ],
        },
        factSlotCoverage: [
          {
            slotId: "slot-1",
            status: "filled",
            verificationCandidateIds: ["claim-1"],
          },
        ],
      },
      "audit-claims.main": audit,
    },
  });
  const synthesis = {
    schema: "deep-research-final-synthesis-v1",
    digest: "s",
    synthesis: {
      bottomLine: "Answer",
      keyFindingIds: [],
      recommendations: [
        {
          recommendation: "Proceed",
          supportingClaimIds: ["claim-1"],
          evidenceStatus: "verified",
        },
      ],
      actionPlan: [],
      caveatNotes: [],
      parentDecisionNotes: [],
    },
  };
  const rendered = await render({
    sources: {
      "final-audit.main": synthesis,
      "final-audit-packet.main": packet,
    },
  });
  assert.equal(rendered.status, "passed");
  assert.match(rendered.reportMarkdown, /Evidence status: unsupported/);
  assert.doesNotMatch(rendered.reportMarkdown, /Evidence status: derived/);
});

test("deep-research hostile synthesis identities produce an explicit budget block", async () => {
  const hugeQuestionId = `rq-${"😀".repeat(24000)}`;
  const audit = auditSource();
  const packet = await finalPacket({
    sources: {
      "plan.main": {
        researchQuestions: [{ id: hugeQuestionId }],
        factSlots: [],
      },
      "normalize-input-packet.main": {
        packet: {
          researchQuestionCoverage: {
            passed: true,
            plannedIds: [hugeQuestionId],
            completedIds: [hugeQuestionId],
            missingIds: [],
            duplicateIds: [],
            extraIds: [],
            failedIds: [],
            invalidPlannedQuestionCount: 0,
            plannedDuplicateIds: [],
            invalidOutputSourceIds: [],
            rows: [
              {
                questionId: hugeQuestionId,
                status: "completed",
                sourceIds: [],
              },
            ],
          },
        },
      },
      "normalize-claims.main": {
        claimInventory: {
          verificationCandidates: [{ id: "claim-1", claim: "A fact." }],
        },
        factSlotCoverage: [],
      },
      "sanitize-claims.main": {
        claimInventory: {
          verificationCandidates: [{ id: "claim-1", claim: "A fact." }],
        },
        factSlotCoverage: [],
      },
      "audit-claims.main": audit,
    },
  });
  assert([...JSON.stringify(packet.packet.synthesisInput)].length <= 24000);
  assert.equal(
    packet.packet.synthesisInput.inputBudget.budgetBlock.status,
    "blocked",
  );
  const rendered = await render({
    sources: {
      "final-audit.main": {
        schema: "deep-research-final-synthesis-v1",
        digest: "s",
        synthesis: {
          bottomLine: "Answer",
          keyFindingIds: [],
          recommendations: [],
          actionPlan: [],
          caveatNotes: [],
          parentDecisionNotes: [],
        },
      },
      "final-audit-packet.main": packet,
    },
  });
  assert.equal(rendered.status, "failed");
  assert(
    rendered.gates.packetReconciliationBlockers.some((item) =>
      item.includes("budget block"),
    ),
  );
});

test("deep-research shipped final packet graphs provide normalize-input-packet", async () => {
  for (const path of [
    "../../workflows/deep-research/spec.json",
    "../../workflows/deep-research/tiered-verification.spec.json",
  ]) {
    const spec = JSON.parse(
      await readFile(new URL(path, import.meta.url), "utf8"),
    );
    const stage = spec.artifactGraph.stages.find(
      (item) => item.id === "final-audit-packet",
    );
    assert(stage.from.includes("normalize-input-packet"), path);
  }
});

test("deep-research source phrase checks retain exact source-backed API claims", async () => {
  const result = await (
    await import(
      "../../workflows/deep-research/helpers/sanitize-verification-candidates.mjs"
    )
  ).default({
    sources: {
      "normalize-input-packet.main": {
        packet: {
          research: {
            extractedFacts: [
              {
                slotId: "slot-1",
                value: "gen_ai.request.model",
                quote:
                  "The gen_ai.request.model attribute records the requested model name.",
                sourceRefs: ["wsrc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
                sourceUrls: ["https://example.test/api"],
              },
            ],
          },
        },
      },
      "normalize-claims.main": {
        claimInventory: {
          verificationCandidates: [
            {
              id: "claim-1",
              claim:
                "The gen_ai.request.model attribute records the requested model name.",
              factSlotIds: ["slot-1"],
              sourceRefs: ["wsrc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
              sourceUrls: ["https://example.test/api"],
            },
          ],
          preservedClaims: [],
          duplicates: [],
        },
        factSlotCoverage: [],
        coverageGaps: [],
      },
    },
    options: { overclaimedSourceInferencePhrases: ["gen_ai.request.model"] },
  });
  assert.deepEqual(
    result.claimInventory.verificationCandidates.map((row) => row.id),
    ["claim-1"],
  );
});

test("deep-research local url evidence is byte-gated rather than accepted as a web citation", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "deep-research-local-url-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "source.custom"), "enabled = false;\n");
  const result = await claimGate({
    sources: {
      "plan.main": { factSlots: [{ id: "slot-1", type: "policy" }] },
      "normalize-input-packet.main": { packet: { research: { sources: [] } } },
      "normalize-claims.main": {
        claimInventory: {
          verificationCandidates: [
            {
              id: "claim-1",
              claim: "The feature is disabled.",
              sourceRefs: ["source.custom"],
              factSlotIds: ["slot-1"],
            },
          ],
        },
        factSlotCoverage: [],
      },
      "sanitize-claims.main": {
        claimInventory: {
          verificationCandidates: [
            {
              id: "claim-1",
              claim: "The feature is disabled.",
              sourceRefs: ["source.custom"],
              factSlotIds: ["slot-1"],
            },
          ],
        },
      },
      "verify-claims.claim-1": {
        id: "claim-1",
        status: "verified",
        evidence: [
          {
            url: "source.custom",
            lineStart: 1,
            lineEnd: 1,
            quote: "not the bytes",
          },
        ],
      },
    },
    context: { cwd },
    options: { requireFetchedEvidenceForVerified: true },
  });
  assert.equal(result.verdictCounts.verified, 0);
  assert.equal(result.verdictCounts.partiallySupported, 1);
  assert.equal(
    result.auditedClaims[0].evidenceGate.reasonCode,
    "local_quote_mismatch",
  );
});

test("deep-research final packet bounds the required synthesis read and rejects incomplete floors", async () => {
  const candidates = Array.from({ length: 48 }, (_, i) => ({
    id: `claim-${i + 1}`,
    claim: "A grounded claim.",
    factSlotIds: ["slot-1"],
  }));
  const audit = auditSource({ claimCount: 48 });
  const ids = candidates.map((candidate) => candidate.id);
  audit.statusPartitions.verified = ids;
  audit.verdictCounts.verified = ids.length;
  audit.verifierOwnerLedger = audit.claimDigests.map(
    (row) => row.verifierOwner,
  );
  const sources = {
    "plan.main": {
      researchQuestions: [{ id: "rq-1" }],
      factSlots: [{ id: "slot-1", label: "slot", status: "filled" }],
    },
    "normalize-input-packet.main": {
      packet: {
        researchQuestionCoverage: {
          passed: true,
          plannedIds: ["rq-1"],
          completedIds: ["rq-1"],
          missingIds: [],
          duplicateIds: [],
          extraIds: [],
          failedIds: [],
          invalidPlannedQuestionCount: 0,
          plannedDuplicateIds: [],
          invalidOutputSourceIds: [],
          rows: [
            {
              questionId: "rq-1",
              status: "completed",
              sourceIds: ["research-questions.rq-1"],
            },
          ],
        },
      },
    },
    "normalize-claims.main": {
      claimInventory: {
        verificationCandidates: candidates,
        preservedClaims: [],
      },
      factSlotCoverage: [
        { slotId: "slot-1", status: "filled", verificationCandidateIds: ids },
      ],
      coverageGaps: [],
    },
    "sanitize-claims.main": {
      claimInventory: {
        verificationCandidates: candidates,
        preservedClaims: [],
      },
      factSlotCoverage: [
        { slotId: "slot-1", status: "filled", verificationCandidateIds: ids },
      ],
      coverageGaps: [],
    },
    "audit-claims.main": audit,
  };
  const packet = await finalPacket({ sources });
  const encoded = JSON.stringify(packet.packet.synthesisInput);
  assert([...encoded].length <= 24000);
  assert.equal(packet.packet.synthesisInput.claims.length, 48);
  assert.equal(packet.packet.synthesisInput.inputBudget.claimRowsPreserved, 48);

  const cleanSynthesis = {
    schema: "deep-research-final-synthesis-v1",
    digest: "s",
    synthesis: {
      bottomLine: "Answer",
      keyFindingIds: [],
      recommendations: [
        {
          recommendation: "Ship now",
          supportingClaimIds: [],
          evidenceStatus: "verified",
        },
      ],
      actionPlan: [],
      caveatNotes: [],
      parentDecisionNotes: [],
    },
  };
  const unicodeControl = {
    ...cleanSynthesis,
    synthesis: { ...cleanSynthesis.synthesis, bottomLine: "😀".repeat(2001) },
  };
  const unicodeRendered = await render({
    sources: {
      "final-audit.main": unicodeControl,
      "final-audit-packet.main": packet,
    },
  });
  assert.notEqual(unicodeRendered.status, "blocked");
  const rendered = await render({
    sources: {
      "final-audit.main": cleanSynthesis,
      "final-audit-packet.main": packet,
    },
  });
  assert.equal(rendered.status, "passed", JSON.stringify(rendered.gates));
  assert.match(rendered.reportMarkdown, /Evidence status: unverified/);
  assert.doesNotMatch(rendered.reportMarkdown, /Evidence status: derived/);
  const hostileSynthesis = {
    ...cleanSynthesis,
    synthesis: {
      ...cleanSynthesis.synthesis,
      bottomLine: "<em>unsafe</em> [click](javascript:alert(1))",
      keyFindingIds: ["claim-1"],
    },
  };
  const hostile = await render({
    sources: {
      "final-audit.main": hostileSynthesis,
      "final-audit-packet.main": packet,
    },
  });
  assert.equal(hostile.reportMarkdown.includes("<em>"), false);
  assert.doesNotMatch(hostile.reportMarkdown, /\[click\]\(javascript:/);
  const sidecarFailure = await render({
    sources: {
      "final-audit.main": cleanSynthesis,
      "final-audit-packet.main": packet,
    },
    context: { cwd: "/dev/null", runId: "r", taskId: "t" },
  });
  assert.equal(sidecarFailure.sidecarErrors.length, 1);
  assert.equal(sidecarFailure.gates.sidecarWriteSucceeded, false);
  assert.equal(sidecarFailure.status, "failed");

  const blockedPacket = await finalPacket({
    sources: { ...sources, "audit-claims.main": auditSource({ floor: 1 }) },
  });
  const blocked = await render({
    sources: {
      "final-audit.main": cleanSynthesis,
      "final-audit-packet.main": blockedPacket,
    },
  });
  assert.equal(blocked.status, "failed");
  assert(
    blocked.gates.packetReconciliationBlockers.some((item) =>
      item.includes("floor blockers"),
    ),
  );
});

test("deep-research local aliases honor typed paths and do not read opaque labels", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "deep-research-local-context-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "README"), "actual bytes\\n");
  const rows = await localQuoteGate(
    [
      { file: "README", source: "display label", lineStart: 1, quote: "actual bytes" },
      { sourceRef: "README#L1", lineStart: 1, quote: "actual bytes" },
      { source: "README", lineStart: 1, quote: "actual bytes" },
      { sourceRef: "opaque-web-ref", lineStart: 1, quote: "remote quote" },
      { sourceRef: "README", lineStart: 1 },
    ],
    { cwd },
  );
  assert.equal(rows.length, 4);
  assert(rows.slice(0, 3).every((row) => row.status === "verified"));
  assert.equal(rows[3].status, "mismatch");
  assert(rows.every((row) => row.file === "README"));
});

test("deep-research contradictory local and remote evidence is conservatively downgraded", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "deep-research-contradictory-fields-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "good.txt"), "actual bytes\\n");
  const sources = {
    "plan.main": { factSlots: [{ id: "slot-1" }] },
    "normalize-input-packet.main": { packet: { research: { sources: [] } } },
    "normalize-claims.main": {
      claimInventory: {
        verificationCandidates: [{ id: "claim-1", claim: "actual bytes", sourceRefs: ["good.txt"], factSlotIds: ["slot-1"] }],
      },
    },
    "sanitize-claims.main": {
      claimInventory: {
        verificationCandidates: [{ id: "claim-1", claim: "actual bytes", sourceRefs: ["good.txt"], factSlotIds: ["slot-1"] }],
      },
    },
    "verify-claims.claim-1": {
      id: "claim-1",
      status: "verified",
      evidence: [{ file: "good.txt", url: "https://contradict.invalid/doc", lineStart: 1, quote: "actual bytes" }],
    },
  };
  const result = await claimGate({ sources, context: { cwd } });
  assert.equal(result.verdictCounts.verified, 0);
  assert.equal(result.verdictCounts.partiallySupported, 1);
  assert.equal(result.auditedClaims[0].evidenceGate.reasonCode, "local_file_and_remote_url_conflict");
});

test("deep-research actual synthesis reads use UTF-16 budget telemetry and preserve raw ledgers", async (t) => {
  for (const questionId of ["rq-plain", "rq-mixed-😀-\\\\-\\\"", `rq-${"😀".repeat(12000)}`]) {
    const packet = await finalPacket({ sources: packetSources(questionId) });
    const { encoded, projection } = await actualSynthesisRead(t, packet);
    assert.equal(packet.packet.synthesisInput.inputBudget.utf16Chars, encoded.length);
    assert.equal(
      packet.packet.synthesisInput.inputBudget.codePointTelemetry.codePoints,
      [...encoded].length,
    );
    assert(encoded.length < 24000);
    assert.equal(projection.projection.charsTruncated, false);
    if (questionId.includes("😀".repeat(100))) {
      assert.equal(packet.packet.synthesisInput.inputBudget.budgetBlock.status, "blocked");
      assert.equal(packet.packet.claimVerdictLedger.length, 1);
    } else {
      assert.equal(packet.packet.synthesisInput.inputBudget.budgetBlock, undefined);
    }
  }
});

test("deep-research demotion identities survive sanitizer, audit packet, and render gap ledger", async () => {
  const refs = Array.from({ length: 8 }, (_, index) => `wsrc_${String(index + 1).padStart(32, "a")}`);
  const urls = Array.from({ length: 8 }, (_, index) => `https://gap-${index}.invalid/doc`);
  const sanitized = await (await import("../../workflows/deep-research/helpers/sanitize-verification-candidates.mjs")).default({
    sources: {
      "normalize-input-packet.main": { packet: { research: { sources: [] } } },
      "normalize-claims.main": {
        claimInventory: {
          verificationCandidates: [{ id: "demoted-1", claim: "Every vendor should adopt this implementation plan.", sourceRefs: refs, sourceUrls: urls, factSlotIds: ["slot-1"] }],
          preservedClaims: [],
        },
        factSlotCoverage: [{ slotId: "slot-1", status: "filled" }],
        coverageGaps: [],
      },
    },
  });
  assert.deepEqual(sanitized.coverageGaps[0].sourceRefs, refs);
  assert.deepEqual(sanitized.coverageGaps[0].sourceUrls, urls);
  const audit = await claimGate({
    sources: {
      "normalize-claims.main": sanitized,
      "sanitize-claims.main": sanitized,
    },
  });
  const packet = await finalPacket({
    sources: {
      "plan.main": { factSlots: [{ id: "slot-1", status: "filled" }] },
      "normalize-claims.main": sanitized,
      "sanitize-claims.main": sanitized,
      "audit-claims.main": audit,
    },
  });
  assert.deepEqual(packet.packet.coverageGaps[0].sourceRefs, refs);
  assert.deepEqual(packet.packet.coverageGaps[0].sourceUrls, urls);
  const synthesisGap = packet.packet.synthesisInput.gaps.find(
    (gap) => gap.claimId === "demoted-1",
  );
  assert.deepEqual(synthesisGap.sourceRefs, refs);
  assert.deepEqual(synthesisGap.sourceUrls, urls);
  const rendered = await render({
    sources: {
      "final-audit.main": {
        schema: "deep-research-final-synthesis-v1",
        digest: "s",
        synthesis: {
          bottomLine: "Answer",
          keyFindingIds: [],
          recommendations: [],
          actionPlan: [],
          caveatNotes: [],
          parentDecisionNotes: [],
        },
      },
      "final-audit-packet.main": packet,
    },
  });
  assert(urls.every((url) => rendered.sourceUrls.includes(url)));
});
