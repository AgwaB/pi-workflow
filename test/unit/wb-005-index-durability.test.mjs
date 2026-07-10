import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { findDuplicateActiveRun } from "../../.tmp/unit/run-estimates.js";
import {
	compiledWorkflowPath,
	readFreshIndex,
	readIndex,
	setTaskTerminal,
	withRunLease,
	workflowRunDir,
	workflowRunPath,
	writeJsonAtomic,
	writeRunRecord,
} from "../../.tmp/unit/store.js";

function task(runId) {
	return {
		taskId: `${runId}-task`,
		specId: "main",
		kind: "single",
		stageId: "main",
		status: "pending",
		statusDetail: "pending",
		runtime: { maxRuntimeMs: 1_000 },
		files: {
			systemPrompt: `.pi/workflows/${runId}/tasks/main/system.md`,
			taskPrompt: `.pi/workflows/${runId}/tasks/main/task.md`,
			output: `.pi/workflows/${runId}/tasks/main/output.md`,
			stderr: `.pi/workflows/${runId}/tasks/main/stderr.log`,
			result: `.pi/workflows/${runId}/tasks/main/result.json`,
		},
	};
}

function runRecord(cwd, runId, createdAt = new Date().toISOString()) {
	return {
		schemaVersion: 1,
		runId,
		name: "unit-workflow",
		description: "unit",
		type: "workflow",
		status: "running",
		taskSummary: {
			total: 1,
			pending: 1,
			running: 0,
			completed: 0,
			failed: 0,
			skipped: 0,
			interrupted: 0,
			blocked: 0,
		},
		cwd,
		backend: { mode: "headless" },
		createdAt,
		updatedAt: createdAt,
		specPath: "/tmp/spec.json",
		tasks: [task(runId)],
	};
}

test("WB-005 first and terminal writes are immediately visible in the index", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "piwf-wb005-write-"));
	const run = runRecord(cwd, "run-first");
	await mkdir(workflowRunDir(cwd, run.runId), { recursive: true });
	await withRunLease(cwd, run.runId, async () => writeRunRecord(cwd, run));
	let index = await readIndex(cwd);
	assert.equal(index.runs.find((entry) => entry.runId === run.runId).status, "running");

	setTaskTerminal(run.tasks[0], "completed", "completed");
	await withRunLease(cwd, run.runId, async () => writeRunRecord(cwd, run));
	index = await readIndex(cwd);
	assert.equal(index.runs.find((entry) => entry.runId === run.runId).status, "completed");
});

test("WB-005 fresh index repairs missing and stale cache rows from run.json", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "piwf-wb005-fresh-"));
	const run = runRecord(cwd, "run-source");
	await writeJsonAtomic(workflowRunPath(cwd, run.runId), run);
	let index = await readFreshIndex(cwd);
	assert.equal(index.runs.find((entry) => entry.runId === run.runId).status, "running");

	setTaskTerminal(run.tasks[0], "completed", "completed");
	run.updatedAt = new Date(Date.now() + 1_000).toISOString();
	await writeJsonAtomic(workflowRunPath(cwd, run.runId), run);
	index = await readFreshIndex(cwd);
	assert.equal(index.runs.find((entry) => entry.runId === run.runId).status, "completed");
});

test("WB-005 duplicate guard sees active run.json even when index is absent", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "piwf-wb005-duplicate-"));
	const run = runRecord(cwd, "run-duplicate");
	await writeJsonAtomic(workflowRunPath(cwd, run.runId), run);
	await writeJsonAtomic(compiledWorkflowPath(cwd, run.runId), {
		name: run.name,
		task: "same task",
	});
	const match = await findDuplicateActiveRun(
		cwd,
		{ kind: "spec", name: run.name },
		"same task",
	);
	assert.equal(match.runId, run.runId);
});
