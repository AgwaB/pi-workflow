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

test("compiler stamps omitted/true/false skills across all context-field values", async () => {
	const cwd = makeProject();
	try {
		const skillCases = [
			{ name: "omitted", raw: undefined, parsed: undefined },
			{ name: "true", raw: "true", parsed: true },
			{ name: "false", raw: "false", parsed: false },
		];
		const contextCases = [
			{ name: "omitted", raw: undefined, parsed: undefined },
			{ name: "true", raw: "true", parsed: true },
			{ name: "false", raw: "false", parsed: false },
		];

		for (const skill of skillCases) {
			for (const context of contextCases) {
				const name = `matrix-${skill.name}-${context.name}`;
				writeFixtureAgent(cwd, name, {
					inheritSkills: skill.raw,
					inheritProjectContext: context.raw,
				});
				const compiled = await compileFixture(
					cwd,
					workflowSpec(name, [
						{ id: "main", type: "single", prompt: "Inspect." },
					]),
				);
				const task = taskById(compiled, "main.main");
				assertCurrentPolicyMarker(task);
				assert.equal(task.inheritSkills, skill.parsed, name);
				assert.equal(task.inheritProjectContext, context.parsed, name);
				assert.deepEqual(
					resolveWorkflowResourcePolicy(task),
					expectedPolicy(skill.parsed),
					name,
				);

				const warnings = compiled.warnings.filter((warning) =>
					warning.includes(`agent "${name}"`),
				);
				if (context.parsed === true) {
					assert.equal(warnings.length, 1, name);
					assert.match(warnings[0], /project context discovery remains disabled/);
				} else {
					assert.deepEqual(warnings, [], name);
				}
			}
		}
	} finally {
		removeProject(cwd);
	}
});

test("malformed frontmatter is warning-only, ignored, and deduplicated per agent", async () => {
	const cwd = makeProject();
	try {
		const malformedFile = writeFixtureAgent(cwd, "malformed", {
			inheritSkills: "[false]",
			inheritProjectContext: "7",
		});
		const malformed = parseAgentMarkdown(
			readFileSync(malformedFile, "utf8"),
			malformedFile,
			"project",
			join(cwd, ".pi", "agents"),
		);
		assert.equal(malformed.inheritSkills, undefined);
		assert.equal(malformed.inheritProjectContext, undefined);
		assert.deepEqual(malformed.frontmatter.inheritSkills, ["false"]);
		assert.equal(malformed.frontmatter.inheritProjectContext, 7);
		assert.equal(resourceInheritanceWarnings(malformed).length, 2);

		const quietFile = writeFixtureAgent(cwd, "quiet", {
			inheritSkills: "false",
			inheritProjectContext: "false",
		});
		const quiet = parseAgentMarkdown(
			readFileSync(quietFile, "utf8"),
			quietFile,
			"project",
			join(cwd, ".pi", "agents"),
		);
		assert.deepEqual(resourceInheritanceWarnings(quiet), []);

		const compiled = await compileFixture(
			cwd,
			workflowSpec("malformed", [
				{ id: "first", type: "single", prompt: "First." },
				{ id: "second", type: "single", prompt: "Second." },
				{
					id: "nested",
					type: "dag",
					outputFrom: "child",
					stages: [
						{ id: "child", type: "single", prompt: "Nested." },
					],
				},
				{
					id: "quiet-stage",
					type: "single",
					agent: "quiet",
					prompt: "Quiet.",
				},
			]),
		);
		const malformedWarnings = compiled.warnings.filter((warning) =>
			warning.includes('agent "malformed"'),
		);
		assert.equal(malformedWarnings.length, 2);
		assert.match(malformedWarnings.join("\n"), /non-boolean inheritSkills/);
		assert.match(
			malformedWarnings.join("\n"),
			/non-boolean inheritProjectContext/,
		);
		assert.equal(
			compiled.warnings.some((warning) => warning.includes('agent "quiet"')),
			false,
		);
		for (const task of compiled.tasks.filter((task) => task.agent === "malformed")) {
			assertCurrentPolicyMarker(task);
			assert.deepEqual(resolveWorkflowResourcePolicy(task), expectedPolicy());
		}
	} finally {
		removeProject(cwd);
	}
});

test("compiler carries the marker through nested, foreach, loop, and dynamic topology", async () => {
	const cwd = makeProject();
	try {
		writeFixtureAgent(cwd, "topology-agent", { inheritSkills: "false" });
		const compiled = await compileFixture(
			cwd,
			workflowSpec("topology-agent", [
				{ id: "single", type: "single", prompt: "Single." },
				{
					id: "nested",
					type: "dag",
					outputFrom: "inner",
					stages: [
						{ id: "entry", type: "single", prompt: "Entry." },
						{
							id: "inner",
							type: "dag",
							outputFrom: "leaf",
							stages: [
								{ id: "leaf", type: "single", prompt: "Leaf." },
							],
						},
					],
				},
				{ id: "produce", type: "single", prompt: "Produce." },
				{
					id: "fan",
					type: "foreach",
					from: "produce",
					each: { prompt: "Review ${item}." },
				},
				{
					id: "iterate",
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
				{
					id: "adaptive",
					type: "dynamic",
					dynamic: { uses: "./controller.mjs" },
				},
			]),
		);

		for (const id of [
			"single.main",
			"nested.entry.main",
			"nested.inner.leaf.main",
			"produce.main",
			"fan.item",
			"iterate.loop",
			"adaptive.controller",
		]) {
			assertCurrentPolicyMarker(taskById(compiled, id));
		}

		const fan = taskById(compiled, "fan.item");
		const generated = buildForeachGeneratedTasks(fan, undefined, [
			{ id: "one", value: 1 },
			{ id: "two", value: 2 },
		]);
		assert.equal(generated.error, undefined);
		assert.deepEqual(
			generated.tasks.map((task) => task.id),
			["fan.one", "fan.two"],
		);
		for (const task of generated.tasks) assertCurrentPolicyMarker(task);

		const loop = stageById(compiled, "iterate");
		assert.equal(loop.type, "loop");
		for (const template of loop.childTemplates)
			assertCurrentPolicyMarker(template);
		assert.ok(loop.onExhausted?.template);
		assertCurrentPolicyMarker(loop.onExhausted.template);
	} finally {
		removeProject(cwd);
	}
});

test("explicit false preserves model, thinking, tools, and prompt compilation", async () => {
	const cwd = makeProject();
	try {
		const name = "stable-agent";
		const spec = workflowSpec(name, [
			{ id: "main", type: "single", prompt: "Review the exact input." },
		]);
		const specBefore = JSON.parse(JSON.stringify(spec));

		const agentFile = writeFixtureAgent(cwd, name, { inheritSkills: "true" });
		const sourceWithTrue = readFileSync(agentFile, "utf8");
		const compiledTrue = await compileFixture(cwd, spec);
		assert.equal(readFileSync(agentFile, "utf8"), sourceWithTrue);
		assert.deepEqual(spec, specBefore);

		writeFixtureAgent(cwd, name, { inheritSkills: "false" });
		const sourceWithFalse = readFileSync(agentFile, "utf8");
		const parsedSource = parseAgentMarkdown(
			sourceWithFalse,
			agentFile,
			"project",
			join(cwd, ".pi", "agents"),
		);
		const parsedSourceBefore = structuredClone(parsedSource);
		const compiledFalse = await compileFixture(cwd, spec);
		assert.equal(readFileSync(agentFile, "utf8"), sourceWithFalse);
		assert.deepEqual(parsedSource, parsedSourceBefore);

		const trueTask = taskById(compiledTrue, "main.main");
		const falseTask = taskById(compiledFalse, "main.main");
		assert.equal(trueTask.inheritSkills, true);
		assert.equal(falseTask.inheritSkills, false);
		assertCurrentPolicyMarker(trueTask);
		assertCurrentPolicyMarker(falseTask);
		assert.deepEqual(resolveWorkflowResourcePolicy(trueTask), expectedPolicy(true));
		assert.deepEqual(resolveWorkflowResourcePolicy(falseTask), expectedPolicy(false));
		assert.deepEqual(falseTask.runtime, trueTask.runtime);
		assert.deepEqual(falseTask.safety, trueTask.safety);
		assert.deepEqual(falseTask.roleNames, trueTask.roleNames);
		assert.equal(falseTask.agentSystemPrompt, trueTask.agentSystemPrompt);
		assert.equal(falseTask.task, trueTask.task);
		assert.equal(falseTask.compiledPrompt, trueTask.compiledPrompt);
	} finally {
		removeProject(cwd);
	}
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

test("dynamic children use selected-agent flags, preserve legacy absence, and persist warnings", async () => {
	const cwd = makeProject();
	try {
		writeFixtureAgent(cwd, "dynamic-ambient", { inheritSkills: "true" });
		writeFixtureAgent(cwd, "dynamic-disabled", { inheritSkills: "false" });
		writeFixtureAgent(cwd, "dynamic-warning", {
			inheritSkills: "[false]",
			inheritProjectContext: "true",
		});

		const newControllerRawFalse = dynamicController(cwd, 1, false);
		const ambientFlow = { tasks: [newControllerRawFalse], warnings: [] };
		const ambientChild = await buildDynamicGeneratedCompiledTask(
			dynamicBuildInput(
				cwd,
				newControllerRawFalse,
				ambientFlow,
				"dynamic-ambient",
				"ambient",
			),
		);
		assert.equal(ambientChild.inheritSkills, true);
		assertCurrentPolicyMarker(ambientChild);
		assert.deepEqual(resolveWorkflowResourcePolicy(ambientChild), expectedPolicy(true));

		const newControllerRawTrue = dynamicController(cwd, 1, true);
		const disabledFlow = { tasks: [newControllerRawTrue], warnings: [] };
		const disabledChild = await buildDynamicGeneratedCompiledTask(
			dynamicBuildInput(
				cwd,
				newControllerRawTrue,
				disabledFlow,
				"dynamic-disabled",
				"disabled",
			),
		);
		assert.equal(disabledChild.inheritSkills, false);
		assertCurrentPolicyMarker(disabledChild);
		assert.deepEqual(
			resolveWorkflowResourcePolicy(disabledChild),
			expectedPolicy(false),
		);

		const legacyController = dynamicController(cwd, undefined, true);
		const legacyArtifactPath = join(
			cwd,
			".pi",
			"workflows",
			"legacy-dynamic",
			"compiled.json",
		);
		mkdirSync(dirname(legacyArtifactPath), { recursive: true });
		writeFileSync(
			legacyArtifactPath,
			JSON.stringify({ tasks: [legacyController], warnings: [] }),
			"utf8",
		);
		const resumedLegacyFlow = JSON.parse(readFileSync(legacyArtifactPath, "utf8"));
		const resumedLegacyController = resumedLegacyFlow.tasks[0];
		assertNoPolicyMarker(resumedLegacyController);
		const legacyChild = await buildDynamicGeneratedCompiledTask(
			dynamicBuildInput(
				cwd,
				resumedLegacyController,
				resumedLegacyFlow,
				"dynamic-disabled",
				"legacy-disabled",
			),
		);
		assert.equal(legacyChild.inheritSkills, false);
		assertNoPolicyMarker(legacyChild);
		assert.equal(resolveWorkflowResourcePolicy(legacyChild), undefined);
		assertNoPolicyMarker(resumedLegacyController);
		await writeCompiledRunArtifact(
			cwd,
			"legacy-dynamic-roundtrip",
			resumedLegacyFlow,
		);
		const roundTrippedLegacyController = JSON.parse(
			readFileSync(
				compiledWorkflowPath(cwd, "legacy-dynamic-roundtrip"),
				"utf8",
			),
		).tasks[0];
		assertNoPolicyMarker(roundTrippedLegacyController);

		const warningController = dynamicController(cwd, 1, true);
		const warningFlow = {
			tasks: [warningController],
			warnings: ["pre-existing warning"],
		};
		const warningOne = await buildDynamicGeneratedCompiledTask(
			dynamicBuildInput(
				cwd,
				warningController,
				warningFlow,
				"dynamic-warning",
				"warning-one",
			),
		);
		const warningTwo = await buildDynamicGeneratedCompiledTask(
			dynamicBuildInput(
				cwd,
				warningController,
				warningFlow,
				"dynamic-warning",
				"warning-two",
			),
		);
		assertCurrentPolicyMarker(warningOne);
		assertCurrentPolicyMarker(warningTwo);
		const dynamicWarnings = warningFlow.warnings.filter((warning) =>
			warning.includes('agent "dynamic-warning"'),
		);
		assert.equal(dynamicWarnings.length, 2);
		assert.equal(new Set(dynamicWarnings).size, 2);
		assert.match(dynamicWarnings.join("\n"), /non-boolean inheritSkills/);
		assert.match(
			dynamicWarnings.join("\n"),
			/project context discovery remains disabled/,
		);
		await writeCompiledRunArtifact(cwd, "dynamic-warning-artifact", warningFlow);
		const persistedWarnings = JSON.parse(
			readFileSync(
				compiledWorkflowPath(cwd, "dynamic-warning-artifact"),
				"utf8",
			),
		).warnings;
		assert.deepEqual(persistedWarnings, warningFlow.warnings);

		const unknownController = dynamicController(cwd, 2, true);
		await assert.rejects(
			() =>
				buildDynamicGeneratedCompiledTask(
					dynamicBuildInput(
						cwd,
						unknownController,
						{ tasks: [unknownController], warnings: [] },
						"dynamic-ambient",
						"unknown-version",
					),
				),
			/unsupported/,
		);
	} finally {
		removeProject(cwd);
	}
});
