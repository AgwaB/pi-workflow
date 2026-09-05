import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildWorkflowRunMetrics } from "../../.tmp/unit/workflow-metrics.js";
import { estimateWorkflowDurationMs } from "../../.tmp/unit/run-estimates.js";

function task(index, stageId) {
	return {
		taskId: `task-${index}`, specId: `spec-${index}`, displayName: `Task ${index}`,
		agent: "scout", stageId, runtime: {},
		status: ["completed", "failed", "skipped", "blocked", "interrupted", "running", "pending"][index % 7],
		statusDetail: "retained detail", kind: index % 3 === 0 ? "support" : "subagent",
		...(index % 2 === 0 ? {} : { usage: { inputTokens: index, outputTokens: 1, totalTokens: index + 1, costUsd: 0.01,
			aggregate: { inputTokens: index, totalTokens: index + 1, attempts: 2, incomplete: true } },
			timing: { launchWaitMs: index, executionMs: 2, totalMs: index + 2 },
			launchRetry: { attempts: 1 }, outputRetry: { attempts: 2 },
			resumeEvents: [{ launchRetryAttempts: 3, outputRetryAttempts: 4 }] }),
	};
}
function run(tasks) {
	return { runId: "workflow_metrics", type: "artifact-graph", status: "running", createdAt: "start", updatedAt: "end", tasks };
}

test("stage rollups preserve first-seen groups, task order, nulls, usage and retry semantics", () => {
	const stages = ["b", null, "a", "b", "", undefined, "__proto__", "a", null];
	const record = run(stages.map((stage, i) => task(i, stage)));
	const before = structuredClone(record);
	const metrics = buildWorkflowRunMetrics(record);
	assert.deepEqual(record, before);
	assert.deepEqual(metrics.byStage.map((stage) => stage.stageId), ["b", null, "a", "", "__proto__"]);
	assert.deepEqual(metrics.byTask.map((entry) => entry.taskId), record.tasks.map((entry) => entry.taskId));
	for (const stage of metrics.byStage) {
		const subset = run(record.tasks.filter((entry) => (entry.stageId ?? null) === stage.stageId));
		assert.deepEqual(stage, { stageId: stage.stageId, ...buildWorkflowRunMetrics(subset).totals });
	}
	assert.equal(metrics.totals.taskCount, stages.length);
	assert.equal(metrics.totals.usage.totalTokens, null);
	assert.equal(metrics.totals.retries.totalRetryEvents, 44);
	assert.equal(buildWorkflowRunMetrics(run([])).byStage.length, 0);
	// No retained grouping cache: changed records and repeated calls must be fresh.
	record.tasks[0].stageId = "new";
	record.tasks[1].usage.aggregate.totalTokens = 100;
	const updated = buildWorkflowRunMetrics(record);
	assert.equal(updated.byStage[0].stageId, "new");
	assert.equal(updated.byTask[1].usage.totalTokens, 100);
	assert.deepEqual(buildWorkflowRunMetrics(before), metrics);
});

test("duration sampling reaches usable history beyond mock prefixes and rereads provenance", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "workflow-duration-contract-"));
	try {
		const root = join(cwd, ".pi", "workflows");
		mkdirSync(root, { recursive: true });
		const now = Date.now();
		const runs = Array.from({ length: 50 }, (_, i) => ({
			runId: `workflow_sample_${i}`, name: "estimate", status: "completed",
			createdAt: new Date(now - (i + 1) * 100_000).toISOString(),
			updatedAt: new Date(now - (i + 1) * 100_000 + (i < 40 ? 90_000 : (i - 39) * 1000)).toISOString(),
		}));
		writeFileSync(join(root, "index.json"), JSON.stringify({ schemaVersion: 1, runs }));
		for (let i = 0; i < 40; i += 1) {
			const directory = join(root, runs[i].runId);
			mkdirSync(directory);
			writeFileSync(join(directory, "run.json"), JSON.stringify({ provenance: { mode: "mock" } }));
		}
		// Missing run records intentionally remain usable, as in the existing contract.
		assert.deepEqual(await estimateWorkflowDurationMs(cwd, "estimate"), { medianMs: 4500, samples: 8 });
		writeFileSync(join(root, runs[0].runId, "run.json"), JSON.stringify({ provenance: { mode: "direct-dynamic" } }));
		assert.deepEqual(await estimateWorkflowDurationMs(cwd, "estimate"), { medianMs: 4500, samples: 8 });
		writeFileSync(join(root, runs[1].runId, "run.json"), "{");
		assert.deepEqual(await estimateWorkflowDurationMs(cwd, "estimate"), { medianMs: 4500, samples: 8 });
		// Four newly usable 90s rows displace four oldest short rows: median rises.
		writeFileSync(join(root, runs[2].runId, "run.json"), "{}");
		assert.deepEqual(await estimateWorkflowDurationMs(cwd, "estimate"), { medianMs: 4500, samples: 8 });
		writeFileSync(join(root, runs[3].runId, "run.json"), "{}");
		assert.deepEqual(await estimateWorkflowDurationMs(cwd, "estimate"), { medianMs: 47000, samples: 8 });
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
