import type {
	DynamicDecisionAddWorkItemAction,
	DynamicDecisionArtifactRef,
	DynamicDecisionSynthesizeAction,
	DynamicDecisionVerifyAction,
} from "./dynamic-decision.js";
import type { DynamicPlannerPromptInput } from "./dynamic-loop-types.js";

const DYNAMIC_WORKER_OBJECTIVE_MAX_CHARS = 1200;

export function dynamicWorkerHandoffPrompt(input: {
	action: DynamicDecisionAddWorkItemAction | DynamicDecisionVerifyAction;
	outputProfile: string;
	dependsOn?: string[];
}): string {
	const keyFacts =
		input.action.type === "add_work_item"
			? [
					`actionId=${input.action.actionId}`,
					`workItemId=${input.action.workItemId}`,
					...(input.dependsOn && input.dependsOn.length > 0
						? [`dependsOn=${input.dependsOn.join(", ")}`]
						: []),
				]
			: [
					`actionId=${input.action.actionId}`,
					`targetFindingId=${input.action.targetFindingId}`,
				];
	return [
		"# Dynamic Worker Handoff",
		`## Objective\n${compactDynamicObjective(input.action.prompt)}`,
		`## Output Profile\n${input.outputProfile}`,
		[
			"## Boundaries",
			"- Return compact typed output for the declared output profile.",
			"- Use declared artifact refs for source material; do not paste large upstream context into the final answer.",
			"- Surface gaps, blockers, conflicts, or omissions explicitly instead of inventing coverage.",
		].join("\n"),
		dynamicRefsSection(input.action.inputRefs),
		[`## Key Facts`, ...keyFacts.map((fact) => `- ${fact}`)].join("\n"),
	]
		.filter(Boolean)
		.join("\n\n");
}

export function dynamicSynthesisHandoffPrompt(
	action: DynamicDecisionSynthesizeAction,
	outputProfile: string,
): string {
	return [
		"# Dynamic Synthesis Handoff",
		`## Objective\n${compactDynamicObjective(
			action.prompt ??
				"Synthesize the accepted dynamic workflow findings into a concise final handoff.",
		)}`,
		`## Output Profile\n${outputProfile}`,
		[
			"## Boundaries",
			"- Produce a compact final synthesis; reference large supporting material by artifact ref.",
			"- Surface blockers, omissions, and caveats explicitly.",
		].join("\n"),
		dynamicRefsSection(action.inputRefs),
		[`## Key Facts`, `- actionId=${action.actionId}`].join("\n"),
	]
		.filter(Boolean)
		.join("\n\n");
}

function compactDynamicObjective(value: string): string {
	if (value.length <= DYNAMIC_WORKER_OBJECTIVE_MAX_CHARS) return value;
	return `${value.slice(0, DYNAMIC_WORKER_OBJECTIVE_MAX_CHARS).trimEnd()}\n\n[Objective truncated from ${value.length} chars. Put bulky source material in inputRefs/artifact reads rather than inline worker prompts.]`;
}

function dynamicRefsSection(
	inputRefs: DynamicDecisionArtifactRef[] | undefined,
): string {
	if (!inputRefs || inputRefs.length === 0) {
		return "## Input Artifact Refs\nNone declared.";
	}
	return [
		"## Input Artifact Refs",
		...inputRefs.map(
			(ref) =>
				`- ${dynamicArtifactInputName(ref)}${ref.digest ? ` (digest ${ref.digest})` : ""}`,
		),
	].join("\n");
}

export function dynamicActionInputs(
	inputRefs: DynamicDecisionArtifactRef[] | undefined,
): Array<{
	kind: "workflow-artifact-ref";
	name: string;
	options?: Record<string, unknown>;
}> {
	return (inputRefs ?? []).map((ref) => ({
		kind: "workflow-artifact-ref",
		name: dynamicArtifactInputName(ref),
		...(ref.digest ? { options: { digest: ref.digest } } : {}),
	}));
}

function dynamicArtifactInputName(ref: DynamicDecisionArtifactRef): string {
	return ref.artifact ? `${ref.taskId}.${ref.artifact}` : ref.taskId;
}

export function defaultPlannerPrompt(input: DynamicPlannerPromptInput): string {
	return [
		"You are the planner for a dynamic workflow stage.",
		"Emit only machine-readable JSON in <control> using schema dynamic-decision-v1.",
		"The trusted controller will validate and execute accepted decisions; you cannot call tools directly from the decision.",
		`Round: ${input.round}`,
		`Runtime task: ${input.task}`,
		`Generated tasks: ${input.generatedTaskIds.join(", ") || "none"}`,
		input.latestStateIndex
			? `Latest state index digest: ${input.latestStateIndex.digest}`
			: "No state index yet.",
		input.replan
			? [
					`Replan requested after stalled dynamic loop progress (attempt ${input.replan.attempt}/${input.replan.maxAttempts}).`,
					`Rounds without progress: ${input.replan.roundsWithoutProgress}.`,
					`Stall count: ${input.replan.stallCount}.`,
					`Last state index digest: ${input.replan.lastDigest ?? "none"}.`,
				].join("\n")
			: undefined,
		input.repair
			? `Your previous decision was invalid (attempt ${input.repair.attempt}): ${input.repair.errors.join("; ")}`
			: undefined,
		`Allowed output profiles: ${input.config.allowedOutputProfiles.join(", ")}`,
		`Maximum actions this round: ${input.config.maxActionsPerRound}`,
		"Keep <control> limited to controller-consumed fields; put rationale, strategy, criteria descriptions, gaps, and evidence discussion in <analysis> only.",
		"Use nextActions to add work, verify findings, synthesize, stop, or block. Do not include unknown fields.",
		"Keep generated-worker prompts compact: describe objective/key facts/boundaries, and put bulky source material in inputRefs artifact references instead of inline prompt text.",
	]
		.filter(Boolean)
		.join("\n\n");
}
