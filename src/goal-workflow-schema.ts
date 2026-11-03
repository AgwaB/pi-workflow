import { validateDynamicWorkflows, validateGoalWorkflowMetadata } from "./artifact-graph-schema.js";
import { cloneGoalWorkflowData } from "./goal-json.js";
import { GOAL_COMMAND_VERIFIER_PRODUCER, goalCommandVerifierConfigIssues } from "./goal-command-verifier.js";
import { isSimpleJsonPath } from "./workflow-runtime.js";
import {
	type GoalWorkflowSpec,
	type ValidationIssue,
	WorkflowValidationError,
	type WorkflowArtifactKind,
} from "./types.js";

const TOP_LEVEL_KEYS = new Set([
	"schemaVersion",
	"name",
	"description",
	"input",
	"defaults",
	"roles",
	"executionProfiles",
	"defaultExecutionProfile",
	"goal",
]);
const GOAL_KEYS = new Set([
	"objective",
	"criteria",
	"authority",
	"nesting",
	"limits",
	"workflows",
]);
const CRITERION_KEYS = new Set(["id", "verifier"]);
const VERIFIER_KEYS = new Set([
	"kind",
	"producerId",
	"target",
	"subject",
	"config",
]);
const SUBJECT_KEYS = new Set(["resultSlot", "artifact", "path"]);
const AUTHORITY_KEYS = new Set([
	"allowedPaths",
	"protectedPaths",
	"allowedEffects",
]);
const NESTING_KEYS = new Set(["maxDepth"]);
const LIMITS_KEYS = new Set(["requests", "costMicros", "generations"]);
/** Generations (first plan plus replans) a Goal may use when `limits.generations` is unset. */
export const GOAL_DEFAULT_GENERATION_LIMIT = 10;
export const GOAL_MAX_GENERATION_LIMIT = 100;

/** Effective generation limit of a Goal definition. */
export function goalGenerationLimit(definition: GoalWorkflowSpec): number {
	return definition.goal.limits?.generations ?? GOAL_DEFAULT_GENERATION_LIMIT;
}
const DETERMINISTIC_CONFIG_KEYS = new Set(["comparison", "expected"]);

const FORBIDDEN_CONFIG_FIELDS = new Set([
	"agent",
	"backend",
	"capability",
	"command",
	"function",
	"handler",
	"prompt",
	"provider",
	"sdk",
	"script",
	"ticket",
	"tools",
]);
const ARTIFACT_KINDS = new Set<WorkflowArtifactKind>([
	"control",
	"analysis",
	"refs",
	"raw",
]);
const EFFECTS = new Set([
	"read",
	"candidate-write",
	"verify",
	"origin-apply",
	"workflow-create",
]);
const ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

/** True only for the authored root Goal workflow shape. */
export function isGoalWorkflowSpecShape(value: unknown): value is GoalWorkflowSpec {
	return (
		isRecord(value) &&
		value.schemaVersion === 1 &&
		isRecord(value.goal) &&
		!Object.hasOwn(value, "artifactGraph")
	);
}

/**
 * Parses the public, JSON-only Goal workflow definition. It does not resolve
 * verifier registrations or grant any authority; those host bindings happen
 * after parsing.
 */
export function parseGoalWorkflowSpec(value: unknown): GoalWorkflowSpec {
	const issues: ValidationIssue[] = [];
	let data: unknown;
	try {
		// Validates descriptors, symbols, sparse arrays, proxies, cycles, and
		// finite JSON numbers without evaluating authored accessors.
		data = cloneGoalWorkflowData(value);
	} catch {
		throw new WorkflowValidationError([
			{ path: "$", message: "must contain only JSON values" },
		]);
	}
	if (!isRecord(data)) {
		throw new WorkflowValidationError([
			{ path: "$", message: "must be an object" },
		]);
	}
	const spec = data;
	if (spec.schemaVersion !== 1) {
		issues.push({ path: "$.schemaVersion", message: "must be exactly 1" });
	}
	rejectUnknownKeys(spec, TOP_LEVEL_KEYS, "$", issues);
	if (Object.hasOwn(spec, "artifactGraph")) {
		issues.push({
			path: "$.artifactGraph",
			message: "cannot be combined with a root goal definition",
		});
	}
	optionalString(spec.name, "$.name", issues);
	optionalString(spec.description, "$.description", issues);
	validateGoalWorkflowMetadata(spec, issues);
	if (isRecord(spec.defaults) && Object.hasOwn(spec.defaults, "backend")) {
		issues.push({
			path: "$.defaults.backend",
			message: "is not allowed in a public Goal workflow definition",
		});
	}
	// A Goal profile carries only model/thinking per role, so Fast would show
	// at consent but never reach a request. (Authored model/thinking defaults
	// are documented as replaced by the captured role settings.)
	if (isRecord(spec.defaults) && Object.hasOwn(spec.defaults, "fast"))
		issues.push({ path: "$.defaults.fast", message: "is not supported for Goal runs yet" });
	if (isRecord(spec.executionProfiles))
		for (const [name, profile] of Object.entries(spec.executionProfiles))
			if (isRecord(profile))
				for (const [slot, override] of Object.entries(profile))
					if (isRecord(override) && Object.hasOwn(override, "fast"))
						issues.push({
							path: `$.executionProfiles.${name}.${slot}.fast`,
							message: "is not supported for Goal runs yet",
						});
	validateGoal(spec.goal, "$.goal", issues);
	assertValidatedGoalWorkflowSpec(data, issues);
	const parsed = data;
	if (parsed.goal.nesting === undefined) parsed.goal.nesting = { maxDepth: 3 };
	return parsed;
}

/**
 * `validateGoalWorkflowMetadata` and `validateGoal` validate every public
 * member before this assertion narrows the JSON record to the closed authored
 * union. Keeping the assertion at this boundary prevents callers from
 * receiving an unchecked structural cast.
 */
function assertValidatedGoalWorkflowSpec(
	value: unknown,
	issues: ValidationIssue[],
): asserts value is GoalWorkflowSpec {
	if (issues.length > 0) throw new WorkflowValidationError(issues);
	if (!isGoalWorkflowSpecShape(value)) {
		throw new WorkflowValidationError([
			{ path: "$", message: "must be a root Goal workflow definition" },
		]);
	}
}

function validateGoal(value: unknown, path: string, issues: ValidationIssue[]): void {
	const goal = recordAt(value, path, issues);
	if (!goal) return;
	rejectUnknownKeys(goal, GOAL_KEYS, path, issues);
	requiredString(goal.objective, `${path}.objective`, issues);
	validateCriteria(goal.criteria, `${path}.criteria`, issues);
	validateAuthority(goal.authority, `${path}.authority`, issues);
	validateNesting(goal.nesting, `${path}.nesting`, issues);
	validateLimits(goal.limits, `${path}.limits`, issues);
	validateDynamicWorkflows(goal.workflows, `${path}.workflows`, issues);
}

function validateCriteria(value: unknown, path: string, issues: ValidationIssue[]): void {
	if (!Array.isArray(value) || value.length === 0) {
		issues.push({ path, message: "must be a non-empty array" });
		return;
	}
	const ids = new Set<string>();
	const criterionExecutionIds = new Map<string, string>();
	const slotExecutionIds = new Map<string, string>();
	for (const [index, entry] of value.entries()) {
		const criterionPath = `${path}[${index}]`;
		const criterion = recordAt(entry, criterionPath, issues);
		if (!criterion) continue;
		rejectUnknownKeys(criterion, CRITERION_KEYS, criterionPath, issues);
		const id = requiredId(criterion.id, `${criterionPath}.id`, issues);
		if (id !== undefined) {
			if (ids.has(id)) issues.push({ path: `${criterionPath}.id`, message: "must be unique" });
			ids.add(id);
			validateExecutionId(id, `${criterionPath}.id`, GOAL_CRITERION_ID_MAX, criterionExecutionIds, issues);
		}
		validateVerifier(criterion.verifier, `${criterionPath}.verifier`, issues);
		const slot = (criterion.verifier as { subject?: { resultSlot?: unknown } } | undefined)?.subject?.resultSlot;
		if (typeof slot === "string" && ID_PATTERN.test(slot)) {
			const path = `${criterionPath}.verifier.subject.resultSlot`;
			if (reservedGoalSlot(goalExecutionId(slot)))
				issues.push({ path, message: `"${slot}" is reserved for Goal planner/verifier identities` });
			else validateExecutionId(slot, path, GOAL_SLOT_ID_MAX, slotExecutionIds, issues);
		}
	}
}

/**
 * Goal slots and criteria become generated task identities
 * (`generation<N>.<slot>`, `generation<N>.verify.<criterion>`), which are
 * lowercased, have other punctuation replaced by "-" and are cut at 64
 * characters. Distinct authored IDs must stay distinct after that, so a valid
 * definition cannot fail only after requests were spent.
 * Mirrors sanitizeTaskId in engine-run-graph.ts.
 */
export function goalExecutionId(id: string): string {
	return id.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}
/** Room for "generation9999.verify." and "generation9999." prefixes. */
const GOAL_CRITERION_ID_MAX = 64 - "generation9999.verify.".length;
const GOAL_SLOT_ID_MAX = 64 - "generation9999.".length;
/** Slot identities that would equal a planner, verifier or controller request. */
function reservedGoalSlot(execution: string): boolean {
	return execution === "controller" || execution === "planner" || execution.startsWith("verify.") ||
		/^generation\d+(?:\.|$)/.test(execution);
}

function validateExecutionId(id: string, path: string, max: number, seen: Map<string, string>,
	issues: ValidationIssue[]): void {
	const execution = goalExecutionId(id);
	if (!execution) issues.push({ path, message: "must contain a letter or number" });
	else if (id.length > max) issues.push({ path, message: `must be at most ${max} characters` });
	else if (seen.has(execution) && seen.get(execution) !== id)
		issues.push({ path, message: `collides with "${seen.get(execution)}" once lowercased and normalized` });
	seen.set(execution, id);
}

function validateVerifier(value: unknown, path: string, issues: ValidationIssue[]): void {
	const verifier = recordAt(value, path, issues);
	if (!verifier) return;
	rejectUnknownKeys(verifier, VERIFIER_KEYS, path, issues);
	const kind = verifier.kind;
	if (kind !== "deterministic" && kind !== "model-rubric" && kind !== "human") {
		issues.push({ path: `${path}.kind`, message: "must be deterministic, model-rubric, or human" });
	}
	requiredId(verifier.producerId, `${path}.producerId`, issues);
	if (!["artifact", "candidate", "origin"].includes(String(verifier.target))) {
		issues.push({ path: `${path}.target`, message: "must be artifact, candidate, or origin" });
	}
	const subject = recordAt(verifier.subject, `${path}.subject`, issues);
	if (subject) {
		rejectUnknownKeys(subject, SUBJECT_KEYS, `${path}.subject`, issues);
		requiredId(subject.resultSlot, `${path}.subject.resultSlot`, issues);
		if (!ARTIFACT_KINDS.has(subject.artifact as WorkflowArtifactKind)) {
			issues.push({ path: `${path}.subject.artifact`, message: "must name a workflow artifact kind" });
		}
		if (subject.path !== undefined && (
			typeof subject.path !== "string" || !isSimpleJsonPath(subject.path) || /\[(?:\*|\d*:\d*)\]/u.test(subject.path) ||
			!["control", "refs"].includes(String(subject.artifact))
		)) issues.push({ path: `${path}.subject.path`, message: "must select one exact JSON value from control or refs" });
	}
	if (!Object.hasOwn(verifier, "config")) {
		issues.push({ path: `${path}.config`, message: "is required" });
		return;
	}
	if (kind === "deterministic" && verifier.producerId === GOAL_COMMAND_VERIFIER_PRODUCER) {
		// The command is user-authored, shown at consent and run by the host in a
		// sandboxed copy of the candidate; its exit code is the verdict.
		if (verifier.target !== "candidate" || subject?.artifact !== "control" || subject?.path !== undefined)
			issues.push({ path, message: `${GOAL_COMMAND_VERIFIER_PRODUCER} requires target candidate and subject artifact control without path` });
		for (const message of goalCommandVerifierConfigIssues(verifier.config))
			issues.push({ path: `${path}.config`, message });
	} else if (kind === "deterministic") {
		validateDeterministicConfig(
			verifier.config,
			String(verifier.producerId),
			`${path}.config`,
			issues,
		);
	} else if (kind === "model-rubric") {
		validateSemanticConfig(verifier.config, "rubric", `${path}.config`, issues);
		if (verifier.producerId === "json-control-rubric-v1") {
			if (verifier.target !== "artifact" || subject?.artifact !== "control")
				issues.push({ path, message: "json-control-rubric-v1 requires artifact/control" });
			const config = recordAt(verifier.config, `${path}.config`, issues);
			if (config) {
				rejectUnknownKeys(config, new Set(["rubric", "minScore"]), `${path}.config`, issues);
				if (typeof config.minScore !== "number" || !Number.isFinite(config.minScore) || config.minScore < 0 || config.minScore > 1)
					issues.push({ path: `${path}.config.minScore`, message: "must be a finite score between 0 and 1" });
			}
		}
	} else if (kind === "human") {
		validateSemanticConfig(verifier.config, "condition", `${path}.config`, issues);
		if (verifier.producerId === "human-acceptance-v1") {
			if (verifier.target !== "artifact" || subject?.artifact !== "control")
				issues.push({ path, message: "human-acceptance-v1 requires artifact/control" });
			const config = recordAt(verifier.config, `${path}.config`, issues);
			if (config) {
				rejectUnknownKeys(config, new Set(["condition"]), `${path}.config`, issues);
				const condition = recordAt(config.condition, `${path}.config.condition`, issues);
				if (condition) {
					rejectUnknownKeys(condition, new Set(["statement"]), `${path}.config.condition`, issues);
					if (typeof condition.statement !== "string" || !condition.statement.trim())
						issues.push({ path: `${path}.config.condition.statement`, message: "must be a non-empty string" });
				}
			}
		}
	}
}

function validateDeterministicConfig(
	value: unknown,
	producerId: string,
	path: string,
	issues: ValidationIssue[],
): void {
	const config = recordAt(value, path, issues);
	if (!config) return;
	if (Object.keys(config).length === 0) {
		issues.push({ path, message: "must be a non-empty host registration config" });
		return;
	}
	if (producerId !== "json-exact-value-v1") {
		validateNoExecutableConfigFields(config, path, issues);
		if (
			Object.hasOwn(config, "comparison") ||
			Object.hasOwn(config, "expected")
		) {
			issues.push({
				path,
				message:
					"exact-value comparison is reserved for producerId json-exact-value-v1",
			});
		}
		return;
	}
	rejectUnknownKeys(config, DETERMINISTIC_CONFIG_KEYS, path, issues);
	if (config.comparison !== "canonical-json-equality") {
		issues.push({ path: `${path}.comparison`, message: "must be canonical-json-equality" });
	}
	if (!Object.hasOwn(config, "expected")) {
		issues.push({ path: `${path}.expected`, message: "is required" });
	}
}

function validateSemanticConfig(
	value: unknown,
	field: "rubric" | "condition",
	path: string,
	issues: ValidationIssue[],
): void {
	const config = recordAt(value, path, issues);
	if (!config) return;
	if (Object.keys(config).length === 0) {
		issues.push({ path, message: "must be a non-empty semantic contract object" });
		return;
	}
	validateNoExecutableConfigFields(config, path, issues);
	if (!Object.hasOwn(config, field)) {
		issues.push({ path: `${path}.${field}`, message: "is required" });
		return;
	}
	const semantic = recordAt(config[field], `${path}.${field}`, issues);
	if (semantic && Object.keys(semantic).length === 0) {
		issues.push({ path: `${path}.${field}`, message: "must be a non-empty object" });
	}
}

function validateNoExecutableConfigFields(
	value: Record<string, unknown>,
	path: string,
	issues: ValidationIssue[],
): void {
	for (const [key, child] of Object.entries(value)) {
		const childPath = `${path}.${key}`;
		if (FORBIDDEN_CONFIG_FIELDS.has(key)) {
			issues.push({ path: childPath, message: "is not allowed in verifier config" });
		}
		if (isRecord(child)) validateNoExecutableConfigFields(child, childPath, issues);
		if (Array.isArray(child)) {
			for (const [index, item] of child.entries()) {
				if (isRecord(item))
					validateNoExecutableConfigFields(item, `${childPath}[${index}]`, issues);
			}
		}
	}
}

function validateAuthority(value: unknown, path: string, issues: ValidationIssue[]): void {
	const authority = recordAt(value, path, issues);
	if (!authority) return;
	rejectUnknownKeys(authority, AUTHORITY_KEYS, path, issues);
	for (const key of ["allowedPaths", "protectedPaths"] as const) {
		if (
			!Array.isArray(authority[key]) ||
			authority[key].some((item) => !isSafeRelativePath(item))
		) {
			issues.push({
				path: `${path}.${key}`,
				message: "must be an array of safe relative, non-glob paths",
			});
		}
	}
	if (!Array.isArray(authority.allowedEffects) || authority.allowedEffects.some((effect) => !EFFECTS.has(String(effect)))) {
		issues.push({ path: `${path}.allowedEffects`, message: "must contain only declared Goal effects" });
	}
}

function validateNesting(value: unknown, path: string, issues: ValidationIssue[]): void {
	if (value === undefined) return;
	const nesting = recordAt(value, path, issues);
	if (!nesting) return;
	rejectUnknownKeys(nesting, NESTING_KEYS, path, issues);
	if (!Number.isSafeInteger(nesting.maxDepth) || (nesting.maxDepth as number) < 1) {
		issues.push({ path: `${path}.maxDepth`, message: "must be a finite positive integer" });
	}
}

function validateLimits(value: unknown, path: string, issues: ValidationIssue[]): void {
	if (value === undefined) return;
	const limits = recordAt(value, path, issues);
	if (!limits) return;
	rejectUnknownKeys(limits, LIMITS_KEYS, path, issues);
	for (const key of ["requests", "costMicros"] as const) {
		if (limits[key] !== undefined && limits[key] !== null && (!Number.isSafeInteger(limits[key]) || (limits[key] as number) < 0)) {
			issues.push({ path: `${path}.${key}`, message: "must be null or a finite non-negative integer" });
		}
	}
	if (limits.generations !== undefined && (!Number.isSafeInteger(limits.generations) ||
		(limits.generations as number) < 1 || (limits.generations as number) > GOAL_MAX_GENERATION_LIMIT))
		issues.push({ path: `${path}.generations`, message: `must be an integer from 1 to ${GOAL_MAX_GENERATION_LIMIT}` });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeRelativePath(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!value.startsWith("/") &&
		!value.startsWith("\\") &&
		!/^[A-Za-z]:/.test(value) &&
		!/[\\\u0000-\u001f\u007f*?[\]{}]/.test(value) &&
		!value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
	);
}

function recordAt(value: unknown, path: string, issues: ValidationIssue[]): Record<string, unknown> | undefined {
	if (!isRecord(value)) {
		issues.push({ path, message: "must be an object" });
		return undefined;
	}
	return value;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, path: string, issues: ValidationIssue[]): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) issues.push({ path: `${path}.${key}`, message: "is not allowed" });
	}
}

function requiredString(value: unknown, path: string, issues: ValidationIssue[]): string | undefined {
	if (typeof value !== "string" || value.length === 0) {
		issues.push({ path, message: "must be a non-empty string" });
		return undefined;
	}
	return value;
}

function requiredId(value: unknown, path: string, issues: ValidationIssue[]): string | undefined {
	const id = requiredString(value, path, issues);
	if (id !== undefined && !ID_PATTERN.test(id)) {
		issues.push({ path, message: "must use only letters, numbers, ., _, :, or -" });
	}
	return id;
}

function optionalString(value: unknown, path: string, issues: ValidationIssue[]): void {
	if (value !== undefined && typeof value !== "string") issues.push({ path, message: "must be a string" });
}
