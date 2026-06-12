import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import {
	TOOL_CLASSIFICATIONS,
	type WorkflowSpec,
	WorkflowValidationError,
	type ValidationIssue,
} from "./types.js";
import {
	type ResolvedWorkflowSpecRef,
	resolveWorkflowRef,
} from "./workflow-specs.js";
import { parseYamlSubset } from "./yaml.js";

const BACKEND_KEYS = new Set(["type", "mode"]);

const OUTPUT_KEYS = new Set([
	"format",
	"requiredKeys",
	"onInvalid",
	"contract",
	"template",
	"templateRef",
]);
const OUTPUT_FORMATS = new Set(["text", "json", "markdown"]);
const OUTPUT_ON_INVALID = new Set(["fail", "warn"]);
const OUTPUT_CONTRACT_KEYS = new Set([
	"requiredPaths",
	"arrays",
	"maxStringChars",
]);
const SOURCE_CONTEXT_KEYS = new Set([
	"maxPreviewChars",
	"maxStructuredChars",
	"maxStructuredCharsByStage",
	"structuredOutputPathsByStage",
	"maxPacketChars",
]);
const SUPPORT_STAGE_KEYS = new Set([
	"id",
	"type",
	"from",
	"after",
	"support",
	"sourcePolicy",
]);
const SUPPORT_SPEC_KEYS = new Set(["uses", "options"]);
const LEGACY_TRANSFORM_MIGRATION_MESSAGE =
	'legacy type "transform" is not supported; use support: { "uses": "./helpers/name.mjs", "options": { ... } } without a type field';
const LEGACY_FLOW_MIGRATION_MESSAGE =
	"legacy flow.type bodies are not supported; use workflow.stages with stage type fields and from dependencies";
const TOOL_OBJECT_KEYS = new Set([
	"name",
	"extensions",
	"classification",
	"optional",
	"fallbackTools",
]);
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:/-]+$/;

export interface LoadedWorkflowSpec extends ResolvedWorkflowSpecRef {
	spec: WorkflowSpec;
}

export async function loadWorkflowSpec(
	specRef: string,
	cwd: string,
): Promise<LoadedWorkflowSpec> {
	const resolved = await resolveWorkflowRef(specRef, cwd);
	let parsed: unknown;

	try {
		parsed = parseSpecText(
			await readFile(resolved.specPath, "utf8"),
			resolved.specPath,
		);
	} catch (error) {
		if (error instanceof WorkflowValidationError) throw error;
		throw new WorkflowValidationError([
			{
				path: specRef,
				message: error instanceof Error ? error.message : String(error),
			},
		]);
	}

	return {
		...resolved,
		spec: parseWorkflow(parsed),
	};
}

function parseSpecText(text: string, specPath: string): unknown {
	const extension = extname(specPath).toLowerCase();
	if (extension === ".yaml" || extension === ".yml")
		return parseYamlSubset(text, specPath);
	return JSON.parse(text);
}

function parseBackend(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	const backend = objectAt(value, path, issues);
	if (!backend) return;

	rejectUnknownKeys(backend, BACKEND_KEYS, path, issues);

	if (backend.type !== undefined && backend.type !== "local-pi") {
		issues.push({ path: `${path}.type`, message: 'must be "local-pi"' });
	}

	if (
		backend.mode !== undefined &&
		backend.mode !== "auto" &&
		backend.mode !== "headless"
	) {
		issues.push({
			path: `${path}.mode`,
			message: 'must be "auto" or "headless"',
		});
	}
}

function parseOutputTemplates(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	const templates = objectAt(value, path, issues);
	if (!templates) return;
	for (const key of Object.keys(templates)) {
		if (key.trim() === "")
			issues.push({ path, message: "template names must be non-empty" });
	}
}

function parseOutput(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	const output = objectAt(value, path, issues);
	if (!output) return;
	rejectUnknownKeys(output, OUTPUT_KEYS, path, issues);
	if (!OUTPUT_FORMATS.has(output.format as string))
		issues.push({
			path: `${path}.format`,
			message: "must be one of: text, json, markdown",
		});
	optionalStringArray(output, "requiredKeys", `${path}.requiredKeys`, issues);
	optionalString(output, "templateRef", `${path}.templateRef`, issues);
	if (output.template !== undefined && output.templateRef !== undefined) {
		issues.push({
			path,
			message: "must not specify both template and templateRef",
		});
	}
	if (
		output.onInvalid !== undefined &&
		!OUTPUT_ON_INVALID.has(output.onInvalid as string)
	) {
		issues.push({
			path: `${path}.onInvalid`,
			message: "must be one of: fail, warn",
		});
	}
	if (output.contract !== undefined)
		parseOutputContract(output.contract, `${path}.contract`, issues);
}

function parseOutputContract(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	const contract = objectAt(value, path, issues);
	if (!contract) return;
	rejectUnknownKeys(contract, OUTPUT_CONTRACT_KEYS, path, issues);
	optionalStringArray(
		contract,
		"requiredPaths",
		`${path}.requiredPaths`,
		issues,
	);
}

function parseSourceContext(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	const sourceContext = objectAt(value, path, issues);
	if (!sourceContext) return;
	rejectUnknownKeys(sourceContext, SOURCE_CONTEXT_KEYS, path, issues);
	optionalPositiveInteger(
		sourceContext,
		"maxPreviewChars",
		`${path}.maxPreviewChars`,
		issues,
	);
	optionalPositiveInteger(
		sourceContext,
		"maxStructuredChars",
		`${path}.maxStructuredChars`,
		issues,
	);
	optionalPositiveInteger(
		sourceContext,
		"maxPacketChars",
		`${path}.maxPacketChars`,
		issues,
	);
	parsePositiveIntegerMap(
		sourceContext.maxStructuredCharsByStage,
		`${path}.maxStructuredCharsByStage`,
		issues,
	);
	parseJsonPathArrayMap(
		sourceContext.structuredOutputPathsByStage,
		`${path}.structuredOutputPathsByStage`,
		issues,
	);
}

function parsePositiveIntegerMap(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	if (value === undefined) return;
	const map = objectAt(value, path, issues);
	if (!map) return;
	for (const [key, item] of Object.entries(map)) {
		if (key.trim() === "")
			issues.push({ path, message: "keys must be non-empty" });
		if (typeof item !== "number" || !Number.isInteger(item) || item <= 0) {
			issues.push({
				path: `${path}.${jsonKey(key)}`,
				message: "must be a positive integer",
			});
		}
	}
}

function parseJsonPathArrayMap(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	if (value === undefined) return;
	const map = objectAt(value, path, issues);
	if (!map) return;
	for (const [key, paths] of Object.entries(map)) {
		if (key.trim() === "")
			issues.push({ path, message: "keys must be non-empty" });
		const itemPath = `${path}.${jsonKey(key)}`;
		if (!Array.isArray(paths)) {
			issues.push({ path: itemPath, message: "must be an array" });
			continue;
		}
		const seen = new Set<string>();
		paths.forEach((jsonPath, index) => {
			const entryPath = `${itemPath}[${index}]`;
			if (typeof jsonPath !== "string" || jsonPath.trim() === "") {
				issues.push({ path: entryPath, message: "must be a non-empty string" });
				return;
			}
			if (!jsonPath.startsWith("$."))
				issues.push({ path: entryPath, message: "must start with $." });
			if (seen.has(jsonPath))
				issues.push({
					path: entryPath,
					message: `duplicate value "${jsonPath}"`,
				});
			seen.add(jsonPath);
		});
	}
}

function objectAt(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): Record<string, unknown> | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		issues.push({ path, message: "must be an object" });
		return undefined;
	}
	return value as Record<string, unknown>;
}

function rejectUnknownKeys(
	object: Record<string, unknown>,
	allowedKeys: Set<string>,
	path: string,
	issues: ValidationIssue[],
): void {
	for (const key of Object.keys(object)) {
		if (!allowedKeys.has(key)) {
			issues.push({
				path: `${path}.${jsonKey(key)}`,
				message: "unknown field",
			});
		}
	}
}

function requiredString(
	object: Record<string, unknown>,
	key: string,
	path: string,
	issues: ValidationIssue[],
): void {
	if (object[key] === undefined) {
		issues.push({ path, message: "is required" });
		return;
	}
	optionalString(object, key, path, issues);
}

function optionalString(
	object: Record<string, unknown>,
	key: string,
	path: string,
	issues: ValidationIssue[],
): void {
	if (object[key] === undefined) return;
	if (
		typeof object[key] !== "string" ||
		(object[key] as string).trim() === ""
	) {
		issues.push({ path, message: "must be a non-empty string" });
	}
}

function optionalBoolean(
	object: Record<string, unknown>,
	key: string,
	path: string,
	issues: ValidationIssue[],
): void {
	if (object[key] === undefined) return;
	if (typeof object[key] !== "boolean") {
		issues.push({ path, message: "must be a boolean" });
	}
}

function optionalPositiveInteger(
	object: Record<string, unknown>,
	key: string,
	path: string,
	issues: ValidationIssue[],
	max?: number,
): void {
	if (object[key] === undefined) return;
	const value = object[key];
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		issues.push({ path, message: "must be a positive integer" });
		return;
	}
	if (max !== undefined && value > max) {
		issues.push({ path, message: `must be less than or equal to ${max}` });
	}
}

function optionalWorkflowToolArray(
	object: Record<string, unknown>,
	key: string,
	path: string,
	issues: ValidationIssue[],
): void {
	if (object[key] === undefined) return;
	validateWorkflowToolArray(object[key], path, issues);
}

function validateWorkflowToolArray(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	if (!Array.isArray(value)) {
		issues.push({ path, message: "must be an array" });
		return;
	}

	const seen = new Set<string>();
	value.forEach((item, index) => {
		const itemPath = `${path}[${index}]`;
		const name = validateWorkflowToolEntry(item, itemPath, issues);
		if (name === undefined) return;
		if (seen.has(name))
			issues.push({ path: itemPath, message: `duplicate value "${name}"` });
		seen.add(name);
	});
}

function validateWorkflowToolEntry(
	item: unknown,
	path: string,
	issues: ValidationIssue[],
): string | undefined {
	if (typeof item === "string") {
		validateToolName(item, path, issues);
		return item;
	}

	const tool = objectAt(item, path, issues);
	if (!tool) return undefined;

	rejectUnknownKeys(tool, TOOL_OBJECT_KEYS, path, issues);
	requiredString(tool, "name", `${path}.name`, issues);
	if (typeof tool.name !== "string") return undefined;
	validateToolName(tool.name, `${path}.name`, issues);

	optionalStringArray(tool, "extensions", `${path}.extensions`, issues);
	optionalEnum(
		tool,
		"classification",
		TOOL_CLASSIFICATIONS,
		`${path}.classification`,
		issues,
	);
	optionalBoolean(tool, "optional", `${path}.optional`, issues);
	optionalToolNameArray(tool, "fallbackTools", `${path}.fallbackTools`, issues);

	return tool.name;
}

function optionalToolNameArray(
	object: Record<string, unknown>,
	key: string,
	path: string,
	issues: ValidationIssue[],
): void {
	if (object[key] === undefined) return;
	if (!Array.isArray(object[key])) {
		issues.push({ path, message: "must be an array" });
		return;
	}

	const seen = new Set<string>();
	(object[key] as unknown[]).forEach((item, index) => {
		const itemPath = `${path}[${index}]`;
		if (typeof item !== "string") {
			issues.push({ path: itemPath, message: "must be a non-empty string" });
			return;
		}
		validateToolName(item, itemPath, issues);
		if (seen.has(item))
			issues.push({ path: itemPath, message: `duplicate value "${item}"` });
		seen.add(item);
	});
}

function validateToolName(
	value: string,
	path: string,
	issues: ValidationIssue[],
): void {
	if (value.trim() === "") {
		issues.push({ path, message: "must be a non-empty string" });
		return;
	}
	if (!TOOL_NAME_PATTERN.test(value))
		issues.push({ path, message: `invalid tool name "${value}"` });
}

function optionalStringArray(
	object: Record<string, unknown>,
	key: string,
	path: string,
	issues: ValidationIssue[],
): void {
	if (object[key] === undefined) return;
	if (!Array.isArray(object[key])) {
		issues.push({ path, message: "must be an array" });
		return;
	}

	const seen = new Set<string>();
	(object[key] as unknown[]).forEach((item, index) => {
		if (typeof item !== "string" || item.trim() === "") {
			issues.push({
				path: `${path}[${index}]`,
				message: "must be a non-empty string",
			});
			return;
		}
		if (seen.has(item)) {
			issues.push({
				path: `${path}[${index}]`,
				message: `duplicate value "${item}"`,
			});
		}
		seen.add(item);
	});
}

function optionalEnum<T extends readonly string[]>(
	object: Record<string, unknown>,
	key: string,
	values: T,
	path: string,
	issues: ValidationIssue[],
): void {
	if (object[key] === undefined) return;
	if (!values.includes(object[key] as never)) {
		issues.push({ path, message: `must be one of: ${values.join(", ")}` });
	}
}

function jsonKey(key: string): string {
	return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

export const loadWorkflow = loadWorkflowSpec;

const STAGE_FIRST_LOOP_MAX_ROUNDS = 50;
const STAGE_FIRST_OUTPUT_FORMATS = ["text", "json", "markdown"] as const;
const STAGE_FIRST_OUTPUT_ON_INVALID = ["fail", "warn"] as const;
const STAGE_FIRST_OUTPUT_KEYS = new Set([
	"format",
	"requiredKeys",
	"onInvalid",
	"contract",
	"template",
	"templateRef",
]);
const STAGE_FIRST_LOOP_STAGE_KEYS = new Set([
	"id",
	"type",
	"stages",
	"maxRounds",
	"until",
	"progressPath",
	"onExhausted",
	"prompt",
	"agent",
	"role",
	"cwd",
	"model",
	"thinking",
	"fast",
	"approvalMode",
	"tools",
	"readOnly",
	"worktreePolicy",
	"maxRuntimeMs",
	"maxConcurrency",
	"from",
	"after",
	"sourcePolicy",
	"sourceContext",
	"inject",
	"output",
	"outputContract",
]);
const STAGE_FIRST_UNTIL_KEYS = new Set([
	"stage",
	"path",
	"equals",
	"notEquals",
	"lengthEquals",
	"all",
	"any",
]);

function isStageFirstSpec(value: unknown): value is any {
	return Boolean(
		value && typeof value === "object" && (value as any).workflow?.stages,
	);
}

export function parseStageFirstWorkflowSpec(value: unknown): any {
	if (!value || typeof value !== "object")
		throw new WorkflowValidationError([
			{ path: "$", message: "must be an object" },
		]);
	const spec = value as any;
	const stages = spec.workflow?.stages;
	if (spec.schemaVersion !== 1)
		throw new WorkflowValidationError([
			{ path: "$.schemaVersion", message: "must be exactly 1" },
		]);
	if (!Array.isArray(stages))
		throw new WorkflowValidationError([
			{ path: "$.workflow.stages", message: "must be an array" },
		]);

	const issues: ValidationIssue[] = [];
	if (spec.backend !== undefined)
		parseBackend(spec.backend, "$.backend", issues);
	if (spec.defaults?.backend !== undefined)
		parseBackend(spec.defaults.backend, "$.defaults.backend", issues);
	if (spec.fast === "on")
		issues.push({ path: "$.fast", message: "fast:on is not supported" });
	if (spec.defaults?.fast === "on")
		issues.push({
			path: "$.defaults.fast",
			message: "fast:on is not supported",
		});
	if (spec.outputTemplates !== undefined)
		parseOutputTemplates(spec.outputTemplates, "$.outputTemplates", issues);
	if (spec.tools !== undefined)
		optionalWorkflowToolArray(spec, "tools", "$.tools", issues);
	if (
		spec.defaults &&
		typeof spec.defaults === "object" &&
		!Array.isArray(spec.defaults) &&
		spec.defaults.tools !== undefined
	) {
		optionalWorkflowToolArray(
			spec.defaults,
			"tools",
			"$.defaults.tools",
			issues,
		);
	}

	const stageIds = new Set<string>();
	for (const [index, stageValue] of stages.entries()) {
		const stagePath = `$.workflow.stages[${index}]`;
		const stage = requireStageFirstObject(stageValue, stagePath);
		const stageId = validateStageFirstRequiredString(
			stage,
			"id",
			`${stagePath}.id`,
		);
		if (stageIds.has(stageId))
			throw new WorkflowValidationError([
				{ path: `${stagePath}.id`, message: `duplicate stage id "${stageId}"` },
			]);
		stageIds.add(stageId);
		validateStageFirstStage(stage, stagePath);
		if (stage.output !== undefined)
			parseOutput(stage.output, `${stagePath}.output`, issues);
		if (stage.sourceContext !== undefined)
			parseSourceContext(
				stage.sourceContext,
				`${stagePath}.sourceContext`,
				issues,
			);
		if (stage.type === "transform") {
			issues.push({
				path: `${stagePath}.type`,
				message: LEGACY_TRANSFORM_MIGRATION_MESSAGE,
			});
		}
		if (stage.support !== undefined)
			validateStageFirstSupportStage(stage, stagePath, issues);
		if (stage.type === "loop") validateStageFirstLoopStage(stage, stagePath);
	}
	validateStageFirstDagGraph(stages, issues);

	if (issues.length > 0) throw new WorkflowValidationError(issues);
	return spec;
}

function requireStageFirstObject(
	value: unknown,
	path: string,
): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new WorkflowValidationError([{ path, message: "must be an object" }]);
	}
	return value as Record<string, unknown>;
}

function validateStageFirstStage(
	stage: Record<string, unknown>,
	path: string,
): void {
	if (stage.continuation !== undefined)
		throw new WorkflowValidationError([
			{ path: `${path}.continuation`, message: "unknown field" },
		]);
	if (stage.fast === "on")
		throw new WorkflowValidationError([
			{
				path: `${path}.fast`,
				message: '"on" is not supported for workflow stages',
			},
		]);
	if (stage.tools !== undefined)
		validateStageFirstWorkflowToolArray(stage.tools, `${path}.tools`);
	if (stage.after !== undefined)
		validateStageFirstAfter(stage.after, `${path}.after`);
	if (stage.output !== undefined)
		validateStageFirstOutput(stage.output, `${path}.output`);
	if (stage.sourceContext !== undefined)
		validateStageFirstSourceContext(
			stage.sourceContext,
			`${path}.sourceContext`,
		);

	if (stage.type === "parallel" && Array.isArray(stage.tasks)) {
		for (const [taskIndex, taskValue] of stage.tasks.entries()) {
			const task =
				taskValue && typeof taskValue === "object" && !Array.isArray(taskValue)
					? (taskValue as Record<string, unknown>)
					: undefined;
			if (task?.inject !== undefined)
				throw new WorkflowValidationError([
					{
						path: `${path}.tasks[${taskIndex}].inject`,
						message: "unknown field",
					},
				]);
		}
	}

	const each = stage.each;
	if (
		stage.type === "foreach" &&
		each &&
		typeof each === "object" &&
		!Array.isArray(each) &&
		(each as Record<string, unknown>).inject !== undefined
	) {
		throw new WorkflowValidationError([
			{ path: `${path}.each.inject`, message: "unknown field" },
		]);
	}
}

function validateStageFirstSupportStage(
	stage: Record<string, unknown>,
	path: string,
	issues: ValidationIssue[],
): void {
	rejectUnknownKeys(stage, SUPPORT_STAGE_KEYS, path, issues);
	if (stage.type !== undefined) {
		issues.push({
			path: `${path}.type`,
			message:
				"support nodes must not declare type; use support.uses without a type field",
		});
	}

	const support = objectAt(stage.support, `${path}.support`, issues);
	if (!support) return;
	rejectUnknownKeys(support, SUPPORT_SPEC_KEYS, `${path}.support`, issues);
	requiredString(support, "uses", `${path}.support.uses`, issues);
	if (support.options !== undefined)
		objectAt(support.options, `${path}.support.options`, issues);
}

function validateStageFirstOutput(value: unknown, path: string): void {
	const output = requireStageFirstObject(value, path);
	rejectUnknownStageFirstKeys(output, STAGE_FIRST_OUTPUT_KEYS, path);

	if (output.format === undefined)
		throw new WorkflowValidationError([
			{ path: `${path}.format`, message: "is required" },
		]);
	if (!STAGE_FIRST_OUTPUT_FORMATS.includes(output.format as never)) {
		throw new WorkflowValidationError([
			{
				path: `${path}.format`,
				message: `must be one of: ${STAGE_FIRST_OUTPUT_FORMATS.join(", ")}`,
			},
		]);
	}
	if (output.requiredKeys !== undefined)
		validateStageFirstStringArray(output.requiredKeys, `${path}.requiredKeys`);
	if (
		output.onInvalid !== undefined &&
		!STAGE_FIRST_OUTPUT_ON_INVALID.includes(output.onInvalid as never)
	) {
		throw new WorkflowValidationError([
			{
				path: `${path}.onInvalid`,
				message: `must be one of: ${STAGE_FIRST_OUTPUT_ON_INVALID.join(", ")}`,
			},
		]);
	}
}

function validateStageFirstSourceContext(value: unknown, path: string): void {
	if (typeof value === "boolean") return;
	requireStageFirstObject(value, path);
}

function validateStageFirstStringArray(value: unknown, path: string): void {
	if (!Array.isArray(value))
		throw new WorkflowValidationError([{ path, message: "must be an array" }]);

	const seen = new Set<string>();
	for (const [index, item] of value.entries()) {
		if (typeof item !== "string" || item.trim() === "") {
			throw new WorkflowValidationError([
				{ path: `${path}[${index}]`, message: "must be a non-empty string" },
			]);
		}
		if (seen.has(item))
			throw new WorkflowValidationError([
				{ path: `${path}[${index}]`, message: `duplicate value "${item}"` },
			]);
		seen.add(item);
	}
}

function validateStageFirstAfter(value: unknown, path: string): void {
	if (typeof value === "string") {
		if (value.trim() === "")
			throw new WorkflowValidationError([
				{ path, message: "must be a non-empty string" },
			]);
		return;
	}
	if (!Array.isArray(value))
		throw new WorkflowValidationError([
			{ path, message: "must be a string or array of strings" },
		]);
	for (const [index, item] of value.entries()) {
		if (typeof item !== "string" || item.trim() === "")
			throw new WorkflowValidationError([
				{ path: `${path}[${index}]`, message: "must be a non-empty string" },
			]);
	}
}

function validateStageFirstWorkflowToolArray(
	value: unknown,
	path: string,
): void {
	const issues: ValidationIssue[] = [];
	validateWorkflowToolArray(value, path, issues);
	if (issues.length > 0) throw new WorkflowValidationError([issues[0]!]);
}

function validateStageFirstLoopStage(
	stage: Record<string, unknown>,
	path: string,
): void {
	rejectUnknownStageFirstKeys(stage, STAGE_FIRST_LOOP_STAGE_KEYS, path);
	validateStageFirstRequiredString(stage, "id", `${path}.id`);

	if (stage.stages === undefined)
		throw new WorkflowValidationError([
			{ path: `${path}.stages`, message: "is required" },
		]);
	if (!Array.isArray(stage.stages))
		throw new WorkflowValidationError([
			{ path: `${path}.stages`, message: "must be an array" },
		]);
	if (stage.stages.length < 2) {
		throw new WorkflowValidationError([
			{
				path: `${path}.stages`,
				message:
					"must contain at least 2 stages (separate implementation and check stages)",
			},
		]);
	}

	const childStageIds = new Set<string>();
	const childStageIdList: string[] = [];
	for (const [childIndex, childValue] of stage.stages.entries()) {
		const childPath = `${path}.stages[${childIndex}]`;
		const childStage = requireStageFirstObject(childValue, childPath);
		const childStageId = validateStageFirstRequiredString(
			childStage,
			"id",
			`${childPath}.id`,
		);
		if (childStageIds.has(childStageId)) {
			throw new WorkflowValidationError([
				{
					path: `${childPath}.id`,
					message: `duplicate child stage id "${childStageId}"`,
				},
			]);
		}
		childStageIds.add(childStageId);
		childStageIdList.push(childStageId);
		if (childStage.type === "loop")
			throw new WorkflowValidationError([
				{
					path: `${childPath}.type`,
					message: "loop nesting is not supported in v1",
				},
			]);
		if (childStage.type === "foreach")
			throw new WorkflowValidationError([
				{
					path: `${childPath}.type`,
					message: "foreach child stages are deferred for loop v1",
				},
			]);
		if (childStage.type === "transform")
			throw new WorkflowValidationError([
				{
					path: `${childPath}.type`,
					message: LEGACY_TRANSFORM_MIGRATION_MESSAGE,
				},
			]);
		if (childStage.support !== undefined)
			throw new WorkflowValidationError([
				{
					path: `${childPath}.support`,
					message:
						"support child stages are deferred for loop v1; loop round materialization is only validated for task children",
				},
			]);
		if (childStage.type === "parallel") {
			throw new WorkflowValidationError([
				{
					path: `${childPath}.type`,
					message:
						"parallel child stages are not supported in loop v1 because loop children share one worktree and until/progress selection must remain deterministic",
				},
			]);
		}
		if (childStage.from !== undefined) {
			throw new WorkflowValidationError([
				{
					path: `${childPath}.from`,
					message:
						"loop child stages must not define from in v1; loop children run strictly in listed order so the final check observes all mutations",
				},
			]);
		}
		if (childStage.after !== undefined) {
			throw new WorkflowValidationError([
				{
					path: `${childPath}.after`,
					message:
						"loop child stages must not define after in v1; loop children run strictly in listed order so the final check observes all mutations",
				},
			]);
		}
		validateStageFirstStage(childStage, childPath);
	}

	validateStageFirstLoopMaxRounds(stage.maxRounds, `${path}.maxRounds`);

	if (stage.until === undefined)
		throw new WorkflowValidationError([
			{ path: `${path}.until`, message: "is required" },
		]);
	const untilStageRefs: Array<{ stageId: string; path: string }> = [];
	validateStageFirstUntilCondition(
		stage.until,
		`${path}.until`,
		childStageIds,
		untilStageRefs,
	);
	validateStageFirstLoopCheckSeparation(untilStageRefs, childStageIdList);

	if (
		stage.progressPath !== undefined &&
		(typeof stage.progressPath !== "string" ||
			!stage.progressPath.startsWith("$."))
	) {
		throw new WorkflowValidationError([
			{
				path: `${path}.progressPath`,
				message: "must be a string starting with $.",
			},
		]);
	}

	if (stage.onExhausted !== undefined) {
		const onExhausted = requireStageFirstObject(
			stage.onExhausted,
			`${path}.onExhausted`,
		);
		validateStageFirstStage(onExhausted, `${path}.onExhausted`);
		if (onExhausted.type !== "reduce") {
			throw new WorkflowValidationError([
				{ path: `${path}.onExhausted.type`, message: 'must be "reduce"' },
			]);
		}
	}
}

function validateStageFirstLoopMaxRounds(value: unknown, path: string): void {
	if (value === undefined)
		throw new WorkflowValidationError([{ path, message: "is required" }]);
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new WorkflowValidationError([
			{ path, message: "must be a positive integer" },
		]);
	}
	if (value > STAGE_FIRST_LOOP_MAX_ROUNDS) {
		throw new WorkflowValidationError([
			{
				path,
				message: `must be less than or equal to ${STAGE_FIRST_LOOP_MAX_ROUNDS}`,
			},
		]);
	}
}

function validateStageFirstRequiredString(
	object: Record<string, unknown>,
	key: string,
	path: string,
): string {
	if (object[key] === undefined)
		throw new WorkflowValidationError([{ path, message: "is required" }]);
	const value = object[key];
	if (typeof value !== "string" || value.trim() === "") {
		throw new WorkflowValidationError([
			{ path, message: "must be a non-empty string" },
		]);
	}
	return value;
}

function validateStageFirstLoopCheckSeparation(
	untilStageRefs: Array<{ stageId: string; path: string }>,
	childStageIds: string[],
): void {
	const finalCheckStageId = childStageIds[childStageIds.length - 1];
	if (!finalCheckStageId) return;
	for (const ref of untilStageRefs) {
		if (ref.stageId !== finalCheckStageId) {
			throw new WorkflowValidationError([
				{
					path: ref.path,
					message:
						"loop until/check stage must be the final child stage in v1; loop children run strictly in listed order so validation observes all mutations",
				},
			]);
		}
	}
}

function validateStageFirstUntilCondition(
	value: unknown,
	path: string,
	childStageIds: Set<string>,
	stageRefs: Array<{ stageId: string; path: string }> = [],
): void {
	const condition = requireStageFirstObject(value, path);
	rejectUnknownStageFirstKeys(condition, STAGE_FIRST_UNTIL_KEYS, path);

	const hasAll = condition.all !== undefined;
	const hasAny = condition.any !== undefined;
	const combinatorCount = Number(hasAll) + Number(hasAny);
	const operatorKeys = ["equals", "notEquals", "lengthEquals"].filter(
		(key) => condition[key] !== undefined,
	);
	const hasLeafField =
		condition.stage !== undefined ||
		condition.path !== undefined ||
		operatorKeys.length > 0;

	if (combinatorCount > 0) {
		if (combinatorCount > 1 || hasLeafField) {
			throw new WorkflowValidationError([
				{
					path,
					message:
						"must be either a leaf condition or a single all/any combinator",
				},
			]);
		}
		const key = hasAll ? "all" : "any";
		const items = condition[key];
		if (!Array.isArray(items))
			throw new WorkflowValidationError([
				{ path: `${path}.${key}`, message: "must be an array" },
			]);
		if (items.length < 1)
			throw new WorkflowValidationError([
				{
					path: `${path}.${key}`,
					message: "must contain at least one condition",
				},
			]);
		for (const [index, item] of items.entries())
			validateStageFirstUntilCondition(
				item,
				`${path}.${key}[${index}]`,
				childStageIds,
				stageRefs,
			);
		return;
	}

	if (operatorKeys.length !== 1) {
		throw new WorkflowValidationError([
			{
				path,
				message:
					"leaf condition must define exactly one of equals, notEquals, or lengthEquals",
			},
		]);
	}

	if (typeof condition.stage !== "string" || condition.stage.trim() === "") {
		throw new WorkflowValidationError([
			{ path: `${path}.stage`, message: "must be a non-empty string" },
		]);
	}
	if (!childStageIds.has(condition.stage)) {
		throw new WorkflowValidationError([
			{
				path: `${path}.stage`,
				message: `unknown child stage reference "${condition.stage}"`,
			},
		]);
	}
	stageRefs.push({ stageId: condition.stage, path: `${path}.stage` });

	if (typeof condition.path !== "string" || !condition.path.startsWith("$.")) {
		throw new WorkflowValidationError([
			{ path: `${path}.path`, message: "must be a string starting with $." },
		]);
	}

	const operator = operatorKeys[0]!;
	const operatorValue = condition[operator];
	if (operator === "lengthEquals") {
		if (
			typeof operatorValue !== "number" ||
			!Number.isInteger(operatorValue) ||
			operatorValue < 0
		) {
			throw new WorkflowValidationError([
				{
					path: `${path}.lengthEquals`,
					message: "must be an integer greater than or equal to 0",
				},
			]);
		}
		return;
	}

	const valueType = typeof operatorValue;
	if (
		valueType !== "string" &&
		valueType !== "number" &&
		valueType !== "boolean"
	) {
		throw new WorkflowValidationError([
			{
				path: `${path}.${operator}`,
				message: "must be a string, number, or boolean",
			},
		]);
	}
}

type StageFirstDagRef = { stageId: string; path: string };
type StageFirstDagEdge = { toId: string; path: string };

function validateStageFirstDagGraph(
	stages: unknown[],
	issues: ValidationIssue[],
): void {
	const stageIndexById = new Map<string, number>();
	for (const [index, stageValue] of stages.entries()) {
		const stage = stageValue as Record<string, unknown>;
		if (typeof stage.id === "string" && stage.id.trim() !== "")
			stageIndexById.set(stage.id, index);
	}

	const stageIds = [...stageIndexById.keys()];
	const adjacency = new Map<string, StageFirstDagEdge[]>();
	for (const [index, stageValue] of stages.entries()) {
		const stage = stageValue as Record<string, unknown>;
		if (typeof stage.id !== "string" || stage.id.trim() === "") continue;
		for (const ref of stageFirstDagRefs(stage, index)) {
			if (!stageIndexById.has(ref.stageId)) {
				issues.push({
					path: ref.path,
					message: `unknown stage reference "${ref.stageId}"`,
				});
				continue;
			}
			if (ref.stageId === stage.id) {
				issues.push({
					path: ref.path,
					message: "stage must not depend on itself",
				});
				continue;
			}
			const edges = adjacency.get(stage.id) ?? [];
			edges.push({ toId: ref.stageId, path: ref.path });
			adjacency.set(stage.id, edges);
		}
	}

	const cycle = findDependencyCycle(stageIds, adjacency);
	if (cycle)
		issues.push({
			path: cycle.path,
			message: `dependency cycle detected: ${cycle.stageIds.join(" -> ")}`,
		});
}

function stageFirstDagRefs(
	stage: Record<string, unknown>,
	index: number,
): StageFirstDagRef[] {
	const path = `$.workflow.stages[${index}]`;
	return [
		...stageFirstFromRefs(stage.from, `${path}.from`),
		...stageFirstAfterRefs(stage.after, `${path}.after`),
	];
}

function stageFirstFromRefs(from: unknown, path: string): StageFirstDagRef[] {
	if (from === undefined) return [];
	if (typeof from === "string") return [{ stageId: from, path }];
	if (Array.isArray(from)) {
		return from
			.map((item, index) =>
				typeof item === "string"
					? { stageId: item, path: `${path}[${index}]` }
					: undefined,
			)
			.filter((item): item is StageFirstDagRef => Boolean(item));
	}
	if (from && typeof from === "object" && !Array.isArray(from)) {
		const stage = (from as Record<string, unknown>).stage;
		if (typeof stage === "string") return [{ stageId: stage, path: `${path}.stage` }];
	}
	return [];
}

function stageFirstAfterRefs(after: unknown, path: string): StageFirstDagRef[] {
	if (after === undefined) return [];
	if (typeof after === "string") return [{ stageId: after, path }];
	if (Array.isArray(after)) {
		return after
			.map((item, index) =>
				typeof item === "string"
					? { stageId: item, path: `${path}[${index}]` }
					: undefined,
			)
			.filter((item): item is StageFirstDagRef => Boolean(item));
	}
	return [];
}

function findDependencyCycle(
	stageIds: string[],
	adjacency: Map<string, StageFirstDagEdge[]>,
): { path: string; stageIds: string[] } | undefined {
	const state = new Map<string, "visiting" | "visited">();
	for (const root of stageIds) {
		if (state.has(root)) continue;
		state.set(root, "visiting");
		const stack: Array<{ stageId: string; nextEdge: number }> = [
			{ stageId: root, nextEdge: 0 },
		];
		while (stack.length > 0) {
			const frame = stack[stack.length - 1]!;
			const edges = adjacency.get(frame.stageId) ?? [];
			if (frame.nextEdge >= edges.length) {
				state.set(frame.stageId, "visited");
				stack.pop();
				continue;
			}
			const edge = edges[frame.nextEdge]!;
			frame.nextEdge += 1;
			const edgeState = state.get(edge.toId);
			if (edgeState === "visiting") {
				const pathIds = stack.map((item) => item.stageId);
				const start = pathIds.indexOf(edge.toId);
				return {
					path: edge.path,
					stageIds: pathIds.slice(start).concat(edge.toId),
				};
			}
			if (!edgeState) {
				state.set(edge.toId, "visiting");
				stack.push({ stageId: edge.toId, nextEdge: 0 });
			}
		}
	}
	return undefined;
}

function rejectUnknownStageFirstKeys(
	object: Record<string, unknown>,
	allowedKeys: Set<string>,
	path: string,
): void {
	for (const key of Object.keys(object)) {
		if (!allowedKeys.has(key))
			throw new WorkflowValidationError([
				{ path: `${path}.${jsonKey(key)}`, message: "unknown field" },
			]);
	}
}

export function parseWorkflow(value: unknown): WorkflowSpec {
	if (
		value &&
		typeof value === "object" &&
		(value as any).flow?.type !== undefined
	) {
		throw new WorkflowValidationError([
			{ path: "$.flow.type", message: LEGACY_FLOW_MIGRATION_MESSAGE },
		]);
	}
	if (isStageFirstSpec(value)) return parseStageFirstWorkflowSpec(value);
	throw new WorkflowValidationError([
		{ path: "$.workflow.stages", message: "must be an array" },
	]);
}
