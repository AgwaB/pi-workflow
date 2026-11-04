import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatGoalExecutionDetails,
  formatGoalExecutionConsent,
  formatGoalProfileExceptionConsent,
  isGoalProfileExceptionPreview,
} from "../../.tmp/unit/goal-consent-summary.js";

const rubric = (id, instruction) => ({ id, verifier: { kind: "model-rubric", producerId: "json-control-rubric-v1",
  target: "artifact", subject: { resultSlot: "result", artifact: "control", path: "$.candidate.files[0].value.hex" },
  config: { rubric: { instruction }, minScore: 1 } } });

function preview(overrides = {}) {
  return {
    executionFoundation: "workflow-engine",
    request: "Make parseCsvLine parse one CSV record.\n\nTarget: Implement the parser described by the Goal.",
    definition: { schemaVersion: 1, name: "csv-parser", defaults: { fast: "on" }, goal: {
      objective: "Make parseCsvLine(line) in src/csv.mjs parse one CSV record (RFC 4180 style) ".repeat(6),
      criteria: [
        { id: "tests-pass", verifier: { kind: "deterministic", producerId: "command-exit-v1", target: "candidate",
          subject: { resultSlot: "result", artifact: "control" }, config: { argv: ["node", "--test", "test/csv.test.mjs"], timeoutMs: 60000 } } },
        rubric("quality", "Score 1 only if the code is readable and handles quotes."),
        { id: "owner", verifier: { kind: "human", producerId: "owner-approval-v1", target: "artifact",
          subject: { resultSlot: "result", artifact: "control" }, config: { condition: { approval: "Owner signs off" } } } },
        { id: "exact", verifier: { kind: "deterministic", producerId: "json-exact-value-v1", target: "artifact",
          subject: { resultSlot: "summary", artifact: "control", path: "$.result" },
          config: { comparison: "canonical-json-equality", expected: { ok: true } } } },
      ],
      authority: { allowedPaths: ["src/csv.mjs"], protectedPaths: ["PROTECTED.md", "test/csv.test.mjs"],
        allowedEffects: ["read", "candidate-write", "verify", "origin-apply", "workflow-create"] },
      limits: { requests: 40 },
    } },
    profile: { roles: ["planning", "research-execution", "synthesis", "verification", "final-judgment"]
      .map(role => ({ role, model: "openai-codex/gpt-6-luna", thinking: "medium" })) },
    workflows: [{ id: "explain", definition: { goal: {} } }, { id: "lint", definition: { artifactGraph: {} } }],
    generationLimit: 10,
    ...overrides,
  };
}

test("the execution consent fits on one screen and names what the Goal may do", () => {
  const summary = formatGoalExecutionConsent(preview());
  const lines = summary.split("\n");
  assert.ok(lines.length <= 30, summary);
  assert.ok(lines.every(line => line.length <= 160), summary);
  assert.match(summary, /^Goal: csv-parser$/m);
  assert.match(summary, /^Objective \(saved in the definition\): Make parseCsvLine/m);
  assert.ok(lines.filter(line => /^ {37}\S/.test(line)).length <= 2, "objective is at most three lines");
  assert.match(summary, /^This run \(your request\): Implement the parser described by the Goal\.$/m);
  assert.match(summary, /^Done when all 4 criteria hold:$/m);
  assert.match(summary, /• tests-pass — command passes: node --test test\/csv\.test\.mjs \(timeout 60s\)/);
  assert.match(summary, /• quality — model rubric, min score 1: Score 1 only if the code is readable/);
  assert.match(summary, /• owner — your judgment: Owner signs off/);
  assert.match(summary, /• exact \[summary\] — exact value at \$\.result = \{"ok":true\}/);
  assert.match(summary, /^May change: src\/csv\.mjs$/m);
  assert.match(summary, /^Protected: PROTECTED\.md, test\/csv\.test\.mjs$/m);
  assert.match(summary, /^Allowed: read, write in a separate candidate copy, verify, apply verified changes to your working tree, run declared child workflows$/m);
  assert.match(summary, /^Child workflows: explain \(Goal\), lint \(workflow\)$/m);
  assert.match(summary, /^Models: all roles openai-codex\/gpt-6-luna · medium$/m);
  assert.match(summary, /^Requests: 40 · cost: no cap · attempts \(plan \+ replans\): 10 · Fast: on \(priority tier\)$/m);
  assert.match(summary, /without asking again\.$/);
});

test("the execution consent states candidate-only results, mixed models, recovery and many criteria", () => {
  const base = preview();
  const goal = { ...base.definition.goal,
    criteria: Array.from({ length: 9 }, (_, index) => rubric(`c${index}`, "x")),
    authority: { allowedPaths: [], protectedPaths: [], allowedEffects: ["read", "candidate-write", "verify"] },
    limits: undefined };
  const summary = formatGoalExecutionConsent(preview({
    definition: { name: "mixed", goal },
    profile: { roles: [{ role: "planning", model: "a/x", thinking: "high" }, { role: "verification", model: "b/y", thinking: "low" }] },
    workflows: [],
    recovery: { fromRunId: "workflow_old", priorRequests: 7, priorGenerations: 2, carriedCandidate: ["src/a.ts"] },
  }));
  assert.match(summary, /^  … and 3 more \(see full details\)$/m);
  assert.match(summary, /^Allowed: read, write in a separate candidate copy, verify$/m, "no child workflows, no child effect");
  assert.match(summary, /^May change: nothing \(no file paths\)$/m);
  assert.match(summary, /^Results stay in the candidate copy; your working tree is not changed\.$/m);
  assert.match(summary, /^Models: planning a\/x · high; verification b\/y · low$/m);
  assert.match(summary, /^Requests: no cap · cost: no cap · attempts \(plan \+ replans\): 10$/m);
  assert.match(summary, /^Recovers workflow_old: counts its 2 attempt\(s\) and 7 request\(s\); starts from its last candidate \(src\/a\.ts\)\.$/m);
  assert.doesNotMatch(summary, /Child workflows|Fast/);
  const reset = formatGoalExecutionConsent(preview({ recovery: { fromRunId: "w", priorRequests: 1, priorGenerations: 1,
    carriedCandidate: [], candidateNotCarried: "the origin changed" } }));
  assert.match(reset, /starts from the working tree \(the origin changed\)\./);
  assert.match(formatGoalExecutionConsent({}), /could not be summarized; open the full details/);
});

test("the profile exception consent names the task, the runtime change and the reason", () => {
  const exception = { schema: "workflow-goal-profile-exception-preview-v1", runId: "workflow_r",
    target: { template: "goal.result", materializedTaskId: "task-4" }, scope: { role: "verification" },
    reason: "needs  a stronger\nverifier", oldRuntime: { model: "a/x", thinking: "low" }, newRuntime: { model: "a/y", thinking: "high" } };
  assert.equal(isGoalProfileExceptionPreview(exception), true);
  assert.equal(isGoalProfileExceptionPreview(preview()), false);
  assert.equal(formatGoalProfileExceptionConsent(exception), [
    "Run: workflow_r",
    "Task: task-4 (verification)",
    "Change: a/x · low → a/y · high",
    "Reason: needs a stronger verifier",
    "Only this task changes; saved profiles, other tasks and shared limits stay as they are.",
  ].join("\n"));
});

test("a single criterion reads naturally and child-workflow effects need declared children", () => {
  const base = preview();
  const summary = formatGoalExecutionConsent(preview({
    definition: { ...base.definition, goal: { ...base.definition.goal, criteria: [base.definition.goal.criteria[0]] } },
    workflows: [] }));
  assert.match(summary, /^Done when this criterion holds:$/m);
  assert.doesNotMatch(summary, /run declared child workflows/);
});

test("full details explain every part in plain language and end with the exact bound preview", () => {
  const value = preview({ exclusions: ["deployment", "arbitrary-commands", "cost-accounting"],
    profile: { name: "captured", roles: [{ role: "planning", model: "openai-codex/gpt-6.1-sol", thinking: "xhigh" },
      { role: "verification", model: "openai-codex/gpt-6-luna", thinking: "high" }] },
    workflows: [{ id: "explain", uses: "./explain.json", definition: { name: "explain", goal: { objective: "Explain unknown outcomes." } } }],
    recovery: { fromRunId: "workflow_old", priorRequests: 3, priorGenerations: 1, carriedCandidate: [], feedbackCriteria: ["tests-pass: not-met"] } });
  const details = formatGoalExecutionDetails(value);
  const [readable, raw] = details.split("Exact preview this consent is bound to (JSON)\n");
  assert.deepEqual(JSON.parse(raw), value, "the exact preview follows unchanged");
  assert.doesNotMatch(readable, /"executionFoundation"|"profileProposal"/);
  for (const expected of [
    /^Objective \(saved in the definition\)$/m,
    /^This run \(your request\)\n  Implement the parser described by the Goal\.$/m,
    /^Completion criteria — the Goal is achieved only when all 4 hold$/m,
    /^  1\. tests-pass\n     Checked by: running a command on a sandboxed copy/m,
    /^     Command: node --test test\/csv\.test\.mjs$/m,
    /^     Working directory: \. · time limit 60 s$/m,
    /^  2\. quality\n     Checked by: a model scoring the result \(needs score 1\) against:\n       Score 1 only if the code is readable/m,
    /^  3\. owner\n     Checked by: you, with \/workflow goal judge <runId>/m,
    /^     Expected: \{"ok":true\}$/m,
    /^  Protected \(never changed\): PROTECTED\.md, test\/csv\.test\.mjs$/m,
    /^    • apply verified changes to your working tree$/m,
    /^  Not part of this consent:\n    • deploying or publishing anything\n    • running commands other than the ones written in the criteria\n    • authoritative cost accounting/m,
    /^Models \(profile captured\)\n  planning +openai-codex\/gpt-6\.1-sol · xhigh\n  checking \(rubric\) +openai-codex\/gpt-6-luna · high$/m,
    /^  Fast: on \(OpenAI priority tier for every request\)$/m,
    /^  Requests: 40 · cost: no cap$/m,
    /^  Attempts \(first plan \+ replans\): 10$/m,
    /^  • explain — Goal explain \(\.\/explain\.json\)\n      Objective: Explain unknown outcomes\.$/m,
    /^Recovery of workflow_old\n  Counts its 1 attempt\(s\) and 3 request\(s\) against the limits\n  Starts from the working tree\n  Last verdicts passed to the planner: tests-pass: not-met$/m,
  ]) assert.match(readable, expected);
  assert.ok(readable.split("\n").every(line => line.length <= 160), "lines fit a normal terminal");
  assert.match(formatGoalExecutionDetails({ weird: true }), /could not be described; its exact content follows\.\n\n\{/);
});
