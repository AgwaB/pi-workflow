import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadAgentByName, parseAgentMarkdown } from "../../.tmp/unit/agents.js";
import { compileWorkflow } from "../../.tmp/unit/compiler.js";
import {
	buildRunSourceContext,
	evaluateLoopUntilCondition,
	formatRun,
	resumeRun,
	runDynamicControllerEngineIntegrityCheckForTests,
	runDynamicTask,
	runWorkflow,
	runWorkflowSpec,
	scheduleRun,
	waitForRun,
} from "../../.tmp/unit/engine.js";
import {
	notifyUnfinishedRuns,
	registerWorkflowNaturalLanguageTools,
	WORKFLOW_DYNAMIC_TOOL,
	WORKFLOW_LIST_TOOL,
	WORKFLOW_RUN_TOOL,
	workflowArgumentCompletions,
	parseWorkflowDynamicArgs,
	parseWorkflowRunArgs,
} from "../../.tmp/unit/extension.js";
import {
	listWorkflows,
	resolveWorkflowRef,
} from "../../.tmp/unit/workflow-specs.js";
import { WorkflowView } from "../../.tmp/unit/workflow-view.js";
import { resolveWorkflowRuntime } from "../../.tmp/unit/workflow-runtime.js";
import {
	loadWorkflow,
	parseWorkflow as parsePublicWorkflow,
} from "../../.tmp/unit/schema.js";
import {
	acquireSupervisorLease,
	createRunRecord,
	createWorkflowRunRecord,
	deriveRunStatus,
	heartbeatSupervisorLease,
	readRunRecord,
	resetTaskForResume,
	resolveFlowsCwd,
	setTaskTerminal,
	supervisorLeasePath,
	updateIndex,
	workflowProcessRoleForTests,
	workflowSupervisorOwnerIdForTests,
	writeJsonAtomic,
	writeRunRecord,
	writeStaticRunArtifacts,
} from "../../.tmp/unit/store.js";
import {
	WorkflowValidationError,
	WORKFLOW_RUN_TYPE,
} from "../../.tmp/unit/types.js";
import {
	canStageProceedAfterPreviousFailure,
	shouldScheduleAfterStageFailure,
} from "../../.tmp/unit/workflow-runtime.js";
import { deriveWorkflowStatus, summarizeTasks } from "../../.tmp/unit/store.js";
import {
	assertWorkflowActionAllowedForRole,
	assertWorkflowToolAllowedForRole,
	getWorkflowProcessRole,
	isWorkflowSupervisorEnabled,
	workflowWorkerEnvPrefix,
} from "../../.tmp/unit/process-role.js";
import {
	buildSourceContextPacket,
	summarizeWorkflowTelemetry,
	validateStructuredContract,
} from "../../.tmp/unit/workflow-artifacts.js";
import { formatArtifactGraphSourceContext } from "../../.tmp/unit/artifact-graph-runtime.js";
import {
	loadWorkflowHelper,
	resolveWorkflowHelperRef,
} from "../../.tmp/unit/workflow-helpers.js";
import { loadDynamicController } from "../../.tmp/unit/dynamic-loader.js";
import {
	appendDynamicEvent,
	dynamicEventsPath,
	hashDynamicRequest,
	readDynamicEvents,
} from "../../.tmp/unit/dynamic-events.js";
import {
	dynamicStatePath,
	readOrRebuildDynamicState,
	rebuildDynamicState,
	recordDynamicControllerPhase,
} from "../../.tmp/unit/dynamic-state.js";
import {
	dynamicLoopSignature,
	validateDynamicDecision,
	writeDynamicDecisionArtifacts,
} from "../../.tmp/unit/dynamic-decision.js";
import { runDynamicDecisionLoop } from "../../.tmp/unit/dynamic-decision-loop.js";
import {
	assembleDynamicStateIndex,
	extractDynamicStateArtifact,
	writeDynamicStateIndexArtifacts,
} from "../../.tmp/unit/dynamic-state-index.js";
import {
	handleWorkflowArtifactToolCall,
	listWorkflowArtifactSources,
	loadWorkflowSourceManifest,
	readWorkflowArtifactReadLedger,
} from "../../.tmp/unit/workflow-artifact-tool.js";
import {
	buildWorkflowArtifactExtensionWrapper,
	registerWorkflowArtifactTool,
	writeWorkflowArtifactExtensionWrapper,
} from "../../.tmp/unit/workflow-artifact-extension.js";
import {
	buildWorkflowOutputRetryInstructions,
	parseWorkflowOutput,
	writeWorkflowTaskArtifactBundle,
} from "../../.tmp/unit/workflow-output-artifacts.js";
import { registerWorkflowFetchCacheExtension } from "../../.tmp/unit/workflow-fetch-cache-extension.js";
import {
	createWorkflowWebSource,
	createWorkflowWebVisibleBudget,
	findWorkflowWebSourceByUrl,
	readWorkflowWebSourceSnippet,
	readWorkflowWebSource,
	readWorkflowWebSourceIndex,
	sanitizeUrlForModel,
	validateWorkflowWebUrl,
	writeWorkflowWebSource,
} from "../../.tmp/unit/workflow-web-source.js";
import { registerWorkflowWebSourceExtension } from "../../.tmp/unit/workflow-web-source-extension.js";
import { validateJsonSchema } from "../../.tmp/unit/json-schema.js";
import {
	launchSubagentTask,
	refreshRunFromSubagentArtifacts,
	setSubagentApiForTests,
} from "../../.tmp/unit/subagent-backend.js";

function makeProject() {
	return mkdtempSync(join(tmpdir(), "workflow-unit-"));
}

function writeAgent(cwd, name, tools = "read, grep, find, ls") {
	const dir = join(cwd, ".pi", "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${name}.md`),
		`---\ndescription: ${name}\ntools: [${tools
			.split(/,\s*/)
			.filter(Boolean)
			.map((tool) => JSON.stringify(tool))
			.join(
				", ",
			)}]\nreadOnly: true\n---\n# ${name}\n\nUse repository evidence.\n`,
	);
}

function isBundledPiWebAccessExtension(entry) {
	return /node_modules[\\/]pi-web-access[\\/]index\.ts$/.test(entry);
}

const parseWorkflow = parsePublicWorkflow;

function workflowSpec(agent = "unit-scout", extra = {}) {
	const {
		artifactGraph,
		defaults,
		tools,
		readOnly,
		model,
		thinking,
		fast,
		approvalMode,
		worktreePolicy,
		maxConcurrency,
		maxRuntimeMs,
		backend,
		...rest
	} = extra;
	const baseDefaults = {
		agent,
		readOnly: readOnly ?? true,
		tools: tools ?? ["read"],
		...(model !== undefined ? { model } : {}),
		...(thinking !== undefined ? { thinking } : {}),
		...(fast !== undefined ? { fast } : {}),
		...(approvalMode !== undefined ? { approvalMode } : {}),
		...(worktreePolicy !== undefined ? { worktreePolicy } : {}),
		...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
		...(maxRuntimeMs !== undefined ? { maxRuntimeMs } : {}),
		...(backend !== undefined ? { backend } : {}),
		...(defaults ?? {}),
	};
	const graph = artifactGraph ?? {
		stages: [{ id: "main", type: "single", prompt: "Do the work." }],
	};
	return {
		schemaVersion: 1,
		defaults: baseDefaults,
		artifactGraph: {
			...graph,
			stages: normalizeArtifactGraphStages(graph.stages ?? []),
		},
		...rest,
	};
}

function normalizeArtifactGraphStages(stages) {
	return stages.map((stage) => normalizeArtifactGraphStage(stage));
}

function normalizeArtifactGraphStage(stage) {
	const next = { ...stage };
	if (Array.isArray(next.stages))
		next.stages = normalizeArtifactGraphStages(next.stages);
	if (next.onExhausted)
		next.onExhausted = normalizeArtifactGraphStage(next.onExhausted);
	return next;
}

function artifactGraphWorkflowSpec(extra = {}) {
	return {
		schemaVersion: 1,
		name: "unit-artifact-graph",
		defaults: { agent: "unit-scout", readOnly: true, tools: ["read"] },
		artifactGraph: {
			stages: [
				{
					id: "main",
					type: "single",
					prompt: "Do the work.",
					output: {
						controlSchema: "./schemas/stage-control.schema.json",
						analysis: { required: true },
						refs: { required: true },
					},
				},
			],
		},
		...extra,
	};
}

function writeDefaultStageControlSchema(workflowRoot) {
	mkdirSync(join(workflowRoot, "schemas"), { recursive: true });
	writeFileSync(
		join(workflowRoot, "schemas", "stage-control.schema.json"),
		JSON.stringify({
			type: "object",
			required: ["schema", "digest"],
			properties: {
				schema: { type: "string" },
				digest: { type: "string" },
			},
		}),
	);
}

function bundledArtifactGraphSpecPaths() {
	return [
		"workflows/spec-review/spec.json",
		"workflows/deep-research/spec.json",
		"workflows/deep-review/spec.json",
		"workflows/impact-review/spec.json",
	];
}

function flattenArtifactGraphStages(stages) {
	return stages.flatMap((stage) => [
		stage,
		...(stage.stages ? flattenArtifactGraphStages(stage.stages) : []),
		...(stage.onExhausted
			? flattenArtifactGraphStages([stage.onExhausted])
			: []),
	]);
}

function loopWorkflowSpec(loop = {}) {
	return workflowSpec("unit-scout", {
		artifactGraph: {
			stages: [
				{
					id: "fix-loop",
					type: "loop",
					stages: [
						{
							id: "implement",
							type: "single",
							prompt: "Implement the requested fix.",
						},
						{
							id: "check",
							type: "single",
							prompt: "Check the fix.",
						},
					],
					maxRounds: 5,
					until: {
						all: [
							{ stage: "check", path: "$.status", equals: "pass" },
							{ stage: "check", path: "$.verdict", equals: "ACCEPT" },
						],
					},
					...loop,
				},
			],
		},
	});
}

function assertThrowsFlow(fn) {
	assert.throws(fn, WorkflowValidationError);
	try {
		fn();
	} catch (error) {
		return error;
	}
	throw new Error("expected throw");
}

function assertIssue(error, path, messagePart) {
	assert(error instanceof WorkflowValidationError);
	assert(
		error.issues.some(
			(issue) => issue.path === path && issue.message.includes(messagePart),
		),
		JSON.stringify(error.issues),
	);
}

async function createLoopRun(cwd, spec = loopWorkflowSpec()) {
	const compiled = await compileWorkflow(spec, {
		cwd,
		task: "Fix the loop target",
	});
	const { run } = await createWorkflowRunRecord(
		cwd,
		compiled,
		join(cwd, "workflows", "loop.json"),
	);
	await writeStaticRunArtifacts(cwd, run, compiled, spec);
	await writeRunRecord(cwd, run);
	return { compiled, run };
}

async function completeTask(
	cwd,
	task,
	structuredOutput = {},
	status = "completed",
) {
	setTaskTerminal(task, status, status, {
		exitCode: status === "completed" ? 0 : 1,
		lastMessage: status,
	});
	if (task.artifactGraph?.enabled && status === "completed") {
		const control = {
			schema: "stage-control-v1",
			digest: `${task.stageId ?? task.specId} completed`,
			...structuredOutput,
		};
		await writeWorkflowTaskArtifactBundle({
			taskDir: dirname(join(cwd, task.files.result)),
			rawOutput: [
				"<control>",
				JSON.stringify(control),
				"</control>",
				"<analysis>",
				`${task.stageId ?? task.specId} analysis`,
				"</analysis>",
				"<refs>",
				"[]",
				"</refs>",
			].join("\n"),
			completedAt: new Date().toISOString(),
		});
		return;
	}
	await writeJsonAtomic(join(cwd, task.files.result), {
		status,
		completedAt: new Date().toISOString(),
		exitCode: status === "completed" ? 0 : 1,
		structuredOutput,
	});
}

function taskBySpec(run, specId) {
	const task = run.tasks.find((item) => item.specId === specId);
	assert(task, `missing task ${specId}`);
	return task;
}

async function createDynamicControllerRun(cwd, controllerSource) {
	writeAgent(cwd, "unit-scout", "read");
	const workflowDir = join(cwd, "workflows", "bundle");
	mkdirSync(join(workflowDir, "helpers"), { recursive: true });
	const specPath = join(workflowDir, "spec.json");
	writeFileSync(
		join(workflowDir, "helpers", "controller.mjs"),
		controllerSource,
	);
	const spec = artifactGraphWorkflowSpec({
		artifactGraph: {
			stages: [
				{
					id: "adaptive",
					type: "dynamic",
					dynamic: { uses: "./helpers/controller.mjs" },
				},
			],
		},
	});
	writeFileSync(specPath, JSON.stringify(spec));
	const compiled = await compileWorkflow(spec, {
		cwd,
		task: "Review dynamically.",
		specPath,
	});
	const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
	await writeStaticRunArtifacts(cwd, run, compiled, spec);
	await writeRunRecord(cwd, run);
	return { compiled, run, spec, specPath, workflowDir };
}

test("dynamic controller engine guard reports stale missing runDecisionLoop wiring", async () => {
	const specificMessage =
		"incompatible or stale pi-workflow engine: dynamic controller context is missing runDecisionLoop (rebuild dist / reload workflow engine)";
	await assert.rejects(
		() =>
			runDynamicControllerEngineIntegrityCheckForTests({
				engineCapabilities: { decisionLoop: false },
				controllerSource: [
					"export default function controller(ctx) {",
					"  if (typeof ctx?.dynamic?.runDecisionLoop !== 'function') {",
					"    throw new Error('dynamic decision-loop helper is unavailable in controller context');",
					"  }",
					"  return ctx.dynamic.runDecisionLoop();",
					"}",
				].join("\n"),
			}),
		(error) => {
			assert(error instanceof Error);
			assert.equal(error.message, specificMessage);
			assert.doesNotMatch(error.message, /helper is unavailable/);
			return true;
		},
	);
});

function captureSubagentPrompts(prompts = []) {
	let launchCount = 0;
	setSubagentApiForTests({
		async runSubagent(options) {
			launchCount += 1;
			prompts.push(String(options.task ?? ""));
			return {
				runId: `run_stub_${launchCount}`,
				attemptId: `attempt_stub_${launchCount}`,
				status: "running",
			};
		},
		async getSubagentStatus() {
			return null;
		},
		async reconcileSubagentRun() {
			return {};
		},
		async interruptSubagent() {
			return {};
		},
	});
	return prompts;
}

function dagContainerRuntimeSpec({
	finalSourcePolicy,
	reportSourcePolicy,
} = {}) {
	return workflowSpec("unit-scout", {
		artifactGraph: {
			stages: [
				{
					id: "setup",
					type: "single",
					output: { format: "json" },
					prompt: "Setup.",
				},
				{
					id: "analysis",
					type: "dag",
					from: "setup",
					outputFrom: "final",
					stages: [
						{
							id: "scan",
							type: "single",
							output: { format: "json" },
							prompt: "Scan.",
						},
						{
							id: "review",
							type: "single",
							after: "scan",
							prompt: "Review.",
						},
						{
							id: "final",
							type: "reduce",
							from: ["scan", "review"],
							output: { format: "json" },
							prompt: "Finalize.",
							...(finalSourcePolicy ? { sourcePolicy: finalSourcePolicy } : {}),
						},
					],
				},
				{
					id: "report",
					type: "reduce",
					from: "analysis",
					prompt: "Report.",
					...(reportSourcePolicy ? { sourcePolicy: reportSourcePolicy } : {}),
				},
			],
		},
	});
}

test("shared status helpers derive canonical task summaries", () => {
	assert.deepEqual(
		summarizeTasks([
			{ status: "completed" },
			{ status: "blocked" },
			{ status: "pending" },
		]),
		{
			total: 3,
			pending: 1,
			running: 0,
			blocked: 1,
			completed: 1,
			failed: 0,
			skipped: 0,
			interrupted: 0,
		},
	);
	assert.equal(
		deriveWorkflowStatus({
			total: 2,
			pending: 1,
			running: 0,
			blocked: 1,
			completed: 0,
			failed: 0,
			skipped: 0,
			interrupted: 0,
		}),
		"blocked",
	);
	// blocked outranks running so supervisors surface stuck runs instead of polling forever
	assert.equal(
		deriveWorkflowStatus({
			total: 2,
			pending: 0,
			running: 1,
			blocked: 1,
			completed: 0,
			failed: 0,
			skipped: 0,
			interrupted: 0,
		}),
		"blocked",
	);
});

test("workflow process role helpers default to supervisor and honor worker/disabled", () => {
	assert.equal(getWorkflowProcessRole({}), "supervisor");
	assert.equal(
		getWorkflowProcessRole({ PI_WORKFLOW_ROLE: "worker" }),
		"worker",
	);
	assert.equal(
		getWorkflowProcessRole({ PI_WORKFLOW_ROLE: "disabled" }),
		"disabled",
	);
	assert.equal(
		getWorkflowProcessRole({ PI_WORKFLOW_ROLE: "surprise" }),
		"supervisor",
	);
	assert.equal(
		isWorkflowSupervisorEnabled({ PI_WORKFLOW_ROLE: "worker" }),
		false,
	);
	assert.equal(workflowWorkerEnvPrefix(), "PI_WORKFLOW_ROLE=worker");
});

test("worker and disabled roles block supervisor workflow actions", () => {
	const originalRole = process.env.PI_WORKFLOW_ROLE;
	try {
		process.env.PI_WORKFLOW_ROLE = "worker";
		assert.doesNotThrow(() => assertWorkflowActionAllowedForRole("help"));
		assert.doesNotThrow(() => assertWorkflowActionAllowedForRole("validate"));
		assert.doesNotThrow(() => assertWorkflowActionAllowedForRole("board"));
		assert.throws(
			() => assertWorkflowActionAllowedForRole("run"),
			/PI_WORKFLOW_ROLE=worker/,
		);
		assert.throws(
			() => assertWorkflowActionAllowedForRole("continue"),
			/PI_WORKFLOW_ROLE=worker/,
		);
		assert.throws(
			() => assertWorkflowActionAllowedForRole("wait"),
			/PI_WORKFLOW_ROLE=worker/,
		);
		assert.throws(
			() => assertWorkflowToolAllowedForRole(),
			/PI_WORKFLOW_ROLE=worker/,
		);

		process.env.PI_WORKFLOW_ROLE = "disabled";
		assert.doesNotThrow(() => assertWorkflowActionAllowedForRole("validate"));
		assert.doesNotThrow(() => assertWorkflowActionAllowedForRole("board"));
		assert.throws(
			() => assertWorkflowActionAllowedForRole("run"),
			/PI_WORKFLOW_ROLE=disabled/,
		);
		assert.throws(
			() => assertWorkflowToolAllowedForRole(),
			/PI_WORKFLOW_ROLE=disabled/,
		);
	} finally {
		if (originalRole === undefined) delete process.env.PI_WORKFLOW_ROLE;
		else process.env.PI_WORKFLOW_ROLE = originalRole;
	}
});

test("supervisor lease ignores orphaned reclaim mutex from dead owner", async () => {
	const cwd = makeProject();
	const originalRole = process.env.PI_WORKFLOW_ROLE;
	try {
		process.env.PI_WORKFLOW_ROLE = "supervisor";
		const runId = "workflow_unit_orphan_reclaim";
		const reclaimDir = join(
			cwd,
			".pi",
			"workflows",
			runId,
			"supervisor-lease.lock.reclaim",
		);
		mkdirSync(reclaimDir, { recursive: true });
		writeFileSync(
			join(reclaimDir, "owner"),
			`dead-owner\n99999999\n${new Date().toISOString()}\n`,
		);
		assert.equal(await acquireSupervisorLease(cwd, runId), true);
	} finally {
		if (originalRole === undefined) delete process.env.PI_WORKFLOW_ROLE;
		else process.env.PI_WORKFLOW_ROLE = originalRole;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("supervisor lease honors live foreign owners and stale reclaim; workers cannot acquire", async () => {
	const cwd = makeProject();
	const originalRole = process.env.PI_WORKFLOW_ROLE;
	try {
		process.env.PI_WORKFLOW_ROLE = "supervisor";
		const runId = "workflow_unit_lease";
		assert.equal(await acquireSupervisorLease(cwd, runId), true);
		assert.equal(workflowProcessRoleForTests(), "supervisor");

		const ownLease = JSON.parse(
			readFileSync(supervisorLeasePath(cwd, runId), "utf8"),
		);
		assert.equal(ownLease.ownerId, workflowSupervisorOwnerIdForTests());
		await writeJsonAtomic(supervisorLeasePath(cwd, runId), {
			...ownLease,
			heartbeatAt: "2000-01-01T00:00:00.000Z",
		});
		assert.equal(await heartbeatSupervisorLease(cwd, runId), true);
		const heartbeaten = JSON.parse(
			readFileSync(supervisorLeasePath(cwd, runId), "utf8"),
		);
		assert.equal(heartbeaten.ownerId, workflowSupervisorOwnerIdForTests());
		assert.notEqual(heartbeaten.heartbeatAt, "2000-01-01T00:00:00.000Z");

		const foreignLiveRunId = "workflow_unit_foreign_live";
		await writeJsonAtomic(supervisorLeasePath(cwd, foreignLiveRunId), {
			schemaVersion: 1,
			ownerId: "foreign-live",
			pid: process.pid,
			role: "supervisor",
			startedAt: new Date().toISOString(),
			heartbeatAt: new Date().toISOString(),
		});
		assert.equal(await acquireSupervisorLease(cwd, foreignLiveRunId), false);

		const foreignStaleRunId = "workflow_unit_foreign_stale";
		await writeJsonAtomic(supervisorLeasePath(cwd, foreignStaleRunId), {
			schemaVersion: 1,
			ownerId: "foreign-stale",
			pid: 99999999,
			role: "supervisor",
			startedAt: "2000-01-01T00:00:00.000Z",
			heartbeatAt: "2000-01-01T00:00:00.000Z",
		});
		assert.equal(await acquireSupervisorLease(cwd, foreignStaleRunId), true);

		process.env.PI_WORKFLOW_ROLE = "worker";
		assert.equal(
			await acquireSupervisorLease(cwd, "workflow_unit_worker"),
			false,
		);
	} finally {
		if (originalRole === undefined) delete process.env.PI_WORKFLOW_ROLE;
		else process.env.PI_WORKFLOW_ROLE = originalRole;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("agent parser reads frontmatter tool ceilings", () => {
	const agent = parseAgentMarkdown(
		"---\ndescription: Scout\ntools: [read, grep]\nreadOnly: true\n---\nBody",
		"scout.md",
		"project",
	);
	assert.equal(agent.displayName, "scout");
	assert.deepEqual(agent.tools, ["read", "grep"]);
	assert.equal(agent.readOnly, true);
});

test("bundled common agents are fallback after project-local agents", async () => {
	const cwd = makeProject();
	const home = mkdtempSync(join(tmpdir(), "workflow-home-"));
	const previousHome = process.env.HOME;
	try {
		process.env.HOME = home;

		const bundled = await loadAgentByName("scout", cwd);
		assert.equal(bundled?.scope, "bundled");
		assert.match(bundled?.sourcePath ?? "", /agents[\\/]scout\.md$/);

		writeAgent(cwd, "scout", "read");
		const local = await loadAgentByName("scout", cwd);
		assert.equal(local?.scope, "project");
		assert.match(local?.sourcePath ?? "", /\.pi[\\/]agents[\\/]scout\.md$/);

		const compiled = await compileWorkflow(
			workflowSpec("researcher", {
				tools: ["read", "fetch_content"],
				artifactGraph: {
					stages: [
						{
							id: "main",
							type: "single",
							prompt: "Research with bundled researcher.",
						},
					],
				},
			}),
			{ cwd, task: "Research topic" },
		);
		assert.equal(compiled.tasks[0].agent, "researcher");
		assert.match(compiled.tasks[0].agentPath, /agents[\\/]researcher\.md$/);
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		rmSync(cwd, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	}
});

test("public schemaVersion 1 parser accepts artifact graph and rejects non-artifactGraph top-level shapes", () => {
	const parsed = parsePublicWorkflow(
		artifactGraphWorkflowSpec({
			name: "impact-artifact",
			artifactGraph: {
				stages: [
					{
						id: "risk",
						type: "single",
						prompt: "Assess risk.",
						output: {
							controlSchema: "./schemas/risk.schema.json",
							analysis: { required: true },
							refs: { required: true },
						},
					},
					{
						id: "final",
						type: "reduce",
						from: ["risk"],
						inputPolicy: {
							requiredReads: ["risk.analysis"],
							enforcement: "fail",
						},
						prompt: "Synthesize.",
					},
				],
			},
		}),
	);
	assert.equal(parsed.schemaVersion, 1);
	assert.equal(parsed.name, "impact-artifact");
	assert.equal(parsed.artifactGraph.stages[0].id, "risk");
	assert.equal(
		parsed.artifactGraph.stages[1].inputPolicy.requiredReads[0],
		"risk.analysis",
	);

	const invalidTopLevel = assertThrowsFlow(() =>
		parsePublicWorkflow({
			schemaVersion: 1,
			artifactGraph: {
				stages: [{ id: "main", type: "single", prompt: "Do." }],
			},
			unsupported: true,
		}),
	);
	assertIssue(invalidTopLevel, "$.unsupported", "unknown field");

	const legacyTaskType = assertThrowsFlow(() =>
		parsePublicWorkflow({
			schemaVersion: 1,
			artifactGraph: {
				stages: [{ id: "main", type: "task", prompt: "Do." }],
			},
		}),
	);
	assertIssue(
		legacyTaskType,
		"$.artifactGraph.stages[0].type",
		"must be one of: single, reduce, foreach, loop, dag, dynamic",
	);
});

test("artifact graph schema validates sourcePolicy maxItems and schema refs", () => {
	const invalidPolicy = assertThrowsFlow(() =>
		parsePublicWorkflow(
			artifactGraphWorkflowSpec({
				artifactGraph: {
					stages: [
						{
							id: "main",
							type: "single",
							prompt: "Do it.",
							sourcePolicy: "sometimes",
						},
					],
				},
			}),
		),
	);
	assertIssue(
		invalidPolicy,
		"$.artifactGraph.stages[0].sourcePolicy",
		"must be one of",
	);

	assert.doesNotThrow(() =>
		parsePublicWorkflow(
			artifactGraphWorkflowSpec({
				artifactGraph: {
					stages: [
						{
							id: "plan",
							type: "single",
							prompt: "Plan.",
						},
						{
							id: "items",
							type: "foreach",
							from: { source: "plan", path: "$.items" },
							maxItems: 5,
							each: { prompt: "Item ${item}" },
						},
					],
				},
			}),
		),
	);

	const badSchemaRef = assertThrowsFlow(() =>
		parsePublicWorkflow(
			artifactGraphWorkflowSpec({
				artifactGraph: {
					stages: [
						{
							id: "main",
							type: "single",
							prompt: "Do it.",
							output: { controlSchema: "../schema.json" },
						},
					],
				},
			}),
		),
	);
	assertIssue(
		badSchemaRef,
		"$.artifactGraph.stages[0].output.controlSchema",
		"must stay inside the workflow bundle",
	);

	const badSchemaDoubleSlash = assertThrowsFlow(() =>
		parsePublicWorkflow(
			artifactGraphWorkflowSpec({
				artifactGraph: {
					stages: [
						{
							id: "main",
							type: "single",
							prompt: "Do it.",
							output: { controlSchema: ".//schemas/control.json" },
						},
					],
				},
			}),
		),
	);
	assertIssue(
		badSchemaDoubleSlash,
		"$.artifactGraph.stages[0].output.controlSchema",
		"must stay inside the workflow bundle",
	);
});

test("artifact graph schema accepts dynamic stages and validates helper refs", () => {
	const parsed = parsePublicWorkflow(
		artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: {
							uses: "./helpers/controller.mjs",
							mode: "graph-splice",
							budget: {
								maxAgents: 1000,
								maxConcurrency: 16,
								maxRuntimeMs: 14_400_000,
								maxNestedWorkflowDepth: 3,
							},
							permissions: {
								approval: "auto",
								allowDynamicRoles: true,
								allowDynamicTools: true,
							},
							decisionLoop: {
								stopPolicy: { maxStalls: 4 },
							},
							helpers: {
								normalize: {
									uses: "./helpers/normalize.mjs",
									inputSchema: "./schemas/normalize-input.schema.json",
									outputSchema: "./schemas/normalize-output.schema.json",
								},
							},
						},
					},
				],
			},
		}),
	);
	assert.equal(parsed.artifactGraph.stages[0].type, "dynamic");
	assert.equal(
		parsed.artifactGraph.stages[0].dynamic.uses,
		"./helpers/controller.mjs",
	);
	assert.equal(
		parsed.artifactGraph.stages[0].dynamic.decisionLoop.stopPolicy.maxStalls,
		4,
	);

	const badPath = assertThrowsFlow(() =>
		parsePublicWorkflow(
			artifactGraphWorkflowSpec({
				artifactGraph: {
					stages: [
						{
							id: "adaptive",
							type: "dynamic",
							dynamic: { uses: "../controller.mjs" },
						},
					],
				},
			}),
		),
	);
	assertIssue(
		badPath,
		"$.artifactGraph.stages[0].dynamic.uses",
		"must be a relative ./ helper .mjs path",
	);
	assertIssue(
		badPath,
		"$.artifactGraph.stages[0].dynamic.uses",
		"must stay inside the workflow bundle",
	);

	const badDoubleSlash = assertThrowsFlow(() =>
		parsePublicWorkflow(
			artifactGraphWorkflowSpec({
				artifactGraph: {
					stages: [
						{
							id: "adaptive",
							type: "dynamic",
							dynamic: { uses: ".//helpers/controller.mjs" },
						},
					],
				},
			}),
		),
	);
	assertIssue(
		badDoubleSlash,
		"$.artifactGraph.stages[0].dynamic.uses",
		"must stay inside the workflow bundle",
	);

	const badApproval = assertThrowsFlow(() =>
		parsePublicWorkflow(
			artifactGraphWorkflowSpec({
				artifactGraph: {
					stages: [
						{
							id: "adaptive",
							type: "dynamic",
							dynamic: {
								uses: "./helpers/controller.mjs",
								permissions: { approval: "manual" },
							},
						},
					],
				},
			}),
		),
	);
	assertIssue(
		badApproval,
		"$.artifactGraph.stages[0].dynamic.permissions.approval",
		"must be one of: auto, ask",
	);

	const badHelperSchema = assertThrowsFlow(() =>
		parsePublicWorkflow(
			artifactGraphWorkflowSpec({
				artifactGraph: {
					stages: [
						{
							id: "adaptive",
							type: "dynamic",
							dynamic: {
								uses: "./helpers/controller.mjs",
								helpers: {
									normalize: {
										uses: "./helpers/normalize.mjs",
										inputSchema: "./helpers/normalize.mjs",
									},
								},
							},
						},
					],
				},
			}),
		),
	);
	assertIssue(
		badHelperSchema,
		"$.artifactGraph.stages[0].dynamic.helpers.normalize.inputSchema",
		"must point to a bundle-local .json file",
	);

	const helperSchemaFragment = assertThrowsFlow(() =>
		parsePublicWorkflow(
			artifactGraphWorkflowSpec({
				artifactGraph: {
					stages: [
						{
							id: "adaptive",
							type: "dynamic",
							dynamic: {
								uses: "./helpers/controller.mjs",
								helpers: {
									normalize: {
										uses: "./helpers/normalize.mjs",
										inputSchema: "./schemas/normalize.schema.json#/$defs/input",
									},
								},
							},
						},
					],
				},
			}),
		),
	);
	assertIssue(
		helperSchemaFragment,
		"$.artifactGraph.stages[0].dynamic.helpers.normalize.inputSchema",
		"must point to a bundle-local .json file",
	);
});

test("compiler lowers dynamic stages to controller placeholders", async () => {
	const cwd = makeProject();
	try {
		const compiled = await compileWorkflow(
			artifactGraphWorkflowSpec({
				artifactGraph: {
					stages: [
						{
							id: "adaptive",
							type: "dynamic",
							output: {
								controlSchema: "./schemas/controller-output.schema.json",
							},
							dynamic: {
								uses: "./helpers/controller.mjs",
								helpers: {
									normalize: {
										uses: "./helpers/normalize.mjs",
										inputSchema: "./schemas/normalize-input.schema.json",
										idempotent: true,
									},
								},
							},
						},
					],
				},
			}),
			{ cwd, task: "Review dynamically." },
		);
		assert.equal(compiled.tasks.length, 1);
		const [controller] = compiled.tasks;
		assert.equal(controller.id, "adaptive.controller");
		assert.equal(controller.kind, "dynamic");
		assert.equal(controller.agent, "dynamic");
		assert.equal(controller.dynamic.uses, "./helpers/controller.mjs");
		assert.equal(controller.dynamic.mode, "graph-splice");
		assert.equal(controller.dynamic.budget.maxAgents, 1000);
		assert.equal(controller.dynamic.budget.maxConcurrency, 16);
		assert.equal(controller.dynamic.budget.maxRuntimeMs, 14_400_000);
		assert.equal(controller.dynamic.budget.maxNestedWorkflowDepth, 3);
		assert.equal(controller.dynamic.permissions.approval, "auto");
		assert.match(
			controller.compiledPrompt,
			/# Runtime Task\n\nReview dynamically\./,
		);
		assert.match(
			controller.compiledPrompt,
			/Use workflow-local control schema reference: \.\/schemas\/controller-output\.schema\.json/,
		);
		assert.equal(
			controller.dynamic.helpers.normalize.uses,
			"./helpers/normalize.mjs",
		);
		assert.equal(
			controller.dynamic.helpers.normalize.inputSchema,
			"./schemas/normalize-input.schema.json",
		);
		assert.equal(controller.dynamic.helpers.normalize.idempotent, true);
		assert.ok(
			controller.dynamic.helpers.normalize.inputSchemaPath.endsWith(
				"schemas/normalize-input.schema.json",
			),
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("compiler defaults dynamic decision repair to two re-asks and maxStalls to three", async () => {
	const cwd = makeProject();
	try {
		const compiled = await compileWorkflow(
			artifactGraphWorkflowSpec({
				artifactGraph: {
					stages: [
						{
							id: "adaptive",
							type: "dynamic",
							dynamic: {
								uses: "./helpers/controller.mjs",
								decisionLoop: {},
							},
						},
					],
				},
			}),
			{ cwd, task: "Review dynamically." },
		);

		const loop = compiled.tasks[0].dynamic.decisionLoop;
		assert.equal(loop.repair.maxAttempts, 2);
		assert.equal(loop.stopPolicy.maxStalls, 3);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("compiler applies runtime defaults to dynamic stages and decision-loop profiles", async () => {
	const cwd = makeProject();
	try {
		const compiled = await compileWorkflow(
			artifactGraphWorkflowSpec({
				artifactGraph: {
					stages: [
						{
							id: "adaptive",
							type: "dynamic",
							dynamic: {
								uses: "./helpers/controller.mjs",
								decisionLoop: {
									planner: {},
									workerDefaults: { model: "profile/model" },
									verifier: { thinking: "medium" },
									synthesis: {},
								},
							},
						},
					],
				},
			}),
			{
				cwd,
				task: "Review dynamically.",
				runtimeDefaults: { model: "runtime/model", thinking: "low" },
			},
		);

		const controller = compiled.tasks[0];
		assert.equal(controller.runtime.model, "runtime/model");
		assert.equal(controller.runtime.thinking, "low");
		const loop = controller.dynamic.decisionLoop;
		assert.equal(loop.planner.model, "runtime/model");
		assert.equal(loop.planner.thinking, "low");
		assert.equal(loop.workerDefaults.model, "profile/model");
		assert.equal(loop.workerDefaults.thinking, "low");
		assert.equal(loop.verifier.model, "runtime/model");
		assert.equal(loop.verifier.thinking, "medium");
		assert.equal(loop.synthesis.model, "runtime/model");
		assert.equal(loop.synthesis.thinking, "low");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("compiler accepts deprecated dynamic decision-loop no-op fields", async () => {
	const cwd = makeProject();
	try {
		const compiled = await compileWorkflow(
			artifactGraphWorkflowSpec({
				artifactGraph: {
					stages: [
						{
							id: "adaptive",
							type: "dynamic",
							dynamic: {
								uses: "./helpers/controller.mjs",
								decisionLoop: {
									stateIndex: {
										maxFindings: 5,
										requiredFindingIds: ["F-deprecated"],
									},
									stopPolicy: {
										requireSynthesisAction: true,
										failOnInvalidDecision: false,
										maxStalls: 5,
										failOnDroppedRequiredBranch: true,
									},
								},
							},
						},
					],
				},
			}),
			{ cwd, task: "Review dynamically." },
		);

		const loop = compiled.tasks[0].dynamic.decisionLoop;
		assert.deepEqual(loop.stateIndex.requiredFindingIds, ["F-deprecated"]);
		assert.equal(loop.stopPolicy.requireSynthesisAction, true);
		assert.equal(loop.stopPolicy.failOnInvalidDecision, false);
		assert.equal(loop.stopPolicy.maxStalls, 5);
		assert.equal(loop.stopPolicy.failOnDroppedRequiredBranch, true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("dynamic event ledger writes monotonic events and rebuilds state", async () => {
	const cwd = makeProject();
	try {
		const runId = "workflow_dynamic_unit";
		const initialized = await appendDynamicEvent(cwd, runId, {
			controllerSpecId: "adaptive.controller",
			type: "controller.initialized",
			opId: "adaptive.controller:init",
			requestHash: "hash-init",
			payload: {
				controllerTaskId: "task-1",
				stageId: "adaptive",
				status: "pending",
				budget: { maxAgents: 1000, maxConcurrency: 16 },
				helperRefs: ["./helpers/controller.mjs"],
			},
		});
		const generated = await appendDynamicEvent(cwd, runId, {
			controllerSpecId: "adaptive.controller",
			type: "task.generated",
			opId: "adaptive.controller:agent:review",
			requestHash: "hash-review",
			payload: { taskId: "adaptive.review" },
		});
		assert.equal(initialized.seq, 1);
		assert.equal(generated.seq, 2);

		await recordDynamicControllerPhase(cwd, runId, {
			controllerSpecId: "adaptive.controller",
			phase: "review",
		});
		await appendDynamicEvent(cwd, runId, {
			controllerSpecId: "adaptive.controller",
			type: "workflow.started",
			opId: "adaptive.controller:workflow:child",
			requestHash: "hash-child",
			payload: { runId: "workflow_child", wait: true },
		});
		await appendDynamicEvent(cwd, runId, {
			controllerSpecId: "adaptive.controller",
			type: "workflow.completed",
			opId: "adaptive.controller:workflow:child",
			requestHash: "hash-child",
			payload: { runId: "workflow_child", result: { status: "completed" } },
		});
		const state = await rebuildDynamicState(cwd, runId);
		const controller = state.controllers["adaptive.controller"];
		assert.equal(controller.status, "pending");
		assert.equal(controller.phase, "review");
		assert.deepEqual(controller.generatedTaskIds, ["adaptive.review"]);
		assert.equal(controller.counters.agents, 1);
		assert.equal(controller.counters.graphMutations, 1);
		assert.deepEqual(controller.nestedWorkflowRunIds, ["workflow_child"]);
		assert.deepEqual(controller.waitingNestedWorkflowRunIds, []);
		assert.equal(controller.lastEventSeq, 5);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("dynamic request hashes use persisted JSON shape", () => {
	assert.equal(
		hashDynamicRequest({ value: new Date("2026-01-02T03:04:05.000Z") }),
		hashDynamicRequest({ value: "2026-01-02T03:04:05.000Z" }),
	);
	assert.equal(
		hashDynamicRequest({ value: { toJSON: () => "json-shape" } }),
		hashDynamicRequest({ value: "json-shape" }),
	);
});

test("dynamic-decision-v1 accepts strict executable decisions and canonicalizes hashes", () => {
	const decision = {
		schema: "dynamic-decision-v1",
		decisionId: "decide-r0",
		round: 0,
		phase: "orientation",
		status: "continue",
		nextActions: [
			{
				type: "add_work_item",
				actionId: "act-inspect-auth",
				workItemId: "inspect-auth",
				agent: "unit-scout",
				prompt: "Inspect auth paths.",
				tools: ["read", "custom_external_tool"],
				outputProfile: "candidate_findings_v1",
				inputRefs: [
					{
						kind: "workflow-artifact-ref",
						taskId: "seed",
						artifact: "control",
						digest: "sha256:seed",
					},
				],
			},
		],
	};

	const result = validateDynamicDecision(decision, {
		expectedRound: 0,
		maxActions: 2,
		allowedTools: ["read", "custom_external_tool"],
		toolProviders: {
			custom_external_tool: { classification: "read-only" },
		},
		knownArtifactTaskIds: ["seed"],
	});

	assert.equal(result.ok, true, result.errors.join("\n"));
	assert.equal(result.decision?.nextActions[0].type, "add_work_item");
	assert.match(result.hash, /^[a-f0-9]{64}$/);
	assert.equal(
		validateDynamicDecision(result.decision, {
			expectedRound: 0,
			allowedTools: ["read", "custom_external_tool"],
			toolProviders: {
				custom_external_tool: { classification: "read-only" },
			},
			knownArtifactTaskIds: ["seed"],
		}).hash,
		result.hash,
	);
});

test("dynamic-decision-v1 rejects schema, invariant, ref, id, and tool violations", () => {
	const invalid = validateDynamicDecision(
		{
			schema: "dynamic-decision-v1",
			decisionId: "decide r0",
			round: 1,
			phase: "round",
			status: "continue",
			unknown: true,
			nextActions: [
				{
					type: "synthesize",
					actionId: "decide-r0",
					outputProfile: "unknown_profile",
					inputRefs: [{ kind: "workflow-artifact-ref", taskId: "missing" }],
				},
				{
					type: "add_work_item",
					actionId: "Act 1",
					workItemId: "act-1",
					agent: "unit-scout",
					prompt: "Bad tools.",
					tools: ["unknown_tool"],
				},
			],
		},
		{
			expectedRound: 0,
			maxActions: 1,
			allowedTools: ["read"],
			knownArtifactTaskIds: ["seed"],
		},
	);

	assert.equal(invalid.ok, false);
	assert.match(invalid.errors.join("\n"), /unknown decision field unknown/);
	assert.match(invalid.errors.join("\n"), /round must match expected round 0/);
	assert.match(
		invalid.errors.join("\n"),
		/status continue cannot include stop or synthesize/,
	);
	assert.match(invalid.errors.join("\n"), /nextActions exceeds maxActions 1/);
	assert.match(invalid.errors.join("\n"), /references unknown artifact task/);
	assert.match(invalid.errors.join("\n"), /outputProfile is unknown/);
	assert.match(invalid.errors.join("\n"), /outside the allowed tool ceiling/);
	assert.match(invalid.errors.join("\n"), /collides|duplicated/);
});

function canonicalDynamicDecision(overrides = {}) {
	const canonical = {
		schema: "dynamic-decision-v1",
		decisionId: "decide-r0",
		round: 0,
		phase: "orientation",
		status: "continue",
		nextActions: [
			{
				type: "add_work_item",
				actionId: "act-review",
				workItemId: "review",
				agent: "unit-scout",
				prompt: "Review the target.",
			},
		],
	};
	return { ...canonical, ...overrides };
}

function assertDynamicDecisionRejects(decision, pattern, context = {}) {
	const result = validateDynamicDecision(decision, {
		expectedRound: 0,
		maxActions: 1,
		...context,
	});
	assert.equal(result.ok, false, result.errors.join("\n"));
	assert.match(result.errors.join("\n"), pattern);
	return result;
}

test("dynamic-decision-v1 rejects top-level actions alias", () => {
	const canonical = canonicalDynamicDecision();
	assertDynamicDecisionRejects(
		{
			...canonical,
			nextActions: undefined,
			actions: canonical.nextActions,
		},
		/decision field actions is not allowed; use nextActions/,
	);
});

test("dynamic-decision-v1 rejects action alias for type", () => {
	assertDynamicDecisionRejects(
		canonicalDynamicDecision({
			nextActions: [
				{
					action: "add_work_item",
					actionId: "act-review",
					workItemId: "review",
					agent: "unit-scout",
					prompt: "Review the target.",
				},
			],
		}),
		/nextActions\[0\]\.action is not allowed; use type/,
	);
});

test("dynamic-decision-v1 rejects id alias for actionId", () => {
	assertDynamicDecisionRejects(
		canonicalDynamicDecision({
			nextActions: [
				{
					type: "add_work_item",
					id: "act-review",
					workItemId: "review",
					agent: "unit-scout",
					prompt: "Review the target.",
				},
			],
		}),
		/nextActions\[0\]\.id is not allowed; use actionId/,
	);
});

test("dynamic-decision-v1 rejects missing actionId", () => {
	assertDynamicDecisionRejects(
		canonicalDynamicDecision({
			nextActions: [
				{
					type: "add_work_item",
					workItemId: "review",
					agent: "unit-scout",
					prompt: "Review the target.",
				},
			],
		}),
		/nextActions\[0\]\.actionId must be a non-empty string/,
	);
});

test("dynamic-decision-v1 rejects top-level decision arrays", () => {
	assertDynamicDecisionRejects(
		[canonicalDynamicDecision()],
		/decision must be an object/,
	);
});

test("dynamic-decision-v1 rejects nextActions object drift", () => {
	const canonical = canonicalDynamicDecision();
	assertDynamicDecisionRejects(
		{
			...canonical,
			nextActions: canonical.nextActions[0],
		},
		/nextActions must be an array/,
	);
});

test("dynamic-decision-v1 rejects inputRefs string drift", () => {
	const canonical = canonicalDynamicDecision();
	assertDynamicDecisionRejects(
		{
			...canonical,
			nextActions: [
				{
					...canonical.nextActions[0],
					inputRefs: "seed",
				},
			],
		},
		/nextActions\[0\]\.inputRefs must be an array/,
	);
});

test("dynamic-decision-v1 rejects inputRefs string-array drift", () => {
	const canonical = canonicalDynamicDecision();
	assertDynamicDecisionRejects(
		{
			...canonical,
			nextActions: [
				{
					...canonical.nextActions[0],
					inputRefs: ["seed"],
				},
			],
		},
		/nextActions\[0\]\.inputRefs\[0\] must be an object/,
	);
});

test("dynamic-decision-v1 rejects prose rationale in control JSON", () => {
	assertDynamicDecisionRejects(
		canonicalDynamicDecision({ rationale: "Need inspection first." }),
		/unknown decision field rationale/,
	);
});

test("dynamic-decision-v1 rejects prose criteria descriptions in control JSON", () => {
	assertDynamicDecisionRejects(
		canonicalDynamicDecision({
			criteria: [{ id: "C1", description: "Long-form criterion" }],
		}),
		/unknown decision field criteria/,
	);
});

test("dynamic-decision-v1 rejects malformed criteria drift in control JSON", () => {
	assertDynamicDecisionRejects(
		canonicalDynamicDecision({ criteria: "" }),
		/unknown decision field criteria/,
	);
});

test("dynamic-decision-v1 rejects gaps drift in control JSON", () => {
	assertDynamicDecisionRejects(
		canonicalDynamicDecision({ gaps: [""] }),
		/unknown decision field gaps/,
	);
});

test("dynamic-decision-v1 rejects unknown top-level field", () => {
	assertDynamicDecisionRejects(
		canonicalDynamicDecision({ unexpected: true }),
		/unknown decision field unexpected/,
	);
});

test("dynamic-decision-v1 rejects unknown action field", () => {
	const canonical = canonicalDynamicDecision();
	assertDynamicDecisionRejects(
		{
			...canonical,
			nextActions: [{ ...canonical.nextActions[0], unexpected: true }],
		},
		/nextActions\[0\]\.unexpected is not allowed/,
	);
});

test("dynamic-decision artifacts persist raw validation and accepted canonical decision", async () => {
	const cwd = makeProject();
	try {
		const rawDecision = {
			schema: "dynamic-decision-v1",
			decisionId: "decide-r2",
			round: 2,
			phase: "final",
			status: "stop",
			nextActions: [
				{
					type: "stop",
					actionId: "stop-r2",
					reason: "All criteria satisfied.",
				},
			],
		};
		const validation = validateDynamicDecision(rawDecision, {
			expectedRound: 2,
		});
		const written = await writeDynamicDecisionArtifacts({
			cwd,
			runId: "workflow_decision_artifacts",
			controllerSpecId: "adaptive.controller",
			rawDecision,
			validation,
			stateIndexDigest: "sha256:index",
		});

		assert.equal(validation.ok, true, validation.errors.join("\n"));
		assert.equal(existsSync(written.rawPath), true);
		assert.equal(existsSync(written.validationPath), true);
		assert.equal(existsSync(written.acceptedPath), true);
		const accepted = JSON.parse(readFileSync(written.acceptedPath, "utf8"));
		assert.equal(accepted.validatorVersion, "dynamic-decision-validator-v1");
		assert.equal(accepted.stateIndexDigest, "sha256:index");
		assert.equal(accepted.decisionHash, validation.hash);
		assert.equal(accepted.decision.decisionId, "decide-r2");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("dynamic-state-index extracts findings verifications coverage and guardrails", () => {
	const candidate = extractDynamicStateArtifact({
		taskId: "inspect-auth",
		outputProfile: "candidate_findings_v1",
		control: {
			findings: [
				{
					id: "AUTH-1",
					title: "Missing auth check",
					severity: "high",
					confidence: "medium",
					evidenceRefs: [
						{
							taskId: "inspect-auth",
							artifact: "analysis",
							digest: "sha256:a",
						},
					],
				},
			],
			gaps: ["Need route coverage"],
		},
	});
	const verification = extractDynamicStateArtifact({
		taskId: "verify-auth",
		outputProfile: "verification_result_v1",
		control: {
			findingId: "AUTH-1",
			verdict: "weakened",
			confidence: "low",
			evidenceRefs: [{ taskId: "verify-auth", artifact: "control" }],
		},
	});
	const coverage = extractDynamicStateArtifact({
		taskId: "inspect-tests",
		outputProfile: "coverage_assessment_v1",
		control: {
			criteriaCoverage: {
				C1: { status: "partial", notes: "Auth tests missing" },
			},
			conflicts: [
				{
					id: "conflict-auth",
					message: "Implementation and tests disagree",
					relatedFindingIds: ["AUTH-1"],
				},
			],
		},
	});

	const index = assembleDynamicStateIndex([candidate, verification, coverage], {
		requiredFindingIds: ["AUTH-1"],
	});

	assert.equal(index.schema, "dynamic-state-index-v1");
	assert.match(index.digest, /^[a-f0-9]{64}$/);
	assert.equal(index.findings.length, 1);
	assert.equal(index.findings[0].verificationStatus, "weakened");
	assert.equal(index.findings[0].confidence, "low");
	assert.equal(index.criteriaCoverage[0].criterionId, "C1");
	assert.equal(index.conflicts[0].relatedFindingIds[0], "AUTH-1");
	assert.equal(
		index.gaps.some((gap) => gap.message.includes("Need route coverage")),
		true,
	);
	assert.equal(
		index.blockers.some((blocker) => blocker.id === "unverified-AUTH-1"),
		false,
	);
});

test("dynamic-state-index extracts verifier claim-source support", () => {
	const verification = extractDynamicStateArtifact({
		taskId: "verify-auth",
		outputProfile: "verification_result_v1",
		control: {
			findingId: "AUTH-1",
			verdict: "verified",
			confidence: "high",
			claimSupports: [
				{
					claim: "The route requires an authenticated session.",
					status: "supports",
					sourceLocators: ["https://example.test/auth-doc"],
					excerpt: "authenticated session required",
				},
			],
		},
	});
	const index = assembleDynamicStateIndex([verification]);

	assert.equal(verification.claimSupports.length, 1);
	assert.equal(index.claimSupports[0].findingId, "AUTH-1");
	assert.equal(index.claimSupports[0].status, "supports");
	assert.deepEqual(index.claimSupports[0].sourceLocators, [
		"https://example.test/auth-doc",
	]);
	assert.deepEqual(index.claimSupportSummary, {
		positiveVerifications: 1,
		positiveVerificationsWithClaimSupport: 1,
		positiveVerificationsMissingClaimSupport: 0,
		claimSupports: 1,
		positiveClaimSupports: 1,
	});
	assert.equal(
		index.gaps.some((gap) => gap.id === "missing-claim-support-auth-1"),
		false,
	);
});

test("dynamic-state-index records missing structured support for positive verifications", () => {
	const verification = extractDynamicStateArtifact({
		taskId: "verify-auth",
		outputProfile: "verification_result_v1",
		control: {
			findingId: "AUTH-1",
			verdict: "verified",
			confidence: "high",
		},
	});
	const index = assembleDynamicStateIndex([verification]);

	assert.equal(
		index.gaps.some((gap) => gap.id === "missing-claim-support-auth-1"),
		true,
	);
	assert.deepEqual(index.claimSupportSummary, {
		positiveVerifications: 1,
		positiveVerificationsWithClaimSupport: 0,
		positiveVerificationsMissingClaimSupport: 1,
		claimSupports: 0,
		positiveClaimSupports: 0,
	});
});

test("dynamic-state-index records extraction lossiness blockers and omissions", () => {
	const malformed = extractDynamicStateArtifact({
		taskId: "bad-inspect",
		outputProfile: "candidate_findings_v1",
		control: {
			findings: "not-array",
			omissions: ["truncated control"],
		},
	});
	const overflow = extractDynamicStateArtifact({
		taskId: "overflow-inspect",
		outputProfile: "candidate_findings_v1",
		maxFindings: 1,
		control: {
			findings: [
				{ id: "F1", title: "High risk", severity: "high", confidence: "low" },
				{
					id: "F2",
					title: "Dropped",
					severity: "medium",
					confidence: "medium",
				},
			],
		},
	});

	const index = assembleDynamicStateIndex([malformed, overflow], {
		requiredFindingIds: ["F1", "F2"],
		maxFindings: 1,
	});

	assert.equal(
		index.blockers.some((blocker) =>
			blocker.message.includes("findings must be an array"),
		),
		true,
	);
	assert.equal(
		index.blockers.some((blocker) =>
			blocker.message.includes("Required finding F2 was dropped"),
		),
		true,
	);
	assert.equal(
		index.blockers.some((blocker) =>
			blocker.message.includes("High-risk finding F1 remains unverified"),
		),
		true,
	);
	assert.equal(
		index.omissions.some((item) => item.includes("maxFindings=1")),
		true,
	);
	assert.equal(
		index.omissions.some((item) => item.includes("truncated control")),
		true,
	);
});

test("dynamic-state-index assembly is verification order independent", () => {
	const finding = extractDynamicStateArtifact({
		taskId: "inspect-auth",
		outputProfile: "candidate_findings_v1",
		control: {
			findings: [
				{
					id: "AUTH-1",
					title: "Auth gap",
					severity: "medium",
					confidence: "medium",
				},
			],
		},
	});
	const verification = extractDynamicStateArtifact({
		taskId: "verify-auth",
		outputProfile: "verification_result_v1",
		control: { findingId: "AUTH-1", verdict: "verified", confidence: "high" },
	});

	const normal = assembleDynamicStateIndex([finding, verification]);
	const reversed = assembleDynamicStateIndex([verification, finding]);
	assert.equal(reversed.findings[0].verificationStatus, "verified");
	assert.equal(reversed.digest, normal.digest);
	assert.equal(
		reversed.blockers.some((blocker) =>
			blocker.message.includes("Verification references unknown finding"),
		),
		false,
	);
});

test("dynamic-state-index namespaces synthetic ids by source task", () => {
	const first = extractDynamicStateArtifact({
		taskId: "inspect-one",
		outputProfile: "candidate_findings_v1",
		control: {
			findings: [{ title: "Missing id", severity: "low", confidence: "low" }],
			gaps: ["Needs evidence"],
		},
	});
	const second = extractDynamicStateArtifact({
		taskId: "inspect-two",
		outputProfile: "candidate_findings_v1",
		control: {
			findings: [{ title: "Missing id", severity: "low", confidence: "low" }],
			gaps: ["Needs evidence"],
		},
	});
	const index = assembleDynamicStateIndex([first, second]);

	assert.deepEqual(
		index.findings.map((finding) => finding.id),
		["finding-inspect-one-001", "finding-inspect-two-001"],
	);
	assert.deepEqual(
		index.gaps.map((gap) => gap.id),
		[
			"gap-inspect-one-1",
			"gap-inspect-two-1",
			"weak-evidence-finding-inspect-one-001",
			"weak-evidence-finding-inspect-two-001",
		],
	);
});

test("dynamic-state-index preserves required findings during truncation or blocks", () => {
	const extract = extractDynamicStateArtifact({
		taskId: "inspect-many",
		outputProfile: "candidate_findings_v1",
		control: {
			findings: [
				{ id: "A", title: "A", severity: "low", confidence: "high" },
				{ id: "B", title: "B", severity: "low", confidence: "high" },
			],
		},
	});
	const index = assembleDynamicStateIndex([extract], {
		requiredFindingIds: ["B"],
		maxFindings: 1,
	});

	assert.deepEqual(
		index.findings.map((finding) => finding.id),
		["B"],
	);
	assert.equal(
		index.blockers.some((blocker) =>
			blocker.message.includes("Required finding B was dropped"),
		),
		false,
	);
	assert.equal(
		index.omissions.some((item) => item.includes("A")),
		true,
	);
});

test("dynamic-state-index artifacts reject divergent rewrites", async () => {
	const cwd = makeProject();
	try {
		const firstExtract = extractDynamicStateArtifact({
			taskId: "inspect-one",
			outputProfile: "candidate_findings_v1",
			control: { findings: [{ id: "A", title: "A", confidence: "high" }] },
		});
		const secondExtract = extractDynamicStateArtifact({
			taskId: "inspect-two",
			outputProfile: "candidate_findings_v1",
			control: { findings: [{ id: "B", title: "B", confidence: "high" }] },
		});
		const firstIndex = assembleDynamicStateIndex([firstExtract]);
		const secondIndex = assembleDynamicStateIndex([secondExtract]);
		const base = {
			cwd,
			runId: "workflow_state_index_divergent",
			controllerSpecId: "adaptive.controller",
			round: 1,
		};
		await writeDynamicStateIndexArtifacts({
			...base,
			extracts: [firstExtract],
			index: firstIndex,
		});
		await assert.rejects(
			() =>
				writeDynamicStateIndexArtifacts({
					...base,
					extracts: [secondExtract],
					index: secondIndex,
				}),
			/divergent digest/,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("dynamic-state-index artifacts persist extracts and canonical index", async () => {
	const cwd = makeProject();
	try {
		const extract = extractDynamicStateArtifact({
			taskId: "inspect-auth",
			outputProfile: "candidate_findings_v1",
			control: {
				findings: [
					{
						id: "AUTH-1",
						title: "Missing auth check",
						severity: "medium",
						confidence: "high",
					},
				],
			},
		});
		const index = assembleDynamicStateIndex([extract]);
		const written = await writeDynamicStateIndexArtifacts({
			cwd,
			runId: "workflow_state_index_artifacts",
			controllerSpecId: "adaptive.controller",
			round: 1,
			extracts: [extract],
			index,
		});

		assert.equal(existsSync(written.extractsPath), true);
		assert.equal(existsSync(written.indexPath), true);
		const saved = JSON.parse(readFileSync(written.indexPath, "utf8"));
		assert.equal(saved.digest, index.digest);
		assert.equal(saved.findings[0].id, "AUTH-1");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("dynamic-decision artifacts reject divergent accepted rewrites", async () => {
	const cwd = makeProject();
	try {
		const baseDecision = {
			schema: "dynamic-decision-v1",
			decisionId: "decide-r2",
			round: 2,
			phase: "final",
			status: "stop",
			nextActions: [{ type: "stop", actionId: "stop-r2", reason: "done" }],
		};
		const changedDecision = {
			...baseDecision,
			nextActions: [{ type: "stop", actionId: "stop-r2", reason: "changed" }],
		};
		const base = {
			cwd,
			runId: "workflow_decision_divergent",
			controllerSpecId: "adaptive.controller",
		};
		await writeDynamicDecisionArtifacts({
			...base,
			rawDecision: baseDecision,
			validation: validateDynamicDecision(baseDecision, { expectedRound: 2 }),
		});
		await assert.rejects(
			() =>
				writeDynamicDecisionArtifacts({
					...base,
					rawDecision: changedDecision,
					validation: validateDynamicDecision(changedDecision, {
						expectedRound: 2,
					}),
				}),
			/divergent hash/,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("deterministic dynamic decision-loop fixture persists decisions and state indexes", async () => {
	const cwd = makeProject();
	try {
		const runId = "workflow_decision_loop_fixture";
		const controllerSpecId = "adaptive.controller";
		const decideR0 = {
			schema: "dynamic-decision-v1",
			decisionId: "decide-r0",
			round: 0,
			phase: "orientation",
			status: "continue",
			nextActions: [
				{
					type: "add_work_item",
					actionId: "act-inspect-auth",
					workItemId: "inspect-auth",
					agent: "unit-scout",
					prompt: "Inspect auth implementation.",
					tools: ["read"],
					outputProfile: "candidate_findings_v1",
				},
				{
					type: "add_work_item",
					actionId: "act-inspect-tests",
					workItemId: "inspect-tests",
					agent: "unit-scout",
					prompt: "Inspect tests.",
					tools: ["read"],
					outputProfile: "coverage_assessment_v1",
				},
			],
		};
		const r0 = validateDynamicDecision(decideR0, {
			expectedRound: 0,
			maxActions: 2,
			allowedTools: ["read"],
		});
		assert.equal(r0.ok, true, r0.errors.join("\n"));
		await writeDynamicDecisionArtifacts({
			cwd,
			runId,
			controllerSpecId,
			rawDecision: decideR0,
			validation: r0,
		});

		const inspectAuth = extractDynamicStateArtifact({
			taskId: "inspect-auth",
			outputProfile: "candidate_findings_v1",
			control: {
				findings: [
					{
						id: "AUTH-1",
						title: "Auth check may be bypassed",
						severity: "high",
						confidence: "medium",
						evidenceRefs: [
							{
								taskId: "inspect-auth",
								artifact: "analysis",
								digest: "sha256:auth",
							},
						],
					},
				],
			},
		});
		const inspectTests = extractDynamicStateArtifact({
			taskId: "inspect-tests",
			outputProfile: "coverage_assessment_v1",
			control: {
				criteriaCoverage: {
					C2: { status: "partial", notes: "No negative auth test found" },
				},
				gaps: ["Auth negative coverage gap"],
			},
		});
		const indexR0 = assembleDynamicStateIndex([inspectAuth, inspectTests], {
			requiredFindingIds: ["AUTH-1"],
		});
		assert.equal(
			indexR0.blockers.some((blocker) => blocker.id === "unverified-AUTH-1"),
			true,
		);
		await writeDynamicStateIndexArtifacts({
			cwd,
			runId,
			controllerSpecId,
			round: 0,
			extracts: [inspectAuth, inspectTests],
			index: indexR0,
		});

		const decideR1 = {
			schema: "dynamic-decision-v1",
			decisionId: "decide-r1",
			round: 1,
			phase: "round",
			status: "continue",
			nextActions: [
				{
					type: "verify",
					actionId: "act-verify-auth-1",
					targetFindingId: "AUTH-1",
					prompt: "Verify AUTH-1.",
					tools: ["read"],
					outputProfile: "verification_result_v1",
				},
				{
					type: "add_work_item",
					actionId: "act-followup-tests",
					workItemId: "followup-tests",
					agent: "unit-scout",
					prompt: "Inspect missing auth tests.",
					tools: ["read"],
					outputProfile: "coverage_assessment_v1",
				},
			],
		};
		const r1 = validateDynamicDecision(decideR1, {
			expectedRound: 1,
			maxActions: 2,
			allowedTools: ["read"],
			knownFindingIds: ["AUTH-1"],
		});
		assert.equal(r1.ok, true, r1.errors.join("\n"));
		await writeDynamicDecisionArtifacts({
			cwd,
			runId,
			controllerSpecId,
			rawDecision: decideR1,
			validation: r1,
			stateIndexDigest: indexR0.digest,
		});

		const verifyAuth = extractDynamicStateArtifact({
			taskId: "verify-auth-1",
			outputProfile: "verification_result_v1",
			control: {
				findingId: "AUTH-1",
				verdict: "verified",
				confidence: "high",
				evidenceRefs: [{ taskId: "verify-auth-1", artifact: "control" }],
			},
		});
		const followupTests = extractDynamicStateArtifact({
			taskId: "followup-tests",
			outputProfile: "coverage_assessment_v1",
			control: {
				criteriaCoverage: {
					C1: { status: "satisfied" },
					C2: { status: "satisfied" },
				},
			},
		});
		const indexR1 = assembleDynamicStateIndex(
			[inspectAuth, inspectTests, verifyAuth, followupTests],
			{ requiredFindingIds: ["AUTH-1"] },
		);
		assert.equal(indexR1.findings[0].verificationStatus, "verified");
		assert.equal(
			indexR1.blockers.some((blocker) => blocker.id === "unverified-AUTH-1"),
			false,
		);
		await writeDynamicStateIndexArtifacts({
			cwd,
			runId,
			controllerSpecId,
			round: 1,
			extracts: [inspectAuth, inspectTests, verifyAuth, followupTests],
			index: indexR1,
		});

		const decideR2 = {
			schema: "dynamic-decision-v1",
			decisionId: "decide-r2",
			round: 2,
			phase: "final",
			status: "stop",
			nextActions: [
				{
					type: "stop",
					actionId: "act-stop-r2",
					reason:
						"Verified finding and coverage state are sufficient for synthesis.",
				},
			],
		};
		const r2 = validateDynamicDecision(decideR2, {
			expectedRound: 2,
		});
		assert.equal(r2.ok, true, r2.errors.join("\n"));
		const finalDecision = await writeDynamicDecisionArtifacts({
			cwd,
			runId,
			controllerSpecId,
			rawDecision: decideR2,
			validation: r2,
			stateIndexDigest: indexR1.digest,
		});

		assert.equal(existsSync(finalDecision.acceptedPath), true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

function dynamicLoopConfig(overrides = {}) {
	const base = {
		allowedAgents: ["unit-scout"],
		allowedTools: ["read"],
		allowedToolProviders: {},
		allowedOutputProfiles: [
			"candidate_findings_v1",
			"verification_result_v1",
			"coverage_assessment_v1",
			"generic_summary_v1",
			"synthesis_v1",
		],
		maxDecisionRounds: 3,
		maxActionsPerRound: 4,
		repair: { maxAttempts: 0 },
		stateIndex: { maxFindings: 10 },
		stopPolicy: {
			requireSynthesisAction: false,
			failOnInvalidDecision: false,
			maxStalls: 3,
			failOnDroppedRequiredBranch: false,
		},
	};
	return {
		...base,
		...overrides,
		repair: { ...base.repair, ...(overrides.repair ?? {}) },
		stateIndex: { ...base.stateIndex, ...(overrides.stateIndex ?? {}) },
		stopPolicy: { ...base.stopPolicy, ...(overrides.stopPolicy ?? {}) },
	};
}

function dynamicLoopPersistedDecision(decision, extras = {}) {
	return {
		ok: true,
		errors: [],
		decision: {
			schema: "dynamic-decision-v1",
			decisionId: `decide-r${decision.round}`,
			phase:
				decision.status === "stop" || decision.status === "synthesize"
					? "final"
					: "round",
			...decision,
		},
		decisionHash: `hash-${decision.round}`,
		...extras,
	};
}

function dynamicLoopInvalidDecision(errors = ["invalid decision"]) {
	return { ok: false, errors };
}

function makeDynamicDecisionLoopCtx({
	config = dynamicLoopConfig(),
	persistedDecisions = [],
	agentResults = {},
	generatedTaskIds = [],
	stateIndexDigests = [],
} = {}) {
	const calls = {
		agent: [],
		validationContexts: [],
		stateIndexRequests: [],
		decisionLoopStatus: [],
	};
	let validationIndex = 0;
	const ctx = {
		task: "Unit dynamic task",
		sources: { seed: { digest: "sha256:seed" } },
		graph: { generatedTaskIds: () => [...generatedTaskIds] },
		dynamic: {
			config: () => config,
			async recordDecisionLoopStatus(status) {
				calls.decisionLoopStatus.push(status);
			},
		},
		decision: {
			async validateAndPersist(_rawDecision, context) {
				calls.validationContexts.push(context);
				const persisted = persistedDecisions[validationIndex];
				validationIndex += 1;
				if (!persisted) {
					throw new Error(
						`unexpected decision validation call ${validationIndex}`,
					);
				}
				return persisted;
			},
		},
		stateIndex: {
			async extractAndPersist(request) {
				calls.stateIndexRequests.push(request);
				return {
					digest:
						stateIndexDigests[calls.stateIndexRequests.length - 1] ??
						`index-${calls.stateIndexRequests.length}`,
					index: {},
					artifacts: {},
				};
			},
		},
		async agent(request) {
			calls.agent.push(request);
			if (request.profile === "planner") {
				return { control: { plannerRequestId: request.id } };
			}
			return (
				agentResults[request.id] ?? {
					taskId: `${request.id}-task`,
					specId: `${request.id}-spec`,
					control: { digest: `${request.id}-digest` },
				}
			);
		},
	};
	return { ctx, calls };
}

function makeValidatingDynamicDecisionLoopCtx({
	config = dynamicLoopConfig(),
	plannerControls = [],
	plannerAnalyses = [],
	plannerRefs = [],
	agentResults = {},
	generatedTaskIds = [],
	stateIndexDigests = [],
} = {}) {
	const calls = {
		agent: [],
		validationResults: [],
		stateIndexRequests: [],
		decisionLoopStatus: [],
	};
	let plannerIndex = 0;
	const ctx = {
		task: "Unit dynamic task",
		sources: { seed: { digest: "sha256:seed" } },
		graph: { generatedTaskIds: () => [...generatedTaskIds] },
		dynamic: {
			config: () => config,
			async recordDecisionLoopStatus(status) {
				calls.decisionLoopStatus.push(status);
			},
		},
		decision: {
			async validateAndPersist(rawDecision, context) {
				const validation = validateDynamicDecision(rawDecision, context);
				calls.validationResults.push(validation);
				return {
					ok: validation.ok,
					errors: validation.errors,
					decision: validation.decision,
					decisionHash: validation.hash,
				};
			},
		},
		stateIndex: {
			async extractAndPersist(request) {
				calls.stateIndexRequests.push(request);
				return {
					digest:
						stateIndexDigests[calls.stateIndexRequests.length - 1] ??
						`index-${calls.stateIndexRequests.length}`,
					index: {},
					artifacts: {},
				};
			},
		},
		async agent(request) {
			calls.agent.push(request);
			if (request.profile === "planner") {
				const index = plannerIndex;
				const control = plannerControls[index];
				plannerIndex += 1;
				if (control === undefined) {
					throw new Error(`unexpected planner call ${plannerIndex}`);
				}
				return {
					control,
					...(plannerAnalyses[index] !== undefined
						? { analysis: plannerAnalyses[index] }
						: {}),
					...(plannerRefs[index] !== undefined
						? { refs: plannerRefs[index] }
						: {}),
				};
			}
			return (
				agentResults[request.id] ?? {
					taskId: `${request.id}-task`,
					specId: `${request.id}-spec`,
					control: { digest: `${request.id}-digest` },
				}
			);
		},
	};
	return { ctx, calls };
}

function dynamicLoopAliasDriftRawDecision() {
	return {
		schema: "dynamic-decision-v1",
		decisionId: "decide-r0",
		round: 0,
		phase: "round",
		status: "continue",
		actions: [
			{
				type: "add_work_item",
				actionId: "act-review",
				workItemId: "review",
				agent: "unit-scout",
				prompt: "Review the target.",
				tools: ["read"],
				outputProfile: "candidate_findings_v1",
			},
		],
	};
}

function dynamicLoopValidWorkDecision() {
	return {
		schema: "dynamic-decision-v1",
		decisionId: "decide-r0",
		round: 0,
		phase: "round",
		status: "continue",
		nextActions: [
			{
				type: "add_work_item",
				actionId: "act-review",
				workItemId: "review",
				agent: "unit-scout",
				prompt: "Review the target.",
				tools: ["read"],
				outputProfile: "candidate_findings_v1",
			},
		],
	};
}

function plannerCalls(calls) {
	return calls.agent.filter((request) => request.profile === "planner");
}

function dispatchedCalls(calls) {
	return calls.agent.filter((request) => request.profile !== "planner");
}

test("runDynamicDecisionLoop treats deprecated config fields as no-op and hides them from planner prompts", async () => {
	async function runWithConfig(config) {
		const { ctx, calls } = makeValidatingDynamicDecisionLoopCtx({
			config,
			plannerControls: [dynamicLoopValidWorkDecision()],
			agentResults: {
				review: { taskId: "review", specId: "adaptive.review" },
			},
		});
		const result = await runDynamicDecisionLoop(ctx);
		return {
			result,
			plannerPrompt: plannerCalls(calls)[0]?.prompt ?? "",
			dispatched: dispatchedCalls(calls).map((request) => ({
				id: request.id,
				profile: request.profile,
				prompt: request.prompt,
				outputProfile: request.outputProfile,
				dependsOn: request.dependsOn,
			})),
			stateIndexRequests: calls.stateIndexRequests,
		};
	}
	const baseline = await runWithConfig(
		dynamicLoopConfig({ maxDecisionRounds: 1 }),
	);
	const withDeprecated = await runWithConfig(
		dynamicLoopConfig({
			maxDecisionRounds: 1,
			stateIndex: {
				maxFindings: 10,
				requiredFindingIds: ["F-deprecated"],
			},
			stopPolicy: {
				requireSynthesisAction: true,
				failOnInvalidDecision: false,
				failOnDroppedRequiredBranch: true,
			},
		}),
	);

	assert.equal(
		withDeprecated.result.control.status,
		baseline.result.control.status,
	);
	assert.deepEqual(
		withDeprecated.result.control.generatedTasks,
		baseline.result.control.generatedTasks,
	);
	assert.deepEqual(withDeprecated.dispatched, baseline.dispatched);
	assert.deepEqual(
		withDeprecated.stateIndexRequests,
		baseline.stateIndexRequests,
	);
	for (const hidden of [
		"requireSynthesisAction",
		"failOnDroppedRequiredBranch",
		"requiredFindingIds",
		"F-deprecated",
	]) {
		assert.equal(
			withDeprecated.plannerPrompt.includes(hidden),
			false,
			`${hidden} surfaced in planner prompt`,
		);
	}
});

test("runDynamicDecisionLoop records planner prose outside control JSON", async () => {
	const { ctx } = makeValidatingDynamicDecisionLoopCtx({
		config: dynamicLoopConfig({ maxDecisionRounds: 1 }),
		plannerControls: [dynamicLoopValidWorkDecision()],
		plannerAnalyses: ["Planner rationale and strategy live here."],
		plannerRefs: [[{ taskId: "seed", artifact: "analysis" }]],
		agentResults: {
			review: { taskId: "review", specId: "adaptive.review" },
		},
	});

	const result = await runDynamicDecisionLoop(ctx);

	assert.match(result.analysis, /Planner rationale and strategy live here\./);
	assert.deepEqual(result.refs, [{ taskId: "seed", artifact: "analysis" }]);
	assert.equal(Object.hasOwn(result.control, "analysis"), false);
	assert.equal(Object.hasOwn(result.control, "rationale"), false);
});

test("runDynamicDecisionLoop sends compact artifact-ref handoff without inlining large blobs", async () => {
	const largeBlob = `BEGIN-LARGE-${"x".repeat(5000)}-END-LARGE`;
	const decision = {
		...dynamicLoopValidWorkDecision(),
		nextActions: [
			{
				type: "add_work_item",
				actionId: "act-review",
				workItemId: "review",
				agent: "unit-scout",
				prompt: `Review the declared scope.\n${largeBlob}`,
				tools: ["read"],
				outputProfile: "candidate_findings_v1",
				inputRefs: [
					{
						kind: "workflow-artifact-ref",
						taskId: "seed.main",
						artifact: "control",
						digest: "sha256:seed",
					},
				],
			},
		],
	};
	const { ctx, calls } = makeValidatingDynamicDecisionLoopCtx({
		config: dynamicLoopConfig({ maxDecisionRounds: 1 }),
		plannerControls: [decision],
		generatedTaskIds: ["seed.main"],
		agentResults: {
			review: { taskId: "review", specId: "adaptive.review" },
		},
	});

	await runDynamicDecisionLoop(ctx);
	const [worker] = dispatchedCalls(calls);

	assert.equal(worker.profile, "worker");
	assert.match(worker.prompt, /# Dynamic Worker Handoff/);
	assert.match(worker.prompt, /## Objective\nReview the declared scope\./);
	assert.match(worker.prompt, /## Output Profile\ncandidate_findings_v1/);
	assert.match(
		worker.prompt,
		/## Input Artifact Refs\n- seed\.main\.control \(digest sha256:seed\)/,
	);
	assert.equal(worker.prompt.includes(largeBlob), false);
	assert.ok(worker.prompt.length < largeBlob.length / 2);
	assert.deepEqual(worker.inputs, [
		{
			kind: "workflow-artifact-ref",
			name: "seed.main.control",
			options: { digest: "sha256:seed" },
		},
	]);
});

test("runDynamicDecisionLoop repairs unknown dynamic inputRefs before fanout", async () => {
	const invalidRefDecision = {
		...dynamicLoopValidWorkDecision(),
		nextActions: [
			{
				type: "add_work_item",
				actionId: "act-review",
				workItemId: "review",
				agent: "unit-scout",
				prompt: "Review the declared scope.",
				tools: ["read"],
				outputProfile: "candidate_findings_v1",
				inputRefs: [
					{
						kind: "workflow-artifact-ref",
						taskId: "task-1",
						artifact: "analysis",
					},
				],
			},
		],
	};
	const config = dynamicLoopConfig({
		maxDecisionRounds: 1,
		repair: { maxAttempts: 1 },
		stopPolicy: { failOnInvalidDecision: true },
	});
	const { ctx, calls } = makeValidatingDynamicDecisionLoopCtx({
		config,
		plannerControls: [invalidRefDecision, dynamicLoopValidWorkDecision()],
		agentResults: { review: { taskId: "review", specId: "adaptive.review" } },
	});

	await runDynamicDecisionLoop(ctx);

	assert.deepEqual(
		calls.validationResults.map((validation) => validation.ok),
		[false, true],
	);
	assert.match(
		calls.validationResults[0].errors.join("\n"),
		/\.inputRefs\[0\]\.taskId references unknown artifact task/,
	);
	assert.deepEqual(
		plannerCalls(calls).map((request) => request.id),
		["decide-r0", "decide-r0-repair-1"],
	);
	assert.equal(dispatchedCalls(calls).length, 1);
});

test("runDynamicDecisionLoop repairs reused generated task ids before fanout", async () => {
	const reusedWorkItemDecision = {
		...dynamicLoopValidWorkDecision(),
		nextActions: [
			{
				type: "add_work_item",
				actionId: "act-review-again",
				workItemId: "adaptive.review",
				agent: "unit-scout",
				prompt: "Review the same generated task again.",
				tools: ["read"],
				outputProfile: "candidate_findings_v1",
			},
		],
	};
	const config = dynamicLoopConfig({
		maxDecisionRounds: 1,
		repair: { maxAttempts: 1 },
		stopPolicy: { failOnInvalidDecision: true },
	});
	const freshWorkItemDecision = {
		...dynamicLoopValidWorkDecision(),
		nextActions: [
			{
				type: "add_work_item",
				actionId: "act-review-fresh",
				workItemId: "review-2",
				agent: "unit-scout",
				prompt: "Review a fresh generated task.",
				tools: ["read"],
				outputProfile: "candidate_findings_v1",
			},
		],
	};
	const { ctx, calls } = makeValidatingDynamicDecisionLoopCtx({
		config,
		generatedTaskIds: ["adaptive.review"],
		plannerControls: [reusedWorkItemDecision, freshWorkItemDecision],
		agentResults: {
			"review-2": { taskId: "review-2", specId: "adaptive.review-2" },
		},
	});

	await runDynamicDecisionLoop(ctx);

	assert.deepEqual(
		calls.validationResults.map((validation) => validation.ok),
		[false, true],
	);
	assert.match(
		calls.validationResults[0].errors.join("\n"),
		/workItemId already exists as a generated task/,
	);
	assert.deepEqual(
		plannerCalls(calls).map((request) => request.id),
		["decide-r0", "decide-r0-repair-1"],
	);
	assert.equal(dispatchedCalls(calls).length, 1);
});

test("runDynamicDecisionLoop shape-repairs drift then dispatches accepted work once", async () => {
	const config = dynamicLoopConfig({
		maxDecisionRounds: 1,
		maxActionsPerRound: 1,
		repair: { maxAttempts: 2 },
		stopPolicy: { failOnInvalidDecision: true },
	});
	const { ctx, calls } = makeValidatingDynamicDecisionLoopCtx({
		config,
		plannerControls: [
			dynamicLoopAliasDriftRawDecision(),
			dynamicLoopValidWorkDecision(),
		],
		agentResults: { review: { taskId: "review", specId: "adaptive.review" } },
	});

	const result = await runDynamicDecisionLoop(ctx);
	const planners = plannerCalls(calls);
	const dispatched = dispatchedCalls(calls);

	assert.equal(result.control.status, "exhausted");
	assert.equal(result.control.decisions.length, 1);
	assert.deepEqual(
		calls.validationResults.map((validation) => validation.ok),
		[false, true],
	);
	assert.equal(
		calls.validationResults.filter((validation) => validation.ok).length,
		1,
	);
	assert.equal(planners.length, 2);
	assert.ok(planners.length <= 1 + config.repair.maxAttempts);
	assert.match(planners[1].prompt, /previous decision was invalid/);
	assert.match(
		planners[1].prompt,
		/decision field actions is not allowed; use nextActions/,
	);
	assert.deepEqual(
		planners.map((request) => request.id),
		["decide-r0", "decide-r0-repair-1"],
	);
	assert.equal(dispatched.length, 1);
	assert.equal(dispatched[0].profile, "worker");
	assert.equal(dispatched[0].id, "review");
	assert.deepEqual(result.control.generatedTasks, ["adaptive.review"]);
	assert.equal(calls.stateIndexRequests.length, 1);
});

test("runDynamicDecisionLoop exhausts repair and blocks without dispatch when failOnInvalidDecision is true", async () => {
	const config = dynamicLoopConfig({
		maxDecisionRounds: 1,
		repair: { maxAttempts: 2 },
		stopPolicy: { failOnInvalidDecision: true },
	});
	const invalid = dynamicLoopAliasDriftRawDecision();
	const { ctx, calls } = makeValidatingDynamicDecisionLoopCtx({
		config,
		plannerControls: [invalid, invalid, invalid],
	});

	const result = await runDynamicDecisionLoop(ctx);
	const planners = plannerCalls(calls);
	assert.equal(result.control.status, "blocked");
	assert.match(
		result.control.blockers.join("\n"),
		/decision field actions is not allowed; use nextActions/,
	);
	assert.deepEqual(result.control.generatedTasks, []);
	assert.equal(planners.length, 1 + config.repair.maxAttempts);
	assert.ok(planners.length <= 1 + config.repair.maxAttempts);
	assert.deepEqual(dispatchedCalls(calls), []);
	assert.equal(calls.stateIndexRequests.length, 0);
	assert.deepEqual(
		calls.validationResults.map((validation) => validation.ok),
		[false, false, false],
	);
});

test("runDynamicDecisionLoop exhausts repair and blocks without dispatch when failOnInvalidDecision is false", async () => {
	const config = dynamicLoopConfig({
		maxDecisionRounds: 1,
		repair: { maxAttempts: 2 },
		stopPolicy: { failOnInvalidDecision: false },
	});
	const invalid = dynamicLoopAliasDriftRawDecision();
	const { ctx, calls } = makeValidatingDynamicDecisionLoopCtx({
		config,
		plannerControls: [invalid, invalid, invalid],
	});

	const result = await runDynamicDecisionLoop(ctx);
	const planners = plannerCalls(calls);

	assert.equal(result.control.status, "blocked");
	assert.match(
		result.control.blockers.join("\n"),
		/decision field actions is not allowed; use nextActions/,
	);
	assert.deepEqual(result.control.generatedTasks, []);
	assert.equal(planners.length, 1 + config.repair.maxAttempts);
	assert.ok(planners.length <= 1 + config.repair.maxAttempts);
	assert.deepEqual(dispatchedCalls(calls), []);
	assert.equal(calls.stateIndexRequests.length, 0);
	assert.deepEqual(
		calls.validationResults.map((validation) => validation.ok),
		[false, false, false],
	);
});

test("runDynamicDecisionLoop stops on accepted stop decision", async () => {
	const { ctx, calls } = makeDynamicDecisionLoopCtx({
		persistedDecisions: [
			dynamicLoopPersistedDecision({
				decisionId: "decide-r0",
				round: 0,
				status: "stop",
				nextActions: [
					{
						type: "stop",
						actionId: "stop-r0",
						reason: "enough evidence",
						caveats: ["sample caveat"],
					},
				],
			}),
		],
	});

	const result = await runDynamicDecisionLoop(ctx);

	assert.equal(result.control.status, "stopped");
	assert.deepEqual(result.control.blockers, ["enough evidence"]);
	assert.deepEqual(result.control.caveats, ["sample caveat"]);
	assert.deepEqual(result.control.generatedTasks, []);
	assert.deepEqual(
		calls.agent.map((request) => request.id),
		["decide-r0"],
	);
});

test("runDynamicDecisionLoop runs synthesis actions and returns synthesized", async () => {
	const { ctx, calls } = makeDynamicDecisionLoopCtx({
		agentResults: { "synth-final": { specId: "adaptive.synthesis" } },
		persistedDecisions: [
			dynamicLoopPersistedDecision({
				decisionId: "decide-r0",
				round: 0,
				status: "synthesize",
				nextActions: [{ type: "synthesize", actionId: "synth-final" }],
			}),
		],
	});

	const result = await runDynamicDecisionLoop(ctx);

	assert.equal(result.control.status, "synthesized");
	assert.deepEqual(result.control.generatedTasks, ["adaptive.synthesis"]);
	assert.deepEqual(result.control.outputTasks, ["adaptive.synthesis"]);
	assert.deepEqual(
		calls.agent.map((request) => request.profile),
		["planner", "synthesis"],
	);
	assert.equal(calls.agent[1].outputProfile, "synthesis_v1");
	assert.equal(calls.stateIndexRequests.length, 0);
});

test("runDynamicDecisionLoop returns exhausted when maxRounds is reached", async () => {
	const { ctx, calls } = makeDynamicDecisionLoopCtx({
		config: dynamicLoopConfig({ maxDecisionRounds: 2 }),
		persistedDecisions: [
			dynamicLoopPersistedDecision({
				decisionId: "decide-r0",
				round: 0,
				status: "continue",
				nextActions: [],
			}),
			dynamicLoopPersistedDecision({
				decisionId: "decide-r1",
				round: 1,
				status: "continue",
				nextActions: [],
			}),
		],
	});

	const result = await runDynamicDecisionLoop(ctx);

	assert.equal(result.control.status, "exhausted");
	assert.equal(result.control.decisions.length, 2);
	assert.deepEqual(result.control.omissions, [
		"round 0 accepted no executable work actions",
		"round 1 accepted no executable work actions",
	]);
	assert.equal(calls.validationContexts.length, 2);
	assert.equal(calls.stateIndexRequests.length, 0);
});

test("runDynamicDecisionLoop increments stalls on no-progress and decrements on progress", async () => {
	const { ctx, calls } = makeDynamicDecisionLoopCtx({
		config: dynamicLoopConfig({
			maxDecisionRounds: 3,
			stopPolicy: { maxStalls: 10 },
		}),
		persistedDecisions: [
			dynamicLoopPersistedDecision({
				decisionId: "decide-r0",
				round: 0,
				status: "continue",
				nextActions: [],
			}),
			dynamicLoopPersistedDecision({
				decisionId: "decide-r1",
				round: 1,
				status: "continue",
				nextActions: [
					{
						type: "add_work_item",
						actionId: "act-review-1",
						workItemId: "review-1",
						prompt: "Review target 1.",
					},
				],
			}),
			dynamicLoopPersistedDecision({
				decisionId: "decide-r2",
				round: 2,
				status: "continue",
				nextActions: [
					{
						type: "add_work_item",
						actionId: "act-review-2",
						workItemId: "review-2",
						prompt: "Review target 2.",
					},
				],
			}),
		],
		agentResults: {
			"review-1": { taskId: "review-1", specId: "adaptive.review-1" },
			"review-2": { taskId: "review-2", specId: "adaptive.review-2" },
		},
	});

	const result = await runDynamicDecisionLoop(ctx);

	assert.equal(result.control.status, "exhausted");
	assert.deepEqual(calls.decisionLoopStatus, [
		{ stallCount: 1, replanCount: 0 },
		{ stallCount: 0, replanCount: 0 },
		{ stallCount: 0, replanCount: 0 },
	]);
	assert.match(result.analysis, /Stall counter: 0\./);
});

test("runDynamicDecisionLoop adds an extra stall for repeated loop signature", async () => {
	const config = dynamicLoopConfig({
		maxDecisionRounds: 2,
		stopPolicy: { maxStalls: 10 },
	});
	const nextActions = [
		{
			type: "verify",
			actionId: "verify-repeat-a",
			targetFindingId: "finding-repeat",
			prompt: "Re-check unchanged finding A.",
		},
		{
			type: "verify",
			actionId: "verify-repeat-b",
			targetFindingId: "finding-repeat",
			prompt: "Re-check unchanged finding B.",
		},
	];
	const rawDecision = (round) => ({
		schema: "dynamic-decision-v1",
		decisionId: `decide-r${round}`,
		round,
		phase: "round",
		status: "continue",
		nextActions,
	});
	const validationContext = (round) => ({
		expectedRound: round,
		maxActions: config.maxActionsPerRound,
		maxDecisionRounds: config.maxDecisionRounds,
		allowedTools: config.allowedTools,
		toolProviders: config.allowedToolProviders,
		allowedOutputProfiles: config.allowedOutputProfiles,
		allowedAgents: config.allowedAgents,
		requireAgent: false,
		knownGeneratedTaskIds: [],
	});
	const accepted = [0, 1].map((round) =>
		validateDynamicDecision(rawDecision(round), validationContext(round)),
	);
	for (const validation of accepted) {
		assert.equal(validation.ok, true, validation.errors.join("\n"));
		assert(validation.decision);
	}
	assert.notEqual(accepted[0].hash, accepted[1].hash);
	assert.equal(
		dynamicLoopSignature(accepted[0].decision),
		dynamicLoopSignature(accepted[1].decision),
	);

	const { ctx, calls } = makeValidatingDynamicDecisionLoopCtx({
		config,
		plannerControls: [rawDecision(0), rawDecision(1)],
	});
	const originalAgent = ctx.agent;
	ctx.agent = async (request) => {
		if (request.profile === "planner") return await originalAgent(request);
		calls.agent.push(request);
		throw new Error("worker did not complete");
	};
	ctx.parallel = async (thunks) =>
		Promise.allSettled(thunks.map(async (thunk) => await thunk()));

	await runDynamicDecisionLoop(ctx);

	assert.deepEqual(calls.decisionLoopStatus, [
		{ stallCount: 1, replanCount: 0 },
		{ stallCount: 3, replanCount: 0 },
	]);
});

test("runDynamicDecisionLoop triggers one bounded replan prompt with stall context", async () => {
	const config = dynamicLoopConfig({
		maxDecisionRounds: 2,
		stopPolicy: { maxStalls: 1 },
	});
	const { ctx, calls } = makeDynamicDecisionLoopCtx({
		config,
		persistedDecisions: [
			dynamicLoopPersistedDecision({
				decisionId: "decide-r0",
				round: 0,
				status: "continue",
				nextActions: [],
			}),
			dynamicLoopPersistedDecision({
				decisionId: "decide-r1",
				round: 1,
				status: "stop",
				nextActions: [
					{
						type: "stop",
						actionId: "stop-r1",
						reason: "replanned stop",
					},
				],
			}),
		],
	});

	const result = await runDynamicDecisionLoop(ctx);
	const planners = plannerCalls(calls);

	assert.equal(result.control.status, "stopped");
	assert.equal(planners.length, 2);
	assert.match(planners[1].prompt, /Replan requested/);
	assert.match(planners[1].prompt, /Rounds without progress: 1\./);
	assert.match(planners[1].prompt, /Last state index digest: none\./);
	assert.deepEqual(calls.decisionLoopStatus, [
		{ stallCount: 1, replanCount: 1 },
	]);
});

test("runDynamicDecisionLoop blocks after replan budget exhausts with no progress", async () => {
	const config = dynamicLoopConfig({
		maxDecisionRounds: 3,
		stopPolicy: { maxStalls: 1 },
	});
	const noProgress = (round) =>
		dynamicLoopPersistedDecision({
			decisionId: `decide-r${round}`,
			round,
			status: "continue",
			nextActions: [],
		});
	const { ctx, calls } = makeDynamicDecisionLoopCtx({
		config,
		persistedDecisions: [noProgress(0), noProgress(1)],
	});

	const result = await runDynamicDecisionLoop(ctx);

	assert.equal(result.control.status, "blocked");
	assert.match(result.control.blockers.join("\n"), /decision loop stalled/);
	assert.equal(plannerCalls(calls).length, 2);
	assert.deepEqual(dispatchedCalls(calls), []);
	assert.deepEqual(calls.decisionLoopStatus, [
		{ stallCount: 1, replanCount: 1 },
		{ stallCount: 3, replanCount: 1 },
	]);
});

test("runDynamicDecisionLoop keeps maxDecisionRounds as an absolute cap", async () => {
	const { ctx, calls } = makeDynamicDecisionLoopCtx({
		config: dynamicLoopConfig({
			maxDecisionRounds: 1,
			stopPolicy: { maxStalls: 1 },
		}),
		persistedDecisions: [
			dynamicLoopPersistedDecision({
				decisionId: "decide-r0",
				round: 0,
				status: "continue",
				nextActions: [],
			}),
		],
	});

	const result = await runDynamicDecisionLoop(ctx);

	assert.equal(result.control.status, "exhausted");
	assert.equal(plannerCalls(calls).length, 1);
	assert.deepEqual(calls.decisionLoopStatus, [
		{ stallCount: 1, replanCount: 0 },
	]);
});

test("runDynamicDecisionLoop persists and recomputes stall/replan counters deterministically", async () => {
	const cwd = makeProject();
	try {
		const config = dynamicLoopConfig({
			maxDecisionRounds: 3,
			stopPolicy: { maxStalls: 1 },
		});
		const noProgress = (round) =>
			dynamicLoopPersistedDecision({
				decisionId: `decide-r${round}`,
				round,
				status: "continue",
				nextActions: [],
			});
		async function runAndPersist(runId) {
			const { ctx, calls } = makeDynamicDecisionLoopCtx({
				config,
				persistedDecisions: [noProgress(0), noProgress(1)],
			});
			ctx.dynamic.recordDecisionLoopStatus = async (status) => {
				calls.decisionLoopStatus.push(status);
				const callIndex = calls.decisionLoopStatus.length;
				const payload = {
					callIndex,
					status: "running",
					decisionLoop: status,
				};
				await appendDynamicEvent(cwd, runId, {
					controllerSpecId: "adaptive.controller",
					type: "controller.status",
					opId: `adaptive.controller:decision-loop-status:${String(callIndex).padStart(3, "0")}`,
					requestHash: hashDynamicRequest(payload),
					payload,
				});
			};
			return {
				result: await runDynamicDecisionLoop(ctx),
				statuses: calls.decisionLoopStatus,
			};
		}

		const first = await runAndPersist("workflow_stall_replay_1");
		const projected = await rebuildDynamicState(cwd, "workflow_stall_replay_1");
		const second = await runAndPersist("workflow_stall_replay_2");

		assert.equal(first.result.control.status, "blocked");
		assert.equal(second.result.control.status, first.result.control.status);
		assert.deepEqual(second.statuses, first.statuses);
		assert.deepEqual(
			projected.controllers["adaptive.controller"].decisionLoop,
			{ stallCount: 3, replanCount: 1 },
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("runDynamicDecisionLoop blocks on invalid decision when failOnInvalidDecision is false", async () => {
	const invalid = dynamicLoopInvalidDecision(["missing nextActions"]);
	const { ctx, calls } = makeDynamicDecisionLoopCtx({
		config: dynamicLoopConfig({ repair: { maxAttempts: 1 } }),
		persistedDecisions: [invalid, invalid],
	});

	const result = await runDynamicDecisionLoop(ctx);

	assert.equal(result.control.status, "blocked");
	assert.match(result.control.blockers.join("\n"), /missing nextActions/);
	assert.deepEqual(
		calls.agent.map((request) => request.id),
		["decide-r0", "decide-r0-repair-1"],
	);
	assert.equal(calls.validationContexts.length, 2);
});

test("runDynamicDecisionLoop uses shared validator and blocks alias drift before dispatch", async () => {
	const config = dynamicLoopConfig({
		maxDecisionRounds: 1,
		repair: { maxAttempts: 0 },
	});
	const rawDecision = {
		schema: "dynamic-decision-v1",
		decisionId: "decide-r0",
		round: 0,
		phase: "orientation",
		status: "continue",
		nextActions: [
			{
				action: "add_work_item",
				id: "act-review",
				workItemId: "review",
				prompt: "Review the target.",
				outputProfile: "candidate_findings_v1",
			},
		],
	};
	const official = validateDynamicDecision(rawDecision, {
		expectedRound: 0,
		maxActions: config.maxActionsPerRound,
		maxDecisionRounds: config.maxDecisionRounds,
		allowedTools: config.allowedTools,
		toolProviders: config.allowedToolProviders,
		allowedOutputProfiles: config.allowedOutputProfiles,
		allowedAgents: config.allowedAgents,
		requireAgent: false,
		knownGeneratedTaskIds: [],
	});
	const calls = { agent: [], validationResults: [] };
	const ctx = {
		task: "Unit dynamic task",
		sources: {},
		graph: { generatedTaskIds: () => [] },
		dynamic: { config: () => config },
		decision: {
			async validateAndPersist(decision, context) {
				const validation = validateDynamicDecision(decision, context);
				calls.validationResults.push(validation);
				return {
					ok: validation.ok,
					errors: validation.errors,
					decision: validation.decision,
					decisionHash: validation.hash,
				};
			},
		},
		stateIndex: {
			async extractAndPersist() {
				throw new Error("state index should not run for invalid decisions");
			},
		},
		async agent(request) {
			calls.agent.push(request);
			if (request.profile === "planner") return { control: rawDecision };
			return {
				taskId: `${request.id}-task`,
				specId: `${request.id}-spec`,
			};
		},
	};

	assert.equal(official.ok, false);
	assert.match(
		official.errors.join("\n"),
		/nextActions\[0\]\.action is not allowed; use type/,
	);
	assert.match(
		official.errors.join("\n"),
		/nextActions\[0\]\.id is not allowed; use actionId/,
	);

	const result = await runDynamicDecisionLoop(ctx);

	assert.equal(result.control.status, "blocked");
	assert.deepEqual(result.control.generatedTasks, []);
	assert.equal(calls.validationResults.length, 1);
	assert.deepEqual(calls.validationResults[0].errors, official.errors);
	assert.deepEqual(
		calls.agent.map((request) => `${request.profile}:${request.id}`),
		["planner:decide-r0"],
	);
	assert.match(
		result.control.blockers.join("\n"),
		/nextActions\[0\]\.action is not allowed; use type/,
	);
});

test("runDynamicDecisionLoop returns blocked invalid decision result when failOnInvalidDecision is true", async () => {
	const invalid = dynamicLoopInvalidDecision(["malformed control"]);
	const { ctx, calls } = makeDynamicDecisionLoopCtx({
		config: dynamicLoopConfig({
			repair: { maxAttempts: 1 },
			stopPolicy: { failOnInvalidDecision: true },
		}),
		persistedDecisions: [invalid, invalid],
	});

	const result = await runDynamicDecisionLoop(ctx);
	assert.equal(result.control.status, "blocked");
	assert.match(
		result.control.blockers.join("\n"),
		/round 0 decision invalid: malformed control/,
	);
	assert.deepEqual(
		calls.agent.map((request) => request.id),
		["decide-r0", "decide-r0-repair-1"],
	);
});

test("runDynamicDecisionLoop does not plan fanout for intended stop or invalid decisions", async () => {
	let fanoutCalls = 0;
	const stopped = makeDynamicDecisionLoopCtx({
		persistedDecisions: [
			dynamicLoopPersistedDecision({
				decisionId: "decide-r0",
				round: 0,
				status: "stop",
				nextActions: [{ type: "stop", actionId: "stop-r0", reason: "done" }],
			}),
		],
	});
	stopped.ctx.fanout = {
		async plan() {
			fanoutCalls += 1;
			throw new Error("stop decisions must not plan fanout");
		},
	};

	const stopResult = await runDynamicDecisionLoop(stopped.ctx);
	assert.equal(stopResult.control.status, "stopped");
	assert.equal(fanoutCalls, 0);

	const invalid = makeDynamicDecisionLoopCtx({
		config: dynamicLoopConfig({ repair: { maxAttempts: 0 } }),
		persistedDecisions: [dynamicLoopInvalidDecision(["missing nextActions"])],
	});
	invalid.ctx.fanout = stopped.ctx.fanout;
	const invalidResult = await runDynamicDecisionLoop(invalid.ctx);
	assert.equal(invalidResult.control.status, "blocked");
	assert.match(
		invalidResult.control.blockers.join("\n"),
		/missing nextActions/,
	);
	assert.equal(fanoutCalls, 0);
});

test("dynamic state cache rebuilds when state.json is missing or corrupt", async () => {
	const cwd = makeProject();
	try {
		const runId = "workflow_dynamic_rebuild";
		await appendDynamicEvent(cwd, runId, {
			controllerSpecId: "adaptive.controller",
			type: "controller.initialized",
			opId: "init",
			requestHash: "hash-init",
			payload: { status: "pending" },
		});
		await appendDynamicEvent(cwd, runId, {
			controllerSpecId: "adaptive.controller",
			type: "controller.status",
			opId: "running",
			requestHash: "hash-running",
			payload: { status: "running" },
		});
		writeFileSync(dynamicStatePath(cwd, runId), "{not valid json\n");

		const state = await readOrRebuildDynamicState(cwd, runId);
		assert.equal(state.controllers["adaptive.controller"].status, "running");
		assert.equal(state.controllers["adaptive.controller"].lastEventSeq, 2);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph runtime dynamic executes trusted controller and writes aggregate", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			[
				"export default async function controller(ctx) {",
				"  ctx.phase('map');",
				"  return {",
				"    control: { schema: 'dynamic-controller-result-v1', summary: 'done', generatedTaskIds: ctx.graph.generatedTaskIds(), sourceCount: Object.keys(ctx.sources).length },",
				"    analysis: `task=${ctx.task}`,",
				"    refs: []",
				"  };",
				"}",
			].join("\n"),
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: { uses: "./helpers/controller.mjs" },
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Review dynamically.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			"export default async function controller() { throw new Error('live controller should not run'); }\n",
		);
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		const updated = await readRunRecord(cwd, run.runId);
		const controllerTask = updated.tasks.find(
			(task) => task.specId === "adaptive.controller",
		);
		assert.equal(controllerTask?.status, "completed");
		assert.equal(controllerTask?.statusDetail, "dynamic_completed");
		assert.equal(
			updated.dynamic?.events,
			`.pi/workflows/${run.runId}/dynamic/events.jsonl`,
		);
		assert.equal(
			existsSync(join(cwd, ".pi", "workflows", run.runId, "dynamic")),
			true,
		);
		assert.equal(
			controllerTask?.agentFile,
			`.pi/workflows/${run.runId}/bundle/helpers/controller.mjs`,
		);
		assert.match(
			readFileSync(dynamicEventsPath(cwd, run.runId), "utf8"),
			/controller\.phase/,
		);
		const state = await readOrRebuildDynamicState(cwd, run.runId);
		assert.equal(state.controllers["adaptive.controller"].status, "complete");
		assert.equal(state.controllers["adaptive.controller"].phase, "map");
		const control = JSON.parse(
			readFileSync(
				join(dirname(join(cwd, controllerTask.files.result)), "control.json"),
				"utf8",
			),
		);
		assert.equal(control.schema, "dynamic-controller-result-v1");
		assert.equal(control.digest, "done");
		assert.equal(control.sourceCount, 0);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("runDynamicDecisionLoop projects dependent branch spec ids consistently", async () => {
	let fanoutPlan;
	const { ctx, calls } = makeDynamicDecisionLoopCtx({
		config: dynamicLoopConfig({ maxDecisionRounds: 1, maxActionsPerRound: 3 }),
		persistedDecisions: [
			dynamicLoopPersistedDecision({
				round: 0,
				status: "continue",
				nextActions: [
					{
						type: "add_work_item",
						actionId: "act-src",
						workItemId: "src",
						prompt: "Inspect source policy.",
						outputProfile: "candidate_findings_v1",
					},
					{
						type: "add_work_item",
						actionId: "act-tests",
						workItemId: "tests",
						prompt: "Inspect test policy.",
						outputProfile: "coverage_assessment_v1",
					},
					{
						type: "add_work_item",
						actionId: "act-cross-check",
						workItemId: "cross-check",
						prompt: "Cross-check source and test evidence.",
						outputProfile: "verification_result_v1",
						dependsOn: ["src", "tests"],
					},
				],
			}),
		],
		agentResults: {
			src: {
				taskId: "src",
				specId: "adaptive.src",
				control: { digest: "src done" },
			},
			tests: {
				taskId: "tests",
				specId: "adaptive.tests",
				control: { digest: "tests done" },
			},
			"cross-check": {
				taskId: "cross-check",
				specId: "adaptive.cross-check",
				control: { digest: "cross-check done" },
			},
		},
	});
	ctx.graph.generatedTaskSpecId = (taskId) => `adaptive.${taskId}`;
	ctx.fanout = {
		async plan(request) {
			fanoutPlan = request;
			return { accepted: true };
		},
	};

	await runDynamicDecisionLoop(ctx);

	const plannedCrossCheck = fanoutPlan.branches.find(
		(branch) => branch.requestId === "cross-check",
	);
	const actualCrossCheck = calls.agent.find(
		(request) => request.id === "cross-check",
	);
	assert.deepEqual(plannedCrossCheck.dependsOn, [
		"adaptive.src",
		"adaptive.tests",
	]);
	assert.deepEqual(plannedCrossCheck.agentRequest, actualCrossCheck);
});

test("artifactGraph dynamic surfaces unintended zero-fanout omissions as dropped stage", async () => {
	const cwd = makeProject();
	try {
		const { run } = await createDynamicControllerRun(
			cwd,
			[
				"export default async function controller() {",
				"  return {",
				"    control: {",
				"      schema: 'dynamic-controller-result-v1',",
				"      digest: 'zero-fanout',",
				"      status: 'exhausted',",
				"      decisions: [{ round: 0, decisionId: 'decide-r0', status: 'continue' }],",
				"      generatedTasks: [],",
				"      stateIndexes: [],",
				"      blockers: [],",
				"      omissions: ['round 0 accepted no executable work actions'],",
				"      caveats: []",
				"    },",
				"    analysis: 'planner accepted no executable dynamic work',",
				"    refs: []",
				"  };",
				"}",
			].join("\n"),
		);

		await scheduleRun(cwd, run.runId);
		const updated = await readRunRecord(cwd, run.runId);
		const controller = taskBySpec(updated, "adaptive.controller");
		assert.equal(controller.status, "failed");
		assert.equal(controller.statusDetail, "dynamic_dropped");
		assert.match(
			controller.lastMessage ?? "",
			/round 0 accepted no executable work actions/,
		);
		assert.equal(updated.taskSummary.failed, 1);
		assert.equal(updated.taskSummary.completed, 0);
		assert.match(formatRun(updated, "full"), /dynamic_dropped/);
		assert.match(
			formatRun(updated, "full"),
			/round 0 accepted no executable work actions/,
		);
		const state = await readOrRebuildDynamicState(cwd, run.runId);
		assert.deepEqual(state.controllers["adaptive.controller"].omissions, [
			"round 0 accepted no executable work actions",
		]);
		const statusEvent = (await readDynamicEvents(cwd, run.runId))
			.filter((event) => event.type === "controller.status")
			.at(-1);
		assert.deepEqual(statusEvent?.payload.omissions, [
			"round 0 accepted no executable work actions",
		]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph dynamic treats explicit stopped result as clean completion", async () => {
	const cwd = makeProject();
	try {
		const { run } = await createDynamicControllerRun(
			cwd,
			[
				"export default async function controller() {",
				"  return {",
				"    control: {",
				"      schema: 'dynamic-controller-result-v1',",
				"      digest: 'explicit-stop',",
				"      status: 'stopped',",
				"      decisions: [{ round: 0, decisionId: 'decide-r0', status: 'stop' }],",
				"      generatedTasks: [],",
				"      stateIndexes: [],",
				"      blockers: ['budget stop requested explicitly'],",
				"      omissions: [],",
				"      caveats: []",
				"    },",
				"    analysis: 'explicit clean stop',",
				"    refs: []",
				"  };",
				"}",
			].join("\n"),
		);

		await scheduleRun(cwd, run.runId);
		const updated = await readRunRecord(cwd, run.runId);
		const controller = taskBySpec(updated, "adaptive.controller");
		assert.equal(controller.status, "completed");
		assert.equal(controller.statusDetail, "dynamic_stopped");
		assert.equal(updated.taskSummary.completed, 1);
		assert.equal(updated.taskSummary.failed, 0);
		assert.equal(updated.taskSummary.blocked, 0);
		assert.match(
			controller.lastMessage ?? "",
			/budget stop requested explicitly/,
		);
		const state = await readOrRebuildDynamicState(cwd, run.runId);
		assert.equal(state.controllers["adaptive.controller"].status, "complete");
		assert.deepEqual(state.controllers["adaptive.controller"].omissions, []);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph dynamic surfaces invalid fail-open decision result as blocked", async () => {
	const cwd = makeProject();
	try {
		const { run } = await createDynamicControllerRun(
			cwd,
			[
				"export default async function controller() {",
				"  return {",
				"    control: {",
				"      schema: 'dynamic-controller-result-v1',",
				"      digest: 'invalid-decision',",
				"      status: 'blocked',",
				"      decisions: [{ round: 0 }],",
				"      generatedTasks: [],",
				"      stateIndexes: [],",
				"      blockers: ['round 0 decision invalid: missing nextActions'],",
				"      omissions: [],",
				"      caveats: []",
				"    },",
				"    analysis: 'fail-closed=false returned a blocked controller result',",
				"    refs: []",
				"  };",
				"}",
			].join("\n"),
		);

		await scheduleRun(cwd, run.runId);
		const updated = await readRunRecord(cwd, run.runId);
		const controller = taskBySpec(updated, "adaptive.controller");
		assert.equal(controller.status, "blocked");
		assert.equal(controller.statusDetail, "dynamic_blocked");
		assert.equal(updated.status, "blocked");
		assert.equal(updated.taskSummary.completed, 0);
		assert.equal(updated.taskSummary.blocked, 1);
		assert.match(controller.lastMessage ?? "", /missing nextActions/);
		assert.match(formatRun(updated, "full"), /dynamic_blocked/);
		assert.match(formatRun(updated, "full"), /missing nextActions/);
		const state = await readOrRebuildDynamicState(cwd, run.runId);
		assert.equal(state.controllers["adaptive.controller"].status, "blocked");
		assert.deepEqual(state.controllers["adaptive.controller"].blockers, [
			"round 0 decision invalid: missing nextActions",
		]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph dynamic decision-loop failOnInvalidDecision surfaces blockers as dynamic_blocked", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const prompts = captureSubagentPrompts([]);
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			"export default async function controller(ctx) { return await ctx.dynamic.runDecisionLoop(); }\n",
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: {
							uses: "./helpers/controller.mjs",
							decisionLoop: {
								planner: {
									agent: "unit-scout",
									tools: ["read"],
									outputProfile: "generic_summary_v1",
								},
								workerDefaults: {
									agent: "unit-scout",
									tools: ["read"],
									outputProfile: "candidate_findings_v1",
								},
								allowedAgents: ["unit-scout"],
								allowedTools: ["read"],
								allowedOutputProfiles: [
									"candidate_findings_v1",
									"generic_summary_v1",
								],
								maxDecisionRounds: 1,
								maxActionsPerRound: 1,
								repair: { maxAttempts: 1 },
								stopPolicy: { failOnInvalidDecision: true },
							},
						},
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Review dynamically.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		let updated = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(updated, "adaptive.controller").status, "pending");
		assert.equal(taskBySpec(updated, "adaptive.decide-r0").status, "running");

		const invalidDecision = {
			schema: "dynamic-decision-v1",
			digest: "invalid decision envelope",
			decisionId: "bad-r0",
			round: 0,
			phase: "round",
			status: "continue",
			actions: [
				{
					type: "add_work_item",
					actionId: "act-review",
					workItemId: "review",
					prompt: "This work must not dispatch.",
					outputProfile: "candidate_findings_v1",
				},
			],
		};
		await completeTask(
			cwd,
			taskBySpec(updated, "adaptive.decide-r0"),
			invalidDecision,
		);
		await writeRunRecord(cwd, updated);

		await scheduleRun(cwd, run.runId);
		updated = await readRunRecord(cwd, run.runId);
		assert.equal(
			taskBySpec(updated, "adaptive.decide-r0-repair-1").status,
			"running",
		);
		await completeTask(
			cwd,
			taskBySpec(updated, "adaptive.decide-r0-repair-1"),
			invalidDecision,
		);
		await writeRunRecord(cwd, updated);

		await scheduleRun(cwd, run.runId);
		updated = await readRunRecord(cwd, run.runId);
		const controller = taskBySpec(updated, "adaptive.controller");
		assert.equal(controller.status, "blocked");
		assert.equal(controller.statusDetail, "dynamic_blocked");
		assert.equal(updated.status, "blocked");
		assert.equal(updated.taskSummary.blocked, 1);
		assert.equal(updated.taskSummary.failed, 0);
		assert.match(
			controller.lastMessage ?? "",
			/decision field actions is not allowed; use nextActions/,
		);
		assert.equal(
			updated.tasks.some((task) => task.specId === "adaptive.review"),
			false,
		);
		assert.equal(prompts.length, 2);
		const state = await readOrRebuildDynamicState(cwd, run.runId);
		assert.equal(state.controllers["adaptive.controller"].status, "blocked");
		assert.match(
			state.controllers["adaptive.controller"].blockers.join("\n"),
			/decision field actions is not allowed; use nextActions/,
		);
		const statusEvent = (await readDynamicEvents(cwd, run.runId))
			.filter((event) => event.type === "controller.status")
			.at(-1);
		assert.equal(statusEvent?.payload.status, "blocked");
		assert.deepEqual(
			statusEvent?.payload.blockers,
			state.controllers["adaptive.controller"].blockers,
		);
		const control = JSON.parse(
			readFileSync(
				join(dirname(join(cwd, controller.files.result)), "control.json"),
				"utf8",
			),
		);
		assert.equal(control.status, "blocked");
		assert.deepEqual(
			control.blockers,
			state.controllers["adaptive.controller"].blockers,
		);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph dynamic decision-loop plans fanout once and dedupes partial replay", async () => {
	const cwd = makeProject();
	const prompts = captureSubagentPrompts([]);
	try {
		writeAgent(cwd, "unit-scout", "read");
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			"export default async function controller(ctx) { return await ctx.dynamic.runDecisionLoop(); }\n",
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: {
							uses: "./helpers/controller.mjs",
							decisionLoop: {
								planner: {
									agent: "unit-scout",
									tools: ["read"],
									outputProfile: "generic_summary_v1",
								},
								workerDefaults: {
									agent: "unit-scout",
									tools: ["read"],
									outputProfile: "candidate_findings_v1",
								},
								allowedAgents: ["unit-scout"],
								allowedTools: ["read"],
								allowedOutputProfiles: [
									"candidate_findings_v1",
									"coverage_assessment_v1",
									"generic_summary_v1",
								],
								maxDecisionRounds: 1,
								maxActionsPerRound: 2,
								repair: { maxAttempts: 0 },
							},
						},
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Review dynamically.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		let updated = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(updated, "adaptive.decide-r0").status, "running");
		const decision = {
			schema: "dynamic-decision-v1",
			digest: "two branch decision",
			decisionId: "decide-r0",
			round: 0,
			phase: "round",
			status: "continue",
			nextActions: [
				{
					type: "add_work_item",
					actionId: "act-inspect-auth",
					workItemId: "inspect-auth",
					agent: "unit-scout",
					prompt: "Inspect auth implementation.",
					tools: ["read"],
					outputProfile: "candidate_findings_v1",
				},
				{
					type: "add_work_item",
					actionId: "act-inspect-tests",
					workItemId: "inspect-tests",
					agent: "unit-scout",
					prompt: "Inspect tests.",
					tools: ["read"],
					outputProfile: "coverage_assessment_v1",
				},
			],
		};
		await completeTask(
			cwd,
			taskBySpec(updated, "adaptive.decide-r0"),
			decision,
		);
		await writeRunRecord(cwd, updated);

		await scheduleRun(cwd, run.runId);
		updated = await readRunRecord(cwd, run.runId);
		assert.equal(
			taskBySpec(updated, "adaptive.inspect-auth").status,
			"running",
		);
		assert.equal(
			taskBySpec(updated, "adaptive.inspect-tests").status,
			"running",
		);
		assert.equal(prompts.length, 3);
		let events = await readDynamicEvents(cwd, run.runId);
		let fanoutEvents = events.filter(
			(event) => event.type === "fanout.planned",
		);
		let branchTaskEvents = events.filter(
			(event) => event.type === "task.generated" && event.payload.branchId,
		);
		assert.equal(fanoutEvents.length, 1);
		assert.equal(fanoutEvents[0].payload.branches.length, 2);
		assert.deepEqual(
			fanoutEvents[0].payload.branches.map((branch) => ({
				branchId: branch.branchId,
				requestId: branch.requestId,
				targetSpecId: branch.targetSpecId,
			})),
			[
				{
					branchId: "r0:act-inspect-auth",
					requestId: "inspect-auth",
					targetSpecId: "adaptive.inspect-auth",
				},
				{
					branchId: "r0:act-inspect-tests",
					requestId: "inspect-tests",
					targetSpecId: "adaptive.inspect-tests",
				},
			],
		);
		assert.equal(branchTaskEvents.length, 2);
		assert.deepEqual(
			branchTaskEvents.map((event) => event.payload.branchId),
			["r0:act-inspect-auth", "r0:act-inspect-tests"],
		);
		let state = await readOrRebuildDynamicState(cwd, run.runId);
		assert.deepEqual(
			state.controllers["adaptive.controller"].branches.map((branch) => ({
				branchId: branch.branchId,
				requestId: branch.requestId,
				targetSpecId: branch.targetSpecId,
				status: branch.status,
				specId: branch.specId,
			})),
			[
				{
					branchId: "r0:act-inspect-auth",
					requestId: "inspect-auth",
					targetSpecId: "adaptive.inspect-auth",
					status: "generated",
					specId: "adaptive.inspect-auth",
				},
				{
					branchId: "r0:act-inspect-tests",
					requestId: "inspect-tests",
					targetSpecId: "adaptive.inspect-tests",
					status: "generated",
					specId: "adaptive.inspect-tests",
				},
			],
		);

		await completeTask(cwd, taskBySpec(updated, "adaptive.inspect-auth"), {
			digest: "auth done",
		});
		await writeRunRecord(cwd, updated);
		await scheduleRun(cwd, run.runId);
		updated = await readRunRecord(cwd, run.runId);
		assert.equal(
			taskBySpec(updated, "adaptive.controller").status,
			"pending",
			taskBySpec(updated, "adaptive.controller").lastMessage,
		);
		assert.equal(prompts.length, 3);
		events = await readDynamicEvents(cwd, run.runId);
		assert.equal(
			events.filter((event) => event.type === "fanout.planned").length,
			1,
		);
		assert.equal(
			events.filter(
				(event) => event.type === "task.generated" && event.payload.branchId,
			).length,
			2,
		);
		state = await readOrRebuildDynamicState(cwd, run.runId);
		assert.deepEqual(
			state.controllers["adaptive.controller"].branches.map((branch) => ({
				branchId: branch.branchId,
				status: branch.status,
			})),
			[
				{ branchId: "r0:act-inspect-auth", status: "completed" },
				{ branchId: "r0:act-inspect-tests", status: "generated" },
			],
		);

		await completeTask(cwd, taskBySpec(updated, "adaptive.inspect-tests"), {
			digest: "tests done",
		});
		await writeRunRecord(cwd, updated);
		await scheduleRun(cwd, run.runId);
		updated = await readRunRecord(cwd, run.runId);
		assert.equal(
			taskBySpec(updated, "adaptive.controller").status,
			"completed",
		);
		assert.equal(prompts.length, 3);
		events = await readDynamicEvents(cwd, run.runId);
		fanoutEvents = events.filter((event) => event.type === "fanout.planned");
		branchTaskEvents = events.filter(
			(event) => event.type === "task.generated" && event.payload.branchId,
		);
		assert.equal(fanoutEvents.length, 1);
		assert.equal(branchTaskEvents.length, 2);
		state = await readOrRebuildDynamicState(cwd, run.runId);
		assert.deepEqual(
			state.controllers["adaptive.controller"].branches.map((branch) => ({
				branchId: branch.branchId,
				status: branch.status,
			})),
			[
				{ branchId: "r0:act-inspect-auth", status: "completed" },
				{ branchId: "r0:act-inspect-tests", status: "completed" },
			],
		);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph dynamic decision-loop status replay does not append duplicate status events", async () => {
	const cwd = makeProject();
	const prompts = captureSubagentPrompts([]);
	try {
		writeAgent(cwd, "unit-scout", "read");
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			"export default async function controller(ctx) { return await ctx.dynamic.runDecisionLoop(); }\n",
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: {
							uses: "./helpers/controller.mjs",
							decisionLoop: {
								planner: {
									agent: "unit-scout",
									tools: ["read"],
									outputProfile: "generic_summary_v1",
								},
								workerDefaults: {
									agent: "unit-scout",
									tools: ["read"],
									outputProfile: "candidate_findings_v1",
								},
								allowedAgents: ["unit-scout"],
								allowedTools: ["read"],
								allowedOutputProfiles: [
									"candidate_findings_v1",
									"generic_summary_v1",
								],
								maxDecisionRounds: 2,
								maxActionsPerRound: 1,
								repair: { maxAttempts: 0 },
								stopPolicy: { maxStalls: 10 },
							},
						},
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Review dynamically.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		let updated = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(updated, "adaptive.decide-r0").status, "running");
		await completeTask(cwd, taskBySpec(updated, "adaptive.decide-r0"), {
			schema: "dynamic-decision-v1",
			digest: "round 0 decision",
			decisionId: "decide-r0",
			round: 0,
			phase: "round",
			status: "continue",
			nextActions: [
				{
					type: "add_work_item",
					actionId: "act-review",
					workItemId: "review",
					agent: "unit-scout",
					prompt: "Review the target.",
					tools: ["read"],
					outputProfile: "candidate_findings_v1",
				},
			],
		});
		await writeRunRecord(cwd, updated);

		await scheduleRun(cwd, run.runId);
		updated = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(updated, "adaptive.review").status, "running");
		assert.equal(
			(await readDynamicEvents(cwd, run.runId)).filter(
				(event) =>
					event.type === "controller.status" &&
					event.opId.includes(":decision-loop-status:"),
			).length,
			0,
		);

		await completeTask(cwd, taskBySpec(updated, "adaptive.review"), {
			digest: "review done",
			findings: [
				{
					id: "F-1",
					title: "Sample finding",
					severity: "low",
					confidence: "medium",
				},
			],
		});
		await writeRunRecord(cwd, updated);
		await scheduleRun(cwd, run.runId);
		updated = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(updated, "adaptive.decide-r1").status, "running");
		assert.equal(prompts.length, 3);
		let events = await readDynamicEvents(cwd, run.runId);
		const statusEvents = () =>
			events.filter(
				(event) =>
					event.type === "controller.status" &&
					event.opId.includes(":decision-loop-status:"),
			);
		assert.equal(statusEvents().length, 1);
		assert.equal(
			statusEvents()[0].opId,
			"adaptive.controller:decision-loop-status:001",
		);
		assert.deepEqual(statusEvents()[0].payload.decisionLoop, {
			stallCount: 0,
			replanCount: 0,
		});
		let state = await readOrRebuildDynamicState(cwd, run.runId);
		assert.deepEqual(state.controllers["adaptive.controller"].decisionLoop, {
			stallCount: 0,
			replanCount: 0,
		});

		await scheduleRun(cwd, run.runId);
		updated = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(updated, "adaptive.decide-r1").status, "running");
		assert.equal(prompts.length, 3);
		events = await readDynamicEvents(cwd, run.runId);
		assert.equal(statusEvents().length, 1);
		assert.deepEqual(statusEvents()[0].payload.decisionLoop, {
			stallCount: 0,
			replanCount: 0,
		});
		state = await readOrRebuildDynamicState(cwd, run.runId);
		assert.deepEqual(state.controllers["adaptive.controller"].decisionLoop, {
			stallCount: 0,
			replanCount: 0,
		});
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph dynamic replay fails closed when a reused branchId changes request", async () => {
	const cwd = makeProject();
	const launched = captureSubagentPrompts([]);
	try {
		const { run } = await createDynamicControllerRun(
			cwd,
			[
				"export default async function controller(ctx) {",
				"  if (ctx.graph.generatedTaskIds().length === 0) {",
				"    await ctx.agent({ id: 'first', agent: 'unit-scout', tools: ['read'], prompt: 'Original branch request.', branchId: 'r0:act-reused' });",
				"  } else {",
				"    await ctx.agent({ id: 'second', agent: 'unit-scout', tools: ['read'], prompt: 'Changed branch request.', branchId: 'r0:act-reused' });",
				"  }",
				"  return { control: { schema: 'dynamic-controller-result-v1', digest: 'done' }, analysis: 'done', refs: [] };",
				"}",
			].join("\n"),
		);

		await scheduleRun(cwd, run.runId);
		let updated = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(updated, "adaptive.first").status, "running");
		assert.equal(launched.length, 1);

		await completeTask(cwd, taskBySpec(updated, "adaptive.first"), {
			digest: "first done",
		});
		await writeRunRecord(cwd, updated);
		await scheduleRun(cwd, run.runId);
		updated = await readRunRecord(cwd, run.runId);
		const controller = taskBySpec(updated, "adaptive.controller");
		assert.equal(controller.status, "failed");
		assert.match(
			controller.lastMessage ?? "",
			/dynamic agent request changed for branchId "r0:act-reused"/,
		);
		assert.equal(
			updated.tasks.some((task) => task.specId === "adaptive.second"),
			false,
		);
		assert.equal(launched.length, 1);
		const events = await readDynamicEvents(cwd, run.runId);
		assert.equal(
			events.filter((event) => event.type === "task.generated").length,
			1,
		);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph dynamic blocks completion when planned branch is never generated", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const { run } = await createDynamicControllerRun(
			cwd,
			[
				"export default async function controller(ctx) {",
				"  await ctx.fanout.plan({",
				"    round: 0,",
				"    decisionHash: 'manual-decision',",
				"    branches: [{",
				"      branchId: 'r0:act-ghost',",
				"      actionId: 'act-ghost',",
				"      type: 'add_work_item',",
				"      outputProfile: 'candidate_findings_v1',",
				"      agentRequest: { id: 'ghost', agent: 'unit-scout', tools: ['read'], prompt: 'Ghost work.', outputProfile: 'candidate_findings_v1', branchId: 'r0:act-ghost' }",
				"    }]",
				"  });",
				"  return { control: { schema: 'dynamic-controller-result-v1', digest: 'bad-clean-success' }, analysis: 'bad', refs: [] };",
				"}",
			].join("\n"),
		);

		await scheduleRun(cwd, run.runId);
		const updated = await readRunRecord(cwd, run.runId);
		const controller = taskBySpec(updated, "adaptive.controller");
		assert.equal(controller.status, "blocked");
		assert.equal(controller.statusDetail, "dynamic_blocked");
		assert.match(controller.lastMessage ?? "", /planned but never generated/);
		assert.equal(updated.status, "blocked");
		assert.equal(updated.taskSummary.blocked, 1);
		const events = await readDynamicEvents(cwd, run.runId);
		assert.equal(
			events.filter((event) => event.type === "fanout.planned").length,
			1,
		);
		assert.equal(
			events.filter((event) => event.type === "task.generated").length,
			0,
		);
		const state = await readOrRebuildDynamicState(cwd, run.runId);
		assert.equal(
			state.controllers["adaptive.controller"].branches[0].status,
			"planned",
		);
		assert.match(
			state.controllers["adaptive.controller"].blockers.join("\n"),
			/planned but never generated/,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph runtime dynamic requires immutable run bundle", async () => {
	const cwd = makeProject();
	try {
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			"export default async function controller() { return { control: { schema: 'dynamic-controller-result-v1', summary: 'done' }, analysis: 'done', refs: [] }; }\n",
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: { uses: "./helpers/controller.mjs" },
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Review dynamically.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		writeFileSync(
			join(cwd, ".pi/workflows", run.runId, "compiled.json"),
			JSON.stringify(compiled, null, 2),
		);
		await writeRunRecord(cwd, run);
		await scheduleRun(cwd, run.runId);
		const updated = await readRunRecord(cwd, run.runId);
		const controller = taskBySpec(updated, "adaptive.controller");
		assert.equal(controller.status, "failed");
		assert.equal(controller.statusDetail, "dynamic_failed");
		assert.match(controller.lastMessage ?? "", /run bundle is required/);
		const state = await readOrRebuildDynamicState(cwd, run.runId);
		assert.equal(state.controllers["adaptive.controller"].status, "failed");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph runtime dynamic recovers stale running controller", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			"export default async function controller() { return { control: { schema: 'dynamic-controller-result-v1', summary: 'recovered' }, analysis: 'ok', refs: [] }; }\n",
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: { uses: "./helpers/controller.mjs" },
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Review dynamically.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		run.tasks[0].status = "running";
		run.tasks[0].statusDetail = "running";
		run.tasks[0].lastMessage = "simulated scheduler crash";
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		const updated = await readRunRecord(cwd, run.runId);
		assert.equal(
			taskBySpec(updated, "adaptive.controller").status,
			"completed",
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph runtime dynamic does not let controllers catch suspension and complete early", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		captureSubagentPrompts([]);
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			[
				"export default async function controller(ctx) {",
				"  try { await ctx.agent({ id: 'review', agent: 'unit-scout', tools: ['read'], prompt: 'Review generated work.' }); } catch (_error) {}",
				"  return { control: { schema: 'dynamic-controller-result-v1', summary: 'caught' }, analysis: 'bad', refs: [] };",
				"}",
			].join("\n"),
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: { uses: "./helpers/controller.mjs" },
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Review dynamically.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		const updated = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(updated, "adaptive.controller").status, "pending");
		assert.equal(
			taskBySpec(updated, "adaptive.controller").statusDetail,
			"suspended_waiting_children",
		);
		assert.equal(taskBySpec(updated, "adaptive.review").status, "running");
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph runtime dynamic agent splices official task and replays result", async () => {
	const cwd = makeProject();
	const launched = [];
	try {
		writeAgent(cwd, "unit-scout", "read");
		setSubagentApiForTests({
			async runSubagent(options) {
				launched.push(String(options.task ?? ""));
				return {
					runId: `run_dynamic_${launched.length}`,
					attemptId: `attempt_dynamic_${launched.length}`,
					status: "running",
				};
			},
			async getSubagentStatus() {
				return null;
			},
			async reconcileSubagentRun() {
				return {};
			},
			async interruptSubagent() {
				return {};
			},
		});
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			[
				"export default async function controller(ctx) {",
				"  ctx.phase('review');",
				"  const child = await ctx.agent({ id: 'review', agent: 'unit-scout', tools: ['read'], prompt: 'Review generated work.', compact: true });",
				"  return { control: { schema: 'dynamic-controller-result-v1', summary: child.control.digest, child: child.control }, analysis: 'done', refs: [] };",
				"}",
			].join("\n"),
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: { uses: "./helpers/controller.mjs" },
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Review dynamically.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		let updated = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(updated, "adaptive.controller").status, "pending");
		assert.equal(
			taskBySpec(updated, "adaptive.controller").statusDetail,
			"suspended_waiting_children",
		);
		assert.equal(taskBySpec(updated, "adaptive.review").status, "running");
		assert.equal(launched.length, 1);
		assert.match(launched[0], /Review generated work/);
		const compiledAfterSplice = JSON.parse(
			readFileSync(
				join(cwd, ".pi", "workflows", run.runId, "compiled.json"),
				"utf8",
			),
		);
		assert.deepEqual(
			compiledAfterSplice.tasks.map((task) => task.id),
			["adaptive.controller", "adaptive.review"],
		);

		await completeTask(cwd, taskBySpec(updated, "adaptive.review"), {
			digest: "review child completed",
			result: "ok",
		});
		await writeRunRecord(cwd, updated);
		await scheduleRun(cwd, run.runId);
		updated = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(updated, "adaptive.review").status, "completed");
		assert.equal(
			taskBySpec(updated, "adaptive.controller").status,
			"completed",
		);
		assert.equal(launched.length, 1);
		const control = JSON.parse(
			readFileSync(
				join(
					dirname(
						join(cwd, taskBySpec(updated, "adaptive.controller").files.result),
					),
					"control.json",
				),
				"utf8",
			),
		);
		assert.equal(control.digest, "review child completed");
		assert.deepEqual(control.child.result, "ok");
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph dynamic decision and state-index bridge persists replayable control ops", async () => {
	const cwd = makeProject();
	const launched = [];
	try {
		writeAgent(cwd, "unit-scout", "read");
		setSubagentApiForTests({
			async runSubagent(options) {
				launched.push(String(options.task ?? ""));
				return {
					runId: `run_bridge_${launched.length}`,
					attemptId: `attempt_bridge_${launched.length}`,
					status: "running",
				};
			},
			async getSubagentStatus() {
				return null;
			},
			async reconcileSubagentRun() {
				return {};
			},
			async interruptSubagent() {
				return {};
			},
		});
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			[
				"export default async function controller(ctx) {",
				"  ctx.phase('bridge');",
				"  const rawDecision = {",
				"    schema: 'dynamic-decision-v1',",
				"    decisionId: 'decide-r0',",
				"    round: 0,",
				"    phase: 'orientation',",
				"    status: 'continue',",
				"    nextActions: [{ type: 'add_work_item', actionId: 'act-review', workItemId: 'review', agent: 'unit-scout', prompt: 'Review bridge state.', tools: ['read'], outputProfile: 'candidate_findings_v1' }],",
				"  };",
				"  const decision = await ctx.decision.validateAndPersist(rawDecision, { expectedRound: 0, maxActions: 1, allowedTools: ['read'] });",
				"  const state = await ctx.stateIndex.extractAndPersist({ round: 0, tasks: [{ taskId: 'seed.main', outputProfile: 'candidate_findings_v1' }], maxFindings: 5 });",
				"  const child = await ctx.agent({ id: 'review', agent: 'unit-scout', tools: ['read'], prompt: `Review ${decision.decisionHash} ${state.digest}.`, outputProfile: 'candidate_findings_v1' });",
				"  return { control: { schema: 'dynamic-controller-result-v1', summary: child.control.digest, decisionHash: decision.decisionHash, stateIndexDigest: state.digest, generated: ctx.graph.generatedTaskIds() }, analysis: 'bridge complete', refs: [] };",
				"}",
			].join("\n"),
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{ id: "seed", type: "single", prompt: "Seed." },
					{
						id: "adaptive",
						from: "seed",
						type: "dynamic",
						dynamic: { uses: "./helpers/controller.mjs" },
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Review dynamically.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await completeTask(cwd, taskBySpec(run, "seed.main"), {
			digest: "seed ready",
			findings: [
				{
					id: "F1",
					title: "Seed finding",
					severity: "medium",
					confidence: "high",
				},
			],
		});
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		let updated = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(updated, "adaptive.controller").status, "pending");
		assert.equal(
			taskBySpec(updated, "adaptive.controller").statusDetail,
			"suspended_waiting_children",
		);
		assert.equal(taskBySpec(updated, "adaptive.review").status, "running");
		assert.equal(launched.length, 1);
		assert.match(launched[0], /Review [a-f0-9]{64} [a-f0-9]{64}/);

		let events = await readDynamicEvents(cwd, run.runId);
		assert.deepEqual(
			events
				.filter((event) =>
					[
						"decision.persisted",
						"state-index.persisted",
						"task.generated",
					].includes(event.type),
				)
				.map((event) => event.opId),
			[
				"adaptive.controller:decision:001",
				"adaptive.controller:state-index:001",
				"adaptive.controller:agent:review",
			],
		);
		const decisionEvent = events.find(
			(event) => event.type === "decision.persisted",
		);
		const stateIndexEvent = events.find(
			(event) => event.type === "state-index.persisted",
		);
		assert(decisionEvent);
		assert(stateIndexEvent);
		assert.equal(decisionEvent.payload.callIndex, 1);
		assert.equal(decisionEvent.payload.ok, true);
		assert.equal(stateIndexEvent.payload.callIndex, 1);
		assert.equal(stateIndexEvent.payload.round, 0);
		for (const artifactPath of [
			decisionEvent.payload.paths.raw,
			decisionEvent.payload.paths.validation,
			decisionEvent.payload.paths.accepted,
			stateIndexEvent.payload.paths.extracts,
			stateIndexEvent.payload.paths.index,
		]) {
			assert.equal(existsSync(join(cwd, artifactPath)), true, artifactPath);
		}
		const accepted = JSON.parse(
			readFileSync(join(cwd, decisionEvent.payload.paths.accepted), "utf8"),
		);
		assert.equal(accepted.decision.decisionId, "decide-r0");
		assert.equal(accepted.decisionHash, decisionEvent.payload.decisionHash);
		const index = JSON.parse(
			readFileSync(join(cwd, stateIndexEvent.payload.paths.index), "utf8"),
		);
		assert.equal(index.digest, stateIndexEvent.payload.digest);
		assert.deepEqual(
			index.findings.map((finding) => finding.id),
			["F1"],
		);

		await completeTask(cwd, taskBySpec(updated, "adaptive.review"), {
			digest: "review done",
			result: "ok",
		});
		await writeRunRecord(cwd, updated);
		await scheduleRun(cwd, run.runId);
		updated = await readRunRecord(cwd, run.runId);
		assert.equal(
			taskBySpec(updated, "adaptive.controller").status,
			"completed",
		);
		assert.equal(launched.length, 1);
		events = await readDynamicEvents(cwd, run.runId);
		assert.equal(
			events.filter((event) => event.type === "decision.persisted").length,
			1,
		);
		assert.equal(
			events.filter((event) => event.type === "state-index.persisted").length,
			1,
		);
		assert.equal(
			events.filter((event) => event.type === "task.generated").length,
			1,
		);
		const control = JSON.parse(
			readFileSync(
				join(
					dirname(
						join(cwd, taskBySpec(updated, "adaptive.controller").files.result),
					),
					"control.json",
				),
				"utf8",
			),
		);
		assert.equal(control.digest, "review done");
		assert.equal(control.decisionHash, decisionEvent.payload.decisionHash);
		assert.equal(control.stateIndexDigest, stateIndexEvent.payload.digest);
		assert.deepEqual(control.generated, ["adaptive.review"]);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph dynamic ctx.result returns scoped content-bound fields", async () => {
	const cwd = makeProject();
	const largeBlob = `RESULT-LARGE-${"z".repeat(6000)}-END`;
	try {
		writeAgent(cwd, "unit-scout", "read");
		captureSubagentPrompts([]);
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			[
				"export default async function controller(ctx) {",
				"  await ctx.agent({ id: 'review', agent: 'unit-scout', tools: ['read'], prompt: 'Review scoped result.', outputProfile: 'generic_summary_v1' });",
				"  const scoped = await ctx.result({ taskId: 'adaptive.review', include: ['$.schema', '$.digest', '$.summary'] });",
				"  return { control: { schema: 'dynamic-controller-result-v1', digest: scoped.scope.scopeHash, scoped }, analysis: 'scoped result complete', refs: [] };",
				"}",
			].join("\n"),
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: { uses: "./helpers/controller.mjs" },
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Review dynamically.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		let updated = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(updated, "adaptive.review").status, "running");
		await completeTask(cwd, taskBySpec(updated, "adaptive.review"), {
			digest: "review scoped digest",
			summary: "declared summary",
			undeclaredExtra: largeBlob,
		});
		writeFileSync(
			join(
				dirname(join(cwd, taskBySpec(updated, "adaptive.review").files.result)),
				"analysis.md",
			),
			largeBlob,
		);
		await writeRunRecord(cwd, updated);
		await scheduleRun(cwd, run.runId);
		updated = await readRunRecord(cwd, run.runId);
		assert.equal(
			taskBySpec(updated, "adaptive.controller").status,
			"completed",
		);

		const control = JSON.parse(
			readFileSync(
				join(
					dirname(
						join(cwd, taskBySpec(updated, "adaptive.controller").files.result),
					),
					"control.json",
				),
				"utf8",
			),
		);
		const scoped = control.scoped;
		const expectedControl = {
			schema: "stage-control-v1",
			digest: "review scoped digest",
			summary: "declared summary",
		};
		const include = ["$.schema", "$.digest", "$.summary"];
		assert.deepEqual(scoped.control, expectedControl);
		assert.equal(Object.hasOwn(scoped.control, "undeclaredExtra"), false);
		assert.equal(Object.hasOwn(scoped, "analysis"), false);
		assert.equal(Object.hasOwn(scoped, "refs"), false);
		assert.equal(JSON.stringify(scoped).includes(largeBlob), false);
		assert.deepEqual(scoped.scope.include, include);
		assert.equal(scoped.scope.contentDigest, "review scoped digest");
		assert.equal(
			scoped.scope.scopeHash,
			hashDynamicRequest({
				taskId: "adaptive.review",
				artifact: "control",
				include,
				contentDigest: "review scoped digest",
				missingPaths: [],
				content: expectedControl,
			}),
		);
		assert.deepEqual(scoped.artifacts.control, {
			taskId: "adaptive.review",
			artifact: "control",
			digest: "review scoped digest",
		});
		assert.deepEqual(scoped.artifacts.analysis, {
			taskId: "adaptive.review",
			artifact: "analysis",
		});
		const events = await readDynamicEvents(cwd, run.runId);
		assert.equal(
			events.filter((event) => event.type === "result.read").length,
			1,
		);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph dynamic rejects generated sibling dependency cycles", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		captureSubagentPrompts([]);
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			[
				"export default async function controller(ctx) {",
				"  await ctx.agent({ id: 'a', agent: 'unit-scout', tools: ['read'], prompt: 'A.' });",
				"  await ctx.agent({ id: 'b', agent: 'unit-scout', tools: ['read'], prompt: 'B.', dependsOn: ['adaptive.a'] });",
				"  return { control: { schema: 'dynamic-controller-result-v1', summary: 'done' }, analysis: 'done', refs: [] };",
				"}",
			].join("\n"),
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: { uses: "./helpers/controller.mjs" },
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Review dynamically.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);
		await scheduleRun(cwd, run.runId);
		let updated = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(updated, "adaptive.a").status, "running");
		await completeTask(cwd, taskBySpec(updated, "adaptive.a"), {
			digest: "a done",
		});
		await writeRunRecord(cwd, updated);
		const compiledPath = join(cwd, ".pi/workflows", run.runId, "compiled.json");
		const compiledProjection = JSON.parse(readFileSync(compiledPath, "utf8"));
		const generatedA = compiledProjection.tasks.find(
			(task) => task.id === "adaptive.a",
		);
		assert.ok(generatedA);
		generatedA.dependsOn = ["adaptive.b"];
		writeFileSync(compiledPath, JSON.stringify(compiledProjection, null, 2));

		await scheduleRun(cwd, run.runId);
		updated = await readRunRecord(cwd, run.runId);
		const controller = taskBySpec(updated, "adaptive.controller");
		assert.equal(controller.status, "failed");
		assert.match(controller.lastMessage ?? "", /generated-task cycle/);
		assert.equal(
			updated.tasks.some((task) => task.specId === "adaptive.b"),
			false,
		);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph dynamic replay rejects new operations before omitted prior operations", async () => {
	const cwd = makeProject();
	const launched = [];
	try {
		writeAgent(cwd, "unit-scout", "read");
		setSubagentApiForTests({
			async runSubagent(options) {
				launched.push(String(options.task ?? ""));
				return {
					runId: `run_replay_prefix_${launched.length}`,
					attemptId: `attempt_replay_prefix_${launched.length}`,
					status: "running",
				};
			},
			async getSubagentStatus() {
				return null;
			},
			async reconcileSubagentRun() {
				return {};
			},
			async interruptSubagent() {
				return {};
			},
		});
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			[
				"export default async function controller(ctx) {",
				"  await ctx.agent({ id: 'first', agent: 'unit-scout', tools: ['read'], prompt: 'First.' });",
				"  await ctx.agent({ id: 'second', agent: 'unit-scout', tools: ['read'], prompt: 'Second.' });",
				"  return { control: { schema: 'dynamic-controller-result-v1', summary: 'done' }, analysis: 'done', refs: [] };",
				"}",
			].join("\n"),
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: { uses: "./helpers/controller.mjs" },
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Review dynamically.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		let updated = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(updated, "adaptive.controller").status, "pending");
		assert.equal(taskBySpec(updated, "adaptive.first").status, "running");
		assert.equal(launched.length, 1);

		await completeTask(cwd, taskBySpec(updated, "adaptive.first"), {
			digest: "first done",
		});
		await writeRunRecord(cwd, updated);
		writeFileSync(
			join(
				cwd,
				".pi",
				"workflows",
				run.runId,
				"bundle",
				"helpers",
				"controller.mjs",
			),
			[
				"export default async function controller(ctx) {",
				"  await ctx.agent({ id: 'second', agent: 'unit-scout', tools: ['read'], prompt: 'Second.' });",
				"  return { control: { schema: 'dynamic-controller-result-v1', summary: 'bad' }, analysis: 'bad', refs: [] };",
				"}",
			].join("\n"),
		);

		await scheduleRun(cwd, run.runId);
		updated = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(updated, "adaptive.controller").status, "failed");
		assert.match(
			taskBySpec(updated, "adaptive.controller").lastMessage,
			/dynamic controller initialization changed/,
		);
		assert.equal(
			updated.tasks.some((task) => task.specId === "adaptive.second"),
			false,
		);
		assert.equal(launched.length, 1);
		const events = readFileSync(dynamicEventsPath(cwd, run.runId), "utf8");
		assert.equal(events.match(/task\.generated/g)?.length, 1);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph dynamic agent repairs graph projection from existing event", async () => {
	const cwd = makeProject();
	const launched = [];
	try {
		writeAgent(cwd, "unit-scout", "read");
		setSubagentApiForTests({
			async runSubagent(options) {
				launched.push(String(options.task ?? ""));
				return {
					runId: `run_repaired_${launched.length}`,
					attemptId: `attempt_repaired_${launched.length}`,
					status: "running",
				};
			},
			async getSubagentStatus() {
				return null;
			},
			async reconcileSubagentRun() {
				return {};
			},
			async interruptSubagent() {
				return {};
			},
		});
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			[
				"export default async function controller(ctx) {",
				"  await ctx.agent({ id: 'review', agent: 'unit-scout', tools: ['read'], prompt: 'Review generated work.', compact: true });",
				"  return { control: { schema: 'dynamic-controller-result-v1', summary: 'done' }, analysis: 'done', refs: [] };",
				"}",
			].join("\n"),
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: { uses: "./helpers/controller.mjs" },
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Review dynamically.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await appendDynamicEvent(cwd, run.runId, {
			controllerSpecId: "adaptive.controller",
			type: "task.generated",
			opId: "adaptive.controller:agent:review",
			requestHash: hashDynamicRequest({
				id: "review",
				agent: "unit-scout",
				prompt: "Review generated work.",
				tools: ["read"],
				inputs: [],
				requiredReads: [],
				compact: true,
			}),
			payload: {
				taskId: "adaptive.review",
				request: {
					id: "review",
					agent: "unit-scout",
					prompt: "Review generated work.",
					tools: ["read"],
					compact: true,
				},
			},
		});
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		const updated = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(updated, "adaptive.review").status, "running");
		assert.equal(launched.length, 1);
		const compiledAfterRepair = JSON.parse(
			readFileSync(
				join(cwd, ".pi", "workflows", run.runId, "compiled.json"),
				"utf8",
			),
		);
		assert.ok(
			compiledAfterRepair.tasks.some((task) => task.id === "adaptive.review"),
		);
		const events = readFileSync(dynamicEventsPath(cwd, run.runId), "utf8");
		assert.equal(events.match(/task\.generated/g)?.length, 1);

		updated.tasks = updated.tasks.filter(
			(task) => task.specId !== "adaptive.review",
		);
		await writeRunRecord(cwd, updated);
		await scheduleRun(cwd, run.runId);
		const repairedRun = await readRunRecord(cwd, run.runId);
		assert.equal(repairedRun.tasks[1]?.specId, "adaptive.review");
		assert.equal(taskBySpec(repairedRun, "adaptive.review").status, "running");
		assert.equal(launched.length, 2);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph runtime dynamic parallel splices multiple tasks before suspend", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const launched = captureSubagentPrompts([]);
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			[
				"export default async function controller(ctx) {",
				"  const results = await ctx.parallel([",
				"    () => ctx.agent({ id: 'one', agent: 'unit-scout', tools: ['read'], prompt: 'One.' }),",
				"    () => ctx.agent({ id: 'two', agent: 'unit-scout', tools: ['read'], prompt: 'Two.' })",
				"  ]);",
				"  return { control: { schema: 'dynamic-controller-result-v1', summary: String(results.length), statuses: results.map((r) => r.status) }, analysis: 'done', refs: [] };",
				"}",
			].join("\n"),
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: { uses: "./helpers/controller.mjs" },
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Review dynamically.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		let updated = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(updated, "adaptive.controller").status, "pending");
		assert.equal(taskBySpec(updated, "adaptive.one").status, "running");
		assert.equal(taskBySpec(updated, "adaptive.two").status, "running");
		assert.equal(launched.length, 2);

		await completeTask(cwd, taskBySpec(updated, "adaptive.one"), {
			digest: "one done",
		});
		await completeTask(cwd, taskBySpec(updated, "adaptive.two"), {
			digest: "two done",
		});
		await writeRunRecord(cwd, updated);
		await scheduleRun(cwd, run.runId);
		updated = await readRunRecord(cwd, run.runId);
		assert.equal(
			taskBySpec(updated, "adaptive.controller").status,
			"completed",
		);
		const control = JSON.parse(
			readFileSync(
				join(
					dirname(
						join(cwd, taskBySpec(updated, "adaptive.controller").files.result),
					),
					"control.json",
				),
				"utf8",
			),
		);
		assert.equal(control.digest, "2");
		assert.deepEqual(control.statuses, ["fulfilled", "fulfilled"]);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph dynamic budget API reflects running generated agents and captures logs", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		captureSubagentPrompts([]);
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			[
				"export default async function controller(ctx) {",
				"  if (ctx.graph.generatedTaskIds().length > 0) ctx.log('budget', ctx.budget.remaining(), ctx.budget.check());",
				"  await ctx.parallel([",
				"    () => ctx.agent({ id: 'one', agent: 'unit-scout', tools: ['read'], prompt: 'One.' }),",
				"    () => ctx.agent({ id: 'two', agent: 'unit-scout', tools: ['read'], prompt: 'Two.' })",
				"  ]);",
				"  return { control: { schema: 'dynamic-controller-result-v1', summary: 'done' }, analysis: 'done', refs: [] };",
				"}",
			].join("\n"),
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: {
							uses: "./helpers/controller.mjs",
							budget: { maxConcurrency: 1 },
						},
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Review dynamically.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		let updated = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(updated, "adaptive.one").status, "running");
		assert.equal(taskBySpec(updated, "adaptive.two").status, "pending");
		await completeTask(cwd, taskBySpec(updated, "adaptive.one"), {
			digest: "one done",
		});
		const two = taskBySpec(updated, "adaptive.two");
		two.status = "running";
		two.statusDetail = "running";
		two.startedAt = new Date().toISOString();
		await writeRunRecord(cwd, updated);

		await scheduleRun(cwd, run.runId);
		updated = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(updated, "adaptive.controller").status, "pending");
		const logLines = readFileSync(
			join(cwd, ".pi/workflows", run.runId, "dynamic", "controller.log"),
			"utf8",
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const budgetLog = logLines.find((line) => line.args?.[0] === "budget");
		assert.equal(budgetLog.args[1].maxConcurrency, 0);
		assert.equal(budgetLog.args[2], false);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph dynamic helper API uses declared helpers and replays cached result", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const launched = captureSubagentPrompts([]);
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			[
				"export default async function controller(ctx) {",
				"  const normalized = await ctx.helper('normalize', { value: 'normalized' });",
				"  const child = await ctx.agent({ id: 'review', agent: 'unit-scout', tools: ['read'], prompt: `Review ${normalized.value}.` });",
				"  return { control: { schema: 'dynamic-controller-result-v1', summary: `${normalized.value}:${child.control.digest}` }, analysis: 'done', refs: [] };",
				"}",
			].join("\n"),
		);
		writeFileSync(
			join(workflowDir, "helpers", "normalize.mjs"),
			"export default async function helper({ options }) { return { value: options.value }; }\n",
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: {
							uses: "./helpers/controller.mjs",
							helpers: {
								normalize: { uses: "./helpers/normalize.mjs" },
							},
						},
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Review dynamically.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		writeFileSync(
			join(workflowDir, "helpers", "normalize.mjs"),
			"export default async function helper() { throw new Error('live helper should not run'); }\n",
		);
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		let updated = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(updated, "adaptive.review").status, "running");
		assert.match(launched[0], /Review normalized/);
		let state = await readOrRebuildDynamicState(cwd, run.runId);
		assert.equal(
			state.controllers["adaptive.controller"].counters.helperRuns,
			1,
		);

		await completeTask(cwd, taskBySpec(updated, "adaptive.review"), {
			digest: "review done",
		});
		await writeRunRecord(cwd, updated);
		await scheduleRun(cwd, run.runId);
		updated = await readRunRecord(cwd, run.runId);
		assert.equal(
			taskBySpec(updated, "adaptive.controller").status,
			"completed",
		);
		state = await readOrRebuildDynamicState(cwd, run.runId);
		assert.equal(
			state.controllers["adaptive.controller"].counters.helperRuns,
			1,
		);
		const events = readFileSync(dynamicEventsPath(cwd, run.runId), "utf8");
		assert.equal(events.match(/helper\.completed/g)?.length, 1);
		const control = JSON.parse(
			readFileSync(
				join(
					dirname(
						join(cwd, taskBySpec(updated, "adaptive.controller").files.result),
					),
					"control.json",
				),
				"utf8",
			),
		);
		assert.equal(control.digest, "normalized:review done");
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph dynamic idempotent helper retries dangling started event", async () => {
	const cwd = makeProject();
	try {
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			[
				"export default async function controller(ctx) {",
				"  const normalized = await ctx.helper('normalize', { value: 'normalized' });",
				"  return { control: { schema: 'dynamic-controller-result-v1', summary: normalized.value }, analysis: 'done', refs: [] };",
				"}",
			].join("\n"),
		);
		writeFileSync(
			join(workflowDir, "helpers", "normalize.mjs"),
			"export default async function helper({ options }) { return { value: options.value }; }\n",
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: {
							uses: "./helpers/controller.mjs",
							helpers: {
								normalize: {
									uses: "./helpers/normalize.mjs",
									idempotent: true,
								},
							},
						},
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Review dynamically.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await appendDynamicEvent(cwd, run.runId, {
			controllerSpecId: "adaptive.controller",
			type: "helper.started",
			opId: "adaptive.controller:helper:normalize:001",
			requestHash: hashDynamicRequest({
				helperId: "normalize",
				uses: "./helpers/normalize.mjs",
				idempotent: true,
				inputSchema: undefined,
				outputSchema: undefined,
				input: { sources: {}, options: { value: "normalized" } },
			}),
			payload: {
				helperId: "normalize",
				uses: "./helpers/normalize.mjs",
				input: { sources: {}, options: { value: "normalized" } },
			},
		});
		await writeRunRecord(cwd, run);
		await scheduleRun(cwd, run.runId);
		const updated = await readRunRecord(cwd, run.runId);
		assert.equal(
			taskBySpec(updated, "adaptive.controller").status,
			"completed",
		);
		const events = readFileSync(dynamicEventsPath(cwd, run.runId), "utf8");
		assert.equal(events.match(/helper\.started/g)?.length, 1);
		assert.equal(events.match(/helper\.completed/g)?.length, 1);
		const control = JSON.parse(
			readFileSync(
				join(
					dirname(
						join(cwd, taskBySpec(updated, "adaptive.controller").files.result),
					),
					"control.json",
				),
				"utf8",
			),
		);
		assert.equal(control.digest, "normalized");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph dynamic helper replay detects schema changes", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		captureSubagentPrompts([]);
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		mkdirSync(join(workflowDir, "schemas"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			[
				"export default async function controller(ctx) {",
				"  const normalized = await ctx.helper('normalize', { value: 'normalized' });",
				"  const child = await ctx.agent({ id: 'review', agent: 'unit-scout', tools: ['read'], prompt: `Review ${normalized.value}.` });",
				"  return { control: { schema: 'dynamic-controller-result-v1', summary: child.control.digest }, analysis: 'done', refs: [] };",
				"}",
			].join("\n"),
		);
		writeFileSync(
			join(workflowDir, "helpers", "normalize.mjs"),
			"export default async function helper({ options }) { return { value: options.value }; }\n",
		);
		writeFileSync(
			join(workflowDir, "schemas", "input.json"),
			JSON.stringify({
				type: "object",
				properties: { value: { type: "string" } },
			}),
		);
		writeFileSync(
			join(workflowDir, "schemas", "output.json"),
			JSON.stringify({
				type: "object",
				properties: { value: { type: "string" } },
			}),
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: {
							uses: "./helpers/controller.mjs",
							helpers: {
								normalize: {
									uses: "./helpers/normalize.mjs",
									inputSchema: "./schemas/input.json",
									outputSchema: "./schemas/output.json",
								},
							},
						},
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Review dynamically.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);
		await scheduleRun(cwd, run.runId);
		let updated = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(updated, "adaptive.review").status, "running");
		writeFileSync(
			join(cwd, ".pi/workflows", run.runId, "bundle", "schemas", "output.json"),
			JSON.stringify({
				type: "object",
				properties: { value: { type: "string", minLength: 1 } },
			}),
		);
		await completeTask(cwd, taskBySpec(updated, "adaptive.review"), {
			digest: "review done",
		});
		await writeRunRecord(cwd, updated);
		await scheduleRun(cwd, run.runId);
		updated = await readRunRecord(cwd, run.runId);
		const controller = taskBySpec(updated, "adaptive.controller");
		assert.equal(controller.status, "failed");
		assert.match(
			controller.lastMessage ?? "",
			/dynamic controller initialization changed/,
		);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph dynamic helper budget blocks excess helper calls", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			[
				"export default async function controller(ctx) {",
				"  await ctx.helper('normalize', { value: 'one' });",
				"  await ctx.helper('normalize', { value: 'two' });",
				"  return { control: { schema: 'dynamic-controller-result-v1', summary: 'done' }, analysis: 'done', refs: [] };",
				"}",
			].join("\n"),
		);
		writeFileSync(
			join(workflowDir, "helpers", "normalize.mjs"),
			"export default async function helper({ options }) { return { value: options.value }; }\n",
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: {
							uses: "./helpers/controller.mjs",
							budget: { maxHelperRuns: 1 },
							helpers: {
								normalize: { uses: "./helpers/normalize.mjs" },
							},
						},
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Review dynamically.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		const updated = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(updated, "adaptive.controller").status, "blocked");
		assert.equal(
			taskBySpec(updated, "adaptive.controller").statusDetail,
			"dynamic_budget_blocked",
		);
		const state = await readOrRebuildDynamicState(cwd, run.runId);
		assert.equal(
			state.controllers["adaptive.controller"].counters.helperRuns,
			1,
		);
		assert.equal(
			state.controllers["adaptive.controller"].status,
			"budget_blocked",
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph dynamic budget blocks cannot be caught by controller", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			[
				"export default async function controller(ctx) {",
				"  try {",
				"    await ctx.helper('normalize', { value: 'one' });",
				"    await ctx.helper('normalize', { value: 'two' });",
				"  } catch (error) {",
				"    return { control: { schema: 'dynamic-controller-result-v1', summary: 'caught budget' }, analysis: 'caught', refs: [] };",
				"  }",
				"  return { control: { schema: 'dynamic-controller-result-v1', summary: 'done' }, analysis: 'done', refs: [] };",
				"}",
			].join("\n"),
		);
		writeFileSync(
			join(workflowDir, "helpers", "normalize.mjs"),
			"export default async function helper({ options }) { return { value: options.value }; }\n",
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: {
							uses: "./helpers/controller.mjs",
							budget: { maxHelperRuns: 1 },
							helpers: {
								normalize: { uses: "./helpers/normalize.mjs" },
							},
						},
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Review dynamically.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);
		await scheduleRun(cwd, run.runId);
		const updated = await readRunRecord(cwd, run.runId);
		const controller = taskBySpec(updated, "adaptive.controller");
		assert.equal(controller.status, "blocked");
		assert.equal(controller.statusDetail, "dynamic_budget_blocked");
		assert.equal(existsSync(join(cwd, controller.files.result)), false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph dynamic agents without explicit tools require managed worktrees", async () => {
	const cwd = makeProject();
	try {
		const agentDir = join(cwd, ".pi", "agents");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "default-tools.md"),
			"---\ndescription: default tools\n---\n# default tools\n\nUse Pi defaults.\n",
		);
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			[
				"export default async function controller(ctx) {",
				"  await ctx.agent({ id: 'defaults', agent: 'default-tools', prompt: 'Use default tools.' });",
				"  return { control: { schema: 'dynamic-controller-result-v1', summary: 'done' }, analysis: 'done', refs: [] };",
				"}",
			].join("\n"),
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: { uses: "./helpers/controller.mjs" },
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Review dynamically.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		const updated = await readRunRecord(cwd, run.runId);
		const generated = taskBySpec(updated, "adaptive.defaults");
		assert.equal(generated.status, "failed");
		assert.equal(generated.statusDetail, "worktree_failed");
		const compiledAfterSplice = JSON.parse(
			readFileSync(
				join(cwd, ".pi", "workflows", run.runId, "compiled.json"),
				"utf8",
			),
		);
		const generatedCompiled = compiledAfterSplice.tasks.find(
			(task) => task.id === "adaptive.defaults",
		);
		assert.equal(generatedCompiled.runtime.tools, undefined);
		assert.equal(generatedCompiled.safety.capability, "mutation-capable");
		assert.equal(generatedCompiled.safety.requiresWorktree, true);
		assert.equal(generatedCompiled.safety.sharedCwdSafe, false);
		assert.equal(generatedCompiled.safety.worktreePolicy, "on");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph dynamic ctx.parallel fails closed on non-suspension errors", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		captureSubagentPrompts([]);
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			[
				"export default async function controller(ctx) {",
				"  await ctx.parallel([",
				"    () => ctx.agent({ id: 'ok', agent: 'unit-scout', tools: ['read'], prompt: 'Ok.' }),",
				"    () => ctx.agent({ id: 'bad', agent: 'unit-scout', tools: ['write'], prompt: 'Bad.' }),",
				"  ]);",
				"  return { control: { schema: 'dynamic-controller-result-v1', summary: 'done' }, analysis: 'done', refs: [] };",
				"}",
			].join("\n"),
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: { uses: "./helpers/controller.mjs" },
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Review dynamically.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		const updated = await readRunRecord(cwd, run.runId);
		const controller = taskBySpec(updated, "adaptive.controller");
		assert.equal(controller.status, "failed");
		assert.equal(controller.statusDetail, "dynamic_failed");
		assert.match(
			controller.lastMessage ?? "",
			/ctx\.parallel dynamic operation failed/,
		);
		assert.equal(taskBySpec(updated, "adaptive.ok").status, "running");
		assert.equal(
			updated.tasks.some((task) => task.specId === "adaptive.bad"),
			false,
		);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph dynamic agent budget blocks additional generated tasks", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const launched = captureSubagentPrompts([]);
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			[
				"export default async function controller(ctx) {",
				"  await ctx.agent({ id: 'one', agent: 'unit-scout', tools: ['read'], prompt: 'One.' });",
				"  await ctx.agent({ id: 'two', agent: 'unit-scout', tools: ['read'], prompt: 'Two.' });",
				"  return { control: { schema: 'dynamic-controller-result-v1', summary: 'done' }, analysis: 'done', refs: [] };",
				"}",
			].join("\n"),
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: {
							uses: "./helpers/controller.mjs",
							budget: { maxAgents: 1 },
						},
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Review dynamically.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		let updated = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(updated, "adaptive.one").status, "running");
		assert.equal(taskBySpec(updated, "adaptive.controller").status, "pending");
		assert.equal(launched.length, 1);

		await completeTask(cwd, taskBySpec(updated, "adaptive.one"), {
			digest: "one done",
		});
		await writeRunRecord(cwd, updated);
		await scheduleRun(cwd, run.runId);
		updated = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(updated, "adaptive.controller").status, "blocked");
		assert.equal(
			taskBySpec(updated, "adaptive.controller").statusDetail,
			"dynamic_budget_blocked",
		);
		assert.equal(
			updated.tasks.some((task) => task.specId === "adaptive.two"),
			false,
		);
		assert.equal(launched.length, 1);
		const state = await readOrRebuildDynamicState(cwd, run.runId);
		assert.equal(
			state.controllers["adaptive.controller"].status,
			"budget_blocked",
		);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph dynamic permissions enforce role and tool restrictions", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			[
				"export default async function controller(ctx) {",
				"  await ctx.agent({ id: 'review', agent: 'unit-scout', tools: ['read'], prompt: 'Review generated work.' });",
				"  return { control: { schema: 'dynamic-controller-result-v1', summary: 'done' }, analysis: 'done', refs: [] };",
				"}",
			].join("\n"),
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: {
							uses: "./helpers/controller.mjs",
							permissions: { allowDynamicRoles: false },
						},
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Review dynamically.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		let updated = await readRunRecord(cwd, run.runId);
		let controller = taskBySpec(updated, "adaptive.controller");
		assert.equal(controller.status, "failed");
		assert.match(controller.lastMessage, /role selection is not allowed/);

		const toolsSpec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: {
							uses: "./helpers/controller.mjs",
							permissions: { allowDynamicTools: false },
						},
					},
				],
			},
		});
		const toolsCompiled = await compileWorkflow(toolsSpec, {
			cwd,
			task: "Review dynamically.",
			specPath,
		});
		const { run: toolsRun } = await createWorkflowRunRecord(
			cwd,
			toolsCompiled,
			specPath,
		);
		await writeStaticRunArtifacts(cwd, toolsRun, toolsCompiled, toolsSpec);
		await writeRunRecord(cwd, toolsRun);

		await scheduleRun(cwd, toolsRun.runId);
		updated = await readRunRecord(cwd, toolsRun.runId);
		controller = taskBySpec(updated, "adaptive.controller");
		assert.equal(controller.status, "failed");
		assert.match(controller.lastMessage, /tool overrides are not allowed/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph dynamic agent inputs build source manifest and required reads", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const launched = captureSubagentPrompts([]);
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			[
				"export default async function controller(ctx) {",
				"  await ctx.agent({ id: 'read-scope', agent: 'unit-scout', tools: ['read'], inputs: [ctx.artifact('scope.control', { include: ['$.items'] })], prompt: 'Read the scope artifact.' });",
				"  return { control: { schema: 'dynamic-controller-result-v1', summary: 'done' }, analysis: 'done', refs: [] };",
				"}",
			].join("\n"),
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "scope",
						type: "single",
						prompt: "Define scope.",
					},
					{
						id: "adaptive",
						from: "scope",
						type: "dynamic",
						dynamic: { uses: "./helpers/controller.mjs" },
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Review dynamically.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await completeTask(cwd, taskBySpec(run, "scope.main"), {
			digest: "scope ready",
			items: ["a"],
		});
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		const updated = await readRunRecord(cwd, run.runId);
		const generated = taskBySpec(updated, "adaptive.read-scope");
		assert.equal(generated.status, "running");
		assert.equal(launched.length, 1);
		assert.match(launched[0], /Required reads before final output/);
		assert.match(launched[0], /scope\.control/);
		const generatedDir = dirname(join(cwd, generated.files.result));
		const manifest = JSON.parse(
			readFileSync(join(generatedDir, "source-manifest.json"), "utf8"),
		);
		assert.equal(manifest.sources[0].source, "scope");
		assert.equal(manifest.sources[0].digest, "scope ready");
		assert.deepEqual(manifest.sources[0].controlProjection.items, ["a"]);
		const compiledAfterSplice = JSON.parse(
			readFileSync(
				join(cwd, ".pi", "workflows", run.runId, "compiled.json"),
				"utf8",
			),
		);
		const generatedCompiled = compiledAfterSplice.tasks.find(
			(task) => task.id === "adaptive.read-scope",
		);
		assert.deepEqual(generatedCompiled.artifactGraph.requiredReads, [
			"scope.control",
		]);
		assert.deepEqual(generatedCompiled.contextDependsOn, ["scope.main"]);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph dynamic generated input sources use generated spec ids", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		captureSubagentPrompts([]);
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			[
				"export default async function controller(ctx) {",
				"  await ctx.agent({ id: 'first', agent: 'unit-scout', tools: ['read'], prompt: 'First.' });",
				"  await ctx.agent({ id: 'second', agent: 'unit-scout', tools: ['read'], inputs: [ctx.artifact('adaptive.first.control')], prompt: 'Second reads first.' });",
				"  return { control: { schema: 'dynamic-controller-result-v1', summary: 'done' }, analysis: 'done', refs: [] };",
				"}",
			].join("\n"),
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: { uses: "./helpers/controller.mjs" },
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Review dynamically.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		let updated = await readRunRecord(cwd, run.runId);
		await completeTask(cwd, taskBySpec(updated, "adaptive.first"), {
			digest: "first done",
			result: "ok",
		});
		await writeRunRecord(cwd, updated);
		await scheduleRun(cwd, run.runId);
		updated = await readRunRecord(cwd, run.runId);
		const second = taskBySpec(updated, "adaptive.second");
		assert.equal(second.status, "running");
		const manifest = JSON.parse(
			readFileSync(
				join(dirname(join(cwd, second.files.result)), "source-manifest.json"),
				"utf8",
			),
		);
		assert.equal(manifest.sources[0].source, "adaptive.first");
		const compiledAfterSplice = JSON.parse(
			readFileSync(
				join(cwd, ".pi", "workflows", run.runId, "compiled.json"),
				"utf8",
			),
		);
		const secondCompiled = compiledAfterSplice.tasks.find(
			(task) => task.id === "adaptive.second",
		);
		assert.deepEqual(secondCompiled.artifactGraph.requiredReads, [
			"adaptive.first.control",
		]);
		assert.equal(secondCompiled.artifactGraph.output.maxDigestChars, 1000);
		assert.match(
			secondCompiled.compiledPrompt,
			/control\.digest string must be at most 1000 characters/,
		);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph downstream reduce sees exported dynamic output source", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		captureSubagentPrompts([]);
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			[
				"export default async function controller(ctx) {",
				"  const result = await ctx.agent({ id: 'synthesis', agent: 'unit-scout', tools: ['read'], prompt: 'Synthesize dynamic output.' });",
				"  return { control: { schema: 'dynamic-controller-result-v1', digest: 'controller done', generatedTasks: [result.specId], outputTasks: [result.specId] }, analysis: 'controller done', refs: [] };",
				"}",
			].join("\n"),
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: { uses: "./helpers/controller.mjs" },
					},
					{
						id: "final",
						type: "reduce",
						from: "adaptive",
						prompt: "Write final report from the dynamic output.",
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Review dynamically.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		let updated = await readRunRecord(cwd, run.runId);
		await completeTask(cwd, taskBySpec(updated, "adaptive.synthesis"), {
			digest: "synthesis done",
			answer: "source-backed synthesis",
		});
		await writeRunRecord(cwd, updated);
		for (let attempt = 0; attempt < 3; attempt += 1) {
			await scheduleRun(cwd, run.runId);
			updated = await readRunRecord(cwd, run.runId);
			if (taskBySpec(updated, "final.main").status === "running") break;
		}
		const finalTask = taskBySpec(updated, "final.main");
		assert.equal(finalTask.status, "running");
		const manifest = JSON.parse(
			readFileSync(
				join(
					dirname(join(cwd, finalTask.files.result)),
					"source-manifest.json",
				),
				"utf8",
			),
		);
		assert.deepEqual(
			manifest.sources.map((source) => source.source),
			["adaptive", "adaptive.output"],
		);
		assert.equal(manifest.sources[1].specId, "adaptive.synthesis");
		assert.equal(manifest.sources[1].digest, "synthesis done");
		assert.deepEqual(manifest.sources[1].controlProjection, undefined);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph dynamic approval ask uses interactive UI decisions", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			"export default async function controller() { return { control: { schema: 'dynamic-controller-result-v1', summary: 'approved' }, analysis: 'approved', refs: [] }; }\n",
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: {
							uses: "./helpers/controller.mjs",
							permissions: { approval: "ask" },
						},
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const prompts = [];
		const approvedRun = await runWorkflowSpec(specPath, cwd, {
			task: "Review dynamically.",
			dynamicUi: {
				hasUI: true,
				confirm: async (title, message) => {
					prompts.push({ title, message });
					return true;
				},
			},
		});
		assert.equal(approvedRun.status, "completed");
		assert.equal(prompts.length, 1);
		assert.match(prompts[0].message, /adaptive\.controller/);
		assert.match(prompts[0].message, /Task digest:/);
		assert.match(prompts[0].message, /Approval request digest:/);
		assert.match(prompts[0].message, /without later approval prompts/);
		const approvalEvents = await readDynamicEvents(cwd, approvedRun.runId);
		const pendingApproval = approvalEvents.find(
			(event) => event.type === "approval.pending",
		);
		const resolvedApproval = approvalEvents.find(
			(event) => event.type === "approval.resolved",
		);
		assert.equal(
			pendingApproval.payload.approvalScope.taskText.hash,
			resolvedApproval.payload.approvalScope.taskText.hash,
		);
		assert.equal(
			resolvedApproval.payload.approvalScope.controllerSpecId,
			"adaptive.controller",
		);
		assert.equal(
			resolvedApproval.payload.approvalScope.bundle.files[0].hash.length,
			64,
		);
		const approvedController = taskBySpec(approvedRun, "adaptive.controller");
		const approvedControl = JSON.parse(
			readFileSync(
				join(
					dirname(join(cwd, approvedController.files.result)),
					"control.json",
				),
				"utf8",
			),
		);
		assert.equal(approvedControl.digest, "approved");

		const confirmOnlyRun = await runWorkflowSpec(specPath, cwd, {
			task: "Review dynamically.",
			dynamicUi: { confirm: async () => true },
		});
		assert.equal(confirmOnlyRun.status, "completed");

		const rejectedRun = await runWorkflowSpec(specPath, cwd, {
			task: "Review dynamically.",
			dynamicUi: { hasUI: true, confirm: async () => false },
		});
		assert.equal(rejectedRun.status, "blocked");
		assert.equal(
			taskBySpec(rejectedRun, "adaptive.controller").statusDetail,
			"dynamic_approval_rejected",
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph dynamic approval ask blocks when no UI is available", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			"export default async function controller() { return { control: { schema: 'dynamic-controller-result-v1', summary: 'approved-after-resume' }, analysis: 'approved', refs: [] }; }\n",
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: {
							uses: "./helpers/controller.mjs",
							permissions: { approval: "ask" },
						},
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Review dynamically.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		const updated = await readRunRecord(cwd, run.runId);
		const controller = taskBySpec(updated, "adaptive.controller");
		assert.equal(controller.status, "blocked");
		assert.equal(controller.statusDetail, "dynamic_ui_unavailable");
		const state = await readOrRebuildDynamicState(cwd, run.runId);
		assert.equal(
			state.controllers["adaptive.controller"].status,
			"awaiting_ui_unavailable",
		);
		assert.ok(state.controllers["adaptive.controller"].pendingUiApproval);
		assert.match(
			readFileSync(dynamicEventsPath(cwd, run.runId), "utf8"),
			/approval\.pending/,
		);

		const resumed = await resumeRun(cwd, run.runId, {
			dynamicUi: { hasUI: true, confirm: async () => true },
		});
		assert.equal(resumed.run.status, "completed");
		assert.equal(resumed.resetTaskIds.length, 1);
		assert.equal(
			taskBySpec(resumed.run, "adaptive.controller").statusDetail,
			"dynamic_completed",
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph dynamic approval detects changed pending approval request", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			"export default async function controller() { return { control: { schema: 'dynamic-controller-result-v1', summary: 'approved' }, analysis: 'approved', refs: [] }; }\n",
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: {
							uses: "./helpers/controller.mjs",
							permissions: { approval: "ask" },
						},
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Review dynamically.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await appendDynamicEvent(cwd, run.runId, {
			controllerSpecId: "adaptive.controller",
			type: "approval.pending",
			opId: "adaptive.controller:approval:controller",
			requestHash: "old-approval-hash",
			payload: { message: "old prompt" },
		});
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId, undefined, {
			dynamicUi: { hasUI: true, confirm: async () => true },
		});
		const updated = await readRunRecord(cwd, run.runId);
		assert.equal(
			taskBySpec(updated, "adaptive.controller").statusDetail,
			"dynamic_approval_changed",
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph dynamic runtime budget blocks slow controller", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			[
				"export default async function controller() {",
				"  await new Promise((resolve) => setTimeout(resolve, 20));",
				"  return { control: { schema: 'dynamic-controller-result-v1', summary: 'late' }, analysis: 'late', refs: [] };",
				"}",
			].join("\n"),
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: {
							uses: "./helpers/controller.mjs",
							budget: { maxRuntimeMs: 1 },
						},
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Review dynamically.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		const updated = await readRunRecord(cwd, run.runId);
		const controller = taskBySpec(updated, "adaptive.controller");
		assert.equal(controller.status, "blocked");
		assert.equal(controller.statusDetail, "dynamic_budget_blocked");
		assert.match(controller.lastMessage, /maxRuntimeMs=1/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph dynamic runtime budget excludes suspended child wait time", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		captureSubagentPrompts([]);
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			[
				"export default async function controller(ctx) {",
				"  const child = await ctx.agent({ id: 'review', agent: 'unit-scout', tools: ['read'], prompt: 'Review generated work.' });",
				"  return { control: { schema: 'dynamic-controller-result-v1', summary: child.control.digest }, analysis: 'done', refs: [] };",
				"}",
			].join("\n"),
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: {
							uses: "./helpers/controller.mjs",
							budget: { maxRuntimeMs: 100 },
						},
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Review dynamically.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		let updated = await readRunRecord(cwd, run.runId);
		const controller = taskBySpec(updated, "adaptive.controller");
		assert.equal(controller.statusDetail, "suspended_waiting_children");
		await scheduleRun(cwd, run.runId);
		await scheduleRun(cwd, run.runId);
		assert.equal(
			readFileSync(dynamicEventsPath(cwd, run.runId), "utf8").match(
				/budget\.used/g,
			)?.length,
			1,
		);
		updated = await readRunRecord(cwd, run.runId);
		const suspendedController = taskBySpec(updated, "adaptive.controller");
		suspendedController.startedAt = new Date(Date.now() - 60_000).toISOString();
		await completeTask(cwd, taskBySpec(updated, "adaptive.review"), {
			digest: "review done",
		});
		await writeRunRecord(cwd, updated);

		await scheduleRun(cwd, run.runId);
		updated = await readRunRecord(cwd, run.runId);
		assert.equal(
			taskBySpec(updated, "adaptive.controller").status,
			"completed",
		);
		const state = await readOrRebuildDynamicState(cwd, run.runId);
		assert.ok(
			state.controllers["adaptive.controller"].counters.runtimeMs < 100,
		);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph dynamic runtime budget terminates synchronous controller loop", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			"export default async function controller() { while (true) {} }\n",
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: {
							uses: "./helpers/controller.mjs",
							budget: { maxRuntimeMs: 10 },
						},
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Review dynamically.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		const updated = await readRunRecord(cwd, run.runId);
		const controller = taskBySpec(updated, "adaptive.controller");
		assert.equal(controller.status, "blocked");
		assert.equal(controller.statusDetail, "dynamic_budget_blocked");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph dynamic optional missing artifact input is skipped", async () => {
	const cwd = makeProject();
	const launched = [];
	try {
		writeAgent(cwd, "unit-scout", "read");
		setSubagentApiForTests({
			async runSubagent(options) {
				launched.push(String(options.task ?? ""));
				return {
					runId: "run_optional",
					attemptId: "attempt_optional",
					status: "running",
				};
			},
			async getSubagentStatus() {
				return null;
			},
			async reconcileSubagentRun() {
				return {};
			},
			async interruptSubagent() {
				return {};
			},
		});
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			[
				"export default async function controller(ctx) {",
				"  await ctx.agent({ id: 'optional', agent: 'unit-scout', tools: ['read'], inputs: [ctx.artifact('missing.control', { required: false })], prompt: 'Optional.' });",
				"  return { control: { schema: 'dynamic-controller-result-v1', summary: 'done' }, analysis: 'done', refs: [] };",
				"}",
			].join("\n"),
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: { uses: "./helpers/controller.mjs" },
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Review dynamically.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		const updated = await readRunRecord(cwd, run.runId);
		const generated = taskBySpec(updated, "adaptive.optional");
		assert.equal(generated.status, "running");
		assert.equal(launched.length, 1);
		const compiledAfterSplice = JSON.parse(
			readFileSync(
				join(cwd, ".pi", "workflows", run.runId, "compiled.json"),
				"utf8",
			),
		);
		const generatedCompiled = compiledAfterSplice.tasks.find(
			(task) => task.id === "adaptive.optional",
		);
		assert.deepEqual(generatedCompiled.contextDependsOn, []);
		assert.deepEqual(generatedCompiled.artifactGraph.requiredReads, []);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph dynamic nested workflow runs declared workflow from bundle", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		mkdirSync(join(workflowDir, "nested", "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			[
				"export default async function controller(ctx) {",
				"  const nested = await ctx.workflow('child', { task: 'Nested task' });",
				"  return { control: { schema: 'dynamic-controller-result-v1', summary: nested.status, nestedRunId: nested.runId, nestedDigest: nested.tasks[0].control.digest }, analysis: 'done', refs: [] };",
				"}",
			].join("\n"),
		);
		writeFileSync(
			join(workflowDir, "nested", "helpers", "done.mjs"),
			"export default async function helper() { return { schema: 'stage-control-v1', digest: 'nested done' }; }\n",
		);
		const nestedSpec = artifactGraphWorkflowSpec({
			name: "nested-child",
			artifactGraph: {
				stages: [{ id: "done", support: { uses: "./helpers/done.mjs" } }],
			},
		});
		writeFileSync(
			join(workflowDir, "nested", "spec.json"),
			JSON.stringify(nestedSpec),
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: {
							uses: "./helpers/controller.mjs",
							workflows: { child: { uses: "./nested/spec.json" } },
						},
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Review dynamically.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		writeFileSync(
			join(workflowDir, "nested", "helpers", "done.mjs"),
			"export default async function helper() { throw new Error('live nested helper should not run'); }\n",
		);
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		const updated = await readRunRecord(cwd, run.runId);
		const controller = taskBySpec(updated, "adaptive.controller");
		assert.equal(controller.status, "completed");
		const control = JSON.parse(
			readFileSync(
				join(dirname(join(cwd, controller.files.result)), "control.json"),
				"utf8",
			),
		);
		assert.equal(control.digest, "completed");
		assert.equal(control.nestedDigest, "nested done");
		assert.match(control.nestedRunId, /^workflow_/);
		const state = await readOrRebuildDynamicState(cwd, run.runId);
		assert.equal(
			state.controllers["adaptive.controller"].counters.nestedWorkflowDepth,
			1,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph dynamic nested workflow wait false replays first snapshot", async () => {
	const cwd = makeProject();
	const launched = [];
	try {
		writeAgent(cwd, "unit-scout", "read");
		setSubagentApiForTests({
			async runSubagent(options) {
				launched.push(String(options.task ?? ""));
				return {
					runId: `run_nested_wait_false_${launched.length}`,
					attemptId: `attempt_nested_wait_false_${launched.length}`,
					status: "running",
				};
			},
			async getSubagentStatus() {
				return null;
			},
			async reconcileSubagentRun() {
				return {};
			},
			async interruptSubagent() {
				return {};
			},
		});
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		mkdirSync(join(workflowDir, "nested"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			[
				"export default async function controller(ctx) {",
				"  const nested = await ctx.workflow('child', { task: 'Nested task', wait: false });",
				"  await ctx.agent({ id: 'gate', agent: 'unit-scout', tools: ['read'], prompt: 'Gate.' });",
				"  return { control: { schema: 'dynamic-controller-result-v1', summary: nested.status, nestedStatus: nested.status }, analysis: 'done', refs: [] };",
				"}",
			].join("\n"),
		);
		const nestedSpec = artifactGraphWorkflowSpec({
			name: "nested-child",
			artifactGraph: {
				stages: [{ id: "child", type: "single", prompt: "Child." }],
			},
		});
		writeFileSync(
			join(workflowDir, "nested", "spec.json"),
			JSON.stringify(nestedSpec),
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: {
							uses: "./helpers/controller.mjs",
							workflows: { child: { uses: "./nested/spec.json" } },
						},
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Review dynamically.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		let parent = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(parent, "adaptive.controller").status, "pending");
		assert.equal(taskBySpec(parent, "adaptive.gate").status, "running");
		const state = await readOrRebuildDynamicState(cwd, run.runId);
		const nestedRunId =
			state.controllers["adaptive.controller"].nestedWorkflowRunIds[0];
		const nested = await readRunRecord(cwd, nestedRunId);
		assert.equal(nested.status, "running");

		await completeTask(cwd, nested.tasks[0], { digest: "nested complete" });
		await writeRunRecord(cwd, nested);
		await completeTask(cwd, taskBySpec(parent, "adaptive.gate"), {
			digest: "gate complete",
		});
		await writeRunRecord(cwd, parent);
		await scheduleRun(cwd, run.runId);
		parent = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(parent, "adaptive.controller").status, "completed");
		const control = JSON.parse(
			readFileSync(
				join(
					dirname(
						join(cwd, taskBySpec(parent, "adaptive.controller").files.result),
					),
					"control.json",
				),
				"utf8",
			),
		);
		assert.equal(control.nestedStatus, "running");
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifact graph loader rejects unsupported controlSchema keywords", async () => {
	const cwd = makeProject();
	try {
		mkdirSync(join(cwd, "workflows", "schemas"), { recursive: true });
		writeFileSync(
			join(cwd, "workflows", "schemas", "bad.json"),
			JSON.stringify({
				type: "object",
				properties: { name: { type: "string", pattern: "^[a-z]+$" } },
			}),
		);
		writeFileSync(
			join(cwd, "workflows", "bad-schema.json"),
			JSON.stringify(
				artifactGraphWorkflowSpec({
					artifactGraph: {
						stages: [
							{
								id: "main",
								type: "single",
								prompt: "Do it.",
								output: { controlSchema: "./schemas/bad.json" },
							},
						],
					},
				}),
			),
		);
		await assert.rejects(
			() => loadWorkflow("bad-schema", cwd),
			(error) =>
				error instanceof WorkflowValidationError &&
				/pattern is not supported/.test(String(error)),
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifact graph loader rejects missing controlSchema files", async () => {
	const cwd = makeProject();
	try {
		mkdirSync(join(cwd, "workflows"), { recursive: true });
		writeFileSync(
			join(cwd, "workflows", "missing-schema.json"),
			JSON.stringify(
				artifactGraphWorkflowSpec({
					artifactGraph: {
						stages: [
							{
								id: "main",
								type: "single",
								prompt: "Do it.",
								output: { controlSchema: "./schemas/missing.json" },
							},
						],
					},
				}),
			),
		);
		await assert.rejects(
			() => loadWorkflow("missing-schema", cwd),
			(error) =>
				error instanceof WorkflowValidationError &&
				/controlSchema not readable JSON/.test(String(error)),
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifact graph schema rejects unknown output fields and invalid required reads", () => {
	const invalid = assertThrowsFlow(() =>
		parsePublicWorkflow(
			artifactGraphWorkflowSpec({
				artifactGraph: {
					stages: [
						{
							id: "extract",
							type: "single",
							prompt: "Extract.",
							output: { unexpected: true, extra: ["items"] },
						},
						{
							id: "review",
							type: "reduce",
							from: ["missing"],
							inputPolicy: {
								requiredReads: ["extract.prompt", "extract.analysis"],
							},
							prompt: "Review.",
						},
					],
				},
			}),
		),
	);
	assertIssue(
		invalid,
		"$.artifactGraph.stages[0].output.unexpected",
		"unknown field",
	);
	assertIssue(
		invalid,
		"$.artifactGraph.stages[0].output.extra",
		"unknown field",
	);
	assertIssue(
		invalid,
		"$.artifactGraph.stages[1].from[0]",
		"unknown stage reference",
	);
	assertIssue(
		invalid,
		"$.artifactGraph.stages[1].inputPolicy.requiredReads[0]",
		"artifact must be one of",
	);
});

test("artifact graph schema enforces launch-time invariants", () => {
	const legacySupportType = assertThrowsFlow(() =>
		parsePublicWorkflow(
			artifactGraphWorkflowSpec({
				artifactGraph: {
					stages: [
						{
							id: "audit",
							type: "support",
							support: { uses: "./helpers/audit.mjs" },
						},
					],
				},
			}),
		),
	);
	assertIssue(
		legacySupportType,
		"$.artifactGraph.stages[0].type",
		"must be one of: single, reduce, foreach, loop, dag, dynamic",
	);

	const supportOnSingle = assertThrowsFlow(() =>
		parsePublicWorkflow(
			artifactGraphWorkflowSpec({
				artifactGraph: {
					stages: [
						{
							id: "audit",
							type: "single",
							prompt: "Audit.",
							support: { uses: "./helpers/audit.mjs" },
						},
					],
				},
			}),
		),
	);
	assertIssue(
		supportOnSingle,
		"$.artifactGraph.stages[0].type",
		"must be omitted when support is declared",
	);

	const loopWithoutMaxRounds = assertThrowsFlow(() =>
		parsePublicWorkflow(
			loopWorkflowSpec({ maxRounds: undefined, until: { exists: true } }),
		),
	);
	assertIssue(
		loopWithoutMaxRounds,
		"$.artifactGraph.stages[0].maxRounds",
		"must declare maxRounds",
	);

	const badLoopPath = assertThrowsFlow(() =>
		parsePublicWorkflow(
			loopWorkflowSpec({
				until: { stage: "check", path: "status", exists: true },
			}),
		),
	);
	assertIssue(
		badLoopPath,
		"$.artifactGraph.stages[0].until.path",
		"starting with $.",
	);

	const forwardRef = assertThrowsFlow(() =>
		parsePublicWorkflow(
			artifactGraphWorkflowSpec({
				artifactGraph: {
					stages: [
						{ id: "final", type: "reduce", from: "scan", prompt: "Final." },
						{ id: "scan", type: "single", prompt: "Scan." },
					],
				},
			}),
		),
	);
	assertIssue(
		forwardRef,
		"$.artifactGraph.stages[0].from",
		"earlier sibling stages",
	);

	const backendAuto = assertThrowsFlow(() =>
		parsePublicWorkflow(
			artifactGraphWorkflowSpec({
				defaults: { agent: "unit-scout", backend: { mode: "auto" } },
			}),
		),
	);
	assertIssue(backendAuto, "$.defaults.backend.mode", 'must be "headless"');

	assert.doesNotThrow(() =>
		parsePublicWorkflow(
			artifactGraphWorkflowSpec({
				artifactGraph: {
					stages: [
						{
							id: "analysis",
							type: "dag",
							outputFrom: "final",
							stages: [
								{ id: "scan", type: "single", prompt: "Scan." },
								{
									id: "final",
									type: "reduce",
									from: "scan",
									prompt: "Final.",
								},
							],
						},
						{
							id: "report",
							type: "reduce",
							from: "analysis",
							inputPolicy: {
								requiredReads: ["analysis.final.analysis"],
							},
							prompt: "Report.",
						},
					],
				},
			}),
		),
	);

	const dagContainerRead = assertThrowsFlow(() =>
		parsePublicWorkflow(
			artifactGraphWorkflowSpec({
				artifactGraph: {
					stages: [
						{
							id: "analysis",
							type: "dag",
							outputFrom: "final",
							stages: [{ id: "final", type: "single", prompt: "Final." }],
						},
						{
							id: "report",
							type: "reduce",
							from: "analysis",
							inputPolicy: { requiredReads: ["analysis.analysis"] },
							prompt: "Report.",
						},
					],
				},
			}),
		),
	);
	assertIssue(
		dagContainerRead,
		"$.artifactGraph.stages[1].inputPolicy.requiredReads[0]",
		"not an available upstream artifact source",
	);

	const badStageId = assertThrowsFlow(() =>
		parsePublicWorkflow(
			artifactGraphWorkflowSpec({
				artifactGraph: {
					stages: [{ id: "bad/id", type: "single", prompt: "Bad." }],
				},
			}),
		),
	);
	assertIssue(badStageId, "$.artifactGraph.stages[0].id", "stage id");

	const loopInDag = assertThrowsFlow(() =>
		parsePublicWorkflow(
			artifactGraphWorkflowSpec({
				artifactGraph: {
					stages: [
						{
							id: "box",
							type: "dag",
							stages: [loopWorkflowSpec().artifactGraph.stages[0]],
						},
					],
				},
			}),
		),
	);
	assertIssue(
		loopInDag,
		"$.artifactGraph.stages[0].stages[0].type",
		"top level",
	);
});

test("schema accepts bundled artifact graph workflow fixtures", () => {
	for (const specPath of bundledArtifactGraphSpecPaths()) {
		const spec = JSON.parse(
			readFileSync(join(process.cwd(), specPath), "utf8"),
		);
		assert.doesNotThrow(() => parsePublicWorkflow(spec), specPath);
		assert.ok(spec.artifactGraph, specPath);
		assert.equal(spec.workflow, undefined, specPath);
	}
});

test("bundled artifact graph outputs declare control schemas", () => {
	for (const specPath of bundledArtifactGraphSpecPaths()) {
		const spec = JSON.parse(
			readFileSync(join(process.cwd(), specPath), "utf8"),
		);
		for (const stage of flattenArtifactGraphStages(spec.artifactGraph.stages)) {
			if (!stage.output) continue;
			assert.equal(
				typeof stage.output.controlSchema,
				"string",
				`${specPath}:${stage.id}`,
			);
		}
	}
});

test("bundled deep-research compacts audit packets before executive final", async () => {
	const specPath = join(
		process.cwd(),
		"workflows",
		"deep-research",
		"spec.json",
	);
	const spec = parsePublicWorkflow(JSON.parse(readFileSync(specPath, "utf8")));
	const compiled = await compileWorkflow(spec, {
		cwd: process.cwd(),
		task: "Research the deep-research artifact contract.",
		specPath,
	});
	const byStage = new Map(compiled.tasks.map((task) => [task.stageId, task]));
	const normalizeInputPacket = byStage.get("normalize-input-packet");
	const normalizeClaims = byStage.get("normalize-claims");
	const auditClaims = byStage.get("audit-claims");
	const finalAuditPacket = byStage.get("final-audit-packet");
	const finalAudit = byStage.get("final-audit");
	const final = byStage.get("final");

	assert.equal(normalizeInputPacket?.kind, "support");
	assert.deepEqual(normalizeInputPacket.dependsOn, [
		"plan.main",
		"research-questions.item",
	]);
	assert.equal(normalizeInputPacket.support.uses, "./helpers/normalize-input-packet.mjs");
	assert.deepEqual(normalizeClaims?.dependsOn, [
		"plan.main",
		"research-questions.item",
		"normalize-input-packet.main",
	]);

	assert.equal(auditClaims?.kind, "support");
	assert.deepEqual(auditClaims.dependsOn, [
		"plan.main",
		"normalize-input-packet.main",
		"normalize-claims.main",
		"verify-claims.item",
	]);

	assert.equal(finalAuditPacket?.kind, "support");
	assert.deepEqual(finalAuditPacket.dependsOn, [
		"plan.main",
		"normalize-claims.main",
		"audit-claims.main",
	]);
	assert.equal(finalAuditPacket.support.uses, "./helpers/final-audit-packet.mjs");

	assert.equal(finalAudit?.kind, "reduce");
	assert.deepEqual(finalAudit.dependsOn, ["final-audit-packet.main"]);
	assert.deepEqual(finalAudit.artifactGraph.requiredReads, [
		"final-audit-packet.control",
	]);
	assert.equal(finalAudit.artifactGraph.sourceProjection, undefined);
	assert.ok(
		finalAudit.artifactGraph.output.controlSchemaPath.endsWith(
			join(
				"workflows",
				"deep-research",
				"schemas",
				"deep-research-final-control.schema.json",
			),
		),
	);

	assert.equal(final?.kind, "support");
	assert.deepEqual(final.dependsOn, ["final-audit.main"]);
	assert.equal(final.support.uses, "./helpers/render-executive.mjs");
	assert.deepEqual(final.support.options, {
		maxWords: 600,
		maxUrls: 5,
		maxFindings: 3,
		maxRecommendations: 3,
		maxGaps: 2,
	});
	assert.ok(
		final.artifactGraph.output.controlSchemaPath.endsWith(
			join(
				"workflows",
				"deep-research",
				"schemas",
				"deep-research-executive-render-control.schema.json",
			),
		),
	);
});

test("non-dynamic artifact graph compile/run golden preserves static structure", async () => {
	const cwd = makeProject();
	const launched = [];
	try {
		writeAgent(cwd, "unit-scout", "read");
		setSubagentApiForTests({
			async runSubagent(options) {
				launched.push(String(options.task ?? ""));
				return {
					runId: `run_static_${launched.length}`,
					attemptId: `attempt_static_${launched.length}`,
					status: "running",
				};
			},
			async getSubagentStatus() {
				return null;
			},
			async reconcileSubagentRun() {
				return {};
			},
			async interruptSubagent() {
				return {};
			},
		});
		const spec = workflowSpec("unit-scout", {
			artifactGraph: {
				stages: [
					{ id: "scope", type: "single", prompt: "Scope." },
					{ id: "report", type: "reduce", from: "scope", prompt: "Report." },
				],
			},
		});
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Review static behavior",
		});

		assert.equal(compiled.type, "artifact-graph");
		assert.equal(compiled.artifactGraph.enabled, true);
		assert.deepEqual(
			compiled.stages.map((stage) => ({
				id: stage.id,
				type: stage.type,
				sourcePolicy: stage.sourcePolicy,
			})),
			[
				{ id: "scope", type: "single", sourcePolicy: "require-success" },
				{ id: "report", type: "reduce", sourcePolicy: "require-success" },
			],
		);
		assert.deepEqual(
			compiled.tasks.map((task) => ({
				id: task.id,
				key: task.key,
				stageId: task.stageId,
				kind: task.kind,
				agent: task.agent,
				dependsOn: task.dependsOn,
				injectTask: task.injectTask,
				requiredReads: task.artifactGraph.requiredReads,
			})),
			[
				{
					id: "scope.main",
					key: "scope.main",
					stageId: "scope",
					kind: "single",
					agent: "unit-scout",
					dependsOn: [],
					injectTask: true,
					requiredReads: [],
				},
				{
					id: "report.main",
					key: "report.main",
					stageId: "report",
					kind: "reduce",
					agent: "unit-scout",
					dependsOn: ["scope.main"],
					injectTask: false,
					requiredReads: [],
				},
			],
		);

		const { run } = await createWorkflowRunRecord(
			cwd,
			compiled,
			join(cwd, "workflows", "static.json"),
		);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		let updated = await readRunRecord(cwd, run.runId);
		assert.equal(updated.dynamic, undefined);
		assert.deepEqual(
			updated.tasks.map((task) => ({
				specId: task.specId,
				status: task.status,
				statusDetail: task.statusDetail,
			})),
			[
				{
					specId: "scope.main",
					status: "running",
					statusDetail: "running",
				},
				{
					specId: "report.main",
					status: "pending",
					statusDetail: "pending",
				},
			],
		);
		assert.equal(launched.length, 1);
		assert.match(launched[0], /# Task\n\nReview static behavior/);
		assert.match(launched[0], /stage=scope/);

		await completeTask(cwd, taskBySpec(updated, "scope.main"), {
			digest: "scope done",
		});
		await writeRunRecord(cwd, updated);
		await scheduleRun(cwd, run.runId);
		updated = await readRunRecord(cwd, run.runId);
		assert.deepEqual(
			updated.tasks.map((task) => ({
				specId: task.specId,
				status: task.status,
				statusDetail: task.statusDetail,
			})),
			[
				{
					specId: "scope.main",
					status: "completed",
					statusDetail: "completed",
				},
				{
					specId: "report.main",
					status: "running",
					statusDetail: "running",
				},
			],
		);
		assert.equal(launched.length, 2);
		assert.doesNotMatch(launched[1], /# Task/);
		assert.match(launched[1], /stage=report/);

		await completeTask(cwd, taskBySpec(updated, "report.main"), {
			digest: "report done",
		});
		await writeRunRecord(cwd, updated);
		updated = await readRunRecord(cwd, run.runId);
		assert.equal(updated.status, "completed");
		assert.deepEqual(updated.taskSummary, {
			total: 2,
			pending: 0,
			running: 0,
			blocked: 0,
			completed: 2,
			failed: 0,
			skipped: 0,
			interrupted: 0,
		});
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("schema and compiler accept partial sourcePolicy on foreach", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "extract",
						type: "single",
						prompt: "Extract",
					},
					{
						id: "verify",
						type: "foreach",
						sourcePolicy: "partial",
						from: { source: "extract", path: "$.items" },
						each: { prompt: "Verify ${item}" },
					},
				],
			},
		});
		assert.equal(
			parseWorkflow(spec).artifactGraph.stages[1].sourcePolicy,
			"partial",
		);
		const compiled = await compileWorkflow(spec, { cwd, task: "Review" });
		assert.equal(compiled.stages[1].sourcePolicy, "partial");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("compiler warns when readOnly stage keeps mutation-capable tools", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read, bash");
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "check",
						type: "single",
						readOnly: true,
						tools: ["read", "bash"],
						prompt: "Run checks read-only.",
					},
				],
			},
		});
		const compiled = await compileWorkflow(spec, { cwd, task: "Check" });
		assert.equal(compiled.tasks[0].safety.readOnlyDeclared, true);
		assert.equal(compiled.tasks[0].safety.capability, "mutation-capable");
		assert.ok(
			compiled.warnings.some(
				(w) =>
					/stage "check" declares readOnly: true/.test(w) && /bash/.test(w),
			),
			`expected readOnly+bash warning, got: ${JSON.stringify(compiled.warnings)}`,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("compiler does not warn when read-only stage uses only read-only tools", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read, grep");
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "scan",
						type: "single",
						readOnly: true,
						tools: ["read", "grep"],
						prompt: "Scan read-only.",
					},
				],
			},
		});
		const compiled = await compileWorkflow(spec, { cwd, task: "Scan" });
		assert.equal(
			compiled.warnings.filter((w) => /declares readOnly: true/.test(w)).length,
			0,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("compiler warns when a foreach path is absent from the source control schema", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		mkdirSync(join(cwd, "schemas"), { recursive: true });
		writeFileSync(
			join(cwd, "schemas", "scan.schema.json"),
			JSON.stringify({
				type: "object",
				required: ["schema", "digest", "gapItems"],
				properties: {
					schema: { type: "string" },
					digest: { type: "string" },
					gapItems: { type: "array" },
				},
			}),
		);
		const baseSpec = (foreachPath) =>
			artifactGraphWorkflowSpec({
				artifactGraph: {
					stages: [
						{
							id: "scan",
							type: "single",
							prompt: "Scan.",
							output: { controlSchema: "./schemas/scan.schema.json" },
						},
						{
							id: "analyze",
							type: "foreach",
							from: { source: "scan", path: foreachPath },
							each: { prompt: "Analyze ${item}" },
						},
					],
				},
			});

		const good = await compileWorkflow(baseSpec("$.gapItems"), {
			cwd,
			task: "Analyze",
		});
		assert.equal(
			good.warnings.filter((w) => /foreach stage "analyze"/.test(w)).length,
			0,
			`unexpected foreach warning: ${JSON.stringify(good.warnings)}`,
		);

		const bad = await compileWorkflow(baseSpec("$.gapItemsTYPO"), {
			cwd,
			task: "Analyze",
		});
		assert.ok(
			bad.warnings.some(
				(w) => /foreach stage "analyze"/.test(w) && /gapItemsTYPO/.test(w),
			),
			`expected foreach path warning, got: ${JSON.stringify(bad.warnings)}`,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("partial foreach continues scheduling after an item failure", () => {
	assert.equal(
		shouldScheduleAfterStageFailure({
			id: "review",
			type: "foreach",
			sourcePolicy: "partial",
		}),
		true,
	);
	assert.equal(
		shouldScheduleAfterStageFailure({
			id: "review",
			type: "foreach",
			sourcePolicy: "require-success",
		}),
		false,
	);
	assert.equal(
		shouldScheduleAfterStageFailure({
			id: "report",
			type: "reduce",
			sourcePolicy: "partial",
		}),
		false,
	);
});

test("dependency-aware skip lets explicit partial sources bypass unrelated previous failures", () => {
	const previous = {
		id: "failed",
		type: "single",
		sourceStageIds: [],
		sourcePolicy: "require-success",
	};
	assert.equal(
		canStageProceedAfterPreviousFailure(
			{
				id: "next",
				type: "single",
				sourceStageIds: [],
				sourcePolicy: "require-success",
			},
			previous,
		),
		false,
	);
	assert.equal(
		canStageProceedAfterPreviousFailure(
			{
				id: "strict",
				type: "reduce",
				sourceStageIds: ["failed"],
				sourcePolicy: "require-success",
			},
			previous,
		),
		false,
	);
	assert.equal(
		canStageProceedAfterPreviousFailure(
			{
				id: "partial",
				type: "reduce",
				sourceStageIds: ["failed"],
				sourcePolicy: "partial",
			},
			previous,
		),
		true,
	);
	assert.equal(
		canStageProceedAfterPreviousFailure(
			{
				id: "unrelated",
				type: "reduce",
				sourceStageIds: ["ok"],
				sourcePolicy: "require-success",
			},
			previous,
		),
		true,
	);
});

test("compiler injects runtime task for single stages only", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const compiled = await compileWorkflow(
			workflowSpec("unit-scout", {
				roles: { lens: { prompt: "Role context marker." } },
				artifactGraph: {
					stages: [
						{ id: "entry", type: "single", prompt: "Entry instructions." },
						{
							id: "entry-extra",
							type: "single",
							prompt: "Entry extra instructions.",
						},
						{ id: "final", type: "reduce", prompt: "Final instructions." },
						{
							id: "final-extra",
							type: "reduce",
							from: "final",
							prompt: "Final extra instructions.",
						},
					],
				},
			}),
			{ cwd, task: "Review feature A" },
		);

		assert.equal(compiled.schemaVersion, 1);
		const byKey = Object.fromEntries(
			compiled.tasks.map((task) => [task.key, task]),
		);
		assert.match(
			byKey["entry.main"].compiledPrompt,
			/^# Task\n\nReview feature A\n\n# Workflow Stage/,
		);
		assert.equal(byKey["entry.main"].injectTask, true);
		assert.match(
			byKey["entry-extra.main"].compiledPrompt,
			/^# Task\n\nReview feature A\n\n# Workflow Stage/,
		);
		assert.equal(byKey["entry-extra.main"].injectTask, true);
		assert.doesNotMatch(byKey["final.main"].compiledPrompt, /# Task/);
		assert.equal(byKey["final.main"].injectTask, false);
		assert.doesNotMatch(byKey["final-extra.main"].compiledPrompt, /# Task/);
		assert.equal(byKey["final-extra.main"].injectTask, false);
		assert.match(
			byKey["entry.main"].compiledPrompt,
			/# Instructions\n\nEntry instructions\./,
		);
		assert.match(
			byKey["entry.main"].compiledPrompt,
			/# Role Context\n\n## Role: lens\nRole context marker\./,
		);
		assert.match(
			byKey["entry.main"].compiledPrompt,
			/# Role Context\n\n## Role: lens\nRole context marker\./,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("compiler omits runtime task injection from foreach templates", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const compiled = await compileWorkflow(
			workflowSpec("unit-scout", {
				artifactGraph: {
					stages: [
						{
							id: "extract",
							type: "single",
							prompt: "Extract",
						},
						{
							id: "verify",
							type: "foreach",
							from: { source: "extract", path: "$.claims" },
							each: { prompt: "Verify ${item}" },
						},
					],
				},
			}),
			{ cwd, task: "Check ${WORKSPACE} literally" },
		);

		assert.equal(compiled.task, "Check ${WORKSPACE} literally");
		assert.equal(compiled.tasks[1].injectTask, false);
		assert.deepEqual(compiled.tasks[1].dependsOn, ["extract.main"]);
		assert.doesNotMatch(compiled.tasks[1].compiledPrompt, /# Task/);
		assert.doesNotMatch(compiled.tasks[1].compiledPrompt, /WORKSPACE/);
		assert.match(
			compiled.tasks[1].compiledPrompt,
			/Verify the relevant item from the dependency context/,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("compiler injects runtime task into foreach and reduce stages that opt in", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const compiled = await compileWorkflow(
			workflowSpec("unit-scout", {
				artifactGraph: {
					stages: [
						{ id: "extract", type: "single", prompt: "Extract" },
						{
							id: "verify",
							type: "foreach",
							injectRuntimeTask: true,
							from: { source: "extract", path: "$.claims" },
							each: { prompt: "Verify ${item}" },
						},
						{
							id: "summary",
							type: "reduce",
							injectRuntimeTask: true,
							from: "verify",
							prompt: "Summarize",
						},
					],
				},
			}),
			{ cwd, task: "OPT_IN_CONSTRAINT_MARKER" },
		);
		const byStage = Object.fromEntries(
			compiled.tasks.map((task) => [task.stageId, task]),
		);
		// Opted-in foreach template carries the runtime task injection flag.
		assert.equal(byStage.verify.injectTask, true);
		assert.equal(byStage.verify.foreach.injectRuntimeTask, true);
		// Opted-in reduce stage embeds the runtime task body in its prompt.
		assert.equal(byStage.summary.injectTask, true);
		assert.match(
			byStage.summary.compiledPrompt,
			/# Task\n\nOPT_IN_CONSTRAINT_MARKER/,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("compiler applies explicit stage from dependencies and stage runtime defaults", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read, grep");
		const compiled = await compileWorkflow(
			workflowSpec("unit-scout", {
				model: "kimi-coding/kimi-for-coding",
				thinking: "high",
				tools: ["read", "grep"],
				defaults: { maxRuntimeMs: 12345 },
				artifactGraph: {
					stages: [
						{ id: "plan", type: "single", prompt: "Plan" },
						{
							id: "research",
							type: "foreach",
							from: { source: "plan", path: "$.questions" },
							each: { prompt: "Research ${item}" },
						},
						{
							id: "final",
							type: "reduce",
							from: ["plan", "research"],
							prompt: "Final",
						},
					],
				},
			}),
			{ cwd, task: "Research topic" },
		);

		const byKey = Object.fromEntries(
			compiled.tasks.map((task) => [task.key, task]),
		);
		assert.deepEqual(byKey["research.item"].dependsOn, ["plan.main"]);
		assert.deepEqual(byKey["final.main"].dependsOn, [
			"plan.main",
			"research.item",
		]);
		assert.equal(
			byKey["final.main"].runtime.model,
			"kimi-coding/kimi-for-coding",
		);
		assert.equal(byKey["final.main"].runtime.thinking, "high");
		assert.deepEqual(byKey["final.main"].runtime.tools, ["read", "grep"]);
		assert.equal(byKey["final.main"].runtime.maxRuntimeMs, 12345);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("compiler separates order-only after dependencies from source context", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const compiled = await compileWorkflow(
			workflowSpec("unit-scout", {
				artifactGraph: {
					stages: [
						{ id: "sourceOne", type: "single", prompt: "Source one." },
						{
							id: "sourceTwo",
							type: "single",
							after: [],
							prompt: "Source two.",
						},
						{ id: "gate", type: "single", prompt: "Gate." },
						{
							id: "mixed",
							type: "single",
							from: ["sourceOne", "sourceTwo"],
							after: "gate",
							prompt: "Mixed.",
						},
						{
							id: "fromOnly",
							type: "single",
							from: ["sourceOne", "sourceTwo"],
							prompt: "From only.",
						},
					],
				},
			}),
			{ cwd, task: "Check sources" },
		);

		const byKey = Object.fromEntries(
			compiled.tasks.map((task) => [task.key, task]),
		);
		assert.deepEqual(byKey["mixed.main"].dependsOn, [
			"sourceOne.main",
			"sourceTwo.main",
			"gate.main",
		]);
		assert.deepEqual(byKey["mixed.main"].contextDependsOn, [
			"sourceOne.main",
			"sourceTwo.main",
		]);
		assert.equal(byKey["fromOnly.main"].contextDependsOn, undefined);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("compiler treats empty after as an explicit parallel root", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const compiled = await compileWorkflow(
			workflowSpec("unit-scout", {
				artifactGraph: {
					stages: [
						{ id: "a", type: "single", prompt: "A." },
						{ id: "b", type: "single", after: [], prompt: "B." },
						{ id: "c", type: "single", from: ["a", "b"], prompt: "C." },
						{ id: "d", type: "single", prompt: "D." },
					],
				},
			}),
			{ cwd, task: "Check parallel roots" },
		);

		const byKey = Object.fromEntries(
			compiled.tasks.map((task) => [task.key, task]),
		);
		assert.deepEqual(byKey["b.main"].dependsOn, []);
		assert.deepEqual(byKey["c.main"].dependsOn, ["a.main", "b.main"]);
		assert.deepEqual(byKey["d.main"].dependsOn, ["c.main"]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("compiler lowers dag containers to namespaced child tasks", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const compiled = await compileWorkflow(
			workflowSpec("unit-scout", {
				artifactGraph: {
					stages: [
						{ id: "seedOne", type: "single", prompt: "Seed one." },
						{ id: "seedTwo", type: "single", after: [], prompt: "Seed two." },
						{ id: "gate", type: "single", prompt: "Gate." },
						{
							id: "box",
							type: "dag",
							from: ["seedOne", "seedTwo"],
							after: "gate",
							outputFrom: "d",
							stages: [
								{ id: "a", type: "single", prompt: "A." },
								{ id: "b", type: "single", after: "a", prompt: "B." },
								{ id: "c", type: "single", after: "a", prompt: "C." },
								{
									id: "d",
									type: "reduce",
									from: "b",
									after: "c",
									prompt: "D.",
								},
							],
						},
						{ id: "implicit", type: "single", prompt: "Implicit." },
						{ id: "down", type: "single", from: "box", prompt: "Down." },
					],
				},
			}),
			{ cwd, task: "Check dag" },
		);

		const byKey = Object.fromEntries(
			compiled.tasks.map((task) => [task.key, task]),
		);
		assert.deepEqual(
			compiled.tasks.map((task) => task.key),
			[
				"seedOne.main",
				"seedTwo.main",
				"gate.main",
				"box.a.main",
				"box.b.main",
				"box.c.main",
				"box.d.main",
				"implicit.main",
				"down.main",
			],
		);
		assert.deepEqual(
			compiled.stages
				.filter((stage) => String(stage.id).startsWith("box"))
				.map((stage) => stage.id),
			["box.a", "box.b", "box.c", "box.d"],
		);
		assert.deepEqual(byKey["box.a.main"].dependsOn, [
			"seedOne.main",
			"seedTwo.main",
			"gate.main",
		]);
		assert.deepEqual(byKey["box.a.main"].contextDependsOn, [
			"seedOne.main",
			"seedTwo.main",
		]);
		assert.deepEqual(byKey["box.b.main"].dependsOn, ["box.a.main"]);
		assert.deepEqual(byKey["box.b.main"].contextDependsOn, []);
		assert.deepEqual(byKey["box.d.main"].dependsOn, [
			"box.b.main",
			"box.c.main",
		]);
		assert.deepEqual(byKey["box.d.main"].contextDependsOn, ["box.b.main"]);
		assert.deepEqual(byKey["implicit.main"].dependsOn, ["box.d.main"]);
		assert.deepEqual(byKey["down.main"].dependsOn, ["box.d.main"]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("compiler lowers foreach and support children inside dag containers", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const compiled = await compileWorkflow(
			workflowSpec("unit-scout", {
				artifactGraph: {
					stages: [
						{
							id: "fan",
							type: "dag",
							sourcePolicy: "partial",
							maxConcurrency: 2,
							outputFrom: "audit",
							stages: [
								{
									id: "source",
									type: "single",
									output: { format: "json" },
									prompt: "Source.",
								},
								{
									id: "verify",
									type: "foreach",
									from: { source: "source", path: "$.items" },
									each: { prompt: "Verify ${item}." },
								},
								{
									id: "audit",
									from: "verify",
									support: { uses: "./helpers/audit.mjs" },
								},
							],
						},
					],
				},
			}),
			{ cwd, task: "Check fanout" },
		);

		const byKey = Object.fromEntries(
			compiled.tasks.map((task) => [task.key, task]),
		);
		assert.deepEqual(byKey["fan.verify.item"].dependsOn, ["fan.source.main"]);
		assert.deepEqual(byKey["fan.verify.item"].foreach.from, {
			stage: "fan.source",
			path: "$.items",
		});
		assert.equal(byKey["fan.verify.item"].stageMaxConcurrency, 2);
		assert.equal(
			compiled.stages.find((stage) => stage.id === "fan.verify").sourcePolicy,
			"partial",
		);
		assert.equal(byKey["fan.audit.main"].agent, "support");
		assert.equal(byKey["fan.audit.main"].stageMaxConcurrency, 2);
		assert.deepEqual(byKey["fan.audit.main"].dependsOn, ["fan.verify.item"]);
		assert.deepEqual(byKey["fan.audit.main"].support, {
			uses: "./helpers/audit.mjs",
			options: undefined,
		});
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("compiler lowers nested dag containers with composed namespaces", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const compiled = await compileWorkflow(
			workflowSpec("unit-scout", {
				artifactGraph: {
					stages: [
						{
							id: "outer",
							type: "dag",
							outputFrom: "inner",
							stages: [
								{ id: "root", type: "single", prompt: "Root." },
								{
									id: "inner",
									type: "dag",
									from: "root",
									stages: [{ id: "leaf", type: "single", prompt: "Leaf." }],
								},
							],
						},
						{ id: "next", type: "single", from: "outer", prompt: "Next." },
					],
				},
			}),
			{ cwd, task: "Check nested" },
		);

		const byKey = Object.fromEntries(
			compiled.tasks.map((task) => [task.key, task]),
		);
		assert.deepEqual(Object.keys(byKey), [
			"outer.root.main",
			"outer.inner.leaf.main",
			"next.main",
		]);
		assert.deepEqual(byKey["outer.inner.leaf.main"].dependsOn, [
			"outer.root.main",
		]);
		assert.deepEqual(byKey["next.main"].dependsOn, ["outer.inner.leaf.main"]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("compiler keeps dag namespace prefixes distinct from loop ids", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const compiled = await compileWorkflow(
			workflowSpec("unit-scout", {
				artifactGraph: {
					stages: [
						{
							id: "box",
							type: "loop",
							stages: [
								{ id: "implement", type: "single", prompt: "Implement." },
								{ id: "check", type: "single", prompt: "Check." },
							],
							maxRounds: 1,
							until: { stage: "check", path: "$.status", equals: "pass" },
						},
						{
							id: "boxcar",
							type: "dag",
							stages: [
								{ id: "r01", type: "single", prompt: "Looks loop-like." },
								{ id: "done", type: "single", from: "r01", prompt: "Done." },
							],
						},
					],
				},
			}),
			{ cwd, task: "Check prefixes" },
		);

		assert.equal(
			compiled.stages.find((stage) => stage.id === "box").type,
			"loop",
		);
		assert(compiled.tasks.some((task) => task.key === "box.loop"));
		assert(compiled.tasks.some((task) => task.key === "boxcar.r01.main"));
		assert.equal(
			compiled.tasks.find((task) => task.key === "boxcar.r01.main").loopChild,
			undefined,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("schema accepts object-form tools and rejects invalid tool objects", () => {
	parseWorkflow(
		workflowSpec("unit-scout", {
			tools: [
				"read",
				{
					name: "scrapling_fetch",
					extensions: ["packages/pi-scrapling-access"],
					classification: "read-only",
					optional: true,
					fallbackTools: ["fetch_content"],
				},
			],
		}),
	);

	const missingName = assertThrowsFlow(() =>
		parseWorkflow(
			workflowSpec("unit-scout", { tools: [{ extensions: ["pkg"] }] }),
		),
	);
	assertIssue(
		missingName,
		"$.defaults.tools[0]",
		"must be a tool name string or object with a name",
	);

	const invalid = assertThrowsFlow(() =>
		parseWorkflow(
			workflowSpec("unit-scout", {
				tools: [
					"read",
					{ name: "bad tool" },
					{ name: "custom_class", classification: "side-effect" },
					{ name: "custom_ext", extensions: "pkg" },
					{ name: "custom_fallback", fallbackTools: ["bad tool"] },
				],
			}),
		),
	);
	assertIssue(invalid, "$.defaults.tools[1].name", "invalid tool name");
	assertIssue(invalid, "$.defaults.tools[2].classification", "must be one of");
	assertIssue(invalid, "$.defaults.tools[3].extensions", "must be an array");
	assertIssue(
		invalid,
		"$.defaults.tools[4].fallbackTools[0]",
		"invalid tool name",
	);
});

test("compiler normalizes object-form tools and treats classified custom read-only tools as safe", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read, fetch_content, scrapling_fetch");
		const compiled = await compileWorkflow(
			workflowSpec("unit-scout", {
				tools: [
					"read",
					"fetch_content",
					{
						name: "scrapling_fetch",
						extensions: ["packages/pi-scrapling-access"],
						classification: "read-only",
						optional: true,
						fallbackTools: ["fetch_content"],
					},
				],
			}),
			{ cwd, task: "Fetch safely" },
		);

		const task = compiled.tasks[0];
		assert.deepEqual(task.runtime.tools, [
			"read",
			"fetch_content",
			"scrapling_fetch",
		]);
		assert.deepEqual(task.runtime.toolProviders, {
			scrapling_fetch: {
				extensions: ["packages/pi-scrapling-access"],
				classification: "read-only",
				optional: true,
				fallbackTools: ["fetch_content"],
			},
		});
		assert.equal(task.safety.capability, "read-only");
		assert.equal(task.safety.permission.status, "pending");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("compiler keeps unclassified custom tools blocked for explicit review", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read, custom_external_tool");
		const compiled = await compileWorkflow(
			workflowSpec("unit-scout", {
				tools: ["read", "custom_external_tool"],
			}),
			{ cwd, task: "Check custom tool" },
		);

		assert.equal(compiled.tasks[0].safety.permission.status, "blocked");
		assert.equal(
			compiled.tasks[0].safety.permission.reason,
			"unknown/custom tools require explicit review: custom_external_tool",
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("object-form tools cannot expand beyond agent-declared tool ceilings", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		await assert.rejects(
			() =>
				compileWorkflow(
					workflowSpec("unit-scout", {
						tools: [{ name: "scrapling_fetch", classification: "read-only" }],
					}),
					{ cwd, task: "Fetch" },
				),
			(error) => {
				assert(error instanceof WorkflowValidationError);
				assertIssue(error, "$.defaults.tools", "expands agent");
				return true;
			},
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("narrow tool scopes inherit metadata for strings and override it for objects", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read, scrapling_fetch");
		const compiled = await compileWorkflow(
			workflowSpec("unit-scout", {
				tools: [
					"read",
					{
						name: "scrapling_fetch",
						extensions: ["packages/base-provider"],
						classification: "mutation-capable",
						optional: true,
					},
				],
				artifactGraph: {
					stages: [
						{
							id: "inherit",
							type: "single",
							tools: ["scrapling_fetch"],
							prompt: "Inherit metadata.",
						},
						{
							id: "override",
							type: "single",
							tools: [
								{
									name: "scrapling_fetch",
									extensions: ["packages/stage-provider"],
									classification: "read-only",
								},
							],
							prompt: "Override metadata.",
						},
					],
				},
			}),
			{ cwd, task: "Fetch" },
		);

		const byKey = Object.fromEntries(
			compiled.tasks.map((task) => [task.key, task]),
		);
		assert.deepEqual(byKey["inherit.main"].runtime.tools, ["scrapling_fetch"]);
		assert.deepEqual(byKey["inherit.main"].runtime.toolProviders, {
			scrapling_fetch: {
				extensions: ["packages/base-provider"],
				classification: "mutation-capable",
				optional: true,
			},
		});
		assert.deepEqual(byKey["override.main"].runtime.toolProviders, {
			scrapling_fetch: {
				extensions: ["packages/stage-provider"],
				classification: "read-only",
				optional: true,
			},
		});
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("tool metadata cannot downgrade known mutating tools", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read, bash");
		const compiled = await compileWorkflow(
			workflowSpec("unit-scout", {
				tools: ["read", { name: "bash", classification: "read-only" }],
			}),
			{ cwd, task: "Inspect" },
		);

		assert.equal(compiled.tasks[0].safety.capability, "mutation-capable");
		assert.equal(compiled.tasks[0].safety.permission.reason, undefined);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("compiler rejects delegation tools on dynamic stage metadata before filtering", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read, workflow");
		await assert.rejects(
			() =>
				compileWorkflow(
					artifactGraphWorkflowSpec({
						defaults: {
							agent: "unit-scout",
							readOnly: true,
							tools: ["read", "workflow"],
						},
						artifactGraph: {
							stages: [
								{
									id: "adaptive",
									type: "dynamic",
									dynamic: { uses: "./helpers/controller.mjs" },
								},
							],
						},
					}),
					{ cwd, task: "Reject delegation tool." },
				),
			(error) => {
				assert(error instanceof WorkflowValidationError);
				assertIssue(error, "$.defaults.tools", "delegation/orchestration tool");
				return true;
			},
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("dynamic controllers expose a deterministic available tool view", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			[
				"export default async function controller(ctx) {",
				"  return { control: { schema: 'dynamic-controller-result-v1', summary: 'tools', tools: ctx.tools.available() }, analysis: 'done', refs: [] };",
				"}",
			].join("\n"),
		);
		const spec = artifactGraphWorkflowSpec({
			defaults: {
				agent: "unit-scout",
				readOnly: true,
				tools: [
					"read",
					{
						name: "custom_external_tool",
						classification: "read-only",
						extensions: ["unit-provider"],
					},
					{ name: "bash", classification: "read-only" },
				],
			},
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: { uses: "./helpers/controller.mjs" },
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Show tools.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		const updated = await readRunRecord(cwd, run.runId);
		const control = JSON.parse(
			readFileSync(
				join(
					dirname(
						join(cwd, taskBySpec(updated, "adaptive.controller").files.result),
					),
					"control.json",
				),
				"utf8",
			),
		);
		const byName = Object.fromEntries(
			control.tools.map((tool) => [tool.name, tool]),
		);
		assert.equal(byName.custom_external_tool.classification, "read-only");
		assert.deepEqual(byName.custom_external_tool.extensions, ["unit-provider"]);
		assert.equal(byName.bash.classification, "mutation-capable");
		assert.equal(byName.bash.floor, "mutation-capable");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("dynamic generated tasks propagate toolProviders and enforce tool ceilings", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read, custom_external_tool");
		captureSubagentPrompts([]);
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			[
				"export default async function controller(ctx) {",
				"  await ctx.agent({ id: 'custom', agent: 'unit-scout', tools: ['custom_external_tool'], prompt: 'Use custom tool.' });",
				"  return { control: { schema: 'dynamic-controller-result-v1', summary: 'done' }, analysis: 'done', refs: [] };",
				"}",
			].join("\n"),
		);
		const spec = artifactGraphWorkflowSpec({
			defaults: {
				agent: "unit-scout",
				readOnly: true,
				tools: [
					"read",
					{
						name: "custom_external_tool",
						classification: "read-only",
						extensions: ["unit-provider"],
					},
				],
			},
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: { uses: "./helpers/controller.mjs" },
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Generate custom task.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		const updated = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(updated, "adaptive.custom").status, "running");
		const compiledAfterSplice = JSON.parse(
			readFileSync(
				join(cwd, ".pi", "workflows", run.runId, "compiled.json"),
				"utf8",
			),
		);
		const generated = compiledAfterSplice.tasks.find(
			(task) => task.id === "adaptive.custom",
		);
		assert.deepEqual(generated.runtime.tools, ["custom_external_tool"]);
		assert.deepEqual(generated.runtime.toolProviders, {
			custom_external_tool: {
				classification: "read-only",
				extensions: ["unit-provider"],
			},
		});
		assert.equal(generated.safety.capability, "read-only");
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("dynamic generated tasks reject explicit tools for agents without ceilings", async () => {
	const cwd = makeProject();
	try {
		const agentDir = join(cwd, ".pi", "agents");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "no-ceiling.md"),
			"---\ndescription: no-ceiling\nreadOnly: true\n---\n# no-ceiling\n",
		);
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			[
				"export default async function controller(ctx) {",
				"  await ctx.agent({ id: 'bad', agent: 'no-ceiling', tools: ['read'], prompt: 'Bad.' });",
				"  return { control: { schema: 'dynamic-controller-result-v1', summary: 'bad' }, analysis: 'bad', refs: [] };",
				"}",
			].join("\n"),
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: { uses: "./helpers/controller.mjs" },
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Reject missing ceiling.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		const updated = await readRunRecord(cwd, run.runId);
		const controller = taskBySpec(updated, "adaptive.controller");
		assert.equal(controller.status, "failed");
		assert.equal(controller.statusDetail, "dynamic_failed");
		assert.match(
			controller.lastMessage,
			/does not declare a tools authority ceiling/,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("dynamic generated tasks reject delegation tools on target agents", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read, workflow");
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			[
				"export default async function controller(ctx) {",
				"  await ctx.agent({ id: 'bad', agent: 'unit-scout', tools: ['workflow'], prompt: 'Bad.' });",
				"  return { control: { schema: 'dynamic-controller-result-v1', summary: 'bad' }, analysis: 'bad', refs: [] };",
				"}",
			].join("\n"),
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: { uses: "./helpers/controller.mjs" },
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Reject delegation tool.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		const updated = await readRunRecord(cwd, run.runId);
		const controller = taskBySpec(updated, "adaptive.controller");
		assert.equal(controller.status, "failed");
		assert.match(
			controller.lastMessage,
			/invalid delegation\/orchestration tools: workflow/,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("dynamic generated tasks reject maxSubagentDepth on target agents", async () => {
	const cwd = makeProject();
	try {
		const agentDir = join(cwd, ".pi", "agents");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "nested-agent.md"),
			'---\ndescription: nested-agent\ntools: ["read"]\nmaxSubagentDepth: 1\nreadOnly: true\n---\n# nested-agent\n',
		);
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			[
				"export default async function controller(ctx) {",
				"  await ctx.agent({ id: 'bad', agent: 'nested-agent', tools: ['read'], prompt: 'Bad.' });",
				"  return { control: { schema: 'dynamic-controller-result-v1', summary: 'bad' }, analysis: 'bad', refs: [] };",
				"}",
			].join("\n"),
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: { uses: "./helpers/controller.mjs" },
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Reject nested agent.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		const updated = await readRunRecord(cwd, run.runId);
		const controller = taskBySpec(updated, "adaptive.controller");
		assert.equal(controller.status, "failed");
		assert.match(controller.lastMessage, /maxSubagentDepth > 0/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph runtime foreach materializes source array into generated tasks", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const spec = workflowSpec("unit-scout", {
			artifactGraph: {
				stages: [
					{
						id: "extract",
						type: "single",
						prompt: "Extract",
					},
					{
						id: "verify",
						type: "foreach",
						from: { source: "extract", path: "$.claims" },
						maxConcurrency: 2,
						each: { prompt: "Verify ${item}" },
					},
					{
						id: "summary",
						type: "reduce",
						from: "verify",
						prompt: "Summarize",
					},
				],
			},
		});
		const compiled = await compileWorkflow(spec, { cwd, task: "Check claims" });
		const { run } = await createWorkflowRunRecord(
			cwd,
			compiled,
			join(cwd, "workflows", "unit.json"),
		);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);

		await completeTask(cwd, run.tasks[0], {
			claims: [{ id: "CLAIM_A", text: "A" }, "plain claim"],
		});
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		const materialized = await readRunRecord(cwd, run.runId);
		const specIds = materialized.tasks.map((task) => task.specId);
		assert.deepEqual(specIds, [
			"extract.main",
			"verify.claim_a",
			"verify.item-002",
			"summary.main",
		]);
		assert.equal(
			materialized.tasks.find((task) => task.specId === "verify.claim_a")
				?.status,
			"pending",
		);
		assert.equal(
			materialized.tasks.find((task) => task.specId === "verify.item-002")
				?.status,
			"pending",
		);
		assert.deepEqual(
			JSON.parse(
				readFileSync(
					join(cwd, ".pi", "workflows", materialized.runId, "compiled.json"),
					"utf8",
				),
			).tasks.find((task) => task.id === "summary.main").dependsOn,
			["verify.claim_a", "verify.item-002"],
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph runtime foreach materializes items from a dag container output", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const spec = workflowSpec("unit-scout", {
			artifactGraph: {
				stages: [
					{
						id: "analysis",
						type: "dag",
						outputFrom: "source",
						stages: [
							{
								id: "source",
								type: "single",
								output: { format: "json" },
								prompt: "Source.",
							},
						],
					},
					{
						id: "verify",
						type: "foreach",
						from: { source: "analysis", path: "$.items" },
						each: { prompt: "Verify ${item}." },
					},
					{
						id: "summary",
						type: "reduce",
						from: "verify",
						prompt: "Summarize.",
					},
				],
			},
		});
		const compiled = await compileWorkflow(spec, { cwd, task: "Check items" });
		assert.deepEqual(
			compiled.tasks.find((task) => task.id === "verify.item")?.foreach.from,
			{ stage: "analysis.source", path: "$.items" },
		);
		const { run } = await createWorkflowRunRecord(
			cwd,
			compiled,
			join(cwd, "workflows", "unit.json"),
		);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);

		await completeTask(cwd, run.tasks[0], {
			items: [
				{ id: "ITEM_A", text: "A" },
				{ id: "ITEM_B", text: "B" },
			],
		});
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		const materialized = await readRunRecord(cwd, run.runId);
		assert.deepEqual(
			materialized.tasks.map((task) => task.specId),
			[
				"analysis.source.main",
				"verify.item_a",
				"verify.item_b",
				"summary.main",
			],
		);
		assert.deepEqual(
			JSON.parse(
				readFileSync(
					join(cwd, ".pi", "workflows", materialized.runId, "compiled.json"),
					"utf8",
				),
			).tasks.find((task) => task.id === "summary.main").dependsOn,
			["verify.item_a", "verify.item_b"],
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("successive foreach materialization keeps task ids unique", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const spec = workflowSpec("unit-scout", {
			artifactGraph: {
				stages: [
					{
						id: "extract",
						type: "single",
						prompt: "Extract",
					},
					{
						id: "review",
						type: "foreach",
						from: { source: "extract", path: "$.claims" },
						each: { prompt: "Review ${item}" },
					},
					{
						id: "verify",
						type: "foreach",
						from: { source: "review", path: "$.findings" },
						each: { prompt: "Verify ${item}" },
					},
				],
			},
		});
		const compiled = await compileWorkflow(spec, { cwd, task: "Check claims" });
		const { run } = await createWorkflowRunRecord(
			cwd,
			compiled,
			join(cwd, "workflows", "unit.json"),
		);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await completeTask(cwd, run.tasks[0], { claims: ["a", "b"] });
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		let current = await readRunRecord(cwd, run.runId);
		for (const task of current.tasks.filter(
			(item) => item.stageId === "review",
		)) {
			await completeTask(cwd, task, {
				findings: [{ title: `${task.specId}-finding` }],
			});
		}
		await writeRunRecord(cwd, current);

		await scheduleRun(cwd, run.runId);
		current = await readRunRecord(cwd, run.runId);
		const taskIds = current.tasks.map((task) => task.taskId);
		assert.equal(new Set(taskIds).size, taskIds.length);
		assert.deepEqual(
			current.tasks
				.filter((task) => task.stageId === "verify")
				.map((task) => task.specId),
			["verify.item-001", "verify.item-002"],
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph runtime foreach blocks when maxItems is exceeded", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const spec = workflowSpec("unit-scout", {
			artifactGraph: {
				stages: [
					{
						id: "extract",
						type: "single",
						prompt: "Extract",
					},
					{
						id: "verify",
						type: "foreach",
						from: { source: "extract", path: "$.claims" },
						maxItems: 1,
						each: { prompt: "Verify ${item}" },
					},
				],
			},
		});
		const compiled = await compileWorkflow(spec, { cwd, task: "Check claims" });
		const { run } = await createWorkflowRunRecord(
			cwd,
			compiled,
			join(cwd, "workflows", "unit.json"),
		);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await completeTask(cwd, run.tasks[0], { claims: ["a", "b"] });
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		const blocked = await readRunRecord(cwd, run.runId);
		assert.equal(blocked.tasks[1].status, "blocked");
		assert.match(blocked.tasks[1].lastMessage, /exceeding maxItems=1/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifact graph schema rejects dynamic loop children", () => {
	const error = assertThrowsFlow(() =>
		parsePublicWorkflow(
			artifactGraphWorkflowSpec({
				artifactGraph: {
					stages: [
						{
							id: "iterate",
							type: "loop",
							maxRounds: 2,
							stages: [
								{
									id: "adaptive",
									type: "dynamic",
									dynamic: { uses: "./helpers/controller.mjs" },
								},
							],
						},
					],
				},
			}),
		),
	);
	assertIssue(
		error,
		"$.artifactGraph.stages[0].stages[0].type",
		"loop child stages must be single or reduce stages",
	);
});

test("loop compiles to a loop stage record with no premature child tasks", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const compiled = await compileWorkflow(loopWorkflowSpec(), {
			cwd,
			task: "Fix failures",
		});
		const loopStage = compiled.stages.find((stage) => stage.id === "fix-loop");
		assert.equal(loopStage.type, "loop");
		assert.equal(loopStage.maxRounds, 5);
		assert.deepEqual(loopStage.childStageIds, ["implement", "check"]);
		assert.equal(loopStage.childTemplates.length, 2);
		assert.equal(loopStage.childTemplates[0].artifactGraph?.enabled, true);
		assert.equal(loopStage.childTemplates[1].artifactGraph?.enabled, true);
		assert.match(
			loopStage.childTemplates[1].compiledPrompt,
			/Workflow Output Protocol/,
		);
		assert.deepEqual(
			compiled.tasks.map((task) => task.specId),
			["fix-loop.loop"],
		);
		assert.equal(compiled.tasks.filter((task) => task.loopChild).length, 0);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("loop round 1 materializes child tasks with deterministic ids", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const { run } = await createLoopRun(cwd);

		await scheduleRun(cwd, run.runId);
		const materialized = await readRunRecord(cwd, run.runId);
		assert.deepEqual(
			materialized.tasks.map((task) => task.specId),
			["fix-loop.loop", "fix-loop.r01.implement", "fix-loop.r01.check"],
		);
		assert.deepEqual(
			taskBySpec(materialized, "fix-loop.r01.implement").dependsOn ?? [],
			[],
		);
		assert.deepEqual(taskBySpec(materialized, "fix-loop.r01.check").dependsOn, [
			"fix-loop.r01.implement",
		]);
		assert.equal(
			taskBySpec(materialized, "fix-loop.r01.implement").artifactGraph?.enabled,
			true,
		);
		assert.equal(
			taskBySpec(materialized, "fix-loop.r01.check").artifactGraph?.enabled,
			true,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("loop resume reconciliation backfills missing run records for compiled round tasks", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const loopStage = loopWorkflowSpec().artifactGraph.stages[0];
		const spec = workflowSpec("unit-scout", {
			artifactGraph: {
				stages: [
					loopStage,
					{ id: "after", type: "single", prompt: "After loop." },
				],
			},
		});
		const { run } = await createLoopRun(cwd, spec);
		await scheduleRun(cwd, run.runId);
		let current = await readRunRecord(cwd, run.runId);
		assert.deepEqual(
			current.tasks.map((task) => task.specId),
			[
				"fix-loop.loop",
				"fix-loop.r01.implement",
				"fix-loop.r01.check",
				"after.main",
			],
		);

		current.tasks = current.tasks.filter(
			(task) => !task.specId.startsWith("fix-loop.r01."),
		);
		await writeRunRecord(cwd, current);

		await scheduleRun(cwd, run.runId);
		current = await readRunRecord(cwd, run.runId);
		assert.deepEqual(
			current.tasks.map((task) => task.specId),
			[
				"fix-loop.loop",
				"fix-loop.r01.implement",
				"fix-loop.r01.check",
				"after.main",
			],
		);
		assert.equal(
			current.tasks.filter((task) => task.specId === "fix-loop.r01.implement")
				.length,
			1,
		);
		assert.equal(
			current.tasks.filter((task) => task.specId === "fix-loop.r01.check")
				.length,
			1,
		);

		await completeTask(cwd, taskBySpec(current, "fix-loop.r01.implement"), {
			changed: true,
		});
		await completeTask(cwd, taskBySpec(current, "fix-loop.r01.check"), {
			status: "pass",
			verdict: "ACCEPT",
			blockingFailures: [],
		});
		await writeRunRecord(cwd, current);
		await scheduleRun(cwd, run.runId);
		current = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(current, "fix-loop.loop").status, "completed");
		assert.equal(current.loopResults[0].status, "completed");
		assert.equal(taskBySpec(current, "after.main").status, "pending");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph runtime scheduler fails closed on compiled run positional mismatch", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const spec = workflowSpec("unit-scout", {
			artifactGraph: {
				stages: [
					{ id: "one", type: "single", prompt: "One." },
					{ id: "two", type: "single", prompt: "Two." },
				],
			},
		});
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Check alignment",
		});
		const { run } = await createWorkflowRunRecord(
			cwd,
			compiled,
			join(cwd, "workflows", "alignment.json"),
		);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		run.tasks = [run.tasks[1], run.tasks[0]];
		await writeRunRecord(cwd, run);

		await assert.rejects(
			() => scheduleRun(cwd, run.runId),
			/materialization is misaligned/,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("loop until satisfied after a round marks loop completed and stops materializing", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const { run } = await createLoopRun(cwd);
		await scheduleRun(cwd, run.runId);
		let current = await readRunRecord(cwd, run.runId);
		await completeTask(cwd, taskBySpec(current, "fix-loop.r01.implement"), {
			changed: true,
		});
		await completeTask(cwd, taskBySpec(current, "fix-loop.r01.check"), {
			status: "pass",
			verdict: "ACCEPT",
			blockingFailures: [],
		});
		await writeRunRecord(cwd, current);

		await scheduleRun(cwd, run.runId);
		current = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(current, "fix-loop.loop").status, "completed");
		assert.equal(current.loopResults[0].status, "completed");
		assert.equal(current.loopResults[0].roundsUsed, 1);
		assert.deepEqual(current.loopResults[0].finalCheck, {
			schema: "stage-control-v1",
			digest: "fix-loop.r01.check completed",
			status: "pass",
			verdict: "ACCEPT",
			blockingFailures: [],
		});
		assert.equal(
			current.tasks.some((task) => task.specId.includes(".r02.")),
			false,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("loop until unmet materializes round 2 with unique ids and carry-forward context", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const { run } = await createLoopRun(cwd);
		await scheduleRun(cwd, run.runId);
		let current = await readRunRecord(cwd, run.runId);
		await completeTask(cwd, taskBySpec(current, "fix-loop.r01.implement"), {
			changed: true,
		});
		await completeTask(cwd, taskBySpec(current, "fix-loop.r01.check"), {
			status: "fail",
			verdict: "REJECT",
			blockingFailures: ["a", "b"],
		});
		await writeRunRecord(cwd, current);

		await scheduleRun(cwd, run.runId);
		current = await readRunRecord(cwd, run.runId);
		const specIds = current.tasks.map((task) => task.specId);
		assert.equal(new Set(specIds).size, specIds.length);
		assert(specIds.includes("fix-loop.r02.implement"));
		assert(specIds.includes("fix-loop.r02.check"));
		assert.deepEqual(taskBySpec(current, "fix-loop.r02.implement").dependsOn, [
			"fix-loop.r01.implement",
			"fix-loop.r01.check",
		]);

		const compiledAfterRound2 = JSON.parse(
			readFileSync(
				join(cwd, ".pi", "workflows", current.runId, "compiled.json"),
				"utf8",
			),
		);
		const round2Implement = compiledAfterRound2.tasks.find(
			(task) => task.id === "fix-loop.r02.implement",
		);
		assert.match(
			round2Implement.compiledPrompt,
			/# Loop Carry-Forward Context/,
		);
		assert.match(
			round2Implement.compiledPrompt,
			/"blockingFailures":\["a","b"\]/,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("loop no-progress stops early with stopped_no_progress", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const { run } = await createLoopRun(cwd);
		await scheduleRun(cwd, run.runId);
		let current = await readRunRecord(cwd, run.runId);
		await completeTask(cwd, taskBySpec(current, "fix-loop.r01.implement"), {
			changed: true,
		});
		await completeTask(cwd, taskBySpec(current, "fix-loop.r01.check"), {
			status: "fail",
			verdict: "REJECT",
			blockingFailures: ["a", "b"],
		});
		await writeRunRecord(cwd, current);
		await scheduleRun(cwd, run.runId);

		current = await readRunRecord(cwd, run.runId);
		await completeTask(cwd, taskBySpec(current, "fix-loop.r02.implement"), {
			changed: true,
		});
		await completeTask(cwd, taskBySpec(current, "fix-loop.r02.check"), {
			status: "fail",
			verdict: "REJECT",
			blockingFailures: ["a", "b"],
		});
		await writeRunRecord(cwd, current);
		await scheduleRun(cwd, run.runId);

		current = await readRunRecord(cwd, run.runId);
		assert.equal(current.loopResults[0].status, "stopped_no_progress");
		assert.equal(current.loopResults[0].roundsUsed, 2);
		assert.equal(
			current.tasks.some((task) => task.specId.includes(".r03.")),
			false,
		);
		assert.equal(
			taskBySpec(current, "fix-loop.loop").statusDetail,
			"loop_stopped_no_progress",
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("loop invalid progressPath value records a warning", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const { run } = await createLoopRun(
			cwd,
			loopWorkflowSpec({ progressPath: "$.passing" }),
		);
		await scheduleRun(cwd, run.runId);
		let current = await readRunRecord(cwd, run.runId);
		await completeTask(cwd, taskBySpec(current, "fix-loop.r01.implement"), {
			changed: true,
		});
		await completeTask(cwd, taskBySpec(current, "fix-loop.r01.check"), {
			status: "fail",
			verdict: "REJECT",
			passing: false,
		});
		await writeRunRecord(cwd, current);
		await scheduleRun(cwd, run.runId);

		current = await readRunRecord(cwd, run.runId);
		await completeTask(cwd, taskBySpec(current, "fix-loop.r02.implement"), {
			changed: true,
		});
		await completeTask(cwd, taskBySpec(current, "fix-loop.r02.check"), {
			status: "fail",
			verdict: "REJECT",
			passing: false,
		});
		await writeRunRecord(cwd, current);
		await scheduleRun(cwd, run.runId);

		current = await readRunRecord(cwd, run.runId);
		assert.match(
			taskBySpec(current, "fix-loop.r02.check").lastMessage ?? "",
			/progressPath \$\.passing resolved to unsupported boolean/,
		);
		assert.equal(
			current.tasks.some((task) => task.specId.includes(".r03.")),
			true,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("loop explicit missing progressPath records a warning", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const { run } = await createLoopRun(
			cwd,
			loopWorkflowSpec({ progressPath: "$.missingProgress" }),
		);
		await scheduleRun(cwd, run.runId);
		let current = await readRunRecord(cwd, run.runId);
		await completeTask(cwd, taskBySpec(current, "fix-loop.r01.implement"), {
			changed: true,
		});
		await completeTask(cwd, taskBySpec(current, "fix-loop.r01.check"), {
			status: "fail",
			verdict: "REJECT",
			blockingFailures: ["a"],
		});
		await writeRunRecord(cwd, current);
		await scheduleRun(cwd, run.runId);

		current = await readRunRecord(cwd, run.runId);
		await completeTask(cwd, taskBySpec(current, "fix-loop.r02.implement"), {
			changed: true,
		});
		await completeTask(cwd, taskBySpec(current, "fix-loop.r02.check"), {
			status: "fail",
			verdict: "REJECT",
			blockingFailures: ["a"],
		});
		await writeRunRecord(cwd, current);
		await scheduleRun(cwd, run.runId);

		current = await readRunRecord(cwd, run.runId);
		assert.match(
			taskBySpec(current, "fix-loop.r02.check").lastMessage ?? "",
			/progressPath \$\.missingProgress resolved to unsupported undefined/,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("loop maxRounds exhaustion materializes and waits for onExhausted", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const spec = loopWorkflowSpec({
			maxRounds: 1,
			onExhausted: {
				id: "loop-summary",
				type: "reduce",
				prompt: "Summarize remaining failures.",
			},
		});
		const { run } = await createLoopRun(cwd, spec);
		await scheduleRun(cwd, run.runId);
		let current = await readRunRecord(cwd, run.runId);
		await completeTask(cwd, taskBySpec(current, "fix-loop.r01.implement"), {
			changed: true,
		});
		await completeTask(cwd, taskBySpec(current, "fix-loop.r01.check"), {
			status: "fail",
			verdict: "REJECT",
			blockingFailures: ["still failing"],
		});
		await writeRunRecord(cwd, current);

		await scheduleRun(cwd, run.runId);
		current = await readRunRecord(cwd, run.runId);
		const exhausted = taskBySpec(current, "fix-loop.onExhausted.loop-summary");
		assert.equal(exhausted.status, "pending");
		assert.equal(taskBySpec(current, "fix-loop.loop").status, "pending");

		await completeTask(cwd, exhausted, { summary: "human follow-up needed" });
		await writeRunRecord(cwd, current);
		await scheduleRun(cwd, run.runId);
		current = await readRunRecord(cwd, run.runId);
		assert.equal(current.loopResults[0].status, "exhausted");
		assert.equal(current.loopResults[0].roundsUsed, 1);
		assert.equal(taskBySpec(current, "fix-loop.loop").status, "completed");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("loop onExhausted context includes bounded prior round check outputs", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const spec = loopWorkflowSpec({
			maxRounds: 2,
			onExhausted: {
				id: "loop-summary",
				type: "reduce",
				prompt: "Summarize each round.",
			},
		});
		const { run } = await createLoopRun(cwd, spec);
		await scheduleRun(cwd, run.runId);
		let current = await readRunRecord(cwd, run.runId);
		await completeTask(cwd, taskBySpec(current, "fix-loop.r01.implement"), {
			changed: true,
		});
		await completeTask(cwd, taskBySpec(current, "fix-loop.r01.check"), {
			status: "fail",
			verdict: "REJECT",
			blockingFailures: ["a", "b"],
		});
		await writeRunRecord(cwd, current);

		await scheduleRun(cwd, run.runId);
		current = await readRunRecord(cwd, run.runId);
		await completeTask(cwd, taskBySpec(current, "fix-loop.r02.implement"), {
			changed: true,
		});
		await completeTask(cwd, taskBySpec(current, "fix-loop.r02.check"), {
			status: "fail",
			verdict: "REJECT",
			blockingFailures: ["a"],
		});
		await writeRunRecord(cwd, current);

		await scheduleRun(cwd, run.runId);
		current = await readRunRecord(cwd, run.runId);
		const exhausted = taskBySpec(current, "fix-loop.onExhausted.loop-summary");
		assert.deepEqual(exhausted.dependsOn, [
			"fix-loop.r01.implement",
			"fix-loop.r01.check",
			"fix-loop.r02.implement",
			"fix-loop.r02.check",
		]);
		const compiledAfterExhaustion = JSON.parse(
			readFileSync(
				join(cwd, ".pi", "workflows", current.runId, "compiled.json"),
				"utf8",
			),
		);
		const exhaustedTask = compiledAfterExhaustion.tasks.find(
			(task) => task.id === "fix-loop.onExhausted.loop-summary",
		);
		assert.match(exhaustedTask.compiledPrompt, /Round check outputs/);
		assert.match(exhaustedTask.compiledPrompt, /Round 1/);
		assert.match(
			exhaustedTask.compiledPrompt,
			/"blockingFailures":\["a","b"\]/,
		);
		assert.match(exhaustedTask.compiledPrompt, /Round 2/);
		assert.match(exhaustedTask.compiledPrompt, /"blockingFailures":\["a"\]/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("loop until evaluator supports equals notEquals lengthEquals all and any", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const { run } = await createLoopRun(cwd);
		await scheduleRun(cwd, run.runId);
		const current = await readRunRecord(cwd, run.runId);
		await completeTask(cwd, taskBySpec(current, "fix-loop.r01.implement"), {
			changed: true,
		});
		await completeTask(cwd, taskBySpec(current, "fix-loop.r01.check"), {
			status: "pass",
			verdict: "ACCEPT",
			blockingFailures: ["a", "b"],
			count: 2,
		});
		await writeRunRecord(cwd, current);
		const compiledAfterRound1 = JSON.parse(
			readFileSync(
				join(cwd, ".pi", "workflows", current.runId, "compiled.json"),
				"utf8",
			),
		);

		assert.equal(
			await evaluateLoopUntilCondition(
				cwd,
				current,
				compiledAfterRound1,
				"fix-loop",
				1,
				{ stage: "check", path: "$.status", equals: "pass" },
			),
			true,
		);
		assert.equal(
			await evaluateLoopUntilCondition(
				cwd,
				current,
				compiledAfterRound1,
				"fix-loop",
				1,
				{ stage: "check", path: "$.status", notEquals: "fail" },
			),
			true,
		);
		assert.equal(
			await evaluateLoopUntilCondition(
				cwd,
				current,
				compiledAfterRound1,
				"fix-loop",
				1,
				{ stage: "check", path: "$.blockingFailures", lengthEquals: 2 },
			),
			true,
		);
		assert.equal(
			await evaluateLoopUntilCondition(
				cwd,
				current,
				compiledAfterRound1,
				"fix-loop",
				1,
				{
					all: [
						{ stage: "check", path: "$.status", equals: "pass" },
						{ stage: "check", path: "$.verdict", equals: "ACCEPT" },
					],
				},
			),
			true,
		);
		assert.equal(
			await evaluateLoopUntilCondition(
				cwd,
				current,
				compiledAfterRound1,
				"fix-loop",
				1,
				{
					any: [
						{ stage: "check", path: "$.status", equals: "fail" },
						{ stage: "check", path: "$.verdict", equals: "ACCEPT" },
					],
				},
			),
			true,
		);
		assert.equal(
			await evaluateLoopUntilCondition(
				cwd,
				current,
				compiledAfterRound1,
				"fix-loop",
				1,
				{ source: "check", path: "$.status", equals: "pass" },
			),
			true,
		);
		assert.equal(
			await evaluateLoopUntilCondition(
				cwd,
				current,
				compiledAfterRound1,
				"fix-loop",
				1,
				{ stage: "check", path: "$.status", exists: true },
			),
			true,
		);
		assert.equal(
			await evaluateLoopUntilCondition(
				cwd,
				current,
				compiledAfterRound1,
				"fix-loop",
				1,
				{ source: "check", path: "$.missing", exists: false },
			),
			true,
		);
		assert.equal(
			await evaluateLoopUntilCondition(
				cwd,
				current,
				compiledAfterRound1,
				"fix-loop",
				1,
				{ stage: "check", path: "$.missing", notEquals: "anything" },
			),
			false,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("loop completed task with unreadable result records a warning", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const { run } = await createLoopRun(cwd);
		await scheduleRun(cwd, run.runId);
		const current = await readRunRecord(cwd, run.runId);
		await completeTask(cwd, taskBySpec(current, "fix-loop.r01.implement"), {
			changed: true,
		});
		const check = taskBySpec(current, "fix-loop.r01.check");
		await completeTask(cwd, check, { status: "pass" });
		writeFileSync(
			join(dirname(join(cwd, check.files.result)), "control.json"),
			"{not-json",
		);
		await writeRunRecord(cwd, current);
		const compiledAfterRound1 = JSON.parse(
			readFileSync(
				join(cwd, ".pi", "workflows", current.runId, "compiled.json"),
				"utf8",
			),
		);

		assert.equal(
			await evaluateLoopUntilCondition(
				cwd,
				current,
				compiledAfterRound1,
				"fix-loop",
				1,
				{ stage: "check", path: "$.status", equals: "pass" },
			),
			false,
		);
		assert.match(check.lastMessage, /completed loop task result unreadable/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("spec-review partition helper joins verifier results and flags missing coverage", async () => {
	const helper = (
		await import(
			pathToFileURL(
				join(
					process.cwd(),
					"workflows",
					"spec-review",
					"helpers",
					"spec-review-pipeline.mjs",
				),
			).href
		)
	).default;
	const result = await helper({
		sources: {
			"candidate-findings.main": {
				requirementCoverage: [{ requirementId: "REQ-001", status: "partial" }],
				candidateFindings: [
					{
						id: "FINDING-001",
						title: "Kept issue",
						severity: "high",
						requirementIds: ["REQ-001"],
						claim: "Issue is real",
					},
					{
						id: "FINDING-002",
						title: "Dropped issue",
						severity: "medium",
						requirementIds: ["REQ-002"],
						claim: "Issue is not real",
					},
					{
						id: "FINDING-003",
						title: "Missing verifier",
						severity: "low",
						claim: "Needs verification",
					},
				],
				needsHuman: [{ question: "Spec ambiguity?" }],
				noIssueNotes: ["REQ-004 satisfied"],
			},
			"verify-findings.finding-001": {
				id: "FINDING-001",
				verdict: "KEEP",
				severity: "high",
				evidence: [{ file: "src/a.ts", quote: "a", relevance: "r" }],
				finalClaim: "Kept final claim",
				recommendedAction: "Fix it",
			},
			"verify-findings.finding-002": {
				id: "FINDING-002",
				verdict: "DROP",
				finalClaim: "Not supported",
			},
			"verify-findings.orphan": {
				id: "FINDING-999",
				verdict: "KEEP",
			},
		},
		options: { mode: "partition" },
		context: {
			cwd: process.cwd(),
			specPath: "workflows/spec-review/spec.json",
		},
	});

	assert.equal(result.schema, "spec-review-partition-v1");
	assert.deepEqual(result.verifierCoverage.missingIds, ["FINDING-003"]);
	assert.deepEqual(result.verifierCoverage.orphanVerifierIds, ["FINDING-999"]);
	assert.deepEqual(
		result.finalFindings.map((finding) => finding.id),
		["FINDING-001"],
	);
	assert.deepEqual(
		result.droppedFindings.map((finding) => finding.id),
		["FINDING-002"],
	);
	assert(
		result.needsHuman.some((item) => item.source === "missing-verification"),
	);
	assert(result.needsHuman.some((item) => item.source === "orphan-verifier"));
	assert.deepEqual(result.noIssueNotes, ["REQ-004 satisfied"]);
});

test("bundled spec-review workflow compiles flat analysis and verification fanout", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "scout", "read, grep, find, ls");
		const specPath = join(
			process.cwd(),
			"workflows",
			"spec-review",
			"spec.json",
		);
		const spec = JSON.parse(readFileSync(specPath, "utf8"));
		parsePublicWorkflow(spec);
		assert.deepEqual(
			spec.artifactGraph.stages.slice(0, 4).map((stage) => stage.id),
			[
				"extract-spec",
				"map-implementation",
				"inspect-tests",
				"candidate-findings",
			],
		);
		const compiled = await compileWorkflow(spec, {
			cwd,
			specPath,
			task: "Compare docs/API_SPEC.md to src implementation and tests.",
		});
		assert.deepEqual(
			compiled.tasks.slice(0, 3).map((task) => task.key),
			["extract-spec.main", "map-implementation.main", "inspect-tests.main"],
		);
		assert.deepEqual(
			compiled.tasks.slice(0, 3).map((task) => task.dependsOn),
			[[], [], []],
		);
		const candidates = compiled.tasks.find(
			(task) => task.key === "candidate-findings.main",
		);
		assert.equal(candidates.kind, "reduce");
		assert.deepEqual(candidates.dependsOn, [
			"extract-spec.main",
			"map-implementation.main",
			"inspect-tests.main",
		]);
		const verifier = compiled.tasks.find(
			(task) => task.key === "verify-findings.item",
		);
		assert.equal(verifier.kind, "foreach");
		assert.deepEqual(verifier.dependsOn, ["candidate-findings.main"]);
		assert.deepEqual(verifier.foreach.from, {
			stage: "candidate-findings",
			path: "$.candidateFindings",
		});
		const partition = compiled.tasks.find(
			(task) => task.key === "partition-findings.main",
		);
		assert.equal(partition.kind, "support");
		assert.deepEqual(partition.dependsOn, [
			"candidate-findings.main",
			"verify-findings.item",
		]);
		assert.deepEqual(partition.support, {
			uses: "./helpers/spec-review-pipeline.mjs",
			options: { mode: "partition" },
		});
		const reportStage = compiled.stages.find((stage) => stage.id === "report");
		assert.equal(reportStage.sourcePolicy, "require-success");
		const report = compiled.tasks.find((task) => task.key === "report.main");
		assert.equal(report.kind, "reduce");
		assert.deepEqual(report.dependsOn, ["partition-findings.main"]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifact graph compiler propagates graph maxConcurrency", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const compiled = await compileWorkflow(
			artifactGraphWorkflowSpec({
				artifactGraph: {
					maxConcurrency: 3,
					stages: [{ id: "main", type: "single", prompt: "Do it." }],
				},
			}),
			{ cwd, task: "Do it." },
		);
		assert.equal(compiled.maxConcurrency, 3);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("bundled impact-review artifact graph workflow compiles multi-join DAG", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "scout", "read, grep, find, ls");
		const specPath = join(
			process.cwd(),
			"workflows",
			"impact-review",
			"spec.json",
		);
		const spec = JSON.parse(readFileSync(specPath, "utf8"));
		parsePublicWorkflow(spec);
		assert.equal(spec.name, "impact-review");
		assert.equal(spec.artifactGraph.stages[0].id, "impact-analysis");
		assert.equal(spec.artifactGraph.stages[0].type, "dag");
		assert.equal(spec.artifactGraph.stages[0].outputFrom, "impact-synthesis");

		const compiled = await compileWorkflow(spec, {
			cwd,
			specPath,
			task: "Review ship impact before merging this PR.",
		});
		const byKey = Object.fromEntries(
			compiled.tasks.map((task) => [task.key, task]),
		);

		assert.deepEqual(
			compiled.tasks.slice(0, 3).map((task) => task.key),
			[
				"impact-analysis.change-scope.main",
				"impact-analysis.implementation-map.main",
				"impact-analysis.validation-map.main",
			],
		);
		assert.deepEqual(
			compiled.tasks.slice(0, 3).map((task) => task.dependsOn),
			[[], [], []],
		);
		assert.deepEqual(
			byKey["impact-analysis.api-contract-impact.main"].dependsOn,
			[
				"impact-analysis.change-scope.main",
				"impact-analysis.implementation-map.main",
			],
		);
		assert.deepEqual(
			byKey["impact-analysis.validation-impact.main"].dependsOn,
			[
				"impact-analysis.change-scope.main",
				"impact-analysis.validation-map.main",
			],
		);
		assert.deepEqual(byKey["impact-analysis.regression-risk.main"].dependsOn, [
			"impact-analysis.api-contract-impact.main",
			"impact-analysis.state-data-impact.main",
			"impact-analysis.validation-impact.main",
			"impact-analysis.security-performance-impact.main",
		]);
		assert.deepEqual(byKey["impact-analysis.impact-synthesis.main"].dependsOn, [
			"impact-analysis.change-scope.main",
			"impact-analysis.contract-consistency.main",
			"impact-analysis.regression-risk.main",
			"impact-analysis.ship-readiness.main",
		]);
		assert.equal(byKey["impact-analysis.impact-synthesis.main"].kind, "reduce");
		assert.ok(
			byKey[
				"impact-analysis.impact-synthesis.main"
			].artifactGraph.output.controlSchemaPath.endsWith(
				join(
					"workflows",
					"impact-review",
					"schemas",
					"impact-synthesis-control.schema.json",
				),
			),
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("bundled artifact graph workflows are public runnable", async () => {
	const workflows = await listWorkflows(process.cwd());
	for (const name of [
		"spec-review",
		"deep-review",
		"deep-research",
		"impact-review",
	]) {
		assert(
			workflows.some((workflow) => workflow.name === name),
			name,
		);
	}
	const resolved = await resolveWorkflowRef("spec-review", process.cwd());
	assert(resolved.specPath.endsWith("workflows/spec-review/spec.json"));
});

test("built dist scheduler injects runDecisionLoop on the real dynamic path", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const marker = "__PI_WORKFLOW_DIST_RESULT__";
		const script = `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = ${JSON.stringify(process.cwd())};
const cwd = ${JSON.stringify(cwd)};
const marker = ${JSON.stringify(marker)};
const workflowDir = join(cwd, "workflows", "dist-dynamic");
mkdirSync(join(workflowDir, "helpers"), { recursive: true });
const specPath = join(workflowDir, "spec.json");
writeFileSync(
	join(workflowDir, "helpers", "controller.mjs"),
	[
		"export default async function controller(ctx) {",
		"  if (typeof ctx?.dynamic?.runDecisionLoop !== 'function') {",
		"    throw new Error('dynamic decision-loop helper is unavailable in controller context');",
		"  }",
		"  return await ctx.dynamic.runDecisionLoop({",
		"    maxRounds: 1,",
		"    buildPlannerPrompt(input) {",
		"      return 'Deterministic built-dist decision-loop regression. Round ' + input.round + '. Return a valid dynamic-decision-v1 stop decision.';",
		"    }",
		"  });",
		"}",
	].join("\\n"),
);
const spec = {
	schemaVersion: 1,
	defaults: { agent: "unit-scout", readOnly: true, tools: ["read"] },
	artifactGraph: {
		stages: [
			{
				id: "adaptive",
				type: "dynamic",
				dynamic: {
					uses: "./helpers/controller.mjs",
					decisionLoop: {
						planner: {
							agent: "unit-scout",
							tools: ["read"],
							outputProfile: "generic_summary_v1",
						},
						workerDefaults: {
							agent: "unit-scout",
							tools: ["read"],
							outputProfile: "candidate_findings_v1",
						},
						allowedAgents: ["unit-scout"],
						allowedTools: ["read"],
						allowedOutputProfiles: [
							"candidate_findings_v1",
							"generic_summary_v1",
						],
						maxDecisionRounds: 1,
						maxActionsPerRound: 1,
						repair: { maxAttempts: 1 },
						stopPolicy: { failOnInvalidDecision: true },
					},
				},
			},
		],
	},
};
writeFileSync(specPath, JSON.stringify(spec));
const distUrl = (file) => pathToFileURL(join(repoRoot, "dist", file)).href;
const { compileWorkflow } = await import(distUrl("compiler.js"));
const { scheduleRun } = await import(distUrl("engine.js"));
const { readDynamicEvents } = await import(distUrl("dynamic-events.js"));
const { setSubagentApiForTests } = await import(distUrl("subagent-backend.js"));
const { writeWorkflowTaskArtifactBundle } = await import(distUrl("workflow-output-artifacts.js"));
const {
	createWorkflowRunRecord,
	readRunRecord,
	setTaskTerminal,
	writeJsonAtomic,
	writeRunRecord,
	writeStaticRunArtifacts,
} = await import(distUrl("store.js"));
let launchCount = 0;
setSubagentApiForTests({
	async runSubagent() {
		launchCount += 1;
		return {
			runId: "dist_stub_" + launchCount,
			attemptId: "dist_attempt_" + launchCount,
			status: "running",
		};
	},
	async getSubagentStatus() {
		return null;
	},
	async reconcileSubagentRun() {
		return {};
	},
	async interruptSubagent() {
		return {};
	},
});
async function completeTask(task, structuredOutput, status = "completed") {
	setTaskTerminal(task, status, status, {
		exitCode: status === "completed" ? 0 : 1,
		lastMessage: status,
	});
	if (task.artifactGraph?.enabled && status === "completed") {
		const control = {
			schema: "stage-control-v1",
			digest: (task.stageId ?? task.specId) + " completed",
			...structuredOutput,
		};
		await writeWorkflowTaskArtifactBundle({
			taskDir: dirname(join(cwd, task.files.result)),
			rawOutput: [
				"<control>",
				JSON.stringify(control),
				"</control>",
				"<analysis>",
				(task.stageId ?? task.specId) + " analysis",
				"</analysis>",
				"<refs>",
				"[]",
				"</refs>",
			].join("\\n"),
			completedAt: new Date().toISOString(),
		});
		return;
	}
	await writeJsonAtomic(join(cwd, task.files.result), {
		status,
		completedAt: new Date().toISOString(),
		exitCode: status === "completed" ? 0 : 1,
		structuredOutput,
	});
}
const compiled = await compileWorkflow(spec, {
	cwd,
	task: "Verify built dist dynamic injection.",
	specPath,
});
const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
await writeStaticRunArtifacts(cwd, run, compiled, spec);
await writeRunRecord(cwd, run);
await scheduleRun(cwd, run.runId);
let updated = await readRunRecord(cwd, run.runId);
let controller = updated.tasks.find((task) => task.specId === "adaptive.controller");
const planner = updated.tasks.find((task) => task.specId === "adaptive.decide-r0");
if (controller?.status === "pending" && planner?.status === "running") {
	await completeTask(planner, {
		schema: "dynamic-decision-v1",
		decisionId: "decision-r0",
		round: 0,
		phase: "round",
		status: "stop",
		nextActions: [
			{
				type: "stop",
				actionId: "stop-r0",
				reason: "built dist decision loop persisted a stop decision",
				caveats: ["integration test"],
			},
		],
	});
	await writeRunRecord(cwd, updated);
	await scheduleRun(cwd, run.runId);
	updated = await readRunRecord(cwd, run.runId);
	controller = updated.tasks.find((task) => task.specId === "adaptive.controller");
}
const control = controller?.status === "completed"
	? JSON.parse(readFileSync(join(dirname(join(cwd, controller.files.result)), "control.json"), "utf8"))
	: null;
const events = await readDynamicEvents(cwd, run.runId);
const decisionPersistedCount = events.filter((event) => event.type === "decision.persisted").length;
console.log(marker + JSON.stringify({
	status: controller?.status ?? null,
	statusDetail: controller?.statusDetail ?? null,
	message: controller?.lastMessage ?? null,
	plannerStatus: planner?.status ?? null,
	controlStatus: control?.status ?? null,
	controlDecisionCount: Array.isArray(control?.decisions) ? control.decisions.length : 0,
	decisionPersistedCount,
	launchCount,
}));
if (
	controller?.status !== "completed" ||
	controller?.statusDetail !== "dynamic_stopped" ||
	control?.status !== "stopped" ||
	!Array.isArray(control?.decisions) ||
	control.decisions.length < 1 ||
	decisionPersistedCount < 1
) {
	process.exitCode = 1;
}
`;
		const child = spawnSync(
			process.execPath,
			["--input-type=module", "-e", script],
			{
				cwd: process.cwd(),
				encoding: "utf8",
				env: { ...process.env, PI_WORKFLOW_ROLE: "supervisor" },
			},
		);
		const output = `${child.stdout}\n${child.stderr}`;
		assert.equal(child.error, undefined);
		const resultLine = child.stdout
			.split(/\r?\n/)
			.find((line) => line.startsWith(marker));
		assert(resultLine, output);
		const result = JSON.parse(resultLine.slice(marker.length));
		assert.equal(child.status, 0, output);
		assert.equal(result.status, "completed");
		assert.equal(result.statusDetail, "dynamic_stopped");
		assert.equal(result.plannerStatus, "completed");
		assert.equal(result.controlStatus, "stopped");
		assert.equal(result.controlDecisionCount >= 1, true);
		assert.equal(result.decisionPersistedCount >= 1, true);
		assert.equal(result.launchCount, 1);
		assert.doesNotMatch(
			output,
			/dynamic decision-loop helper is unavailable in controller context/,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("bundled deep-review workflow leaves reviewer fanout unconstrained by stage caps", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "scout", "read, grep, find, ls");
		const specPath = join(
			process.cwd(),
			"workflows",
			"deep-review",
			"spec.json",
		);
		const spec = JSON.parse(readFileSync(specPath, "utf8"));
		const reviewersStage = spec.artifactGraph.stages.find(
			(stage) => stage.id === "reviewers",
		);
		assert.match(reviewersStage.each.prompt, /leading \+ or - marker/);
		const compiled = await compileWorkflow(spec, {
			cwd,
			specPath,
		});
		const reviewers = compiled.tasks.find(
			(task) => task.key === "reviewers.item",
		);
		const devilAdvocate = compiled.tasks.find(
			(task) => task.key === "devil-advocate.item",
		);
		assert.equal(reviewers?.stageMaxConcurrency, undefined);
		assert.equal(devilAdvocate?.stageMaxConcurrency, undefined);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("bundled spec-review workflow materializes verifier and partitions verified findings", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "scout", "read, grep, find, ls");
		captureSubagentPrompts([]);
		const specPath = join(
			process.cwd(),
			"workflows",
			"spec-review",
			"spec.json",
		);
		const spec = JSON.parse(readFileSync(specPath, "utf8"));
		const compiled = await compileWorkflow(spec, {
			cwd,
			specPath,
			task: "Compare docs/API_SPEC.md to src implementation and tests.",
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);

		await completeTask(cwd, taskBySpec(run, "extract-spec.main"), {
			requirements: [{ id: "REQ-001", requirement: "Must match" }],
		});
		await completeTask(cwd, taskBySpec(run, "map-implementation.main"), {
			implementationMap: [],
		});
		await completeTask(cwd, taskBySpec(run, "inspect-tests.main"), {
			testMap: [],
		});
		await completeTask(cwd, taskBySpec(run, "candidate-findings.main"), {
			requirementCoverage: [{ requirementId: "REQ-001", status: "partial" }],
			candidateFindings: [
				{
					id: "FINDING-001",
					requirementIds: ["REQ-001"],
					severity: "medium",
					title: "Missing behavior",
					claim: "Implementation misses behavior",
				},
			],
			needsHuman: [],
			noIssueNotes: [],
		});
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		let current = await readRunRecord(cwd, run.runId);
		assert.deepEqual(
			current.tasks.map((task) => task.specId),
			[
				"extract-spec.main",
				"map-implementation.main",
				"inspect-tests.main",
				"candidate-findings.main",
				"verify-findings.finding-001",
				"partition-findings.main",
				"report.main",
			],
		);
		assert.deepEqual(taskBySpec(current, "partition-findings.main").dependsOn, [
			"candidate-findings.main",
			"verify-findings.finding-001",
		]);

		await completeTask(
			cwd,
			taskBySpec(current, "verify-findings.finding-001"),
			{
				id: "FINDING-001",
				verdict: "KEEP",
				severity: "medium",
				evidence: [
					{ file: "src/example.ts", quote: "missing", relevance: "gap" },
				],
				counterEvidence: [],
				finalClaim: "Implementation misses behavior",
				recommendedAction: "Implement the missing behavior",
			},
		);
		await writeRunRecord(cwd, current);

		await scheduleRun(cwd, current.runId);
		current = await readRunRecord(cwd, current.runId);
		const partitionTask = taskBySpec(current, "partition-findings.main");
		assert.equal(partitionTask.status, "completed");
		const partitionResult = JSON.parse(
			readFileSync(
				join(dirname(join(cwd, partitionTask.files.result)), "control.json"),
				"utf8",
			),
		);
		assert.deepEqual(partitionResult.verifierCoverage.missingIds, []);
		assert.deepEqual(
			partitionResult.finalFindings.map((finding) => finding.id),
			["FINDING-001"],
		);
		assert.deepEqual(partitionResult.verdictCounts, {
			keep: 1,
			weaken: 0,
			drop: 0,
			needsHuman: 0,
			missingVerification: 0,
			invalidVerifier: 0,
			orphanVerifier: 0,
		});
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("workflow artifact telemetry summarizes stage status, retries, wall clock, and output bytes", () => {
	const run = {
		createdAt: "2026-06-08T00:00:00.000Z",
		updatedAt: "2026-06-08T00:02:00.000Z",
		tasks: [
			{
				stageId: "plan",
				status: "completed",
				startedAt: "2026-06-08T00:00:00.000Z",
				completedAt: "2026-06-08T00:00:10.000Z",
				files: { output: "a", stderr: "", result: "" },
			},
			{
				stageId: "verify",
				status: "completed",
				startedAt: "2026-06-08T00:00:15.000Z",
				completedAt: "2026-06-08T00:00:45.000Z",
				outputRetry: {
					attempts: 1,
					reason: "workflow_output_invalid",
					repairMode: "new_session",
				},
				resumeEvents: [
					{
						at: "2026-06-08T00:00:50.000Z",
						fromStatus: "failed",
						fromStatusDetail: "workflow_output_invalid_exhausted",
						outputRetryAttempts: 2,
						outputRetryReason: "workflow_output_invalid_exhausted",
						outputRetryRepairMode: "same_session",
					},
				],
				files: { output: "b", stderr: "", result: "" },
			},
			{
				stageId: "verify",
				status: "interrupted",
				startedAt: "2026-06-08T00:00:20.000Z",
				completedAt: "2026-06-08T00:00:25.000Z",
				launchRetry: { attempts: 1 },
				files: { output: "c", stderr: "", result: "" },
			},
		],
	};
	const summary = summarizeWorkflowTelemetry(run, {
		outputBytesByTaskId: { a: 10, b: 20, c: 0 },
	});
	assert.equal(summary.wallClockMs, 120000);
	assert.equal(summary.taskCount, 3);
	assert.equal(summary.statusCounts.completed, 2);
	assert.equal(summary.statusCounts.interrupted, 1);
	assert.equal(summary.retryCounts.output, 3);
	assert.equal(summary.retryCounts.launch, 1);
	assert.equal(summary.retryReasons.output.workflow_output_invalid, 1);
	assert.equal(
		summary.retryReasons.output.workflow_output_invalid_exhausted,
		1,
	);
	assert.equal(summary.resumeCounts.events, 1);
	assert.equal(summary.resumeCounts.tasks, 1);
	assert.equal(summary.resumeStatusCounts.failed, 1);
	assert.equal(summary.outputRepairCounts.sameSession, 1);
	assert.equal(summary.outputRepairCounts.newSession, 1);
	assert.equal(summary.outputBytes, 30);
	assert.equal(summary.stages.verify.taskCount, 2);
	assert.equal(summary.stages.verify.durationMs, 35000);
});

test("workflow resume reset preserves retry accounting metadata", () => {
	const task = {
		taskId: "task-1",
		specId: "verify.claim-1",
		displayName: "verify",
		agent: "unit-agent",
		agentFile: "agents/unit.md",
		roles: [],
		status: "failed",
		statusDetail: "workflow_output_invalid_exhausted",
		runtime: { approvalMode: "non-interactive" },
		tools: [],
		cwd: ".",
		worktree: {
			enabled: false,
			path: null,
			branch: null,
			baseCwd: null,
			warning: null,
		},
		backendTaskId: "run_backend",
		backendHandle: {
			engine: "pi-subagent",
			runId: "run_backend",
			attemptId: "attempt_backend",
		},
		files: { output: "out", stderr: "err", result: "result" },
		lastMessage: "invalid output",
		outputRetry: {
			attempts: 1,
			reason: "workflow_output_invalid_exhausted",
			repairMode: "new_session",
		},
	};

	assert.equal(resetTaskForResume(task), true);
	assert.equal(task.status, "pending");
	assert.equal(task.outputRetry, undefined);
	assert.equal(task.resumeEvents.length, 1);
	assert.equal(task.resumeEvents[0].fromStatus, "failed");
	assert.equal(task.resumeEvents[0].outputRetryAttempts, 1);
	assert.equal(task.resumeEvents[0].outputRetryRepairMode, "new_session");
	assert.equal(task.resumeEvents[0].backendRunId, "run_backend");
	assert.equal(task.resumeEvents[0].backendAttemptId, "attempt_backend");
});

test("workflow source context packet prefers structured output and caps raw previews", () => {
	const run = {
		tasks: [
			{
				taskId: "task-1",
				specId: "plan.main",
				stageId: "plan",
				status: "completed",
				files: { output: "plan.out", result: "plan.json" },
			},
			{
				taskId: "task-2",
				specId: "verify.claim-001",
				stageId: "verify",
				status: "completed",
				files: { output: "verify.out", result: "verify.json" },
			},
			{
				taskId: "task-3",
				specId: "verify.claim-002",
				stageId: "verify",
				status: "failed",
				files: { output: "failed.out", result: "failed.json" },
			},
		],
	};
	const packet = buildSourceContextPacket(run, {
		structuredOutputsByTaskId: {
			"task-1": { researchQuestions: [{ id: "rq1", question: "Q?" }] },
			"task-2": {
				id: "claim-001",
				status: "verified",
				evidence: [{ url: "https://example.test", quote: "ok" }],
			},
		},
		rawOutputsByTaskId: {
			"task-3": "abcdefghijklmnopqrstuvwxyz",
		},
		maxPreviewChars: 8,
	});

	assert.equal(packet.tasks.length, 3);
	assert.deepEqual(packet.byStage.verify.statusCounts, {
		completed: 1,
		failed: 1,
	});
	assert.equal(packet.tasks[1].structuredOutput.status, "verified");
	assert.equal(packet.tasks[2].outputPreview, "abcdefgh…");
	assert.equal(packet.tasks[2].structuredOutput, undefined);
});

test("workflow source context packet can cap oversized structured output", () => {
	const packet = buildSourceContextPacket(
		{
			tasks: [
				{
					taskId: "task-1",
					specId: "normalize.main",
					stageId: "normalize",
					status: "completed",
					files: { output: "normalize.out", result: "normalize.json" },
				},
			],
		},
		{
			structuredOutputsByTaskId: {
				"task-1": { huge: "abcdefghijklmnopqrstuvwxyz" },
			},
			maxStructuredChars: 16,
		},
	);
	assert.equal(packet.tasks[0].structuredOutput.truncated, true);
	assert.equal(packet.tasks[0].structuredOutput.originalChars > 16, true);
	assert.match(packet.tasks[0].structuredOutput.preview, /^\{/);
});

test("workflow source context packet applies stage caps and a global packet budget", () => {
	const run = {
		tasks: [
			{
				taskId: "task-1",
				specId: "plan.main",
				stageId: "plan",
				status: "completed",
				files: { output: "plan.out", result: "plan.json" },
			},
			{
				taskId: "task-2",
				specId: "verify.claim-001",
				stageId: "verify",
				status: "completed",
				files: { output: "verify.out", result: "verify.json" },
			},
			{
				taskId: "task-3",
				specId: "verify.claim-002",
				stageId: "verify",
				status: "completed",
				files: { output: "verify2.out", result: "verify2.json" },
			},
		],
	};
	const packet = buildSourceContextPacket(run, {
		structuredOutputsByTaskId: {
			"task-1": { plan: "abcdefghijklmnopqrstuvwxyz" },
			"task-2": { evidence: "abcdefghijklmnopqrstuvwxyz" },
			"task-3": { evidence: "abcdefghijklmnopqrstuvwxyz" },
		},
		maxStructuredChars: 64,
		maxStructuredCharsByStage: { verify: 12 },
		maxPacketChars: 320,
	});

	assert.equal(packet.tasks[1].structuredOutput.truncated, true);
	assert.equal(packet.tasks[1].structuredOutput.preview.length <= 13, true);
	assert.equal(packet.tasks[2].omittedOutput.reason, "packet_budget_exhausted");
	assert.deepEqual(packet.byStage.verify.statusCounts, { completed: 2 });
});

test("workflow source context packet can project structured outputs by source stage", () => {
	const packet = buildSourceContextPacket(
		{
			tasks: [
				{
					taskId: "task-1",
					specId: "verify.claim-001",
					stageId: "verify",
					status: "completed",
					files: { output: "verify.out", result: "verify.json" },
				},
			],
		},
		{
			structuredOutputsByTaskId: {
				"task-1": {
					id: "claim-001",
					status: "verified",
					verdictDigest: {
						support: "direct",
						sourceUrls: ["https://example.test"],
					},
					evidence: [{ quote: "long quote that final should not need" }],
				},
			},
			structuredOutputPathsByStage: {
				verify: ["$.id", "$.status", "$.verdictDigest", "$.missingDigest"],
			},
		},
	);

	assert.deepEqual(packet.tasks[0].structuredOutput, {
		id: "claim-001",
		status: "verified",
		verdictDigest: { support: "direct", sourceUrls: ["https://example.test"] },
	});
	assert.deepEqual(packet.tasks[0].projectionWarnings, [
		{ path: "$.missingDigest", reason: "missing" },
	]);
});

test("structured contract validator checks nested paths, arrays, and caps", () => {
	const valid = validateStructuredContract(
		{
			finalReport: {
				mainFindings: [{ finding: "x" }],
				remainingGaps: { blocking: [], nonBlocking: ["minor"] },
			},
			claimVerdictIndex: {
				claims: [
					{
						id: "claim-001",
						status: "verified",
						sourceUrls: ["https://example.test"],
					},
				],
			},
		},
		{
			requiredPaths: ["$.finalReport", "$.claimVerdictIndex.claims"],
			arrays: [
				{ path: "$.claimVerdictIndex.claims", minItems: 1, maxItems: 2 },
			],
			maxStringChars: [
				{ path: "$.finalReport.remainingGaps.nonBlocking[0]", maxChars: 16 },
			],
		},
	);
	assert.equal(valid.valid, true);

	const invalid = validateStructuredContract(
		{ claimVerdictIndex: { claims: [] } },
		{
			requiredPaths: ["$.finalReport", "$.claimVerdictIndex.claims"],
			arrays: [{ path: "$.claimVerdictIndex.claims", minItems: 1 }],
		},
	);
	assert.equal(invalid.valid, false);
	assert(invalid.issues.some((issue) => issue.path === "$.finalReport"));
	assert(
		invalid.issues.some(
			(issue) =>
				issue.path === "$.claimVerdictIndex.claims" &&
				issue.message.includes("at least 1"),
		),
	);
});

test("engine source context reads structured outputs and telemetry from task artifacts", async () => {
	const cwd = makeProject();
	try {
		const run = {
			createdAt: "2026-06-08T00:00:00.000Z",
			updatedAt: "2026-06-08T00:01:00.000Z",
			tasks: [
				{
					taskId: "task-1",
					specId: "plan.main",
					stageId: "plan",
					status: "completed",
					startedAt: "2026-06-08T00:00:00.000Z",
					completedAt: "2026-06-08T00:00:10.000Z",
					files: {
						output: ".pi/workflows/workflow_unit/tasks/task-1/output.log",
						stderr: ".pi/workflows/workflow_unit/tasks/task-1/stderr.log",
						result: ".pi/workflows/workflow_unit/tasks/task-1/result.json",
					},
				},
				{
					taskId: "task-2",
					specId: "verify.claim-001",
					stageId: "verify",
					status: "completed",
					startedAt: "2026-06-08T00:00:20.000Z",
					completedAt: "2026-06-08T00:00:50.000Z",
					outputRetry: { attempts: 1 },
					files: {
						output: ".pi/workflows/workflow_unit/tasks/task-2/output.log",
						stderr: ".pi/workflows/workflow_unit/tasks/task-2/stderr.log",
						result: ".pi/workflows/workflow_unit/tasks/task-2/result.json",
					},
				},
			],
		};
		for (const task of run.tasks)
			mkdirSync(join(cwd, task.files.output, ".."), { recursive: true });
		writeFileSync(join(cwd, run.tasks[0].files.output), "raw plan output");
		writeFileSync(
			join(cwd, run.tasks[0].files.result),
			JSON.stringify({
				structuredOutput: { researchQuestions: [{ id: "rq1" }] },
			}),
		);
		writeFileSync(join(cwd, run.tasks[1].files.output), "raw verify output");
		writeFileSync(
			join(cwd, run.tasks[1].files.result),
			JSON.stringify({
				structuredOutput: { id: "claim-001", status: "verified" },
			}),
		);

		const context = await buildRunSourceContext(cwd, run, run.tasks, {
			maxPreviewChars: 4,
		});
		assert.equal(context.telemetry.wallClockMs, 60000);
		assert.equal(context.telemetry.retryCounts.output, 1);
		assert.equal(
			context.packet.tasks[0].structuredOutput.researchQuestions[0].id,
			"rq1",
		);
		assert.equal(context.packet.tasks[0].outputPreview, undefined);
		assert.equal(context.packet.byStage.verify.statusCounts.completed, 1);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("schema and compiler support pi-subagent headless backend", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");

		const defaultCompiled = await compileWorkflow(workflowSpec("unit-scout"), {
			cwd,
			task: "Review",
		});
		assert.equal(defaultCompiled.backend.mode, "headless");
		assert.equal(defaultCompiled.maxConcurrency, 16);

		const headlessSpec = workflowSpec("unit-scout", {
			defaults: { backend: { mode: "headless" } },
		});
		assert.equal(parseWorkflow(headlessSpec).defaults.backend.mode, "headless");
		assert.equal(
			(await compileWorkflow(headlessSpec, { cwd, task: "Review" })).backend
				.mode,
			"headless",
		);

		assertThrowsFlow(() =>
			parseWorkflow(
				workflowSpec("unit-scout", { defaults: { backend: { mode: "tmux" } } }),
			),
		);
		assertThrowsFlow(() =>
			parseWorkflow(workflowSpec("unit-scout", { defaults: { fast: "on" } })),
		);
		assertThrowsFlow(() =>
			parseWorkflow(
				workflowSpec("unit-scout", {
					artifactGraph: {
						stages: [
							{ id: "main", type: "single", fast: "on", prompt: "Do it." },
						],
					},
				}),
			),
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("schema and compiler accept artifactGraph support nodes", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const spec = workflowSpec("unit-scout", {
			artifactGraph: {
				stages: [
					{
						id: "verify",
						type: "single",
						prompt: "Verify claims",
					},
					{
						id: "audit",
						from: "verify",
						support: {
							uses: "./helpers/audit.mjs",
							options: { strict: true },
						},
					},
				],
			},
		});

		const parsed = parseWorkflow(spec);
		assert.equal(
			parsed.artifactGraph.stages[1].support.uses,
			"./helpers/audit.mjs",
		);
		const compiled = await compileWorkflow(spec, { cwd, task: "Research" });
		const supportTask = compiled.tasks.find((task) => task.stageId === "audit");
		assert.ok(supportTask);
		assert.equal(supportTask.kind, "support");
		assert.equal(supportTask.agent, "support");
		assert.equal(supportTask.runtime.tools, undefined);
		assert.deepEqual(supportTask.dependsOn, ["verify.main"]);
		assert.deepEqual(supportTask.support, {
			uses: "./helpers/audit.mjs",
			options: { strict: true },
		});
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("schema rejects invalid artifactGraph support nodes", () => {
	const missingUses = assertThrowsFlow(() =>
		parseWorkflow(
			workflowSpec("unit-scout", {
				artifactGraph: {
					stages: [
						{ id: "verify", type: "single", prompt: "Verify." },
						{ id: "audit", from: "verify", support: {} },
					],
				},
			}),
		),
	);
	assertIssue(
		missingUses,
		"$.artifactGraph.stages[1].support.uses",
		"must be a non-empty string",
	);
});

test("workflow helper loader resolves directory-local helpers", async () => {
	const cwd = makeProject();
	try {
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		const helperPath = join(workflowDir, "helpers", "audit.mjs");
		writeFileSync(specPath, JSON.stringify(workflowSpec("unit-scout")));
		writeFileSync(
			helperPath,
			"export default async function helper(input) { return { ok: true, sources: input.sources }; }\n",
		);

		const resolved = await resolveWorkflowHelperRef(
			"./helpers/audit.mjs",
			specPath,
		);
		assert.equal(
			resolved.path.endsWith("/workflows/bundle/helpers/audit.mjs"),
			true,
		);

		const helper = await loadWorkflowHelper("./helpers/audit.mjs", specPath);
		assert.deepEqual(
			await helper({
				sources: { verify: { ok: true } },
				context: { specPath, cwd },
			}),
			{
				ok: true,
				sources: { verify: { ok: true } },
			},
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("workflow helper loader rejects external or invalid helper refs", async () => {
	const cwd = makeProject();
	try {
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(specPath, JSON.stringify(workflowSpec("unit-scout")));
		writeFileSync(
			join(workflowDir, "helpers", "not-function.mjs"),
			"export default 1;\n",
		);

		await assert.rejects(
			() => resolveWorkflowHelperRef("../outside.mjs", specPath),
			/parent-directory/,
		);
		await assert.rejects(
			() => resolveWorkflowHelperRef("/tmp/outside.mjs", specPath),
			/directory-local/,
		);
		await assert.rejects(
			() => resolveWorkflowHelperRef("file://helpers/audit.mjs", specPath),
			/directory-local/,
		);
		await assert.rejects(
			() => resolveWorkflowHelperRef("npm:pkg", specPath),
			/directory-local/,
		);
		await assert.rejects(
			() => resolveWorkflowHelperRef("~/.pi/helper.mjs", specPath),
			/directory-local/,
		);
		await assert.rejects(
			() => resolveWorkflowHelperRef("./helpers/audit.js", specPath),
			/relative \.mjs file/,
		);
		await assert.rejects(
			() => loadWorkflowHelper("./helpers/not-function.mjs", specPath),
			/default-export a function/,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("dynamic controller loader resolves trusted directory-local controllers", async () => {
	const cwd = makeProject();
	try {
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(specPath, JSON.stringify(workflowSpec("unit-scout")));
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			"export default async function controller(ctx) { return { task: ctx.task }; }\n",
		);
		writeFileSync(
			join(workflowDir, "helpers", "not-function.mjs"),
			"export default 1;\n",
		);

		const controller = await loadDynamicController(
			"./helpers/controller.mjs",
			specPath,
		);
		assert.deepEqual(
			await controller({
				task: "Do it",
				sources: {},
				phase: () => {},
				log: () => {},
				artifact: (name) => ({ kind: "workflow-artifact-ref", name }),
				graph: { generatedTaskIds: () => [] },
				budget: { remaining: () => ({}), check: () => true },
				agent: async () => {
					throw new Error("not implemented");
				},
				parallel: async (thunks) =>
					Promise.allSettled(thunks.map((fn) => fn())),
			}),
			{ task: "Do it" },
		);
		await assert.rejects(
			() => loadDynamicController("../outside.mjs", specPath),
			/parent-directory/,
		);
		await assert.rejects(
			() => loadDynamicController("./helpers/not-function.mjs", specPath),
			/dynamic controller must default-export a function/,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("deep-research claim evidence gate downgrades unsupported verified claims", async () => {
	const { default: helper } = await import(
		`../../workflows/deep-research/helpers/claim-evidence-gate.mjs?test=${Date.now()}`
	);

	const result = await helper({
		sources: {
			"verify-claims.item-001": {
				auditedClaims: [
					{
						id: "claim-001",
						status: "verified",
						text: "The benchmark improved by 42%.",
					},
					{
						id: "claim-002",
						status: "verified",
						text: "The release exists.",
						evidence: [
							{
								url: "https://example.com/release",
								quote: "Release notes confirm it exists.",
								fetched: true,
							},
						],
					},
					{
						id: "claim-003",
						status: "verified",
						text: "The release exists with candidate-only weak term evidence.",
						evidence: [
							{
								url: "https://example.com/release",
								quote: "Release notes",
								matchType: "terms",
								candidateOnly: true,
								matchedTerms: ["release"],
								missingTerms: ["exists"],
								coverageRatio: 0.5,
							},
						],
					},
					{
						id: "claim-004",
						status: "verified",
						text: "The release exists with candidate-only full term evidence.",
						evidence: [
							{
								url: "https://example.com/release",
								quote: "Release notes confirm it exists.",
								matchType: "terms",
								candidateOnly: true,
								matchedTerms: ["release", "exists"],
								missingTerms: [],
								coverageRatio: 1,
							},
						],
					},
				],
			},
		},
		options: {
			downgradeExactQuantitativeWithoutSource: true,
			requireFetchedEvidenceForVerified: true,
		},
		context: {},
	});

	assert.equal(result.gateSummary.total, 4);
	assert.equal(result.gateSummary.downgraded, 3);
	assert.equal(result.auditedClaims[0].status, "partially_supported");
	assert.equal(result.auditedClaims[0].evidenceGate.previous, "verified");
	assert.equal(result.auditedClaims[1].status, "verified");
	assert.equal(result.auditedClaims[2].status, "partially_supported");
	assert.equal(result.auditedClaims[3].status, "partially_supported");
	assert.deepEqual(result.auditedClaims[1].sourceUrls, [
		"https://example.com/release",
	]);
});

test("deep-research normalize input packet compacts research context", async () => {
	const { default: helper } = await import(
		`../../workflows/deep-research/helpers/normalize-input-packet.mjs?test=${Date.now()}`
	);
	const result = await helper({
		sources: {
			"plan.main": {
				depth: "standard",
				taskType: "decision_memo",
				expectedFinalShape: "decision_memo",
				factSlots: [{ id: "slot-001", label: "Latency", required: true }],
				verificationPriorities: [{ id: "vp-001", targetSlots: ["slot-001"], priority: "high" }],
			},
			"research-questions.item-001": {
				extractedFacts: [
					{
						slotId: "slot-001",
						value: "42 ms",
						sourceUrls: ["https://example.test/report"],
						sourceRefs: ["wsrc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
						quote: "Latency was 42 ms in the benchmark.",
					},
				],
				claims: [
					{
						claim: "Latency was 42 ms.",
						factSlotIds: ["slot-001"],
						sourceRefs: ["wsrc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
					},
				],
				sources: [{ url: "https://example.test/report", sourceRef: "wsrc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }],
				additionalUnverifiedLeads: [{ lead: "Check p95 latency", factSlotIds: ["slot-001"] }],
			},
		},
	});
	assert.equal(result.schema, "deep-research-normalize-input-packet-v2");
	assert.equal(result.packet.plan.factSlots.length, 1);
	assert.equal(result.packet.research.extractedFacts[0].slotId, "slot-001");
	assert.deepEqual(result.packet.research.claims[0].sourceRefs, ["wsrc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
	assert.equal(result.packet.ledgers.sourceRefCoverage.claimsWithSourceRefs, 1);
	assert.equal(result.packet.ledgers.slotFactCounts["slot-001"], 1);
});

test("deep-research normalize input packet preserves slots and flags precision risks", async () => {
	const { default: helper } = await import(
		`../../workflows/deep-research/helpers/normalize-input-packet.mjs?test=${Date.now()}`
	);
	const result = await helper({
		sources: {
			"plan.main": {
				depth: "standard",
				taskType: "vendor_comparison",
				expectedFinalShape: "side_by_side_comparison",
				factSlots: [
					{
						id: "slot-latency",
						label: "Provider A latency",
						type: "numeric",
						required: true,
						entities: ["Provider A"],
						sourcePriority: "primary_required",
					},
					{
						id: "slot-price",
						label: "Provider B price",
						type: "pricing",
						required: true,
						entities: ["Provider B"],
						sourcePriority: "primary_required",
					},
				],
			},
			"research-questions.item-001": {
				extractedFacts: [
					{
						slotId: "slot-latency",
						value: "42 ms",
						sourceUrls: ["https://example.test/latency"],
						sourceRefs: ["wsrc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
					},
					{
						slotId: "slot-price",
						value: "$9/month",
						sourceUrls: ["https://example.test/pricing"],
						sourceRefs: ["wsrc_cccccccccccccccccccccccccccccccc"],
					},
				],
				claims: [
					{
						claim:
							"Provider A is the best and always cheaper than Provider B because latency is 42 ms and price is $9/month.",
						factSlotIds: ["slot-latency", "slot-price"],
						sourceUrls: ["https://example.test/latency"],
						sourceRefs: ["wsrc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
					},
					{
						claim: "Provider B costs $9/month.",
						factSlotIds: ["slot-price"],
					},
				],
			},
		},
	});

	assert.deepEqual(result.packet.slotPreservation.slotsWithEvidence.sort(), [
		"slot-latency",
		"slot-price",
	]);
	assert.deepEqual(result.packet.slotPreservation.missingRequiredOrCriticalSlots, []);
	const priceSlot = result.packet.slotPreservation.requiredOrCriticalSlots.find(
		(slot) => slot.slotId === "slot-price",
	);
	assert.equal(priceSlot.observationCount, 1);
	assert.deepEqual(priceSlot.sourceRefs, ["wsrc_cccccccccccccccccccccccccccccccc"]);

	assert.equal(result.packet.precisionGuard.summary.totalClaims, 2);
	assert.equal(result.packet.precisionGuard.summary.flaggedClaims, 2);
	const bundled = result.packet.precisionGuard.claims.find((claim) =>
		claim.issues.includes("bundled_slots"),
	);
	assert(bundled);
	assert.equal(bundled.action, "split_or_narrow_before_verification");
	assert(bundled.issues.includes("compound_or_bundled_text"));
	assert(bundled.issues.includes("normative_language"));
	assert(bundled.issues.includes("overbroad_quantifier"));
	assert(bundled.issues.includes("entity_blend_risk"));
	const sourceWeak = result.packet.precisionGuard.claims.find((claim) =>
		claim.issues.includes("quantitative_without_visible_source"),
	);
	assert.equal(sourceWeak.action, "preserve_or_gap_until_source_backed");
});

test("deep-research normalize input packet distinguishes P1 gap and recommendation risks", async () => {
	const { default: helper } = await import(
		`../../workflows/deep-research/helpers/normalize-input-packet.mjs?test=${Date.now()}`
	);
	const result = await helper({
		sources: {
			"plan.main": {
				depth: "standard",
				taskType: "implementation_guidance",
				expectedFinalShape: "implementation_checklist",
				factSlots: [
					{ id: "slot-provider", label: "Provider carbon export granularity", type: "policy", required: true },
					{ id: "slot-tier", label: "Implementation tiering", type: "policy", required: true },
					{ id: "slot-power", label: "GPU power telemetry", type: "numeric", required: true },
				],
			},
			"research-questions.item-001": {
				extractedFacts: [
					{
						slotId: "slot-provider",
						value: "resource-level emissions",
						sourceRefs: ["wsrc_dddddddddddddddddddddddddddddddd"],
						sourceUrls: ["https://example.test/provider-carbon"],
					},
					{
						slotId: "slot-power",
						value: "milliwatts with architecture caveats",
						sourceRefs: ["wsrc_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"],
						sourceUrls: ["https://example.test/nvml"],
					},
				],
				claims: [
					{
						claim: "Azure exact carbon-export granularity was not established by retrieved evidence.",
						factSlotIds: ["slot-provider"],
						sourceRefs: ["wsrc_dddddddddddddddddddddddddddddddd"],
						sourceUrls: ["https://example.test/provider-carbon"],
					},
					{
						claim:
							"A feasible small-SaaS tiering is API-only proxy logging, provider carbon exports, and self-hosted telemetry.",
						factSlotIds: ["slot-tier"],
						sourceRefs: ["wsrc_dddddddddddddddddddddddddddddddd"],
						sourceUrls: ["https://example.test/provider-carbon"],
					},
					{
						claim:
							"NVML reports GPU power in milliwatts and Ampere except GA100 returns one-second averaged readings.",
						factSlotIds: ["slot-power"],
						sourceRefs: ["wsrc_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"],
						sourceUrls: ["https://example.test/nvml"],
					},
					{
						claim:
							"Vendor guidance recommends separating untrusted data and requiring human approval for high-impact actions.",
						factSlotIds: ["slot-provider"],
						sourceRefs: ["wsrc_dddddddddddddddddddddddddddddddd"],
						sourceUrls: ["https://example.test/provider-carbon"],
					},
				],
			},
		},
	});

	const retrievalGap = result.packet.precisionGuard.claims.find((claim) =>
		claim.issues.includes("retrieval_gap_inference"),
	);
	assert(retrievalGap);
	assert.equal(retrievalGap.action, "verify_only_if_doc_scoped_or_replace_with_positive_source_claim");

	const derivedRecommendation = result.packet.precisionGuard.claims.find((claim) =>
		claim.issues.includes("derived_recommendation"),
	);
	assert(derivedRecommendation);
	assert.equal(derivedRecommendation.action, "split_source_atoms_keep_recommendation_caveated");

	const multiObligation = result.packet.precisionGuard.claims.find(
		(claim) =>
			claim.issues.includes("multi_obligation_claim") &&
			claim.claim?.startsWith("Vendor guidance recommends"),
	);
	assert(multiObligation);
	assert.equal(multiObligation.action, "split_or_narrow_before_verification");

	assert.equal(
		result.packet.precisionGuard.claims.some((claim) => claim.claim?.startsWith("NVML reports GPU power")),
		false,
	);
});

test("deep-research final-audit packet compacts deterministic ledgers", async () => {
	const { default: helper } = await import(
		`../../workflows/deep-research/helpers/final-audit-packet.mjs?test=${Date.now()}`
	);
	const result = await helper({
		sources: {
			"plan.main": {
				depth: "standard",
				taskType: "decision_memo",
				expectedFinalShape: "decision_memo",
				factSlots: [{ id: "slot-001" }, { id: "slot-002" }],
				researchQuestions: [{ id: "q1" }],
			},
			"normalize-claims.main": {
				claimInventory: {
					verificationCandidates: [
						{ id: "claim-001", sourceRefs: ["wsrc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] },
						{ id: "claim-002" },
					],
					preservedClaims: [{ id: "claim-003", claim: "Unverified useful lead" }],
				},
				factSlotCoverage: [
					{ slotId: "slot-001", status: "filled", bestValue: "yes" },
					{ slotId: "slot-002", status: "missing", gapReason: "no primary source" },
				],
				coverageGaps: [{ slotId: "slot-002", reason: "missing source" }],
			},
			"audit-claims.main": {
				verdictCounts: { verified: 1, partiallySupported: 1, unsupported: 0, conflicting: 0 },
				statusPartitions: { verified: ["claim-001"], partiallySupported: ["claim-002"] },
				claimDigests: [
					{ id: "claim-001", claim: "Verified", status: "verified", sourceRefs: ["wsrc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] },
				],
				remainingGaps: [{ claimId: "claim-002", evidenceState: "insufficient_for_verified" }],
				sourceRefJoinFailures: [{ claimId: "claim-002", evidenceState: "source_ref_not_available" }],
				invalidVerifierRows: [{ sourceId: "verify-claims.bad", reason: "missing_claim_id", status: "verified" }],
				duplicateVerifierRows: [{ claimId: "claim-001", rowCount: 2, sourceIds: ["verify-claims.a", "verify-claims.b"], statusInputs: ["verified", "verified"], selectedStatus: "verified" }],
				gateSummary: { missingVerifierResults: 1 },
				slotCoverageCheck: { droppedSlotIds: ["slot-002"] },
			},
		},
	});
	assert.equal(result.schema, "deep-research-final-audit-packet-v1");
	assert.equal(result.packet.researchMetadataSeed.depth, "standard");
	assert.equal(result.packet.verdictCounts.verified, 1);
	assert.equal(result.packet.claimVerdictLedger.length, 1);
	assert.deepEqual(result.packet.statusPartitions.verified, ["claim-001"]);
	assert.deepEqual(result.packet.invariantChecks.omittedCandidateIds, ["claim-002"]);
	assert.deepEqual(result.packet.invariantChecks.droppedSlotIds, ["slot-002"]);
	assert.equal(result.packet.invariantChecks.sourceRefCoverage.sourceRefJoinFailures, 1);
	assert.equal(result.packet.invariantChecks.verifierIntegrity.invalidVerifierRows, 1);
	assert.equal(result.packet.invariantChecks.verifierIntegrity.duplicateVerifierRows, 1);
	assert.equal(result.packet.invariantChecks.verifierIntegrity.missingVerifierResults, 1);
	assert.equal(result.packet.verifierIntegrity.invalidVerifierRows[0].reason, "missing_claim_id");
	assert.equal(result.packet.verifierIntegrity.duplicateVerifierRows[0].claimId, "claim-001");
	assert.equal(result.packet.overflowLedger.omittedVerificationCandidateCount, 1);
	assert.equal(result.packet.overflowLedger.invalidVerifierRowCount, 1);
});

test("deep-research P3 final-audit replay fixture preserves guardrail floors", async () => {
	const fixturePath = join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
		"internal",
		"eval",
		"deep-research-web-source-20260626",
		"fixtures",
		"p3-final-audit-replay.json",
	);
	const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
	const expectations = fixture.expectations;
	assert.equal(fixture.provenance.sourceRunId, "workflow_mqyrg95t_740b57");

	const { default: finalAuditPacket } = await import(
		`../../workflows/deep-research/helpers/final-audit-packet.mjs?test=${Date.now()}`
	);
	const packetResult = await finalAuditPacket({ sources: fixture.sources });
	const packet = packetResult.packet;

	assert.equal(packet.verdictCounts.verified, expectations.verified);
	assert.equal(
		packet.verdictCounts.partiallySupported,
		expectations.partiallySupported,
	);
	assert.equal(packet.verdictCounts.unsupported, expectations.unsupported);
	assert.equal(packet.verdictCounts.conflicting, expectations.conflicting);
	assert.ok(packet.verdictCounts.verified >= expectations.verifiedFloor);
	assert.equal(packet.factSlotCoverage.length, expectations.plannedFactSlots);
	assert.equal(
		packet.factSlotCoverage.filter((slot) => slot.status === "filled").length,
		expectations.filledFactSlots,
	);
	assert.equal(
		packet.factSlotCoverage.filter((slot) => slot.status === "partial").length,
		expectations.partialFactSlots,
	);
	assert.equal(
		packet.factSlotCoverage.filter((slot) => slot.status === "missing").length,
		expectations.missingFactSlots,
	);
	assert.deepEqual(packet.invariantChecks.omittedCandidateIds, []);
	assert.deepEqual(packet.invariantChecks.droppedSlotIds, []);
	assert.equal(
		packet.invariantChecks.sourceRefCoverage.sourceRefJoinFailures,
		expectations.sourceRefJoinFailures,
	);
	assert.equal(packet.invariantChecks.verifierIntegrity.invalidVerifierRows, 0);
	assert.equal(packet.invariantChecks.verifierIntegrity.duplicateVerifierRows, 0);
	assert.equal(packet.invariantChecks.verifierIntegrity.missingVerifierResults, 0);
	assert.equal(packet.overflowLedger.omittedVerificationCandidateCount, 0);

	const plannedSlotIds = fixture.sources["plan.main"].factSlots.map(
		(slot) => slot.id,
	);
	const normalizeSlotIds = fixture.sources[
		"normalize-claims.main"
	].factSlotCoverage.map((slot) => slot.slotId);
	const finalSlotIds = fixture.finalAudit.finalReport.factSlotCoverage.map(
		(slot) => slot.slotId,
	);
	assert.deepEqual(
		plannedSlotIds.filter((slotId) => !normalizeSlotIds.includes(slotId)),
		[],
	);
	assert.deepEqual(
		plannedSlotIds.filter((slotId) => !finalSlotIds.includes(slotId)),
		[],
	);
	assert.deepEqual(finalSlotIds, packet.factSlotCoverage.map((slot) => slot.slotId));
	assert.equal(
		fixture.finalAudit.finalReport.coverageSummary.verified,
		expectations.verified,
	);
	assert.equal(
		fixture.finalAudit.claimVerdictIndex.claims.length,
		expectations.verified,
	);
	assert.equal(
		fixture.finalAudit.claimVerdictIndex.claims.every(
			(claim) => claim.status === "verified",
		),
		true,
	);

	const cwd = makeProject();
	try {
		const helperPath = join(
			dirname(fileURLToPath(import.meta.url)),
			"..",
			"..",
			"workflows",
			"deep-research",
			"helpers",
			"render-executive.mjs",
		);
		const renderExecutive = (
			await import(`${pathToFileURL(helperPath).href}?test=${Date.now()}`)
		).default;
		const rendered = await renderExecutive({
			sources: { "final-audit.main": fixture.finalAudit },
			options: {
				maxWords: 600,
				maxUrls: 5,
				maxFindings: 3,
				maxRecommendations: 3,
				maxGaps: 2,
			},
			context: { cwd, runId: "workflow_p3_fixture", taskId: "task-final" },
		});
		assert.equal(rendered.status, "passed");
		assert.equal(rendered.gates.passed, true);
		assert.equal(rendered.claimSummary.verified, expectations.verified);
		assert.equal(rendered.factSlotSummary.total, expectations.plannedFactSlots);
		assert.equal(
			rendered.factSlotSummary.missingOrConflicting,
			expectations.missingFactSlots,
		);
		assert.equal(rendered.sourceUrlCount <= rendered.gates.maxUrls, true);
		assert.doesNotMatch(
			JSON.stringify(rendered),
			/\/Users\/|\.pi\/workflows|web-source-cache/,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("deep-research executive renderer emits bounded final and sidecar", async () => {
	const cwd = makeProject();
	try {
		const helperPath = join(
			dirname(fileURLToPath(import.meta.url)),
			"..",
			"..",
			"workflows",
			"deep-research",
			"helpers",
			"render-executive.mjs",
		);
		const helper = (
			await import(`${pathToFileURL(helperPath).href}?test=${Date.now()}`)
		).default;
		const result = await helper({
			sources: {
				"final-audit.main": {
					digest: "Audited research digest",
					finalReport: {
						summary:
							"Use the deterministic executive final for the parent handoff and keep the full audit in final-audit.control.json.",
						factSlotCoverage: [
							{ slotId: "slot-001", status: "filled" },
							{ slotId: "slot-002", status: "partial" },
							{ slotId: "slot-003", status: "missing" },
						],
						mainFindings: [
							{
								finding:
									"The final support stage renders executiveMarkdown from the full audit control artifact.",
								sourceUrls: ["https://example.test/spec"],
							},
						],
						recommendations: [
							{
								recommendation:
									"Read executive.md first, then inspect final-audit.control.json for claim-level evidence.",
								sourceUrls: ["https://example.test/audit"],
							},
						],
						remainingGaps: [
							{ gap: "Run a larger holdout before making superiority claims." },
						],
					},
					claimVerdictIndex: {
						claims: [
							{ id: "claim-001", status: "verified" },
							{ id: "claim-002", status: "partially_supported" },
						],
					},
				},
			},
			options: {
				maxWords: 120,
				maxUrls: 1,
				maxFindings: 1,
				maxRecommendations: 1,
				maxGaps: 1,
			},
			context: { cwd, runId: "workflow_exec", taskId: "task-final" },
		});

		assert.equal(result.schema, "deep-research-executive-render-v1");
		assert.equal(result.status, "passed");
		assert.equal(result.gates.passed, true);
		assert.ok(result.wordCount <= 120);
		assert.ok(result.sourceUrlCount <= 1);
		assert.equal(result.auditArtifact, "final-audit.control.json");
		assert.match(result.executiveMarkdown, /# Executive summary/);
		assert.match(result.executiveMarkdown, /Audit trail/);
		assert.equal(result.claimSummary.verified, 1);
		assert.equal(result.factSlotSummary.missingOrConflicting, 1);
		assert.equal(result.sidecarPath, "executive.md");
		assert.doesNotMatch(JSON.stringify(result), /\/Users\/|\.pi\/workflows|web-source-cache/);
		assert.equal(
			readFileSync(
				join(
					cwd,
					".pi",
					"workflows",
					"workflow_exec",
					"tasks",
					"task-final",
					"executive.md",
				),
				"utf8",
			),
			`${result.executiveMarkdown}\n`,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("deep-research executive renderer preserves object gaps zeros and recommendation labels", async () => {
	const cwd = makeProject();
	try {
		const helperPath = join(
			dirname(fileURLToPath(import.meta.url)),
			"..",
			"..",
			"workflows",
			"deep-research",
			"helpers",
			"render-executive.mjs",
		);
		const helper = (
			await import(`${pathToFileURL(helperPath).href}?test=${Date.now()}`)
		).default;
		const result = await helper({
			sources: {
				"final-audit.main": {
					digest: "Zero-count audit digest",
					finalReport: {
						summary: "No claims were promoted after deterministic checks.",
						coverageSummary: {
							verificationCandidates: 0,
							verified: 0,
							partiallySupported: 0,
							unsupported: 0,
							conflicting: 0,
						},
						recommendations: [
							{ recommendation: "Use measured telemetry before estimates." },
							{
								recommendation: "Keep cited methodology in the audit trail.",
								sourceUrls: ["https://example.test/method"],
							},
						],
						remainingGaps: {
							blocking: [{ gap: "Verify any claim before promoting it." }],
							nonBlocking: ["Keep a human domain review before public claims."],
						},
					},
					claimVerdictIndex: {
						claims: [{ id: "claim-legacy", status: "verified" }],
					},
				},
			},
			options: {
				maxWords: 160,
				maxUrls: 2,
				maxFindings: 0,
				maxRecommendations: 2,
				maxGaps: 2,
			},
			context: { cwd, runId: "workflow_exec", taskId: "task-final" },
		});

		assert.equal(result.status, "passed");
		assert.equal(result.claimSummary.total, 0);
		assert.equal(result.claimSummary.verified, 0);
		assert.match(result.executiveMarkdown, /evidence: not explicitly cited/);
		assert.match(result.executiveMarkdown, /Verify any claim before promoting it/);
		assert.match(result.executiveMarkdown, /human domain review/);
		assert.equal(result.sidecarPath, "executive.md");
		assert.doesNotMatch(JSON.stringify(result), /\/Users\/|\.pi\/workflows|web-source-cache/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("deep-research executive renderer fails gate when truncating open gaps", async () => {
	const helperPath = join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
		"workflows",
		"deep-research",
		"helpers",
		"render-executive.mjs",
	);
	const helper = (
		await import(`${pathToFileURL(helperPath).href}?test=${Date.now()}`)
	).default;
	const result = await helper({
		sources: {
			"final-audit.main": {
				digest:
					"This summary is intentionally verbose so the bounded renderer truncates before all caveats can be displayed safely to the parent consumer.",
				finalReport: {
					summary:
						"This summary is intentionally verbose so the bounded renderer truncates before all caveats can be displayed safely to the parent consumer.",
					remainingGaps: [{ gap: "This open gap must not be silently hidden." }],
				},
				claimVerdictIndex: { claims: [] },
			},
		},
		options: { maxWords: 12, maxUrls: 1, maxFindings: 0, maxRecommendations: 0, maxGaps: 1 },
		context: {},
	});

	assert.equal(result.status, "failed");
	assert.equal(result.gates.truncated, true);
	assert.equal(result.gates.truncatedWithOpenGaps, true);
	assert.equal(result.gates.passed, false);
});

test("deep-research executive renderer blocks without audit control", async () => {
	const helperPath = join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
		"workflows",
		"deep-research",
		"helpers",
		"render-executive.mjs",
	);
	const helper = (
		await import(`${pathToFileURL(helperPath).href}?test=${Date.now()}`)
	).default;
	const result = await helper({ sources: {}, options: {}, context: {} });

	assert.equal(result.status, "blocked");
	assert.equal(result.gates.passed, false);
	assert.deepEqual(result.blockers, ["missing final-audit control source"]);
});

test("artifactGraph runtime support executes helper and writes artifacts", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "audit.mjs"),
			"export default async function helper({ sources, options, context }) { return { audited: sources.extract.claims.length, strict: options.strict, stageId: context.stageId, analysis: 'Audit helper summary.', refs: ['README.md'] }; }\n",
		);
		const spec = workflowSpec("unit-scout", {
			artifactGraph: {
				stages: [
					{
						id: "extract",
						type: "single",
						output: { format: "json" },
						prompt: "Extract",
					},
					{
						id: "audit",
						from: "extract",
						support: {
							uses: "./helpers/audit.mjs",
							options: { strict: true },
						},
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Check claims",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		writeFileSync(
			join(workflowDir, "helpers", "audit.mjs"),
			"export default async function helper() { throw new Error('live helper should not run'); }\n",
		);
		await completeTask(cwd, run.tasks[0], { claims: ["a", "b"] });
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		const updated = await readRunRecord(cwd, run.runId);
		const support = updated.tasks.find((task) => task.specId === "audit.main");
		assert.equal(support?.kind, "support");
		assert.equal(support?.status, "completed");
		assert.equal(support?.statusDetail, "support_completed");
		assert.equal(support?.lastMessage, "support completed");
		const supportDir = dirname(join(cwd, support.files.result));
		assert.deepEqual(
			JSON.parse(readFileSync(join(supportDir, "control.json"), "utf8")),
			{
				schema: "stage-control-v1",
				digest: "Support helper completed.",
				audited: 2,
				strict: true,
				stageId: "audit",
				analysis: "Audit helper summary.",
				refs: ["README.md"],
			},
		);
		assert.equal(
			readFileSync(join(supportDir, "analysis.md"), "utf8").trim(),
			"Audit helper summary.",
		);
		assert.deepEqual(
			JSON.parse(readFileSync(join(supportDir, "refs.json"), "utf8")),
			["README.md"],
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph runtime support omits failed control sources but passes status metadata", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "sources.mjs"),
			"export default async function helper({ sources, context }) { return { sourceKeys: Object.keys(sources).sort(), sourceStatuses: context.sourceStatuses, failedSource: sources.extractFailed ?? null, okSource: sources.extractOk }; }\n",
		);
		const spec = workflowSpec("unit-scout", {
			artifactGraph: {
				stages: [
					{
						id: "extractOk",
						type: "single",
						prompt: "Extract OK",
					},
					{
						id: "extractFailed",
						type: "single",
						after: [],
						prompt: "Extract failed",
					},
					{
						id: "audit",
						from: ["extractOk", "extractFailed"],
						sourcePolicy: "partial",
						support: { uses: "./helpers/sources.mjs" },
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Check claims",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		const ok = run.tasks.find((task) => task.specId === "extractOk.main");
		const failed = run.tasks.find(
			(task) => task.specId === "extractFailed.main",
		);
		assert.ok(ok);
		assert.ok(failed);
		await completeTask(cwd, ok, { claims: ["kept"] });
		setTaskTerminal(failed, "failed", "failed", {
			exitCode: 1,
			lastMessage: "failed",
		});
		mkdirSync(dirname(join(cwd, failed.files.output)), { recursive: true });
		writeFileSync(join(cwd, failed.files.output), "failed raw source\n");
		await writeJsonAtomic(join(cwd, failed.files.result), { status: "failed" });
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		const updated = await readRunRecord(cwd, run.runId);
		const support = updated.tasks.find((task) => task.specId === "audit.main");
		assert.equal(support?.status, "completed");
		const control = JSON.parse(
			readFileSync(
				join(dirname(join(cwd, support.files.result)), "control.json"),
				"utf8",
			),
		);
		assert.deepEqual(control, {
			schema: "stage-control-v1",
			digest: "Support helper completed.",
			failedSource: null,
			okSource: {
				schema: "stage-control-v1",
				digest: "extractOk completed",
				claims: ["kept"],
			},
			sourceKeys: ["extractOk"],
			sourceStatuses: [
				{
					source: "extractOk",
					displayName: "extractOk.main",
					taskId: ok.taskId,
					specId: "extractOk.main",
					stageId: "extractOk",
					status: "completed",
					statusDetail: "completed",
					lastMessage: "completed",
				},
				{
					source: "extractFailed",
					displayName: "extractFailed.main",
					taskId: failed.taskId,
					specId: "extractFailed.main",
					stageId: "extractFailed",
					status: "failed",
					statusDetail: "failed",
					lastMessage: "failed",
					errorType: "failed",
				},
			],
		});
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph runtime support marks helper errors as failed", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "fail.mjs"),
			"export default async function helper() { throw new Error('helper boom'); }\n",
		);
		const spec = workflowSpec("unit-scout", {
			artifactGraph: {
				stages: [
					{
						id: "extract",
						type: "single",
						output: { format: "json" },
						prompt: "Extract",
					},
					{
						id: "audit",
						from: "extract",
						support: { uses: "./helpers/fail.mjs" },
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Check claims",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		setTaskTerminal(run.tasks[0], "completed", "completed", {
			exitCode: 0,
			lastMessage: "completed",
		});
		await writeJsonAtomic(join(cwd, run.tasks[0].files.result), {
			status: "completed",
			structuredOutput: { claims: ["a"] },
		});
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		const updated = await readRunRecord(cwd, run.runId);
		const support = updated.tasks.find((task) => task.specId === "audit.main");
		assert.equal(support?.kind, "support");
		assert.equal(support?.status, "failed");
		assert.equal(support?.statusDetail, "support_failed");
		assert.match(support?.lastMessage ?? "", /helper boom/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph runtime scheduler launches empty-after roots in parallel", async () => {
	const cwd = makeProject();
	const prompts = [];
	try {
		writeAgent(cwd, "unit-scout", "read");
		setSubagentApiForTests({
			async runSubagent(options) {
				prompts.push(String(options.task ?? ""));
				return {
					runId: `run_stub_${prompts.length}`,
					attemptId: `attempt_stub_${prompts.length}`,
					status: "running",
				};
			},
			async getSubagentStatus() {
				return null;
			},
			async reconcileSubagentRun() {
				return {};
			},
			async interruptSubagent() {
				return {};
			},
		});
		const spec = workflowSpec("unit-scout", {
			artifactGraph: {
				stages: [
					{ id: "a", type: "single", prompt: "A." },
					{ id: "b", type: "single", after: [], prompt: "B." },
					{ id: "c", type: "single", from: ["a", "b"], prompt: "C." },
				],
			},
		});
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Check scheduling",
		});
		const { run } = await createWorkflowRunRecord(
			cwd,
			compiled,
			join(cwd, "workflows", "unit.json"),
		);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);

		const updated = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(updated, "a.main").status, "running");
		assert.equal(taskBySpec(updated, "b.main").status, "running");
		assert.equal(taskBySpec(updated, "c.main").status, "pending");
		assert.equal(prompts.length, 2);
		assert(prompts.some((prompt) => prompt.includes("stage=a")));
		assert(prompts.some((prompt) => prompt.includes("stage=b")));
		assert(!prompts.some((prompt) => prompt.includes("stage=c")));
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph runtime after dependencies do not inject order-only source context", async () => {
	const cwd = makeProject();
	const prompts = [];
	try {
		writeAgent(cwd, "unit-scout", "read");
		setSubagentApiForTests({
			async runSubagent(options) {
				prompts.push(String(options.task ?? ""));
				return {
					runId: `run_stub_${prompts.length}`,
					attemptId: `attempt_stub_${prompts.length}`,
					status: "running",
				};
			},
			async getSubagentStatus() {
				return null;
			},
			async reconcileSubagentRun() {
				return {};
			},
			async interruptSubagent() {
				return {};
			},
		});
		const spec = workflowSpec("unit-scout", {
			artifactGraph: {
				stages: [
					{
						id: "source",
						type: "single",
						output: { format: "json" },
						prompt: "Source.",
					},
					{
						id: "gate",
						type: "single",
						output: { format: "json" },
						prompt: "Gate.",
					},
					{
						id: "afterOnly",
						type: "single",
						after: "gate",
						prompt: "After only.",
					},
					{
						id: "mixed",
						type: "single",
						from: "source",
						after: "gate",
						prompt: "Mixed.",
					},
				],
			},
		});
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Check context",
		});
		const { run } = await createWorkflowRunRecord(
			cwd,
			compiled,
			join(cwd, "workflows", "unit.json"),
		);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);

		await completeTask(cwd, taskBySpec(run, "source.main"), {
			content: "source completed",
		});
		await completeTask(cwd, taskBySpec(run, "gate.main"), {
			content: "after-source-content",
		});
		for (const task of [
			taskBySpec(run, "source.main"),
			taskBySpec(run, "gate.main"),
		]) {
			mkdirSync(dirname(join(cwd, task.files.output)), { recursive: true });
			writeFileSync(
				join(cwd, task.files.output),
				task.specId === "source.main"
					? "source completed\n"
					: "after-source-content\n",
			);
		}
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);

		const afterOnlyPrompt = prompts.find((prompt) =>
			prompt.includes("stage=afterOnly"),
		);
		const mixedPrompt = prompts.find((prompt) =>
			prompt.includes("stage=mixed"),
		);
		assert(afterOnlyPrompt);
		assert(mixedPrompt);
		assert.match(afterOnlyPrompt, /# Workflow Artifact Inputs/);
		assert.doesNotMatch(afterOnlyPrompt, /source completed/);
		assert.match(mixedPrompt, /# Workflow Artifact Inputs/);
		assert.match(mixedPrompt, /source completed/);
		assert.doesNotMatch(mixedPrompt, /after-source-content/);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph runtime diamond fan-out launches branches in parallel and joins context", async () => {
	const cwd = makeProject();
	const prompts = [];
	try {
		writeAgent(cwd, "unit-scout", "read");
		captureSubagentPrompts(prompts);
		const spec = workflowSpec("unit-scout", {
			artifactGraph: {
				stages: [
					{
						id: "a",
						type: "single",
						output: { format: "json" },
						prompt: "A.",
					},
					{
						id: "b",
						type: "single",
						from: "a",
						output: { format: "json" },
						prompt: "B.",
					},
					{
						id: "c",
						type: "single",
						from: "a",
						output: { format: "json" },
						prompt: "C.",
					},
					{
						id: "d",
						type: "reduce",
						from: ["b", "c"],
						prompt: "D.",
					},
				],
			},
		});
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Check diamond",
		});
		const { run } = await createWorkflowRunRecord(
			cwd,
			compiled,
			join(cwd, "workflows", "unit.json"),
		);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		let current = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(current, "a.main").status, "running");
		assert.equal(taskBySpec(current, "b.main").status, "pending");
		assert.equal(taskBySpec(current, "c.main").status, "pending");
		assert.equal(taskBySpec(current, "d.main").status, "pending");
		assert.equal(prompts.length, 1);

		await completeTask(cwd, taskBySpec(current, "a.main"), {
			marker: "a completed",
		});
		await writeRunRecord(cwd, current);

		await scheduleRun(cwd, run.runId);
		current = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(current, "b.main").status, "running");
		assert.equal(taskBySpec(current, "c.main").status, "running");
		assert.equal(taskBySpec(current, "d.main").status, "pending");
		assert.equal(prompts.length, 3);
		assert(prompts.some((prompt) => prompt.includes("stage=b")));
		assert(prompts.some((prompt) => prompt.includes("stage=c")));

		await completeTask(cwd, taskBySpec(current, "b.main"), {
			marker: "b completed",
		});
		await completeTask(cwd, taskBySpec(current, "c.main"), {
			marker: "c completed",
		});
		await writeRunRecord(cwd, current);

		await scheduleRun(cwd, run.runId);
		current = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(current, "d.main").status, "running");
		const joinPrompt = prompts.find((prompt) => prompt.includes("stage=d"));
		assert(joinPrompt);
		assert.match(joinPrompt, /# Workflow Artifact Inputs/);
		assert.match(joinPrompt, /b completed/);
		assert.match(joinPrompt, /c completed/);
		assert.doesNotMatch(joinPrompt, /a completed/);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph runtime dag container waits for outer sources and skips strict dependents", async () => {
	const cwd = makeProject();
	const prompts = [];
	try {
		writeAgent(cwd, "unit-scout", "read");
		captureSubagentPrompts(prompts);
		const spec = dagContainerRuntimeSpec();
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Check strict container",
		});
		const { run } = await createWorkflowRunRecord(
			cwd,
			compiled,
			join(cwd, "workflows", "unit.json"),
		);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		let current = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(current, "setup.main").status, "running");
		assert.equal(taskBySpec(current, "analysis.scan.main").status, "pending");
		assert(!prompts.some((prompt) => prompt.includes("stage=analysis.scan")));

		await completeTask(cwd, taskBySpec(current, "setup.main"), {
			marker: "setup completed",
		});
		await writeRunRecord(cwd, current);

		await scheduleRun(cwd, run.runId);
		current = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(current, "analysis.scan.main").status, "running");
		assert.equal(taskBySpec(current, "analysis.review.main").status, "pending");
		assert.equal(taskBySpec(current, "analysis.final.main").status, "pending");
		assert.equal(taskBySpec(current, "report.main").status, "pending");
		const scanPrompt = prompts.find((prompt) =>
			prompt.includes("stage=analysis.scan"),
		);
		assert(scanPrompt);
		assert.match(scanPrompt, /# Workflow Artifact Inputs/);
		assert.match(scanPrompt, /setup completed/);

		await completeTask(
			cwd,
			taskBySpec(current, "analysis.scan.main"),
			{ marker: "scan-failed-output" },
			"failed",
		);
		await writeRunRecord(cwd, current);

		await scheduleRun(cwd, run.runId);
		current = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(current, "analysis.scan.main").status, "failed");
		assert.equal(taskBySpec(current, "analysis.review.main").status, "skipped");
		assert.equal(taskBySpec(current, "analysis.final.main").status, "skipped");
		assert.equal(taskBySpec(current, "report.main").status, "skipped");
		assert.equal(current.status, "failed");
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifactGraph runtime partial dag join proceeds and exposes outputFrom downstream", async () => {
	const cwd = makeProject();
	const prompts = [];
	try {
		writeAgent(cwd, "unit-scout", "read");
		captureSubagentPrompts(prompts);
		const spec = dagContainerRuntimeSpec({
			finalSourcePolicy: "partial",
			reportSourcePolicy: "partial",
		});
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Check partial container",
		});
		const { run } = await createWorkflowRunRecord(
			cwd,
			compiled,
			join(cwd, "workflows", "unit.json"),
		);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		let current = await readRunRecord(cwd, run.runId);
		await completeTask(cwd, taskBySpec(current, "setup.main"), {
			marker: "setup completed",
		});
		await writeRunRecord(cwd, current);

		await scheduleRun(cwd, run.runId);
		current = await readRunRecord(cwd, run.runId);
		await completeTask(
			cwd,
			taskBySpec(current, "analysis.scan.main"),
			{ marker: "scan-failed-output" },
			"failed",
		);
		await writeRunRecord(cwd, current);

		await scheduleRun(cwd, run.runId);
		current = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(current, "analysis.scan.main").status, "failed");
		assert.equal(taskBySpec(current, "analysis.review.main").status, "skipped");
		assert.equal(taskBySpec(current, "analysis.final.main").status, "running");
		assert.equal(taskBySpec(current, "report.main").status, "pending");
		const finalPrompt = prompts.find((prompt) =>
			prompt.includes("stage=analysis.final"),
		);
		assert(finalPrompt);
		assert.match(finalPrompt, /# Workflow Artifact Inputs/);
		assert.doesNotMatch(finalPrompt, /scan-failed-output/);

		await completeTask(cwd, taskBySpec(current, "analysis.final.main"), {
			marker: "analysis.final completed",
		});
		await writeRunRecord(cwd, current);

		await scheduleRun(cwd, run.runId);
		current = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(current, "report.main").status, "running");
		const reportPrompt = prompts.find((prompt) =>
			prompt.includes("stage=report"),
		);
		assert(reportPrompt);
		assert.match(reportPrompt, /# Workflow Artifact Inputs/);
		assert.match(reportPrompt, /analysis.final completed/);
		assert.doesNotMatch(reportPrompt, /scan-failed-output/);
		assert.doesNotMatch(reportPrompt, /analysis.scan.main/);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("resumeRun resets failed dag container children and relaunches roots", async () => {
	const cwd = makeProject();
	const prompts = [];
	try {
		writeAgent(cwd, "unit-scout", "read");
		captureSubagentPrompts(prompts);
		const spec = dagContainerRuntimeSpec();
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Resume container",
		});
		const { run } = await createWorkflowRunRecord(
			cwd,
			compiled,
			join(cwd, "workflows", "unit.json"),
		);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);
		let current = await readRunRecord(cwd, run.runId);
		await completeTask(cwd, taskBySpec(current, "setup.main"), {
			marker: "setup completed",
		});
		await writeRunRecord(cwd, current);

		await scheduleRun(cwd, run.runId);
		current = await readRunRecord(cwd, run.runId);
		await completeTask(
			cwd,
			taskBySpec(current, "analysis.scan.main"),
			{ marker: "scan-failed-output" },
			"failed",
		);
		await writeRunRecord(cwd, current);

		await scheduleRun(cwd, run.runId);
		const failed = await readRunRecord(cwd, run.runId);
		assert.equal(failed.status, "failed");
		const expectedResetTaskIds = [
			"analysis.scan.main",
			"analysis.review.main",
			"analysis.final.main",
			"report.main",
		].map((specId) => taskBySpec(failed, specId).taskId);

		prompts.length = 0;
		const { run: resumed, resetTaskIds } = await resumeRun(cwd, run.runId);
		assert.deepEqual(resetTaskIds, expectedResetTaskIds);
		assert.equal(resumed.status, "running");
		assert.equal(taskBySpec(resumed, "setup.main").status, "completed");
		assert.equal(taskBySpec(resumed, "analysis.scan.main").status, "running");
		assert.equal(taskBySpec(resumed, "analysis.review.main").status, "pending");
		assert.equal(taskBySpec(resumed, "analysis.final.main").status, "pending");
		assert.equal(taskBySpec(resumed, "report.main").status, "pending");
		assert.equal(prompts.length, 1);
		assert.match(prompts[0], /stage=analysis\.scan/);
		assert.match(prompts[0], /setup completed/);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("subagent launch forwards tool-call capture only when env is enabled", async () => {
	const cwd = makeProject();
	const previous = process.env.PI_WORKFLOW_CAPTURE_TOOL_CALLS;
	const captured = [];
	try {
		writeAgent(cwd, "unit-scout", "read");
		setSubagentApiForTests({
			async runSubagent(options) {
				captured.push(options);
				return {
					runId: `run_stub_${captured.length}`,
					attemptId: `attempt_stub_${captured.length}`,
					status: "running",
				};
			},
			async getSubagentStatus() {
				return null;
			},
			async reconcileSubagentRun() {
				return {};
			},
			async interruptSubagent() {
				return {};
			},
		});

		const spec = workflowSpec("unit-scout", {
			artifactGraph: {
				stages: [{ id: "main", type: "single", prompt: "Do work." }],
			},
		});
		const compiled = await compileWorkflow(spec, { cwd, task: "Review topic" });

		delete process.env.PI_WORKFLOW_CAPTURE_TOOL_CALLS;
		const first = await createWorkflowRunRecord(
			cwd,
			compiled,
			join(cwd, "workflows", "unit-a.json"),
		);
		await writeStaticRunArtifacts(cwd, first.run, compiled, spec);
		await writeRunRecord(cwd, first.run);
		await scheduleRun(cwd, first.run.runId);
		assert.equal(captured[0].captureToolCalls, undefined);

		process.env.PI_WORKFLOW_CAPTURE_TOOL_CALLS = "1";
		const second = await createWorkflowRunRecord(
			cwd,
			compiled,
			join(cwd, "workflows", "unit-b.json"),
		);
		await writeStaticRunArtifacts(cwd, second.run, compiled, spec);
		await writeRunRecord(cwd, second.run);
		await scheduleRun(cwd, second.run.runId);
		assert.equal(captured[1].captureToolCalls, true);
	} finally {
		if (previous === undefined)
			delete process.env.PI_WORKFLOW_CAPTURE_TOOL_CALLS;
		else process.env.PI_WORKFLOW_CAPTURE_TOOL_CALLS = previous;
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("subagent launch loads provider extensions for extension-backed tools", async () => {
	const cwd = makeProject();
	let captured;
	try {
		writeAgent(
			cwd,
			"unit-researcher",
			"read, web_search, fetch_content, get_search_content",
		);
		setSubagentApiForTests({
			async runSubagent(options) {
				captured = options;
				return {
					runId: "run_stub",
					attemptId: "attempt_stub",
					status: "running",
				};
			},
			async getSubagentStatus() {
				return null;
			},
			async reconcileSubagentRun() {
				return {};
			},
			async interruptSubagent() {
				return {};
			},
		});

		const spec = workflowSpec("unit-researcher", {
			tools: ["read", "web_search", "fetch_content", "get_search_content"],
			artifactGraph: {
				stages: [
					{ id: "main", type: "single", prompt: "Research with web tools." },
				],
			},
		});
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Research topic",
		});
		const { run } = await createWorkflowRunRecord(
			cwd,
			compiled,
			join(cwd, "workflows", "unit.json"),
		);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);
		await scheduleRun(cwd, run.runId);

		assert(
			captured.extensions.some((entry) =>
				entry.endsWith("workflow-fetch-cache-extension.ts"),
			),
		);
		assert(
			captured.extensions.some((entry) =>
				entry.endsWith("workflow-artifact-extension.ts"),
			),
		);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("subagent launch appends extra extensions from env", async () => {
	const cwd = makeProject();
	const previous = process.env.PI_WORKFLOW_SUBAGENT_EXTRA_EXTENSIONS;
	let captured;
	try {
		process.env.PI_WORKFLOW_SUBAGENT_EXTRA_EXTENSIONS =
			"/tmp/pi-telemetry-extension.mjs";
		writeAgent(cwd, "unit-researcher", "read, fetch_content");
		setSubagentApiForTests({
			async runSubagent(options) {
				captured = options;
				return {
					runId: "run_stub",
					attemptId: "attempt_stub",
					status: "running",
				};
			},
			async getSubagentStatus() {
				return null;
			},
			async reconcileSubagentRun() {
				return {};
			},
			async interruptSubagent() {
				return {};
			},
		});

		const spec = workflowSpec("unit-researcher", {
			tools: ["read", "fetch_content"],
			artifactGraph: {
				stages: [
					{ id: "main", type: "single", prompt: "Research with fetch." },
				],
			},
		});
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Research topic",
		});
		const { run } = await createWorkflowRunRecord(
			cwd,
			compiled,
			join(cwd, "workflows", "unit.json"),
		);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);
		await scheduleRun(cwd, run.runId);

		assert(
			captured.extensions.some((entry) =>
				entry.endsWith("workflow-fetch-cache-extension.ts"),
			),
		);
		assert(captured.extensions.includes("/tmp/pi-telemetry-extension.mjs"));
		assert(
			captured.extensions.some((entry) =>
				entry.endsWith("workflow-artifact-extension.ts"),
			),
		);
	} finally {
		if (previous === undefined)
			delete process.env.PI_WORKFLOW_SUBAGENT_EXTRA_EXTENSIONS;
		else process.env.PI_WORKFLOW_SUBAGENT_EXTRA_EXTENSIONS = previous;
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("workflow fetch_content cache wrapper replays run-scoped hits with fresh response ids", async () => {
	const cwd = makeProject();
	try {
		const cacheDir = join(
			cwd,
			".pi",
			"workflows",
			"workflow_unit",
			"source-cache",
			"fetch-content",
		);
		const registered = new Map();
		const appended = [];
		const stored = new Map();
		let originCalls = 0;
		let generatedIds = 0;
		const storage = {
			generateId() {
				generatedIds += 1;
				return `cached-${generatedIds}`;
			},
			storeResult(id, data) {
				stored.set(id, data);
			},
		};
		const fakePi = {
			registerTool(tool) {
				registered.set(tool.name, tool);
			},
			appendEntry(type, data) {
				appended.push({ type, data });
			},
		};
		const webAccessExtension = (pi) => {
			pi.registerTool({
				name: "fetch_content",
				async execute(_toolCallId, params) {
					originCalls += 1;
					const responseId = `origin-${originCalls}`;
					const data = {
						id: responseId,
						type: "fetch",
						timestamp: Date.now(),
						urls: [
							{
								url: params.url,
								title: "Example",
								content: "cached body",
							},
						],
					};
					storage.storeResult(responseId, data);
					pi.appendEntry("web-search-results", data);
					return {
						content: [{ type: "text", text: `body via ${responseId}` }],
						details: {
							urls: [params.url],
							urlCount: 1,
							successful: 1,
							responseId,
							totalChars: 11,
						},
					};
				},
			});
		};
		registerWorkflowFetchCacheExtension(
			fakePi,
			{ runId: "workflow_unit", taskId: "task-1", cacheDir },
			webAccessExtension,
			storage,
		);

		const tool = registered.get("fetch_content");
		const first = await tool.execute("call-1", { url: "https://example.test" });
		const second = await tool.execute("call-2", {
			url: "https://example.test",
		});

		assert.equal(originCalls, 1);
		assert.equal(first.details.cache.hit, false);
		assert.equal(second.details.cache.hit, true);
		assert.equal(second.details.responseId, "cached-1");
		assert.match(second.content[0].text, /cached-1/);
		assert.equal(stored.has("cached-1"), true);
		assert.equal(appended.at(-1).data.id, "cached-1");
		assert.equal(existsSync(join(cacheDir, "events.jsonl")), true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("subagent launch can opt out of fetch cache and keep built-in provider mappings", async () => {
	const cwd = makeProject();
	let captured;
	const previousFetchCache = process.env.PI_WORKFLOW_FETCH_CONTENT_CACHE;
	try {
		process.env.PI_WORKFLOW_FETCH_CONTENT_CACHE = "0";
		writeAgent(cwd, "unit-researcher", "read, fetch_content, scrapling_fetch");
		setSubagentApiForTests({
			async runSubagent(options) {
				captured = options;
				return {
					runId: "run_stub",
					attemptId: "attempt_stub",
					status: "running",
				};
			},
			async getSubagentStatus() {
				return null;
			},
			async reconcileSubagentRun() {
				return {};
			},
			async interruptSubagent() {
				return {};
			},
		});

		const spec = workflowSpec("unit-researcher", {
			tools: [
				"read",
				"fetch_content",
				{
					name: "scrapling_fetch",
					extensions: ["packages/pi-scrapling-access"],
					classification: "read-only",
				},
			],
			artifactGraph: {
				stages: [
					{
						id: "main",
						type: "single",
						prompt: "Research with custom fetch fallback.",
					},
				],
			},
		});
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Research topic",
		});
		const { run } = await createWorkflowRunRecord(
			cwd,
			compiled,
			join(cwd, "workflows", "unit.json"),
		);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);
		await scheduleRun(cwd, run.runId);

		assert.deepEqual(captured.tools, [
			"read",
			"fetch_content",
			"scrapling_fetch",
			"workflow_artifact",
		]);
		assert(captured.extensions.some(isBundledPiWebAccessExtension));
		assert(captured.extensions.includes("packages/pi-scrapling-access"));
		assert(
			captured.extensions.some((entry) =>
				entry.endsWith("workflow-artifact-extension.ts"),
			),
		);
	} finally {
		if (previousFetchCache === undefined)
			delete process.env.PI_WORKFLOW_FETCH_CONTENT_CACHE;
		else process.env.PI_WORKFLOW_FETCH_CONTENT_CACHE = previousFetchCache;
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("subagent launch uses generated fetch cache extension by default", async () => {
	const cwd = makeProject();
	let captured;
	const previousFetchCache = process.env.PI_WORKFLOW_FETCH_CONTENT_CACHE;
	try {
		delete process.env.PI_WORKFLOW_FETCH_CONTENT_CACHE;
		writeAgent(cwd, "unit-researcher", "read, fetch_content, web_search");
		setSubagentApiForTests({
			async runSubagent(options) {
				captured = options;
				return {
					runId: "run_stub",
					attemptId: "attempt_stub",
					status: "running",
				};
			},
			async getSubagentStatus() {
				return null;
			},
			async reconcileSubagentRun() {
				return {};
			},
			async interruptSubagent() {
				return {};
			},
		});

		const spec = workflowSpec("unit-researcher", {
			tools: ["read", "fetch_content", "web_search"],
			artifactGraph: {
				stages: [
					{
						id: "main",
						type: "single",
						prompt: "Research with cached fetch.",
					},
				],
			},
		});
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Research topic",
		});
		const { run } = await createWorkflowRunRecord(
			cwd,
			compiled,
			join(cwd, "workflows", "unit.json"),
		);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);
		await scheduleRun(cwd, run.runId);

		assert.equal(captured.tools.includes("fetch_content"), true);
		assert.equal(
			captured.extensions.some(isBundledPiWebAccessExtension),
			false,
		);
		assert(
			captured.extensions.some((entry) =>
				entry.endsWith("workflow-fetch-cache-extension.ts"),
			),
		);
	} finally {
		if (previousFetchCache === undefined)
			delete process.env.PI_WORKFLOW_FETCH_CONTENT_CACHE;
		else process.env.PI_WORKFLOW_FETCH_CONTENT_CACHE = previousFetchCache;
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("workflow web-source core redacts URLs and reads normalized snippets", async () => {
	const cwd = makeProject();
	try {
		const config = {
			runId: "workflow_unit",
			taskId: "task-1",
			cacheDir: join(cwd, ".pi", "workflows", "workflow_unit", "web-source-cache"),
		};
		assert.equal(
			validateWorkflowWebUrl("file:///etc/passwd").ok,
			false,
		);
		assert.equal(
			validateWorkflowWebUrl("http://169.254.169.254/latest/meta-data").ok,
			false,
		);
		assert.equal(validateWorkflowWebUrl("http://[::1]/").ok, false);
		assert.equal(validateWorkflowWebUrl("http://[::ffff:7f00:1]/").ok, false);
		assert.equal(validateWorkflowWebUrl("http://100.64.0.1/").ok, false);
		assert.equal(validateWorkflowWebUrl("http://198.18.0.1/").ok, false);
		assert.equal(
			sanitizeUrlForModel("https://user:pass@example.test/path?token=secret&ok=1#access_token=secret"),
			"https://example.test/path?token=REDACTED&ok=1#access_token=REDACTED",
		);
		const embeddedRedacted = sanitizeUrlForModel("See https://user:pass@example.test/path?token=secret&ok=1 for details");
		assert.doesNotMatch(embeddedRedacted, /user|pass|secret/);
		assert.match(embeddedRedacted, /https:\/\/example\.test\/path\?token=REDACTED&ok=1/);
		const source = createWorkflowWebSource({
			config,
			url: "https://example.test/report?signature=secret#section",
			text: "The quoted value is “forty two” after whitespace.\nSecond line says GPU power is reported in milliwatts by the telemetry API.",
			title: "Example Report",
		});
		const budget = createWorkflowWebVisibleBudget(180);
		const read = readWorkflowWebSourceSnippet({
			source,
			query: "quoted value is \"forty two\"",
			maxChars: 60,
			budget,
		});
		assert.equal(read.status, "matched");
		assert.equal(read.matchType, "normalized");
		assert.match(read.quote, /forty two/);
		const termRead = readWorkflowWebSourceSnippet({
			source,
			claim: "Telemetry reports GPU power in milliwatts",
			terms: ["GPU power", "milliwatts", "telemetry API"],
			maxChars: 90,
			budget,
		});
		assert.equal(termRead.status, "matched");
		assert.equal(termRead.matchType, "terms");
		assert.match(termRead.quote, /milliwatts/);
		assert.deepEqual(termRead.matchedTerms, ["GPU power", "milliwatts", "telemetry API"]);
		assert.deepEqual(termRead.missingTerms, []);
		assert.equal(termRead.coverageRatio, 1);
		assert.equal(termRead.candidateOnly, true);
		assert.equal(source.redactedUrl.includes("secret"), false);
		assert.equal(await readWorkflowWebSource(config, "../escape"), undefined);
		await writeWorkflowWebSource(config, source);
		writeFileSync(join(config.cacheDir, "index.json"), JSON.stringify({
			schema: "workflow-web-source-index-v1",
			updatedAt: new Date().toISOString(),
			runId: config.runId,
			sources: [],
		}));
		const rebuiltIndex = await readWorkflowWebSourceIndex(config);
		assert.ok(rebuiltIndex.sources.some((entry) => entry.sourceRef === source.sourceRef));
		const foundByScan = await findWorkflowWebSourceByUrl(config, "https://example.test/report?signature=secret#section");
		assert.equal(foundByScan.sourceRef, source.sourceRef);
		const differentSecret = await findWorkflowWebSourceByUrl(config, "https://example.test/report?signature=different#section");
		assert.equal(differentSecret, undefined);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("workflow web-source extension returns source cards and narrow reads without exposing cache paths", async () => {
	const cwd = makeProject();
	try {
		const cacheDir = join(cwd, ".pi", "workflows", "workflow_unit", "web-source-cache");
		const registered = new Map();
		const appended = [];
		const fakePi = {
			registerTool(tool) {
				registered.set(tool.name, tool);
			},
			appendEntry(type, data) {
				appended.push({ type, data });
			},
		};
		const providerExtension = (pi) => {
			pi.registerTool({
				name: "web_search",
				async execute() {
					return {
						content: [
							{
								type: "text",
								text: "Example result https://example.test/report?token=secret with useful context",
							},
						],
					};
				},
			});
			pi.registerTool({
				name: "fetch_content",
				async execute(_id, params) {
					pi.appendEntry("web-search-results", {
						type: "fetch",
						urls: [{ url: params.url, content: "RAW PROVIDER PAYLOAD" }],
					});
					return {
						content: [
							{
								type: "text",
								text: `# Provider Title\nExact claim: workflow source cards preserve evidence for ${params.url}.`,
							},
						],
						details: { successful: 1 },
					};
				},
			});
		};
		registerWorkflowWebSourceExtension(
			fakePi,
			{
				schema: "workflow-web-source-launch-config-v1",
				runId: "workflow_unit",
				taskId: "task-1",
				cwd,
				cacheDir,
				provider: { kind: "extension" },
				securityPolicy: { allowPrivateHosts: true },
				webSourcePolicy: { previewChars: 48, sourceReadMaxChars: 80, perTaskVisibleCharBudget: 500 },
			},
			providerExtension,
		);

		assert.equal(registered.has("web_search"), false);
		assert.equal(registered.has("fetch_content"), false);
		assert.equal(registered.has("workflow_web_search"), true);
		assert.equal(registered.has("workflow_web_fetch_source"), true);
		assert.equal(registered.has("workflow_web_source_read"), true);
		assert.equal(registered.get("workflow_web_search").parameters.type, "object");
		assert.equal(registered.get("workflow_web_fetch_source").parameters.type, "object");
		assert.equal(registered.get("workflow_web_source_read").parameters.type, "object");

		const search = await registered
			.get("workflow_web_search")
			.execute("call-search", { query: "example" });
		assert.match(search.content[0].text, /workflow_web_fetch_source/);
		assert.doesNotMatch(search.content[0].text, /secret/);

		const fetched = await registered
			.get("workflow_web_fetch_source")
			.execute("call-fetch", { url: "https://example.test/report?token=secret" });
		assert.match(fetched.content[0].text, /sourceRef/);
		assert.doesNotMatch(fetched.content[0].text, /web-source-cache/);
		assert.doesNotMatch(fetched.content[0].text, /secret/);
		const card = JSON.parse(fetched.content[0].text).card;
		const stored = await readWorkflowWebSource({ runId: "workflow_unit", taskId: "task-1", cacheDir }, card.sourceRef);
		assert.equal(stored.text.includes("Exact claim"), true);
		assert.equal(stored.url.includes("secret"), false);
		assert.equal(appended.length, 0);

		const fetchedBatch = await registered.get("workflow_web_fetch_source").execute("call-fetch-batch", {
			urls: ["https://example.test/batch-a", "https://example.test/batch-b"],
			titles: ["Batch A", "Batch B"],
		});
		const fetchedBatchBody = JSON.parse(fetchedBatch.content[0].text);
		assert.equal(fetchedBatchBody.status, "ok");
		assert.equal(fetchedBatchBody.cards.length, 2);
		assert.equal(fetchedBatchBody.results.length, 2);
		assert.equal(fetchedBatchBody.results[0].card, undefined);
		assert.equal(fetchedBatchBody.results[0].cardIndex, 0);
		assert.equal(fetchedBatchBody.results[0].sourceRef, fetchedBatchBody.cards[0].sourceRef);
		assert.equal(fetchedBatchBody.results[1].cardIndex, 1);
		assert.equal(fetchedBatchBody.results[1].sourceRef, fetchedBatchBody.cards[1].sourceRef);
		assert.match(fetchedBatch.content[0].text, /sourceRef/);
		assert.doesNotMatch(fetchedBatch.content[0].text, /\n  \"cards\"/);
		assert.doesNotMatch(fetchedBatch.content[0].text, /web-source-cache/);

		const read = await registered.get("workflow_web_source_read").execute("call-read", {
			sourceRef: card.sourceRef,
			query: "Exact claim: workflow source cards preserve evidence",
		});
		assert.match(read.content[0].text, /Exact claim/);
		assert.doesNotMatch(read.content[0].text, /web-source-cache/);

		const termSearch = await registered.get("workflow_web_source_read").execute("call-read-terms", {
			sourceRef: card.sourceRef,
			claim: "workflow source cards preserve evidence",
			terms: ["source cards", "preserve evidence"],
		});
		const termBody = JSON.parse(termSearch.content[0].text);
		assert.equal(termBody.status, "candidate");
		assert.equal(termBody.matchType, "terms");
		assert.equal(termBody.candidateOnly, true);
		assert.deepEqual(termBody.missingTerms, []);
		assert.match(termBody.quote, /preserve evidence/);

		const batch = await registered.get("workflow_web_source_read").execute("call-read-batch", {
			sourceRef: card.sourceRef,
			reads: [
				{ query: "Exact claim: workflow source cards preserve evidence" },
				{ claim: "workflow source cards preserve evidence", terms: ["source cards", "preserve evidence"] },
				{ query: "not present in source" },
			],
		});
		const batchBody = JSON.parse(batch.content[0].text);
		assert.equal(batchBody.status, "partial");
		assert.equal(batchBody.results.length, 3);
		assert.equal(batchBody.results[0].status, "ok");
		assert.equal(batchBody.results[1].status, "candidate");
		assert.equal(batchBody.results[1].matchType, "terms");
		assert.equal(batchBody.results[2].status, "not_found");
		assert.doesNotMatch(batch.content[0].text, /web-source-cache/);

		const exhausted = await registered.get("workflow_web_source_read").execute("call-read-2", {
			sourceRef: card.sourceRef,
			query: "alpha beta gamma that is not present but keeps budget unchanged",
		});
		assert.match(exhausted.content[0].text, /not_found/);

		const duplicate = await registered
			.get("workflow_web_fetch_source")
			.execute("call-fetch-2", { url: "https://example.test/report?token=secret#quote" });
		assert.equal(JSON.parse(duplicate.content[0].text).card.duplicate, true);
		assert.equal(existsSync(join(cacheDir, "events.jsonl")), true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("workflow web-source fetch single-flights duplicate URLs and caches transient empty results in process", async () => {
	const cwd = makeProject();
	try {
		const cacheDir = join(cwd, ".pi", "workflows", "workflow_unit", "web-source-cache");
		const registered = new Map();
		const fakePi = { registerTool(tool) { registered.set(tool.name, tool); } };
		const callsByUrl = new Map();
		const providerExtension = (pi) => {
			pi.registerTool({
				name: "fetch_content",
				async execute(_id, params) {
					callsByUrl.set(params.url, (callsByUrl.get(params.url) ?? 0) + 1);
					await new Promise((resolve) => setTimeout(resolve, 20));
					if (params.url.includes("empty")) return { content: [] };
					return { content: [{ type: "text", text: `Single-flight content for ${params.url}` }] };
				},
			});
		};
		registerWorkflowWebSourceExtension(
			fakePi,
			{
				schema: "workflow-web-source-launch-config-v1",
				runId: "workflow_unit",
				taskId: "task-1",
				cwd,
				cacheDir,
				provider: { kind: "extension" },
				securityPolicy: { allowPrivateHosts: true },
				webSourcePolicy: { previewChars: 60, sourceReadMaxChars: 80, perTaskVisibleCharBudget: 500 },
			},
			providerExtension,
		);

		const [first, second] = await Promise.all([
			registered.get("workflow_web_fetch_source").execute("fetch-a", { url: "https://example.test/same" }),
			registered.get("workflow_web_fetch_source").execute("fetch-b", { url: "https://example.test/same#section" }),
		]);
		assert.match(first.content[0].text, /sourceRef/);
		const firstCard = JSON.parse(first.content[0].text).card;
		const secondCard = JSON.parse(second.content[0].text).card;
		assert.equal(
			[firstCard.duplicate, secondCard.duplicate].filter(Boolean).length,
			1,
		);
		assert.equal(callsByUrl.get("https://example.test/same"), 1);

		const registeredCrossTask = new Map();
		registerWorkflowWebSourceExtension(
			{ registerTool(tool) { registeredCrossTask.set(tool.name, tool); } },
			{
				schema: "workflow-web-source-launch-config-v1",
				runId: "workflow_unit",
				taskId: "task-2",
				cwd,
				cacheDir,
				provider: { kind: "extension" },
				securityPolicy: { allowPrivateHosts: true },
				webSourcePolicy: { previewChars: 60, sourceReadMaxChars: 80, perTaskVisibleCharBudget: 500 },
			},
			providerExtension,
		);
		const [crossFirst, crossSecond] = await Promise.all([
			registered.get("workflow_web_fetch_source").execute("fetch-cross-a", { url: "https://example.test/cross" }),
			registeredCrossTask.get("workflow_web_fetch_source").execute("fetch-cross-b", { url: "https://example.test/cross" }),
		]);
		assert.match(crossFirst.content[0].text, /sourceRef/);
		assert.match(crossSecond.content[0].text, /sourceRef/);
		assert.equal(callsByUrl.get("https://example.test/cross"), 1);

		const emptyFirst = await registered.get("workflow_web_fetch_source").execute("fetch-empty-a", { url: "https://example.test/empty" });
		const emptySecond = await registered.get("workflow_web_fetch_source").execute("fetch-empty-b", { url: "https://example.test/empty" });
		assert.match(emptyFirst.content[0].text, /empty_source/);
		assert.match(emptySecond.content[0].text, /empty_source/);
		assert.equal(callsByUrl.get("https://example.test/empty"), 1);
		const emptyFromOtherTask = await registeredCrossTask.get("workflow_web_fetch_source").execute("fetch-empty-c", { url: "https://example.test/empty" });
		assert.match(emptyFromOtherTask.content[0].text, /empty_source/);
		assert.equal(callsByUrl.get("https://example.test/empty"), 2);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("workflow web-source search disables provider curation by default", async () => {
	const cwd = makeProject();
	try {
		const cacheDir = join(cwd, ".pi", "workflows", "workflow_unit", "web-source-cache");
		const registered = new Map();
		const fakePi = { registerTool(tool) { registered.set(tool.name, tool); } };
		const providerExtension = (pi) => {
			pi.registerTool({
				name: "web_search",
				async execute(_id, params) {
					assert.equal(params.workflow, "none");
					return { content: [{ type: "text", text: "Result https://example.test/source snippet" }] };
				},
			});
		};
		registerWorkflowWebSourceExtension(
			fakePi,
			{
				schema: "workflow-web-source-launch-config-v1",
				runId: "workflow_unit",
				taskId: "task-1",
				cwd,
				cacheDir,
				provider: { kind: "extension" },
			},
			providerExtension,
		);
		const search = await registered
			.get("workflow_web_search")
			.execute("call-search", { query: "example" });
		assert.match(search.content[0].text, /workflow_web_fetch_source/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("workflow web-source extension blocks untrusted custom fetch and reports budget exhaustion", async () => {
	const cwd = makeProject();
	try {
		const cacheDir = join(cwd, ".pi", "workflows", "workflow_unit", "web-source-cache");
		const registered = new Map();
		let providerCalls = 0;
		const fakePi = { registerTool(tool) { registered.set(tool.name, tool); } };
		const providerExtension = (pi) => {
			pi.registerTool({
				name: "fetch_content",
				async execute(_id, params) {
					providerCalls += 1;
					return {
						content: [{ type: "text", text: `Alpha beta gamma exact quote for ${params.url}.` }],
						details: { finalUrl: params.url },
					};
				},
			});
		};
		registerWorkflowWebSourceExtension(
			fakePi,
			{
				schema: "workflow-web-source-launch-config-v1",
				runId: "workflow_unit",
				taskId: "task-1",
				cwd,
				cacheDir,
				provider: { kind: "extension" },
				webSourcePolicy: { previewChars: 0, sourceReadMaxChars: 80, perTaskVisibleCharBudget: 0 },
			},
			providerExtension,
		);
		const blocked = await registered
			.get("workflow_web_fetch_source")
			.execute("call-untrusted", { url: "http://1.1.1.1/source" });
		assert.match(blocked.content[0].text, /untrusted_provider_fetch/);
		assert.equal(providerCalls, 0);

		const trustedRegistered = new Map();
		registerWorkflowWebSourceExtension(
			{ registerTool(tool) { trustedRegistered.set(tool.name, tool); } },
			{
				schema: "workflow-web-source-launch-config-v1",
				runId: "workflow_unit_trusted",
				taskId: "task-1",
				cwd,
				cacheDir: join(cwd, ".pi", "workflows", "workflow_unit_trusted", "web-source-cache"),
				provider: { kind: "extension" },
				securityPolicy: { allowPrivateHosts: true },
				webSourcePolicy: { previewChars: 0, sourceReadMaxChars: 80, perTaskVisibleCharBudget: 0 },
			},
			providerExtension,
		);
		const fetched = await trustedRegistered
			.get("workflow_web_fetch_source")
			.execute("call-fetch", { url: "https://example.test/source" });
		const card = JSON.parse(fetched.content[0].text).card;
		const read = await trustedRegistered.get("workflow_web_source_read").execute("call-read", {
			sourceRef: card.sourceRef,
			query: "Alpha beta gamma",
		});
		assert.match(read.content[0].text, /budget_exhausted/);
		assert.doesNotMatch(read.content[0].text, /"quote": ""/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("default normalized web fetch uses guarded direct fetch instead of captured fetch_content", async () => {
	const cwd = makeProject();
	const server = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "text/html" });
		res.end("<html><head><title>Guarded &amp; Direct</title><style>.x{}</style></head><body><script>secret()</script><main>Local direct fetch body &amp; decoded quote for guarded default provider.</main></body></html>");
	});
	await new Promise((resolve) => server.listen(0, resolve));
	try {
		const address = server.address();
		assert.equal(typeof address, "object");
		const url = `http://localhost:${address.port}/source`;
		const cacheDir = join(cwd, ".pi", "workflows", "workflow_unit", "web-source-cache");
		const registered = new Map();
		let providerFetchCalls = 0;
		const fakePi = { registerTool(tool) { registered.set(tool.name, tool); } };
		const providerExtension = (pi) => {
			pi.registerTool({
				name: "fetch_content",
				async execute() {
					providerFetchCalls += 1;
					throw new Error("captured fetch_content should not be called");
				},
			});
		};
		registerWorkflowWebSourceExtension(
			fakePi,
			{
				schema: "workflow-web-source-launch-config-v1",
				runId: "workflow_unit",
				taskId: "task-1",
				cwd,
				cacheDir,
				provider: { kind: "pi-web-access" },
				securityPolicy: { allowPrivateHosts: true },
			},
			providerExtension,
		);
		const fetched = await registered
			.get("workflow_web_fetch_source")
			.execute("call-fetch", { url });
		assert.equal(providerFetchCalls, 0);
		assert.match(fetched.content[0].text, /Local direct fetch body & decoded quote/);
		assert.doesNotMatch(fetched.content[0].text, /<main>|secret\(\)/);
		const card = JSON.parse(fetched.content[0].text).card;
		const stored = await readWorkflowWebSource({ runId: "workflow_unit", taskId: "task-1", cacheDir }, card.sourceRef);
		assert.equal(stored.extractionLossy, true);
		assert.match(stored.text, /Local direct fetch body & decoded quote/);
	} finally {
		await new Promise((resolve) => server.close(resolve));
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("subagent launch wires normalized workflow web-source tools through generated extension", async () => {
	const cwd = makeProject();
	let captured;
	try {
		writeAgent(
			cwd,
			"unit-researcher",
			"read, workflow_web_search, workflow_web_fetch_source, workflow_web_source_read",
		);
		setSubagentApiForTests({
			async runSubagent(options) {
				captured = options;
				return { runId: "run_stub", attemptId: "attempt_stub", status: "running" };
			},
			async getSubagentStatus() {
				return null;
			},
			async reconcileSubagentRun() {
				return {};
			},
			async interruptSubagent() {
				return {};
			},
		});

		const spec = workflowSpec("unit-researcher", {
			tools: ["read", "workflow_web_search", "workflow_web_fetch_source", "workflow_web_source_read"],
			artifactGraph: {
				stages: [{ id: "main", type: "single", prompt: "Research with normalized web tools." }],
			},
		});
		const compiled = await compileWorkflow(spec, { cwd, task: "Research topic" });
		const { run } = await createWorkflowRunRecord(
			cwd,
			compiled,
			join(cwd, "workflows", "unit.json"),
		);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);
		await scheduleRun(cwd, run.runId);

		assert(captured.tools.includes("workflow_web_search"));
		assert(
			captured.extensions.some((entry) =>
				entry.endsWith("workflow-web-source-extension.ts"),
			),
		);
		assert.equal(captured.extensions.some(isBundledPiWebAccessExtension), false);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("subagent launch captures custom normalized web provider extension instead of exposing it directly", async () => {
	const cwd = makeProject();
	let captured;
	try {
		const providerPath = "/tmp/custom-workflow-web-provider.mjs";
		writeAgent(cwd, "unit-researcher", "read, workflow_web_fetch_source");
		setSubagentApiForTests({
			async runSubagent(options) {
				captured = options;
				return { runId: "run_stub", attemptId: "attempt_stub", status: "running" };
			},
			async getSubagentStatus() {
				return null;
			},
			async reconcileSubagentRun() {
				return {};
			},
			async interruptSubagent() {
				return {};
			},
		});
		const spec = workflowSpec("unit-researcher", {
			tools: [
				"read",
				{
					name: "workflow_web_fetch_source",
					extensions: [providerPath],
					classification: "read-only",
				},
			],
			artifactGraph: {
				stages: [{ id: "main", type: "single", prompt: "Fetch with custom normalized provider." }],
			},
		});
		const compiled = await compileWorkflow(spec, { cwd, task: "Research topic" });
		const { run } = await createWorkflowRunRecord(
			cwd,
			compiled,
			join(cwd, "workflows", "unit.json"),
		);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);
		await scheduleRun(cwd, run.runId);

		assert.equal(captured.extensions.includes(providerPath), false);
		const wrapperPath = captured.extensions.find((entry) =>
			entry.endsWith("workflow-web-source-extension.ts"),
		);
		assert(wrapperPath);
		assert.match(readFileSync(wrapperPath, "utf8"), /custom-workflow-web-provider/);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("completed subagent with contextLengthExceeded and valid output remains completed", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const compiled = await compileWorkflow(
			workflowSpec("unit-scout", {
				artifactGraph: {
					stages: [
						{
							id: "main",
							type: "single",
							prompt: "Return valid workflow output.",
						},
					],
				},
			}),
			{ cwd, task: "Review topic" },
		);
		const { run } = await createWorkflowRunRecord(
			cwd,
			compiled,
			join(cwd, "workflows", "unit.json"),
		);
		await writeStaticRunArtifacts(
			cwd,
			run,
			compiled,
			workflowSpec("unit-scout"),
		);
		const task = run.tasks[0];
		task.status = "running";
		task.statusDetail = "running";
		task.startedAt = new Date().toISOString();
		task.backendHandle = {
			engine: "pi-subagent",
			backend: "headless",
			runId: "run_context",
			attemptId: "attempt_context",
			cwd,
			runsDir: ".pi/workflow-subagents/context",
			display: "pi-subagent/headless run_context/attempt_context",
		};

		const artifactDir = join(cwd, ".fake-context-subagent");
		mkdirSync(artifactDir, { recursive: true });
		writeFileSync(
			join(artifactDir, "output.log"),
			[
				"<control>",
				JSON.stringify({ schema: "stage-control-v1", digest: "ok", ok: true }),
				"</control>",
				"<analysis>",
				"context length output analysis",
				"</analysis>",
				"<refs>",
				"[]",
				"</refs>",
			].join("\n"),
		);
		writeFileSync(join(artifactDir, "stderr.log"), "");
		writeFileSync(
			join(artifactDir, "tool-calls-summary.json"),
			JSON.stringify({
				enabled: true,
				totalCalls: 1,
				callsByTool: { fetch_content: 1 },
				callsByCategory: { network: 1 },
				errorsByTool: {},
				resources: {
					urls: ["https://docs.example.test/a"],
					hosts: ["docs.example.test"],
				},
			}),
		);
		writeFileSync(
			join(artifactDir, "result.json"),
			JSON.stringify({
				status: "completed",
				completedAt: new Date().toISOString(),
				startedAt: task.startedAt,
				exitCode: 0,
				cwd,
				metadata: { contextLengthExceeded: true, stopReason: "stop" },
				artifacts: [
					{
						type: "tool-calls-summary",
						path: ".fake-context-subagent/tool-calls-summary.json",
					},
				],
			}),
		);

		setSubagentApiForTests({
			async runSubagent() {
				throw new Error("not expected");
			},
			async reconcileSubagentRun() {
				return {};
			},
			async getSubagentStatus() {
				return {
					runId: "run_context",
					attemptId: "attempt_context",
					backend: "headless",
					status: "completed",
					failureKind: null,
					startedAt: task.startedAt,
					completedAt: new Date().toISOString(),
					logs: [
						{
							type: "output",
							path: ".fake-context-subagent/output.log",
							artifactCwd: cwd,
						},
						{
							type: "stderr",
							path: ".fake-context-subagent/stderr.log",
							artifactCwd: cwd,
						},
						{
							type: "result",
							path: ".fake-context-subagent/result.json",
							artifactCwd: cwd,
						},
					],
					metadata: { contextLengthExceeded: true, stopReason: "stop" },
					attempts: [
						{
							attemptId: "attempt_context",
							status: "completed",
							pid: 99999999,
						},
					],
				};
			},
			async interruptSubagent() {
				return {};
			},
		});

		await writeRunRecord(cwd, run);
		const refreshed = await refreshRunFromSubagentArtifacts(
			cwd,
			await readRunRecord(cwd, run.runId),
		);
		const refreshedTask = refreshed.tasks[0];
		const workflowResult = JSON.parse(
			readFileSync(join(cwd, refreshedTask.files.result), "utf8"),
		);
		assert.equal(refreshedTask.status, "completed");
		assert.equal(workflowResult.outputValidation.valid, true);
		assert.equal(workflowResult.failureKind, undefined);
		assert.deepEqual(
			JSON.parse(
				readFileSync(
					join(dirname(join(cwd, refreshedTask.files.result)), "control.json"),
					"utf8",
				),
			),
			{ schema: "stage-control-v1", digest: "ok", ok: true },
		);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("failed context-window subagent with valid artifactGraph output is salvaged", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const compiled = await compileWorkflow(
			workflowSpec("unit-scout", {
				artifactGraph: {
					stages: [
						{
							id: "main",
							type: "single",
							prompt: "Return valid workflow output.",
						},
					],
				},
			}),
			{ cwd, task: "Review topic" },
		);
		const { run } = await createWorkflowRunRecord(
			cwd,
			compiled,
			join(cwd, "workflows", "unit.json"),
		);
		await writeStaticRunArtifacts(
			cwd,
			run,
			compiled,
			workflowSpec("unit-scout"),
		);
		const task = run.tasks[0];
		task.status = "running";
		task.statusDetail = "running";
		task.startedAt = new Date().toISOString();
		task.backendHandle = {
			engine: "pi-subagent",
			backend: "headless",
			runId: "run_context_failed",
			attemptId: "attempt_context_failed",
			cwd,
			runsDir: ".pi/workflow-subagents/context-failed",
			display: "pi-subagent/headless run_context_failed/attempt_context_failed",
		};

		const artifactDir = join(cwd, ".fake-context-failed-subagent");
		mkdirSync(artifactDir, { recursive: true });
		writeFileSync(
			join(artifactDir, "output.log"),
			[
				"<control>",
				JSON.stringify({ schema: "stage-control-v1", digest: "ok", ok: true }),
				"</control>",
				"<analysis>",
				"salvaged context output analysis",
				"</analysis>",
				"<refs>",
				"[]",
				"</refs>",
			].join("\n"),
		);
		writeFileSync(join(artifactDir, "stderr.log"), "context exceeded\n");
		writeFileSync(
			join(artifactDir, "result.json"),
			JSON.stringify({
				status: "failed",
				failureKind: "model",
				completedAt: new Date().toISOString(),
				startedAt: task.startedAt,
				exitCode: 1,
				cwd,
				metadata: { contextLengthExceeded: true, stopReason: "length" },
			}),
		);

		setSubagentApiForTests({
			async runSubagent() {
				throw new Error("not expected");
			},
			async reconcileSubagentRun() {
				return {};
			},
			async getSubagentStatus() {
				return {
					runId: "run_context_failed",
					attemptId: "attempt_context_failed",
					backend: "headless",
					status: "failed",
					failureKind: "model",
					startedAt: task.startedAt,
					completedAt: new Date().toISOString(),
					logs: [
						{
							type: "output",
							path: ".fake-context-failed-subagent/output.log",
							artifactCwd: cwd,
						},
						{
							type: "stderr",
							path: ".fake-context-failed-subagent/stderr.log",
							artifactCwd: cwd,
						},
						{
							type: "result",
							path: ".fake-context-failed-subagent/result.json",
							artifactCwd: cwd,
						},
					],
					metadata: { contextLengthExceeded: true, stopReason: "length" },
					attempts: [
						{
							attemptId: "attempt_context_failed",
							status: "failed",
							pid: 99999999,
						},
					],
				};
			},
			async interruptSubagent() {
				return {};
			},
		});

		await writeRunRecord(cwd, run);
		const refreshed = await refreshRunFromSubagentArtifacts(
			cwd,
			await readRunRecord(cwd, run.runId),
		);
		const refreshedTask = refreshed.tasks[0];
		const workflowResult = JSON.parse(
			readFileSync(join(cwd, refreshedTask.files.result), "utf8"),
		);
		assert.equal(refreshedTask.status, "completed");
		assert.equal(workflowResult.status, "completed");
		assert.equal(
			workflowResult.salvagedFromFailureKind,
			"context_or_request_too_large",
		);
		assert.equal(workflowResult.outputValidation.valid, true);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("failed model subagent with valid artifactGraph output is salvaged", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const compiled = await compileWorkflow(
			workflowSpec("unit-scout", {
				artifactGraph: {
					stages: [
						{
							id: "main",
							type: "single",
							prompt: "Return valid workflow output.",
						},
					],
				},
			}),
			{ cwd, task: "Review topic" },
		);
		const { run } = await createWorkflowRunRecord(
			cwd,
			compiled,
			join(cwd, "workflows", "unit.json"),
		);
		await writeStaticRunArtifacts(
			cwd,
			run,
			compiled,
			workflowSpec("unit-scout"),
		);
		const task = run.tasks[0];
		task.status = "running";
		task.statusDetail = "running";
		task.startedAt = new Date().toISOString();
		task.backendHandle = {
			engine: "pi-subagent",
			backend: "headless",
			runId: "run_salvage",
			attemptId: "attempt_salvage",
			cwd,
			runsDir: ".pi/workflow-subagents/salvage",
			display: "pi-subagent/headless run_salvage/attempt_salvage",
		};

		const artifactDir = join(cwd, ".fake-salvage-subagent");
		mkdirSync(artifactDir, { recursive: true });
		writeFileSync(
			join(artifactDir, "output.log"),
			[
				"<control>",
				JSON.stringify({ schema: "stage-control-v1", digest: "ok", ok: true }),
				"</control>",
				"<analysis>",
				"salvaged output analysis",
				"</analysis>",
				"<refs>",
				"[]",
				"</refs>",
			].join("\n"),
		);
		writeFileSync(join(artifactDir, "stderr.log"), "");
		writeFileSync(
			join(artifactDir, "result.json"),
			JSON.stringify({
				status: "failed",
				failureKind: "model",
				completedAt: new Date().toISOString(),
				startedAt: task.startedAt,
				exitCode: 0,
				cwd,
				metadata: { contextLengthExceeded: false, stopReason: "stop" },
			}),
		);

		setSubagentApiForTests({
			async runSubagent() {
				throw new Error("not expected");
			},
			async reconcileSubagentRun() {
				return {};
			},
			async getSubagentStatus() {
				return {
					runId: "run_salvage",
					attemptId: "attempt_salvage",
					backend: "headless",
					status: "failed",
					failureKind: "model",
					startedAt: task.startedAt,
					completedAt: new Date().toISOString(),
					logs: [
						{
							type: "output",
							path: ".fake-salvage-subagent/output.log",
							artifactCwd: cwd,
						},
						{
							type: "stderr",
							path: ".fake-salvage-subagent/stderr.log",
							artifactCwd: cwd,
						},
						{
							type: "result",
							path: ".fake-salvage-subagent/result.json",
							artifactCwd: cwd,
						},
					],
					metadata: { contextLengthExceeded: false, stopReason: "stop" },
					attempts: [
						{
							attemptId: "attempt_salvage",
							status: "failed",
							pid: 99999999,
						},
					],
				};
			},
			async interruptSubagent() {
				return {};
			},
		});

		await writeRunRecord(cwd, run);
		const refreshed = await refreshRunFromSubagentArtifacts(
			cwd,
			await readRunRecord(cwd, run.runId),
		);
		const refreshedTask = refreshed.tasks[0];
		const taskDir = dirname(join(cwd, refreshedTask.files.result));
		const workflowResult = JSON.parse(
			readFileSync(join(cwd, refreshedTask.files.result), "utf8"),
		);
		assert.equal(refreshedTask.status, "completed");
		assert.equal(workflowResult.status, "completed");
		assert.equal(workflowResult.outputValidation.valid, true);
		assert.deepEqual(
			JSON.parse(readFileSync(join(taskDir, "control.json"), "utf8")),
			{ schema: "stage-control-v1", digest: "ok", ok: true },
		);
		assert.equal(
			readFileSync(join(taskDir, "analysis.md"), "utf8"),
			"salvaged output analysis\n",
		);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("refresh retries zero-output transient subagent model failures", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const compiled = await compileWorkflow(
			workflowSpec("unit-scout", {
				artifactGraph: {
					stages: [{ id: "main", type: "single", prompt: "Do work." }],
				},
			}),
			{ cwd, task: "Review topic" },
		);
		const { run } = await createWorkflowRunRecord(
			cwd,
			compiled,
			join(cwd, "workflows", "unit.json"),
		);
		await writeStaticRunArtifacts(
			cwd,
			run,
			compiled,
			workflowSpec("unit-scout"),
		);
		const task = run.tasks[0];
		task.status = "running";
		task.statusDetail = "running";
		task.startedAt = new Date().toISOString();
		task.backendHandle = {
			engine: "pi-subagent",
			backend: "headless",
			runId: "run_model_flake",
			attemptId: "attempt_model_flake",
			cwd,
			runsDir: ".pi/workflow-subagents/model-flake",
			display: "pi-subagent/headless run_model_flake/attempt_model_flake",
		};

		const artifactDir = join(cwd, ".fake-model-subagent");
		mkdirSync(artifactDir, { recursive: true });
		writeFileSync(join(artifactDir, "output.log"), "");
		writeFileSync(
			join(artifactDir, "stderr.log"),
			"model temporarily unavailable\n",
		);
		writeFileSync(
			join(artifactDir, "result.json"),
			JSON.stringify({
				status: "failed",
				failureKind: "model",
				exitCode: 0,
				completedAt: new Date().toISOString(),
				startedAt: task.startedAt,
				errorMessage: "pi-subagent run failed: model",
				metadata: { contextLengthExceeded: false },
			}),
		);

		setSubagentApiForTests({
			async runSubagent() {
				throw new Error("not expected");
			},
			async reconcileSubagentRun() {
				return {};
			},
			async getSubagentStatus() {
				return {
					runId: "run_model_flake",
					attemptId: "attempt_model_flake",
					backend: "headless",
					status: "failed",
					failureKind: "model",
					startedAt: task.startedAt,
					completedAt: new Date().toISOString(),
					logs: [
						{
							type: "output",
							path: ".fake-model-subagent/output.log",
							artifactCwd: cwd,
						},
						{
							type: "stderr",
							path: ".fake-model-subagent/stderr.log",
							artifactCwd: cwd,
						},
						{
							type: "result",
							path: ".fake-model-subagent/result.json",
							artifactCwd: cwd,
						},
					],
					metadata: { contextLengthExceeded: false, stopReason: "error" },
					attempts: [
						{
							attemptId: "attempt_model_flake",
							status: "failed",
							pid: 99999999,
						},
					],
				};
			},
			async interruptSubagent() {
				return {};
			},
		});

		await writeRunRecord(cwd, run);
		const refreshed = await refreshRunFromSubagentArtifacts(
			cwd,
			await readRunRecord(cwd, run.runId),
		);
		const refreshedTask = refreshed.tasks[0];
		assert.equal(refreshedTask.status, "pending");
		assert.equal(refreshedTask.statusDetail, "retry_model_failure");
		assert.equal(refreshedTask.launchRetry?.attempts, 1);
		assert.equal(refreshedTask.launchRetry?.reason, "model");
		assert.equal(refreshedTask.backendHandle, undefined);
		assert.equal(
			existsSync(
				join(
					cwd,
					dirname(refreshedTask.files.result),
					"result.transient-model-failure-1.json",
				),
			),
			true,
		);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("refresh adopts handle-less running subagent from deterministic runsDir", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const compiled = await compileWorkflow(
			workflowSpec("unit-scout", {
				artifactGraph: {
					stages: [{ id: "main", type: "single", prompt: "Do work." }],
				},
			}),
			{ cwd, task: "Review topic" },
		);
		const { run } = await createWorkflowRunRecord(
			cwd,
			compiled,
			join(cwd, "workflows", "unit.json"),
		);
		await writeStaticRunArtifacts(
			cwd,
			run,
			compiled,
			workflowSpec("unit-scout"),
		);
		const task = run.tasks[0];
		task.status = "running";
		task.statusDetail = "launching";
		task.startedAt = new Date().toISOString();
		delete task.backendHandle;

		const subRunId = "run_recovered";
		const subAttemptId = "attempt_recovered";
		const runsDir = join(
			cwd,
			".pi",
			"workflow-subagents",
			run.runId,
			task.taskId,
		);
		const subRunDir = join(runsDir, subRunId);
		mkdirSync(subRunDir, { recursive: true });
		writeFileSync(
			join(subRunDir, "run.json"),
			JSON.stringify({
				runId: subRunId,
				correlationId: `${run.runId}:${task.taskId}`,
				status: "completed",
				backend: "headless",
				startedAt: task.startedAt,
				updatedAt: new Date().toISOString(),
				latestAttemptId: subAttemptId,
				attempts: [
					{
						attemptId: subAttemptId,
						status: "completed",
						backend: "headless",
						startedAt: task.startedAt,
						updatedAt: new Date().toISOString(),
					},
				],
			}),
		);

		const artifactDir = join(runsDir, subRunId, "attempts", subAttemptId);
		mkdirSync(artifactDir, { recursive: true });
		const adoptedOutput = [
			"<control>",
			JSON.stringify({ schema: "stage-control-v1", digest: "adopted" }),
			"</control>",
			"<analysis>",
			"adopted output",
			"</analysis>",
			"<refs>",
			"[]",
			"</refs>",
		].join("\n");
		writeFileSync(join(artifactDir, "output.log"), adoptedOutput);
		writeFileSync(join(artifactDir, "stderr.log"), "");
		writeFileSync(
			join(artifactDir, "result.json"),
			JSON.stringify({
				status: "completed",
				completedAt: new Date().toISOString(),
				startedAt: task.startedAt,
				exitCode: 0,
				metadata: { contextLengthExceeded: false },
			}),
		);

		setSubagentApiForTests({
			async runSubagent() {
				throw new Error("not expected");
			},
			async reconcileSubagentRun() {
				return {};
			},
			async getSubagentStatus() {
				return {
					runId: subRunId,
					attemptId: subAttemptId,
					backend: "headless",
					status: "completed",
					failureKind: null,
					startedAt: task.startedAt,
					completedAt: new Date().toISOString(),
					logs: [
						{
							type: "output",
							path: "output.log",
							artifactCwd: artifactDir,
						},
						{
							type: "stderr",
							path: "stderr.log",
							artifactCwd: artifactDir,
						},
						{
							type: "result",
							path: "result.json",
							artifactCwd: artifactDir,
						},
					],
					metadata: { contextLengthExceeded: false },
					attempts: [
						{ attemptId: subAttemptId, status: "completed", pid: 99999999 },
					],
				};
			},
			async interruptSubagent() {
				return {};
			},
		});

		await writeRunRecord(cwd, run);
		const refreshed = await refreshRunFromSubagentArtifacts(
			cwd,
			await readRunRecord(cwd, run.runId),
		);
		assert.equal(refreshed.tasks[0].status, "completed");
		assert.equal(refreshed.tasks[0].backendHandle, undefined);
		const workflowResult = JSON.parse(
			readFileSync(join(cwd, refreshed.tasks[0].files.result), "utf8"),
		);
		assert.equal(workflowResult.outputValidation.valid, true);
		assert.equal(
			readFileSync(join(cwd, refreshed.tasks[0].files.output), "utf8"),
			adoptedOutput,
		);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("runtime model resolver defaults to current model and thinking", async () => {
	const resolved = await resolveWorkflowRuntime(
		{},
		{
			taskKey: "main.main",
			stageId: "main",
			taskId: "main",
			agent: "unit-scout",
		},
		{
			defaults: { model: "openai-codex/gpt-5.5", thinking: "high" },
			availableModels: [
				{
					provider: "openai-codex",
					id: "gpt-5.5",
					fullId: "openai-codex/gpt-5.5",
					reasoning: true,
				},
			],
		},
	);

	assert.deepEqual(resolved, {
		model: "openai-codex/gpt-5.5",
		thinking: "high",
	});
});

test("runtime model resolver asks before choosing ambiguous enabled models", async () => {
	const selections = [];
	const resolved = await resolveWorkflowRuntime(
		{ model: "gpt-5.5" },
		{
			taskKey: "main.main",
			stageId: "main",
			taskId: "main",
			agent: "unit-scout",
		},
		{
			defaults: { thinking: "medium" },
			availableModels: [
				{
					provider: "openai-codex",
					id: "gpt-5.5",
					fullId: "openai-codex/gpt-5.5",
					reasoning: true,
				},
				{
					provider: "github-copilot",
					id: "gpt-5.5",
					fullId: "github-copilot/gpt-5.5",
					reasoning: true,
				},
			],
			prompt: {
				async select(_title, options) {
					selections.push(options);
					return "github-copilot/gpt-5.5";
				},
			},
		},
	);

	assert.deepEqual(selections, [
		["github-copilot/gpt-5.5", "openai-codex/gpt-5.5"],
	]);
	assert.deepEqual(resolved, {
		model: "github-copilot/gpt-5.5",
		thinking: "medium",
	});
});

test("runtime model resolver asks before choosing an available model when requested model is missing", async () => {
	const selections = [];
	const resolved = await resolveWorkflowRuntime(
		{ model: "gpt-6" },
		{
			taskKey: "main.main",
			stageId: "main",
			taskId: "main",
			agent: "unit-scout",
		},
		{
			availableModels: [
				{
					provider: "openai-codex",
					id: "gpt-5.5",
					fullId: "openai-codex/gpt-5.5",
					reasoning: true,
				},
				{
					provider: "kimi-coding",
					id: "kimi-for-coding",
					fullId: "kimi-coding/kimi-for-coding",
					reasoning: true,
				},
			],
			prompt: {
				async select(_title, options) {
					selections.push(options);
					return "kimi-coding/kimi-for-coding";
				},
			},
		},
	);

	assert.deepEqual(selections, [
		["kimi-coding/kimi-for-coding", "openai-codex/gpt-5.5"],
	]);
	assert.deepEqual(resolved, { model: "kimi-coding/kimi-for-coding" });
});

test("runtime model resolver asks before changing unsupported thinking", async () => {
	const resolved = await resolveWorkflowRuntime(
		{ model: "gpt-5.5", thinking: "xhigh" },
		{
			taskKey: "main.main",
			stageId: "main",
			taskId: "main",
			agent: "unit-scout",
		},
		{
			availableModels: [
				{
					provider: "openai-codex",
					id: "gpt-5.5",
					fullId: "openai-codex/gpt-5.5",
					reasoning: true,
					thinkingLevelMap: {
						off: null,
						minimal: null,
						low: null,
						medium: "medium",
						high: "high",
					},
				},
			],
			prompt: {
				async select(_title, options) {
					assert.deepEqual(options, ["medium", "high"]);
					return "high";
				},
			},
		},
	);

	assert.deepEqual(resolved, {
		model: "openai-codex/gpt-5.5",
		thinking: "high",
	});
});

test("runtime model resolver refuses ambiguity, missing model, or unsupported thinking without UI", async () => {
	const context = {
		taskKey: "main.main",
		stageId: "main",
		taskId: "main",
		agent: "unit-scout",
	};
	const availableModels = [
		{
			provider: "openai-codex",
			id: "gpt-5.5",
			fullId: "openai-codex/gpt-5.5",
			reasoning: true,
		},
		{
			provider: "github-copilot",
			id: "gpt-5.5",
			fullId: "github-copilot/gpt-5.5",
			reasoning: true,
		},
	];

	await assert.rejects(
		() =>
			resolveWorkflowRuntime({ model: "gpt-5.5" }, context, {
				availableModels,
			}),
		/ambiguous in \/model/,
	);
	await assert.rejects(
		() =>
			resolveWorkflowRuntime(
				{ model: "openai-codex/gpt-5.5", thinking: "xhigh" },
				context,
				{
					availableModels: [
						{
							provider: "openai-codex",
							id: "gpt-5.5",
							fullId: "openai-codex/gpt-5.5",
							reasoning: false,
						},
					],
				},
			),
		/does not support reasoning level "xhigh"/,
	);
});

test("compiler applies runtime defaults before budget estimates", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const compiled = await compileWorkflow(
			workflowSpec("unit-scout", {
				budget: {
					expectedOutputTokensPerTask: 100,
					modelRates: {
						"openai-codex/gpt-5.5": {
							inputUsdPerMillionTokens: 1,
							outputUsdPerMillionTokens: 2,
						},
					},
				},
			}),
			{
				cwd,
				task: "Summarize",
				runtimeDefaults: { model: "openai-codex/gpt-5.5", thinking: "high" },
			},
		);

		assert.equal(compiled.tasks[0].runtime.model, "openai-codex/gpt-5.5");
		assert.equal(compiled.tasks[0].runtime.thinking, "high");
		assert.equal(compiled.budget.models[0].model, "openai-codex/gpt-5.5");
		assert.equal(compiled.budget.unratedModels.length, 0);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("run boundary requires runtime task", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		writeFileSync(
			join(cwd, "workflow.json"),
			JSON.stringify(workflowSpec("unit-scout")),
		);
		await assert.rejects(
			() => runWorkflow("workflow.json", cwd),
			/This workflow needs a task/,
		);
		await assert.rejects(
			() => runWorkflow("workflow.json", cwd, { task: "   " }),
			/This workflow needs a task/,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("workflow run runtime defaults reach launched subagents", async () => {
	const cwd = makeProject();
	const captured = [];
	try {
		writeAgent(cwd, "unit-scout", "read");
		writeFileSync(
			join(cwd, "workflow.json"),
			JSON.stringify(workflowSpec("unit-scout")),
		);
		setSubagentApiForTests({
			async runSubagent(options) {
				captured.push(options);
				return {
					runId: "run_runtime_defaults",
					attemptId: "attempt_runtime_defaults",
					status: "running",
				};
			},
			async getSubagentStatus() {
				return null;
			},
			async reconcileSubagentRun() {
				return {};
			},
			async interruptSubagent() {
				return {};
			},
		});

		const run = await runWorkflowSpec("workflow.json", cwd, {
			task: "Review the diff",
			runtimeDefaults: {
				model: "kimi-coding/kimi-for-coding",
				thinking: "low",
			},
		});

		assert.equal(run.tasks[0].runtime.model, "kimi-coding/kimi-for-coding");
		assert.equal(run.tasks[0].runtime.thinking, "low");
		assert.equal(captured[0].model, "kimi-coding/kimi-for-coding");
		assert.equal(captured[0].thinking, "low");
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("static run artifacts preserve declared workflow bundle files only", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		mkdirSync(join(workflowDir, "schemas"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		const spec = workflowSpec("unit-scout", {
			name: "bundle",
			artifactGraph: {
				stages: [
					{
						id: "audit",
						support: { uses: "./helpers/audit.mjs" },
						output: { controlSchema: "./schemas/audit-control.schema.json" },
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		writeFileSync(
			join(workflowDir, "templates.json"),
			JSON.stringify({ audit: { ok: true } }),
		);
		writeFileSync(
			join(workflowDir, "schemas", "audit-control.schema.json"),
			JSON.stringify({
				type: "object",
				properties: { item: { $ref: "./defs.json" } },
			}),
		);
		writeFileSync(
			join(workflowDir, "schemas", "defs.json"),
			JSON.stringify({ type: "string" }),
		);
		writeFileSync(
			join(workflowDir, "helpers", "legacy-dep.cjs"),
			"module.exports = { dep: true };\n",
		);
		writeFileSync(
			join(workflowDir, "helpers", "extensionless-dep.js"),
			"export const dep = true;\n",
		);
		writeFileSync(
			join(workflowDir, "helpers", "legacy.cjs"),
			"require('./legacy-dep.cjs');\nrequire('./extensionless-dep');\nmodule.exports = { ok: true };\n",
		);
		writeFileSync(
			join(workflowDir, "helpers", "audit.mjs"),
			[
				"// import './comment-only-missing.mjs';",
				"const ignored = \"import './string-only-missing.mjs'\";",
				"const ignoredMid = \"please import './string-mid-missing.mjs' later\";",
				"import './legacy.cjs';",
				"export default () => ({ ok: true, ignored });",
			].join("\n"),
		);

		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Summarize",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		const bundleDir = join(cwd, ".pi", "workflows", run.runId, "bundle");

		assert.equal(existsSync(join(bundleDir, "templates.json")), false);
		assert.match(
			readFileSync(join(bundleDir, "helpers", "audit.mjs"), "utf8"),
			/export default/,
		);
		assert.match(
			readFileSync(join(bundleDir, "helpers", "legacy.cjs"), "utf8"),
			/module\.exports/,
		);
		assert.match(
			readFileSync(join(bundleDir, "helpers", "legacy-dep.cjs"), "utf8"),
			/dep: true/,
		);
		assert.match(
			readFileSync(join(bundleDir, "helpers", "extensionless-dep.js"), "utf8"),
			/dep = true/,
		);
		assert.equal(
			existsSync(join(bundleDir, "helpers", "comment-only-missing.mjs")),
			false,
		);
		assert.equal(
			existsSync(join(bundleDir, "helpers", "string-only-missing.mjs")),
			false,
		);
		assert.equal(
			existsSync(join(bundleDir, "helpers", "string-mid-missing.mjs")),
			false,
		);
		assert.equal(
			readFileSync(
				join(bundleDir, "schemas", "audit-control.schema.json"),
				"utf8",
			),
			JSON.stringify({
				type: "object",
				properties: { item: { $ref: "./defs.json" } },
			}),
		);
		assert.equal(
			readFileSync(join(bundleDir, "schemas", "defs.json"), "utf8"),
			JSON.stringify({ type: "string" }),
		);

		const alternateDir = join(cwd, "workflows", "alternate-bundle");
		mkdirSync(join(alternateDir, "helpers"), { recursive: true });
		const alternateSpecPath = join(alternateDir, "review.json");
		const alternateSpec = workflowSpec("unit-scout", {
			name: "alternate-bundle",
			artifactGraph: {
				stages: [
					{
						id: "audit",
						support: { uses: "./helpers/audit.mjs" },
					},
				],
			},
		});
		writeFileSync(alternateSpecPath, JSON.stringify(alternateSpec));
		writeFileSync(
			join(alternateDir, "helpers", "audit.mjs"),
			"export default () => ({ ok: true });\n",
		);
		const alternateCompiled = await compileWorkflow(alternateSpec, {
			cwd,
			task: "Summarize",
			specPath: alternateSpecPath,
		});
		const { run: alternateRun } = await createWorkflowRunRecord(
			cwd,
			alternateCompiled,
			alternateSpecPath,
		);
		await writeStaticRunArtifacts(
			cwd,
			alternateRun,
			alternateCompiled,
			alternateSpec,
		);
		const alternateBundleDir = join(
			cwd,
			".pi",
			"workflows",
			alternateRun.runId,
			"bundle",
		);
		assert.equal(existsSync(join(alternateBundleDir, "spec.json")), false);
		assert.match(
			readFileSync(join(alternateBundleDir, "review.json"), "utf8"),
			/alternate-bundle/,
		);
		assert.match(
			readFileSync(join(alternateBundleDir, "helpers", "audit.mjs"), "utf8"),
			/export default/,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("static run artifacts reject escaping discovered bundle refs", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const schemaDir = join(cwd, "workflows", "schema-escape");
		mkdirSync(join(schemaDir, "schemas"), { recursive: true });
		const schemaSpecPath = join(schemaDir, "spec.json");
		const schemaSpec = workflowSpec("unit-scout", {
			name: "schema-escape",
			artifactGraph: {
				stages: [
					{
						id: "audit",
						type: "single",
						prompt: "Audit.",
						output: { controlSchema: "./schemas/control.json" },
					},
				],
			},
		});
		writeFileSync(schemaSpecPath, JSON.stringify(schemaSpec));
		writeFileSync(
			join(schemaDir, "schemas", "control.json"),
			JSON.stringify({
				type: "object",
				properties: { item: { $ref: "../../outside.json" } },
			}),
		);
		const schemaCompiled = await compileWorkflow(schemaSpec, {
			cwd,
			task: "Audit",
			specPath: schemaSpecPath,
		});
		const { run: schemaRun } = await createWorkflowRunRecord(
			cwd,
			schemaCompiled,
			schemaSpecPath,
		);
		await assert.rejects(
			() => writeStaticRunArtifacts(cwd, schemaRun, schemaCompiled, schemaSpec),
			/schema ref escapes workflow directory/,
		);

		const importDir = join(cwd, "workflows", "import-escape");
		mkdirSync(join(importDir, "helpers"), { recursive: true });
		const importSpecPath = join(importDir, "spec.json");
		const importSpec = workflowSpec("unit-scout", {
			name: "import-escape",
			artifactGraph: {
				stages: [{ id: "audit", support: { uses: "./helpers/audit.mjs" } }],
			},
		});
		writeFileSync(importSpecPath, JSON.stringify(importSpec));
		writeFileSync(
			join(importDir, "helpers", "audit.mjs"),
			"import '../../outside.mjs';\nexport default () => ({ ok: true });\n",
		);
		const importCompiled = await compileWorkflow(importSpec, {
			cwd,
			task: "Audit",
			specPath: importSpecPath,
		});
		const { run: importRun } = await createWorkflowRunRecord(
			cwd,
			importCompiled,
			importSpecPath,
		);
		await assert.rejects(
			() => writeStaticRunArtifacts(cwd, importRun, importCompiled, importSpec),
			/bundle import escapes workflow directory/,
		);

		const nestedDir = join(cwd, "workflows", "nested-invalid");
		mkdirSync(join(nestedDir, "helpers"), { recursive: true });
		mkdirSync(join(nestedDir, "nested"), { recursive: true });
		const nestedSpecPath = join(nestedDir, "spec.json");
		const nestedSpec = workflowSpec("unit-scout", {
			name: "nested-invalid",
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: {
							uses: "./helpers/controller.mjs",
							workflows: { child: { uses: "./nested/spec.json" } },
						},
					},
				],
			},
		});
		const invalidNestedSpec = workflowSpec("unit-scout", {
			name: "invalid-child",
			artifactGraph: {
				stages: [{ id: "bad", support: { uses: "../outside.mjs" } }],
			},
		});
		writeFileSync(nestedSpecPath, JSON.stringify(nestedSpec));
		writeFileSync(
			join(nestedDir, "helpers", "controller.mjs"),
			"export default () => ({ control: { schema: 'dynamic-controller-result-v1', summary: 'done' }, analysis: 'done', refs: [] });\n",
		);
		writeFileSync(
			join(nestedDir, "nested", "spec.json"),
			JSON.stringify(invalidNestedSpec),
		);
		const nestedCompiled = await compileWorkflow(nestedSpec, {
			cwd,
			task: "Audit",
			specPath: nestedSpecPath,
		});
		const { run: nestedRun } = await createWorkflowRunRecord(
			cwd,
			nestedCompiled,
			nestedSpecPath,
		);
		await assert.rejects(
			() => writeStaticRunArtifacts(cwd, nestedRun, nestedCompiled, nestedSpec),
			/support\.uses|workflow bundle ref/,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("run records use artifact-graph type and preserve artifact graph discriminator", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const compiled = await compileWorkflow(workflowSpec("unit-scout"), {
			cwd,
			task: "Summarize",
		});
		const { run } = await createWorkflowRunRecord(
			cwd,
			compiled,
			join(cwd, "workflow.json"),
		);
		assert.equal(run.type, WORKFLOW_RUN_TYPE);
		assert.equal(run.type, "artifact-graph");
		assert.deepEqual(run.artifactGraph, { enabled: true });
		assert.match(formatRun(run), /type=artifact-graph/);
		setTaskTerminal(run.tasks[0], "completed", "completed");
		assert.equal(deriveRunStatus(run).status, "completed");

		const artifactCompiled = await compileWorkflow(
			artifactGraphWorkflowSpec(),
			{
				cwd,
				task: "Summarize",
			},
		);
		const { run: artifactRun } = await createRunRecord(
			cwd,
			artifactCompiled,
			join(cwd, "artifact.json"),
		);
		assert.deepEqual(artifactRun.artifactGraph, { enabled: true });
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("run records create dynamic state paths for dynamic loop onExhausted templates", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const spec = loopWorkflowSpec({
			onExhausted: {
				id: "adaptive",
				type: "dynamic",
				dynamic: { uses: "./helpers/controller.mjs" },
			},
		});
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Loop with dynamic exhausted handler",
		});
		const { run } = await createRunRecord(
			cwd,
			compiled,
			join(cwd, "loop-dynamic.json"),
		);
		assert.ok(run.dynamic);
		assert.equal(
			existsSync(join(cwd, ".pi/workflows", run.runId, "dynamic")),
			true,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("workflow registry resolves exact names", async () => {
	const cwd = makeProject();
	try {
		mkdirSync(join(cwd, "workflows"), { recursive: true });
		writeDefaultStageControlSchema(join(cwd, "workflows"));
		writeFileSync(
			join(cwd, "workflows", "review.json"),
			JSON.stringify(
				artifactGraphWorkflowSpec({
					name: "review",
				}),
			),
		);

		const workflows = await listWorkflows(cwd);
		assert.deepEqual(
			workflows.map((item) => item.name),
			["review"],
		);
		const resolved = await resolveWorkflowRef("review", cwd);
		assert.equal(resolved.workflowName, "review");
		const loaded = await loadWorkflow("review", cwd);
		assert.equal(loaded.spec.name, "review");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("workflow specs are JSON-only and YAML files are rejected", async () => {
	const cwd = makeProject();
	try {
		mkdirSync(join(cwd, "workflows"), { recursive: true });
		writeFileSync(
			join(cwd, "workflows", "review.yaml"),
			[
				"schemaVersion: 1",
				"name: review",
				"artifactGraph:",
				"  stages:",
				"    - id: main",
				"      type: single",
				"      prompt: Review.",
				"",
			].join("\n"),
		);
		writeFileSync(
			join(cwd, "workflows", "other.yml"),
			"schemaVersion: 1\nartifactGraph:\n  stages: []\n",
		);

		const workflows = await listWorkflows(cwd);
		assert.deepEqual(
			workflows.map((item) => item.name),
			[],
		);
		await assert.rejects(
			() => resolveWorkflowRef("review", cwd),
			/workflow name or spec file not found/,
		);
		await assert.rejects(
			() => loadWorkflow("./workflows/review.yaml", cwd),
			/YAML workflow specs are not supported; use JSON \(\.json\)\./,
		);
		await assert.rejects(
			() => loadWorkflow("./workflows/other.yml", cwd),
			/YAML workflow specs are not supported; use JSON \(\.json\)\./,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("workflow registry does not resolve prelaunch renamed workflow aliases", async () => {
	const cwd = makeProject();
	try {
		mkdirSync(join(cwd, "workflows", "modern-review"), { recursive: true });
		writeFileSync(
			join(cwd, "workflows", "modern-review", "spec.json"),
			JSON.stringify(artifactGraphWorkflowSpec({ name: "modern-review" })),
		);

		await assert.rejects(
			() => resolveWorkflowRef("dynamic-review", cwd),
			/workflow name or spec file not found/,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("workflow registry resolves bundle specs and sets correct workflowRoot", async () => {
	const cwd = makeProject();
	try {
		mkdirSync(join(cwd, "workflows", "bundle-wf"), { recursive: true });
		writeDefaultStageControlSchema(join(cwd, "workflows", "bundle-wf"));
		writeFileSync(
			join(cwd, "workflows", "bundle-wf", "spec.json"),
			JSON.stringify(
				artifactGraphWorkflowSpec({
					name: "bundle-wf",
				}),
			),
		);

		const workflows = await listWorkflows(cwd);
		const bundleRecord = workflows.find(
			(workflow) => workflow.name === "bundle-wf",
		);
		assert.ok(bundleRecord);
		assert.equal(
			bundleRecord.specPath,
			join(cwd, "workflows", "bundle-wf", "spec.json"),
		);
		assert.equal(
			bundleRecord.workflowRoot,
			join(cwd, "workflows", "bundle-wf"),
		);
		assert.deepEqual(bundleRecord.aliases, ["bundle-wf"]);

		const resolved = await resolveWorkflowRef("bundle-wf", cwd);
		assert.equal(resolved.workflowName, "bundle-wf");
		assert.equal(resolved.workflowRoot, join(cwd, "workflows", "bundle-wf"));

		const loaded = await loadWorkflow("bundle-wf", cwd);
		assert.equal(loaded.spec.name, "bundle-wf");
		assert.equal(
			loaded.specPath,
			join(cwd, "workflows", "bundle-wf", "spec.json"),
		);

		// Run-state directories store a spec.json snapshot; they must never
		// register as workflows even though they live under .pi/workflows/.
		mkdirSync(join(cwd, ".pi", "workflows", "workflow_mq99zzzz_abc123"), {
			recursive: true,
		});
		writeFileSync(
			join(cwd, ".pi", "workflows", "workflow_mq99zzzz_abc123", "spec.json"),
			JSON.stringify(workflowSpec("unit-scout", { name: "bundle-wf" })),
		);
		const withRunState = await listWorkflows(cwd);
		assert.ok(
			!withRunState.some((workflow) =>
				workflow.specPath.includes("workflow_mq99zzzz_abc123"),
			),
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("workflow registry fails closed when flat and bundle specs conflict", async () => {
	const cwd = makeProject();
	try {
		mkdirSync(join(cwd, "workflows", "ambiguous"), { recursive: true });
		writeFileSync(
			join(cwd, "workflows", "ambiguous.json"),
			JSON.stringify(artifactGraphWorkflowSpec({ name: "ambiguous" })),
		);
		writeFileSync(
			join(cwd, "workflows", "ambiguous", "spec.json"),
			JSON.stringify(artifactGraphWorkflowSpec({ name: "ambiguous" })),
		);

		await assert.rejects(
			() => resolveWorkflowRef("ambiguous", cwd),
			/ambiguous workflow name/,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("workflow command completions and run arg parsing preserve task text", () => {
	const workflows = [
		{
			name: "review",
			specPath: "/tmp/review.json",
			fileName: "review.json",
			aliases: ["review"],
			workflowRoot: "/tmp",
		},
	];
	assert.deepEqual(
		workflowArgumentCompletions("", workflows)?.map((item) => item.value),
		[
			"help",
			"list",
			"validate",
			"roles",
			"agents",
			"run",
			"dynamic",
			"status",
			"show",
			"logs",
			"wait",
			"resume",
		],
	);
	assert.deepEqual(
		workflowArgumentCompletions("l", workflows)?.map((item) => item.value),
		["list", "logs"],
	);
	assert.deepEqual(
		workflowArgumentCompletions("run re", workflows)?.map((item) => item.value),
		["run review"],
	);
	assert.deepEqual(
		workflowArgumentCompletions("validate re", workflows)?.map(
			(item) => item.value,
		),
		["validate review"],
	);
	assert.deepEqual(
		parseWorkflowRunArgs("run review Fix this:\n  const x = 1;"),
		{ specPath: "review", task: "Fix this:\n  const x = 1;", detach: false },
	);
	assert.deepEqual(parseWorkflowRunArgs('run review "Fix the thing"'), {
		specPath: "review",
		task: "Fix the thing",
		detach: false,
	});
	assert.deepEqual(
		parseWorkflowRunArgs('run review "Fix the thing" --detach'),
		{ specPath: "review", task: "Fix the thing", detach: true },
	);
	assert.deepEqual(
		parseWorkflowRunArgs('run review "Keep literal --detach in the task"'),
		{
			specPath: "review",
			task: "Keep literal --detach in the task",
			detach: false,
		},
	);
	assert.deepEqual(
		parseWorkflowRunArgs(
			'run review "Keep literal --model=openai-codex/gpt-5.5 in the task"',
		),
		{
			specPath: "review",
			task: "Keep literal --model=openai-codex/gpt-5.5 in the task",
			detach: false,
		},
	);
	assert.deepEqual(
		parseWorkflowRunArgs(
			'run --model kimi-coding/kimi-for-coding --thinking low review "Fix the thing" --detach',
		),
		{
			specPath: "review",
			task: "Fix the thing",
			detach: true,
			model: "kimi-coding/kimi-for-coding",
			thinking: "low",
		},
	);
	assert.deepEqual(
		parseWorkflowRunArgs(
			'run review "Fix the thing" --model=openai-codex/gpt-5.5 --reasoning=xhigh',
		),
		{
			specPath: "review",
			task: "Fix the thing",
			detach: false,
			model: "openai-codex/gpt-5.5",
			thinking: "xhigh",
		},
	);
	assert.deepEqual(
		parseWorkflowDynamicArgs(
			'dynamic --model openai-codex/gpt-5.5 --thinking low "Research adaptive workflows" --detach',
		),
		{
			task: "Research adaptive workflows",
			detach: true,
			model: "openai-codex/gpt-5.5",
			thinking: "low",
		},
	);
	assert.deepEqual(
		parseWorkflowDynamicArgs(
			'dynamic "Keep literal --detach and --model=x in the task"',
		),
		{
			task: "Keep literal --detach and --model=x in the task",
			detach: false,
		},
	);
	assert.throws(
		() => parseWorkflowRunArgs("run --thinking turbo review Fix"),
		/Invalid workflow thinking level/,
	);
});

test("natural-language workflow tools list and start workflows", async () => {
	const cwd = makeProject();
	const originalRole = process.env.PI_WORKFLOW_ROLE;
	try {
		process.env.PI_WORKFLOW_ROLE = "supervisor";
		writeAgent(cwd, "unit-scout", "read");
		mkdirSync(join(cwd, "workflows"), { recursive: true });
		writeFileSync(
			join(cwd, "workflows", "research-lite.json"),
			JSON.stringify(
				workflowSpec("unit-scout", {
					name: "research-lite",
					description: "Research lite workflow",
				}),
			),
		);

		const disabledTools = [];
		registerWorkflowNaturalLanguageTools(
			{
				registerTool(tool) {
					disabledTools.push(tool);
				},
			},
			{ PI_WORKFLOW_ROLE: "worker" },
		);
		assert.equal(disabledTools.length, 0);

		const registeredTools = [];
		const fakePi = {
			registerTool(tool) {
				registeredTools.push(tool);
			},
			getThinkingLevel() {
				return undefined;
			},
		};
		registerWorkflowNaturalLanguageTools(fakePi, {
			PI_WORKFLOW_ROLE: "supervisor",
		});
		assert.deepEqual(
			registeredTools.map((tool) => tool.name),
			[WORKFLOW_LIST_TOOL, WORKFLOW_RUN_TOOL, WORKFLOW_DYNAMIC_TOOL],
		);
		assert.match(registeredTools[1].promptSnippet, /Start a pi-workflow/);

		const ctx = {
			cwd,
			hasUI: false,
			model: undefined,
			ui: { notify() {} },
		};
		const listResult = await registeredTools[0].execute(
			"tool-list",
			{},
			undefined,
			undefined,
			ctx,
		);
		assert.match(listResult.content[0].text, /research-lite/);
		assert.equal(
			listResult.details.workflows[0].description,
			"Research lite workflow",
		);

		await assert.rejects(
			() =>
				registeredTools[1].execute(
					"tool-run-empty",
					{ workflow: "research-lite", task: "   " },
					undefined,
					undefined,
					ctx,
				),
			/concrete task/,
		);

		let launchedTask = "";
		setSubagentApiForTests({
			async runSubagent(options) {
				launchedTask = String(options.task ?? "");
				return {
					runId: "run_tool_1",
					attemptId: "attempt_tool_1",
					status: "running",
				};
			},
			async getSubagentStatus() {
				return null;
			},
			async reconcileSubagentRun() {
				return {};
			},
			async interruptSubagent() {
				return {};
			},
		});
		const runResult = await registeredTools[1].execute(
			"tool-run",
			{ workflow: "research-lite", task: "Investigate the repo" },
			undefined,
			undefined,
			ctx,
		);
		assert.match(runResult.content[0].text, /Workflow run workflow_/);
		assert.match(runResult.content[0].text, /Open: \/workflow workflow_/);
		assert.equal(runResult.details.status, "running");
		assert.match(launchedTask, /Investigate the repo/);
	} finally {
		setSubagentApiForTests(undefined);
		if (originalRole === undefined) delete process.env.PI_WORKFLOW_ROLE;
		else process.env.PI_WORKFLOW_ROLE = originalRole;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("natural-language workflow tools list and start workflows", async () => {
	const cwd = makeProject();
	const originalRole = process.env.PI_WORKFLOW_ROLE;
	try {
		process.env.PI_WORKFLOW_ROLE = "supervisor";
		writeAgent(cwd, "unit-scout", "read");
		mkdirSync(join(cwd, "workflows"), { recursive: true });
		writeFileSync(
			join(cwd, "workflows", "research-lite.json"),
			JSON.stringify(
				workflowSpec("unit-scout", {
					name: "research-lite",
					description: "Research lite workflow",
				}),
			),
		);

		const disabledTools = [];
		registerWorkflowNaturalLanguageTools(
			{
				registerTool(tool) {
					disabledTools.push(tool);
				},
			},
			{ PI_WORKFLOW_ROLE: "worker" },
		);
		assert.equal(disabledTools.length, 0);

		const registeredTools = [];
		const fakePi = {
			registerTool(tool) {
				registeredTools.push(tool);
			},
			getThinkingLevel() {
				return undefined;
			},
		};
		registerWorkflowNaturalLanguageTools(fakePi, {
			PI_WORKFLOW_ROLE: "supervisor",
		});
		assert.deepEqual(
			registeredTools.map((tool) => tool.name),
			[WORKFLOW_LIST_TOOL, WORKFLOW_RUN_TOOL, WORKFLOW_DYNAMIC_TOOL],
		);
		assert.match(registeredTools[1].promptSnippet, /Start a pi-workflow/);

		const ctx = {
			cwd,
			hasUI: false,
			model: undefined,
			ui: { notify() {} },
		};
		const listResult = await registeredTools[0].execute(
			"tool-list",
			{},
			undefined,
			undefined,
			ctx,
		);
		assert.match(listResult.content[0].text, /research-lite/);
		assert.equal(
			listResult.details.workflows[0].description,
			"Research lite workflow",
		);

		await assert.rejects(
			() =>
				registeredTools[1].execute(
					"tool-run-empty",
					{ workflow: "research-lite", task: "   " },
					undefined,
					undefined,
					ctx,
				),
			/concrete task/,
		);

		let launchedTask = "";
		setSubagentApiForTests({
			async runSubagent(options) {
				launchedTask = String(options.task ?? "");
				return {
					runId: "run_tool_1",
					attemptId: "attempt_tool_1",
					status: "running",
				};
			},
			async getSubagentStatus() {
				return null;
			},
			async reconcileSubagentRun() {
				return {};
			},
			async interruptSubagent() {
				return {};
			},
		});
		const runResult = await registeredTools[1].execute(
			"tool-run",
			{ workflow: "research-lite", task: "Investigate the repo" },
			undefined,
			undefined,
			ctx,
		);
		assert.match(runResult.content[0].text, /Workflow run workflow_/);
		assert.match(runResult.content[0].text, /Open: \/workflow workflow_/);
		assert.equal(runResult.details.status, "running");
		assert.match(launchedTask, /Investigate the repo/);
	} finally {
		setSubagentApiForTests(undefined);
		if (originalRole === undefined) delete process.env.PI_WORKFLOW_ROLE;
		else process.env.PI_WORKFLOW_ROLE = originalRole;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("spec-less direct dynamic run records provenance and launches planner", async () => {
	const cwd = makeProject();
	try {
		const launched = [];
		setSubagentApiForTests({
			async runSubagent(options) {
				launched.push(options);
				return {
					runId: "run_dynamic_planner",
					attemptId: "attempt_dynamic_planner",
					status: "running",
				};
			},
			async getSubagentStatus() {
				return null;
			},
			async reconcileSubagentRun() {
				return {};
			},
			async interruptSubagent() {
				return {};
			},
		});

		const run = await runDynamicTask(cwd, {
			task: "Research dynamic workflow evaluation methods.",
			runtimeDefaults: { model: "openai-codex/gpt-5.5", thinking: "low" },
		});
		assert.equal(run.status, "running");
		assert.equal(run.name, "dynamic");
		assert.equal(run.provenance.mode, "direct-dynamic");
		assert.equal(run.provenance.requestedWorkflow, null);
		assert.equal(run.provenance.specPath, null);
		assert.equal(run.provenance.userSelectedWorkflow, false);
		assert.equal(run.provenance.generatedSpec, false);
		assert.match(
			run.provenance.runtimeBundle,
			/\.pi\/workflow-runtime\/direct-dynamic-runtime-v1\/spec\.json$/,
		);
		assert.equal(run.tasks[0].kind, "dynamic");
		assert.equal(launched.length, 1);
		assert.equal(launched[0].model, "openai-codex/gpt-5.5");
		assert.equal(launched[0].thinking, "low");
		assert.deepEqual(
			launched[0].tools.filter((tool) => tool !== "workflow_artifact"),
			[
				"read",
				"grep",
				"find",
				"ls",
				"workflow_web_search",
				"workflow_web_fetch_source",
				"workflow_web_source_read",
			],
		);
		assert.equal(launched[0].tools.includes("get_search_content"), false);
		assert.match(
			String(launched[0].systemPrompt),
			/Only these tools are enabled for this workflow task: read, grep, find, ls, workflow_web_search, workflow_web_fetch_source, workflow_web_source_read, workflow_artifact\./,
		);
		assert.match(
			String(launched[0].systemPrompt),
			/Workflow web-source tools return compact source cards\./,
		);
		const materializedSpec = JSON.parse(
			readFileSync(join(cwd, run.provenance.runtimeBundle), "utf8"),
		);
		assert.equal(
			JSON.stringify(materializedSpec).includes("get_search_content"),
			false,
		);
		assert.match(String(launched[0].task), /request-only direct dynamic/);
		assert.match(
			String(launched[0].task),
			/Research dynamic workflow evaluation methods/,
		);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("workflow_dynamic tool starts spec-less direct dynamic runs", async () => {
	const cwd = makeProject();
	const originalRole = process.env.PI_WORKFLOW_ROLE;
	try {
		process.env.PI_WORKFLOW_ROLE = "supervisor";
		const registeredTools = [];
		const fakePi = {
			registerTool(tool) {
				registeredTools.push(tool);
			},
			getThinkingLevel() {
				return "low";
			},
		};
		registerWorkflowNaturalLanguageTools(fakePi, {
			PI_WORKFLOW_ROLE: "supervisor",
		});
		const dynamicTool = registeredTools.find(
			(tool) => tool.name === WORKFLOW_DYNAMIC_TOOL,
		);
		assert.ok(dynamicTool);

		const launched = [];
		setSubagentApiForTests({
			async runSubagent(options) {
				launched.push(options);
				return {
					runId: "run_tool_dynamic_1",
					attemptId: "attempt_tool_dynamic_1",
					status: "running",
				};
			},
			async getSubagentStatus() {
				return null;
			},
			async reconcileSubagentRun() {
				return {};
			},
			async interruptSubagent() {
				return {};
			},
		});
		const ctx = {
			cwd,
			hasUI: false,
			model: undefined,
			ui: { notify() {} },
		};
		await assert.rejects(
			() =>
				dynamicTool.execute(
					"tool-dynamic-empty",
					{ task: "   " },
					undefined,
					undefined,
					ctx,
				),
			/concrete task/,
		);
		const result = await dynamicTool.execute(
			"tool-dynamic",
			{ task: "Research this with a dynamic workflow" },
			undefined,
			undefined,
			ctx,
		);
		assert.match(result.content[0].text, /Dynamic workflow run workflow_/);
		assert.match(result.content[0].text, /Mode: direct-dynamic/);
		assert.equal(result.details.mode, "direct-dynamic");
		assert.equal(result.details.provenance.userSelectedWorkflow, false);
		assert.equal(launched.length, 1);
		assert.match(
			String(launched[0].task),
			/Research this with a dynamic workflow/,
		);
	} finally {
		setSubagentApiForTests(undefined);
		if (originalRole === undefined) delete process.env.PI_WORKFLOW_ROLE;
		else process.env.PI_WORKFLOW_ROLE = originalRole;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("workflow index preserves run linkage and task metadata", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const spec = artifactGraphWorkflowSpec();
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Index metadata",
		});
		const { run } = await createRunRecord(
			cwd,
			compiled,
			join(cwd, "index-metadata.json"),
			{ parentRunId: "workflow_parent", rootRunId: "workflow_root" },
		);
		await writeRunRecord(cwd, run);
		const index = await updateIndex(cwd);
		const indexed = index.runs.find(
			(candidate) => candidate.runId === run.runId,
		);
		assert.ok(indexed);
		assert.equal(indexed.parentRunId, "workflow_parent");
		assert.equal(indexed.rootRunId, "workflow_root");
		assert.equal(indexed.tasks[0].kind, run.tasks[0].kind);
		assert.equal(indexed.tasks[0].stageId, run.tasks[0].stageId);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("resolveFlowsCwd finds ancestor workflow state root", async () => {
	const cwd = makeProject();
	try {
		mkdirSync(join(cwd, ".pi", "workflows"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "workflows", "index.json"),
			JSON.stringify({
				schemaVersion: 1,
				updatedAt: "2026-06-04T00:00:00.000Z",
				runs: [],
			}),
		);
		const nested = join(cwd, "a", "b");
		mkdirSync(nested, { recursive: true });
		assert.equal(await resolveFlowsCwd(nested), cwd);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("resumeRun resets failed and skipped tasks, preserves completed work, and relaunches", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout");
		const spec = workflowSpec("unit-scout", {
			artifactGraph: {
				stages: [
					{
						id: "one",
						type: "single",
						output: { format: "json" },
						prompt: "Step one.",
					},
					{
						id: "two",
						type: "reduce",
						from: "one",
						output: { format: "json" },
						prompt: "Step two.",
					},
					{ id: "three", type: "reduce", from: "two", prompt: "Step three." },
				],
			},
		});
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Resume target",
		});
		const { run } = await createWorkflowRunRecord(
			cwd,
			compiled,
			join(cwd, "workflows", "unit.json"),
		);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);

		await completeTask(cwd, taskBySpec(run, "one.main"), { facts: ["a"] });
		setTaskTerminal(taskBySpec(run, "two.main"), "failed", "failed", {
			exitCode: 1,
			lastMessage: "boom",
		});
		setTaskTerminal(
			taskBySpec(run, "three.main"),
			"skipped",
			"skipped_after_dependency_failure",
			{ lastMessage: "skipped" },
		);
		await writeRunRecord(cwd, run);
		assert.equal((await readRunRecord(cwd, run.runId)).status, "failed");

		const launchedTasks = [];
		setSubagentApiForTests({
			async runSubagent(options) {
				launchedTasks.push(String(options.task ?? "").slice(0, 40));
				return {
					runId: "run_stub",
					attemptId: "attempt_stub",
					status: "running",
				};
			},
			async getSubagentStatus() {
				return null;
			},
			async reconcileSubagentRun() {
				return {};
			},
			async interruptSubagent() {
				return {};
			},
		});
		try {
			const { run: resumed, resetTaskIds } = await resumeRun(cwd, run.runId);
			assert.deepEqual(resetTaskIds, [
				taskBySpec(run, "two.main").taskId,
				taskBySpec(run, "three.main").taskId,
			]);
			assert.equal(resumed.status, "running");
			assert.equal(taskBySpec(resumed, "one.main").status, "completed");
			assert.equal(taskBySpec(resumed, "two.main").status, "running");
			assert.equal(taskBySpec(resumed, "three.main").status, "pending");
			assert.equal(launchedTasks.length, 1);
		} finally {
			setSubagentApiForTests(undefined);
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("resumeRun rejects completed and loop runs", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout");
		const spec = workflowSpec("unit-scout", {
			artifactGraph: {
				stages: [{ id: "only", type: "single", prompt: "Do it." }],
			},
		});
		const compiled = await compileWorkflow(spec, { cwd, task: "Done target" });
		const { run } = await createWorkflowRunRecord(
			cwd,
			compiled,
			join(cwd, "workflows", "unit.json"),
		);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await completeTask(cwd, taskBySpec(run, "only.main"), {});
		await writeRunRecord(cwd, run);
		await assert.rejects(
			() => resumeRun(cwd, run.runId),
			/failed, interrupted, or resumable blocked/,
		);

		const { run: loopRun } = await createLoopRun(cwd);
		setTaskTerminal(loopRun.tasks[0], "failed", "failed", { exitCode: 1 });
		for (const task of loopRun.tasks.slice(1))
			setTaskTerminal(task, "skipped", "skipped", {});
		await writeRunRecord(cwd, loopRun);
		await assert.rejects(() => resumeRun(cwd, loopRun.runId), /loop workflows/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("notifyUnfinishedRuns reports recent failed root runs with resume hint", async () => {
	const cwd = makeProject();
	try {
		const nowMs = Date.parse("2026-06-12T12:00:00.000Z");
		const indexDir = join(cwd, ".pi", "workflows");
		mkdirSync(indexDir, { recursive: true });
		const summary = {
			pending: 0,
			running: 0,
			blocked: 0,
			completed: 1,
			failed: 1,
			skipped: 3,
			interrupted: 0,
			total: 5,
		};
		writeFileSync(
			join(indexDir, "index.json"),
			JSON.stringify({
				schemaVersion: 1,
				updatedAt: "2026-06-12T11:00:00.000Z",
				runs: [
					{
						runId: "workflow_recent",
						name: "deep-research",
						type: "artifact-graph",
						status: "failed",
						taskSummary: summary,
						createdAt: "2026-06-11T00:00:00.000Z",
						updatedAt: "2026-06-11T00:00:00.000Z",
						runJson: "x",
						tasks: [],
					},
					{
						runId: "workflow_old",
						name: "stale",
						type: "artifact-graph",
						status: "failed",
						taskSummary: summary,
						createdAt: "2026-05-01T00:00:00.000Z",
						updatedAt: "2026-05-01T00:00:00.000Z",
						runJson: "x",
						tasks: [],
					},
					{
						runId: "workflow_child",
						name: "loop-child",
						type: "artifact-graph",
						status: "failed",
						parentRunId: "workflow_recent",
						taskSummary: summary,
						createdAt: "2026-06-11T00:00:00.000Z",
						updatedAt: "2026-06-11T00:00:00.000Z",
						runJson: "x",
						tasks: [],
					},
					{
						runId: "workflow_done",
						name: "ok",
						type: "artifact-graph",
						status: "completed",
						taskSummary: summary,
						createdAt: "2026-06-11T00:00:00.000Z",
						updatedAt: "2026-06-11T00:00:00.000Z",
						runJson: "x",
						tasks: [],
					},
				],
			}),
		);

		const notices = [];
		await notifyUnfinishedRuns(
			cwd,
			(message, type) => notices.push({ message, type }),
			nowMs,
		);
		assert.equal(notices.length, 1);
		assert.equal(notices[0].type, "warning");
		assert.match(notices[0].message, /deep-research workflow_recent: failed/);
		assert.match(notices[0].message, /\/workflow resume workflow_recent/);
		assert.doesNotMatch(
			notices[0].message,
			/workflow_old|workflow_child|workflow_done/,
		);

		const silent = [];
		await notifyUnfinishedRuns(
			join(cwd, "no-such"),
			(message) => silent.push(message),
			nowMs,
		);
		assert.equal(silent.length, 0);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("deep-review finding-pipeline dedups by file+title-token overlap and partitions verdicts with severity join", async () => {
	const helperPath = join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
		"workflows",
		"deep-review",
		"helpers",
		"finding-pipeline.mjs",
	);
	const helper = (await import(pathToFileURL(helperPath).href)).default;

	const dedup = await helper({
		sources: {
			"reviewers.lens-a": {
				findings: [
					{
						severity: "critical",
						title: "matchHostname drops trailing anchor",
						file: "host/src/host/patterns.ts",
						evidence: "patterns.ts:42",
					},
					{
						severity: "major",
						title: "Port upper bound removed",
						evidence: "host/src/sandbox/server-ops.ts:10",
					},
				],
			},
			"reviewers.lens-b": {
				findings: [
					{
						severity: "critical",
						title: "matchHostname regex trailing anchor dropped",
						file: "host/src/host/patterns.ts",
						evidence: "patterns.ts:42 with longer supporting evidence",
					},
				],
			},
		},
		options: { mode: "dedup" },
		context: {
			sourceStatuses: [
				{
					source: "reviewers.release-test-hygiene",
					specId: "reviewers.release-test-hygiene",
					stageId: "reviewers",
					status: "failed",
					statusDetail: "failed",
					lastMessage: "pi-subagent run failed: model",
					errorType: "model_failure",
				},
			],
		},
	});
	assert.equal(dedup.dedupSummary.rawCount, 3);
	assert.equal(dedup.dedupSummary.uniqueCount, 2);
	assert.equal(dedup.dedupSummary.duplicateCount, 1);
	assert.match(dedup.digest, /dedup: raw=3, unique=2, duplicates=1/);
	// Duplicate resolution keeps the variant with more evidence text.
	assert.ok(
		dedup.findings.some((f) => f.evidence.includes("longer supporting")),
	);

	const distinctTestEvidenceFindings = await helper({
		sources: {
			"reviewers.lens-a": {
				findings: [
					{
						title:
							"Role-restriction unit tests would fail if assertWorkflowActionAllowedForRole is removed",
						file: "test/unit/unit.test.mjs",
					},
					{
						title:
							"JSON output contract-path tests would fail if selectorPaths matching and fallback are removed",
						file: "test/unit/unit.test.mjs",
					},
				],
			},
		},
		options: { mode: "dedup" },
	});
	assert.equal(distinctTestEvidenceFindings.dedupSummary.uniqueCount, 2);
	assert.equal(distinctTestEvidenceFindings.dedupSummary.duplicateCount, 0);

	const partition = await helper({
		sources: {
			"dedup-findings.main": dedup,
			"devil-advocate.item-001": {
				finding: { title: "matchHostname trailing anchor regex dropped" },
				verdict: "KEPT",
			},
			"devil-advocate.item-002": {
				finding: { title: "Port upper bound removed" },
				verdict: "totally bogus verdict",
			},
		},
		options: { mode: "partition", dedupStage: "dedup-findings" },
		context: {
			sourceStatuses: [
				{
					source: "devil-advocate.item-003",
					specId: "devil-advocate.item-003",
					stageId: "devil-advocate",
					status: "failed",
					statusDetail: "failed",
					lastMessage: "pi-subagent run failed: model",
					errorType: "model_failure",
				},
			],
		},
	});
	assert.equal(partition.partitionSummary.keep, 1);
	assert.match(partition.digest, /partition: keep=1/);
	assert.equal(partition.partitionSummary.partialFailures, 2);
	assert.equal("reviewerFinding" in partition.partitions.keep[0], false);
	assert.deepEqual(
		partition.reportContext.partialFailures.map((failure) => failure.specId),
		["devil-advocate.item-003", "reviewers.release-test-hygiene"],
	);
	assert.equal(partition.sourceStatusSummary.total, 2);
	assert.equal(partition.sourceStatusSummary.completed, 0);
	assert.equal(partition.sourceStatusSummary.nonCompleted, 2);
	assert.equal(
		partition.reportContext.keep[0].findingId,
		partition.partitions.keep[0].findingId,
	);
	// Severity joined from the reviewer finding, not the devil-advocate echo.
	assert.equal(partition.partitions.keep[0].severity, "critical");
	// Unrecognized verdict routes to needsHuman, not silence.
	assert.equal(partition.partitionSummary.needsHuman, 1);
	assert.ok(
		partition.normalizationNotes.some((n) =>
			n.includes("unrecognized verdict"),
		),
	);

	const sparseUnmatchedVerdict = await helper({
		sources: {
			"dedup-findings.main": { findings: [] },
			"devil-advocate.item-001": {
				finding: { title: "Sparse unmatched claim" },
				verdict: "KEEP",
			},
		},
		options: { mode: "partition", dedupStage: "dedup-findings" },
	});
	assert.equal(sparseUnmatchedVerdict.partitionSummary.keep, 0);
	assert.equal(sparseUnmatchedVerdict.partitionSummary.needsHuman, 1);
	assert.equal(
		sparseUnmatchedVerdict.partitions.needsHuman[0].findingId,
		"verdict-001",
	);
	assert.ok(
		sparseUnmatchedVerdict.normalizationNotes.some((note) =>
			note.includes("lacked identity evidence"),
		),
	);

	const weakenCounterEvidence = await helper({
		sources: {
			"dedup-findings.main": {
				findings: [
					{
						severity: "medium",
						title: "Config parser accepts invalid booleans",
						file: "src/config.ts",
						locations: [{ file: "src/config.ts", line: 12 }],
						evidenceQuotes: ["parseBoolean(value)"],
					},
				],
			},
			"devil-advocate.item-001": {
				finding: { title: "Config parser accepts invalid booleans" },
				verdict: "WEAKEN",
				counterEvidence: "Only non-production config paths call this parser.",
			},
		},
		options: { mode: "partition", dedupStage: "dedup-findings" },
	});
	assert.deepEqual(
		weakenCounterEvidence.reportContext.weaken[0].counterEvidence,
		["Only non-production config paths call this parser."],
	);

	const supportDemotion = await helper({
		sources: {
			"dedup-findings.main": {
				findings: [
					{
						severity: "medium",
						title: "Dropping colon parser loses file:line locations",
						file: "workflows/deep-review/helpers/finding-pipeline.mjs",
						locations: [
							{
								file: "workflows/deep-review/helpers/finding-pipeline.mjs",
								line: 96,
							},
						],
						evidence:
							"removing :801 parsing loses line pins; tests mention the path but the runtime behavior is the defect",
						evidenceQuotes: ["|:(\\d{1,6})(?:[–-](\\d{1,6}))?"],
						recommendedAction: "Restore the parser and add targeted tests.",
					},
					{
						severity: "low",
						title: "Dead match[4] fallback remains after capture group removal",
						file: "workflows/deep-review/helpers/finding-pipeline.mjs",
						evidence: "const start still reads match[4]",
					},
					{
						severity: "low",
						title: "Stale comment still says colon references are supported",
						file: "workflows/deep-review/helpers/finding-pipeline.mjs",
						evidence: "comment mentions :N references",
					},
					{
						severity: "low",
						title: "Existing tests do not cover file:line fallback",
						file: "test/unit/unit.test.mjs",
						evidence: "test coverage gap",
					},
				],
			},
			"devil-advocate.item-001": {
				finding: { title: "Dropping colon parser loses file:line locations" },
				verdict: "KEEP",
			},
			"devil-advocate.item-002": {
				finding: {
					title: "Dead match[4] fallback remains after capture group removal",
				},
				verdict: "KEEP",
			},
			"devil-advocate.item-003": {
				finding: {
					title: "Stale comment still says colon references are supported",
				},
				verdict: "KEEP",
			},
			"devil-advocate.item-004": {
				finding: { title: "Existing tests do not cover file:line fallback" },
				verdict: "WEAKEN",
			},
		},
		options: { mode: "partition", dedupStage: "dedup-findings" },
	});
	assert.deepEqual(
		supportDemotion.partitions.keep.map((finding) => finding.title),
		["Dropping colon parser loses file:line locations"],
	);
	assert.deepEqual(supportDemotion.partitions.weaken, []);
	assert.equal(supportDemotion.partitionSummary.supportNotes, 3);
	assert.equal(supportDemotion.supportNotes.length, 3);
	assert.ok(
		supportDemotion.supportNotes.every(
			(note) =>
				note.supportingFindingOf ===
				"Dropping colon parser loses file:line locations",
		),
	);
	assert.ok(
		supportDemotion.normalizationNotes.some((note) =>
			note.includes("support finding"),
		),
	);

	const d4DuplicateRootCollapse = await helper({
		sources: {
			"dedup-findings.main": {
				findings: [
					{
						severity: "medium",
						title:
							"Regex/capture-group contract mismatch and loss of ':line' location extraction",
						file: "workflows/deep-review/helpers/finding-pipeline.mjs",
						locations: [
							{
								file: "workflows/deep-review/helpers/finding-pipeline.mjs",
								line: 96,
								lineEnd: 106,
							},
						],
						evidenceQuotes: [
							"-  const re = /(?:\\blines?\\s+~?(\\d{1,6})(?:\\s*[–-]\\s*(\\d{1,6}))?|\\bL(\\d{1,6})\\b|:(\\d{1,6})(?:[–-](\\d{1,6}))?)/gi;",
							"+  const re = /(?:\\blines?\\s+~?(\\d{1,6})(?:\\s*[–-]\\s*(\\d{1,6}))?|\\bL(\\d{1,6})\\b)/gi;",
							"This leaves dead, misleading code.",
						],
					},
					{
						severity: "medium",
						title:
							"Removing ':' line-reference extraction drops structured locations for file:line evidence",
						file: "workflows/deep-review/helpers/finding-pipeline.mjs",
						locations: [
							{
								file: "workflows/deep-review/helpers/finding-pipeline.mjs",
								line: 96,
								lineEnd: 102,
							},
						],
						evidenceQuotes: [
							"-  const re = /(?:\\blines?\\s+~?(\\d{1,6})(?:\\s*[–-]\\s*(\\d{1,6}))?|\\bL(\\d{1,6})\\b|:(\\d{1,6})(?:[–-](\\d{1,6}))?)/gi;",
							"+  const re = /(?:\\blines?\\s+~?(\\d{1,6})(?:\\s*[–-]\\s*(\\d{1,6}))?|\\bL(\\d{1,6})\\b)/gi;",
						],
					},
					{
						severity: "low",
						title:
							"Stale capture-group reads after removing ':' evidence format",
						file: "workflows/deep-review/helpers/finding-pipeline.mjs",
						locations: [
							{
								file: "workflows/deep-review/helpers/finding-pipeline.mjs",
								line: 104,
							},
						],
						evidenceQuotes: [
							"const start = Number(match[1] ?? match[3] ?? match[4]);",
							"The finding itself concedes the leftover capture reads are dead code.",
						],
					},
					{
						severity: "medium",
						title:
							"linesFromEvidence drops :N line-reference parsing, breaking advertised location reconstruction contract",
						file: "workflows/deep-review/helpers/finding-pipeline.mjs",
						locations: [
							{
								file: "workflows/deep-review/helpers/finding-pipeline.mjs",
								line: 96,
								lineEnd: 101,
							},
						],
						evidenceQuotes: [
							"-  const re = /(?:\\blines?\\s+~?(\\d{1,6})(?:\\s*[–-]\\s*(\\d{1,6}))?|\\bL(\\d{1,6})\\b|:(\\d{1,6})(?:[–-](\\d{1,6}))?)/gi;",
							"+  const re = /(?:\\blines?\\s+~?(\\d{1,6})(?:\\s*[–-]\\s*(\\d{1,6}))?|\\bL(\\d{1,6})\\b)/gi;",
							"The prose parsing path is therefore a fallback for non-compliant reviewers, not the primary contract.",
						],
					},
				],
			},
			"devil-advocate.item-001": {
				finding: {
					title:
						"Regex/capture-group contract mismatch and loss of ':line' location extraction",
				},
				verdict: "KEEP",
			},
			"devil-advocate.item-002": {
				finding: {
					title:
						"Removing ':' line-reference extraction drops structured locations for file:line evidence",
				},
				verdict: "KEEP",
			},
			"devil-advocate.item-003": {
				finding: {
					title: "Stale capture-group reads after removing ':' evidence format",
				},
				verdict: "WEAKEN",
			},
			"devil-advocate.item-004": {
				finding: {
					title:
						"linesFromEvidence drops :N line-reference parsing, breaking advertised location reconstruction contract",
				},
				verdict: "WEAKEN",
			},
		},
		options: { mode: "partition", dedupStage: "dedup-findings" },
	});
	assert.equal(d4DuplicateRootCollapse.partitionSummary.keep, 1);
	assert.equal(d4DuplicateRootCollapse.partitionSummary.weaken, 0);
	assert.equal(d4DuplicateRootCollapse.partitionSummary.supportNotes, 1);
	assert.equal(d4DuplicateRootCollapse.partitionSummary.mergedFindings, 2);
	assert.deepEqual(
		d4DuplicateRootCollapse.reportContext.keep[0].mergedFindingIds,
		["verdict-002", "verdict-004"],
	);

	const supportOnlyDemotion = await helper({
		sources: {
			"dedup-findings.main": {
				findings: [
					{
						severity: "low",
						title:
							"Prose line-reference extraction lacks tests for remaining patterns and the removed colon branch",
						file: "test/unit/unit.test.mjs",
						evidence: "test coverage gap for file:line fallback",
					},
					{
						severity: "low",
						title:
							"normalizeLocation comment still advertises unsupported colon line references",
						file: "workflows/deep-review/helpers/finding-pipeline.mjs",
						evidence: "stale comment mentions :N references",
					},
					{
						severity: "low",
						title:
							"Dead match capture fallback remains after regex branch removal",
						file: "workflows/deep-review/helpers/finding-pipeline.mjs",
						evidence: "dead capture fallback",
					},
				],
			},
			"devil-advocate.item-001": {
				finding: {
					title:
						"Prose line-reference extraction lacks tests for remaining patterns and the removed colon branch",
				},
				verdict: "KEEP",
			},
			"devil-advocate.item-002": {
				finding: {
					title:
						"normalizeLocation comment still advertises unsupported colon line references",
				},
				verdict: "KEEP",
			},
			"devil-advocate.item-003": {
				finding: {
					title:
						"Dead match capture fallback remains after regex branch removal",
				},
				verdict: "WEAKEN",
			},
		},
		options: { mode: "partition", dedupStage: "dedup-findings" },
	});
	assert.deepEqual(supportOnlyDemotion.partitions.keep, []);
	assert.deepEqual(supportOnlyDemotion.partitions.weaken, []);
	assert.equal(supportOnlyDemotion.partitionSummary.supportNotes, 3);
	assert.equal(supportOnlyDemotion.partitionSummary.needsHuman, 1);
	assert.equal(
		supportOnlyDemotion.partitions.needsHuman[0].findingId,
		"needs-human-support-only",
	);
	assert.ok(
		supportOnlyDemotion.normalizationNotes.some((note) =>
			note.includes("support-only review produced 3 non-root finding"),
		),
	);

	const documentationNamedRoot = await helper({
		sources: {
			"dedup-findings.main": {
				findings: [
					{
						severity: "high",
						title: "Documentation endpoint leaks secret tokens",
						file: "src/docs-endpoint.ts",
						locations: [{ file: "src/docs-endpoint.ts", line: 22 }],
						evidenceQuotes: ["return { token: process.env.SECRET_TOKEN }"],
					},
				],
			},
			"devil-advocate.item-001": {
				finding: { title: "Documentation endpoint leaks secret tokens" },
				verdict: "KEEP",
			},
		},
		options: { mode: "partition", dedupStage: "dedup-findings" },
	});
	assert.deepEqual(
		documentationNamedRoot.partitions.keep.map((finding) => finding.title),
		["Documentation endpoint leaks secret tokens"],
	);
	assert.equal(documentationNamedRoot.partitionSummary.supportNotes, 0);

	const docsEvidenceRoot = await helper({
		sources: {
			"dedup-findings.main": {
				findings: [
					{
						severity: "medium",
						title: "String-form scrapling_fetch becomes a blocked custom tool",
						file: "src/compiler.ts",
						evidence:
							"Docs mention object-form migration, but the root defect is runtime string-form compatibility.",
						evidenceQuotes: ['-\t"scrapling_fetch",'],
					},
					{
						severity: "medium",
						title:
							"Missing targeted unit coverage for scrapling_fetch after removing its built-in safety classification",
						file: "test/unit/unit.test.mjs",
						evidence: "test coverage gap for scrapling_fetch",
						evidenceQuotes: ['tools: ["read", "custom_external_tool"]'],
					},
				],
			},
			"devil-advocate.item-001": {
				finding: {
					title: "String-form scrapling_fetch becomes a blocked custom tool",
				},
				verdict: "KEEP",
			},
			"devil-advocate.item-002": {
				finding: {
					title:
						"Missing targeted unit coverage for scrapling_fetch after removing its built-in safety classification",
				},
				verdict: "WEAKEN",
			},
		},
		options: { mode: "partition", dedupStage: "dedup-findings" },
	});
	assert.deepEqual(
		docsEvidenceRoot.partitions.keep.map((finding) => finding.title),
		["String-form scrapling_fetch becomes a blocked custom tool"],
	);
	assert.deepEqual(docsEvidenceRoot.partitions.weaken, []);
	assert.equal(docsEvidenceRoot.partitionSummary.supportNotes, 1);

	const rootMerge = await helper({
		sources: {
			"dedup-findings.main": {
				findings: [
					{
						severity: "medium",
						title: "maxItems equality is incorrectly treated as an overflow",
						file: "src/engine.ts",
						locations: [{ file: "src/engine.ts", line: 568 }],
						evidence:
							"if (typeof stage.maxItems === number && items.length >= stage.maxItems)",
						evidenceQuotes: ["items.length >= stage.maxItems"],
					},
					{
						severity: "medium",
						title: "foreach maxItems boundary is incorrectly rejected",
						file: "src/engine.ts",
						locations: [
							{ file: "src/engine.ts", line: 568 },
							{ file: "src/json-schema.ts", line: 277 },
						],
						evidence:
							"items.length >= stage.maxItems rejects exact maxItems boundary",
						evidenceQuotes: [
							"items.length >= stage.maxItems rejects exact maxItems boundary",
						],
					},
					{
						severity: "high",
						title: "unrelated scheduler status regression",
						file: "src/engine.ts",
						locations: [{ file: "src/engine.ts", line: 820 }],
						evidence: "blocked status is overwritten later",
						evidenceQuotes: ["blocked status is overwritten later"],
					},
				],
			},
			"devil-advocate.item-001": {
				finding: {
					title: "maxItems equality is incorrectly treated as an overflow",
				},
				verdict: "KEEP",
			},
			"devil-advocate.item-002": {
				finding: { title: "foreach maxItems boundary is incorrectly rejected" },
				verdict: "KEEP",
			},
			"devil-advocate.item-003": {
				finding: { title: "unrelated scheduler status regression" },
				verdict: "KEEP",
			},
		},
		options: { mode: "partition", dedupStage: "dedup-findings" },
	});
	assert.deepEqual(
		rootMerge.partitions.keep.map((finding) => finding.title),
		[
			"maxItems equality is incorrectly treated as an overflow",
			"unrelated scheduler status regression",
		],
	);
	assert.equal(rootMerge.partitionSummary.mergedFindings, 1);
	assert.equal(rootMerge.partitions.keep[0].mergedFindings.length, 1);
	assert.ok(
		rootMerge.partitions.keep[0].locations.some(
			(location) =>
				location.file === "src/json-schema.ts" && location.line === 277,
		),
	);
	assert.ok(
		rootMerge.normalizationNotes.some((note) =>
			note.includes("equivalent root finding"),
		),
	);

	const lifecycleRootPreservation = await helper({
		sources: {
			"dedup-findings.main": {
				findings: [
					{
						severity: "high",
						title:
							"Start no longer waits for journal recovery or reports setup failure",
						file: "core/txpool/locals/tx_tracker.go",
						locations: [
							{
								file: "core/txpool/locals/tx_tracker.go",
								line: 175,
								lineEnd: 190,
							},
						],
						evidenceQuotes: ["go tracker.loop()", "setupWriter returns error"],
					},
					{
						severity: "high",
						title:
							"TrackAll can race journal writer state before setup completes",
						file: "core/txpool/locals/tx_tracker.go",
						locations: [
							{
								file: "core/txpool/locals/tx_tracker.go",
								line: 184,
								lineEnd: 204,
							},
							{ file: "core/txpool/locals/tx_tracker.go", line: 111 },
						],
						evidenceQuotes: [
							"_ = tracker.journal.insert(tx)",
							"journal.writer = new(devNull)",
						],
					},
					{
						severity: "medium",
						title: "Stop no longer returns journal close failures",
						file: "core/txpool/locals/tx_tracker.go",
						locations: [
							{
								file: "core/txpool/locals/tx_tracker.go",
								line: 184,
								lineEnd: 190,
							},
							{
								file: "core/txpool/locals/journal.go",
								line: 197,
								lineEnd: 203,
							},
						],
						evidenceQuotes: ["return nil", "err = journal.writer.Close()"],
					},
					{
						severity: "high",
						title: "Journal setup failures are no longer reported by Start",
						file: "core/txpool/locals/tx_tracker.go",
						locations: [
							{
								file: "core/txpool/locals/tx_tracker.go",
								line: 173,
								lineEnd: 184,
							},
						],
						evidenceQuotes: ["setupWriter returns error", "return nil"],
					},
				],
			},
			"devil-advocate.item-001": {
				finding: {
					title:
						"Start no longer waits for journal recovery or reports setup failure",
				},
				verdict: "KEEP",
			},
			"devil-advocate.item-002": {
				finding: {
					title:
						"TrackAll can race journal writer state before setup completes",
				},
				verdict: "KEEP",
			},
			"devil-advocate.item-003": {
				finding: { title: "Stop no longer returns journal close failures" },
				verdict: "KEEP",
			},
			"devil-advocate.item-004": {
				finding: {
					title: "Journal setup failures are no longer reported by Start",
				},
				verdict: "KEEP",
			},
		},
		options: { mode: "partition", dedupStage: "dedup-findings" },
	});
	assert.deepEqual(
		lifecycleRootPreservation.partitions.keep.map((finding) => finding.title),
		[
			"TrackAll can race journal writer state before setup completes",
			"Stop no longer returns journal close failures",
			"Journal setup failures are no longer reported by Start",
		],
	);
	assert.equal(lifecycleRootPreservation.partitionSummary.mergedFindings, 1);
	assert.deepEqual(
		lifecycleRootPreservation.partitions.keep[2].mergedFindings.map(
			(finding) => finding.title,
		),
		["Start no longer waits for journal recovery or reports setup failure"],
	);

	const generatorLifecycleRootCollapse = await helper({
		sources: {
			"dedup-findings.main": {
				findings: [
					{
						severity: "high",
						title:
							"Completed snapshot generator goroutine can remain blocked forever",
						file: "core/state/snapshot/generate.go",
						locations: [
							{
								file: "core/state/snapshot/generate.go",
								line: 698,
								lineEnd: 702,
							},
							{
								file: "core/state/snapshot/disklayer.go",
								line: 196,
								lineEnd: 211,
							},
						],
						evidenceQuotes: [
							"abort = <-dl.genAbort",
							"func (dl *diskLayer) Release() error",
						],
					},
					{
						severity: "high",
						title:
							"genAbort remains armed after abort, allowing later callers to deadlock",
						file: "core/state/snapshot/journal.go",
						locations: [
							{
								file: "core/state/snapshot/journal.go",
								line: 203,
								lineEnd: 209,
							},
							{
								file: "core/state/snapshot/generate.go",
								line: 669,
								lineEnd: 681,
							},
						],
						evidence:
							"The snapshot generator exits after replying on genAbort, but Journal still sends to genAbort later.",
						evidenceQuotes: ["dl.genAbort <- abort", "abort <- stats"],
					},
					{
						severity: "high",
						title:
							"Release no longer stops active snapshot generation before freeing disk-layer resources",
						file: "core/state/snapshot/disklayer.go",
						locations: [
							{
								file: "core/state/snapshot/disklayer.go",
								line: 49,
								lineEnd: 54,
							},
							{
								file: "core/state/snapshot/generate.go",
								line: 675,
								lineEnd: 676,
							},
						],
						evidence:
							"Release omits stopGeneration while the snapshot generator still uses dl.diskdb.",
						evidenceQuotes: ["dl.stopGeneration()", "newGeneratorContext"],
					},
				],
			},
			"devil-advocate.item-001": {
				finding: {
					title:
						"Completed snapshot generator goroutine can remain blocked forever",
				},
				verdict: "KEEP",
			},
			"devil-advocate.item-002": {
				finding: {
					title:
						"genAbort remains armed after abort, allowing later callers to deadlock",
				},
				verdict: "KEEP",
			},
			"devil-advocate.item-003": {
				finding: {
					title:
						"Release no longer stops active snapshot generation before freeing disk-layer resources",
				},
				verdict: "KEEP",
			},
		},
		options: { mode: "partition", dedupStage: "dedup-findings" },
	});
	assert.deepEqual(
		generatorLifecycleRootCollapse.partitions.keep.map(
			(finding) => finding.title,
		),
		["Completed snapshot generator goroutine can remain blocked forever"],
	);
	assert.equal(
		generatorLifecycleRootCollapse.partitionSummary.mergedFindings,
		2,
	);

	await assert.rejects(
		helper({ sources: {}, options: { mode: "bogus" } }),
		/unknown mode/,
	);
});

test("deep-review finding-pipeline preserves structured locations through dedup and partition", async () => {
	const helperPath = join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
		"workflows",
		"deep-review",
		"helpers",
		"finding-pipeline.mjs",
	);
	const helper = (await import(pathToFileURL(helperPath).href)).default;

	const dedup = await helper({
		sources: {
			"reviewers.lens-a": {
				findings: [
					{
						severity: "high",
						title: "Path boundary bypass in isPathInsideRoot",
						file: "host/src/alpine/rootfs.ts",
						// Line numbers live only in prose evidence here; the pipeline
						// must reconstruct them into structured locations.
						evidence:
							"Gates resolveWritePath (line 46) and assertSafeWritePath (line 90).",
						evidenceQuote: "if (!isPathInsideRoot(target, root)) throw",
					},
					{
						severity: "medium",
						title: "Regex anchor dropped in matchHostname",
						file: "host/src/host/patterns.ts",
						// Explicit structured locations must pass through verbatim.
						locations: [
							{
								file: "host/src/host/patterns.ts",
								line: 15,
								symbol: "matchHostname",
							},
						],
						evidence: "diff drops the $ anchor",
						evidenceQuotes: [
							"return pattern.test(hostname)",
							"diff drops the $ anchor",
						],
					},
				],
			},
		},
		options: { mode: "dedup" },
	});

	const boundary = dedup.findings.find((f) =>
		f.title.includes("Path boundary"),
	);
	// Reconstructed from prose: two distinct line locations on the cited file.
	assert.deepEqual(boundary.locations, [
		{ file: "host/src/alpine/rootfs.ts", line: 46 },
		{ file: "host/src/alpine/rootfs.ts", line: 90 },
	]);
	assert.deepEqual(boundary.evidenceQuotes, [
		"if (!isPathInsideRoot(target, root)) throw",
		"Gates resolveWritePath (line 46) and assertSafeWritePath (line 90).",
	]);
	const regex = dedup.findings.find((f) => f.title.includes("Regex anchor"));
	// Explicit location preserved verbatim, including the symbol.
	assert.deepEqual(regex.locations, [
		{ file: "host/src/host/patterns.ts", line: 15, symbol: "matchHostname" },
	]);
	assert.deepEqual(regex.evidenceQuotes, [
		"return pattern.test(hostname)",
		"diff drops the $ anchor",
	]);

	const partition = await helper({
		sources: {
			"dedup-findings.main": dedup,
			"devil-advocate.item-001": {
				finding: { title: "Path boundary bypass in isPathInsideRoot" },
				verdict: "KEEP",
			},
			"devil-advocate.item-002": {
				finding: { title: "Regex anchor dropped in matchHostname" },
				verdict: "KEEP",
			},
		},
		options: { mode: "partition", dedupStage: "dedup-findings" },
	});
	assert.equal(partition.partitionSummary.keep, 2);
	// Identity evidence is code-preserved onto keep items, same as severity.
	const keepBoundary = partition.partitions.keep.find((k) =>
		k.title.includes("Path boundary"),
	);
	assert.equal(keepBoundary.file, "host/src/alpine/rootfs.ts");
	assert.ok(keepBoundary.locations.some((loc) => loc.line === 46));
	assert.ok(keepBoundary.locations.some((loc) => loc.line === 90));
	assert.ok(
		keepBoundary.evidenceQuotes.includes(
			"if (!isPathInsideRoot(target, root)) throw",
		),
	);
	const keepRegex = partition.partitions.keep.find((k) =>
		k.title.includes("Regex anchor"),
	);
	assert.deepEqual(keepRegex.locations, [
		{ file: "host/src/host/patterns.ts", line: 15, symbol: "matchHostname" },
	]);
	assert.deepEqual(keepRegex.evidenceQuotes, [
		"return pattern.test(hostname)",
		"diff drops the $ anchor",
	]);
	assert.equal(
		partition.partitions.keep.some((finding) => "reviewerFinding" in finding),
		false,
	);

	const schemaDir = join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
		"workflows",
		"deep-review",
		"schemas",
	);
	const dedupSchema = JSON.parse(
		readFileSync(
			join(schemaDir, "deep-review-dedup-control.schema.json"),
			"utf8",
		),
	);
	const partitionSchema = JSON.parse(
		readFileSync(
			join(schemaDir, "deep-review-partition-control.schema.json"),
			"utf8",
		),
	);
	const validDedup = validateJsonSchema(
		{ schema: "stage-control-v1", ...dedup },
		dedupSchema,
	);
	assert.equal(validDedup.valid, true, JSON.stringify(validDedup.issues));
	const validPartition = validateJsonSchema(
		{ schema: "stage-control-v1", ...partition },
		partitionSchema,
	);
	assert.equal(
		validPartition.valid,
		true,
		JSON.stringify(validPartition.issues),
	);
});

test("deep-research claim-evidence-gate enforces structured evidence, rejoins identity, and partitions statuses", async () => {
	const helperPath = join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
		"workflows",
		"deep-research",
		"helpers",
		"claim-evidence-gate.mjs",
	);
	const helper = (await import(pathToFileURL(helperPath).href)).default;
	const out = await helper({
		sources: {
			"plan.main": {
				factSlots: [{ id: "slot-001" }, { id: "slot-002" }, { id: "slot-003" }],
			},
			"normalize-claims.main": {
				claimInventory: {
					verificationCandidates: [
						{
							id: "claim-001",
							claim: "Original claim text",
							factSlotIds: ["slot-001"],
							sourceRefs: ["wsrc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
						},
						{
							id: "claim-002",
							claim: "Costs 5 usd per 1M tokens",
							factSlotIds: ["slot-002"],
							sourceUrls: ["https://example.test/pricing"],
						},
						{
							id: "claim-003",
							claim: "Local docs claim",
							factSlotIds: ["slot-001"],
							sourceRefs: ["wsrc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
						},
					],
				},
				factSlotCoverage: [{ slotId: "slot-001" }, { slotId: "slot-002" }],
			},
			"verify-claims.claim-001": {
				id: "claim-001",
				claim: "Restated by verifier",
				status: "verified",
				evidence: [{ url: "https://example.test/a", quote: "supports it" }],
			},
			"verify-claims.claim-002": {
				id: "claim-002",
				claim: "Costs 5 usd per 1M tokens",
				status: "verified",
				// URL mentioned in prose but no structured url+quote row: must downgrade.
				evidence: [{ source: "see https://example.test/blog" }],
			},
			"verify-claims.claim-003": {
				id: "claim-003",
				claim: "Local docs claim",
				status: "verified",
				evidence: [{ url: "docs/usage.md", quote: "local file evidence" }],
			},
		},
		options: {
			requireFetchedEvidenceForVerified: true,
			downgradeExactQuantitativeWithoutSource: true,
		},
	});
	assert.deepEqual(out.statusPartitions.verified, ["claim-001", "claim-003"]);
	assert.deepEqual(out.statusPartitions.partiallySupported, ["claim-002"]);
	assert.equal(out.verdictCounts.verified, 2);
	// Identity/sourceRefs rejoined from the normalizer, not the verifier echo.
	assert.equal(out.auditedClaims[0].claim, "Original claim text");
	assert.deepEqual(out.auditedClaims[0].sourceRefs, ["wsrc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
	assert.deepEqual(out.auditedClaims[2].sourceRefs, ["wsrc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]);
	assert.equal(out.gateSummary.identityRejoined, 1);
	assert.equal(out.gateSummary.sourceRefsRejoined, 2);
	assert.equal(out.gateSummary.sourceRefJoinFailures, 1);
	assert.deepEqual(out.sourceRefJoinFailures.map((gap) => gap.claimId), ["claim-002"]);
	// Planned slot dropped by the normalizer is surfaced as a gap.
	assert.deepEqual(out.slotCoverageCheck.droppedSlotIds, ["slot-003"]);
	assert.ok(out.remainingGaps.some((g) => g.slotId === "slot-003"));
	// Compact digest exists for source-context budgeting.
	assert.equal(out.claimDigests.length, 3);
	assert.deepEqual(out.claimDigests[0].sourceRefs, ["wsrc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
	assert.ok(!("evidence" in out.claimDigests[0]));
});

test("deep-research claim-evidence-gate backfills sourceRefs from normalize packet source cards", async () => {
	const helperPath = join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
		"workflows",
		"deep-research",
		"helpers",
		"claim-evidence-gate.mjs",
	);
	const helper = (await import(`${pathToFileURL(helperPath).href}?test=${Date.now()}`)).default;
	const out = await helper({
		sources: {
			"plan.main": {
				factSlots: [{ id: "slot-001" }],
			},
			"normalize-input-packet.main": {
				packet: {
					research: {
						sources: [
							{
								url: "https://Example.test/docs/source/",
								sourceRef: "wsrc_cccccccccccccccccccccccccccccccc",
							},
						],
					},
				},
			},
			"normalize-claims.main": {
				claimInventory: {
					verificationCandidates: [
						{
							id: "claim-001",
							claim: "Official docs support the source-card mapping.",
							factSlotIds: ["slot-001"],
							sourceUrls: ["https://example.test/docs/source"],
						},
					],
				},
				factSlotCoverage: [{ slotId: "slot-001" }],
			},
			"verify-claims.claim-001": {
				id: "claim-001",
				status: "verified",
				evidence: [
					{
						url: "https://example.test/docs/source,",
						quote: "Official docs support the source-card mapping.",
					},
				],
			},
		},
		options: {
			requireFetchedEvidenceForVerified: true,
			downgradeExactQuantitativeWithoutSource: true,
		},
	});

	assert.deepEqual(out.statusPartitions.verified, ["claim-001"]);
	assert.deepEqual(out.auditedClaims[0].sourceRefs, [
		"wsrc_cccccccccccccccccccccccccccccccc",
	]);
	assert.equal(out.gateSummary.sourceRefsBackfilledFromUrls, 1);
	assert.equal(out.gateSummary.sourceRefJoinFailures, 0);
	assert.deepEqual(out.sourceRefJoinFailures, []);
});

test("deep-research verifier schema allows omitted identity echoes", () => {
	const schemaPath = join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
		"workflows",
		"deep-research",
		"schemas",
		"deep-research-verify-claims-control.schema.json",
	);
	const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
	const valid = validateJsonSchema(
		{
			schema: "./schemas/deep-research-verify-claims-control.schema.json",
			digest: "verified from source-backed evidence",
			id: "claim-001",
			status: "verified",
			verdictDigest: { support: "official source supports it" },
			evidence: [
				{
					url: "https://example.test/source",
					quote: "source-backed evidence",
				},
			],
		},
		schema,
	);
	assert.equal(valid.valid, true, JSON.stringify(valid.issues));
	const invalid = validateJsonSchema(
		{
			schema: "./schemas/deep-research-verify-claims-control.schema.json",
			digest: "missing id remains invalid",
			status: "verified",
			verdictDigest: { support: "official source supports it" },
			evidence: [],
		},
		schema,
	);
	assert.equal(invalid.valid, false);
	assert.ok(invalid.issues.some((issue) => issue.path === "$.id"));
});

test("deep-research claim-evidence-gate canonicalizes candidate ids and verifier integrity", async () => {
	const helperPath = join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
		"workflows",
		"deep-research",
		"helpers",
		"claim-evidence-gate.mjs",
	);
	const helper = (await import(`${pathToFileURL(helperPath).href}?test=${Date.now()}`)).default;
	const out = await helper({
		sources: {
			"normalize-claims.main": {
				claimInventory: {
					verificationCandidates: [
						{
							id: "claim-001",
							claim: "Canonical claim one",
							factSlotIds: ["slot-001"],
							sourceRefs: ["wsrc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
						},
						{
							id: "claim-002",
							claim: "Missing verifier result",
							factSlotIds: ["slot-002"],
							sourceUrls: ["https://example.test/missing"],
						},
						{
							id: "claim-003",
							claim: "Latency improved by 42 ms",
							factSlotIds: ["slot-003"],
						},
					],
				},
				factSlotCoverage: [],
			},
			"verify-claims.claim-001.a": {
				id: "claim-001",
				claim: "Verifier restated claim one",
				status: "verified",
				evidence: [
					{
						sourceRef: "wsrc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
						quote: "Evidence supports claim one.",
					},
				],
			},
			"verify-claims.claim-001.b": {
				claimId: "claim-001",
				status: "unsupported",
				verdictDigest: { caveat: "second verifier disagreed" },
			},
			"verify-claims.claim-003": {
				id: "claim-003",
				status: "verified",
			},
			"verify-claims.bad-missing": {
				status: "verified",
			},
			"verify-claims.bad-non-string": {
				id: 123,
				status: "verified",
			},
			"verify-claims.unknown": {
				id: "claim-999",
				status: "verified",
			},
		},
		options: {
			requireFetchedEvidenceForVerified: true,
			downgradeExactQuantitativeWithoutSource: true,
		},
	});

	assert.deepEqual(out.auditedClaims.map((claim) => claim.id), [
		"claim-001",
		"claim-002",
		"claim-003",
	]);
	assert.equal(out.gateSummary.total, 3);
	assert.equal(out.gateSummary.verifierRowsTotal, 6);
	assert.equal(out.gateSummary.invalidVerifierRows, 3);
	assert.equal(out.gateSummary.missingVerifierResults, 1);
	assert.equal(out.gateSummary.duplicateVerifierRows, 1);
	assert.equal(out.gateSummary.duplicateStatusConflicts, 1);
	assert.deepEqual(out.statusPartitions.unsupported, ["claim-001"]);
	assert.deepEqual(out.statusPartitions.partiallySupported, ["claim-003"]);
	assert.deepEqual(out.statusPartitions.other, ["claim-002"]);
	assert.equal(out.auditedClaims[0].claim, "Canonical claim one");
	assert.deepEqual(out.auditedClaims[0].factSlotIds, ["slot-001"]);
	assert.equal(out.auditedClaims[1].status, "unverified");
	assert.equal(out.auditedClaims[2].status, "partially_supported");
	assert.deepEqual(out.invalidVerifierRows.map((row) => row.reason), [
		"missing_claim_id",
		"non_string_claim_id",
		"unknown_claim_id",
	]);
	assert.equal(out.duplicateVerifierRows[0].claimId, "claim-001");
	assert.equal(out.duplicateVerifierRows[0].selectedStatus, "unsupported");
	assert.ok(out.remainingGaps.some((gap) => gap.evidenceState === "missing_verifier_result"));
	assert.ok(out.remainingGaps.some((gap) => gap.evidenceState === "duplicate_verifier_rows_conflicting"));
});

test("workflow_artifact lists visible sources, reads by source name, and records a read ledger", async () => {
	const cwd = makeProject();
	try {
		const runId = "workflow_unit";
		const runDir = join(cwd, ".pi", "workflows", runId);
		const producerDir = join(runDir, "tasks", "task-1");
		const consumerDir = join(runDir, "tasks", "task-2");
		mkdirSync(producerDir, { recursive: true });
		mkdirSync(consumerDir, { recursive: true });
		writeFileSync(
			join(producerDir, "control.json"),
			'{"digest":"planned 2 items"}\n',
		);
		writeFileSync(
			join(producerDir, "analysis.md"),
			"Important upstream analysis\n",
		);
		writeFileSync(join(producerDir, "refs.json"), "[]\n");
		writeFileSync(join(producerDir, "raw.md"), "raw output\n");
		writeFileSync(join(producerDir, "prompt.md"), "hidden prompt\n");
		const manifestPath = join(consumerDir, "source-manifest.json");
		const ledgerPath = join(consumerDir, "read-ledger.jsonl");
		writeFileSync(
			manifestPath,
			JSON.stringify(
				{
					schema: "workflow-source-manifest-v1",
					runId,
					taskId: "task-2",
					sources: [
						{
							source: "plan",
							displayName: "Plan",
							taskId: "task-1",
							specId: "plan",
							stageId: "plan",
							status: "completed",
							statusDetail: "completed",
							digest: "planned 2 items",
							artifacts: {
								control: { path: join(producerDir, "control.json") },
								analysis: { path: join(producerDir, "analysis.md") },
								refs: { path: join(producerDir, "refs.json") },
								raw: { path: join(producerDir, "raw.md") },
								prompt: { path: join(producerDir, "prompt.md") },
							},
						},
						{
							source: "failed-reviewer",
							displayName: "Failed reviewer",
							taskId: "task-failed",
							specId: "reviewers.failed",
							stageId: "reviewers",
							status: "failed",
							statusDetail: "failed",
							lastMessage: "model failed",
							errorType: "model_failure",
							artifacts: {},
						},
					],
				},
				null,
				2,
			),
		);

		const manifest = await loadWorkflowSourceManifest(manifestPath, { runDir });
		const taskList = listWorkflowArtifactSources(manifest, {
			accessMode: "workflow-task",
		});
		assert.deepEqual(taskList[0].artifacts, [
			"control",
			"analysis",
			"refs",
			"raw",
		]);
		assert.equal(taskList[1].source, "failed-reviewer");
		assert.equal(taskList[1].specId, "reviewers.failed");
		assert.equal(taskList[1].stageId, "reviewers");
		assert.equal(taskList[1].status, "failed");
		assert.equal(taskList[1].statusDetail, "failed");
		assert.equal(taskList[1].lastMessage, "model failed");
		assert.equal(taskList[1].errorType, "model_failure");
		assert.deepEqual(taskList[1].artifacts, []);
		const debugList = listWorkflowArtifactSources(manifest, {
			accessMode: "human-debug",
		});
		assert.ok(debugList[0].artifacts.includes("prompt"));

		const listResult = await handleWorkflowArtifactToolCall(
			{ action: "list" },
			{ runId, taskId: "task-2", manifestPath, ledgerPath, runDir },
		);
		assert.match(listResult.content[0].text, /"source": "plan"/);
		assert.doesNotMatch(
			listResult.content[0].text,
			new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		);

		const readResult = await handleWorkflowArtifactToolCall(
			{ action: "read", source: "plan", artifact: "analysis" },
			{ runId, taskId: "task-2", manifestPath, ledgerPath, runDir },
		);
		assert.match(
			readResult.content[0].text,
			/# workflow_artifact: plan\.analysis/,
		);
		assert.match(readResult.content[0].text, /Important upstream analysis/);
		assert.doesNotMatch(
			readResult.content[0].text,
			new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		);

		const ledger = await readWorkflowArtifactReadLedger(ledgerPath);
		assert.equal(ledger.length, 1);
		assert.equal(ledger[0].runId, runId);
		assert.equal(ledger[0].taskId, "task-2");
		assert.equal(ledger[0].source, "plan");
		assert.equal(ledger[0].artifact, "analysis");
		assert.equal(ledger[0].truncated, false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifact graph source context warns that capped workflow_artifact reads need paths", () => {
	const prompt = formatArtifactGraphSourceContext(
		[
			{
				source: "plan",
				taskId: "task-1",
				specId: "plan.main",
				stageId: "plan",
				status: "completed",
				statusDetail: "completed",
				digest: "planned work",
				artifacts: { control: { path: "/tmp/control.json" } },
			},
		],
		[],
	);
	assert.match(prompt, /Projected reads must include a JSON path/);
	assert.match(prompt, /\"path\":\"\$\.factSlots\"/);
	assert.match(prompt, /For a whole artifact read, omit maxItems\/maxChars/);
});

test("workflow_artifact can read deterministic JSON projections with caps", async () => {
	const cwd = makeProject();
	try {
		const runId = "workflow_unit";
		const runDir = join(cwd, ".pi", "workflows", runId);
		const producerDir = join(runDir, "tasks", "task-1");
		const consumerDir = join(runDir, "tasks", "task-2");
		mkdirSync(producerDir, { recursive: true });
		mkdirSync(consumerDir, { recursive: true });
		writeFileSync(
			join(producerDir, "control.json"),
			JSON.stringify(
				{
					claims: [
						{ id: "claim-1", text: "first" },
						{ id: "claim-2", text: "second" },
						{ id: "claim-3", text: "third" },
					],
					sourcePolicy: { preferred: ["primary"] },
				},
				null,
				2,
			),
		);
		writeFileSync(
			join(producerDir, "refs.json"),
			JSON.stringify([{ url: "https://example.test/ref" }], null, 2),
		);
		const manifestPath = join(consumerDir, "source-manifest.json");
		const ledgerPath = join(consumerDir, "read-ledger.jsonl");
		writeFileSync(
			manifestPath,
			JSON.stringify({
				schema: "workflow-source-manifest-v1",
				runId,
				taskId: "task-2",
				sources: [
					{
						source: "normalize",
						artifacts: {
							control: { path: join(producerDir, "control.json") },
							refs: { path: join(producerDir, "refs.json") },
						},
					},
				],
			}),
		);

		const result = await handleWorkflowArtifactToolCall(
			{
				action: "read",
				source: "normalize",
				artifact: "control",
				path: "$.claims",
				maxItems: 2,
				maxChars: 200,
			},
			{ runId, taskId: "task-2", manifestPath, ledgerPath, runDir },
		);

		assert.match(
			result.content[0].text,
			/# workflow_artifact: normalize\.control path=\$\.claims/,
		);
		assert.match(result.content[0].text, /"id": "claim-1"/);
		assert.match(result.content[0].text, /"id": "claim-2"/);
		assert.doesNotMatch(result.content[0].text, /claim-3/);
		assert.equal(result.details.projection.path, "$.claims");
		assert.equal(result.details.projection.totalItems, 3);
		assert.equal(result.details.projection.itemsReturned, 2);
		assert.equal(result.details.projection.itemsTruncated, true);
		assert.equal(result.details.truncated, true);

		const ledger = await readWorkflowArtifactReadLedger(ledgerPath);
		assert.equal(ledger.length, 1);
		assert.equal(ledger[0].source, "normalize");
		assert.equal(ledger[0].artifact, "control");
		assert.equal(ledger[0].path, "$.claims");
		assert.equal(ledger[0].maxItems, 2);
		assert.equal(ledger[0].maxChars, 200);

		const sourcePrefixed = await handleWorkflowArtifactToolCall(
			{
				action: "read",
				source: "normalize",
				artifact: "control",
				path: "$.normalize.claims[0]",
				maxItems: 1,
			},
			{ runId, taskId: "task-2", manifestPath, ledgerPath, runDir },
		);
		assert.match(
			sourcePrefixed.content[0].text,
			/# workflow_artifact: normalize\.control path=\$\.claims/,
		);
		assert.match(sourcePrefixed.content[0].text, /"id": "claim-1"/);

		const artifactPrefixed = await handleWorkflowArtifactToolCall(
			{
				action: "read",
				source: "normalize",
				artifact: "control",
				path: "$.control.claims",
				maxItems: 1,
			},
			{ runId, taskId: "task-2", manifestPath, ledgerPath, runDir },
		);
		assert.match(
			artifactPrefixed.content[0].text,
			/# workflow_artifact: normalize\.control path=\$\.claims/,
		);

		const rootAlias = await handleWorkflowArtifactToolCall(
			{
				action: "read",
				source: "normalize",
				artifact: "refs",
				path: "$.refs",
				maxChars: 200,
			},
			{ runId, taskId: "task-2", manifestPath, ledgerPath, runDir },
		);
		assert.match(
			rootAlias.content[0].text,
			/# workflow_artifact: normalize\.refs path=\$/,
		);

		const fieldAlias = await handleWorkflowArtifactToolCall(
			{
				action: "read",
				source: "normalize",
				artifact: "control",
				path: "$.sourceRequirements",
				maxChars: 200,
			},
			{ runId, taskId: "task-2", manifestPath, ledgerPath, runDir },
		);
		assert.match(
			fieldAlias.content[0].text,
			/# workflow_artifact: normalize\.control path=\$\.sourcePolicy/,
		);
		assert.match(fieldAlias.content[0].text, /"primary"/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("workflow_artifact rejects path injection, unknown artifacts, and debug reads in workflow-task mode", async () => {
	const cwd = makeProject();
	try {
		const runId = "workflow_unit";
		const runDir = join(cwd, ".pi", "workflows", runId);
		const producerDir = join(runDir, "tasks", "task-1");
		const consumerDir = join(runDir, "tasks", "task-2");
		mkdirSync(producerDir, { recursive: true });
		mkdirSync(consumerDir, { recursive: true });
		writeFileSync(join(producerDir, "analysis.md"), "analysis\n");
		writeFileSync(join(producerDir, "prompt.md"), "prompt\n");
		const manifestPath = join(consumerDir, "source-manifest.json");
		const ledgerPath = join(consumerDir, "read-ledger.jsonl");
		writeFileSync(
			manifestPath,
			JSON.stringify({
				schema: "workflow-source-manifest-v1",
				runId,
				taskId: "task-2",
				sources: [
					{
						source: "plan",
						artifacts: {
							analysis: { path: join(producerDir, "analysis.md") },
							prompt: { path: join(producerDir, "prompt.md") },
						},
					},
				],
			}),
		);

		await assert.rejects(
			handleWorkflowArtifactToolCall(
				{ action: "read", source: "../plan", artifact: "analysis" },
				{ runId, taskId: "task-2", manifestPath, ledgerPath, runDir },
			),
			/canonical workflow artifact source name/,
		);
		await assert.rejects(
			handleWorkflowArtifactToolCall(
				{ action: "read", source: "missing", artifact: "analysis" },
				{ runId, taskId: "task-2", manifestPath, ledgerPath, runDir },
			),
			/unknown workflow artifact source/,
		);
		await assert.rejects(
			handleWorkflowArtifactToolCall(
				{ action: "read", source: "plan", artifact: "prompt" },
				{ runId, taskId: "task-2", manifestPath, ledgerPath, runDir },
			),
			/not available in workflow-task access mode/,
		);
		await assert.rejects(
			handleWorkflowArtifactToolCall(
				{ action: "read", source: "plan", artifact: "bogus" },
				{ runId, taskId: "task-2", manifestPath, ledgerPath, runDir },
			),
			/must be one of/,
		);

		writeFileSync(
			manifestPath,
			JSON.stringify({
				schema: "workflow-source-manifest-v1",
				runId,
				taskId: "task-2",
				sources: [
					{
						source: "evil",
						artifacts: { analysis: { path: join(cwd, "outside.md") } },
					},
				],
			}),
		);
		await assert.rejects(
			loadWorkflowSourceManifest(manifestPath, { runDir }),
			/inside the workflow run directory/,
		);

		writeFileSync(join(cwd, "outside-secret.md"), "secret\n");
		symlinkSync(join(cwd, "outside-secret.md"), join(producerDir, "link.md"));
		writeFileSync(
			manifestPath,
			JSON.stringify({
				schema: "workflow-source-manifest-v1",
				runId,
				taskId: "task-2",
				sources: [
					{
						source: "linked",
						artifacts: { analysis: { path: join(producerDir, "link.md") } },
					},
				],
			}),
		);
		await assert.rejects(
			handleWorkflowArtifactToolCall(
				{ action: "read", source: "linked", artifact: "analysis" },
				{ runId, taskId: "task-2", manifestPath, ledgerPath, runDir },
			),
			/must not be a symlink/,
		);

		const largePath = join(producerDir, "large.md");
		writeFileSync(largePath, "x".repeat(10_000));
		writeFileSync(
			manifestPath,
			JSON.stringify({
				schema: "workflow-source-manifest-v1",
				runId,
				taskId: "task-2",
				sources: [
					{
						source: "large",
						artifacts: { analysis: { path: largePath } },
					},
				],
			}),
		);
		const large = await handleWorkflowArtifactToolCall(
			{ action: "read", source: "large", artifact: "analysis" },
			{
				runId,
				taskId: "task-2",
				manifestPath,
				ledgerPath,
				runDir,
				maxBytes: 32,
			},
		);
		assert.equal(large.details.bytes, 10_000);
		assert.equal(large.details.returnedBytes, 32);
		assert.equal(large.details.truncated, true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("workflow_artifact extension registers and activates the tool", async () => {
	const cwd = makeProject();
	try {
		const runId = "workflow_unit";
		const runDir = join(cwd, ".pi", "workflows", runId);
		const producerDir = join(runDir, "tasks", "task-1");
		const consumerDir = join(runDir, "tasks", "task-2");
		mkdirSync(producerDir, { recursive: true });
		mkdirSync(consumerDir, { recursive: true });
		writeFileSync(
			join(producerDir, "analysis.md"),
			"extension-visible analysis\n",
		);
		const manifestPath = join(consumerDir, "source-manifest.json");
		const ledgerPath = join(consumerDir, "read-ledger.jsonl");
		writeFileSync(
			manifestPath,
			JSON.stringify({
				schema: "workflow-source-manifest-v1",
				runId,
				taskId: "task-2",
				sources: [
					{
						source: "plan",
						artifacts: {
							analysis: { path: join(producerDir, "analysis.md") },
						},
					},
				],
			}),
		);

		const registeredTools = [];
		const handlers = new Map();
		let activeTools = ["read"];
		const fakePi = {
			registerTool(tool) {
				registeredTools.push(tool);
			},
			on(event, handler) {
				handlers.set(event, handler);
			},
			getActiveTools() {
				return activeTools;
			},
			setActiveTools(tools) {
				activeTools = tools;
			},
		};

		registerWorkflowArtifactTool(fakePi, {
			runId,
			taskId: "task-2",
			manifestPath,
			ledgerPath,
			runDir,
		});
		assert.equal(registeredTools.length, 1);
		assert.equal(registeredTools[0].name, "workflow_artifact");
		handlers.get("session_start")?.({}, {});
		assert.deepEqual(
			new Set(activeTools),
			new Set(["read", "workflow_artifact"]),
		);

		const result = await registeredTools[0].execute("tool-call-1", {
			action: "read",
			source: "plan",
			artifact: "analysis",
		});
		assert.match(result.content[0].text, /extension-visible analysis/);
		const ledger = await readWorkflowArtifactReadLedger(ledgerPath);
		assert.equal(ledger.length, 1);
		assert.equal(ledger[0].source, "plan");
		assert.equal(ledger[0].artifact, "analysis");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifact graph workflow runs workflow artifacts and enforces required reads", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		mkdirSync(join(cwd, "workflows"), { recursive: true });
		writeFileSync(
			join(cwd, "workflows", "artifact.json"),
			JSON.stringify(
				artifactGraphWorkflowSpec({
					name: "artifact",
					artifactGraph: {
						stages: [
							{
								id: "analyze",
								type: "single",
								prompt: "Analyze.",
								output: {
									analysis: { required: true },
									refs: { required: true },
								},
							},
							{
								id: "final",
								type: "reduce",
								from: ["analyze"],
								sourceProjection: {
									include: ["$.digest", "$.items"],
									maxChars: 200,
								},
								inputPolicy: {
									requiredReads: ["analyze.analysis"],
									enforcement: "fail",
								},
								prompt: "Finalize.",
							},
						],
					},
				}),
			),
		);

		let launchCount = 0;
		const runs = new Map();
		setSubagentApiForTests({
			async runSubagent(options) {
				launchCount += 1;
				const runId = `run_artifact_${launchCount}`;
				const attemptId = `attempt_artifact_${launchCount}`;
				const artifactDir = join(
					cwd,
					String(options.runsDir),
					runId,
					"attempts",
					attemptId,
				);
				mkdirSync(artifactDir, { recursive: true });
				const isFinal = launchCount === 2;
				if (isFinal) {
					const [workflowRunId, taskId] = String(options.correlationId).split(
						":",
					);
					const taskDir = join(
						cwd,
						".pi",
						"workflows",
						workflowRunId,
						"tasks",
						taskId,
					);
					const ledgerPath = join(taskDir, "read-ledger.jsonl");
					assert.match(
						String(options.task),
						/Required reads before final output/,
					);
					assert.match(
						String(options.task),
						/# Required Workflow Artifact Reads/,
					);
					assert.doesNotMatch(
						String(options.task),
						/# Required Workflow Artifact Read Contents/,
					);
					assert.doesNotMatch(String(options.task), /Detailed analysis\./);
					writeFileSync(
						ledgerPath,
						`${JSON.stringify({
							schema: "workflow-artifact-read-v1",
							runId: workflowRunId,
							taskId,
							source: "analyze",
							artifact: "analysis",
							at: new Date().toISOString(),
							bytes: 18,
							returnedBytes: 18,
							truncated: false,
						})}\n`,
					);
				}
				const control = isFinal
					? { schema: "stage-control-v1", digest: "final done", verdict: "ok" }
					: {
							schema: "stage-control-v1",
							digest: "analysis done",
							items: [{ id: "a" }],
						};
				const output = [
					"<control>",
					JSON.stringify(control),
					"</control>",
					"<analysis>",
					isFinal
						? "Final analysis after required read."
						: "Detailed analysis.",
					"</analysis>",
					"<refs>",
					"[]",
					"</refs>",
				].join("\n");
				writeFileSync(join(artifactDir, "output.log"), output);
				writeFileSync(join(artifactDir, "stderr.log"), "");
				writeFileSync(
					join(artifactDir, "result.json"),
					JSON.stringify({
						status: "completed",
						completedAt: new Date().toISOString(),
						startedAt: new Date().toISOString(),
						exitCode: 0,
					}),
				);
				runs.set(runId, { runId, attemptId, artifactDir });
				return { runId, attemptId, status: "running" };
			},
			async reconcileSubagentRun() {
				return {};
			},
			async getSubagentStatus({ runId }) {
				const run = runs.get(runId);
				return {
					runId,
					attemptId: run.attemptId,
					backend: "headless",
					status: "completed",
					failureKind: null,
					startedAt: new Date().toISOString(),
					completedAt: new Date().toISOString(),
					logs: [
						{
							type: "output",
							path: "output.log",
							artifactCwd: run.artifactDir,
						},
						{
							type: "stderr",
							path: "stderr.log",
							artifactCwd: run.artifactDir,
						},
						{
							type: "result",
							path: "result.json",
							artifactCwd: run.artifactDir,
						},
					],
					metadata: { contextLengthExceeded: false },
					attempts: [
						{ attemptId: run.attemptId, status: "completed", pid: 12345 },
					],
				};
			},
			async interruptSubagent() {
				return {};
			},
		});

		const started = await runWorkflow("artifact", cwd, {
			task: "Run artifact graph",
		});
		const completed = await waitForRun(cwd, started.runId, 5_000);
		assert.equal(completed.status, "completed");
		assert.equal(launchCount, 2);
		const finalTask = taskBySpec(completed, "final.main");
		assert.equal(finalTask.status, "completed");
		const finalDir = dirname(join(cwd, finalTask.files.result));
		assert.equal(
			JSON.parse(readFileSync(join(finalDir, "control.json"), "utf8")).digest,
			"final done",
		);
		assert.match(
			readFileSync(join(finalDir, "analysis.md"), "utf8"),
			/Final analysis/,
		);
		const finalTaskPrompt = readFileSync(join(finalDir, "task.md"), "utf8");
		assert.ok(finalTaskPrompt.includes("Required reads before final output"));
		assert.ok(finalTaskPrompt.includes("# Required Workflow Artifact Reads"));
		assert.ok(finalTaskPrompt.includes("- analyze.analysis:"));
		assert.doesNotMatch(finalTaskPrompt, /Detailed analysis\./);
		const finalManifest = JSON.parse(
			readFileSync(join(finalDir, "source-manifest.json"), "utf8"),
		);
		assert.deepEqual(finalManifest.sources[0].controlProjection, {
			digest: "analysis done",
			items: [{ id: "a" }],
		});
		assert.match(
			readFileSync(join(finalDir, "task.md"), "utf8"),
			/controlProjection/,
		);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifact graph output retry reuses confirmed subagent session", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		mkdirSync(join(cwd, "workflows"), { recursive: true });
		writeFileSync(
			join(cwd, "workflows", "session-retry.json"),
			JSON.stringify(
				workflowSpec("unit-scout", {
					artifactGraph: {
						stages: [{ id: "main", type: "single", prompt: "Analyze." }],
					},
				}),
			),
		);

		const launched = [];
		const runs = new Map();
		setSubagentApiForTests({
			async runSubagent(options) {
				launched.push(options);
				const runId = `run_session_${launched.length}`;
				const attemptId = `attempt_session_${launched.length}`;
				const artifactDir = join(
					cwd,
					String(options.runsDir),
					runId,
					"attempts",
					attemptId,
				);
				mkdirSync(artifactDir, { recursive: true });
				const output =
					launched.length === 1
						? "not workflow output"
						: [
								"<control>",
								JSON.stringify({ schema: "stage-control-v1", digest: "ok" }),
								"</control>",
								"<analysis>",
								"retry succeeded",
								"</analysis>",
								"<refs>",
								"[]",
								"</refs>",
							].join("\n");
				writeFileSync(join(artifactDir, "output.log"), output);
				writeFileSync(join(artifactDir, "stderr.log"), "");
				writeFileSync(
					join(artifactDir, "result.json"),
					JSON.stringify({
						status: "completed",
						completedAt: new Date().toISOString(),
						startedAt: new Date().toISOString(),
						exitCode: 0,
						metadata: {
							contextLengthExceeded: false,
							sessionId: options.sessionId,
							session: {
								id: options.sessionId,
								requested: true,
								disposition: "resumed",
							},
						},
					}),
				);
				runs.set(runId, { runId, attemptId, artifactDir });
				return { runId, attemptId, status: "running" };
			},
			async reconcileSubagentRun() {
				return {};
			},
			async getSubagentStatus({ runId }) {
				const run = runs.get(runId);
				return {
					runId,
					attemptId: run.attemptId,
					backend: "headless",
					status: "completed",
					failureKind: null,
					startedAt: new Date().toISOString(),
					completedAt: new Date().toISOString(),
					logs: [
						{
							type: "output",
							path: "output.log",
							artifactCwd: run.artifactDir,
						},
						{
							type: "stderr",
							path: "stderr.log",
							artifactCwd: run.artifactDir,
						},
						{
							type: "result",
							path: "result.json",
							artifactCwd: run.artifactDir,
						},
					],
					metadata: { contextLengthExceeded: false },
					attempts: [
						{ attemptId: run.attemptId, status: "completed", pid: 12345 },
					],
				};
			},
			async interruptSubagent() {
				return {};
			},
		});

		const started = await runWorkflow("session-retry", cwd, {
			task: "Run artifact graph",
		});
		const completed = await waitForRun(cwd, started.runId, 5_000);
		assert.equal(completed.status, "completed");
		assert.equal(launched.length, 2);
		const expectedSessionId = `pi-workflow.${started.runId}.task-1`;
		assert.equal(launched[0].sessionId, expectedSessionId);
		assert.equal(launched[1].sessionId, expectedSessionId);
		const task = taskBySpec(completed, "main.main");
		assert.equal(task.outputRetry.maxAttempts, 2);
		assert.equal(task.outputRetry.repairMode, "same_session");
		assert.equal(task.outputRetry.sessionId, expectedSessionId);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifact graph output retry starts new session when subagent session is unconfirmed", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		mkdirSync(join(cwd, "workflows"), { recursive: true });
		writeFileSync(
			join(cwd, "workflows", "session-fallback.json"),
			JSON.stringify(
				workflowSpec("unit-scout", {
					artifactGraph: {
						stages: [{ id: "main", type: "single", prompt: "Analyze." }],
					},
				}),
			),
		);

		const launched = [];
		const runs = new Map();
		setSubagentApiForTests({
			async runSubagent(options) {
				launched.push(options);
				const runId = `run_fallback_${launched.length}`;
				const attemptId = `attempt_fallback_${launched.length}`;
				const artifactDir = join(
					cwd,
					String(options.runsDir),
					runId,
					"attempts",
					attemptId,
				);
				mkdirSync(artifactDir, { recursive: true });
				const output =
					launched.length === 1
						? "not workflow output"
						: [
								"<control>",
								JSON.stringify({ schema: "stage-control-v1", digest: "ok" }),
								"</control>",
								"<analysis>",
								"fallback retry succeeded",
								"</analysis>",
								"<refs>",
								"[]",
								"</refs>",
							].join("\n");
				writeFileSync(join(artifactDir, "output.log"), output);
				writeFileSync(join(artifactDir, "stderr.log"), "");
				writeFileSync(
					join(artifactDir, "result.json"),
					JSON.stringify({
						status: "completed",
						completedAt: new Date().toISOString(),
						startedAt: new Date().toISOString(),
						exitCode: 0,
						metadata: {
							contextLengthExceeded: false,
							sessionId: options.sessionId,
							session: {
								id: options.sessionId,
								requested: true,
								disposition: launched.length === 1 ? "created" : "resumed",
							},
						},
					}),
				);
				runs.set(runId, { runId, attemptId, artifactDir });
				return { runId, attemptId, status: "running" };
			},
			async reconcileSubagentRun() {
				return {};
			},
			async getSubagentStatus({ runId }) {
				const run = runs.get(runId);
				return {
					runId,
					attemptId: run.attemptId,
					backend: "headless",
					status: "completed",
					failureKind: null,
					startedAt: new Date().toISOString(),
					completedAt: new Date().toISOString(),
					logs: [
						{
							type: "output",
							path: "output.log",
							artifactCwd: run.artifactDir,
						},
						{
							type: "stderr",
							path: "stderr.log",
							artifactCwd: run.artifactDir,
						},
						{
							type: "result",
							path: "result.json",
							artifactCwd: run.artifactDir,
						},
					],
					metadata: { contextLengthExceeded: false },
					attempts: [
						{ attemptId: run.attemptId, status: "completed", pid: 12345 },
					],
				};
			},
			async interruptSubagent() {
				return {};
			},
		});

		const started = await runWorkflow("session-fallback", cwd, {
			task: "Run artifact graph",
		});
		const completed = await waitForRun(cwd, started.runId, 5_000);
		assert.equal(completed.status, "completed");
		assert.equal(launched.length, 2);
		const baseSessionId = `pi-workflow.${started.runId}.task-1`;
		const retrySessionId = `${baseSessionId}.retry-1`;
		assert.equal(launched[0].sessionId, baseSessionId);
		assert.equal(launched[1].sessionId, retrySessionId);
		const task = taskBySpec(completed, "main.main");
		assert.equal(task.outputRetry.maxAttempts, 2);
		assert.equal(task.outputRetry.repairMode, "new_session");
		assert.equal(task.outputRetry.sessionId, retrySessionId);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("recovered artifact graph subagent handle preserves same-session retry", async () => {
	const cwd = makeProject();
	try {
		const now = new Date().toISOString();
		const expectedSessionId = "pi-workflow.workflow_recovery.task-1";
		const artifactDir = join(
			cwd,
			".pi",
			"workflow-subagents",
			"workflow_recovery",
			"task-1",
			"run_recovered",
			"attempts",
			"attempt_recovered",
		);
		mkdirSync(artifactDir, { recursive: true });
		writeFileSync(join(artifactDir, "output.log"), "not workflow output");
		writeFileSync(join(artifactDir, "stderr.log"), "");
		writeFileSync(
			join(artifactDir, "result.json"),
			JSON.stringify({
				status: "completed",
				completedAt: now,
				startedAt: now,
				exitCode: 0,
				metadata: {
					contextLengthExceeded: false,
					sessionId: expectedSessionId,
					session: {
						id: expectedSessionId,
						requested: true,
						disposition: "resumed",
					},
				},
			}),
		);
		writeFileSync(
			join(
				cwd,
				".pi",
				"workflow-subagents",
				"workflow_recovery",
				"task-1",
				"run_recovered",
				"run.json",
			),
			JSON.stringify({
				schemaVersion: 2,
				runId: "run_recovered",
				correlationId: "workflow_recovery:task-1",
				status: "completed",
				failureKind: null,
				startedAt: now,
				updatedAt: now,
				completedAt: now,
				activeAttemptId: "attempt_recovered",
				latestAttemptId: "attempt_recovered",
				attempts: [
					{
						attemptId: "attempt_recovered",
						status: "completed",
						failureKind: null,
						startedAt: now,
						updatedAt: now,
						completedAt: now,
					},
				],
			}),
		);

		let relaunched;
		setSubagentApiForTests({
			async runSubagent(options) {
				relaunched = options;
				return {
					runId: "run_relaunched",
					attemptId: "attempt_relaunched",
					status: "running",
				};
			},
			async reconcileSubagentRun() {
				return {};
			},
			async getSubagentStatus() {
				return {
					runId: "run_recovered",
					attemptId: "attempt_recovered",
					backend: "headless",
					status: "completed",
					failureKind: null,
					startedAt: now,
					completedAt: now,
					logs: [
						{ type: "output", path: "output.log", artifactCwd: artifactDir },
						{ type: "stderr", path: "stderr.log", artifactCwd: artifactDir },
						{ type: "result", path: "result.json", artifactCwd: artifactDir },
					],
					metadata: { contextLengthExceeded: false },
					attempts: [
						{ attemptId: "attempt_recovered", status: "completed", pid: 12345 },
					],
				};
			},
			async interruptSubagent() {
				return {};
			},
		});

		const artifactGraph = {
			enabled: true,
			output: { analysisRequired: true, refsRequired: true },
			requiredReads: [],
		};
		const task = {
			taskId: "task-1",
			specId: "main.main",
			displayName: "main.main",
			agent: "unit-scout",
			agentFile: ".pi/agents/unit-scout.md",
			roles: [],
			status: "running",
			statusDetail: "running",
			runtime: { approvalMode: "non-interactive" },
			cwd,
			worktree: {
				enabled: false,
				path: null,
				branch: null,
				baseCwd: null,
				warning: null,
			},
			backendTaskId: "run_recovered",
			artifactGraph,
			files: {
				systemPrompt: ".pi/workflows/workflow_recovery/tasks/task-1/system.md",
				taskPrompt: ".pi/workflows/workflow_recovery/tasks/task-1/task.md",
				output: ".pi/workflows/workflow_recovery/tasks/task-1/output.log",
				stderr: ".pi/workflows/workflow_recovery/tasks/task-1/stderr.log",
				result: ".pi/workflows/workflow_recovery/tasks/task-1/result.json",
			},
		};
		const run = {
			schemaVersion: 1,
			runId: "workflow_recovery",
			type: WORKFLOW_RUN_TYPE,
			artifactGraph: { enabled: true },
			status: "running",
			taskSummary: {
				pending: 0,
				running: 1,
				blocked: 0,
				completed: 0,
				failed: 0,
				skipped: 0,
				interrupted: 0,
				total: 1,
			},
			cwd,
			backend: { type: "local-pi", mode: "headless" },
			createdAt: now,
			updatedAt: now,
			specPath: "workflow.json",
			tasks: [task],
		};

		const refreshed = await refreshRunFromSubagentArtifacts(cwd, run);
		assert.equal(refreshed.tasks[0].status, "pending");
		assert.equal(refreshed.tasks[0].outputRetry.repairMode, "same_session");
		assert.equal(refreshed.tasks[0].outputRetry.sessionId, expectedSessionId);

		const compiledTask = {
			id: "main.main",
			agent: "unit-scout",
			agentPath: ".pi/agents/unit-scout.md",
			agentSystemPrompt: "Artifact agent.",
			roleNames: [],
			task: "Do the work.",
			cwd,
			explicitCwd: false,
			explicitWorktreePolicy: false,
			runtime: {
				fast: "off",
				approvalMode: "non-interactive",
				tools: ["read"],
			},
			safety: { capability: "read-only", reason: "test" },
			compiledPrompt: "Artifact prompt.",
			artifactGraph,
		};
		await launchSubagentTask(cwd, refreshed, refreshed.tasks[0], compiledTask);
		assert.equal(relaunched.sessionId, expectedSessionId);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("non artifact graph subagent launches do not request child sessions", async () => {
	const cwd = makeProject();
	try {
		let captured;
		setSubagentApiForTests({
			async runSubagent(options) {
				captured = options;
				return {
					runId: "run_plain",
					attemptId: "attempt_plain",
					status: "running",
				};
			},
		});
		const now = new Date().toISOString();
		const task = {
			taskId: "task-1",
			specId: "plain.main",
			displayName: "plain.main",
			agent: "unit-scout",
			agentFile: ".pi/agents/unit-scout.md",
			roles: [],
			status: "pending",
			statusDetail: "pending",
			runtime: { approvalMode: "non-interactive" },
			cwd,
			worktree: {
				enabled: false,
				path: null,
				branch: null,
				baseCwd: null,
				warning: null,
			},
			backendTaskId: "",
			files: {
				systemPrompt: ".pi/workflows/workflow_plain/tasks/task-1/system.md",
				taskPrompt: ".pi/workflows/workflow_plain/tasks/task-1/task.md",
				output: ".pi/workflows/workflow_plain/tasks/task-1/output.log",
				stderr: ".pi/workflows/workflow_plain/tasks/task-1/stderr.log",
				result: ".pi/workflows/workflow_plain/tasks/task-1/result.json",
			},
		};
		const run = {
			schemaVersion: 1,
			runId: "workflow_plain",
			type: WORKFLOW_RUN_TYPE,
			status: "running",
			taskSummary: {
				pending: 1,
				running: 0,
				blocked: 0,
				completed: 0,
				failed: 0,
				skipped: 0,
				interrupted: 0,
				total: 1,
			},
			cwd,
			backend: { type: "local-pi", mode: "headless" },
			createdAt: now,
			updatedAt: now,
			specPath: "workflow.json",
			tasks: [task],
		};
		const compiledTask = {
			id: "plain.main",
			agent: "unit-scout",
			agentPath: ".pi/agents/unit-scout.md",
			agentSystemPrompt: "Plain agent.",
			roleNames: [],
			task: "Do the work.",
			cwd,
			explicitCwd: false,
			explicitWorktreePolicy: false,
			runtime: {
				fast: "off",
				approvalMode: "non-interactive",
				tools: ["read"],
			},
			safety: { capability: "read-only", reason: "test" },
			compiledPrompt: "Plain prompt.",
		};
		await launchSubagentTask(cwd, run, task, compiledTask);
		assert.equal(captured.sessionId, undefined);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("workflow_artifact generated extension wrapper embeds config without prompt-visible paths", async () => {
	const cwd = makeProject();
	try {
		const wrapperPath = join(
			cwd,
			".pi",
			"workflows",
			"workflow_unit",
			"tasks",
			"task-2",
			"workflow-artifact-extension.ts",
		);
		const config = {
			runId: "workflow_unit",
			taskId: "task-2",
			manifestPath: join(
				cwd,
				".pi",
				"workflows",
				"workflow_unit",
				"tasks",
				"task-2",
				"source-manifest.json",
			),
			ledgerPath: join(
				cwd,
				".pi",
				"workflows",
				"workflow_unit",
				"tasks",
				"task-2",
				"read-ledger.jsonl",
			),
			accessMode: "workflow-task",
		};
		const importPath = join(cwd, "src", "workflow-artifact-extension.ts");
		const content = buildWorkflowArtifactExtensionWrapper({
			importPath,
			config,
		});
		assert.match(content, /registerWorkflowArtifactTool/);
		assert.match(content, /file:\/\//);
		assert.match(content, /"runId": "workflow_unit"/);
		assert.match(content, /"accessMode": "workflow-task"/);
		await writeWorkflowArtifactExtensionWrapper({
			wrapperPath,
			importPath,
			config,
		});
		assert.equal(readFileSync(wrapperPath, "utf8"), content);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("workflow output parser accepts canonical control analysis refs sections", () => {
	const raw = [
		"<control>",
		JSON.stringify({
			schema: "stage-control-v1",
			digest: "ready",
			findings: [{ id: "f-1" }],
		}),
		"</control>",
		"<analysis>",
		"# Analysis\n\nDetailed reasoning. Literal <control> text is okay here.",
		"</analysis>",
		"<refs>",
		JSON.stringify([{ kind: "file", path: "src/compiler.ts" }]),
		"</refs>",
	].join("\n");
	const parsed = parseWorkflowOutput(raw, {
		controlContract: { requiredPaths: ["$.findings"] },
	});
	assert.equal(parsed.valid, true, JSON.stringify(parsed.issues));
	assert.equal(parsed.control.digest, "ready");
	assert.match(parsed.analysis, /Detailed reasoning/);
	assert.deepEqual(parsed.refs, [{ kind: "file", path: "src/compiler.ts" }]);
});

test("workflow output parser can require non-empty refs", () => {
	const raw = [
		"<control>",
		JSON.stringify({ schema: "stage-control-v1", digest: "ready" }),
		"</control>",
		"<analysis>",
		"Detailed reasoning with a cited claim.",
		"</analysis>",
		"<refs>",
		"[]",
		"</refs>",
	].join("\n");

	const defaultParsed = parseWorkflowOutput(raw);
	assert.equal(defaultParsed.valid, true, JSON.stringify(defaultParsed.issues));

	const strictParsed = parseWorkflowOutput(raw, { refsMinItems: 1 });
	assert.equal(strictParsed.valid, false);
	assert.ok(
		strictParsed.issues.some(
			(issue) => issue.code === "too_few_items" && issue.section === "refs",
		),
		JSON.stringify(strictParsed.issues),
	);
	assert.match(
		buildWorkflowOutputRetryInstructions(strictParsed.issues),
		/refs must include at least one item/,
	);
});

test("workflow output parser rejects empty strict ref locators", () => {
	const raw = [
		"<control>",
		JSON.stringify({ schema: "stage-control-v1", digest: "ready" }),
		"</control>",
		"<analysis>",
		"Detailed reasoning with a cited claim.",
		"</analysis>",
		"<refs>",
		JSON.stringify([
			"",
			{ title: "missing locator" },
			{ url: "https://example.com" },
		]),
		"</refs>",
	].join("\n");

	const defaultParsed = parseWorkflowOutput(raw);
	assert.equal(defaultParsed.valid, true, JSON.stringify(defaultParsed.issues));

	const strictParsed = parseWorkflowOutput(raw, { refsMinItems: 1 });
	assert.equal(strictParsed.valid, false);
	const locatorIssues = strictParsed.issues.filter(
		(issue) => issue.code === "invalid_ref_locator" && issue.section === "refs",
	);
	assert.equal(locatorIssues.length, 2, JSON.stringify(strictParsed.issues));
	assert.match(
		buildWorkflowOutputRetryInstructions(strictParsed.issues),
		/non-empty locator string/,
	);
});

test("workflow artifact bundle can validate strict ref URL availability", async () => {
	const taskDir = mkdtempSync(join(tmpdir(), "workflow-ref-url-validation-"));
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () => ({
			ok: false,
			status: 404,
			url: "https://example.test/missing",
			arrayBuffer: async () => new ArrayBuffer(0),
		});
		const raw = [
			"<control>",
			JSON.stringify({ schema: "stage-control-v1", digest: "ready" }),
			"</control>",
			"<analysis>",
			"Detailed reasoning with a cited claim.",
			"</analysis>",
			"<refs>",
			JSON.stringify([{ url: "https://example.test/missing" }]),
			"</refs>",
		].join("\n");

		const written = await writeWorkflowTaskArtifactBundle({
			taskDir,
			rawOutput: raw,
			refsMinItems: 1,
			refsUrlValidation: { timeoutMs: 100, maxUrls: 5 },
		});

		assert.equal(written.valid, false);
		assert.ok(
			written.parsed.issues.some(
				(issue) =>
					issue.code === "unavailable_ref_locator" &&
					issue.path === "refs[0]" &&
					/HTTP 404/.test(issue.message),
			),
			JSON.stringify(written.parsed.issues),
		);
	} finally {
		globalThis.fetch = originalFetch;
		rmSync(taskDir, { recursive: true, force: true });
	}
});

test("workflow artifact bundle can restrict refs to an upstream source ledger", async () => {
	const taskDir = mkdtempSync(join(tmpdir(), "workflow-ref-ledger-"));
	try {
		const raw = [
			"<control>",
			JSON.stringify({ schema: "stage-control-v1", digest: "ready" }),
			"</control>",
			"<analysis>",
			"Detailed reasoning with one upstream and one invented source.",
			"</analysis>",
			"<refs>",
			JSON.stringify([
				{ url: "https://example.test/allowed" },
				{ url: "https://example.test/invented" },
			]),
			"</refs>",
		].join("\n");

		const written = await writeWorkflowTaskArtifactBundle({
			taskDir,
			rawOutput: raw,
			refsAllowedLocators: ["https://example.test/allowed"],
		});

		assert.equal(written.valid, false);
		assert.ok(
			written.parsed.issues.some(
				(issue) =>
					issue.code === "unavailable_ref_locator" &&
					issue.path === "refs[1]" &&
					/not in the verified upstream source ledger/.test(issue.message),
			),
			JSON.stringify(written.parsed.issues),
		);
	} finally {
		rmSync(taskDir, { recursive: true, force: true });
	}
});

test("workflow output retry instructions include ref repair guidance", () => {
	const message = buildWorkflowOutputRetryInstructions([
		{
			code: "unavailable_ref_locator",
			section: "refs",
			path: "refs[0]",
			message:
				"ref URL is not reachable (HTTP 404): https://example.test/stale",
		},
	]);

	assert.match(message, /Ref repair guidance/);
	assert.match(message, /Do not repeat refs/);
	assert.match(message, /Remove stale refs or replace them/);
});

test("workflow output retry instructions include claim-support repair guidance", () => {
	const message = buildWorkflowOutputRetryInstructions([
		{
			code: "missing_claim_support",
			section: "control",
			path: "$.claimSupports",
			message: "positive verdict requires claim support",
		},
	]);

	assert.match(message, /Claim-support repair guidance/);
	assert.match(message, /verified or weakened/);
	assert.match(message, /sourceLocator must also appear in <refs>/);
});

test("workflow artifact bundle gates positive verifier claim support", async () => {
	const taskDir = mkdtempSync(join(tmpdir(), "workflow-claim-support-"));
	try {
		const raw = [
			"<control>",
			JSON.stringify({
				schema: "stage-control-v1",
				digest: "claim support ok",
				findingId: "F1",
				verdict: "verified",
				claimSupports: [
					{
						claim: "Runtime validates citation evidence.",
						status: "supports",
						sourceLocators: ["https://example.test/source"],
						excerpt: "validates citation evidence",
					},
				],
			}),
			"</control>",
			"<analysis>",
			"Verifier checked the source excerpt.",
			"</analysis>",
			"<refs>",
			JSON.stringify([{ url: "https://example.test/source" }]),
			"</refs>",
		].join("\n");

		const written = await writeWorkflowTaskArtifactBundle({
			taskDir,
			rawOutput: raw,
			outputProfile: "verification_result_v1",
		});

		assert.equal(written.valid, true, JSON.stringify(written.parsed.issues));
	} finally {
		rmSync(taskDir, { recursive: true, force: true });
	}
});

test("workflow artifact bundle rejects positive verifier support outside refs", async () => {
	const taskDir = mkdtempSync(join(tmpdir(), "workflow-claim-support-bad-"));
	try {
		const raw = [
			"<control>",
			JSON.stringify({
				schema: "stage-control-v1",
				digest: "claim support bad",
				findingId: "F1",
				verdict: "verified",
				claimSupports: [
					{
						claim: "Runtime validates citation evidence.",
						status: "supports",
						sourceLocators: ["https://example.test/invented"],
						excerpt: "validates citation evidence",
					},
				],
			}),
			"</control>",
			"<analysis>",
			"Verifier checked the source excerpt.",
			"</analysis>",
			"<refs>",
			JSON.stringify([{ url: "https://example.test/source" }]),
			"</refs>",
		].join("\n");

		const written = await writeWorkflowTaskArtifactBundle({
			taskDir,
			rawOutput: raw,
			outputProfile: "verification_result_v1",
		});

		assert.equal(written.valid, false);
		assert.ok(
			written.parsed.issues.some(
				(issue) =>
					issue.code === "source_locator_not_in_refs" &&
					/also appear in <refs>/.test(issue.message),
			),
			JSON.stringify(written.parsed.issues),
		);
	} finally {
		rmSync(taskDir, { recursive: true, force: true });
	}
});

test("workflow output parser recovers control object followed by one stray closing brace", () => {
	const control = {
		schema: "stage-control-v1",
		digest: "stray brace recovered",
		findings: [{ id: "f-1", status: "ok" }],
	};
	const raw = [
		"<control>",
		`${JSON.stringify(control)}}`,
		"</control>",
		"<analysis>",
		"Analysis.",
		"</analysis>",
		"<refs>",
		"[]",
		"</refs>",
	].join("\n");
	const parsed = parseWorkflowOutput(raw);
	assert.equal(parsed.valid, true, JSON.stringify(parsed.issues));
	assert.deepEqual(parsed.control, control);
	assert.equal(
		parsed.issues.some(
			(issue) => issue.code === "invalid_json" && issue.section === "control",
		),
		false,
	);
});

test("workflow output parser rejects truncated control JSON with invalid_json", () => {
	const controlText = JSON.stringify({
		schema: "stage-control-v1",
		digest: "truncated",
		details: { ready: true },
	});
	const raw = [
		"<control>",
		controlText.slice(0, -1),
		"</control>",
		"<analysis>",
		"Analysis.",
		"</analysis>",
		"<refs>",
		"[]",
		"</refs>",
	].join("\n");
	const parsed = parseWorkflowOutput(raw);
	assert.equal(parsed.valid, false);
	assert.ok(
		parsed.issues.some(
			(issue) => issue.code === "invalid_json" && issue.section === "control",
		),
		JSON.stringify(parsed.issues),
	);
});

test("workflow output parser rejects substantive trailing control text after first object", () => {
	const controlText = JSON.stringify({
		schema: "stage-control-v1",
		digest: "base object",
	});
	const prose = parseWorkflowOutput(
		[
			"<control>",
			`${controlText} trailing prose`,
			"</control>",
			"<analysis>",
			"Analysis.",
			"</analysis>",
			"<refs>",
			"[]",
			"</refs>",
		].join("\n"),
	);
	assert.equal(prose.valid, false);
	assert.ok(
		prose.issues.some(
			(issue) => issue.code === "invalid_json" && issue.section === "control",
		),
		JSON.stringify(prose.issues),
	);

	const secondObject = parseWorkflowOutput(
		[
			"<control>",
			`${controlText}${JSON.stringify({ schema: "stage-control-v1", digest: "second" })}`,
			"</control>",
			"<analysis>",
			"Analysis.",
			"</analysis>",
			"<refs>",
			"[]",
			"</refs>",
		].join("\n"),
	);
	assert.equal(secondObject.valid, false);
	assert.ok(
		secondObject.issues.some(
			(issue) => issue.code === "invalid_json" && issue.section === "control",
		),
		JSON.stringify(secondObject.issues),
	);
});

test("workflow output parser balances control braces inside strings during stray-brace recovery", () => {
	const control = {
		schema: "stage-control-v1",
		digest: 'string has { and } plus escaped quote "inside"',
		evidence: 'nested-looking {"a":"}"} text and backslash \\ end',
	};
	const raw = [
		"<control>",
		`${JSON.stringify(control)}}`,
		"</control>",
		"<analysis>",
		"Analysis.",
		"</analysis>",
		"<refs>",
		"[]",
		"</refs>",
	].join("\n");
	const parsed = parseWorkflowOutput(raw);
	assert.equal(parsed.valid, true, JSON.stringify(parsed.issues));
	assert.deepEqual(parsed.control, control);
});

test("workflow output parser tolerates literal closing tags inside JSON strings", () => {
	const raw = [
		"<control>",
		JSON.stringify({
			schema: "stage-control-v1",
			digest: "quote contains </control> safely",
			evidence: "also mention </analysis> and </refs> as data",
		}),
		"</control>",
		"<analysis>",
		"Analysis may mention </analysis> as literal text.",
		"</analysis>",
		"<refs>",
		JSON.stringify([{ note: "literal </refs> in JSON data" }]),
		"</refs>",
	].join("\n");
	const parsed = parseWorkflowOutput(raw);
	assert.equal(parsed.valid, true, JSON.stringify(parsed.issues));
	assert.equal(parsed.control.digest, "quote contains </control> safely");
	assert.deepEqual(parsed.refs, [{ note: "literal </refs> in JSON data" }]);

	const protocolQuote = parseWorkflowOutput(
		[
			"<control>",
			JSON.stringify({
				schema: "stage-control-v1",
				digest: "quoted protocol",
				evidence:
					"Return <control>{}</control> <analysis>...</analysis> <refs>[]</refs> exactly.",
			}),
			"</control>",
			"<analysis>",
			"Detailed reasoning.",
			"</analysis>",
			"<refs>",
			"[]",
			"</refs>",
		].join("\n"),
	);
	assert.equal(protocolQuote.valid, true, JSON.stringify(protocolQuote.issues));
	assert.equal(protocolQuote.control.digest, "quoted protocol");
});

test("deep-review report schema requires identity evidence for findings", () => {
	const schemaDir = join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
		"workflows",
		"deep-review",
		"schemas",
	);
	const reportSchema = JSON.parse(
		readFileSync(
			join(schemaDir, "deep-review-report-control.schema.json"),
			"utf8",
		),
	);
	const validControl = {
		schema: "./schemas/deep-review-report-control.schema.json",
		digest: "one finding",
		summary: "summary",
		verdict: "material_issue_found",
		findings: [
			{
				findingId: "finding-001",
				rootCauseId: "root-001",
				title: "Pinned evidence survives",
				severity: "medium",
				locations: [{ file: "src/engine.ts", line: 10 }],
				evidenceQuotes: ["if (changed) return bad;"],
			},
		],
		risks: [],
		needsHuman: [],
		evidenceIndex: [],
		recommendedNextAction: "Fix it.",
	};
	const valid = validateJsonSchema(validControl, reportSchema);
	assert.equal(valid.valid, true, JSON.stringify(valid.issues));
	const invalid = validateJsonSchema(
		{
			...validControl,
			findings: [{ ...validControl.findings[0], evidenceQuotes: [] }],
		},
		reportSchema,
	);
	assert.equal(invalid.valid, false);
	assert.ok(
		invalid.issues.some(
			(issue) => issue.path === "$.findings[0].evidenceQuotes",
		),
	);
});

test("minimal JSON schema validator enforces control schema subset", () => {
	const schema = {
		type: "object",
		required: ["schema", "digest", "items"],
		properties: {
			schema: { type: "string" },
			digest: { type: "string", minLength: 1 },
			items: {
				type: "array",
				minItems: 1,
				items: {
					type: "object",
					required: ["id"],
					properties: { id: { type: "string" } },
				},
			},
		},
	};
	assert.equal(
		validateJsonSchema(
			{ schema: "stage-control-v1", digest: "ok", items: [{ id: "a" }] },
			schema,
		).valid,
		true,
	);
	const invalid = validateJsonSchema(
		{ schema: "stage-control-v1", digest: "ok", items: [] },
		schema,
	);
	assert.equal(invalid.valid, false);
	assert.ok(invalid.issues.some((issue) => issue.path === "$.items"));
});

test("workflow output parser normalizes reviewer location ranges before schema validation", () => {
	const schemaDir = join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
		"workflows",
		"deep-review",
		"schemas",
	);
	const reviewerSchema = JSON.parse(
		readFileSync(
			join(schemaDir, "deep-review-reviewers-control.schema.json"),
			"utf8",
		),
	);
	const baseFinding = {
		severity: "medium",
		title: "Early local transactions can be skipped from persistence",
		file: "core/txpool/locals/tx_tracker.go",
		evidenceQuotes: ["func (tracker *TxTracker) Start() error { ... }"],
	};
	const parseControl = (control) =>
		parseWorkflowOutput(
			[
				"<control>",
				JSON.stringify(control),
				"</control>",
				"<analysis>",
				"analysis",
				"</analysis>",
				"<refs>",
				"[]",
				"</refs>",
			].join("\n"),
			{ controlJsonSchema: reviewerSchema },
		);

	const stringLocations = parseControl({
		schema: "./schemas/deep-review-reviewers-control.schema.json",
		digest: "task-7 attempt 1 shape",
		findings: [
			{
				...baseFinding,
				locations: [
					"core/txpool/locals/tx_tracker.go:175-178",
					"core/txpool/locals/journal.go:140",
				],
			},
		],
	});
	assert.equal(
		stringLocations.valid,
		true,
		JSON.stringify(stringLocations.issues),
	);
	assert.deepEqual(stringLocations.control.findings[0].locations, [
		{ file: "core/txpool/locals/tx_tracker.go", line: 175, lineEnd: 178 },
		{ file: "core/txpool/locals/journal.go", line: 140 },
	]);

	const stringLineRange = parseControl({
		schema: "./schemas/deep-review-reviewers-control.schema.json",
		digest: "task-7 attempt 2 shape",
		findings: [
			{
				...baseFinding,
				locations: [
					{ file: "core/txpool/locals/tx_tracker.go", line: "175-178" },
					{ file: "core/txpool/locals/journal.go", line: "140" },
				],
			},
		],
	});
	assert.equal(
		stringLineRange.valid,
		true,
		JSON.stringify(stringLineRange.issues),
	);
	assert.deepEqual(stringLineRange.control.findings[0].locations, [
		{ file: "core/txpool/locals/tx_tracker.go", line: 175, lineEnd: 178 },
		{ file: "core/txpool/locals/journal.go", line: 140 },
	]);
});

test("workflow output parser rejects missing sections, bad control, outside prose, and contract failures", () => {
	const missing = parseWorkflowOutput("<control>{}</control>\n<refs>[]</refs>");
	assert.equal(missing.valid, false);
	assert.ok(
		missing.issues.some(
			(issue) =>
				issue.code === "missing_section" && issue.section === "analysis",
		),
	);
	assert.ok(missing.issues.some((issue) => issue.path === "$.schema"));
	assert.ok(missing.issues.some((issue) => issue.path === "$.digest"));

	const badJson = parseWorkflowOutput(
		"<control>{nope}</control><analysis>x</analysis><refs>{}</refs>",
	);
	assert.equal(badJson.valid, false);
	assert.ok(
		badJson.issues.some(
			(issue) => issue.code === "invalid_json" && issue.section === "control",
		),
	);
	assert.ok(
		badJson.issues.some(
			(issue) => issue.code === "invalid_type" && issue.section === "refs",
		),
	);

	const prose = parseWorkflowOutput(
		'hello\n<control>{"schema":"x","digest":"d"}</control><analysis>x</analysis><refs>[]</refs>',
	);
	assert.equal(prose.valid, false);
	assert.ok(prose.issues.some((issue) => issue.code === "unexpected_text"));

	const contract = parseWorkflowOutput(
		'<control>{"schema":"x","digest":"d"}</control><analysis>x</analysis><refs>[]</refs>',
		{ controlContract: { requiredPaths: ["$.items"] } },
	);
	assert.equal(contract.valid, false);
	assert.ok(
		contract.issues.some(
			(issue) => issue.code === "contract_failed" && issue.path === "$.items",
		),
	);
	const jsonSchema = parseWorkflowOutput(
		'<control>{"schema":"x","digest":"d","items":[]}</control><analysis>x</analysis><refs>[]</refs>',
		{
			controlJsonSchema: {
				type: "object",
				required: ["items"],
				properties: { items: { type: "array", minItems: 1 } },
			},
		},
	);
	assert.equal(jsonSchema.valid, false);
	assert.ok(
		jsonSchema.issues.some(
			(issue) =>
				issue.code === "contract_failed" &&
				issue.path === "$.items" &&
				/control JSON schema failed/.test(issue.message),
		),
	);
	assert.match(buildWorkflowOutputRetryInstructions(contract.issues), /Issues/);
	assert.match(buildWorkflowOutputRetryInstructions(contract.issues), /items/);
});

test("workflow artifact bundle writer writes sidecars before result envelope", async () => {
	const cwd = makeProject();
	try {
		const taskDir = join(
			cwd,
			".pi",
			"workflows",
			"workflow_unit",
			"tasks",
			"task-1",
		);
		const raw = [
			"<control>",
			JSON.stringify({
				schema: "stage-control-v1",
				digest: "bundle digest",
				outcome: "complete",
			}),
			"</control>",
			"<analysis>",
			"Bundle analysis",
			"</analysis>",
			"<refs>",
			"[]",
			"</refs>",
		].join("\n");
		const written = await writeWorkflowTaskArtifactBundle({
			taskDir,
			rawOutput: raw,
			startedAt: "2026-06-14T00:00:00.000Z",
			completedAt: "2026-06-14T00:00:01.000Z",
			prompt: "prompt text",
			systemPrompt: "system prompt",
			stderr: "",
		});
		assert.equal(written.valid, true);
		assert.equal(
			JSON.parse(readFileSync(join(taskDir, "control.json"), "utf8")).digest,
			"bundle digest",
		);
		assert.equal(
			readFileSync(join(taskDir, "analysis.md"), "utf8"),
			"Bundle analysis\n",
		);
		assert.deepEqual(
			JSON.parse(readFileSync(join(taskDir, "refs.json"), "utf8")),
			[],
		);
		assert.equal(readFileSync(join(taskDir, "raw.md"), "utf8"), raw);
		assert.equal(
			readFileSync(join(taskDir, "prompt.md"), "utf8"),
			"prompt text",
		);
		assert.equal(
			readFileSync(join(taskDir, "system-prompt.md"), "utf8"),
			"system prompt",
		);
		const result = JSON.parse(
			readFileSync(join(taskDir, "result.json"), "utf8"),
		);
		assert.equal(result.schema, "workflow-task-result-v1");
		assert.equal(result.protocol, "workflow-output-sections-v1");
		assert.equal(result.status, "completed");
		assert.equal(result.controlDigest, "bundle digest");
		assert.equal(result.artifacts.control, "control.json");
		assert.equal(result.artifacts.analysis, "analysis.md");
		assert.equal(result.artifacts["system-prompt"], "system-prompt.md");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("workflow artifact bundle writer stores invalid attempts without commit result", async () => {
	const cwd = makeProject();
	try {
		const taskDir = join(
			cwd,
			".pi",
			"workflows",
			"workflow_unit",
			"tasks",
			"task-1",
		);
		const written = await writeWorkflowTaskArtifactBundle({
			taskDir,
			rawOutput: "<control>{}</control><analysis></analysis><refs>{}</refs>",
			attempt: 2,
			completedAt: "2026-06-14T00:00:01.000Z",
		});
		assert.equal(written.valid, false);
		assert.ok(written.parsed.issues.length > 0);
		assert.match(
			readFileSync(join(taskDir, "raw.invalid-attempt-2.md"), "utf8"),
			/<control>/,
		);
		const result = JSON.parse(
			readFileSync(join(taskDir, "result.invalid-attempt-2.json"), "utf8"),
		);
		assert.equal(result.status, "failed");
		assert.equal(result.outputValidation.valid, false);
		assert.ok(
			result.outputValidation.issues.some((issue) => issue.path === "$.digest"),
		);
		assert.throws(
			() => readFileSync(join(taskDir, "result.json"), "utf8"),
			/ENOENT/,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

function workflowViewTask(overrides = {}) {
	const taskId = overrides.taskId ?? "task-1";
	return {
		taskId,
		specId: overrides.specId ?? `${taskId}.main`,
		displayName: overrides.displayName ?? taskId,
		agent: overrides.agent ?? "unit-scout",
		agentFile: ".pi/agents/unit-scout.md",
		roles: [],
		status: overrides.status ?? "completed",
		statusDetail: overrides.statusDetail ?? overrides.status ?? "completed",
		runtime: {
			approvalMode: "never",
			model: "kimi-coding/kimi-for-coding",
			thinking: "low",
			...(overrides.runtime ?? {}),
		},
		tools: [],
		cwd: process.cwd(),
		worktree: {
			enabled: false,
			path: null,
			branch: null,
			baseCwd: null,
			warning: null,
		},
		backendTaskId: `backend-${taskId}`,
		kind: "task",
		stageId: overrides.stageId ?? "verify",
		startedAt: "2026-06-17T06:00:00.000Z",
		completedAt:
			overrides.status === "running" ? undefined : "2026-06-17T06:01:00.000Z",
		elapsedMs: 60_000,
		files: {
			systemPrompt: `.pi/workflows/workflow_ui/tasks/${taskId}/system.md`,
			taskPrompt: `.pi/workflows/workflow_ui/tasks/${taskId}/prompt.md`,
			output: `.pi/workflows/workflow_ui/tasks/${taskId}/output.log`,
			stderr: `.pi/workflows/workflow_ui/tasks/${taskId}/stderr.log`,
			result: `.pi/workflows/workflow_ui/tasks/${taskId}/result.json`,
			...(overrides.files ?? {}),
		},
		lastMessage: overrides.lastMessage,
		outputValidation: overrides.outputValidation,
	};
}

function workflowViewRun(tasks) {
	return {
		schemaVersion: 1,
		runId: "workflow_ui",
		name: "UI fixture",
		type: WORKFLOW_RUN_TYPE,
		status: deriveWorkflowStatus(summarizeTasks(tasks)),
		taskSummary: summarizeTasks(tasks),
		cwd: process.cwd(),
		backend: { type: "local-pi", mode: "headless" },
		createdAt: "2026-06-17T06:00:00.000Z",
		updatedAt: "2026-06-17T06:02:00.000Z",
		specPath: "workflows/ui.json",
		runJson: ".pi/workflows/workflow_ui/run.json",
		tasks,
	};
}

function workflowViewSummary(run) {
	return {
		runId: run.runId,
		name: run.name,
		type: run.type,
		status: run.status,
		taskSummary: run.taskSummary,
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
		runJson: run.runJson,
		tasks: run.tasks.map((task) => ({
			taskId: task.taskId,
			displayName: task.displayName,
			kind: task.kind,
			stageId: task.stageId,
			agent: task.agent,
			status: task.status,
			statusDetail: task.statusDetail,
			lastMessage: task.lastMessage,
		})),
	};
}

function workflowViewFixture(tasks) {
	const run = workflowViewRun(tasks);
	const view = new WorkflowView(
		process.cwd(),
		{ requestRender() {} },
		{},
		() => {},
	);
	view.loading = false;
	view.flows = [workflowViewSummary(run)];
	view.detailRun = run;
	view.selectedStage = 0;
	view.selectedTask = 0;
	return { view, run };
}

function workflowViewText(view, width = 118) {
	return view.render(width).join("\n");
}

test("workflow task detail switches between output and prompt artifacts", () => {
	const task = workflowViewTask({
		displayName: "broken verifier",
		status: "failed",
		outputValidation: {
			valid: false,
			issues: [{ path: "$.digest", message: "digest is required" }],
		},
	});
	const { view } = workflowViewFixture([task]);
	view.mode = "task";
	view.outputLines = ["output evidence line"];
	view.promptLines = ["prompt instruction line"];

	let rendered = workflowViewText(view);
	assert.match(rendered, /Viewing: Output/);
	assert.match(rendered, /output evidence line/);
	assert.match(rendered, /digest is required/);
	assert.doesNotMatch(rendered, /prompt instruction line/);
	assert.doesNotMatch(rendered, /Artifacts \/ Commands|Contract \/ Output/);

	view.handleInput("\u001b[C");
	rendered = workflowViewText(view);
	assert.match(rendered, /Viewing: Prompt/);
	assert.match(rendered, /prompt instruction line/);
	assert.doesNotMatch(rendered, /output evidence line/);

	view.handleInput("\u001b[D");
	rendered = workflowViewText(view);
	assert.match(rendered, /Viewing: Output/);
	assert.match(rendered, /output evidence line/);
});

test("workflow task detail scrolls the selected artifact with arrow keys", () => {
	const task = workflowViewTask({
		displayName: "long output",
		status: "failed",
	});
	const { view } = workflowViewFixture([task]);
	view.mode = "task";
	view.outputLines = Array.from(
		{ length: 24 },
		(_, index) => `output row ${String(index + 1).padStart(2, "0")}`,
	);

	let rendered = workflowViewText(view);
	assert.match(rendered, /1-16 \/ 24/);
	assert.match(rendered, /output row 01/);
	assert.doesNotMatch(rendered, /output row 17/);

	view.handleInput("\u001b[B");
	rendered = workflowViewText(view);
	assert.match(rendered, /2-17 \/ 24/);
	assert.doesNotMatch(rendered, /output row 01/);
	assert.match(rendered, /output row 17/);

	view.handleInput("\u001b[A");
	rendered = workflowViewText(view);
	assert.match(rendered, /1-16 \/ 24/);
	assert.match(rendered, /output row 01/);
});

test("workflow task list orders problem tasks before completed tasks", () => {
	const tasks = [
		workflowViewTask({
			taskId: "done",
			displayName: "done task",
			status: "completed",
		}),
		workflowViewTask({
			taskId: "blocked",
			displayName: "blocked task",
			status: "blocked",
		}),
		workflowViewTask({
			taskId: "failed",
			displayName: "failed task",
			status: "failed",
			outputValidation: {
				valid: false,
				issues: [{ message: "bad contract output" }],
			},
		}),
		workflowViewTask({
			taskId: "running",
			displayName: "running task",
			status: "running",
		}),
	];
	const { view } = workflowViewFixture(tasks);
	view.mode = "tasks";

	const rendered = workflowViewText(view);
	const failedIndex = rendered.indexOf("failed task");
	const blockedIndex = rendered.indexOf("blocked task");
	const runningIndex = rendered.indexOf("running task");
	const doneIndex = rendered.indexOf("done task");
	const invalidOutputIndex = rendered.indexOf("invalid output");

	assert.ok(failedIndex >= 0, "failed task rendered");
	assert.ok(blockedIndex > failedIndex, "blocked task follows failed task");
	assert.ok(runningIndex > blockedIndex, "running task follows blocked task");
	assert.ok(doneIndex > runningIndex, "completed task follows running task");
	assert.ok(
		invalidOutputIndex > failedIndex,
		"failed row shows invalid output",
	);
	assert.match(rendered, /Stages/);
	assert.match(rendered, /verify tasks/);
	assert.doesNotMatch(rendered, /Stage Summary|Selected Task Preview/);
});

test("workflow task selection follows task id after problem reordering changes", () => {
	const tasks = [
		workflowViewTask({
			taskId: "failed",
			displayName: "failed task",
			status: "failed",
		}),
		workflowViewTask({
			taskId: "blocked",
			displayName: "blocked task",
			status: "blocked",
		}),
		workflowViewTask({
			taskId: "running",
			displayName: "running task",
			status: "running",
		}),
		workflowViewTask({
			taskId: "done",
			displayName: "done task",
			status: "completed",
		}),
	];
	const { view, run } = workflowViewFixture(tasks);
	view.mode = "tasks";

	view.handleInput("\u001b[B");
	assert.match(workflowViewText(view), /› ◆ blocked task/);

	const failed = run.tasks.find((task) => task.taskId === "failed");
	failed.status = "completed";
	failed.statusDetail = "completed";
	view.clampStageAndTask();

	const rendered = workflowViewText(view);
	assert.match(rendered, /› ◆ blocked task/);
	assert.ok(
		rendered.indexOf("blocked task") < rendered.indexOf("failed task"),
		"blocked task remains selected after failed task moves down",
	);
});
test("workflow board render clamps ANSI and wide glyphs to viewport width", () => {
	const theme = {
		fg: (color, text) => `\u001b[38;2;${color.length};2;3m${text}\u001b[39m`,
		bg: (_color, text) => `\u001b[48;2;32;40;31m${text}\u001b[49m`,
		bold: (text) => `\u001b[1m${text}\u001b[22m`,
	};
	const view = new WorkflowView(
		process.cwd(),
		{ requestRender() {} },
		theme,
		() => {},
	);
	view.loading = false;
	view.flows = [
		{
			runId: "workflow_crash_regression_width_test",
			name: "Validation result ✅🚀 delivery-signed workflow".repeat(4),
			type: WORKFLOW_RUN_TYPE,
			artifactGraph: { enabled: true },
			status: "completed",
			taskSummary: {
				pending: 0,
				running: 0,
				blocked: 0,
				completed: 3,
				failed: 0,
				skipped: 0,
				interrupted: 0,
				total: 3,
			},
			createdAt: "2026-06-17T06:00:00.000Z",
			updatedAt: "2026-06-17T06:09:35.895Z",
			runJson: ".pi/workflows/workflow_crash_regression_width_test/run.json",
			tasks: [],
		},
	];
	view.message = "Validation result ✅🚀 passed".repeat(8);

	for (const width of [86, 40, 10, 1]) {
		const lines = view.render(width);
		for (const [index, line] of lines.entries()) {
			assert.ok(
				testVisibleWidth(line) <= width,
				`line ${index} exceeds width ${width}: ${testVisibleWidth(line)} > ${width}`,
			);
		}
	}
});

function testVisibleWidth(text) {
	let clean = "";
	for (let index = 0; index < text.length; ) {
		if (text[index] === "\u001b" && text[index + 1] === "[") {
			index += 2;
			while (index < text.length) {
				const code = text.charCodeAt(index);
				index += 1;
				if (code >= 0x40 && code <= 0x7e) break;
			}
			continue;
		}
		const codePoint = text.codePointAt(index);
		if (codePoint === undefined) break;
		const char = String.fromCodePoint(codePoint);
		clean += char;
		index += char.length;
	}
	let width = 0;
	for (const char of clean) {
		const codePoint = char.codePointAt(0) ?? 0;
		width += isTestWideCodePoint(codePoint) ? 2 : 1;
	}
	return width;
}

function isTestWideCodePoint(codePoint) {
	return (
		(codePoint >= 0x1100 && codePoint <= 0x115f) ||
		(codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
		(codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
		(codePoint >= 0xf900 && codePoint <= 0xfaff) ||
		(codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
		(codePoint >= 0xff00 && codePoint <= 0xffe6) ||
		(codePoint >= 0x1f000 && codePoint <= 0x1fbff) ||
		codePoint === 0x2705 ||
		(codePoint >= 0x2b50 && codePoint <= 0x2b55)
	);
}
