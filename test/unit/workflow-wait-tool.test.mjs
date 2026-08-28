import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import { awaitWithinWorkflowWaitBoundary } from "../../.tmp/unit/engine.js";
import {
	acquireRunFileLease,
	setRunLeaseTestHooksForTests,
} from "../../.tmp/unit/store.js";
import {
	deliverWorkflowFeedback,
	setWorkflowFeedbackBindWaitMsForTests,
	setWorkflowFeedbackPollMsForTests,
	watchWorkflowFeedbackForTests,
	WORKFLOW_DYNAMIC_TOOL,
	WORKFLOW_RUN_TOOL,
	WORKFLOW_WAIT_TOOL,
	registerWorkflowNaturalLanguageTools,
	registerWorkflowWaitTool,
} from "../../.tmp/unit/extension.js";
import { summarizeWorkflowTerminal } from "../../.tmp/unit/workflow-terminal.js";
import { artifactGraphWorkflowSpec } from "./unit-test-support.mjs";

function fakePi(tools) {
	return {
		getThinkingLevel: () => "none",
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

async function writeFeedbackAudience(cwd, runId, sessionId) {
	await writeFile(
		join(cwd, ".pi", "workflows", runId, "feedback-audience.json"),
		`${JSON.stringify({
			schema: "workflow-feedback-audience-v1",
			runId,
			sessionId,
			boundAt: new Date().toISOString(),
		})}\n`,
	);
}

function feedbackContext(cwd, sessionId, overrides = {}) {
	return {
		cwd,
		hasUI: true,
		sessionManager: { getSessionId: () => sessionId },
		ui: { confirm: async () => false, notify: () => undefined },
		...overrides,
	};
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function terminalEpoch(run) {
	return createHash("sha256")
		.update(
			JSON.stringify({
				status: run.status,
				tasks: [...run.tasks]
					.sort((left, right) => left.taskId.localeCompare(right.taskId))
					.map((task) => ({
						taskId: task.taskId,
						specId: task.specId,
						status: task.status,
						statusDetail: task.statusDetail,
						startedAt: task.startedAt,
						completedAt: task.completedAt,
						exitCode: task.exitCode,
						resumeEvents: task.resumeEvents ?? [],
					})),
			}),
		)
		.digest("hex");
}

function parseJsonFixture(text) {
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new Error("invalid JSON test fixture", { cause: error });
	}
}

async function feedbackReceipts(cwd, runId) {
	const dir = join(
		cwd,
		".pi",
		"workflows",
		runId,
		"feedback-delivery-receipts",
	);
	const files = await readdir(dir).catch((error) => {
		if (error?.code === "ENOENT") return [];
		throw error;
	});
	return Promise.all(
		files
			.filter((file) => file.endsWith(".json"))
			.sort()
			.map(async (file) => ({
				file,
				receipt: parseJsonFixture(await readFile(join(dir, file), "utf8")),
			})),
	);
}

async function eventually(action, timeoutMs = 1_000) {
	const deadline = Date.now() + timeoutMs;
	let lastError;
	while (Date.now() <= deadline) {
		try {
			return await action();
		} catch (error) {
			lastError = error;
			await sleep(10);
		}
	}
	throw lastError;
}

test("workflow wait boundary enforces timeout and cancellation without owning the operation", async () => {
	const never = new Promise(() => {});
	const startedAt = Date.now();
	await assert.rejects(
		awaitWithinWorkflowWaitBoundary(
			never,
			25,
			undefined,
			"wait timeout sentinel",
		),
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

test("run-file lease retries release internally and abandons persistent failures for immediate reclaim", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "workflow-wait-lease-hooks-"));
	try {
		let initialReleaseAttempts = 0;
		setRunLeaseTestHooksForTests({
			onBeforeHeartbeat({ initial }) {
				if (initial) throw new Error("initial heartbeat hook failed");
			},
			onBeforeReleaseLockRename() {
				initialReleaseAttempts += 1;
				if (initialReleaseAttempts === 1)
					throw new Error("transient initial release hook failed");
			},
		});
		await assert.rejects(
			acquireRunFileLease(cwd, "workflow_hook_initial", "presentation"),
			/initial heartbeat hook failed/,
		);
		assert.equal(initialReleaseAttempts, 2);

		setRunLeaseTestHooksForTests(undefined);
		const transient = await acquireRunFileLease(
			cwd,
			"workflow_hook_transient",
			"presentation",
		);
		assert.ok(transient);
		let transientAttempts = 0;
		setRunLeaseTestHooksForTests({
			onBeforeReleaseLockRename() {
				transientAttempts += 1;
				if (transientAttempts === 1)
					throw new Error("transient release hook failed");
			},
		});
		await transient.release();
		assert.equal(transientAttempts, 2);

		setRunLeaseTestHooksForTests(undefined);
		const persistent = await acquireRunFileLease(
			cwd,
			"workflow_hook_persistent",
			"presentation",
		);
		assert.ok(persistent);
		let persistentAttempts = 0;
		setRunLeaseTestHooksForTests({
			onBeforeReleaseLockRename() {
				persistentAttempts += 1;
				throw new Error("persistent release hook failed");
			},
		});
		await assert.rejects(persistent.release(), /persistent release hook failed/);
		assert.equal(persistentAttempts, 3);
		setRunLeaseTestHooksForTests(undefined);
		const childScript = `
			import { acquireRunFileLease } from ${JSON.stringify(
				new URL("../../.tmp/unit/store.js", import.meta.url).href,
			)};
			const lease = await acquireRunFileLease(
				process.env.RECLAIM_CWD,
				"workflow_hook_persistent",
				"presentation",
				500,
			);
			if (!lease) throw new Error("child could not reclaim abandoned lease");
			await lease.release();
			process.stdout.write("reclaimed");
		`;
		const child = await execFileAsync(
			process.execPath,
			["--input-type=module", "-e", childScript],
			{ env: { ...process.env, RECLAIM_CWD: cwd } },
		);
		assert.equal(child.stdout, "reclaimed");

		const racing = await acquireRunFileLease(
			cwd,
			"workflow_hook_release_reclaim_race",
			"presentation",
		);
		assert.ok(racing);
		const releaseHookEntered = Promise.withResolvers();
		const continueRelease = Promise.withResolvers();
		const reclaimRenameCompleted = Promise.withResolvers();
		const continueReclaim = Promise.withResolvers();
		setRunLeaseTestHooksForTests({
			async onBeforeReleaseLockRename({ lockFile }) {
				if (!lockFile.includes("workflow_hook_release_reclaim_race")) return;
				releaseHookEntered.resolve();
				await continueRelease.promise;
			},
			async onAfterReclaimRename({ lockFile }) {
				if (!lockFile.includes("workflow_hook_release_reclaim_race")) return;
				reclaimRenameCompleted.resolve();
				await continueReclaim.promise;
			},
		});
		const racingRelease = racing.release();
		await releaseHookEntered.promise;
		const racingReclaim = acquireRunFileLease(
			cwd,
			"workflow_hook_release_reclaim_race",
			"presentation",
			500,
		);
		await reclaimRenameCompleted.promise;
		continueRelease.resolve();
		await racingRelease;
		continueReclaim.resolve();
		const reclaimedRace = await racingReclaim;
		assert.ok(reclaimedRace);
		setRunLeaseTestHooksForTests(undefined);
		await reclaimedRace.release();

		setRunLeaseTestHooksForTests({
			onBeforeHeartbeat({ initial }) {
				if (initial) throw new Error("persistent initial heartbeat failure");
			},
			onBeforeReleaseLockRename() {
				throw new Error("persistent initial cleanup failure");
			},
		});
		await assert.rejects(
			acquireRunFileLease(
				cwd,
				"workflow_hook_persistent_initial",
				"presentation",
			),
			/Failed to initialize and release run-file lease/,
		);
		setRunLeaseTestHooksForTests(undefined);
		const reclaimedInitial = await acquireRunFileLease(
			cwd,
			"workflow_hook_persistent_initial",
			"presentation",
		);
		assert.ok(reclaimedInitial);
		await reclaimedInitial.release();
	} finally {
		setRunLeaseTestHooksForTests(undefined);
		await rm(cwd, { recursive: true, force: true });
	}
});

test("workflow terminal wait spends one deadline across presentation and run waiting", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "workflow-wait-one-deadline-"));
	try {
		const run = runRecord(cwd, { runId: "workflow_one_deadline" });
		await writeRunFixture(cwd, run);
		await writeFeedbackAudience(cwd, run.runId, "session-deadline");
		setRunLeaseTestHooksForTests({
			async onBeforeHeartbeat({ name, initial }) {
				if (name === "feedback-presentation" && initial) await sleep(1_100);
			},
		});
		const tools = [];
		registerWorkflowWaitTool(fakePi(tools), { PI_WORKFLOW_ROLE: "supervisor" });
		const startedAt = Date.now();
		await assert.rejects(
			tools[0].execute(
				"call-deadline",
				{ runId: run.runId, timeoutMs: 1_000 },
				new AbortController().signal,
				undefined,
				feedbackContext(cwd, "session-deadline", { hasUI: false }),
			),
			/still running after 1000ms wait/,
		);
		assert.ok(Date.now() - startedAt < 1_500);
	} finally {
		setRunLeaseTestHooksForTests(undefined);
		await rm(cwd, { recursive: true, force: true });
	}
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

test("terminal presentation rejects a foreign session without changing the audience", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "workflow-wait-foreign-owner-"));
	try {
		const run = runRecord(cwd, { runId: "workflow_foreign_owner" });
		await writeRunFixture(cwd, run);
		await writeFeedbackAudience(cwd, run.runId, "session-owner");
		const tools = [];
		registerWorkflowWaitTool(fakePi(tools), { PI_WORKFLOW_ROLE: "supervisor" });
		await assert.rejects(
			tools[0].execute(
				"call-foreign",
				{ runId: run.runId, timeoutMs: 60_000 },
				new AbortController().signal,
				undefined,
				feedbackContext(cwd, "session-other"),
			),
			/not owned by the current session/,
		);
		const audience = JSON.parse(
			await readFile(join(cwd, ".pi", "workflows", run.runId, "feedback-audience.json"), "utf8"),
		);
		assert.equal(audience.sessionId, "session-owner");
		await assert.rejects(
			readFile(join(cwd, ".pi", "workflows", run.runId, "feedback-delivery.json"), "utf8"),
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
		assert.doesNotMatch(
			result.content[0].text,
			/Watcher-owned terminal result/,
		);
		assert.equal(sends, 1);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("successful completion feedback requests a result-only summary", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "workflow-result-only-feedback-"));
	try {
		const run = runRecord(cwd, { runId: "workflow_result_only" });
		await writeRunFixture(cwd, run, {
			completionSummaryMarkdown:
				"## Core conclusion\n\nUse the verified result.\n\n## Evidence level\n\n- 4 verified claims.",
			executiveMarkdown: "# Full report\n\nFULL_REPORT_ONLY_TEXT",
			sidecarPath: "final-report.md",
			auditSidecarPath: "audit.md",
		});
		await writeFeedbackAudience(cwd, run.runId, "session-result-only");
		const sent = [];

		const outcome = await deliverWorkflowFeedback(
			feedbackContext(cwd, "session-result-only"),
			{
				sendMessage(message, options) {
					sent.push({ message, options });
				},
			},
			run,
		);

		assert.deepEqual(outcome, { status: "delivered" });
		assert.equal(sent.length, 1);
		assert.match(sent[0].message.content, /Use the verified result/);
		assert.match(sent[0].message.content, /substantive workflow result/);
		assert.match(sent[0].message.content, /Do not mention routine completion status/);
		assert.doesNotMatch(sent[0].message.content, /FULL_REPORT_ONLY_TEXT/);
		assert.doesNotMatch(sent[0].message.content, /Open: \/workflow/);
		assert.doesNotMatch(sent[0].message.content, /completed, 0 failed/);
		assert.doesNotMatch(sent[0].message.content, /link relevant artifacts/);
		assert.doesNotMatch(sent[0].message.content, /final-report\.md|audit\.md/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("delivery claims enforce audience identity and report structured outcomes", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "workflow-wait-claim-audience-"));
	try {
		const run = runRecord(cwd, { runId: "workflow_claim_audience" });
		await writeRunFixture(cwd, run);
		await writeFeedbackAudience(cwd, run.runId, "session-owner");
		await writeFile(
			join(cwd, ".pi", "workflows", run.runId, "feedback-delivery.json"),
			`${JSON.stringify({ schema: "workflow-feedback-delivery-v1", runId: run.runId, sessionId: "session-other", delivered: {} })}\n`,
		);
		let sends = 0;
		await assert.rejects(
			deliverWorkflowFeedback(
				feedbackContext(cwd, "session-owner"),
				{ sendMessage: () => (sends += 1) },
				run,
			),
			/delivery belongs to another session/,
		);
		assert.equal(sends, 0);
		const foreign = await deliverWorkflowFeedback(
			feedbackContext(cwd, "session-other"),
			{ sendMessage: () => (sends += 1) },
			run,
		);
		assert.deepEqual(foreign, { status: "not-owner" });
		assert.equal(sends, 0);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("immutable completion receipt precedes best-effort UI notification", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "workflow-wait-notify-"));
	try {
		const run = runRecord(cwd, { runId: "workflow_notify_best_effort" });
		await writeRunFixture(cwd, run);
		await writeFeedbackAudience(cwd, run.runId, "session-notify");
		let sends = 0;
		const outcome = await deliverWorkflowFeedback(
			feedbackContext(cwd, "session-notify", {
				ui: { notify: () => { throw new Error("UI notification failed"); } },
			}),
			{ sendMessage: () => (sends += 1) },
			run,
		);
		assert.deepEqual(outcome, { status: "delivered" });
		assert.equal(sends, 1);
		const receipts = await feedbackReceipts(cwd, run.runId);
		assert.equal(receipts.length, 1);
		assert.equal(
			receipts[0].receipt.schema,
			"workflow-feedback-delivery-receipt-v1",
		);
		assert.equal(receipts[0].receipt.sessionId, "session-notify");
		await assert.rejects(
			readFile(
				join(cwd, ".pi", "workflows", run.runId, "feedback-delivery.json"),
				"utf8",
			),
			(error) => error?.code === "ENOENT",
		);
		const repeated = await deliverWorkflowFeedback(
			feedbackContext(cwd, "session-notify"),
			{ sendMessage: () => (sends += 1) },
			run,
		);
		assert.deepEqual(repeated, { status: "already-delivered" });
		assert.equal(sends, 1);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("terminal delivery epochs allow same-status resume and migrate legacy markers", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "workflow-wait-epochs-"));
	try {
		const base = runRecord(cwd, { runId: "workflow_same_status_resume" });
		const first = {
			...base,
			status: "failed",
			taskSummary: {
				...base.taskSummary,
				completed: 0,
				failed: 1,
			},
			tasks: [
				{
					...base.tasks[0],
					status: "failed",
					statusDetail: "first failure",
					completedAt: "2026-07-25T00:00:01.000Z",
				},
			],
		};
		await writeRunFixture(cwd, first);
		await writeFeedbackAudience(cwd, first.runId, "session-epochs");
		let sends = 0;
		assert.deepEqual(
			await deliverWorkflowFeedback(
				feedbackContext(cwd, "session-epochs"),
				{ sendMessage: () => (sends += 1) },
				first,
			),
			{ status: "delivered" },
		);
		const resumed = {
			...first,
			updatedAt: "2026-07-25T00:00:03.000Z",
			tasks: [
				{
					...first.tasks[0],
					statusDetail: "second failure",
					completedAt: "2026-07-25T00:00:03.000Z",
					resumeEvents: [
						{
							at: "2026-07-25T00:00:02.000Z",
							fromStatus: "failed",
							fromStatusDetail: "first failure",
						},
					],
				},
			],
		};
		assert.deepEqual(
			await deliverWorkflowFeedback(
				feedbackContext(cwd, "session-epochs"),
				{ sendMessage: () => (sends += 1) },
				resumed,
			),
			{ status: "delivered" },
		);
		assert.equal(sends, 2);
		assert.equal((await feedbackReceipts(cwd, first.runId)).length, 2);

		const legacy = runRecord(cwd, { runId: "workflow_legacy_delivery" });
		await writeRunFixture(cwd, legacy);
		await writeFeedbackAudience(cwd, legacy.runId, "session-legacy");
		await writeFile(
			join(cwd, ".pi", "workflows", legacy.runId, "feedback-delivery.json"),
			`${JSON.stringify({
				schema: "workflow-feedback-delivery-v1",
				runId: legacy.runId,
				sessionId: "session-legacy",
				delivered: { completed: "2026-07-25T00:00:02.000Z" },
			})}\n`,
		);
		const legacyOutcome = await deliverWorkflowFeedback(
			feedbackContext(cwd, "session-legacy"),
			{ sendMessage: () => (sends += 1) },
			legacy,
		);
		assert.deepEqual(legacyOutcome, { status: "already-delivered" });
		assert.equal(sends, 2);
		const retainedLegacy = JSON.parse(
			await readFile(
				join(cwd, ".pi", "workflows", legacy.runId, "feedback-delivery.json"),
				"utf8",
			),
		);
		assert.equal(retainedLegacy.schema, "workflow-feedback-delivery-v1");
		assert.equal(retainedLegacy.delivered.completed, "2026-07-25T00:00:02.000Z");
		assert.equal((await feedbackReceipts(cwd, legacy.runId)).length, 1);
		await writeFile(
			join(cwd, ".pi", "workflows", legacy.runId, "feedback-delivery.json"),
			"{ malformed legacy marker\n",
		);
		assert.deepEqual(
			await deliverWorkflowFeedback(
				feedbackContext(cwd, "session-legacy"),
				{ sendMessage: () => (sends += 1) },
				legacy,
			),
			{ status: "already-delivered" },
		);
		assert.equal(sends, 2);

		const invalidResume = {
			...legacy,
			runId: "workflow_legacy_invalid_resume_time",
			tasks: [
				{
					...legacy.tasks[0],
					resumeEvents: [
						{
							at: "invalid-resume-time",
							fromStatus: "completed",
							fromStatusDetail: "completed",
						},
					],
				},
			],
		};
		await writeRunFixture(cwd, invalidResume);
		await writeFeedbackAudience(
			cwd,
			invalidResume.runId,
			"session-invalid-resume",
		);
		await writeFile(
			join(
				cwd,
				".pi",
				"workflows",
				invalidResume.runId,
				"feedback-delivery.json",
			),
			`${JSON.stringify({
				schema: "workflow-feedback-delivery-v1",
				runId: invalidResume.runId,
				sessionId: "session-invalid-resume",
				delivered: { completed: "2026-07-25T00:00:02.000Z" },
			})}\n`,
		);
		let invalidResumeSends = 0;
		assert.deepEqual(
			await deliverWorkflowFeedback(
				feedbackContext(cwd, "session-invalid-resume"),
				{ sendMessage: () => (invalidResumeSends += 1) },
				invalidResume,
			),
			{ status: "delivered" },
		);
		assert.equal(invalidResumeSends, 1);

		const legacyResumed = {
			...first,
			runId: "workflow_legacy_same_status_resume",
			tasks: [
				{
					...first.tasks[0],
					completedAt: "2026-07-25T00:00:03.000Z",
					resumeEvents: [
						{
							at: "2026-07-25T00:00:02.000Z",
							fromStatus: "failed",
							fromStatusDetail: "first failure",
						},
					],
				},
			],
		};
		await writeRunFixture(cwd, legacyResumed);
		await writeFeedbackAudience(cwd, legacyResumed.runId, "session-legacy-resume");
		await writeFile(
			join(cwd, ".pi", "workflows", legacyResumed.runId, "feedback-delivery.json"),
			`${JSON.stringify({
				schema: "workflow-feedback-delivery-v1",
				runId: legacyResumed.runId,
				sessionId: "session-legacy-resume",
				delivered: { failed: "2026-07-25T00:00:01.000Z" },
			})}\n`,
		);
		assert.deepEqual(
			await deliverWorkflowFeedback(
				feedbackContext(cwd, "session-legacy-resume"),
				{ sendMessage: () => (sends += 1) },
				legacyResumed,
			),
			{ status: "delivered" },
		);
		assert.equal(sends, 3);
		assert.equal((await feedbackReceipts(cwd, legacyResumed.runId)).length, 1);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("exclusive epoch receipts preserve prior epochs across final-boundary lease loss", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "workflow-wait-receipt-fence-"));
	try {
		const first = runRecord(cwd, { runId: "workflow_receipt_fence" });
		await writeRunFixture(cwd, first);
		await writeFeedbackAudience(cwd, first.runId, "session-receipt-fence");
		await deliverWorkflowFeedback(
			feedbackContext(cwd, "session-receipt-fence"),
			{ sendMessage: () => undefined },
			first,
		);
		const firstReceipts = await feedbackReceipts(cwd, first.runId);
		assert.equal(firstReceipts.length, 1);
		const preservedFirst = JSON.stringify(firstReceipts[0].receipt);
		const resumed = {
			...first,
			updatedAt: "2026-07-25T00:00:03.000Z",
			tasks: [
				{
					...first.tasks[0],
					statusDetail: "completed after resume",
					completedAt: "2026-07-25T00:00:03.000Z",
					resumeEvents: [
						{
							at: "2026-07-25T00:00:02.000Z",
							fromStatus: "completed",
							fromStatusDetail: "completed",
						},
					],
				},
			],
		};
		const secondReceiptPath = join(
			cwd,
			".pi",
			"workflows",
			first.runId,
			"feedback-delivery-receipts",
			`${terminalEpoch(resumed)}.json`,
		);
		const sends = [];
		let winnerOutcome;
		setRunLeaseTestHooksForTests({
			async onBeforeExclusiveLink({ file }) {
				if (file !== secondReceiptPath) return;
				await rename(
					join(cwd, ".pi", "workflows", first.runId, "feedback-presentation.lock"),
					join(cwd, ".pi", "workflows", first.runId, "feedback-presentation.lost"),
				);
				setRunLeaseTestHooksForTests(undefined);
				winnerOutcome = await deliverWorkflowFeedback(
					feedbackContext(cwd, "session-receipt-fence"),
					{ sendMessage: () => sends.push("winner") },
					resumed,
				);
			},
		});
		await assert.rejects(
			deliverWorkflowFeedback(
				feedbackContext(cwd, "session-receipt-fence"),
				{ sendMessage: () => sends.push("stale") },
				resumed,
			),
			/Lost supervisor lease/,
		);
		assert.deepEqual(winnerOutcome, { status: "delivered" });
		assert.deepEqual(sends, ["stale", "winner"]);
		const receipts = await feedbackReceipts(cwd, first.runId);
		assert.equal(receipts.length, 2);
		assert.equal(
			JSON.stringify(
				receipts.find(({ file }) => file === firstReceipts[0].file).receipt,
			),
			preservedFirst,
		);
		assert.equal(
			receipts.find(({ file }) => file === `${terminalEpoch(resumed)}.json`)
				.receipt.status,
			"completed",
		);
	} finally {
		setRunLeaseTestHooksForTests(undefined);
		await rm(cwd, { recursive: true, force: true });
	}
});

test("feedback watcher single-flights delivery and retries a failed send", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "workflow-wait-watcher-retry-"));
	const controller = new AbortController();
	let rejectFirst;
	try {
		const run = runRecord(cwd, { runId: "workflow_watcher_retry" });
		await writeRunFixture(cwd, run);
		await writeFeedbackAudience(cwd, run.runId, "session-watcher-retry");
		setWorkflowFeedbackPollMsForTests(5);
		let sends = 0;
		watchWorkflowFeedbackForTests(
			feedbackContext(cwd, "session-watcher-retry"),
			{
				sendMessage() {
					sends += 1;
					if (sends === 1)
						return new Promise((_, reject) => {
							rejectFirst = reject;
						});
				},
			},
			run.runId,
			controller.signal,
		);
		await eventually(() => assert.equal(sends, 1));
		await sleep(30);
		assert.equal(sends, 1, "poll ticks must not overlap an in-flight send");
		rejectFirst(new Error("transient send failure"));
		await eventually(() => assert.equal(sends, 2));
		await eventually(async () => {
			assert.equal((await feedbackReceipts(cwd, run.runId)).length, 1);
		});
		controller.abort();
		const reclaimed = await eventually(async () => {
			const lease = await acquireRunFileLease(
				cwd,
				run.runId,
				"feedback-presentation",
			);
			assert.ok(lease);
			return lease;
		}, 2_000);
		await reclaimed.release();
	} finally {
		controller.abort();
		setWorkflowFeedbackPollMsForTests(undefined);
		await rm(cwd, { recursive: true, force: true });
	}
});

test("feedback watcher stops after retry exhaustion and warns once", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "workflow-wait-watcher-exhausted-"));
	const controller = new AbortController();
	try {
		const run = runRecord(cwd, { runId: "workflow_watcher_exhausted" });
		await writeRunFixture(cwd, run);
		await writeFeedbackAudience(cwd, run.runId, "session-watcher-exhausted");
		setWorkflowFeedbackPollMsForTests(5);
		let sends = 0;
		const warnings = [];
		watchWorkflowFeedbackForTests(
			feedbackContext(cwd, "session-watcher-exhausted", {
				ui: { notify: (message) => warnings.push(message) },
			}),
			{
				sendMessage() {
					sends += 1;
					throw new Error("persistent send failure");
				},
			},
			run.runId,
			controller.signal,
		);
		await eventually(() => {
			assert.equal(sends, 4);
			assert.equal(warnings.length, 1);
		});
		assert.match(warnings[0], new RegExp(`/workflow wait ${run.runId}`));
		await sleep(75);
		assert.equal(sends, 4);
		assert.equal(warnings.length, 1);
	} finally {
		controller.abort();
		setWorkflowFeedbackPollMsForTests(undefined);
		await rm(cwd, { recursive: true, force: true });
	}
});

test("legacy, v1, and malformed v2 delivery markers are permanent", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "workflow-wait-malformed-markers-"));
	try {
		const cases = [
			{
				name: "legacy-map",
				marker: (run) => ({ runId: run.runId, delivered: [] }),
			},
			{
				name: "v1-audience",
				marker: (run) => ({
					schema: "workflow-feedback-delivery-v1",
					runId: run.runId,
					delivered: {},
				}),
			},
			{
				name: "v2-audience",
				marker: () => ({
					schema: "workflow-feedback-delivery-v2",
					sessionId: "session-malformed",
					deliveredEpochs: {},
				}),
			},
			{
				name: "v2-map",
				marker: (run) => ({
					schema: "workflow-feedback-delivery-v2",
					runId: run.runId,
					sessionId: "session-malformed",
					deliveredEpochs: [],
				}),
			},
			{
				name: "v2-entry",
				marker: (run) => ({
					schema: "workflow-feedback-delivery-v2",
					runId: run.runId,
					sessionId: "session-malformed",
					deliveredEpochs: { [terminalEpoch(run)]: "invalid" },
				}),
			},
			{
				name: "v2-status",
				marker: (run) => ({
					schema: "workflow-feedback-delivery-v2",
					runId: run.runId,
					sessionId: "session-malformed",
					deliveredEpochs: {
						[terminalEpoch(run)]: {
							status: "failed",
							deliveredAt: "2026-07-25T00:00:02.000Z",
						},
					},
				}),
			},
			{
				name: "v2-timestamp",
				marker: (run) => ({
					schema: "workflow-feedback-delivery-v2",
					runId: run.runId,
					sessionId: "session-malformed",
					deliveredEpochs: {
						[terminalEpoch(run)]: {
							status: run.status,
							deliveredAt: "not-a-timestamp",
						},
					},
				}),
			},
		];
		for (const entry of cases) {
			const run = runRecord(cwd, {
				runId: `workflow_malformed_${entry.name.replaceAll("-", "_")}`,
			});
			await writeRunFixture(cwd, run);
			await writeFeedbackAudience(cwd, run.runId, "session-malformed");
			await writeFile(
				join(cwd, ".pi", "workflows", run.runId, "feedback-delivery.json"),
				`${JSON.stringify(entry.marker(run))}\n`,
			);
			let sends = 0;
			await assert.rejects(
				deliverWorkflowFeedback(
					feedbackContext(cwd, "session-malformed"),
					{ sendMessage: () => (sends += 1) },
					run,
				),
				/marker|epochs|entry|status|timestamp|session/,
				entry.name,
			);
			assert.equal(sends, 0, entry.name);
		}
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("malformed receipt shape, audience, status, and timestamp are permanent", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "workflow-wait-malformed-receipts-"));
	try {
		for (const variant of ["shape", "audience", "status", "timestamp"]) {
			const run = runRecord(cwd, { runId: `workflow_receipt_${variant}` });
			await writeRunFixture(cwd, run);
			await writeFeedbackAudience(cwd, run.runId, "session-receipt-invalid");
			const epoch = terminalEpoch(run);
			const receiptFile = join(
				cwd,
				".pi",
				"workflows",
				run.runId,
				"feedback-delivery-receipts",
				`${epoch}.json`,
			);
			await mkdir(dirname(receiptFile), { recursive: true });
			const valid = {
				schema: "workflow-feedback-delivery-receipt-v1",
				runId: run.runId,
				sessionId: "session-receipt-invalid",
				epoch,
				status: run.status,
				deliveredAt: "2026-07-25T00:00:02.000Z",
				presentationOwnerId: "123-owner",
			};
			let receipt;
			switch (variant) {
				case "shape":
					receipt = [];
					break;
				case "audience":
					receipt = { ...valid, sessionId: "session-other" };
					break;
				case "status":
					receipt = { ...valid, status: "failed" };
					break;
				default:
					receipt = { ...valid, deliveredAt: "invalid" };
			}
			await writeFile(receiptFile, `${JSON.stringify(receipt)}\n`);
			let sends = 0;
			await assert.rejects(
				deliverWorkflowFeedback(
					feedbackContext(cwd, "session-receipt-invalid"),
					{ sendMessage: () => (sends += 1) },
					run,
				),
				/receipt/,
				variant,
			);
			assert.equal(sends, 0, variant);
		}
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("feedback watcher classifies invalid delivery markers as permanent", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "workflow-wait-watcher-permanent-"));
	const controller = new AbortController();
	try {
		const run = runRecord(cwd, { runId: "workflow_watcher_permanent" });
		await writeRunFixture(cwd, run);
		await writeFeedbackAudience(cwd, run.runId, "session-watcher-permanent");
		await writeFile(
			join(cwd, ".pi", "workflows", run.runId, "feedback-delivery.json"),
			`${JSON.stringify({
				schema: "workflow-feedback-delivery-unknown",
				runId: run.runId,
				sessionId: "session-watcher-permanent",
			})}\n`,
		);
		setWorkflowFeedbackPollMsForTests(5);
		let sends = 0;
		const warnings = [];
		watchWorkflowFeedbackForTests(
			feedbackContext(cwd, "session-watcher-permanent", {
				ui: { notify: (message) => warnings.push(message) },
			}),
			{ sendMessage: () => (sends += 1) },
			run.runId,
			controller.signal,
		);
		await eventually(() => assert.equal(warnings.length, 1));
		assert.equal(sends, 0);
		assert.match(warnings[0], /unsupported delivery marker/);
		await sleep(50);
		assert.equal(warnings.length, 1);
	} finally {
		controller.abort();
		setWorkflowFeedbackPollMsForTests(undefined);
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
	assert.match(
		tools[0].promptGuidelines.join("\n"),
		/Do not repeatedly read run\.json/,
	);
	assert.deepEqual(tools[0].parameters.required, ["runId"]);
	assert.equal(tools[0].parameters.properties.timeoutMs.maximum, 14_400_000);
});

test("workflow wait returns a terminal result without model polling", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "workflow-wait-tool-"));
	try {
		const run = runRecord(cwd);
		await writeRunFixture(cwd, run, {
			completionSummaryMarkdown:
				"## Core conclusion\n\nCompleted result from the workflow.",
			executiveMarkdown: "# Full report\n\nFULL_REPORT_ONLY_TEXT",
			sidecarPath: "final-report.md",
			auditSidecarPath: "audit.md",
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
		assert.equal(
			result.content[0].text,
			"## Core conclusion\n\nCompleted result from the workflow.",
		);
		assert.doesNotMatch(result.content[0].text, /Workflow terminal|Run:/);
		assert.doesNotMatch(
			result.content[0].text,
			/Artifacts:|final-report\.md|audit\.md|FULL_REPORT_ONLY_TEXT/,
		);
		assert.equal(updates.length, 1);
		assert.equal(updates[0].details.taskSummary.completed, 1);
		assert.equal((await feedbackReceipts(cwd, run.runId)).length, 1);
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

test("successful workflow wait survives persistent final release failure", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "workflow-wait-release-success-"));
	try {
		const run = runRecord(cwd, { runId: "workflow_wait_release_success" });
		await writeRunFixture(cwd, run, { executiveMarkdown: "Durable result." });
		await writeFeedbackAudience(cwd, run.runId, "session-release-success");
		let releaseAttempts = 0;
		setRunLeaseTestHooksForTests({
			onBeforeReleaseLockRename({ lockFile }) {
				if (!lockFile.endsWith("feedback-presentation.lock")) return;
				releaseAttempts += 1;
				throw new Error("persistent final release failure");
			},
		});
		const tools = [];
		registerWorkflowWaitTool(fakePi(tools), {
			PI_WORKFLOW_ROLE: "supervisor",
		});
		const result = await tools[0].execute(
			"call-release-success",
			{ runId: run.runId, timeoutMs: 60_000 },
			new AbortController().signal,
			undefined,
			feedbackContext(cwd, "session-release-success", { hasUI: false }),
		);
		assert.equal(result.details.status, "completed");
		assert.match(result.details.finalResultPreview, /Durable result/);
		assert.equal(releaseAttempts, 3);
		assert.equal((await feedbackReceipts(cwd, run.runId)).length, 1);
		setRunLeaseTestHooksForTests(undefined);
		const reclaimed = await acquireRunFileLease(
			cwd,
			run.runId,
			"feedback-presentation",
		);
		assert.ok(reclaimed);
		await reclaimed.release();
	} finally {
		setRunLeaseTestHooksForTests(undefined);
		await rm(cwd, { recursive: true, force: true });
	}
});

test("workflow wait timeout preserves its error and hands delivery back after release failure", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "workflow-wait-release-timeout-"));
	try {
		const base = runRecord(cwd, { runId: "workflow_wait_release_timeout" });
		await writeRunFixture(cwd, base, { executiveMarkdown: "Watcher handoff result." });
		await writeFeedbackAudience(cwd, base.runId, "session-release-timeout");
		setWorkflowFeedbackPollMsForTests(5);
		let releaseAttempts = 0;
		let delayedInitialLease = false;
		setRunLeaseTestHooksForTests({
			async onBeforeHeartbeat({ name, initial }) {
				if (
					name === "feedback-presentation" &&
					initial &&
					!delayedInitialLease
				) {
					delayedInitialLease = true;
					await sleep(1_100);
				}
			},
			onBeforeReleaseLockRename({ lockFile }) {
				if (!lockFile.endsWith("feedback-presentation.lock")) return;
				releaseAttempts += 1;
				throw new Error("persistent timeout release failure");
			},
		});
		const tools = [];
		const api = fakePi(tools);
		let sends = 0;
		api.sendMessage = () => (sends += 1);
		registerWorkflowWaitTool(api, { PI_WORKFLOW_ROLE: "supervisor" });
		await assert.rejects(
			tools[0].execute(
				"call-release-timeout",
				{ runId: base.runId, timeoutMs: 1_000 },
				new AbortController().signal,
				undefined,
				feedbackContext(cwd, "session-release-timeout"),
			),
			/still running after 1000ms wait/,
		);
		assert.ok(releaseAttempts >= 3);
		setRunLeaseTestHooksForTests(undefined);
		await eventually(() => assert.equal(sends, 1), 2_000);
		await eventually(
			async () =>
				assert.equal((await feedbackReceipts(cwd, base.runId)).length, 1),
			2_000,
		);
		const reclaimed = await eventually(async () => {
			const lease = await acquireRunFileLease(
				cwd,
				base.runId,
				"feedback-presentation",
			);
			assert.ok(lease);
			return lease;
		}, 2_000);
		await reclaimed.release();
	} finally {
		setRunLeaseTestHooksForTests(undefined);
		setWorkflowFeedbackPollMsForTests(undefined);
		await eventually(
			() => rm(cwd, { recursive: true, force: true }),
			2_000,
		);
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
		await writeFeedbackAudience(cwd, run.runId, "session-blocked");
		const tools = [];
		registerWorkflowWaitTool(fakePi(tools), {
			PI_WORKFLOW_ROLE: "supervisor",
		});
		const result = await tools[0].execute(
			"call-blocked",
			{ runId: run.runId, timeoutMs: 60_000 },
			new AbortController().signal,
			undefined,
			{
				...feedbackContext(cwd, "session-blocked"),
				hasUI: false,
			},
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

test("result-only completion is limited to successful semantic statuses with output", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "workflow-result-only-statuses-"));
	try {
		for (const [status, preview] of [
			["synthesized", "Synthesized result."],
			["exhausted", "Exhausted result."],
		]) {
			const runId = `workflow_result_only_${status}`;
			const run = runRecord(cwd, {
				runId,
				provenance: { mode: "direct-dynamic" },
				tasks: [
					taskRecord(runId, "controller", "dynamic.controller", {
						kind: "dynamic",
						statusDetail: "dynamic_completed",
					}),
					taskRecord(runId, "synthesis", "dynamic.synthesis", {
						dynamicGenerated: { outputProfile: "synthesis_v1" },
					}),
				],
			});
			await writeRunFixture(cwd, run, {
				schema: "dynamic-controller-result-v1",
				status,
				outputTasks: ["dynamic.synthesis"],
			});
			await writeDynamicControl(cwd, { tasks: [run.tasks[1]] }, {
				summary: status === "synthesized" ? preview : "",
			});
			if (status === "exhausted") {
				await writeFile(
					join(cwd, dirname(run.tasks[1].files.output), "analysis.md"),
					`${preview}\n`,
				);
			}
			await writeFeedbackAudience(cwd, runId, `session-${status}`);
			const sent = [];
			const outcome = await deliverWorkflowFeedback(
				feedbackContext(cwd, `session-${status}`),
				{ sendMessage: (message) => sent.push(message) },
				run,
			);
			assert.deepEqual(outcome, { status: "delivered" });
			assert.equal(sent.length, 1);
			assert.match(sent[0].content, /substantive workflow result/);
		}

		const blankId = "workflow_result_only_blank";
		const blankRun = runRecord(cwd, {
			runId: blankId,
			provenance: { mode: "direct-dynamic" },
			tasks: [
				taskRecord(blankId, "controller", "dynamic.controller", {
					kind: "dynamic",
					statusDetail: "dynamic_completed",
				}),
				taskRecord(blankId, "synthesis", "dynamic.synthesis", {
					dynamicGenerated: { outputProfile: "synthesis_v1" },
				}),
			],
		});
		await writeRunFixture(cwd, blankRun, {
			schema: "dynamic-controller-result-v1",
			status: "exhausted",
			outputTasks: ["dynamic.synthesis"],
		});
		await writeDynamicControl(cwd, { tasks: [blankRun.tasks[1]] }, { summary: "   " });
		await writeFeedbackAudience(cwd, blankId, "session-blank");
		const blankSent = [];
		await deliverWorkflowFeedback(
			feedbackContext(cwd, "session-blank"),
			{ sendMessage: (message) => blankSent.push(message) },
			blankRun,
		);
		assert.equal(blankSent.length, 1);
		assert.doesNotMatch(blankSent[0].content, /substantive workflow result/);
		assert.match(blankSent[0].content, /Summarize the workflow outcome/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("workflow preview ignores sidecar traversal paths", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "workflow-preview-traversal-"));
	try {
		const runId = "workflow_preview_traversal";
		const run = runRecord(cwd, { runId });
		const outsidePath = join(cwd, "outside-preview.md");
		await writeFile(outsidePath, "MUST NOT BE PREVIEWED\n");
		await writeRunFixture(cwd, run, {
			sidecarPath: "../../../../../outside-preview.md",
		});
		await writeFeedbackAudience(cwd, runId, "session-traversal");
		const sent = [];
		await deliverWorkflowFeedback(
			feedbackContext(cwd, "session-traversal"),
			{ sendMessage: (message) => sent.push(message) },
			run,
		);
		assert.equal(sent.length, 1);
		assert.doesNotMatch(sent[0].content, /MUST NOT BE PREVIEWED/);
		assert.doesNotMatch(sent[0].content, /outside-preview/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("direct dynamic synthesis previews validated analysis, never protocol wrappers", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "workflow-preview-dynamic-"));
	try {
		const runId = "workflow_preview_dynamic";
		const run = runRecord(cwd, {
			runId,
			provenance: { mode: "direct-dynamic" },
			tasks: [
				taskRecord(runId, "controller", "dynamic.controller", {
					kind: "dynamic",
					statusDetail: "dynamic_completed",
				}),
				taskRecord(runId, "synthesis", "dynamic.synthesis", {
					dynamicGenerated: { outputProfile: "synthesis_v1" },
				}),
			],
		});
		await writeRunFixture(cwd, run, {
			schema: "dynamic-controller-result-v1",
			status: "synthesized",
			outputTasks: ["dynamic.synthesis"],
		});
		const taskDir = join(cwd, dirname(run.tasks[1].files.output));
		await writeDynamicControl(cwd, { tasks: [run.tasks[1]] }, {
			summary: "",
			sidecarPath: "raw.md",
		});
		await writeFile(join(taskDir, "analysis.md"), "Validated synthesis analysis.\n");
		await writeFile(join(taskDir, "raw.md"), "<control>RAW PROTOCOL</control>\n");
		await writeFile(join(taskDir, "output.log"), "<analysis>RAW WRAPPER</analysis>\n");
		await writeFeedbackAudience(cwd, runId, "session-dynamic-preview");
		const sent = [];
		await deliverWorkflowFeedback(
			feedbackContext(cwd, "session-dynamic-preview"),
			{ sendMessage: (message) => sent.push(message) },
			run,
		);
		assert.equal(sent.length, 1);
		assert.match(sent[0].content, /Validated synthesis analysis/);
		assert.doesNotMatch(sent[0].content, /RAW PROTOCOL|RAW WRAPPER/);
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
		await writeFeedbackAudience(cwd, run.runId, "session-output");
		const tools = [];
		registerWorkflowWaitTool(fakePi(tools), {
			PI_WORKFLOW_ROLE: "supervisor",
		});
		const result = await tools[0].execute(
			"call-output",
			{ runId, timeoutMs: 60_000 },
			new AbortController().signal,
			undefined,
			{
				...feedbackContext(cwd, "session-output"),
				hasUI: false,
			},
		);
		assert.deepEqual(result.details.outputTaskIds, ["dynamic.synthesis-final"]);
		assert.match(
			result.details.finalResultPreview,
			/Authoritative synthesized/,
		);
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
		await writeFeedbackAudience(cwd, run.runId, "session-failed-final");
		const tools = [];
		registerWorkflowWaitTool(fakePi(tools), {
			PI_WORKFLOW_ROLE: "supervisor",
		});
		const result = await tools[0].execute(
			"call-failed-final",
			{ runId, timeoutMs: 60_000 },
			new AbortController().signal,
			undefined,
			{
				...feedbackContext(cwd, "session-failed-final"),
				hasUI: false,
			},
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

test("awaitTerminal retries feedback binding for an immediately terminal support run", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "workflow-wait-immediate-terminal-"));
	try {
		let bindAttempts = 0;
		setWorkflowFeedbackBindWaitMsForTests(200);
		setRunLeaseTestHooksForTests({
			onBeforeHeartbeat({ name, initial }) {
				if (name !== "feedback-audience" || !initial) return;
				bindAttempts += 1;
				if (bindAttempts === 1) throw new Error("transient audience bind failure");
			},
		});
		const workflowDir = join(cwd, "workflows", "immediate");
		await mkdir(join(workflowDir, "helpers"), { recursive: true });
		await writeFile(
			join(workflowDir, "helpers", "done.mjs"),
			"export default async function done() { return { executiveMarkdown: '# Immediate result\\n\\nDone.' }; }\n",
		);
		await writeFile(
			join(workflowDir, "spec.json"),
			JSON.stringify(
				artifactGraphWorkflowSpec({
					name: "immediate-terminal",
					artifactGraph: {
						stages: [
							{ id: "done", support: { uses: "./helpers/done.mjs" } },
						],
					},
				}),
			),
		);
		const tools = [];
		registerWorkflowNaturalLanguageTools(fakePi(tools), {
			PI_WORKFLOW_ROLE: "supervisor",
		});
		const runTool = tools.find((tool) => tool.name === WORKFLOW_RUN_TOOL);
		const result = await runTool.execute(
			"call-immediate",
			{
				workflow: join(workflowDir, "spec.json"),
				task: "Complete immediately",
				awaitTerminal: true,
				timeoutMs: 60_000,
			},
			new AbortController().signal,
			undefined,
			feedbackContext(cwd, "session-immediate", { hasUI: false }),
		);
		assert.equal(result.details.status, "completed");
		const audience = JSON.parse(
			await readFile(
				join(cwd, ".pi", "workflows", result.details.runId, "feedback-audience.json"),
				"utf8",
			),
		);
		assert.equal(audience.sessionId, "session-immediate");
		assert.ok(bindAttempts >= 2);
	} finally {
		setRunLeaseTestHooksForTests(undefined);
		setWorkflowFeedbackBindWaitMsForTests(undefined);
		await rm(cwd, { recursive: true, force: true });
	}
});

test("awaitTerminal bind failure reports run id and deterministic wait recovery", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "workflow-wait-bind-failure-"));
	try {
		const workflowDir = join(cwd, "workflows", "bind-failure");
		await mkdir(join(workflowDir, "helpers"), { recursive: true });
		await writeFile(
			join(workflowDir, "helpers", "done.mjs"),
			"export default async function done() { return { executiveMarkdown: '# Done' }; }\n",
		);
		await writeFile(
			join(workflowDir, "spec.json"),
			JSON.stringify(
				artifactGraphWorkflowSpec({
					name: "bind-failure",
					artifactGraph: {
						stages: [
							{ id: "done", support: { uses: "./helpers/done.mjs" } },
						],
					},
				}),
			),
		);
		setWorkflowFeedbackBindWaitMsForTests(25);
		setRunLeaseTestHooksForTests({
			onBeforeHeartbeat({ name, initial }) {
				if (name === "feedback-audience" && initial)
					throw new Error("persistent audience bind failure");
			},
		});
		const tools = [];
		registerWorkflowNaturalLanguageTools(fakePi(tools), {
			PI_WORKFLOW_ROLE: "supervisor",
		});
		const runTool = tools.find((tool) => tool.name === WORKFLOW_RUN_TOOL);
		let bindError;
		try {
			await runTool.execute(
				"call-bind-failure",
				{
					workflow: join(workflowDir, "spec.json"),
					task: "Complete before binding",
					awaitTerminal: true,
					timeoutMs: 60_000,
				},
				new AbortController().signal,
				undefined,
				feedbackContext(cwd, "session-bind-failure", { hasUI: false }),
			);
		} catch (error) {
			bindError = error;
		}
		assert.ok(bindError instanceof Error);
		const runId = bindError.message.match(/workflow (workflow_[^ ]+) started/)?.[1];
		assert.ok(runId, `missing run id in: ${bindError.message}`);
		assert.match(bindError.message, new RegExp(`/workflow wait ${runId}$`));
	} finally {
		setRunLeaseTestHooksForTests(undefined);
		setWorkflowFeedbackBindWaitMsForTests(undefined);
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
		const synthesizedSummary = await summarizeWorkflowTerminal(
			cwd,
			synthesized,
		);
		assert.equal(synthesizedSummary.semanticStatus, "synthesized");
		assert.deepEqual(synthesizedSummary.outputTaskIds, [
			"dynamic.synthesize-r1",
		]);
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
