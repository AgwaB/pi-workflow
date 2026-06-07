// @ts-nocheck
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";

import { flowRunDir, flowsRoot, managedWorktreePath, toProjectPath } from "./store.js";
import { CompiledTask, FlowRunRecord, FlowTaskRunRecord, WorktreeSnapshotRecord } from "./types.js";

const GIT_MAX_BUFFER = 50 * 1024 * 1024;

export async function ensureManagedWorktree(
  projectCwd: string,
  run: FlowRunRecord,
  task: FlowTaskRunRecord,
  compiledTask: CompiledTask,
): Promise<void> {
  if (!compiledTask.safety.requiresWorktree) return;

  const gitRoot = findGitRoot(compiledTask.cwd);
  if (!gitRoot) {
    throw new Error(`managed worktree required for ${task.taskId}, but ${compiledTask.cwd} is not inside a git repository`);
  }

  const path = managedWorktreePath(projectCwd, run.runId, task.taskId);
  const branch = `pi-flow/${run.runId}-${task.taskId}`;
  await mkdir(dirname(path), { recursive: true });

  const snapshot = await captureDirtyWorktreeSnapshot(projectCwd, run, task, gitRoot);
  if (task.worktree.enabled && task.worktree.path) {
    if (task.worktree.path !== path) {
      throw new Error(`managed worktree path mismatch for ${task.taskId}: expected ${path}, found ${task.worktree.path}`);
    }
    if (await canReuseManagedWorktree(path, task.worktree.snapshot, snapshot.record)) {
      task.cwd = path;
      task.worktree = {
        ...task.worktree,
        enabled: true,
        path,
        branch: task.worktree.branch ?? branch,
        baseCwd: compiledTask.cwd,
        warning: snapshot.record.dirty ? "reusing existing managed worktree with dirty source checkout snapshot" : "reusing existing managed worktree path",
        snapshot: snapshot.record,
      };
      return;
    }
    await removeManagedWorktree(gitRoot, path, task.worktree.branch ?? branch);
  } else if (await exists(path)) {
    await removeManagedWorktree(gitRoot, path, branch);
  }

  execFileSync("git", ["worktree", "add", "-b", branch, path, "HEAD"], {
    cwd: gitRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await applyDirtyWorktreeSnapshot(path, snapshot);
  } catch (error) {
    cleanupManagedWorktree(gitRoot, path, branch);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to apply dirty worktree snapshot for ${task.taskId}: ${message}`);
  }

  task.cwd = path;
  task.worktree = {
    enabled: true,
    path,
    branch,
    baseCwd: compiledTask.cwd,
    warning: snapshot.record.dirty ? "applied dirty source checkout snapshot" : null,
    snapshot: snapshot.record,
  };
}

interface CapturedWorktreeSnapshot {
  record: WorktreeSnapshotRecord;
  snapshotDir: string;
  trackedPatchPath?: string;
}

async function captureDirtyWorktreeSnapshot(
  projectCwd: string,
  run: FlowRunRecord,
  task: FlowTaskRunRecord,
  gitRoot: string,
): Promise<CapturedWorktreeSnapshot> {
  const snapshotDir = join(flowRunDir(projectCwd, run.runId), "worktree-snapshots", task.taskId);
  await rm(snapshotDir, { recursive: true, force: true });
  await mkdir(snapshotDir, { recursive: true });

  const baseHead = git(gitRoot, ["rev-parse", "HEAD"]).trim();
  const excludedFlowState = gitRelativePrefix(gitRoot, flowsRoot(projectCwd)) ?? ".pi/workflows";
  const flowStatePathspec = excludedFlowState ? [`:(exclude)${excludedFlowState}`] : [];
  const trackedPatch = git(gitRoot, ["diff", "--binary", "HEAD", "--", ".", ...flowStatePathspec]);
  const trackedFiles = parseNul(git(gitRoot, ["diff", "--name-only", "-z", "HEAD", "--", ".", ...flowStatePathspec]))
    .map(safeGitRelativePath)
    .filter((file) => !isUnderGitPrefix(file, excludedFlowState));
  const untrackedFiles = parseNul(git(gitRoot, ["ls-files", "--others", "--exclude-standard", "-z"])).map(safeGitRelativePath)
    .filter((file) => !isUnderGitPrefix(file, excludedFlowState));
  const trackedPatchPath = trackedPatch.length > 0 ? join(snapshotDir, "tracked.patch") : undefined;
  const untrackedFileSha256: Record<string, string> = {};

  if (trackedPatchPath) await writeFile(trackedPatchPath, trackedPatch, "utf8");
  for (const file of untrackedFiles) {
    await copySnapshotFile(gitRoot, join(snapshotDir, "untracked"), file);
    untrackedFileSha256[file] = await hashSnapshotPath(gitRoot, file);
  }

  const record: WorktreeSnapshotRecord = {
    createdAt: new Date().toISOString(),
    sourceGitRoot: gitRoot,
    baseHead,
    dirty: trackedFiles.length > 0 || untrackedFiles.length > 0,
    trackedPatch: trackedPatchPath ? toProjectPath(projectCwd, trackedPatchPath) : null,
    trackedPatchSha256: trackedPatchPath ? sha256Text(trackedPatch) : null,
    trackedFileCount: trackedFiles.length,
    untrackedFileCount: untrackedFiles.length,
    untrackedFiles,
    untrackedFileSha256,
    ignoredExcluded: true,
  };
  await writeFile(join(snapshotDir, "metadata.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return { record, snapshotDir, trackedPatchPath };
}

async function applyDirtyWorktreeSnapshot(worktreeRoot: string, snapshot: CapturedWorktreeSnapshot): Promise<void> {
  if (snapshot.trackedPatchPath) {
    execFileSync("git", ["apply", "--whitespace=nowarn", snapshot.trackedPatchPath], {
      cwd: worktreeRoot,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: GIT_MAX_BUFFER,
    });
  }
  for (const file of snapshot.record.untrackedFiles) {
    await copySnapshotFile(join(snapshot.snapshotDir, "untracked"), worktreeRoot, file);
  }
}

async function canReuseManagedWorktree(
  path: string,
  previous: WorktreeSnapshotRecord | null | undefined,
  current: WorktreeSnapshotRecord,
): Promise<boolean> {
  if (!previous) return false;
  if (!(await exists(path))) return false;
  if (!sameSnapshotContent(previous, current)) return false;
  try {
    return git(path, ["rev-parse", "HEAD"]).trim() === current.baseHead;
  } catch {
    return false;
  }
}

function sameSnapshotContent(previous: WorktreeSnapshotRecord, current: WorktreeSnapshotRecord): boolean {
  if (previous.sourceGitRoot !== current.sourceGitRoot) return false;
  if (previous.baseHead !== current.baseHead) return false;
  if (previous.dirty !== current.dirty) return false;
  if ((previous.trackedPatchSha256 ?? null) !== (current.trackedPatchSha256 ?? null)) return false;
  if (previous.trackedFileCount !== current.trackedFileCount) return false;
  if (previous.untrackedFileCount !== current.untrackedFileCount) return false;
  if (previous.ignoredExcluded !== current.ignoredExcluded) return false;
  if (!sameStringArray(previous.untrackedFiles, current.untrackedFiles)) return false;

  const previousHashes = previous.untrackedFileSha256 ?? {};
  const currentHashes = current.untrackedFileSha256 ?? {};
  return current.untrackedFiles.every((file) => previousHashes[file] === currentHashes[file]);
}

function sameStringArray(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

async function removeManagedWorktree(gitRoot: string, path: string, branch: string): Promise<void> {
  cleanupManagedWorktree(gitRoot, path, branch);
  await rm(path, { recursive: true, force: true });
}

async function copySnapshotFile(sourceRoot: string, targetRoot: string, file: string): Promise<void> {
  const safePath = safeGitRelativePath(file);
  const source = join(sourceRoot, safePath);
  const target = join(targetRoot, safePath);
  await mkdir(dirname(target), { recursive: true });
  const info = await lstat(source);
  if (info.isSymbolicLink()) {
    await symlink(await readlink(source), target);
    return;
  }
  if (!info.isFile()) throw new Error(`snapshot path is not a regular file: ${file}`);
  await copyFile(source, target);
}

async function hashSnapshotPath(sourceRoot: string, file: string): Promise<string> {
  const source = join(sourceRoot, safeGitRelativePath(file));
  const info = await lstat(source);
  if (info.isSymbolicLink()) return `symlink:${sha256Text(await readlink(source))}`;
  if (!info.isFile()) throw new Error(`snapshot path is not a regular file: ${file}`);
  return sha256Buffer(await readFile(source));
}

function sha256Text(value: string): string {
  return sha256Buffer(Buffer.from(value, "utf8"));
}

function sha256Buffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function cleanupManagedWorktree(gitRoot: string, path: string, branch: string): void {
  tryGit(gitRoot, ["worktree", "remove", "--force", path]);
  tryGit(gitRoot, ["branch", "-D", branch]);
}

function findGitRoot(cwd: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: GIT_MAX_BUFFER,
  });
}

function tryGit(cwd: string, args: string[]): void {
  try {
    git(cwd, args);
  } catch {
    // Best-effort cleanup only.
  }
}

function parseNul(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

function gitRelativePrefix(gitRoot: string, value: string): string | undefined {
  const rel = normalize(relative(gitRoot, value));
  if (!rel || rel === "." || isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) return undefined;
  return rel;
}

function isUnderGitPrefix(value: string, prefix: string | undefined): boolean {
  if (!prefix) return false;
  return value === prefix || value.startsWith(`${prefix}/`) || value.startsWith(`${prefix}\\`);
}

function safeGitRelativePath(value: string): string {
  if (isAbsolute(value)) throw new Error(`snapshot path must be relative: ${value}`);
  const normalized = normalize(value);
  if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("..\\")) throw new Error(`snapshot path escapes git root: ${value}`);
  return normalized;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
