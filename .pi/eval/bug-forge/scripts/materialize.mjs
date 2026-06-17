#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readJson } from "./lib/findings.mjs";

const ROOT = process.cwd();
const FORBIDDEN = [
  ".git",
  ".harness",
  ".harness-archive",
  ".pi/eval",
  "gold-key.json",
  "gold-key.draft.json",
  "reference-fix.patch",
  "score-output",
  "judge-prompt",
  "answer-key",
];

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function run(cmd, args, opts = {}) {
  const cp = spawnSync(cmd, args, { cwd: opts.cwd ?? ROOT, stdio: opts.stdio ?? "pipe", encoding: "utf8" });
  if (cp.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed\n${cp.stdout}\n${cp.stderr}`);
  }
  return cp;
}
function listForbiddenHits(dir) {
  const hits = [];
  function walk(rel) {
    const abs = path.join(dir, rel);
    const base = rel || ".";
    for (const forbidden of FORBIDDEN) {
      if (base === forbidden || base.startsWith(`${forbidden}/`) || base.includes(`/${forbidden}/`)) hits.push(base);
    }
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const child = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(child);
      else {
        for (const forbidden of FORBIDDEN) {
          if (child === forbidden || child.startsWith(`${forbidden}/`) || child.includes(`/${forbidden}/`)) hits.push(child);
        }
      }
    }
  }
  walk("");
  return [...new Set(hits)].sort();
}

const taskId = arg("--task");
const out = arg("--out") ?? fs.mkdtempSync(path.join(os.tmpdir(), `bug-forge-${taskId ?? "task"}-`));
const checkOnly = process.argv.includes("--check-only");
if (!taskId) {
  console.error("Usage: materialize.mjs --task <candidate-id> [--out <dir>] [--check-only]");
  process.exit(2);
}

const taskDir = path.join(ROOT, ".pi/eval/bug-forge/tasks", taskId);
const task = readJson(path.join(taskDir, "task.json"));
const goldPath = path.join(taskDir, "gold-key.draft.json");
const gold = fs.existsSync(goldPath) ? readJson(goldPath) : {};
const revision = gold.sourceRevision && gold.sourceRevision !== "TBD" ? gold.sourceRevision : "HEAD";
const fixture = path.join(taskDir, task.candidateVisible?.fixturePatch ?? "fixture.diff");
if (!fs.existsSync(fixture)) throw new Error(`Missing fixture diff: ${fixture}`);

function sourceRepoCwd(task) {
  const source = task.sourceRepository;
  if (!source) return ROOT;
  if (source.type !== "local-git") throw new Error(`Unsupported sourceRepository.type: ${source.type}`);
  const localPath = source.localPathEnv && process.env[source.localPathEnv]
    ? process.env[source.localPathEnv]
    : source.localPath;
  if (!localPath) throw new Error("sourceRepository.localPath or localPathEnv is required");
  const resolved = path.resolve(localPath);
  if (!fs.existsSync(path.join(resolved, ".git"))) throw new Error(`Local git source not found: ${resolved}`);
  return resolved;
}

const sourceCwd = sourceRepoCwd(task);
if (!checkOnly) fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
if (!checkOnly) {
  const archive = spawnSync("git", ["archive", revision], { cwd: sourceCwd, encoding: null, maxBuffer: 512 * 1024 * 1024 });
  if (archive.status !== 0) throw new Error(`git archive ${revision} failed in ${sourceCwd}: ${archive.stderr?.toString()}`);
  const tar = spawnSync("tar", ["-x", "-C", out], { input: archive.stdout, encoding: null, maxBuffer: 512 * 1024 * 1024 });
  if (tar.status !== 0) throw new Error(`tar extract failed: ${tar.stderr?.toString()}`);
  for (const rel of [".git", ".harness", ".harness-archive", ".pi/eval"]) {
    fs.rmSync(path.join(out, rel), { recursive: true, force: true });
  }
  run("git", ["apply", fixture], { cwd: out });
}
const hits = listForbiddenHits(out);
const result = { taskId, out, revision, sourceCwd, fixture, forbiddenHits: hits, ok: hits.length === 0 };
console.log(JSON.stringify(result, null, 2));
if (hits.length) process.exitCode = 1;
