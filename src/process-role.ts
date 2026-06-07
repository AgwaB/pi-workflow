export const PI_WORKFLOW_ROLE_ENV = "PI_WORKFLOW_ROLE";

export type WorkflowProcessRole = "supervisor" | "worker" | "disabled";

export function getWorkflowProcessRole(env: NodeJS.ProcessEnv = process.env): WorkflowProcessRole {
  const raw = env[PI_WORKFLOW_ROLE_ENV]?.trim().toLowerCase();
  if (raw === "worker" || raw === "disabled" || raw === "supervisor") return raw;
  return "supervisor";
}

export function isWorkflowSupervisorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return getWorkflowProcessRole(env) === "supervisor";
}

export function isWorkflowWorker(env: NodeJS.ProcessEnv = process.env): boolean {
  return getWorkflowProcessRole(env) === "worker";
}

export function workflowWorkerEnvPrefix(): string {
  return `${PI_WORKFLOW_ROLE_ENV}=worker`;
}
