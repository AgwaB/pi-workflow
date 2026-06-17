#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { extractFindingsJson, readJson, scoreFindings, validateCandidateFindings } from "./lib/findings.mjs";

const ROOT = process.cwd();
const BF = path.join(ROOT, ".pi/eval/bug-forge");
const PI_MAX_OUTPUT_BUFFER = 50 * 1024 * 1024;
const WORKFLOW_WAIT_CHUNK_MS = 900_000;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(name) { return process.argv.includes(name); }
function run(cmd, args, opts = {}) {
  const cp = spawnSync(cmd, args, { cwd: opts.cwd ?? ROOT, encoding: "utf8", maxBuffer: PI_MAX_OUTPUT_BUFFER, env: { ...process.env, ...(opts.env ?? {}) } });
  if (opts.allowFailure) return cp;
  if (cp.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed\n${cp.stdout}\n${cp.stderr}`);
  return cp;
}
function runAsync(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd ?? ROOT, env: { ...process.env, ...(opts.env ?? {}) }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killedForBuffer = false;
    const append = (kind, chunk) => {
      if (kind === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
      if (stdout.length + stderr.length > PI_MAX_OUTPUT_BUFFER && !killedForBuffer) {
        killedForBuffer = true;
        stderr += `\n${cmd} output exceeded ${PI_MAX_OUTPUT_BUFFER} bytes; terminating.\n`;
        child.kill("SIGTERM");
      }
    };
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    child.on("error", (err) => resolve({ status: 1, signal: null, stdout, stderr: `${stderr}\n${err.stack || err.message}` }));
    child.on("close", (code, signal) => resolve({ status: code ?? (signal ? 1 : 0), signal, stdout, stderr }));
  });
}
function timestamp() { return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z"); }
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function write(p, content) { ensureDir(path.dirname(p)); fs.writeFileSync(p, content); }
function shellQuote(s) { return JSON.stringify(String(s)); }

async function pi(prompt, cwd, model, thinking, extra = [], options = {}) {
  const args = [
    "--offline",
    "--no-session",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-extensions",
    "--extension",
    options.extensionRoot ?? cwd,
  ];
  if (model) args.push("--model", model);
  if (thinking) args.push("--thinking", thinking);
  args.push(...extra, "-p", prompt);
  return runAsync("pi", args, { cwd, env: { PI_WORKFLOW_ROLE: options.role ?? "disabled" } });
}
function extractWorkflowRunId(text) {
  const m = String(text ?? "").match(/workflow_[A-Za-z0-9_-]+/);
  return m ? m[0] : null;
}
function workflowWaitTimedOut(text) {
  return /Flow run still running after/i.test(String(text ?? ""));
}

async function waitWorkflowUntilTerminal(runId, cwd, model, thinking, options = {}) {
  let combinedStdout = "";
  let combinedStderr = "";
  let waitCount = 0;
  while (true) {
    waitCount += 1;
    const wait = await pi(`/workflow wait ${runId} ${WORKFLOW_WAIT_CHUNK_MS}`, cwd, model, thinking, [], { role: options.role ?? "supervisor", extensionRoot: options.extensionRoot });
    const text = `${wait.stdout}\n${wait.stderr}`;
    combinedStdout += `\n\n[workflow wait attempt ${waitCount}]\n${wait.stdout ?? ""}`;
    if (wait.stderr) combinedStderr += `\n\n[workflow wait attempt ${waitCount} stderr]\n${wait.stderr}`;
    if (workflowWaitTimedOut(text)) continue;
    return { ...wait, stdout: combinedStdout.trimStart(), stderr: combinedStderr.trimStart(), waitAttempts: waitCount };
  }
}

function candidatePrompt(taskId, workspace, fixtureDiff) {
  const template = fs.readFileSync(path.join(BF, "prompts/candidate-review.md"), "utf8");
  return `${template}\n\n# Candidate workspace\n\nSanitized workspace path: ${workspace}\n\n# Proposed patch\n\n\`\`\`diff\n${fixtureDiff}\n\`\`\`\n`;
}
function selfCheckPrompt(taskPrompt, draft) {
  return `${taskPrompt}\n\n# First-pass draft to check\n\n${draft}\n\n# Self-check instruction\n\nRevise the review if needed. Remove unsupported findings. Keep the same required JSON findings block contract. If the draft overclaims, correct it.`;
}

function materialize(taskId, outDir) {
  const cp = run("node", [".pi/eval/bug-forge/scripts/materialize.mjs", "--task", taskId, "--out", outDir]);
  return JSON.parse(cp.stdout);
}

function scoreOutput(taskId, outputPath) {
  const taskDir = path.join(BF, "tasks", taskId);
  const gold = readJson(path.join(taskDir, "gold-key.draft.json"));
  const text = fs.readFileSync(outputPath, "utf8");
  const extracted = extractFindingsJson(text);
  const validationIssues = validateCandidateFindings(extracted.data);
  const score = scoreFindings(gold, extracted.data);
  return { extracted: { ok: extracted.ok, extractionMode: extracted.extractionMode, error: extracted.error }, validationIssues, score };
}

function classifyInvalidCell(runResult, scored) {
  const reasons = [];
  if (runResult.status !== 0) reasons.push(`nonzero-status:${runResult.status}`);
  if (runResult.collected?.runStatus && runResult.collected.runStatus !== "completed") reasons.push(`workflow-run-status:${runResult.collected.runStatus}`);
  if (runResult.collected && runResult.collected.collected === false) reasons.push(`workflow-collection:${runResult.collected.reason ?? "unknown"}`);
  if (!scored.extracted.ok) reasons.push(`extraction:${scored.extracted.extractionMode}`);
  if (scored.validationIssues.length) reasons.push(`validation:${scored.validationIssues.length}`);
  const stderrHint = fs.existsSync(runResult.outputPath) ? fs.readFileSync(runResult.outputPath, "utf8") : "";
  if (runResult.collected?.collected === false && /Flow run still running after/i.test(stderrHint)) reasons.push("timeout:workflow-wait");
  if (/pi-subagent run failed/i.test(stderrHint)) reasons.push("subagent-failure");
  if (/status 143|SIGTERM/i.test(stderrHint)) reasons.push("interrupted:143");
  return reasons.length ? { valid: false, reasons: [...new Set(reasons)] } : { valid: true, reasons: [] };
}

async function runPlain(taskId, workspace, prompt, outPath, model, thinking) {
  const cp = await pi(prompt, workspace, model, thinking);
  write(outPath, `${cp.stdout}\n${cp.stderr ? `\n\n[stderr]\n${cp.stderr}` : ""}`);
  return { status: cp.status, outputPath: outPath };
}
async function runSelfCheck(taskId, workspace, prompt, outPath, model, thinking) {
  const draft = await pi(prompt, workspace, model, thinking);
  const draftText = `${draft.stdout}\n${draft.stderr ? `\n\n[stderr]\n${draft.stderr}` : ""}`;
  const revise = await pi(selfCheckPrompt(prompt, draftText), workspace, model, thinking);
  const finalText = `${revise.stdout}\n${revise.stderr ? `\n\n[stderr]\n${revise.stderr}` : ""}`;
  write(outPath.replace(/\.md$/, ".draft.md"), draftText);
  write(outPath, finalText);
  return { status: revise.status || draft.status, outputPath: outPath };
}
function quoteFromEvidenceValue(value, allowString = true) {
  return quoteStringsFromEvidenceValue(value, allowString)[0];
}

function quoteStringsFromEvidenceValue(value, allowString = true) {
  if (typeof value === "string" && value.trim()) return allowString ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap((item) => quoteStringsFromEvidenceValue(item, allowString));
  if (value && typeof value === "object") {
    const direct = typeof value.quote === "string" && value.quote.trim() ? [value.quote.trim()] : [];
    return [...direct, ...Object.values(value).flatMap((item) => quoteStringsFromEvidenceValue(item, false))];
  }
  return [];
}

function firstEvidenceQuote(control, includeDigest = true) {
  return quoteFromEvidenceValue(control.evidenceIndex) ?? (includeDigest ? control.digest ?? "workflow evidence" : undefined);
}

function workflowEvidenceQuote(finding, control) {
  const quotes = [
    ...quoteStringsFromEvidenceValue(finding.evidenceQuotes),
    ...quoteStringsFromEvidenceValue(finding.evidence),
    ...quoteStringsFromEvidenceValue(finding.evidenceQuote),
    firstEvidenceQuote(control, false),
  ].filter((quote) => typeof quote === "string" && quote.trim());
  const unique = [...new Set(quotes)];
  return unique.length ? unique.join("\n") : firstEvidenceQuote(control, true);
}

function preferredWorkflowLocation(finding) {
  const locations = Array.isArray(finding.locations) ? finding.locations.filter((item) => item?.file) : [];
  const sourceLike = locations.find((item) => !String(item.file).startsWith("test/"));
  return sourceLike ?? locations[0] ?? null;
}

function normalizeWorkflowControl(control) {
  const findings = (Array.isArray(control.findings) ? control.findings : [])
    .filter((finding) => finding && typeof finding === "object")
    .map((finding) => normalizeWorkflowFinding(finding, control));
  return { findings, noMaterialIssues: findings.length === 0 };
}

function normalizeWorkflowFinding(finding, control) {
  const loc = preferredWorkflowLocation(finding);
  return {
    severity: ["critical", "high", "medium", "low"].includes(finding.severity) ? finding.severity : "medium",
    file: (!String(finding.file ?? "").startsWith("test/") && finding.file) || loc?.file || finding.file || "unknown",
    ...(Number.isInteger(finding.line ?? loc?.line) ? { line: finding.line ?? loc.line } : {}),
    ...(Number.isInteger(finding.lineEnd ?? loc?.lineEnd) ? { lineEnd: finding.lineEnd ?? loc.lineEnd } : {}),
    claim: finding.claim ?? finding.title ?? finding.rationale ?? control.summary?.headline ?? control.digest ?? "workflow finding",
    evidenceQuote: workflowEvidenceQuote(finding, control),
    fix: finding.fix ?? finding.recommendedAction ?? control.recommendedNextAction ?? "See workflow recommendation.",
    confidence: typeof finding.confidence === "number" ? finding.confidence : 0.8,
  };
}

function normalizePartitionControl(control) {
  const findings = [
    ...asArray(control.partitions?.keep),
    ...asArray(control.partitions?.weaken),
  ].map((finding) => normalizeWorkflowFinding(finding, control));
  return { findings, noMaterialIssues: findings.length === 0 };
}

function asArray(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [];
}

function collectWorkflowStage(workspace, runId, outPath, waitText, scoreStage = "report") {
  if (scoreStage === "partition") return collectWorkflowPartition(workspace, runId, outPath, waitText);
  return collectWorkflowFinal(workspace, runId, outPath, waitText);
}

function collectWorkflowFinal(workspace, runId, outPath, waitText) {
  const runDir = path.join(workspace, ".pi/workflows", runId);
  const runJsonPath = path.join(runDir, "run.json");
  if (!fs.existsSync(runJsonPath)) {
    write(outPath, waitText);
    return { collected: false, reason: "missing run.json" };
  }
  const runJson = readJson(runJsonPath);
  const reportTask = [...(runJson.tasks ?? [])].reverse().find((task) => task?.stageId === "report") ?? [...(runJson.tasks ?? [])].reverse().find((task) => task?.specId?.startsWith?.("report"));
  if (!reportTask?.taskId) {
    write(outPath, waitText);
    return { collected: false, reason: "missing report task" };
  }
  const taskDir = path.join(runDir, "tasks", reportTask.taskId);
  const controlPath = path.join(taskDir, "control.json");
  const rawPath = path.join(taskDir, "raw.md");
  if (!fs.existsSync(controlPath)) {
    const partial = collectWorkflowPartitionFallback(runJson, runDir, outPath, waitText);
    return { collected: false, reason: "missing control.json", reportTaskId: reportTask.taskId, ...partial };
  }
  const control = readJson(controlPath);
  const normalized = normalizeWorkflowControl(control);
  const raw = fs.existsSync(rawPath) ? fs.readFileSync(rawPath, "utf8") : "";
  write(outPath.replace(/\.md$/, ".workflow-control.json"), JSON.stringify(control, null, 2));
  write(outPath.replace(/\.md$/, ".workflow-raw.md"), raw);
  write(outPath, `${raw}\n\n\`\`\`json\n${JSON.stringify(normalized, null, 2)}\n\`\`\`\n`);
  return { collected: true, runStatus: runJson.status, reportTaskId: reportTask.taskId, controlPath };
}

function collectWorkflowPartition(workspace, runId, outPath, waitText) {
  const runDir = path.join(workspace, ".pi/workflows", runId);
  const runJsonPath = path.join(runDir, "run.json");
  if (!fs.existsSync(runJsonPath)) {
    write(outPath, waitText);
    return { collected: false, reason: "missing run.json" };
  }
  const runJson = readJson(runJsonPath);
  const partial = collectWorkflowPartitionFallback(runJson, runDir, outPath, waitText);
  if (!partial.partialCollected) return { collected: false, reason: partial.partialReason ?? "missing partition output", ...partial };
  return { collected: true, runStatus: runJson.status, scoreStage: "partition", ...partial };
}

function collectWorkflowPartitionFallback(runJson, runDir, outPath, waitText) {
  const partitionTask = [...(runJson.tasks ?? [])].reverse().find((task) => task?.stageId === "partition-verdicts") ?? [...(runJson.tasks ?? [])].reverse().find((task) => task?.specId?.startsWith?.("partition-verdicts"));
  if (!partitionTask?.taskId) {
    write(outPath, waitText);
    return { partialCollected: false, partialReason: "missing partition task" };
  }
  const taskDir = path.join(runDir, "tasks", partitionTask.taskId);
  const controlPath = path.join(taskDir, "control.json");
  const rawPath = path.join(taskDir, "raw.md");
  if (!fs.existsSync(controlPath)) {
    write(outPath, waitText);
    return { partialCollected: false, partialReason: "missing partition control.json", partitionTaskId: partitionTask.taskId };
  }
  const control = readJson(controlPath);
  const normalized = normalizePartitionControl(control);
  const raw = fs.existsSync(rawPath) ? fs.readFileSync(rawPath, "utf8") : waitText;
  write(outPath.replace(/\.md$/, ".workflow-partition-control.json"), JSON.stringify(control, null, 2));
  write(outPath.replace(/\.md$/, ".workflow-partial-raw.md"), raw);
  write(outPath, `${raw}\n\n\`\`\`json\n${JSON.stringify(normalized, null, 2)}\n\`\`\`\n`);
  return { partialCollected: true, partitionTaskId: partitionTask.taskId, partitionControlPath: controlPath };
}

async function runWorkflowArm(taskId, workspace, prompt, outPath, model, thinking, options = {}) {
  const workflowRef = options.workflowRef ?? "deep-review";
  const launch = await pi(`/workflow run ${workflowRef} ${shellQuote(prompt)}`, workspace, model, thinking, [], { role: "supervisor", extensionRoot: options.extensionRoot });
  const launchText = `${launch.stdout}\n${launch.stderr}`;
  const runId = extractWorkflowRunId(launchText);
  if (!runId) {
    write(outPath, launchText);
    return { status: launch.status || 1, outputPath: outPath, runId: null };
  }
  const wait = await waitWorkflowUntilTerminal(runId, workspace, model, thinking, { role: "supervisor", extensionRoot: options.extensionRoot });
  const waitText = `${wait.stdout}\n${wait.stderr ? `\n\n[stderr]\n${wait.stderr}` : ""}`;
  const collected = collectWorkflowStage(workspace, runId, outPath, waitText, options.scoreStage ?? "report");
  return { status: wait.status, outputPath: outPath, runId, waitAttempts: wait.waitAttempts, collected };
}

function armList() {
  return (arg("--arms") ?? "plain,self-check,workflow").split(",").map((s) => s.trim()).filter(Boolean);
}
function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
function workflowSpecPath(ref, extensionRoot) {
  if (ref && ref.endsWith(".json") && fs.existsSync(ref)) return ref;
  if (extensionRoot) {
    const candidate = path.join(extensionRoot, "workflows", ref, "spec.json");
    if (fs.existsSync(candidate)) return candidate;
  }
  const bundled = path.join(ROOT, "workflows", ref, "spec.json");
  return fs.existsSync(bundled) ? bundled : ref;
}

function realpathExisting(p) {
  return fs.realpathSync(path.resolve(p));
}

function gitCleanTracked(cwd) {
  const worktree = spawnSync("git", ["diff", "--quiet", "--"], { cwd, encoding: "utf8" });
  const index = spawnSync("git", ["diff", "--cached", "--quiet", "--"], { cwd, encoding: "utf8" });
  return worktree.status === 0 && index.status === 0;
}

function assertPartitionOnlyIsolation({ workflowNoReport, workflowExtensionRoot, outRoot }) {
  if (!workflowNoReport) return null;
  if (!has("--allow-partition-only")) {
    throw new Error("--workflow-no-report is disabled unless --allow-partition-only is passed after confirming isolated execution");
  }
  if (!workflowExtensionRoot) {
    throw new Error("--workflow-no-report requires --workflow-extension-root pointing at the clean candidate workflow checkout");
  }
  const rootReal = realpathExisting(ROOT);
  const extensionReal = realpathExisting(workflowExtensionRoot);
  const outReal = realpathExisting(outRoot);
  if (!fs.existsSync(path.join(extensionReal, "workflows"))) {
    throw new Error(`--workflow-extension-root must contain workflows/: ${workflowExtensionRoot}`);
  }
  if (!gitCleanTracked(ROOT)) {
    throw new Error("--workflow-no-report requires a tracked-clean current worktree because materialize uses git archive from process.cwd(); run from a clean worktree instead of a dirty root checkout");
  }
  if (!gitCleanTracked(extensionReal)) {
    throw new Error("--workflow-no-report requires a tracked-clean workflow extension root");
  }
  if (outReal === rootReal || rootReal.startsWith(`${outReal}${path.sep}`)) {
    throw new Error("--workflow-no-report output root must not be the repository root or an ancestor of it");
  }
  return {
    mode: "partition-only",
    allowed: true,
    rootReal,
    extensionReal,
    outReal,
    trackedClean: true,
  };
}
function copyWorkflowBundles(sourceDir, variantDir) {
  for (const bundleDir of ["schemas", "helpers"]) {
    const sourceBundleDir = path.join(sourceDir, bundleDir);
    if (fs.existsSync(sourceBundleDir)) fs.cpSync(sourceBundleDir, path.join(variantDir, bundleDir), { recursive: true, force: true });
  }
}

function writeWorkflowEvalVariant(ref, extensionRoot, outRoot, options = {}) {
  const sourcePath = workflowSpecPath(ref, extensionRoot);
  const sourceDir = path.dirname(sourcePath);
  const spec = readJson(sourcePath);
  const stages = spec?.artifactGraph?.stages;
  if (!Array.isArray(stages)) throw new Error(`workflow spec has no artifactGraph.stages: ${sourcePath}`);
  const suffixes = ["bug-forge-eval"];
  spec.defaults = spec.defaults && typeof spec.defaults === "object" && !Array.isArray(spec.defaults) ? { ...spec.defaults } : {};
  if (options.model) spec.defaults.model = options.model;
  if (options.thinking) spec.defaults.thinking = options.thinking;
  if (options.noReport) {
    const filtered = stages.filter((stage) => stage?.id !== "report");
    if (filtered.length === stages.length) throw new Error(`workflow spec has no report stage to remove: ${sourcePath}`);
    spec.artifactGraph.stages = filtered;
    suffixes.push("partition-only");
  }
  spec.name = `${spec.name ?? "workflow"}-${suffixes.join("-")}`;
  const variantNotes = [
    "Bug Forge eval variant generated by calibrator.",
    options.model ? `model=${options.model}` : undefined,
    options.thinking ? `thinking=${options.thinking}` : undefined,
    options.noReport ? "final report stage removed" : undefined,
  ].filter(Boolean).join("; ");
  spec.description = `${spec.description ?? ""} ${variantNotes}`.trim();
  const variantDir = path.join(outRoot, "workflow-variants", spec.name);
  ensureDir(variantDir);
  copyWorkflowBundles(sourceDir, variantDir);
  const variantPath = path.join(variantDir, "spec.json");
  write(variantPath, JSON.stringify(spec, null, 2));
  return variantPath;
}
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) break;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

const selectedTasks = (arg("--tasks") ?? "review-case-a1,review-case-b2,review-case-c3").split(",").map((s) => s.trim()).filter(Boolean);
const arms = armList();
const model = arg("--model") ?? "kimi-coding/kimi-for-coding";
const thinking = arg("--thinking") ?? "low";
const outerConcurrency = positiveInt(arg("--concurrency"), 3);
const workflowExtensionRoot = arg("--workflow-extension-root") ? path.resolve(arg("--workflow-extension-root")) : undefined;
const requestedWorkflowRef = arg("--workflow-ref") ?? "deep-review";
const workflowScoreStage = arg("--workflow-score-stage") ?? (has("--workflow-no-report") ? "partition" : "report");
if (!["report", "partition"].includes(workflowScoreStage)) throw new Error(`--workflow-score-stage must be report or partition, got ${workflowScoreStage}`);
const outRoot = path.resolve(arg("--out") ?? path.join(BF, "runs", `calibration-${timestamp()}`));
ensureDir(outRoot);
const workflowNoReport = has("--workflow-no-report");
const partitionOnlyIsolation = assertPartitionOnlyIsolation({ workflowNoReport, workflowExtensionRoot, outRoot });
const workflowRef = arms.includes("workflow") ? writeWorkflowEvalVariant(requestedWorkflowRef, workflowExtensionRoot, outRoot, { model, thinking, noReport: workflowNoReport }) : requestedWorkflowRef;

const manifest = { kind: "bug-forge-calibration", startedAt: new Date().toISOString(), model, thinking, concurrency: outerConcurrency, tasks: selectedTasks, arms, outRoot, workflowRef, requestedWorkflowRef, workflowScoreStage, workflowNoReport, workflowEvalVariant: arms.includes("workflow"), ...(partitionOnlyIsolation ? { partitionOnlyIsolation } : {}), ...(workflowExtensionRoot ? { workflowExtensionRoot } : {}) };
write(path.join(outRoot, "manifest.json"), JSON.stringify(manifest, null, 2));

async function runCell({ taskId, arm }) {
  const armDir = path.join(outRoot, taskId, arm);
  ensureDir(armDir);
  const workspace = path.resolve(path.join(armDir, "workspace"));
  const outputPath = path.join(armDir, "output.md");
  let runResult;
  try {
    const taskDir = path.join(BF, "tasks", taskId);
    const fixtureDiff = fs.readFileSync(path.join(taskDir, "fixture.diff"), "utf8");
    const mat = materialize(taskId, workspace);
    write(path.join(armDir, "materialize.json"), JSON.stringify(mat, null, 2));
    const prompt = candidatePrompt(taskId, workspace, fixtureDiff);
    write(path.join(armDir, "prompt.md"), prompt);
    if (arm === "plain") runResult = await runPlain(taskId, workspace, prompt, outputPath, model, thinking);
    else if (arm === "self-check") runResult = await runSelfCheck(taskId, workspace, prompt, outputPath, model, thinking);
    else if (arm === "workflow") runResult = await runWorkflowArm(taskId, workspace, prompt, outputPath, model, thinking, { extensionRoot: workflowExtensionRoot, workflowRef, scoreStage: workflowScoreStage });
    else throw new Error(`unknown arm: ${arm}`);
  } catch (err) {
    const message = err?.stack || err?.message || String(err);
    write(outputPath, `[runner-error]\n${message}\n`);
    runResult = { status: 1, outputPath, error: message };
  }
  write(path.join(armDir, "run-result.json"), JSON.stringify(runResult, null, 2));
  const scored = scoreOutput(taskId, outputPath);
  const invalidCell = classifyInvalidCell(runResult, scored);
  write(path.join(armDir, "score.json"), JSON.stringify({ ...scored, invalidCell }, null, 2));
  const result = { taskId, arm, status: runResult.status, score: scored.score, extraction: scored.extracted, validationIssues: scored.validationIssues, invalidCell };
  const invalidSuffix = invalidCell.valid ? "" : ` invalid=${invalidCell.reasons.join("+")}`;
  console.log(`${taskId} ${arm}: score=${scored.score.objectiveScore.toFixed(3)} recall=${scored.score.recall.toFixed(3)} fp=${scored.score.falsePositiveCount} extraction=${scored.extractionMode ?? scored.extracted.extractionMode}${invalidSuffix}`);
  return result;
}

const cells = selectedTasks.flatMap((taskId) => arms.map((arm) => ({ taskId, arm })));
console.log(`Running ${cells.length} calibration cells with outer concurrency ${outerConcurrency}; model=${model}; thinking=${thinking}; workflowScoreStage=${workflowScoreStage}${has("--workflow-no-report") ? "; workflowNoReport=true" : ""}`);
const results = await runWithConcurrency(cells, outerConcurrency, runCell);

const byTask = {};
for (const r of results) (byTask[r.taskId] ??= {})[r.arm] = r;
const invalidCells = results.filter((r) => !r.invalidCell.valid);
const validResults = results.filter((r) => r.invalidCell.valid);
const summary = { completedAt: new Date().toISOString(), model, thinking, concurrency: outerConcurrency, results, validResults, invalidCells, byTask };
write(path.join(outRoot, "summary.json"), JSON.stringify(summary, null, 2));
let md = `# Bug Forge Calibration\n\nModel: ${model}\nThinking: ${thinking}\nConcurrency: ${outerConcurrency}\nWorkflow score stage: ${workflowScoreStage}\nWorkflow no report: ${has("--workflow-no-report") ? "yes" : "no"}\n\nInvalid cells are quarantined from interpretation; their objective scores are diagnostic only.\n\n| Task | Arm | Valid | Score | Recall | Precision | FP | Extraction | Status | Invalid reasons |\n|---|---|---|---:|---:|---:|---:|---|---:|---|\n`;
for (const r of results) md += `| ${r.taskId} | ${r.arm} | ${r.invalidCell.valid ? "yes" : "no"} | ${r.score.objectiveScore.toFixed(3)} | ${r.score.recall.toFixed(3)} | ${r.score.precision.toFixed(3)} | ${r.score.falsePositiveCount} | ${r.extraction.extractionMode} | ${r.status} | ${r.invalidCell.reasons.join(", ")} |\n`;
if (invalidCells.length) {
  md += `\n## Invalid cells\n\n`;
  for (const r of invalidCells) md += `- ${r.taskId} / ${r.arm}: ${r.invalidCell.reasons.join(", ")}\n`;
}
write(path.join(outRoot, "report.md"), md);
console.log(`Report: ${path.join(outRoot, "report.md")}`);
