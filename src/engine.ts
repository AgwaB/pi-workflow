import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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
  resetTaskForResume,
  setTaskTerminal,
  supervisorPath,
  updateIndex,
  withRunLease,
  workflowRunDir,
  writeJsonAtomic,
  writeRunRecord,
  writeStaticRunArtifacts,
} from "./store.js";
import { resolveWorkflowBackend } from "./backend.js";
import { ensureManagedWorktree } from "./worktree.js";
import { buildJsonOutputRetryInstructions } from "./result.js";
import { loadWorkflowHelper } from "./workflow-helpers.js";
import { buildSourceContextPacket, formatOutputTemplateSection, summarizeWorkflowTelemetry, type SourceContextPacketOptions } from "./workflow-artifacts.js";
import { extractStageFirstForeachItems, readSimpleJsonPath } from "./workflow-runtime.js";
import {
  CompiledTask,
  CompiledWorkflow,
  LoopResultStatus,
  LoopStateRecord,
  LoopUntilCondition,
  STAGE_FIRST_RUN_TYPE,
  WorkflowIndexRecord,
  WorkflowRunRecord,
  WorkflowTaskRunRecord,
} from "./types.js";

const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
const MAX_WAIT_TIMEOUT_MS = 14_400_000;
const POLL_INTERVAL_MS = 1_000;
const LOG_LINES_DEFAULT = 80;
const LOG_LINES_MAX = 400;
const MAX_CONCURRENCY = 16;
const LOOP_CARRY_FORWARD_MAX_CHARS = 4000;
const LOOP_SUMMARY_MAX_CHARS = 1200;
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

export interface ResumeRunSummary {
  run: WorkflowRunRecord;
  resetTaskIds: string[];
}

export async function resumeRun(cwd: string, runIdOrPrefix: string): Promise<ResumeRunSummary> {
  const current = await readRunRecord(cwd, runIdOrPrefix);
  if (current.status !== "failed" && current.status !== "interrupted") {
    throw new Error(`resume requires a failed or interrupted run; ${current.runId} is ${current.status}`);
  }
  const compiledFlow = await readCompiledWorkflow(cwd, current.runId);
  const hasLoopTasks = compiledFlow?.tasks.some((task) => task.kind === "loop" || task.loopPlaceholder !== undefined || task.loopChild !== undefined) ?? false;
  if (hasLoopTasks || (current.loopStates?.length ?? 0) > 0) {
    throw new Error(`resume does not support loop workflows yet: ${current.runId}`);
  }

  const resetTaskIds: string[] = [];
  const updated = await withRunLease(cwd, current.runId, async () => {
    const run = await readRunRecord(cwd, current.runId);
    for (const task of run.tasks) {
      if (resetTaskForResume(task)) resetTaskIds.push(task.taskId);
    }
    if (resetTaskIds.length > 0) await writeRunRecord(cwd, run);
    return run;
  });
  if (!updated) throw new Error(`Could not acquire supervisor lease for ${current.runId}; another supervisor may be active`);
  if (resetTaskIds.length === 0) throw new Error(`No failed, interrupted, or skipped tasks to resume in ${current.runId}`);

  const scheduled = await scheduleRun(cwd, current.runId) ?? await readRunRecord(cwd, current.runId);
  if (scheduled.status === "running") watchRun(cwd, scheduled.runId);
  return { run: scheduled, resetTaskIds };
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
  if (compiledFlow.type === STAGE_FIRST_RUN_TYPE) {
    const reconciled = await reconcileLoopTaskMaterialization(cwd, run, compiledFlow);
    if (reconciled) return;
    assertRunTaskPositionalAlignment(run, compiledFlow);
  }

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

    if (compiledTask.kind === "loop" && compiledTask.loopPlaceholder) {
      const changed = await scheduleLoop(cwd, run, compiledFlow, index, compiledTask);
      if (changed) return;
      continue;
    }

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

async function scheduleLoop(
  cwd: string,
  run: WorkflowRunRecord,
  compiledFlow: CompiledWorkflow,
  placeholderIndex: number,
  placeholder: CompiledTask,
): Promise<boolean> {
  const loopId = placeholder.loopPlaceholder?.loopId ?? placeholder.stageId;
  if (!loopId) return false;
  const loopStage = findLoopStageRecord(compiledFlow, loopId);
  const placeholderRunTask = run.tasks[placeholderIndex];
  if (!loopStage || !placeholderRunTask) return false;

  const state = getLoopState(run, loopId);
  if (state?.awaitingOnExhausted) {
    const exhaustedTask = findLoopExhaustedRunTask(run, compiledFlow, loopId);
    if (exhaustedTask && !isTerminalTaskStatus(exhaustedTask.status)) return false;
    await finalizeLoop(cwd, run, compiledFlow, placeholderRunTask, loopStage, state.status ?? "exhausted", state.round || latestLoopRound(compiledFlow, loopId));
    return true;
  }

  const currentRound = latestLoopRound(compiledFlow, loopId);
  if (currentRound === 0) {
    await materializeLoopRound(cwd, run, compiledFlow, placeholderIndex, placeholder, loopStage, 1);
    return true;
  }

  const roundTasks = getLoopRoundRunTasks(run, compiledFlow, loopId, currentRound);
  if (roundTasks.length === 0) return false;
  if (roundTasks.some((task) => !isTerminalTaskStatus(task.status))) return false;

  if (await evaluateLoopUntilCondition(cwd, run, compiledFlow, loopId, currentRound, loopStage.until)) {
    await finalizeLoop(cwd, run, compiledFlow, placeholderRunTask, loopStage, "completed", currentRound);
    return true;
  }

  if (currentRound >= loopStage.maxRounds) {
    await stopLoopOrRunOnExhausted(cwd, run, compiledFlow, placeholderRunTask, loopStage, "exhausted", currentRound);
    return true;
  }

  if (await loopHasNoProgress(cwd, run, compiledFlow, loopStage, loopId, currentRound)) {
    await stopLoopOrRunOnExhausted(cwd, run, compiledFlow, placeholderRunTask, loopStage, "stopped_no_progress", currentRound);
    return true;
  }

  await materializeLoopRound(cwd, run, compiledFlow, placeholderIndex, placeholder, loopStage, currentRound + 1);
  return true;
}

async function stopLoopOrRunOnExhausted(
  cwd: string,
  run: WorkflowRunRecord,
  compiledFlow: CompiledWorkflow,
  placeholderRunTask: WorkflowTaskRunRecord,
  loopStage: any,
  status: LoopResultStatus,
  round: number,
): Promise<void> {
  if (loopStage.onExhausted) {
    const exhaustedTask = findLoopExhaustedRunTask(run, compiledFlow, loopStage.id);
    if (!exhaustedTask) {
      await materializeLoopOnExhausted(cwd, run, compiledFlow, loopStage, status, round);
      return;
    }
    const state = ensureLoopState(run, loopStage.id);
    state.status = status;
    state.round = round;
    state.awaitingOnExhausted = true;
    state.onExhaustedSpecId = exhaustedTask.specId;
    state.updatedAt = new Date().toISOString();
    if (!isTerminalTaskStatus(exhaustedTask.status)) {
      await writeRunRecord(cwd, run);
      return;
    }
  }

  await finalizeLoop(cwd, run, compiledFlow, placeholderRunTask, loopStage, status, round);
}

async function materializeLoopRound(
  cwd: string,
  run: WorkflowRunRecord,
  compiledFlow: CompiledWorkflow,
  placeholderIndex: number,
  placeholder: CompiledTask,
  loopStage: any,
  round: number,
): Promise<void> {
  const childTemplates = (loopStage.childTemplates ?? []) as CompiledTask[];
  const roundTag = `r${String(round).padStart(2, "0")}`;
  const countsByChildStage = new Map<string, number>();
  for (const template of childTemplates) {
    const childStageId = template.stageId ?? template.id.split(".")[0] ?? "child";
    countsByChildStage.set(childStageId, (countsByChildStage.get(childStageId) ?? 0) + 1);
  }

  const localToRoundSpecId = new Map<string, string>();
  for (const template of childTemplates) {
    const childStageId = template.stageId ?? template.id.split(".")[0] ?? "child";
    const childTaskId = template.taskId ?? "main";
    const singleTaskChild = (countsByChildStage.get(childStageId) ?? 0) === 1;
    const specId = singleTaskChild && childTaskId === "main"
      ? `${loopStage.id}.${roundTag}.${childStageId}`
      : `${loopStage.id}.${roundTag}.${childStageId}.${childTaskId}`;
    localToRoundSpecId.set(template.id, specId);
  }

  const entryDependsOn = round === 1
    ? [...(placeholder.dependsOn ?? [])]
    : getLoopRoundRunTasks(run, compiledFlow, loopStage.id, round - 1).map((task) => task.specId);
  const firstChildStageId = loopStage.childStageIds?.[0];
  const carryForward = round > 1 ? await buildLoopCarryForwardContext(cwd, run, compiledFlow, loopStage, loopStage.id, round) : "";
  const generatedTasks = childTemplates.map((template) => {
    const childStageId = template.stageId ?? template.id.split(".")[0] ?? "child";
    const childTaskId = template.taskId ?? "main";
    const roundStageId = `${loopStage.id}.${roundTag}.${childStageId}`;
    const rawDependsOn = template.dependsOn ?? [];
    const dependsOn = rawDependsOn.length > 0
      ? rawDependsOn.map((dep) => localToRoundSpecId.get(dep) ?? dep)
      : [...entryDependsOn];
    const sourcePolicy = childStageId === firstChildStageId && round > 1
      ? "partial"
      : loopChildSourcePolicy(loopStage, childStageId);
    ensureGeneratedStageRecord(compiledFlow, roundStageId, template.kind, sourcePolicy);
    const loopRoundPrompt = [
      template.compiledPrompt,
      "# Loop Round",
      `loop=${loopStage.id}`,
      `round=${round}`,
      `childStage=${childStageId}`,
      carryForward && childStageId === firstChildStageId ? `# Loop Carry-Forward Context\n\n${carryForward}` : undefined,
    ].filter(Boolean).join("\n\n");
    const specId = localToRoundSpecId.get(template.id)!;
    return {
      ...template,
      id: specId,
      key: specId,
      specId,
      taskId: childTaskId,
      stageId: roundStageId,
      dependsOn,
      foreach: undefined,
      compiledPrompt: loopRoundPrompt,
      loopChild: {
        loopId: loopStage.id,
        round,
        roundTag,
        childStageId,
        childTaskId,
        firstChildStage: childStageId === firstChildStageId,
      },
    } as CompiledTask;
  });

  upsertCompiledLoopTasksAtInsertion(compiledFlow, loopStage.id, placeholderIndex, generatedTasks);
  reconcileLoopTaskRecordsInMemory(cwd, run, compiledFlow, new Set([loopStage.id]));
  assertLoopTaskPositionalAlignment(run, compiledFlow, new Set([loopStage.id]));

  const state = ensureLoopState(run, loopStage.id);
  state.round = round;
  state.awaitingOnExhausted = false;
  state.status = undefined;
  state.onExhaustedSpecId = undefined;
  state.updatedAt = new Date().toISOString();
  run.round = round;

  await writeJsonAtomic(compiledWorkflowPath(cwd, run.runId), compiledFlow);
  await writeRunRecord(cwd, run);
}

async function materializeLoopOnExhausted(
  cwd: string,
  run: WorkflowRunRecord,
  compiledFlow: CompiledWorkflow,
  loopStage: any,
  status: LoopResultStatus,
  round: number,
): Promise<void> {
  const template = loopStage.onExhausted?.template as CompiledTask | undefined;
  if (!template) return;
  const stageId = `${loopStage.id}.onExhausted`;
  const specId = `${stageId}.${loopStage.onExhausted.stageId ?? "summary"}`;
  const dependsOn = getLoopRunTasksThroughRound(run, compiledFlow, loopStage.id, round).map((task) => task.specId);
  const context = await buildLoopTerminalContext(cwd, run, compiledFlow, loopStage, status, round);
  const task: CompiledTask = {
    ...template,
    id: specId,
    key: specId,
    specId,
    taskId: loopStage.onExhausted.stageId ?? "summary",
    stageId,
    dependsOn,
    compiledPrompt: [
      template.compiledPrompt,
      "# Loop Exhaustion Context",
      context,
    ].join("\n\n"),
    loopExhausted: { loopId: loopStage.id, status },
  } as CompiledTask;

  ensureGeneratedStageRecord(compiledFlow, stageId, "reduce", "partial");
  const placeholderIndex = compiledFlow.tasks.findIndex((candidate) => candidate.loopPlaceholder?.loopId === loopStage.id);
  upsertCompiledLoopTasksAtInsertion(compiledFlow, loopStage.id, placeholderIndex, [task]);
  reconcileLoopTaskRecordsInMemory(cwd, run, compiledFlow, new Set([loopStage.id]));
  assertLoopTaskPositionalAlignment(run, compiledFlow, new Set([loopStage.id]));

  const state = ensureLoopState(run, loopStage.id);
  state.round = round;
  state.status = status;
  state.awaitingOnExhausted = true;
  state.onExhaustedSpecId = specId;
  state.updatedAt = new Date().toISOString();

  await writeJsonAtomic(compiledWorkflowPath(cwd, run.runId), compiledFlow);
  await writeRunRecord(cwd, run);
}

async function finalizeLoop(
  cwd: string,
  run: WorkflowRunRecord,
  compiledFlow: CompiledWorkflow,
  placeholderRunTask: WorkflowTaskRunRecord,
  loopStage: any,
  status: LoopResultStatus,
  round: number,
): Promise<void> {
  const finalCheck = await readLoopStageStructuredOutput(cwd, run, compiledFlow, loopStage.id, round, loopDesignatedCheckStageId(loopStage));
  const worktreePath = findLoopWorktreePath(run, loopStage.id);
  const summary = buildLoopResultSummary(status, round, worktreePath, finalCheck);
  upsertLoopResult(run, {
    loopId: loopStage.id,
    status,
    roundsUsed: round,
    worktreePath,
    finalCheck,
    summary,
  });
  const state = ensureLoopState(run, loopStage.id);
  state.round = round;
  state.status = status;
  state.awaitingOnExhausted = false;
  state.updatedAt = new Date().toISOString();
  setTaskTerminal(placeholderRunTask, "completed", `loop_${status}`, { lastMessage: summary });
  await writeRunRecord(cwd, run);
}

export async function evaluateLoopUntilCondition(
  cwd: string,
  run: WorkflowRunRecord,
  compiledFlow: CompiledWorkflow,
  loopId: string,
  round: number,
  condition: LoopUntilCondition,
): Promise<boolean> {
  const candidate = condition as any;
  if (Array.isArray(candidate.all)) {
    for (const item of candidate.all) {
      if (!await evaluateLoopUntilCondition(cwd, run, compiledFlow, loopId, round, item)) return false;
    }
    return true;
  }
  if (Array.isArray(candidate.any)) {
    for (const item of candidate.any) {
      if (await evaluateLoopUntilCondition(cwd, run, compiledFlow, loopId, round, item)) return true;
    }
    return false;
  }

  if (typeof candidate.stage !== "string" || typeof candidate.path !== "string") return false;
  const output = await readLoopStageStructuredOutput(cwd, run, compiledFlow, loopId, round, candidate.stage);
  const value = output === undefined ? undefined : readSimpleJsonPath(output, candidate.path);
  if (value === undefined) return false;
  if (Object.prototype.hasOwnProperty.call(candidate, "equals")) return Object.is(value, candidate.equals);
  if (Object.prototype.hasOwnProperty.call(candidate, "notEquals")) return !Object.is(value, candidate.notEquals);
  if (Object.prototype.hasOwnProperty.call(candidate, "lengthEquals")) return valueLength(value) === candidate.lengthEquals;
  return false;
}

async function loopHasNoProgress(
  cwd: string,
  run: WorkflowRunRecord,
  compiledFlow: CompiledWorkflow,
  loopStage: any,
  loopId: string,
  round: number,
): Promise<boolean> {
  if (round <= 1) return false;
  const current = await readLoopProgressMetric(cwd, run, compiledFlow, loopStage, loopId, round);
  const previous = await readLoopProgressMetric(cwd, run, compiledFlow, loopStage, loopId, round - 1);
  return current !== undefined && previous !== undefined && current >= previous;
}

async function readLoopProgressMetric(
  cwd: string,
  run: WorkflowRunRecord,
  compiledFlow: CompiledWorkflow,
  loopStage: any,
  loopId: string,
  round: number,
): Promise<number | undefined> {
  const checkStageId = loopDesignatedCheckStageId(loopStage);
  const output = await readLoopStageStructuredOutput(cwd, run, compiledFlow, loopId, round, checkStageId);
  if (output === undefined) return undefined;
  const progressPath = loopStage.progressPath ?? "$.blockingFailures";
  const value = readSimpleJsonPath(output, progressPath);
  const length = valueLength(value);
  if (length !== undefined) return length;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value !== undefined || loopStage.progressPath !== undefined) {
    warnInvalidLoopProgressMetric(run, compiledFlow, loopId, round, checkStageId, progressPath, value);
  }
  return undefined;
}

function warnInvalidLoopProgressMetric(
  run: WorkflowRunRecord,
  compiledFlow: CompiledWorkflow,
  loopId: string,
  round: number,
  childStageId: string,
  progressPath: string,
  value: unknown,
): void {
  const entry = getLatestLoopStageTaskEntry(run, compiledFlow, loopId, round, childStageId);
  if (!entry || entry.runTask.status !== "completed") return;
  entry.runTask.lastMessage = `loop progressPath ${progressPath} resolved to unsupported ${describeLoopProgressValue(value)}; no-progress comparison skipped`;
}

function getLatestLoopStageTaskEntry(
  run: WorkflowRunRecord,
  compiledFlow: CompiledWorkflow,
  loopId: string,
  round: number,
  childStageId: string,
): { compiledTask: CompiledTask; runTask: WorkflowTaskRunRecord } | undefined {
  return getLoopRoundTaskEntries(run, compiledFlow, loopId, round)
    .filter((item) => item.compiledTask.loopChild?.childStageId === childStageId)
    .at(-1);
}

function describeLoopProgressValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && !Number.isFinite(value)) return "non-finite number";
  return typeof value;
}

async function readLoopStageStructuredOutput(
  cwd: string,
  run: WorkflowRunRecord,
  compiledFlow: CompiledWorkflow,
  loopId: string,
  round: number,
  childStageId: string,
): Promise<unknown> {
  const entry = getLatestLoopStageTaskEntry(run, compiledFlow, loopId, round, childStageId);
  if (!entry || entry.runTask.status !== "completed") return undefined;
  try {
    const result = JSON.parse(await readFile(fromProjectPath(cwd, entry.runTask.files.result), "utf8"));
    return result?.structuredOutput;
  } catch (error) {
    entry.runTask.lastMessage = `completed loop task result unreadable: ${error instanceof Error ? error.message : String(error)}`;
    return undefined;
  }
}

async function buildLoopCarryForwardContext(
  cwd: string,
  run: WorkflowRunRecord,
  compiledFlow: CompiledWorkflow,
  loopStage: any,
  loopId: string,
  nextRound: number,
): Promise<string> {
  const previousRound = nextRound - 1;
  const checkStageId = loopDesignatedCheckStageId(loopStage);
  const latestCheck = await readLoopStageStructuredOutput(cwd, run, compiledFlow, loopId, previousRound, checkStageId);
  const metric = await readLoopProgressMetric(cwd, run, compiledFlow, loopStage, loopId, previousRound);
  const summary = [
    `Previous round: ${previousRound}`,
    `Designated check stage: ${checkStageId}`,
    metric !== undefined ? `Progress metric (${loopStage.progressPath ?? "$.blockingFailures"} length/value): ${metric}` : undefined,
    "Latest check structured output:",
    compactJson(latestCheck, Math.floor(LOOP_CARRY_FORWARD_MAX_CHARS * 0.7)),
    "Rolling summary:",
    await buildLoopRollingSummary(cwd, run, compiledFlow, loopStage, loopId, previousRound),
  ].filter(Boolean).join("\n");
  return truncate(summary, LOOP_CARRY_FORWARD_MAX_CHARS);
}

async function buildLoopRollingSummary(
  cwd: string,
  run: WorkflowRunRecord,
  compiledFlow: CompiledWorkflow,
  loopStage: any,
  loopId: string,
  latestRound: number,
): Promise<string> {
  const start = Math.max(1, latestRound - 2);
  const lines: string[] = [];
  for (let round = start; round <= latestRound; round += 1) {
    const metric = await readLoopProgressMetric(cwd, run, compiledFlow, loopStage, loopId, round);
    lines.push(`round ${round}: ${metric === undefined ? "progress metric unavailable" : `progress=${metric}`}`);
  }
  return lines.join("\n");
}

async function buildLoopTerminalContext(
  cwd: string,
  run: WorkflowRunRecord,
  compiledFlow: CompiledWorkflow,
  loopStage: any,
  status: LoopResultStatus,
  round: number,
): Promise<string> {
  const checkStageId = loopDesignatedCheckStageId(loopStage);
  const finalCheck = await readLoopStageStructuredOutput(cwd, run, compiledFlow, loopStage.id, round, checkStageId);
  const roundChecks = await buildLoopRoundCheckContext(cwd, run, compiledFlow, loopStage, loopStage.id, round, checkStageId);
  return truncate([
    `loop=${loopStage.id}`,
    `status=${status}`,
    `roundsUsed=${round}`,
    `worktreePath=${findLoopWorktreePath(run, loopStage.id) ?? "(none)"}`,
    "Round check outputs (bounded, most recent retained):",
    roundChecks,
    "Final check structured output:",
    compactJson(finalCheck, LOOP_SUMMARY_MAX_CHARS),
  ].join("\n"), LOOP_CARRY_FORWARD_MAX_CHARS);
}

async function buildLoopRoundCheckContext(
  cwd: string,
  run: WorkflowRunRecord,
  compiledFlow: CompiledWorkflow,
  loopStage: any,
  loopId: string,
  latestRound: number,
  checkStageId: string,
): Promise<string> {
  const sections: string[] = [];
  for (let round = latestRound; round >= 1; round -= 1) {
    const output = await readLoopStageStructuredOutput(cwd, run, compiledFlow, loopId, round, checkStageId);
    const metric = await readLoopProgressMetric(cwd, run, compiledFlow, loopStage, loopId, round);
    const section = [
      `Round ${round}`,
      metric !== undefined ? `progress=${metric}` : "progress metric unavailable",
      compactJson(output, 900),
    ].join("\n");
    const candidate = [section, ...sections].join("\n\n");
    if (candidate.length > LOOP_CARRY_FORWARD_MAX_CHARS && sections.length > 0) break;
    sections.unshift(section);
  }
  return truncate(sections.join("\n\n") || "(unavailable)", LOOP_CARRY_FORWARD_MAX_CHARS);
}

function buildLoopResultSummary(status: LoopResultStatus, round: number, worktreePath: string | null, finalCheck: unknown): string {
  const statusText = status === "completed"
    ? "Loop completed"
    : status === "exhausted"
      ? "Loop exhausted before until condition passed"
      : "Loop stopped because the progress metric did not strictly decrease";
  return truncate([
    `${statusText} after ${round} round${round === 1 ? "" : "s"}.`,
    `worktree=${worktreePath ?? "(none)"}`,
    `finalCheck=${compactJson(finalCheck, 700)}`,
  ].join("\n"), LOOP_SUMMARY_MAX_CHARS);
}

function findLoopStageRecord(compiledFlow: CompiledWorkflow, loopId: string): any | undefined {
  return ((compiledFlow as any).stages ?? []).find((stage: any) => stage?.id === loopId && stage?.type === "loop");
}

function latestLoopRound(compiledFlow: CompiledWorkflow, loopId: string): number {
  let latest = 0;
  for (const task of compiledFlow.tasks) {
    if (task.loopChild?.loopId === loopId) latest = Math.max(latest, task.loopChild.round);
  }
  return latest;
}

function getLoopRoundRunTasks(run: WorkflowRunRecord, compiledFlow: CompiledWorkflow, loopId: string, round: number): WorkflowTaskRunRecord[] {
  return getLoopRoundTaskEntries(run, compiledFlow, loopId, round).map((entry) => entry.runTask);
}

function getLoopRunTasksThroughRound(
  run: WorkflowRunRecord,
  compiledFlow: CompiledWorkflow,
  loopId: string,
  latestRound: number,
): WorkflowTaskRunRecord[] {
  const tasks: WorkflowTaskRunRecord[] = [];
  for (let round = 1; round <= latestRound; round += 1) tasks.push(...getLoopRoundRunTasks(run, compiledFlow, loopId, round));
  return tasks;
}

function getLoopRoundTaskEntries(
  run: WorkflowRunRecord,
  compiledFlow: CompiledWorkflow,
  loopId: string,
  round: number,
): Array<{ runTask: WorkflowTaskRunRecord; compiledTask: CompiledTask; index: number }> {
  const entries: Array<{ runTask: WorkflowTaskRunRecord; compiledTask: CompiledTask; index: number }> = [];
  const runTaskBySpecId = new Map<string, { task: WorkflowTaskRunRecord; index: number }>();
  for (const [index, task] of run.tasks.entries()) runTaskBySpecId.set(task.specId, { task, index });
  for (const compiledTask of compiledFlow.tasks) {
    if (compiledTask.loopChild?.loopId !== loopId || compiledTask.loopChild.round !== round) continue;
    const runEntry = runTaskBySpecId.get(compiledTaskSpecId(compiledTask));
    if (runEntry) entries.push({ runTask: runEntry.task, compiledTask, index: runEntry.index });
  }
  return entries;
}

async function reconcileLoopTaskMaterialization(
  cwd: string,
  run: WorkflowRunRecord,
  compiledFlow: CompiledWorkflow,
): Promise<boolean> {
  const loopIds = loopStageIdSet(compiledFlow);
  if (loopIds.size === 0) return false;
  const changed = reconcileLoopTaskRecordsInMemory(cwd, run, compiledFlow, loopIds);
  if (!changed) return false;
  assertLoopTaskPositionalAlignment(run, compiledFlow, loopIds);
  await writeRunRecord(cwd, run);
  return true;
}

function reconcileLoopTaskRecordsInMemory(
  cwd: string,
  run: WorkflowRunRecord,
  compiledFlow: CompiledWorkflow,
  loopIds: Set<string>,
): boolean {
  const compiledSpecIds = new Set(compiledFlow.tasks.map((task) => compiledTaskSpecId(task)));
  const filteredRunTasks: WorkflowTaskRunRecord[] = [];
  const seenLoopSpecIds = new Set<string>();
  let changed = false;

  for (const task of run.tasks) {
    const loopGenerated = isLoopGeneratedRunTask(task, loopIds);
    if (loopGenerated && !compiledSpecIds.has(task.specId)) {
      changed = true;
      continue;
    }
    if (loopGenerated && seenLoopSpecIds.has(task.specId)) {
      changed = true;
      continue;
    }
    if (loopGenerated) seenLoopSpecIds.add(task.specId);
    filteredRunTasks.push(task);
  }

  const runTaskBySpecId = new Map<string, WorkflowTaskRunRecord>();
  for (const task of filteredRunTasks) {
    if (!runTaskBySpecId.has(task.specId)) runTaskBySpecId.set(task.specId, task);
  }

  const reordered: WorkflowTaskRunRecord[] = [];
  const usedSpecIds = new Set<string>();
  let nextIndex = nextTaskRecordIndex({ ...run, tasks: filteredRunTasks });
  for (const compiledTask of compiledFlow.tasks) {
    const specId = compiledTaskSpecId(compiledTask);
    const existing = runTaskBySpecId.get(specId);
    if (existing) {
      reordered.push(existing);
      usedSpecIds.add(specId);
      continue;
    }
    if (!isLoopGeneratedCompiledTask(compiledTask, loopIds)) continue;
    const created = createTaskRunRecord(cwd, run.runId, compiledTask, nextIndex);
    nextIndex += 1;
    reordered.push(created);
    usedSpecIds.add(specId);
    changed = true;
  }

  for (const task of filteredRunTasks) {
    if (!usedSpecIds.has(task.specId)) reordered.push(task);
  }

  if (!sameTaskRecordOrder(filteredRunTasks, reordered)) changed = true;
  if (changed) run.tasks = reordered;
  return changed;
}

function assertRunTaskPositionalAlignment(run: WorkflowRunRecord, compiledFlow: CompiledWorkflow): void {
  const maxLength = Math.max(run.tasks.length, compiledFlow.tasks.length);
  for (let index = 0; index < maxLength; index += 1) {
    const runTask = run.tasks[index];
    const compiledTask = compiledFlow.tasks[index];
    if (!runTask && compiledTask) {
      throw new Error(`Workflow task materialization is misaligned at index ${index}: compiled task ${compiledTaskSpecId(compiledTask)} has no run record`);
    }
    if (runTask && !compiledTask) {
      throw new Error(`Workflow task materialization is misaligned at index ${index}: run task ${runTask.specId} has no compiled task`);
    }
    if (runTask && compiledTask) {
      const specId = compiledTaskSpecId(compiledTask);
      if (runTask.specId !== specId) {
        throw new Error(`Workflow task materialization is misaligned at index ${index}: expected ${specId}, found ${runTask.specId}`);
      }
    }
  }
}

function assertLoopTaskPositionalAlignment(
  run: WorkflowRunRecord,
  compiledFlow: CompiledWorkflow,
  loopIds = loopStageIdSet(compiledFlow),
): void {
  for (const [index, compiledTask] of compiledFlow.tasks.entries()) {
    if (!isLoopGeneratedCompiledTask(compiledTask, loopIds)) continue;
    const runTask = run.tasks[index];
    const specId = compiledTaskSpecId(compiledTask);
    if (!runTask || runTask.specId !== specId) {
      throw new Error(`Loop task materialization is misaligned at index ${index}: expected ${specId}, found ${runTask?.specId ?? "(missing)"}`);
    }
  }

  for (const [index, runTask] of run.tasks.entries()) {
    if (!isLoopGeneratedRunTask(runTask, loopIds)) continue;
    const compiledTask = compiledFlow.tasks[index];
    if (!compiledTask || compiledTaskSpecId(compiledTask) !== runTask.specId) {
      throw new Error(`Loop task materialization is misaligned at index ${index}: run task ${runTask.specId} has no matching compiled task`);
    }
  }
}

function upsertCompiledLoopTasksAtInsertion(
  compiledFlow: CompiledWorkflow,
  loopId: string,
  placeholderIndex: number,
  tasks: CompiledTask[],
): void {
  const specIds = new Set(tasks.map((task) => compiledTaskSpecId(task)));
  compiledFlow.tasks = compiledFlow.tasks.filter((task) => !specIds.has(compiledTaskSpecId(task)));
  const currentPlaceholderIndex = compiledFlow.tasks.findIndex((task) => task.loopPlaceholder?.loopId === loopId);
  const insertionIndex = loopInsertionIndex(compiledFlow, loopId, currentPlaceholderIndex === -1 ? placeholderIndex : currentPlaceholderIndex);
  compiledFlow.tasks.splice(insertionIndex, 0, ...tasks);
}

function compiledTaskSpecId(task: CompiledTask): string {
  const specId = (task as CompiledTask & { specId?: unknown }).specId;
  return typeof specId === "string" && specId.trim() !== "" ? specId : task.id;
}

function isLoopGeneratedCompiledTask(task: CompiledTask, loopIds: Set<string>): boolean {
  return Boolean(
    task.loopChild?.loopId && loopIds.has(task.loopChild.loopId)
    || task.loopExhausted?.loopId && loopIds.has(task.loopExhausted.loopId),
  );
}

function isLoopGeneratedRunTask(task: WorkflowTaskRunRecord, loopIds: Set<string>): boolean {
  for (const loopId of loopIds) {
    if (task.specId.startsWith(`${loopId}.onExhausted.`)) return true;
    if (new RegExp(`^${escapeRegExp(loopId)}\\.r\\d{2}\\.`).test(task.specId)) return true;
    if (task.stageId?.startsWith(`${loopId}.onExhausted`)) return true;
    if (new RegExp(`^${escapeRegExp(loopId)}\\.r\\d{2}\\.`).test(task.stageId ?? "")) return true;
  }
  return false;
}

function loopStageIdSet(compiledFlow: CompiledWorkflow): Set<string> {
  const loopIds = new Set<string>();
  for (const stage of ((compiledFlow as any).stages ?? [])) {
    if (stage?.type === "loop" && typeof stage.id === "string") loopIds.add(stage.id);
  }
  for (const task of compiledFlow.tasks) {
    if (task.loopChild?.loopId) loopIds.add(task.loopChild.loopId);
    if (task.loopExhausted?.loopId) loopIds.add(task.loopExhausted.loopId);
  }
  return loopIds;
}

function sameTaskRecordOrder(left: WorkflowTaskRunRecord[], right: WorkflowTaskRunRecord[]): boolean {
  return left.length === right.length && left.every((task, index) => task === right[index]);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function loopInsertionIndex(compiledFlow: CompiledWorkflow, loopId: string, placeholderIndex: number): number {
  let index = Math.max(0, placeholderIndex + 1);
  while (index < compiledFlow.tasks.length) {
    const task = compiledFlow.tasks[index];
    if (task?.loopChild?.loopId === loopId || task?.loopExhausted?.loopId === loopId) {
      index += 1;
      continue;
    }
    break;
  }
  return index;
}

function loopChildSourcePolicy(loopStage: any, childStageId: string): string {
  const record = (loopStage.childStageRecords ?? []).find((stage: any) => stage.id === childStageId);
  return record?.sourcePolicy ?? "require-success";
}

function ensureGeneratedStageRecord(compiledFlow: CompiledWorkflow, id: string, type: string | undefined, sourcePolicy: string): void {
  const stages = ((compiledFlow as any).stages ??= []);
  const existing = stages.find((stage: any) => stage.id === id);
  if (existing) {
    existing.sourcePolicy = existing.sourcePolicy ?? sourcePolicy;
    return;
  }
  stages.push({ id, type: type ?? "task", sourcePolicy });
}

function getLoopState(run: WorkflowRunRecord, loopId: string): LoopStateRecord | undefined {
  return run.loopStates?.find((state) => state.loopId === loopId);
}

function ensureLoopState(run: WorkflowRunRecord, loopId: string): LoopStateRecord {
  run.loopStates ??= [];
  let state = getLoopState(run, loopId);
  if (!state) {
    state = { loopId, round: 0 };
    run.loopStates.push(state);
  }
  return state;
}

function findLoopExhaustedRunTask(run: WorkflowRunRecord, compiledFlow: CompiledWorkflow, loopId: string): WorkflowTaskRunRecord | undefined {
  const compiledTask = compiledFlow.tasks.find((task) => task.loopExhausted?.loopId === loopId);
  return compiledTask ? run.tasks.find((task) => task.specId === compiledTaskSpecId(compiledTask)) : undefined;
}

function loopDesignatedCheckStageId(loopStage: any): string {
  const refs = new Set<string>();
  collectUntilStageRefs(loopStage.until, refs);
  if (refs.size === 1) return [...refs][0]!;
  const childStageIds = loopStage.childStageIds ?? [];
  return childStageIds[childStageIds.length - 1] ?? "check";
}

function collectUntilStageRefs(condition: unknown, refs: Set<string>): void {
  if (!condition || typeof condition !== "object") return;
  const candidate = condition as any;
  if (typeof candidate.stage === "string") refs.add(candidate.stage);
  for (const item of candidate.all ?? []) collectUntilStageRefs(item, refs);
  for (const item of candidate.any ?? []) collectUntilStageRefs(item, refs);
}

function valueLength(value: unknown): number | undefined {
  if (Array.isArray(value) || typeof value === "string") return value.length;
  return undefined;
}

function upsertLoopResult(run: WorkflowRunRecord, result: NonNullable<WorkflowRunRecord["loopResults"]>[number]): void {
  run.loopResults ??= [];
  const index = run.loopResults.findIndex((item) => item.loopId === result.loopId);
  if (index === -1) run.loopResults.push(result);
  else run.loopResults[index] = result;
}

function findLoopWorktreePath(run: WorkflowRunRecord, loopId: string): string | null {
  const recorded = run.loopWorktrees?.find((item) => item.loopId === loopId)?.path;
  if (recorded) return recorded;
  return run.tasks.find((task) => task.specId.startsWith(`${loopId}.r`) && task.worktree.enabled && task.worktree.path)?.worktree.path ?? null;
}

function compactJson(value: unknown, maxChars: number): string {
  if (value === undefined) return "(unavailable)";
  try {
    return truncate(JSON.stringify(value), maxChars);
  } catch {
    return truncate(String(value), maxChars);
  }
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, Math.max(0, maxChars - 1))}…` : value;
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
    if (launchTask.kind === "transform") {
      return await executeTransformTask(cwd, run, task, launchTask);
    }
    const worktreeLaunchTask = applyExistingLoopWorktree(run, task, launchTask);
    await ensureManagedWorktree(cwd, run, task, worktreeLaunchTask);
    recordCreatedLoopWorktree(run, task, worktreeLaunchTask);
    await writeRunRecord(cwd, run);
    const launch = await resolveWorkflowBackend(run).launchTask(cwd, run, task, worktreeLaunchTask);
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

async function executeTransformTask(
  cwd: string,
  run: WorkflowRunRecord,
  task: WorkflowTaskRunRecord,
  compiledTask: CompiledWorkflow["tasks"][number],
): Promise<boolean> {
  if (!compiledTask.transform) {
    throw new Error("transform metadata is missing");
  }
  task.status = "running";
  task.statusDetail = "running";
  task.startedAt = task.startedAt ?? new Date().toISOString();
  await writeRunRecord(cwd, run);

  const sources = await readTransformSources(cwd, run, compiledTask.dependsOn ?? []);
  const helperSpecPath = await transformHelperSpecPath(cwd, run);
  const helper = await loadWorkflowHelper(compiledTask.transform.helper, helperSpecPath);
  const structuredOutput = await helper({
    sources,
    options: compiledTask.transform.options,
    context: {
      specPath: helperSpecPath,
      originalSpecPath: run.specPath,
      stageId: task.stageId,
      taskId: task.taskId,
      runId: run.runId,
      cwd,
    },
  });

  await mkdir(dirname(fromProjectPath(cwd, task.files.output)), { recursive: true });
  await writeFile(fromProjectPath(cwd, task.files.output), `${JSON.stringify(structuredOutput, null, 2)}\n`, "utf8");
  await writeFile(fromProjectPath(cwd, task.files.stderr), "", "utf8");
  await writeJsonAtomic(fromProjectPath(cwd, task.files.result), {
    status: "completed",
    structuredOutput,
  });
  setTaskTerminal(task, "completed", "completed", { lastMessage: "transform completed" });
  await writeRunRecord(cwd, run);
  return true;
}

async function transformHelperSpecPath(cwd: string, run: WorkflowRunRecord): Promise<string> {
  const artifactSpecPath = join(workflowRunDir(cwd, run.runId), "bundle", "spec.json");
  try {
    if ((await stat(artifactSpecPath)).isFile()) return artifactSpecPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return run.specPath;
}

async function readTransformSources(cwd: string, run: WorkflowRunRecord, dependsOn: string[]): Promise<Record<string, unknown>> {
  const sources: Record<string, unknown> = {};
  for (const specId of dependsOn) {
    const source = run.tasks.find((candidate) => candidate.specId === specId);
    if (!source) continue;
    const result = await readJson<{ structuredOutput?: unknown }>(fromProjectPath(cwd, source.files.result)).catch(() => undefined);
    if (result && Object.prototype.hasOwnProperty.call(result, "structuredOutput")) {
      sources[source.specId] = result.structuredOutput;
    } else {
      sources[source.specId] = (await readOutputText(cwd, source.files.output)).text;
    }
  }
  return sources;
}

function applyExistingLoopWorktree(
  run: WorkflowRunRecord,
  task: WorkflowTaskRunRecord,
  compiledTask: CompiledTask,
): CompiledTask {
  const loopId = compiledTask.loopChild?.loopId;
  if (!loopId) return compiledTask;
  const existing = run.loopWorktrees?.find((item) => item.loopId === loopId);
  if (!existing?.path) return compiledTask;

  task.cwd = existing.path;
  task.worktree = {
    enabled: true,
    path: existing.path,
    branch: existing.branch,
    baseCwd: existing.baseCwd,
    warning: "reused loop managed worktree",
  };
  return {
    ...compiledTask,
    cwd: existing.path,
    safety: {
      ...compiledTask.safety,
      requiresWorktree: false,
    },
  };
}

function recordCreatedLoopWorktree(
  run: WorkflowRunRecord,
  task: WorkflowTaskRunRecord,
  compiledTask: CompiledTask,
): void {
  const loopId = compiledTask.loopChild?.loopId;
  if (!loopId || !task.worktree.enabled || !task.worktree.path) return;
  run.loopWorktrees ??= [];
  const record = {
    loopId,
    path: task.worktree.path,
    branch: task.worktree.branch,
    baseCwd: task.worktree.baseCwd,
  };
  const index = run.loopWorktrees.findIndex((item) => item.loopId === loopId);
  if (index === -1) run.loopWorktrees.push(record);
  else run.loopWorktrees[index] = record;

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
