import assert from 'node:assert/strict';
import http from 'node:http';
import dns from 'node:dns/promises';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import test from 'node:test';

async function withinWatchdog(promise, message) {
 let timer;
 try { return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),500);})]); }
 finally { clearTimeout(timer); }
}

test('refs URL probe settles an abruptly closed GET response after HEAD fallback', async () => {
 const originalRequest=http.request,originalLookup=dns.lookup;
 const root=await mkdtemp(join(tmpdir(),'piwf-refs-local-'));
 let requests=0,getResponse,clientData=false,clientAborted=false,pending;
 const server=http.createServer((req,res)=>{
  requests++;
  if(req.method==='HEAD'){res.writeHead(405);res.end();return;}
  getResponse=res;
  res.writeHead(200,{'content-type':'text/plain'});res.write('partial');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  // Public DNS validation is exercised, but transport stays on disposable loopback.
  dns.lookup=async hostname=>{assert.equal(hostname,'fixture.invalid');return [{address:'93.184.216.34',family:4}];};
  http.request=(url,options,callback)=>{
   assert.equal(url.hostname,'fixture.invalid');
   return originalRequest(new URL('http://127.0.0.1:'+server.address().port+'/'),{method:options.method,headers:options.headers},response=>{
    callback(response);
    if(options.method==='GET'){
     response.once('aborted',()=>{clientAborted=true;});
     response.once('data',()=>{clientData=true;getResponse.destroy();});
    }
   });
  };
  syncBuiltinESMExports();
  const {writeWorkflowTaskArtifactBundle}=await import(pathToFileURL(join(process.cwd(),'.tmp/unit/workflow-output-artifacts.js')));
  const raw='<control>{"schema":"stage-control-v1","digest":"done"}</control>\n<analysis>fixture</analysis>\n<refs>[{"url":"http://fixture.invalid/"}]</refs>';
  pending=writeWorkflowTaskArtifactBundle({taskDir:root,rawOutput:raw,refsMinItems:1,refsUrlValidation:{timeoutMs:100,maxUrls:1}});
  const result=await withinWatchdog(pending,'refs GET must settle after response abort within 500ms');
  assert.equal(clientData,true,'GET body must reach the installed product response handler');
  assert.equal(clientAborted,true,'exercise post-response abort, not a pre-response socket failure');
  assert.equal(requests,2);
  assert.equal(result.valid,false);
  assert.ok(result.parsed.issues.some(issue=>issue.code==='unavailable_ref_locator'));
 } finally {
  server.closeAllConnections();
  let drained=false;
  try { if(pending) await withinWatchdog(pending,'refs fixture writer did not drain after closing connections'); drained=true; }
  finally {
   dns.lookup=originalLookup;http.request=originalRequest;syncBuiltinESMExports();
   await new Promise(resolve=>server.close(resolve));
   // Keep evidence if a defective writer did not join; never delete under it.
   if(drained) await rm(root,{recursive:true,force:true});
  }
 }
});
