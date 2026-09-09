import assert from "node:assert/strict";
import { test } from "node:test";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import {
	createNativeWorkflowProfileUi,
	selectWorkflowProfileTarget,
} from "../../.tmp/unit/workflow-profile-tui.js";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const ENTER = "\r";
const ESC = "\x1b";
const LUNA = "openai-codex/gpt-5.6-luna";
const MODELS = [
	"Inherit current Pi model at run start",
	...Array.from({ length: 118 }, (_, index) => `catalog/model-${String(index).padStart(3, "0")}`),
	LUNA,
];

function harness(bindings = {}) {
	const colors = [];
	const theme = {
		bold: (text) => text,
		fg: (color, text) => { colors.push(color); return text; },
	};
	const state = { terminal: { rows: 24 }, renders: 0, completions: [] };
	const ui = {
		select: () => assert.fail("native adapter must not use the unbounded text selector"),
		notify() {},
		custom(factory) {
			return new Promise((resolve) => {
				state.component = factory(
					{ terminal: state.terminal, requestRender: () => state.renders++ },
					theme,
					new KeybindingsManager(TUI_KEYBINDINGS, bindings),
					(value) => { state.completions.push(value); resolve(value); },
				);
				state.component.focused = true;
			});
		},
	};
	return { ui, state, colors, profileUi: createNativeWorkflowProfileUi(ui) };
}

function frame(state, width = 82) {
	const lines = state.component.render(width);
	assert.ok(lines.every((line) => visibleWidth(line) <= width), "all rows fit terminal width");
	assert.ok(lines.length <= state.terminal.rows - 4, "selector leaves room for Pi chrome");
	return lines;
}

function pointed(lines) {
	return lines.find((line) => line.startsWith("→ "));
}

test("native profile selector keeps order and focuses the saved choice", async () => {
	const { profileUi, state, colors } = harness();
	const choices = ["Codex", "Codex High", "Claude", "Mixed", "Custom (saved)"];
	const result = profileUi.select("Workflow execution profile\nDefinition-specific setting", choices, {
		selected: choices[4],
	});
	const lines = frame(state);
	assert.deepEqual(lines.filter((line) => /^  |^→ /.test(line)).map((line) => line.slice(2)), choices);
	assert.equal(pointed(lines), "→ Custom (saved)");
	assert.ok(colors.includes("accent"));
	assert.ok(colors.includes("text"));
	assert.ok(colors.every((color) => !/^(syntax|thinking)/.test(color)));
	state.component.handleInput(ENTER);
	assert.equal(await result, choices[4]);
});

test("120-model selector keeps focus visible on open, navigation, wrap and resize", async () => {
	const { profileUi, state } = harness();
	const result = profileUi.select("Choose model\nCurrent setting: " + LUNA + "\nCurrent Pi: other/model", MODELS, {
		selected: LUNA, searchable: true,
	});
	let lines = frame(state);
	assert.equal(pointed(lines), `→ ${LUNA}`);
	assert.match(lines.join("\n"), /Selected: openai-codex\/gpt-5\.6-luna/);
	assert.match(lines.join("\n"), /\(120\/120\)/);
	assert.ok(lines.filter((line) => /catalog\/model/.test(line)).length <= 9);
	state.component.handleInput(DOWN);
	assert.match(pointed(frame(state)), /Inherit current Pi model/);
	state.component.handleInput(UP);
	state.component.handleInput(PAGE_UP);
	assert.match(pointed(frame(state)), /catalog\/model-108/);
	state.component.handleInput(PAGE_DOWN);
	state.terminal.rows = 16;
	lines = frame(state, 48);
	assert.match(lines.join("\n"), /esc cancel/);
	assert.equal(pointed(lines), `→ ${LUNA}`);
	assert.match(lines.join("\n"), /Selected: openai-codex\/gpt-5\.6-luna/);
	state.component.handleInput(ENTER);
	assert.equal(await result, LUNA);
});

test("model search matches provider and model tokens, handles no matches and preserves exact IDs", async () => {
	const { profileUi, state } = harness();
	const result = profileUi.select("Choose model", MODELS, { searchable: true });
	frame(state);
	state.component.handleInput("\x1b[200~CODEX luna\x1b[201~");
	assert.equal(pointed(frame(state)), `→ ${LUNA}`);
	state.component.handleInput("absent");
	assert.equal(pointed(frame(state)), undefined);
	state.component.handleInput(ENTER);
	assert.deepEqual(state.completions, []);
	assert.match(frame(state).join("\n"), /No matching models/);
	state.component.handleInput("\x15"); // Input's configured delete-to-line-start (Ctrl+U).
	assert.ok(pointed(frame(state)));
	state.component.handleInput("luna");
	assert.equal(pointed(frame(state)), `→ ${LUNA}`);
	state.component.handleInput(ENTER);
	assert.equal(await result, LUNA);
});

test("long model IDs wrap in the selected detail instead of disappearing beyond the list", async () => {
	const { profileUi, state } = harness();
	const longModel = "provider/" + "long-model-".repeat(7) + "끝-model";
	const result = profileUi.select("Choose model", [...MODELS, longModel], {
		selected: longModel, searchable: true,
	});
	const lines = frame(state, 48);
	const detailStart = lines.findIndex((line) => line.startsWith(" Selected:"));
	const detailEnd = lines.findIndex((line) => line.includes("type to filter"));
	assert.ok(detailStart > 0 && detailEnd > detailStart);
	assert.equal(lines.slice(detailStart, detailEnd).join("").replace(/^\s*Selected:\s*/, ""), longModel);
	state.component.handleInput(ESC);
	assert.equal(await result, undefined);
});

test("picker respects injected navigation bindings and cancel does not select", async () => {
	const { profileUi, state } = harness({ "tui.select.down": "ctrl+n", "tui.select.cancel": "ctrl+q" });
	const result = profileUi.select("Choose model", MODELS, { selected: LUNA, searchable: true });
	frame(state);
	state.component.handleInput("\x0e");
	assert.match(pointed(frame(state)), /Inherit/);
	state.component.handleInput("\x11");
	assert.equal(await result, undefined);
	assert.deepEqual(state.completions, [null]);
});

test("native workflow choices never render hidden path identities", async () => {
	const { ui, state } = harness();
	const result = selectWorkflowProfileTarget(ui, [
		{ ref: "/private/first/spec.json", label: "same name", description: "Current: Codex" },
		{ ref: "/private/second/spec.json", label: "same name", description: "Current: Custom" },
		{ ref: "/private/empty/spec.json", label: "", description: "Current: Unavailable" },
	]);
	for (const width of [48, 100]) assert.doesNotMatch(frame(state, width).join("\n"), /private|spec\.json/);
	state.component.handleInput(DOWN);
	state.component.handleInput(ENTER);
	assert.equal(await result, "/private/second/spec.json");
});

test("native preview actions share picker colors and preserve cancel and save identity", async () => {
	const { profileUi, state, colors } = harness();
	const preview = {
		profileName: "Custom", page: 1, pages: 1,
		rows: [{ id: "plan", role: "planning", model: LUNA, thinking: "xhigh" }],
		actions: [{ id: "save", label: "Save for next run" }, { id: "back", label: "Back to profiles" }],
	};
	const cancelled = profileUi.preview(preview);
	frame(state, 100);
	assert.ok(colors.includes("text"));
	assert.ok(colors.includes("muted"));
	assert.ok(colors.every((color) => !/^(syntax|thinking)/.test(color)));
	state.component.handleInput(ESC);
	assert.equal(await cancelled, undefined);
	const saved = profileUi.preview(preview);
	state.component.handleInput(ENTER);
	assert.equal(await saved, "save");
});

test("compatibility adapter retains the ordinary select flow without a native preview", async () => {
	const calls = [];
	const profileUi = createNativeWorkflowProfileUi({
		select: async (title, options) => { calls.push({ title, options }); return options[1]; },
		notify() {},
	});
	assert.equal(profileUi.preview, undefined);
	const choices = ["Codex", "Codex High", "Claude", "Mixed", "Custom"];
	assert.equal(await profileUi.select("Profiles", choices, { selected: "Custom" }), "Codex High");
	assert.deepEqual(calls, [{ title: "Profiles", options: choices }]);
});
