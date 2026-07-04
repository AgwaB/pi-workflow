/**
 * Serialize JSON embedded directly in prompts/model context.
 *
 * Persisted artifacts can stay pretty-printed for humans, but prompt context
 * should avoid indentation bytes when the JSON data is otherwise identical.
 */
export function stringifyPromptJson(value: unknown): string {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) {
		throw new TypeError("prompt JSON value must be JSON-serializable");
	}
	return serialized;
}
