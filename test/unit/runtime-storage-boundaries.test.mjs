import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { setRunLeaseTestHooksForTests, withRunLease, writeJsonAtomic, writeJsonExclusive } from '../../.tmp/unit/store.js';
import { awaitSubagentOperation } from '../../.tmp/unit/subagent-backend.js';
import { pruneWorkflowRuns, setWorkflowPruneBeforeDeleteForTests, setWorkflowPruneAfterQuarantineForTests } from '../../.tmp/unit/run-retention.js';

async function fixture(fn) {
 const cwd = await mkdtemp(join(tmpdir(), 'piwf-runtime-boundary-'));
 try { await fn(cwd); } finally { setWorkflowPruneAfterQuarantineForTests(); setWorkflowPruneBeforeDeleteForTests(); setRunLeaseTestHooksForTests(); await rm(cwd, { recursive: true, force: true }); }
}
async function runFixture(cwd, status = 'failed') {
 const dir = join(cwd, '.pi', 'workflows', 'workflow-fixture');
 const run = { schemaVersion: 1, runId: 'workflow-fixture', updatedAt: '2020-01-01T00:00:00Z', tasks: [{ taskId: 'task-1', specId: 'one', status }] };
 await mkdir(dir, { recursive: true });
 await writeFile(join(dir, 'run.json'), JSON.stringify(run));
 return { dir, run };
}
test('two Node processes serialize updates under the supervisor lease and publish whole JSON', async () => fixture(async cwd => {
 const { dir } = await runFixture(cwd);
 const counter = join(dir, 'counter.json');
 await writeJsonAtomic(counter, { count: 0, payload: 'x'.repeat(65536) });
 const moduleUrl = new URL('../../.tmp/unit/store.js', import.meta.url).href;
 const code = `import {withRunLease,writeJsonAtomic} from ${JSON.stringify(moduleUrl)};
 import {readFile} from 'node:fs/promises';
 const cwd=process.argv[1],counter=process.argv[2];
 for(let i=0;i<12;){
  const result=await withRunLease(cwd,'workflow-fixture',async()=>{
   const value=JSON.parse(await readFile(counter,'utf8'));
   await new Promise(r=>setTimeout(r,2));
   await writeJsonAtomic(counter,{...value,count:value.count+1}); return true;
  });
  if(result) i++; else await new Promise(r=>setTimeout(r,2));
 }`;
 function worker() {
  return new Promise((resolve, reject) => {
   const child = spawn(process.execPath, ['--input-type=module', '-e', code, cwd, counter], { stdio: ['ignore','pipe','pipe'] });
   let error = ''; child.stderr.on('data', bytes => error += bytes);
   child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(error || `exit ${code}`)));
  });
 }
 let done = false, reads = 0;
 const workers = Promise.all([worker(), worker()]).finally(() => { done = true; });
 while (!done) {
  const value = JSON.parse(await readFile(counter, 'utf8'));
  assert.equal(value.payload.length, 65536); reads++;
  await new Promise(resolve => setTimeout(resolve, 1));
 }
 await workers;
 assert.equal(JSON.parse(await readFile(counter, 'utf8')).count, 24);
 assert.ok(reads > 0);
}));
test('cancelled queued backend operation never starts its local effect', async () => fixture(async cwd => {
 const abort = new AbortController();
 let started = false;
 const pending = awaitSubagentOperation(async () => {
  started = true;
  await writeFile(join(cwd, 'late-effect'), 'must not execute');
 }, { operation: 'local effect', context: 'disposable fixture', timeoutMs: 100, signal: abort.signal });
 abort.abort(new Error('cancelled while queued'));
 await assert.rejects(pending, /cancelled while queued/);
 await new Promise(resolve => setTimeout(resolve, 20));
 assert.equal(started, false);
 assert.deepEqual(await readdir(cwd), []);
}));
test('atomic JSON rejection cleans its unpublished temporary file and preserves prior bytes', async () => fixture(async cwd => {
 const file = join(cwd, 'record.json');
 await writeJsonAtomic(file, { old: true });
 await assert.rejects(writeJsonAtomic(file, { newer: true }, undefined, () => { throw new Error('fence lost'); }), /fence lost/);
 assert.deepEqual(JSON.parse(await readFile(file)), { old: true });
 assert.deepEqual(await readdir(cwd), ['record.json']);
}));
test('exclusive JSON commit rechecks cancellation after asynchronous precommit work', async () => fixture(async cwd => {
 const abort = new AbortController();
 setRunLeaseTestHooksForTests({ onBeforeExclusiveLink: () => abort.abort(new Error('cancelled before commit')) });
 await assert.rejects(writeJsonExclusive(join(cwd, 'receipt.json'), { value: 1 }, abort.signal), /cancelled before commit/);
 assert.deepEqual(await readdir(cwd), []);
}));
test('supervisor heartbeat cannot publish after losing the owner at the atomic commit fence', async () => fixture(async cwd => {
 const { dir } = await runFixture(cwd);
 let fired = false;
 setRunLeaseTestHooksForTests({ onBeforeAtomicRename: async ({ file }) => {
  if (file !== join(dir, 'supervisor.json') || fired) return;
  fired = true;
  await writeFile(join(dir, 'supervisor.lock'), `replacement-owner\n${process.pid}\n${new Date().toISOString()}\n`);
  await writeFile(file, JSON.stringify({ ownerId: 'replacement-owner' }));
 } });
 await assert.rejects(withRunLease(cwd, 'workflow-fixture', async () => 'never'), /Lost supervisor lease/);
 assert.equal(JSON.parse(await readFile(join(dir, 'supervisor.json'))).ownerId, 'replacement-owner');
}));
for (const component of ['.pi', 'workflows', 'workflow-subagents']) {
 test(`prune does not traverse a symlinked ${component} retention ancestor`, async () => fixture(async cwd => {
  const outside = join(cwd, 'disposable-outside');
  await mkdir(outside);
  const { dir } = await runFixture(cwd);
  if (component === 'workflow-subagents') {
   await mkdir(join(outside, 'workflow-fixture'));
   await writeFile(join(outside, 'workflow-fixture', 'marker'), 'preserve');
   await symlink(outside, join(cwd, '.pi', component));
  } else {
   const source = component === '.pi' ? join(cwd, '.pi') : join(cwd, '.pi', component);
   const { rename } = await import('node:fs/promises');
   await rm(outside, { recursive: true });
   await rename(source, outside);
   await symlink(outside, source);
  }
  const summary = await pruneWorkflowRuns(cwd, { keep: 0, yes: true });
  if (component === 'workflow-subagents') assert.equal(await readFile(join(outside, 'workflow-fixture', 'marker'), 'utf8'), 'preserve');
  else { assert.equal(summary.runs.some(run => run.deleted), false); await readFile(join(dir, 'run.json')); }
 }));
}
test('prune revalidates a run resumed after its terminal selection', async () => fixture(async cwd => {
 const { dir, run } = await runFixture(cwd);
 setWorkflowPruneBeforeDeleteForTests(async () => {
  await withRunLease(cwd, run.runId, async () => {
   run.tasks[0].status = 'running';
   await writeJsonAtomic(join(dir, 'run.json'), run);
  });
 });
 const summary = await pruneWorkflowRuns(cwd, { keep: 0, yes: true });
 assert.equal(summary.runs[0].deleted, false);
 assert.equal(summary.runs[0].protected, true);
 assert.equal(JSON.parse(await readFile(join(dir, 'run.json'))).tasks[0].status, 'running');
}));
test('prune holds the scheduler lock at deletion-time revalidation', async () => fixture(async cwd => {
 const { dir, run } = await runFixture(cwd);
 let attempted = false;
 setRunLeaseTestHooksForTests({ onBeforeHeartbeat: async ({ name }) => {
  if (name !== 'supervisor') return;
  attempted = true;
  assert.equal(await withRunLease(cwd, run.runId, async () => 'must not acquire'), undefined);
 } });
 const summary = await pruneWorkflowRuns(cwd, { keep: 0, yes: true });
 assert.equal(attempted, true);
 assert.equal(summary.runs[0].deleted, true);
 await assert.rejects(readFile(join(dir, 'run.json')), { code: 'ENOENT' });
}));
test('recursive prune cannot delete a new generation reusing the detached run name', async () => fixture(async cwd => {
 const { dir, run } = await runFixture(cwd);
 const mirror = join(cwd, '.pi', 'workflow-subagents', run.runId);
 await mkdir(mirror, { recursive: true });
 await writeFile(join(mirror, 'old'), 'old generation');
 setWorkflowPruneAfterQuarantineForTests(async () => {
  await withRunLease(cwd, run.runId, async () => {
   await writeJsonAtomic(join(dir, 'run.json'), { ...run, tasks: [{ taskId: 'task-1', specId: 'one', status: 'running' }] });
   await writeFile(join(dir, 'new'), 'new generation');
   await mkdir(mirror, { recursive: true });
   await writeFile(join(mirror, 'new'), 'new mirror');
  });
 });
 const summary = await pruneWorkflowRuns(cwd, { keep: 0, yes: true });
 assert.equal(summary.runs[0].deleted, true);
 assert.equal(await readFile(join(dir, 'new'), 'utf8'), 'new generation');
 assert.equal(await readFile(join(mirror, 'new'), 'utf8'), 'new mirror');
 assert.equal((await readdir(join(cwd, '.pi', 'workflows'))).some(name => name.startsWith('.prune-')), false);
}));
test('prune protects malformed task statuses instead of deriving interrupted and deleting', async () => fixture(async cwd => {
 const { dir } = await runFixture(cwd, 'unrecognized');
 const summary = await pruneWorkflowRuns(cwd, { keep: 0, yes: true });
 assert.equal(summary.runs.some(run => run.deleted), false);
 await readFile(join(dir, 'run.json'));
}));
