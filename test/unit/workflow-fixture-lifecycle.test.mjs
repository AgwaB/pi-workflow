import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as h from './unit-test-support.mjs';
import { drainWorkflowFixture, withWorkflowFixtureLease } from './workflow-fixture-lifecycle.mjs';

async function completedFixture() {
    const cwd = await mkdtemp(join(tmpdir(), 'piwf-fixture-drain-'));
    h.writeAgent(cwd, 'unit-scout', 'read');
    const spec = h.artifactGraphWorkflowSpec({ artifactGraph: { stages: [{ id: 'adaptive', type: 'dynamic', dynamic: { uses: './controller.mjs', budget: { maxNestedWorkflowDepth: 1 } } }] } });
    const specPath = join(cwd, 'spec.json');
    await writeFile(join(cwd, 'controller.mjs'), 'export default ()=>({control:{digest:"done"}})');
    await writeFile(specPath, JSON.stringify(spec));
    const compiled = await h.compileWorkflow(spec, { cwd, task: 'fixture cleanup', specPath });
    const { run } = await h.createWorkflowRunRecord(cwd, compiled, specPath);
    await h.writeStaticRunArtifacts(cwd, run, compiled, spec);
    for (const task of run.tasks) task.status = 'completed';
    await h.writeRunRecord(cwd, run);
    return { cwd, runId: run.runId };
}

test('fixture lease waits for ownership instead of silently skipping a manual mutation', { timeout: 10000 }, async () => {
    const { cwd, runId } = await completedFixture();
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const released = new Promise(resolve => { release = resolve; });
    const holder = h.withRunLease(cwd, runId, async () => { enter(); await released; });
    let mutations = 0;
    try {
        await entered;
        const skipped = await h.withRunLease(cwd, runId, async () => { mutations++; });
        assert.equal(skipped, undefined);
        assert.equal(mutations, 0, 'the original one-shot call can silently skip its write');
        const mutation = withWorkflowFixtureLease(cwd, runId, async () => { mutations++; return 'written'; });
        release();
        await holder;
        assert.equal(await mutation, 'written');
        assert.equal(mutations, 1);
    } finally {
        release(); await holder;
        await h.flushPendingIndexUpdatesForTests();
        await rm(cwd, { recursive: true, force: true });
    }
});

for (const guarded of [false, true]) {
    test(`fixture ${guarded ? 'drain preserves' : 'early deletion rejects'} a terminal run's still-owned writer`, { timeout: 10000 }, async () => {
        const { cwd, runId } = await completedFixture();
        let enter, release;
        const entered = new Promise(resolve => { enter = resolve; });
        const released = new Promise(resolve => { release = resolve; });
        const order = [];
        const holder = h.withRunLease(cwd, runId, async () => {
            enter();
            await released;
            await writeFile(join(cwd, 'owned-write'), 'settled');
            order.push('writer');
        });
        // Observe rejections immediately, including the deliberate baseline miss.
        void holder.catch(() => {});
        try {
            await entered;
            if (!guarded) {
                await rm(cwd, { recursive: true, force: true });
                release();
                await assert.rejects(holder, { code: 'ENOENT' });
            } else {
                const draining = drainWorkflowFixture(cwd, runId);
                setImmediate(release);
                await draining;
                order.push('cleanup');
                await holder;
                await access(join(cwd, 'owned-write'));
                assert.deepEqual(order, ['writer', 'cleanup']);
            }
        } finally {
            release();
            await holder.catch(() => {});
            await h.flushPendingIndexUpdatesForTests();
            await rm(cwd, { recursive: true, force: true });
        }
    });
}
