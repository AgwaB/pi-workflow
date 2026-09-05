import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseWorkflow } from "../../.tmp/unit/schema.js";
import { compileWorkflow } from "../../.tmp/unit/compiler.js";
import * as store from "../../.tmp/unit/store.js";
import * as usage from "../../.tmp/unit/workflow-parent-usage.js";
import { pruneWorkflowRuns, setWorkflowPruneAfterQuarantineForTests } from "../../.tmp/unit/run-retention.js";

const owner = "retention-owner";
const message = timestamp => ({ role: "assistant", timestamp, usage: { totalTokens: timestamp } });
async function fixture(t) {
	const cwd = await mkdtemp(join(tmpdir(), "piwf-usage-retention-"));
	t.after(async () => {
		setWorkflowPruneAfterQuarantineForTests(undefined);
		usage.resetParentUsageTrackingForTests();
		await store.flushPendingIndexUpdatesForTests();
		await rm(cwd, { recursive: true, force: true });
	});
	const specPath = join(cwd, "spec.json");
	await writeFile(join(cwd, "helper.mjs"), "export default()=>({control:{schema:'fixture',digest:'done'},analysis:'fixture',refs:[]});");
	const spec = parseWorkflow({ schemaVersion: 1, name: "usage-retention", artifactGraph: { stages: [{ id: "local", support: { uses: "./helper.mjs" } }] } });
	await writeFile(specPath, JSON.stringify(spec));
	const compiled = await compileWorkflow(spec, { cwd, specPath, task: "Local record only; no task execution." });
	const { run } = await store.createWorkflowRunRecord(cwd, compiled, specPath);
	await store.writeStaticRunArtifacts(cwd, run, compiled, spec);
	await store.writeRunRecord(cwd, run);
	usage.beginParentUsageTracking(cwd, run.runId, owner);
	await usage.recordParentSessionUsage(cwd, message(10), owner);
	assert.equal((await usage.readParentUsage(cwd, run.runId)).totalTokens, 10);
	for (const task of run.tasks) task.status = "completed";
	await store.writeRunRecord(cwd, run);
	return { cwd, run, dir: store.workflowRunDir(cwd, run.runId) };
}

test("later usage and flush do not recreate an explicitly pruned run", async t => {
	const { cwd, run, dir } = await fixture(t);
	const result = await pruneWorkflowRuns(cwd, { keep: 0, yes: true });
	assert.equal(result.runs.filter(row => row.deleted).length, 1);
	await assert.rejects(access(dir), { code: "ENOENT" });
	await usage.recordParentSessionUsage(cwd, message(777), owner);
	await usage.recordParentSessionUsage(cwd, message(888), owner);
	await usage.flushParentUsageTracking(cwd, owner, true);
	await assert.rejects(access(dir), { code: "ENOENT" });
	assert.equal((await store.readIndex(cwd)).runs.some(row => row.runId === run.runId), false);
});

test("usage cannot recreate a detached generation while prune still owns topology", async t => {
	const { cwd, dir } = await fixture(t);
	let observed = false;
	setWorkflowPruneAfterQuarantineForTests(async () => {
		await assert.rejects(access(dir), { code: "ENOENT" });
		await usage.recordParentSessionUsage(cwd, message(777), owner);
		await assert.rejects(access(dir), { code: "ENOENT" });
		observed = true;
	});
	const result = await pruneWorkflowRuns(cwd, { keep: 0, yes: true });
	assert.equal(result.error, undefined);
	assert.equal(observed, true);
	await assert.rejects(access(dir), { code: "ENOENT" });
});

test("a replacement run with the same id never receives the old tracked delta", async t => {
	const { cwd, run, dir } = await fixture(t);
	let replacement;
	setWorkflowPruneAfterQuarantineForTests(async () => {
		// Simulate a separately published filesystem generation at the old name.
		await mkdir(dir);
		const next = structuredClone(run);
		next.createdAt = new Date(Date.now() + 1000).toISOString();
		next.status = "running";
		for (const task of next.tasks) task.status = "running";
		replacement = JSON.stringify(next);
		await writeFile(join(dir, "run.json"), replacement);
	});
	await pruneWorkflowRuns(cwd, { keep: 0, yes: true });
	await usage.recordParentSessionUsage(cwd, message(777), owner);
	await usage.flushParentUsageTracking(cwd, owner, true);
	assert.equal(await readFile(join(dir, "run.json"), "utf8"), replacement);
	await assert.rejects(access(join(dir, "parent-usage.json")), { code: "ENOENT" });
});

test("beginning tracking for an unknown run does not create workflow storage", async t => {
	const cwd = await mkdtemp(join(tmpdir(), "piwf-usage-unknown-"));
	t.after(async () => { usage.resetParentUsageTrackingForTests(); await rm(cwd, { recursive: true, force: true }); });
	usage.beginParentUsageTracking(cwd, "workflow_unknown", owner);
	await usage.flushParentUsageTracking(cwd, owner);
	await usage.recordParentSessionUsage(cwd, message(777), owner);
	await assert.rejects(access(join(cwd, ".pi", "workflows")), { code: "ENOENT" });
});
