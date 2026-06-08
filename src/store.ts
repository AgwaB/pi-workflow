import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, open, readdir, readFile, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomBytes } from "node:crypto";

import {
  CompiledWorkflow,
  CompiledTask,
  STAGE_FIRST_RUN_TYPE,
  WorkflowIndexRecord,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowTaskRunRecord,
  TaskRunStatus,
  TaskSummary,
} from "./types.js";

const TERMINAL_INDEX_LIMIT = 50;
const LEASE_STALE_MS = 30_000;
const INDEX_LOCK_WAIT_MS = 5_000;
const INDEX_LOCK_RETRY_MS = 50;
const runLeaseContext = new AsyncLocalStorage<{ cwd: string; runId: string; ownerId: string }>();
const TASK_STATUSES: Array<keyof Omit<TaskSummary, "total">> = [
  "pending",
  "running",
  "blocked",
  "completed",
  "failed",
  "skipped",
  "interrupted",
];

export function nowIso(): string {
  return new Date().toISOString();
}

export function makeRunId(): string {
  return `workflow_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
}

export function workflowsRoot(cwd: string): string {
  return join(cwd, ".pi", "workflows");
}

export function workflowRunDir(cwd: string, runId: string): string {
  return join(workflowsRoot(cwd), runId);
}

export function workflowRunPath(cwd: string, runId: string): string {
  return join(workflowRunDir(cwd, runId), "run.json");
}

export function workflowIndexPath(cwd: string): string {
  return join(workflowsRoot(cwd), "index.json");
}

export function compiledWorkflowPath(cwd: string, runId: string): string {
  return join(workflowRunDir(cwd, runId), "compiled.json");
}

export function supervisorPath(cwd: string, runId: string): string {
  return join(workflowRunDir(cwd, runId), "supervisor.json");
}

export function indexSupervisorErrorPath(cwd: string): string {
  return join(workflowsRoot(cwd), "supervisor-error.json");
}

export function taskDir(cwd: string, runId: string, taskId: string): string {
  return join(workflowRunDir(cwd, runId), "tasks", taskId);
}

export function managedWorktreePath(cwd: string, runId: string, taskId: string): string {
  return join(workflowRunDir(cwd, runId), "worktrees", taskId);
}

export function toProjectPath(cwd: string, filePath: string): string {
  return isAbsolute(filePath) ? relative(cwd, filePath) || "." : filePath;
}

export function fromProjectPath(cwd: string, filePath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await ensureDir(dirname(file));
  const temp = join(dirname(file), `.${Date.now().toString(36)}-${randomBytes(3).toString("hex")}.tmp`);
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

export async function withRunLease<T>(cwd: string, runId: string, action: () => Promise<T>): Promise<T | undefined> {
  const dir = workflowRunDir(cwd, runId);
  await ensureDir(dir);
  const lockFile = join(dir, "supervisor.lock");
  const ownerId = `${process.pid}-${randomBytes(3).toString("hex")}`;
  const lock = await acquireLock(lockFile, ownerId);
  if (!lock) return undefined;

  const supervisorFile = join(dir, "supervisor.json");
  const heartbeat = async (): Promise<void> => {
    await assertLockOwner(lockFile, ownerId);
    const timestamp = nowIso();
    const now = new Date();
    await utimes(lockFile, now, now);
    await writeJsonAtomic(supervisorFile, {
      schemaVersion: 1,
      ownerId,
      pid: process.pid,
      updatedAt: timestamp,
      lockFile: toProjectPath(cwd, lockFile),
    });
  };

  await heartbeat();
  const heartbeatTimer = setInterval(() => {
    void heartbeat().catch(() => undefined);
  }, Math.max(1000, Math.floor(LEASE_STALE_MS / 3)));
  heartbeatTimer.unref?.();

  try {
    return await runLeaseContext.run({ cwd, runId, ownerId }, action);
  } finally {
    clearInterval(heartbeatTimer);
    await releaseLock(lockFile, ownerId);
  }
}

async function acquireLock(lockFile: string, ownerId: string): Promise<boolean> {
  const tryCreate = async (): Promise<boolean> => {
    try {
      const handle = await open(lockFile, "wx");
      try {
        await handle.writeFile(`${ownerId}\n${process.pid}\n${nowIso()}\n`, "utf8");
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return false;
    }
  };

  if (await tryCreate()) return true;
  if (await reclaimStaleLock(lockFile)) return tryCreate();
  return false;
}

async function reclaimStaleLock(lockFile: string): Promise<boolean> {
  const snapshot = await readLockSnapshot(lockFile);
  if (!snapshot) return true;
  if (Date.now() - snapshot.mtimeMs <= LEASE_STALE_MS) return false;
  if (snapshot.pid !== undefined && isProcessAlive(snapshot.pid)) return false;

  const latest = await readLockSnapshot(lockFile);
  if (!latest) return true;
  if (latest.ownerId !== snapshot.ownerId || latest.pid !== snapshot.pid) return false;
  if (Date.now() - latest.mtimeMs <= LEASE_STALE_MS) return false;
  if (latest.pid !== undefined && isProcessAlive(latest.pid)) return false;

  await unlink(lockFile).catch(() => undefined);
  return true;
}

async function readLockSnapshot(lockFile: string): Promise<{ ownerId: string; pid?: number; mtimeMs: number } | undefined> {
  try {
    const [fileStat, text] = await Promise.all([stat(lockFile), readFile(lockFile, "utf8")]);
    const [ownerId = "", pidText] = text.split(/\r?\n/);
    const pid = Number.parseInt(pidText ?? "", 10);
    return { ownerId, pid: Number.isFinite(pid) ? pid : undefined, mtimeMs: fileStat.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

async function acquireLockWithWait(lockFile: string, ownerId: string): Promise<void> {
  const deadline = Date.now() + INDEX_LOCK_WAIT_MS;
  while (!(await acquireLock(lockFile, ownerId))) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for lock: ${lockFile}`);
    await sleep(INDEX_LOCK_RETRY_MS);
  }
}

async function releaseLock(lockFile: string, ownerId: string): Promise<void> {
  if (await ownsLock(lockFile, ownerId)) await unlink(lockFile).catch(() => undefined);
}

async function assertLockOwner(lockFile: string, ownerId: string): Promise<void> {
  if (!(await ownsLock(lockFile, ownerId))) throw new Error(`Lost supervisor lease: ${lockFile}`);
}

async function ownsLock(lockFile: string, ownerId: string): Promise<boolean> {
  try {
    const [currentOwner] = (await readFile(lockFile, "utf8")).split(/\r?\n/);
    return currentOwner === ownerId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function createRunRecord(
  cwd: string,
  compiled: CompiledWorkflow,
  specPath: string,
): Promise<{ run: WorkflowRunRecord; runDir: string }> {
  const runId = makeRunId();
  const runDir = workflowRunDir(cwd, runId);
  await ensureDir(runDir);
  await ensureDir(join(runDir, "tasks"));

  const createdAt = nowIso();
  const tasks = compiled.tasks.map((task, index) => createTaskRunRecord(cwd, runId, task, index));
  const run = deriveRunStatus({
    schemaVersion: 1,
    runId,
    name: compiled.name,
    description: compiled.description,
    type: compiled.type,
    status: "running",
    taskSummary: emptySummary(),
    cwd: compiled.cwd,
    backend: compiled.backend,
    createdAt,
    updatedAt: createdAt,
    specPath,
    tasks,
  });

  return { run, runDir };
}

export async function writeRunRecord(cwd: string, run: WorkflowRunRecord): Promise<void> {
  await assertActiveRunLease(cwd, run.runId);
  run.updatedAt = nowIso();
  const derived = deriveRunStatus(run);
  Object.assign(run, derived);
  await writeJsonAtomic(workflowRunPath(cwd, run.runId), run);
  await updateIndex(cwd).catch(() => undefined);
}

export async function writeStaticRunArtifacts(cwd: string, run: WorkflowRunRecord, compiled: CompiledWorkflow, originalSpec: unknown): Promise<void> {
  const runDir = workflowRunDir(cwd, run.runId);
  await writeJsonAtomic(join(runDir, "spec.json"), originalSpec);
  await writeJsonAtomic(join(runDir, "compiled.json"), compiled);
}

async function assertActiveRunLease(cwd: string, runId: string): Promise<void> {
  const context = runLeaseContext.getStore();
  if (!context) return;
  if (context.cwd !== cwd || context.runId !== runId) return;
  await assertLockOwner(join(workflowRunDir(cwd, runId), "supervisor.lock"), context.ownerId);
}

export async function findRunRecordPath(cwd: string, runIdOrPrefix: string): Promise<string | undefined> {
  const root = workflowsRoot(cwd);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  const matches = entries.filter((entry) => entry === runIdOrPrefix || entry.startsWith(runIdOrPrefix)).sort();
  if (matches.length === 0) return undefined;
  if (matches.length > 1 && !matches.includes(runIdOrPrefix)) {
    throw new Error(`Ambiguous workflow run id prefix "${runIdOrPrefix}": ${matches.slice(0, 8).join(", ")}`);
  }
  const runId = matches.includes(runIdOrPrefix) ? runIdOrPrefix : matches[0]!;
  return workflowRunPath(cwd, runId);
}

export async function readRunRecord(cwd: string, runIdOrPrefix: string): Promise<WorkflowRunRecord> {
  const file = await findRunRecordPath(cwd, runIdOrPrefix);
  if (!file) throw new Error(`Flow run not found: ${runIdOrPrefix}`);

  const run = await readJson<WorkflowRunRecord>(file);
  if (!run?.runId || !Array.isArray(run.tasks)) throw new Error(`Invalid workflow run record: ${file}`);
  return deriveRunStatus(run);
}

export async function readIndex(cwd: string): Promise<WorkflowIndexRecord | undefined> {
  return readJson<WorkflowIndexRecord>(workflowIndexPath(cwd));
}

export async function listRunRecords(cwd: string): Promise<WorkflowRunRecord[]> {
  const root = workflowsRoot(cwd);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const records = await Promise.all(entries.map(async (entry) => {
    const file = join(root, entry, "run.json");
    try {
      const fileStat = await stat(file);
      if (!fileStat.isFile()) return undefined;
      const parsed = JSON.parse(await readFile(file, "utf8")) as WorkflowRunRecord;
      if (!isRunRecordLike(parsed)) return undefined;
      return deriveRunStatus(parsed);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return undefined;
      if (error instanceof SyntaxError) return undefined;
      throw error;
    }
  }));

  return records.filter((record): record is WorkflowRunRecord => Boolean(record));
}

function isRunRecordLike(value: unknown): value is WorkflowRunRecord {
  if (!value || typeof value !== "object") return false;
  const run = value as Partial<WorkflowRunRecord>;
  if (typeof run.runId !== "string" || !Array.isArray(run.tasks)) return false;
  return run.tasks.every((task) => Boolean(
    task
    && typeof task === "object"
    && typeof (task as WorkflowTaskRunRecord).status === "string"
    && TASK_STATUSES.includes((task as WorkflowTaskRunRecord).status as keyof Omit<TaskSummary, "total">),
  ));
}

export async function updateIndex(cwd: string): Promise<WorkflowIndexRecord> {
  const lockFile = join(workflowsRoot(cwd), "index.lock");
  const ownerId = `${process.pid}-${randomBytes(3).toString("hex")}`;
  await ensureDir(workflowsRoot(cwd));
  await acquireLockWithWait(lockFile, ownerId);

  try {
    const runs = (await listRunRecords(cwd)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const active = runs.filter((run) => !isTerminalWorkflowStatus(run.status));
    const terminal = runs.filter((run) => isTerminalWorkflowStatus(run.status)).slice(0, TERMINAL_INDEX_LIMIT);
    const selected = [...active, ...terminal].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

    const index: WorkflowIndexRecord = {
      schemaVersion: 1,
      updatedAt: nowIso(),
      runs: selected.map((run) => ({
        runId: run.runId,
        name: run.name,
        type: run.type,
        status: run.status,
        taskSummary: run.taskSummary,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        runJson: toProjectPath(cwd, workflowRunPath(cwd, run.runId)),
        tasks: run.tasks.map((task) => ({
          taskId: task.taskId,
          displayName: task.displayName,
          agent: task.agent,
          status: task.status,
          statusDetail: task.statusDetail,
          paneId: task.paneId,
          lastMessage: task.lastMessage,
        })),
      })),
    };

    await writeJsonAtomic(workflowIndexPath(cwd), index);
    return index;
  } finally {
    await releaseLock(lockFile, ownerId);
  }
}

export function deriveRunStatus(run: WorkflowRunRecord): WorkflowRunRecord {
  const next = { ...run, tasks: run.tasks };
  next.taskSummary = summarizeTasks(next.tasks);
  next.status = deriveWorkflowStatus(next.taskSummary);
  return next;
}

export function summarizeTasks(tasks: WorkflowTaskRunRecord[]): TaskSummary {
  const summary = emptySummary();
  for (const task of tasks) {
    summary[task.status] += 1;
    summary.total += 1;
  }
  return summary;
}

export function deriveWorkflowStatus(summary: TaskSummary): WorkflowRunStatus {
  if (summary.blocked > 0) return "blocked";
  if (summary.running > 0 || summary.pending > 0) return "running";
  if (summary.total > 0 && summary.completed === summary.total) return "completed";
  if (summary.failed > 0 || summary.interrupted > 0) return "failed";
  return "interrupted";
}

export function isTerminalWorkflowStatus(status: WorkflowRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "interrupted";
}

export function isTerminalTaskStatus(status: TaskRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "skipped" || status === "interrupted" || status === "blocked";
}

export function setTaskTerminal(
  task: WorkflowTaskRunRecord,
  status: TaskRunStatus,
  statusDetail: string,
  options: { completedAt?: string; exitCode?: number; lastMessage?: string } = {},
): boolean {
  if (isTerminalTaskStatus(task.status)) return false;
  task.status = status;
  task.statusDetail = statusDetail;
  task.completedAt = options.completedAt ?? nowIso();
  task.exitCode = options.exitCode;
  task.lastMessage = options.lastMessage;
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createTaskRunRecord(cwd: string, runId: string, task: CompiledTask, index: number): WorkflowTaskRunRecord {
  const taskId = `task-${index + 1}`;
  const dir = taskDir(cwd, runId, taskId);
  const files = {
    systemPrompt: toProjectPath(cwd, join(dir, "system-prompt.md")),
    taskPrompt: toProjectPath(cwd, join(dir, "task.md")),
    output: toProjectPath(cwd, join(dir, "output.log")),
    stderr: toProjectPath(cwd, join(dir, "stderr.log")),
    result: toProjectPath(cwd, join(dir, "result.json")),
  };
  const blocked = task.safety.permission.status === "blocked";

  return {
    taskId,
    specId: task.id,
    displayName: task.id,
    agent: task.agent,
    agentDescription: task.agentDescription,
    agentFile: task.agentPath,
    roles: task.roleNames,
    status: blocked ? "blocked" : "pending",
    statusDetail: blocked ? (task.safety.permission.statusDetail ?? "needs_attention") : "pending",
    runtime: {
      model: task.runtime.model,
      thinking: task.runtime.thinking,
      fast: task.runtime.fast,
      approvalMode: task.runtime.approvalMode,
      maxRuntimeMs: task.runtime.maxRuntimeMs,
    },
    tools: task.runtime.tools,
    cwd: task.cwd,
    worktree: {
      enabled: false,
      path: null,
      branch: null,
      baseCwd: null,
      warning: null,
    },
    backendTaskId: taskId,
    kind: task.kind,
    stageId: task.stageId,
    dependsOn: task.dependsOn,
    output: task.output,
    files,
    lastMessage: blocked ? task.safety.permission.reason : undefined,
  };
}

function emptySummary(): TaskSummary {
  return TASK_STATUSES.reduce((summary, status) => {
    summary[status] = 0;
    return summary;
  }, { total: 0 } as TaskSummary);
}

export async function resolveFlowsCwd(cwd: string): Promise<string> {
  let current = cwd;
  while (true) {
    try {
      const found = await readJson(workflowIndexPath(current));
      if (found) return current;
    } catch {}
    const parent = dirname(current);
    if (parent === current) return cwd;
    current = parent;
  }
}

export async function createStageFirstRunRecord(cwd: string, compiled: CompiledWorkflow, specPath: string): Promise<{ run: WorkflowRunRecord; runDir: string }> {
  const result = await createRunRecord(cwd, compiled, specPath);
  result.run.type = STAGE_FIRST_RUN_TYPE as any;
  return result;
}

export function supervisorLeasePath(cwd: string, runId: string): string {
  return join(cwd, ".pi", "workflows", runId, "supervisor-lease.json");
}
const TEST_OWNER_ID = `pi-workflow-${process.pid}`;
export function workflowSupervisorOwnerIdForTests(): string { return TEST_OWNER_ID; }
export function workflowProcessRoleForTests(): string { return process.env.PI_WORKFLOW_ROLE ?? "supervisor"; }
export async function acquireSupervisorLease(cwd: string, runId: string): Promise<boolean> {
  if (process.env.PI_WORKFLOW_ROLE === "worker" || process.env.PI_WORKFLOW_ROLE === "disabled") return false;
  const path = supervisorLeasePath(cwd, runId);
  try {
    const current = await readJson(path) as any;
    if (current?.ownerId && current.ownerId !== TEST_OWNER_ID && current.pid === process.pid) return false;
  } catch {}
  await writeJsonAtomic(path, { schemaVersion: 1, ownerId: TEST_OWNER_ID, pid: process.pid, role: "supervisor", startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() });
  return true;
}
export async function heartbeatSupervisorLease(cwd: string, runId: string): Promise<boolean> {
  const path = supervisorLeasePath(cwd, runId);
  const current = await readJson(path) as any;
  if (!current || current.ownerId !== TEST_OWNER_ID) return false;
  await writeJsonAtomic(path, { ...current, heartbeatAt: new Date().toISOString() });
  return true;
}
