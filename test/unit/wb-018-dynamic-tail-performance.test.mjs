import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	appendDynamicEvent,
	dynamicEventAppendStatsForTests,
	dynamicEventsPath,
	readDynamicEvents,
	resetDynamicEventAppendStateForTests,
} from "../../.tmp/unit/dynamic-events.js";
import { readFileLinesBounded } from "../../.tmp/unit/workflow-view.js";

function input(index) {
	return {
		controllerSpecId: "controller",
		type: "controller.status",
		opId: `op-${index}`,
		timestamp: new Date(Date.UTC(2026, 6, 10, 2, 0, 0, index)).toISOString(),
		payload: { index },
	};
}

test("WB-018 dynamic append cursor reads a ledger once and preserves sequential bytes", async (t) => {
	resetDynamicEventAppendStateForTests();
	t.after(() => resetDynamicEventAppendStateForTests());
	const cwd = await mkdtemp(join(tmpdir(), "piwf-wb018-dynamic-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const runId = "workflow_incremental";
	for (let index = 1; index <= 100; index += 1)
		await appendDynamicEvent(cwd, runId, input(index));
	assert.deepEqual(dynamicEventAppendStatsForTests(), {
		cursors: 1,
		fullLedgerReads: 1,
	});
	const events = await readDynamicEvents(cwd, runId);
	assert.deepEqual(
		events.map((event) => event.seq),
		Array.from({ length: 100 }, (_, index) => index + 1),
	);
	const text = await readFile(dynamicEventsPath(cwd, runId), "utf8");
	assert.equal(text, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
});

test("WB-018 dynamic append queue serializes same-process concurrent calls", async (t) => {
	resetDynamicEventAppendStateForTests();
	t.after(() => resetDynamicEventAppendStateForTests());
	const cwd = await mkdtemp(join(tmpdir(), "piwf-wb018-concurrent-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const runId = "workflow_concurrent";
	const appended = await Promise.all(
		Array.from({ length: 40 }, (_, index) =>
			appendDynamicEvent(cwd, runId, input(index + 1)),
		),
	);
	assert.deepEqual(
		appended.map((event) => event.seq),
		Array.from({ length: 40 }, (_, index) => index + 1),
	);
	assert.equal(dynamicEventAppendStatsForTests().fullLedgerReads, 1);
});

test("WB-018 cursor self-heals after restart and external size change", async (t) => {
	resetDynamicEventAppendStateForTests();
	t.after(() => resetDynamicEventAppendStateForTests());
	const cwd = await mkdtemp(join(tmpdir(), "piwf-wb018-restart-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const runId = "workflow_restart";
	await appendDynamicEvent(cwd, runId, input(1));
	resetDynamicEventAppendStateForTests();
	assert.equal((await appendDynamicEvent(cwd, runId, input(2))).seq, 2);
	assert.equal(dynamicEventAppendStatsForTests().fullLedgerReads, 1);
	const external = {
		schema: "pi-workflow-dynamic-event-v1",
		seq: 3,
		opId: "external",
		requestHash: "external-hash",
		runId,
		controllerSpecId: "controller",
		type: "controller.status",
		timestamp: "2026-07-10T02:00:00.003Z",
		payload: { external: true },
	};
	await appendFile(dynamicEventsPath(cwd, runId), `${JSON.stringify(external)}\n`);
	assert.equal((await appendDynamicEvent(cwd, runId, input(4))).seq, 4);
	assert.equal(dynamicEventAppendStatsForTests().fullLedgerReads, 2);
	assert.deepEqual(
		(await readDynamicEvents(cwd, runId)).map((event) => event.seq),
		[1, 2, 3, 4],
	);
});

test("WB-018 bounded tail matches full UTF-8/CRLF visible output with fewer bytes", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "piwf-wb018-tail-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const relative = "logs/output.log";
	const absolute = join(cwd, relative);
	await mkdir(join(cwd, "logs"), { recursive: true });
	const allLines = Array.from(
		{ length: 4_000 },
		(_, index) => `${String(index).padStart(5, "0")}: 한글🙂 ${"x".repeat(180)}`,
	);
	const body = allLines.join("\r\n");
	await writeFile(absolute, body);
	let bytesRead = 0;
	const actual = await readFileLinesBounded(cwd, relative, 200, {
		chunkBytes: 257,
		onRead: (bytes) => {
			bytesRead += bytes;
		},
	});
	const expected = body.split(/\r?\n/).slice(-200);
	assert.deepEqual(actual, expected);
	assert.ok(bytesRead < Buffer.byteLength(body) / 4, `${bytesRead} bytes read`);
});

test("WB-018 bounded tail preserves short, trailing-newline, empty, and missing behavior", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "piwf-wb018-tail-edge-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await writeFile(join(cwd, "short.log"), "alpha\nbeta\n");
	await writeFile(join(cwd, "empty.log"), "");
	assert.deepEqual(await readFileLinesBounded(cwd, "short.log", 10), [
		"alpha",
		"beta",
	]);
	assert.deepEqual(await readFileLinesBounded(cwd, "empty.log", 10), []);
	assert.deepEqual(await readFileLinesBounded(cwd, "missing.log", 10), []);
	assert.deepEqual(await readFileLinesBounded(cwd, "short.log", 0), []);
});
