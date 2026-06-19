import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

import { ensureDir, nowIso, workflowRunDir } from "./store.js";

export const DYNAMIC_EVENT_SCHEMA = "pi-workflow-dynamic-event-v1";

export type DynamicWorkflowEventType =
	| "controller.initialized"
	| "controller.status"
	| "controller.phase"
	| "helper.started"
	| "helper.completed"
	| "workflow.started"
	| "workflow.completed"
	| "task.generated"
	| "budget.used"
	| "approval.pending"
	| "approval.resolved";

export interface DynamicWorkflowEvent {
	schema: typeof DYNAMIC_EVENT_SCHEMA;
	seq: number;
	opId: string;
	requestHash: string;
	runId: string;
	controllerSpecId: string;
	type: DynamicWorkflowEventType;
	timestamp: string;
	payload: Record<string, unknown>;
}

export interface AppendDynamicWorkflowEventInput {
	controllerSpecId: string;
	type: DynamicWorkflowEventType;
	opId?: string;
	requestHash?: string;
	timestamp?: string;
	payload?: Record<string, unknown>;
}

export function dynamicRunDir(cwd: string, runId: string): string {
	return join(workflowRunDir(cwd, runId), "dynamic");
}

export function dynamicEventsPath(cwd: string, runId: string): string {
	return join(dynamicRunDir(cwd, runId), "events.jsonl");
}

export async function readDynamicEvents(
	cwd: string,
	runId: string,
): Promise<DynamicWorkflowEvent[]> {
	let text: string;
	try {
		text = await readFile(dynamicEventsPath(cwd, runId), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const events: DynamicWorkflowEvent[] = [];
	const lines = text.split(/\r?\n/);
	for (const [index, line] of lines.entries()) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			throw new Error(
				`invalid dynamic event JSON at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		events.push(assertDynamicEvent(parsed, index + 1));
	}
	return events;
}

export async function appendDynamicEvent(
	cwd: string,
	runId: string,
	input: AppendDynamicWorkflowEventInput,
): Promise<DynamicWorkflowEvent> {
	const previous = await readDynamicEvents(cwd, runId);
	const event: DynamicWorkflowEvent = {
		schema: DYNAMIC_EVENT_SCHEMA,
		seq: previous.reduce((max, item) => Math.max(max, item.seq), 0) + 1,
		opId: input.opId ?? `${input.controllerSpecId}:${input.type}`,
		requestHash:
			input.requestHash ??
			hashDynamicRequest({
				controllerSpecId: input.controllerSpecId,
				type: input.type,
				payload: input.payload ?? {},
			}),
		runId,
		controllerSpecId: input.controllerSpecId,
		type: input.type,
		timestamp: input.timestamp ?? nowIso(),
		payload: normalizePayload(input.payload ?? {}),
	};
	await ensureDir(dynamicRunDir(cwd, runId));
	await appendFile(dynamicEventsPath(cwd, runId), `${JSON.stringify(event)}\n`,
		"utf8",
	);
	return event;
}

export function hashDynamicRequest(value: unknown): string {
	return createHash("sha256")
		.update(stableStringify(toJsonNormalizedValue(value)))
		.digest("hex");
}

function assertDynamicEvent(value: unknown, line: number): DynamicWorkflowEvent {
	if (!isRecord(value)) throw new Error(`dynamic event at line ${line} must be an object`);
	if (value.schema !== DYNAMIC_EVENT_SCHEMA)
		throw new Error(`dynamic event at line ${line} has unsupported schema`);
	if (typeof value.seq !== "number" || !Number.isInteger(value.seq) || value.seq <= 0)
		throw new Error(`dynamic event at line ${line} has invalid seq`);
	if (typeof value.opId !== "string" || value.opId.trim() === "")
		throw new Error(`dynamic event at line ${line} has invalid opId`);
	if (typeof value.requestHash !== "string" || value.requestHash.trim() === "")
		throw new Error(`dynamic event at line ${line} has invalid requestHash`);
	if (typeof value.runId !== "string" || value.runId.trim() === "")
		throw new Error(`dynamic event at line ${line} has invalid runId`);
	if (
		typeof value.controllerSpecId !== "string" ||
		value.controllerSpecId.trim() === ""
	)
		throw new Error(`dynamic event at line ${line} has invalid controllerSpecId`);
	if (!isDynamicWorkflowEventType(value.type))
		throw new Error(`dynamic event at line ${line} has invalid type`);
	if (typeof value.timestamp !== "string" || value.timestamp.trim() === "")
		throw new Error(`dynamic event at line ${line} has invalid timestamp`);
	if (!isRecord(value.payload))
		throw new Error(`dynamic event at line ${line} has invalid payload`);
	return value as unknown as DynamicWorkflowEvent;
}

function isDynamicWorkflowEventType(
	value: unknown,
): value is DynamicWorkflowEventType {
	return (
		value === "controller.initialized" ||
		value === "controller.status" ||
		value === "controller.phase" ||
		value === "helper.started" ||
		value === "helper.completed" ||
		value === "workflow.started" ||
		value === "workflow.completed" ||
		value === "task.generated" ||
		value === "budget.used" ||
		value === "approval.pending" ||
		value === "approval.resolved"
	);
}

function normalizePayload(value: Record<string, unknown>): Record<string, unknown> {
	return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function stableStringify(value: unknown): string {
	return JSON.stringify(toStableJson(value));
}

function toJsonNormalizedValue(value: unknown): unknown {
	const text = JSON.stringify(value);
	return text === undefined ? null : JSON.parse(text);
}

function toStableJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => toStableJson(item));
	if (!isRecord(value)) return value;
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) result[key] = toStableJson(value[key]);
	return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
