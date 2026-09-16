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
export {
	listWorkflows,
	listWorkflowRoutingSpecs,
	resolveWorkflowRef,
	WORKFLOW_ROUTING_CATALOG_BOUNDS,
} from "./workflow-specs.js";
export type {
	ResolvedWorkflowSpecRef,
	WorkflowRoutingCatalog,
	WorkflowRoutingScope,
	WorkflowRoutingSpecRecord,
	WorkflowSpecRecord,
} from "./workflow-specs.js";
export {
	formatWorkflowAutoRecommendation,
	parseWorkflowAutoComparisonOutput,
	recommendWorkflowAuto,
	workflowAutoDirectDraft,
	WORKFLOW_AUTO_COMPARE_CORRELATION_ID,
	WORKFLOW_AUTO_COMPARE_TIMEOUT_MS,
	WORKFLOW_AUTO_MAX_CANDIDATE_CARDS,
	WORKFLOW_AUTO_MAX_MODEL_INPUT_BYTES,
	WORKFLOW_AUTO_MAX_TASK_BYTES,
} from "./workflow-router.js";
export type {
	WorkflowAutoAssessment,
	WorkflowAutoCandidate,
	WorkflowAutoCandidateFacts,
	WorkflowAutoCandidateKind,
	WorkflowAutoComparison,
	WorkflowAutoComparisonStatus,
	WorkflowAutoReadiness,
	WorkflowAutoRecommendation,
	WorkflowAutoRequest,
	WorkflowAutoResult,
} from "./workflow-router.js";
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
	ExecutionProfileForeachBatch,
	ExecutionProfileStageOverride,
	FastMode,
	WorkflowDefaults,
	WorkflowRoutingHints,
	WorkflowCapturedExecutionProfile,
	WorkflowExecutionProfileSelection,
	WorkflowProfileRole,
	WorkflowRunExecutionProfile,
	WorkflowRunAutoSelectionMetadata,
	WorkflowRunLaunchCapture,
	WorkflowRunLaunchCaptureV1,
	WorkflowRunLaunchCaptureV2,
	WorkflowRunLaunchCommandMetadata,
	WorkflowRunLaunchMetadata,
	WorkflowRunLaunchMetadataV1,
	WorkflowRunLaunchMetadataV2,
	WorkflowRunLaunchProfile,
	WorkflowRunLaunchSource,
	WorkflowAutoRoute,
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
export { WORKFLOW_PROFILE_ROLES, WorkflowValidationError } from "./types.js";
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
  /workflow profile [workflow-name-or-path]
  /workflow auto "<task>"
  /workflow run [--model MODEL] [--thinking LEVEL] [--profile NAME] <workflow-name-or-path> "<task>" [--detach] [--force-new]
  /workflow dynamic [--model MODEL] [--thinking LEVEL] "<task>" [--detach] [--force-new]
  /workflow status [run-id]
  /workflow show [--raw] <run-id-or-workflow-name>
  /workflow logs <run-id> [task-id-or-spec-id] [lines]
  /workflow wait <run-id> [timeout-ms]
  /workflow resume <run-id>
  /workflow stop <run-id>
  /workflow prune [--keep N] [--older-than DAYS] [--yes] [--json]
  /workflow notices list [--json]
  /workflow notices acknowledge <exact-run-id> --state <sha256> --reason <text>
  /workflow notices clear <exact-run-id> [--json]

/workflow opens the read-only workflow board TUI.
/workflow <run-id> opens the board focused on that run.
/workflow dynamic starts a spec-less direct dynamic run: no workflow name,
user-selected spec, or generated workflow spec is required.

With --detach, a standalone supervisor process (pi-workflow supervise) keeps
the run progressing after this session exits.

Interactive run/dynamic starts skip launching when an active run with the
same workflow and identical task started within the last 10 minutes;
--force-new starts another run anyway.

/workflow run starts exactly the named workflow and /workflow dynamic starts
exactly the direct dynamic runtime. Neither command classifies or replaces your
selection. /workflow auto discovers bounded existing candidates, may ask one
read-only classifier for a recommendation, then requires an interactive choice
and separate final confirmation before any workflow starts. In print/RPC/headless
mode auto is recommendation-only and prints explicit follow-up commands.

--route and --no-route are no longer accepted; use /workflow auto "<task>" to
request a recommendation.

/workflow profile opens the native Pi picker for Codex, Codex High, Claude,
Mixed, or one per-workflow Custom model/thinking setup. It saves a private user
preference for the exact workflow definition; Custom may capture the current Pi
model/thinking when a new run starts. The picker never starts a workflow or
provider call.

With --profile NAME, /workflow run applies a custom-named executionProfiles
entry declared by the workflow spec and records it on the run. Launch precedence
is explicit --profile, then a saved user workflow profile, then the existing
omitted behavior. Without a saved preference, interactive runs offer declared
profiles plus Base; headless/print runs use defaultExecutionProfile when
present, otherwise Base. Unknown names and unavailable saved model/thinking
pairs fail closed without substitution or silent clamp.
`;
