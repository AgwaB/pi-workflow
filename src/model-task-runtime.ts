export const UNLIMITED_MODEL_TASK_RUNTIME_MS = 0;

/** Valid authored/normalized per-model-task wall-time values. */
export function isModelTaskMaxRuntimeMs(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= UNLIMITED_MODEL_TASK_RUNTIME_MS
	);
}

/**
 * Resolve the finite workflow-owned task deadline. Zero explicitly means that
 * no model-task wall-time deadline is installed; omission retains legacy
 * no-value behavior for old persisted records and non-model tasks.
 */
export function modelTaskRuntimeDeadlineMs(
	value: unknown,
): number | undefined {
	if (value === undefined || value === UNLIMITED_MODEL_TASK_RUNTIME_MS)
		return undefined;
	if (!isModelTaskMaxRuntimeMs(value)) {
		throw new Error(
			"model task maxRuntimeMs must be 0 or a positive safe integer",
		);
	}
	return value;
}
