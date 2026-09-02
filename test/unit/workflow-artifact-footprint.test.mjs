import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  setTaskArtifactLinkForTests,
  writeValidatedWorkflowTaskArtifactBundle,
} from "../../.tmp/unit/workflow-output-artifacts.js";

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
