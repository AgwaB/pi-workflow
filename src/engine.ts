import { readFile } from "node:fs/promises";

import { compileWorkflow, compileWorkflowSpec } from "./compiler.js";
import { loadWorkflowSpec } from "./schema.js";
import {
  createRunRecord,
  createTaskRunRecord,
  compiledWorkflowPath,
  fromProjectPath,
  indexSupervisorErrorPath,
  isTerminalWorkflowStatus,
  isTerminalTaskStatus,
  listRunRecords,
  readIndex,
  readJson,
  readRunRecord,
  setTaskTerminal,
  supervisorPath,
  updateIndex,
  withRunLease,
  writeJsonAtomic,
  writeRunRecord,
  writeStaticRunArtifacts,
} from "./store.js";
import { resolveWorkflowBackend } from "./backend.js";
import { ensureManagedWorktree } from "./worktree.js";
import { buildJsonOutputRetryInstructions } from "./result.js";
import { buildSourceContextPacket, formatOutputTemplateSection, summarizeWorkflowTelemetry, type SourceContextPacketOptions } from "./workflow-artifacts.js";
import { extractStageFirstForeachItems } from "./workflow-runtime.js";
import { CompiledTask, CompiledWorkflow, STAGE_FIRST_RUN_TYPE, WorkflowIndexRecord, WorkflowRunRecord, WorkflowTaskRunRecord } from "./types.js";

const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
const MAX_WAIT_TIMEOUT_MS = 14_400_000;
const POLL_INTERVAL_MS = 1_000;
const LOG_LINES_DEFAULT = 80;
const LOG_LINES_MAX = 400;
const MAX_CONCURRENCY = 16;
const SOURCE_CONTEXT_PREVIEW_CHARS = 1_200;
const SOURCE_CONTEXT_STRUCTURED_CHARS = 6_000;
const SOURCE_CONTEXT_MAX_PACKET_CHARS = 48_000;

const supervisorTimers = new Map<string, ReturnType<typeof setInterval>>();

export async function runWorkflowSpec(specPath: string, cwd: string, options: { task?: string } = {}): Promise<WorkflowRunRecord> {
  const loaded = await loadWorkflowSpec(specPath, cwd);
  const compiled = options.task !== undefined
    ? await compileWorkflow(loaded.spec, { cwd, specPath: loaded.specPath, task: options.task })
    : await compileWorkflowSpec(loaded.spec, { cwd, specPath: loaded.specPath });

  const { run } = await createRunRecord(cwd, compiled, loaded.specPath);
  await withRunLease(cwd, run.runId, async () => {
    await writeStaticRunArtifacts(cwd, run, compiled, loaded.spec);
    await writeRunRecord(cwd, run);
  });

  const scheduled = await scheduleRun(cwd, run.runId, compiled) ?? await readRunRecord(cwd, run.runId);
  if (scheduled.status === "running") watchRun(cwd, scheduled.runId);
  return scheduled;
}

export async function refreshRun(cwd: string, runIdOrPrefix: string): Promise<WorkflowRunRecord> {
  const current = await readRunRecord(cwd, runIdOrPrefix);
  const refreshed = await withRunLease(cwd, current.runId, async () => {
    const run = await readRunRecord(cwd, current.runId);
    return resolveWorkflowBackend(run).refreshRun(cwd, run);
  });
  return refreshed ?? current;
}

export async function waitForRun(cwd: string, runIdOrPrefix: string, timeoutMs?: number): Promise<WorkflowRunRecord> {
  const timeout = clampTimeout(timeoutMs);
  const deadline = Date.now() + timeout;
  let run = await refreshRun(cwd, runIdOrPrefix);

  while (run.status === "running") {
    await scheduleRun(cwd, run.runId);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Flow run still running after ${timeout}ms: ${run.runId}`);
    await sleep(Math.min(POLL_INTERVAL_MS, remaining));
    run = await refreshRun(cwd, run.runId);
  }

  return run;
}

export async function resumeSupervisors(cwd: string): Promise<void> {
  try {
    const runs = await listRunRecords(cwd);
    for (const run of runs) {
      if (run.status === "running") {
        await scheduleRun(cwd, run.runId).catch((error) => recordSupervisorError(cwd, run.runId, error));
        watchRun(cwd, run.runId);
      }
    }
    await updateIndex(cwd).catch((error) => recordSupervisorError(cwd, "index", error));
  } catch (error) {
    await recordSupervisorError(cwd, "index", error);
  }
}

export function watchRun(cwd: string, runId: string): void {
  const key = `${cwd}\0${runId}`;
  if (supervisorTimers.has(key)) return;

  const timer = setInterval(() => {
    void (async () => {
      const refreshed = await refreshRun(cwd, runId);
      if (refreshed.status === "running") {
        await scheduleRun(cwd, runId);
        return;
      }

      const existing = supervisorTimers.get(key);
      if (existing) clearInterval(existing);
      supervisorTimers.delete(key);
    })().catch((error) => {
      void recordSupervisorError(cwd, runId, error);
    });
  }, POLL_INTERVAL_MS);

  timer.unref?.();
  supervisorTimers.set(key, timer);
}

export async function scheduleRun(cwd: string, runId: string, compiled?: CompiledWorkflow): Promise<WorkflowRunRecord | undefined> {
  return withRunLease(cwd, runId, async () => {
    let run = await readRunRecord(cwd, runId);
    run = await resolveWorkflowBackend(run).refreshRun(cwd, run);
    if (run.taskSummary.blocked > 0 || isTerminalWorkflowStatus(run.status)) return run;

    const compiledFlow = compiled ?? await readCompiledWorkflow(cwd, run.runId);
    if (!compiledFlow) return run;

    if (compiledFlow.type === "chain") {
      await scheduleChain(cwd, run, compiledFlow);
    } else if (compiledFlow.type === "dag" || compiledFlow.type === "tree" || compiledFlow.type === STAGE_FIRST_RUN_TYPE) {
      await scheduleDag(cwd, run, compiledFlow);
    } else if (compiledFlow.type === "retry") {
      await scheduleRetry(cwd, run, compiledFlow);
    } else {
      await scheduleParallel(cwd, run, compiledFlow);
    }

    run = await readRunRecord(cwd, run.runId);
    return run;
  });
}

export async function formatStatus(cwd: string): Promise<string> {
  const cached = await readIndex(cwd);
  if (cached) {
    await reconcileIndexedActiveRuns(cwd, cached);
    const refreshed = await readIndex(cwd).catch(() => cached) ?? cached;
    if (refreshed.runs.length === 0) return "No workflow runs found.";
    return formatIndex(refreshed);
  }

  await reconcileActiveRuns(cwd);
  const rebuilt = await updateIndex(cwd).catch(() => readIndex(cwd));
  if (!rebuilt || rebuilt.runs.length === 0) return "No workflow runs found.";
  return formatIndex(rebuilt);
}

export async function formatRunDetails(cwd: string, runIdOrPrefix: string): Promise<string> {
  const run = await refreshRun(cwd, runIdOrPrefix);
  return formatRun(run, "full");
}

export async function formatRunStatus(cwd: string, runIdOrPrefix: string): Promise<string> {
  const run = await refreshRun(cwd, runIdOrPrefix);
  return formatRun(run, "summary");
}

export async function formatLogs(cwd: string, runIdOrPrefix: string, taskId = "task-1", lineCount = LOG_LINES_DEFAULT): Promise<string> {
  const run = await refreshRun(cwd, runIdOrPrefix);
  const task = run.tasks.find((item) => item.taskId === taskId || item.specId === taskId);
  if (!task) throw new Error(`Task not found in ${run.runId}: ${taskId}`);

  const outputFile = fromProjectPath(cwd, task.files.output);
  const count = Math.max(1, Math.min(LOG_LINES_MAX, Math.floor(lineCount || LOG_LINES_DEFAULT)));
  let text: string;
  try {
    text = await readFile(outputFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") text = "";
    else throw error;
  }

  const tail = text.split(/\r?\n/).slice(-count).join("\n").trim();
  return `${run.runId}/${task.taskId} output=${task.files.output}\n${tail || "(empty log)"}`;
}

export function formatRun(run: WorkflowRunRecord, detail: "summary" | "full" = "summary"): string {
  const lines = [
    `${run.runId} [${run.status}] type=${run.type} backend=${run.backend.type}/${run.backend.mode}`,
    `created=${run.createdAt} updated=${run.updatedAt}`,
    `tasks=${run.taskSummary.completed}/${run.taskSummary.total} completed, running=${run.taskSummary.running}, pending=${run.taskSummary.pending}, blocked=${run.taskSummary.blocked}, failed=${run.taskSummary.failed}, interrupted=${run.taskSummary.interrupted}`,
  ];

  for (const task of run.tasks) {
    lines.push(formatTask(task, detail));
  }

  return lines.join("\n");
}

async function reconcileActiveRuns(cwd: string): Promise<void> {
  const runs = await listRunRecords(cwd);
  for (const run of runs) {
    if (run.status === "running") await refreshRun(cwd, run.runId).catch((error) => recordSupervisorError(cwd, run.runId, error));
  }
}

async function reconcileIndexedActiveRuns(cwd: string, index: WorkflowIndexRecord): Promise<void> {
  for (const run of index.runs) {
    if (run.status === "running") await refreshRun(cwd, run.runId).catch((error) => recordSupervisorError(cwd, run.runId, error));
  }
}

async function recordSupervisorError(cwd: string, runId: string, error: unknown): Promise<void> {
  const file = runId === "index" ? indexSupervisorErrorPath(cwd) : supervisorPath(cwd, runId);
  await writeJsonAtomic(file, {
    schemaVersion: 1,
    status: "error",
    runId,
    pid: process.pid,
    updatedAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
  }).catch(() => undefined);
}

async function scheduleParallel(cwd: string, run: WorkflowRunRecord, compiledFlow: CompiledWorkflow): Promise<void> {
  const joinIndex = compiledFlow.tasks.findIndex((task) => isJoinTaskKind(task.kind));
  if (joinIndex === -1) {
    await scheduleParallelMainTasks(cwd, run, compiledFlow, allTaskIndexes(run));
    return;
  }

  const mainIndexes = allTaskIndexes(run).filter((index) => index !== joinIndex);
  await scheduleParallelMainTasks(cwd, run, compiledFlow, mainIndexes);

  const refreshed = await readRunRecord(cwd, run.runId);
  const mainTasks = mainIndexes.map((index) => refreshed.tasks[index]).filter((task): task is WorkflowTaskRunRecord => Boolean(task));
  if (mainTasks.some((task) => task.status === "pending" || task.status === "running")) return;
  if (refreshed.tasks.some((task, index) => index !== joinIndex && task.status === "blocked")) return;

  await launchPendingTaskAt(cwd, refreshed, compiledFlow, joinIndex, { join: true });
}

async function scheduleParallelMainTasks(cwd: string, run: WorkflowRunRecord, compiledFlow: CompiledWorkflow, indexes: number[]): Promise<void> {
  const maxConcurrency = Math.max(1, Math.min(MAX_CONCURRENCY, compiledFlow.maxConcurrency));
  let running = indexes.filter((index) => run.tasks[index]?.status === "running").length;

  for (const index of indexes) {
    if (running >= maxConcurrency) return;
    const launched = await launchPendingTaskAt(cwd, run, compiledFlow, index);
    if (launched) running += 1;
  }
}

function allTaskIndexes(run: WorkflowRunRecord): number[] {
  return run.tasks.map((_, index) => index);
}

async function scheduleDag(cwd: string, run: WorkflowRunRecord, compiledFlow: CompiledWorkflow): Promise<void> {
  let changed = markDagDependentsSkipped(run, compiledFlow);
  if (changed) {
    await writeRunRecord(cwd, run);
    run = await readRunRecord(cwd, run.runId);
  }

  const maxConcurrency = Math.max(1, Math.min(MAX_CONCURRENCY, compiledFlow.maxConcurrency));
  let running = run.tasks.filter((task) => task.status === "running").length;
  const bySpecId = new Map(run.tasks.map((task) => [task.specId, task]));

  for (let index = 0; index < run.tasks.length && running < maxConcurrency; index += 1) {
    const task = run.tasks[index];
    const compiledTask = compiledFlow.tasks[index];
    if (!task || !compiledTask || task.status !== "pending") continue;
    if (!dependenciesReady(compiledTask, bySpecId, compiledFlow)) continue;

    if (compiledTask.kind === "foreach" && compiledTask.foreach) {
      const changed = await materializeForeachTask(cwd, run, compiledFlow, index, compiledTask);
      if (changed) return;
    }

    if (compiledTask.stageMaxConcurrency !== undefined) {
      const runningInStage = run.tasks.filter((candidate) => candidate.stageId === compiledTask.stageId && candidate.status === "running").length;
      if (runningInStage >= Math.max(1, Math.min(MAX_CONCURRENCY, compiledTask.stageMaxConcurrency))) continue;
    }

    const launched = await launchPendingTaskAt(cwd, run, compiledFlow, index, { dag: true });
    if (launched) running += 1;
  }
}

async function materializeForeachTask(
  cwd: string,
  run: WorkflowRunRecord,
  compiledFlow: CompiledWorkflow,
  index: number,
  template: CompiledTask,
): Promise<boolean> {
  const templateRunTask = run.tasks[index];
  if (!templateRunTask || !template.foreach || !template.stageId) return false;

  const sourceStageIds = sourceStageIdsForFrom(template.foreach.from);
  const sourceTasks = run.tasks.filter((task) => sourceStageIds.includes(task.stageId ?? ""));
  const extracted = await extractStageFirstForeachItems(cwd, {
    from: template.foreach.from,
    sourcePolicy: stageSourcePolicy(compiledFlow, template.stageId),
    maxItems: template.foreach.maxItems,
  }, sourceTasks);

  if (extracted.error) {
    setTaskTerminal(templateRunTask, "blocked", "foreach_expansion_blocked", { lastMessage: extracted.error });
    await writeRunRecord(cwd, run);
    return true;
  }

  const items = extracted.items ?? [];
  const generated = buildForeachGeneratedTasks(template, compiledFlow.task, items);
  if (generated.error) {
    setTaskTerminal(templateRunTask, "blocked", "foreach_expansion_blocked", { lastMessage: generated.error });
    await writeRunRecord(cwd, run);
    return true;
  }

  const placeholderSpecId = template.id;
  const generatedSpecIds = generated.tasks.map((task) => task.id);
  compiledFlow.tasks.splice(index, 1, ...generated.tasks);
  updateDownstreamDependencies(compiledFlow, placeholderSpecId, generatedSpecIds);

  const nextIndex = nextTaskRecordIndex(run);
  const generatedRunTasks = generated.tasks.map((task, offset) => createTaskRunRecord(cwd, run.runId, task, nextIndex + offset));
  run.tasks.splice(index, 1, ...generatedRunTasks);
  for (const task of run.tasks) {
    if (!task.dependsOn) continue;
    task.dependsOn = replaceDependencyList(task.dependsOn, placeholderSpecId, generatedSpecIds);
  }

  await writeJsonAtomic(compiledWorkflowPath(cwd, run.runId), compiledFlow);
  await writeRunRecord(cwd, run);
  return true;
}

function nextTaskRecordIndex(run: WorkflowRunRecord): number {
  let max = 0;
  for (const task of run.tasks) {
    const match = /^task-(\d+)$/.exec(task.taskId);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}

function dependenciesReady(compiledTask: CompiledTask, bySpecId: Map<string, WorkflowTaskRunRecord>, compiledFlow: CompiledWorkflow): boolean {
  const deps = compiledTask.dependsOn ?? [];
  if (deps.length === 0) return true;
  const partial = stageSourcePolicy(compiledFlow, compiledTask.stageId ?? "") === "partial";
  return deps.every((dep) => {
    const status = bySpecId.get(dep)?.status;
    if (status === "completed") return true;
    if (partial && status && isTerminalTaskStatus(status)) return true;
    return false;
  });
}

function buildForeachGeneratedTasks(template: CompiledTask, runtimeTask: string | undefined, items: unknown[]): { tasks: CompiledTask[]; error?: string } {
  const seen = new Set<string>();
  const tasks: CompiledTask[] = [];
  for (const [index, item] of items.entries()) {
    const taskId = foreachItemTaskId(item, index);
    if (seen.has(taskId)) return { tasks: [], error: `duplicate foreach generated task id "${taskId}"` };
    seen.add(taskId);
    const specId = `${template.stageId}.${taskId}`;
    const itemText = formatForeachItem(item);
    const instructions = template.foreach!.prompt.replace(/\$\{item\}/g, itemText);
    const compiledPrompt = [
      template.foreach!.injectRuntimeTask && runtimeTask ? `# Task\n\n${runtimeTask}` : undefined,
      `# Workflow Stage\n\nstage=${template.stageId}\ntype=foreach\nitem=${taskId}`,
      `# Instructions\n\n${instructions}`,
      formatOutputTemplateSection(template.output),
      template.foreach!.roleText || undefined,
    ].filter(Boolean).join("\n\n");
    tasks.push({
      ...template,
      id: specId,
      key: specId,
      specId,
      taskId,
      task: instructions,
      compiledPrompt,
      dependsOn: [...(template.dependsOn ?? [])],
      foreach: undefined,
    } as CompiledTask);
  }
  return { tasks };
}

function foreachItemTaskId(item: unknown, index: number): string {
  if (item && typeof item === "object" && typeof (item as any).id === "string") {
    const sanitized = sanitizeTaskId((item as any).id);
    if (sanitized) return sanitized;
  }
  return `item-${String(index + 1).padStart(3, "0")}`;
}

function sanitizeTaskId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

function formatForeachItem(item: unknown): string {
  return typeof item === "string" ? item : JSON.stringify(item);
}

function sourceStageIdsForFrom(from: unknown): string[] {
  if (Array.isArray(from)) return from.filter((item): item is string => typeof item === "string");
  if (typeof from === "string") return [from];
  if (from && typeof from === "object" && typeof (from as any).stage === "string") return [(from as any).stage];
  return [];
}

function stageSourcePolicy(compiledFlow: CompiledWorkflow, stageId: string): string {
  return ((compiledFlow as any).stages ?? []).find((stage: any) => stage.id === stageId)?.sourcePolicy ?? "require-success";
}

function updateDownstreamDependencies(compiledFlow: CompiledWorkflow, placeholderSpecId: string, generatedSpecIds: string[]): void {
  for (const task of compiledFlow.tasks) {
    if (!task.dependsOn) continue;
    task.dependsOn = replaceDependencyList(task.dependsOn, placeholderSpecId, generatedSpecIds);
  }
}

function replaceDependencyList(dependsOn: string[], placeholderSpecId: string, generatedSpecIds: string[]): string[] {
  const replaced: string[] = [];
  for (const dep of dependsOn) {
    if (dep === placeholderSpecId) replaced.push(...generatedSpecIds);
    else replaced.push(dep);
  }
  return [...new Set(replaced)];
}

function markDagDependentsSkipped(run: WorkflowRunRecord, compiledFlow: CompiledWorkflow): boolean {
  const bySpecId = new Map(run.tasks.map((task) => [task.specId, task]));
  let changed = false;
  let passChanged = true;

  while (passChanged) {
    passChanged = false;
    for (const [index, task] of run.tasks.entries()) {
      if (task.status !== "pending") continue;
      const compiledTask = compiledFlow.tasks[index];
      if (!compiledTask) continue;
      const failedDep = (compiledTask.dependsOn ?? []).find((dep) => {
        const status = bySpecId.get(dep)?.status;
        return status === "failed" || status === "interrupted" || status === "skipped";
      });
      if (!failedDep) continue;
      if (stageSourcePolicy(compiledFlow, compiledTask.stageId ?? "") === "partial") continue;
      setTaskTerminal(task, "skipped", "skipped_after_dependency_failure", {
        lastMessage: `skipped because dependency ${failedDep} did not complete`,
      });
      changed = true;
      passChanged = true;
    }
  }

  return changed;
}

async function scheduleRetry(cwd: string, run: WorkflowRunRecord, compiledFlow: CompiledWorkflow): Promise<void> {
  if (run.tasks.some((task) => task.status === "running")) return;

  const completedIndex = run.tasks.findIndex((task) => task.status === "completed");
  if (completedIndex !== -1) {
    await skipRemainingRetryTasks(cwd, run, completedIndex + 1);
    return;
  }

  const pendingIndex = run.tasks.findIndex((task) => task.status === "pending");
  if (pendingIndex === -1) return;
  const previous = pendingIndex > 0 ? run.tasks[pendingIndex - 1] : undefined;
  if (previous && !isTerminalTaskStatus(previous.status)) return;
  if (previous && previous.status !== "failed" && previous.status !== "interrupted") return;

  await launchPendingTaskAt(cwd, run, compiledFlow, pendingIndex, { retry: true });
}

async function scheduleChain(cwd: string, run: WorkflowRunRecord, compiledFlow: CompiledWorkflow): Promise<void> {
  if (run.tasks.some((task) => task.status === "running")) return;

  const failedIndex = run.tasks.findIndex((task) => task.status === "failed" || task.status === "interrupted");
  if (failedIndex !== -1) {
    await skipRemainingChainTasks(cwd, run, failedIndex + 1);
    return;
  }

  const pendingIndex = run.tasks.findIndex((task) => task.status === "pending");
  if (pendingIndex === -1) return;

  const previousComplete = run.tasks.slice(0, pendingIndex).every((task) => task.status === "completed");
  if (!previousComplete) return;

  await launchPendingTaskAt(cwd, run, compiledFlow, pendingIndex, { chain: true });
}

async function launchPendingTaskAt(
  cwd: string,
  run: WorkflowRunRecord,
  compiledFlow: CompiledWorkflow,
  index: number,
  options: { chain?: boolean; join?: boolean; dag?: boolean; retry?: boolean } = {},
): Promise<boolean> {
  const task = run.tasks[index];
  if (!task || task.status !== "pending") return false;
  if (task.backendHandle || task.pid) return false;

  const compiledTask = compiledFlow.tasks[index];
  if (!compiledTask) {
    setTaskTerminal(task, "failed", "compile_missing", { lastMessage: "compiled task is missing" });
    await writeRunRecord(cwd, run);
    return false;
  }

  let launchTask = options.retry
    ? await prepareRetryTask(cwd, run, compiledFlow, index)
    : options.chain
      ? await prepareChainTask(cwd, run, compiledFlow, index)
      : options.join
        ? await prepareJoinTask(cwd, run, compiledFlow, index)
        : options.dag
          ? await prepareDagTask(cwd, run, compiledFlow, index)
          : compiledTask;
  if (task.outputRetry) launchTask = await prepareOutputRetryTask(cwd, task, launchTask);

  try {
    await ensureManagedWorktree(cwd, run, task, launchTask);
    await writeRunRecord(cwd, run);
    const launch = await resolveWorkflowBackend(run).launchTask(cwd, run, task, launchTask);
    if (launch.kind === "fatal") throw new Error(launch.message);
    return launch.kind === "launched";
  } catch (error) {
    setTaskTerminal(task, "failed", launchTask.safety.requiresWorktree ? "worktree_failed" : "launch_failed", {
      lastMessage: error instanceof Error ? error.message : String(error),
    });
    await writeRunRecord(cwd, run).catch(() => undefined);
    if (compiledFlow.type === "chain") await skipRemainingChainTasks(cwd, run, index + 1);
    if (compiledFlow.type === "dag" || compiledFlow.type === "tree" || compiledFlow.type === STAGE_FIRST_RUN_TYPE) {
      markDagDependentsSkipped(run, compiledFlow);
      await writeRunRecord(cwd, run).catch(() => undefined);
    }
    return false;
  }
}

async function prepareChainTask(
  cwd: string,
  run: WorkflowRunRecord,
  compiledFlow: CompiledWorkflow,
  index: number,
): Promise<CompiledWorkflow["tasks"][number]> {
  const compiledTask = compiledFlow.tasks[index]!;
  const task = run.tasks[index]!;
  const previousTask = index > 0 ? run.tasks[index - 1] : undefined;
  const inheritedWorktree = findInheritedWorktree(run, index);

  if (inheritedWorktree && !compiledTask.explicitCwd && !compiledTask.explicitWorktreePolicy) {
    task.cwd = inheritedWorktree.path;
    task.worktree = {
      enabled: true,
      path: inheritedWorktree.path,
      branch: inheritedWorktree.branch,
      baseCwd: inheritedWorktree.baseCwd,
      warning: "inherited from previous chain step",
    };
  }

  if (!previousTask) return compiledTask;

  const previousOutput = previousTask.files.output;
  const previousSummary = await readOutputPreview(cwd, previousOutput);
  return {
    ...compiledTask,
    cwd: task.cwd,
    compiledPrompt: [
      compiledTask.compiledPrompt,
      "# Previous Chain Step",
      `Previous task: ${previousTask.taskId} (${previousTask.specId})`,
      `Previous status: ${previousTask.status}`,
      `Previous output path: ${previousOutput}`,
      "Previous output preview:",
      previousSummary || "(empty output)",
    ].join("\n\n"),
  };
}

async function prepareDagTask(
  cwd: string,
  run: WorkflowRunRecord,
  compiledFlow: CompiledWorkflow,
  index: number,
): Promise<CompiledWorkflow["tasks"][number]> {
  const compiledTask = compiledFlow.tasks[index]!;
  const task = run.tasks[index]!;
  const dependsOn = compiledTask.dependsOn ?? [];
  if (dependsOn.length === 0) return compiledTask;

  const bySpecId = new Map(run.tasks.map((sourceTask) => [sourceTask.specId, sourceTask]));
  const sourceTasks = dependsOn.map((dep) => bySpecId.get(dep)).filter((sourceTask): sourceTask is WorkflowTaskRunRecord => Boolean(sourceTask));
  const missing = dependsOn.filter((dep) => !bySpecId.has(dep));
  const context = await buildRunSourceContext(cwd, run, sourceTasks, sourceContextOptions(compiledTask));

  return {
    ...compiledTask,
    cwd: task.cwd,
    compiledPrompt: [
      compiledTask.compiledPrompt,
      "# Source Stage Context",
      "Use this deterministic source context packet. Prefer structuredOutput over outputPreview. Do not assume dependencies beyond this explicit packet.",
      JSON.stringify({ ...context, missingDependencies: missing }, null, 2),
    ].join("\n\n"),
  };
}

async function prepareJoinTask(
  cwd: string,
  run: WorkflowRunRecord,
  compiledFlow: CompiledWorkflow,
  joinIndex: number,
): Promise<CompiledWorkflow["tasks"][number]> {
  const compiledTask = compiledFlow.tasks[joinIndex]!;
  const task = run.tasks[joinIndex]!;
  const label = joinContextLabel(compiledTask.kind);
  const sourceTasks = run.tasks.filter((_, index) => index !== joinIndex);
  const context = await buildRunSourceContext(cwd, run, sourceTasks, sourceContextOptions(compiledTask));

  return {
    ...compiledTask,
    cwd: task.cwd,
    compiledPrompt: [
      compiledTask.compiledPrompt,
      `# ${label} Context`,
      "Use this deterministic source context packet. Prefer structuredOutput over outputPreview. Do not assume all tasks succeeded.",
      JSON.stringify(context, null, 2),
    ].join("\n\n"),
  };
}

async function prepareRetryTask(
  cwd: string,
  run: WorkflowRunRecord,
  compiledFlow: CompiledWorkflow,
  index: number,
): Promise<CompiledWorkflow["tasks"][number]> {
  const compiledTask = compiledFlow.tasks[index]!;
  const task = run.tasks[index]!;
  const previousOutputPath = run.tasks[index - 1]?.files.output ?? task.files.output;
  const previousOutput = await readOutputPreview(cwd, previousOutputPath, 1200);

  return {
    ...compiledTask,
    cwd: task.cwd,
    compiledPrompt: [
      compiledTask.compiledPrompt,
      "# Retry Instructions",
      "Retry after previous task failure.",
      "# Previous Retry Attempt",
      `Previous task: ${task.taskId} (${task.specId})`,
      `Previous status: ${task.status}/${task.statusDetail}`,
      `Previous output: ${previousOutputPath}`,
      "Previous output preview:",
      previousOutput || "(empty or unavailable)",
    ].join("\n\n"),
  };
}

async function prepareOutputRetryTask(
  cwd: string,
  task: WorkflowTaskRunRecord,
  preparedTask: CompiledWorkflow["tasks"][number],
): Promise<CompiledWorkflow["tasks"][number]> {
  const retryInstructions = buildJsonOutputRetryInstructions(task);
  const invalidAttempt = task.outputRetry?.attempts ? `${task.files.output}.invalid-attempt-${task.outputRetry.attempts}` : task.files.output;
  const previousOutput = await readOutputPreview(cwd, invalidAttempt, 1200);

  return {
    ...preparedTask,
    cwd: task.cwd,
    compiledPrompt: [
      preparedTask.compiledPrompt,
      "# Output Contract Retry Instructions",
      retryInstructions,
      "# Previous Invalid Output Attempt",
      `Previous task: ${task.taskId} (${task.specId})`,
      `Previous status: ${task.status}/${task.statusDetail}`,
      `Previous output: ${invalidAttempt}`,
      "Previous output preview:",
      previousOutput || "(empty or unavailable)",
    ].join("\n\n"),
  };
}

async function skipRemainingRetryTasks(cwd: string, run: WorkflowRunRecord, startIndex: number): Promise<void> {
  let changed = false;
  for (const task of run.tasks.slice(startIndex)) {
    if (task.status !== "pending") continue;
    setTaskTerminal(task, "skipped", "retry_not_needed", { lastMessage: "skipped because an earlier retry attempt completed" });
    changed = true;
  }
  if (changed) await writeRunRecord(cwd, run);
}

async function skipRemainingChainTasks(cwd: string, run: WorkflowRunRecord, startIndex: number): Promise<void> {
  let changed = false;
  for (const task of run.tasks.slice(startIndex)) {
    if (task.status !== "pending") continue;
    setTaskTerminal(task, "skipped", "skipped_after_failure", { lastMessage: "skipped because an earlier chain step failed" });
    changed = true;
  }
  if (changed) await writeRunRecord(cwd, run);
}

function isJoinTaskKind(kind: CompiledWorkflow["tasks"][number]["kind"]): boolean {
  return kind === "aggregate" || kind === "judge" || kind === "vote";
}

function joinContextLabel(kind: CompiledWorkflow["tasks"][number]["kind"]): string {
  if (kind === "judge") return "Judge";
  if (kind === "vote") return "Vote";
  return "Parallel Aggregate";
}

function findInheritedWorktree(run: WorkflowRunRecord, beforeIndex: number): { path: string; branch: string | null; baseCwd: string | null } | undefined {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const worktree = run.tasks[index]?.worktree;
    if (worktree?.enabled && worktree.path) {
      return { path: worktree.path, branch: worktree.branch, baseCwd: worktree.baseCwd };
    }
  }
  return undefined;
}

function sourceContextOptions(task: Pick<CompiledTask, "sourceContext">): SourceContextPacketOptions {
  const sourceContext = task.sourceContext ?? {};
  return {
    maxPreviewChars: sourceContext.maxPreviewChars ?? SOURCE_CONTEXT_PREVIEW_CHARS,
    maxStructuredChars: sourceContext.maxStructuredChars ?? SOURCE_CONTEXT_STRUCTURED_CHARS,
    maxStructuredCharsByStage: sourceContext.maxStructuredCharsByStage,
    structuredOutputPathsByStage: sourceContext.structuredOutputPathsByStage,
    maxPacketChars: sourceContext.maxPacketChars ?? SOURCE_CONTEXT_MAX_PACKET_CHARS,
  };
}

export async function buildRunSourceContext(
  cwd: string,
  run: Pick<WorkflowRunRecord, "createdAt" | "updatedAt"> & { tasks: WorkflowTaskRunRecord[] },
  sourceTasks: WorkflowTaskRunRecord[],
  options: Pick<SourceContextPacketOptions, "maxPreviewChars" | "maxStructuredChars" | "maxStructuredCharsByStage" | "structuredOutputPathsByStage" | "maxPacketChars"> = {},
): Promise<{ telemetry: ReturnType<typeof summarizeWorkflowTelemetry>; packet: ReturnType<typeof buildSourceContextPacket> }> {
  const maxPreviewChars = options.maxPreviewChars ?? SOURCE_CONTEXT_PREVIEW_CHARS;
  const maxStructuredChars = options.maxStructuredChars ?? SOURCE_CONTEXT_STRUCTURED_CHARS;
  const maxPacketChars = options.maxPacketChars ?? SOURCE_CONTEXT_MAX_PACKET_CHARS;
  const structuredOutputsByTaskId: Record<string, unknown> = {};
  const rawOutputsByTaskId: Record<string, string> = {};
  const outputBytesByTaskId: Record<string, number> = {};

  await Promise.all(sourceTasks.map(async (task) => {
    const [result, output] = await Promise.all([
      readJson<{ structuredOutput?: unknown }>(fromProjectPath(cwd, task.files.result)).catch(() => undefined),
      readOutputText(cwd, task.files.output),
    ]);
    if (result && Object.prototype.hasOwnProperty.call(result, "structuredOutput")) structuredOutputsByTaskId[task.taskId] = result.structuredOutput;
    rawOutputsByTaskId[task.taskId] = output.text;
    outputBytesByTaskId[task.files.output] = output.bytes;
  }));

  return {
    telemetry: summarizeWorkflowTelemetry(run, { outputBytesByTaskId }),
    packet: buildSourceContextPacket({ tasks: sourceTasks }, {
      structuredOutputsByTaskId,
      rawOutputsByTaskId,
      maxPreviewChars,
      maxStructuredChars,
      maxStructuredCharsByStage: options.maxStructuredCharsByStage,
      structuredOutputPathsByStage: options.structuredOutputPathsByStage,
      maxPacketChars,
    }),
  };
}

async function readOutputText(cwd: string, projectPath: string): Promise<{ text: string; bytes: number }> {
  try {
    const text = await readFile(fromProjectPath(cwd, projectPath), "utf8");
    return { text, bytes: Buffer.byteLength(text, "utf8") };
  } catch {
    return { text: "", bytes: 0 };
  }
}

async function readOutputPreview(cwd: string, projectPath: string, maxChars = 4000): Promise<string> {
  const output = await readOutputText(cwd, projectPath);
  return output.text.trim().slice(0, maxChars);
}

async function readCompiledWorkflow(cwd: string, runId: string): Promise<CompiledWorkflow | undefined> {
  return readJson<CompiledWorkflow>(compiledWorkflowPath(cwd, runId));
}

function formatIndex(index: WorkflowIndexRecord): string {
  return index.runs.map((run) => {
    const lines = [
      `${run.runId} [${run.status}] type=${run.type} updated=${run.updatedAt}`,
      `tasks=${run.taskSummary.completed}/${run.taskSummary.total} completed, running=${run.taskSummary.running}, pending=${run.taskSummary.pending}, blocked=${run.taskSummary.blocked}, failed=${run.taskSummary.failed}`,
    ];
    for (const task of run.tasks) {
      const message = task.lastMessage ? ` — ${task.lastMessage}` : "";
      const kind = task.kind && task.kind !== "main" ? ` ${task.kind}` : "";
      lines.push(`- ${task.taskId}${kind} ${task.agent} [${task.status}/${task.statusDetail}]${message}`);
    }
    return lines.join("\n");
  }).join("\n\n");
}

function formatTask(task: WorkflowTaskRunRecord, detail: "summary" | "full"): string {
  const elapsed = task.elapsedMs !== undefined ? ` elapsed=${Math.round(task.elapsedMs / 1000)}s` : "";
  const pid = task.pid ? ` pid=${task.pid}` : "";
  const runtime = `model=${task.runtime.model ?? "inherit"} thinking=${task.runtime.thinking ?? "inherit"}`;
  const message = task.lastMessage ? `\n  last=${task.lastMessage}` : "";
  const worktree = task.worktree.enabled ? `\n  worktree=${task.worktree.path}` : "";
  const deps = task.dependsOn && task.dependsOn.length > 0 ? `\n  dependsOn=${task.dependsOn.join(",")}` : "";
  const full = detail === "full"
    ? `\n  agentFile=${task.agentFile}\n  cwd=${task.cwd}${worktree}${deps}\n  tools=${task.tools?.join(",") ?? "(Pi default)"}\n  output=${task.files.output}\n  stderr=${task.files.stderr}\n  result=${task.files.result}`
    : ` output=${task.files.output}`;

  const kind = task.kind && task.kind !== "main" ? ` kind=${task.kind}` : "";
  return `- ${task.taskId}${kind} spec=${task.specId} agent=${task.agent} [${task.status}/${task.statusDetail}]${elapsed}${pid} ${runtime}${full}${message}`;
}

function clampTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_WAIT_TIMEOUT_MS;
  return Math.max(POLL_INTERVAL_MS, Math.min(MAX_WAIT_TIMEOUT_MS, Math.floor(value)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runWorkflow(specPath: string, cwd: string, options: { task?: string } = {}): Promise<WorkflowRunRecord> {
  if (!options.task || options.task.trim() === "") throw new Error("This workflow needs a task");
  return runWorkflowSpec(specPath, cwd, options);
}
export const waitForWorkflowRun = waitForRun;
export async function continueWorkflow(_cwd: string, _runId: string): Promise<WorkflowRunRecord | undefined> {
  return undefined;
}
