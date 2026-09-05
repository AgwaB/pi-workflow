import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { nonPublicIpReason } from "./workflow-network-policy.js";
import { isSensitiveWorkflowQueryKey, redactSensitiveWorkflowText } from "./workflow-sensitive-query.js";

// Unit tests replace fetch with an explicit in-memory transport. That seam is
// enabled only inside Node's test context; production always uses the
// request-based path below so DNS resolution is under our control.
const defaultRefValidationFetch = globalThis.fetch;
const runningUnderNodeTest = process.env.NODE_TEST_CONTEXT !== undefined;

import {
	validateStructuredContract,
	type StructuredContract,
	type StructuredContractIssue,
} from "./workflow-artifacts.js";
import { stripWorkflowPartialOutputSections } from "./workflow-partial-output.js";
import {
	validateJsonSchema,
	type JsonSchema,
	type JsonSchemaIssue,
	type JsonSchemaObject,
} from "./json-schema.js";

export const VNEXT_OUTPUT_PROTOCOL = "workflow-output-sections-v1" as const;
export const VNEXT_TASK_RESULT_SCHEMA = "workflow-task-result-v1" as const;

const SECTION_CONTROL = "control" as const;
const SECTION_ANALYSIS = "analysis" as const;
const SECTION_REFS = "refs" as const;
const CANONICAL_SECTION_ORDER = [
	SECTION_CONTROL,
	SECTION_ANALYSIS,
	SECTION_REFS,
] as const;
const DEFAULT_MAX_DIGEST_CHARS = 1000;
const DEFAULT_REFS_URL_VALIDATION_TIMEOUT_MS = 8_000;
const DEFAULT_REFS_URL_VALIDATION_MAX_URLS = 25;
const REFS_URL_VALIDATION_CONCURRENCY = 4;
const REFS_URL_VALIDATION_PER_HOST_CONCURRENCY = 1;
const REFS_URL_VALIDATION_MAX_REDIRECTS = 5;
const REFS_URL_VALIDATION_MAX_RESPONSE_BYTES = 64 * 1024;

type WorkflowOutputSectionName = (typeof CANONICAL_SECTION_ORDER)[number];

export type WorkflowOutputIssueCode =
	| "missing_section"
	| "duplicate_section"
	| "unexpected_text"
	| "invalid_json"
	| "invalid_type"
	| "missing_required_field"
	| "field_too_long"
	| "empty_section"
	| "too_few_items"
	| "invalid_ref_locator"
	| "unavailable_ref_locator"
	| "missing_required_read"
	| "missing_claim_support"
	| "missing_claim_support_locator"
	| "source_locator_not_in_refs"
	| "contract_failed";

export interface WorkflowOutputIssue {
	code: WorkflowOutputIssueCode;
	message: string;
	section?: WorkflowOutputSectionName;
	path?: string;
}

export type WorkflowOutputRepairCode =
	| "control_status_lifecycle_to_unknown"
	| "control_missing_required_sources_empty_array"
	| "control_budget_ledger_array_fields"
	| "control_additional_unverified_leads_objects"
	| "control_fact_slot_coverage_string_fields"
	| "control_final_synthesis_array_caps"
	| "control_enum_near_miss"
	| "control_object_row_from_string";

export interface WorkflowOutputRepair {
	code: WorkflowOutputRepairCode;
	message: string;
	section?: WorkflowOutputSectionName;
	path?: string;
}

export interface ParsedWorkflowOutput {
	protocol: typeof VNEXT_OUTPUT_PROTOCOL;
	valid: boolean;
	raw: string;
	control?: Record<string, unknown>;
	analysis?: string;
	refs?: unknown[];
	issues: WorkflowOutputIssue[];
	repairs?: WorkflowOutputRepair[];
}

export interface ParseWorkflowOutputOptions {
	/** Declared streaming paths; [] disallows publications. Undefined supports standalone parser use. */
	partialPaths?: readonly string[];
	analysisRequired?: boolean;
	refsRequired?: boolean;
	refsMinItems?: number;
	refsUrlValidation?: boolean | RefsUrlValidationOptions;
	refsAllowedLocators?: readonly string[];
	maxDigestChars?: number;
	controlContract?: StructuredContract;
	controlJsonSchema?: JsonSchema;
	outputProfile?: string;
}

export interface RefsUrlValidationOptions {
	enabled?: boolean;
	timeoutMs?: number;
	maxUrls?: number;
}

export interface WorkflowTaskFailedToolCallSummary {
	toolCallId?: string;
	toolName?: string;
	category?: string;
	status?: string;
	startedAt?: string;
	completedAt?: string | null;
	durationMs?: number | null;
	isError?: boolean;
	argsSummary?: unknown;
	resultSummary?: unknown;
	failedArgs?: unknown;
	failedResult?: unknown;
}

export interface WorkflowTaskArtifactBundleOptions
	extends ParseWorkflowOutputOptions {
	taskDir: string;
	rawOutput: string;
	attempt?: number;
	startedAt?: string;
	completedAt?: string;
	lifecycleStatus?: "completed" | "failed";
	exitCode?: number;
	prompt?: string;
	systemPrompt?: string;
	stderr?: string;
	salvagedFromFailureKind?: string;
	subagentWarning?: string;
	subagentStatus?: string;
	subagentFailureKind?: string | null;
	subagentToolCallsPath?: string;
	subagentToolCallsSummaryPath?: string;
	subagentToolCallsArtifactCwd?: string;
	subagentFailedToolCalls?: WorkflowTaskFailedToolCallSummary[];
}

export interface WorkflowTaskResultEnvelope {
	schema: typeof VNEXT_TASK_RESULT_SCHEMA;
	protocol: typeof VNEXT_OUTPUT_PROTOCOL;
	status: "completed" | "failed";
	artifacts: Record<string, string>;
	controlDigest?: string;
	startedAt?: string;
	completedAt: string;
	exitCode: number;
	outputValidation: {
		valid: boolean;
		issues: WorkflowOutputIssue[];
		repairCount?: number;
		repairs?: WorkflowOutputRepair[];
	};
	salvagedFromFailureKind?: string;
	subagentWarning?: string;
	subagentStatus?: string;
	subagentFailureKind?: string | null;
	subagentToolCallsPath?: string;
	subagentToolCallsSummaryPath?: string;
	subagentToolCallsArtifactCwd?: string;
	subagentFailedToolCalls?: WorkflowTaskFailedToolCallSummary[];
}

export type ValidParsedWorkflowOutput = ParsedWorkflowOutput & {
	valid: true;
	control: Record<string, unknown>;
	analysis: string;
	refs: unknown[];
};

export type WorkflowArtifactBundleWriteResult =
	| {
			valid: true;
			parsed: ValidParsedWorkflowOutput;
			result: WorkflowTaskResultEnvelope;
			files: Record<string, string>;
	  }
	| {
			valid: false;
			parsed: ParsedWorkflowOutput;
			files: Record<string, string>;
	  };

interface SectionMatch {
	name: WorkflowOutputSectionName;
	content: string;
	start: number;
	end: number;
}

interface SectionRequirements {
	analysisRequired: boolean;
	refsRequired: boolean;
	refsMinItems: number;
}

interface SectionObservation {
	name: WorkflowOutputSectionName;
	start: number;
	contentStart: number;
	contentEnd: number;
	end?: number;
}

interface TextRange {
	start: number;
	end: number;
}

interface SectionLayoutScan {
	sections: SectionMatch[];
	observations: SectionObservation[];
	duplicateNames: ReadonlySet<WorkflowOutputSectionName>;
	duplicateCounts: ReadonlyMap<WorkflowOutputSectionName, number>;
	outsideRanges: TextRange[];
	complete: boolean;
	repairEligible: boolean;
	hasExtraProtocolBlocks: boolean;
}

export function parseWorkflowOutput(
	raw: string,
	options: ParseWorkflowOutputOptions = {},
): ParsedWorkflowOutput {
	const protocolRaw = stripWorkflowPartialOutputSections(raw, {
		allowedPaths: options.partialPaths,
	});
	const issues: WorkflowOutputIssue[] = [];
	const repairs: WorkflowOutputRepair[] = [];
	const requirements = sectionRequirements(options);
	const layout = scanSectionLayout(protocolRaw, requirements);
	validateSectionLayout(layout, issues, requirements);

	const control = parseControlSection(
		sectionText(layout.sections, SECTION_CONTROL),
		issues,
		repairs,
		options,
	);
	const analysis = parseAnalysisSection(
		sectionText(layout.sections, SECTION_ANALYSIS),
		issues,
		requirements,
	);
	const refs = parseRefsSection(
		sectionText(layout.sections, SECTION_REFS),
		issues,
		requirements,
	);
	validateControlContract(control, issues, options.controlContract);
	validateControlJsonSchema(control, issues, options.controlJsonSchema);

	return buildParsedOutput(
		protocolRaw,
		issues,
		{ control, analysis, refs },
		requirements,
		repairs,
	);
}

export function parseWorkflowOutputForBundle(
	raw: string,
	options: ParseWorkflowOutputOptions = {},
): ParsedWorkflowOutput {
	const parsed = parseWorkflowOutput(raw, options);
	if (parsed.valid) return parsed;
	return parseSanitizedWorkflowOutput(parsed.raw, options) ?? parsed;
}

/** Validate a candidate bundle fully in memory without writing task artifacts. */
export async function validateWorkflowOutputForBundle(
	raw: string,
	options: ParseWorkflowOutputOptions = {},
): Promise<ParsedWorkflowOutput> {
	return validateWorkflowOutputRefsForBundle(
		parseWorkflowOutputForBundle(raw, options),
		options,
	);
}

async function validateWorkflowOutputRefsForBundle(
	parsed: ParsedWorkflowOutput,
	options: ParseWorkflowOutputOptions,
): Promise<ParsedWorkflowOutput> {
	if (!parsed.valid) return parsed;
	const issues = [
		...validateRefsAllowedLocators(
			parsed.refs ?? [],
			options.refsAllowedLocators,
		),
		...validateVerificationClaimSupport(
			parsed.control,
			parsed.refs ?? [],
			options.outputProfile,
		),
		...(await validateRefsUrlAvailability(
			parsed.refs ?? [],
			options.refsUrlValidation,
		)),
	];
	if (issues.length === 0) return parsed;
	return { ...parsed, valid: false, issues: [...parsed.issues, ...issues] };
}

export async function writeWorkflowTaskArtifactBundle(
	options: WorkflowTaskArtifactBundleOptions,
): Promise<WorkflowArtifactBundleWriteResult> {
	const taskDir = resolve(options.taskDir);
	await mkdir(taskDir, { recursive: true });
	const parsed = await validateWorkflowOutputForBundle(
		options.rawOutput,
		options,
	);
	if (!parsed.valid)
		return writeInvalidWorkflowOutputAttempt(taskDir, parsed, options);
	return writeValidatedWorkflowTaskArtifactBundle(
		options,
		parsed as ValidParsedWorkflowOutput,
	);
}

/**
 * Write an already fully validated output. Batch demux uses this to validate
 * every sibling before it writes any per-item artifact bundle.
 */
export async function writeValidatedWorkflowTaskArtifactBundle(
	options: WorkflowTaskArtifactBundleOptions,
	parsed: ValidParsedWorkflowOutput,
): Promise<Extract<WorkflowArtifactBundleWriteResult, { valid: true }>> {
	const taskDir = resolve(options.taskDir);
	await mkdir(taskDir, { recursive: true });
	return writeValidWorkflowOutputBundle(taskDir, parsed, options);
}

export function buildWorkflowOutputRetryInstructions(
	issues: readonly WorkflowOutputIssue[],
	options: ParseWorkflowOutputOptions = {},
): string {
	const requirements = sectionRequirements(options);
	const issueLines = issues.map((issue) => {
		const where = issue.path ?? issue.section;
		return `- ${where ? `${where}: ` : ""}${issue.message}`;
	});
	return [
		"Validation error: workflow output protocol was invalid.",
		requirements.analysisRequired && requirements.refsRequired
			? "Return exactly these sections, in this order, with no prose outside the tags:"
			: "Return these sections in this order, at most once each, with no prose outside the tags. Optional sections may be omitted:",
		"<control>{...}</control>",
		requirements.analysisRequired ? "<analysis>...</analysis>" : "<analysis>...</analysis> (optional)",
		requirements.refsRequired ? "<refs>[...]</refs>" : "<refs>[...]</refs> (optional)",
		...retryRepairGuidance(issues),
		"Issues:",
		...issueLines,
	].join("\n");
}

function retryRepairGuidance(issues: readonly WorkflowOutputIssue[]): string[] {
	const guidance: string[] = [];
	const hasUnavailableRef = issues.some(
		(issue) => issue.code === "unavailable_ref_locator",
	);
	if (hasUnavailableRef) {
		guidance.push(
			"Ref repair guidance:",
			"- Do not repeat refs that validation reported as unreachable or outside the allowed source ledger.",
			"- Remove stale refs or replace them with sources you have actually verified with available tools.",
			"- Keep every remaining <refs> item auditably tied to the revised analysis/control output.",
		);
	}
	const hasClaimSupportIssue = issues.some((issue) =>
		[
			"missing_claim_support",
			"missing_claim_support_locator",
			"source_locator_not_in_refs",
		].includes(issue.code),
	);
	if (hasClaimSupportIssue) {
		guidance.push(
			"Claim-support repair guidance:",
			"- If verdict/status is verified or weakened, include a positive claimSupports entry with status supports or partial.",
			"- Each positive claimSupports entry must include sourceLocators and a short excerpt or notes explaining the evidence.",
			"- Every positive sourceLocator must also appear in <refs>; remove unsupported positive verdicts or downgrade to inconclusive/rejected when evidence is insufficient.",
		);
	}
	const hasRequiredReadIssue = issues.some(
		(issue) => issue.code === "missing_required_read",
	);
	if (hasRequiredReadIssue) {
		guidance.push(
			"Required-read repair guidance:",
			"- Before returning again, call workflow_artifact for each required source listed in the issues.",
			"- Prefer projected reads with path/maxItems/maxChars when only a JSON slice is needed.",
		);
	}
	const hasJsonIssue = issues.some((issue) => issue.code === "invalid_json");
	if (hasJsonIssue) {
		guidance.push(
			"JSON repair guidance:",
			"- Return parseable JSON inside <control> and <refs>; do not append prose or a second object inside JSON sections.",
		);
	}
	const hasSchemaIssue = issues.some(
		(issue) => issue.code === "contract_failed",
	);
	if (hasSchemaIssue) {
		guidance.push(
			"Schema repair guidance:",
			"- Preserve the requested output schema exactly; add missing required fields and remove incompatible shapes rather than adding prose explanations.",
		);
	}
	return guidance;
}

function sectionRequirements(
	options: ParseWorkflowOutputOptions,
): SectionRequirements {
	const refsMinItems = normalizedRefsMinItems(options.refsMinItems);
	return {
		analysisRequired: options.analysisRequired ?? true,
		refsRequired: (options.refsRequired ?? true) || refsMinItems > 0,
		refsMinItems,
	};
}

function normalizedRefsMinItems(value: number | undefined): number {
	if (value === undefined) return 0;
	return Number.isInteger(value) && value > 0 ? value : 0;
}

function scanSectionLayout(
	raw: string,
	requirements: SectionRequirements,
): SectionLayoutScan {
	const observations = collectSectionObservations(raw);
	const sections = observations.flatMap((observation): SectionMatch[] => {
		if (observation.end === undefined) return [];
		return [
			{
				name: observation.name,
				content: raw
					.slice(observation.contentStart, observation.contentEnd)
					.trim(),
				start: observation.start,
				end: observation.end,
			},
		];
	});
	const expected = CANONICAL_SECTION_ORDER.filter((name) =>
		sectionRequired(name, requirements) || sections.some((section) => section.name === name),
	);
	const complete =
		sections.length === expected.length &&
		sections.every((section, index) => section.name === expected[index]);
	const { duplicateNames, duplicateCounts, hasExtraProtocolBlocks } =
		scanStructuralSectionOpenings(raw, observations);
	return {
		sections,
		observations,
		duplicateNames,
		duplicateCounts,
		outsideRanges: collectOutsideTextRanges(raw, sections),
		complete,
		repairEligible:
			!complete && duplicateNames.size === 0 && !hasExtraProtocolBlocks,
		hasExtraProtocolBlocks,
	};
}

function collectSectionObservations(
	raw: string,
): SectionObservation[] {
	const observations: SectionObservation[] = [];
	let cursor = 0;
	const expected = CANONICAL_SECTION_ORDER;
	for (const [index, name] of expected.entries()) {
		const openTag = `<${name}>`;
		const closeTag = `</${name}>`;
		const nextTag = expected[index + 1]
			? `<${expected[index + 1]}>`
			: undefined;
		const openStart = raw.indexOf(openTag, cursor);
		if (openStart < 0) continue;
		// An absent optional section must not be discovered inside a later
		// section's JSON strings (for example a literal <analysis> in refs).
		if (expected.slice(index + 1).some((later) => {
			const laterStart = raw.indexOf(`<${later}>`, cursor);
			return laterStart >= 0 && laterStart < openStart;
		})) continue;
		const contentStart = openStart + openTag.length;
		const closeStart = findSectionClose(raw, {
			name,
			contentStart,
			closeTag,
			nextTag,
		});
		if (closeStart >= 0) {
			const end = closeStart + closeTag.length;
			observations.push({
				name,
				start: openStart,
				contentStart,
				contentEnd: closeStart,
				end,
			});
			cursor = end;
			continue;
		}
		const nextOpen = nextTag ? raw.indexOf(nextTag, contentStart) : -1;
		const contentEnd = nextOpen >= 0 ? nextOpen : raw.length;
		observations.push({
			name,
			start: openStart,
			contentStart,
			contentEnd,
		});
		cursor = contentEnd;
	}
	return observations;
}

function findSectionClose(
	raw: string,
	options: {
		name: WorkflowOutputSectionName;
		contentStart: number;
		closeTag: string;
		nextTag?: string;
	},
): number {
	let fallback = -1;
	let inJsonString = false;
	let escaped = false;
	for (let index = options.contentStart; index < raw.length; index += 1) {
		if (options.name !== SECTION_ANALYSIS) {
			const char = raw[index] ?? "";
			if (escaped) {
				escaped = false;
				continue;
			}
			if (inJsonString && char === "\\") {
				escaped = true;
				continue;
			}
			if (char === '"') {
				inJsonString = !inJsonString;
				continue;
			}
			if (inJsonString) continue;
		}
		if (!raw.startsWith(options.closeTag, index)) continue;
		fallback = index;
		const after = skipWhitespace(raw, index + options.closeTag.length);
		if (options.nextTag && raw.startsWith(options.nextTag, after)) return index;
		index += options.closeTag.length - 1;
	}
	return fallback;
}

function skipWhitespace(raw: string, index: number): number {
	let cursor = index;
	while (cursor < raw.length && /\s/.test(raw[cursor] ?? "")) cursor += 1;
	return cursor;
}

function scanStructuralSectionOpenings(
	raw: string,
	observations: readonly SectionObservation[],
): {
	duplicateNames: ReadonlySet<WorkflowOutputSectionName>;
	duplicateCounts: ReadonlyMap<WorkflowOutputSectionName, number>;
	hasExtraProtocolBlocks: boolean;
} {
	const openingCounts = new Map<WorkflowOutputSectionName, number>();
	const addOpenings = (
		counts: ReadonlyMap<WorkflowOutputSectionName, number>,
	): void => {
		for (const [name, count] of counts) {
			openingCounts.set(name, (openingCounts.get(name) ?? 0) + count);
		}
	};
	for (const observation of observations) {
		openingCounts.set(
			observation.name,
			(openingCounts.get(observation.name) ?? 0) + 1,
		);
		addOpenings(
			countStructuralSectionOpenings(
				raw.slice(observation.contentStart, observation.contentEnd),
				observation.name,
			),
		);
	}

	for (const range of collectOutsideRanges(raw.length, observations)) {
		addOpenings(countStructuralSectionOpenings(raw.slice(range.start, range.end)));
	}

	const duplicateNames = new Set<WorkflowOutputSectionName>();
	let hasExtraProtocolBlocks = false;
	const duplicateCounts = new Map<WorkflowOutputSectionName, number>();
	for (const name of CANONICAL_SECTION_ORDER) {
		const count = openingCounts.get(name) ?? 0;
		if (count > 1) duplicateNames.add(name);
		if (duplicateNames.has(name)) duplicateCounts.set(name, Math.max(count, 2));
		if (count > observations.filter((observation) => observation.name === name).length) {
			hasExtraProtocolBlocks = true;
		}
	}
	return { duplicateNames, duplicateCounts, hasExtraProtocolBlocks };
}

function collectOutsideRanges(
	rawLength: number,
	observations: readonly SectionObservation[],
): TextRange[] {
	const ranges: TextRange[] = [];
	let cursor = 0;
	for (const observation of observations) {
		if (cursor < observation.start) {
			ranges.push({ start: cursor, end: observation.start });
		}
		cursor = Math.max(cursor, observation.end ?? observation.contentEnd);
	}
	if (cursor < rawLength) ranges.push({ start: cursor, end: rawLength });
	return ranges;
}

function collectOutsideTextRanges(
	raw: string,
	sections: readonly SectionMatch[],
): TextRange[] {
	const ranges: TextRange[] = [];
	let cursor = 0;
	for (const section of sections) {
		if (
			cursor < section.start &&
			raw.slice(cursor, section.start).trim().length > 0
		) {
			ranges.push({ start: cursor, end: section.start });
		}
		cursor = section.end;
	}
	if (raw.slice(cursor).trim().length > 0) {
		ranges.push({ start: cursor, end: raw.length });
	}
	return ranges;
}

function countStructuralSectionOpenings(
	text: string,
	initialSection?: WorkflowOutputSectionName,
): ReadonlyMap<WorkflowOutputSectionName, number> {
	const counts = new Map<WorkflowOutputSectionName, number>();
	const analysisMarkers = analyzeAnalysisMarkers(text);
	const selectedAnalysisContent = initialSection === SECTION_ANALYSIS;
	const completeJsonSectionOpenings = new Set([
		...findCompleteJsonSectionOpenings(text, SECTION_CONTROL),
		...findCompleteJsonSectionOpenings(text, SECTION_REFS),
	]);
	let activeSection = initialSection;
	let analysisDepth = activeSection === SECTION_ANALYSIS ? 1 : 0;
	let analysisClosedLiteral = false;
	let inJsonString = false;
	let escaped = false;
	const recordOpening = (opening: WorkflowOutputSectionName): void => {
		counts.set(opening, (counts.get(opening) ?? 0) + 1);
		activeSection = opening;
		analysisDepth = opening === SECTION_ANALYSIS ? 1 : 0;
		analysisClosedLiteral = false;
		inJsonString = false;
		escaped = false;
	};

	for (let index = 0; index < text.length; index += 1) {
		if (activeSection === SECTION_ANALYSIS) {
			const opening = sectionOpeningAt(text, index);
			if (
				opening &&
				opening !== SECTION_ANALYSIS &&
				analysisClosedLiteral &&
				completeJsonSectionOpenings.has(index)
			) {
				recordOpening(opening);
				index += `<${opening}>`.length - 1;
				continue;
			}

			const openTag = `<${SECTION_ANALYSIS}>`;
			const closeTag = `</${SECTION_ANALYSIS}>`;
			if (opening === SECTION_ANALYSIS) {
				const balancedLiteral =
					selectedAnalysisContent &&
					analysisMarkers.balancedSuffixOpenings.has(index);
				if (analysisClosedLiteral && !balancedLiteral) {
					recordOpening(SECTION_ANALYSIS);
				} else {
					analysisDepth += 1;
				}
				index += openTag.length - 1;
				continue;
			}
			if (text.startsWith(closeTag, index)) {
				analysisDepth = Math.max(0, analysisDepth - 1);
				analysisClosedLiteral = true;
				if (analysisDepth === 0 && !selectedAnalysisContent) {
					activeSection = undefined;
				}
				index += closeTag.length - 1;
			}
			continue;
		}

		if (activeSection !== undefined) {
			const char = text[index] ?? "";
			if (escaped) {
				escaped = false;
				continue;
			}
			if (inJsonString && char === "\\") {
				escaped = true;
				continue;
			}
			if (char === '"') {
				inJsonString = !inJsonString;
				continue;
			}
			if (inJsonString) continue;
			const closeTag = `</${activeSection}>`;
			if (text.startsWith(closeTag, index)) {
				activeSection = undefined;
				index += closeTag.length - 1;
				continue;
			}
		}

		const opening = sectionOpeningAt(text, index);
		if (!opening) continue;
		recordOpening(opening);
		index += `<${opening}>`.length - 1;
	}
	return counts;
}

function sectionOpeningAt(
	text: string,
	index: number,
): WorkflowOutputSectionName | undefined {
	return CANONICAL_SECTION_ORDER.find((name) =>
		text.startsWith(`<${name}>`, index),
	);
}

function analyzeAnalysisMarkers(text: string): {
	balancedSuffixOpenings: ReadonlySet<number>;
} {
	const openTag = `<${SECTION_ANALYSIS}>`;
	const closeTag = `</${SECTION_ANALYSIS}>`;
	const markers: Array<{ index: number; delta: 1 | -1 }> = [];
	for (let index = 0; index < text.length; index += 1) {
		if (text.startsWith(openTag, index)) {
			markers.push({ index, delta: 1 });
			index += openTag.length - 1;
			continue;
		}
		if (text.startsWith(closeTag, index)) {
			markers.push({ index, delta: -1 });
			index += closeTag.length - 1;
		}
	}

	const cumulative: number[] = [];
	let balance = 0;
	for (const marker of markers) {
		balance += marker.delta;
		cumulative.push(balance);
	}
	const suffixMinimum: number[] = Array.from({ length: markers.length });
	let runningMinimum = Number.POSITIVE_INFINITY;
	for (let index = markers.length - 1; index >= 0; index -= 1) {
		runningMinimum = Math.min(runningMinimum, cumulative[index] ?? 0);
		suffixMinimum[index] = runningMinimum;
	}

	const balancedSuffixOpenings = new Set<number>();
	for (let index = markers.length - 1; index >= 0; index -= 1) {
		const marker = markers[index];
		if (!marker || marker.delta === -1) continue;
		const balanceBefore = index === 0 ? 0 : (cumulative[index - 1] ?? 0);
		if (
			balance - balanceBefore === 0 &&
			(suffixMinimum[index] ?? Number.NEGATIVE_INFINITY) >= balanceBefore
		) {
			balancedSuffixOpenings.add(marker.index);
		}
	}
	return { balancedSuffixOpenings };
}

function findCompleteJsonSectionOpenings(
	text: string,
	name: typeof SECTION_CONTROL | typeof SECTION_REFS,
): ReadonlySet<number> {
	const complete = new Set<number>();
	const pending: number[] = [];
	const openTag = `<${name}>`;
	const closeTag = `</${name}>`;
	let inJsonString = false;
	let escaped = false;
	for (let index = 0; index < text.length; index += 1) {
		if (pending.length === 0) {
			if (!text.startsWith(openTag, index)) continue;
			pending.push(index);
			inJsonString = false;
			escaped = false;
			index += openTag.length - 1;
			continue;
		}
		const char = text[index] ?? "";
		if (escaped) {
			escaped = false;
			continue;
		}
		if (inJsonString && char === "\\") {
			escaped = true;
			continue;
		}
		if (char === '"') {
			inJsonString = !inJsonString;
			continue;
		}
		if (inJsonString) continue;
		if (text.startsWith(openTag, index)) {
			pending.push(index);
			index += openTag.length - 1;
			continue;
		}
		if (!text.startsWith(closeTag, index)) continue;
		const opening = pending.pop();
		if (opening !== undefined) complete.add(opening);
		index += closeTag.length - 1;
	}
	return complete;
}

function validateSectionLayout(
	layout: SectionLayoutScan,
	issues: WorkflowOutputIssue[],
	requirements: SectionRequirements,
): void {
	validateSectionCounts(layout, issues, requirements);
	validateCanonicalOrder(layout.sections, issues);
	validateNoOutsideText(layout.outsideRanges, issues);
}

function parseSanitizedWorkflowOutput(
	raw: string,
	options: ParseWorkflowOutputOptions,
): ParsedWorkflowOutput | undefined {
	const requirements = sectionRequirements(options);
	const layout = scanSectionLayout(raw, requirements);
	// A rejected/incomplete publication must not be discarded as outside prose.
	if (layout.outsideRanges.some((range) =>
		/(?:^|\n)[ \t]*<partial-control\b/i.test(raw.slice(range.start, range.end)),
	)) return undefined;
	if (layout.duplicateNames.size > 0 || layout.hasExtraProtocolBlocks) {
		return undefined;
	}
	if (layout.complete) {
		const sanitized = layout.sections
			.map((section) => raw.slice(section.start, section.end).trim())
			.join("\n");
		if (sanitized !== raw.trim()) {
			const parsed = parseWorkflowOutput(sanitized, options);
			if (parsed.valid) return parsed;
		}
	}
	const repaired = repairMissingTailSections(raw, requirements, layout);
	if (repaired !== undefined) {
		const parsed = parseWorkflowOutput(repaired, options);
		if (parsed.valid) return parsed;
	}
	return undefined;
}

function repairMissingTailSections(
	raw: string,
	requirements: SectionRequirements,
	layout: SectionLayoutScan,
): string | undefined {
	if (!layout.repairEligible) return undefined;
	const observations = new Map(
		layout.observations.map((observation) => [observation.name, observation]),
	);
	const control = observations.get(SECTION_CONTROL);
	if (!control || control.end === undefined) return undefined;
	const contents = new Map<WorkflowOutputSectionName, string>();
	contents.set(
		SECTION_CONTROL,
		raw.slice(control.contentStart, control.contentEnd).trim(),
	);
	if (requirements.analysisRequired || observations.has(SECTION_ANALYSIS)) {
		const analysis = observations.get(SECTION_ANALYSIS);
		if (!analysis) return undefined;
		const content = raw
			.slice(analysis.contentStart, analysis.contentEnd)
			.trim();
		if (content.length === 0) return undefined;
		contents.set(SECTION_ANALYSIS, content);
	}
	if (requirements.refsRequired || observations.has(SECTION_REFS)) {
		const refs = observations.get(SECTION_REFS);
		// Optional supplied JSON must validate, not disappear during tail repair.
		if (!requirements.refsRequired && refs?.end === undefined) return undefined;
		contents.set(
			SECTION_REFS,
			refs?.end === undefined
				? "[]"
				: raw.slice(refs.contentStart, refs.contentEnd).trim(),
		);
	}
	return CANONICAL_SECTION_ORDER.filter((name) => contents.has(name))
		.flatMap((name) => [
			`<${name}>`,
			contents.get(name) ?? "",
			`</${name}>`,
		])
		.join("\n");
}

function validateSectionCounts(
	layout: SectionLayoutScan,
	issues: WorkflowOutputIssue[],
	requirements: SectionRequirements,
): void {
	for (const name of CANONICAL_SECTION_ORDER) {
		const required = sectionRequired(name, requirements);
		const count = layout.sections.filter(
			(section) => section.name === name,
		).length;
		if (required && count === 0) issues.push(missingSectionIssue(name));
		if (layout.duplicateNames.has(name)) {
			issues.push(
				duplicateSectionIssue(name, layout.duplicateCounts.get(name) ?? 2),
			);
		}
	}
}

function validateCanonicalOrder(
	sections: readonly SectionMatch[],
	issues: WorkflowOutputIssue[],
): void {
	if (sections.length === 0) return;
	const actual = sections.map((section) => section.name);
	const expected = CANONICAL_SECTION_ORDER.filter((name) => actual.includes(name));
	if (sameArray(actual, expected)) return;
	issues.push({
		code: "unexpected_text",
		message: `sections must appear in canonical order: ${expected.join(", ")}; got ${actual.join(",")}`,
	});
}

function validateNoOutsideText(
	outsideRanges: readonly TextRange[],
	issues: WorkflowOutputIssue[],
): void {
	if (outsideRanges.length > 0) issues.push(outsideTextIssue());
}

function parseControlSection(
	text: string | undefined,
	issues: WorkflowOutputIssue[],
	repairs: WorkflowOutputRepair[],
	options: ParseWorkflowOutputOptions,
): Record<string, unknown> | undefined {
	if (text === undefined) return undefined;
	const parsed = parseJsonSection(text, SECTION_CONTROL, issues);
	if (parsed === undefined) return undefined;
	if (!isPlainRecord(parsed)) {
		issues.push({
			code: "invalid_type",
			section: SECTION_CONTROL,
			message: "control must be a JSON object",
		});
		return undefined;
	}
	const normalized = normalizeWorkflowControl(
		parsed,
		options.controlJsonSchema,
		repairs,
	);
	validateBaseControl(normalized, issues, options);
	return normalized;
}

function normalizeWorkflowControl(
	control: Record<string, unknown>,
	schema: JsonSchema | undefined,
	repairs: WorkflowOutputRepair[],
): Record<string, unknown> {
	const normalized = normalizeControlValue(control);
	const record = isPlainRecord(normalized) ? normalized : control;
	return normalizeKnownWorkflowControlSchema(record, schema, repairs);
}

function normalizeKnownWorkflowControlSchema(
	control: Record<string, unknown>,
	schema: JsonSchema | undefined,
	repairs: WorkflowOutputRepair[],
): Record<string, unknown> {
	if (!isJsonSchemaObject(schema)) return control;
	let normalized = control;
	const properties = schema.properties ?? {};
	if (isSeverityStatusSchema(properties.status)) {
		const repairedStatus = severityStatusFromLifecycle(control.status);
		if (repairedStatus !== undefined) {
			normalized = { ...normalized, status: repairedStatus };
			repairs.push({
				code: "control_status_lifecycle_to_unknown",
				section: SECTION_CONTROL,
				path: "$.status",
				message: "normalized lifecycle status text to unknown severity status",
			});
		}
	}
	if (
		control.sources === undefined &&
		Array.isArray(schema.required) &&
		schema.required.includes("sources") &&
		isArrayJsonSchema(properties.sources)
	) {
		normalized = { ...normalized, sources: [] };
		repairs.push({
			code: "control_missing_required_sources_empty_array",
			section: SECTION_CONTROL,
			path: "$.sources",
			message: "inserted empty required sources array",
		});
	}
	if (isPlainRecord(control.budgetLedger)) {
		const budgetLedgerSchema = properties.budgetLedger;
		const budgetLedgerProperties = isJsonSchemaObject(budgetLedgerSchema)
			? (budgetLedgerSchema.properties ?? {})
			: {};
		const repairedBudgetLedger = normalizeBudgetLedgerArrays(
			control.budgetLedger,
			budgetLedgerProperties,
		);
		if (repairedBudgetLedger !== control.budgetLedger) {
			normalized = { ...normalized, budgetLedger: repairedBudgetLedger };
			repairs.push({
				code: "control_budget_ledger_array_fields",
				section: SECTION_CONTROL,
				path: "$.budgetLedger",
				message: "normalized budget ledger query fields to arrays",
			});
		}
	}
	if (
		Array.isArray(control.additionalUnverifiedLeads) &&
		isArrayOfObjectJsonSchema(properties.additionalUnverifiedLeads)
	) {
		const repairedLeads = normalizeObjectArrayRows(
			control.additionalUnverifiedLeads,
			"note",
		);
		if (repairedLeads !== control.additionalUnverifiedLeads) {
			normalized = {
				...normalized,
				additionalUnverifiedLeads: repairedLeads,
			};
			repairs.push({
				code: "control_additional_unverified_leads_objects",
				section: SECTION_CONTROL,
				path: "$.additionalUnverifiedLeads",
				message: "normalized additional unverified leads to objects",
			});
		}
	}
	if (Array.isArray(control.factSlotCoverage)) {
		const repairedCoverage = normalizeObjectArrayStringFields(
			control.factSlotCoverage,
			properties.factSlotCoverage,
			["gapReason"],
		);
		if (repairedCoverage !== control.factSlotCoverage) {
			normalized = { ...normalized, factSlotCoverage: repairedCoverage };
			repairs.push({
				code: "control_fact_slot_coverage_string_fields",
				section: SECTION_CONTROL,
				path: "$.factSlotCoverage",
				message: "normalized fact slot coverage string fields",
			});
		}
	}
	if (isDeepResearchFinalSynthesisSchema(schema)) {
		const repairedSynthesis = normalizeFinalSynthesisArrayCaps(
			control.synthesis,
			schema,
		);
		if (repairedSynthesis.value !== control.synthesis) {
			normalized = { ...normalized, synthesis: repairedSynthesis.value };
			repairs.push({
				code: "control_final_synthesis_array_caps",
				section: SECTION_CONTROL,
				path: "$.synthesis",
				message: finalSynthesisCapRepairMessage(repairedSynthesis.dropped),
			});
		}
	}
	const rowRepaired = normalizeBareStringObjectRows(
		normalized,
		schema,
		"$",
		repairs,
	);
	if (isPlainRecord(rowRepaired)) normalized = rowRepaired;
	const enumRepaired = normalizeEnumNearMisses(
		normalized,
		schema,
		"$",
		repairs,
	);
	if (isPlainRecord(enumRepaired)) normalized = enumRepaired;
	return normalized;
}

// Schema-driven repair for bare-string rows in arrays whose items must be
// objects — the dominant retry class measured on impact-review (~11 output
// retries/run, "value must be of type object"). A string row is wrapped into
// an object only when the wrap is valid by construction: free-form object
// items (no required properties) wrap as { note: <string> } (or a preferred
// declared string property), and items with exactly one required string
// property wrap into that property. Rows whose schemas require multiple
// properties are left untouched so validation still fails closed.
const OBJECT_ROW_TEXT_KEY_PREFERENCE = [
	"note",
	"text",
	"summary",
	"description",
	"message",
	"reason",
	"title",
	"item",
];

function normalizeBareStringObjectRows(
	value: unknown,
	schema: JsonSchema | undefined,
	path: string,
	repairs: WorkflowOutputRepair[],
): unknown {
	if (!isJsonSchemaObject(schema)) return value;
	if (Array.isArray(value)) {
		const itemSchema = Array.isArray(schema.items) ? undefined : schema.items;
		if (!isJsonSchemaObject(itemSchema)) return value;
		let normalized: unknown[] | undefined;
		for (const [index, item] of value.entries()) {
			let repaired = item;
			if (typeof item === "string" && schemaHasType(itemSchema, "object")) {
				const textKey = objectRowTextKey(itemSchema);
				if (textKey !== undefined && item.trim().length > 0) {
					repaired = { [textKey]: item.trim() };
					repairs.push({
						code: "control_object_row_from_string",
						section: SECTION_CONTROL,
						path: `${path}[${index}]`,
						message: `wrapped bare string row into { ${JSON.stringify(textKey)}: ... }`,
					});
				}
			} else {
				repaired = normalizeBareStringObjectRows(
					item,
					itemSchema,
					`${path}[${index}]`,
					repairs,
				);
			}
			if (repaired !== item) {
				if (normalized === undefined) normalized = [...value];
				normalized[index] = repaired;
			}
		}
		return normalized ?? value;
	}
	if (isPlainRecord(value) && schemaHasType(schema, "object")) {
		const properties = schema.properties ?? {};
		let normalized: Record<string, unknown> | undefined;
		for (const [key, child] of Object.entries(properties)) {
			if (!(key in value)) continue;
			const repaired = normalizeBareStringObjectRows(
				value[key],
				child,
				`${path}.${key}`,
				repairs,
			);
			if (repaired !== value[key]) {
				if (normalized === undefined) normalized = { ...value };
				normalized[key] = repaired;
			}
		}
		return normalized ?? value;
	}
	return value;
}

function objectRowTextKey(itemSchema: JsonSchemaObject): string | undefined {
	const properties = itemSchema.properties ?? {};
	const required = Array.isArray(itemSchema.required)
		? itemSchema.required
		: [];
	const stringProps = Object.entries(properties)
		.filter(
			([, child]) => isJsonSchemaObject(child) && isStringJsonSchema(child),
		)
		.map(([key]) => key);
	if (required.length === 1) {
		const key = required[0];
		return typeof key === "string" && stringProps.includes(key)
			? key
			: undefined;
	}
	if (required.length > 1) return undefined;
	for (const preferred of OBJECT_ROW_TEXT_KEY_PREFERENCE) {
		if (Object.keys(properties).length === 0) return "note";
		if (stringProps.includes(preferred)) return preferred;
	}
	if (Object.keys(properties).length === 0) return "note";
	return stringProps[0];
}

// Schema-driven repair for enum near-misses: a string value that fails an enum
// is replaced only when it maps to exactly one allowed value via (tier 1)
// case/separator-insensitive equality — e.g. "cf-001" vs "CF-001", "keep" vs
// "KEEP" — or (tier 2) a unique token-subset match — e.g.
// "declared-but-unused-dependency" vs "declared-unused-dependency". Ambiguous
// or distant values are left untouched so validation still fails closed, and
// every replacement is recorded as a typed repair.
function normalizeEnumNearMisses(
	value: unknown,
	schema: JsonSchema | undefined,
	path: string,
	repairs: WorkflowOutputRepair[],
): unknown {
	if (!isJsonSchemaObject(schema)) return value;
	if (
		typeof value === "string" &&
		Array.isArray(schema.enum) &&
		schema.enum.every((option) => typeof option === "string")
	) {
		const options = schema.enum as string[];
		if (options.includes(value)) return value;
		const match = uniqueEnumNearMiss(value, options);
		if (match !== undefined) {
			repairs.push({
				code: "control_enum_near_miss",
				section: SECTION_CONTROL,
				path,
				message: `normalized enum near miss ${JSON.stringify(value)} to ${JSON.stringify(match)}`,
			});
			return match;
		}
		return value;
	}
	if (Array.isArray(value)) {
		const itemSchema = Array.isArray(schema.items) ? undefined : schema.items;
		if (!isJsonSchemaObject(itemSchema)) return value;
		let normalized: unknown[] | undefined;
		for (const [index, item] of value.entries()) {
			const repaired = normalizeEnumNearMisses(
				item,
				itemSchema,
				`${path}[${index}]`,
				repairs,
			);
			if (repaired !== item) {
				if (normalized === undefined) normalized = [...value];
				normalized[index] = repaired;
			}
		}
		return normalized ?? value;
	}
	if (isPlainRecord(value) && schemaHasType(schema, "object")) {
		const properties = schema.properties ?? {};
		let normalized: Record<string, unknown> | undefined;
		for (const [key, child] of Object.entries(properties)) {
			if (!(key in value)) continue;
			const repaired = normalizeEnumNearMisses(
				value[key],
				child,
				`${path}.${key}`,
				repairs,
			);
			if (repaired !== value[key]) {
				if (normalized === undefined) normalized = { ...value };
				normalized[key] = repaired;
			}
		}
		return normalized ?? value;
	}
	return value;
}

function enumComparableForm(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function enumTokens(value: string): string[] {
	return value
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((token) => token.length > 0);
}

// Tokens that flip the meaning of an enum value. A tier-2 subset match must
// never bridge a negation difference: repairing "verification-needed" into
// "verification-not-needed" would silently invert the model's statement.
const ENUM_NEGATION_TOKENS = new Set([
	"not",
	"no",
	"non",
	"never",
	"none",
	"without",
]);

function uniqueEnumNearMiss(
	value: string,
	options: string[],
): string | undefined {
	const comparable = enumComparableForm(value);
	if (comparable.length === 0) return undefined;
	const exact = options.filter(
		(option) => enumComparableForm(option) === comparable,
	);
	if (exact.length === 1) return exact[0];
	if (exact.length > 1) return undefined;
	const valueTokens = new Set(enumTokens(value));
	if (valueTokens.size === 0) return undefined;
	const subsetMatches = options.filter((option) => {
		const optionTokens = new Set(enumTokens(option));
		if (optionTokens.size === 0) return false;
		const [smaller, larger] =
			optionTokens.size <= valueTokens.size
				? [optionTokens, valueTokens]
				: [valueTokens, optionTokens];
		if (larger.size - smaller.size > 2) return false;
		for (const token of smaller) if (!larger.has(token)) return false;
		if (smaller.size < 2) return false;
		for (const token of larger) {
			if (!smaller.has(token) && ENUM_NEGATION_TOKENS.has(token)) return false;
		}
		return true;
	});
	return subsetMatches.length === 1 ? subsetMatches[0] : undefined;
}

function isDeepResearchFinalSynthesisSchema(schema: JsonSchemaObject): boolean {
	const schemaProperty = schema.properties?.schema;
	return (
		isJsonSchemaObject(schemaProperty) &&
		schemaProperty.const === "deep-research-final-synthesis-v1"
	);
}

type FinalSynthesisRepair = {
	value: unknown;
	dropped: Record<string, number>;
};

type FinalSynthesisRowCaps = {
	maxRows: number | undefined;
	arrayFields: Record<string, number>;
};

type FinalSynthesisCaps = {
	arrays: Record<string, number>;
	rows: Record<string, FinalSynthesisRowCaps>;
};

function normalizeFinalSynthesisArrayCaps(
	synthesis: unknown,
	schema: JsonSchemaObject,
): FinalSynthesisRepair {
	if (!isPlainRecord(synthesis)) return { value: synthesis, dropped: {} };
	const caps = finalSynthesisCapsFromSchema(schema);
	let normalized: Record<string, unknown> = synthesis;
	const dropped: Record<string, number> = {};
	for (const [key, maxItems] of Object.entries(caps.arrays)) {
		const capped = cappedArray(synthesis[key], maxItems);
		if (capped.value !== synthesis[key]) {
			if (normalized === synthesis) normalized = { ...normalized };
			normalized[key] = capped.value;
			dropped[key] = (dropped[key] ?? 0) + capped.dropped;
		}
	}
	for (const [key, rowCaps] of Object.entries(caps.rows)) {
		const cappedRows = normalizeFinalSynthesisRows(
			synthesis[key],
			key,
			rowCaps,
			dropped,
		);
		if (cappedRows !== synthesis[key]) {
			if (normalized === synthesis) normalized = { ...normalized };
			normalized[key] = cappedRows;
		}
	}
	return { value: normalized, dropped };
}

function finalSynthesisCapsFromSchema(
	schema: JsonSchemaObject,
): FinalSynthesisCaps {
	const synthesisSchema = schema.properties?.synthesis;
	const properties = isJsonSchemaObject(synthesisSchema)
		? (synthesisSchema.properties ?? {})
		: {};
	return {
		arrays: compactNumberRecord({
			keyFindingIds: arrayMaxItems(properties.keyFindingIds),
			notableUnsupportedClaimIds: arrayMaxItems(
				properties.notableUnsupportedClaimIds,
			),
			contestedClaimIds: arrayMaxItems(properties.contestedClaimIds),
		}),
		rows: compactRowCaps({
			recommendations: rowCaps(properties.recommendations, [
				"supportingClaimIds",
			]),
			actionPlan: rowCaps(properties.actionPlan, ["supportingClaimIds"]),
			parentDecisionNotes: rowCaps(properties.parentDecisionNotes, [
				"supportingClaimIds",
			]),
			caveatNotes: rowCaps(properties.caveatNotes, [
				"relatedClaimIds",
				"gapIds",
			]),
		}),
	};
}

function rowCaps(
	schema: JsonSchema | undefined,
	arrayFields: string[],
): FinalSynthesisRowCaps | undefined {
	if (!isJsonSchemaObject(schema)) return undefined;
	const itemSchema = !Array.isArray(schema.items) ? schema.items : undefined;
	const itemProperties = isJsonSchemaObject(itemSchema)
		? (itemSchema.properties ?? {})
		: {};
	const fields: Record<string, number> = {};
	for (const field of arrayFields) {
		const maxItems = arrayMaxItems(itemProperties[field]);
		if (maxItems !== undefined) fields[field] = maxItems;
	}
	const maxRows = arrayMaxItems(schema);
	if (maxRows === undefined && Object.keys(fields).length === 0)
		return undefined;
	return { maxRows, arrayFields: fields };
}

function compactNumberRecord(
	values: Record<string, number | undefined>,
): Record<string, number> {
	const compacted: Record<string, number> = {};
	for (const [key, value] of Object.entries(values)) {
		if (value !== undefined) compacted[key] = value;
	}
	return compacted;
}

function compactRowCaps(
	values: Record<string, FinalSynthesisRowCaps | undefined>,
): Record<string, FinalSynthesisRowCaps> {
	const compacted: Record<string, FinalSynthesisRowCaps> = {};
	for (const [key, value] of Object.entries(values)) {
		if (value !== undefined) compacted[key] = value;
	}
	return compacted;
}

function arrayMaxItems(schema: JsonSchema | undefined): number | undefined {
	if (!isJsonSchemaObject(schema) || typeof schema.maxItems !== "number")
		return undefined;
	return Number.isFinite(schema.maxItems) && schema.maxItems >= 0
		? Math.floor(schema.maxItems)
		: undefined;
}

function normalizeFinalSynthesisRows(
	value: unknown,
	key: string,
	caps: FinalSynthesisRowCaps,
	dropped: Record<string, number>,
): unknown {
	if (!Array.isArray(value)) return value;
	let normalized: unknown[] | undefined;
	const cappedRows =
		caps.maxRows !== undefined && value.length > caps.maxRows
			? value.slice(0, caps.maxRows)
			: value;
	if (cappedRows !== value && caps.maxRows !== undefined) {
		dropped[key] = (dropped[key] ?? 0) + value.length - caps.maxRows;
	}
	for (const [index, row] of cappedRows.entries()) {
		if (!isPlainRecord(row)) continue;
		let repaired = row;
		for (const [field, maxItems] of Object.entries(caps.arrayFields)) {
			const capped = cappedArray(row[field], maxItems);
			if (capped.value === row[field]) continue;
			if (repaired === row) repaired = { ...row };
			repaired[field] = capped.value;
			const dropKey = `${key}.${field}`;
			dropped[dropKey] = (dropped[dropKey] ?? 0) + capped.dropped;
		}
		if (repaired !== row) {
			if (normalized === undefined) normalized = [...cappedRows];
			normalized[index] = repaired;
		}
	}
	if (normalized !== undefined) return normalized;
	return cappedRows === value ? value : cappedRows;
}

function cappedArray(
	value: unknown,
	maxItems: number,
): { value: unknown; dropped: number } {
	if (!Array.isArray(value) || value.length <= maxItems)
		return { value, dropped: 0 };
	return { value: value.slice(0, maxItems), dropped: value.length - maxItems };
}

function finalSynthesisCapRepairMessage(
	dropped: Record<string, number>,
): string {
	const entries = Object.entries(dropped).filter(([, count]) => count > 0);
	if (entries.length === 0)
		return "clamped final synthesis arrays to schema caps";
	const detail = entries
		.slice(0, 8)
		.map(([path, count]) => `${path}:-${count}`)
		.join(", ");
	const suffix = entries.length > 8 ? ", …" : "";
	return `clamped final synthesis arrays to schema caps (${detail}${suffix})`;
}

function isJsonSchemaObject(
	schema: JsonSchema | undefined,
): schema is JsonSchemaObject {
	return (
		typeof schema === "object" && schema !== null && !Array.isArray(schema)
	);
}

function isArrayJsonSchema(schema: JsonSchema | undefined): boolean {
	if (!isJsonSchemaObject(schema)) return false;
	return schemaHasType(schema, "array");
}

function isArrayOfObjectJsonSchema(schema: JsonSchema | undefined): boolean {
	if (!isJsonSchemaObject(schema) || !schemaHasType(schema, "array"))
		return false;
	const items = schema.items;
	return (
		!Array.isArray(items) &&
		isJsonSchemaObject(items) &&
		schemaHasType(items, "object")
	);
}

function isSeverityStatusSchema(schema: JsonSchema | undefined): boolean {
	if (!isJsonSchemaObject(schema) || !Array.isArray(schema.enum)) return false;
	const values = new Set(schema.enum);
	return ["none", "low", "medium", "high", "unknown"].every((value) =>
		values.has(value),
	);
}

function severityStatusFromLifecycle(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (
		[
			"complete",
			"completed",
			"done",
			"ok",
			"pass",
			"passed",
			"success",
			"succeeded",
		].includes(normalized)
	) {
		return "unknown";
	}
	return undefined;
}

function normalizeBudgetLedgerArrays(
	budgetLedger: Record<string, unknown>,
	properties: Record<string, JsonSchema>,
): Record<string, unknown> {
	let normalized = budgetLedger;
	for (const key of ["searchQueriesAttempted", "omittedSearchQueries"]) {
		if (!isArrayJsonSchema(properties[key])) continue;
		const repaired = stringArrayFromLedgerValue(budgetLedger[key]);
		if (repaired === undefined) continue;
		if (normalized === budgetLedger) normalized = { ...budgetLedger };
		normalized[key] = repaired;
	}
	return normalized;
}

function stringArrayFromLedgerValue(value: unknown): string[] | undefined {
	if (value === undefined || Array.isArray(value)) return undefined;
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? [trimmed] : [];
	}
	if (isPlainRecord(value)) {
		return Object.values(value)
			.filter((item): item is string => typeof item === "string")
			.map((item) => item.trim())
			.filter((item) => item.length > 0);
	}
	return [];
}

function normalizeObjectArrayRows(rows: unknown[], textKey: string): unknown[] {
	let normalized: unknown[] | undefined;
	for (const [index, row] of rows.entries()) {
		let repaired = row;
		if (typeof row === "string") {
			const trimmed = row.trim();
			repaired = trimmed.length > 0 ? { [textKey]: trimmed } : {};
		}
		if (repaired !== row) {
			if (normalized === undefined) normalized = [...rows];
			normalized[index] = repaired;
		}
	}
	return normalized ?? rows;
}

function normalizeObjectArrayStringFields(
	rows: unknown[],
	arraySchema: JsonSchema | undefined,
	fieldNames: string[],
): unknown[] {
	if (!isJsonSchemaObject(arraySchema) || !schemaHasType(arraySchema, "array"))
		return rows;
	const itemSchema = !Array.isArray(arraySchema.items)
		? arraySchema.items
		: undefined;
	if (!isJsonSchemaObject(itemSchema) || !schemaHasType(itemSchema, "object"))
		return rows;
	const itemProperties = itemSchema.properties ?? {};
	const itemRequired = Array.isArray(itemSchema.required)
		? itemSchema.required
		: [];
	let normalized: unknown[] | undefined;
	for (const [index, row] of rows.entries()) {
		if (!isPlainRecord(row)) continue;
		let repaired = row;
		for (const field of fieldNames) {
			if (!isStringJsonSchema(itemProperties[field])) continue;
			if (!(field in row)) continue;
			const value = row[field];
			if (typeof value === "string") continue;
			if (value == null && !itemRequired.includes(field)) {
				if (repaired === row) repaired = { ...row };
				delete repaired[field];
				continue;
			}
			const text = stringFromStructuredFieldValue(value);
			if (text !== undefined) {
				if (repaired === row) repaired = { ...row };
				repaired[field] = text;
			}
		}
		if (repaired !== row) {
			if (normalized === undefined) normalized = [...rows];
			normalized[index] = repaired;
		}
	}
	return normalized ?? rows;
}

function isStringJsonSchema(schema: JsonSchema | undefined): boolean {
	if (!isJsonSchemaObject(schema)) return false;
	return schemaHasType(schema, "string");
}

function stringFromStructuredFieldValue(value: unknown): string | undefined {
	if (typeof value === "number" || typeof value === "boolean")
		return String(value);
	if (isPlainRecord(value)) {
		for (const key of ["reason", "message", "summary", "note", "text"]) {
			const candidate = value[key];
			if (typeof candidate === "string" && candidate.trim())
				return candidate.trim();
		}
	}
	return undefined;
}

function schemaHasType(schema: JsonSchemaObject, type: string): boolean {
	return Array.isArray(schema.type)
		? schema.type.includes(type)
		: schema.type === type;
}

function normalizeControlValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeControlValue);
	if (!isPlainRecord(value)) return value;
	const normalized: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		normalized[key] =
			key === "locations" && Array.isArray(child)
				? child.map(normalizeLocationValue)
				: normalizeControlValue(child);
	}
	return normalized;
}

function normalizeLocationValue(value: unknown): unknown {
	if (typeof value === "string") return parseLocationString(value) ?? value;
	if (!isPlainRecord(value)) return value;
	const normalized: Record<string, unknown> = { ...value };
	if (typeof normalized.file === "string" && normalized.line === undefined) {
		const parsed = parseLocationString(normalized.file);
		if (parsed !== undefined) {
			normalized.file = parsed.file;
			normalized.line = parsed.line;
			if (parsed.lineEnd !== undefined) normalized.lineEnd = parsed.lineEnd;
		}
	}
	if (typeof normalized.line === "string") {
		const parsed = parseLineRange(normalized.line);
		if (parsed !== undefined) {
			normalized.line = parsed.line;
			if (normalized.lineEnd === undefined && parsed.lineEnd !== undefined)
				normalized.lineEnd = parsed.lineEnd;
		}
	}
	if (typeof normalized.lineEnd === "string") {
		const parsed = parsePositiveInteger(normalized.lineEnd);
		if (parsed !== undefined) normalized.lineEnd = parsed;
	}
	return normalized;
}

function parseLocationString(
	value: string,
): { file: string; line: number; lineEnd?: number } | undefined {
	const match = /^(.+?):(\d+)(?:\s*[-–—]\s*(\d+))?$/.exec(value.trim());
	if (!match) return undefined;
	const file = match[1]?.trim();
	const line = parsePositiveInteger(match[2] ?? "");
	const lineEnd = parsePositiveInteger(match[3] ?? "");
	if (!file || line === undefined) return undefined;
	return lineEnd !== undefined && lineEnd >= line
		? { file, line, lineEnd }
		: { file, line };
}

function parseLineRange(
	value: string,
): { line: number; lineEnd?: number } | undefined {
	const match = /^(\d+)(?:\s*[-–—]\s*(\d+))?$/.exec(value.trim());
	if (!match) return undefined;
	const line = parsePositiveInteger(match[1] ?? "");
	const lineEnd = parsePositiveInteger(match[2] ?? "");
	if (line === undefined) return undefined;
	return lineEnd !== undefined && lineEnd >= line
		? { line, lineEnd }
		: { line };
}

function parsePositiveInteger(value: string): number | undefined {
	if (!/^\d+$/.test(value.trim())) return undefined;
	const parsed = Number(value.trim());
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseAnalysisSection(
	text: string | undefined,
	issues: WorkflowOutputIssue[],
	requirements: SectionRequirements,
): string | undefined {
	if (text === undefined) return requirements.analysisRequired ? undefined : "";
	if (requirements.analysisRequired && text.trim().length === 0) {
		issues.push({
			code: "empty_section",
			section: SECTION_ANALYSIS,
			message: "analysis section must not be empty",
		});
	}
	return text;
}

function parseRefsSection(
	text: string | undefined,
	issues: WorkflowOutputIssue[],
	requirements: SectionRequirements,
): unknown[] | undefined {
	if (text === undefined) return requirements.refsRequired ? undefined : [];
	const parsed = parseJsonSection(text, SECTION_REFS, issues);
	if (parsed === undefined) return undefined;
	if (Array.isArray(parsed)) {
		if (parsed.length < requirements.refsMinItems) {
			issues.push({
				code: "too_few_items",
				section: SECTION_REFS,
				message:
					requirements.refsMinItems === 1
						? "refs must include at least one item"
						: `refs must include at least ${requirements.refsMinItems} items`,
			});
		}
		if (requirements.refsMinItems > 0) validateRefsLocators(parsed, issues);
		return parsed;
	}
	issues.push({
		code: "invalid_type",
		section: SECTION_REFS,
		message: "refs must be a JSON array",
	});
	return undefined;
}

function validateRefsLocators(
	refs: readonly unknown[],
	issues: WorkflowOutputIssue[],
): void {
	refs.forEach((ref, index) => {
		const locator = refLocator(ref);
		if (locator !== undefined && locator.trim().length > 0) return;
		issues.push({
			code: "invalid_ref_locator",
			section: SECTION_REFS,
			path: `refs[${index}]`,
			message:
				"refs items must include a non-empty locator string (string item, or object url/ref/path/taskId/source)",
		});
	});
}

function refLocator(ref: unknown): string | undefined {
	if (typeof ref === "string") return ref;
	if (!ref || typeof ref !== "object") return undefined;
	const record = ref as Record<string, unknown>;
	for (const key of ["url", "ref", "path", "taskId", "source"]) {
		const value = record[key];
		if (typeof value === "string") return value;
	}
	return undefined;
}

function validateRefsAllowedLocators(
	refs: readonly unknown[],
	allowedLocators: readonly string[] | undefined,
): WorkflowOutputIssue[] {
	if (allowedLocators === undefined) return [];
	const allowed = new Set(
		allowedLocators.flatMap((locator) => refLocatorAliases(locator)),
	);
	const issues: WorkflowOutputIssue[] = [];
	refs.forEach((ref, index) => {
		const locator = refLocator(ref);
		if (locator === undefined || locator.trim().length === 0) return;
		const aliases = refLocatorAliases(locator);
		if (aliases.some((alias) => allowed.has(alias))) return;
		issues.push({
			code: "unavailable_ref_locator",
			section: SECTION_REFS,
			path: `refs[${index}]`,
			message: `ref locator is not in the verified upstream source ledger: ${locator}`,
		});
	});
	return issues;
}

function validateVerificationClaimSupport(
	control: Record<string, unknown> | undefined,
	refs: readonly unknown[],
	outputProfile: string | undefined,
): WorkflowOutputIssue[] {
	if (outputProfile !== "verification_result_v1") return [];
	if (!control) return [];
	const verdict = control.verdict ?? control.status;
	if (verdict !== "verified" && verdict !== "weakened") return [];
	const entries = positiveClaimSupportEntries(control);
	if (entries.length === 0) {
		return [
			{
				code: "missing_claim_support",
				section: SECTION_CONTROL,
				path: "$.claimSupports",
				message:
					"verification_result_v1 positive verdict requires at least one positive claimSupports entry",
			},
		];
	}
	const refAliases = new Set(
		refs.flatMap((ref) => {
			const locator = refLocator(ref);
			return locator ? refLocatorAliases(locator) : [];
		}),
	);
	const issues: WorkflowOutputIssue[] = [];
	for (const [index, entry] of entries.entries()) {
		const locators = claimSupportLocators(entry);
		if (locators.length === 0) {
			issues.push({
				code: "missing_claim_support_locator",
				section: SECTION_CONTROL,
				path: `$.claimSupports[${index}].sourceLocators`,
				message:
					"positive claimSupports entries must include at least one source locator",
			});
			continue;
		}
		for (const locator of locators) {
			const aliases = refLocatorAliases(locator);
			if (aliases.some((alias) => refAliases.has(alias))) continue;
			issues.push({
				code: "source_locator_not_in_refs",
				section: SECTION_CONTROL,
				path: `$.claimSupports[${index}].sourceLocators`,
				message: `positive claim support locator must also appear in <refs>: ${locator}`,
			});
		}
	}
	return issues;
}

function positiveClaimSupportEntries(
	control: Record<string, unknown>,
): Record<string, unknown>[] {
	const raw =
		control.claimSupports ??
		control.sourceSupports ??
		control.claimSourceSupport ??
		control.sourceSupport;
	const entries = Array.isArray(raw)
		? raw
		: raw && typeof raw === "object"
			? [raw]
			: hasTopLevelClaimSupportFields(control)
				? [control]
				: [];
	return entries.filter(
		(entry): entry is Record<string, unknown> =>
			!!entry &&
			typeof entry === "object" &&
			!Array.isArray(entry) &&
			isPositiveClaimSupportStatus(
				entry.status ??
					entry.supportStatus ??
					entry.support ??
					entry.verdict ??
					control.verdict ??
					control.status,
			),
	);
}

function hasTopLevelClaimSupportFields(
	control: Record<string, unknown>,
): boolean {
	return [
		"claim",
		"sourceLocators",
		"locators",
		"sources",
		"refs",
		"urls",
		"sourceRefs",
		"excerpt",
		"quote",
	].some((key) => control[key] !== undefined);
}

function claimSupportLocators(entry: Record<string, unknown>): string[] {
	return [
		...refLocatorsField(entry.sourceLocators),
		...refLocatorsField(entry.locators),
		...refLocatorsField(entry.sources),
		...refLocatorsField(entry.refs),
		...refLocatorsField(entry.urls),
		...(refLocator(entry) ? [refLocator(entry)!] : []),
	].filter(Boolean);
}

function refLocatorsField(value: unknown): string[] {
	if (typeof value === "string" && value.trim()) return [value.trim()];
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		const locator = refLocator(item);
		return locator ? [locator] : [];
	});
}

function isPositiveClaimSupportStatus(value: unknown): boolean {
	return (
		value === "supports" ||
		value === "partial" ||
		value === "verified" ||
		value === "weakened"
	);
}

function refLocatorAliases(locator: string): string[] {
	const trimmed = locator.trim();
	if (!trimmed) return [];
	const aliases = new Set<string>([trimmed]);
	try {
		const parsed = new URL(trimmed);
		if (["http:", "https:"].includes(parsed.protocol)) {
			aliases.add(parsed.href);
			if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
				const withoutTrailingSlash = new URL(parsed.href);
				withoutTrailingSlash.pathname = withoutTrailingSlash.pathname.replace(
					/\/+$/u,
					"",
				);
				aliases.add(withoutTrailingSlash.href);
			}
		}
	} catch {
		// Non-URL refs are matched exactly after trimming.
	}
	return [...aliases];
}

async function validateRefsUrlAvailability(
	refs: readonly unknown[],
	option: ParseWorkflowOutputOptions["refsUrlValidation"],
): Promise<WorkflowOutputIssue[]> {
	const config = refsUrlValidationConfig(option);
	if (!config) return [];
	const selectedRefs: Array<{ index: number; href: string }> = [];
	const uniqueHrefs: string[] = [];
	const queuedHrefs = new Set<string>();
	let checkedUrls = 0;
	for (const [index, ref] of refs.entries()) {
		const locator = refLocator(ref);
		const href = locator === undefined ? undefined : httpRefHref(locator);
		if (href === undefined) continue;
		if (checkedUrls >= config.maxUrls) break;
		checkedUrls += 1;
		selectedRefs.push({ index, href });
		if (!queuedHrefs.has(href)) {
			queuedHrefs.add(href);
			uniqueHrefs.push(href);
		}
	}
	if (selectedRefs.length === 0) return [];

	const results = await checkRefUrlsAvailabilityBounded(
		uniqueHrefs,
		config.timeoutMs,
	);
	const issues: WorkflowOutputIssue[] = [];
	for (const { index, href } of selectedRefs) {
		const result = results.get(href);
		if (result === undefined || result.ok) continue;
		issues.push({
			code: "unavailable_ref_locator",
			section: SECTION_REFS,
			path: `refs[${index}]`,
			message: `ref URL is not reachable (${result.reason}): ${redactSensitiveWorkflowText(href)}`,
		});
	}
	return issues;
}

function refsUrlValidationConfig(
	option: ParseWorkflowOutputOptions["refsUrlValidation"],
): { timeoutMs: number; maxUrls: number } | undefined {
	if (!option) return undefined;
	if (option === true) {
		return {
			timeoutMs: DEFAULT_REFS_URL_VALIDATION_TIMEOUT_MS,
			maxUrls: DEFAULT_REFS_URL_VALIDATION_MAX_URLS,
		};
	}
	if (option.enabled === false) return undefined;
	return {
		timeoutMs:
			Number.isInteger(option.timeoutMs) && option.timeoutMs! > 0
				? option.timeoutMs!
				: DEFAULT_REFS_URL_VALIDATION_TIMEOUT_MS,
		maxUrls:
			Number.isInteger(option.maxUrls) && option.maxUrls! > 0
				? option.maxUrls!
				: DEFAULT_REFS_URL_VALIDATION_MAX_URLS,
	};
}

function httpRefHref(locator: string): string | undefined {
	try {
		const parsed = new URL(locator);
		return ["http:", "https:"].includes(parsed.protocol)
			? parsed.href
			: undefined;
	} catch {
		return undefined;
	}
}

type RefUrlAvailabilityResult = { ok: true } | { ok: false; reason: string };

async function checkRefUrlsAvailabilityBounded(
	hrefs: readonly string[],
	timeoutMs: number,
): Promise<Map<string, RefUrlAvailabilityResult>> {
	const results = new Map<string, RefUrlAvailabilityResult>();
	const pending = [...hrefs];
	const activeByHost = new Map<string, number>();
	let active = 0;

	return await new Promise<Map<string, RefUrlAvailabilityResult>>((resolve) => {
		const pump = (): void => {
			if (pending.length === 0 && active === 0) {
				resolve(results);
				return;
			}
			while (active < REFS_URL_VALIDATION_CONCURRENCY) {
				const pendingIndex = pending.findIndex(
					(href) =>
						(activeByHost.get(refUrlHostKey(href)) ?? 0) <
						REFS_URL_VALIDATION_PER_HOST_CONCURRENCY,
				);
				if (pendingIndex < 0) return;
				const [href] = pending.splice(pendingIndex, 1);
				if (href === undefined) return;
				const hostKey = refUrlHostKey(href);
				active += 1;
				activeByHost.set(hostKey, (activeByHost.get(hostKey) ?? 0) + 1);
				void checkRefUrlAvailability(href, timeoutMs)
					.then((result) => {
						results.set(href, result);
					})
					.catch((error: unknown) => {
						const reason =
							error instanceof Error
								? error.message || error.name
								: String(error);
						results.set(href, { ok: false, reason });
					})
					.finally(() => {
						active -= 1;
						const hostActive = (activeByHost.get(hostKey) ?? 1) - 1;
						if (hostActive > 0) activeByHost.set(hostKey, hostActive);
						else activeByHost.delete(hostKey);
						pump();
					});
			}
		};
		pump();
	});
}

function refUrlHostKey(href: string): string {
	const parsed = new URL(href);
	return parsed.host;
}

async function checkRefUrlAvailability(
	href: string,
	timeoutMs: number,
): Promise<RefUrlAvailabilityResult> {
	if (obviouslyNonPublicRefUrl(href))
		return { ok: false, reason: "private host blocked" };
	if (runningUnderNodeTest && globalThis.fetch !== defaultRefValidationFetch)
		return checkInjectedRefUrlAvailability(href, timeoutMs);
	const headers = {
		"user-agent": "pi-workflow-ref-validator/0.2",
		"accept-encoding": "identity",
	};
	for (const method of ["HEAD", "GET"] as const) {
		let current = href;
		try {
			for (let redirect = 0; redirect <= REFS_URL_VALIDATION_MAX_REDIRECTS; redirect += 1) {
				const checked = await validatePublicRefUrl(current, timeoutMs);
				const response = await requestRefUrl(checked, method, headers, timeoutMs);
				if (response.status >= 300 && response.status < 400) {
					if (!response.location)
						return { ok: false, reason: "redirect without location" };
					if (redirect === REFS_URL_VALIDATION_MAX_REDIRECTS)
						return { ok: false, reason: "too many redirects" };
					current = new URL(response.location, checked).href;
					continue;
				}
				if (response.tooLarge)
					return { ok: false, reason: "response exceeds size cap" };
				if (response.status >= 200 && response.status < 300)
					return { ok: true };
				if (method === "GET") return { ok: false, reason: `HTTP ${response.status}` };
				break;
			}
		} catch (error) {
			if (method === "GET") {
				const reason = error instanceof Error ? error.message || error.name : String(error);
				return { ok: false, reason };
			}
		}
	}
	return { ok: false, reason: "request failed" };
}

function obviouslyNonPublicRefUrl(href: string): boolean {
	try {
		const parsed = new URL(href);
		const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
		return Boolean(nonPublicIpReason(hostname)) || parsed.username !== "" || parsed.password !== "" ||
			[...parsed.searchParams.keys()].some(isSensitiveWorkflowQueryKey) ||
			hostname === "localhost" || hostname.endsWith(".localhost") ||
			hostname.endsWith(".local") || hostname.endsWith(".internal");
	} catch {
		return true;
	}
}

async function checkInjectedRefUrlAvailability(
	href: string,
	timeoutMs: number,
): Promise<RefUrlAvailabilityResult> {
	const headers = { "user-agent": "pi-workflow-ref-validator/0.2" };
	for (const method of ["HEAD", "GET"] as const) {
		try {
			const response = await globalThis.fetch(href, {
				method,
				headers: method === "GET" ? { ...headers, range: "bytes=0-2047" } : headers,
				redirect: "follow",
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (response.ok) {
				if (method === "GET") {
					const body = await response.arrayBuffer();
					if (body.byteLength > REFS_URL_VALIDATION_MAX_RESPONSE_BYTES)
						return { ok: false, reason: "response exceeds size cap" };
				}
				return { ok: true };
			}
			if (method === "GET") return { ok: false, reason: `HTTP ${response.status}` };
		} catch (error) {
			if (method === "GET") {
				const reason = error instanceof Error ? error.message || error.name : String(error);
				return { ok: false, reason };
			}
		}
	}
	return { ok: false, reason: "request failed" };
}

type RefProbeResponse = {
	status: number;
	location?: string;
	tooLarge: boolean;
};

async function validatePublicRefUrl(href: string, timeoutMs: number): Promise<string> {
	let parsed: URL;
	try {
		parsed = new URL(href);
	} catch {
		throw new Error("invalid URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
		throw new Error("unsupported URL scheme");
	if (parsed.username || parsed.password || [...parsed.searchParams.keys()].some(isSensitiveWorkflowQueryKey))
		throw new Error("sensitive URL blocked");
	// Separate per-preflight bound, just like the per-request transport bound.
	// HEAD, GET and each redirect may each consume both; not a batch deadline.
	// OS DNS may be uncancellable, but a late result never resumes this probe.
	const pending = lookup(parsed.hostname, { all: true, verbatim: true });
	let timer: ReturnType<typeof setTimeout> | undefined;
	const addresses = await Promise.race([
		pending,
		new Promise<Awaited<typeof pending>>((_, reject) => {
			timer = setTimeout(() => reject(new Error("DNS resolution timeout")), Math.max(1, timeoutMs));
		}),
	]).finally(() => { if (timer) clearTimeout(timer); });
	if (addresses.length === 0) throw new Error("DNS resolution failed");
	for (const address of addresses) {
		if (nonPublicIpReason(address.address)) throw new Error("private host blocked");
	}
	return parsed.href;
}

async function requestRefUrl(
	href: string,
	method: "HEAD" | "GET",
	headers: Record<string, string>,
	timeoutMs: number,
): Promise<RefProbeResponse> {
	const parsed = new URL(href);
	const request = parsed.protocol === "https:" ? httpsRequest : httpRequest;
	return await new Promise<RefProbeResponse>((resolveResult, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (result: RefProbeResponse): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolveResult(result);
		};
		const fail = (error: unknown): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			reject(error);
		};
		const req = request(
			parsed,
			{
				method,
				headers,
				lookup(hostname, options, callback) {
					lookup(hostname, { all: true, verbatim: true })
						.then((addresses) => {
							if (addresses.length === 0 || addresses.some((address) => nonPublicIpReason(address.address))) {
								callback(new Error("private host blocked"), "", 4);
								return;
							}
							const address = addresses[0]!;
							if (options && typeof options === "object" && "all" in options && options.all === true)
								callback(null, addresses);
							else callback(null, address.address, address.family);
						})
						.catch((error: unknown) => callback(error as Error, "", 4));
				},
			},
			(res) => {
				const status = res.statusCode ?? 0;
				const location = Array.isArray(res.headers.location)
					? res.headers.location[0]
					: res.headers.location;
				const declaredLength = Number(res.headers["content-length"]);
				if (status >= 200 && status < 300 && Number.isSafeInteger(declaredLength) &&
					declaredLength > REFS_URL_VALIDATION_MAX_RESPONSE_BYTES) {
					res.destroy();
					finish({ status, tooLarge: true });
					return;
				}
				if (method === "HEAD" || (status >= 300 && status < 400)) {
					finish({ status, ...(location ? { location } : {}), tooLarge: false });
					res.destroy();
					return;
				}
				let bytes = 0;
				let tooLarge = false;
				res.on("data", (chunk: Buffer | string) => {
					bytes += Buffer.byteLength(chunk);
					if (bytes > REFS_URL_VALIDATION_MAX_RESPONSE_BYTES) {
						tooLarge = true;
						res.destroy();
					}
				});
				res.on("end", () => finish({ status, ...(location ? { location } : {}), tooLarge }));
				res.on("error", (error: Error) => { if (!tooLarge) fail(error); });
				res.on("aborted", () => { if (!tooLarge) fail(new Error("response aborted")); });
				res.on("close", () => {
					if (tooLarge) finish({ status, tooLarge });
					else fail(new Error("response aborted"));
				});
			},
		);
		req.setTimeout(Math.max(1, timeoutMs), () => req.destroy(new Error("request timeout")));
		timer = setTimeout(() => {
			const error = new Error("request timeout");
			fail(error);
			req.destroy(error);
		}, Math.max(1, timeoutMs));
		req.on("error", fail);
		req.end();
	});
}

function validateControlContract(
	control: Record<string, unknown> | undefined,
	issues: WorkflowOutputIssue[],
	contract: StructuredContract | undefined,
): void {
	if (!control || !contract) return;
	const validation = validateStructuredContract(control, contract);
	for (const issue of validation.issues) issues.push(contractIssue(issue));
}

function validateControlJsonSchema(
	control: Record<string, unknown> | undefined,
	issues: WorkflowOutputIssue[],
	schema: JsonSchema | undefined,
): void {
	if (!control || schema === undefined) return;
	const validation = validateJsonSchema(control, schema);
	for (const issue of validation.issues) issues.push(jsonSchemaIssue(issue));
}

function buildParsedOutput(
	raw: string,
	issues: WorkflowOutputIssue[],
	sections: {
		control?: Record<string, unknown>;
		analysis?: string;
		refs?: unknown[];
	},
	requirements: SectionRequirements,
	repairs: WorkflowOutputRepair[] = [],
): ParsedWorkflowOutput {
	const parsed: ParsedWorkflowOutput = {
		protocol: VNEXT_OUTPUT_PROTOCOL,
		valid: parsedOutputValid(issues, sections, requirements),
		raw,
		issues,
	};
	if (sections.control !== undefined) parsed.control = sections.control;
	if (sections.analysis !== undefined) parsed.analysis = sections.analysis;
	if (sections.refs !== undefined) parsed.refs = sections.refs;
	if (repairs.length > 0) parsed.repairs = repairs;
	return parsed;
}

function parsedOutputValid(
	issues: readonly WorkflowOutputIssue[],
	sections: {
		control?: Record<string, unknown>;
		analysis?: string;
		refs?: unknown[];
	},
	requirements: SectionRequirements,
): boolean {
	if (issues.length > 0 || sections.control === undefined) return false;
	if (requirements.analysisRequired && sections.analysis === undefined)
		return false;
	if (requirements.refsRequired && sections.refs === undefined) return false;
	return true;
}

export type TaskArtifactLinkTestHook = (source: string, target: string) => void | Promise<void>;

let taskArtifactLinkForTests: TaskArtifactLinkTestHook | undefined;

export function setTaskArtifactLinkForTests(
	hook: TaskArtifactLinkTestHook | undefined,
): void {
	taskArtifactLinkForTests = hook;
}

type WorkflowOutputArtifactWriteHook = (event: {
	phase: "before" | "after";
	file: string;
}) => void | Promise<void>;

let workflowOutputArtifactWriteHookForTests:
	| WorkflowOutputArtifactWriteHook
	| undefined;

export function setWorkflowOutputArtifactWriteHookForTests(
	hook: WorkflowOutputArtifactWriteHook | undefined,
): void {
	workflowOutputArtifactWriteHookForTests = hook;
}

async function emitWorkflowOutputArtifactWriteHook(event: {
	phase: "before" | "after";
	file: string;
}): Promise<void> {
	await workflowOutputArtifactWriteHookForTests?.(event);
}

async function writeInvalidWorkflowOutputAttempt(
	taskDir: string,
	parsed: ParsedWorkflowOutput,
	options: WorkflowTaskArtifactBundleOptions,
): Promise<WorkflowArtifactBundleWriteResult> {
	const attempt = Math.max(1, Math.floor(options.attempt ?? 1));
	const files = {
		rawInvalid: join(taskDir, `raw.invalid-attempt-${attempt}.md`),
		resultInvalid: join(taskDir, `result.invalid-attempt-${attempt}.json`),
	};
	await writeTextAtomic(files.rawInvalid, options.rawOutput);
	await writeJsonAtomic(
		files.resultInvalid,
		invalidResultEnvelope(parsed, options),
	);
	return { valid: false, parsed, files };
}

async function writeValidWorkflowOutputBundle(
	taskDir: string,
	parsed: ValidParsedWorkflowOutput,
	options: WorkflowTaskArtifactBundleOptions,
): Promise<Extract<WorkflowArtifactBundleWriteResult, { valid: true }>> {
	const files = artifactFileMap(taskDir, options);
	await writeSidecars(files, parsed, options);
	const result = validResultEnvelope(files, parsed, options);
	await writeJsonAtomic(files.result!, result);
	return { valid: true, parsed, result, files };
}

function artifactFileMap(
	taskDir: string,
	options: WorkflowTaskArtifactBundleOptions,
): Record<string, string> {
	const files: Record<string, string> = {
		control: join(taskDir, "control.json"),
		analysis: join(taskDir, "analysis.md"),
		refs: join(taskDir, "refs.json"),
		raw: join(taskDir, "raw.md"),
		result: join(taskDir, "result.json"),
	};
	if (options.prompt !== undefined) files.prompt = join(taskDir, "prompt.md");
	if (options.systemPrompt !== undefined)
		files["system-prompt"] = join(taskDir, "system-prompt.md");
	if (options.stderr !== undefined) files.stderr = join(taskDir, "stderr.log");
	return files;
}

async function writeSidecars(
	files: Record<string, string>,
	parsed: ValidParsedWorkflowOutput,
	options: WorkflowTaskArtifactBundleOptions,
): Promise<void> {
	await Promise.all([
		writeJsonAtomic(files.control!, parsed.control),
		writeTextAtomic(files.analysis!, ensureTrailingNewline(parsed.analysis)),
		writeJsonAtomic(files.refs!, parsed.refs),
		writeRawArtifact(files.raw!, options.rawOutput),
		writeOptionalText(files.prompt, options.prompt),
		writeOptionalText(files["system-prompt"], options.systemPrompt),
		writeOptionalText(files.stderr, options.stderr),
	]);
}

async function writeRawArtifact(file: string, value: string): Promise<void> {
	const outputFile = join(dirname(file), "output.log");
	const expected = Buffer.from(value, "utf8");
	try {
		const output = await stat(outputFile);
		if (output.isFile() && output.size === expected.byteLength) {
			const actual = await readFile(outputFile);
			if (Buffer.compare(actual, expected) === 0) {
				await taskArtifactLinkForTests?.(outputFile, file);
				// Keep raw independently readable and immutable even when output.log
				// shares an attempt inode. CoW retains storage savings where available.
				const temp = join(dirname(file), `.raw-${randomBytes(12).toString("hex")}.tmp`);
				try {
					await emitWorkflowOutputArtifactWriteHook({ phase: "before", file });
					await copyFile(outputFile, temp, fsConstants.COPYFILE_FICLONE | fsConstants.COPYFILE_EXCL);
					if (!expected.equals(await readFile(temp))) throw new Error("raw snapshot source changed");
					await rename(temp, file);
					await emitWorkflowOutputArtifactWriteHook({ phase: "after", file });
					return;
				} finally {
					await unlink(temp).catch(() => {});
				}
			}
		}
	} catch {
		// A failed comparison or clone attempt falls back to the authoritative bytes.
	}
	await writeTextAtomic(file, value);
}

async function writeOptionalText(
	file: string | undefined,
	content: string | undefined,
): Promise<void> {
	if (file !== undefined && content !== undefined)
		await writeTextAtomic(file, content);
}

function outputValidationEnvelope(
	valid: boolean,
	issues: WorkflowOutputIssue[],
	repairs?: WorkflowOutputRepair[],
): WorkflowTaskResultEnvelope["outputValidation"] {
	const outputValidation: WorkflowTaskResultEnvelope["outputValidation"] = {
		valid,
		issues,
	};
	if (repairs !== undefined && repairs.length > 0) {
		outputValidation.repairCount = repairs.length;
		outputValidation.repairs = repairs;
	}
	return outputValidation;
}

function invalidResultEnvelope(
	parsed: ParsedWorkflowOutput,
	options: WorkflowTaskArtifactBundleOptions,
): WorkflowTaskResultEnvelope {
	return {
		schema: VNEXT_TASK_RESULT_SCHEMA,
		protocol: VNEXT_OUTPUT_PROTOCOL,
		status: "failed",
		artifacts: {},
		completedAt: options.completedAt ?? new Date().toISOString(),
		exitCode: 1,
		outputValidation: outputValidationEnvelope(
			false,
			parsed.issues,
			parsed.repairs,
		),
	};
}

function validResultEnvelope(
	files: Record<string, string>,
	parsed: ValidParsedWorkflowOutput,
	options: WorkflowTaskArtifactBundleOptions,
): WorkflowTaskResultEnvelope {
	const status = options.lifecycleStatus ?? "completed";
	const result: WorkflowTaskResultEnvelope = {
		schema: VNEXT_TASK_RESULT_SCHEMA,
		protocol: VNEXT_OUTPUT_PROTOCOL,
		status,
		artifacts: artifactIndex(files),
		controlDigest: controlDigest(parsed.control),
		startedAt: options.startedAt,
		completedAt: options.completedAt ?? new Date().toISOString(),
		exitCode: options.exitCode ?? (status === "completed" ? 0 : 1),
		outputValidation: outputValidationEnvelope(true, [], parsed.repairs),
	};
	if (options.salvagedFromFailureKind !== undefined)
		result.salvagedFromFailureKind = options.salvagedFromFailureKind;
	if (options.subagentWarning !== undefined)
		result.subagentWarning = options.subagentWarning;
	if (options.subagentStatus !== undefined)
		result.subagentStatus = options.subagentStatus;
	if (options.subagentFailureKind !== undefined)
		result.subagentFailureKind = options.subagentFailureKind;
	if (options.subagentToolCallsPath !== undefined)
		result.subagentToolCallsPath = options.subagentToolCallsPath;
	if (options.subagentToolCallsSummaryPath !== undefined)
		result.subagentToolCallsSummaryPath = options.subagentToolCallsSummaryPath;
	if (options.subagentToolCallsArtifactCwd !== undefined)
		result.subagentToolCallsArtifactCwd = options.subagentToolCallsArtifactCwd;
	if (
		options.subagentFailedToolCalls !== undefined &&
		options.subagentFailedToolCalls.length > 0
	) {
		result.subagentFailedToolCalls = options.subagentFailedToolCalls;
	}
	if (result.startedAt === undefined) delete result.startedAt;
	return result;
}

function artifactIndex(files: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(files).map(([name, path]) => [name, basename(path)]),
	);
}

function sectionRequired(
	name: WorkflowOutputSectionName,
	requirements: SectionRequirements,
): boolean {
	if (name === SECTION_ANALYSIS) return requirements.analysisRequired;
	if (name === SECTION_REFS) return requirements.refsRequired;
	return true;
}

function missingSectionIssue(
	section: WorkflowOutputSectionName,
): WorkflowOutputIssue {
	return {
		code: "missing_section",
		section,
		message: `${section} section is required`,
	};
}

function duplicateSectionIssue(
	section: WorkflowOutputSectionName,
	count: number,
): WorkflowOutputIssue {
	return {
		code: "duplicate_section",
		section,
		message: `${section} section must appear exactly once; found ${count}`,
	};
}

function outsideTextIssue(): WorkflowOutputIssue {
	return {
		code: "unexpected_text",
		message: "output must not contain prose outside workflow output sections",
	};
}

function sectionText(
	sections: readonly SectionMatch[],
	name: WorkflowOutputSectionName,
): string | undefined {
	const matches = sections.filter((section) => section.name === name);
	return matches.length === 1 ? matches[0]!.content.trim() : undefined;
}

function parseJsonSection(
	text: string,
	section: typeof SECTION_CONTROL | typeof SECTION_REFS,
	issues: WorkflowOutputIssue[],
): unknown | undefined {
	if (text.trim().length === 0) {
		issues.push({
			code: "empty_section",
			section,
			message: `${section} section must not be empty`,
		});
		return undefined;
	}
	try {
		return JSON.parse(text);
	} catch (error) {
		if (section === SECTION_CONTROL) {
			const recovered = parseFirstBalancedControlJson(text);
			if (recovered !== undefined) return recovered;
		}
		issues.push({
			code: "invalid_json",
			section,
			message: `${section} must contain valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		});
		return undefined;
	}
}

function parseFirstBalancedControlJson(text: string): unknown | undefined {
	const json = firstBalancedJsonObject(text);
	if (json === undefined) return undefined;
	const objectStart = text.indexOf("{");
	if (objectStart < 0) return undefined;
	if (text.slice(0, objectStart).trim().length > 0) return undefined;
	const remainder = text.slice(objectStart + json.length);
	if (!isTrivialControlJsonRemainder(remainder)) return undefined;
	try {
		return JSON.parse(json);
	} catch {
		return undefined;
	}
}

function firstBalancedJsonObject(text: string): string | undefined {
	const start = text.indexOf("{");
	if (start < 0) return undefined;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < text.length; index += 1) {
		const char = text[index];
		if (char === undefined) break;
		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "{") {
			depth += 1;
			continue;
		}
		if (char === "}") {
			depth -= 1;
			if (depth === 0) return text.slice(start, index + 1);
			if (depth < 0) return undefined;
		}
	}
	return undefined;
}

function isTrivialControlJsonRemainder(remainder: string): boolean {
	const trimmed = remainder.trim();
	return trimmed.length === 0 || trimmed === "}" || trimmed === "]";
}

function validateBaseControl(
	control: Record<string, unknown>,
	issues: WorkflowOutputIssue[],
	options: ParseWorkflowOutputOptions,
): void {
	validateControlSchemaField(control, issues);
	validateControlDigestField(control, issues, options);
}

function validateControlSchemaField(
	control: Record<string, unknown>,
	issues: WorkflowOutputIssue[],
): void {
	if (typeof control.schema === "string" && control.schema.length > 0) return;
	issues.push({
		code: "missing_required_field",
		section: SECTION_CONTROL,
		path: "$.schema",
		message: "control.schema must be a non-empty string",
	});
}

function validateControlDigestField(
	control: Record<string, unknown>,
	issues: WorkflowOutputIssue[],
	options: ParseWorkflowOutputOptions,
): void {
	if (
		typeof control.digest !== "string" ||
		control.digest.trim().length === 0
	) {
		issues.push({
			code: "missing_required_field",
			section: SECTION_CONTROL,
			path: "$.digest",
			message: "control.digest must be a non-empty string",
		});
		return;
	}
	const maxDigestChars = options.maxDigestChars ?? DEFAULT_MAX_DIGEST_CHARS;
	if (control.digest.length <= maxDigestChars) return;
	issues.push({
		code: "field_too_long",
		section: SECTION_CONTROL,
		path: "$.digest",
		message: `control.digest must be <= ${maxDigestChars} characters`,
	});
}

function contractIssue(issue: StructuredContractIssue): WorkflowOutputIssue {
	return {
		code: "contract_failed",
		section: SECTION_CONTROL,
		path: issue.path,
		message: `control schema contract failed: ${issue.message}`,
	};
}

function jsonSchemaIssue(issue: JsonSchemaIssue): WorkflowOutputIssue {
	return {
		code: "contract_failed",
		section: SECTION_CONTROL,
		path: issue.path,
		message: `control JSON schema failed: ${issue.message}`,
	};
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameArray<T>(actual: readonly T[], expected: readonly T[]): boolean {
	if (actual.length !== expected.length) return false;
	return expected.every((value, index) => actual[index] === value);
}

function controlDigest(control: Record<string, unknown>): string | undefined {
	return typeof control.digest === "string" ? control.digest : undefined;
}

function ensureTrailingNewline(text: string): string {
	return text.endsWith("\n") ? text : `${text}\n`;
}

function basename(path: string): string {
	return path.split(/[\\/]/).at(-1) ?? path;
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
	await writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomic(file: string, value: string): Promise<void> {
	await emitWorkflowOutputArtifactWriteHook({ phase: "before", file });
	await mkdir(dirname(file), { recursive: true });
	const temp = join(
		dirname(file),
		`.${Date.now().toString(36)}-${randomBytes(3).toString("hex")}.tmp`,
	);
	await writeFile(temp, value, "utf8");
	await rename(temp, file);
	await emitWorkflowOutputArtifactWriteHook({ phase: "after", file });
}
