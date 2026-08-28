/** Shared cancellation markers used at provider boundaries. */
export function isWorkflowAbortError(value: unknown): boolean {
	if (typeof DOMException !== "undefined" && value instanceof DOMException)
		return value.name === "AbortError";
	return isRecord(value) && value.name === "AbortError";
}

/**
 * Provider adapters have historically returned cancellation in several shapes.
 * Keep this check deliberately exact: arbitrary provider errors must not be
 * promoted to cancellation (or accidentally suppress useful diagnostics).
 */
export function isWorkflowReturnedCancellation(value: unknown): boolean {
	if (isWorkflowAbortError(value)) return true;
	if (!isRecord(value)) return false;
	if (value.cancelled === true) return true;
	const details = isRecord(value.details) ? value.details : undefined;
	if (details?.cancelled === true) return true;
	for (const candidate of [value.error, details?.error, value.reason, details?.reason]) {
		if (candidate === "aborted" || candidate === "AbortError" || candidate === "ABORT_ERR") return true;
		if (isWorkflowAbortError(candidate)) return true;
	}
	if (Array.isArray(value.content)) {
		for (const entry of value.content) {
			if (!isRecord(entry) || typeof entry.text !== "string") continue;
			try {
				const parsed: unknown = JSON.parse(entry.text);
				if (parsed !== value && isWorkflowReturnedCancellation(parsed)) return true;
			} catch { /* ordinary provider text */ }
		}
	}
	return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
