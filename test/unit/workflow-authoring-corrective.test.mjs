import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { buildForeachGeneratedTasks } from "../../dist/engine-run-graph.js";
import { compileWorkflow } from "../../dist/compiler.js";
import { parseArtifactGraphWorkflowSpec } from "../../dist/artifact-graph-schema.js";
import { WorkflowValidationError } from "../../dist/types.js";
import { listWorkflows, resolveWorkflowRef } from "../../dist/workflow-specs.js";

async function project() {
  const cwd = await mkdtemp(join(tmpdir(), "workflow-authoring-corrective-"));
  await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
  await writeFile(
    join(cwd, ".pi", "agents", "stage-agent.md"),
    "---\nname: stage-agent\ntools: [read, grep]\n---\nStage agent.\n",
  );
  await writeFile(
    join(cwd, ".pi", "agents", "item-agent.md"),
    "---\nname: item-agent\ntools: [read]\n---\nItem agent.\n",
  );
  return cwd;
}

function parse(spec) {
  return parseArtifactGraphWorkflowSpec(spec);
}

test("compiler applies foreach agent, role, tools, runtime, safety, and cwd overrides", async () => {
  const cwd = await project();
  try {
    const compiled = await compileWorkflow(
      parse({
        schemaVersion: 1,
        defaults: {
          agent: "stage-agent",
          cwd: "workspace",
          tools: ["read"],
          readOnly: false,
          worktreePolicy: "on",
        },
        roles: {
          ordinary: { prompt: "Ordinary role context." },
          item: { prompt: "Item role context." },
        },
        artifactGraph: {
          stages: [
            {
              id: "ordinary",
              type: "single",
              role: "ordinary",
              prompt: "Do the ordinary task.",
            },
            {
              id: "items",
              type: "foreach",
              from: { source: "ordinary", path: "$.items" },
              agent: "stage-agent",
              role: "ordinary",
              tools: ["grep"],
              readOnly: false,
              worktreePolicy: "on",
              each: {
                prompt: "Inspect ${item}.",
                agent: "item-agent",
                role: "item",
                tools: ["read"],
                model: "test-model",
                thinking: "low",
                maxRuntimeMs: 1234,
                readOnly: true,
                worktreePolicy: "off",
              },
              cwd: "stage-dir",
            },
          ],
        },
      }),
      { cwd, task: "Review this" },
    );

    const ordinary = compiled.tasks.find((task) => task.stageId === "ordinary");
    const template = compiled.tasks.find((task) => task.stageId === "items");
    assert.equal(ordinary.roleNames.join(","), "ordinary");
    assert.match(ordinary.compiledPrompt, /Ordinary role context/);
    assert.doesNotMatch(ordinary.compiledPrompt, /Item role context/);
    assert.ok(template);
    assert.equal(template.agent, "item-agent");
    assert.deepEqual(template.roleNames, ["item"]);
    assert.match(template.compiledPrompt, /Item role context/);
    assert.doesNotMatch(template.compiledPrompt, /Ordinary role context/);
    assert.deepEqual(template.runtime.tools, ["read"]);
    assert.equal(template.runtime.model, "test-model");
    assert.equal(template.runtime.thinking, "low");
    assert.equal(template.runtime.maxRuntimeMs, 1234);
    assert.equal(template.safety.readOnlyDeclared, true);
    assert.equal(template.safety.worktreePolicy, "off");
    assert.equal(template.safety.requiresWorktree, false);
    assert.equal(template.cwd, resolve(cwd, "workspace", "stage-dir"));
    assert.equal(template.explicitCwd, true);
    assert.equal(template.explicitWorktreePolicy, true);
    assert.equal(template.foreach.roleText.includes("Item role context"), true);

    const generated = buildForeachGeneratedTasks(template, "Review this", [{ id: "one" }]);
    assert.equal(generated.error, undefined);
    assert.equal(generated.tasks[0].agent, "item-agent");
    assert.equal(generated.tasks[0].cwd, template.cwd);
    assert.deepEqual(generated.tasks[0].runtime.tools, ["read"]);
    assert.equal(generated.tasks[0].safety.readOnlyDeclared, true);
    assert.match(generated.tasks[0].compiledPrompt, /Item role context/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("schema rejects invalid foreach runtime/safety values instead of accepting ignored fields", () => {
  assert.throws(
    () =>
      parse({
        schemaVersion: 1,
        artifactGraph: {
          stages: [
            {
              id: "items",
              type: "foreach",
              each: {
                prompt: "Inspect.",
                thinking: "turbo",
                worktreePolicy: "maybe",
              },
            },
          ],
        },
      }),
    (error) => {
      assert.ok(error instanceof WorkflowValidationError);
      assert.match(error.message, /each\.thinking: must be one of/);
      assert.match(error.message, /each\.worktreePolicy: must be one of/);
      return true;
    },
  );
});

test("workflow discovery omits invalid advertised names while explicit paths still resolve", async () => {
  const cwd = await project();
  try {
    const workflowDir = join(cwd, "workflows");
    await mkdir(workflowDir, { recursive: true });
    const spec = JSON.stringify({
      schemaVersion: 1,
      artifactGraph: { stages: [{ id: "main", type: "single", prompt: "Run." }] },
    });
    const invalidPath = join(workflowDir, "not a workflow.json");
    await writeFile(invalidPath, spec);
    const workflows = await listWorkflows(cwd);
    assert.equal(
      workflows.some((workflow) => workflow.specPath === invalidPath),
      false,
    );
    await assert.rejects(
      () => resolveWorkflowRef("not a workflow", cwd),
      /workflow names may contain only letters, numbers, dot, underscore, and dash/,
    );
    assert.equal((await resolveWorkflowRef("./workflows/not a workflow.json", cwd)).specPath, invalidPath);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
