import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkRequiredArtifactReads } from "../../.tmp/unit/subagent-backend.js";
import { readWorkflowArtifact } from "../../.tmp/unit/workflow-artifact-tool.js";
import { validateJsonSchema } from "../../.tmp/unit/json-schema.js";
import renderImpactReport from "../../workflows/impact-review/helpers/render-impact-report.mjs";

const stages = [
  "change-scope", "implementation-map", "validation-map", "api-contract-impact",
  "state-data-impact", "validation-impact", "docs-release-impact",
  "security-performance-impact", "contract-consistency", "regression-risk",
  "ship-readiness", "impact-synthesis",
];
const fields = {
  "change-scope": ["changeInputs", "affectedFiles", "affectedComponents", "publicSurfaces", "assumptions", "outOfScope"],
  "implementation-map": ["components", "entryPoints", "dataFlows", "unknowns"],
  "validation-map": ["tests", "docs", "releaseArtifacts", "validationCommandsMentioned", "knownGaps"],
  "validation-impact": ["coveredAreas", "missingValidation", "recommendedCommands", "assumptions"],
  "api-contract-impact": ["impacts", "assumptions"],
  "state-data-impact": ["impacts", "assumptions"],
  "docs-release-impact": ["impacts", "assumptions"],
  "security-performance-impact": ["impacts", "assumptions"],
  "contract-consistency": ["issues", "confirmedConsistencies"],
  "regression-risk": ["risks", "riskReducers"],
  "ship-readiness": ["requiredBeforeShip", "niceToHave", "assumptions"],
  "impact-synthesis": ["blockingIssues", "nonBlockingIssues", "confirmedSafeAreas", "recommendedNextActions", "validationToRun", "needsHuman"],
};

function item(id, text, extra = {}) {
  return { id, text, ...extra };
}

function controls({ high = false, unknown = false, blocked = false } = {}) {
  const out = {};
  for (const stage of stages) {
    const value = { schema: "stage-control-v1", digest: `${stage}-digest` };
    for (const field of fields[stage]) value[field] = [];
    if (stage === "change-scope") value.changeSummary = "Review the supplied change.";
    if (stage === "validation-impact") value.coverageStatus = unknown ? "unknown" : "strong";
    if (["api-contract-impact", "state-data-impact", "docs-release-impact", "security-performance-impact"].includes(stage)) value.status = unknown ? "unknown" : "none";
    if (stage === "contract-consistency") value.status = unknown ? "unknown" : "pass";
    if (stage === "regression-risk") value.riskLevel = unknown ? "unknown" : high ? "high" : "low";
    if (stage === "ship-readiness") value.status = blocked ? "blocked" : unknown ? "unknown" : "ready";
    if (stage === "impact-synthesis") {
      Object.assign(value, {
        summary: "The reviewed change was assessed.",
        verdict: blocked ? "BLOCKED" : unknown ? "UNKNOWN" : "READY",
        riskLevel: unknown ? "unknown" : high ? "high" : "low",
      });
    }
    out[`impact-analysis.${stage}`] = value;
  }
  return out;
}

function contextFor(patch = {}) {
  return {
    sourceStatuses: stages.map((stage, index) => ({
      source: `impact-analysis.${stage}`,
      specId: `impact-analysis.${stage}.main`,
      stageId: stage,
      taskId: `task-${index + 1}`,
      status: "completed",
    })),
    ...patch,
  };
}

async function schemas() {
  const spec = JSON.parse(await readFile("workflows/impact-review/spec.json", "utf8"));
  const result = {};
  for (const stage of spec.artifactGraph.stages[0].stages) {
    if (stage.output?.controlSchema)
      result[stage.id] = JSON.parse(await readFile(join("workflows/impact-review", stage.output.controlSchema), "utf8"));
  }
  return result;
}

const clone = (value) => JSON.parse(JSON.stringify(value));
const sourceMap = (value) => value;

async function validSourceSet(source) {
  const all = await schemas();
  for (const [key, value] of Object.entries(source)) {
    const stage = key.replace("impact-analysis.", "");
    const checked = validateJsonSchema(value, all[stage]);
    assert.equal(checked.valid, true, `${stage}: ${JSON.stringify(checked.issues)}`);
  }
  return all;
}

test("fresh model controls validate without the redundant impact ledger and final ledger is canonical", async () => {
  const source = controls();
  const all = await validSourceSet(source);
  for (const stage of stages) {
    assert.equal(all[stage].required.includes("impactLedger"), false);
    assert.equal(Object.hasOwn(all[stage].properties, "impactLedger"), false);
  }
  const result = await renderImpactReport({ sources: source, context: contextFor() });
  assert.equal(result.status, "passed");
  assert.equal(result.ledgerCoverage.status, "complete");
  assert.ok(result.impactLedger.every((row) => row.provenance && row.contentHash.startsWith("sha256:")));
  assert.equal(validateJsonSchema(result, all.final).valid, true, JSON.stringify(validateJsonSchema(result, all.final).issues));
});

test("canonical observations use source-qualified identity, preserve duplicate producer labels, and ignore producer provenance", async () => {
  const source = controls();
  const impacts = source["impact-analysis.security-performance-impact"].impacts;
  impacts.push(item("SAME-LABEL", "first observation", { severity: "low", owner: "model-owner", sourceIds: ["forged-source"] }));
  impacts.push(item("SAME-LABEL", "second observation", { severity: "low", owner: "other-owner", sourceIds: ["also-forged"] }));
  const result = await renderImpactReport({ sources: source, context: contextFor() });
  assert.equal(result.status, "passed");
  const rows = result.impactLedger.filter((row) => row.provenance.field === "impacts" && row.provenance.stage === "security-performance-impact");
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].id, rows[1].id);
  assert.deepEqual(rows.map((row) => row.sourceIds), [["impact-analysis.security-performance-impact"], ["impact-analysis.security-performance-impact"]]);
  assert.ok(rows.every((row) => row.origin === "security-performance-impact"));
});

test("absent, renamed, or mutated advisory echoes cannot alter canonical original observations", async () => {
  const source = controls();
  source["impact-analysis.security-performance-impact"].impacts.push(item("ORIGINAL-RISK", "Canonical source risk", { severity: "high" }));
  const baseline = await renderImpactReport({ sources: source, context: contextFor() });
  const advisory = clone(source);
  advisory["impact-analysis.security-performance-impact"].impactLedger = [{ id: "fake", text: "mutated echo", severity: "none" }];
  advisory["impact-analysis.impact-synthesis"].impactLedger = [{ id: "fake", text: "hide it", severity: "none" }];
  const replay = await renderImpactReport({ sources: advisory, context: contextFor() });
  assert.deepEqual(replay.impactLedger, baseline.impactLedger);
  assert.equal(replay.riskLevel, baseline.riskLevel);
  assert.ok(replay.impactLedger.some((row) => row.text === "Canonical source risk"));
});

test("missing or forged source lifecycle metadata blocks the fresh twelve-source bundle", async () => {
  const missing = controls();
  delete missing["impact-analysis.validation-map"];
  const missingResult = await renderImpactReport({ sources: missing, context: contextFor() });
  assert.equal(missingResult.status, "blocked");
  const forged = contextFor();
  forged.sourceStatuses[0].source = "impact-analysis.validation-map";
  const forgedResult = await renderImpactReport({ sources: controls(), context: forged });
  assert.equal(forgedResult.status, "blocked");
  const legacy = contextFor();
  legacy.sourceStatuses = legacy.sourceStatuses.slice(0, 4);
  const legacyResult = await renderImpactReport({ sources: controls(), context: legacy });
  assert.equal(legacyResult.status, "blocked");
});

test("original high risk absent from synthesis cannot become a clean low result", async () => {
  const source = controls();
  source["impact-analysis.security-performance-impact"].impacts.push(item("HIGH-ORIGINAL", "Tenant isolation risk", { severity: "high" }));
  const result = await renderImpactReport({ sources: source, context: contextFor() });
  assert.equal(result.riskLevel, "high");
  assert.notEqual(result.status, "passed");
  assert.match(result.blockers.join("\n"), /canonical regression risk|risk floor/i);
});

test("unbound acceptance never hides a canonical high risk", async () => {
  for (const resolution of ["accepted", "resolved", "not-applicable"]) {
    const source = controls();
    source["impact-analysis.security-performance-impact"].impacts.push(item("ACCEPTED-HIGH", "High risk claimed accepted", {
      severity: "high", resolution, resolutionNote: "Business approved", owner: "claimed-owner",
      resolutionEvidence: [{ type: "approval", ref: "invented-approval" }],
    }));
    const result = await renderImpactReport({ sources: source, context: contextFor() });
    assert.equal(result.status, "blocked", resolution);
    assert.equal(result.riskLevel, "high", resolution);
    assert.match(result.markdown, /Needs human review/);
    assert.deepEqual(result.impactLedger.find((row) => row.text === "High risk claimed accepted").sourceIds, ["impact-analysis.security-performance-impact"]);
  }
});

test("omitted observation severity does not invent unknown risk for a known blocked change", async () => {
  const source = controls({ blocked: true, high: true });
  source["impact-analysis.validation-map"].knownGaps.push("Cross-tenant regression is absent.");
  source["impact-analysis.validation-impact"].missingValidation.push({ id: "MISSING-TEST", text: "Add cross-tenant coverage." });
  const result = await renderImpactReport({ sources: source, context: contextFor() });
  assert.equal(result.status, "passed");
  assert.equal(result.verdict, "BLOCKED");
  assert.equal(result.riskLevel, "high");
  assert.equal(result.impactLedger.find(row => row.text === "Add cross-tenant coverage.").severity, "none");
});

test("source-level risk is not lost when observation severity is absent", async () => {
  const source = controls();
  source["impact-analysis.security-performance-impact"].status = "high";
  source["impact-analysis.security-performance-impact"].impacts.push({ id: "RISK", text: "Tenant scope is lost." });
  const result = await renderImpactReport({ sources: source, context: contextFor() });
  assert.equal(result.riskLevel, "high");
  assert.notEqual(result.status, "passed");
  assert.notEqual(result.verdict, "READY");
});

test("known blockers survive an unrelated unverified resolution claim", async () => {
  const source = controls({ blocked: true, high: true });
  source["impact-analysis.security-performance-impact"].impacts.push({ id: "RISK", text: "Unverified resolution.", severity: "high", resolution: "accepted" });
  const result = await renderImpactReport({ sources: source, context: contextFor() });
  assert.equal(result.status, "blocked");
  assert.equal(result.verdict, "BLOCKED");
  assert.equal(result.riskLevel, "high");
});

test("known blocker and informational unknown survive together without forcing every high risk to block", async () => {
  const source = controls({ high: true });
  source["impact-analysis.impact-synthesis"].blockingIssues.push(item("KNOWN-BLOCKER", "Known contract blocker", { severity: "high" }));
  source["impact-analysis.impact-synthesis"].needsHuman.push(item("CALLER-NOTE", "Readonly unknown caller note", { severity: "unknown" }));
  // The informational limit is retained, while the actual model BLOCKED judgment remains authoritative.
  source["impact-analysis.impact-synthesis"].verdict = "BLOCKED";
  const result = await renderImpactReport({ sources: source, context: contextFor() });
  assert.equal(result.verdict, "BLOCKED");
  assert.equal(result.riskLevel, "high");
  assert.ok(result.impactLedger.some((row) => row.text === "Readonly unknown caller note"));
});

test("known negative conclusions retain their risk floor alongside unquantified observations", async () => {
  const all = await schemas();
  for (const verdict of ["BLOCKED", "NEEDS_WORK"]) {
    const source = controls({ high: true });
    source["impact-analysis.ship-readiness"].status = verdict === "BLOCKED" ? "blocked" : "needs-work";
    source["impact-analysis.impact-synthesis"].verdict = verdict;
    source["impact-analysis.security-performance-impact"].impacts.push(item("KNOWN-HIGH", "Tenant isolation risk.", { severity: "high" }));
    source["impact-analysis.state-data-impact"].impacts.push(item("UNKNOWN-MIGRATION", "Migration behavior cannot be established from the supplied scope.", { severity: "unknown", scope: "unknown" }));
    const result = await renderImpactReport({ sources: source, context: contextFor() });
    assert.equal(result.status, "passed");
    assert.equal(result.verdict, verdict);
    assert.equal(result.riskLevel, "high");
    assert.equal(result.riskUncertainty.present, true);
    assert.equal(result.riskUncertainty.knownFloor, "high");
    assert.equal(result.riskUncertainty.observationIds.length, 1);
    assert.match(result.completionSummaryMarkdown, /unquantified/);
    assert.equal(validateJsonSchema(result, all.final).valid, true);
  }
});

test("unquantified observations cannot authorize READY or hide an understated known floor", async () => {
  const source = controls();
  source["impact-analysis.state-data-impact"].impacts.push(item("UNKNOWN", "Migration scope unavailable.", { severity: "unknown" }));
  const unknown = await renderImpactReport({ sources: source, context: contextFor() });
  assert.equal(unknown.status, "failed");
  assert.equal(unknown.verdict, "UNKNOWN");
  assert.equal(unknown.riskUncertainty.present, true);
  source["impact-analysis.security-performance-impact"].impacts.push(item("HIGH", "Tenant isolation risk.", { severity: "high" }));
  const understated = await renderImpactReport({ sources: source, context: contextFor() });
  assert.equal(understated.status, "failed");
  assert.equal(understated.verdict, "UNKNOWN");
  assert.equal(understated.riskUncertainty.knownFloor, "high");
  assert.equal(understated.gates.riskFloorConsistent, false);
});

test("material unknown scope remains visible and conservative rather than being dropped", async () => {
  const source = controls({ unknown: true });
  source["impact-analysis.validation-impact"].missingValidation.push(item("REQUIRED-UNKNOWN", "Required validation scope unavailable", { severity: "unknown", scope: "unknown" }));
  const result = await renderImpactReport({ sources: source, context: contextFor() });
  assert.equal(result.riskLevel, "unknown");
  assert.notEqual(result.status, "passed");
  assert.ok(result.impactLedger.some((row) => row.text === "Required validation scope unavailable"));
});

test("all action arrays and citations render escaped, with required-before-ship in both reports", async () => {
  const source = controls();
  source["impact-analysis.ship-readiness"].requiredBeforeShip.push(item("SHIP-CMD", "Run <security>& verify `tenant`", { command: "npm test" }));
  source["impact-analysis.ship-readiness"].status = "needs-work";
  source["impact-analysis.impact-synthesis"].verdict = "NEEDS_WORK";
  source["impact-analysis.validation-impact"].recommendedCommands.push(item("VALIDATE-CMD", "npm run check", { command: "npm run check" }));
  const result = await renderImpactReport({ sources: source, context: contextFor() });
  assert.equal(result.status, "passed");
  assert.match(result.completionSummaryMarkdown, /SHIP-CMD|Run/);
  assert.match(result.markdown, /SHIP-CMD|Run/);
  assert.doesNotMatch(result.markdown, /<security>/);
  assert.ok(result.impactLedger.some((row) => row.id.endsWith(":SHIP-CMD")));
});

test("business BLOCKED is a rendered negative analysis, distinct from control-integrity blocking", async () => {
  const source = controls({ blocked: true, high: true });
  source["impact-analysis.impact-synthesis"].blockingIssues.push(item("BUSINESS-BLOCK", "Ship is blocked by the tenant contract", { severity: "high" }));
  const result = await renderImpactReport({ sources: source, context: contextFor() });
  assert.equal(result.status, "passed");
  assert.equal(result.verdict, "BLOCKED");
  assert.equal(result.gates.sourceCoverageComplete, true);
});

test("source reorder is deterministic and sidecar retains all original controls", async () => {
  const source = controls();
  source["impact-analysis.change-scope"].affectedFiles.push(item("FILE-1", "src/cache.ts"));
  const first = await renderImpactReport({ sources: source, context: contextFor() });
  const reordered = Object.fromEntries(Object.entries(source).reverse());
  const second = await renderImpactReport({ sources: reordered, context: contextFor() });
  assert.equal(first.digest, second.digest);
  const cwd = await mkdtemp(join(tmpdir(), "impact-sidecar-"));
  const sidecar = await renderImpactReport({ sources: source, context: { ...contextFor(), cwd, runId: "run", taskId: "final" } });
  assert.equal(sidecar.gates.sidecarPublished, true);
  const ledger = JSON.parse(await readFile(join(cwd, ".pi", "workflows", "run", "tasks", "final", "source-ledger.json"), "utf8"));
  assert.equal(ledger.sourceControls["change-scope"].affectedFiles[0].id, "FILE-1");
  assert.match(sidecar.blockers.join("\n"), /does not attest source bytes|control values/);
  await rm(cwd, { recursive: true, force: true });
});

test("required projected reads distinguish default truncation from explicit capacity", async () => {
  const root = await mkdtemp(join(tmpdir(), "impact-projection-"));
  const artifact = join(root, "control.json");
  await writeFile(artifact, JSON.stringify({ schema: "stage-control-v1", payload: "x".repeat(60000) }));
  const manifest = {
    schema: "workflow-source-manifest-v1", runId: "projection-run", taskId: "consumer",
    sources: [{ source: "impact-analysis.change-scope", taskId: "producer", stageId: "change-scope", specId: "impact-analysis.change-scope.main", artifacts: { control: { path: artifact } } }],
  };
  const defaultRead = await readWorkflowArtifact(manifest, manifest.sources[0].source, "control", { runDir: root, path: "$" });
  assert.equal(defaultRead.truncated, true);
  const explicitRead = await readWorkflowArtifact(manifest, manifest.sources[0].source, "control", { runDir: root, path: "$", maxChars: defaultRead.projection.originalChars + 1 });
  assert.equal(explicitRead.truncated, false);
  const readDir = join(root, "reads");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(readDir));
  await writeFile(join(readDir, "read-ledger.jsonl"), `${JSON.stringify({ schema: "workflow-artifact-read-v1", runId: manifest.runId, taskId: manifest.taskId, source: manifest.sources[0].source, artifact: "control", at: new Date().toISOString(), bytes: explicitRead.bytes, returnedBytes: explicitRead.returnedBytes, truncated: explicitRead.truncated, path: "$", maxChars: explicitRead.projection.maxChars })}\n`);
  assert.deepEqual(await checkRequiredArtifactReads(readDir, [{ source: manifest.sources[0].source, artifact: "control", path: "$" }], [{ source: manifest.sources[0].source, artifact: "control", path: "$", mustNotTruncate: true }]), { missing: [], projectionFailures: [] });
  await rm(root, { recursive: true, force: true });
});

test("sidecar failure is visible and cannot claim passed", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "impact-sidecar-fail-"));
  const runDir = join(cwd, ".pi", "workflows", "run", "tasks");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(runDir, { recursive: true }));
  await writeFile(join(runDir, "task"), "not a directory");
  const result = await renderImpactReport({ sources: controls(), context: { ...contextFor(), cwd, runId: "run", taskId: "task" } });
  assert.equal(result.status, "failed");
  assert.equal(result.gates.sidecarPublished, false);
  assert.match(result.sidecarError, /Sidecar publication failed/);
  await rm(cwd, { recursive: true, force: true });
});
