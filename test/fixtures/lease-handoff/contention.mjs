import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import fsPromises, { mkdtemp, open, opendir, readFile, readdir, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
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

async function denialEvidence(cwd, phase, releasePhase) {
  const evidence = { observedAt: Date.now(), phase, releasePhase,
    owner: null, census: { scanned: 0, truncated: false, retentionLocks: 0,
      releaseArtifacts: 0, abandonmentArtifacts: 0 }, readErrors: [] };
  try {
    const handle = await open(join(workflowsRoot(cwd), "retention.lock"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > 1024) throw new Error("INVALID_LOCK");
      const bytes = Buffer.alloc(1025);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const after = await handle.stat();
      const [ownerId, pidText, createdAt] = bytes.subarray(0, bytesRead).toString("utf8").split(/\r?\n/);
      if (bytesRead > 1024 || !/^\d+-[a-f0-9]{12}$/.test(ownerId) ||
          !/^\d+$/.test(pidText) || !Number.isFinite(Date.parse(createdAt)))
        throw new Error("INVALID_LOCK");
      evidence.owner = { ownerId, pid: Number(pidText), createdAtMs: Date.parse(createdAt),
        mtimeMs: after.mtimeMs, inode: after.ino,
        stableRead: before.ino === after.ino && before.size === after.size &&
          before.mtimeMs === after.mtimeMs };
    } finally { await handle.close(); }
  } catch (error) {
    evidence.readErrors.push({ operation: "owner",
      code: ["ENOENT", "ELOOP", "EACCES", "EPERM"].includes(error?.code) ? error.code : "UNAVAILABLE" });
  }
  try {
    const directory = await opendir(workflowsRoot(cwd));
    for await (const entry of directory) {
      if (++evidence.census.scanned > 256) { evidence.census.truncated = true; break; }
      if (entry.name === "retention.lock") evidence.census.retentionLocks++;
      else if (entry.name.startsWith("retention.lock.abandoned-")) evidence.census.abandonmentArtifacts++;
      else if (entry.name.startsWith("retention.lock.")) evidence.census.releaseArtifacts++;
    }
  } catch {
    evidence.readErrors.push({ operation: "census", code: "UNAVAILABLE" });
  }
  return evidence;
}

async function worker(cwd, mode, workerId, iterations) {
  let completed = 0;
  let phase = "startup";
  const releasePhase = { state: "not-started", startedAt: null, settledAt: null };
  const wave = { rounds: 0, entered: 0, released: 0, ioEntered: 0, ioReleased: 0, advanced: 0 };
  const retentionLock = join(workflowsRoot(cwd), "retention.lock");
  const genuineOpen = fsPromises.open;
  let armedRound = -1;
  let interceptedRound = -1;
  let awaiting;
  let protocolFailure;
  const failProtocol = error => {
    if (protocolFailure) return;
    protocolFailure = error;
    awaiting?.reject(error);
    awaiting = undefined;
  };
  const waitFor = (type, round) => {
    if (protocolFailure) throw protocolFailure;
    assert.equal(awaiting, undefined, "worker protocol may await only one event");
    return new Promise((resolve, reject) => { awaiting = { type, round, resolve, reject }; });
  };
  process.on("message", message => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      failProtocol(new Error("malformed parent wave message"));
      return;
    }
    if (!awaiting || message.type !== awaiting.type ||
        (awaiting.round === undefined
          ? Object.keys(message).length !== 1
          : Object.keys(message).length !== 2 || message.round !== awaiting.round)) {
      failProtocol(new Error(`unexpected parent wave message: ${JSON.stringify(message)}`));
      return;
    }
    const { resolve } = awaiting;
    awaiting = undefined;
    resolve();
  });
  process.on("disconnect", () => {
    if (wave.advanced !== iterations) failProtocol(new Error("parent disconnected before final wave advance"));
  });
  const send = message => new Promise((resolve, reject) => {
    if (!process.connected) { reject(new Error("parent IPC channel closed")); return; }
    process.send(message, error => error ? reject(error) : resolve());
  });
  const guardedOpen = async (...args) => {
    if (armedRound >= 0 && interceptedRound !== armedRound &&
        args[0] === retentionLock && args[1] === "wx") {
      interceptedRound = armedRound;
      const ioGo = waitFor("io-go", armedRound);
      wave.ioEntered++;
      await send({ type: "io-enter", round: armedRound });
      await ioGo;
      wave.ioReleased++;
    }
    return genuineOpen(...args);
  };
  try {
    const startup = waitFor("start");
    await send({ ready: true });
    await startup;
    const usage = mode === "usage" || mode === "mixed";
    const runId = `workflow_usage_${workerId}`;
    const session = `owner-${workerId}`;
    if (usage) {
      phase = "usage-initialize";
      beginParentUsageTracking(cwd, runId, session);
      await flushParentUsageTracking(cwd, session);
    }
    fsPromises.open = guardedOpen;
    syncBuiltinESMExports();
    for (let i = 0; i < iterations; i++) {
      phase = "round-enter";
      const released = waitFor("round-go", i);
      await send({ type: "round-enter", round: i });
      wave.entered++;
      await released;
      wave.released++;
      armedRound = i;
      if (mode === "topology" || mode === "mixed") {
        phase = "topology-acquire";
        const lease = await acquireWorkflowTopologyLease(cwd);
        assert.ok(lease, "topology acquisition must settle without caller retries");
        try {
          phase = "topology-write";
          await lease.assertOwner();
          const counter = join(workflowsRoot(cwd), "handoffs.json");
          const previous = await readJson(counter) ?? { count: 0 };
          await writeJsonAtomic(counter, { count: previous.count + 1 }, lease.signal, lease.assertOwner);
          await lease.assertOwner();
          assert.equal(lease.signal.aborted, false);
        } finally {
          phase = "topology-release";
          releasePhase.state = "pending";
          releasePhase.startedAt = Date.now();
          releasePhase.settledAt = null;
          try {
            await lease.release();
            releasePhase.state = "released";
          } catch (error) {
            releasePhase.state = "failed";
            throw error;
          } finally { releasePhase.settledAt = Date.now(); }
        }
      }
      if (mode === "publication" || mode === "mixed") {
        phase = "publication";
        await publish(cwd, `workflow_child_${workerId}_${i}`, "workflow_parent");
      }
      if (usage) {
        phase = "usage-record";
        const message = { role: "assistant", timestamp: i + 1, usage: { totalTokens: 3 } };
        const receipt = `message-${workerId}-${i}`;
        await recordParentSessionUsage(cwd, message, session, receipt);
        // Replay one receipt periodically: exact accounting, not merely a
        // successful exit, must survive composed topology/sidecar handoffs.
        if (i % 10 === 0) await recordParentSessionUsage(cwd, message, session, receipt);
      }
      completed++;
      phase = "round-done";
      const advanced = waitFor("round-advance", i);
      await send({ type: "round-done", round: i });
      await advanced;
      wave.rounds++;
      wave.advanced++;
      armedRound = -1;
    }
    if (usage) {
      phase = "usage-flush";
      await flushParentUsageTracking(cwd, session, true);
    }
    assert.deepEqual(wave, {
      rounds: iterations, entered: iterations, released: iterations,
      ioEntered: iterations, ioReleased: iterations, advanced: iterations,
    });
    console.log(JSON.stringify({ completed, wave }));
  } catch (error) {
    // Failure-only observation, not retry authority or a reconstructed owner
    // history. Preserve the original failure before parent fixture teardown.
    const diagnostic = await denialEvidence(cwd, phase, releasePhase);
    console.log(JSON.stringify({ completed, error: error?.stack ?? String(error), diagnostic }));
    process.exitCode = 1;
  } finally {
    fsPromises.open = genuineOpen;
    syncBuiltinESMExports();
    if (process.connected) process.disconnect();
  }
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
    let failure;
    let rejectFailure;
    let startedWaves = false;
    let finalWaveAdvanced = false;
    const readyWorkers = new Set();
    const completedWaves = [];
    const wave = {
      round: 0, phase: "enter", entered: new Set(), released: new Set(), ioEntered: new Set(),
      ioReleased: new Set(), done: new Set(), rounds: 0,
    };
    const failed = new Promise((_, reject) => { rejectFailure = reject; });
    void failed.catch(() => {});
    const fail = error => {
      if (failure) return;
      failure = error instanceof Error ? error : new Error(String(error));
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      rejectFailure(failure);
    };
    const send = (child, message) => {
      if (failure) return;
      if (!child.connected) { fail(new Error(`worker ${children.indexOf(child)} IPC channel closed`)); return; }
      try {
        child.send(message, error => { if (error) fail(error); });
      } catch (error) { fail(error); }
    };
    let resolveReady;
    const allReady = new Promise(resolve => { resolveReady = resolve; });
    const protocolError = (worker, message) =>
      new Error(`worker ${worker} invalid wave protocol message: ${JSON.stringify(message)}`);
    const receive = (worker, message) => {
      if (failure) return;
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        fail(protocolError(worker, message));
        return;
      }
      if (!startedWaves) {
        if (message.ready !== true || Object.keys(message).length !== 1 || readyWorkers.has(worker)) {
          fail(protocolError(worker, message));
          return;
        }
        readyWorkers.add(worker);
        if (readyWorkers.size === 4) resolveReady();
        return;
      }
      if (message.type === "round-enter") {
        if (!Number.isInteger(message.round) || Object.keys(message).length !== 2 ||
            wave.phase !== "enter" || message.round !== wave.round || wave.entered.has(worker)) {
          fail(protocolError(worker, message));
          return;
        }
        wave.entered.add(worker);
        if (wave.entered.size !== 4) return;
        if (wave.done.size !== 0) { fail(new Error("round released after completion")); return; }
        wave.phase = "released";
        wave.released = new Set();
        for (const [worker, child] of children.entries()) {
          wave.released.add(worker);
          send(child, { type: "round-go", round: wave.round });
        }
        if (wave.released.size !== 4) { fail(new Error("round did not release four workers")); return; }
        return;
      }
      if (message.type === "io-enter") {
        if (!Number.isInteger(message.round) || Object.keys(message).length !== 2 ||
            wave.phase !== "released" || message.round !== wave.round || wave.ioEntered.has(worker)) {
          fail(protocolError(worker, message));
          return;
        }
        wave.ioEntered.add(worker);
        if (wave.ioEntered.size !== 4) return;
        if (wave.done.size !== 0 || wave.released.size !== 4) {
          fail(new Error("exclusive-create boundary released before four workers arrived"));
          return;
        }
        wave.phase = "io-released";
        wave.ioReleased = new Set();
        for (const [worker, child] of children.entries()) {
          wave.ioReleased.add(worker);
          send(child, { type: "io-go", round: wave.round });
        }
        if (wave.ioReleased.size !== 4) { fail(new Error("exclusive-create boundary did not release four workers")); return; }
        return;
      }
      if (message.type === "round-done") {
        if (!Number.isInteger(message.round) || Object.keys(message).length !== 2 ||
            wave.phase !== "io-released" || message.round !== wave.round || wave.done.has(worker)) {
          fail(protocolError(worker, message));
          return;
        }
        if (wave.released.size !== 4 || wave.entered.size !== 4 ||
            wave.ioEntered.size !== 4 || wave.ioReleased.size !== 4) {
          fail(new Error("worker completed before four-worker release"));
          return;
        }
        wave.done.add(worker);
        if (wave.done.size !== 4) return;
        if (wave.entered.size !== 4) { fail(new Error("round completed without four unique workers")); return; }
        completedWaves.push({
          round: wave.round, entered: [...wave.entered].sort(), released: [...wave.released].sort(),
          ioEntered: [...wave.ioEntered].sort(), ioReleased: [...wave.ioReleased].sort(),
          done: [...wave.done].sort(),
        });
        wave.rounds++;
        if (wave.round === iterations - 1) {
          finalWaveAdvanced = true;
          wave.phase = "final-advanced";
        } else {
          wave.round++;
          wave.phase = "enter";
          wave.entered = new Set();
          wave.released = new Set();
          wave.ioEntered = new Set();
          wave.ioReleased = new Set();
          wave.done = new Set();
        }
        for (const child of children) send(child, { type: "round-advance", round: message.round });
        return;
      }
      fail(protocolError(worker, message));
    };
    const started = Date.now();
    try {
      if (mode === "publication" || mode === "mixed") await publish(cwd, "workflow_parent");
      if (mode === "usage" || mode === "mixed")
        for (let i = 0; i < 4; i++) await publish(cwd, `workflow_usage_${i}`);
      for (let i = 0; i < 4; i++) {
        const child = spawn(process.execPath, [fixture, "worker", cwd, mode, String(i), String(iterations)], {
          stdio: ["ignore", "pipe", "pipe", "ipc"], env: process.env,
        });
        children.push(child);
        let stdout = "", stderr = "";
        child.stdout.on("data", data => { stdout += data; });
        child.stderr.on("data", data => { stderr += data; });
        child.on("error", error => { stderr += error.stack; fail(error); });
        child.on("message", message => receive(i, message));
        child.on("disconnect", () => {
          if (!finalWaveAdvanced) fail(new Error(`worker ${i} disconnected before final wave advance`));
        });
        joined.push(new Promise(resolve => child.once("close", (status, signal) => {
          if (!finalWaveAdvanced || status !== 0 || signal !== null)
            fail(new Error(`worker ${i} closed before clean final wave completion`));
          resolve({ worker: i, status, signal, stdout: stdout.trim(), stderr: stderr.trim() });
        })));
      }
      timer = setTimeout(() => {
        timedOut = true;
        fail(new Error("bounded contention deadline"));
      }, timeoutMs);
      await Promise.race([allReady, failed]);
      startedWaves = true;
      for (const child of children) send(child, { type: "start" });
      const results = await Promise.race([Promise.all(joined), failed]);
      assert.equal(wave.rounds, iterations, "parent completed every wave");
      assert.equal(wave.entered.size, 4, "final wave has four unique entrants");
      assert.equal(wave.released.size, 4, "final wave released all four workers");
      assert.equal(wave.ioEntered.size, 4, "final wave reached four exclusive-create call stacks");
      assert.equal(wave.ioReleased.size, 4, "final wave released four exclusive-create call stacks");
      assert.equal(wave.done.size, 4, "final wave has four completions");
      assert.deepEqual(completedWaves, Array.from({ length: iterations }, (_, round) => ({
        round, entered: [0, 1, 2, 3], released: [0, 1, 2, 3],
        ioEntered: [0, 1, 2, 3], ioReleased: [0, 1, 2, 3], done: [0, 1, 2, 3],
      })));
      const waveEvidence = {
        rounds: wave.rounds, completedWaves,
        exclusiveCreateBoundaryStacks: wave.ioEntered.size,
      };
      const summary = { mode, repeat, workers: 4, iterations, timedOut, elapsedMs: Date.now() - started, wave: waveEvidence, results };
      console.log(JSON.stringify(summary));
      assert.equal(timedOut, false, "bounded contention deadline");
      for (const result of results) {
        assert.equal(result.status, 0, JSON.stringify(result));
        assert.equal(result.stderr, "");
        assert.deepEqual(JSON.parse(result.stdout), {
          completed: iterations,
          wave: {
            rounds: iterations, entered: iterations, released: iterations,
            ioEntered: iterations, ioReleased: iterations, advanced: iterations,
          },
        });
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
    } catch (error) {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      const results = await Promise.all(joined);
      console.log(JSON.stringify({
        mode, repeat, workers: children.length, iterations, timedOut,
        elapsedMs: Date.now() - started, error: error?.stack ?? String(error),
        round: wave.round, phase: wave.phase, completedWaves, results,
      }));
      throw error;
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
