import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as sdk from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const require = createRequire(import.meta.url);
const jiti = require("../../node_modules/jiti/lib/jiti.cjs")(import.meta.url, {
	fsCache: false,
});
const sourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));
const nativeContext = await jiti.import(
	join(sourceRoot, "workflow-native-host-context.ts"),
);
const { registerWorkflowNativeHost } = await jiti.import(
	join(sourceRoot, "workflow-native-host-extension.ts"),
);
const { compileWorkflow } = await jiti.import(join(sourceRoot, "compiler.ts"));
const store = await jiti.import(join(sourceRoot, "store.ts"));

const {
	WORKFLOW_NATIVE_HOST_CONTEXT_ENV,
	captureWorkflowNativeHostContext,
	resolveWorkflowNativeHostContext,
	withWorkflowNativeHostContext,
} = nativeContext;
const supported = typeof sdk.createMcpExtension === "function";
const PROBE_TOOL = "workflow_native_session_probe";
let probeSequence = 0;

function host(cwd, agentDir) {
	return { version: 1, cwd, agentDir, projectTrusted: true };
}

function probeExtension(compiled, specPath) {
	return (pi) => {
		let releaseContext;
		pi.on("session_start", (_event, ctx) => {
			releaseContext?.();
			releaseContext = captureWorkflowNativeHostContext(pi, ctx);
		});
		pi.on("session_shutdown", () => {
			releaseContext?.();
			releaseContext = undefined;
		});
		pi.registerTool({
			name: PROBE_TOOL,
			label: "Native session probe",
			description: "Offline unit-test probe.",
			parameters: Type.Object({
				delayMs: Type.Optional(Type.Number({ minimum: 0, maximum: 1_000 })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const runtimeCwd = ctx.cwd;
				const details = await withWorkflowNativeHostContext(ctx, async () => {
					if (params.delayMs)
						await new Promise((resolve) => setTimeout(resolve, params.delayMs));
					const resolved = resolveWorkflowNativeHostContext(runtimeCwd);
					const { run } = await store.createRunRecord(
						runtimeCwd,
						compiled,
						specPath,
						{
							initialize: false,
						},
					);
					return { resolved, persisted: run.nativeHost };
				});
				return {
					content: [{ type: "text", text: JSON.stringify(details) }],
					details,
				};
			},
		});
	};
}

async function executeProbe(session, delayMs = 0) {
	const tool = session.agent.state.tools.find(
		(candidate) => candidate.name === PROBE_TOOL,
	);
	assert.ok(tool, "session probe tool must be registered");
	return (await tool.execute(`native-session-${++probeSequence}`, { delayMs }))
		.details;
}

async function closeSession(session, live) {
	if (!live.has(session)) return;
	live.delete(session);
	await session.extensionRunner?.emit({
		type: "session_shutdown",
		reason: "quit",
	});
	session.dispose();
}

test("native host context is isolated by actual SDK session across overlap and non-LIFO shutdown", {
	skip: !supported,
	timeout: 60_000,
}, async () => {
	const root = await mkdtemp(join(tmpdir(), "piwf-native-session-"));
	const agentDir = join(root, "agent");
	const runtimeCwd = join(root, "shared-child");
	const parentA = join(root, "parent-a");
	const parentB = join(root, "parent-b");
	const outerRoot = join(root, "outer-root");
	const configA = host(parentA, agentDir);
	const configB = host(parentB, agentDir);
	const outer = host(outerRoot, agentDir);
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	const oldContext = process.env[WORKFLOW_NATIVE_HOST_CONTEXT_ENV];
	const oldOffline = process.env.PI_OFFLINE;
	const oldFetch = globalThis.fetch;
	const outerText = JSON.stringify(outer);
	const live = new Set();
	let fetches = 0;

	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_OFFLINE = "1";
		process.env[WORKFLOW_NATIVE_HOST_CONTEXT_ENV] = outerText;
		globalThis.fetch = async () => {
			fetches += 1;
			throw new Error("NETWORK_FORBIDDEN");
		};
		await Promise.all(
			[
				agentDir,
				runtimeCwd,
				parentA,
				parentB,
				outerRoot,
				join(runtimeCwd, ".pi/agents"),
			].map((dir) => mkdir(dir, { recursive: true })),
		);
		await writeFile(
			join(runtimeCwd, ".pi/agents/probe.md"),
			[
				"---",
				"name: probe",
				"description: Offline native session fixture.",
				"tools: read",
				"---",
				"Inspect only.",
				"",
			].join("\n"),
		);
		const specPath = join(runtimeCwd, "session-workflow.json");
		const spec = {
			schemaVersion: 1,
			name: "native-session-fixture",
			defaults: { agent: "probe", readOnly: true },
			artifactGraph: {
				stages: [
					{
						id: "main",
						type: "single",
						prompt: "Offline fixture.",
						output: { analysis: { required: true }, refs: { required: true } },
					},
				],
			},
		};
		await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`);
		const compiled = await compileWorkflow(spec, {
			cwd: runtimeCwd,
			specPath,
			task: "Verify native session isolation.",
		});

		const createSession = async (config, nativeFirst) => {
			const settingsManager = sdk.SettingsManager.inMemory(
				{},
				{ projectTrusted: true },
			);
			const nativeFactory = (pi) => registerWorkflowNativeHost(pi, config);
			const probeFactory = probeExtension(compiled, specPath);
			const resourceLoader = new sdk.DefaultResourceLoader({
				cwd: runtimeCwd,
				agentDir,
				settingsManager,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				extensionFactories: nativeFirst
					? [nativeFactory, probeFactory]
					: [probeFactory, nativeFactory],
			});
			await resourceLoader.reload();
			assert.deepEqual(resourceLoader.getExtensions().errors, []);
			assert.equal(
				process.env[WORKFLOW_NATIVE_HOST_CONTEXT_ENV],
				outerText,
				"factory/preflight must not mutate process context",
			);
			const { session } = await sdk.createAgentSession({
				cwd: runtimeCwd,
				agentDir,
				settingsManager,
				resourceLoader,
				sessionManager: sdk.SessionManager.inMemory(),
				tools: [PROBE_TOOL],
			});
			try {
				await session.bindExtensions({});
				live.add(session);
				assert.equal(process.env[WORKFLOW_NATIVE_HOST_CONTEXT_ENV], outerText);
				return session;
			} catch (error) {
				await session.extensionRunner?.emit({
					type: "session_shutdown",
					reason: "quit",
				});
				session.dispose();
				throw error;
			}
		};

		for (const shutdownOrder of [
			[0, 1],
			[1, 0],
		]) {
			const sessions = [
				await createSession(configA, false),
				await createSession(configB, true),
			];
			assert.throws(
				() => resolveWorkflowNativeHostContext(runtimeCwd),
				/Ambiguous workflow native host context/,
				"same-cwd direct resolution must fail closed instead of guessing a session",
			);
			const [observedA, observedB] = await Promise.all([
				executeProbe(sessions[0], 20),
				executeProbe(sessions[1], 1),
			]);
			assert.deepEqual(observedA, { resolved: configA, persisted: configA });
			assert.deepEqual(observedB, { resolved: configB, persisted: configB });

			await closeSession(sessions[shutdownOrder[0]], live);
			const survivorIndex = shutdownOrder[1];
			const survivorConfig = survivorIndex === 0 ? configA : configB;
			assert.deepEqual(
				resolveWorkflowNativeHostContext(runtimeCwd),
				survivorConfig,
			);
			assert.deepEqual(await executeProbe(sessions[survivorIndex]), {
				resolved: survivorConfig,
				persisted: survivorConfig,
			});
			await closeSession(sessions[survivorIndex], live);
			assert.deepEqual(resolveWorkflowNativeHostContext(runtimeCwd), outer);
			assert.equal(process.env[WORKFLOW_NATIVE_HOST_CONTEXT_ENV], outerText);
		}

		const equalSessions = [
			await createSession(configA, false),
			await createSession(configA, true),
		];
		assert.deepEqual(resolveWorkflowNativeHostContext(runtimeCwd), configA);
		await closeSession(equalSessions[0], live);
		assert.deepEqual(
			resolveWorkflowNativeHostContext(runtimeCwd),
			configA,
			"one same-context shutdown must not clear the other session",
		);
		await closeSession(equalSessions[1], live);
		assert.deepEqual(resolveWorkflowNativeHostContext(runtimeCwd), outer);

		const repeated = await createSession(configB, false);
		await repeated.extensionRunner.emit({
			type: "session_start",
			reason: "reload",
		});
		assert.deepEqual(await executeProbe(repeated), {
			resolved: configB,
			persisted: configB,
		});
		await closeSession(repeated, live);
		await repeated.extensionRunner?.emit({
			type: "session_shutdown",
			reason: "quit",
		});
		assert.deepEqual(resolveWorkflowNativeHostContext(runtimeCwd), outer);

		const legacyRelease = captureWorkflowNativeHostContext(
			{ getMcpServers() {} },
			{ cwd: runtimeCwd, isProjectTrusted: () => true },
		);
		assert.deepEqual(
			withWorkflowNativeHostContext({ cwd: runtimeCwd }, () =>
				resolveWorkflowNativeHostContext(runtimeCwd),
			),
			undefined,
			"an explicit launch without session identity must not borrow inherited context",
		);
		legacyRelease();
		assert.deepEqual(resolveWorkflowNativeHostContext(runtimeCwd), outer, "direct process-start fallback remains available outside an explicit session boundary");

		await assert.rejects(
			registerWorkflowNativeHost(
				{},
				{ ...configA, agentDir: join(root, "wrong-agent") },
			),
			/agent directory changed/,
			"native host must fail closed before binding a different agent directory",
		);
		assert.equal(fetches, 0);
	} finally {
		for (const session of live) {
			await closeSession(session, live).catch(() => undefined);
		}
		await store.flushPendingIndexUpdatesForTests();
		globalThis.fetch = oldFetch;
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		if (oldContext === undefined)
			delete process.env[WORKFLOW_NATIVE_HOST_CONTEXT_ENV];
		else process.env[WORKFLOW_NATIVE_HOST_CONTEXT_ENV] = oldContext;
		if (oldOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = oldOffline;
		await rm(root, { recursive: true, force: true });
	}
});

test("session-manager generation changes retire old captures and an unbound session cannot borrow a peer", () => {
	const cwd = join(tmpdir(), "native-session-generation");
	const config = host(join(cwd, "parent"), join(cwd, "agent"));
	const pi = { getMcpServers() { return []; } };
	let sessionId = "first";
	const ctx = { cwd, isProjectTrusted: () => true, sessionManager: { getSessionId: () => sessionId } };
	const peer = { ...ctx, sessionManager: { getSessionId: () => "unbound" } };
	const releases = [];
	try {
		releases.push(captureWorkflowNativeHostContext(pi, ctx, config));
		releases.push(captureWorkflowNativeHostContext(pi, ctx, config));
		assert.equal(withWorkflowNativeHostContext(peer, () => resolveWorkflowNativeHostContext(cwd)), undefined);
		assert.equal(withWorkflowNativeHostContext(ctx, () => withWorkflowNativeHostContext(peer, () => resolveWorkflowNativeHostContext(cwd))), undefined);
		sessionId = "second";
		releases.push(captureWorkflowNativeHostContext(pi, ctx, config));
		releases[0]();
		releases[1]();
		assert.deepEqual(withWorkflowNativeHostContext(ctx, () => resolveWorkflowNativeHostContext(cwd)), config);
		releases[0]();
		assert.deepEqual(resolveWorkflowNativeHostContext(cwd), config);
	} finally {
		for (const release of releases) release();
	}
});
