import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
	artifactRefsForTask,
	controlDigest,
	projectArtifactGraphControl,
	readArtifactGraphControl,
} from "./artifact-graph-runtime.js";
import { DynamicControllerSuspended } from "./dynamic-controller-errors.js";
import {
	validateDynamicDecision,
	writeDynamicDecisionArtifacts,
} from "./dynamic-decision.js";
import { hashDynamicRequest, readDynamicEvents } from "./dynamic-events.js";
import {
	normalizeDynamicAgentRequest,
	type DynamicAgentRequest,
} from "./dynamic-generated-task-runtime.js";
import {
	isDynamicOutputProfile,
	type DynamicOutputProfile,
} from "./dynamic-profiles.js";
import { recordDynamicEventAndUpdateState } from "./dynamic-state.js";
import {
	assembleDynamicStateIndex,
	extractDynamicStateArtifact,
	writeDynamicStateIndexArtifacts,
} from "./dynamic-state-index.js";
import {
	fromProjectPath,
	isTerminalTaskStatus,
	readJson,
	toProjectPath,
} from "./store.js";
import type {
	CompiledTask,
	WorkflowRunRecord,
	WorkflowTaskRunRecord,
} from "./types.js";
import type { WorkflowSourceManifestSource } from "./workflow-artifact-tool.js";
import { readSimpleJsonPath } from "./workflow-runtime.js";

export async function runDynamicDecisionPersistCall(input: {
	cwd: string;
	run: WorkflowRunRecord;
	controllerTask: WorkflowTaskRunRecord;
	opId: string;
	callIndex: number;
	rawDecision: unknown;
	context: unknown;
}): Promise<Record<string, unknown>> {
	const context = isPlainDynamicRecord(input.context) ? input.context : {};
	const validation = validateDynamicDecision(input.rawDecision, context);
	const stateIndexDigest = optionalDynamicStringField(context.stateIndexDigest);
	const requestHash = hashDynamicRequest({
		rawDecision: input.rawDecision,
		context,
		validationHash: validation.hash,
		stateIndexDigest,
	});
	const alreadyRecorded = await assertDynamicControlOpRequestStable({
		cwd: input.cwd,
		runId: input.run.runId,
		opId: input.opId,
		type: "decision.persisted",
		requestHash,
		errorPrefix: "dynamic decision persist request changed",
	});
	const written = await writeDynamicDecisionArtifacts({
		cwd: input.cwd,
		runId: input.run.runId,
		controllerSpecId: input.controllerTask.specId,
		rawDecision: input.rawDecision,
		validation,
		stateIndexDigest,
	});
	if (!alreadyRecorded)
		await recordDynamicEventAndUpdateState(input.cwd, input.run.runId, {
			controllerSpecId: input.controllerTask.specId,
			type: "decision.persisted",
			opId: input.opId,
			requestHash,
			payload: {
				callIndex: input.callIndex,
				ok: validation.ok,
				errors: validation.errors,
				decisionHash: validation.hash,
				stateIndexDigest,
				paths: {
					raw: toProjectPath(input.cwd, written.rawPath),
					validation: toProjectPath(input.cwd, written.validationPath),
					...(written.acceptedPath
						? { accepted: toProjectPath(input.cwd, written.acceptedPath) }
						: {}),
				},
			},
		});
	return {
		ok: validation.ok,
		errors: validation.errors,
		decision: validation.decision,
		decisionHash: validation.hash,
		stateIndexDigest,
		artifacts: {
			raw: toProjectPath(input.cwd, written.rawPath),
			validation: toProjectPath(input.cwd, written.validationPath),
			...(written.acceptedPath
				? { accepted: toProjectPath(input.cwd, written.acceptedPath) }
				: {}),
		},
	};
}

export async function runDynamicFanoutPlanPersistCall(input: {
	cwd: string;
	run: WorkflowRunRecord;
	controllerTask: WorkflowTaskRunRecord;
	opId: string;
	callIndex: number;
	request: NormalizedDynamicFanoutPlanRequest;
}): Promise<Record<string, unknown>> {
	const controllerStageId =
		input.controllerTask.stageId ??
		input.controllerTask.specId.replace(/\.controller$/, "");
	const branches = input.request.branches.map((branch) => ({
		branchId: branch.branchId,
		actionId: branch.actionId,
		requestId: branch.requestId,
		type: branch.type,
		outputProfile: branch.outputProfile,
		...(branch.dependsOn && branch.dependsOn.length > 0
			? { dependsOn: branch.dependsOn }
			: {}),
		requestHash: hashDynamicRequest(branch.agentRequest),
		status: "planned" as const,
		targetSpecId: `${controllerStageId}.${branch.requestId}`,
	}));
	// requestId/targetSpecId are derived audit fields; keep the fanout
	// stability hash tied to the pre-existing branch request identity.
	const requestHashBranches = branches.map(
		({ requestId: _requestId, targetSpecId: _targetSpecId, ...branch }) =>
			branch,
	);
	const payload = {
		callIndex: input.callIndex,
		round: input.request.round,
		decisionHash: input.request.decisionHash,
		branches,
	};
	const requestHash = hashDynamicRequest({
		round: input.request.round,
		decisionHash: input.request.decisionHash,
		branches: requestHashBranches,
	});
	const alreadyRecorded = await assertDynamicControlOpRequestStable({
		cwd: input.cwd,
		runId: input.run.runId,
		opId: input.opId,
		type: "fanout.planned",
		requestHash,
		errorPrefix: "dynamic fanout plan request changed",
	});
	if (!alreadyRecorded) {
		await recordDynamicEventAndUpdateState(input.cwd, input.run.runId, {
			controllerSpecId: input.controllerTask.specId,
			type: "fanout.planned",
			opId: input.opId,
			requestHash,
			payload,
		});
		return payload;
	}
	const previous = (await readDynamicEvents(input.cwd, input.run.runId))
		.filter(
			(event) => event.opId === input.opId && event.type === "fanout.planned",
		)
		.at(-1);
	return isPlainDynamicRecord(previous?.payload) ? previous.payload : payload;
}

export async function runDynamicStateIndexPersistCall(input: {
	cwd: string;
	run: WorkflowRunRecord;
	controllerTask: WorkflowTaskRunRecord;
	controllerCompiledTask: CompiledTask;
	opId: string;
	callIndex: number;
	request: unknown;
}): Promise<Record<string, unknown>> {
	const request = normalizeDynamicStateIndexRequest(input.request);
	const extracts = await Promise.all(
		request.tasks.map(async (taskRequest) => {
			const task = resolveDynamicRunTask(input.run, taskRequest.taskId);
			assertDynamicReadableTask(
				task,
				input.controllerTask,
				input.controllerCompiledTask,
			);
			const result = await readWorkflowTaskStructuredResult(input.cwd, task, {
				allowFailed: true,
			});
			return extractDynamicStateArtifact({
				taskId: task.specId,
				outputProfile: taskRequest.outputProfile,
				control: isPlainDynamicRecord(result.control)
					? result.control
					: undefined,
				analysis:
					typeof result.analysis === "string" ? result.analysis : undefined,
				refs: result.refs,
				artifactRef: { taskId: task.specId, artifact: "control" },
				status: result.status === "completed" ? "completed" : "failed",
				maxFindings: request.maxFindings,
			});
		}),
	);
	const index = assembleDynamicStateIndex(extracts, {
		// requiredFindingIds is accepted on ctx.stateIndex requests for
		// compatibility, but is a deprecated/no-op Phase 1 runtime field.
		maxFindings: request.maxFindings,
	});
	const requestHash = hashDynamicRequest({ request, digest: index.digest });
	const alreadyRecorded = await assertDynamicControlOpRequestStable({
		cwd: input.cwd,
		runId: input.run.runId,
		opId: input.opId,
		type: "state-index.persisted",
		requestHash,
		errorPrefix: "dynamic state index request changed",
	});
	const written = await writeDynamicStateIndexArtifacts({
		cwd: input.cwd,
		runId: input.run.runId,
		controllerSpecId: input.controllerTask.specId,
		round: request.round,
		extracts,
		index,
	});
	if (!alreadyRecorded)
		await recordDynamicEventAndUpdateState(input.cwd, input.run.runId, {
			controllerSpecId: input.controllerTask.specId,
			type: "state-index.persisted",
			opId: input.opId,
			requestHash,
			payload: {
				callIndex: input.callIndex,
				round: request.round,
				digest: index.digest,
				tasks: request.tasks,
				paths: {
					extracts: toProjectPath(input.cwd, written.extractsPath),
					index: toProjectPath(input.cwd, written.indexPath),
				},
			},
		});
	return {
		digest: index.digest,
		index,
		artifacts: {
			extracts: toProjectPath(input.cwd, written.extractsPath),
			index: toProjectPath(input.cwd, written.indexPath),
		},
	};
}

export async function runDynamicDecisionLoopStatusPersistCall(input: {
	cwd: string;
	run: WorkflowRunRecord;
	controllerTask: WorkflowTaskRunRecord;
	opId: string;
	callIndex: number;
	request: unknown;
}): Promise<Record<string, unknown>> {
	const decisionLoop = normalizeDynamicDecisionLoopStatusRequest(input.request);
	const payload = {
		callIndex: input.callIndex,
		status: "running",
		decisionLoop,
	};
	const requestHash = hashDynamicRequest(payload);
	const alreadyRecorded = await assertDynamicControlOpRequestStable({
		cwd: input.cwd,
		runId: input.run.runId,
		opId: input.opId,
		type: "controller.status",
		requestHash,
		errorPrefix: "dynamic decision-loop status request changed",
	});
	if (!alreadyRecorded) {
		await recordDynamicEventAndUpdateState(input.cwd, input.run.runId, {
			controllerSpecId: input.controllerTask.specId,
			type: "controller.status",
			opId: input.opId,
			requestHash,
			payload,
		});
		return payload;
	}
	const previous = (await readDynamicEvents(input.cwd, input.run.runId))
		.filter(
			(event) =>
				event.opId === input.opId && event.type === "controller.status",
		)
		.at(-1);
	return isPlainDynamicRecord(previous?.payload) ? previous.payload : payload;
}

export async function runDynamicResultReadCall(input: {
	cwd: string;
	run: WorkflowRunRecord;
	controllerTask: WorkflowTaskRunRecord;
	controllerCompiledTask: CompiledTask;
	opId: string;
	callIndex: number;
	request: unknown;
}): Promise<Record<string, unknown>> {
	const request = normalizeDynamicResultReadRequest(input.request);
	const task = resolveDynamicRunTask(input.run, request.taskId);
	assertDynamicReadableTask(
		task,
		input.controllerTask,
		input.controllerCompiledTask,
	);
	const result = await readWorkflowTaskScopedResult(input.cwd, task, {
		allowFailed: request.allowFailed,
		include: request.include,
	});
	const resultDigest = hashDynamicRequest(result);
	const requestHash = hashDynamicRequest({
		request,
		status: result.status,
		resultDigest,
	});
	const alreadyRecorded = await assertDynamicControlOpRequestStable({
		cwd: input.cwd,
		runId: input.run.runId,
		opId: input.opId,
		type: "result.read",
		requestHash,
		errorPrefix: "dynamic result read request changed",
	});
	if (!alreadyRecorded)
		await recordDynamicEventAndUpdateState(input.cwd, input.run.runId, {
			controllerSpecId: input.controllerTask.specId,
			type: "result.read",
			opId: input.opId,
			requestHash,
			payload: {
				callIndex: input.callIndex,
				taskId: task.specId,
				status: result.status,
				resultDigest,
			},
		});
	return result;
}

async function assertDynamicControlOpRequestStable(input: {
	cwd: string;
	runId: string;
	opId: string;
	type:
		| "decision.persisted"
		| "fanout.planned"
		| "state-index.persisted"
		| "controller.status"
		| "result.read";
	requestHash: string;
	errorPrefix: string;
}): Promise<boolean> {
	const previous = (await readDynamicEvents(input.cwd, input.runId)).filter(
		(event) => event.opId === input.opId && event.type === input.type,
	);
	const divergent = previous.find(
		(event) => event.requestHash !== input.requestHash,
	);
	if (divergent) {
		throw new Error(
			`${input.errorPrefix} for ${input.opId}; previous hash ${divergent.requestHash}, new hash ${input.requestHash}`,
		);
	}
	return previous.length > 0;
}

export interface NormalizedDynamicFanoutPlanRequest {
	round: number;
	decisionHash: string;
	branches: Array<{
		branchId: string;
		actionId: string;
		requestId: string;
		type: "add_work_item" | "verify";
		outputProfile: DynamicOutputProfile;
		dependsOn?: string[];
		agentRequest: DynamicAgentRequest;
	}>;
}

export function normalizeDynamicFanoutPlanRequest(
	value: unknown,
): NormalizedDynamicFanoutPlanRequest {
	if (!isPlainDynamicRecord(value)) {
		throw new Error("ctx.fanout.plan() input must be an object");
	}
	const round = requiredDynamicNonNegativeInteger(
		value.round,
		"round",
		"ctx.fanout.plan()",
	);
	const decisionHash = requiredDynamicString(
		value.decisionHash,
		"decisionHash",
		"ctx.fanout.plan()",
	);
	if (!Array.isArray(value.branches)) {
		throw new Error("ctx.fanout.plan() branches must be an array");
	}
	const branches = value.branches.map((item, index) => {
		if (!isPlainDynamicRecord(item)) {
			throw new Error(`ctx.fanout.plan() branches[${index}] must be an object`);
		}
		const branchId = requiredDynamicString(
			item.branchId,
			`branches[${index}].branchId`,
			"ctx.fanout.plan()",
		);
		const actionId = requiredDynamicString(
			item.actionId,
			`branches[${index}].actionId`,
			"ctx.fanout.plan()",
		);
		const type = requiredDynamicString(
			item.type,
			`branches[${index}].type`,
			"ctx.fanout.plan()",
		);
		if (type !== "add_work_item" && type !== "verify") {
			throw new Error(
				`ctx.fanout.plan() branches[${index}].type must be add_work_item or verify`,
			);
		}
		const branchType: "add_work_item" | "verify" = type;
		const outputProfile = requiredDynamicOutputProfile(
			item.outputProfile,
			`branches[${index}].outputProfile`,
			"ctx.fanout.plan()",
		);
		const dependsOn = optionalDynamicStringArray(
			item.dependsOn,
			`branches[${index}].dependsOn`,
		);
		const agentRequest = normalizeDynamicAgentRequest(item.agentRequest);
		if (agentRequest.branchId && agentRequest.branchId !== branchId) {
			throw new Error(
				`ctx.fanout.plan() branches[${index}].agentRequest.branchId must match branchId`,
			);
		}
		const requestId = agentRequest.id;
		const declaredRequestId = optionalDynamicString(
			item.requestId,
			`branches[${index}].requestId`,
		);
		if (declaredRequestId && declaredRequestId !== requestId) {
			throw new Error(
				`ctx.fanout.plan() branches[${index}].requestId must match agentRequest.id`,
			);
		}
		return {
			branchId,
			actionId,
			requestId,
			type: branchType,
			outputProfile,
			dependsOn,
			agentRequest: { ...agentRequest, branchId },
		};
	});
	return { round, decisionHash, branches };
}

function normalizeDynamicStateIndexRequest(value: unknown): {
	round: number;
	tasks: Array<{ taskId: string; outputProfile: DynamicOutputProfile }>;
	maxFindings?: number;
} {
	if (!isPlainDynamicRecord(value)) {
		throw new Error(
			"ctx.stateIndex.extractAndPersist() input must be an object",
		);
	}
	const round = requiredDynamicNonNegativeInteger(
		value.round,
		"round",
		"ctx.stateIndex.extractAndPersist()",
	);
	if (!Array.isArray(value.tasks)) {
		throw new Error(
			"ctx.stateIndex.extractAndPersist() tasks must be an array",
		);
	}
	const tasks = value.tasks.map((item, index) => {
		if (!isPlainDynamicRecord(item)) {
			throw new Error(
				`ctx.stateIndex.extractAndPersist() tasks[${index}] must be an object`,
			);
		}
		return {
			taskId: requiredDynamicString(
				item.taskId ?? item.specId,
				`tasks[${index}].taskId`,
				"ctx.stateIndex.extractAndPersist()",
			),
			outputProfile: requiredDynamicOutputProfile(
				item.outputProfile,
				`tasks[${index}].outputProfile`,
				"ctx.stateIndex.extractAndPersist()",
			),
		};
	});
	// Deprecated/no-op compatibility field: validate accepted shape, then drop
	// it so Phase 1 runtime state-index assembly and replay hashes ignore it.
	optionalDynamicStringArray(value.requiredFindingIds, "requiredFindingIds");
	return {
		round,
		tasks,
		maxFindings: optionalDynamicPositiveInteger(
			value.maxFindings,
			"maxFindings",
		),
	};
}

function normalizeDynamicDecisionLoopStatusRequest(value: unknown): {
	stallCount: number;
	replanCount: number;
} {
	if (!isPlainDynamicRecord(value)) {
		throw new Error(
			"ctx.dynamic.recordDecisionLoopStatus() input must be an object",
		);
	}
	return {
		stallCount: requiredDynamicNonNegativeInteger(
			value.stallCount,
			"stallCount",
			"ctx.dynamic.recordDecisionLoopStatus()",
		),
		replanCount: requiredDynamicNonNegativeInteger(
			value.replanCount,
			"replanCount",
			"ctx.dynamic.recordDecisionLoopStatus()",
		),
	};
}

const DEFAULT_DYNAMIC_RESULT_INCLUDE = ["$.schema", "$.digest"];

function normalizeDynamicResultReadRequest(value: unknown): {
	taskId: string;
	allowFailed: boolean;
	include: string[];
} {
	if (typeof value === "string") {
		return {
			taskId: value,
			allowFailed: false,
			include: [...DEFAULT_DYNAMIC_RESULT_INCLUDE],
		};
	}
	if (!isPlainDynamicRecord(value)) {
		throw new Error("ctx.result() input must be a task id string or object");
	}
	return {
		taskId: requiredDynamicString(
			value.taskId ?? value.specId,
			"taskId",
			"ctx.result()",
		),
		allowFailed: value.allowFailed === true,
		include: normalizeDynamicResultInclude(value.include) ?? [
			...DEFAULT_DYNAMIC_RESULT_INCLUDE,
		],
	};
}

function resolveDynamicRunTask(
	run: WorkflowRunRecord,
	taskIdOrSpecId: string,
): WorkflowTaskRunRecord {
	const task = run.tasks.find(
		(candidate) =>
			candidate.taskId === taskIdOrSpecId ||
			candidate.specId === taskIdOrSpecId,
	);
	if (!task)
		throw new Error(`dynamic task result not found: ${taskIdOrSpecId}`);
	return task;
}

function assertDynamicReadableTask(
	task: WorkflowTaskRunRecord,
	controllerTask: WorkflowTaskRunRecord,
	controllerCompiledTask: CompiledTask,
): void {
	if (task.dynamicGenerated?.controllerSpecId === controllerTask.specId) return;
	const allowed = new Set([
		...(controllerCompiledTask.dependsOn ?? []),
		...(controllerCompiledTask.contextDependsOn ?? []),
	]);
	if (allowed.has(task.specId)) return;
	throw new Error(
		`dynamic result read is limited to generated tasks and upstream dependencies; ${task.specId} is not readable by ${controllerTask.specId}`,
	);
}

async function readWorkflowTaskStructuredResult(
	cwd: string,
	task: WorkflowTaskRunRecord,
	options: { allowFailed?: boolean } = {},
): Promise<Record<string, unknown>> {
	if (task.status === "completed") {
		const output = await readTaskOutputArtifacts(cwd, task);
		return {
			status: task.status,
			statusDetail: task.statusDetail,
			taskId: task.taskId,
			specId: task.specId,
			...output,
		};
	}
	if (!isTerminalTaskStatus(task.status)) {
		throw new DynamicControllerSuspended(
			`waiting for dynamic task result ${task.specId} (${task.status})`,
		);
	}
	if (!options.allowFailed) {
		throw new Error(
			`dynamic task result ${task.specId} ended with ${task.status}: ${task.lastMessage ?? task.statusDetail}`,
		);
	}
	const output = await readTaskOutputArtifacts(cwd, task).catch(() => ({}));
	return {
		status: task.status,
		statusDetail: task.statusDetail,
		taskId: task.taskId,
		specId: task.specId,
		lastMessage: task.lastMessage,
		...output,
	};
}

async function readTaskOutputArtifacts(
	cwd: string,
	task: WorkflowTaskRunRecord,
): Promise<Record<string, unknown>> {
	if (task.artifactGraph?.enabled) {
		const taskDir = dirname(fromProjectPath(cwd, task.files.result));
		return {
			control: await readArtifactGraphControl(cwd, task).catch(() => undefined),
			analysis: await readFile(join(taskDir, "analysis.md"), "utf8").catch(
				() => undefined,
			),
			refs: await readJson(join(taskDir, "refs.json")).catch(() => undefined),
		};
	}
	return {
		result: await readJson(fromProjectPath(cwd, task.files.result)).catch(
			() => undefined,
		),
	};
}

async function readWorkflowTaskScopedResult(
	cwd: string,
	task: WorkflowTaskRunRecord,
	options: { allowFailed?: boolean; include: readonly string[] },
): Promise<Record<string, unknown>> {
	if (task.status === "completed") {
		return {
			...dynamicTaskResultMetadata(task),
			...(await readScopedTaskOutput(cwd, task, options.include)),
		};
	}
	if (!isTerminalTaskStatus(task.status)) {
		throw new DynamicControllerSuspended(
			`waiting for dynamic task result ${task.specId} (${task.status})`,
		);
	}
	if (!options.allowFailed) {
		throw new Error(
			`dynamic task result ${task.specId} ended with ${task.status}: ${task.lastMessage ?? task.statusDetail}`,
		);
	}
	const output = await readScopedTaskOutput(cwd, task, options.include).catch(
		() => ({}),
	);
	return {
		...dynamicTaskResultMetadata(task),
		lastMessage: task.lastMessage,
		...output,
	};
}

function dynamicTaskResultMetadata(
	task: WorkflowTaskRunRecord,
): Record<string, unknown> {
	return {
		status: task.status,
		statusDetail: task.statusDetail,
		taskId: task.taskId,
		specId: task.specId,
		...(task.dynamicGenerated?.outputProfile
			? { outputProfile: task.dynamicGenerated.outputProfile }
			: {}),
	};
}

async function readScopedTaskOutput(
	cwd: string,
	task: WorkflowTaskRunRecord,
	include: readonly string[],
): Promise<Record<string, unknown>> {
	if (task.artifactGraph?.enabled) {
		const control = await readArtifactGraphControl(cwd, task).catch(
			() => undefined,
		);
		const projection = projectArtifactGraphControl(control, {
			include: [...include],
		});
		const scopedControl = projection.value ?? {};
		const digest = controlDigest(control);
		return {
			control: scopedControl,
			artifacts: dynamicResultArtifactRefs(
				task,
				await artifactRefsForTask(cwd, task),
				digest,
			),
			scope: dynamicResultScope({
				taskId: task.specId,
				artifact: "control",
				include,
				content: scopedControl,
				contentDigest: digest,
				missingPaths: projection.missingPaths,
			}),
		};
	}
	const result = await readJson(fromProjectPath(cwd, task.files.result)).catch(
		() => undefined,
	);
	const projection = projectArtifactGraphControl(result, {
		include: [...include],
	});
	const scopedResult = projection.value ?? {};
	const digest = hashDynamicRequest(result);
	return {
		result: scopedResult,
		artifacts: { result: { taskId: task.specId, artifact: "result", digest } },
		scope: dynamicResultScope({
			taskId: task.specId,
			artifact: "result",
			include,
			content: scopedResult,
			contentDigest: digest,
			missingPaths: projection.missingPaths,
		}),
	};
}

function dynamicResultArtifactRefs(
	task: WorkflowTaskRunRecord,
	artifacts: WorkflowSourceManifestSource["artifacts"],
	controlDigestValue: string | undefined,
): Record<string, unknown> {
	const refs: Record<string, unknown> = {};
	for (const artifact of Object.keys(artifacts)) {
		refs[artifact] = {
			taskId: task.specId,
			artifact,
			...(artifact === "control" && controlDigestValue
				? { digest: controlDigestValue }
				: {}),
		};
	}
	return refs;
}

function dynamicResultScope(input: {
	taskId: string;
	artifact: string;
	include: readonly string[];
	content: unknown;
	contentDigest?: string;
	missingPaths: readonly string[];
}): Record<string, unknown> {
	const base = {
		taskId: input.taskId,
		artifact: input.artifact,
		include: [...input.include],
		contentDigest: input.contentDigest,
		missingPaths: [...input.missingPaths],
		content: input.content,
	};
	return {
		taskId: input.taskId,
		artifact: input.artifact,
		include: [...input.include],
		...(input.contentDigest ? { contentDigest: input.contentDigest } : {}),
		...(input.missingPaths.length > 0
			? { missingPaths: [...input.missingPaths] }
			: {}),
		scopeHash: hashDynamicRequest(base),
	};
}

function normalizeDynamicResultInclude(value: unknown): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new Error("ctx.result() include must be an array of strings");
	}
	return value.map((item, index) =>
		normalizeDynamicResultPath(
			requiredDynamicString(item, `include[${index}]`, "ctx.result()"),
		),
	);
}

function normalizeDynamicResultPath(path: string): string {
	let normalized = path.trim();
	if (normalized === "$" || normalized.includes("*")) {
		throw new Error("ctx.result() include paths must name explicit fields");
	}
	if (!normalized.startsWith("$.")) {
		normalized = `$.${normalized.replace(/^\.+/, "")}`;
	}
	if (normalized === "$.") {
		throw new Error("ctx.result() include paths must name explicit fields");
	}
	return normalized;
}

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

function optionalDynamicString(
	value: unknown,
	field: string,
): string | undefined {
	if (value === undefined) return undefined;
	return requiredDynamicString(value, field);
}

function optionalDynamicStringArray(
	value: unknown,
	field: string,
): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new Error(`ctx.agent() ${field} must be an array of strings`);
	}
	return value.map((item) => item.trim()).filter(Boolean);
}

function isPlainDynamicRecord(
	value: unknown,
): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalDynamicPositiveInteger(
	value: unknown,
	field: string,
): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new Error(`ctx.agent() ${field} must be a positive integer`);
	}
	return value;
}

function requiredDynamicOutputProfile(
	value: unknown,
	field: string,
	api: string,
): DynamicOutputProfile {
	const profile = requiredDynamicString(value, field, api);
	if (!isDynamicOutputProfile(profile)) {
		throw new Error(`${api} ${field} has an unsupported output profile`);
	}
	return profile;
}

function requiredDynamicNonNegativeInteger(
	value: unknown,
	field: string,
	api: string,
): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new Error(`${api} ${field} must be a non-negative integer`);
	}
	return value;
}

function requiredDynamicPositiveInteger(
	value: unknown,
	field: string,
	api: string,
): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new Error(`${api} ${field} must be a positive integer`);
	}
	return value;
}

function optionalDynamicStringField(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalDynamicOutputProfile(
	value: unknown,
): DynamicOutputProfile | undefined {
	if (value === undefined) return undefined;
	return requiredDynamicOutputProfile(value, "outputProfile", "ctx.agent()");
}
