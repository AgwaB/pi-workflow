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
