import { hashDynamicRequest } from "./dynamic-events.js";

import {
	DYNAMIC_DECISION_SCHEMA,
	dynamicLoopSignature,
	type DynamicDecisionAction,
} from "./dynamic-decision.js";
import {
	buildFanoutBranchPlanRequests,
	runSynthesisActions,
	runWorkActions,
} from "./dynamic-loop-actions.js";
import { defaultPlannerPrompt } from "./dynamic-loop-prompts.js";
import type {
	DynamicDecisionLoopControllerContext,
	DynamicDecisionLoopResult,
	DynamicDecisionLoopRunResult,
	DynamicDecisionLoopStatus,
	DynamicLoopAgentResult,
	DynamicPlannerPromptInput,
	DynamicStateIndexPersistResult,
	LoopDecisionRecord,
	RunDynamicDecisionLoopOptions,
} from "./dynamic-loop-types.js";
import type { CompiledDynamicDecisionLoop } from "./types.js";

export type {
	DynamicDecisionLoopControllerContext,
	DynamicDecisionLoopResult,
	DynamicDecisionLoopRunResult,
	DynamicDecisionLoopStatus,
	DynamicDecisionPersistResult,
	DynamicFanoutBranchPlanRequest,
	DynamicFanoutPlanPersistRequest,
	DynamicFanoutPlanPersistResult,
	DynamicFanoutPlannedBranch,
	DynamicLoopAgentRequest,
	DynamicLoopAgentResult,
	DynamicPlannerPromptInput,
	DynamicStateIndexPersistRequest,
	DynamicStateIndexPersistResult,
	RunDynamicDecisionLoopOptions,
} from "./dynamic-loop-types.js";

const DEFAULT_REPLAN_BUDGET = 1;

export async function runDynamicDecisionLoop(
	ctx: DynamicDecisionLoopControllerContext,
	options: RunDynamicDecisionLoopOptions = {},
): Promise<DynamicDecisionLoopRunResult> {
	const config = ctx.dynamic.config();
	if (!config) throw new Error("dynamic decision loop config is required");
	const maxRounds = options.maxRounds ?? config.maxDecisionRounds;
	const maxStalls = Math.max(1, config.stopPolicy.maxStalls ?? 3);
	const decisions: LoopDecisionRecord[] = [];
	const stateIndexes: Array<{ round: number; digest: string }> = [];
	const generatedTasks = new Set<string>(
		dynamicLoopInitialGeneratedTaskIds(ctx),
	);
	const blockers: string[] = [];
	const omissions: string[] = [];
	const caveats: string[] = [];
	const seenDecisionLoopSignatures = new Set<string>();
	let latestStateIndex: DynamicStateIndexPersistResult | undefined;
	let stallCount = 0;
	let roundsWithoutProgress = 0;
	let replanCount = 0;
	let pendingReplan: DynamicPlannerPromptInput["replan"] | undefined;

	for (let round = 0; round < maxRounds; round += 1) {
		const replan = pendingReplan;
		pendingReplan = undefined;
		const persisted = await requestValidDecision(ctx, {
			round,
			config,
			previousDecisions: decisions,
			latestStateIndex,
			generatedTaskIds: [...generatedTasks],
			buildPlannerPrompt: options.buildPlannerPrompt,
			replan,
		});
		decisions.push(persisted);
		if (!persisted.ok || !persisted.decision) {
			const message = `round ${round} decision invalid: ${persisted.errors.join("; ")}`;
			blockers.push(message);
			return result(
				"blocked",
				decisions,
				generatedTasks,
				stateIndexes,
				blockers,
				omissions,
				caveats,
				{ stallCount, replanCount },
			);
		}

		const decision = persisted.decision;
		if (decision.status === "stop" || decision.status === "blocked") {
			for (const action of decision.nextActions) {
				if (action.type === "stop") {
					blockers.push(action.reason);
					caveats.push(...(action.caveats ?? []));
				}
			}
			return result(
				decision.status === "blocked" ? "blocked" : "stopped",
				decisions,
				generatedTasks,
				stateIndexes,
				blockers,
				omissions,
				caveats,
				{ stallCount, replanCount },
			);
		}

		if (decision.status === "synthesize") {
			const outputTasks = await runSynthesisActions(
				ctx,
				decision.nextActions,
				generatedTasks,
			);
			return result(
				"synthesized",
				decisions,
				generatedTasks,
				stateIndexes,
				blockers,
				omissions,
				caveats,
				{ stallCount, replanCount },
				new Set(outputTasks),
			);
		}

		const decisionHash = persisted.decisionHash ?? hashDynamicRequest(decision);
		const decisionLoopSignature = dynamicLoopSignature(decision);
		const repeatedDecision = seenDecisionLoopSignatures.has(
			decisionLoopSignature,
		);
		const generatedCountBeforeRound = generatedTasks.size;
		const previousDigest = latestStateIndex?.digest;
		await recordFanoutPlan(ctx, {
			round,
			decisionHash,
			actions: decision.nextActions,
		});
		const completed = await runWorkActions(
			ctx,
			decision.nextActions,
			generatedTasks,
			round,
		);
		if (completed.length === 0) {
			omissions.push(`round ${round} accepted no executable work actions`);
		} else {
			latestStateIndex = await ctx.stateIndex.extractAndPersist({
				round,
				tasks: completed.map((item) => ({
					taskId: item.specId ?? item.taskId,
					outputProfile: item.outputProfile,
				})),
				maxFindings: config.stateIndex.maxFindings,
			});
			stateIndexes.push({ round, digest: latestStateIndex.digest });
		}

		const hasNewGeneratedTask = generatedTasks.size > generatedCountBeforeRound;
		const digestChanged =
			latestStateIndex !== undefined &&
			latestStateIndex.digest !== previousDigest;
		const madeProgress = hasNewGeneratedTask || digestChanged;
		if (madeProgress) {
			stallCount = Math.max(0, stallCount - 1);
			roundsWithoutProgress = 0;
		} else {
			stallCount += repeatedDecision ? 2 : 1;
			roundsWithoutProgress += 1;
		}
		seenDecisionLoopSignatures.add(decisionLoopSignature);

		let stallBlocker: string | undefined;
		if (stallCount >= maxStalls) {
			if (replanCount < DEFAULT_REPLAN_BUDGET && round + 1 < maxRounds) {
				replanCount += 1;
				pendingReplan = {
					attempt: replanCount,
					maxAttempts: DEFAULT_REPLAN_BUDGET,
					stallCount,
					roundsWithoutProgress,
					...(latestStateIndex?.digest
						? { lastDigest: latestStateIndex.digest }
						: {}),
				};
			} else if (replanCount >= DEFAULT_REPLAN_BUDGET) {
				stallBlocker = `dynamic decision loop stalled after ${roundsWithoutProgress} round(s) without progress (stall count ${stallCount}, maxStalls ${maxStalls}, replans ${replanCount}/${DEFAULT_REPLAN_BUDGET})`;
			}
		}
		await persistDecisionLoopStatus(ctx, { stallCount, replanCount });
		if (stallBlocker) {
			blockers.push(stallBlocker);
			return result(
				"blocked",
				decisions,
				generatedTasks,
				stateIndexes,
				blockers,
				omissions,
				caveats,
				{ stallCount, replanCount },
			);
		}
	}

	return result(
		"exhausted",
		decisions,
		generatedTasks,
		stateIndexes,
		blockers,
		omissions,
		caveats,
		{ stallCount, replanCount },
	);
}

async function persistDecisionLoopStatus(
	ctx: DynamicDecisionLoopControllerContext,
	status: DynamicDecisionLoopStatus,
): Promise<void> {
	await ctx.dynamic.recordDecisionLoopStatus?.(status);
}

async function requestValidDecision(
	ctx: DynamicDecisionLoopControllerContext,
	input: {
		round: number;
		config: CompiledDynamicDecisionLoop;
		previousDecisions: LoopDecisionRecord[];
		latestStateIndex?: DynamicStateIndexPersistResult;
		generatedTaskIds: string[];
		buildPlannerPrompt?: (input: DynamicPlannerPromptInput) => string;
		replan?: DynamicPlannerPromptInput["replan"];
	},
): Promise<LoopDecisionRecord> {
	let lastPersisted: LoopDecisionRecord | undefined;
	for (
		let attempt = 0;
		attempt <= input.config.repair.maxAttempts;
		attempt += 1
	) {
		const promptInput: DynamicPlannerPromptInput = {
			round: input.round,
			task: ctx.task,
			sources: ctx.sources,
			config: input.config,
			previousDecisions: input.previousDecisions,
			latestStateIndex: input.latestStateIndex,
			generatedTaskIds: input.generatedTaskIds,
			...(input.replan ? { replan: input.replan } : {}),
			...(lastPersisted && !lastPersisted.ok
				? { repair: { errors: lastPersisted.errors, attempt } }
				: {}),
		};
		const planner = await ctx.agent({
			id:
				attempt === 0
					? `decide-r${input.round}`
					: `decide-r${input.round}-repair-${attempt}`,
			profile: "planner",
			prompt: (input.buildPlannerPrompt ?? defaultPlannerPrompt)(promptInput),
			compact: false,
		});
		lastPersisted = {
			...(await ctx.decision.validateAndPersist(
				plannerDecisionControl(planner.control),
				{
					expectedRound: input.round,
					maxActions: input.config.maxActionsPerRound,
					maxDecisionRounds: input.config.maxDecisionRounds,
					allowedTools: input.config.allowedTools,
					toolProviders: input.config.allowedToolProviders,
					allowedOutputProfiles: input.config.allowedOutputProfiles,
					allowedAgents: input.config.allowedAgents,
					requireAgent: false,
					knownGeneratedTaskIds: input.generatedTaskIds,
					stateIndexDigest: input.latestStateIndex?.digest,
				},
			)),
			...plannerProse(planner),
		};
		if (lastPersisted.ok) return lastPersisted;
	}
	return (
		lastPersisted ?? {
			ok: false,
			errors: ["planner did not return a decision"],
		}
	);
}

async function recordFanoutPlan(
	ctx: DynamicDecisionLoopControllerContext,
	input: {
		round: number;
		decisionHash: string;
		actions: DynamicDecisionAction[];
	},
): Promise<void> {
	const branches = buildFanoutBranchPlanRequests(
		ctx,
		input.actions,
		input.round,
	);
	if (branches.length === 0) return;
	if (ctx.fanout?.plan) {
		await ctx.fanout.plan({
			round: input.round,
			decisionHash: input.decisionHash,
			branches,
		});
	}
}

function dynamicLoopInitialGeneratedTaskIds(
	ctx: DynamicDecisionLoopControllerContext,
): string[] {
	const generatedBranchTaskIds = new Set(
		ctx.graph.generatedBranchTaskIds?.() ?? [],
	);
	return dynamicLoopVisibleGeneratedTaskIds(
		ctx.graph.generatedTaskIds(),
	).filter((id) => !generatedBranchTaskIds.has(id));
}

function dynamicLoopVisibleGeneratedTaskIds(ids: string[]): string[] {
	return ids.filter((id) => !isDynamicLoopPlannerTaskId(id));
}

function isDynamicLoopPlannerTaskId(id: string): boolean {
	const localId = id.split(".").at(-1) ?? id;
	return /^decide-r\d+(?:-repair-\d+)?$/.test(localId);
}

function result(
	status: DynamicDecisionLoopResult["status"],
	decisions: LoopDecisionRecord[],
	generatedTasks: Set<string>,
	stateIndexes: Array<{ round: number; digest: string }>,
	blockers: string[],
	omissions: string[],
	caveats: string[],
	loopStatus: DynamicDecisionLoopStatus,
	outputTasks: Set<string> = new Set(),
): { control: DynamicDecisionLoopResult; analysis: string; refs: unknown[] } {
	const control: DynamicDecisionLoopResult = {
		schema: "dynamic-controller-result-v1",
		digest: `decision-loop:${status}:${decisions.length}:${generatedTasks.size}`,
		status,
		decisions: decisions.map((item) => ({
			round: item.decision?.round ?? 0,
			decisionId: item.decision?.decisionId,
			status: item.decision?.status,
			decisionHash: item.decisionHash,
		})),
		generatedTasks: [...generatedTasks].sort(),
		outputTasks: [...outputTasks].sort(),
		stateIndexes,
		blockers,
		omissions,
		caveats,
	};
	return {
		control,
		analysis: [
			`Dynamic decision loop finished with status ${status}.`,
			`Accepted/attempted decisions: ${decisions.length}.`,
			`Generated tasks observed: ${generatedTasks.size}.`,
			`Stall counter: ${loopStatus.stallCount}.`,
			`Replan prompts used: ${loopStatus.replanCount}.`,
			...decisions.flatMap((item, index) =>
				item.plannerAnalysis
					? [`\n## Planner analysis ${index + 1}`, item.plannerAnalysis]
					: [],
			),
		].join("\n"),
		refs: decisions.flatMap((item) => item.plannerRefs ?? []),
	};
}

function plannerDecisionControl(control: unknown): unknown {
	if (!control || typeof control !== "object" || Array.isArray(control)) {
		return control;
	}
	const record = control as Record<string, unknown>;
	if (record.schema !== DYNAMIC_DECISION_SCHEMA || !("digest" in record)) {
		return control;
	}
	const { digest: _digest, ...decision } = record;
	return decision;
}

function plannerProse(
	planner: DynamicLoopAgentResult,
): Pick<LoopDecisionRecord, "plannerAnalysis" | "plannerRefs"> {
	return {
		...(typeof planner.analysis === "string" && planner.analysis.trim()
			? { plannerAnalysis: planner.analysis.trim() }
			: {}),
		...(Array.isArray(planner.refs) ? { plannerRefs: planner.refs } : {}),
	};
}
