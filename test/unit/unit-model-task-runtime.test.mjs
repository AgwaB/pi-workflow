import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { compileWorkflow } from "../../.tmp/unit/compiler.js";
import {
	buildDynamicGeneratedCompiledTask,
	normalizeDynamicAgentRequest,
} from "../../.tmp/unit/dynamic-generated-task-runtime.js";
import { stopRun } from "../../.tmp/unit/engine.js";
import {
	applyTaskResultArtifact,
	isTaskTimedOut,
	resultCompletedAfterTimeout,
} from "../../.tmp/unit/result.js";
import { parseWorkflow } from "../../.tmp/unit/schema.js";
import {
	launchSubagentTask,
	setSubagentApiForTests,
} from "../../.tmp/unit/subagent-backend.js";
import { classifyWorkflowTaskDuration } from "../../.tmp/unit/workflow-progress-health.js";
import {
	createWorkflowRunRecord,
	readRunRecord,
	writeRunRecord,
	writeStaticRunArtifacts,
} from "../../.tmp/unit/store.js";
import {
	makeProject,
	makeSubagentLaunchFixture,
	writeAgent,
} from "./unit-test-support.mjs";

function baseSpec(stages = [{ id: "main", type: "single", prompt: "Work." }]) {
	return {
		schemaVersion: 1,
		defaults: { agent: "unit-scout", readOnly: true, tools: ["read"] },
		artifactGraph: { stages },
	};
}

function taskById(compiled, id) {
	const task = compiled.tasks.find((candidate) => candidate.id === id);
	assert.ok(task, `missing compiled task ${id}`);
	return task;
}

function dynamicSpec() {
	return baseSpec([
		{
			id: "adaptive",
			type: "dynamic",
			profileRole: "research-execution",
			dynamic: {
				uses: "./controller.mjs",
				budget: {
					maxAgents: 10,
					maxConcurrency: 2,
					maxRuntimeMs: 900_000,
				},
				decisionLoop: {
					verifier: {
						agent: "unit-scout",
						profileRole: "verification",
						tools: ["read"],
						maxRuntimeMs: 0,
					},
					allowedAgents: ["unit-scout"],
					allowedTools: ["read"],
				},
			},
		},
	]);
}

function generatedRequest(overrides) {
	return normalizeDynamicAgentRequest({
		id: "worker",
		agent: "unit-scout",
		prompt: "Inspect the target.",
		inputs: [],
		...overrides,
	});
}

function generatedInput(cwd, compiled, request, suffix) {
	const controller = compiled.tasks[0];
	return {
		cwd,
		run: {
			runId: "workflow_unlimited_dynamic",
			provenance: {},
			tasks: [
				{
					specId: controller.id,
					stageId: controller.stageId,
					taskId: "controller",
					status: "running",
				},
			],
		},
		compiledFlow: compiled,
		controllerCompiledTask: controller,
		controllerSpecId: controller.id,
		controllerStageId: controller.stageId,
		generatedSpecId: `adaptive.${suffix}`,
		opId: `adaptive.controller:agent:${suffix}`,
		requestHash: `hash-${suffix}`,
		request,
		dynamic: controller.dynamic,
	};
}

function invalidTaskRuntimeSpecs(value) {
	const defaults = baseSpec();
	defaults.defaults.maxRuntimeMs = value;
	const stage = baseSpec([
		{ id: "main", type: "single", prompt: "Work.", maxRuntimeMs: value },
	]);
	const each = baseSpec([
		{ id: "source", type: "single", prompt: "Produce." },
		{
			id: "fan",
			type: "foreach",
			from: { source: "source", path: "$.items" },
			each: { prompt: "Handle ${item}.", maxRuntimeMs: value },
		},
	]);
	const profile = dynamicSpec();
	profile.artifactGraph.stages[0].dynamic.decisionLoop.verifier.maxRuntimeMs =
		value;
	return [defaults, stage, each, profile];
}

test("model-task maxRuntimeMs accepts only zero or positive safe integers while controller budgets stay positive", () => {
	for (const spec of invalidTaskRuntimeSpecs(0)) assert.doesNotThrow(() => parseWorkflow(spec));
	for (const value of [
		-1,
		0.5,
		null,
		"0",
		Number.NaN,
		Number.NEGATIVE_INFINITY,
		Number.POSITIVE_INFINITY,
		Number.MAX_SAFE_INTEGER + 1,
	]) {
		for (const spec of invalidTaskRuntimeSpecs(value)) {
			assert.throws(
				() => parseWorkflow(spec),
				/0 or a positive safe integer/,
				`value=${String(value)}`,
			);
		}
		assert.throws(
			() => generatedRequest({ maxRuntimeMs: value }),
			/0 or a positive safe integer/,
			`dynamic value=${String(value)}`,
		);
	}

	const budgetZero = dynamicSpec();
	budgetZero.artifactGraph.stages[0].dynamic.budget.maxRuntimeMs = 0;
	assert.throws(() => parseWorkflow(budgetZero), /positive integer/);
	const budgetInfinity = dynamicSpec();
	budgetInfinity.artifactGraph.stages[0].dynamic.budget.maxRuntimeMs =
		Number.POSITIVE_INFINITY;
	assert.throws(() => parseWorkflow(budgetInfinity), /positive integer/);
	assert.equal(generatedRequest({ maxRuntimeMs: 0 }).maxRuntimeMs, 0);
});


test("dynamic decision profiles and ctx.agent requests preserve zero with request/profile/budget precedence", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const compiled = await compileWorkflow(parseWorkflow(dynamicSpec()), {
			cwd,
			task: "Exercise dynamic timeout precedence.",
		});
		const controller = compiled.tasks[0];
		assert.equal(controller.runtime.maxRuntimeMs, 900_000);
		assert.equal(controller.dynamic.budget.maxRuntimeMs, 900_000);
		assert.equal(controller.dynamic.decisionLoop.verifier.maxRuntimeMs, 0);

		const matching = await buildDynamicGeneratedCompiledTask(
			generatedInput(
				cwd,
				compiled,
				generatedRequest({ profile: "verifier", maxRuntimeMs: 0 }),
				"matching",
			),
		);
		assert.equal(matching.runtime.maxRuntimeMs, 0);

		const profileOnly = await buildDynamicGeneratedCompiledTask(
			generatedInput(
				cwd,
				compiled,
				generatedRequest({ profile: "verifier" }),
				"profile-only",
			),
		);
		assert.equal(profileOnly.runtime.maxRuntimeMs, 0);

		const requestOnly = await buildDynamicGeneratedCompiledTask(
			generatedInput(
				cwd,
				compiled,
				generatedRequest({ maxRuntimeMs: 0 }),
				"request-only",
			),
		);
		assert.equal(requestOnly.runtime.maxRuntimeMs, 0);

		const inheritedBudget = await buildDynamicGeneratedCompiledTask(
			generatedInput(cwd, compiled, generatedRequest({}), "budget"),
		);
		assert.equal(inheritedBudget.runtime.maxRuntimeMs, 900_000);

		await assert.rejects(
			buildDynamicGeneratedCompiledTask(
				generatedInput(
					cwd,
					compiled,
					generatedRequest({ profile: "verifier", maxRuntimeMs: 1 }),
					"mismatch",
				),
			),
			/cannot override maxRuntimeMs/,
		);

		const finiteProfile = structuredClone(compiled);
		finiteProfile.tasks[0].dynamic.decisionLoop.verifier.maxRuntimeMs = 120_000;
		await assert.rejects(
			buildDynamicGeneratedCompiledTask(
				generatedInput(
					cwd,
					finiteProfile,
					generatedRequest({ profile: "verifier", maxRuntimeMs: 0 }),
					"finite-profile-mismatch",
				),
			),
			/cannot override maxRuntimeMs/,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("unlimited launches omit backend timeout, persist zero provenance, and remain manually cancellable", async () => {
	const cwd = makeProject();
	const launches = [];
	const interrupts = [];
	try {
		setSubagentApiForTests({
			async runSubagent(options) {
				launches.push(options);
				return {
					runId: `backend-run-${launches.length}`,
					attemptId: `backend-attempt-${launches.length}`,
					status: "running",
				};
			},
			async getSubagentStatus() {
				return null;
			},
			async reconcileSubagentRun() {
				return {};
			},
			async interruptSubagent(options) {
				interrupts.push(options);
				return {
					status: "already-terminal",
					runId: options.runId,
					interruptedAttempts: [],
					unsupportedAttempts: [],
					record: {
						attempts: [
							{ attemptId: options.attemptId, status: "cancelled" },
						],
					},
				};
			},
		});

		const unlimited = makeSubagentLaunchFixture(cwd, "unlimited-runtime");
		unlimited.task.runtime.maxRuntimeMs = 0;
		unlimited.compiledTask.runtime.maxRuntimeMs = 0;
		assert.deepEqual(
			await launchSubagentTask(
				cwd,
				unlimited.run,
				unlimited.task,
				unlimited.compiledTask,
			),
			{ kind: "launched" },
		);
		assert.equal(Object.hasOwn(launches[0], "timeoutMs"), false);
		assert.equal(
			unlimited.task.launchBootstrap.records[0].effectivePolicy.maxRuntimeMs,
			0,
		);
		const persistedUnlimited = await readRunRecord(cwd, unlimited.run.runId);
		assert.equal(persistedUnlimited.tasks[0].runtime.maxRuntimeMs, 0);
		assert.equal(
			persistedUnlimited.tasks[0].launchBootstrap.records[0].effectivePolicy
				.maxRuntimeMs,
			0,
		);
		const stoppedUnlimited = await stopRun(cwd, unlimited.run.runId);
		assert.equal(stoppedUnlimited.run.tasks[0].status, "interrupted");
		assert.equal(interrupts.length, 1);

		const finite = makeSubagentLaunchFixture(cwd, "finite-runtime");
		finite.task.runtime.maxRuntimeMs = 2_500;
		finite.compiledTask.runtime.maxRuntimeMs = 2_500;
		await launchSubagentTask(
			cwd,
			finite.run,
			finite.task,
			finite.compiledTask,
		);
		assert.equal(launches[1].timeoutMs, 2_500);
		await stopRun(cwd, finite.run.runId);
		assert.equal(interrupts.length, 2);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("zero disables active and late-result deadlines while finite timeout rejection remains", async () => {
	const cwd = makeProject();
	try {
		const startedAt = new Date(Date.now() - 181_000).toISOString();
		const completedAt = new Date(Date.parse(startedAt) + 180_001).toISOString();
		const unlimited = makeSubagentLaunchFixture(cwd, "late-unlimited").task;
		unlimited.status = "running";
		unlimited.statusDetail = "running";
		unlimited.startedAt = startedAt;
		unlimited.runtime.maxRuntimeMs = 0;
		assert.equal(isTaskTimedOut(unlimited), false);
		assert.equal(resultCompletedAfterTimeout(unlimited, completedAt), false);
		unlimited.stageId = "review";
		assert.equal(classifyWorkflowTaskDuration(unlimited), "long");
		await applyTaskResultArtifact(cwd, unlimited, {
			resultFile: unlimited.files.result,
			result: { completedAt, exitCode: 0 },
			status: "completed",
			completedAfterTimeout: resultCompletedAfterTimeout(
				unlimited,
				completedAt,
			),
		});
		assert.equal(unlimited.status, "completed");

		const finite = makeSubagentLaunchFixture(cwd, "late-finite").task;
		finite.status = "running";
		finite.statusDetail = "running";
		finite.startedAt = startedAt;
		finite.runtime.maxRuntimeMs = 180_000;
		assert.equal(isTaskTimedOut(finite), true);
		assert.equal(resultCompletedAfterTimeout(finite, completedAt), true);
		await applyTaskResultArtifact(cwd, finite, {
			resultFile: finite.files.result,
			result: { completedAt, exitCode: 0 },
			status: "completed",
			completedAfterTimeout: resultCompletedAfterTimeout(finite, completedAt),
		});
		assert.equal(finite.status, "failed");
		assert.equal(finite.statusDetail, "timeout");

		for (const value of [
			-1,
			0.5,
			null,
			"0",
			Number.NaN,
			Number.NEGATIVE_INFINITY,
			Number.POSITIVE_INFINITY,
			Number.MAX_SAFE_INTEGER + 1,
		]) {
			const malformed = makeSubagentLaunchFixture(
				cwd,
				`malformed-${String(value)}`,
			).task;
			malformed.startedAt = startedAt;
			malformed.runtime.maxRuntimeMs = value;
			assert.throws(
				() => isTaskTimedOut(malformed),
				/0 or a positive safe integer/,
			);
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
