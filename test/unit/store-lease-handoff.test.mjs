import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acquireWorkflowTopologyLease, setRunLeaseTestHooksForTests,
  workflowsRoot, writeJsonAtomic,
} from "../../.tmp/unit/store.js";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test("normal release snapshot cannot admit a replacement before its rename", { timeout: 10_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "piwf-handoff-"));
  let first, second;
  let snapshotReached = false;
  let restoreReached = false;
  try {
    first = await acquireWorkflowTopologyLease(cwd);
    assert.ok(first);
    setRunLeaseTestHooksForTests({
      heartbeatIntervalMs: 2,
      async onBeforeReleaseLockRename({ ownerId }) {
        if (ownerId !== first.ownerId || snapshotReached) return;
        snapshotReached = true;
        // On the old protocol B reclaims A here, precisely after A's snapshot
        // and before A renames the well-known path. On the fixed protocol B
        // must wait until A has actually detached its own generation.
        second = await acquireWorkflowTopologyLease(cwd, 0);
      },
      async onBeforeRestoreReclaimFile() {
        restoreReached = true;
        await sleep(30); // Let B's real heartbeat observe A's misplaced rename.
      },
    });
    await first.release();
    second ??= await acquireWorkflowTopologyLease(cwd);
    assert.ok(second);
    assert.equal(snapshotReached, true);
    assert.equal(second.signal.aborted, false, "replacement heartbeat must remain healthy");
    await second.assertOwner();
    const file = join(workflowsRoot(cwd), "protected.json");
    await writeJsonAtomic(file, { owner: second.ownerId }, second.signal, second.assertOwner);
    await sleep(30);
    await second.assertOwner();
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { owner: second.ownerId });
    assert.equal(restoreReached, false, "normal release never detaches the replacement");
  } finally {
    setRunLeaseTestHooksForTests();
    await second?.release();
    await first?.release();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("concurrent releases of one handle share cleanup and never touch the successor", { timeout: 10_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "piwf-shared-release-"));
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  let first, second;
  let releases = [];
  let attempts = 0;
  try {
    first = await acquireWorkflowTopologyLease(cwd);
    setRunLeaseTestHooksForTests({
      async onBeforeReleaseLockRename({ ownerId }) {
        if (ownerId !== first.ownerId) return;
        attempts++;
        entered.resolve();
        await resume.promise;
      },
    });
    releases = Array.from({ length: 8 }, () => first.release());
    await entered.promise;
    second = await acquireWorkflowTopologyLease(cwd, 0);
    assert.equal(second, undefined);
    resume.resolve();
    await Promise.all(releases);
    second = await acquireWorkflowTopologyLease(cwd);
    await first.release();
    assert.equal(attempts, 1);
    await second.assertOwner();
    assert.equal(second.signal.aborted, false);
  } finally {
    resume.resolve();
    await Promise.allSettled(releases);
    setRunLeaseTestHooksForTests();
    await second?.release();
    await first?.release();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("failed cleanup hands off only after all rename attempts and cannot resume after abandonment", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "piwf-failed-handoff-"));
  let first, second;
  let attempts = 0;
  try {
    first = await acquireWorkflowTopologyLease(cwd);
    const marker = join(workflowsRoot(cwd), `retention.lock.abandoned-${first.ownerId}`);
    setRunLeaseTestHooksForTests({
      async onBeforeReleaseLockRename({ ownerId }) {
        if (ownerId !== first.ownerId) return;
        attempts++;
        await assert.rejects(readFile(marker), { code: "ENOENT" });
        assert.equal(await acquireWorkflowTopologyLease(cwd, 0), undefined);
        throw Object.assign(new Error("release permission failure"), { code: "EPERM" });
      },
    });
    await assert.rejects(first.release(), /release permission failure/);
    assert.equal(attempts, 3);
    assert.equal(await readFile(marker, "utf8"), `${first.ownerId}\n`);
    assert.equal(first.signal.aborted, true);
    second = await acquireWorkflowTopologyLease(cwd, 0);
    assert.ok(second, "failed release is immediately reclaimable despite live PID");
    await first.release();
    assert.equal(attempts, 3);
    await second.assertOwner();
    assert.equal(second.signal.aborted, false);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  } finally {
    setRunLeaseTestHooksForTests();
    await second?.release();
    await first?.release();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a validated failed-release abandonment stays latched across reclaim rename", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "piwf-abandoned-reclaim-"));
  let first, second;
  try {
    first = await acquireWorkflowTopologyLease(cwd);
    setRunLeaseTestHooksForTests({
      onBeforeReleaseLockRename() { throw new Error("persistent release failure"); },
    });
    await assert.rejects(first.release(), /persistent release failure/);
    let reclaimed = false;
    setRunLeaseTestHooksForTests({
      async onAfterReclaimRename({ lockFile }) {
        reclaimed = true;
        await unlink(`${lockFile}.abandoned-${first.ownerId}`);
      },
      onBeforeRestoreReclaimFile() { assert.fail("must not restore the abandoned live-PID generation"); },
    });
    second = await acquireWorkflowTopologyLease(cwd, 0);
    assert.ok(second);
    assert.equal(reclaimed, true);
    await second.assertOwner();
    assert.equal(second.signal.aborted, false);
  } finally {
    setRunLeaseTestHooksForTests();
    await second?.release();
    await first?.release();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("held lock, owner mismatch, and invalid abandonment never authorize protected writes or reclaim", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "piwf-handoff-negatives-"));
  let lease;
  try {
    lease = await acquireWorkflowTopologyLease(cwd);
    const root = workflowsRoot(cwd);
    const lock = join(root, "retention.lock");
    const marker = `${lock}.abandoned-${lease.ownerId}`;
    await writeFile(marker, "wrong-owner\n");
    assert.equal(await acquireWorkflowTopologyLease(cwd, 0), undefined);
    await lease.assertOwner();
    await writeFile(lock, `replacement-owner\n${process.pid}\n${new Date().toISOString()}\n`);
    await assert.rejects(lease.assertOwner(), /Lost supervisor lease/);
    const file = join(root, "must-not-commit.json");
    await assert.rejects(writeJsonAtomic(file, {}, lease.signal, lease.assertOwner), /Lost supervisor lease/);
    await assert.rejects(readFile(file), { code: "ENOENT" });
    await lease.release();
    assert.match(await readFile(lock, "utf8"), /^replacement-owner\n/);
    assert.equal(await acquireWorkflowTopologyLease(cwd, 0), undefined);
    assert.equal((await readdir(root)).some(name => name.endsWith(".tmp")), false);
  } finally {
    setRunLeaseTestHooksForTests();
    await lease?.release();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("release and abandonment IO failures remain visible and do not authorize reclaim", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "piwf-abandon-failure-"));
  let lease;
  try {
    lease = await acquireWorkflowTopologyLease(cwd);
    const lock = join(workflowsRoot(cwd), "retention.lock");
    // A real filesystem error publishing the marker, independent of UID/chmod.
    await mkdir(`${lock}.abandoned-${lease.ownerId}`);
    setRunLeaseTestHooksForTests({
      onBeforeReleaseLockRename() {
        throw Object.assign(new Error("release permission failure"), { code: "EPERM" });
      },
    });
    await assert.rejects(lease.release(), error => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /Failed to release and durably abandon/);
      assert.equal(error.errors[0].code, "EPERM");
      assert.ok(["EISDIR", "EACCES", "EPERM"].includes(error.errors[1].code));
      return true;
    });
    await assert.rejects(acquireWorkflowTopologyLease(cwd, 0), error =>
      ["EISDIR", "EACCES", "EPERM"].includes(error.code));
    assert.match(await readFile(lock, "utf8"), new RegExp(`^${lease.ownerId}\\n`));
  } finally {
    setRunLeaseTestHooksForTests();
    await lease?.release();
    await rm(cwd, { recursive: true, force: true });
  }
});
