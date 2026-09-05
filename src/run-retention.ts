import { lstat, mkdtemp, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
	acquireRunFileLease,
	acquireWorkflowTopologyLease,
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
	/** Canonical identity removed, even if recovery evidence is retained. */
	detached?: boolean;
	purged?: boolean;
	retainedEvidencePath?: string;
	retainedMirrorPath?: string;
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
let beforePrimaryDetachForTests: (() => void | Promise<void>) | undefined;
export function setWorkflowPruneBeforePrimaryDetachForTests(hook?: () => void | Promise<void>): void {
	beforePrimaryDetachForTests = hook;
}
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

	// No topology lock (or any filesystem writes) for a preview.
	if (!options.yes) return prunePlan(cwd, options, keep, olderThanDays);
	if (!(await physicalRetentionRoot(workflowsRoot(cwd)).catch(() => undefined)))
		return prunePlan(cwd, options, keep, olderThanDays);
	const topology = await acquireWorkflowTopologyLease(cwd);
	if (!topology) return { dryRun: false, keep, olderThanDays, runs: [], totalBytes: 0, deletedBytes: 0, indexUpdated: false, error: "workflow topology lease unavailable" };
	try {
		return await prunePlan(cwd, options, keep, olderThanDays, topology.assertOwner);
	} finally {
		await topology.release();
	}
}

interface RetentionPlan {
	candidates: Candidate[];
	children: Map<string, Set<string>>;
	uncertain: boolean;
}

async function prunePlan(
	cwd: string, options: WorkflowPruneOptions, keep: number, olderThanDays?: number,
	assertTopologyOwner?: () => Promise<void>,
): Promise<WorkflowPruneSummary> {
	const plan = await findRetentionPlan(cwd);
	const candidates = plan.candidates;
	candidates.sort((left, right) => Date.parse(right.run.updatedAt) - Date.parse(left.run.updatedAt));
	const cutoff = olderThanDays === undefined ? undefined : Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
	const summaryRuns: WorkflowPruneRun[] = [];
	const detachedRunIds: string[] = [];
	const purgedRunIds = new Set<string>();
	const selected = candidates.filter((candidate, index) => index >= keep &&
		(cutoff === undefined || Date.parse(candidate.run.updatedAt) < cutoff));

	for (const candidate of childrenFirst(selected, plan.children)) {
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
		const referenceError = await retainedChildReason(cwd, candidate.run.runId, plan, purgedRunIds);
		if (referenceError) {
			entry.protected = true;
			entry.error = referenceError;
			summaryRuns.push(entry);
			continue;
		}
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
		const deletion = await deleteCandidate(cwd, candidate, async () => {
			await assertTopologyOwner?.();
			return retainedChildReason(cwd, candidate.run.runId, plan, purgedRunIds);
		});
		Object.assign(entry, deletion);
		if (deletion.detached) detachedRunIds.push(candidate.run.runId);
		if (deletion.purged) purgedRunIds.add(candidate.run.runId);
		summaryRuns.push(entry);
	}

	let indexUpdated = false;
	const failures = summaryRuns.filter((run) => !run.protected && run.error);
	let error = failures.length > 0 ? `${failures.length} selected run(s) failed to purge` : undefined;
	if (options.yes && detachedRunIds.length > 0) {
		try {
			await updateIndex(cwd);
			indexUpdated = true;
		} catch (indexError) {
			error = `${error ? `${error}; ` : ""}index update failed: ${errorMessage(indexError)}`;
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
			if (run.retainedEvidencePath) lines.push(`  Retained run evidence: ${run.retainedEvidencePath}`);
			if (run.retainedMirrorPath) lines.push(`  Retained mirror evidence: ${run.retainedMirrorPath}`);
		}
	}
	lines.push(`Total bytes: ${summary.totalBytes} (logical file bytes; hard links counted once, so du may report more)`);
	if (!summary.dryRun) lines.push(`Deleted bytes: ${summary.deletedBytes}`);
	if (summary.error) lines.push(`Error: ${summary.error}`);
	return lines.join("\n");
}

async function findRetentionPlan(cwd: string): Promise<RetentionPlan> {
	const plan: RetentionPlan = { candidates: [], children: new Map(), uncertain: false };
	const root = workflowsRoot(cwd);
	const rootReal = await physicalRetentionRoot(root).catch(() => undefined);
	if (!rootReal) return plan;
	const entries = await readdir(root, { withFileTypes: true });
	for (const entry of entries) {
		const quarantine = entry.name.startsWith(".prune-");
		if (!quarantine && !isSafeRunId(entry.name)) continue;
		// Ordinary root metadata (index, lock) is not a run directory.
		if (!quarantine && entry.isFile()) continue;
		const runDir = join(root, entry.name, ...(quarantine ? ["run"] : []));
		try {
			if (!(await isContainedDirectory(rootReal, runDir))) throw new Error("uncertain run directory");
			const run = await readTerminalCandidate(runDir);
			if (!isSafeRunId(run.runId) || (!quarantine && run.runId !== entry.name) ||
				(run.parentRunId !== undefined && !isSafeRunId(run.parentRunId)) ||
				(run.rootRunId !== undefined && !isSafeRunId(run.rootRunId)) ||
				(!run.parentRunId && run.rootRunId !== undefined && run.rootRunId !== run.runId)) throw new Error("uncertain run identity");
			if (run.parentRunId) {
				const children = plan.children.get(run.parentRunId) ?? new Set<string>();
				children.add(entry.name);
				plan.children.set(run.parentRunId, children);
			}
			if (quarantine || !isTerminalWorkflowStatus(run.status) || !Number.isFinite(Date.parse(run.updatedAt))) continue;
			const mirrorDir = join(cwd, ".pi", "workflow-subagents", entry.name);
			const bytes = (await directoryBytes(runDir)) + (await containedDirectoryBytes(cwd, mirrorDir));
			plan.candidates.push({ run, runDir, mirrorDir, bytes, identity: await lstat(runDir) });
		} catch {
			// An unreadable record may reference ANY candidate. Do not guess.
			plan.uncertain = true;
		}
	}
	return plan;
}

function childrenFirst(candidates: Candidate[], children: Map<string, Set<string>>): Candidate[] {
	const selected = new Map(candidates.map((candidate) => [candidate.run.runId, candidate]));
	const pending = new Map(candidates.map((candidate) => [candidate.run.runId,
		[...(children.get(candidate.run.runId) ?? [])].filter((id) => selected.has(id)).length]));
	const queue = candidates.filter((candidate) => pending.get(candidate.run.runId) === 0);
	const visited = new Set<string>();
	for (let index = 0; index < queue.length; index += 1) {
		const candidate = queue[index];
		visited.add(candidate.run.runId);
		const parent = candidate.run.parentRunId;
		if (!parent || !pending.has(parent)) continue;
		pending.set(parent, pending.get(parent)! - 1);
		if (pending.get(parent) === 0) queue.push(selected.get(parent)!);
	}
	// Cycles remain protected by their references, rather than being omitted.
	return [...queue, ...candidates.filter((candidate) => !visited.has(candidate.run.runId))];
}

async function retainedChildReason(
	cwd: string, runId: string, plan: RetentionPlan, purged: Set<string>,
): Promise<string | undefined> {
	if (plan.uncertain) return "uncertain run references";
	for (const child of plan.children.get(runId) ?? []) {
		if (!purged.has(child)) return `retained direct child: ${child}`;
		// A selected child was purged, but its canonical name may have been
		// recreated. Never remove its ancestor based on the old generation.
		try {
			await lstat(join(workflowsRoot(cwd), child));
			return `recreated direct child: ${child}`;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return `uncertain direct child: ${child}`;
		}
	}
	return undefined;
}

type DeletionOutcome = Pick<WorkflowPruneRun, "deleted" | "detached" | "purged" | "protected" | "error" | "retainedEvidencePath" | "retainedMirrorPath">;

async function deleteCandidate(
	cwd: string, candidate: Candidate, recheckReferences: () => Promise<string | undefined>,
): Promise<DeletionOutcome> {
	const root = workflowsRoot(cwd);
	let lease: Awaited<ReturnType<typeof acquireRunFileLease>>;
	const outcome: DeletionOutcome = { deleted: false, detached: false, purged: false, protected: false };
	let primary: Quarantine | undefined;
	let mirror: Quarantine | undefined;
	try {
		await physicalRetentionRoot(root);
		const identity = await lstat(candidate.runDir);
		if (!identity.isDirectory() || identity.isSymbolicLink() ||
			identity.dev !== candidate.identity.dev || identity.ino !== candidate.identity.ino)
			throw new Error("run directory changed since selection");
		if (await isWorkflowRunLeaseLive(cwd, candidate.run.runId))
			return { ...outcome, protected: true, error: "live or indeterminate supervisor lease" };
		lease = await acquireRunFileLease(cwd, candidate.run.runId, "supervisor");
		if (!lease) return { ...outcome, protected: true, error: "supervisor lease acquired concurrently" };
		const current = await readTerminalCandidate(candidate.runDir);
		if (current.runId !== candidate.run.runId || current.updatedAt !== candidate.run.updatedAt ||
			!isTerminalWorkflowStatus(current.status))
			return { ...outcome, protected: true, error: "run changed since selection" };
		const reason = await recheckReferences();
		if (reason) return { ...outcome, protected: true, error: reason };
		await lease.assertOwner();
		// No irreversible removal until BOTH generations are safely detached.
		mirror = await quarantineContainedDirectory(join(cwd, ".pi", "workflow-subagents"), candidate.mirrorDir);
		outcome.retainedMirrorPath = mirror?.directory;
		await beforePrimaryDetachForTests?.();
		await lease.assertOwner();
		const finalReason = await recheckReferences();
		if (finalReason) throw new Error(finalReason);
		primary = await quarantineContainedDirectory(root, candidate.runDir, candidate.identity, async () => {
			await lease!.assertOwner();
			const reason = await recheckReferences();
			if (reason) throw new Error(reason);
		});
		if (!primary) throw new Error("selected run disappeared before detach");
		outcome.detached = true;
		outcome.retainedEvidencePath = primary.directory;
		await afterQuarantineForTests?.();
		if (mirror) {
			await rm(mirror.container, { recursive: true, force: true });
			outcome.retainedMirrorPath = undefined;
		}
		await rm(primary.container, { recursive: true, force: true });
		outcome.retainedEvidencePath = undefined;
		outcome.purged = true;
		outcome.deleted = true;
	} catch (error) {
		outcome.error = errorMessage(error);
	} finally {
		try { await lease?.release(); }
		catch (error) { outcome.error = `${outcome.error ? `${outcome.error}; ` : ""}lease release failed: ${errorMessage(error)}`; }
	}
	return outcome;
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

interface Quarantine { container: string; directory: string }

async function quarantineContainedDirectory(
	root: string, directory: string, identity?: { dev: number; ino: number },
	commitFence?: () => Promise<void>,
): Promise<Quarantine | undefined> {
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
		await commitFence?.();
		await rename(directory, detached);
		moved = true;
		return { container, directory: detached };
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
