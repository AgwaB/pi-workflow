/**
 * Readable human-judgment dialog. The judgment stays bound to the exact
 * captured subject; this only decides how it is shown: the change as a diff
 * against the working tree first, the exact captured bytes on request.
 */
import { lineDiffStats, unifiedLineDiff } from "./goal-report.js";

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value : "");

export const GOAL_JUDGE_ACCEPT = "Accept this criterion";
export const GOAL_JUDGE_REJECT = "Reject this criterion";
export const GOAL_JUDGE_SHOW = "Show everything";
export const GOAL_JUDGE_PENDING = "Leave pending";

/** Lines of the change shown above the choices; the rest is behind "Show everything". */
const SUMMARY_CHANGE_LINES = 14;

export interface GoalJudgmentContext {
	goalName?: string;
	/** The attempt (first plan plus replans) whose result is judged. */
	attempt?: number;
	/** The workers' own notes for that attempt (untrusted). */
	workerNotes?: string[];
	/** The other criteria's verdicts in that attempt, one readable line each. */
	otherChecks?: string[];
}

/** The current working-tree text of a candidate path, or undefined (missing or unreadable). */
export type ReadOrigin = (path: string) => Promise<string | undefined>;

interface FileChange {
	path: string;
	headline: string;
	lines: string[];
}

function decodeUtf8(hex: string): string | undefined {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(hex, "hex"));
	} catch {
		return undefined;
	}
}

async function describeCandidateFiles(subject: Json, readOrigin: ReadOrigin): Promise<FileChange[] | undefined> {
	if (subject.schema !== "goal-candidate-evidence-v1" || !isRecord(subject.candidate)) return undefined;
	const files = Array.isArray(subject.candidate.files) ? subject.candidate.files.filter(isRecord) : [];
	const changes: FileChange[] = [];
	for (const file of files) {
		const path = text(file.path);
		const value = isRecord(file.value) ? file.value : undefined;
		if (!value || value.kind !== "file" || typeof value.hex !== "string") {
			changes.push({ path, headline: `${path} (removed or not a regular file)`, lines: [] });
			continue;
		}
		const after = decodeUtf8(value.hex);
		if (after === undefined) {
			changes.push({ path, headline: `${path} (binary, ${value.hex.length / 2} bytes)`, lines: [] });
			continue;
		}
		const before = await readOrigin(path);
		const diff = unifiedLineDiff(before ?? "", after);
		const stats = lineDiffStats(before ?? "", after);
		const headline = before === undefined ? `${path} (new file, ${after.split("\n").length} lines)`
			: diff?.length === 0 ? `${path} (unchanged)` : `${path} (+${stats.added} −${stats.removed} lines)`;
		changes.push({ path, headline, lines: diff ?? after.split("\n").map((line) => `+${line}`) });
	}
	return changes;
}

const clip = (value: string, width: number): string =>
	value.length <= width ? value : `${value.slice(0, width - 1)}…`;

/** The dialog's summary (above the choices) and the full view (behind "Show everything"). */
export async function describeGoalJudgment(
	snapshot: Readonly<Json>,
	context: GoalJudgmentContext,
	readOrigin: ReadOrigin,
	width = 160,
): Promise<{ summary: string; details: string }> {
	const criterion = isRecord(snapshot.criterion) ? snapshot.criterion : {};
	const verifier = isRecord(criterion.verifier) ? criterion.verifier : {};
	const condition = isRecord(verifier.config) && isRecord(verifier.config.condition) ? verifier.config.condition : {};
	const statement = text(condition.statement) || "(no statement)";
	const subjectBytes = text(snapshot.subjectBytes);
	let subject: unknown;
	try { subject = JSON.parse(subjectBytes); } catch { subject = undefined; }

	const head: string[] = [];
	const name = context.goalName ? `Goal ${context.goalName}` : "A Goal";
	head.push(`Your judgment is needed: ${name}${context.attempt ? `, attempt ${context.attempt}` : ""}`);
	head.push(`Criterion ${text(snapshot.criterionId)}: ${statement}`);
	for (const note of context.workerNotes ?? []) head.push(`Worker's note (untrusted): ${note}`);
	if (context.otherChecks?.length) head.push(`Other checks in this attempt: ${context.otherChecks.join("; ")}`);

	const files = isRecord(subject) ? await describeCandidateFiles(subject, readOrigin) : undefined;
	const body: string[] = [];
	const full: string[] = [];
	if (files) {
		body.push("The result to judge (untrusted), compared with your working tree now:");
		full.push(...body);
		let shownLines = 0, hidden = 0;
		for (const file of files) {
			body.push(`  ${file.headline}`);
			full.push(`  ${file.headline}`, ...file.lines.map((line) => `    ${line}`));
			for (const line of file.lines) {
				if (shownLines < SUMMARY_CHANGE_LINES) { body.push(`    ${line}`); shownLines++; }
				else hidden++;
			}
		}
		if (hidden) body.push(`    … ${hidden} more line${hidden === 1 ? "" : "s"} (choose "${GOAL_JUDGE_SHOW}")`);
	} else {
		const pretty = subject === undefined ? subjectBytes : JSON.stringify(subject, null, 2);
		const lines = pretty.split("\n");
		body.push("The result to judge (untrusted):", ...lines.slice(0, SUMMARY_CHANGE_LINES).map((line) => `  ${line}`));
		if (lines.length > SUMMARY_CHANGE_LINES)
			body.push(`  … ${lines.length - SUMMARY_CHANGE_LINES} more lines (choose "${GOAL_JUDGE_SHOW}")`);
		full.push("The result to judge (untrusted):", ...lines.map((line) => `  ${line}`));
	}
	const footer = "Your choice decides only this criterion; it does not change what the Goal may do.";
	const summary = [...head, "", ...body, "", footer].map((line) => clip(line, width)).join("\n");
	const details = [
		...head, "", ...full, "", footer, "",
		"─".repeat(40),
		"Exact data this judgment is bound to (untrusted)",
		`Run: ${text(snapshot.runId)} · policy: ${text(snapshot.policySpecId)} · generation: ${String(snapshot.generation ?? "")}`,
		`Definition: ${text(snapshot.definitionFingerprint)}`,
		`Subject digest: ${text(snapshot.subjectDigest)}`,
		`Subject: ${subjectBytes}`,
		`Provenance: ${JSON.stringify(snapshot.source ?? "unavailable")}`,
	].join("\n");
	return { summary, details };
}
