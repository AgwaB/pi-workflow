import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { pruneWorkflowRuns, setWorkflowPruneAfterQuarantineForTests, setWorkflowPruneBeforeDeleteForTests, setWorkflowPruneBeforePrimaryDetachForTests } from '../../.tmp/unit/run-retention.js';
import { readIndex, updateIndex, withRunLease, writeRunRecord, acquireWorkflowTopologyLease, setRunLeaseTestHooksForTests } from '../../.tmp/unit/store.js';
import { remainingDynamicNestedWorkflowDepth } from '../../.tmp/unit/dynamic-nested-depth.js';
import { projectDynamicState, readOrRebuildDynamicState, recordDynamicEventAndUpdateState } from '../../.tmp/unit/dynamic-state.js';
const parent = 'workflow_parent', child = 'workflow_child', controller = 'adaptive.controller';
const timestamp = '2026-01-01T00:00:00.000Z';
const event = (seq, type, payload, extra = {}) => ({schema:'pi-workflow-dynamic-event-v1',runId:parent,controllerSpecId:controller,seq,type,payload,opId:`op-${seq}`,requestHash:`hash-${seq}`,timestamp,...extra});
const init = event(1, 'controller.initialized', {budget:{maxNestedWorkflowDepth:2}});
const start = event(2, 'workflow.started', {runId:child,workflowId:'child',uses:'./child/spec.json',status:'starting'});
async function fixture() { return mkdtemp(join(tmpdir(), 'piwf-review-fixes-')); }
async function run(cwd, id, status = 'completed', extra = {}) {
 const dir = join(cwd,'.pi','workflows',id); await mkdir(join(dir,'dynamic'),{recursive:true});
 const record = {schemaVersion:1,runId:id,createdAt:timestamp,updatedAt:timestamp,tasks:[{taskId:`${id}-task`,specId:controller,status}],...extra};
 await writeFile(join(dir,'run.json'),JSON.stringify(record)); return {dir,record};
}
async function ledger(dir, events) { await writeFile(join(dir,'dynamic','events.jsonl'),events.map(JSON.stringify).join('\n')+'\n'); }
const exists = path => stat(path).then(()=>true,()=>false);
for (const status of ['running','failed','interrupted','completed']) test(`RR-01 retained ${status} child preserves ancestry`, async()=>{
 const cwd=await fixture(); let release; let held;
 try {
  const p=await run(cwd,parent); await run(cwd,child,status,{parentRunId:parent,rootRunId:parent,updatedAt:'2026-01-02T00:00:00.000Z'}); await ledger(p.dir,[init,start]);
  if(status==='running') { let ready; const acquired=new Promise(r=>ready=r); held=withRunLease(cwd,child,async()=>{ready();await new Promise(r=>release=r);}); await acquired; }
  assert.equal(await remainingDynamicNestedWorkflowDepth(cwd,child,8),1);
  const result=await pruneWorkflowRuns(cwd,{keep:status==='running'?0:1,yes:true});
  assert.equal(result.runs.find(r=>r.runId===parent).protected,true);
  assert.equal(await exists(p.dir),true); assert.equal(await remainingDynamicNestedWorkflowDepth(cwd,child,8),1);
 } finally { release?.(); await held; await rm(cwd,{recursive:true,force:true}); }
});
test('RR-01 selected child purges before newer parent; dry run has no writes',async()=>{
 const cwd=await fixture(); try {
  await run(cwd,parent,'completed',{updatedAt:'2026-01-03T00:00:00.000Z'}); await run(cwd,child,'failed',{parentRunId:parent});
  const before=await readdir(join(cwd,'.pi','workflows')); const dry=await pruneWorkflowRuns(cwd,{keep:0});
  assert.equal(dry.indexUpdated,false); assert.deepEqual(await readdir(join(cwd,'.pi','workflows')),before);
  const result=await pruneWorkflowRuns(cwd,{keep:0,yes:true}); assert.deepEqual(result.runs.map(r=>r.runId),[child,parent]); assert.ok(result.runs.every(r=>r.deleted));
 } finally { await rm(cwd,{recursive:true,force:true}); }
});
test('RR-01 malformed child references conservatively protect ancestors',async()=>{
 const cwd=await fixture(); try { await run(cwd,parent); const c=await run(cwd,child,'failed',{parentRunId:parent}); await writeFile(join(c.dir,'run.json'),'{bad'); const result=await pruneWorkflowRuns(cwd,{keep:0,yes:true}); assert.equal(result.runs[0].protected,true); } finally {await rm(cwd,{recursive:true,force:true});}
});
test('RR-02 post-detach failure reports recovery paths, repairs index and frees no retained bytes',async()=>{
 const cwd=await fixture(); try {
  await run(cwd,parent); const mirror=join(cwd,'.pi','workflow-subagents',parent); await mkdir(mirror,{recursive:true}); await writeFile(join(mirror,'evidence'),'recover me'); await updateIndex(cwd);
  setWorkflowPruneAfterQuarantineForTests(()=>{throw Error('purge fault');});
  const result=await pruneWorkflowRuns(cwd,{keep:0,yes:true}); const entry=result.runs[0];
  assert.equal(entry.detached,true); assert.equal(entry.purged,false); assert.equal(entry.deleted,false); assert.equal(result.deletedBytes,0); assert.equal(result.indexUpdated,true); assert.ok(result.error);
  assert.deepEqual((await readIndex(cwd)).runs,[]); assert.equal(JSON.parse(await readFile(join(entry.retainedEvidencePath,'run.json'),'utf8')).runId,parent); assert.equal(await readFile(join(entry.retainedMirrorPath,'evidence'),'utf8'),'recover me');
 } finally {setWorkflowPruneAfterQuarantineForTests();await rm(cwd,{recursive:true,force:true});}
});
test('RR-02 retained child quarantine protects its parent',async()=>{
 const cwd=await fixture(); try {await run(cwd,parent);await run(cwd,child,'failed',{parentRunId:parent});setWorkflowPruneAfterQuarantineForTests(()=>{throw Error('purge fault');});const result=await pruneWorkflowRuns(cwd,{keep:0,yes:true});assert.equal(result.runs.find(r=>r.runId===parent).protected,true);assert.equal(await exists(join(cwd,'.pi','workflows',parent)),true);}finally{setWorkflowPruneAfterQuarantineForTests();await rm(cwd,{recursive:true,force:true});}
});
test('RR-02 actual CLI rejects mirror validation failure and preserves primary and mirror evidence',async()=>{
 const cwd=await fixture(); try {
  const p=await run(cwd,parent); const outside=join(cwd,'mirror-evidence'); await mkdir(outside); await writeFile(join(outside,'evidence'),'recover me'); const mirror=join(cwd,'.pi','workflow-subagents',parent); await mkdir(join(mirror,'..'),{recursive:true}); await symlink(outside,mirror); await updateIndex(cwd);
  const cli=spawnSync(process.execPath,[new URL('../../src/cli.mjs',import.meta.url).pathname,'prune','--keep','0','--yes','--json'],{cwd,encoding:'utf8'});
  assert.notEqual(cli.status,0,cli.stdout+cli.stderr); const summary=JSON.parse(cli.stdout); assert.ok(summary.error); assert.equal(summary.runs[0].detached,false); assert.equal(await exists(p.dir),true); assert.equal(await readFile(join(mirror,'evidence'),'utf8'),'recover me'); assert.equal((await readIndex(cwd)).runs[0].runId,parent);
 } finally {await rm(cwd,{recursive:true,force:true});}
});
test('RR-02 pre-primary-detach failure preserves canonical run and recoverable mirror',async()=>{
 const cwd=await fixture();try{
  const p=await run(cwd,parent);const mirror=join(cwd,'.pi','workflow-subagents',parent);await mkdir(mirror,{recursive:true});await writeFile(join(mirror,'evidence'),'recover me');await updateIndex(cwd);
  setWorkflowPruneBeforePrimaryDetachForTests(()=>{throw Error('primary detach fault');});
  const summary=await pruneWorkflowRuns(cwd,{keep:0,yes:true});const entry=summary.runs[0];assert.equal(entry.detached,false);assert.equal(entry.purged,false);assert.equal(summary.deletedBytes,0);assert.equal(summary.indexUpdated,false);assert.ok(summary.error);assert.equal(await exists(p.dir),true);assert.equal(await readFile(join(entry.retainedMirrorPath,'evidence'),'utf8'),'recover me');assert.equal((await readIndex(cwd)).runs[0].runId,parent);
 }finally{setWorkflowPruneBeforePrimaryDetachForTests();await rm(cwd,{recursive:true,force:true});}
});
test('RR-01 retained quarantine continues to protect ancestry in a later prune plan',async()=>{
 const cwd=await fixture();try{
  await run(cwd,parent);await run(cwd,child,'failed',{parentRunId:parent});setWorkflowPruneAfterQuarantineForTests(()=>{throw Error('purge fault');});await pruneWorkflowRuns(cwd,{keep:0,yes:true});setWorkflowPruneAfterQuarantineForTests();
  const second=await pruneWorkflowRuns(cwd,{keep:0,yes:true});assert.equal(second.runs.find(r=>r.runId===parent).protected,true);assert.equal(await exists(join(cwd,'.pi','workflows',parent)),true);
 }finally{setWorkflowPruneAfterQuarantineForTests();await rm(cwd,{recursive:true,force:true});}
});
function processResult(code,cwd){const child=spawn(process.execPath,['--input-type=module','-e',code],{cwd,stdio:['ignore','pipe','pipe']});return new Promise((resolve,reject)=>{let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',reject);child.on('exit',status=>resolve({status,stdout,stderr}));});}
test('RR-01 cross-process child publication cannot race a prune into an orphan',async()=>{
 const cwd=await fixture();let writer;try{
  await run(cwd,parent);const marker=join(cwd,'writer-ready');
  setWorkflowPruneBeforeDeleteForTests(async()=>{
   const record={schemaVersion:1,runId:child,parentRunId:parent,rootRunId:parent,createdAt:timestamp,updatedAt:timestamp,tasks:[]};
   writer=processResult(`import {writeRunRecord} from ${JSON.stringify(new URL('../../.tmp/unit/store.js',import.meta.url).href)};import {writeFile} from 'node:fs/promises';await writeFile(${JSON.stringify(marker)},'ready');try{await writeRunRecord(${JSON.stringify(cwd)},${JSON.stringify(record)});console.log('published');}catch(error){console.log(error.message);process.exitCode=3;}`,cwd);
   const deadline=Date.now()+3000;while(!await exists(marker)){assert.ok(Date.now()<deadline);await new Promise(r=>setTimeout(r,5));}await new Promise(r=>setTimeout(r,30));
   assert.equal(await exists(join(cwd,'.pi','workflows',child,'run.json')),false);
  });
  const summary=await pruneWorkflowRuns(cwd,{keep:0,yes:true});assert.equal(summary.runs[0].deleted,true);const result=await writer;assert.equal(result.status,3,result.stdout+result.stderr);assert.equal(await exists(join(cwd,'.pi','workflows',child,'run.json')),false);
 }finally{setWorkflowPruneBeforeDeleteForTests();await writer;await rm(cwd,{recursive:true,force:true});}
});
test('RR-01 two destructive prune processes serialize their plans',async()=>{
 const cwd=await fixture();let second;let entered=false;try{
  await run(cwd,parent);
  setWorkflowPruneBeforeDeleteForTests(async()=>{if(entered)return;entered=true;second=processResult(`import {pruneWorkflowRuns} from ${JSON.stringify(new URL('../../.tmp/unit/run-retention.js',import.meta.url).href)};console.log(JSON.stringify(await pruneWorkflowRuns(${JSON.stringify(cwd)},{keep:0,yes:true})));`,cwd);await new Promise(r=>setTimeout(r,60));});
  const first=await pruneWorkflowRuns(cwd,{keep:0,yes:true});assert.equal(first.runs[0].deleted,true);const result=await second;assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout).runs,[]);assert.deepEqual((await readIndex(cwd)).runs,[]);
 }finally{setWorkflowPruneBeforeDeleteForTests();await second;await rm(cwd,{recursive:true,force:true});}
});
test('RR-02 post-detach fault never removes a new same-ID run or mirror and indexes the new generation',async()=>{
 const cwd=await fixture();try{
  await run(cwd,parent);const mirror=join(cwd,'.pi','workflow-subagents',parent);await mkdir(mirror,{recursive:true});await writeFile(join(mirror,'old'),'old');
  setWorkflowPruneAfterQuarantineForTests(async()=>{await run(cwd,parent,'running',{name:'new-generation'});await mkdir(mirror,{recursive:true});await writeFile(join(mirror,'new'),'new');throw Error('post-detach fault');});
  const result=await pruneWorkflowRuns(cwd,{keep:0,yes:true});assert.equal(result.runs[0].detached,true);assert.equal(result.deletedBytes,0);assert.equal((await readIndex(cwd)).runs[0].name,'new-generation');assert.equal(await readFile(join(mirror,'new'),'utf8'),'new');assert.equal(await readFile(join(result.runs[0].retainedMirrorPath,'old'),'utf8'),'old');
 }finally{setWorkflowPruneAfterQuarantineForTests();await rm(cwd,{recursive:true,force:true});}
});
test('RR-01 topology lease acquisition is bounded and dry run ignores a held plan lock',async()=>{
 const cwd=await fixture();let lease;try{await run(cwd,parent);lease=await acquireWorkflowTopologyLease(cwd);assert.ok(lease);const start=Date.now();assert.equal(await acquireWorkflowTopologyLease(cwd,25),undefined);assert.ok(Date.now()-start<1000);const dry=await pruneWorkflowRuns(cwd,{keep:0});assert.equal(dry.dryRun,true);assert.equal(dry.indexUpdated,false);await lease.assertOwner();}finally{await lease?.release();await rm(cwd,{recursive:true,force:true});}
});
test('RR-01 first child publication fences topology ownership at atomic commit',async()=>{
 const cwd=await fixture();try{
  await run(cwd,parent);const file=join(cwd,'.pi','workflows',child,'run.json');
  setRunLeaseTestHooksForTests({onBeforeAtomicRename:async({file:target})=>{if(target!==file)return;await writeFile(join(cwd,'.pi','workflows','retention.lock'),`replacement-owner\n${process.pid}\n${new Date().toISOString()}\n`);}});
  await assert.rejects(writeRunRecord(cwd,{schemaVersion:1,runId:child,parentRunId:parent,createdAt:timestamp,updatedAt:timestamp,tasks:[]}),/Lost supervisor lease/);assert.equal(await exists(file),false);
 }finally{setRunLeaseTestHooksForTests();await rm(cwd,{recursive:true,force:true});}
});
test('RR-01 competing first writers cannot change a published parent reference',async()=>{
 const cwd=await fixture();try{
  await run(cwd,parent);await run(cwd,'workflow_other_parent');const record={schemaVersion:1,runId:child,parentRunId:parent,createdAt:timestamp,updatedAt:timestamp,tasks:[]};
  const results=await Promise.allSettled([writeRunRecord(cwd,{...record}),writeRunRecord(cwd,{...record,parentRunId:'workflow_other_parent'})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.match(results.find(r=>r.status==='rejected').reason.message,/ancestry is immutable/);
 }finally{await rm(cwd,{recursive:true,force:true});}
});
test('RR-01 published ancestry cannot move outside topology serialization',async()=>{
 const cwd=await fixture();try{await run(cwd,parent);const c=await run(cwd,child,'running',{parentRunId:parent});await assert.rejects(writeRunRecord(cwd,{...c.record,parentRunId:undefined}),/ancestry is immutable/);}finally{await rm(cwd,{recursive:true,force:true});}
});
for(const change of ['valid','opId','requestHash','workflowId','uses','controllerSpecId','seq','runId']) test(`DEP-01 ancestry tuple and canonical ledger: ${change}`,async()=>{
 const cwd=await fixture();try{
  const p=await run(cwd,parent);await run(cwd,child,'running',{parentRunId:parent,rootRunId:parent});
  const duplicate={...start,seq:3,payload:{...start.payload,status:'running'}};
  if(['workflowId','uses'].includes(change))duplicate.payload[change]='different';else if(change==='seq')duplicate.seq=2;else if(change!=='valid')duplicate[change]='different';
  await ledger(p.dir,[init,start,duplicate]);assert.equal(await remainingDynamicNestedWorkflowDepth(cwd,child,8),change==='valid'?1:0);
 }finally{await rm(cwd,{recursive:true,force:true});}
});
test('DEP-02 hot reads/writes do not open descendant ledgers; explicit display retains full depth',async()=>{
 const cwd=await fixture();try{
  const p=await run(cwd,parent);const c=await run(cwd,child,'running',{parentRunId:parent});await ledger(p.dir,[init,start]);await ledger(c.dir,[{...init,runId:child},{...start,runId:child,payload:{...start.payload,runId:'workflow_grandchild'}}]);
  await writeFile(join(p.dir,'dynamic','state.json'),JSON.stringify(projectDynamicState(parent,[init,start])));
  const display=await readOrRebuildDynamicState(cwd,parent,{observeDescendants:true});assert.equal(display.controllers[controller].counters.nestedWorkflowDepth,2);
  // A malformed descendant is an IO tripwire. A hot read must not touch it.
  await writeFile(join(c.dir,'dynamic','events.jsonl'),'{bad\n');
  const hot=await readOrRebuildDynamicState(cwd,parent);assert.equal(hot.controllers[controller].counters.nestedWorkflowDepth,1);
  await recordDynamicEventAndUpdateState(cwd,parent,{controllerSpecId:controller,type:'controller.phase',opId:'phase',requestHash:'phase-hash',payload:{phase:'hot'}});
 }finally{await rm(cwd,{recursive:true,force:true});}
});
