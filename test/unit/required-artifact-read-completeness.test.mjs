import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeWorkflowTaskArtifactBundle } from "../../.tmp/unit/workflow-output-artifacts.js";
import { handleWorkflowArtifactToolCall } from "../../.tmp/unit/workflow-artifact-tool.js";
import { checkRequiredArtifactReads } from "../../.tmp/unit/subagent-backend.js";

async function fixture(t) {
 const root = await mkdtemp(join(tmpdir(), "workflow-read-completeness-"));
 t.after(() => rm(root, { recursive: true, force: true }));
 const producer = join(root, "tasks", "producer"), consumer = join(root, "tasks", "consumer");
 await mkdir(consumer, { recursive: true });
 const bundle = await writeWorkflowTaskArtifactBundle({ taskDir: producer, rawOutput: '<control>{"schema":"stage-control-v1","digest":"done","items":["a","b"],"empty":[]}</control>\n<analysis>Evidence</analysis>\n<refs>[]</refs>' });
 assert.equal(bundle.valid, true);
 const config = { runId: "test", taskId: "consumer", runDir: root, manifestPath: join(consumer, "source-manifest.json"), ledgerPath: join(consumer, "read-ledger.jsonl") };
 await writeFile(config.manifestPath, JSON.stringify({ schema: "workflow-source-manifest-v1", runId: "test", taskId: "consumer", sources: [{ source: "producer", artifacts: { control: { path: bundle.files.control } } }] }));
 return { consumer, config, read: (args) => handleWorkflowArtifactToolCall({ action: "read", source: "producer", artifact: "control", ...args }, config) };
}

for (const limits of [{ maxItems: 1, maxChars: 1000 }, { maxItems: 2, maxChars: 2 }]) {
 test(`real truncated projection cannot satisfy required reads ${JSON.stringify(limits)}`, async (t) => {
  const f = await fixture(t);
  const result = await f.read({ path: "$.items", ...limits });
  assert.equal(result.details.truncated, true);
  const requirement = { source: "producer", artifact: "control", path: "$.items", ...limits, count: 1 };
  assert.equal((await checkRequiredArtifactReads(f.consumer, ["producer.control"])).missing.length, 1);
  assert.equal((await checkRequiredArtifactReads(f.consumer, [requirement])).missing.length, 1);
  assert.equal((await checkRequiredArtifactReads(f.consumer, [], [{ ...requirement, mustNotTruncate: false }])).projectionFailures.length, 1);
 });
}

test("required reads preserve missing, wrong-path, empty-slice, exact-count and valid controls", async (t) => {
 const f = await fixture(t);
 const req = { source: "producer", artifact: "control", path: "$.items", maxItems: 2, maxChars: 1000, count: 1 };
 assert.equal((await checkRequiredArtifactReads(f.consumer, [req])).missing.length, 1);
 await f.read({ path: "$.empty", maxItems: 2, maxChars: 1000 });
 assert.equal((await checkRequiredArtifactReads(f.consumer, [req])).missing.length, 1);
 assert.equal((await checkRequiredArtifactReads(f.consumer, [{ ...req, path: "$.empty" }])).missing.length, 0);
 await f.read({ path: "$.items", maxItems: 2, maxChars: 1000 });
 assert.deepEqual(await checkRequiredArtifactReads(f.consumer, [req, "producer.control"]), { missing: [], projectionFailures: [] });
 await f.read({ path: "$.items", maxItems: 2, maxChars: 1000 });
 assert.equal((await checkRequiredArtifactReads(f.consumer, [req])).missing.length, 1);
 assert.equal((await checkRequiredArtifactReads(f.consumer, [{ ...req, count: 2 }])).missing.length, 0);
});

test("truncated rows do not inflate the exact count of qualifying reads", async (t) => {
 const f = await fixture(t);
 await f.read({ path: "$.items", maxItems: 1, maxChars: 1000 });
 await f.read({ path: "$.items", maxItems: 2, maxChars: 1000 });
 assert.equal((await checkRequiredArtifactReads(f.consumer, [{ source: "producer", artifact: "control", count: 1 }])).missing.length, 0);
});
