import {
	DynamicBorder,
	type ExtensionCommandContext,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	type Component,
	type SelectItem,
	SelectList,
	Spacer,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

import type {
	WorkflowProfilePickerChoice,
	WorkflowProfilePreview,
	WorkflowProfilePreviewMenuAction,
	WorkflowProfilePreviewRow,
	WorkflowProfileUi,
} from "./workflow-profile-ui.js";

type NativeUi = ExtensionCommandContext["ui"];
type PreviewTheme = Pick<Theme, "bold" | "fg">;

const MAX_VISIBLE_CHOICES = 10;
const COLUMN_GAP = "  ";
const TABLE_SIDE_PADDING = 1;

function supportsCustomUi(ui: NativeUi): boolean {
	return Boolean(ui.custom);
}

/** Use Pi's bounded native SelectList while keeping option values out of display text. */
export async function selectWorkflowProfileTarget(
	ui: NativeUi,
	choices: readonly WorkflowProfilePickerChoice[],
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
	);
}

/** Adapt Pi's custom-component API to the profile flow's testable UI boundary. */
export function createNativeWorkflowProfileUi(ui: NativeUi): WorkflowProfileUi {
	const profileUi: WorkflowProfileUi = {
		select: (title, options) => ui.select(title, options),
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
	const safeWidth = Math.max(1, width);
	const title = [
		theme.fg("accent", theme.bold(safeLine(preview.profileName))),
		theme.fg(
			"muted",
			`  stage preview ${preview.page}/${preview.pages}`,
		),
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
			fitLine(
				theme.fg("borderMuted", ` ${"─".repeat(tableWidth)}`),
				safeWidth,
			),
		);
		for (const row of preview.rows) {
			lines.push(
				fitLine(
					` ${renderWideCells(
						[row.id, row.role, row.model, row.thinking],
						dimensions,
						[
							"syntaxFunction",
							"syntaxType",
							"syntaxString",
							thinkingColor(row.thinking),
						],
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
		(tui, theme, _keybindings, done) => {
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
						` ${theme.fg("dim", "↑↓ navigate  enter select  esc cancel")}`,
						width,
					),
				]),
			);
			container.addChild(
				new DynamicBorder((text: string) => theme.fg("borderMuted", text)),
			);
			return {
				render: (width) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data) => {
					actions.handleInput(data);
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
): Promise<string | undefined> {
	if (items.length === 0) return undefined;
	const safeItems = items.map((item) => {
		const safeItem: SelectItem = {
			value: item.value,
			label: safeLine(item.label),
		};
		if (item.description) safeItem.description = safeLine(item.description);
		return safeItem;
	});
	const selected = await ui.custom<string | null>(
		(tui, theme, _keybindings, done) => {
			const container = new Container();
			container.addChild(
				new DynamicBorder((text: string) => theme.fg("borderAccent", text)),
			);
			container.addChild(
				renderComponent((width) => renderTitle(title, theme, width)),
			);
			const list = new SelectList(
				safeItems,
				Math.min(safeItems.length, MAX_VISIBLE_CHOICES),
				selectListTheme(theme),
			);
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(null);
			container.addChild(list);
			container.addChild(
				renderComponent((width) => [
					fitLine(
						` ${theme.fg("dim", "↑↓ navigate  enter select  esc cancel")}`,
						width,
					),
				]),
			);
			container.addChild(
				new DynamicBorder((text: string) => theme.fg("borderMuted", text)),
			);
			return {
				render: (width) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data) => {
					list.handleInput(data);
					tui.requestRender();
				},
			};
		},
	);
	return selected ?? undefined;
}

function renderTitle(title: string, theme: PreviewTheme, width: number): string[] {
	return title.split(/\r?\n/).map((line, index) => {
		const text = safeLine(line);
		const styled =
			index === 0
				? theme.fg("accent", theme.bold(text))
				: theme.fg("muted", text);
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
		noMatch: (text: string) => theme.fg("warning", text),
	};
}

type TableDimensions = readonly [number, number, number, number];

function tableDimensions(
	rows: readonly WorkflowProfilePreviewRow[],
	width: number,
): TableDimensions | undefined {
	if (width < 64) return undefined;
	const stage = boundedNaturalWidth("STAGE", rows.map(({ id }) => id), 10, 22);
	const role = boundedNaturalWidth("ROLE", rows.map(({ role }) => role), 8, 20);
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
			` ${theme.fg("syntaxFunction", safeLine(row.id))} ${theme.fg("syntaxType", `[${safeLine(row.role)}]`)}`,
			width,
		),
		fitLine(
			`   ${theme.fg("syntaxString", safeLine(row.model))} ${theme.fg("dim", "·")} ${theme.fg(thinkingColor(row.thinking), safeLine(row.thinking))}`,
			width,
		),
	];
}

function thinkingColor(value: string): ThemeColor {
	const level = safeLine(value).toLowerCase().split(/[ (]/, 1)[0];
	switch (level) {
		case "off":
			return "thinkingOff";
		case "minimal":
			return "thinkingMinimal";
		case "low":
			return "thinkingLow";
		case "medium":
			return "thinkingMedium";
		case "high":
			return "thinkingHigh";
		case "xhigh":
			return "thinkingXhigh";
		case "max":
			return "thinkingMax";
		default:
			return "warning";
	}
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
