export const PI_WORKFLOW_ROLE_ENV = "PI_WORKFLOW_ROLE";

export type WorkflowProcessRole = "supervisor" | "worker" | "disabled";

export function getWorkflowProcessRole(
	env: NodeJS.ProcessEnv = process.env,
): WorkflowProcessRole {
	const raw = env[PI_WORKFLOW_ROLE_ENV]?.trim().toLowerCase();
	if (raw === "worker" || raw === "disabled" || raw === "supervisor")
		return raw;
	return "supervisor";
}

export function isWorkflowSupervisorEnabled(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return getWorkflowProcessRole(env) === "supervisor";
}

export function workflowWorkerEnvPrefix(): string {
	return `${PI_WORKFLOW_ROLE_ENV}=worker`;
}

export function assertWorkflowActionAllowedForRole(
	action: string,
	env: NodeJS.ProcessEnv = process.env,
): void {
	const role = getWorkflowProcessRole(env);
	if (role === "supervisor") return;
	if (
		(action === "help" || action === "validate" || action === "board") &&
		role === "worker"
	)
		return;
	if (
		(action === "help" || action === "validate" || action === "board") &&
		role === "disabled"
	)
		return;
	throw new Error(
		`Workflow action "${action}" is not allowed when ${PI_WORKFLOW_ROLE_ENV}=${role}`,
	);
}

export function assertWorkflowToolAllowedForRole(
	env: NodeJS.ProcessEnv = process.env,
): void {
	const role = getWorkflowProcessRole(env);
	if (role !== "supervisor")
		throw new Error(
			`Workflow tool is not allowed when ${PI_WORKFLOW_ROLE_ENV}=${role}`,
		);
}
