export const EXPERIMENTAL_TOOL_DEDUP_ENV = "PI_WORKFLOW_EXPERIMENTAL_TOOL_DEDUP";
export const EXPERIMENTAL_CACHE_STABLE_FOREACH_ENV =
	"PI_WORKFLOW_EXPERIMENTAL_CACHE_STABLE_FOREACH";
export const EXPERIMENTAL_LAUNCH_RAMP_ENV = "PI_WORKFLOW_EXPERIMENTAL_LAUNCH_RAMP";
export const CACHE_SHAPE_METRICS_ENV = "PI_WORKFLOW_CACHE_SHAPE_METRICS";
export const EXPERIMENTAL_DEPTH_ROUTER_ENV = "PI_WORKFLOW_EXPERIMENTAL_DEPTH_ROUTER";
export const EXPERIMENTAL_SAME_SESSION_REPAIR_ENV =
	"PI_WORKFLOW_EXPERIMENTAL_SAME_SESSION_REPAIR";

const ACTIVE_EXPERIMENTAL_SPEED_FLAGS = [
	EXPERIMENTAL_TOOL_DEDUP_ENV,
	EXPERIMENTAL_CACHE_STABLE_FOREACH_ENV,
	EXPERIMENTAL_LAUNCH_RAMP_ENV,
	EXPERIMENTAL_SAME_SESSION_REPAIR_ENV,
] as const;

// Exported for compatibility with earlier experiments, but intentionally not
// returned by enabledWorkflowExperimentalSpeedFlags because no flag-gated
// runtime behavior is currently implemented for these deferred ideas.
export const DEFERRED_EXPERIMENTAL_SPEED_FLAGS = [
	CACHE_SHAPE_METRICS_ENV,
	EXPERIMENTAL_DEPTH_ROUTER_ENV,
] as const;

const TRUE_PATTERN = /^(1|true|yes|on)$/i;

export function workflowExperimentalFlagEnabled(
	name: string,
	env: Record<string, string | undefined> = process.env,
): boolean {
	return TRUE_PATTERN.test(env[name]?.trim() ?? "");
}

export function enabledWorkflowExperimentalSpeedFlags(
	env: Record<string, string | undefined> = process.env,
): string[] {
	return ACTIVE_EXPERIMENTAL_SPEED_FLAGS.filter((name) =>
		workflowExperimentalFlagEnabled(name, env),
	);
}
