import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as h from "./unit-test-support.mjs";
import { loadWorkflowSpec } from "../../.tmp/unit/schema.js";
import { validateJsonSchema } from "../../.tmp/unit/json-schema.js";
import render from "../../workflows/spec-review/helpers/render-spec-review-report.mjs";

const citation = { file: "source.ts", lineStart: 1, lineEnd: 1, quote: "export const enabled = true;" };
const candidate = { id: "finding-001", title: "Candidate gap", claim: "Gap", severity: "medium", requirementIds: ["REQ-001"], specEvidence: [], implementationEvidence: [], testEvidence: [], uncertainty: "Verify" };
const positives = ["all-covered-drop", "all-covered-reordered-drop", "gap-keep", "gap-weaken", "partial-keep"];
const modes = [...positives, "coverage-empty", "coverage-wrong-id", "coverage-missing", "coverage-duplicate", "coverage-missing-array", "coverage-missing-id", "coverage-invalid-id", "coverage-missing-status", "coverage-invalid-status", "extract-duplicate", "extract-invalid-id", "extract-empty", "gap-drop", "partial-drop", "unclear-keep", "unlinked-gap", "bad-extra-gap-citation", "bad-extra-positive-citation", "legacy-positive", "missing-proof", "saved-missing", "saved-stale", "saved-forged", "source-stale", "candidate-stale"];

for (const mode of modes) test(`IRCF-01 real materialized coverage: ${mode}`, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "spec-coverage-"));
  let current;
  try {
    h.writeAgent(cwd, "scout", "read, grep, find, ls");
    await writeFile(join(cwd, "source.ts"), `${citation.quote}\n`);
    const bundle = join(cwd, "workflows", "fixture");
    await mkdir(dirname(bundle), { recursive: true });
    await cp(resolve("workflows/spec-review"), bundle, { recursive: true });
    const specPath = join(bundle, "spec.json");
    const loaded = await loadWorkflowSpec(specPath, cwd);
    const compiled = await h.compileWorkflow(loaded.spec, { cwd, specPath, task: "Check exact extracted requirement IDs using local bytes; no provider." });
    assert.deepEqual(compiled.warnings, []);
    const { run } = await h.createWorkflowRunRecord(cwd, compiled, specPath);
    current = run;
    await h.writeStaticRunArtifacts(cwd, run, compiled, loaded.spec);
    await h.writeRunRecord(cwd, run);
    const launches = [];
    h.setSubagentApiForTests({
      async runSubagent(options) { launches.push({ agent: options.agent, model: options.model, tools: options.tools }); return { runId: `fake-${launches.length}`, attemptId: `attempt-${launches.length}`, status: "running" }; },
      async getSubagentStatus() { return null; }, async reconcileSubagentRun() { return {}; }, async interruptSubagent() { return {}; },
    });
    const step = async () => { await h.writeRunRecord(cwd, current); current = await h.scheduleRun(cwd, run.runId); return current; };
    const path = task => join(dirname(join(cwd, task.files.result)), "control.json");
    const read = async task => JSON.parse(await readFile(path(task), "utf8"));
    const complete = async (task, control, malformed = false) => {
      assert.equal(task.status, "running", task.specId);
      const stage = loaded.spec.artifactGraph.stages.find(row => row.id === task.stageId);
      const schema = JSON.parse(await readFile(join(bundle, stage.output.controlSchema), "utf8"));
      // Deliberately malformed controls bypass model-output shape validation
      // to test helper defense in depth. The actual scheduler still writes
      // manifests/materializes tasks and validates support-helper outputs.
      if (!malformed) assert.deepEqual(validateJsonSchema({ schema: "stage-control-v1", digest: "fixture", ...control }, schema), { valid: true, issues: [] });
      await h.completeTask(cwd, task, control);
    };
    current = await step();
    const requirements = [{ id: "REQ-001", requirement: "Enabled", specEvidence: "SPEC.md:1" }];
    if (["coverage-missing", "all-covered-reordered-drop"].includes(mode)) requirements.push({ ...requirements[0], id: "REQ-002" });
    if (mode === "extract-duplicate") requirements.push({ ...requirements[0] });
    if (mode === "extract-invalid-id") requirements[0].id = " REQ-001 ";
    if (mode === "extract-empty") requirements.length = 0;
    const extractTask = h.taskBySpec(current, "extract-spec.main");
    await complete(extractTask, { requirements }, mode === "extract-invalid-id" || mode === "extract-empty");
    await complete(h.taskBySpec(current, "map-implementation.main"), { implementationMap: [{ file: "source.ts", evidence: citation.quote }] });
    await complete(h.taskBySpec(current, "inspect-tests.main"), { testMap: [] });
    current = await step();
    const coverage = [{ requirementId: "REQ-001", status: "covered", evidence: [citation] }];
    if (["gap-keep", "gap-weaken", "gap-drop", "unlinked-gap", "bad-extra-gap-citation"].includes(mode)) coverage[0] = { requirementId: "REQ-001", status: "gap" };
    if (mode.startsWith("partial-")) coverage[0].status = "partial";
    if (mode === "unclear-keep") coverage[0].status = "unclear";
    if (mode === "all-covered-reordered-drop") coverage.unshift({ ...coverage[0], requirementId: "REQ-002" });
    if (mode === "coverage-empty") coverage.length = 0;
    if (mode === "coverage-wrong-id") coverage[0].requirementId = "REQ-NOT-EXTRACTED";
    if (mode === "coverage-duplicate") coverage.push({ ...coverage[0] });
    if (mode === "coverage-missing-id") { delete coverage[0].requirementId; coverage[0].id = "REQ-001"; }
    if (mode === "coverage-invalid-id") coverage[0].requirementId = " REQ-001 ";
    if (mode === "coverage-missing-status") delete coverage[0].status;
    if (mode === "coverage-invalid-status") coverage[0].status = "CONFORMS";
    if (mode.startsWith("bad-extra-")) coverage[0].evidence = [citation, { ...citation, quote: "invented" }];
    if (mode === "legacy-positive") coverage[0].evidence = ["source.ts:1"];
    const actualCandidate = mode === "unlinked-gap" ? { ...candidate, requirementIds: ["REQ-NOT-EXTRACTED"] } : candidate;
    const candidateControl = { candidateFindings: [actualCandidate], requirementCoverage: coverage, needsHuman: [], noIssueNotes: [] };
    if (mode === "coverage-missing-array") delete candidateControl.requirementCoverage;
    const candidateTask = h.taskBySpec(current, "candidate-findings.main");
    await complete(candidateTask, candidateControl, ["coverage-missing-array", "coverage-missing-id", "coverage-invalid-id", "coverage-missing-status", "coverage-invalid-status"].includes(mode));
    current = await step();
    const verifier = current.tasks.find(task => task.foreachGenerated?.placeholderSpecId === "verify-findings.item");
    assert.equal(verifier.foreachGenerated.itemIdentity, candidate.id);
    const keep = ["gap-keep", "gap-weaken", "partial-keep", "unclear-keep", "unlinked-gap", "bad-extra-gap-citation"].includes(mode);
    await complete(verifier, { id: candidate.id, verdict: keep ? mode === "gap-weaken" ? "WEAKEN" : "KEEP" : "DROP", severity: "medium", evidence: keep ? [citation] : [], counterEvidence: keep ? [] : [citation], finalClaim: "Fixture", recommendedAction: "Inspect" });
    if (mode === "missing-proof") await rm(join(dirname(path(candidateTask)), "source-manifest.json"));
    current = await step();
    const partitionTask = h.taskBySpec(current, "partition-findings.main");
    assert.equal(partitionTask.status, "completed");
    const p = await read(partitionTask);
    const owner = p.verifierCoverage.ownerLedger[0];
    assert.equal(owner.taskId, verifier.taskId);
    assert.equal(owner.specId, verifier.specId);
    assert.equal(owner.itemIdentity, candidate.id);
    assert.equal(p.verifierCoverage.ownerLedgerReconciliation.passed, true);
    assert.equal(p.evidenceGate.findings[0].complete, true);
    assert.equal(p.evidenceGate.findings[0].rows[0].status, "verified");
    const pristine = structuredClone(p);
    if (mode === "saved-missing") delete p.evidenceGate.requirementReconciliation;
    if (mode === "saved-stale") p.requirementCoverage[0].requirementId = "REQ-OLD";
    if (mode === "saved-forged") p.evidenceGate.requirementReconciliation = { ...(p.evidenceGate.requirementReconciliation ?? {}), complete: true, requirementIds: ["REQ-FORGED"] };
    if (mode === "source-stale") { const value = await read(extractTask); value.requirements[0].requirement = "Changed control bytes, same IDs"; await writeFile(path(extractTask), JSON.stringify(value)); }
    if (mode === "candidate-stale") { const value = await read(candidateTask); value.requirementCoverage = []; await writeFile(path(candidateTask), JSON.stringify(value)); }
    if (mode.startsWith("saved-")) await writeFile(path(partitionTask), JSON.stringify(p));
    // Follow the canonical gate rather than forcing an inconsistent negative
    // narrative. On the vulnerable baseline the bypasses actually pass.
    const expectedVerdict = p.evidenceGate.requirementReconciliation?.complete === false || mode === "missing-proof"
      ? "INCONCLUSIVE" : keep ? "GAPS_FOUND" : "CONFORMS";
    const report = { schema: "spec-review-report-v1", summary: "Coverage fixture", verdict: expectedVerdict, ownerLedger: p.verifierCoverage.ownerLedger, ownerLedgerReconciliation: p.verifierCoverage.ownerLedgerReconciliation, risks: [], recommendedNextAction: "Inspect" };
    await complete(h.taskBySpec(current, "report.main"), report);
    // Independent renderer invocation uses genuine scheduler identities and
    // manifests too: runtime tamper detection must not be the only rejection.
    const direct = await render({ sources: { "partition-findings": p, report }, context: { cwd, runId: run.runId, sourceStatuses: [partitionTask, h.taskBySpec(current, "report.main")].map(task => ({ source: task.stageId, stageId: task.stageId, specId: task.specId, taskId: task.taskId, status: "completed" })) } });
    current = await step();
    const final = h.taskBySpec(current, "final.main");
    let result;
    try { result = await read(final); } catch {}
    const summary = { mode, runId: run.runId, launches, partition: pristine, direct: { status: direct.status, verdict: direct.verdict, gates: direct.gates }, finalTaskStatus: final.status, final: result ?? null };
    if (process.env.COVERAGE_FINAL_EVIDENCE_DIR) {
      const destination = join(process.env.COVERAGE_FINAL_EVIDENCE_DIR, mode);
      await mkdir(destination, { recursive: true });
      await cp(join(cwd, ".pi", "workflows", run.runId), join(destination, run.runId), { recursive: true });
      await writeFile(join(destination, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    }
    const passed = positives.includes(mode);
    assert.equal(direct.status, passed ? "passed" : "failed", "independent renderer");
    if (passed) {
      assert.equal(result?.status, "passed"); assert.equal(result.verdict, expectedVerdict);
      assert.equal(current.tasks.length, 9);
      assert.equal(current.tasks.filter(task => task.status === "completed").length, 9);
    }
    else { assert.notEqual(result?.status, "passed"); assert.equal(direct.verdict, "INCONCLUSIVE"); }
    if (!mode.startsWith("saved-") && !["source-stale", "candidate-stale"].includes(mode)) assert.equal(pristine.evidenceGate.complete, passed);
  } finally { h.setSubagentApiForTests(undefined); await rm(cwd, { recursive: true, force: true }); }
});
