import { isAbsolute, relative, resolve } from "node:path";

import { loadAgentByName } from "./agents.js";
import { compileRole } from "./roles.js";
import {
  AgentDefinition,
  ApprovalMode,
  CompiledWorkflow,
  CompiledRole,
  CompiledTask,
  CompiledTaskSafety,
  FastMode,
  WorkflowSpec,
  WorkflowTaskSpec,
  WorkflowValidationError,
  PermissionPreview,
  STAGE_FIRST_RUN_TYPE,
  TaskCapability,
  ThinkingLevel,
  ValidationIssue,
  WorktreePolicy,
} from "./types.js";

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const EXPLICIT_WRITE_TOOLS = new Set(["edit", "write"]);
const MUTATION_CAPABLE_TOOLS = new Set(["bash"]);
const DELEGATION_TOOLS = new Set(["tmux_subagent", "skill_test_subagent", "workflow", "/workflow"]);
const DEFAULT_MAX_RUNTIME_MS = 30 * 60 * 1000;

interface CompileOptions {
  cwd: string;
}

export async function compileWorkflowSpec(spec: WorkflowSpec, options: CompileOptions): Promise<CompiledWorkflow> {
  const issues: ValidationIssue[] = [];
  const warnings: string[] = [];
  const agentCache = new Map<string, AgentDefinition>();
  const projectRoot = resolve(options.cwd);
  const defaultCwd = resolve(projectRoot, spec.defaults?.cwd ?? ".");
  const backendOptions = spec.defaults?.backend ?? spec.backend ?? {};
  const backend = {
    type: "local-pi" as const,
    mode: "tmux" as const,
  };

  validateCwdInsideProject(defaultCwd, projectRoot, "$.defaults.cwd", issues);

  if (backendOptions.type !== undefined && backendOptions.type !== "local-pi") {
    issues.push({ path: "$.backend.type", message: 'must be "local-pi"' });
  }
  if (backendOptions.mode !== undefined && backendOptions.mode !== "auto" && backendOptions.mode !== "tmux") {
    issues.push({ path: "$.backend.mode", message: 'must be "auto" or "tmux" in MVP' });
  }

  const compiledRoles = await compileRoles(spec, options.cwd, agentCache, issues);
  const roleMap = new Map(compiledRoles.map((role) => [role.name, role]));
  const rawTasks = getWorkflowTasks(spec);
  const compiledTasks: CompiledTask[] = [];
  const seenTaskIds = new Set<string>();

  for (const [index, task] of rawTasks.entries()) {
    const taskPath = taskPathFor(spec, index);
    const id = task.id ?? `task-${index + 1}`;

    if (seenTaskIds.has(id)) {
      issues.push({ path: `${taskPath}.id`, message: `duplicate task id "${id}"` });
      continue;
    }
    seenTaskIds.add(id);

    const agent = await getAgent(task.agent, options.cwd, agentCache, issues, `${taskPath}.agent`);
    if (!agent) continue;

    validateAgentRuntime(agent, issues, `${taskPath}.agent`);
    const roleNames = roleNamesFor(task.role);
    for (const roleName of roleNames) {
      if (!roleMap.has(roleName)) {
        issues.push({ path: `${taskPath}.role`, message: `unknown role "${roleName}"` });
      }
    }

    validateToolNames(task.tools, issues, `${taskPath}.tools`);
    validateToolNames(spec.defaults?.tools, issues, "$.defaults.tools");
    validateToolSubset(spec.defaults?.tools, agent, issues, "$.defaults.tools");
    validateToolSubset(task.tools, agent, issues, `${taskPath}.tools`);

    const runtime = resolveRuntime(task, spec, agent);
    const worktreePolicy = task.worktreePolicy ?? spec.defaults?.worktreePolicy ?? "auto";
    const readOnlyDeclared = task.readOnly ?? agent.readOnly ?? false;
    const safety = classifySafety(runtime.tools, readOnlyDeclared, worktreePolicy, runtime.approvalMode);

    if (readOnlyDeclared && runtime.tools?.some((tool) => EXPLICIT_WRITE_TOOLS.has(tool))) {
      issues.push({
        path: `${taskPath}.readOnly`,
        message: "readOnly cannot be true when effective tools include edit or write",
      });
    }

    validateDelegationBoundary(runtime.tools, issues, `${taskPath}.tools`);
    validateFastMode(runtime.model, runtime.fast, issues, `${taskPath}.fast`);

    const selectedRoles = roleNames.map((roleName) => roleMap.get(roleName)).filter((role): role is CompiledRole => Boolean(role));
    const cwd = resolve(projectRoot, task.cwd ?? spec.defaults?.cwd ?? ".");
    if (task.cwd !== undefined) validateCwdInsideProject(cwd, projectRoot, `${taskPath}.cwd`, issues);

    compiledTasks.push({
      id,
      agent: task.agent,
      agentPath: agent.sourcePath,
      agentDescription: agent.description,
      agentSystemPrompt: agent.body,
      systemPromptMode: agent.systemPromptMode,
      inheritProjectContext: agent.inheritProjectContext,
      inheritSkills: agent.inheritSkills,
      roleNames,
      task: task.task,
      cwd,
      explicitCwd: task.cwd !== undefined,
      explicitWorktreePolicy: task.worktreePolicy !== undefined,
      runtime,
      safety,
      outputContract: task.outputContract,
      compiledPrompt: buildCompiledPrompt(task, selectedRoles),
    });
  }

  if (issues.length > 0) throw new WorkflowValidationError(issues);

  return {
    schemaVersion: 1,
    name: spec.name,
    description: spec.description,
    type: spec.flow.type,
    cwd: defaultCwd,
    backend,
    maxConcurrency: spec.defaults?.maxConcurrency ?? 4,
    roles: compiledRoles,
    tasks: compiledTasks,
    warnings,
  };
}

function getWorkflowTasks(spec: WorkflowSpec): WorkflowTaskSpec[] {
  if (spec.flow.type === "single") return [spec.flow.task];
  if (spec.flow.type === "parallel") return spec.flow.tasks;
  return spec.flow.steps;
}

function taskPathFor(spec: WorkflowSpec, index: number): string {
  if (spec.flow.type === "single") return "$.flow.task";
  if (spec.flow.type === "parallel") return `$.flow.tasks[${index}]`;
  return `$.flow.steps[${index}]`;
}

async function compileRoles(
  spec: WorkflowSpec,
  cwd: string,
  agentCache: Map<string, AgentDefinition>,
  issues: ValidationIssue[],
): Promise<CompiledRole[]> {
  const roles = spec.roles ?? {};
  const compiled: CompiledRole[] = [];

  for (const [name, roleSpec] of Object.entries(roles)) {
    const sourceAgent = roleSpec.fromAgent
      ? await getAgent(roleSpec.fromAgent, cwd, agentCache, issues, `$.roles.${jsonKey(name)}.fromAgent`)
      : undefined;

    compiled.push(compileRole(name, roleSpec, sourceAgent));
  }

  return compiled;
}

async function getAgent(
  name: string,
  cwd: string,
  cache: Map<string, AgentDefinition>,
  issues: ValidationIssue[],
  path: string,
): Promise<AgentDefinition | undefined> {
  if (cache.has(name)) return cache.get(name);

  const agent = await loadAgentByName(name, cwd);
  if (!agent) {
    issues.push({ path, message: `unknown agent "${name}"` });
    return undefined;
  }

  cache.set(name, agent);
  for (const alias of agent.aliases) cache.set(alias, agent);
  return agent;
}

function validateAgentRuntime(agent: AgentDefinition, issues: ValidationIssue[], path: string): void {
  if (agent.maxSubagentDepth > 0) {
    issues.push({ path, message: `agent ${agent.displayName} declares maxSubagentDepth > 0, which is invalid in MVP` });
  }

  validateDelegationBoundary(agent.tools, issues, path);
}

function validateToolSubset(
  requestedTools: string[] | undefined,
  agent: AgentDefinition,
  issues: ValidationIssue[],
  path: string,
): void {
  if (!requestedTools) return;
  if (!agent.tools) {
    issues.push({
      path,
      message: `agent ${agent.displayName} does not declare a tools authority ceiling`,
    });
    return;
  }

  const allowed = new Set(agent.tools);
  for (const tool of requestedTools) {
    if (!allowed.has(tool)) {
      issues.push({
        path,
        message: `tool "${tool}" expands agent ${agent.displayName}; allowed tools: ${agent.tools.join(", ")}`,
      });
    }
  }
}

function validateCwdInsideProject(cwd: string, projectRoot: string, path: string, issues: ValidationIssue[]): void {
  const relativePath = relative(projectRoot, cwd);
  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) return;
  issues.push({ path, message: `cwd must stay inside project root: ${projectRoot}` });
}

function validateToolNames(tools: string[] | undefined, issues: ValidationIssue[], path: string): void {
  if (!tools) return;
  for (const [index, tool] of tools.entries()) {
    if (!/^[A-Za-z0-9_.:/-]+$/.test(tool)) {
      issues.push({ path: `${path}[${index}]`, message: `invalid tool name "${tool}"` });
    }
  }
}

function validateDelegationBoundary(tools: string[] | undefined, issues: ValidationIssue[], path: string): void {
  if (!tools) return;
  for (const tool of tools) {
    if (DELEGATION_TOOLS.has(tool)) {
      issues.push({ path, message: `delegation/orchestration tool "${tool}" is invalid in MVP` });
    }
  }
}

function filterDelegationTools(tools: string[] | undefined): string[] | undefined {
  if (!tools) return undefined;
  return tools.filter((tool) => !DELEGATION_TOOLS.has(tool));
}

function validateFastMode(model: string | undefined, fast: FastMode | undefined, issues: ValidationIssue[], path: string): void {
  if (fast !== "on") return;
  if (!model || !/^openai(?:-codex)?\/gpt-5\.[45](?:\b|[-.])/.test(model)) {
    issues.push({ path, message: "fast:on requires an eligible openai/openai-codex GPT-5.4/GPT-5.5 model" });
  }
}

function resolveRuntime(task: WorkflowTaskSpec, spec: WorkflowSpec, agent: AgentDefinition): {
  model?: string;
  thinking?: ThinkingLevel;
  fast?: FastMode;
  approvalMode: ApprovalMode;
  tools?: string[];
  maxRuntimeMs: number;
} {
  return {
    model: task.model ?? spec.defaults?.model ?? agent.model,
    thinking: task.thinking ?? spec.defaults?.thinking ?? agent.thinking,
    fast: task.fast ?? spec.defaults?.fast ?? agent.fast,
    approvalMode: task.approvalMode ?? spec.defaults?.approvalMode ?? agent.approvalMode ?? "non-interactive",
    tools: filterDelegationTools(task.tools ?? spec.defaults?.tools ?? agent.tools),
    maxRuntimeMs: task.maxRuntimeMs ?? spec.defaults?.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS,
  };
}

function classifySafety(
  tools: string[] | undefined,
  readOnlyDeclared: boolean,
  worktreePolicy: WorktreePolicy,
  approvalMode: ApprovalMode,
): CompiledTaskSafety {
  const capability = classifyCapability(tools, readOnlyDeclared);
  const sharedCwdSafe = Boolean(readOnlyDeclared && tools && tools.every((tool) => READ_ONLY_TOOLS.has(tool)));
  const requiresWorktree = worktreePolicy === "on" || (worktreePolicy === "auto" && !sharedCwdSafe);

  return {
    readOnlyDeclared,
    capability,
    sharedCwdSafe,
    worktreePolicy,
    requiresWorktree,
    permission: permissionPreview(tools, capability, approvalMode),
  };
}

function classifyCapability(tools: string[] | undefined, readOnlyDeclared: boolean): TaskCapability {
  if (!tools || tools.length === 0) return "write-capable";
  if (tools.some((tool) => MUTATION_CAPABLE_TOOLS.has(tool) || !READ_ONLY_TOOLS.has(tool) && !EXPLICIT_WRITE_TOOLS.has(tool))) {
    return "mutation-capable";
  }
  if (tools.some((tool) => EXPLICIT_WRITE_TOOLS.has(tool))) return "write-capable";
  return readOnlyDeclared ? "read-only" : "write-capable";
}

function permissionPreview(
  tools: string[] | undefined,
  capability: TaskCapability,
  approvalMode: ApprovalMode,
): PermissionPreview {
  if (!tools || tools.length === 0) {
    return {
      status: "blocked",
      statusDetail: "needs_attention",
      reason: "effective tools are unspecified; background permission surface is unknown",
    };
  }

  const unknownTools = tools.filter((tool) => !READ_ONLY_TOOLS.has(tool) && !EXPLICIT_WRITE_TOOLS.has(tool) && !MUTATION_CAPABLE_TOOLS.has(tool));
  if (unknownTools.length > 0) {
    return {
      status: "blocked",
      statusDetail: "needs_attention",
      reason: `unknown/custom tools require explicit review: ${unknownTools.join(", ")}`,
    };
  }

  if (approvalMode === "on-request" && capability !== "read-only") {
    return {
      status: "blocked",
      statusDetail: "pending_approval",
      reason: "mutation-capable background task uses on-request approval mode",
    };
  }

  return { status: "pending" };
}

function roleNamesFor(role: string | string[] | undefined): string[] {
  if (role === undefined) return [];
  return Array.isArray(role) ? role : [role];
}

function buildCompiledPrompt(task: WorkflowTaskSpec, roles: CompiledRole[]): string {
  const parts = ["# Flow Task", task.task.trim()];

  if (roles.length > 0) {
    parts.push("# Role Context");
    for (const role of roles) {
      parts.push(`## Role: ${role.name}\n${role.content}`.trim());
    }
  }

  if (task.outputContract?.trim()) {
    parts.push("# Output Contract", task.outputContract.trim());
  }

  parts.push(
    "# Constraints",
    "- Use only the task prompt and files you inspect.\n- Do not assume parent conversation history.\n- Do not launch other agents unless explicitly instructed.",
  );

  return parts.join("\n\n");
}

function jsonKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}



export async function compileWorkflow(spec: any, options: CompileOptions & { task?: string; runtimeDefaults?: { model?: string; thinking?: ThinkingLevel } }): Promise<any> {
  const stages = spec.workflow?.stages ?? spec.flow?.stages;
  if (!Array.isArray(stages)) return compileWorkflowSpec(spec, options);

  const agentName = spec.agent ?? spec.defaults?.agent ?? "scout";
  const agentCache = new Map<string, AgentDefinition>();
  const defaultAgent = await loadStageFirstAgent(agentName, options.cwd, agentCache, "$.agent");
  const roleEntries = Object.entries(spec.roles ?? {});
  const roles = roleEntries.map(([name, role]: [string, any]) => ({
    name,
    fromAgent: role.fromAgent,
    content: role.prompt ?? "",
    maxChars: role.maxChars ?? 8000,
    truncated: false,
    includedSections: [],
    excludedSections: [],
  }));
  const roleText = roles.length ? `# Role Context\n\n${roles.map((r) => `## Role: ${r.name}\n${r.content}`).join("\n\n")}` : "";
  const defaultModel = options.runtimeDefaults?.model ?? spec.defaults?.model ?? spec.model;
  const defaultThinking = options.runtimeDefaults?.thinking ?? spec.defaults?.thinking ?? spec.thinking;
  const tasks: any[] = [];
  const stageRecords: any[] = [];
  let previousStageTaskKeys: string[] = [];
  const stageTaskKeys = new Map<string, string[]>();

  const buildTask = async (stage: any, taskId: string, prompt: string, dependencyKeys: string[], overrides: (Partial<CompiledTask> & Record<string, unknown>) = {}): Promise<any> => {
    const stageAgentName = stage.agent ?? agentName;
    const stageAgent = stageAgentName === agentName ? defaultAgent : await loadStageFirstAgent(stageAgentName, options.cwd, agentCache, `$.workflow.stages.${stage.id}.agent`);
    const stageInject = stage.inject;
    const defaultInject = stage.type === "task";
    const injectTask = stageInject ?? defaultInject;
    const injectRuntimeTaskInPrompt = stage.type === "foreach" ? false : injectTask;
    const key = `${stage.id}.${taskId}`;
    const normalizedPrompt = String(prompt ?? "").replace(/\$\{item\}/g, "the relevant item from the dependency context");
    const compiledPrompt = [
      injectRuntimeTaskInPrompt && options.task ? `# Task\n\n${options.task}` : undefined,
      `# Workflow Stage\n\nstage=${stage.id}\ntype=${stage.type}`,
      `# Instructions\n\n${normalizedPrompt}`,
      roleText || undefined,
    ].filter(Boolean).join("\n\n");
    const runtime = {
      approvalMode: stage.approvalMode ?? spec.defaults?.approvalMode ?? "non-interactive",
      model: stage.model ?? defaultModel,
      thinking: stage.thinking ?? defaultThinking,
      tools: stage.tools ?? spec.defaults?.tools ?? spec.tools ?? stageAgent.tools,
      maxRuntimeMs: stage.maxRuntimeMs ?? spec.defaults?.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS,
    };
    const readOnlyDeclared = stage.readOnly ?? spec.defaults?.readOnly ?? spec.readOnly ?? stageAgent.readOnly ?? false;
    const worktreePolicy = stage.worktreePolicy ?? spec.defaults?.worktreePolicy ?? spec.worktreePolicy ?? "auto";
    const safety = classifySafety(runtime.tools, readOnlyDeclared, worktreePolicy, runtime.approvalMode);

    return {
      key,
      id: key,
      specId: key,
      taskId,
      stageId: stage.id,
      agent: stageAgentName,
      agentPath: stageAgent.sourcePath,
      agentDescription: stageAgent.description,
      agentSystemPrompt: stageAgent.body,
      systemPromptMode: stageAgent.systemPromptMode,
      inheritProjectContext: stageAgent.inheritProjectContext,
      inheritSkills: stageAgent.inheritSkills,
      roleNames: roles.map((r) => r.name),
      task: normalizedPrompt,
      cwd: options.cwd,
      explicitCwd: stage.cwd !== undefined,
      explicitWorktreePolicy: stage.worktreePolicy !== undefined,
      runtime,
      safety,
      output: stage.output,
      outputContract: stage.outputContract,
      compiledPrompt,
      injectTask,
      kind: stage.type,
      stageMaxConcurrency: stage.maxConcurrency,
      dependsOn: [...dependencyKeys],
      foreach: stage.type === "foreach" ? {
        from: stage.from,
        prompt: String(stage.each?.prompt ?? stage.prompt ?? ""),
        maxItems: stage.maxItems,
        injectRuntimeTask: injectTask,
        roleText,
      } : undefined,
      ...overrides,
    };
  };

  for (const stage of stages) {
    const currentStageTaskKeys: string[] = [];
    const explicitDependencyKeys = dependencyKeysForStage(stage, stageTaskKeys);
    const dependencyKeys = explicitDependencyKeys.length > 0 ? explicitDependencyKeys : previousStageTaskKeys;

    if (stage.type === "loop") {
      const placeholderKey = `${stage.id}.loop`;
      const loopTemplates = await compileLoopChildTemplates(stage, buildTask);
      stageRecords.push({
        id: stage.id,
        type: "loop",
        sourcePolicy: stage.sourcePolicy ?? "require-success",
        maxRounds: stage.maxRounds,
        until: stage.until,
        childStageIds: loopTemplates.childStageIds,
        childTemplates: loopTemplates.childTemplates,
        childStageRecords: loopTemplates.childStageRecords,
        onExhausted: loopTemplates.onExhausted,
        progressPath: stage.progressPath ?? stage.progress?.path,
        progressStageId: stage.progressStageId ?? stage.progress?.stage,
      });
      tasks.push(await buildTask(stage, "loop", stage.prompt ?? "Loop controller placeholder.", dependencyKeys, {
        key: placeholderKey,
        id: placeholderKey,
        specId: placeholderKey,
        taskId: "loop",
        kind: "loop",
        loopPlaceholder: { loopId: stage.id },
        foreach: undefined,
        safety: { readOnlyDeclared: true, capability: "read-only", sharedCwdSafe: true, worktreePolicy: "off", requiresWorktree: false, permission: { status: "pending" } },
        compiledPrompt: [
          `# Workflow Stage\n\nstage=${stage.id}\ntype=loop`,
          "# Instructions\n\nLoop controller placeholder. Child stages are materialized by the workflow engine at runtime.",
          roleText || undefined,
        ].filter(Boolean).join("\n\n"),
      }));
      currentStageTaskKeys.push(placeholderKey);
      previousStageTaskKeys = currentStageTaskKeys;
      stageTaskKeys.set(stage.id, currentStageTaskKeys);
      continue;
    }

    stageRecords.push({ id: stage.id, type: stage.type, sourcePolicy: stage.sourcePolicy ?? "require-success" });
    const addTask = async (taskId: string, prompt: string) => {
      const task = await buildTask(stage, taskId, prompt, dependencyKeys);
      tasks.push(task);
      currentStageTaskKeys.push(task.id);
    };
    if (stage.type === "parallel" && Array.isArray(stage.tasks)) {
      for (const item of stage.tasks) await addTask(item.id ?? `item-${tasks.length + 1}`, item.prompt ?? "");
    } else if (stage.type === "foreach") {
      await addTask("item", stage.each?.prompt ?? stage.prompt ?? "");
    } else {
      await addTask("main", stage.prompt ?? "");
    }
    previousStageTaskKeys = currentStageTaskKeys;
    stageTaskKeys.set(stage.id, currentStageTaskKeys);
  }
  return {
    schemaVersion: 1,
    name: spec.name,
    description: spec.description,
    type: STAGE_FIRST_RUN_TYPE,
    task: options.task,
    cwd: options.cwd,
    backend: { type: "local-pi", mode: "tmux" },
    maxConcurrency: spec.defaults?.maxConcurrency ?? 4,
    roles,
    stages: stageRecords,
    tasks,
    warnings: [],
    budget: { models: defaultModel ? [{ model: defaultModel }] : [], unratedModels: [] },
  };
}

async function loadStageFirstAgent(
  name: string,
  cwd: string,
  cache: Map<string, AgentDefinition>,
  path: string,
): Promise<AgentDefinition> {
  const cached = cache.get(name);
  if (cached) return cached;
  const agent = await loadAgentByName(name, cwd).catch(() => undefined);
  if (!agent) throw new WorkflowValidationError([{ path, message: `unknown agent "${name}"` }]);
  cache.set(name, agent);
  for (const alias of agent.aliases) cache.set(alias, agent);
  return agent;
}

async function compileLoopChildTemplates(
  loopStage: any,
  buildTask: (stage: any, taskId: string, prompt: string, dependencyKeys: string[], overrides?: Partial<CompiledTask> & Record<string, unknown>) => Promise<any>,
): Promise<{
  childStageIds: string[];
  childTemplates: any[];
  childStageRecords: Array<{ id: string; type?: string; sourcePolicy?: string }>;
  onExhausted?: { stageId: string; template: any };
}> {
  const childStageIds: string[] = [];
  const childTemplates: any[] = [];
  const childStageRecords: Array<{ id: string; type?: string; sourcePolicy?: string }> = [];
  let previousChildTaskKeys: string[] = [];
  const childTaskKeys = new Map<string, string[]>();

  for (const childStage of loopStage.stages ?? []) {
    childStageIds.push(childStage.id);
    childStageRecords.push({ id: childStage.id, type: childStage.type, sourcePolicy: childStage.sourcePolicy ?? "require-success" });
    const currentChildTaskKeys: string[] = [];
    const explicitDependencyKeys = dependencyKeysForStage(childStage, childTaskKeys);
    const dependencyKeys = explicitDependencyKeys.length > 0 ? explicitDependencyKeys : previousChildTaskKeys;
    const addChildTask = async (taskId: string, prompt: string) => {
      const template = await buildTask(childStage, taskId, prompt, dependencyKeys);
      childTemplates.push(template);
      currentChildTaskKeys.push(template.id);
    };

    if (childStage.type === "parallel" && Array.isArray(childStage.tasks)) {
      for (const item of childStage.tasks) await addChildTask(item.id ?? `item-${childTemplates.length + 1}`, item.prompt ?? "");
    } else {
      await addChildTask("main", childStage.prompt ?? "");
    }

    previousChildTaskKeys = currentChildTaskKeys;
    childTaskKeys.set(childStage.id, currentChildTaskKeys);
  }

  const onExhaustedStage = loopStage.onExhausted;
  const onExhausted = onExhaustedStage
    ? {
        stageId: onExhaustedStage.id ?? "onExhausted",
        template: await buildTask(onExhaustedStage, "main", onExhaustedStage.prompt ?? "", []),
      }
    : undefined;

  return { childStageIds, childTemplates, childStageRecords, onExhausted };
}

function dependencyKeysForStage(stage: any, stageTaskKeys: Map<string, string[]>): string[] {
  const from = stage.from;
  if (!from) return [];
  const stageIds = Array.isArray(from)
    ? from
    : typeof from === "string"
      ? [from]
      : typeof from.stage === "string"
        ? [from.stage]
        : [];
  const keys: string[] = [];
  for (const stageId of stageIds) keys.push(...(stageTaskKeys.get(stageId) ?? []));
  return keys;
}
