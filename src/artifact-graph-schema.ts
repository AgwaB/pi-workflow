import { isAbsolute } from "node:path";

import {
	APPROVAL_MODES,
	FAST_MODES,
	THINKING_LEVELS,
	TOOL_CLASSIFICATIONS,
	WORKTREE_POLICIES,
	WorkflowValidationError,
	type ArtifactGraphStageType,
	type ArtifactGraphWorkflowSpec,
	type ValidationIssue,
	type WorkflowArtifactKind,
} from "./types.js";

const TOP_LEVEL_KEYS = new Set([
	"schemaVersion",
	"name",
	"description",
	"input",
	"catalog",
	"defaults",
	"roles",
	"artifactGraph",
]);
const ARTIFACT_GRAPH_KEYS = new Set(["stages", "maxConcurrency"]);
const STAGE_TYPES = new Set<ArtifactGraphStageType>([
	"task",
	"reduce",
	"foreach",
	"support",
	"loop",
	"dag",
]);
const STAGE_KEYS = new Set([
	"id",
	"type",
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
	"maxItems",
	"from",
	"after",
	"sourcePolicy",
	"sourceProjection",
	"inputPolicy",
	"output",
	"each",
	"stages",
	"outputFrom",
	"support",
	"until",
	"maxRounds",
	"progressPath",
	"onExhausted",
]);
const OUTPUT_KEYS = new Set([
	"controlSchema",
	"analysis",
	"refs",
	"maxDigestChars",
]);
const REQUIRED_FLAG_KEYS = new Set(["required"]);
const INPUT_POLICY_KEYS = new Set(["requiredReads", "enforcement"]);
const SOURCE_PROJECTION_KEYS = new Set(["include", "maxChars"]);
const SUPPORT_KEYS = new Set(["uses", "options"]);
const EACH_KEYS = new Set([
	"prompt",
	"agent",
	"role",
	"tools",
	"readOnly",
	"model",
	"thinking",
	"maxRuntimeMs",
	"worktreePolicy",
]);
const UNTIL_KEYS = new Set([
	"source",
	"stage",
	"path",
	"equals",
	"notEquals",
	"lengthEquals",
	"exists",
	"all",
	"any",
]);
const FOREACH_FROM_KEYS = new Set(["source", "path"]);
const NORMAL_ARTIFACT_KINDS = new Set<WorkflowArtifactKind>([
	"control",
	"analysis",
	"refs",
	"raw",
]);
const SOURCE_POLICY_VALUES = new Set(["success", "partial", "require-success"]);

const TOOL_OBJECT_KEYS = new Set([
	"name",
	"extensions",
	"classification",
	"optional",
	"fallbackTools",
]);
const DEFAULTS_KEYS = new Set([
	"cwd",
	"agent",
	"model",
	"thinking",
	"fast",
	"approvalMode",
	"tools",
	"readOnly",
	"worktreePolicy",
	"maxConcurrency",
	"maxRuntimeMs",
	"backend",
]);
const ROLES_KEYS = new Set([
	"fromAgent",
	"prompt",
	"includeSections",
	"excludeSections",
	"maxChars",
]);

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:/-]+$/;

export function isArtifactGraphWorkflowSpecShape(
	value: unknown,
): value is ArtifactGraphWorkflowSpec {
	if (!isRecord(value)) return false;
	if (value.schemaVersion !== 1) return false;
	const graph = value.artifactGraph;
	return isRecord(graph) && Array.isArray(graph.stages);
}

export function parseArtifactGraphWorkflowSpec(
	value: unknown,
): ArtifactGraphWorkflowSpec {
	const issues: ValidationIssue[] = [];
	if (!isRecord(value)) {
		throw new WorkflowValidationError([
			{ path: "$", message: "must be an object" },
		]);
	}
	const spec = value as Record<string, unknown>;
	validateArtifactGraphTopLevel(spec, issues);
	validateArtifactGraphBody(spec.artifactGraph, "$.artifactGraph", issues);
	if (issues.length > 0) throw new WorkflowValidationError(issues);
	return spec as unknown as ArtifactGraphWorkflowSpec;
}

function validateArtifactGraphTopLevel(
	spec: Record<string, unknown>,
	issues: ValidationIssue[],
): void {
	if (spec.schemaVersion !== 1) {
		issues.push({ path: "$.schemaVersion", message: "must be exactly 1" });
	}
	rejectUnknownKeys(spec, TOP_LEVEL_KEYS, "$", issues);
	optionalString(spec.name, "$.name", issues);
	optionalString(spec.description, "$.description", issues);
	optionalRecord(spec.catalog, "$.catalog", issues);
	validateDefaults(spec.defaults, "$.defaults", issues);
	validateRoles(spec.roles, "$.roles", issues);
}

function validateArtifactGraphBody(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	const graph = recordAt(value, path, issues);
	if (!graph) return;
	rejectUnknownKeys(graph, ARTIFACT_GRAPH_KEYS, path, issues);
	optionalPositiveInteger(
		graph.maxConcurrency,
		`${path}.maxConcurrency`,
		issues,
	);
	validateStageArray(graph.stages, `${path}.stages`, issues);
}

function validateStageArray(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	if (!Array.isArray(value)) {
		issues.push({ path, message: "must be an array" });
		return;
	}
	if (value.length === 0) issues.push({ path, message: "must not be empty" });
	const ids = collectStageIds(value, path, issues);
	for (const [index, item] of value.entries()) {
		validateStage(item, `${path}[${index}]`, ids, issues);
	}
	validateStageDependencyGraph(value, path, issues);
}

function validateStageDependencyGraph(
	stages: readonly unknown[],
	path: string,
	issues: ValidationIssue[],
): void {
	const ids = new Set(
		stages
			.filter(isRecord)
			.map((stage) => stage.id)
			.filter((id): id is string => typeof id === "string" && id.trim() !== ""),
	);
	const outgoing = new Map<string, string[]>([...ids].map((id) => [id, []]));
	for (const [index, stage] of stages.entries()) {
		if (!isRecord(stage) || typeof stage.id !== "string") continue;
		for (const [field, refs] of dependencyRefsByField(stage)) {
			for (const ref of refs) {
				if (!ids.has(ref)) continue;
				if (ref === stage.id) {
					issues.push({
						path: `${path}[${index}].${field}`,
						message: `stage "${stage.id}" must not depend on itself`,
					});
					continue;
				}
				outgoing.get(ref)?.push(stage.id);
			}
		}
	}
	const state = new Map<string, "visiting" | "done">();
	const stack: string[] = [];
	const visit = (id: string): boolean => {
		const existing = state.get(id);
		if (existing === "visiting") {
			const cycle = [...stack.slice(stack.indexOf(id)), id].join(" -> ");
			issues.push({ path, message: `dependency cycle detected: ${cycle}` });
			return true;
		}
		if (existing === "done") return false;
		state.set(id, "visiting");
		stack.push(id);
		for (const next of outgoing.get(id) ?? []) {
			if (visit(next)) return true;
		}
		stack.pop();
		state.set(id, "done");
		return false;
	};
	for (const id of ids) {
		if (visit(id)) break;
	}
}

function dependencyRefsByField(
	stage: Record<string, unknown>,
): Array<["from" | "after", string[]]> {
	return [
		["from", extractDependencyRefs(stage.from)],
		["after", extractDependencyRefs(stage.after)],
	];
}

function extractDependencyRefs(value: unknown): string[] {
	if (value === undefined) return [];
	if (typeof value === "string") return [value];
	if (Array.isArray(value))
		return value.filter((item): item is string => typeof item === "string");
	if (isRecord(value) && typeof value.source === "string")
		return [value.source];
	return [];
}

function findSinkStageIds(stages: readonly unknown[]): string[] {
	const ids = new Set(
		stages
			.filter(isRecord)
			.map((stage) => stage.id)
			.filter((id): id is string => typeof id === "string" && id.trim() !== ""),
	);
	const referenced = new Set<string>();
	for (const stage of stages) {
		if (!isRecord(stage)) continue;
		for (const [, refs] of dependencyRefsByField(stage)) {
			for (const ref of refs) {
				if (ids.has(ref)) referenced.add(ref);
			}
		}
	}
	return [...ids].filter((id) => !referenced.has(id));
}

function collectStageIds(
	stages: readonly unknown[],
	path: string,
	issues: ValidationIssue[],
): Set<string> {
	const ids = new Set<string>();
	for (const [index, item] of stages.entries()) {
		const itemPath = `${path}[${index}]`;
		if (!isRecord(item)) continue;
		const id = requiredString(item.id, `${itemPath}.id`, issues);
		if (id === undefined) continue;
		if (ids.has(id)) {
			issues.push({
				path: `${itemPath}.id`,
				message: `duplicate stage id "${id}"`,
			});
		}
		ids.add(id);
	}
	return ids;
}

function validateStage(
	value: unknown,
	path: string,
	siblingIds: ReadonlySet<string>,
	issues: ValidationIssue[],
): void {
	const stage = recordAt(value, path, issues);
	if (!stage) return;
	rejectUnknownKeys(stage, STAGE_KEYS, path, issues);
	const type = validateStageType(stage.type, `${path}.type`, issues);
	optionalString(stage.prompt, `${path}.prompt`, issues);
	optionalString(stage.agent, `${path}.agent`, issues);
	optionalString(stage.cwd, `${path}.cwd`, issues);
	optionalString(stage.model, `${path}.model`, issues);
	optionalEnum(stage.thinking, THINKING_LEVELS, `${path}.thinking`, issues);
	optionalEnum(stage.fast, FAST_MODES, `${path}.fast`, issues);
	optionalEnum(
		stage.approvalMode,
		APPROVAL_MODES,
		`${path}.approvalMode`,
		issues,
	);
	optionalEnum(
		stage.worktreePolicy,
		WORKTREE_POLICIES,
		`${path}.worktreePolicy`,
		issues,
	);
	optionalBoolean(stage.readOnly, `${path}.readOnly`, issues);
	optionalPositiveInteger(stage.maxRuntimeMs, `${path}.maxRuntimeMs`, issues);
	optionalPositiveInteger(
		stage.maxConcurrency,
		`${path}.maxConcurrency`,
		issues,
	);
	optionalPositiveInteger(stage.maxItems, `${path}.maxItems`, issues);
	validateSourcePolicy(stage.sourcePolicy, `${path}.sourcePolicy`, issues);
	validateRole(stage.role, `${path}.role`, issues);
	validateWorkflowToolArray(stage.tools, `${path}.tools`, issues);
	validateStageRefs(stage.from, `${path}.from`, siblingIds, issues, {
		allowControlPath: type === "foreach",
	});
	validateStageRefs(stage.after, `${path}.after`, siblingIds, issues, {
		allowControlPath: false,
	});
	validateSourceProjection(
		stage.sourceProjection,
		`${path}.sourceProjection`,
		issues,
	);
	validateInputPolicy(
		stage.inputPolicy,
		`${path}.inputPolicy`,
		siblingIds,
		issues,
	);
	validateOutput(stage.output, `${path}.output`, issues);
	validateSupport(stage.support, `${path}.support`, issues);
	validateForeachStage(stage, type, path, issues);
	validateLoopStage(stage, type, path, siblingIds, issues);
	validateDagStage(stage, type, path, issues);
}

function validateStageType(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): ArtifactGraphStageType | undefined {
	const type = requiredString(value, path, issues);
	if (type === undefined) return undefined;
	if (!STAGE_TYPES.has(type as ArtifactGraphStageType)) {
		issues.push({
			path,
			message: "must be one of: task, reduce, foreach, support, loop, dag",
		});
		return undefined;
	}
	return type as ArtifactGraphStageType;
}

function validateStageRefs(
	value: unknown,
	path: string,
	siblingIds: ReadonlySet<string>,
	issues: ValidationIssue[],
	options: { allowControlPath: boolean },
): void {
	if (value === undefined) return;
	if (typeof value === "string") {
		validateKnownStageRef(value, path, siblingIds, issues);
		return;
	}
	if (Array.isArray(value)) {
		validateStringRefs(value, path, siblingIds, issues);
		return;
	}
	if (options.allowControlPath && isRecord(value)) {
		validateControlPathRef(value, path, siblingIds, issues);
		return;
	}
	issues.push({
		path,
		message: "must be a stage id string or array of stage ids",
	});
}

function validateStringRefs(
	items: readonly unknown[],
	path: string,
	siblingIds: ReadonlySet<string>,
	issues: ValidationIssue[],
): void {
	const seen = new Set<string>();
	for (const [index, item] of items.entries()) {
		const itemPath = `${path}[${index}]`;
		if (typeof item !== "string" || item.trim() === "") {
			issues.push({ path: itemPath, message: "must be a non-empty string" });
			continue;
		}
		if (seen.has(item))
			issues.push({ path: itemPath, message: `duplicate value "${item}"` });
		seen.add(item);
		validateKnownStageRef(item, itemPath, siblingIds, issues);
	}
}

function validateControlPathRef(
	value: Record<string, unknown>,
	path: string,
	siblingIds: ReadonlySet<string>,
	issues: ValidationIssue[],
): void {
	rejectUnknownKeys(value, FOREACH_FROM_KEYS, path, issues);
	const source = requiredString(value.source, `${path}.source`, issues);
	if (source)
		validateKnownStageRef(source, `${path}.source`, siblingIds, issues);
	const controlPath = requiredString(value.path, `${path}.path`, issues);
	if (controlPath && !controlPath.startsWith("$.")) {
		issues.push({
			path: `${path}.path`,
			message: "must be a control JSONPath starting with $.",
		});
	}
}

function validateKnownStageRef(
	stageId: string,
	path: string,
	siblingIds: ReadonlySet<string>,
	issues: ValidationIssue[],
): void {
	if (stageId.trim() === "") {
		issues.push({ path, message: "must be a non-empty string" });
		return;
	}
	if (!siblingIds.has(stageId)) {
		issues.push({ path, message: `unknown stage reference "${stageId}"` });
	}
}

function validateOutput(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	if (value === undefined) return;
	const output = recordAt(value, path, issues);
	if (!output) return;
	rejectUnknownKeys(output, OUTPUT_KEYS, path, issues);
	validateControlSchemaRef(
		output.controlSchema,
		`${path}.controlSchema`,
		issues,
	);
	optionalPositiveInteger(
		output.maxDigestChars,
		`${path}.maxDigestChars`,
		issues,
	);
	validateRequiredFlagObject(output.analysis, `${path}.analysis`, issues);
	validateRequiredFlagObject(output.refs, `${path}.refs`, issues);
}

function validateControlSchemaRef(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	if (value === undefined) return;
	if (typeof value !== "string" || value.trim() === "") {
		issues.push({ path, message: "must be a non-empty string" });
		return;
	}
	if (isAbsolute(value) || value.includes("\\")) {
		issues.push({ path, message: "must be a relative POSIX JSON file path" });
	}
	if (value.split("/").includes("..")) {
		issues.push({ path, message: "must not contain .. path segments" });
	}
	if (!value.endsWith(".json")) {
		issues.push({ path, message: "must point to a .json schema file" });
	}
}

function validateRequiredFlagObject(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	if (value === undefined) return;
	const object = recordAt(value, path, issues);
	if (!object) return;
	rejectUnknownKeys(object, REQUIRED_FLAG_KEYS, path, issues);
	optionalBoolean(object.required, `${path}.required`, issues);
}

function validateInputPolicy(
	value: unknown,
	path: string,
	siblingIds: ReadonlySet<string>,
	issues: ValidationIssue[],
): void {
	if (value === undefined) return;
	const policy = recordAt(value, path, issues);
	if (!policy) return;
	rejectUnknownKeys(policy, INPUT_POLICY_KEYS, path, issues);
	validateRequiredReads(
		policy.requiredReads,
		`${path}.requiredReads`,
		siblingIds,
		issues,
	);
	if (policy.enforcement !== undefined && policy.enforcement !== "fail") {
		issues.push({ path: `${path}.enforcement`, message: 'must be "fail"' });
	}
}

function validateRequiredReads(
	value: unknown,
	path: string,
	siblingIds: ReadonlySet<string>,
	issues: ValidationIssue[],
): void {
	if (value === undefined) return;
	if (!Array.isArray(value)) {
		issues.push({ path, message: "must be an array" });
		return;
	}
	const seen = new Set<string>();
	for (const [index, item] of value.entries()) {
		const itemPath = `${path}[${index}]`;
		if (typeof item !== "string" || item.trim() === "") {
			issues.push({
				path: itemPath,
				message: "must be a source.artifact string",
			});
			continue;
		}
		if (seen.has(item))
			issues.push({ path: itemPath, message: `duplicate value "${item}"` });
		seen.add(item);
		validateRequiredRead(item, itemPath, siblingIds, issues);
	}
}

function validateRequiredRead(
	value: string,
	path: string,
	siblingIds: ReadonlySet<string>,
	issues: ValidationIssue[],
): void {
	const dot = value.lastIndexOf(".");
	const source = dot > 0 ? value.slice(0, dot) : "";
	const artifact = dot > 0 ? value.slice(dot + 1) : "";
	if (source.trim() === "" || artifact.trim() === "") {
		issues.push({ path, message: "must use source.artifact form" });
		return;
	}
	if (!siblingIds.has(source)) {
		issues.push({
			path,
			message: `required read source "${source}" is not a visible sibling stage`,
		});
	}
	if (!NORMAL_ARTIFACT_KINDS.has(artifact as WorkflowArtifactKind)) {
		issues.push({
			path,
			message: "artifact must be one of: control, analysis, refs, raw",
		});
	}
}

function validateSourcePolicy(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	if (value === undefined) return;
	if (typeof value !== "string" || !SOURCE_POLICY_VALUES.has(value)) {
		issues.push({
			path,
			message: "must be one of: success, partial, require-success",
		});
	}
}

function validateSourceProjection(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	if (value === undefined) return;
	const projection = recordAt(value, path, issues);
	if (!projection) return;
	rejectUnknownKeys(projection, SOURCE_PROJECTION_KEYS, path, issues);
	validateJsonPathArray(projection.include, `${path}.include`, issues);
	optionalPositiveInteger(projection.maxChars, `${path}.maxChars`, issues);
}

function validateSupport(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	if (value === undefined) return;
	const support = recordAt(value, path, issues);
	if (!support) return;
	rejectUnknownKeys(support, SUPPORT_KEYS, path, issues);
	const uses = requiredString(support.uses, `${path}.uses`, issues);
	if (uses !== undefined) validateSupportRef(uses, `${path}.uses`, issues);
	optionalRecord(support.options, `${path}.options`, issues);
}

function validateSupportRef(
	value: string,
	path: string,
	issues: ValidationIssue[],
): void {
	if (!value.startsWith("./") || !value.endsWith(".mjs")) {
		issues.push({ path, message: "must be a relative ./ helper .mjs path" });
	}
	if (
		isAbsolute(value) ||
		value.includes("\\") ||
		value.split("/").includes("..")
	) {
		issues.push({ path, message: "must stay inside the workflow bundle" });
	}
}

function validateForeachStage(
	stage: Record<string, unknown>,
	type: ArtifactGraphStageType | undefined,
	path: string,
	issues: ValidationIssue[],
): void {
	if (type !== "foreach") {
		if (stage.each !== undefined) {
			issues.push({
				path: `${path}.each`,
				message: "is only valid on foreach stages",
			});
		}
		return;
	}
	const each = recordAt(stage.each, `${path}.each`, issues);
	if (!each) return;
	rejectUnknownKeys(each, EACH_KEYS, `${path}.each`, issues);
	requiredString(each.prompt, `${path}.each.prompt`, issues);
	optionalString(each.agent, `${path}.each.agent`, issues);
	validateRole(each.role, `${path}.each.role`, issues);
	validateWorkflowToolArray(each.tools, `${path}.each.tools`, issues);
	optionalBoolean(each.readOnly, `${path}.each.readOnly`, issues);
	optionalString(each.model, `${path}.each.model`, issues);
	optionalString(each.thinking, `${path}.each.thinking`, issues);
	optionalPositiveInteger(
		each.maxRuntimeMs,
		`${path}.each.maxRuntimeMs`,
		issues,
	);
	optionalString(each.worktreePolicy, `${path}.each.worktreePolicy`, issues);
}

function validateLoopStage(
	stage: Record<string, unknown>,
	type: ArtifactGraphStageType | undefined,
	path: string,
	siblingIds: ReadonlySet<string>,
	issues: ValidationIssue[],
): void {
	if (type !== "loop") {
		for (const key of [
			"until",
			"maxRounds",
			"progressPath",
			"onExhausted",
		] as const) {
			if (stage[key] !== undefined) {
				issues.push({
					path: `${path}.${key}`,
					message: "is only valid on loop stages",
				});
			}
		}
		return;
	}
	optionalPositiveInteger(stage.maxRounds, `${path}.maxRounds`, issues);
	optionalString(stage.progressPath, `${path}.progressPath`, issues);
	const until = recordAt(stage.until, `${path}.until`, issues);
	if (until) validateLoopUntil(until, `${path}.until`, issues);
	if (!Array.isArray(stage.stages)) {
		issues.push({
			path: `${path}.stages`,
			message: "loop stages must declare child stages",
		});
		return;
	}
	if (stage.stages.length < 2) {
		issues.push({
			path: `${path}.stages`,
			message: "loop requires at least two child stages",
		});
	}
	validateStageArray(stage.stages, `${path}.stages`, issues);
	validateLoopChildren(stage.stages, `${path}.stages`, issues);
	const childIds = stage.stages
		.filter(isRecord)
		.map((child) => child.id)
		.filter((id): id is string => typeof id === "string");
	const finalChildId = childIds.at(-1);
	if (until) {
		const untilSource =
			typeof until.source === "string"
				? until.source
				: typeof until.stage === "string"
					? until.stage
					: undefined;
		const untilSourcePath = until.source !== undefined ? "source" : "stage";
		if (untilSource) {
			if (!childIds.includes(untilSource)) {
				issues.push({
					path: `${path}.until.${untilSourcePath}`,
					message: `references unknown loop child stage "${untilSource}"`,
				});
			} else if (finalChildId && untilSource !== finalChildId) {
				issues.push({
					path: `${path}.until.${untilSourcePath}`,
					message: "must reference the final loop child stage",
				});
			}
		}
	}
	if (stage.onExhausted !== undefined) {
		validateStage(stage.onExhausted, `${path}.onExhausted`, siblingIds, issues);
	}
}

function validateLoopUntil(
	until: Record<string, unknown>,
	path: string,
	issues: ValidationIssue[],
): void {
	rejectUnknownKeys(until, UNTIL_KEYS, path, issues);
	optionalString(until.source, `${path}.source`, issues);
	optionalString(until.stage, `${path}.stage`, issues);
	optionalString(until.path, `${path}.path`, issues);
	optionalBoolean(until.exists, `${path}.exists`, issues);
	if (
		until.lengthEquals !== undefined &&
		!Number.isInteger(until.lengthEquals)
	) {
		issues.push({
			path: `${path}.lengthEquals`,
			message: "must be an integer",
		});
	}
	for (const key of ["all", "any"] as const) {
		if (until[key] === undefined) continue;
		if (!Array.isArray(until[key])) {
			issues.push({ path: `${path}.${key}`, message: "must be an array" });
			continue;
		}
		for (const [index, child] of until[key].entries()) {
			const childUntil = recordAt(child, `${path}.${key}[${index}]`, issues);
			if (childUntil)
				validateLoopUntil(childUntil, `${path}.${key}[${index}]`, issues);
		}
	}
}

function validateLoopChildren(
	stages: readonly unknown[],
	path: string,
	issues: ValidationIssue[],
): void {
	for (const [index, child] of stages.entries()) {
		if (!isRecord(child)) continue;
		const childPath = `${path}[${index}]`;
		if (["loop", "foreach", "support", "dag"].includes(String(child.type))) {
			issues.push({
				path: `${childPath}.type`,
				message: "loop child stages must be simple task or reduce stages",
			});
		}
		if (child.from !== undefined || child.after !== undefined) {
			issues.push({
				path:
					child.from !== undefined ? `${childPath}.from` : `${childPath}.after`,
				message:
					"loop child stages run serially and must not declare from/after",
			});
		}
	}
}

function validateDagStage(
	stage: Record<string, unknown>,
	type: ArtifactGraphStageType | undefined,
	path: string,
	issues: ValidationIssue[],
): void {
	if (type !== "dag") {
		if (type !== "loop" && stage.stages !== undefined) {
			issues.push({
				path: `${path}.stages`,
				message: "is only valid on dag or loop stages",
			});
		}
		if (stage.outputFrom !== undefined) {
			issues.push({
				path: `${path}.outputFrom`,
				message: "is only valid on dag stages",
			});
		}
		return;
	}
	for (const key of [
		"prompt",
		"agent",
		"role",
		"tools",
		"output",
		"each",
		"support",
		"inputPolicy",
		"sourceProjection",
		"maxItems",
	] as const) {
		if (stage[key] !== undefined) {
			issues.push({
				path: `${path}.${key}`,
				message: "is not valid on dag container stages",
			});
		}
	}
	if (!Array.isArray(stage.stages)) {
		issues.push({
			path: `${path}.stages`,
			message: "dag stages must declare child stages",
		});
		return;
	}
	validateStageArray(stage.stages, `${path}.stages`, issues);
	const childIds = collectStageIds(stage.stages, `${path}.stages`, []);
	if (stage.outputFrom !== undefined) {
		optionalString(stage.outputFrom, `${path}.outputFrom`, issues);
		const outputFrom =
			typeof stage.outputFrom === "string" ? stage.outputFrom : undefined;
		if (outputFrom && !childIds.has(outputFrom)) {
			issues.push({
				path: `${path}.outputFrom`,
				message: `references unknown child stage "${outputFrom}"`,
			});
		}
	} else {
		const sinks = findSinkStageIds(stage.stages);
		if (sinks.length !== 1) {
			issues.push({
				path: `${path}.outputFrom`,
				message: `dag stages without outputFrom must have exactly one sink child, found ${sinks.length}`,
			});
		}
	}
}

function validateDefaults(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	if (value === undefined) return;
	const defaults = recordAt(value, path, issues);
	if (!defaults) return;
	rejectUnknownKeys(defaults, DEFAULTS_KEYS, path, issues);
	optionalString(defaults.cwd, `${path}.cwd`, issues);
	optionalString(defaults.agent, `${path}.agent`, issues);
	optionalString(defaults.model, `${path}.model`, issues);
	optionalEnum(defaults.thinking, THINKING_LEVELS, `${path}.thinking`, issues);
	optionalEnum(defaults.fast, FAST_MODES, `${path}.fast`, issues);
	optionalEnum(
		defaults.approvalMode,
		APPROVAL_MODES,
		`${path}.approvalMode`,
		issues,
	);
	optionalEnum(
		defaults.worktreePolicy,
		WORKTREE_POLICIES,
		`${path}.worktreePolicy`,
		issues,
	);
	validateBackend(defaults.backend, `${path}.backend`, issues);
	optionalBoolean(defaults.readOnly, `${path}.readOnly`, issues);
	optionalPositiveInteger(
		defaults.maxConcurrency,
		`${path}.maxConcurrency`,
		issues,
	);
	optionalPositiveInteger(
		defaults.maxRuntimeMs,
		`${path}.maxRuntimeMs`,
		issues,
	);
	validateWorkflowToolArray(defaults.tools, `${path}.tools`, issues);
}

function validateRoles(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	if (value === undefined) return;
	const roles = recordAt(value, path, issues);
	if (!roles) return;
	for (const [name, role] of Object.entries(roles)) {
		if (name.trim() === "")
			issues.push({ path, message: "role names must be non-empty" });
		validateRoleSpec(role, `${path}.${jsonKey(name)}`, issues);
	}
}

function validateRoleSpec(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	const role = recordAt(value, path, issues);
	if (!role) return;
	rejectUnknownKeys(role, ROLES_KEYS, path, issues);
	optionalString(role.fromAgent, `${path}.fromAgent`, issues);
	optionalString(role.prompt, `${path}.prompt`, issues);
	validateStringArray(role.includeSections, `${path}.includeSections`, issues);
	validateStringArray(role.excludeSections, `${path}.excludeSections`, issues);
	optionalPositiveInteger(role.maxChars, `${path}.maxChars`, issues);
}

function validateRole(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	if (value === undefined) return;
	if (typeof value === "string") {
		if (value.trim() === "")
			issues.push({ path, message: "must be a non-empty string" });
		return;
	}
	validateStringArray(value, path, issues);
}

function validateWorkflowToolArray(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	if (value === undefined) return;
	if (!Array.isArray(value)) {
		issues.push({ path, message: "must be an array" });
		return;
	}
	const seen = new Set<string>();
	for (const [index, item] of value.entries()) {
		validateWorkflowToolEntry(item, `${path}[${index}]`, seen, issues);
	}
}

function validateWorkflowToolEntry(
	value: unknown,
	path: string,
	seen: Set<string>,
	issues: ValidationIssue[],
): void {
	const name = workflowToolName(value);
	if (name === undefined) {
		issues.push({
			path,
			message: "must be a tool name string or object with a name",
		});
		return;
	}
	validateToolName(
		name,
		typeof value === "string" ? path : `${path}.name`,
		issues,
	);
	if (seen.has(name))
		issues.push({ path, message: `duplicate value "${name}"` });
	seen.add(name);
	if (isRecord(value)) validateWorkflowToolObject(value, path, issues);
}

function validateWorkflowToolObject(
	value: Record<string, unknown>,
	path: string,
	issues: ValidationIssue[],
): void {
	rejectUnknownKeys(value, TOOL_OBJECT_KEYS, path, issues);
	validateStringArray(value.extensions, `${path}.extensions`, issues);
	validateToolNameArray(value.fallbackTools, `${path}.fallbackTools`, issues);
	optionalBoolean(value.optional, `${path}.optional`, issues);
	if (
		value.classification !== undefined &&
		!TOOL_CLASSIFICATIONS.includes(value.classification as never)
	) {
		issues.push({
			path: `${path}.classification`,
			message: "must be one of: read-only, write-capable, mutation-capable",
		});
	}
}

function workflowToolName(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (isRecord(value) && typeof value.name === "string") return value.name;
	return undefined;
}

function validateToolNameArray(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	if (value === undefined) return;
	if (!Array.isArray(value)) {
		issues.push({ path, message: "must be an array" });
		return;
	}
	const seen = new Set<string>();
	for (const [index, item] of value.entries()) {
		const itemPath = `${path}[${index}]`;
		if (typeof item !== "string") {
			issues.push({ path: itemPath, message: "must be a non-empty string" });
			continue;
		}
		validateToolName(item, itemPath, issues);
		if (seen.has(item))
			issues.push({ path: itemPath, message: `duplicate value "${item}"` });
		seen.add(item);
	}
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

function validateJsonPathArray(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	if (value === undefined) return;
	if (!Array.isArray(value)) {
		issues.push({ path, message: "must be an array" });
		return;
	}
	for (const [index, item] of value.entries()) {
		const itemPath = `${path}[${index}]`;
		if (typeof item !== "string" || !item.startsWith("$.")) {
			issues.push({
				path: itemPath,
				message: "must be a JSONPath starting with $.",
			});
		}
	}
}

function validateStringArray(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	if (value === undefined) return;
	if (!Array.isArray(value)) {
		issues.push({ path, message: "must be an array" });
		return;
	}
	const seen = new Set<string>();
	for (const [index, item] of value.entries()) {
		const itemPath = `${path}[${index}]`;
		if (typeof item !== "string" || item.trim() === "") {
			issues.push({ path: itemPath, message: "must be a non-empty string" });
			continue;
		}
		if (seen.has(item))
			issues.push({ path: itemPath, message: `duplicate value "${item}"` });
		seen.add(item);
	}
}

function rejectUnknownKeys(
	object: Record<string, unknown>,
	allowed: ReadonlySet<string>,
	path: string,
	issues: ValidationIssue[],
): void {
	for (const key of Object.keys(object)) {
		if (!allowed.has(key))
			issues.push({
				path: `${path}.${jsonKey(key)}`,
				message: "unknown field",
			});
	}
}

function recordAt(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): Record<string, unknown> | undefined {
	if (!isRecord(value)) {
		issues.push({ path, message: "must be an object" });
		return undefined;
	}
	return value;
}

function optionalRecord(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	if (value !== undefined && !isRecord(value))
		issues.push({ path, message: "must be an object" });
}

function requiredString(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): string | undefined {
	if (typeof value !== "string" || value.trim() === "") {
		issues.push({ path, message: "must be a non-empty string" });
		return undefined;
	}
	return value;
}

function optionalString(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	if (
		value !== undefined &&
		(typeof value !== "string" || value.trim() === "")
	) {
		issues.push({ path, message: "must be a non-empty string" });
	}
}

function optionalBoolean(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	if (value !== undefined && typeof value !== "boolean") {
		issues.push({ path, message: "must be a boolean" });
	}
}

function optionalEnum<T extends readonly string[]>(
	value: unknown,
	values: T,
	path: string,
	issues: ValidationIssue[],
): void {
	if (value === undefined) return;
	if (!values.includes(value as never)) {
		issues.push({ path, message: `must be one of: ${values.join(", ")}` });
	}
}

function validateBackend(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	if (value === undefined) return;
	const backend = recordAt(value, path, issues);
	if (!backend) return;
	rejectUnknownKeys(backend, new Set(["type", "mode"]), path, issues);
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

function optionalPositiveInteger(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	if (value === undefined) return;
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		issues.push({ path, message: "must be a positive integer" });
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonKey(key: string): string {
	return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}
