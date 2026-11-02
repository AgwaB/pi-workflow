import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("Goal temporary directories of a process are removed when it exits", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "goal-temp-owner-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtimeUrl = new URL("../../.tmp/unit/goal-workflow-runtime.js", import.meta.url).href;
  const tracked = join(directory, "pi-goal-candidate-fixture");
  const script = `
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { trackGoalTemporaryDirectory } = await import(${JSON.stringify(runtimeUrl)});
    mkdirSync(${JSON.stringify(join(tracked, "candidate"))}, { recursive: true });
    writeFileSync(${JSON.stringify(join(tracked, "candidate", "a.txt"))}, "copy");
    trackGoalTemporaryDirectory(${JSON.stringify(tracked)});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const code = await new Promise(resolve => child.once("exit", resolve));
  assert.equal(code, 0, stderr);
  await assert.rejects(stat(tracked), { code: "ENOENT" });
});
