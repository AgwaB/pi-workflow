import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { compileWorkflow } from "../../.tmp/unit/compiler.js";
import { setSupportHelperPreparedHookForTests } from "../../.tmp/unit/artifact-graph-runtime.js";
import { appendDynamicEvent } from "../../.tmp/unit/dynamic-events.js";
import { setDynamicControllerHooksForTests } from "../../.tmp/unit/engine.js";
import { markFailFastCancellations } from "../../.tmp/unit/engine-run-graph.js";
import {
	checkRequiredArtifactReads,
	launchSubagentTask,
} from "../../.tmp/unit/subagent-backend.js";
import {
	listRunRecords,
	readRunRecord,
	readWorkflowStopIntent,
	requestWorkflowStop,
	writeJsonAtomic,
	writeRunRecord,
} from "../../.tmp/unit/store.js";
import {
	artifactGraphWorkflowSpec,
	completeTask,
	createDynamicControllerRun,
	createWorkflowRunRecord,
	eventually,
	makeProject,
	makeSubagentLaunchFixture,
	runWorkflowSpec,
	scheduleRun,
	setSubagentApiForTests,
	setSubagentLaunchControlsForTests,
	sleep,
	stopRun,
	taskBySpec,
	withRunLease,
	workflowSpec,
	writeAgent,
	writeStaticRunArtifacts,
} from "./unit-test-support.mjs";

function cleanup(cwd) {
	rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
}

function deferred() {
	let resolve;
	const promise = new Promise((innerResolve) => {
		resolve = innerResolve;
	});
	return { promise, resolve };
}

function writeAbortRejectingHelper(cwd) {
	const workflowDir = join(cwd, "workflows");
	mkdirSync(workflowDir, { recursive: true });
	writeFileSync(
		join(workflowDir, "block-helper.mjs"),
		`import { writeFile } from "node:fs/promises";\nexport default async function helper({ context }) {\n  await writeFile(${JSON.stringify(join(cwd, "helper-started"))}, "started", "utf8");\n  return await new Promise((resolve, reject) => {\n    if (context.signal?.aborted) return reject(context.signal.reason);\n    context.signal?.addEventListener("abort", () => reject(context.signal.reason), { once: true });\n  });\n}\n`,
	);
}

function writeAbortResolvingHelper(cwd) {
	const workflowDir = join(cwd, "workflows");
	mkdirSync(workflowDir, { recursive: true });
	writeFileSync(
		join(workflowDir, "resolve-helper.mjs"),
		`import { writeFile } from "node:fs/promises";\nexport default async function helper({ context }) {\n  await writeFile(${JSON.stringify(join(cwd, "helper-started"))}, "started", "utf8");\n  return await new Promise((resolve) => {\n    if (context.signal?.aborted) return resolve({ analysis: "aborted" });\n    context.signal?.addEventListener("abort", () => resolve({ analysis: "aborted" }), { once: true });\n  });\n}\n`,
	);
}

function writeAbortIgnoringReleasableHelper(cwd) {
	const workflowDir = join(cwd, "workflows");
	mkdirSync(workflowDir, { recursive: true });
	writeFileSync(
		join(workflowDir, "ignore-helper.mjs"),
		`import { access, writeFile } from "node:fs/promises";\nconst releaseFile = ${JSON.stringify(join(cwd, "helper-release"))};\nexport default async function helper() {\n  await writeFile(${JSON.stringify(join(cwd, "helper-started"))}, "started", "utf8");\n  for (;;) {\n    try { await access(releaseFile); return { analysis: "released" }; } catch {}\n    await new Promise((resolve) => setTimeout(resolve, 25));\n  }\n}\n`,
	);
}

test("two-level nested dag requiredReads and requiredReadPolicy are namespaced like runtime sources", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const spec = workflowSpec("unit-scout", {
			artifactGraph: {
				stages: [
					{
						id: "box",
						type: "dag",
						stages: [
							{
								id: "inner",
								type: "dag",
								stages: [
									{ id: "scan", type: "single", prompt: "Scan." },
									{
										id: "report",
										type: "single",
										from: "scan",
										prompt: "Report.",
										inputPolicy: {
											requiredReads: [
												"scan.control",
												{ source: "scan", artifact: "analysis" },
											],
											requiredReadPolicy: [
												{
													source: "scan",
													artifact: "control",
													path: "$.items",
													mustNotTruncate: true,
												},
											],
										},
									},
								],
							},
						],
					},
				],
			},
		});
		const compiled = await compileWorkflow(spec, { cwd, task: "Check" });
		const report = compiled.tasks.find(
			(task) => task.id === "box.inner.report.main",
		);
		assert.deepEqual(report.artifactGraph.requiredReads, [
			"box.inner.scan.control",
			{ source: "box.inner.scan", artifact: "analysis" },
		]);
		assert.equal(
			report.artifactGraph.requiredReadPolicy[0].source,
			"box.inner.scan",
		);

		const taskDir = join(cwd, "task");
		mkdirSync(taskDir, { recursive: true });
		writeFileSync(
			join(taskDir, "read-ledger.jsonl"),
			[
				JSON.stringify({
					schema: "workflow-artifact-read-v1",
					runId: "run",
					taskId: "task",
					source: "box.inner.scan",
					artifact: "control",
					at: new Date().toISOString(),
					bytes: 100,
					returnedBytes: 100,
					truncated: false,
					path: "$.items",
				}),
				JSON.stringify({
					schema: "workflow-artifact-read-v1",
					runId: "run",
					taskId: "task",
					source: "box.inner.scan",
					artifact: "analysis",
					at: new Date().toISOString(),
					bytes: 50,
					returnedBytes: 50,
					truncated: false,
				}),
				"",
			].join("\n"),
		);
		assert.deepEqual(
			await checkRequiredArtifactReads(
				taskDir,
				report.artifactGraph.requiredReads,
				report.artifactGraph.requiredReadPolicy,
			),
			{ missing: [], projectionFailures: [] },
		);
	} finally {
		cleanup(cwd);
	}
});

test("requiredReads targeting after-only sources fail before backend launch", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const spec = workflowSpec("unit-scout", {
			artifactGraph: {
				stages: [
					{ id: "source", type: "single", prompt: "Source." },
					{
						id: "consumer",
						type: "single",
						after: "source",
						prompt: "Consumer.",
						inputPolicy: {
							requiredReads: ["source.control"],
							requiredReadPolicy: [
								{
									source: "source",
									artifact: "analysis",
									mustNotTruncate: true,
								},
							],
						},
					},
				],
			},
		});
		const compiled = await compileWorkflow(spec, { cwd, task: "Check" });
		const { run } = await createWorkflowRunRecord(
			cwd,
			compiled,
			join(cwd, "workflows", "unit.json"),
		);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await completeTask(cwd, taskBySpec(run, "source.main"), {});
		await writeRunRecord(cwd, run);
		let launched = false;
		setSubagentApiForTests({
			async runSubagent() {
				launched = true;
				throw new Error("must not launch");
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
			const updated = await scheduleRun(cwd, run.runId);
			const consumer = taskBySpec(updated, "consumer.main");
			assert.equal(launched, false);
			assert.equal(consumer.status, "failed");
			assert.equal(consumer.statusDetail, "prepare_failed");
			assert.match(consumer.lastMessage, /after is ordering-only/);
		} finally {
			setSubagentApiForTests(undefined);
		}
	} finally {
		cleanup(cwd);
	}
});

test("stopRun reports pending when an in-process support helper ignores abort", async () => {
	const cwd = makeProject();
	let scheduling;
	try {
		writeAbortIgnoringReleasableHelper(cwd);
		const spec = workflowSpec("unit-scout", {
			artifactGraph: {
				stages: [
					{
						id: "block",
						prompt: "Block.",
						support: { uses: "./ignore-helper.mjs" },
					},
				],
			},
		});
		const specPath = join(cwd, "workflows", "unit.json");
		writeFileSync(specPath, JSON.stringify(spec, null, 2));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Stop ignored support",
			specPath: "workflows/unit.json",
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);
		scheduling = scheduleRun(cwd, run.runId);
		await eventually(
			() => assert.equal(existsSync(join(cwd, "helper-started")), true),
			1500,
		);
		await assert.rejects(
			() => stopRun(cwd, run.runId),
			/could not be confirmed stopped|still pending/,
		);
		assert.ok(await readWorkflowStopIntent(cwd, run.runId));
		writeFileSync(join(cwd, "helper-release"), "release", "utf8");
		await Promise.race([
			scheduling,
			sleep(1500).then(() => {
				throw new Error("support helper cleanup leaked or hung");
			}),
		]);
		const finalRun = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(finalRun, "block.main").status, "interrupted");
		assert.equal(await readWorkflowStopIntent(cwd, run.runId), undefined);
	} finally {
		writeFileSync(join(cwd, "helper-release"), "release", "utf8");
		if (scheduling)
			await Promise.race([scheduling.catch(() => undefined), sleep(500)]);
		cleanup(cwd);
	}
});

test("stopRun writes durable intent and cooperatively cancels a blocked async support helper", async () => {
	const cwd = makeProject();
	try {
		writeAbortRejectingHelper(cwd);
		const spec = workflowSpec("unit-scout", {
			artifactGraph: {
				stages: [
					{
						id: "block",
						prompt: "Block.",
						support: { uses: "./block-helper.mjs" },
					},
				],
			},
		});
		const specPath = join(cwd, "workflows", "unit.json");
		writeFileSync(specPath, JSON.stringify(spec, null, 2));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Stop support",
			specPath: "workflows/unit.json",
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);
		const scheduling = scheduleRun(cwd, run.runId);
		await eventually(
			() => assert.equal(existsSync(join(cwd, "helper-started")), true),
			1500,
		);
		const stopped = await stopRun(cwd, run.runId);
		await scheduling;
		const finalRun = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(finalRun, "block.main").status, "interrupted");
		assert.equal(
			taskBySpec(finalRun, "block.main").statusDetail,
			"workflow_stopped",
		);
		assert.equal(stopped.run.runId, run.runId);
	} finally {
		cleanup(cwd);
	}
});

test("stop intent during support helper preparation prevents helper invocation and artifact commit", async () => {
	const cwd = makeProject();
	const releasePreparation = deferred();
	try {
		mkdirSync(join(cwd, "workflows"), { recursive: true });
		writeFileSync(
			join(cwd, "workflows", "prepared-helper.mjs"),
			`import { writeFile } from "node:fs/promises";\nexport default async function helper() {\n  await writeFile(${JSON.stringify(join(cwd, "helper-invoked"))}, "invoked", "utf8");\n  return { analysis: "should not commit" };\n}\n`,
		);
		setSupportHelperPreparedHookForTests(async () => {
			writeFileSync(join(cwd, "helper-prepared"), "prepared", "utf8");
			await releasePreparation.promise;
		});
		const spec = workflowSpec("unit-scout", {
			artifactGraph: {
				stages: [
					{
						id: "support",
						prompt: "Support.",
						support: { uses: "./prepared-helper.mjs" },
					},
				],
			},
		});
		const specPath = join(cwd, "workflows", "unit.json");
		writeFileSync(specPath, JSON.stringify(spec, null, 2));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Stop support preparation",
			specPath: "workflows/unit.json",
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);
		const scheduling = scheduleRun(cwd, run.runId);
		await eventually(
			() => assert.equal(existsSync(join(cwd, "helper-prepared")), true),
			1500,
		);
		await requestWorkflowStop(cwd, run.runId);
		releasePreparation.resolve();
		await scheduling;
		const finalRun = await readRunRecord(cwd, run.runId);
		const support = taskBySpec(finalRun, "support.main");
		assert.equal(existsSync(join(cwd, "helper-invoked")), false);
		assert.equal(existsSync(join(cwd, support.files.result)), false);
		assert.equal(support.status, "interrupted");
		assert.equal(support.statusDetail, "workflow_stopped");
	} finally {
		setSupportHelperPreparedHookForTests(undefined);
		releasePreparation.resolve();
		cleanup(cwd);
	}
});

test("stop intent during backend launch preparation prevents runSubagent side effects", async () => {
	const cwd = makeProject();
	const releasePreparation = deferred();
	try {
		writeAgent(cwd, "unit-scout", "read");
		let launches = 0;
		setSubagentApiForTests({
			async runSubagent() {
				launches += 1;
				throw new Error("runSubagent must not be invoked after stop intent");
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
		setSubagentLaunchControlsForTests({
			releaseDelayMs: 0,
			retryJitterMs: 0,
			beforeRunSubagent: async () => {
				writeFileSync(join(cwd, "backend-prepared"), "prepared", "utf8");
				await releasePreparation.promise;
			},
		});
		const spec = workflowSpec("unit-scout", {
			artifactGraph: {
				stages: [{ id: "worker", type: "single", prompt: "Worker." }],
			},
		});
		const compiled = await compileWorkflow(spec, { cwd, task: "Stop backend" });
		const { run } = await createWorkflowRunRecord(
			cwd,
			compiled,
			join(cwd, "workflows", "unit.json"),
		);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);
		const scheduling = scheduleRun(cwd, run.runId);
		await eventually(
			() => assert.equal(existsSync(join(cwd, "backend-prepared")), true),
			1500,
		);
		await requestWorkflowStop(cwd, run.runId);
		releasePreparation.resolve();
		await scheduling;
		const finalRun = await readRunRecord(cwd, run.runId);
		const worker = taskBySpec(finalRun, "worker.main");
		assert.equal(launches, 0);
		assert.equal(worker.backendHandle, undefined);
		assert.equal(worker.status, "interrupted");
		assert.equal(worker.statusDetail, "workflow_stopped");
	} finally {
		setSubagentApiForTests(undefined);
		setSubagentLaunchControlsForTests({ releaseDelayMs: 0, retryJitterMs: 0 });
		releasePreparation.resolve();
		cleanup(cwd);
	}
});

test("stop during support prevents later independent backend launches and records interrupted support", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		writeAbortResolvingHelper(cwd);
		const spec = workflowSpec("unit-scout", {
			artifactGraph: {
				maxConcurrency: 1,
				stages: [
					{
						id: "support",
						prompt: "Support.",
						support: { uses: "./resolve-helper.mjs" },
					},
					{ id: "later", type: "single", prompt: "Must not launch." },
				],
			},
		});
		const specPath = join(cwd, "workflows", "unit.json");
		writeFileSync(specPath, JSON.stringify(spec, null, 2));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Stop support",
			specPath: "workflows/unit.json",
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);
		let launches = 0;
		setSubagentApiForTests({
			async runSubagent() {
				launches += 1;
				throw new Error("later task must not launch after stop intent");
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
		const scheduling = scheduleRun(cwd, run.runId);
		await eventually(
			() => assert.equal(existsSync(join(cwd, "helper-started")), true),
			1500,
		);
		await stopRun(cwd, run.runId).catch((error) => {
			assert.match(String(error), /stop|terminal|pending/i);
		});
		await scheduling;
		const finalRun = await readRunRecord(cwd, run.runId);
		const support = taskBySpec(finalRun, "support.main");
		assert.equal(launches, 0);
		assert.equal(support.status, "interrupted");
		assert.equal(support.statusDetail, "workflow_stopped");
		assert.equal(existsSync(join(cwd, support.files.output)), false);
		assert.equal(taskBySpec(finalRun, "later.main").status, "interrupted");
	} finally {
		setSubagentApiForTests(undefined);
		cleanup(cwd);
	}
});

test("restart with stop intent interrupts stale running support instead of stale-recovery failing it", async () => {
	const cwd = makeProject();
	try {
		const spec = workflowSpec("unit-scout", {
			artifactGraph: {
				stages: [
					{
						id: "support",
						prompt: "Support.",
						support: { uses: "./never-needed.mjs" },
					},
				],
			},
		});
		const specPath = join(cwd, "workflows", "unit.json");
		mkdirSync(join(cwd, "workflows"), { recursive: true });
		writeFileSync(
			join(cwd, "workflows", "never-needed.mjs"),
			"export default async function helper() { return {}; }\n",
		);
		writeFileSync(specPath, JSON.stringify(spec, null, 2));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Restart stop support",
			specPath: "workflows/unit.json",
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		const support = taskBySpec(run, "support.main");
		support.status = "running";
		support.statusDetail = "running";
		support.startedAt = new Date().toISOString();
		support.pid = 12345;
		await writeRunRecord(cwd, run);
		await requestWorkflowStop(cwd, run.runId);

		await scheduleRun(cwd, run.runId);

		const finalRun = await readRunRecord(cwd, run.runId);
		const finalSupport = taskBySpec(finalRun, "support.main");
		assert.equal(finalRun.status, "interrupted");
		assert.equal(finalSupport.status, "interrupted");
		assert.equal(finalSupport.statusDetail, "workflow_stopped");
		assert.notEqual(finalSupport.statusDetail, "recovered_stale_support_task");
		assert.equal(await readWorkflowStopIntent(cwd, run.runId), undefined);
	} finally {
		cleanup(cwd);
	}
});

test("restart with stop intent interrupts stale running dynamic instead of resetting it", async () => {
	const cwd = makeProject();
	try {
		const { run } = await createDynamicControllerRun(
			cwd,
			"export default async function controller() { return { control: { schema: 'dynamic-controller-result-v1', summary: 'unused' }, analysis: 'unused', refs: [] }; }\n",
		);
		const controller = taskBySpec(run, "adaptive.controller");
		controller.status = "running";
		controller.statusDetail = "running";
		controller.startedAt = new Date().toISOString();
		controller.pid = 23456;
		await writeRunRecord(cwd, run);
		await requestWorkflowStop(cwd, run.runId);

		await scheduleRun(cwd, run.runId);

		const finalRun = await readRunRecord(cwd, run.runId);
		const finalController = taskBySpec(finalRun, "adaptive.controller");
		assert.equal(finalRun.status, "interrupted");
		assert.equal(finalController.status, "interrupted");
		assert.equal(finalController.statusDetail, "workflow_stopped");
		assert.notEqual(
			finalController.statusDetail,
			"recovered_stale_dynamic_controller",
		);
		assert.equal(await readWorkflowStopIntent(cwd, run.runId), undefined);
	} finally {
		cleanup(cwd);
	}
});

test("restart without stop intent fails closed for stale running support", async () => {
	const cwd = makeProject();
	try {
		const spec = workflowSpec("unit-scout", {
			artifactGraph: {
				stages: [
					{
						id: "support",
						prompt: "Support.",
						support: { uses: "./never-needed.mjs" },
					},
				],
			},
		});
		const specPath = join(cwd, "workflows", "unit.json");
		mkdirSync(join(cwd, "workflows"), { recursive: true });
		writeFileSync(
			join(cwd, "workflows", "never-needed.mjs"),
			"export default async function helper() { return {}; }\n",
		);
		writeFileSync(specPath, JSON.stringify(spec, null, 2));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Restart stale support",
			specPath: "workflows/unit.json",
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		const support = taskBySpec(run, "support.main");
		support.status = "running";
		support.statusDetail = "running";
		support.startedAt = new Date().toISOString();
		support.pid = 34567;
		await writeRunRecord(cwd, run);

		await scheduleRun(cwd, run.runId);

		const finalRun = await readRunRecord(cwd, run.runId);
		const finalSupport = taskBySpec(finalRun, "support.main");
		assert.equal(finalRun.status, "failed");
		assert.equal(finalSupport.status, "failed");
		assert.equal(finalSupport.statusDetail, "recovered_stale_support_task");
		assert.match(finalSupport.lastMessage, /failed closed/);
		assert.equal(finalSupport.pid, undefined);
	} finally {
		cleanup(cwd);
	}
});

test("stop intent during dynamic pre-worker preparation prevents controller worker side effects", async () => {
	const cwd = makeProject();
	try {
		const { run } = await createDynamicControllerRun(
			cwd,
			[
				"import { writeFile } from 'node:fs/promises';",
				`await writeFile(${JSON.stringify(join(cwd, "controller-worker-started"))}, "started", "utf8");`,
				"export default async function controller() {",
				"  return { control: { schema: 'dynamic-controller-result-v1', summary: 'should not run' }, analysis: 'should not run', refs: [] };",
				"}",
				"",
			].join("\n"),
		);
		setDynamicControllerHooksForTests({
			beforeControllerWorkerLaunch: async ({ runId }) => {
				writeFileSync(join(cwd, "dynamic-preworker-hook"), "hook", "utf8");
				await requestWorkflowStop(cwd, runId);
			},
		});

		await scheduleRun(cwd, run.runId);

		const finalRun = await readRunRecord(cwd, run.runId);
		const controller = taskBySpec(finalRun, "adaptive.controller");
		assert.equal(existsSync(join(cwd, "dynamic-preworker-hook")), true);
		assert.equal(existsSync(join(cwd, "controller-worker-started")), false);
		assert.equal(existsSync(join(cwd, controller.files.result)), false);
		assert.equal(finalRun.status, "interrupted");
		assert.equal(controller.status, "interrupted");
		assert.equal(controller.statusDetail, "workflow_stopped");
	} finally {
		setDynamicControllerHooksForTests();
		cleanup(cwd);
	}
});

test("stop intent immediately before dynamic result commit prevents completed artifact commit", async () => {
	const cwd = makeProject();
	try {
		const { run } = await createDynamicControllerRun(
			cwd,
			[
				"import { writeFile } from 'node:fs/promises';",
				"export default async function controller() {",
				`  await writeFile(${JSON.stringify(join(cwd, "controller-worker-started"))}, "started", "utf8");`,
				"  return { control: { schema: 'dynamic-controller-result-v1', summary: 'done' }, analysis: 'done', refs: [] };",
				"}",
				"",
			].join("\n"),
		);
		let hookCalls = 0;
		setDynamicControllerHooksForTests({
			beforeDynamicResultCommit: async ({ runId }) => {
				hookCalls += 1;
				await requestWorkflowStop(cwd, runId);
			},
		});

		await scheduleRun(cwd, run.runId);

		const finalRun = await readRunRecord(cwd, run.runId);
		const controller = taskBySpec(finalRun, "adaptive.controller");
		assert.equal(hookCalls, 1);
		assert.equal(existsSync(join(cwd, "controller-worker-started")), true);
		assert.equal(existsSync(join(cwd, controller.files.output)), false);
		assert.equal(existsSync(join(cwd, controller.files.result)), false);
		assert.equal(finalRun.status, "interrupted");
		assert.equal(controller.status, "interrupted");
		assert.equal(controller.statusDetail, "workflow_stopped");
	} finally {
		setDynamicControllerHooksForTests();
		cleanup(cwd);
	}
});

test("stop during dynamic helper terminates helper worker before delayed side effect", async () => {
	const cwd = makeProject();
	let scheduling;
	try {
		writeAgent(cwd, "unit-scout", "read");
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			[
				"export default async function controller(ctx) {",
				"  await ctx.helper('slow', {});",
				"  return { control: { schema: 'dynamic-controller-result-v1', summary: 'must not complete' }, analysis: 'done', refs: [] };",
				"}",
			].join("\n"),
		);
		writeFileSync(
			join(workflowDir, "helpers", "slow.mjs"),
			[
				"import { writeFile } from 'node:fs/promises';",
				"export default async function helper() {",
				`  await writeFile(${JSON.stringify(join(cwd, "dynamic-helper-started"))}, "started", "utf8");`,
				"  await new Promise((resolve) => setTimeout(resolve, 300));",
				`  await writeFile(${JSON.stringify(join(cwd, "dynamic-helper-after-stop"))}, "late", "utf8");`,
				"  return { analysis: 'late' };",
				"}",
			].join("\n"),
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: {
							uses: "./helpers/controller.mjs",
							helpers: { slow: { uses: "./helpers/slow.mjs" } },
						},
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Stop dynamic helper.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);
		scheduling = scheduleRun(cwd, run.runId);
		await eventually(
			() => assert.equal(existsSync(join(cwd, "dynamic-helper-started")), true),
			1500,
		);
		await stopRun(cwd, run.runId);
		await scheduling;
		await sleep(500);
		const finalRun = await readRunRecord(cwd, run.runId);
		const controller = taskBySpec(finalRun, "adaptive.controller");
		assert.equal(controller.status, "interrupted");
		assert.equal(controller.statusDetail, "workflow_stopped");
		assert.equal(existsSync(join(cwd, "dynamic-helper-after-stop")), false);
	} finally {
		if (scheduling)
			await Promise.race([scheduling.catch(() => undefined), sleep(500)]);
		cleanup(cwd);
	}
});

test("existing stop intent prevents dynamic nested workflow launch", async () => {
	const cwd = makeProject();
	let scheduling;
	try {
		writeAgent(cwd, "unit-scout", "read");
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		mkdirSync(join(workflowDir, "nested", "helpers"), { recursive: true });
		const releaseFile = join(cwd, "release-nested-call");
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			[
				"import { access, writeFile } from 'node:fs/promises';",
				`const readyFile = ${JSON.stringify(join(cwd, "nested-controller-ready"))};`,
				`const releaseFile = ${JSON.stringify(releaseFile)};`,
				"export default async function controller(ctx) {",
				"  await writeFile(readyFile, 'ready', 'utf8');",
				"  for (;;) {",
				"    try { await access(releaseFile); break; } catch {}",
				"    await new Promise((resolve) => setTimeout(resolve, 5));",
				"  }",
				"  await ctx.workflow('child', { task: 'Nested task', wait: false });",
				"  return { control: { schema: 'dynamic-controller-result-v1', summary: 'must not complete' }, analysis: 'done', refs: [] };",
				"}",
			].join("\n"),
		);
		writeFileSync(
			join(workflowDir, "nested", "helpers", "side-effect.mjs"),
			`import { writeFile } from 'node:fs/promises';\nexport default async function helper() { await writeFile(${JSON.stringify(join(cwd, "nested-launched"))}, "launched", "utf8"); return { schema: 'stage-control-v1', digest: 'launched' }; }\n`,
		);
		const nestedSpec = artifactGraphWorkflowSpec({
			name: "nested-child",
			artifactGraph: {
				stages: [
					{ id: "side", support: { uses: "./helpers/side-effect.mjs" } },
				],
			},
		});
		writeFileSync(
			join(workflowDir, "nested", "spec.json"),
			JSON.stringify(nestedSpec),
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: {
							uses: "./helpers/controller.mjs",
							workflows: { child: { uses: "./nested/spec.json" } },
						},
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Stop before nested.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);
		scheduling = scheduleRun(cwd, run.runId);
		await eventually(
			() =>
				assert.equal(existsSync(join(cwd, "nested-controller-ready")), true),
			1500,
		);
		await requestWorkflowStop(cwd, run.runId);
		writeFileSync(releaseFile, "release", "utf8");
		await scheduling;
		const finalRun = await readRunRecord(cwd, run.runId);
		const controller = taskBySpec(finalRun, "adaptive.controller");
		const childRuns = (await listRunRecords(cwd)).filter(
			(candidate) => candidate.parentRunId === run.runId,
		);
		assert.equal(controller.status, "interrupted");
		assert.equal(controller.statusDetail, "workflow_stopped");
		assert.equal(childRuns.length, 0);
		assert.equal(existsSync(join(cwd, "nested-launched")), false);
	} finally {
		writeFileSync(join(cwd, "release-nested-call"), "release", "utf8");
		if (scheduling)
			await Promise.race([scheduling.catch(() => undefined), sleep(500)]);
		cleanup(cwd);
	}
});

test("parent stop fences a registered nested child before its run record exists", async () => {
	const cwd = makeProject();
	try {
		const { run } = await createDynamicControllerRun(
			cwd,
			"export default async function controller() { return { control: { schema: 'dynamic-controller-result-v1', summary: 'unused' }, analysis: 'unused', refs: [] }; }",
		);
		const childRunId = "workflow_prelaunch_child";
		await appendDynamicEvent(cwd, run.runId, {
			controllerSpecId: "adaptive.controller",
			type: "workflow.started",
			opId: "adaptive.controller:workflow:child:001",
			requestHash: "registered-child-request",
			payload: {
				workflowId: "child",
				runId: childRunId,
				wait: false,
				status: "starting",
			},
		});

		const stoppedParent = await stopRun(cwd, run.runId);
		assert.equal(stoppedParent.run.status, "interrupted");
		assert.equal(
			(await listRunRecords(cwd)).some(
				(candidate) => candidate.runId === childRunId,
			),
			false,
		);
		assert.ok(await readWorkflowStopIntent(cwd, childRunId));

		const nestedDir = join(cwd, "workflows", "registered-child");
		mkdirSync(join(nestedDir, "helpers"), { recursive: true });
		writeFileSync(
			join(nestedDir, "helpers", "side-effect.mjs"),
			`import { writeFile } from "node:fs/promises";\nexport default async function helper() { await writeFile(${JSON.stringify(join(cwd, "registered-child-launched"))}, "launched", "utf8"); return { schema: "stage-control-v1", digest: "launched" }; }\n`,
		);
		const nestedSpecPath = join(nestedDir, "spec.json");
		writeFileSync(
			nestedSpecPath,
			JSON.stringify(
				artifactGraphWorkflowSpec({
					name: "registered-child",
					artifactGraph: {
						stages: [
							{
								id: "side",
								support: { uses: "./helpers/side-effect.mjs" },
							},
						],
					},
				}),
			),
		);

		const child = await runWorkflowSpec(nestedSpecPath, cwd, {
			task: "Must remain stopped.",
			runId: childRunId,
			parentRunId: run.runId,
		});
		assert.equal(child.status, "interrupted");
		assert.equal(child.tasks[0].status, "interrupted");
		assert.equal(child.tasks[0].statusDetail, "workflow_stopped");
		assert.equal(existsSync(join(cwd, "registered-child-launched")), false);
		assert.equal(await readWorkflowStopIntent(cwd, childRunId), undefined);
	} finally {
		cleanup(cwd);
	}
});

test("stopping parent cascades to active nested dynamic child before parent finalizes", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		let launches = 0;
		let interrupts = 0;
		setSubagentApiForTests({
			async runSubagent() {
				launches += 1;
				return {
					runId: `run_nested_active_${launches}`,
					attemptId: `attempt_nested_active_${launches}`,
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
				interrupts += 1;
				return {};
			},
		});
		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		mkdirSync(join(workflowDir, "nested"), { recursive: true });
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			[
				"export default async function controller(ctx) {",
				"  await ctx.workflow('child', { task: 'Nested task' });",
				"  return { control: { schema: 'dynamic-controller-result-v1', summary: 'child done' }, analysis: 'done', refs: [] };",
				"}",
			].join("\n"),
		);
		const nestedSpec = artifactGraphWorkflowSpec({
			name: "nested-active-child",
			artifactGraph: {
				stages: [{ id: "child", type: "single", prompt: "Child." }],
			},
		});
		writeFileSync(
			join(workflowDir, "nested", "spec.json"),
			JSON.stringify(nestedSpec),
		);
		const spec = artifactGraphWorkflowSpec({
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: {
							uses: "./helpers/controller.mjs",
							workflows: { child: { uses: "./nested/spec.json" } },
						},
					},
				],
			},
		});
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Stop active nested.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);
		await scheduleRun(cwd, run.runId);
		const childRuns = (await listRunRecords(cwd)).filter(
			(candidate) => candidate.parentRunId === run.runId,
		);
		assert.equal(childRuns.length, 1);
		assert.equal(childRuns[0].status, "running");
		await stopRun(cwd, run.runId);
		const finalParent = await readRunRecord(cwd, run.runId);
		const finalChild = await readRunRecord(cwd, childRuns[0].runId);
		assert.equal(interrupts, 1);
		assert.equal(finalChild.status, "interrupted");
		assert.equal(finalChild.tasks[0].status, "interrupted");
		assert.equal(finalChild.tasks[0].statusDetail, "workflow_stopped");
		assert.equal(finalParent.status, "interrupted");
		assert.equal(
			taskBySpec(finalParent, "adaptive.controller").status,
			"interrupted",
		);
		assert.equal(await readWorkflowStopIntent(cwd, run.runId), undefined);
		assert.equal(
			await readWorkflowStopIntent(cwd, finalChild.runId),
			undefined,
		);
	} finally {
		setSubagentApiForTests(undefined);
		cleanup(cwd);
	}
});

test("terminal child stop intent is cleared after lease-held cascade race", async () => {
	const cwd = makeProject();
	const releaseChildLease = deferred();
	let childLease;
	let stopping;
	try {
		writeAgent(cwd, "unit-scout", "read");
		const specPath = join(cwd, "workflows", "terminal-race.json");
		const spec = workflowSpec("unit-scout", {
			artifactGraph: {
				stages: [{ id: "task", type: "single", prompt: "Run." }],
			},
		});
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Terminal stop-intent race.",
			specPath,
		});
		const { run: parent } = await createWorkflowRunRecord(
			cwd,
			compiled,
			specPath,
		);
		const { run: child } = await createWorkflowRunRecord(
			cwd,
			compiled,
			specPath,
		);
		child.parentRunId = parent.runId;
		child.rootRunId = parent.runId;
		await writeStaticRunArtifacts(cwd, parent, compiled, spec);
		await writeStaticRunArtifacts(cwd, child, compiled, spec);
		await writeRunRecord(cwd, parent);
		await writeRunRecord(cwd, child);

		const childLeaseAcquired = deferred();
		childLease = withRunLease(cwd, child.runId, async () => {
			childLeaseAcquired.resolve();
			await releaseChildLease.promise;
			const leasedChild = await readRunRecord(cwd, child.runId);
			await completeTask(cwd, taskBySpec(leasedChild, "task.main"));
			await writeRunRecord(cwd, leasedChild);
		});
		await childLeaseAcquired.promise;

		stopping = stopRun(cwd, parent.runId);
		await eventually(() => {
			assert.equal(
				existsSync(
					join(cwd, ".pi", "workflows", child.runId, "stop-intent.json"),
				),
				true,
			);
		});
		await sleep(75);
		releaseChildLease.resolve();
		await childLease;
		await stopping;

		const finalParent = await readRunRecord(cwd, parent.runId);
		const finalChild = await readRunRecord(cwd, child.runId);
		assert.equal(finalParent.status, "interrupted");
		assert.equal(finalChild.status, "completed");
		assert.equal(await readWorkflowStopIntent(cwd, parent.runId), undefined);
		assert.equal(await readWorkflowStopIntent(cwd, child.runId), undefined);
	} finally {
		releaseChildLease.resolve();
		if (childLease)
			await Promise.race([childLease.catch(() => undefined), sleep(500)]);
		if (stopping)
			await Promise.race([stopping.catch(() => undefined), sleep(500)]);
		cleanup(cwd);
	}
});

test("fail-fast cancellation failure is not retried on repeated scheduler passes", () => {
	const compiled = {
		failurePolicy: { failFast: true, cancelSiblingsOnFailure: true },
		tasks: [{ id: "failed" }, { id: "running" }],
	};
	const run = {
		tasks: [
			{ taskId: "failed-task", specId: "failed", status: "failed" },
			{
				taskId: "running-task",
				specId: "running",
				status: "running",
				statusDetail: "cancellation_failed",
			},
		],
	};
	assert.deepEqual(markFailFastCancellations(run, compiled), {
		cancelledTaskIds: [],
		interruptedTaskIds: [],
	});
	assert.deepEqual(markFailFastCancellations(run, compiled), {
		cancelledTaskIds: [],
		interruptedTaskIds: [],
	});
});

test("successful fail-fast interruption releases the live model worker slot immediately", async () => {
	const cwd = makeProject();
	const originalLaunchLimit = process.env.PI_WORKFLOW_MAX_CONCURRENT_LAUNCHES;
	const originalLiveLimit = process.env.PI_WORKFLOW_MAX_LIVE_MODEL_WORKERS;
	process.env.PI_WORKFLOW_MAX_CONCURRENT_LAUNCHES = "2";
	process.env.PI_WORKFLOW_MAX_LIVE_MODEL_WORKERS = "1";
	setSubagentLaunchControlsForTests({ releaseDelayMs: 0, retryJitterMs: 0 });
	try {
		writeAgent(cwd, "unit-scout", "read");
		let launches = 0;
		let interrupts = 0;
		setSubagentApiForTests({
			async runSubagent() {
				launches += 1;
				return {
					runId: `run_ff_release_${launches}`,
					attemptId: `attempt_ff_release_${launches}`,
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
				interrupts += 1;
				return {};
			},
		});
		const spec = workflowSpec("unit-scout", {
			artifactGraph: {
				failFast: true,
				cancelSiblingsOnFailure: true,
				maxConcurrency: 2,
				stages: [
					{ id: "running", type: "single", prompt: "Run." },
					{ id: "failed", type: "single", prompt: "Fail." },
				],
			},
		});
		const compiled = await compileWorkflow(spec, { cwd, task: "Fail fast" });
		const { run } = await createWorkflowRunRecord(
			cwd,
			compiled,
			join(cwd, "workflows", "unit.json"),
		);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await launchSubagentTask(
			cwd,
			run,
			taskBySpec(run, "running.main"),
			compiled.tasks.find((task) => task.id === "running.main"),
		);
		await completeTask(cwd, taskBySpec(run, "failed.main"), {}, "failed");
		await writeRunRecord(cwd, run);
		await scheduleRun(cwd, run.runId);
		const cancelled = await readRunRecord(cwd, run.runId);
		assert.equal(taskBySpec(cancelled, "running.main").status, "interrupted");
		assert.equal(interrupts, 1);

		const next = makeSubagentLaunchFixture(cwd, "after_fail_fast_release");
		const nextLaunch = await Promise.race([
			launchSubagentTask(cwd, next.run, next.task, next.compiledTask),
			sleep(500).then(() => {
				throw new Error("fail-fast cancellation leaked live worker capacity");
			}),
		]);
		assert.equal(nextLaunch.kind, "launched");
	} finally {
		setSubagentApiForTests(undefined);
		setSubagentLaunchControlsForTests({ releaseDelayMs: 0, retryJitterMs: 0 });
		if (originalLaunchLimit === undefined)
			delete process.env.PI_WORKFLOW_MAX_CONCURRENT_LAUNCHES;
		else process.env.PI_WORKFLOW_MAX_CONCURRENT_LAUNCHES = originalLaunchLimit;
		if (originalLiveLimit === undefined)
			delete process.env.PI_WORKFLOW_MAX_LIVE_MODEL_WORKERS;
		else process.env.PI_WORKFLOW_MAX_LIVE_MODEL_WORKERS = originalLiveLimit;
		cleanup(cwd);
	}
});

test("foreach recovery repairs stale placeholder context before manifest launch", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const launched = [];
		setSubagentApiForTests({
			async runSubagent(options) {
				launched.push(options);
				return {
					runId: `run_foreach_recovery_${launched.length}`,
					attemptId: `attempt_foreach_recovery_${launched.length}`,
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
					{ id: "source", type: "single", prompt: "Source." },
					{
						id: "fan",
						type: "foreach",
						from: { source: "source", path: "$.items" },
						each: { prompt: "Fan ${item}." },
					},
					{
						id: "report",
						type: "single",
						after: "fan",
						from: "fan",
						prompt: "Report.",
						inputPolicy: { requiredReads: ["fan.control"] },
					},
				],
			},
		});
		const compiled = await compileWorkflow(spec, { cwd, task: "Foreach" });
		const { run } = await createWorkflowRunRecord(
			cwd,
			compiled,
			join(cwd, "workflows", "unit.json"),
		);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await completeTask(cwd, taskBySpec(run, "source.main"), {
			items: ["a", "b"],
		});
		await writeRunRecord(cwd, run);
		await scheduleRun(cwd, run.runId);
		const materialized = await readRunRecord(cwd, run.runId);
		await completeTask(cwd, taskBySpec(materialized, "fan.item-001"), {
			item: "a",
		});
		await completeTask(cwd, taskBySpec(materialized, "fan.item-002"), {
			item: "b",
		});
		await writeRunRecord(cwd, materialized);
		const compiledPath = join(
			cwd,
			".pi",
			"workflows",
			run.runId,
			"compiled.json",
		);
		const staleCompiled = JSON.parse(readFileSync(compiledPath, "utf8"));
		const staleReport = staleCompiled.tasks.find(
			(task) => task.id === "report.main",
		);
		staleReport.dependsOn = ["fan.item-001", "fan.item-002"];
		staleReport.contextDependsOn = ["fan.item"];
		await writeJsonAtomic(compiledPath, staleCompiled);
		await scheduleRun(cwd, run.runId);
		const recoveredCompiled = JSON.parse(readFileSync(compiledPath, "utf8"));
		assert.deepEqual(
			recoveredCompiled.tasks.find((task) => task.id === "report.main")
				.contextDependsOn,
			["fan.item-001", "fan.item-002"],
		);
		const launchedRun = await readRunRecord(cwd, run.runId);
		const report = taskBySpec(launchedRun, "report.main");
		assert.equal(report.status, "running");
		const manifest = JSON.parse(
			readFileSync(
				join(
					cwd,
					".pi",
					"workflows",
					run.runId,
					"tasks",
					report.taskId,
					"source-manifest.json",
				),
				"utf8",
			),
		);
		assert.deepEqual(
			manifest.sources.map((source) => source.specId),
			["fan.item-001", "fan.item-002"],
		);
	} finally {
		setSubagentApiForTests(undefined);
		cleanup(cwd);
	}
});

test("foreach materialization updates context dependencies for from plus after consumers", async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const launched = [];
		setSubagentApiForTests({
			async runSubagent(options) {
				launched.push(options);
				return {
					runId: `run_foreach_context_${launched.length}`,
					attemptId: `attempt_foreach_context_${launched.length}`,
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
					{ id: "source", type: "single", prompt: "Source." },
					{
						id: "fan",
						type: "foreach",
						from: { source: "source", path: "$.items" },
						each: { prompt: "Fan ${item}." },
					},
					{
						id: "report",
						type: "single",
						after: "fan",
						from: "fan",
						prompt: "Report.",
						inputPolicy: { requiredReads: ["fan.control"] },
					},
				],
			},
		});
		const compiled = await compileWorkflow(spec, { cwd, task: "Foreach" });
		const { run } = await createWorkflowRunRecord(
			cwd,
			compiled,
			join(cwd, "workflows", "unit.json"),
		);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await completeTask(cwd, taskBySpec(run, "source.main"), {
			items: ["a", "b"],
		});
		await writeRunRecord(cwd, run);
		await scheduleRun(cwd, run.runId);
		let materialized = await readRunRecord(cwd, run.runId);
		assert.deepEqual(taskBySpec(materialized, "report.main").dependsOn, [
			"fan.item-001",
			"fan.item-002",
		]);
		const materializedCompiled = JSON.parse(
			readFileSync(
				join(cwd, ".pi", "workflows", run.runId, "compiled.json"),
				"utf8",
			),
		);
		assert.deepEqual(
			materializedCompiled.tasks.find((task) => task.id === "report.main")
				.contextDependsOn,
			["fan.item-001", "fan.item-002"],
		);
		await completeTask(cwd, taskBySpec(materialized, "fan.item-001"), {
			item: "a",
		});
		await completeTask(cwd, taskBySpec(materialized, "fan.item-002"), {
			item: "b",
		});
		await writeRunRecord(cwd, materialized);
		await scheduleRun(cwd, run.runId);
		materialized = await readRunRecord(cwd, run.runId);
		const report = taskBySpec(materialized, "report.main");
		assert.equal(report.status, "running");
		const manifest = JSON.parse(
			readFileSync(
				join(
					cwd,
					".pi",
					"workflows",
					run.runId,
					"tasks",
					report.taskId,
					"source-manifest.json",
				),
				"utf8",
			),
		);
		assert.deepEqual(
			manifest.sources.map((source) => source.specId),
			["fan.item-001", "fan.item-002"],
		);
		assert.deepEqual(
			manifest.sources.map((source) => source.source),
			["fan", "fan.item-002"],
		);
	} finally {
		setSubagentApiForTests(undefined);
		cleanup(cwd);
	}
});
