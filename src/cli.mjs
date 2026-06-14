#!/usr/bin/env node
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function usage() {
  return `pi-workflow

Usage:
  pi-workflow inspect <run-id-or-prefix> [--failures] [--results] [--json]
  pi-workflow supervise <run-id-or-prefix> [--poll-ms N] [--max-runtime-ms N]
  pi-workflow supervise --all [--poll-ms N] [--max-runtime-ms N]

supervise drives workflow scheduling from a standalone process until the
target run(s) reach a terminal status, so runs keep progressing after the
Pi session that started them exits. The run lease arbitrates with any
in-session supervisor. Exit codes: 0 completed, 1 failed/interrupted, 2 blocked.
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
const cwd = process.cwd();
const run = await readRun(cwd, ref);

if (options.has("--json")) {
  process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
  process.exit(0);
}

const tasks = Array.isArray(run.tasks) ? run.tasks : [];
const selected = options.has("--failures")
  ? tasks.filter((task) => ["failed", "blocked", "interrupted"].includes(task.status))
  : tasks;

const lines = [
  `runId: ${run.runId}`,
  `name: ${run.name ?? "(unnamed)"}`,
  `type: ${run.type}`,
  `status: ${run.status}`,
  `tasks: ${tasks.length}`,
];

for (const task of selected) {
  lines.push(`- ${task.taskId}: ${task.status}/${task.statusDetail}${task.lastMessage ? ` — ${task.lastMessage}` : ""}`);
  if (options.has("--results") && task.files?.result) {
    const resultPath = resolve(cwd, task.files.result);
    const text = await readFile(resultPath, "utf8").catch(() => "");
    if (text) lines.push(indent(text.trim(), "    "));
  }
}

process.stdout.write(`${lines.join("\n")}\n`);

async function supervise(argv) {
  let runRef;
  let allMode = false;
  let pollMs = 2_000;
  let maxRuntimeMs = 14_400_000;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--all") allMode = true;
    else if (arg === "--poll-ms") pollMs = Math.max(250, Number(argv[++index]) || pollMs);
    else if (arg === "--max-runtime-ms") maxRuntimeMs = Math.max(1_000, Number(argv[++index]) || maxRuntimeMs);
    else if (!arg.startsWith("--") && !runRef) runRef = arg;
    else {
      process.stderr.write(`Unknown supervise argument "${arg}".\n${usage()}`);
      return 1;
    }
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
  const deadline = Date.now() + maxRuntimeMs;
  log(`supervising ${runId ?? "all running runs"} in ${cwd} (poll ${pollMs}ms)`);

  while (true) {
    const runs = runId
      ? [await store.readRunRecord(cwd, runId)]
      : (await store.listRunRecords(cwd)).filter((run) => run.status === "running" && !run.parentRunId);

    for (const run of runs) {
      if (run.status !== "running") continue;
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
      return 0;
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
