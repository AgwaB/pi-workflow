import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { compileWorkflow } from "../../.tmp/unit/compiler.js";
import {
	buildDynamicGeneratedCompiledTask,
	normalizeDynamicAgentRequest,
} from "../../.tmp/unit/dynamic-generated-task-runtime.js";
import { runWorkflowSpec, scheduleRun } from "../../.tmp/unit/engine.js";
import { prepareDagTask } from "../../.tmp/unit/artifact-graph-runtime.js";
import { setSubagentApiForTests } from "../../.tmp/unit/subagent-backend.js";
import {
	createRunRecord,
	flushPendingIndexUpdatesForTests,
	writeRunRecord,
	writeStaticRunArtifacts,
	readRunRecord,
} from "../../.tmp/unit/store.js";
import { WORKFLOW_NATIVE_HOST_CONTEXT_ENV } from "../../.tmp/unit/workflow-native-host-context.js";
import { applyWorkflowNativeToolPolicy } from "../../.tmp/unit/workflow-native-tool-policy.js";

function nativeHost(cwd) {
	return {
		version: 1,
		cwd,
		agentDir: join(cwd, ".pi"),
		projectTrusted: true,
	};
}

function readerAgent(cwd) {
	return {
		name: "reader",
		displayName: "reader",
		description: "provider-free reader fixture",
		aliases: [],
		sourcePath: join(cwd, ".pi", "agents", "reader.md"),
		scope: "project",
		frontmatter: {},
		body: "Use repository evidence.",
		tools: ["read"],
		readOnly: true,
		maxSubagentDepth: 0,
	};
}

function baseSpec(stages) {
	return {
		schemaVersion: 1,
		name: "native-policy-fixture",
		defaults: {
			agent: "reader",
			tools: ["read"],
			readOnly: true,
			worktreePolicy: "auto",
		},
		artifactGraph: { stages },
	};
}

function taskById(compiled, id) {
	const task = compiled.tasks.find((candidate) => candidate.id === id);
	assert.ok(task, `missing compiled task ${id}`);
	return task;
}

async function compileFixture(cwd, spec, override = nativeHost(cwd)) {
	return compileWorkflow(spec, {
		cwd,
		task: "Check the native tool policy.",
		nativeHost: override,
		agentLoader: async () => readerAgent(cwd),
	});
}

async function writeReaderAgent(cwd) {
	const dir = join(cwd, ".pi", "agents");
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, "reader.md"),
		"---\ndescription: reader\ntools: [read]\nreadOnly: true\n---\n# Reader\n\nUse repository evidence.\n",
		"utf8",
	);
}

function dynamicRun(controller, host) {
	return {
		runId: "workflow_native_dynamic",
		nativeHost: host,
		provenance: {},
		tasks: [
			{
				specId: controller.id,
				stageId: controller.stageId,
				taskId: "controller",
				status: "running",
			},
		],
	};
}

function dynamicRequest(id, tools) {
	return normalizeDynamicAgentRequest({
		id,
		agent: "reader",
		prompt: "Inspect the target.",
		...(tools === undefined ? {} : { tools }),
		inputs: [],
		requiredReads: [],
		compact: true,
	});
}

function dynamicBuildInput(cwd, compiledFlow, controller, run, id, tools) {
	return {
		cwd,
		run,
		compiledFlow,
		controllerCompiledTask: controller,
		controllerSpecId: controller.id,
		controllerStageId: controller.stageId,
		generatedSpecId: `adaptive.${id}`,
		opId: `adaptive.controller:agent:${id}`,
		requestHash: `hash-${id}`,
		request: dynamicRequest(id, tools),
		dynamic: controller.dynamic,
	};
}

test("native policy classifies the full codemode/MCP surface conservatively", () => {
	const cwd = join(tmpdir(), "native-policy-classification");
	const policy = applyWorkflowNativeToolPolicy(
		["read", "mcp__fixture__inspect"],
		{ mcp__fixture__inspect: { classification: "read-only" } },
		nativeHost(cwd),
	);
	assert.deepEqual(policy.tools, [
		"read",
		"mcp__fixture__inspect",
		"codemode",
		"tool_search",
		"mcp__*",
		"list_mcp_resources",
		"list_mcp_resource_templates",
		"read_mcp_resource",
	]);
	for (const resource of ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]) {
		assert.equal(policy.toolProviders[resource].classification, "mutation-capable");
	}
	assert.equal(policy.nativeToolsEnabled, true);
	assert.equal(
		policy.toolProviders.mcp__fixture__inspect.classification,
		"mutation-capable",
	);
	assert.equal(policy.toolProviders.codemode.classification, "mutation-capable");
	assert.equal(policy.toolProviders.tool_search.classification, "read-only");
	assert.equal(
		policy.toolProviders["mcp__*"].classification,
		"mutation-capable",
	);
});


test("persisted native tasks without the eligibility marker regain safe launch policy without rewriting compilation", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "piwf-native-policy-resume-"));
	let launches = 0;
	setSubagentApiForTests({ async runSubagent() { launches++; throw new Error("unexpected model launch"); } });
	try {
		await writeReaderAgent(cwd);
		const spec = baseSpec([{ id: "main", type: "single", prompt: "Require approval.", approvalMode: "on-request" }]);
		const compiled = await compileFixture(cwd, spec, null);
		const frozen = JSON.stringify(compiled);
		const specPath = join(cwd, "spec.json");
		await writeFile(specPath, JSON.stringify(spec));
		const { run } = await createRunRecord(cwd, compiled, specPath);
		run.nativeHost = nativeHost(cwd);
		const prepared = await prepareDagTask(cwd, run, compiled, 0);
		assert.equal(prepared.runtime.nativeToolsEnabled, true);
		assert.ok(prepared.runtime.tools.includes("mcp__*"));
		assert.equal(prepared.safety.capability, "mutation-capable");
		assert.equal(prepared.safety.sharedCwdSafe, false);
		assert.equal(prepared.safety.requiresWorktree, true);
		assert.equal(prepared.safety.permission.statusDetail, "pending_approval");
		assert.equal(JSON.stringify(compiled), frozen);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);
		await scheduleRun(cwd, run.runId);
		const persisted = await readRunRecord(cwd, run.runId);
		assert.equal(persisted.tasks[0].status, "blocked");
		assert.equal(persisted.tasks[0].statusDetail, "pending_approval");
		assert.equal(launches, 0);
		assert.deepEqual(JSON.parse(await readFile(join(cwd, ".pi", "workflows", run.runId, "compiled.json"), "utf8")), JSON.parse(frozen));
	} finally {
		setSubagentApiForTests(undefined);
		await flushPendingIndexUpdatesForTests();
		await rm(cwd, { recursive: true, force: true });
	}
});


test("nested engine compilation treats persisted parent nativeHost absence as authoritative", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "piwf-native-policy-parent-"));
	const priorContext = process.env[WORKFLOW_NATIVE_HOST_CONTEXT_ENV];
	try {
		const agentDir = join(cwd, ".pi", "agents");
		await mkdir(agentDir, { recursive: true });
		await writeFile(
			join(agentDir, "custom.md"),
			"---\ndescription: custom\ntools: [custom_tool]\nreadOnly: false\n---\n# Custom\n",
			"utf8",
		);
		const spec = {
			schemaVersion: 1,
			defaults: { agent: "custom", tools: ["custom_tool"] },
			artifactGraph: {
				stages: [{ id: "blocked", type: "single", prompt: "Stay blocked." }],
			},
		};
		const specPath = join(cwd, "nested.json");
		await writeFile(specPath, JSON.stringify(spec), "utf8");
		delete process.env[WORKFLOW_NATIVE_HOST_CONTEXT_ENV];
		const parentCompiled = await compileWorkflow(spec, {
			cwd,
			specPath,
			nativeHost: null,
		});
		const { run: parent } = await createRunRecord(cwd, parentCompiled, specPath, {
			runId: "workflow_native_legacy_parent",
		});
		await writeRunRecord(cwd, parent);

		process.env[WORKFLOW_NATIVE_HOST_CONTEXT_ENV] = JSON.stringify(
			nativeHost(cwd),
		);
		const child = await runWorkflowSpec(specPath, cwd, {
			runId: "workflow_native_legacy_child",
			parentRunId: parent.runId,
			task: "Do not inherit the ambient host.",
		});
		assert.equal(child.nativeHost, undefined);
		const persisted = JSON.parse(
			await readFile(
				join(cwd, ".pi", "workflows", child.runId, "compiled.json"),
				"utf8",
			),
		);
		const task = taskById(persisted, "blocked.main");
		assert.deepEqual(task.runtime.tools, ["custom_tool"]);
		assert.equal(Object.hasOwn(task.runtime, "nativeToolsEnabled"), false);
	} finally {
		if (priorContext === undefined)
			delete process.env[WORKFLOW_NATIVE_HOST_CONTEXT_ENV];
		else process.env[WORKFLOW_NATIVE_HOST_CONTEXT_ENV] = priorContext;
		await flushPendingIndexUpdatesForTests();
		await rm(cwd, { recursive: true, force: true });
	}
});

test("dynamic generated tasks assess expanded tools and do not upgrade legacy controllers", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "piwf-native-policy-dynamic-"));
	try {
		await writeReaderAgent(cwd);
		const host = nativeHost(cwd);
		const compiled = await compileWorkflow(
			baseSpec([
				{
					id: "adaptive",
					type: "dynamic",
					dynamic: {
						uses: "./controller.mjs",
						permissions: {
							approval: "auto",
							allowDynamicRoles: true,
							allowDynamicTools: true,
						},
						decisionLoop: {
							allowedAgents: ["reader"],
							allowedTools: ["read"],
						},
					},
				},
			]),
			{ cwd, task: "Run dynamic work.", nativeHost: host },
		);
		const controller = taskById(compiled, "adaptive.controller");
		assert.equal(controller.runtime.nativeToolsEnabled, true);
		assert.ok(controller.runtime.tools.includes("codemode"));
		const run = dynamicRun(controller, host);

		const generated = await buildDynamicGeneratedCompiledTask(
			dynamicBuildInput(cwd, compiled, controller, run, "worker", ["read"]),
		);
		assert.deepEqual(generated.runtime.tools, [
			"read",
			"codemode",
			"tool_search",
			"mcp__*",
			"list_mcp_resources",
			"list_mcp_resource_templates",
			"read_mcp_resource",
		]);
		assert.equal(generated.runtime.nativeToolsEnabled, true);
		assert.equal(generated.safety.capability, "mutation-capable");
		assert.equal(generated.safety.sharedCwdSafe, false);
		assert.equal(generated.safety.requiresWorktree, true);
		assert.equal(generated.safety.worktreePolicy, "on");

		const empty = await buildDynamicGeneratedCompiledTask(
			dynamicBuildInput(cwd, compiled, controller, run, "empty", []),
		);
		assert.deepEqual(empty.runtime.tools, []);
		assert.equal(empty.runtime.nativeToolsEnabled, false);
		assert.equal(empty.safety.capability, "read-only");
		assert.equal(empty.safety.requiresWorktree, false);

		const persisted = JSON.parse(JSON.stringify(generated));
		assert.equal(persisted.runtime.nativeToolsEnabled, true);
		assert.deepEqual(persisted.runtime.tools, generated.runtime.tools);
		assert.deepEqual(
			persisted.runtime.toolProviders,
			generated.runtime.toolProviders,
		);

		const legacyController = structuredClone(controller);
		delete legacyController.runtime.nativeToolsEnabled;
		legacyController.runtime.tools = ["read"];
		delete legacyController.runtime.toolProviders;
		const legacyFlow = { ...compiled, tasks: [legacyController] };
		const resumedNativeChild = await buildDynamicGeneratedCompiledTask(
			dynamicBuildInput(cwd, legacyFlow, legacyController, dynamicRun(legacyController, host), "resumed-native", ["read"]),
		);
		assert.equal(resumedNativeChild.safety.capability, "mutation-capable");
		assert.equal(resumedNativeChild.safety.requiresWorktree, true);
		assert.ok(resumedNativeChild.runtime.tools.includes("mcp__*"));
		const legacyRun = dynamicRun(legacyController, undefined);
		const legacyChild = await buildDynamicGeneratedCompiledTask(
			dynamicBuildInput(cwd, legacyFlow, legacyController, legacyRun, "legacy", [
				"read",
			]),
		);
		assert.deepEqual(legacyChild.runtime.tools, ["read"]);
		assert.equal(Object.hasOwn(legacyChild.runtime, "nativeToolsEnabled"), false);
		assert.equal(legacyChild.safety.capability, "read-only");
		assert.equal(legacyChild.safety.requiresWorktree, false);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
