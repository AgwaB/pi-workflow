import type {
	AgentDefinition,
	CompiledTask,
	WorkflowResourcePolicy,
} from "./types.js";

/**
 * Marks compiled tasks that use the explicit, sealed resource-policy contract.
 * Tasks without this marker are permanently legacy, even when they happen to
 * carry an authored `inheritSkills: false` value.
 */
export const WORKFLOW_RESOURCE_POLICY_VERSION = 1 as const;

export type { WorkflowResourcePolicy } from "./types.js";

/**
 * Resolve the one resource policy that is allowed to affect a workflow launch.
 * The absent marker deliberately preserves pre-policy behavior.
 */
export function resolveWorkflowResourcePolicy(
	task: Pick<CompiledTask, "resourcePolicyVersion" | "inheritSkills">,
): WorkflowResourcePolicy | undefined {
	if (task.resourcePolicyVersion === undefined) return undefined;
	if (task.resourcePolicyVersion !== WORKFLOW_RESOURCE_POLICY_VERSION) {
		throw new Error("workflow resource policy version is unsupported");
	}
	return {
		version: WORKFLOW_RESOURCE_POLICY_VERSION,
		skillDiscovery: task.inheritSkills === false ? "disabled" : "ambient",
		contextFiles: "disabled",
	};
}

/** Strict structural validation for a persisted or prepared policy record. */
export function isWorkflowResourcePolicy(
	value: unknown,
): value is WorkflowResourcePolicy {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	)
		return false;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	return (
		keys.length === 3 &&
		keys[0] === "contextFiles" &&
		keys[1] === "skillDiscovery" &&
		keys[2] === "version" &&
		record.version === WORKFLOW_RESOURCE_POLICY_VERSION &&
		(record.skillDiscovery === "ambient" || record.skillDiscovery === "disabled") &&
		record.contextFiles === "disabled"
	);
}

/**
 * Reject a prepared policy that does not exactly represent the compiled task.
 * Returning the prepared object ensures launch code consumes the sealed value,
 * not mutable authoring metadata.
 */
export function assertWorkflowResourcePolicyMatchesTask(
	task: Pick<CompiledTask, "resourcePolicyVersion" | "inheritSkills">,
	preparedPolicy: unknown,
): WorkflowResourcePolicy | undefined {
	const resolved = resolveWorkflowResourcePolicy(task);
	if (resolved === undefined) {
		if (preparedPolicy !== undefined) {
			throw new Error(
				"workflow resource policy drifted from legacy compiled semantics",
			);
		}
		return undefined;
	}
	if (
		!isWorkflowResourcePolicy(preparedPolicy) ||
		preparedPolicy.version !== resolved.version ||
		preparedPolicy.skillDiscovery !== resolved.skillDiscovery ||
		preparedPolicy.contextFiles !== resolved.contextFiles
	) {
		throw new Error("workflow resource policy drifted from compiled semantics");
	}
	return preparedPolicy;
}

/**
 * Diagnostics are deliberately warning-only: raw frontmatter remains available
 * even when the parsed boolean field is absent.
 */
export function resourceInheritanceWarnings(agent: AgentDefinition): string[] {
	const frontmatter =
		agent.frontmatter &&
		typeof agent.frontmatter === "object" &&
		!Array.isArray(agent.frontmatter)
			? agent.frontmatter
			: {};
	const warnings: string[] = [];
	for (const field of ["inheritSkills", "inheritProjectContext"] as const) {
		if (Object.hasOwn(frontmatter, field) && typeof frontmatter[field] !== "boolean") {
			warnings.push(
				`agent "${agent.displayName}" has non-boolean ${field} frontmatter; it is ignored`,
			);
		}
	}
	if (frontmatter.inheritProjectContext === true) {
		warnings.push(
			`agent "${agent.displayName}" requests inheritProjectContext: true, but project context discovery remains disabled`,
		);
	}
	return warnings;
}
