import assert from "node:assert/strict";
import test from "node:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

for (const [name, rounds, args, expectedStatus] of [
 ["finite default retains supervisor deadline", 2, [], 1],
 ["unlimited loop removes implicit supervisor deadline", null, [], 0],
 ["explicit zero removes finite workflow supervisor deadline", 2, ["--max-runtime-ms", "0"], 0],
 ["explicit finite supervisor override still applies to unlimited loop", null, ["--max-runtime-ms", "1000"], 1],
]) test(name, () => {
 const root = mkdtempSync(join(tmpdir(), "pi-unlimited-supervisor-"));
 try {
  mkdirSync(join(root, "src")); mkdirSync(join(root, "dist"));
  copyFileSync(resolve("src/cli.mjs"), join(root, "src/cli.mjs"));
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  writeFileSync(join(root, "compiled.json"), JSON.stringify({ stages: [{ id: "trials", type: "loop", maxRounds: rounds }] }));
  writeFileSync(join(root, "dist/store.js"), `export const run = {runId:"workflow_test",status:"running",taskSummary:{completed:0,total:1,running:1,failed:0,interrupted:0}};
export async function readRunRecord(){return run;}
export const compiledWorkflowPath = cwd => cwd + "/compiled.json";`);
  writeFileSync(join(root, "dist/engine.js"), `import {run} from "./store.js"; let calls = 0;
export async function scheduleRun(){if(++calls === 2){run.status="completed";run.taskSummary.completed=1;run.taskSummary.running=0;}}`);
  writeFileSync(join(root, "dist/process-role.js"), 'export function assertWorkflowActionAllowedForRole() {}');
  // Advance only this process's fake clock beyond the former four-hour cutoff.
  writeFileSync(join(root, "clock.mjs"), 'let calls=0; Date.now=()=>++calls*18000000;');
  const result = spawnSync(process.execPath, ["--import", join(root, "clock.mjs"), join(root, "src/cli.mjs"), "supervise", "workflow_test", "--poll-ms", "250", ...args], { cwd: root, encoding: "utf8", timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, expectedStatus, result.stdout + result.stderr);
  if (expectedStatus === 0) { assert.match(result.stdout, /runtime unlimited/); assert.match(result.stdout, /done: workflow_test completed/); }
  else assert.match(result.stdout, /giving up after --max-runtime-ms/);
 } finally { rmSync(root, { recursive: true, force: true }); }
});
