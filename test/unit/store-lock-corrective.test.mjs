import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  setRunLeaseTestHooksForTests,
  updateIndex,
  withRunLease,
} from "../../.tmp/unit/store.js";

test("supervisor lock release preserves outcomes and abandons persistent failures", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "piwf-supervisor-lock-"));
  const runId = "workflow_supervisor_lock_corrective";
  try {
    let releaseAttempts = 0;
    setRunLeaseTestHooksForTests({
      onBeforeReleaseLockRename({ lockFile }) {
        if (!lockFile.endsWith("supervisor.lock")) return;
        releaseAttempts += 1;
        throw new Error("persistent supervisor release failure");
      },
    });

    assert.equal(
      await withRunLease(cwd, runId, async () => "caller-result"),
      "caller-result",
    );
    assert.equal(releaseAttempts, 3);

    // The abandonment marker makes the live-PID lock immediately reclaimable.
    setRunLeaseTestHooksForTests(undefined);
    assert.equal(
      await withRunLease(cwd, runId, async () => "replacement-owner"),
      "replacement-owner",
    );

    releaseAttempts = 0;
    setRunLeaseTestHooksForTests({
      onBeforeReleaseLockRename({ lockFile }) {
        if (!lockFile.endsWith("supervisor.lock")) return;
        releaseAttempts += 1;
        throw new Error("persistent supervisor release failure");
      },
    });
    await assert.rejects(
      () => withRunLease(cwd, runId, async () => {
        throw new Error("caller failure");
      }),
      /caller failure/,
    );
    assert.equal(releaseAttempts, 3);
  } finally {
    setRunLeaseTestHooksForTests(undefined);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("index lock release preserves outcomes and abandons persistent failures", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "piwf-index-lock-"));
  try {
    let releaseAttempts = 0;
    setRunLeaseTestHooksForTests({
      onBeforeReleaseLockRename({ lockFile }) {
        if (!lockFile.endsWith("index.lock")) return;
        releaseAttempts += 1;
        throw new Error("persistent index release failure");
      },
    });

    const index = await updateIndex(cwd);
    assert.equal(index.schemaVersion, 1);
    assert.equal(releaseAttempts, 3);

    setRunLeaseTestHooksForTests(undefined);
    const replacement = await updateIndex(cwd);
    assert.equal(replacement.schemaVersion, 1);

    releaseAttempts = 0;
    setRunLeaseTestHooksForTests({
      onBeforeAtomicRename({ file }) {
        if (file.endsWith("index.json"))
          throw new Error("caller index failure");
      },
      onBeforeReleaseLockRename({ lockFile }) {
        if (!lockFile.endsWith("index.lock")) return;
        releaseAttempts += 1;
        throw new Error("persistent index release failure");
      },
    });
    await assert.rejects(() => updateIndex(cwd), /caller index failure/);
    assert.equal(releaseAttempts, 3);

    setRunLeaseTestHooksForTests(undefined);
    const secondReplacement = await updateIndex(cwd);
    assert.equal(secondReplacement.schemaVersion, 1);
  } finally {
    setRunLeaseTestHooksForTests(undefined);
    await rm(cwd, { recursive: true, force: true });
  }
});
