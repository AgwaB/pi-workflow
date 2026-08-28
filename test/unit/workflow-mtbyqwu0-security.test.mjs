import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildSourceContextPacket } from "../../.tmp/unit/workflow-artifacts.js";
import { createSafeProviderOnUpdate } from "../../.tmp/unit/workflow-provider-callback.js";
import {
  appendPrivateFile,
  publishPrivateGenerationDirectory,
  writePrivateFileAtomic,
  writePrivateFileNoReplace,
} from "../../.tmp/unit/secure-atomic-write.js";
import { writeWorkflowTaskArtifactBundle } from "../../.tmp/unit/workflow-output-artifacts.js";

const project = () => mkdtemp(join(tmpdir(), "pi-mtbyqwu0-security-"));

 test("source-context cap is measured on the complete serialized packet", () => {
  const packet = buildSourceContextPacket({
    tasks: Array.from({ length: 8 }, (_, index) => ({
      taskId: `task-${index}`,
      specId: `stage.${index}`,
      stageId: index % 2 ? "verify" : "plan",
      status: "completed",
    })),
  }, {
    structuredOutputsByTaskId: Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [`task-${index}`, { text: "x".repeat(500) }]),
    ),
    maxStructuredChars: 500,
    maxPacketChars: 700,
  });
  assert.ok(JSON.stringify(packet).length <= 700);
 });

 test("provider progress bounds nodes, keys, and input bytes before redaction", () => {
  const updates = [];
  const gate = createSafeProviderOnUpdate((update) => updates.push(update), { maxVisibleChars: 100 });
  const details = Object.fromEntries(Array.from({ length: 20_000 }, (_, index) => [`key-${index}`, "secret=do-not-expose"]));
  gate.callback({
    content: [{ type: "text", text: `token=do-not-expose ${"x".repeat(200_000)}` }],
    details,
  });
  assert.equal(updates.length, 1);
  assert.ok(JSON.stringify(updates).length < 2_000);
  assert.equal(JSON.stringify(updates).includes("do-not-expose"), false);
  assert.ok(updates[0].content[0].text.length <= 100);
 });

 test("secure writers reject symlinked ancestors for every publication mode", async () => {
  const root = await project();
  const outside = await project();
  const linkRoot = join(root, "link");
  try {
    await symlink(outside, linkRoot);
    await assert.rejects(() => appendPrivateFile(join(linkRoot, "append"), "x"));
    await assert.rejects(() => writePrivateFileAtomic(join(linkRoot, "atomic"), "x"));
    await assert.rejects(() => writePrivateFileNoReplace(join(linkRoot, "no-replace"), "x"));
    await assert.rejects(() => publishPrivateGenerationDirectory(join(linkRoot, "generation"), "owner", "x"));
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
 });

 test("refs URL validation blocks loopback before any HTTP request", async () => {
  const taskDir = await mkdtemp(join(tmpdir(), "pi-mtbyqwu0-refs-"));
  try {
    const raw = [
      "<control>", JSON.stringify({ schema: "stage-control-v1", digest: "ready" }), "</control>",
      "<analysis>", "analysis", "</analysis>",
      "<refs>", JSON.stringify([{ url: "http://127.0.0.1:1/private" }]), "</refs>",
    ].join("\n");
    const written = await writeWorkflowTaskArtifactBundle({
      taskDir, rawOutput: raw, refsMinItems: 1, refsUrlValidation: { timeoutMs: 100, maxUrls: 1 },
    });
    assert.ok(written.parsed.issues.some((issue) => issue.code === "unavailable_ref_locator" && /private host blocked/.test(issue.message)));
  } finally {
    await rm(taskDir, { recursive: true, force: true });
  }
 });
