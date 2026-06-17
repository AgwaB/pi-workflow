#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { extractFindingsJson, readJson, scoreFindings, validateCandidateFindings } from "./lib/findings.mjs";

const ROOT = process.cwd();
const BF = path.join(ROOT, ".pi/eval/bug-forge");
const errors = [];

function shouldSkipWalkDir(dir) {
  const rel = path.relative(BF, dir).split(path.sep).join('/');
  return (
    rel === 'node_modules' ||
    rel.endsWith('/node_modules') ||
    rel === '.git' ||
    rel.endsWith('/.git') ||
    rel.endsWith('/workspace') ||
    rel.includes('/workspace/') ||
    rel.endsWith('/.pi/workflows') ||
    rel.includes('/.pi/workflows/') ||
    rel.endsWith('/.pi/workflow-subagents') ||
    rel.includes('/.pi/workflow-subagents/')
  );
}

function walk(dir, pred, out = []) {
  if (shouldSkipWalkDir(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, pred, out);
    else if (pred(p)) out.push(p);
  }
  return out;
}
function check(cond, msg) { if (!cond) errors.push(msg); }
function run(cmd, args, cwd = ROOT) {
  return spawnSync(cmd, args, { cwd, encoding: "utf8", stdio: "pipe" });
}

for (const file of walk(BF, (p) => p.endsWith(".json"))) {
  try { JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (err) { errors.push(`Invalid JSON ${path.relative(ROOT, file)}: ${err.message}`); }
}

function validateGoldShape(taskId, gold) {
  check(gold.schemaVersion === 1, `${taskId}: gold schemaVersion must be 1`);
  for (const key of ["taskId", "candidateId", "status", "sourceRevision", "fixturePatch", "referenceFixPatch"]) {
    check(typeof gold[key] === "string" && gold[key], `${taskId}: gold.${key} missing`);
  }
  check(Array.isArray(gold.bugs), `${taskId}: gold.bugs must be array`);
  check(Array.isArray(gold.noIssueRegions), `${taskId}: gold.noIssueRegions must be array`);
  check(gold.leakagePolicy && Array.isArray(gold.leakagePolicy.candidateVisible) && Array.isArray(gold.leakagePolicy.candidateForbidden), `${taskId}: leakagePolicy incomplete`);
  check(gold.approval && Array.isArray(gold.approval.providerReviews) && Array.isArray(gold.approval.approvedBy), `${taskId}: approval incomplete`);
}

function sourceRepoCwd(task) {
  const source = task.sourceRepository;
  if (!source) return ROOT;
  if (source.type !== "local-git") return ROOT;
  const localPath = source.localPathEnv && process.env[source.localPathEnv]
    ? process.env[source.localPathEnv]
    : source.localPath;
  return localPath ? path.resolve(localPath) : ROOT;
}

function sourceTextAtRevision(revision, file, task) {
  if (!revision || revision === "TBD" || !file) return "";
  const cwd = sourceRepoCwd(task);
  const cp = run("git", ["show", `${revision}:${file}`], cwd);
  return cp.status === 0 ? cp.stdout : "";
}

function quoteAppears(taskDir, gold, evidence, task) {
  const candidates = [];
  const sourceText = sourceTextAtRevision(gold.sourceRevision, evidence.file, task);
  if (sourceText) candidates.push(sourceText);
  const fixture = path.join(taskDir, gold.fixturePatch ?? "fixture.diff");
  if (fs.existsSync(fixture)) candidates.push(fs.readFileSync(fixture, "utf8"));
  const quote = String(evidence.quote ?? "");
  return candidates.some((text) => {
    if (evidence.matchMode === "exact") return text.includes(quote);
    if (evidence.matchMode === "regex") return new RegExp(quote, "i").test(text);
    return text.toLowerCase().includes(quote.toLowerCase());
  });
}

function validateMaterialization(taskId) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), `bug-forge-validate-${taskId}-`));
  try {
    const cp = run("node", [".pi/eval/bug-forge/scripts/materialize.mjs", "--task", taskId, "--out", out]);
    check(cp.status === 0, `${taskId}: materialize failed: ${cp.stderr || cp.stdout}`);
    if (cp.status === 0) {
      const result = JSON.parse(cp.stdout);
      check(result.ok === true, `${taskId}: materialized workspace failed leakage audit: ${cp.stdout}`);
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

const registry = readJson(path.join(BF, "registry.json"));
for (const task of registry.tasks ?? []) {
  const taskDir = path.join(BF, task.path);
  check(fs.existsSync(path.join(taskDir, "task.json")), `${task.candidateId}: missing task.json`);
  check(fs.existsSync(path.join(taskDir, "gold-key.draft.json")), `${task.candidateId}: missing gold-key.draft.json`);
  check(fs.existsSync(path.join(taskDir, "fixture.diff")), `${task.candidateId}: missing fixture.diff`);
  check(fs.existsSync(path.join(taskDir, "reference-fix.patch")), `${task.candidateId}: missing reference-fix.patch`);
  validateMaterialization(task.candidateId);
  const gold = readJson(path.join(taskDir, "gold-key.draft.json"));
  validateGoldShape(task.candidateId, gold);
  check(gold.candidateId === task.candidateId, `${task.candidateId}: gold candidateId mismatch`);
  check(gold.sourceRevision && gold.sourceRevision !== "TBD", `${task.candidateId}: sourceRevision not pinned`);
  for (const bug of gold.bugs ?? []) {
    check((bug.locations ?? []).every((loc) => loc.file && loc.file !== "TBD"), `${task.candidateId}/${bug.bugId}: location not concrete`);
    for (const ev of bug.requiredEvidence ?? []) {
      check(ev.file && ev.file !== "TBD" && ev.quote && !ev.quote.startsWith("TBD"), `${task.candidateId}/${bug.bugId}: evidence not concrete`);
      check(quoteAppears(taskDir, gold, ev, task), `${task.candidateId}/${bug.bugId}: evidence quote not found: ${ev.quote}`);
    }
  }
}

// Scorer self-tests.
const goldOne = {
  taskId: "self-test",
  candidateId: "self-test",
  bugs: [{ bugId: "G1", severity: "high", summary: "runtime task injection is omitted", impact: "foreach stages miss user constraints", locations: [{ file: "src/compiler.ts", startLine: 1, endLine: 5 }], requiredEvidence: [{ file: "src/compiler.ts", quote: "taskStageKind", matchMode: "substring" }] }],
};
const good = { findings: [{ severity: "high", file: "src/compiler.ts", line: 3, claim: "runtime task injection is omitted for opted-in stages", evidenceQuote: "taskStageKind", fix: "include opt-in condition", confidence: 0.8 }], noMaterialIssues: false };
const goodMultiLocation = { findings: [{ severity: "high", file: "src/compiler.ts", line: 99, locations: [{ file: "src/other.ts", line: 1 }, { file: "src/compiler.ts", line: 3 }], claim: "runtime task injection is omitted for opted-in stages", evidenceQuote: "taskStageKind", fix: "include opt-in condition", confidence: 0.8 }], noMaterialIssues: false };
const badFp = { findings: [{ severity: "medium", file: "src/other.ts", claim: "unrelated", evidenceQuote: "none", fix: "none" }], noMaterialIssues: false };
check(validateCandidateFindings(good).length === 0, "self-test: good candidate schema invalid");
check(validateCandidateFindings(goodMultiLocation).length === 0, "self-test: multi-location candidate schema invalid");
check(scoreFindings(goldOne, good).recall === 1, "self-test: true positive recall failed");
check(scoreFindings(goldOne, goodMultiLocation).recall === 1, "self-test: multi-location true positive recall failed");
check(scoreFindings(goldOne, badFp).falsePositiveCount === 1, "self-test: false positive count failed");
const noIssueGold = { taskId: "no-issue", candidateId: "no-issue", bugs: [] };
check(scoreFindings(noIssueGold, { findings: [], noMaterialIssues: true }).objectiveScore > 0.9, "self-test: no-issue success failed");
check(scoreFindings(noIssueGold, badFp).objectiveScore === 0, "self-test: no-issue hallucination penalty failed");
check(!extractFindingsJson("no json here").ok, "self-test: missing JSON should not parse");

if (errors.length) {
  console.error(errors.map((e) => `- ${e}`).join("\n"));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, checkedTasks: (registry.tasks ?? []).length, message: "bug-forge validation passed" }, null, 2));
