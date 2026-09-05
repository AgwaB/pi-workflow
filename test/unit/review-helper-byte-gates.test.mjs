import assert from "node:assert/strict";
import test, { mock } from "node:test";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { readLocalText as readScaffold } from "../../skills/workflow-guide/scaffolds/support-partition/helpers/local-evidence-reader.mjs";
import { readLocalText as readSpec } from "../../workflows/spec-review/helpers/local-evidence-reader.mjs";
import { validateJsonSchema } from "../../.tmp/unit/json-schema.js";
import { readFile } from "node:fs/promises";
import { mkdtemp, mkdir, writeFile, symlink, rm, open } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import scaffoldGate from "../../skills/workflow-guide/scaffolds/support-partition/helpers/evidence-gate.mjs";
import partition from "../../workflows/spec-review/helpers/spec-review-pipeline.mjs";
import render from "../../workflows/spec-review/helpers/render-spec-review-report.mjs";

export const citation = { file: "source.ts", lineStart: 1, lineEnd: 1, quote: "export const enabled = false;" };
export const candidate = { id: "finding-001", title: "Local gap", claim: "A gap exists", severity: "medium", requirementIds: ["REQ-1"], specEvidence: [], implementationEvidence: [], testEvidence: [], uncertainty: "Verify" };
export const candidates = { schema: "stage-control-v1", digest: "candidate", candidateFindings: [candidate], requirementCoverage: [{ requirementId: "REQ-1", status: "gap" }], needsHuman: [], noIssueNotes: [] };
const owner = { source: "verify-findings", stageId: "verify-findings", specId: "verify-findings.finding-001", taskId: "task-verifier", itemIdentity: candidate.id, placeholderSpecId: "verify-findings.item", status: "completed" };
const statuses = [{ source: "candidate-findings", stageId: "candidate-findings", specId: "candidate-findings.main", taskId: "task-candidate", status: "completed" }, owner];
export const verifierControl = (evidence, verdict = "KEEP", counterEvidence = []) => ({ schema: "stage-control-v1", digest: "verify", id: candidate.id, verdict, severity: "medium", evidence, counterEvidence, finalClaim: "A gap exists", recommendedAction: "Inspect" });
export const reportControl = (p) => ({ schema: "spec-review-report-v1", digest: "report", summary: "Fixture review", verdict: p.finalFindings.length ? "GAPS_FOUND" : p.needsHuman.length ? "NEEDS_HUMAN" : "CONFORMS", risks: [], recommendedNextAction: "Inspect", ownerLedger: p.verifierCoverage.ownerLedger, ownerLedgerReconciliation: p.verifierCoverage.ownerLedgerReconciliation });
export async function roundtrip(cwd, evidence, verdict = "KEEP", counterEvidence = [], analysis = candidates) {
  const p = await partition({ sources: { "candidate-findings": analysis, "verify-findings": verifierControl(evidence, verdict, counterEvidence) }, context: { cwd, sourceStatuses: statuses } });
  const result = await render({ sources: { "partition-findings": p, report: reportControl(p) }, context: { cwd, sourceStatuses: ["partition-findings", "report"].map(source => ({ source, stageId: source, specId: `${source}.main`, taskId: `task-${source}`, status: "completed" })) } });
  return { p, result };
}
async function fixture(fn) {
  const cwd = await mkdtemp(join(tmpdir(), "review-byte-gate-"));
  try { await writeFile(join(cwd, "source.ts"), `${citation.quote}\n`); await fn(cwd); }
  finally { await rm(cwd, { recursive: true, force: true }); }
}
async function scaffold(cwd, file = "source.ts", quote = citation.quote) {
  return scaffoldGate({ context: { cwd }, sources: { "partition-verdicts": { value: {
    partitions: { keep: [{ findingId: "A", locations: [{ file, line: 1, lineEnd: 1 }], evidenceQuotes: [quote] }], weaken: [], drop: [], needsHuman: [] },
    partitionSummary: { candidates: 1, verdictsReceived: 1, integrity: "complete" },
    identityIntegrity: { plannedIds: ["A"], verifiedIds: ["A"], complete: true, issues: [] }
  } } } });
}
for (const kind of ["leaf-symlink", "ancestor-symlink", "oversize", "fifo", "directory"]) {
  test(`scaffold rejects ${kind} before unsafe read`, () => fixture(async cwd => {
    let file = "bad.ts";
    if (kind.includes("symlink")) {
      const outside = await mkdtemp(join(tmpdir(), "review-outside-"));
      try {
        await writeFile(join(outside, "source.ts"), citation.quote);
        await symlink(kind === "leaf-symlink" ? join(outside, "source.ts") : outside, join(cwd, file));
        if (kind === "ancestor-symlink") file += "/source.ts";
        const out = await scaffold(cwd, file);
        assert.equal(out.value.evidenceGate.integrity, "partial");
        assert.equal(out.value.partitions.keep.length, 0);
      } finally { await rm(outside, { recursive: true, force: true }); }
      return;
    }
    if (kind === "oversize") { const fd = await open(join(cwd, file), "w"); await fd.write(citation.quote); await fd.truncate(5 * 1024 * 1024); await fd.close(); }
    if (kind === "fifo") execFileSync("mkfifo", [join(cwd, file)]);
    if (kind === "directory") await mkdir(join(cwd, file));
    const out = await scaffold(cwd, file);
    assert.equal(out.value.evidenceGate.integrity, "partial");
    assert.equal(out.value.partitions.keep.length, 0);
  }));
}
test("scaffold real in-root bytes retain identity-bound KEEP", () => fixture(async cwd => {
  const out = await scaffold(cwd);
  assert.equal(out.value.evidenceGate.integrity, "complete");
  assert.equal(out.value.partitions.keep.length, 1);
}));
for (const evidence of [["definitely-not-present.ts:999: Trust me"], ["https://example.invalid:1 quote"], ["wsrc:opaque"], [{ ...citation, file: "https://example.invalid/source.ts" }], [{ ...citation, file: "wsrc:opaque" }], [{ ...citation, file: "missing.ts" }], [{ ...citation, quote: "invented" }]]) {
  test(`spec-review unverified evidence cannot pass: ${JSON.stringify(evidence)}`, () => fixture(async cwd => {
    const { p, result } = await roundtrip(cwd, evidence);
    assert.equal(p.finalFindings.length, 0);
    assert.equal(p.needsHuman.length, 1);
    assert.equal(result.gates.actionableEvidenceComplete, false);
    assert.notEqual(result.status, "passed");
  }));
}
for (const verdict of ["KEEP", "WEAKEN", "DROP"]) {
  test(`spec-review grounded ${verdict} roundtrip passes`, () => fixture(async cwd => {
    const { p, result } = await roundtrip(cwd, verdict === "DROP" ? [] : [citation], verdict, verdict === "DROP" ? [citation] : []);
    assert.equal(result.status, "passed");
    assert.equal(p.evidenceGate.complete, true);
    assert.equal(p.evidenceGate.findings[0].rows[0].status, "verified");
    for (const [name, control] of [["verify-findings", verifierControl(verdict === "DROP" ? [] : [citation], verdict, verdict === "DROP" ? [citation] : [])], ["partition", p], ["report", reportControl(p)], ["render", result]]) {
      const schema = JSON.parse(await readFile(new URL(`../../workflows/spec-review/schemas/spec-review-${name}-control.schema.json`, import.meta.url)));
      assert.deepEqual(validateJsonSchema(control, schema), { valid: true, issues: [] }, name);
    }
  }));
}
for (const [label, read] of [["scaffold", readScaffold], ["spec-review", readSpec]]) {
  test(`${label} bounded descriptor read rejects mutation, invalid UTF-8 and cancellation`, () => fixture(async cwd => {
    const actualOpen = fsPromises.open;
    let reads = 0;
    mock.method(fsPromises, "open", async (...args) => {
      const handle = await actualOpen(...args);
      const actualRead = handle.read.bind(handle);
      handle.read = async (...readArgs) => {
        reads++;
        assert.ok(readArgs[0].byteLength <= 4 * 1024 * 1024 + 1);
        assert.ok(readArgs[2] <= 64 * 1024);
        const result = await actualRead(...readArgs);
        await writeFile(join(cwd, "source.ts"), "changed during read\n");
        return result;
      };
      return handle;
    });
    syncBuiltinESMExports();
    try { await assert.rejects(read(cwd, "source.ts"), /changed/); assert.ok(reads > 0); }
    finally { mock.restoreAll(); syncBuiltinESMExports(); }
    await writeFile(join(cwd, "source.ts"), Buffer.from([0xff]));
    await assert.rejects(read(cwd, "source.ts"), /encoded|encoding/i);
    await assert.rejects(read(cwd, "source.ts", AbortSignal.abort()), /abort/i);
  }));
  test(`${label} oversize and nonregular rejected before open`, () => fixture(async cwd => {
    const fd = await open(join(cwd, "large"), "w"); await fd.truncate(8 * 1024 * 1024); await fd.close();
    await mkdir(join(cwd, "directory"));
    execFileSync("mkfifo", [join(cwd, "fifo")]);
    mock.method(fsPromises, "open", () => { throw new Error("must not open"); });
    syncBuiltinESMExports();
    try { for (const file of ["large", "directory", "fifo"]) await assert.rejects(read(cwd, file), /bounded regular/); }
    finally { mock.restoreAll(); syncBuiltinESMExports(); }
  }));
}
for (const change of [{ lineEnd: 99 }, { lineStart: 0 }, { lineStart: 2, lineEnd: 1 }, { quote: "export const enabled = false;\n" }]) {
  test(`exact range rejects ${JSON.stringify(change)}`, () => fixture(async cwd => {
    const { result } = await roundtrip(cwd, [{ ...citation, ...change }]);
    assert.notEqual(result.status, "passed");
  }));
}
test("CRLF and whitespace remain significant; mixed legacy display is not authority", () => fixture(async cwd => {
  await writeFile(join(cwd, "source.ts"), "first\r\n  second  \r\n");
  const exact = { ...citation, lineEnd: 2, quote: "first\r\n  second  \r" };
  assert.equal((await roundtrip(cwd, [exact, "missing.ts:999: display-only"])).result.status, "passed");
  assert.notEqual((await roundtrip(cwd, [{ ...exact, quote: "first\n  second  " }])).result.status, "passed");
  assert.notEqual((await roundtrip(cwd, [{ ...exact, quote: "first\r\nsecond" }])).result.status, "passed");
}));
test("one good citation cannot hide another missing required source", () => fixture(async cwd => {
  const { p, result } = await roundtrip(cwd, [citation, { ...citation, file: "missing.ts" }]);
  assert.equal(p.evidenceGate.findings[0].rows.length, 2);
  assert.equal(p.finalFindings.length, 0);
  assert.notEqual(result.status, "passed");
}));
test("positive requirement coverage needs bytes; gap is not a coverage proof", () => fixture(async cwd => {
  const analysis = { ...candidates, requirementCoverage: [{ requirementId: "REQ-1", status: "covered", evidence: ["missing.ts:999"] }] };
  assert.notEqual((await roundtrip(cwd, [citation], "KEEP", [], analysis)).result.status, "passed");
  analysis.requirementCoverage[0].evidence = [citation];
  assert.equal((await roundtrip(cwd, [citation], "KEEP", [], analysis)).result.status, "passed");
}));
test("renderer rechecks source bytes and refuses absent/fabricated gate metadata", () => fixture(async cwd => {
  const { p } = await roundtrip(cwd, [citation]);
  const invoke = () => render({ sources: { "partition-findings": p, report: reportControl(p) }, context: { cwd, sourceStatuses: ["partition-findings", "report"].map(source => ({ source, stageId: source, specId: `${source}.main`, taskId: source, status: "completed" })) } });
  await writeFile(join(cwd, "source.ts"), "changed after partition\n");
  assert.equal((await invoke()).gates.actionableEvidenceComplete, false);
  p.evidenceGate.findings[0].rows[0].status = "verified";
  assert.equal((await invoke()).gates.actionableEvidenceComplete, false);
  delete p.evidenceGate;
  assert.equal((await invoke()).gates.actionableEvidenceComplete, false);
}));
test("typed schema rejects claim/relevance as substitute quote", async () => {
  const schema = JSON.parse(await readFile(new URL("../../workflows/spec-review/schemas/spec-review-verify-findings-control.schema.json", import.meta.url)));
  assert.equal(validateJsonSchema(verifierControl([{ file: "source.ts", claim: "Trust me" }]), schema).valid, false);
});
test("candidate source status absent/failed cannot claim complete evidence", () => fixture(async cwd => {
  for (const sourceStatuses of [[owner], [{ ...statuses[0], status: "failed" }, owner]]) {
    const p = await partition({ sources: { "candidate-findings": candidates, "verify-findings": verifierControl([citation]) }, context: { cwd, sourceStatuses } });
    assert.equal(p.evidenceGate.complete, false);
    assert.ok(p.sourceStatusSummary.nonCompleted > 0);
  }
}));
test("UTF-8 BOM is retained in exact bytes and digest", () => fixture(async cwd => {
  await writeFile(join(cwd, "source.ts"), "\uFEFF" + citation.quote);
  const { result } = await roundtrip(cwd, [{ ...citation, quote: "\uFEFF" + citation.quote }]);
  assert.equal(result.status, "passed");
}));
test("reader detects ancestor replacement after open before any content read", () => fixture(async cwd => {
  await mkdir(join(cwd, "dir"));
  await writeFile(join(cwd, "dir/source.ts"), citation.quote);
  const actualOpen = fsPromises.open;
  const actualRename = fsPromises.rename;
  let reads = 0;
  mock.method(fsPromises, "open", async (...args) => {
    const handle = await actualOpen(...args);
    handle.read = async () => { reads++; throw new Error("must not read"); };
    await actualRename(join(cwd, "dir"), join(cwd, "moved"));
    await symlink(join(cwd, "moved"), join(cwd, "dir"));
    return handle;
  });
  syncBuiltinESMExports();
  try { await assert.rejects(readScaffold(cwd, "dir/source.ts"), /ancestry changed/); assert.equal(reads, 0); }
  finally { mock.restoreAll(); syncBuiltinESMExports(); }
}));
test("unverified DROP cannot silently remove a candidate", () => fixture(async cwd => {
  const { p, result } = await roundtrip(cwd, [], "DROP", ["missing.ts:999: not a gap"]);
  assert.equal(p.droppedFindings.length, 0);
  assert.equal(p.needsHuman.length, 1);
  assert.notEqual(result.verdict, "CONFORMS");
  assert.notEqual(result.status, "passed");
}));
