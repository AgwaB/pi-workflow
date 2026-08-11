import type {
	WorkflowModelInfo,
	WorkflowRuntimeDefaults,
	WorkflowRuntimeThinkingResolution,
} from "./workflow-runtime.js";

export const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const;
export const FAST_MODES = ["inherit", "off"] as const;
export const APPROVAL_MODES = ["non-interactive", "on-request"] as const;
export const WORKTREE_POLICIES = ["auto", "on", "off"] as const;
export const TOOL_CLASSIFICATIONS = [
	"read-only",
	"write-capable",
	"mutation-capable",
] as const;
export const WORKFLOW_RUN_TYPE = "artifact-graph" as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type FastMode = (typeof FAST_MODES)[number];
export type ApprovalMode = (typeof APPROVAL_MODES)[number];
export type WorktreePolicy = (typeof WORKTREE_POLICIES)[number];
export type ToolClassification = (typeof TOOL_CLASSIFICATIONS)[number];
export type WorkflowRunType = typeof WORKFLOW_RUN_TYPE;

export interface BackendOptions {
	type?: "local-pi";
	mode?: "auto" | "headless";
}

export interface WorkflowBackendHandle {
	display?: string;
	[key: string]: unknown;
}

export interface WorkflowToolObjectSpec {
	name: string;
	extensions?: string[];
	classification?: ToolClassification;
	optional?: boolean;
	fallbackTools?: string[];
}

export type WorkflowToolSpec = string | WorkflowToolObjectSpec;

export interface CompiledToolProvider {
	extensions?: string[];
	classification?: ToolClassification;
	optional?: boolean;
	fallbackTools?: string[];
}

export interface WorkflowDefaults {
	cwd?: string;
	agent?: string;
	model?: string;
	thinking?: ThinkingLevel;
	fast?: FastMode;
	approvalMode?: ApprovalMode;
	tools?: WorkflowToolSpec[];
	readOnly?: boolean;
	worktreePolicy?: WorktreePolicy;
	maxConcurrency?: number;
	maxRuntimeMs?: number;
	backend?: BackendOptions;
}

export interface RoleSpec {
	fromAgent?: string;
	prompt?: string;
	includeSections?: string[];
	excludeSections?: string[];
	maxChars?: number;
}

export type ArtifactGraphStageType =
	| "single"
	| "reduce"
	| "foreach"
	| "loop"
	| "dag"
	| "dynamic";

export type WorkflowArtifactKind = "control" | "analysis" | "refs" | "raw";

export interface WorkflowFailurePolicy {
	failFast?: boolean;
	cancelSiblingsOnFailure?: boolean;
	cancelDescendantsOnParentFailure?: boolean;
}

interface RequiredWorkflowArtifactReadPolicyBase {
	source: string;
	artifact: WorkflowArtifactKind;
	mustNotTruncate?: boolean;
	minReturnedBytes?: number;
}

export type RequiredWorkflowArtifactReadPolicy =
	| (RequiredWorkflowArtifactReadPolicyBase & {
			path: string;
			maxItems?: number;
			maxChars?: number;
	  })
	| (RequiredWorkflowArtifactReadPolicyBase & {
			path?: string;
			maxItems?: undefined;
			maxChars?: undefined;
	  });

export interface ExecutionProfileForeachBatch {
	/** Fixed v1 batch size for profile-only transparent foreach batching. */
	maxItems: 2;
	/** One or more simple JSONPaths evaluated relative to each foreach item. */
	groupBy?: string | string[];
}

/** Durable per-item eligibility metadata captured while a foreach item is raw. */
export interface WorkflowForeachBatchGrouping {
	enabled: true;
	/** False means adjacent items may pair without a grouping key. */
	groupBy: boolean;
	/** Canonical JSON for the first usable configured groupBy value. */
	groupKey?: string;
}

export interface ExecutionProfileStageOverride {
	model?: string;
	thinking?: ThinkingLevel;
	foreachBatch?: ExecutionProfileForeachBatch;
}

export interface ArtifactGraphWorkflowSpec {
	schemaVersion: 1;
	name?: string;
	description?: string;
	input?: unknown;
	defaults?: WorkflowDefaults;
	roles?: Record<string, RoleSpec>;
	/**
	 * Named execution profiles selected at run time. Stage keys are top-level ids
	 * or canonical nested dag ids (`container.child`). Empty profiles are identity.
	 */
	executionProfiles?: Record<
		string,
		Record<string, ExecutionProfileStageOverride>
	>;
	/** Omitted profile selection uses this declared profile when present. */
	defaultExecutionProfile?: string;
	artifactGraph: WorkflowFailurePolicy & {
		stages: ArtifactGraphStageSpec[];
		maxConcurrency?: number;
	};
}

export interface DynamicWorkflowBudgetSpec {
	maxAgents?: number;
	maxConcurrency?: number;
	maxRuntimeMs?: number;
	maxNestedWorkflowDepth?: number;
	maxGraphMutations?: number;
	maxHelperRuns?: number;
}

export interface DynamicWorkflowPermissionsSpec {
	approval?: "auto" | "ask";
	allowDynamicRoles?: boolean;
	allowDynamicTools?: boolean;
}

export interface DynamicWorkflowHelperSpec {
	uses: string;
	inputSchema?: string;
	outputSchema?: string;
	idempotent?: boolean;
}

export interface DynamicWorkflowNestedSpec {
	uses: string;
}

export interface DynamicDecisionLoopExecutionProfileSpec {
	agent?: string;
	model?: string;
	thinking?: ThinkingLevel;
	tools?: WorkflowToolSpec[];
	outputProfile?: string;
	maxRuntimeMs?: number;
}

export interface DynamicDecisionLoopSpec {
	planner?: DynamicDecisionLoopExecutionProfileSpec;
	workerDefaults?: DynamicDecisionLoopExecutionProfileSpec;
	verifier?: DynamicDecisionLoopExecutionProfileSpec;
	synthesis?: DynamicDecisionLoopExecutionProfileSpec;
	allowedAgents?: string[];
	allowedTools?: WorkflowToolSpec[];
	allowedOutputProfiles?: string[];
	maxDecisionRounds?: number;
	maxActionsPerRound?: number;
	repair?: { maxAttempts?: number };
	stateIndex?: {
		maxFindings?: number;
		/**
		 * @deprecated Phase 1 compatibility no-op. Accepted by the authoring
		 * contract but not used by the decision-loop runtime.
		 */
		requiredFindingIds?: string[];
	};
	stopPolicy?: {
		/**
		 * @deprecated Phase 1 compatibility no-op. Synthesize decisions are
		 * governed by the canonical decision validator instead.
		 */
		requireSynthesisAction?: boolean;
		failOnInvalidDecision?: boolean;
		/**
		 * Maximum progress-aware stall score before the dynamic loop asks the
		 * planner for a bounded replan.
		 */
		maxStalls?: number;
		/**
		 * @deprecated Phase 1 compatibility no-op. Dropped-branch enforcement is
		 * deferred; invalid/omitted work is surfaced via blockers/omissions.
		 */
		failOnDroppedRequiredBranch?: boolean;
	};
}

export interface DynamicWorkflowStageSpec {
	uses: string;
	mode?: "graph-splice";
	budget?: DynamicWorkflowBudgetSpec;
	permissions?: DynamicWorkflowPermissionsSpec;
	helpers?: Record<string, DynamicWorkflowHelperSpec>;
	workflows?: Record<string, DynamicWorkflowNestedSpec>;
	decisionLoop?: DynamicDecisionLoopSpec;
}

export interface ArtifactGraphRequiredReadSpec {
	source: string;
	artifact: WorkflowArtifactKind;
	path?: string;
	maxChars?: number;
	maxItems?: number;
	count?: number;
}

export type ArtifactGraphRequiredRead = string | ArtifactGraphRequiredReadSpec;
export interface ArtifactGraphForeachSpec {
	prompt: string;
	agent?: string;
	role?: string | string[];
	tools?: WorkflowToolSpec[];
	readOnly?: boolean;
	model?: string;
	thinking?: string;
	maxRuntimeMs?: number;
	worktreePolicy?: string;
	itemIdentityPath?: string;
	itemPayloadPath?: string;
}

export interface ArtifactGraphStageSpec {
	id: string;
	type?: ArtifactGraphStageType;
	prompt?: string;
	agent?: string;
	role?: string | string[];
	cwd?: string;
	model?: string;
	thinking?: ThinkingLevel;
	fast?: FastMode;
	approvalMode?: ApprovalMode;
	tools?: WorkflowToolSpec[];
	readOnly?: boolean;
	worktreePolicy?: WorktreePolicy;
	maxRuntimeMs?: number;
	maxConcurrency?: number;
	maxItems?: number;
	from?:
		| string
		| string[]
		| {
				source: string;
				path: string;
				streaming?: { enabled: true; minChunk?: number };
		  };
	after?: string | string[];
	sourcePolicy?: "success" | "partial" | "require-success";
	sourceProjection?: {
		include?: string[];
		maxChars?: number;
	};
	inputPolicy?: {
		requiredReads?: ArtifactGraphRequiredRead[];
		requiredReadPolicy?: RequiredWorkflowArtifactReadPolicy[];
		enforcement?: "fail";
		artifactAccess?: "enabled" | "none";
		terminalBarrier?: "all-sources";
		invalidateOnDependencyResume?: true;
		maxCompiledPromptChars?: number;
	};
	output?: {
		controlSchema?: string;
		analysis?: { required?: boolean };
		refs?: { required?: boolean; minItems?: number };
		maxDigestChars?: number;
		partial?: { paths: string[] };
	};
	each?: ArtifactGraphForeachSpec;
	stages?: ArtifactGraphStageSpec[];
	outputFrom?: string;
	support?: { uses: string; options?: Record<string, unknown> };
	dynamic?: DynamicWorkflowStageSpec;
	until?: unknown;
	maxRounds?: number;
	progressPath?: string;
	onExhausted?: ArtifactGraphStageSpec;
}

export interface ValidationIssue {
	path: string;
	message: string;
}

export class WorkflowValidationError extends Error {
	readonly issues: ValidationIssue[];

	constructor(issues: ValidationIssue[]) {
		super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
		this.name = "WorkflowValidationError";
		this.issues = issues;
	}
}

export interface AgentDefinition {
	name: string;
	displayName: string;
	description?: string;
	packageName?: string;
	aliases: string[];
	sourcePath: string;
	scope: "project" | "user" | "bundled";
	frontmatter: Record<string, unknown>;
	body: string;
	model?: string;
	thinking?: ThinkingLevel;
	fast?: FastMode;
	tools?: string[];
	readOnly?: boolean;
	approvalMode?: ApprovalMode;
	maxSubagentDepth: number;
	systemPromptMode?: string;
	inheritProjectContext?: boolean;
	inheritSkills?: boolean;
}

export interface CompiledRole {
	name: string;
	fromAgent?: string;
	sourcePath?: string;
	content: string;
	maxChars: number;
	truncated: boolean;
	includedSections: string[];
	excludedSections: string[];
}

export type TaskCapability = ToolClassification;

export interface PermissionPreview {
	status: "pending" | "blocked";
	statusDetail?: "pending_approval" | "needs_attention";
	reason?: string;
}

export interface CompiledTaskRuntime {
	model?: string;
	thinking?: ThinkingLevel;
	thinkingResolution?: WorkflowRuntimeThinkingResolution;
	fast?: FastMode;
	approvalMode: ApprovalMode;
	tools?: string[];
	toolProviders?: Record<string, CompiledToolProvider>;
	maxRuntimeMs?: number;
}

export interface CompiledTaskSafety {
	readOnlyDeclared: boolean;
	capability: TaskCapability;
	sharedCwdSafe: boolean;
	worktreePolicy: WorktreePolicy;
	requiresWorktree: boolean;
	permission: PermissionPreview;
}

export type LoopUntilLeaf = {
	stage?: string;
	source?: string;
	path: string;
	equals?: string | number | boolean | null;
	notEquals?: string | number | boolean | null;
	lengthEquals?: number;
	exists?: boolean;
};

export type LoopUntilCondition =
	| LoopUntilLeaf
	| { all: LoopUntilCondition[] }
	| { any: LoopUntilCondition[] };

export type LoopResultStatus =
	| "completed"
	| "exhausted"
	| "stopped_no_progress";

export interface CompiledLoopChildTaskRef {
	loopId: string;
	round: number;
	roundTag: string;
	childStageId: string;
	childTaskId: string;
	firstChildStage: boolean;
}

export interface CompiledLoopStageRecord {
	id: string;
	type: "loop";
	sourcePolicy?: string;
	maxRounds: number;
	until: LoopUntilCondition;
	childStageIds: string[];
	childTemplates: CompiledTask[];
	childStageRecords?: Array<{
		id: string;
		type?: string;
		sourcePolicy?: string;
	}>;
	onExhausted?: {
		stageId: string;
		template: CompiledTask;
	};
	progressPath?: string;
}

export interface LoopStateRecord {
	loopId: string;
	round: number;
	status?: LoopResultStatus;
	awaitingOnExhausted?: boolean;
	onExhaustedSpecId?: string;
	updatedAt?: string;
}

export interface LoopWorktreeRecord {
	loopId: string;
	path: string;
	branch: string | null;
	baseCwd: string | null;
}

export interface LoopResultRecord {
	loopId: string;
	status: LoopResultStatus;
	roundsUsed: number;
	worktreePath: string | null;
	finalCheck?: unknown;
	summary: string;
}

export interface WorkflowSourceContextSpec {
	maxPreviewChars?: number;
	maxStructuredChars?: number;
	maxStructuredCharsByStage?: Record<string, number>;
	structuredOutputPathsByStage?: Record<string, string[]>;
	maxPacketChars?: number;
}

export interface CompiledDynamicWorkflowBudget {
	maxAgents: number;
	maxConcurrency: number;
	maxRuntimeMs: number;
	maxNestedWorkflowDepth: number;
	maxGraphMutations: number;
	maxHelperRuns: number;
}

export interface CompiledDynamicWorkflowHelper {
	uses: string;
	usesPath?: string;
	inputSchema?: string;
	inputSchemaPath?: string;
	outputSchema?: string;
	outputSchemaPath?: string;
	idempotent?: boolean;
}

export interface CompiledDynamicNestedWorkflow {
	uses: string;
	usesPath?: string;
}

export interface CompiledDynamicDecisionLoopExecutionProfile {
	agent?: string;
	model?: string;
	thinking?: ThinkingLevel;
	tools?: string[];
	toolProviders?: Record<string, CompiledToolProvider>;
	outputProfile?: string;
	maxRuntimeMs?: number;
}

export interface CompiledDynamicDecisionLoop {
	planner?: CompiledDynamicDecisionLoopExecutionProfile;
	workerDefaults?: CompiledDynamicDecisionLoopExecutionProfile;
	verifier?: CompiledDynamicDecisionLoopExecutionProfile;
	synthesis?: CompiledDynamicDecisionLoopExecutionProfile;
	allowedAgents: string[];
	allowedTools?: string[];
	allowedToolProviders?: Record<string, CompiledToolProvider>;
	allowedOutputProfiles: string[];
	maxDecisionRounds: number;
	maxActionsPerRound: number;
	repair: { maxAttempts: number };
	stateIndex: {
		maxFindings?: number;
		/**
		 * @deprecated Phase 1 compatibility no-op. Accepted and compiled for
		 * compatibility, but not used by the decision-loop runtime.
		 */
		requiredFindingIds?: string[];
	};
	stopPolicy: {
		/**
		 * @deprecated Phase 1 compatibility no-op. Synthesize decisions are
		 * governed by the canonical decision validator instead.
		 */
		requireSynthesisAction: boolean;
		failOnInvalidDecision: boolean;
		/**
		 * Maximum progress-aware stall score before the dynamic loop asks the
		 * planner for a bounded replan.
		 */
		maxStalls: number;
		/**
		 * @deprecated Phase 1 compatibility no-op. Dropped-branch enforcement is
		 * deferred; invalid/omitted work is surfaced via blockers/omissions.
		 */
		failOnDroppedRequiredBranch: boolean;
	};
}

export interface CompiledDynamicWorkflowTask {
	uses: string;
	usesPath?: string;
	mode: "graph-splice";
	budget: CompiledDynamicWorkflowBudget;
	permissions: {
		approval: "auto" | "ask";
		allowDynamicRoles: boolean;
		allowDynamicTools: boolean;
	};
	helpers: Record<string, CompiledDynamicWorkflowHelper>;
	workflows: Record<string, CompiledDynamicNestedWorkflow>;
	decisionLoop?: CompiledDynamicDecisionLoop;
	runtimeOverrides?: WorkflowRuntimeDefaults;
	availableModels?: WorkflowModelInfo[];
}

export interface CompiledArtifactGraphTask {
	enabled: true;
	output: {
		analysisRequired: boolean;
		refsRequired: boolean;
		refsMinItems?: number;
		refsUrlValidation?: boolean;
		controlSchema?: string;
		controlSchemaPath?: string;
		maxDigestChars?: number;
		partial?: { paths: string[] };
	};
	requiredReads: ArtifactGraphRequiredRead[];
	requiredReadPolicy?: RequiredWorkflowArtifactReadPolicy[];
	artifactAccess: "enabled" | "none";
	inputPolicy?: {
		terminalBarrier?: "all-sources";
		invalidateOnDependencyResume?: true;
		maxCompiledPromptChars?: number;
	};
	sourceProjection?: {
		include?: string[];
		maxChars?: number;
	};
}

export interface CompiledTask {
	id: string;
	agent: string;
	agentPath: string;
	agentDescription?: string;
	agentSystemPrompt: string;
	systemPromptMode?: string;
	inheritProjectContext?: boolean;
	inheritSkills?: boolean;
	roleNames: string[];
	task: string;
	cwd: string;
	explicitCwd: boolean;
	explicitWorktreePolicy: boolean;
	runtime: CompiledTaskRuntime;
	safety: CompiledTaskSafety;
	outputContract?: string;
	sourceContext?: WorkflowSourceContextSpec;
	compiledPrompt: string;
	kind?: string;
	stageId?: string;
	taskId?: string;
	stageMaxConcurrency?: number;
	dependsOn?: string[];
	contextDependsOn?: string[];
	generation?: number;
	sourceGeneration?: number;
	foreach?: {
		from: unknown;
		prompt: string;
		maxItems?: number;
		/** Profile-only v1 batch metadata; base authored stages cannot set it. */
		batch?: ExecutionProfileForeachBatch;
		itemIdentityPath?: string;
		itemPayloadPath?: string;
		injectRuntimeTask: boolean;
		roleText?: string;
	};
	support?: {
		uses: string;
		options?: Record<string, unknown>;
	};
	dynamic?: CompiledDynamicWorkflowTask;
	dynamicGenerated?: {
		controllerSpecId: string;
		opId: string;
		requestHash: string;
		branchId?: string;
		outputProfile?: string;
	};
	/** Runtime-only synthetic carrier for one transparent foreach batch launch. */
	foreachBatchSynthetic?: {
		schema: "workflow-foreach-batch-v1";
	};
	foreachGenerated?: {
		placeholderSpecId: string;
		itemIdentity?: string;
		itemHash?: string;
		itemSourceTaskId?: string;
		itemSourceSpecId?: string;
		itemSourceKind?: "control" | "partial";
		itemRef?: string;
		sourceLineageDigest?: string;
		resolvedTaskId?: string;
		perItemDispatch?: true;
		batch?: WorkflowForeachBatchGrouping;
	};
	loopChild?: CompiledLoopChildTaskRef;
	loopPlaceholder?: {
		loopId: string;
	};
	loopExhausted?: {
		loopId: string;
		status: LoopResultStatus;
	};
	artifactGraph?: CompiledArtifactGraphTask;
}

export type TaskRunStatus =
	| "pending"
	| "running"
	| "blocked"
	| "completed"
	| "failed"
	| "skipped"
	| "interrupted";
export type WorkflowRunStatus =
	| "running"
	| "blocked"
	| "completed"
	| "failed"
	| "interrupted";

export interface WorkflowTaskUsageValues {
	inputTokens?: number | null;
	outputTokens?: number | null;
	totalTokens?: number | null;
	cachedInputTokens?: number | null;
	cacheCreationInputTokens?: number | null;
	cacheReadInputTokens?: number | null;
	reasoningTokens?: number | null;
	costUsd?: number | null;
}

export interface WorkflowTaskUsageAttemptRecord
	extends WorkflowTaskUsageValues {
	source: string;
	capturedAt: string;
	provider?: string;
	model?: string;
	thinking?: ThinkingLevel | string;
	backendRunId?: string;
	backendAttemptId?: string;
	unavailable?: true;
	raw?: unknown;
}

export interface WorkflowTaskUsageAggregateRecord
	extends WorkflowTaskUsageValues {
	attempts: number;
	incomplete?: boolean;
}

export interface WorkflowTaskUsageRecord extends WorkflowTaskUsageValues {
	source: "pi-subagent";
	capturedAt: string;
	provider?: string;
	model?: string;
	thinking?: ThinkingLevel | string;
	incomplete?: boolean;
	aggregate?: WorkflowTaskUsageAggregateRecord;
	attempts?: WorkflowTaskUsageAttemptRecord[];
}

export type WorkflowToolResultBudgetConfigurationSource =
	| "default"
	| "environment"
	| "disabled";

export interface WorkflowTaskToolResultBudgetAttemptRecord {
	source: string;
	capturedAt: string;
	configuredAt?: string;
	backendRunId?: string;
	backendAttemptId?: string;
	configured?: boolean;
	configurationSource?: WorkflowToolResultBudgetConfigurationSource;
	configuredMaxTotalChars?: number;
	terminal?: true;
	reported?: true;
	enabled?: boolean;
	maxTotalChars?: number;
	warning?: string;
	toolResults?: number;
	retainedChars?: number;
	evictedCount?: number;
	evictedChars?: number;
	evictableCount?: number;
	forcedEvictionApplied?: boolean;
	contextLengthExceeded?: boolean;
	contextOverflowRecovered?: boolean;
	contextRecovered?: boolean;
	unavailable?: true;
}

export interface WorkflowTaskToolResultBudgetConfigurationRecord {
	configuredAt: string;
	configured: boolean;
	configurationSource: WorkflowToolResultBudgetConfigurationSource;
	configuredMaxTotalChars?: number;
}

export interface WorkflowTaskToolResultBudgetAggregateRecord {
	attempts: number;
	terminalAttempts: number;
	pendingAttempts: number;
	reportingAttempts: number;
	unavailableAttempts: number;
	configuredAttempts: number;
	disabledConfigurationAttempts: number;
	backendEnabledAttempts: number;
	backendDisabledAttempts: number;
	evictionCounterExpectedAttempts: number;
	evictionCounterReportingAttempts: number;
	observedEvictedCount: number;
	observedEvictedChars: number;
	evictionAttempts: number;
	warningAttempts: number;
	forcedEvictionAttempts: number;
	contextRecoveryAttempts: number;
	contextRecoveredAttempts: number;
	contextOverflowRecoveredAttempts: number;
	contextLengthExceededAttempts: number;
	configuredMaxTotalChars?: number | null;
	backendMaxTotalChars?: number | null;
	maxToolResults?: number;
	maxRetainedChars?: number;
	maxEvictableCount?: number;
	maxUtilization?: number;
	incomplete?: boolean;
}

export interface WorkflowTaskToolResultBudgetRecord {
	source: "pi-subagent";
	capturedAt: string;
	incomplete?: boolean;
	pendingConfiguration?: WorkflowTaskToolResultBudgetConfigurationRecord;
	aggregate: WorkflowTaskToolResultBudgetAggregateRecord;
	attempts: WorkflowTaskToolResultBudgetAttemptRecord[];
}

export interface WorkflowTaskTimingAttemptRecord {
	source: string;
	capturedAt: string;
	backendRunId?: string;
	backendAttemptId?: string;
	launchQueuedAt?: string;
	launchStartedAt?: string;
	launchCompletedAt?: string;
	launchWaitMs?: number;
	launchDurationMs?: number;
	waiting_for_global_worker_slot?: boolean;
	executionStartedAt?: string;
	executionCompletedAt?: string;
	executionMs?: number | null;
	totalMs?: number;
}

export interface WorkflowTaskTimingAggregateRecord {
	attempts: number;
	launchWaitMs?: number | null;
	launchDurationMs?: number | null;
	executionMs?: number | null;
	totalMs?: number | null;
	incomplete?: boolean;
}

export interface LaunchBootstrapProvenanceRecord {
	schema: "pi-workflow-launch-bootstrap-provenance-v1";
	identitySha256: string;
	workflow: { type: string; specPathSha256: string };
	runId: string;
	task: { taskId: string; specId: string; generation?: number };
	attempt: {
		key: string;
		launchRetry: number;
		outputRetry: number;
		resume: number;
	};
	sessionId?: string;
	backend: { id: string; type: string; mode: string };
	prompt: { sha256: string; bytes: number };
	artifacts?: {
		manifestSha256: string;
		wrapperSha256: string;
		configSha256: string;
	};
	effectiveLaunch: {
		extensions: Array<{
			pathSha256: string;
			generated?: {
				kind: "fetch-cache" | "web-source";
				wrapperSha256: string;
				configSha256: string;
			};
		}>;
		captureToolCalls: boolean;
		toolResultBudgetSha256?: string;
		artifactBinding?: {
			manifestPathSha256: string;
			manifestBytesSha256: string;
			wrapperPathSha256: string;
			wrapperBytesSha256: string;
		};
	};
	effectivePolicy: {
		tools: string[];
		toolProvidersSha256: string;
		model?: string;
		thinking?: string;
		fast?: string;
		approvalMode: string;
		maxRuntimeMs?: number;
		cwdSha256: string;
		stateRootSha256?: string;
		worktree: {
			enabled: boolean;
			pathSha256?: string;
			branchSha256?: string;
			baseCwdSha256?: string;
		};
	};
	sourceDependencies: {
		contextDependsOn: string[];
		sourceProjection?: unknown;
		requiredReads?: unknown;
		requiredReadPolicy?: unknown;
		artifactAccess?: string;
	};
}

export interface LaunchBootstrapProvenanceHistory {
	version: 1;
	records: LaunchBootstrapProvenanceRecord[];
}

export interface WorkflowLaunchAuthorityGrant {
	schema: "pi-workflow-launch-authority-v1";
	identitySha256: string;
	issuer: "pi-workflow-engine";
	operation: "launch-task";
	runId: string;
	task: { taskId: string; specId: string; generation?: number };
	attemptKey: string;
	backendId: string;
	launchBootstrapSha256: string;
}

export interface WorkflowLaunchAuthorityRecord {
	grant: WorkflowLaunchAuthorityGrant;
	state:
		| { phase: "issued" }
		| { phase: "registered" }
		| {
				phase: "consumed";
				backendRunId: string;
				backendAttemptId: string;
			};
}

export interface WorkflowLaunchAuthorityHistory {
	version: 1;
	records: WorkflowLaunchAuthorityRecord[];
}

export interface WorkflowDurableLaunchBarrierDescriptor {
	schema: "pi-subagent-durable-launch-barrier-v1";
	identitySha256: string;
	directory: string;
	readyPath: string;
	releasePath: string;
	ackPath: string;
	challenge: string;
	subjectSha256: string;
	directoryIdentity: { device: number; inode: number; uid?: number };
	timeoutMs: number;
	pollIntervalMs: number;
}

export interface WorkflowDurableLaunchBarrierRecord {
	attemptKey: string;
	launchAuthoritySha256: string;
	descriptor: WorkflowDurableLaunchBarrierDescriptor;
	phase: "created" | "ready" | "consumed" | "released" | "acknowledged";
	readySha256?: string;
	releaseSha256?: string;
	ackSha256?: string;
	backendRunId?: string;
	backendAttemptId?: string;
	releasePayloadSha256?: string;
}

export interface WorkflowDurableLaunchBarrierHistory {
	version: 1;
	records: WorkflowDurableLaunchBarrierRecord[];
}

export interface WorkflowTaskTimingRecord {
	source: "pi-workflow";
	capturedAt: string;
	launchQueuedAt?: string;
	launchStartedAt?: string;
	launchCompletedAt?: string;
	launchWaitMs?: number;
	launchDurationMs?: number;
	waiting_for_global_worker_slot?: boolean;
	launchSlotReleaseDelayMs?: number;
	maxConcurrentLaunches?: number;
	maxLiveModelWorkers?: number;
	experimentalLaunchRampEnabled?: boolean;
	adaptiveLiveModelWorkersEnabled?: boolean;
	adaptiveLiveModelWorkers?: Record<
		string,
		{
			limit: number;
			lastDecision: string;
			baselineMs?: number;
			samples: number;
		}
	>;
	executionStartedAt?: string;
	executionCompletedAt?: string;
	executionMs?: number | null;
	totalMs?: number;
	refreshReconcileMs?: number;
	refreshStatusPollMs?: number;
	terminalOutputCopyMs?: number;
	terminalStderrCopyMs?: number;
	terminalOutputBytes?: number;
	terminalStderrBytes?: number;
	terminalArtifactMaterializeMs?: number;
	terminalArtifactBundleWriteMs?: number;
	aggregate?: WorkflowTaskTimingAggregateRecord;
	attempts?: WorkflowTaskTimingAttemptRecord[];
}

export type WorkflowForeachBatchPhase =
	| "prepared"
	| "launching"
	| "running"
	| "terminal_received"
	| "committing"
	| "completed"
	| "fallback_prepared"
	| "fallback_applied"
	| "stopped"
	| "invalidated"
	| "non_reusable";

/** Per-task ownership marker for an active or archived transparent foreach batch. */
export interface WorkflowForeachBatchTaskState {
	batchId: string;
	role: "leader" | "member";
	phase: WorkflowForeachBatchPhase;
	/** Prevent a malformed/failed batch from being selected again for this item. */
	batchingDisabled?: true;
}

export interface WorkflowForeachBatchMember {
	taskId: string;
	specId: string;
	role: "leader" | "member";
	/** Final singleton prompt prepared before the physical batch launch. */
	preparedPrompt: string;
	preparedPromptSha256: string;
}

/**
 * Durable ownership and terminal-demux journal for one physical max-2 launch.
 * Records are retained after completion/fallback so restart never infers members
 * from list adjacency.
 */
export interface WorkflowForeachBatchRecord {
	version: 1;
	batchId: string;
	placeholderSpecId: string;
	stageId?: string;
	generation?: number;
	sourceGeneration?: number;
	grouping: WorkflowForeachBatchGrouping;
	executionSurfaceSha256: string;
	stateRootSha256?: string;
	capabilitySubjectSha256?: string;
	dispatch?: {
		schema: "workflow-foreach-batch-dispatch-v1";
		state: "reserved" | "terminal_received" | "reconciled" | "non_reusable";
		attemptKey: string;
		reservationSha256: string;
		reservedAt: string;
		terminalReceivedAt?: string;
		reconciledAt?: string;
		reason?: string;
	};
	members: [WorkflowForeachBatchMember, WorkflowForeachBatchMember];
	attempt: number;
	phase: WorkflowForeachBatchPhase;
	preparedAt: string;
	batchPrompt: string;
	batchPromptSha256: string;
	terminal?: {
		receivedAt: string;
		rawPath: string;
		receiptPath: string;
		rawSha256: string;
		backendRunId?: string;
		backendAttemptId?: string;
		status: "completed" | "failed" | "interrupted";
		completedAt?: string;
		startedAt?: string;
		exitCode?: number;
	};
	fallback?: {
		preparedAt: string;
		appliedAt?: string;
		reason: string;
		diagnosticsPath?: string;
	};
	commit?: {
		startedAt: string;
		completedAt?: string;
	};
	/** Physical-call observability; logical members are not double-counted. */
	physicalExecution?: {
		leaderTaskId: string;
		usage?: WorkflowTaskUsageRecord;
		timing?: WorkflowTaskTimingRecord;
	};
}

export interface WorkflowTaskRunRecord {
	taskId: string;
	specId: string;
	displayName: string;
	agent: string;
	agentDescription?: string;
	agentFile: string;
	roles: string[];
	status: TaskRunStatus;
	statusDetail: string;
	runtime: {
		model?: string;
		thinking?: ThinkingLevel;
		thinkingResolution?: WorkflowRuntimeThinkingResolution;
		fast?: FastMode;
		approvalMode: ApprovalMode;
		maxRuntimeMs?: number;
	};
	tools?: string[];
	cwd: string;
	worktree: {
		enabled: boolean;
		path: string | null;
		branch: string | null;
		baseCwd: string | null;
		warning: string | null;
		snapshot?: WorktreeSnapshotRecord;
	};
	backendTaskId: string;
	pid?: number;
	launchToken?: string;
	backendHandle?: WorkflowBackendHandle;
	kind?: string;
	stageId?: string;
	dependsOn?: string[];
	terminalBarrier?: {
		mode: "all-sources";
		sourceSpecIds: string[];
	};
	generation?: number;
	sourceGeneration?: number;
	dispatchMap?: {
		version: 1;
		generation: number;
		sourceTaskId: string;
		entries: Array<{
			itemIdentity: string;
			taskId: string;
			specId: string;
			itemSourceTaskId: string;
			itemSourceSpecId: string;
			itemSourceKind: "control" | "partial";
			itemRef: string;
			itemHash: string;
			perItemDispatch?: true;
		}>;
		digest: string;
	};
	promptMetadata?: {
		version: 1;
		chars: number;
		maxChars?: number;
		measuredAt: string;
	};
	/** Internal persisted launch identity; not a workflow authoring or package API. */
	launchBootstrap?: LaunchBootstrapProvenanceHistory;
	/** Internal host-owned launch grant; not an external authority or public API. */
	launchAuthority?: WorkflowLaunchAuthorityHistory;
	/** General pi-subagent durable launch barrier receipts, retained by attempt. */
	durableLaunchBarrier?: WorkflowDurableLaunchBarrierHistory;
	startedAt?: string;
	completedAt?: string;
	elapsedMs?: number;
	usage?: WorkflowTaskUsageRecord;
	toolResultBudget?: WorkflowTaskToolResultBudgetRecord;
	timing?: WorkflowTaskTimingRecord;
	exitCode?: number;
	files: {
		systemPrompt: string;
		taskPrompt: string;
		output: string;
		stderr: string;
		result: string;
	};
	backendFiles?: Record<string, string>;
	lastMessage?: string;
	outputRetry?: {
		attempts: number;
		maxAttempts?: number;
		reason?: string;
		message?: string;
		artifacts?: string[];
		repairMode?: "same_session" | "new_session";
		sessionId?: string;
	};
	resumeEvents?: WorkflowTaskResumeEvent[];
	artifactGraph?: CompiledArtifactGraphTask;
	dynamicGenerated?: {
		controllerSpecId: string;
		opId: string;
		requestHash: string;
		branchId?: string;
		outputProfile?: string;
	};
	foreachGenerated?: {
		placeholderSpecId: string;
		itemIdentity?: string;
		itemHash?: string;
		itemSourceTaskId?: string;
		itemSourceSpecId?: string;
		itemSourceKind?: "control" | "partial";
		itemRef?: string;
		sourceLineageDigest?: string;
		resolvedTaskId?: string;
		perItemDispatch?: true;
		batch?: WorkflowForeachBatchGrouping;
	};
	/** Internal leader/member ownership for profile-only transparent batching. */
	foreachBatch?: WorkflowForeachBatchTaskState;
	launchRetry?: {
		attempts: number;
		maxAttempts?: number;
		reason?: string;
		message?: string;
		nextEligibleAt?: string;
		retryAfterMs?: number;
	};
}

export interface TaskSummary {
	pending: number;
	running: number;
	blocked: number;
	completed: number;
	failed: number;
	skipped: number;
	interrupted: number;
	total: number;
}

/**
 * Shape of `.pi/workflows/<runId>/supervisor.json` written by the run-lease
 * heartbeat. `lastTaskTransitionAt`/`taskStatusCounts` are progress signals:
 * `updatedAt` proves the supervisor process is alive, while
 * `lastTaskTransitionAt` proves the run is actually making task progress.
 */
export interface WorkflowSupervisorRecord {
	schemaVersion?: number;
	ownerId?: string;
	pid?: number;
	updatedAt?: string;
	lockFile?: string;
	lastTaskTransitionAt?: string;
	taskStatusCounts?: TaskSummary;
}

export interface WorkflowTaskResumeEvent {
	at: string;
	fromStatus: TaskRunStatus;
	fromStatusDetail: string;
	lastMessage?: string;
	outputRetryAttempts?: number;
	outputRetryReason?: string;
	outputRetryRepairMode?: "same_session" | "new_session";
	launchRetryAttempts?: number;
	launchRetryReason?: string;
	backendRunId?: string;
	backendAttemptId?: string;
}

export type WorkflowRouteDecision = "direct" | "dynamic" | "workflow";
export type WorkflowRouteDepth = "quick" | "standard" | "max";

/**
 * Audit record for the opt-in `--route` router pass. Present only on runs
 * started through routing; default runs never carry this field.
 */
export interface WorkflowRunExecutionProfile {
	/** Selected declared profile name. */
	name: string;
	/** Canonical stage-id → complete profile overrides applied at compile time. */
	stageOverrides: Record<string, ExecutionProfileStageOverride>;
}

export interface WorkflowRunRouting {
	requested: string;
	decided: WorkflowRouteDecision;
	depth: WorkflowRouteDepth;
	confidence: number;
	reason: string;
	/** Wall-clock duration of the opt-in router classifier pass in milliseconds. */
	routerElapsedMs?: number;
	routerModel?: string;
	routerThinking?: string;
}

export interface WorkflowRunProvenance {
	mode?: string;
	requestedWorkflow?: string | null;
	specPath?: string | null;
	userSelectedWorkflow?: boolean;
	generatedSpec?: boolean;
	runtimeBundle?: string;
	runtimeVersion?: string;
	[key: string]: unknown;
}

export type WorkflowRunLaunchSource =
	| { kind: "slash-command"; action: "run" | "dynamic" }
	| { kind: "tool"; name: "workflow_run" | "workflow_dynamic" };

export type WorkflowRunLaunchProfile =
	| { kind: "named"; name: string }
	| { kind: "base" }
	| { kind: "not-applicable" };

export type WorkflowRunLaunchCommandMetadata =
	| {
			state: "captured";
			artifact: "launch-command.txt";
			encoding: "utf-8";
			bytes: number;
			sha256: string;
			fidelity: "pi-extension-command-v1";
			sensitivity: "user-input";
			disclosure: "explicit-only";
	  }
	| { state: "unavailable"; reason: "not-a-command" };

/** Structured creation-launch provenance. Exact command text lives in a private sidecar. */
export interface WorkflowRunLaunchMetadata {
	schema: "pi-workflow-run-launch-v1";
	source: WorkflowRunLaunchSource;
	requestKind: "named-workflow" | "direct-dynamic";
	routingMode: "default-on" | "explicit-on" | "off";
	profile: WorkflowRunLaunchProfile;
	task: { characters: number; lines: number };
	command: WorkflowRunLaunchCommandMetadata;
}

/** Non-persisted launch input carried from a launch surface to the engine. */
export interface WorkflowRunLaunchCapture {
	schema: "pi-workflow-run-launch-v1";
	source: WorkflowRunLaunchSource;
	requestKind: "named-workflow" | "direct-dynamic";
	routingMode: "default-on" | "explicit-on" | "off";
	profile: WorkflowRunLaunchProfile;
	task: { characters: number; lines: number };
	command:
		| { state: "captured"; text: string }
		| { state: "unavailable"; reason: "not-a-command" };
}

/**
 * Deterministic claim-support accounting computed after a direct dynamic
 * run's synthesis completes. Fail-open: audit computation errors are recorded
 * as `{ error }` on the run record instead of failing the run.
 */
export interface WorkflowDynamicRunAudit {
	claimsTotal: number;
	claimsWithSources: number;
	claimsWithoutSources: number;
	refsTotal: number;
	uniqueSourceUrls: number;
	sourceRefJoinFailures: number;
	/** Bounded to 24 entries. */
	unsupportedClaimIds: string[];
	/** Which claim-bearing synthesis control arrays were counted. */
	countedClaimKeys: string[];
	synthesisTaskIds: string[];
}

/**
 * Optional degradation metadata computed when a run reaches a terminal
 * "completed" or "failed" status. Present only when the terminal status hides
 * a partial outcome: work was delivered despite task failures (final-stage
 * tasks completed while other tasks failed), or a completed run leaned on
 * degraded helper output. The run `status` enum is intentionally unchanged;
 * consumers that need the distinction read this field.
 */
export interface WorkflowRunDegradation {
	finalOutputRendered: boolean;
	failedTaskIds: string[];
	degradedHelperTaskIds: string[];
	summary: string;
}

export interface WorkflowRunRecord {
	schemaVersion: 1;
	runId: string;
	name?: string;
	description?: string;
	type: WorkflowRunType;
	artifactGraph?: { enabled: true };
	status: WorkflowRunStatus;
	degradation?: WorkflowRunDegradation;
	taskSummary: TaskSummary;
	cwd: string;
	backend: { type: "local-pi"; mode: "headless" };
	failurePolicy?: Required<WorkflowFailurePolicy>;
	parentRunId?: string;
	rootRunId?: string;
	round?: number;
	fanout?: unknown[];
	invalidationJournal?: {
		generation: number;
		idempotencyKey: string;
		sourceTaskIds: string[];
		invalidatedTaskIds: string[];
		artifactState: "pending" | "quarantined";
		status: "prepared" | "applied";
	};
	loopStates?: LoopStateRecord[];
	loopWorktrees?: LoopWorktreeRecord[];
	loopResults?: LoopResultRecord[];
	dynamic?: {
		events: string;
		state: string;
	};
	/** Claim-support audit for direct dynamic runs (fail-open accounting). */
	dynamicAudit?: WorkflowDynamicRunAudit | { error: string };
	createdAt: string;
	updatedAt: string;
	specPath: string;
	provenance?: WorkflowRunProvenance;
	routing?: WorkflowRunRouting;
	executionProfile?: WorkflowRunExecutionProfile;
	launch?: WorkflowRunLaunchMetadata;
	/** Durable transparent foreach batch journals, including terminal receipts. */
	foreachBatches?: WorkflowForeachBatchRecord[];
	/** Task-usage rollup persisted when the run reaches a terminal status. */
	usage?: WorkflowRunUsageRollup;
	tasks: WorkflowTaskRunRecord[];
}

/**
 * Run-level sum of per-task provider-reported usage. Values cover only tasks
 * that reported usage (`tasksReporting`); no cost is ever derived from token
 * counts. Parent-session usage lives in the parent-usage.json sidecar, not
 * here, because the parent session does not own run.json.
 */
export interface WorkflowRunUsageRollup extends WorkflowTaskUsageValues {
	source: "task-rollup";
	capturedAt: string;
	taskCount: number;
	tasksReporting: number;
}

export interface WorkflowIndexRecord {
	schemaVersion: 1;
	updatedAt: string;
	runs: Array<{
		runId: string;
		name?: string;
		type: WorkflowRunType;
		artifactGraph?: { enabled: true };
		status: WorkflowRunStatus;
		degradation?: WorkflowRunDegradation;
		taskSummary: TaskSummary;
		createdAt: string;
		updatedAt: string;
		runJson: string;
		parentRunId?: string;
		rootRunId?: string;
		round?: number;
		fanout?: unknown[];
		/**
		 * Deprecated compatibility projection. New index writes omit task rows;
		 * consumers that need task-level details should load runJson/run.json.
		 */
		tasks?: Array<{
			taskId: string;
			displayName: string;
			agent: string;
			status: TaskRunStatus;
			statusDetail: string;
			lastMessage?: string;
			kind?: string;
			stageId?: string;
			backendHandle?: WorkflowBackendHandle;
		}>;
	}>;
}

export interface WorktreeSnapshotRecord {
	files?: string[];
	hash?: string;
	[key: string]: unknown;
}

export interface CompiledWorkflow {
	schemaVersion: 1;
	name?: string;
	description?: string;
	type: WorkflowRunType;
	task?: string;
	cwd: string;
	backend: { type: "local-pi"; mode: "headless" };
	maxConcurrency: number;
	failurePolicy?: Required<WorkflowFailurePolicy>;
	roles: CompiledRole[];
	tasks: CompiledTask[];
	stages?: Array<Record<string, unknown> | CompiledLoopStageRecord>;
	warnings: string[];
	artifactGraph?: { enabled: true };
}
