import { isAbsolute } from "node:path";

import { DYNAMIC_OUTPUT_PROFILES } from "./dynamic-profiles.js";
import { compactStrings } from "./strings.js";
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
	"defaults",
	"roles",
	"artifactGraph",
]);
const ARTIFACT_GRAPH_KEYS = new Set(["stages", "maxConcurrency"]);
const STAGE_TYPES = new Set<ArtifactGraphStageType>([
	"single",
	"reduce",
	"foreach",
	"loop",
	"dag",
	"dynamic",
]);
const STAGE_KEYS = new Set([
	"id",
	"type",
	"prompt",
	"injectRuntimeTask",
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
	"dynamic",
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
	"partial",
]);
const OUTPUT_PARTIAL_KEYS = new Set(["paths"]);
const REQUIRED_FLAG_KEYS = new Set(["required"]);
const REFS_OUTPUT_KEYS = new Set(["required", "minItems"]);
const INPUT_POLICY_KEYS = new Set([
	"requiredReads",
	"enforcement",
	"artifactAccess",
]);
const SOURCE_PROJECTION_KEYS = new Set(["include", "maxChars"]);
const SUPPORT_KEYS = new Set(["uses", "options"]);
const DYNAMIC_STAGE_FORBIDDEN_KEYS = new Set([
	"prompt",
	"injectRuntimeTask",
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
]);
const DYNAMIC_KEYS = new Set([
	"uses",
	"mode",
	"budget",
	"permissions",
	"helpers",
	"workflows",
	"decisionLoop",
]);
const DYNAMIC_BUDGET_KEYS = new Set([
	"maxAgents",
	"maxConcurrency",
	"maxRuntimeMs",
	"maxNestedWorkflowDepth",
	"maxGraphMutations",
	"maxHelperRuns",
]);
const DYNAMIC_PERMISSIONS_KEYS = new Set([
	"approval",
	"allowDynamicRoles",
	"allowDynamicTools",
]);
const DYNAMIC_HELPER_KEYS = new Set([
	"uses",
	"inputSchema",
	"outputSchema",
	"idempotent",
]);
const DYNAMIC_NESTED_WORKFLOW_KEYS = new Set(["uses"]);
const DYNAMIC_DECISION_LOOP_KEYS = new Set([
	"planner",
	"workerDefaults",
	"verifier",
	"synthesis",
	"allowedAgents",
	"allowedTools",
	"allowedOutputProfiles",
	"maxDecisionRounds",
	"maxActionsPerRound",
	"repair",
	"stateIndex",
	"stopPolicy",
]);
const DYNAMIC_DECISION_LOOP_PROFILE_KEYS = new Set([
	"agent",
	"model",
	"thinking",
	"tools",
	"outputProfile",
	"maxRuntimeMs",
]);
const DYNAMIC_DECISION_LOOP_REPAIR_KEYS = new Set(["maxAttempts"]);
const DYNAMIC_DECISION_LOOP_STATE_INDEX_KEYS = new Set([
	"maxFindings",
	// Deprecated/no-op compatibility field; accepted but not used by Phase 1.
	"requiredFindingIds",
]);
const DYNAMIC_DECISION_LOOP_STOP_POLICY_KEYS = new Set([
	"requireSynthesisAction",
	"failOnInvalidDecision",
	"maxStalls",
	"failOnDroppedRequiredBranch",
]);
const RESERVED_DYNAMIC_MAP_KEYS = new Set([
	"__proto__",
	"prototype",
	"constructor",
]);
const DYNAMIC_APPROVAL_VALUES = ["auto", "ask"] as const;
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
const FOREACH_FROM_KEYS = new Set(["source", "path", "streaming"]);
const FOREACH_STREAMING_KEYS = new Set(["enabled", "minChunk"]);
const NORMAL_ARTIFACT_KINDS = new Set<WorkflowArtifactKind>([
	"control",
	"analysis",
	"refs",
	"raw",
]);
const SOURCE_POLICY_VALUES = new Set(["success", "partial", "require-success"]);
const STAGE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

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
	const sourceIds = collectStageSourceIds(value);
	for (const [index, item] of value.entries()) {
		validateStage(item, `${path}[${index}]`, ids, sourceIds, issues);
	}
	validateStreamingProducerDeclarations(value, path, issues);
	validateStageDependencyGraph(value, path, issues);
}

function validateStreamingProducerDeclarations(
	stages: readonly unknown[],
	path: string,
	issues: ValidationIssue[],
): void {
	const byId = new Map<string, Record<string, unknown>>();
	for (const stage of stages) {
		if (isRecord(stage) && typeof stage.id === "string") {
			byId.set(stage.id, stage);
		}
	}
	for (const [index, stage] of stages.entries()) {
		if (!isRecord(stage) || !isRecord(stage.from)) continue;
		const from = stage.from;
		if (!isRecord(from.streaming) || from.streaming.enabled !== true) continue;
		const source = typeof from.source === "string" ? from.source : undefined;
		const controlPath = typeof from.path === "string" ? from.path : undefined;
		if (!source || !controlPath) continue;
		const sourceStage = byId.get(source);
		const partialPaths = outputPartialPaths(sourceStage);
		if (!partialPaths.includes(controlPath)) {
			issues.push({
				path: `${path}[${index}].from.streaming`,
				message: `source stage "${source}" must declare output.partial.paths including "${controlPath}" to use streaming`,
			});
		}
	}
}

function outputPartialPaths(
	stage: Record<string, unknown> | undefined,
): string[] {
	const output = isRecord(stage?.output) ? stage.output : undefined;
	const partial = isRecord(output?.partial) ? output.partial : undefined;
	return Array.isArray(partial?.paths)
		? compactStrings(partial.paths, {
				trim: false,
				unique: false,
				dropEmpty: false,
				dropWhitespaceOnly: false,
			})
		: [];
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
	const seen = new Set<string>();
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
				if (!seen.has(ref)) {
					issues.push({
						path: `${path}[${index}].${field}`,
						message: `stage "${stage.id}" must reference only earlier sibling stages; "${ref}" appears later`,
					});
				}
				outgoing.get(ref)?.push(stage.id);
			}
		}
		seen.add(stage.id);
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
		return compactStrings(value, {
			trim: false,
			unique: false,
			dropEmpty: false,
			dropWhitespaceOnly: false,
		});
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
		if (!STAGE_ID_PATTERN.test(id)) {
			issues.push({
				path: `${itemPath}.id`,
				message: "stage id must contain only letters, numbers, _ and -",
			});
		}
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

function collectStageSourceIds(stages: readonly unknown[]): Set<string> {
	const ids = new Set<string>();
	for (const stage of stages) {
		if (!isRecord(stage)) continue;
		const sourceId = stageSourceId(stage);
		if (sourceId) ids.add(sourceId);
	}
	return ids;
}

function stageSourceId(stage: Record<string, unknown>): string | undefined {
	const id =
		typeof stage.id === "string" && stage.id.trim() !== ""
			? stage.id
			: undefined;
	if (!id) return undefined;
	if (stage.type !== "dag" || !Array.isArray(stage.stages)) return id;
	const outputChildId =
		typeof stage.outputFrom === "string"
			? stage.outputFrom
			: singleSinkStageId(stage.stages);
	if (!outputChildId) return undefined;
	const outputChild = stage.stages.find(
		(child) => isRecord(child) && child.id === outputChildId,
	);
	if (!isRecord(outputChild)) return undefined;
	const childSourceId = stageSourceId(outputChild);
	return childSourceId ? `${id}.${childSourceId}` : undefined;
}

function singleSinkStageId(stages: readonly unknown[]): string | undefined {
	const sinks = findSinkStageIds(stages);
	return sinks.length === 1 ? sinks[0] : undefined;
}

function validateStage(
	value: unknown,
	path: string,
	siblingIds: ReadonlySet<string>,
	sourceIds: ReadonlySet<string>,
	issues: ValidationIssue[],
): void {
	const stage = recordAt(value, path, issues);
	if (!stage) return;
	rejectUnknownKeys(stage, STAGE_KEYS, path, issues);
	const type = validateStageType(stage, `${path}.type`, issues);
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
	optionalBoolean(stage.injectRuntimeTask, `${path}.injectRuntimeTask`, issues);
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
		sourceIds,
		issues,
		stage.sourceProjection,
	);
	validateOutput(stage.output, `${path}.output`, issues);
	validateSupportStage(stage, type, path, issues);
	validateDynamicStage(stage, type, path, issues);
	validateForeachStage(stage, type, path, issues);
	validateLoopStage(stage, type, path, siblingIds, sourceIds, issues);
	validateDagStage(stage, type, path, issues);
}

function validateStageType(
	stage: Record<string, unknown>,
	path: string,
	issues: ValidationIssue[],
): ArtifactGraphStageType | undefined {
	if (stage.type === undefined) {
		if (stage.support !== undefined) return undefined;
		issues.push({ path, message: "must be a non-empty string" });
		return undefined;
	}
	const type = requiredString(stage.type, path, issues);
	if (type === undefined) return undefined;
	if (!STAGE_TYPES.has(type as ArtifactGraphStageType)) {
		issues.push({
			path,
			message: "must be one of: single, reduce, foreach, loop, dag, dynamic",
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
	if (value.streaming !== undefined) {
		validateForeachStreaming(value.streaming, `${path}.streaming`, issues);
	}
}

function validateForeachStreaming(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	const streaming = recordAt(value, path, issues);
	if (!streaming) return;
	rejectUnknownKeys(streaming, FOREACH_STREAMING_KEYS, path, issues);
	if (streaming.enabled !== true) {
		issues.push({ path: `${path}.enabled`, message: "must be true" });
	}
	optionalPositiveInteger(streaming.minChunk, `${path}.minChunk`, issues);
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
	validateRefsOutputObject(output.refs, `${path}.refs`, issues);
	validatePartialOutput(output.partial, `${path}.partial`, issues);
}

function validatePartialOutput(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	if (value === undefined) return;
	const partial = recordAt(value, path, issues);
	if (!partial) return;
	rejectUnknownKeys(partial, OUTPUT_PARTIAL_KEYS, path, issues);
	if (!Array.isArray(partial.paths)) {
		issues.push({ path: `${path}.paths`, message: "must be an array" });
		return;
	}
	if (partial.paths.length === 0) {
		issues.push({ path: `${path}.paths`, message: "must not be empty" });
	}
	const seen = new Set<string>();
	for (const [index, item] of partial.paths.entries()) {
		const itemPath = `${path}.paths[${index}]`;
		if (typeof item !== "string" || item.trim() === "") {
			issues.push({ path: itemPath, message: "must be a non-empty string" });
			continue;
		}
		if (!item.startsWith("$.")) {
			issues.push({
				path: itemPath,
				message: "must be a control JSONPath starting with $.",
			});
		}
		if (seen.has(item))
			issues.push({ path: itemPath, message: `duplicate value "${item}"` });
		seen.add(item);
	}
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
	validateWorkflowBundleJsonRef(value, path, issues);
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

function validateRefsOutputObject(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	if (value === undefined) return;
	const object = recordAt(value, path, issues);
	if (!object) return;
	rejectUnknownKeys(object, REFS_OUTPUT_KEYS, path, issues);
	optionalBoolean(object.required, `${path}.required`, issues);
	optionalPositiveInteger(object.minItems, `${path}.minItems`, issues);
}

function validateInputPolicy(
	value: unknown,
	path: string,
	siblingIds: ReadonlySet<string>,
	issues: ValidationIssue[],
	sourceProjection: unknown,
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
	if (
		policy.artifactAccess !== undefined &&
		policy.artifactAccess !== "enabled" &&
		policy.artifactAccess !== "none"
	) {
		issues.push({
			path: `${path}.artifactAccess`,
			message: 'must be "enabled" or "none"',
		});
	}
	if (policy.artifactAccess === "none") {
		if (
			Array.isArray(policy.requiredReads) &&
			policy.requiredReads.length > 0
		) {
			issues.push({
				path: `${path}.requiredReads`,
				message: 'must be empty when artifactAccess is "none"',
			});
		}
		if (sourceProjection !== undefined) {
			issues.push({
				path: `${path}.artifactAccess`,
				message: 'cannot be "none" when sourceProjection is declared',
			});
		}
	}
}

function validateRequiredReads(
	value: unknown,
	path: string,
	sourceIds: ReadonlySet<string>,
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
		validateRequiredRead(item, itemPath, sourceIds, issues);
	}
}

function validateRequiredRead(
	value: string,
	path: string,
	sourceIds: ReadonlySet<string>,
	issues: ValidationIssue[],
): void {
	const dot = value.lastIndexOf(".");
	const source = dot > 0 ? value.slice(0, dot) : "";
	const artifact = dot > 0 ? value.slice(dot + 1) : "";
	if (source.trim() === "" || artifact.trim() === "") {
		issues.push({ path, message: "must use source.artifact form" });
		return;
	}
	if (!sourceIds.has(source)) {
		issues.push({
			path,
			message: `required read source "${source}" is not an available upstream artifact source`,
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

function validateSupportStage(
	stage: Record<string, unknown>,
	type: ArtifactGraphStageType | undefined,
	path: string,
	issues: ValidationIssue[],
): void {
	if (stage.support === undefined) return;
	if (type !== undefined) {
		issues.push({
			path: `${path}.type`,
			message: "must be omitted when support is declared",
		});
	}
	const support = recordAt(stage.support, `${path}.support`, issues);
	if (!support) return;
	rejectUnknownKeys(support, SUPPORT_KEYS, `${path}.support`, issues);
	const uses = requiredString(support.uses, `${path}.support.uses`, issues);
	if (uses !== undefined)
		validateSupportRef(uses, `${path}.support.uses`, issues);
	optionalRecord(support.options, `${path}.support.options`, issues);
}

function validateSupportRef(
	value: string,
	path: string,
	issues: ValidationIssue[],
): void {
	if (!value.startsWith("./") || !value.endsWith(".mjs")) {
		issues.push({ path, message: "must be a relative ./ helper .mjs path" });
	}
	validateWorkflowBundleRef(value, path, issues);
}

function validateWorkflowBundleRef(
	value: string,
	path: string,
	issues: ValidationIssue[],
): void {
	if (!value.startsWith("./")) {
		issues.push({ path, message: "must be a relative ./ bundle path" });
	}
	if (
		isAbsolute(value) ||
		value.startsWith(".//") ||
		value.includes("//") ||
		value.includes("\\") ||
		value.includes("://") ||
		/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) ||
		value.split("/").includes("..")
	) {
		issues.push({ path, message: "must stay inside the workflow bundle" });
	}
}

function validateWorkflowBundleJsonRef(
	value: string,
	path: string,
	issues: ValidationIssue[],
): void {
	validateWorkflowBundleRef(value, path, issues);
	if (!value.endsWith(".json")) {
		issues.push({ path, message: "must point to a bundle-local .json file" });
	}
}

function validateDynamicStage(
	stage: Record<string, unknown>,
	type: ArtifactGraphStageType | undefined,
	path: string,
	issues: ValidationIssue[],
): void {
	if (type !== "dynamic") {
		if (stage.dynamic !== undefined) {
			issues.push({
				path: `${path}.dynamic`,
				message: "is only valid on dynamic stages",
			});
		}
		return;
	}
	for (const key of DYNAMIC_STAGE_FORBIDDEN_KEYS) {
		if (stage[key] !== undefined) {
			issues.push({
				path: `${path}.${key}`,
				message:
					"is ignored by dynamic stages; configure dynamic.permissions or dynamic.budget instead",
			});
		}
	}
	const dynamic = recordAt(stage.dynamic, `${path}.dynamic`, issues);
	if (!dynamic) return;
	rejectUnknownKeys(dynamic, DYNAMIC_KEYS, `${path}.dynamic`, issues);
	const uses = requiredString(dynamic.uses, `${path}.dynamic.uses`, issues);
	if (uses !== undefined)
		validateSupportRef(uses, `${path}.dynamic.uses`, issues);
	if (dynamic.mode !== undefined && dynamic.mode !== "graph-splice") {
		issues.push({
			path: `${path}.dynamic.mode`,
			message: 'must be "graph-splice"',
		});
	}
	validateDynamicBudget(dynamic.budget, `${path}.dynamic.budget`, issues);
	validateDynamicPermissions(
		dynamic.permissions,
		`${path}.dynamic.permissions`,
		issues,
	);
	validateDynamicHelpers(dynamic.helpers, `${path}.dynamic.helpers`, issues);
	validateDynamicWorkflows(
		dynamic.workflows,
		`${path}.dynamic.workflows`,
		issues,
	);
	validateDynamicDecisionLoop(
		dynamic.decisionLoop,
		`${path}.dynamic.decisionLoop`,
		issues,
	);
}

function validateDynamicBudget(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	if (value === undefined) return;
	const budget = recordAt(value, path, issues);
	if (!budget) return;
	rejectUnknownKeys(budget, DYNAMIC_BUDGET_KEYS, path, issues);
	for (const key of DYNAMIC_BUDGET_KEYS) {
		optionalPositiveInteger(budget[key], `${path}.${key}`, issues);
	}
}

function validateDynamicPermissions(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	if (value === undefined) return;
	const permissions = recordAt(value, path, issues);
	if (!permissions) return;
	rejectUnknownKeys(permissions, DYNAMIC_PERMISSIONS_KEYS, path, issues);
	optionalEnum(
		permissions.approval,
		DYNAMIC_APPROVAL_VALUES,
		`${path}.approval`,
		issues,
	);
	optionalBoolean(
		permissions.allowDynamicRoles,
		`${path}.allowDynamicRoles`,
		issues,
	);
	optionalBoolean(
		permissions.allowDynamicTools,
		`${path}.allowDynamicTools`,
		issues,
	);
}

function validateDynamicHelpers(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	if (value === undefined) return;
	const helpers = recordAt(value, path, issues);
	if (!helpers) return;
	for (const [key, helperValue] of Object.entries(helpers)) {
		if (!STAGE_ID_PATTERN.test(key)) {
			issues.push({
				path: `${path}.${jsonKey(key)}`,
				message: "helper id must contain only letters, numbers, _ and -",
			});
		}
		if (RESERVED_DYNAMIC_MAP_KEYS.has(key)) {
			issues.push({
				path: `${path}.${jsonKey(key)}`,
				message: "helper id is reserved",
			});
		}
		const helperPath = `${path}.${jsonKey(key)}`;
		const helper = recordAt(helperValue, helperPath, issues);
		if (!helper) continue;
		rejectUnknownKeys(helper, DYNAMIC_HELPER_KEYS, helperPath, issues);
		const uses = requiredString(helper.uses, `${helperPath}.uses`, issues);
		if (uses !== undefined)
			validateSupportRef(uses, `${helperPath}.uses`, issues);
		if (helper.inputSchema !== undefined) {
			const inputSchema = requiredString(
				helper.inputSchema,
				`${helperPath}.inputSchema`,
				issues,
			);
			if (inputSchema)
				validateWorkflowBundleJsonRef(
					inputSchema,
					`${helperPath}.inputSchema`,
					issues,
				);
		}
		if (helper.outputSchema !== undefined) {
			const outputSchema = requiredString(
				helper.outputSchema,
				`${helperPath}.outputSchema`,
				issues,
			);
			if (outputSchema)
				validateWorkflowBundleJsonRef(
					outputSchema,
					`${helperPath}.outputSchema`,
					issues,
				);
		}
		if (
			helper.idempotent !== undefined &&
			typeof helper.idempotent !== "boolean"
		) {
			issues.push({
				path: `${helperPath}.idempotent`,
				message: "idempotent must be a boolean",
			});
		}
	}
}

function validateDynamicWorkflows(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	if (value === undefined) return;
	const workflows = recordAt(value, path, issues);
	if (!workflows) return;
	for (const [key, workflowValue] of Object.entries(workflows)) {
		if (!STAGE_ID_PATTERN.test(key)) {
			issues.push({
				path: `${path}.${jsonKey(key)}`,
				message: "workflow id must contain only letters, numbers, _ and -",
			});
		}
		if (RESERVED_DYNAMIC_MAP_KEYS.has(key)) {
			issues.push({
				path: `${path}.${jsonKey(key)}`,
				message: "workflow id is reserved",
			});
		}
		const workflowPath = `${path}.${jsonKey(key)}`;
		const workflow = recordAt(workflowValue, workflowPath, issues);
		if (!workflow) continue;
		rejectUnknownKeys(
			workflow,
			DYNAMIC_NESTED_WORKFLOW_KEYS,
			workflowPath,
			issues,
		);
		const uses = requiredString(workflow.uses, `${workflowPath}.uses`, issues);
		if (uses !== undefined) {
			validateWorkflowBundleRef(uses, `${workflowPath}.uses`, issues);
			if (!uses.endsWith(".json")) {
				issues.push({
					path: `${workflowPath}.uses`,
					message: "must reference a workflow .json spec",
				});
			}
		}
	}
}

function validateDynamicDecisionLoop(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	if (value === undefined) return;
	const loop = recordAt(value, path, issues);
	if (!loop) return;
	rejectUnknownKeys(loop, DYNAMIC_DECISION_LOOP_KEYS, path, issues);
	for (const key of ["planner", "workerDefaults", "verifier", "synthesis"]) {
		validateDynamicDecisionLoopProfile(loop[key], `${path}.${key}`, issues);
	}
	validateStringArray(loop.allowedAgents, `${path}.allowedAgents`, issues);
	validateWorkflowToolArray(loop.allowedTools, `${path}.allowedTools`, issues);
	validateDynamicOutputProfileArray(
		loop.allowedOutputProfiles,
		`${path}.allowedOutputProfiles`,
		issues,
	);
	optionalPositiveInteger(
		loop.maxDecisionRounds,
		`${path}.maxDecisionRounds`,
		issues,
	);
	optionalPositiveInteger(
		loop.maxActionsPerRound,
		`${path}.maxActionsPerRound`,
		issues,
	);
	validateDynamicDecisionLoopRepair(loop.repair, `${path}.repair`, issues);
	validateDynamicDecisionLoopStateIndex(
		loop.stateIndex,
		`${path}.stateIndex`,
		issues,
	);
	validateDynamicDecisionLoopStopPolicy(
		loop.stopPolicy,
		`${path}.stopPolicy`,
		issues,
	);
}

function validateDynamicDecisionLoopProfile(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	if (value === undefined) return;
	const profile = recordAt(value, path, issues);
	if (!profile) return;
	rejectUnknownKeys(profile, DYNAMIC_DECISION_LOOP_PROFILE_KEYS, path, issues);
	optionalString(profile.agent, `${path}.agent`, issues);
	optionalString(profile.model, `${path}.model`, issues);
	optionalEnum(profile.thinking, THINKING_LEVELS, `${path}.thinking`, issues);
	validateWorkflowToolArray(profile.tools, `${path}.tools`, issues);
	optionalEnum(
		profile.outputProfile,
		DYNAMIC_OUTPUT_PROFILES,
		`${path}.outputProfile`,
		issues,
	);
	optionalPositiveInteger(profile.maxRuntimeMs, `${path}.maxRuntimeMs`, issues);
}

function validateDynamicOutputProfileArray(
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
		optionalEnum(item, DYNAMIC_OUTPUT_PROFILES, itemPath, issues);
		if (typeof item !== "string") continue;
		if (seen.has(item)) {
			issues.push({ path: itemPath, message: `duplicate value "${item}"` });
		}
		seen.add(item);
	}
}

function validateDynamicDecisionLoopRepair(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	if (value === undefined) return;
	const repair = recordAt(value, path, issues);
	if (!repair) return;
	rejectUnknownKeys(repair, DYNAMIC_DECISION_LOOP_REPAIR_KEYS, path, issues);
	optionalPositiveInteger(repair.maxAttempts, `${path}.maxAttempts`, issues);
}

function validateDynamicDecisionLoopStateIndex(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	if (value === undefined) return;
	const stateIndex = recordAt(value, path, issues);
	if (!stateIndex) return;
	rejectUnknownKeys(
		stateIndex,
		DYNAMIC_DECISION_LOOP_STATE_INDEX_KEYS,
		path,
		issues,
	);
	optionalPositiveInteger(
		stateIndex.maxFindings,
		`${path}.maxFindings`,
		issues,
	);
	validateStringArray(
		stateIndex.requiredFindingIds,
		`${path}.requiredFindingIds`,
		issues,
	);
}

function validateDynamicDecisionLoopStopPolicy(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	if (value === undefined) return;
	const stopPolicy = recordAt(value, path, issues);
	if (!stopPolicy) return;
	rejectUnknownKeys(
		stopPolicy,
		DYNAMIC_DECISION_LOOP_STOP_POLICY_KEYS,
		path,
		issues,
	);
	optionalBoolean(
		stopPolicy.requireSynthesisAction,
		`${path}.requireSynthesisAction`,
		issues,
	);
	optionalBoolean(
		stopPolicy.failOnInvalidDecision,
		`${path}.failOnInvalidDecision`,
		issues,
	);
	optionalPositiveInteger(stopPolicy.maxStalls, `${path}.maxStalls`, issues);
	optionalBoolean(
		stopPolicy.failOnDroppedRequiredBranch,
		`${path}.failOnDroppedRequiredBranch`,
		issues,
	);
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
	sourceIds: ReadonlySet<string>,
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
	if (stage.maxRounds === undefined) {
		issues.push({
			path: `${path}.maxRounds`,
			message: "loop stages must declare maxRounds",
		});
	} else {
		optionalPositiveInteger(stage.maxRounds, `${path}.maxRounds`, issues);
	}
	validateOptionalJsonPath(stage.progressPath, `${path}.progressPath`, issues);
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
		validateStage(
			stage.onExhausted,
			`${path}.onExhausted`,
			siblingIds,
			sourceIds,
			issues,
		);
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
	validateOptionalJsonPath(until.path, `${path}.path`, issues);
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
		if (["loop", "foreach", "dag", "dynamic"].includes(String(child.type))) {
			issues.push({
				path: `${childPath}.type`,
				message: "loop child stages must be single or reduce stages",
			});
		}
		if (child.support !== undefined) {
			issues.push({
				path: `${childPath}.support`,
				message: "loop child stages must be single or reduce stages",
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
	for (const [index, child] of stage.stages.entries()) {
		if (isRecord(child) && child.type === "loop") {
			issues.push({
				path: `${path}.stages[${index}].type`,
				message: "loop stages are only supported at the top level in v1",
			});
		}
	}
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

function validateOptionalJsonPath(
	value: unknown,
	path: string,
	issues: ValidationIssue[],
): void {
	if (value === undefined) return;
	if (typeof value !== "string" || value.trim() === "") {
		issues.push({ path, message: "must be a non-empty string" });
		return;
	}
	if (!value.startsWith("$.")) {
		issues.push({ path, message: "must be a JSONPath starting with $." });
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
	if (backend.mode !== undefined && backend.mode !== "headless") {
		issues.push({
			path: `${path}.mode`,
			message: 'must be "headless"',
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
