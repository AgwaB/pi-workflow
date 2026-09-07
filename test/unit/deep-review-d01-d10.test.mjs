import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { validateJsonSchema } from "../../.tmp/unit/json-schema.js";

const workflowRoot = join(process.cwd(), "workflows", "deep-review");
const pipeline = (
  await import(
    pathToFileURL(join(workflowRoot, "helpers/finding-pipeline.mjs")).href
  )
).default;
const render = (
  await import(
    pathToFileURL(join(workflowRoot, "helpers/render-review-report.mjs")).href
  )
).default;
const verifierSchema = JSON.parse(
  readFileSync(
    join(
      workflowRoot,
      "schemas/deep-review-devil-advocate-control.schema.json",
    ),
    "utf8",
  ),
);
const renderSchema = JSON.parse(
  readFileSync(
    join(workflowRoot, "schemas/deep-review-render-control.schema.json"),
    "utf8",
  ),
);

const status = (stage, id, task = `${stage}-${id}`) => ({
  source: `${stage}.${id}`,
  specId: `${stage}.${id}`,
  taskId: task,
  stageId: stage,
  itemIdentity: id,
  placeholderSpecId: `${stage}.item`,
  status: "completed",
});
const finding = (id, title, line, extra = {}) => ({
  findingId: id,
  rootCauseId: `rc-${id}`,
  title,
  severity: "high",
  file: "src/review.ts",
  locations: [{ file: "src/review.ts", line }],
  evidence: `Observed ${id}`,
  evidenceQuotes: [`line-${id}`],
  rationale: `Rationale ${id}`,
  recommendedAction: `Action ${id}`,
  confidence: "high",
  ...extra,
});
const reviewerSources = (findings, lens = "runtime", sourceCoverage) => ({
  triage: {
    reviewLenses: [
      {
        id: lens,
        ...(sourceCoverage ? { evidenceToInspect: [sourceCoverage.path] } : {}),
      },
    ],
  },
  [`reviewers.${lens}`]: {
    lens,
    findings,
    evidenceChecked: sourceCoverage ? [sourceCoverage.path] : ["src/review.ts"],
    sourceCoverage: sourceCoverage ? [sourceCoverage] : [],
    noIssueNotes: findings.length ? [] : ["No issues in this lens."],
  },
});
const verifier = (
  id,
  title,
  verdict = "KEEP",
  evidence = [{ file: "src/review.ts", line: 1, quote: "line-" + id }],
  extra = {},
) => ({
  findingId: id,
  finding: title,
  verdict,
  evidence,
  counterEvidence: [],
  recommendedAction: `Action ${id}`,
  ...extra,
});

async function dedup(findings, options = {}, sourceCoverage, cwd) {
  const lens = "runtime";
  return pipeline({
    sources: reviewerSources(findings, lens, sourceCoverage),
    context: { cwd, sourceStatuses: [status("reviewers", lens)] },
    options: { mode: "dedup", ...options },
  });
}
async function partition(dedupResult, verdicts, context = {}) {
  const sources = { "dedup-findings.main": dedupResult };
  for (const row of verdicts) sources[`devil-advocate.${row.findingId}`] = row;
  return pipeline({
    sources,
    context: {
      ...context,
      sourceStatuses: [
        status("reviewers", "runtime"),
        ...verdicts.map((row) => status("devil-advocate", row.findingId)),
        ...(context.sourceStatuses ?? []),
      ],
    },
    options: { mode: "partition", dedupStage: "dedup-findings" },
  });
}

test("D01 preserves distinct defects sharing a statement through verifier partition", async () => {
  const rows = [
    finding("sql", "SQL injection", 1, { evidenceQuotes: ["line-shared"] }),
    finding("tenant", "Missing tenant predicate", 1, {
      evidenceQuotes: ["line-shared"],
    }),
  ];
  const d = await dedup(rows);
  assert.equal(d.findings.length, 2);
  const p = await partition(
    d,
    rows.map((row) =>
      verifier(row.findingId, row.title, "KEEP", ["line-shared"]),
    ),
  );
  assert.deepEqual(
    p.partitions.keep.map((row) => row.findingId),
    ["sql", "tenant"],
  );
  assert.equal(p.partitionSummary.mergedFindings, 0);
});

test("D01 requires validated same-defect payload identity, not shared title, quote, or guessed root", async () => {
  const conflictingRoots = await dedup([
    finding("runtime", "Same title", 1, {
      rootCauseId: "runtime-root",
      evidenceQuotes: ["same source quote"],
    }),
    finding("security", "Same title", 1, {
      rootCauseId: "security-root",
      evidenceQuotes: ["same source quote"],
    }),
  ]);
  assert.equal(conflictingRoots.findings.length, 2);
  const conflictingPayload = await dedup([
    finding("first", "Same title", 1, {
      rootCauseId: "guessed-root",
      evidenceQuotes: ["same source quote"],
      supportingFindingId: "first-support-target",
    }),
    finding("second", "Same title", 1, {
      rootCauseId: "guessed-root",
      evidenceQuotes: ["same source quote"],
    }),
  ]);
  assert.equal(conflictingPayload.findings.length, 2);
  const genuineDuplicate = await dedup([
    finding("original", "Same title", 1, {
      rootCauseId: "validated-root",
      evidenceQuotes: ["same source quote"],
      claim: "same causal claim",
      rationale: "same rationale",
      recommendedAction: "same action",
    }),
    finding("duplicate", "Same title", 1, {
      rootCauseId: "validated-root",
      evidenceQuotes: ["same source quote"],
      claim: "same causal claim",
      rationale: "same rationale",
      recommendedAction: "same action",
    }),
  ]);
  assert.equal(genuineDuplicate.findings.length, 1);
  assert.equal(genuineDuplicate.dedupSummary.duplicateCount, 1);
});

test("D02 requires an explicit support target even when a root has an explicit root cause id", async () => {
  const root = finding("root", "Authorization bypass", 1, {
    rootCauseId: "authorization-root",
    evidenceQuotes: ["line-root"],
  });
  const support = finding("support", "Unrelated timeout test", 2, {
    classification: "support-only",
    file: "test/review.test.ts",
    locations: [{ file: "test/review.test.ts", line: 2 }],
    evidenceQuotes: ["line-support"],
  });
  const d = await dedup([root, support]);
  const p = await partition(d, [
    verifier("root", root.title, "KEEP", ["line-root"]),
    verifier("support", support.title),
  ]);
  assert.equal(p.supportNotes.length, 0);
  assert.equal(
    p.partitions.needsHuman.some((row) => row.findingId === "support"),
    true,
  );
  assert.equal(
    p.partitions.needsHuman.find((row) => row.findingId === "support")
      .supportingFindingId,
    undefined,
  );
});

test("D03 gates duplicate pairs and accepts a legitimate second-pass root reparent", async () => {
  const d = await dedup([
    finding("root-a", "Shared root", 1, {
      rootCauseId: "shared-root",
      evidenceQuotes: ["line-a"],
    }),
    finding("root-b", "Shared root", 20, {
      rootCauseId: "shared-root",
      evidenceQuotes: ["line-b"],
    }),
    finding("duplicate-b", "Shared root", 20, {
      rootCauseId: "shared-root",
      evidenceQuotes: ["line-b"],
    }),
  ]);
  assert.equal(d.dedupSummary.duplicateCount, 1);
  const p = await partition(d, [
    verifier("root-a", "Shared root", "KEEP", ["line-a"]),
    verifier("root-b", "Shared root", "KEEP", ["line-b"]),
  ]);
  const r = await render({
    sources: {
      "partition-verdicts.main": p,
      report: {
        summary: "Work remains",
        verdict: "NEEDS_WORK",
        risks: [],
        recommendedNextAction: "Fix it",
      },
    },
  });
  assert.equal(r.gates.duplicateLedgerPairsMismatch, false);
  assert.equal(r.gates.duplicateLedgerReconciled, true);
  assert.equal(r.gates.passed, true);
  const tampered = structuredClone(p);
  tampered.dedupSummary.duplicates[0].keptFindingId = "not-a-dedup-survivor";
  const rejected = await render({
    sources: {
      "partition-verdicts.main": tampered,
      report: {
        summary: "Work remains",
        verdict: "NEEDS_WORK",
        risks: [],
        recommendedNextAction: "Fix it",
      },
    },
  });
  assert.equal(rejected.gates.duplicateLedgerPairsMismatch, true);
  assert.equal(rejected.status, "failed");
});

test("D04 rejects normalized whitespace, CRLF substitution, invalid UTF-8, and out-of-bounds ranges", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "deep-review-d04-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, "src"), { recursive: true });
  const crlf = "  const danger = true;  \r\nconst safe = true;\r\n";
  writeFileSync(join(cwd, "src/review.ts"), crlf);
  const goodCoverage = {
    path: "src/review.ts:1-2",
    status: "read",
    evidence: "  const danger = true;  \r\nconst safe = true;",
    artifact: "",
    reason: "",
  };
  const good = await dedup([], {}, goodCoverage, cwd);
  assert.equal(good.sourceStatusSummary.nonCompleted, 0);
  const lf = await dedup(
    [],
    {},
    {
      ...goodCoverage,
      evidence: "  const danger = true;  \nconst safe = true;",
    },
    cwd,
  );
  assert.equal(lf.sourceStatusSummary.nonCompleted, 1);
  const pastEof = await dedup(
    [],
    {},
    { ...goodCoverage, path: "src/review.ts:1-99" },
    cwd,
  );
  assert.equal(pastEof.sourceStatusSummary.nonCompleted, 1);
  writeFileSync(
    join(cwd, "src/binary.ts"),
    Buffer.from([0x63, 0x6f, 0x6e, 0x73, 0x74, 0xff, 0x3b]),
  );
  const invalid = await dedup(
    [],
    {},
    {
      path: "src/binary.ts",
      status: "read",
      evidence: "const �;",
      artifact: "",
      reason: "",
    },
    cwd,
  );
  assert.equal(invalid.sourceStatusSummary.nonCompleted, 1);
  const f = finding("exact", "Exact bytes", 1, {
    evidenceQuotes: ["  const danger = true;  "],
  });
  const d = await dedup([f], {}, undefined, cwd);
  const exact = await partition(
    d,
    [
      verifier("exact", f.title, "KEEP", [
        { file: "src/review.ts", line: 1, quote: "  const danger = true;  " },
      ]),
    ],
    { cwd, sourceStatuses: [] },
  );
  assert.equal(exact.partitions.keep.length, 1);
  const trimmed = await partition(
    d,
    [
      verifier("exact", f.title, "KEEP", [
        { file: "src/review.ts", line: 1, quote: "   const danger = true;   " },
      ]),
    ],
    { cwd, sourceStatuses: [] },
  );
  assert.equal(
    trimmed.partitions.needsHuman.some((row) => row.findingId === "exact"),
    true,
  );
});

test("D05 keeps repeated LF bytes in rendered evidence quotes", async () => {
  const quote = "const first = 1;\n\n\nconst last = 2;";
  const d = await dedup([
    finding("blank", "Blank lines", 1, {
      locations: [{ file: "src/review.ts", line: 1, lineEnd: 4 }],
      evidenceQuotes: [quote],
    }),
  ]);
  const p = await partition(d, [
    verifier("blank", "Blank lines", "KEEP", [quote]),
  ]);
  const r = await render({
    sources: {
      "partition-verdicts.main": p,
      report: {
        summary: "Work",
        verdict: "NEEDS_WORK",
        risks: [],
        recommendedNextAction: "Fix",
      },
    },
  });
  assert.equal(r.markdown.includes(quote), true);
});

test("D06 accepts only honest empty-evidence NEEDS_HUMAN controls", () => {
  const base = {
    schema: "stage-control-v1",
    digest: "d",
    findingId: "f",
    finding: "Finding",
    verdict: "NEEDS_HUMAN",
    evidence: [],
    counterEvidence: [],
    recommendedAction: "Inspect",
    evidenceUnavailableReason: "Source was inaccessible.",
  };
  assert.equal(validateJsonSchema(base, verifierSchema).valid, true);
  assert.equal(
    validateJsonSchema(
      { ...base, evidenceUnavailableReason: undefined },
      verifierSchema,
    ).valid,
    false,
  );
  assert.equal(
    validateJsonSchema({ ...base, verdict: "KEEP" }, verifierSchema).valid,
    false,
  );
});

test("D06 keeps unavailable verifier evidence separate from reviewer/source evidence", async () => {
  const sourceFinding = finding("human", "Needs human evidence", 1, {
    rootCauseId: "human-root",
    evidenceQuotes: ["reviewer source quote"],
  });
  const d = await dedup([sourceFinding]);
  const p = await partition(d, [
    verifier("human", sourceFinding.title, "NEEDS_HUMAN", [], {
      evidenceUnavailableReason: "Verifier could not read the source snapshot.",
    }),
  ]);
  const r = await render({
    sources: {
      "partition-verdicts.main": p,
      report: {
        summary: "Needs human",
        verdict: "NEEDS_WORK",
        risks: [],
        recommendedNextAction: "Inspect",
      },
    },
  });
  assert.equal(r.status, "passed");
  assert.equal(validateJsonSchema(r, renderSchema).valid, true);
  assert.equal(r.verdict, "NEEDS_WORK");
  assert.equal(r.gates.needsHumanEvidenceIncomplete, true);
  assert.equal(r.gates.needsHumanEvidenceUnavailable, true);
  assert.equal(r.needsHumanSummary.verifierEvidenceIncomplete, 1);
  assert.equal(r.needsHumanSummary.verifierEvidenceUnavailable, 1);
  assert.match(r.markdown, /Reviewer\/source evidence:/u);
  assert.match(r.markdown, /Verifier evidence: unavailable\./u);
  assert.match(r.markdown, /Verifier could not read the source snapshot\./u);
  assert.match(r.completionSummaryMarkdown, /lacks verifier evidence/u);
  assert.deepEqual(p.partitions.needsHuman[0].verifierEvidence, []);
});

test("D07 preserves escaped synthesis risks/actions and finding rationale", async () => {
  const f = finding("narrative", "Narrative finding", 1, {
    evidenceQuotes: ["line-narrative"],
  });
  const d = await dedup([f]);
  const p = await partition(d, [
    verifier("narrative", f.title, "KEEP", ["line-narrative"]),
  ]);
  const r = await render({
    sources: {
      "partition-verdicts.main": p,
      report: {
        summary: "SYNTHESIS_SENTINEL",
        verdict: "NEEDS_WORK",
        risks: ["RISK_SENTINEL"],
        recommendedNextAction: "ACTION_SENTINEL",
      },
    },
  });
  assert.match(r.markdown, /SYNTHESIS\\_SENTINEL/u);
  assert.match(r.markdown, /RISK\\_SENTINEL/u);
  assert.match(r.markdown, /ACTION\\_SENTINEL/u);
  assert.match(r.markdown, /Rationale:\n\nRationale narrative/u);
  assert.match(r.markdown, /Recommended action:\n\nAction narrative/u);
});

test("D08 escapes source-gap output while evidence remains fenced", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "deep-review-d08-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src/review.ts"), "const x = true;\n");
  const html = '<img src="https://invalid.example/pixel">';
  const d = await dedup(
    [],
    {},
    {
      path: "src/review.ts",
      status: "unreadable",
      evidence: "",
      artifact: "",
      reason: html,
    },
    cwd,
  );
  const p = await partition(d, []);
  const r = await render({
    sources: {
      "partition-verdicts.main": p,
      report: {
        summary: "Partial",
        verdict: "PARTIAL_REVIEW",
        risks: [],
        recommendedNextAction: "Retry",
      },
    },
  });
  assert.equal(r.markdown.includes(html), false);
  assert.equal(r.markdown.includes("&lt;img"), true);
});

test("D09 exposes requested sidecar write failure", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "deep-review-d09-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, ".pi"), "not a directory");
  const d = await dedup([], {}, undefined, cwd);
  const p = await partition(d, []);
  const r = await render({
    sources: {
      "partition-verdicts.main": p,
      report: {
        summary: "Clean",
        verdict: "REVIEW_COMPLETE",
        risks: [],
        recommendedNextAction: "None",
      },
    },
    context: { cwd, runId: "run", taskId: "task" },
  });
  assert.equal(r.gates.sidecarWriteFailed, true);
  assert.equal(typeof r.sidecarError, "string");
  assert.equal(r.status, "failed");
});

test("D10 states the reviewed-snapshot limitation instead of current-tree assurance", async () => {
  const d = await dedup([]);
  const p = await partition(d, []);
  const r = await render({
    sources: {
      "partition-verdicts.main": p,
      report: {
        summary: "Clean",
        verdict: "REVIEW_COMPLETE",
        risks: [],
        recommendedNextAction: "None",
      },
    },
  });
  assert.match(r.markdown, /reviewed snapshot/u);
  assert.match(r.markdown, /does not attest current-tree bytes/u);
  assert.equal(r.gates.reviewedSnapshotOnly, true);
  assert.equal(r.gates.currentTreeBytesAttested, false);
});
