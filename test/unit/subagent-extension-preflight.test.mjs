import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assertSubagentExtensionsLoadable, runOneShotSubagentCall, setSubagentApiForTests } from "../../.tmp/unit/subagent-backend.js";

const duplicateProviderSource = (label) => `export default function register(pi) {
	for (const name of ["fetch_content", "get_search_content"]) {
		pi.registerTool({
			name,
			description: ${JSON.stringify(label)},
			parameters: { type: "object", properties: {} },
			async execute() {
				return { content: [{ type: "text", text: ${JSON.stringify(label)} }], details: {} };
			},
		});
	}
}
`;

test("subagent preflight preserves child-runner ambient discovery and fails closed on collisions", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "workflow-extension-preflight-"));
	const agentDir = join(cwd, "agent");
	const ambientExtension = join(agentDir, "extensions", "pi-web-access.mjs");
	const workflowProvider = join(cwd, "workflow-web-provider.mjs");
	const secondWorkflowProvider = join(cwd, "second-workflow-web-provider.mjs");
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	writeFileSync(ambientExtension, duplicateProviderSource("ambient"));
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ extensions: [ambientExtension] }),
	);
	writeFileSync(workflowProvider, duplicateProviderSource("workflow"));
	writeFileSync(secondWorkflowProvider, duplicateProviderSource("second workflow"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const piSdk = await import("@earendil-works/pi-coding-agent");
		const additiveLoader = new piSdk.DefaultResourceLoader({
			cwd,
			agentDir,
			additionalExtensionPaths: [workflowProvider],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await additiveLoader.reload();
		assert.equal(
			additiveLoader
				.getExtensions()
				.errors.some(({ error }) => /fetch_content|get_search_content/.test(error)),
			true,
			"the fixture must reproduce an additive ambient provider collision",
		);

		await assert.rejects(
			() => assertSubagentExtensionsLoadable({ cwd, extensions: [workflowProvider] }),
			/Subagent extension preflight failed[\s\S]*(?:fetch_content|get_search_content)/,
			"non-empty child extension lists are additive, so preflight must not hide ambient collisions",
		);
		await assert.doesNotReject(() =>
			assertSubagentExtensionsLoadable({ cwd, extensions: [] }),
		);
		await assert.doesNotReject(() =>
			assertSubagentExtensionsLoadable({ cwd, extensions: [workflowProvider], noExtensions: true }),
		);
		await assert.rejects(() => assertSubagentExtensionsLoadable({
			cwd, extensions: [workflowProvider, secondWorkflowProvider], noExtensions: true,
		}), /Subagent extension preflight failed[\s\S]*(?:fetch_content|get_search_content)/);
		let launched;
		setSubagentApiForTests({
			supportsExplicitExtensionIsolation: () => true,
			async runSubagent(options) { launched = options; return { runId: "fixture", attemptId: "fixture", status: "completed" }; },
		});
		const options = { cwd, extensions: [workflowProvider] };
		await runOneShotSubagentCall(options);
		assert.equal(launched.noExtensions, true, "preflight and child use the same discovery mode");
		assert.deepEqual(launched.extensions, [workflowProvider]);
		assert.equal(Object.hasOwn(options, "noExtensions"), false);
		setSubagentApiForTests({ async runSubagent() { assert.fail("unsupported engine must not launch"); } });
		await assert.rejects(() => runOneShotSubagentCall({ ...options, noExtensions: true }), /does not support explicit extension isolation/);
		await assert.rejects(() => runOneShotSubagentCall(options), /Subagent extension preflight failed/);
		await assert.rejects(
			() =>
				assertSubagentExtensionsLoadable({
					cwd,
					extensions: [workflowProvider, secondWorkflowProvider],
				}),
			/Subagent extension preflight failed[\s\S]*(?:fetch_content|get_search_content)/,
			"explicit workflow-provider collisions must remain fatal",
		);
	} finally {
		setSubagentApiForTests(undefined);
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(cwd, { recursive: true, force: true });
	}
});
