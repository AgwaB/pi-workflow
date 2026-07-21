import type { ExecutionProfileForeachBatch } from "./types.js";

/** Internal profile overlay metadata; symbols cannot be authored in JSON specs. */
export const EXECUTION_PROFILE_FOREACH_BATCH = Symbol(
	"workflow.executionProfileForeachBatch",
);

export type ProfiledArtifactGraphStage = Record<string, unknown> & {
	[EXECUTION_PROFILE_FOREACH_BATCH]?: ExecutionProfileForeachBatch;
};
