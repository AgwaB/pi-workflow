import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as piAi from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { createWorkflowFastProviderStream } from "../../.tmp/unit/workflow-fast-mode-extension.js";

function providerContext() {
	const context = {
		systemPrompt: "HOST_SDK_SYSTEM_MARKER",
		tools: [{
			name: "host_sdk_probe",
			description: "Offline compatibility probe",
			parameters: { type: "object", properties: {} },
		}],
		messages: [{
			role: "user",
			content: [{ type: "text", text: "HOST_SDK_USER_MARKER" }],
			timestamp: 0,
		}],
	};
	// Pi <0.86 passes Context; newer hosts pass a normalized transcript.
	return typeof piAi.normalizeContext === "function"
		? piAi.normalizeContext(context)
		: context;
}


test("workflow declares host SDK packages as peers with matching development locks", () => {
	const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
	const lock = JSON.parse(readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"));
	for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
		assert.equal(manifest.peerDependencies[name], "*", name);
		assert.ok(manifest.devDependencies[name], name);
		assert.equal(Object.hasOwn(manifest.dependencies, name), false, name);
		assert.equal(manifest.bundleDependencies.includes(name), false, name);
	}
	for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
		assert.deepEqual(lock.packages[""][key], manifest[key]);
	}
});
