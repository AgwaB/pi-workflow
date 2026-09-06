import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { compileWorkflow } from "../../.tmp/unit/compiler.js";
import { scheduleRun } from "../../.tmp/unit/engine.js";
import { buildForeachGeneratedTasks } from "../../.tmp/unit/engine-run-graph.js";
import { loadWorkflowSpec } from "../../.tmp/unit/schema.js";
import { setSubagentApiForTests } from "../../.tmp/unit/subagent-backend.js";
import {
  compiledWorkflowPath,
  createWorkflowRunRecord,
  readRunRecord,
  writeRunRecord,
  writeStaticRunArtifacts,
} from "../../.tmp/unit/store.js";
import { validateJsonSchema } from "../../.tmp/unit/json-schema.js";
import { completeTask, taskBySpec } from "./unit-test-support.mjs";
import claimGate from "../../workflows/deep-research/helpers/claim-evidence-gate.mjs";
import finalPacket from "../../workflows/deep-research/helpers/final-audit-packet.mjs";
import render from "../../workflows/deep-research/helpers/render-executive.mjs";

const specPath = fileURLToPath(
  new URL("../../workflows/deep-research/spec.json", import.meta.url),
);
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const ids = ["claim-alpha", "claim-beta"];
const candidates = ids.map((id) => ({
  id,
  claim: "The feature is disabled.",
  file: "source.ts",
  sourceRefs: ["source.ts"],
  sourceUrls: [],
  sourceQuality: "local_repo",
  factSlotIds: ["slot-local"],
  scopeItems: ["local behavior"],
  reasonToVerify: "Check current bytes",
  verificationNeed: "core",
}));
const inventory = {
  schema: "stage-control-v1",
  digest: "Fixture candidates",
  claimInventory: {
    verificationCandidates: candidates,
    preservedClaims: [],
    duplicates: [],
  },
  factSlotCoverage: [
    {
      slotId: "slot-local",
      label: "Local behavior",
      status: "filled",
      bestValue: "disabled",
      sourceUrls: [],
      sourceQuality: "local_repo",
      verificationCandidateIds: ids,
    },
  ],
  coverageGaps: [],
  researchScopeCoverage: [],
  normalizationNotes: [],
};
const verifier = (id) => ({
  schema: "deep-research-verify-claim-v1",
  digest: "Fixture byte evidence",
  id,
  status: "verified",
  confidence: "high",
  verdictDigest: { support: "The local source disables the feature." },
  evidence: [
    {
      file: "source.ts",
      lineStart: 1,
      lineEnd: 1,
      quote: "export const enabled = false;",
    },
  ],
  caveats: [],
  correctionOrCounterclaim: "",
});
const synthesis = {
  schema: "deep-research-final-synthesis-v1",
  digest: "Fixture synthesis",
  synthesis: {
    bottomLine: "The feature is disabled in the local fixture.",
    keyFindingIds: ids,
    recommendations: [],
    actionPlan: [],
    caveatNotes: [],
    parentDecisionNotes: [],
  },
};

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "research-verifier-identity-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
  await writeFile(
    join(cwd, ".pi", "agents", "researcher.md"),
    await readFile(new URL("../../agents/researcher.md", import.meta.url)),
  );
  await writeFile(join(cwd, "source.ts"), "export const enabled = false;\n");
  const loaded = await loadWorkflowSpec(specPath, cwd);
  const compiled = await compileWorkflow(loaded.spec, {
    cwd,
    specPath,
    task: "Inspect local behavior in source.ts.",
  });
  return { cwd, compiled, spec: loaded.spec };
}

async function control(cwd, run, specId) {
  return readJson(
    join(cwd, dirname(taskBySpec(run, specId).files.result), "control.json"),
  );
}

// No worker executes: only model control artifacts are seeded using the existing
// fixture helper. The actual bundled graph, scheduler materialization, support
// context sourceStatuses, audit, packet and final renderer execute unchanged.
test("bundled deep-research carries materialized claim owners through runtime audit and final render", async (t) => {
  const { cwd, compiled, spec } = await fixture(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Network is forbidden in the identity fixture");
  });
  t.after(() => assert.equal(fetch.mock.callCount(), 0));
  const launches = [];
  setSubagentApiForTests({
    async runSubagent(options) {
      launches.push(options);
      return {
        runId: `run_identity_${launches.length}`,
        attemptId: `attempt_identity_${launches.length}`,
        status: "running",
      };
    },
    async getSubagentStatus() {
      return null;
    },
    async reconcileSubagentRun() {
      return {};
    },
    async interruptSubagent() {
      return {};
    },
  });
  t.after(() => setSubagentApiForTests(undefined));
  const { run: initial } = await createWorkflowRunRecord(
    cwd,
    compiled,
    specPath,
  );
  await writeStaticRunArtifacts(cwd, initial, compiled, spec);
  const seed = {
    "plan.main": {
      depth: "quick",
      factSlots: [
        {
          id: "slot-local",
          label: "Local behavior",
          type: "policy",
          required: true,
          sourcePriority: "local_repo",
        },
      ],
      researchScope: [],
      researchQuestions: [],
    },
    "research-questions.item": {},
    "normalize-input-packet.main": { packet: { research: { sources: [] } } },
    "normalize-claims.main": inventory,
    "sanitize-claims.main": inventory,
  };
  for (const [id, value] of Object.entries(seed))
    await completeTask(cwd, taskBySpec(initial, id), value);
  await writeRunRecord(cwd, initial);
  await scheduleRun(cwd, initial.runId);
  let run = await readRunRecord(cwd, initial.runId);
  const children = run.tasks.filter(
    (task) => task.foreachGenerated?.placeholderSpecId === "verify-claims.item",
  );
  assert.deepEqual(
    children.map((task) => task.specId),
    ids.map((id) => `verify-claims.${id}`),
  );
  assert.equal(launches.length, 2);
  const verifierSchema = await readJson(
    join(
      dirname(specPath),
      "schemas/deep-research-verify-claims-control.schema.json",
    ),
  );
  for (const [index, child] of children.entries()) {
    const output = verifier(ids[index]);
    assert.equal(validateJsonSchema(output, verifierSchema).valid, true);
    await completeTask(cwd, child, output);
  }
  await writeRunRecord(cwd, run);
  await scheduleRun(cwd, run.runId);
  run = await readRunRecord(cwd, run.runId);
  const audit = await control(cwd, run, "audit-claims.main");
  const packet = await control(cwd, run, "final-audit-packet.main");
  const synthesisSchema = await readJson(
    join(
      dirname(specPath),
      "schemas/deep-research-final-synthesis-control.schema.json",
    ),
  );
  assert.equal(validateJsonSchema(synthesis, synthesisSchema).valid, true);
  await completeTask(cwd, taskBySpec(run, "final-audit.main"), synthesis);
  await writeRunRecord(cwd, run);
  await scheduleRun(cwd, run.runId);
  run = await readRunRecord(cwd, run.runId);
  const final = await control(cwd, run, "final.main");
  // Preserve enough genuine red diagnostics to distinguish owner rejection from
  // an invalid fixture or absent model id, even when the final assertion fails.
  t.diagnostic(
    JSON.stringify({
      owners: children.map((task) => task.foreachGenerated),
      verifierIds: ids,
      ownerIssues: audit.verifierOwnerIssues,
      finalStatus: final.status,
      blockers: final.gates.packetReconciliationBlockers,
    }),
  );
  assert.equal(
    final.status,
    "passed",
    "valid bundled verifier results must pass final reconciliation",
  );
  assert.equal(run.status, "completed");
  assert.equal(
    launches.length,
    3,
    "only two verifier workers and synthesis are stubbed",
  );
  assert.deepEqual(
    children.map((task) => task.foreachGenerated.itemIdentity),
    ids,
  );
  const materialized = await readJson(compiledWorkflowPath(cwd, run.runId));
  assert.deepEqual(
    materialized.tasks
      .filter(
        (task) =>
          task.foreachGenerated?.placeholderSpecId === "verify-claims.item",
      )
      .map((task) => task.foreachGenerated.itemIdentity),
    ids,
  );
  assert.equal(audit.gateSummary.validVerifierRows, 2);
  assert.equal(audit.gateSummary.verifierOwnerIssues, 0);
  assert.equal(audit.gateSummary.missingVerifierResults, 0);
  assert.deepEqual(audit.invalidVerifierRows, []);
  assert.deepEqual(audit.sourceRefJoinFailures, []);
  assert.equal(audit.verdictCounts.verified, 2);
  assert.deepEqual(
    audit.verifierOwnerLedger.map((owner) => [
      owner.itemIdentity,
      owner.taskId,
      owner.specId,
    ]),
    children.map((task) => [
      task.foreachGenerated.itemIdentity,
      task.taskId,
      task.specId,
    ]),
  );
  assert.deepEqual(
    packet.packet.verifierIntegrity.verifierOwnerLedger,
    audit.verifierOwnerLedger,
  );
  assert.deepEqual(
    packet.packet.claimVerdictLedger.map((row) => row.verifierOwner),
    audit.verifierOwnerLedger,
  );
  assert.equal(final.gates.packetReconciliationPassed, true);
});

test("bundled verifier materialization rejects missing, invalid, duplicate and colliding claim IDs", async (t) => {
  const { compiled } = await fixture(t);
  const template = compiled.tasks.find(
    (task) => task.id === "verify-claims.item",
  );
  for (const items of [
    [{}],
    [{ id: "" }],
    [{ id: 42 }],
    [{ id: "../escape" }],
    [{ id: "item" }],
    [{ id: "same" }, { id: "same" }],
  ]) {
    const generated = buildForeachGeneratedTasks(template, undefined, items);
    assert.ok(
      generated.error,
      `invalid identity must fail closed: ${JSON.stringify(items)}`,
    );
    assert.deepEqual(generated.tasks, []);
  }
});

// Negative-only mutation fixtures supplement the runtime positive above; they
// never supply or repair owner metadata on that positive path.
for (const mode of [
  "missing-owner",
  "duplicate-owner",
  "missing-identity",
  "wrong-identity",
  "wrong-stage",
  "wrong-spec",
  "missing-task",
  "wrong-placeholder",
  "failed-owner",
  "missing-id",
  "blank-id",
  "non-string-id",
  "mismatched-id",
]) {
  test(`deep-research quarantines ${mode} and gives accurate recovery guidance`, async (t) => {
    const { cwd, compiled } = await fixture(t);
    const template = compiled.tasks.find(
      (task) => task.id === "verify-claims.item",
    );
    const generated = buildForeachGeneratedTasks(template, undefined, [
      candidates[0],
    ]).tasks[0];
    const source = "verify-claims";
    const row = verifier(ids[0]);
    const owner = {
      source,
      specId: generated.specId,
      stageId: generated.stageId,
      taskId: "task-fixture",
      status: "completed",
      ...generated.foreachGenerated,
    };
    let statuses = [owner];
    if (mode === "missing-owner") statuses = [];
    if (mode === "duplicate-owner")
      statuses.push({ ...owner, taskId: "task-other" });
    if (mode === "missing-identity") delete owner.itemIdentity;
    if (mode === "wrong-identity") owner.itemIdentity = ids[1];
    if (mode === "wrong-stage") owner.stageId = "other";
    if (mode === "wrong-spec") owner.specId = `verify-claims.${ids[1]}`;
    if (mode === "missing-task") delete owner.taskId;
    if (mode === "wrong-placeholder") owner.placeholderSpecId = "other.item";
    if (mode === "failed-owner") owner.status = "failed";
    if (mode === "missing-id") delete row.id;
    if (mode === "blank-id") row.id = " ";
    if (mode === "non-string-id") row.id = 42;
    if (mode === "mismatched-id") row.id = ids[1];
    const singleInventory = {
      ...inventory,
      claimInventory: {
        ...inventory.claimInventory,
        verificationCandidates: [candidates[0]],
      },
      factSlotCoverage: inventory.factSlotCoverage.map((slot) => ({
        ...slot,
        verificationCandidateIds: [ids[0]],
      })),
    };
    const sources = { "sanitize-claims": singleInventory, [source]: row };
    const audit = await claimGate({
      sources,
      context: { cwd, sourceStatuses: statuses },
    });
    assert.equal(audit.gateSummary.validVerifierRows, 0);
    assert.equal(audit.verdictCounts.verified, 0);
    assert.deepEqual(audit.verifierOwnerLedger, []);
    assert.equal(audit.invalidVerifierRows.length, 1);
    const issue = audit.invalidVerifierRows[0];
    if (["missing-id", "blank-id", "non-string-id"].includes(mode)) {
      const expectedReason =
        mode === "missing-id"
          ? "missing_claim_id"
          : mode === "blank-id"
            ? "blank_claim_id"
            : "non_string_claim_id";
      assert.equal(issue.reason, expectedReason);
      assert.match(issue.nextStep, /missing a usable string id\/claimId/);
    } else {
      const expectedReason =
        mode === "missing-owner"
          ? "missing_materialized_verifier_owner"
          : mode === "duplicate-owner"
            ? "verifier_source_not_bound_to_exactly_one_materialized_owner"
            : "verifier_source_status_identity_mismatch";
      assert.equal(issue.reason, expectedReason);
      assert.match(issue.nextStep, /runtime.*owner/i);
      assert.match(issue.nextStep, /itemIdentity/);
      assert.doesNotMatch(issue.nextStep, /output is missing a usable/);
    }
    const packet = await finalPacket({
      sources: { ...sources, "audit-claims": audit },
    });
    assert.equal(packet.packet.claimVerdictLedger.length, 1);
    const final = await render({
      sources: {
        "final-audit-packet": packet,
        "final-audit": {
          ...synthesis,
          synthesis: { ...synthesis.synthesis, keyFindingIds: [ids[0]] },
        },
      },
      context: { cwd },
    });
    assert.equal(final.status, "failed");
    assert.equal(final.gates.packetReconciliationPassed, false);
  });
}
