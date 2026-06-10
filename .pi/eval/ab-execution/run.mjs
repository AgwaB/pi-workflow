#!/usr/bin/env node
// A/B Execution eval runner.
// Design:  docs/ab-execution-eval-plan.md
// Impl:    docs/ab-execution-impl-plan.md
//
// Runs two execution arms (A and B) on the same task, extracts each arm's final
// output, scores each arm independently with a blind LLM judge, then writes a
// report with blind quality first and hidden operational metadata second.

import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
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
const HARD_FAILURES = new Set([
  "invalid-output",
  "failed-to-complete",
  "modified-files-in-read-only-task",
  "hallucinated-file-path",
  "unsupported-critical-claim",
  "missed-known-critical-issue",
  "unsafe-tool-use",
]);
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
const PLAIN_FINAL_START = "<<<PI_AB_FINAL_ANSWER_START>>>";
const PLAIN_FINAL_END = "<<<PI_AB_FINAL_ANSWER_END>>>";
const EVAL_PATH_RE = /(?:^|[\s`"'(:])(?:\.pi\/eval\/|docs\/ab-execution|docs\/deep-research-|evals\/ab-execution|\.pi\/skill-runs\/review|\.pi\/skill-runs\/implementer)/i;

function parseArgs(argv) {
  const args = {
    dryRun: false,
    task: null,
    timeoutMs: 21_600_000,
    model: null,
    thinking: null,
    workflowDepth: null,
    judgeModel: null,
    judgeThinking: null,
    judgeSamples: 1,
    aaArm: null,
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
    else if (a === "--workflow-depth") args.workflowDepth = argv[++i];
    else if (a === "--judge-model") args.judgeModel = argv[++i];
    else if (a === "--judge-thinking") args.judgeThinking = argv[++i];
    else if (a === "--judge-samples") args.judgeSamples = Math.max(1, Number(argv[++i]) || 1);
    else if (a === "--aa-arm") args.aaArm = argv[++i];
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
  --timeout <ms>            Per-arm wait timeout (default 21600000; 6 hours)
  --model <model>           Execution model override shared by all arms
  --thinking <level>        Execution thinking override shared by all arms
  --workflow-depth <level>  Workflow input.depth override for copied JSON workflow arms (quick|standard|max)
  --judge-model <model>     Judge model (default: current Pi setting)
  --judge-thinking <level>  Judge thinking level (default: current Pi setting)
  --judge-samples <n>       Judge each blind output n times and average scores (default 1)
  --aa-arm <key>            A/A noise-floor mode: score the same configured arm under every blind label
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

const PI_MAX_OUTPUT_BUFFER = 64 * 1024 * 1024;

function piProcessArgs(promptText, extraArgs = []) {
  const extensionArgs = ["--no-extensions", "--extension", repoRoot];
  return [
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
}

function piProcessEnv(options = {}) {
  return {
    ...process.env,
    PI_WORKFLOW_ROLE: options.role ?? "disabled",
  };
}

function pi(promptText, extraArgs = [], options = {}) {
  const result = spawnSync("pi", piProcessArgs(promptText, extraArgs), { cwd: repoRoot, encoding: "utf8", maxBuffer: PI_MAX_OUTPUT_BUFFER, env: piProcessEnv(options) });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return { status: result.status ?? (result.error ? 1 : 0), stdout, stderr, error: result.error };
}

function piAsync(promptText, extraArgs = [], options = {}) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const child = spawn("pi", piProcessArgs(promptText, extraArgs), { cwd: repoRoot, env: piProcessEnv(options), stdio: ["ignore", "pipe", "pipe"] });
  const stdoutChunks = [];
  const stderrChunks = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputTruncated = false;

  function capture(chunks, chunk, currentBytes) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = Math.max(0, PI_MAX_OUTPUT_BUFFER - currentBytes);
    if (remaining > 0) chunks.push(buffer.byteLength <= remaining ? buffer : buffer.subarray(0, remaining));
    if (buffer.byteLength > remaining) outputTruncated = true;
    return currentBytes + buffer.byteLength;
  }

  child.stdout?.on("data", (chunk) => {
    stdoutBytes = capture(stdoutChunks, chunk, stdoutBytes);
  });
  child.stderr?.on("data", (chunk) => {
    stderrBytes = capture(stderrChunks, chunk, stderrBytes);
  });

  return {
    kind: "process",
    startedAt,
    started,
    promise: new Promise((resolve) => {
      child.on("error", (error) => {
        resolve({ status: 1, stdout: Buffer.concat(stdoutChunks).toString("utf8"), stderr: Buffer.concat(stderrChunks).toString("utf8"), error, outputTruncated, completedAt: new Date().toISOString(), elapsedMs: Date.now() - started });
      });
      child.on("close", (code) => {
        resolve({ status: code ?? 1, stdout: Buffer.concat(stdoutChunks).toString("utf8"), stderr: Buffer.concat(stderrChunks).toString("utf8"), error: null, outputTruncated, completedAt: new Date().toISOString(), elapsedMs: Date.now() - started });
      });
    }),
  };
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

function stripArchiveBanner(text) {
  const lines = text.split(/\r?\n/);
  while (lines[0]?.startsWith("> Historical archive.") || lines[0]?.startsWith("> Current public terminology")) lines.shift();
  while (lines[0] === "") lines.shift();
  return lines.join("\n").trim();
}

function commonAnswerFormatPrompt() {
  return `

# Required A/B Evaluation Answer Format

Use the same presentation format as every other evaluation arm. Do not output JSON unless the user task explicitly requires JSON. Do not mention hidden labels, run IDs, evaluation arm labels, internal task IDs, claim IDs, slot IDs, tool logs, or evaluation-arm mechanics. Domain terms from the user task, such as product names or the word "workflow", are allowed when needed to answer the task.

Prefer these top-level sections, in this order, or clear semantic equivalents. This is a presentation normalization request, not a correctness requirement; minor heading syntax differences (for example missing Markdown ## markers) should not affect quality scoring:

## Summary
A concise answer to the task.

## Evidence
Evidence-backed findings. Cite URLs, files, or line references for major claims. For code review tasks, include severity and file/path evidence here.

## Caveats and Limitations
Important uncertainty, unsupported leads, conflicting evidence, or scope limits.

## Recommendations
Prioritized practical actions or decisions.

## Open Questions
Questions that need human follow-up, or "None" if there are none.
`;
}

function taskPromptForArms(task) {
  return `${task.task.trim()}${commonAnswerFormatPrompt()}${evalIsolationPrompt()}`;
}

function plainTaskPrompt(task) {
  return `${taskPromptForArms(task)}

# Direct Arm Output Capture

Write your final answer between these exact delimiter lines. Do not write anything after the end delimiter.

${PLAIN_FINAL_START}
<final answer>
${PLAIN_FINAL_END}`;
}

function evalIsolationPrompt() {
  return `

# Evaluation Isolation

Do not inspect, summarize, quote, or rely on this repository's prior evaluation artifacts, answer keys, score reports, panel reviews, or implementation notes. In particular, do not read or use files under .pi/eval/, evals/ab-execution/, docs/ab-execution*, docs/deep-research-*, or .pi/skill-runs/ for this answer. Treat the task as a fresh evaluation item and use task-relevant source evidence instead.`;
}

function taskToolSet(task) {
  const hasParallelResearch = Object.values(task.arms ?? {}).some((arm) => arm?.type === "parallel5");
  return hasParallelResearch || /research/i.test(task.id) ? WEB_READ_ONLY_TOOLS : READ_ONLY_TOOLS;
}

function workflowStages(spec) {
  return spec?.workflow?.stages && Array.isArray(spec.workflow.stages) ? spec.workflow.stages : [];
}

function terminalStageIds(spec) {
  const stages = workflowStages(spec);
  const ids = new Set(stages.map((stage) => stage.id).filter(Boolean));
  const referenced = new Set();
  for (const stage of stages) {
    const from = stage.from;
    if (Array.isArray(from)) for (const id of from) referenced.add(id);
    else if (typeof from === "string") referenced.add(from);
    else if (from && typeof from === "object" && typeof from.stage === "string") referenced.add(from.stage);
  }
  const terminal = [...ids].filter((id) => !referenced.has(id));
  return terminal.length > 0 ? terminal : stages.length > 0 && stages.at(-1).id ? [stages.at(-1).id] : [];
}

function injectCommonPresentationStage(spec) {
  const stages = workflowStages(spec);
  if (stages.length === 0 || stages.some((stage) => stage.id === "ab-common-answer-format")) return;
  const from = terminalStageIds(spec);
  stages.push({
    id: "ab-common-answer-format",
    type: "reduce",
    from,
    sourcePolicy: "partial",
    inject: true,
    prompt: `Rewrite the completed work into a parent-facing research brief for the runtime task. Preserve the substantive findings, evidence, caveats, and recommendations from Source Stage Context, but remove internal bookkeeping identifiers and schema labels. Do not add new research and do not re-verify claims. When condensing, prioritize: (1) direct relevance to the runtime task, (2) source-backed evidence with URLs or concrete file references, (3) cost-vs-quality or baseline tradeoffs when the task asks about evaluation, (4) uncertainty labels for partial/conflicting/unverified material, and (5) actionable recommendations tied to evidence in prose rather than claim IDs. Avoid unsupported analogies: if a source is only indirectly relevant, say so briefly. Do not present exact quantitative, statistical, cost, latency, sample-size, or benchmark-performance claims as recommendations unless the visible source context includes a URL or concrete file reference for that exact claim. If a quantitative claim lacks visible support, move it to Caveats and Limitations or Open Questions instead of using it as an action threshold.${commonAnswerFormatPrompt()}`,
  });
}

function writeGeneratedSpec(task, arm, args) {
  mkdirSync(generatedDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const file = join(generatedDir, `${task.id}-${arm.type}-${arm.name}-${stamp}.json`);
  let spec;
  let sourceWorkflowPath = null;
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
            prompt: `Complete the runtime task. Do not modify files.${commonAnswerFormatPrompt()}`,
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
            prompt: `Synthesize the parallel research outputs into one practical final report for the runtime task. Preserve citations, distinguish strong evidence from caveats, and identify unsupported or conflicting claims.${commonAnswerFormatPrompt()}`
          }
        ]
      }
    };
  } else {
    const p = workflowPath(arm.name);
    if (!p || !p.endsWith(".json")) {
      throw new Error(`model/thinking override for workflow "${arm.name}" requires a JSON workflow in workflows/ or workflows/`);
    }
    sourceWorkflowPath = p;
    spec = JSON.parse(readFileSync(p, "utf8"));
    injectCommonPresentationStage(spec);
  }
  const model = executionModel(task, args);
  const thinking = executionThinking(task, args);
  if (model) spec.model = model;
  if (thinking) spec.thinking = thinking;
  if (args.workflowDepth && arm.type === "workflow") {
    if (!["quick", "standard", "max"].includes(args.workflowDepth)) throw new Error(`unsupported --workflow-depth ${args.workflowDepth}; expected quick|standard|max`);
    spec.input = { ...(spec.input && typeof spec.input === "object" && !Array.isArray(spec.input) ? spec.input : {}), depth: args.workflowDepth };
  }
  writeFileSync(file, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
  if (sourceWorkflowPath) copyWorkflowTemplateDirectory(sourceWorkflowPath, file);
  return file;
}

function copyWorkflowTemplateDirectory(sourceWorkflowPath, generatedSpecPath) {
  const sourceTemplates = join(dirname(sourceWorkflowPath), "templates");
  if (!existsSync(sourceTemplates)) return;
  cpSync(sourceTemplates, join(dirname(generatedSpecPath), "templates"), { recursive: true, force: true });
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
  return { kind: "direct", process: piAsync(plainTaskPrompt(task), directPiArgs(task, args), { role: "disabled" }) };
}

function extractDelimitedFinalAnswer(stdout) {
  const start = stdout.indexOf(PLAIN_FINAL_START);
  const end = stdout.indexOf(PLAIN_FINAL_END, start + PLAIN_FINAL_START.length);
  if (start >= 0 && end > start) return stdout.slice(start + PLAIN_FINAL_START.length, end).trim();
  return stdout.trim();
}

async function collectPlainArm(launched) {
  const processResult = await launched.process.promise;
  const text = extractDelimitedFinalAnswer(processResult.stdout);
  return {
    kind: "direct",
    final: { taskId: "plain", text },
    metadata: {
      runId: null,
      status: processResult.status === 0 ? "completed" : "failed",
      taskCount: 1,
      completedTaskCount: processResult.status === 0 ? 1 : 0,
      failedTaskCount: processResult.status === 0 ? 0 : 1,
      skippedTaskCount: 0,
      blockedTaskCount: 0,
      interruptedTaskCount: 0,
      sumTaskElapsedMs: processResult.elapsedMs,
      wallClockMs: processResult.elapsedMs,
      startedAt: launched.process.startedAt,
      completedAt: processResult.completedAt,
      estimatedTokens: null,
      estimatedCostUsd: null,
      outputTruncated: processResult.outputTruncated,
      stdoutCapturedBytes: processResult.stdout.length,
      stderrCapturedBytes: processResult.stderr.length,
      stderrExcludedFromCandidate: true,
    },
    raw: {
      stdout: processResult.stdout,
      stderr: processResult.stderr,
    },
  };
}

function launchArm(task, arm, args) {
  if (arm.type === "plain") return launchPlainArm(task, args);

  const override = Boolean(executionModel(task, args) || executionThinking(task, args) || arm.type === "workflow" || arm.type === "parallel5");
  let runResult;
  if (override) {
    const specPath = writeGeneratedSpec(task, arm, args);
    runResult = pi(`/workflow run ${toRepoPath(specPath)} ${quote(taskPromptForArms(task))}`, [], { role: "supervisor" });
  } else if (arm.type === "workflow") {
    runResult = pi(`/workflow run ${arm.name} ${quote(taskPromptForArms(task))}`, [], { role: "supervisor" });
  } else {
    runResult = pi(`/workflow delegate ${arm.name} ${quote(taskPromptForArms(task))}`, [], { role: "supervisor" });
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
  const structured = task.output?.format === "json" ? parseStructuredCandidate(raw) : null;
  if (structured !== null) raw = structuredToMarkdown(structured);
  return { taskId: task.taskId, text: raw.trim() };
}

const JUDGE_OMIT_KEYS = new Set([
  "researchMetadata",
  "coverageSummary",
  "claimVerdictIndex",
  "factSlotCoverage",
  "researchScopeCoverage",
  "parentDecisionNotes",
  "slotId",
  "id",
  "claimIds",
  "parentImpact",
  "parentAction",
  "sourcePolicySummary",
  "taskType",
  "expectedFinalShape",
  "factSlotsPlanned",
  "factSlotsFilled",
  "factSlotsPartial",
  "factSlotsMissing",
  "claimsVerified",
]);

function parseStructuredCandidate(text) {
  const trimmed = text.trim();
  for (const candidate of [trimmed, ...jsonFenceBodies(trimmed)]) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try next candidate
    }
  }
  return null;
}

function jsonFenceBodies(text) {
  const bodies = [];
  const re = /```(?:json)?\s*\n([\s\S]*?)\n```/gi;
  let match;
  while ((match = re.exec(text)) !== null) bodies.push(match[1].trim());
  return bodies;
}

function displayKey(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function compactPrimitive(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function sanitizeForJudge(value) {
  if (Array.isArray(value)) return value.map(sanitizeForJudge).filter((item) => item !== undefined);
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value)
    .filter(([key]) => !JUDGE_OMIT_KEYS.has(key))
    .map(([key, val]) => [key, sanitizeForJudge(val)])
    .filter(([, val]) => val !== undefined && !(Array.isArray(val) && val.length === 0));
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries);
}

// Render structured output into a common readable report so the judge sees the
// deliverable content, not arm-specific JSON/schema fingerprints.
function structuredToMarkdown(value) {
  const sanitized = sanitizeForJudge(value);
  const root = sanitized && typeof sanitized === "object" && !Array.isArray(sanitized) && sanitized.finalReport
    ? sanitizeForJudge(sanitized.finalReport)
    : sanitized;
  return renderStructuredValue(root, 2).trim();
}

function renderStructuredValue(value, headingLevel = 2) {
  if (value == null) return "";
  if (typeof value !== "object") return compactPrimitive(value);
  if (Array.isArray(value)) {
    return value.map((item) => renderListItem(item, headingLevel)).filter(Boolean).join("\n");
  }
  return Object.entries(value)
    .map(([key, val]) => {
      const rendered = renderStructuredValue(val, Math.min(headingLevel + 1, 4));
      if (!rendered.trim()) return "";
      if (typeof val !== "object" || val === null) return `**${displayKey(key)}:** ${rendered}`;
      return `${"#".repeat(headingLevel)} ${displayKey(key)}\n${rendered}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

function renderListItem(item, headingLevel) {
  if (item == null) return "";
  if (typeof item !== "object") return `- ${compactPrimitive(item)}`;
  if (Array.isArray(item)) return renderStructuredValue(item, headingLevel);
  const parts = Object.entries(item)
    .map(([key, val]) => {
      const rendered = renderStructuredValue(val, Math.min(headingLevel + 1, 4));
      return rendered.trim() ? `  - **${displayKey(key)}:** ${rendered.replace(/\n/g, "\n    ")}` : "";
    })
    .filter(Boolean);
  return parts.length ? `-\n${parts.join("\n")}` : "";
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
  // Strip true identifiers and orchestration metadata that could reveal the arm.
  // Do not rewrite domain terms such as "workflow" or "single-agent baseline".
  return text
    .replace(/\.pi\/workflows\/workflow_[^\s)\]}]+/g, ".pi/workflows/<run>/...")
    .replace(/\.pi\/workflow-subagents\/workflow_[^\s)\]}]+/g, ".pi/workflow-subagents/<run>/...")
    .replace(/workflow_[A-Za-z0-9_-]+/g, "<run>")
    .replace(/\brun-\d{8}T\d{6}Z\b/g, "<eval-run>")
    .replace(/\bclaim-\d+\b/gi, "supporting evidence")
    .replace(/\bslot-\d+\b/gi, "evidence slot")
    .replace(/^\s*(Run ID|Run path|Arm|Mode|Provider\/model):.*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function judgeArm(taskBrief, output, args, context = {}) {
  const samples = Math.max(1, Number(args.judgeSamples) || 1);
  if (samples === 1) return judgeArmOnce(taskBrief, output, args, context, 1);
  const records = [];
  for (let sample = 1; sample <= samples; sample++) records.push(judgeArmOnce(taskBrief, output, args, context, sample));
  const scored = records.filter((record) => !record.judgeFailure);
  if (scored.length === 0) return { ...records[0], judgeSamples: records };
  const avgScores = Object.fromEntries(DIMENSIONS.map((d) => [d, scored.reduce((sum, record) => sum + Number(record.scores[d] ?? 0), 0) / scored.length]));
  const scoreStddev = Object.fromEntries(DIMENSIONS.map((d) => {
    const meanValue = avgScores[d];
    return [d, Math.sqrt(scored.reduce((sum, record) => sum + Math.pow(Number(record.scores[d] ?? 0) - meanValue, 2), 0) / scored.length)];
  }));
  const failureCounts = new Map();
  for (const record of scored) for (const failure of record.hardFailures ?? []) failureCounts.set(failure, (failureCounts.get(failure) ?? 0) + 1);
  const hardFailures = [...failureCounts.entries()].filter(([, count]) => count > scored.length / 2).map(([failure]) => failure);
  const hardFailureEvidence = scored.flatMap((record) => record.hardFailureEvidence ?? []).filter((item) => hardFailures.includes(item.failure));
  return {
    scores: avgScores,
    scoreStddev,
    hardFailures,
    hardFailureEvidence,
    unsupportedHardFailures: [...new Set(scored.flatMap((record) => record.unsupportedHardFailures ?? []))],
    notes: scored.map((record, index) => `sample ${index + 1}: ${record.notes ?? ""}`).join("\n"),
    judgeSampleCount: samples,
    judgeScoredSampleCount: scored.length,
    judgeSamples: records,
  };
}

function judgeArmOnce(taskBrief, output, args, context = {}, sample = 1) {
  const judgePrompt = stripArchiveBanner(readFileSync(join(evalDir, "judge-prompt.md"), "utf8"));
  const rubric = stripArchiveBanner(readFileSync(join(evalDir, "rubric.md"), "utf8"));
  const prompt = [
    judgePrompt,
    "\n---\n",
    "## Rubric\n",
    rubric,
    "\n---\n",
    "## Task brief\n",
    taskBrief,
    "\n## Candidate output\n",
    output || "(empty output)",
  ].join("\n");
  const extra = ["--no-tools"];
  if (args.judgeModel) extra.push("--model", args.judgeModel);
  if (args.judgeThinking) extra.push("--thinking", args.judgeThinking);
  const attempts = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = pi(prompt, extra, { role: "disabled" });
    const raw = `${res.stdout}\n${res.stderr}`;
    writeJudgeAttempt(context, attempt + 1, res, raw, sample);
    const parsed = parseJudgeJson(raw, output);
    attempts.push({ sample, attempt: attempt + 1, status: res.status, parseable: Boolean(parsed), rawPath: judgeAttemptPath(context, attempt + 1, sample) });
    if (parsed) return parsed;
  }
  const providerFailed = attempts.some((attempt) => attempt.status !== 0);
  return {
    scores: Object.fromEntries(DIMENSIONS.map((d) => [d, 0])),
    hardFailures: [],
    hardFailureEvidence: [],
    unsupportedHardFailures: [],
    judgeFailure: {
      kind: providerFailed ? "provider_error" : "parse_error",
      notes: "judge output not parseable after retry; candidate was not scored",
      attempts,
    },
    notes: "judge output not parseable after retry",
  };
}

function judgeAttemptPath(context, attempt, sample = 1) {
  if (!context.resultDir || !context.taskId || !context.label) return null;
  return toRepoPath(join(context.resultDir, "internal", context.taskId, "judge", `label-${context.label}-sample-${sample}-attempt-${attempt}.txt`));
}

function writeJudgeAttempt(context, attempt, res, raw, sample = 1) {
  if (!context.resultDir || !context.taskId || !context.label) return;
  const dir = join(context.resultDir, "internal", context.taskId, "judge");
  mkdirSync(dir, { recursive: true });
  const body = [
    `status=${res.status}`,
    `sample=${sample}`,
    `attempt=${attempt}`,
    "--- stdout+stderr ---",
    raw,
  ].join("\n");
  writeFileSync(join(dir, `label-${context.label}-sample-${sample}-attempt-${attempt}.txt`), body, "utf8");
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

function parseJudgeJson(text, candidateOutput = "") {
  // Prefer the last candidate that carries a scores object (judge's final answer).
  const candidates = jsonCandidates(text);
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(candidates[i]);
      if (!parsed || typeof parsed !== "object" || !parsed.scores) continue;
      const scores = {};
      for (const d of DIMENSIONS) scores[d] = Number(parsed.scores?.[d]) || 0;
      const evidence = normalizeHardFailureEvidence(parsed.hardFailureEvidence, candidateOutput);
      const evidenceFailures = new Set(evidence.map((item) => item.failure));
      const requestedFailures = Array.isArray(parsed.hardFailures) ? parsed.hardFailures.map(String).filter((item) => HARD_FAILURES.has(item)) : [];
      const hardFailures = requestedFailures.filter((failure) => evidenceFailures.has(failure));
      const unsupportedHardFailures = requestedFailures.filter((failure) => !evidenceFailures.has(failure));
      return {
        scores,
        hardFailures,
        hardFailureEvidence: evidence.filter((item) => hardFailures.includes(item.failure)),
        unsupportedHardFailures,
        notes: String(parsed.notes ?? ""),
      };
    } catch {
      // try next candidate
    }
  }
  return null;
}

function normalizeHardFailureEvidence(value, candidateOutput = "") {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      failure: String(item?.failure ?? ""),
      evidenceQuote: String(item?.evidenceQuote ?? item?.quote ?? "").trim(),
      explanation: String(item?.explanation ?? "").trim(),
    }))
    .filter((item) => HARD_FAILURES.has(item.failure) && item.evidenceQuote.length > 0 && quoteAppearsInOutput(item.evidenceQuote, candidateOutput));
}

function quoteAppearsInOutput(quote, output) {
  const normalize = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
  const normalizedQuote = normalize(quote);
  if (!normalizedQuote) return false;
  const normalizedOutput = normalize(output);
  return normalizedOutput.includes(normalizedQuote);
}

function mean(scores, scoreRecord = null) {
  if (!scores || scoreRecord?.judgeFailure) return null;
  const vals = DIMENSIONS.map((d) => Number(scores[d] ?? 0));
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function formatMean(value) {
  return value === null || value === undefined || !Number.isFinite(value) ? "unscored" : value.toFixed(2);
}

function rankLabelScores(labelScores) {
  return Object.entries(labelScores)
    .filter(([, score]) => !score.judgeFailure)
    .map(([label, score]) => ({ label, hardFailures: score.hardFailures.length, scoreMean: mean(score.scores, score) }))
    .sort((left, right) => left.hardFailures - right.hardFailures || right.scoreMean - left.scoreMean);
}

function deriveMultiWinner(labelScores) {
  const ranked = rankLabelScores(labelScores);
  if (ranked.length === 0) return "unscored";
  const best = ranked[0];
  const second = ranked[1];
  if (!best) return "tie";
  if (!second) return best.label;
  if (best.hardFailures < second.hardFailures) return best.label;
  if (best.hardFailures === second.hardFailures && best.scoreMean - second.scoreMean > SCORE_TIE_THRESHOLD + SCORE_TIE_EPSILON) return best.label;
  return "tie";
}

function topTieLabels(labelScores) {
  const ranked = rankLabelScores(labelScores);
  if (ranked.length === 0) return [];
  const best = ranked[0];
  return ranked
    .filter((item) => item.hardFailures === best.hardFailures && best.scoreMean - item.scoreMean <= SCORE_TIE_THRESHOLD + SCORE_TIE_EPSILON)
    .map((item) => item.label);
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
    console.log(`  workflowDepth: ${args.workflowDepth ?? "default"}`);
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
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  if ((result.status ?? 1) !== 0) return combined || null;
  return combined || null;
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
      workflowDepthOverride: args.workflowDepth,
      judgeModelOverride: args.judgeModel,
      judgeThinkingOverride: args.judgeThinking,
      judgeSamples: args.judgeSamples,
      aaArm: args.aaArm,
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
      workflowDepth: args.workflowDepth,
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
  if (armResult.raw) {
    writeFileSync(join(armDir, "stdout.raw.log"), armResult.raw.stdout ?? "", "utf8");
    writeFileSync(join(armDir, "stderr.raw.log"), armResult.raw.stderr ?? "", "utf8");
  }
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

async function runTask(task, args, resultDir) {
  console.log(`\n=== Task: ${task.id} ===`);
  const launchedArms = {};
  for (const key of armKeys(task)) {
    const arm = task.arms[key];
    console.log(`  [${key}] launching ${armLabel(arm)} ...`);
    launchedArms[key] = launchArm(task, arm, args);
  }

  const arms = {};
  for (const key of armKeys(task)) {
    const arm = task.arms[key];
    const launched = launchedArms[key];
    if (launched.kind === "direct") {
      console.log(`  [${key}] waiting ${armLabel(arm)} ...`);
      const collected = await collectPlainArm(launched);
      const armResult = { arm, runId: null, run: null, final: collected.final, metadata: collected.metadata, raw: collected.raw };
      writeArmArtifacts(task, key, armResult, resultDir);
      arms[key] = armResult;
    } else {
      console.log(`  [${key}] waiting ${armLabel(arm)} (${launched.runId}) ...`);
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

function blindLabelSources(task, resultDir, args = {}) {
  const sourceKeys = armKeys(task);
  const labels = sourceKeys.map((_, index) => String.fromCharCode("A".charCodeAt(0) + index));
  if (args.aaArm) {
    if (!sourceKeys.includes(args.aaArm)) throw new Error(`--aa-arm ${args.aaArm} is not a configured arm for task ${task.id}`);
    return Object.fromEntries(labels.map((label) => [label, args.aaArm]));
  }
  return labels
    .map((label) => ({ label, sortKey: sha256Text(`${toRepoPath(resultDir)}:${task.id}:${label}`) }))
    .sort((left, right) => left.sortKey.localeCompare(right.sortKey))
    .reduce((mapping, item, index) => {
      mapping[item.label] = sourceKeys[index];
      return mapping;
    }, {});
}

function outputUrls(text, maxUrls = 12) {
  const seen = new Set();
  const urls = [];
  const re = /https?:\/\/[^\s)\]}>,"']+/g;
  for (const match of String(text ?? "").matchAll(re)) {
    const url = match[0].replace(/[.,;:]+$/, "");
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
    if (urls.length >= maxUrls) break;
  }
  return urls;
}

function auditCitationUrl(url) {
  const result = spawnSync("curl", ["-L", "--max-time", "12", "--range", "0-0", "-o", "/dev/null", "-sS", "-w", "%{http_code} %{url_effective}", url], { cwd: repoRoot, encoding: "utf8" });
  const stdout = String(result.stdout ?? "").trim();
  const statusMatch = stdout.match(/^(\d{3})\s+(.*)$/);
  const httpStatus = statusMatch ? Number(statusMatch[1]) : null;
  const effectiveUrl = statusMatch ? statusMatch[2] : null;
  return {
    url,
    status: result.status ?? 1,
    httpStatus,
    effectiveUrl,
    resolves: Boolean(httpStatus && httpStatus >= 200 && httpStatus < 400),
    stderr: String(result.stderr ?? "").trim().slice(0, 500),
  };
}

function citationAudit(text, maxUrls = 12) {
  const urls = outputUrls(text, maxUrls);
  const checked = urls.map(auditCitationUrl);
  const resolved = checked.filter((item) => item.resolves).length;
  return {
    urlCount: outputUrls(text, 10_000).length,
    checkedCount: checked.length,
    resolvedCount: resolved,
    resolveRate: checked.length ? resolved / checked.length : null,
    checked,
  };
}

function scanEvalLeakText(text) {
  return EVAL_PATH_RE.test(text ?? "");
}

function scanWorkflowToolLogsForEvalPaths(runId) {
  if (!runId) return [];
  const root = join(repoRoot, ".pi", "workflow-subagents", runId);
  const hits = [];
  const find = spawnSync("find", [root, "-name", "tool-calls.jsonl", "-type", "f"], { cwd: repoRoot, encoding: "utf8" });
  if ((find.status ?? 1) !== 0) return hits;
  for (const file of (find.stdout ?? "").split(/\r?\n/).filter(Boolean)) {
    const rel = toRepoPath(file);
    const content = readFileSync(file, "utf8");
    if (scanEvalLeakText(content)) hits.push({ path: rel, reason: "tool-call-log-mentions-eval-path" });
  }
  return hits;
}

function evalLeakAudit(task, arms) {
  return Object.fromEntries(armKeys(task).map((key) => {
    const arm = arms[key];
    const hits = [];
    if (scanEvalLeakText(arm.final?.text)) hits.push({ path: "candidate-output", reason: "candidate-mentions-eval-path" });
    hits.push(...scanWorkflowToolLogsForEvalPaths(arm.metadata?.runId));
    return [key, { arm: armLabel(task.arms[key]), hitCount: hits.length, hits }];
  }));
}

function scoreTask(task, arms, args, resultDir) {
  const labelSources = blindLabelSources(task, resultDir, args);
  const leakAudit = evalLeakAudit(task, arms);
  const citationAudits = Object.fromEntries(armKeys(task).map((key) => [key, citationAudit(arms[key].final?.text)]));

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
  writeFileSync(join(internalDir, "eval-access-audit.json"), `${JSON.stringify(leakAudit, null, 2)}\n`, "utf8");
  writeFileSync(join(internalDir, "citation-audit.json"), `${JSON.stringify(citationAudits, null, 2)}\n`, "utf8");
  if (task.answerKey) {
    writeFileSync(join(internalDir, "answer-key.json"), `${JSON.stringify(task.answerKey, null, 2)}\n`, "utf8");
  }

  // Independent blind scoring
  const labelScores = Object.fromEntries(blindLabels.map((label) => [
    label,
    judgeArm(task.task, normalizeOutput(arms[labelSources[label]].final.text), args, { resultDir, taskId: task.id, label }),
  ]));
  const labelMeans = Object.fromEntries(blindLabels.map((label) => [label, mean(labelScores[label].scores, labelScores[label])]));
  const winner = deriveMultiWinner(labelScores);
  const winnerArm = winner === "tie" || winner === "unscored" ? winner : labelSources[winner];
  const scores = {
    taskId: task.id,
    blindLabelSources: labelSources,
    aaArm: args.aaArm,
    labels: labelScores,
    means: labelMeans,
    tieThreshold: SCORE_TIE_THRESHOLD,
    tieEpsilon: SCORE_TIE_EPSILON,
    winner,
    winnerArm,
    topTieLabels: topTieLabels(labelScores),
    evalAccessAudit: leakAudit,
    citationAudit: citationAudits,
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
    if (r.scores.aaArm) blind.push(`- A/A noise-floor mode: every blind label uses configured arm ${r.scores.aaArm} (${armLabel(r.task.arms[r.scores.aaArm])})`);
    if (r.scores.winner === "tie" && r.scores.topTieLabels?.length) blind.push(`- top tie labels: ${r.scores.topTieLabels.join(", ")}`);
    for (const label of Object.keys(r.scores.labels).sort()) {
      const score = r.scores.labels[label];
      const hardFailureText = score.hardFailures.join(", ") || "none";
      const judgeFailureText = score.judgeFailure ? `  judgeFailure: ${score.judgeFailure.kind}` : "";
      const unsupportedText = score.unsupportedHardFailures?.length ? `  unsupportedHardFailures: ${score.unsupportedHardFailures.join(", ")}` : "";
      blind.push(`- blind ${label} mean: ${formatMean(r.scores.means[label])}  hardFailures: ${hardFailureText}${judgeFailureText}${unsupportedText}`);
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
      blind.push(`- configured ${key} ${armLabel(r.task.arms[key])}: status=${m.status} tasks=${m.taskCount} completed=${m.completedTaskCount} failed=${m.failedTaskCount} skipped=${m.skippedTaskCount} blocked=${m.blockedTaskCount} interrupted=${m.interruptedTaskCount ?? 0}`);
    }
    if (r.scores.evalAccessAudit) {
      for (const key of armKeys(r.task)) {
        const audit = r.scores.evalAccessAudit[key];
        if (audit?.hitCount) blind.push(`- configured ${key} eval artifact audit: ${audit.hitCount} potential hit(s); see internal/${r.task.id}/eval-access-audit.json`);
      }
    }
    if (r.scores.citationAudit) {
      for (const key of armKeys(r.task)) {
        const audit = r.scores.citationAudit[key];
        if (audit?.checkedCount) blind.push(`- configured ${key} citation resolve audit: ${audit.resolvedCount}/${audit.checkedCount} resolved (${audit.resolveRate == null ? "n/a" : `${Math.round(audit.resolveRate * 100)}%`}); total URLs=${audit.urlCount}`);
      }
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
  const parsedJudge = parseJudgeJson(JSON.stringify({
    scores: Object.fromEntries(DIMENSIONS.map((d) => [d, 4])),
    hardFailures: ["hallucinated-file-path", "unsupported-critical-claim"],
    hardFailureEvidence: [
      { failure: "hallucinated-file-path", evidenceQuote: "https://example.invalid/missing", explanation: "missing file" },
      { failure: "unsupported-critical-claim", evidenceQuote: "not in output", explanation: "unsupported" },
    ],
    notes: "ok",
  }), "candidate cites https://example.invalid/missing only");
  const normalizedStructured = structuredToMarkdown(parseStructuredCandidate('```json\n{"finalReport":{"summary":"Use hidden tests.","researchMetadata":{"claimsVerified":7},"factSlotCoverage":[{"slotId":"slot-001","label":"Benchmark contamination","status":"partial","bestValue":"Use private tasks.","parentImpact":"decision"}],"mainFindings":[{"id":"mf-1","finding":"Benchmark contamination requires private tasks.","claimIds":["claim-001"]}]},"claimVerdictIndex":{"claims":[]}}\n```'));
  const commonPrompt = taskPromptForArms({ task: "Review a patch." });
  const presentationSpec = { workflow: { stages: [{ id: "final", type: "reduce" }] } };
  injectCommonPresentationStage(presentationSpec);
  const judgeBrief = { task: "Review a patch." }.task;
  const normalizedDomainText = normalizeOutput("Compare workflow orchestration against a single-agent baseline. Run ID: workflow_mqabc_123");
  const urls = outputUrls("See https://example.com/a, https://example.com/a and https://example.org/b.");
  const aaLabels = blindLabelSources({ id: "aa", arms: { A: {}, B: {}, C: {} } }, repoRoot, { aaArm: "B" });
  const checks = [
    ["markdown bullet finding is preserved", issueFound(bulletFinding, issue) === true],
    ["diff hunk evidence is stripped", issueFound(diffOnly, issue) === false],
    ["negated marker is rejected", issueFound(negated, maxConcurrencyIssue) === false],
    ["judge hard failure requires evidence", parsedJudge?.hardFailures.includes("hallucinated-file-path") === true && parsedJudge?.unsupportedHardFailures.includes("unsupported-critical-claim") === true],
    ["fenced structured output is flattened for blind judging", normalizedStructured.includes("Use hidden tests.") && normalizedStructured.includes("Benchmark contamination") && !normalizedStructured.includes("finalReport") && !normalizedStructured.includes("researchMetadata") && !normalizedStructured.includes("Fact Slot Coverage") && !normalizedStructured.includes("slot-001") && !normalizedStructured.includes("claim-001")],
    ["common answer format is injected into arm prompts", commonPrompt.includes("## Summary") && commonPrompt.includes("## Evidence") && commonPrompt.includes("Do not output JSON")],
    ["workflow arms get common presentation stage", presentationSpec.workflow.stages.at(-1).id === "ab-common-answer-format" && presentationSpec.workflow.stages.at(-1).from.includes("final")],
    ["judge task brief excludes presentation contract", !judgeBrief.includes("Required A/B Evaluation Answer Format") && !judgeBrief.includes("## Summary")],
    ["normalizer preserves domain terms", normalizedDomainText.includes("workflow orchestration") && normalizedDomainText.includes("single-agent baseline") && normalizedDomainText.includes("<run>")],
    ["plain final delimiter extraction excludes stderr-style noise", extractDelimitedFinalAnswer(`noise\n${PLAIN_FINAL_START}\nfinal only\n${PLAIN_FINAL_END}\nWarning: bad`) === "final only"],
    ["archive banner stripper removes live prompt warning", !stripArchiveBanner("> Historical archive. Non-authoritative. Preserved for recovery context only.\n\n# Prompt").includes("Historical archive")],
    ["citation URL extraction deduplicates URLs", urls.length === 2 && urls[0] === "https://example.com/a" && urls[1] === "https://example.org/b"],
    ["A/A mode maps all blind labels to one source arm", aaLabels.A === "B" && aaLabels.B === "B" && aaLabels.C === "B"],
    ["top tie labels exclude lower-scored labels", topTieLabels({ A: { scores: Object.fromEntries(DIMENSIONS.map((d) => [d, 5])), hardFailures: [] }, B: { scores: { ...Object.fromEntries(DIMENSIONS.map((d) => [d, 5])), concision: 4 }, hardFailures: [] }, C: { scores: Object.fromEntries(DIMENSIONS.map((d) => [d, 4])), hardFailures: [] } }).join(",") === "A,B"],
    ["all judge failures are unscored", deriveMultiWinner({ A: { scores: {}, hardFailures: [], judgeFailure: { kind: "parse_error" } } }) === "unscored"],
  ];
  const failed = checks.filter(([, ok]) => !ok);
  for (const [name, ok] of checks) console.log(`${ok ? "ok" : "not ok"} - ${name}`);
  if (failed.length > 0) process.exitCode = 1;
}

async function main() {
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
  for (const task of tasks) results.push(await runTask(task, args, resultDir));
  writeReport(results, resultDir);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
