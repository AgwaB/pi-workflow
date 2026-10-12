import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import {
	assert, join, launchSubagentTask, makeProject, makeSubagentLaunchFixture,
	setSubagentApiForTests, test, artifactGraphWorkflowSpec, compileWorkflow, writeAgent,
} from "./unit-test-support.mjs";
import { prepareSubagentTaskLaunch } from "../../.tmp/unit/subagent-backend.js";
import { createRunRecord, readRunRecord, writeRunRecord } from "../../.tmp/unit/store.js";
import { createLaunchBootstrapProvenance } from "../../.tmp/unit/launch-bootstrap-provenance.js";
import { captureWorkflowNativeHostContext, resolveWorkflowNativeHostContext, WORKFLOW_NATIVE_HOST_CONTEXT_ENV } from "../../.tmp/unit/workflow-native-host-context.js";

const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url, { fsCache: false, moduleCache: false });
const { buildPiArgv } = jiti("../../node_modules/@agwab/pi-subagent/src/runners/headless-model.ts");

function host(cwd) {
	return { version: 1, cwd, agentDir: join(cwd, "fixture-agent"), projectTrusted: true };
}

test("native default reaches sealed launch, bundled headless argv, and actual wrapper bytes", async () => {
	const cwd = makeProject();
	const { run, task, compiledTask } = makeSubagentLaunchFixture(cwd, "native-argv");
	run.nativeHost = host(cwd);
	compiledTask.runtime.tools = ["read"];
	let captured;
	setSubagentApiForTests({
		async runSubagent(options) { captured = options; return { runId: "run_native_argv", attemptId: "attempt_native_argv", status: "running" }; },
		async getSubagentStatus() { return null; },
		async reconcileSubagentRun() { return {}; },
		async interruptSubagent() { return {}; },
	});
	try {
		const prepared = await prepareSubagentTaskLaunch(cwd, run, task, compiledTask);
		const native = prepared.generatedExtensions.find((entry) => entry.kind === "native-host");
		assert.ok(native);
		assert.equal(await readFile(native.path, "utf8"), native.expectedBytes);
		assert.deepEqual(native.config, run.nativeHost);
		assert.deepEqual(Object.keys(native.config).sort(), ["agentDir", "cwd", "projectTrusted", "version"]);
		const provenance = await createLaunchBootstrapProvenance(cwd, run, task, compiledTask, "pi-subagent/headless", prepared);
		assert.deepEqual(provenance.effectivePolicy.tools, ["read", "codemode", "tool_search", "mcp__*", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);
		assert.equal((await launchSubagentTask(cwd, run, task, compiledTask, undefined, undefined, prepared)).kind, "launched");
		assert.deepEqual(captured.tools, provenance.effectivePolicy.tools);
		const argv = buildPiArgv(captured);
		assert.equal(argv[argv.indexOf("--tools") + 1], "read,codemode,tool_search,mcp__*,list_mcp_resources,list_mcp_resource_templates,read_mcp_resource");
		assert.ok(argv.includes(native.path));
		assert.ok(!captured.tools.includes("bash"));
		await assert.rejects(() => createLaunchBootstrapProvenance(cwd, run, task, compiledTask, "pi-subagent/headless", {
			...prepared, nativeHost: { ...prepared.nativeHost, cwd: join(cwd, "other") },
		}), /native host context/);
		await assert.rejects(() => createLaunchBootstrapProvenance(cwd, run, task, compiledTask, "pi-subagent/headless", {
			...prepared, generatedExtensions: [],
		}), /native host extension/);
	} finally {
		setSubagentApiForTests(undefined);
	}
});

test("nested controller runs inherit persisted parent context and cannot retarget it", async () => {
	const cwd = makeProject();
	const prior = process.env[WORKFLOW_NATIVE_HOST_CONTEXT_ENV];
	try {
		delete process.env[WORKFLOW_NATIVE_HOST_CONTEXT_ENV];
		writeAgent(cwd, "unit-scout", "read");
		const compiled = await compileWorkflow(artifactGraphWorkflowSpec(), { cwd, task: "Native inheritance" });
		const { run: parent } = await createRunRecord(cwd, compiled, join(cwd, "parent.json"));
		parent.nativeHost = host(cwd);
		await writeRunRecord(cwd, parent);
		const { run: child } = await createRunRecord(cwd, compiled, join(cwd, "nested.json"), { parentRunId: parent.runId });
		assert.deepEqual(child.nativeHost, parent.nativeHost);
		await writeRunRecord(cwd, child);
		assert.deepEqual((await readRunRecord(cwd, child.runId)).nativeHost, host(cwd));
		await assert.rejects(() => writeRunRecord(cwd, { ...child, nativeHost: { ...host(cwd), projectTrusted: false } }), /native host context is immutable/);
	} finally {
		if (prior === undefined) delete process.env[WORKFLOW_NATIVE_HOST_CONTEXT_ENV];
		else process.env[WORKFLOW_NATIVE_HOST_CONTEXT_ENV] = prior;
	}
});

test("old runs and explicit no-tools tasks retain their original launch surface", async () => {
	const cwd = makeProject();
	for (const [context, tools] of [[undefined, ["read"]], [host(cwd), []]]) {
		const { run, task, compiledTask } = makeSubagentLaunchFixture(cwd, `native-old-${tools.length}`);
		if (context) run.nativeHost = context;
		compiledTask.runtime.tools = tools;
		const prepared = await prepareSubagentTaskLaunch(cwd, run, task, compiledTask);
		assert.equal(prepared.nativeHost, undefined);
		assert.equal(prepared.generatedExtensions.some((entry) => entry.kind === "native-host"), false);
		const provenance = await createLaunchBootstrapProvenance(cwd, run, task, compiledTask, "pi-subagent/headless", prepared);
		assert.deepEqual(provenance.effectivePolicy.tools, tools);
	}
});

test("a nested workflow retains the original parent root instead of its local cwd", () => {
	const cwd = makeProject();
	const child = join(cwd, "child");
	const prior = process.env[WORKFLOW_NATIVE_HOST_CONTEXT_ENV];
	try {
		process.env[WORKFLOW_NATIVE_HOST_CONTEXT_ENV] = JSON.stringify(host(cwd));
		captureWorkflowNativeHostContext({ getMcpServers() {} }, { cwd: child, isProjectTrusted: () => true });
		assert.deepEqual(resolveWorkflowNativeHostContext(child), host(cwd));
		process.env[WORKFLOW_NATIVE_HOST_CONTEXT_ENV] = "malformed";
		assert.throws(() => resolveWorkflowNativeHostContext(child), /Invalid workflow native host context/);
	} finally {
		if (prior === undefined) delete process.env[WORKFLOW_NATIVE_HOST_CONTEXT_ENV];
		else process.env[WORKFLOW_NATIVE_HOST_CONTEXT_ENV] = prior;
	}
});
