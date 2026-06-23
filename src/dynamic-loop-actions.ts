import type {
	DynamicDecisionAction,
	DynamicDecisionAddWorkItemAction,
	DynamicDecisionVerifyAction,
} from "./dynamic-decision.js";
import type {
	DynamicDecisionLoopControllerContext,
	DynamicFanoutBranchPlanRequest,
	DynamicLoopAgentRequest,
	DynamicLoopAgentResult,
} from "./dynamic-loop-types.js";
import {
	dynamicActionInputs,
	dynamicSynthesisHandoffPrompt,
	dynamicWorkerHandoffPrompt,
} from "./dynamic-loop-prompts.js";

const DEFAULT_OUTPUT_PROFILE_BY_ACTION: Record<string, string> = {
	add_work_item: "candidate_findings_v1",
	verify: "verification_result_v1",
	synthesize: "synthesis_v1",
};

export function buildFanoutBranchPlanRequests(
	ctx: DynamicDecisionLoopControllerContext,
	actions: DynamicDecisionAction[],
	round: number,
): DynamicFanoutBranchPlanRequest[] {
	const branches: DynamicFanoutBranchPlanRequest[] = [];
	const workItemToSpecId = new Map<string, string>();
	for (const action of actions) {
		if (action.type !== "add_work_item" && action.type !== "verify") continue;
		const built = buildActionAgentRequest(action, workItemToSpecId, round);
		branches.push({
			branchId: built.branchId,
			actionId: action.actionId,
			requestId: built.request.id,
			type: action.type,
			outputProfile: built.outputProfile,
			...(built.dependsOn && built.dependsOn.length > 0
				? { dependsOn: built.dependsOn }
				: {}),
			agentRequest: built.request,
		});
		if (action.type === "add_work_item") {
			workItemToSpecId.set(
				action.workItemId,
				ctx.graph.generatedTaskSpecId?.(action.workItemId) ?? action.workItemId,
			);
		}
	}
	return branches;
}

export async function runWorkActions(
	ctx: DynamicDecisionLoopControllerContext,
	actions: DynamicDecisionAction[],
	generatedTasks: Set<string>,
	round: number,
): Promise<Array<{ taskId: string; specId: string; outputProfile: string }>> {
	const completed: Array<{
		taskId: string;
		specId: string;
		outputProfile: string;
	}> = [];
	const workActions = actions.filter(
		(
			action,
		): action is
			| DynamicDecisionAddWorkItemAction
			| DynamicDecisionVerifyAction =>
			action.type === "add_work_item" || action.type === "verify",
	);
	if (canDispatchWorkActionsInParallel(ctx, workActions)) {
		const workItemToSpecId = new Map<string, string>();
		const planned = workActions.map((action) => ({
			action,
			built: buildActionAgentRequest(action, workItemToSpecId, round),
		}));
		const settled = (await ctx.parallel!(
			planned.map((item) => async () => ({
				action: item.action,
				outputProfile: item.built.outputProfile,
				result: await ctx.agent(item.built.request),
			})),
		)) as Array<
			PromiseSettledResult<{
				action: DynamicDecisionAddWorkItemAction | DynamicDecisionVerifyAction;
				outputProfile: string;
				result: DynamicLoopAgentResult;
			}>
		>;
		for (const item of settled) {
			if (item.status !== "fulfilled") continue;
			appendCompletedWorkAction(
				completed,
				generatedTasks,
				item.value.action,
				item.value.result,
				item.value.outputProfile,
			);
		}
		return completed;
	}
	const workItemToSpecId = new Map<string, string>();
	for (const action of workActions) {
		const result = await runAction(ctx, action, workItemToSpecId, round);
		const specId = appendCompletedWorkAction(
			completed,
			generatedTasks,
			action,
			result,
			action.outputProfile ?? DEFAULT_OUTPUT_PROFILE_BY_ACTION[action.type],
		);
		if (action.type === "add_work_item")
			workItemToSpecId.set(action.workItemId, specId);
	}
	return completed;
}

function canDispatchWorkActionsInParallel(
	ctx: DynamicDecisionLoopControllerContext,
	workActions: Array<
		DynamicDecisionAddWorkItemAction | DynamicDecisionVerifyAction
	>,
): boolean {
	return (
		typeof ctx.parallel === "function" &&
		workActions.length > 1 &&
		workActions.every(
			(action) =>
				action.type !== "add_work_item" ||
				!action.dependsOn ||
				action.dependsOn.length === 0,
		)
	);
}

function appendCompletedWorkAction(
	completed: Array<{ taskId: string; specId: string; outputProfile: string }>,
	generatedTasks: Set<string>,
	action: DynamicDecisionAddWorkItemAction | DynamicDecisionVerifyAction,
	result: DynamicLoopAgentResult,
	outputProfile: string,
): string {
	const specId = String(result.specId ?? result.taskId ?? "");
	if (!specId)
		throw new Error(`dynamic action ${action.actionId} returned no task id`);
	generatedTasks.add(specId);
	completed.push({
		taskId: String(result.taskId ?? specId),
		specId,
		outputProfile,
	});
	return specId;
}

async function runAction(
	ctx: DynamicDecisionLoopControllerContext,
	action: DynamicDecisionAddWorkItemAction | DynamicDecisionVerifyAction,
	workItemToSpecId: Map<string, string>,
	round: number,
): Promise<DynamicLoopAgentResult> {
	return await ctx.agent(
		buildActionAgentRequest(action, workItemToSpecId, round).request,
	);
}

function buildActionAgentRequest(
	action: DynamicDecisionAddWorkItemAction | DynamicDecisionVerifyAction,
	workItemToSpecId: Map<string, string>,
	round: number,
): {
	branchId: string;
	outputProfile: string;
	dependsOn?: string[];
	request: DynamicLoopAgentRequest;
} {
	const branchId = dynamicBranchId(round, action.actionId);
	const dependsOn =
		action.type === "add_work_item"
			? (action.dependsOn ?? []).map(
					(item) => workItemToSpecId.get(item) ?? item,
				)
			: undefined;
	const outputProfile =
		action.outputProfile ?? DEFAULT_OUTPUT_PROFILE_BY_ACTION[action.type];
	const prompt = dynamicWorkerHandoffPrompt({
		action,
		outputProfile,
		dependsOn,
	});
	const inputs = dynamicActionInputs(action.inputRefs);
	if (action.type === "add_work_item") {
		return {
			branchId,
			outputProfile,
			dependsOn,
			request: {
				id: action.workItemId,
				profile: "worker",
				prompt,
				outputProfile,
				branchId,
				...(dependsOn && dependsOn.length > 0 ? { dependsOn } : {}),
				...(inputs.length > 0 ? { inputs } : {}),
			},
		};
	}
	return {
		branchId,
		outputProfile,
		request: {
			id: action.actionId,
			profile: "verifier",
			prompt,
			outputProfile,
			branchId,
			...(inputs.length > 0 ? { inputs } : {}),
		},
	};
}

function dynamicBranchId(round: number, actionId: string): string {
	return `r${round}:${actionId}`;
}

export async function runSynthesisActions(
	ctx: DynamicDecisionLoopControllerContext,
	actions: DynamicDecisionAction[],
	generatedTasks: Set<string>,
): Promise<string[]> {
	const outputTasks: string[] = [];
	for (const action of actions) {
		if (action.type !== "synthesize") continue;
		const outputProfile =
			action.outputProfile ?? DEFAULT_OUTPUT_PROFILE_BY_ACTION[action.type];
		const inputs = dynamicActionInputs(action.inputRefs);
		const result = await ctx.agent({
			id: action.actionId,
			profile: "synthesis",
			prompt: dynamicSynthesisHandoffPrompt(action, outputProfile),
			outputProfile,
			...(inputs.length > 0 ? { inputs } : {}),
		});
		const specId = String(result.specId ?? result.taskId ?? "");
		if (specId) {
			generatedTasks.add(specId);
			outputTasks.push(specId);
		}
	}
	return outputTasks;
}
