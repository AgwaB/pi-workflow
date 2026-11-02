import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { compileWorkflow } from "../../.tmp/unit/compiler.js";
import { resolveWorkflowBackend } from "../../.tmp/unit/backend.js";
import { refreshRun, resumeRun, scheduleRun, stopRun, stopWorkflowWatchersForTests } from "../../.tmp/unit/engine.js";
import {
  assertNoProtectedGoalEngineArtifacts,
  isProtectedGoalEngineRun,
} from "../../.tmp/unit/goal-protected-legacy.js";
import {
  createWorkflowRunRecord,
  flushPendingIndexUpdatesForTests,
  workflowRunPath,
  writeRunRecord,
} from "../../.tmp/unit/store.js";
import { ensureManagedWorktree } from "../../.tmp/unit/worktree.js";

const roots = [];
after(async () => {
  await stopWorkflowWatchersForTests(roots);
  await flushPendingIndexUpdatesForTests();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});
const model = { fullId: "fixture/model", provider: "fixture", id: "model", reasoning: true };

function agent(name = "fixture", aliases = [name]) {
  return {
    name, displayName: name, aliases, sourcePath: `/trusted/${name}.md`, scope: "project",
    frontmatter: {}, body: `Trusted ${name} instructions`, tools: ["read"], readOnly: true,
    approvalMode: "non-interactive", maxSubagentDepth: 0,
  };
}

function spec({ agentName = "fixture" } = {}) {
  return {
    schemaVersion: 1,
    name: "legacy-fixture",
    defaults: { agent: agentName, maxConcurrency: 1, readOnly: true, tools: ["read"] },
    artifactGraph: { stages: [{
      id: "work", type: "single", profileRole: "research-execution",
      prompt: "Return bounded fixture evidence.",
      output: { analysis: { required: true }, refs: { required: true } },
    }] },
  };
}

async function protectedRunFixture(marker) {
  const cwd = await mkdtemp(join(tmpdir(), "goal-protected-legacy-"));
  roots.push(cwd);
  const definition = spec();
  const specPath = join(cwd, "legacy.json");
  await writeFile(specPath, JSON.stringify(definition));
  const compiled = await compileWorkflow(definition, {
    cwd, task: "legacy", agentDefinitions: new Map([["fixture", agent()]]), availableModels: [model],
  });
  const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
  if (marker === "backend") run.backend = { type: "goal-sdk", mode: "sealed" };
  else run.goal = { binding: { runId: run.runId }, bindingHash: "0".repeat(64) };
  run.status = "interrupted";
  run.tasks[0].status = "interrupted";
  await writeRunRecord(cwd, run);
  const runPath = workflowRunPath(cwd, run.runId);
  return { cwd, run, compiled, runPath };
}

for (const marker of ["backend", "binding"]) {
  test(`removed protected Goal engine ${marker} records fail closed without mutation`, async () => {
    const { cwd, run, compiled, runPath } = await protectedRunFixture(marker);
    const before = await readFile(runPath, "utf8");
    const removed = /removed protected Goal engine/;
    assert.equal(isProtectedGoalEngineRun(run), true);
    assert.throws(() => resolveWorkflowBackend(run), removed);
    assert.throws(() => assertNoProtectedGoalEngineArtifacts(run, compiled), removed);
    await assert.rejects(refreshRun(cwd, run.runId), removed);
    await assert.rejects(resumeRun(cwd, run.runId), removed);
    run.status = "running";
    run.tasks[0].status = "running";
    await writeRunRecord(cwd, run);
    const running = await readFile(runPath, "utf8");
    await assert.rejects(stopRun(cwd, run.runId), removed);
    await assert.rejects(scheduleRun(cwd, run.runId), removed);
    assert.equal(await readFile(runPath, "utf8"), running, "no protected record is rewritten");
    assert.notEqual(before, running);
  });
}

test("an ordinary run whose compiled workflow gained a protected binding is a downgrade", async () => {
  const { compiled, run } = await protectedRunFixture("binding");
  delete run.goal;
  run.backend = { type: "local-pi", mode: "headless" };
  assert.throws(() => assertNoProtectedGoalEngineArtifacts(run, { ...compiled, goal: { binding: {}, bindingHash: "x" } }),
    /downgrade detected/);
  assert.doesNotThrow(() => assertNoProtectedGoalEngineArtifacts(run, compiled));
});

test("sealed compiler inventory is authoritative for names, aliases, and roles.fromAgent while normal discovery remains compatible", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "goal-agent-inventory-"));
  roots.push(cwd);
  await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
  await writeFile(join(cwd, ".pi", "agents", "ambient.md"), "---\nname: ambient-name\ntools: [read]\n---\nAmbient body\n");

  const ambientSpec = spec({ agentName: "ambient" });
  const normal = await compileWorkflow(ambientSpec, { cwd, availableModels: [model] });
  assert.equal(normal.tasks[0].agent, "ambient");
  assert.deepEqual(normal.backend, { type: "local-pi", mode: "headless" });
  const authoredGoalBackend = spec({ agentName: "ambient" });
  authoredGoalBackend.defaults.backend = { type: "goal-sdk", mode: "sealed" };
  await assert.rejects(() => compileWorkflow(authoredGoalBackend, { cwd, availableModels: [model] }), /must be "local-pi"/);
  await assert.rejects(() => compileWorkflow(ambientSpec, { cwd, availableModels: [model], agentDefinitions: new Map() }), /unknown agent/);

  const trusted = agent("trusted", ["trusted", "sealed-alias"]);
  const inventory = new Map([["trusted-key", trusted]]);
  const aliasSpec = spec({ agentName: "sealed-alias" });
  aliasSpec.roles = { reviewer: { fromAgent: "sealed-alias" } };
  const sealed = await compileWorkflow(aliasSpec, { cwd, availableModels: [model], agentDefinitions: inventory });
  assert.equal(sealed.tasks[0].agentDescription, undefined);
  aliasSpec.roles.reviewer.fromAgent = "ambient-name";
  await assert.rejects(() => compileWorkflow(aliasSpec, { cwd, availableModels: [model], agentDefinitions: inventory }), /unknown agent/);
});

test("W03 ordinary workflow physically keeps the existing automatic managed-worktree default outside Goal", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ordinary-managed-worktree-"));
  roots.push(cwd);
  execFileSync("git", ["init", "--initial-branch=main"], { cwd, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Goal Runtime Test"], { cwd });
  execFileSync("git", ["config", "user.email", "goal-runtime@example.invalid"], { cwd });
  await writeFile(join(cwd, "tracked.txt"), "baseline\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd, stdio: "ignore" });

  const ordinary = agent("ordinary-writer");
  ordinary.tools = ["read", "write"];
  ordinary.readOnly = false;
  const definition = spec({ agentName: ordinary.name });
  definition.defaults.readOnly = false;
  definition.defaults.tools = ["read", "write"];
  const specPath = join(cwd, "ordinary.json");
  await writeFile(specPath, JSON.stringify(definition));
  const compiled = await compileWorkflow(definition, {
    cwd, task: "ordinary mutation", agentDefinitions: new Map([[ordinary.name, ordinary]]),
  });
  assert.deepEqual(compiled.backend, { type: "local-pi", mode: "headless" });
  assert.equal(compiled.goal, undefined);
  assert.equal(compiled.tasks[0].explicitWorktreePolicy, false);
  assert.equal(compiled.tasks[0].safety.worktreePolicy, "auto");
  assert.equal(compiled.tasks[0].safety.requiresWorktree, true);
  assert.equal(compiled.tasks[0].safety.sharedCwdSafe, false);

  const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
  await ensureManagedWorktree(cwd, run, run.tasks[0], compiled.tasks[0]);
  assert.equal(run.tasks[0].worktree.enabled, true);
  assert.notEqual(run.tasks[0].worktree.path, cwd);
  assert.equal(run.tasks[0].cwd, run.tasks[0].worktree.path);
  assert.equal(await readFile(join(run.tasks[0].cwd, "tracked.txt"), "utf8"), "baseline\n");
  assert.equal(
    await realpath(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: run.tasks[0].cwd, encoding: "utf8" }).trim()),
    await realpath(run.tasks[0].worktree.path),
  );
});
