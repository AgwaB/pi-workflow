import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import { CompiledTask, WorkflowRunRecord, WorkflowTaskRunRecord } from "./types.js";
import { fromProjectPath, isTerminalTaskStatus, nowIso, setTaskTerminal, toProjectPath, writeRunRecord } from "./store.js";
import { applyTaskResultArtifact, isTaskTimedOut, markTaskTimedOut } from "./result.js";
import type { BackendLaunchResult } from "./backend.js";

const DEFAULT_SUBAGENT_RUNS_ROOT = ".pi/workflow-subagents";
const TOOL_PROVIDER_EXTENSIONS: Record<string, string[]> = {
  web_search: ["npm:pi-web-access"],
  code_search: ["npm:pi-web-access"],
  fetch_content: ["npm:pi-web-access"],
  get_search_content: ["npm:pi-web-access"],
};

interface SubagentBackendHandle extends Record<string, unknown> {
  engine: "pi-subagent";
  backend: "headless";
  runId: string;
  attemptId: string;
  cwd: string;
  runsDir: string;
  display: string;
}

interface SubagentArtifactRef {
  type: string;
  path: string;
  artifactCwd?: string;
}

type SubagentRunLogRef = SubagentArtifactRef & { type: "stdout" | "stderr" | "output" | "result" };
type SubagentResultArtifactRef = SubagentArtifactRef & { type: "tool-calls" | "tool-calls-summary" | SubagentRunLogRef["type"] };

interface SubagentAttemptSnapshot {
  attemptId: string;
  status: string;
  heartbeatAt?: string;
  pid?: number;
  workerPid?: number;
}

interface SubagentRunStatusSnapshot {
  runId: string;
  attemptId: string;
  backend: string;
  status: string;
  failureKind: string | null;
  startedAt: string;
  completedAt: string | null;
  logs: SubagentRunLogRef[];
  metadata?: { contextLengthExceeded?: boolean; [key: string]: unknown };
  completion?: unknown;
  attempts?: SubagentAttemptSnapshot[];
}

interface SubagentResultEnvelope {
  runId: string;
  attemptId: string;
  status: string;
  artifacts?: SubagentResultArtifactRef[];
  cwd?: string;
}

interface SubagentApi {
  runSubagent(options: Record<string, unknown>): Promise<SubagentResultEnvelope>;
  getSubagentStatus(options: Record<string, unknown>): Promise<SubagentRunStatusSnapshot | null>;
  interruptSubagent(options: Record<string, unknown>): Promise<unknown>;
  reconcileSubagentRun(options: Record<string, unknown>): Promise<unknown>;
}

const subagentApiSpecifier = "@agwab/pi-subagent/api";
let cachedSubagentApi: Promise<SubagentApi> | undefined;
let injectedSubagentApi: SubagentApi | undefined;

export function setSubagentApiForTests(api: unknown | undefined): void {
  injectedSubagentApi = api === undefined ? undefined : api as SubagentApi;
  cachedSubagentApi = undefined;
}

async function loadSubagentApi(): Promise<SubagentApi> {
  if (injectedSubagentApi) return injectedSubagentApi;
  cachedSubagentApi ??= import(subagentApiSpecifier).then((mod) => mod as SubagentApi);
  return cachedSubagentApi;
}

export async function cleanupSubagentRun(_cwd: string, run: WorkflowRunRecord): Promise<void> {
  for (const task of run.tasks) {
    if (isTerminalTaskStatus(task.status)) continue;
    const handle = getSubagentHandle(task);
    if (!handle) continue;
    const api = await loadSubagentApi();
    await api.interruptSubagent({ cwd: handle.cwd, runsDir: handle.runsDir, runId: handle.runId, attemptId: handle.attemptId, reason: "workflow cleanup" }).catch(() => undefined);
  }
}

export async function launchSubagentTask(
  cwd: string,
  run: WorkflowRunRecord,
  task: WorkflowTaskRunRecord,
  compiledTask: CompiledTask,
): Promise<BackendLaunchResult> {
  if (task.status !== "pending") return { kind: "launched" };
  if (task.backendHandle || task.pid) return { kind: "launched" };

  if ((compiledTask.runtime.fast as string | undefined) === "on") {
    return {
      kind: "fatal",
      message: "fast:on is not supported for pi-workflow execution.",
    };
  }

  const systemPromptFile = fromProjectPath(cwd, task.files.systemPrompt);
  const taskPromptFile = fromProjectPath(cwd, task.files.taskPrompt);
  const outputFile = fromProjectPath(cwd, task.files.output);
  const stderrFile = fromProjectPath(cwd, task.files.stderr);
  const resultFile = fromProjectPath(cwd, task.files.result);
  await mkdir(dirname(systemPromptFile), { recursive: true });
  await rm(resultFile, { force: true });
  await writeFile(systemPromptFile, buildSystemPrompt(compiledTask), "utf8");
  await writeFile(taskPromptFile, compiledTask.compiledPrompt, "utf8");
  await writeFile(outputFile, "", "utf8");
  await writeFile(stderrFile, "", "utf8");

  const runsDir = subagentRunsDir(run, task);
  const correlationId = `${run.runId}:${task.taskId}`;
  task.status = "running";
  task.statusDetail = "launching";
  task.startedAt = nowIso();
  task.backendFiles = {
    runsDir: toProjectPath(task.cwd, resolve(task.cwd, runsDir)),
    correlationId,
  };
  task.lastMessage = "pi-subagent launch claim recorded";
  await writeRunRecord(cwd, run);

  let launched: SubagentResultEnvelope;
  try {
    const api = await loadSubagentApi();
    const providerExtensions = providerExtensionsForTools(compiledTask.runtime.tools);
    const subagentOptions: Record<string, unknown> = {
      cwd: task.cwd,
      backend: "headless",
      task: compiledTask.compiledPrompt,
      systemPrompt: buildSystemPrompt(compiledTask),
      model: compiledTask.runtime.model,
      thinking: compiledTask.runtime.thinking,
      tools: compiledTask.runtime.tools,
      async: true,
      onComplete: "detach",
      asyncDependency: "needed-before-final",
      workspace: "shared",
      worktreePolicy: "never",
      timeoutMs: compiledTask.runtime.maxRuntimeMs,
      runsDir,
      correlationId,
    };
    if (providerExtensions.length > 0) subagentOptions.extensions = providerExtensions;
    if (captureToolCallsEnabled()) subagentOptions.captureToolCalls = true;
    launched = await api.runSubagent(subagentOptions);
  } catch (error) {
    task.status = "pending";
    task.statusDetail = "pending";
    task.startedAt = undefined;
    task.lastMessage = "pi-subagent launch failed before backend handle was recorded";
    await writeRunRecord(cwd, run).catch(() => undefined);
    throw error;
  }

  const handle = makeSubagentHandle(run, task, launched.runId, launched.attemptId, runsDir);
  task.backendHandle = handle;
  task.backendTaskId = launched.runId;
  task.backendFiles = {
    runsDir: toProjectPath(task.cwd, resolve(task.cwd, runsDir)),
    correlationId,
  };
  task.statusDetail = "running";
  task.lastMessage = "launched via pi-subagent/headless";
  await writeRunRecord(cwd, run).catch(() => undefined);
  return { kind: "launched" };
}

export async function refreshRunFromSubagentArtifacts(cwd: string, run: WorkflowRunRecord): Promise<WorkflowRunRecord> {
  let changed = false;

  for (const task of run.tasks) {
    if (isTerminalTaskStatus(task.status) || task.status !== "running") continue;
    let handle = getSubagentHandle(task);
    if (!handle) {
      handle = await recoverSubagentHandle(run, task);
      if (handle) {
        task.backendHandle = handle;
        task.backendTaskId = handle.runId;
        task.backendFiles = {
          runsDir: toProjectPath(task.cwd, resolve(task.cwd, handle.runsDir)),
          correlationId: `${run.runId}:${task.taskId}`,
        };
        task.statusDetail = "running";
        task.lastMessage = `adopted pi-subagent run ${handle.runId}/${handle.attemptId}`;
        changed = true;
      }
    }
    if (!handle) {
      if (isTaskTimedOut(task)) {
        markTaskTimedOut(task);
        changed = true;
      }
      continue;
    }

    const api = await loadSubagentApi();
    await api.reconcileSubagentRun({ cwd: handle.cwd, runsDir: handle.runsDir, runId: handle.runId }).catch(() => undefined);
    const snapshot = await api.getSubagentStatus({ cwd: handle.cwd, runsDir: handle.runsDir, runId: handle.runId, attemptId: handle.attemptId }).catch(() => null);

    if (snapshot === null) {
      if (isTaskTimedOut(task)) {
        await api.interruptSubagent({ cwd: handle.cwd, runsDir: handle.runsDir, runId: handle.runId, attemptId: handle.attemptId, reason: "workflow timeout" }).catch(() => undefined);
        markTaskTimedOut(task);
        changed = true;
      }
      continue;
    }

    const activeAttempt = snapshot.attempts?.find((attempt) => attempt.attemptId === handle.attemptId) ?? snapshot.attempts?.at(-1);
    task.pid = activeAttempt?.workerPid ?? activeAttempt?.pid ?? task.pid;
    if (snapshot.status === "running" || snapshot.status === "pending") {
      task.statusDetail = "running";
      task.lastMessage = activeAttempt?.heartbeatAt ? `pi-subagent heartbeat ${activeAttempt.heartbeatAt}` : "pi-subagent running";
      if (isTaskTimedOut(task)) {
        await api.interruptSubagent({ cwd: handle.cwd, runsDir: handle.runsDir, runId: handle.runId, attemptId: handle.attemptId, reason: "workflow timeout" }).catch(() => undefined);
        markTaskTimedOut(task);
        changed = true;
      }
      continue;
    }

    if (await materializeTerminalSubagentResult(cwd, task, snapshot)) changed = true;
  }

  if (changed) await writeRunRecord(cwd, run);
  return run;
}

async function materializeTerminalSubagentResult(cwd: string, task: WorkflowTaskRunRecord, snapshot: SubagentRunStatusSnapshot): Promise<boolean> {
  const outputRef = findLog(snapshot, "output");
  const stderrRef = findLog(snapshot, "stderr");
  const resultRef = findLog(snapshot, "result");
  const outputFile = fromProjectPath(cwd, task.files.output);
  const stderrFile = fromProjectPath(cwd, task.files.stderr);
  const resultFile = fromProjectPath(cwd, task.files.result);

  await mkdir(dirname(outputFile), { recursive: true });
  await copyLogOrEmpty(snapshot, outputRef, outputFile);
  await copyLogOrEmpty(snapshot, stderrRef, stderrFile);

  const subagentResult = resultRef ? await readJsonLoose<Record<string, unknown>>(safeArtifactPath(snapshot, resultRef)) : undefined;
  const toolCalls = await readToolCallsSummary(snapshot, subagentResult);
  const outputBytes = Buffer.byteLength(await readFile(outputFile, "utf8").catch(() => ""), "utf8");
  const statusInfo = workflowStatusFromSubagent(snapshot, subagentResult, outputBytes);
  const completedAt = typeof subagentResult?.completedAt === "string" ? subagentResult.completedAt : snapshot.completedAt ?? nowIso();
  const startedAt = typeof subagentResult?.startedAt === "string" ? subagentResult.startedAt : snapshot.startedAt;
  const exitCode = typeof subagentResult?.exitCode === "number" ? subagentResult.exitCode : statusInfo.status === "completed" ? 0 : 1;
  const errorMessage = statusInfo.errorMessage ?? (typeof subagentResult?.errorMessage === "string" ? subagentResult.errorMessage : undefined);
  const workflowResult = {
    status: statusInfo.status,
    failureKind: statusInfo.failureKind,
    exitCode,
    completedAt,
    startedAt,
    errorMessage,
    noFinalOutput: outputBytes === 0,
    contextLengthExceeded: Boolean((subagentResult?.metadata as any)?.contextLengthExceeded ?? snapshot.metadata?.contextLengthExceeded),
    subagent: {
      runId: snapshot.runId,
      attemptId: snapshot.attemptId,
      backend: snapshot.backend,
      failureKind: snapshot.failureKind,
      resultPath: resultRef?.path,
      artifactCwd: resultRef?.artifactCwd,
      metadata: snapshot.metadata,
      completion: snapshot.completion,
      toolsConfigured: task.tools,
      toolCalls: toolCalls?.summary,
      toolCallsSummaryPath: toolCalls?.ref.path,
      toolCallsArtifactCwd: toolCalls?.ref.artifactCwd,
    },
  };
  await writeJson(resultFile, workflowResult);

  const completedAfterTimeout = resultCompletedAfterTimeout(task, completedAt);
  if (completedAfterTimeout) {
    markTaskTimedOut(task);
    return true;
  }

  const changed = await applyTaskResultArtifact(cwd, task, {
    resultFile,
    result: workflowResult,
    status: statusInfo.status,
    completedAfterTimeout: false,
  });
  if (isTerminalTaskStatus(task.status)) {
    delete task.backendHandle;
    delete task.backendFiles;
  }
  return changed;
}

function workflowStatusFromSubagent(snapshot: SubagentRunStatusSnapshot, result: Record<string, unknown> | undefined, outputBytes: number): { status: WorkflowTaskRunRecord["status"]; failureKind?: string; errorMessage?: string } {
  const contextLengthExceeded = Boolean((result?.metadata as any)?.contextLengthExceeded ?? snapshot.metadata?.contextLengthExceeded);
  if (snapshot.status === "completed" && outputBytes === 0) return { status: "failed", failureKind: "no_final_output", errorMessage: "child Pi produced no final assistant output" };
  if (snapshot.status === "completed") return { status: "completed" };
  if (contextLengthExceeded) return { status: "failed", failureKind: "context_or_request_too_large", errorMessage: "child Pi exceeded the model context window" };
  if (snapshot.status === "cancelled") return { status: "interrupted", failureKind: snapshot.failureKind ?? "cancelled", errorMessage: "pi-subagent run was cancelled" };
  if (snapshot.failureKind === "timeout") return { status: "failed", failureKind: "timeout", errorMessage: "pi-subagent run timed out" };
  if (snapshot.failureKind === "abort" || snapshot.failureKind === "cancelled" || snapshot.failureKind === "stale") {
    return { status: "interrupted", failureKind: snapshot.failureKind, errorMessage: `pi-subagent run ${snapshot.failureKind}` };
  }
  return { status: "failed", failureKind: snapshot.failureKind ?? "model", errorMessage: snapshot.failureKind ? `pi-subagent run failed: ${snapshot.failureKind}` : "pi-subagent run failed" };
}

function findLog(snapshot: SubagentRunStatusSnapshot, type: SubagentRunLogRef["type"]): SubagentRunLogRef | undefined {
  return snapshot.logs.find((log) => log.type === type);
}

function captureToolCallsEnabled(): boolean {
  const value = process.env.PI_WORKFLOW_CAPTURE_TOOL_CALLS;
  return typeof value === "string" && /^(1|true|yes|on)$/i.test(value.trim());
}

function providerExtensionsForTools(tools: readonly string[] | undefined): string[] {
  const providers = new Set<string>();
  for (const tool of tools ?? []) {
    for (const provider of TOOL_PROVIDER_EXTENSIONS[tool] ?? []) providers.add(provider);
  }
  return [...providers];
}

async function readToolCallsSummary(snapshot: SubagentRunStatusSnapshot, subagentResult: Record<string, unknown> | undefined): Promise<{ ref: SubagentArtifactRef; summary: unknown } | undefined> {
  const artifacts = Array.isArray(subagentResult?.artifacts) ? subagentResult.artifacts : [];
  const resultCwd = typeof subagentResult?.cwd === "string" ? subagentResult.cwd : undefined;
  const ref = artifacts.find((artifact): artifact is SubagentArtifactRef => {
    return typeof artifact === "object" && artifact !== null && (artifact as SubagentArtifactRef).type === "tool-calls-summary" && typeof (artifact as SubagentArtifactRef).path === "string";
  });
  if (!ref) return undefined;
  const artifactRef = { ...ref, artifactCwd: ref.artifactCwd ?? resultCwd };
  const summary = await readJsonLoose<unknown>(safeArtifactPath(snapshot, artifactRef));
  return summary === undefined ? undefined : { ref: artifactRef, summary };
}

async function copyLogOrEmpty(snapshot: SubagentRunStatusSnapshot, ref: SubagentRunLogRef | undefined, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  if (!ref) {
    await writeFile(target, "", "utf8");
    return;
  }
  await copyFile(safeArtifactPath(snapshot, ref), target).catch(async () => {
    await writeFile(target, "", "utf8");
  });
}

function safeArtifactPath(snapshot: SubagentRunStatusSnapshot, artifact: Pick<SubagentRunLogRef, "path" | "artifactCwd">): string {
  if (isAbsolute(artifact.path) || artifact.path.split("/").includes("..")) throw new Error("subagent artifact path must be relative and safe");
  const artifactCwd = resolve(artifact.artifactCwd ?? snapshot.logs.find((log) => log.artifactCwd)?.artifactCwd ?? ".");
  return resolve(artifactCwd, artifact.path.split("/").join(sep));
}

async function readJsonLoose<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

interface SubagentRunRecordLike {
  runId?: string;
  correlationId?: string;
  activeAttemptId?: string | null;
  latestAttemptId?: string | null;
  startedAt?: string;
  updatedAt?: string;
  attempts?: Array<{ attemptId?: string; startedAt?: string; updatedAt?: string }>;
}

async function recoverSubagentHandle(run: WorkflowRunRecord, task: WorkflowTaskRunRecord): Promise<SubagentBackendHandle | undefined> {
  const runsDir = subagentRunsDir(run, task);
  const absoluteRunsDir = resolve(task.cwd, runsDir);
  const expectedCorrelationId = `${run.runId}:${task.taskId}`;
  const entries = await readdir(absoluteRunsDir, { withFileTypes: true }).catch(() => []);
  const candidates: Array<{ handle: SubagentBackendHandle; updatedAtMs: number }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("run_")) continue;
    const record = await readJsonLoose<SubagentRunRecordLike>(join(absoluteRunsDir, entry.name, "run.json"));
    if (!record || record.correlationId !== expectedCorrelationId) continue;
    const attemptId = record.activeAttemptId ?? record.latestAttemptId ?? record.attempts?.at(-1)?.attemptId;
    if (typeof attemptId !== "string" || attemptId.length === 0) continue;
    candidates.push({
      handle: makeSubagentHandle(run, task, record.runId ?? entry.name, attemptId, runsDir),
      updatedAtMs: timestampMs(record.updatedAt) ?? timestampMs(record.startedAt) ?? timestampMs(record.attempts?.at(-1)?.updatedAt) ?? timestampMs(record.attempts?.at(-1)?.startedAt) ?? 0,
    });
  }

  candidates.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
  return candidates[0]?.handle;
}

function timestampMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function makeSubagentHandle(run: WorkflowRunRecord, task: WorkflowTaskRunRecord, runId: string, attemptId: string, runsDir: string): SubagentBackendHandle {
  return {
    engine: "pi-subagent",
    backend: "headless",
    runId,
    attemptId,
    cwd: task.cwd,
    runsDir,
    display: `pi-subagent/headless ${runId}/${attemptId}`,
  };
}

function getSubagentHandle(task: WorkflowTaskRunRecord): SubagentBackendHandle | undefined {
  const handle = task.backendHandle;
  if (!handle || typeof handle !== "object") return undefined;
  const candidate = handle as Partial<SubagentBackendHandle>;
  if (candidate.engine !== "pi-subagent" || candidate.backend !== "headless") return undefined;
  if (typeof candidate.runId !== "string" || typeof candidate.attemptId !== "string" || typeof candidate.cwd !== "string" || typeof candidate.runsDir !== "string") return undefined;
  return candidate as SubagentBackendHandle;
}

function subagentRunsDir(run: WorkflowRunRecord, task: WorkflowTaskRunRecord): string {
  return `${DEFAULT_SUBAGENT_RUNS_ROOT}/${run.runId}/${task.taskId}`;
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

function resultCompletedAfterTimeout(task: WorkflowTaskRunRecord, completedAt: string): boolean {
  if (!task.startedAt || !task.runtime.maxRuntimeMs) return false;
  const startedAtMs = Date.parse(task.startedAt);
  const completedAtMs = Date.parse(completedAt);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(completedAtMs)) return false;
  return completedAtMs - startedAtMs > task.runtime.maxRuntimeMs;
}
