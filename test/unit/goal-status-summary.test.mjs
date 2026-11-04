import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeOrdinaryWorkflowGoal } from "../../.tmp/unit/goal-workflow-commands.js";

const criterion = id => ({ id, verifier: { kind: "deterministic" } });
function status({ runStatus = "completed", state = "engine:achieved", taskStatus = "completed", statusDetail = "goal_achieved",
  message = null, verdicts = ["met"], originApply = null, recoveredBy = null, currentWork = [], generation = 1,
  liveInSession = false } = {}) {
  return { runId: "workflow_s", runStatus, observedUsage: { totalTokens: 1200, costUsd: 0.001, tasksReporting: 3, taskCount: 3 },
    recovery: null, recoveredBy, currentWork, liveInSession,
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
    "Working tree: applied src/csv.mjs",
    "Used: attempts 2 · requests 8 · cost $0.0030",
    "Tokens: 1200",
  ].join("\n"), "an achieved Goal needs no next step");
});

test("partial application, failure and judgment each name the next step", () => {
  const partial = summarizeOrdinaryWorkflowGoal(status({ originApply: { status: "conflict",
    paths: [{ path: "a.ts", state: "applied" }, { path: "b.ts", state: "conflict" }] } }));
  assert.match(partial, /^Working tree: conflict — a\.ts \[applied\], b\.ts \[conflict\]$/m);
  const failed = summarizeOrdinaryWorkflowGoal(status({ runStatus: "failed", state: "engine:not-achieved", taskStatus: "failed",
    statusDetail: "launch_failed", message: "Root replan exhausted: generation limit (3) reached", verdicts: ["not-met", "met"], generation: 2 }));
  assert.match(failed, /^Goal csv-parser \(workflow_s\) — not achieved$/m);
  assert.match(failed, /^Criteria: 1 of 2 met, 1 not met$/m);
  assert.match(failed, /^  ✗ c1 — not met \(exit 1\): exit 1: 3 tests failed$/m);
  assert.match(failed, /^Why: Root replan exhausted: generation limit \(3\) reached$/m);
  assert.match(failed, /^Next: more attempts: raise limits\.generations in the definition and run it again$/m,
    "a used-up attempt limit cannot be recovered");
  assert.doesNotMatch(summarizeOrdinaryWorkflowGoal(status({ runStatus: "failed", state: "x", taskStatus: "failed",
    verdicts: ["not-met"], recoveredBy: "workflow_next" })), /continue:/, "a recovered run points to its successor instead");
  const judging = summarizeOrdinaryWorkflowGoal(status({ runStatus: "running", state: "engine:pending", taskStatus: "blocked",
    statusDetail: "goal_waiting_user", verdicts: ["met", "pending"], currentWork: [{ specId: "goal.main", status: "blocked" }] }));
  assert.match(judging, / — waiting for your judgment$/m);
  assert.match(judging, /^Criteria: 1 of 2 met, 1 waiting for your judgment$/m);
  assert.match(judging, /^  … c2 — waiting for your judgment$/m);
  assert.match(judging, /^Next: judge: \/workflow goal judge workflow_s$/m);
  assert.doesNotMatch(judging, /^Why:/m);
});

test("the report tells what each attempt did and how much changed", () => {
  const data = status({ originApply: { status: "applied", paths: [{ path: "src/csv.mjs", state: "applied" }] } });
  data.policies[0].changeStats = { "src/csv.mjs": { added: 38, removed: 2 } };
  data.policies[0].attempts = [
    { attempt: 1, criteria: [{ id: "tests-pass", verdict: "not-met", exitCode: 1, failed: ['" a , b "', 'ab"c,d'],
      summary: "tests 12, pass 10, fail 2" }], notes: [{ slot: "result", note: "Implemented quoted fields and escaped quotes." }] },
    { attempt: 2, criteria: [{ id: "tests-pass", verdict: "met", exitCode: 0, failed: [], summary: "tests 12, pass 12, fail 0" }],
      notes: [{ slot: "result", note: "Added per-field quote tracking." }] },
  ];
  const report = summarizeOrdinaryWorkflowGoal(data).split("\n");
  const start = report.indexOf("What happened:");
  assert.deepEqual(report.slice(start, start + 6), [
    "What happened:",
    '  Attempt 1: tests-pass not met (exit 1) — failed: " a , b ", ab"c,d · tests 12, pass 10, fail 2',
    "    Worker: Implemented quoted fields and escaped quotes.",
    "  Attempt 2: tests-pass met (exit 0) — tests 12, pass 12, fail 0",
    "    Worker: Added per-field quote tracking.",
    "Working tree: applied src/csv.mjs (+38 −2 lines)",
  ]);
});

test("a stopped Goal continues with resume in its own session and with recover after it", () => {
  const stopped = live => summarizeOrdinaryWorkflowGoal(status({ runStatus: "interrupted", state: "engine:unknown",
    taskStatus: "interrupted", statusDetail: "workflow_stopped", message: "Workflow stopped by user request",
    verdicts: ["unknown"], liveInSession: live }));
  assert.match(stopped(true), /^Next: continue: \/workflow goal resume workflow_s$/m);
  assert.match(stopped(false), /^Next: continue: \/workflow goal recover workflow_s$/m);
  const exhausted = summarizeOrdinaryWorkflowGoal(status({ runStatus: "failed", state: "engine:not-achieved", taskStatus: "failed",
    statusDetail: "launch_failed", message: "Root replan exhausted: unchanged failed candidate", verdicts: ["not-met"],
    liveInSession: true }));
  assert.match(exhausted, /^Next: continue: \/workflow goal recover workflow_s$/m,
    "a finished run cannot resume even in its own session");
});

test("list shows one readable line per Goal run", async () => {
  const { summarizeOrdinaryWorkflowGoalLine, goalControlMessage } = await import("../../.tmp/unit/goal-workflow-commands.js");
  const line = summarizeOrdinaryWorkflowGoalLine({ ...status({ verdicts: ["met", "met"] }), updatedAt: "2026-11-04T02:36:22.000Z" });
  assert.match(line, /^csv-parser — achieved · 2\/2 criteria met · 2 attempts · \d\d\/\d\d \d\d:\d\d · workflow_s$/);
  const stopped = summarizeOrdinaryWorkflowGoalLine(status({ runStatus: "interrupted", state: "engine:unknown",
    statusDetail: "workflow_stopped", verdicts: ["unknown"], generation: 0 }));
  assert.equal(stopped, "csv-parser — stopped before finishing · 0/1 criteria met · 1 attempt · workflow_s");
  // pause and cancel are the same stop; the reply says how to continue.
  const run = { runId: "workflow_s", name: "csv-parser" };
  assert.equal(goalControlMessage("cancel", { ...run, status: "interrupted" }), goalControlMessage("pause", { ...run, status: "interrupted" }));
  assert.match(goalControlMessage("pause", { ...run, status: "interrupted" }),
    /^Goal csv-parser \(workflow_s\) stopped\. Nothing more is applied to your files\. To continue: \/workflow goal resume workflow_s in this Pi session, or \/workflow goal recover workflow_s after restarting Pi\.$/);
  assert.equal(goalControlMessage("resume", { ...run, status: "running" }), "Goal csv-parser (workflow_s) resumed.");
  assert.doesNotMatch(goalControlMessage("pause", { ...run, status: "running" }), /admission|origin/);
});
