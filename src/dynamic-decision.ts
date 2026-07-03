import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { dynamicRunDir } from "./dynamic-events.js";
import { DYNAMIC_OUTPUT_PROFILES } from "./dynamic-profiles.js";
import { ensureDir, writeJsonAtomic } from "./store.js";
import {
	effectiveToolClassification,
	validateToolAuthority,
} from "./tool-metadata.js";
import type { CompiledToolProvider } from "./types.js";

export const DYNAMIC_DECISION_SCHEMA = "dynamic-decision-v1" as const;
export const DYNAMIC_DECISION_VALIDATOR_VERSION =
	"dynamic-decision-validator-v1";
const DYNAMIC_LOOP_SIGNATURE_SCHEMA = "dynamic-loop-signature-v1" as const;

export type DynamicDecisionPhase = "orientation" | "round" | "final";
export type DynamicDecisionStatus =
	| "continue"
	| "synthesize"
	| "stop"
	| "blocked";
export type DynamicDecisionActionType =
	| "add_work_item"
	| "verify"
	| "synthesize"
	| "stop";

/**
 * @deprecated Planner criteria prose is no longer part of validated
 * dynamic-decision-v1 control JSON; put it in <analysis> instead.
 */
export interface DynamicDecisionCriterion {
	id: string;
	description: string;
}

export interface DynamicDecisionArtifactRef {
	kind: "workflow-artifact-ref";
	taskId: string;
	artifact?: string;
	digest?: string;
}

export interface DynamicDecisionAddWorkItemAction {
	type: "add_work_item";
	actionId: string;
	workItemId: string;
	agent?: string;
	prompt: string;
	tools?: string[];
	outputProfile?: string;
	dependsOn?: string[];
	inputRefs?: DynamicDecisionArtifactRef[];
}

export interface DynamicDecisionVerifyAction {
	type: "verify";
	actionId: string;
	targetFindingId: string;
	prompt: string;
	tools?: string[];
	outputProfile?: string;
	inputRefs?: DynamicDecisionArtifactRef[];
}

export interface DynamicDecisionSynthesizeAction {
	type: "synthesize";
	actionId: string;
	prompt?: string;
	outputProfile?: string;
	inputRefs?: DynamicDecisionArtifactRef[];
}

export interface DynamicDecisionStopAction {
	type: "stop";
	actionId: string;
	reason: string;
	caveats?: string[];
}

export type DynamicDecisionAction =
	| DynamicDecisionAddWorkItemAction
	| DynamicDecisionVerifyAction
	| DynamicDecisionSynthesizeAction
	| DynamicDecisionStopAction;

export interface NormalizedDynamicDecision {
	schema: typeof DYNAMIC_DECISION_SCHEMA;
	decisionId: string;
	round: number;
	phase: DynamicDecisionPhase;
	status: DynamicDecisionStatus;
	nextActions: DynamicDecisionAction[];
}

export interface DynamicDecisionValidationContext {
	expectedRound?: number;
	maxActions?: number;
	maxDecisionRounds?: number;
	allowedTools?: readonly string[];
	toolProviders?: Record<string, CompiledToolProvider>;
	allowUnknownTools?: boolean;
	allowedAgents?: readonly string[];
	requireAgent?: boolean;
	allowedOutputProfiles?: readonly string[];
	knownCriteriaIds?: readonly string[];
	knownArtifactTaskIds?: readonly string[];
	knownFindingIds?: readonly string[];
	knownGeneratedTaskIds?: readonly string[];
}

export interface DynamicDecisionValidationResult {
	ok: boolean;
	errors: string[];
	decision?: NormalizedDynamicDecision;
	hash?: string;
}

export interface DynamicDecisionArtifactWriteInput {
	cwd: string;
	runId: string;
	controllerSpecId: string;
	rawDecision: unknown;
	validation: DynamicDecisionValidationResult;
	stateIndexDigest?: string;
}

export interface DynamicDecisionArtifactWriteResult {
	directory: string;
	rawPath: string;
	validationPath: string;
	acceptedPath?: string;
	hash?: string;
}

// Keep validated control JSON to controller-consumed machine fields only.
// Planner prose such as rationale, strategy, criteria descriptions, and gaps
// belongs in the separate <analysis> artifact captured by the controller loop.
const DECISION_ALLOWED_KEYS = new Set([
	"schema",
	"decisionId",
	"round",
	"phase",
	"status",
	"nextActions",
]);
const DECISION_FIELD_ALIASES = new Map([["actions", "nextActions"]]);

const COMMON_ACTION_KEYS = new Set(["type", "actionId"]);
const ACTION_FIELD_ALIASES = new Map([
	["action", "type"],
	["id", "actionId"],
]);
const ACTION_KEYS: Record<DynamicDecisionActionType, Set<string>> = {
	add_work_item: new Set([
		...COMMON_ACTION_KEYS,
		"workItemId",
		"agent",
		"prompt",
		"tools",
		"outputProfile",
		"dependsOn",
		"inputRefs",
	]),
	verify: new Set([
		...COMMON_ACTION_KEYS,
		"targetFindingId",
		"prompt",
		"tools",
		"outputProfile",
		"inputRefs",
	]),
	synthesize: new Set([
		...COMMON_ACTION_KEYS,
		"prompt",
		"outputProfile",
		"inputRefs",
	]),
	stop: new Set([...COMMON_ACTION_KEYS, "reason", "caveats"]),
};

const DEFAULT_OUTPUT_PROFILES = new Set<string>(DYNAMIC_OUTPUT_PROFILES);

export function validateDynamicDecision(
	value: unknown,
	context: DynamicDecisionValidationContext = {},
): DynamicDecisionValidationResult {
	const errors: string[] = [];
	if (!isRecord(value)) {
		return { ok: false, errors: ["decision must be an object"] };
	}
	for (const key of Object.keys(value)) {
		if (DECISION_ALLOWED_KEYS.has(key)) continue;
		const canonical = DECISION_FIELD_ALIASES.get(key);
		if (canonical)
			errors.push(`decision field ${key} is not allowed; use ${canonical}`);
		else errors.push(`unknown decision field ${key}`);
	}
	if (value.schema !== DYNAMIC_DECISION_SCHEMA)
		errors.push(`schema must be ${DYNAMIC_DECISION_SCHEMA}`);
	const decisionId = requiredString(value.decisionId, "decisionId", errors);
	const round = requiredNonNegativeInteger(value.round, "round", errors);
	const phase = enumString(
		value.phase,
		"phase",
		["orientation", "round", "final"],
		errors,
	) as DynamicDecisionPhase | undefined;
	const status = enumString(
		value.status,
		"status",
		["continue", "synthesize", "stop", "blocked"],
		errors,
	) as DynamicDecisionStatus | undefined;

	if (
		context.expectedRound !== undefined &&
		round !== undefined &&
		round !== context.expectedRound
	) {
		errors.push(`round must match expected round ${context.expectedRound}`);
	}
	if (
		context.maxDecisionRounds !== undefined &&
		round !== undefined &&
		round >= context.maxDecisionRounds
	) {
		errors.push(`round exceeds maxDecisionRounds ${context.maxDecisionRounds}`);
	}

	const nextActions = normalizeActions(value.nextActions, context, errors);

	if (
		context.maxActions !== undefined &&
		nextActions.length > context.maxActions
	)
		errors.push(`nextActions exceeds maxActions ${context.maxActions}`);
	validateIdCollisions(
		[
			...(decisionId ? [{ label: "decisionId", value: decisionId }] : []),
			...nextActions.map((action) => ({
				label: "actionId",
				value: action.actionId,
			})),
			...nextActions
				.filter(
					(action): action is DynamicDecisionAddWorkItemAction =>
						action.type === "add_work_item",
				)
				.map((action) => ({ label: "workItemId", value: action.workItemId })),
		],
		errors,
	);
	validateStatusActionInvariant(status, nextActions, errors);
	validateDependencies(nextActions, context, errors);

	if (
		errors.length > 0 ||
		!decisionId ||
		round === undefined ||
		!phase ||
		!status
	) {
		return { ok: false, errors };
	}

	const decision: NormalizedDynamicDecision = pruneUndefined({
		schema: DYNAMIC_DECISION_SCHEMA,
		decisionId,
		round,
		phase,
		status,
		nextActions,
	});
	return {
		ok: true,
		errors: [],
		decision,
		hash: hashDynamicDecision(decision),
	};
}

export function assertValidDynamicDecision(
	value: unknown,
	context: DynamicDecisionValidationContext = {},
): NormalizedDynamicDecision {
	const result = validateDynamicDecision(value, context);
	if (!result.ok || !result.decision) {
		throw new Error(`invalid dynamic decision: ${result.errors.join("; ")}`);
	}
	return result.decision;
}

export function hashDynamicDecision(value: unknown): string {
	return createHash("sha256")
		.update(stableStringify(toJsonNormalizedValue(value)))
		.digest("hex");
}

export function dynamicLoopSignature(
	decision: NormalizedDynamicDecision,
): string {
	return hashDynamicDecision({
		schema: DYNAMIC_LOOP_SIGNATURE_SCHEMA,
		status: decision.status,
		nextActions: decision.nextActions,
	});
}

export async function writeDynamicDecisionArtifacts(
	input: DynamicDecisionArtifactWriteInput,
): Promise<DynamicDecisionArtifactWriteResult> {
	const round = input.validation.decision?.round ?? 0;
	const decisionId = input.validation.decision?.decisionId ?? "invalid";
	const directory = join(
		dynamicRunDir(input.cwd, input.runId),
		"decisions",
		sanitizeSegment(input.controllerSpecId),
		`round-${String(round).padStart(3, "0")}-${sanitizeSegment(decisionId)}`,
	);
	await ensureDir(directory);
	const rawPath = join(directory, "raw.json");
	const validationPath = join(directory, "validation.json");
	const acceptedPath = join(directory, "accepted.json");
	if (input.validation.ok && input.validation.hash)
		await assertExistingDecisionHashMatches(
			acceptedPath,
			input.validation.hash,
		);
	await writeJsonAtomic(rawPath, toJsonNormalizedValue(input.rawDecision));
	await writeJsonAtomic(validationPath, {
		schema: DYNAMIC_DECISION_SCHEMA,
		validatorVersion: DYNAMIC_DECISION_VALIDATOR_VERSION,
		ok: input.validation.ok,
		errors: input.validation.errors,
		decisionHash: input.validation.hash,
		stateIndexDigest: input.stateIndexDigest,
	});
	if (!input.validation.ok || !input.validation.decision) {
		return { directory, rawPath, validationPath };
	}
	await writeJsonAtomic(acceptedPath, {
		schema: DYNAMIC_DECISION_SCHEMA,
		validatorVersion: DYNAMIC_DECISION_VALIDATOR_VERSION,
		decisionHash: input.validation.hash,
		stateIndexDigest: input.stateIndexDigest,
		decision: input.validation.decision,
	});
	return {
		directory,
		rawPath,
		validationPath,
		acceptedPath,
		hash: input.validation.hash,
	};
}

async function assertExistingDecisionHashMatches(
	acceptedPath: string,
	expectedHash: string,
): Promise<void> {
	let existingText: string;
	try {
		existingText = await readFile(acceptedPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	const existing = JSON.parse(existingText) as { decisionHash?: unknown };
	if (existing.decisionHash !== expectedHash) {
		throw new Error(
			`dynamic decision accepted artifact already exists with divergent hash: ${String(existing.decisionHash)} != ${expectedHash}`,
		);
	}
}

function normalizeActions(
	value: unknown,
	context: DynamicDecisionValidationContext,
	errors: string[],
): DynamicDecisionAction[] {
	if (!Array.isArray(value)) {
		errors.push("nextActions must be an array");
		return [];
	}
	const actions: DynamicDecisionAction[] = [];
	for (const [index, rawAction] of value.entries()) {
		const path = `nextActions[${index}]`;
		if (!isRecord(rawAction)) {
			errors.push(`${path} must be an object`);
			continue;
		}
		for (const key of Object.keys(rawAction)) {
			const canonical = ACTION_FIELD_ALIASES.get(key);
			if (canonical)
				errors.push(`${path}.${key} is not allowed; use ${canonical}`);
		}
		const type = enumString(
			rawAction.type,
			`${path}.type`,
			["add_work_item", "verify", "synthesize", "stop"],
			errors,
		) as DynamicDecisionActionType | undefined;
		if (!type) continue;
		for (const key of Object.keys(rawAction)) {
			if (!ACTION_KEYS[type].has(key) && !ACTION_FIELD_ALIASES.has(key))
				errors.push(`${path}.${key} is not allowed`);
		}
		const actionId = requiredString(
			rawAction.actionId,
			`${path}.actionId`,
			errors,
		);
		if (!actionId) continue;
		if (type === "add_work_item") {
			const workItemId = requiredString(
				rawAction.workItemId,
				`${path}.workItemId`,
				errors,
			);
			const agent =
				context.requireAgent === false
					? optionalString(rawAction.agent, `${path}.agent`, errors)
					: requiredString(rawAction.agent, `${path}.agent`, errors);
			validateActionAgent(agent, context, path, errors);
			const prompt = requiredString(rawAction.prompt, `${path}.prompt`, errors);
			const tools = optionalStringArray(
				rawAction.tools,
				`${path}.tools`,
				errors,
			);
			validateActionTools(tools, context, path, errors);
			const outputProfile = optionalOutputProfile(
				rawAction.outputProfile,
				context,
				path,
				errors,
			);
			const dependsOn = optionalStringArray(
				rawAction.dependsOn,
				`${path}.dependsOn`,
				errors,
			);
			const inputRefs = optionalArtifactRefs(
				rawAction.inputRefs,
				`${path}.inputRefs`,
				context,
				errors,
			);
			if (workItemId && prompt && (agent || context.requireAgent === false))
				actions.push(
					pruneUndefined({
						type,
						actionId,
						workItemId,
						agent,
						prompt,
						tools,
						outputProfile,
						dependsOn,
						inputRefs,
					}) as DynamicDecisionAddWorkItemAction,
				);
			continue;
		}
		if (type === "verify") {
			const targetFindingId = requiredString(
				rawAction.targetFindingId,
				`${path}.targetFindingId`,
				errors,
			);
			if (
				targetFindingId &&
				context.knownFindingIds &&
				!context.knownFindingIds.includes(targetFindingId)
			) {
				errors.push(`${path}.targetFindingId references unknown finding`);
			}
			const prompt = requiredString(rawAction.prompt, `${path}.prompt`, errors);
			const tools = optionalStringArray(
				rawAction.tools,
				`${path}.tools`,
				errors,
			);
			validateActionTools(tools, context, path, errors);
			const outputProfile = optionalOutputProfile(
				rawAction.outputProfile,
				context,
				path,
				errors,
			);
			const inputRefs = optionalArtifactRefs(
				rawAction.inputRefs,
				`${path}.inputRefs`,
				context,
				errors,
			);
			if (targetFindingId && prompt)
				actions.push(
					pruneUndefined({
						type,
						actionId,
						targetFindingId,
						prompt,
						tools,
						outputProfile,
						inputRefs,
					}) as DynamicDecisionVerifyAction,
				);
			continue;
		}
		if (type === "synthesize") {
			const prompt = optionalString(rawAction.prompt, `${path}.prompt`, errors);
			const outputProfile = optionalOutputProfile(
				rawAction.outputProfile,
				context,
				path,
				errors,
			);
			const inputRefs = optionalArtifactRefs(
				rawAction.inputRefs,
				`${path}.inputRefs`,
				context,
				errors,
			);
			actions.push(
				pruneUndefined({
					type,
					actionId,
					prompt,
					outputProfile,
					inputRefs,
				}) as DynamicDecisionSynthesizeAction,
			);
			continue;
		}
		const reason = requiredString(rawAction.reason, `${path}.reason`, errors);
		const caveats = optionalStringArray(
			rawAction.caveats,
			`${path}.caveats`,
			errors,
		);
		if (reason)
			actions.push(
				pruneUndefined({
					type,
					actionId,
					reason,
					caveats,
				}) as DynamicDecisionStopAction,
			);
	}
	return actions;
}

function validateActionAgent(
	agent: string | undefined,
	context: DynamicDecisionValidationContext,
	path: string,
	errors: string[],
): void {
	if (!agent) return;
	const allowedAgents = context.allowedAgents;
	if (
		allowedAgents &&
		allowedAgents.length > 0 &&
		!allowedAgents.includes(agent)
	) {
		errors.push(`${path}.agent is not allowed`);
	}
}

function validateActionTools(
	tools: string[] | undefined,
	context: DynamicDecisionValidationContext,
	path: string,
	errors: string[],
): void {
	for (const error of validateToolAuthority(tools, {
		allowedTools: context.allowedTools,
		toolProviders: context.toolProviders,
		allowUnknownTools: context.allowUnknownTools,
	})) {
		errors.push(`${path}.tools: ${error}`);
	}
	for (const tool of tools ?? []) {
		if (effectiveToolClassification(tool, context.toolProviders) === undefined)
			continue;
	}
}

function optionalOutputProfile(
	value: unknown,
	context: DynamicDecisionValidationContext,
	path: string,
	errors: string[],
): string | undefined {
	const outputProfile = optionalString(value, `${path}.outputProfile`, errors);
	if (!outputProfile) return undefined;
	const allowed = new Set(
		context.allowedOutputProfiles ?? DEFAULT_OUTPUT_PROFILES,
	);
	if (!allowed.has(outputProfile))
		errors.push(`${path}.outputProfile is unknown`);
	return outputProfile;
}

function optionalArtifactRefs(
	value: unknown,
	path: string,
	context: DynamicDecisionValidationContext,
	errors: string[],
): DynamicDecisionArtifactRef[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		errors.push(`${path} must be an array`);
		return undefined;
	}
	const refs: DynamicDecisionArtifactRef[] = [];
	for (const [index, ref] of value.entries()) {
		const refPath = `${path}[${index}]`;
		if (!isRecord(ref)) {
			errors.push(`${refPath} must be an object`);
			continue;
		}
		const allowedKeys = new Set(["kind", "taskId", "artifact", "digest"]);
		for (const key of Object.keys(ref)) {
			if (!allowedKeys.has(key))
				errors.push(`${refPath}.${key} is not allowed`);
		}
		if (ref.kind !== "workflow-artifact-ref")
			errors.push(`${refPath}.kind must be workflow-artifact-ref`);
		const taskId = requiredString(ref.taskId, `${refPath}.taskId`, errors);
		const knownArtifactTaskIds =
			context.knownArtifactTaskIds ?? context.knownGeneratedTaskIds;
		if (
			taskId &&
			knownArtifactTaskIds &&
			!knownArtifactTaskIds.includes(taskId)
		) {
			errors.push(`${refPath}.taskId references unknown artifact task`);
		}
		const artifact = optionalString(
			ref.artifact,
			`${refPath}.artifact`,
			errors,
		);
		const digest = optionalString(ref.digest, `${refPath}.digest`, errors);
		if (taskId)
			refs.push(
				pruneUndefined({
					kind: "workflow-artifact-ref",
					taskId,
					artifact,
					digest,
				}) as DynamicDecisionArtifactRef,
			);
	}
	return refs;
}

function validateStatusActionInvariant(
	status: DynamicDecisionStatus | undefined,
	actions: DynamicDecisionAction[],
	errors: string[],
): void {
	if (!status) return;
	if (actions.length === 0) {
		errors.push("nextActions must contain at least one action");
		return;
	}
	const types = new Set(actions.map((action) => action.type));
	if (
		types.has("stop") &&
		(actions.length !== 1 || (status !== "stop" && status !== "blocked"))
	)
		errors.push(
			"stop action must be the only action and requires status stop or blocked",
		);
	if (status === "stop" && !types.has("stop"))
		errors.push("status stop requires a stop action");
	if (status === "continue" && (types.has("stop") || types.has("synthesize")))
		errors.push("status continue cannot include stop or synthesize actions");
	if (
		status === "synthesize" &&
		(types.has("add_work_item") || types.has("verify"))
	)
		errors.push(
			"status synthesize cannot include add_work_item or verify actions",
		);
	if (status === "blocked" && !types.has("stop"))
		errors.push("status blocked must currently use a stop action with caveats");
}

function validateDependencies(
	actions: DynamicDecisionAction[],
	context: DynamicDecisionValidationContext,
	errors: string[],
): void {
	const known = new Set(context.knownGeneratedTaskIds ?? []);
	for (const action of actions) {
		if (action.type !== "add_work_item") continue;
		if (
			known.has(action.workItemId) ||
			[...known].some(
				(taskId) => taskId.split(".").at(-1) === action.workItemId,
			)
		) {
			errors.push(
				`action ${action.actionId} workItemId already exists as a generated task`,
			);
		}
		const dependsOn = action.dependsOn ?? [];
		for (const dependency of dependsOn) {
			if (known.size > 0 && !known.has(dependency))
				errors.push(
					`action ${action.actionId} depends on unknown task ${dependency}`,
				);
			if (dependency === action.workItemId)
				errors.push(`action ${action.actionId} depends on itself`);
		}
	}
}

function validateIdCollisions(
	items: Array<{ label: string; value: string }>,
	errors: string[],
): void {
	const seen = new Map<string, string>();
	for (const item of items) {
		const slug = slugId(item.value);
		if (!slug) {
			errors.push(`${item.label} ${item.value} has no stable slug`);
			continue;
		}
		const previous = seen.get(slug);
		if (previous && previous !== item.value)
			errors.push(`${item.label} ${item.value} collides with ${previous}`);
		else if (previous) errors.push(`${item.label} ${item.value} is duplicated`);
		seen.set(slug, item.value);
	}
}

function requiredString(
	value: unknown,
	path: string,
	errors: string[],
): string | undefined {
	if (typeof value !== "string" || value.trim() === "") {
		errors.push(`${path} must be a non-empty string`);
		return undefined;
	}
	return value.trim();
}

function optionalString(
	value: unknown,
	path: string,
	errors: string[],
): string | undefined {
	if (value === undefined) return undefined;
	return requiredString(value, path, errors);
}

function optionalStringArray(
	value: unknown,
	path: string,
	errors: string[],
): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		errors.push(`${path} must be an array of strings`);
		return undefined;
	}
	const result: string[] = [];
	const seen = new Set<string>();
	for (const [index, item] of value.entries()) {
		const normalized = requiredString(item, `${path}[${index}]`, errors);
		if (!normalized) continue;
		const slug = slugId(normalized);
		if (seen.has(slug))
			errors.push(`${path}[${index}] duplicates ${normalized}`);
		seen.add(slug);
		result.push(normalized);
	}
	return result;
}

function requiredNonNegativeInteger(
	value: unknown,
	path: string,
	errors: string[],
): number | undefined {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		errors.push(`${path} must be a non-negative integer`);
		return undefined;
	}
	return value;
}

function enumString(
	value: unknown,
	path: string,
	allowed: readonly string[],
	errors: string[],
): string | undefined {
	if (typeof value !== "string" || !allowed.includes(value)) {
		errors.push(`${path} must be one of: ${allowed.join(", ")}`);
		return undefined;
	}
	return value;
}

function pruneUndefined<T>(value: T): T {
	if (Array.isArray(value))
		return value.map((item) => pruneUndefined(item)) as T;
	if (!isRecord(value)) return value;
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (item !== undefined) result[key] = pruneUndefined(item);
	}
	return result as T;
}

function stableStringify(value: unknown): string {
	return JSON.stringify(toStableJson(value));
}

function toJsonNormalizedValue(value: unknown): unknown {
	const text = JSON.stringify(value);
	return text === undefined ? null : JSON.parse(text);
}

function toStableJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => toStableJson(item));
	if (!isRecord(value)) return value;
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort())
		result[key] = toStableJson(value[key]);
	return result;
}

function slugId(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

function sanitizeSegment(value: string): string {
	return slugId(value) || "item";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
