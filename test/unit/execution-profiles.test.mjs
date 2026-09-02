import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { compileWorkflow } from "../../.tmp/unit/compiler.js";
import { runWorkflow, waitForRun } from "../../.tmp/unit/engine.js";
import {
	parseWorkflowRunArgs,
	selectWorkflowExecutionProfile,
} from "../../.tmp/unit/extension.js";
import { parseArtifactGraphWorkflowSpec } from "../../.tmp/unit/artifact-graph-schema.js";
import { loadWorkflowSpec } from "../../.tmp/unit/schema.js";
import { compiledWorkflowPath, readRunRecord } from "../../.tmp/unit/store.js";
import { setSubagentApiForTests } from "../../.tmp/unit/subagent-backend.js";

const UNIT_TEST_ROOT = mkdtempSync(join(tmpdir(), "pi-workflow-tests-"));
const UNIT_TEST_HOME = mkdtempSync(join(UNIT_TEST_ROOT, "execution-profiles-home-"));
process.env.HOME = UNIT_TEST_HOME;
process.env.USERPROFILE = UNIT_TEST_HOME;

function cleanupUnitTestRoot() {
	if (process.exitCode !== undefined && process.exitCode !== 0) {
		console.error(`execution profile test artifacts retained at ${UNIT_TEST_ROOT}`);
		return;
	}
	rmSync(UNIT_TEST_ROOT, { recursive: true, force: true });
}

after(cleanupUnitTestRoot);
process.on("exit", cleanupUnitTestRoot);

function makeProject() {
	return mkdtempSync(join(UNIT_TEST_ROOT, "execution-profiles-"));
}

function writeAgent(cwd, name) {
	const dir = join(cwd, ".pi", "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${name}.md`),
		`---\ndescription: ${name}\ntools: ["read"]\nreadOnly: true\n---\n# ${name}\n\nUse repository evidence.\n`,
	);
}

function output() {
	return { analysis: { required: true }, refs: { required: true } };
}

function profileSpec(overrides = {}) {
	return {
		schemaVersion: 1,
		name: "profile-target",
		defaults: { agent: "unit-scout", readOnly: true, tools: ["read"] },
		executionProfiles: {
			"cost conscious": {
				one: { model: "profile/model", thinking: "low" },
				two: { thinking: "high" },
			},
			identity: {},
		},
		artifactGraph: {
			stages: [
				{
					id: "one",
					type: "single",
					thinking: "high",
					output: output(),
					prompt: "Step one.",
				},
				{
					id: "two",
					type: "single",
					thinking: "xhigh",
					output: output(),
					prompt: "Step two.",
				},
			],
		},
		...overrides,
	};
}

function foreachProfileSpec(overrides = {}) {
	return profileSpec({
		executionProfiles: {
			batched: {
				items: {
					foreachBatch: { maxItems: 2, groupBy: ["$.repository", "$.kind"] },
				},
			},
		},
		artifactGraph: {
			stages: [
				{ id: "one", type: "single", output: output(), prompt: "List items." },
				{
					id: "items",
					type: "foreach",
					from: "one",
					inputPolicy: { artifactAccess: "none" },
					each: { prompt: "Review each item." },
					output: output(),
				},
			],
		},
		...overrides,
	});
}

function nestedProfileSpec(profileTarget) {
	return profileSpec({
		executionProfiles: { custom: profileTarget },
		artifactGraph: {
			stages: [
				{
					id: "container",
					type: "dag",
					stages: [
						{ id: "child", type: "single", output: output(), prompt: "Child." },
					],
				},
			],
		},
	});
}

function writeSpec(cwd, spec) {
	const dir = join(cwd, "workflows", "profile-target");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "spec.json"), JSON.stringify(spec));
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
			"Profile task output.",
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

function installFakeSubagentApi(cwd) {
	const calls = { launches: [] };
	const launches = new Map();
	setSubagentApiForTests({
		async runSubagent(options) {
			calls.launches.push({ model: options.model, thinking: options.thinking });
			const seq = calls.launches.length;
			const runId = `run_task_${seq}`;
			const attemptId = `attempt_task_${seq}`;
			const runsDir = String(options.runsDir ?? ".pi/agent/runs");
			const artifactDir = writeCompletedSubagentArtifacts(
				cwd,
				runsDir,
				runId,
				attemptId,
			);
			launches.set(runId, { runId, attemptId, artifactDir });
			return { runId, attemptId, status: "running" };
		},
		async reconcileSubagentRun() {
			return {};
		},
		async getSubagentStatus({ runId }) {
			const run = launches.get(runId);
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
					{ type: "output", path: "output.log", artifactCwd: run.artifactDir },
					{ type: "stderr", path: "stderr.log", artifactCwd: run.artifactDir },
					{ type: "result", path: "result.json", artifactCwd: run.artifactDir },
				],
				metadata: { contextLengthExceeded: false },
				attempts: [{ attemptId: run.attemptId, status: "completed" }],
			};
		},
		async interruptSubagent() {
			return {};
		},
	});
	return calls;
}

test("execution profiles accept custom names and validate default, override, and batch shapes", () => {
	assert.doesNotThrow(() =>
			parseArtifactGraphWorkflowSpec(
			profileSpec({ defaultExecutionProfile: "cost conscious" }),
			),
	);
	assert.doesNotThrow(() =>
		parseArtifactGraphWorkflowSpec(foreachProfileSpec()),
	);
	assert.doesNotThrow(() =>
			parseArtifactGraphWorkflowSpec(
			nestedProfileSpec({ "container.child": { model: "nested/model" } }),
			),
	);

	for (const [spec, message] of [
		[
			profileSpec({ executionProfiles: { custom: { one: "low" } } }),
			/must be an object/,
		],
		[
			profileSpec({
				executionProfiles: { custom: { one: { unsupported: true } } },
			}),
			/unknown field/,
		],
		[
			profileSpec({
				executionProfiles: { custom: { missing: { thinking: "low" } } },
			}),
			/unknown stage id "missing"/,
		],
		[
			profileSpec({ executionProfiles: { custom: { one: { model: " " } } } }),
			/must be a non-empty string/,
		],
		[
			profileSpec({
				executionProfiles: { custom: { one: { thinking: "turbo" } } },
			}),
			/must be one of/,
		],
		[
			profileSpec({ defaultExecutionProfile: "missing" }),
			/must name a declared execution profile/,
		],
		[
			foreachProfileSpec({
				executionProfiles: {
					custom: { items: { foreachBatch: { maxItems: 3 } } },
				},
			}),
			/maxItems.*exactly 2/,
		],
		[
			foreachProfileSpec({
				executionProfiles: {
					custom: { items: { foreachBatch: { maxItems: 2, extra: true } } },
				},
			}),
			/unknown field/,
		],
		[
			foreachProfileSpec({
				executionProfiles: { custom: { items: { foreachBatch: "two" } } },
			}),
			/must be an object/,
		],
		[
			foreachProfileSpec({
				executionProfiles: {
					custom: { items: { foreachBatch: { maxItems: 2, groupBy: [] } } },
				},
			}),
			/groupBy.*non-empty array/,
		],
		[
			foreachProfileSpec({
				executionProfiles: {
					custom: {
						items: { foreachBatch: { maxItems: 2, groupBy: "not-a-path" } },
					},
				},
			}),
			/simple item-relative JSONPath/,
		],
		[
			profileSpec({
				executionProfiles: {
					custom: { one: { foreachBatch: { maxItems: 2 } } },
				},
			}),
			/only valid when the target is a foreach stage/,
		],
		[
			foreachProfileSpec({
				artifactGraph: {
					stages: [
						{ id: "one", type: "single", output: output(), prompt: "List." },
						{
							id: "items",
							type: "foreach",
							from: "one",
							each: { prompt: "Each." },
							output: output(),
						},
					],
				},
			}),
			/artifactAccess.*explicitly "none"/,
		],
		[
			nestedProfileSpec({ child: { thinking: "low" } }),
			/must use canonical id "container.child"/,
		],
	]) {
		assert.throws(() => parseArtifactGraphWorkflowSpec(spec), message);
	}

	const duplicateChildren = profileSpec({
		executionProfiles: { custom: { child: { thinking: "low" } } },
		artifactGraph: {
			stages: ["left", "right"].map((id) => ({
				id,
				type: "dag",
				stages: [
					{ id: "child", type: "single", output: output(), prompt: "Child." },
				],
			})),
		},
	});
	assert.throws(
		() => parseArtifactGraphWorkflowSpec(duplicateChildren),
		/ambiguous raw child stage id "child"/,
	);
});

test("bundled specs load, validate, and compile; deep-research profiles preserve exact batching semantics", async () => {
	const cwd = process.cwd();
	const specPaths = [
		"workflows/deep-research/spec.json",
		"workflows/deep-research/tiered-verification.spec.json",
		"workflows/deep-review/spec.json",
		"workflows/impact-review/spec.json",
		"workflows/spec-review/spec.json",
	];
	const loadedByPath = new Map();
	for (const specPath of specPaths) {
		const loaded = await loadWorkflowSpec(specPath, cwd);
		loadedByPath.set(specPath, loaded);
		const compiled = await compileWorkflow(loaded.spec, {
			cwd,
			specPath: loaded.specPath,
			task: "Validate bundled workflow compilation.",
		});
		assert.ok(compiled.tasks.length > 0, specPath);
	}

	const deepResearch = loadedByPath.get(
		"workflows/deep-research/spec.json",
	).spec;
	const batch = {
		maxItems: 2,
		groupBy: ["$.sourceRefs", "$.sourceUrls"],
	};
	assert.equal(deepResearch.defaultExecutionProfile, "medium");
	assert.deepEqual(deepResearch.executionProfiles, {
		low: {
			"research-questions": { thinking: "low" },
			"normalize-claims": { thinking: "medium" },
			"verify-claims": { thinking: "low", foreachBatch: batch },
			"final-audit": { thinking: "high" },
		},
		medium: {
			"verify-claims": { foreachBatch: batch },
		},
		high: {
			"research-questions": { thinking: "high" },
			"verify-claims": { thinking: "xhigh" },
		},
	});
	assert.deepEqual(
		deepResearch.executionProfiles.low["verify-claims"].foreachBatch,
		batch,
	);
	assert.deepEqual(
		deepResearch.executionProfiles.medium["verify-claims"].foreachBatch,
		batch,
	);
	assert.equal(
		deepResearch.executionProfiles.high["verify-claims"].foreachBatch,
		undefined,
	);
	for (const profile of Object.values(deepResearch.executionProfiles)) {
		for (const override of Object.values(profile))
			assert.equal(override.model, undefined);
	}
});

test("--profile parses from leading, trailing, and equals forms; quoted stays literal", () => {
	assert.equal(
		parseWorkflowRunArgs('run --profile eco profile-target "Task"').profile,
		"eco",
	);
	assert.equal(
		parseWorkflowRunArgs('run --profile=eco profile-target "Task"').profile,
		"eco",
	);
	assert.equal(
		parseWorkflowRunArgs('run profile-target "Task" --profile eco').profile,
		"eco",
	);
	assert.equal(
		parseWorkflowRunArgs('run profile-target "Keep --profile eco inside"')
			.profile,
		undefined,
	);
});

test("profile selection is explicit-first, default-aware, and supports base selection", async () => {
	const cwd = makeProject();
	try {
		writeSpec(
			cwd,
			profileSpec({
				defaultExecutionProfile: "cost conscious",
				executionProfiles: { "cost conscious": {}, zebra: {}, alpha: {} },
			}),
		);
		assert.equal(
			await selectWorkflowExecutionProfile("profile-target", cwd, undefined),
			"cost conscious",
		);
		assert.equal(
			await selectWorkflowExecutionProfile(
				"profile-target",
				cwd,
				"zebra",
				async () => {
					throw new Error("must not prompt");
				},
			),
			"zebra",
		);

		let options;
		assert.equal(
			await selectWorkflowExecutionProfile(
			"profile-target",
			cwd,
			undefined,
				async (_title, choices) => {
					options = choices;
					return choices[1];
			},
			),
			"alpha",
		);
		assert.deepEqual(options, [
			"Profile: cost conscious",
			"Profile: alpha",
			"Profile: zebra",
			"Base (no profile)",
		]);
		assert.equal(
			await selectWorkflowExecutionProfile(
				"profile-target",
				cwd,
				undefined,
				async (_title, choices) => choices.at(-1),
			),
			undefined,
			"interactive callers can explicitly run the base spec despite a default",
		);

		writeSpec(
			cwd,
			profileSpec({ executionProfiles: { zebra: {}, alpha: {} } }),
		);
		assert.equal(
			await selectWorkflowExecutionProfile("profile-target", cwd, undefined),
			undefined,
		);
		assert.equal(
			await selectWorkflowExecutionProfile(
				"profile-target",
				cwd,
				undefined,
				async (_title, choices) => {
					assert.deepEqual(choices, [
						"Profile: alpha",
						"Profile: zebra",
						"Base (no profile)",
					]);
					return "Base (no profile)";
				},
			),
			undefined,
		);
		writeSpec(cwd, profileSpec({ executionProfiles: undefined }));
		assert.equal(
			await selectWorkflowExecutionProfile("profile-target", cwd, undefined),
			undefined,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("selected profile overlays model and thinking, records complete overrides, and keeps CLI runtime overrides highest", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout");
		writeSpec(cwd, profileSpec());
		const calls = installFakeSubagentApi(cwd);

		const started = await runWorkflow("profile-target", cwd, {
			task: "Profile run.",
			executionProfile: "cost conscious",
		});
		const run = await waitForRun(cwd, started.runId, 30_000);
		assert.equal(run.status, "completed");
		assert.deepEqual(run.executionProfile, {
			name: "cost conscious",
			stageOverrides: {
				one: { model: "profile/model", thinking: "low" },
				two: { thinking: "high" },
			},
		});
		assert.deepEqual(
			await readRunRecord(cwd, run.runId).then(
				(record) => record.executionProfile,
			),
			run.executionProfile,
		);
		assert.deepEqual(calls.launches, [
			{ model: "profile/model", thinking: "low" },
			{ model: undefined, thinking: "high" },
		]);

		calls.launches.length = 0;
		const cliStarted = await runWorkflow("profile-target", cwd, {
			task: "CLI wins.",
			executionProfile: "cost conscious",
			runtimeOverrides: { model: "cli/model", thinking: "xhigh" },
		});
		await waitForRun(cwd, cliStarted.runId, 30_000);
		assert.deepEqual(calls.launches, [
			{ model: "cli/model", thinking: "xhigh" },
			{ model: "cli/model", thinking: "xhigh" },
		]);

		calls.launches.length = 0;
		writeSpec(
			cwd,
			nestedProfileSpec({
				"container.child": { model: "nested/model", thinking: "minimal" },
			}),
		);
		const nestedStarted = await runWorkflow("profile-target", cwd, {
			task: "Nested profile.",
			executionProfile: "custom",
		});
		await waitForRun(cwd, nestedStarted.runId, 30_000);
		assert.deepEqual(calls.launches, [
			{ model: "nested/model", thinking: "minimal" },
		]);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("empty profile is identity and selected foreach batches lower to compiled task metadata", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout");
		writeSpec(cwd, profileSpec());
		installFakeSubagentApi(cwd);
		const base = await runWorkflow("profile-target", cwd, {
			task: "Identity check.",
		});
		const baseCompiled = readFileSync(
			compiledWorkflowPath(cwd, base.runId),
			"utf8",
		);
		const identity = await runWorkflow("profile-target", cwd, {
			task: "Identity check.",
			executionProfile: "identity",
		});
		const identityCompiled = readFileSync(
			compiledWorkflowPath(cwd, identity.runId),
			"utf8",
		);
		assert.equal(identityCompiled, baseCompiled);

		writeSpec(cwd, foreachProfileSpec());
		const batched = await runWorkflow("profile-target", cwd, {
			task: "Batch metadata.",
			executionProfile: "batched",
		});
		const compiled = JSON.parse(
			readFileSync(compiledWorkflowPath(cwd, batched.runId), "utf8"),
		);
		const task = compiled.tasks.find((item) => item.stageId === "items");
		assert.deepEqual(task.foreach.batch, {
			maxItems: 2,
			groupBy: ["$.repository", "$.kind"],
		});
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("unknown profile name fails closed before any launch", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout");
		writeSpec(cwd, profileSpec());
		const calls = installFakeSubagentApi(cwd);
		await assert.rejects(
			() =>
				runWorkflow("profile-target", cwd, {
					task: "Bad profile.",
					executionProfile: "nope",
				}),
			/unknown execution profile "nope"; spec declares: cost conscious, identity/,
		);
		assert.equal(calls.launches.length, 0);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});
