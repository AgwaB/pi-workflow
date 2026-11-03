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

test("a dirty Git index and worktree are observed as-is before consent, never reset", async () => {
  const cwd = await workspace(true);
  const run = (...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();
  await writeFile(join(cwd, "src", "a.mjs"), "export const a = 'staged';\n");
  run("add", "src/a.mjs");
  await writeFile(join(cwd, "src", "a.mjs"), "export const a = 'unstaged on top';\n");
  const statusBefore = run("status", "--porcelain");
  await assertGoalScopeObservableBeforeConsent(cwd, definition(["test/a.test.mjs"]));
  assert.equal(run("status", "--porcelain"), statusBefore, "observation changes neither index nor worktree");
  assert.equal(run("show", ":src/a.mjs"), "export const a = 'staged';\n");
});

test("absent allowed paths and absent protected paths are accepted before consent", async () => {
  const cwd = await workspace(false);
  const withPaths = { ...definition(["test/missing.test.mjs"]) };
  withPaths.goal = { ...withPaths.goal, authority: { ...withPaths.goal.authority, allowedPaths: ["src/a.mjs", "src/new/file.mjs"] } };
  await assertGoalScopeObservableBeforeConsent(cwd, withPaths);
});

test("a symlinked allowed path is refused before consent", async () => {
  const cwd = await workspace(false);
  const { symlink } = await import("node:fs/promises");
  await symlink(join(cwd, "src", "a.mjs"), join(cwd, "src", "link.mjs"));
  const linked = { ...definition([]) };
  linked.goal = { ...linked.goal, authority: { ...linked.goal.authority, allowedPaths: ["src/link.mjs"] } };
  await assert.rejects(assertGoalScopeObservableBeforeConsent(cwd, linked), /Goal scope cannot be observed before consent/);
});
