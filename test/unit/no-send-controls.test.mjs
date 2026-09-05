import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
	makeProject,
	makeSubagentLaunchFixture,
} from "./unit-test-support.mjs";
import {
	launchSubagentTask,
	reconcileDurableLaunchBarrierTaskForTests,
	setSubagentApiForTests,
	setSubagentLaunchControlsForTests,
} from "../../.tmp/unit/subagent-backend.js";
import {
	assertWorkflowStateRootCapability,
	openWorkflowStateRootCapability,
	workflowStateRootIdentity,
} from "../../.tmp/unit/workflow-state-root.js";

const sha256 = (character) => character.repeat(64);

function parseJson(text, context) {
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new Error(`invalid JSON in ${context}`, { cause: error });
	}
}

function barrierDescriptor(cwd, options = {}) {
	return {
		schema: "pi-subagent-durable-launch-barrier-v2",
		identitySha256: sha256("1"),
		directory: join(cwd, "barrier"),
		readyPath: join(cwd, "barrier", "ready-v2.json"),
		decisionPath: join(cwd, "barrier", "decision-v2.json"),
		ackPath: join(cwd, "barrier", "ack-v2.json"),
		challenge: sha256("2"),
		decisionNonce: sha256("9"),
		subjectSha256: options.subjectSha256 ?? sha256("a"),
		...(options.authorityBindingSha256 === undefined
			? {}
			: { authorityBindingSha256: options.authorityBindingSha256 }),
		directoryIdentity: { device: 1, inode: 2 },
		timeoutMs: 30_000,
		pollIntervalMs: 10,
	};
}

function barrierReady(descriptor) {
	return {
		schema: "pi-subagent-durable-launch-barrier-ready-v2",
		barrierIdentitySha256: descriptor.identitySha256,
		challenge: descriptor.challenge,
		decisionNonce: descriptor.decisionNonce,
		subjectSha256: descriptor.subjectSha256,
		...(descriptor.authorityBindingSha256 === undefined
			? {}
			: { authorityBindingSha256: descriptor.authorityBindingSha256 }),
		runId: "barrier-run",
		attemptId: "barrier-attempt",
		workerPid: 101,
		workerProcessGroupId: 101,
		readySha256: sha256("3"),
		launchPayloadSha256: sha256("4"),
		executionPlanSha256: sha256("8"),
	};
}

function barrierRelease(descriptor, ready, releasePayloadSha256) {
	return {
		schema: "pi-subagent-durable-launch-barrier-decision-v2",
		kind: "released",
		barrierIdentitySha256: descriptor.identitySha256,
		challenge: descriptor.challenge,
		decisionNonce: descriptor.decisionNonce,
		subjectSha256: descriptor.subjectSha256,
		...(descriptor.authorityBindingSha256 === undefined
			? {}
			: { authorityBindingSha256: descriptor.authorityBindingSha256 }),
		runId: ready.runId,
		attemptId: ready.attemptId,
		readySha256: ready.readySha256,
		releasePayloadSha256,
		decisionSha256: sha256("5"),
	};
}

function barrierRevocation(descriptor, options) {
	return {
		schema: "pi-subagent-durable-launch-barrier-decision-v2",
		kind: "revoked",
		barrierIdentitySha256: descriptor.identitySha256,
		challenge: descriptor.challenge,
		decisionNonce: descriptor.decisionNonce,
		subjectSha256: descriptor.subjectSha256,
		...(descriptor.authorityBindingSha256 === undefined
			? {}
			: { authorityBindingSha256: descriptor.authorityBindingSha256 }),
		cancellationId: options.cancellationId,
		reasonSha256: options.reasonSha256,
		decisionSha256: sha256("b"),
	};
}

function barrierAck(descriptor, release) {
	return {
		schema: "pi-subagent-durable-launch-barrier-ack-v2",
		barrierIdentitySha256: descriptor.identitySha256,
		challenge: descriptor.challenge,
		decisionNonce: descriptor.decisionNonce,
		runId: release.runId,
		attemptId: release.attemptId,
		readySha256: release.readySha256,
		decisionSha256: release.decisionSha256,
		ackSha256: sha256("6"),
	};
}

function resetLaunchControls() {
	setSubagentApiForTests(undefined);
	setSubagentLaunchControlsForTests({ releaseDelayMs: 0, retryJitterMs: 0 });
}

test("workflow state-root capabilities are private, stable, and physically bound", async () => {
	const cwd = makeProject();
	try {
		const capability = await openWorkflowStateRootCapability(cwd);
		const identity = await assertWorkflowStateRootCapability(cwd, capability);
		assert.match(identity.identitySha256, /^[a-f0-9]{64}$/u);
		assert.equal(
			(await workflowStateRootIdentity(cwd)).identitySha256,
			identity.identitySha256,
		);
		await assert.rejects(
			assertWorkflowStateRootCapability(cwd, {
				kind: "pi-workflow-private-state-root-capability-v1",
			}),
			/private workflow state-root capability is required/,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("the packed workflow contract is locked to pi-subagent 0.6.1 durable APIs", async () => {
	const packageJson = parseJson(
		readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
		"package.json",
	);
	const packageLock = parseJson(
		readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"),
		"package-lock.json",
	);
	assert.equal(packageJson.dependencies["@agwab/pi-subagent"], "^0.6.1");
	assert.ok(packageJson.bundleDependencies.includes("@agwab/pi-subagent"));
	const locked = packageLock.packages["node_modules/@agwab/pi-subagent"];
	assert.equal(locked.version, "0.6.1");
	assert.equal(
		locked.integrity,
		"sha512-JZ+roYctNBTNpxpb0abO9UXRNXsmKkBWPO0DKW68gH3FvgCYCvh5lKtM74W8nOp3Jp909zjqLgjtAOizOfSTdw==",
	);
	assert.equal(locked.inBundle, true);
	const api = await import("@agwab/pi-subagent/api");
	for (const name of [
		"createDurableLaunchBarrierV2",
		"durableLaunchBarrierDigest",
		"waitForDurableLaunchBarrierV2Ready",
		"resolveDurableLaunchBarrierV2Release",
		"revokeDurableLaunchBarrierV2",
		"readDurableLaunchBarrierV2State",
		"waitForDurableLaunchBarrierV2Ack",
		"pruneSubagentRuns",
	])
		assert.equal(typeof api[name], "function", `missing ${name}`);
});

test("subagent launch durably consumes authority before releasing the general worker barrier", async () => {
	const cwd = makeProject();
	const events = [];
	const digested = [];
	const externalLaunchGrantSha256 = "7".repeat(64);
	try {
		process.env.PI_WORKFLOW_REQUIRE_EXTERNAL_LAUNCH_GRANT = "1";
		process.env.PI_WORKFLOW_EXTERNAL_LAUNCH_GRANT_SHA256 =
			externalLaunchGrantSha256;
		const fixture = makeSubagentLaunchFixture(cwd, "durable-launch-barrier");
		setSubagentApiForTests({
			async createDurableLaunchBarrierV2(options) {
				events.push("create");
				assert.equal(
					options.authorityBindingSha256,
					externalLaunchGrantSha256,
				);
				return barrierDescriptor(cwd, options);
			},
			durableLaunchBarrierDigest(value) {
				digested.push(value);
				return createHash("sha256")
					.update(JSON.stringify(value))
					.digest("hex");
			},
			async runSubagent(options) {
				events.push("run");
				assert.equal(
					options.durableLaunchBarrier.subjectSha256,
					fixture.task.launchAuthority.records[0].grant.identitySha256,
				);
				assert.equal(
					options.durableLaunchBarrier.authorityBindingSha256,
					externalLaunchGrantSha256,
				);
				assert.equal(
					fixture.task.launchAuthority.records[0].state.phase,
					"registered",
				);
				return {
					runId: "barrier-run",
					attemptId: "barrier-attempt",
					status: "running",
				};
			},
			async waitForDurableLaunchBarrierV2Ready(descriptor) {
				events.push("ready");
				return barrierReady(descriptor);
			},
			async resolveDurableLaunchBarrierV2Release(
				descriptor,
				ready,
				releasePayloadSha256,
			) {
				events.push("release");
				const persisted = parseJson(
					readFileSync(
						join(
							cwd,
							".pi",
							"workflows",
							fixture.run.runId,
							"run.json",
						),
						"utf8",
					),
					"persisted workflow run",
				);
				assert.equal(
					persisted.tasks[0].launchAuthority.records[0].state.phase,
					"consumed",
				);
				assert.equal(
					persisted.tasks[0].durableLaunchBarrier.records[0].phase,
					"consumed",
				);
				const decision = barrierRelease(
					descriptor,
					ready,
					releasePayloadSha256,
				);
				return { outcome: "released", decision };
			},
			async revokeDurableLaunchBarrierV2() {
				throw new Error("unexpected revocation");
			},
			async readDurableLaunchBarrierV2State() {
				return {};
			},
			async waitForDurableLaunchBarrierV2Ack(descriptor, release) {
				events.push("ack");
				return barrierAck(descriptor, release);
			},
			async getSubagentStatus() {
				return null;
			},
			async reconcileSubagentRun() {
				return {};
			},
			async interruptSubagent() {
				return {
					status: "already-terminal",
					runId: "barrier-run",
					interruptedAttempts: [],
					unsupportedAttempts: [],
					record: {
						attempts: [
							{ attemptId: "barrier-attempt", status: "cancelled" },
						],
					},
				};
			},
		});
		const result = await launchSubagentTask(
			cwd,
			fixture.run,
			fixture.task,
			fixture.compiledTask,
		);
		assert.equal(result.kind, "launched");
		assert.deepEqual(events, ["create", "run", "ready", "release", "ack"]);
		assert.equal(
			fixture.task.durableLaunchBarrier.records[0].phase,
			"acknowledged",
		);
		assert.equal(
			fixture.task.launchAuthority.records[0].state.phase,
			"consumed",
		);
		assert.equal(
			fixture.task.durableLaunchBarrier.records[0].authorityBindingSha256,
			externalLaunchGrantSha256,
		);
		assert.equal(
			fixture.task.durableLaunchBarrier.records[0].executionPlanSha256,
			sha256("8"),
		);
		assert.equal(
			fixture.task.launchBootstrap.records[0].effectivePolicy
				.externalLaunchGrantSha256,
			externalLaunchGrantSha256,
		);
		const releaseDigestInput = digested.find(
			(value) => value.schema === "pi-workflow-consumed-launch-release-v1",
		);
		assert.ok(releaseDigestInput);
		assert.equal(
			releaseDigestInput.authorityBindingSha256,
			externalLaunchGrantSha256,
		);
		assert.equal(
			releaseDigestInput.externalLaunchGrantSha256,
			externalLaunchGrantSha256,
		);
		assert.equal(releaseDigestInput.executionPlanSha256, sha256("8"));
	} finally {
		delete process.env.PI_WORKFLOW_EXTERNAL_LAUNCH_GRANT_SHA256;
		delete process.env.PI_WORKFLOW_REQUIRE_EXTERNAL_LAUNCH_GRANT;
		resetLaunchControls();
		rmSync(cwd, { recursive: true, force: true });
	}
});

function cancellationBarrierApi(cwd, events, overrides = {}) {
	const state = {};
	return {
		stateForTests: state,
		async createDurableLaunchBarrierV2(options) {
			events.push("create");
			return barrierDescriptor(cwd, options);
		},
		durableLaunchBarrierDigest(value) {
			return createHash("sha256")
				.update(JSON.stringify(value))
				.digest("hex");
		},
		async runSubagent() {
			events.push("run");
			return {
				runId: "barrier-run",
				attemptId: "barrier-attempt",
				status: "running",
			};
		},
		async waitForDurableLaunchBarrierV2Ready(descriptor) {
			events.push("ready");
			state.ready = overrides.ready
				? await overrides.ready(descriptor)
				: barrierReady(descriptor);
			return state.ready;
		},
		async resolveDurableLaunchBarrierV2Release(
			descriptor,
			ready,
			releasePayloadSha256,
		) {
			events.push("release");
			state.decision ??= barrierRelease(
				descriptor,
				ready,
				releasePayloadSha256,
			);
			return { outcome: state.decision.kind, decision: state.decision };
		},
		async revokeDurableLaunchBarrierV2(descriptor, options) {
			events.push("revoke");
			state.decision ??= barrierRevocation(descriptor, options);
			return { outcome: state.decision.kind, decision: state.decision };
		},
		async readDurableLaunchBarrierV2State() {
			return { ...state };
		},
		async waitForDurableLaunchBarrierV2Ack(descriptor, release) {
			events.push("ack");
			state.ack = barrierAck(descriptor, release);
			return state.ack;
		},
		async getSubagentStatus() {
			if (overrides.getStatus) return overrides.getStatus();
			return {
				runId: "barrier-run",
				attemptId: "barrier-attempt",
				backend: "headless",
				status: "cancelled",
				failureKind: "user_cancelled",
				startedAt: new Date().toISOString(),
				completedAt: new Date().toISOString(),
				logs: [],
				attempts: [
					{ attemptId: "barrier-attempt", status: "cancelled" },
				],
			};
		},
		async reconcileSubagentRun() {
			return {};
		},
		async interruptSubagent(options) {
			events.push("interrupt");
			assert.equal(options.runId, "barrier-run");
			assert.equal(options.attemptId, "barrier-attempt");
			if (overrides.interruptResult)
				return overrides.interruptResult(options);
			return {
				status: "interrupt-requested",
				runId: "barrier-run",
				interruptedAttempts: ["barrier-attempt"],
				unsupportedAttempts: [],
				record: {
					attempts: [
						{ attemptId: "barrier-attempt", status: "cancelled" },
					],
				},
			};
		},
	};
}

function persistedTask(cwd, fixture) {
	return parseJson(
		readFileSync(
			join(cwd, ".pi", "workflows", fixture.run.runId, "run.json"),
			"utf8",
		),
		"persisted workflow task",
	).tasks[0];
}

test("READY authority-binding drift fails closed and interrupts the provisional worker", async () => {
	const cwd = makeProject();
	const events = [];
	try {
		process.env.PI_WORKFLOW_REQUIRE_EXTERNAL_LAUNCH_GRANT = "1";
		process.env.PI_WORKFLOW_EXTERNAL_LAUNCH_GRANT_SHA256 = sha256("7");
		const fixture = makeSubagentLaunchFixture(cwd, "ready-binding-drift");
		setSubagentApiForTests(
			cancellationBarrierApi(cwd, events, {
				ready(descriptor) {
					return {
						...barrierReady(descriptor),
						authorityBindingSha256: sha256("0"),
					};
				},
			}),
		);
		await assert.rejects(
			launchSubagentTask(
				cwd,
				fixture.run,
				fixture.task,
				fixture.compiledTask,
			),
			/READY does not match the authorized launch/,
		);
		assert.deepEqual(events, [
			"create",
			"run",
			"ready",
			"revoke",
			"interrupt",
		]);
		assert.equal(fixture.task.statusDetail, "cancellation_acknowledged");
		assert.equal(
			fixture.task.launchAuthority.records[0].state.phase,
			"registered",
		);
		assert.equal(
			fixture.task.durableLaunchBarrier.records[0].phase,
			"cancellation_acknowledged",
		);
	} finally {
		delete process.env.PI_WORKFLOW_EXTERNAL_LAUNCH_GRANT_SHA256;
		delete process.env.PI_WORKFLOW_REQUIRE_EXTERNAL_LAUNCH_GRANT;
		resetLaunchControls();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("lease cancellation before READY interrupts the persisted provisional worker without release", async () => {
	const cwd = makeProject();
	const events = [];
	const lease = new AbortController();
	let finishReady;
	try {
		const fixture = makeSubagentLaunchFixture(cwd, "cancel-before-ready");
		setSubagentApiForTests(
			cancellationBarrierApi(cwd, events, {
				ready(descriptor) {
					lease.abort(new Error("lease lost before READY"));
					return new Promise((resolveReady) => {
						finishReady = () => resolveReady(barrierReady(descriptor));
					});
				},
			}),
		);
		await assert.rejects(
			launchSubagentTask(
				cwd,
				fixture.run,
				fixture.task,
				fixture.compiledTask,
				lease.signal,
			),
			/lease lost before READY/,
		);
		assert.deepEqual(events, [
			"create",
			"run",
			"ready",
			"revoke",
			"interrupt",
		]);
		assert.equal(fixture.task.statusDetail, "cancellation_acknowledged");
		assert.equal(fixture.task.backendHandle.runId, "barrier-run");
		const persisted = persistedTask(cwd, fixture);
		assert.equal(persisted.backendHandle.runId, "barrier-run");
		assert.equal(
			persisted.durableLaunchBarrier.records[0].phase,
			"cancellation_acknowledged",
		);
	} finally {
		finishReady?.();
		resetLaunchControls();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("workflow stop after READY interrupts the provisional worker and never releases the gate", async () => {
	const cwd = makeProject();
	const events = [];
	const workflowStop = new AbortController();
	try {
		const fixture = makeSubagentLaunchFixture(cwd, "cancel-before-release");
		setSubagentApiForTests(cancellationBarrierApi(cwd, events));
		setSubagentLaunchControlsForTests({
			releaseDelayMs: 0,
			retryJitterMs: 0,
			beforeDurableBarrierRelease() {
				workflowStop.abort(new Error("workflow stopped before release"));
			},
		});
		await assert.rejects(
			launchSubagentTask(
				cwd,
				fixture.run,
				fixture.task,
				fixture.compiledTask,
				undefined,
				workflowStop.signal,
			),
			/workflow stopped before release/,
		);
		assert.deepEqual(events, [
			"create",
			"run",
			"ready",
			"revoke",
			"revoke",
			"interrupt",
		]);
		const record = fixture.task.durableLaunchBarrier.records[0];
		assert.equal(record.phase, "cancellation_acknowledged");
		assert.equal(record.releaseWinner, false);
		assert.equal(record.executionPlanSha256, sha256("8"));
		assert.equal(
			fixture.task.launchAuthority.records[0].state.phase,
			"consumed",
		);
		assert.equal(
			persistedTask(cwd, fixture).durableLaunchBarrier.records[0].phase,
			"cancellation_acknowledged",
		);
	} finally {
		resetLaunchControls();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("workflow stop during the release decision window wins the exclusive revoke fence", async () => {
	const cwd = makeProject();
	const events = [];
	const workflowStop = new AbortController();
	try {
		const fixture = makeSubagentLaunchFixture(cwd, "cancel-during-release");
		const api = cancellationBarrierApi(cwd, events);
		const resolveRelease = api.resolveDurableLaunchBarrierV2Release;
		api.resolveDurableLaunchBarrierV2Release = async (...args) => {
			events.push("release-window");
			workflowStop.abort(new Error("workflow stopped during release"));
			await new Promise((resolveTurn) => setImmediate(resolveTurn));
			return resolveRelease(...args);
		};
		setSubagentApiForTests(api);
		await assert.rejects(
			launchSubagentTask(
				cwd,
				fixture.run,
				fixture.task,
				fixture.compiledTask,
				undefined,
				workflowStop.signal,
			),
			/workflow stopped during release/,
		);
		assert.ok(events.includes("release-window"));
		assert.ok(events.includes("revoke"));
		assert.ok(events.includes("interrupt"));
		const record = fixture.task.durableLaunchBarrier.records[0];
		assert.equal(record.phase, "cancellation_acknowledged");
		assert.equal(record.releaseWinner, false);
		assert.equal(record.cancellation.decision, "revoked");
		assert.equal(record.decisionSha256, sha256("b"));
		assert.equal(events.includes("ack"), false);
	} finally {
		resetLaunchControls();
		rmSync(cwd, { recursive: true, force: true });
	}
});

async function acknowledgedBarrierFixture(cwd, name) {
	const events = [];
	const fixture = makeSubagentLaunchFixture(cwd, name);
	const api = cancellationBarrierApi(cwd, events);
	setSubagentApiForTests(api);
	const result = await launchSubagentTask(
		cwd,
		fixture.run,
		fixture.task,
		fixture.compiledTask,
	);
	assert.equal(result.kind, "launched");
	assert.equal(
		fixture.task.durableLaunchBarrier.records[0].phase,
		"acknowledged",
	);
	return { api, events, fixture };
}

test("barrier recovery reconstructs release and ACK receipts without respawn", async () => {
	const cwd = makeProject();
	try {
		const { api, events, fixture } = await acknowledgedBarrierFixture(
			cwd,
			"recover-release-ack",
		);
		const record = fixture.task.durableLaunchBarrier.records[0];
		record.phase = "consumed";
		delete record.decisionSha256;
		delete record.ackSha256;
		delete api.stateForTests.ack;
		const launchCount = events.filter((event) => event === "run").length;
		assert.equal(
			await reconcileDurableLaunchBarrierTaskForTests(
				cwd,
				fixture.run,
				fixture.task,
			),
			true,
		);
		assert.equal(record.phase, "released");
		assert.equal(record.decisionSha256, sha256("5"));
		assert.equal(
			events.filter((event) => event === "run").length,
			launchCount,
		);

		api.stateForTests.ack = barrierAck(
			record.descriptor,
			api.stateForTests.decision,
		);
		assert.equal(
			await reconcileDurableLaunchBarrierTaskForTests(
				cwd,
				fixture.run,
				fixture.task,
			),
			true,
		);
		assert.equal(record.phase, "acknowledged");
		assert.equal(record.ackSha256, sha256("6"));
		assert.equal(
			events.filter((event) => event === "run").length,
			launchCount,
		);
	} finally {
		resetLaunchControls();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("stale pre-release barrier recovery revokes and exactly reaps the same attempt", async () => {
	const cwd = makeProject();
	try {
		const { api, events, fixture } = await acknowledgedBarrierFixture(
			cwd,
			"recover-stale-pre-release",
		);
		const record = fixture.task.durableLaunchBarrier.records[0];
		delete api.stateForTests.decision;
		delete api.stateForTests.ack;
		record.phase = "created";
		delete record.readySha256;
		delete record.launchPayloadSha256;
		delete record.executionPlanSha256;
		delete record.releasePayloadSha256;
		delete record.decisionSha256;
		delete record.ackSha256;
		delete record.releaseWinner;
		delete record.cancellation;
		fixture.task.startedAt = "2000-01-01T00:00:00.000Z";
		const launchCount = events.filter((event) => event === "run").length;
		await reconcileDurableLaunchBarrierTaskForTests(
			cwd,
			fixture.run,
			fixture.task,
		);
		assert.equal(api.stateForTests.decision.kind, "revoked");
		assert.equal(record.phase, "cancellation_acknowledged");
		assert.equal(record.releaseWinner, false);
		assert.equal(record.cancellation.terminalAttemptId, "barrier-attempt");
		assert.equal(record.cancellation.terminalStatus, "cancelled");
		assert.equal(
			events.filter((event) => event === "run").length,
			launchCount,
		);
	} finally {
		resetLaunchControls();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("barrier recovery rejects receipt identity drift before adoption", async () => {
	const cwd = makeProject();
	try {
		const { api, fixture } = await acknowledgedBarrierFixture(
			cwd,
			"recover-receipt-drift",
		);
		api.stateForTests.ready = {
			...api.stateForTests.ready,
			authorityBindingSha256: sha256("0"),
		};
		await assert.rejects(
			reconcileDurableLaunchBarrierTaskForTests(
				cwd,
				fixture.run,
				fixture.task,
			),
			/recovered READY does not match persisted authority/,
		);
		assert.equal(
			fixture.task.durableLaunchBarrier.records[0].phase,
			"acknowledged",
		);
	} finally {
		resetLaunchControls();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("workflow stop before ACK interrupts an already-released provisional worker and preserves the release receipt", async () => {
	const cwd = makeProject();
	const events = [];
	const workflowStop = new AbortController();
	try {
		const fixture = makeSubagentLaunchFixture(cwd, "cancel-before-ack");
		setSubagentApiForTests(cancellationBarrierApi(cwd, events));
		setSubagentLaunchControlsForTests({
			releaseDelayMs: 0,
			retryJitterMs: 0,
			beforeDurableBarrierAckWait() {
				workflowStop.abort(new Error("workflow stopped before ACK"));
			},
		});
		await assert.rejects(
			launchSubagentTask(
				cwd,
				fixture.run,
				fixture.task,
				fixture.compiledTask,
				undefined,
				workflowStop.signal,
			),
			/workflow stopped before ACK/,
		);
		assert.deepEqual(events, [
			"create",
			"run",
			"ready",
			"release",
			"revoke",
			"interrupt",
		]);
		const record = fixture.task.durableLaunchBarrier.records[0];
		assert.equal(record.phase, "cancellation_acknowledged");
		assert.equal(record.releaseWinner, true);
		assert.equal(record.decisionSha256, sha256("5"));
		assert.equal(record.cancellation.decision, "released");
		const persisted = persistedTask(cwd, fixture);
		assert.equal(
			persisted.durableLaunchBarrier.records[0].phase,
			"cancellation_acknowledged",
		);
		assert.equal(
			persisted.durableLaunchBarrier.records[0].decisionSha256,
			sha256("5"),
		);
	} finally {
		resetLaunchControls();
		rmSync(cwd, { recursive: true, force: true });
	}
});
