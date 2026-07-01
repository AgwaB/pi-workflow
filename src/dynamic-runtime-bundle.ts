import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ArtifactGraphWorkflowSpec } from "./types.js";

export const DIRECT_DYNAMIC_RUNTIME_VERSION = "direct-dynamic-runtime-v1";
const DIRECT_DYNAMIC_RUNTIME_MAX_RUNTIME_MS = 7_200_000;
const DIRECT_DYNAMIC_RUNTIME_TOOLS = [
	"read",
	"grep",
	"find",
	"ls",
	"workflow_web_search",
	"workflow_web_fetch_source",
	"workflow_web_source_read",
];

export async function ensureDirectDynamicRuntimeBundle(
	cwd: string,
): Promise<string> {
	const bundleDir = join(
		cwd,
		".pi",
		"workflow-runtime",
		DIRECT_DYNAMIC_RUNTIME_VERSION,
	);
	await mkdir(bundleDir, { recursive: true });
	const specPath = join(bundleDir, "spec.json");
	await writeFile(
		join(bundleDir, "controller.mjs"),
		directDynamicControllerSource(),
		"utf8",
	);
	await writeFile(
		specPath,
		`${JSON.stringify(directDynamicSpec(), null, 2)}\n`,
		"utf8",
	);
	return specPath;
}

function directDynamicSpec(): ArtifactGraphWorkflowSpec {
	return {
		schemaVersion: 1,
		name: "dynamic",
		description:
			"Internal spec-less direct dynamic runtime. Users start this through /workflow dynamic or workflow_dynamic, not by selecting a workflow spec.",
		defaults: {
			maxRuntimeMs: DIRECT_DYNAMIC_RUNTIME_MAX_RUNTIME_MS,
			agent: "researcher",
			readOnly: true,
			tools: DIRECT_DYNAMIC_RUNTIME_TOOLS,
		},
		artifactGraph: {
			stages: [
				{
					id: "dynamic",
					type: "dynamic",
					dynamic: {
						uses: "./controller.mjs",
						mode: "graph-splice",
						permissions: {
							approval: "auto",
							allowDynamicRoles: false,
							allowDynamicTools: false,
						},
						budget: {
							maxAgents: 12,
							maxConcurrency: 4,
							maxRuntimeMs: DIRECT_DYNAMIC_RUNTIME_MAX_RUNTIME_MS,
							maxGraphMutations: 32,
						},
						decisionLoop: {
							planner: {
								agent: "researcher",
								tools: DIRECT_DYNAMIC_RUNTIME_TOOLS,
								outputProfile: "generic_summary_v1",
							},
							workerDefaults: {
								agent: "researcher",
								tools: DIRECT_DYNAMIC_RUNTIME_TOOLS,
								outputProfile: "candidate_findings_v1",
							},
							verifier: {
								agent: "researcher",
								tools: DIRECT_DYNAMIC_RUNTIME_TOOLS,
								outputProfile: "verification_result_v1",
							},
							synthesis: {
								agent: "researcher",
								tools: DIRECT_DYNAMIC_RUNTIME_TOOLS,
								outputProfile: "synthesis_v1",
							},
							allowedAgents: ["researcher"],
							allowedTools: DIRECT_DYNAMIC_RUNTIME_TOOLS,
							allowedOutputProfiles: [
								"candidate_findings_v1",
								"verification_result_v1",
								"coverage_assessment_v1",
								"generic_summary_v1",
								"synthesis_v1",
							],
							maxDecisionRounds: 3,
							maxActionsPerRound: 4,
							stateIndex: { maxFindings: 40 },
						},
					},
				},
			],
		},
	};
}

function directDynamicControllerSource(): string {
	return `export default function controller(ctx) {
  if (typeof ctx?.dynamic?.runDecisionLoop !== 'function') {
    throw new Error('dynamic decision-loop helper is unavailable in controller context');
  }
  return ctx.dynamic.runDecisionLoop({ buildPlannerPrompt: directDynamicPlannerPrompt });
}

function directDynamicPlannerPrompt(input) {
  const generated = input.generatedTaskIds.join(', ') || 'none';
  return [
    'You are the planner for a request-only direct dynamic research run.',
    'There is no user-selected workflow, no static intake stage, and no static final reducer. You must plan and execute the whole job dynamically, then produce the final answer through a synthesize action.',
    'Emit only machine-readable JSON in <control> using schema dynamic-decision-v1; the trusted runtime validates and executes accepted decisions.',
    'Decide whether to add research work, verify findings, synthesize, stop, or block.',
    \`Runtime task: \${input.task}\`,
    \`Round: \${input.round}\`,
    \`Generated tasks: \${generated}\`,
    input.latestStateIndex ? \`Latest state index digest: \${input.latestStateIndex.digest}\` : 'No state index yet.',
    input.replan ? [
      \`Replan requested after stalled progress (attempt \${input.replan.attempt}/\${input.replan.maxAttempts}).\`,
      \`Rounds without progress: \${input.replan.roundsWithoutProgress}.\`,
      \`Stall count: \${input.replan.stallCount}.\`,
      \`Last state index digest: \${input.replan.lastDigest ?? 'none'}.\`,
    ].join('\\n') : undefined,
    input.repair ? \`Your previous decision was invalid (attempt \${input.repair.attempt}): \${input.repair.errors.join('; ')}. Fix exactly these problems and re-emit the full decision.\` : undefined,
    \`Max actions: \${input.config.maxActionsPerRound}\`,
    \`Allowed output profiles: \${input.config.allowedOutputProfiles.join(', ')}\`,
    [
      'Required decision shape (dynamic-decision-v1). The top-level object MUST have exactly these fields and no others:',
      '- "schema": "dynamic-decision-v1"',
      '- "decisionId": a non-empty unique string, e.g. "decide-r' + input.round + '"',
      '- "round": ' + input.round + ' (integer)',
      '- "phase": one of "orientation" | "round" | "final"',
      '- "status": one of "continue" | "synthesize" | "stop" | "blocked"',
      '- "nextActions": an array of action objects',
    ].join('\\n'),
    [
      'Action objects:',
      '- add_work_item: { "type": "add_work_item", "actionId": str, "workItemId": str, "prompt": str, "outputProfile": str, optional "dependsOn": [workItemId...], optional "inputRefs": [...] }',
      '- verify: { "type": "verify", "actionId": str, "targetFindingId": str, "prompt": str, "outputProfile": str, optional "inputRefs": [...] }',
      '- synthesize: { "type": "synthesize", "actionId": str, "prompt": str, "outputProfile": "synthesis_v1", optional "inputRefs": [...] }',
      '- stop: { "type": "stop", "actionId": str, "reason": str }',
      'status continue requires add_work_item/verify actions; status synthesize requires synthesize action(s); status stop/blocked requires a single stop action.',
    ].join('\\n'),
    [
      'Synthesis action requirements:',
      '- The synthesis worker is the final user-facing answer for this direct dynamic run.',
      '- Its prompt must ask for a cited decision memo or dossier that answers the original Runtime task directly.',
      '- It must include caveats, source references, and actionable recommendations when relevant.',
      '- It must not say that a later reducer will complete the answer; there is no later reducer.',
    ].join('\\n'),
    [
      'inputRefs rules: each ref MUST be { "kind": "workflow-artifact-ref", "taskId": <known task id>, optional "artifact": str, optional "digest": str }.',
      \`Only reference a taskId you actually know from Generated tasks (\${generated}). If unknown, omit inputRefs rather than inventing one.\`,
    ].join('\\n'),
    'Keep <control> limited to controller-consumed fields; put rationale, strategy, criteria descriptions, gaps, and evidence discussion in <analysis> only.',
    'For add_work_item actions, omit agent/tools unless asserting the static policy; focus on workItemId, compact prompt, outputProfile, dependencies, and inputRefs.',
    'Do not include unknown fields.',
  ].filter(Boolean).join('\\n\\n');
}
`;
}
