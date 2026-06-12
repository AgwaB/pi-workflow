import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { parseAgentMarkdown } from "../.tmp/unit/agents.js";
import { compileWorkflow } from "../.tmp/unit/compiler.js";
import { buildRunSourceContext, evaluateLoopUntilCondition, formatRun, runWorkflow, scheduleRun } from "../.tmp/unit/engine.js";
import { workflowArgumentCompletions, parseWorkflowRunArgs } from "../.tmp/unit/extension.js";
import { listWorkflows, recommendWorkflows, resolveWorkflowRef } from "../.tmp/unit/workflow-specs.js";
import { resolveWorkflowRuntime } from "../.tmp/unit/workflow-runtime.js";
import { loadWorkflow, parseWorkflow } from "../.tmp/unit/schema.js";
import { acquireSupervisorLease, createStageFirstRunRecord, deriveRunStatus, heartbeatSupervisorLease, readRunRecord, resolveFlowsCwd, setTaskTerminal, supervisorLeasePath, workflowProcessRoleForTests, workflowSupervisorOwnerIdForTests, writeJsonAtomic, writeRunRecord, writeStaticRunArtifacts } from "../.tmp/unit/store.js";
import { WorkflowValidationError, STAGE_FIRST_RUN_TYPE } from "../.tmp/unit/types.js";
import { applyTaskResultArtifact, buildJsonOutputRetryInstructions, extractJsonOutput, parseJsonOutput } from "../.tmp/unit/result.js";
import { canStageProceedAfterPreviousFailure, extractStageFirstForeachItems, shouldScheduleAfterStageFailure } from "../.tmp/unit/workflow-runtime.js";
import { deriveWorkflowStatus, summarizeTasks } from "../.tmp/unit/store.js";
import { assertWorkflowActionAllowedForRole, assertWorkflowToolAllowedForRole, getWorkflowProcessRole, isWorkflowSupervisorEnabled, workflowWorkerEnvPrefix } from "../.tmp/unit/process-role.js";
import { buildSourceContextPacket, summarizeWorkflowTelemetry, validateStructuredContract } from "../.tmp/unit/workflow-artifacts.js";
import { loadWorkflowHelper, resolveWorkflowHelperRef } from "../.tmp/unit/workflow-helpers.js";
import { refreshRunFromSubagentArtifacts, setSubagentApiForTests } from "../.tmp/unit/subagent-backend.js";

function makeProject() {
  return mkdtempSync(join(tmpdir(), "workflow-unit-"));
}

function writeAgent(cwd, name, tools = "read, grep, find, ls") {
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\ndescription: ${name}\ntools: [${tools.split(/,\s*/).filter(Boolean).map((tool) => JSON.stringify(tool)).join(", ")}]\nreadOnly: true\n---\n# ${name}\n\nUse repository evidence.\n`);
}

function workflowSpec(agent = "unit-scout", extra = {}) {
  return {
    schemaVersion: 1,
    agent,
    readOnly: true,
    tools: ["read"],
    flow: { stages: [{ id: "main", type: "task", prompt: "Do the work." }] },
    ...extra,
  };
}

function loopWorkflowSpec(loop = {}) {
  return workflowSpec("unit-scout", {
    workflow: {
      stages: [{
        id: "fix-loop",
        type: "loop",
        stages: [
          { id: "implement", type: "task", prompt: "Implement the requested fix." },
          { id: "check", type: "task", output: { format: "json", requiredKeys: ["status", "verdict"], onInvalid: "fail" }, prompt: "Check the fix." },
        ],
        maxRounds: 5,
        until: {
          all: [
            { stage: "check", path: "$.status", equals: "pass" },
            { stage: "check", path: "$.verdict", equals: "ACCEPT" },
          ],
        },
        ...loop,
      }],
    },
  });
}

function assertThrowsFlow(fn) {
  assert.throws(fn, WorkflowValidationError);
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected throw");
}

function assertIssue(error, path, messagePart) {
  assert(error instanceof WorkflowValidationError);
  assert(error.issues.some((issue) => issue.path === path && issue.message.includes(messagePart)), JSON.stringify(error.issues));
}

async function createLoopRun(cwd, spec = loopWorkflowSpec()) {
  const compiled = await compileWorkflow(spec, { cwd, task: "Fix the loop target" });
  const { run } = await createStageFirstRunRecord(cwd, compiled, join(cwd, "workflows", "loop.json"));
  await writeStaticRunArtifacts(cwd, run, compiled, spec);
  await writeRunRecord(cwd, run);
  return { compiled, run };
}

async function completeTask(cwd, task, structuredOutput = {}, status = "completed") {
  setTaskTerminal(task, status, status, { exitCode: status === "completed" ? 0 : 1, lastMessage: status });
  await writeJsonAtomic(join(cwd, task.files.result), {
    status,
    completedAt: new Date().toISOString(),
    exitCode: status === "completed" ? 0 : 1,
    structuredOutput,
  });
}

function taskBySpec(run, specId) {
  const task = run.tasks.find((item) => item.specId === specId);
  assert(task, `missing task ${specId}`);
  return task;
}

test("shared status helpers derive canonical task summaries", () => {
  assert.deepEqual(summarizeTasks([{ status: "completed" }, { status: "blocked" }, { status: "pending" }]), {
    total: 3,
    pending: 1,
    running: 0,
    blocked: 1,
    completed: 1,
    failed: 0,
    skipped: 0,
    interrupted: 0,
  });
  assert.equal(deriveWorkflowStatus({ total: 2, pending: 1, running: 0, blocked: 1, completed: 0, failed: 0, skipped: 0, interrupted: 0 }), "blocked");
  // blocked outranks running so supervisors surface stuck runs instead of polling forever
  assert.equal(deriveWorkflowStatus({ total: 2, pending: 0, running: 1, blocked: 1, completed: 0, failed: 0, skipped: 0, interrupted: 0 }), "blocked");
});

test("workflow process role helpers default to supervisor and honor worker/disabled", () => {
  assert.equal(getWorkflowProcessRole({}), "supervisor");
  assert.equal(getWorkflowProcessRole({ PI_WORKFLOW_ROLE: "worker" }), "worker");
  assert.equal(getWorkflowProcessRole({ PI_WORKFLOW_ROLE: "disabled" }), "disabled");
  assert.equal(getWorkflowProcessRole({ PI_WORKFLOW_ROLE: "surprise" }), "supervisor");
  assert.equal(isWorkflowSupervisorEnabled({ PI_WORKFLOW_ROLE: "worker" }), false);
  assert.equal(workflowWorkerEnvPrefix(), "PI_WORKFLOW_ROLE=worker");
});

test("worker and disabled roles block supervisor workflow actions", () => {
  const originalRole = process.env.PI_WORKFLOW_ROLE;
  try {
    process.env.PI_WORKFLOW_ROLE = "worker";
    assert.doesNotThrow(() => assertWorkflowActionAllowedForRole("help"));
    assert.doesNotThrow(() => assertWorkflowActionAllowedForRole("validate"));
    assert.throws(() => assertWorkflowActionAllowedForRole("run"), /PI_WORKFLOW_ROLE=worker/);
    assert.throws(() => assertWorkflowActionAllowedForRole("continue"), /PI_WORKFLOW_ROLE=worker/);
    assert.throws(() => assertWorkflowActionAllowedForRole("wait"), /PI_WORKFLOW_ROLE=worker/);
    assert.throws(() => assertWorkflowToolAllowedForRole(), /PI_WORKFLOW_ROLE=worker/);

    process.env.PI_WORKFLOW_ROLE = "disabled";
    assert.doesNotThrow(() => assertWorkflowActionAllowedForRole("recommend"));
    assert.throws(() => assertWorkflowActionAllowedForRole("run"), /PI_WORKFLOW_ROLE=disabled/);
    assert.throws(() => assertWorkflowToolAllowedForRole(), /PI_WORKFLOW_ROLE=disabled/);
  } finally {
    if (originalRole === undefined) delete process.env.PI_WORKFLOW_ROLE;
    else process.env.PI_WORKFLOW_ROLE = originalRole;
  }
});

test("supervisor lease ignores orphaned reclaim mutex from dead owner", async () => {
  const cwd = makeProject();
  const originalRole = process.env.PI_WORKFLOW_ROLE;
  try {
    process.env.PI_WORKFLOW_ROLE = "supervisor";
    const runId = "workflow_unit_orphan_reclaim";
    const reclaimDir = join(cwd, ".pi", "workflows", runId, "supervisor-lease.lock.reclaim");
    mkdirSync(reclaimDir, { recursive: true });
    writeFileSync(join(reclaimDir, "owner"), `dead-owner\n99999999\n${new Date().toISOString()}\n`);
    assert.equal(await acquireSupervisorLease(cwd, runId), true);
  } finally {
    if (originalRole === undefined) delete process.env.PI_WORKFLOW_ROLE;
    else process.env.PI_WORKFLOW_ROLE = originalRole;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("supervisor lease honors live foreign owners and stale reclaim; workers cannot acquire", async () => {
  const cwd = makeProject();
  const originalRole = process.env.PI_WORKFLOW_ROLE;
  try {
    process.env.PI_WORKFLOW_ROLE = "supervisor";
    const runId = "workflow_unit_lease";
    assert.equal(await acquireSupervisorLease(cwd, runId), true);
    assert.equal(workflowProcessRoleForTests(), "supervisor");

    const ownLease = JSON.parse(readFileSync(supervisorLeasePath(cwd, runId), "utf8"));
    assert.equal(ownLease.ownerId, workflowSupervisorOwnerIdForTests());
    await writeJsonAtomic(supervisorLeasePath(cwd, runId), { ...ownLease, heartbeatAt: "2000-01-01T00:00:00.000Z" });
    assert.equal(await heartbeatSupervisorLease(cwd, runId), true);
    const heartbeaten = JSON.parse(readFileSync(supervisorLeasePath(cwd, runId), "utf8"));
    assert.equal(heartbeaten.ownerId, workflowSupervisorOwnerIdForTests());
    assert.notEqual(heartbeaten.heartbeatAt, "2000-01-01T00:00:00.000Z");

    const foreignLiveRunId = "workflow_unit_foreign_live";
    await writeJsonAtomic(supervisorLeasePath(cwd, foreignLiveRunId), {
      schemaVersion: 1,
      ownerId: "foreign-live",
      pid: process.pid,
      role: "supervisor",
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    });
    assert.equal(await acquireSupervisorLease(cwd, foreignLiveRunId), false);

    const foreignStaleRunId = "workflow_unit_foreign_stale";
    await writeJsonAtomic(supervisorLeasePath(cwd, foreignStaleRunId), {
      schemaVersion: 1,
      ownerId: "foreign-stale",
      pid: 99999999,
      role: "supervisor",
      startedAt: "2000-01-01T00:00:00.000Z",
      heartbeatAt: "2000-01-01T00:00:00.000Z",
    });
    assert.equal(await acquireSupervisorLease(cwd, foreignStaleRunId), true);

    process.env.PI_WORKFLOW_ROLE = "worker";
    assert.equal(await acquireSupervisorLease(cwd, "workflow_unit_worker"), false);
  } finally {
    if (originalRole === undefined) delete process.env.PI_WORKFLOW_ROLE;
    else process.env.PI_WORKFLOW_ROLE = originalRole;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("agent parser reads frontmatter tool ceilings", () => {
  const agent = parseAgentMarkdown("---\ndescription: Scout\ntools: [read, grep]\nreadOnly: true\n---\nBody", "scout.md", "project");
  assert.equal(agent.displayName, "scout");
  assert.deepEqual(agent.tools, ["read", "grep"]);
  assert.equal(agent.readOnly, true);
});

test("schema accepts final v1 workflow and rejects old legacy bodies", () => {
  const parsed = parseWorkflow(workflowSpec());
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.flow.stages[0].id, "main");

  const wrongVersion = assertThrowsFlow(() => parseWorkflow({ ...workflowSpec(), schemaVersion: 99 }));
  assertIssue(wrongVersion, "$.schemaVersion", "must be exactly 1");

  const legacy = assertThrowsFlow(() => parseWorkflow({
    schemaVersion: 1,
    flow: { type: "single", task: { agent: "unit-scout", task: "legacy" } },
  }));
  assertIssue(legacy, "$.flow.type", "unknown field");

  const continuation = assertThrowsFlow(() => parseWorkflow(workflowSpec("unit-scout", {
    workflow: { stages: [{ id: "final", type: "reduce", continuation: { mode: "ask" }, prompt: "Final" }] },
  })));
  assertIssue(continuation, "$.workflow.stages[0].continuation", "unknown field");
});

test("schema accepts stage-level inject and rejects item-level inject", () => {
  const parsed = parseWorkflow(workflowSpec("unit-scout", {
    flow: {
      stages: [
        { id: "entry", type: "task", inject: false, prompt: "Entry" },
        { id: "fanout", type: "parallel", inject: true, tasks: [{ id: "a", prompt: "A" }, { id: "b", prompt: "B" }] },
        { id: "summary", type: "reduce", inject: true, prompt: "Summary" },
      ],
    },
  }));
  assert.equal(parsed.flow.stages[0].inject, false);
  assert.equal(parsed.flow.stages[1].inject, true);
  assert.equal(parsed.flow.stages[2].inject, true);

  assertThrowsFlow(() => parseWorkflow(workflowSpec("unit-scout", {
    flow: { stages: [{ id: "fanout", type: "parallel", tasks: [{ id: "a", prompt: "A", inject: true }, { id: "b", prompt: "B" }] }] },
  })));

  assertThrowsFlow(() => parseWorkflow(workflowSpec("unit-scout", {
    flow: {
      stages: [
        { id: "extract", type: "task", output: { format: "json" }, prompt: "Extract" },
        { id: "verify", type: "foreach", from: { stage: "extract", path: "$.items" }, each: { prompt: "Verify", inject: true } },
      ],
    },
  })));
});

test("schema accepts valid loop with until all and onExhausted reduce", () => {
  const parsed = parseWorkflow(loopWorkflowSpec({
    onExhausted: { id: "loop-summary", type: "reduce", prompt: "Summarize remaining failures." },
  }));

  assert.equal(parsed.workflow.stages[0].type, "loop");
  assert.equal(parsed.workflow.stages[0].maxRounds, 5);
  assert.equal(parsed.workflow.stages[0].until.all.length, 2);
  assert.equal(parsed.workflow.stages[0].onExhausted.type, "reduce");
});

test("schema rejects nested loop child", () => {
  const error = assertThrowsFlow(() => parseWorkflow(loopWorkflowSpec({
    stages: [
      { id: "inner", type: "loop", stages: [], maxRounds: 1, until: { stage: "check", path: "$.status", equals: "pass" } },
      { id: "check", type: "task", prompt: "Check." },
    ],
  })));
  assertIssue(error, "$.workflow.stages[0].stages[0].type", "not supported in v1");
});

test("schema rejects foreach child in loop as deferred", () => {
  const error = assertThrowsFlow(() => parseWorkflow(loopWorkflowSpec({
    stages: [
      { id: "items", type: "foreach", from: { stage: "check", path: "$.items" }, each: { prompt: "Review ${item}" } },
      { id: "check", type: "task", prompt: "Check." },
    ],
  })));
  assertIssue(error, "$.workflow.stages[0].stages[0].type", "deferred");
});

test("schema rejects transform child in loop as deferred", () => {
  const error = assertThrowsFlow(() => parseWorkflow(loopWorkflowSpec({
    stages: [
      { id: "implement", type: "task", prompt: "Implement." },
      { id: "gate", type: "transform", helper: "./helpers/gate.mjs" },
      { id: "check", type: "task", prompt: "Check." },
    ],
  })));
  assertIssue(error, "$.workflow.stages[0].stages[1].type", "deferred");
});

test("schema rejects parallel child in loop", () => {
  const error = assertThrowsFlow(() => parseWorkflow(loopWorkflowSpec({
    stages: [
      { id: "implement", type: "parallel", tasks: [{ id: "a", prompt: "A" }, { id: "b", prompt: "B" }] },
      { id: "check", type: "task", prompt: "Check." },
    ],
  })));
  assertIssue(error, "$.workflow.stages[0].stages[0].type", "parallel child stages are not supported in loop v1");
});

test("schema rejects loop until referencing a non-final child stage", () => {
  const error = assertThrowsFlow(() => parseWorkflow(loopWorkflowSpec({
    stages: [
      { id: "implement", type: "task", readOnly: false, tools: ["read", "edit"], prompt: "Implement." },
      { id: "check", type: "task", tools: ["read"], prompt: "Check." },
    ],
    until: { stage: "implement", path: "$.status", equals: "pass" },
  })));
  assertIssue(error, "$.workflow.stages[0].until.stage", "final child stage");
});

test("schema rejects loop child from fan-out", () => {
  const error = assertThrowsFlow(() => parseWorkflow(loopWorkflowSpec({
    stages: [
      { id: "implement", type: "task", prompt: "Implement." },
      { id: "check", type: "task", from: "implement", prompt: "Check." },
    ],
  })));
  assertIssue(error, "$.workflow.stages[0].stages[1].from", "must not define from");
});

test("schema rejects loop until check before a later mutating child", () => {
  const error = assertThrowsFlow(() => parseWorkflow(loopWorkflowSpec({
    stages: [
      { id: "implement", type: "task", prompt: "Implement." },
      { id: "check", type: "task", tools: ["read"], prompt: "Check." },
      { id: "mutate-again", type: "task", tools: ["read", "edit"], prompt: "Mutate after check." },
    ],
    until: { stage: "check", path: "$.status", equals: "pass" },
  })));
  assertIssue(error, "$.workflow.stages[0].until.stage", "final child stage");
});

test("schema accepts bundled implement-loop separation shape", () => {
  const spec = JSON.parse(readFileSync(join(process.cwd(), "workflows", "implement-loop.json"), "utf8"));
  assert.doesNotThrow(() => parseWorkflow(spec));
});

test("schema rejects duplicate top-level stage ids", () => {
  const error = assertThrowsFlow(() => parseWorkflow(workflowSpec("unit-scout", {
    workflow: {
      stages: [
        { id: "duplicate", type: "task", prompt: "One." },
        { id: "duplicate", type: "task", prompt: "Two." },
      ],
    },
  })));
  assertIssue(error, "$.workflow.stages[1].id", "duplicate stage id");
});

test("schema rejects loop dependsOn because stage-first dependencies use from", () => {
  const error = assertThrowsFlow(() => parseWorkflow(loopWorkflowSpec({ dependsOn: ["setup.main"] })));
  assertIssue(error, "$.workflow.stages[0].dependsOn", "unknown field");
});

test("schema rejects loop missing its own id", () => {
  const spec = loopWorkflowSpec();
  delete spec.workflow.stages[0].id;
  const error = assertThrowsFlow(() => parseWorkflow(spec));
  assertIssue(error, "$.workflow.stages[0].id", "is required");
});

test("schema rejects loop child missing id", () => {
  const error = assertThrowsFlow(() => parseWorkflow(loopWorkflowSpec({
    stages: [
      { type: "task", prompt: "Implement." },
      { id: "check", type: "task", prompt: "Check." },
    ],
  })));
  assertIssue(error, "$.workflow.stages[0].stages[0].id", "is required");
});

test("schema rejects duplicate loop child ids", () => {
  const error = assertThrowsFlow(() => parseWorkflow(loopWorkflowSpec({
    stages: [
      { id: "implement", type: "task", prompt: "Implement." },
      { id: "implement", type: "task", prompt: "Check." },
    ],
  })));
  assertIssue(error, "$.workflow.stages[0].stages[1].id", "duplicate child stage id");
});

test("schema rejects loop maxRounds missing", () => {
  const error = assertThrowsFlow(() => parseWorkflow(loopWorkflowSpec({ maxRounds: undefined })));
  assertIssue(error, "$.workflow.stages[0].maxRounds", "is required");
});

test("schema rejects loop maxRounds zero", () => {
  const error = assertThrowsFlow(() => parseWorkflow(loopWorkflowSpec({ maxRounds: 0 })));
  assertIssue(error, "$.workflow.stages[0].maxRounds", "positive integer");
});

test("schema rejects loop maxRounds above hard cap", () => {
  const error = assertThrowsFlow(() => parseWorkflow(loopWorkflowSpec({ maxRounds: 51 })));
  assertIssue(error, "$.workflow.stages[0].maxRounds", "less than or equal to 50");
});

test("schema rejects loop until missing", () => {
  const error = assertThrowsFlow(() => parseWorkflow(loopWorkflowSpec({ until: undefined })));
  assertIssue(error, "$.workflow.stages[0].until", "is required");
});

test("schema rejects loop until path not starting with dollar dot", () => {
  const error = assertThrowsFlow(() => parseWorkflow(loopWorkflowSpec({
    until: { stage: "check", path: "status", equals: "pass" },
  })));
  assertIssue(error, "$.workflow.stages[0].until.path", "starting with $.");
});

test("schema rejects loop until leaf unknown stage ref", () => {
  const error = assertThrowsFlow(() => parseWorkflow(loopWorkflowSpec({
    until: { stage: "review", path: "$.status", equals: "pass" },
  })));
  assertIssue(error, "$.workflow.stages[0].until.stage", "unknown");
});

test("schema rejects loop onExhausted non-reduce type", () => {
  const error = assertThrowsFlow(() => parseWorkflow(loopWorkflowSpec({
    onExhausted: { id: "fallback", type: "task", prompt: "Fallback work." },
  })));
  assertIssue(error, "$.workflow.stages[0].onExhausted.type", "reduce");
});

test("schema and compiler accept partial sourcePolicy on foreach", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read");
    const spec = workflowSpec("unit-scout", {
      workflow: {
        stages: [
          { id: "extract", type: "task", output: { format: "json" }, prompt: "Extract" },
          { id: "verify", type: "foreach", sourcePolicy: "partial", from: { stage: "extract", path: "$.items" }, each: { prompt: "Verify ${item}" } },
        ],
      },
    });
    assert.equal(parseWorkflow(spec).workflow.stages[1].sourcePolicy, "partial");
    const compiled = await compileWorkflow(spec, { cwd, task: "Review" });
    assert.equal(compiled.stages[1].sourcePolicy, "partial");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("JSON output extraction tolerates prose and fenced JSON", () => {
  assert.deepEqual(extractJsonOutput('{"findings":[]}'), { text: '{"findings":[]}', extracted: false });
  assert.deepEqual(extractJsonOutput('```json\n{"findings":[]}\n```'), { text: '{"findings":[]}', extracted: false });
  assert.deepEqual(extractJsonOutput('Here are findings.\n\n{"findings":[{"title":"brace } inside string"}]}\nThanks.'), {
    text: '{"findings":[{"title":"brace } inside string"}]}',
    extracted: true,
  });
});

test("JSON output parsing picks candidate matching required keys", () => {
  const output = 'Prose with escaped example `{\\"findings\\": null}` before the final answer.\n\n{"finding":{"title":"kept"},"verdict":"KEEP"}';
  assert.deepEqual(parseJsonOutput(output, ["$.finding", "$.verdict"]), {
    valid: true,
    extracted: true,
    structuredOutput: { finding: { title: "kept" }, verdict: "KEEP" },
  });
});

test("partial foreach continues scheduling after an item failure", () => {
  assert.equal(shouldScheduleAfterStageFailure({ id: "review", type: "foreach", sourcePolicy: "partial" }), true);
  assert.equal(shouldScheduleAfterStageFailure({ id: "review", type: "foreach", sourcePolicy: "require-success" }), false);
  assert.equal(shouldScheduleAfterStageFailure({ id: "report", type: "reduce", sourcePolicy: "partial" }), false);
});

test("dependency-aware skip lets explicit partial sources bypass unrelated previous failures", () => {
  const previous = { id: "failed", type: "task", sourceStageIds: [], sourcePolicy: "require-success" };
  assert.equal(canStageProceedAfterPreviousFailure({ id: "next", type: "task", sourceStageIds: [], sourcePolicy: "require-success" }, previous), false);
  assert.equal(canStageProceedAfterPreviousFailure({ id: "strict", type: "reduce", sourceStageIds: ["failed"], sourcePolicy: "require-success" }, previous), false);
  assert.equal(canStageProceedAfterPreviousFailure({ id: "partial", type: "reduce", sourceStageIds: ["failed"], sourcePolicy: "partial" }, previous), true);
  assert.equal(canStageProceedAfterPreviousFailure({ id: "unrelated", type: "reduce", sourceStageIds: ["ok"], sourcePolicy: "require-success" }, previous), true);
});

test("partial foreach extraction skips failed source tasks", async () => {
  const cwd = makeProject();
  try {
    const completedFile = join(cwd, ".pi", "workflows", "workflow_unit", "stages", "reviewers", "tasks", "item-001", "result.json");
    const failedFile = join(cwd, ".pi", "workflows", "workflow_unit", "stages", "reviewers", "tasks", "item-002", "result.json");
    await writeJsonAtomic(completedFile, { structuredOutput: { findings: [{ title: "kept" }] } });
    await writeJsonAtomic(failedFile, { status: "failed" });
    const sourceTasks = [
      { taskId: "reviewers.item-001", status: "completed", files: { result: ".pi/workflows/workflow_unit/stages/reviewers/tasks/item-001/result.json" } },
      { taskId: "reviewers.item-002", status: "failed", files: { result: ".pi/workflows/workflow_unit/stages/reviewers/tasks/item-002/result.json" } },
    ];
    const partialStage = { from: { path: "$.findings", mode: "concat" }, sourcePolicy: "partial" };
    const strictStage = { from: { path: "$.findings", mode: "concat" }, sourcePolicy: "require-success" };
    assert.deepEqual(await extractStageFirstForeachItems(cwd, partialStage, sourceTasks), { items: [{ title: "kept" }] });
    assert.match((await extractStageFirstForeachItems(cwd, strictStage, sourceTasks)).error, /did not complete/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("compiler injects runtime task by effective stage policy", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read");
    const compiled = await compileWorkflow(workflowSpec("unit-scout", {
      roles: { lens: { prompt: "Role context marker." } },
      flow: {
        stages: [
          { id: "entry", type: "task", prompt: "Entry instructions." },
          { id: "entry-no-inject", type: "task", inject: false, prompt: "Entry no inject." },
          { id: "final", type: "reduce", prompt: "Final instructions." },
          { id: "final-inject", type: "reduce", inject: true, from: "final", prompt: "Final with task." },
        ],
      },
    }), { cwd, task: "Review feature A" });

    assert.equal(compiled.schemaVersion, 1);
    const byKey = Object.fromEntries(compiled.tasks.map((task) => [task.key, task]));
    assert.match(byKey["entry.main"].compiledPrompt, /^# Task\n\nReview feature A\n\n# Workflow Stage/);
    assert.equal(byKey["entry.main"].injectTask, true);
    assert.doesNotMatch(byKey["entry-no-inject.main"].compiledPrompt, /# Task/);
    assert.equal(byKey["entry-no-inject.main"].injectTask, false);
    assert.doesNotMatch(byKey["final.main"].compiledPrompt, /# Task/);
    assert.equal(byKey["final.main"].injectTask, false);
    assert.match(byKey["final-inject.main"].compiledPrompt, /^# Task\n\nReview feature A\n\n# Workflow Stage/);
    assert.equal(byKey["final-inject.main"].injectTask, true);
    assert.match(byKey["entry.main"].compiledPrompt, /# Instructions\n\nEntry instructions\./);
    assert.match(byKey["entry.main"].compiledPrompt, /# Role Context\n\n## Role: lens\nRole context marker\./);
    assert.match(byKey["entry.main"].compiledPrompt, /# Role Context\n\n## Role: lens\nRole context marker\./);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("compiler defers foreach task injection until runtime interpolation", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read");
    const compiled = await compileWorkflow(workflowSpec("unit-scout", {
      flow: {
        stages: [
          { id: "extract", type: "task", output: { format: "json" }, prompt: "Extract" },
          { id: "verify", type: "foreach", inject: true, from: { stage: "extract", path: "$.claims" }, each: { prompt: "Verify ${item}" } },
        ],
      },
    }), { cwd, task: "Check ${WORKSPACE} literally" });

    assert.equal(compiled.task, "Check ${WORKSPACE} literally");
    assert.equal(compiled.tasks[1].injectTask, true);
    assert.deepEqual(compiled.tasks[1].dependsOn, ["extract.main"]);
    assert.doesNotMatch(compiled.tasks[1].compiledPrompt, /# Task/);
    assert.doesNotMatch(compiled.tasks[1].compiledPrompt, /WORKSPACE/);
    assert.match(compiled.tasks[1].compiledPrompt, /Verify the relevant item from the dependency context/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("compiler applies explicit stage from dependencies and stage runtime defaults", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read, grep");
    const compiled = await compileWorkflow(workflowSpec("unit-scout", {
      model: "kimi-coding/kimi-for-coding",
      thinking: "high",
      tools: ["read", "grep"],
      defaults: { maxRuntimeMs: 12345 },
      flow: {
        stages: [
          { id: "plan", type: "task", prompt: "Plan" },
          { id: "research", type: "foreach", from: { stage: "plan", path: "$.questions" }, each: { prompt: "Research ${item}" } },
          { id: "final", type: "reduce", from: ["plan", "research"], prompt: "Final" },
        ],
      },
    }), { cwd, task: "Research topic" });

    const byKey = Object.fromEntries(compiled.tasks.map((task) => [task.key, task]));
    assert.deepEqual(byKey["research.item"].dependsOn, ["plan.main"]);
    assert.deepEqual(byKey["final.main"].dependsOn, ["plan.main", "research.item"]);
    assert.equal(byKey["final.main"].runtime.model, "kimi-coding/kimi-for-coding");
    assert.equal(byKey["final.main"].runtime.thinking, "high");
    assert.deepEqual(byKey["final.main"].runtime.tools, ["read", "grep"]);
    assert.equal(byKey["final.main"].runtime.maxRuntimeMs, 12345);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("schema accepts object-form tools and rejects invalid tool objects", () => {
  parseWorkflow(workflowSpec("unit-scout", {
    tools: [
      "read",
      {
        name: "scrapling_fetch",
        extensions: ["packages/pi-scrapling-access"],
        classification: "read-only",
        optional: true,
        fallbackTools: ["fetch_content"],
      },
    ],
  }));

  const missingName = assertThrowsFlow(() => parseWorkflow(workflowSpec("unit-scout", { tools: [{ extensions: ["pkg"] }] })));
  assertIssue(missingName, "$.tools[0].name", "is required");

  const invalid = assertThrowsFlow(() => parseWorkflow(workflowSpec("unit-scout", {
    tools: [
      "read",
      { name: "bad tool" },
      { name: "custom_class", classification: "side-effect" },
      { name: "custom_ext", extensions: "pkg" },
      { name: "custom_fallback", fallbackTools: ["bad tool"] },
    ],
  })));
  assertIssue(invalid, "$.tools[1].name", "invalid tool name");
  assertIssue(invalid, "$.tools[2].classification", "must be one of");
  assertIssue(invalid, "$.tools[3].extensions", "must be an array");
  assertIssue(invalid, "$.tools[4].fallbackTools[0]", "invalid tool name");
});

test("compiler normalizes object-form tools and treats classified custom read-only tools as safe", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read, fetch_content, scrapling_fetch");
    const compiled = await compileWorkflow(workflowSpec("unit-scout", {
      tools: [
        "read",
        "fetch_content",
        {
          name: "scrapling_fetch",
          extensions: ["packages/pi-scrapling-access"],
          classification: "read-only",
          optional: true,
          fallbackTools: ["fetch_content"],
        },
      ],
    }), { cwd, task: "Fetch safely" });

    const task = compiled.tasks[0];
    assert.deepEqual(task.runtime.tools, ["read", "fetch_content", "scrapling_fetch"]);
    assert.deepEqual(task.runtime.toolProviders, {
      scrapling_fetch: {
        extensions: ["packages/pi-scrapling-access"],
        classification: "read-only",
        optional: true,
        fallbackTools: ["fetch_content"],
      },
    });
    assert.equal(task.safety.capability, "read-only");
    assert.equal(task.safety.permission.status, "pending");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("compiler keeps unclassified custom tools blocked for explicit review", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read, custom_external_tool");
    const compiled = await compileWorkflow(workflowSpec("unit-scout", {
      tools: ["read", "custom_external_tool"],
    }), { cwd, task: "Check custom tool" });

    assert.equal(compiled.tasks[0].safety.permission.status, "blocked");
    assert.equal(compiled.tasks[0].safety.permission.reason, "unknown/custom tools require explicit review: custom_external_tool");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("object-form tools cannot expand beyond agent-declared tool ceilings", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read");
    await assert.rejects(
      () => compileWorkflow(workflowSpec("unit-scout", {
        tools: [{ name: "scrapling_fetch", classification: "read-only" }],
      }), { cwd, task: "Fetch" }),
      (error) => {
        assert(error instanceof WorkflowValidationError);
        assertIssue(error, "$.tools", "expands agent");
        return true;
      },
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("narrow tool scopes inherit metadata for strings and override it for objects", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read, scrapling_fetch");
    const compiled = await compileWorkflow(workflowSpec("unit-scout", {
      tools: [
        "read",
        {
          name: "scrapling_fetch",
          extensions: ["packages/base-provider"],
          classification: "mutation-capable",
          optional: true,
        },
      ],
      workflow: {
        stages: [
          { id: "inherit", type: "task", tools: ["scrapling_fetch"], prompt: "Inherit metadata." },
          {
            id: "override",
            type: "task",
            tools: [{ name: "scrapling_fetch", extensions: ["packages/stage-provider"], classification: "read-only" }],
            prompt: "Override metadata.",
          },
        ],
      },
    }), { cwd, task: "Fetch" });

    const byKey = Object.fromEntries(compiled.tasks.map((task) => [task.key, task]));
    assert.deepEqual(byKey["inherit.main"].runtime.tools, ["scrapling_fetch"]);
    assert.deepEqual(byKey["inherit.main"].runtime.toolProviders, {
      scrapling_fetch: {
        extensions: ["packages/base-provider"],
        classification: "mutation-capable",
        optional: true,
      },
    });
    assert.deepEqual(byKey["override.main"].runtime.toolProviders, {
      scrapling_fetch: {
        extensions: ["packages/stage-provider"],
        classification: "read-only",
        optional: true,
      },
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("stage-first foreach materializes source array into generated tasks", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read");
    const spec = workflowSpec("unit-scout", {
      flow: {
        stages: [
          { id: "extract", type: "task", output: { format: "json", requiredKeys: ["claims"] }, prompt: "Extract" },
          { id: "verify", type: "foreach", inject: true, from: { stage: "extract", path: "$.claims", mode: "concat" }, maxConcurrency: 2, each: { prompt: "Verify ${item}" } },
          { id: "summary", type: "reduce", from: "verify", prompt: "Summarize" },
        ],
      },
    });
    const compiled = await compileWorkflow(spec, { cwd, task: "Check claims" });
    const { run } = await createStageFirstRunRecord(cwd, compiled, join(cwd, "workflows", "unit.json"));
    await writeStaticRunArtifacts(cwd, run, compiled, spec);

    setTaskTerminal(run.tasks[0], "completed", "completed", { exitCode: 0, lastMessage: "completed" });
    await writeJsonAtomic(join(cwd, run.tasks[0].files.result), {
      status: "completed",
      structuredOutput: { claims: [{ id: "CLAIM_A", text: "A" }, "plain claim"] },
    });
    await writeRunRecord(cwd, run);

    await scheduleRun(cwd, run.runId);
    const materialized = await readRunRecord(cwd, run.runId);
    const specIds = materialized.tasks.map((task) => task.specId);
    assert.deepEqual(specIds, ["extract.main", "verify.claim_a", "verify.item-002", "summary.main"]);
    assert.equal(materialized.tasks.find((task) => task.specId === "verify.claim_a")?.status, "pending");
    assert.equal(materialized.tasks.find((task) => task.specId === "verify.item-002")?.status, "pending");
    assert.deepEqual(JSON.parse(readFileSync(join(cwd, ".pi", "workflows", materialized.runId, "compiled.json"), "utf8")).tasks.find((task) => task.id === "summary.main").dependsOn, ["verify.claim_a", "verify.item-002"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("successive foreach materialization keeps task ids unique", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read");
    const spec = workflowSpec("unit-scout", {
      flow: {
        stages: [
          { id: "extract", type: "task", output: { format: "json", requiredKeys: ["claims"] }, prompt: "Extract" },
          { id: "review", type: "foreach", from: { stage: "extract", path: "$.claims" }, each: { prompt: "Review ${item}" } },
          { id: "verify", type: "foreach", from: { stage: "review", path: "$.findings", mode: "concat" }, each: { prompt: "Verify ${item}" } },
        ],
      },
    });
    const compiled = await compileWorkflow(spec, { cwd, task: "Check claims" });
    const { run } = await createStageFirstRunRecord(cwd, compiled, join(cwd, "workflows", "unit.json"));
    await writeStaticRunArtifacts(cwd, run, compiled, spec);
    setTaskTerminal(run.tasks[0], "completed", "completed", { exitCode: 0, lastMessage: "completed" });
    await writeJsonAtomic(join(cwd, run.tasks[0].files.result), { status: "completed", structuredOutput: { claims: ["a", "b"] } });
    await writeRunRecord(cwd, run);

    await scheduleRun(cwd, run.runId);
    let current = await readRunRecord(cwd, run.runId);
    for (const task of current.tasks.filter((item) => item.stageId === "review")) {
      setTaskTerminal(task, "completed", "completed", { exitCode: 0, lastMessage: "completed" });
      await writeJsonAtomic(join(cwd, task.files.result), { status: "completed", structuredOutput: { findings: [{ title: `${task.specId}-finding` }] } });
    }
    await writeRunRecord(cwd, current);

    await scheduleRun(cwd, run.runId);
    current = await readRunRecord(cwd, run.runId);
    const taskIds = current.tasks.map((task) => task.taskId);
    assert.equal(new Set(taskIds).size, taskIds.length);
    assert.deepEqual(current.tasks.filter((task) => task.stageId === "verify").map((task) => task.specId), ["verify.item-001", "verify.item-002"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("stage-first foreach blocks when maxItems is exceeded", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read");
    const spec = workflowSpec("unit-scout", {
      flow: {
        stages: [
          { id: "extract", type: "task", output: { format: "json", requiredKeys: ["claims"] }, prompt: "Extract" },
          { id: "verify", type: "foreach", from: { stage: "extract", path: "$.claims" }, maxItems: 1, each: { prompt: "Verify ${item}" } },
        ],
      },
    });
    const compiled = await compileWorkflow(spec, { cwd, task: "Check claims" });
    const { run } = await createStageFirstRunRecord(cwd, compiled, join(cwd, "workflows", "unit.json"));
    await writeStaticRunArtifacts(cwd, run, compiled, spec);
    setTaskTerminal(run.tasks[0], "completed", "completed", { exitCode: 0, lastMessage: "completed" });
    await writeJsonAtomic(join(cwd, run.tasks[0].files.result), { status: "completed", structuredOutput: { claims: ["a", "b"] } });
    await writeRunRecord(cwd, run);

    await scheduleRun(cwd, run.runId);
    const blocked = await readRunRecord(cwd, run.runId);
    assert.equal(blocked.tasks[1].status, "blocked");
    assert.match(blocked.tasks[1].lastMessage, /exceeding maxItems=1/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("loop compiles to a loop stage record with no premature child tasks", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read");
    const compiled = await compileWorkflow(loopWorkflowSpec(), { cwd, task: "Fix failures" });
    const loopStage = compiled.stages.find((stage) => stage.id === "fix-loop");
    assert.equal(loopStage.type, "loop");
    assert.equal(loopStage.maxRounds, 5);
    assert.deepEqual(loopStage.childStageIds, ["implement", "check"]);
    assert.equal(loopStage.childTemplates.length, 2);
    assert.deepEqual(compiled.tasks.map((task) => task.specId), ["fix-loop.loop"]);
    assert.equal(compiled.tasks.filter((task) => task.loopChild).length, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("loop round 1 materializes child tasks with deterministic ids", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read");
    const { run } = await createLoopRun(cwd);

    await scheduleRun(cwd, run.runId);
    const materialized = await readRunRecord(cwd, run.runId);
    assert.deepEqual(materialized.tasks.map((task) => task.specId), [
      "fix-loop.loop",
      "fix-loop.r01.implement",
      "fix-loop.r01.check",
    ]);
    assert.deepEqual(taskBySpec(materialized, "fix-loop.r01.implement").dependsOn ?? [], []);
    assert.deepEqual(taskBySpec(materialized, "fix-loop.r01.check").dependsOn, ["fix-loop.r01.implement"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("loop resume reconciliation backfills missing run records for compiled round tasks", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read");
    const loopStage = loopWorkflowSpec().workflow.stages[0];
    const spec = workflowSpec("unit-scout", {
      workflow: { stages: [loopStage, { id: "after", type: "task", prompt: "After loop." }] },
    });
    const { run } = await createLoopRun(cwd, spec);
    await scheduleRun(cwd, run.runId);
    let current = await readRunRecord(cwd, run.runId);
    assert.deepEqual(current.tasks.map((task) => task.specId), [
      "fix-loop.loop",
      "fix-loop.r01.implement",
      "fix-loop.r01.check",
      "after.main",
    ]);

    current.tasks = current.tasks.filter((task) => !task.specId.startsWith("fix-loop.r01."));
    await writeRunRecord(cwd, current);

    await scheduleRun(cwd, run.runId);
    current = await readRunRecord(cwd, run.runId);
    assert.deepEqual(current.tasks.map((task) => task.specId), [
      "fix-loop.loop",
      "fix-loop.r01.implement",
      "fix-loop.r01.check",
      "after.main",
    ]);
    assert.equal(current.tasks.filter((task) => task.specId === "fix-loop.r01.implement").length, 1);
    assert.equal(current.tasks.filter((task) => task.specId === "fix-loop.r01.check").length, 1);

    await completeTask(cwd, taskBySpec(current, "fix-loop.r01.implement"), { changed: true });
    await completeTask(cwd, taskBySpec(current, "fix-loop.r01.check"), { status: "pass", verdict: "ACCEPT", blockingFailures: [] });
    await writeRunRecord(cwd, current);
    await scheduleRun(cwd, run.runId);
    current = await readRunRecord(cwd, run.runId);
    assert.equal(taskBySpec(current, "fix-loop.loop").status, "completed");
    assert.equal(current.loopResults[0].status, "completed");
    assert.equal(taskBySpec(current, "after.main").status, "pending");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("stage-first scheduler fails closed on compiled run positional mismatch", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read");
    const spec = workflowSpec("unit-scout", {
      workflow: {
        stages: [
          { id: "one", type: "task", prompt: "One." },
          { id: "two", type: "task", prompt: "Two." },
        ],
      },
    });
    const compiled = await compileWorkflow(spec, { cwd, task: "Check alignment" });
    const { run } = await createStageFirstRunRecord(cwd, compiled, join(cwd, "workflows", "alignment.json"));
    await writeStaticRunArtifacts(cwd, run, compiled, spec);
    run.tasks = [run.tasks[1], run.tasks[0]];
    await writeRunRecord(cwd, run);

    await assert.rejects(() => scheduleRun(cwd, run.runId), /materialization is misaligned/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("loop until satisfied after a round marks loop completed and stops materializing", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read");
    const { run } = await createLoopRun(cwd);
    await scheduleRun(cwd, run.runId);
    let current = await readRunRecord(cwd, run.runId);
    await completeTask(cwd, taskBySpec(current, "fix-loop.r01.implement"), { changed: true });
    await completeTask(cwd, taskBySpec(current, "fix-loop.r01.check"), { status: "pass", verdict: "ACCEPT", blockingFailures: [] });
    await writeRunRecord(cwd, current);

    await scheduleRun(cwd, run.runId);
    current = await readRunRecord(cwd, run.runId);
    assert.equal(taskBySpec(current, "fix-loop.loop").status, "completed");
    assert.equal(current.loopResults[0].status, "completed");
    assert.equal(current.loopResults[0].roundsUsed, 1);
    assert.deepEqual(current.loopResults[0].finalCheck, { status: "pass", verdict: "ACCEPT", blockingFailures: [] });
    assert.equal(current.tasks.some((task) => task.specId.includes(".r02.")), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("loop until unmet materializes round 2 with unique ids and carry-forward context", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read");
    const { run } = await createLoopRun(cwd);
    await scheduleRun(cwd, run.runId);
    let current = await readRunRecord(cwd, run.runId);
    await completeTask(cwd, taskBySpec(current, "fix-loop.r01.implement"), { changed: true });
    await completeTask(cwd, taskBySpec(current, "fix-loop.r01.check"), { status: "fail", verdict: "REJECT", blockingFailures: ["a", "b"] });
    await writeRunRecord(cwd, current);

    await scheduleRun(cwd, run.runId);
    current = await readRunRecord(cwd, run.runId);
    const specIds = current.tasks.map((task) => task.specId);
    assert.equal(new Set(specIds).size, specIds.length);
    assert(specIds.includes("fix-loop.r02.implement"));
    assert(specIds.includes("fix-loop.r02.check"));
    assert.deepEqual(taskBySpec(current, "fix-loop.r02.implement").dependsOn, ["fix-loop.r01.implement", "fix-loop.r01.check"]);

    const compiledAfterRound2 = JSON.parse(readFileSync(join(cwd, ".pi", "workflows", current.runId, "compiled.json"), "utf8"));
    const round2Implement = compiledAfterRound2.tasks.find((task) => task.id === "fix-loop.r02.implement");
    assert.match(round2Implement.compiledPrompt, /# Loop Carry-Forward Context/);
    assert.match(round2Implement.compiledPrompt, /"blockingFailures":\["a","b"\]/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("loop no-progress stops early with stopped_no_progress", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read");
    const { run } = await createLoopRun(cwd);
    await scheduleRun(cwd, run.runId);
    let current = await readRunRecord(cwd, run.runId);
    await completeTask(cwd, taskBySpec(current, "fix-loop.r01.implement"), { changed: true });
    await completeTask(cwd, taskBySpec(current, "fix-loop.r01.check"), { status: "fail", verdict: "REJECT", blockingFailures: ["a", "b"] });
    await writeRunRecord(cwd, current);
    await scheduleRun(cwd, run.runId);

    current = await readRunRecord(cwd, run.runId);
    await completeTask(cwd, taskBySpec(current, "fix-loop.r02.implement"), { changed: true });
    await completeTask(cwd, taskBySpec(current, "fix-loop.r02.check"), { status: "fail", verdict: "REJECT", blockingFailures: ["a", "b"] });
    await writeRunRecord(cwd, current);
    await scheduleRun(cwd, run.runId);

    current = await readRunRecord(cwd, run.runId);
    assert.equal(current.loopResults[0].status, "stopped_no_progress");
    assert.equal(current.loopResults[0].roundsUsed, 2);
    assert.equal(current.tasks.some((task) => task.specId.includes(".r03.")), false);
    assert.equal(taskBySpec(current, "fix-loop.loop").statusDetail, "loop_stopped_no_progress");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("loop output requiredKeys compile to requiredPaths contract", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read");
    const compiled = await compileWorkflow(loopWorkflowSpec(), { cwd, task: "Fix failures" });
    const loopStage = compiled.stages.find((stage) => stage.id === "fix-loop");
    const checkTemplate = loopStage.childTemplates.find((task) => task.stageId === "check");
    assert.deepEqual(checkTemplate.output.contract.requiredPaths, ["$.status", "$.verdict"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("loop check missing requiredKeys triggers output retry", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read");
    const { run } = await createLoopRun(cwd);
    await scheduleRun(cwd, run.runId);
    const current = await readRunRecord(cwd, run.runId);
    const check = taskBySpec(current, "fix-loop.r01.check");
    mkdirSync(dirname(join(cwd, check.files.output)), { recursive: true });
    writeFileSync(join(cwd, check.files.output), JSON.stringify({ status: "pass" }));
    const changed = await applyTaskResultArtifact(cwd, check, {
      resultFile: join(cwd, check.files.result),
      result: { status: "completed", completedAt: new Date().toISOString(), exitCode: 0 },
      status: "completed",
      completedAfterTimeout: false,
    });
    assert.equal(changed, true);
    assert.equal(check.status, "pending");
    assert.equal(check.statusDetail, "retry_output_invalid");
    assert.match(check.outputRetry.message, /\$\.verdict/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("loop invalid progressPath value records a warning", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read");
    const { run } = await createLoopRun(cwd, loopWorkflowSpec({ progressPath: "$.passing" }));
    await scheduleRun(cwd, run.runId);
    let current = await readRunRecord(cwd, run.runId);
    await completeTask(cwd, taskBySpec(current, "fix-loop.r01.implement"), { changed: true });
    await completeTask(cwd, taskBySpec(current, "fix-loop.r01.check"), { status: "fail", verdict: "REJECT", passing: false });
    await writeRunRecord(cwd, current);
    await scheduleRun(cwd, run.runId);

    current = await readRunRecord(cwd, run.runId);
    await completeTask(cwd, taskBySpec(current, "fix-loop.r02.implement"), { changed: true });
    await completeTask(cwd, taskBySpec(current, "fix-loop.r02.check"), { status: "fail", verdict: "REJECT", passing: false });
    await writeRunRecord(cwd, current);
    await scheduleRun(cwd, run.runId);

    current = await readRunRecord(cwd, run.runId);
    assert.match(taskBySpec(current, "fix-loop.r02.check").lastMessage ?? "", /progressPath \$\.passing resolved to unsupported boolean/);
    assert.equal(current.tasks.some((task) => task.specId.includes(".r03.")), true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("loop explicit missing progressPath records a warning", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read");
    const { run } = await createLoopRun(cwd, loopWorkflowSpec({ progressPath: "$.missingProgress" }));
    await scheduleRun(cwd, run.runId);
    let current = await readRunRecord(cwd, run.runId);
    await completeTask(cwd, taskBySpec(current, "fix-loop.r01.implement"), { changed: true });
    await completeTask(cwd, taskBySpec(current, "fix-loop.r01.check"), { status: "fail", verdict: "REJECT", blockingFailures: ["a"] });
    await writeRunRecord(cwd, current);
    await scheduleRun(cwd, run.runId);

    current = await readRunRecord(cwd, run.runId);
    await completeTask(cwd, taskBySpec(current, "fix-loop.r02.implement"), { changed: true });
    await completeTask(cwd, taskBySpec(current, "fix-loop.r02.check"), { status: "fail", verdict: "REJECT", blockingFailures: ["a"] });
    await writeRunRecord(cwd, current);
    await scheduleRun(cwd, run.runId);

    current = await readRunRecord(cwd, run.runId);
    assert.match(taskBySpec(current, "fix-loop.r02.check").lastMessage ?? "", /progressPath \$\.missingProgress resolved to unsupported undefined/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("loop maxRounds exhaustion materializes and waits for onExhausted", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read");
    const spec = loopWorkflowSpec({
      maxRounds: 1,
      onExhausted: { id: "loop-summary", type: "reduce", prompt: "Summarize remaining failures." },
    });
    const { run } = await createLoopRun(cwd, spec);
    await scheduleRun(cwd, run.runId);
    let current = await readRunRecord(cwd, run.runId);
    await completeTask(cwd, taskBySpec(current, "fix-loop.r01.implement"), { changed: true });
    await completeTask(cwd, taskBySpec(current, "fix-loop.r01.check"), { status: "fail", verdict: "REJECT", blockingFailures: ["still failing"] });
    await writeRunRecord(cwd, current);

    await scheduleRun(cwd, run.runId);
    current = await readRunRecord(cwd, run.runId);
    const exhausted = taskBySpec(current, "fix-loop.onExhausted.loop-summary");
    assert.equal(exhausted.status, "pending");
    assert.equal(taskBySpec(current, "fix-loop.loop").status, "pending");

    await completeTask(cwd, exhausted, { summary: "human follow-up needed" });
    await writeRunRecord(cwd, current);
    await scheduleRun(cwd, run.runId);
    current = await readRunRecord(cwd, run.runId);
    assert.equal(current.loopResults[0].status, "exhausted");
    assert.equal(current.loopResults[0].roundsUsed, 1);
    assert.equal(taskBySpec(current, "fix-loop.loop").status, "completed");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("loop onExhausted context includes bounded prior round check outputs", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read");
    const spec = loopWorkflowSpec({
      maxRounds: 2,
      onExhausted: { id: "loop-summary", type: "reduce", prompt: "Summarize each round." },
    });
    const { run } = await createLoopRun(cwd, spec);
    await scheduleRun(cwd, run.runId);
    let current = await readRunRecord(cwd, run.runId);
    await completeTask(cwd, taskBySpec(current, "fix-loop.r01.implement"), { changed: true });
    await completeTask(cwd, taskBySpec(current, "fix-loop.r01.check"), { status: "fail", verdict: "REJECT", blockingFailures: ["a", "b"] });
    await writeRunRecord(cwd, current);

    await scheduleRun(cwd, run.runId);
    current = await readRunRecord(cwd, run.runId);
    await completeTask(cwd, taskBySpec(current, "fix-loop.r02.implement"), { changed: true });
    await completeTask(cwd, taskBySpec(current, "fix-loop.r02.check"), { status: "fail", verdict: "REJECT", blockingFailures: ["a"] });
    await writeRunRecord(cwd, current);

    await scheduleRun(cwd, run.runId);
    current = await readRunRecord(cwd, run.runId);
    const exhausted = taskBySpec(current, "fix-loop.onExhausted.loop-summary");
    assert.deepEqual(exhausted.dependsOn, [
      "fix-loop.r01.implement",
      "fix-loop.r01.check",
      "fix-loop.r02.implement",
      "fix-loop.r02.check",
    ]);
    const compiledAfterExhaustion = JSON.parse(readFileSync(join(cwd, ".pi", "workflows", current.runId, "compiled.json"), "utf8"));
    const exhaustedTask = compiledAfterExhaustion.tasks.find((task) => task.id === "fix-loop.onExhausted.loop-summary");
    assert.match(exhaustedTask.compiledPrompt, /Round check outputs/);
    assert.match(exhaustedTask.compiledPrompt, /Round 1/);
    assert.match(exhaustedTask.compiledPrompt, /"blockingFailures":\["a","b"\]/);
    assert.match(exhaustedTask.compiledPrompt, /Round 2/);
    assert.match(exhaustedTask.compiledPrompt, /"blockingFailures":\["a"\]/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("loop until evaluator supports equals notEquals lengthEquals all and any", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read");
    const { run } = await createLoopRun(cwd);
    await scheduleRun(cwd, run.runId);
    const current = await readRunRecord(cwd, run.runId);
    await completeTask(cwd, taskBySpec(current, "fix-loop.r01.implement"), { changed: true });
    await completeTask(cwd, taskBySpec(current, "fix-loop.r01.check"), { status: "pass", verdict: "ACCEPT", blockingFailures: ["a", "b"], count: 2 });
    await writeRunRecord(cwd, current);
    const compiledAfterRound1 = JSON.parse(readFileSync(join(cwd, ".pi", "workflows", current.runId, "compiled.json"), "utf8"));

    assert.equal(await evaluateLoopUntilCondition(cwd, current, compiledAfterRound1, "fix-loop", 1, { stage: "check", path: "$.status", equals: "pass" }), true);
    assert.equal(await evaluateLoopUntilCondition(cwd, current, compiledAfterRound1, "fix-loop", 1, { stage: "check", path: "$.status", notEquals: "fail" }), true);
    assert.equal(await evaluateLoopUntilCondition(cwd, current, compiledAfterRound1, "fix-loop", 1, { stage: "check", path: "$.blockingFailures", lengthEquals: 2 }), true);
    assert.equal(await evaluateLoopUntilCondition(cwd, current, compiledAfterRound1, "fix-loop", 1, {
      all: [
        { stage: "check", path: "$.status", equals: "pass" },
        { stage: "check", path: "$.verdict", equals: "ACCEPT" },
      ],
    }), true);
    assert.equal(await evaluateLoopUntilCondition(cwd, current, compiledAfterRound1, "fix-loop", 1, {
      any: [
        { stage: "check", path: "$.status", equals: "fail" },
        { stage: "check", path: "$.verdict", equals: "ACCEPT" },
      ],
    }), true);
    assert.equal(await evaluateLoopUntilCondition(cwd, current, compiledAfterRound1, "fix-loop", 1, { stage: "check", path: "$.missing", notEquals: "anything" }), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("loop completed task with unreadable result records a warning", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read");
    const { run } = await createLoopRun(cwd);
    await scheduleRun(cwd, run.runId);
    const current = await readRunRecord(cwd, run.runId);
    await completeTask(cwd, taskBySpec(current, "fix-loop.r01.implement"), { changed: true });
    const check = taskBySpec(current, "fix-loop.r01.check");
    setTaskTerminal(check, "completed", "completed", { exitCode: 0, lastMessage: "completed" });
    mkdirSync(dirname(join(cwd, check.files.result)), { recursive: true });
    writeFileSync(join(cwd, check.files.result), "{not-json");
    await writeRunRecord(cwd, current);
    const compiledAfterRound1 = JSON.parse(readFileSync(join(cwd, ".pi", "workflows", current.runId, "compiled.json"), "utf8"));

    assert.equal(await evaluateLoopUntilCondition(cwd, current, compiledAfterRound1, "fix-loop", 1, { stage: "check", path: "$.status", equals: "pass" }), false);
    assert.match(check.lastMessage, /completed loop task result unreadable/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("bundled implement-loop workflow parses and compiles (schema/engine integration)", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "delegate", "read, grep, find, ls, edit, write");
    writeAgent(cwd, "scout", "read, grep, find, ls, bash");
    const spec = JSON.parse(readFileSync(join(process.cwd(), "workflows", "implement-loop.json"), "utf8"));
    parseWorkflow(spec);
    const compiled = await compileWorkflow(spec, { cwd, task: "Fix the failing auth test." });
    const loopStage = compiled.stages.find((stage) => stage.id === "fix-loop");
    assert.equal(loopStage.type, "loop");
    assert.equal(loopStage.maxRounds, 5);
    assert.deepEqual(loopStage.childStageIds, ["implement", "check"]);
    assert.equal(compiled.tasks.filter((task) => task.loopChild).length, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("bundled test-repair-loop workflow materializes a serial repair/check round", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "delegate", "read, grep, find, ls, edit, write");
    writeAgent(cwd, "scout", "read, grep, find, ls, bash");
    const specPath = join(process.cwd(), "workflows", "test-repair-loop.json");
    const spec = JSON.parse(readFileSync(specPath, "utf8"));
    parseWorkflow(spec);
    const compiled = await compileWorkflow(spec, { cwd, task: "Fix npm test; approved command: npm test." });
    const loopStage = compiled.stages.find((stage) => stage.id === "repair-loop");
    assert.equal(loopStage.type, "loop");
    assert.deepEqual(loopStage.childStageIds, ["repair", "test-check"]);
    assert.equal(loopStage.maxRounds, 4);
    assert.equal(loopStage.progressPath, "$.failingChecks");

    const { run } = await createStageFirstRunRecord(cwd, compiled, specPath);
    await writeStaticRunArtifacts(cwd, run, compiled, spec);
    await writeRunRecord(cwd, run);
    await scheduleRun(cwd, run.runId);

    const materialized = await readRunRecord(cwd, run.runId);
    assert.deepEqual(materialized.tasks.map((task) => task.specId), [
      "repair-loop.loop",
      "repair-loop.r01.repair",
      "repair-loop.r01.test-check",
    ]);
    assert.deepEqual(taskBySpec(materialized, "repair-loop.r01.repair").dependsOn ?? [], []);
    assert.deepEqual(taskBySpec(materialized, "repair-loop.r01.test-check").dependsOn, ["repair-loop.r01.repair"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("workflow artifact telemetry summarizes stage status, retries, wall clock, and output bytes", () => {
  const run = {
    createdAt: "2026-06-08T00:00:00.000Z",
    updatedAt: "2026-06-08T00:02:00.000Z",
    tasks: [
      {
        stageId: "plan",
        status: "completed",
        startedAt: "2026-06-08T00:00:00.000Z",
        completedAt: "2026-06-08T00:00:10.000Z",
        files: { output: "a", stderr: "", result: "" },
      },
      {
        stageId: "verify",
        status: "completed",
        startedAt: "2026-06-08T00:00:15.000Z",
        completedAt: "2026-06-08T00:00:45.000Z",
        outputRetry: { attempts: 1 },
        files: { output: "b", stderr: "", result: "" },
      },
      {
        stageId: "verify",
        status: "interrupted",
        startedAt: "2026-06-08T00:00:20.000Z",
        completedAt: "2026-06-08T00:00:25.000Z",
        launchRetry: { attempts: 1 },
        files: { output: "c", stderr: "", result: "" },
      },
    ],
  };
  const summary = summarizeWorkflowTelemetry(run, { outputBytesByTaskId: { a: 10, b: 20, c: 0 } });
  assert.equal(summary.wallClockMs, 120000);
  assert.equal(summary.taskCount, 3);
  assert.equal(summary.statusCounts.completed, 2);
  assert.equal(summary.statusCounts.interrupted, 1);
  assert.equal(summary.retryCounts.output, 1);
  assert.equal(summary.retryCounts.launch, 1);
  assert.equal(summary.outputBytes, 30);
  assert.equal(summary.stages.verify.taskCount, 2);
  assert.equal(summary.stages.verify.durationMs, 35000);
});

test("workflow source context packet prefers structured output and caps raw previews", () => {
  const run = {
    tasks: [
      {
        taskId: "task-1",
        specId: "plan.main",
        stageId: "plan",
        status: "completed",
        outputValidation: { structured: true },
        files: { output: "plan.out", result: "plan.json" },
      },
      {
        taskId: "task-2",
        specId: "verify.claim-001",
        stageId: "verify",
        status: "completed",
        outputValidation: { structured: true },
        files: { output: "verify.out", result: "verify.json" },
      },
      {
        taskId: "task-3",
        specId: "verify.claim-002",
        stageId: "verify",
        status: "failed",
        files: { output: "failed.out", result: "failed.json" },
      },
    ],
  };
  const packet = buildSourceContextPacket(run, {
    structuredOutputsByTaskId: {
      "task-1": { researchQuestions: [{ id: "rq1", question: "Q?" }] },
      "task-2": { id: "claim-001", status: "verified", evidence: [{ url: "https://example.test", quote: "ok" }] },
    },
    rawOutputsByTaskId: {
      "task-3": "abcdefghijklmnopqrstuvwxyz",
    },
    maxPreviewChars: 8,
  });

  assert.equal(packet.tasks.length, 3);
  assert.deepEqual(packet.byStage.verify.statusCounts, { completed: 1, failed: 1 });
  assert.equal(packet.tasks[1].structuredOutput.status, "verified");
  assert.equal(packet.tasks[2].outputPreview, "abcdefgh…");
  assert.equal(packet.tasks[2].structuredOutput, undefined);
});

test("workflow source context packet can cap oversized structured output", () => {
  const packet = buildSourceContextPacket({
    tasks: [
      {
        taskId: "task-1",
        specId: "normalize.main",
        stageId: "normalize",
        status: "completed",
        files: { output: "normalize.out", result: "normalize.json" },
      },
    ],
  }, {
    structuredOutputsByTaskId: {
      "task-1": { huge: "abcdefghijklmnopqrstuvwxyz" },
    },
    maxStructuredChars: 16,
  });
  assert.equal(packet.tasks[0].structuredOutput.truncated, true);
  assert.equal(packet.tasks[0].structuredOutput.originalChars > 16, true);
  assert.match(packet.tasks[0].structuredOutput.preview, /^\{/);
});

test("workflow source context packet applies stage caps and a global packet budget", () => {
  const run = {
    tasks: [
      { taskId: "task-1", specId: "plan.main", stageId: "plan", status: "completed", files: { output: "plan.out", result: "plan.json" } },
      { taskId: "task-2", specId: "verify.claim-001", stageId: "verify", status: "completed", files: { output: "verify.out", result: "verify.json" } },
      { taskId: "task-3", specId: "verify.claim-002", stageId: "verify", status: "completed", files: { output: "verify2.out", result: "verify2.json" } },
    ],
  };
  const packet = buildSourceContextPacket(run, {
    structuredOutputsByTaskId: {
      "task-1": { plan: "abcdefghijklmnopqrstuvwxyz" },
      "task-2": { evidence: "abcdefghijklmnopqrstuvwxyz" },
      "task-3": { evidence: "abcdefghijklmnopqrstuvwxyz" },
    },
    maxStructuredChars: 64,
    maxStructuredCharsByStage: { verify: 12 },
    maxPacketChars: 320,
  });

  assert.equal(packet.tasks[1].structuredOutput.truncated, true);
  assert.equal(packet.tasks[1].structuredOutput.preview.length <= 13, true);
  assert.equal(packet.tasks[2].omittedOutput.reason, "packet_budget_exhausted");
  assert.deepEqual(packet.byStage.verify.statusCounts, { completed: 2 });
});

test("workflow source context packet can project structured outputs by source stage", () => {
  const packet = buildSourceContextPacket({
    tasks: [
      { taskId: "task-1", specId: "verify.claim-001", stageId: "verify", status: "completed", files: { output: "verify.out", result: "verify.json" } },
    ],
  }, {
    structuredOutputsByTaskId: {
      "task-1": {
        id: "claim-001",
        status: "verified",
        verdictDigest: { support: "direct", sourceUrls: ["https://example.test"] },
        evidence: [{ quote: "long quote that final should not need" }],
      },
    },
    structuredOutputPathsByStage: {
      verify: ["$.id", "$.status", "$.verdictDigest", "$.missingDigest"],
    },
  });

  assert.deepEqual(packet.tasks[0].structuredOutput, {
    id: "claim-001",
    status: "verified",
    verdictDigest: { support: "direct", sourceUrls: ["https://example.test"] },
  });
  assert.deepEqual(packet.tasks[0].projectionWarnings, [{ path: "$.missingDigest", reason: "missing" }]);
});

test("structured contract validator checks nested paths, arrays, and caps", () => {
  const valid = validateStructuredContract({
    finalReport: { mainFindings: [{ finding: "x" }], remainingGaps: { blocking: [], nonBlocking: ["minor"] } },
    claimVerdictIndex: { claims: [{ id: "claim-001", status: "verified", sourceUrls: ["https://example.test"] }] },
  }, {
    requiredPaths: ["$.finalReport", "$.claimVerdictIndex.claims"],
    arrays: [{ path: "$.claimVerdictIndex.claims", minItems: 1, maxItems: 2 }],
    maxStringChars: [{ path: "$.finalReport.remainingGaps.nonBlocking[0]", maxChars: 16 }],
  });
  assert.equal(valid.valid, true);

  const invalid = validateStructuredContract({ claimVerdictIndex: { claims: [] } }, {
    requiredPaths: ["$.finalReport", "$.claimVerdictIndex.claims"],
    arrays: [{ path: "$.claimVerdictIndex.claims", minItems: 1 }],
  });
  assert.equal(invalid.valid, false);
  assert(invalid.issues.some((issue) => issue.path === "$.finalReport"));
  assert(invalid.issues.some((issue) => issue.path === "$.claimVerdictIndex.claims" && issue.message.includes("at least 1")));
});

test("task output contract enforces nested structured JSON shape", async () => {
  const cwd = makeProject();
  try {
    const taskDir = join(cwd, ".pi", "workflows", "workflow_unit", "tasks", "main");
    mkdirSync(taskDir, { recursive: true });
    const output = join(taskDir, "output.log");
    const stderr = join(taskDir, "stderr.log");
    const result = join(taskDir, "result.json");
    writeFileSync(output, JSON.stringify({ finalReport: {}, claimVerdictIndex: { claims: [] } }));
    writeFileSync(stderr, "");
    const task = {
      taskId: "main",
      specId: "final.main",
      displayName: "final.main",
      agent: "unit-scout",
      agentFile: "unit-scout.md",
      roles: [],
      status: "running",
      statusDetail: "running",
      runtime: { approvalMode: "non-interactive" },
      cwd,
      worktree: { enabled: false, path: null, branch: null, baseCwd: null, warning: null },
      backendTaskId: "final.main",
      launchToken: "token-1",
      files: {
        systemPrompt: ".pi/workflows/workflow_unit/tasks/main/system-prompt.md",
        taskPrompt: ".pi/workflows/workflow_unit/tasks/main/task.md",
        output: ".pi/workflows/workflow_unit/tasks/main/output.log",
        stderr: ".pi/workflows/workflow_unit/tasks/main/stderr.log",
        result: ".pi/workflows/workflow_unit/tasks/main/result.json",
      },
      output: {
        format: "json",
        onInvalid: "fail",
        contract: {
          requiredPaths: ["$.finalReport", "$.claimVerdictIndex.claims"],
          arrays: [{ path: "$.claimVerdictIndex.claims", minItems: 1 }],
        },
      },
    };
    const changed = await applyTaskResultArtifact(cwd, task, {
      resultFile: result,
      result: { status: "completed", completedAt: new Date().toISOString(), exitCode: 0, launchToken: "token-1" },
      status: "completed",
      completedAfterTimeout: false,
    });
    assert.equal(changed, true);
    assert.equal(task.status, "pending");
    assert.equal(task.statusDetail, "retry_output_invalid");
    const recorded = JSON.parse(readFileSync(result, "utf8"));
    assert.equal(recorded.failureKind, "output_invalid");
    assert.match(recorded.errorMessage, /expected at least 1 items/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("engine source context reads structured outputs and telemetry from task artifacts", async () => {
  const cwd = makeProject();
  try {
    const run = {
      createdAt: "2026-06-08T00:00:00.000Z",
      updatedAt: "2026-06-08T00:01:00.000Z",
      tasks: [
        {
          taskId: "task-1",
          specId: "plan.main",
          stageId: "plan",
          status: "completed",
          startedAt: "2026-06-08T00:00:00.000Z",
          completedAt: "2026-06-08T00:00:10.000Z",
          files: {
            output: ".pi/workflows/workflow_unit/tasks/task-1/output.log",
            stderr: ".pi/workflows/workflow_unit/tasks/task-1/stderr.log",
            result: ".pi/workflows/workflow_unit/tasks/task-1/result.json",
          },
        },
        {
          taskId: "task-2",
          specId: "verify.claim-001",
          stageId: "verify",
          status: "completed",
          startedAt: "2026-06-08T00:00:20.000Z",
          completedAt: "2026-06-08T00:00:50.000Z",
          outputRetry: { attempts: 1 },
          files: {
            output: ".pi/workflows/workflow_unit/tasks/task-2/output.log",
            stderr: ".pi/workflows/workflow_unit/tasks/task-2/stderr.log",
            result: ".pi/workflows/workflow_unit/tasks/task-2/result.json",
          },
        },
      ],
    };
    for (const task of run.tasks) mkdirSync(join(cwd, task.files.output, ".."), { recursive: true });
    writeFileSync(join(cwd, run.tasks[0].files.output), "raw plan output");
    writeFileSync(join(cwd, run.tasks[0].files.result), JSON.stringify({ structuredOutput: { researchQuestions: [{ id: "rq1" }] } }));
    writeFileSync(join(cwd, run.tasks[1].files.output), "raw verify output");
    writeFileSync(join(cwd, run.tasks[1].files.result), JSON.stringify({ structuredOutput: { id: "claim-001", status: "verified" } }));

    const context = await buildRunSourceContext(cwd, run, run.tasks, { maxPreviewChars: 4 });
    assert.equal(context.telemetry.wallClockMs, 60000);
    assert.equal(context.telemetry.retryCounts.output, 1);
    assert.equal(context.packet.tasks[0].structuredOutput.researchQuestions[0].id, "rq1");
    assert.equal(context.packet.tasks[0].outputPreview, undefined);
    assert.equal(context.packet.byStage.verify.statusCounts.completed, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("schema and compiler support pi-subagent headless backend", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read");

    const defaultCompiled = await compileWorkflow(workflowSpec("unit-scout"), { cwd, task: "Review" });
    assert.equal(defaultCompiled.backend.mode, "headless");
    assert.equal(defaultCompiled.maxConcurrency, 16);

    const headlessSpec = workflowSpec("unit-scout", { defaults: { backend: { mode: "headless" } } });
    assert.equal(parseWorkflow(headlessSpec).defaults.backend.mode, "headless");
    assert.equal((await compileWorkflow(headlessSpec, { cwd, task: "Review" })).backend.mode, "headless");

    assertThrowsFlow(() => parseWorkflow(workflowSpec("unit-scout", { defaults: { backend: { mode: "tmux" } } })));
    assertThrowsFlow(() => parseWorkflow(workflowSpec("unit-scout", { defaults: { fast: "on" } })));
    assertThrowsFlow(() => parseWorkflow(workflowSpec("unit-scout", { workflow: { stages: [{ id: "main", type: "task", fast: "on", prompt: "Do it." }] } })));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("schema validates stage sourceContext projection settings", () => {
  const parsed = parseWorkflow(workflowSpec("unit-scout", {
    workflow: {
      stages: [
        {
          id: "final",
          type: "reduce",
          sourceContext: {
            maxStructuredChars: 1200,
            maxPacketChars: 32000,
            maxStructuredCharsByStage: { verify: 800 },
            structuredOutputPathsByStage: { verify: ["$.id", "$.verdictDigest"] },
          },
          prompt: "Summarize",
        },
      ],
    },
  }));
  assert.equal(parsed.workflow.stages[0].sourceContext.maxPacketChars, 32000);

  const badCap = assertThrowsFlow(() => parseWorkflow(workflowSpec("unit-scout", {
    workflow: { stages: [{ id: "final", type: "reduce", sourceContext: { maxPacketChars: "large" }, prompt: "Summarize" }] },
  })));
  assertIssue(badCap, "$.workflow.stages[0].sourceContext.maxPacketChars", "positive integer");

  const badPath = assertThrowsFlow(() => parseWorkflow(workflowSpec("unit-scout", {
    workflow: { stages: [{ id: "final", type: "reduce", sourceContext: { structuredOutputPathsByStage: { verify: ["id"] } }, prompt: "Summarize" }] },
  })));
  assertIssue(badPath, "$.workflow.stages[0].sourceContext.structuredOutputPathsByStage.verify[0]", "must start with $.");
});

test("schema and compiler accept transform stages", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read");
    const spec = workflowSpec("unit-scout", {
      workflow: {
        stages: [
          { id: "verify", type: "task", output: { format: "json" }, prompt: "Verify claims" },
          { id: "audit", type: "transform", from: "verify", helper: "./helpers/audit.mjs", options: { strict: true } },
        ],
      },
    });

    const parsed = parseWorkflow(spec);
    assert.equal(parsed.workflow.stages[1].helper, "./helpers/audit.mjs");
    const compiled = await compileWorkflow(spec, { cwd, task: "Research" });
    const transformTask = compiled.tasks.find((task) => task.stageId === "audit");
    assert.ok(transformTask);
    assert.equal(transformTask.kind, "transform");
    assert.deepEqual(transformTask.dependsOn, ["verify.main"]);
    assert.deepEqual(transformTask.transform, { helper: "./helpers/audit.mjs", options: { strict: true } });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("schema rejects invalid transform stages", () => {
  const missingHelper = assertThrowsFlow(() => parseWorkflow(workflowSpec("unit-scout", {
    workflow: { stages: [{ id: "audit", type: "transform", from: "verify" }] },
  })));
  assertIssue(missingHelper, "$.workflow.stages[0].helper", "required");

  const unknownKey = assertThrowsFlow(() => parseWorkflow(workflowSpec("unit-scout", {
    workflow: { stages: [{ id: "audit", type: "transform", from: "verify", helper: "./helpers/audit.mjs", prompt: "No prompt" }] },
  })));
  assertIssue(unknownKey, "$.workflow.stages[0].prompt", "unknown field");
});

test("compiler injects output JSON template from output protocol", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read");
    const spec = workflowSpec("unit-scout", {
      workflow: {
        stages: [
          {
            id: "extract",
            type: "task",
            output: {
              format: "json",
              contract: { requiredPaths: ["$.items"] },
              template: { items: [{ id: "item-001", text: "..." }] },
            },
            prompt: "Extract items.",
          },
          {
            id: "verify",
            type: "foreach",
            from: { stage: "extract", path: "$.items" },
            output: {
              format: "json",
              template: { id: "item-001", status: "verified|unsupported" },
            },
            each: { prompt: "Verify ${item}" },
          },
        ],
      },
    });
    const compiled = await compileWorkflow(spec, { cwd, task: "Check items" });
    assert.match(compiled.tasks[0].compiledPrompt, /# Output JSON Template/);
    assert.match(compiled.tasks[0].compiledPrompt, /"items"/);

    const { run } = await createStageFirstRunRecord(cwd, compiled, join(cwd, "workflows", "unit.json"));
    await writeStaticRunArtifacts(cwd, run, compiled, spec);
    setTaskTerminal(run.tasks[0], "completed", "completed", { exitCode: 0, lastMessage: "completed" });
    await writeJsonAtomic(join(cwd, run.tasks[0].files.result), { status: "completed", structuredOutput: { items: [{ id: "alpha" }] } });
    await writeRunRecord(cwd, run);
    await scheduleRun(cwd, run.runId);
    const compiledAfterMaterialize = JSON.parse(readFileSync(join(cwd, ".pi", "workflows", run.runId, "compiled.json"), "utf8"));
    const verifyTask = compiledAfterMaterialize.tasks.find((task) => task.id === "verify.alpha");
    assert.match(verifyTask.compiledPrompt, /# Output JSON Template/);
    assert.match(verifyTask.compiledPrompt, /verified\|unsupported/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("compiler resolves internal and external output template refs", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read");
    mkdirSync(join(cwd, "workflows", "templates"), { recursive: true });
    writeFileSync(join(cwd, "workflows", "templates", "external.json"), JSON.stringify({ extract: { externalItems: ["..."] } }));

    const internalSpec = workflowSpec("unit-scout", {
      outputTemplates: { extract: { items: [{ id: "item-001" }] } },
      workflow: {
        stages: [
          { id: "extract", type: "task", output: { format: "json", templateRef: "#/outputTemplates/extract" }, prompt: "Extract" },
        ],
      },
    });
    const internal = await compileWorkflow(internalSpec, { cwd, task: "Extract" });
    assert.match(internal.tasks[0].compiledPrompt, /"items"/);
    assert.equal(internal.tasks[0].output.templateRef, undefined);

    const externalSpec = workflowSpec("unit-scout", {
      workflow: {
        stages: [
          { id: "extract", type: "task", output: { format: "json", templateRef: "./templates/external.json#/extract" }, prompt: "Extract" },
        ],
      },
    });
    const external = await compileWorkflow(externalSpec, { cwd, specPath: join(cwd, "workflows", "external-workflow.json"), task: "Extract" });
    assert.match(external.tasks[0].compiledPrompt, /"externalItems"/);
    assert.equal(external.tasks[0].output.templateRef, undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("workflow helper loader resolves directory-local helpers", async () => {
  const cwd = makeProject();
  try {
    const workflowDir = join(cwd, "workflows", "bundle");
    mkdirSync(join(workflowDir, "helpers"), { recursive: true });
    const specPath = join(workflowDir, "spec.json");
    const helperPath = join(workflowDir, "helpers", "audit.mjs");
    writeFileSync(specPath, JSON.stringify(workflowSpec("unit-scout")));
    writeFileSync(helperPath, "export default async function helper(input) { return { ok: true, sources: input.sources }; }\n");

    const resolved = await resolveWorkflowHelperRef("./helpers/audit.mjs", specPath);
    assert.equal(resolved.path.endsWith("/workflows/bundle/helpers/audit.mjs"), true);

    const helper = await loadWorkflowHelper("./helpers/audit.mjs", specPath);
    assert.deepEqual(await helper({ sources: { verify: { ok: true } }, context: { specPath, cwd } }), {
      ok: true,
      sources: { verify: { ok: true } },
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("workflow helper loader rejects external or invalid helper refs", async () => {
  const cwd = makeProject();
  try {
    const workflowDir = join(cwd, "workflows", "bundle");
    mkdirSync(join(workflowDir, "helpers"), { recursive: true });
    const specPath = join(workflowDir, "spec.json");
    writeFileSync(specPath, JSON.stringify(workflowSpec("unit-scout")));
    writeFileSync(join(workflowDir, "helpers", "not-function.mjs"), "export default 1;\n");

    await assert.rejects(() => resolveWorkflowHelperRef("../outside.mjs", specPath), /parent-directory/);
    await assert.rejects(() => resolveWorkflowHelperRef("/tmp/outside.mjs", specPath), /directory-local/);
    await assert.rejects(() => resolveWorkflowHelperRef("file://helpers/audit.mjs", specPath), /directory-local/);
    await assert.rejects(() => resolveWorkflowHelperRef("npm:pkg", specPath), /directory-local/);
    await assert.rejects(() => resolveWorkflowHelperRef("~/.pi/helper.mjs", specPath), /directory-local/);
    await assert.rejects(() => resolveWorkflowHelperRef("./helpers/audit.js", specPath), /relative \.mjs file/);
    await assert.rejects(() => loadWorkflowHelper("./helpers/not-function.mjs", specPath), /default-export a function/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("deep-research claim evidence gate downgrades unsupported verified claims", async () => {
  const { default: helper } = await import(`../workflows/deep-research/helpers/claim-evidence-gate.mjs?test=${Date.now()}`);

  const result = await helper({
    sources: {
      "verify-claims.item-001": {
        auditedClaims: [
          { id: "claim-001", status: "verified", text: "The benchmark improved by 42%." },
          { id: "claim-002", status: "verified", text: "The release exists.", evidence: [{ url: "https://example.com/release", fetched: true }] },
        ],
      },
    },
    options: { downgradeExactQuantitativeWithoutSource: true, requireFetchedEvidenceForVerified: true },
    context: {},
  });

  assert.equal(result.gateSummary.total, 2);
  assert.equal(result.gateSummary.downgraded, 1);
  assert.equal(result.auditedClaims[0].status, "partially_supported");
  assert.equal(result.auditedClaims[0].evidenceGate.previous, "verified");
  assert.equal(result.auditedClaims[1].status, "verified");
  assert.deepEqual(result.auditedClaims[1].sourceUrls, ["https://example.com/release"]);
});

test("JSON output parsing picks candidate matching contract paths", () => {
  const output = 'Prose with escaped example `{\\"findings\\": null}` before the final answer.\n\n{"finding":{"title":"kept"},"verdict":"KEEP"}';
  assert.deepEqual(parseJsonOutput(output, ["$.finding", "$.verdict"]), {
    valid: true,
    extracted: true,
    structuredOutput: { finding: { title: "kept" }, verdict: "KEEP" },
  });
});

test("invalid JSON output exhausts retry cap instead of looping", async () => {
  const cwd = makeProject();
  try {
    const taskDir = join(cwd, ".pi", "workflows", "workflow_unit", "tasks", "task-1");
    mkdirSync(taskDir, { recursive: true });
    const output = join(taskDir, "output.log");
    const result = join(taskDir, "result.json");
    writeFileSync(output, '{"item":true');
    const task = {
      taskId: "task-1",
      specId: "plan.main",
      displayName: "plan.main",
      agent: "unit-scout",
      agentFile: "unit-scout.md",
      roles: [],
      status: "running",
      statusDetail: "running",
      runtime: { approvalMode: "non-interactive" },
      cwd,
      worktree: { enabled: false, path: null, branch: null, baseCwd: null, warning: null },
      backendTaskId: "plan.main",
      pid: 12345,
      startedAt: new Date().toISOString(),
      files: {
        systemPrompt: ".pi/workflows/workflow_unit/tasks/task-1/system-prompt.md",
        taskPrompt: ".pi/workflows/workflow_unit/tasks/task-1/task.md",
        output: ".pi/workflows/workflow_unit/tasks/task-1/output.log",
        stderr: ".pi/workflows/workflow_unit/tasks/task-1/stderr.log",
        result: ".pi/workflows/workflow_unit/tasks/task-1/result.json",
      },
      output: { format: "json", contract: { requiredPaths: ["$.item"] }, onInvalid: "fail" },
      outputRetry: { attempts: 1, maxAttempts: 1, reason: "output_invalid", message: "previous invalid output" },
    };

    const changed = await applyTaskResultArtifact(cwd, task, {
      resultFile: result,
      result: { status: "completed", completedAt: new Date().toISOString(), exitCode: 0 },
      status: "completed",
      completedAfterTimeout: false,
    });

    assert.equal(changed, true);
    assert.equal(task.status, "failed");
    assert.equal(task.statusDetail, "output_invalid_exhausted");
    assert.equal(task.outputRetry.attempts, 2);
    assert.equal(JSON.parse(readFileSync(result, "utf8")).failureKind, "output_invalid_exhausted");
    assert.match(readFileSync(`${output}.invalid-attempt-2`, "utf8"), /item/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("JSON output retry prompt includes validation error, self-check, and few-shot examples", () => {
  const prompt = buildJsonOutputRetryInstructions({
    output: { format: "json", contract: { requiredPaths: ["$.item", "$.plan"] }, template: { item: {}, plan: {} }, onInvalid: "fail" },
    outputRetry: {
      attempts: 1,
      maxAttempts: 1,
      reason: "output_invalid",
      message: "expected valid JSON output: missing closing brace",
      artifacts: [],
    },
  });
  assert.match(prompt, /Validation error: expected valid JSON output: missing closing brace/);
  assert.match(prompt, /JSON\.parse\(finalAnswer\) would succeed/);
  assert.match(prompt, /Invalid JSON:/);
  assert.match(prompt, /Required JSON paths:/);
  assert.match(prompt, /\$\.item/);
  assert.match(prompt, /\$\.plan/);
  assert.match(prompt, /# Output JSON Template/);
});

test("stage-first foreach materializes source array into generated tasks with output contract paths", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read");
    const spec = workflowSpec("unit-scout", {
      flow: {
        stages: [
          { id: "extract", type: "task", output: { format: "json", contract: { requiredPaths: ["$.claims"] } }, prompt: "Extract" },
          { id: "verify", type: "foreach", inject: true, from: { stage: "extract", path: "$.claims", mode: "concat" }, maxConcurrency: 2, each: { prompt: "Verify ${item}" } },
          { id: "summary", type: "reduce", from: "verify", prompt: "Summarize" },
        ],
      },
    });
    const compiled = await compileWorkflow(spec, { cwd, task: "Check claims" });
    const { run } = await createStageFirstRunRecord(cwd, compiled, join(cwd, "workflows", "unit.json"));
    await writeStaticRunArtifacts(cwd, run, compiled, spec);

    setTaskTerminal(run.tasks[0], "completed", "completed", { exitCode: 0, lastMessage: "completed" });
    await writeJsonAtomic(join(cwd, run.tasks[0].files.result), {
      status: "completed",
      structuredOutput: { claims: [{ id: "CLAIM_A", text: "A" }, "plain claim"] },
    });
    await writeRunRecord(cwd, run);

    await scheduleRun(cwd, run.runId);
    const materialized = await readRunRecord(cwd, run.runId);
    const specIds = materialized.tasks.map((task) => task.specId);
    assert.deepEqual(specIds, ["extract.main", "verify.claim_a", "verify.item-002", "summary.main"]);
    assert.equal(materialized.tasks.find((task) => task.specId === "verify.claim_a")?.status, "pending");
    assert.equal(materialized.tasks.find((task) => task.specId === "verify.item-002")?.status, "pending");
    assert.deepEqual(JSON.parse(readFileSync(join(cwd, ".pi", "workflows", materialized.runId, "compiled.json"), "utf8")).tasks.find((task) => task.id === "summary.main").dependsOn, ["verify.claim_a", "verify.item-002"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("successive foreach materialization keeps task ids unique with output contract paths", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read");
    const spec = workflowSpec("unit-scout", {
      flow: {
        stages: [
          { id: "extract", type: "task", output: { format: "json", contract: { requiredPaths: ["$.claims"] } }, prompt: "Extract" },
          { id: "review", type: "foreach", from: { stage: "extract", path: "$.claims" }, each: { prompt: "Review ${item}" } },
          { id: "verify", type: "foreach", from: { stage: "review", path: "$.findings", mode: "concat" }, each: { prompt: "Verify ${item}" } },
        ],
      },
    });
    const compiled = await compileWorkflow(spec, { cwd, task: "Check claims" });
    const { run } = await createStageFirstRunRecord(cwd, compiled, join(cwd, "workflows", "unit.json"));
    await writeStaticRunArtifacts(cwd, run, compiled, spec);
    setTaskTerminal(run.tasks[0], "completed", "completed", { exitCode: 0, lastMessage: "completed" });
    await writeJsonAtomic(join(cwd, run.tasks[0].files.result), { status: "completed", structuredOutput: { claims: ["a", "b"] } });
    await writeRunRecord(cwd, run);

    await scheduleRun(cwd, run.runId);
    let current = await readRunRecord(cwd, run.runId);
    for (const task of current.tasks.filter((item) => item.stageId === "review")) {
      setTaskTerminal(task, "completed", "completed", { exitCode: 0, lastMessage: "completed" });
      await writeJsonAtomic(join(cwd, task.files.result), { status: "completed", structuredOutput: { findings: [{ title: `${task.specId}-finding` }] } });
    }
    await writeRunRecord(cwd, current);

    await scheduleRun(cwd, run.runId);
    current = await readRunRecord(cwd, run.runId);
    const taskIds = current.tasks.map((task) => task.taskId);
    assert.equal(new Set(taskIds).size, taskIds.length);
    assert.deepEqual(current.tasks.filter((task) => task.stageId === "verify").map((task) => task.specId), ["verify.item-001", "verify.item-002"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("stage-first transform executes helper and writes artifacts", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read");
    const workflowDir = join(cwd, "workflows", "bundle");
    mkdirSync(join(workflowDir, "helpers"), { recursive: true });
    const specPath = join(workflowDir, "spec.json");
    writeFileSync(join(workflowDir, "helpers", "audit.mjs"), "export default async function helper({ sources, options, context }) { return { audited: sources['extract.main'].claims.length, strict: options.strict, stageId: context.stageId }; }\n");
    const spec = workflowSpec("unit-scout", {
      flow: {
        stages: [
          { id: "extract", type: "task", output: { format: "json" }, prompt: "Extract" },
          { id: "audit", type: "transform", from: "extract", helper: "./helpers/audit.mjs", options: { strict: true } },
        ],
      },
    });
    writeFileSync(specPath, JSON.stringify(spec));
    const compiled = await compileWorkflow(spec, { cwd, task: "Check claims", specPath });
    const { run } = await createStageFirstRunRecord(cwd, compiled, specPath);
    await writeStaticRunArtifacts(cwd, run, compiled, spec);
    writeFileSync(join(workflowDir, "helpers", "audit.mjs"), "export default async function helper() { throw new Error('live helper should not run'); }\n");
    setTaskTerminal(run.tasks[0], "completed", "completed", { exitCode: 0, lastMessage: "completed" });
    await writeJsonAtomic(join(cwd, run.tasks[0].files.result), { status: "completed", structuredOutput: { claims: ["a", "b"] } });
    await writeRunRecord(cwd, run);

    await scheduleRun(cwd, run.runId);
    const updated = await readRunRecord(cwd, run.runId);
    const transform = updated.tasks.find((task) => task.specId === "audit.main");
    assert.equal(transform?.status, "completed");
    assert.equal(transform?.lastMessage, "transform completed");
    assert.deepEqual(JSON.parse(readFileSync(join(cwd, transform.files.result), "utf8")).structuredOutput, {
      audited: 2,
      strict: true,
      stageId: "audit",
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("stage-first transform marks helper errors as failed", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read");
    const workflowDir = join(cwd, "workflows", "bundle");
    mkdirSync(join(workflowDir, "helpers"), { recursive: true });
    const specPath = join(workflowDir, "spec.json");
    writeFileSync(join(workflowDir, "helpers", "fail.mjs"), "export default async function helper() { throw new Error('helper boom'); }\n");
    const spec = workflowSpec("unit-scout", {
      flow: {
        stages: [
          { id: "extract", type: "task", output: { format: "json" }, prompt: "Extract" },
          { id: "audit", type: "transform", from: "extract", helper: "./helpers/fail.mjs" },
        ],
      },
    });
    writeFileSync(specPath, JSON.stringify(spec));
    const compiled = await compileWorkflow(spec, { cwd, task: "Check claims", specPath });
    const { run } = await createStageFirstRunRecord(cwd, compiled, specPath);
    await writeStaticRunArtifacts(cwd, run, compiled, spec);
    setTaskTerminal(run.tasks[0], "completed", "completed", { exitCode: 0, lastMessage: "completed" });
    await writeJsonAtomic(join(cwd, run.tasks[0].files.result), { status: "completed", structuredOutput: { claims: ["a"] } });
    await writeRunRecord(cwd, run);

    await scheduleRun(cwd, run.runId);
    const updated = await readRunRecord(cwd, run.runId);
    const transform = updated.tasks.find((task) => task.specId === "audit.main");
    assert.equal(transform?.status, "failed");
    assert.equal(transform?.statusDetail, "launch_failed");
    assert.match(transform?.lastMessage ?? "", /helper boom/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("stage-first foreach blocks when maxItems is exceeded with output contract paths", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read");
    const spec = workflowSpec("unit-scout", {
      flow: {
        stages: [
          { id: "extract", type: "task", output: { format: "json", contract: { requiredPaths: ["$.claims"] } }, prompt: "Extract" },
          { id: "verify", type: "foreach", from: { stage: "extract", path: "$.claims" }, maxItems: 1, each: { prompt: "Verify ${item}" } },
        ],
      },
    });
    const compiled = await compileWorkflow(spec, { cwd, task: "Check claims" });
    const { run } = await createStageFirstRunRecord(cwd, compiled, join(cwd, "workflows", "unit.json"));
    await writeStaticRunArtifacts(cwd, run, compiled, spec);
    setTaskTerminal(run.tasks[0], "completed", "completed", { exitCode: 0, lastMessage: "completed" });
    await writeJsonAtomic(join(cwd, run.tasks[0].files.result), { status: "completed", structuredOutput: { claims: ["a", "b"] } });
    await writeRunRecord(cwd, run);

    await scheduleRun(cwd, run.runId);
    const blocked = await readRunRecord(cwd, run.runId);
    assert.equal(blocked.tasks[1].status, "blocked");
    assert.match(blocked.tasks[1].lastMessage, /exceeding maxItems=1/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("output contract retry preserves DAG source context", async () => {
  const cwd = makeProject();
  let capturedPrompt = "";
  try {
    writeAgent(cwd, "unit-scout", "read");
    setSubagentApiForTests({
      async runSubagent(options) {
        capturedPrompt = String(options.task ?? "");
        return { runId: "run_stub", attemptId: "attempt_stub", status: "running" };
      },
      async getSubagentStatus() { return null; },
      async reconcileSubagentRun() { return {}; },
      async interruptSubagent() { return {}; },
    });

    const spec = workflowSpec("unit-scout", {
      workflow: {
        stages: [
          { id: "extract", type: "task", output: { format: "json" }, prompt: "Extract source facts." },
          {
            id: "final",
            type: "reduce",
            from: "extract",
            output: { format: "json", contract: { requiredPaths: ["$.summary"] }, onInvalid: "fail" },
            prompt: "Summarize source facts.",
          },
        ],
      },
    });
    const compiled = await compileWorkflow(spec, { cwd, task: "Review topic" });
    const { run } = await createStageFirstRunRecord(cwd, compiled, join(cwd, "workflows", "unit.json"));
    await writeStaticRunArtifacts(cwd, run, compiled, spec);

    const sourceTask = run.tasks[0];
    mkdirSync(dirname(join(cwd, sourceTask.files.output)), { recursive: true });
    writeFileSync(join(cwd, sourceTask.files.output), "source fact alpha");
    await writeJsonAtomic(join(cwd, sourceTask.files.result), {
      status: "completed",
      structuredOutput: { facts: ["source fact alpha"] },
    });
    setTaskTerminal(sourceTask, "completed", "completed", { exitCode: 0, lastMessage: "completed" });

    const finalTask = run.tasks[1];
    finalTask.status = "pending";
    finalTask.statusDetail = "retry_output_invalid";
    finalTask.outputRetry = { attempts: 1, maxAttempts: 1, reason: "output_invalid", message: "missing $.summary" };
    mkdirSync(dirname(join(cwd, finalTask.files.output)), { recursive: true });
    writeFileSync(`${join(cwd, finalTask.files.output)}.invalid-attempt-1`, '{"wrong":true}\n');
    await writeRunRecord(cwd, run);

    await scheduleRun(cwd, run.runId);

    assert.match(capturedPrompt, /# Source Stage Context/);
    assert.match(capturedPrompt, /source fact alpha/);
    assert.match(capturedPrompt, /# Output Contract Retry Instructions/);
    assert.match(capturedPrompt, /missing \$\.summary/);
  } finally {
    setSubagentApiForTests(undefined);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("subagent launch forwards tool-call capture only when env is enabled", async () => {
  const cwd = makeProject();
  const previous = process.env.PI_WORKFLOW_CAPTURE_TOOL_CALLS;
  const captured = [];
  try {
    writeAgent(cwd, "unit-scout", "read");
    setSubagentApiForTests({
      async runSubagent(options) {
        captured.push(options);
        return { runId: `run_stub_${captured.length}`, attemptId: `attempt_stub_${captured.length}`, status: "running" };
      },
      async getSubagentStatus() { return null; },
      async reconcileSubagentRun() { return {}; },
      async interruptSubagent() { return {}; },
    });

    const spec = workflowSpec("unit-scout", { workflow: { stages: [{ id: "main", type: "task", prompt: "Do work." }] } });
    const compiled = await compileWorkflow(spec, { cwd, task: "Review topic" });

    delete process.env.PI_WORKFLOW_CAPTURE_TOOL_CALLS;
    const first = await createStageFirstRunRecord(cwd, compiled, join(cwd, "workflows", "unit-a.json"));
    await writeStaticRunArtifacts(cwd, first.run, compiled, spec);
    await writeRunRecord(cwd, first.run);
    await scheduleRun(cwd, first.run.runId);
    assert.equal(captured[0].captureToolCalls, undefined);

    process.env.PI_WORKFLOW_CAPTURE_TOOL_CALLS = "1";
    const second = await createStageFirstRunRecord(cwd, compiled, join(cwd, "workflows", "unit-b.json"));
    await writeStaticRunArtifacts(cwd, second.run, compiled, spec);
    await writeRunRecord(cwd, second.run);
    await scheduleRun(cwd, second.run.runId);
    assert.equal(captured[1].captureToolCalls, true);
  } finally {
    if (previous === undefined) delete process.env.PI_WORKFLOW_CAPTURE_TOOL_CALLS;
    else process.env.PI_WORKFLOW_CAPTURE_TOOL_CALLS = previous;
    setSubagentApiForTests(undefined);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("subagent launch loads provider extensions for extension-backed tools", async () => {
  const cwd = makeProject();
  let captured;
  try {
    writeAgent(cwd, "unit-researcher", "read, web_search, fetch_content, get_search_content");
    setSubagentApiForTests({
      async runSubagent(options) {
        captured = options;
        return { runId: "run_stub", attemptId: "attempt_stub", status: "running" };
      },
      async getSubagentStatus() { return null; },
      async reconcileSubagentRun() { return {}; },
      async interruptSubagent() { return {}; },
    });

    const spec = workflowSpec("unit-researcher", {
      tools: ["read", "web_search", "fetch_content", "get_search_content"],
      workflow: { stages: [{ id: "main", type: "task", prompt: "Research with web tools." }] },
    });
    const compiled = await compileWorkflow(spec, { cwd, task: "Research topic" });
    const { run } = await createStageFirstRunRecord(cwd, compiled, join(cwd, "workflows", "unit.json"));
    await writeStaticRunArtifacts(cwd, run, compiled, spec);
    await writeRunRecord(cwd, run);
    await scheduleRun(cwd, run.runId);

    assert.deepEqual(captured.extensions, ["npm:pi-web-access"]);
  } finally {
    setSubagentApiForTests(undefined);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("subagent launch merges object-form provider extensions with built-in mappings", async () => {
  const cwd = makeProject();
  let captured;
  try {
    writeAgent(cwd, "unit-researcher", "read, fetch_content, scrapling_fetch");
    setSubagentApiForTests({
      async runSubagent(options) {
        captured = options;
        return { runId: "run_stub", attemptId: "attempt_stub", status: "running" };
      },
      async getSubagentStatus() { return null; },
      async reconcileSubagentRun() { return {}; },
      async interruptSubagent() { return {}; },
    });

    const spec = workflowSpec("unit-researcher", {
      tools: [
        "read",
        "fetch_content",
        {
          name: "scrapling_fetch",
          extensions: ["npm:pi-web-access", "packages/pi-scrapling-access"],
          classification: "read-only",
        },
      ],
      workflow: { stages: [{ id: "main", type: "task", prompt: "Research with custom fetch fallback." }] },
    });
    const compiled = await compileWorkflow(spec, { cwd, task: "Research topic" });
    const { run } = await createStageFirstRunRecord(cwd, compiled, join(cwd, "workflows", "unit.json"));
    await writeStaticRunArtifacts(cwd, run, compiled, spec);
    await writeRunRecord(cwd, run);
    await scheduleRun(cwd, run.runId);

    assert.deepEqual(captured.tools, ["read", "fetch_content", "scrapling_fetch"]);
    assert.deepEqual(captured.extensions, ["npm:pi-web-access", "packages/pi-scrapling-access"]);
  } finally {
    setSubagentApiForTests(undefined);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("completed subagent with contextLengthExceeded and valid output remains completed", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read");
    const compiled = await compileWorkflow(workflowSpec("unit-scout", {
      workflow: {
        stages: [{
          id: "main",
          type: "task",
          output: { format: "json", onInvalid: "fail", contract: { requiredPaths: ["$.ok"] } },
          prompt: "Return JSON.",
        }],
      },
    }), { cwd, task: "Review topic" });
    const { run } = await createStageFirstRunRecord(cwd, compiled, join(cwd, "workflows", "unit.json"));
    await writeStaticRunArtifacts(cwd, run, compiled, workflowSpec("unit-scout"));
    const task = run.tasks[0];
    task.status = "running";
    task.statusDetail = "running";
    task.startedAt = new Date().toISOString();
    task.backendHandle = { engine: "pi-subagent", backend: "headless", runId: "run_context", attemptId: "attempt_context", cwd, runsDir: ".pi/workflow-subagents/context", display: "pi-subagent/headless run_context/attempt_context" };

    const artifactDir = join(cwd, ".fake-context-subagent");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, "output.log"), '{"ok":true}\n');
    writeFileSync(join(artifactDir, "stderr.log"), "");
    writeFileSync(join(artifactDir, "tool-calls-summary.json"), JSON.stringify({
      enabled: true,
      totalCalls: 1,
      callsByTool: { fetch_content: 1 },
      callsByCategory: { network: 1 },
      errorsByTool: {},
      resources: { urls: ["https://docs.example.test/a"], hosts: ["docs.example.test"] },
    }));
    writeFileSync(join(artifactDir, "result.json"), JSON.stringify({
      status: "completed",
      completedAt: new Date().toISOString(),
      startedAt: task.startedAt,
      exitCode: 0,
      cwd,
      metadata: { contextLengthExceeded: true, stopReason: "stop" },
      artifacts: [
        { type: "tool-calls-summary", path: ".fake-context-subagent/tool-calls-summary.json" },
      ],
    }));

    setSubagentApiForTests({
      async runSubagent() { throw new Error("not expected"); },
      async reconcileSubagentRun() { return {}; },
      async getSubagentStatus() {
        return {
          runId: "run_context",
          attemptId: "attempt_context",
          backend: "headless",
          status: "completed",
          failureKind: null,
          startedAt: task.startedAt,
          completedAt: new Date().toISOString(),
          logs: [
            { type: "output", path: ".fake-context-subagent/output.log", artifactCwd: cwd },
            { type: "stderr", path: ".fake-context-subagent/stderr.log", artifactCwd: cwd },
            { type: "result", path: ".fake-context-subagent/result.json", artifactCwd: cwd },
          ],
          metadata: { contextLengthExceeded: true, stopReason: "stop" },
          attempts: [{ attemptId: "attempt_context", status: "completed", pid: 99999999 }],
        };
      },
      async interruptSubagent() { return {}; },
    });

    await writeRunRecord(cwd, run);
    const refreshed = await refreshRunFromSubagentArtifacts(cwd, await readRunRecord(cwd, run.runId));
    const refreshedTask = refreshed.tasks[0];
    const workflowResult = JSON.parse(readFileSync(join(cwd, refreshedTask.files.result), "utf8"));
    assert.equal(refreshedTask.status, "completed");
    assert.equal(refreshedTask.outputValidation.status, "valid");
    assert.equal(workflowResult.contextLengthExceeded, true);
    assert.equal(workflowResult.failureKind, undefined);
    assert.deepEqual(workflowResult.structuredOutput, { ok: true });
    assert.equal(workflowResult.subagent.toolCalls.totalCalls, 1);
    assert.deepEqual(workflowResult.subagent.toolCalls.callsByTool, { fetch_content: 1 });
    assert.equal(workflowResult.subagent.toolCallsSummaryPath, ".fake-context-subagent/tool-calls-summary.json");
  } finally {
    setSubagentApiForTests(undefined);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("refresh adopts handle-less running subagent from deterministic runsDir", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read");
    const compiled = await compileWorkflow(workflowSpec("unit-scout", {
      workflow: { stages: [{ id: "main", type: "task", prompt: "Do work." }] },
    }), { cwd, task: "Review topic" });
    const { run } = await createStageFirstRunRecord(cwd, compiled, join(cwd, "workflows", "unit.json"));
    await writeStaticRunArtifacts(cwd, run, compiled, workflowSpec("unit-scout"));
    const task = run.tasks[0];
    task.status = "running";
    task.statusDetail = "launching";
    task.startedAt = new Date().toISOString();
    delete task.backendHandle;

    const subRunId = "run_recovered";
    const subAttemptId = "attempt_recovered";
    const runsDir = join(cwd, ".pi", "workflow-subagents", run.runId, task.taskId);
    const subRunDir = join(runsDir, subRunId);
    mkdirSync(subRunDir, { recursive: true });
    writeFileSync(join(subRunDir, "run.json"), JSON.stringify({
      runId: subRunId,
      correlationId: `${run.runId}:${task.taskId}`,
      status: "completed",
      backend: "headless",
      startedAt: task.startedAt,
      updatedAt: new Date().toISOString(),
      latestAttemptId: subAttemptId,
      attempts: [{ attemptId: subAttemptId, status: "completed", backend: "headless", startedAt: task.startedAt, updatedAt: new Date().toISOString() }],
    }));

    const artifactDir = join(cwd, ".fake-subagent");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, "output.log"), "adopted output\n");
    writeFileSync(join(artifactDir, "stderr.log"), "");
    writeFileSync(join(artifactDir, "result.json"), JSON.stringify({
      status: "completed",
      completedAt: new Date().toISOString(),
      startedAt: task.startedAt,
      exitCode: 0,
      metadata: { contextLengthExceeded: false },
    }));

    setSubagentApiForTests({
      async runSubagent() { throw new Error("not expected"); },
      async reconcileSubagentRun() { return {}; },
      async getSubagentStatus() {
        return {
          runId: subRunId,
          attemptId: subAttemptId,
          backend: "headless",
          status: "completed",
          failureKind: null,
          startedAt: task.startedAt,
          completedAt: new Date().toISOString(),
          logs: [
            { type: "output", path: ".fake-subagent/output.log", artifactCwd: cwd },
            { type: "stderr", path: ".fake-subagent/stderr.log", artifactCwd: cwd },
            { type: "result", path: ".fake-subagent/result.json", artifactCwd: cwd },
          ],
          metadata: { contextLengthExceeded: false },
          attempts: [{ attemptId: subAttemptId, status: "completed", pid: 99999999 }],
        };
      },
      async interruptSubagent() { return {}; },
    });

    await writeRunRecord(cwd, run);
    const refreshed = await refreshRunFromSubagentArtifacts(cwd, await readRunRecord(cwd, run.runId));
    assert.equal(refreshed.tasks[0].status, "completed");
    assert.equal(refreshed.tasks[0].backendHandle, undefined);
    const workflowResult = JSON.parse(readFileSync(join(cwd, refreshed.tasks[0].files.result), "utf8"));
    assert.equal(workflowResult.subagent.runId, subRunId);
    assert.equal(readFileSync(join(cwd, refreshed.tasks[0].files.output), "utf8"), "adopted output\n");
  } finally {
    setSubagentApiForTests(undefined);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runtime model resolver defaults to current model and thinking", async () => {
  const resolved = await resolveWorkflowRuntime({}, {
    taskKey: "main.main",
    stageId: "main",
    taskId: "main",
    agent: "unit-scout",
  }, {
    defaults: { model: "openai-codex/gpt-5.5", thinking: "high" },
    availableModels: [{ provider: "openai-codex", id: "gpt-5.5", fullId: "openai-codex/gpt-5.5", reasoning: true }],
  });

  assert.deepEqual(resolved, { model: "openai-codex/gpt-5.5", thinking: "high" });
});

test("runtime model resolver asks before choosing ambiguous enabled models", async () => {
  const selections = [];
  const resolved = await resolveWorkflowRuntime({ model: "gpt-5.5" }, {
    taskKey: "main.main",
    stageId: "main",
    taskId: "main",
    agent: "unit-scout",
  }, {
    defaults: { thinking: "medium" },
    availableModels: [
      { provider: "openai-codex", id: "gpt-5.5", fullId: "openai-codex/gpt-5.5", reasoning: true },
      { provider: "github-copilot", id: "gpt-5.5", fullId: "github-copilot/gpt-5.5", reasoning: true },
    ],
    prompt: {
      async select(_title, options) {
        selections.push(options);
        return "github-copilot/gpt-5.5";
      },
    },
  });

  assert.deepEqual(selections, [["github-copilot/gpt-5.5", "openai-codex/gpt-5.5"]]);
  assert.deepEqual(resolved, { model: "github-copilot/gpt-5.5", thinking: "medium" });
});

test("runtime model resolver asks before choosing an available model when requested model is missing", async () => {
  const selections = [];
  const resolved = await resolveWorkflowRuntime({ model: "gpt-6" }, {
    taskKey: "main.main",
    stageId: "main",
    taskId: "main",
    agent: "unit-scout",
  }, {
    availableModels: [
      { provider: "openai-codex", id: "gpt-5.5", fullId: "openai-codex/gpt-5.5", reasoning: true },
      { provider: "kimi-coding", id: "kimi-for-coding", fullId: "kimi-coding/kimi-for-coding", reasoning: true },
    ],
    prompt: {
      async select(_title, options) {
        selections.push(options);
        return "kimi-coding/kimi-for-coding";
      },
    },
  });

  assert.deepEqual(selections, [["kimi-coding/kimi-for-coding", "openai-codex/gpt-5.5"]]);
  assert.deepEqual(resolved, { model: "kimi-coding/kimi-for-coding" });
});

test("runtime model resolver asks before changing unsupported thinking", async () => {
  const resolved = await resolveWorkflowRuntime({ model: "gpt-5.5", thinking: "xhigh" }, {
    taskKey: "main.main",
    stageId: "main",
    taskId: "main",
    agent: "unit-scout",
  }, {
    availableModels: [{
      provider: "openai-codex",
      id: "gpt-5.5",
      fullId: "openai-codex/gpt-5.5",
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, low: null, medium: "medium", high: "high" },
    }],
    prompt: {
      async select(_title, options) {
        assert.deepEqual(options, ["medium", "high"]);
        return "high";
      },
    },
  });

  assert.deepEqual(resolved, { model: "openai-codex/gpt-5.5", thinking: "high" });
});

test("runtime model resolver refuses ambiguity, missing model, or unsupported thinking without UI", async () => {
  const context = { taskKey: "main.main", stageId: "main", taskId: "main", agent: "unit-scout" };
  const availableModels = [
    { provider: "openai-codex", id: "gpt-5.5", fullId: "openai-codex/gpt-5.5", reasoning: true },
    { provider: "github-copilot", id: "gpt-5.5", fullId: "github-copilot/gpt-5.5", reasoning: true },
  ];

  await assert.rejects(
    () => resolveWorkflowRuntime({ model: "gpt-5.5" }, context, { availableModels }),
    /ambiguous in \/model/,
  );
  await assert.rejects(
    () => resolveWorkflowRuntime({ model: "openai-codex/gpt-5.5", thinking: "xhigh" }, context, {
      availableModels: [{ provider: "openai-codex", id: "gpt-5.5", fullId: "openai-codex/gpt-5.5", reasoning: false }],
    }),
    /does not support reasoning level "xhigh"/,
  );
});

test("compiler applies runtime defaults before budget estimates", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read");
    const compiled = await compileWorkflow(workflowSpec("unit-scout", {
      budget: {
        expectedOutputTokensPerTask: 100,
        modelRates: { "openai-codex/gpt-5.5": { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 } },
      },
    }), { cwd, task: "Summarize", runtimeDefaults: { model: "openai-codex/gpt-5.5", thinking: "high" } });

    assert.equal(compiled.tasks[0].runtime.model, "openai-codex/gpt-5.5");
    assert.equal(compiled.tasks[0].runtime.thinking, "high");
    assert.equal(compiled.budget.models[0].model, "openai-codex/gpt-5.5");
    assert.equal(compiled.budget.unratedModels.length, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run boundary requires runtime task", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read");
    writeFileSync(join(cwd, "workflow.json"), JSON.stringify(workflowSpec("unit-scout")));
    await assert.rejects(() => runWorkflow("workflow.json", cwd), /This workflow needs a task/);
    await assert.rejects(() => runWorkflow("workflow.json", cwd, { task: "   " }), /This workflow needs a task/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("static run artifacts preserve workflow bundle files", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read");
    const workflowDir = join(cwd, "workflows", "bundle");
    mkdirSync(join(workflowDir, "helpers"), { recursive: true });
    const specPath = join(workflowDir, "spec.json");
    const spec = workflowSpec("unit-scout", { name: "bundle" });
    writeFileSync(specPath, JSON.stringify(spec));
    writeFileSync(join(workflowDir, "templates.json"), JSON.stringify({ audit: { ok: true } }));
    writeFileSync(join(workflowDir, "helpers", "audit.mjs"), "export default () => ({ ok: true });\n");

    const compiled = await compileWorkflow(spec, { cwd, task: "Summarize", specPath });
    const { run } = await createStageFirstRunRecord(cwd, compiled, specPath);
    await writeStaticRunArtifacts(cwd, run, compiled, spec);

    assert.equal(readFileSync(join(cwd, ".pi", "workflows", run.runId, "bundle", "templates.json"), "utf8"), JSON.stringify({ audit: { ok: true } }));
    assert.match(readFileSync(join(cwd, ".pi", "workflows", run.runId, "bundle", "helpers", "audit.mjs"), "utf8"), /export default/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run records use workflow-v1 type and derive completion", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd, "unit-scout", "read");
    const compiled = await compileWorkflow(workflowSpec("unit-scout"), { cwd, task: "Summarize" });
    const { run } = await createStageFirstRunRecord(cwd, compiled, join(cwd, "workflow.json"));
    assert.equal(run.type, STAGE_FIRST_RUN_TYPE);
    assert.equal(run.type, "workflow-v1");
    assert.match(formatRun(run), /type=workflow/);
    setTaskTerminal(run.tasks[0], "completed", "completed");
    assert.equal(deriveRunStatus(run).status, "completed");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("workflow registry resolves exact names and recommendation metadata", async () => {
  const cwd = makeProject();
  try {
    mkdirSync(join(cwd, "workflows"), { recursive: true });
    writeFileSync(join(cwd, "workflows", "review.json"), JSON.stringify(workflowSpec("unit-scout", {
      name: "review",
      catalog: {
        useWhen: ["standard review"],
        avoidWhen: ["implementation"],
        mutationRisk: "read-only",
        naturalLanguageTriggers: ["review this change"],
      },
    })));

    const workflows = await listWorkflows(cwd);
    assert.deepEqual(workflows.map((item) => item.name), ["review"]);
    const resolved = await resolveWorkflowRef("review", cwd);
    assert.equal(resolved.workflowName, "review");
    const loaded = await loadWorkflow("review", cwd);
    assert.equal(loaded.spec.name, "review");
    const recs = await recommendWorkflows("please review this change", cwd);
    assert.equal(recs[0].workflow.name, "review");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("workflow registry resolves bundle specs and sets correct workflowRoot", async () => {
  const cwd = makeProject();
  try {
    mkdirSync(join(cwd, "workflows", "bundle-wf"), { recursive: true });
    writeFileSync(join(cwd, "workflows", "bundle-wf", "spec.json"), JSON.stringify(workflowSpec("unit-scout", {
      name: "bundle-wf",
      catalog: { useWhen: ["bundle testing"] },
    })));

    const workflows = await listWorkflows(cwd);
    const bundleRecord = workflows.find((workflow) => workflow.name === "bundle-wf");
    assert.ok(bundleRecord);
    assert.equal(bundleRecord.specPath, join(cwd, "workflows", "bundle-wf", "spec.json"));
    assert.equal(bundleRecord.workflowRoot, join(cwd, "workflows", "bundle-wf"));
    assert.deepEqual(bundleRecord.aliases, ["bundle-wf"]);

    const resolved = await resolveWorkflowRef("bundle-wf", cwd);
    assert.equal(resolved.workflowName, "bundle-wf");
    assert.equal(resolved.workflowRoot, join(cwd, "workflows", "bundle-wf"));

    const loaded = await loadWorkflow("bundle-wf", cwd);
    assert.equal(loaded.spec.name, "bundle-wf");
    assert.equal(loaded.specPath, join(cwd, "workflows", "bundle-wf", "spec.json"));

    // Run-state directories store a spec.json snapshot; they must never
    // register as workflows even though they live under .pi/workflows/.
    mkdirSync(join(cwd, ".pi", "workflows", "workflow_mq99zzzz_abc123"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "workflows", "workflow_mq99zzzz_abc123", "spec.json"), JSON.stringify(workflowSpec("unit-scout", { name: "bundle-wf" })));
    const withRunState = await listWorkflows(cwd);
    assert.ok(!withRunState.some((workflow) => workflow.specPath.includes("workflow_mq99zzzz_abc123")));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("workflow registry fails closed when flat and bundle specs conflict", async () => {
  const cwd = makeProject();
  try {
    mkdirSync(join(cwd, "workflows", "ambiguous"), { recursive: true });
    writeFileSync(join(cwd, "workflows", "ambiguous.json"), JSON.stringify(workflowSpec("unit-scout", { name: "ambiguous" })));
    writeFileSync(join(cwd, "workflows", "ambiguous", "spec.json"), JSON.stringify(workflowSpec("unit-scout", { name: "ambiguous" })));

    await assert.rejects(
      () => resolveWorkflowRef("ambiguous", cwd),
      /ambiguous workflow name/,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("workflow command completions and run arg parsing preserve task text", () => {
  const workflows = [{ name: "review", specPath: "/tmp/review.json", fileName: "review.json", aliases: ["review"], workflowRoot: "/tmp" }];
  assert.deepEqual(workflowArgumentCompletions("", workflows)?.map((item) => item.value), ["help", "list", "recommend", "validate", "roles", "agents", "run", "status", "show", "logs", "wait"]);
  assert.deepEqual(workflowArgumentCompletions("l", workflows)?.map((item) => item.value), ["list", "logs"]);
  assert.deepEqual(workflowArgumentCompletions("run re", workflows)?.map((item) => item.value), ["run review"]);
  assert.deepEqual(workflowArgumentCompletions("validate re", workflows)?.map((item) => item.value), ["validate review"]);
  assert.deepEqual(parseWorkflowRunArgs("run review Fix this:\n  const x = 1;"), { specPath: "review", task: "Fix this:\n  const x = 1;" });
  assert.deepEqual(parseWorkflowRunArgs("run review \"Fix the thing\""), { specPath: "review", task: "Fix the thing" });
});

test("resolveFlowsCwd finds ancestor workflow state root", async () => {
  const cwd = makeProject();
  try {
    mkdirSync(join(cwd, ".pi", "workflows"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "workflows", "index.json"), JSON.stringify({ schemaVersion: 1, updatedAt: "2026-06-04T00:00:00.000Z", runs: [] }));
    const nested = join(cwd, "a", "b");
    mkdirSync(nested, { recursive: true });
    assert.equal(await resolveFlowsCwd(nested), cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
