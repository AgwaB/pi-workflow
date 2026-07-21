import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, test } from "node:test";

import { buildForeachGeneratedTasks } from "../../.tmp/unit/engine-run-graph.js";
import {
	assertForeachBatchRecord,
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
	readRunRecord,
	withRunLease,
	workflowRunDir,
	writeRunRecord,
} from "../../.tmp/unit/store.js";
import { setSubagentApiForTests } from "../../.tmp/unit/subagent-backend.js";
import { setWorkflowOutputArtifactWriteHookForTests } from "../../.tmp/unit/workflow-output-artifacts.js";

const UNIT_TEST_HOME = mkdtempSync(
	join(tmpdir(), "foreach-batch-runtime-home-"),
);
process.env.HOME = UNIT_TEST_HOME;
process.env.USERPROFILE = UNIT_TEST_HOME;

after(() => {
	rmSync(UNIT_TEST_HOME, { recursive: true, force: true });
});

function makeProject() {
	return mkdtempSync(join(tmpdir(), "foreach-batch-runtime-"));
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
	{ itemCount = 3, maxConcurrency = 2, groupBy } = {},
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

function writeSubagentArtifacts(cwd, runsDir, runId, attemptId, output) {
	const dir = join(cwd, runsDir, runId, "attempts", attemptId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "output.log"), output);
	writeFileSync(join(dir, "stderr.log"), "");
	writeFileSync(
		join(dir, "result.json"),
		JSON.stringify({
			status: "completed",
			startedAt: new Date(Date.now() - 100).toISOString(),
			completedAt: new Date().toISOString(),
			exitCode: 0,
		}),
	);
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
	delayedBatch = false,
	throwBatchPoll = false,
}) {
	const runs = new Map();
	const launches = [];
	const interrupts = [];
	let batchCompleted = !delayedBatch;
	let batchStatusCalls = 0;
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
					const ids = idsFromBatchPrompt(prompt);
					output = batchOutput(
						ids.map((id, itemIndex) => batchItemFactory(id, itemIndex)),
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
				return {};
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
		assert.equal(
			completedBatch?.physicalExecution?.leaderTaskId,
			completedBatch?.members.find((member) => member.role === "leader")?.taskId,
		);
		assert.ok(
			completedBatch?.physicalExecution?.timing,
			"physical batch timing must be attributed once at batch level",
		);
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
		assert.equal(recoveredPrepared.foreachBatches?.[0]?.phase, "prepared");
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
