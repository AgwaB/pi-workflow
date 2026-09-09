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
	workflowUserProfileLabel,
	type InheritableWorkflowProfileValue,
	type WorkflowBuiltinProfileId,
	type WorkflowCustomProfile,
	type WorkflowCustomStageAssignment,
	type WorkflowProfileContext,
	type WorkflowProfilePreference,
	type WorkflowUserProfileId,
} from "./workflow-profile-settings.js";

export type WorkflowProfilePreviewMenuAction =
	| "save"
	| "edit"
	| "next"
	| "previous"
	| "back";

export interface WorkflowProfilePreviewRow {
	id: string;
	role: string;
	model: string;
	thinking: string;
}

export interface WorkflowProfilePreview {
	profileName: string;
	page: number;
	pages: number;
	rows: readonly WorkflowProfilePreviewRow[];
	error?: string;
	actions: ReadonlyArray<{
		id: WorkflowProfilePreviewMenuAction;
		label: string;
	}>;
}

export interface WorkflowProfileSelectOptions {
	selected?: string;
	searchable?: boolean;
	cancelLabel?: "back" | "cancel";
}

export interface WorkflowProfileUi {
	select(
		title: string,
		options: string[],
		selection?: WorkflowProfileSelectOptions,
	): Promise<string | undefined>;
	preview?(
		preview: WorkflowProfilePreview,
	): Promise<WorkflowProfilePreviewMenuAction | undefined>;
	notify?(message: string, level?: "info" | "warning" | "error"): void;
}

export interface WorkflowProfilePickerWorkflow {
	name: string;
	specPath: string;
}

export interface WorkflowProfilePickerChoice {
	ref: string;
	label: string;
	description: string;
}

export interface ConfigureWorkflowProfileInput {
	ui: WorkflowProfileUi;
	spec: ArtifactGraphWorkflowSpec;
	specPath: string;
	workflowLabel?: string;
	backToWorkflows?: boolean;
	availableModels: readonly WorkflowModelInfo[];
	currentRuntime: WorkflowRuntimeDefaults;
}

export type ConfigureWorkflowProfileResult =
	| { status: "cancelled" }
	| { status: "saved"; preference: WorkflowProfilePreference };

type PreviewAction = "save" | "edit" | "back";

const PREVIEW_PAGE_ROWS = 6;
const INHERIT_MODEL_LABEL = "Inherit current Pi model at run start";
const INHERIT_THINKING_LABEL = "Inherit current Pi thinking at run start";
const EDIT_MODEL = "Model only";
const EDIT_THINKING = "Thinking only";
const EDIT_BOTH = "Model and thinking";

/** Build path-free workflow choices while preserving the path as hidden identity. */
export async function buildWorkflowProfilePickerChoices(
	workflows: readonly WorkflowProfilePickerWorkflow[],
	loadWorkflow: (
		specPath: string,
	) => Promise<{ spec: ArtifactGraphWorkflowSpec; specPath: string }>,
): Promise<WorkflowProfilePickerChoice[]> {
	const choices: WorkflowProfilePickerChoice[] = [];
	for (const workflow of workflows) {
		let current = "Unavailable";
		try {
			const loadedWorkflow = await loadWorkflow(workflow.specPath);
			const loadedPreference = await loadWorkflowProfilePreference(
				loadedWorkflow.spec,
				loadedWorkflow.specPath,
			);
			if (loadedPreference.preference) {
				current = workflowUserProfileLabel(
					loadedPreference.preference.selectedProfile,
				);
			} else if (loadedPreference.stalePreference) {
				current = `Not configured (outdated ${workflowUserProfileLabel(loadedPreference.stalePreference.selectedProfile)} saved)`;
			} else {
				current = "Not configured";
			}
		} catch {
			// Keep browsing available. Selecting this workflow reruns strict loading
			// and surfaces the original validation or settings error.
		}
		choices.push({
			ref: workflow.specPath,
			label: workflow.name,
			description: `Current: ${current}`,
		});
	}
	return choices;
}

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
		const labels = profileLabels(context, previous?.selectedProfile);
		const selectedLabel = await input.ui.select(
			[
				`Workflow execution profile — ${clip(input.workflowLabel ?? input.spec.name ?? "workflow", 68)}`,
				"Selection is saved for this workflow definition across projects.",
			].join("\n"),
			labels.map(({ label }) => label),
			{
				selected: labels.find(({ id }) => id === selectedProfile)?.label,
				cancelLabel: input.backToWorkflows ? "back" : "cancel",
			},
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
): Array<{ id: WorkflowUserProfileId; label: string }> {
	return [
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
	rows: readonly WorkflowProfilePreviewRow[],
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
		const actions: WorkflowProfilePreview["actions"] = [
			...(error ? [] : [{ id: "save" as const, label: "Save for next run" }]),
			...(editable
				? [{ id: "edit" as const, label: "Edit a stage…" }]
				: []),
			...(pages > 1
				? [
						{ id: "next" as const, label: "Next preview page" },
						{ id: "previous" as const, label: "Previous preview page" },
					]
				: []),
			{ id: "back" as const, label: "Back to profiles" },
		];
		let selectedAction: WorkflowProfilePreviewMenuAction | undefined;
		if (ui.preview) {
			const preview: WorkflowProfilePreview = {
				profileName,
				page: page + 1,
				pages,
				rows: pageRows,
				actions,
			};
			if (error) preview.error = error;
			selectedAction = await ui.preview(preview);
			if (
				selectedAction !== undefined &&
				!actions.some(({ id }) => id === selectedAction)
			) {
				throw new Error(`Unknown workflow profile preview action: ${selectedAction}`);
			}
		} else {
			const title = [
				`${profileName} — stage preview (${page + 1}/${pages})`,
				...pageRows.map(
					(row) =>
						`${clip(row.id, 42)} [${row.role}]\n  ${clip(row.model, 68)} · ${row.thinking}`,
				),
				...(error
					? [`Blocked: ${clip(error.replace(/\s+/g, " "), 180)}`]
					: []),
			].join("\n");
			const selected = await ui.select(
				title,
				actions.map(({ label }) => label),
			);
			selectedAction = actions.find(({ label }) => label === selected)?.id;
		}
		if (selectedAction === undefined) return "back";
		if (selectedAction === "save") return "save";
		if (selectedAction === "edit") return "edit";
		if (selectedAction === "back") return "back";
		if (selectedAction === "next") page = (page + 1) % pages;
		if (selectedAction === "previous") page = (page - 1 + pages) % pages;
	}
}

function builtinPreviewRows(
	slots: readonly WorkflowProfileStageSlot[],
	profileId: WorkflowBuiltinProfileId,
): WorkflowProfilePreviewRow[] {
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
): WorkflowProfilePreviewRow[] {
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
	while (true) {
		const stageLabel = await ui.select(
			"Choose a Custom stage to edit",
			choices.map(({ label }) => label),
			{ selected: choices.find(({ id }) => id === focus.stageId)?.label },
		);
		if (stageLabel === undefined) return custom;
		const slot = choices.find(({ label }) => label === stageLabel);
		if (!slot) return custom;
		focus.stageId = slot.id;
		const assignment = await editStageAssignment(ui, context, slot.id, custom.stages[slot.id]!);
		if (assignment) {
			return { ...custom, stages: { ...custom.stages, [slot.id]: assignment } };
		}
	}
}

async function editStageAssignment(
	ui: WorkflowProfileUi,
	context: WorkflowProfileContext,
	stageId: string,
	previous: WorkflowCustomStageAssignment,
): Promise<WorkflowCustomStageAssignment | undefined> {
	let field: string | undefined;
	while (true) {
		field = await ui.select(
			`Edit ${stageId}\nCurrent: ${formatAssignment(previous)}`,
			[EDIT_MODEL, EDIT_THINKING, EDIT_BOTH],
			{ selected: field },
		);
		if (field === undefined) return undefined;
		const assignment = await selectStageAssignment(ui, context, previous, field);
		if (assignment) return assignment;
	}
}

async function selectStageAssignment(
	ui: WorkflowProfileUi,
	context: WorkflowProfileContext,
	previous: WorkflowCustomStageAssignment,
	field: string,
): Promise<WorkflowCustomStageAssignment | undefined> {
	let model = previous.model;
	while (true) {
		if (field === EDIT_MODEL || field === EDIT_BOTH) {
			const selected = await selectModel(ui, context, model);
			if (!selected) return undefined;
			model = selected;
		}
		if (field === EDIT_MODEL) return { model, thinking: previous.thinking };
		const thinking = await selectThinking(ui, context, model, previous.thinking);
		if (thinking) return { model, thinking };
		if (field !== EDIT_BOTH) return undefined;
		// In the combined editor, thinking's Back revisits the model draft.
	}
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
	const selected = await ui.select(
		`Choose model\nCurrent setting: ${current.kind === "fixed" ? current.value : "Pi model at run start"}\nCurrent Pi: ${context.currentRuntime.model ?? "unavailable"}`,
		choices.map(({ label }) => label),
		{ selected: currentChoiceLabel(choices), searchable: true },
	);
	return choices.find(({ label }) => label === selected)?.value;
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
	const selected = await ui.select(
		`Choose thinking for ${modelId ?? "unavailable model"}\nCurrent setting: ${current.kind === "fixed" ? current.value : "Pi thinking at run start"}\nCurrent Pi: ${context.currentRuntime.thinking ?? "unavailable"}`,
		choices.map(({ label }) => label),
		{ selected: currentChoiceLabel(choices) },
	);
	return choices.find(({ label }) => label === selected)?.value;
}

function currentChoiceLabel(choices: readonly { label: string }[]): string | undefined {
	return choices.find(({ label }) => label.endsWith(" (current setting)"))?.label;
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
