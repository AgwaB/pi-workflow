import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as h from './unit-test-support.mjs';
import { validateDynamicDecision } from '../../.tmp/unit/dynamic-decision.js';
import { runDynamicDecisionPersistCall, normalizeDynamicFanoutPlanRequest } from '../../.tmp/unit/dynamic-control-ops.js';
import { runDynamicDecisionLoop } from '../../.tmp/unit/dynamic-decision-loop.js';
import { extractDynamicStateArtifact, assembleDynamicStateIndex } from '../../.tmp/unit/dynamic-state-index.js';
import { buildFanoutBranchPlanRequests } from '../../.tmp/unit/dynamic-loop-actions.js';

const decision = (round, actions, status = 'continue') => ({schema:'dynamic-decision-v1',decisionId:`decision-${round}`,round,phase:'round',status,nextActions:actions});
const work = (id, dependsOn) => ({type:'add_work_item',actionId:`add-${id}`,workItemId:id,prompt:`Research ${id}`, ...(dependsOn ? {dependsOn} : {})});
const loop = {verifier:{agent:'unit-scout',tools:['read']},synthesis:{agent:'unit-scout',tools:['read']},planner:{agent:'unit-scout',tools:['read'],outputProfile:'generic_summary_v1'},workerDefaults:{agent:'unit-scout',tools:['read'],outputProfile:'candidate_findings_v1'},allowedAgents:['unit-scout'],allowedTools:['read'],maxDecisionRounds:3,maxActionsPerRound:3};
async function fixture(t, controller, dynamic, helpers = {}) {
 const dir = await mkdtemp(join(tmpdir(), 'piwf-dynamic-regression-'));
 t.after(() => rm(dir, {recursive:true,force:true}));
 h.captureSubagentPrompts([]); h.writeAgent(dir,'unit-scout','read');
 const bundle=join(dir,'bundle'); await mkdir(bundle); await writeFile(join(bundle,'controller.mjs'),controller.replaceAll('$ROOT', dir));
 for (const [name, code] of Object.entries(helpers)) await writeFile(join(bundle,name),code.replaceAll('$ROOT',dir));
 const spec=h.artifactGraphWorkflowSpec({artifactGraph:{stages:[{id:'adaptive',type:'dynamic',dynamic:{uses:'./controller.mjs',...dynamic}}]}});
 const specPath=join(bundle,'spec.json'); await writeFile(specPath,JSON.stringify(spec));
 const compiled=await h.compileWorkflow(spec,{cwd:dir,task:'Local fake-only regression',specPath});
 const {run}=await h.createWorkflowRunRecord(dir,compiled,specPath); await h.writeStaticRunArtifacts(dir,run,compiled,spec); await h.writeRunRecord(dir,run);
 return {dir,run};
}
async function schedule(f) { await h.scheduleRun(f.dir,f.run.runId); return h.readRunRecord(f.dir,f.run.runId); }
async function finish(f,r,id,control) { await h.completeTask(f.dir,h.taskBySpec(r,`adaptive.${id}`),control); await h.writeRunRecord(f.dir,r); }

test('decision dependencies resolve ordered local work in every round and reject unsatisfiable references', () => {
 for (const prior of [[], ['adaptive.previous']]) {
  assert.equal(validateDynamicDecision(decision(1,[work('SOURCE'),work('followup',['SOURCE'])]),{requireAgent:false,knownGeneratedTaskIds:prior}).ok,true);
  for (const actions of [[work('a',['missing'])], [work('a',['b']),work('b')], [work('a',['a'])]])
   assert.equal(validateDynamicDecision(decision(1,actions),{requireAgent:false,knownGeneratedTaskIds:prior}).ok,false);
 }
});

test('executable IDs reject engine truncation, reserved IDs and prior-task collisions before fanout', () => {
 const prefix='x'.repeat(64);
 for (const actions of [[work(prefix+'a'),work(prefix+'b')],[work('controller')],[work('PREVIOUS')]])
  assert.equal(validateDynamicDecision(decision(1,actions),{requireAgent:false,knownGeneratedTaskIds:['adaptive.previous']}).ok,false);
 const branches=buildFanoutBranchPlanRequests({graph:{}},[work(prefix+'a'),work(prefix+'b')],0);
 assert.throws(()=>normalizeDynamicFanoutPlanRequest({round:0,decisionHash:'hash',branches}),/duplicate|collid/i);
});

test('invalid decision attempts retain immutable distinct event-linked raw and validation artifacts across replay', async t => {
 const cwd=await mkdtemp(join(tmpdir(),'piwf-decisions-')); t.after(()=>rm(cwd,{recursive:true,force:true}));
 const base={cwd,run:{runId:'workflow_invalid'},controllerTask:{specId:'adaptive.controller'}};
 const attempts=[1,2,3].map(n=>({...base,opId:`decision:${n}`,callIndex:n,rawDecision:{bad:`attempt-${n}`},context:{expectedRound:n===3?2:1}}));
 const values=[]; for(const attempt of attempts) values.push(await runDynamicDecisionPersistCall(attempt));
 assert.equal(new Set(values.map(v=>v.artifacts.raw)).size,3);
 assert.equal(new Set(values.map(v=>v.artifacts.validation)).size,3);
 await runDynamicDecisionPersistCall(attempts[0]);
 const events=await h.readDynamicEvents(cwd,'workflow_invalid'); assert.equal(events.length,3);
 for (const [i,event] of events.entries()) {
  assert.deepEqual(JSON.parse(await readFile(join(cwd,event.payload.paths.raw),'utf8')),attempts[i].rawDecision);
  assert.equal(JSON.parse(await readFile(join(cwd,event.payload.paths.validation),'utf8')).ok,false);
  assert.equal(event.payload.paths.raw,values[i].artifacts.raw);
 }
 await assert.rejects(runDynamicDecisionPersistCall({...attempts[0],rawDecision:{bad:'changed'}}),/request changed/);
});

test('controller deadline terminates late-started helper and persists terminal evidence before settlement', async t => {
 const f=await fixture(t,`export default async ctx => { await new Promise(r=>setTimeout(r,650)); await ctx.helper('slow'); return {control:{digest:'done'}}; };`,{budget:{maxRuntimeMs:1000},helpers:{slow:{uses:'./slow.mjs'}}},{'slow.mjs':`import {writeFile} from 'node:fs/promises'; export default async () => { await new Promise(r=>setTimeout(r,650)); await writeFile('$ROOT/late-marker','late'); return {ok:true}; };`});
 const r=await schedule(f); assert.equal(h.taskBySpec(r,'adaptive.controller').statusDetail,'dynamic_budget_blocked');
 const events=await h.readDynamicEvents(f.dir,r.runId);
 const started=events.find(e=>e.type==='helper.started'); assert.ok(started);
 const terminal=events.find(e=>e.type==='helper.cancelled');
 const ledger=JSON.stringify(events);
 await new Promise(r=>setTimeout(r,800));
 await assert.rejects(access(join(f.dir,'late-marker')), {code:'ENOENT'}, 'owned helper must not write a local marker after controller settlement');
 assert.ok(terminal,'helper must have durable cancellation at controller settlement');
 assert.equal(terminal.opId,started.opId); assert.equal(terminal.requestHash,started.requestHash);
 assert.equal(JSON.stringify(await h.readDynamicEvents(f.dir,r.runId)),ledger,'no post-settlement ledger writes');
});

test('later-round uppercase dependency chain and cross-round verification preserve finding provenance through real scheduler', async t => {
 const f=await fixture(t,'export default ctx => ctx.dynamic.runDecisionLoop();',{decisionLoop:loop});
 let r=await schedule(f);
 await finish(f,r,'decide-r0',decision(0,[work('research')])); r=await schedule(f);
 await finish(f,r,'research',{findings:[{id:'F1',title:'Actual finding',severity:'high',confidence:'high',evidenceRefs:['source.ts:1']}]}); r=await schedule(f);
 await finish(f,r,'decide-r1',decision(1,[work('SOURCE'),work('followup',['SOURCE']),{type:'verify',actionId:'verify-F1',targetFindingId:'F1',prompt:'Verify F1'}])); r=await schedule(f);
 assert.ok(h.taskBySpec(r,'adaptive.source'));
 await finish(f,r,'source',{findings:[]}); r=await schedule(f);
 await finish(f,r,'followup',{findings:[]}); r=await schedule(f);
 assert.ok(r.tasks.some(task=>task.specId==='adaptive.verify-f1'),JSON.stringify(r.tasks.map(task=>({id:task.specId,status:task.status,message:task.lastMessage}))));
 await finish(f,r,'verify-f1',{findingId:'F1',verdict:'verified',confidence:'high',claimSupports:[{claim:'Actual finding',status:'supports',sourceLocators:['source.ts:1']}]}); r=await schedule(f);
 const events=await h.readDynamicEvents(f.dir,r.runId);
 const indexEvent=events.filter(e=>e.type==='state-index.persisted').at(-1);
 const index=JSON.parse(await readFile(join(f.dir,indexEvent.payload.paths.index),'utf8'));
 assert.equal(index.findings.length,1); assert.equal(index.findings[0].id,'F1');
 assert.equal(index.findings[0].verificationStatus,'verified');
 assert.deepEqual(index.findings[0].sourceTaskIds,['adaptive.research','adaptive.verify-f1']);
 assert.ok(!index.blockers.some(b=>b.message.includes('unknown finding')));
 const extracts=JSON.parse(await readFile(join(f.dir,indexEvent.payload.paths.extracts),'utf8'));
 assert.match(JSON.stringify(extracts),/adaptive.research/); assert.match(JSON.stringify(extracts),/source.ts:1/); assert.match(JSON.stringify(extracts),/adaptive.verify-f1/);
 await finish(f,r,'decide-r2',decision(2,[{type:'synthesize',actionId:'final',prompt:'Finish'}],'synthesize')); r=await schedule(f);
 await finish(f,r,'final',{summary:'Done'}); r=await schedule(f);
 assert.equal(h.taskBySpec(r,'adaptive.controller').status,'completed');
 const state=await h.readOrRebuildDynamicState(f.dir,r.runId);
 assert.ok(state.controllers['adaptive.controller'].branches.every(b=>b.status!=='planned'));
});

test('cross-round verification joins original candidate and retains both source identities', async () => {
 const controls={research:{findings:[{id:'F1',title:'Finding',severity:'high',confidence:'high',evidenceRefs:['source.ts:1']}]},'verify-f1':{findingId:'F1',verdict:'verified',confidence:'high',claimSupports:[{claim:'Finding',status:'supports',sourceLocators:['source.ts:1']}]}};
 const decisions=[decision(0,[work('research')]),decision(1,[{type:'verify',actionId:'verify-f1',targetFindingId:'F1',prompt:'Verify'}]),decision(2,[{type:'synthesize',actionId:'final',prompt:'Finish'}],'synthesize')];
 const indexes=[];
 await runDynamicDecisionLoop({task:'Local',graph:{generatedTaskIds:()=>[]},dynamic:{config:()=>({...loop,allowedOutputProfiles:['candidate_findings_v1','verification_result_v1','synthesis_v1'],repair:{maxAttempts:2},stateIndex:{maxFindings:40},stopPolicy:{maxStalls:3}})},decision:{validateAndPersist:async(d,c)=>{const result=validateDynamicDecision(d,c);return {...result,decisionHash:result.hash};}},agent:async r=>r.profile==='planner'?{control:decisions[Number(/decide-r(\d+)/.exec(r.id)[1])]}:{specId:`adaptive.${r.id}`,status:'completed'},stateIndex:{extractAndPersist:async request=>{const index=assembleDynamicStateIndex(request.tasks.map(task=>extractDynamicStateArtifact({taskId:task.taskId,outputProfile:task.outputProfile,control:controls[task.taskId.split('.').at(-1)]})));indexes.push(index);return {index,digest:index.digest};}}});
 assert.equal(indexes[1].findings.length,1);
 assert.equal(indexes[1].findings[0].verificationStatus,'verified');
 assert.deepEqual(indexes[1].findings[0].sourceTaskIds,['adaptive.research','adaptive.verify-f1']);
 assert.ok(!indexes[1].blockers.some(b=>b.message.includes('unknown finding')));
});

test('first-round uppercase predecessor completes every accepted branch', async t => {
 const f=await fixture(t,'export default ctx => ctx.dynamic.runDecisionLoop();',{decisionLoop:{...loop,maxDecisionRounds:1}});
 let r=await schedule(f); await finish(f,r,'decide-r0',decision(0,[work('SOURCE'),work('followup',['SOURCE'])])); r=await schedule(f);
 await finish(f,r,'source',{findings:[]}); r=await schedule(f); await finish(f,r,'followup',{findings:[]}); r=await schedule(f);
 assert.equal(h.taskBySpec(r,'adaptive.controller').status,'completed');
 const events=await h.readDynamicEvents(f.dir,r.runId);
 const plan=events.find(e=>e.type==='fanout.planned');
 for (const branch of plan.payload.branches) assert.ok(events.some(e=>e.type==='task.generated'&&e.payload.branchId===branch.branchId&&e.requestHash===branch.requestHash));
});

test('custom controller cannot report success with an unresolvable exported output ID', async t => {
 for (const key of ['outputTasks','outputTaskIds']) {
  const f=await fixture(t,`export default () => ({control:{status:'synthesized',${key}:['adaptive.missing']}});`,{});
  const r=await schedule(f); const controller=h.taskBySpec(r,'adaptive.controller');
  assert.equal(controller.status,'blocked'); assert.match(controller.lastMessage,/export.*adaptive.missing/);
 }
});

test('truncation collision takes bounded planner repair without partial accepted generation', async t => {
 const f=await fixture(t,'export default ctx => ctx.dynamic.runDecisionLoop();',{decisionLoop:loop});
 let r=await schedule(f); const prefix='x'.repeat(64);
 await finish(f,r,'decide-r0',decision(0,[work(prefix+'a'),work(prefix+'b')])); r=await schedule(f);
 const events=await h.readDynamicEvents(f.dir,r.runId);
 assert.equal(events.find(e=>e.type==='decision.persisted').payload.ok,false);
 assert.ok(!events.some(e=>e.type==='fanout.planned'));
 assert.ok(!r.tasks.some(task=>task.specId===`adaptive.${prefix}`));
 assert.notEqual(h.taskBySpec(r,'adaptive.controller').status,'failed');
 assert.ok(r.tasks.some(task=>/repair/.test(task.specId)));
});
