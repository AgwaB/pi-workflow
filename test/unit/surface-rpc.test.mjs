import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// A real locked Pi subprocess. Only registered custom commands are sent: no
// provider credentials, model request, workflow launch, or user configuration.
test('actual Pi RPC /workflow emits fallback and malformed launch commands stop before scheduling', {timeout:30000}, async t=>{
 const cwd=await mkdtemp(join(tmpdir(),'surface-rpc-'));
 const home=join(cwd,'home'),agent=join(home,'agent');await mkdir(agent,{recursive:true});
 const guard=join(cwd,'guard.ts');await writeFile(guard,`export default function(pi) {
 pi.on('before_provider_request', () => { throw new Error('MODEL_CALL_FORBIDDEN'); });
 pi.registerCommand('surface-context', {handler: async (_args,ctx) => ctx.ui.notify('mode='+ctx.mode+';hasUI='+ctx.hasUI,'info')});
 pi.registerCommand('surface-exit', {handler: async (_args,ctx) => ctx.shutdown()});
 }`);
 const p=spawn(process.execPath,[resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),'--mode','rpc','--no-session','--offline','--no-extensions','--no-skills','--no-prompt-templates','--no-themes','--no-context-files','--no-tools','-e',resolve('src/extension.ts'),'-e',guard],{cwd,env:{PATH:process.env.PATH,HOME:home,PI_CODING_AGENT_DIR:agent,PI_OFFLINE:'1',PI_WORKFLOW_ROLE:'parent'},stdio:['pipe','pipe','pipe']});
 const events=[];let buffer='',stderr='';p.stdout.setEncoding('utf8');p.stderr.setEncoding('utf8');p.stderr.on('data',s=>stderr+=s);
 p.stdout.on('data',s=>{buffer+=s;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{events.push(JSON.parse(line));}catch{events.push({invalid:line});}}});
 const exited=new Promise(r=>p.on('exit',r));t.after(async()=>{if(p.exitCode===null)p.kill('SIGTERM');await exited;await rm(cwd,{recursive:true,force:true});});
 const send=x=>p.stdin.write(JSON.stringify(x)+'\n');
 async function wait(predicate){const deadline=Date.now()+10000;while(Date.now()<deadline){const value=events.find(predicate);if(value)return value;if(p.exitCode!==null)break;await new Promise(r=>setTimeout(r,10));}assert.fail(JSON.stringify({events,stderr}));}
 send({id:'commands',type:'get_commands'});
 const commands=await wait(e=>e.id==='commands');assert.equal(commands.success,true);assert.ok(commands.data.commands.some(c=>c.name==='workflow'));
 send({id:'context',type:'prompt',message:'/surface-context'});await wait(e=>e.method==='notify'&&e.message==='mode=rpc;hasUI=true');
 send({id:'board',type:'prompt',message:'/workflow'});await wait(e=>e.method==='notify'&&/No workflow runs|Workflow runs/i.test(e.message));
 for(const [id,message] of [['missing','/workflow run deep-research "task" --model'],['dynamic','/workflow dynamic --profile high "task"']]){
  send({id,type:'prompt',message});await wait(e=>e.method==='notify'&&e.notifyType==='error'&&(id==='missing'?/requires a value/.test(e.message):/does not support --profile/.test(e.message)));
 }
 assert.equal(events.some(e=>e.type==='agent_start'),false,'custom commands must not invoke an agent');assert.doesNotMatch(stderr,/MODEL_CALL_FORBIDDEN/);
 send({id:'quit',type:'prompt',message:'/surface-exit'});await exited;
 assert.equal(p.exitCode,0,stderr);
});
