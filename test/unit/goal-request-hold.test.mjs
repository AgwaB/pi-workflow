import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createGoalRequestBudget } from "../../.tmp/unit/workflow-goal-workspace-tools.js";
import { attemptEndedOnItsOwnWhileStopping, recordObservedAttemptEnd } from "../../.tmp/unit/observed-attempt-ends.js";

const roots = [];
after(() => Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))));
const commitment = "c".repeat(64);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture() {
  const evidenceRoot = await mkdtemp(join(tmpdir(), "goal-hold-"));
  roots.push(evidenceRoot);
  const budget = createGoalRequestBudget(undefined);
  const peer = {};
  let stopped = false;
  const live = () => { if (stopped) throw new Error("Goal stopped"); };
  const op = (id, action, extra = {}) => budget.operate({ id, commitment, action, evidenceRoot, peer, live,
    current: async () => "authority", ...extra });
  return { budget, op, evidenceRoot, stop: () => { stopped = true; } };
}

test("a pause holds new requests while the request in flight finishes and settles", async () => {
  const { budget, op, evidenceRoot } = await fixture();
  await op("first", "reserve");
  await op("first", "release");
  const hold = budget.beginHold();
  assert.equal(hold.inFlight(), 1, "the released request is still in flight");
  let secondDone = false;
  const second = op("second", "reserve").then(() => { secondDone = true; });
  await sleep(200);
  assert.equal(secondDone, false, "a new request waits instead of failing");
  assert.ok(hold.heldForMs() >= 150, "the wait of the held request is measured");
  await op("first", "settle", { known: true });
  assert.equal(hold.inFlight(), 0, "the request in flight settled while new ones were held");
  hold.release();
  await second;
  assert.equal(secondDone, true, "releasing the hold lets the held request through");
  assert.equal((await readdir(evidenceRoot)).length, 2);
});

test("stopping the Goal ends a held request without reserving it", async () => {
  const { budget, op, evidenceRoot, stop } = await fixture();
  const hold = budget.beginHold();
  const held = op("late", "reserve");
  await sleep(120);
  stop();
  await assert.rejects(held, /Goal stopped/);
  hold.release();
  assert.deepEqual(await readdir(evidenceRoot), [], "no reservation was written, so nothing is UNKNOWN");
  assert.equal(await budget.settledRequestCount(), 0, "the budget stays known");
});

test("only an attempt end this process observed lets a stopped worker resume", () => {
  const task = { taskId: "task-3", status: "interrupted", statusDetail: "workflow_stopped" };
  const acknowledged = { attemptKey: "launch-retry:0;resume:0", phase: "acknowledged", backendAttemptId: "attempt_a" };
  assert.equal(attemptEndedOnItsOwnWhileStopping("/tmp/ws", "workflow_x", task, acknowledged), false,
    "a run record alone proves nothing");
  recordObservedAttemptEnd({ cwd: "/tmp/ws", runId: "workflow_x", taskId: "task-3", attemptKey: acknowledged.attemptKey,
    backendAttemptId: "attempt_a", status: "failed" });
  assert.equal(attemptEndedOnItsOwnWhileStopping("/tmp/ws", "workflow_x", task, acknowledged), true);
  assert.equal(attemptEndedOnItsOwnWhileStopping("/tmp/ws", "workflow_x", task, { ...acknowledged, backendAttemptId: "attempt_b" }),
    false, "another backend attempt");
  assert.equal(attemptEndedOnItsOwnWhileStopping("/tmp/ws", "workflow_x", { ...task, status: "running" }, acknowledged), false);
  const failedAck = { ...acknowledged, phase: "cancellation_acknowledged",
    cancellation: { terminalAttemptId: "attempt_a", terminalStatus: "failed", terminalObservedAt: "2026-11-04T00:00:00Z" } };
  assert.equal(attemptEndedOnItsOwnWhileStopping("/tmp/ws", "workflow_x", task, failedAck), true);
  assert.equal(attemptEndedOnItsOwnWhileStopping("/tmp/ws", "workflow_x", task,
    { ...failedAck, cancellation: { ...failedAck.cancellation, terminalStatus: "completed" } }), false);
  recordObservedAttemptEnd({ cwd: "/tmp/ws", runId: "workflow_x", taskId: "task-4", attemptKey: "k",
    backendAttemptId: "attempt_c", status: "completed" });
  assert.equal(attemptEndedOnItsOwnWhileStopping("/tmp/ws", "workflow_x", { ...task, taskId: "task-4" },
    { attemptKey: "k", phase: "acknowledged", backendAttemptId: "attempt_c" }), false, "only a failed end counts");
});

test("an earlier attempt that a pause stopped counts for later generations only with proof it ended", async () => {
  const { stoppedPredecessorAttemptForTests: stopped } = await import("../../.tmp/unit/goal-workflow-runtime.js");
  const run = { cwd: "/tmp/ws-pred", runId: "workflow_p" };
  const cancelled = { attemptKey: "a0", phase: "cancellation_acknowledged", backendAttemptId: "attempt_0",
    cancellation: { terminalAttemptId: "attempt_0", terminalStatus: "cancelled", terminalObservedAt: "2026-11-04T00:00:00Z" } };
  const resumed = { attemptKey: "a1", phase: "acknowledged", backendAttemptId: "attempt_1" };
  assert.equal(stopped(run, "task-2", cancelled, [cancelled, resumed]), true, "cleanly cancelled, then resumed");
  assert.equal(stopped(run, "task-2", cancelled, [cancelled]), false, "the last attempt must complete by itself");
  assert.equal(stopped(run, "task-2", { ...cancelled, cancellation: { ...cancelled.cancellation, terminalAttemptId: "attempt_x" } },
    [cancelled, resumed]), false, "the cancellation names another attempt");
  assert.equal(stopped(run, "task-2", { ...cancelled, cancellation: { ...cancelled.cancellation, terminalObservedAt: undefined } },
    [cancelled, resumed]), false, "no terminal observation");
  const failed = { ...cancelled, cancellation: { ...cancelled.cancellation, terminalStatus: "failed" } };
  assert.equal(stopped(run, "task-2", failed, [failed, resumed]), false, "a failed end read from the record alone");
  recordObservedAttemptEnd({ cwd: run.cwd, runId: run.runId, taskId: "task-2", attemptKey: "a0",
    backendAttemptId: "attempt_0", status: "failed" });
  assert.equal(stopped(run, "task-2", failed, [failed, resumed]), true, "a failed end this process saw");
  assert.equal(stopped(run, "task-2", { ...failed, cancellation: { ...failed.cancellation, terminalStatus: "completed" } },
    [failed, resumed]), false);
});
