import { basename, relative } from "node:path";

import {
	hashDynamicRequest,
	readDynamicEvents,
} from "./dynamic-events.js";
import {
	readOrRebuildDynamicState,
	recordDynamicControllerStatus,
	recordDynamicEventAndUpdateState,
} from "./dynamic-state.js";
import { DynamicControllerBudgetBlocked } from "./dynamic-controller-errors.js";
import {
	workflowBundleFingerprint,
	workflowBundleSpecPath,
} from "./workflow-source-context-runtime.js";
import type {
	CompiledDynamicWorkflowTask,
	WorkflowRunRecord,
	WorkflowTaskRunRecord,
} from "./types.js";

const DYNAMIC_APPROVAL_TIMEOUT_MS = 5 * 60_000;

export interface DynamicWorkflowUi {
	hasUI?: boolean;
	confirm?: (
		title: string,
		message: string,
		options?: { timeout?: number; signal?: AbortSignal },
	) => boolean | Promise<boolean>;
}

export async function ensureDynamicControllerApproval(input: {
	cwd: string;
	run: WorkflowRunRecord;
	task: WorkflowTaskRunRecord;
	dynamic: CompiledDynamicWorkflowTask;
	taskText?: string;
	ui?: DynamicWorkflowUi;
}): Promise<
	{ allowed: true } | { allowed: false; statusDetail: string; message: string }
> {
	const opId = `${input.task.specId}:approval:controller`;
	const approvalRequest = await dynamicApprovalRequestPayload(input);
	const requestHash = hashDynamicRequest(approvalRequest);
	const approvalEvents = (
		await readDynamicEvents(input.cwd, input.run.runId)
	).filter(
		(event) =>
			event.opId === opId &&
			(event.type === "approval.pending" || event.type === "approval.resolved"),
	);
	const divergent = approvalEvents.find(
		(event) => event.requestHash !== requestHash,
	);
	if (divergent) {
		const message = `dynamic approval request changed since the pending prompt; previous hash ${divergent.requestHash}, new hash ${requestHash}. Resolve the workflow bundle/spec scope change, then start a new workflow run to approve the updated scope.`;
		await recordDynamicControllerStatus(input.cwd, input.run.runId, {
			controllerSpecId: input.task.specId,
			status: "policy_blocked",
			message,
		}).catch(() => undefined);
		return {
			allowed: false,
			statusDetail: "dynamic_approval_changed",
			message,
		};
	}
	const resolved = approvalEvents
		.filter((event) => event.type === "approval.resolved")
		.at(-1);
	const approvalMessage = await dynamicApprovalPromptMessage(
		input,
		requestHash,
	);
	const hasPendingApproval = approvalEvents.some(
		(event) =>
			event.type === "approval.pending" && event.requestHash === requestHash,
	);
	if (resolved) {
		if (resolved.payload.approved === true) return { allowed: true };
		const message =
			"dynamic controller approval was rejected; this run will not re-prompt on resume. Start a new workflow run if you want to approve it later.";
		await recordDynamicControllerStatus(input.cwd, input.run.runId, {
			controllerSpecId: input.task.specId,
			status: "policy_blocked",
			message,
		}).catch(() => undefined);
		return {
			allowed: false,
			statusDetail: "dynamic_approval_rejected",
			message,
		};
	}
	if (typeof input.ui?.confirm !== "function" || input.ui.hasUI === false) {
		if (!hasPendingApproval) {
			await recordDynamicEventAndUpdateState(input.cwd, input.run.runId, {
				controllerSpecId: input.task.specId,
				type: "approval.pending",
				opId,
				requestHash,
				payload: {
					message: approvalMessage,
					approvalScope: approvalRequest,
				},
			});
		}
		const message = `dynamic approval mode "ask" requires an interactive Pi UI; this scheduler has no approval UI. Open an interactive Pi session and run /workflow resume ${input.run.runId} to approve or reject.`;
		await recordDynamicControllerStatus(input.cwd, input.run.runId, {
			controllerSpecId: input.task.specId,
			status: "awaiting_ui_unavailable",
			message,
		});
		return {
			allowed: false,
			statusDetail: "dynamic_ui_unavailable",
			message,
		};
	}
	if (!hasPendingApproval) {
		await recordDynamicEventAndUpdateState(input.cwd, input.run.runId, {
			controllerSpecId: input.task.specId,
			type: "approval.pending",
			opId,
			requestHash,
			payload: {
				message: approvalMessage,
				approvalScope: approvalRequest,
			},
		});
	}
	let approved: boolean;
	try {
		approved = await confirmDynamicControllerApproval(
			input.ui,
			approvalMessage,
		);
	} catch {
		const message = `dynamic controller approval timed out or was unavailable. Open an interactive Pi session and run /workflow resume ${input.run.runId} to approve or reject.`;
		await recordDynamicControllerStatus(input.cwd, input.run.runId, {
			controllerSpecId: input.task.specId,
			status: "awaiting_ui_unavailable",
			message,
		});
		return {
			allowed: false,
			statusDetail: "dynamic_approval_timeout",
			message,
		};
	}
	await recordDynamicEventAndUpdateState(input.cwd, input.run.runId, {
		controllerSpecId: input.task.specId,
		type: "approval.resolved",
		opId,
		requestHash,
		payload: { approved, approvalScope: approvalRequest },
	});
	if (!approved) {
		const message =
			"dynamic controller approval was rejected; this run will not re-prompt on resume. Start a new workflow run if you want to approve it later.";
		await recordDynamicControllerStatus(input.cwd, input.run.runId, {
			controllerSpecId: input.task.specId,
			status: "policy_blocked",
			message,
		});
		return {
			allowed: false,
			statusDetail: "dynamic_approval_rejected",
			message,
		};
	}
	return { allowed: true };
}

async function dynamicApprovalRequestPayload(input: {
	cwd: string;
	run: WorkflowRunRecord;
	task: WorkflowTaskRunRecord;
	dynamic: CompiledDynamicWorkflowTask;
	taskText?: string;
}): Promise<Record<string, unknown>> {
	return {
		controllerSpecId: input.task.specId,
		bundle: await workflowBundleFingerprint(input.cwd, input.run),
		uses: input.dynamic.uses,
		mode: input.dynamic.mode,
		taskText: dynamicApprovalTaskFingerprint(input.taskText),
		budget: input.dynamic.budget,
		permissions: input.dynamic.permissions,
		helpers: Object.fromEntries(
			Object.entries(input.dynamic.helpers).map(([id, helper]) => [
				id,
				{
					uses: helper.uses,
					inputSchema: helper.inputSchema,
					outputSchema: helper.outputSchema,
					idempotent: helper.idempotent === true,
				},
			]),
		),
		workflows: Object.fromEntries(
			Object.entries(input.dynamic.workflows).map(([id, workflow]) => [
				id,
				{ uses: workflow.uses },
			]),
		),
	};
}

function dynamicApprovalTaskFingerprint(
	value: string | undefined,
): { preview: string; length: number; hash: string } | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	return {
		preview: truncateDynamicTaskText(trimmed),
		length: trimmed.length,
		hash: hashDynamicRequest(trimmed),
	};
}

function truncateDynamicTaskText(value: string | undefined): string {
	if (!value) return "";
	const trimmed = value.trim();
	return trimmed.length > 1_000 ? `${trimmed.slice(0, 1_000)}…` : trimmed;
}

async function confirmDynamicControllerApproval(
	ui: DynamicWorkflowUi,
	message: string,
): Promise<boolean> {
	const controller = new AbortController();
	let timeout: NodeJS.Timeout | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeout = setTimeout(() => {
			controller.abort();
			reject(new Error("dynamic approval timed out"));
		}, DYNAMIC_APPROVAL_TIMEOUT_MS);
	});
	const confirmPromise = Promise.resolve(
		ui.confirm!("Run dynamic workflow controller?", message, {
			timeout: DYNAMIC_APPROVAL_TIMEOUT_MS,
			signal: controller.signal,
		}),
	);
	confirmPromise.catch(() => undefined);
	try {
		return await Promise.race([confirmPromise, timeoutPromise]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

async function dynamicApprovalPromptMessage(
	input: {
		cwd: string;
		run: WorkflowRunRecord;
		task: WorkflowTaskRunRecord;
		dynamic: CompiledDynamicWorkflowTask;
		taskText?: string;
	},
	approvalRequestHash: string,
): Promise<string> {
	const helpers = Object.entries(input.dynamic.helpers).map(
		([id, helper]) => `${id} -> ${helper.uses}`,
	);
	const workflows = Object.entries(input.dynamic.workflows).map(
		([id, workflow]) => `${id} -> ${workflow.uses}`,
	);
	const taskFingerprint = dynamicApprovalTaskFingerprint(input.taskText);
	const resolvedBundleSpec = await workflowBundleSpecPath(
		input.cwd,
		input.run,
		{
			required: true,
		},
	).catch(() => undefined);
	const bundleSpec = resolvedBundleSpec
		? relative(input.cwd, resolvedBundleSpec).replaceAll("\\", "/")
		: `.pi/workflows/${input.run.runId}/bundle/${basename(input.run.specPath)}`;
	return [
		`Workflow run ${input.run.runId} (${input.run.name ?? "unnamed workflow"}) requests approval to run dynamic controller ${input.task.specId}.`,
		`Original spec: ${input.run.specPath}`,
		`Run bundle spec: ${bundleSpec}`,
		`Approval request digest: ${approvalRequestHash}`,
		...(taskFingerprint
			? [
					`Task: ${taskFingerprint.preview}`,
					`Task digest: ${taskFingerprint.hash} (length=${taskFingerprint.length})`,
				]
			: []),
		`Controller helper: ${input.dynamic.uses}`,
		`Mode: ${input.dynamic.mode}`,
		`Generated agents may request dynamic roles/tools: roles=${input.dynamic.permissions.allowDynamicRoles ? "allowed" : "blocked"}, tools=${input.dynamic.permissions.allowDynamicTools ? "allowed" : "blocked"}.`,
		"Approving this controller authorizes this controller's generated agents to run without later approval prompts. Generated agents run non-interactively within the allowed roles/tools and budgets shown here; read-only generated agents use the shared workspace, while mutation-capable agents and agents using Pi-default tools use managed worktrees. Nested workflows keep their own approval policy and may still block for approval.",
		`Budget: maxAgents=${input.dynamic.budget.maxAgents}, maxConcurrency=${input.dynamic.budget.maxConcurrency}, maxRuntimeMs=${input.dynamic.budget.maxRuntimeMs}, maxGraphMutations=${input.dynamic.budget.maxGraphMutations}, maxHelperRuns=${input.dynamic.budget.maxHelperRuns}, maxNestedWorkflowDepth=${input.dynamic.budget.maxNestedWorkflowDepth}.`,
		helpers.length > 0
			? `Declared helpers: ${helpers.join(", ")}`
			: "Declared helpers: none",
		workflows.length > 0
			? `Declared nested workflows: ${workflows.join(", ")}`
			: "Declared nested workflows: none",
		"Approve only if this workflow bundle and its helper code are trusted.",
	].join("\n");
}

export async function assertDynamicRuntimeBudgetAvailable(input: {
	cwd: string;
	runId: string;
	controllerSpecId: string;
	dynamic: CompiledDynamicWorkflowTask;
}): Promise<void> {
	const message = await dynamicRuntimeBudgetExceededMessageForController(
		input.cwd,
		input.runId,
		input.controllerSpecId,
		input.dynamic,
	);
	if (message) throw new DynamicControllerBudgetBlocked(message);
}

export async function dynamicRuntimeBudgetExceededMessageForController(
	cwd: string,
	runId: string,
	controllerSpecId: string,
	dynamic: CompiledDynamicWorkflowTask,
): Promise<string | undefined> {
	const state = await readOrRebuildDynamicState(cwd, runId);
	const runtimeMs =
		state.controllers[controllerSpecId]?.counters.runtimeMs ?? 0;
	return dynamicRuntimeBudgetExceededMessage(dynamic, runtimeMs);
}

function dynamicRuntimeBudgetExceededMessage(
	dynamic: CompiledDynamicWorkflowTask,
	consumedRuntimeMs: number,
): string | undefined {
	if (consumedRuntimeMs >= dynamic.budget.maxRuntimeMs) {
		return `dynamic runtime budget exhausted: runtimeMs=${consumedRuntimeMs} maxRuntimeMs=${dynamic.budget.maxRuntimeMs}`;
	}
	return undefined;
}

export async function recordDynamicRuntimeUsage(
	cwd: string,
	runId: string,
	controllerSpecId: string,
	elapsedMs: number,
): Promise<void> {
	await recordDynamicEventAndUpdateState(cwd, runId, {
		controllerSpecId,
		type: "budget.used",
		opId: `${controllerSpecId}:budget:runtime`,
		requestHash: hashDynamicRequest({ controllerSpecId, elapsedMs }),
		payload: { counters: { runtimeMs: elapsedMs } },
	});
}
