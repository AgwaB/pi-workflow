import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import {
  APPROVAL_MODES,
  FAST_MODES,
  WORKFLOW_TYPES,
  WorkflowMapItemSpec,
  WorkflowSpec,
  WorkflowTaskSpec,
  WorkflowValidationError,
  THINKING_LEVELS,
  ValidationIssue,
  WORKTREE_POLICIES,
} from "./types.js";
import { ResolvedWorkflowSpecRef, resolveWorkflowRef } from "./workflow-specs.js";
import { parseYamlSubset } from "./yaml.js";

const TOP_LEVEL_KEYS = new Set(["schemaVersion", "name", "description", "defaults", "backend", "roles", "flow"]);
const MAX_CONCURRENCY = 16;
const MAX_RUNTIME_MS = 86_400_000;
const DEFAULT_KEYS = new Set([
  "cwd",
  "model",
  "thinking",
  "fast",
  "approvalMode",
  "tools",
  "worktreePolicy",
  "maxConcurrency",
  "maxRuntimeMs",
  "backend",
]);
const BACKEND_KEYS = new Set(["type", "mode"]);
const ROLE_KEYS = new Set(["fromAgent", "prompt", "includeSections", "excludeSections", "maxChars"]);
const TASK_KEYS = new Set([
  "id",
  "agent",
  "role",
  "task",
  "cwd",
  "model",
  "thinking",
  "fast",
  "approvalMode",
  "tools",
  "readOnly",
  "worktreePolicy",
  "outputContract",
  "maxRuntimeMs",
  "dependsOn",
]);
const WORKFLOW_SINGLE_KEYS = new Set(["type", "task"]);
const WORKFLOW_PARALLEL_KEYS = new Set(["type", "tasks", "aggregate"]);
const WORKFLOW_CHAIN_KEYS = new Set(["type", "steps"]);
const WORKFLOW_DAG_KEYS = new Set(["type", "tasks"]);
const WORKFLOW_MAP_KEYS = new Set(["type", "items", "task", "aggregate"]);
const MAP_ITEM_KEYS = new Set(["id", "input"]);

export interface LoadedWorkflowSpec extends ResolvedWorkflowSpecRef {
  spec: WorkflowSpec;
}

export async function loadWorkflowSpec(specRef: string, cwd: string): Promise<LoadedWorkflowSpec> {
  const resolved = await resolveWorkflowRef(specRef, cwd);
  let parsed: unknown;

  try {
    parsed = parseSpecText(await readFile(resolved.specPath, "utf8"), resolved.specPath);
  } catch (error) {
    if (error instanceof WorkflowValidationError) throw error;
    throw new WorkflowValidationError([
      {
        path: specRef,
        message: error instanceof Error ? error.message : String(error),
      },
    ]);
  }

  return {
    ...resolved,
    spec: parseWorkflowSpecCompat(parsed),
  };
}

function parseSpecText(text: string, specPath: string): unknown {
  const extension = extname(specPath).toLowerCase();
  if (extension === ".yaml" || extension === ".yml") return parseYamlSubset(text, specPath);
  return JSON.parse(text);
}

export function parseWorkflowSpec(value: unknown): WorkflowSpec {
  const issues: ValidationIssue[] = [];
  const root = objectAt(value, "$", issues);

  if (root) {
    rejectUnknownKeys(root, TOP_LEVEL_KEYS, "$", issues);

    if (root.schemaVersion !== 1) {
      issues.push({ path: "$.schemaVersion", message: "must be exactly 1" });
    }

    optionalString(root, "name", "$.name", issues);
    optionalString(root, "description", "$.description", issues);

    if (root.backend !== undefined) parseBackend(root.backend, "$.backend", issues);
    if (root.defaults !== undefined) parseDefaults(root.defaults, "$.defaults", issues);
    if (root.roles !== undefined) parseRoles(root.roles, "$.roles", issues);
    parseWorkflowBody(root.flow, "$.flow", issues);
  }

  if (issues.length > 0) throw new WorkflowValidationError(issues);
  return value as WorkflowSpec;
}

function parseDefaults(value: unknown, path: string, issues: ValidationIssue[]): void {
  const defaults = objectAt(value, path, issues);
  if (!defaults) return;

  rejectUnknownKeys(defaults, DEFAULT_KEYS, path, issues);
  optionalString(defaults, "cwd", `${path}.cwd`, issues);
  optionalString(defaults, "model", `${path}.model`, issues);
  optionalEnum(defaults, "thinking", THINKING_LEVELS, `${path}.thinking`, issues);
  optionalEnum(defaults, "fast", FAST_MODES, `${path}.fast`, issues);
  optionalEnum(defaults, "approvalMode", APPROVAL_MODES, `${path}.approvalMode`, issues);
  optionalStringArray(defaults, "tools", `${path}.tools`, issues);
  optionalEnum(defaults, "worktreePolicy", WORKTREE_POLICIES, `${path}.worktreePolicy`, issues);

  if (defaults.maxConcurrency !== undefined) {
    const maxConcurrency = defaults.maxConcurrency;
    if (typeof maxConcurrency !== "number" || !Number.isInteger(maxConcurrency) || maxConcurrency <= 0) {
      issues.push({ path: `${path}.maxConcurrency`, message: "must be a positive integer" });
    } else if (maxConcurrency > MAX_CONCURRENCY) {
      issues.push({ path: `${path}.maxConcurrency`, message: `must be less than or equal to ${MAX_CONCURRENCY}` });
    }
  }

  optionalPositiveInteger(defaults, "maxRuntimeMs", `${path}.maxRuntimeMs`, issues, MAX_RUNTIME_MS);

  if (defaults.backend !== undefined) parseBackend(defaults.backend, `${path}.backend`, issues);
}

function parseBackend(value: unknown, path: string, issues: ValidationIssue[]): void {
  const backend = objectAt(value, path, issues);
  if (!backend) return;

  rejectUnknownKeys(backend, BACKEND_KEYS, path, issues);

  if (backend.type !== undefined && backend.type !== "local-pi") {
    issues.push({ path: `${path}.type`, message: 'must be "local-pi"' });
  }

  if (backend.mode !== undefined) {
    if (backend.mode === "headless") {
      issues.push({ path: `${path}.mode`, message: '"headless" is reserved and unsupported in MVP' });
    } else if (backend.mode !== "auto" && backend.mode !== "tmux") {
      issues.push({ path: `${path}.mode`, message: 'must be "auto" or "tmux"' });
    }
  }
}

function parseRoles(value: unknown, path: string, issues: ValidationIssue[]): void {
  const roles = objectAt(value, path, issues);
  if (!roles) return;

  for (const [name, roleValue] of Object.entries(roles)) {
    if (name.trim() === "") {
      issues.push({ path, message: "role names must be non-empty" });
      continue;
    }

    const rolePath = `${path}.${jsonKey(name)}`;
    const role = objectAt(roleValue, rolePath, issues);
    if (!role) continue;

    rejectUnknownKeys(role, ROLE_KEYS, rolePath, issues);
    optionalString(role, "fromAgent", `${rolePath}.fromAgent`, issues);
    optionalString(role, "prompt", `${rolePath}.prompt`, issues);
    optionalStringArray(role, "includeSections", `${rolePath}.includeSections`, issues);
    optionalStringArray(role, "excludeSections", `${rolePath}.excludeSections`, issues);

    if (role.maxChars !== undefined) {
      const maxChars = role.maxChars;
      if (typeof maxChars !== "number" || !Number.isInteger(maxChars) || maxChars <= 0) {
        issues.push({ path: `${rolePath}.maxChars`, message: "must be a positive integer" });
      }
    }

    if (role.fromAgent === undefined && role.prompt === undefined) {
      issues.push({ path: rolePath, message: "must define fromAgent, prompt, or both" });
    }
  }
}

function parseWorkflowBody(value: unknown, path: string, issues: ValidationIssue[]): void {
  const body = objectAt(value, path, issues);
  if (!body) return;

  if (!WORKFLOW_TYPES.includes(body.type as never)) {
    issues.push({ path: `${path}.type`, message: 'must be "single", "parallel", "chain", "dag", or "map"' });
    return;
  }

  if (body.type === "single") {
    rejectUnknownKeys(body, WORKFLOW_SINGLE_KEYS, path, issues);
    parseTask(body.task, `${path}.task`, issues);
    return;
  }

  if (body.type === "parallel") {
    rejectUnknownKeys(body, WORKFLOW_PARALLEL_KEYS, path, issues);
    parseTaskArray(body.tasks, `${path}.tasks`, issues, 2);
    if (body.aggregate !== undefined) parseTask(body.aggregate, `${path}.aggregate`, issues);
    return;
  }

  if (body.type === "chain") {
    rejectUnknownKeys(body, WORKFLOW_CHAIN_KEYS, path, issues);
    parseTaskArray(body.steps, `${path}.steps`, issues);
    return;
  }

  if (body.type === "dag") {
    rejectUnknownKeys(body, WORKFLOW_DAG_KEYS, path, issues);
    parseTaskArray(body.tasks, `${path}.tasks`, issues, 1, { idRequired: true, allowDependsOn: true });
    return;
  }

  rejectUnknownKeys(body, WORKFLOW_MAP_KEYS, path, issues);
  parseMapItems(body.items, `${path}.items`, issues);
  parseTask(body.task, `${path}.task`, issues);
  if (body.aggregate !== undefined) parseTask(body.aggregate, `${path}.aggregate`, issues);
}

function parseMapItems(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be an array" });
    return;
  }
  if (value.length < 1) {
    issues.push({ path, message: "must contain at least one item" });
    return;
  }

  const seen = new Set<string>();
  value.forEach((itemValue, index) => {
    const itemPath = `${path}[${index}]`;
    const item = objectAt(itemValue, itemPath, issues) as (Partial<WorkflowMapItemSpec> & Record<string, unknown>) | undefined;
    if (!item) return;
    rejectUnknownKeys(item, MAP_ITEM_KEYS, itemPath, issues);
    requiredString(item, "id", `${itemPath}.id`, issues);
    requiredString(item, "input", `${itemPath}.input`, issues);
    if (typeof item.id === "string") {
      if (seen.has(item.id)) issues.push({ path: `${itemPath}.id`, message: `duplicate value "${item.id}"` });
      seen.add(item.id);
    }
  });
}

function parseTaskArray(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  minLength = 1,
  options: { idRequired?: boolean; allowDependsOn?: boolean } = {},
): void {
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be an array" });
    return;
  }

  if (value.length < minLength) {
    issues.push({ path, message: minLength === 1 ? "must contain at least one task" : `must contain at least ${minLength} tasks` });
    return;
  }

  value.forEach((task, index) => parseTask(task, `${path}[${index}]`, issues, options));
}

function parseTask(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  options: { idRequired?: boolean; allowDependsOn?: boolean } = {},
): void {
  const task = objectAt(value, path, issues) as (Partial<WorkflowTaskSpec> & Record<string, unknown>) | undefined;
  if (!task) return;

  rejectUnknownKeys(task, TASK_KEYS, path, issues);
  if (options.idRequired) requiredString(task, "id", `${path}.id`, issues);
  else optionalString(task, "id", `${path}.id`, issues);
  requiredString(task, "agent", `${path}.agent`, issues);
  parseRoleReference(task.role, `${path}.role`, issues);
  requiredString(task, "task", `${path}.task`, issues);
  optionalString(task, "cwd", `${path}.cwd`, issues);
  optionalString(task, "model", `${path}.model`, issues);
  optionalEnum(task, "thinking", THINKING_LEVELS, `${path}.thinking`, issues);
  optionalEnum(task, "fast", FAST_MODES, `${path}.fast`, issues);
  optionalEnum(task, "approvalMode", APPROVAL_MODES, `${path}.approvalMode`, issues);
  optionalStringArray(task, "tools", `${path}.tools`, issues);
  optionalBoolean(task, "readOnly", `${path}.readOnly`, issues);
  optionalEnum(task, "worktreePolicy", WORKTREE_POLICIES, `${path}.worktreePolicy`, issues);
  optionalString(task, "outputContract", `${path}.outputContract`, issues);
  optionalPositiveInteger(task, "maxRuntimeMs", `${path}.maxRuntimeMs`, issues, MAX_RUNTIME_MS);
  optionalStringArray(task, "dependsOn", `${path}.dependsOn`, issues);
  if (task.dependsOn !== undefined && !options.allowDependsOn) {
    issues.push({ path: `${path}.dependsOn`, message: "is only supported for dag flows" });
  }
}

function parseRoleReference(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (value === undefined) return;
  if (typeof value === "string") {
    if (value.trim() === "") issues.push({ path, message: "must be non-empty" });
    return;
  }

  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be a string or string array" });
    return;
  }

  value.forEach((item, index) => {
    if (typeof item !== "string" || item.trim() === "") {
      issues.push({ path: `${path}[${index}]`, message: "must be a non-empty string" });
    }
  });
}

function objectAt(value: unknown, path: string, issues: ValidationIssue[]): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    issues.push({ path, message: "must be an object" });
    return undefined;
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  object: Record<string, unknown>,
  allowedKeys: Set<string>,
  path: string,
  issues: ValidationIssue[],
): void {
  for (const key of Object.keys(object)) {
    if (!allowedKeys.has(key)) {
      issues.push({ path: `${path}.${jsonKey(key)}`, message: "unknown field" });
    }
  }
}

function requiredString(object: Record<string, unknown>, key: string, path: string, issues: ValidationIssue[]): void {
  if (object[key] === undefined) {
    issues.push({ path, message: "is required" });
    return;
  }
  optionalString(object, key, path, issues);
}

function optionalString(object: Record<string, unknown>, key: string, path: string, issues: ValidationIssue[]): void {
  if (object[key] === undefined) return;
  if (typeof object[key] !== "string" || (object[key] as string).trim() === "") {
    issues.push({ path, message: "must be a non-empty string" });
  }
}

function optionalBoolean(object: Record<string, unknown>, key: string, path: string, issues: ValidationIssue[]): void {
  if (object[key] === undefined) return;
  if (typeof object[key] !== "boolean") {
    issues.push({ path, message: "must be a boolean" });
  }
}

function optionalPositiveInteger(object: Record<string, unknown>, key: string, path: string, issues: ValidationIssue[], max?: number): void {
  if (object[key] === undefined) return;
  const value = object[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    issues.push({ path, message: "must be a positive integer" });
    return;
  }
  if (max !== undefined && value > max) {
    issues.push({ path, message: `must be less than or equal to ${max}` });
  }
}

function optionalStringArray(object: Record<string, unknown>, key: string, path: string, issues: ValidationIssue[]): void {
  if (object[key] === undefined) return;
  if (!Array.isArray(object[key])) {
    issues.push({ path, message: "must be an array" });
    return;
  }

  const seen = new Set<string>();
  (object[key] as unknown[]).forEach((item, index) => {
    if (typeof item !== "string" || item.trim() === "") {
      issues.push({ path: `${path}[${index}]`, message: "must be a non-empty string" });
      return;
    }
    if (seen.has(item)) {
      issues.push({ path: `${path}[${index}]`, message: `duplicate value "${item}"` });
    }
    seen.add(item);
  });
}

function optionalEnum<T extends readonly string[]>(
  object: Record<string, unknown>,
  key: string,
  values: T,
  path: string,
  issues: ValidationIssue[],
): void {
  if (object[key] === undefined) return;
  if (!values.includes(object[key] as never)) {
    issues.push({ path, message: `must be one of: ${values.join(", ")}` });
  }
}

function jsonKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

export const loadWorkflow = loadWorkflowSpec;
export const parseWorkflow = parseWorkflowSpecCompat;


function isStageFirstSpec(value: unknown): value is any {
  return Boolean(value && typeof value === "object" && (value as any).workflow?.stages || (value as any).flow?.stages);
}

export function parseStageFirstWorkflowSpec(value: unknown): any {
  if (!value || typeof value !== "object") throw new WorkflowValidationError([{ path: "$", message: "must be an object" }]);
  const spec = value as any;
  const stages = spec.workflow?.stages ?? spec.flow?.stages;
  if (spec.schemaVersion !== 1) throw new WorkflowValidationError([{ path: "$.schemaVersion", message: "must be exactly 1" }]);
  if (!Array.isArray(stages)) throw new WorkflowValidationError([{ path: "$.workflow.stages", message: "must be an array" }]);
  for (const [index, stage] of stages.entries()) {
    if (!stage || typeof stage !== "object") throw new WorkflowValidationError([{ path: `$.workflow.stages[${index}]`, message: "must be an object" }]);
    if (stage.type === "parallel" && Array.isArray(stage.tasks)) {
      for (const [taskIndex, task] of stage.tasks.entries()) {
        if (task?.inject !== undefined) throw new WorkflowValidationError([{ path: `$.workflow.stages[${index}].tasks[${taskIndex}].inject`, message: "unknown field" }]);
      }
    }
    if (stage.type === "foreach" && stage.each?.inject !== undefined) {
      throw new WorkflowValidationError([{ path: `$.workflow.stages[${index}].each.inject`, message: "unknown field" }]);
    }
  }
  if (!spec.workflow && spec.flow?.stages) return { ...spec, workflow: { stages: spec.flow.stages } };
  return spec;
}

const originalParseWorkflowSpec = parseWorkflowSpec;
export function parseWorkflowSpecCompat(value: unknown): any {
  if (value && typeof value === "object" && (value as any).flow?.type !== undefined && !(value as any).flow?.stages) {
    throw new WorkflowValidationError([{ path: "$.flow.type", message: "unknown field" }]);
  }
  if (isStageFirstSpec(value)) return parseStageFirstWorkflowSpec(value);
  return originalParseWorkflowSpec(value);
}
