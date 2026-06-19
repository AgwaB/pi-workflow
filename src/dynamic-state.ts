import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
	appendDynamicEvent,
	dynamicRunDir,
	hashDynamicRequest,
	readDynamicEvents,
	type AppendDynamicWorkflowEventInput,
	type DynamicWorkflowEvent,
} from "./dynamic-events.js";
import { nowIso, writeJsonAtomic } from "./store.js";
import type { CompiledDynamicWorkflowTask } from "./types.js";

export const DYNAMIC_STATE_SCHEMA = "pi-workflow-dynamic-state-v1";

export type DynamicControllerStatus =
	| "pending"
	| "running"
	| "suspended_waiting_children"
	| "complete"
	| "policy_blocked"
	| "budget_blocked"
	| "failed"
	| "awaiting_ui"
	| "awaiting_ui_unavailable";

export interface DynamicBudgetCounters {
	agents: number;
	runningAgents: number;
	graphMutations: number;
	helperRuns: number;
	nestedWorkflowDepth: number;
	runtimeMs: number;
}

export interface DynamicPendingUiApproval {
	opId: string;
	requestHash: string;
	message?: string;
	options?: unknown[];
	requestedAt: string;
}

export interface DynamicControllerState {
	controllerSpecId: string;
	controllerTaskId?: string;
	stageId?: string;
	status: DynamicControllerStatus;
	phase?: string;
	generatedTaskIds: string[];
	nestedWorkflowRunIds: string[];
	waitingNestedWorkflowRunIds: string[];
	counters: DynamicBudgetCounters;
	budget?: CompiledDynamicWorkflowTask["budget"];
	permissions?: CompiledDynamicWorkflowTask["permissions"];
	helperRefs?: string[];
	pendingUiApproval?: DynamicPendingUiApproval;
	lastEventSeq: number;
	lastError?: string;
	updatedAt: string;
}

export interface DynamicWorkflowState {
	schema: typeof DYNAMIC_STATE_SCHEMA;
	runId: string;
	updatedAt: string;
	controllers: Record<string, DynamicControllerState>;
}

export interface DynamicControllerInitInput {
	controllerSpecId: string;
	controllerTaskId?: string;
	stageId?: string;
	dynamic: CompiledDynamicWorkflowTask;
	contentFingerprint?: unknown;
}

export function dynamicStatePath(cwd: string, runId: string): string {
	return join(dynamicRunDir(cwd, runId), "state.json");
}

export async function readDynamicState(
	cwd: string,
	runId: string,
): Promise<DynamicWorkflowState | undefined> {
	let text: string;
	try {
		text = await readFile(dynamicStatePath(cwd, runId), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const parsed = JSON.parse(text) as unknown;
	return assertDynamicState(parsed, runId);
}

export async function readOrRebuildDynamicState(
	cwd: string,
	runId: string,
): Promise<DynamicWorkflowState> {
	try {
		const state = await readDynamicState(cwd, runId);
		if (state) {
			const events = await readDynamicEvents(cwd, runId);
			const latestEventSeq = events.reduce(
				(max, event) => Math.max(max, event.seq),
				0,
			);
			const projectedSeq = Object.values(state.controllers).reduce(
				(max, controller) => Math.max(max, controller.lastEventSeq),
				0,
			);
			if (projectedSeq === latestEventSeq) return state;
		}
	} catch {
		// Corrupt or stale state is a projection cache; rebuild from the append-only log.
	}
	return rebuildDynamicState(cwd, runId);
}

export async function rebuildDynamicState(
	cwd: string,
	runId: string,
): Promise<DynamicWorkflowState> {
	const events = await readDynamicEvents(cwd, runId);
	const state = projectDynamicState(runId, events);
	await writeDynamicState(cwd, runId, state);
	return state;
}

export async function writeDynamicState(
	cwd: string,
	runId: string,
	state: DynamicWorkflowState,
): Promise<void> {
	await writeJsonAtomic(dynamicStatePath(cwd, runId), state);
}

export function projectDynamicState(
	runId: string,
	events: DynamicWorkflowEvent[],
): DynamicWorkflowState {
	const state = emptyDynamicState(runId);
	let expectedSeq = 1;
	for (const event of events) {
		if (event.runId !== runId) {
			throw new Error(
				`dynamic event runId mismatch at seq ${event.seq}: expected ${runId}, got ${event.runId}`,
			);
		}
		if (event.seq !== expectedSeq) {
			throw new Error(
				`dynamic event seq must be monotonic: expected ${expectedSeq}, got ${event.seq}`,
			);
		}
		expectedSeq += 1;
		applyDynamicEvent(state, event);
	}
	return state;
}

export async function recordDynamicEventAndUpdateState(
	cwd: string,
	runId: string,
	input: AppendDynamicWorkflowEventInput,
): Promise<{ event: DynamicWorkflowEvent; state: DynamicWorkflowState }> {
	const event = await appendDynamicEvent(cwd, runId, input);
	const state = projectDynamicState(runId, await readDynamicEvents(cwd, runId));
	await writeDynamicState(cwd, runId, state);
	return { event, state };
}

export async function ensureDynamicControllerInitialized(
	cwd: string,
	runId: string,
	input: DynamicControllerInitInput,
): Promise<DynamicWorkflowState> {
	const helperRefs = [
		input.dynamic.uses,
		...Object.values(input.dynamic.helpers).map((helper) => helper.uses),
	];
	const workflowRefs = Object.values(input.dynamic.workflows).map(
		(workflow) => workflow.uses,
	);
	const request = {
		controllerSpecId: input.controllerSpecId,
		controllerTaskId: input.controllerTaskId,
		stageId: input.stageId,
		uses: input.dynamic.uses,
		mode: input.dynamic.mode,
		budget: input.dynamic.budget,
		permissions: input.dynamic.permissions,
		helperRefs,
		workflowRefs,
		contentFingerprint: input.contentFingerprint,
	};
	const requestHash = hashDynamicRequest(request);
	const events = await readDynamicEvents(cwd, runId);
	const previous = events.find(
		(event) =>
			event.controllerSpecId === input.controllerSpecId &&
			event.type === "controller.initialized" &&
			event.opId === `${input.controllerSpecId}:controller:init`,
	);
	if (previous && previous.requestHash !== requestHash) {
		throw new Error(
			`dynamic controller initialization changed for ${input.controllerSpecId}; previous hash ${previous.requestHash}, new hash ${requestHash}`,
		);
	}
	const existing = projectDynamicState(runId, events);
	if (existing.controllers[input.controllerSpecId]) return existing;
	const { state } = await recordDynamicEventAndUpdateState(cwd, runId, {
		controllerSpecId: input.controllerSpecId,
		type: "controller.initialized",
		opId: `${input.controllerSpecId}:controller:init`,
		requestHash,
		payload: {
			...request,
			status: "pending",
		},
	});
	return state;
}

export async function recordDynamicControllerStatus(
	cwd: string,
	runId: string,
	input: {
		controllerSpecId: string;
		status: DynamicControllerStatus;
		message?: string;
	},
): Promise<DynamicWorkflowState> {
	const existing = await readOrRebuildDynamicState(cwd, runId);
	const controller = existing.controllers[input.controllerSpecId];
	if (
		controller?.status === input.status &&
		(input.message ? controller.lastError === input.message : true)
	) {
		return existing;
	}
	const { state } = await recordDynamicEventAndUpdateState(cwd, runId, {
		controllerSpecId: input.controllerSpecId,
		type: "controller.status",
		opId: `${input.controllerSpecId}:controller:status:${input.status}`,
		requestHash: hashDynamicRequest(input),
		payload: {
			status: input.status,
			...(input.message ? { message: input.message } : {}),
		},
	});
	return state;
}

export async function recordDynamicControllerPhase(
	cwd: string,
	runId: string,
	input: { controllerSpecId: string; phase: string },
): Promise<DynamicWorkflowState> {
	const existing = await readOrRebuildDynamicState(cwd, runId);
	if (existing.controllers[input.controllerSpecId]?.phase === input.phase) {
		return existing;
	}
	const { state } = await recordDynamicEventAndUpdateState(cwd, runId, {
		controllerSpecId: input.controllerSpecId,
		type: "controller.phase",
		opId: `${input.controllerSpecId}:controller:phase:${input.phase}`,
		requestHash: hashDynamicRequest(input),
		payload: { phase: input.phase },
	});
	return state;
}

function emptyDynamicState(runId: string): DynamicWorkflowState {
	return {
		schema: DYNAMIC_STATE_SCHEMA,
		runId,
		updatedAt: nowIso(),
		controllers: {},
	};
}

function applyDynamicEvent(
	state: DynamicWorkflowState,
	event: DynamicWorkflowEvent,
): void {
	const controller = ensureControllerState(state, event.controllerSpecId, event);
	controller.lastEventSeq = event.seq;
	controller.updatedAt = event.timestamp;
	state.updatedAt = event.timestamp;

	if (event.type === "controller.initialized") {
		controller.controllerTaskId = optionalString(event.payload.controllerTaskId);
		controller.stageId = optionalString(event.payload.stageId);
		controller.status = asControllerStatus(event.payload.status) ?? controller.status;
		controller.budget = isRecord(event.payload.budget)
			? (event.payload.budget as unknown as CompiledDynamicWorkflowTask["budget"])
			: controller.budget;
		controller.permissions = isRecord(event.payload.permissions)
			? (event.payload.permissions as CompiledDynamicWorkflowTask["permissions"])
			: controller.permissions;
		controller.helperRefs = Array.isArray(event.payload.helperRefs)
			? event.payload.helperRefs.filter(
					(item): item is string => typeof item === "string",
				)
			: controller.helperRefs;
		return;
	}

	if (event.type === "controller.status") {
		const status = asControllerStatus(event.payload.status);
		if (!status) throw new Error(`invalid dynamic controller status at seq ${event.seq}`);
		controller.status = status;
		const message = optionalString(event.payload.message);
		if (message) controller.lastError = message;
		else if (
			status === "running" ||
			status === "pending" ||
			status === "complete" ||
			status === "awaiting_ui"
		) {
			controller.lastError = undefined;
		}
		if (status !== "awaiting_ui" && status !== "awaiting_ui_unavailable") {
			controller.pendingUiApproval = undefined;
		}
		return;
	}

	if (event.type === "controller.phase") {
		const phase = optionalString(event.payload.phase);
		if (!phase) throw new Error(`invalid dynamic controller phase at seq ${event.seq}`);
		controller.phase = phase;
		return;
	}

	if (event.type === "helper.started") {
		controller.counters.helperRuns += 1;
		return;
	}

	if (event.type === "helper.completed") {
		return;
	}

	if (event.type === "workflow.completed") {
		const runId = optionalString(event.payload.runId);
		if (runId) {
			controller.waitingNestedWorkflowRunIds = controller.waitingNestedWorkflowRunIds.filter(
				(candidate) => candidate !== runId,
			);
		}
		return;
	}
	if (event.type === "workflow.started") {
		const runId = optionalString(event.payload.runId);
		if (runId && !controller.nestedWorkflowRunIds.includes(runId)) {
			controller.nestedWorkflowRunIds.push(runId);
			controller.counters.nestedWorkflowDepth += 1;
		}
		if (
			runId &&
			event.payload.wait !== false &&
			!controller.waitingNestedWorkflowRunIds.includes(runId)
		) {
			controller.waitingNestedWorkflowRunIds.push(runId);
		}
		return;
	}

	if (event.type === "task.generated") {
		const taskId = optionalString(event.payload.taskId);
		if (!taskId) throw new Error(`invalid generated dynamic task id at seq ${event.seq}`);
		if (!controller.generatedTaskIds.includes(taskId)) {
			controller.generatedTaskIds.push(taskId);
			controller.counters.agents += 1;
			controller.counters.graphMutations += 1;
		}
		return;
	}

	if (event.type === "budget.used") {
		mergeCounters(controller.counters, event.payload.counters);
		return;
	}

	if (event.type === "approval.pending") {
		controller.status = "awaiting_ui";
		controller.pendingUiApproval = {
			opId: event.opId,
			requestHash: event.requestHash,
			message: optionalString(event.payload.message),
			options: Array.isArray(event.payload.options)
				? event.payload.options
				: undefined,
			requestedAt: event.timestamp,
		};
		return;
	}

	if (event.type === "approval.resolved") {
		controller.pendingUiApproval = undefined;
		if (event.payload.approved === false) {
			controller.status = "policy_blocked";
			controller.lastError = "dynamic controller approval was rejected";
		}
		return;
	}
}

function ensureControllerState(
	state: DynamicWorkflowState,
	controllerSpecId: string,
	event: DynamicWorkflowEvent,
): DynamicControllerState {
	state.controllers[controllerSpecId] ??= {
		controllerSpecId,
		status: "pending",
		generatedTaskIds: [],
		nestedWorkflowRunIds: [],
		waitingNestedWorkflowRunIds: [],
		counters: emptyCounters(),
		lastEventSeq: 0,
		updatedAt: event.timestamp,
	};
	return state.controllers[controllerSpecId];
}

function emptyCounters(): DynamicBudgetCounters {
	return {
		agents: 0,
		runningAgents: 0,
		graphMutations: 0,
		helperRuns: 0,
		nestedWorkflowDepth: 0,
		runtimeMs: 0,
	};
}

function mergeCounters(counters: DynamicBudgetCounters, value: unknown): void {
	if (!isRecord(value)) return;
	for (const key of Object.keys(counters) as Array<keyof DynamicBudgetCounters>) {
		const amount = value[key];
		if (typeof amount === "number" && Number.isFinite(amount)) {
			counters[key] += amount;
		}
	}
}

function assertDynamicState(
	value: unknown,
	runId: string,
): DynamicWorkflowState {
	if (!isRecord(value)) throw new Error("dynamic state must be an object");
	if (value.schema !== DYNAMIC_STATE_SCHEMA)
		throw new Error("unsupported dynamic state schema");
	if (value.runId !== runId) throw new Error("dynamic state runId mismatch");
	if (!isRecord(value.controllers))
		throw new Error("dynamic state controllers must be an object");
	return value as unknown as DynamicWorkflowState;
}

function asControllerStatus(value: unknown): DynamicControllerStatus | undefined {
	if (
		value === "pending" ||
		value === "running" ||
		value === "suspended_waiting_children" ||
		value === "complete" ||
		value === "policy_blocked" ||
		value === "budget_blocked" ||
		value === "failed" ||
		value === "awaiting_ui" ||
		value === "awaiting_ui_unavailable"
	)
		return value;
	return undefined;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
