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
export {
	estimateWorkflowDurationMs,
	findDuplicateActiveRun,
	formatApproxDuration,
} from "./run-estimates.js";
export type {
	DuplicateActiveRunMatch,
	DuplicateRunTarget,
	WorkflowDurationEstimate,
} from "./run-estimates.js";
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
export {
	buildDynamicToolResultBudgetMetrics,
	DYNAMIC_TOOL_RESULT_BUDGET_METRICS_SCHEMA_VERSION,
} from "./dynamic-tool-result-budget-metrics.js";
export type {
	DynamicToolResultBudgetControllerMetrics,
	DynamicToolResultBudgetMetricsSchemaVersion,
	DynamicToolResultBudgetRollup,
	DynamicToolResultBudgetRunMetrics,
	DynamicToolResultBudgetStatusCounts,
	DynamicToolResultBudgetTaskMetrics,
} from "./dynamic-tool-result-budget-metrics.js";
export {
	buildWorkflowRunMetrics,
	WORKFLOW_METRICS_PRICING_MODEL_VERSION,
	WORKFLOW_METRICS_SCHEMA_VERSION,
} from "./workflow-metrics.js";
export {
	VERIFICATION_STATUS,
	VERIFICATION_STATUS_BUCKETS,
	VERIFICATION_STATUS_LABELS,
	VERIFICATION_STATUS_VALUES,
	canonicalVerificationStatus,
	isNonVerifiedTerminalStatus,
	isVerificationBlockedStatus,
	isVerifiedStatus,
	verificationStatusBucket,
} from "./verification-ontology.js";
export type {
	TerminalVerificationStatus,
	VerificationStatus,
} from "./verification-ontology.js";
export type {
	WorkflowLaunchTimingMetrics,
	WorkflowMetricValue,
	WorkflowMetricsPricingModelVersion,
	WorkflowMetricsPricingSource,
	WorkflowMetricsSchemaVersion,
	WorkflowRetryMetrics,
	WorkflowRunMetrics,
	WorkflowRunMetricsMetadata,
	WorkflowRunMetricsRollup,
	WorkflowStageMetrics,
	WorkflowTaskMetrics,
	WorkflowTaskStatusCounts,
	WorkflowUsageMetrics,
} from "./workflow-metrics.js";

export const WORKFLOW_COMMAND = "workflow";

export const WORKFLOW_HELP = `pi-workflow

Usage:
  /workflow [run-id]
  /workflow help
  /workflow validate <workflow-name-or-path>
  /workflow roles <workflow-name-or-path>
  /workflow agents
  /workflow list
  /workflow run [--no-route] [--model MODEL] [--thinking LEVEL] [--profile NAME] <workflow-name-or-path> "<task>" [--detach] [--force-new]
  /workflow dynamic [--route] [--model MODEL] [--thinking LEVEL] "<task>" [--detach] [--force-new]
  /workflow status [run-id]
  /workflow show [--raw] <run-id-or-workflow-name>
  /workflow logs <run-id> [task-id-or-spec-id] [lines]
  /workflow wait <run-id> [timeout-ms]
  /workflow resume <run-id>
  /workflow stop <run-id>

/workflow opens the read-only workflow board TUI.
/workflow <run-id> opens the board focused on that run.
/workflow dynamic starts a spec-less direct dynamic run: no workflow name,
user-selected spec, or generated workflow spec is required.

With --detach, a standalone supervisor process (pi-workflow supervise) keeps
the run progressing after this session exits.

Interactive run/dynamic starts skip launching when an active run with the
same workflow and identical task started within the last 10 minutes;
--force-new starts another run anyway.

/workflow run routes by default: a low-cost router pass first decides direct
answer vs dynamic vs the requested workflow (with quick/standard/max depth).
On low confidence or router failure it escalates to the requested path at
standard depth; the decision is recorded on the run record (or
routing-log.jsonl for direct). Use --no-route to skip the router and start
the requested workflow directly. /workflow dynamic still requires an
explicit --route to enable the router pass.

With --profile NAME, /workflow run applies a named executionProfiles entry
declared by the workflow spec and records it on the run. When omitted for a
workflow with multiple profiles, interactive runs ask before launch; medium
is the recommended first choice. Headless/print runs choose medium when it is
declared. Explicit --profile bypasses the prompt. Routing asks only when the
named workflow path is selected. Unknown names fail closed and list the
declared profiles.
`;
