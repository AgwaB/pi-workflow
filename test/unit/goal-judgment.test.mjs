import assert from "node:assert/strict";
import { test } from "node:test";
import { describeGoalJudgment, GOAL_JUDGE_SHOW } from "../../.tmp/unit/goal-judgment.js";

const hex = text => Buffer.from(text).toString("hex");
function snapshot(subject, statement = "The change is clear enough to accept") {
  return { runId: "workflow_j", policySpecId: "goal.main", generation: 0, criterionId: "readable",
    definitionFingerprint: "def", subjectDigest: "digest",
    criterion: { id: "readable", verifier: { kind: "human", config: { condition: { statement } } } },
    subjectBytes: JSON.stringify(subject), source: { taskId: "result", identity: { taskId: "task-3" } } };
}
const candidate = files => ({ schema: "goal-candidate-evidence-v1", candidate: { baselineHash: "b", files } });
const file = (path, text) => ({ path, value: { hex: hex(text), kind: "file", links: 1, mode: "0644" } });

test("a candidate change is shown as a diff against the working tree, the exact bytes behind Show everything", async () => {
  const subject = candidate([file("src/csv.mjs", "export const a = 1;\nexport const b = 3;\n")]);
  const view = await describeGoalJudgment(snapshot(subject), { goalName: "csv-reviewed", attempt: 2,
    workerNotes: ["Changed b to 3."], otherChecks: ["tests-pass met (exit 0)"] },
    async path => path === "src/csv.mjs" ? "export const a = 1;\nexport const b = 2;\n" : undefined);
  const lines = view.summary.split("\n");
  assert.equal(lines[0], "Your judgment is needed: Goal csv-reviewed, attempt 2");
  assert.equal(lines[1], "Criterion readable: The change is clear enough to accept");
  assert.ok(lines.includes("Worker's note (untrusted): Changed b to 3."));
  assert.ok(lines.includes("Other checks in this attempt: tests-pass met (exit 0)"));
  assert.ok(lines.includes("  src/csv.mjs (+1 −1 lines)"));
  assert.ok(lines.includes("    -export const b = 2;") && lines.includes("    +export const b = 3;"), view.summary);
  assert.doesNotMatch(view.summary, /"hex"|6578706f7274/, "no hex in the readable part");
  assert.ok(view.details.includes(`Subject: ${JSON.stringify(subject)}`), "the exact captured bytes are in the full view");
  assert.match(view.details, /^Provenance: \{"taskId":"result"/m);
});

test("new, binary and long changes, and non-file subjects, stay readable", async () => {
  const long = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
  const view = await describeGoalJudgment(snapshot(candidate([
    file("new.txt", long),
    { path: "img.bin", value: { hex: "ff00fe", kind: "file" } },
  ])), {}, async () => undefined);
  assert.match(view.summary, /^Your judgment is needed: A Goal$/m);
  assert.match(view.summary, /^  new\.txt \(new file, 40 lines\)$/m);
  assert.match(view.summary, /^  img\.bin \(binary, 3 bytes\)$/m);
  assert.match(view.summary, new RegExp(`^    … \\d+ more lines \\(choose "${GOAL_JUDGE_SHOW}"\\)$`, "m"));
  assert.ok(view.details.includes("    +line 39"), "the full view has every line");
  const json = await describeGoalJudgment(snapshot({ result: { accepted: true, note: "ok" } }), {}, async () => undefined);
  assert.match(json.summary, /^The result to judge \(untrusted\):\n  \{\n    "result": \{/m);
  const narrow = await describeGoalJudgment(snapshot({ result: "x" }, "y".repeat(300)), {}, async () => undefined, 80);
  assert.ok(narrow.summary.split("\n").every(line => line.length <= 80));
});
