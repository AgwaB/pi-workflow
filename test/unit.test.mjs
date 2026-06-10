import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { parseAgentMarkdown } from "../.tmp/unit/agents.js";
import { compileWorkflow } from "../.tmp/unit/compiler.js";
import { evaluateLoopUntilCondition, formatRun, runWorkflow, scheduleRun } from "../.tmp/unit/engine.js";
import { workflowArgumentCompletions, parseWorkflowRunArgs } from "../.tmp/unit/extension.js";
import { listWorkflows, recommendWorkflows, resolveWorkflowRef } from "../.tmp/unit/workflow-specs.js";
import { resolveWorkflowRuntime } from "../.tmp/unit/model-runtime.js";
import { loadWorkflow, parseWorkflow } from "../.tmp/unit/schema.js";
import { acquireSupervisorLease, createStageFirstRunRecord, deriveRunStatus, heartbeatSupervisorLease, readRunRecord, resolveFlowsCwd, setTaskTerminal, supervisorLeasePath, workflowProcessRoleForTests, workflowSupervisorOwnerIdForTests, writeJsonAtomic, writeRunRecord, writeStaticRunArtifacts } from "../.tmp/unit/store.js";
import { WorkflowValidationError, STAGE_FIRST_RUN_TYPE } from "../.tmp/unit/types.js";
import { applyTaskResultArtifact, buildJsonOutputRetryInstructions, extractJsonOutput, parseJsonOutput } from "../.tmp/unit/result.js";
import { canStageProceedAfterPreviousFailure, extractStageFirstForeachItems, shouldScheduleAfterStageFailure } from "../.tmp/unit/workflow-runtime.js";
import { deriveWorkflowStatus, isActiveTaskStatus, isNonCompletedTerminalTaskStatus, summarizeTasks } from "../.tmp/unit/status.js";
import { assertWorkflowActionAllowedForRole, assertWorkflowToolAllowedForRole, getWorkflowProcessRole, isWorkflowSupervisorEnabled, workflowWorkerEnvPrefix } from "../.tmp/unit/process-role.js";

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
  assert.equal(isActiveTaskStatus("pending"), true);
  assert.equal(isNonCompletedTerminalTaskStatus("skipped"), true);
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
  assert.deepEqual(parseJsonOutput(output, ["finding", "verdict"]), {
    valid: true,
    extracted: true,
    structuredOutput: { finding: { title: "kept" }, verdict: "KEEP" },
  });
});

test("invalid JSON output schedules one corrective retry and preserves artifacts", async () => {
  const cwd = makeProject();
  try {
    const taskDir = join(cwd, ".pi", "workflows", "workflow_unit", "stages", "plan", "tasks", "main");
    mkdirSync(taskDir, { recursive: true });
    const output = join(taskDir, "output.log");
    const stderr = join(taskDir, "stderr.log");
    const result = join(taskDir, "result.json");
    writeFileSync(output, '{"item":{"id":"x"},"plan":{"steps":[]}\n');
    writeFileSync(stderr, "");
    const task = {
      taskId: "plan.main",
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
      paneId: "%1",
      pid: 12345,
      startedAt: new Date().toISOString(),
      launchToken: "token-1",
      files: {
        systemPrompt: ".pi/workflows/workflow_unit/stages/plan/tasks/main/system-prompt.md",
        taskPrompt: ".pi/workflows/workflow_unit/stages/plan/tasks/main/task.md",
        output: ".pi/workflows/workflow_unit/stages/plan/tasks/main/output.log",
        stderr: ".pi/workflows/workflow_unit/stages/plan/tasks/main/stderr.log",
        result: ".pi/workflows/workflow_unit/stages/plan/tasks/main/result.json",
      },
      output: { format: "json", requiredKeys: ["item", "plan"], onInvalid: "fail" },
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
    assert.equal(task.outputRetry.attempts, 1);
    assert.equal(task.outputRetry.requiredKeys.join(","), "item,plan");
    assert.equal(task.paneId, undefined);
    assert.equal(task.pid, undefined);
    assert.equal(task.startedAt, undefined);
    assert.equal(task.launchToken, undefined);
    assert.match(readFileSync(`${output}.invalid-attempt-1`, "utf8"), /"item"/);
    assert.equal(JSON.parse(readFileSync(`${result}.invalid-attempt-1`, "utf8")).failureKind, "output_invalid");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("JSON output retry prompt includes validation error, self-check, and few-shot examples", () => {
  const prompt = buildJsonOutputRetryInstructions({
    output: { format: "json", requiredKeys: ["item", "plan"], onInvalid: "fail" },
    outputRetry: {
      attempts: 1,
      maxAttempts: 1,
      reason: "output_invalid",
      message: "expected valid JSON output: missing closing brace",
      requiredKeys: ["item", "plan"],
      artifacts: [],
    },
  });
  assert.match(prompt, /Validation error: expected valid JSON output: missing closing brace/);
  assert.match(prompt, /JSON\.parse\(finalAnswer\) would succeed/);
  assert.match(prompt, /Invalid JSON:/);
  assert.match(prompt, /Valid shape:/);
  assert.match(prompt, /"item"/);
  assert.match(prompt, /"plan"/);
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
    writeAgent(cwd, "unit-scout", "read");
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

test("workflow command completions and run arg parsing preserve task text", () => {
  const workflows = [{ name: "review", specPath: "/tmp/review.json", fileName: "review.json", aliases: ["review"], workflowRoot: "/tmp" }];
  assert.deepEqual(workflowArgumentCompletions("workflow ", workflows)?.map((item) => item.value), ["workflow list", "workflow show"]);
  assert.deepEqual(workflowArgumentCompletions("run re", workflows)?.map((item) => item.value), ["run review"]);
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
