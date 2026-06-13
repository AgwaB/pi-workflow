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
export const STAGE_FIRST_RUN_TYPE = "workflow-v1" as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type FastMode = (typeof FAST_MODES)[number];
export type ApprovalMode = (typeof APPROVAL_MODES)[number];
export type WorktreePolicy = (typeof WORKTREE_POLICIES)[number];
export type ToolClassification = (typeof TOOL_CLASSIFICATIONS)[number];
export type CompiledWorkflowType = typeof STAGE_FIRST_RUN_TYPE;

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

export interface WorkflowSpec {
	schemaVersion: 1;
	name?: string;
	description?: string;
	agent?: string;
	readOnly?: boolean;
	tools?: WorkflowToolSpec[];
	model?: string;
	thinking?: ThinkingLevel;
	fast?: FastMode;
	worktreePolicy?: WorktreePolicy;
	input?: unknown;
	catalog?: Record<string, unknown>;
	defaults?: WorkflowDefaults;
	backend?: BackendOptions;
	roles?: Record<string, RoleSpec>;
	outputTemplates?: Record<string, unknown>;
	workflow?: { stages: unknown[] };
	flow?: { type?: unknown };
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
	scope: "project" | "user";
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

export type LoopUntilCondition =
	| { stage: string; path: string; equals: string | number | boolean }
	| { stage: string; path: string; notEquals: string | number | boolean }
	| { stage: string; path: string; lengthEquals: number }
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
	output?: WorkflowTaskOutputSpec;
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
	loopChild?: CompiledLoopChildTaskRef;
	loopPlaceholder?: {
		loopId: string;
	};
	loopExhausted?: {
		loopId: string;
		status: LoopResultStatus;
	};
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
	output?: WorkflowTaskOutputSpec;
	outputValidation?: WorkflowTaskOutputValidationRecord;
	outputRetry?: {
		attempts: number;
		maxAttempts?: number;
		reason?: string;
		message?: string;
		artifacts?: string[];
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

export interface WorkflowRunRecord {
	schemaVersion: 1;
	runId: string;
	name?: string;
	description?: string;
	type: CompiledWorkflowType;
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
	createdAt: string;
	updatedAt: string;
	specPath: string;
	tasks: WorkflowTaskRunRecord[];
}

export interface WorkflowIndexRecord {
	schemaVersion: 1;
	updatedAt: string;
	runs: Array<{
		runId: string;
		name?: string;
		type: CompiledWorkflowType;
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

export type OutputFormat = "text" | "json" | "markdown";
export type OutputOnInvalidAction = "fail" | "warn";

export interface WorkflowStructuredOutputContract {
	requiredPaths?: string[];
	arrays?: Array<{ path: string; minItems?: number; maxItems?: number }>;
	maxStringChars?: Array<{ path: string; maxChars: number }>;
}

export interface WorkflowTaskOutputSpec {
	format: OutputFormat;
	requiredKeys?: string[];
	onInvalid?: OutputOnInvalidAction;
	contract?: WorkflowStructuredOutputContract;
	template?: unknown;
	templateRef?: string;
}

export interface WorkflowTaskOutputValidationRecord {
	format: OutputFormat;
	status: "valid" | "invalid" | "warning";
	message: string;
	structured: boolean;
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
	type: CompiledWorkflowType;
	task?: string;
	cwd: string;
	backend: { type: "local-pi"; mode: "headless" };
	maxConcurrency: number;
	roles: CompiledRole[];
	tasks: CompiledTask[];
	stages?: Array<Record<string, unknown> | CompiledLoopStageRecord>;
	warnings: string[];
}
