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

for (const [name, effects, paths, tools] of [
  ["source-free", ["read", "verify"], [], []],
  ["read-only", ["read", "verify"], ["input.txt"], ["goal_candidate_read"]],
  ["candidate-write", ["read", "verify", "candidate-write"], ["input.txt"], ["goal_candidate_read", "goal_candidate_write"]],
]) {
  test(`Goal canonical worker template preserves ${name} tool capability`, () => {
    const input = fixture(effects, paths);
    const before = structuredClone(input);
    const dynamic = buildGoalWorkerPhaseTemplate(input);
    assert.deepEqual(dynamic.decisionLoop.workerDefaults.tools, tools);
    assert.deepEqual(dynamic.decisionLoop.allowedTools, tools);
    assert.deepEqual(Object.keys(dynamic.decisionLoop.workerDefaults.toolProviders ?? {}), tools);
    for (const tool of tools) assert.equal(dynamic.decisionLoop.workerDefaults.toolProviders[tool].classification,
      tool === "goal_candidate_read" ? "read-only" : "write-capable");
    assert.equal(dynamic.decisionLoop.workerDefaults.model, "fixture/worker");
    assert.deepEqual(input, before);
  });
}

for (const [name, effects, paths] of [
  ["missing read", ["candidate-write", "verify"], ["input.txt"]],
  ["missing paths", ["candidate-write", "read", "verify"], []],
]) {
  test(`Goal canonical worker template rejects coding with ${name}`, () => {
    assert.throws(() => buildGoalWorkerPhaseTemplate(fixture(effects, paths)), /explicit scoped read admission/);
  });
}

test("Goal canonical worker template binds distinct result slots and selected child depth", () => {
  const input = fixture(["read", "verify", "workflow-create"], []);
  const duplicate = structuredClone(input.definition.goal.criteria[0]);
  duplicate.id = "same-slot";
  const other = structuredClone(duplicate);
  other.id = "second-slot";
  other.verifier.subject.resultSlot = "second";
  input.definition.goal.criteria.push(duplicate, other);
  input.workflows = [{ id: "child", uses: "./child.json" }];
  const direct = buildGoalWorkerPhaseTemplate(input);
  const nested = buildGoalWorkerPhaseTemplate({ ...input, hasChildren: true });
  assert.equal(direct.budget.maxAgents, 2);
  assert.equal(direct.budget.maxGraphMutations, 2);
  assert.equal(direct.decisionLoop.maxActionsPerRound, 2);
  assert.equal(direct.budget.maxRuntimeMs, 12345);
  assert.equal(direct.budget.maxNestedWorkflowDepth, 0);
  assert.equal(nested.budget.maxNestedWorkflowDepth, 3);
  assert.deepEqual(nested.workflows, { child: { uses: "./child.json" } });
  nested.workflows.child.uses = "changed";
  assert.equal(input.workflows[0].uses, "./child.json");
});

test("Goal canonical planner template preserves immutable detached construction data", () => {
  const { definition, profile } = fixture(["read", "verify", "candidate-write"], ["input.txt"]);
  const planning = profile.roles.find(role => role.role === "planning");
  planning.model = "fixture/planner";
  planning.thinking = "high";
  definition.goal.criteria[0].verifier.subject.resultSlot = "ANSWER";
  const normalizedLooking = structuredClone(definition.goal.criteria[0]);
  normalizedLooking.id = "original-colon-slot";
  normalizedLooking.verifier.subject.resultSlot = "answer:one";
  definition.goal.criteria.push(normalizedLooking);
  const duplicate = structuredClone(definition.goal.criteria[0]);
  duplicate.id = "same-original-slot";
  definition.goal.criteria.push(duplicate);
  definition.goal.workflows = { "declared-child": { uses: "./declared-child.json" } };
  const snapshot = {
    executionFoundation: "original-owner-captured-data",
    request: "Original owner request",
    definition,
    profile,
    profileProposal: { revision: "captured-only" },
    workflows: [{
      id: "admitted-child",
      sourcePath: "/private/source/child.json",
      sourceBytesHex: "deadbeef",
    }],
    remainingDepth: 2,
    exclusions: ["source-paths"],
  };
  const before = structuredClone(snapshot);
  const compiled = buildGoalPlannerPhaseTemplate({ snapshot, plannerId: "original.$rootPlanner" });
  const stage = compiled.artifactGraph.stages[0];
  const advisory = JSON.parse(stage.prompt.split("\n\n").at(-1).slice("Immutable admitted Goal: ".length));

  assert.deepEqual(snapshot, before);
  assert.deepEqual(stage.output, { analysis: { required: true }, refs: { required: true } });
  assert.deepEqual([stage.id, stage.agent, stage.profileRole, stage.model, stage.thinking, stage.maxRuntimeMs],
    ["original.$rootPlanner", "researcher", "planning", "fixture/planner", "high", 12345]);
  assert.match(stage.prompt, /exact immutable original resultSlot IDs are \["ANSWER","answer:one"\]/);
  assert.match(stage.prompt, /Admitted workflow IDs: \["admitted-child"\]/);
  assert.equal(stage.prompt.includes("/private/source/child.json"), false);
  assert.equal(stage.prompt.includes("deadbeef"), false);
  assert.equal(advisory.workflows, undefined);
  assert.equal(advisory.definition.goal.workflows, undefined);
  assert.equal(advisory.executionFoundation, "original-owner-captured-data");
  assert.equal(advisory.request, "Original owner request");
  assert.deepEqual(advisory.profileProposal, { revision: "captured-only" });
  assert.deepEqual([advisory.remainingDepth, advisory.exclusions], [2, ["source-paths"]]);
  assert.equal(advisory.definition.goal.objective, before.definition.goal.objective);
});

test("Goal canonical planner template keeps caller data detached from output", () => {
  const { definition, profile } = fixture(["read", "verify"], []);
  const snapshot = {
    request: "captured request",
    definition,
    profile,
    workflows: [],
    remainingDepth: 1,
    exclusions: [],
  };
  const compiled = buildGoalPlannerPhaseTemplate({ snapshot, plannerId: "captured.$rootPlanner" });
  const prompt = compiled.artifactGraph.stages[0].prompt;
  snapshot.request = "changed caller request";
  snapshot.workflows.push({ id: "later-child" });
  definition.goal.objective = "changed caller goal";
  assert.equal(compiled.artifactGraph.stages[0].prompt, prompt);
  assert.match(prompt, /captured request/);
  assert.doesNotMatch(prompt, /later-child|changed caller/);
});

test("Goal worker request preserves source-free, read-only, and coding capabilities", () => {
  for (const [name, effects, paths, readOnly] of [
    ["source-free", ["read", "verify"], [], true],
    ["read-only", ["read", "verify"], ["input.txt"], true],
    ["coding", ["read", "verify", "candidate-write"], ["input.txt"], false],
  ]) {
    const { definition } = fixture(effects, paths);
    const request = buildGoalWorkerRequest({
      definition, request: "完成「原始」目标\nwith \"quotes\"", id: "result", prompt: `  ${name} proposal  `,
    });
    assert.equal(request.id, "result");
    assert.equal(request.readOnly, readOnly);
    assert.equal(request.profile, "worker");
    assert.deepEqual([request.inputs, request.requiredReads, request.compact], [[], [], false]);
    assert.match(request.prompt, /Immutable Goal: /);
    assert.match(request.prompt, /Host-owned invocation scope .*完成「原始」目标\\nwith \\"quotes\\"/);
    assert.equal(request.prompt.endsWith(`Proposed work:   ${name} proposal  `), true);
  }
});

test("Goal invocation request trims distinct targets but preserves objective-equal requests", () => {
  const { definition } = fixture(["read", "verify"], []);
  assert.equal(goalInvocationRequest(definition, undefined), definition.goal.objective);
  assert.equal(goalInvocationRequest(definition, `  ${definition.goal.objective} \n`), definition.goal.objective);
  assert.equal(goalInvocationRequest(definition, "  조사\n\"quoted\"  "),
    `${definition.goal.objective}\n\nTarget: 조사\n\"quoted\"`);
});

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
