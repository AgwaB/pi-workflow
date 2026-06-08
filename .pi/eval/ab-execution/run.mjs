#!/usr/bin/env node
// A/B Execution eval runner.
// Design:  docs/ab-execution-eval-plan.md
// Impl:    docs/ab-execution-impl-plan.md
//
// Runs two execution arms (A and B) on the same task, extracts each arm's final
// output, scores each arm independently with a blind LLM judge, then writes a
// report with blind quality first and hidden operational metadata second.

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const evalDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(evalDir, "..", "..", "..");
const generatedDir = join(evalDir, ".generated");
const resultsRoot = join(evalDir, "runs");

const RUNNER_VERSION = "workflow-v1-ab-runner-2026-06-06";
const SYNTHESIS_KINDS = new Set(["reduce", "aggregate", "synthesize", "dedupe", "select", "rank", "judge", "vote"]);
const DIMENSIONS = ["correctness", "completeness", "evidenceQuality", "actionability", "concision", "calibration"];
const SCORE_TIE_THRESHOLD = 1 / DIMENSIONS.length;
const SCORE_TIE_EPSILON = 1e-9;
const ANSWER_KEY_WINDOW_CHARS = 400;
const DEFECT_MARKERS = [
  "absent",
  "bypass",
  "bypassed",
  "bypasses",
  "disabled",
  "dropped",
  "fails",
  "failure",
  "ignored",
  "ignores",
  "insecure",
  "missing",
  "no longer",
  "not enforced",
  "regression",
  "removed",
  "removes",
  "resource exhaustion",
  "silently",
  "unbounded",
  "unconditional",
  "unconditionally",
  "unsafe",
  "without",
];
const EXPECTED_ADVANTAGES = new Set(["workflow", "plain", "tie", "uncertain"]);
const TASK_CLASSES = new Set([
  "iterative-refinement",
  "verification-heavy-review",
  "coverage-diverse-research",
  "long-horizon-tool-use",
  "clean-partition-implementation",
  "single-synthesis-decision",
  "straight-line-planning",
  "small-contained-task",
  "tightly-coupled-work",
  "ambiguous-specialist-routing",
]);
const RUN_ID_RE = /workflow_[A-Za-z0-9_-]+/;
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const WEB_READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "web_search", "fetch_content", "get_search_content", "scrapling_fetch"];
const NEGATION_RE = /\b(?:not|no|never|cannot|can't|isn't|aren't|wasn't|weren't|doesn't|don't|didn't)\b/;

function parseArgs(argv) {
  const args = {
    dryRun: false,
    task: null,
    timeoutMs: 1_800_000,
    model: null,
    thinking: null,
    judgeModel: null,
    judgeThinking: null,
    rejudge: null,
    selfTest: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--rejudge") args.rejudge = argv[++i];
    else if (a === "--task") args.task = argv[++i];
    else if (a === "--timeout") args.timeoutMs = Number(argv[++i]);
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--thinking") args.thinking = argv[++i];
    else if (a === "--judge-model") args.judgeModel = argv[++i];
    else if (a === "--judge-thinking") args.judgeThinking = argv[++i];
    else if (a === "--self-test") args.selfTest = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

const HELP = `A/B Execution eval runner

Usage:
  node .pi/eval/ab-execution/run.mjs [options]

Options:
  --dry-run                 Validate config and print the plan, launch nothing
  --rejudge <result-dir>    Re-extract and re-judge a prior run's arms, no relaunch
  --task <id>               Run only one task by id
  --timeout <ms>            Per-arm wait timeout (default 1800000)
  --model <model>           Execution model override shared by all arms
  --thinking <level>        Execution thinking override shared by all arms
  --judge-model <model>     Judge model (default: current Pi setting)
  --judge-thinking <level>  Judge thinking level (default: current Pi setting)
  --self-test               Run deterministic runner self-tests, launch nothing
  --help, -h                Show this help
`;

function loadTasks() {
  const tasks = JSON.parse(readFileSync(join(evalDir, "tasks.json"), "utf8"));
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error("tasks.json must be a non-empty array");
  for (const t of tasks) {
    if (!t.id || !t.task || !t.arms?.A || !t.arms?.B) throw new Error(`task ${t.id ?? "?"} missing id/task/arms.A/arms.B`);
    for (const key of Object.keys(t.arms).sort()) {
      const arm = t.arms[key];
      if (!["workflow", "agent", "plain", "parallel5"].includes(arm.type)) throw new Error(`task ${t.id} arm ${key} type must be workflow|agent|plain|parallel5`);
      if ((arm.type === "workflow" || arm.type === "agent") && !arm.name) throw new Error(`task ${t.id} arm ${key} missing name`);
    }
  }
  return tasks;
}

function workflowRoots() {
  return [
    join(repoRoot, ".pi", "workflows"),
    join(repoRoot, "workflows"),
    join(homedir(), ".pi", "agent", "workflows"),
  ];
}

function workflowPath(name) {
  for (const root of workflowRoots()) {
    for (const ext of ["json", "yaml", "yml"]) {
      const p = join(root, `${name}.${ext}`);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

function agentPath(name) {
  const roots = [
    join(repoRoot, ".pi", "agent", "agents"),
    join(homedir(), ".pi", "agent", "agents"),
  ];
  for (const root of roots) {
    const p = join(root, `${name}.md`);
    if (existsSync(p)) return p;
  }
  return null;
}

function validateArm(taskId, key, arm) {
  if (arm.type === "workflow" && !workflowPath(arm.name)) return `task ${taskId} arm ${key}: workflow "${arm.name}" not found`;
  if (arm.type === "agent" && !agentPath(arm.name)) return `task ${taskId} arm ${key}: agent "${arm.name}" not found`;
  if (arm.type === "parallel5" && !agentPath(arm.agent ?? "researcher")) return `task ${taskId} arm ${key}: parallel5 agent "${arm.agent ?? "researcher"}" not found`;
  return null;
}

function pi(promptText, extraArgs = [], options = {}) {
  const extensionArgs = ["--no-extensions", "--extension", repoRoot];
  const baseArgs = [
    "--offline",
    "--no-session",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    ...extensionArgs,
    ...extraArgs,
    "-p",
    promptText,
  ];
  const env = {
    ...process.env,
    PI_WORKFLOW_ROLE: options.role ?? "disabled",
  };
  const result = spawnSync("pi", baseArgs, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return { status: result.status ?? (result.error ? 1 : 0), stdout, stderr, error: result.error };
}

function extractRunId(text) {
  const m = text.match(RUN_ID_RE);
  return m ? m[0] : null;
}

function executionModel(task, args) {
  return args.model ?? task.model ?? null;
}

function executionThinking(task, args) {
  return args.thinking ?? task.thinking ?? null;
}

function effectiveSetting(value) {
  return value ?? "default-unresolved";
}

function quote(value) {
  return JSON.stringify(String(value));
}

function taskToolSet(task) {
  const hasParallelResearch = Object.values(task.arms ?? {}).some((arm) => arm?.type === "parallel5");
  return hasParallelResearch || /research/i.test(task.id) ? WEB_READ_ONLY_TOOLS : READ_ONLY_TOOLS;
}

function writeGeneratedSpec(task, arm, args) {
  mkdirSync(generatedDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const file = join(generatedDir, `${task.id}-${arm.type}-${arm.name}-${stamp}.json`);
  let spec;
  if (arm.type === "agent") {
    spec = {
      schemaVersion: 1,
      name: `ab-${randomUUID()}`,
      description: `A/B eval arm for ${task.id}`,
      readOnly: true,
      tools: taskToolSet(task),
      workflow: {
        stages: [
          {
            id: "main",
            type: "task",
            agent: arm.name,
            readOnly: true,
            tools: taskToolSet(task),
            prompt: "Complete the runtime task. Do not modify files.",
          },
        ],
      },
    };
  } else if (arm.type === "parallel5") {
    const agent = arm.agent ?? "researcher";
    spec = {
      schemaVersion: 1,
      name: `ab-${randomUUID()}`,
      description: `A/B eval naive parallel-5 research arm for ${task.id}`,
      agent,
      readOnly: true,
      tools: taskToolSet(task),
      workflow: {
        stages: [
          {
            id: "research",
            type: "parallel",
            maxConcurrency: 5,
            tasks: [
              { id: "source-landscape", prompt: "Research the source landscape and identify credible primary/benchmark sources for the runtime task. Cite URLs." },
              { id: "methodology", prompt: "Research methodology guidance relevant to the runtime task. Focus on evaluation design and validity threats. Cite URLs." },
              { id: "judge-reliability", prompt: "Research LLM-as-judge reliability, bias, and calibration concerns relevant to the runtime task. Cite URLs." },
              { id: "contamination-repro", prompt: "Research benchmark contamination and reproducibility practices relevant to the runtime task. Cite URLs." },
              { id: "tradeoffs", prompt: "Research multi-agent or workflow-vs-single-agent quality/cost tradeoffs relevant to the runtime task. Cite URLs." }
            ]
          },
          {
            id: "final",
            type: "reduce",
            from: ["research"],
            sourcePolicy: "partial",
            inject: true,
            prompt: "Synthesize the parallel research outputs into one practical final report for the runtime task. Preserve citations, distinguish strong evidence from caveats, and identify unsupported or conflicting claims."
          }
        ]
      }
    };
  } else {
    const p = workflowPath(arm.name);
    if (!p || !p.endsWith(".json")) {
      throw new Error(`model/thinking override for workflow "${arm.name}" requires a JSON workflow in workflows/ or workflows/`);
    }
    spec = JSON.parse(readFileSync(p, "utf8"));
  }
  const model = executionModel(task, args);
  const thinking = executionThinking(task, args);
  if (model) spec.model = model;
  if (thinking) spec.thinking = thinking;
  writeFileSync(file, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
  return file;
}

function directPiArgs(task, args) {
  const extra = ["--tools", taskToolSet(task).join(",")];
  const model = executionModel(task, args);
  const thinking = executionThinking(task, args);
  if (model) extra.push("--model", model);
  if (thinking) extra.push("--thinking", thinking);
  return extra;
}

function launchPlainArm(task, args) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const result = pi(task.task, directPiArgs(task, args), { role: "disabled" });
  const completedAt = new Date().toISOString();
  const text = `${result.stdout}\n${result.stderr}`.trim();
  return {
    kind: "direct",
    final: { taskId: "plain", text },
    metadata: {
      runId: null,
      status: result.status === 0 ? "completed" : "failed",
      taskCount: 1,
      completedTaskCount: result.status === 0 ? 1 : 0,
      failedTaskCount: result.status === 0 ? 0 : 1,
      skippedTaskCount: 0,
      blockedTaskCount: 0,
      interruptedTaskCount: 0,
      sumTaskElapsedMs: Date.now() - started,
      wallClockMs: Date.now() - started,
      startedAt,
      completedAt,
      estimatedTokens: null,
      estimatedCostUsd: null,
    },
  };
}

function launchArm(task, arm, args) {
  if (arm.type === "plain") return launchPlainArm(task, args);

  const override = Boolean(executionModel(task, args) || executionThinking(task, args) || arm.type === "parallel5");
  let runResult;
  if (override) {
    const specPath = writeGeneratedSpec(task, arm, args);
    runResult = pi(`/workflow run ${toRepoPath(specPath)} ${quote(task.task)}`, [], { role: "supervisor" });
  } else if (arm.type === "workflow") {
    runResult = pi(`/workflow run ${arm.name} ${quote(task.task)}`, [], { role: "supervisor" });
  } else {
    runResult = pi(`/workflow delegate ${arm.name} ${quote(task.task)}`, [], { role: "supervisor" });
  }
  const runId = extractRunId(`${runResult.stdout}\n${runResult.stderr}`);
  if (!runId) throw new Error(`could not find run id for ${task.id}/${arm.type}:${arm.name ?? ""}\n${runResult.stdout}\n${runResult.stderr}`);
  return { kind: "workflow", runId };
}

function waitForRun(runId, timeoutMs) {
  const result = pi(`/workflow wait ${runId} ${timeoutMs}`, [], { role: "supervisor" });
  if (result.status !== 0) {
    throw new Error(`workflow wait failed for ${runId}:\n${result.stdout}\n${result.stderr}`.trim());
  }
}

function readRunRecord(runId) {
  const path = join(repoRoot, ".pi", "workflows", runId, "run.json");
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
      raw = structuredToMarkdown(JSON.parse(raw));
    } catch {
      // leave raw as-is
    }
  }
  return { taskId: task.taskId, text: raw.trim() };
}

// Render a structured JSON output into readable markdown so the judge sees the
// full deliverable (e.g. all findings with evidence), not just one field.
function structuredToMarkdown(value) {
  const renderValue = (val) => {
    if (val == null) return "";
    if (typeof val === "string") return val;
    if (typeof val === "number" || typeof val === "boolean") return String(val);
    if (Array.isArray(val)) {
      return val
        .map((item) => {
          if (item && typeof item === "object") {
            return Object.entries(item)
              .map(([k, v]) => `- **${k}**: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
              .join("\n");
          }
          return `- ${String(item)}`;
        })
        .join("\n\n");
    }
    if (typeof val === "object") {
      return Object.entries(val)
        .map(([k, v]) => `**${k}**: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
        .join("\n");
    }
    return String(val);
  };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value)
      .map(([key, val]) => `## ${key}\n${renderValue(val)}`)
      .join("\n\n")
      .trim();
  }
  return renderValue(value);
}

function collectMetadata(run) {
  const tasks = run.tasks ?? [];
  const count = (status) => tasks.filter((t) => t.status === status).length;
  const elapsedMs = tasks.reduce((sum, t) => sum + (Number(t.elapsedMs) || 0), 0);
  const start = run.createdAt ? Date.parse(run.createdAt) : null;
  const end = run.updatedAt ? Date.parse(run.updatedAt) : null;
  return {
    runId: run.runId,
    status: run.status,
    taskCount: tasks.length,
    completedTaskCount: count("completed"),
    failedTaskCount: count("failed"),
    skippedTaskCount: count("skipped"),
    blockedTaskCount: count("blocked"),
    interruptedTaskCount: count("interrupted"),
    sumTaskElapsedMs: elapsedMs,
    wallClockMs: start && end ? end - start : null,
    estimatedTokens: null,
    estimatedCostUsd: null,
  };
}

function normalizeOutput(text) {
  // Strip identifiers and orchestration metadata that could reveal the arm.
  // Keep task-relevant file references and technical evidence intact.
  return text
    .replace(/\.pi\/workflows\/workflow_[^\s)\]}]+/g, ".pi/workflows/<run>/...")
    .replace(/\.pi\/workflows\/workflow_[^\s)\]}]+/g, ".pi/workflows/<run>/...")
    .replace(/workflow_[A-Za-z0-9_-]+/g, "<run>")
    .replace(/workflow_[A-Za-z0-9_-]+/g, "<run>")
    .replace(/\bab-(?!execution\b)[A-Za-z0-9_.-]+\b/g, "<eval-spec>")
    .replace(/^\s*(Run ID|Run path|Workflow|Workflow|Agent|Arm|Mode|Provider\/model):.*$/gim, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\b(workflow arm|workflow arm|agent arm)\b/gi, "execution arm")
    .replace(/\b(single-agent baseline|single agent baseline)\b/gi, "baseline")
    .replace(/\n{3,}/g, "\n\n")
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
  const extra = ["--no-tools"];
  if (args.judgeModel) extra.push("--model", args.judgeModel);
  if (args.judgeThinking) extra.push("--thinking", args.judgeThinking);
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = pi(prompt, extra, { role: "disabled" });
    const parsed = parseJudgeJson(`${res.stdout}\n${res.stderr}`);
    if (parsed) return parsed;
  }
  return { scores: Object.fromEntries(DIMENSIONS.map((d) => [d, 0])), hardFailures: ["invalid-output"], notes: "judge output not parseable after retry" };
}

// Extract every balanced top-level {...} substring from text.
function jsonCandidates(text) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

function parseJudgeJson(text) {
  // Prefer the last candidate that carries a scores object (judge's final answer).
  const candidates = jsonCandidates(text);
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(candidates[i]);
      if (!parsed || typeof parsed !== "object" || !parsed.scores) continue;
      const scores = {};
      for (const d of DIMENSIONS) scores[d] = Number(parsed.scores?.[d]) || 0;
      return { scores, hardFailures: Array.isArray(parsed.hardFailures) ? parsed.hardFailures : [], notes: String(parsed.notes ?? "") };
    } catch {
      // try next candidate
    }
  }
  return null;
}

function mean(scores) {
  if (!scores) return null;
  const vals = DIMENSIONS.map((d) => Number(scores[d] ?? 0));
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function formatMean(value) {
  return value === null || value === undefined || !Number.isFinite(value) ? "unscored" : value.toFixed(2);
}

function deriveMultiWinner(labelScores) {
  const ranked = Object.entries(labelScores)
    .map(([label, score]) => ({ label, hardFailures: score.hardFailures.length, scoreMean: mean(score.scores) }))
    .sort((left, right) => left.hardFailures - right.hardFailures || right.scoreMean - left.scoreMean);
  const best = ranked[0];
  const second = ranked[1];
  if (!best) return "tie";
  if (!second) return best.label;
  if (best.hardFailures < second.hardFailures) return best.label;
  if (best.hardFailures === second.hardFailures && best.scoreMean - second.scoreMean > SCORE_TIE_THRESHOLD + SCORE_TIE_EPSILON) return best.label;
  return "tie";
}

function stripQuotedEvidenceForAnswerKey(text) {
  let inFence = false;
  let inDiff = false;
  const lines = text.split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^\s*diff --git\b/.test(line)) {
      inDiff = true;
      continue;
    }
    if (inDiff && /^\s*(?:@@|index\s|\+\+\+\s|---\s)/.test(line)) continue;
    if (inDiff && /^\s*[+-](?![+-])/.test(line)) continue;
    if (inDiff && /^\s*$/.test(line)) {
      inDiff = false;
      continue;
    }
    if (inDiff) inDiff = false;
    kept.push(line);
  }
  return kept.join("\n");
}

function hasNegationNear(window, term) {
  let index = window.indexOf(term);
  while (index !== -1) {
    const before = window.slice(Math.max(0, index - 40), index);
    if (NEGATION_RE.test(before)) return true;
    index = window.indexOf(term, index + term.length);
  }
  return false;
}

function termsMatchInWindow(text, terms, markers = DEFECT_MARKERS) {
  const lower = text.toLowerCase();
  const normalizedTerms = terms.map((term) => String(term).toLowerCase()).filter(Boolean);
  if (normalizedTerms.length === 0) return false;
  const normalizedMarkers = markers.map((marker) => String(marker).toLowerCase()).filter((marker) => marker && !normalizedTerms.includes(marker));
  const anchor = normalizedTerms.slice().sort((a, b) => b.length - a.length)[0];
  let index = lower.indexOf(anchor);
  while (index !== -1) {
    const start = Math.max(0, index - ANSWER_KEY_WINDOW_CHARS);
    const end = Math.min(lower.length, index + anchor.length + ANSWER_KEY_WINDOW_CHARS);
    const window = lower.slice(start, end);
    const termsPresent = normalizedTerms.every((term) => window.includes(term));
    const markerPresent = normalizedMarkers.some((marker) => window.includes(marker));
    const negated = normalizedTerms.some((term) => hasNegationNear(window, term));
    if (termsPresent && markerPresent && !negated) return true;
    index = lower.indexOf(anchor, index + anchor.length);
  }
  return false;
}

function issueFound(output, issue) {
  const matcherInput = stripQuotedEvidenceForAnswerKey(output);
  const markers = Array.isArray(issue.defectMarkers)
    ? issue.defectMarkers.map((marker) => String(marker).toLowerCase())
    : DEFECT_MARKERS;
  if (Array.isArray(issue.matchAny)) {
    return issue.matchAny.some((terms) => Array.isArray(terms) && termsMatchInWindow(matcherInput, terms, markers));
  }
  if (Array.isArray(issue.matchAll)) return termsMatchInWindow(matcherInput, issue.matchAll, markers);
  return false;
}

function checkAnswerKey(task, arms, resultDir) {
  if (!task.answerKey) return null;
  const issues = Array.isArray(task.answerKey.knownIssues) ? task.answerKey.knownIssues : [];
  if (issues.length === 0) return null;
  const hardFailureIfMissed = new Set(task.answerKey.hardFailureIfMissed ?? []);
  const byArm = {};
  for (const key of armKeys(task)) {
    const output = normalizeOutput(arms[key].final.text);
    const knownIssueResults = issues.map((issue) => {
      const found = issueFound(output, issue);
      return {
        id: issue.id,
        severity: issue.severity,
        found,
        expectedFinding: issue.expectedFinding,
        hardFailureIfMissed: hardFailureIfMissed.has(issue.id),
      };
    });
    const missedHardFailures = knownIssueResults
      .filter((item) => item.hardFailureIfMissed && !item.found)
      .map((item) => item.id);
    byArm[key] = {
      arm: armLabel(task.arms[key]),
      foundCount: knownIssueResults.filter((item) => item.found).length,
      totalCount: knownIssueResults.length,
      missedHardFailures,
      knownIssueResults,
    };
  }
  const keys = armKeys(task);
  const candidates = keys
    .map((key) => ({ key, hardMisses: byArm[key].missedHardFailures.length, foundCount: byArm[key].foundCount }))
    .sort((left, right) => left.hardMisses - right.hardMisses || right.foundCount - left.foundCount);
  let winner = "tie";
  if (candidates.length > 0) {
    const best = candidates[0];
    const second = candidates[1];
    if (!second || best.hardMisses < second.hardMisses || best.foundCount > second.foundCount) winner = best.key;
  }

  const result = {
    taskId: task.id,
    kind: "hidden-answer-key-check",
    matcher: {
      method: "quote-stripped proximity window with defect marker",
      windowChars: ANSWER_KEY_WINDOW_CHARS,
      defaultDefectMarkers: DEFECT_MARKERS,
    },
    winner,
    byArm,
  };
  const internalDir = join(resultDir, "internal", task.id);
  mkdirSync(internalDir, { recursive: true });
  writeFileSync(join(internalDir, "answer-key-results.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

function toRepoPath(p) {
  return relative(repoRoot, p) || p;
}

function armKeys(task) {
  return Object.keys(task.arms).sort();
}

function armLabel(arm) {
  if (arm.type === "plain") return "plain:single-pi";
  if (arm.type === "parallel5") return `parallel5:${arm.agent ?? "researcher"}`;
  return `${arm.type}:${arm.name}`;
}

function runDryRun(tasks, args) {
  const issues = [];
  console.log("A/B Execution eval — dry run\n");
  for (const t of tasks) {
    console.log(`Task: ${t.id}`);
    console.log(`  brief: ${t.task}`);
    for (const key of armKeys(t)) console.log(`  ${key}: ${armLabel(t.arms[key])}`);
    console.log(`  model/thinking: ${executionModel(t, args) ?? "default"} / ${executionThinking(t, args) ?? "default"}`);
    if (t.fixture) console.log(`  fixture: ${t.fixture}`);
    if (t.evaluationHypothesis) console.log(`  hypothesis: expected=${t.evaluationHypothesis.expectedAdvantage} class=${t.evaluationHypothesis.taskClass} drivers=${(t.evaluationHypothesis.drivers ?? []).join(",") || "none"}`);
    if (t.coverageCriteria) console.log("  coverageCriteria: present (for human spot-check)");
    if (t.answerKey) console.log("  answerKey: present (hidden from arms/judge)");
    for (const key of armKeys(t)) {
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

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

function sha256File(path) {
  return existsSync(path) ? sha256Text(readFileSync(path)) : null;
}

function git(args) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if ((result.status ?? 1) !== 0) return null;
  return (result.stdout ?? "").trim();
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8" });
  if ((result.status ?? 1) !== 0) return null;
  return (result.stdout ?? "").trim();
}

function armManifest(arm) {
  const path = arm.type === "workflow" ? workflowPath(arm.name) : arm.type === "agent" ? agentPath(arm.name) : arm.type === "parallel5" ? agentPath(arm.agent ?? "researcher") : null;
  return {
    ...arm,
    path: path ? toRepoPath(path) : null,
    sha256: path ? sha256File(path) : null,
  };
}

function buildManifest(tasks, args) {
  const statusShort = git(["status", "--short"]);
  return {
    schemaVersion: 1,
    runner: "pi-workflow-ab-execution",
    runnerVersion: RUNNER_VERSION,
    createdAt: new Date().toISOString(),
    repoRoot,
    git: {
      commit: git(["rev-parse", "HEAD"]),
      dirty: Boolean(statusShort),
      statusShort,
    },
    runtime: {
      piVersion: commandOutput("pi", ["--version"]),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    config: {
      runnerPath: toRepoPath(join(evalDir, "run.mjs")),
      runnerSha256: sha256File(join(evalDir, "run.mjs")),
      tasksPath: toRepoPath(join(evalDir, "tasks.json")),
      tasksSha256: sha256File(join(evalDir, "tasks.json")),
      rubricSha256: sha256File(join(evalDir, "rubric.md")),
      judgePromptSha256: sha256File(join(evalDir, "judge-prompt.md")),
      scoreTieThreshold: SCORE_TIE_THRESHOLD,
      answerKeyWindowChars: ANSWER_KEY_WINDOW_CHARS,
      executionModelOverride: args.model,
      executionThinkingOverride: args.thinking,
      judgeModelOverride: args.judgeModel,
      judgeThinkingOverride: args.judgeThinking,
      effectiveJudgeModel: effectiveSetting(args.judgeModel),
      effectiveJudgeThinking: effectiveSetting(args.judgeThinking),
    },
    tasks: tasks.map((task) => ({
      id: task.id,
      fixture: task.fixture ?? null,
      fixtureSha256: task.fixture ? sha256File(resolve(repoRoot, task.fixture)) : null,
      answerKeyPresent: Boolean(task.answerKey),
      coverageCriteriaPresent: Boolean(task.coverageCriteria),
      evaluationHypothesis: task.evaluationHypothesis ?? null,
      evaluationHypothesis: task.evaluationHypothesis ?? null,
      model: executionModel(task, args),
      thinking: executionThinking(task, args),
      effectiveModel: effectiveSetting(executionModel(task, args)),
      effectiveThinking: effectiveSetting(executionThinking(task, args)),
      coverageCriteriaKind: task.coverageCriteria ? "human-spot-check" : null,
      sharedToolSet: taskToolSet(task),
      arms: Object.fromEntries(armKeys(task).map((key) => [key, armManifest(task.arms[key])])),
    })),
  };
}

function writeManifest(resultDir, tasks, args) {
  writeFileSync(join(resultDir, "manifest.json"), `${JSON.stringify(buildManifest(tasks, args), null, 2)}\n`, "utf8");
}

function writeArmArtifacts(task, key, armResult, resultDir) {
  const armDir = join(resultDir, "internal", task.id, `arm-${key.toLowerCase()}`);
  mkdirSync(armDir, { recursive: true });
  writeFileSync(join(armDir, "output.md"), `${armResult.final.text}\n`, "utf8");
  writeFileSync(join(armDir, "metadata.json"), `${JSON.stringify(armResult.metadata, null, 2)}\n`, "utf8");
}

function buildArmFromWorkflowRun(task, key, runId, resultDir) {
  const arm = task.arms[key];
  const run = readRunRecord(runId);
  const final = extractFinalOutput(run);
  const metadata = collectMetadata(run);
  const armResult = { arm, runId, run, final, metadata };
  writeArmArtifacts(task, key, armResult, resultDir);
  return armResult;
}

function runTask(task, args, resultDir) {
  console.log(`\n=== Task: ${task.id} ===`);
  const arms = {};
  for (const key of armKeys(task)) {
    const arm = task.arms[key];
    console.log(`  [${key}] launching ${armLabel(arm)} ...`);
    const launched = launchArm(task, arm, args);
    if (launched.kind === "direct") {
      const armResult = { arm, runId: null, run: null, final: launched.final, metadata: launched.metadata };
      writeArmArtifacts(task, key, armResult, resultDir);
      arms[key] = armResult;
    } else {
      waitForRun(launched.runId, args.timeoutMs);
      arms[key] = buildArmFromWorkflowRun(task, key, launched.runId, resultDir);
    }
  }
  return scoreTask(task, arms, args, resultDir);
}

function rejudgeTask(task, args, sourceDir, resultDir) {
  console.log(`\n=== Rejudge: ${task.id} ===`);
  const arms = {};
  for (const key of armKeys(task)) {
    const armDir = join(sourceDir, "internal", task.id, `arm-${key.toLowerCase()}`);
    const metaPath = join(armDir, "metadata.json");
    if (!existsSync(metaPath)) throw new Error(`missing prior run for ${task.id} arm ${key}: ${toRepoPath(metaPath)}`);
    const metadata = JSON.parse(readFileSync(metaPath, "utf8"));
    if (metadata.runId) {
      console.log(`  [${key}] re-extracting ${armLabel(task.arms[key])} from ${metadata.runId}`);
      arms[key] = buildArmFromWorkflowRun(task, key, metadata.runId, resultDir);
    } else {
      console.log(`  [${key}] reusing direct output for ${armLabel(task.arms[key])}`);
      const outputPath = join(armDir, "output.md");
      const final = { taskId: "plain", text: existsSync(outputPath) ? readFileSync(outputPath, "utf8").trim() : "" };
      const armResult = { arm: task.arms[key], runId: null, run: null, final, metadata };
      writeArmArtifacts(task, key, armResult, resultDir);
      arms[key] = armResult;
    }
  }
  return scoreTask(task, arms, args, resultDir);
}

function blindLabelSources(task, resultDir) {
  const sourceKeys = armKeys(task);
  const labels = sourceKeys.map((_, index) => String.fromCharCode("A".charCodeAt(0) + index));
  return labels
    .map((label) => ({ label, sortKey: sha256Text(`${toRepoPath(resultDir)}:${task.id}:${label}`) }))
    .sort((left, right) => left.sortKey.localeCompare(right.sortKey))
    .reduce((mapping, item, index) => {
      mapping[item.label] = sourceKeys[index];
      return mapping;
    }, {});
}

function scoreTask(task, arms, args, resultDir) {
  const labelSources = blindLabelSources(task, resultDir);

  // Blind package
  const blindDir = join(resultDir, "blind", task.id);
  mkdirSync(blindDir, { recursive: true });
  writeFileSync(join(blindDir, "task.md"), `${task.task}\n`, "utf8");
  const blindLabels = Object.keys(labelSources).sort();
  for (const label of blindLabels) {
    const source = labelSources[label];
    writeFileSync(join(blindDir, `output-${label}.md`), `${normalizeOutput(arms[source].final.text)}\n`, "utf8");
  }

  const internalDir = join(resultDir, "internal", task.id);
  writeFileSync(join(internalDir, "mapping.json"), `${JSON.stringify({
    blindLabels: Object.fromEntries(blindLabels.map((label) => [label, armLabel(task.arms[labelSources[label]])])),
    configuredArms: Object.fromEntries(armKeys(task).map((key) => [key, armLabel(task.arms[key])])),
    labelSources,
  }, null, 2)}\n`, "utf8");
  if (task.answerKey) {
    writeFileSync(join(internalDir, "answer-key.json"), `${JSON.stringify(task.answerKey, null, 2)}\n`, "utf8");
  }

  // Independent blind scoring
  const labelScores = Object.fromEntries(blindLabels.map((label) => [label, judgeArm(task.task, normalizeOutput(arms[labelSources[label]].final.text), args)]));
  const labelMeans = Object.fromEntries(blindLabels.map((label) => [label, mean(labelScores[label].scores)]));
  const winner = deriveMultiWinner(labelScores);
  const winnerArm = winner === "tie" || winner === "unscored" ? winner : labelSources[winner];
  const scores = {
    taskId: task.id,
    blindLabelSources: labelSources,
    labels: labelScores,
    means: labelMeans,
    tieThreshold: SCORE_TIE_THRESHOLD,
    tieEpsilon: SCORE_TIE_EPSILON,
    winner,
    winnerArm,
  };
  const scoresDir = join(resultDir, "scores");
  mkdirSync(scoresDir, { recursive: true });
  writeFileSync(join(scoresDir, `${task.id}.json`), `${JSON.stringify(scores, null, 2)}\n`, "utf8");

  const answerKey = checkAnswerKey(task, arms, resultDir);

  console.log(`  winner: blind ${winner} (${blindLabels.map((label) => `${label}=${formatMean(scores.means[label])}`).join(", ")})`);
  if (answerKey) console.log(`  answer-key winner: configured ${answerKey.winner}`);
  return { task, arms, scores, answerKey };
}

function hasWinningConfiguredArm(scores) {
  return scores.winner !== "tie" && scores.winner !== "unscored" && Boolean(scores.winnerArm);
}

function formatEvaluationHypothesis(task) {
  const h = task.evaluationHypothesis;
  if (!h) return null;
  return [
    `expected=${h.expectedAdvantage}`,
    `class=${h.taskClass}`,
    `drivers=${(h.drivers ?? []).join(", ") || "none"}`,
    `risks=${(h.riskFactors ?? []).join(", ") || "none"}`,
  ].join("; ");
}

function configuredWinnerType(result) {
  if (!hasWinningConfiguredArm(result.scores)) return result.scores.winner;
  return result.task.arms[result.scores.winnerArm]?.type ?? "unknown";
}

function hypothesisOutcome(result) {
  const expected = result.task.evaluationHypothesis?.expectedAdvantage;
  if (!expected) return "unclassified";
  const winnerType = configuredWinnerType(result);
  if (winnerType === "unscored") return "unscored";
  if (winnerType === "tie") return expected === "tie" || expected === "uncertain" ? "consistent" : "tie";
  if (expected === "uncertain") return "informative";
  return winnerType === expected ? "consistent" : "surprising";
}

function taskFitSummary(results) {
  const rows = new Map();
  for (const result of results) {
    const h = result.task.evaluationHypothesis;
    if (!h) continue;
    const key = `${h.expectedAdvantage} / ${h.taskClass}`;
    const row = rows.get(key) ?? { tasks: 0, consistent: 0, surprising: 0, tie: 0, informative: 0, unscored: 0 };
    row.tasks += 1;
    row[hypothesisOutcome(result)] += 1;
    rows.set(key, row);
  }
  return [...rows.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function writeReport(results, resultDir) {
  const blind = ["# A/B Execution Report", ""];
  const fitRows = taskFitSummary(results);
  if (fitRows.length > 0) {
    blind.push("## 0. Task-Fit Hypothesis Summary", "");
    for (const [key, row] of fitRows) {
      blind.push(`- ${key}: tasks=${row.tasks} consistent=${row.consistent} surprising=${row.surprising} tie=${row.tie} informative=${row.informative} unscored=${row.unscored}`);
    }
    blind.push("");
  }
  blind.push("## 1. Blind Output Quality", "");
  for (const r of results) {
    blind.push(`### ${r.task.id}`);
    blind.push(`- winner: blind ${r.scores.winner}`);
    for (const label of Object.keys(r.scores.labels).sort()) {
      const score = r.scores.labels[label];
      blind.push(`- blind ${label} mean: ${r.scores.means[label].toFixed(2)}  hardFailures: ${score.hardFailures.join(", ") || "none"}`);
    }
    blind.push("");
  }
  blind.push("## 2. System / Operational Analysis (mapping revealed)", "");
  for (const r of results) {
    blind.push(`### ${r.task.id}`);
    const hypothesis = formatEvaluationHypothesis(r.task);
    if (hypothesis) {
      blind.push(`- task-fit hypothesis: ${hypothesis}`);
      if (r.task.evaluationHypothesis?.reason) blind.push(`- hypothesis reason: ${r.task.evaluationHypothesis.reason}`);
      blind.push(`- hypothesis outcome: ${hypothesisOutcome(r)} (configured winner type: ${configuredWinnerType(r)})`);
    }
    blind.push(`- configured arms: ${armKeys(r.task).map((key) => `${key}=${armLabel(r.task.arms[key])}`).join(" | ")}`);
    blind.push(`- blind labels: ${Object.keys(r.scores.blindLabelSources).sort().map((label) => `${label}=${armLabel(r.task.arms[r.scores.blindLabelSources[label]])}`).join(" | ")}`);
    if (hasWinningConfiguredArm(r.scores)) blind.push(`- winning configured arm: ${r.scores.winnerArm} (${armLabel(r.task.arms[r.scores.winnerArm])})`);
    else if (r.scores.winner === "unscored") blind.push("- winning configured arm: unscored (judge unavailable)");
    for (const key of armKeys(r.task)) {
      const m = r.arms[key].metadata;
      blind.push(`- configured ${key} ${armLabel(r.task.arms[key])}: status=${m.status} tasks=${m.taskCount} completed=${m.completedTaskCount} failed=${m.failedTaskCount} skipped=${m.skippedTaskCount} blocked=${m.blockedTaskCount}`);
    }
    if (r.task.coverageCriteria) {
      blind.push("- coverage criteria: present; human spot-check required (not machine-gated)");
    }
    if (r.answerKey) {
      blind.push(`- hidden answer-key winner: ${r.answerKey.winner}`);
      for (const key of armKeys(r.task)) {
        const ak = r.answerKey.byArm[key];
        blind.push(`- configured ${key} answer-key coverage: ${ak.foundCount}/${ak.totalCount}; missed hard failures: ${ak.missedHardFailures.join(", ") || "none"}`);
      }
    }
    blind.push("");
  }
  writeFileSync(join(resultDir, "report.md"), `${blind.join("\n")}\n`, "utf8");
  console.log(`\nReport: ${toRepoPath(join(resultDir, "report.md"))}`);
}

function runSelfTest() {
  const bulletFinding = "- PI_WORKFLOW_ROLE worker role was removed, which is an unsafe regression.";
  const diffOnly = "diff --git a/file b/file\n@@ -1 +1 @@\n- PI_WORKFLOW_ROLE=worker\n+ echo ok\n";
  const negated = "maxConcurrency is respected and not ignored; no regression here.";
  const issue = {
    matchAny: [["PI_WORKFLOW_ROLE", "worker", "removed"]],
    defectMarkers: ["unsafe", "regression", "removed"],
  };
  const maxConcurrencyIssue = {
    matchAny: [["maxConcurrency", "ignored"]],
    defectMarkers: ["unsafe", "regression", "ignored"],
  };
  const checks = [
    ["markdown bullet finding is preserved", issueFound(bulletFinding, issue) === true],
    ["diff hunk evidence is stripped", issueFound(diffOnly, issue) === false],
    ["negated marker is rejected", issueFound(negated, maxConcurrencyIssue) === false],
  ];
  const failed = checks.filter(([, ok]) => !ok);
  for (const [name, ok] of checks) console.log(`${ok ? "ok" : "not ok"} - ${name}`);
  if (failed.length > 0) process.exitCode = 1;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (args.selfTest) {
    runSelfTest();
    return;
  }
  let tasks = loadTasks();
  if (args.task) {
    tasks = tasks.filter((t) => t.id === args.task);
    if (tasks.length === 0) throw new Error(`task not found: ${args.task}`);
  }
  if (args.dryRun) {
    runDryRun(tasks, args);
    return;
  }
  if (args.rejudge) {
    const sourceDir = resolve(repoRoot, args.rejudge);
    const resultDir = newResultDir();
    writeManifest(resultDir, tasks, args);
    console.log(`Rejudge source: ${toRepoPath(sourceDir)}`);
    console.log(`Results: ${toRepoPath(resultDir)}`);
    const results = [];
    for (const task of tasks) results.push(rejudgeTask(task, args, sourceDir, resultDir));
    writeReport(results, resultDir);
    return;
  }
  const resultDir = newResultDir();
  writeManifest(resultDir, tasks, args);
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
