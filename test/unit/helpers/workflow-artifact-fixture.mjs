import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeWorkflowTaskArtifactBundle } from "../../../.tmp/unit/workflow-output-artifacts.js";
import { handleWorkflowArtifactToolCall } from "../../../.tmp/unit/workflow-artifact-tool.js";

export async function artifactReadFixture(t, control = { schema: "stage-control-v1", digest: "done", items: ["a", "b"], empty: [] }, source = "producer") {
 const root = await mkdtemp(join(tmpdir(), "workflow-read-completeness-"));
 t.after(() => rm(root, { recursive: true, force: true }));
 const producer = join(root, "tasks", "producer"), consumer = join(root, "tasks", "consumer");
 await mkdir(consumer, { recursive: true });
 const bundle = await writeWorkflowTaskArtifactBundle({ taskDir: producer, rawOutput: `<control>${JSON.stringify(control)}</control>\n<analysis>Evidence</analysis>\n<refs>[]</refs>` });
 assert.equal(bundle.valid, true);
 const config = { runId: "test", taskId: "consumer", runDir: root, manifestPath: join(consumer, "source-manifest.json"), ledgerPath: join(consumer, "read-ledger.jsonl") };
 await writeFile(config.manifestPath, JSON.stringify({ schema: "workflow-source-manifest-v1", runId: "test", taskId: "consumer", sources: [{ source, artifacts: { control: { path: bundle.files.control } } }] }));
 return { consumer, config, bundle, read: (args) => handleWorkflowArtifactToolCall({ action: "read", source, artifact: "control", ...args }, config) };
}
