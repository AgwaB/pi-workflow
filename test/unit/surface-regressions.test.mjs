import assert from 'node:assert/strict';
import test from 'node:test';
import fsPromises, { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { readFileLinesBounded, WorkflowView } from '../../.tmp/unit/workflow-view.js';
import workflowExtension, { parseWorkflowRunArgs, parseWorkflowDynamicArgs, registerWorkflowNaturalLanguageTools, deliverMissedWorkflowFeedback } from '../../.tmp/unit/extension.js';
import * as usage from '../../.tmp/unit/workflow-parent-usage.js';
import * as store from '../../.tmp/unit/store.js';
import { parseWorkflow } from '../../.tmp/unit/schema.js';
import { compileWorkflow } from '../../.tmp/unit/compiler.js';
import { formatLogs } from '../../.tmp/unit/engine-format.js';

async function project(t) { const cwd = await mkdtemp(join(tmpdir(), 'surface-regression-')); t.after(() => rm(cwd, {recursive:true, force:true})); return cwd; }
async function index(cwd, runs) { await mkdir(join(cwd,'.pi/workflows'),{recursive:true}); await writeFile(join(cwd,'.pi/workflows/index.json'),JSON.stringify({schemaVersion:1,updatedAt:new Date().toISOString(),runs})); }
const message = (n, timestamp) => ({role:'assistant',timestamp,usage:{totalTokens:n}});
const cli = (cwd, args) => spawnSync(process.execPath,[resolve('src/cli.mjs'),...args],{cwd,encoding:'utf8',timeout:15000});
async function child(code) { return new Promise((res,rej)=>{const p=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']});let err='';p.stderr.on('data',s=>err+=s);p.on('error',rej);p.on('exit',n=>n===0?res():rej(new Error(err||`exit ${n}`)));}); }

test('ownership survives separate processes; same-session concurrent deltas and replay are not lost', async t => {
 const cwd=await project(t), runId='workflow_owner'; await index(cwd,[{runId,status:'running'}]);
 const mod=JSON.stringify(resolve('.tmp/unit/workflow-parent-usage.js'));
 const run=async(owner,n,id,begin=false)=>child(`const u=await import(${mod});const cwd=${JSON.stringify(cwd)};${begin?'await u.beginParentUsageTracking(cwd,"workflow_owner",'+JSON.stringify(owner)+');':'await u.resumeParentUsageTracking(cwd,'+JSON.stringify(owner)+');'}await u.recordParentSessionUsage(cwd,${JSON.stringify(message(n,id))},${JSON.stringify(owner)});`);
 await run('A',10,1,true); await run('B',777,2);
 assert.equal((await usage.readParentUsage(cwd,runId)).totalTokens,10);
 await Promise.all([run('A',20,3),run('A',30,4)]); await run('A',20,3);
 assert.equal((await usage.readParentUsage(cwd,runId)).totalTokens,60);
});

test('owner-less historical sidecars are readable but never claimed by a new session',async t=>{
 const cwd=await project(t),runId='workflow_legacy';await index(cwd,[{runId,status:'running'}]);await mkdir(store.workflowRunDir(cwd,runId),{recursive:true});
 await writeFile(join(store.workflowRunDir(cwd,runId),'parent-usage.json'),JSON.stringify({schema:'workflow-parent-usage-v1',runId,source:'parent-session',assistantMessages:1,totalTokens:10}));
 await usage.resumeParentUsageTracking(cwd,'new-owner');await usage.recordParentSessionUsage(cwd,message(777,2),'new-owner');
 assert.equal((await usage.readParentUsage(cwd,runId)).totalTokens,10);
});

test('8MiB single-line preview has a hard IO and returned-text bound',async t=>{
 const cwd=await project(t);await writeFile(join(cwd,'big.log'),'X'.repeat(8*1024*1024));let bytes=0;
 const started=performance.now();const lines=await readFileLinesBounded(cwd,'big.log',1000,{onRead:n=>bytes+=n});
 t.diagnostic(JSON.stringify({fixtureBytes:8*1024*1024,bytesRead:bytes,returnedBytes:Buffer.byteLength(lines.join('\n')),elapsedMs:performance.now()-started}));
 assert.ok(bytes<=256*1024,`read ${bytes} bytes`);assert.ok(Buffer.byteLength(lines.join('\n'))<=256*1024);assert.match(lines.join('\n'),/truncat|omitted/i);
 await writeFile(join(cwd,'invalid-utf8.log'),Buffer.concat(Array.from({length:900},()=>Buffer.concat([Buffer.alloc(200,255),Buffer.from('\n')]))));
 const invalid=await readFileLinesBounded(cwd,'invalid-utf8.log',1000);assert.ok(Buffer.byteLength(invalid.join('\n'))<=256*1024);assert.match(invalid.join('\n'),/truncated/);
 assert.deepEqual(await readFileLinesBounded(cwd,'big.log',0.5),[]);
});

test('preview reverse completion and disposal cannot commit stale task data',async t=>{
 const cwd=await project(t), pending=new Map();
 for(const name of ['Ao','Ap','Bo','Bp']) await writeFile(join(cwd,name),name.startsWith('A')?'A':'B');
 const originalOpen=fsPromises.open;
 t.mock.method(fsPromises,'open',(path,...args)=>String(path).startsWith(cwd)?new Promise(r=>pending.set(String(path).split('/').at(-1),()=>r(originalOpen(path,...args)))):originalOpen(path,...args));
 syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 const view=new WorkflowView(cwd,{requestRender(){}},{},()=>{});
 view.mode='task';view.detailRun={runId:'workflow_ui',type:'legacy',tasks:['A','B'].map(taskId=>({taskId,status:'completed',files:{output:taskId+'o',taskPrompt:taskId+'p'}}))};
 const a=view.updateTaskPreviews();view.selectedTask=1;const b=view.updateTaskPreviews();
 await new Promise(r=>setTimeout(r,20));
 assert.ok(pending.has('Bo'),'filesystem reader receives selected task');
 pending.get('Bo')();pending.get('Bp')();await b;pending.get('Ao')();pending.get('Ap')();await a;
 assert.deepEqual(view.outputLines,['B']);
 await writeFile(join(cwd,'Ao'),'late');await writeFile(join(cwd,'Ap'),'late');
 view.selectedTask=0;const closing=view.updateTaskPreviews();await new Promise(r=>setTimeout(r,20));view.dispose();pending.get('Ao')();pending.get('Ap')();await closing;assert.notDeepEqual(view.outputLines,['late']);
});

test('slash options fail closed and command whitespace is consistent',()=>{
 for(const option of ['--model','--profile','--thinking','--reasoning','--model=','--profile=','--typo']) assert.throws(()=>parseWorkflowRunArgs(`run deep-research "task" ${option}`),/option|value|Unsupported|Unknown/i,option);
 assert.throws(()=>parseWorkflowRunArgs('run deep-research "task" --model --detach'),/value/i);
 assert.throws(()=>parseWorkflowDynamicArgs('dynamic --profile high "task"'),/profile.*support|support.*profile/i);
 for(const space of ['\t','\n',' ']) {
  assert.equal(parseWorkflowRunArgs(`run${space}deep-research "task"`).specPath,'deep-research');
  assert.equal(parseWorkflowDynamicArgs(`dynamic${space}"task"`).task,'task');
 }
 assert.equal(parseWorkflowRunArgs('run deep-research "literal --unknown text"').task,'literal --unknown text');
 assert.throws(()=>parseWorkflowRunArgs('run deep-research "unterminated'),/Unterminated/);
});

test('actual CLI rejects invalid numeric and unknown options before store access',async t=>{
 const cwd=await project(t);
 for(const args of [['supervise','--all','--poll-ms'],['supervise','--all','--max-runtime-ms','garbage'],['supervise','--all','--max-runtime-ms','Infinity'],['supervise','--all','--poll-ms','1.5'],['supervise','--all','--poll-ms','-1'],['supervise','--all','--poll-ms',''],['supervise','--all','workflow_x'],['inspect','workflow_x','--typo'],['prune','--keep',''],['prune','--older-than',' '],['prune','--keep','9007199254740992']]) {
 const result=cli(cwd,args);assert.equal(result.status,1);assert.match(result.stderr,/requires|argument|option|cannot|exclusive/i,result.stderr);
 }
});

async function localRun(cwd, behavior='throw new Error("local failure")', dynamic=false) {
 const specPath=join(cwd,'spec.json');await writeFile(join(cwd,'helper.mjs'),`export default async()=>{${behavior}}`);
 const spec=parseWorkflow({schemaVersion:1,name:'local-only',artifactGraph:{stages:[dynamic ? {id:'fixture',type:'dynamic',dynamic:{uses:'./helper.mjs',permissions:{approval:'ask'}}} : {id:'fixture',support:{uses:'./helper.mjs'}}]}});await writeFile(specPath,JSON.stringify(spec));
 const compiled=await compileWorkflow(spec,{cwd,specPath,task:'local support only'});const {run}=await store.createWorkflowRunRecord(cwd,compiled,specPath);await store.writeStaticRunArtifacts(cwd,run,compiled,spec);await store.writeRunRecord(cwd,run);return run;
}

test('actual scheduler failed supervise --all is nonzero',async t=>{
 const cwd=await project(t),run=await localRun(cwd);const result=cli(cwd,['supervise','--all','--max-runtime-ms','5000']);assert.equal((await store.readRunRecord(cwd,run.runId)).status,'failed');assert.equal(result.status,1,result.stdout+result.stderr);
});

test('actual scheduler blocked supervise --all exits 2; mixed failure takes precedence',async t=>{
 const cwd=await project(t);const run=await localRun(cwd,'throw new Error("must not run without approval")',true);
 const result=cli(cwd,['supervise','--all','--max-runtime-ms','5000']);
 assert.equal((await store.readRunRecord(cwd,run.runId)).status,'blocked');assert.equal(result.status,2,result.stdout+result.stderr);
 const mixed=await project(t);await localRun(mixed,'throw new Error("must not run without approval")',true);await localRun(mixed);
 assert.equal(cli(mixed,['supervise','--all','--max-runtime-ms','5000']).status,1);
});

test('supervise completed/empty batches succeed and historical failures do not contaminate later batches',async t=>{
 const cwd=await project(t);assert.equal(cli(cwd,['supervise','--all']).status,0);
 await localRun(cwd);assert.equal(cli(cwd,['supervise','--all']).status,1);
 await localRun(cwd,'return {control:{},analysis:"done",refs:[]}');
 const result=cli(cwd,['supervise','--all','--max-runtime-ms','5000']);assert.equal(result.status,0,result.stdout+result.stderr);
});

test('formatLogs uses bounded tail IO for huge single-line output',async t=>{
 const cwd=await project(t),run=await localRun(cwd);cli(cwd,['supervise','--all']);
 await writeFile(join(cwd,run.tasks[0].files.output),'X'.repeat(8*1024*1024));
 const text=await formatLogs(cwd,run.runId,run.tasks[0].taskId);assert.ok(Buffer.byteLength(text)<256*1024);assert.match(text,/truncated/i);
});

test('RPC hasUI without custom rendering emits the board fallback',async t=>{
 const cwd=await project(t),sent=[];let handler;workflowExtension({on(){},registerTool(){},registerCommand(_name,command){handler=command.handler;}});await handler('',{cwd,hasUI:true,mode:'rpc',ui:{notify:(text)=>sent.push(text),custom:async()=>undefined}});
 assert.ok(sent.some(s=>/workflow|runs/i.test(s)));
});

test('workflow_list execution bounds huge metadata and provides actionable continuation',async t=>{
 const cwd=await project(t);const previousAgent=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=join(cwd,'agent');t.after(()=>{if(previousAgent===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previousAgent;});await mkdir(join(cwd,'workflows'),{recursive:true});
 for(let i=0;i<80;i++) await writeFile(join(cwd,'workflows',`catalog-${i}.json`),JSON.stringify({schemaVersion:1,name:`catalog-${i}`,description:'X'.repeat(100000),artifactGraph:{stages:[{id:'fixture',support:{uses:'./helper.mjs'}}]}}));
 let tool;registerWorkflowNaturalLanguageTools({registerTool:t=>{if(t.name==='workflow_list')tool=t;}},{PI_WORKFLOW_ROLE:'parent'});
 for(const params of [{offset:-1},{offset:null},{limit:Infinity},{limit:0},{limit:21},{query:42},{unknown:true}]) await assert.rejects(()=>tool.execute('invalid',params,undefined,undefined,{cwd}),/workflow_list/);
 const result=await tool.execute('call',{},undefined,undefined,{cwd});const text=result.content[0].text;
 assert.match(text,/catalog-/);assert.ok(result.details.workflows.length>0);
 assert.ok(Buffer.byteLength(text)<=50*1024);assert.ok(text.split('\n').length<=2000);assert.match(text,/omitted/i);assert.match(text,/offset|query|read .*spec/i);
 const next=await tool.execute('next',{offset:result.details.nextOffset,query:'catalog-'},undefined,undefined,{cwd});assert.ok(next.details.workflows.length>0);assert.notEqual(next.details.workflows[0].name,result.details.workflows[0].name);
});

test('catch-up delivery cap excludes foreign runs',async t=>{
 const cwd=await project(t),runs=[];
 for(let i=0;i<7;i++){const run=await localRun(cwd);run.status='failed';for(const task of run.tasks)task.status='failed';await store.writeRunRecord(cwd,run);await writeFile(join(store.workflowRunDir(cwd,run.runId),'feedback-audience.json'),JSON.stringify({schema:'workflow-feedback-audience-v1',runId:run.runId,sessionId:i===0?'owner':'other'}));runs.push(run);}
 await store.updateIndex(cwd);const sent=[];const ctx={cwd,hasUI:true,mode:'rpc',isIdle:()=>true,sessionManager:{getSessionId:()=> 'owner'},ui:{notify(){}}};
 await deliverMissedWorkflowFeedback(ctx,{sendMessage:(m)=>sent.push(m)});assert.equal(sent.length,1);
});

test('catch-up cap counts deliveries rather than five existing receipts',async t=>{
 const cwd=await project(t);const runs=[];
 for(let i=0;i<6;i++){const run=await localRun(cwd);run.status='failed';for(const task of run.tasks)task.status='failed';await store.writeRunRecord(cwd,run);await writeFile(join(store.workflowRunDir(cwd,run.runId),'feedback-audience.json'),JSON.stringify({schema:'workflow-feedback-audience-v1',runId:run.runId,sessionId:'owner'}));runs.push(run);}
 await store.updateIndex(cwd);
 const ctx={cwd,hasUI:true,mode:'rpc',isIdle:()=>true,sessionManager:{getSessionId:()=> 'owner'},ui:{notify(){}}};const sent=[];
 await deliverMissedWorkflowFeedback(ctx,{sendMessage:m=>sent.push(m)});assert.equal(sent.length,5);
 await deliverMissedWorkflowFeedback(ctx,{sendMessage:m=>sent.push(m)});assert.equal(sent.length,6);
 await deliverMissedWorkflowFeedback(ctx,{sendMessage:m=>sent.push(m)});assert.equal(sent.length,6);
});

test('owner usage persists before the first turn, flushes on detach, and retains finalized totals on resume',async t=>{
 const cwd=await project(t),runId='workflow_resume';await index(cwd,[{runId,status:'running'}]);
 usage.beginParentUsageTracking(cwd,runId,'owner');await usage.flushParentUsageTracking(cwd,'owner',true);
 assert.equal((await usage.readParentUsage(cwd,runId)).sessionId,'owner');
 await usage.resumeParentUsageTracking(cwd,'owner');await usage.recordParentSessionUsage(cwd,message(10,1),'owner');
 await index(cwd,[{runId,status:'completed'}]);await usage.recordParentSessionUsage(cwd,message(20,2),'owner');
 await index(cwd,[{runId,status:'running'}]);await usage.resumeParentUsageTracking(cwd,'owner');await usage.recordParentSessionUsage(cwd,message(30,3),'owner');
 await usage.flushParentUsageTracking(cwd,'owner',true);await usage.recordParentSessionUsage(cwd,message(777,4),'owner');
 assert.equal((await usage.readParentUsage(cwd,runId)).totalTokens,60);
});

test('durable feedback audience rejects a conflicting explicit usage owner',async t=>{
 const cwd=await project(t),runId='workflow_conflict';await index(cwd,[{runId,status:'running'}]);await mkdir(store.workflowRunDir(cwd,runId),{recursive:true});
 await writeFile(join(store.workflowRunDir(cwd,runId),'feedback-audience.json'),JSON.stringify({schema:'workflow-feedback-audience-v1',runId,sessionId:'owner'}));
 usage.beginParentUsageTracking(cwd,runId,'other');await usage.recordParentSessionUsage(cwd,message(777,1),'other');await usage.flushParentUsageTracking(cwd,'other',true);
 assert.equal(await usage.readParentUsage(cwd,runId),undefined);
});

test('board preserves selected run identity on refresh/re-sort',async t=>{
 const cwd=await project(t),first=await localRun(cwd),second=await localRun(cwd);
 first.updatedAt='2026-01-01T00:00:00.000Z';second.updatedAt='2026-01-02T00:00:00.000Z';await store.writeRunRecord(cwd,first);await store.writeRunRecord(cwd,second);await store.updateIndex(cwd);
 const view=new WorkflowView(cwd,{requestRender(){}},{},()=>{});t.after(()=>view.dispose());await view.reload(true);
 const selected=view.flows[view.selectedFlow].runId;
 const other=selected===first.runId?second:first;other.updatedAt='2099-01-01T00:00:00.000Z';await store.writeRunRecord(cwd,other);await store.updateIndex(cwd);await view.reload(true);
 assert.equal(view.flows[view.selectedFlow].runId,selected);assert.equal(view.detailRun.runId,selected);
});

test('canonical skipped dependent stage is shown as skipped, not interrupted',async t=>{
 const cwd=await project(t),specPath=join(cwd,'spec.json');await writeFile(join(cwd,'helper.mjs'),'export default async()=>{throw new Error("upstream failure")}');
 const spec=parseWorkflow({schemaVersion:1,name:'skip-fixture',artifactGraph:{stages:[{id:'upstream',support:{uses:'./helper.mjs'}},{id:'dependent',after:'upstream',support:{uses:'./helper.mjs'}}]}});await writeFile(specPath,JSON.stringify(spec));
 const compiled=await compileWorkflow(spec,{cwd,specPath,task:'local failure dependency'});const {run}=await store.createWorkflowRunRecord(cwd,compiled,specPath);await store.writeStaticRunArtifacts(cwd,run,compiled,spec);await store.writeRunRecord(cwd,run);
 cli(cwd,['supervise','--all']);const final=await store.readRunRecord(cwd,run.runId);assert.equal(final.status,'failed');assert.equal(final.tasks.find(task=>task.stageId==='dependent').status,'skipped');
 const view=new WorkflowView(cwd,{requestRender(){}},{},()=>{});t.after(()=>view.dispose());await view.reload(true);view.mode='stages';view.selectedStage=1;
 const lines=view.render(140).join('\n');assert.match(lines,/\[SKIPPED\]/);
 assert.equal(cli(cwd,['inspect',run.runId]).stdout.includes('completion: incomplete'),true);
});

test('hidden artifact views do no IO; unchanged visible previews reuse file identity cache',async t=>{
 const cwd=await project(t);for(const name of ['output','prompt'])await writeFile(join(cwd,name),name);
 const original=fsPromises.open;let reads=0;t.mock.method(fsPromises,'open',(...args)=>{if(String(args[0]).startsWith(cwd))reads++;return original(...args);});syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 const view=new WorkflowView(cwd,{requestRender(){}},{},()=>{});t.after(()=>view.dispose());view.detailRun={runId:'workflow_cache',type:'legacy',tasks:[{taskId:'a',status:'completed',files:{output:'output',taskPrompt:'prompt'}}]};
 await view.updateTaskPreviews();assert.equal(reads,0);
 view.mode='task';await view.updateTaskPreviews();assert.equal(reads,2);await view.updateTaskPreviews();assert.equal(reads,2);
 await writeFile(join(cwd,'output'),'changed');await view.updateTaskPreviews();assert.equal(reads,3);assert.deepEqual(view.outputLines,['changed']);
});

