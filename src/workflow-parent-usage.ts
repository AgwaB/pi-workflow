import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

import { normalizedUsageValues } from "./subagent-backend.js";
import { acquireRunFileLease, nowIso, readIndex, readJson, workflowRunDir, writeJsonAtomic } from "./store.js";
import type { WorkflowTaskUsageValues } from "./types.js";

/** Parent assistant usage is a sidecar: the scheduler owns run.json. */
export const PARENT_USAGE_FILE = "parent-usage.json";
const PARENT_USAGE_SCHEMA = "workflow-parent-usage-v1";

export interface WorkflowParentUsageRecord extends WorkflowTaskUsageValues {
	schema: typeof PARENT_USAGE_SCHEMA;
	source: "parent-session";
	runId: string;
	/** Absent on historical v1 sidecars; unknown ownership is never inferred. */
	sessionId?: string;
	/** Durable replay receipts, updated in the same transaction as the totals. */
	messageIds?: string[];
	startedAt: string;
	updatedAt: string;
	completedAt?: string;
	assistantMessages: number;
}

const ACCUMULATED_USAGE_KEYS = [
	"inputTokens", "outputTokens", "totalTokens", "cachedInputTokens",
	"cacheCreationInputTokens", "cacheReadInputTokens", "reasoningTokens", "costUsd",
] as const satisfies readonly (keyof WorkflowTaskUsageValues)[];
const TERMINAL_INDEX_STATUSES = new Set(["completed", "failed", "blocked", "interrupted"]);
// Backward-compatible owner-omitting API calls are process-local, not a claim
// on a persisted Pi session. A different process cannot resume this identity.
const localOwner = `process:${randomUUID()}`;
interface TrackedRun {
	cwd: string;
	runId: string;
	sessionId: string;
	pendingWrite: Promise<void>;
}
const trackedRuns = new Map<string, TrackedRun>();
const trackedRunKey = (cwd: string, runId: string, sessionId: string): string => `${cwd}\0${runId}\0${sessionId}`;
const parentUsageFile = (cwd: string, runId: string): string => join(workflowRunDir(cwd, runId), PARENT_USAGE_FILE);

async function mutate(entry: TrackedRun, update: (record: WorkflowParentUsageRecord) => void): Promise<void> {
	const lease = await acquireRunFileLease(entry.cwd, entry.runId, "parent-usage", 5_000);
	if (!lease) throw new Error(`Parent usage sidecar busy: ${entry.runId}`);
	try {
		const existing = await readJson<WorkflowParentUsageRecord>(parentUsageFile(entry.cwd, entry.runId));
		// Also check durable feedback ownership when it exists. Legacy sidecars
		// remain readable but frozen, even if a caller explicitly begins tracking.
		const audience = await readJson<{ schema?: string; runId?: string; sessionId?: string }>(
			join(workflowRunDir(entry.cwd, entry.runId), "feedback-audience.json"),
		);
		if (existing && (existing.schema !== PARENT_USAGE_SCHEMA || existing.runId !== entry.runId || existing.sessionId !== entry.sessionId)) return;
		if (audience && (audience.schema !== "workflow-feedback-audience-v1" || audience.runId !== entry.runId || audience.sessionId !== entry.sessionId)) return;
		const record: WorkflowParentUsageRecord = existing ?? {
			schema: PARENT_USAGE_SCHEMA, source: "parent-session", runId: entry.runId,
			sessionId: entry.sessionId, startedAt: nowIso(), updatedAt: nowIso(), assistantMessages: 0,
		};
		update(record);
		await lease.assertOwner();
		await writeJsonAtomic(parentUsageFile(entry.cwd, entry.runId), record);
	} finally { await lease.release(); }
}

/** Begin is still synchronous; queued initialization persists even before a turn. */
export function beginParentUsageTracking(cwd: string, runId: string, sessionId = localOwner): void {
	if (!sessionId.trim()) return;
	const key = trackedRunKey(cwd, runId, sessionId);
	if (trackedRuns.has(key)) return;
	const entry: TrackedRun = { cwd, runId, sessionId, pendingWrite: Promise.resolve() };
	trackedRuns.set(key, entry);
	entry.pendingWrite = mutate(entry, (record) => { delete record.completedAt; });
	// Prevent unhandled rejections for legacy callers that do not await a flush.
	void entry.pendingWrite.catch(() => undefined);
}

/** Resume only this known owner; preserve historical totals on a resumed run. */
export async function resumeParentUsageTracking(cwd: string, sessionId = localOwner): Promise<void> {
	const index = await readIndex(cwd);
	for (const run of index?.runs ?? []) {
		if (run.status !== "running") continue;
		const existing = await readParentUsage(cwd, run.runId).catch(() => undefined);
		if (existing?.sessionId !== sessionId) continue;
		beginParentUsageTracking(cwd, run.runId, sessionId);
	}
	await flushParentUsageTracking(cwd, sessionId);
}

export async function readParentUsage(cwd: string, runId: string): Promise<WorkflowParentUsageRecord | undefined> {
	const record = await readJson<WorkflowParentUsageRecord>(parentUsageFile(cwd, runId));
	return record?.schema === PARENT_USAGE_SCHEMA ? record : undefined;
}

/** Feed message_end into owned active runs; terminal wrap-up is counted once. */
export async function recordParentSessionUsage(cwd: string, message: unknown, sessionId = localOwner, messageId?: string): Promise<void> {
	if (typeof message !== "object" || message === null) return;
	const msg = message as Record<string, unknown>;
	if (msg.role !== "assistant" || msg.usage == null) return;
	const values = normalizedUsageValues(msg.usage);
	// Pi messages carry timestamps. Explicit session-entry IDs are preferred;
	// timestamp + content hashing also deduplicates same-session process replay.
	const receipt = messageId ?? (typeof msg.timestamp === "number"
		? createHash("sha256").update(JSON.stringify(message)).digest("hex") : undefined);
	const tracked = [...trackedRuns.values()].filter(e => e.cwd === cwd && e.sessionId === sessionId);
	await Promise.all(tracked.map(entry => {
		entry.pendingWrite = entry.pendingWrite.then(async () => {
			const index = await readIndex(cwd);
			const terminal = TERMINAL_INDEX_STATUSES.has(index?.runs.find(r => r.runId === entry.runId)?.status ?? "");
			await mutate(entry, record => {
				if (record.completedAt && terminal) return;
				if (!receipt || !record.messageIds?.includes(receipt)) {
					for (const key of ACCUMULATED_USAGE_KEYS) {
						const value = values[key];
						if (typeof value === "number") record[key] = (record[key] ?? 0) + value;
					}
					record.assistantMessages += 1;
					record.updatedAt = nowIso();
					if (receipt) (record.messageIds ??= []).push(receipt);
				}
				if (terminal) record.completedAt = nowIso();
			});
			if (terminal) trackedRuns.delete(trackedRunKey(cwd, entry.runId, sessionId));
		});
		return entry.pendingWrite;
	}));
}

export async function flushParentUsageTracking(cwd: string, sessionId = localOwner, detach = false): Promise<void> {
	const entries = [...trackedRuns.entries()].filter(([, e]) => e.cwd === cwd && e.sessionId === sessionId);
	if (detach) for (const [key] of entries) trackedRuns.delete(key);
	await Promise.all(entries.map(([, e]) => e.pendingWrite));
}

export function resetParentUsageTrackingForTests(): void { trackedRuns.clear(); }
