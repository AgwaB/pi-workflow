import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import * as h from './unit-test-support.mjs';
import { dynamicStatePath, rebuildDynamicState, readOrRebuildDynamicState } from '../../.tmp/unit/dynamic-state.js';
import { dynamicEventsPath } from '../../.tmp/unit/dynamic-events.js';
const spec = (depth, workflows = {}, budget = {}, helpers = {}) => h.artifactGraphWorkflowSpec({ artifactGraph: { stages: [{ id: 'adaptive', type: 'dynamic', dynamic: { uses: './controller.mjs', budget: { maxNestedWorkflowDepth: depth, ...budget }, workflows, helpers } }] } });
const childRef = { child: { uses: './child/spec.json' } };
const leaf = `export default ctx => ({control:{digest:'leaf',remaining:ctx.budget.remaining(),check:ctx.budget.check()}})`;
const callChild = `export default async ctx => {const child=await ctx.workflow('child','child');return {control:{digest:'done',child,remaining:ctx.budget.remaining()}}}`;
async function fixture(files, options = {}) {
    const cwd = await mkdtemp(join(tmpdir(), 'piwf-true-depth-'));
    h.writeAgent(cwd, 'unit-scout', 'read');
    // No provider or fake provider execution is allowed in these fixtures.
    h.setSubagentApiForTests({ async runSubagent() { throw new Error('unexpected provider agent'); } });
    for (const [name, value] of Object.entries(files)) {
        await mkdir(dirname(join(cwd, name)), { recursive: true });
        await writeFile(join(cwd, name), typeof value === 'string' ? value.replaceAll('RESTART_MARKER', join(cwd, 'RESTART_MARKER')) : JSON.stringify(value));
    }
    const specPath = join(cwd, 'spec.json');
    const compiled = await h.compileWorkflow(files['spec.json'], { cwd, task: 'Local depth behavior', specPath });
    const { run } = await h.createWorkflowRunRecord(cwd, compiled, specPath, options);
    await h.writeStaticRunArtifacts(cwd, run, compiled, files['spec.json']);
    await h.writeRunRecord(cwd, run);
    return { cwd, run, async close() { h.setSubagentApiForTests(undefined); await rm(cwd, { recursive: true, force: true }); } };
}
async function controller(cwd, runId) { return h.taskBySpec(await h.readRunRecord(cwd, runId), 'adaptive.controller'); }
async function control(cwd, runId) { const task = await controller(cwd, runId); return JSON.parse(await readFile(join(dirname(join(cwd, task.files.result)), 'control.json'), 'utf8')); }
async function children(cwd, runId) { return [...new Set((await h.readDynamicEvents(cwd, runId)).filter(e => e.type === 'workflow.started').map(e => e.payload.runId))]; }
async function depth(cwd, runId) { return (await readOrRebuildDynamicState(cwd, runId)).controllers['adaptive.controller'].counters.nestedWorkflowDepth; }
// All controller runs use the real local scheduler, bundle snapshots and worker threads.
test('depth one permits sequential siblings without consuming remaining headroom or check', async () => {
    const f = await fixture({ 'spec.json': spec(1, childRef), 'controller.mjs': `export default async ctx=>{const before=ctx.budget.remaining();await ctx.workflow('child','one');const after=ctx.budget.remaining();const check=ctx.budget.check();await ctx.workflow('child','two');return {control:{digest:'siblings',before,after,check,final:ctx.budget.remaining()}}}`, 'child/spec.json': spec(8), 'child/controller.mjs': leaf });
    try {
        await h.scheduleRun(f.cwd, f.run.runId);
        assert.equal((await controller(f.cwd, f.run.runId)).status, 'completed');
        const c = await control(f.cwd, f.run.runId);
        assert.equal(c.before.maxNestedWorkflowDepth, 1);
        assert.equal(c.after.maxNestedWorkflowDepth, 1);
        assert.equal(c.final.maxNestedWorkflowDepth, 1);
        assert.equal(c.check, true);
        assert.equal((await children(f.cwd, f.run.runId)).length, 2);
        assert.equal(await depth(f.cwd, f.run.runId), 1);
        const cached = await readOrRebuildDynamicState(f.cwd, f.run.runId);
        cached.controllers['adaptive.controller'].counters.nestedWorkflowDepth = 999;
        await writeFile(dynamicStatePath(f.cwd, f.run.runId), JSON.stringify(cached));
        assert.equal(await depth(f.cwd, f.run.runId), 1, 'legacy cumulative cache is not retained');
        for (const id of await children(f.cwd, f.run.runId)) {
            const c = await control(f.cwd, id);
            assert.equal(c.remaining.maxNestedWorkflowDepth, 0);
            assert.equal(c.check, false);
        }
    }
    finally {
        await f.close();
    }
});
test('root depth one forbids a grandchild even when child configuration requests larger depth', async () => {
    const f = await fixture({ 'spec.json': spec(1, childRef), 'controller.mjs': callChild, 'child/spec.json': spec(8, childRef), 'child/controller.mjs': callChild, 'child/child/spec.json': spec(8), 'child/child/controller.mjs': leaf });
    try {
        await h.scheduleRun(f.cwd, f.run.runId);
        const [child] = await children(f.cwd, f.run.runId);
        assert.equal((await controller(f.cwd, child)).statusDetail, 'dynamic_budget_blocked');
        assert.deepEqual(await children(f.cwd, child), []);
        assert.notEqual((await controller(f.cwd, f.run.runId)).status, 'completed');
    }
    finally {
        await f.close();
    }
});
test('each ancestor relative allowance permits grandchild but forbids great-grandchild', async () => {
    for (const rootDepth of [2, 8]) {
        const f = await fixture({ 'spec.json': spec(rootDepth, childRef), 'controller.mjs': callChild, 'child/spec.json': spec(1, childRef), 'child/controller.mjs': callChild, 'child/child/spec.json': spec(8, childRef), 'child/child/controller.mjs': callChild, 'child/child/child/spec.json': spec(8), 'child/child/child/controller.mjs': leaf });
        try {
            await h.scheduleRun(f.cwd, f.run.runId);
            const [child] = await children(f.cwd, f.run.runId);
            const [grandchild] = await children(f.cwd, child);
            assert.ok(grandchild, 'grandchild was actually launched');
            assert.equal((await controller(f.cwd, grandchild)).statusDetail, 'dynamic_budget_blocked');
            assert.deepEqual(await children(f.cwd, grandchild), []);
            assert.equal(await depth(f.cwd, f.run.runId), 2);
            assert.equal(await depth(f.cwd, child), 1);
        }
        finally {
            await f.close();
        }
    }
});
test('completed sibling replay and disk restart preserve inherited allowance, not a cumulative child cap', async () => {
    const f = await fixture({ 'spec.json': spec(2, childRef), 'controller.mjs': callChild, 'child/spec.json': spec(1, childRef), 'child/controller.mjs': `import {existsSync} from 'node:fs';export default async ctx=>{await ctx.workflow('child','one');if(!existsSync(${JSON.stringify('RESTART_MARKER')}))throw Error('restart fixture');await ctx.workflow('child','two');return {control:{digest:'restarted',remaining:ctx.budget.remaining()}}}`, 'child/child/spec.json': spec(8), 'child/child/controller.mjs': leaf });
    try {
        // The fixture substitutes an absolute project-local marker path.
        await h.scheduleRun(f.cwd, f.run.runId);
        const [child] = await children(f.cwd, f.run.runId);
        assert.equal((await children(f.cwd, child)).length, 1);
        const childRun = await h.readRunRecord(f.cwd, child);
        const task = h.taskBySpec(childRun, 'adaptive.controller');
        h.resetTaskForResume(task);
        await h.writeRunRecord(f.cwd, childRun);
        await writeFile(join(f.cwd, 'RESTART_MARKER'), 'ready');
        await rm(dynamicStatePath(f.cwd, child), { force: true });
        const script = `import {scheduleRun} from ${JSON.stringify(new URL('../../.tmp/unit/engine.js', import.meta.url).href)};await scheduleRun(${JSON.stringify(f.cwd)},${JSON.stringify(child)});`;
        const restarted = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: f.cwd, encoding: 'utf8', env: process.env });
        assert.equal(restarted.status, 0, restarted.stderr);
        assert.equal((await controller(f.cwd, child)).status, 'completed');
        assert.equal((await children(f.cwd, child)).length, 2);
        assert.equal((await control(f.cwd, child)).remaining.maxNestedWorkflowDepth, 1);
        for (const id of await children(f.cwd, child))
            assert.equal((await control(f.cwd, id)).remaining.maxNestedWorkflowDepth, 0);
        assert.equal((await rebuildDynamicState(f.cwd, child)).controllers['adaptive.controller'].counters.nestedWorkflowDepth, 1);
    }
    finally {
        await f.close();
    }
});
test('failed child does not consume sibling depth and helper budget still blocks', async () => {
    const f = await fixture({ 'spec.json': spec(1, childRef, { maxHelperRuns: 1 }, { local: { uses: './helper.mjs', idempotent: true } }), 'controller.mjs': `export default async ctx=>{for(const name of ['one','two']){try{await ctx.workflow('child',name)}catch{}}await ctx.helper('local',{});await ctx.helper('local',{});return {control:{digest:'must not complete'}}}`, 'helper.mjs': `export default ()=>({ok:true})`, 'child/spec.json': spec(8), 'child/controller.mjs': `export default ()=>{throw Error('local child error')}` });
    try {
        await h.scheduleRun(f.cwd, f.run.runId);
        assert.equal((await children(f.cwd, f.run.runId)).length, 2);
        const task = await controller(f.cwd, f.run.runId);
        assert.equal(task.statusDetail, 'dynamic_budget_blocked');
        assert.match(task.lastMessage, /maxHelperRuns=1/);
        const state = await readOrRebuildDynamicState(f.cwd, f.run.runId);
        assert.equal(state.controllers['adaptive.controller'].counters.helperRuns, 1);
        assert.equal(await depth(f.cwd, f.run.runId), 1);
    }
    finally {
        await f.close();
    }
});
test('legacy missing parent registration must not silently grant child configuration depth', async () => {
    const f = await fixture({ 'spec.json': spec(1, childRef), 'controller.mjs': callChild, 'child/spec.json': spec(8, childRef), 'child/controller.mjs': callChild, 'child/child/spec.json': spec(8), 'child/child/controller.mjs': leaf });
    try {
        await h.scheduleRun(f.cwd, f.run.runId);
        const [child] = await children(f.cwd, f.run.runId);
        // Explicit legacy/incomplete-ledger fault injection, not a normal writer output.
        await rm(dynamicEventsPath(f.cwd, f.run.runId));
        await rm(dynamicStatePath(f.cwd, child), { force: true });
        const run = await h.readRunRecord(f.cwd, child);
        h.resetTaskForResume(h.taskBySpec(run, 'adaptive.controller'));
        await h.writeRunRecord(f.cwd, run);
        await h.scheduleRun(f.cwd, child);
        assert.notEqual((await controller(f.cwd, child)).status, 'completed');
    }
    finally {
        await f.close();
    }
});
test('cancellation stops local nested controllers without authorizing another sibling', async () => {
    const f = await fixture({ 'spec.json': spec(1, childRef), 'controller.mjs': `export default async ctx=>{await ctx.workflow('child','one');await ctx.workflow('child','two');return {control:{digest:'must not complete'}}}`, 'child/spec.json': spec(8), 'child/controller.mjs': `import {writeFile} from 'node:fs/promises';export default async()=>{await writeFile('RESTART_MARKER','started');await new Promise(r=>setTimeout(r,2000));await writeFile('RESTART_MARKER.late','must not happen');return {control:{digest:'late'}}}` });
    let running;
    try {
        running = h.scheduleRun(f.cwd, f.run.runId);
        const deadline = Date.now() + 5000;
        while (true) {
            try {
                await access(join(f.cwd, 'RESTART_MARKER'));
                break;
            }
            catch {
                assert.ok(Date.now() < deadline, 'child must start');
                await new Promise(r => setTimeout(r, 10));
            }
        }
        await h.stopRun(f.cwd, f.run.runId);
        await running;
        const [child] = await children(f.cwd, f.run.runId);
        assert.equal((await children(f.cwd, f.run.runId)).length, 1);
        assert.equal((await controller(f.cwd, f.run.runId)).status, 'interrupted');
        assert.equal((await controller(f.cwd, child)).status, 'interrupted');
        assert.equal(await depth(f.cwd, f.run.runId), 1);
        await new Promise(r => setTimeout(r, 2100));
        await assert.rejects(access(join(f.cwd, 'RESTART_MARKER.late')), { code: 'ENOENT' });
    }
    finally {
        await running?.catch(() => { });
        await f.close();
    }
});
test('runtime deadline still bounds a controller after successful sibling workflows', async () => {
    const f = await fixture({ 'spec.json': spec(1, childRef, { maxRuntimeMs: 600 }), 'controller.mjs': `export default async ctx=>{await ctx.workflow('child','one');await ctx.workflow('child','two');await new Promise(r=>setTimeout(r,1200));return {control:{digest:'must not complete'}}}`, 'child/spec.json': spec(8), 'child/controller.mjs': leaf });
    try {
        await h.scheduleRun(f.cwd, f.run.runId);
        assert.equal((await children(f.cwd, f.run.runId)).length, 2);
        const task = await controller(f.cwd, f.run.runId);
        assert.equal(task.statusDetail, 'dynamic_budget_blocked');
        assert.match(task.lastMessage, /maxRuntimeMs=600/);
        assert.equal(await depth(f.cwd, f.run.runId), 1);
    }
    finally {
        await f.close();
    }
});
