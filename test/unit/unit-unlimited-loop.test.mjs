import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseWorkflow } from "../../.tmp/unit/schema.js";
import { setTaskTerminal, writeJsonAtomic } from "../../.tmp/unit/store.js";
import {
 captureSubagentPrompts, completeTask, compileWorkflow, createLoopRun, createWorkflowRunRecord, loopWorkflowSpec,
 makeProject, readRunRecord, scheduleRun, setSubagentApiForTests,
 taskBySpec, writeAgent, writeRunRecord, writeStaticRunArtifacts,
} from "./unit-test-support.mjs";

test("loop requires an explicit positive count or null, preserving null through compilation", async () => {
 const cwd = makeProject();
 try {
  writeAgent(cwd, "unit-scout", "read");
  for (const value of [undefined, 0, -1, 1.5, "unlimited", false]) {
   assert.throws(() => parseWorkflow(loopWorkflowSpec({ maxRounds: value })), /maxRounds/);
  }
  const spec = parseWorkflow(loopWorkflowSpec({ maxRounds: null }));
  const { compiled } = await createLoopRun(cwd, spec);
  assert.equal(compiled.stages.find(stage => stage.id === "fix-loop").maxRounds, null);
 } finally { rmSync(cwd, { recursive: true, force: true }); }
});

async function finishRound(cwd, runId, round, done = false) {
 const current = await readRunRecord(cwd, runId);
 const tag = `r${String(round).padStart(2, "0")}`;
 await completeTask(cwd, taskBySpec(current, `fix-loop.${tag}.implement`), { changed: true });
 await completeTask(cwd, taskBySpec(current, `fix-loop.${tag}.check`), {
  status: done ? "pass" : "fail", verdict: done ? "ACCEPT" : "REJECT", blockingFailures: ["same unfinished case"],
 });
 await writeRunRecord(cwd, current);
 await scheduleRun(cwd, runId);
 return readRunRecord(cwd, runId);
}

test("unlimited loop continues past finite defaults with unchanged progress and completes only on until", async () => {
 const cwd = makeProject();
 captureSubagentPrompts();
 try {
  writeAgent(cwd, "unit-scout", "read");
  const { run } = await createLoopRun(cwd, loopWorkflowSpec({ maxRounds: null }));
  await scheduleRun(cwd, run.runId);
  for (let round = 1; round <= 6; round += 1) {
   const current = await finishRound(cwd, run.runId, round);
   assert.equal(current.loopResults?.length ?? 0, 0);
   assert.ok(taskBySpec(current, `fix-loop.r${String(round + 1).padStart(2, "0")}.implement`));
  }
  const current = await finishRound(cwd, run.runId, 7, true);
  assert.equal(current.loopResults[0].status, "completed");
  assert.equal(current.loopResults[0].roundsUsed, 7);
  assert.equal(current.tasks.some(task => task.specId.includes(".r08.")), false);
 } finally { setSubagentApiForTests(undefined); rmSync(cwd, { recursive: true, force: true }); }
});

test("explicit progressPath still opts unlimited loops into no-progress stopping", async () => {
 const cwd = makeProject();
 captureSubagentPrompts();
 try {
  writeAgent(cwd, "unit-scout", "read");
  const { run } = await createLoopRun(cwd, loopWorkflowSpec({ maxRounds: null, progressPath: "$.blockingFailures" }));
  await scheduleRun(cwd, run.runId);
  await finishRound(cwd, run.runId, 1);
  const current = await finishRound(cwd, run.runId, 2);
  assert.equal(current.loopResults[0].status, "stopped_no_progress");
  assert.equal(current.loopResults[0].roundsUsed, 2);
 } finally { setSubagentApiForTests(undefined); rmSync(cwd, { recursive: true, force: true }); }
});

test("unlimited loop materializes round 100 from structured round 99 state with unique identities", async () => {
 const cwd = makeProject();
 captureSubagentPrompts();
 try {
  writeAgent(cwd, "unit-scout", "read");
  const { run } = await createLoopRun(cwd, loopWorkflowSpec({ maxRounds: null }));
  await scheduleRun(cwd, run.runId);
  const current = await readRunRecord(cwd, run.runId);
  await completeTask(cwd, taskBySpec(current, "fix-loop.r01.implement"), { changed: true });
  await completeTask(cwd, taskBySpec(current, "fix-loop.r01.check"), { status: "fail", verdict: "REJECT", blockingFailures: ["same"] });
  // Seed a durable later-round state without performing 99 unrelated worker runs.
  const compiledPath = join(cwd, ".pi", "workflows", run.runId, "compiled.json");
  const promote = value => JSON.parse(JSON.stringify(value).replaceAll(".r01.", ".r99."));
  const compiled = promote(JSON.parse(readFileSync(compiledPath, "utf8")));
  for (const task of compiled.tasks) if (task.loopChild) { task.loopChild.round = 99; task.loopChild.roundTag = "r99"; }
  const promotedRun = promote(current);
  for (const state of promotedRun.loopStates ?? []) state.round = 99;
  await writeJsonAtomic(compiledPath, compiled);
  await writeRunRecord(cwd, promotedRun);
  await scheduleRun(cwd, run.runId);
  const after = await readRunRecord(cwd, run.runId);
  assert.ok(taskBySpec(after, "fix-loop.r100.implement"));
  assert.ok(taskBySpec(after, "fix-loop.r100.check"));
  assert.equal(new Set(after.tasks.map(task => task.taskId)).size, after.tasks.length);
  const final = await finishRound(cwd, run.runId, 100, true);
  assert.equal(final.loopResults[0].roundsUsed, 100);
  assert.equal(final.loopResults[0].status, "completed");
 } finally { setSubagentApiForTests(undefined); rmSync(cwd, { recursive: true, force: true }); }
});


test("unlimited loop stops on execution failure and allows downstream partial cleanup", async () => {
 const cwd = makeProject();
 captureSubagentPrompts();
 try {
  writeAgent(cwd, "unit-scout", "read");
  mkdirSync(join(cwd, "workflows"), { recursive: true });
  writeFileSync(join(cwd, "workflows", "cleanup.mjs"), 'export default () => ({schema:"cleanup-v1",digest:"cleaned",cleaned:true});');
  const spec = loopWorkflowSpec({ maxRounds: null });
  spec.artifactGraph.stages.push({ id: "cleanup", from: ["fix-loop"], sourcePolicy: "partial", support: { uses: "./cleanup.mjs" } });
  const specPath = join(cwd, "workflows", "loop.json");
  writeFileSync(specPath, JSON.stringify(spec));
  const compiled = await compileWorkflow(spec, { cwd, specPath, task: "Fail worker and perform cleanup" });
  const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
  await writeStaticRunArtifacts(cwd, run, compiled, spec);
  await writeRunRecord(cwd, run);
  await scheduleRun(cwd, run.runId);
  const current = await readRunRecord(cwd, run.runId);
  setTaskTerminal(taskBySpec(current, "fix-loop.r01.implement"), "failed", "simulated_backend_failure");
  await writeRunRecord(cwd, current);
  await scheduleRun(cwd, run.runId);
  const after = await scheduleRun(cwd, run.runId);
  assert.equal(after.loopResults[0].status, "failed");
  assert.equal(after.loopResults[0].roundsUsed, 1);
  assert.match(after.loopResults[0].summary, /child did not complete successfully/);
  assert.doesNotMatch(after.loopResults[0].summary, /progress metric/);
  assert.equal(taskBySpec(after, "fix-loop.loop").status, "failed");
  assert.equal(after.tasks.some(task => task.specId.includes(".r02.")), false);
  assert.equal(after.tasks.find(task => task.stageId === "cleanup").status, "completed");
 } finally { setSubagentApiForTests(undefined); rmSync(cwd, { recursive: true, force: true }); }
});
