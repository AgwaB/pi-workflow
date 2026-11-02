import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { assertGoalScopeObservableBeforeConsent } from "../../.tmp/unit/goal-workflow-runtime.js";

const roots = [];
after(() => Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))));
async function workspace(git) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "goal-scope-")));
  roots.push(cwd);
  await mkdir(join(cwd, "src")); await mkdir(join(cwd, "test"));
  await writeFile(join(cwd, "src", "a.mjs"), "export const a = 1;\n");
  await writeFile(join(cwd, "test", "a.test.mjs"), "// test\n");
  if (git) {
    const run = (...args) => execFileSync("git", args, { cwd, stdio: "ignore" });
    run("init", "-q"); run("add", "-A");
    run("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "base");
  }
  return cwd;
}
const definition = (protectedPaths) => ({ schemaVersion: 1, name: "scope", goal: { objective: "x",
  criteria: [{ id: "c", verifier: { kind: "deterministic", producerId: "json-exact-value-v1", target: "artifact",
    subject: { resultSlot: "result", artifact: "control", path: "$.result" }, config: { comparison: "canonical-json-equality", expected: true } } }],
  authority: { allowedPaths: ["src/a.mjs"], protectedPaths, allowedEffects: ["read", "candidate-write", "verify", "workflow-create"] } } });

for (const git of [false, true]) {
  test(`${git ? "Git" : "non-Git"} workspace without .pi accepts exact file scope before consent`, async () => {
    const cwd = await workspace(git);
    await assertGoalScopeObservableBeforeConsent(cwd, definition(["test/a.test.mjs"]));
  });
  test(`${git ? "Git" : "non-Git"} workspace refuses a directory in protectedPaths before consent`, async () => {
    const cwd = await workspace(git);
    await assert.rejects(assertGoalScopeObservableBeforeConsent(cwd, definition(["test"])),
      /Goal scope cannot be observed before consent: .*test/);
  });
}
