import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	setTaskArtifactLinkForTests,
	writeValidatedWorkflowTaskArtifactBundle,
} from "../../.tmp/unit/workflow-output-artifacts.js";
import { pruneWorkflowRuns } from "../../.tmp/unit/run-retention.js";
import {
	setStaticArtifactLinkForTests,
	updateIndex,
	withRunLease,
	writeStaticRunArtifacts,
} from "../../.tmp/unit/store.js";

const parsed = {
	protocol: "workflow-output-sections-v1",
	valid: true,
	raw: "",
	control: { status: "completed" },
	analysis: "analysis",
	refs: [],
	issues: [],
};

async function withStaticArtifacts(
	fn,
	bundleSpec = `${JSON.stringify({ name: "fixture", stages: [{ id: "main" }] }, null, 2)}\n`,
	hook,
) {
	const root = await mkdtemp(join(tmpdir(), "pi-workflow-static-artifacts-"));
	const sourceDir = join(root, "workflow");
	const runId = "workflow_static_artifact_link";
	const originalSpec = { name: "fixture", stages: [{ id: "main" }] };
	await mkdir(sourceDir, { recursive: true });
	await writeFile(join(sourceDir, "spec.json"), bundleSpec);
	try {
		setStaticArtifactLinkForTests(hook);
		await writeStaticRunArtifacts(
			root,
			{ runId, specPath: join(sourceDir, "spec.json"), tasks: [] },
			{},
			originalSpec,
		);
		await fn(join(root, ".pi", "workflows", runId), originalSpec);
	} finally {
		setStaticArtifactLinkForTests(undefined);
		await rm(root, { recursive: true, force: true });
	}
}

async function withTaskDir(fn) {
	const root = await mkdtemp(join(tmpdir(), "pi-workflow-artifacts-"));
	let failed = false;
	try {
		await fn(root);
	} catch (error) {
		failed = true;
		throw error;
	} finally {
		setTaskArtifactLinkForTests(undefined);
		if (!failed) await rm(root, { recursive: true, force: true });
		else console.error(`workflow artifact test artifacts retained at ${root}`);
	}
}




test("artifact file names and files.output remain unchanged", async () => {
	await withTaskDir(async (root) => {
		const result = await writeValidatedWorkflowTaskArtifactBundle({
			taskDir: root,
			rawOutput: "raw\n",
		}, parsed);
		assert.deepEqual(Object.keys(result.files).sort(), [
			"analysis",
			"control",
			"raw",
			"refs",
			"result",
		]);
		assert.equal(result.files.raw, join(root, "raw.md"));
		assert.equal(join(root, "output.log").endsWith("output.log"), true);
	});
});

function terminalRun(runId, updatedAt, options = {}) {
	return {
		schemaVersion: 1,
		runId,
		name: options.name ?? runId,
		createdAt: updatedAt,
		updatedAt,
		provenance: options.provenance,
		tasks: [{ taskId: "task-1", specId: "task-1", status: options.status ?? "completed", statusDetail: "fixture" }],
	};
}

async function writeRun(cwd, run) {
	const dir = join(cwd, ".pi", "workflows", run.runId);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "run.json"), `${JSON.stringify(run)}\n`);
	await writeFile(join(dir, "artifact.bin"), "artifact");
}


test("prune protects running, blocked, and live-lease runs", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-prune-"));
	try {
		await writeRun(cwd, terminalRun("workflow-terminal", "2026-01-01T00:00:00.000Z"));
		await writeRun(cwd, terminalRun("workflow-running", "2026-01-02T00:00:00.000Z", { status: "running" }));
		await writeRun(cwd, terminalRun("workflow-blocked", "2026-01-03T00:00:00.000Z", { status: "blocked" }));
		await writeRun(cwd, terminalRun("workflow-live", "2026-01-04T00:00:00.000Z"));
		const result = await withRunLease(cwd, "workflow-live", async () => pruneWorkflowRuns(cwd, { keep: 0, yes: true }));
		const live = result.runs.find((run) => run.runId === "workflow-live");
		assert.equal(live?.protected, true);
		assert.equal(result.runs.some((run) => run.runId === "workflow-running"), false);
		assert.equal(result.runs.some((run) => run.runId === "workflow-blocked"), false);
		await stat(join(cwd, ".pi", "workflows", "workflow-live", "run.json"));
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});


test("prune skips symlinked run directories outside the workflow root", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-prune-"));
	const outside = await mkdtemp(join(tmpdir(), "pi-workflow-outside-"));
	try {
		await mkdir(join(cwd, ".pi", "workflows"), { recursive: true });
		await writeRun(outside, terminalRun("workflow-outside", "2020-01-01T00:00:00.000Z"));
		await symlink(join(outside, ".pi", "workflows", "workflow-outside"), join(cwd, ".pi", "workflows", "workflow-link"));
		const summary = await pruneWorkflowRuns(cwd, { keep: 0, yes: true });
		assert.equal(summary.runs.length, 0);
		await stat(join(outside, ".pi", "workflows", "workflow-outside", "run.json"));
	} finally {
		await rm(cwd, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});
