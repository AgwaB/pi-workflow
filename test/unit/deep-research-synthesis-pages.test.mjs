import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { checkRequiredArtifactReads } from "../../.tmp/unit/subagent-backend.js";
import { validateJsonSchema } from "../../.tmp/unit/json-schema.js";
import finalPacket from "../../workflows/deep-research/helpers/final-audit-packet.mjs";
import render from "../../workflows/deep-research/helpers/render-executive.mjs";
import {
  buildSynthesisPages,
  canonicalSynthesisData,
  reconstructSynthesisPages,
  validateSynthesisPages,
} from "../../workflows/deep-research/helpers/synthesis-pages.mjs";
import { artifactReadFixture } from "./helpers/workflow-artifact-fixture.mjs";

const fixture = JSON.parse(
  await readFile(
    new URL(
      "../fixtures/deep-research/max-synthesis-handoff-replay.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const schema = JSON.parse(
  await readFile(
    new URL(
      "../../workflows/deep-research/schemas/deep-research-final-audit-packet-control.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const paths = [
  "$.packet.synthesisInput.header",
  ...Array.from({ length: 8 }, (_, i) => `$.packet.synthesisInput.pages[${i}]`),
];
const required = paths.map((path) => ({
  source: "final-audit-packet",
  artifact: "control",
  path,
  maxChars: 24000,
  count: 1,
}));
const overlay = {
  schema: "deep-research-final-synthesis-v1",
  digest: "Synthetic scale handoff; evidence remains limited.",
  synthesis: {
    bottomLine:
      "Regional freshness defaults are supported; historical client compatibility remains unresolved.",
    keyFindingIds: ["claim-001", "claim-018", "claim-019"],
    recommendations: [
      {
        recommendation: "Test legacy clients before rollout.",
        supportingClaimIds: ["claim-019"],
      },
    ],
    actionPlan: [],
    caveatNotes: [
      {
        note: "Partial evidence is not a rollout guarantee.",
        relatedClaimIds: ["claim-019"],
        gapIds: ["gap-remaining-001"],
      },
    ],
    parentDecisionNotes: [],
  },
};
const renderPacket = (control) =>
  render({
    sources: { "final-audit-packet": control, "final-audit": overlay },
  });
const json = (value) => JSON.parse(JSON.stringify(value));

function deliveredValue(result) {
  assert.equal(result.details.truncated, false);
  return JSON.parse(result.content[0].text.split("\n\n").slice(1).join("\n\n"))
    .value;
}

async function readBank(t, control) {
  const f = await artifactReadFixture(t, control, "final-audit-packet");
  const delivered = [];
  for (const requirement of required) {
    const result = await f.read(requirement);
    const value = deliveredValue(result);
    assert.equal(
      result.details.projection.originalChars,
      JSON.stringify(value).length,
    );
    assert(JSON.stringify(value).length <= 24000);
    delivered.push(value);
  }
  assert.deepEqual(await checkRequiredArtifactReads(f.consumer, required), {
    missing: [],
    projectionFailures: [],
  });
  return { f, input: { header: delivered[0], pages: delivered.slice(1) } };
}

test("both research specs require the exact header and all eight indexed pages", async () => {
  for (const filename of ["spec.json", "tiered-verification.spec.json"]) {
    const spec = JSON.parse(
      await readFile(
        new URL(`../../workflows/deep-research/${filename}`, import.meta.url),
        "utf8",
      ),
    );
    const stage = spec.artifactGraph.stages.find(
      (row) => row.id === "final-audit",
    );
    assert.deepEqual(stage.inputPolicy.requiredReads, required);
    assert.equal(stage.inputPolicy.enforcement, "fail");
    for (const path of paths) assert(stage.prompt.includes(path));
    assert.match(stage.prompt, /including empty tails/);
    assert.match(stage.prompt, /Do not make extra workflow_artifact reads/);
    assert.doesNotMatch(stage.prompt, /synthesisInput\.integritySummary/);
    if (filename === "tiered-verification.spec.json") {
      assert.match(stage.prompt, /packet\.verifierIntegrity\.invalidNormalizedCandidateCount/);
      assert.match(stage.prompt, /packet\.verifierIntegrity\.invalidNormalizedCandidateRows/);
    }
  }
});

test("48 evidence-bearing claims, 56 slots, 22 questions reach actual synthesis reads losslessly", async (t) => {
  const control = await finalPacket({ sources: fixture.sources });
  const packet = control.packet;
  assert.equal(validateJsonSchema(control, schema).valid, true);
  assert.equal(packet.synthesisInput.header.budgetBlock, undefined);
  assert(JSON.stringify(packet.synthesisInput).length > 24000);
  const { input } = await readBank(t, control);
  const decoded = reconstructSynthesisPages(input);
  assert.deepEqual(decoded, canonicalSynthesisData(packet));
  assert.deepEqual(
    validateSynthesisPages({ ...packet, synthesisInput: input }),
    [],
  );
  assert.equal(decoded.claimVerdictLedger.length, 48);
  assert.equal(decoded.factSlotCoverage.length, 56);
  assert.equal(decoded.researchQuestionCoverage.length, 22);
  assert.equal(decoded.preservedClaims.length, 24);
  assert.equal(decoded.researchScopeCoverage.length, 16);
  assert.equal(decoded.remainingGaps.length + decoded.coverageGaps.length, 47);
  const evidence = decoded.claimVerdictLedger.flatMap((row) => row.evidence);
  assert.equal(
    new Set(evidence.map((row) => JSON.stringify(row))).size,
    evidence.length,
  );
  assert(evidence.length >= 48);
  for (const [index, claim] of decoded.claimVerdictLedger.entries()) {
    const audited = fixture.sources["audit-claims"].claimDigests[index];
    assert.deepEqual(claim, json(packet.claimVerdictLedger[index]));
    assert.equal(claim.support, audited.verdictDigest.support);
    assert.equal(claim.caveat, audited.verdictDigest.caveat);
    assert.equal(claim.claim, audited.claim);
    assert.equal(
      claim.correctionOrCounterclaim,
      audited.correctionOrCounterclaim,
    );
    assert.deepEqual(claim.evidence, audited.evidence);
    assert(claim.support.length > 120);
  }
  const result = await renderPacket(control);
  assert.equal(result.status, "passed", JSON.stringify(result.gates));
  const contradictory = structuredClone(control);
  contradictory.packet.verifierIntegrity.gateSummary.sourceRefJoinFailures = 1;
  contradictory.packet.synthesisInput = buildSynthesisPages(
    contradictory.packet,
  );
  assert.deepEqual(validateSynthesisPages(contradictory.packet), []);
  const rejected = await renderPacket(contradictory);
  assert.equal(rejected.status, "failed");
  assert(
    rejected.gates.packetReconciliationBlockers.includes(
      "gate source-ref count does not match rows",
    ),
  );
  assert.equal(result.claimSummary.verified, 18);
  assert.equal(result.claimSummary.partially_supported, 30);
  assert.equal(result.factSlotSummary.partial, 48);
  assert.equal(result.factSlotSummary.missingOrConflicting, 8);
  assert.equal(result.gates.packetReconciliationPassed, true);
  const reordered = await finalPacket({
    sources: Object.fromEntries(Object.entries(fixture.sources).reverse()),
  });
  assert.deepEqual(reordered, control);
  const rowsReordered = structuredClone(fixture.sources);
  rowsReordered["audit-claims"].claimDigests.reverse();
  const reversed = await finalPacket({ sources: rowsReordered });
  assert.deepEqual(
    reconstructSynthesisPages(reversed.packet.synthesisInput),
    canonicalSynthesisData(reversed.packet),
  );
});

test("real read gate rejects missing tail, wrong root, truncation, and duplicate qualifying reads", async (t) => {
  const control = await finalPacket({ sources: fixture.sources });
  const f = await artifactReadFixture(t, control, "final-audit-packet");
  // Even an untruncated whole-root read is not a different required path.
  // This larger read is a negative test only, never an allowed synthesis call.
  await f.read({ path: "$.packet", maxChars: 1000000 });
  assert.equal(
    (await checkRequiredArtifactReads(f.consumer, required)).missing.length,
    9,
  );
  for (const req of required.slice(0, -1)) await f.read(req);
  assert.equal(
    (await checkRequiredArtifactReads(f.consumer, required)).missing.length,
    1,
  );
  const damaged = structuredClone(control);
  damaged.packet.synthesisInput.pages[7].entries.push({
    field: "hostile",
    value: "😀".repeat(24000),
  });
  await writeFile(f.bundle.files.control, JSON.stringify(damaged));
  const clipped = await f.read(required[8]);
  assert.equal(clipped.details.truncated, true);
  assert.equal(
    (await checkRequiredArtifactReads(f.consumer, required)).missing.length,
    1,
  );
  await writeFile(f.bundle.files.control, JSON.stringify(control));
  await f.read(required[8]);
  assert.deepEqual(await checkRequiredArtifactReads(f.consumer, required), {
    missing: [],
    projectionFailures: [],
  });
  await f.read(required[8]);
  assert.equal(
    (await checkRequiredArtifactReads(f.consumer, required)).missing.length,
    1,
  );
});

test("missing, duplicate, extra, tampered and hidden omitted canonical page data fail render", async () => {
  const control = await finalPacket({ sources: fixture.sources });
  for (const mutate of [
    (p) => {
      p.synthesisInput.pages.pop();
    },
    (p) => {
      p.synthesisInput.pages[1] = structuredClone(p.synthesisInput.pages[0]);
    },
    (p) => {
      p.synthesisInput.pages[1] = {
        ...structuredClone(p.synthesisInput.pages[0]),
        index: 1,
      };
      p.synthesisInput.header.pageEntryCounts[1] =
        p.synthesisInput.pages[1].entries.length;
    },
    (p) => {
      p.synthesisInput.pages.push({ index: 8, entries: [] });
    },
    (p) => {
      p.synthesisInput.header.pageCount = 7;
    },
    (p) => {
      p.synthesisInput.header.pageEntryCounts[0] += 1;
    },
    (p) => {
      p.synthesisInput.pages[0].entries.push(
        p.synthesisInput.pages[0].entries[0],
      );
    },
    (p) => {
      p.synthesisInput.pages
        .flatMap((page) => page.entries)
        .find((e) => e.field === "claimVerdictLedger").value.support =
        "tampered";
    },
    (p) => {
      p.synthesisInput.pages
        .flatMap((page) => page.entries)
        .find((e) => e.field === "claimVerdictLedger").value.evidence[0].quote =
        "tampered";
    },
    (p) => {
      p.synthesisInput = buildSynthesisPages({
        ...canonicalSynthesisData(p),
        claimVerdictLedger: [],
      });
    },
    (p) => {
      p.synthesisInput = buildSynthesisPages({
        ...canonicalSynthesisData(p),
        researchQuestionCoverage: [],
        factSlotCoverage: [],
      });
    },
    (p) => {
      p.synthesisInput = buildSynthesisPages({
        ...canonicalSynthesisData(p),
        preservedClaims: [],
        remainingGaps: [],
        researchScopeCoverage: [],
      });
    },
    (p) => {
      p.synthesisInput = buildSynthesisPages({});
    },
    (p) => {
      delete p.synthesisInput;
    },
  ]) {
    const damaged = structuredClone(control);
    mutate(damaged.packet);
    assert(validateSynthesisPages(damaged.packet).length > 0);
    const result = await renderPacket(damaged);
    assert(
      ["failed", "blocked"].includes(result.status),
      JSON.stringify(result.gates),
    );
  }
});

test("UTF-16 exact boundary includes JSON escaping but excludes tool envelope; no surrogate clipping", async (t) => {
  const canonical = {
    claimVerdictLedger: [
      { id: "claim-astral-😀", claim: '😀 " \\ \n \t \u0000' },
    ],
  };
  let input = buildSynthesisPages(canonical);
  const padding = 24000 - JSON.stringify(input.pages[0]).length;
  canonical.claimVerdictLedger[0].claim += "x".repeat(padding);
  input = buildSynthesisPages(canonical);
  assert.equal(JSON.stringify(input.pages[0]).length, 24000);
  assert([...JSON.stringify(input.pages[0])].length < 24000);
  const { f, input: delivered } = await readBank(t, {
    schema: "test",
    digest: "boundary",
    packet: { ...canonical, synthesisInput: input },
  });
  assert.deepEqual(reconstructSynthesisPages(delivered), canonical);
  const response = await f.read(required[1]);
  assert(
    response.content[0].text.length > 24000,
    "envelope is outside the selected-value cap",
  );
  canonical.claimVerdictLedger[0].claim += "😀";
  const blocked = buildSynthesisPages(canonical);
  assert.equal(blocked.header.budgetBlock.reason, "oversized_row");
  assert.equal(canonical.claimVerdictLedger[0].claim.endsWith("😀"), true);
});

test("empty collections require empty tails; hostile row, metadata and exhausted bank stay blocked", async (t) => {
  const canonical = {
    claimVerdictLedger: [],
    factSlotCoverage: [],
    researchQuestionCoverage: [],
    preservedClaims: [],
    remainingGaps: [],
    coverageGaps: [],
    researchScopeCoverage: [],
  };
  const input = buildSynthesisPages(canonical);
  assert(input.pages.every((page) => page.entries.length === 0));
  const emptyControl = {
    schema: "test",
    digest: "empty",
    packet: { ...canonical, synthesisInput: input },
  };
  const { input: delivered } = await readBank(t, emptyControl);
  assert.deepEqual(reconstructSynthesisPages(delivered), canonical);
  const missingTail = await artifactReadFixture(
    t,
    emptyControl,
    "final-audit-packet",
  );
  for (const req of required.slice(0, -1)) await missingTail.read(req);
  assert.equal(
    (await checkRequiredArtifactReads(missingTail.consumer, required)).missing
      .length,
    1,
  );
  assert.deepEqual(deliveredValue(await missingTail.read(required[8])), {
    index: 7,
    entries: [],
  });
  assert.deepEqual(
    await checkRequiredArtifactReads(missingTail.consumer, required),
    { missing: [], projectionFailures: [] },
  );
  const emptyPacket = await finalPacket({
    sources: {
      plan: { researchQuestions: [], factSlots: [] },
      "normalize-claims": {
        claimInventory: { verificationCandidates: [], preservedClaims: [] },
        factSlotCoverage: [],
        coverageGaps: [],
        researchScopeCoverage: [],
      },
      "audit-claims": {
        claimDigests: [],
        gateSummary: { missingVerifierResults: 0 },
        verdictCounts: { verified: 0 },
      },
    },
  });
  assert.deepEqual(
    reconstructSynthesisPages(emptyPacket.packet.synthesisInput),
    canonicalSynthesisData(emptyPacket.packet),
  );
  assert.equal(validateJsonSchema(emptyPacket, schema).valid, true);
  for (const [data, reason] of [
    [
      { claimVerdictLedger: [{ id: "hostile-" + "😀".repeat(12000) }] },
      "oversized_row",
    ],
    [
      { verifierIntegrity: { hostile: "\\\u0000".repeat(6000) } },
      "oversized_row",
    ],
    [
      {
        claimVerdictLedger: Array.from({ length: 9 }, (_, index) => ({
          id: `claim-${index}`,
          support: "x".repeat(23000),
        })),
      },
      "page_bank_exhausted",
    ],
  ]) {
    const original = structuredClone(data);
    const blocked = buildSynthesisPages(data);
    assert.equal(blocked.header.budgetBlock.reason, reason);
    assert.equal(blocked.header.budgetBlock.canonicalLedgerPreserved, true);
    assert.deepEqual(data, original);
    assert(blocked.pages.every((page) => page.entries.length === 0));
    assert.throws(() => reconstructSynthesisPages(blocked));
    await readBank(t, {
      schema: "test",
      digest: "blocked",
      packet: { ...data, synthesisInput: blocked },
    });
  }
  const exhausted = await finalPacket({ sources: fixture.sources });
  for (const claim of exhausted.packet.claimVerdictLedger.slice(0, 10))
    claim.support = "x".repeat(20000);
  const before = canonicalSynthesisData(exhausted.packet);
  exhausted.packet.synthesisInput = buildSynthesisPages(exhausted.packet);
  assert.equal(
    exhausted.packet.synthesisInput.header.budgetBlock.reason,
    "page_bank_exhausted",
  );
  assert.deepEqual(canonicalSynthesisData(exhausted.packet), before);
  const rendered = await renderPacket(exhausted);
  assert.equal(rendered.status, "failed");
  assert(
    rendered.gates.packetReconciliationBlockers.includes(
      "synthesis input budget block is present",
    ),
  );
});
