import type { CompiledWorkflow, WorkflowRunRecord } from "./types.js";

/**
 * Durable markers written by the removed protected Goal engine: a sealed
 * `goal-sdk` backend or a persisted `goal` binding. This build has no trusted
 * host for such records, so it never schedules, refreshes, resumes, stops,
 * or cleans them and never downgrades them to the ordinary backend.
 */
export function isProtectedGoalEngineRun(
	run: Pick<WorkflowRunRecord, "backend" | "goal">,
): boolean {
	return run.backend.type === "goal-sdk" || run.goal !== undefined;
}

export function assertNotProtectedGoalEngineRun(
	run: Pick<WorkflowRunRecord, "backend" | "goal" | "runId">,
): void {
	if (isProtectedGoalEngineRun(run))
		throw new Error(
			`Workflow run ${run.runId} was created by the removed protected Goal engine; this build cannot operate on it.`,
		);
}

/** Rejects protected markers on either the run or its compiled workflow. */
export function assertNoProtectedGoalEngineArtifacts(
	run: Pick<WorkflowRunRecord, "backend" | "goal" | "runId">,
	compiled: Pick<CompiledWorkflow, "backend" | "goal">,
): void {
	assertNotProtectedGoalEngineRun(run);
	if (compiled.backend.type === "goal-sdk" || compiled.goal !== undefined)
		throw new Error("Goal engine backend/binding downgrade detected");
}
