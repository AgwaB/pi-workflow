// A Goal request that arrives as the Goal stops fails its worker as before, but
// it must not fail the stop cleanup's channel drain ("could not confirm
// cancellation; cleanup cause: workflow stop requested"). Seen under load.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openGoalAuthenticatedLocalSession } from "../../.tmp/unit/goal-authenticated-local-channel.js";
import { goalHash } from "../../.tmp/unit/goal-json.js";
import { createGoalRequestBudget, openGoalRequestBudgetChannel } from "../../.tmp/unit/workflow-goal-workspace-tools.js";
import { createWorkflowStopRequestedError } from "../../.tmp/unit/workflow-stop.js";

async function stoppingChannel(t, failure) {
  const cwd = await mkdtemp(join(tmpdir(), "goal-stop-deny-"));
  const evidenceRoot = join(cwd, "evidence");
  const budget = createGoalRequestBudget(2);
  const stopped = new AbortController();
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let checks = 0;
  const channel = await openGoalRequestBudgetChannel({
    directory: join(cwd, "rpc"), evidenceRoot, identity: { runId: "workflow_root", taskId: "task-1" },
    attemptKey: "attempt", model: "openai/gpt-5.2", budget,
    // The first currentness check of the reservation waits until the stop has
    // started; then the check fails the way a stopping Goal makes it fail.
    current: async () => {
      if (++checks === 1) { entered.resolve(); await release.promise; failure(stopped); }
      return "authority";
    },
    live() {}, stopped: stopped.signal,
  });
  const extension = await readFile(channel.extensionPath, "utf8");
  const binding = JSON.parse(extension.match(/registerGoalRequestBudget\(pi, (\{[^\n]+\}), /)[1]);
  const session = await openGoalAuthenticatedLocalSession(binding);
  t.after(async () => { await session.close().catch(() => undefined); stopped.abort(); await rm(cwd, { recursive: true, force: true }); });
  return { channel, budget, session, evidenceRoot, entered, release };
}

for (const [label, failure] of [
  ["the stop signal", stopped => { stopped.abort(createWorkflowStopRequestedError("workflow_root")); stopped.signal.throwIfAborted(); }],
  ["the durable stop intent", () => { throw createWorkflowStopRequestedError("workflow_root"); }],
]) test(`a reservation refused by ${label} fails its worker but not the stop drain`, async t => {
  const { channel, budget, session, evidenceRoot, entered, release } = await stoppingChannel(t, failure);
  const id = "late-request";
  const reply = session.exchange({ id, commitment: goalHash({ id }), action: "reserve" },
    { operationId: id, fingerprint: goalHash({ id }) });
  reply.catch(() => undefined);
  await entered.promise;
  const drain = channel.drain();
  setTimeout(() => release.resolve(), 200); // fail only once the drain waits for the request
  await drain;
  await assert.rejects(reply, "the worker's request fails as before, so it is not sent");
  assert.equal(existsSync(evidenceRoot), false, "nothing was reserved");
  assert.equal(await budget.settledRequestCount(), 0);
  assert.doesNotThrow(() => budget.assertSettled(), "no UNKNOWN reservation");
});
