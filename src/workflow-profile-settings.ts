import { createHash } from "node:crypto";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
	cloneExecutionProfileStageOverride,
	collectWorkflowProfileStageSlots,
	workflowDefinitionFingerprint,
	type WorkflowProfileStageSlot,
} from "./execution-profile.js";
import { piAgentDir } from "./pi-agent-dir.js";
import {
	ensurePrivateDirectory,
	readPrivateDirectoryNames,
	readPrivateFileText,
	writePrivateFileAtomic,
} from "./secure-atomic-write.js";
import {
	THINKING_LEVELS,
	WORKFLOW_PROFILE_ROLES,
	type ArtifactGraphWorkflowSpec,
	type ExecutionProfileStageOverride,
	type ThinkingLevel,
	type WorkflowCapturedExecutionProfile,
	type WorkflowProfileRole,
} from "./types.js";
import {
	getSupportedThinkingLevels,
	type WorkflowModelInfo,
	type WorkflowRuntimeDefaults,
} from "./workflow-runtime.js";

export const WORKFLOW_PROFILE_SETTINGS_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_BUILTIN_PROFILE_IDS = [
	"codex",
	"codex-high",
	"claude",
	"mixed",
] as const;
export const WORKFLOW_USER_PROFILE_IDS = [
	...WORKFLOW_BUILTIN_PROFILE_IDS,
	"custom",
] as const;

export type WorkflowBuiltinProfileId =
	(typeof WORKFLOW_BUILTIN_PROFILE_IDS)[number];
export type WorkflowUserProfileId = (typeof WORKFLOW_USER_PROFILE_IDS)[number];
export type WorkflowCustomBaseProfileId = WorkflowBuiltinProfileId | "current";

export type InheritableWorkflowProfileValue<T> =
	| { kind: "inherit" }
	| { kind: "fixed"; value: T };

export interface WorkflowCustomStageAssignment {
	model: InheritableWorkflowProfileValue<string>;
	thinking: InheritableWorkflowProfileValue<ThinkingLevel>;
}

export interface WorkflowCustomProfile {
	baseProfile: WorkflowCustomBaseProfileId;
	stages: Record<string, WorkflowCustomStageAssignment>;
}

export interface StoredWorkflowProfileStage {
	id: string;
	profileRole: WorkflowProfileRole;
}

export interface WorkflowProfilePreference {
	schemaVersion: typeof WORKFLOW_PROFILE_SETTINGS_SCHEMA_VERSION;
	definitionFingerprint: string;
	workflowName: string;
	/** All canonical source paths that have saved this identical definition. */
	sourcePathHashes: string[];
	selectedProfile: WorkflowUserProfileId;
	stages: StoredWorkflowProfileStage[];
	custom?: WorkflowCustomProfile;
	updatedAt: string;
}

export interface WorkflowProfileIdentity {
	definitionFingerprint: string;
	workflowName: string;
	sourcePathHash: string;
	settingsFile: string;
}

export interface WorkflowProfileContext {
	spec: ArtifactGraphWorkflowSpec;
	specPath: string;
	availableModels: readonly WorkflowModelInfo[];
	currentRuntime: WorkflowRuntimeDefaults;
	runtimeOverrides?: WorkflowRuntimeDefaults;
}

export interface WorkflowProfileLoadResult {
	identity: WorkflowProfileIdentity;
	preference?: WorkflowProfilePreference;
	stalePreference?: WorkflowProfilePreference;
}

type BuiltinRoleRuntime = { model: string; thinking: ThinkingLevel };

const SOL_MODEL = "openai-codex/gpt-5.6-sol";
const LUNA_MODEL = "openai-codex/gpt-5.6-luna";
const OPUS_MODEL = "anthropic/claude-opus-4-8";
const SETTINGS_DIRECTORY = join("workflow-profiles", "v1");
const SETTINGS_FILE_PATTERN = /^[a-f0-9]{64}\.json$/;
const MAX_STALE_SCAN_FILES = 2_000;
const MAX_SETTINGS_DIRECTORY_ENTRIES = MAX_STALE_SCAN_FILES + 64;
const MAX_STALE_SCAN_BYTES = 16 * 1_048_576;
const SETTINGS_LOCK_FILE = ".settings.lock";
const SETTINGS_LOCK_WAIT_MS = 5_000;
const MIN_PROFILE_UPDATED_AT = "0000-01-01T00:00:00.000Z";
const MAX_PROFILE_UPDATED_AT = "9999-12-31T23:59:59.999Z";
const MIN_PROFILE_UPDATED_AT_MS = Date.parse(MIN_PROFILE_UPDATED_AT);
const MAX_PROFILE_UPDATED_AT_MS = Date.parse(MAX_PROFILE_UPDATED_AT);

const BUILTIN_PROFILE_LABELS: Record<WorkflowBuiltinProfileId, string> = {
	codex: "Codex",
	"codex-high": "Codex High",
	claude: "Claude",
	mixed: "Mixed",
};

const BUILTIN_ROLE_RUNTIME: Record<
	WorkflowBuiltinProfileId,
	Record<WorkflowProfileRole, BuiltinRoleRuntime>
> = {
	codex: {
		planning: { model: SOL_MODEL, thinking: "high" },
		"research-execution": { model: LUNA_MODEL, thinking: "medium" },
		synthesis: { model: LUNA_MODEL, thinking: "high" },
		verification: { model: LUNA_MODEL, thinking: "high" },
		"final-judgment": { model: SOL_MODEL, thinking: "xhigh" },
	},
	"codex-high": {
		planning: { model: SOL_MODEL, thinking: "xhigh" },
		"research-execution": { model: SOL_MODEL, thinking: "high" },
		synthesis: { model: SOL_MODEL, thinking: "xhigh" },
		verification: { model: SOL_MODEL, thinking: "xhigh" },
		"final-judgment": { model: SOL_MODEL, thinking: "xhigh" },
	},
	claude: {
		planning: { model: OPUS_MODEL, thinking: "high" },
		"research-execution": { model: OPUS_MODEL, thinking: "medium" },
		synthesis: { model: OPUS_MODEL, thinking: "high" },
		verification: { model: OPUS_MODEL, thinking: "high" },
		"final-judgment": { model: OPUS_MODEL, thinking: "high" },
	},
	mixed: {
		planning: { model: OPUS_MODEL, thinking: "high" },
		"research-execution": { model: LUNA_MODEL, thinking: "medium" },
		synthesis: { model: OPUS_MODEL, thinking: "high" },
		verification: { model: LUNA_MODEL, thinking: "high" },
		"final-judgment": { model: OPUS_MODEL, thinking: "high" },
	},
};

export function workflowBuiltinProfileLabel(
	profileId: WorkflowBuiltinProfileId,
): string {
	return BUILTIN_PROFILE_LABELS[profileId];
}

export function workflowUserProfileLabel(
	profileId: WorkflowUserProfileId,
): string {
	return profileId === "custom"
		? "Custom"
		: workflowBuiltinProfileLabel(profileId);
}

export function workflowProfileSettingsRoot(): string {
	return join(piAgentDir(), SETTINGS_DIRECTORY);
}

export async function workflowProfileIdentity(
	spec: ArtifactGraphWorkflowSpec,
	specPath: string,
): Promise<WorkflowProfileIdentity> {
	// Routing is comparison-only metadata, not execution/profile configuration.
	// Run capture still binds the complete definition via workflowDefinitionFingerprint.
	const profileDefinition = { ...spec };
	delete profileDefinition.routing;
	const definitionFingerprint = workflowDefinitionFingerprint(profileDefinition);
	let canonicalPath: string;
	try {
		canonicalPath = await realpath(specPath);
	} catch (error) {
		if (!isMissingPathError(error)) throw error;
		canonicalPath = resolve(specPath);
	}
	const sourcePathHash = sha256(canonicalPath);
	return {
		definitionFingerprint,
		workflowName: spec.name?.trim() || "unnamed-workflow",
		sourcePathHash,
		settingsFile: join(
			workflowProfileSettingsRoot(),
			`${definitionFingerprint}.json`,
		),
	};
}

/** Read both profile identity generations without rewriting either settings file. */
async function readCompatibleProfilePreference(
	spec: ArtifactGraphWorkflowSpec,
	identity: WorkflowProfileIdentity,
): Promise<WorkflowProfilePreference | undefined> {
	const slots = collectWorkflowProfileStageSlots(spec);
	const identities = [identity];
	const fullFingerprint = workflowDefinitionFingerprint(spec);
	if (fullFingerprint !== identity.definitionFingerprint) {
		identities.push({
			...identity,
			definitionFingerprint: fullFingerprint,
			settingsFile: join(
				dirname(identity.settingsFile),
				`${fullFingerprint}.json`,
			),
		});
	}
	const compatible: Array<{
		preference: WorkflowProfilePreference;
		canonical: boolean;
	}> = [];
	for (const [index, candidateIdentity] of identities.entries()) {
		const preference = await readPreferenceFile(candidateIdentity.settingsFile);
		if (!preference) continue;
		assertExactPreferenceMatches(preference, candidateIdentity, slots);
		compatible.push({ preference, canonical: index === 0 });
	}
	// Preserve the latest explicit choice if both pre-routing and full-definition
	// settings exist. At the ISO ceiling, the canonical tie-break lets a successful
	// canonical save supersede an immutable legacy record without rewriting it.
	compatible.sort(
		(left, right) =>
			right.preference.updatedAt.localeCompare(left.preference.updatedAt) ||
			Number(right.canonical) - Number(left.canonical),
	);
	const selected = compatible[0]?.preference;
	if (!selected) return undefined;
	return {
		...selected,
		definitionFingerprint: identity.definitionFingerprint,
		sourcePathHashes: [
			...new Set(
				compatible.flatMap(({ preference }) => preference.sourcePathHashes),
			),
		].sort((left, right) => left.localeCompare(right)),
	};
}

function nextWorkflowProfileUpdatedAt(previous: string | undefined): string {
	const boundedNow = Math.min(
		MAX_PROFILE_UPDATED_AT_MS,
		Math.max(MIN_PROFILE_UPDATED_AT_MS, Date.now()),
	);
	if (previous === undefined) return new Date(boundedNow).toISOString();
	const previousMs = Date.parse(previous);
	if (previousMs >= MAX_PROFILE_UPDATED_AT_MS) return MAX_PROFILE_UPDATED_AT;
	// The settings lock turns updatedAt into a durable logical revision: every
	// successful save advances beyond the selected compatible record even if the
	// wall clock rolls back or a legacy record was dated in the future.
	return new Date(Math.max(boundedNow, previousMs + 1)).toISOString();
}

export async function loadWorkflowProfilePreference(
	spec: ArtifactGraphWorkflowSpec,
	specPath: string,
): Promise<WorkflowProfileLoadResult> {
	const identity = await workflowProfileIdentity(spec, specPath);
	const exact = await readCompatibleProfilePreference(spec, identity);
	if (exact) return { identity, preference: exact };

	const root = dirname(identity.settingsFile);
	let names: string[];
	try {
		names = await readPrivateDirectoryNames(
			root,
			MAX_SETTINGS_DIRECTORY_ENTRIES,
		);
	} catch (error) {
		if (isMissingPathError(error)) return { identity };
		throw error;
	}
	const settingNames = names
		.filter((entry) => SETTINGS_FILE_PATTERN.test(entry))
		.sort();
	if (settingNames.length > MAX_STALE_SCAN_FILES) {
		throw new Error(
			`Workflow profile settings contain more than ${MAX_STALE_SCAN_FILES} definitions; stale-definition matching was blocked rather than truncated.`,
		);
	}
	const candidates: WorkflowProfilePreference[] = [];
	let scannedBytes = 0;
	for (const name of settingNames) {
		const candidate = await readPreferenceFile(join(root, name), (bytes) => {
			scannedBytes += bytes;
			if (scannedBytes > MAX_STALE_SCAN_BYTES) {
				throw new Error(
					`Workflow profile stale-definition scan exceeds ${MAX_STALE_SCAN_BYTES} bytes and was blocked rather than truncated.`,
				);
			}
		});
		if (
			candidate &&
			candidate.sourcePathHashes.includes(identity.sourcePathHash) &&
			candidate.definitionFingerprint !== identity.definitionFingerprint
		) {
			candidates.push(candidate);
		}
	}
	const stalePreference = candidates.sort((left, right) =>
		right.updatedAt.localeCompare(left.updatedAt),
	)[0];
	return { identity, ...(stalePreference ? { stalePreference } : {}) };
}

export async function saveWorkflowProfilePreference(
	context: Pick<WorkflowProfileContext, "spec" | "specPath">,
	selection: {
		selectedProfile: WorkflowUserProfileId;
		custom?: WorkflowCustomProfile;
	},
): Promise<WorkflowProfilePreference> {
	if (!WORKFLOW_USER_PROFILE_IDS.includes(selection.selectedProfile))
		throw new Error(
			`Unknown workflow profile: ${String(selection.selectedProfile)}`,
		);
	const identity = await workflowProfileIdentity(context.spec, context.specPath);
	const slots = requireProfileRoles(context.spec);
	return withWorkflowProfileSettingsLock(
		dirname(identity.settingsFile),
		async (assertOwner) => {
			const existing = await readCompatibleProfilePreference(
				context.spec,
				identity,
			);
			const selectedCustom = selection.custom
				? parseCustomProfile(selection.custom)
				: undefined;
			const custom = selectedCustom ?? existing?.custom;
			if (selection.selectedProfile === "custom" && !custom)
				throw new Error("Custom workflow profile requires stage settings.");
			const sourcePathHashes = Array.from(
				new Set([...(existing?.sourcePathHashes ?? []), identity.sourcePathHash]),
			).sort();
			const preference = parseWorkflowProfilePreference({
				schemaVersion: WORKFLOW_PROFILE_SETTINGS_SCHEMA_VERSION,
				definitionFingerprint: identity.definitionFingerprint,
				workflowName: identity.workflowName,
				sourcePathHashes,
				selectedProfile: selection.selectedProfile,
				stages: slots.map(({ id, profileRole }) => ({
					id,
					profileRole: profileRole!,
				})),
				...(custom ? { custom: cloneCustomProfile(custom) } : {}),
				updatedAt: nextWorkflowProfileUpdatedAt(existing?.updatedAt),
			});
			assertPreferenceMatchesSpec(preference, slots);
			await assertOwner();
			await writePrivateFileAtomic(
				identity.settingsFile,
				`${JSON.stringify(preference, null, 2)}\n`,
			);
			// Atomic rename is the commit boundary. A post-commit lock check could
			// report failure after the new preference is already visible.
			return preference;
		},
	);
}

/** Resolve a saved selection at run start; inheritance is captured here. */
export async function resolveSavedWorkflowExecutionProfile(
	context: WorkflowProfileContext,
): Promise<WorkflowCapturedExecutionProfile | undefined> {
	const loaded = await loadWorkflowProfilePreference(
		context.spec,
		context.specPath,
	);
	if (loaded.stalePreference) {
		throw new Error(formatStaleWorkflowProfileError(loaded.stalePreference, context.spec));
	}
	if (!loaded.preference) return undefined;
	const slots = requireProfileRoles(context.spec);
	assertPreferenceMatchesSpec(loaded.preference, slots);
	return buildWorkflowExecutionProfile(
		context,
		loaded.preference.selectedProfile,
		loaded.preference.custom,
	);
}

export function buildWorkflowExecutionProfile(
	context: WorkflowProfileContext,
	profileId: WorkflowUserProfileId,
	custom?: WorkflowCustomProfile,
): WorkflowCapturedExecutionProfile {
	if (!WORKFLOW_USER_PROFILE_IDS.includes(profileId))
		throw new Error(`Unknown workflow profile: ${String(profileId)}`);
	const slots = requireProfileRoles(context.spec);
	const stageOverrides = baseStageOverrides(context.spec);
	if (profileId === "custom") {
		if (!custom) throw new Error("Saved Custom workflow profile has no stage settings.");
		custom = parseCustomProfile(custom);
		assertCustomProfileMatchesSlots(custom, slots);
		for (const slot of slots) {
			const assignment = custom.stages[slot.id]!;
			stageOverrides[slot.id] = {
				...(stageOverrides[slot.id] ?? {}),
				model: resolveProfileValue(
					assignment.model,
					context.currentRuntime.model,
					`current Pi model for ${slot.id}`,
				),
				thinking: resolveProfileValue(
					assignment.thinking,
					context.currentRuntime.thinking,
					`current Pi thinking for ${slot.id}`,
				),
			};
		}
	} else {
		const roleRuntime = BUILTIN_ROLE_RUNTIME[profileId];
		for (const slot of slots) {
			const runtime = roleRuntime[slot.profileRole!];
			stageOverrides[slot.id] = {
				...(stageOverrides[slot.id] ?? {}),
				...runtime,
			};
		}
	}
	assertProfileRuntimeAvailable(
		stageOverrides,
		slots,
		context.availableModels,
		context.runtimeOverrides,
	);
	return {
		name: workflowUserProfileLabel(profileId),
		definitionFingerprint: workflowDefinitionFingerprint(context.spec),
		stageOverrides,
	};
}

export function createCustomProfileFromBuiltin(
	spec: ArtifactGraphWorkflowSpec,
	profileId: WorkflowBuiltinProfileId,
): WorkflowCustomProfile {
	if (!WORKFLOW_BUILTIN_PROFILE_IDS.includes(profileId))
		throw new Error(`Unknown built-in workflow profile: ${String(profileId)}`);
	const slots = requireProfileRoles(spec);
	const roleRuntime = BUILTIN_ROLE_RUNTIME[profileId];
	return {
		baseProfile: profileId,
		stages: Object.fromEntries(
			slots.map((slot) => {
				const runtime = roleRuntime[slot.profileRole!];
				return [
					slot.id,
					{
						model: { kind: "fixed", value: runtime.model },
						thinking: { kind: "fixed", value: runtime.thinking },
					},
				];
			}),
		),
	};
}

export function createInheritedCustomProfile(
	spec: ArtifactGraphWorkflowSpec,
): WorkflowCustomProfile {
	const slots = requireProfileRoles(spec);
	return {
		baseProfile: "current",
		stages: Object.fromEntries(
			slots.map(({ id }) => [
				id,
				{
					model: { kind: "inherit" },
					thinking: { kind: "inherit" },
				},
			]),
		),
	};
}

export function profileRuntimeForRole(
	profileId: WorkflowBuiltinProfileId,
	role: WorkflowProfileRole,
): Readonly<BuiltinRoleRuntime> {
	if (!WORKFLOW_BUILTIN_PROFILE_IDS.includes(profileId))
		throw new Error(`Unknown built-in workflow profile: ${String(profileId)}`);
	if (!WORKFLOW_PROFILE_ROLES.includes(role))
		throw new Error(`Unknown workflow profile role: ${String(role)}`);
	return { ...BUILTIN_ROLE_RUNTIME[profileId][role] };
}

export function formatStaleWorkflowProfileError(
	preference: WorkflowProfilePreference,
	currentSpec: ArtifactGraphWorkflowSpec,
): string {
	const currentSlots = collectWorkflowProfileStageSlots(currentSpec);
	const previous = new Map(preference.stages.map((stage) => [stage.id, stage]));
	const current = new Map(currentSlots.map((stage) => [stage.id, stage]));
	const added = [...current.keys()].filter((id) => !previous.has(id));
	const removed = [...previous.keys()].filter((id) => !current.has(id));
	const changed = [...current.entries()]
		.filter(
			([id, stage]) =>
				previous.has(id) &&
				previous.get(id)!.profileRole !== stage.profileRole,
		)
		.map(
			([id, stage]) =>
				`${id} (${previous.get(id)!.profileRole} → ${stage.profileRole ?? "missing"})`,
		);
	const details = [
		formatChangedList("added", added),
		formatChangedList("removed", removed),
		formatChangedList("role changed", changed),
	].filter((line): line is string => line !== undefined);
	return [
		`Saved workflow profile for ${JSON.stringify(preference.workflowName)} belongs to an older definition at this path and was not applied.`,
		...(details.length > 0
			? details
			: ["The workflow definition changed while its profile-role topology stayed the same."]),
		"Run /workflow profile <workflow> to review and save a profile for the new definition. The old settings file was not changed or migrated.",
	].join(" ");
}

export function effectiveCustomStageAssignment(
	assignment: WorkflowCustomStageAssignment,
	currentRuntime: WorkflowRuntimeDefaults,
): { model: string; thinking: ThinkingLevel } {
	return {
		model: resolveProfileValue(
			assignment.model,
			currentRuntime.model,
			"current Pi model",
		),
		thinking: resolveProfileValue(
			assignment.thinking,
			currentRuntime.thinking,
			"current Pi thinking",
		),
	};
}

function requireProfileRoles(
	spec: ArtifactGraphWorkflowSpec,
): WorkflowProfileStageSlot[] {
	const slots = collectWorkflowProfileStageSlots(spec);
	const missing = slots.filter(({ profileRole }) => profileRole === undefined);
	if (missing.length > 0) {
		throw new Error(
			`Workflow profile roles are missing or invalid for model-backed stage slot(s): ${missing
				.map(({ id }) => id)
				.join(", ")}. Add profileRole (${WORKFLOW_PROFILE_ROLES.join(", ")}) to each model-backed stage and dynamic decision profile. Existing declared executionProfiles remain usable without this metadata.`,
		);
	}
	return slots;
}

function baseStageOverrides(
	spec: ArtifactGraphWorkflowSpec,
): Record<string, ExecutionProfileStageOverride> {
	const profileName = spec.defaultExecutionProfile;
	const mapping = profileName ? spec.executionProfiles?.[profileName] : undefined;
	const cloned = Object.create(null) as Record<
		string,
		ExecutionProfileStageOverride
	>;
	for (const [id, override] of Object.entries(mapping ?? {})) {
		cloned[id] = cloneExecutionProfileStageOverride(override);
	}
	return cloned;
}

function assertProfileRuntimeAvailable(
	stageOverrides: Readonly<Record<string, ExecutionProfileStageOverride>>,
	slots: readonly WorkflowProfileStageSlot[],
	availableModels: readonly WorkflowModelInfo[],
	runtimeOverrides: WorkflowRuntimeDefaults | undefined,
): void {
	const problems: string[] = [];
	for (const slot of slots) {
		const runtime = stageOverrides[slot.id];
		if (!runtime) continue;
		let model: WorkflowModelInfo | undefined;
		if (runtimeOverrides?.model === undefined && runtime.model) {
			model = availableModels.find(({ fullId }) => fullId === runtime.model);
			if (!model) {
				problems.push(`${slot.id}: model ${runtime.model} is not available in Pi /model`);
				continue;
			}
		} else if (runtimeOverrides?.model?.includes("/")) {
			model = availableModels.find(
				({ fullId }) => fullId === runtimeOverrides.model,
			);
		}
		if (runtimeOverrides?.thinking !== undefined || !runtime.thinking || !model)
			continue;
		const supported = getSupportedThinkingLevels(model);
		if (!supported.includes(runtime.thinking)) {
			problems.push(
				`${slot.id}: thinking ${runtime.thinking} is not supported by ${model.fullId} (supported: ${supported.join(", ")})`,
			);
		}
	}
	if (problems.length > 0) {
		throw new Error(
			`Workflow profile cannot be applied without substitution or thinking clamp:\n- ${problems.join("\n- ")}`,
		);
	}
}

function assertExactPreferenceMatches(
	preference: WorkflowProfilePreference,
	identity: WorkflowProfileIdentity,
	slots: readonly WorkflowProfileStageSlot[],
): void {
	try {
		if (preference.definitionFingerprint !== identity.definitionFingerprint) {
			throw new Error("definition fingerprint does not match the settings filename.");
		}
		if (preference.workflowName !== identity.workflowName)
			throw new Error("workflow name does not match the workflow definition.");
		assertPreferenceMatchesSpec(preference, slots);
	} catch (error) {
		throw new Error(
			`Workflow profile settings are corrupt at ${identity.settingsFile}: ${error instanceof Error ? error.message : String(error)} The file was not changed.`,
		);
	}
}

function assertPreferenceMatchesSpec(
	preference: WorkflowProfilePreference,
	slots: readonly WorkflowProfileStageSlot[],
): void {
	const expected = slots.map(({ id, profileRole }) => ({ id, profileRole }));
	if (stableJson(preference.stages) !== stableJson(expected)) {
		throw new Error(
			"Saved workflow profile stage metadata does not match this workflow definition. It was not applied or migrated.",
		);
	}
	if (preference.custom) assertCustomProfileMatchesSlots(preference.custom, slots);
}

function assertCustomProfileMatchesSlots(
	custom: WorkflowCustomProfile,
	slots: readonly WorkflowProfileStageSlot[],
): void {
	const expected = new Set(slots.map(({ id }) => id));
	const actual = Object.keys(custom.stages);
	const missing = [...expected].filter(
		(id) => !Object.hasOwn(custom.stages, id),
	);
	const unknown = actual.filter((id) => !expected.has(id));
	if (missing.length > 0 || unknown.length > 0) {
		throw new Error(
			`Custom workflow profile stage settings do not match this definition (missing: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"}).`,
		);
	}
}

function resolveProfileValue<T>(
	value: InheritableWorkflowProfileValue<T>,
	current: T | undefined,
	label: string,
): T {
	if (value.kind === "fixed") return value.value;
	if (current === undefined) throw new Error(`${label} is unavailable for inheritance`);
	return current;
}

function cloneCustomProfile(custom: WorkflowCustomProfile): WorkflowCustomProfile {
	return {
		baseProfile: custom.baseProfile,
		stages: Object.fromEntries(
			Object.entries(custom.stages).map(([id, assignment]) => [
				id,
				{
					model:
						assignment.model.kind === "inherit"
							? { kind: "inherit" }
							: { kind: "fixed", value: assignment.model.value },
					thinking:
						assignment.thinking.kind === "inherit"
							? { kind: "inherit" }
							: { kind: "fixed", value: assignment.thinking.value },
				},
			]),
		),
	};
}

// Serialize read/merge/write so concurrent profile selection cannot discard a
// saved Custom draft. Unknown/crashed lock evidence is never reclaimed.
async function withWorkflowProfileSettingsLock<T>(
	root: string,
	action: (assertOwner: () => Promise<void>) => Promise<T>,
): Promise<T> {
	await ensurePrivateDirectory(root);
	const rootInfo = await lstat(root);
	const lockFile = join(root, SETTINGS_LOCK_FILE);
	const deadline = Date.now() + SETTINGS_LOCK_WAIT_MS;
	let handle;
	while (!handle) {
		await assertDirectoryIdentity(root, rootInfo);
		try {
			handle = await open(lockFile, "wx", 0o600);
		} catch (error) {
			if (!isRecord(error) || error.code !== "EEXIST") throw error;
			const info = await lstat(lockFile).catch((statError: unknown) => {
				if (isMissingPathError(statError)) return undefined;
				throw statError;
			});
			if (
				info &&
				(!info.isFile() ||
					info.isSymbolicLink() ||
					(info.nlink !== 0 && info.nlink !== 1))
			) {
				throw new Error("Unsafe workflow profile settings lock.");
			}
			if (Date.now() >= deadline) {
				throw new Error(
					"Workflow profile settings lock is busy; retry later. An abandoned lock requires manual inspection.",
				);
			}
			await new Promise((done) => setTimeout(done, 20));
		}
	}
	const lockInfo = await handle.stat();
	const assertOwner = async (): Promise<void> => {
		await assertDirectoryIdentity(root, rootInfo);
		const current = await lstat(lockFile);
		if (
			current.dev !== lockInfo.dev ||
			current.ino !== lockInfo.ino ||
			current.isSymbolicLink() ||
			current.nlink !== 1
		) {
			throw new Error("Workflow profile settings lock changed.");
		}
	};
	try {
		await handle.writeFile(`${JSON.stringify({ pid: process.pid })}\n`);
		await handle.sync();
		await assertOwner();
		return await action(assertOwner);
	} finally {
		await handle.close().catch(() => undefined);
		const currentRoot = await lstat(root).catch(() => undefined);
		const currentLock = await lstat(lockFile).catch(() => undefined);
		if (
			currentRoot?.dev === rootInfo.dev &&
			currentRoot.ino === rootInfo.ino &&
			currentLock?.dev === lockInfo.dev &&
			currentLock.ino === lockInfo.ino &&
			!currentLock.isSymbolicLink()
		) {
			await unlink(lockFile);
		}
	}
}

async function assertDirectoryIdentity(
	path: string,
	expected: { dev: number | bigint; ino: number | bigint },
): Promise<void> {
	const current = await lstat(path);
	if (
		!current.isDirectory() ||
		current.isSymbolicLink() ||
		current.dev !== expected.dev ||
		current.ino !== expected.ino
	) {
		throw new Error("Workflow profile settings directory changed.");
	}
}

async function readPreferenceFile(
	file: string,
	onBytes?: (bytes: number) => void,
): Promise<WorkflowProfilePreference | undefined> {
	let text: string;
	try {
		text = await readPrivateFileText(file);
	} catch (error) {
		if (isMissingPathError(error)) return undefined;
		throw new Error(
			`Workflow profile settings are unreadable or invalid at ${file}: ${error instanceof Error ? error.message : String(error)}. The file was not changed.`,
		);
	}
	onBytes?.(Buffer.byteLength(text, "utf8"));
	try {
		const preference = parseWorkflowProfilePreference(JSON.parse(text));
		const fileFingerprint = basename(file, ".json");
		if (
			SETTINGS_FILE_PATTERN.test(basename(file)) &&
			preference.definitionFingerprint !== fileFingerprint
		) {
			throw new Error(
				"definitionFingerprint does not match the settings filename",
			);
		}
		return preference;
	} catch (error) {
		throw new Error(
			`Workflow profile settings are unreadable or invalid at ${file}: ${error instanceof Error ? error.message : String(error)}. The file was not changed.`,
		);
	}
}

function parseWorkflowProfilePreference(
	value: unknown,
): WorkflowProfilePreference {
	const record = ownRecord(value, "settings root");
	assertOnlyKeys(
		record,
		[
			"schemaVersion",
			"definitionFingerprint",
			"workflowName",
			"sourcePathHashes",
			"selectedProfile",
			"stages",
			"custom",
			"updatedAt",
		],
		"settings root",
	);
	if (record.schemaVersion !== WORKFLOW_PROFILE_SETTINGS_SCHEMA_VERSION)
		throw new Error(
			`unsupported schemaVersion ${String(record.schemaVersion)}`,
		);
	const definitionFingerprint = requiredHash(
		record.definitionFingerprint,
		"definitionFingerprint",
	);
	const workflowName = requiredString(record.workflowName, "workflowName");
	if (
		!Array.isArray(record.sourcePathHashes) ||
		record.sourcePathHashes.length === 0
	) {
		throw new Error("sourcePathHashes must be a non-empty array");
	}
	const sourcePathHashes = record.sourcePathHashes.map((entry, index) =>
		requiredHash(entry, `sourcePathHashes[${index}]`),
	);
	if (new Set(sourcePathHashes).size !== sourcePathHashes.length)
		throw new Error("sourcePathHashes must not contain duplicates");
	const selectedProfile = requiredProfileId(record.selectedProfile);
	const updatedAt = requiredString(record.updatedAt, "updatedAt");
	const updatedAtMillis = Date.parse(updatedAt);
	if (
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(updatedAt) ||
		!Number.isFinite(updatedAtMillis) ||
		new Date(updatedAtMillis).toISOString() !== updatedAt
	) {
		throw new Error("updatedAt must be a canonical ISO date-time string");
	}
	if (!Array.isArray(record.stages)) throw new Error("stages must be an array");
	const seen = new Set<string>();
	const stages = record.stages.map((entry, index) => {
		const stage = ownRecord(entry, `stages[${index}]`);
		assertOnlyKeys(stage, ["id", "profileRole"], `stages[${index}]`);
		const id = requiredString(stage.id, `stages[${index}].id`);
		if (seen.has(id)) throw new Error(`stages contains duplicate id ${id}`);
		seen.add(id);
		const profileRole = requiredProfileRole(
			stage.profileRole,
			`stages[${index}].profileRole`,
		);
		return { id, profileRole };
	});
	const custom =
		record.custom === undefined ? undefined : parseCustomProfile(record.custom);
	if (selectedProfile === "custom" && custom === undefined)
		throw new Error("selected Custom profile requires custom settings");
	return {
		schemaVersion: WORKFLOW_PROFILE_SETTINGS_SCHEMA_VERSION,
		definitionFingerprint,
		workflowName,
		sourcePathHashes,
		selectedProfile,
		stages,
		...(custom ? { custom } : {}),
		updatedAt,
	};
}

function parseCustomProfile(value: unknown): WorkflowCustomProfile {
	const record = ownRecord(value, "custom");
	assertOnlyKeys(record, ["baseProfile", "stages"], "custom");
	const baseProfile = record.baseProfile;
	if (
		baseProfile !== "current" &&
		!WORKFLOW_BUILTIN_PROFILE_IDS.includes(
			baseProfile as WorkflowBuiltinProfileId,
		)
	) {
		throw new Error("custom.baseProfile is invalid");
	}
	const authoredStages = ownRecord(record.stages, "custom.stages");
	const stages = Object.create(null) as Record<
		string,
		WorkflowCustomStageAssignment
	>;
	for (const [id, value] of Object.entries(authoredStages)) {
		if (!id.trim())
			throw new Error("custom.stages.<empty> must be an object");
		const assignment = ownRecord(value, `custom.stages.${id}`);
		assertOnlyKeys(assignment, ["model", "thinking"], `custom.stages.${id}`);
		stages[id] = {
			model: parseInheritableModel(assignment.model, `${id}.model`),
			thinking: parseInheritableThinking(
				assignment.thinking,
				`${id}.thinking`,
			),
		};
	}
	return {
		baseProfile: baseProfile as WorkflowCustomBaseProfileId,
		stages,
	};
}

function parseInheritableModel(
	value: unknown,
	path: string,
): InheritableWorkflowProfileValue<string> {
	const record = ownRecord(value, path);
	if (record.kind === "inherit") {
		assertOnlyKeys(record, ["kind"], path);
		return { kind: "inherit" };
	}
	if (record.kind !== "fixed") throw new Error(`${path}.kind is invalid`);
	assertOnlyKeys(record, ["kind", "value"], path);
	const model = requiredString(record.value, `${path}.value`);
	const separator = model.indexOf("/");
	if (
		separator <= 0 ||
		separator === model.length - 1 ||
		model.trim() !== model ||
		/\s|[\u0000-\u001f\u007f-\u009f]/.test(model)
	) {
		throw new Error(`${path}.value must be a provider/model id`);
	}
	return { kind: "fixed", value: model };
}

function parseInheritableThinking(
	value: unknown,
	path: string,
): InheritableWorkflowProfileValue<ThinkingLevel> {
	const record = ownRecord(value, path);
	if (record.kind === "inherit") {
		assertOnlyKeys(record, ["kind"], path);
		return { kind: "inherit" };
	}
	if (record.kind !== "fixed") throw new Error(`${path}.kind is invalid`);
	assertOnlyKeys(record, ["kind", "value"], path);
	if (!THINKING_LEVELS.includes(record.value as ThinkingLevel))
		throw new Error(`${path}.value is not a supported Pi thinking level`);
	return { kind: "fixed", value: record.value as ThinkingLevel };
}

function assertOnlyKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	path: string,
): void {
	const allowedKeys = new Set(allowed);
	const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
	if (unknown.length > 0)
		throw new Error(`${path} contains unknown field ${unknown[0]}`);
}

function requiredProfileId(value: unknown): WorkflowUserProfileId {
	if (!WORKFLOW_USER_PROFILE_IDS.includes(value as WorkflowUserProfileId))
		throw new Error("selectedProfile is invalid");
	return value as WorkflowUserProfileId;
}

function requiredProfileRole(value: unknown, path: string): WorkflowProfileRole {
	if (!WORKFLOW_PROFILE_ROLES.includes(value as WorkflowProfileRole))
		throw new Error(`${path} is invalid`);
	return value as WorkflowProfileRole;
}

function requiredString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim() === "")
		throw new Error(`${path} must be a non-empty string`);
	return value;
}

function requiredHash(value: unknown, path: string): string {
	const text = requiredString(value, path);
	if (!/^[a-f0-9]{64}$/.test(text)) throw new Error(`${path} must be a sha256 hex digest`);
	return text;
}

function formatChangedList(label: string, values: readonly string[]): string | undefined {
	if (values.length === 0) return undefined;
	const shown = values.slice(0, 8).map(safeDisplayValue);
	return `${label}: ${shown.join(", ")}${values.length > shown.length ? ` (+${values.length - shown.length} more)` : ""}.`;
}

function safeDisplayValue(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "�").slice(0, 160);
}

function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.filter((key) => record[key] !== undefined)
		.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
		.join(",")}}`;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function isMissingPathError(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

function ownRecord(value: unknown, path: string): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`${path} must be an object`);
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null)
		throw new Error(`${path} must be a plain object`);
	return Object.assign(Object.create(null), value) as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
