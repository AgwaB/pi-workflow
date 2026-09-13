import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { findDuplicateActiveRun } from "../../.tmp/unit/run-estimates.js";
import { formatStatus } from "../../.tmp/unit/engine-format.js";
import {
	compiledWorkflowPath,
	readFreshIndex,
	readIndex,
	setTaskTerminal,
	withRunLease,
	workflowIndexPath,
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

test("formatStatus does not create workflow state in a project without runs", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "piwf-status-empty-"));
	try {
		assert.equal(await formatStatus(cwd), "No workflow runs found.");
		assert.equal(
			existsSync(join(cwd, ".pi", "workflows")),
			false,
			"empty status does not create workflow state",
		);
	} finally {
		const { rm } = await import("node:fs/promises");
		await rm(cwd, { recursive: true, force: true });
	}
});

for (const state of ["corrupt", "orphaned", "directory"]) {
	test(`empty formatStatus preserves existing ${state} index maintenance`, async () => {
		const cwd = await mkdtemp(join(tmpdir(), "piwf-status-repair-"));
		try {
			await mkdir(join(cwd, ".pi", "workflows"), { recursive: true });
			if (state === "corrupt") {
				await writeFile(workflowIndexPath(cwd), "{invalid\n");
			} else if (state === "orphaned") {
				const run = runRecord(cwd, "removed-run");
				await writeJsonAtomic(workflowRunPath(cwd, run.runId), run);
				assert.equal((await readFreshIndex(cwd)).runs.length, 1);
				await rm(workflowRunDir(cwd, run.runId), { recursive: true });
			} else {
				await mkdir(workflowIndexPath(cwd));
			}
			if (state === "directory") {
				await assert.rejects(formatStatus(cwd), { code: "EISDIR" });
			} else {
				assert.equal(await formatStatus(cwd), "No workflow runs found.");
				assert.deepEqual((await readIndex(cwd)).runs, []);
			}
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
}

test("concurrent first-run status still publishes a real run", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "piwf-status-first-run-"));
	try {
		const runId = "status-first-run";
		const run = runRecord(cwd, runId);
		setTaskTerminal(run.tasks[0], "completed", "completed");
		run.status = "completed";
		await writeJsonAtomic(workflowRunPath(cwd, runId), run);
		const statuses = await Promise.all([
			formatStatus(cwd),
			formatStatus(cwd),
			formatStatus(cwd),
		]);
		for (const status of statuses) assert.match(status, /status-first-run/);
		const index = await readIndex(cwd);
		assert.ok(index);
		assert.deepEqual(index.runs.map((run) => run.runId), [runId]);
	} finally {
		const { rm } = await import("node:fs/promises");
		await rm(cwd, { recursive: true, force: true });
	}
});

test("resumeSupervisors does not create workflow state in a project without runs", async () => {
	const { resumeSupervisors } = await import("../../.tmp/unit/engine.js");
	const { existsSync } = await import("node:fs");
	const { rm } = await import("node:fs/promises");
	const cwd = await mkdtemp(join(tmpdir(), "piwf-resume-empty-"));
	try {
	await resumeSupervisors(cwd);
	assert.equal(existsSync(join(cwd, ".pi", "workflows")), false, "no .pi/workflows directory is created");
	assert.equal(await readIndex(cwd), undefined);

	// Once a run exists the index is written as before.
	const runId = "resume-seeded";
	await mkdir(workflowRunDir(cwd, runId), { recursive: true });
	const seeded = runRecord(cwd, runId);
	setTaskTerminal(seeded.tasks[0], "completed", "completed");
	seeded.status = "completed";
	await withRunLease(cwd, runId, async () => writeRunRecord(cwd, seeded));
	await resumeSupervisors(cwd);
	const index = await readIndex(cwd);
	assert.ok(index, "index is created once a run exists");
	assert.deepEqual(index.runs.map((run) => run.runId), [runId]);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
