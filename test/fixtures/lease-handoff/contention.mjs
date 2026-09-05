import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireWorkflowTopologyLease, readIndex, readJson, readRunRecord,
  withRunLease, workflowRunPath, workflowsRoot, writeJsonAtomic, writeRunRecord,
} from "../../../.tmp/unit/store.js";
import {
  beginParentUsageTracking, flushParentUsageTracking, readParentUsage,
  recordParentSessionUsage,
} from "../../../.tmp/unit/workflow-parent-usage.js";

const fixture = fileURLToPath(import.meta.url);
const record = (runId, parentRunId) => ({
  schemaVersion: 1, runId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  ...(parentRunId ? { parentRunId, rootRunId: parentRunId } : {}),
  tasks: [{ taskId: `${runId}-task`, specId: "s", status: "running" }],
});
async function publish(cwd, runId, parentRunId) {
  assert.equal(await withRunLease(cwd, runId, async signal => {
    await writeRunRecord(cwd, record(runId, parentRunId), signal);
    signal.throwIfAborted();
    return true;
  }), true);
}

async function worker(cwd, mode, workerId, iterations) {
  let completed = 0;
  try {
    await new Promise(resolve => {
      process.once("message", resolve);
      process.send({ ready: true });
    });
    const usage = mode === "usage" || mode === "mixed";
    const runId = `workflow_usage_${workerId}`;
    const session = `owner-${workerId}`;
    if (usage) {
      beginParentUsageTracking(cwd, runId, session);
      await flushParentUsageTracking(cwd, session);
    }
    for (let i = 0; i < iterations; i++) {
      if (mode === "topology" || mode === "mixed") {
        const lease = await acquireWorkflowTopologyLease(cwd);
        assert.ok(lease, "topology acquisition must settle without caller retries");
        try {
          await lease.assertOwner();
          const counter = join(workflowsRoot(cwd), "handoffs.json");
          const previous = await readJson(counter) ?? { count: 0 };
          await writeJsonAtomic(counter, { count: previous.count + 1 }, lease.signal, lease.assertOwner);
          await lease.assertOwner();
          assert.equal(lease.signal.aborted, false);
        } finally { await lease.release(); }
      }
      if (mode === "publication" || mode === "mixed")
        await publish(cwd, `workflow_child_${workerId}_${i}`, "workflow_parent");
      if (usage) {
        const message = { role: "assistant", timestamp: i + 1, usage: { totalTokens: 3 } };
        const receipt = `message-${workerId}-${i}`;
        await recordParentSessionUsage(cwd, message, session, receipt);
        // Replay one receipt periodically: exact accounting, not merely a
        // successful exit, must survive composed topology/sidecar handoffs.
        if (i % 10 === 0) await recordParentSessionUsage(cwd, message, session, receipt);
      }
      completed++;
    }
    if (usage) await flushParentUsageTracking(cwd, session, true);
    console.log(JSON.stringify({ completed }));
  } catch (error) {
    console.log(JSON.stringify({ completed, error: error?.stack ?? String(error) }));
    process.exitCode = 1;
  } finally { process.disconnect(); }
}

export async function runContention({ mode, iterations, repeats = 2, timeoutMs = 120_000 }) {
  assert.ok(["topology", "publication", "usage", "mixed"].includes(mode));
  assert.ok(Number.isInteger(iterations) && iterations > 0 && iterations <= 2000);
  assert.ok(Number.isInteger(repeats) && repeats > 0 && repeats <= 10);
  assert.ok(timeoutMs > 0 && timeoutMs <= 180_000);
  const summaries = [];
  for (let repeat = 0; repeat < repeats; repeat++) {
    const cwd = await mkdtemp(join(tmpdir(), "piwf-natural-handoff-"));
    const children = [];
    const joined = [];
    let timer;
    let timedOut = false;
    const started = Date.now();
    try {
      if (mode === "publication" || mode === "mixed") await publish(cwd, "workflow_parent");
      if (mode === "usage" || mode === "mixed")
        for (let i = 0; i < 4; i++) await publish(cwd, `workflow_usage_${i}`);
      const ready = [];
      for (let i = 0; i < 4; i++) {
        const child = spawn(process.execPath, [fixture, "worker", cwd, mode, String(i), String(iterations)], {
          stdio: ["ignore", "pipe", "pipe", "ipc"], env: process.env,
        });
        children.push(child);
        let stdout = "", stderr = "";
        child.stdout.on("data", data => { stdout += data; });
        child.stderr.on("data", data => { stderr += data; });
        child.on("error", error => { stderr += error.stack; });
        // Resolve readiness on early exit too, so startup errors cannot strand
        // the barrier. Every process is joined on close, including failures.
        ready.push(new Promise(resolve => {
          child.once("message", resolve);
          child.once("close", resolve);
        }));
        joined.push(new Promise(resolve => child.once("close", (status, signal) => {
          resolve({ worker: i, status, signal, stdout: stdout.trim(), stderr: stderr.trim() });
        })));
      }
      timer = setTimeout(() => {
        timedOut = true;
        for (const child of children) child.kill("SIGKILL");
      }, timeoutMs);
      await Promise.all(ready);
      for (const child of children) if (child.connected) child.send({ go: true }, () => {});
      const results = await Promise.all(joined);
      const summary = { mode, repeat, workers: 4, iterations, timedOut, elapsedMs: Date.now() - started, results };
      console.log(JSON.stringify(summary));
      assert.equal(timedOut, false, "bounded contention deadline");
      for (const result of results) {
        assert.equal(result.status, 0, JSON.stringify(result));
        assert.equal(result.stderr, "");
        assert.deepEqual(JSON.parse(result.stdout), { completed: iterations });
      }
      const expected = 4 * iterations;
      if (mode === "topology" || mode === "mixed") {
        assert.deepEqual(await readJson(join(workflowsRoot(cwd), "handoffs.json")), { count: expected });
        summary.protectedWrites = expected;
      }
      if (mode === "publication" || mode === "mixed") {
        const index = await readIndex(cwd);
        const children = index.runs.filter(run => run.runId.startsWith("workflow_child_"));
        assert.equal(children.length, expected);
        assert.equal(new Set(children.map(run => run.runId)).size, expected);
        for (let worker = 0; worker < 4; worker++) for (let i = 0; i < iterations; i++) {
          const id = `workflow_child_${worker}_${i}`;
          const run = await readRunRecord(cwd, id);
          assert.equal(run.runId, id);
          assert.equal(run.parentRunId, "workflow_parent");
          assert.equal(run.rootRunId, "workflow_parent");
          assert.equal(run.status, "running");
          assert.ok(await readFile(workflowRunPath(cwd, id)));
        }
        summary.publications = expected;
      }
      if (mode === "usage" || mode === "mixed") {
        for (let worker = 0; worker < 4; worker++) {
          const usage = await readParentUsage(cwd, `workflow_usage_${worker}`);
          assert.equal(usage.sessionId, `owner-${worker}`);
          assert.equal(usage.assistantMessages, iterations);
          assert.equal(usage.totalTokens, 3 * iterations);
          assert.equal(usage.messageIds.length, iterations);
          assert.deepEqual(new Set(usage.messageIds), new Set(Array.from({ length: iterations }, (_, i) => `message-${worker}-${i}`)));
          assert.equal(usage.lastWriteFailure, undefined, "no hidden queue retry errors");
        }
        summary.messages = expected;
        summary.tokens = expected * 3;
        summary.receipts = expected;
      }
      const artifacts = await readdir(workflowsRoot(cwd), { recursive: true });
      assert.deepEqual(artifacts.filter(path => /(?:\.lock(?:\.|$)|\.tmp$)/.test(path)), []);
      console.log(JSON.stringify({ verified: summary }));
      summaries.push(summary);
    } finally {
      clearTimeout(timer);
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await Promise.allSettled(joined);
      await rm(cwd, { recursive: true, force: true });
    }
  }
  return summaries;
}

if (process.argv[1] === fixture && process.argv[2] === "worker")
  await worker(process.argv[3], process.argv[4], Number(process.argv[5]), Number(process.argv[6]));
else if (process.argv[1] === fixture)
  await runContention({ mode: process.argv[2], iterations: Number(process.argv[3]), repeats: Number(process.argv[4] ?? 2) });
