import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { awaitWithinWorkflowWaitBoundary } from "../../.tmp/unit/engine.js";
import { acquireRunFileLease } from "../../.tmp/unit/store.js";
import {
	deliverWorkflowFeedback,
	WORKFLOW_DYNAMIC_TOOL,
	WORKFLOW_RUN_TOOL,
	WORKFLOW_WAIT_TOOL,
	registerWorkflowNaturalLanguageTools,
	registerWorkflowWaitTool,
} from "../../.tmp/unit/extension.js";
import { summarizeWorkflowTerminal } from "../../.tmp/unit/workflow-terminal.js";

function fakePi(tools) {
	return {
		registerTool(tool) {
			tools.push(tool);
		},
	};
}

function runRecord(cwd, overrides = {}) {
	const runId = overrides.runId ?? "workflow_wait_fixture";
	return {
		schemaVersion: 1,
		runId,
		name: "wait-fixture",
		type: "artifact-graph",
		status: "completed",
		taskSummary: {
			total: 1,
			pending: 0,
			running: 0,
			blocked: 0,
			completed: 1,
			failed: 0,
			skipped: 0,
			interrupted: 0,
		},
		cwd,
		backend: { type: "local-pi", mode: "headless" },
		createdAt: "2026-07-25T00:00:00.000Z",
		updatedAt: "2026-07-25T00:00:01.000Z",
		specPath: ".pi/workflows/spec.json",
		tasks: [
			{
				taskId: "task-1",
				specId: "final",
				status: "completed",
				statusDetail: "completed",
				runtime: { model: "test-model", thinking: "none" },
				files: {
					systemPrompt: `.pi/workflows/${runId}/tasks/task-1/system.md`,
					taskPrompt: `.pi/workflows/${runId}/tasks/task-1/task.md`,
					output: `.pi/workflows/${runId}/tasks/task-1/output.log`,
					stderr: `.pi/workflows/${runId}/tasks/task-1/stderr.log`,
					result: `.pi/workflows/${runId}/tasks/task-1/result.json`,
				},
			},
		],
		...overrides,
	};
}

function taskRecord(runId, taskId, specId, overrides = {}) {
	return {
		taskId,
		specId,
		status: "completed",
		statusDetail: "completed",
		runtime: { model: "test-model", thinking: "none" },
		files: {
			systemPrompt: `.pi/workflows/${runId}/tasks/${taskId}/system.md`,
			taskPrompt: `.pi/workflows/${runId}/tasks/${taskId}/task.md`,
			output: `.pi/workflows/${runId}/tasks/${taskId}/output.log`,
			stderr: `.pi/workflows/${runId}/tasks/${taskId}/stderr.log`,
			result: `.pi/workflows/${runId}/tasks/${taskId}/result.json`,
		},
		...overrides,
	};
}

async function writeDynamicControl(cwd, run, control) {
	const path = join(cwd, dirname(run.tasks[0].files.output), "control.json");
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(control, null, 2)}\n`);
}

async function writeRunFixture(cwd, run, control = {}) {
	const runPath = join(cwd, ".pi", "workflows", run.runId, "run.json");
	await mkdir(dirname(runPath), { recursive: true });
	await writeFile(runPath, `${JSON.stringify(run, null, 2)}\n`);
	await writeDynamicControl(cwd, run, control);
}

test("workflow wait boundary enforces timeout and cancellation without owning the operation", async () => {
	const never = new Promise(() => {});
	const startedAt = Date.now();
	await assert.rejects(
		awaitWithinWorkflowWaitBoundary(never, 25, undefined, "wait timeout sentinel"),
		/wait timeout sentinel/,
	);
	assert.ok(Date.now() - startedAt < 250);

	const controller = new AbortController();
	const aborted = awaitWithinWorkflowWaitBoundary(
		never,
		5_000,
		controller.signal,
		"must not time out",
	);
	controller.abort(new Error("wait cancellation sentinel"));
	await assert.rejects(aborted, /wait cancellation sentinel/);
});

test("durable wait ownership suppresses completion feedback in another delivery path", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "workflow-wait-ownership-"));
	try {
		const run = runRecord(cwd, { runId: "workflow_wait_owned" });
		await writeRunFixture(cwd, run, {
			executiveMarkdown: "Owned terminal result.",
		});
		await writeFile(
			join(cwd, ".pi", "workflows", run.runId, "feedback-audience.json"),
			`${JSON.stringify({
				schema: "workflow-feedback-audience-v1",
				runId: run.runId,
				sessionId: "session-owned-wait",
			})}\n`,
		);
		const presentationLease = await acquireRunFileLease(
			cwd,
			run.runId,
			"feedback-presentation",
		);
		assert.ok(presentationLease);
		let sends = 0;
		await deliverWorkflowFeedback(
			{
				cwd,
				hasUI: true,
				sessionManager: { getSessionId: () => "session-owned-wait" },
				ui: { notify: () => undefined },
			},
			{ sendMessage: () => (sends += 1) },
			run,
		);
		assert.equal(sends, 0);
		await presentationLease.release();
		await assert.rejects(
			readFile(
				join(cwd, ".pi", "workflows", run.runId, "feedback-delivery.json"),
				"utf8",
			),
			(error) => error?.code === "ENOENT",
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("workflow wait does not re-present a completion won by the watcher", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "workflow-watcher-wins-"));
	try {
		const run = runRecord(cwd, { runId: "workflow_watcher_wins" });
		await writeRunFixture(cwd, run, {
			executiveMarkdown: "Watcher-owned terminal result.",
		});
		await writeFile(
			join(cwd, ".pi", "workflows", run.runId, "feedback-audience.json"),
			`${JSON.stringify({
				schema: "workflow-feedback-audience-v1",
				runId: run.runId,
				sessionId: "session-watcher-wins",
			})}\n`,
		);
		let sends = 0;
		const ctx = {
			cwd,
			hasUI: true,
			sessionManager: { getSessionId: () => "session-watcher-wins" },
			ui: { confirm: async () => false, notify: () => undefined },
		};
		await deliverWorkflowFeedback(
			ctx,
			{ sendMessage: () => (sends += 1) },
			run,
		);
		assert.equal(sends, 1);

		const tools = [];
		registerWorkflowWaitTool(fakePi(tools), {
			PI_WORKFLOW_ROLE: "supervisor",
		});
		const result = await tools[0].execute(
			"call-after-watcher",
			{ runId: run.runId, timeoutMs: 60_000 },
			new AbortController().signal,
			undefined,
			ctx,
		);
		assert.equal(result.details.deliveryAlreadyCompleted, true);
		assert.equal(result.details.finalResultPreview, undefined);
		assert.match(result.content[0].text, /completion already delivered/);
		assert.doesNotMatch(result.content[0].text, /Watcher-owned terminal result/);
		assert.equal(sends, 1);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("workflow wait tool registers with bounded wait guidance", () => {
	const tools = [];
	registerWorkflowWaitTool(fakePi(tools), {
		PI_WORKFLOW_ROLE: "supervisor",
	});
	assert.equal(tools.length, 1);
	assert.equal(tools[0].name, WORKFLOW_WAIT_TOOL);
	assert.match(tools[0].promptGuidelines.join("\n"), /Do not repeatedly read run\.json/);
	assert.deepEqual(tools[0].parameters.required, ["runId"]);
	assert.equal(tools[0].parameters.properties.timeoutMs.maximum, 14_400_000);
});

test("workflow wait returns a terminal result without model polling", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "workflow-wait-tool-"));
	try {
		const run = runRecord(cwd);
		await writeRunFixture(cwd, run, {
			executiveMarkdown: "Completed result from the workflow.",
		});
		await writeFile(
			join(cwd, ".pi", "workflows", run.runId, "feedback-audience.json"),
			`${JSON.stringify({
				schema: "workflow-feedback-audience-v1",
				runId: run.runId,
				sessionId: "session-wait-test",
			})}\n`,
		);
		const tools = [];
		registerWorkflowWaitTool(fakePi(tools), {
			PI_WORKFLOW_ROLE: "supervisor",
		});
		const updates = [];
		const result = await tools[0].execute(
			"call-wait",
			{ runId: run.runId, timeoutMs: 60_000 },
			new AbortController().signal,
			(update) => updates.push(update),
			{
				cwd,
				hasUI: false,
				sessionManager: { getSessionId: () => "session-wait-test" },
				ui: { confirm: async () => false },
			},
		);
		assert.equal(result.details.status, "completed");
		assert.equal(result.details.semanticStatus, "completed");
		assert.match(result.details.finalResultPreview, /Completed result/);
		assert.match(result.content[0].text, /Workflow terminal/);
		assert.equal(updates.length, 1);
		assert.equal(updates[0].details.taskSummary.completed, 1);
		const delivery = JSON.parse(
			await readFile(
				join(cwd, ".pi", "workflows", run.runId, "feedback-delivery.json"),
				"utf8",
			),
		);
		assert.equal(typeof delivery.delivered.completed, "string");
		await assert.rejects(
			readFile(
				join(
					cwd,
					".pi",
					"workflows",
					run.runId,
					"feedback-delivery.completed.lock",
				),
				"utf8",
			),
			(error) => error?.code === "ENOENT",
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("workflow wait reports blocked action-required state without a final preview", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "workflow-wait-blocked-"));
	try {
		const base = runRecord(cwd, { runId: "workflow_wait_blocked" });
		const run = {
			...base,
			status: "blocked",
			taskSummary: {
				...base.taskSummary,
				completed: 0,
				blocked: 1,
			},
			tasks: [
				{
					...base.tasks[0],
					status: "blocked",
					statusDetail: "approval_required",
					lastMessage: "Approval is required.",
				},
			],
		};
		await writeRunFixture(cwd, run, {
			executiveMarkdown: "Intermediate text must not become a final result.",
		});
		const tools = [];
		registerWorkflowWaitTool(fakePi(tools), {
			PI_WORKFLOW_ROLE: "supervisor",
		});
		const result = await tools[0].execute(
			"call-blocked",
			{ runId: run.runId, timeoutMs: 60_000 },
			new AbortController().signal,
			undefined,
			{ cwd, hasUI: false, ui: { confirm: async () => false } },
		);
		assert.equal(result.details.terminal, false);
		assert.equal(result.details.actionRequired, true);
		assert.equal(result.details.finalResultPreview, undefined);
		assert.deepEqual(result.details.blockedTaskIds, ["final"]);
		assert.match(result.content[0].text, /Workflow blocked; action required/);
		assert.doesNotMatch(result.content[0].text, /Intermediate text/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("workflow wait previews the declared dynamic output instead of the last completed task", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "workflow-wait-output-"));
	try {
		const runId = "workflow_wait_authoritative_output";
		const run = runRecord(cwd, {
			runId,
			provenance: { mode: "direct-dynamic" },
			taskSummary: {
				total: 3,
				pending: 0,
				running: 0,
				blocked: 0,
				completed: 3,
				failed: 0,
				skipped: 0,
				interrupted: 0,
			},
			tasks: [
				taskRecord(runId, "task-1", "dynamic.controller", {
					kind: "dynamic",
					statusDetail: "dynamic_completed",
				}),
				taskRecord(runId, "task-2", "dynamic.synthesis-final"),
				taskRecord(runId, "task-3", "dynamic.intermediate-tail"),
			],
		});
		await writeRunFixture(cwd, run, {
			schema: "dynamic-controller-result-v1",
			status: "synthesized",
			outputTasks: ["dynamic.synthesis-final"],
		});
		await writeDynamicControl(
			cwd,
			{ tasks: [run.tasks[1]] },
			{ executiveMarkdown: "Authoritative synthesized answer." },
		);
		await writeDynamicControl(
			cwd,
			{ tasks: [run.tasks[2]] },
			{ executiveMarkdown: "Misleading later intermediate output." },
		);
		const tools = [];
		registerWorkflowWaitTool(fakePi(tools), {
			PI_WORKFLOW_ROLE: "supervisor",
		});
		const result = await tools[0].execute(
			"call-output",
			{ runId, timeoutMs: 60_000 },
			new AbortController().signal,
			undefined,
			{ cwd, hasUI: false, ui: { confirm: async () => false } },
		);
		assert.deepEqual(result.details.outputTaskIds, [
			"dynamic.synthesis-final",
		]);
		assert.match(result.details.finalResultPreview, /Authoritative synthesized/);
		assert.doesNotMatch(
			result.details.finalResultPreview,
			/Misleading later intermediate/,
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("workflow wait never falls back to an upstream artifact when the final task failed", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "workflow-wait-failed-final-"));
	try {
		const runId = "workflow_wait_failed_final";
		const run = runRecord(cwd, {
			runId,
			status: "failed",
			taskSummary: {
				total: 2,
				pending: 0,
				running: 0,
				blocked: 0,
				completed: 1,
				failed: 1,
				skipped: 0,
				interrupted: 0,
			},
			tasks: [
				taskRecord(runId, "task-1", "research"),
				taskRecord(runId, "task-2", "final", {
					status: "failed",
					statusDetail: "workflow_output_invalid_exhausted",
					dependsOn: ["research"],
				}),
			],
		});
		await writeRunFixture(cwd, run);
		await writeDynamicControl(
			cwd,
			{ tasks: [run.tasks[0]] },
			{ executiveMarkdown: "Upstream output is not the final answer." },
		);
		const tools = [];
		registerWorkflowWaitTool(fakePi(tools), {
			PI_WORKFLOW_ROLE: "supervisor",
		});
		const result = await tools[0].execute(
			"call-failed-final",
			{ runId, timeoutMs: 60_000 },
			new AbortController().signal,
			undefined,
			{ cwd, hasUI: false, ui: { confirm: async () => false } },
		);
		assert.equal(result.details.terminal, true);
		assert.deepEqual(result.details.outputTaskIds, ["final"]);
		assert.equal(result.details.finalResultPreview, undefined);
		assert.doesNotMatch(result.content[0].text, /Upstream output/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("cancelling workflow wait does not mutate the workflow", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "workflow-wait-cancel-"));
	try {
		const run = runRecord(cwd, { runId: "workflow_wait_cancelled" });
		await writeRunFixture(cwd, run);
		const tools = [];
		registerWorkflowWaitTool(fakePi(tools), {
			PI_WORKFLOW_ROLE: "supervisor",
		});
		const controller = new AbortController();
		controller.abort(new Error("cancel test wait"));
		await assert.rejects(
			tools[0].execute(
				"call-cancelled",
				{ runId: run.runId, timeoutMs: 60_000 },
				controller.signal,
				undefined,
				{ cwd, hasUI: false, ui: { confirm: async () => false } },
			),
			/cancel test wait/,
		);
		const persisted = JSON.parse(
			await readFile(
				join(cwd, ".pi", "workflows", run.runId, "run.json"),
				"utf8",
			),
		);
		assert.equal(persisted.status, "completed");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("workflow launch tools expose and enforce terminal wait options", async () => {
	const tools = [];
	registerWorkflowNaturalLanguageTools(fakePi(tools), {
		PI_WORKFLOW_ROLE: "supervisor",
	});
	const runTool = tools.find((tool) => tool.name === WORKFLOW_RUN_TOOL);
	const dynamicTool = tools.find((tool) => tool.name === WORKFLOW_DYNAMIC_TOOL);
	for (const tool of [runTool, dynamicTool]) {
		assert.equal(tool.parameters.properties.awaitTerminal.type, "boolean");
		assert.equal(tool.parameters.properties.timeoutMs.minimum, 1_000);
		assert.match(tool.promptGuidelines.join("\n"), /awaitTerminal=true/);
	}
	const signal = new AbortController().signal;
	await assert.rejects(
		runTool.execute(
			"call-1",
			{
				workflow: "deep-research",
				task: "Research this repository",
				detach: true,
				awaitTerminal: true,
			},
			signal,
			undefined,
			{},
		),
		/detach and awaitTerminal are mutually exclusive/,
	);
	await assert.rejects(
		dynamicTool.execute(
			"call-2",
			{ task: "Research this repository", timeoutMs: 60_000 },
			signal,
			undefined,
			{},
		),
		/timeoutMs requires awaitTerminal=true/,
	);
});

test("terminal summary distinguishes dynamic synthesis from exhausted no-output completion", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "workflow-wait-summary-"));
	try {
		const synthesized = runRecord(cwd, {
			runId: "workflow_dynamic_synthesized",
			provenance: { mode: "direct-dynamic" },
			tasks: [
				{
					...runRecord(cwd).tasks[0],
					specId: "dynamic.controller",
					statusDetail: "dynamic_completed",
					outputRetry: { attempts: 1 },
					launchRetry: { attempts: 2 },
					files: {
						...runRecord(cwd).tasks[0].files,
						output:
							".pi/workflows/workflow_dynamic_synthesized/tasks/task-1/output.log",
					},
				},
			],
		});
		await writeDynamicControl(cwd, synthesized, {
			schema: "dynamic-controller-result-v1",
			status: "synthesized",
			outputTasks: ["dynamic.synthesize-r1"],
		});
		const synthesizedSummary = await summarizeWorkflowTerminal(cwd, synthesized);
		assert.equal(synthesizedSummary.semanticStatus, "synthesized");
		assert.deepEqual(synthesizedSummary.outputTaskIds, ["dynamic.synthesize-r1"]);
		assert.equal(synthesizedSummary.outputRetryAttempts, 1);
		assert.equal(synthesizedSummary.launchRetryAttempts, 2);

		const exhausted = runRecord(cwd, {
			runId: "workflow_dynamic_exhausted",
			provenance: { mode: "direct-dynamic" },
			tasks: [
				{
					...runRecord(cwd).tasks[0],
					specId: "dynamic.controller",
					statusDetail: "dynamic_completed",
					files: {
						...runRecord(cwd).tasks[0].files,
						output:
							".pi/workflows/workflow_dynamic_exhausted/tasks/task-1/output.log",
					},
				},
			],
		});
		await writeDynamicControl(cwd, exhausted, {
			schema: "dynamic-controller-result-v1",
			status: "exhausted",
			outputTasks: [],
		});
		const exhaustedSummary = await summarizeWorkflowTerminal(cwd, exhausted);
		assert.equal(exhaustedSummary.semanticStatus, "exhausted_without_output");
		assert.equal(exhaustedSummary.engineStatus, "completed");

		const incomplete = {
			...exhausted,
			runId: "workflow_dynamic_incomplete",
			status: "failed",
			taskSummary: {
				...exhausted.taskSummary,
				completed: 0,
				failed: 1,
			},
			tasks: [
				{
					...exhausted.tasks[0],
					status: "failed",
					statusDetail: "dynamic_incomplete",
					files: {
						...exhausted.tasks[0].files,
						output:
							".pi/workflows/workflow_dynamic_incomplete/tasks/task-1/output.log",
					},
				},
			],
		};
		await writeDynamicControl(cwd, incomplete, {
			schema: "dynamic-controller-result-v1",
			status: "exhausted",
			outputTasks: [],
		});
		const incompleteSummary = await summarizeWorkflowTerminal(cwd, incomplete);
		assert.equal(incompleteSummary.engineStatus, "failed");
		assert.equal(incompleteSummary.semanticStatus, "dynamic_incomplete");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("terminal summary reports static degradation without changing engine status", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "workflow-wait-static-"));
	try {
		const run = runRecord(cwd, {
			degradation: {
				finalOutputRendered: true,
				failedTaskIds: ["task-2"],
				degradedHelperTaskIds: [],
				summary: "one non-final task failed",
			},
		});
		const summary = await summarizeWorkflowTerminal(cwd, run);
		assert.equal(summary.engineStatus, "completed");
		assert.equal(summary.semanticStatus, "completed_degraded");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
