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

for (const provider of ["openai", "openai-codex"]) {
	test(`Fast ${provider} forwards the host context without rebuilding it`, () => {
		const model = getModel(provider, "gpt-5.5");
		const context = providerContext();
		const config = { provider, model: model.id, api: model.api, serviceTier: "priority" };
		const result = {};
		const capture = (receivedModel, receivedContext, options) => {
			assert.equal(receivedModel, model);
			assert.equal(receivedContext, context);
			assert.equal(options.serviceTier, "priority");
			assert.equal(options.reasoningEffort, "high");
			return result;
		};
		const unexpected = () => assert.fail("wrong provider stream selected");
		const streams = {
			openaiResponses: provider === "openai" ? capture : unexpected,
			openaiCodexResponses: provider === "openai-codex" ? capture : unexpected,
		};
		assert.equal(createWorkflowFastProviderStream(config, undefined, streams)(
			model, context, { reasoning: "high" },
		), result);
	});

	test(`Fast ${provider} preserves prompt and tools in the real host serializer without sending`, async (t) => {
		const fetch = t.mock.method(globalThis, "fetch", () => {
			throw new Error("NETWORK_FORBIDDEN");
		});
		const model = getModel(provider, "gpt-5.5");
		const config = { provider, model: model.id, api: model.api, serviceTier: "priority" };
		const context = providerContext();
		const before = JSON.stringify(context);
		// Unsigned fixture only: never read or send a real credential.
		const token = [
			"eyJhbGciOiJub25lIn0",
			Buffer.from(JSON.stringify({
				"https://api.openai.com/auth": { chatgpt_account_id: "offline-test-only" },
			})).toString("base64url"),
			"unsigned",
		].join(".");
		let payload;
		let failures = 0;
		const stream = createWorkflowFastProviderStream(config, () => { failures++; })(model, context, {
			apiKey: provider === "openai" ? "offline-test-only" : token,
			env: {},
			transport: "sse",
			reasoning: "high",
			onPayload(value) {
				payload = value;
				throw new Error("STOP_BEFORE_PROVIDER_SEND");
			},
		});
		const response = await stream.result();
		assert.equal(response.stopReason, "error");
		assert.match(response.errorMessage, /STOP_BEFORE_PROVIDER_SEND/);
		assert.ok(payload);
		assert.equal(payload.service_tier, "priority");
		const serialized = JSON.stringify(payload);
		for (const marker of ["HOST_SDK_SYSTEM_MARKER", "HOST_SDK_USER_MARKER", "host_sdk_probe"]) {
			assert.ok(serialized.includes(marker), `missing ${marker}`);
		}
		assert.equal(JSON.stringify(context), before);
		assert.equal(failures, 1);
		assert.equal(fetch.mock.callCount(), 0);
	});
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
