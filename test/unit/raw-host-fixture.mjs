import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

// Opt-in materialization for old API-only backend fixtures. Produce the same
// bounded mirror/attempt names as the backend; never manufacture a raw anchor.
export function withMaterializedRawHost(setApi) {
 return api => setApi(api && {
  ...api,
  async getSubagentStatus(options) {
   const status = await api.getSubagentStatus(options);
   if (!status || !['completed','failed'].includes(status.status)) return status;
   const runsRoot = resolve(options.cwd, options.runsDir);
   if (basename(dirname(dirname(runsRoot))) !== 'workflow-subagents') return status;
   const runId=status.runId, attemptId=status.attemptId;
   const mirrorDir=join(runsRoot,runId), attemptDir=join(mirrorDir,'attempts',attemptId);
   await mkdir(attemptDir,{recursive:true});
   const readJson=async path=>JSON.parse(await readFile(path,'utf8').catch(error=>{if(error.code==='ENOENT')return '{}';throw error;}));
   const put=async(path,value)=>{const text=typeof value==='string'?value:JSON.stringify(value);if(await readFile(path,'utf8').catch(()=>undefined)!==text)await writeFile(path,text);};
   const terminalLog=status.logs?.find(log=>log.type==='result');
   const terminal=terminalLog?await readJson(resolve(terminalLog.artifactCwd??options.cwd,terminalLog.path)):{};
   await put(join(attemptDir,'result.json'),{runId,attemptId,status:status.status,...terminal});
   for(const kind of ['output','stderr']){
    const log=status.logs?.find(log=>log.type===kind);
    if(log)await put(join(attemptDir,`${kind}.log`),await readFile(resolve(log.artifactCwd??options.cwd,log.path),'utf8'));
   }
   const path=join(mirrorDir,'run.json'),mirror=await readJson(path);
   await put(path,{runId,correlationId:`${basename(dirname(runsRoot))}:${basename(runsRoot)}`,...mirror,latestAttemptId:attemptId,activeAttemptId:null,status:status.status,attempts:mirror.attempts?.map(attempt=>attempt.attemptId===attemptId?{...attempt,status:status.status}:attempt)??[{attemptId,status:status.status}]});
   return status;
  },
 });
}
