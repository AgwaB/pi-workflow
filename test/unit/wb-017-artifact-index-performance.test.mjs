import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	clearCompletedArtifactReadCacheForTests,
	handleWorkflowArtifactToolCall,
	readWorkflowArtifactReadLedger,
	setArtifactValidatedHookForTests,
} from "../../.tmp/unit/workflow-artifact-tool.js";
import {
	flushPendingIndexUpdatesForTests,
	setIndexUpdateDebounceMsForTests,
	setTaskTerminal,
	writeRunRecord,
} from "../../.tmp/unit/store.js";
import { EXPERIMENTAL_TOOL_DEDUP_ENV } from "../../.tmp/unit/experimental-speed-flags.js";

function artifactManifest(runId, taskId, artifactPath, status) {
	return {
		schema: "workflow-source-manifest-v1",
		runId,
		taskId,
		sources: [
		{
			source: "producer",
			taskId: "task-1",
			specId: "producer",
			stageId: "producer",
			status,
			statusDetail: status,
			artifacts: { analysis: { path: artifactPath, mediaType: "text/plain" } },
		},
		],
	};
}

async function artifactFixture(status = "completed") {
	const cwd = await mkdtemp(join(tmpdir(), "piwf-wb017-artifact-"));
	const runId = `workflow_wb017_${status}`;
	const runDir = join(cwd, ".pi", "workflows", runId);
	const producerDir = join(runDir, "tasks", "task-1");
	const consumerDir = join(runDir, "tasks", "task-2");
	await mkdir(producerDir, { recursive: true });
	await mkdir(consumerDir, { recursive: true });
	const artifactPath = join(producerDir, "analysis.md");
	const manifestPath = join(consumerDir, "source-manifest.json");
	const ledgerPath = join(consumerDir, "read-ledger.jsonl");
	await writeFile(artifactPath, "immutable output\n");
	await writeFile(
		manifestPath,
		JSON.stringify(artifactManifest(runId, "task-2", artifactPath, status)),
	);
	return {
		cwd,
		artifactPath,
		manifestPath,
		ledgerPath,
		config: { runId, taskId: "task-2", manifestPath, ledgerPath, runDir },
	};
}

test("WB-017 memoizes completed artifact reads with identical output and ledger rows", async (t) => {
	clearCompletedArtifactReadCacheForTests();
	t.after(() => {
		clearCompletedArtifactReadCacheForTests();
		setArtifactValidatedHookForTests(undefined);
	});
	const fixture = await artifactFixture("completed");
	t.after(() => rm(fixture.cwd, { recursive: true, force: true }));
	let opens = 0;
	setArtifactValidatedHookForTests(() => {
		opens += 1;
	});
	const params = { action: "read", source: "producer", artifact: "analysis" };
	const first = await handleWorkflowArtifactToolCall(params, fixture.config);
	await writeFile(fixture.artifactPath, "unexpected rewrite\n");
	const second = await handleWorkflowArtifactToolCall(params, fixture.config);
	assert.deepEqual(second, first);
	assert.equal(opens, 1);
	const ledger = await readWorkflowArtifactReadLedger(fixture.ledgerPath);
	assert.equal(ledger.length, 2);
	assert.equal(ledger[0].returnedBytes, ledger[1].returnedBytes);
	assert.equal(ledger[0].bytes, ledger[1].bytes);
});

test("long-lived Goal host reads bypass both worker caches and retain real ledger rows", async (t) => {
	clearCompletedArtifactReadCacheForTests();
	const previous = process.env[EXPERIMENTAL_TOOL_DEDUP_ENV];
	process.env[EXPERIMENTAL_TOOL_DEDUP_ENV] = "1";
	t.after(() => {
		if (previous === undefined) delete process.env[EXPERIMENTAL_TOOL_DEDUP_ENV];
		else process.env[EXPERIMENTAL_TOOL_DEDUP_ENV] = previous;
		clearCompletedArtifactReadCacheForTests();
		setArtifactValidatedHookForTests(undefined);
	});
	const fixture = await artifactFixture("completed");
	t.after(() => rm(fixture.cwd, { recursive: true, force: true }));
	let opens = 0;
	setArtifactValidatedHookForTests(() => { opens++; });
	const params = { action: "read", source: "producer", artifact: "analysis" };
	await handleWorkflowArtifactToolCall(params, fixture.config);
	await writeFile(fixture.artifactPath, "current attempt output\n");
	const config = { ...fixture.config, cache: false };
	const first = await handleWorkflowArtifactToolCall(params, config);
	const second = await handleWorkflowArtifactToolCall(params, config);
	assert.match(first.content[0].text, /current attempt output/);
	assert.deepEqual(second, first);
	assert.equal(first.details.duplicate, undefined);
	assert.equal(opens, 3);
	const ledger = await readWorkflowArtifactReadLedger(fixture.ledgerPath);
	assert.equal(ledger.length, 3);
	assert.equal(ledger[1].returnedBytes, Buffer.byteLength("current attempt output\n"));
	assert.equal(ledger[2].returnedBytes, ledger[1].returnedBytes);
});

test("WB-017 never memoizes running sources", async (t) => {
	clearCompletedArtifactReadCacheForTests();
	t.after(() => {
		clearCompletedArtifactReadCacheForTests();
		setArtifactValidatedHookForTests(undefined);
	});
	const fixture = await artifactFixture("running");
	t.after(() => rm(fixture.cwd, { recursive: true, force: true }));
	let opens = 0;
	setArtifactValidatedHookForTests(() => {
		opens += 1;
	});
	const params = { action: "read", source: "producer", artifact: "analysis" };
	const first = await handleWorkflowArtifactToolCall(params, fixture.config);
	await writeFile(fixture.artifactPath, "new running output\n");
	const second = await handleWorkflowArtifactToolCall(params, fixture.config);
	assert.match(first.content[0].text, /immutable output/);
	assert.match(second.content[0].text, /new running output/);
	assert.equal(opens, 2);
});

function runningRun(cwd, runId) {
	return {
		schemaVersion: 1,
		runId,
		type: "artifact-graph",
		status: "running",
		cwd,
		backend: { type: "local-pi", mode: "headless" },
		createdAt: "2026-07-10T02:00:00.000Z",
		updatedAt: "2026-07-10T02:00:00.000Z",
		specPath: "fixture.json",
		taskSummary: {
			pending: 1,
			running: 0,
			blocked: 0,
			completed: 0,
			failed: 0,
			skipped: 0,
			interrupted: 0,
			total: 1,
		},
		tasks: [
			{
				taskId: "task-1",
				specId: "main",
				displayName: "main",
				agent: "scout",
				runtime: { model: "test-model", thinking: "none" },
				status: "pending",
				statusDetail: "pending",
				backendTaskId: "",
				files: {},
			},
		],
	};
}

async function indexedRunIds(cwd) {
	const index = JSON.parse(
		await readFile(join(cwd, ".pi", "workflows", "index.json"), "utf8"),
	);
	return index.runs.map((run) => run.runId).sort();
}


test("WB-017 keeps cwd batches separate and terminal cancellation preserves sibling dirtiness", async (t) => {
	setIndexUpdateDebounceMsForTests(60_000);
	t.after(async () => {
		setIndexUpdateDebounceMsForTests(undefined);
		await flushPendingIndexUpdatesForTests();
	});
	await flushPendingIndexUpdatesForTests();
	const firstCwd = await mkdtemp(join(tmpdir(), "piwf-wb017-index-a-"));
	const secondCwd = await mkdtemp(join(tmpdir(), "piwf-wb017-index-b-"));
	t.after(() => Promise.all([firstCwd, secondCwd].map((cwd) => rm(cwd, { recursive: true, force: true }))));
	const first = runningRun(firstCwd, "workflow_first");
	const sibling = runningRun(firstCwd, "workflow_sibling");
	const separate = runningRun(secondCwd, "workflow_separate");
	for (const run of [first, sibling, separate]) await writeRunRecord(run.cwd, run);
	for (const run of [first, sibling, separate]) await writeRunRecord(run.cwd, run);
	setTaskTerminal(first.tasks[0], "completed", "completed", {});
	await writeRunRecord(firstCwd, first);
	assert.equal(await flushPendingIndexUpdatesForTests(), 2);
	assert.deepEqual(await indexedRunIds(firstCwd), ["workflow_first", "workflow_sibling"]);
	assert.deepEqual(await indexedRunIds(secondCwd), ["workflow_separate"]);
});
