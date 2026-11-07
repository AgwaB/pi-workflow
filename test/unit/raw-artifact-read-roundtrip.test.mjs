import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat, link, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeWorkflowTaskArtifactBundle, setTaskArtifactLinkForTests } from "../../.tmp/unit/workflow-output-artifacts.js";
import { handleWorkflowArtifactToolCall, readWorkflowArtifact, setArtifactValidatedHookForTests } from "../../.tmp/unit/workflow-artifact-tool.js";
import { checkRequiredArtifactReads } from "../../.tmp/unit/subagent-backend.js";

const raw = '<control>{"schema":"stage-control-v1","digest":"done"}</control>\n<analysis>Evidence</analysis>\n<refs>[]</refs>';
async function fixture(t) {
 const root = await mkdtemp(join(tmpdir(), "workflow-raw-roundtrip-"));
 t.after(() => rm(root, { recursive: true, force: true }));
 t.after(() => { setTaskArtifactLinkForTests(undefined); setArtifactValidatedHookForTests(undefined); });
 const producer = join(root, "run", "tasks", "producer"), consumer = join(root, "run", "tasks", "consumer");
 await mkdir(producer, { recursive: true }); await mkdir(consumer, { recursive: true });
 const manifest = { schema: "workflow-source-manifest-v1", runId: "test", taskId: "consumer", sources: [{ source: "producer", artifacts: { raw: { path: join(producer, "raw.md") } } }] };
 const config = { runId: "test", taskId: "consumer", runDir: join(root, "run"), manifestPath: join(consumer, "source-manifest.json"), ledgerPath: join(consumer, "read-ledger.jsonl") };
 await writeFile(config.manifestPath, JSON.stringify(manifest));
 return { root, producer, consumer, manifest, config };
}


for (const kind of ["hardlink", "symlink", "outside", "late-hardlink"]) {
 test(`raw reader rejects arbitrary ${kind} evidence`, async (t) => {
  const f = await fixture(t), secret = join(f.root, "secret"), target = join(f.producer, "raw.md");
  await writeFile(secret, "secret");
  if (kind === "hardlink") await link(secret, target);
  else if (kind === "symlink") await symlink(secret, target);
  else if (kind === "outside") f.manifest.sources[0].artifacts.raw.path = secret;
  else {
   await writeFile(target, raw);
   setArtifactValidatedHookForTests(() => link(target, join(f.root, "late-link")));
  }
  await assert.rejects(() => readWorkflowArtifact(f.manifest, "producer", "raw", { runDir: f.config.runDir }));
 });
}
