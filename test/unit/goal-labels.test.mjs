import assert from "node:assert/strict";
import { test } from "node:test";
import { goalStageLabel, goalTaskLabel, goalTaskLabels } from "../../.tmp/unit/goal-labels.js";

const task = (specId, stageId, extra = {}) => ({ specId, stageId, ...extra });
const run = { tasks: [
  task("goal.$rootPlanner.main", "goal.$rootPlanner"),
  task("goal.main", "goal", { kind: "goal", goalRoot: { generations: [
    { generation: 0, plannerSpecId: "goal.$rootPlanner.main", slots: { result: "goal.result" }, verifiers: { quality: "goal.verify.quality" } },
    { generation: 1, plannerSpecId: "goal.generation1.planner", slots: { result: "goal.generation1.result" },
      verifiers: { quality: "goal.generation1.verify.quality" } },
  ] } }),
  task("goal.result", "goal"), task("goal.verify.quality", "goal"),
  task("goal.generation1.planner", "goal"), task("goal.generation1.result", "goal"), task("goal.generation1.verify.quality", "goal"),
] };

test("Goal tasks read as what they do and in which attempt", () => {
  assert.deepEqual(Object.fromEntries(goalTaskLabels(run)), {
    "goal.main": "Goal controller",
    "goal.$rootPlanner.main": "Plan · attempt 1",
    "goal.result": "Work: result · attempt 1",
    "goal.verify.quality": "Check: quality · attempt 1",
    "goal.generation1.planner": "Re-plan · attempt 2",
    "goal.generation1.result": "Work: result · attempt 2",
    "goal.generation1.verify.quality": "Check: quality · attempt 2",
  });
  assert.equal(goalStageLabel(run, "goal.$rootPlanner"), "Goal: first plan");
  assert.equal(goalStageLabel(run, "goal"), "Goal: attempts and checks");
  assert.equal(goalTaskLabel(run, { specId: "other" }), undefined);
  const before = { tasks: [task("goal.$rootPlanner.main", "goal.$rootPlanner"), task("goal.main", "goal", { kind: "goal" })] };
  assert.equal(goalTaskLabel(before, { specId: "goal.$rootPlanner.main" }), "Plan · attempt 1", "before any attempt is recorded");
  const embedded = { tasks: [task("build.main", "build"), task("fix.$rootPlanner.main", "fix.$rootPlanner"), task("fix.main", "fix", { kind: "goal" })] };
  assert.equal(goalTaskLabel(embedded, { specId: "build.main" }), undefined, "ordinary stages keep their authored names");
  assert.equal(goalStageLabel(embedded, "build"), undefined);
  assert.equal(goalStageLabel(embedded, "fix.$rootPlanner"), "Goal: first plan");
  assert.equal(goalTaskLabel({ tasks: [task("a", "s")] }, { specId: "a" }), undefined, "non-Goal runs are untouched");
});
