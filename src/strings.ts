export interface CompactStringsOptions {
	/** Trim returned strings before filtering. Defaults to true. */
	trim?: boolean;
	/** Drop duplicate strings after optional trimming. Defaults to true. */
	unique?: boolean;
	/** Drop strings whose raw/trimmed form is empty. Defaults to true. */
	dropEmpty?: boolean;
	/** Drop strings whose trimmed form is empty even when trim=false. */
	dropWhitespaceOnly?: boolean;
}

export function compactStrings(
	values: readonly unknown[],
	options: CompactStringsOptions = {},
): string[] {
	const trim = options.trim ?? true;
	const unique = options.unique ?? true;
	const dropEmpty = options.dropEmpty ?? true;
	const dropWhitespaceOnly = options.dropWhitespaceOnly ?? trim;
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		if (typeof value !== "string") continue;
		const compacted = trim ? value.trim() : value;
		if (
			dropEmpty &&
			(dropWhitespaceOnly ? value.trim().length === 0 : compacted.length === 0)
		) {
			continue;
		}
		if (unique) {
			if (seen.has(compacted)) continue;
			seen.add(compacted);
		}
		result.push(compacted);
	}
	return result;
}
