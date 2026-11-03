import assert from "node:assert/strict";
import { test } from "node:test";
import { goalOracleOutcome, goalRubricVerdict } from "../../.tmp/unit/goal-workflow-runtime.js";

test("UNKNOWN dominates, pending human judgment waits, and only all-met achieves", () => {
  const cases = [
    [["met", "met"], { unknown: false, waitingUser: false, met: true }],
    [["met", "not-met"], { unknown: false, waitingUser: false, met: false }],
    [["met", "pending"], { unknown: false, waitingUser: true, met: false }],
    // A pending human judgment never compensates for a deterministic failure:
    // after the judgment the not-met criterion still blocks achievement.
    [["not-met", "pending"], { unknown: false, waitingUser: true, met: false }],
    [["unknown", "pending"], { unknown: true, waitingUser: false, met: false }],
    [["unknown", "met"], { unknown: true, waitingUser: false, met: false }],
    [["met", "met", "unknown"], { unknown: true, waitingUser: false, met: false }],
    [[], { unknown: false, waitingUser: false, met: false }],
  ];
  for (const [verdicts, expected] of cases)
    assert.deepEqual(goalOracleOutcome(verdicts), expected, JSON.stringify(verdicts));
});

test("rubric verdict boundaries and malformed results", () => {
  const result = score => ({ schema: "dynamic-task-result-v1", digest: "judged", score, reason: "because" });
  assert.equal(goalRubricVerdict(result(1), 1), "met", "full score at the strictest minimum");
  assert.equal(goalRubricVerdict(result(0.75), 0.75), "met", "exactly the minimum is met");
  assert.equal(goalRubricVerdict(result(0.7499999), 0.75), "not-met", "just below the minimum");
  assert.equal(goalRubricVerdict(result(0), 0), "met", "a zero minimum accepts a zero score");
  assert.equal(goalRubricVerdict(result(0.9999), 1), "not-met");
  for (const [label, value] of [
    ["above one", result(1.0001)], ["negative", result(-0.1)], ["NaN", result(Number.NaN)],
    ["infinite", result(Number.POSITIVE_INFINITY)], ["string score", result("1")], ["null", null], ["array", []],
    ["missing reason", { schema: "dynamic-task-result-v1", digest: "d", score: 1 }],
    ["extra key", { ...result(1), extra: true }], ["wrong schema", { ...result(1), schema: "other" }],
    ["blank digest", { ...result(1), digest: "  " }], ["blank reason", { ...result(1), reason: "" }],
    ["long reason", { ...result(1), reason: "r".repeat(4097) }], ["long digest", { ...result(1), digest: "d".repeat(1001) }],
  ]) assert.throws(() => goalRubricVerdict(value, 0.5), /Goal rubric malformed or foreign result/, label);
});
