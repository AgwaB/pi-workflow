import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readOrdinaryWorkflowGoalStatuses, resolveOrdinaryWorkflowGoal } from "../../.tmp/unit/goal-workflow-commands.js";

const roots = [];
after(() => Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))));

async function workspace(runIds, goalIds = {}) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "goal-resolve-")));
  roots.push(cwd);
  for (const runId of runIds) {
    await mkdir(join(cwd, ".pi", "workflows", runId), { recursive: true });
    await writeFile(join(cwd, ".pi", "workflows", runId, "run.json"), JSON.stringify({ schemaVersion: 1, runId, status: "completed", cwd,
      goalParticipation: { schemaVersion: 1, resumeRequired: false, goalPaths: ["goal"] },
      tasks: [{ taskId: "task-1", specId: "goal.main", kind: "goal", status: "completed",
        ...(goalIds[runId] ? { goal: { goalId: goalIds[runId], state: "engine:achieved" } } : {}) }] }));
  }
  return cwd;
}

test("run identifiers: exact wins, a unique prefix resolves on slash commands only, ambiguity is refused", async () => {
  const cwd = await workspace(["workflow_aaa111_one", "workflow_aaa111_one2", "workflow_bbb222_two"]);
  assert.equal((await resolveOrdinaryWorkflowGoal(cwd, "workflow_aaa111_one")).run.runId, "workflow_aaa111_one",
    "an exact ID wins although it prefixes another run");
  assert.equal((await resolveOrdinaryWorkflowGoal(cwd, "workflow_bbb")).run.runId, "workflow_bbb222_two");
  await assert.rejects(resolveOrdinaryWorkflowGoal(cwd, "workflow_bbb", true), /unavailable or ambiguous/,
    "the tool requires exact IDs");
  await assert.rejects(resolveOrdinaryWorkflowGoal(cwd, "workflow_aaa"), /unavailable or ambiguous/);
  await assert.rejects(resolveOrdinaryWorkflowGoal(cwd, "workflow_zzz"), /unavailable or ambiguous/);
  for (const id of ["../workflow_aaa111_one", "", "-x", "a/b", "a.b"])
    await assert.rejects(resolveOrdinaryWorkflowGoal(cwd, id), /Invalid ordinary Goal workflow identifier/, id);
});

test("goal_engine identifiers must be exact and unique", async () => {
  const id = `goal_engine_${"a".repeat(32)}`;
  const cwd = await workspace(["workflow_c1", "workflow_c2"], { workflow_c1: id, workflow_c2: `goal_engine_${"b".repeat(32)}` });
  assert.equal((await resolveOrdinaryWorkflowGoal(cwd, id)).run.runId, "workflow_c1");
  await assert.rejects(resolveOrdinaryWorkflowGoal(cwd, "goal_engine_aaaa"), /exact goal_engine identifier/);
  const duplicated = await workspace(["workflow_d1", "workflow_d2"], { workflow_d1: id, workflow_d2: id });
  await assert.rejects(resolveOrdinaryWorkflowGoal(duplicated, id), /unavailable or ambiguous/);
});

test("listing many runs isolates unverifiable records and stays bounded", async () => {
  const runIds = Array.from({ length: 120 }, (_, index) => `workflow_many_${String(index).padStart(3, "0")}`);
  const cwd = await workspace(runIds);
  const statuses = await readOrdinaryWorkflowGoalStatuses(cwd);
  assert.equal(statuses.runs.length, 120);
  assert.ok(statuses.runs.every(entry => entry.error), "fabricated runs without compiled records are unverifiable, one by one");
  assert.equal(statuses.text.split("\n\n").length, 120);
});

test("a symlinked run directory fails the listing closed", async () => {
  const cwd = await workspace(["workflow_real"]);
  const outside = await realpath(await mkdtemp(join(tmpdir(), "goal-resolve-outside-")));
  roots.push(outside);
  await symlink(outside, join(cwd, ".pi", "workflows", "workflow_link"));
  await assert.rejects(readOrdinaryWorkflowGoalStatuses(cwd), /symbolic links/);
});
