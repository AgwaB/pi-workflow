import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as sdk from "@earendil-works/pi-coding-agent";
import { registerWorkflowNativeHost } from "../../.tmp/unit/workflow-native-host-extension.js";
import { buildWorkflowNativeHostExtensionWrapper, resolveWorkflowNativeHostContext, workflowNativeLaunchTools, WORKFLOW_NATIVE_HOST_CONTEXT_ENV } from "../../.tmp/unit/workflow-native-host-context.js";

const supported = typeof sdk.createMcpExtension === "function";
const fixture = fileURLToPath(new URL("./helpers/workflow-native-host-mcp-fixture.mjs", import.meta.url));
const text = (result) => result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
const waitFor = async (predicate) => {
	const deadline = Date.now() + 10_000;
	while (!await predicate()) {
		assert.ok(Date.now() < deadline, "native fixture startup deadline");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
};

for (const trustCase of ["trusted", "untrusted", "revoked"]) {
	const projectTrusted = trustCase !== "untrusted";
	const projectAllowed = trustCase === "trusted";
	test(`native MCP uses parent references, full codemode, and trust=${trustCase}`, { skip: !supported, timeout: 25_000 }, async () => {
		const root = await mkdtemp(join(tmpdir(), "piwf-native-mcp-"));
		const parent = join(root, "parent"), child = join(root, "child"), agentDir = join(root, "agent");
		const previousAgent = process.env.PI_CODING_AGENT_DIR;
		const previousContext = process.env[WORKFLOW_NATIVE_HOST_CONTEXT_ENV];
		const originalFetch = globalThis.fetch;
		let fetches = 0, session;
		const hooks = [];
		try {
			process.env.PI_CODING_AGENT_DIR = agentDir;
			delete process.env[WORKFLOW_NATIVE_HOST_CONTEXT_ENV];
			globalThis.fetch = async () => { fetches++; throw new Error("NETWORK_FORBIDDEN"); };
			await Promise.all([agentDir, join(parent, ".pi"), join(child, ".pi"), join(parent, "server-work")].map((dir) => mkdir(dir, { recursive: true })));
			const server = (scope, exposure = "codemode") => ({
				command: process.execPath, args: [fixture, join(root, `${scope}.jsonl`)],
				cwd: "server-work", env: { MCP_FIXTURE_SCOPE: scope, UNUSED_SECRET: "fixture-secret-not-for-artifacts" }, exposure,
				toolExposure: { blocked: "hidden" },
			});
			await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
				shared: server("global"), disabled: { ...server("disabled"), enabled: false }, direct: server("direct", "direct"),
			} }));
			await writeFile(join(parent, ".pi/mcp.json"), JSON.stringify({ mcpServers: { shared: server("project") } }));
			await writeFile(join(child, ".pi/mcp.json"), JSON.stringify({ mcpServers: { childonly: server("child-only") } }));
			if (trustCase === "revoked") new sdk.ProjectTrustStore(agentDir).set(parent, false);
			const config = { version: 1, cwd: parent, agentDir, projectTrusted };
			const wrapper = buildWorkflowNativeHostExtensionWrapper({ importPath: "fixture-extension", config });
			assert.ok(!wrapper.includes("fixture-secret"));
			const settingsManager = sdk.SettingsManager.inMemory({}, { projectTrusted: true });
			const loader = new sdk.DefaultResourceLoader({
				cwd: child, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				extensionFactories: [
					(pi) => registerWorkflowNativeHost(pi, config),
					(pi) => {
						pi.on("tool_call", (event) => {
							hooks.push({ type: "call", name: event.toolName, parent: event.parentToolCallId });
							if (event.toolName === "mcp__shared__fail") return { block: true, reason: "FIXTURE_PERMISSION_DENIED" };
						});
						pi.on("tool_result", (event) => hooks.push({ type: "result", name: event.toolName, parent: event.parentToolCallId }));
					},
				],
			});
			await loader.reload();
			assert.deepEqual(loader.getExtensions().errors, []);
			assert.equal(process.env[WORKFLOW_NATIVE_HOST_CONTEXT_ENV], undefined, "factory/preflight must not mutate the supervisor context");
			({ session } = await sdk.createAgentSession({ cwd: child, agentDir, resourceLoader: loader, settingsManager, sessionManager: sdk.SessionManager.inMemory(), tools: workflowNativeLaunchTools(["read"], config) }));
			await session.bindExtensions({});
			assert.equal(process.env[WORKFLOW_NATIVE_HOST_CONTEXT_ENV], undefined, "session binding must not mutate process-global context");
			assert.deepEqual(resolveWorkflowNativeHostContext(child), config);
			await waitFor(() => session.getAllTools().some((tool) => tool.name === "mcp__shared__inspect") && session.getAllTools().some((tool) => tool.name === "mcp__direct__inspect"));
			const names = session.getCallableToolNames();
			assert.ok(names.includes("mcp__shared__inspect"));
			assert.ok(names.includes("mcp__direct__inspect"));
			assert.ok(!names.includes("mcp__shared__blocked"));
			assert.ok(!names.some((name) => name.includes("childonly") || name.includes("disabled")));
			assert.ok(!names.includes("bash"));
			for (const resource of ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]) {
				assert.ok(names.includes(resource), `native resource tool missing: ${resource}`);
			}
			const codemode = session.agent.state.tools.find((tool) => tool.name === "codemode");
			assert.ok(codemode);
			let call = 0;
			const execute = async (code, signal) => {
				const id = `native-${++call}`;
				session.agent.state.messages.push({ role: "assistant", content: [{ type: "toolCall", id, name: "codemode", arguments: { code } }], api: "openai-responses", provider: "offline", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now() });
				return codemode.execute(id, { code }, signal);
			};
			const result = await execute('text({classify:typeof models.classify,generateImages:typeof models.generateImages}); text(await tools.mcp__shared__inspect({label:"offline"}));');
			assert.match(text(result), /"classify":\s*"function"/);
			assert.match(text(result), /"generateImages":\s*"function"/);
			assert.match(text(result), new RegExp(projectAllowed ? '"scope":"project"' : '"scope":"global"'));
			assert.ok(text(result).includes(join(parent, "server-work")));
			assert.match(text(await execute('await tools.mcp__shared__fail({});')), /FIXTURE_PERMISSION_DENIED/);
			const failed = text(await execute('text(await tools.mcp__direct__fail({}));'));
			assert.match(failed, /expected-error/);
			assert.match(failed, /"isError":\s*true/);
			assert.ok(hooks.some((entry) => entry.type === "call" && entry.name === "mcp__shared__inspect" && entry.parent));
			assert.ok(hooks.some((entry) => entry.type === "result" && entry.name === "mcp__shared__inspect" && entry.parent));
			const scope = projectAllowed ? "project" : "global";
			assert.match(text(await execute('text(await tools.list_mcp_resources({server:"shared"}));')), new RegExp(`fixture://${scope}/document`));
			assert.match(text(await execute('text(await tools.list_mcp_resource_templates({server:"shared"}));')), /fixture-template/);
			assert.match(text(await execute(`text(await tools.read_mcp_resource({server:"shared",uri:"fixture://${scope}/document"}));`)), new RegExp(`MCP_RESOURCE_${scope}`));
			assert.ok(hooks.some((entry) => entry.type === "call" && entry.name === "read_mcp_resource" && entry.parent));
			const controller = new AbortController();
			const pending = execute('await tools.mcp__shared__slow({});', controller.signal);
			await waitFor(async () => (await readFile(join(root, `${scope}.jsonl`), "utf8")).includes('"tool":"slow"'));
			controller.abort();
			await pending;
			await waitFor(async () => (await readFile(join(root, `${scope}.jsonl`), "utf8")).includes('"event":"cancelled"'));
			assert.equal(fetches, 0);
			await session.extensionRunner.emit({ type: "session_shutdown" });
			assert.equal(process.env[WORKFLOW_NATIVE_HOST_CONTEXT_ENV], undefined, "child shutdown leaves the environment unchanged");
			assert.equal(resolveWorkflowNativeHostContext(child), undefined, "shutdown releases only the owned session binding");
		} finally {
			if (session) { await session.extensionRunner?.emit({ type: "session_shutdown" }); session.dispose(); }
			globalThis.fetch = originalFetch;
			if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent;
			if (previousContext === undefined) delete process.env[WORKFLOW_NATIVE_HOST_CONTEXT_ENV]; else process.env[WORKFLOW_NATIVE_HOST_CONTEXT_ENV] = previousContext;
			await rm(root, { recursive: true, force: true });
		}
	});
}
