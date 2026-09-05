import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
	POLL_INTERVAL_MS,
	schedulerPollDelayMs,
} from "../../.tmp/unit/engine-wait.js";

function task(status, nextEligibleAt) {
	return {
		taskId: `${status}-${nextEligibleAt ?? "none"}`,
		specId: "main",
		status,
		launchRetry: nextEligibleAt ? { nextEligibleAt } : undefined,
	};
}

test("WB-016 scheduler wakes at earliest pending retry deadline within fixed bounds", () => {
	const now = Date.parse("2026-07-10T02:00:00.000Z");
	const run = {
		tasks: [
			task("pending", new Date(now + 475).toISOString()),
			task("pending", new Date(now + 150).toISOString()),
			task("running", new Date(now + 25).toISOString()),
			task("pending", "not-a-date"),
		],
	};
	const before = structuredClone(run);
	assert.equal(POLL_INTERVAL_MS, 1_000);
	assert.equal(schedulerPollDelayMs(run, 5_000, now), 150);
	assert.equal(schedulerPollDelayMs(run, 100, now), 100);
	assert.deepEqual(run, before);
});

test("WB-016 scheduler retains fixed poll for absent, expired, or non-pending deadlines", () => {
	const now = Date.parse("2026-07-10T02:00:00.000Z");
	assert.equal(
		schedulerPollDelayMs(
			{
				tasks: [
					task("pending", new Date(now - 1).toISOString()),
					task("completed", new Date(now + 10).toISOString()),
				],
			},
			10_000,
			now,
		),
		1_000,
	);
	assert.equal(schedulerPollDelayMs({ tasks: [] }, 250, now), 250);
	assert.equal(
		schedulerPollDelayMs(
			{ tasks: [task("pending", new Date(now + 1).toISOString())] },
			10_000,
			now,
		),
		1,
	);
});

test("WB-016 wait loop uses deadline selector while refresh remains single-write coalesced", async () => {
	const [engine, backend] = await Promise.all([
		readFile(new URL("../../src/engine.ts", import.meta.url), "utf8"),
		readFile(new URL("../../src/subagent-backend.ts", import.meta.url), "utf8"),
	]);
	assert.match(
		engine,
		/await awaitWithinWorkflowWaitBoundary\(\s*sleep\(schedulerPollDelayMs\(run, remaining\)\)/,
	);
	const refreshBody = backend.slice(
		backend.indexOf("export async function refreshRunFromSubagentArtifacts"),
		backend.indexOf("async function pollSubagentForRefresh"),
	);
	// Ordinary refresh remains coalesced. A newly consumed recovery owner is
	// the one required exception: raw publication cannot precede durable authority.
	assert.equal((refreshBody.match(/writeRunRecord\(/g) ?? []).length, 2);
	assert.match(refreshBody, /consumeRegisteredWorkflowLaunchAuthority\([\s\S]*?await writeRunRecord\(cwd, run\);/);
	assert.match(
		refreshBody,
		/if \(changed \|\| telemetryChanged\) await writeRunRecord\(cwd, run\)/,
	);
});
