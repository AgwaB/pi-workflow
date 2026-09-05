import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

for (const scenario of ['abrupt-response', 'unsupported-content']) {
 test(`direct-safe transport closes ${scenario} without crashing or continuing download`, async () => {
  const moduleUrl = new URL('../../.tmp/unit/workflow-web-source-extension.js', import.meta.url).href;
  const code = `import {createServer} from 'node:http';
   import {safeFetchWorkflowWebText} from ${JSON.stringify(moduleUrl)};
   const scenario=${JSON.stringify(scenario)};
   let responseClosed=false;
   const server=createServer((req,res)=>{
    res.on('close',()=>{responseClosed=true;});
    res.writeHead(200,{'content-type':scenario==='abrupt-response'?'text/plain':'application/octet-stream'});
    res.write('partial');
    if(scenario==='abrupt-response') setTimeout(()=>res.destroy(),10);
   });
   await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
   try {
    const result=await Promise.race([safeFetchWorkflowWebText('http://127.0.0.1:'+server.address().port+'/',{allowPrivateHosts:true,cacheRawProviderPayloads:false},undefined,200),new Promise(resolve=>setTimeout(()=>resolve({ok:false,reason:'test_watchdog_expired'}),500))]);
    await new Promise(resolve=>setTimeout(resolve,30));
    console.log(JSON.stringify({result,responseClosed}));
   } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}`;
  const result = await new Promise((resolve, reject) => {
   const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
   let stdout = '', stderr = '';
   child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes);
   child.on('error', reject); child.on('exit', code => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  const observation = JSON.parse(result.stdout);
  assert.equal(observation.result.ok, false);
  assert.equal(observation.result.reason, scenario === 'abrupt-response' ? 'response_aborted' : 'unsupported_content_type');
  assert.equal(observation.responseClosed, true, 'transport must close after returning failure');
 });
}
