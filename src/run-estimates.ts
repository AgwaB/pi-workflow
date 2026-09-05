import {
	compiledWorkflowPath,
	isMockRunProvenance,
	listRunRecords,
	readIndex,
	readJson,
	workflowRunPath,
} from "./store.js";
import type { CompiledWorkflow, WorkflowRunRecord } from "./types.js";

const MAX_DURATION_SAMPLES = 8;
const MIN_DURATION_SAMPLES = 2;

export const DUPLICATE_RUN_WINDOW_MS = 10 * 60 * 1000;

/** Statuses that count as an in-flight run for the duplicate-launch guard. */
const ACTIVE_RUN_STATUSES = new Set(["running", "pending", "blocked"]);

export interface WorkflowDurationEstimate {
	medianMs: number;
	samples: number;
}

export type DuplicateRunTarget =
	| { kind: "spec"; name: string | undefined }
	| { kind: "dynamic" };

export interface DuplicateActiveRunMatch {
	runId: string;
	createdAt: string;
}

/**
 * Estimate wall time for a workflow from the most recent completed top-level
 * runs with the same name in the workflow index. Index rows do not expose
 * provenance, so candidates are read newest-first until MAX_DURATION_SAMPLES
 * usable durations are found or candidates are exhausted. Mock runs are excluded;
 * unreadable records are kept. The usable-sample cap does not bound file reads.
 * Returns undefined when fewer than MIN_DURATION_SAMPLES samples exist.
 */
export async function estimateWorkflowDurationMs(
	cwd: string,
	workflowName: string | undefined,
): Promise<WorkflowDurationEstimate | undefined> {
	if (!workflowName) return undefined;
	const index = await readIndex(cwd).catch(() => undefined);
	if (!index) return undefined;

	const candidates = index.runs
		.filter(
			(run) =>
				!run.parentRunId &&
				run.status === "completed" &&
				run.name === workflowName,
		)
		.map((run) => ({
			runId: run.runId,
			createdAtMs: Date.parse(run.createdAt),
			wallMs: Date.parse(run.updatedAt) - Date.parse(run.createdAt),
		}))
		.filter(
			(entry) =>
				Number.isFinite(entry.createdAtMs) &&
				Number.isFinite(entry.wallMs) &&
				entry.wallMs > 0,
		)
		.sort((a, b) => b.createdAtMs - a.createdAtMs);

	const walls: number[] = [];
	for (const entry of candidates) {
		if (walls.length >= MAX_DURATION_SAMPLES) break;
		const record = await readJson<WorkflowRunRecord>(
			workflowRunPath(cwd, entry.runId),
		).catch(() => undefined);
		if (record && isMockRunProvenance(record.provenance)) continue;
		walls.push(entry.wallMs);
	}
	if (walls.length < MIN_DURATION_SAMPLES) return undefined;
	return { medianMs: median(walls), samples: walls.length };
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? sorted[middle]!
		: Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

/** Compact human duration: 45s, 18m, 2h, 2h 05m-style (no zero padding). */
export function formatApproxDuration(ms: number): string {
	const totalSeconds = Math.max(1, Math.round(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const totalMinutes = Math.round(totalSeconds / 60);
	if (totalMinutes < 60) return `${totalMinutes}m`;
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/**
 * Find an active (running/pending/blocked) top-level run started within the
 * last windowMs that duplicates a pending launch: same workflow identity and
 * byte-identical task text. Task text lives on compiled.json (run.json does
 * not store it), so compiled.json is read for the few active candidates.
 * Dynamic targets match candidates whose run.json provenance mode is
 * "direct-dynamic"; spec targets match on run name and skip dynamic runs.
 */
export async function findDuplicateActiveRun(
	cwd: string,
	target: DuplicateRunTarget,
	task: string,
	options: { windowMs?: number; now?: number } = {},
): Promise<DuplicateActiveRunMatch | undefined> {
	if (!task) return undefined;
	const windowMs = options.windowMs ?? DUPLICATE_RUN_WINDOW_MS;
	const now = options.now ?? Date.now();
	const records = await listRunRecords(cwd).catch(() => []);
	const cached = await readIndex(cwd).catch(() => undefined);
	const cachedByRunId = new Map(
		(cached?.runs ?? []).map((entry) => [entry.runId, entry]),
	);
	const sourceCandidates = records.map((record) => {
		const cachedEntry = cachedByRunId.get(record.runId);
		if (!cachedEntry) return record;
		return {
			...record,
			name: record.name ?? cachedEntry.name,
			createdAt: record.createdAt ?? cachedEntry.createdAt,
			updatedAt: record.updatedAt ?? cachedEntry.updatedAt,
			parentRunId: record.parentRunId ?? cachedEntry.parentRunId,
			status: record.tasks.length === 0 ? cachedEntry.status : record.status,
		};
	});
	const candidates = sourceCandidates
		.filter((run) => {
			if (run.parentRunId) return false;
			if (!ACTIVE_RUN_STATUSES.has(run.status)) return false;
			if (target.kind === "spec" && run.name !== target.name) return false;
			const createdAtMs = Date.parse(run.createdAt);
			return Number.isFinite(createdAtMs) && now - createdAtMs <= windowMs;
		})
		.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

	for (const candidate of candidates) {
		if (isMockRunProvenance(candidate.provenance)) continue;
		const isDynamicRun = candidate.provenance?.mode === "direct-dynamic";
		if (target.kind === "dynamic" && !isDynamicRun) continue;
		if (target.kind === "spec" && isDynamicRun) continue;
		const compiled = await readJson<CompiledWorkflow>(
			compiledWorkflowPath(cwd, candidate.runId),
		).catch(() => undefined);
		if (typeof compiled?.task !== "string" || compiled.task !== task) continue;
		return { runId: candidate.runId, createdAt: candidate.createdAt };
	}
	return undefined;
}
