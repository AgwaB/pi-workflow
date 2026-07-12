/**
 * Pure, dependency-free projection of raw `DynamicStateIndex.index` payloads
 * (gaps/blockers/conflicts/omissions/failedWork) into a cumulative
 * coordination ledger and a compact planner-facing text summary.
 *
 * No I/O. No mutation of inputs. Deterministic output for deterministic
 * input sequences.
 */

export const MAX_PROJECTED_ISSUES = 8;
export const MAX_MESSAGE_CHARS = 160;
export const MAX_SUMMARY_CHARS = 2000;
export const MAX_LEDGER_ENTRIES = 32;

export type CoordinationSeverity =
	| "critical"
	| "high"
	| "medium"
	| "low"
	| "info"
	| "unknown";

export type CoordinationEntryKind = "gap" | "blocker" | "conflict" | "omission";

export interface CoordinationLedgerEntry {
	kind: CoordinationEntryKind;
	id: string;
	message: string;
	severity: CoordinationSeverity;
	sourceTaskIds: string[];
	relatedFindingIds: string[];
	firstSeenRound: number;
}

export interface CoordinationLedger {
	entries: readonly CoordinationLedgerEntry[];
	failedTaskIds: readonly string[];
}

export interface PlannerCoordination {
	summary: string;
	artifactPath?: string;
	digest?: string;
}

const SEVERITY_RANK: Record<CoordinationSeverity, number> = {
	unknown: 0,
	info: 1,
	low: 2,
	medium: 3,
	high: 4,
	critical: 5,
};

const KIND_RANK: Record<CoordinationEntryKind, number> = {
	blocker: 0,
	conflict: 1,
	gap: 2,
	omission: 3,
};

export function createCoordinationLedger(): CoordinationLedger {
	return { entries: [], failedTaskIds: [] };
}

export function addRoundToCoordinationLedger(
	ledger: CoordinationLedger,
	round: number,
	index: unknown,
): CoordinationLedger {
	if (!isPlainObject(index)) {
		return ledger;
	}

	const gaps = readIssues(index.gaps);
	const blockers = readIssues(index.blockers);
	const conflicts = readIssues(index.conflicts);
	const omissions = readOmissions(index.omissions);
	const failedWork = readFailedWorkTaskIds(index.failedWork);

	if (
		gaps.length === 0 &&
		blockers.length === 0 &&
		conflicts.length === 0 &&
		omissions.length === 0 &&
		failedWork.length === 0
	) {
		return ledger;
	}

	const entryMap = new Map<string, CoordinationLedgerEntry>();
	for (const entry of ledger.entries) {
		entryMap.set(entryKey(entry.kind, entry.id), entry);
	}

	const applyIssues = (
		kind: Exclude<CoordinationEntryKind, "omission">,
		items: ParsedIssue[],
	) => {
		for (const item of items) {
			const key = entryKey(kind, item.id);
			const existing = entryMap.get(key);
			entryMap.set(key, {
				kind,
				id: item.id,
				message: item.message,
				severity: item.severity,
				sourceTaskIds: item.sourceTaskIds,
				relatedFindingIds: item.relatedFindingIds,
				firstSeenRound: existing ? existing.firstSeenRound : round,
			});
		}
	};

	applyIssues("blocker", blockers);
	applyIssues("conflict", conflicts);
	applyIssues("gap", gaps);

	for (const text of omissions) {
		const key = entryKey("omission", text);
		const existing = entryMap.get(key);
		entryMap.set(key, {
			kind: "omission",
			id: text,
			message: text,
			severity: "unknown",
			sourceTaskIds: [],
			relatedFindingIds: [],
			firstSeenRound: existing ? existing.firstSeenRound : round,
		});
	}

	let entries = Array.from(entryMap.values());
	if (entries.length > MAX_LEDGER_ENTRIES) {
		entries = entries.sort(compareEntries).slice(0, MAX_LEDGER_ENTRIES);
	}

	const failedTaskIds = [...ledger.failedTaskIds];
	const failedSeen = new Set(failedTaskIds);
	for (const taskId of failedWork) {
		if (!failedSeen.has(taskId)) {
			failedSeen.add(taskId);
			failedTaskIds.push(taskId);
		}
	}

	return { entries, failedTaskIds };
}

export function renderCoordinationSummary(
	ledger: CoordinationLedger,
): string | undefined {
	if (ledger.entries.length === 0 && ledger.failedTaskIds.length === 0) {
		return undefined;
	}

	const totals = {
		blockers: countKind(ledger, "blocker"),
		conflicts: countKind(ledger, "conflict"),
		gaps: countKind(ledger, "gap"),
		omissions: countKind(ledger, "omission"),
		failed: ledger.failedTaskIds.length,
	};

	const sorted = [...ledger.entries].sort(compareEntries);
	const candidates = sorted.slice(0, MAX_PROJECTED_ISSUES);
	const candidateLines = candidates.map(renderLine);

	for (let n = candidates.length; n >= 0; n--) {
		const shown = candidates.slice(0, n);
		const header = buildHeader(totals, shown);
		const block = [header, ...candidateLines.slice(0, n)].join("\n");
		if (block.length <= MAX_SUMMARY_CHARS || n === 0) {
			return block;
		}
	}

	return buildHeader(totals, []);
}

export function buildPlannerCoordination(
	ledger: CoordinationLedger,
	latest?: { digest?: string; artifactPath?: string },
): PlannerCoordination | undefined {
	const summary = renderCoordinationSummary(ledger);
	if (summary === undefined) {
		return undefined;
	}

	const result: PlannerCoordination = { summary };
	if (latest?.artifactPath !== undefined) {
		result.artifactPath = latest.artifactPath;
	}
	if (latest?.digest !== undefined) {
		result.digest = latest.digest;
	}
	return result;
}

interface ParsedIssue {
	id: string;
	message: string;
	severity: CoordinationSeverity;
	sourceTaskIds: string[];
	relatedFindingIds: string[];
}

function entryKey(kind: CoordinationEntryKind, id: string): string {
	return `${kind}:${id}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readIssues(value: unknown): ParsedIssue[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const out: ParsedIssue[] = [];
	for (const item of value) {
		if (!isPlainObject(item)) {
			continue;
		}
		const id = typeof item.id === "string" ? item.id : undefined;
		const message = typeof item.message === "string" ? item.message : undefined;
		if (id === undefined || message === undefined) {
			continue;
		}
		out.push({
			id,
			message,
			severity: readSeverity(item.severity),
			sourceTaskIds: readStringArray(item.sourceTaskIds),
			relatedFindingIds: readStringArray(item.relatedFindingIds),
		});
	}
	return out;
}

function readOmissions(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((item): item is string => typeof item === "string");
}

function readFailedWorkTaskIds(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const out: string[] = [];
	for (const item of value) {
		if (!isPlainObject(item)) {
			continue;
		}
		if (typeof item.taskId === "string") {
			out.push(item.taskId);
		}
	}
	return out;
}

function readStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((item): item is string => typeof item === "string");
}

function readSeverity(value: unknown): CoordinationSeverity {
	return value === "critical" ||
		value === "high" ||
		value === "medium" ||
		value === "low" ||
		value === "info"
		? value
		: "unknown";
}

function compareEntries(
	a: CoordinationLedgerEntry,
	b: CoordinationLedgerEntry,
): number {
	const rankA = SEVERITY_RANK[a.severity];
	const rankB = SEVERITY_RANK[b.severity];
	if (rankA !== rankB) {
		return rankB - rankA;
	}
	const kindA = KIND_RANK[a.kind];
	const kindB = KIND_RANK[b.kind];
	if (kindA !== kindB) {
		return kindA - kindB;
	}
	if (a.firstSeenRound !== b.firstSeenRound) {
		return a.firstSeenRound - b.firstSeenRound;
	}
	if (a.id < b.id) {
		return -1;
	}
	if (a.id > b.id) {
		return 1;
	}
	return 0;
}

function countKind(
	ledger: CoordinationLedger,
	kind: CoordinationEntryKind,
): number {
	let count = 0;
	for (const entry of ledger.entries) {
		if (entry.kind === kind) {
			count++;
		}
	}
	return count;
}

function truncateMessage(message: string): string {
	if (message.length <= MAX_MESSAGE_CHARS) {
		return message;
	}
	return `${message.slice(0, MAX_MESSAGE_CHARS - 1)}…`;
}

function renderLine(entry: CoordinationLedgerEntry): string {
	const message = truncateMessage(entry.message);
	if (entry.kind === "omission") {
		return `- [omission][since r${entry.firstSeenRound}] ${message}`;
	}

	const clauses: string[] = [];
	if (entry.sourceTaskIds.length > 0) {
		clauses.push(`tasks: ${entry.sourceTaskIds.join(",")}`);
	}
	if (entry.relatedFindingIds.length > 0) {
		clauses.push(`findings: ${entry.relatedFindingIds.join(",")}`);
	}
	const suffix = clauses.length > 0 ? ` (${clauses.join("; ")})` : "";

	return `- [${entry.kind}][${entry.severity}][since r${entry.firstSeenRound}] ${entry.id}: ${message}${suffix}`;
}

function buildHeader(
	totals: {
		blockers: number;
		conflicts: number;
		gaps: number;
		omissions: number;
		failed: number;
	},
	shown: readonly CoordinationLedgerEntry[],
): string {
	const shownByKind: Record<CoordinationEntryKind, number> = {
		blocker: 0,
		conflict: 0,
		gap: 0,
		omission: 0,
	};
	for (const entry of shown) {
		shownByKind[entry.kind]++;
	}

	const part = (label: string, total: number, count: number): string =>
		count < total ? `${label} ${total} (showing ${count})` : `${label} ${total}`;

	return [
		"Coordination state (cumulative): ",
		part("blockers", totals.blockers, shownByKind.blocker),
		", ",
		part("conflicts", totals.conflicts, shownByKind.conflict),
		", ",
		part("gaps", totals.gaps, shownByKind.gap),
		", ",
		part("omissions", totals.omissions, shownByKind.omission),
		", ",
		`failed work ${totals.failed}`,
	].join("");
}
