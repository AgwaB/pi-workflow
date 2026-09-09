import {
	collectWorkflowProfileStageSlots,
	type WorkflowProfileStageSlot,
} from "./execution-profile.js";
import type {
	ArtifactGraphWorkflowSpec,
	ThinkingLevel,
} from "./types.js";
import {
	getSupportedThinkingLevels,
	type WorkflowModelInfo,
	type WorkflowRuntimeDefaults,
} from "./workflow-runtime.js";
import {
	WORKFLOW_BUILTIN_PROFILE_IDS,
	buildWorkflowExecutionProfile,
	createCustomProfileFromBuiltin,
	createInheritedCustomProfile,
	effectiveCustomStageAssignment,
	formatStaleWorkflowProfileError,
	loadWorkflowProfilePreference,
	profileRuntimeForRole,
	saveWorkflowProfilePreference,
	workflowBuiltinProfileLabel,
	type InheritableWorkflowProfileValue,
	type WorkflowBuiltinProfileId,
	type WorkflowCustomProfile,
	type WorkflowCustomStageAssignment,
	type WorkflowProfileContext,
	type WorkflowProfilePreference,
	type WorkflowUserProfileId,
} from "./workflow-profile-settings.js";

export interface WorkflowProfileUi {
	select(title: string, options: string[]): Promise<string | undefined>;
	notify?(message: string, level?: "info" | "warning" | "error"): void;
}

export interface ConfigureWorkflowProfileInput {
	ui: WorkflowProfileUi;
	spec: ArtifactGraphWorkflowSpec;
	specPath: string;
	workflowLabel?: string;
	availableModels: readonly WorkflowModelInfo[];
	currentRuntime: WorkflowRuntimeDefaults;
}

export type ConfigureWorkflowProfileResult =
	| { status: "cancelled" }
	| { status: "saved"; preference: WorkflowProfilePreference };

type PreviewAction = "save" | "edit" | "back" | "cancelled";
type ProfilePreviewRow = {
	id: string;
	role: string;
	model: string;
	thinking: string;
};

const PREVIEW_PAGE_ROWS = 6;
const INHERIT_MODEL_LABEL = "Inherit current Pi model at run start";
const INHERIT_THINKING_LABEL = "Inherit current Pi thinking at run start";
const EDIT_MODEL = "Model only";
const EDIT_THINKING = "Thinking only";
const EDIT_BOTH = "Model and thinking";

/**
 * Native Pi selection flow for one workflow's durable user profile. Merely
 * opening/browsing this flow never writes settings or starts a workflow/model.
 */
export async function configureWorkflowExecutionProfile(
	input: ConfigureWorkflowProfileInput,
): Promise<ConfigureWorkflowProfileResult> {
	const slots = collectWorkflowProfileStageSlots(input.spec);
	// This also emits the actionable missing-role error before opening a partial UI.
	createInheritedCustomProfile(input.spec);
	if (slots.length === 0)
		throw new Error("This workflow has no model-backed stages to configure.");

	const context: WorkflowProfileContext = {
		spec: input.spec,
		specPath: input.specPath,
		availableModels: input.availableModels,
		currentRuntime: input.currentRuntime,
	};
	const loaded = await loadWorkflowProfilePreference(input.spec, input.specPath);
	if (loaded.stalePreference) {
		input.ui.notify?.(
			formatStaleWorkflowProfileError(loaded.stalePreference, input.spec),
			"warning",
		);
	}
	const previous = loaded.preference;
	let custom = previous?.custom;
	let selectedProfile: WorkflowUserProfileId =
		previous?.selectedProfile ?? firstUsableProfile(context);
	let customSeed: WorkflowBuiltinProfileId =
		selectedProfile === "custom" ? "codex" : selectedProfile;
	const customFocus: { stageId?: string } = {};

	while (true) {
		const labels = profileLabels(
			context,
			previous?.selectedProfile,
			selectedProfile,
		);
		const selectedLabel = await input.ui.select(
			[
				`Workflow execution profile — ${clip(input.workflowLabel ?? input.spec.name ?? "workflow", 68)}`,
				"Selection is saved for this workflow definition across projects.",
			].join("\n"),
			labels.map(({ label }) => label),
		);
		if (selectedLabel === undefined) return { status: "cancelled" };
		const selected = labels.find(({ label }) => label === selectedLabel);
		if (!selected) throw new Error(`Unknown workflow profile choice: ${selectedLabel}`);
		selectedProfile = selected.id;

		if (selectedProfile !== "custom") {
			customSeed = selectedProfile;
			const built = tryBuildProfile(context, selectedProfile);
			const action = await selectPreviewAction(
				input.ui,
				workflowBuiltinProfileLabel(selectedProfile),
				builtinPreviewRows(slots, selectedProfile),
				built.error,
				false,
			);
			if (action === "cancelled") return { status: "cancelled" };
			if (action !== "save") continue;
			if (built.error) continue;
			const preference = await saveWorkflowProfilePreference(context, {
				selectedProfile,
			});
			input.ui.notify?.(
				`${workflowBuiltinProfileLabel(selectedProfile)} saved for ${clip(preference.workflowName, 68)}.`,
				"info",
			);
			return { status: "saved", preference };
		}

		custom ??= createInitialCustomProfile(context, customSeed);
		while (true) {
			const built = tryBuildProfile(context, "custom", custom);
			const action = await selectPreviewAction(
				input.ui,
				"Custom",
				customPreviewRows(slots, custom, input.currentRuntime),
				built.error,
				true,
			);
			if (action === "cancelled") return { status: "cancelled" };
			if (action === "back") break;
			if (action === "edit") {
				custom = await editCustomStage(
					input.ui,
					context,
					slots,
					custom,
					customFocus,
				);
				continue;
			}
			if (built.error) continue;
			const preference = await saveWorkflowProfilePreference(context, {
				selectedProfile: "custom",
				custom,
			});
			input.ui.notify?.(
				`Custom saved for ${clip(preference.workflowName, 68)}. Inherited values will be captured when each new run starts.`,
				"info",
			);
			return { status: "saved", preference };
		}
	}
}

function firstUsableProfile(context: WorkflowProfileContext): WorkflowUserProfileId {
	for (const profileId of WORKFLOW_BUILTIN_PROFILE_IDS) {
		if (!tryBuildProfile(context, profileId).error) return profileId;
	}
	return "custom";
}

function profileLabels(
	context: WorkflowProfileContext,
	saved: WorkflowUserProfileId | undefined,
	focused: WorkflowUserProfileId,
): Array<{ id: WorkflowUserProfileId; label: string }> {
	const labels = [
		...WORKFLOW_BUILTIN_PROFILE_IDS.map((id) => {
			const error = tryBuildProfile(context, id).error;
			return {
				id,
				label: `${workflowBuiltinProfileLabel(id)}${saved === id ? " (saved)" : ""}${error ? " — unavailable" : ""}`,
			};
		}),
		{
			id: "custom" as const,
			label: `Custom${saved === "custom" ? " (saved)" : ""}`,
		},
	];
	const focusedIndex = labels.findIndex(({ id }) => id === focused);
	return focusedIndex <= 0
		? labels
		: [...labels.slice(focusedIndex), ...labels.slice(0, focusedIndex)];
}

function tryBuildProfile(
	context: WorkflowProfileContext,
	profileId: WorkflowUserProfileId,
	custom?: WorkflowCustomProfile,
): { error?: string } {
	try {
		buildWorkflowExecutionProfile(context, profileId, custom);
		return {};
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

async function selectPreviewAction(
	ui: WorkflowProfileUi,
	profileName: string,
	rows: readonly ProfilePreviewRow[],
	error: string | undefined,
	editable: boolean,
): Promise<PreviewAction> {
	let page = 0;
	const pages = Math.max(1, Math.ceil(rows.length / PREVIEW_PAGE_ROWS));
	while (true) {
		const pageRows = rows.slice(
			page * PREVIEW_PAGE_ROWS,
			(page + 1) * PREVIEW_PAGE_ROWS,
		);
		const title = [
			`${profileName} — stage preview (${page + 1}/${pages})`,
			...pageRows.map(
				(row) =>
					`${clip(row.id, 42)} [${row.role}]\n  ${clip(row.model, 68)} · ${row.thinking}`,
			),
			...(error ? [`Blocked: ${clip(error.replace(/\s+/g, " "), 180)}`] : []),
		].join("\n");
		const actions = [
			...(error ? [] : ["Save for next run"]),
			...(editable ? ["Edit a stage…"] : []),
			...(pages > 1 ? ["Next preview page", "Previous preview page"] : []),
			"Back to profiles",
		];
		const selected = await ui.select(title, actions);
		if (selected === undefined) return "cancelled";
		if (selected === "Save for next run") return "save";
		if (selected === "Edit a stage…") return "edit";
		if (selected === "Back to profiles") return "back";
		if (selected === "Next preview page") page = (page + 1) % pages;
		if (selected === "Previous preview page") page = (page - 1 + pages) % pages;
	}
}

function builtinPreviewRows(
	slots: readonly WorkflowProfileStageSlot[],
	profileId: WorkflowBuiltinProfileId,
): ProfilePreviewRow[] {
	return slots.map((slot) => {
		const runtime = profileRuntimeForRole(profileId, slot.profileRole!);
		return {
			id: slot.id,
			role: slot.profileRole!,
			model: runtime.model,
			thinking: runtime.thinking,
		};
	});
}

function customPreviewRows(
	slots: readonly WorkflowProfileStageSlot[],
	custom: WorkflowCustomProfile,
	currentRuntime: WorkflowRuntimeDefaults,
): ProfilePreviewRow[] {
	return slots.map((slot) => {
		const assignment = custom.stages[slot.id]!;
		let effective: { model: string; thinking: ThinkingLevel } | undefined;
		try {
			effective = effectiveCustomStageAssignment(assignment, currentRuntime);
		} catch {
			effective = undefined;
		}
		return {
			id: slot.id,
			role: slot.profileRole!,
			model:
				assignment.model.kind === "inherit"
					? `${effective?.model ?? "unavailable"} (Pi at run start)`
					: assignment.model.value,
			thinking:
				assignment.thinking.kind === "inherit"
					? `${effective?.thinking ?? "unavailable"} (Pi at run start)`
					: assignment.thinking.value,
		};
	});
}

function createInitialCustomProfile(
	context: WorkflowProfileContext,
	seed: WorkflowBuiltinProfileId,
): WorkflowCustomProfile {
	return createCustomProfileFromBuiltin(context.spec, seed);
}

async function editCustomStage(
	ui: WorkflowProfileUi,
	context: WorkflowProfileContext,
	slots: readonly WorkflowProfileStageSlot[],
	custom: WorkflowCustomProfile,
	focus: { stageId?: string },
): Promise<WorkflowCustomProfile> {
	const choices = slots.map((slot) => ({
		id: slot.id,
		label: `${slot.id} — ${slot.profileRole}`,
	}));
	const focusedIndex = choices.findIndex(({ id }) => id === focus.stageId);
	const stageChoices =
		focusedIndex <= 0
			? choices
			: [...choices.slice(focusedIndex), ...choices.slice(0, focusedIndex)];
	const stageLabel = await ui.select(
		"Choose a Custom stage to edit",
		stageChoices.map(({ label }) => label),
	);
	if (stageLabel === undefined) return custom;
	const slot = stageChoices.find(({ label }) => label === stageLabel);
	if (!slot) return custom;
	focus.stageId = slot.id;
	const previous = custom.stages[slot.id]!;
	const field = await ui.select(
		`Edit ${slot.id}\nCurrent: ${formatAssignment(previous)}`,
		[EDIT_MODEL, EDIT_THINKING, EDIT_BOTH],
	);
	if (field === undefined) return custom;

	let model = previous.model;
	let thinking = previous.thinking;
	if (field === EDIT_MODEL || field === EDIT_BOTH) {
		const selectedModel = await selectModel(ui, context, model);
		if (!selectedModel) return custom;
		model = selectedModel;
	}
	if (field === EDIT_THINKING || field === EDIT_BOTH) {
		const selectedThinking = await selectThinking(ui, context, model, thinking);
		if (!selectedThinking) return custom;
		thinking = selectedThinking;
	}
	return {
		...custom,
		stages: {
			...custom.stages,
			[slot.id]: { model, thinking },
		},
	};
}

async function selectModel(
	ui: WorkflowProfileUi,
	context: WorkflowProfileContext,
	current: InheritableWorkflowProfileValue<string>,
): Promise<InheritableWorkflowProfileValue<string> | undefined> {
	const fixed = [...context.availableModels]
		.map(({ fullId }) => fullId)
		.sort((left, right) => left.localeCompare(right));
	const choices = [
		{
			label: `${INHERIT_MODEL_LABEL}${current.kind === "inherit" ? " (current setting)" : ""}`,
			value: { kind: "inherit" } as const,
		},
		...fixed.map((model) => ({
			label: `${model}${current.kind === "fixed" && current.value === model ? " (current setting)" : ""}`,
			value: { kind: "fixed", value: model } as const,
		})),
	];
	const ordered = focusCurrentChoice(choices);
	const selected = await ui.select(
		`Choose model\nCurrent Pi: ${context.currentRuntime.model ?? "unavailable"}`,
		ordered.map(({ label }) => label),
	);
	return ordered.find(({ label }) => label === selected)?.value;
}

async function selectThinking(
	ui: WorkflowProfileUi,
	context: WorkflowProfileContext,
	model: InheritableWorkflowProfileValue<string>,
	current: InheritableWorkflowProfileValue<ThinkingLevel>,
): Promise<InheritableWorkflowProfileValue<ThinkingLevel> | undefined> {
	const modelId =
		model.kind === "fixed" ? model.value : context.currentRuntime.model;
	const modelInfo = context.availableModels.find(({ fullId }) => fullId === modelId);
	const supported = getSupportedThinkingLevels(modelInfo);
	const choices = [
		{
			label: `${INHERIT_THINKING_LABEL}${current.kind === "inherit" ? " (current setting)" : ""}`,
			value: { kind: "inherit" } as const,
		},
		...supported.map((thinking) => ({
			label: `${thinking}${current.kind === "fixed" && current.value === thinking ? " (current setting)" : ""}`,
			value: { kind: "fixed", value: thinking } as const,
		})),
	];
	const ordered = focusCurrentChoice(choices);
	const selected = await ui.select(
		`Choose thinking for ${modelId ?? "unavailable model"}\nCurrent Pi: ${context.currentRuntime.thinking ?? "unavailable"}`,
		ordered.map(({ label }) => label),
	);
	return ordered.find(({ label }) => label === selected)?.value;
}

function focusCurrentChoice<T extends { label: string }>(choices: T[]): T[] {
	const currentIndex = choices.findIndex(({ label }) =>
		label.endsWith(" (current setting)"),
	);
	return currentIndex <= 0
		? choices
		: [...choices.slice(currentIndex), ...choices.slice(0, currentIndex)];
}

function formatAssignment(assignment: WorkflowCustomStageAssignment): string {
	const model =
		assignment.model.kind === "inherit"
			? "Pi model at run start"
			: assignment.model.value;
	const thinking =
		assignment.thinking.kind === "inherit"
			? "Pi thinking at run start"
			: assignment.thinking.value;
	return `${model} · ${thinking}`;
}

function clip(value: string, maxCharacters: number): string {
	const safe = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "�");
	const characters = Array.from(safe);
	return characters.length <= maxCharacters
		? safe
		: `${characters.slice(0, Math.max(1, maxCharacters - 1)).join("")}…`;
}
