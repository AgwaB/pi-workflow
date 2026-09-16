import assert from "node:assert/strict";
import { test } from "node:test";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	createNativeWorkflowProfileUi,
	selectWorkflowAutoChoice,
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
	assert.match(lines.join("\n"), /esc back/);
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

test("all native profile screens share a responsive maximum width and correct Back hints", async () => {
	const { ui, profileUi, state } = harness();
	const screens = [
		() => selectWorkflowProfileTarget(ui, [
			{ ref: "/private/first.json", label: "First", description: "Current: Codex" },
			{ ref: "/private/second.json", label: "Second", description: "Current: Custom" },
		], "/private/second.json"),
		() => profileUi.select("Profiles", ["Codex", "Custom"]),
		() => profileUi.select("Model", MODELS, { selected: LUNA, searchable: true }),
		() => profileUi.preview({
			profileName: "Custom", page: 1, pages: 1,
			rows: [{ id: "plan", role: "planning", model: LUNA, thinking: "high" }],
			actions: [{ id: "save", label: "Save for next run" }, { id: "back", label: "Back to profiles" }],
		}),
	];
	for (const [index, open] of screens.entries()) {
		const result = open();
		for (const width of [48, 82, 100, 240, 500]) {
			const lines = frame(state, width);
			assert.equal(visibleWidth(lines[0]), Math.min(width, 100));
			assert.equal(visibleWidth(lines.at(-1)), Math.min(width, 100));
			assert.ok(lines.every((line) => visibleWidth(line) <= Math.min(width, 100)));
			assert.match(lines.join("\n"), index === 0 ? /esc cancel/ : /esc back/);
			if (index === 0) assert.match(pointed(lines), /Second/);
		}
		state.component.handleInput(ESC);
		assert.equal(await result, undefined);
	}
});

test("native preview Back accepts the injected cancel binding", async () => {
	const { profileUi, state } = harness({ "tui.select.cancel": "ctrl+q" });
	const result = profileUi.preview({
		profileName: "Codex", page: 1, pages: 1, rows: [],
		actions: [{ id: "back", label: "Back to profiles" }],
	});
	state.component.handleInput("\x11");
	assert.equal(await result, undefined);
});

test("auto picker shows names without competing description columns and bounds every frame", async () => {
	const { ui, state } = harness();
	const choices = Array.from({ length: 30 }, (_, index) => ({
		value: `hidden-id-${index}`,
		label: `workflow-${index}`,
		description: `Description ${index}. ` + "A long explanation with 한국어 and readable details. ".repeat(20),
	}));
	const result = selectWorkflowAutoChoice(ui, "Choose how to run\nNo recommendation available. Choose an option.", choices, "hidden-id-15");
	for (const rows of [16, 24, 40]) {
		state.terminal.rows = rows;
		for (const width of [32, 48, 82, 100, 240]) {
			const lines = frame(state, width);
			assert.ok(lines.every((line) => visibleWidth(line) <= Math.min(width, 100)));
			assert.match(lines.join("\n"), /→ workflow-15/);
			assert.doesNotMatch(lines.join("\n"), /hidden-id|Description 14|Description 16/);
		}
	}
	state.component.handleInput(DOWN);
	state.component.handleInput(ENTER);
	assert.equal(await result, "hidden-id-16");
});

test("auto details preserve every wrapped line, scroll on resize, and never select on return", async () => {
	const { ui, state } = harness();
	state.terminal.rows = 16;
	const label = "아주 긴 워크플로 이름 ".repeat(12) + "NAME-END";
	const description = Array.from({ length: 70 }, (_, i) => `DETAIL-${i} 확인`).join(" ") + " CAUTION-END";
	const result = selectWorkflowAutoChoice(ui, "Choose how to run", [{ value: "exact-id", label, description }]);
	frame(state, 48);
	state.component.handleInput("\t");
	const seen = [];
	const exactLines = new Map();
	for (let index = 0; index < 150; index += 1) {
		const lines = frame(state, 48);
		seen.push(...lines);
		const footer = lines.findIndex((line) => /^ \d+–\d+ \/ \d+ lines$/.test(line));
		assert.ok(footer > 2);
		const firstLine = Number(lines[footer].match(/\d+/)[0]) - 1;
		lines.slice(2, footer).forEach((line, offset) => exactLines.set(firstLine + offset, line.slice(1)));
		state.component.handleInput(DOWN);
	}
	assert.deepEqual([...exactLines.entries()].sort(([a], [b]) => a - b).map(([, line]) => line), wrapTextWithAnsi(`${label}\n${description}`, 46));
	const text = seen.join("\n");
	for (let i = 0; i < 70; i += 1) assert.match(text, new RegExp(`DETAIL-${i}\\b`));
	assert.match(text, /NAME-END/);
	assert.match(text, /CAUTION-END/);
	state.terminal.rows = 24;
	assert.match(frame(state, 100).join("\n"), /CAUTION-END/);
	state.component.handleInput(ENTER);
	assert.deepEqual(state.completions, [], "enter returns to choices, not a selection");
	state.component.handleInput("\t");
	state.component.handleInput(ESC);
	assert.deepEqual(state.completions, [], "escape returns from details first");
	state.component.handleInput(ESC);
	assert.equal(await result, undefined);
});

test("auto search retains exact hidden IDs, no-match safety and injected navigation", async () => {
	const { ui, state } = harness({ "tui.select.down": "ctrl+n", "tui.select.cancel": "ctrl+q" });
	const choices = Array.from({ length: 15 }, (_, i) => ({ value: `id-${i}`, label: `option-${i}`, description: "Read this option." }));
	const result = selectWorkflowAutoChoice(ui, "Choose how to run", choices);
	frame(state, 48);
	state.component.handleInput("\x0e");
	assert.match(frame(state, 48).join("\n"), /→ option-1\b/);
	state.component.handleInput("absent");
	assert.match(frame(state, 48).join("\n"), /No matching choices/);
	state.component.handleInput(ENTER);
	assert.deepEqual(state.completions, []);
	state.component.handleInput("\x15");
	state.component.handleInput("option-13");
	state.component.handleInput("\t");
	assert.match(frame(state, 48).join("\n"), /Read this option/);
	state.component.handleInput("\x11");
	assert.deepEqual(state.completions, []);
	state.component.handleInput(ENTER);
	assert.equal(await result, "id-13");
});

test("auto compatibility picker keeps duplicate display names bound to distinct IDs", async () => {
	const calls = [];
	const result = await selectWorkflowAutoChoice({
		select: async (title, options) => { calls.push({ title, options }); return options[1]; },
	}, "Choose how to run", [
		{ value: "first", label: "same", description: "Private first detail" },
		{ value: "second", label: "same", description: "Private second detail" },
	]);
	assert.equal(result, "second");
	assert.deepEqual(calls[0].options, ["1. same", "2. same"]);
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
