import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { CompiledTask, WorkflowRunRecord, WorkflowTaskRunRecord } from "./types.js";
import {
  fromProjectPath,
  isTerminalTaskStatus,
  nowIso,
  setTaskTerminal,
  writeRunRecord,
} from "./store.js";
import {
  applyTaskResultArtifact,
  isTaskTimedOut,
  markTaskTimedOut,
  readTaskResultArtifact,
} from "./result.js";

const FAST_MODE_EXTENSION = join(homedir(), ".pi", "agent", "packages", "pi-openai-fast-mode", "index.ts");
const LAUNCH_STALE_MS = 30_000;

export type TmuxLaunchResult = { kind: "launched" } | { kind: "capacity"; message: string; retryAfterMs?: number };

export async function cleanupTmuxRun(_cwd: string, run: WorkflowRunRecord): Promise<void> {
  for (const task of run.tasks) {
    if (task.paneId && !isTerminalTaskStatus(task.status)) killTmuxPane(task.paneId);
  }
}

export async function launchTmuxTask(
  cwd: string,
  run: WorkflowRunRecord,
  task: WorkflowTaskRunRecord,
  compiledTask: CompiledTask,
): Promise<TmuxLaunchResult> {
  if (task.status !== "pending") return { kind: "launched" };
  if (task.paneId || task.pid) return { kind: "launched" };

  const systemPromptFile = fromProjectPath(cwd, task.files.systemPrompt);
  const absoluteTaskDir = dirname(systemPromptFile);
  await mkdir(absoluteTaskDir, { recursive: true });

  const taskPromptFile = fromProjectPath(cwd, task.files.taskPrompt);
  const outputFile = fromProjectPath(cwd, task.files.output);
  const stderrFile = fromProjectPath(cwd, task.files.stderr);
  const resultFile = fromProjectPath(cwd, task.files.result);
  const parserScript = join(absoluteTaskDir, "parse-json-events.mjs");
  const completeScript = join(absoluteTaskDir, "complete.mjs");
  const runnerScript = join(absoluteTaskDir, `${task.taskId}-runner.sh`);
  const launchToken = randomBytes(12).toString("hex");
  task.launchToken = launchToken;

  await rm(resultFile, { force: true });
  await writeFile(systemPromptFile, buildSystemPrompt(compiledTask), "utf8");
  await writeFile(taskPromptFile, compiledTask.compiledPrompt, "utf8");
  await writeJsonEventParserScript(parserScript);
  await writeCompletionScript(completeScript);
  await writeRunnerScript({
    runnerScript,
    taskCwd: task.cwd,
    task,
    compiledTask,
    systemPromptFile,
    taskPromptFile,
    outputFile,
    stderrFile,
    resultFile,
    parserScript,
    completeScript,
    launchToken,
  });

  task.status = "running";
  task.statusDetail = "launching";
  task.startedAt = nowIso();
  task.lastMessage = "launch claim recorded";
  await writeRunRecord(cwd, run);

  let pane: { paneId: string; pid?: number };
  try {
    pane = createTmuxPane(runnerScript);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isTmuxCapacityError(message)) {
      resetPendingLaunchClaim(task, message);
      await writeRunRecord(cwd, run).catch(() => undefined);
      return { kind: "capacity", message, retryAfterMs: 1000 };
    }
    throw error;
  }

  task.paneId = pane.paneId;
  task.pid = pane.pid;
  task.statusDetail = "running";
  task.lastMessage = "launched";
  await writeRunRecord(cwd, run).catch(() => undefined);
  return { kind: "launched" };
}

export async function refreshRunFromArtifacts(cwd: string, run: WorkflowRunRecord): Promise<WorkflowRunRecord> {
  let changed = false;

  for (const task of run.tasks) {
    if (isTerminalTaskStatus(task.status)) continue;
    if (task.status !== "running") continue;

    const acceptedResult = await readTaskResultArtifact(cwd, task);
    if (acceptedResult) {
      if (acceptedResult.completedAfterTimeout) {
        if (task.paneId) killTmuxPane(task.paneId);
        markTaskTimedOut(task);
        changed = true;
      } else {
        changed = await applyTaskResultArtifact(cwd, task, acceptedResult) || changed;
      }
      continue;
    }

    if (isTaskTimedOut(task)) {
      if (task.paneId) killTmuxPane(task.paneId);
      markTaskTimedOut(task);
      changed = true;
      continue;
    }

    if (!task.paneId) {
      if (isLaunchStale(task)) {
        changed = setTaskTerminal(task, "interrupted", "launch_lost", {
          lastMessage: "launch claim had no tmux pane after stale timeout",
        }) || changed;
      }
      continue;
    }

    if (!tmuxPaneAlive(task.paneId)) {
      changed = setTaskTerminal(task, "interrupted", "pane_missing", {
        lastMessage: "tmux pane disappeared before completion was recorded",
      }) || changed;
      continue;
    }

  }

  if (changed) await writeRunRecord(cwd, run);
  return run;
}

function buildSystemPrompt(task: CompiledTask): string {
  return [
    `You are Pi workflow subagent '${task.agent}'.`,
    "You were launched by /workflow from a deterministic workflow spec.",
    "Do not assume parent conversation history.",
    "Do not launch other agents or orchestration workflows unless explicitly instructed.",
    "When complete, provide a concise final report with findings, changed files if any, and blockers.",
    "",
    "# Agent Definition",
    task.agentSystemPrompt.trim(),
  ].join("\n");
}

async function writeJsonEventParserScript(file: string): Promise<void> {
  const script = `
import fs from 'node:fs'; import path from 'node:path';
const outputFile=process.argv[2]; const resultFile=process.argv[3]; const launchToken=process.argv[4];
let buffer=''; let finalText=''; let lastAssistant={}; let assistantTurns=0; let messageEndEvents=0;
function writeJson(f,v){fs.mkdirSync(path.dirname(f),{recursive:true});const tmp=path.join(path.dirname(f),'.'+Date.now().toString(36)+'-'+Math.random().toString(16).slice(2)+'.tmp');fs.writeFileSync(tmp,JSON.stringify(v,null,2)+'\\n');fs.renameSync(tmp,f)}
function textFromContent(content){return Array.isArray(content)?content.filter(c=>c&&c.type==='text'&&typeof c.text==='string').map(c=>c.text).join('\\n'):''}
function handleLine(line){
  if(!line.trim()) return;
  if(!/\"type\"\\s*:\\s*\"(?:message_end|agent_end)\"/.test(line)) return;
  let event; try{event=JSON.parse(line)}catch{return}
  if(event.type==='message_end'){
    messageEndEvents++;
    const msg=event.message;
    if(msg?.role==='assistant'){
      assistantTurns++;
      lastAssistant={stopReason:msg.stopReason,errorMessage:msg.errorMessage,provider:msg.provider,model:msg.model,usage:msg.usage};
      if(msg.stopReason!=='toolUse') finalText=textFromContent(msg.content);
    }
  }
}
process.stdin.on('data',(chunk)=>{buffer+=chunk.toString(); const lines=buffer.split('\\n'); buffer=lines.pop()||''; for(const line of lines) handleLine(line)});
process.stdin.on('end',()=>{if(buffer.trim()) handleLine(buffer); fs.mkdirSync(path.dirname(outputFile),{recursive:true}); const text=finalText.trimEnd(); fs.writeFileSync(outputFile,text?text+'\\n':''); if(text) process.stdout.write(text+'\\n'); writeJson(resultFile,{...lastAssistant,launchToken,assistantTurns,messageEndEvents,finalTextChars:text.length,finalTextBytes:Buffer.byteLength(text,'utf8'),outputLog:outputFile,completedAt:new Date().toISOString()})});
process.stdin.on('error',(error)=>{writeJson(resultFile,{launchToken,stopReason:'error',errorMessage:String(error),completedAt:new Date().toISOString()}); process.exitCode=1});
`;
  await writeFile(file, script, { mode: 0o700 });
}

async function writeCompletionScript(file: string): Promise<void> {
  const script = `
import fs from 'node:fs'; import path from 'node:path';
const taskId=process.argv[2]; const exitCode=Number(process.argv[3]||'0'); const outputFile=process.argv[4]; const resultFile=process.argv[5]; const stderrFile=process.argv[6]; const launchToken=process.argv[7];
if(!taskId||!outputFile||!resultFile||!stderrFile){throw new Error('workflow completion missing task artifact paths')}
function readJson(f){try{return JSON.parse(fs.readFileSync(f,'utf8'))}catch{return undefined}} function writeJson(f,v){fs.mkdirSync(path.dirname(f),{recursive:true});const tmp=path.join(path.dirname(f),'.'+Date.now().toString(36)+'-'+Math.random().toString(16).slice(2)+'.tmp');fs.writeFileSync(tmp,JSON.stringify(v,null,2)+'\\n');fs.renameSync(tmp,f)}
function readText(f){try{return fs.readFileSync(f,'utf8')}catch{return ''}} function fileSize(f){try{return fs.statSync(f).size}catch{return 0}} function cap(s){s=String(s||''); return s.length>4000?s.slice(0,4000)+'…':s}
const completedAt=new Date().toISOString(); let result=readJson(resultFile)||{}; const stderrText=cap(readText(stderrFile).trim()); const outputBytes=fileSize(outputFile); let errorMessage=cap(typeof result.errorMessage==='string'?result.errorMessage:''); const stopReason=result.stopReason;
const contextLengthExceeded=/context_length_exceeded/i.test(errorMessage)||/context_length_exceeded/i.test(stderrText); let status='completed'; let failureKind=undefined;
if(contextLengthExceeded){status='failed'; failureKind='context_or_request_too_large'; errorMessage='context_length_exceeded: '+(errorMessage||stderrText||'child Pi exceeded the model context window')}
else if(stopReason==='error'||stopReason==='aborted'){status='failed'; failureKind=stopReason==='aborted'?'aborted':'provider_error'; errorMessage=errorMessage||stderrText||('child Pi stopReason='+stopReason)}
else if(Number.isFinite(exitCode)&&exitCode!==0){status='failed'; failureKind='exit_code'; errorMessage=errorMessage||stderrText||('child Pi exited with code '+exitCode)}
else if(outputBytes===0){status='failed'; failureKind='no_final_output'; errorMessage=errorMessage||stderrText||'child Pi produced no final assistant output'}
errorMessage=cap(errorMessage); result={...result,launchToken,status,exitCode,completedAt,outputLog:outputFile,stderrLog:stderrFile,finalTextBytes:outputBytes,noFinalOutput:outputBytes===0,contextLengthExceeded,failureKind,errorMessage:errorMessage||undefined}; writeJson(resultFile,result);
if(status==='failed'){const line='[workflow task failed: '+(errorMessage||failureKind||'unknown error')+']\\n'; const existing=readText(outputFile); fs.writeFileSync(outputFile, existing ? existing.replace(/\\s*$/,'\\n')+line : line)}
`;
  await writeFile(file, script, { mode: 0o700 });
}

async function writeRunnerScript(options: {
  runnerScript: string;
  taskCwd: string;
  task: WorkflowTaskRunRecord;
  compiledTask: CompiledTask;
  systemPromptFile: string;
  taskPromptFile: string;
  outputFile: string;
  stderrFile: string;
  resultFile: string;
  parserScript: string;
  completeScript: string;
  launchToken: string;
}): Promise<void> {
  const args = buildPiArgs(options.compiledTask, options.systemPromptFile).map(shellQuote).join(" ");
  const script = `#!/usr/bin/env bash
set -o pipefail
mkdir -p ${shellQuote(dirname(options.outputFile))}
: > ${shellQuote(options.outputFile)}
: > ${shellQuote(options.stderrFile)}
cd ${shellQuote(options.taskCwd)} || { echo ${shellQuote(`workflow runner failed to enter task cwd: ${options.taskCwd}`)} >> ${shellQuote(options.stderrFile)}; ${shellQuote(process.execPath)} ${shellQuote(options.completeScript)} ${shellQuote(options.task.taskId)} 1 ${shellQuote(options.outputFile)} ${shellQuote(options.resultFile)} ${shellQuote(options.stderrFile)} ${shellQuote(options.launchToken)}; exit 1; }
pi ${args} -p "$(cat ${shellQuote(options.taskPromptFile)})" 2> >(tee ${shellQuote(options.stderrFile)} >&2) | ${shellQuote(process.execPath)} ${shellQuote(options.parserScript)} ${shellQuote(options.outputFile)} ${shellQuote(options.resultFile)} ${shellQuote(options.launchToken)}
status=("\${PIPESTATUS[@]}")
code="\${status[0]:-1}"
parser_code="\${status[1]:-0}"
completion_code="$code"
if [ "$parser_code" != "0" ]; then echo "workflow JSON parser failed with code $parser_code" >> ${shellQuote(options.stderrFile)}; if [ "$completion_code" = "0" ]; then completion_code="$parser_code"; fi; fi
${shellQuote(process.execPath)} ${shellQuote(options.completeScript)} ${shellQuote(options.task.taskId)} "$completion_code" ${shellQuote(options.outputFile)} ${shellQuote(options.resultFile)} ${shellQuote(options.stderrFile)} ${shellQuote(options.launchToken)}
echo "[workflow completed task=${options.task.taskId} exit=$completion_code]"
exit "$completion_code"
`;
  await writeFile(options.runnerScript, script, "utf8");
  await chmod(options.runnerScript, 0o700);
}

function buildPiArgs(task: CompiledTask, systemPromptFile: string): string[] {
  const args = ["--mode", "json", "--no-session"];
  args.push(task.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt", systemPromptFile);

  if (task.inheritProjectContext === false) args.push("--no-context-files");
  if (task.inheritSkills === false) args.push("--no-skills");
  if (task.runtime.fast === "on") args.push("--extension", FAST_MODE_EXTENSION, "--fast");
  if (task.runtime.model) args.push("--model", task.runtime.model);
  if (task.runtime.thinking) args.push("--thinking", task.runtime.thinking);
  if (task.runtime.tools?.length) args.push("--tools", task.runtime.tools.join(","));
  return args;
}

function createTmuxPane(runnerScript: string): { paneId: string; pid?: number } {
  const target = currentTmuxPane();
  const args = ["split-window", "-d", "-h", "-P", "-F", "#{pane_id}"];
  if (target) args.push("-t", target);
  args.push(`bash ${shellQuote(runnerScript)}`);
  const paneId = tmux(args);
  const pidText = tryTmux(["display-message", "-p", "-t", paneId, "#{pane_pid}"]);
  const pid = Number.parseInt(pidText ?? "", 10);
  return { paneId, pid: Number.isFinite(pid) ? pid : undefined };
}

function currentTmuxPane(): string | undefined {
  if (process.env.TMUX_PANE) return process.env.TMUX_PANE;
  try {
    return tmux(["display-message", "-p", "#{pane_id}"]);
  } catch {
    return undefined;
  }
}

function tmuxPaneAlive(paneId: string): boolean {
  try {
    tmux(["display-message", "-p", "-t", paneId, "#{pane_id}"]);
    return true;
  } catch {
    return false;
  }
}

function killTmuxPane(paneId: string): void {
  try {
    tmux(["kill-pane", "-t", paneId]);
  } catch {
    // Pane may have already exited; reconciliation will pick up result/pane state on next refresh.
  }
}

function tmux(args: string[]): string {
  return execFileSync("tmux", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }).trim();
}

function tryTmux(args: string[]): string | undefined {
  try {
    return tmux(args);
  } catch {
    return undefined;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function isLaunchStale(task: WorkflowTaskRunRecord): boolean {
  if (!task.startedAt) return true;
  return Date.now() - Date.parse(task.startedAt) > LAUNCH_STALE_MS;
}

function isTmuxCapacityError(message: string): boolean {
  return /no space for new pane|resource temporarily unavailable|\bEAGAIN\b|\bEMFILE\b|\bENOMEM\b/i.test(message);
}

function resetPendingLaunchClaim(task: WorkflowTaskRunRecord, message: string): void {
  task.status = "pending";
  task.statusDetail = "waiting_capacity";
  task.lastMessage = message;
  delete task.startedAt;
  delete task.completedAt;
  delete task.elapsedMs;
  delete task.exitCode;
  delete task.paneId;
  delete task.pid;
  delete task.launchToken;
}
