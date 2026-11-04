import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

type ViewerTheme = { bold?: (text: string) => string; fg?: (color: string, text: string) => string };
type ViewerTui = { requestRender(force?: boolean): void; terminal?: { rows?: number } };

/**
 * A read-only text viewer that opens at the top and scrolls. Used for long
 * Goal details so the reader starts with the plain-language part. Hosts
 * without custom components fall back to Pi's editor.
 */
export async function showGoalTextViewer(ctx: ExtensionContext, title: string, text: string): Promise<void> {
	if (typeof ctx.ui.custom !== "function") {
		await ctx.ui.editor(title, text);
		return;
	}
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
		new GoalTextViewer(tui as ViewerTui, theme as ViewerTheme, title, text, () => done(undefined)));
}

export class GoalTextViewer {
	private offset = 0;
	private width = 0;
	private lines: string[] = [];

	constructor(
		private readonly tui: ViewerTui,
		private readonly theme: ViewerTheme,
		readonly title: string,
		readonly text: string,
		private readonly close: () => void,
	) {}

	/** Rows available for text: the terminal less the title, footer and Pi's chrome. */
	private page(): number {
		const rows = this.tui.terminal?.rows ?? process.stdout.rows ?? 40;
		return Math.max(5, rows - 8);
	}

	private layout(width: number): void {
		if (width === this.width) return;
		this.width = width;
		this.lines = this.text.split("\n").flatMap((line) =>
			line ? wrapTextWithAnsi(line, Math.max(10, width - 2)) : [""]);
	}

	render(width: number): string[] {
		this.layout(width);
		const page = this.page();
		const last = Math.max(0, this.lines.length - page);
		this.offset = Math.min(Math.max(0, this.offset), last);
		const bold = this.theme.bold ?? ((value: string) => value);
		const dim = (value: string) => this.theme.fg?.("muted", value) ?? value;
		const shown = this.lines.slice(this.offset, this.offset + page);
		const end = this.offset + shown.length;
		const position = this.lines.length > page ? ` · lines ${this.offset + 1}-${end} of ${this.lines.length}` : "";
		const hint = "↑↓ PgUp PgDn Home End scroll · Esc/Enter close";
		const footer = `${hint}${position}`;
		return [
			truncateToWidth(bold(this.title), width),
			"",
			...shown.map((line) => truncateToWidth(` ${line}`, width)),
			"",
			truncateToWidth(dim(visibleWidth(footer) > width ? hint : footer), width),
		];
	}

	handleInput(data: string): void {
		const page = this.page();
		if (matchesKey(data, "escape") || matchesKey(data, "enter") || data === "q") {
			this.close();
			return;
		}
		if (matchesKey(data, "up") || data === "k") this.offset -= 1;
		else if (matchesKey(data, "down") || data === "j") this.offset += 1;
		else if (matchesKey(data, "pageUp") || data === "b") this.offset -= page;
		else if (matchesKey(data, "pageDown") || data === " ") this.offset += page;
		else if (matchesKey(data, "home") || data === "g") this.offset = 0;
		else if (matchesKey(data, "end") || data === "G") this.offset = Number.MAX_SAFE_INTEGER;
		else return;
		this.tui.requestRender();
	}

	invalidate(): void {
		this.width = 0;
	}
}
