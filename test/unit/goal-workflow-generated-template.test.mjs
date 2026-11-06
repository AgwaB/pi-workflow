import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGoalPlannerPhaseTemplate,
  buildGoalWorkerPhaseTemplate,
  buildGoalWorkerRequest,
  goalInvocationRequest,
  reconstructGoalWorkerRequest,
} from "../../.tmp/unit/goal-workflow-generated-template.js";
import { parseGoalWorkflowSpec } from "../../.tmp/unit/goal-workflow-schema.js";
import { contractData } from "./helpers/goal-fixture.mjs";

function fixture(effects, paths) {
  const definition = parseGoalWorkflowSpec({
    schemaVersion: 1,
    defaults: { maxRuntimeMs: 12345 },
    goal: {
      objective: "Produce the captured child result",
      criteria: [{ id: "ready", verifier: {
        kind: "deterministic", producerId: "json-exact-value-v1", target: "artifact",
        subject: { artifact: "control", path: "$.result", resultSlot: "result" },
        config: { comparison: "canonical-json-equality", expected: { ready: true } },
      } }],
      authority: { allowedPaths: paths, protectedPaths: [], allowedEffects: effects },
      nesting: { maxDepth: 3 },
    },
  });
  const profile = contractData().profile;
  profile.roles.find(role => role.role === "research-execution").model = "fixture/worker";
  return { definition, profile, workerAgent: "goal-coder", workflows: [], hasChildren: false };
}


for (const [name, effects, paths] of [
  ["missing read", ["candidate-write", "verify"], ["input.txt"]],
  ["missing paths", ["candidate-write", "read", "verify"], []],
]) {
  test(`Goal canonical worker template rejects coding with ${name}`, () => {
    assert.throws(() => buildGoalWorkerPhaseTemplate(fixture(effects, paths)), /explicit scoped read admission/);
  });
}






test("Goal worker request reconstructs only its exact immutable prefix", () => {
  const { definition } = fixture(["read", "verify"], ["input.txt"]);
  const input = {
    definition, request: "원래 요청\n\"scope\"", id: "RESULT:Original",
    prompt: "advisory\nProposed work: misleading later marker",
  };
  definition.goal.criteria[0].verifier.subject.resultSlot = input.id;
  const built = buildGoalWorkerRequest(input);
  assert.deepEqual(reconstructGoalWorkerRequest({ ...input, candidatePrompt: built.prompt }), built);
  assert.throws(() => buildGoalWorkerRequest({ ...input, id: "foreign" }), /original resultSlot/);
  assert.throws(() => buildGoalWorkerRequest({ ...input, prompt: " \n\t " }), /non-blank proposed work/);
  assert.throws(() => reconstructGoalWorkerRequest({ ...input, id: "foreign", candidatePrompt: built.prompt }),
    /original resultSlot/);
  assert.throws(() => reconstructGoalWorkerRequest({ ...input, candidatePrompt: "Proposed work: advisory" }),
    /immutable Goal or original invocation scope/);
  assert.throws(() => reconstructGoalWorkerRequest({ ...input, request: "changed", candidatePrompt: built.prompt }),
    /immutable Goal or original invocation scope/);
  const changedDefinition = structuredClone(definition);
  changedDefinition.goal.objective = "changed objective";
  assert.throws(() => reconstructGoalWorkerRequest({ ...input, definition: changedDefinition, candidatePrompt: built.prompt }),
    /immutable Goal or original invocation scope/);
  assert.throws(() => reconstructGoalWorkerRequest({ ...input, candidatePrompt: built.prompt.replace(input.prompt, " \n") }),
    /blank advisory proposed work/);
});
