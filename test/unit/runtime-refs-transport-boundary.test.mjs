import assert from 'node:assert/strict';
import http from 'node:http';
import dns from 'node:dns/promises';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import test from 'node:test';
test('refs URL probe settles an abruptly closed GET response after HEAD fallback', async () => {
const originalRequest=http.request,originalLookup=dns.lookup;
const root=await mkdtemp(join(tmpdir(),'piwf-refs-local-'));
let requests=0;
const server=http.createServer((req,res)=>{
 requests++;
 if(req.method==='HEAD'){res.writeHead(405);res.end();return;}
 res.writeHead(200,{'content-type':'text/plain'});res.write('partial');setTimeout(()=>res.destroy(),10);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try{
 // Test-only DNS/transport seam: the public entry path validates a synthetic
 // public address, but all HTTP I/O is directed to this disposable loopback
 // server. No request or DNS lookup leaves this process/host.
 dns.lookup=async hostname=>{assert.equal(hostname,'fixture.invalid');return [{address:'93.184.216.34',family:4}];};
 http.request=(url,options,callback)=>{assert.equal(url.hostname,'fixture.invalid');return originalRequest(new URL('http://127.0.0.1:'+server.address().port+'/'),{method:options.method,headers:options.headers},callback);};
 syncBuiltinESMExports();
 const {writeWorkflowTaskArtifactBundle}=await import(pathToFileURL(join(process.cwd(),'.tmp/unit/workflow-output-artifacts.js')));
 const raw='<control>{"schema":"stage-control-v1","digest":"done"}</control>\n<analysis>fixture</analysis>\n<refs>[{"url":"http://fixture.invalid/"}]</refs>';
 const start=performance.now();
 const result=await Promise.race([writeWorkflowTaskArtifactBundle({taskDir:root,rawOutput:raw,refsMinItems:1,refsUrlValidation:{timeoutMs:100,maxUrls:1}}),new Promise(resolve=>setTimeout(()=>resolve({watchdog:true}),500))]);
 console.log(JSON.stringify({result,requests,elapsedMs:performance.now()-start}));
 assert.notEqual(result.watchdog,true,'refs GET must settle after response abort, not leave the writer waiting past timeout');
 assert.equal(result.valid,false);
 assert.ok(result.parsed.issues.some(issue=>issue.code==='unavailable_ref_locator'));
}finally{
 dns.lookup=originalLookup;http.request=originalRequest;syncBuiltinESMExports();
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});
}

});
