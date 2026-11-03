import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeGoalProgress } from "../../.tmp/unit/goal-progress.js";

const task = (specId, status, extra = {}) => ({ taskId: specId, specId, status, ...extra });
function goalRun({ generations, running = [], detail = "goal_policy_running", status = "running", recovered } = {}) {
  const root = task("goal.main", status, { kind: "goal", statusDetail: detail,
    ...(generations ? { goalRoot: { definitionFingerprint: "x", generations } } : {}) });
  const others = ["goal.$rootPlanner.main", "goal.planner1", "goal.result", "goal.verify.tests"]
    .map(id => task(id, running.includes(id) ? "running" : "completed",
      id === "goal.$rootPlanner.main" ? { stageId: "goal.$rootPlanner" } : {}));
  return { runId: "workflow_g", status: "running", tasks: [root, ...others],
    ...(recovered ? { goalRecovery: { fromRunId: "workflow_old", priorGenerations: recovered } } : {}) };
}
const generation = (n, plannerSpecId) => ({ generation: n, plannerSpecId, workerControllerSpecId: "w",
  slots: { result: "goal.result" }, verifiers: { tests: "goal.verify.tests" } });

test("Goal progress names the phase from the latest attempt's running task", () => {
  assert.deepEqual(summarizeGoalProgress(goalRun({ running: ["goal.$rootPlanner.main"] })), { attempt: 1, phase: "planning" });
  const first = [generation(0, "goal.$rootPlanner.main")];
  assert.deepEqual(summarizeGoalProgress(goalRun({ generations: first, running: ["goal.result"] })), { attempt: 1, phase: "working" });
  assert.deepEqual(summarizeGoalProgress(goalRun({ generations: first, running: ["goal.verify.tests"] })), { attempt: 1, phase: "verifying" });
  assert.deepEqual(summarizeGoalProgress(goalRun({ generations: first })), { attempt: 1, phase: "checking" });
  const second = [...first, generation(1, "goal.planner1")];
  assert.deepEqual(summarizeGoalProgress(goalRun({ generations: second, running: ["goal.planner1"] })), { attempt: 2, phase: "planning" });
  assert.deepEqual(summarizeGoalProgress(goalRun({ generations: first, detail: "goal_waiting_user" })),
    { attempt: 1, phase: "waiting for your judgment" });
  assert.deepEqual(summarizeGoalProgress(goalRun({ generations: second, recovered: 3, running: ["goal.result"] })),
    { attempt: 5, phase: "working" }, "a recovered run counts the attempts it continues");
  assert.equal(summarizeGoalProgress({ runId: "w", status: "running", tasks: [task("main", "running")] }), undefined);
  assert.equal(summarizeGoalProgress({ ...goalRun(), parentRunId: "workflow_parent" }), undefined, "child runs are not shown");
});
