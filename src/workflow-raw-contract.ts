import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { hasNonSpawnableWorkflowLaunchAuthority } from "./launch-authority.js";
import { workflowTaskAttemptIdentity, workflowTaskSessionId } from "./launch-session.js";
import { foreachBatchTasks } from "./foreach-batch-runtime.js";
import type { WorkflowRunRecord } from "./types.js";

// Host run records are the authority boundary. These hashes detect corruption;
// they are NOT signatures, nor proof of historical byte authorship.
export interface RawIntegrity {
	version: 1;
	sha256: string;
	bytes: number;
	owner: string;
	/** Host-captured terminal identity; avoids rereading an unchanged raw-bearing mirror result. */
	terminal?: Record<string, unknown>;
	terminalVersion?: RawFileVersion;
}
type RawFileVersion = Pick<Stats, "dev" | "ino" | "size" | "nlink" | "mtimeMs" | "ctimeMs">;
export function rawFileVersion(info: RawFileVersion): RawFileVersion {
	const { dev, ino, size, nlink, mtimeMs, ctimeMs } = info;
	return { dev, ino, size, nlink, mtimeMs, ctimeMs };
}
export interface RawOwner {
	runDir: string;
	taskDir: string;
	raw: string;
	output: string;
	attempt?: string;
	identity: string;
	integrity?: RawIntegrity;
	selection?: RawSelection;
	directories: Map<string, Stats>;
	metadata: Map<string, Stats>;
	resultValidated?: boolean;
	terminal?: Record<string, unknown>;
}
interface RawSelection { runDir: string; runId: string; taskId?: string; source: string; generation?: number; sourceGeneration?: number }
const safeId = (value: unknown): value is string =>
	typeof value === "string" && /^[A-Za-z0-9_.-]+$/.test(value) && value !== "." && value !== "..";
function fail(): never { throw new Error("raw artifact ownership/link contract could not be established"); }
export const rawDigest = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
export const sameInode = (a: RawFileVersion, b: RawFileVersion): boolean =>
	Number.isSafeInteger(a.dev) && Number.isSafeInteger(a.ino) && Number.isSafeInteger(b.dev) && Number.isSafeInteger(b.ino) && a.dev === b.dev && a.ino === b.ino;
export const sameRawVersion = (a: RawFileVersion, b: RawFileVersion): boolean =>
	sameInode(a, b) && a.size === b.size && a.nlink === b.nlink && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

async function directoryChain(project: string, path: string, identities: Map<string, Stats>): Promise<void> {
	const rel = relative(project, path);
	if (rel.startsWith("..") || resolve(project, rel) !== path) fail();
	let current = project;
	for (const part of ["", ...rel.split("/").filter(Boolean)]) {
		if (part) current = join(current, part);
		if (identities.has(current)) continue;
		const info = await lstat(current);
		if (!info.isDirectory() || info.isSymbolicLink()) fail();
		identities.set(current, info);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function metadata(path: string, snapshots?: Map<string, Stats>): Promise<Record<string, unknown>> {
	const before = await lstat(path);
	if (!before.isFile() || before.nlink !== 1) fail();
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		if (!sameRawVersion(before, await file.stat())) fail();
		const value = JSON.parse(await file.readFile("utf8"));
		if (!sameRawVersion(before, await file.stat()) || !sameRawVersion(before, await lstat(path))) fail();
		if (!value || typeof value !== "object" || Array.isArray(value)) fail();
		snapshots?.set(path, before);
		return value;
	} finally { await file.close(); }
}

export async function assertSafeRawTaskDirectory(taskDirectory: string): Promise<void> {
	const taskDir = resolve(taskDirectory);
	const runDir = dirname(dirname(taskDir));
	if (basename(dirname(taskDir)) !== "tasks" || basename(dirname(runDir)) !== "workflows" || basename(dirname(dirname(runDir))) !== ".pi") return;
	const project = await realpath(dirname(dirname(dirname(runDir))));
	await directoryChain(project, join(project, ".pi", "workflows", basename(runDir), "tasks", basename(taskDir)), new Map());
}

/** Only the canonical host-selected run tree can confer a raw link allowance. */
export async function establishRawOwner(taskDirectory: string, expected?: RawSelection): Promise<RawOwner> {
	const taskDir = resolve(taskDirectory);
	const taskId = basename(taskDir);
	const runDir = dirname(dirname(taskDir));
	const runId = basename(runDir);
	const lexicalProject = dirname(dirname(dirname(runDir)));
	const project = await realpath(lexicalProject);
	if (!safeId(taskId) || !safeId(runId) || taskDir !== join(lexicalProject, ".pi", "workflows", runId, "tasks", taskId)) fail();
	if (expected && (resolve(expected.runDir) !== runDir || expected.runId !== runId || (expected.taskId !== undefined && expected.taskId !== taskId))) fail();
	const canonicalTask = join(project, ".pi", "workflows", runId, "tasks", taskId);
	const directories = new Map<string, Stats>();
	const snapshots = new Map<string, Stats>();
	await directoryChain(project, canonicalTask, directories);
	// SAFETY: only the fields checked below are consumed here; the launch-authority
	// validator checks the full recorded grant/provenance before mirror ownership.
	const run = await metadata(join(project, ".pi", "workflows", runId, "run.json"), snapshots) as unknown as WorkflowRunRecord;
	if (run.runId !== runId || !Array.isArray(run.tasks) || typeof run.createdAt !== "string") fail();
	const matches = run.tasks.filter(task => task.taskId === taskId);
	if (matches.length !== 1) fail();
	const task = matches[0]!;
	if (expected) {
		// The manifest may select a host record, not rename a foreign producer.
		// Ambiguous stage aliases (e.g. multiple foreach children) fail closed.
		const named = run.tasks.filter(candidate => expected.source === candidate.specId || expected.source === candidate.taskId || (!candidate.dynamicGenerated && expected.source === candidate.stageId));
		if (named.length !== 1 || named[0]!.taskId !== taskId || expected.generation !== task.generation || expected.sourceGeneration !== task.sourceGeneration) fail();
	}
	if (!task.files || resolve(lexicalProject, task.files.output) !== join(taskDir, "output.log") || resolve(lexicalProject, task.files.result) !== join(taskDir, "result.json")) fail();
	if (!["running", "completed", "failed"].includes(task.status)) fail();
	let executionTask = task;
	let batchIdentity: unknown;
	if (task.foreachBatch && ["committing", "completed"].includes(task.foreachBatch.phase)) {
		const batches = run.foreachBatches?.filter(record => record.batchId === task.foreachBatch!.batchId);
		if (batches?.length !== 1) fail();
		const batch = batches[0]!;
		const members = foreachBatchTasks(run, batch);
		if (!members.includes(task) || !["committing", "completed"].includes(batch.phase)) fail();
		executionTask = members.find(member => member.foreachBatch?.role === "leader")!;
		batchIdentity = { batchId: batch.batchId, attempt: batch.attempt, members: batch.members, terminal: batch.terminal };
	}
	const attemptKey = workflowTaskAttemptIdentity(executionTask, workflowTaskSessionId(run, executionTask));
	let attempt: string | undefined;
	let backend: unknown;
	let terminalIdentity: Record<string, unknown> | undefined;
	if (executionTask.launchAuthority !== undefined) {
		const records = executionTask.launchAuthority.records?.filter(record => record.grant.attemptKey === attemptKey);
		if (records?.length !== 1) fail();
		const record = records[0]!;
		if (!hasNonSpawnableWorkflowLaunchAuthority(run, executionTask, record.grant.backendId) || record.state.phase !== "consumed") fail();
		const state = record.state;
		if (!safeId(state.backendRunId) || !safeId(state.backendAttemptId) || await realpath(task.cwd) !== project) fail();
		const mirrorRun = join(project, ".pi", "workflow-subagents", runId, executionTask.taskId, state.backendRunId);
		const attemptDir = join(mirrorRun, "attempts", state.backendAttemptId);
		await directoryChain(project, attemptDir, directories);
		const mirror = await metadata(join(mirrorRun, "run.json"), snapshots);
		// Only a HOST anchor can supply this bounded identity. A result-sidecar
		// hash never supplies authority. Legacy still checks its terminal record.
		const terminalPath = join(attemptDir, "result.json");
		const terminalStat = await lstat(terminalPath);
		const anchor = task.rawArtifactIntegrity;
		const terminal = anchor?.terminal && anchor.terminalVersion && terminalStat.isFile() && terminalStat.nlink === 1 && sameRawVersion(anchor.terminalVersion, terminalStat)
			? anchor.terminal
			: await metadata(terminalPath, snapshots);
		// Even the bounded host-backed path rechecks the current terminal inode
		// at every fence. A changed version must be read and validated in full.
		if (!snapshots.has(terminalPath)) snapshots.set(terminalPath, terminalStat);
		if (mirror.runId !== state.backendRunId || mirror.correlationId !== `${runId}:${executionTask.taskId}` || mirror.latestAttemptId !== state.backendAttemptId || (mirror.activeAttemptId != null && mirror.activeAttemptId !== state.backendAttemptId) || !Array.isArray(mirror.attempts) || mirror.attempts.filter((item: unknown) => isRecord(item) && item.attemptId === state.backendAttemptId).length !== 1) fail();
		const mirrorAttempt = (mirror.attempts as unknown[]).find((item) => isRecord(item) && item.attemptId === state.backendAttemptId);
		if (mirror.activeAttemptId != null || typeof mirror.status !== "string" || !["completed", "failed"].includes(mirror.status) || !isRecord(mirrorAttempt) || typeof mirrorAttempt.status !== "string" || !["completed", "failed"].includes(mirrorAttempt.status)) fail();
		if (terminal.runId !== state.backendRunId || terminal.attemptId !== state.backendAttemptId || typeof terminal.status !== "string" || !["completed", "failed"].includes(terminal.status)) fail();
		attempt = join(attemptDir, "output.log");
		// Notification/telemetry fields may change after terminal materialization.
		// Bind the terminal execution identity, not unrelated mutable decorations.
		terminalIdentity = { runId: terminal.runId, attemptId: terminal.attemptId, status: terminal.status, startedAt: terminal.startedAt, completedAt: terminal.completedAt, exitCode: terminal.exitCode };
		backend = {
			grant: record.grant,
			state,
			mirror: { runId: mirror.runId, correlationId: mirror.correlationId, latestAttemptId: mirror.latestAttemptId },
			terminal: terminalIdentity,
		};
	} else if (task.backendTaskId && task.backendTaskId !== taskId) {
		// Old records missing launch identity cannot authorize a mirrored inode.
		fail();
	}
	const identity = rawDigest(JSON.stringify({ runId, createdAt: run.createdAt, taskId, specId: task.specId, generation: task.generation, sourceGeneration: task.sourceGeneration, attemptKey, files: task.files, backend, ...(batchIdentity ? { batch: batchIdentity } : {}) }));
	return { runDir, taskDir, raw: join(canonicalTask, "raw.md"), output: join(canonicalTask, "output.log"), attempt, identity, integrity: task.rawArtifactIntegrity, selection: expected, directories, metadata: snapshots, terminal: terminalIdentity };
}

export async function recheckRawOwner(owner: RawOwner): Promise<void> {
	// Per-operation snapshots, never a cross-read cache: every root inode and
	// every metadata version is freshly checked at each fence. Reparse changes.
	await Promise.all([...owner.directories].map(async ([path, before]) => {
		const current = await lstat(path);
		if (!current.isDirectory() || current.isSymbolicLink() || !sameInode(before, current)) fail();
	}));
	const unchanged = await Promise.all([...owner.metadata].map(async ([path, before]) => sameRawVersion(before, await lstat(path))));
	if (unchanged.every(Boolean)) return;
	const current = await establishRawOwner(owner.taskDir, owner.selection);
	if (current.identity !== owner.identity || JSON.stringify(current.integrity) !== JSON.stringify(owner.integrity) || current.directories.size !== owner.directories.size) fail();
	for (const [path, info] of owner.directories) if (!sameInode(info, current.directories.get(path)!)) fail();
}

/** Enumerate exact authorized names; nlink must equal ALL matching names. */
export async function checkRawLinks(owner: RawOwner, info: Stats, includeRaw = true): Promise<void> {
	const names = [owner.output, ...(owner.attempt ? [owner.attempt] : []), ...(includeRaw ? [owner.raw] : [])];
	let count = 0;
	for (const path of names) {
		const candidate = await lstat(path);
		if (!candidate.isFile() || candidate.isSymbolicLink()) fail();
		if (sameInode(candidate, info)) count++;
		else if (path === owner.output || path === owner.raw) fail();
	}
	if (count !== info.nlink || count < (includeRaw ? 2 : 1)) fail();
}

/** A failed owner check must not silently turn new evidence into legacy/snapshot data. */
export async function assertNoRawIntegrityAnchor(taskDirectory: string): Promise<void> {
	const taskDir = resolve(taskDirectory);
	const runDir = dirname(dirname(taskDir));
	if (basename(dirname(taskDir)) !== "tasks" || basename(dirname(runDir)) !== "workflows" || basename(dirname(dirname(runDir))) !== ".pi") return;
	for (const path of [join(runDir, "run.json"), join(taskDir, "result.json")]) {
		let record: Record<string, unknown>;
		try { record = await metadata(path); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
		// A canonical run record exists: failure to establish its exact selection
		// cannot be relabeled as independent legacy data, even without a digest.
		if (path === join(runDir, "run.json") || record.rawIntegrity !== undefined) fail();
	}
}

export async function readRawIntegrity(owner: RawOwner): Promise<RawIntegrity | undefined> {
	const path = join(owner.taskDir, "result.json");
	const previous = owner.metadata.get(path);
	if (owner.resultValidated && previous && sameRawVersion(previous, await lstat(path))) return owner.integrity;
	const result = await metadata(path, owner.metadata);
	if (result.schema !== "workflow-task-result-v1" || !isRecord(result.outputValidation) || result.outputValidation.valid !== true || !isRecord(result.artifacts) || result.artifacts.raw !== "raw.md") fail();
	const record = result.rawIntegrity;
	if (JSON.stringify(owner.integrity) !== JSON.stringify(record)) fail();
	// Owner-selected legacy_scoped_unattested: current scoped bytes, NOT
	// historical authenticity. Both independent and linked legacy are unattested.
	if (record === undefined) { owner.resultValidated = true; return undefined; }
	if (!isRecord(record) || record.version !== 1 || record.owner !== owner.identity || typeof record.bytes !== "number" || !Number.isSafeInteger(record.bytes) || record.bytes < 0 || typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256)) fail();
	owner.resultValidated = true;
	return owner.integrity;
}

/** Publication already hashes authoritative bytes; compare rather than hash twice. */
export async function matchesRawDescriptor(file: FileHandle, expected: Buffer): Promise<boolean> {
	const buffer = Buffer.allocUnsafe(Math.min(256 * 1024, expected.length));
	let position = 0;
	while (position < expected.length) {
		const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, expected.length - position), position);
		if (!bytesRead || !buffer.subarray(0, bytesRead).equals(expected.subarray(position, position + bytesRead))) return false;
		position += bytesRead;
	}
	return true;
}

export async function hashRawDescriptor(file: FileHandle, size: number): Promise<string> {
	const hash = createHash("sha256");
	const buffer = Buffer.allocUnsafe(256 * 1024);
	let position = 0;
	while (position < size) {
		const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - position), position);
		if (!bytesRead) fail();
		hash.update(buffer.subarray(0, bytesRead));
		position += bytesRead;
	}
	return hash.digest("hex");
}
