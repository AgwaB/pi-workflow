import type { GoalProfileCapture } from "./goal-types.js";
import type { ArtifactGraphWorkflowSpec, CompiledDynamicWorkflowTask, GoalWorkflowSpec } from "./types.js";
import type { DynamicAgentRequest } from "./dynamic-generated-task-runtime.js";
import { GOAL_CANDIDATE_TOOLS, type GoalCandidateTool } from "./workflow-goal-workspace-tools.js";
import { workflowDefinitionFingerprint } from "./execution-profile.js";

export function goalWorkerTools(definition: GoalWorkflowSpec): GoalCandidateTool[] {
  const authority = definition.goal.authority;
  const coding = authority.allowedEffects.includes("candidate-write");
  const read = authority.allowedEffects.includes("read");
  if (coding && (!read || !authority.allowedPaths.length))
    throw new Error("Goal candidate-write requires explicit scoped read admission");
  return coding ? [...GOAL_CANDIDATE_TOOLS] : read && authority.allowedPaths.length ? [GOAL_CANDIDATE_TOOLS[0]] : [];
}

export function goalInvocationRequest(definition: GoalWorkflowSpec, task: string | undefined): string {
  const objective = definition.goal.objective;
  const target = task?.trim();
  return target && target !== objective ? `${objective}\n\nTarget: ${target}` : objective;
}

function assertGoalWorkerResultSlot(definition: GoalWorkflowSpec, id: string): void {
  if (!definition.goal.criteria.some(criterion => criterion.verifier.subject.resultSlot === id))
    throw new Error("Goal worker proposal must use an original resultSlot");
}

function goalWorkerPromptPrefix(input: {
  readonly definition: GoalWorkflowSpec;
  readonly request: string;
  readonly id: string;
}): string {
  const { definition, request, id } = input;
  assertGoalWorkerResultSlot(definition, id);
  const coding = definition.goal.authority.allowedEffects.includes("candidate-write");
  const tools = goalWorkerTools(definition);
  const rubricResultPaths = definition.goal.criteria
    .filter(({ verifier }) => verifier.subject.resultSlot === id &&
      verifier.target === "artifact" && verifier.subject.artifact === "control" &&
      verifier.subject.path?.startsWith("$.result"))
    .map(({ verifier }) => verifier.subject.path!);
  const resultContract = rubricResultPaths.length
    ? ` Your <control> JSON MUST include a top-level "result" object and populate every immutable Goal rubric subject path ${JSON.stringify(rubricResultPaths)} with the actual research state. When complete sources are required, continue bounded reads until every required source reaches EOF before finalizing. Unread pages are work to continue, not a blocker or a reason to return early. If an actual tool error, revoked authority, exhausted budget, or missing evidence prevents completion, identify that concrete limitation without inventing results. Never omit a required subject or replace it with a digest-only claim. Incomplete research remains incomplete and is evaluated by the original rubric. The control section must be valid JSON: escape quotation marks inside strings and place explanatory prose in analysis.`
    : "";
  const scopeContext = `Host-owned invocation scope (not criteria, evidence, permissions or thresholds): ${JSON.stringify({ request })}`;
  return `Execute ${coding ? "coding work only through goal_candidate_read/goal_candidate_write on exact admitted ASCII paths. Read complete sources page by page: use cursor:\"\" only to restart at the beginning, then pass each returned nextCursor unchanged until EOF; omit cursor only to continue the last ACKed page. For replacements up to 8192 UTF-8 bytes, write path, current expectedDigest, and content. Large replacements use begin/chunk/commit: begin with that current expectedDigest and exact byte count; then append ordered utf8/base64 chunks of at most 4096 decoded bytes, using returned receivedBytes as each next offset; commit after all bytes are staged. Tool message limits are not file-size limits. No raw tools, commands or origin apply. Source-observed candidate bytes, not your control claims, are evaluated" : tools.length ? "read-only research through goal_candidate_read on exact admitted source paths. No writes, raw tools, commands or origin apply. Read receipts prove access, not research achievement. sourceEvidence contains only original-host citation metadata, not earlier source text or proof this worker read it. Earlier content remains available through genuine bounded reads: use an empty cursor to start at the beginning, then follow returned cursors until EOF. Return actual research control data against the unchanged oracle" : "this read-only, tool-free Goal work. Return actual control data, not a claim of achievement"}.${resultContract}${tools.includes("goal_candidate_read") ? " Candidate tool calls execute sequentially. To continue the original acknowledged read frontier efficiently, you may issue several reads for the same path with cursor omitted in one turn; each resumes after the preceding acknowledged page. When rereading earlier content, follow its explicit nextCursor instead: omission resumes the original frontier, not the reread position. Inspect the returned content and EOF for every required source; citation metadata never substitutes for unread text." : ""}\nImmutable Goal: ${JSON.stringify(definition)}\n${scopeContext}\nProposed work: `;
}

export function buildGoalWorkerRequest(input: {
  readonly definition: GoalWorkflowSpec;
  readonly request: string;
  readonly id: string;
  readonly prompt: string;
}): DynamicAgentRequest {
  const { definition, request, id, prompt } = input;
  if (!prompt.trim()) throw new Error("Goal worker proposal must include non-blank proposed work");
  const coding = definition.goal.authority.allowedEffects.includes("candidate-write");
  return { id, profile: "worker", readOnly: !coding,
    prompt: `${goalWorkerPromptPrefix({ definition, request, id })}${prompt}`,
    inputs: [], requiredReads: [], compact: false };
}

export function reconstructGoalWorkerRequest(input: {
  readonly definition: GoalWorkflowSpec;
  readonly request: string;
  readonly id: string;
  readonly candidatePrompt: string;
}): DynamicAgentRequest {
  const prefix = goalWorkerPromptPrefix(input);
  if (!input.candidatePrompt.startsWith(prefix))
    throw new Error("Goal worker candidate prompt changed its immutable Goal or original invocation scope");
  const prompt = input.candidatePrompt.slice(prefix.length);
  if (!prompt.trim()) throw new Error("Goal worker candidate prompt has blank advisory proposed work");
  return buildGoalWorkerRequest({ ...input, prompt });
}

/** Canonical compiler data only. This neither admits a policy nor grants execution. */
export function buildGoalWorkerPhaseTemplate(input: {
  readonly definition: GoalWorkflowSpec;
  readonly profile: GoalProfileCapture;
  readonly workerAgent: string;
  readonly workflows: readonly { readonly id: string; readonly uses: string }[];
  readonly hasChildren: boolean;
}): CompiledDynamicWorkflowTask {
  const { definition, profile, workerAgent } = input;
  const coding = definition.goal.authority.allowedEffects.includes("candidate-write");
  const tools = goalWorkerTools(definition);
  const slots = new Set(definition.goal.criteria.map(criterion => criterion.verifier.subject.resultSlot));
  const role = profile.roles.find(value => value.role === "research-execution")!;
  return {
    uses: "goal-root-worker-phase", mode: "graph-splice",
    budget: { maxAgents: slots.size, maxConcurrency: 1, maxGraphMutations: slots.size,
      maxRuntimeMs: definition.defaults?.maxRuntimeMs ?? 120_000, maxHelperRuns: 0,
      maxNestedWorkflowDepth: input.hasChildren ? definition.goal.nesting.maxDepth : 0 },
    permissions: { approval: "auto", allowDynamicRoles: false, allowDynamicTools: false }, helpers: {},
    workflows: Object.fromEntries(input.workflows.map(child => [child.id, { uses: child.uses }])),
    decisionLoop: { workerDefaults: { agent: workerAgent, model: role.model, thinking: role.thinking, tools,
        ...(tools.length ? { toolProviders: { goal_candidate_read: { classification: "read-only" as const },
          ...(coding ? { goal_candidate_write: { classification: "write-capable" as const } } : {}) } } : {}) },
      allowedAgents: [...new Set([workerAgent, "researcher"])], allowedTools: tools, allowedOutputProfiles: [], maxDecisionRounds: 1,
      maxActionsPerRound: slots.size, repair: { maxAttempts: 0 }, stateIndex: {},
      stopPolicy: { requireSynthesisAction: false, failOnInvalidDecision: true, maxStalls: 1, failOnDroppedRequiredBranch: true } },
  };
}

/** Captured planner data only. This neither admits a policy nor grants execution. */
export interface GoalPlannerPhaseSnapshot {
  readonly request: string;
  readonly definition: GoalWorkflowSpec;
  readonly profile: GoalProfileCapture;
  readonly workflows: readonly { readonly id: string }[];
}

/** Canonical compiler data only. This neither admits a policy nor grants execution. */
export function buildGoalPlannerPhaseTemplate<Snapshot extends GoalPlannerPhaseSnapshot>(input: {
  readonly snapshot: Snapshot;
  readonly plannerId: string;
  /** Untrusted context carried from an interrupted run being recovered. */
  readonly recoveryNote?: string;
}): ArtifactGraphWorkflowSpec {
  const { snapshot, plannerId, recoveryNote } = input;
  const { definition, profile } = snapshot;
  const resultSlots = [...new Set(definition.goal.criteria.map(criterion => criterion.verifier.subject.resultSlot))];
  const role = profile.roles.find(value => value.role === "planning")!;
  // The planner may select admitted names, never source paths or captured bytes.
  const { workflows: omittedCatalog, ...goal } = definition.goal;
  const plannerDefinition = { ...definition, goal };
  const { workflows: omittedCaptures, definition: omittedDefinition, ...plannerPreview } = snapshot;
  return { schemaVersion: 1, name: "goal-root-planning", artifactGraph: { stages: [{
    id: plannerId, type: "single",
    agent: "researcher", profileRole: "planning", model: role.model, thinking: role.thinking,
    tools: [], readOnly: true, worktreePolicy: "off", maxRuntimeMs: definition.defaults?.maxRuntimeMs ?? 120_000,
    inputPolicy: { artifactAccess: "none" },
    prompt: ["Produce an advisory Goal plan only. You have no tools and no effect authority.",
      "Do not claim achievement or authorize execution. Preserve objective, criteria, scope and oracle exactly.",
      "Emit <control> JSON with schema goal-root-plan-v1, digest, and proposedTasks; then <analysis> and <refs>.",
      `digest must equal ${workflowDefinitionFingerprint(definition)}. The exact immutable original resultSlot IDs are ${JSON.stringify(resultSlots)}. proposedTasks must contain exactly one {id,prompt} per listed ID. A direct worker proposal {id,prompt} with no workflow is allowed and required when no child workflow is selected; the admitted workflow catalog may be empty. The workflow field is optional and may select only an admitted catalog ID. Scoped original read admission permits mediated source reads; only original candidate-write admission permits coding. Source-free workers remain tool-free. No paths, specs, roles, tools, profiles, models or oracle changes are accepted.`,
      "Workflow selection is optional; plans do not need to select a child for every result slot. When selected, plans may select only declared admitted children. Source-aware children have original sequential scoped candidate stages and a unique terminal sink, with explicit per-stage goal_candidate_read and goal_candidate_write only when originally admitted. They reuse the root candidate workspace and captured per-stage agents/tools/profile ceilings, never source their inputs or apply origins. Every predecessor's original request and candidate attempts must settle and retire before successor authority. Tool-free children may retain original safe pipeline dependencies and the unique terminal sink. Each selected child slot uses a distinct catalog ID. Nested Goal children are available only from the immutable captured descendant catalog within the remaining authored depth, and use the captured inherited worker profile. Per-phase agent and graph-mutation ceilings equal the original resultSlot count. All slots run at concurrency one and share the original root request budget, including every child stage; selecting another workflow does not replenish it. Root input and byte ceilings remain original. No execution-phase model may replan.",
      `Admitted workflow IDs: ${JSON.stringify(snapshot.workflows.map(child => child.id))}`,
      `Immutable admitted Goal: ${JSON.stringify({ ...plannerPreview, definition: plannerDefinition })}`,
      ...(recoveryNote ? [recoveryNote] : [])].join("\n\n"),
    output: { analysis: { required: true }, refs: { required: true } },
  }] } };
}
