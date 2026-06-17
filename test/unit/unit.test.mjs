import assert from "node:assert/strict";
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

import { parseAgentMarkdown } from "../../.tmp/unit/agents.js";
import { compileWorkflow } from "../../.tmp/unit/compiler.js";
import {
	buildRunSourceContext,
	evaluateLoopUntilCondition,
	formatRun,
	resumeRun,
	runWorkflow,
	scheduleRun,
	waitForRun,
} from "../../.tmp/unit/engine.js";
import {
	notifyUnfinishedRuns,
	workflowArgumentCompletions,
	parseWorkflowRunArgs,
} from "../../.tmp/unit/extension.js";
import {
	listWorkflows,
	resolveWorkflowRef,
} from "../../.tmp/unit/workflow-specs.js";
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
	resolveFlowsCwd,
	setTaskTerminal,
	supervisorLeasePath,
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
import {
	loadWorkflowHelper,
	resolveWorkflowHelperRef,
} from "../../.tmp/unit/workflow-helpers.js";
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
import { validateJsonSchema } from "../../.tmp/unit/json-schema.js";
import {
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
		stages: [{ id: "main", type: "task", prompt: "Do the work." }],
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
					type: "task",
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
							type: "task",
							prompt: "Implement the requested fix.",
						},
						{
							id: "check",
							type: "task",
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
					type: "task",
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
							type: "task",
							output: { format: "json" },
							prompt: "Scan.",
						},
						{
							id: "review",
							type: "task",
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

test("public schemaVersion 1 parser accepts artifact graph and rejects non-artifactGraph top-level shapes", () => {
	const parsed = parsePublicWorkflow(
		artifactGraphWorkflowSpec({
			name: "impact-artifact",
			artifactGraph: {
				stages: [
					{
						id: "risk",
						type: "task",
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
			artifactGraph: { stages: [{ id: "main", type: "task", prompt: "Do." }] },
			unsupported: true,
		}),
	);
	assertIssue(invalidTopLevel, "$.unsupported", "unknown field");
});

test("artifact graph schema validates sourcePolicy maxItems and schema refs", () => {
	const invalidPolicy = assertThrowsFlow(() =>
		parsePublicWorkflow(
			artifactGraphWorkflowSpec({
				artifactGraph: {
					stages: [
						{
							id: "main",
							type: "task",
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
							type: "task",
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
							type: "task",
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
		"must not contain ..",
	);
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
								type: "task",
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
								type: "task",
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
							type: "task",
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
		"must be one of: task, reduce, foreach, loop, dag",
	);

	const supportOnTask = assertThrowsFlow(() =>
		parsePublicWorkflow(
			artifactGraphWorkflowSpec({
				artifactGraph: {
					stages: [
						{
							id: "audit",
							type: "task",
							prompt: "Audit.",
							support: { uses: "./helpers/audit.mjs" },
						},
					],
				},
			}),
		),
	);
	assertIssue(
		supportOnTask,
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
						{ id: "scan", type: "task", prompt: "Scan." },
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
								{ id: "scan", type: "task", prompt: "Scan." },
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
							stages: [{ id: "final", type: "task", prompt: "Final." }],
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
					stages: [{ id: "bad/id", type: "task", prompt: "Bad." }],
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

test("schema and compiler accept partial sourcePolicy on foreach", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "extract",
						type: "task",
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
						type: "task",
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
						type: "task",
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
							type: "task",
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
		type: "task",
		sourceStageIds: [],
		sourcePolicy: "require-success",
	};
	assert.equal(
		canStageProceedAfterPreviousFailure(
			{
				id: "next",
				type: "task",
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

test("compiler injects runtime task for task stages only", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const compiled = await compileWorkflow(
			workflowSpec("unit-scout", {
				roles: { lens: { prompt: "Role context marker." } },
				artifactGraph: {
					stages: [
						{ id: "entry", type: "task", prompt: "Entry instructions." },
						{
							id: "entry-extra",
							type: "task",
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
							type: "task",
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
						{ id: "extract", type: "task", prompt: "Extract" },
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
						{ id: "plan", type: "task", prompt: "Plan" },
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
						{ id: "sourceOne", type: "task", prompt: "Source one." },
						{ id: "sourceTwo", type: "task", after: [], prompt: "Source two." },
						{ id: "gate", type: "task", prompt: "Gate." },
						{
							id: "mixed",
							type: "task",
							from: ["sourceOne", "sourceTwo"],
							after: "gate",
							prompt: "Mixed.",
						},
						{
							id: "fromOnly",
							type: "task",
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
						{ id: "a", type: "task", prompt: "A." },
						{ id: "b", type: "task", after: [], prompt: "B." },
						{ id: "c", type: "task", from: ["a", "b"], prompt: "C." },
						{ id: "d", type: "task", prompt: "D." },
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
						{ id: "seedOne", type: "task", prompt: "Seed one." },
						{ id: "seedTwo", type: "task", after: [], prompt: "Seed two." },
						{ id: "gate", type: "task", prompt: "Gate." },
						{
							id: "box",
							type: "dag",
							from: ["seedOne", "seedTwo"],
							after: "gate",
							outputFrom: "d",
							stages: [
								{ id: "a", type: "task", prompt: "A." },
								{ id: "b", type: "task", after: "a", prompt: "B." },
								{ id: "c", type: "task", after: "a", prompt: "C." },
								{
									id: "d",
									type: "reduce",
									from: "b",
									after: "c",
									prompt: "D.",
								},
							],
						},
						{ id: "implicit", type: "task", prompt: "Implicit." },
						{ id: "down", type: "task", from: "box", prompt: "Down." },
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
									type: "task",
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
								{ id: "root", type: "task", prompt: "Root." },
								{
									id: "inner",
									type: "dag",
									from: "root",
									stages: [{ id: "leaf", type: "task", prompt: "Leaf." }],
								},
							],
						},
						{ id: "next", type: "task", from: "outer", prompt: "Next." },
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
								{ id: "implement", type: "task", prompt: "Implement." },
								{ id: "check", type: "task", prompt: "Check." },
							],
							maxRounds: 1,
							until: { stage: "check", path: "$.status", equals: "pass" },
						},
						{
							id: "boxcar",
							type: "dag",
							stages: [
								{ id: "r01", type: "task", prompt: "Looks loop-like." },
								{ id: "done", type: "task", from: "r01", prompt: "Done." },
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
							type: "task",
							tools: ["scrapling_fetch"],
							prompt: "Inherit metadata.",
						},
						{
							id: "override",
							type: "task",
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

test("artifactGraph runtime foreach materializes source array into generated tasks", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const spec = workflowSpec("unit-scout", {
			artifactGraph: {
				stages: [
					{
						id: "extract",
						type: "task",
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
								type: "task",
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
						type: "task",
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
						type: "task",
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
					{ id: "after", type: "task", prompt: "After loop." },
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
					{ id: "one", type: "task", prompt: "One." },
					{ id: "two", type: "task", prompt: "Two." },
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
			["extract-spec", "map-implementation", "inspect-tests", "candidate-findings"],
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
					stages: [{ id: "main", type: "task", prompt: "Do it." }],
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
		const reviewers = compiled.tasks.find((task) => task.key === "reviewers.item");
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
		await completeTask(
			cwd,
			taskBySpec(run, "map-implementation.main"),
			{
				implementationMap: [],
			},
		);
		await completeTask(cwd, taskBySpec(run, "inspect-tests.main"), {
			testMap: [],
		});
		await completeTask(
			cwd,
			taskBySpec(run, "candidate-findings.main"),
			{
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
			},
		);
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
				outputRetry: { attempts: 1 },
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
	assert.equal(summary.retryCounts.output, 1);
	assert.equal(summary.retryCounts.launch, 1);
	assert.equal(summary.outputBytes, 30);
	assert.equal(summary.stages.verify.taskCount, 2);
	assert.equal(summary.stages.verify.durationMs, 35000);
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
							{ id: "main", type: "task", fast: "on", prompt: "Do it." },
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
						type: "task",
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
						{ id: "verify", type: "task", prompt: "Verify." },
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
				],
			},
		},
		options: {
			downgradeExactQuantitativeWithoutSource: true,
			requireFetchedEvidenceForVerified: true,
		},
		context: {},
	});

	assert.equal(result.gateSummary.total, 2);
	assert.equal(result.gateSummary.downgraded, 1);
	assert.equal(result.auditedClaims[0].status, "partially_supported");
	assert.equal(result.auditedClaims[0].evidenceGate.previous, "verified");
	assert.equal(result.auditedClaims[1].status, "verified");
	assert.deepEqual(result.auditedClaims[1].sourceUrls, [
		"https://example.com/release",
	]);
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
			"export default async function helper({ sources, options, context }) { return { audited: sources.extract.claims.length, strict: options.strict, stageId: context.stageId }; }\n",
		);
		const spec = workflowSpec("unit-scout", {
			artifactGraph: {
				stages: [
					{
						id: "extract",
						type: "task",
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
		assert.deepEqual(
			JSON.parse(
				readFileSync(
					join(dirname(join(cwd, support.files.result)), "control.json"),
					"utf8",
				),
			),
			{
				schema: "stage-control-v1",
				digest: "Support helper completed.",
				audited: 2,
				strict: true,
				stageId: "audit",
			},
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
						type: "task",
						prompt: "Extract OK",
					},
					{
						id: "extractFailed",
						type: "task",
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
						type: "task",
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
					{ id: "a", type: "task", prompt: "A." },
					{ id: "b", type: "task", after: [], prompt: "B." },
					{ id: "c", type: "task", from: ["a", "b"], prompt: "C." },
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
						type: "task",
						output: { format: "json" },
						prompt: "Source.",
					},
					{
						id: "gate",
						type: "task",
						output: { format: "json" },
						prompt: "Gate.",
					},
					{
						id: "afterOnly",
						type: "task",
						after: "gate",
						prompt: "After only.",
					},
					{
						id: "mixed",
						type: "task",
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
						type: "task",
						output: { format: "json" },
						prompt: "A.",
					},
					{
						id: "b",
						type: "task",
						from: "a",
						output: { format: "json" },
						prompt: "B.",
					},
					{
						id: "c",
						type: "task",
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
				stages: [{ id: "main", type: "task", prompt: "Do work." }],
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
					{ id: "main", type: "task", prompt: "Research with web tools." },
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

		assert.equal(captured.extensions[0], "npm:pi-web-access");
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
				stages: [{ id: "main", type: "task", prompt: "Research with fetch." }],
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

		assert(captured.extensions.includes("npm:pi-web-access"));
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

test("subagent launch merges object-form provider extensions with built-in mappings", async () => {
	const cwd = makeProject();
	let captured;
	try {
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
					extensions: ["npm:pi-web-access", "packages/pi-scrapling-access"],
					classification: "read-only",
				},
			],
			artifactGraph: {
				stages: [
					{
						id: "main",
						type: "task",
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
		assert(captured.extensions.includes("npm:pi-web-access"));
		assert(captured.extensions.includes("packages/pi-scrapling-access"));
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
							type: "task",
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

test("refresh adopts handle-less running subagent from deterministic runsDir", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const compiled = await compileWorkflow(
			workflowSpec("unit-scout", {
				artifactGraph: {
					stages: [{ id: "main", type: "task", prompt: "Do work." }],
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
			JSON.stringify({ type: "object" }),
		);
		writeFileSync(
			join(workflowDir, "helpers", "audit.mjs"),
			"export default () => ({ ok: true });\n",
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
		assert.equal(
			readFileSync(
				join(bundleDir, "schemas", "audit-control.schema.json"),
				"utf8",
			),
			JSON.stringify({ type: "object" }),
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
						type: "task",
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
				stages: [{ id: "only", type: "task", prompt: "Do it." }],
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
			/failed or interrupted/,
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
	assert.equal(partition.reportContext.keep[0].findingId, partition.partitions.keep[0].findingId);
	// Severity joined from the reviewer finding, not the devil-advocate echo.
	assert.equal(partition.partitions.keep[0].severity, "critical");
	// Unrecognized verdict routes to needsHuman, not silence.
	assert.equal(partition.partitionSummary.needsHuman, 1);
	assert.ok(
		partition.normalizationNotes.some((n) =>
			n.includes("unrecognized verdict"),
		),
	);

	const supportDemotion = await helper({
		sources: {
			"dedup-findings.main": {
				findings: [
					{
						severity: "medium",
						title: "Dropping colon parser loses file:line locations",
						file: "workflows/deep-review/helpers/finding-pipeline.mjs",
						evidence:
							"removing :801 parsing loses line pins; tests mention the path but the runtime behavior is the defect",
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
						evidenceQuotes: ["-\t\"scrapling_fetch\","],
					},
					{
						severity: "medium",
						title:
							"Missing targeted unit coverage for scrapling_fetch after removing its built-in safety classification",
						file: "test/unit/unit.test.mjs",
						evidence: "test coverage gap for scrapling_fetch",
						evidenceQuotes: ["tools: [\"read\", \"custom_external_tool\"]"],
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
					},
					{
						severity: "high",
						title: "unrelated scheduler status regression",
						file: "src/engine.ts",
						locations: [{ file: "src/engine.ts", line: 820 }],
						evidence: "blocked status is overwritten later",
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
						evidenceQuotes: ["return pattern.test(hostname)", "diff drops the $ anchor"],
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
		readFileSync(join(schemaDir, "deep-review-dedup-control.schema.json"), "utf8"),
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
						},
						{
							id: "claim-002",
							claim: "Costs 5 usd per 1M tokens",
							factSlotIds: ["slot-002"],
						},
						{
							id: "claim-003",
							claim: "Local docs claim",
							factSlotIds: ["slot-001"],
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
	// Identity rejoined from the normalizer, not the verifier echo.
	assert.equal(out.auditedClaims[0].claim, "Original claim text");
	assert.equal(out.gateSummary.identityRejoined, 1);
	// Planned slot dropped by the normalizer is surfaced as a gap.
	assert.deepEqual(out.slotCoverageCheck.droppedSlotIds, ["slot-003"]);
	assert.ok(out.remainingGaps.some((g) => g.slotId === "slot-003"));
	// Compact digest exists for source-context budgeting.
	assert.equal(out.claimDigests.length, 3);
	assert.ok(!("evidence" in out.claimDigests[0]));
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
								type: "task",
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
					const ledgerPath = join(
						cwd,
						".pi",
						"workflows",
						workflowRunId,
						"tasks",
						taskId,
						"read-ledger.jsonl",
					);
					mkdirSync(dirname(ledgerPath), { recursive: true });
					writeFileSync(
						ledgerPath,
						`${JSON.stringify({
							schema: "workflow-artifact-read-v1",
							runId: workflowRunId,
							taskId,
							source: "analyze",
							artifact: "analysis",
							at: new Date().toISOString(),
							bytes: 10,
							returnedBytes: 10,
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
		assert.ok(
			readFileSync(join(finalDir, "task.md"), "utf8").includes(
				"Required reads before final output",
			),
		);
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
		readFileSync(join(schemaDir, "deep-review-report-control.schema.json"), "utf8"),
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
