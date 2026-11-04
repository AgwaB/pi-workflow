import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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
async function interruptedRun({ candidateText = "export const a = 2;\n", achieved = false, receipts = true,
  candidateFiles, priorRecovery, executionProfile, definitionPatch } = {}) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "goal-recovery-")));
  roots.push(cwd);
  await mkdir(join(cwd, "src")); await mkdir(join(cwd, "test")); await mkdir(join(cwd, "workflows"));
  await writeFile(join(cwd, "src", "a.mjs"), "export const a = 1;\n");
  await writeFile(join(cwd, "test", "a.test.mjs"), "// test\n");
  const usesPath = join(cwd, "workflows", "goal.json");
  const authored = definitionPatch ? definitionPatch(structuredClone(authoredDefinition)) : authoredDefinition;
  await json(usesPath, authored);
  const definition = parseGoalWorkflowSpec((await loadWorkflowSpec(usesPath, cwd)).spec);
  const fingerprint = workflowDefinitionFingerprint(definition);
  const runDir = join(cwd, ".pi", "workflows", RUN);
  await mkdir(join(runDir, "tasks", "task-1", "goal-evidence"), { recursive: true });
  await json(join(runDir, "run.json"), { schemaVersion: 1, runId: RUN, name: "recover-me", status: "running", cwd,
    specPath: usesPath,
    goalParticipation: { schemaVersion: 1, resumeRequired: false, goalPaths: ["goal"] },
    ...(priorRecovery ? { goalRecovery: priorRecovery } : {}),
    ...(executionProfile ? { executionProfile } : {}),
    tasks: [{ taskId: "task-1", specId: "goal.main", stageId: "goal", kind: "goal", status: "pending",
      files: { result: `.pi/workflows/${RUN}/tasks/task-1/result.json` },
      ...(achieved ? { goal: { state: "engine:achieved" } } : {}),
      goalRoot: { generations: [{ generation: 0 }, { generation: 1 }] } }] });
  await json(join(runDir, "compiled.json"), { task: "Finish a", tasks: [{ id: "goal.main", stageId: "goal", kind: "goal",
    goal: { usesPath, definition, definitionFingerprint: fingerprint } }] });
  const origin = await observeGoalWorkspaceOrigin({ originRoot: cwd, repository: "nonGit",
    scope: ["src/a.mjs"], protectedPaths: ["test/a.test.mjs"], controlRoots: [join(cwd, ".pi")] });
  const candidate = { schemaVersion: 1, workspaceId: "goal-old-workspace",
    baselineHash: goalRecoveryBaselineHash(definition, "goal-old-workspace", origin),
    files: candidateFiles ?? [{ path: "src/a.mjs", value: { kind: "file", links: 1, mode: "0644", hex: hex(candidateText) } }] };
  const writeReceipt = async (generation, stdout, overrides = {}) => {
    const evidence = { schema: "goal-oracle-observation-v1", runId: RUN, definitionFingerprint: fingerprint, generation,
      observations: [{ criterion: definition.goal.criteria[0], verdict: "not-met", reason: null,
        verification: { schema: "goal-command-verification-v1", argv: ["node", "--test"], cwd: ".", sandbox: "macos-seatbelt",
          exitCode: 1, signal: null, timedOut: false, durationMs: 4, stdoutTail: stdout, stderrTail: "" },
        sources: [{ identity: { kind: "host-candidate-snapshot", generation },
          control: { schema: "goal-candidate-evidence-v1", candidate } }] }], ...overrides };
    const digest = workflowDefinitionFingerprint(evidence);
    await json(join(runDir, "tasks", "task-1", "goal-evidence", `${digest}.json`), { schema: "goal-oracle-receipt-v1", digest, evidence });
  };
  if (receipts) for (const [generation, stdout] of [[0, "first failure"], [1, "latest failure: expected 2"]])
    await writeReceipt(generation, stdout);
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
  return { cwd, usesPath, definition, origin, writeReceipt };
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

test("a change to a protected file alone keeps the carried candidate, which the new run re-judges", async () => {
  const { cwd } = await interruptedRun();
  await writeFile(join(cwd, "test", "a.test.mjs"), "// the user tightened the tests\n");
  const { plan } = await planWorkflowGoalRecovery(cwd, RUN, notLive);
  assert.deepEqual(plan.seed?.files.map(file => file.path), ["src/a.mjs"],
    "only allowed paths decide whether the candidate still applies");
  assert.equal(plan.seedSkipped, null);
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

  await assert.rejects(planWorkflowGoalRecovery(owned.cwd, RUN, runId => runId === RUN), /still running in this session/);
  const runFile = join(owned.cwd, ".pi", "workflows", RUN, "run.json");
  // A stopped run of this session can be recovered too: resume may be impossible
  // after a stop (a model request cut off), and recovery is the way on.
  const stopped = JSON.parse(await readFile(runFile, "utf8"));
  stopped.status = "interrupted";
  stopped.tasks[0] = { ...stopped.tasks[0], status: "interrupted", statusDetail: "workflow_stopped" };
  await json(runFile, stopped);
  assert.equal((await planWorkflowGoalRecovery(owned.cwd, RUN, runId => runId === RUN)).plan.fromRunId, RUN);
  // A finished (failed) run of this session can be recovered as a new run.
  const failed = JSON.parse(await readFile(runFile, "utf8"));
  failed.status = "failed";
  failed.tasks[0] = { ...failed.tasks[0], status: "failed", statusDetail: "launch_failed",
    lastMessage: "Root replan exhausted: unchanged failed candidate" };
  await json(runFile, failed);
  assert.equal((await planWorkflowGoalRecovery(owned.cwd, RUN, runId => runId === RUN)).plan.fromRunId, RUN);
});

test("a run is recovered at most once and concurrent recoveries are refused", async () => {
  const { cwd } = await interruptedRun();
  const release = await claimWorkflowGoalRecovery(cwd, RUN);
  await assert.rejects(claimWorkflowGoalRecovery(cwd, RUN), /being recovered by another command/,
    "a second recover in the same process is refused while the first waits for consent");
  await release();
  const second = await claimWorkflowGoalRecovery(cwd, RUN);
  await completeWorkflowGoalRecovery(cwd, RUN, "workflow_mvzrecov_newrun");
  await second();
  assert.equal(existsSync(join(cwd, ".pi", "workflows", RUN, "goal-recovery.lock")), false, "a released claim leaves no lock");
  assert.equal(await readWorkflowGoalRecoveredBy(cwd, RUN), "workflow_mvzrecov_newrun", "completion survives release");
  await assert.rejects(planWorkflowGoalRecovery(cwd, RUN, notLive), /already recovered as workflow_mvzrecov_newrun/);
});

test("two processes racing to recover the same run: exactly one claims it", async () => {
  const { cwd } = await interruptedRun();
  const moduleUrl = new URL("../../.tmp/unit/goal-workflow-recovery.js", import.meta.url).href;
  const script = `
    const { claimWorkflowGoalRecovery } = await import(${JSON.stringify(moduleUrl)});
    try {
      const release = await claimWorkflowGoalRecovery(${JSON.stringify(cwd)}, ${JSON.stringify(RUN)});
      console.log("claimed");
      await new Promise(resolve => setTimeout(resolve, 1500));
      await release();
    } catch (error) { console.log("refused: " + error.message); }`;
  const { spawn } = await import("node:child_process");
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.stderr.on("data", chunk => { err += chunk; });
    child.once("exit", code => code === 0 ? resolve(out.trim()) : reject(new Error(err)));
  });
  const results = await Promise.all([run(), run(), run()]);
  assert.equal(results.filter(result => result === "claimed").length, 1, JSON.stringify(results));
  assert.equal(results.filter(result => /being recovered by another command/.test(result)).length, 2, JSON.stringify(results));
  assert.equal(existsSync(join(cwd, ".pi", "workflows", RUN, "goal-recovery.lock")), false, "the winner released its claim");
});

test("a successor run created before the marker was written still blocks a second recovery", async () => {
  const { cwd } = await interruptedRun();
  // Crash between creating the successor and writing the marker: only the successor record exists.
  const successor = "workflow_mvzrecov_succes";
  await mkdir(join(cwd, ".pi", "workflows", successor), { recursive: true });
  await json(join(cwd, ".pi", "workflows", successor, "run.json"), { schemaVersion: 1, runId: successor, status: "running", cwd,
    goalRecovery: { fromRunId: RUN, priorRequests: 5, feedbackGeneration: 1, seededPaths: [] }, tasks: [] });
  await writeFile(join(cwd, ".pi", "workflows", RUN, "goal-recovery.json"), "{ partial");
  assert.equal(await readWorkflowGoalRecoveredBy(cwd, RUN), successor, "a corrupt marker does not hide the successor");
  await assert.rejects(planWorkflowGoalRecovery(cwd, RUN, notLive), new RegExp(`already recovered as ${successor}`));
});

test("recovery accumulates prior requests across a chain and starts clean without receipts", async () => {
  const chained = await interruptedRun({ priorRecovery: { fromRunId: "workflow_mvzrecov_older0", priorRequests: 3,
    priorGenerations: 1, feedbackGeneration: 0, seededPaths: [] } });
  const chainedPlan = (await planWorkflowGoalRecovery(chained.cwd, RUN, notLive)).plan;
  assert.equal(chainedPlan.priorRequests, 8, "the interrupted run's own carried requests plus its family's reservations");
  assert.equal(chainedPlan.priorGenerations, 3, "carried generations plus the interrupted run's own two");
  const bare = await interruptedRun({ receipts: false });
  const { plan } = await planWorkflowGoalRecovery(bare.cwd, RUN, notLive);
  assert.deepEqual([plan.feedbackGeneration, plan.feedback, plan.seed, plan.seedSkipped], [null, [], null, null]);
  assert.equal(plan.priorRequests, 5, "requests still count without any oracle observation");
});

test("only receipts of recorded generations for the consented criteria are used", async () => {
  const { cwd, definition, writeReceipt } = await interruptedRun();
  await writeReceipt(7, "forged future generation");
  await writeReceipt(1, "wrong criteria", { observations: [{ criterion: { ...definition.goal.criteria[0], id: "other" },
    verdict: "met", reason: null, sources: [] }] });
  await writeFile(join(cwd, ".pi", "workflows", RUN, "tasks", "task-1", "goal-evidence", `${"e".repeat(64)}.json`), "not json");
  const { plan } = await planWorkflowGoalRecovery(cwd, RUN, notLive);
  assert.equal(plan.feedbackGeneration, 1);
  assert.match(JSON.stringify(plan.feedback), /latest failure: expected 2/);
  assert.doesNotMatch(JSON.stringify(plan.feedback), /forged|wrong criteria/);
});

test("within one generation the most recently written receipt is the last observation", async () => {
  const { cwd, writeReceipt } = await interruptedRun();
  await new Promise(resolve => setTimeout(resolve, 20));
  await writeReceipt(1, "decided later in generation one");
  const later = await planWorkflowGoalRecovery(cwd, RUN, notLive);
  assert.match(JSON.stringify(later.plan.feedback), /decided later in generation one/);
});

test("seeds that cannot be reproduced are skipped with a reason", async () => {
  const deleted = await interruptedRun({ candidateFiles: [{ path: "src/a.mjs", value: null }] });
  assert.match((await planWorkflowGoalRecovery(deleted.cwd, RUN, notLive)).plan.seedSkipped, /removed a file/);
  const executable = await interruptedRun({ candidateFiles: [{ path: "src/a.mjs",
    value: { kind: "file", links: 1, mode: "0755", hex: hex("#!/bin/sh\n") } }] });
  assert.match((await planWorkflowGoalRecovery(executable.cwd, RUN, notLive)).plan.seedSkipped, /mode change/);
  const large = await interruptedRun({ candidateFiles: [{ path: "src/a.mjs",
    value: { kind: "artifact", links: 1, mode: "0644", locator: `source/${"b".repeat(64)}`, sha256: "a".repeat(64), bytes: 20000, lines: 1 } }] });
  assert.match((await planWorkflowGoalRecovery(large.cwd, RUN, notLive)).plan.seedSkipped, /too large/);
  const unchanged = await interruptedRun({ candidateText: "export const a = 1;\n" });
  const same = await planWorkflowGoalRecovery(unchanged.cwd, RUN, notLive);
  assert.deepEqual([same.plan.seed, same.plan.seedSkipped], [null, null], "an unchanged candidate needs no seed");
});

test("child runs, embedded Goal stages and ad-hoc profiles are handled explicitly", async () => {
  const { cwd } = await interruptedRun();
  await assert.rejects(planWorkflowGoalRecovery(cwd, CHILD, notLive), /root Goal run|not an ordinary Goal run/);
  const embedded = await interruptedRun();
  const runFile = join(embedded.cwd, ".pi", "workflows", RUN, "run.json");
  const record = JSON.parse(await readFile(runFile, "utf8"));
  record.specPath = join(embedded.cwd, "workflows", "wrapper.json");
  await json(runFile, record);
  await assert.rejects(planWorkflowGoalRecovery(embedded.cwd, RUN, notLive), /top-level Goal definition/);
  const adHoc = await interruptedRun({ executionProfile: { name: "chosen-at-launch" } });
  assert.equal((await planWorkflowGoalRecovery(adHoc.cwd, RUN, notLive)).executionProfile, undefined,
    "an ad-hoc profile is chosen again at launch");
  const named = await interruptedRun({ executionProfile: { name: "careful" },
    definitionPatch: d => ({ ...d, executionProfiles: { careful: {} } }) });
  assert.equal((await planWorkflowGoalRecovery(named.cwd, RUN, notLive)).executionProfile, "careful");
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

test("a Goal run continued by recovery can no longer be resumed", async () => {
  const { resumeRun } = await import("../../.tmp/unit/engine.js");
  const { cwd } = await interruptedRun();
  const runFile = join(cwd, ".pi", "workflows", RUN, "run.json");
  const stopped = JSON.parse(await readFile(runFile, "utf8"));
  stopped.status = "interrupted";
  stopped.backend = { type: "pi-subagent" };
  stopped.tasks[0] = { ...stopped.tasks[0], status: "interrupted", statusDetail: "workflow_stopped" };
  await json(runFile, stopped);
  const successor = "workflow_mvzrecov_f7e8d9";
  await mkdir(join(cwd, ".pi", "workflows", successor), { recursive: true });
  await json(join(cwd, ".pi", "workflows", successor, "run.json"), { schemaVersion: 1, runId: successor, name: "recover-me",
    status: "running", cwd, goalParticipation: stopped.goalParticipation,
    goalRecovery: { fromRunId: RUN, priorRequests: 5, priorGenerations: 2, feedbackGeneration: 1, seededPaths: [] }, tasks: [] });
  await assert.rejects(resumeRun(cwd, RUN), new RegExp(`Goal run ${RUN} was continued as ${successor}; it cannot be resumed`));
});
