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

export interface ArtifactGraphWorkflowSpec {
	schemaVersion: 1;
	name?: string;
	description?: string;
	input?: unknown;
	defaults?: WorkflowDefaults;
	roles?: Record<string, RoleSpec>;
	artifactGraph: {
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
	from?: string | string[] | { source: string; path: string };
	after?: string | string[];
	sourcePolicy?: "success" | "partial" | "require-success";
	sourceProjection?: {
		include?: string[];
		maxChars?: number;
	};
	inputPolicy?: {
		requiredReads?: string[];
		enforcement?: "fail";
	};
	output?: {
		controlSchema?: string;
		analysis?: { required?: boolean };
		refs?: { required?: boolean; minItems?: number };
		maxDigestChars?: number;
	};
	each?: Record<string, unknown>;
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
	};
	requiredReads: string[];
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
	foreach?: {
		from: unknown;
		prompt: string;
		maxItems?: number;
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
	startedAt?: string;
	completedAt?: string;
	elapsedMs?: number;
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
	launchRetry?: {
		attempts: number;
		maxAttempts?: number;
		reason?: string;
		message?: string;
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

export interface WorkflowRunRecord {
	schemaVersion: 1;
	runId: string;
	name?: string;
	description?: string;
	type: WorkflowRunType;
	artifactGraph?: { enabled: true };
	status: WorkflowRunStatus;
	taskSummary: TaskSummary;
	cwd: string;
	backend: { type: "local-pi"; mode: "headless" };
	parentRunId?: string;
	rootRunId?: string;
	round?: number;
	fanout?: unknown[];
	loopStates?: LoopStateRecord[];
	loopWorktrees?: LoopWorktreeRecord[];
	loopResults?: LoopResultRecord[];
	dynamic?: {
		events: string;
		state: string;
	};
	createdAt: string;
	updatedAt: string;
	specPath: string;
	provenance?: WorkflowRunProvenance;
	tasks: WorkflowTaskRunRecord[];
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
		taskSummary: TaskSummary;
		createdAt: string;
		updatedAt: string;
		runJson: string;
		parentRunId?: string;
		rootRunId?: string;
		round?: number;
		fanout?: unknown[];
		tasks: Array<{
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

export interface WorkflowStructuredOutputContract {
	requiredPaths?: string[];
	arrays?: Array<{ path: string; minItems?: number; maxItems?: number }>;
	maxStringChars?: Array<{ path: string; maxChars: number }>;
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
	roles: CompiledRole[];
	tasks: CompiledTask[];
	stages?: Array<Record<string, unknown> | CompiledLoopStageRecord>;
	warnings: string[];
	artifactGraph?: { enabled: true };
}
