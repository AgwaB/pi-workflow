import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { readArtifactGraphControl } from "./artifact-graph-runtime.js";
import {
	DynamicControllerBudgetBlocked,
	DynamicControllerNestedApprovalBlocked,
	DynamicControllerSuspended,
} from "./dynamic-controller-errors.js";
import {
	assertDynamicRuntimeBudgetAvailable,
	type DynamicWorkflowUi,
} from "./dynamic-controller-policy.js";
import { hashDynamicRequest, readDynamicEvents } from "./dynamic-events.js";
import {
	readOrRebuildDynamicState,
	recordDynamicEventAndUpdateState,
} from "./dynamic-state.js";
import { validateJsonSchema, type JsonSchema } from "./json-schema.js";
import { makeRunId, readRunRecord } from "./store.js";
import type {
	CompiledDynamicWorkflowTask,
	WorkflowRunRecord,
	WorkflowTaskRunRecord,
} from "./types.js";

type DynamicNestedWorkflowRunOptions = {
	task?: string;
	dynamicUi?: DynamicWorkflowUi;
	runId?: string;
	parentRunId?: string;
};

type RunWorkflowSpecForDynamicCall = (
	specPath: string,
	cwd: string,
	options: DynamicNestedWorkflowRunOptions,
) => Promise<WorkflowRunRecord>;

type RefreshRunForDynamicCall = (
	cwd: string,
	runIdOrPrefix: string,
) => Promise<WorkflowRunRecord>;

type DynamicHelperWorkerRunner = (input: {
	ref: string;
	specPath: string;
	callInput: unknown;
	timeoutMs: number;
}) => Promise<unknown>;

function requiredDynamicString(
	value: unknown,
	field: string,
	api = "ctx.agent()",
): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${api} ${field} must be a non-empty string`);
	}
	return value.trim();
}

function isPlainDynamicRecord(
	value: unknown,
): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function remainingDynamicRuntimeMs(
	dynamic: CompiledDynamicWorkflowTask,
	consumedRuntimeMs: number,
): number {
	return Math.max(0, dynamic.budget.maxRuntimeMs - consumedRuntimeMs);
}

interface DynamicHelperCallInput {
	sources: Record<string, unknown>;
	options?: Record<string, unknown>;
}

interface DynamicNestedWorkflowInput {
	task: string;
	wait: boolean;
}

export async function runDynamicNestedWorkflowCall(input: {
	runWorkflowSpec: RunWorkflowSpecForDynamicCall;
	refreshRun: RefreshRunForDynamicCall;
	isResumableDynamicApprovalBlockedRun: (run: WorkflowRunRecord) => boolean;
	cwd: string;
	run: WorkflowRunRecord;
	controllerTask: WorkflowTaskRunRecord;
	helperSpecPath: string;
	dynamic: CompiledDynamicWorkflowTask;
	dynamicUi?: DynamicWorkflowUi;
	workflowId: string;
	callIndex: number;
	workflowInput: unknown;
	isSettled?: () => boolean;
}): Promise<unknown> {
	await assertDynamicRuntimeBudgetAvailable({
		cwd: input.cwd,
		runId: input.run.runId,
		controllerSpecId: input.controllerTask.specId,
		dynamic: input.dynamic,
	});
	const workflowId = requiredDynamicString(
		input.workflowId,
		"workflow name",
		"ctx.workflow()",
	);
	const workflowSpec = input.dynamic.workflows[workflowId];
	if (!workflowSpec) {
		throw new Error(
			`dynamic nested workflow is not declared in spec.json: ${workflowId}`,
		);
	}
	const normalizedInput = normalizeDynamicNestedWorkflowInput(
		input.workflowInput,
	);
	const nestedSpecPath = resolveDynamicNestedWorkflowSpecPath(
		input.helperSpecPath,
		workflowSpec.uses,
	);
	const opId = `${input.controllerTask.specId}:workflow:${workflowId}:${String(input.callIndex).padStart(3, "0")}`;
	const request = {
		workflowId,
		uses: workflowSpec.uses,
		specHash: hashDynamicRequest(await readFile(nestedSpecPath, "utf8")),
		input: normalizedInput,
	};
	const requestHash = hashDynamicRequest(request);
	const events = await readDynamicEvents(input.cwd, input.run.runId);
	const previousStarts = events.filter(
		(event) => event.opId === opId && event.type === "workflow.started",
	);
	const divergent = previousStarts.find(
		(event) => event.requestHash !== requestHash,
	);
	if (divergent) {
		throw new Error(
			`dynamic workflow request changed for ${workflowId} call ${input.callIndex}; previous hash ${divergent.requestHash}, new hash ${requestHash}`,
		);
	}
	const previousCompleted = events.find(
		(event) => event.opId === opId && event.type === "workflow.completed",
	);
	const previousNonWaitingSnapshot = [...previousStarts]
		.reverse()
		.map((event) => event.payload.result)
		.find((result) => result !== undefined);
	if (!normalizedInput.wait && previousNonWaitingSnapshot !== undefined) {
		return previousNonWaitingSnapshot;
	}
	if (previousCompleted) return previousCompleted.payload.result;
	let nestedRunId = optionalEventString(
		[...previousStarts]
			.reverse()
			.find((event) => optionalEventString(event.payload.runId))?.payload.runId,
	);
	if (!nestedRunId) {
		await assertDynamicNestedWorkflowBudgetAvailable({
			cwd: input.cwd,
			runId: input.run.runId,
			controllerSpecId: input.controllerTask.specId,
			dynamic: input.dynamic,
		});
		nestedRunId = makeRunId();
		await recordDynamicEventAndUpdateState(input.cwd, input.run.runId, {
			controllerSpecId: input.controllerTask.specId,
			type: "workflow.started",
			opId,
			requestHash,
			payload: {
				workflowId,
				uses: workflowSpec.uses,
				runId: nestedRunId,
				wait: normalizedInput.wait,
				status: "starting",
			},
		});
	}
	let nestedRun = await readRunRecord(input.cwd, nestedRunId).catch(
		() => undefined,
	);
	if (!nestedRun) {
		nestedRun = await input.runWorkflowSpec(nestedSpecPath, input.cwd, {
			task: normalizedInput.task,
			dynamicUi: input.dynamicUi,
			runId: nestedRunId,
			parentRunId: input.run.runId,
		});
		if (input.isSettled?.()) return undefined;
		const result = !normalizedInput.wait
			? await buildNestedWorkflowResult(input.cwd, nestedRun)
			: undefined;
		await recordDynamicEventAndUpdateState(input.cwd, input.run.runId, {
			controllerSpecId: input.controllerTask.specId,
			type: "workflow.started",
			opId,
			requestHash,
			payload: {
				workflowId,
				uses: workflowSpec.uses,
				runId: nestedRunId,
				wait: normalizedInput.wait,
				status: nestedRun.status,
				...(result !== undefined ? { result } : {}),
			},
		});
		if (result !== undefined) return result;
	}
	nestedRun = await input.refreshRun(input.cwd, nestedRunId);
	if (!normalizedInput.wait) {
		const result = await buildNestedWorkflowResult(input.cwd, nestedRun);
		if (input.isSettled?.()) return undefined;
		await recordDynamicEventAndUpdateState(input.cwd, input.run.runId, {
			controllerSpecId: input.controllerTask.specId,
			type: "workflow.started",
			opId,
			requestHash,
			payload: {
				workflowId,
				uses: workflowSpec.uses,
				runId: nestedRunId,
				wait: false,
				status: nestedRun.status,
				result,
			},
		});
		return result;
	}
	if (nestedRun.status === "completed") {
		const result = await buildNestedWorkflowResult(input.cwd, nestedRun);
		if (input.isSettled?.()) return undefined;
		await recordDynamicEventAndUpdateState(input.cwd, input.run.runId, {
			controllerSpecId: input.controllerTask.specId,
			type: "workflow.completed",
			opId,
			requestHash,
			payload: { workflowId, runId: nestedRun.runId, result },
		});
		return result;
	}
	if (input.isResumableDynamicApprovalBlockedRun(nestedRun) && normalizedInput.wait) {
		throw new DynamicControllerNestedApprovalBlocked(
			`dynamic nested workflow ${workflowId} (${nestedRun.runId}) is blocked awaiting approval; run /workflow resume ${nestedRun.runId}, then run /workflow resume ${input.run.runId} after the nested workflow completes to continue the parent workflow`,
			nestedRun.runId,
		);
	}
	if (nestedRun.status === "running" && normalizedInput.wait) {
		throw new DynamicControllerSuspended(
			`waiting for dynamic nested workflow ${workflowId} (${nestedRun.runId})`,
		);
	}
	if (nestedRun.status === "running") {
		return await buildNestedWorkflowResult(input.cwd, nestedRun);
	}
	throw new Error(
		`dynamic nested workflow ${workflowId} ended with ${nestedRun.status}`,
	);
}

async function buildNestedWorkflowResult(
	cwd: string,
	run: WorkflowRunRecord,
): Promise<Record<string, unknown>> {
	const tasks = await Promise.all(
		run.tasks.map(async (task) => {
			const control =
				task.status === "completed" && task.artifactGraph?.enabled
					? await readArtifactGraphControl(cwd, task).catch(() => undefined)
					: undefined;
			return {
				taskId: task.taskId,
				specId: task.specId,
				stageId: task.stageId,
				status: task.status,
				statusDetail: task.statusDetail,
				...(control !== undefined ? { control } : {}),
			};
		}),
	);
	return {
		status: run.status,
		runId: run.runId,
		taskSummary: run.taskSummary,
		tasks,
	};
}

async function assertDynamicNestedWorkflowBudgetAvailable(input: {
	cwd: string;
	runId: string;
	controllerSpecId: string;
	dynamic: CompiledDynamicWorkflowTask;
}): Promise<void> {
	const state = await readOrRebuildDynamicState(input.cwd, input.runId);
	const counters = state.controllers[input.controllerSpecId]?.counters;
	if (
		(counters?.nestedWorkflowDepth ?? 0) >=
		input.dynamic.budget.maxNestedWorkflowDepth
	) {
		throw new DynamicControllerBudgetBlocked(
			`dynamic nested workflow budget exhausted: maxNestedWorkflowDepth=${input.dynamic.budget.maxNestedWorkflowDepth}`,
		);
	}
}

function normalizeDynamicNestedWorkflowInput(
	value: unknown,
): DynamicNestedWorkflowInput {
	if (typeof value === "string") return { task: value, wait: true };
	if (!isPlainDynamicRecord(value)) {
		throw new Error("ctx.workflow() input must be a task string or object");
	}
	return {
		task: requiredDynamicString(value.task, "workflow task", "ctx.workflow()"),
		wait: value.wait === false ? false : true,
	};
}

function resolveDynamicNestedWorkflowSpecPath(
	helperSpecPath: string,
	ref: string,
): string {
	if (
		!ref.startsWith("./") ||
		!ref.endsWith(".json") ||
		isAbsolute(ref) ||
		ref.includes("\\") ||
		ref.includes("://") ||
		/^[A-Za-z][A-Za-z0-9+.-]*:/.test(ref) ||
		ref.split("/").includes("..")
	) {
		throw new Error(
			"dynamic nested workflow must be a bundle-local ./ .json spec",
		);
	}
	const root = dirname(helperSpecPath);
	const resolved = resolve(root, ref);
	const rel = relative(root, resolved);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new Error(
			"dynamic nested workflow must stay inside the workflow bundle",
		);
	}
	return resolved;
}

export function optionalEventString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export async function runDynamicHelperCall(input: {
	runDynamicHelperWorker: DynamicHelperWorkerRunner;
	cwd: string;
	run: WorkflowRunRecord;
	controllerTask: WorkflowTaskRunRecord;
	helperSpecPath: string;
	dynamic: CompiledDynamicWorkflowTask;
	helperId: string;
	callIndex: number;
	helperInput: unknown;
	isSettled?: () => boolean;
}): Promise<unknown> {
	await assertDynamicRuntimeBudgetAvailable({
		cwd: input.cwd,
		runId: input.run.runId,
		controllerSpecId: input.controllerTask.specId,
		dynamic: input.dynamic,
	});
	const helperId = requiredDynamicString(
		input.helperId,
		"helper name",
		"ctx.helper()",
	);
	const helperSpec = input.dynamic.helpers[helperId];
	if (!helperSpec) {
		throw new Error(`dynamic helper is not declared in spec.json: ${helperId}`);
	}
	const normalizedInput = normalizeDynamicHelperCallInput(input.helperInput);
	const opId = `${input.controllerTask.specId}:helper:${helperId}:${String(input.callIndex).padStart(3, "0")}`;
	const request = {
		helperId,
		uses: helperSpec.uses,
		idempotent: helperSpec.idempotent === true,
		inputSchema: await dynamicHelperSchemaFingerprint(
			input.helperSpecPath,
			helperSpec.inputSchema,
		),
		outputSchema: await dynamicHelperSchemaFingerprint(
			input.helperSpecPath,
			helperSpec.outputSchema,
		),
		input: normalizedInput,
	};
	const requestHash = hashDynamicRequest(request);
	const previous = (await readDynamicEvents(input.cwd, input.run.runId)).filter(
		(event) =>
			event.opId === opId &&
			(event.type === "helper.started" || event.type === "helper.completed"),
	);
	const divergent = previous.find((event) => event.requestHash !== requestHash);
	if (divergent) {
		throw new Error(
			`dynamic helper request changed for ${helperId} call ${input.callIndex}; previous hash ${divergent.requestHash}, new hash ${requestHash}`,
		);
	}
	const completed = previous.find((event) => event.type === "helper.completed");
	if (completed) return completed.payload.result;
	const hasDanglingStarted = previous.some(
		(event) => event.type === "helper.started",
	);
	if (hasDanglingStarted && !helperSpec.idempotent) {
		throw new Error(
			`dynamic helper ${helperId} call ${input.callIndex} previously started but did not complete; helper side effects are not replay-safe`,
		);
	}
	if (!hasDanglingStarted) {
		await assertDynamicHelperBudgetAvailable({
			cwd: input.cwd,
			runId: input.run.runId,
			controllerSpecId: input.controllerTask.specId,
			dynamic: input.dynamic,
		});
	}
	await validateDynamicHelperSchema(
		input.helperSpecPath,
		helperSpec.inputSchema,
		normalizedInput,
		`dynamic helper ${helperId} input`,
	);
	if (input.isSettled?.()) return undefined;
	if (!hasDanglingStarted) {
		await recordDynamicEventAndUpdateState(input.cwd, input.run.runId, {
			controllerSpecId: input.controllerTask.specId,
			type: "helper.started",
			opId,
			requestHash,
			payload: {
				helperId,
				uses: helperSpec.uses,
				input: normalizedInput,
			},
		});
	}
	const result = await input.runDynamicHelperWorker({
		ref: helperSpec.uses,
		specPath: input.helperSpecPath,
		callInput: {
			sources: normalizedInput.sources,
			options: normalizedInput.options,
			context: {
				specPath: input.helperSpecPath,
				originalSpecPath: input.run.specPath,
				stageId: input.controllerTask.stageId,
				taskId: input.controllerTask.taskId,
				runId: input.run.runId,
				cwd: input.cwd,
			},
		},
		timeoutMs: remainingDynamicRuntimeMs(
			input.dynamic,
			(await readOrRebuildDynamicState(input.cwd, input.run.runId)).controllers[
				input.controllerTask.specId
			]?.counters.runtimeMs ?? 0,
		),
	});
	if (input.isSettled?.()) return undefined;
	const serializedResult = toDynamicJsonValue(result);
	await validateDynamicHelperSchema(
		input.helperSpecPath,
		helperSpec.outputSchema,
		serializedResult,
		`dynamic helper ${helperId} output`,
	);
	if (input.isSettled?.()) return undefined;
	await recordDynamicEventAndUpdateState(input.cwd, input.run.runId, {
		controllerSpecId: input.controllerTask.specId,
		type: "helper.completed",
		opId,
		requestHash,
		payload: {
			helperId,
			uses: helperSpec.uses,
			result: serializedResult,
		},
	});
	return serializedResult;
}

async function validateDynamicHelperSchema(
	helperSpecPath: string,
	schemaRef: string | undefined,
	value: unknown,
	label: string,
): Promise<void> {
	if (!schemaRef) return;
	const schemaPath = resolveDynamicHelperSchemaPath(helperSpecPath, schemaRef);
	const schema = JSON.parse(await readFile(schemaPath, "utf8")) as JsonSchema;
	const result = validateJsonSchema(value, schema);
	if (!result.valid) {
		throw new Error(
			`${label} does not match schema ${schemaRef}: ${result.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`,
		);
	}
}

async function dynamicHelperSchemaFingerprint(
	helperSpecPath: string,
	schemaRef: string | undefined,
): Promise<{ ref: string; hash: string } | undefined> {
	if (!schemaRef) return undefined;
	const schemaPath = resolveDynamicHelperSchemaPath(helperSpecPath, schemaRef);
	const schema = JSON.parse(await readFile(schemaPath, "utf8"));
	return { ref: schemaRef, hash: hashDynamicRequest(schema) };
}

function resolveDynamicHelperSchemaPath(
	helperSpecPath: string,
	ref: string,
): string {
	if (ref.includes("#")) {
		throw new Error(
			"dynamic helper schema JSON Pointer fragments are not supported",
		);
	}
	const pathPart = ref;
	if (
		!pathPart.startsWith("./") ||
		!pathPart.endsWith(".json") ||
		isAbsolute(pathPart) ||
		pathPart.includes("\\") ||
		pathPart.includes("://") ||
		/^[A-Za-z][A-Za-z0-9+.-]*:/.test(pathPart) ||
		pathPart.split("/").includes("..")
	) {
		throw new Error(
			"dynamic helper schema must be a bundle-local ./ .json file",
		);
	}
	const root = dirname(helperSpecPath);
	const resolved = resolve(root, pathPart.slice(2));
	const rel = relative(root, resolved);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new Error(
			"dynamic helper schema must stay inside the workflow bundle",
		);
	}
	return resolved;
}

async function assertDynamicHelperBudgetAvailable(input: {
	cwd: string;
	runId: string;
	controllerSpecId: string;
	dynamic: CompiledDynamicWorkflowTask;
}): Promise<void> {
	const state = await readOrRebuildDynamicState(input.cwd, input.runId);
	const counters = state.controllers[input.controllerSpecId]?.counters;
	if ((counters?.helperRuns ?? 0) >= input.dynamic.budget.maxHelperRuns) {
		throw new DynamicControllerBudgetBlocked(
			`dynamic helper budget exhausted: maxHelperRuns=${input.dynamic.budget.maxHelperRuns}`,
		);
	}
}

function normalizeDynamicHelperCallInput(
	value: unknown,
): DynamicHelperCallInput {
	if (value === undefined) return { sources: {} };
	if (!isPlainDynamicRecord(value)) {
		return { sources: {}, options: { value } };
	}
	if ("sources" in value || "options" in value) {
		return {
			sources: isPlainDynamicRecord(value.sources) ? value.sources : {},
			...(isPlainDynamicRecord(value.options)
				? { options: value.options }
				: {}),
		};
	}
	return { sources: {}, options: value };
}

function toDynamicJsonValue(value: unknown): unknown {
	const text = JSON.stringify(value);
	if (text === undefined) return null;
	return JSON.parse(text) as unknown;
}
