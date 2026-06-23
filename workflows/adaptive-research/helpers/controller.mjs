export default function controller(ctx) {
	if (typeof ctx?.dynamic?.runDecisionLoop !== "function") {
		throw new Error(
			"dynamic decision-loop helper is unavailable in controller context",
		);
	}
	return ctx.dynamic.runDecisionLoop({
		buildPlannerPrompt: adaptiveResearchPlannerPrompt,
	});
}

function adaptiveResearchPlannerPrompt(input) {
	const generated = input.generatedTaskIds.join(", ") || "none";
	return [
		"You are the planner for an adaptive research workflow stage.",
		"Emit only machine-readable JSON in <control> using schema dynamic-decision-v1; the trusted controller validates and executes accepted decisions. Invalid decisions are rejected and the run can be blocked, so match the schema exactly.",
		"Decide whether to add research work, verify findings, synthesize, stop, or block.",
		`Runtime task: ${input.task}`,
		`Round: ${input.round}`,
		`Generated tasks: ${generated}`,
		input.latestStateIndex
			? `Latest state index digest: ${input.latestStateIndex.digest}`
			: "No state index yet.",
		input.repair
			? `Your previous decision was invalid (attempt ${input.repair.attempt}): ${input.repair.errors.join("; ")}. Fix exactly these problems and re-emit the full decision.`
			: undefined,
		`Max actions: ${input.config.maxActionsPerRound}`,
		`Allowed output profiles: ${input.config.allowedOutputProfiles.join(", ")}`,
		[
			"Required decision shape (dynamic-decision-v1). The top-level object MUST have exactly these fields and no others:",
			'- "schema": "dynamic-decision-v1"',
			'- "decisionId": a non-empty unique string, e.g. "decide-r' +
				input.round +
				'"',
			'- "round": ' + input.round + " (integer)",
			'- "phase": one of "orientation" | "round" | "final" (use "orientation" for round 0 planning, "round" for later research rounds, "final" when synthesizing/stopping)',
			'- "status": one of "continue" | "synthesize" | "stop" | "blocked" (NOT a verb like "add_work")',
			'- "nextActions": an array of action objects (do not use "actions" or a top-level "decision" field)',
		].join("\n"),
		[
			"Action objects:",
			'- add_work_item: { "type": "add_work_item", "actionId": str, "workItemId": str, "prompt": str, "outputProfile": str, optional "dependsOn": [workItemId...], optional "inputRefs": [...] }',
			'- verify: { "type": "verify", "actionId": str, "targetFindingId": str, "prompt": str, "outputProfile": str, optional "inputRefs": [...] }',
			'- synthesize: { "type": "synthesize", "actionId": str, "prompt": str, "outputProfile": "synthesis_v1", optional "inputRefs": [...] }',
			'- stop: { "type": "stop", "actionId": str, "reason": str }',
			"status continue requires add_work_item/verify actions; status synthesize requires synthesize action(s); status stop/blocked requires a single stop action.",
		].join("\n"),
		[
			'inputRefs rules (important): each ref MUST be { "kind": "workflow-artifact-ref", "taskId": <known task id>, optional "artifact": str, optional "digest": str }.',
			`Only reference a taskId you actually know from Generated tasks (${generated}). If you do not know a concrete taskId, OMIT inputRefs entirely rather than inventing one. Do not use fields like "source" or "artifact" without "kind"/"taskId".`,
		].join("\n"),
		[
			"Example valid round-0 decision:",
			'{"schema":"dynamic-decision-v1","decisionId":"decide-r0","round":0,"phase":"orientation","status":"continue","nextActions":[{"type":"add_work_item","actionId":"act-a","workItemId":"wi-a","prompt":"Research ...","outputProfile":"candidate_findings_v1"}]}',
		].join("\n"),
		"Keep <control> limited to controller-consumed fields; put rationale, strategy, criteria descriptions, gaps, and evidence discussion in <analysis> only.",
		"For add_work_item actions, omit agent/tools unless you are asserting the static policy; focus on workItemId, compact prompt, outputProfile, dependencies, and inputRefs.",
		"Generated worker handoffs must stay compact: put objective/key facts/boundaries in prompt; use inputRefs only for known-taskId artifacts instead of pasting bulky material inline.",
		"Do not include unknown fields.",
	]
		.filter(Boolean)
		.join("\n\n");
}
