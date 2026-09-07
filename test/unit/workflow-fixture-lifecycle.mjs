import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { stopRun } from '../../.tmp/unit/engine.js';
import { flushPendingIndexUpdatesForTests, isTerminalWorkflowStatus, readRunRecord, withRunLease } from '../../.tmp/unit/store.js';

export async function withWorkflowFixtureLease(cwd, runId, action) {
    const deadline = performance.now() + 5000;
    for (;;) {
        const result = await withRunLease(cwd, runId, async signal => ({ value: await action(signal) }));
        if (result) return result.value;
        assert.ok(performance.now() < deadline, `fixture scheduler lease did not drain: ${runId}`);
        await sleep(10);
    }
}

// Call before resetting fake backends or deleting a fixture, including failure paths.
export async function drainWorkflowFixture(cwd, runId) {
    const run = await readRunRecord(cwd, runId);
    if (!isTerminalWorkflowStatus(run.status)) await stopRun(cwd, runId);
    // Terminal task status can be persisted before the scheduling lease unwinds.
    await withWorkflowFixtureLease(cwd, runId, async () => {});
    await flushPendingIndexUpdatesForTests();
}
