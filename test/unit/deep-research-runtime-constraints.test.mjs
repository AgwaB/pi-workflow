import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { compileWorkflow } from "../../.tmp/unit/compiler.js";
import { buildForeachGeneratedTasks } from "../../.tmp/unit/engine-run-graph.js";
import { loadWorkflowSpec } from "../../.tmp/unit/schema.js";

const cwd = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runtimeTask = "LOCAL_SCOPE_ONLY: read the supplied local files; do not search or fetch external sources.";
for (const [file, stages] of [
  ["spec.json", ["verify-claims"]],
  ["tiered-verification.spec.json", ["verify-core-claims", "verify-tail-claims"]],
]) {
  test(`research verifier materialization preserves user constraints: ${file}`, async () => {
    const specPath = join(cwd, "workflows/deep-research", file);
    const loaded = await loadWorkflowSpec(specPath, cwd);
    const compiled = await compileWorkflow(loaded.spec, { cwd, specPath, task: runtimeTask });
    for (const stageId of stages) {
      const template = compiled.tasks.find((task) => task.stageId === stageId);
      assert.ok(template);
      assert.equal(template.foreach.injectRuntimeTask, true);
      const item = { id: "claim-001", claim: "A local document fact.", file: "docs/policy.md" };
      const generated = buildForeachGeneratedTasks(template, runtimeTask, [item]);
      assert.equal(generated.error, undefined);
      assert.equal(generated.tasks.length, 1);
      assert.ok(generated.tasks[0].compiledPrompt.includes(`# Task\n\n${runtimeTask}`));
      assert.equal(generated.tasks[0].foreachGenerated.itemIdentity, item.id);
      // Demonstrate that the assertion exercises the injection flag, not item text.
      const omitted = buildForeachGeneratedTasks({ ...template, foreach: { ...template.foreach, injectRuntimeTask: false } }, runtimeTask, [item]);
      assert.equal(omitted.tasks[0].compiledPrompt.includes(runtimeTask), false);
    }
  });
}
