import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('one-shot launch requests explicit extension isolation without dropping task extensions', async t => {
 const {runOneShotSubagentCall,setSubagentApiForTests}=await import('../../.tmp/unit/subagent-backend.js');
 const cwd=await mkdtemp(join(tmpdir(),'piwf-explicit-isolation-'));
 t.after(()=>rm(cwd,{recursive:true,force:true}));
 const extension=join(cwd,'task-extension.mjs');
 await writeFile(extension,"export default function(pi){pi.registerFlag('explicit-isolation-fixture',{description:'Explicit fixture',type:'boolean'});}");
 await mkdir(join(cwd,'.pi','extensions'),{recursive:true});
 await writeFile(join(cwd,'.pi','extensions','ambient.js'),"throw new Error('AMBIENT_EXTENSION_MUST_NOT_LOAD');");
 let received;
 setSubagentApiForTests({
  supportsExplicitExtensionIsolation(){return true;},
  async runSubagent(options){received=options;return {runId:'run',attemptId:'attempt',status:'running'};},
 });
 t.after(()=>setSubagentApiForTests(undefined));
 await runOneShotSubagentCall({cwd,extensions:[extension]});
 assert.equal(received.noExtensions,true);
 assert.deepEqual(received.extensions,[extension]);
 setSubagentApiForTests({
  async runSubagent(){assert.fail('additive preflight must reject the ambient extension before launch');},
 });
 await assert.rejects(
  runOneShotSubagentCall({cwd,extensions:[extension]}),
  /AMBIENT_EXTENSION_MUST_NOT_LOAD/,
 );
});

test('one-shot launch refuses a sealed isolation request without native capability', async t => {
 const {runOneShotSubagentCall,setSubagentApiForTests}=await import('../../.tmp/unit/subagent-backend.js');
 let launched=false;
 setSubagentApiForTests({
  async runSubagent(){launched=true;return {runId:'run',attemptId:'attempt',status:'running'};},
 });
 t.after(()=>setSubagentApiForTests(undefined));
 await assert.rejects(
  ()=>runOneShotSubagentCall({cwd:process.cwd(),extensions:['task-extension.mjs'],noExtensions:true}),
  /does not support explicit extension isolation/,
 );
 assert.equal(launched,false);
});

for (const scenario of ['abrupt-response', 'unsupported-content']) {
 test(`direct-safe transport closes ${scenario} without crashing or continuing download`, async () => {
  const moduleUrl = new URL('../../.tmp/unit/workflow-web-source-extension.js', import.meta.url).href;
  const code = `import assert from 'node:assert/strict';
   import http,{createServer} from 'node:http';
   import net from 'node:net';
   import {mkdtemp,rm} from 'node:fs/promises';
   import {tmpdir} from 'node:os';
   import {join} from 'node:path';
   import {safeFetchWorkflowWebText} from ${JSON.stringify(moduleUrl)};
   if(process.env.PI_WORKFLOW_E2E_NO_EXTERNAL_ACTIONS==='1'){
    assert.equal(globalThis[Symbol.for('pi-workflow.e2e-no-external-actions-guard')],true,'original guard must be active in the physical transport child');
   }
   const scenario=${JSON.stringify(scenario)};
   const root=await mkdtemp(join(tmpdir(),'piwf-transport-'));
   const socketPath=join(root,'http.sock');
   let responseClosed=false;
   let closeObserved;
   const closed=new Promise(resolve=>{closeObserved=resolve;});
   const server=createServer((req,res)=>{
    res.on('close',()=>{responseClosed=true;closeObserved();});
    res.writeHead(200,{'content-type':scenario==='abrupt-response'?'text/plain':'application/octet-stream'});
    res.write('partial',()=>{if(scenario==='abrupt-response') res.destroy();});
   });
   await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});
   try {
    const runtime={now:Date.now,httpRequest(url,options,callback){
     assert.equal(url.href,'http://127.0.0.1/');
     return new http.ClientRequest({method:options.method,headers:options.headers,path:'/',agent:undefined,
      createConnection:()=>net.createConnection({path:socketPath})},callback);
    },httpsRequest(){throw new Error('unexpected HTTPS transport');},setDeadlineTimer:setTimeout,clearDeadlineTimer:clearTimeout};
    const result=await Promise.race([safeFetchWorkflowWebText('http://127.0.0.1/',{allowPrivateHosts:true,cacheRawProviderPayloads:false},undefined,200,runtime),new Promise(resolve=>setTimeout(()=>resolve({ok:false,reason:'test_watchdog_expired'}),500))]);
    await Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(new Error('response close not observed')),500))]);
    console.log(JSON.stringify({result,responseClosed}));
   } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});}`;
  const result = await new Promise((resolve, reject) => {
   const child = spawn(process.execPath, [
    '--import', new URL('../e2e/no-external-actions-guard.mjs', import.meta.url).href,
    '--input-type=module', '-e', code,
   ], { stdio: ['ignore', 'pipe', 'pipe'] });
   let stdout = '', stderr = '';
   child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes);
   child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  const observation = JSON.parse(result.stdout);
  assert.equal(observation.result.ok, false);
  assert.equal(observation.result.reason, scenario === 'abrupt-response' ? 'response_aborted' : 'unsupported_content_type');
  assert.equal(observation.responseClosed, true, 'transport must close after returning failure');
 });
}
