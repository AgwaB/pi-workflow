export { discoverAgents, loadAgentByName, parseAgentMarkdown } from "./agents.js";
export { compileFlowSpec } from "./compiler.js";
export { formatLogs, formatRunDetails, formatRunStatus, formatStatus, refreshRun, resumeSupervisors, runFlowSpec, waitForRun } from "./engine.js";
export { listFlowRecipes, resolveFlowSpecRef } from "./recipes.js";
export type { FlowRecipeRecord, ResolvedFlowSpecRef } from "./recipes.js";
export { compileRole, extractMarkdownSections } from "./roles.js";
export { loadFlowSpec, parseFlowSpec } from "./schema.js";
export type {
  AgentDefinition,
  ApprovalMode,
  BackendOptions,
  CompiledFlow,
  CompiledRole,
  CompiledTask,
  FastMode,
  FlowDefaults,
  FlowSpec,
  FlowTaskSpec,
  FlowType,
  RoleSpec,
  TaskCapability,
  ThinkingLevel,
  WorktreePolicy,
} from "./types.js";
export { FlowValidationError } from "./types.js";

export const FLOW_COMMAND = "flow";
export const WORKFLOW_COMMAND = "workflow";

export const FLOW_HELP = `pi-subagent-flow

Usage:
  /flow help
  /flow validate <spec.json>
  /flow roles <spec.json>
  /flow agents
  /flow run <spec.json>
  /flow status [run-id]
  /flow show <run-id>
  /flow logs <run-id> [task-id] [lines]
  /flow wait <run-id> [timeout-ms]
`;

export const WORKFLOW_HELP = FLOW_HELP;
