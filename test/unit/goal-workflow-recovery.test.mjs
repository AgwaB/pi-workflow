import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  claimWorkflowGoalRecovery,
  completeWorkflowGoalRecovery,
  goalRecoveryBaselineHash,
  goalRecoveryPreview,
  planWorkflowGoalRecovery,
  readWorkflowGoalRecoveredBy,
  seedWorkflowGoalRecoveryCandidate,
} from "../../.tmp/unit/goal-workflow-recovery.js";
import { loadWorkflowSpec } from "../../.tmp/unit/schema.js";
import { parseGoalWorkflowSpec } from "../../.tmp/unit/goal-workflow-schema.js";
import { workflowDefinitionFingerprint } from "../../.tmp/unit/execution-profile.js";
import { observeGoalWorkspaceOrigin, prepareGoalWorkspaceHost } from "../../.tmp/unit/goal-workspace-host.js";

const roots = [];
after(() => Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))));
const RUN = "workflow_mvzrecov_a1b2c3";
const CHILD = "workflow_mvzrecov_c4d5e6";
const hex = text => Buffer.from(text).toString("hex");
const json = (path, value) => writeFile(path, JSON.stringify(value, null, 1));

const authoredDefinition = {
  schemaVersion: 1, name: "recover-me", goal: {
    objective: "Make a equal 2",
    criteria: [{ id: "tests", verifier: { kind: "deterministic", producerId: "command-exit-v1", target: "candidate",
      subject: { resultSlot: "result", artifact: "control" }, config: { argv: ["node", "--test"] } } }],
    authority: { allowedPaths: ["src/a.mjs"], protectedPaths: ["test/a.test.mjs"],
      allowedEffects: ["read", "candidate-write", "verify", "origin-apply", "workflow-create"] },
    limits: { requests: 12 },
  },
};

/** An interrupted root Goal run as a dead Pi session leaves it. */
async function interruptedRun({ candidateText = "export const a = 2;\n", achieved = false } = {}) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "goal-recovery-")));
  roots.push(cwd);
  await mkdir(join(cwd, "src")); await mkdir(join(cwd, "test")); await mkdir(join(cwd, "workflows"));
  await writeFile(join(cwd, "src", "a.mjs"), "export const a = 1;\n");
  await writeFile(join(cwd, "test", "a.test.mjs"), "// test\n");
  const usesPath = join(cwd, "workflows", "goal.json");
  await json(usesPath, authoredDefinition);
  const definition = parseGoalWorkflowSpec((await loadWorkflowSpec(usesPath, cwd)).spec);
  const fingerprint = workflowDefinitionFingerprint(definition);
  const runDir = join(cwd, ".pi", "workflows", RUN);
  await mkdir(join(runDir, "tasks", "task-1", "goal-evidence"), { recursive: true });
  await json(join(runDir, "run.json"), { schemaVersion: 1, runId: RUN, name: "recover-me", status: "running", cwd,
    goalParticipation: { schemaVersion: 1, resumeRequired: false, goalPaths: ["goal"] },
    tasks: [{ taskId: "task-1", specId: "goal.main", kind: "goal", status: "pending",
      files: { result: `.pi/workflows/${RUN}/tasks/task-1/result.json` },
      ...(achieved ? { goal: { state: "engine:achieved" } } : {}),
      goalRoot: { generations: [{ generation: 0 }, { generation: 1 }] } }] });
  await json(join(runDir, "compiled.json"), { task: "Finish a", tasks: [{ id: "goal.main", kind: "goal",
    goal: { usesPath, definition, definitionFingerprint: fingerprint } }] });
  const origin = await observeGoalWorkspaceOrigin({ originRoot: cwd, repository: "nonGit",
    scope: ["src/a.mjs"], protectedPaths: ["test/a.test.mjs"], controlRoots: [join(cwd, ".pi")] });
  const candidate = { schemaVersion: 1, workspaceId: "goal-old-workspace",
    baselineHash: goalRecoveryBaselineHash(definition, "goal-old-workspace", origin),
    files: [{ path: "src/a.mjs", value: { kind: "file", links: 1, mode: "0644", hex: hex(candidateText) } }] };
  for (const [generation, stdout] of [[0, "first failure"], [1, "latest failure: expected 2"]]) {
    const evidence = { schema: "goal-oracle-observation-v1", runId: RUN, definitionFingerprint: fingerprint, generation,
      observations: [{ criterion: { id: "tests" }, verdict: "not-met", reason: null,
        verification: { schema: "goal-command-verification-v1", argv: ["node", "--test"], cwd: ".", sandbox: "macos-seatbelt",
          exitCode: 1, signal: null, timedOut: false, durationMs: 4, stdoutTail: stdout, stderrTail: "" },
        sources: [{ identity: { kind: "host-candidate-snapshot", generation },
          control: { schema: "goal-candidate-evidence-v1", candidate } }] }] };
    const digest = workflowDefinitionFingerprint(evidence);
    await json(join(runDir, "tasks", "task-1", "goal-evidence", `${digest}.json`), { schema: "goal-oracle-receipt-v1", digest, evidence });
  }
  const reserve = async (runId, task, count) => {
    const dir = join(cwd, ".pi", "workflows", runId, "tasks", task, "artifacts", "request-reservations");
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < count; i++) await json(join(dir, `${String(i).repeat(64).slice(0, 64)}.json`), { phase: "settled" });
  };
  await reserve(RUN, "task-2", 3);
  await mkdir(join(cwd, ".pi", "workflows", CHILD), { recursive: true });
  await json(join(cwd, ".pi", "workflows", CHILD, "run.json"), { schemaVersion: 1, runId: CHILD, status: "running",
    cwd, parentRunId: RUN, rootRunId: RUN, tasks: [] });
  await reserve(CHILD, "task-1", 2);
  return { cwd, usesPath, definition, origin };
}

const notLive = () => false;

test("recovery plan counts every request of the interrupted family, keeps the latest feedback, and carries the candidate", async () => {
  const { cwd, usesPath } = await interruptedRun();
  const launch = await planWorkflowGoalRecovery(cwd, RUN, notLive);
  assert.equal(launch.specPath, usesPath);
  assert.equal(launch.task, "Finish a");
  assert.equal(launch.plan.fromRunId, RUN);
  assert.equal(launch.plan.priorRequests, 5, "root and child reservations both count, conservatively");
  assert.equal(launch.plan.priorGenerations, 2);
  assert.equal(launch.plan.feedbackGeneration, 1);
  assert.match(JSON.stringify(launch.plan.feedback), /latest failure: expected 2/);
  assert.doesNotMatch(JSON.stringify(launch.plan.feedback), /first failure/);
  assert.deepEqual(launch.plan.seed.files.map(file => file.path), ["src/a.mjs"]);
  assert.equal(launch.plan.seedSkipped, null);
  assert.deepEqual(goalRecoveryPreview(launch.plan, 12), {
    fromRunId: RUN, priorRequests: 5, remainingRequests: 7, priorGenerations: 2, feedbackGeneration: 1,
    feedbackCriteria: ["tests: not-met"], carriedCandidate: ["src/a.mjs"],
  });
});

test("a changed origin starts the recovery from the origin and says why", async () => {
  const { cwd } = await interruptedRun();
  await writeFile(join(cwd, "src", "a.mjs"), "export const a = 'edited by hand';\n");
  const launch = await planWorkflowGoalRecovery(cwd, RUN, notLive);
  assert.equal(launch.plan.seed, null);
  assert.match(launch.plan.seedSkipped, /origin changed/);
  assert.equal(launch.plan.priorRequests, 5, "usage still counts when the candidate is not carried");
});

test("recovery is refused for a changed definition, an achieved Goal, a live owner, or a live admission", async () => {
  const changed = await interruptedRun();
  await json(changed.usesPath, { ...authoredDefinition, goal: { ...authoredDefinition.goal, objective: "Something else" } });
  await assert.rejects(planWorkflowGoalRecovery(changed.cwd, RUN, notLive), /changed since run/);

  const achieved = await interruptedRun({ achieved: true });
  await assert.rejects(planWorkflowGoalRecovery(achieved.cwd, RUN, notLive), /already achieved/);

  const owned = await interruptedRun();
  const lock = join(owned.cwd, ".pi", "workflows", RUN, "supervisor.lock");
  await writeFile(lock, `${process.pid}-owner\n${process.pid}\n${new Date().toISOString()}\n`);
  await assert.rejects(planWorkflowGoalRecovery(owned.cwd, RUN, notLive), /owned by a live session/);
  const stale = new Date(Date.now() - 120_000);
  await writeFile(lock, `99999999-dead\n99999999\n${stale.toISOString()}\n`);
  await utimes(lock, stale, stale);
  await planWorkflowGoalRecovery(owned.cwd, RUN, notLive);

  await assert.rejects(planWorkflowGoalRecovery(owned.cwd, RUN, runId => runId === RUN), /use \/workflow goal resume/);
});

test("a run is recovered at most once and concurrent recoveries are refused", async () => {
  const { cwd } = await interruptedRun();
  const release = await claimWorkflowGoalRecovery(cwd, RUN);
  await writeFile(join(cwd, ".pi", "workflows", RUN, "goal-recovery.json"), JSON.stringify({
    schema: "goal-recovery-marker-v1", state: "claimed", pid: process.ppid, at: new Date().toISOString() }));
  await assert.rejects(claimWorkflowGoalRecovery(cwd, RUN), /being recovered by another session/);
  await writeFile(join(cwd, ".pi", "workflows", RUN, "goal-recovery.json"), JSON.stringify({
    schema: "goal-recovery-marker-v1", state: "claimed", pid: process.pid, at: new Date().toISOString() }));
  await release();
  const second = await claimWorkflowGoalRecovery(cwd, RUN);
  await completeWorkflowGoalRecovery(cwd, RUN, "workflow_mvzrecov_newrun");
  await second();
  assert.equal(await readWorkflowGoalRecoveredBy(cwd, RUN), "workflow_mvzrecov_newrun", "completion survives release");
  await assert.rejects(claimWorkflowGoalRecovery(cwd, RUN), /already recovered as workflow_mvzrecov_newrun/);
  await assert.rejects(planWorkflowGoalRecovery(cwd, RUN, notLive), /already recovered/);
});

test("the seed is written through the candidate workspace and re-checked against its baseline", async () => {
  const { cwd, definition } = await interruptedRun();
  const { plan } = await planWorkflowGoalRecovery(cwd, RUN, notLive);
  const host = async (name) => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), `goal-recovery-${name}-`)));
    roots.push(parent);
    return prepareGoalWorkspaceHost({ originRoot: cwd, workspaceRoot: join(parent, "candidate"),
      workspaceId: `goal-new-${name}`, mode: "mutation", repository: "nonGit", scope: ["src/a.mjs"],
      protectedPaths: ["test/a.test.mjs"], controlRoots: [join(cwd, ".pi")], artifactRoot: join(parent, "artifacts") },
    { assertCurrent: async () => {}, assertLive: () => {} });
  };
  const fresh = await host("fresh");
  assert.deepEqual(await seedWorkflowGoalRecoveryCandidate(fresh, definition, plan), ["src/a.mjs"]);
  const seeded = (await fresh.inspectCandidate()).files.find(file => file.path === "src/a.mjs").value;
  assert.equal(Buffer.from(seeded.hex, "hex").toString(), "export const a = 2;\n");
  assert.equal(await readFile(join(cwd, "src", "a.mjs"), "utf8"), "export const a = 1;\n", "the origin is untouched");
  await fresh.cleanup();

  await writeFile(join(cwd, "src", "a.mjs"), "export const a = 'drifted after consent';\n");
  const drifted = await host("drift");
  await assert.rejects(seedWorkflowGoalRecoveryCandidate(drifted, definition, plan), /origin changed after consent/);
  await drifted.cleanup();
});
