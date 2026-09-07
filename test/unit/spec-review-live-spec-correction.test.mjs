import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import partition from "../../workflows/spec-review/helpers/spec-review-pipeline.mjs";
import render from "../../workflows/spec-review/helpers/render-spec-review-report.mjs";
import { validateJsonSchema } from "../../.tmp/unit/json-schema.js";

const limitation = {
  kind: "NONBLOCKING",
  text: "Tests were inspected but not executed by this read-only stage.",
  blocking: false,
};
const citation = {
  file: "SPEC.md",
  lineStart: 1,
  lineEnd: 1,
  quote: "The account lookup returns null for a missing account.",
};
const implementationCitation = {
  file: "account.js",
  lineStart: 2,
  lineEnd: 2,
  quote: "return accounts.find(account => account.id === id) ?? null;",
};

async function save(cwd, runId, taskId, file, value) {
  const dir = join(cwd, ".pi", "workflows", runId, "tasks", taskId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), JSON.stringify(value));
}

async function positiveChain(cwd) {
  const runId = "scope-limit-chain";
  const source = (stage, taskId) => ({
    source: stage,
    stageId: stage,
    specId: `${stage}.main`,
    taskId,
    status: "completed",
    artifacts: { control: { path: "control.json" } },
  });
  const upstream = [
    source("extract-spec", "extract-task"),
    source("map-implementation", "map-task"),
    source("inspect-tests", "inspect-task"),
  ];
  await writeFile(join(cwd, "SPEC.md"), `${citation.quote}\n`);
  await writeFile(join(cwd, "account.js"), `export function lookupAccount(accounts, id) {\n  ${implementationCitation.quote}\n}\n`);
  await save(cwd, runId, "extract-task", "control.json", {
    specSources: ["SPEC.md"],
    requirements: [{
      id: "REQ-001",
      requirement: citation.quote,
      specEvidence: citation,
      priority: "medium",
      implementationSignals: ["account lookup"],
      testSignals: ["missing account"],
    }],
  });
  await save(cwd, runId, "map-task", "control.json", { implementationMap: [] });
  await save(cwd, runId, "inspect-task", "control.json", {
    testMap: [],
    scopeLimitations: [limitation],
    testExecutionAttested: false,
  });
  const candidate = {
    schema: "stage-control-v1",
    digest: "candidate",
    candidateFindings: [],
    requirementCoverage: [{ requirementId: "REQ-001", status: "covered", evidence: [implementationCitation] }],
    needsHuman: [],
    noIssueNotes: [],
    scopeLimitations: [limitation],
    testExecutionAttested: false,
  };
  await save(cwd, runId, "candidate-task", "control.json", candidate);
  await save(cwd, runId, "candidate-task", "source-manifest.json", {
    schema: "workflow-source-manifest-v1",
    runId,
    taskId: "candidate-task",
    sources: upstream,
  });
  await save(cwd, runId, "partition-task", "source-manifest.json", {
    schema: "workflow-source-manifest-v1",
    runId,
    taskId: "partition-task",
    sources: [source("candidate-findings", "candidate-task")],
  });
  const statuses = [
    { ...source("candidate-findings", "candidate-task") },
    { ...source("partition-findings", "partition-task") },
  ];
  const p = await partition({
    sources: { "candidate-findings": candidate },
    context: { cwd, runId, sourceStatuses: statuses },
  });
  const report = {
    schema: "spec-review-report-v1",
    digest: "report",
    summary: "All extracted behavior is byte-grounded.",
    verdict: "CONFORMS",
    ownerLedger: [],
    ownerLedgerReconciliation: p.verifierCoverage.ownerLedgerReconciliation,
    risks: [],
    scopeLimitations: [limitation],
    testExecutionAttested: false,
    recommendedNextAction: "No action is required.",
  };
  const result = await render({
    sources: { "partition-findings": p, report },
    context: {
      cwd,
      runId,
      taskId: "final-task",
      sourceStatuses: [
        { ...source("partition-findings", "partition-task") },
        { ...source("report", "report-task") },
      ],
    },
  });
  return { p, report, result };
}

test("NONBLOCKING scope limits survive a positive zero-candidate chain", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "spec-live-limit-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { p, report, result } = await positiveChain(cwd);
  assert.deepEqual(p.scopeLimitations, [limitation]);
  assert.equal(p.testExecutionAttested, false);
  assert.equal(p.needsHuman.length, 0);
  assert.equal(result.status, "passed");
  assert.equal(result.verdict, "CONFORMS");
  assert.deepEqual(result.scopeLimitations, [limitation]);
  assert.equal(result.testExecutionAttested, false);
  assert.match(result.markdown, /Nonblocking scope limitations/);
  for (const [name, value] of [
    ["candidate-findings", {
      schema: "stage-control-v1", digest: "candidate", candidateFindings: [],
      requirementCoverage: [{ requirementId: "REQ-001", status: "covered", evidence: [implementationCitation] }],
      needsHuman: [], noIssueNotes: [], scopeLimitations: [limitation], testExecutionAttested: false,
    }],
    ["partition", p],
    ["report", report],
    ["render", result],
  ]) {
    const schema = JSON.parse(await readFile(new URL(`../../workflows/spec-review/schemas/spec-review-${name}-control.schema.json`, import.meta.url)));
    assert.deepEqual(validateJsonSchema(value, schema), { valid: true, issues: [] }, name);
  }
});

test("material missing verification remains NEEDS_HUMAN beside, not inside, scope limits", async () => {
  const p = await partition({
    sources: {
      "candidate-findings": {
        candidateFindings: [{ id: "finding-001", title: "Gap", claim: "A gap", severity: "low", requirementIds: ["REQ-001"] }],
        requirementCoverage: [],
        needsHuman: [],
        scopeLimitations: [limitation],
      },
    },
    context: { sourceStatuses: [] },
  });
  assert.deepEqual(p.scopeLimitations, [limitation]);
  assert.equal(p.needsHuman.some((row) => row.source === "missing-verification"), true);
  assert.equal(p.needsHuman.some((row) => row.source === "scope"), false);
});
