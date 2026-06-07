export { discoverAgents, loadAgentByName, parseAgentMarkdown } from "./agents.js";
export { compileWorkflowRecipe } from "./compiler.js";
export { continueWorkflow, runWorkflowRecipe, waitForWorkflowRun } from "./engine.js";
export { listWorkflowRecipes, recommendWorkflowRecipes, resolveWorkflowRecipeRef } from "./recipes.js";
export type { WorkflowRecipeCatalogMetadata, WorkflowRecipeRecommendation, WorkflowRecipeRecord } from "./recipes.js";
export { compileRole, extractMarkdownSections } from "./roles.js";
export { loadWorkflowRecipe, parseWorkflowRecipe } from "./schema.js";
export type {
  AgentDefinition,
  ApprovalMode,
  BackendOptions,
  BudgetOnExceedAction,
  CompiledBudgetEstimate,
  CompiledBudgetModelEstimate,
  CompiledStageFirstWorkflow,
  CompiledStageFirstWorkflowStage,
  CompiledStageFirstWorkflowTask,
  CompiledStageFirstWorkflowTaskRuntime,
  CompiledRole,
  CompiledTask,
  CompiledTaskOutput,
  FastMode,
  WorkflowBudgetRateSpec,
  WorkflowBudgetSpec,
  WorkflowContinuationRecord,
  WorkflowContinuationStatus,
  WorkflowRecipe,
  WorkflowRunType,
  StageFirstContinuationMode,
  StageFirstContinuationSpec,
  StageFirstFromMode,
  StageFirstFromSpec,
  StageFirstOnInvalidGeneratedSpecAction,
  StageFirstSourcePolicy,
  StageFirstStageSpec,
  StageFirstStageType,
  StageFirstTaskItemSpec,
  StageFirstToolCapability,
  StageFirstToolDefinitionSpec,
  WorkflowTaskOutputSpec,
  WorkflowTaskOutputValidationRecord,
  WorkflowRuntimeTaskRecord,
  OutputFormat,
  OutputOnInvalidAction,
  RoleSpec,
  TaskCapability,
  ThinkingLevel,
  WorktreePolicy,
} from "./types.js";
export { WorkflowValidationError, STAGE_FIRST_RUN_TYPE } from "./types.js";

export const WORKFLOW_COMMAND = "workflow";

export const WORKFLOW_HELP = `pi-workflow

User command:
  /workflow                         Open the workflow board
  /workflow <workflow_run_id>           Open the board focused on one run
  /workflow help                    Show this help

Inside the board:
  ←/→ column · ↑/↓ move · [/]/n/p run · Enter agent detail · r refresh · q/Esc close

Agent-facing/internal subcommands remain available for orchestration and debugging:
  /workflow validate <recipe.json|yaml|recipe-name>
  /workflow roles <recipe.json|yaml|recipe-name>
  /workflow agents
  /workflow recipe list
  /workflow recipe show <recipe-name>
  /workflow recommend "<natural-language request>"
  /workflow run <recipe-name|recipe.json|yaml> "<task>"
  /workflow delegate <agent> <task>
  /workflow status [run-id]
  /workflow show <run-id>
  /workflow view [run-id]
  /workflow logs <run-id> [task-id] [lines]
  /workflow continue <run-id>
  /workflow wait <run-id> [timeout-ms]

Status:
  Implemented JSON/YAML/recipe validation, recipe listing, role preview, agent listing, task/parallel/foreach/reduce recipe stages with linked continuation child runs and /workflow continue approval,
  maxConcurrency scheduling, timeout reconciliation, budget/fan-out warnings and static token/cost estimates, configurable output formats/JSON validation,
  managed worktrees, context passing, workflow-local artifacts, board/status/show/logs/wait, and dogfood E2E scenarios.
`;
