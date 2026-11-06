import assert from "node:assert/strict";
import { test } from "node:test";
import { workflowArgumentCompletions } from "../../.tmp/unit/extension.js";

test("/workflow goal suggests its subcommands and saved definitions to run", () => {
  const workflows = [{ name: "csv-parser" }, { name: "deep-review" }];
  const all = workflowArgumentCompletions("goal ", workflows)?.map(item => item.value);
  assert.deepEqual(all, ["goal create", "goal run", "goal status", "goal list", "goal pause", "goal resume",
    "goal recover", "goal judge", "goal cancel", "goal help", "goal criteria", "goal evidence"],
    "everyday commands first, JSON troubleshooting last; profile is not offered");
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
