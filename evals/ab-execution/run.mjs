#!/usr/bin/env node
// A/B Execution eval runner.
// Design:  docs/ab-execution-eval-plan.md
// Impl:    docs/ab-execution-impl-plan.md
//
// Runs two execution arms (A and B) on the same task, extracts each arm's final
// output, scores each arm independently with a blind LLM judge, then writes a
// report with blind quality first and hidden operational metadata second.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const evalDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(evalDir, "..", "..");
const generatedDir = join(evalDir, ".generated");
const resultsRoot = join(evalDir, "results");

const SYNTHESIS_KINDS = new Set(["reduce", "aggregate", "synthesize", "dedupe", "select", "rank", "judge", "vote"]);
const DIMENSIONS = ["correctness", "completeness", "evidenceQuality", "actionability", "concision", "calibration"];
const RUN_ID_RE = /flow_[A-Za-z0-9_-]+/;

function parseArgs(argv) {
  const args = { dryRun: false, task: null, timeoutMs: 1_800_000, judgeModel: null, judgeThinking: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--task") args.task = argv[++i];
    else if (a === "--timeout") args.timeoutMs = Number(argv[++i]);
    else if (a === "--judge-model") args.judgeModel = argv[++i];
    else if (a === "--judge-thinking") args.judgeThinking = argv[++i];
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

const HELP = `A/B Execution eval runner

Usage:
  node evals/ab-execution/run.mjs [options]

Options:
  --dry-run                 Validate config and print the plan, launch nothing
  --task <id>               Run only one task by id
  --timeout <ms>            Per-arm wait timeout (default 1800000)
  --judge-model <model>     Judge model (default: current Pi setting)
  --judge-thinking <level>  Judge thinking level (default: current Pi setting)
  --help, -h                Show this help
`;

function loadTasks() {
  const tasks = JSON.parse(readFileSync(join(evalDir, "tasks.json"), "utf8"));
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error("tasks.json must be a non-empty array");
  for (const t of tasks) {
    if (!t.id || !t.task || !t.arms?.A || !t.arms?.B) throw new Error(`task ${t.id ?? "?"} missing id/task/arms.A/arms.B`);
    for (const key of ["A", "B"]) {
      const arm = t.arms[key];
      if (arm.type !== "recipe" && arm.type !== "agent") throw new Error(`task ${t.id} arm ${key} type must be recipe|agent`);
      if (!arm.name) throw new Error(`task ${t.id} arm ${key} missing name`);
    }
  }
  return tasks;
}

function recipeExists(name) {
  const roots = [
    join(repoRoot, ".pi", "flow-recipes"),
    join(repoRoot, "flows"),
    join(homedir(), ".pi", "agent", "flow-recipes"),
  ];
  return roots.some((root) => ["json", "yaml", "yml"].some((ext) => existsSync(join(root, `${name}.${ext}`))));
}

function agentExists(name) {
  const roots = [
    join(repoRoot, ".pi", "agent", "agents"),
    join(homedir(), ".pi", "agent", "agents"),
  ];
  return roots.some((root) => existsSync(join(root, `${name}.md`)));
}

function validateArm(taskId, key, arm) {
  if (arm.type === "recipe" && !recipeExists(arm.name)) return `task ${taskId} arm ${key}: recipe "${arm.name}" not found`;
  if (arm.type === "agent" && !agentExists(arm.name)) return `task ${taskId} arm ${key}: agent "${arm.name}" not found`;
  return null;
}

function pi(promptText, extraArgs = []) {
  const baseArgs = [
    "--no-session",
    "--no-context-files",
    "-e",
    repoRoot,
    ...extraArgs,
    "-p",
    promptText,
  ];
  const result = spawnSync("pi", baseArgs, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return { status: result.status ?? (result.error ? 1 : 0), stdout, stderr, error: result.error };
}

function extractRunId(text) {
  const m = text.match(RUN_ID_RE);
  return m ? m[0] : null;
}

function writeGeneratedSpec(task, arm) {
  mkdirSync(generatedDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const file = join(generatedDir, `${task.id}-${arm.type}-${arm.name}-${stamp}.json`);
  let spec;
  if (arm.type === "agent") {
    spec = {
      schemaVersion: 2,
      name: `ab-${task.id}-${arm.name}`,
      description: `A/B eval agent arm for ${task.id}`,
      agent: arm.name,
      flow: { stages: [{ id: "main", type: "task", prompt: task.task }] },
    };
  } else {
    const recipePath = ["json", "yaml", "yml"]
      .map((ext) => join(repoRoot, "flows", `${arm.name}.${ext}`))
      .find((p) => existsSync(p));
    if (!recipePath || !recipePath.endsWith(".json")) {
      throw new Error(`model/thinking override for recipe "${arm.name}" requires a JSON recipe in flows/`);
    }
    spec = JSON.parse(readFileSync(recipePath, "utf8"));
  }
  if (task.model) spec.model = task.model;
  if (task.thinking) spec.thinking = task.thinking;
  writeFileSync(file, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
  return file;
}

function launchArm(task, arm) {
  const override = Boolean(task.model || task.thinking);
  let runResult;
  if (override) {
    const specPath = writeGeneratedSpec(task, arm);
    runResult = pi(`/flow run ${toRepoPath(specPath)}`);
  } else if (arm.type === "recipe") {
    runResult = pi(`/flow run ${arm.name}`);
  } else {
    runResult = pi(`/flow delegate ${arm.name} ${JSON.stringify(task.task)}`);
  }
  const runId = extractRunId(`${runResult.stdout}\n${runResult.stderr}`);
  if (!runId) throw new Error(`could not find run id for ${task.id}/${arm.type}:${arm.name}\n${runResult.stdout}\n${runResult.stderr}`);
  return runId;
}

function waitForRun(runId, timeoutMs) {
  pi(`/flow wait ${runId} ${timeoutMs}`);
}

function readRunRecord(runId) {
  const path = join(repoRoot, ".pi", "flows", runId, "run.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

function pickFinalTask(run) {
  const completed = (run.tasks ?? []).filter((t) => t.status === "completed");
  if (completed.length === 0) return null;
  for (let i = completed.length - 1; i >= 0; i--) {
    if (SYNTHESIS_KINDS.has(completed[i].kind)) return completed[i];
  }
  return completed[completed.length - 1];
}

function extractFinalOutput(run) {
  const task = pickFinalTask(run);
  if (!task?.files?.output) return { taskId: task?.taskId ?? null, text: "" };
  const outputPath = join(repoRoot, task.files.output);
  let raw = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "";
  if (task.output?.format === "json") {
    try {
      const parsed = JSON.parse(raw);
      const key = ["finalReport", "report", "summary"].find((k) => typeof parsed[k] === "string");
      if (key) raw = parsed[key];
      else {
        const firstString = Object.values(parsed).find((v) => typeof v === "string");
        if (firstString) raw = firstString;
      }
    } catch {
      // leave raw as-is
    }
  }
  return { taskId: task.taskId, text: raw.trim() };
}

function collectMetadata(run) {
  const tasks = run.tasks ?? [];
  const completed = tasks.filter((t) => t.status === "completed");
  const failed = tasks.filter((t) => t.status === "failed");
  const elapsedMs = tasks.reduce((sum, t) => sum + (Number(t.elapsedMs) || 0), 0);
  const start = run.createdAt ? Date.parse(run.createdAt) : null;
  const end = run.updatedAt ? Date.parse(run.updatedAt) : null;
  return {
    runId: run.runId,
    status: run.status,
    taskCount: tasks.length,
    completedTaskCount: completed.length,
    failedTaskCount: failed.length,
    sumTaskElapsedMs: elapsedMs,
    wallClockMs: start && end ? end - start : null,
    estimatedTokens: null,
    estimatedCostUsd: null,
  };
}

function normalizeOutput(text) {
  // Strip identifiers that could reveal the execution strategy to the judge.
  return text
    .replace(/flow_[A-Za-z0-9_-]+/g, "<run>")
    .replace(/^\s*Spec:.*$/gim, "")
    .replace(/\.pi\/flows\/[^\s)]+/g, "<artifact>")
    .trim();
}

function judgeArm(taskBrief, output, args) {
  const judgePrompt = readFileSync(join(evalDir, "judge-prompt.md"), "utf8");
  const prompt = [
    judgePrompt,
    "\n---\n",
    "## Task brief\n",
    taskBrief,
    "\n## Candidate output\n",
    output || "(empty output)",
  ].join("\n");
  const extra = ["--no-tools", "--no-extensions"];
  if (args.judgeModel) extra.push("--model", args.judgeModel);
  if (args.judgeThinking) extra.push("--thinking", args.judgeThinking);
  const res = pi(prompt, extra);
  return parseJudgeJson(`${res.stdout}\n${res.stderr}`);
}

function parseJudgeJson(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    const parsed = JSON.parse(candidate);
    const scores = {};
    for (const d of DIMENSIONS) scores[d] = Number(parsed.scores?.[d]) || 0;
    return { scores, hardFailures: Array.isArray(parsed.hardFailures) ? parsed.hardFailures : [], notes: String(parsed.notes ?? "") };
  } catch {
    return { scores: Object.fromEntries(DIMENSIONS.map((d) => [d, 0])), hardFailures: ["invalid-output"], notes: "judge output not parseable" };
  }
}

function mean(scores) {
  const vals = DIMENSIONS.map((d) => scores[d]);
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function deriveWinner(scoreA, scoreB) {
  const aFail = scoreA.hardFailures.length > 0;
  const bFail = scoreB.hardFailures.length > 0;
  if (aFail !== bFail) return aFail ? "B" : "A";
  const ma = mean(scoreA.scores);
  const mb = mean(scoreB.scores);
  if (Math.abs(ma - mb) >= 0.01) return ma > mb ? "A" : "B";
  return "tie";
}

function toRepoPath(p) {
  return relative(repoRoot, p) || p;
}

function armLabel(arm) {
  return `${arm.type}:${arm.name}`;
}

function runDryRun(tasks) {
  const issues = [];
  console.log("A/B Execution eval — dry run\n");
  for (const t of tasks) {
    console.log(`Task: ${t.id}`);
    console.log(`  brief: ${t.task}`);
    console.log(`  A: ${armLabel(t.arms.A)}`);
    console.log(`  B: ${armLabel(t.arms.B)}`);
    console.log(`  model/thinking: ${t.model ?? "default"} / ${t.thinking ?? "default"}`);
    for (const key of ["A", "B"]) {
      const issue = validateArm(t.id, key, t.arms[key]);
      if (issue) issues.push(issue);
    }
    console.log("");
  }
  if (issues.length > 0) {
    console.log("Issues:");
    for (const i of issues) console.log(`  - ${i}`);
    process.exitCode = 1;
  } else {
    console.log("All arms resolve. Plan is valid.");
  }
}

function newResultDir() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const dir = join(resultsRoot, `run-${stamp}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runTask(task, args, resultDir) {
  console.log(`\n=== Task: ${task.id} ===`);
  const arms = {};
  for (const key of ["A", "B"]) {
    const arm = task.arms[key];
    console.log(`  [${key}] launching ${armLabel(arm)} ...`);
    const runId = launchArm(task, arm);
    waitForRun(runId, args.timeoutMs);
    const run = readRunRecord(runId);
    const final = extractFinalOutput(run);
    arms[key] = { arm, runId, run, final, metadata: collectMetadata(run) };
    const armDir = join(resultDir, "internal", task.id, `arm-${key.toLowerCase()}`);
    mkdirSync(armDir, { recursive: true });
    writeFileSync(join(armDir, "output.md"), `${final.text}\n`, "utf8");
    writeFileSync(join(armDir, "metadata.json"), `${JSON.stringify(arms[key].metadata, null, 2)}\n`, "utf8");
  }

  // Blind package
  const blindDir = join(resultDir, "blind", task.id);
  mkdirSync(blindDir, { recursive: true });
  writeFileSync(join(blindDir, "task.md"), `${task.task}\n`, "utf8");
  writeFileSync(join(blindDir, "output-A.md"), `${normalizeOutput(arms.A.final.text)}\n`, "utf8");
  writeFileSync(join(blindDir, "output-B.md"), `${normalizeOutput(arms.B.final.text)}\n`, "utf8");

  const internalDir = join(resultDir, "internal", task.id);
  writeFileSync(join(internalDir, "mapping.json"), `${JSON.stringify({ A: armLabel(task.arms.A), B: armLabel(task.arms.B) }, null, 2)}\n`, "utf8");

  // Independent blind scoring
  const scoreA = judgeArm(task.task, normalizeOutput(arms.A.final.text), args);
  const scoreB = judgeArm(task.task, normalizeOutput(arms.B.final.text), args);
  const winner = deriveWinner(scoreA, scoreB);
  const scores = { taskId: task.id, A: scoreA, B: scoreB, means: { A: mean(scoreA.scores), B: mean(scoreB.scores) }, winner };
  const scoresDir = join(resultDir, "scores");
  mkdirSync(scoresDir, { recursive: true });
  writeFileSync(join(scoresDir, `${task.id}.json`), `${JSON.stringify(scores, null, 2)}\n`, "utf8");

  console.log(`  winner: ${winner} (A=${scores.means.A.toFixed(2)}, B=${scores.means.B.toFixed(2)})`);
  return { task, arms, scores };
}

function writeReport(results, resultDir) {
  const blind = ["# A/B Execution Report", "", "## 1. Blind Output Quality", ""];
  for (const r of results) {
    blind.push(`### ${r.task.id}`);
    blind.push(`- winner: ${r.scores.winner}`);
    blind.push(`- A mean: ${r.scores.means.A.toFixed(2)}  hardFailures: ${r.scores.A.hardFailures.join(", ") || "none"}`);
    blind.push(`- B mean: ${r.scores.means.B.toFixed(2)}  hardFailures: ${r.scores.B.hardFailures.join(", ") || "none"}`);
    blind.push("");
  }
  blind.push("## 2. System / Operational Analysis (mapping revealed)", "");
  for (const r of results) {
    blind.push(`### ${r.task.id}`);
    blind.push(`- A = ${armLabel(r.task.arms.A)} | B = ${armLabel(r.task.arms.B)}`);
    for (const key of ["A", "B"]) {
      const m = r.arms[key].metadata;
      blind.push(`- ${key} ${armLabel(r.task.arms[key])}: status=${m.status} tasks=${m.taskCount} wallMs=${m.wallClockMs ?? "?"} sumTaskMs=${m.sumTaskElapsedMs}`);
    }
    blind.push("");
  }
  writeFileSync(join(resultDir, "report.md"), `${blind.join("\n")}\n`, "utf8");
  console.log(`\nReport: ${toRepoPath(join(resultDir, "report.md"))}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  let tasks = loadTasks();
  if (args.task) {
    tasks = tasks.filter((t) => t.id === args.task);
    if (tasks.length === 0) throw new Error(`task not found: ${args.task}`);
  }
  if (args.dryRun) {
    runDryRun(tasks);
    return;
  }
  const resultDir = newResultDir();
  console.log(`Results: ${toRepoPath(resultDir)}`);
  const results = [];
  for (const task of tasks) results.push(runTask(task, args, resultDir));
  writeReport(results, resultDir);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
