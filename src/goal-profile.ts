import { parseArtifactGraphWorkflowSpec } from "./artifact-graph-schema.js";
import { collectWorkflowProfileStageSlots, workflowDefinitionFingerprint } from "./execution-profile.js";
import { parseGoalProfile } from "./goal-contract.js";
import { parseGoalWorkflowSpec } from "./goal-workflow-schema.js";
import { arr, cloneGoalWorkflowData, digest, frozen, goalHash, id, nat, nullable, obj, one, parse, positive, str, unique, type Check } from "./goal-json.js";
import type {
	GoalProfileCapture,
	GoalProfileCaptureRevision,
	GoalProfileCaptureRevisionProposal,
	GoalProfileRuntimePatch,
	GoalProfileScope,
} from "./goal-types.js";
import {
	THINKING_LEVELS,
	WORKFLOW_PROFILE_ROLES,
	type ArtifactGraphWorkflowSpec,
	type GoalWorkflowSpec,
	type ThinkingLevel,
	type WorkflowCapturedExecutionProfile,
	type WorkflowProfileRole,
	type WorkflowSpec,
} from "./types.js";
import { buildWorkflowExecutionProfile, type WorkflowCustomProfile, type WorkflowUserProfileId } from "./workflow-profile-settings.js";
import { getSupportedThinkingLevels, type WorkflowModelInfo, type WorkflowRuntimeDefaults } from "./workflow-runtime.js";

/** Settings-only template. Not registered in the catalog or accepted for dispatch. */
export function goalProfileTemplate(): ArtifactGraphWorkflowSpec {
	return frozen({
		schemaVersion: 1,
		name: "goal-profile-template-v1",
		defaults: { agent: "goal-profile-template", readOnly: true, tools: ["read"] },
		artifactGraph: { stages: WORKFLOW_PROFILE_ROLES.map(role => ({
			id: role, type: "single" as const, profileRole: role,
			prompt: "Profile settings slot only; never execute this template.",
			output: { analysis: { required: true }, refs: { required: true } },
		})) },
	});
}

export interface GoalProfileStart {
	profileId: WorkflowUserProfileId;
	custom?: WorkflowCustomProfile;
	currentRuntime: WorkflowRuntimeDefaults;
	availableModels: readonly WorkflowModelInfo[];
	environmentDigest: string;
}

export type GoalWorkflowProfileSelection =
	| {
			profileId: WorkflowUserProfileId;
			custom?: WorkflowCustomProfile;
	  }
	| { executionProfile: WorkflowCapturedExecutionProfile };

export interface GoalWorkflowProfileStart {
	spec: GoalWorkflowSpec;
	selection: GoalWorkflowProfileSelection;
	currentRuntime: WorkflowRuntimeDefaults;
	availableModels: readonly WorkflowModelInfo[];
	environmentDigest: string;
}

/** Pure capture; caller supplies a trusted /model inventory, not worker claims.
 * No saved preferences, defaults, environment variables or provider calls read here. */
export function captureGoalProfile(input: GoalProfileStart): GoalProfileCapture {
	digest(input.environmentDigest);
	const template = goalProfileTemplate();
	const capture = buildWorkflowExecutionProfile({
		spec: template, specPath: "", currentRuntime: input.currentRuntime,
		availableModels: input.availableModels,
	}, input.profileId, input.custom);
	const profile = parseGoalProfile({
		schemaVersion: 1, name: capture.name, source: input.profileId === "custom" ? "custom" : "builtin",
		templateFingerprint: capture.definitionFingerprint, environmentDigest: input.environmentDigest,
		roles: WORKFLOW_PROFILE_ROLES.map(role => ({
			role, model: capture.stageOverrides[role].model, thinking: capture.stageOverrides[role].thinking,
			origin: {
				model: input.profileId === "custom" ? input.custom!.stages[role].model.kind : "fixed",
				thinking: input.profileId === "custom" ? input.custom!.stages[role].thinking.kind : "fixed",
			},
		})),
	});
	assertGoalProfileAvailable(profile, input.availableModels);
	if (profile.templateFingerprint !== workflowDefinitionFingerprint(template)) throw new Error("Goal profile template fingerprint mismatch");
	return profile;
}

/** Capture the concrete role selection for one parsed Goal definition at launch. */
export function captureGoalWorkflowProfile(
	input: GoalWorkflowProfileStart,
): GoalProfileCapture {
	digest(input.environmentDigest);
	const definitionFingerprint = workflowDefinitionFingerprint(input.spec);
	const executionProfile =
		"executionProfile" in input.selection
			? input.selection.executionProfile
			: buildWorkflowExecutionProfile(
					{
						spec: input.spec,
						specPath: "",
						currentRuntime: input.currentRuntime,
						availableModels: input.availableModels,
					},
					input.selection.profileId,
					input.selection.custom,
				);
	if (executionProfile.definitionFingerprint !== definitionFingerprint)
		throw new Error("Goal execution profile belongs to a different definition");
	const source =
		"executionProfile" in input.selection
			? executionProfile.name === "Custom"
				? "custom"
				: "builtin"
			: input.selection.profileId === "custom"
				? "custom"
				: "builtin";
	const roles = new Map<
		WorkflowProfileRole,
		{ model: string; thinking: ThinkingLevel }
	>();
	for (const slot of collectWorkflowProfileStageSlots(input.spec)) {
		const role = slot.profileRole!;
		const runtime = executionProfile.stageOverrides[slot.id];
		if (!runtime?.model || !runtime.thinking)
			throw new Error(`Goal execution profile lacks concrete runtime: ${slot.id}`);
		const previous = roles.get(role);
		if (
			previous &&
			(previous.model !== runtime.model || previous.thinking !== runtime.thinking)
		)
			throw new Error(`Goal role has inconsistent concrete runtime: ${role}`);
		roles.set(role, { model: runtime.model, thinking: runtime.thinking });
	}
	const profile = parseGoalProfile({
		schemaVersion: 1,
		name: executionProfile.name,
		source,
		templateFingerprint: definitionFingerprint,
		environmentDigest: input.environmentDigest,
		roles: WORKFLOW_PROFILE_ROLES.map((role) => {
			const runtime = roles.get(role);
			if (!runtime) throw new Error(`Goal execution profile missing role: ${role}`);
			return {
				role,
				...runtime,
				origin: { model: "fixed", thinking: "fixed" },
			};
		}),
	});
	assertGoalProfileAvailable(profile, input.availableModels);
	return profile;
}

export function assertGoalProfileAvailable(profile: GoalProfileCapture, models: readonly WorkflowModelInfo[]): void {
	parseGoalProfile(profile);
	for (const runtime of profile.roles) assertProfileRuntimeAvailable(runtime, runtime.role, models);
}

function assertProfileRuntimeAvailable(
	runtime: { model: string; thinking: ThinkingLevel },
	role: WorkflowProfileRole,
	models: readonly WorkflowModelInfo[],
): void {
	const found = models.filter(model => model.fullId === runtime.model);
	if (found.length !== 1) throw new Error(`Goal profile model unavailable or ambiguous: ${runtime.model}`);
	if (!getSupportedThinkingLevels(found[0]).includes(runtime.thinking))
		throw new Error(`Goal profile thinking unsupported: ${role}`);
}

export interface GoalChildProfileContext<TSpec extends WorkflowSpec = ArtifactGraphWorkflowSpec> {
	profile: GoalProfileCapture;
	/** Exact parsed definition and host-frozen transitive bundle identity. */
	spec: TSpec;
	bundleDigest: string;
	availableModels: readonly WorkflowModelInfo[];
	runtimeOverrides?: WorkflowRuntimeDefaults;
}
export interface GoalChildProfileCapture {
	schemaVersion: 1;
	profileHash: string;
	bundleDigest: string;
	executionProfile: WorkflowCapturedExecutionProfile;
}

const dynamicGoalRoles: Readonly<Record<string, WorkflowProfileRole>> = Object.freeze({
	planner: "planning",
	workerDefaults: "research-execution",
	verifier: "verification",
	synthesis: "synthesis",
});

/** A NEW definition-bound capture per child. No parent fingerprint transplant or
 * child saved-preference lookup. Bundle digest binding is not filesystem proof. */
export function captureGoalChildProfile(context: GoalChildProfileContext<WorkflowSpec>): GoalChildProfileCapture {
	const profile = parseGoalProfile(context.profile);
	assertGoalProfileAvailable(profile, context.availableModels);
	digest(context.bundleDigest);
	const input = cloneGoalWorkflowData(context.spec);
	const spec = Object.hasOwn(input, "goal")
		? parseGoalWorkflowSpec(input)
		: parseArtifactGraphWorkflowSpec(input);
	if (workflowDefinitionFingerprint(spec) === profile.templateFingerprint) throw new Error("Goal settings template is not a child workflow");
	const slots = collectWorkflowProfileStageSlots(spec);
	if (!slots.length || new Set(slots.map(s => s.id)).size !== slots.length) throw new Error("Goal child requires unique model slots");
	const custom: WorkflowCustomProfile = { baseProfile: "current", stages: Object.create(null) };
	for (const slot of slots) {
		const role = slot.profileRole ?? (slot.kind === "stage" ? "research-execution" :
			slot.kind === "dynamic-profile" ? dynamicGoalRoles[slot.id.slice(slot.id.lastIndexOf(".$") + 2)] : undefined);
		const runtime = profile.roles.find(r => r.role === role);
		if (!runtime) throw new Error(`Goal child missing profile role: ${slot.id}`);
		for (const key of ["model", "thinking"] as const) {
			if (context.runtimeOverrides?.[key] !== undefined && context.runtimeOverrides[key] !== runtime[key]) throw new Error(`Goal runtime override conflict: ${slot.id}/${key}`);
		}
		custom.stages[slot.id] = { model: { kind: "fixed", value: runtime.model }, thinking: { kind: "fixed", value: runtime.thinking } };
	}
	const executionProfile = buildWorkflowExecutionProfile({
		spec, specPath: "", currentRuntime: {}, availableModels: context.availableModels,
		defaultProfileRole: "research-execution",
	}, "custom", custom);
	return frozen({ schemaVersion: 1, profileHash: goalHash(profile), bundleDigest: context.bundleDigest, executionProfile });
}

/** Recompute exact expected bytes with the CURRENT trusted model inventory. */
export function assertGoalChildProfile(context: GoalChildProfileContext<WorkflowSpec>, capture: GoalChildProfileCapture): void {
	if (goalHash(capture) !== goalHash(captureGoalChildProfile(context))) throw new Error("Goal child profile capture mismatch");
}

/** Must be called at the actual materialized launch seam by the future adapter;
 * exporting a pure checker is not proof that a worker launch uses it. */
export function assertGoalResolvedRuntime(context: GoalChildProfileContext<WorkflowSpec>, capture: GoalChildProfileCapture, slotId: string, resolved: WorkflowRuntimeDefaults): void {
	assertGoalChildProfile(context, capture);
	if (!collectWorkflowProfileStageSlots(context.spec).some(s => s.id === slotId)) throw new Error("Goal resolved slot unknown");
	const expected = capture.executionProfile.stageOverrides[slotId];
	if (resolved.model !== expected.model || resolved.thinking !== expected.thinking) throw new Error("Goal resolved runtime differs from fixed capture");
}

const exactProfileKey: Check = value => {
	str(value);
	if (/[*?]/u.test(value as string)) throw new Error("Goal profile scope requires an exact key");
};
const profileItemProof = obj({
	placeholderSpecId: exactProfileKey,
	itemIdentity: str,
	itemHash: digest,
	sourceGeneration: nat,
	dispatchDigest: digest,
	materializedTaskId: id,
	materializedSpecId: exactProfileKey,
	itemSourceTaskId: id,
	itemSourceSpecId: exactProfileKey,
	itemSourceKind: one("control", "partial"),
	itemRef: str,
});
const profilePathSegment: Check = value => {
	const hasChild = value !== null && typeof value === "object" && Object.hasOwn(value, "child");
	obj({
		policySpecId: exactProfileKey,
		definitionFingerprint: digest,
		...(hasChild ? { child: obj({
			generation: nat, slot: exactProfileKey, workflowId: exactProfileKey,
			specHash: digest, requestHash: digest,
		}) } : {}),
	})(value);
};
const profileScope: Check = value => {
	const hasItem = value !== null && typeof value === "object" && Object.hasOwn(value, "item");
	obj({
		rootRunId: id,
		executionRunId: id,
		goalPath: arr(profilePathSegment, 1),
		template: exactProfileKey,
		role: one(...WORKFLOW_PROFILE_ROLES),
		...(hasItem ? { item: profileItemProof } : {}),
	})(value);
	const scope = value as GoalProfileScope;
	for (const [index, segment] of scope.goalPath.entries()) {
		if (Object.hasOwn(segment, "child") !== (index > 0))
			throw new Error("Goal profile path requires one root followed by complete child segments");
	}
	if (scope.item && scope.item.placeholderSpecId !== scope.template)
		throw new Error("Goal profile item belongs to another template");
};
const profileRuntimeFields = (requireField: boolean): Check => value => {
	const shape: Record<string, Check> = {};
	if (value !== null && typeof value === "object") {
		if (Object.hasOwn(value, "model")) shape.model = str;
		if (Object.hasOwn(value, "thinking")) shape.thinking = one(...THINKING_LEVELS);
	}
	if (requireField && Object.keys(shape).length === 0)
		throw new Error("Goal profile exception requires at least one runtime field");
	obj(shape)(value);
};
const profileConfirmationTime: Check = value => {
	str(value);
	const time = Date.parse(value as string);
	if (!Number.isFinite(time) || new Date(time).toISOString() !== value)
		throw new Error("Goal profile confirmation requires a canonical timestamp");
};
const profileCaptureProposalFields = {
	schemaVersion: one(1),
	captureRevision: positive,
	previousCaptureHash: nullable(digest),
	rootProfileHash: digest,
	initialBase: profileRuntimeFields(false),
	exceptions: arr(obj({
		scope: profileScope,
		runtime: profileRuntimeFields(true),
		reason: str,
	})),
};
const profileCaptureRevision = obj({
	...profileCaptureProposalFields,
	confirmation: obj({
		provenance: one("original-live-tui"),
		previewHash: digest,
		confirmedAt: profileConfirmationTime,
	}),
});

/** Strict configuration data only; neither a scope nor a digest grants admission. */
export function parseGoalProfileScope(input: unknown): GoalProfileScope {
	return parse<GoalProfileScope>(input, profileScope);
}

export function goalProfileScopeHash(input: GoalProfileScope): string {
	return goalHash(parseGoalProfileScope(input));
}

/** Checks representation, not publication or live confirmation of the revision. */
export function parseGoalProfileCaptureRevision(input: unknown, rootProfile: GoalProfileCapture): GoalProfileCaptureRevision {
	const root = parseGoalProfile(rootProfile);
	const revision = parse<GoalProfileCaptureRevision>(input, profileCaptureRevision);
	assertProfileRevisionRoot(revision, root);
	return revision;
}

/** A proposal has no confirmation fields and cannot masquerade as an accepted revision. */
export function parseGoalProfileCaptureRevisionProposal(
	input: unknown,
	rootProfile: GoalProfileCapture,
): GoalProfileCaptureRevisionProposal {
	const root = parseGoalProfile(rootProfile);
	const proposal = parse<GoalProfileCaptureRevisionProposal>(input, obj(profileCaptureProposalFields));
	assertProfileRevisionRoot(proposal, root);
	return proposal;
}

/**
 * Builds configuration data only. The result is neither accepted nor
 * published, and carries no confirmation or runtime authority.
 */
export function buildGoalProfileCaptureRevisionProposal(
	previous: GoalProfileCaptureRevision,
	rootProfile: GoalProfileCapture,
	inputScope: GoalProfileScope,
	inputRuntimePatch: GoalProfileRuntimePatch,
	inputReason: string,
	availableModels: readonly WorkflowModelInfo[],
): GoalProfileCaptureRevisionProposal {
	const root = parseGoalProfile(rootProfile);
	const prior = parseGoalProfileCaptureRevision(previous, root);
	const scope = parseGoalProfileScope(inputScope);
	const runtime = parse<GoalProfileRuntimePatch>(inputRuntimePatch, profileRuntimeFields(true));
	const { reason } = parse<{ reason: string }>({ reason: inputReason }, obj({ reason: str }));
	assertProfileRevisionInventory(prior, root, availableModels);
	if (prior.captureRevision === Number.MAX_SAFE_INTEGER)
		throw new Error("Goal profile revision overflow");
	const scopeHash = goalHash(scope);
	const index = prior.exceptions.findIndex(exception => goalHash(exception.scope) === scopeHash);
	const exceptions = prior.exceptions.map(exception => ({
		scope: exception.scope,
		runtime: exception.runtime,
		reason: exception.reason,
	}));
	if (index === -1) {
		exceptions.push({ scope, runtime, reason });
	} else {
		const mergedRuntime = parse<GoalProfileRuntimePatch>({
			...prior.exceptions[index].runtime,
			...runtime,
		}, profileRuntimeFields(true));
		exceptions[index] = {
			scope: prior.exceptions[index].scope,
			runtime: mergedRuntime,
			reason,
		};
	}
	const proposal = parseGoalProfileCaptureRevisionProposal({
		schemaVersion: 1,
		captureRevision: prior.captureRevision + 1,
		previousCaptureHash: goalHash(prior),
		rootProfileHash: prior.rootProfileHash,
		initialBase: prior.initialBase,
		exceptions,
	}, root);
	assertProfileRevisionInventory(proposal, root, availableModels);
	return proposal;
}

/**
 * Validates structural accepted-revision history only. A valid chain does not
 * establish live confirmation, publication, admission, or store membership.
 */
export function parseGoalProfileCaptureRevisionHistory(
	input: unknown,
	rootProfile: GoalProfileCapture,
): readonly GoalProfileCaptureRevision[] {
	const root = parseGoalProfile(rootProfile);
	const history = parse<GoalProfileCaptureRevision[]>(input, arr(profileCaptureRevision, 1));
	for (const revision of history) assertProfileRevisionRoot(revision, root);
	const first = history[0];
	if (first.captureRevision !== 1 || first.previousCaptureHash !== null)
		throw new Error("Goal profile revision history must begin at revision 1");
	const initialBaseHash = goalHash(first.initialBase);
	for (let index = 1; index < history.length; index++) {
		const previous = history[index - 1];
		const revision = history[index];
		if (previous.captureRevision === Number.MAX_SAFE_INTEGER ||
			revision.captureRevision !== previous.captureRevision + 1)
			throw new Error("Goal profile revision history is not contiguous");
		if (revision.previousCaptureHash !== goalHash(previous))
			throw new Error("Goal profile revision history predecessor mismatch");
		if (goalHash(revision.initialBase) !== initialBaseHash)
			throw new Error("Goal profile revision history initial base changed");
	}
	return history;
}

function assertProfileRevisionRoot(revision: GoalProfileCaptureRevisionProposal, root: GoalProfileCapture): void {
	if (revision.rootProfileHash !== goalHash(root))
		throw new Error("Goal profile revision belongs to another root capture");
	if ((revision.captureRevision === 1) !== (revision.previousCaptureHash === null))
		throw new Error("Goal profile revision predecessor shape is invalid");
	unique(revision.exceptions.map(exception => goalHash(exception.scope)));
}

function assertProfileRevisionInventory(
	revision: GoalProfileCaptureRevisionProposal,
	root: GoalProfileCapture,
	availableModels: readonly WorkflowModelInfo[],
): void {
	assertGoalProfileAvailable(root, availableModels);
	for (const exception of revision.exceptions) {
		const role = root.roles.find(runtime => runtime.role === exception.scope.role)!;
		assertProfileRuntimeAvailable({
			model: exception.runtime.model ?? role.model,
			thinking: exception.runtime.thinking ?? role.thinking,
		}, exception.scope.role, availableModels);
	}
}

/** Whole-proposal inventory validation, still not confirmation or publication. */
export function assertGoalProfileCaptureRevisionAvailable(
	input: GoalProfileCaptureRevision,
	rootProfile: GoalProfileCapture,
	availableModels: readonly WorkflowModelInfo[],
): void {
	const root = parseGoalProfile(rootProfile);
	const revision = parseGoalProfileCaptureRevision(input, root);
	assertProfileRevisionInventory(revision, root, availableModels);
}

export function assertGoalProfileCaptureRevisionProposalAvailable(
	input: GoalProfileCaptureRevisionProposal,
	rootProfile: GoalProfileCapture,
	availableModels: readonly WorkflowModelInfo[],
): void {
	const root = parseGoalProfile(rootProfile);
	const proposal = parseGoalProfileCaptureRevisionProposal(input, root);
	assertProfileRevisionInventory(proposal, root, availableModels);
}

/**
 * Pure per-field resolution. Callers must independently prove original live
 * admission, revision publication and current source/materialization custody.
 * Initial base is provenance only: complete captured roles cannot be repaired
 * from current preferences, partial base data, or exception fields.
 */
export function resolveGoalProfileRuntime(
	input: GoalProfileCaptureRevision,
	rootProfile: GoalProfileCapture,
	inputScope: GoalProfileScope,
	availableModels: readonly WorkflowModelInfo[],
): {
	model: string;
	thinking: ThinkingLevel;
	modelSource: "branch-exception" | "root-role";
	thinkingSource: "branch-exception" | "root-role";
	captureRevision: number;
	captureHash: string;
	scopeHash: string;
} {
	const root = parseGoalProfile(rootProfile);
	const revision = parseGoalProfileCaptureRevision(input, root);
	return resolveParsedGoalProfileRuntime(revision, root, inputScope, availableModels);
}

/** Preview data only: no fabricated confirmation or accepted-revision identity. */
export function resolveGoalProfileProposalRuntime(
	input: GoalProfileCaptureRevisionProposal,
	rootProfile: GoalProfileCapture,
	inputScope: GoalProfileScope,
	availableModels: readonly WorkflowModelInfo[],
): Readonly<{ model: string; thinking: ThinkingLevel }> {
	const root = parseGoalProfile(rootProfile);
	const proposal = parseGoalProfileCaptureRevisionProposal(input, root);
	const { model, thinking } = resolveParsedGoalProfileRuntime(proposal, root, inputScope, availableModels);
	return frozen({ model, thinking });
}

function resolveParsedGoalProfileRuntime(
	revision: GoalProfileCaptureRevisionProposal,
	root: GoalProfileCapture,
	inputScope: GoalProfileScope,
	availableModels: readonly WorkflowModelInfo[],
) {
	const scope = parseGoalProfileScope(inputScope);
	assertProfileRevisionInventory(revision, root, availableModels);
	const scopeHash = goalHash(scope);
	const patch = revision.exceptions.find(exception => goalHash(exception.scope) === scopeHash)?.runtime;
	const role = root.roles.find(runtime => runtime.role === scope.role)!;
	const model = patch?.model ?? role.model;
	const thinking = patch?.thinking ?? role.thinking;
	assertProfileRuntimeAvailable({ model, thinking }, scope.role, availableModels);
	return frozen({
		model, thinking,
		modelSource: patch?.model === undefined ? "root-role" : "branch-exception",
		thinkingSource: patch?.thinking === undefined ? "root-role" : "branch-exception",
		captureRevision: revision.captureRevision,
		captureHash: goalHash(revision),
		scopeHash,
	} as const);
}
