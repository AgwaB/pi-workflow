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
import { nowIso, readRunRecord, writeJsonAtomic } from "./store.js";
import type { CompiledDynamicWorkflowTask } from "./types.js";

export const DYNAMIC_STATE_SCHEMA = "pi-workflow-dynamic-state-v1";

export type DynamicControllerStatus =
	| "pending"
	| "running"
	| "suspended_waiting_children"
	| "complete"
	| "blocked"
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

export interface DynamicDecisionLoopState {
	stallCount: number;
	replanCount: number;
}

export interface DynamicPendingUiApproval {
	opId: string;
	requestHash: string;
	message?: string;
	options?: unknown[];
	requestedAt: string;
}

export type DynamicBranchStatus =
	| "planned"
	| "generated"
	| "completed"
	| "failed"
	| "dropped";

export interface DynamicBranchState {
	branchId: string;
	actionId: string;
	requestId?: string;
	type: string;
	status: DynamicBranchStatus;
	outputProfile?: string;
	dependsOn?: string[];
	requestHash?: string;
	targetSpecId?: string;
	specId?: string;
}

export interface DynamicControllerState {
	controllerSpecId: string;
	controllerTaskId?: string;
	stageId?: string;
	status: DynamicControllerStatus;
	phase?: string;
	generatedTaskIds: string[];
	branches: DynamicBranchState[];
	nestedWorkflowRunIds: string[];
	waitingNestedWorkflowRunIds: string[];
	blockers: string[];
	omissions: string[];
	counters: DynamicBudgetCounters;
	decisionLoop?: DynamicDecisionLoopState;
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
			if (projectedSeq === latestEventSeq) {
				await applyDynamicTaskLifecycle(cwd, runId, state);
				return state;
			}
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
	await applyDynamicTaskLifecycle(cwd, runId, state);
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
	await applyDynamicTaskLifecycle(cwd, runId, state);
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
		decisionLoop: input.dynamic.decisionLoop,
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
		blockers?: readonly string[];
		omissions?: readonly string[];
		decisionLoop?: Partial<DynamicDecisionLoopState>;
	},
): Promise<DynamicWorkflowState> {
	const existing = await readOrRebuildDynamicState(cwd, runId);
	const controller = existing.controllers[input.controllerSpecId];
	const blockers = cleanStringArray(input.blockers);
	const omissions = cleanStringArray(input.omissions);
	const decisionLoop = cleanDecisionLoopState(input.decisionLoop);
	if (
		controller?.status === input.status &&
		(input.message ? controller.lastError === input.message : true) &&
		sameStringArray(controller.blockers ?? [], blockers) &&
		sameStringArray(controller.omissions ?? [], omissions) &&
		(input.decisionLoop === undefined ||
			sameDecisionLoopState(controller.decisionLoop, decisionLoop))
	) {
		return existing;
	}
	const { state } = await recordDynamicEventAndUpdateState(cwd, runId, {
		controllerSpecId: input.controllerSpecId,
		type: "controller.status",
		opId: `${input.controllerSpecId}:controller:status:${input.status}`,
		requestHash: hashDynamicRequest({
			...input,
			blockers,
			omissions,
			...(decisionLoop ? { decisionLoop } : {}),
		}),
		payload: {
			status: input.status,
			...(input.message ? { message: input.message } : {}),
			...(blockers.length > 0 ? { blockers } : {}),
			...(omissions.length > 0 ? { omissions } : {}),
			...(decisionLoop ? { decisionLoop } : {}),
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
	const controller = ensureControllerState(
		state,
		event.controllerSpecId,
		event,
	);
	controller.lastEventSeq = event.seq;
	controller.updatedAt = event.timestamp;
	state.updatedAt = event.timestamp;

	if (event.type === "controller.initialized") {
		controller.controllerTaskId = optionalString(
			event.payload.controllerTaskId,
		);
		controller.stageId = optionalString(event.payload.stageId);
		controller.status =
			asControllerStatus(event.payload.status) ?? controller.status;
		controller.budget = isRecord(event.payload.budget)
			? (event.payload
					.budget as unknown as CompiledDynamicWorkflowTask["budget"])
			: controller.budget;
		controller.permissions = isRecord(event.payload.permissions)
			? (event.payload
					.permissions as CompiledDynamicWorkflowTask["permissions"])
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
		if (!status)
			throw new Error(`invalid dynamic controller status at seq ${event.seq}`);
		controller.status = status;
		controller.blockers = payloadStringArray(event.payload.blockers);
		controller.omissions = payloadStringArray(event.payload.omissions);
		const decisionLoop = payloadDecisionLoopState(event.payload.decisionLoop);
		if (decisionLoop) controller.decisionLoop = decisionLoop;
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
		if (!phase)
			throw new Error(`invalid dynamic controller phase at seq ${event.seq}`);
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
			controller.waitingNestedWorkflowRunIds =
				controller.waitingNestedWorkflowRunIds.filter(
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

	if (event.type === "fanout.planned") {
		const branches = Array.isArray(event.payload.branches)
			? event.payload.branches
			: [];
		for (const branch of branches) {
			if (!isRecord(branch)) continue;
			const branchId = optionalString(branch.branchId);
			const actionId = optionalString(branch.actionId);
			const type = optionalString(branch.type);
			if (!branchId || !actionId || !type) continue;
			upsertDynamicBranch(controller, {
				branchId,
				actionId,
				requestId: optionalString(branch.requestId),
				type,
				status: "planned",
				outputProfile: optionalString(branch.outputProfile),
				dependsOn: payloadStringArray(branch.dependsOn),
				requestHash: optionalString(branch.requestHash),
				targetSpecId: optionalString(branch.targetSpecId),
			});
		}
		return;
	}

	if (event.type === "task.generated") {
		const taskId = optionalString(event.payload.taskId);
		if (!taskId)
			throw new Error(`invalid generated dynamic task id at seq ${event.seq}`);
		if (!controller.generatedTaskIds.includes(taskId)) {
			controller.generatedTaskIds.push(taskId);
			controller.counters.agents += 1;
			controller.counters.graphMutations += 1;
		}
		const branchId = optionalString(event.payload.branchId);
		const requestHash = optionalString(event.requestHash);
		const request = isRecord(event.payload.request)
			? event.payload.request
			: undefined;
		const requestId = optionalString(request?.id);
		const branch = findDynamicBranch(controller, { branchId, requestHash });
		if (branch) {
			branch.status = advanceDynamicBranchStatus(branch.status, "generated");
			branch.specId = taskId;
			branch.targetSpecId ??= taskId;
			if (requestId) branch.requestId ??= requestId;
			if (requestHash) branch.requestHash = requestHash;
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
		branches: [],
		nestedWorkflowRunIds: [],
		waitingNestedWorkflowRunIds: [],
		blockers: [],
		omissions: [],
		counters: emptyCounters(),
		lastEventSeq: 0,
		updatedAt: event.timestamp,
	};
	return state.controllers[controllerSpecId];
}

async function applyDynamicTaskLifecycle(
	cwd: string,
	runId: string,
	state: DynamicWorkflowState,
): Promise<void> {
	const run = await readRunRecord(cwd, runId).catch(() => undefined);
	if (!run) return;
	for (const controller of Object.values(state.controllers)) {
		for (const branch of controller.branches) {
			if (!branch.specId) continue;
			const task = run.tasks.find(
				(candidate) =>
					candidate.specId === branch.specId ||
					candidate.taskId === branch.specId,
			);
			if (!task) continue;
			branch.specId = task.specId;
			branch.status = advanceDynamicBranchStatus(
				branch.status,
				dynamicBranchStatusFromTaskStatus(task.status),
			);
		}
	}
}

function dynamicBranchStatusFromTaskStatus(
	status: string,
): DynamicBranchStatus {
	if (status === "completed") return "completed";
	if (status === "skipped") return "dropped";
	if (status === "failed" || status === "blocked" || status === "interrupted")
		return "failed";
	return "generated";
}

function upsertDynamicBranch(
	controller: DynamicControllerState,
	next: DynamicBranchState,
): void {
	const existing = findDynamicBranch(controller, {
		branchId: next.branchId,
		requestHash: next.requestHash,
	});
	if (!existing) {
		controller.branches.push({
			...next,
			...(next.dependsOn && next.dependsOn.length > 0
				? { dependsOn: next.dependsOn }
				: { dependsOn: undefined }),
		});
		return;
	}
	existing.status = advanceDynamicBranchStatus(existing.status, next.status);
	existing.actionId = existing.actionId || next.actionId;
	existing.requestId ??= next.requestId;
	existing.type = existing.type || next.type;
	existing.outputProfile ??= next.outputProfile;
	if (next.dependsOn && next.dependsOn.length > 0)
		existing.dependsOn = next.dependsOn;
	existing.requestHash ??= next.requestHash;
	existing.targetSpecId ??= next.targetSpecId;
	existing.specId ??= next.specId;
}

function findDynamicBranch(
	controller: DynamicControllerState,
	input: { branchId?: string; requestHash?: string },
): DynamicBranchState | undefined {
	if (input.branchId !== undefined && input.requestHash !== undefined) {
		return (
			controller.branches.find(
				(branch) =>
					branch.branchId === input.branchId &&
					branch.requestHash === input.requestHash,
			) ??
			controller.branches.find(
				(branch) =>
					branch.branchId === input.branchId &&
					branch.requestHash === undefined,
			)
		);
	}
	return controller.branches.find(
		(branch) =>
			(input.branchId !== undefined && branch.branchId === input.branchId) ||
			(input.requestHash !== undefined &&
				branch.requestHash === input.requestHash),
	);
}

function advanceDynamicBranchStatus(
	current: DynamicBranchStatus,
	next: DynamicBranchStatus,
): DynamicBranchStatus {
	const rank: Record<DynamicBranchStatus, number> = {
		planned: 0,
		generated: 1,
		dropped: 2,
		failed: 3,
		completed: 4,
	};
	return rank[next] > rank[current] ? next : current;
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
	for (const key of Object.keys(counters) as Array<
		keyof DynamicBudgetCounters
	>) {
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

function asControllerStatus(
	value: unknown,
): DynamicControllerStatus | undefined {
	if (
		value === "pending" ||
		value === "running" ||
		value === "suspended_waiting_children" ||
		value === "complete" ||
		value === "blocked" ||
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

function cleanStringArray(value: readonly string[] | undefined): string[] {
	return (value ?? [])
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

function payloadStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value
				.filter((item): item is string => typeof item === "string")
				.map((item) => item.trim())
				.filter((item) => item.length > 0)
		: [];
}

function sameStringArray(
	left: readonly string[],
	right: readonly string[],
): boolean {
	return (
		left.length === right.length &&
		left.every((item, index) => item === right[index])
	);
}

function cleanDecisionLoopState(
	value: Partial<DynamicDecisionLoopState> | undefined,
): DynamicDecisionLoopState | undefined {
	if (!value) return undefined;
	const stallCount = nonNegativeInteger(value.stallCount);
	const replanCount = nonNegativeInteger(value.replanCount);
	if (stallCount === undefined && replanCount === undefined) return undefined;
	return {
		stallCount: stallCount ?? 0,
		replanCount: replanCount ?? 0,
	};
}

function payloadDecisionLoopState(
	value: unknown,
): DynamicDecisionLoopState | undefined {
	if (!isRecord(value)) return undefined;
	const stallCount = nonNegativeInteger(value.stallCount);
	const replanCount = nonNegativeInteger(value.replanCount);
	if (stallCount === undefined || replanCount === undefined) return undefined;
	return { stallCount, replanCount };
}

function sameDecisionLoopState(
	left: DynamicDecisionLoopState | undefined,
	right: DynamicDecisionLoopState | undefined,
): boolean {
	return (
		(left?.stallCount ?? 0) === (right?.stallCount ?? 0) &&
		(left?.replanCount ?? 0) === (right?.replanCount ?? 0)
	);
}

function nonNegativeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0
		? value
		: undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
