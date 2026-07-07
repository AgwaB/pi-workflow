import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	beginParentUsageTracking,
	readParentUsage,
	recordParentSessionUsage,
	resetParentUsageTrackingForTests,
	resumeParentUsageTracking,
} from "../../.tmp/unit/workflow-parent-usage.js";

function writeIndex(cwd, runs) {
	const dir = join(cwd, ".pi", "workflows");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "index.json"),
		`${JSON.stringify({
			schemaVersion: 1,
			updatedAt: new Date().toISOString(),
			runs,
		})}\n`,
		"utf8",
	);
}

function indexRun(runId, status) {
	return {
		runId,
		type: "workflow",
		status,
		taskSummary: {
			total: 1,
			pending: 0,
			running: status === "running" ? 1 : 0,
			completed: status === "completed" ? 1 : 0,
			blocked: 0,
			failed: 0,
			skipped: 0,
			interrupted: 0,
		},
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
}

function assistantMessage(usage) {
	return {
		role: "assistant",
		content: [{ type: "text", text: "turn" }],
		usage,
	};
}

test("parent usage accumulates assistant messages for active runs", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "parent-usage-"));
	t.after(() => {
		resetParentUsageTrackingForTests();
		rmSync(cwd, { recursive: true, force: true });
	});
	resetParentUsageTrackingForTests();
	writeIndex(cwd, [indexRun("workflow_pu_1", "running")]);
	beginParentUsageTracking(cwd, "workflow_pu_1");

	await recordParentSessionUsage(
		cwd,
		assistantMessage({
			input: 100,
			output: 50,
			cacheRead: 1000,
			cacheWrite: 200,
			totalTokens: 1350,
			cost: { total: 0.5 },
		}),
	);
	await recordParentSessionUsage(
		cwd,
		assistantMessage({
			input: 10,
			output: 40,
			cacheRead: 1500,
			cacheWrite: 0,
			totalTokens: 1550,
			cost: { total: 0.25 },
		}),
	);
	// Non-assistant messages and usage-less assistant messages are ignored.
	await recordParentSessionUsage(cwd, { role: "user", content: [] });
	await recordParentSessionUsage(cwd, {
		role: "assistant",
		content: [],
	});

	const record = await readParentUsage(cwd, "workflow_pu_1");
	assert.equal(record.schema, "workflow-parent-usage-v1");
	assert.equal(record.source, "parent-session");
	assert.equal(record.assistantMessages, 2);
	assert.equal(record.inputTokens, 110);
	assert.equal(record.outputTokens, 90);
	assert.equal(record.totalTokens, 2900);
	assert.equal(record.cacheReadInputTokens, 2500);
	assert.equal(record.cacheCreationInputTokens, 200);
	assert.equal(record.costUsd, 0.75);
	assert.equal(record.completedAt, undefined);
});

test("parent usage finalizes on the wrap-up message after the run turns terminal", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "parent-usage-"));
	t.after(() => {
		resetParentUsageTrackingForTests();
		rmSync(cwd, { recursive: true, force: true });
	});
	resetParentUsageTrackingForTests();
	writeIndex(cwd, [indexRun("workflow_pu_2", "running")]);
	beginParentUsageTracking(cwd, "workflow_pu_2");

	await recordParentSessionUsage(
		cwd,
		assistantMessage({ input: 5, output: 5, totalTokens: 10 }),
	);

	writeIndex(cwd, [indexRun("workflow_pu_2", "completed")]);
	// The first message after terminal status is the summary turn: counted, then closed.
	await recordParentSessionUsage(
		cwd,
		assistantMessage({ input: 1, output: 2, totalTokens: 3 }),
	);
	// Tracking stopped: later messages must not accumulate.
	await recordParentSessionUsage(
		cwd,
		assistantMessage({ input: 100, output: 100, totalTokens: 200 }),
	);

	const record = await readParentUsage(cwd, "workflow_pu_2");
	assert.equal(record.assistantMessages, 2);
	assert.equal(record.totalTokens, 13);
	assert.ok(record.completedAt);
});

test("resumeParentUsageTracking re-attaches active runs with an existing sidecar", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "parent-usage-"));
	t.after(() => {
		resetParentUsageTrackingForTests();
		rmSync(cwd, { recursive: true, force: true });
	});
	resetParentUsageTrackingForTests();
	writeIndex(cwd, [
		indexRun("workflow_pu_3", "running"),
		indexRun("workflow_pu_4", "running"),
	]);
	beginParentUsageTracking(cwd, "workflow_pu_3");
	await recordParentSessionUsage(
		cwd,
		assistantMessage({ input: 7, output: 3, totalTokens: 10 }),
	);

	// Simulate a session restart: in-memory tracking is gone.
	resetParentUsageTrackingForTests();
	await resumeParentUsageTracking(cwd);
	await recordParentSessionUsage(
		cwd,
		assistantMessage({ input: 1, output: 1, totalTokens: 2 }),
	);

	const resumed = await readParentUsage(cwd, "workflow_pu_3");
	assert.equal(resumed.assistantMessages, 2);
	assert.equal(resumed.totalTokens, 12);
	// workflow_pu_4 never had a sidecar (started elsewhere): still none.
	assert.equal(await readParentUsage(cwd, "workflow_pu_4"), undefined);
});
