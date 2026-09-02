import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { WORKFLOW_KNOWN_ACTIONS } from "../../.tmp/unit/extension.js";
import { WORKFLOW_HELP } from "../../.tmp/unit/index.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function helpActions() {
	const actions = new Set();
	for (const line of WORKFLOW_HELP.split("\n")) {
		const match = /^ {2}\/workflow (\S+)/.exec(line);
		if (!match) continue;
		// `/workflow [run-id]` is the board shortcut, not a named action.
		if (match[1].startsWith("[")) continue;
		actions.add(match[1]);
	}
	return actions;
}

function handledActions() {
	const source = readFileSync(join(repoRoot, "src", "extension.ts"), "utf8");
	const actions = new Set();
	for (const match of source.matchAll(/action === "([^"]+)"/g)) actions.add(match[1]);
	return actions;
}

test("WORKFLOW_KNOWN_ACTIONS covers every action advertised by WORKFLOW_HELP", () => {
	const advertised = helpActions();
	assert.ok(advertised.size >= 12, `unexpectedly few help actions: ${[...advertised]}`);
	for (const action of advertised) {
		assert.ok(
			WORKFLOW_KNOWN_ACTIONS.has(action),
			`help advertises /workflow ${action} but WORKFLOW_KNOWN_ACTIONS omits it`,
		);
	}
});

test("WORKFLOW_KNOWN_ACTIONS matches the actions the slash command dispatches", () => {
	const handled = handledActions();
	assert.ok(handled.has("stop"), "expected a /workflow stop handler in extension.ts");
	for (const action of handled) {
		assert.ok(
			WORKFLOW_KNOWN_ACTIONS.has(action),
			`extension.ts handles action "${action}" but WORKFLOW_KNOWN_ACTIONS omits it`,
		);
	}
	for (const action of WORKFLOW_KNOWN_ACTIONS) {
		assert.ok(
			handled.has(action),
			`WORKFLOW_KNOWN_ACTIONS lists "${action}" but extension.ts never dispatches it`,
		);
	}
});
