import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { parseArtifactGraphWorkflowSpec } from "../../.tmp/unit/artifact-graph-schema.js";
import { compileWorkflow } from "../../.tmp/unit/compiler.js";
import { buildDynamicGeneratedCompiledTask } from "../../.tmp/unit/dynamic-generated-task-runtime.js";
import { applyWorkflowExecutionProfile } from "../../.tmp/unit/execution-profile.js";
import {
	createLaunchBootstrapProvenance,
	recordLaunchBootstrapProvenance,
} from "../../.tmp/unit/launch-bootstrap-provenance.js";
import { createTaskRunRecord } from "../../.tmp/unit/store.js";
import {
	assertSubagentExtensionsLoadable,
	prepareSubagentTaskLaunch,
} from "../../.tmp/unit/subagent-backend.js";
import {
	applyWorkflowFastServiceTier,
	buildWorkflowFastProviderOptions,
	createWorkflowFastProviderStream,
	registerWorkflowFastModeExtension,
	resolveWorkflowFastModeConfig,
	workflowFastEligibleModelIds,
	WORKFLOW_FAST_SERVICE_TIER,
} from "../../.tmp/unit/workflow-fast-mode-extension.js";
import { workflowAutoLaunchBindingSettings } from "../../.tmp/unit/workflow-auto-binding.js";
import { selectWorkflowRuntime } from "../../.tmp/unit/workflow-runtime.js";

const ROOT = mkdtempSync(join(tmpdir(), "pi-workflow-fast-mode-"));

after(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

function project() {
	const cwd = mkdtempSync(join(ROOT, "project-"));
	const agentDir = join(cwd, ".pi", "agents");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "fast-worker.md"),
		`---\ndescription: Fast worker\ntools: [read]\nreadOnly: true\n---\nUse repository evidence.\n`,
	);
	writeFileSync(
		join(agentDir, "fast-agent-default.md"),
		`---\ndescription: Fast worker with task defaults\ntools: [read]\nreadOnly: true\nmodel: ${CODEX_FAST_MODEL.fullId}\nfast: on\n---\nUse repository evidence.\n`,
	);
	return cwd;
}

function model(fullId, api) {
	const slash = fullId.indexOf("/");
	return {
		provider: fullId.slice(0, slash),
		id: fullId.slice(slash + 1),
		fullId,
		api,
		reasoning: true,
	};
}

function workflow(defaults = {}, stage = {}) {
	return {
		schemaVersion: 1,
		name: "fast-mode-test",
		defaults: {
			agent: "fast-worker",
			tools: ["read"],
			readOnly: true,
			...defaults,
		},
		artifactGraph: {
			stages: [{ id: "main", type: "single", prompt: "Inspect.", ...stage }],
		},
	};
}

const CODEX_FAST_MODEL = model(
	"openai-codex/gpt-5.6-sol",
	"openai-codex-responses",
);

test("fast:on parses and runtime layering preserves explicit inherit/off semantics", () => {
	assert.deepEqual(workflowFastEligibleModelIds(), [
		"openai/gpt-5.4",
		"openai/gpt-5.5",
		"openai-codex/gpt-5.4",
		"openai-codex/gpt-5.5",
		"openai-codex/gpt-5.6-sol",
		"openai-codex/gpt-5.6-terra",
		"openai-codex/gpt-5.6-luna",
		"openai-codex/gpt-6-astra",
		"openai-codex/gpt-6-sol",
		"openai-codex/gpt-6-luna",
	]);
	assert.doesNotThrow(() =>
		parseArtifactGraphWorkflowSpec(
			workflow({ model: CODEX_FAST_MODEL.fullId, fast: "on" }),
		),
	);
	assert.deepEqual(
		selectWorkflowRuntime({ fast: "inherit" }, { fast: "on" }),
		{ fast: "on" },
	);
	assert.deepEqual(
		selectWorkflowRuntime({ fast: "off" }, { fast: "on" }),
		{ fast: "off" },
	);
	assert.throws(
		() =>
			resolveWorkflowFastModeConfig({
				fast: "on",
				model: CODEX_FAST_MODEL.fullId,
			}),
		/requires a resolved API binding/,
	);
	const openAiModel = model("openai/gpt-5.4", "openai-responses");
	assert.deepEqual(
		resolveWorkflowFastModeConfig(
			{ fast: "on", model: openAiModel.fullId },
			[openAiModel],
		),
		{
			provider: "openai",
			model: "gpt-5.4",
			api: "openai-responses",
			serviceTier: "priority",
		},
	);
	assert.deepEqual(
		workflowAutoLaunchBindingSettings({
			runtimeDefaults: { model: CODEX_FAST_MODEL.fullId, fast: "on" },
			runtimeOverrides: { fast: "inherit" },
		}),
		{
			executionProfile: null,
			executionProfileOverride: null,
			runtimeDefaults: {
				model: CODEX_FAST_MODEL.fullId,
				thinking: null,
				fast: "on",
			},
			runtimeOverrides: {
				model: null,
				thinking: null,
				fast: "inherit",
			},
		},
	);
});

test("compiler accepts an eligible Fast model and rejects unresolved or unsupported bindings", async () => {
	const cwd = project();
	const compiled = await compileWorkflow(
		workflow({ model: CODEX_FAST_MODEL.fullId, fast: "on" }),
		{ cwd, task: "Check fast mode", availableModels: [CODEX_FAST_MODEL] },
	);
	assert.equal(compiled.tasks[0].runtime.model, CODEX_FAST_MODEL.fullId);
	assert.equal(compiled.tasks[0].runtime.api, CODEX_FAST_MODEL.api);
	assert.equal(compiled.tasks[0].runtime.fast, "on");
	const taskRecord = createTaskRunRecord(
		cwd,
		"workflow_fast_record",
		compiled.tasks[0],
		0,
	);
	assert.equal(taskRecord.runtime.api, CODEX_FAST_MODEL.api);
	assert.equal(taskRecord.runtime.fast, "on");
	const baseline = await compileWorkflow(
		workflow({ model: CODEX_FAST_MODEL.fullId }),
		{ cwd, task: "Check default off", availableModels: [CODEX_FAST_MODEL] },
	);
	assert.equal(baseline.tasks[0].runtime.fast, undefined);
	assert.equal(baseline.tasks[0].runtime.api, undefined);

	const agentDefault = await compileWorkflow(
		workflow({ agent: "fast-agent-default" }),
		{ cwd, task: "Check agent opt-in", availableModels: [CODEX_FAST_MODEL] },
	);
	assert.equal(agentDefault.tasks[0].runtime.model, CODEX_FAST_MODEL.fullId);
	assert.equal(agentDefault.tasks[0].runtime.api, CODEX_FAST_MODEL.api);
	assert.equal(agentDefault.tasks[0].runtime.fast, "on");

	const disabled = await compileWorkflow(
		workflow(
			{ model: CODEX_FAST_MODEL.fullId, fast: "on" },
			{ fast: "off" },
		),
		{ cwd, task: "Check opt-out", availableModels: [CODEX_FAST_MODEL] },
	);
	assert.equal(disabled.tasks[0].runtime.fast, "off");

	const profileSpec = workflow({ model: CODEX_FAST_MODEL.fullId, fast: "off" });
	profileSpec.executionProfiles = { accelerated: { main: { fast: "on" } } };
	parseArtifactGraphWorkflowSpec(profileSpec);
	const profiled = await compileWorkflow(
		applyWorkflowExecutionProfile(profileSpec, "accelerated", undefined).spec,
		{ cwd, task: "Check profile opt-in", availableModels: [CODEX_FAST_MODEL] },
	);
	assert.equal(profiled.tasks[0].runtime.fast, "on");

	const foreachSpec = workflow({
		model: CODEX_FAST_MODEL.fullId,
		fast: "off",
	});
	foreachSpec.artifactGraph.stages = [
		{ id: "source", type: "single", prompt: "Produce items." },
		{
			id: "fanout",
			type: "foreach",
			from: { source: "source", path: "$.items" },
			each: { prompt: "Inspect ${item}.", fast: "on" },
		},
	];
	const foreachCompiled = await compileWorkflow(
		parseArtifactGraphWorkflowSpec(foreachSpec),
		{ cwd, task: "Check foreach opt-in", availableModels: [CODEX_FAST_MODEL] },
	);
	assert.equal(
		foreachCompiled.tasks.find((task) => task.stageId === "fanout").runtime.fast,
		"on",
	);
	const inheritedEachSpec = workflow({
		model: CODEX_FAST_MODEL.fullId,
		fast: "on",
	});
	inheritedEachSpec.artifactGraph.stages = [
		{ id: "source", type: "single", prompt: "Produce items." },
		{
			id: "fanout",
			type: "foreach",
			fast: "off",
			from: { source: "source", path: "$.items" },
			each: { prompt: "Inspect ${item}.", fast: "inherit" },
		},
	];
	const inheritedEach = await compileWorkflow(
		parseArtifactGraphWorkflowSpec(inheritedEachSpec),
		{ cwd, task: "Check foreach inheritance", availableModels: [CODEX_FAST_MODEL] },
	);
	assert.equal(
		inheritedEach.tasks.find((task) => task.stageId === "fanout").runtime.fast,
		"off",
	);

	const unsupported = model("anthropic/claude-opus-4-6", "anthropic-messages");
	await assert.rejects(
		compileWorkflow(workflow({ model: unsupported.fullId, fast: "on" }), {
			cwd,
			task: "Reject unsupported provider",
			availableModels: [unsupported],
		}),
		/fast:on is not supported for model "anthropic\/claude-opus-4-6"/,
	);
	await assert.rejects(
		compileWorkflow(workflow({ fast: "on" }), {
			cwd,
			task: "Reject unresolved model",
		}),
		/requires a resolved OpenAI model/,
	);
	await assert.rejects(
		compileWorkflow(
			workflow({ model: CODEX_FAST_MODEL.fullId, fast: "on" }),
			{
				cwd,
				task: "Reject API mismatch",
				availableModels: [
					{ ...CODEX_FAST_MODEL, api: "openai-responses" },
				],
			},
		),
		/requires openai-codex-responses.*registered openai-responses/,
	);
});

test("dynamic generated tasks inherit and validate Fast runtime settings", async () => {
	const cwd = project();
	const controllerCompiledTask = {
		id: "adaptive.controller",
		key: "adaptive.controller",
		specId: "adaptive.controller",
		taskId: "controller",
		stageId: "adaptive",
		agent: "dynamic",
		agentPath: "./helpers/controller.mjs",
		agentSystemPrompt: "",
		roleNames: [],
		task: "Run controller.",
		cwd,
		explicitCwd: false,
		explicitWorktreePolicy: false,
		runtime: {
			model: CODEX_FAST_MODEL.fullId,
			api: CODEX_FAST_MODEL.api,
			fast: "on",
			approvalMode: "non-interactive",
		},
		safety: {
			readOnlyDeclared: false,
			capability: "mutation-capable",
			sharedCwdSafe: false,
			worktreePolicy: "off",
			requiresWorktree: false,
			permission: { status: "pending" },
		},
		compiledPrompt: "Run controller.",
		kind: "dynamic",
	};
	const generated = await buildDynamicGeneratedCompiledTask({
		cwd,
		run: {
			runId: "workflow_dynamic_fast_mode",
			provenance: {},
			tasks: [
				{
					specId: "adaptive.controller",
					stageId: "adaptive",
					taskId: "controller",
					status: "running",
				},
			],
		},
		compiledFlow: { tasks: [controllerCompiledTask] },
		controllerCompiledTask,
		controllerSpecId: "adaptive.controller",
		controllerStageId: "adaptive",
		generatedSpecId: "adaptive.worker",
		opId: "op-fast",
		requestHash: "hash-fast",
		request: {
			id: "worker",
			agent: "fast-worker",
			profile: "worker",
			prompt: "Inspect the target.",
			inputs: [],
		},
		dynamic: {
			uses: "./helpers/controller.mjs",
			mode: "graph-splice",
			budget: { maxAgents: 10, maxConcurrency: 2, maxRuntimeMs: 1000 },
			permissions: {
				approval: "auto",
				allowDynamicRoles: true,
				allowDynamicTools: true,
			},
			helpers: {},
			workflows: {},
			decisionLoop: {
				workerDefaults: { tools: ["read"] },
				allowedAgents: [],
				allowedOutputProfiles: [],
			},
		},
	});
	assert.equal(generated.runtime.model, CODEX_FAST_MODEL.fullId);
	assert.equal(generated.runtime.api, CODEX_FAST_MODEL.api);
	assert.equal(generated.runtime.fast, "on");
});

test("task launch prepares a sealed generated Fast extension only for fast:on", async () => {
	const cwd = project();
	const compiled = await compileWorkflow(
		workflow({ model: CODEX_FAST_MODEL.fullId, fast: "on" }),
		{ cwd, task: "Prepare launch", availableModels: [CODEX_FAST_MODEL] },
	);
	const run = { runId: "run_fast_mode" };
	const task = {
		taskId: "main",
		files: { result: ".pi/workflows/run_fast_mode/tasks/main/result.json" },
	};
	const prepared = await prepareSubagentTaskLaunch(
		cwd,
		run,
		task,
		compiled.tasks[0],
	);
	const generated = prepared.generatedExtensions.find(
		(entry) => entry.kind === "openai-fast",
	);
	assert.ok(generated);
	assert.equal(readFileSync(generated.path, "utf8"), generated.expectedBytes);
	assert.equal(prepared.extensions.at(-1), generated.path);
	assert.deepEqual(generated.config, {
		provider: "openai-codex",
		model: "gpt-5.6-sol",
		api: "openai-codex-responses",
		serviceTier: "priority",
	});
	await assertSubagentExtensionsLoadable({
		cwd,
		extensions: [generated.path],
	});

	const mutatorPath = join(cwd, "ambient-fast-tier-mutator.ts");
	writeFileSync(
		mutatorPath,
		`export default function mutateFastTier(pi) {\n\tpi.on("before_provider_request", (event) => ({ ...event.payload, service_tier: "default" }));\n}\n`,
	);
	const piSdk = await import("@earendil-works/pi-coding-agent");
	const loaderAgentDir = join(cwd, "isolated-agent-dir");
	mkdirSync(loaderAgentDir, { recursive: true });
	const loader = new piSdk.DefaultResourceLoader({
		cwd,
		agentDir: loaderAgentDir,
		additionalExtensionPaths: [generated.path, mutatorPath],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	const loaded = loader.getExtensions();
	assert.deepEqual(loaded.errors, []);
	const fastLoaded = loaded.extensions.find((entry) =>
		entry.path.endsWith("workflow-fast-mode-extension.ts"),
	);
	assert.ok(fastLoaded);
	const sessionHandler = fastLoaded.handlers.get("session_start")?.[0];
	assert.equal(typeof sessionHandler, "function");
	let registeredProvider;
	let providerOptions;
	let loaderAborted = false;
	const payloadModel = {
		provider: generated.config.provider,
		id: generated.config.model,
		api: generated.config.api,
	};
	const extensionContext = {
		model: payloadModel,
		abort() {
			loaderAborted = true;
		},
		modelRegistry: {
			registerProvider(provider, providerConfig) {
				registeredProvider = { provider, providerConfig };
			},
		},
	};
	await sessionHandler({ type: "session_start" }, extensionContext);
	const runPayloadChain = async (initialPayload) => {
		let payload = initialPayload;
		for (const extension of loaded.extensions) {
			for (const callback of extension.handlers.get("before_provider_request") ?? []) {
				const replacement = await callback(
					{ type: "before_provider_request", payload },
					extensionContext,
				);
				if (replacement !== undefined) payload = replacement;
			}
		}
		return payload;
	};
	assert.equal(registeredProvider.provider, generated.config.provider);
	assert.equal(registeredProvider.providerConfig.api, generated.config.api);
	assert.equal(typeof registeredProvider.providerConfig.streamSimple, "function");
	const guardedStream = createWorkflowFastProviderStream(
		generated.config,
		() => {
			loaderAborted = true;
		},
		{
			openaiResponses() {
				throw new Error("unexpected OpenAI Responses stream");
			},
			openaiCodexResponses(_model, _requestContext, options) {
				providerOptions = options;
				return "loader-guarded-stream";
			},
		},
	);
	assert.equal(
		guardedStream(payloadModel, {}, { onPayload: runPayloadChain }),
		"loader-guarded-stream",
	);
	assert.deepEqual(
		await providerOptions.onPayload(
			{ model: generated.config.model, store: false },
			payloadModel,
		),
		{
			model: generated.config.model,
			store: false,
			service_tier: "priority",
		},
	);
	assert.equal(loaderAborted, false);

	const provenanceTask = {
		...task,
		specId: compiled.tasks[0].specId,
		cwd,
		worktree: {
			enabled: false,
			path: null,
			branch: null,
			baseCwd: null,
			warning: null,
		},
	};
	const provenance = await createLaunchBootstrapProvenance(
		cwd,
		{
			...run,
			type: "artifact-graph",
			specPath: ".pi/workflows/fast-mode.yaml",
			backend: { type: "subagent", mode: "headless" },
		},
		provenanceTask,
		compiled.tasks[0],
		"subagent",
		prepared,
	);
	assert.equal(provenance.effectivePolicy.fast, "on");
	assert.equal(provenance.effectivePolicy.api, CODEX_FAST_MODEL.api);
	assert.equal(
		provenance.effectiveLaunch.extensions.some(
			(entry) => entry.generated?.kind === "openai-fast",
		),
		true,
	);
	recordLaunchBootstrapProvenance(provenanceTask, provenance);
	assert.equal(provenanceTask.launchBootstrap.records.length, 1);

	const disabled = await prepareSubagentTaskLaunch(
		cwd,
		{ runId: "run_fast_off" },
		{
			taskId: "main-off",
			files: { result: ".pi/workflows/run_fast_off/tasks/main/result.json" },
		},
		{
			...compiled.tasks[0],
			runtime: { ...compiled.tasks[0].runtime, fast: "off" },
		},
	);
	assert.equal(
		disabled.generatedExtensions.some((entry) => entry.kind === "openai-fast"),
		false,
	);
});

test("generated Fast hook preserves payload fields, forces priority, and checks the task model", async () => {
	const config = resolveWorkflowFastModeConfig(
		{ fast: "on", model: CODEX_FAST_MODEL.fullId },
		[CODEX_FAST_MODEL],
	);
	assert.ok(config);
	assert.equal(WORKFLOW_FAST_SERVICE_TIER, "priority");
	assert.deepEqual(
		applyWorkflowFastServiceTier(
			{
				model: "gpt-5.6-sol",
				input: [{ role: "user", content: "hello" }],
				metadata: { trace: "keep" },
				service_tier: "default",
			},
			config,
		),
		{
			model: "gpt-5.6-sol",
			input: [{ role: "user", content: "hello" }],
			metadata: { trace: "keep" },
			service_tier: "priority",
		},
	);

	const payloadModel = {
		provider: config.provider,
		id: config.model,
		api: config.api,
	};
	const guardedOptions = buildWorkflowFastProviderOptions(
		{
			marker: "preserved",
			onPayload: async (payload) => ({
				...payload,
				service_tier: "default",
			}),
		},
		config,
	);
	assert.equal(guardedOptions.marker, "preserved");
	assert.equal(guardedOptions.serviceTier, "priority");
	assert.deepEqual(
		await guardedOptions.onPayload(
			{ model: config.model, store: false },
			payloadModel,
		),
		{ model: config.model, store: false, service_tier: "priority" },
	);

	const openAiModel = model("openai/gpt-5.4", "openai-responses");
	const openAiConfig = resolveWorkflowFastModeConfig(
		{ fast: "on", model: openAiModel.fullId },
		[openAiModel],
	);
	let openAiOptions;
	const openAiStream = createWorkflowFastProviderStream(openAiConfig, undefined, {
		openaiResponses(_model, _requestContext, options) {
			openAiOptions = options;
			return "openai-guarded-stream";
		},
		openaiCodexResponses() {
			throw new Error("unexpected OpenAI Codex Responses stream");
		},
	});
	assert.equal(
		openAiStream(
			{ ...openAiModel, id: "gpt-5.4" },
			{},
			{ reasoning: "high" },
		),
		"openai-guarded-stream",
	);
	assert.equal(openAiOptions.reasoningEffort, "high");
	assert.equal(openAiOptions.serviceTier, "priority");
	assert.deepEqual(
		await openAiOptions.onPayload({ model: "gpt-5.4" }, openAiModel),
		{ model: "gpt-5.4", service_tier: "priority" },
	);

	const handlers = new Map();
	let registeredProvider;
	let providerOptions;
	registerWorkflowFastModeExtension(
		{
			on(event, callback) {
				handlers.set(event, callback);
			},
		},
		config,
		{
			openaiResponses() {
				throw new Error("unexpected OpenAI Responses stream");
			},
			openaiCodexResponses(_model, _requestContext, options) {
				providerOptions = options;
				return "guarded-stream";
			},
		},
	);
	const handler = handlers.get("before_provider_request");
	const sessionHandler = handlers.get("session_start");
	assert.equal(typeof handler, "function");
	assert.equal(typeof sessionHandler, "function");
	const context = { model: payloadModel };
	assert.deepEqual(
		await handler({ payload: { model: config.model, store: false } }, context),
		{ model: config.model, store: false, service_tier: "priority" },
	);
	let aborted = false;
	assert.throws(
		() =>
			handler(
				{ payload: { model: "gpt-5.5" } },
				{
					...context,
					abort() {
						aborted = true;
					},
				},
			),
		/payload binding mismatch/,
	);
	assert.equal(aborted, true);
	aborted = false;
	assert.throws(
		() =>
			handler(
				{ payload: { model: "claude" } },
				{
					model: {
						provider: "anthropic",
						id: "claude-opus-4-6",
						api: "anthropic-messages",
					},
					abort() {
						aborted = true;
					},
				},
			),
		/launch binding mismatch/,
	);
	assert.equal(aborted, true);

	aborted = false;
	sessionHandler(
		{},
		{
			abort() {
				aborted = true;
			},
			modelRegistry: {
				registerProvider(provider, providerConfig) {
					registeredProvider = { provider, providerConfig };
				},
			},
		},
	);
	assert.equal(registeredProvider.provider, config.provider);
	assert.equal(registeredProvider.providerConfig.api, config.api);
	assert.equal(
		registeredProvider.providerConfig.streamSimple(
			payloadModel,
			{},
			{
				onPayload: async (payload) => ({
					...payload,
					service_tier: "default",
				}),
			},
		),
		"guarded-stream",
	);
	assert.equal(providerOptions.serviceTier, "priority");
	assert.deepEqual(
		await providerOptions.onPayload(
			{ model: config.model, store: false },
			payloadModel,
		),
		{ model: config.model, store: false, service_tier: "priority" },
	);
	registeredProvider.providerConfig.streamSimple(payloadModel, {}, {
		onPayload: async (payload) => ({ ...payload, model: "gpt-5.5" }),
	});
	await assert.rejects(
		providerOptions.onPayload(
			{ model: config.model, store: false },
			payloadModel,
		),
		/payload binding mismatch/,
	);
	assert.equal(aborted, true);
});
