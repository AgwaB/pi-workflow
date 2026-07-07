import { join } from "node:path";

import { normalizedUsageValues } from "./subagent-backend.js";
import { nowIso, readIndex, readJson, workflowRunDir, writeJsonAtomic } from "./store.js";
import type { WorkflowTaskUsageValues } from "./types.js";

/**
 * Parent-session usage tracking. Subagent tokens are recorded per task by the
 * backend, but the orchestrating pi session's own turns (routing, waiting,
 * summarizing) were invisible. This module sums assistant per-request usage
 * from the parent session while runs started from this session are active.
 *
 * The totals live in a sidecar file (never run.json): a detached supervisor
 * owns run.json, so writing there from the parent session would race it.
 */

export const PARENT_USAGE_FILE = "parent-usage.json";

const PARENT_USAGE_SCHEMA = "workflow-parent-usage-v1";

export interface WorkflowParentUsageRecord extends WorkflowTaskUsageValues {
	schema: typeof PARENT_USAGE_SCHEMA;
	source: "parent-session";
	runId: string;
	startedAt: string;
	updatedAt: string;
	completedAt?: string;
	assistantMessages: number;
}

const ACCUMULATED_USAGE_KEYS = [
	"inputTokens",
	"outputTokens",
	"totalTokens",
	"cachedInputTokens",
	"cacheCreationInputTokens",
	"cacheReadInputTokens",
	"reasoningTokens",
	"costUsd",
] as const satisfies readonly (keyof WorkflowTaskUsageValues)[];

const TERMINAL_INDEX_STATUSES = new Set([
	"completed",
	"failed",
	"interrupted",
]);

interface TrackedRun {
	cwd: string;
	runId: string;
	record: WorkflowParentUsageRecord;
	/** Serializes sidecar writes so a fast turn cannot interleave with a slow one. */
	pendingWrite: Promise<void>;
}

const trackedRuns = new Map<string, TrackedRun>();

function trackedRunKey(cwd: string, runId: string): string {
	return `${cwd}\0${runId}`;
}

function parentUsageFile(cwd: string, runId: string): string {
	return join(workflowRunDir(cwd, runId), PARENT_USAGE_FILE);
}

function emptyParentUsageRecord(runId: string): WorkflowParentUsageRecord {
	const capturedAt = nowIso();
	return {
		schema: PARENT_USAGE_SCHEMA,
		source: "parent-session",
		runId,
		startedAt: capturedAt,
		updatedAt: capturedAt,
		assistantMessages: 0,
	};
}

/** Start attributing this session's assistant usage to a freshly started run. */
export function beginParentUsageTracking(cwd: string, runId: string): void {
	const key = trackedRunKey(cwd, runId);
	if (trackedRuns.has(key)) return;
	trackedRuns.set(key, {
		cwd,
		runId,
		record: emptyParentUsageRecord(runId),
		pendingWrite: Promise.resolve(),
	});
}

/**
 * Re-attach tracking after a session restart: any still-active run with an
 * existing sidecar was started from this session and keeps accumulating.
 */
export async function resumeParentUsageTracking(cwd: string): Promise<void> {
	const index = await readIndex(cwd).catch(() => undefined);
	for (const entry of index?.runs ?? []) {
		if (entry.status !== "running") continue;
		const key = trackedRunKey(cwd, entry.runId);
		if (trackedRuns.has(key)) continue;
		const existing = await readParentUsage(cwd, entry.runId).catch(
			() => undefined,
		);
		if (!existing || existing.completedAt) continue;
		trackedRuns.set(key, {
			cwd,
			runId: entry.runId,
			record: existing,
			pendingWrite: Promise.resolve(),
		});
	}
}

export async function readParentUsage(
	cwd: string,
	runId: string,
): Promise<WorkflowParentUsageRecord | undefined> {
	const record = await readJson<WorkflowParentUsageRecord>(
		parentUsageFile(cwd, runId),
	);
	return record?.schema === PARENT_USAGE_SCHEMA ? record : undefined;
}

function accumulateUsage(
	record: WorkflowParentUsageRecord,
	values: WorkflowTaskUsageValues,
): void {
	for (const key of ACCUMULATED_USAGE_KEYS) {
		const value = values[key];
		if (typeof value !== "number") continue;
		const current = record[key];
		record[key] = typeof current === "number" ? current + value : value;
	}
}

function assistantUsageFromMessage(message: unknown): unknown {
	if (typeof message !== "object" || message === null) return undefined;
	const record = message as Record<string, unknown>;
	if (record.role !== "assistant") return undefined;
	return record.usage;
}

/**
 * Feed one parent-session `message_end` into every tracked run. Runs that the
 * index reports terminal still receive this message (it is the wrap-up turn
 * that summarizes the run) and are then finalized and dropped.
 */
export async function recordParentSessionUsage(
	cwd: string,
	message: unknown,
): Promise<void> {
	const tracked = [...trackedRuns.values()].filter(
		(entry) => entry.cwd === cwd,
	);
	if (tracked.length === 0) return;
	const usage = assistantUsageFromMessage(message);
	if (usage === undefined || usage === null) return;
	const values = normalizedUsageValues(usage);
	const capturedAt = nowIso();
	const index = await readIndex(cwd).catch(() => undefined);
	const statusByRun = new Map(
		(index?.runs ?? []).map((entry) => [entry.runId, entry.status as string]),
	);

	for (const entry of tracked) {
		accumulateUsage(entry.record, values);
		entry.record.assistantMessages += 1;
		entry.record.updatedAt = capturedAt;
		const status = statusByRun.get(entry.runId);
		const terminal = status !== undefined && TERMINAL_INDEX_STATUSES.has(status);
		if (terminal) {
			entry.record.completedAt = capturedAt;
			trackedRuns.delete(trackedRunKey(entry.cwd, entry.runId));
		}
		const snapshot = { ...entry.record };
		entry.pendingWrite = entry.pendingWrite
			.catch(() => undefined)
			.then(() =>
				writeJsonAtomic(parentUsageFile(entry.cwd, entry.runId), snapshot),
			);
		await entry.pendingWrite.catch(() => undefined);
	}
}

export function resetParentUsageTrackingForTests(): void {
	trackedRuns.clear();
}
