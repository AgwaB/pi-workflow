import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	resumeRun,
	runWorkflowSpec,
	waitForRun,
} from "../../.tmp/unit/engine.js";
import { readArtifactGraphControl } from "../../.tmp/unit/artifact-graph-runtime.js";
import {
	appendDynamicEvent,
	hashDynamicRequest,
	readDynamicEvents,
} from "../../.tmp/unit/dynamic-events.js";
import { readRunRecord, writeRunRecord } from "../../.tmp/unit/store.js";
import {
	clearWorkflowHostCapabilityProvidersForTests,
	registerWorkflowHostCapabilityProvider,
	resolveWorkflowHostCapabilities,
} from "../../.tmp/unit/host-capabilities.js";

function project() {
	return mkdtempSync(join(tmpdir(), "pi-workflow-host-operation-"));
}

function writeHostWorkflow(cwd, controllerSource = null, hostOperations = {
	echo: { capability: "test.echo.v1" },
}) {
	const root = join(cwd, "workflows", "host-operation");
	mkdirSync(join(root, "helpers"), { recursive: true });
	writeFileSync(
		join(root, "helpers", "controller.mjs"),
		controllerSource ?? [
			"export default async function controller(ctx) {",
			"  const value = await ctx.host.invoke('echo', { message: 'hello' });",
			"  return {",
			"    control: { schema: 'host-operation-result-v1', status: 'done', value },",
			"    analysis: 'host operation completed',",
			"    refs: [],",
			"  };",
			"}",
		].join("\n"),
	);
	const specPath = join(root, "spec.json");
	writeFileSync(specPath, JSON.stringify({
		schemaVersion: 1,
		name: "host-operation",
		artifactGraph: {
			stages: [{
				id: "host",
				type: "dynamic",
				dynamic: {
					uses: "./helpers/controller.mjs",
					permissions: { approval: "auto" },
					hostOperations,
				},
			}],
		},
	}));
	return specPath;
}

async function finishedRun(cwd, specPath, hostCapabilities) {
	const run = await runWorkflowSpec(specPath, cwd, {
		task: "invoke the declared host operation",
		hostCapabilities,
	});
	return waitForRun(cwd, run.runId, 10_000, { hostCapabilities });
}

test("declared host operation invokes the parent adapter with frozen run provenance", async () => {
	const cwd = project();
	const calls = [];
	try {
		const specPath = writeHostWorkflow(cwd);
		const hostCapabilities = {
			"test.echo.v1": {
				async invoke(request, context) {
					calls.push({ request, context });
					assert.equal(Object.isFrozen(context), true);
					assert.equal(Object.isFrozen(context.workflow), true);
					assert.equal(Object.isFrozen(context.operation), true);
					return { echoed: request.message };
				},
				async reconcile() {
					throw new Error("reconcile must not run on the first invocation");
				},
			},
		};
		const run = await finishedRun(cwd, specPath, hostCapabilities);

		assert.equal(run.status, "completed", JSON.stringify(run.tasks));
		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0].request, { message: "hello" });
		assert.equal(calls[0].context.runId, run.runId);
		assert.equal(calls[0].context.parentRunId, null);
		assert.equal(calls[0].context.controllerStageId, "host");
		assert.equal(calls[0].context.operation.alias, "echo");
		assert.equal(calls[0].context.operation.capability, "test.echo.v1");
		assert.match(calls[0].context.operation.idempotencyKey, /^[a-f0-9]{64}$/u);
		assert.match(calls[0].context.workflow.bundleHash, /^[a-f0-9]{64}$/u);

		const task = run.tasks.find((candidate) => candidate.stageId === "host");
		const control = await readArtifactGraphControl(cwd, task);
		assert.deepEqual(control.value, { echoed: "hello" });
		const events = await readDynamicEvents(cwd, run.runId);
		assert.deepEqual(
			events.filter((event) => event.opId.includes(":host:echo:")).map((event) => event.type),
			["host.started", "host.completed"],
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("missing and undeclared host capabilities fail closed before invocation", async () => {
	const cwd = project();
	let calls = 0;
	try {
		const missingSpec = writeHostWorkflow(cwd);
		const missing = await finishedRun(cwd, missingSpec, {});
		assert.equal(missing.status, "failed");
		assert.match(String(missing.tasks[0].lastMessage), /host capability.*unavailable/iu);

		const undeclaredSpec = writeHostWorkflow(
			cwd,
			"export default async function controller(ctx) { return await ctx.host.invoke('undeclared', {}); }\n",
		);
		const undeclared = await finishedRun(cwd, undeclaredSpec, {
			"test.echo.v1": {
				invoke() { calls += 1; return {}; },
				reconcile() { calls += 1; return {}; },
			},
		});
		assert.equal(undeclared.status, "failed");
		assert.match(String(undeclared.tasks[0].lastMessage), /not declared/iu);
		assert.equal(calls, 0);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("completed host operation replays without invoking the adapter twice", async () => {
	const cwd = project();
	let invokes = 0;
	try {
		const specPath = writeHostWorkflow(cwd);
		const hostCapabilities = {
			"test.echo.v1": {
				invoke() { invokes += 1; return { echoed: "hello" }; },
				reconcile() { throw new Error("completed call must not reconcile"); },
			},
		};
		const completed = await finishedRun(cwd, specPath, hostCapabilities);
		assert.equal(invokes, 1);

		const unregister = registerWorkflowHostCapabilityProvider(() =>
			hostCapabilities,
		);
		try {
			const run = await readRunRecord(cwd, completed.runId);
			const task = run.tasks.find((candidate) => candidate.stageId === "host");
			task.status = "failed";
			task.statusDetail = "test_replay";
			task.completedAt = new Date().toISOString();
			run.status = "failed";
			await writeRunRecord(cwd, run);
			const resumed = await resumeRun(cwd, run.runId);
			await waitForRun(cwd, resumed.run.runId, 10_000);
			assert.equal(invokes, 1);
		} finally {
			unregister();
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("dangling started operation reconciles with the original idempotency key", async () => {
	const cwd = project();
	let invokes = 0;
	const reconciliations = [];
	try {
		const specPath = writeHostWorkflow(cwd);
		const run = await runWorkflowSpec(specPath, cwd, {
			task: "invoke the declared host operation",
			hostCapabilities: {},
		});
		const record = await readRunRecord(cwd, run.runId);
		const task = record.tasks.find((candidate) => candidate.stageId === "host");
		const request = {
			alias: "echo",
			capability: "test.echo.v1",
			input: { message: "hello" },
		};
		const requestHash = hashDynamicRequest(request);
		const idempotencyKey = hashDynamicRequest({
			runId: run.runId,
			controllerSpecId: task.specId,
			opId: `${task.specId}:host:echo:001`,
			requestHash,
		});
		await appendDynamicEvent(cwd, run.runId, {
			controllerSpecId: task.specId,
			type: "host.started",
			opId: `${task.specId}:host:echo:001`,
			requestHash,
			payload: { alias: "echo", capability: "test.echo.v1", idempotencyKey },
		});
		task.status = "failed";
		task.statusDetail = "simulated_process_exit";
		record.status = "failed";
		await writeRunRecord(cwd, record);

		const hostCapabilities = {
			"test.echo.v1": {
				invoke() { invokes += 1; return {}; },
				reconcile(requestValue, context) {
					reconciliations.push({ requestValue, context });
					return { echoed: requestValue.message };
				},
			},
		};
		const unregister = registerWorkflowHostCapabilityProvider(() =>
			hostCapabilities,
		);
		try {
			const resumed = await resumeRun(cwd, run.runId);
			const finished = await waitForRun(cwd, resumed.run.runId, 10_000);
			assert.equal(finished.status, "completed", JSON.stringify(finished.tasks));
			assert.equal(invokes, 0);
			assert.equal(reconciliations.length, 1);
			assert.equal(
				reconciliations[0].context.operation.idempotencyKey,
				idempotencyKey,
			);
		} finally {
			unregister();
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("host operation declarations reject unknown fields and reserved aliases", async () => {
	const cwd = project();
	try {
		const unknown = writeHostWorkflow(cwd, null, {
			echo: { capability: "test.echo.v1", extra: true },
		});
		await assert.rejects(
			() => runWorkflowSpec(unknown, cwd, { task: "invalid declaration" }),
			/hostOperations.*extra|unknown.*extra/iu,
		);

		const reserved = writeHostWorkflow(cwd, null, {
			constructor: { capability: "test.echo.v1" },
		});
		await assert.rejects(
			() => runWorkflowSpec(reserved, cwd, { task: "invalid declaration" }),
			/reserved/iu,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("host capability providers receive frozen launch context and reject collisions", async () => {
	clearWorkflowHostCapabilityProvidersForTests();
	const adapter = { invoke() {}, reconcile() {} };
	const unregister = registerWorkflowHostCapabilityProvider((context) => {
		assert.equal(Object.isFrozen(context), true);
		return { "test.echo.v1": adapter };
	});
	try {
		const resolved = await resolveWorkflowHostCapabilities({
			cwd: "/project",
			workflow: "host-operation",
			task: "test",
		});
		assert.equal(resolved["test.echo.v1"], adapter);
		assert.equal(Object.isFrozen(resolved), true);
		const unregisterDuplicate = registerWorkflowHostCapabilityProvider(() => ({
			"test.echo.v1": adapter,
		}));
		try {
			await assert.rejects(
				() => resolveWorkflowHostCapabilities({ cwd: "/project", workflow: "host-operation" }),
				/duplicate workflow host capability/iu,
			);
		} finally {
			unregisterDuplicate();
		}
	} finally {
		unregister();
		clearWorkflowHostCapabilityProvidersForTests();
	}
});

test("host operation rejects non-JSON adapter results", async () => {
	const cwd = project();
	try {
		const run = await finishedRun(cwd, writeHostWorkflow(cwd), {
			"test.echo.v1": {
				invoke() {
					return { invalid: undefined };
				},
				reconcile() {
					throw new Error("unexpected reconcile");
				},
			},
		});
		assert.equal(run.status, "failed");
		assert.match(String(run.tasks[0].lastMessage), /only JSON values/iu);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
