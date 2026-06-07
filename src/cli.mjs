#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

function usage() {
  return `pi-workflow

Usage:
  pi-workflow inspect <run-id-or-prefix> [--failures] [--results] [--json]
`;
}

const args = process.argv.slice(2);
const command = args[0];
if (!command || command === "help" || command === "--help" || command === "-h") {
  process.stdout.write(usage());
  process.exit(0);
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
