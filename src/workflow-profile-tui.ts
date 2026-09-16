import {
	DynamicBorder,
	type ExtensionCommandContext,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	type Component,
	Input,
	type KeybindingsManager,
	type SelectItem,
	SelectList,
	Spacer,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import type {
	WorkflowProfilePickerChoice,
	WorkflowProfilePreview,
	WorkflowProfilePreviewMenuAction,
	WorkflowProfilePreviewRow,
	WorkflowProfileSelectOptions,
	WorkflowProfileUi,
} from "./workflow-profile-ui.js";

type NativeUi = ExtensionCommandContext["ui"];
type PreviewTheme = Pick<Theme, "bold" | "fg">;

/** Small reusable bounded native picker for one-shot launch selection flows. */
export interface WorkflowNativePickerChoice {
	value: string;
	label: string;
	description?: string;
}

type NativeSelectOptions = WorkflowProfileSelectOptions & {
	detailsBelow?: boolean;
};

const MAX_VISIBLE_CHOICES = 10;
const MAX_PROFILE_WIDTH = 100;

function profileWidth(width: number): number {
	return Math.max(1, Math.min(width, MAX_PROFILE_WIDTH));
}
const COLUMN_GAP = "  ";
const TABLE_SIDE_PADDING = 1;

function supportsCustomUi(ui: NativeUi): boolean {
	return Boolean(ui.custom);
}

/** Use Pi's bounded native SelectList while keeping option values out of display text. */
export async function selectWorkflowProfileTarget(
	ui: NativeUi,
	choices: readonly WorkflowProfilePickerChoice[],
	selectedRef?: string,
): Promise<string | undefined> {
	if (!supportsCustomUi(ui)) {
		const fallback = choices.map((choice, index) => ({
			ref: choice.ref,
			display: `${index + 1}. ${safeLine(choice.label)} — ${safeLine(choice.description)}`,
		}));
		const selected = await ui.select(
			"Choose a workflow to configure",
			fallback.map(({ display }) => display),
		);
		return fallback.find(({ display }) => display === selected)?.ref;
	}
	return selectNativeItem(
		ui,
		"Choose a workflow to configure",
		choices.map(({ ref, label, description }) => ({
			value: ref,
			label,
			description,
		})),
		{ selected: selectedRef, cancelLabel: "cancel" },
	);
}

/** Auto routing shows names first, with selected details below and a scrollable full view. */
export async function selectWorkflowAutoChoice(
	ui: NativeUi,
	title: string,
	choices: readonly WorkflowNativePickerChoice[],
	selected?: string,
): Promise<string | undefined> {
	if (choices.length === 0) return undefined;
	if (!supportsCustomUi(ui)) {
		const options = choices.map((choice, index) => `${index + 1}. ${safeLine(choice.label)}`);
		const selectedLabel = await ui.select(title, options);
		const selectedIndex = options.findIndex((option) => option === selectedLabel);
		return selectedIndex < 0 ? undefined : choices[selectedIndex]?.value;
	}
	return selectNativeItem(
		ui,
		title,
		choices.map((choice) => ({
			value: choice.value,
			label: choice.label,
			description: choice.description,
		})),
		{
			selected,
			searchable: choices.length > MAX_VISIBLE_CHOICES,
			cancelLabel: "cancel",
			detailsBelow: true,
		},
	);
}

/** Adapt Pi's custom-component API to the profile flow's testable UI boundary. */
export function createNativeWorkflowProfileUi(ui: NativeUi): WorkflowProfileUi {
	const profileUi: WorkflowProfileUi = {
		select: (title, options, selection) =>
			supportsCustomUi(ui)
				? selectNativeItem(
						ui,
						title,
						options.map((label) => ({ value: label, label })),
						selection,
					)
				: ui.select(title, options),
		notify: (message, level) => ui.notify(message, level),
	};
	if (supportsCustomUi(ui)) {
		profileUi.preview = (preview) => selectNativeProfilePreview(ui, preview);
	}
	return profileUi;
}

/** Render the profile summary as a responsive, theme-colored stage table. */
export function renderWorkflowProfilePreview(
	preview: WorkflowProfilePreview,
	theme: PreviewTheme,
	width: number,
): string[] {
	const safeWidth = profileWidth(width);
	const title = [
		theme.fg("accent", theme.bold(safeLine(preview.profileName))),
		theme.fg("muted", `  stage preview ${preview.page}/${preview.pages}`),
	].join("");
	const lines = [fitLine(` ${title}`, safeWidth)];
	const tableWidth = Math.max(1, safeWidth - TABLE_SIDE_PADDING * 2);
	const dimensions = tableDimensions(preview.rows, tableWidth);
	if (dimensions) {
		lines.push(
			fitLine(
				` ${renderWideCells(
					["STAGE", "ROLE", "MODEL", "THINKING"],
					dimensions,
					["dim", "dim", "dim", "dim"],
					theme,
				)}`,
				safeWidth,
			),
		);
		lines.push(
			fitLine(theme.fg("borderMuted", ` ${"─".repeat(tableWidth)}`), safeWidth),
		);
		for (const row of preview.rows) {
			lines.push(
				fitLine(
					` ${renderWideCells(
						[row.id, row.role, row.model, row.thinking],
						dimensions,
						["text", "muted", "text", "muted"],
						theme,
					)}`,
					safeWidth,
				),
			);
		}
	} else {
		for (const row of preview.rows) {
			lines.push(...renderStackedRow(row, theme, safeWidth));
		}
	}
	if (preview.error) {
		lines.push(
			fitLine(
				` ${theme.fg("error", `Blocked: ${safeLine(preview.error.replace(/\s+/g, " "))}`)}`,
				safeWidth,
			),
		);
	}
	return lines;
}

async function selectNativeProfilePreview(
	ui: NativeUi,
	preview: WorkflowProfilePreview,
): Promise<WorkflowProfilePreviewMenuAction | undefined> {
	const selected = await ui.custom<WorkflowProfilePreviewMenuAction | null>(
		(tui, theme, keybindings, done) => {
			const container = new Container();
			container.addChild(
				new DynamicBorder((text: string) => theme.fg("borderAccent", text)),
			);
			container.addChild(
				renderComponent((width) =>
					renderWorkflowProfilePreview(preview, theme, width),
				),
			);
			container.addChild(new Spacer(1));
			const actions = new SelectList(
				preview.actions.map(({ id, label }) => ({ value: id, label })),
				Math.max(1, preview.actions.length),
				selectListTheme(theme),
			);
			actions.onSelect = (item) =>
				done(item.value as WorkflowProfilePreviewMenuAction);
			actions.onCancel = () => done(null);
			container.addChild(actions);
			container.addChild(
				renderComponent((width) => [
					fitLine(
						` ${theme.fg("dim", "↑↓ navigate  enter select  esc back")}`,
						width,
					),
				]),
			);
			container.addChild(
				new DynamicBorder((text: string) => theme.fg("borderMuted", text)),
			);
			return {
				render: (width) => container.render(profileWidth(width)),
				invalidate: () => container.invalidate(),
				handleInput: (data) => {
					if (keybindings.matches(data, "tui.select.cancel")) done(null);
					else actions.handleInput(data);
					tui.requestRender();
				},
			};
		},
	);
	return selected ?? undefined;
}

async function selectNativeItem(
	ui: NativeUi,
	title: string,
	items: readonly SelectItem[],
	selection: NativeSelectOptions = {},
): Promise<string | undefined> {
	if (items.length === 0) return undefined;
	const safeItems = items.map((item) => {
		const safeItem: SelectItem = {
			value: item.value,
			label: safeLine(item.label) || "(unnamed)",
		};
		if (item.description) safeItem.description = safeLine(item.description);
		return safeItem;
	});
	const selected = await ui.custom<string | null>(
		(tui, theme, keybindings, done) => {
			const picker = new ProfileChoiceList(safeItems, selection, theme);
			return {
				get focused() {
					return picker.input.focused;
				},
				set focused(value: boolean) {
					picker.input.focused = value;
				},
				render: (width) =>
					picker.render(title, profileWidth(width), tui.terminal.rows),
				invalidate: () => picker.input.invalidate(),
				handleInput: (data) => {
					if (keybindings.matches(data, "tui.select.cancel")) {
						if (!picker.closeDetails()) done(null);
					} else if (keybindings.matches(data, "tui.select.confirm")) {
						if (!picker.closeDetails()) {
							const item = picker.selectedItem();
							if (item) done(item.value);
						}
					} else picker.handleInput(data, keybindings);
					tui.requestRender();
				},
			};
		},
	);
	return selected ?? undefined;
}

/** Keep source order and selection identity independent of the visible window. */
class ProfileChoiceList {
	readonly input = new Input();
	private filtered: readonly SelectItem[];
	private index: number;
	private visibleRows = MAX_VISIBLE_CHOICES;
	private detailsOpen = false;
	private detailOffset = 0;
	private detailRows = 1;
	private detailTotal = 0;

	constructor(
		private readonly items: readonly SelectItem[],
		private readonly selection: NativeSelectOptions,
		private readonly theme: PreviewTheme,
	) {
		this.filtered = items;
		this.index = Math.max(
			0,
			items.findIndex(({ value }) => value === selection.selected),
		);
	}

	selectedItem(): SelectItem | undefined {
		return this.filtered[this.index];
	}

	closeDetails(): boolean {
		if (!this.detailsOpen) return false;
		this.detailsOpen = false;
		return true;
	}

	handleInput(data: string, keybindings: KeybindingsManager): void {
		if (this.selection.detailsBelow && data === "\t") {
			this.detailsOpen = !this.detailsOpen;
			this.detailOffset = 0;
			return;
		}
		if (this.detailsOpen) {
			let delta = 0;
			if (keybindings.matches(data, "tui.select.up")) delta = -1;
			else if (keybindings.matches(data, "tui.select.down")) delta = 1;
			else if (keybindings.matches(data, "tui.select.pageUp")) delta = -this.detailRows;
			else if (keybindings.matches(data, "tui.select.pageDown")) delta = this.detailRows;
			this.detailOffset = Math.max(0, Math.min(this.detailTotal - this.detailRows, this.detailOffset + delta));
			return;
		}
		const count = this.filtered.length;
		if (keybindings.matches(data, "tui.select.up")) {
			this.index = count ? (this.index - 1 + count) % count : 0;
		} else if (keybindings.matches(data, "tui.select.down")) {
			this.index = count ? (this.index + 1) % count : 0;
		} else if (keybindings.matches(data, "tui.select.pageUp")) {
			this.index = Math.max(0, this.index - this.visibleRows);
		} else if (keybindings.matches(data, "tui.select.pageDown")) {
			this.index = Math.max(0, Math.min(count - 1, this.index + this.visibleRows));
		} else if (this.selection.searchable) {
			const before = this.input.getValue();
			this.input.handleInput(data);
			if (before !== this.input.getValue()) this.filter();
		}
	}

	private filter(): void {
		const selected = this.selectedItem()?.value ?? this.selection.selected;
		const words = this.input.getValue().trim().toLowerCase().split(/\s+/);
		this.filtered = this.items.filter(({ label }) =>
			words.every((word) => label.toLowerCase().includes(word)),
		);
		this.index = Math.max(
			0,
			this.filtered.findIndex(({ value }) => value === selected),
		);
	}

	render(title: string, width: number, terminalRows: number): string[] {
		if (this.selection.detailsBelow) return this.renderAuto(title, width, terminalRows);
		const theme = this.theme;
		const header = renderTitle(title, theme, width);
		const search = this.selection.searchable ? this.input.render(width) : [];
		const detail = this.selection.searchable
			? wrapTextWithAnsi(
					` Selected: ${this.selectedItem()?.label ?? "No matching models"}`,
					Math.max(1, width),
				)
			: [];
		const cancel = `esc ${this.selection.cancelLabel ?? "back"}`;
		const hints = this.selection.searchable
			? wrapTextWithAnsi(
					`type to filter  ↑↓/pgup/pgdn navigate  enter select  ${cancel}`,
					Math.max(1, width - 2),
				)
			: [`↑↓ navigate  enter select  ${cancel}`];
		// Leave room for borders, count, hints and Pi's surrounding editor/footer.
		this.visibleRows = Math.max(
			1,
			Math.min(
				MAX_VISIBLE_CHOICES,
				terminalRows -
					header.length -
					search.length -
					detail.length -
					hints.length -
					8,
			),
		);
		const list = new SelectList(
			[...this.filtered],
			this.visibleRows,
			selectListTheme(theme),
		);
		list.setSelectedIndex(this.index);
		return [
			...new DynamicBorder((text) => theme.fg("borderAccent", text)).render(width),
			...header,
			...search,
			...list.render(width).map((line) => theme.fg("text", line)),
			...detail.map((line) => theme.fg("muted", line)),
			...hints.map((hint) => fitLine(` ${theme.fg("dim", hint)}`, width)),
			...new DynamicBorder((text) => theme.fg("borderMuted", text)).render(width),
		];
	}

	private renderAuto(title: string, width: number, terminalRows: number): string[] {
		const theme = this.theme;
		const innerWidth = Math.max(1, width - 2);
		const header = wrapTextWithAnsi(
			this.detailsOpen ? "Option details" : title.split(/\r?\n/).map(safeLine).join("\n"),
			innerWidth,
		);
		const search = !this.detailsOpen && this.selection.searchable ? this.input.render(width) : [];
		const hints = wrapTextWithAnsi(
			this.detailsOpen
				? "↑↓/pgup/pgdn scroll  tab/enter/esc back"
				: `${this.selection.searchable ? "type to filter  " : ""}↑↓ choose  enter next  tab details  esc cancel`,
			innerWidth,
		);
		const bodyRows = Math.max(1, terminalRows - 6 - header.length - search.length - hints.length);
		const selected = this.selectedItem();
		const details = wrapTextWithAnsi(
			selected ? `${selected.label}\n${selected.description ?? ""}` : "No matching choices",
			innerWidth,
		);
		let body: string[];
		if (this.detailsOpen) {
			this.detailTotal = details.length;
			this.detailRows = Math.max(1, bodyRows - 1);
			this.detailOffset = Math.max(0, Math.min(this.detailOffset, details.length - this.detailRows));
			body = details.slice(this.detailOffset, this.detailOffset + this.detailRows);
			body.push(`${this.detailOffset + 1}–${Math.min(details.length, this.detailOffset + this.detailRows)} / ${details.length} lines`);
		} else {
			const detailRows = Math.min(3, Math.max(0, bodyRows - 3));
			this.visibleRows = Math.max(1, Math.min(MAX_VISIBLE_CHOICES, bodyRows - detailRows - 1));
			const start = Math.max(0, Math.min(this.index - Math.floor(this.visibleRows / 2), this.filtered.length - this.visibleRows));
			body = this.filtered.slice(start, start + this.visibleRows).map((item, offset) => {
				const active = start + offset === this.index;
				return theme.fg(active ? "accent" : "text", truncateToWidth(`${active ? "→" : " "} ${item.label}`, innerWidth, "…"));
			});
			if (!body.length) body.push("No matching choices");
			body.push(`${this.filtered.length ? this.index + 1 : 0} / ${this.filtered.length}`);
			const summary = details.slice(0, detailRows);
			if (summary.length && details.length > detailRows) {
				const last = summary.length - 1;
				summary[last] = `${truncateToWidth(summary[last] ?? "", Math.max(1, innerWidth - 1), "")}…`;
			}
			body.push(...summary.map((line) => theme.fg("muted", line)));
		}
		return [
			...new DynamicBorder((text) => theme.fg("borderAccent", text)).render(width),
			...header.map((line) => ` ${theme.fg("accent", line)}`),
			...search,
			...body.map((line) => fitLine(` ${line}`, width)),
			...hints.map((line) => ` ${theme.fg("dim", line)}`),
			...new DynamicBorder((text) => theme.fg("borderMuted", text)).render(width),
		];
	}
}

function renderTitle(
	title: string,
	theme: PreviewTheme,
	width: number,
): string[] {
	return title.split(/\r?\n/).map((line, index) => {
		const text = safeLine(line);
		const styled =
			index === 0 ? theme.fg("accent", theme.bold(text)) : theme.fg("muted", text);
		return fitLine(` ${styled}`, width);
	});
}

function renderComponent(render: (width: number) => string[]): Component {
	return { render, invalidate() {} };
}

function selectListTheme(theme: PreviewTheme) {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("dim", text),
		noMatch: (_text: string) => theme.fg("warning", "  No matching choices"),
	};
}

type TableDimensions = readonly [number, number, number, number];

function tableDimensions(
	rows: readonly WorkflowProfilePreviewRow[],
	width: number,
): TableDimensions | undefined {
	if (width < 64) return undefined;
	const stage = boundedNaturalWidth(
		"STAGE",
		rows.map(({ id }) => id),
		10,
		22,
	);
	const role = boundedNaturalWidth(
		"ROLE",
		rows.map(({ role }) => role),
		8,
		20,
	);
	const thinking = boundedNaturalWidth(
		"THINKING",
		rows.map(({ thinking }) => thinking),
		8,
		18,
	);
	const model = width - stage - role - thinking - COLUMN_GAP.length * 3;
	return model >= 18 ? [stage, role, model, thinking] : undefined;
}

function boundedNaturalWidth(
	header: string,
	values: readonly string[],
	minimum: number,
	maximum: number,
): number {
	return Math.min(
		maximum,
		Math.max(
			minimum,
			visibleWidth(header),
			...values.map((value) => visibleWidth(safeLine(value))),
		),
	);
}

function renderWideCells(
	values: readonly [string, string, string, string],
	widths: TableDimensions,
	colors: readonly [ThemeColor, ThemeColor, ThemeColor, ThemeColor],
	theme: PreviewTheme,
): string {
	return values
		.map((value, index) => {
			const color = colors[index];
			const width = widths[index];
			if (color === undefined || width === undefined) return "";
			return theme.fg(color, fitCell(value, width));
		})
		.join(COLUMN_GAP);
}

function renderStackedRow(
	row: WorkflowProfilePreviewRow,
	theme: PreviewTheme,
	width: number,
): string[] {
	return [
		fitLine(
			` ${theme.fg("text", safeLine(row.id))} ${theme.fg("muted", `[${safeLine(row.role)}]`)}`,
			width,
		),
		fitLine(
			`   ${theme.fg("text", safeLine(row.model))} ${theme.fg("dim", "·")} ${theme.fg("muted", safeLine(row.thinking))}`,
			width,
		),
	];
}

function fitCell(value: string, width: number): string {
	const fitted = truncateToWidth(safeLine(value), width, "…");
	return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
}

function fitLine(value: string, width: number): string {
	return truncateToWidth(value, Math.max(1, width), "");
}

function safeLine(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "�");
}
