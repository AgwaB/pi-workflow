import assert from "node:assert/strict";
import { test } from "node:test";
import { workflowArgumentCompletions } from "../../.tmp/unit/extension.js";

test("/workflow goal suggests its subcommands and saved definitions to run", () => {
  const workflows = [{ name: "csv-parser" }, { name: "deep-review" }];
  const all = workflowArgumentCompletions("goal ", workflows)?.map(item => item.value);
  assert.deepEqual(all, ["goal create", "goal run", "goal list", "goal status", "goal pause", "goal resume", "goal cancel",
    "goal recover", "goal judge", "goal criteria", "goal evidence", "goal profile", "goal help"]);
  assert.deepEqual(workflowArgumentCompletions("goal re", workflows)?.map(item => item.value), ["goal resume", "goal recover"]);
  assert.match(workflowArgumentCompletions("goal rec", workflows)[0].description, /Continue a stopped or failed Goal/);
  assert.deepEqual(workflowArgumentCompletions("goal run ", workflows)?.map(item => item.value),
    ["goal run csv-parser", "goal run deep-review"]);
  assert.deepEqual(workflowArgumentCompletions("goal run cs", workflows)?.map(item => item.label), ["csv-parser"]);
  assert.equal(workflowArgumentCompletions("goal run csv-parser \"task", workflows), undefined, "no suggestion inside the task text");
  assert.equal(workflowArgumentCompletions("goal zzz", workflows), undefined);
  assert.equal(workflowArgumentCompletions("goal status workflow_", workflows), undefined);
  assert.ok(workflowArgumentCompletions("go", workflows).some(item => item.value === "goal"), "top-level still offers goal");
  // Pi applies a completion on Enter without submitting: a fully typed command shows no popup, so Enter runs it.
  for (const typed of ["goal", "goal status", "goal run csv-parser", "list", "run deep-review"])
    assert.equal(workflowArgumentCompletions(typed, workflows), undefined, `${typed} runs on the first Enter`);
  assert.deepEqual(workflowArgumentCompletions("goal statu", workflows)?.map(item => item.value), ["goal status"]);
});

test("goal help lists every completed subcommand in short lines", async () => {
  const { WORKFLOW_GOAL_HELP } = await import("../../.tmp/unit/goal-workflow-commands.js");
  const lines = WORKFLOW_GOAL_HELP.split("\n");
  assert.ok(lines.every(line => line.length <= 100), "every help line fits 100 columns");
  const subcommands = workflowArgumentCompletions("goal ", []).map(item => item.value.slice("goal ".length));
  for (const name of subcommands.filter(name => name !== "help"))
    assert.match(WORKFLOW_GOAL_HELP, new RegExp(`^  /workflow goal ${name}\\b`, "m"), `help explains ${name}`);
  assert.doesNotMatch(WORKFLOW_GOAL_HELP, /NEVER-launched|goal_engine_ID|admission|oracle/, "no internal terms");
});
