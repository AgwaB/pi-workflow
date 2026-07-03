import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { hashDynamicRequest } from "./dynamic-events.js";
import { readJson, writeJsonAtomic } from "./store.js";

export const WORKFLOW_PARTIAL_OUTPUT_PROTOCOL =
	"workflow-partial-output-v1" as const;
export const WORKFLOW_PARTIAL_OUTPUT_LEDGER_SCHEMA =
	"workflow-partial-output-ledger-v1" as const;
export const WORKFLOW_PARTIAL_OUTPUT_LEDGER_FILE = "partial-control.json";

export type WorkflowPartialOutputIssueCode =
	| "invalid_json"
	| "invalid_type"
	| "invalid_schema"
	| "invalid_path"
	| "disallowed_path"
	| "missing_items"
	| "missing_item_id"
	| "duplicate_item_id";

export interface WorkflowPartialOutputIssue {
	code: WorkflowPartialOutputIssueCode;
	message: string;
	sectionIndex?: number;
	path?: string;
	itemId?: string;
}

export interface WorkflowPartialOutputItem {
	path: string;
	itemId: string;
	itemHash: string;
	item: unknown;
	ordinal: number;
	sectionIndex: number;
	sectionItemIndex: number;
	itemRef: string;
}

export interface WorkflowPartialOutputLedger {
	schema: typeof WORKFLOW_PARTIAL_OUTPUT_LEDGER_SCHEMA;
	protocol: typeof WORKFLOW_PARTIAL_OUTPUT_PROTOCOL;
	items: WorkflowPartialOutputItem[];
	issues: WorkflowPartialOutputIssue[];
}

export interface ParseWorkflowPartialOutputOptions {
	allowedPaths?: readonly string[];
}

interface PartialSectionMatch {
	content: string;
	start: number;
	end: number;
	index: number;
}

const PARTIAL_CONTROL_OPEN = "partial-control";

export function partialOutputLedgerPath(taskDir: string): string {
	return join(taskDir, WORKFLOW_PARTIAL_OUTPUT_LEDGER_FILE);
}

export async function readWorkflowPartialOutputLedger(
	taskDir: string,
): Promise<WorkflowPartialOutputLedger | undefined> {
	return await readJson<WorkflowPartialOutputLedger>(
		partialOutputLedgerPath(taskDir),
	);
}

export async function writeWorkflowPartialOutputLedger(options: {
	taskDir: string;
	rawOutput: string;
	allowedPaths?: readonly string[];
}): Promise<WorkflowPartialOutputLedger> {
	const ledger = parseWorkflowPartialOutput(options.rawOutput, {
		allowedPaths: options.allowedPaths,
	});
	await writeJsonAtomic(partialOutputLedgerPath(options.taskDir), ledger);
	return ledger;
}

export async function writeWorkflowPartialOutputLedgerFromFile(options: {
	taskDir: string;
	outputFile: string;
	allowedPaths?: readonly string[];
}): Promise<WorkflowPartialOutputLedger | undefined> {
	const rawOutput = await readFile(options.outputFile, "utf8").catch(
		() => undefined,
	);
	if (rawOutput === undefined) return undefined;
	return await writeWorkflowPartialOutputLedger({
		taskDir: options.taskDir,
		rawOutput,
		allowedPaths: options.allowedPaths,
	});
}

export function stripWorkflowPartialOutputSections(raw: string): string {
	if (!raw.includes(PARTIAL_CONTROL_OPEN)) return raw;
	return raw.replace(partialControlSectionRegExp(), "");
}

export function parseWorkflowPartialOutput(
	raw: string,
	options: ParseWorkflowPartialOutputOptions = {},
): WorkflowPartialOutputLedger {
	const allowedPaths = options.allowedPaths
		? new Set(options.allowedPaths)
		: undefined;
	const items: WorkflowPartialOutputItem[] = [];
	const issues: WorkflowPartialOutputIssue[] = [];
	const byPathAndId = new Map<string, WorkflowPartialOutputItem>();

	for (const section of collectPartialControlSections(raw)) {
		const parsed = parsePartialSectionJson(section, issues);
		if (!parsed) continue;
		const path = parsePartialSectionPath(parsed, section, allowedPaths, issues);
		if (!path) continue;
		const rawItems = parsePartialSectionItems(parsed, section, path, issues);
		if (!rawItems) continue;
		for (const [sectionItemIndex, item] of rawItems.entries()) {
			const itemId = stablePartialItemId(item);
			if (!itemId) {
				issues.push({
					code: "missing_item_id",
					sectionIndex: section.index,
					path,
					message:
						"partial output items must be objects with a stable non-empty string id",
				});
				continue;
			}
			const itemHash = hashDynamicRequest(item);
			const key = `${path}\0${itemId}`;
			const existing = byPathAndId.get(key);
			if (existing) {
				if (existing.itemHash !== itemHash) {
					issues.push({
						code: "duplicate_item_id",
						sectionIndex: section.index,
						path,
						itemId,
						message: `partial output item ${itemId} at ${path} changed after it was published`,
					});
				}
				continue;
			}
			const ordinal = items.length;
			const partialItem: WorkflowPartialOutputItem = {
				path,
				itemId,
				itemHash,
				item,
				ordinal,
				sectionIndex: section.index,
				sectionItemIndex,
				itemRef: `${WORKFLOW_PARTIAL_OUTPUT_LEDGER_FILE}#/items/${ordinal}`,
			};
			items.push(partialItem);
			byPathAndId.set(key, partialItem);
		}
	}

	return {
		schema: WORKFLOW_PARTIAL_OUTPUT_LEDGER_SCHEMA,
		protocol: WORKFLOW_PARTIAL_OUTPUT_PROTOCOL,
		items,
		issues,
	};
}

export function hasFatalPartialOutputIssue(
	ledger: Pick<WorkflowPartialOutputLedger, "issues"> | undefined,
): WorkflowPartialOutputIssue | undefined {
	return ledger?.issues.find((issue) => issue.code === "duplicate_item_id");
}

function collectPartialControlSections(raw: string): PartialSectionMatch[] {
	if (!raw.includes(PARTIAL_CONTROL_OPEN)) return [];
	const matches: PartialSectionMatch[] = [];
	const re = partialControlSectionRegExp();
	let match: RegExpExecArray | null;
	while ((match = re.exec(raw)) !== null) {
		matches.push({
			content: match[1] ?? "",
			start: match.index,
			end: re.lastIndex,
			index: matches.length,
		});
	}
	return matches;
}

function partialControlSectionRegExp(): RegExp {
	return /[ \t]*<partial-control\s*>([\s\S]*?)<\/partial-control>[ \t]*(?:\r?\n)?/gi;
}

function parsePartialSectionJson(
	section: PartialSectionMatch,
	issues: WorkflowPartialOutputIssue[],
): Record<string, unknown> | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(section.content.trim());
	} catch (error) {
		issues.push({
			code: "invalid_json",
			sectionIndex: section.index,
			message: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
	if (!isRecord(parsed)) {
		issues.push({
			code: "invalid_type",
			sectionIndex: section.index,
			message: "partial-control section must contain a JSON object",
		});
		return undefined;
	}
	if (parsed.schema !== WORKFLOW_PARTIAL_OUTPUT_PROTOCOL) {
		issues.push({
			code: "invalid_schema",
			sectionIndex: section.index,
			message: `partial-control schema must be ${WORKFLOW_PARTIAL_OUTPUT_PROTOCOL}`,
		});
		return undefined;
	}
	return parsed;
}

function parsePartialSectionPath(
	section: Record<string, unknown>,
	match: PartialSectionMatch,
	allowedPaths: Set<string> | undefined,
	issues: WorkflowPartialOutputIssue[],
): string | undefined {
	const path = section.path;
	if (typeof path !== "string" || !path.startsWith("$.")) {
		issues.push({
			code: "invalid_path",
			sectionIndex: match.index,
			message: "partial-control path must be a control JSONPath starting with $.",
		});
		return undefined;
	}
	if (allowedPaths && !allowedPaths.has(path)) {
		issues.push({
			code: "disallowed_path",
			sectionIndex: match.index,
			path,
			message: `partial-control path ${path} is not declared for this stage`,
		});
		return undefined;
	}
	return path;
}

function parsePartialSectionItems(
	section: Record<string, unknown>,
	match: PartialSectionMatch,
	path: string,
	issues: WorkflowPartialOutputIssue[],
): unknown[] | undefined {
	const items = section.items;
	if (!Array.isArray(items)) {
		issues.push({
			code: "missing_items",
			sectionIndex: match.index,
			path,
			message: "partial-control items must be an array",
		});
		return undefined;
	}
	return items;
}

function stablePartialItemId(item: unknown): string | undefined {
	if (!isRecord(item) || typeof item.id !== "string") return undefined;
	const sanitized = sanitizePartialItemId(item.id);
	return sanitized || undefined;
}

function sanitizePartialItemId(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_.-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
