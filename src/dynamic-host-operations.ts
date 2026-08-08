import {
	appendDynamicEvent,
	hashDynamicRequest,
	readDynamicEvents,
} from "./dynamic-events.js";
import {
	deepFreeze,
	type WorkflowHostCapabilities,
	type WorkflowHostOperationContext,
} from "./host-capabilities.js";
import type {
	CompiledDynamicWorkflowTask,
	WorkflowRunRecord,
	WorkflowTaskRunRecord,
} from "./types.js";
import {
	workflowBundleFingerprint,
	workflowBundleSpecPath,
} from "./workflow-source-context-runtime.js";

export async function runDynamicHostOperation(input: {
	cwd: string;
	run: WorkflowRunRecord;
	controllerTask: WorkflowTaskRunRecord;
	dynamic: CompiledDynamicWorkflowTask;
	hostCapabilities?: WorkflowHostCapabilities;
	alias: string;
	callIndex: number;
	request: unknown;
}): Promise<unknown> {
	const declaration = input.dynamic.hostOperations[input.alias];
	if (!declaration)
		throw new Error(`host operation "${input.alias}" is not declared`);
	const adapter = input.hostCapabilities?.[declaration.capability];
	if (!adapter)
		throw new Error(
			`host capability "${declaration.capability}" is unavailable`,
		);
	const request = strictJson(input.request, "host operation request");
	const operationRequest = {
		alias: input.alias,
		capability: declaration.capability,
		input: request,
	};
	const requestHash = hashDynamicRequest(operationRequest);
	const opId = `${input.controllerTask.specId}:host:${input.alias}:${String(input.callIndex).padStart(3, "0")}`;
	const idempotencyKey = hashDynamicRequest({
		runId: input.run.runId,
		controllerSpecId: input.controllerTask.specId,
		opId,
		requestHash,
	});
	const events = (await readDynamicEvents(input.cwd, input.run.runId)).filter(
		(event) =>
			event.controllerSpecId === input.controllerTask.specId &&
			event.opId === opId &&
			(event.type === "host.started" || event.type === "host.completed"),
	);
	const divergent = events.find((event) => event.requestHash !== requestHash);
	if (divergent)
		throw new Error(
			`host operation request changed for ${opId}; previous hash ${divergent.requestHash}, new hash ${requestHash}`,
		);
	const completed = [...events]
		.reverse()
		.find((event) => event.type === "host.completed");
	if (completed)
		return strictJson(
			completed.payload.result,
			"persisted host operation result",
		);

	const bundleSpecPath = await workflowBundleSpecPath(input.cwd, input.run, {
		required: true,
	});
	const bundleHash = hashDynamicRequest(
		await workflowBundleFingerprint(input.cwd, input.run),
	);
	const context = deepFreeze<WorkflowHostOperationContext>({
		cwd: input.cwd,
		runId: input.run.runId,
		parentRunId: input.run.parentRunId ?? null,
		controllerSpecId: input.controllerTask.specId,
		controllerTaskId: input.controllerTask.taskId,
		controllerStageId:
			input.controllerTask.stageId ??
			input.controllerTask.specId.replace(/\.controller$/u, ""),
		workflow: {
			name: input.run.name ?? null,
			specPath: input.run.specPath,
			bundleSpecPath,
			bundleHash,
		},
		operation: {
			alias: input.alias,
			capability: declaration.capability,
			callIndex: input.callIndex,
			opId,
			requestHash,
			idempotencyKey,
		},
	});
	if (!events.some((event) => event.type === "host.started")) {
		await appendDynamicEvent(input.cwd, input.run.runId, {
			controllerSpecId: input.controllerTask.specId,
			type: "host.started",
			opId,
			requestHash,
			payload: {
				alias: input.alias,
				capability: declaration.capability,
				idempotencyKey,
			},
		});
	}
	const result = strictJson(
		await (events.some((event) => event.type === "host.started")
			? adapter.reconcile(request, context)
			: adapter.invoke(request, context)),
		"host operation result",
	);
	await appendDynamicEvent(input.cwd, input.run.runId, {
		controllerSpecId: input.controllerTask.specId,
		type: "host.completed",
		opId,
		requestHash,
		payload: {
			alias: input.alias,
			capability: declaration.capability,
			idempotencyKey,
			result,
		},
	});
	return result;
}

function strictJson(value: unknown, label: string): unknown {
	assertJsonValue(value, label, new Set());
	let text: string;
	try {
		text = JSON.stringify(value);
	} catch (error) {
		throw new Error(
			`${label} must be JSON serializable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (text === undefined) throw new Error(`${label} must be JSON serializable`);
	return JSON.parse(text);
}

function assertJsonValue(value: unknown, label: string, seen: Set<object>): void {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean"
	)
		return;
	if (typeof value === "number" && Number.isFinite(value)) return;
	if (typeof value !== "object")
		throw new Error(`${label} must contain only JSON values`);
	if (seen.has(value)) throw new Error(`${label} must not contain cycles`);
	seen.add(value);
	if (Array.isArray(value)) {
		for (const item of value) assertJsonValue(item, label, seen);
	} else {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new Error(`${label} must contain only JSON objects and arrays`);
		}
		for (const item of Object.values(value as Record<string, unknown>)) {
			assertJsonValue(item, label, seen);
		}
	}
	seen.delete(value);
}
