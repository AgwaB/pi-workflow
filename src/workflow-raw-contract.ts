import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { hasNonSpawnableWorkflowLaunchAuthority } from "./launch-authority.js";
import { workflowTaskAttemptIdentity, workflowTaskSessionId } from "./launch-session.js";
import type { WorkflowRunRecord } from "./types.js";

// Host run records are the authority boundary. These hashes detect corruption;
// they are NOT signatures, nor proof of historical byte authorship.
export interface RawIntegrity {
	version: 1;
	sha256: string;
	bytes: number;
	owner: string;
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
}
interface RawSelection { runDir: string; runId: string; taskId?: string; source: string; generation?: number; sourceGeneration?: number }
const safeId = (value: unknown): value is string =>
	typeof value === "string" && /^[A-Za-z0-9_.-]+$/.test(value) && value !== "." && value !== "..";
function fail(): never { throw new Error("raw artifact ownership/link contract could not be established"); }
export const rawDigest = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
export const sameInode = (a: Stats, b: Stats): boolean =>
	Number.isSafeInteger(a.dev) && Number.isSafeInteger(a.ino) && Number.isSafeInteger(b.dev) && Number.isSafeInteger(b.ino) && a.dev === b.dev && a.ino === b.ino;
export const sameRawVersion = (a: Stats, b: Stats): boolean =>
	sameInode(a, b) && a.size === b.size && a.nlink === b.nlink && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

async function directoryChain(project: string, path: string, identities: Map<string, Stats>): Promise<void> {
	const rel = relative(project, path);
	if (rel.startsWith("..") || resolve(project, rel) !== path) fail();
	let current = project;
	for (const part of ["", ...rel.split("/").filter(Boolean)]) {
		if (part) current = join(current, part);
		const info = await lstat(current);
		if (!info.isDirectory() || info.isSymbolicLink()) fail();
		identities.set(current, info);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function metadata(path: string): Promise<Record<string, unknown>> {
	const before = await lstat(path);
	if (!before.isFile() || before.nlink !== 1) fail();
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		if (!sameRawVersion(before, await file.stat())) fail();
		const value = JSON.parse(await file.readFile("utf8"));
		if (!sameRawVersion(before, await file.stat()) || !sameRawVersion(before, await lstat(path))) fail();
		if (!value || typeof value !== "object" || Array.isArray(value)) fail();
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
	await directoryChain(project, canonicalTask, directories);
	// SAFETY: only the fields checked below are consumed here; the launch-authority
	// validator checks the full recorded grant/provenance before mirror ownership.
	const run = await metadata(join(project, ".pi", "workflows", runId, "run.json")) as unknown as WorkflowRunRecord;
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
	const attemptKey = workflowTaskAttemptIdentity(task, workflowTaskSessionId(run, task));
	let attempt: string | undefined;
	let backend: unknown;
	if (task.launchAuthority !== undefined) {
		const records = task.launchAuthority.records?.filter(record => record.grant.attemptKey === attemptKey);
		if (records?.length !== 1) fail();
		const record = records[0]!;
		if (!hasNonSpawnableWorkflowLaunchAuthority(run, task, record.grant.backendId) || record.state.phase !== "consumed") fail();
		const state = record.state;
		if (!safeId(state.backendRunId) || !safeId(state.backendAttemptId) || await realpath(task.cwd) !== project) fail();
		const mirrorRun = join(project, ".pi", "workflow-subagents", runId, taskId, state.backendRunId);
		const attemptDir = join(mirrorRun, "attempts", state.backendAttemptId);
		await directoryChain(project, attemptDir, directories);
		const mirror = await metadata(join(mirrorRun, "run.json"));
		const terminal = await metadata(join(attemptDir, "result.json"));
		if (mirror.runId !== state.backendRunId || mirror.correlationId !== `${runId}:${taskId}` || mirror.latestAttemptId !== state.backendAttemptId || (mirror.activeAttemptId != null && mirror.activeAttemptId !== state.backendAttemptId) || !Array.isArray(mirror.attempts) || mirror.attempts.filter((item: unknown) => isRecord(item) && item.attemptId === state.backendAttemptId).length !== 1) fail();
		const mirrorAttempt = (mirror.attempts as unknown[]).find((item) => isRecord(item) && item.attemptId === state.backendAttemptId);
		if (mirror.activeAttemptId != null || typeof mirror.status !== "string" || !["completed", "failed"].includes(mirror.status) || !isRecord(mirrorAttempt) || typeof mirrorAttempt.status !== "string" || !["completed", "failed"].includes(mirrorAttempt.status)) fail();
		if (terminal.runId !== state.backendRunId || terminal.attemptId !== state.backendAttemptId || typeof terminal.status !== "string" || !["completed", "failed"].includes(terminal.status)) fail();
		attempt = join(attemptDir, "output.log");
		backend = { grant: record.grant, state, mirror: { runId: mirror.runId, correlationId: mirror.correlationId, latestAttemptId: mirror.latestAttemptId }, terminal };
	} else if (task.backendTaskId && task.backendTaskId !== taskId) {
		// Old records missing launch identity cannot authorize a mirrored inode.
		fail();
	}
	const identity = rawDigest(JSON.stringify({ runId, createdAt: run.createdAt, taskId, specId: task.specId, generation: task.generation, sourceGeneration: task.sourceGeneration, attemptKey, files: task.files, backend }));
	return { runDir, taskDir, raw: join(canonicalTask, "raw.md"), output: join(canonicalTask, "output.log"), attempt, identity, integrity: task.rawArtifactIntegrity, selection: expected, directories };
}

export async function recheckRawOwner(owner: RawOwner): Promise<void> {
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
		if (record.rawIntegrity !== undefined || (Array.isArray(record.tasks) && record.tasks.some((task: unknown) => isRecord(task) && task.taskId === basename(taskDir) && task.rawArtifactIntegrity !== undefined))) fail();
	}
}

export async function readRawIntegrity(owner: RawOwner, independentSnapshot = false): Promise<RawIntegrity | undefined> {
	const result = await metadata(join(owner.taskDir, "result.json"));
	if (result.schema !== "workflow-task-result-v1" || !isRecord(result.outputValidation) || result.outputValidation.valid !== true || !isRecord(result.artifacts) || result.artifacts.raw !== "raw.md") fail();
	const record = result.rawIntegrity;
	if (owner.integrity !== undefined && JSON.stringify(owner.integrity) !== JSON.stringify(record)) fail();
	if (record === undefined) {
		if (independentSnapshot) return undefined;
		// Exact current link accounting does NOT distinguish the original legacy
		// inode from replacement of every authorized name before validation. The
		// old host/mirror records have no raw digest. Do not invent that authority.
		throw new Error("legacy linked raw lacks a trusted original-byte integrity anchor");
	}
	if (!isRecord(record) || record.version !== 1 || record.owner !== owner.identity || typeof record.bytes !== "number" || !Number.isSafeInteger(record.bytes) || record.bytes < 0 || typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256)) fail();
	return { version: 1, owner: record.owner as string, bytes: record.bytes as number, sha256: record.sha256 as string };
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
