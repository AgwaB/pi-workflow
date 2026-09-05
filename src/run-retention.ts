import { lstat, mkdtemp, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
	acquireRunFileLease,
	deriveRunStatus,
	isSafeRunId,
	isTerminalWorkflowStatus,
	isWorkflowRunLeaseLive,
	TERMINAL_INDEX_LIMIT,
	updateIndex,
	workflowsRoot,
} from "./store.js";
import type { WorkflowRunRecord, WorkflowRunStatus } from "./types.js";

export interface WorkflowPruneOptions {
	keep?: number;
	olderThanDays?: number;
	yes?: boolean;
}

export interface WorkflowPruneRun {
	runId: string;
	name?: string;
	status: WorkflowRunStatus;
	updatedAt: string;
	bytes: number;
	selected: boolean;
	protected: boolean;
	deleted: boolean;
	error?: string;
}

export interface WorkflowPruneSummary {
	dryRun: boolean;
	keep: number;
	olderThanDays?: number;
	runs: WorkflowPruneRun[];
	totalBytes: number;
	deletedBytes: number;
	indexUpdated: boolean;
	error?: string;
}

interface Candidate {
	run: WorkflowRunRecord;
	runDir: string;
	mirrorDir: string;
	bytes: number;
	identity: { dev: number; ino: number };
}

let beforeDeleteForTests: (() => void | Promise<void>) | undefined;
let afterQuarantineForTests: (() => void | Promise<void>) | undefined;
export function setWorkflowPruneAfterQuarantineForTests(hook?: () => void | Promise<void>): void {
	afterQuarantineForTests = hook;
}
export function setWorkflowPruneBeforeDeleteForTests(hook?: () => void | Promise<void>): void {
	beforeDeleteForTests = hook;
}

export async function pruneWorkflowRuns(
	cwd: string,
	options: WorkflowPruneOptions = {},
): Promise<WorkflowPruneSummary> {
	cwd = await realpath(resolve(cwd));
	const keep = normalizeNonNegativeInteger(options.keep, TERMINAL_INDEX_LIMIT);
	const olderThanDays = options.olderThanDays;
	if (olderThanDays !== undefined && (!Number.isFinite(olderThanDays) || olderThanDays < 0))
		throw new Error("--older-than requires a non-negative number of days");

	const candidates = await findTerminalCandidates(cwd);
	candidates.sort((left, right) => Date.parse(right.run.updatedAt) - Date.parse(left.run.updatedAt));
	const cutoff = olderThanDays === undefined ? undefined : Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
	const summaryRuns: WorkflowPruneRun[] = [];
	const deletedRunIds: string[] = [];

	for (const [index, candidate] of candidates.entries()) {
		const beyondKeep = index >= keep;
		const olderEnough = cutoff === undefined || Date.parse(candidate.run.updatedAt) < cutoff;
		const selected = beyondKeep && olderEnough;
		if (!selected) continue;
		const entry: WorkflowPruneRun = {
			runId: candidate.run.runId,
			...(candidate.run.name === undefined ? {} : { name: candidate.run.name }),
			status: candidate.run.status,
			updatedAt: candidate.run.updatedAt,
			bytes: candidate.bytes,
			selected: true,
			protected: false,
			deleted: false,
		};
		if (await isWorkflowRunLeaseLive(cwd, candidate.run.runId)) {
			entry.protected = true;
			entry.error = "live or indeterminate supervisor lease";
			summaryRuns.push(entry);
			continue;
		}
		if (!options.yes) {
			summaryRuns.push(entry);
			continue;
		}
		await beforeDeleteForTests?.();
		const deletion = await deleteCandidate(cwd, candidate);
		entry.protected = deletion.protected ?? false;
		entry.deleted = deletion.deleted;
		entry.error = deletion.error;
		if (deletion.deleted) deletedRunIds.push(candidate.run.runId);
		summaryRuns.push(entry);
	}

	let indexUpdated = false;
	let error: string | undefined;
	if (options.yes && deletedRunIds.length > 0) {
		try {
			await updateIndex(cwd);
			indexUpdated = true;
		} catch (indexError) {
			error = `index update failed: ${errorMessage(indexError)}`;
		}
	}
	return {
		dryRun: !options.yes,
		keep,
		...(olderThanDays === undefined ? {} : { olderThanDays }),
		runs: summaryRuns,
		totalBytes: summaryRuns.reduce((total, run) => total + (run.protected ? 0 : run.bytes), 0),
		deletedBytes: summaryRuns.reduce((total, run) => total + (run.deleted ? run.bytes : 0), 0),
		indexUpdated,
		...(error === undefined ? {} : { error }),
	};
}

export function formatWorkflowPruneSummary(summary: WorkflowPruneSummary): string {
	const lines = [summary.dryRun ? "Workflow prune (dry run)" : "Workflow prune"];
	if (summary.runs.length === 0) {
		lines.push("No terminal runs are beyond the retention filters.");
	} else {
		lines.push(summary.dryRun ? "Runs that would be deleted:" : "Runs selected for deletion:");
		for (const run of summary.runs) {
			lines.push(
				`- ${run.runId} ${run.name ?? "(unnamed)"} ${run.status} ${run.updatedAt} ${run.bytes} bytes${run.protected ? ` — protected: ${run.error}` : run.error ? ` — ${run.error}` : run.deleted ? " — deleted" : ""}`,
			);
		}
	}
	lines.push(`Total bytes: ${summary.totalBytes} (logical file bytes; hard links counted once, so du may report more)`);
	if (!summary.dryRun) lines.push(`Deleted bytes: ${summary.deletedBytes}`);
	if (summary.error) lines.push(`Error: ${summary.error}`);
	return lines.join("\n");
}

async function findTerminalCandidates(cwd: string): Promise<Candidate[]> {
	const root = workflowsRoot(cwd);
	const rootReal = await physicalRetentionRoot(root).catch(() => undefined);
	if (!rootReal) return [];
	const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
	const candidates: Candidate[] = [];
	for (const entry of entries) {
		if (!isSafeRunId(entry.name)) continue;
		const runDir = join(root, entry.name);
		if (!(await isContainedDirectory(rootReal, runDir))) continue;
		try {
			const run = await readTerminalCandidate(runDir);
			if (run.runId !== entry.name || !isTerminalWorkflowStatus(run.status) || !Number.isFinite(Date.parse(run.updatedAt))) continue;
			const mirrorDir = join(cwd, ".pi", "workflow-subagents", entry.name);
			const bytes = (await directoryBytes(runDir)) + (await containedDirectoryBytes(cwd, mirrorDir));
			candidates.push({ run, runDir, mirrorDir, bytes, identity: await lstat(runDir) });
		} catch {
			// Invalid, incomplete, or unreadable run records are protected by omission.
		}
	}
	return candidates;
}

async function deleteCandidate(
	cwd: string,
	candidate: Candidate,
): Promise<{ deleted: boolean; protected?: boolean; error?: string }> {
	const root = workflowsRoot(cwd);
	let lease: Awaited<ReturnType<typeof acquireRunFileLease>>;
	let primaryDeleted = false;
	try {
		await physicalRetentionRoot(root);
		const identity = await lstat(candidate.runDir);
		if (!identity.isDirectory() || identity.isSymbolicLink() ||
			identity.dev !== candidate.identity.dev || identity.ino !== candidate.identity.ino)
			throw new Error("run directory changed since selection");
		if (await isWorkflowRunLeaseLive(cwd, candidate.run.runId))
			return { deleted: false, protected: true, error: "live or indeterminate supervisor lease" };
		// Share the scheduler/resume lock, not a separate prune-only lock. The
		// earlier read-only probe is advisory; ownership closes the normal race.
		lease = await acquireRunFileLease(cwd, candidate.run.runId, "supervisor");
		if (!lease) return { deleted: false, protected: true, error: "supervisor lease acquired concurrently" };
		const current = await readTerminalCandidate(candidate.runDir);
		if (current.runId !== candidate.run.runId || current.updatedAt !== candidate.run.updatedAt ||
			!isTerminalWorkflowStatus(current.status))
			return { deleted: false, protected: true, error: "run changed since selection" };
		// Remove the old mirror while the original run still occupies its name;
		// a later run reusing that name must never lose its new mirror.
		await lease.assertOwner();
		await removeContainedDirectory(join(cwd, ".pi", "workflow-subagents"), candidate.mirrorDir);
		await lease.assertOwner();
		await removeContainedDirectory(root, candidate.runDir, candidate.identity);
		primaryDeleted = true;
		return { deleted: true };
	} catch (error) {
		return { deleted: primaryDeleted, error: errorMessage(error) };
	} finally {
		await lease?.release();
	}
}

async function readTerminalCandidate(runDir: string): Promise<WorkflowRunRecord> {
	const file = join(runDir, "run.json");
	const info = await lstat(file);
	if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("unsafe run record");
	const run = JSON.parse(await readFile(file, "utf8")) as WorkflowRunRecord;
	const statuses = new Set(["pending", "running", "blocked", "completed", "failed", "skipped", "interrupted"]);
	if (!Array.isArray(run.tasks) || !run.tasks.every(task => task && statuses.has(task.status)))
		throw new Error("invalid task statuses");
	return deriveRunStatus(run);
}

async function physicalRetentionRoot(root: string): Promise<string> {
	// cwd has been canonicalized, but application-owned ancestors must never
	// be canonicalized through a symlink into an unrelated retention tree.
	for (const path of [resolve(root, ".."), root]) {
		const info = await lstat(path);
		if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe retention root");
	}
	const physical = await realpath(root);
	if (physical !== resolve(root)) throw new Error("retention root changed");
	return physical;
}

async function removeContainedDirectory(root: string, directory: string, identity?: { dev: number; ino: number }): Promise<void> {
	let rootReal: string;
	try {
		rootReal = await physicalRetentionRoot(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	let info;
	try {
		info = await lstat(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("path is not a real directory");
	if (identity && (info.dev !== identity.dev || info.ino !== identity.ino)) throw new Error("run directory changed since selection");
	const directoryReal = await realpath(directory);
	if (!isInside(rootReal, directoryReal)) throw new Error("path is outside retention root");
	// Detach the selected generation before recursive removal can unlink its
	// supervisor.lock. An unlocked/recreated original name is not our target.
	// The container has no run.json, so index readers ignore it during removal.
	const container = await mkdtemp(join(rootReal, ".prune-"));
	const detached = join(container, "run");
	let moved = false;
	try {
		await physicalRetentionRoot(root);
		const current = await lstat(directory);
		if (current.dev !== info.dev || current.ino !== info.ino) throw new Error("directory changed before quarantine");
		await rename(directory, detached);
		moved = true;
		if (identity) await afterQuarantineForTests?.();
		await rm(container, { recursive: true, force: true });
	} catch (error) {
		if (!moved) await rm(container, { recursive: true, force: true }).catch(() => undefined);
		throw new Error(`${errorMessage(error)}${moved ? `; detached evidence retained at ${detached}` : ""}`);
	}
}

async function containedDirectoryBytes(cwd: string, directory: string): Promise<number> {
	const root = join(cwd, ".pi", "workflow-subagents");
	try {
		if (!(await isContainedDirectory(await physicalRetentionRoot(root), directory))) return 0;
		return await directoryBytes(directory);
	} catch {
		return 0;
	}
}

async function isContainedDirectory(root: string, directory: string): Promise<boolean> {
	try {
		const info = await lstat(directory);
		if (!info.isDirectory() || info.isSymbolicLink()) return false;
		return isInside(root, await realpath(directory));
	} catch {
		return false;
	}
}

async function directoryBytes(directory: string): Promise<number> {
	const seen = new Set<string>();
	async function walk(current: string): Promise<number> {
		const entries = await readdir(current, { withFileTypes: true });
		let total = 0;
		for (const entry of entries) {
			if (entry.isSymbolicLink()) continue;
			const file = join(current, entry.name);
			if (entry.isDirectory()) {
				total += await walk(file);
			} else if (entry.isFile()) {
				const info = await lstat(file);
				const identity = `${info.dev}:${info.ino}`;
				if (!seen.has(identity)) {
					seen.add(identity);
					total += info.size;
				}
			}
		}
		return total;
	}
	return walk(directory).catch(() => 0);
}

function isInside(root: string, child: string): boolean {
	const rel = relative(resolve(root), resolve(child));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) throw new Error("--keep requires a non-negative integer");
	return value;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
