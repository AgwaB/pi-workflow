import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { goalHash } from "./goal-json.js";
import { goalFileContentIdentity, goalWorkspaceDelta, goalWorkspacePathCheck, type GoalFileValue } from "./goal-workspace.js";
import { observeGoalWorkspaceOrigin, type GoalWorkspaceHostHandle } from "./goal-workspace-host.js";

/**
 * Ordinary (workflow-engine) Goal origin application.
 *
 * After every criterion is achieved, the verified candidate bytes of the
 * consented scope are copied to the original working tree. Each changed path
 * must still hold the exact baseline bytes the candidate was derived from;
 * otherwise nothing is written and the conflict is reported. Writes are
 * per-file atomic (temporary file + rename) and never touch Git HEAD/index.
 * An interrupted application is reported path by path and never replayed.
 */
export type WorkflowGoalOriginApplyStatus =
	| "applying" | "applied" | "no-changes" | "conflict" | "unavailable" | "interrupted" | "failed";

export interface WorkflowGoalOriginApplyPath {
	path: string;
	action: "create" | "update" | "delete";
	state: "pending" | "applied" | "conflict" | "failed" | "unknown";
	beforeSha256: string | null;
	afterSha256: string | null;
}

export interface WorkflowGoalOriginApplyRecord {
	status: WorkflowGoalOriginApplyStatus;
	reason?: string;
	paths: WorkflowGoalOriginApplyPath[];
}

export interface ApplyGoalCandidateToOriginInput {
	originRoot: string;
	workspace: GoalWorkspaceHostHandle;
	controlRoots: readonly string[];
	signal?: AbortSignal;
	/** Called before the first write and after every path; failures abort further writes. */
	onProgress?: (record: WorkflowGoalOriginApplyRecord) => Promise<void>;
}

const sha = (value: GoalFileValue | null) => goalFileContentIdentity(value)?.sha256 ?? null;
const sameContent = (left: GoalFileValue | null, right: GoalFileValue | null) =>
	goalHash(goalFileContentIdentity(left)) === goalHash(goalFileContentIdentity(right));

function bufferIdentity(bytes: Buffer, mode: GoalFileValue["mode"]) {
	return {
		sha256: createHash("sha256").update(bytes).digest("hex"),
		bytes: bytes.length,
		lines: bytes.length === 0 ? 0 : bytes.reduce((count, byte) => count + (byte === 10 ? 1 : 0), 0) + (bytes.at(-1) === 10 ? 0 : 1),
		mode,
		links: 1 as const,
	};
}

/** Reads the current origin file without following a final symlink. */
async function readOriginFile(path: string): Promise<{ bytes: Buffer; mode: GoalFileValue["mode"] } | null> {
	const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return null;
		throw error;
	});
	if (!info) return null;
	if (!info.isFile() || info.nlink !== 1) throw new Error("Goal origin path is not a single-link regular file");
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		return { bytes: await handle.readFile(), mode: (info.mode & 0o111) ? "0755" : "0644" };
	} finally { await handle.close(); }
}

function currentMatches(current: { bytes: Buffer; mode: GoalFileValue["mode"] } | null, expected: GoalFileValue | null): boolean {
	if (expected === null) return current === null;
	if (current === null) return false;
	return goalHash(bufferIdentity(current.bytes, current.mode)) === goalHash(goalFileContentIdentity(expected));
}

/** Creates missing parent directories inside originRoot, refusing symlinked or non-directory components. */
async function ensureParentDirectories(originRoot: string, path: string): Promise<void> {
	const parts = path.split("/").slice(0, -1);
	let current = originRoot;
	for (const part of parts) {
		current = join(current, part);
		const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});
		if (!info) await mkdir(current, { mode: 0o755 });
		else if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Goal origin parent is not a plain directory: ${path}`);
	}
}

/** Stages the bytes beside the target, then rechecks the target immediately
 * before the rename so a concurrent edit made while staging is not replaced.
 * (A same-user writer racing the final rename itself is not excluded.) */
async function writeAtomically(target: string, bytes: Buffer, mode: GoalFileValue["mode"],
	unchanged: () => Promise<boolean>): Promise<boolean> {
	const temporary = join(target, "..", `.goal-apply-${randomBytes(8).toString("hex")}.tmp`);
	const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	try {
		await handle.writeFile(bytes);
		await handle.sync();
	} finally { await handle.close(); }
	try {
		await chmod(temporary, mode === "0755" ? 0o755 : 0o644);
		if (!await unchanged()) { await rm(temporary, { force: true }); return false; }
		await rename(temporary, target);
		return true;
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

export async function applyGoalCandidateToOrigin(input: ApplyGoalCandidateToOriginInput): Promise<WorkflowGoalOriginApplyRecord> {
	const { workspace } = input;
	if (workspace.baseline.mode !== "mutation" || !workspace.workspaceRoot)
		return { status: "unavailable", reason: "Goal candidate workspace is not a writable candidate", paths: [] };
	// Pin the canonical origin directory; every later step uses it and rechecks
	// that the named root still resolves to the same physical directory.
	const originRoot = await realpath(input.originRoot);
	const rootIdentity = await lstat(originRoot);
	const rootCurrent = async () => {
		const now = await lstat(originRoot).catch(() => null);
		return Boolean(now && now.isDirectory() && !now.isSymbolicLink() && now.dev === rootIdentity.dev &&
			now.ino === rootIdentity.ino && await realpath(input.originRoot).catch(() => null) === originRoot);
	};
	// The consented scope (all scoped paths, plus Git HEAD/index and protected
	// paths through the host's candidate observation) must still match the
	// baseline the candidate derived from.
	// Every scoped path must hold its baseline bytes, or the candidate bytes for
	// paths this application already wrote; Git HEAD and index must be unchanged.
	const applied = new Map<string, GoalFileValue | null>();
	const scopeDrift = async (): Promise<string[]> => {
		const origin = await observeGoalWorkspaceOrigin({
			originRoot, repository: workspace.baseline.origin.repository,
			scope: workspace.baseline.scope, protectedPaths: workspace.baseline.protectedPaths,
			controlRoots: input.controlRoots,
		});
		const drifted = workspace.baseline.origin.files.filter(file =>
			!sameContent(origin.files.find(now => now.path === file.path)?.worktree ?? null,
				applied.has(file.path) ? applied.get(file.path)! : file.worktree)).map(file => file.path);
		if (origin.headDigest !== workspace.baseline.origin.headDigest || origin.indexDigest !== workspace.baseline.origin.indexDigest)
			drifted.push("(git HEAD/index)");
		return drifted;
	};
	const originDrift = async (): Promise<WorkflowGoalOriginApplyRecord | null> => {
		const drifted = await scopeDrift();
		return drifted.length ? { status: "conflict", reason: "Origin changed after the candidate baseline; nothing was applied.",
			paths: workspace.baseline.origin.files.filter(file => drifted.includes(file.path)).map(file => ({
				path: file.path, action: "update", state: "conflict", beforeSha256: sha(file.worktree), afterSha256: null })) } : null;
	};
	const observeCandidate = async () => {
		try {
			return await workspace.inspectCandidate();
		} catch (error) {
			// The host rejects candidate observation when origin HEAD/index/protected bytes drifted.
			return { status: "conflict" as const, paths: [],
				reason: `${error instanceof Error ? error.message : String(error)}; nothing was applied.` };
		}
	};
	const initialDrift = await originDrift();
	if (initialDrift) return initialDrift;
	const candidate = await observeCandidate();
	if ("status" in candidate) return candidate;
	const delta = goalWorkspaceDelta(workspace.baseline, candidate);
	if (!delta.paths.length) return { status: "no-changes", paths: [] };
	const record: WorkflowGoalOriginApplyRecord = {
		status: "applying",
		paths: delta.paths.map(change => ({
			path: change.path,
			action: change.before === null ? "create" : change.after === null ? "delete" : "update",
			state: "pending",
			beforeSha256: sha(change.before),
			afterSha256: sha(change.after),
		})),
	};
	const finish = (status: WorkflowGoalOriginApplyStatus, reason?: string): WorkflowGoalOriginApplyRecord => {
		record.status = status;
		if (reason) record.reason = reason;
		return record;
	};
	// Load and verify every candidate byte before the first origin write.
	const contents = new Map<string, Buffer>();
	for (const change of delta.paths) {
		goalWorkspacePathCheck(change.path);
		if (change.after === null) continue;
		const loaded = await readOriginFile(join(workspace.workspaceRoot, ...change.path.split("/")));
		if (!loaded || goalHash(bufferIdentity(loaded.bytes, change.after.mode)) !== goalHash(goalFileContentIdentity(change.after)))
			return finish("failed", `Candidate bytes changed after verification: ${change.path}; nothing was applied.`);
		contents.set(change.path, loaded.bytes);
	}
	if (input.signal?.aborted) return finish("interrupted", "Stopped before origin application; nothing was applied.");
	await input.onProgress?.(record);
	// Recheck everything after staging and the durable progress record, immediately
	// before the first origin mutation.
	if (!await rootCurrent()) return finish("conflict", "Origin directory changed identity; nothing was applied.");
	const finalDrift = await originDrift();
	if (finalDrift) return finalDrift;
	const recheck = await observeCandidate();
	if ("status" in recheck) return recheck;
	if (goalHash(recheck) !== goalHash(candidate))
		return finish("failed", "Candidate changed after verification; nothing was applied.");
	for (const [index, change] of delta.paths.entries()) {
		const entry = record.paths[index];
		if (input.signal?.aborted) return finish("interrupted", "Stopped during origin application; remaining paths were not applied.");
		const target = join(originRoot, ...change.path.split("/"));
		const unchanged = async () => await rootCurrent() && currentMatches(await readOriginFile(target), change.before);
		try {
			if (!await unchanged()) {
				entry.state = "conflict";
				await input.onProgress?.(record);
				return finish("conflict", `Origin changed during application: ${change.path}; remaining paths were not applied.`);
			}
			// Persist the in-flight state before the effect: a crash leaves it UNKNOWN, never pending.
			entry.state = "unknown";
			await input.onProgress?.(record);
			// Revalidate the root and the whole scope after that durable record and
			// before creating directories, staging, or publishing anything.
			const drifted = await rootCurrent() ? await scopeDrift() : ["(origin directory identity)"];
			if (drifted.length) {
				entry.state = "conflict";
				await input.onProgress?.(record);
				return finish("conflict", `Origin changed during application (${drifted.join(", ")}); remaining paths were not applied.`);
			}
			// A stop that arrived while the in-flight record was persisted wins:
			// nothing has been written for this path yet.
			if (input.signal?.aborted) {
				entry.state = "pending";
				await input.onProgress?.(record).catch(() => undefined);
				return finish("interrupted", "Stopped during origin application; remaining paths were not applied.");
			}
			let published: boolean;
			if (change.after === null) {
				published = await unchanged();
				if (published) await rm(target);
			} else {
				await ensureParentDirectories(originRoot, change.path);
				published = await writeAtomically(target, contents.get(change.path)!, change.after.mode, unchanged);
			}
			if (!published) {
				entry.state = "conflict";
				await input.onProgress?.(record);
				return finish("conflict", `Origin changed during application: ${change.path}; remaining paths were not applied.`);
			}
			if (!currentMatches(await readOriginFile(target), change.after)) throw new Error(`Goal origin write was not observed: ${change.path}`);
			applied.set(change.path, change.after);
			entry.state = "applied";
		} catch (error) {
			if (entry.state !== "unknown") entry.state = "failed";
			await input.onProgress?.(record).catch(() => undefined);
			return finish("failed", `${error instanceof Error ? error.message : String(error)}; remaining paths were not applied.`);
		}
		await input.onProgress?.(record);
	}
	return finish("applied");
}
