import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateJsonSchema } from "../../dist/json-schema.js";
import { parseWorkflowOutputForBundle } from "../../dist/workflow-output-artifacts.js";
import localQuoteGate from "../../workflows/deep-research/helpers/local-quote-gate.mjs";
import partition from "../../skills/workflow-guide/scaffolds/support-partition/helpers/partition.mjs";
import evidenceGate from "../../skills/workflow-guide/scaffolds/support-partition/helpers/evidence-gate.mjs";
import claimGate from "../../workflows/deep-research/helpers/claim-evidence-gate.mjs";
import specPartition from "../../workflows/spec-review/helpers/spec-review-pipeline.mjs";
import specRender from "../../workflows/spec-review/helpers/render-spec-review-report.mjs";

const schema = async (path) => JSON.parse(await readFile(new URL(`../../${path}`, import.meta.url), "utf8"));
const candidate = (id) => ({ id, title: "Same title", severity: "medium", locations: [{ file: "source.ts", line: 1 }], evidenceQuotes: ["export const enabled = false;"], rationale: "reason", recommendedAction: "fix" });
const verification = (id) => ({ schema: "test", digest: "test", candidateId: id, finding: candidate(id), verdict: "KEEP", evidenceQuotes: [], counterEvidence: [], recommendedAction: "fix" });
const owner = (stage, id, source = stage) => ({ source, stageId: stage, specId: `${stage}.${id}`, taskId: `task-${id}`, itemIdentity: id, placeholderSpecId: `${stage}.item`, status: "completed" });
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "helper-grounding-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "source.ts"), "export const enabled = false;\nsecond line\n");
  return cwd;
}
async function scaffold(cwd, candidates, rows, statuses = rows.map(([source, v]) => owner("verify-candidates", v.candidateId, source))) {
  const plan = { schema: 'test', digest: 'test', candidates };
  assert.equal(validateJsonSchema(plan, await schema('skills/workflow-guide/scaffolds/support-partition/schemas/candidates-control.schema.json')).valid, true);
  const p = await partition({ sources: { "collect-candidates": plan, ...Object.fromEntries(rows) }, context: { cwd, sourceStatuses: statuses } });
  const g = await evidenceGate({ sources: { "partition-verdicts": p }, context: { cwd } });
  const contract = await schema("skills/workflow-guide/scaffolds/support-partition/schemas/partition-control.schema.json");
  assert.equal(validateJsonSchema(p, contract).valid, true);
  assert.equal(validateJsonSchema(g, contract).valid, true);
  return g.value;
}

test("scaffold exact identity survives source reordering, case distinctions and same titles", async (t) => {
  const cwd = await fixture(t);
  for (const rows of [[['verify-candidates.alias', verification('A')], ['verify-candidates', verification('a')]], [['verify-candidates', verification('a')], ['verify-candidates.alias', verification('A')]]]) {
    const value = await scaffold(cwd, [candidate('A'), candidate('a')], rows);
    assert.equal(value.evidenceGate.integrity, 'complete');
    assert.deepEqual(value.partitions.keep.map((v) => v.findingId).sort(), ['A', 'a']);
  }
});

for (const mode of ['unknown', 'wrong-echo', 'case-fold', 'missing', 'duplicate', 'duplicate-plan', 'missing-owner', 'wrong-owner', 'failed-owner', 'malformed']) {
  test(`scaffold ${mode} rows cannot produce complete identity`, async (t) => {
    const cwd = await fixture(t);
    const v = verification('A');
    const candidates = [candidate('A')];
    let rows = [['verify-candidates', v]];
    let statuses = [owner('verify-candidates', 'A')];
    if (mode === 'unknown') v.candidateId = 'UNKNOWN';
    if (mode === 'wrong-echo') v.finding.id = 'OTHER';
    if (mode === 'case-fold') v.candidateId = 'a';
    if (mode === 'missing') rows = [];
    if (mode === 'duplicate') { rows.push(['verify-candidates.other', verification('A')]); statuses.push(owner('verify-candidates', 'A', 'verify-candidates.other')); }
    if (mode === 'duplicate-plan') candidates.push(candidate('A'));
    if (mode === 'missing-owner') statuses = [];
    if (mode === 'wrong-owner') statuses[0].itemIdentity = 'OTHER';
    if (mode === 'failed-owner') statuses[0].status = 'failed';
    if (mode === 'malformed') rows = [['verify-candidates', {}]];
    if (!['missing', 'malformed'].includes(mode)) assert.equal(validateJsonSchema(v, await schema('skills/workflow-guide/scaffolds/support-partition/schemas/verification-control.schema.json')).valid, true);
    const value = await scaffold(cwd, candidates, rows, statuses);
    assert.equal(value.evidenceGate.integrity, 'partial');
    assert.equal(value.partitions.keep.length, 0);
    assert.ok(value.partitions.needsHuman.some((row) => row.findingId === 'A'));
  });
}

test('scaffold evidence gate never upgrades missing identity accounting', async (t) => {
  const cwd = await fixture(t);
  const p = await partition({ sources: { 'collect-candidates': { candidates: [candidate('A')] }, 'verify-candidates': verification('A') }, context: { sourceStatuses: [owner('verify-candidates', 'A')] } });
  delete p.value.identityIntegrity;
  delete p.value.partitionSummary.integrity;
  const g = await evidenceGate({ sources: { 'partition-verdicts': p }, context: { cwd } });
  assert.equal(g.value.evidenceGate.integrity, 'partial');
});

for (const mode of ['exact', 'mismatch', 'wrong-range', 'missing-file', 'symlink', 'remote', 'partial']) {
  test(`research local quote grounding: ${mode}`, async (t) => {
    const cwd = await fixture(t);
    if (mode === 'symlink') await symlink(join(cwd, 'source.ts'), join(cwd, 'link.ts'));
    const file = mode === 'missing-file' ? 'absent.ts' : mode === 'symlink' ? 'link.ts' : 'source.ts';
    const c = { id: 'claim-001', claim: 'The feature is disabled.', file, sourceRefs: [file], factSlotIds: ['slot-001'] };
    const evidence = mode === 'remote' ? { url: 'https://example.invalid/source', quote: 'remote evidence remains model inspected' } : { file, line: mode === 'wrong-range' ? 2 : 1, quote: mode === 'mismatch' ? 'export const enabled = true;' : 'export const enabled = false;' };
    if (mode === 'remote') { delete c.file; c.sourceRefs = []; c.sourceUrls = [evidence.url]; }
    const v = { schema: 'test', digest: 'test', id: c.id, status: mode === 'partial' ? 'partially_supported' : 'verified', confidence: 'high', verdictDigest: {}, evidence: [evidence] };
    assert.equal(validateJsonSchema(v, await schema('workflows/deep-research/schemas/deep-research-verify-claims-control.schema.json')).valid, true);
    const plan = { schema: 'test', digest: 'test', claimInventory: { verificationCandidates: [c], preservedClaims: [], duplicates: [] }, factSlotCoverage: [] };
    assert.equal(validateJsonSchema(plan, await schema('workflows/deep-research/schemas/deep-research-sanitize-claims-control.schema.json')).valid, true);
    const result = await claimGate({ sources: { 'sanitize-claims': plan, 'verify-claims': v }, context: { cwd, sourceStatuses: [owner('verify-claims', c.id)] } });
    const row = result.auditedClaims[0];
    if (['exact', 'remote'].includes(mode)) assert.equal(row.status, 'verified');
    else assert.notEqual(row.status, 'verified');
    if (mode === 'mismatch') assert.equal(row.evidenceGate.reasonCode, 'local_quote_mismatch');
    if (mode === 'partial') assert.equal(row.status, 'partially_supported');
  });
}

for (const [label, evidence, usable] of [
  ['bare assertion', ['Trust me; no repository locator.'], false],
  ['legacy located evidence is display-only', ['source.ts:1: export const enabled = false;'], false],
  ['structured quote', [{ file: 'source.ts', lineStart: 1, lineEnd: 1, quote: 'export const enabled = false;' }], true],
  ['claim is not quote', ['source.ts:1: Trust me'], false],
]) {
  test(`spec-review actionable evidence requires verified bytes: ${label}`, async (t) => {
    const cwd = await fixture(t);
    const id = 'finding-001';
    const v = { schema: 'test', digest: 'test', id, verdict: 'KEEP', severity: 'medium', evidence, finalClaim: 'A gap exists', recommendedAction: 'Fix it' };
    assert.equal(validateJsonSchema(v, await schema('workflows/spec-review/schemas/spec-review-verify-findings-control.schema.json')).valid, true);
    const plan = { schema: 'test', digest: 'test', candidateFindings: [{ id, title: 'Gap', claim: 'A gap exists', severity: 'medium', requirementIds: ['REQ-1'] }], requirementCoverage: [], needsHuman: [], noIssueNotes: [] };
    assert.equal(validateJsonSchema(plan, await schema('workflows/spec-review/schemas/spec-review-candidate-findings-control.schema.json')).valid, true);
    const p = await specPartition({ sources: { 'candidate-findings': plan, 'verify-findings': v }, options: { mode: 'partition' }, context: { cwd, sourceStatuses: [{ source: 'candidate-findings', stageId: 'candidate-findings', specId: 'candidate-findings.main', taskId: 'task-plan', status: 'completed' }, owner('verify-findings', id)] } });
    const report = { schema: 'spec-review-report-v1', digest: 'test', summary: 'A gap exists.', verdict: 'GAPS_FOUND', risks: [], recommendedNextAction: 'Fix it.', ownerLedger: p.verifierCoverage.ownerLedger, ownerLedgerReconciliation: p.verifierCoverage.ownerLedgerReconciliation };
    const result = await specRender({ sources: { 'partition-findings': p, report }, context: { cwd, sourceStatuses: ['partition-findings', 'report'].map((source) => ({ source, stageId: source, specId: `${source}.main`, taskId: `task-${source}`, status: 'completed' })) } });
    assert.equal(validateJsonSchema(p, await schema('workflows/spec-review/schemas/spec-review-partition-control.schema.json')).valid, true);
    assert.equal(validateJsonSchema(report, await schema('workflows/spec-review/schemas/spec-review-report-control.schema.json')).valid, true);
    assert.equal(validateJsonSchema(result, await schema('workflows/spec-review/schemas/spec-review-render-control.schema.json')).valid, true);
    assert.equal(result.gates.actionableEvidenceComplete, usable);
    assert.equal(result.status === 'passed', usable);
  });
}

test('literal complete protocol escaping preserves analysis without relaxing duplicate checks', () => {
  const sample = '<control>{"schema":"test","digest":"example"}</control>\n<analysis>reason</analysis>\n<refs>[]</refs>';
  const escaped = sample.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const analysis = `Example:\n\`\`\`xml\n${escaped}\n\`\`\``;
  const output = `<control>{"schema":"test","digest":"outer"}</control>\n<analysis>${analysis}</analysis>\n<refs>[]</refs>`;
  const parsed = parseWorkflowOutputForBundle(output);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.analysis, analysis);
  assert.equal(parseWorkflowOutputForBundle(`${output}\n<refs>[]</refs>`).valid, false);
  assert.equal(parseWorkflowOutputForBundle(`${output}\n${sample}`).valid, false);
});

test('local quote grammar and bounded reads preserve exact evidence and reject unsafe controls', async (t) => {
  const cwd = await fixture(t);
  const gate = (row, context = { cwd }) => localQuoteGate([row], context, () => false);
  const quote = 'export const enabled = false;';
  for (const location of [{ lineStart: 1, lineEnd: 1 }, { lines: 'L1-L1' }, { excerptLocation: 'enabled declaration' }]) {
    const rows = await gate({ file: 'source.ts', quote, ...location });
    assert.equal(rows[0].status, 'verified');
    assert.equal(rows[0].matchScope, location.excerptLocation ? 'file' : 'range');
  }
  for (const location of [{ line: 0 }, { line: 1, lineEnd: 99 }, { lineStart: 1, lines: '2' }, { lines: 'not a range' }]) {
    assert.equal((await gate({ file: 'source.ts', quote, ...location }))[0].status, 'unreadable');
  }
  assert.equal((await gate({ file: '../source.ts', line: 1, quote }))[0].status, 'unreadable');
  assert.equal((await gate({ file: 'source.ts', line: 1, quote }, {}))[0].status, 'unreadable');
  await writeFile(join(cwd, 'large.txt'), 'x'.repeat(4 * 1024 * 1024 + 1));
  assert.equal((await gate({ file: 'large.txt', line: 1, quote: 'x' }))[0].status, 'unreadable');
  await writeFile(join(cwd, 'crlf.txt'), 'first\r\nsecond\r\n');
  assert.equal((await gate({ file: 'crlf.txt', lineStart: 1, lineEnd: 2, quote: 'first\nsecond' }))[0].status, 'mismatch');
  assert.equal((await gate({ file: 'crlf.txt', lineStart: 1, lineEnd: 2, quote: 'first\r\nsecond' }))[0].status, 'verified');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(gate({ file: 'source.ts', line: 1, quote }, { cwd, signal: controller.signal }), /abort/i);
});
