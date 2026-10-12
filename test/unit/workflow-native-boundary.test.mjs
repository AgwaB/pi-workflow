import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	captureWorkflowNativeHostContext,
	resolveWorkflowNativeHostContext,
	withWorkflowNativeHostContext,
	WORKFLOW_NATIVE_HOST_CONTEXT_ENV,
} from "../../.tmp/unit/workflow-native-host-context.js";
import { runWorkflowSpec, WORKFLOW_PROMPT_SCHEMA_DIAGNOSTIC_SINK } from "../../.tmp/unit/engine.js";
import { setSubagentApiForTests } from "../../.tmp/unit/subagent-backend.js";

function bind(cwd, id) {
	const host = { version: 1, cwd: join(cwd, id), agentDir: join(cwd, "agent"), projectTrusted: true };
	const ctx = { cwd, sessionManager: { getSessionId: () => id }, isProjectTrusted: () => true };
	return { host, ctx, release: captureWorkflowNativeHostContext({ getMcpServers: () => [] }, ctx, host) };
}

function restoreEnv(name, value) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

test("identity-less native launch cannot borrow a cwd peer or process transport", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "native-unbound-"));
	const previous = process.env[WORKFLOW_NATIVE_HOST_CONTEXT_ENV];
	const peer = bind(cwd, "peer");
	try {
		process.env[WORKFLOW_NATIVE_HOST_CONTEXT_ENV] = JSON.stringify(peer.host);
		assert.deepEqual(resolveWorkflowNativeHostContext(cwd), peer.host);
		await withWorkflowNativeHostContext({ cwd }, async () => {
			await Promise.resolve();
			assert.equal(resolveWorkflowNativeHostContext(cwd), undefined);
		});
	} finally {
		peer.release();
		restoreEnv(WORKFLOW_NATIVE_HOST_CONTEXT_ENV, previous);
		await rm(cwd, { recursive: true, force: true });
	}
});

for (const initiallyBound of [true, false]) {
	test(`root native decision stays frozen across compile/persist session churn (bound=${initiallyBound})`, async () => {
		const cwd = await mkdtemp(join(tmpdir(), "native-root-snapshot-"));
		const previous = process.env[WORKFLOW_NATIVE_HOST_CONTEXT_ENV];
		const strict = process.env.PI_WORKFLOW_STRICT_PROMPT_SCHEMA;
		delete process.env[WORKFLOW_NATIVE_HOST_CONTEXT_ENV];
		delete process.env.PI_WORKFLOW_STRICT_PROMPT_SCHEMA;
		const first = initiallyBound ? bind(cwd, "first") : undefined;
		let replacement;
		let diagnostics = 0;
		let launches = 0;
		setSubagentApiForTests({ async runSubagent() { launches++; throw new Error("NETWORK_FORBIDDEN"); } });
		try {
			await mkdir(join(cwd, ".pi/agents"), { recursive: true });
			await writeFile(join(cwd, ".pi/agents/probe.md"), "---\nname: probe\ndescription: Offline fixture.\ntools: bash\n---\nDo not execute.\n");
			await writeFile(join(cwd, "control.schema.json"), JSON.stringify({ type: "object", required: ["payload"], properties: { payload: { type: "object", properties: { value: { type: "string" } } } } }));
			const spec = {
				schemaVersion: 1,
				name: "native-boundary",
				defaults: { agent: "probe", tools: ["bash"], readOnly: false, worktreePolicy: "off" },
				artifactGraph: { stages: [{
					id: "main", type: "single", approvalMode: "on-request", prompt: "Wait for approval.",
					output: { controlSchema: "./control.schema.json" },
				}] },
			};
			const specPath = join(cwd, "spec.json");
			await writeFile(specPath, JSON.stringify(spec));
			const run = await runWorkflowSpec(specPath, cwd, {
				[WORKFLOW_PROMPT_SCHEMA_DIAGNOSTIC_SINK]: () => {
					diagnostics++;
					first?.release();
					replacement = bind(cwd, "replacement");
				},
			});
			assert.equal(diagnostics, 1, "swap must occur after compilation and before run persistence");
			assert.deepEqual(run.nativeHost, first?.host);
			const compiled = JSON.parse(await readFile(join(cwd, ".pi/workflows", run.runId, "compiled.json"), "utf8"));
			assert.equal(compiled.tasks[0].runtime.tools.includes("codemode"), initiallyBound);
			assert.equal(run.tasks[0].statusDetail, "pending_approval");
			assert.equal(launches, 0);
			assert.deepEqual(resolveWorkflowNativeHostContext(cwd), replacement.host, "new direct callers see the replacement, not the ended launch scope");
		} finally {
			first?.release();
			replacement?.release();
			setSubagentApiForTests(undefined);
			restoreEnv(WORKFLOW_NATIVE_HOST_CONTEXT_ENV, previous);
			restoreEnv("PI_WORKFLOW_STRICT_PROMPT_SCHEMA", strict);
			await rm(cwd, { recursive: true, force: true });
		}
	});
}
