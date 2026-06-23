import { randomBytes } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
	validateStructuredContract,
	type StructuredContract,
	type StructuredContractIssue,
} from "./workflow-artifacts.js";
import {
	validateJsonSchema,
	type JsonSchema,
	type JsonSchemaIssue,
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

export interface ParsedWorkflowOutput {
	protocol: typeof VNEXT_OUTPUT_PROTOCOL;
	valid: boolean;
	raw: string;
	control?: Record<string, unknown>;
	analysis?: string;
	refs?: unknown[];
	issues: WorkflowOutputIssue[];
}

export interface ParseWorkflowOutputOptions {
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
	};
	salvagedFromFailureKind?: string;
	subagentWarning?: string;
	subagentStatus?: string;
	subagentFailureKind?: string | null;
}

type ValidParsedWorkflowOutput = ParsedWorkflowOutput & {
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

export function parseWorkflowOutput(
	raw: string,
	options: ParseWorkflowOutputOptions = {},
): ParsedWorkflowOutput {
	const issues: WorkflowOutputIssue[] = [];
	const requirements = sectionRequirements(options);
	const sections = collectSections(raw, requirements);
	validateSectionLayout(raw, sections, issues, requirements);

	const control = parseControlSection(
		sectionText(sections, SECTION_CONTROL),
		issues,
		options,
	);
	const analysis = parseAnalysisSection(
		sectionText(sections, SECTION_ANALYSIS),
		issues,
		requirements,
	);
	const refs = parseRefsSection(
		sectionText(sections, SECTION_REFS),
		issues,
		requirements,
	);
	validateControlContract(control, issues, options.controlContract);
	validateControlJsonSchema(control, issues, options.controlJsonSchema);

	return buildParsedOutput(
		raw,
		issues,
		{ control, analysis, refs },
		requirements,
	);
}

export function parseWorkflowOutputForBundle(
	raw: string,
	options: ParseWorkflowOutputOptions = {},
): ParsedWorkflowOutput {
	const parsed = parseWorkflowOutput(raw, options);
	if (parsed.valid) return parsed;
	return parseSanitizedWorkflowOutput(raw, options) ?? parsed;
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
	const parsed = await validateWorkflowOutputRefsForBundle(
		parseWorkflowOutputForBundle(options.rawOutput, options),
		options,
	);
	if (!parsed.valid)
		return await writeInvalidWorkflowOutputAttempt(taskDir, parsed, options);
	return await writeValidWorkflowOutputBundle(
		taskDir,
		parsed as ValidParsedWorkflowOutput,
		options,
	);
}

export function buildWorkflowOutputRetryInstructions(
	issues: readonly WorkflowOutputIssue[],
): string {
	const issueLines = issues.map((issue) => {
		const where = issue.path ?? issue.section;
		return `- ${where ? `${where}: ` : ""}${issue.message}`;
	});
	return [
		"Validation error: workflow output protocol was invalid.",
		"Return exactly these sections, in this order, with no prose outside the tags:",
		"<control>{...}</control>",
		"<analysis>...</analysis>",
		"<refs>[...]</refs>",
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

function collectSections(
	raw: string,
	requirements: SectionRequirements,
): SectionMatch[] {
	const sections: SectionMatch[] = [];
	let cursor = 0;
	const expected = requiredSectionOrder(requirements);
	for (const [index, name] of expected.entries()) {
		const openTag = `<${name}>`;
		const closeTag = `</${name}>`;
		const openStart = raw.indexOf(openTag, cursor);
		if (openStart < 0) continue;
		const contentStart = openStart + openTag.length;
		const closeStart = findSectionClose(raw, {
			contentStart,
			closeTag,
			nextTag: expected[index + 1] ? `<${expected[index + 1]}>` : undefined,
		});
		if (closeStart < 0) continue;
		const end = closeStart + closeTag.length;
		sections.push({
			name,
			content: raw.slice(contentStart, closeStart).trim(),
			start: openStart,
			end,
		});
		cursor = end;
	}
	return sections;
}

function findSectionClose(
	raw: string,
	options: { contentStart: number; closeTag: string; nextTag?: string },
): number {
	let searchFrom = options.contentStart;
	let fallback = -1;
	while (true) {
		const candidate = raw.indexOf(options.closeTag, searchFrom);
		if (candidate < 0) break;
		fallback = candidate;
		const after = skipWhitespace(raw, candidate + options.closeTag.length);
		if (
			options.closeTag === "</control>" &&
			isInsideJsonString(raw.slice(options.contentStart, candidate))
		) {
			searchFrom = candidate + options.closeTag.length;
			continue;
		}
		if (options.nextTag) {
			if (raw.startsWith(options.nextTag, after)) return candidate;
		} else if (raw.slice(after).trim() === "") {
			return candidate;
		}
		searchFrom = candidate + options.closeTag.length;
	}
	return fallback;
}

function skipWhitespace(raw: string, index: number): number {
	let cursor = index;
	while (cursor < raw.length && /\s/.test(raw[cursor] ?? "")) cursor += 1;
	return cursor;
}

function isInsideJsonString(text: string): boolean {
	let inString = false;
	let escaped = false;
	for (const char of text) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === '"') inString = !inString;
	}
	return inString;
}

function validateSectionLayout(
	raw: string,
	sections: readonly SectionMatch[],
	issues: WorkflowOutputIssue[],
	requirements: SectionRequirements,
): void {
	validateSectionCounts(sections, issues, requirements);
	validateCanonicalOrder(sections, issues, requirements);
	validateNoOutsideText(raw, sections, issues);
}

function parseSanitizedWorkflowOutput(
	raw: string,
	options: ParseWorkflowOutputOptions,
): ParsedWorkflowOutput | undefined {
	const requirements = sectionRequirements(options);
	const sections = collectSections(raw, requirements);
	if (hasExactlyRequiredSections(sections, requirements)) {
		const sanitized = sections
			.map((section) => raw.slice(section.start, section.end).trim())
			.join("\n");
		if (sanitized !== raw.trim()) {
			const parsed = parseWorkflowOutput(sanitized, options);
			if (parsed.valid) return parsed;
		}
	}
	const repaired = repairMissingTailSections(raw, requirements);
	if (repaired !== undefined) {
		const parsed = parseWorkflowOutput(repaired, options);
		if (parsed.valid) return parsed;
	}
	return undefined;
}

function repairMissingTailSections(
	raw: string,
	requirements: SectionRequirements,
): string | undefined {
	const controlOpen = raw.indexOf("<control>");
	if (controlOpen < 0) return undefined;
	const controlContentStart = controlOpen + "<control>".length;
	const controlClose = raw.indexOf("</control>", controlContentStart);
	if (controlClose < 0) return undefined;
	const controlContent = raw.slice(controlContentStart, controlClose).trim();
	const afterControl = raw.slice(controlClose + "</control>".length);
	let analysis = "";
	let refs = "[]";
	const analysisOpen = afterControl.indexOf("<analysis>");
	if (requirements.analysisRequired) {
		if (analysisOpen < 0) return undefined;
		const analysisStart = analysisOpen + "<analysis>".length;
		const analysisClose = afterControl.indexOf("</analysis>", analysisStart);
		const refsOpenAfterAnalysis = afterControl.indexOf("<refs>", analysisStart);
		const analysisEnd =
			analysisClose >= 0
				? analysisClose
				: refsOpenAfterAnalysis >= 0
					? refsOpenAfterAnalysis
					: afterControl.length;
		analysis = afterControl.slice(analysisStart, analysisEnd).trim();
		if (analysis.length === 0) return undefined;
	}
	const refsSearchStart =
		analysisOpen >= 0 ? analysisOpen + "<analysis>".length : 0;
	const refsOpen = afterControl.indexOf("<refs>", refsSearchStart);
	if (refsOpen >= 0) {
		const refsStart = refsOpen + "<refs>".length;
		const refsClose = afterControl.indexOf("</refs>", refsStart);
		if (refsClose >= 0) refs = afterControl.slice(refsStart, refsClose).trim();
	} else if (requirements.refsRequired) {
		refs = "[]";
	}
	return [
		"<control>",
		controlContent,
		"</control>",
		"<analysis>",
		analysis,
		"</analysis>",
		"<refs>",
		refs,
		"</refs>",
	].join("\n");
}

function hasExactlyRequiredSections(
	sections: readonly SectionMatch[],
	requirements: SectionRequirements,
): boolean {
	const expected = requiredSectionOrder(requirements);
	if (sections.length !== expected.length) return false;
	return sections.every((section, index) => section.name === expected[index]);
}

function validateSectionCounts(
	sections: readonly SectionMatch[],
	issues: WorkflowOutputIssue[],
	requirements: SectionRequirements,
): void {
	const counts = sectionCounts(sections);
	for (const name of CANONICAL_SECTION_ORDER) {
		const required = sectionRequired(name, requirements);
		const count = counts.get(name) ?? 0;
		if (required && count === 0) issues.push(missingSectionIssue(name));
		if (count > 1) issues.push(duplicateSectionIssue(name));
	}
}

function validateCanonicalOrder(
	sections: readonly SectionMatch[],
	issues: WorkflowOutputIssue[],
	requirements: SectionRequirements,
): void {
	if (sections.length === 0) return;
	const actual = sections.map((section) => section.name);
	const expected = requiredSectionOrder(requirements);
	if (sameArray(actual, expected)) return;
	issues.push({
		code: "unexpected_text",
		message: `sections must appear in canonical order: ${expected.join(", ")}; got ${actual.join(",")}`,
	});
}

function validateNoOutsideText(
	raw: string,
	sections: readonly SectionMatch[],
	issues: WorkflowOutputIssue[],
): void {
	let cursor = 0;
	for (const section of sections) {
		if (raw.slice(cursor, section.start).trim().length > 0) {
			issues.push(outsideTextIssue());
			return;
		}
		cursor = section.end;
	}
	if (raw.slice(cursor).trim().length > 0) issues.push(outsideTextIssue());
}

function parseControlSection(
	text: string | undefined,
	issues: WorkflowOutputIssue[],
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
	const normalized = normalizeWorkflowControl(parsed);
	validateBaseControl(normalized, issues, options);
	return normalized;
}

function normalizeWorkflowControl(
	control: Record<string, unknown>,
): Record<string, unknown> {
	const normalized = normalizeControlValue(control);
	return isPlainRecord(normalized) ? normalized : control;
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
	if (text === undefined) return undefined;
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
	const issues: WorkflowOutputIssue[] = [];
	const checks = new Map<
		string,
		Promise<{ ok: true } | { ok: false; reason: string }>
	>();
	let checkedUrls = 0;
	for (const [index, ref] of refs.entries()) {
		const locator = refLocator(ref);
		const href = locator === undefined ? undefined : httpRefHref(locator);
		if (href === undefined) continue;
		if (checkedUrls >= config.maxUrls) break;
		checkedUrls += 1;
		let check = checks.get(href);
		if (!check) {
			check = checkRefUrlAvailability(href, config.timeoutMs);
			checks.set(href, check);
		}
		const result = await check;
		if (result.ok) continue;
		issues.push({
			code: "unavailable_ref_locator",
			section: SECTION_REFS,
			path: `refs[${index}]`,
			message: `ref URL is not reachable (${result.reason}): ${href}`,
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

async function checkRefUrlAvailability(
	href: string,
	timeoutMs: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const headers = { "user-agent": "pi-workflow-ref-validator/0.1" };
	for (const attempt of [
		{ method: "HEAD", headers },
		{ method: "GET", headers: { ...headers, range: "bytes=0-2047" } },
	]) {
		try {
			const response = await fetch(href, {
				...attempt,
				redirect: "follow",
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (response.ok) {
				if (attempt.method === "GET") {
					try {
						await response.arrayBuffer();
					} catch {
						// Availability was already established by the HTTP status.
					}
				}
				return { ok: true };
			}
			if (attempt.method === "GET")
				return { ok: false, reason: `HTTP ${response.status}` };
		} catch (error) {
			if (attempt.method === "GET") {
				const reason =
					error instanceof Error ? error.message || error.name : String(error);
				return { ok: false, reason };
			}
		}
	}
	return { ok: false, reason: "request failed" };
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
): Promise<WorkflowArtifactBundleWriteResult> {
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
	await writeJsonAtomic(files.control!, parsed.control);
	await writeTextAtomic(
		files.analysis!,
		ensureTrailingNewline(parsed.analysis),
	);
	await writeJsonAtomic(files.refs!, parsed.refs);
	await writeTextAtomic(files.raw!, options.rawOutput);
	await writeOptionalText(files.prompt, options.prompt);
	await writeOptionalText(files["system-prompt"], options.systemPrompt);
	await writeOptionalText(files.stderr, options.stderr);
}

async function writeOptionalText(
	file: string | undefined,
	content: string | undefined,
): Promise<void> {
	if (file !== undefined && content !== undefined)
		await writeTextAtomic(file, content);
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
		outputValidation: { valid: false, issues: parsed.issues },
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
		outputValidation: { valid: true, issues: [] },
	};
	if (options.salvagedFromFailureKind !== undefined)
		result.salvagedFromFailureKind = options.salvagedFromFailureKind;
	if (options.subagentWarning !== undefined)
		result.subagentWarning = options.subagentWarning;
	if (options.subagentStatus !== undefined)
		result.subagentStatus = options.subagentStatus;
	if (options.subagentFailureKind !== undefined)
		result.subagentFailureKind = options.subagentFailureKind;
	if (result.startedAt === undefined) delete result.startedAt;
	return result;
}

function artifactIndex(files: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(files).map(([name, path]) => [name, basename(path)]),
	);
}

function sectionCounts(
	sections: readonly SectionMatch[],
): Map<WorkflowOutputSectionName, number> {
	const counts = new Map<WorkflowOutputSectionName, number>();
	for (const section of sections) {
		counts.set(section.name, (counts.get(section.name) ?? 0) + 1);
	}
	return counts;
}

function sectionRequired(
	name: WorkflowOutputSectionName,
	requirements: SectionRequirements,
): boolean {
	if (name === SECTION_ANALYSIS) return requirements.analysisRequired;
	if (name === SECTION_REFS) return requirements.refsRequired;
	return true;
}

function requiredSectionOrder(
	requirements: SectionRequirements,
): WorkflowOutputSectionName[] {
	return CANONICAL_SECTION_ORDER.filter((name) =>
		sectionRequired(name, requirements),
	);
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
): WorkflowOutputIssue {
	return {
		code: "duplicate_section",
		section,
		message: `${section} section must appear exactly once`,
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
	await mkdir(dirname(file), { recursive: true });
	const temp = join(
		dirname(file),
		`.${Date.now().toString(36)}-${randomBytes(3).toString("hex")}.tmp`,
	);
	await writeFile(temp, value, "utf8");
	await rename(temp, file);
}
