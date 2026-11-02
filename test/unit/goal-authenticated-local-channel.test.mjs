import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const moduleUrl = new URL("../../.tmp/unit/goal-authenticated-local-channel.js", import.meta.url).href;

test("an undrained Goal endpoint does not keep the host process alive", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "goal-endpoint-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = `
    const { openGoalAuthenticatedLocalChannel } = await import(${JSON.stringify(moduleUrl)});
    const stop = new AbortController();
    await openGoalAuthenticatedLocalChannel({ socketPath: ${JSON.stringify(join(directory, "endpoint.sock"))},
      attemptKey: "attempt", stopped: stop.signal,
      onRequest: async () => ({}), onAcknowledged: async () => ({}) });
    console.log("listening");`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve("hung"); }, 10_000);
    child.once("exit", code => { clearTimeout(timer); resolve(code); });
  });
  assert.match(stdout, /listening/, stderr);
  assert.equal(exited, 0, "the process exits although the endpoint was never drained");
});

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
