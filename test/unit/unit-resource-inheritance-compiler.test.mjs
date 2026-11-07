import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { parseAgentMarkdown } from "../../.tmp/unit/agents.js";
import { compileWorkflow } from "../../.tmp/unit/compiler.js";
import { buildDynamicGeneratedCompiledTask } from "../../.tmp/unit/dynamic-generated-task-runtime.js";
import { buildForeachGeneratedTasks } from "../../.tmp/unit/engine-run-graph.js";
import { scheduleLoop } from "../../.tmp/unit/loop-runtime.js";
import {
	resourceInheritanceWarnings,
	resolveWorkflowResourcePolicy,
	WORKFLOW_RESOURCE_POLICY_VERSION,
} from "../../.tmp/unit/resource-inheritance.js";
import {
	compiledWorkflowPath,
	createRunRecord,
	flushPendingIndexUpdatesForTests,
	readRunRecord,
	writeCompiledRunArtifact,
	writeRunRecord,
	writeStaticRunArtifacts,
} from "../../.tmp/unit/store.js";

function makeProject() {
	return mkdtempSync(join(tmpdir(), "piwf-resource-inheritance-"));
}

function removeProject(cwd) {
	rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

function writeFixtureAgent(cwd, name, rawFields = {}) {
	const agentDir = join(cwd, ".pi", "agents");
	const file = join(agentDir, `${name}.md`);
	const fields = [
		`description: ${name}`,
		"tools: [read]",
		"readOnly: true",
	];
	for (const [key, value] of Object.entries(rawFields)) {
		if (value !== undefined) fields.push(`${key}: ${value}`);
	}
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		file,
		`---\n${fields.join("\n")}\n---\n# ${name}\n\nUse repository evidence.\n`,
		"utf8",
	);
	return file;
}

function workflowSpec(agent, stages) {
	return {
		schemaVersion: 1,
		name: "resource-inheritance-fixture",
		defaults: {
			agent,
			readOnly: true,
			tools: ["read"],
			model: "fixture/model",
			thinking: "high",
		},
		artifactGraph: { stages },
	};
}

async function compileFixture(cwd, spec) {
	return compileWorkflow(spec, {
		cwd,
		task: "Keep this compiler fixture deterministic.",
	});
}

function taskById(compiled, id) {
	const task = compiled.tasks.find((candidate) => candidate.id === id);
	assert.ok(task, `missing compiled task ${id}`);
	return task;
}

function stageById(compiled, id) {
	const stage = compiled.stages.find((candidate) => candidate.id === id);
	assert.ok(stage, `missing compiled stage ${id}`);
	return stage;
}

function assertCurrentPolicyMarker(task) {
	assert.equal(task.resourcePolicyVersion, WORKFLOW_RESOURCE_POLICY_VERSION);
	assert.equal(Object.hasOwn(task, "resourcePolicyVersion"), true);
}

function assertNoPolicyMarker(task) {
	assert.equal(Object.hasOwn(task, "resourcePolicyVersion"), false);
}

function expectedPolicy(inheritSkills) {
	return {
		version: WORKFLOW_RESOURCE_POLICY_VERSION,
		skillDiscovery: inheritSkills === false ? "disabled" : "ambient",
		contextFiles: "disabled",
	};
}

function removePolicyMarkers(value) {
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const item of value) removePolicyMarkers(item);
		return;
	}
	delete value.resourcePolicyVersion;
	for (const item of Object.values(value)) removePolicyMarkers(item);
}

function dynamicDefinition() {
	return {
		uses: "./controller.mjs",
		mode: "graph-splice",
		budget: { maxAgents: 10, maxConcurrency: 2, maxRuntimeMs: 1_000 },
		permissions: {
			approval: "auto",
			allowDynamicRoles: true,
			allowDynamicTools: true,
		},
		helpers: {},
		workflows: {},
	};
}

function dynamicController(cwd, resourcePolicyVersion, inheritSkills) {
	const controller = {
		id: "adaptive.controller",
		key: "adaptive.controller",
		specId: "adaptive.controller",
		taskId: "controller",
		stageId: "adaptive",
		agent: "dynamic",
		agentPath: "./controller.mjs",
		agentDescription: "Fixture dynamic controller",
		agentSystemPrompt: "",
		roleNames: [],
		task: "Run controller.",
		cwd,
		explicitCwd: false,
		explicitWorktreePolicy: false,
		runtime: {
			approvalMode: "non-interactive",
			model: "fixture/model",
			thinking: "high",
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
	if (resourcePolicyVersion !== undefined)
		controller.resourcePolicyVersion = resourcePolicyVersion;
	if (inheritSkills !== undefined) controller.inheritSkills = inheritSkills;
	return controller;
}

function dynamicBuildInput(cwd, controller, compiledFlow, agent, id) {
	return {
		cwd,
		run: {
			runId: "dynamic-resource-policy-fixture",
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
		compiledFlow,
		controllerCompiledTask: controller,
		controllerSpecId: "adaptive.controller",
		controllerStageId: "adaptive",
		generatedSpecId: `adaptive.${id}`,
		opId: `op-${id}`,
		requestHash: `request-${id}`,
		request: {
			id,
			agent,
			prompt: "Inspect the fixture.",
			inputs: [],
			requiredReads: [],
			compact: true,
		},
		dynamic: dynamicDefinition(),
	};
}

test("resource policy resolver retains legacy absence and rejects unknown versions", () => {
	assert.equal(WORKFLOW_RESOURCE_POLICY_VERSION, 1);
	assert.equal(
		resolveWorkflowResourcePolicy({ inheritSkills: false }),
		undefined,
		"an absent marker must remain legacy even when its raw flag is false",
	);
	assert.deepEqual(
		resolveWorkflowResourcePolicy({ resourcePolicyVersion: 1 }),
		expectedPolicy(undefined),
	);
	assert.deepEqual(
		resolveWorkflowResourcePolicy({
			resourcePolicyVersion: 1,
			inheritSkills: true,
		}),
		expectedPolicy(true),
	);
	assert.deepEqual(
		resolveWorkflowResourcePolicy({
			resourcePolicyVersion: 1,
			inheritSkills: false,
		}),
		expectedPolicy(false),
	);
	assert.throws(
		() => resolveWorkflowResourcePolicy({ resourcePolicyVersion: 2 }),
		/unsupported/,
	);
});




test("loop materialization preserves new markers and legacy absence through resumed rounds", async () => {
	const cwd = makeProject();
	try {
		writeFixtureAgent(cwd, "legacy-agent", { inheritSkills: "false" });
		const spec = workflowSpec("legacy-agent", [
			{
				id: "legacy-loop",
				type: "loop",
				maxRounds: 3,
				until: { any: [] },
				stages: [
					{ id: "implement", type: "single", prompt: "Implement." },
					{
						id: "check",
						type: "single",
						after: "implement",
						prompt: "Check.",
					},
				],
				onExhausted: {
					id: "summary",
					type: "reduce",
					prompt: "Summarize.",
				},
			},
		]);
		const newlyCompiled = await compileFixture(cwd, spec);
		const legacyCompiled = JSON.parse(JSON.stringify(newlyCompiled));
		removePolicyMarkers(legacyCompiled);

		const newSpecPath = join(cwd, "new-loop.json");
		writeFileSync(newSpecPath, JSON.stringify(spec), "utf8");
		const { run: newRun } = await createRunRecord(cwd, newlyCompiled, newSpecPath, {
			runId: "new-loop-fixture",
		});
		await writeStaticRunArtifacts(cwd, newRun, newlyCompiled, spec);
		await writeRunRecord(cwd, newRun);
		const newResumedFlow = JSON.parse(
			readFileSync(compiledWorkflowPath(cwd, newRun.runId), "utf8"),
		);
		const newResumedRun = await readRunRecord(cwd, newRun.runId);
		const newPlaceholderIndex = newResumedFlow.tasks.findIndex(
			(task) => task.loopPlaceholder?.loopId === "legacy-loop",
		);
		assert.notEqual(newPlaceholderIndex, -1);
		await scheduleLoop(
			cwd,
			newResumedRun,
			newResumedFlow,
			newPlaceholderIndex,
			newResumedFlow.tasks[newPlaceholderIndex],
		);
		const newRoundOne = JSON.parse(
			readFileSync(compiledWorkflowPath(cwd, newRun.runId), "utf8"),
		);
		const newRoundOneChildren = newRoundOne.tasks.filter(
			(task) => task.loopChild?.loopId === "legacy-loop",
		);
		assert.equal(newRoundOneChildren.length, 2);
		for (const task of newRoundOneChildren) {
			assertCurrentPolicyMarker(task);
			assert.deepEqual(resolveWorkflowResourcePolicy(task), expectedPolicy(false));
		}

		const specPath = join(cwd, "legacy-loop.json");
		writeFileSync(specPath, JSON.stringify(spec), "utf8");
		const { run } = await createRunRecord(cwd, legacyCompiled, specPath, {
			runId: "legacy-loop-fixture",
		});
		await writeStaticRunArtifacts(cwd, run, legacyCompiled, spec);
		await writeRunRecord(cwd, run);

		const persistedBefore = JSON.parse(
			readFileSync(compiledWorkflowPath(cwd, run.runId), "utf8"),
		);
		const persistedLoop = stageById(persistedBefore, "legacy-loop");
		assertNoPolicyMarker(taskById(persistedBefore, "legacy-loop.loop"));
		for (const template of persistedLoop.childTemplates)
			assertNoPolicyMarker(template);
		assertNoPolicyMarker(persistedLoop.onExhausted.template);

		const resumedFlow = JSON.parse(
			readFileSync(compiledWorkflowPath(cwd, run.runId), "utf8"),
		);
		const resumedRun = await readRunRecord(cwd, run.runId);
		const placeholderIndex = resumedFlow.tasks.findIndex(
			(task) => task.loopPlaceholder?.loopId === "legacy-loop",
		);
		assert.notEqual(placeholderIndex, -1);
		await scheduleLoop(
			cwd,
			resumedRun,
			resumedFlow,
			placeholderIndex,
			resumedFlow.tasks[placeholderIndex],
		);

		const afterRoundOne = JSON.parse(
			readFileSync(compiledWorkflowPath(cwd, run.runId), "utf8"),
		);
		const roundOneChildren = afterRoundOne.tasks.filter(
			(task) => task.loopChild?.loopId === "legacy-loop",
		);
		assert.equal(roundOneChildren.length, 2);
		for (const task of roundOneChildren) {
			assertNoPolicyMarker(task);
			assert.equal(resolveWorkflowResourcePolicy(task), undefined);
		}

		const runAfterRoundOne = await readRunRecord(cwd, run.runId);
		for (const task of runAfterRoundOne.tasks) {
			if (task.specId.startsWith("legacy-loop.r01.")) {
				task.status = "completed";
				task.statusDetail = "completed";
				task.completedAt = "2026-09-12T00:00:00.000Z";
			}
		}
		await writeRunRecord(cwd, runAfterRoundOne);

		const resumedRoundFlow = JSON.parse(
			readFileSync(compiledWorkflowPath(cwd, run.runId), "utf8"),
		);
		const resumedRoundRun = await readRunRecord(cwd, run.runId);
		const resumedPlaceholderIndex = resumedRoundFlow.tasks.findIndex(
			(task) => task.loopPlaceholder?.loopId === "legacy-loop",
		);
		await scheduleLoop(
			cwd,
			resumedRoundRun,
			resumedRoundFlow,
			resumedPlaceholderIndex,
			resumedRoundFlow.tasks[resumedPlaceholderIndex],
		);

		const afterRoundTwo = JSON.parse(
			readFileSync(compiledWorkflowPath(cwd, run.runId), "utf8"),
		);
		const regeneratedChildren = afterRoundTwo.tasks.filter(
			(task) => task.loopChild?.loopId === "legacy-loop",
		);
		assert.equal(regeneratedChildren.length, 4);
		for (const task of regeneratedChildren) assertNoPolicyMarker(task);
		const legacyLoopAfterRegeneration = stageById(afterRoundTwo, "legacy-loop");
		for (const template of legacyLoopAfterRegeneration.childTemplates)
			assertNoPolicyMarker(template);
		assertNoPolicyMarker(legacyLoopAfterRegeneration.onExhausted.template);
		const roundTrip = JSON.parse(JSON.stringify(afterRoundTwo));
		for (const task of roundTrip.tasks.filter(
			(task) => task.loopChild?.loopId === "legacy-loop",
		)) {
			assertNoPolicyMarker(task);
		}
	} finally {
		await flushPendingIndexUpdatesForTests();
		removeProject(cwd);
	}
});
