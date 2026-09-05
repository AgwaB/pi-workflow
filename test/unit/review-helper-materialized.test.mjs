import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as h from "./unit-test-support.mjs";
import { loadWorkflowSpec } from "../../.tmp/unit/schema.js";
import { validateJsonSchema } from "../../.tmp/unit/json-schema.js";

const evidenceRoot = process.env.REVIEW_HELPER_EVIDENCE_DIR;
const quote = "export const enabled = false;";
const citation = { file: "source.ts", lineStart: 1, lineEnd: 1, quote };
const candidate = { id: "finding-001", title: "Local gap", claim: "Gap", severity: "medium", requirementIds: ["REQ-1"], specEvidence: [], implementationEvidence: [], testEvidence: [], uncertainty: "Verify" };
const readControl = async (cwd, task) => JSON.parse(await readFile(join(dirname(join(cwd, task.files.result)), "control.json"), "utf8"));

async function withRun(bundlePath, name, fn) {
  const cwd = await mkdtemp(join(tmpdir(), "helper-materialized-"));
  let current;
  try {
    h.writeAgent(cwd, "scout", "read, grep, find, ls");
    await writeFile(join(cwd, "source.ts"), `${quote}\n`);
    const bundle = join(cwd, "workflows", "fixture");
    await mkdir(dirname(bundle), { recursive: true });
    await cp(resolve(bundlePath), bundle, { recursive: true });
    const specPath = join(bundle, "spec.json");
    const loaded = await loadWorkflowSpec(specPath, cwd);
    const compiled = await h.compileWorkflow(loaded.spec, { cwd, specPath, task: "Review the one local candidate with exact byte evidence." });
    assert.deepEqual(compiled.warnings, []);
    const { run } = await h.createWorkflowRunRecord(cwd, compiled, specPath);
    current = run;
    await h.writeStaticRunArtifacts(cwd, run, compiled, loaded.spec);
    await h.writeRunRecord(cwd, run);
    const launches = [];
    h.setSubagentApiForTests({
      async runSubagent(options) { launches.push(options); return { runId: `fake-${launches.length}`, attemptId: `attempt-${launches.length}`, status: "running" }; },
      async getSubagentStatus() { return null; }, async reconcileSubagentRun() { return {}; }, async interruptSubagent() { return {}; },
    });
    const step = async () => { await h.writeRunRecord(cwd, current); current = await h.scheduleRun(cwd, run.runId); return current; };
    const complete = async (task, control) => {
      assert.equal(task.status, "running", task.specId);
      const stage = loaded.spec.artifactGraph.stages.find(row => row.id === task.stageId);
      const schema = JSON.parse(await readFile(join(bundle, stage.output.controlSchema), "utf8"));
      assert.deepEqual(validateJsonSchema({ schema: "stage-control-v1", digest: "fixture", ...control }, schema), { valid: true, issues: [] }, task.specId);
      await h.completeTask(cwd, task, control);
    };
    await fn({ cwd, run, step, complete, launches });
    if (evidenceRoot) {
      const destination = join(evidenceRoot, name);
      await mkdir(destination, { recursive: true });
      await cp(join(cwd, ".pi", "workflows", run.runId), join(destination, run.runId), { recursive: true });
      await writeFile(join(destination, "summary.json"), JSON.stringify({ fixtureCwd: cwd, runId: run.runId, launches: launches.map(row => ({ agent: row.agent, model: row.model, tools: row.tools })), tasks: current.tasks.map(task => ({ specId: task.specId, taskId: task.taskId, status: task.status, foreachGenerated: task.foreachGenerated })) }, null, 2));
    }
  } finally { h.setSubagentApiForTests(undefined); await rm(cwd, { recursive: true, force: true }); }
}

for (const mode of ["grounded", "drop-grounded", "legacy", "drop-unverified", "missing-file", "report-absent", "mapping-missing"]) {
  test(`actual spec-review scheduler/partition/renderer: ${mode}`, () => withRun("workflows/spec-review", `spec-${mode}`, async ({ cwd, step, complete, launches }) => {
    let current = await step();
    await complete(h.taskBySpec(current, "extract-spec.main"), { requirements: [{ id: "REQ-1", requirement: "Enabled", specEvidence: "source.ts:1" }] });
    await complete(h.taskBySpec(current, "map-implementation.main"), { implementationMap: [{ file: "source.ts", evidence: quote }] });
    if (mode === "mapping-missing") await h.completeTask(cwd, h.taskBySpec(current, "inspect-tests.main"), {}, "failed");
    else await complete(h.taskBySpec(current, "inspect-tests.main"), { testMap: [] });
    current = await step();
    await complete(h.taskBySpec(current, "candidate-findings.main"), { candidateFindings: [candidate], requirementCoverage: [{ requirementId: "REQ-1", status: mode === "drop-grounded" ? "covered" : "gap", ...(mode === "drop-grounded" ? { evidence: [citation] } : {}) }], needsHuman: [], noIssueNotes: [] });
    current = await step();
    const verifier = current.tasks.find(task => task.foreachGenerated?.placeholderSpecId === "verify-findings.item");
    assert.equal(verifier.foreachGenerated.itemIdentity, candidate.id);
    const grounded = ["grounded", "drop-grounded", "report-absent", "mapping-missing"].includes(mode);
    const drop = mode.startsWith("drop-");
    const passed = grounded && !["report-absent", "mapping-missing"].includes(mode);
    const evidence = grounded ? [citation] : mode === "missing-file" ? [{ ...citation, file: "missing.ts" }] : ["definitely-not-present.ts:999: Trust me"];
    await complete(verifier, { id: candidate.id, verdict: drop ? "DROP" : "KEEP", severity: "medium", evidence: drop ? [] : evidence, counterEvidence: drop ? evidence : [], finalClaim: "Gap", recommendedAction: "Inspect" });
    current = await step();
    const partitionTask = h.taskBySpec(current, "partition-findings.main");
    assert.equal(partitionTask.status, "completed", JSON.stringify(partitionTask));
    const p = await readControl(cwd, partitionTask);
    const owner = p.verifierCoverage.ownerLedger[0];
    assert.equal(owner.taskId, verifier.taskId);
    assert.equal(owner.specId, verifier.specId);
    assert.equal(owner.itemIdentity, candidate.id);
    assert.equal(p.verifierCoverage.ownerLedgerReconciliation.passed, true);
    assert.equal(p.evidenceGate.complete, grounded && mode !== "mapping-missing");
    assert.equal(p.finalFindings.length, grounded && !drop ? 1 : 0);
    assert.equal(p.droppedFindings.length, grounded && drop ? 1 : 0);
    if (mode === "report-absent") await h.completeTask(cwd, h.taskBySpec(current, "report.main"), {}, "failed");
    else await complete(h.taskBySpec(current, "report.main"), { schema: "spec-review-report-v1", summary: "Fixture review", verdict: mode === "mapping-missing" ? "INCONCLUSIVE" : grounded ? drop ? "CONFORMS" : "GAPS_FOUND" : "NEEDS_HUMAN", ownerLedger: p.verifierCoverage.ownerLedger, ownerLedgerReconciliation: p.verifierCoverage.ownerLedgerReconciliation, risks: [], recommendedNextAction: "Inspect" });
    current = await step();
    const final = h.taskBySpec(current, "final.main");
    assert.equal(final.status, passed ? "completed" : "failed", JSON.stringify(final));
    const result = await readControl(cwd, final);
    assert.equal(result.status, passed ? "passed" : "failed");
    assert.equal(result.gates.actionableEvidenceComplete, grounded && mode !== "mapping-missing");
    assert.equal(launches.length, 6);
    const sidecar = JSON.parse(await readFile(join(dirname(join(cwd, final.files.result)), "source-ledger.json"), "utf8"));
    assert.deepEqual(sidecar.partition.evidenceGate, p.evidenceGate);
  }));
}
for (const mode of ["grounded", "symlink", "identity-mismatch"]) {
  test(`actual scaffold scheduler/byte gate: ${mode}`, () => withRun("skills/workflow-guide/scaffolds/support-partition", `scaffold-${mode}`, async ({ cwd, step, complete }) => {
    let current = await step();
    const finding = { id: "CAND-1", title: "Local candidate", severity: "medium", locations: [{ file: "source.ts", line: 1, lineEnd: 1 }], evidenceQuotes: [quote], rationale: "Fixture", recommendedAction: "Inspect" };
    await complete(h.taskBySpec(current, "collect-candidates.main"), { candidates: [finding] });
    current = await step();
    const verifier = current.tasks.find(task => task.foreachGenerated?.placeholderSpecId === "verify-candidates.item");
    assert.equal(verifier.foreachGenerated.itemIdentity, "CAND-1");
    if (mode === "symlink") { await symlink(join(cwd, "source.ts"), join(cwd, "link.ts")); finding.locations[0].file = "link.ts"; }
    await complete(verifier, { candidateId: mode === "identity-mismatch" ? "OTHER" : "CAND-1", finding, verdict: "KEEP", evidenceQuotes: [], counterEvidence: [], recommendedAction: "Inspect" });
    current = await step();
    const p = await readControl(cwd, h.taskBySpec(current, "partition-verdicts.main"));
    const gated = await readControl(cwd, h.taskBySpec(current, "gate-evidence.main"));
    assert.equal(p.value.identityIntegrity.complete, mode !== "identity-mismatch");
    assert.equal(gated.value.evidenceGate.integrity, mode === "grounded" ? "complete" : "partial");
    assert.equal(gated.value.partitions.keep.length, mode === "grounded" ? 1 : 0);
    assert.equal(gated.value.partitions.needsHuman.length, mode === "grounded" ? 0 : 1);
  }));
}
