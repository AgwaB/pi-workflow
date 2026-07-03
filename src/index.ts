export {
	discoverAgents,
	loadAgentByName,
	parseAgentMarkdown,
} from "./agents.js";
export {
	formatLogs,
	formatRunDetails,
	formatRunStatus,
	formatStatus,
	refreshRun,
	resumeRun,
	resumeSupervisors,
	runDynamicTask,
	stopRun,
	runWorkflow,
	runWorkflowSpec,
	waitForRun,
} from "./engine.js";
export type { ResumeRunSummary, StopRunSummary } from "./engine.js";
export { listWorkflows, resolveWorkflowRef } from "./workflow-specs.js";
export type {
	ResolvedWorkflowSpecRef,
	WorkflowSpecRecord,
} from "./workflow-specs.js";
export { compileRole, extractMarkdownSections } from "./roles.js";
export { loadWorkflow, loadWorkflowSpec, parseWorkflow } from "./schema.js";
export { parseArtifactGraphWorkflowSpec } from "./artifact-graph-schema.js";
export type {
	AgentDefinition,
	ApprovalMode,
	BackendOptions,
	CompiledWorkflow,
	CompiledRole,
	CompiledTask,
	FastMode,
	WorkflowDefaults,
	WorkflowRunProvenance,
	ArtifactGraphWorkflowSpec,
	ArtifactGraphStageSpec,
	ArtifactGraphStageType,
	WorkflowArtifactKind,
	RoleSpec,
	TaskCapability,
	ThinkingLevel,
	WorktreePolicy,
} from "./types.js";
export { WorkflowValidationError } from "./types.js";
export { runDynamicDecisionLoop } from "./dynamic-decision-loop.js";
export type {
	DynamicDecisionLoopControllerContext,
	DynamicDecisionLoopResult,
	DynamicDecisionLoopRunResult,
	RunDynamicDecisionLoopOptions,
} from "./dynamic-decision-loop.js";
export {
	assertValidDynamicDecision,
	validateDynamicDecision,
} from "./dynamic-decision.js";
export type {
	DynamicDecisionAction,
	DynamicDecisionPhase,
	DynamicDecisionStatus,
	DynamicDecisionValidationContext,
	DynamicDecisionValidationResult,
	NormalizedDynamicDecision,
} from "./dynamic-decision.js";
export { dynamicOutputProfileValues } from "./dynamic-profiles.js";
export type { DynamicOutputProfile } from "./dynamic-profiles.js";

export const WORKFLOW_COMMAND = "workflow";

export const WORKFLOW_HELP = `pi-workflow

Usage:
  /workflow [run-id]
  /workflow help
  /workflow validate <workflow-name-or-path>
  /workflow roles <workflow-name-or-path>
  /workflow agents
  /workflow list
  /workflow run [--model MODEL] [--thinking LEVEL] <workflow-name-or-path> "<task>" [--detach]
  /workflow dynamic [--model MODEL] [--thinking LEVEL] "<task>" [--detach]
  /workflow status [run-id]
  /workflow show <run-id-or-workflow-name>
  /workflow logs <run-id> [task-id] [lines]
  /workflow wait <run-id> [timeout-ms]
  /workflow resume <run-id>
  /workflow stop <run-id>

/workflow opens the read-only workflow board TUI.
/workflow <run-id> opens the board focused on that run.
/workflow dynamic starts a spec-less direct dynamic run: no workflow name,
user-selected spec, or generated workflow spec is required.

With --detach, a standalone supervisor process (pi-workflow supervise) keeps
the run progressing after this session exits.
`;
