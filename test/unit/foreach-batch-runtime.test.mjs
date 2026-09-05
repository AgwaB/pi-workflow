import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	statSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, dirname } from "node:path";
import { after, test } from "node:test";

import { buildForeachGeneratedTasks } from "../../.tmp/unit/engine-run-graph.js";
import {
	assertForeachBatchRecord,
	buildForeachBatchPrompt,
	parseForeachBatchEnvelope,
} from "../../.tmp/unit/foreach-batch-runtime.js";
import {
	refreshRun,
	resumeRun,
	runWorkflow,
	scheduleRun,
	stopRun,
	waitForRun,
} from "../../.tmp/unit/engine.js";
import {
	compiledWorkflowPath,
	readRunRecord,
	withRunLease,
	workflowRunDir,
	writeRunRecord,
} from "../../.tmp/unit/store.js";
import {
	setSubagentApiForTests,
	setSubagentLaunchControlsForTests,
} from "../../.tmp/unit/subagent-backend.js";
import { readWorkflowArtifact, handleWorkflowArtifactToolCall, setArtifactReadHookForTests } from "../../.tmp/unit/workflow-artifact-tool.js";
import { checkRequiredArtifactReads } from "../../.tmp/unit/subagent-backend.js";
import * as rawContract from "../../.tmp/unit/workflow-raw-contract.js";
const { setRawOwnerEstablishmentHookForTests } = rawContract;
import { setWorkflowOutputArtifactWriteHookForTests } from "../../.tmp/unit/workflow-output-artifacts.js";

const UNIT_TEST_ROOT = mkdtempSync(join(tmpdir(), "pi-workflow-tests-"));
const UNIT_TEST_HOME = mkdtempSync(
	join(UNIT_TEST_ROOT, "foreach-batch-runtime-home-"),
);
process.env.HOME = UNIT_TEST_HOME;
process.env.USERPROFILE = UNIT_TEST_HOME;

// Keep launch-slot timing local to this fixture. The recovery test deliberately
// leaves a supervisor watcher alive while it rewrites a launch boundary; the
// production default delay can otherwise let that watcher hold the lease until
// the assertion runs under the full concurrent suite.
setSubagentLaunchControlsForTests({ releaseDelayMs: 0, retryJitterMs: 0 });

function cleanupUnitTestRoot() {
	if (process.exitCode !== undefined && process.exitCode !== 0) {
		console.error(`foreach batch test artifacts retained at ${UNIT_TEST_ROOT}`);
		return;
	}
	rmSync(UNIT_TEST_ROOT, { recursive: true, force: true });
}

after(cleanupUnitTestRoot);
process.on("exit", cleanupUnitTestRoot);

function makeProject() {
	return mkdtempSync(join(UNIT_TEST_ROOT, "foreach-batch-runtime-"));
}

function writeAgent(cwd) {
	const dir = join(cwd, ".pi", "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "unit-scout.md"),
		'---\ndescription: unit-scout\ntools: ["read"]\nreadOnly: true\n---\n# Unit Scout\n\nUse supplied task data only.\n',
	);
}

function normalOutput(control, analysis = "normal analysis") {
	return [
		"<control>",
		JSON.stringify(control),
		"</control>",
		"<analysis>",
		analysis,
		"</analysis>",
		"<refs>",
		"[]",
		"</refs>",
	].join("\n");
}

function batchOutput(items) {
	return normalOutput(
		{
			schema: "workflow-foreach-batch-v1",
			items,
		},
		"batch outer analysis",
	);
}

function writeWorkflow(
	cwd,
	name,
	{
		itemCount = 3,
		maxConcurrency = 2,
		groupBy,
		stageMaxConcurrency,
	} = {},
) {
	const dir = join(cwd, "workflows", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "spec.json"),
		JSON.stringify({
			schemaVersion: 1,
			name,
			defaults: { agent: "unit-scout", readOnly: true, tools: ["read"] },
			executionProfiles: {
				batched: {
					fan: {
						foreachBatch: {
							maxItems: 2,
							...(groupBy === undefined ? {} : { groupBy }),
						},
					},
				},
			},
			artifactGraph: {
				maxConcurrency,
				stages: [
					{
						id: "source",
						type: "single",
						prompt: "Produce items.",
						output: { analysis: { required: true }, refs: { required: true } },
					},
					{
						id: "fan",
						type: "foreach",
						from: { source: "source", path: "$.items" },
						...(stageMaxConcurrency === undefined
							? {}
							: { maxConcurrency: stageMaxConcurrency }),
						inputPolicy: { artifactAccess: "none" },
						each: { prompt: "Independently review ${item}." },
						output: { analysis: { required: true }, refs: { required: true } },
					},
					{
						id: "downstream",
						type: "single",
						after: ["fan"],
						prompt: "Finish after every fan item.",
						output: { analysis: { required: true }, refs: { required: true } },
					},
				],
			},
		}),
	);
	return Array.from({ length: itemCount }, (_, index) => ({
		id: `item-${index + 1}`,
		kind: "review",
	}));
}

function writeSubagentArtifacts(cwd, runsDir, runId, attemptId, output, correlationId) {
	const dir = join(cwd, runsDir, runId, "attempts", attemptId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "output.log"), output);
	writeFileSync(join(dir, "stderr.log"), "");
	writeFileSync(
		join(dir, "result.json"),
		JSON.stringify({
			runId,
			attemptId,
			status: "completed",
			startedAt: new Date(Date.now() - 100).toISOString(),
			completedAt: new Date().toISOString(),
			exitCode: 0,
		}),
	);
	writeFileSync(join(cwd, runsDir, runId, "run.json"), JSON.stringify({
		runId, correlationId, latestAttemptId: attemptId, activeAttemptId: null,
		status: "completed", attempts: [{ attemptId, status: "completed" }],
	}));
	return dir;
}

function idsFromBatchPrompt(prompt) {
	const match = prompt.match(
		/"expectedIds"\s*:\s*\[\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\]/,
	);
	assert.ok(match, "synthetic prompt must carry two expected logical task ids");
	return [match[1], match[2]];
}

function fakeApi({
	cwd,
	items,
	batchItemFactory,
	batchItemsTransform = (rows) => rows,
	delayedBatch = false,
	failBatchLaunchOnce = false,
	throwBatchPoll = false,
	durableBarrier = false,
}) {
	const runs = new Map();
	const launches = [];
	const interrupts = [];
	let batchCompleted = !delayedBatch;
	let batchLaunchFailed = false;
	let batchStatusCalls = 0;
	let barrierCount = 0;
	const barriers = new Map();
	return {
		launches,
		interrupts,
		setBatchCompleted(value) {
			batchCompleted = value;
		},
		batchStatusCalls() {
			return batchStatusCalls;
		},
		api: {
			...(durableBarrier
				? {
						async createDurableLaunchBarrierV2(options) {
							barrierCount += 1;
							const barrier = {
								schema: "pi-subagent-durable-launch-barrier-v2",
								identitySha256: createHash("sha256")
									.update(`barrier-${barrierCount}`)
									.digest("hex"),
								directory: options.directory,
								readyPath: join(options.directory, "ready-v2.json"),
								decisionPath: join(options.directory, "decision-v2.json"),
								ackPath: join(options.directory, "ack-v2.json"),
								challenge: "1".repeat(64),
								decisionNonce: "7".repeat(64),
								subjectSha256: options.subjectSha256,
								...(options.authorityBindingSha256 === undefined
									? {}
									: {
											authorityBindingSha256:
												options.authorityBindingSha256,
										}),
								directoryIdentity: { device: 1, inode: barrierCount },
								timeoutMs: options.timeoutMs,
								pollIntervalMs: 10,
							};
							barriers.set(barrier.identitySha256, { barrier });
							return barrier;
						},
						durableLaunchBarrierDigest(value) {
							return createHash("sha256")
								.update(JSON.stringify(value))
								.digest("hex");
						},
						async waitForDurableLaunchBarrierV2Ready(barrier) {
							const launch = launches.at(-1);
							assert.ok(launch, "barrier ready requires a launched worker");
							const ready = {
								schema: "pi-subagent-durable-launch-barrier-ready-v2",
								barrierIdentitySha256: barrier.identitySha256,
								challenge: barrier.challenge,
								decisionNonce: barrier.decisionNonce,
								subjectSha256: barrier.subjectSha256,
								...(barrier.authorityBindingSha256 === undefined
									? {}
									: {
											authorityBindingSha256:
												barrier.authorityBindingSha256,
										}),
								runId: launch.runId,
								attemptId: launch.attemptId,
								workerPid: 101,
								readySha256: "2".repeat(64),
								launchPayloadSha256: "3".repeat(64),
								executionPlanSha256: "6".repeat(64),
							};
							barriers.get(barrier.identitySha256).ready = ready;
							return ready;
						},
						async resolveDurableLaunchBarrierV2Release(
							barrier,
							ready,
							releasePayloadSha256,
						) {
							const state = barriers.get(barrier.identitySha256);
							state.decision ??= {
								schema: "pi-subagent-durable-launch-barrier-decision-v2",
								kind: "released",
								barrierIdentitySha256: barrier.identitySha256,
								challenge: barrier.challenge,
								decisionNonce: barrier.decisionNonce,
								subjectSha256: barrier.subjectSha256,
								...(barrier.authorityBindingSha256 === undefined
									? {}
									: {
											authorityBindingSha256:
												barrier.authorityBindingSha256,
										}),
								runId: ready.runId,
								attemptId: ready.attemptId,
								readySha256: ready.readySha256,
								releasePayloadSha256,
								decisionSha256: "4".repeat(64),
							};
							return {
								outcome: state.decision.kind,
								decision: state.decision,
							};
						},
						async revokeDurableLaunchBarrierV2(barrier, options) {
							const state = barriers.get(barrier.identitySha256);
							state.decision ??= {
								schema: "pi-subagent-durable-launch-barrier-decision-v2",
								kind: "revoked",
								barrierIdentitySha256: barrier.identitySha256,
								challenge: barrier.challenge,
								decisionNonce: barrier.decisionNonce,
								subjectSha256: barrier.subjectSha256,
								...(barrier.authorityBindingSha256 === undefined
									? {}
									: {
											authorityBindingSha256:
												barrier.authorityBindingSha256,
										}),
								cancellationId: options.cancellationId,
								reasonSha256: options.reasonSha256,
								decisionSha256: "8".repeat(64),
							};
							return {
								outcome: state.decision.kind,
								decision: state.decision,
							};
						},
						async readDurableLaunchBarrierV2State(barrier) {
							const state = barriers.get(barrier.identitySha256);
							return {
								...(state.ready ? { ready: state.ready } : {}),
								...(state.decision ? { decision: state.decision } : {}),
								...(state.ack ? { ack: state.ack } : {}),
							};
						},
						async waitForDurableLaunchBarrierV2Ack(barrier, release) {
							const state = barriers.get(barrier.identitySha256);
							state.ack = {
								schema: "pi-subagent-durable-launch-barrier-ack-v2",
								barrierIdentitySha256: barrier.identitySha256,
								challenge: barrier.challenge,
								decisionNonce: barrier.decisionNonce,
								runId: release.runId,
								attemptId: release.attemptId,
								readySha256: release.readySha256,
								decisionSha256: release.decisionSha256,
								ackSha256: "5".repeat(64),
							};
							return state.ack;
						},
					}
				: {}),
			async runSubagent(options) {
				const index = launches.length + 1;
				const prompt = String(options.task);
				const runId = `run_foreach_batch_${index}`;
				const attemptId = `attempt_foreach_batch_${index}`;
				const runsDir = String(options.runsDir);
				let output;
				let kind = "singleton";
				if (prompt.includes("Produce items.")) {
					kind = "source";
					output = normalOutput({
						schema: "stage-control-v1",
						digest: "source",
						items,
					});
				} else if (prompt.includes("Workflow Foreach Batch Protocol v1")) {
					kind = "batch";
					if (failBatchLaunchOnce && !batchLaunchFailed) {
						batchLaunchFailed = true;
						launches.push({ runId, attemptId, kind: "batch-failed", prompt });
						throw new Error("simulated batch launch failure");
					}
					const ids = idsFromBatchPrompt(prompt);
					output = batchOutput(
						batchItemsTransform(
							ids.map((id, itemIndex) => batchItemFactory(id, itemIndex)),
						),
					);
				} else if (prompt.includes("Finish after every fan item.")) {
					kind = "downstream";
					output = normalOutput({
						schema: "stage-control-v1",
						digest: "downstream",
					});
				} else {
					const taskId = prompt.match(/item=(task-\d+)/)?.[1] ?? "singleton";
					output = normalOutput({ schema: "stage-control-v1", digest: taskId });
				}
				const artifactDir = writeSubagentArtifacts(
					cwd,
					runsDir,
					runId,
					attemptId,
					output,
					options.correlationId,
				);
				launches.push({ runId, attemptId, kind, prompt, artifactDir });
				runs.set(runId, { runId, attemptId, kind, artifactDir });
				return { runId, attemptId, status: "running" };
			},
			async reconcileSubagentRun() {
				return {};
			},
			async getSubagentStatus({ runId }) {
				const run = runs.get(runId);
				assert.ok(run, `unknown fake run ${runId}`);
				if (run.kind === "batch") {
					batchStatusCalls += 1;
					if (throwBatchPoll) throw new Error("simulated batch poll failure");
					if (!batchCompleted) {
						return {
							runId,
							attemptId: run.attemptId,
							backend: "headless",
							status: "running",
							failureKind: null,
							startedAt: new Date(Date.now() - 100).toISOString(),
							completedAt: null,
							logs: [],
							attempts: [{ attemptId: run.attemptId, status: "running" }],
						};
					}
				}
				return {
					runId,
					attemptId: run.attemptId,
					backend: "headless",
					status: "completed",
					failureKind: null,
					startedAt: new Date(Date.now() - 100).toISOString(),
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
					attempts: [{ attemptId: run.attemptId, status: "completed" }],
				};
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
		},
	};
}

async function persistTerminalBatchBoundary(cwd, runId, fake) {
	const run = await readRunRecord(cwd, runId);
	const record = run.foreachBatches?.[0];
	assert.ok(record, "expected one durable batch record");
	const launch = fake.launches.find((candidate) => candidate.kind === "batch");
	assert.ok(launch, "expected physical batch launch");
	const rawOutput = readFileSync(
		join(launch.artifactDir, "output.log"),
		"utf8",
	);
	const directory = join(
		workflowRunDir(cwd, runId),
		"foreach-batches",
		createHash("sha256").update(record.batchId).digest("hex"),
	);
	mkdirSync(directory, { recursive: true });
	const rawFile = join(directory, `raw-attempt-${record.attempt}.md`);
	const receiptFile = join(directory, `receipt-attempt-${record.attempt}.json`);
	writeFileSync(rawFile, rawOutput);
	writeFileSync(receiptFile, JSON.stringify({ schema: "test-receipt" }));
	record.phase = "terminal_received";
	record.terminal = {
		receivedAt: new Date().toISOString(),
		rawPath: relative(cwd, rawFile),
		receiptPath: relative(cwd, receiptFile),
		rawSha256: createHash("sha256").update(rawOutput).digest("hex"),
		status: "completed",
		completedAt: new Date().toISOString(),
		exitCode: 0,
	};
	for (const member of record.members) {
		const task = run.tasks.find(
			(candidate) => candidate.taskId === member.taskId,
		);
		assert.ok(task, `missing ${member.taskId}`);
		task.foreachBatch = {
			batchId: record.batchId,
			role: member.role,
			phase: "terminal_received",
		};
		task.status = "running";
		task.statusDetail = "batch_terminal_received";
	}
	await withRunLease(cwd, runId, async () => {
		await writeRunRecord(cwd, run);
	});
	return { rawFile, record };
}

test("batch group keys persist from raw items and envelope ids are strict", () => {
	const template = {
		id: "fan",
		stageId: "fan",
		foreach: {
			prompt: "Review ${item}",
			injectRuntimeTask: false,
			batch: { maxItems: 2, groupBy: ["$.repository", "$.kind"] },
		},
	};
	const grouped = buildForeachGeneratedTasks(template, undefined, [
		{ repository: { b: 2, a: 1 } },
		{ repository: { a: 1, b: 2 } },
		{ repository: "" },
	]);
	assert.equal(grouped.error, undefined);
	assert.equal(
		grouped.tasks[0].foreachGenerated.batch.groupKey,
		'{"a":1,"b":2}',
	);
	assert.equal(
		grouped.tasks[1].foreachGenerated.batch.groupKey,
		grouped.tasks[0].foreachGenerated.batch.groupKey,
	);
	assert.deepEqual(grouped.tasks[2].foreachGenerated.batch, {
		enabled: true,
		groupBy: true,
	});

	const valid = batchOutput([
		{
			id: "task-2",
			control: { schema: "stage-control-v1" },
			analysis: "a",
			refs: [],
		},
		{
			id: "task-3",
			control: { schema: "stage-control-v1" },
			analysis: "b",
			refs: [],
		},
	]);
	assert.equal(
		parseForeachBatchEnvelope(valid, ["task-2", "task-3"]).valid,
		true,
	);
	for (const items of [
		[{ id: "task-2", control: {}, analysis: "a", refs: [] }],
		[
			{ id: "task-2", control: {}, analysis: "a", refs: [] },
			{ id: "task-2", control: {}, analysis: "b", refs: [] },
		],
		[
			{ id: "task-2", control: {}, analysis: "a", refs: [], extra: true },
			{ id: "task-3", control: {}, analysis: "b", refs: [] },
		],
	]) {
		assert.equal(
			parseForeachBatchEnvelope(batchOutput(items), ["task-2", "task-3"]).valid,
			false,
		);
	}
});

test("batch prompt makes nested JSON decoding explicit and preserves decoded prepared prompts", () => {
	const itemPrompts = [
		'Copy payload {"value":"quoted \\"alpha\\" and slash \\\\ path"}.',
		"Copy payload with a real newline:\nsecond line.",
	];
	const prompt = buildForeachBatchPrompt({
		leader: {},
		items: [
			{ id: "task-1", prompt: itemPrompts[0] },
			{ id: "task-2", prompt: itemPrompts[1] },
		],
	});
	assert.match(prompt, /Parse it as JSON before processing either item/);
	assert.match(prompt, /never from its displayed serialized representation/);
	assert.match(prompt, /same threshold you would use if that item were the only task/);
	const encoded = prompt.split("# Untrusted Prepared Item Tasks\n\n")[1];
	let decoded;
	try {
		decoded = JSON.parse(encoded);
	} catch (error) {
		assert.fail(`batch prompt must end in valid JSON: ${String(error)}`);
	}
	assert.deepEqual(
		decoded.items.map((item) => item.taskPrompt),
		itemPrompts,
	);
});

test("persisted batch phases and phase-dependent receipts fail closed", () => {
	const digest = "a".repeat(64);
	const base = {
		version: 1,
		batchId: "batch-1",
		placeholderSpecId: "fan",
		grouping: { enabled: true, groupBy: false },
		executionSurfaceSha256: digest,
		members: [
			{
				taskId: "task-1",
				specId: "fan.task-1",
				role: "leader",
				preparedPrompt: "one",
				preparedPromptSha256: digest,
			},
			{
				taskId: "task-2",
				specId: "fan.task-2",
				role: "member",
				preparedPrompt: "two",
				preparedPromptSha256: digest,
			},
		],
		attempt: 1,
		preparedAt: new Date().toISOString(),
		batchPrompt: "prompt",
		batchPromptSha256: digest,
	};
	assert.throws(
		() => assertForeachBatchRecord({ ...base, phase: "unknown" }),
		/ownership record is invalid/,
	);
	assert.throws(
		() => assertForeachBatchRecord({ ...base, phase: "terminal_received" }),
		/no terminal receipt/,
	);
	assert.throws(
		() => assertForeachBatchRecord({ ...base, phase: "completed" }),
		/completed without a commit receipt/,
	);
	assert.throws(
		() => assertForeachBatchRecord({ ...base, phase: "fallback_prepared" }),
		/without fallback evidence/,
	);
});

test("groupBy separates adjacent keys and a missing key is singleton-only", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd);
		writeWorkflow(cwd, "batch-grouping", { itemCount: 3, groupBy: "$.group" });
		const items = [
			{ id: "item-a", group: "a" },
			{ id: "item-b", group: "b" },
			{ id: "item-none" },
		];
		const fake = fakeApi({
			cwd,
			items,
			batchItemFactory() {
				throw new Error("different or missing group keys must not be paired");
			},
		});
		setSubagentApiForTests(fake.api);
		const started = await runWorkflow("batch-grouping", cwd, {
			task: "Keep groups separate.",
			executionProfile: "batched",
		});
		const completed = await waitForRun(cwd, started.runId, 20_000);
		assert.equal(completed.status, "completed");
		assert.deepEqual(
			fake.launches.map((launch) => launch.kind),
			["source", "singleton", "singleton", "singleton", "downstream"],
		);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("profile-only batching uses one physical launch, preserves per-item artifacts, downstream, and logical slots", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd);
		const items = writeWorkflow(cwd, "batch-valid");
		items.forEach((item, index) => { item.id = ["A", "B", "C"][index]; });
		const specPath = join(cwd, "workflows", "batch-valid", "spec.json");
		const spec = JSON.parse(readFileSync(specPath, "utf8"));
		spec.artifactGraph.stages[2].from = "fan";
		writeFileSync(specPath, JSON.stringify(spec));
		const fake = fakeApi({
			cwd,
			items,
			durableBarrier: true,
			delayedBatch: true,
			batchItemFactory: (id) => ({
				id,
				control: { schema: "stage-control-v1", digest: `batch-${id}` },
				analysis: `analysis for ${id}`,
				refs: [],
			}),
		});
		setSubagentApiForTests(fake.api);
		const started = await runWorkflow("batch-valid", cwd, {
			task: "Run batched items.",
			executionProfile: "batched",
		});

		// Complete source and launch the pair. The tail must remain pending while
		// two logical member records occupy maxConcurrency=2.
		await refreshRun(cwd, started.runId);
		await scheduleRun(cwd, started.runId);
		const active = await readRunRecord(cwd, started.runId);
		assert.deepEqual(
			fake.launches.map((launch) => launch.kind),
			["source", "batch"],
		);
		assert.equal(
			active.tasks.filter((task) => task.status === "running").length,
			2,
		);
		const batch = active.foreachBatches?.[0];
		assert.ok(batch, "batch ownership must be durable before launch");
		assert.equal(batch.members.length, 2);
		assert.match(batch.stateRootSha256, /^[a-f0-9]{64}$/u);
		assert.match(batch.capabilitySubjectSha256, /^[a-f0-9]{64}$/u);
		assert.equal(batch.dispatch?.state, "reserved");
		assert.equal(
			active.tasks.find((task) => task.foreachBatch?.role === "leader")
				?.durableLaunchBarrier?.records.at(-1)?.phase,
			"acknowledged",
		);
		assert.equal(
			active.tasks.find((task) => task.foreachBatch?.role === "member")
				?.backendHandle,
			undefined,
			"member must never own a backend handle",
		);
		await refreshRun(cwd, started.runId);
		assert.equal(fake.batchStatusCalls(), 1, "only the leader is polled");
		assert.equal(
			fake.launches.length,
			2,
			"tail cannot launch while pair occupies two slots",
		);

		fake.setBatchCompleted(true);
		const completed = await waitForRun(cwd, started.runId, 20_000);
		assert.equal(completed.status, "completed");
		assert.deepEqual(
			fake.launches.map((launch) => launch.kind),
			["source", "batch", "singleton", "downstream"],
		);
		const completedBatch = completed.foreachBatches?.[0];
		assert.equal(completedBatch?.dispatch?.state, "reconciled");
		assert.equal(
			completedBatch?.physicalExecution?.leaderTaskId,
			completedBatch?.members.find((member) => member.role === "leader")?.taskId,
		);
		assert.ok(
			completedBatch?.physicalExecution?.timing,
			"physical batch timing must be attributed once at batch level",
		);
		// Exercise every logical item (especially the handle-less follower), not
		// just the physical leader or filesystem bytes. Normal host commits must
		// have persisted each anchor; tests never synthesize an integrity record.
		const persisted = await readRunRecord(cwd, started.runId);
		const runDir = workflowRunDir(cwd, started.runId);
		const downstream = persisted.tasks.find(task => task.stageId === "downstream");
		const consumer = dirname(join(cwd, downstream.files.result));
		const manifestPath = join(consumer, "source-manifest.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		assert.deepEqual(manifest.sources.map(source => source.source), ["fan", "fan.b", "fan.c"]);
		for (const source of manifest.sources) {
			const task = persisted.tasks.find(task => task.taskId === source.taskId);
			const path = join(dirname(join(cwd, task.files.result)), "raw.md");
			const raw = readFileSync(path, "utf8");
			assert.ok(task.rawArtifactIntegrity, `host anchor for ${task.taskId}`);
			assert.equal(statSync(path).nlink, task.foreachBatch ? 2 : 3);
			assert.equal(source.artifacts.raw.path, path);
			const full = await readWorkflowArtifact(manifest, source.source, "raw", { runDir, maxBytes: 65536 });
			assert.equal(full.content, raw);
			assert.equal(full.returnedBytes, Buffer.byteLength(raw));
			assert.equal(full.truncated, false);
			assert.equal(full.rawAssurance.kind, "host_digest_verified");
			const config = { runId: started.runId, taskId: downstream.taskId, runDir, manifestPath, ledgerPath: join(consumer, `${task.taskId}-ledger.jsonl`) };
			// requiredReads reads read-ledger.jsonl, reset it per logical source.
			config.ledgerPath = join(consumer, "read-ledger.jsonl");
			writeFileSync(config.ledgerPath, "");
			const prefix = await readWorkflowArtifact(manifest, source.source, "raw", { runDir, maxBytes: 19 });
			assert.equal(prefix.content, raw.slice(0, 19));
			assert.equal(prefix.returnedBytes, 19);
			assert.equal(prefix.rawAssurance.kind, "host_digest_verified");
			await handleWorkflowArtifactToolCall({ action: "read", source: source.source, artifact: "raw" }, { ...config, maxBytes: 19 });
			assert.deepEqual((await checkRequiredArtifactReads(consumer, [`${source.source}.raw`])).missing, [`${source.source}.raw`]);
			const tool = await handleWorkflowArtifactToolCall({ action: "read", source: source.source, artifact: "raw" }, config);
			assert.equal(tool.details.rawAssurance.kind, "host_digest_verified");
			assert.deepEqual((await checkRequiredArtifactReads(consumer, [`${source.source}.raw`])).missing, []);
		}
		for (const field of ['taskId','specId','stageId','generation','sourceGeneration','source']) {
			const forged=structuredClone(manifest),source=forged.sources[0];
			source[field]=field.includes('Generation')||field==='generation'?999:'foreign';
			await assert.rejects(()=>readWorkflowArtifact(forged,source.source,'raw',{runDir}));
		}
		const ambiguous=structuredClone(manifest);
		delete ambiguous.sources[0].taskId;delete ambiguous.sources[0].specId;
		await assert.rejects(()=>readWorkflowArtifact(ambiguous,'fan','raw',{runDir}));
		const fanTasks = completed.tasks.filter((task) => task.stageId === "fan");
		assert.equal(fanTasks.length, 3);
		for (const task of fanTasks) {
			assert.equal(task.status, "completed");
			const control = JSON.parse(
				readFileSync(join(cwd, task.files.result), "utf8"),
			);
			assert.equal(control.status, "completed");
			assert.ok(
				readFileSync(join(cwd, task.files.output), "utf8").includes(
					"<control>",
				),
			);
		}
		assert.equal(
			completed.tasks.find((task) => task.stageId === "downstream")?.status,
			"completed",
		);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("scheduler persisted dynamic export manifest reads exact full/truncated raw and rejects forged tuples/aliases", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd);
		const dir = join(cwd, "workflows", "raw-dynamic-export");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "controller.mjs"), `export default async function(ctx) {
		 const output = await ctx.agent({id:'synthesis',agent:'unit-scout',tools:['read'],prompt:'Synthesize local output.'});
		 return {control:{schema:'dynamic-controller-result-v1',digest:'done',outputTasks:[output.specId]},analysis:'Controller evidence é 🎯',refs:[]};
		}`);
		writeFileSync(join(dir, "spec.json"), JSON.stringify({schemaVersion:1,name:'raw-dynamic-export',defaults:{agent:'unit-scout',readOnly:true,tools:['read']},artifactGraph:{stages:[
		 {id:'adaptive',type:'dynamic',dynamic:{uses:'./controller.mjs'}},
		 {id:'consumer',type:'single',from:'adaptive',prompt:'Finish after every fan item.'}
		]}}));
		const fake = fakeApi({cwd,items:[],durableBarrier:true});
		setSubagentApiForTests(fake.api);
		const started = await runWorkflow('raw-dynamic-export',cwd,{task:'Local dynamic export'});
		const terminal = await waitForRun(cwd,started.runId,20000);
		assert.equal(terminal.status,'completed');
		const run = await readRunRecord(cwd,started.runId), runDir = workflowRunDir(cwd,run.runId);
		const consumerTask = run.tasks.find(task=>task.stageId==='consumer');
		const consumer = dirname(join(cwd,consumerTask.files.result)), manifestPath=join(consumer,'source-manifest.json');
		const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
		assert.deepEqual(manifest.sources.map(source=>source.source),['adaptive','adaptive.output']);
		const config={runId:run.runId,taskId:consumerTask.taskId,runDir,manifestPath,ledgerPath:join(consumer,'read-ledger.jsonl')};
		for(const source of manifest.sources){
		 const task=run.tasks.find(task=>task.taskId===source.taskId),raw=readFileSync(source.artifacts.raw.path,'utf8');
		 assert.ok(task.rawArtifactIntegrity);
		 assert.deepEqual(JSON.parse(readFileSync(join(cwd,task.files.result),'utf8')).rawIntegrity,task.rawArtifactIntegrity);
		 for(const maxBytes of [17,65536]){
		  const read=await readWorkflowArtifact(manifest,source.source,'raw',{runDir,maxBytes});
		  assert.equal(read.content,maxBytes===17?raw.slice(0,17):raw);
		  assert.equal(read.bytes,Buffer.byteLength(raw));assert.equal(read.returnedBytes,maxBytes===17?17:Buffer.byteLength(raw));
		  assert.equal(read.truncated,maxBytes===17);assert.equal(read.rawAssurance.kind,'host_digest_verified');
		 }
		 writeFileSync(config.ledgerPath,'');
		 const prefix=await handleWorkflowArtifactToolCall({action:'read',source:source.source,artifact:'raw'},{...config,maxBytes:17});
		 assert.equal(prefix.details.rawAssurance.kind,'host_digest_verified');
		 assert.deepEqual((await checkRequiredArtifactReads(consumer,[`${source.source}.raw`])).missing,[`${source.source}.raw`]);
		 const full=await handleWorkflowArtifactToolCall({action:'read',source:source.source,artifact:'raw'},config);
		 assert.equal(full.details.rawAssurance.kind,'host_digest_verified');
		 assert.deepEqual((await checkRequiredArtifactReads(consumer,[`${source.source}.raw`])).missing,[]);
		}
		for(const kind of ['taskId','specId','stageId','generation','sourceGeneration','missing-task','missing-spec','missing-stage','fabricated-alias','foreign-export','duplicate-alias','foreign-run','controller-generation']){
		 const forged=structuredClone(manifest),source=forged.sources[1];
		 if(['taskId','specId','stageId'].includes(kind)) source[kind]='foreign';
		 if(['generation','sourceGeneration'].includes(kind)) source[kind]=999;
		 if(kind.startsWith('missing-')) delete source[{'missing-task':'taskId','missing-spec':'specId','missing-stage':'stageId'}[kind]];
		 if(kind==='fabricated-alias') source.source='arbitrary.output';
		 if(kind==='foreign-export') {const other=forged.sources[0];Object.assign(source,{taskId:other.taskId,specId:other.specId,stageId:other.stageId,generation:other.generation,sourceGeneration:other.sourceGeneration,artifacts:other.artifacts});}
		 if(kind==='duplicate-alias') forged.sources.push(structuredClone(source));
		 if(kind==='foreign-run') forged.runId='foreign';
		 if(kind==='controller-generation') forged.sources[0].generation=999;
		 await assert.rejects(()=>readWorkflowArtifact(forged,source.source,'raw',{runDir}),kind);
		}
		const controller=run.tasks.find(task=>task.kind==='dynamic');
		const controlPath=join(dirname(join(cwd,controller.files.result)),'control.json');
		const controlText=readFileSync(controlPath,'utf8');
		writeFileSync(config.ledgerPath,'');
		setArtifactReadHookForTests(async()=>{
		 setArtifactReadHookForTests(undefined);
		 const control=JSON.parse(controlText);control.outputTasks=[controller.specId];
		 writeFileSync(controlPath,JSON.stringify(control));
		});
		await assert.rejects(()=>handleWorkflowArtifactToolCall({action:'read',source:'adaptive.output',artifact:'raw'},config));
		assert.equal(readFileSync(config.ledgerPath,'utf8'),'','changed export resolution cannot publish a ledger row');
		assert.deepEqual((await checkRequiredArtifactReads(consumer,['adaptive.output.raw'])).missing,['adaptive.output.raw']);
		writeFileSync(controlPath,controlText);
	} finally {setArtifactReadHookForTests(undefined);setSubagentApiForTests(undefined);rmSync(cwd,{recursive:true,force:true});}
});

for (const kind of ['backend','salvage','batch','dynamic']) for (const drift of (kind==='dynamic'?['run','task']:['run','task','mirror','attempt'])) test(`explicit ${kind} host rejects joined pre-establishment ${drift} drift`, async () => {
 const cwd=makeProject();let hits=0;let rejectedTaskDir;
 try {
  writeAgent(cwd);
  let items=[];
  if(kind==='batch')items=writeWorkflow(cwd,'owner-drift');
  else {
   const dir=join(cwd,'workflows','owner-drift');mkdirSync(dir,{recursive:true});
   writeFileSync(join(dir,'controller.mjs'),`export default function(){return {control:{schema:'dynamic-controller-result-v1',digest:'done'},analysis:'Fresh dynamic body',refs:[]}}`);
   writeFileSync(join(dir,'spec.json'),JSON.stringify({schemaVersion:1,name:'owner-drift',defaults:{agent:'unit-scout',readOnly:true,tools:['read']},artifactGraph:{stages:[kind==='dynamic'?{id:'producer',type:'dynamic',dynamic:{uses:'./controller.mjs'}}:{id:'producer',type:'single',prompt:'Local valid body.'}]}}));
  }
  const fake=fakeApi({cwd,items,durableBarrier:true,batchItemFactory:id=>({id,control:{schema:'stage-control-v1',digest:id},analysis:'batch evidence',refs:[]})});
  if(kind==='salvage'){
   const get=fake.api.getSubagentStatus;
   fake.api.getSubagentStatus=async options=>{
    const status=await get(options),attemptDir=status.logs[0].artifactCwd,mirrorPath=join(dirname(dirname(attemptDir)),'run.json');
    const terminalPath=join(attemptDir,'result.json'),terminal=JSON.parse(readFileSync(terminalPath,'utf8')),mirror=JSON.parse(readFileSync(mirrorPath,'utf8'));
    terminal.status='failed';mirror.status='failed';mirror.attempts[0].status='failed';
    writeFileSync(terminalPath,JSON.stringify(terminal));writeFileSync(mirrorPath,JSON.stringify(mirror));
    return {...status,status:'failed',failureKind:'model',metadata:{stopReason:'end',contextLengthExceeded:false}};
   };
  }
  setSubagentApiForTests(fake.api);
  setRawOwnerEstablishmentHookForTests(async taskDir=>{
   const runPath=join(dirname(dirname(taskDir)),'run.json'),run=JSON.parse(readFileSync(runPath,'utf8'));
   const task=run.tasks.find(task=>dirname(join(cwd,task.files.result))===taskDir);
   if(kind==='batch'&&!task.foreachBatch)return;
   hits++;rejectedTaskDir=taskDir;
   // All batch members see the same invalid authority, rather than allowing
   // a healthy sibling to publish after the failed operation has returned.
   if(drift==='run')run.runId='foreign';
   if(drift==='task')for(const member of run.tasks.filter(candidate=>kind==='batch'?candidate.foreachBatch:true))member.status='blocked';
   if(drift==='run'||drift==='task')writeFileSync(runPath,JSON.stringify(run));
   else {
    const leader=task.foreachBatch?run.tasks.find(candidate=>candidate.foreachBatch?.role==='leader'):task;
    const state=leader.launchAuthority.records.at(-1).state;
    const mirrorDir=join(cwd,'.pi','workflow-subagents',run.runId,leader.taskId,state.backendRunId);
    const path=drift==='mirror'?join(mirrorDir,'run.json'):join(mirrorDir,'attempts',state.backendAttemptId,'result.json');
    const record=JSON.parse(readFileSync(path,'utf8'));
    if(drift==='mirror')record.correlationId='foreign:task';else record.attemptId='foreign';
    writeFileSync(path,JSON.stringify(record));
   }
  });
  let started,error;
  try {
   started=await runWorkflow('owner-drift',cwd,{task:'Joined local publication drift',...(kind==='batch'?{executionProfile:'batched'}:{})});
   // Drive only to the rejected publication boundary; do not launch recovery
   // attempts after this deliberately corrupted host state.
   for(let i=0;i<5&&!hits;i++){await refreshRun(cwd,started.runId);if(!hits)await scheduleRun(cwd,started.runId);}
  } catch(caught){error=caught;}
  assert.ok(hits>0,'the actual publisher must reach the establishment fence');
  assert.ok(error||kind==='dynamic','backend publication must propagate the ownership rejection');
  const result=JSON.parse((()=>{try{return readFileSync(join(rejectedTaskDir,'result.json'),'utf8');}catch{return '{}';}})());
  assert.notEqual(result.outputValidation?.valid,true);
  assert.throws(()=>statSync(join(rejectedTaskDir,'raw.md')),{code:'ENOENT'});
  if(started){const persisted=await readRunRecord(cwd,started.runId).catch(()=>undefined);if(persisted)assert.notEqual(persisted.tasks.find(task=>dirname(join(cwd,task.files.result))===rejectedTaskDir)?.status,'completed');}
 } finally {setRawOwnerEstablishmentHookForTests(undefined);setSubagentApiForTests(undefined);rmSync(cwd,{recursive:true,force:true});}
});

test("stop and resume clear an active group as a unit and resume as singletons", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd);
		const items = writeWorkflow(cwd, "batch-stop-resume", { itemCount: 2 });
		const fake = fakeApi({
			cwd,
			items,
			delayedBatch: true,
			batchItemFactory: (id) => ({
				id,
				control: { schema: "stage-control-v1", digest: `batch-${id}` },
				analysis: `analysis for ${id}`,
				refs: [],
			}),
		});
		setSubagentApiForTests(fake.api);
		const started = await runWorkflow("batch-stop-resume", cwd, {
			task: "Stop active batch.",
			executionProfile: "batched",
		});
		await refreshRun(cwd, started.runId);
		await scheduleRun(cwd, started.runId);
		assert.deepEqual(
			fake.launches.map((launch) => launch.kind),
			["source", "batch"],
		);
		const stopped = await stopRun(cwd, started.runId);
		assert.ok(stopped.interruptedTaskIds.length >= 2);
		assert.equal(
			fake.interrupts.length,
			1,
			"only the batch leader is interrupted",
		);
		assert.equal(stopped.run.foreachBatches?.[0]?.phase, "stopped");
		for (const task of stopped.run.tasks.filter(
			(task) => task.stageId === "fan",
		)) {
			assert.equal(task.status, "interrupted");
			assert.equal(task.foreachBatch?.batchingDisabled, true);
		}

		const resumed = await resumeRun(cwd, started.runId);
		const completed = await waitForRun(cwd, resumed.run.runId, 20_000);
		assert.equal(completed.status, "completed");
		assert.equal(
			fake.launches.filter((launch) => launch.kind === "batch").length,
			1,
			"stopped materialization must not strand or re-batch either member",
		);
		assert.equal(
			fake.launches.filter((launch) => launch.kind === "singleton").length,
			2,
		);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("restart recovers a prepared exact pair without inferring adjacency", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd);
		const items = writeWorkflow(cwd, "batch-prepared-recovery", {
			itemCount: 2,
		});
		const fake = fakeApi({
			cwd,
			items,
			delayedBatch: true,
			batchItemFactory: (id) => ({
				id,
				control: { schema: "stage-control-v1", digest: `batch-${id}` },
				analysis: `analysis for ${id}`,
				refs: [],
			}),
		});
		setSubagentApiForTests(fake.api);
		const started = await runWorkflow("batch-prepared-recovery", cwd, {
			task: "Recover prepared pair.",
			executionProfile: "batched",
		});
		await refreshRun(cwd, started.runId);
		await scheduleRun(cwd, started.runId);
		const prepared = await readRunRecord(cwd, started.runId);
		const record = prepared.foreachBatches?.[0];
		assert.ok(record);
		const [leaderMember, memberMember] = record.members;
		const leader = prepared.tasks.find(
			(task) => task.taskId === leaderMember.taskId,
		);
		const member = prepared.tasks.find(
			(task) => task.taskId === memberMember.taskId,
		);
		assert.ok(leader && member);

		// Simulate a persisted pre-spawn launch boundary: no handle exists, but
		// exact membership and prepared prompts do. Recovery must reuse this record.
		record.phase = "launching";
		leader.status = "pending";
		leader.statusDetail = "pending";
		leader.backendHandle = undefined;
		leader.backendFiles = undefined;
		leader.launchBootstrap = undefined;
		leader.launchAuthority = undefined;
		member.status = "running";
		member.statusDetail = "batch_launching";
		leader.foreachBatch = {
			batchId: record.batchId,
			role: "leader",
			phase: "launching",
		};
		member.foreachBatch = {
			batchId: record.batchId,
			role: "member",
			phase: "launching",
		};
		await withRunLease(cwd, started.runId, async () => {
			await writeRunRecord(cwd, prepared);
		});

		await refreshRun(cwd, started.runId);
		const recoveredPrepared = await readRunRecord(cwd, started.runId);
		assert.ok(
			["prepared", "running"].includes(
				recoveredPrepared.foreachBatches?.[0]?.phase,
			),
			"recovery may be observed before or immediately after replacement launch",
		);
		assert.deepEqual(
			recoveredPrepared.foreachBatches?.[0]?.members.map(
				(entry) => entry.taskId,
			),
			[leaderMember.taskId, memberMember.taskId],
		);
		await scheduleRun(cwd, started.runId);
		assert.equal(
			fake.launches.filter((launch) => launch.kind === "batch").length,
			2,
			"the recovered exact pair receives one replacement physical launch",
		);
		fake.setBatchCompleted(true);
		const completed = await waitForRun(cwd, started.runId, 20_000);
		assert.equal(completed.status, "completed");
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("prepared batch execution-surface drift falls back before a physical batch launch", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd);
		const items = writeWorkflow(cwd, "batch-surface-drift", { itemCount: 2 });
		const fake = fakeApi({
			cwd,
			items,
			delayedBatch: true,
			batchItemFactory: (id) => ({
				id,
				control: { schema: "stage-control-v1", digest: `batch-${id}` },
				analysis: `analysis for ${id}`,
				refs: [],
			}),
		});
		setSubagentApiForTests(fake.api);
		const started = await runWorkflow("batch-surface-drift", cwd, {
			task: "Reject prepared surface drift.",
			executionProfile: "batched",
		});
		await refreshRun(cwd, started.runId);
		await scheduleRun(cwd, started.runId);
		const prepared = await readRunRecord(cwd, started.runId);
		const record = prepared.foreachBatches?.[0];
		assert.ok(record);
		const leader = prepared.tasks.find((task) => task.foreachBatch?.role === "leader");
		const member = prepared.tasks.find((task) => task.foreachBatch?.role === "member");
		assert.ok(leader && member);
		record.phase = "prepared";
		for (const task of [leader, member]) {
			task.status = "pending";
			task.statusDetail = "pending";
			task.backendHandle = undefined;
			task.backendFiles = undefined;
			task.launchBootstrap = undefined;
			task.launchAuthority = undefined;
			task.foreachBatch = { batchId: record.batchId, role: task.foreachBatch.role, phase: "prepared" };
		}
		await withRunLease(cwd, started.runId, async () => writeRunRecord(cwd, prepared));
		const compiledPath = compiledWorkflowPath(cwd, started.runId);
		const compiled = JSON.parse(readFileSync(compiledPath, "utf8"));
		const leaderIndex = compiled.tasks.findIndex((task) => task.id === leader.specId);
		compiled.tasks[leaderIndex].runtime = { ...compiled.tasks[leaderIndex].runtime, thinkingLevel: "high" };
		writeFileSync(compiledPath, JSON.stringify(compiled));
		await scheduleRun(cwd, started.runId);
		assert.equal(fake.launches.filter((launch) => launch.kind === "batch").length, 1);
		assert.equal(fake.launches.filter((launch) => launch.kind === "singleton").length, 2);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("restart recovers terminal and partial-demux boundaries from durable batch evidence", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd);
		const items = writeWorkflow(cwd, "batch-recovery", { itemCount: 2 });
		const fake = fakeApi({
			cwd,
			items,
			batchItemFactory: (id) => ({
				id,
				control: { schema: "stage-control-v1", digest: `batch-${id}` },
				analysis: `analysis for ${id}`,
				refs: [],
			}),
		});
		setSubagentApiForTests(fake.api);
		const started = await runWorkflow("batch-recovery", cwd, {
			task: "Recover batch demux.",
			executionProfile: "batched",
		});
		await refreshRun(cwd, started.runId);
		await scheduleRun(cwd, started.runId);
		assert.deepEqual(
			fake.launches.map((launch) => launch.kind),
			["source", "batch"],
		);
		await persistTerminalBatchBoundary(cwd, started.runId, fake);

		let injectedFailure = false;
		setWorkflowOutputArtifactWriteHookForTests(async ({ phase, file }) => {
			if (
				!injectedFailure &&
				phase === "before" &&
				file.endsWith("control.json")
			) {
				injectedFailure = true;
				throw new Error("simulated partial demux crash");
			}
		});
		await assert.rejects(
			() => refreshRun(cwd, started.runId),
			/simulated partial demux crash/,
		);
		setWorkflowOutputArtifactWriteHookForTests(undefined);
		const partial = await readRunRecord(cwd, started.runId);
		assert.equal(partial.foreachBatches?.[0]?.phase, "committing");

		const recovered = await refreshRun(cwd, started.runId);
		assert.equal(recovered.foreachBatches?.[0]?.phase, "completed");
		assert.equal(
			fake.batchStatusCalls(),
			0,
			"terminal recovery must not repoll a member or leader",
		);
		for (const task of recovered.tasks.filter(
			(task) => task.stageId === "fan",
		)) {
			assert.equal(task.status, "completed");
			assert.ok(
				readFileSync(join(cwd, task.files.result), "utf8").includes(
					'"status": "completed"',
				),
			);
		}
		const completed = await waitForRun(cwd, started.runId, 20_000);
		assert.equal(completed.status, "completed");
	} finally {
		setWorkflowOutputArtifactWriteHookForTests(undefined);
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("an expired leader falls back the exact pair after backend refresh errors", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd);
		const items = writeWorkflow(cwd, "batch-refresh-error", { itemCount: 2 });
		const fake = fakeApi({
			cwd,
			items,
			delayedBatch: true,
			throwBatchPoll: true,
			batchItemFactory: (id) => ({
				id,
				control: { schema: "stage-control-v1", digest: `batch-${id}` },
				analysis: `analysis for ${id}`,
				refs: [],
			}),
		});
		setSubagentApiForTests(fake.api);
		const started = await runWorkflow("batch-refresh-error", cwd, {
			task: "Recover from refresh failure.",
			executionProfile: "batched",
		});
		await refreshRun(cwd, started.runId);
		await scheduleRun(cwd, started.runId);
		const active = await readRunRecord(cwd, started.runId);
		const record = active.foreachBatches?.[0];
		assert.ok(record);
		const leader = active.tasks.find(
			(task) => task.foreachBatch?.role === "leader",
		);
		assert.ok(leader);
		leader.startedAt = "2000-01-01T00:00:00.000Z";
		await withRunLease(cwd, started.runId, async () => {
			await writeRunRecord(cwd, active);
		});

		await assert.rejects(
			() => refreshRun(cwd, started.runId),
			/one or more subagent refresh polls failed/,
		);
		const fallenBack = await readRunRecord(cwd, started.runId);
		assert.equal(fallenBack.foreachBatches?.[0]?.phase, "fallback_applied");
		for (const task of fallenBack.tasks.filter(
			(task) => task.stageId === "fan",
		)) {
			assert.equal(task.status, "pending");
			assert.equal(task.foreachBatch?.batchingDisabled, true);
			assert.equal(task.outputRetry, undefined);
		}
		const completed = await waitForRun(cwd, started.runId, 20_000);
		assert.equal(completed.status, "completed");
		assert.equal(
			fake.launches.filter((launch) => launch.kind === "singleton").length,
			2,
		);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("one invalid batched member falls back both items to singleton without output retries", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd);
		const items = writeWorkflow(cwd, "batch-invalid", { itemCount: 2 });
		const fake = fakeApi({
			cwd,
			items,
			batchItemFactory: (id, index) => ({
				id,
				control: { schema: "stage-control-v1", digest: `batch-${id}` },
				analysis: index === 0 ? "valid sibling" : "",
				refs: [],
			}),
		});
		setSubagentApiForTests(fake.api);
		const started = await runWorkflow("batch-invalid", cwd, {
			task: "Run invalid batch fallback.",
			executionProfile: "batched",
		});
		const completed = await waitForRun(cwd, started.runId, 20_000);
		assert.equal(completed.status, "completed");
		assert.deepEqual(
			fake.launches.map((launch) => launch.kind),
			["source", "batch", "singleton", "singleton", "downstream"],
		);
		const run = await readRunRecord(cwd, started.runId);
		const batch = run.foreachBatches?.[0];
		assert.equal(batch?.phase, "fallback_applied");
		assert.match(
			batch?.fallback?.reason ?? "",
			/invalid foreach batch member output/,
		);
		const fanTasks = run.tasks.filter((task) => task.stageId === "fan");
		assert.equal(fanTasks.length, 2);
		for (const task of fanTasks) {
			assert.equal(task.status, "completed");
			assert.equal(task.outputRetry, undefined);
			assert.equal(task.foreachBatch?.batchingDisabled, true);
			assert.match(
				readFileSync(join(cwd, task.files.output), "utf8"),
				/singleton/,
			);
		}
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("zero and one foreach items remain valid without creating batch ownership", async () => {
	for (const itemCount of [0, 1]) {
		const cwd = makeProject();
		try {
			writeAgent(cwd);
			const name = `batch-cardinality-${itemCount}`;
			const items = writeWorkflow(cwd, name, { itemCount });
			const fake = fakeApi({
				cwd,
				items,
				batchItemFactory() {
					throw new Error("cardinality below two must not launch a batch");
				},
			});
			setSubagentApiForTests(fake.api);
			const started = await runWorkflow(name, cwd, {
				task: `Run ${itemCount} foreach items.`,
				executionProfile: "batched",
			});
			const completed = await waitForRun(cwd, started.runId, 20_000);
			assert.equal(completed.status, "completed");
			assert.equal(completed.foreachBatches?.length ?? 0, 0);
			assert.deepEqual(
				fake.launches.map((launch) => launch.kind),
				itemCount === 0
					? ["source", "downstream"]
					: ["source", "singleton", "downstream"],
			);
		} finally {
			setSubagentApiForTests(undefined);
			rmSync(cwd, { recursive: true, force: true });
		}
	}
});

test("logical concurrency below two degrades an eligible pair to ordered singletons", async () => {
	for (const scenario of [
		{ name: "global", maxConcurrency: 1 },
		{ name: "stage", maxConcurrency: 2, stageMaxConcurrency: 1 },
	]) {
		const cwd = makeProject();
		try {
			writeAgent(cwd);
			const name = `batch-one-${scenario.name}-slot`;
			const items = writeWorkflow(cwd, name, {
				itemCount: 2,
				maxConcurrency: scenario.maxConcurrency,
				stageMaxConcurrency: scenario.stageMaxConcurrency,
			});
			const fake = fakeApi({
				cwd,
				items,
				batchItemFactory() {
					throw new Error("a physical pair cannot consume only one logical slot");
				},
			});
			setSubagentApiForTests(fake.api);
			const started = await runWorkflow(name, cwd, {
				task: "Respect one logical slot.",
				executionProfile: "batched",
			});
			const completed = await waitForRun(cwd, started.runId, 20_000);
			assert.equal(completed.status, "completed");
			assert.equal(completed.foreachBatches?.length ?? 0, 0);
			assert.deepEqual(
				fake.launches.map((launch) => launch.kind),
				["source", "singleton", "singleton", "downstream"],
			);
		} finally {
			setSubagentApiForTests(undefined);
			rmSync(cwd, { recursive: true, force: true });
		}
	}
});

test("groupBy fallback paths preserve canonical type boundaries and unusable values stay singleton-only", () => {
	const template = {
		id: "fan",
		stageId: "fan",
		foreach: {
			prompt: "Review ${item}",
			injectRuntimeTask: false,
			batch: { maxItems: 2, groupBy: ["$.primary", "$.fallback"] },
		},
	};
	const generated = buildForeachGeneratedTasks(template, undefined, [
		{ primary: "", fallback: { b: 2, a: 1 } },
		{ fallback: { a: 1, b: 2 } },
		{ primary: 1 },
		{ primary: "1" },
		{ primary: false },
		{ primary: 0 },
		{ primary: null, fallback: [] },
		{ primary: null, fallback: ["x"] },
	]);
	assert.equal(generated.error, undefined);
	const keys = generated.tasks.map(
		(task) => task.foreachGenerated.batch.groupKey,
	);
	assert.deepEqual(keys, [
		'{"a":1,"b":2}',
		'{"a":1,"b":2}',
		"1",
		'"1"',
		"false",
		"0",
		undefined,
		'["x"]',
	]);
});

test("multiple groups accept reversed batch rows and preserve exact per-item ownership", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd);
		writeWorkflow(cwd, "batch-reversed-groups", {
			itemCount: 6,
			maxConcurrency: 6,
			groupBy: "$.group",
		});
		const items = [
			{ id: "a-1", group: "a" },
			{ id: "a-2", group: "a" },
			{ id: "a-tail", group: "a" },
			{ id: "b-1", group: "b" },
			{ id: "b-2", group: "b" },
			{ id: "missing-group" },
		];
		const fake = fakeApi({
			cwd,
			items,
			batchItemsTransform: (rows) => [...rows].reverse(),
			batchItemFactory: (id) => ({
				id,
				control: { schema: "stage-control-v1", digest: `batch-${id}` },
				analysis: `역순 Unicode analysis for ${id} — \"quoted\"`,
				refs: [],
			}),
		});
		setSubagentApiForTests(fake.api);
		const started = await runWorkflow("batch-reversed-groups", cwd, {
			task: "Accept exact ids regardless of row order.",
			executionProfile: "batched",
		});
		const completed = await waitForRun(cwd, started.runId, 20_000);
		assert.equal(completed.status, "completed");
		assert.equal(
			fake.launches.filter((launch) => launch.kind === "batch").length,
			2,
		);
		assert.equal(
			fake.launches.filter((launch) => launch.kind === "singleton").length,
			2,
		);
		assert.equal(completed.foreachBatches?.length, 2);
		for (const batch of completed.foreachBatches ?? []) {
			assert.equal(batch.phase, "completed");
			for (const member of batch.members) {
				const task = completed.tasks.find(
					(candidate) => candidate.taskId === member.taskId,
				);
				assert.ok(task);
				assert.match(
					readFileSync(join(cwd, task.files.output), "utf8"),
					new RegExp(`batch-${member.taskId}`),
				);
			}
		}
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a physical batch launch failure durably falls back the exact pair to singleton", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd);
		const items = writeWorkflow(cwd, "batch-launch-failure", { itemCount: 2 });
		const fake = fakeApi({
			cwd,
			items,
			failBatchLaunchOnce: true,
			batchItemFactory: (id) => ({
				id,
				control: { schema: "stage-control-v1", digest: `batch-${id}` },
				analysis: `analysis for ${id}`,
				refs: [],
			}),
		});
		setSubagentApiForTests(fake.api);
		const started = await runWorkflow("batch-launch-failure", cwd, {
			task: "Recover a failed physical pair launch.",
			executionProfile: "batched",
		});
		const completed = await waitForRun(cwd, started.runId, 20_000);
		assert.equal(completed.status, "completed");
		assert.deepEqual(
			fake.launches.map((launch) => launch.kind),
			["source", "batch-failed", "singleton", "singleton", "downstream"],
		);
		const batch = completed.foreachBatches?.[0];
		assert.equal(batch?.phase, "fallback_applied");
		assert.match(batch?.fallback?.reason ?? "", /simulated batch launch failure/);
		for (const task of completed.tasks.filter(
			(candidate) => candidate.stageId === "fan",
		)) {
			assert.equal(task.status, "completed");
			assert.equal(task.outputRetry, undefined);
			assert.equal(task.foreachBatch?.batchingDisabled, true);
		}
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});
