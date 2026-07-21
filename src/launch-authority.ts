import { createHash } from "node:crypto";

import { assertRecordedLaunchBootstrapProvenance } from "./launch-bootstrap-provenance.js";
import {
	workflowTaskAttemptIdentity,
	workflowTaskSessionId,
} from "./launch-session.js";
import type {
	LaunchBootstrapProvenanceRecord,
	WorkflowLaunchAuthorityGrant,
	WorkflowLaunchAuthorityHistory,
	WorkflowLaunchAuthorityRecord,
	WorkflowRunRecord,
	WorkflowTaskRunRecord,
} from "./types.js";

export const WORKFLOW_LAUNCH_AUTHORITY_SCHEMA =
	"pi-workflow-launch-authority-v1" as const;

const MAX_LAUNCH_AUTHORITY_RECORDS = 1_024;

export class WorkflowLaunchAuthorityRegisteredError extends Error {
	constructor() {
		super("workflow launch authority is already registered");
		this.name = "WorkflowLaunchAuthorityRegisteredError";
	}
}

export class WorkflowLaunchAuthorityConsumedError extends Error {
	constructor() {
		super("workflow launch authority is already consumed");
		this.name = "WorkflowLaunchAuthorityConsumedError";
	}
}

export function createWorkflowLaunchAuthority(
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	backendId: string,
	provenance: LaunchBootstrapProvenanceRecord,
): WorkflowLaunchAuthorityGrant {
	assertCurrentProvenanceOwner(run, task, backendId, provenance);
	const grant: Omit<WorkflowLaunchAuthorityGrant, "identitySha256"> = {
		schema: WORKFLOW_LAUNCH_AUTHORITY_SCHEMA,
		issuer: "pi-workflow-engine",
		operation: "launch-task",
		runId: run.runId,
		task: {
			taskId: task.taskId,
			specId: task.specId,
			...(task.generation === undefined
				? {}
				: { generation: task.generation }),
		},
		attemptKey: provenance.attempt.key,
		backendId,
		launchBootstrapSha256: provenance.identitySha256,
	};
	return { ...grant, identitySha256: sha256Canonical(grant) };
}

export function issueWorkflowLaunchAuthority(
	task: WorkflowTaskRunRecord,
	grant: WorkflowLaunchAuthorityGrant,
): void {
	assertGrantProvenance(task, grant);
	const history: WorkflowLaunchAuthorityHistory = task.launchAuthority ?? {
		version: 1,
		records: [],
	};
	assertAuthorityHistory(task, history, grant);
	const existing = history.records.find(
		(record) => record.grant.attemptKey === grant.attemptKey,
	);
	if (existing) {
		if (canonicalJson(existing.grant) !== canonicalJson(grant))
			throw new Error(
				"workflow launch authority mismatch for existing attempt",
			);
	} else {
		if (history.records.length >= MAX_LAUNCH_AUTHORITY_RECORDS)
			throw new Error("workflow launch authority history limit exceeded");
		history.records.push({ grant, state: { phase: "issued" } });
	}
	task.launchAuthority = history;
}

export function assertCurrentWorkflowLaunchAuthority(
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	grant: WorkflowLaunchAuthorityGrant,
	backendId: string,
): void {
	assertCurrentGrantOwner(run, task, grant, backendId);
	const { record } = authorityRecord(task, grant);
	if (record.state.phase === "consumed")
		throw new WorkflowLaunchAuthorityConsumedError();
}

export function registerWorkflowLaunchAuthority(
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	grant: WorkflowLaunchAuthorityGrant,
	backendId: string,
): void {
	assertCurrentWorkflowLaunchAuthority(run, task, grant, backendId);
	const { history, record } = authorityRecord(task, grant);
	if (record.state.phase === "registered")
		throw new WorkflowLaunchAuthorityRegisteredError();
	record.state = { phase: "registered" };
	task.launchAuthority = history;
}

export function consumeWorkflowLaunchAuthority(
	task: WorkflowTaskRunRecord,
	grant: WorkflowLaunchAuthorityGrant,
	backendRunId: string,
	backendAttemptId: string,
): void {
	if (!nonEmptyString(backendRunId) || !nonEmptyString(backendAttemptId))
		throw new Error("workflow launch authority backend identity is invalid");
	const { history, record } = authorityRecord(task, grant);
	if (record.state.phase === "issued")
		throw new Error("workflow launch authority is not registered");
	if (record.state.phase === "consumed") {
		if (
			record.state.backendRunId !== backendRunId ||
			record.state.backendAttemptId !== backendAttemptId
		)
			throw new Error("workflow launch authority backend identity mismatch");
		return;
	}
	record.state = {
		phase: "consumed",
		backendRunId,
		backendAttemptId,
	};
	task.launchAuthority = history;
}

export function consumeRegisteredWorkflowLaunchAuthority(
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	backendId: string,
	backendRunId: string,
	backendAttemptId: string,
): boolean {
	const history = task.launchAuthority;
	if (history === undefined) return false;
	if (!isAuthorityHistoryContainer(history))
		throw new Error("workflow launch authority history is malformed");
	const attemptKey = workflowTaskAttemptIdentity(
		task,
		workflowTaskSessionId(run, task),
	);
	let current: WorkflowLaunchAuthorityRecord | undefined;
	for (const candidate of history.records) {
		if (!isAuthorityRecord(candidate))
			throw new Error("workflow launch authority history is malformed");
		if (candidate.grant.attemptKey === attemptKey) current = candidate;
	}
	if (!current) return false;
	assertCurrentGrantOwner(run, task, current.grant, backendId);
	assertAuthorityHistory(task, history, current.grant);
	if (current.state.phase === "issued") return false;
	const previous = current.state.phase;
	consumeWorkflowLaunchAuthority(
		task,
		current.grant,
		backendRunId,
		backendAttemptId,
	);
	return previous === "registered";
}

export function hasNonSpawnableWorkflowLaunchAuthority(
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	backendId: string,
): boolean {
	const history = task.launchAuthority;
	if (history === undefined) return false;
	if (!isAuthorityHistoryContainer(history))
		throw new Error("workflow launch authority history is malformed");
	const attemptKey = workflowTaskAttemptIdentity(
		task,
		workflowTaskSessionId(run, task),
	);
	let current: WorkflowLaunchAuthorityRecord | undefined;
	for (const record of history.records) {
		if (!isAuthorityRecord(record))
			throw new Error("workflow launch authority history is malformed");
		if (record.grant.attemptKey === attemptKey) current = record;
	}
	if (!current) return false;
	assertCurrentGrantOwner(run, task, current.grant, backendId);
	assertAuthorityHistory(task, history, current.grant);
	return (
		current.state.phase === "registered" || current.state.phase === "consumed"
	);
}

export function canonicalWorkflowLaunchAuthorityBytes(
	value: unknown,
): Buffer {
	return Buffer.from(canonicalJson(value), "utf8");
}

function authorityRecord(
	task: WorkflowTaskRunRecord,
	grant: WorkflowLaunchAuthorityGrant,
): {
	history: WorkflowLaunchAuthorityHistory;
	record: WorkflowLaunchAuthorityRecord;
} {
	const history = task.launchAuthority;
	if (!isAuthorityHistoryContainer(history))
		throw new Error("workflow launch authority is unavailable");
	assertAuthorityHistory(task, history, grant);
	const record = history.records.find(
		(candidate) => candidate.grant.attemptKey === grant.attemptKey,
	);
	if (!record || canonicalJson(record.grant) !== canonicalJson(grant))
		throw new Error("workflow launch authority grant is unavailable");
	return { history, record };
}

function assertAuthorityHistory(
	task: WorkflowTaskRunRecord,
	history: WorkflowLaunchAuthorityHistory,
	owner: WorkflowLaunchAuthorityGrant,
): void {
	if (!isAuthorityHistoryContainer(history))
		throw new Error("workflow launch authority history is malformed");
	const attempts = new Set<string>();
	for (const record of history.records) {
		if (
			!isAuthorityRecord(record) ||
			!hasSameAuthorityOwner(record.grant, owner) ||
			attempts.has(record.grant.attemptKey)
		)
			throw new Error("workflow launch authority history is malformed");
		attempts.add(record.grant.attemptKey);
		assertGrantProvenance(task, record.grant);
	}
}

function assertGrantProvenance(
	task: WorkflowTaskRunRecord,
	grant: WorkflowLaunchAuthorityGrant,
): LaunchBootstrapProvenanceRecord {
	if (!isWorkflowLaunchAuthorityGrant(grant))
		throw new Error("workflow launch authority grant is malformed");
	const provenance = assertRecordedLaunchBootstrapProvenance(
		task,
		grant.launchBootstrapSha256,
	);
	if (
		provenance.runId !== grant.runId ||
		provenance.task.taskId !== grant.task.taskId ||
		provenance.task.specId !== grant.task.specId ||
		provenance.task.generation !== grant.task.generation ||
		provenance.attempt.key !== grant.attemptKey ||
		provenance.backend.id !== grant.backendId
	)
		throw new Error("workflow launch authority provenance mismatch");
	return provenance;
}

function assertCurrentProvenanceOwner(
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	backendId: string,
	provenance: LaunchBootstrapProvenanceRecord,
): void {
	const recorded = assertRecordedLaunchBootstrapProvenance(
		task,
		provenance.identitySha256,
	);
	if (
		canonicalJson(recorded) !== canonicalJson(provenance) ||
		provenance.runId !== run.runId ||
		provenance.task.taskId !== task.taskId ||
		provenance.task.specId !== task.specId ||
		provenance.task.generation !== task.generation ||
		provenance.attempt.key !==
			workflowTaskAttemptIdentity(task, workflowTaskSessionId(run, task)) ||
		provenance.backend.id !== backendId ||
		provenance.backend.type !== run.backend.type ||
		provenance.backend.mode !== run.backend.mode
	)
		throw new Error("workflow launch authority provenance owner mismatch");
}

function assertCurrentGrantOwner(
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	grant: WorkflowLaunchAuthorityGrant,
	backendId: string,
): void {
	const provenance = assertGrantProvenance(task, grant);
	if (
		grant.runId !== run.runId ||
		grant.task.taskId !== task.taskId ||
		grant.task.specId !== task.specId ||
		grant.task.generation !== task.generation ||
		grant.attemptKey !==
			workflowTaskAttemptIdentity(task, workflowTaskSessionId(run, task)) ||
		grant.backendId !== backendId ||
		provenance.backend.id !== backendId ||
		provenance.backend.type !== run.backend.type ||
		provenance.backend.mode !== run.backend.mode
	)
		throw new Error("workflow launch authority owner mismatch");
}

function hasSameAuthorityOwner(
	candidate: WorkflowLaunchAuthorityGrant,
	current: WorkflowLaunchAuthorityGrant,
): boolean {
	return (
		candidate.runId === current.runId &&
		candidate.task.taskId === current.task.taskId &&
		candidate.task.specId === current.task.specId &&
		candidate.task.generation === current.task.generation &&
		candidate.backendId === current.backendId
	);
}

function isAuthorityHistoryContainer(
	value: unknown,
): value is WorkflowLaunchAuthorityHistory {
	return (
		isRecord(value) &&
		hasExactKeys(value, ["version", "records"]) &&
		value.version === 1 &&
		Array.isArray(value.records) &&
		value.records.length <= MAX_LAUNCH_AUTHORITY_RECORDS
	);
}

function isAuthorityRecord(value: unknown): value is WorkflowLaunchAuthorityRecord {
	if (!isRecord(value) || !hasExactKeys(value, ["grant", "state"]))
		return false;
	return isWorkflowLaunchAuthorityGrant(value.grant) && isAuthorityState(value.state);
}

function isWorkflowLaunchAuthorityGrant(
	value: unknown,
): value is WorkflowLaunchAuthorityGrant {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"schema",
			"identitySha256",
			"issuer",
			"operation",
			"runId",
			"task",
			"attemptKey",
			"backendId",
			"launchBootstrapSha256",
		]) ||
		value.schema !== WORKFLOW_LAUNCH_AUTHORITY_SCHEMA ||
		value.issuer !== "pi-workflow-engine" ||
		value.operation !== "launch-task" ||
		!nonEmptyString(value.runId) ||
		!nonEmptyString(value.attemptKey) ||
		!nonEmptyString(value.backendId) ||
		!isSha256(value.launchBootstrapSha256) ||
		!isSha256(value.identitySha256) ||
		!isAuthorityTask(value.task)
	)
		return false;
	const { identitySha256: _identitySha256, ...body } = value;
	return value.identitySha256 === sha256Canonical(body);
}

function isAuthorityTask(
	value: unknown,
): value is WorkflowLaunchAuthorityGrant["task"] {
	return (
		isRecord(value) &&
		hasAllowedKeys(value, ["taskId", "specId", "generation"]) &&
		hasRequiredKeys(value, ["taskId", "specId"]) &&
		nonEmptyString(value.taskId) &&
		nonEmptyString(value.specId) &&
		(value.generation === undefined || nonNegativeInteger(value.generation))
	);
}

function isAuthorityState(
	value: unknown,
): value is WorkflowLaunchAuthorityRecord["state"] {
	if (!isRecord(value) || !nonEmptyString(value.phase)) return false;
	if (value.phase === "issued" || value.phase === "registered")
		return hasExactKeys(value, ["phase"]);
	return (
		value.phase === "consumed" &&
		hasExactKeys(value, ["phase", "backendRunId", "backendAttemptId"]) &&
		nonEmptyString(value.backendRunId) &&
		nonEmptyString(value.backendAttemptId)
	);
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(normalizeCanonical(value));
}

function normalizeCanonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((entry) => normalizeCanonical(entry));
	if (!isRecord(value)) return value;
	const normalized: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort(compareCanonicalKeys)) {
		const entry = value[key];
		if (entry !== undefined) normalized[key] = normalizeCanonical(entry);
	}
	return normalized;
}

function compareCanonicalKeys(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function sha256Canonical(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	const expected = new Set(keys);
	const actual = Object.keys(value);
	return actual.length === expected.size && actual.every((key) => expected.has(key));
}

function hasAllowedKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	const allowed = new Set(keys);
	return Object.keys(value).every((key) => allowed.has(key));
}

function hasRequiredKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	return keys.every((key) => Object.hasOwn(value, key));
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isSha256(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function nonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
