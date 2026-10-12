import assert from "node:assert/strict";
import fs, {
	access,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as store from "../../.tmp/unit/store.js";
import * as usage from "../../.tmp/unit/workflow-parent-usage.js";

const owner = "topology-retry-owner";
const message = {
	role: "assistant",
	timestamp: 17,
	usage: { totalTokens: 17 },
};
const receipt = "topology-retry-receipt";

async function fixture(t, suffix) {
	const cwd = await mkdtemp(join(tmpdir(), `piwf-parent-usage-${suffix}-`));
	const runId = `workflow_parent_usage_${suffix}`;
	const root = store.workflowsRoot(cwd);
	await mkdir(root, { recursive: true });
	await writeFile(
		join(root, "index.json"),
		JSON.stringify({
			schemaVersion: 1,
			updatedAt: new Date().toISOString(),
			runs: [{ runId, status: "running" }],
		}),
	);
	usage.resetParentUsageTrackingForTests();
	usage.beginParentUsageTracking(cwd, runId, owner);
	await usage.flushParentUsageTracking(cwd, owner);
	t.after(async () => {
		usage.resetParentUsageTrackingForTests();
		await rm(cwd, { recursive: true, force: true });
	});
	return { cwd, runId, root, indexFile: join(root, "index.json") };
}

function observeIndexReads(t, indexFile, onRead = async () => {}) {
	const originalReadFile = fs.readFile;
	let reads = 0;
	t.mock.method(fs, "readFile", async (...args) => {
		if (String(args[0]) === indexFile) {
			reads += 1;
			await onRead(reads);
		}
		return originalReadFile(...args);
	});
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	return () => reads;
}

function settledOutcome(promise) {
	return promise.then(
		() => ({ status: "fulfilled" }),
		(error) => ({ status: "rejected", error }),
	);
}

test("the same parent-usage caller survives the first held topology window", {
	timeout: 20_000,
}, async (t) => {
	const { cwd, runId, indexFile } = await fixture(t, "handoff");
	let topology = await store.acquireWorkflowTopologyLease(cwd, 0);
	assert.ok(topology);
	const retryStarted = Promise.withResolvers();
	const indexReads = observeIndexReads(t, indexFile, async (reads) => {
		// The record operation reads once to preserve terminal intent and once in
		// mutate(). A third read can only come from retrying that retained head.
		if (reads === 3) retryStarted.resolve();
	});
	try {
		const outcome = settledOutcome(
			usage.recordParentSessionUsage(cwd, message, owner, receipt),
		);
		const first = await Promise.race([
			retryStarted.promise.then(() => "retry"),
			outcome.then(() => "settled"),
		]);
		assert.equal(first, "retry", "the original call must own the topology retry");
		await topology.release();
		topology = undefined;
		const result = await outcome;
		assert.equal(result.status, "fulfilled", result.error?.stack);

		const record = await usage.readParentUsage(cwd, runId);
		assert.equal(record.assistantMessages, 1);
		assert.equal(record.totalTokens, 17);
		assert.deepEqual(record.messageIds, [receipt]);
		assert.equal(record.lastWriteFailure, undefined);
		assert.ok(
			indexReads() >= 4,
			"the successful attempt must recheck generation under topology",
		);
	} finally {
		await topology?.release();
	}
});

test("a topology retry rechecks and refuses a replacement run generation", {
	timeout: 20_000,
}, async (t) => {
	const { cwd, runId, indexFile } = await fixture(t, "replacement");
	const runDir = store.workflowRunDir(cwd, runId);
	const topology = await store.acquireWorkflowTopologyLease(cwd, 0);
	assert.ok(topology);
	const retryReadStarted = Promise.withResolvers();
	const continueRetryRead = Promise.withResolvers();
	observeIndexReads(t, indexFile, async (reads) => {
		if (reads === 3) {
			retryReadStarted.resolve();
			await continueRetryRead.promise;
		}
	});
	try {
		const outcome = settledOutcome(
			usage.recordParentSessionUsage(cwd, message, owner, receipt),
		);
		const first = await Promise.race([
			retryReadStarted.promise.then(() => "retry"),
			outcome.then(() => "settled"),
		]);
		assert.equal(first, "retry");

		const previous = await lstat(runDir);
		// Keep the old inode alive: unlink/recreate may reuse it immediately on Linux.
		await rename(runDir, `${runDir}.retained`);
		await mkdir(runDir);
		const replacement = await lstat(runDir);
		assert.notDeepEqual(
			[replacement.dev, replacement.ino],
			[previous.dev, previous.ino],
			"the fixture must replace the directory generation",
		);
		await writeFile(join(runDir, "replacement-marker"), "new generation\n");
		continueRetryRead.resolve();
		const result = await outcome;
		assert.equal(result.status, "fulfilled", result.error?.stack);
		assert.equal(
			await readFile(join(runDir, "replacement-marker"), "utf8"),
			"new generation\n",
		);
		await assert.rejects(access(join(runDir, usage.PARENT_USAGE_FILE)), {
			code: "ENOENT",
		});
	} finally {
		continueRetryRead.resolve();
		await topology?.release();
	}
});

test("topology retries are bounded and record failure only after exhaustion", {
	timeout: 40_000,
}, async (t) => {
	const { cwd, runId, indexFile } = await fixture(t, "exhaustion");
	let topology = await store.acquireWorkflowTopologyLease(cwd, 0);
	assert.ok(topology);
	const indexReads = observeIndexReads(t, indexFile);
	const startedAt = Date.now();
	try {
		await assert.rejects(
			usage.recordParentSessionUsage(cwd, message, owner, receipt),
			/Parent usage topology busy/,
		);
		assert.ok(
			Date.now() - startedAt >= 14_500,
			"three generic five-second windows must be retained",
		);
		assert.equal(
			indexReads(),
			4,
			"one terminal read plus exactly three mutation attempts",
		);
		const beforeRecovery = await usage.readParentUsage(cwd, runId);
		assert.equal(beforeRecovery.assistantMessages, 0);
		assert.equal(beforeRecovery.lastWriteFailure, undefined);

		await topology.release();
		topology = undefined;
		await usage.flushParentUsageTracking(cwd, owner);
		const recovered = await usage.readParentUsage(cwd, runId);
		assert.equal(recovered.assistantMessages, 1);
		assert.equal(recovered.totalTokens, 17);
		assert.deepEqual(recovered.messageIds, [receipt]);
		assert.equal(recovered.lastWriteFailure?.code, "parent_usage_write_failed");
	} finally {
		await topology?.release();
	}
});

test("a held parent-usage sidecar still rejects after one acquisition window", {
	timeout: 20_000,
}, async (t) => {
	const { cwd, runId, indexFile } = await fixture(t, "sidecar");
	let sidecar = await store.acquireRunFileLease(cwd, runId, "parent-usage", 0);
	assert.ok(sidecar);
	const indexReads = observeIndexReads(t, indexFile);
	const startedAt = Date.now();
	try {
		await assert.rejects(
			usage.recordParentSessionUsage(cwd, message, owner, receipt),
			/Parent usage sidecar busy/,
		);
		assert.ok(
			Date.now() - startedAt >= 4_500,
			"the generic sidecar wait remains five seconds",
		);
		assert.equal(
			indexReads(),
			3,
			"sidecar failure must not restart the queued operation",
		);
	} finally {
		await sidecar.release();
		sidecar = undefined;
	}
});
