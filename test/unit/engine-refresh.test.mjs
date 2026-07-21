import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
	utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, test } from "node:test";

import {
	dependencyResumeInvalidationPlanForTests,
	quarantineDependencyInvalidationArtifactsForTests,
	recoverPreparedForeachMaterializationForTests,
	streamingFinalEvidenceErrorForTests,
	resumeRun,
	preparedDependencyInvalidationPlanForTests,
	runWorkflow,
	scheduleRun,
	waitForRun,
} from "../../.tmp/unit/engine.js";
import { setSubagentApiForTests } from "../../.tmp/unit/subagent-backend.js";
import { compileWorkflow } from "../../.tmp/unit/compiler.js";
import {
	buildForeachGeneratedTasks,
	canonicalForeachSourceLineage,
	dependenciesReady,
	markDagDependentsSkipped,
	markFailFastCancellations,
	removeForeachGeneratedTasksForPlaceholders,
	resolveForeachSiblingSourceIds,
	reconcileForeachGeneratedRunRecords,
	synchronizeTerminalBarrierSourceSpecIds,
} from "../../.tmp/unit/engine-run-graph.js";

import {
	artifactGraphDispatchMapValidationStatsForTests,
	assertArtifactGraphSourceRuntimeMetadataCurrent,
	assertFinalCompiledPromptWithinCap,
	createArtifactGraphRuntimeValidationSnapshot,
	resetArtifactGraphDispatchMapValidationStatsForTests,
} from "../../.tmp/unit/artifact-graph-runtime.js";
import { hashDynamicRequest } from "../../.tmp/unit/dynamic-events.js";
import {
	compiledWorkflowPath,
	createTaskRunRecord,
	createRunRecord,
	createWorkflowRunRecord,
	readRunRecord,
	writeRunRecord,
	writeStaticRunArtifacts,
	writeJsonAtomic,
	setRunLeaseTestHooksForTests,
	withRunLease,
	listRunRecords,
	workflowRunDir,
	workflowRunPath,
} from "../../.tmp/unit/store.js";
import { completeTask, taskBySpec } from "./unit-test-support.mjs";

const UNIT_TEST_HOME = mkdtempSync(join(tmpdir(), "workflow-refresh-home-"));
process.env.HOME = UNIT_TEST_HOME;
process.env.USERPROFILE = UNIT_TEST_HOME;

after(() => {
	rmSync(UNIT_TEST_HOME, { recursive: true, force: true });
});

function makeProject() {
	return mkdtempSync(join(tmpdir(), "workflow-refresh-"));
}
function projectTreeSnapshot(cwd) {
	const entries = [];
	const visit = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			const path = join(dir, entry.name);
			const name = relative(cwd, path);
			if (entry.isDirectory()) {
				entries.push({ name, type: "directory" });
				visit(path);
			} else {
				entries.push({
					name,
					type: "file",
					size: statSync(path).size,
					content: readFileSync(path, "utf8"),
				});
			}
		}
	};
	visit(cwd);
	return entries;
}

function writeAgent(cwd, name, tools = "read") {
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

function writeWorkflow(cwd) {
	const workflowDir = join(cwd, "workflows", "wait-refresh");
	mkdirSync(workflowDir, { recursive: true });
	writeFileSync(
		join(workflowDir, "spec.json"),
		JSON.stringify({
			schemaVersion: 1,
			name: "wait-refresh",
			defaults: { agent: "unit-scout", readOnly: true, tools: ["read"] },
			artifactGraph: {
				stages: [
					{
						id: "main",
						type: "single",
						output: {
							analysis: { required: true },
							refs: { required: true },
						},
						prompt: "Do the work.",
					},
				],
			},
		}),
	);
}

function writeCompletedSubagentArtifacts(cwd, runsDir, runId, attemptId) {
	const artifactDir = join(cwd, runsDir, runId, "attempts", attemptId);
	mkdirSync(artifactDir, { recursive: true });
	writeFileSync(
		join(artifactDir, "output.log"),
		[
			"<control>",
			JSON.stringify({ schema: "stage-control-v1", digest: "done" }),
			"</control>",
			"<analysis>",
			"Completed after transient refresh failure.",
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
			status: "completed",
			completedAt: new Date().toISOString(),
			startedAt: new Date(Date.now() - 1000).toISOString(),
			exitCode: 0,
		}),
	);
	return artifactDir;
}

test("waitForRun records transient refresh poll failures and continues", async () => {
	const cwd = makeProject();
	const runs = new Map();
	let launchCount = 0;
	let reconcileCalls = 0;
	try {
		writeAgent(cwd, "unit-scout", "read");
		writeWorkflow(cwd);
		setSubagentApiForTests({
			async runSubagent(options) {
				launchCount += 1;
				const runId = `run_wait_refresh_${launchCount}`;
				const attemptId = `attempt_wait_refresh_${launchCount}`;
				const runsDir = String(options.runsDir ?? ".pi/agent/runs");
				const artifactDir = writeCompletedSubagentArtifacts(
					cwd,
					runsDir,
					runId,
					attemptId,
				);
				runs.set(runId, { runId, attemptId, artifactDir });
				return { runId, attemptId, status: "running" };
			},
			async reconcileSubagentRun() {
				reconcileCalls += 1;
				if (reconcileCalls === 1)
					throw new Error("transient provider refresh blip");
				return {};
			},
			async getSubagentStatus({ runId }) {
				const run = runs.get(runId);
				assert.ok(run, `missing subagent run ${runId}`);
				return {
					runId,
					attemptId: run.attemptId,
					backend: "headless",
					status: "completed",
					failureKind: null,
					startedAt: new Date(Date.now() - 1000).toISOString(),
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
					attempts: [{ attemptId: run.attemptId, status: "completed" }],
				};
			},
			async interruptSubagent() {
				return {};
			},
		});

		const started = await runWorkflow("wait-refresh", cwd, {
			task: "Exercise transient refresh handling.",
		});
		assert.equal(started.status, "running");

		const completed = await waitForRun(cwd, started.runId, 5_000);
		assert.equal(completed.status, "completed");
		assert.equal(completed.tasks[0].status, "completed");
		assert.ok(reconcileCalls >= 2);

		assert.equal(launchCount, 1);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("foreach itemIdentityPath produces stable duplicate-safe child ids", () => {
	const template = {
		id: "singleton.item",
		stageId: "singleton",
		foreach: {
			prompt: "Verify ${item}",
			injectRuntimeTask: false,
			itemIdentityPath: "$.correlationId",
		},
	};
	const generated = buildForeachGeneratedTasks(template, undefined, [
		{ correlationId: "C_Abc-123" },
		{ correlationId: "C_Def-456" },
	]);
	assert.equal(generated.error, undefined);
	assert.deepEqual(
		generated.tasks.map((task) => ({
			specId: task.specId,
			itemIdentity: task.foreachGenerated.itemIdentity,
		})),
		[
			{ specId: "singleton.c_abc-123", itemIdentity: "C_Abc-123" },
			{ specId: "singleton.c_def-456", itemIdentity: "C_Def-456" },
		],
	);

	const duplicate = buildForeachGeneratedTasks(template, undefined, [
		{ correlationId: "C_DUP" },
		{ correlationId: "c_dup" },
	]);
	assert.match(duplicate.error, /duplicate foreach generated task id/);

	const sourceA = canonicalForeachSourceLineage("source-a");
	const sourceB = canonicalForeachSourceLineage("source-b", "upstream-lineage");
	const sibling = resolveForeachSiblingSourceIds(
		["claim", "claim", "unique"],
		[sourceA, sourceB, sourceA],
		"verify",
	);
	assert.equal(sibling.error, undefined);
	assert.equal(sibling.taskIds[2], "unique", "unique legacy ids remain byte-identical");
	assert.match(sibling.taskIds[0], /^claim--[a-f0-9]{12}$/);
	assert.match(sibling.taskIds[1], /^claim--[a-f0-9]{12}$/);
	assert.notEqual(sibling.taskIds[0], sibling.taskIds[1]);

	const uniqueWithLineage = buildForeachGeneratedTasks(
		template,
		undefined,
		[{ correlationId: "unique" }],
		{ lineages: [sourceA] },
	);
	assert.deepEqual(uniqueWithLineage.tasks[0].foreachGenerated, {
		placeholderSpecId: "singleton.item",
		itemIdentity: "unique",
	});
	const collisionWithLineage = buildForeachGeneratedTasks(
		template,
		undefined,
		[{ correlationId: "claim" }, { correlationId: "claim" }],
		{ lineages: [sourceA, sourceB] },
	);
	assert.equal(collisionWithLineage.error, undefined);
	assert.deepEqual(
		collisionWithLineage.tasks.map((task) => task.foreachGenerated),
		collisionWithLineage.tasks.map((task, index) => ({
			placeholderSpecId: "singleton.item",
			itemIdentity: "claim",
			sourceLineageDigest: [sourceA, sourceB][index].digest,
			resolvedTaskId: task.taskId,
		})),
	);
	assert.deepEqual(
		resolveForeachSiblingSourceIds(
			["claim", "claim"],
			[sourceB, sourceA],
			"verify",
		).taskIds,
		[sibling.taskIds[1], sibling.taskIds[0]],
		"source order does not alter lineage resolution",
	);
	assert.match(
		resolveForeachSiblingSourceIds(
			["claim", "claim"],
			[sourceA, sourceA],
			"verify",
		).error,
		/same source lineage/,
	);
	assert.match(
		resolveForeachSiblingSourceIds(
			["unique"],
			[sourceA],
			"verify",
			new Set(["verify.unique"]),
		).error,
		/collides with an existing compiled task/,
	);

	const reserved = buildForeachGeneratedTasks(template, undefined, [
		{ correlationId: "item" },
	]);
	assert.match(reserved.error, /collides with its placeholder/);

	const invalid = buildForeachGeneratedTasks(template, undefined, [
		{ correlationId: 42 },
	]);
	assert.match(invalid.error, /invalid identity/);
});

test("scheduler preserves all-sources joins through skip propagation and fail-fast", () => {
	const join = {
		id: "join.main",
		dependsOn: ["source-a", "source-b"],
		artifactGraph: { inputPolicy: { terminalBarrier: "all-sources" } },
	};
	const flow = {
		failurePolicy: {
			failFast: true,
			cancelSiblingsOnFailure: false,
			cancelDescendantsOnParentFailure: true,
		},
		tasks: [{ id: "source-a" }, { id: "source-b" }, join],
		stages: [],
	};
	const run = {
		tasks: [
			{ taskId: "task-1", specId: "source-a", status: "failed" },
			{ taskId: "task-2", specId: "source-b", status: "running" },
			{ taskId: "task-3", specId: "join.main", status: "pending" },
		],
	};
	assert.equal(markDagDependentsSkipped(run, flow), false);
	assert.equal(run.tasks[2].status, "pending");
	assert.deepEqual(markFailFastCancellations(run, flow), {
		cancelledTaskIds: [],
		interruptedTaskIds: [],
	});
	assert.equal(
		dependenciesReady(join, new Map(run.tasks.map((task) => [task.specId, task])), flow),
		false,
	);

	run.tasks[1].status = "skipped";
	assert.equal(markDagDependentsSkipped(run, flow), false);
	assert.equal(
		dependenciesReady(join, new Map(run.tasks.map((task) => [task.specId, task])), flow),
		true,
	);
	assert.equal(
		dependenciesReady(
			{ dependsOn: ["source-a"], artifactGraph: {} },
			new Map([["source-a", { status: "failed" }]]),
			flow,
		),
		false,
	);
});

test("generation reset removes mapped foreach children and restores the placeholder dependency", () => {
	const placeholderSpecId = "singleton.item";
	const childSpecId = "singleton.c_abc";
	const itemSource = {
		itemHash: "item-hash",
		itemSourceTaskId: "task-0",
		itemSourceSpecId: "source.main",
		itemSourceKind: "control",
		itemRef: "control:1",
	};
	const entries = [
		{
			itemIdentity: "C_ABC",
			taskId: "task-2",
			specId: childSpecId,
			...itemSource,
		},
	];
	const compiled = {
		tasks: [
			{ id: "source.main" },
			{
				id: placeholderSpecId,
				foreach: { itemIdentityPath: "$.correlationId" },
			},
			{
				id: childSpecId,
				sourceGeneration: 1,
				foreachGenerated: {
					placeholderSpecId,
					itemIdentity: "C_ABC",
					...itemSource,
				},
			},
			{ id: "final", dependsOn: [childSpecId] },
		],
	};
	const run = {
		tasks: [
			{
				taskId: "task-0",
				specId: "source.main",
				generation: 1,
			},
			{
				taskId: "task-1",
				specId: placeholderSpecId,
				dispatchMap: {
					version: 1,
					generation: 1,
					sourceTaskId: "task-0",
					entries,
					digest: hashDynamicRequest({
						version: 1,
						generation: 1,
						sourceTaskId: "task-0",
						entries,
					}),
				},
			},
			{
				taskId: "task-2",
				specId: childSpecId,
				foreachGenerated: {
					placeholderSpecId,
					itemIdentity: "C_ABC",
					...itemSource,
				},
				sourceGeneration: 1,
			},
			{ taskId: "task-3", specId: "final", dependsOn: [childSpecId] },
		],
	};
	assert.equal(
		removeForeachGeneratedTasksForPlaceholders(
			run,
			compiled,
			new Set([placeholderSpecId]),
		),
		true,
	);
	assert.deepEqual(
		compiled.tasks.map((task) => task.id),
		["source.main", placeholderSpecId, "final"],
	);
	assert.deepEqual(compiled.tasks[2].dependsOn, [placeholderSpecId]);
	assert.deepEqual(
		run.tasks.map((task) => task.specId),
		["source.main", placeholderSpecId, "final"],
	);
	assert.deepEqual(run.tasks[2].dependsOn, [placeholderSpecId]);
});

test("collision-disambiguated foreach identity drift fails closed during reconciliation and removal", () => {
	const collisionIdentity = {
		sourceLineageDigest: "0123456789abcdef01234567",
		resolvedTaskId: "claim-a--0123456789ab",
	};
	const makeState = () => {
		const placeholderSpecId = "fan.item";
		const childSpecId = `fan.${collisionIdentity.resolvedTaskId}`;
		const membership = {
			placeholderSpecId,
			itemIdentity: "claim-a",
			...collisionIdentity,
		};
		return {
			run: {
				tasks: [
					{ taskId: "task-parent", specId: placeholderSpecId },
					{
						taskId: "task-child",
						specId: childSpecId,
						sourceGeneration: 2,
						foreachGenerated: { ...membership },
					},
				],
			},
			compiled: {
				tasks: [
					{ id: placeholderSpecId, foreach: {} },
					{
						id: childSpecId,
						sourceGeneration: 2,
						foreachGenerated: { ...membership },
					},
				],
			},
			placeholderSpecId,
		};
	};
	const mutations = [
		["sourceLineageDigest", undefined],
		["sourceLineageDigest", "fedcba9876543210fedcba98"],
		["resolvedTaskId", undefined],
		["resolvedTaskId", "claim-a--fedcba987654"],
	];

	for (const [field, value] of mutations) {
		const reconciliation = makeState();
		if (value === undefined) {
			delete reconciliation.run.tasks[1].foreachGenerated[field];
		} else {
			reconciliation.run.tasks[1].foreachGenerated[field] = value;
		}
		assert.throws(
			() =>
				reconcileForeachGeneratedRunRecords(
					"/tmp",
					reconciliation.run,
					reconciliation.compiled,
				),
			/does not exactly match compiled state/,
			`reconciliation must reject ${field}=${String(value)}`,
		);

		const removal = makeState();
		if (value === undefined) {
			delete removal.run.tasks[1].foreachGenerated[field];
		} else {
			removal.run.tasks[1].foreachGenerated[field] = value;
		}
		assert.throws(
			() =>
				removeForeachGeneratedTasksForPlaceholders(
					removal.run,
					removal.compiled,
					new Set([removal.placeholderSpecId]),
				),
			/does not exactly match its compiled placeholder/,
			`removal must reject ${field}=${String(value)}`,
		);
	}
});

test("foreach itemPayloadPath projects prompts, fails closed, and caps the final prompt", () => {
	const template = {
		id: "singleton.item",
		stageId: "singleton",
		foreach: {
			prompt: "Verify ${item}",
			injectRuntimeTask: false,
			itemIdentityPath: "$.correlationId",
			itemPayloadPath: "$.providerItem",
		},
	};
	const item = {
		correlationId: "C_Project-01",
		hiddenJoinMetadata: "must-not-reach-prompt",
		providerItem: { title: "Projected only", evidence: "😀" },
	};
	const projected = buildForeachGeneratedTasks(template, undefined, [item]);
	assert.equal(projected.error, undefined);
	assert.equal(projected.tasks[0].specId, "singleton.c_project-01");
	assert.match(projected.tasks[0].compiledPrompt, /"title":"Projected only"/);
	assert.doesNotMatch(
		projected.tasks[0].compiledPrompt,
		/must-not-reach-prompt/,
	);

	const missing = buildForeachGeneratedTasks(template, undefined, [
		{ correlationId: "C_Project-02" },
	]);
	assert.equal(
		missing.error,
		"foreach item 1 has missing payload at $.providerItem",
	);

	const nonObject = buildForeachGeneratedTasks(template, undefined, [
		{ correlationId: "C_Project-03", providerItem: "not-an-object" },
	]);
	assert.equal(
		nonObject.error,
		"foreach item 1 has non-object payload at $.providerItem",
	);
	for (const providerItem of [null, []]) {
		const invalid = buildForeachGeneratedTasks(template, undefined, [
			{ correlationId: "C_Project-03", providerItem },
		]);
		assert.equal(
			invalid.error,
			"foreach item 1 has non-object payload at $.providerItem",
		);
	}

	const inheritedItem = Object.create({
		providerItem: { title: "inherited" },
	});
	inheritedItem.correlationId = "C_Project-04";
	const inherited = buildForeachGeneratedTasks(template, undefined, [
		inheritedItem,
	]);
	assert.equal(
		inherited.error,
		"foreach item 1 has missing payload at $.providerItem",
	);

	const unsafe = buildForeachGeneratedTasks(
		{
			...template,
			foreach: {
				...template.foreach,
				itemPayloadPath: "$.constructor",
			},
		},
		undefined,
		[item],
	);
	assert.equal(
		unsafe.error,
		'foreach item 1 has unsafe payload path "$.constructor"',
	);

	const actualChars = Array.from(projected.tasks[0].compiledPrompt).length;
	const capped = buildForeachGeneratedTasks(
		{
			...template,
			artifactGraph: {
				inputPolicy: { maxCompiledPromptChars: actualChars - 1 },
			},
		},
		undefined,
		[item],
	);
	assert.equal(
		capped.error,
		`foreach item 1 compiled prompt exceeds maxCompiledPromptChars=${actualChars - 1} (actual ${actualChars})`,
	);
});

test("prepared foreach materialization recovers exact ids after each incomplete persistence boundary", () => {
	const itemSource = {
		itemHash: "item-hash",
		itemSourceTaskId: "task-source",
		itemSourceSpecId: "source.main",
		itemSourceKind: "control",
		itemRef: "control:1",
	};
	const collisionIdentity = {
		sourceLineageDigest: "0123456789abcdef01234567",
		resolvedTaskId: "claim-a--0123456789ab",
	};
	const generatedTask = {
		id: `fan.${collisionIdentity.resolvedTaskId}`,
		dependsOn: ["source.main"],
		foreachGenerated: {
			placeholderSpecId: "fan.item",
			itemIdentity: "claim-a",
			...collisionIdentity,
			...itemSource,
		},
		sourceGeneration: 4,
	};
	const generatedRunTask = {
		taskId: "task-77",
		specId: generatedTask.id,
		status: "pending",
		statusDetail: "pending",
		dependsOn: ["source.main"],
		sourceGeneration: 4,
		foreachGenerated: {
			placeholderSpecId: "fan.item",
			itemIdentity: "claim-a",
			...collisionIdentity,
			...itemSource,
		},
	};
	const entries = [
		{
			itemIdentity: "claim-a",
			taskId: generatedRunTask.taskId,
			specId: generatedRunTask.specId,
			...itemSource,
		},
	];
	const dispatchMap = {
		version: 1,
		generation: 4,
		sourceTaskId: "task-source",
		entries,
		digest: hashDynamicRequest({
			version: 1,
			generation: 4,
			sourceTaskId: "task-source",
			entries,
		}),
	};
	const baseCompiled = {
		tasks: [
			{ id: "source.main" },
			{ id: "fan.item", foreach: {} },
			{ id: "summary.main", dependsOn: ["fan.item"] },
		],
	};
	const baseRun = {
		runId: "run-foreach-recovery",
		tasks: [
			{
				taskId: "task-source",
				specId: "source.main",
				status: "completed",
				generation: 4,
			},
			{
				taskId: "task-parent",
				specId: "fan.item",
				status: "pending",
				dispatchMap,
			},
			{
				taskId: "task-summary",
				specId: "summary.main",
				status: "pending",
				dependsOn: ["fan.item"],
			},
		],
		foreachMaterializationJournal: {
			status: "prepared",
			placeholderSpecId: "fan.item",
			replacePlaceholder: false,
			generatedTasks: [generatedTask],
			generatedRunTasks: [generatedRunTask],
		},
	};
	const compiledAfterCompiledWrite = structuredClone(baseCompiled);
	compiledAfterCompiledWrite.tasks.splice(2, 0, structuredClone(generatedTask));
	compiledAfterCompiledWrite.tasks[3].dependsOn = [generatedTask.id];

	for (const compiled of [baseCompiled, compiledAfterCompiledWrite]) {
		const run = structuredClone(baseRun);
		assert.equal(
			recoverPreparedForeachMaterializationForTests(run, compiled),
			true,
		);
		assert.deepEqual(
			compiled.tasks.map((task) => task.id),
			["source.main", "fan.item", generatedTask.id, "summary.main"],
		);
		assert.deepEqual(
			run.tasks.map((task) => [task.specId, task.taskId]),
			[
				["source.main", "task-source"],
				["fan.item", "task-parent"],
				[generatedTask.id, "task-77"],
				["summary.main", "task-summary"],
			],
		);
		assert.equal(run.tasks[1].status, "completed");
		assert.deepEqual(run.tasks[3].dependsOn, [generatedTask.id]);
		assert.equal("foreachMaterializationJournal" in run, false);
	}

	const committedRun = structuredClone(baseRun);
	const committedCompiled = structuredClone(compiledAfterCompiledWrite);
	assert.equal(
		recoverPreparedForeachMaterializationForTests(
			committedRun,
			committedCompiled,
		),
		true,
	);
	assert.equal(
		recoverPreparedForeachMaterializationForTests(
			committedRun,
			committedCompiled,
		),
		false,
	);
	assert.deepEqual(
		committedRun.tasks.map((task) => task.taskId),
		["task-source", "task-parent", "task-77", "task-summary"],
	);
});

test("final compiled prompt caps source context and retry repair text by code point", () => {
	const sourceContextOverflow = {
		id: "single.main",
		compiledPrompt: "base\n\n# Source Stage Context\n😀😀",
		artifactGraph: { inputPolicy: { maxCompiledPromptChars: 30 } },
	};
	assert.throws(
		() => assertFinalCompiledPromptWithinCap(sourceContextOverflow),
		/final compiled prompt exceeds maxCompiledPromptChars=30 \(actual 31\)/,
	);

	const retryOverflow = {
		id: "fan.claim-a",
		compiledPrompt: "base\n\n# Output Repair\n😀😀",
		artifactGraph: { inputPolicy: { maxCompiledPromptChars: 23 } },
	};
	assert.throws(
		() => assertFinalCompiledPromptWithinCap(retryOverflow),
		/final compiled prompt exceeds maxCompiledPromptChars=23 \(actual 24\)/,
	);
	assert.doesNotThrow(() =>
		assertFinalCompiledPromptWithinCap({
			...retryOverflow,
			artifactGraph: { inputPolicy: { maxCompiledPromptChars: 24 } },
		}),
	);
});

test("dispatch-map validation rejects digest, source-generation, and duplicate-entry drift", () => {
	const currentRun = () => {
		const itemSource = {
			itemHash: "item-hash",
			itemSourceTaskId: "task-source",
			itemSourceSpecId: "source.main",
			itemSourceKind: "control",
			itemRef: "control:1",
		};
		const entries = [
			{
				itemIdentity: "claim-a",
				taskId: "task-child",
				specId: "fan.claim-a",
				...itemSource,
			},
		];
		const dispatchMap = {
			version: 1,
			generation: 4,
			sourceTaskId: "task-source",
			entries,
			digest: hashDynamicRequest({
				version: 1,
				generation: 4,
				sourceTaskId: "task-source",
				entries,
			}),
		};
		const child = {
			taskId: "task-child",
			specId: "fan.claim-a",
			sourceGeneration: 4,
			foreachGenerated: {
				placeholderSpecId: "fan.item",
				itemIdentity: "claim-a",
				...itemSource,
			},
		};
		return {
			tasks: [
				{ taskId: "task-source", specId: "source.main", generation: 4 },
				{ taskId: "task-parent", specId: "fan.item", dispatchMap },
				child,
			],
			child,
		};
	};
	const validate = (tasks, child) => {
		const run = { tasks };
		return assertArtifactGraphSourceRuntimeMetadataCurrent(
			run,
			child,
			createArtifactGraphRuntimeValidationSnapshot(run),
		);
	};

	{
		const { tasks, child } = currentRun();
		assert.doesNotThrow(() =>
			validate(tasks, child),
		);
	}
	{
		const { tasks, child } = currentRun();
		tasks[1].dispatchMap.digest = "tampered";
		assert.throws(
			() => validate(tasks, child),
			/digest does not match/,
		);
	}
	{
		const { tasks, child } = currentRun();
		tasks[0].generation = 5;
		assert.throws(
			() => validate(tasks, child),
			/generation is stale/,
		);
	}
	{
		const { tasks, child } = currentRun();
		const map = tasks[1].dispatchMap;
		map.sourceTaskId = "task-other-source";
		map.digest = hashDynamicRequest({
			version: map.version,
			generation: map.generation,
			sourceTaskId: map.sourceTaskId,
			entries: map.entries,
		});
		assert.throws(
			() => validate(tasks, child),
			/ambiguous or missing source task/,
		);
	}
	{
		const { tasks, child } = currentRun();
		const map = tasks[1].dispatchMap;
		map.entries.push({ ...map.entries[0] });
		map.digest = hashDynamicRequest({
			version: map.version,
			generation: map.generation,
			sourceTaskId: map.sourceTaskId,
			entries: map.entries,
		});
		assert.throws(
			() => validate(tasks, child),
			/invalid dispatch-map entries/,
		);
	}
});

test("default task records omit generation while opted-in records retain it", () => {
	const compiledTask = {
		id: "main.default",
		agent: "unit-scout",
		agentPath: "/tmp/unit-scout.md",
		roleNames: [],
		runtime: {
			model: "unit",
			thinking: "low",
			thinkingResolution: "explicit",
			approvalMode: "default",
		},
		safety: { permission: { status: "allowed" } },
		cwd: "/tmp",
	};
	const defaultRecord = createTaskRunRecord(
		"/tmp",
		"run-default-generation",
		compiledTask,
		0,
	);
	assert.equal(Object.hasOwn(defaultRecord, "generation"), false);
	const optedInRecord = createTaskRunRecord(
		"/tmp",
		"run-opted-generation",
		{ ...compiledTask, generation: 0 },
		0,
	);
	assert.equal(optedInRecord.generation, 0);
});

test("dependency invalidation atomically quarantines old task evidence and fails closed at dynamic ownership", async () => {
	const cwd = makeProject();
	try {
		const taskDir = join(cwd, "runs", "task-1");
		mkdirSync(taskDir, { recursive: true });
		writeFileSync(join(taskDir, "output.log"), "old output");
		writeFileSync(join(taskDir, "source-manifest.json"), "{}");
		writeFileSync(join(taskDir, "read-ledger.jsonl"), "old proof\n");
		const run = {
			runId: "run-invalidation",
			tasks: [
				{
					taskId: "task-1",
					specId: "source.main",
					status: "failed",
					files: { result: join(taskDir, "result.json") },
				},
			],
		};
		await quarantineDependencyInvalidationArtifactsForTests(cwd, run, 2, [
			"task-1",
		]);
		const quarantined = `${taskDir}.invalidated-generation-2`;
		assert.equal(existsSync(taskDir), false);
		assert.equal(existsSync(join(quarantined, "output.log")), true);
		assert.equal(existsSync(join(quarantined, "source-manifest.json")), true);
		assert.equal(existsSync(join(quarantined, "read-ledger.jsonl")), true);

		assert.throws(
			() =>
				dependencyResumeInvalidationPlanForTests(
					{
						runId: "run-dynamic-boundary",
						tasks: [
							{
								taskId: "task-source",
								specId: "source.main",
								status: "failed",
							},
							{
								taskId: "task-controller",
								specId: "controller.main",
								status: "completed",
								dependsOn: ["source.main"],
								artifactGraph: {
									inputPolicy: {
										invalidateOnDependencyResume: true,
									},
								},
							},
						],
					},
					{
						tasks: [
							{ id: "source.main" },
							{ id: "controller.main", kind: "dynamic" },
						],
					},
				),
			/generational dynamic replay is not supported/,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("dependency invalidation fails closed across legacy and streaming foreach groups", () => {
	const producer = {
		taskId: "task-producer",
		specId: "producer.main",
		status: "completed",
		dependsOn: ["upstream.main"],
		artifactGraph: {
			inputPolicy: {
				terminalBarrier: "all-sources",
				invalidateOnDependencyResume: true,
			},
		},
	};
	const upstream = {
		taskId: "task-upstream",
		specId: "upstream.main",
		status: "failed",
	};
	const baseCompiled = {
		tasks: [
			{ id: "upstream.main" },
			{
				id: "producer.main",
				artifactGraph: {
					inputPolicy: {
						terminalBarrier: "all-sources",
						invalidateOnDependencyResume: true,
					},
				},
			},
		],
	};

	assert.throws(
		() =>
			dependencyResumeInvalidationPlanForTests(
				{
					runId: "run-legacy-foreach",
					tasks: [
						upstream,
						producer,
						{
							taskId: "task-legacy-child",
							specId: "fan.item-001",
							status: "completed",
							dependsOn: ["producer.main"],
							foreachGenerated: { placeholderSpecId: "fan.item" },
						},
					],
				},
				{
					tasks: [
						...baseCompiled.tasks,
						{
							id: "fan.item-001",
							foreachGenerated: { placeholderSpecId: "fan.item" },
						},
					],
				},
			),
		/foreach group fan\.item without transactional rematerialization/,
	);

	assert.throws(
		() =>
			dependencyResumeInvalidationPlanForTests(
				{
					runId: "run-streaming-foreach",
					tasks: [
						upstream,
						producer,
						{
							taskId: "task-streaming-parent",
							specId: "fan.item",
							status: "completed",
							dependsOn: ["producer.main"],
						},
						{
							taskId: "task-streaming-child",
							specId: "fan.item-001",
							status: "completed",
							dependsOn: ["fan.item"],
							foreachGenerated: { placeholderSpecId: "fan.item" },
						},
					],
				},
				{
					tasks: [
						...baseCompiled.tasks,
						{
							id: "fan.item",
							foreach: {
								from: { stage: "producer", path: "$.items" },
								streaming: { enabled: true },
							},
						},
						{
							id: "fan.item-001",
							foreachGenerated: { placeholderSpecId: "fan.item" },
						},
					],
				},
			),
		/foreach group fan\.item without transactional rematerialization/,
	);
});
test("pending foreach ownership is transactionally included or rejected before source reset", () => {
	const membership = {
		placeholderSpecId: "fan.item",
		itemIdentity: "claim-a",
		itemHash: "item-hash",
		itemSourceTaskId: "task-source",
		itemSourceSpecId: "source.main",
		itemSourceKind: "control",
		itemRef: "control:1",
	};
	const entries = [
		{
			taskId: "task-child",
			specId: "fan.claim-a",
			...membership,
		},
	];
	const dispatchMap = {
		version: 1,
		generation: 0,
		sourceTaskId: "task-source",
		entries,
		digest: hashDynamicRequest({
			version: 1,
			generation: 0,
			sourceTaskId: "task-source",
			entries,
		}),
	};
	const source = {
		taskId: "task-source",
		specId: "source.main",
		status: "failed",
	};
	const parent = {
		taskId: "task-parent",
		specId: "fan.item",
		status: "pending",
		dependsOn: ["source.main"],
		dispatchMap,
		artifactGraph: {
			inputPolicy: { invalidateOnDependencyResume: true },
		},
	};
	const child = {
		taskId: "task-child",
		specId: "fan.claim-a",
		status: "pending",
		dependsOn: ["source.main"],
		sourceGeneration: 0,
		foreachGenerated: membership,
		artifactGraph: {
			inputPolicy: { invalidateOnDependencyResume: true },
		},
	};
	const compiledParent = {
		id: "fan.item",
		dependsOn: ["source.main"],
		foreach: { itemIdentityPath: "$.id" },
		artifactGraph: {
			inputPolicy: { invalidateOnDependencyResume: true },
		},
	};
	const compiledChild = {
		id: "fan.claim-a",
		dependsOn: ["source.main"],
		sourceGeneration: 0,
		foreachGenerated: membership,
		artifactGraph: {
			inputPolicy: { invalidateOnDependencyResume: true },
		},
	};
	const plan = dependencyResumeInvalidationPlanForTests(
		{
			runId: "pending-stable-foreach",
			tasks: [source, parent, child],
		},
		{
			tasks: [{ id: "source.main" }, compiledParent, compiledChild],
		},
	);
	assert.ok(plan);
	assert.deepEqual(plan.sourceTaskIds, ["task-source"]);
	assert.deepEqual(plan.invalidatedTaskIds, ["task-child", "task-parent"]);

	assert.throws(
		() =>
			dependencyResumeInvalidationPlanForTests(
				{
					runId: "pending-streaming-foreach",
					tasks: [
						source,
						{
							...parent,
							dispatchMap: undefined,
						},
						child,
					],
				},
				{
					tasks: [
						{ id: "source.main" },
						{
							...compiledParent,
							foreach: {
								itemIdentityPath: "$.id",
								from: { streaming: { enabled: true } },
							},
						},
						compiledChild,
					],
				},
			),
		/foreach group fan\.item without transactional rematerialization/,
	);
	assert.throws(
		() =>
			dependencyResumeInvalidationPlanForTests(
				{
					runId: "pending-legacy-foreach",
					tasks: [
						source,
						{
							...child,
							dependsOn: ["source.main"],
						},
					],
				},
				{
					tasks: [
						{ id: "source.main" },
						{
							...compiledChild,
							dependsOn: ["source.main"],
						},
					],
				},
			),
		/foreach group fan\.item without transactional rematerialization/,
	);
});

test("stable foreach validation indexes once and validates its parent map once per snapshot", () => {
	const entries = Array.from({ length: 256 }, (_, index) => ({
		itemIdentity: `claim-${index}`,
		taskId: `task-child-${index}`,
		specId: `fan.claim-${index}`,
		itemHash: `item-hash-${index}`,
		itemSourceTaskId: "task-source",
		itemSourceSpecId: "source.main",
		itemSourceKind: "control",
		itemRef: `control:${index}`,
	}));
	const parent = {
		taskId: "task-parent",
		specId: "fan.item",
		dispatchMap: {
			version: 1,
			generation: 3,
			sourceTaskId: "task-source",
			entries,
			digest: hashDynamicRequest({
				version: 1,
				generation: 3,
				sourceTaskId: "task-source",
				entries,
			}),
		},
	};
	const children = entries.map((entry) => ({
		taskId: entry.taskId,
		specId: entry.specId,
		sourceGeneration: 3,
		foreachGenerated: {
			placeholderSpecId: "fan.item",
			itemIdentity: entry.itemIdentity,
			itemHash: entry.itemHash,
			itemSourceTaskId: entry.itemSourceTaskId,
			itemSourceSpecId: entry.itemSourceSpecId,
			itemSourceKind: entry.itemSourceKind,
			itemRef: entry.itemRef,
		},
	}));
	const run = {
		tasks: [
			{ taskId: "task-source", specId: "source.main", generation: 3 },
			parent,
			...children,
		],
	};

	resetArtifactGraphDispatchMapValidationStatsForTests();
	const snapshot = createArtifactGraphRuntimeValidationSnapshot(run);
	run.tasks[1].dispatchMap.entries[0].itemIdentity = "mutated-after-snapshot";
	for (const child of children) {
		assert.doesNotThrow(() =>
			assertArtifactGraphSourceRuntimeMetadataCurrent(run, child, snapshot),
		);
	}
	assert.deepEqual(artifactGraphDispatchMapValidationStatsForTests(), {
		indexBuilds: 1,
		fullValidations: 1,
	});
	const invalidRun = structuredClone(run);
	invalidRun.tasks[1].dispatchMap.digest = "invalid";
	resetArtifactGraphDispatchMapValidationStatsForTests();
	const invalidSnapshot = createArtifactGraphRuntimeValidationSnapshot(invalidRun);
	for (const child of invalidRun.tasks.slice(2)) {
		assert.throws(
			() =>
				assertArtifactGraphSourceRuntimeMetadataCurrent(
					invalidRun,
					child,
					invalidSnapshot,
				),
			/digest does not match/,
		);
	}
	assert.deepEqual(artifactGraphDispatchMapValidationStatsForTests(), {
		indexBuilds: 1,
		fullValidations: 1,
	});
});

test("resumeRun rejects a prepared legacy foreach invalidation journal before any mutation", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const specPath = join(cwd, "workflow.json");
		const spec = {
			schemaVersion: 1,
			name: "prepared-legacy-invalidation",
			defaults: {
				agent: "unit-scout",
				readOnly: true,
				tools: ["read"],
			},
			artifactGraph: {
				stages: [
					{ id: "upstream", type: "single", prompt: "Upstream." },
					{
						id: "producer",
						type: "single",
						after: ["upstream"],
						prompt: "Producer.",
						inputPolicy: {
							terminalBarrier: "all-sources",
							invalidateOnDependencyResume: true,
						},
					},
					{
						id: "fan",
						type: "foreach",
						from: { source: "producer", path: "$.items" },
						each: { prompt: "Check ${item}." },
					},
				],
			},
		};
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Check prepared invalidation recovery.",
			specPath,
		});
		const fanIndex = compiled.tasks.findIndex((task) => task.id === "fan.item");
		const template = compiled.tasks[fanIndex];
		assert.ok(template?.foreach);
		const generated = buildForeachGeneratedTasks(template, compiled.task, [
			"stale-item",
		]);
		assert.equal(generated.error, undefined);
		const child = generated.tasks[0];
		compiled.tasks.splice(fanIndex, 1, child);

		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		const generatedRunTask = createTaskRunRecord(
			cwd,
			run.runId,
			child,
			run.tasks.length,
		);
		run.tasks[fanIndex] = generatedRunTask;
		const upstream = run.tasks.find((task) => task.specId === "upstream.main");
		const producer = run.tasks.find((task) => task.specId === "producer.main");
		assert.ok(upstream);
		assert.ok(producer);
		upstream.status = "failed";
		upstream.statusDetail = "failed";
		producer.status = "completed";
		producer.statusDetail = "completed";
		generatedRunTask.status = "completed";
		generatedRunTask.statusDetail = "completed";
		run.status = "failed";
		run.invalidationJournal = {
			generation: 1,
			sourceTaskIds: [upstream.taskId],
			invalidatedTaskIds: [producer.taskId, generatedRunTask.taskId],
			status: "prepared",
		};
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		const outputFile = join(cwd, generatedRunTask.files.output);
		mkdirSync(join(outputFile, ".."), { recursive: true });
		writeFileSync(outputFile, "stale legacy prompt output");
		await writeRunRecord(cwd, run);

		const compiledBefore = readFileSync(
			compiledWorkflowPath(cwd, run.runId),
			"utf8",
		);
		await assert.rejects(
			() => resumeRun(cwd, run.runId),
			/foreach group fan\.item without transactional rematerialization/,
		);
		const recovered = await readRunRecord(cwd, run.runId);
		assert.equal(recovered.invalidationJournal?.status, "prepared");
		assert.equal(
			recovered.tasks.find((task) => task.taskId === generatedRunTask.taskId)
				?.status,
			"completed",
		);
		assert.equal(
			readFileSync(outputFile, "utf8"),
			"stale legacy prompt output",
		);
		assert.equal(
			readFileSync(compiledWorkflowPath(cwd, run.runId), "utf8"),
			compiledBefore,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("scheduler materializes stable foreach children from completed control artifacts", async () => {
	const cwd = makeProject();
	const launched = [];
	try {
		writeAgent(cwd, "unit-scout", "read");
		setSubagentApiForTests({
			async runSubagent(options) {
				launched.push(options);
				return {
					runId: `run_materialized_${launched.length}`,
					attemptId: `attempt_materialized_${launched.length}`,
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

		const specPath = join(cwd, "scheduler-materialized-foreach.json");
		const spec = {
			schemaVersion: 1,
			name: "scheduler-materialized-foreach",
			defaults: {
				agent: "unit-scout",
				readOnly: true,
				tools: ["read"],
				model: "openai-codex/gpt-5.5",
				thinking: "low",
			},
			artifactGraph: {
				maxConcurrency: 2,
				stages: [
					{ id: "source", type: "single", prompt: "Source." },
					{
						id: "fan",
						type: "foreach",
						from: { source: "source", path: "$.items" },
						each: {
							prompt: "Check ${item}.",
							itemIdentityPath: "$.correlationId",
							itemPayloadPath: "$.providerItem",
						},
					},
				],
			},
		};
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Schedule stable materialized fanout.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		const source = taskBySpec(run, "source.main");
		const items = [
			{
				correlationId: "Claim-A",
				providerItem: { title: "Alpha", score: 1 },
				hidden: "not projected",
			},
			{
				correlationId: "Claim-B",
				providerItem: { title: "Beta", score: 2 },
				hidden: "not projected",
			},
		];
		await completeTask(cwd, source, { items });
		source.generation = 2;
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);

		const materialized = await readRunRecord(cwd, run.runId);
		const materializedCompiled = JSON.parse(
			readFileSync(compiledWorkflowPath(cwd, run.runId), "utf8"),
		);
		const parent = taskBySpec(materialized, "fan.item");
		assert.equal(parent.status, "completed");
		assert.equal(parent.statusDetail, "foreach_materialized");
		const children = materialized.tasks.filter(
			(task) => task.foreachGenerated?.placeholderSpecId === "fan.item",
		);
		const compiledChildren = materializedCompiled.tasks.filter(
			(task) => task.foreachGenerated?.placeholderSpecId === "fan.item",
		);
		assert.deepEqual(
			children.map((task) => ({
				taskId: task.taskId,
				specId: task.specId,
				sourceGeneration: task.sourceGeneration,
				itemIdentity: task.foreachGenerated.itemIdentity,
				itemSourceTaskId: task.foreachGenerated.itemSourceTaskId,
				itemSourceSpecId: task.foreachGenerated.itemSourceSpecId,
				itemSourceKind: task.foreachGenerated.itemSourceKind,
				itemRef: task.foreachGenerated.itemRef,
				itemHash: task.foreachGenerated.itemHash,
			})),
			[
				{
					taskId: "task-3",
					specId: "fan.claim-a",
					sourceGeneration: 2,
					itemIdentity: "Claim-A",
					itemSourceTaskId: source.taskId,
					itemSourceSpecId: "source.main",
					itemSourceKind: "control",
					itemRef: "source.main:control:$.items[0]",
					itemHash: hashDynamicRequest(items[0]),
				},
				{
					taskId: "task-4",
					specId: "fan.claim-b",
					sourceGeneration: 2,
					itemIdentity: "Claim-B",
					itemSourceTaskId: source.taskId,
					itemSourceSpecId: "source.main",
					itemSourceKind: "control",
					itemRef: "source.main:control:$.items[1]",
					itemHash: hashDynamicRequest(items[1]),
				},
			],
		);
		assert.deepEqual(
			compiledChildren.map((task) => ({
				id: task.id,
				sourceGeneration: task.sourceGeneration,
				itemIdentity: task.foreachGenerated.itemIdentity,
			})),
			[
				{
					id: "fan.claim-a",
					sourceGeneration: 2,
					itemIdentity: "Claim-A",
				},
				{
					id: "fan.claim-b",
					sourceGeneration: 2,
					itemIdentity: "Claim-B",
				},
			],
		);
		assert.equal(
			compiledChildren[0].task.startsWith(
				'Check {"title":"Alpha","score":1}.\n\n# Workflow Output Protocol',
			),
			true,
		);
		assert.equal(
			compiledChildren[1].task.startsWith(
				'Check {"title":"Beta","score":2}.\n\n# Workflow Output Protocol',
			),
			true,
		);
		assert.equal(compiledChildren[0].compiledPrompt.includes("not projected"), false);
		const dispatchEntries = children.map((task) => ({
			itemIdentity: task.foreachGenerated.itemIdentity,
			taskId: task.taskId,
			specId: task.specId,
			itemSourceTaskId: source.taskId,
			itemSourceSpecId: "source.main",
			itemSourceKind: "control",
			itemRef: task.foreachGenerated.itemRef,
			itemHash: task.foreachGenerated.itemHash,
		}));
		assert.deepEqual(parent.dispatchMap, {
			version: 1,
			generation: 2,
			sourceTaskId: source.taskId,
			entries: dispatchEntries,
			digest: hashDynamicRequest({
				version: 1,
				generation: 2,
				sourceTaskId: source.taskId,
				entries: dispatchEntries,
			}),
		});

		const invalidCompiled = structuredClone(compiled);
		const { run: invalidRun } = await createWorkflowRunRecord(
			cwd,
			invalidCompiled,
			specPath,
		);
		await writeStaticRunArtifacts(cwd, invalidRun, invalidCompiled, spec);
		const invalidSource = taskBySpec(invalidRun, "source.main");
		await completeTask(cwd, invalidSource, {
			items: { correlationId: "Claim-C", providerItem: { title: "Gamma" } },
		});
		invalidSource.generation = 2;
		await writeRunRecord(cwd, invalidRun);

		await scheduleRun(cwd, invalidRun.runId);

		const blocked = await readRunRecord(cwd, invalidRun.runId);
		const blockedParent = taskBySpec(blocked, "fan.item");
		assert.equal(blockedParent.status, "blocked");
		assert.equal(blockedParent.statusDetail, "foreach_expansion_blocked");
		assert.equal(
			blockedParent.lastMessage,
			`${invalidSource.taskId} control $.items did not resolve to an array`,
		);
		assert.equal(blockedParent.dispatchMap, undefined);
		assert.deepEqual(
			blocked.tasks.filter(
				(task) => task.foreachGenerated?.placeholderSpecId === "fan.item",
			),
			[],
		);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});
test("scheduler validates valid and invalid 256-child dispatch maps once per pass", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const specPath = join(cwd, "scheduler-fanout.json");
		const spec = {
			schemaVersion: 1,
			name: "scheduler-fanout",
			defaults: {
				agent: "unit-scout",
				readOnly: true,
				tools: ["read"],
			},
			artifactGraph: {
				stages: [
					{ id: "source", type: "single", prompt: "Source." },
					{
						id: "fan",
						type: "foreach",
						from: { source: "source", path: "$.items" },
						each: {
							prompt: "Check ${item}.",
							itemIdentityPath: "$.id",
						},
					},
				],
			},
		};
		writeFileSync(specPath, JSON.stringify(spec));
		const baseCompiled = await compileWorkflow(spec, {
			cwd,
			task: "Schedule stable fanout.",
			specPath,
		});

		const createFanoutRun = async (invalid) => {
			const compiled = structuredClone(baseCompiled);
			const parentIndex = compiled.tasks.findIndex(
				(task) => task.id === "fan.item",
			);
			const parentTemplate = compiled.tasks[parentIndex];
			const generated = buildForeachGeneratedTasks(
				parentTemplate,
				compiled.task,
				Array.from({ length: 256 }, (_, index) => ({
					id: `claim-${index}`,
				})),
			);
			assert.equal(generated.error, undefined);
			const generatedTasks = generated.tasks.map((task) => ({
				...task,
				sourceGeneration: 3,
			}));
			compiled.tasks.splice(parentIndex + 1, 0, ...generatedTasks);
			const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
			const source = run.tasks.find((task) => task.specId === "source.main");
			const parent = run.tasks.find((task) => task.specId === "fan.item");
			assert.ok(source);
			assert.ok(parent);
			source.status = "completed";
			source.statusDetail = "completed";
			source.generation = 3;
			parent.status = "completed";
			parent.statusDetail = "foreach_materialized";
			const children = run.tasks.filter(
				(task) => task.foreachGenerated?.placeholderSpecId === "fan.item",
			);
			const compiledChildren = compiled.tasks.filter(
				(task) =>
					task.foreachGenerated?.placeholderSpecId === "fan.item",
			);
			assert.equal(compiledChildren.length, children.length);
			for (const [index, child] of children.entries()) {
				const itemSource = {
					itemHash: `item-hash-${index}`,
					itemSourceTaskId: source.taskId,
					itemSourceSpecId: source.specId,
					itemSourceKind: "control",
					itemRef: `control:${index}`,
				};
				const compiledChild = compiledChildren[index];
				assert.ok(compiledChild?.foreachGenerated);
				compiledChild.foreachGenerated = {
					...compiledChild.foreachGenerated,
					...itemSource,
				};
				child.foreachGenerated = {
					...child.foreachGenerated,
					...itemSource,
				};
			}
			const entries = children.map((task) => ({
				itemIdentity: task.foreachGenerated.itemIdentity,
				taskId: task.taskId,
				specId: task.specId,
				itemHash: task.foreachGenerated.itemHash,
				itemSourceTaskId: task.foreachGenerated.itemSourceTaskId,
				itemSourceSpecId: task.foreachGenerated.itemSourceSpecId,
				itemSourceKind: task.foreachGenerated.itemSourceKind,
				itemRef: task.foreachGenerated.itemRef,
			}));
			parent.dispatchMap = {
				version: 1,
				generation: 3,
				sourceTaskId: source.taskId,
				entries,
				digest: hashDynamicRequest({
					version: 1,
					generation: 3,
					sourceTaskId: source.taskId,
					entries,
				}),
			};
			if (invalid) parent.dispatchMap.digest = "invalid";
			for (const child of children) {
				child.status = "pending";
				child.statusDetail = "pending";
				child.backendHandle = { runId: "already-claimed" };
			}
			run.status = "running";
			await writeStaticRunArtifacts(cwd, run, compiled, spec);
			await writeRunRecord(cwd, run);
			return run;
		};

		const valid = await createFanoutRun(false);
		resetArtifactGraphDispatchMapValidationStatsForTests();
		await scheduleRun(cwd, valid.runId);
		assert.deepEqual(artifactGraphDispatchMapValidationStatsForTests(), {
			indexBuilds: 1,
			fullValidations: 1,
		});

		const invalid = await createFanoutRun(true);
		resetArtifactGraphDispatchMapValidationStatsForTests();
		await scheduleRun(cwd, invalid.runId);
		assert.deepEqual(artifactGraphDispatchMapValidationStatsForTests(), {
			indexBuilds: 1,
			fullValidations: 1,
		});
		const invalidPersisted = await readRunRecord(cwd, invalid.runId);
		const invalidChildren = invalidPersisted.tasks.filter(
			(task) => task.foreachGenerated?.placeholderSpecId === "fan.item",
		);
		assert.ok(invalidChildren.length > 0);
		for (const child of invalidChildren) {
			assert.equal(
				child.status,
				"blocked",
				"invalid dispatch metadata blocks the child before backend launch",
			);
			assert.equal(child.statusDetail, "foreach_generation_stale");
			assert.match(
				child.lastMessage ?? "",
				/dispatch map digest does not match its current entries/,
			);
			assert.deepEqual(child.backendHandle, { runId: "already-claimed" });
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
test("streaming final control rejects identical-hash source migration", () => {
	const partial = {
		id: "fan.claim-a",
		foreachGenerated: {
			placeholderSpecId: "fan.item",
			itemIdentity: "claim-a",
			itemHash: "same-hash",
			itemSourceTaskId: "task-source-a",
			itemSourceSpecId: "source-a.main",
			itemSourceKind: "partial",
			itemRef: "partial:1",
		},
	};
	const sameSourceControl = {
		id: "fan.claim-a",
		foreachGenerated: {
			...partial.foreachGenerated,
			itemSourceKind: "control",
			itemRef: "control:1",
		},
	};
	const migratedControl = {
		id: "fan.claim-a",
		foreachGenerated: {
			...sameSourceControl.foreachGenerated,
			itemSourceTaskId: "task-source-b",
			itemSourceSpecId: "source-b.main",
		},
	};

	assert.equal(
		streamingFinalEvidenceErrorForTests([partial], [sameSourceControl]),
		undefined,
	);
	assert.match(
		streamingFinalEvidenceErrorForTests([partial], [migratedControl]),
		/changed after materialization/,
	);
});

test("dependency invalidation leaves pending and approval-blocked consumers to ordinary resume", () => {
	const run = {
		runId: "run-pending-approval",
		tasks: [
			{
				taskId: "task-source",
				specId: "source.main",
				status: "failed",
			},
			{
				taskId: "task-pending",
				specId: "pending.main",
				status: "pending",
				dependsOn: ["source.main"],
				artifactGraph: {
					inputPolicy: { invalidateOnDependencyResume: true },
				},
			},
			{
				taskId: "task-approval",
				specId: "approval.main",
				status: "blocked",
				statusDetail: "dynamic_approval_timeout",
				dependsOn: ["source.main"],
				kind: "dynamic",
				artifactGraph: {
					inputPolicy: { invalidateOnDependencyResume: true },
				},
			},
			{
				taskId: "task-skipped",
				specId: "skipped.main",
				status: "skipped",
				statusDetail: "skipped_after_dependency_failure",
				dependsOn: ["source.main"],
				artifactGraph: {
					inputPolicy: { invalidateOnDependencyResume: true },
				},
			},
		],
	};
	const compiled = {
		tasks: [
			{ id: "source.main" },
			{
				id: "pending.main",
				dependsOn: ["source.main"],
				artifactGraph: {
					inputPolicy: { invalidateOnDependencyResume: true },
				},
			},
			{
				id: "approval.main",
				kind: "dynamic",
				dependsOn: ["source.main"],
				artifactGraph: {
					inputPolicy: { invalidateOnDependencyResume: true },
				},
			},
			{
				id: "skipped.main",
				dependsOn: ["source.main"],
				artifactGraph: {
					inputPolicy: { invalidateOnDependencyResume: true },
				},
			},
		],
	};

	assert.equal(dependencyResumeInvalidationPlanForTests(run, compiled), undefined);
});

test("dependency invalidation follows compiled context and persisted streaming lineage", () => {
	const childMembership = {
		placeholderSpecId: "fan.item",
		itemIdentity: "claim-a",
		itemHash: "item-hash",
		itemSourceTaskId: "task-producer",
		itemSourceSpecId: "producer.main",
		itemSourceKind: "partial",
		itemRef: "partial:1",
	};
	const dispatchEntries = [
		{
			itemIdentity: childMembership.itemIdentity,
			taskId: "task-child",
			specId: "fan.claim-a",
			...childMembership,
		},
	];
	const run = {
		runId: "run-streaming-lineage",
		tasks: [
			{
				taskId: "task-upstream",
				specId: "upstream.main",
				status: "failed",
			},
			{
				taskId: "task-producer",
				specId: "producer.main",
				status: "completed",
				dependsOn: [],
				artifactGraph: {
					inputPolicy: { invalidateOnDependencyResume: true },
				},
			},
			{
				taskId: "task-parent",
				specId: "fan.item",
				status: "completed",
				dependsOn: [],
				dispatchMap: {
					version: 1,
					generation: 0,
					sourceTaskId: "task-producer",
					entries: dispatchEntries,
					digest: hashDynamicRequest({
						version: 1,
						generation: 0,
						sourceTaskId: "task-producer",
						entries: dispatchEntries,
					}),
				},
			},
			{
				taskId: "task-child",
				specId: "fan.claim-a",
				status: "pending",
				dependsOn: [],
				sourceGeneration: 0,
				foreachGenerated: childMembership,
			},
		],
	};
	const compiled = {
		tasks: [
			{ id: "upstream.main" },
			{
				id: "producer.main",
				dependsOn: ["upstream.main"],
				artifactGraph: {
					inputPolicy: { invalidateOnDependencyResume: true },
				},
			},
			{
				id: "fan.item",
				contextDependsOn: ["producer.main"],
				foreach: { itemIdentityPath: "$.id" },
			},
			{
				id: "fan.claim-a",
				contextDependsOn: ["producer.main"],
				sourceGeneration: 0,
				foreachGenerated: childMembership,
			},
		],
	};
	const plan = dependencyResumeInvalidationPlanForTests(run, compiled);

	assert.deepEqual(plan?.sourceTaskIds, ["task-upstream"]);
	assert.deepEqual(plan?.invalidatedTaskIds, [
		"task-child",
		"task-parent",
		"task-producer",
	]);
});

test("empty foreach materialization retains its placeholder edge for source resume", () => {
	const placeholderSpecId = "fan.item";
	const run = {
		runId: "run-empty-foreach",
		tasks: [
			{
				taskId: "task-source",
				specId: "source.main",
				status: "failed",
			},
			{
				taskId: "task-parent",
				specId: placeholderSpecId,
				status: "pending",
				dependsOn: ["source.main"],
			},
			{
				taskId: "task-final",
				specId: "final.main",
				status: "completed",
				dependsOn: [placeholderSpecId],
			},
		],
		foreachMaterializationJournal: {
			status: "prepared",
			placeholderSpecId,
			replacePlaceholder: true,
			generatedTasks: [],
			generatedRunTasks: [],
		},
	};
	const compiled = {
		tasks: [
			{ id: "source.main" },
			{
				id: placeholderSpecId,
				dependsOn: ["source.main"],
				foreach: {},
				artifactGraph: {
					inputPolicy: { invalidateOnDependencyResume: true },
				},
			},
			{ id: "final.main", dependsOn: [placeholderSpecId] },
		],
	};

	assert.equal(recoverPreparedForeachMaterializationForTests(run, compiled), true);
	assert.deepEqual(compiled.tasks[2].dependsOn, [placeholderSpecId]);
	assert.deepEqual(run.tasks[2].dependsOn, [placeholderSpecId]);
	assert.equal(run.tasks[1].status, "completed");
	assert.equal(run.tasks[1].statusDetail, "foreach_empty");
	assert.deepEqual(
		dependencyResumeInvalidationPlanForTests(run, compiled)?.invalidatedTaskIds,
		["task-final", "task-parent"],
	);
});

test("foreach reconciliation rejects self, cross-placeholder, and absent generated membership", () => {
	const selfMembership = {
		placeholderSpecId: "fan.item",
		itemIdentity: "claim-a",
	};
	assert.throws(
		() =>
			reconcileForeachGeneratedRunRecords(
				"/tmp",
				{
					tasks: [
						{
							taskId: "task-parent",
							specId: "fan.item",
							foreachGenerated: selfMembership,
						},
					],
				},
				{
					tasks: [
						{
							id: "fan.item",
							foreach: {},
							foreachGenerated: selfMembership,
						},
					],
				},
			),
		/invalid placeholder/,
	);

	assert.throws(
		() =>
			reconcileForeachGeneratedRunRecords(
				"/tmp",
				{
					tasks: [
						{ taskId: "task-parent", specId: "fan.item" },
						{
							taskId: "task-child",
							specId: "fan.claim-a",
							foreachGenerated: {
								placeholderSpecId: "other.item",
								itemIdentity: "claim-a",
							},
						},
					],
				},
				{
					tasks: [
						{ id: "fan.item", foreach: {} },
						{
							id: "fan.claim-a",
							foreachGenerated: {
								placeholderSpecId: "fan.item",
								itemIdentity: "claim-a",
							},
						},
					],
				},
			),
		/does not exactly match compiled state/,
	);

	assert.throws(
		() =>
			reconcileForeachGeneratedRunRecords(
				"/tmp",
				{
					tasks: [
						{ taskId: "task-parent", specId: "fan.item" },
						{
							taskId: "task-rogue",
							specId: "fan.rogue",
							foreachGenerated: {
								placeholderSpecId: "fan.item",
								itemIdentity: "rogue",
							},
						},
					],
				},
				{ tasks: [{ id: "fan.item", foreach: {} }] },
			),
		/does not exactly match compiled state/,
	);
});

test("compiled terminal-barrier policy repairs malformed persisted metadata", () => {
	const join = {
		id: "join.main",
		dependsOn: ["source-a", "source-b"],
		artifactGraph: { inputPolicy: { terminalBarrier: "all-sources" } },
	};
	const run = {
		tasks: [
			{ taskId: "task-a", specId: "source-a", status: "failed" },
			{ taskId: "task-b", specId: "source-b", status: "running" },
			{
				taskId: "task-join",
				specId: "join.main",
				status: "pending",
				terminalBarrier: { mode: "all-sources", sourceSpecIds: "source-a" },
			},
		],
	};
	const flow = { tasks: [{ id: "source-a" }, { id: "source-b" }, join] };
	const bySpecId = new Map(run.tasks.map((task) => [task.specId, task]));

	assert.equal(dependenciesReady(join, bySpecId, flow, run.tasks[2]), false);
	assert.equal(synchronizeTerminalBarrierSourceSpecIds(run, flow), true);
	assert.deepEqual(run.tasks[2].terminalBarrier, {
		mode: "all-sources",
		sourceSpecIds: ["source-a", "source-b"],
	});
	assert.equal(markDagDependentsSkipped(run, flow), false);
});
test("resume replays exact foreach invalidation journals across compiled-only and run-only persistence boundaries", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const specPath = join(cwd, "resume-foreach.json");
		const spec = {
			schemaVersion: 1,
			name: "resume-foreach",
			defaults: {
				agent: "unit-scout",
				readOnly: true,
				tools: ["read"],
			},
			artifactGraph: {
				stages: [
					{ id: "source", type: "single", prompt: "Source." },
					{
						id: "fan",
						type: "foreach",
						after: ["source"],
						from: { source: "source", path: "$.items" },
						each: {
							prompt: "Check ${item}.",
							itemIdentityPath: "$.id",
						},
						inputPolicy: { invalidateOnDependencyResume: true },
					},
				],
			},
		};
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Exercise resumable foreach invalidation.",
			specPath,
		});
		const parentIndex = compiled.tasks.findIndex((task) => task.id === "fan.item");
		const parentTemplate = compiled.tasks[parentIndex];
		assert.ok(parentTemplate?.foreach);
		const generated = buildForeachGeneratedTasks(parentTemplate, compiled.task, [
			{ id: "claim-a" },
		]);
		assert.equal(generated.error, undefined);
		const childMetadata = {
			placeholderSpecId: "fan.item",
			itemIdentity: "claim-a",
			itemHash: "item-hash",
			itemSourceTaskId: "",
			itemSourceSpecId: "source.main",
			itemSourceKind: "control",
			itemRef: "control:1",
		};
		const child = {
			...generated.tasks[0],
			sourceGeneration: 1,
			foreachGenerated: childMetadata,
		};
		compiled.tasks.splice(parentIndex + 1, 0, child);
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		const source = run.tasks.find((task) => task.specId === "source.main");
		const parent = run.tasks.find((task) => task.specId === "fan.item");
		const runChild = run.tasks.find((task) => task.specId === child.id);
		assert.ok(source);
		assert.ok(parent);
		assert.ok(runChild);
		child.foreachGenerated.itemSourceTaskId = source.taskId;
		runChild.foreachGenerated = {
			...child.foreachGenerated,
			itemSourceTaskId: source.taskId,
		};
		source.generation = 1;
		source.status = "failed";
		source.statusDetail = "failed";
		parent.status = "completed";
		parent.statusDetail = "foreach_materialized";
		runChild.status = "completed";
		runChild.statusDetail = "completed";
		const entries = [
			{
				itemIdentity: "claim-a",
				taskId: runChild.taskId,
				specId: runChild.specId,
				...runChild.foreachGenerated,
			},
		];
		parent.dispatchMap = {
			version: 1,
			generation: 1,
			sourceTaskId: source.taskId,
			entries,
			digest: hashDynamicRequest({
				version: 1,
				generation: 1,
				sourceTaskId: source.taskId,
				entries,
			}),
		};
		run.status = "failed";
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);
		const compiledBeforeAbort = JSON.parse(
			readFileSync(compiledWorkflowPath(cwd, run.runId), "utf8"),
		);

		let aborted = false;
		setRunLeaseTestHooksForTests({
			onAfterAtomicRename({ file, abortLease }) {
				if (aborted || file !== compiledWorkflowPath(cwd, run.runId)) return;
				aborted = true;
				abortLease(new Error("forced resume lease loss"));
			},
		});
		await assert.rejects(
			() => resumeRun(cwd, run.runId),
			/forced resume lease loss/,
		);
		const afterAbort = await readRunRecord(cwd, run.runId);
		assert.equal(afterAbort.invalidationJournal?.status, "prepared");
		assert.equal(
			afterAbort.tasks.some((task) => task.specId === child.id),
			true,
		);
		const compiledAfterAbort = JSON.parse(
			readFileSync(compiledWorkflowPath(cwd, run.runId), "utf8"),
		);
		assert.equal(
			compiledAfterAbort.tasks.some((task) => task.id === child.id),
			false,
		);

		setRunLeaseTestHooksForTests(undefined);
		setSubagentApiForTests({
			async runSubagent() {
				return {
					runId: "resume-foreach-worker",
					attemptId: "resume-foreach-attempt",
					status: "running",
				};
			},
			async reconcileSubagentRun() {
				return {};
			},
			async getSubagentStatus() {
				return null;
			},
			async interruptSubagent() {
				return {};
			},
		});
		const resumed = await resumeRun(cwd, run.runId);
		assert.ok(resumed.resetTaskIds.includes(source.taskId));
		const repaired = await readRunRecord(cwd, run.runId);
		assert.equal(
			repaired.tasks.some((task) => task.specId === child.id),
			false,
		);
		assert.equal(repaired.invalidationJournal?.status, "applied");
		const runOnlyInverse = structuredClone(afterAbort);
		runOnlyInverse.tasks = runOnlyInverse.tasks.filter(
			(task) => task.specId !== child.id,
		);
		await writeJsonAtomic(
			compiledWorkflowPath(cwd, run.runId),
			compiledBeforeAbort,
		);
		await writeRunRecord(cwd, runOnlyInverse);
		const replayedInverse = await resumeRun(cwd, run.runId);
		assert.ok(replayedInverse.resetTaskIds.includes(source.taskId));
		const inverseRepaired = await readRunRecord(cwd, run.runId);
		assert.equal(
			inverseRepaired.tasks.some((task) => task.specId === child.id),
			false,
		);
		assert.equal(inverseRepaired.invalidationJournal?.status, "applied");
	} finally {
		setRunLeaseTestHooksForTests(undefined);
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});
test("foreach reconciliation rejects membership-less children and global task identity collisions", () => {
	const membership = {
		placeholderSpecId: "fan.item",
		itemIdentity: "claim-a",
		itemHash: "item-hash",
		itemSourceTaskId: "task-source",
		itemSourceSpecId: "source.main",
		itemSourceKind: "control",
		itemRef: "control:1",
	};
	assert.throws(
		() =>
			reconcileForeachGeneratedRunRecords(
				"/tmp",
				{
					runId: "membership-less",
					tasks: [
						{ taskId: "task-source", specId: "source.main" },
						{
							taskId: "task-child",
							specId: "fan.claim-a",
							sourceGeneration: 1,
						},
					],
				},
				{
					tasks: [
						{ id: "source.main" },
						{
							id: "fan.claim-a",
							sourceGeneration: 1,
							foreachGenerated: membership,
						},
					],
				},
			),
		/does not exactly match compiled state/,
	);
	assert.throws(
		() =>
			reconcileForeachGeneratedRunRecords(
				"/tmp",
				{
					runId: "duplicate-task-id",
					tasks: [
						{ taskId: "task-1", specId: "source.main" },
						{ taskId: "task-1", specId: "other.main" },
					],
				},
				{ tasks: [{ id: "source.main" }, { id: "other.main" }] },
			),
		/globally ambiguous/,
	);
});
test("prepared foreach materialization rejects cross-placeholder child tuples before replay", () => {
	const compiledChild = {
		id: "fan.claim-a",
		sourceGeneration: 2,
		foreachGenerated: {
			placeholderSpecId: "fan.item",
			itemIdentity: "claim-a",
			itemHash: "item-hash",
			itemSourceTaskId: "task-source",
			itemSourceSpecId: "source.main",
			itemSourceKind: "control",
			itemRef: "control:1",
		},
	};
	const runChild = {
		taskId: "task-child",
		specId: "fan.claim-a",
		sourceGeneration: 2,
		foreachGenerated: {
			...compiledChild.foreachGenerated,
			placeholderSpecId: "other.item",
		},
	};
	const run = {
		runId: "journal-cross-placeholder",
		tasks: [
			{ taskId: "task-source", specId: "source.main" },
			{ taskId: "task-parent", specId: "fan.item", kind: "foreach" },
		],
		foreachMaterializationJournal: {
			status: "prepared",
			placeholderSpecId: "fan.item",
			replacePlaceholder: true,
			generatedTasks: [compiledChild],
			generatedRunTasks: [runChild],
		},
	};
	assert.throws(
		() =>
			recoverPreparedForeachMaterializationForTests(run, {
				tasks: [
					{ id: "source.main" },
					{ id: "fan.item", foreach: {} },
				],
			}),
		/journal task mapping is invalid/,
	);
});
test("prepared compiled-only foreach replay preserves unrelated tasks and rejects cross-bound journal ids", () => {
	const itemSource = {
		itemHash: "item-hash",
		itemSourceTaskId: "task-source",
		itemSourceSpecId: "source.main",
		itemSourceKind: "control",
		itemRef: "control:1",
	};
	const generatedTask = {
		id: "fan.claim-a",
		sourceGeneration: 1,
		foreachGenerated: {
			placeholderSpecId: "fan.item",
			itemIdentity: "claim-a",
			...itemSource,
		},
	};
	const generatedRunTask = {
		taskId: "task-child",
		specId: generatedTask.id,
		sourceGeneration: 1,
		foreachGenerated: { ...generatedTask.foreachGenerated },
	};
	const journal = {
		status: "prepared",
		placeholderSpecId: "fan.item",
		replacePlaceholder: true,
		generatedTasks: [generatedTask],
		generatedRunTasks: [generatedRunTask],
	};
	const crossBoundRun = {
		runId: "compiled-only-cross-bound",
		tasks: [
			{ taskId: "task-child", specId: "source.main" },
			{
				taskId: "task-parent",
				specId: "fan.item",
				kind: "foreach",
			},
		],
		foreachMaterializationJournal: structuredClone(journal),
	};
	const crossBoundCompiled = {
		tasks: [{ id: "source.main" }, structuredClone(generatedTask)],
	};
	const crossBoundRunBefore = structuredClone(crossBoundRun);
	const crossBoundCompiledBefore = structuredClone(crossBoundCompiled);
	assert.throws(
		() =>
			recoverPreparedForeachMaterializationForTests(
				crossBoundRun,
				crossBoundCompiled,
			),
		/journal task task-child .*collides with run state|cross-bound/,
	);
	assert.deepEqual(crossBoundRun, crossBoundRunBefore);
	assert.deepEqual(crossBoundCompiled, crossBoundCompiledBefore);

	const misalignedRun = {
		runId: "compiled-only-static-misalignment",
		tasks: [
			{ taskId: "task-source", specId: "source.main" },
			{
				taskId: "task-parent",
				specId: "fan.item",
				kind: "foreach",
			},
			{ taskId: "task-summary", specId: "summary.main" },
		],
		foreachMaterializationJournal: structuredClone(journal),
	};
	const misalignedCompiled = {
		tasks: [
			{ id: "source.main" },
			structuredClone(generatedTask),
			{ id: "unexpected.main" },
		],
	};
	const misalignedRunBefore = structuredClone(misalignedRun);
	const misalignedCompiledBefore = structuredClone(misalignedCompiled);
	assert.throws(
		() =>
			recoverPreparedForeachMaterializationForTests(
				misalignedRun,
				misalignedCompiled,
			),
		/unaffected task alignment changed/,
	);
	assert.deepEqual(misalignedRun, misalignedRunBefore);
	assert.deepEqual(misalignedCompiled, misalignedCompiledBefore);
});

test("journal-less compiled-only foreach recovery requires a pristine pending placeholder", () => {
	const membership = {
		placeholderSpecId: "fan.item",
		itemIdentity: "claim-a",
	};
	const compiled = {
		tasks: [
			{ id: "source.main" },
			{ id: "fan.claim-a", foreachGenerated: membership },
		],
	};
	for (const evidence of [
		{ launchToken: "launch-token" },
		{ pid: 321 },
		{ completedAt: "2026-07-15T00:00:00.000Z" },
		{ outputRetry: { attempts: 1 } },
	]) {
		const run = {
			runId: "journal-less-non-pristine",
			tasks: [
				{ taskId: "task-source", specId: "source.main" },
				{
					taskId: "task-parent",
					specId: "fan.item",
					kind: "foreach",
					status: "pending",
					statusDetail: "pending",
					...evidence,
				},
			],
		};
		const before = structuredClone(run);
		assert.throws(
			() => reconcileForeachGeneratedRunRecords("/tmp", run, compiled),
			/not pristine pending/,
		);
		assert.deepEqual(run, before);
	}
});
test("resume revalidates status after acquiring the lease before cleanup", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		writeWorkflow(cwd);
		const specPath = join(cwd, "workflows", "wait-refresh", "spec.json");
		const spec = JSON.parse(readFileSync(specPath, "utf8"));
		const compiled = await compileWorkflow(spec, {
			cwd,
			specPath,
			task: "Resume status race.",
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		run.tasks[0].status = "failed";
		run.tasks[0].statusDetail = "failed";
		run.status = "failed";
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);

		let replaced = false;
		setRunLeaseTestHooksForTests({
			onBeforeHeartbeat({ runId, initial }) {
				if (!initial || runId !== run.runId || replaced) return;
				replaced = true;
				const persisted = JSON.parse(
					readFileSync(workflowRunPath(cwd, run.runId), "utf8"),
				);
				persisted.tasks[0].status = "completed";
				persisted.tasks[0].statusDetail = "completed";
				persisted.status = "completed";
				writeFileSync(
					workflowRunPath(cwd, run.runId),
					`${JSON.stringify(persisted, null, 2)}\n`,
				);
			},
		});
		await assert.rejects(
			() => resumeRun(cwd, run.runId),
			/resume requires a failed, interrupted, or resumable blocked run; .* is completed/,
		);
		assert.equal(replaced, true);
		assert.equal((await readRunRecord(cwd, run.runId)).status, "completed");
	} finally {
		setRunLeaseTestHooksForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("strict named diagnostics reject before any run, provenance, authority, or backend side effect", async () => {
	const cwd = makeProject();
	let backendInvocations = 0;
	const previousStrict = process.env.PI_WORKFLOW_STRICT_PROMPT_SCHEMA;
	try {
		writeAgent(cwd, "unit-scout", "read");
		writeWorkflow(cwd);
		const workflowDir = join(cwd, "workflows", "wait-refresh");
		writeFileSync(
			join(workflowDir, "control.schema.json"),
			JSON.stringify({
				type: "object",
				required: ["schema", "digest", "items"],
				properties: {
					schema: { type: "string" },
					digest: { type: "string" },
					items: {
						type: "array",
						items: {
							type: "object",
							required: ["claim"],
							properties: { claim: { type: "string" } },
						},
					},
				},
			}),
		);
		const specPath = join(workflowDir, "spec.json");
		const spec = JSON.parse(readFileSync(specPath, "utf8"));
		spec.artifactGraph.stages[0].output = {
			controlSchema: "./control.schema.json",
		};
		writeFileSync(specPath, JSON.stringify(spec));
		setSubagentApiForTests({
			async runSubagent() {
				backendInvocations += 1;
				throw new Error("backend must not be invoked");
			},
		});
		const before = projectTreeSnapshot(cwd);
		process.env.PI_WORKFLOW_STRICT_PROMPT_SCHEMA = "1";
		await assert.rejects(
			() =>
				runWorkflow("wait-refresh", cwd, {
					task: "Strict diagnostics side-effect check.",
					runId: "strict-diagnostics-no-side-effects",
				}),
			/Strict prompt\/schema validation rejected/,
		);
		assert.equal(backendInvocations, 0);
		assert.deepEqual(projectTreeSnapshot(cwd), before);
		assert.equal(
			existsSync(workflowRunDir(cwd, "strict-diagnostics-no-side-effects")),
			false,
		);
	} finally {
		if (previousStrict === undefined)
			delete process.env.PI_WORKFLOW_STRICT_PROMPT_SCHEMA;
		else process.env.PI_WORKFLOW_STRICT_PROMPT_SCHEMA = previousStrict;
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("new runs reject persisted run-id collisions and lease refusal before scheduling", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		writeWorkflow(cwd);
		const specPath = join(cwd, "workflows", "wait-refresh", "spec.json");
		const spec = JSON.parse(readFileSync(specPath, "utf8"));
		const compiled = await compileWorkflow(spec, {
			cwd,
			specPath,
			task: "Run identity collision.",
		});
		const runId = "existing-run-id";
		const { run } = await createRunRecord(cwd, compiled, specPath, { runId });
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);
		const beforeCollision = projectTreeSnapshot(cwd);
		await assert.rejects(
			() =>
				runWorkflow("wait-refresh", cwd, {
					task: "Run identity collision.",
					runId,
				}),
			/persisted run already exists/,
		);
		assert.deepEqual(projectTreeSnapshot(cwd), beforeCollision);

		const refusedRunId = "lease-refused-run-id";
		let releaseHolder;
		let holderReady;
		const holderReadyPromise = new Promise((resolve) => {
			holderReady = resolve;
		});
		const holder = withRunLease(cwd, refusedRunId, async () => {
			holderReady();
			await new Promise((resolve) => {
				releaseHolder = resolve;
			});
			return "released";
		});
		await holderReadyPromise;
		await assert.rejects(
			() =>
				runWorkflow("wait-refresh", cwd, {
					task: "Lease refusal.",
					runId: refusedRunId,
				}),
			/Could not acquire supervisor lease to initialize/,
		);
		assert.equal(existsSync(workflowRunPath(cwd, refusedRunId)), false);
		releaseHolder();
		assert.equal(await holder, "released");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("run leases release first-heartbeat failures and abort an owner after stale takeover", async () => {
	const cwd = makeProject();
	try {
		const heartbeatFailureRunId = "first-heartbeat-failure";
		setRunLeaseTestHooksForTests({
			onBeforeHeartbeat({ runId, initial }) {
				if (initial && runId === heartbeatFailureRunId) {
					throw new Error("first heartbeat failed");
				}
			},
		});
		await assert.rejects(
			() => withRunLease(cwd, heartbeatFailureRunId, async () => "unreachable"),
			/first heartbeat failed/,
		);
		setRunLeaseTestHooksForTests(undefined);
		assert.equal(
			await withRunLease(cwd, heartbeatFailureRunId, async () => "replacement"),
			"replacement",
		);

		setRunLeaseTestHooksForTests({ heartbeatIntervalMs: 1 });
		const takeoverRunId = "stale-takeover";
		let ownerReady;
		const ownerReadyPromise = new Promise((resolve) => {
			ownerReady = resolve;
		});
		const firstOwner = withRunLease(cwd, takeoverRunId, async (signal) => {
			ownerReady();
			await new Promise((_, reject) => {
				signal.addEventListener(
					"abort",
					() => reject(signal.reason),
					{ once: true },
				);
			});
			return "unreachable";
		});
		await ownerReadyPromise;
		const firstOwnerRejected = assert.rejects(firstOwner, /Lost supervisor lease/);
		const lockFile = join(
			cwd,
			".pi",
			"workflows",
			takeoverRunId,
			"supervisor.lock",
		);
		const staleAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
		writeFileSync(
			lockFile,
			`stale-owner\n99999999\n${staleAt.toISOString()}\n`,
		);
		utimesSync(lockFile, staleAt, staleAt);
		assert.equal(
			await withRunLease(cwd, takeoverRunId, async () => "takeover-owner"),
			"takeover-owner",
		);
		await firstOwnerRejected;
	} finally {
		setRunLeaseTestHooksForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});
test("run record identity and public run ids fail closed without mutation", async () => {
	const cwd = makeProject();
	try {
		for (const runId of [
			"",
			".",
			"..",
			"../escape",
			"nested/run",
			"nested\\run",
			"\0run",
			"/absolute-run",
		]) {
			assert.throws(() => workflowRunPath(cwd, runId), /Invalid workflow run id/);
			await assert.rejects(
				() => readRunRecord(cwd, runId),
				/Invalid workflow run id/,
			);
		}

		const containingRunId = "contained-run";
		mkdirSync(workflowRunDir(cwd, containingRunId), { recursive: true });
		writeFileSync(
			workflowRunPath(cwd, containingRunId),
			JSON.stringify({ runId: "rebound-run", tasks: [] }),
		);
		const before = projectTreeSnapshot(cwd);
		await assert.rejects(
			() => readRunRecord(cwd, containingRunId),
			/identity does not match containing directory/,
		);
		await assert.rejects(
			() => listRunRecords(cwd),
			/identity does not match containing directory/,
		);
		assert.deepEqual(projectTreeSnapshot(cwd), before);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("prepared invalidation journals bind ownership and unaffected order across split recovery", () => {
	const membership = {
		placeholderSpecId: "fan.item",
		itemIdentity: "claim-a",
	};
	const source = { taskId: "task-source", specId: "source.main" };
	const parent = {
		taskId: "task-parent",
		specId: "fan.item",
		kind: "foreach",
		dispatchMap: { version: 1, entries: [] },
	};
	const child = {
		taskId: "task-child",
		specId: "fan.claim-a",
		foreachGenerated: membership,
	};
	const summary = { taskId: "task-summary", specId: "summary.main" };
	const tail = { taskId: "task-tail", specId: "tail.main" };
	const compiledSource = { id: source.specId };
	const compiledParent = { id: parent.specId, foreach: {} };
	const compiledChild = { id: child.specId, foreachGenerated: membership };
	const compiledSummary = { id: summary.specId };
	const compiledTail = { id: tail.specId };
	const sourceTaskIds = [source.taskId];
	const invalidatedTaskIds = [parent.taskId, child.taskId];
	const taskOwnership = [
		{ taskId: source.taskId, specId: source.specId },
		{ taskId: parent.taskId, specId: parent.specId },
		{ taskId: child.taskId, specId: child.specId },
	];
	const makeState = () => {
		const run = {
			runId: "prepared-binding",
			tasks: [
				structuredClone(source),
				structuredClone(parent),
				structuredClone(child),
				structuredClone(summary),
				structuredClone(tail),
			],
		};
		const compiled = {
			tasks: [
				structuredClone(compiledSource),
				structuredClone(compiledParent),
				structuredClone(compiledChild),
				structuredClone(compiledSummary),
				structuredClone(compiledTail),
			],
		};
		run.invalidationJournal = {
			status: "prepared",
			artifactState: "pending",
			generation: 1,
			sourceTaskIds,
			invalidatedTaskIds,
			idempotencyKey: hashDynamicRequest({
				version: 2,
				generation: 1,
				sourceTaskIds: [...sourceTaskIds].sort(),
				invalidatedTaskIds: [...invalidatedTaskIds].sort(),
				foreachGroups: [
					{
						placeholderSpecId: parent.specId,
						parentTaskId: parent.taskId,
						dispatchMap: parent.dispatchMap,
						compiledChildren: [compiledChild],
						runChildren: [child],
					},
				],
			}),
			foreachGroups: [
				{
					placeholderSpecId: parent.specId,
					parentTaskId: parent.taskId,
					dispatchMap: parent.dispatchMap,
					compiledChildren: [structuredClone(compiledChild)],
					runChildren: [structuredClone(child)],
				},
			],
			taskOwnership: structuredClone(taskOwnership),
			unaffectedRunSignature: hashDynamicRequest([summary, tail]),
			unaffectedCompiledSignature: hashDynamicRequest([
				compiledSummary,
				compiledTail,
			]),
		};
		return { run, compiled };
	};

	const baseline = makeState();
	assert.ok(
		preparedDependencyInvalidationPlanForTests(
			baseline.run,
			baseline.compiled,
		),
	);

	const runOnly = makeState();
	runOnly.run.tasks = runOnly.run.tasks.filter(
		(task) => task.taskId !== child.taskId,
	);
	assert.ok(
		preparedDependencyInvalidationPlanForTests(runOnly.run, runOnly.compiled),
	);

	const compiledOnly = makeState();
	compiledOnly.compiled.tasks = compiledOnly.compiled.tasks.filter(
		(task) => task.id !== child.specId,
	);
	assert.ok(
		preparedDependencyInvalidationPlanForTests(
			compiledOnly.run,
			compiledOnly.compiled,
		),
	);

	const rebound = makeState();
	rebound.run.tasks.find((task) => task.taskId === child.taskId).specId =
		"fan.rebound";
	const reboundBefore = structuredClone(rebound);
	assert.throws(
		() =>
			preparedDependencyInvalidationPlanForTests(
				rebound.run,
				rebound.compiled,
			),
		/affected task ownership changed/,
	);
	assert.deepEqual(rebound, reboundBefore);

	const orderDrift = makeState();
	orderDrift.run.tasks.splice(3, 2, orderDrift.run.tasks[4], orderDrift.run.tasks[3]);
	const orderDriftBefore = structuredClone(orderDrift);
	assert.throws(
		() =>
			preparedDependencyInvalidationPlanForTests(
				orderDrift.run,
				orderDrift.compiled,
			),
		/unaffected task structure or order changed/,
	);
	assert.deepEqual(orderDrift, orderDriftBefore);

	const compiledRebound = makeState();
	compiledRebound.compiled.tasks.find(
		(task) => task.id === source.specId,
	).id = "source.rebound";
	const compiledReboundBefore = structuredClone(compiledRebound);
	assert.throws(
		() =>
			preparedDependencyInvalidationPlanForTests(
				compiledRebound.run,
				compiledRebound.compiled,
			),
		/affected compiled ownership changed/,
	);
	assert.deepEqual(compiledRebound, compiledReboundBefore);

	const compiledOrderDrift = makeState();
	compiledOrderDrift.compiled.tasks.splice(
		3,
		2,
		compiledOrderDrift.compiled.tasks[4],
		compiledOrderDrift.compiled.tasks[3],
	);
	const compiledOrderDriftBefore = structuredClone(compiledOrderDrift);
	assert.throws(
		() =>
			preparedDependencyInvalidationPlanForTests(
				compiledOrderDrift.run,
				compiledOrderDrift.compiled,
			),
		/unaffected task structure or order changed/,
	);
	assert.deepEqual(compiledOrderDrift, compiledOrderDriftBefore);

	const legacy = makeState();
	delete legacy.run.invalidationJournal.taskOwnership;
	const legacyBefore = structuredClone(legacy);
	assert.throws(
		() =>
			preparedDependencyInvalidationPlanForTests(legacy.run, legacy.compiled),
		/journal is invalid/,
	);
	assert.deepEqual(legacy, legacyBefore);
});

test("resume fences cleanup when ownership changes immediately before mutation", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		writeWorkflow(cwd);
		const specPath = join(cwd, "workflows", "wait-refresh", "spec.json");
		const spec = JSON.parse(readFileSync(specPath, "utf8"));
		const compiled = await compileWorkflow(spec, {
			cwd,
			specPath,
			task: "Fence cleanup.",
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		run.tasks[0].status = "failed";
		run.tasks[0].statusDetail = "failed";
		run.status = "failed";
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);
		const runBefore = readFileSync(workflowRunPath(cwd, run.runId), "utf8");
		const compiledBefore = readFileSync(
			compiledWorkflowPath(cwd, run.runId),
			"utf8",
		);
		let replaced = false;
		setRunLeaseTestHooksForTests({
			onBeforeLeaseOwnershipCheck({ runId }) {
				if (replaced || runId !== run.runId) return;
				replaced = true;
				writeFileSync(
					join(workflowRunDir(cwd, run.runId), "supervisor.lock"),
					"takeover-owner\n99999999\n2026-07-15T00:00:00.000Z\n",
				);
			},
		});
		await assert.rejects(() => resumeRun(cwd, run.runId), /Lost supervisor lease/);
		assert.equal(replaced, true);
		assert.equal(readFileSync(workflowRunPath(cwd, run.runId), "utf8"), runBefore);
		assert.equal(
			readFileSync(compiledWorkflowPath(cwd, run.runId), "utf8"),
			compiledBefore,
		);
	} finally {
		setRunLeaseTestHooksForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a lease action cannot succeed after another owner takes its lock", async () => {
	const cwd = makeProject();
	try {
		const runId = "resolved-after-takeover";
		await assert.rejects(
			() =>
				withRunLease(cwd, runId, async () => {
					writeFileSync(
						join(workflowRunDir(cwd, runId), "supervisor.lock"),
						"takeover-owner\n99999999\n2026-07-15T00:00:00.000Z\n",
					);
					return "stale-success";
				}),
			/Lost supervisor lease/,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a healthy old lease heartbeat is not reclaimable by absolute age alone", async () => {
	const cwd = makeProject();
	try {
		const runId = "healthy-old-heartbeat";
		const lockFile = join(workflowRunDir(cwd, runId), "supervisor.lock");
		mkdirSync(workflowRunDir(cwd, runId), { recursive: true });
		const createdAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
		writeFileSync(
			lockFile,
			`healthy-owner\n${process.pid}\n${createdAt.toISOString()}\n`,
		);
		const fresh = new Date();
		utimesSync(lockFile, fresh, fresh);
		assert.equal(
			await withRunLease(cwd, runId, async () => "must-not-acquire"),
			undefined,
		);
		assert.equal(
			readFileSync(lockFile, "utf8"),
			`healthy-owner\n${process.pid}\n${createdAt.toISOString()}\n`,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
