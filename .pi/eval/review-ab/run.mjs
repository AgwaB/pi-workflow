#!/usr/bin/env node
// Broad review A/B runner for pi-workflow deep-review experiments.
// Experimental: artifacts are ignored by git under .pi/eval/.

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const evalDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(evalDir, "..", "..", "..");
const runsRoot = join(evalDir, "runs");
const generatedDir = join(evalDir, ".generated");
const PI_MAX_OUTPUT_BUFFER = 96 * 1024 * 1024;
const RUN_ID_RE = /workflow_[A-Za-z0-9_-]+/;
const DEFAULT_JUDGE_MODEL = "kimi-coding/kimi-for-coding";
const DEFAULT_JUDGE_THINKING = "xhigh";
const DEFAULT_TIMEOUT_MS = 21_600_000;

function usage() {
  return `review-ab runner\n\nUsage:\n  node .pi/eval/review-ab/run.mjs --task <task-id> [options]\n\nOptions:\n  --dry-run                    Validate task/reference and print plan\n  --task <id>                  Task id from tasks.json\n  --timeout <ms>               Workflow wait timeout (default ${DEFAULT_TIMEOUT_MS})\n  --model <model>              Candidate execution model override\n  --thinking <level>           Candidate execution thinking override\n  --judge-model <model>        Extractor/verifier model (default ${DEFAULT_JUDGE_MODEL})\n  --judge-thinking <level>     Extractor/verifier thinking (default ${DEFAULT_JUDGE_THINKING})\n  --max-findings <n>           Optional cap on extracted findings per arm to verify (default: no cap)\n  --max-candidate-findings <n> Optional cap requested from candidate reviews (default: no cap)\n  --only-arm <A|B>             Run only one configured arm (debugging; no winner report unless both arms run)\n  --merge-runs <dirA> <dirB>   Merge two prior single/full run directories into one comparison report\n  --skip-run                   Reuse prior candidate outputs is not implemented yet (reserved)\n  --help, -h                   Show help\n`;
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    task: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    model: null,
    thinking: null,
    judgeModel: DEFAULT_JUDGE_MODEL,
    judgeThinking: DEFAULT_JUDGE_THINKING,
    maxFindings: null,
    maxCandidateFindings: null,
    onlyArm: null,
    mergeRuns: null,
    skipRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--task") args.task = argv[++i];
    else if (a === "--timeout") args.timeoutMs = Number(argv[++i]);
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--thinking") args.thinking = argv[++i];
    else if (a === "--judge-model") args.judgeModel = argv[++i];
    else if (a === "--judge-thinking") args.judgeThinking = argv[++i];
    else if (a === "--max-findings") args.maxFindings = Number(argv[++i]);
    else if (a === "--max-candidate-findings") args.maxCandidateFindings = Number(argv[++i]);
    else if (a === "--only-arm") args.onlyArm = argv[++i];
    else if (a === "--merge-runs") args.mergeRuns = [argv[++i], argv[++i]];
    else if (a === "--skip-run") args.skipRun = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadTasks() {
  const tasks = readJson(join(evalDir, "tasks.json"));
  if (!Array.isArray(tasks)) throw new Error("tasks.json must be an array");
  return tasks;
}

function getTask(id) {
  const task = loadTasks().find((item) => item.id === id);
  if (!task) throw new Error(`Task not found: ${id}`);
  return task;
}

function validateTask(task) {
  const errors = [];
  if (!task.localPath || !existsSync(task.localPath)) errors.push(`localPath missing: ${task.localPath}`);
  if (!task.referencePath || !existsSync(resolve(repoRoot, task.referencePath))) errors.push(`referencePath missing: ${task.referencePath}`);
  if (!task.arms?.A || !task.arms?.B) errors.push("task must define arms A and B");
  if (!Array.isArray(task.riskAreas) || task.riskAreas.length === 0) errors.push("task must define riskAreas");
  return errors;
}

function piArgs(promptText, extraArgs = []) {
  return [
    "--offline",
    "--no-session",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    ...extraArgs,
    "-p",
    promptText,
  ];
}

function piEnv(role = "disabled") {
  return { ...process.env, PI_WORKFLOW_ROLE: role };
}

function runPi(promptText, extraArgs = [], options = {}) {
  const result = spawnSync("pi", piArgs(promptText, extraArgs), {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    maxBuffer: PI_MAX_OUTPUT_BUFFER,
    env: piEnv(options.role ?? "disabled"),
  });
  return {
    status: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function candidateExtraArgs(args, task) {
  const extra = ["--tools", "read,grep,find,ls"];
  if (args.model || task.model) extra.push("--model", args.model ?? task.model);
  if (args.thinking || task.thinking) extra.push("--thinking", args.thinking ?? task.thinking);
  return extra;
}

function judgeExtraArgs(args) {
  const extra = ["--tools", "read,grep,find,ls"];
  if (args.judgeModel) extra.push("--model", args.judgeModel);
  if (args.judgeThinking) extra.push("--thinking", args.judgeThinking);
  return extra;
}

function workflowExtraArgs(args, task) {
  const extra = ["--no-extensions", "--extension", repoRoot];
  if (args.model || task.model) extra.push("--model", args.model ?? task.model);
  if (args.thinking || task.thinking) extra.push("--thinking", args.thinking ?? task.thinking);
  return extra;
}

function quote(value) {
  return JSON.stringify(String(value));
}

function candidateTaskText(task, args) {
  const capLine = Number.isFinite(args.maxCandidateFindings)
    ? `- Return at most ${args.maxCandidateFindings} substantive findings.`
    : "- Return all substantive findings you can support with repository evidence; do not impose an artificial finding count cap.";
  return `${task.task}\n\nRepository path: ${task.localPath}\nRisk areas: ${JSON.stringify(task.riskAreas)}\n\nOutput requirements for this evaluation:\n${capLine}\n- Prioritize high/medium security impact over low-severity hardening, but do not drop distinct evidence-backed findings solely because there are many.\n- For each finding include severity, affected file(s), evidence, impact, and recommended fix.\n- If you hit time/context limits, return the strongest findings found so far rather than continuing exploration.`;
}

function extractRunId(text) {
  const match = text.match(RUN_ID_RE);
  return match?.[0] ?? null;
}

function runArm(task, armKey, arm, args, armDir) {
  if (arm.type === "plain") return runPlainArm(task, armKey, args, armDir);
  if (arm.type === "workflow") return runWorkflowArm(task, armKey, arm, args, armDir);
  throw new Error(`Unsupported arm type for ${armKey}: ${arm.type}`);
}

function runPlainArm(task, armKey, args, armDir) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const result = runPi(candidateTaskText(task, args), candidateExtraArgs(args, task), { role: "disabled", cwd: task.localPath });
  const completedAt = new Date().toISOString();
  const text = `${result.stdout}\n${result.stderr}`.trim();
  writeFileSync(join(armDir, "candidate-output.md"), text || "(empty)", "utf8");
  writeFileSync(join(armDir, "candidate-process.json"), `${JSON.stringify({ status: result.status, startedAt, completedAt, elapsedMs: Date.now() - started }, null, 2)}\n`, "utf8");
  return {
    armKey,
    configured: "plain:single-pi",
    status: result.status === 0 ? "completed" : "failed",
    runId: null,
    finalText: text,
    metadata: { taskCount: 1, completedTaskCount: result.status === 0 ? 1 : 0, failedTaskCount: result.status === 0 ? 0 : 1, wallClockMs: Date.now() - started },
  };
}

function runWorkflowArm(task, armKey, arm, args, armDir) {
  const workflowRef = writeGeneratedWorkflowSpecIfNeeded(task, arm, args, armDir);
  const runPrompt = `/workflow run ${workflowRef} ${quote(candidateTaskText(task, args))}`;
  const launch = runPi(runPrompt, workflowExtraArgs(args, task), { role: "supervisor", cwd: task.localPath });
  writeFileSync(join(armDir, "workflow-launch.txt"), `${launch.stdout}\n${launch.stderr}`.trim(), "utf8");
  if (launch.status !== 0) throw new Error(`workflow launch failed for ${arm.name}:\n${launch.stdout}\n${launch.stderr}`);
  const runId = extractRunId(`${launch.stdout}\n${launch.stderr}`);
  if (!runId) throw new Error(`Could not extract workflow run id for ${arm.name}`);
  const wait = runPi(`/workflow wait ${runId} ${args.timeoutMs}`, workflowExtraArgs(args, task), { role: "supervisor", cwd: task.localPath });
  writeFileSync(join(armDir, "workflow-wait.txt"), `${wait.stdout}\n${wait.stderr}`.trim(), "utf8");
  if (wait.status !== 0) throw new Error(`workflow wait failed for ${runId}:\n${wait.stdout}\n${wait.stderr}`);
  const collected = collectWorkflowFinal(runId, task.localPath);
  writeFileSync(join(armDir, "candidate-output.md"), collected.finalText || "(empty)", "utf8");
  writeFileSync(join(armDir, "workflow-run-summary.json"), `${JSON.stringify(collected.summary, null, 2)}\n`, "utf8");
  return {
    armKey,
    configured: `workflow:${arm.name}`,
    status: collected.summary.status,
    runId,
    finalText: collected.finalText,
    metadata: collected.summary,
  };
}

function writeGeneratedWorkflowSpecIfNeeded(task, arm, args, armDir) {
  if (!args.model && !args.thinking) return arm.name;
  const sourcePath = join(repoRoot, "workflows", `${arm.name}.json`);
  if (!existsSync(sourcePath)) throw new Error(`workflow spec not found for model override: ${sourcePath}`);
  const spec = readJson(sourcePath);
  if (args.model) spec.model = args.model;
  if (args.thinking) spec.thinking = args.thinking;
  mkdirSync(generatedDir, { recursive: true });
  const generatedPath = join(generatedDir, `${task.id}-${arm.name}-${Date.now()}.json`);
  writeFileSync(generatedPath, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
  writeFileSync(join(armDir, "generated-workflow-spec.json"), `${JSON.stringify({ sourcePath, generatedPath, model: args.model, thinking: args.thinking }, null, 2)}\n`, "utf8");
  return generatedPath;
}

function collectWorkflowFinal(runId, workflowCwd = repoRoot) {
  const runPath = join(workflowCwd, ".pi", "workflows", runId, "run.json");
  const run = readJson(runPath);
  const tasks = Array.isArray(run.tasks) ? run.tasks : [];
  const preferred = [...tasks].reverse().find((task) => task.stageId === "report" || /report|final|summary/i.test(task.specId ?? ""))
    ?? [...tasks].reverse().find((task) => task.status === "completed")
    ?? tasks.at(-1);
  let finalText = "";
  let structured;
  if (preferred?.files?.result) {
    const resultPath = resolve(workflowCwd, preferred.files.result);
    const result = existsSync(resultPath) ? readJson(resultPath) : undefined;
    structured = result?.structuredOutput;
    if (structured !== undefined) finalText += `# structuredOutput\n\n${JSON.stringify(structured, null, 2)}\n\n`;
  }
  if (preferred?.files?.output) {
    const outputPath = resolve(workflowCwd, preferred.files.output);
    if (existsSync(outputPath)) finalText += readFileSync(outputPath, "utf8");
  }
  if (!finalText.trim()) finalText = collectPartialWorkflowOutput(workflowCwd, tasks);
  return {
    finalText: finalText.trim(),
    summary: {
      runId,
      status: run.status,
      type: run.type,
      taskCount: tasks.length,
      completedTaskCount: run.taskSummary?.completed ?? tasks.filter((task) => task.status === "completed").length,
      failedTaskCount: run.taskSummary?.failed ?? tasks.filter((task) => task.status === "failed").length,
      blockedTaskCount: run.taskSummary?.blocked ?? tasks.filter((task) => task.status === "blocked").length,
      interruptedTaskCount: run.taskSummary?.interrupted ?? tasks.filter((task) => task.status === "interrupted").length,
      finalTask: preferred?.taskId,
      finalSpecId: preferred?.specId,
    },
  };
}

function collectPartialWorkflowOutput(workflowCwd, tasks) {
  const sections = [];
  for (const task of tasks) {
    if (task.status !== "completed") continue;
    if (task.stageId !== "reviewers" && task.stageId !== "devil-advocate") continue;
    const outputPath = task.files?.output ? resolve(workflowCwd, task.files.output) : undefined;
    if (!outputPath || !existsSync(outputPath)) continue;
    const text = readFileSync(outputPath, "utf8").trim();
    if (!text) continue;
    sections.push(`## Partial workflow output: ${task.specId}\n\n${text}`);
  }
  return sections.length ? `# Partial workflow output fallback\n\nFinal report was empty or unavailable; using completed reviewer/devil-advocate task outputs.\n\n${sections.join("\n\n")}` : "";
}

function truncate(text, maxChars) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[TRUNCATED ${text.length - maxChars} chars]`;
}

function extractJson(text) {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n?```/i);
  const candidates = [];
  if (fence) candidates.push(fence[1].trim());
  candidates.push(trimmed);
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch {}
  }
  throw new Error(`Could not parse JSON from text prefix: ${trimmed.slice(0, 200)}`);
}

function runExtraction(task, armResult, args, armDir) {
  const promptTemplate = readFileSync(join(evalDir, "prompts", "finding-extractor.md"), "utf8");
  const prompt = [
    promptTemplate,
    "# Task",
    JSON.stringify({ taskId: task.id, task: task.task, riskAreas: task.riskAreas }, null, 2),
    "# Arm",
    JSON.stringify({ armLabel: armResult.configured }, null, 2),
    "# Candidate Review Output",
    truncate(armResult.finalText || "", 90_000),
  ].join("\n\n");
  const result = runPi(prompt, judgeExtraArgs(args), { role: "disabled" });
  writeFileSync(join(armDir, "extraction-raw.txt"), `${result.stdout}\n${result.stderr}`.trim(), "utf8");
  if (result.status !== 0) throw new Error(`extraction failed for ${armResult.configured}`);
  const parsed = extractJson(`${result.stdout}\n${result.stderr}`);
  writeFileSync(join(armDir, "extracted-findings.json"), `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return parsed;
}

function compactReference(reference) {
  return {
    taskId: reference.taskId,
    riskAreas: reference.riskAreas?.map((area) => ({ id: area.id, name: area.name, mustInspect: area.mustInspect })) ?? [],
    referenceFindings: reference.referenceFindings?.map((finding) => ({
      id: finding.id,
      category: finding.category,
      title: finding.title,
      severity: finding.severity,
      claim: finding.claim,
      evidence: finding.evidence?.map((e) => ({ path: e.path, symbolOrLines: e.symbolOrLines })) ?? [],
      matchHints: finding.matchHints,
      credit: finding.credit,
    })) ?? [],
    noIssueExpectations: reference.noIssueExpectations?.map((item) => ({ id: item.id, category: item.category, claim: item.claim })) ?? [],
  };
}

function runVerification(task, reference, extraction, finding, args, armDir) {
  const promptTemplate = readFileSync(join(evalDir, "prompts", "finding-verifier.md"), "utf8");
  const category = task.riskAreas.find((area) => area.id === finding.category);
  const likelyFiles = [...new Set([...(finding.evidence ?? []), ...(category?.mustInspect ?? [])])].slice(0, 12);
  const prompt = [
    promptTemplate,
    "# Repository",
    task.localPath,
    "# Task and risk areas",
    JSON.stringify({ taskId: task.id, task: task.task, riskAreas: task.riskAreas }, null, 2),
    "# Compact hidden reference audit",
    JSON.stringify(compactReference(reference), null, 2),
    "# Candidate finding to verify",
    JSON.stringify(finding, null, 2),
    "# Suggested files to inspect",
    JSON.stringify(likelyFiles.map((p) => p.startsWith("/") ? p : join(task.localPath, p)), null, 2),
  ].join("\n\n");
  const result = runPi(prompt, judgeExtraArgs(args), { role: "disabled" });
  const safeId = String(finding.id ?? randomUUID()).replace(/[^a-zA-Z0-9._-]+/g, "_");
  writeFileSync(join(armDir, `verify-${safeId}-raw.txt`), `${result.stdout}\n${result.stderr}`.trim(), "utf8");
  if (result.status !== 0) {
    return { findingId: finding.id, verdict: "NEEDS_HUMAN", notes: `verifier process failed status=${result.status}` };
  }
  try {
    const parsed = extractJson(`${result.stdout}\n${result.stderr}`);
    writeFileSync(join(armDir, `verify-${safeId}.json`), `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    return parsed;
  } catch (error) {
    return { findingId: finding.id, verdict: "NEEDS_HUMAN", notes: `verifier JSON parse failed: ${error.message}` };
  }
}

function verifyArmFindings(task, reference, extraction, args, armDir) {
  const allFindings = Array.isArray(extraction.findings) ? extraction.findings : [];
  const findings = Number.isFinite(args.maxFindings) ? allFindings.slice(0, args.maxFindings) : allFindings;
  const adjudications = [];
  for (const finding of findings) adjudications.push(runVerification(task, reference, extraction, finding, args, armDir));
  writeFileSync(join(armDir, "adjudications.json"), `${JSON.stringify(adjudications, null, 2)}\n`, "utf8");
  return adjudications;
}

const severityOrder = ["info", "low", "medium", "high", "critical"];
function severityDistance(a, b) {
  const ai = severityOrder.indexOf(String(a ?? "").toLowerCase());
  const bi = severityOrder.indexOf(String(b ?? "").toLowerCase());
  if (ai < 0 || bi < 0) return 99;
  return Math.abs(ai - bi);
}

function scoreArm(task, reference, extraction, adjudications) {
  const refCredit = new Map((reference.referenceFindings ?? []).map((finding) => [finding.id, Number(finding.credit ?? 1)]));
  const totalCredit = [...refCredit.values()].reduce((a, b) => a + b, 0) || 1;
  const matched = new Set();
  for (const adj of adjudications) for (const id of adj.matchesReference ?? []) if (refCredit.has(id)) matched.add(id);
  const matchedCredit = [...matched].reduce((sum, id) => sum + refCredit.get(id), 0);
  const weightedReferenceRecall = matchedCredit / totalCredit;

  const valid = adjudications.filter((adj) => adj.verdict === "VALID");
  const partial = adjudications.filter((adj) => adj.verdict === "PARTIAL");
  const creditable = adjudications.filter((adj) => adj.verdict === "VALID" || adj.verdict === "PARTIAL");
  const invalid = adjudications.filter((adj) => adj.verdict === "INVALID" || adj.isFalsePositive === true);
  const needsHuman = adjudications.filter((adj) => adj.verdict === "NEEDS_HUMAN");
  const nitpicks = adjudications.filter((adj) => adj.isNitpick === true);
  const newValid = valid.filter((adj) => !Array.isArray(adj.matchesReference) || adj.matchesReference.length === 0);
  const newPartial = partial.filter((adj) => !Array.isArray(adj.matchesReference) || adj.matchesReference.length === 0);
  const newValidCredit = newValid.length + 0.5 * newPartial.length;
  const categories = new Set();
  for (const adj of adjudications) {
    if (adj.verdict === "VALID" || adj.verdict === "PARTIAL" || (adj.matchesReference ?? []).length > 0) categories.add(adj.category);
  }
  for (const cov of extraction.noIssueCoverage ?? []) categories.add(cov.category);
  const categoryCoverage = categories.size / Math.max(1, task.riskAreas.length);
  const nonDroppedCount = Math.max(1, (extraction.findings ?? []).length);
  const evidenceValidityRate = adjudications.filter((adj) => adj.evidenceExists !== false && adj.verdict !== "INVALID").length / Math.max(1, adjudications.length || nonDroppedCount);
  const severityCalibrationRate = adjudications.length === 0 ? 0 : adjudications.filter((adj) => {
    const finding = (extraction.findings ?? []).find((f) => f.id === adj.findingId);
    return severityDistance(finding?.severity, adj.severityAssessment) <= 1;
  }).length / adjudications.length;
  const actionabilityRate = creditable.length === 0 ? 0 : creditable.filter((adj) => adj.actionableFix === true).length / creditable.length;
  const rawScore =
    30 * weightedReferenceRecall +
    15 * Math.min(1, newValidCredit / 3) +
    15 * categoryCoverage +
    15 * evidenceValidityRate +
    10 * severityCalibrationRate +
    10 * actionabilityRate -
    5 * invalid.length -
    2 * nitpicks.length;
  return {
    score: Math.max(0, Math.min(100, rawScore)),
    weightedReferenceRecall,
    matchedReference: [...matched].sort(),
    missedReference: [...refCredit.keys()].filter((id) => !matched.has(id)).sort(),
    validFindingCount: valid.length,
    partialFindingCount: partial.length,
    newValidFindingCount: newValidCredit,
    falsePositiveCount: invalid.length,
    needsHumanCount: needsHuman.length,
    nitpickCount: nitpicks.length,
    categoryCoverage,
    coveredCategories: [...categories].filter(Boolean).sort(),
    evidenceValidityRate,
    severityCalibrationRate,
    actionabilityRate,
  };
}

function writeReport(resultDir, task, arms, scores) {
  const lines = [
    "# Review A/B Report",
    "",
    `Task: ${task.id}`,
    `Repo: ${task.localPath}`,
    "",
    "## Scores",
    "",
    "| Arm | Configured | Status | Score | Ref recall | Valid | Partial | New valid credit | False positives | Needs human | Categories |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const arm of arms) {
    const s = scores[arm.armKey];
    lines.push(`| ${arm.armKey} | ${arm.configured} | ${arm.status} | ${s.score.toFixed(1)} | ${(s.weightedReferenceRecall * 100).toFixed(0)}% | ${s.validFindingCount} | ${s.partialFindingCount} | ${s.newValidFindingCount} | ${s.falsePositiveCount} | ${s.needsHumanCount} | ${s.coveredCategories.length}/${task.riskAreas.length} |`);
  }
  const sorted = [...arms].sort((a, b) => scores[b.armKey].score - scores[a.armKey].score);
  const winner = scores[sorted[0].armKey].score === scores[sorted[1]?.armKey]?.score ? "tie" : sorted[0].armKey;
  lines.push("", `Winner by structured score: ${winner}`, "");
  lines.push("## Reference coverage", "");
  for (const arm of arms) {
    const s = scores[arm.armKey];
    lines.push(`### ${arm.armKey} ${arm.configured}`, "", `Matched: ${s.matchedReference.join(", ") || "none"}`, `Missed: ${s.missedReference.join(", ") || "none"}`, "");
  }
  lines.push("## Caveats", "", "- This is an automated experimental evaluator. `NEEDS_HUMAN` and high-impact disagreements should be manually spot-checked.", "- Reference audit is an anchor, not complete ground truth; verified non-reference findings receive credit.", "- Candidate and verifier model/provider settings are recorded in manifest.json.", "");
  writeFileSync(join(resultDir, "report.md"), `${lines.join("\n")}\n`, "utf8");
}

function writeSingleArmReport(resultDir, task, arm, score) {
  const lines = [
    "# Review Single-Arm Report",
    "",
    `Task: ${task.id}`,
    `Repo: ${task.localPath}`,
    "",
    "| Arm | Configured | Status | Score | Ref recall | Valid | Partial | New valid credit | False positives | Needs human | Categories |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    `| ${arm.armKey} | ${arm.configured} | ${arm.status} | ${score.score.toFixed(1)} | ${(score.weightedReferenceRecall * 100).toFixed(0)}% | ${score.validFindingCount} | ${score.partialFindingCount} | ${score.newValidFindingCount} | ${score.falsePositiveCount} | ${score.needsHumanCount} | ${score.coveredCategories.length}/${task.riskAreas.length} |`,
    "",
    "This run used --only-arm, so no A/B winner is computed.",
    "",
    `Matched: ${score.matchedReference.join(", ") || "none"}`,
    `Missed: ${score.missedReference.join(", ") || "none"}`,
    "",
  ];
  writeFileSync(join(resultDir, "report.md"), `${lines.join("\n")}\n`, "utf8");
}

function runDryRun(task, args) {
  const errors = validateTask(task);
  if (errors.length) throw new Error(errors.join("\n"));
  const reference = readJson(resolve(repoRoot, task.referencePath));
  console.log(`Review A/B dry run: ${task.id}`);
  console.log(`  repo: ${task.localPath}`);
  console.log(`  reviewKind: ${task.reviewKind}`);
  console.log(`  arms: ${Object.entries(task.arms).map(([k, arm]) => `${k}=${arm.type}:${arm.name ?? "single-pi"}`).join(" | ")}`);
  console.log(`  riskAreas: ${task.riskAreas.length}`);
  console.log(`  referenceFindings: ${reference.referenceFindings?.length ?? 0}`);
  console.log(`  judge: ${args.judgeModel} / ${args.judgeThinking}`);
  console.log("Plan is valid.");
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function mergeRunReports(task, runDirs) {
  const resolvedDirs = runDirs.map((dir) => resolve(repoRoot, dir));
  const stamp = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15) + "Z";
  const resultDir = join(runsRoot, `merge-${stamp}-${task.id}`);
  mkdirSync(resultDir, { recursive: true });
  const reference = readJson(resolve(repoRoot, task.referencePath));
  const arms = [];
  const scores = {};
  for (const dir of resolvedDirs) {
    const armResults = readJson(join(dir, "arm-results.json"));
    const runScores = existsSync(join(dir, "scores.json")) ? readJson(join(dir, "scores.json")) : {};
    for (const arm of armResults) {
      arms.push({ ...arm, sourceRunDir: relative(repoRoot, dir) });
      const armDir = join(dir, `arm-${arm.armKey}`);
      if (existsSync(join(armDir, "extracted-findings.json")) && existsSync(join(armDir, "adjudications.json"))) {
        scores[arm.armKey] = scoreArm(task, reference, readJson(join(armDir, "extracted-findings.json")), readJson(join(armDir, "adjudications.json")));
      } else {
        scores[arm.armKey] = runScores[arm.armKey];
      }
    }
  }
  if (arms.length < 2) throw new Error("merge-runs needs at least two arm results");
  writeFileSync(join(resultDir, "merged-sources.json"), `${JSON.stringify({ sources: resolvedDirs.map((dir) => relative(repoRoot, dir)), arms }, null, 2)}\n`, "utf8");
  writeFileSync(join(resultDir, "scores.json"), `${JSON.stringify(scores, null, 2)}\n`, "utf8");
  writeFileSync(join(resultDir, "arm-results.json"), `${JSON.stringify(arms, null, 2)}\n`, "utf8");
  writeReport(resultDir, task, arms, scores);
  console.log(`Merged: ${relative(repoRoot, resultDir)}`);
  console.log(readFileSync(join(resultDir, "report.md"), "utf8"));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(usage()); return; }
  if (!args.task) throw new Error("Missing --task.\n" + usage());
  const task = getTask(args.task);
  if (args.mergeRuns) { mergeRunReports(task, args.mergeRuns); return; }
  if (args.dryRun) { runDryRun(task, args); return; }
  if (args.skipRun) throw new Error("--skip-run is reserved but not implemented yet");
  const errors = validateTask(task);
  if (errors.length) throw new Error(errors.join("\n"));
  const stamp = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15) + "Z";
  const resultDir = join(runsRoot, `run-${stamp}-${task.id}`);
  mkdirSync(resultDir, { recursive: true });
  const reference = readJson(resolve(repoRoot, task.referencePath));
  const manifest = {
    schemaVersion: 1,
    taskId: task.id,
    repoRoot,
    resultDir: relative(repoRoot, resultDir),
    taskPath: relative(repoRoot, join(evalDir, "tasks.json")),
    referencePath: task.referencePath,
    referenceSha256: sha256File(resolve(repoRoot, task.referencePath)),
    candidateModel: args.model ?? task.model ?? "default-unresolved",
    candidateThinking: args.thinking ?? task.thinking ?? "default-unresolved",
    judgeModel: args.judgeModel,
    judgeThinking: args.judgeThinking,
    maxFindings: args.maxFindings,
    maxCandidateFindings: args.maxCandidateFindings,
    onlyArm: args.onlyArm,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(join(resultDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const armResults = [];
  const extractions = {};
  const adjudications = {};
  const scores = {};
  for (const [armKey, arm] of Object.entries(task.arms)) {
    if (args.onlyArm && armKey !== args.onlyArm) continue;
    const armDir = join(resultDir, `arm-${armKey}`);
    mkdirSync(armDir, { recursive: true });
    console.log(`Running arm ${armKey}: ${arm.type}:${arm.name ?? "single-pi"}`);
    const armResult = runArm(task, armKey, arm, args, armDir);
    armResults.push(armResult);
    if (armResult.status !== "completed" || !armResult.finalText.trim() || armResult.finalText.trim() === "(empty)") {
      console.log(`Skipping extraction for ${armKey}: arm status=${armResult.status}, final output empty=${!armResult.finalText.trim() || armResult.finalText.trim() === "(empty)"}`);
      const extraction = { schemaVersion: 1, taskId: task.id, armLabel: armResult.configured, findings: [], noIssueCoverage: [], droppedItems: [{ reason: "operational-failure", text: "Candidate review did not produce a usable final output." }] };
      extractions[armKey] = extraction;
      adjudications[armKey] = [];
      writeFileSync(join(armDir, "extracted-findings.json"), `${JSON.stringify(extraction, null, 2)}\n`, "utf8");
      writeFileSync(join(armDir, "adjudications.json"), "[]\n", "utf8");
      scores[armKey] = scoreArm(task, reference, extraction, []);
      continue;
    }
    console.log(`Extracting findings for ${armKey}`);
    const extraction = runExtraction(task, armResult, args, armDir);
    extractions[armKey] = extraction;
    console.log(`Verifying findings for ${armKey}`);
    const adj = verifyArmFindings(task, reference, extraction, args, armDir);
    adjudications[armKey] = adj;
    scores[armKey] = scoreArm(task, reference, extraction, adj);
  }
  writeFileSync(join(resultDir, "arm-results.json"), `${JSON.stringify(armResults, null, 2)}\n`, "utf8");
  writeFileSync(join(resultDir, "scores.json"), `${JSON.stringify(scores, null, 2)}\n`, "utf8");
  if (armResults.length >= 2) writeReport(resultDir, task, armResults, scores);
  else writeSingleArmReport(resultDir, task, armResults[0], scores[armResults[0].armKey]);
  manifest.completedAt = new Date().toISOString();
  writeFileSync(join(resultDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Done: ${relative(repoRoot, resultDir)}`);
  console.log(readFileSync(join(resultDir, "report.md"), "utf8"));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
