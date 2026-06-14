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

type VNextSectionName = (typeof CANONICAL_SECTION_ORDER)[number];

export type VNextOutputIssueCode =
	| "missing_section"
	| "duplicate_section"
	| "unexpected_text"
	| "invalid_json"
	| "invalid_type"
	| "missing_required_field"
	| "field_too_long"
	| "empty_section"
	| "contract_failed";

export interface VNextOutputIssue {
	code: VNextOutputIssueCode;
	message: string;
	section?: VNextSectionName;
	path?: string;
}

export interface ParsedVNextOutput {
	protocol: typeof VNEXT_OUTPUT_PROTOCOL;
	valid: boolean;
	raw: string;
	control?: Record<string, unknown>;
	analysis?: string;
	refs?: unknown[];
	issues: VNextOutputIssue[];
}

export interface ParseVNextOutputOptions {
	analysisRequired?: boolean;
	refsRequired?: boolean;
	maxDigestChars?: number;
	controlContract?: StructuredContract;
	controlJsonSchema?: JsonSchema;
}

export interface VNextTaskArtifactBundleOptions
	extends ParseVNextOutputOptions {
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
}

export interface VNextTaskResultEnvelope {
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
		issues: VNextOutputIssue[];
	};
}

type ValidParsedVNextOutput = ParsedVNextOutput & {
	valid: true;
	control: Record<string, unknown>;
	analysis: string;
	refs: unknown[];
};

export type VNextArtifactBundleWriteResult =
	| {
			valid: true;
			parsed: ValidParsedVNextOutput;
			result: VNextTaskResultEnvelope;
			files: Record<string, string>;
	  }
	| {
			valid: false;
			parsed: ParsedVNextOutput;
			files: Record<string, string>;
	  };

interface SectionMatch {
	name: VNextSectionName;
	content: string;
	start: number;
	end: number;
}

interface SectionRequirements {
	analysisRequired: boolean;
	refsRequired: boolean;
}

export function parseVNextOutput(
	raw: string,
	options: ParseVNextOutputOptions = {},
): ParsedVNextOutput {
	const issues: VNextOutputIssue[] = [];
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

export async function writeVNextTaskArtifactBundle(
	options: VNextTaskArtifactBundleOptions,
): Promise<VNextArtifactBundleWriteResult> {
	const taskDir = resolve(options.taskDir);
	await mkdir(taskDir, { recursive: true });
	const parsed = parseVNextOutput(options.rawOutput, options);
	if (!parsed.valid)
		return await writeInvalidVNextAttempt(taskDir, parsed, options);
	return await writeValidVNextBundle(
		taskDir,
		parsed as ValidParsedVNextOutput,
		options,
	);
}

export function buildVNextOutputRetryInstructions(
	issues: readonly VNextOutputIssue[],
): string {
	const issueLines = issues.map((issue) => {
		const where = issue.path ?? issue.section;
		return `- ${where ? `${where}: ` : ""}${issue.message}`;
	});
	return [
		"Validation error: vNext workflow output protocol was invalid.",
		"Return exactly these sections, in this order, with no prose outside the tags:",
		"<control>{...}</control>",
		"<analysis>...</analysis>",
		"<refs>[]</refs>",
		"Issues:",
		...issueLines,
	].join("\n");
}

function sectionRequirements(
	options: ParseVNextOutputOptions,
): SectionRequirements {
	return {
		analysisRequired: options.analysisRequired ?? true,
		refsRequired: options.refsRequired ?? true,
	};
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

function validateSectionLayout(
	raw: string,
	sections: readonly SectionMatch[],
	issues: VNextOutputIssue[],
	requirements: SectionRequirements,
): void {
	validateSectionCounts(sections, issues, requirements);
	validateCanonicalOrder(sections, issues, requirements);
	validateNoOutsideText(raw, sections, issues);
}

function validateSectionCounts(
	sections: readonly SectionMatch[],
	issues: VNextOutputIssue[],
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
	issues: VNextOutputIssue[],
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
	issues: VNextOutputIssue[],
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
	issues: VNextOutputIssue[],
	options: ParseVNextOutputOptions,
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
	validateBaseControl(parsed, issues, options);
	return parsed;
}

function parseAnalysisSection(
	text: string | undefined,
	issues: VNextOutputIssue[],
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
	issues: VNextOutputIssue[],
	requirements: SectionRequirements,
): unknown[] | undefined {
	if (text === undefined) return requirements.refsRequired ? undefined : [];
	const parsed = parseJsonSection(text, SECTION_REFS, issues);
	if (parsed === undefined) return undefined;
	if (Array.isArray(parsed)) return parsed;
	issues.push({
		code: "invalid_type",
		section: SECTION_REFS,
		message: "refs must be a JSON array",
	});
	return undefined;
}

function validateControlContract(
	control: Record<string, unknown> | undefined,
	issues: VNextOutputIssue[],
	contract: StructuredContract | undefined,
): void {
	if (!control || !contract) return;
	const validation = validateStructuredContract(control, contract);
	for (const issue of validation.issues) issues.push(contractIssue(issue));
}

function validateControlJsonSchema(
	control: Record<string, unknown> | undefined,
	issues: VNextOutputIssue[],
	schema: JsonSchema | undefined,
): void {
	if (!control || schema === undefined) return;
	const validation = validateJsonSchema(control, schema);
	for (const issue of validation.issues) issues.push(jsonSchemaIssue(issue));
}

function buildParsedOutput(
	raw: string,
	issues: VNextOutputIssue[],
	sections: {
		control?: Record<string, unknown>;
		analysis?: string;
		refs?: unknown[];
	},
	requirements: SectionRequirements,
): ParsedVNextOutput {
	const parsed: ParsedVNextOutput = {
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
	issues: readonly VNextOutputIssue[],
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

async function writeInvalidVNextAttempt(
	taskDir: string,
	parsed: ParsedVNextOutput,
	options: VNextTaskArtifactBundleOptions,
): Promise<VNextArtifactBundleWriteResult> {
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

async function writeValidVNextBundle(
	taskDir: string,
	parsed: ValidParsedVNextOutput,
	options: VNextTaskArtifactBundleOptions,
): Promise<VNextArtifactBundleWriteResult> {
	const files = artifactFileMap(taskDir, options);
	await writeSidecars(files, parsed, options);
	const result = validResultEnvelope(files, parsed, options);
	await writeJsonAtomic(files.result!, result);
	return { valid: true, parsed, result, files };
}

function artifactFileMap(
	taskDir: string,
	options: VNextTaskArtifactBundleOptions,
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
	parsed: ValidParsedVNextOutput,
	options: VNextTaskArtifactBundleOptions,
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
	parsed: ParsedVNextOutput,
	options: VNextTaskArtifactBundleOptions,
): VNextTaskResultEnvelope {
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
	parsed: ValidParsedVNextOutput,
	options: VNextTaskArtifactBundleOptions,
): VNextTaskResultEnvelope {
	const status = options.lifecycleStatus ?? "completed";
	const result: VNextTaskResultEnvelope = {
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
): Map<VNextSectionName, number> {
	const counts = new Map<VNextSectionName, number>();
	for (const section of sections) {
		counts.set(section.name, (counts.get(section.name) ?? 0) + 1);
	}
	return counts;
}

function sectionRequired(
	name: VNextSectionName,
	requirements: SectionRequirements,
): boolean {
	if (name === SECTION_ANALYSIS) return requirements.analysisRequired;
	if (name === SECTION_REFS) return requirements.refsRequired;
	return true;
}

function requiredSectionOrder(
	requirements: SectionRequirements,
): VNextSectionName[] {
	return CANONICAL_SECTION_ORDER.filter((name) =>
		sectionRequired(name, requirements),
	);
}

function missingSectionIssue(section: VNextSectionName): VNextOutputIssue {
	return {
		code: "missing_section",
		section,
		message: `${section} section is required`,
	};
}

function duplicateSectionIssue(section: VNextSectionName): VNextOutputIssue {
	return {
		code: "duplicate_section",
		section,
		message: `${section} section must appear exactly once`,
	};
}

function outsideTextIssue(): VNextOutputIssue {
	return {
		code: "unexpected_text",
		message: "output must not contain prose outside vNext sections",
	};
}

function sectionText(
	sections: readonly SectionMatch[],
	name: VNextSectionName,
): string | undefined {
	const matches = sections.filter((section) => section.name === name);
	return matches.length === 1 ? matches[0]!.content.trim() : undefined;
}

function parseJsonSection(
	text: string,
	section: typeof SECTION_CONTROL | typeof SECTION_REFS,
	issues: VNextOutputIssue[],
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
		issues.push({
			code: "invalid_json",
			section,
			message: `${section} must contain valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		});
		return undefined;
	}
}

function validateBaseControl(
	control: Record<string, unknown>,
	issues: VNextOutputIssue[],
	options: ParseVNextOutputOptions,
): void {
	validateControlSchemaField(control, issues);
	validateControlDigestField(control, issues, options);
}

function validateControlSchemaField(
	control: Record<string, unknown>,
	issues: VNextOutputIssue[],
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
	issues: VNextOutputIssue[],
	options: ParseVNextOutputOptions,
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

function contractIssue(issue: StructuredContractIssue): VNextOutputIssue {
	return {
		code: "contract_failed",
		section: SECTION_CONTROL,
		path: issue.path,
		message: `control schema contract failed: ${issue.message}`,
	};
}

function jsonSchemaIssue(issue: JsonSchemaIssue): VNextOutputIssue {
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
