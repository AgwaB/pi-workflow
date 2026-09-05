import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseWorkflowOutput, parseWorkflowOutputForBundle, writeWorkflowTaskArtifactBundle, buildWorkflowOutputRetryInstructions } from "../../.tmp/unit/workflow-output-artifacts.js";
import { writeArtifactGraphSupportResult } from "../../.tmp/unit/artifact-graph-runtime.js";
import { compileWorkflow } from "../../.tmp/unit/compiler.js";
import { parseWorkflow } from "../../.tmp/unit/schema.js";

const control = '<control>{"schema":"stage-control-v1","digest":"done"}</control>';
const analysis = '<analysis>Literal <partial-control>example</partial-control> retained.</analysis>';
const refs = '<refs>[{"note":"Literal <analysis> marker"}]</refs>';
for (const analysisRequired of [true, false]) for (const refsRequired of [true, false]) {
 const options = { analysisRequired, refsRequired };
 test(`optional presence follows required flags ${JSON.stringify(options)}`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workflow-optional-output-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const includeAnalysis of [true, false]) for (const includeRefs of [true, false]) {
   const raw = [control, includeAnalysis ? analysis : "", includeRefs ? refs : ""].filter(Boolean).join("\n");
   const intended = (!analysisRequired || includeAnalysis) && (!refsRequired || includeRefs);
   const direct = parseWorkflowOutput(raw, options);
   assert.equal(direct.valid, intended, JSON.stringify({ options, includeAnalysis, includeRefs, issues: direct.issues }));
   if (!intended) continue; // Existing bundle tail-repair policy is independent of required presence.
   assert.equal(parseWorkflowOutputForBundle(raw, options).valid, true);
   const bundle = await writeWorkflowTaskArtifactBundle({ taskDir: root, rawOutput: raw, ...options });
   assert.equal(bundle.valid, true);
   assert.equal(await readFile(bundle.files.analysis, "utf8"), includeAnalysis ? 'Literal <partial-control>example</partial-control> retained.\n' : '\n');
   assert.deepEqual(JSON.parse(await readFile(bundle.files.refs, "utf8")), includeRefs ? [{ note: "Literal <analysis> marker" }] : []);
  }
 });
 test(`support serializer accepts optional settings ${JSON.stringify(options)}`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workflow-optional-support-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const task = { files: { output: join(root, "output.log"), stderr: join(root, "stderr.log"), result: join(root, "result.json") }, artifactGraph: { output: options } };
  await writeArtifactGraphSupportResult(root, task, { control: { schema: "stage-control-v1", digest: "done" }, analysis: "Kept evidence", refs: [] });
  const result = JSON.parse(await readFile(task.files.result, "utf8"));
  assert.equal(result.outputValidation.valid, true);
  assert.equal((await readFile(join(root, "analysis.md"), "utf8")).trim(), "Kept evidence");
 });
}

test("optional section prompts permit omission instead of demanding three sections", async (t) => {
 const root = await mkdtemp(join(tmpdir(), "workflow-optional-prompt-"));
 t.after(() => rm(root, { recursive: true, force: true }));
 const spec = parseWorkflow({ schemaVersion: 1, defaults: { agent: "scout", tools: ["read"], readOnly: true }, artifactGraph: { stages: [{ id: "one", type: "single", prompt: "Emit output.", output: { analysis: { required: false }, refs: { required: false }, partial: { paths: ["$.items"] } } }] } });
 const compiled = await compileWorkflow(spec, { cwd: root, specPath: join(root, "spec.json"), task: "local task" });
 const prompt = compiled.tasks[0].compiledPrompt;
 const retry = buildWorkflowOutputRetryInstructions([{ code: "invalid_json", section: "control", message: "invalid JSON" }], { analysisRequired: false, refsRequired: false });
 for (const text of [prompt, retry]) {
  assert.doesNotMatch(text, /exactly as these three sections|normal <control>, <analysis>, and <refs> sections exactly once/);
  assert.match(text, /<analysis>.*optional/i);
  assert.match(text, /<refs>.*optional/i);
 }
 const minimumRefs = buildWorkflowOutputRetryInstructions([], { analysisRequired: false, refsRequired: false, refsMinItems: 1 });
 assert.doesNotMatch(minimumRefs, /<refs>.*optional/i);
});

test("supplied optional sections still enforce JSON, canonical order, duplicate and refs-minimum rules", () => {
 const options = { analysisRequired: false, refsRequired: false };
 for (const raw of [`${control}\n<refs>bad</refs>`, `${control}\n${refs}\n${analysis}`, `${control}\n${analysis}\n${analysis}`, `${control}\n${refs}\n${refs}`]) {
  for (const parser of [parseWorkflowOutput, parseWorkflowOutputForBundle]) assert.equal(parser(raw, options).valid, false, raw);
 }
 assert.equal(parseWorkflowOutput(control, { ...options, refsMinItems: 1 }).valid, false);
 assert.equal(parseWorkflowOutput(`${control}\n<refs>[]</refs>`, { ...options, refsMinItems: 1 }).valid, false);
});
