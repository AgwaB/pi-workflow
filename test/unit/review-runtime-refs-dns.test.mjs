import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeWorkflowTaskArtifactBundle } from '../../.tmp/unit/workflow-output-artifacts.js';
test('HTTP-01 refs DNS timeout settles and late DNS never dispatches HTTP', async()=>{
 const originalLookup=dns.lookup,originalRequest=http.request; const root=await mkdtemp(join(tmpdir(),'piwf-refs-dns-fixed-')); let requests=0;const completions=[];let watchdog;
 try {
  dns.lookup=async hostname=>{assert.equal(hostname,'dns-stall.invalid');return new Promise(resolve=>completions.push(resolve));};
  http.request=()=>{requests++;throw Error('unexpected HTTP dispatch');};syncBuiltinESMExports();
  const raw='<control>{"schema":"stage-control-v1","digest":"done"}</control>\n<analysis>fixture</analysis>\n<refs>[{"url":"http://dns-stall.invalid/"}]</refs>';
  const result=await Promise.race([writeWorkflowTaskArtifactBundle({taskDir:root,rawOutput:raw,refsMinItems:1,refsUrlValidation:{timeoutMs:30,maxUrls:1}}),new Promise(resolve=>{watchdog=setTimeout(()=>resolve({watchdog:true}),500);})]);
  assert.notEqual(result.watchdog,true,'DNS preflight must settle before watchdog');assert.match(JSON.stringify(result),/DNS resolution timeout/);assert.equal(completions.length,2,'HEAD and GET each get a preflight budget');assert.equal(requests,0);
  for(const complete of completions)complete([{address:'93.184.216.34',family:4}]);await new Promise(r=>setTimeout(r,50));assert.equal(requests,0,'late DNS result cannot dispatch either attempt');
 }finally{clearTimeout(watchdog);dns.lookup=originalLookup;http.request=originalRequest;syncBuiltinESMExports();await rm(root,{recursive:true,force:true});}
});
test('HTTP-01 successful preflight still rechecks DNS at connect time',async()=>{
 const originalLookup=dns.lookup,originalRequest=http.request;const root=await mkdtemp(join(tmpdir(),'piwf-refs-rebinding-'));let lookups=0,connections=0,requests=0;
 const server=http.createServer((_req,res)=>{connections++;res.end('must not reach private transport');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  dns.lookup=async hostname=>{assert.equal(hostname,'rebind.invalid');lookups++;return [{address:lookups%2?'93.184.216.34':'127.0.0.1',family:4}];};
  http.request=(url,options,callback)=>{requests++;assert.equal(typeof options.lookup,'function','connect resolver policy cannot be dropped');return originalRequest(url,options,callback);};syncBuiltinESMExports();
  const raw=`<control>{"schema":"stage-control-v1","digest":"done"}</control>\n<analysis>fixture</analysis>\n<refs>[{"url":"http://rebind.invalid:${server.address().port}/"}]</refs>`;
  const result=await writeWorkflowTaskArtifactBundle({taskDir:root,rawOutput:raw,refsMinItems:1,refsUrlValidation:{timeoutMs:100,maxUrls:1}});
  assert.equal(result.valid,false);assert.match(JSON.stringify(result),/private host blocked/);assert.equal(requests,2);assert.equal(lookups,4);assert.equal(connections,0);
 }finally{dns.lookup=originalLookup;http.request=originalRequest;syncBuiltinESMExports();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
});
