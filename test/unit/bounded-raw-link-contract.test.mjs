import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, link, unlink, rename, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeWorkflowTaskArtifactBundle, setTaskArtifactLinkForTests, setWorkflowOutputArtifactWriteHookForTests } from '../../.tmp/unit/workflow-output-artifacts.js';
import { readWorkflowArtifact, handleWorkflowArtifactToolCall, setArtifactValidatedHookForTests, setArtifactReadHookForTests } from '../../.tmp/unit/workflow-artifact-tool.js';
import { checkRequiredArtifactReads } from '../../.tmp/unit/subagent-backend.js';

const raw = '<control>{"schema":"stage-control-v1","digest":"done"}</control>\n<analysis>Evidence é 🎯</analysis>\n<refs>[]</refs>';
async function fixture(t, legacy = false) {
 const root = await mkdtemp(join(tmpdir(), 'bounded-raw-'));
 t.after(() => rm(root, {recursive:true,force:true}));
 t.after(() => { setTaskArtifactLinkForTests(undefined); setArtifactValidatedHookForTests(undefined); setArtifactReadHookForTests(undefined); setWorkflowOutputArtifactWriteHookForTests(undefined); });
 const runId='owned', taskId='task-1', runDir=join(root,'.pi','workflows',runId), taskDir=join(runDir,'tasks',taskId), consumer=join(runDir,'tasks','task-2');
 await mkdir(taskDir,{recursive:true}); await mkdir(consumer,{recursive:true});
 const output=join(taskDir,'output.log'), artifact=join(taskDir,'raw.md');
 const run={schemaVersion:1,runId,createdAt:'2026-09-05T00:00:00.000Z',tasks:[{taskId,specId:'producer',cwd:root,status:'completed',files:{output,result:join(taskDir,'result.json')}}]};
 await writeFile(join(runDir,'run.json'),JSON.stringify(run)); await writeFile(output,raw);
 if (legacy) {
  await link(output,artifact);
  await writeFile(join(taskDir,'result.json'),JSON.stringify({schema:'workflow-task-result-v1',artifacts:{raw:'raw.md'},outputValidation:{valid:true}}));
 } else {
  const bundle=await writeWorkflowTaskArtifactBundle({taskDir,rawOutput:raw});
  run.tasks[0].rawArtifactIntegrity=bundle.result.rawIntegrity;
  await writeFile(join(runDir,'run.json'),JSON.stringify(run));
 }
 const manifest={schema:'workflow-source-manifest-v1',runId,taskId:'task-2',sources:[{source:'producer',taskId,status:'completed',artifacts:{raw:{path:artifact}}}]};
 const config={runId,taskId:'task-2',runDir,manifestPath:join(consumer,'source-manifest.json'),ledgerPath:join(consumer,'read-ledger.jsonl')};
 await writeFile(config.manifestPath,JSON.stringify(manifest));
 const read=(opts={})=>readWorkflowArtifact(manifest,'producer','raw',{runDir,...opts});
 return {root,run,runDir,taskDir,consumer,output,artifact,manifest,config,read};
}
for (const legacy of [true,false]) test(`bounded owned ${legacy?'legacy':'new'} two-link full/truncated reads and requiredReads`,async t=>{
 const f=await fixture(t,legacy); assert.equal((await stat(f.artifact)).nlink,2);
 const full=await f.read({maxBytes:4096}); assert.equal(full.content,raw); assert.equal(full.bytes,Buffer.byteLength(raw)); assert.equal(full.returnedBytes,full.bytes); assert.equal(full.truncated,false);
 const prefix=await f.read({maxBytes:20}); assert.equal(prefix.content,raw.slice(0,20)); assert.equal(prefix.returnedBytes,20); assert.equal(prefix.truncated,true);
 await handleWorkflowArtifactToolCall({action:'read',source:'producer',artifact:'raw'},{...f.config,maxBytes:20});
 assert.deepEqual((await checkRequiredArtifactReads(f.consumer,['producer.raw'])).missing,['producer.raw']);
 await handleWorkflowArtifactToolCall({action:'read',source:'producer',artifact:'raw'},f.config);
 assert.deepEqual((await checkRequiredArtifactReads(f.consumer,['producer.raw'])).missing,[]);
});
for (const kind of ['extra-link','foreign-source','foreign-task','foreign-run','output-substitution','late-link','late-output-substitution','generation-change','root-symlink','task-symlink']) test(`bounded raw rejects ${kind}`,async t=>{
 const f=await fixture(t);
 assert.equal((await f.read()).content,raw, 'negative control begins with accepted new evidence');
 if(kind==='extra-link') await link(f.artifact,join(f.root,'unaccounted'));
 if(kind==='foreign-source') {f.run.tasks[0].specId='foreign';await writeFile(join(f.runDir,'run.json'),JSON.stringify(f.run));}
 if(kind==='foreign-task') f.manifest.sources[0].taskId='task-2';
 if(kind==='foreign-run') f.manifest.runId='foreign';
 if(kind==='output-substitution') { await unlink(f.output); await writeFile(f.output,raw); await link(f.artifact,join(f.root,'foreign')); }
 if(kind==='late-link') setArtifactValidatedHookForTests(()=>link(f.artifact,join(f.root,'late')));
 if(kind==='late-output-substitution') setArtifactValidatedHookForTests(async()=>{await unlink(f.output); await writeFile(f.output,raw); await link(f.artifact,join(f.root,'replacement'));});
 if(kind==='generation-change') setArtifactValidatedHookForTests(async()=>{f.run.tasks[0].generation=2; await writeFile(join(f.runDir,'run.json'),JSON.stringify(f.run));});
 if(kind==='root-symlink') {const moved=join(f.root,'moved'); await rename(join(f.root,'.pi','workflows'),moved); await symlink(moved,join(f.root,'.pi','workflows'));}
 if(kind==='task-symlink') {const moved=join(f.root,'moved'); await rename(f.taskDir,moved); await symlink(moved,f.taskDir);}
 await assert.rejects(f.read);
});
for(const phase of ['before','after']) test(`new linked publication source mutation ${phase} falls back to authoritative bytes`,async t=>{
 const f=await fixture(t); await unlink(f.artifact);
 setWorkflowOutputArtifactWriteHookForTests(async event=>{if(event.file===f.artifact&&event.phase===phase){setWorkflowOutputArtifactWriteHookForTests(undefined);await writeFile(f.output,'changed');}});
 await writeWorkflowTaskArtifactBundle({taskDir:f.taskDir,rawOutput:raw});
 assert.equal(await readFile(f.artifact,'utf8'),raw); assert.equal((await stat(f.artifact)).nlink,1);
 assert.equal((await f.read()).content,raw);
});
test('new linked raw detects later mutation including truncated and cached reads',async t=>{
 const f=await fixture(t); assert.equal((await stat(f.artifact)).nlink,2);
 await handleWorkflowArtifactToolCall({action:'read',source:'producer',artifact:'raw'},f.config);
 await writeFile(f.output,raw.replace('Evidence','Tampered'));
 await assert.rejects(()=>f.read({maxBytes:1}),/integrity/);
 await assert.rejects(()=>handleWorkflowArtifactToolCall({action:'read',source:'producer',artifact:'raw'},f.config),/integrity/);
});
for (const kind of ['late-byte-mutation','late-link','late-source-substitution','late-root-generation']) test(`post-read validation rejects ${kind} without a ledger row`,async t=>{
 const f=await fixture(t);
 assert.equal((await f.read()).content,raw, 'post-read control begins with accepted evidence');
 setArtifactReadHookForTests(async()=>{
  if(kind==='late-byte-mutation') await writeFile(f.output,raw.replace('Evidence','Tampered'));
  if(kind==='late-link') await link(f.artifact,join(f.root,'extra'));
  if(kind==='late-source-substitution'){await unlink(f.output);await writeFile(f.output,raw);await link(f.artifact,join(f.root,'foreign'));}
  if(kind==='late-root-generation'){f.run.tasks[0].generation=99;await writeFile(join(f.runDir,'run.json'),JSON.stringify(f.run));}
 });
 await assert.rejects(()=>handleWorkflowArtifactToolCall({action:'read',source:'producer',artifact:'raw'},f.config));
 assert.deepEqual((await checkRequiredArtifactReads(f.consumer,['producer.raw'])).missing,['producer.raw']);
});
for(const kind of ['generation','remove-integrity','replace-integrity','invalid-owner-snapshot']) test(`new evidence cannot downgrade via ${kind}`,async t=>{
 const f=await fixture(t);
 const resultPath=join(f.taskDir,'result.json'),result=JSON.parse(await readFile(resultPath,'utf8'));
 if(kind==='generation') {f.run.tasks[0].generation=2;await writeFile(join(f.runDir,'run.json'),JSON.stringify(f.run));}
 if(kind==='remove-integrity') {delete result.rawIntegrity;await writeFile(resultPath,JSON.stringify(result));}
 if(kind==='replace-integrity') {result.rawIntegrity.sha256='0'.repeat(64);await writeFile(resultPath,JSON.stringify(result));}
 if(kind==='invalid-owner-snapshot') {await unlink(f.output);await writeFile(f.output,raw);f.run.tasks[0].files.output=join(f.root,'foreign');await writeFile(join(f.runDir,'run.json'),JSON.stringify(f.run));}
 await assert.rejects(f.read);
});
test('a new owned generation reads exact new bytes while the prior manifest is rejected',async t=>{
 const f=await fixture(t),next=raw.replace('Evidence','New evidence');
 await unlink(f.artifact);await writeFile(f.output,next);
 f.run.tasks[0].generation=1;delete f.run.tasks[0].rawArtifactIntegrity;
 await writeFile(join(f.runDir,'run.json'),JSON.stringify(f.run));
 const bundle=await writeWorkflowTaskArtifactBundle({taskDir:f.taskDir,rawOutput:next});
 f.run.tasks[0].rawArtifactIntegrity=bundle.result.rawIntegrity;
 await writeFile(join(f.runDir,'run.json'),JSON.stringify(f.run));
 await assert.rejects(f.read);
 f.manifest.sources[0].generation=1;
 const read=await f.read();assert.equal(read.content,next);assert.equal(read.bytes,Buffer.byteLength(next));assert.equal(read.truncated,false);assert.equal((await stat(f.artifact)).nlink,2);
});
test('writer source-inode substitution before link cannot publish substituted bytes',async t=>{
 const f=await fixture(t);await unlink(f.artifact);
 setTaskArtifactLinkForTests(async()=>{await unlink(f.output);await writeFile(f.output,raw.replace('Evidence','Tampered'));});
 await writeWorkflowTaskArtifactBundle({taskDir:f.taskDir,rawOutput:raw});
 assert.equal(await readFile(f.artifact,'utf8'),raw);assert.equal((await stat(f.artifact)).nlink,1);
});
test('writer aborts rather than falling back through a substituted task directory',async t=>{
 const f=await fixture(t);await unlink(f.artifact);
 setTaskArtifactLinkForTests(async()=>{await rename(f.taskDir,f.taskDir+'-old');await mkdir(f.taskDir);await writeFile(f.output,raw);});
 await assert.rejects(()=>writeWorkflowTaskArtifactBundle({taskDir:f.taskDir,rawOutput:raw}));
 await assert.rejects(()=>stat(f.artifact),{code:'ENOENT'});
});
for (const code of ['EXDEV','EPERM','EOPNOTSUPP']) test(`${code} link failure is a safe independent authoritative write`,async t=>{
 const f=await fixture(t); await unlink(f.artifact);
 setTaskArtifactLinkForTests(()=>{throw Object.assign(new Error('link unavailable'),{code});});
 await writeWorkflowTaskArtifactBundle({taskDir:f.taskDir,rawOutput:raw});
 assert.equal(await readFile(f.artifact,'utf8'),raw); assert.equal((await stat(f.artifact)).nlink,1);
});
