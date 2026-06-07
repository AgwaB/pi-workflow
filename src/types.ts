export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export const FAST_MODES = ["inherit", "on", "off"] as const;
export const APPROVAL_MODES = ["non-interactive", "on-request"] as const;
export const WORKTREE_POLICIES = ["auto", "on", "off"] as const;
export const WORKFLOW_TYPES = ["single", "parallel", "chain", "dag", "tree", "retry"] as const;
export const STAGE_FIRST_RUN_TYPE = "workflow-v1" as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type FastMode = (typeof FAST_MODES)[number];
export type ApprovalMode = (typeof APPROVAL_MODES)[number];
export type WorktreePolicy = (typeof WORKTREE_POLICIES)[number];
export type WorkflowType = (typeof WORKFLOW_TYPES)[number];

export interface BackendOptions {
  type?: "local-pi";
  mode?: "auto" | "tmux" | "headless";
}

export interface WorkflowDefaults {
  cwd?: string;
  model?: string;
  thinking?: ThinkingLevel;
  fast?: FastMode;
  approvalMode?: ApprovalMode;
  tools?: string[];
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

export interface WorkflowTaskSpec {
  id?: string;
  agent: string;
  role?: string | string[];
  task: string;
  cwd?: string;
  model?: string;
  thinking?: ThinkingLevel;
  fast?: FastMode;
  approvalMode?: ApprovalMode;
  tools?: string[];
  readOnly?: boolean;
  worktreePolicy?: WorktreePolicy;
  maxRuntimeMs?: number;
  output?: WorkflowTaskOutputSpec;
  outputContract?: string;
}

export interface WorkflowMapItemSpec {
  id?: string;
  task: string;
}

export type WorkflowBody =
  | { type: "single"; task: WorkflowTaskSpec }
  | { type: "parallel"; tasks: WorkflowTaskSpec[] }
  | { type: "chain"; steps: WorkflowTaskSpec[] };

export interface WorkflowSpec {
  schemaVersion: 1;
  name?: string;
  description?: string;
  defaults?: WorkflowDefaults;
  backend?: BackendOptions;
  roles?: Record<string, RoleSpec>;
  flow: WorkflowBody;
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

export type TaskCapability = "read-only" | "write-capable" | "mutation-capable";

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
  compiledPrompt: string;
  kind?: string;
  dependsOn?: string[];
}

export type TaskRunStatus = "pending" | "running" | "blocked" | "completed" | "failed" | "skipped" | "interrupted";
export type WorkflowRunStatus = "running" | "blocked" | "completed" | "failed" | "interrupted";

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
  paneId?: string;
  pid?: number;
  launchToken?: string;
  backendHandle?: string;
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
    requiredKeys?: string[];
    artifacts?: string[];
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
  type: WorkflowType;
  status: WorkflowRunStatus;
  taskSummary: TaskSummary;
  cwd: string;
  backend: { type: "local-pi"; mode: "tmux" };
  parentRunId?: string;
  rootRunId?: string;
  round?: number;
  continuation?: WorkflowContinuationRecord;
  fanout?: unknown[];
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
    type: WorkflowType;
    status: WorkflowRunStatus;
    taskSummary: TaskSummary;
    createdAt: string;
    updatedAt: string;
    runJson: string;
    parentRunId?: string;
    rootRunId?: string;
    round?: number;
    continuation?: WorkflowContinuationRecord;
    fanout?: unknown[];
    tasks: Array<{
      taskId: string;
      displayName: string;
      agent: string;
      status: TaskRunStatus;
      statusDetail: string;
      paneId?: string;
      lastMessage?: string;
      kind?: string;
      stageId?: string;
      backendHandle?: string;
    }>;
  }>;
}

export type OutputFormat = "text" | "json" | "markdown";
export type OutputOnInvalidAction = "fail" | "warn";

export interface WorkflowTaskOutputSpec {
  format: OutputFormat;
  requiredKeys?: string[];
  onInvalid?: OutputOnInvalidAction;
}

export interface WorkflowTaskOutputValidationRecord {
  format: OutputFormat;
  status: "valid" | "invalid" | "warning";
  message: string;
  structured: boolean;
}

export interface WorkflowContinuationRecord {
  status?: string;
  mode?: string;
  [key: string]: unknown;
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
  type: WorkflowType;
  cwd: string;
  backend: { type: "local-pi"; mode: "tmux" };
  maxConcurrency: number;
  roles: CompiledRole[];
  tasks: CompiledTask[];
  warnings: string[];
}
