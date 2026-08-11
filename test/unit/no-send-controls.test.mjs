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
	setSubagentApiForTests,
	setSubagentLaunchControlsForTests,
} from "../../.tmp/unit/subagent-backend.js";
import {
	assertWorkflowStateRootCapability,
	openWorkflowStateRootCapability,
	workflowStateRootIdentity,
} from "../../.tmp/unit/workflow-state-root.js";

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
		const descriptor = {
			schema: "pi-subagent-durable-launch-barrier-v1",
			identitySha256: "1".repeat(64),
			directory: join(cwd, "barrier"),
			readyPath: join(cwd, "barrier", "ready.json"),
			releasePath: join(cwd, "barrier", "release.json"),
			ackPath: join(cwd, "barrier", "ack.json"),
			challenge: "2".repeat(64),
			subjectSha256: "",
			directoryIdentity: { device: 1, inode: 2 },
			timeoutMs: 30_000,
			pollIntervalMs: 10,
		};
		setSubagentApiForTests({
			async createDurableLaunchBarrier(options) {
				events.push("create");
				return { ...descriptor, subjectSha256: options.subjectSha256 };
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
					fixture.task.launchAuthority.records[0].state.phase,
					"registered",
				);
				return {
					runId: "barrier-run",
					attemptId: "barrier-attempt",
					status: "running",
				};
			},
			async waitForDurableLaunchBarrierReady() {
				events.push("ready");
				return {
					runId: "barrier-run",
					attemptId: "barrier-attempt",
					readySha256: "3".repeat(64),
					launchPayloadSha256: "4".repeat(64),
				};
			},
			async releaseDurableLaunchBarrier(_barrier, ready) {
				events.push("release");
				const persisted = JSON.parse(
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
				);
				assert.equal(
					persisted.tasks[0].launchAuthority.records[0].state.phase,
					"consumed",
				);
				assert.equal(
					persisted.tasks[0].durableLaunchBarrier.records[0].phase,
					"consumed",
				);
				return {
					runId: ready.runId,
					attemptId: ready.attemptId,
					readySha256: ready.readySha256,
					releaseSha256: "5".repeat(64),
				};
			},
			async waitForDurableLaunchBarrierAck(_barrier, release) {
				events.push("ack");
				return {
					releaseSha256: release.releaseSha256,
					ackSha256: "6".repeat(64),
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
			fixture.task.launchBootstrap.records[0].effectivePolicy
				.externalLaunchGrantSha256,
			externalLaunchGrantSha256,
		);
		assert.equal(
			digested.find(
				(value) => value.schema === "pi-workflow-consumed-launch-release-v1",
			).externalLaunchGrantSha256,
			externalLaunchGrantSha256,
		);
	} finally {
		delete process.env.PI_WORKFLOW_EXTERNAL_LAUNCH_GRANT_SHA256;
		delete process.env.PI_WORKFLOW_REQUIRE_EXTERNAL_LAUNCH_GRANT;
		setSubagentApiForTests(undefined);
		setSubagentLaunchControlsForTests({ releaseDelayMs: 0, retryJitterMs: 0 });
		rmSync(cwd, { recursive: true, force: true });
	}
});
