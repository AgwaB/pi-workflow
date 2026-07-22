import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
	duplicateRunGuardNotice,
	parseWorkflowDynamicArgs,
	parseWorkflowRunArgs,
	default as workflowExtension,
} from "../../.tmp/unit/extension.js";
import {
	estimateWorkflowDurationMs,
	findDuplicateActiveRun,
	formatApproxDuration,
} from "../../.tmp/unit/run-estimates.js";
import { readIndex } from "../../.tmp/unit/store.js";
import { setSubagentApiForTests } from "../../.tmp/unit/subagent-backend.js";

const UNIT_TEST_HOME = mkdtempSync(join(tmpdir(), "run-estimates-home-"));
process.env.HOME = UNIT_TEST_HOME;
process.env.USERPROFILE = UNIT_TEST_HOME;

after(() => {
	rmSync(UNIT_TEST_HOME, { recursive: true, force: true });
});

const NOW = Date.parse("2026-07-07T12:00:00.000Z");
const MINUTE_MS = 60_000;

function makeProject() {
	return mkdtempSync(join(tmpdir(), "run-estimates-"));
}

function emptyTaskSummary() {
	return {
		pending: 0,
		running: 0,
		blocked: 0,
		completed: 0,
		failed: 0,
		skipped: 0,
		interrupted: 0,
		total: 0,
	};
}

function indexRun(runId, overrides = {}) {
	return {
		runId,
		name: "deep-research",
		type: "artifact-graph",
		status: "completed",
		taskSummary: emptyTaskSummary(),
		createdAt: new Date(NOW - 5 * MINUTE_MS).toISOString(),
		updatedAt: new Date(NOW).toISOString(),
		runJson: join(".pi", "workflows", runId, "run.json"),
		...overrides,
	};
}

function writeIndex(cwd, runs) {
	const dir = join(cwd, ".pi", "workflows");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "index.json"),
		JSON.stringify({
			schemaVersion: 1,
			updatedAt: new Date(NOW).toISOString(),
			runs,
		}),
	);
}

function writeRunFiles(cwd, runId, { run, compiled } = {}) {
	const dir = join(cwd, ".pi", "workflows", runId);
	mkdirSync(dir, { recursive: true });
	if (run !== undefined)
		writeFileSync(join(dir, "run.json"), JSON.stringify(run));
	if (compiled !== undefined)
		writeFileSync(join(dir, "compiled.json"), JSON.stringify(compiled));
}

function completedRun(runId, wallMinutes, ageMinutes, overrides = {}) {
	const createdAtMs = NOW - ageMinutes * MINUTE_MS;
	return indexRun(runId, {
		createdAt: new Date(createdAtMs).toISOString(),
		updatedAt: new Date(createdAtMs + wallMinutes * MINUTE_MS).toISOString(),
		...overrides,
	});
}

test("estimateWorkflowDurationMs returns the median of the most recent completed same-name runs", async () => {
	const cwd = makeProject();
	try {
		const runs = [];
		// 10 completed same-name runs; only the 8 most recent may be sampled.
		// Recent walls 2,4,...,16 minutes → median (8+10)/2 = 9 minutes. The two
		// oldest runs have 100-minute walls and must fall outside the sample cap.
		for (let i = 0; i < 8; i += 1) {
			runs.push(
				completedRun(`workflow_recent_${i}`, 2 * (i + 1), 60 + i * 10),
			);
		}
		runs.push(completedRun("workflow_old_1", 100, 500));
		runs.push(completedRun("workflow_old_2", 100, 510));
		// Noise that must be ignored entirely.
		runs.push(completedRun("workflow_other", 1, 30, { name: "other" }));
		runs.push(
			completedRun("workflow_child", 1, 30, {
				parentRunId: "workflow_recent_0",
			}),
		);
		runs.push(completedRun("workflow_running", 1, 30, { status: "running" }));
		writeIndex(cwd, runs);

		const estimate = await estimateWorkflowDurationMs(cwd, "deep-research");
		assert.deepEqual(estimate, { medianMs: 9 * MINUTE_MS, samples: 8 });
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("estimateWorkflowDurationMs excludes mock runs and needs at least two samples", async () => {
	const cwd = makeProject();
	try {
		writeIndex(cwd, [
			completedRun("workflow_real", 10, 60),
			completedRun("workflow_mock", 50, 30),
		]);
		writeRunFiles(cwd, "workflow_mock", {
			run: {
				schemaVersion: 1,
				runId: "workflow_mock",
				status: "completed",
				provenance: { mode: "mock-screenshot" },
				tasks: [],
			},
		});

		// Mock run filtered out → one sample left → no estimate.
		assert.equal(
			await estimateWorkflowDurationMs(cwd, "deep-research"),
			undefined,
		);
		assert.equal(await estimateWorkflowDurationMs(cwd, "unknown"), undefined);
		assert.equal(await estimateWorkflowDurationMs(cwd, undefined), undefined);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("formatApproxDuration renders compact durations", () => {
	assert.equal(formatApproxDuration(45_000), "45s");
	assert.equal(formatApproxDuration(18 * MINUTE_MS), "18m");
	assert.equal(formatApproxDuration(2 * 60 * MINUTE_MS), "2h");
	assert.equal(formatApproxDuration(125 * MINUTE_MS), "2h 5m");
});

function seedActiveDuplicate(cwd, { runId = "workflow_active1", ...rest } = {}) {
	writeIndex(cwd, [
		indexRun(runId, {
			name: "guard-target",
			status: "running",
			createdAt: new Date(NOW - 2 * MINUTE_MS).toISOString(),
			updatedAt: new Date(NOW - MINUTE_MS).toISOString(),
			...rest,
		}),
	]);
	writeRunFiles(cwd, runId, {
		run: {
			schemaVersion: 1,
			runId,
			name: "guard-target",
			status: "running",
			tasks: [],
		},
		compiled: {
			schemaVersion: 1,
			name: "guard-target",
			task: "Investigate the flaky login test",
			tasks: [],
		},
	});
	return runId;
}

test("findDuplicateActiveRun matches active same-name byte-identical-task runs within the window", async () => {
	const cwd = makeProject();
	try {
		const runId = seedActiveDuplicate(cwd);
		const target = { kind: "spec", name: "guard-target" };

		const match = await findDuplicateActiveRun(
			cwd,
			target,
			"Investigate the flaky login test",
			{ now: NOW },
		);
		assert.equal(match?.runId, runId);

		// Different task text → no duplicate.
		assert.equal(
			await findDuplicateActiveRun(cwd, target, "A different task", {
				now: NOW,
			}),
			undefined,
		);
		// Different workflow name → no duplicate.
		assert.equal(
			await findDuplicateActiveRun(
				cwd,
				{ kind: "spec", name: "other" },
				"Investigate the flaky login test",
				{ now: NOW },
			),
			undefined,
		);
		// Spec runs never satisfy a dynamic launch.
		assert.equal(
			await findDuplicateActiveRun(
				cwd,
				{ kind: "dynamic" },
				"Investigate the flaky login test",
				{ now: NOW },
			),
			undefined,
		);
		// Outside the 10-minute window → no duplicate.
		assert.equal(
			await findDuplicateActiveRun(
				cwd,
				target,
				"Investigate the flaky login test",
				{ now: NOW + 11 * MINUTE_MS },
			),
			undefined,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("findDuplicateActiveRun ignores child, terminal, and mock runs and matches dynamic runs by provenance", async () => {
	const cwd = makeProject();
	try {
		const task = "Dynamic duplicate task";
		writeIndex(cwd, [
			indexRun("workflow_dynamic1", {
				name: "dynamic",
				status: "running",
				createdAt: new Date(NOW - MINUTE_MS).toISOString(),
			}),
			indexRun("workflow_child", {
				name: "guard-target",
				status: "running",
				parentRunId: "workflow_dynamic1",
				createdAt: new Date(NOW - MINUTE_MS).toISOString(),
			}),
			indexRun("workflow_done", {
				name: "guard-target",
				status: "completed",
				createdAt: new Date(NOW - MINUTE_MS).toISOString(),
			}),
			indexRun("workflow_mockrun", {
				name: "guard-target",
				status: "running",
				createdAt: new Date(NOW - MINUTE_MS).toISOString(),
			}),
		]);
		writeRunFiles(cwd, "workflow_dynamic1", {
			run: {
				schemaVersion: 1,
				runId: "workflow_dynamic1",
				status: "running",
				provenance: { mode: "direct-dynamic" },
				tasks: [],
			},
			compiled: { schemaVersion: 1, name: "dynamic", task, tasks: [] },
		});
		for (const runId of ["workflow_child", "workflow_done", "workflow_mockrun"]) {
			writeRunFiles(cwd, runId, {
				run: {
					schemaVersion: 1,
					runId,
					status: "running",
					...(runId === "workflow_mockrun"
						? { provenance: { mode: "mock" } }
						: {}),
					tasks: [],
				},
				compiled: { schemaVersion: 1, name: "guard-target", task, tasks: [] },
			});
		}

		const match = await findDuplicateActiveRun(cwd, { kind: "dynamic" }, task, {
			now: NOW,
		});
		assert.equal(match?.runId, "workflow_dynamic1");

		// Child/terminal/mock candidates never block a spec launch.
		assert.equal(
			await findDuplicateActiveRun(
				cwd,
				{ kind: "spec", name: "guard-target" },
				task,
				{ now: NOW },
			),
			undefined,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

function writeAgent(cwd, name) {
	const dir = join(cwd, ".pi", "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${name}.md`),
		`---\ndescription: ${name}\ntools: ["read"]\nreadOnly: true\n---\n# ${name}\n\nUse repository evidence.\n`,
	);
}

function writeGuardTargetWorkflow(cwd) {
	const workflowDir = join(cwd, "workflows", "guard-target");
	mkdirSync(workflowDir, { recursive: true });
	writeFileSync(
		join(workflowDir, "spec.json"),
		JSON.stringify({
			schemaVersion: 1,
			name: "guard-target",
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
			"Guarded workflow task output.",
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
	const calls = { launches: 0 };
	const launches = new Map();
	setSubagentApiForTests({
		async runSubagent(options) {
			calls.launches += 1;
			const runId = `run_task_${calls.launches}`;
			const attemptId = `attempt_task_${calls.launches}`;
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

function captureWorkflowCommandHandler() {
	const commands = new Map();
	workflowExtension({
		on() {},
		registerCommand(name, definition) {
			commands.set(name, definition);
		},
		registerTool() {},
		sendMessage() {},
		getThinkingLevel() {
			return undefined;
		},
	});
	const command = commands.get("workflow");
	assert.ok(command, "workflow command not registered");
	return command.handler;
}

test("duplicate /workflow run start is blocked with the existing run id; --force-new and new task text start", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout");
		writeGuardTargetWorkflow(cwd);
		const existingRunId = "workflow_active1";
		writeIndex(cwd, [
			indexRun(existingRunId, {
				name: "guard-target",
				status: "running",
				createdAt: new Date(Date.now() - 2 * MINUTE_MS).toISOString(),
				updatedAt: new Date(Date.now() - MINUTE_MS).toISOString(),
			}),
		]);
		writeRunFiles(cwd, existingRunId, {
			run: {
				schemaVersion: 1,
				runId: existingRunId,
				name: "guard-target",
				status: "running",
				tasks: [],
			},
			compiled: {
				schemaVersion: 1,
				name: "guard-target",
				task: "Same task",
				tasks: [],
			},
		});

		const calls = installFakeSubagentApi(cwd);
		const handler = captureWorkflowCommandHandler();
		const notices = [];
		const ctx = {
			cwd,
			hasUI: true,
			ui: {
				notify(message, level) {
					notices.push({ message, level });
				},
				confirm: async () => true,
			},
		};

		// Routing runs first; the duplicate workflow launch itself is blocked.
		await handler('run guard-target "Same task"', ctx);
		assert.equal(notices.length, 1);
		assert.equal(notices[0].level, "warning");
		assert.match(
			notices[0].message,
			new RegExp(`Duplicate launch guard: run ${existingRunId} `),
		);
		assert.match(notices[0].message, /--force-new/);
		assert.equal(calls.launches, 1);
		assert.equal((await readIndex(cwd)).runs.length, 1);

		// --force-new bypasses the guard and starts a new run. Assertions scan
		// notices because the completion-feedback watcher may also notify.
		notices.length = 0;
		await handler('run --no-route --force-new guard-target "Same task"', ctx);
		assert.ok(
			notices.some((notice) =>
				/Workflow started: guard-target/.test(notice.message),
			),
		);
		assert.ok(
			!notices.some((notice) =>
				notice.message.includes("Duplicate launch guard"),
			),
		);
		assert.equal(calls.launches, 2);

		// Different task text starts normally without --force-new.
		notices.length = 0;
		await handler('run --no-route guard-target "A different task"', ctx);
		assert.ok(
			notices.some((notice) =>
				/Workflow started: guard-target/.test(notice.message),
			),
		);
		assert.ok(
			!notices.some((notice) =>
				notice.message.includes("Duplicate launch guard"),
			),
		);
		assert.equal(calls.launches, 3);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
	}
});

test("duplicateRunGuardNotice skips unresolvable workflow refs and blank tasks", async () => {
	const cwd = makeProject();
	try {
		assert.equal(
			await duplicateRunGuardNotice(
				cwd,
				{ kind: "spec", specRef: "no-such-workflow" },
				"Some task",
			),
			undefined,
		);
		assert.equal(
			await duplicateRunGuardNotice(cwd, { kind: "dynamic" }, "   "),
			undefined,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("parseWorkflowRunArgs and parseWorkflowDynamicArgs parse --force-new like --route", () => {
	assert.equal(
		parseWorkflowRunArgs('run --force-new review "Task"').forceNew,
		true,
	);
	assert.equal(
		parseWorkflowRunArgs('run review "Task" --force-new').forceNew,
		true,
	);
	assert.equal(parseWorkflowRunArgs('run review "Task"').forceNew, undefined);
	const literal = parseWorkflowRunArgs(
		'run review "Keep literal --force-new inside"',
	);
	assert.equal(literal.forceNew, undefined);
	assert.equal(literal.task, "Keep literal --force-new inside");
	assert.equal(parseWorkflowDynamicArgs('dynamic --force-new "Task"').forceNew, true);
	assert.equal(parseWorkflowDynamicArgs('dynamic "Task" --force-new').forceNew, true);
});
