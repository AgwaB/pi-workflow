import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync as nodeRmSync,
	symlinkSync,
	unlinkSync,
	utimesSync,
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
	formatStatus,
	resumeRun,
	runDynamicControllerEngineIntegrityCheckForTests,
	stopRun,
	runDynamicTask,
	runWorkflow,
	runWorkflowSpec,
	scheduleRun,
	waitForRun,
	watchRun,
} from "../../.tmp/unit/engine.js";
import workflowExtension, {
	deliverMissedWorkflowFeedback,
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
import {
	diagnoseWorkflowRunHealth,
	diagnoseWorkflowTaskHealth,
} from "../../.tmp/unit/workflow-progress-health.js";
import { WorkflowView } from "../../.tmp/unit/workflow-view.js";
import { resolveWorkflowRuntime } from "../../.tmp/unit/workflow-runtime.js";
import { compactStrings } from "../../.tmp/unit/strings.js";
import {
	assertValidDynamicDecision,
	buildWorkflowRunMetrics,
	canonicalVerificationStatus as canonicalPackageVerificationStatus,
	dynamicOutputProfileValues,
	isNonVerifiedTerminalStatus as isPackageNonVerifiedTerminalStatus,
	isVerificationBlockedStatus as isPackageVerificationBlockedStatus,
	isVerifiedStatus as isPackageVerifiedStatus,
	verificationStatusBucket as packageVerificationStatusBucket,
	VERIFICATION_STATUS_VALUES as PACKAGE_VERIFICATION_STATUS_VALUES,
} from "../../.tmp/unit/index.js";
import {
	loadWorkflow,
	loadWorkflowSpec,
	parseWorkflow as parsePublicWorkflow,
} from "../../.tmp/unit/schema.js";
import {
	acquireSupervisorLease,
	createRunRecord,
	createWorkflowRunRecord,
	deriveRunStatus,
	flushPendingIndexUpdatesForTests,
	heartbeatSupervisorLease,
	readRunRecord,
	resetTaskForResume,
	resolveFlowsCwd,
	setIndexUpdateDebounceMsForTests,
	setRunLeaseTestHooksForTests,
	setTaskTerminal,
	supervisorLeasePath,
	supervisorPath,
	updateIndex,
	workflowProcessRoleForTests,
	workflowSupervisorOwnerIdForTests,
	withRunLease,
	writeJsonAtomic,
	writeRunRecord,
	writeStaticRunArtifacts,
} from "../../.tmp/unit/store.js";
import {
	WorkflowValidationError,
	WORKFLOW_RUN_TYPE,
} from "../../.tmp/unit/types.js";
import {
	prepareDagTask,
	supportOutputAnalysis,
} from "../../.tmp/unit/artifact-graph-runtime.js";
import {
	canStageProceedAfterPreviousFailure,
	readSimpleJsonPath,
	shouldScheduleAfterStageFailure,
} from "../../.tmp/unit/workflow-runtime.js";
import {
	buildForeachGeneratedTasks,
	dependenciesReady,
	markDagDependentsSkipped,
} from "../../.tmp/unit/engine-run-graph.js";
import {
	deriveWorkflowStatus,
	summarizeTaskFailureClasses,
	summarizeTasks,
} from "../../.tmp/unit/store.js";
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
	buildDynamicGeneratedCompiledTask,
	DYNAMIC_WEB_SEARCH_BUDGET,
} from "../../.tmp/unit/dynamic-generated-task-runtime.js";
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
	parseWorkflowOutputForBundle,
	setWorkflowOutputArtifactWriteHookForTests,
	writeWorkflowTaskArtifactBundle,
} from "../../.tmp/unit/workflow-output-artifacts.js";
import { parseWorkflowPartialOutput } from "../../.tmp/unit/workflow-partial-output.js";
import {
	CACHE_SHAPE_METRICS_ENV,
	EXPERIMENTAL_CACHE_STABLE_FOREACH_ENV,
	EXPERIMENTAL_DEPTH_ROUTER_ENV,
	EXPERIMENTAL_LAUNCH_RAMP_ENV,
	EXPERIMENTAL_SAME_SESSION_REPAIR_ENV,
	EXPERIMENTAL_TOOL_DEDUP_ENV,
	enabledWorkflowExperimentalSpeedFlags,
	workflowExperimentalFlagEnabled,
} from "../../.tmp/unit/experimental-speed-flags.js";
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
	ARTIFACT_OUTPUT_RETRIES_ENV,
	TRANSIENT_MODEL_FAILURE_RETRIES_ENV,
	checkRequiredArtifactReads,
	cleanupSubagentRun,
	launchSubagentTask,
	observeLiveModelWorkerCompletion,
	recordSharedModelRateLimitBackoffForTests,
	refreshRunFromSubagentArtifacts,
	resolveLaunchControlTelemetryForTests,
	resolveWorkflowRetryLimit,
	setSubagentApiForTests,
	setSubagentLaunchControlsForTests,
} from "../../.tmp/unit/subagent-backend.js";

function rmSync(path, options) {
	const retryOptions =
		options?.recursive && options?.force
			? {
					...options,
					maxRetries: options.maxRetries ?? 5,
					retryDelay: options.retryDelay ?? 20,
				}
			: options;
	return nodeRmSync(path, retryOptions);
}

const UNIT_TEST_HOME = mkdtempSync(join(tmpdir(), "workflow-unit-home-"));
process.env.HOME = UNIT_TEST_HOME;
process.env.USERPROFILE = UNIT_TEST_HOME;

setSubagentLaunchControlsForTests({ releaseDelayMs: 0, retryJitterMs: 0 });

function makeProject() {
	return mkdtempSync(join(tmpdir(), "workflow-unit-"));
}

function supervisorLockPath(cwd, runId) {
	return join(cwd, ".pi", "workflows", runId, "supervisor.lock");
}

function writeSupervisorLock(
	cwd,
	runId,
	{ ownerId = "stale-owner", pid = 99999999, createdAt, mtime } = {},
) {
	const lockFile = supervisorLockPath(cwd, runId);
	mkdirSync(dirname(lockFile), { recursive: true });
	writeFileSync(
		lockFile,
		`${ownerId}\n${pid}\n${createdAt ?? new Date().toISOString()}\n`,
		"utf8",
	);
	if (mtime) utimesSync(lockFile, mtime, mtime);
	return lockFile;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const parentSubagentEnvKeys = [
	"PI_WORKFLOW_PARENT_SUBAGENT_CWD",
	"PI_WORKFLOW_PARENT_SUBAGENT_RUNS_DIR",
	"PI_WORKFLOW_PARENT_SUBAGENT_RUN_ID",
	"PI_WORKFLOW_PARENT_SUBAGENT_ATTEMPT_ID",
];

function captureParentSubagentEnv() {
	return Object.fromEntries(
		parentSubagentEnvKeys.map((key) => [key, process.env[key]]),
	);
}

function restoreParentSubagentEnv(previous) {
	for (const key of parentSubagentEnvKeys) {
		if (previous[key] === undefined) delete process.env[key];
		else process.env[key] = previous[key];
	}
}

function setParentSubagentEnv(cwd) {
	process.env.PI_WORKFLOW_PARENT_SUBAGENT_CWD = cwd;
	process.env.PI_WORKFLOW_PARENT_SUBAGENT_RUNS_DIR = ".pi/agent/runs";
	process.env.PI_WORKFLOW_PARENT_SUBAGENT_RUN_ID = "parent_run";
	process.env.PI_WORKFLOW_PARENT_SUBAGENT_ATTEMPT_ID = "parent_attempt";
}

async function eventually(action, timeoutMs = 750) {
	const deadline = Date.now() + timeoutMs;
	let lastError;
	while (Date.now() <= deadline) {
		try {
			return action();
		} catch (error) {
			lastError = error;
			await sleep(25);
		}
	}
	if (lastError) throw lastError;
	return action();
}

function readWorkflowIndexFile(cwd) {
	return JSON.parse(
		readFileSync(join(cwd, ".pi", "workflows", "index.json"), "utf8"),
	);
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

async function createFailFastPolicyRun(cwd, policy = {}) {
	writeAgent(cwd, "unit-scout", "read");
	const specPath = join(cwd, "workflows", "fail-fast.json");
	const spec = workflowSpec("unit-scout", {
		artifactGraph: {
			maxConcurrency: 1,
			...policy,
			stages: [
				{ id: "failed", type: "single", prompt: "Fail." },
				{ id: "running", type: "single", prompt: "Run." },
				{ id: "pending", type: "single", prompt: "Wait." },
				{
					id: "partial-child",
					type: "single",
					after: "failed",
					sourcePolicy: "partial",
					prompt: "Partial child.",
				},
				{
					id: "require-child",
					type: "single",
					after: "failed",
					prompt: "Require-success child.",
				},
			],
		},
	});
	const compiled = await compileWorkflow(spec, {
		cwd,
		task: "Exercise fail-fast policy",
		specPath,
	});
	const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
	await writeStaticRunArtifacts(cwd, run, compiled, spec);
	setTaskTerminal(taskBySpec(run, "failed.main"), "failed", "model", {
		exitCode: 1,
		lastMessage: "model failure",
	});
	const running = taskBySpec(run, "running.main");
	running.status = "running";
	running.statusDetail = "running";
	running.startedAt = new Date().toISOString();
	running.backendHandle = {
		engine: "pi-subagent",
		backend: "headless",
		runId: "child-running",
		attemptId: "attempt-running",
		cwd,
		runsDir: ".pi/subagents/fail-fast",
	};
	running.backendTaskId = "child-running";
	await writeRunRecord(cwd, run);
	return { compiled, run, spec };
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

function makeSubagentLaunchFixture(cwd, suffix) {
	const now = new Date().toISOString();
	const task = {
		taskId: "task-1",
		specId: `launch-${suffix}.main`,
		displayName: `launch-${suffix}.main`,
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
			systemPrompt: `.pi/workflows/workflow_launch_${suffix}/tasks/task-1/system.md`,
			taskPrompt: `.pi/workflows/workflow_launch_${suffix}/tasks/task-1/task.md`,
			output: `.pi/workflows/workflow_launch_${suffix}/tasks/task-1/output.log`,
			stderr: `.pi/workflows/workflow_launch_${suffix}/tasks/task-1/stderr.log`,
			result: `.pi/workflows/workflow_launch_${suffix}/tasks/task-1/result.json`,
		},
	};
	const run = {
		schemaVersion: 1,
		runId: `workflow_launch_${suffix}`,
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
		id: `launch-${suffix}.main`,
		agent: "unit-scout",
		agentPath: ".pi/agents/unit-scout.md",
		agentSystemPrompt: "Launch agent.",
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
		compiledPrompt: "Launch prompt.",
	};
	return { run, task, compiledTask };
}

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

async function buildDynamicGeneratedTaskWithTools(cwd, tools) {
	writeAgent(cwd, "unit-scout", tools.join(", "));
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
		runtime: { approvalMode: "non-interactive" },
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
	return await buildDynamicGeneratedCompiledTask({
		cwd,
		run: {
			runId: "workflow_dynamic_web_budget",
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
		opId: "op-1",
		requestHash: "hash-1",
		request: {
			id: "worker",
			agent: "unit-scout",
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
				workerDefaults: { tools },
				allowedAgents: [],
				allowedOutputProfiles: [],
			},
		},
	});
}

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
	stateIndexResults = [],
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
				const i = calls.stateIndexRequests.length - 1;
				const override = stateIndexResults[i];
				return {
					digest:
						override?.digest ?? stateIndexDigests[i] ?? `index-${i + 1}`,
					index: override?.index ?? {},
					artifacts: override?.artifacts ?? {},
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

function withAdaptiveLiveWorkerEnv(overrides, run) {
	const previousAdaptive = process.env.PI_WORKFLOW_ADAPTIVE_LIVE_WORKERS;
	const previousLiveWorkers = process.env.PI_WORKFLOW_MAX_LIVE_MODEL_WORKERS;
	if (overrides.adaptive === undefined)
		delete process.env.PI_WORKFLOW_ADAPTIVE_LIVE_WORKERS;
	else process.env.PI_WORKFLOW_ADAPTIVE_LIVE_WORKERS = overrides.adaptive;
	if (overrides.maxLiveWorkers === undefined)
		delete process.env.PI_WORKFLOW_MAX_LIVE_MODEL_WORKERS;
	else
		process.env.PI_WORKFLOW_MAX_LIVE_MODEL_WORKERS = overrides.maxLiveWorkers;
	setSubagentLaunchControlsForTests({ releaseDelayMs: 0, retryJitterMs: 0 });
	const restore = () => {
		if (previousAdaptive === undefined)
			delete process.env.PI_WORKFLOW_ADAPTIVE_LIVE_WORKERS;
		else process.env.PI_WORKFLOW_ADAPTIVE_LIVE_WORKERS = previousAdaptive;
		if (previousLiveWorkers === undefined)
			delete process.env.PI_WORKFLOW_MAX_LIVE_MODEL_WORKERS;
		else process.env.PI_WORKFLOW_MAX_LIVE_MODEL_WORKERS = previousLiveWorkers;
		setSubagentLaunchControlsForTests({ releaseDelayMs: 0, retryJitterMs: 0 });
	};
	const result = run();
	if (result && typeof result.finally === "function") {
		return result.finally(restore);
	}
	restore();
	return result;
}

function perItemDispatchStreamingSpec(extraStages = []) {
	return workflowSpec("unit-scout", {
		artifactGraph: {
			stages: [
				{
					id: "produce",
					type: "single",
					prompt: "Produce items",
					output: { partial: { paths: ["$.items", "$.slots"] } },
				},
				{
					id: "verify",
					type: "foreach",
					from: {
						source: "produce",
						path: "$.items",
						streaming: { enabled: true },
					},
					sourceProjection: { include: ["$.items", "$.slots"] },
					each: { prompt: "Verify ${item}" },
				},
				...extraStages,
			],
		},
	});
}

async function createRunningPartialProducerRun(cwd, spec, outputText) {
	const compiled = await compileWorkflow(spec, { cwd, task: "Check items" });
	const { run } = await createWorkflowRunRecord(
		cwd,
		compiled,
		join(cwd, "workflows", "unit.json"),
	);
	await writeStaticRunArtifacts(cwd, run, compiled, spec);
	const producer = taskBySpec(run, "produce.main");
	producer.status = "running";
	producer.statusDetail = "running";
	producer.startedAt = new Date().toISOString();
	mkdirSync(dirname(join(cwd, producer.files.output)), { recursive: true });
	writeFileSync(join(cwd, producer.files.output), outputText, "utf8");
	await writeRunRecord(cwd, run);
	return { compiled, run, producer };
}

const PARTIAL_ITEM_A_SECTION =
	'<partial-control>{"schema":"workflow-partial-output-v1","path":"$.items","items":[{"id":"ITEM_A","text":"A"}]}</partial-control>';
const PARTIAL_SLOT_A_SECTION =
	'<partial-control>{"schema":"workflow-partial-output-v1","path":"$.slots","items":[{"id":"SLOT_A","fact":"answer-42"}]}</partial-control>';

async function refreshZeroOutputModelFailure(cwd, options) {
	writeAgent(cwd, "unit-scout", "read");
	const spec = workflowSpec("unit-scout", {
		...(options.model === undefined ? {} : { model: options.model }),
		artifactGraph: {
			stages: [{ id: "main", type: "single", prompt: "Do work." }],
		},
	});
	const compiled = await compileWorkflow(spec, { cwd, task: "Review topic" });
	const { run } = await createWorkflowRunRecord(
		cwd,
		compiled,
		join(cwd, "workflows", "unit.json"),
	);
	await writeStaticRunArtifacts(cwd, run, compiled, spec);
	await prepareDagTask(cwd, run, compiled, 0);
	const task = run.tasks[0];
	const runId = options.runId;
	const attemptId = options.attemptId;
	task.status = "running";
	task.statusDetail = "running";
	task.startedAt = new Date().toISOString();
	if (options.launchRetry) task.launchRetry = options.launchRetry;
	task.backendHandle = {
		engine: "pi-subagent",
		backend: "headless",
		runId,
		attemptId,
		cwd,
		runsDir: `.pi/workflow-subagents/${runId}`,
		display: `pi-subagent/headless ${runId}/${attemptId}`,
	};

	const artifactDirName = options.artifactDirName;
	const artifactDir = join(cwd, artifactDirName);
	const streamErrors = options.streamErrors ?? [];
	const statusMetadata = {
		contextLengthExceeded: false,
		stopReason: "error",
		...(options.metadata ?? {}),
	};
	if (streamErrors.length > 0) statusMetadata.streamErrors = streamErrors;
	mkdirSync(artifactDir, { recursive: true });
	writeFileSync(join(artifactDir, "output.log"), "");
	writeFileSync(join(artifactDir, "stderr.log"), options.stderrText ?? "");
	writeFileSync(
		join(artifactDir, "result.json"),
		JSON.stringify({
			status: "failed",
			failureKind: "model",
			exitCode: 0,
			completedAt: new Date().toISOString(),
			startedAt: task.startedAt,
			errorMessage: options.errorMessage ?? "pi-subagent run failed: model",
			metadata: statusMetadata,
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
				runId,
				attemptId,
				backend: "headless",
				status: "failed",
				failureKind: "model",
				startedAt: task.startedAt,
				completedAt: new Date().toISOString(),
				logs: [
					{
						type: "output",
						path: `${artifactDirName}/output.log`,
						artifactCwd: cwd,
					},
					{
						type: "stderr",
						path: `${artifactDirName}/stderr.log`,
						artifactCwd: cwd,
					},
					{
						type: "result",
						path: `${artifactDirName}/result.json`,
						artifactCwd: cwd,
					},
				],
				metadata: statusMetadata,
				attempts: [
					{
						attemptId,
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
	return { compiled, run: refreshed, refreshedTask: refreshed.tasks[0] };
}

async function createPendingSingleTaskRun(cwd, options = {}) {
	writeAgent(cwd, "unit-scout", "read");
	const spec = workflowSpec("unit-scout", {
		...(options.model === undefined ? {} : { model: options.model }),
		artifactGraph: {
			stages: [{ id: "main", type: "single", prompt: "Do work." }],
		},
	});
	const compiled = await compileWorkflow(spec, { cwd, task: "Review topic" });
	const { run } = await createWorkflowRunRecord(
		cwd,
		compiled,
		join(cwd, "workflows", `${options.specName ?? "unit"}.json`),
	);
	await writeStaticRunArtifacts(cwd, run, compiled, spec);
	await prepareDagTask(cwd, run, compiled, 0);
	return { compiled, run, task: run.tasks[0] };
}

function firstTransientModelFailureAttemptPath(cwd, refreshedTask) {
	return join(
		cwd,
		dirname(refreshedTask.files.result),
		"result.transient-model-failure-1.json",
	);
}

function assertFirstTransientModelRetry(cwd, refreshedTask) {
	assert.equal(refreshedTask.status, "pending");
	assert.equal(refreshedTask.statusDetail, "retry_model_failure");
	assert.equal(refreshedTask.launchRetry?.attempts, 1);
	assert.equal(refreshedTask.launchRetry?.reason, "model");
	assert.equal(refreshedTask.backendHandle, undefined);
	assert.equal(
		existsSync(firstTransientModelFailureAttemptPath(cwd, refreshedTask)),
		true,
	);
}

function assertPermanentModelFailure(cwd, refreshedTask, messagePattern) {
	assert.equal(refreshedTask.status, "failed");
	assert.equal(refreshedTask.launchRetry, undefined);
	assert.match(refreshedTask.lastMessage, /permanent-model failure/);
	assert.match(refreshedTask.lastMessage, messagePattern);
	assert.equal(
		existsSync(firstTransientModelFailureAttemptPath(cwd, refreshedTask)),
		false,
	);
	const result = JSON.parse(
		readFileSync(join(cwd, refreshedTask.files.result), "utf8"),
	);
	assert.equal(result.failureKind, "permanent_model_failure");
}

function degradationWorkflowSpec() {
	return workflowSpec("unit-scout", {
		artifactGraph: {
			stages: [
				{ id: "research", type: "single", prompt: "Research." },
				{ id: "verify", type: "single", prompt: "Verify." },
				{ id: "report", type: "single", prompt: "Report." },
			],
		},
	});
}

function taskByStage(run, stageId) {
	const task = run.tasks.find((item) => item.stageId === stageId);
	assert.ok(task, `task for stage ${stageId}`);
	return task;
}

const UNFINISHED_NOTICE_TEST_SUMMARY = {
	pending: 0,
	running: 0,
	blocked: 0,
	completed: 1,
	failed: 1,
	skipped: 3,
	interrupted: 0,
	total: 5,
};

function writeUnfinishedNoticeIndexRun(overrides) {
	return {
		type: "artifact-graph",
		status: "failed",
		taskSummary: UNFINISHED_NOTICE_TEST_SUMMARY,
		createdAt: "2026-06-11T00:00:00.000Z",
		updatedAt: "2026-06-11T00:00:00.000Z",
		runJson: "x",
		tasks: [],
		...overrides,
	};
}

function unfinishedNoticeTasks(run) {
	const summary = run.taskSummary ?? {};
	const counts =
		run.status === "completed"
			? { completed: Math.max(1, summary.completed ?? 0) }
			: {
					completed: summary.completed ?? 0,
					failed: summary.failed ?? 0,
					skipped: summary.skipped ?? 0,
					interrupted: summary.interrupted ?? 0,
					blocked: summary.blocked ?? 0,
					running: summary.running ?? 0,
					pending: summary.pending ?? 0,
				};
	const tasks = [];
	for (const [status, count] of Object.entries(counts)) {
		for (let index = 0; index < count; index += 1) {
			const taskId = `task-${tasks.length + 1}`;
			tasks.push({
				taskId,
				specId: taskId,
				displayName: taskId,
				agent: "scout",
				status,
				statusDetail: status,
				backendTaskId: "",
				files: {},
			});
		}
	}
	if (tasks.length === 0 && run.status !== "completed") {
		tasks.push({
			taskId: "task-1",
			specId: "task-1",
			displayName: "task-1",
			agent: "scout",
			status: run.status,
			statusDetail: run.status,
			backendTaskId: "",
			files: {},
		});
	}
	if (run.degradation?.finalOutputRendered) {
		const finalTask = tasks.findLast((task) => task.status === "completed");
		if (finalTask) {
			finalTask.dependsOn = tasks
				.filter((task) => task !== finalTask)
				.map((task) => task.specId);
		}
	}
	return tasks;
}

function writeUnfinishedNoticeIndex(cwd, runs) {
	const indexDir = join(cwd, ".pi", "workflows");
	mkdirSync(indexDir, { recursive: true });
	writeFileSync(
		join(indexDir, "index.json"),
		JSON.stringify({
			schemaVersion: 1,
			updatedAt: "2026-06-12T11:00:00.000Z",
			runs,
		}),
	);
	for (const run of runs) {
		const runDir = join(indexDir, run.runId);
		mkdirSync(runDir, { recursive: true });
		writeFileSync(
			join(runDir, "run.json"),
			JSON.stringify({
				...run,
				schemaVersion: 1,
				cwd,
				backend: { type: "local-pi", mode: "headless" },
				specPath: run.specPath ?? "x",
				tasks:
					run.tasks?.length > 0 ? run.tasks : unfinishedNoticeTasks(run),
			}),
		);
	}
	return indexDir;
}

function writeUnfinishedNoticeRunRecord(cwd, runId, provenance) {
	const indexPath = join(cwd, ".pi", "workflows", "index.json");
	const indexedRun = existsSync(indexPath)
		? JSON.parse(readFileSync(indexPath)).runs?.find((run) => run.runId === runId)
		: undefined;
	const runDir = join(cwd, ".pi", "workflows", runId);
	mkdirSync(runDir, { recursive: true });
	writeFileSync(
		join(runDir, "run.json"),
		JSON.stringify({
			schemaVersion: 1,
			runId,
			type: "artifact-graph",
			status: "failed",
			...(indexedRun?.name ? { name: indexedRun.name } : {}),
			taskSummary: UNFINISHED_NOTICE_TEST_SUMMARY,
			cwd,
			backend: { type: "local-pi", mode: "headless" },
			createdAt: "2026-06-11T00:00:00.000Z",
			updatedAt: "2026-06-11T00:00:00.000Z",
			specPath: "x",
			...(provenance ? { provenance } : {}),
			tasks: unfinishedNoticeTasks({
				status: "failed",
				taskSummary: UNFINISHED_NOTICE_TEST_SUMMARY,
			}),
		}),
	);
}

function workflowArtifactJsonPayload(result) {
	const text = result.content[0].text;
	const body = text.slice(text.indexOf("\n\n") + 2);
	const warningMarker = "\n\n[workflow_artifact output truncated:";
	const jsonText = body.includes(warningMarker)
		? body.slice(0, body.indexOf(warningMarker))
		: body;
	return { jsonText, payload: JSON.parse(jsonText) };
}

function workflowOutputRawWithRefs(refs) {
	return [
		"<control>",
		JSON.stringify({ schema: "stage-control-v1", digest: "ready" }),
		"</control>",
		"<analysis>",
		"Detailed reasoning with cited refs.",
		"</analysis>",
		"<refs>",
		JSON.stringify(refs),
		"</refs>",
	].join("\n");
}

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
		kind: overrides.kind ?? "task",
		stageId: overrides.stageId ?? "verify",
		startedAt: overrides.startedAt ?? "2026-06-17T06:00:00.000Z",
		completedAt:
			overrides.completedAt ??
			(overrides.status === "running" ? undefined : "2026-06-17T06:01:00.000Z"),
		elapsedMs: Object.hasOwn(overrides, "elapsedMs")
			? overrides.elapsedMs
			: 60_000,
		backendHandle: overrides.backendHandle,
		pid: overrides.pid,
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

function stallProgressTask(runId, status) {
	return {
		taskId: "task-1",
		specId: "main.main",
		agent: "unit-scout",
		status,
		statusDetail: status,
		runtime: { model: "test-model", thinking: "none" },
		worktree: { enabled: false },
		files: {
			output: `.pi/workflows/${runId}/tasks/task-1/output.md`,
			stderr: `.pi/workflows/${runId}/tasks/task-1/stderr.log`,
			result: `.pi/workflows/${runId}/tasks/task-1/result.json`,
		},
		tools: ["read"],
	};
}

function stallProgressRun(cwd, runId, status, createdAt) {
	const tasks = [stallProgressTask(runId, status)];
	return {
		schemaVersion: 1,
		runId,
		name: "stall-unit",
		type: WORKFLOW_RUN_TYPE,
		status: deriveWorkflowStatus(summarizeTasks(tasks)),
		taskSummary: summarizeTasks(tasks),
		cwd,
		backend: { type: "local-pi", mode: "headless" },
		createdAt,
		updatedAt: createdAt,
		specPath: "workflows/stall-unit.json",
		tasks,
	};
}

async function stallFormatterFixture(cwd, runId, supervisor) {
	const createdAt = new Date(Date.now() - 60 * 60_000).toISOString();
	const run = stallProgressRun(cwd, runId, "running", createdAt);
	await writeJsonAtomic(join(cwd, ".pi", "workflows", runId, "run.json"), run);
	await writeJsonAtomic(supervisorPath(cwd, runId), supervisor);
	const loadedRun = await readRunRecord(cwd, runId);
	const loadedSupervisor = JSON.parse(
		readFileSync(supervisorPath(cwd, runId), "utf8"),
	);
	return { loadedRun, loadedSupervisor };
}

export {
	ARTIFACT_OUTPUT_RETRIES_ENV,
	CACHE_SHAPE_METRICS_ENV,
	DYNAMIC_WEB_SEARCH_BUDGET,
	EXPERIMENTAL_CACHE_STABLE_FOREACH_ENV,
	EXPERIMENTAL_DEPTH_ROUTER_ENV,
	EXPERIMENTAL_LAUNCH_RAMP_ENV,
	EXPERIMENTAL_SAME_SESSION_REPAIR_ENV,
	EXPERIMENTAL_TOOL_DEDUP_ENV,
	PACKAGE_VERIFICATION_STATUS_VALUES,
	PARTIAL_ITEM_A_SECTION,
	PARTIAL_SLOT_A_SECTION,
	TRANSIENT_MODEL_FAILURE_RETRIES_ENV,
	UNFINISHED_NOTICE_TEST_SUMMARY,
	UNIT_TEST_HOME,
	WORKFLOW_DYNAMIC_TOOL,
	WORKFLOW_LIST_TOOL,
	WORKFLOW_RUN_TOOL,
	WORKFLOW_RUN_TYPE,
	WorkflowValidationError,
	WorkflowView,
	acquireSupervisorLease,
	appendDynamicEvent,
	artifactGraphWorkflowSpec,
	assembleDynamicStateIndex,
	assert,
	assertDynamicDecisionRejects,
	assertFirstTransientModelRetry,
	assertIssue,
	assertPermanentModelFailure,
	assertThrowsFlow,
	assertValidDynamicDecision,
	assertWorkflowActionAllowedForRole,
	assertWorkflowToolAllowedForRole,
	buildDynamicGeneratedCompiledTask,
	buildDynamicGeneratedTaskWithTools,
	buildForeachGeneratedTasks,
	buildRunSourceContext,
	buildSourceContextPacket,
	buildWorkflowArtifactExtensionWrapper,
	buildWorkflowOutputRetryInstructions,
	buildWorkflowRunMetrics,
	bundledArtifactGraphSpecPaths,
	canStageProceedAfterPreviousFailure,
	canonicalDynamicDecision,
	canonicalPackageVerificationStatus,
	captureParentSubagentEnv,
	captureSubagentPrompts,
	checkRequiredArtifactReads,
	cleanupSubagentRun,
	closeSync,
	compactStrings,
	compileWorkflow,
	completeTask,
	createDynamicControllerRun,
	createFailFastPolicyRun,
	createLoopRun,
	createPendingSingleTaskRun,
	createRunRecord,
	createRunningPartialProducerRun,
	createServer,
	createWorkflowRunRecord,
	createWorkflowWebSource,
	createWorkflowWebVisibleBudget,
	dagContainerRuntimeSpec,
	degradationWorkflowSpec,
	deliverMissedWorkflowFeedback,
	dependenciesReady,
	deriveRunStatus,
	deriveWorkflowStatus,
	diagnoseWorkflowRunHealth,
	diagnoseWorkflowTaskHealth,
	dirname,
	dispatchedCalls,
	dynamicEventsPath,
	dynamicLoopAliasDriftRawDecision,
	dynamicLoopConfig,
	dynamicLoopInvalidDecision,
	dynamicLoopPersistedDecision,
	dynamicLoopSignature,
	dynamicLoopValidWorkDecision,
	dynamicOutputProfileValues,
	dynamicStatePath,
	enabledWorkflowExperimentalSpeedFlags,
	evaluateLoopUntilCondition,
	eventually,
	existsSync,
	extractDynamicStateArtifact,
	fileURLToPath,
	findWorkflowWebSourceByUrl,
	firstTransientModelFailureAttemptPath,
	flattenArtifactGraphStages,
	flushPendingIndexUpdatesForTests,
	formatArtifactGraphSourceContext,
	formatRun,
	formatStatus,
	getWorkflowProcessRole,
	handleWorkflowArtifactToolCall,
	hashDynamicRequest,
	heartbeatSupervisorLease,
	isBundledPiWebAccessExtension,
	isPackageNonVerifiedTerminalStatus,
	isPackageVerificationBlockedStatus,
	isPackageVerifiedStatus,
	isTestWideCodePoint,
	isWorkflowSupervisorEnabled,
	join,
	launchSubagentTask,
	listWorkflowArtifactSources,
	listWorkflows,
	loadAgentByName,
	loadWorkflow,
	loadWorkflowHelper,
	loadWorkflowSourceManifest,
	loadWorkflowSpec,
	loopWorkflowSpec,
	makeDynamicDecisionLoopCtx,
	makeProject,
	makeSubagentLaunchFixture,
	makeValidatingDynamicDecisionLoopCtx,
	markDagDependentsSkipped,
	mkdirSync,
	mkdtempSync,
	nodeRmSync,
	normalizeArtifactGraphStage,
	normalizeArtifactGraphStages,
	notifyUnfinishedRuns,
	observeLiveModelWorkerCompletion,
	openSync,
	packageVerificationStatusBucket,
	parentSubagentEnvKeys,
	parseAgentMarkdown,
	parsePublicWorkflow,
	parseWorkflow,
	parseWorkflowDynamicArgs,
	parseWorkflowOutput,
	parseWorkflowOutputForBundle,
	parseWorkflowPartialOutput,
	parseWorkflowRunArgs,
	pathToFileURL,
	perItemDispatchStreamingSpec,
	plannerCalls,
	prepareDagTask,
	readDynamicEvents,
	readFileSync,
	readOrRebuildDynamicState,
	readRunRecord,
	readSimpleJsonPath,
	readWorkflowArtifactReadLedger,
	readWorkflowIndexFile,
	readWorkflowWebSource,
	readWorkflowWebSourceIndex,
	readWorkflowWebSourceSnippet,
	readdirSync,
	rebuildDynamicState,
	recordDynamicControllerPhase,
	recordSharedModelRateLimitBackoffForTests,
	refreshRunFromSubagentArtifacts,
	refreshZeroOutputModelFailure,
	registerWorkflowArtifactTool,
	registerWorkflowFetchCacheExtension,
	registerWorkflowNaturalLanguageTools,
	registerWorkflowWebSourceExtension,
	resetTaskForResume,
	resolveFlowsCwd,
	resolveLaunchControlTelemetryForTests,
	resolveWorkflowHelperRef,
	resolveWorkflowRetryLimit,
	resolveWorkflowRef,
	resolveWorkflowRuntime,
	restoreParentSubagentEnv,
	resumeRun,
	rmSync,
	runDynamicControllerEngineIntegrityCheckForTests,
	runDynamicDecisionLoop,
	runDynamicTask,
	runWorkflow,
	runWorkflowSpec,
	sanitizeUrlForModel,
	scheduleRun,
	setIndexUpdateDebounceMsForTests,
	setParentSubagentEnv,
	setRunLeaseTestHooksForTests,
	setSubagentApiForTests,
	setSubagentLaunchControlsForTests,
	setTaskTerminal,
	setWorkflowOutputArtifactWriteHookForTests,
	shouldScheduleAfterStageFailure,
	sleep,
	spawnSync,
	stallFormatterFixture,
	stallProgressRun,
	stallProgressTask,
	stopRun,
	summarizeTaskFailureClasses,
	summarizeTasks,
	summarizeWorkflowTelemetry,
	supervisorLeasePath,
	supervisorLockPath,
	supervisorPath,
	supportOutputAnalysis,
	symlinkSync,
	taskBySpec,
	taskByStage,
	test,
	testVisibleWidth,
	tmpdir,
	unlinkSync,
	updateIndex,
	utimesSync,
	validateDynamicDecision,
	validateJsonSchema,
	validateStructuredContract,
	validateWorkflowWebUrl,
	waitForRun,
	watchRun,
	withAdaptiveLiveWorkerEnv,
	withRunLease,
	workflowArgumentCompletions,
	workflowArtifactJsonPayload,
	workflowExperimentalFlagEnabled,
	workflowExtension,
	workflowOutputRawWithRefs,
	workflowProcessRoleForTests,
	workflowSpec,
	workflowSupervisorOwnerIdForTests,
	workflowViewFixture,
	workflowViewRun,
	workflowViewSummary,
	workflowViewTask,
	workflowViewText,
	workflowWorkerEnvPrefix,
	writeAgent,
	writeDefaultStageControlSchema,
	writeDynamicDecisionArtifacts,
	writeDynamicStateIndexArtifacts,
	writeFileSync,
	writeJsonAtomic,
	writeRunRecord,
	writeStaticRunArtifacts,
	writeSupervisorLock,
	writeUnfinishedNoticeIndex,
	writeUnfinishedNoticeIndexRun,
	writeUnfinishedNoticeRunRecord,
	writeWorkflowArtifactExtensionWrapper,
	writeWorkflowTaskArtifactBundle,
	writeWorkflowWebSource,
};
