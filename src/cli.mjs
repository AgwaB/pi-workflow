#!/usr/bin/env node
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function usage() {
  return `pi-workflow

Usage:
  pi-workflow inspect <run-id-or-prefix> [--failures] [--results] [--json]
  pi-workflow prune [--keep N] [--older-than DAYS] [--yes] [--json]
  pi-workflow supervise <run-id-or-prefix> [--poll-ms N] [--max-runtime-ms N]
  pi-workflow supervise --all [--poll-ms N] [--max-runtime-ms N]

supervise drives workflow scheduling from a standalone process until the
target run(s) reach a terminal status, so runs keep progressing after the
Pi session that started them exits. The run lease arbitrates with any
in-session supervisor. Exit codes: 0 completed, 1 failed/interrupted, 2 blocked.
For --all, only runs observed running are included; failure takes precedence
over blocked. Empty batches succeed; historical terminal runs are ignored.
`;
}

const args = process.argv.slice(2);
const command = args[0];
if (!command || command === "help" || command === "--help" || command === "-h") {
  process.stdout.write(usage());
  process.exit(0);
}

if (command === "supervise") {
  process.exit(await supervise(args.slice(1)));
}

if (command === "prune") {
  process.exit(await prune(args.slice(1)));
}

if (command !== "inspect") {
  process.stderr.write(`Unknown command "${command}".\n${usage()}`);
  process.exit(1);
}

const ref = args[1];
if (!ref) {
  process.stderr.write(`Missing run id.\n${usage()}`);
  process.exit(1);
}

const options = new Set(args.slice(2));
if (ref.startsWith("-") || [...options].some(option => !["--failures", "--results", "--json"].includes(option))) {
  process.stderr.write(`Unknown inspect argument or option.\n${usage()}`);
  process.exit(1);
}
const cwd = process.cwd();
const run = await readRun(cwd, ref);

if (options.has("--json")) {
  process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
  process.exit(0);
}

const tasks = Array.isArray(run.tasks) ? run.tasks : [];
const failures = tasks.filter((task) =>
  ["failed", "blocked", "interrupted"].includes(task.status),
);
// `--failures` narrows the listing to failure detail. Combined with
// `--results` on a run that has no failures it would otherwise print nothing
// useful, so the flags stay additive: fall back to every task's result and
// say so explicitly.
const failuresOnly = options.has("--failures");
const showAllResults = failuresOnly && options.has("--results") && failures.length === 0;
const selected = failuresOnly && !showAllResults ? failures : tasks;
const reliability = summarizeReliability(tasks);

const lines = [
  `runId: ${run.runId}`,
  `name: ${run.name ?? "(unnamed)"}`,
  `type: ${run.type}`,
  `status: ${run.status}`,
  `tasks: ${tasks.length}`,
  `completion: ${reliability.health}`,
  `retries: output=${reliability.outputRetries}, launch=${reliability.launchRetries}, resumes=${reliability.resumeEvents}, contextLimitFailures=${reliability.contextLimitFailures}`,
];
if (showAllResults) lines.push("failures: none (showing every task result)");

for (const task of selected) {
  lines.push(`- ${task.taskId}: ${task.status}/${task.statusDetail}${task.lastMessage ? ` — ${task.lastMessage}` : ""}`);
  if (options.has("--results") && task.files?.result) {
    const resultPath = resolve(cwd, task.files.result);
    const text = await readFile(resultPath, "utf8").catch(() => "");
    if (text) lines.push(indent(text.trim(), "    "));
  }
}

process.stdout.write(`${lines.join("\n")}\n`);

async function prune(argv) {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const buildDir = await resolveEngineDist(packageRoot);
  // Use the same boundary parser as /workflow prune, before any retention IO.
  const { parseWorkflowPruneArgs } = await import(pathToFileURL(join(buildDir, "extension.js")).href);
  let options;
  try { options = parseWorkflowPruneArgs(argv); }
  catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  const { json, ...retentionOptions } = options;
  const retention = await import(pathToFileURL(join(buildDir, "run-retention.js")).href);
  const summary = await retention.pruneWorkflowRuns(process.cwd(), retentionOptions);
  process.stdout.write(`${json ? JSON.stringify(summary, null, 2) : retention.formatWorkflowPruneSummary(summary)}\n`);
  return summary.error ? 1 : 0;
}

async function supervise(argv) {
  let runRef;
  let allMode = false;
  let pollMs = 2_000;
  let maxRuntimeMs = 14_400_000;
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--all") allMode = true;
    else if (arg === "--poll-ms" || arg === "--max-runtime-ms") {
      if (seen.has(arg)) {
        process.stderr.write(`Duplicate supervise option ${arg}.\n`);
        return 1;
      }
      seen.add(arg);
      const raw = argv[++index];
      const value = Number(raw);
      const minimum = arg === "--poll-ms" ? 250 : 1_000;
      if (!raw || !/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < minimum || value > 2_147_483_647) {
        process.stderr.write(`${arg} requires an integer from ${minimum} to 2147483647.\n`);
        return 1;
      }
      if (arg === "--poll-ms") pollMs = value;
      else maxRuntimeMs = value;
    }
    else if (!arg.startsWith("--") && !runRef) runRef = arg;
    else {
      process.stderr.write(`Unknown supervise argument "${arg}".\n${usage()}`);
      return 1;
    }
  }
  if (runRef && allMode) {
    process.stderr.write("Run id and --all are mutually exclusive.\n");
    return 1;
  }
  if (!runRef && !allMode) {
    process.stderr.write(`Missing run id (or --all).\n${usage()}`);
    return 1;
  }

  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const buildDir = await resolveEngineDist(packageRoot);
  const engine = await import(pathToFileURL(join(buildDir, "engine.js")).href);
  const store = await import(pathToFileURL(join(buildDir, "store.js")).href);
  const processRole = await import(pathToFileURL(join(buildDir, "process-role.js")).href);
  processRole.assertWorkflowActionAllowedForRole("supervise");

  const cwd = process.cwd();
  const runId = runRef ? (await store.readRunRecord(cwd, runRef)).runId : undefined;
  const lastPrinted = new Map();
  const supervised = new Set();
  const deadline = Date.now() + maxRuntimeMs;
  log(`supervising ${runId ?? "all running runs"} in ${cwd} (poll ${pollMs}ms)`);

  while (true) {
    const runs = runId
      ? [await store.readRunRecord(cwd, runId)]
      : (await store.listRunRecords(cwd)).filter((run) => run.status === "running" && !run.parentRunId);

    for (const run of runs) {
      if (run.status !== "running") continue;
      supervised.add(run.runId);
      await engine.scheduleRun(cwd, run.runId).catch((error) => log(`schedule error ${run.runId}: ${error?.message ?? error}`));
    }

    const refreshed = runId ? [await store.readRunRecord(cwd, runId)] : (await store.listRunRecords(cwd)).filter((run) => !run.parentRunId);
    for (const run of refreshed) {
      const summary = run.taskSummary;
      const line = `${run.runId} ${run.status} (${summary.completed}/${summary.total} completed, ${summary.running} running, ${summary.failed} failed, ${summary.interrupted} interrupted)`;
      if (lastPrinted.get(run.runId) !== line) {
        lastPrinted.set(run.runId, line);
        log(line);
      }
    }

    if (runId) {
      const run = refreshed[0];
      if (run.status !== "running") {
        log(`done: ${run.runId} ${run.status}`);
        return run.status === "completed" ? 0 : run.status === "blocked" ? 2 : 1;
      }
    } else if (!refreshed.some((run) => run.status === "running")) {
      log("done: no running runs remain");
      const outcomes = refreshed.filter(run => supervised.has(run.runId));
      // Failure/interruption takes precedence over blocked, then completed.
      if (outcomes.length !== supervised.size || outcomes.some(run => !["completed", "blocked"].includes(run.status))) return 1;
      return outcomes.some(run => run.status === "blocked") ? 2 : 0;
    }

    if (Date.now() >= deadline) {
      log(`giving up after --max-runtime-ms ${maxRuntimeMs}; run(s) still in progress`);
      return 1;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, pollMs));
  }
}

function log(message) {
  process.stdout.write(`[supervise ${new Date().toISOString()}] ${message}\n`);
}

async function resolveEngineDist(packageRoot) {
  const buildDir = join(packageRoot, "dist");
  const marker = join(buildDir, "engine.js");
  const markerStat = await stat(marker).catch(() => undefined);
  if (!markerStat?.isFile()) {
    throw new Error(
      `pi-workflow engine build is missing at ${marker}. Run npm run build before using supervise from a source checkout, or install from the packed package.`,
    );
  }
  return buildDir;
}

async function readRun(cwd, ref) {
  const root = join(cwd, ".pi", "workflows");
  const direct = isAbsolute(ref) ? ref : join(root, ref, "run.json");
  const directRun = await readJson(direct).catch(() => undefined);
  if (directRun) return directRun;

  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const matches = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(ref))
    .map((entry) => join(root, entry.name, "run.json"));
  if (matches.length === 0) throw new Error(`workflow run not found: ${ref}`);
  if (matches.length > 1) throw new Error(`ambiguous workflow run id prefix: ${ref}`);
  return readJson(matches[0]);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function indent(text, prefix) {
  return text.split(/\r?\n/).map((line) => `${prefix}${line}`).join("\n");
}

function summarizeReliability(tasks) {
  let outputRetries = 0;
  let launchRetries = 0;
  let resumeEvents = 0;
  let contextLimitFailures = 0;
  for (const task of tasks) {
    outputRetries += positiveCount(task.outputRetry?.attempts);
    launchRetries += positiveCount(task.launchRetry?.attempts);
    if (hasContextLimitFailure(task)) contextLimitFailures += 1;
    for (const event of Array.isArray(task.resumeEvents) ? task.resumeEvents : []) {
      resumeEvents += 1;
      outputRetries += positiveCount(event.outputRetryAttempts);
      launchRetries += positiveCount(event.launchRetryAttempts);
      if (hasContextLimitFailure(event)) contextLimitFailures += 1;
    }
  }
  const allCompleted = tasks.length > 0 && tasks.every((task) => task.status === "completed");
  const repairEvents = outputRetries + launchRetries + resumeEvents;
  const health = !allCompleted
    ? "incomplete"
    : repairEvents === 0 && contextLimitFailures === 0
      ? "clean"
      : "repaired";
  return { health, outputRetries, launchRetries, resumeEvents, contextLimitFailures };
}

function positiveCount(value) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function hasContextLimitFailure(value) {
  return [
    value?.statusDetail,
    value?.fromStatusDetail,
    value?.lastMessage,
    value?.outputRetry?.reason,
    value?.outputRetry?.message,
    value?.launchRetry?.reason,
    value?.launchRetry?.message,
    value?.outputRetryReason,
    value?.launchRetryReason,
  ].some(isContextLimitText);
}

function isContextLimitText(value) {
  const text = String(value ?? "").toLowerCase();
  return text.includes("context_or_request_too_large") || /context (window|length)|maximum context|request too large|token limit/.test(text);
}
