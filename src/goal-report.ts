/** Pure helpers that turn recorded Goal evidence into short, readable facts. */

// In order of precedence: a runner's own summary line beats a per-package line.
const SUMMARY_PATTERNS: readonly RegExp[] = [
	/^(Tests|Test Files|Test Suites):\s/u, // jest / vitest
	/^=+ .*\b(passed|failed|error)\b.* =+$/u, // pytest
	/^test result: /u, // cargo test
	/^(ok|FAIL)\s+\S+/u, // go test
];
const FAILED_PATTERNS: readonly RegExp[] = [
	/^✖ (.+?)(?: \([\d.]+m?s\))?$/u, // node --test
	/^not ok \d+ - (.+)$/u, // TAP
	/^FAIL(?:ED)? (.+)$/u, // jest / pytest
	/^--- FAIL: (\S+)/u, // go test
];

/**
 * A short reading of a verification command's output tail: its pass/fail
 * summary line(s) and the first failing test names. Output is model-free but
 * untrusted text, so it is bounded and single-line.
 */
export function summarizeCommandOutput(stdoutTail: string, stderrTail = ""): { summary?: string; failed: string[] } {
	const lines = `${stdoutTail}\n${stderrTail}`.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
	const node = new Map<string, string>();
	for (const line of lines) {
		const match = /^ℹ (tests|pass|fail) (\d+)$/u.exec(line); // node --test
		if (match) node.set(match[1]!, match[2]!);
	}
	let runnerSummary: string | undefined;
	for (const pattern of SUMMARY_PATTERNS) {
		runnerSummary = [...lines].reverse().find((line) => pattern.test(line));
		if (runnerSummary) break;
	}
	const failed: string[] = [];
	for (const line of lines) {
		if (failed.length >= 3) break;
		for (const pattern of FAILED_PATTERNS) {
			const match = pattern.exec(line);
			const name = match?.[1]?.trim();
			// Skip section headers ("failing tests:") and names repeated in a final summary.
			if (name && !name.endsWith(":") && !/^\d+ (passed|failed)/u.test(name) && !failed.includes(clip(name, 60))) {
				failed.push(clip(name, 60));
				break;
			}
			if (match) break;
		}
	}
	const summary = node.size
		? ["tests", "pass", "fail"].filter((key) => node.has(key)).map((key) => `${key} ${node.get(key)}`).join(", ")
		: runnerSummary ? clip(runnerSummary, 120)
			: lines.length ? clip(lines.at(-1)!, 120) : undefined;
	return { ...(summary ? { summary } : {}), failed };
}

/** Added/removed line counts between two texts (exact up to 2,000 changed lines each). */
export function lineDiffStats(before: string, after: string): { added: number; removed: number } {
	const a = before.split("\n"), b = after.split("\n");
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length, endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
	const left = a.slice(start, endA), right = b.slice(start, endB);
	if (!left.length || !right.length || left.length > 2000 || right.length > 2000)
		return { added: right.length, removed: left.length };
	// Longest common subsequence with two rolling rows.
	let previous = new Uint32Array(right.length + 1), current = new Uint32Array(right.length + 1);
	for (let i = 1; i <= left.length; i++) {
		for (let j = 1; j <= right.length; j++)
			current[j] = left[i - 1] === right[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, current[j - 1]!);
		[previous, current] = [current, previous];
	}
	const common = previous[right.length]!;
	return { added: right.length - common, removed: left.length - common };
}

/**
 * A unified line diff ("@@ -a,b +c,d @@", " ", "-", "+" lines) with `context`
 * unchanged lines around each change. Undefined when the changed region is too
 * large to compare line by line (more than 2000 lines on a side).
 */
export function unifiedLineDiff(before: string, after: string, context = 2): string[] | undefined {
	// An empty file has no lines (not one empty line).
	const a = before === "" ? [] : before.split("\n"), b = after === "" ? [] : after.split("\n");
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length, endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
	const left = a.slice(start, endA), right = b.slice(start, endB);
	if (!left.length && !right.length) return [];
	if (left.length > 2000 || right.length > 2000) return undefined;
	// Longest common subsequence table, then walk it into edit operations.
	const width = right.length + 1;
	const table = new Uint16Array((left.length + 1) * width);
	for (let i = left.length - 1; i >= 0; i--)
		for (let j = right.length - 1; j >= 0; j--)
			table[i * width + j] = left[i] === right[j] ? table[(i + 1) * width + j + 1]! + 1
				: Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
	type Op = { kind: " " | "-" | "+"; text: string; oldLine: number; newLine: number };
	const ops: Op[] = [];
	for (let k = 0; k < start; k++) ops.push({ kind: " ", text: a[k]!, oldLine: k + 1, newLine: k + 1 });
	let i = 0, j = 0;
	while (i < left.length || j < right.length) {
		if (i < left.length && j < right.length && left[i] === right[j]) {
			ops.push({ kind: " ", text: left[i]!, oldLine: start + i + 1, newLine: start + j + 1 }); i++; j++;
		} else if (i < left.length && (j >= right.length || table[(i + 1) * width + j]! >= table[i * width + j + 1]!)) {
			// Removed lines come before the added lines that replace them.
			ops.push({ kind: "-", text: left[i]!, oldLine: start + i + 1, newLine: start + j }); i++;
		} else {
			ops.push({ kind: "+", text: right[j]!, oldLine: start + i, newLine: start + j + 1 }); j++;
		}
	}
	for (let k = 0; k < a.length - endA; k++)
		ops.push({ kind: " ", text: a[endA + k]!, oldLine: endA + k + 1, newLine: endB + k + 1 });
	// Group changes with their context into hunks.
	const out: string[] = [];
	let index = 0;
	while (index < ops.length) {
		while (index < ops.length && ops[index]!.kind === " ") index++;
		if (index >= ops.length) break;
		let from = Math.max(0, index - context), to = index;
		for (;;) {
			while (to < ops.length && ops[to]!.kind !== " ") to++;
			let gap = to;
			while (gap < ops.length && ops[gap]!.kind === " ") gap++;
			if (gap < ops.length && gap - to <= context * 2) { to = gap; continue; }
			to = Math.min(ops.length, to + context);
			break;
		}
		const hunk = ops.slice(from, to);
		const oldCount = hunk.filter(op => op.kind !== "+").length, newCount = hunk.filter(op => op.kind !== "-").length;
		const oldStart = hunk.find(op => op.kind !== "+")?.oldLine ?? hunk[0]!.oldLine;
		const newStart = hunk.find(op => op.kind !== "-")?.newLine ?? hunk[0]!.newLine;
		out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
		for (const op of hunk) out.push(`${op.kind}${op.text}`);
		index = to;
	}
	return out;
}

/** The first paragraph of a model-written note, on one bounded line. */
export function firstParagraph(text: string, max = 220): string {
	const paragraph = text.split(/\n\s*\n/u).map((part) => part.trim()).find(Boolean) ?? "";
	return clip(paragraph.replace(/\s+/gu, " "), max);
}

const SCRIPTS: Array<[RegExp, string]> = [
	[/[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]/u, "Korean"],
	[/[\u3040-\u30FF]/u, "Japanese"],
	[/[\u4E00-\u9FFF]/u, "Chinese"],
	[/[\u0400-\u04FF]/u, "Russian"],
	[/[\u0600-\u06FF]/u, "Arabic"],
	[/[\u0590-\u05FF]/u, "Hebrew"],
	[/[\u0E00-\u0E7F]/u, "Thai"],
	[/[\u0900-\u097F]/u, "Hindi"],
	[/[\u0370-\u03FF]/u, "Greek"],
];

/**
 * The language a request is written in, from its script, so an explanation
 * can match it without passing the request text itself. Latin-script text
 * is ambiguous and returns undefined.
 */
export function requestLanguage(text: unknown): string | undefined {
	if (typeof text !== "string") return undefined;
	return SCRIPTS.find(([pattern]) => pattern.test(text))?.[1];
}

/** The first sentence of a short model-written summary (for example a worker's digest). */
export function firstSentence(text: string, max = 220): string {
	const line = text.replace(/\s+/gu, " ").trim();
	const match = /^(.+?[.!?])(?:\s|$)/u.exec(line);
	return clip(match ? match[1]! : line, max);
}

function clip(value: string, max: number): string {
	const line = value.replace(/\s+/gu, " ").trim();
	return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}
