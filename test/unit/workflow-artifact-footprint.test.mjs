import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  setTaskArtifactLinkForTests,
  writeValidatedWorkflowTaskArtifactBundle,
} from "../../.tmp/unit/workflow-output-artifacts.js";
import { pruneWorkflowRuns } from "../../.tmp/unit/run-retention.js";
import { updateIndex, withRunLease } from "../../.tmp/unit/store.js";

const parsed = {
  protocol: "workflow-output-sections-v1",
  valid: true,
  raw: "",
  control: { status: "completed" },
  analysis: "analysis",
  refs: [],
  issues: [],
};

async function withTaskDir(fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-artifacts-"));
  try {
    await fn(root);
  } finally {
    setTaskArtifactLinkForTests(undefined);
  }
}

test("identical output.log and raw.md share one inode", async () => {
  await withTaskDir(async (root) => {
    const raw = "same output\n";
    await writeFile(join(root, "output.log"), raw);
    const result = await writeValidatedWorkflowTaskArtifactBundle({
      taskDir: root,
      rawOutput: raw,
    }, parsed);
    assert.equal(result.files.raw, join(root, "raw.md"));
    assert.equal((await stat(join(root, "output.log"))).ino, (await stat(join(root, "raw.md"))).ino);
  });
});

test("different raw output remains a separate file", async () => {
  await withTaskDir(async (root) => {
    await writeFile(join(root, "output.log"), "worker output\n");
    await writeValidatedWorkflowTaskArtifactBundle({
      taskDir: root,
      rawOutput: "validated raw\n",
    }, parsed);
    assert.notEqual((await stat(join(root, "output.log"))).ino, (await stat(join(root, "raw.md"))).ino);
    assert.equal(await readFile(join(root, "output.log"), "utf8"), "worker output\n");
    assert.equal(await readFile(join(root, "raw.md"), "utf8"), "validated raw\n");
  });
});

test("artifact link failure falls back to an atomic copy", async () => {
  await withTaskDir(async (root) => {
    const raw = "fallback raw\n";
    await writeFile(join(root, "output.log"), raw);
    setTaskArtifactLinkForTests(() => {
      throw new Error("injected link failure");
    });
    await writeValidatedWorkflowTaskArtifactBundle({
      taskDir: root,
      rawOutput: raw,
    }, parsed);
    assert.equal(await readFile(join(root, "raw.md"), "utf8"), raw);
    assert.notEqual((await stat(join(root, "output.log"))).ino, (await stat(join(root, "raw.md"))).ino);
  });
});

test("artifact file names and files.output remain unchanged", async () => {
  await withTaskDir(async (root) => {
    const result = await writeValidatedWorkflowTaskArtifactBundle({
      taskDir: root,
      rawOutput: "raw\n",
    }, parsed);
    assert.deepEqual(Object.keys(result.files).sort(), [
      "analysis",
      "control",
      "raw",
      "refs",
      "result",
    ]);
    assert.equal(result.files.raw, join(root, "raw.md"));
    assert.equal(join(root, "output.log").endsWith("output.log"), true);
  });
});

function terminalRun(runId, updatedAt, options = {}) {
  return {
    schemaVersion: 1,
    runId,
    name: options.name ?? runId,
    createdAt: updatedAt,
    updatedAt,
    provenance: options.provenance,
    tasks: [{ taskId: "task-1", specId: "task-1", status: options.status ?? "completed", statusDetail: "fixture" }],
  };
}

async function writeRun(cwd, run) {
  const dir = join(cwd, ".pi", "workflows", run.runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "run.json"), `${JSON.stringify(run)}\n`);
  await writeFile(join(dir, "artifact.bin"), "artifact");
}

test("prune dry run is non-destructive and selects only beyond-keep terminal runs", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-prune-"));
  try {
    await writeRun(cwd, terminalRun("workflow-new", "2026-09-01T00:00:00.000Z"));
    await writeRun(cwd, terminalRun("workflow-old", "2026-08-01T00:00:00.000Z"));
    await writeRun(cwd, terminalRun("workflow-running", "2026-07-01T00:00:00.000Z", { status: "running" }));
    const summary = await pruneWorkflowRuns(cwd, { keep: 1 });
    assert.deepEqual(summary.runs.map((run) => run.runId), ["workflow-old"]);
    assert.equal(summary.dryRun, true);
    await stat(join(cwd, ".pi", "workflows", "workflow-old", "run.json"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("prune yes removes workflow and subagent mirrors and rewrites the index", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-prune-"));
  try {
    await writeRun(cwd, terminalRun("workflow-keep", "2026-09-01T00:00:00.000Z"));
    await writeRun(cwd, terminalRun("workflow-delete", "2026-08-01T00:00:00.000Z"));
    await mkdir(join(cwd, ".pi", "workflow-subagents", "workflow-delete"), { recursive: true });
    await writeFile(join(cwd, ".pi", "workflow-subagents", "workflow-delete", "output.log"), "worker");
    await updateIndex(cwd);
    const summary = await pruneWorkflowRuns(cwd, { keep: 1, yes: true });
    assert.equal(summary.deletedBytes > 0, true);
    await assert.rejects(stat(join(cwd, ".pi", "workflows", "workflow-delete")));
    await assert.rejects(stat(join(cwd, ".pi", "workflow-subagents", "workflow-delete")));
    const index = JSON.parse(await readFile(join(cwd, ".pi", "workflows", "index.json"), "utf8"));
    assert.deepEqual(index.runs.map((run) => run.runId), ["workflow-keep"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("prune protects running, blocked, and live-lease runs", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-prune-"));
  try {
    await writeRun(cwd, terminalRun("workflow-terminal", "2026-01-01T00:00:00.000Z"));
    await writeRun(cwd, terminalRun("workflow-running", "2026-01-02T00:00:00.000Z", { status: "running" }));
    await writeRun(cwd, terminalRun("workflow-blocked", "2026-01-03T00:00:00.000Z", { status: "blocked" }));
    await writeRun(cwd, terminalRun("workflow-live", "2026-01-04T00:00:00.000Z"));
    const result = await withRunLease(cwd, "workflow-live", async () => pruneWorkflowRuns(cwd, { keep: 0, yes: true }));
    const live = result.runs.find((run) => run.runId === "workflow-live");
    assert.equal(live?.protected, true);
    assert.equal(result.runs.some((run) => run.runId === "workflow-running"), false);
    assert.equal(result.runs.some((run) => run.runId === "workflow-blocked"), false);
    await stat(join(cwd, ".pi", "workflows", "workflow-live", "run.json"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("older-than combines with the keep window and retains mock terminal runs as candidates", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-prune-"));
  try {
    const now = Date.now();
    await writeRun(cwd, terminalRun("workflow-new", new Date(now - 2 * 86400000).toISOString()));
    await writeRun(cwd, terminalRun("workflow-medium", new Date(now - 5 * 86400000).toISOString()));
    await writeRun(cwd, terminalRun("workflow-old", new Date(now - 20 * 86400000).toISOString(), { provenance: { mode: "mock-screenshot" } }));
    const summary = await pruneWorkflowRuns(cwd, { keep: 1, olderThanDays: 10 });
    assert.deepEqual(summary.runs.map((run) => run.runId), ["workflow-old"]);
    assert.equal(summary.runs[0].status, "completed");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("prune skips symlinked run directories outside the workflow root", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-prune-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-workflow-outside-"));
  try {
    await mkdir(join(cwd, ".pi", "workflows"), { recursive: true });
    await writeRun(outside, terminalRun("workflow-outside", "2020-01-01T00:00:00.000Z"));
    await symlink(join(outside, ".pi", "workflows", "workflow-outside"), join(cwd, ".pi", "workflows", "workflow-link"));
    const summary = await pruneWorkflowRuns(cwd, { keep: 0, yes: true });
    assert.equal(summary.runs.length, 0);
    await stat(join(outside, ".pi", "workflows", "workflow-outside", "run.json"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
