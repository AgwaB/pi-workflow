import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  goalCompiledMaterializationDigest,
  persistGoalGeneratedMaterialization,
  recoverGoalGeneratedMaterialization,
  setGoalGeneratedMaterializationHookForTests,
} from "../../.tmp/unit/goal-generated-materialization.js";
import {
  compiledWorkflowPath,
  flushPendingIndexUpdatesForTests,
  readJson,
  readRunRecord,
  writeJsonAtomic,
  writeRunRecord,
} from "../../.tmp/unit/store.js";

const root = await mkdtemp(join(tmpdir(), "goal-generated-materialization-"));
after(async () => {
  await flushPendingIndexUpdatesForTests();
  await rm(root, { recursive: true, force: true });
});
afterEach(() => setGoalGeneratedMaterializationHookForTests(undefined));

function fixture(label) {
  const cwd = join(root, label);
  const runId = `run-${label}`;
  const authored = { id: "adaptive.controller", taskId: "adaptive", stageId: "adaptive", kind: "dynamic", runtime: {} };
  const generated = {
    id: "adaptive.worker",
    taskId: "worker",
    stageId: "adaptive",
    kind: "dynamic-agent",
    runtime: {},
    dynamicGenerated: {
      controllerSpecId: "adaptive.controller",
      opId: "adaptive.controller:agent:worker",
      requestHash: "a".repeat(64),
      profileSlot: "workerDefaults",
    },
  };
  const before = {
    schemaVersion: 1,
    type: "artifact-graph",
    cwd,
    maxConcurrency: 1,
    backend: "pi-subagent",
    roles: [],
    warnings: [],
    tasks: [authored],
  };
  const afterCompiled = structuredClone(before);
  afterCompiled.tasks.push(generated);
  const run = {
    schemaVersion: 1,
    runId,
    rootRunId: runId,
    type: "artifact-graph",
    status: "running",
    taskSummary: { pending: 2, running: 0, blocked: 0, completed: 0, failed: 0, skipped: 0, interrupted: 0, total: 2 },
    cwd,
    backend: "pi-subagent",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    goal: { bindingHash: "b".repeat(64) },
    tasks: [
      { taskId: "adaptive", specId: authored.id, status: "pending", cwd, runtime: {}, files: {} },
      { taskId: "worker", specId: generated.id, status: "pending", cwd, runtime: {}, files: {} },
    ],
  };
  return { cwd, runId, before, afterCompiled, run };
}

test("ordinary graph persistence needs no Goal digest or journal", async () => {
  const value = fixture("ordinary");
  delete value.run.goal;
  setGoalGeneratedMaterializationHookForTests(() => {
    assert.fail("ordinary persistence must not enter Goal journaling");
  });
  await persistGoalGeneratedMaterialization(value.cwd, value.run, value.afterCompiled, undefined);
  assert.deepEqual(await readJson(compiledWorkflowPath(value.cwd, value.runId)), value.afterCompiled);
  const persisted = await readRunRecord(value.cwd, value.runId);
  assert.deepEqual(persisted.tasks, value.run.tasks);
  assert.equal(persisted.goalGeneratedMaterialization, undefined);
});

test("ordinary graph persistence does not inherit the Goal JSON byte ceiling", async () => {
  const value = fixture("ordinary-large");
  delete value.run.goal;
  value.afterCompiled.tasks = Array.from({ length: 256 }, (_, index) => ({
    ...value.afterCompiled.tasks[0],
    id: `ordinary.${index}`, taskId: `task-${index}`, kind: "single",
    compiledPrompt: "ordinary context ".repeat(256),
  }));
  value.run.tasks = value.afterCompiled.tasks.map(task => ({
    ...value.run.tasks[0], taskId: task.taskId, specId: task.id,
  }));
  value.run.taskSummary = { ...value.run.taskSummary, pending: 256, total: 256 };
  assert.throws(() => goalCompiledMaterializationDigest(value.afterCompiled), /Goal JSON byte limit/);
  await persistGoalGeneratedMaterialization(value.cwd, value.run, value.afterCompiled, undefined);
  assert.deepEqual(await readJson(compiledWorkflowPath(value.cwd, value.runId)), value.afterCompiled);
  const saved = await readRunRecord(value.cwd, value.runId);
  assert.deepEqual(saved.tasks, value.run.tasks);
  assert.equal(saved.goalGeneratedMaterialization, undefined);
});

test("Goal graph persistence still rejects a missing baseline digest before writes", async () => {
  const value = fixture("missing-baseline");
  await assert.rejects(
    persistGoalGeneratedMaterialization(value.cwd, value.run, value.afterCompiled, undefined),
    /baseline invalid/,
  );
  assert.equal(await readJson(compiledWorkflowPath(value.cwd, value.runId)), undefined);
  assert.equal(value.run.goalGeneratedMaterialization, undefined);
});

for (const boundary of ["prepared-run-written", "compiled-written"]) {
  test(`DP08 Goal generated materialization recovers after ${boundary}`, async () => {
    const value = fixture(boundary);
    await mkdir(dirname(compiledWorkflowPath(value.cwd, value.runId)), { recursive: true });
    await writeJsonAtomic(compiledWorkflowPath(value.cwd, value.runId), value.before);
    await writeRunRecord(value.cwd, value.run);
    setGoalGeneratedMaterializationHookForTests((observed) => {
      if (observed === boundary) throw new Error(`crash:${boundary}`);
    });
    await assert.rejects(
      persistGoalGeneratedMaterialization(
        value.cwd,
        value.run,
        value.afterCompiled,
        goalCompiledMaterializationDigest(value.before),
      ),
      new RegExp(`crash:${boundary}`),
    );
    setGoalGeneratedMaterializationHookForTests(undefined);

    const persistedRun = await readRunRecord(value.cwd, value.runId);
    const persistedCompiled = await readJson(compiledWorkflowPath(value.cwd, value.runId));
    assert.ok(persistedRun.goalGeneratedMaterialization);
    assert.equal(persistedRun.tasks.length, 2);

    assert.equal(
      await recoverGoalGeneratedMaterialization(
        value.cwd,
        persistedRun,
        persistedCompiled,
      ),
      true,
    );
    const recoveredRun = await readRunRecord(value.cwd, value.runId);
    const recoveredCompiled = await readJson(compiledWorkflowPath(value.cwd, value.runId));
    assert.equal(recoveredRun.goalGeneratedMaterialization, undefined);
    assert.deepEqual(recoveredCompiled.tasks, value.afterCompiled.tasks);
    assert.equal(recoveredRun.tasks.length, 2);
  });
}
