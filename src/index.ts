export { discoverAgents, loadAgentByName, parseAgentMarkdown } from "./agents.js";
export { compileWorkflow, compileWorkflowSpec } from "./compiler.js";
export { formatLogs, formatRunDetails, formatRunStatus, formatStatus, refreshRun, resumeRun, resumeSupervisors, runWorkflow, runWorkflowSpec, waitForRun } from "./engine.js";
export type { ResumeRunSummary } from "./engine.js";
export { listWorkflows, recommendWorkflows, resolveWorkflowRef } from "./workflow-specs.js";
export type { ResolvedWorkflowSpecRef, WorkflowRecommendation, WorkflowSpecRecord } from "./workflow-specs.js";
export { compileRole, extractMarkdownSections } from "./roles.js";
export { loadWorkflow, loadWorkflowSpec, parseWorkflow, parseWorkflowSpec } from "./schema.js";
export type {
  AgentDefinition,
  ApprovalMode,
  BackendOptions,
  CompiledWorkflow,
  CompiledRole,
  CompiledTask,
  FastMode,
  WorkflowDefaults,
  WorkflowSpec,
  WorkflowTaskSpec,
  WorkflowType,
  RoleSpec,
  TaskCapability,
  ThinkingLevel,
  WorktreePolicy,
} from "./types.js";
export { WorkflowValidationError } from "./types.js";

export const WORKFLOW_COMMAND = "workflow";

export const WORKFLOW_HELP = `pi-workflow

Usage:
  /workflow help
  /workflow validate <workflow-name-or-path>
  /workflow roles <workflow-name-or-path>
  /workflow agents
  /workflow list
  /workflow recommend "<request>"
  /workflow run <workflow-name-or-path> "<task>"
  /workflow status [run-id]
  /workflow show <run-id-or-workflow-name>
  /workflow logs <run-id> [task-id] [lines]
  /workflow wait <run-id> [timeout-ms]
  /workflow resume <run-id>
`;
