import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeOrdinaryWorkflowGoal } from "../../.tmp/unit/goal-workflow-commands.js";

const criterion = id => ({ id, verifier: { kind: "deterministic" } });
function status({ runStatus = "completed", state = "engine:achieved", taskStatus = "completed", statusDetail = "goal_achieved",
  message = null, verdicts = ["met"], originApply = null, recoveredBy = null, currentWork = [], generation = 1 } = {}) {
  return { runId: "workflow_s", runStatus, observedUsage: { totalTokens: 1200, costUsd: 0.001, tasksReporting: 3, taskCount: 3 },
    recovery: null, recoveredBy, currentWork,
    policies: [{ goalId: "goal_engine_x", state, taskStatus, statusDetail, importantFailureOrUnknown: message, generation,
      usage: { requests: 8, costMicros: 3000 }, originApply, originalDefinition: { name: "csv-parser" },
      criteria: verdicts.map((verdict, index) => ({ criterion: criterion(`c${index + 1}`), verdict,
        reason: verdict === "not-met" ? "exit 1: 3 tests failed" : null,
        ...(index === 0 ? { command: { exitCode: verdict === "met" ? 0 : 1, signal: null, timedOut: false } } : {}) })) }] };
}

test("an achieved, applied Goal reads as one short report", () => {
  assert.equal(summarizeOrdinaryWorkflowGoal(status({
    originApply: { status: "applied", paths: [{ path: "src/csv.mjs", state: "applied" }] } })), [
    "Goal csv-parser (workflow_s) — achieved",
    "Criteria: 1 of 1 met",
    "  ✓ c1 — met (exit 0)",
    "Used: attempts 2 · requests 8 · cost $0.0030",
    "Working tree: applied src/csv.mjs",
    "Tokens: 1200",
    "Next: details: /workflow goal criteria|evidence workflow_s",
  ].join("\n"));
});

test("partial application, failure and judgment each name the next step", () => {
  const partial = summarizeOrdinaryWorkflowGoal(status({ originApply: { status: "conflict",
    paths: [{ path: "a.ts", state: "applied" }, { path: "b.ts", state: "conflict" }] } }));
  assert.match(partial, /^Working tree: conflict — a\.ts \(applied\), b\.ts \(conflict\)$/m);
  const failed = summarizeOrdinaryWorkflowGoal(status({ runStatus: "failed", state: "engine:not-achieved", taskStatus: "failed",
    statusDetail: "launch_failed", message: "Root replan exhausted: generation limit (3) reached", verdicts: ["not-met", "met"], generation: 2 }));
  assert.match(failed, /^Goal csv-parser \(workflow_s\) — not achieved$/m);
  assert.match(failed, /^Criteria: 1 of 2 met, 1 not met$/m);
  assert.match(failed, /^  ✗ c1 — not met \(exit 1\): exit 1: 3 tests failed$/m);
  assert.match(failed, /^Why: Root replan exhausted: generation limit \(3\) reached$/m);
  assert.match(failed, /^Next: continue: \/workflow goal recover workflow_s · details: /m);
  assert.doesNotMatch(summarizeOrdinaryWorkflowGoal(status({ runStatus: "failed", state: "x", taskStatus: "failed",
    verdicts: ["not-met"], recoveredBy: "workflow_next" })), /continue:/, "a recovered run points to its successor instead");
  const judging = summarizeOrdinaryWorkflowGoal(status({ runStatus: "running", state: "engine:pending", taskStatus: "blocked",
    statusDetail: "goal_waiting_user", verdicts: ["met", "pending"], currentWork: [{ specId: "goal.main", status: "blocked" }] }));
  assert.match(judging, / — waiting for your judgment$/m);
  assert.match(judging, /^Criteria: 1 of 2 met, 1 waiting for your judgment$/m);
  assert.match(judging, /^  … c2 — waiting for your judgment$/m);
  assert.match(judging, /^Next: judge: \/workflow goal judge workflow_s · /m);
  assert.doesNotMatch(judging, /^Why:/m);
});
