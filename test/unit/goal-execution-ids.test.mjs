import assert from "node:assert/strict";
import { test } from "node:test";
import { goalExecutionId, parseGoalWorkflowSpec } from "../../.tmp/unit/goal-workflow-schema.js";
import { sanitizeTaskId } from "../../.tmp/unit/engine-run-graph.js";

const definition = (criteria) => ({ schemaVersion: 1, name: "ids", goal: { objective: "x", criteria,
  authority: { allowedPaths: [], protectedPaths: [], allowedEffects: ["verify", "workflow-create"] } } });
const exact = (id, slot) => ({ id, verifier: { kind: "deterministic", producerId: "json-exact-value-v1", target: "artifact",
  subject: { resultSlot: slot, artifact: "control", path: "$.result" }, config: { comparison: "canonical-json-equality", expected: true } } });

test("Goal execution identities mirror generated task identities", () => {
  for (const id of ["Result", "a:b", "x.y_z-1", "--edge--", "Ünicode", "A".repeat(80)])
    assert.equal(goalExecutionId(id), sanitizeTaskId(id), id);
});

test("IDs that collide once normalized are refused before any request", () => {
  assert.doesNotThrow(() => parseGoalWorkflowSpec(definition([exact("first", "result"), exact("second", "result")])),
    "several criteria may share one slot");
  assert.throws(() => parseGoalWorkflowSpec(definition([exact("one", "A"), exact("two", "a")])),
    /collides with "A" once lowercased/);
  assert.throws(() => parseGoalWorkflowSpec(definition([exact("x:1", "result"), exact("x-1", "result")])),
    /collides with "x:1"/);
  for (const slot of ["controller", "planner", "verify.tests", "generation1.planner", "Generation2"])
    assert.throws(() => parseGoalWorkflowSpec(definition([exact("c", slot)])), /reserved for Goal planner\/verifier/, slot);
  assert.throws(() => parseGoalWorkflowSpec(definition([exact("c".repeat(43), "result")])), /at most 42 characters/);
  assert.throws(() => parseGoalWorkflowSpec(definition([exact("c", "s".repeat(50))])), /at most 49 characters/);
  assert.throws(() => parseGoalWorkflowSpec(definition([exact("---", "result")])), /letter or number/);
});

test("limits.generations is an optional integer from 1 to 100, defaulting to 10", async () => {
  const { goalGenerationLimit } = await import("../../.tmp/unit/goal-workflow-schema.js");
  const withLimits = limits => {
    const base = definition([exact("c", "result")]);
    return limits === undefined ? base : { ...base, goal: { ...base.goal, limits } };
  };
  assert.equal(goalGenerationLimit(parseGoalWorkflowSpec(withLimits(undefined))), 10);
  assert.equal(goalGenerationLimit(parseGoalWorkflowSpec(withLimits({ generations: 1 }))), 1);
  assert.equal(goalGenerationLimit(parseGoalWorkflowSpec(withLimits({ generations: 100, requests: null }))), 100);
  for (const generations of [0, 101, 1.5, null, "3"])
    assert.throws(() => parseGoalWorkflowSpec(withLimits({ generations })), /generations: must be an integer from 1 to 100/, String(generations));
});
