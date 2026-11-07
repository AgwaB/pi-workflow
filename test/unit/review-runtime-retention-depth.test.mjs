import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm, stat, readdir, symlink, realpath, link } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { pruneWorkflowRuns, setGoalRetentionAfterDetachCommitForTests, setGoalRetentionBeforeDetachCommitForTests, setWorkflowPruneAfterQuarantineForTests, setWorkflowPruneBeforeDeleteForTests, setWorkflowPruneBeforePrimaryDetachForTests } from '../../.tmp/unit/run-retention.js';
import { readIndex, updateIndex, withRunLease, writeRunRecord, acquireWorkflowTopologyLease, setRunLeaseTestHooksForTests } from '../../.tmp/unit/store.js';
import { GoalStore } from '../../.tmp/unit/goal-store.js';
import { hasCurrentGoalHostWriteLease, withGoalHostWriteLock, withGoalHostWriteLocks } from '../../.tmp/unit/goal-host-write-lock.js';
import { fixture as goalFixture, goalHash } from './helpers/goal-fixture.mjs';
import { remainingDynamicNestedWorkflowDepth } from '../../.tmp/unit/dynamic-nested-depth.js';
import { workflowDefinitionFingerprint as fingerprint } from '../../.tmp/unit/execution-profile.js';
import { parseWorkflowPruneArgs } from '../../.tmp/unit/extension.js';
import { projectDynamicState, readOrRebuildDynamicState, recordDynamicEventAndUpdateState } from '../../.tmp/unit/dynamic-state.js';
const parent = 'workflow_parent', child = 'workflow_child', controller = 'adaptive.controller';
const timestamp = '2026-01-01T00:00:00.000Z';
const event = (seq, type, payload, extra = {}) => ({schema:'pi-workflow-dynamic-event-v1',runId:parent,controllerSpecId:controller,seq,type,payload,opId:`op-${seq}`,requestHash:`hash-${seq}`,timestamp,...extra});
const init = event(1, 'controller.initialized', {budget:{maxNestedWorkflowDepth:2}});
const start = event(2, 'workflow.started', {runId:child,workflowId:'child',uses:'./child/spec.json',status:'starting'});
async function fixture() { return realpath(await mkdtemp(join(tmpdir(), 'piwf-review-fixes-'))); }
async function run(cwd, id, status = 'completed', extra = {}) {
 const dir = join(cwd,'.pi','workflows',id); await mkdir(join(dir,'dynamic'),{recursive:true});
 const record = {schemaVersion:1,runId:id,createdAt:timestamp,updatedAt:timestamp,tasks:[{taskId:`${id}-task`,specId:controller,status}],...extra};
 await writeFile(join(dir,'run.json'),JSON.stringify(record)); return {dir,record};
}
async function ledger(dir, events) { await writeFile(join(dir,'dynamic','events.jsonl'),events.map(JSON.stringify).join('\n')+'\n'); }
// Hand-shaped deletion mechanics only: these records do not establish original
// live admission, provider quality, or a successful cold producer lifecycle.
async function ordinaryClosureFixture(cwd) {
 const definition=JSON.parse(await readFile(new URL('../../workflows/goal-example/spec.json',import.meta.url),'utf8'));
 const hash='a'.repeat(64), id=parent, result=`.pi/workflows/${id}/tasks/root/artifacts/result.json`;
 const generation={generation:0,plannerSpecId:'planner',workerControllerSpecId:'goal',slots:{'goal-result':'worker'},outcome:'achieved'};
 const root={taskId:'root',specId:'goal',kind:'goal',status:'completed',files:{result},goalRoot:{definitionFingerprint:fingerprint(definition),generations:[generation]},goal:{goalId:`goal_engine_${hash.slice(0,32)}`,contractHash:hash,state:'engine:achieved',usage:{requests:0,costMicros:null}}};
 const f=await run(cwd,id,'completed',{cwd,rootRunId:id,goalParticipation:{schemaVersion:1,resumeRequired:false,goalPaths:['goal']},tasks:[root,
  {taskId:'planner',specId:'planner',status:'completed',files:{result:`.pi/workflows/${id}/tasks/planner/result.json`}},
  {taskId:'worker',specId:'worker',status:'completed',files:{result:`.pi/workflows/${id}/tasks/worker/result.json`}}]});
 await writeFile(join(f.dir,'compiled.json'),JSON.stringify({tasks:[
  {id:'goal',kind:'goal',goal:{definition,definitionFingerprint:fingerprint(definition)}},
  {id:'planner',kind:'single'},
  {id:'worker',kind:'dynamic-agent',dynamicGenerated:{controllerSpecId:generation.workerControllerSpecId}},
 ]}));
 const control={result:{values:['a','b']}}, criterion=definition.goal.criteria[0];
 const evidence={schema:'goal-oracle-observation-v1',contractHash:hash,cwd,rootRunId:id,runId:id,policySpecId:'goal',policyTaskId:'root',generation:0,policyAttemptKey:'NONAUTHORITY-mechanics',definitionFingerprint:fingerprint(definition),observations:[{criterion,sources:[{taskId:'goal-result',control,controlHash:fingerprint(control),identity:{runId:id,taskId:'worker',specId:'worker',generation:0}}],expectedHash:fingerprint(control.result),valueHash:fingerprint(control.result),value:control.result,verdict:'met',reason:null}]};
 const evidenceDir=join(f.dir,'tasks/root/artifacts/goal-evidence');await mkdir(evidenceDir,{recursive:true});
 const evidencePath=join(evidenceDir,`${fingerprint(evidence)}.json`);await writeFile(evidencePath,JSON.stringify({schema:'goal-oracle-receipt-v1',digest:fingerprint(evidence),evidence}));
 const evidenceRef=relative(cwd,evidencePath);
 await writeFile(join(f.dir,'tasks/root/artifacts/control.json'),JSON.stringify({
  schema:'goal-policy-result-v1',goalId:root.goal.goalId,contractHash:hash,
  evidenceRefs:[evidenceRef],retainedEvidenceRefs:[evidenceRef],oracle:evidence,
 }));
 await writeFile(join(f.dir,'tasks/root/artifacts/refs.json'),JSON.stringify([{id:evidenceRef,path:evidenceRef}]));
 return {...f,root,evidencePath};
}
test('RR-AC14 explicit ordinary selector shared parser rejects duplicate unsafe and mixed filters',async()=>{
 assert.deepEqual(parseWorkflowPruneArgs(['--goal-family',parent,'--yes','--json']),{terminalWorkflowGoalRoot:parent,yes:true,json:true});
 for(const args of [['--goal-family'],['--goal-family','../outside'],['--goal-family',parent,'--goal-family',child],['--goal-family',parent,'--keep','0'],['--older-than','1','--goal-family',parent]])assert.throws(()=>parseWorkflowPruneArgs(args));
 const cwd=await fixture();try{
  for(const options of [{terminalWorkflowGoalRoot:'../outside'},{terminalWorkflowGoalRoot:parent,keep:0},{terminalWorkflowGoalRoot:parent,terminalGoalFamilyRoots:[]}])await assert.rejects(pruneWorkflowRuns(cwd,options));
  assert.match((await pruneWorkflowRuns(cwd,{terminalWorkflowGoalRoot:parent})).error,/absent/);
 }finally{await rm(cwd,{recursive:true,force:true});}
});
test('RR-AC14 explicit isolated ordinary preview inert and yes deletes only exact target',async()=>{
 const cwd=await fixture();try{
  const f=await ordinaryClosureFixture(cwd);const plain=await run(cwd,child);
  const bytes=await readFile(join(f.dir,'run.json'),'utf8'), entries=await readdir(f.dir);
  const generic=await pruneWorkflowRuns(cwd,{keep:0});assert.equal(generic.runs.find(r=>r.runId===parent).protected,true);
  const preview=await pruneWorkflowRuns(cwd,{terminalWorkflowGoalRoot:parent});assert.equal(preview.error,undefined);assert.equal(preview.runs.length,1);assert.equal(preview.runs[0].protected,false);assert.equal(preview.indexUpdated,false);
  assert.deepEqual(await readdir(f.dir),entries);assert.equal(await readFile(join(f.dir,'run.json'),'utf8'),bytes);
  const deleted=await pruneWorkflowRuns(cwd,{terminalWorkflowGoalRoot:parent,yes:true});assert.equal(deleted.error,undefined);assert.equal(deleted.runs.length,1);assert.equal(deleted.runs[0].deleted,true);assert.equal(deleted.indexUpdated,true);assert.equal(await exists(plain.dir),true);assert.equal(await exists(f.dir),false);
 }finally{await rm(cwd,{recursive:true,force:true});}
});
for(const scenario of ['plain','parent','child','child-marker','reservation','external-reference','unknown','partial','missing-oracle','unsettled-request','unknown-effect','recovery','live-heartbeat'])test(`RR-AC14 explicit ordinary closure denies ${scenario}`,async()=>{
 const cwd=await fixture();try{
  const f=await ordinaryClosureFixture(cwd);
  if(scenario==='plain'){delete f.root.goalRoot;delete f.root.goal;delete f.record.goalParticipation;}
  if(scenario==='parent')f.record.parentRunId=child;
  if(scenario==='child')await run(cwd,child,'completed',{parentRunId:parent,rootRunId:parent});
  if(scenario==='child-marker')f.record.goalChild=null;
  if(scenario==='reservation')await ledger(f.dir,[init,start]);
  if(scenario==='external-reference')await run(cwd,child,'completed',{tasks:[{taskId:'external',specId:'external',status:'completed',goal:{...f.root.goal}}]});
  if(scenario==='unknown')f.root.goal.state='engine:unknown';
  if(scenario==='partial')f.root.goal.usage.requests=null;
  if(scenario==='missing-oracle')await rm(f.evidencePath);
  if(scenario==='unsettled-request'){const dir=join(f.dir,'tasks/worker/artifacts/request-reservations');await mkdir(dir,{recursive:true});await writeFile(join(dir,`${goalHash('request')}.json`),JSON.stringify({schema:'goal-request-reservation-v1',id:'request',phase:'reserved',authority:'original',commitment:'original'}));}
  if(scenario==='unknown-effect'){const dir=join(f.dir,'tasks/worker/artifacts/candidate-operations/channel');await mkdir(dir,{recursive:true});await writeFile(join(dir,`${goalHash('call')}.json`),JSON.stringify({intent:{schema:'goal-candidate-operation-v1',toolCallId:'call'},phase:'unknown'}));}
  if(scenario==='recovery')await writeFile(join(f.dir,'publication.txn'),'original recovery residue');
  if(scenario==='live-heartbeat')await writeFile(join(f.dir,'supervisor.json'),JSON.stringify({pid:process.pid,updatedAt:new Date().toISOString()}));
  await writeFile(join(f.dir,'run.json'),JSON.stringify(f.record));const before=await readFile(join(f.dir,'run.json'),'utf8');
  for(const yes of [false,true]){const result=await pruneWorkflowRuns(cwd,{terminalWorkflowGoalRoot:parent,yes});assert.ok(result.error);assert.equal(result.runs[0].protected,true);assert.equal(result.runs[0].deleted,false);assert.notEqual(result.runs[0].detached,true);assert.equal(result.deletedBytes,0);assert.equal(await readFile(join(f.dir,'run.json'),'utf8'),before);}
 }finally{await rm(cwd,{recursive:true,force:true});}
});
for(const fence of ['selection','primary detach'])test(`RR-AC14 explicit ordinary closure rechecks UNKNOWN at ${fence}`,async()=>{
 const cwd=await fixture();try{
  const f=await ordinaryClosureFixture(cwd);const evidence=await readFile(f.evidencePath,'utf8');
  const mark=async()=>{f.root.goal.state='engine:unknown';await writeFile(join(f.dir,'run.json'),JSON.stringify(f.record));};
  if(fence==='selection')setWorkflowPruneBeforeDeleteForTests(mark);else setWorkflowPruneBeforePrimaryDetachForTests(mark);
  const result=await pruneWorkflowRuns(cwd,{terminalWorkflowGoalRoot:parent,yes:true});assert.ok(result.error);assert.equal(result.runs[0].protected,true);assert.equal(result.runs[0].detached,false);assert.equal(await readFile(f.evidencePath,'utf8'),evidence);assert.equal(result.deletedBytes,0);
 }finally{setWorkflowPruneBeforeDeleteForTests();setWorkflowPruneBeforePrimaryDetachForTests();await rm(cwd,{recursive:true,force:true});}
});
for(const fence of ['selection','primary detach'])test(`RR-AC14 explicit ordinary same-inode binary mutation refuses at ${fence}`,async()=>{
 const cwd=await fixture();try{
  const f=await ordinaryClosureFixture(cwd), artifact=join(f.dir,'original-binary-artifact');
  const mirror=join(cwd,'.pi','workflow-subagents',parent);await mkdir(mirror,{recursive:true});
  await writeFile(join(mirror,'evidence'),'complete original mirror');const mirrorIdentity=await stat(mirror);
  await writeFile(artifact,Buffer.from([0xff]));const original=await stat(artifact);
  const mutate=async()=>{
   await writeFile(artifact,Buffer.from([0xfe]));const changed=await stat(artifact);
   assert.equal(changed.dev,original.dev);assert.equal(changed.ino,original.ino);
   assert.equal(Buffer.from([0xff]).toString('utf8'),Buffer.from([0xfe]).toString('utf8'));
  };
  if(fence==='selection')setWorkflowPruneBeforeDeleteForTests(mutate);else setWorkflowPruneBeforePrimaryDetachForTests(mutate);
  const result=await pruneWorkflowRuns(cwd,{terminalWorkflowGoalRoot:parent,yes:true});
  assert.match(result.error,/evidence changed/);assert.equal(result.runs[0].protected,true);
  assert.equal(result.runs[0].detached,false);assert.equal(result.runs[0].deleted,false);assert.equal(result.deletedBytes,0);
  assert.deepEqual(await readFile(artifact),Buffer.from([0xfe]));assert.equal(await exists(f.evidencePath),true);
  const retained=result.runs[0].retainedMirrorPath??mirror, retainedIdentity=await stat(retained);
  assert.equal(retainedIdentity.dev,mirrorIdentity.dev);assert.equal(retainedIdentity.ino,mirrorIdentity.ino);
  assert.deepEqual(await readdir(retained),['evidence']);assert.equal(await readFile(join(retained,'evidence'),'utf8'),'complete original mirror');
  assert.equal(await exists(mirror),fence==='selection');assert.equal(result.indexUpdated,false);
 }finally{setWorkflowPruneBeforeDeleteForTests();setWorkflowPruneBeforePrimaryDetachForTests();await rm(cwd,{recursive:true,force:true});}
});
for(const location of ['external','internal']) test(`RR-AC14 ordinary closure refuses ${location} protected JSON hardlinks`,async()=>{
 const cwd=await fixture();try{
  const f=await ordinaryClosureFixture(cwd), original=await readFile(f.evidencePath);
  const alias=join(location==='external'?cwd:f.dir,'unaccounted-oracle.json');
  await link(f.evidencePath,alias);
  const result=await pruneWorkflowRuns(cwd,{terminalWorkflowGoalRoot:parent,yes:true});
  assert.match(result.error,/Goal evidence.*(custody|unaccounted links)/);
  assert.equal(result.runs[0].protected,true);assert.notEqual(result.runs[0].detached,true);
  assert.equal(await exists(f.dir),true);assert.deepEqual(await readFile(f.evidencePath),original);
 }finally{await rm(cwd,{recursive:true,force:true});}
});
const exists = path => stat(path).then(()=>true,()=>false);
async function admitGoalChild(cwd, parentRunId, childRunId, goalId='fixture-goal') {
 const base=goalFixture();const authority={...base.contract.authority,goalId};const root=join(cwd,'.pi','goals','current',goalId);const f=goalFixture({goalId,authority,authorityHash:goalHash(authority)});const store=new GoalStore(root);const owner=store.hostOwner('retention-owner',0);
 await mkdir(join(cwd,'.pi','goals','current'),{recursive:true});
 const snapshot=await store.create(f.contract,owner,f.obs());
 const noted=await store.commitEvent(owner,snapshot,f.event('note',{text:`goal-p2-fixture-v1:${JSON.stringify({type:'reserve',binding:{storeRoot:root,runId:childRunId,parentRunId}})}`}));
 return {goalId:snapshot.contract.goalId,contractHash:goalHash(snapshot.contract),terminal:async()=>{
  const cancelling=await store.commitEvent(owner,noted,f.event('control',{action:'cancel'},{kind:'user',id:'owner-user'}));
  return store.commitEvent(owner,cancelling,f.terminal('cancelled'));
 }};
}
test('RR-01 selected child purges before newer parent; dry run has no writes',async()=>{
 const cwd=await fixture(); try {
  await run(cwd,parent,'completed',{updatedAt:'2026-01-03T00:00:00.000Z'}); await run(cwd,child,'failed',{parentRunId:parent});
  const before=await readdir(join(cwd,'.pi','workflows')); const dry=await pruneWorkflowRuns(cwd,{keep:0});
  assert.equal(dry.indexUpdated,false); assert.deepEqual(await readdir(join(cwd,'.pi','workflows')),before);
  const result=await pruneWorkflowRuns(cwd,{keep:0,yes:true}); assert.deepEqual(result.runs.map(r=>r.runId),[child,parent]); assert.ok(result.runs.every(r=>r.deleted));
 } finally { await rm(cwd,{recursive:true,force:true}); }
});
for (const [label, status, markers, taskMarkers] of [
 ['UNKNOWN failed', 'failed', {}, {goal:{goalId:'goal_engine_fixture',contractHash:'a'.repeat(64),state:'engine:unknown'}}],
]) test(`RR-AC14 ordinary Goal ${label} protects evidence and ancestry from generic keep0`,async()=>{
 const cwd=await fixture();try{
  const ancestor=await run(cwd,parent);
  const ordinary=await run(cwd,child,status,{parentRunId:parent,rootRunId:parent,...markers,
   tasks:[{taskId:`${child}-task`,specId:'goal',status,...taskMarkers}]});
  const descendant=await run(cwd,'workflow_descendant','completed',{parentRunId:child,rootRunId:parent});
  const plain=await run(cwd,'workflow_plain');
  const evidence=join(ordinary.dir,'immutable-judgment.json');await writeFile(evidence,'original recovery evidence\n');
  const before=await readFile(join(ordinary.dir,'run.json'),'utf8');
  const preview=await pruneWorkflowRuns(cwd,{keep:0});
  for(const id of [parent,child,'workflow_descendant']){
   const entry=preview.runs.find(r=>r.runId===id);assert.equal(entry.selected,true);assert.equal(entry.protected,true);assert.match(entry.error,/ordinary Goal/);
  }
  assert.equal(preview.runs.find(r=>r.runId==='workflow_plain').protected,false);
  assert.equal(await exists(join(cwd,'.pi','goals')),false,'ordinary protection requires no private GoalStore');
  assert.equal(await readFile(join(ordinary.dir,'run.json'),'utf8'),before);
  const deleted=await pruneWorkflowRuns(cwd,{keep:0,yes:true});
  for(const id of [parent,child,'workflow_descendant']){
   const entry=deleted.runs.find(r=>r.runId===id);assert.equal(entry.protected,true);assert.equal(entry.deleted,false);assert.notEqual(entry.detached,true);
  }
  assert.equal(deleted.runs.find(r=>r.runId==='workflow_plain').deleted,true,'unrelated plain workflows remain prunable');
  for(const dir of [ancestor.dir,ordinary.dir,descendant.dir])assert.equal(await exists(dir),true);
  assert.equal(await exists(plain.dir),false);
  assert.equal(await readFile(join(ordinary.dir,'run.json'),'utf8'),before);
  assert.equal(await readFile(evidence,'utf8'),'original recovery evidence\n');
 }finally{await rm(cwd,{recursive:true,force:true});}
});
for (const [label, marker, missingParent] of [
 ['orphan partial', {policySpecId:'goal'}, true],
 ['orphan null', null, true],
 ['malformed without parent', 'not-authority', false],
 ['empty without parent', {}, false],
]) test(`RR-AC14 Goal child ${label} remains protected without authoritative family lineage`,async()=>{
 const cwd=await fixture();try{
  const orphan=await run(cwd,child,'completed',{goalChild:marker,...(missingParent?{parentRunId:'workflow_missing',rootRunId:'workflow_missing'}:{})});
  const plain=await run(cwd,'workflow_plain');
  const evidence=join(orphan.dir,'raw.md');await writeFile(evidence,'original orphan evidence\n');
  const before=await readFile(join(orphan.dir,'run.json'));
  const preview=await pruneWorkflowRuns(cwd,{keep:0});
  const selected=preview.runs.find(entry=>entry.runId===child);
  assert.equal(selected.selected,true);assert.equal(selected.protected,true);assert.match(selected.error,/ordinary Goal/);
  assert.equal(preview.runs.find(entry=>entry.runId==='workflow_plain').protected,false);
  assert.deepEqual(await readFile(join(orphan.dir,'run.json')),before);
  const destructive=await pruneWorkflowRuns(cwd,{keep:0,yes:true});
  const retained=destructive.runs.find(entry=>entry.runId===child);
  assert.equal(retained.protected,true);assert.equal(retained.deleted,false);assert.notEqual(retained.detached,true);
  assert.equal(destructive.runs.find(entry=>entry.runId==='workflow_plain').deleted,true);
  assert.equal(await exists(plain.dir),false);
  assert.deepEqual(await readFile(join(orphan.dir,'run.json')),before);
  assert.equal(await readFile(evidence,'utf8'),'original orphan evidence\n');
  const closure=await pruneWorkflowRuns(cwd,{terminalWorkflowGoalRoot:child,yes:true});
  assert.ok(closure.error,'child marker cannot authorize standalone closure');
  assert.deepEqual(await readFile(join(orphan.dir,'run.json')),before);
  assert.equal(await exists(join(cwd,'.pi','goals')),false,'ordinary hints never open private namespace');
 }finally{await rm(cwd,{recursive:true,force:true});}
});
for (const marker of ['goalParticipation','goalChild']) for (const fence of ['selection','primary detach']) test(`RR-AC14 ordinary Goal ${marker} appearing after ${fence} preserves selected evidence`,async()=>{
 const cwd=await fixture();try{
  const p=await run(cwd,parent);const c=await run(cwd,child,'completed',{parentRunId:parent,rootRunId:parent});
  const mirror=join(cwd,'.pi','workflow-subagents',child);await mkdir(mirror,{recursive:true});await writeFile(join(mirror,'evidence'),'original mirror');
  const mark=async()=>{
   c.record[marker]=marker==='goalChild'?null:{resumeRequired:true};
   // Keep timestamps and directory identity unchanged: a marker alone must fence deletion.
   await writeFile(join(c.dir,'run.json'),JSON.stringify(c.record));
  };
  if(fence==='selection')setWorkflowPruneBeforeDeleteForTests(mark);
  else setWorkflowPruneBeforePrimaryDetachForTests(mark);
  const result=await pruneWorkflowRuns(cwd,{keep:0,yes:true});
  const entry=result.runs.find(r=>r.runId===child);
  assert.equal(entry.protected,true);assert.equal(entry.deleted,false);assert.equal(entry.detached,false);assert.match(entry.error,/ordinary Goal/);
  assert.equal(result.runs.find(r=>r.runId===parent).protected,true,'fresh marker protects its selected ancestor too');
  assert.equal(await exists(p.dir),true);assert.equal(await exists(c.dir),true);assert.equal(result.deletedBytes,0);
  assert.equal(await readFile(join(entry.retainedMirrorPath??mirror,'evidence'),'utf8'),'original mirror');
 }finally{setWorkflowPruneBeforeDeleteForTests();setWorkflowPruneBeforePrimaryDetachForTests();await rm(cwd,{recursive:true,force:true});}
});
test('RR-03 retained Goal parent reference blocks its admitted child',async()=>{
 const cwd=await fixture();try{
  const goal=await admitGoalChild(cwd,parent,child);await run(cwd,parent,'completed',{updatedAt:'2026-01-03T00:00:00.000Z',tasks:[{taskId:'goal-parent-task',specId:controller,status:'completed',goal:{...goal,state:'terminal'}}]});
  const c=await run(cwd,child,'failed');const result=await pruneWorkflowRuns(cwd,{keep:1,yes:true});const entry=result.runs.find(r=>r.runId===child);
  assert.equal(entry.protected,true);assert.match(entry.error,/current Goal reference/);assert.equal(await exists(c.dir),true);
 }finally{await rm(cwd,{recursive:true,force:true});}
});
test('RR-03 standalone current Goal reference blocks its admitted child',async()=>{
 const cwd=await fixture();try{
  await admitGoalChild(cwd,parent,child);const c=await run(cwd,child,'failed');
  const result=await pruneWorkflowRuns(cwd,{keep:0,yes:true});const entry=result.runs.find(r=>r.runId===child);
  assert.equal(entry.protected,true);assert.match(entry.error,/current Goal reference/);assert.equal(await exists(c.dir),true);
 }finally{await rm(cwd,{recursive:true,force:true});}
});
test('RR-03 malformed current Goal closure marker conservatively blocks prune',async()=>{
 const cwd=await fixture();try{
  await admitGoalChild(cwd,parent,child);const c=await run(cwd,child,'failed');
  await writeFile(join(cwd,'.pi','goals','current','fixture-goal','.goal-retention-closed.json'),'{"schema":"pi-goal-retention-closure-v1"');
  const result=await pruneWorkflowRuns(cwd,{keep:0,yes:true});assert.equal(result.runs.find(r=>r.runId===child).protected,true);assert.equal(await exists(c.dir),true);
 }finally{await rm(cwd,{recursive:true,force:true});}
});
test('RR-03 dual current Goal layouts conservatively block prune',async()=>{
 const cwd=await fixture();try{
  await admitGoalChild(cwd,parent,child);const c=await run(cwd,child,'failed');
  await mkdir(join(cwd,'.pi','goals','current','fixture-goal','goal'));
  const result=await pruneWorkflowRuns(cwd,{keep:0,yes:true,terminalGoalFamilyRoots:['fixture-goal']});assert.match(result.error,/dual layouts/);assert.equal(await exists(c.dir),true);
 }finally{await rm(cwd,{recursive:true,force:true});}
});
test('RR-03 swapped current Goal root is never followed for prune references',async()=>{
 const cwd=await fixture();const outside=await fixture();try{
  await admitGoalChild(cwd,parent,child);const c=await run(cwd,child,'failed');
  const root=join(cwd,'.pi','goals','current','fixture-goal');await rm(root,{recursive:true,force:true});await mkdir(join(outside,'foreign-goal'));await symlink(join(outside,'foreign-goal'),root);
  const result=await pruneWorkflowRuns(cwd,{keep:0,yes:true});assert.equal(result.runs.find(r=>r.runId===child).protected,true);assert.equal(await exists(c.dir),true);
 }finally{await rm(cwd,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});
test('RR-03 current Goal evidence blocks ordinary closure and nonterminal explicit closure',async()=>{
 const cwd=await fixture();let release;let held;try{
  const goal=await admitGoalChild(cwd,parent,child);await run(cwd,parent,'completed',{updatedAt:'2026-01-03T00:00:00.000Z',tasks:[{taskId:'goal-parent-task',specId:controller,status:'completed',goal:{...goal,state:'terminal'}}]});
  const c=await run(cwd,child,'failed');const closed=await pruneWorkflowRuns(cwd,{keep:0,yes:true});assert.equal(closed.runs.find(r=>r.runId===child).protected,true);assert.equal(await exists(c.dir),true);
  const explicit=await pruneWorkflowRuns(cwd,{keep:0,yes:true,terminalGoalFamilyRoots:['fixture-goal']});assert.match(explicit.error,/not terminal and drained/);assert.equal(await exists(c.dir),true);
 }finally{release?.();await held;await rm(cwd,{recursive:true,force:true});}
});
test('RR-03 explicit terminal family closes its Goal and workflow evidence together',async()=>{
 const cwd=await fixture();try{
  const goal=await admitGoalChild(cwd,parent,child);await goal.terminal();
  await run(cwd,parent,'completed',{tasks:[{taskId:'goal-parent-task',specId:controller,status:'completed',goal:{goalId:goal.goalId,contractHash:goal.contractHash,state:'terminal'}}]});
  await run(cwd,child,'failed');
  const closed=await pruneWorkflowRuns(cwd,{keep:0,yes:true,terminalGoalFamilyRoots:['fixture-goal']});
  assert.equal(closed.error,undefined);assert.deepEqual(new Set(closed.runs.map(row=>row.runId)),new Set([parent,child]));assert.ok(closed.runs.every(row=>row.deleted));assert.equal(await exists(join(cwd,'.pi','workflows',parent)),false);assert.equal(await exists(join(cwd,'.pi','workflows',child)),false);assert.equal(await exists(join(cwd,'.pi','goals','current','fixture-goal','.goal-retention-closed.json')),true);
 }finally{await rm(cwd,{recursive:true,force:true});}
});
test('RR-03 explicit family refuses a second retained Goal reference',async()=>{
 const cwd=await fixture();try{
  const one=await admitGoalChild(cwd,parent,child);await one.terminal();
  const two=await admitGoalChild(cwd,'workflow_second_parent',child,'fixture-goal-2');await two.terminal();
  await run(cwd,parent,'completed',{tasks:[{taskId:'goal-parent-task',specId:controller,status:'completed',goal:{goalId:one.goalId,contractHash:one.contractHash,state:'terminal'}}]});
  await run(cwd,'workflow_second_parent','completed',{tasks:[{taskId:'goal-second-parent-task',specId:controller,status:'completed',goal:{goalId:two.goalId,contractHash:two.contractHash,state:'terminal'}}]});
  const c=await run(cwd,child,'failed');const result=await pruneWorkflowRuns(cwd,{keep:0,yes:true,terminalGoalFamilyRoots:['fixture-goal']});
  assert.match(result.error,/external retained Goal reference/);assert.equal(await exists(c.dir),true);
 }finally{await rm(cwd,{recursive:true,force:true});}
});
test('RR-03 selected Goal closure fence does not inherit into sibling Goal host',async()=>{
 const cwd=await fixture();try{
  await mkdir(join(cwd,'.pi','goals','current','fixture-goal'),{recursive:true});
  await mkdir(join(cwd,'.pi','goals','current','fixture-goal-2'),{recursive:true});
  const selected=join(cwd,'.pi','goals','current','fixture-goal');
  const sibling=join(cwd,'.pi','goals','current','fixture-goal-2');
  await withGoalHostWriteLock(selected,async mark=>{mark();await withGoalHostWriteLock(selected,async()=>{});});
  await withGoalHostWriteLock(sibling,async()=>{});
 }finally{await rm(cwd,{recursive:true,force:true});}
});
test('RR-03 multi-root lease retains earlier exact root reentrancy without fencing sibling',async()=>{
 const cwd=await fixture();try{
  const first=join(cwd,'first'),second=join(cwd,'second'),sibling=join(cwd,'sibling');await Promise.all([mkdir(first),mkdir(second),mkdir(sibling)]);
  await withGoalHostWriteLocks([second,first],async()=>{
   await withGoalHostWriteLock(first,async()=>{});
   await withGoalHostWriteLock(sibling,async()=>{});
  });
 }finally{await rm(cwd,{recursive:true,force:true});}
});
test('RR-03 replaced exact lock path never remains an owned lease',async()=>{
 const cwd=await fixture();try{
  const root=join(cwd,'goal');await mkdir(root);
  await assert.rejects(withGoalHostWriteLock(root,async()=>{
   const lock=join(root,'.goal-host-write-lock');await rename(lock,join(root,'old-lock'));await mkdir(lock);
   assert.equal(await hasCurrentGoalHostWriteLease(root),false);
  }),/identity changed before release/);
 }finally{await rm(cwd,{recursive:true,force:true});}
});
test('RR-03 committed family detach interruption retains all recovery evidence',async()=>{
 const cwd=await fixture();try{
  const goal=await admitGoalChild(cwd,parent,child);await goal.terminal();
  await run(cwd,parent,'completed',{tasks:[{taskId:'goal-parent-task',specId:controller,status:'completed',goal:{goalId:goal.goalId,contractHash:goal.contractHash,state:'terminal'}}]});
  await run(cwd,child,'failed');
  setGoalRetentionAfterDetachCommitForTests(()=>{throw Error('after detach commit');});
  const result=await pruneWorkflowRuns(cwd,{keep:0,yes:true,terminalGoalFamilyRoots:['fixture-goal']});
  assert.match(result.error,/after detach commit/);assert.ok(result.runs.every(row=>row.detached&&!row.deleted));assert.equal(await exists(join(cwd,'.pi','goals','current','fixture-goal','.goal-retention-closed.json')),true);
 }finally{setGoalRetentionAfterDetachCommitForTests();await rm(cwd,{recursive:true,force:true});}
});
test('RR-03 pre-commit family interruption retains all detached evidence',async()=>{
 const cwd=await fixture();try{
  const goal=await admitGoalChild(cwd,parent,child);await goal.terminal();
  await run(cwd,parent,'completed',{tasks:[{taskId:'goal-parent-task',specId:controller,status:'completed',goal:{goalId:goal.goalId,contractHash:goal.contractHash,state:'terminal'}}]});
  await run(cwd,child,'failed');
  setGoalRetentionBeforeDetachCommitForTests(()=>{throw Error('before detach commit');});
  const result=await pruneWorkflowRuns(cwd,{keep:0,yes:true,terminalGoalFamilyRoots:['fixture-goal']});
  assert.match(result.error,/before detach commit/);assert.ok(result.runs.every(row=>row.detached&&!row.deleted));
 }finally{setGoalRetentionBeforeDetachCommitForTests();await rm(cwd,{recursive:true,force:true});}
});
test('RR-02 actual CLI rejects mirror validation failure and preserves primary and mirror evidence',async()=>{
 const cwd=await fixture(); try {
  const p=await run(cwd,parent); const outside=join(cwd,'mirror-evidence'); await mkdir(outside); await writeFile(join(outside,'evidence'),'recover me'); const mirror=join(cwd,'.pi','workflow-subagents',parent); await mkdir(join(mirror,'..'),{recursive:true}); await symlink(outside,mirror); await updateIndex(cwd);
  const cli=spawnSync(process.execPath,[new URL('../../src/cli.mjs',import.meta.url).pathname,'prune','--keep','0','--yes','--json'],{cwd,encoding:'utf8'});
  assert.notEqual(cli.status,0,cli.stdout+cli.stderr); const summary=JSON.parse(cli.stdout); assert.ok(summary.error); assert.equal(summary.runs[0].detached,false); assert.equal(await exists(p.dir),true); assert.equal(await readFile(join(mirror,'evidence'),'utf8'),'recover me'); assert.equal((await readIndex(cwd)).runs[0].runId,parent);
 } finally {await rm(cwd,{recursive:true,force:true});}
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
for(const change of ['opId','seq']) test(`DEP-01 ancestry tuple and canonical ledger: ${change}`,async()=>{
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
