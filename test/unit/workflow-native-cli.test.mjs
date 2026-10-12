import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as sdk from "@earendil-works/pi-coding-agent";
import { buildWorkflowNativeHostExtensionWrapper } from "../../.tmp/unit/workflow-native-host-context.js";

const supported = typeof sdk.createMcpExtension === "function";
test("real headless Pi loads native child tools despite --no-extensions, without a provider request", { skip: !supported, timeout: 25_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "piwf-native-cli-"));
	const agentDir = join(root, "agent"), parent = join(root, "parent"), child = join(root, "child"), receipt = join(root, "receipt.json");
	let processHandle, finished;
	let stderr = "";
	try {
		await Promise.all([agentDir, parent, child].map((dir) => mkdir(dir, { recursive: true })));
		await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { fixture: {
			command: process.execPath,
			args: [fileURLToPath(new URL("./helpers/workflow-native-host-mcp-fixture.mjs", import.meta.url)), join(root, "server.jsonl")],
			exposure: "codemode",
		} } }));
		const extension = join(root, "native.mjs"), observer = join(root, "observer.mjs");
		await writeFile(extension, buildWorkflowNativeHostExtensionWrapper({
			importPath: fileURLToPath(new URL("../../.tmp/unit/workflow-native-host-extension.js", import.meta.url)),
			config: { version: 1, cwd: parent, agentDir, projectTrusted: false },
		}));
		await writeFile(observer, `import { writeFile } from 'node:fs/promises';
export default function (pi) {
 pi.on('before_provider_request', () => { throw new Error('PROVIDER_FORBIDDEN'); });
 pi.on('session_start', async (_event, ctx) => {
  const deadline = Date.now()+10000;
  while (!pi.getAllTools().some(t=>t.name==='mcp__fixture__inspect')) {
   if(Date.now()>deadline) throw new Error('MCP_STARTUP_DEADLINE');
   await new Promise(r=>setTimeout(r,20));
  }
  await writeFile(${JSON.stringify(receipt)}, JSON.stringify({cwd:ctx.cwd, active:pi.getActiveTools(), names:pi.getAllTools().map(t=>t.name)}));
 });
}
`);
		const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
		processHandle = spawn(process.execPath, [cli, "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--tools", "read,codemode,tool_search,mcp__*", "--extension", extension, "--extension", observer], {
			cwd: child, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_WORKFLOW_NATIVE_HOST_CONTEXT: undefined },
		});
		finished = new Promise((resolve, reject) => { processHandle.once("error", reject); processHandle.once("exit", (code, signal) => resolve({ code, signal })); });
		processHandle.stdout.resume();
		processHandle.stderr.on("data", (value) => { stderr += value.toString(); });
		let ready;
		const deadline = Date.now() + 15_000;
		while (!ready) {
			ready = await readFile(receipt, "utf8").then(JSON.parse).catch(() => undefined);
			if (!ready) {
				assert.ok(processHandle.exitCode === null && Date.now() < deadline, stderr || "native CLI receipt deadline");
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
		}
		assert.equal(await realpath(ready.cwd), await realpath(child));
		assert.ok(ready.active.includes("codemode"));
		assert.ok(ready.active.includes("tool_search"));
		assert.ok(ready.names.includes("mcp__fixture__inspect"));
		assert.ok(!ready.active.includes("bash"));
		assert.ok(!stderr.includes("PROVIDER_FORBIDDEN"));
	} finally {
		if (processHandle?.pid && processHandle.exitCode === null && processHandle.signalCode === null) {
			if (process.platform === "win32") processHandle.kill("SIGTERM");
			else process.kill(-processHandle.pid, "SIGTERM");
		}
		if (finished) await finished;
		await rm(root, { recursive: true, force: true });
	}
});
