import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  goalCommandSandboxAvailable,
  goalCommandVerdict,
  goalCommandVerifierConfigIssues,
  runGoalCommandVerifier,
} from "../../.tmp/unit/goal-command-verifier.js";
import { parseGoalWorkflowSpec } from "../../.tmp/unit/goal-workflow-schema.js";
import { goalHash } from "../../.tmp/unit/goal-json.js";

const roots = [];
after(() => Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))));
const sandboxed = { skip: goalCommandSandboxAvailable() ? false : "macOS sandbox-exec unavailable" };

async function fixture(candidateSource) {
  const root = await mkdtemp(join(tmpdir(), "goal-command-verifier-"));
  roots.push(root);
  const origin = join(root, "origin"), workspaceRoot = join(root, "candidate");
  await mkdir(join(origin, "src"), { recursive: true });
  await mkdir(join(origin, "test"), { recursive: true });
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await writeFile(join(origin, "src", "sum.mjs"), "export const sum = (a, b) => a - b;\n");
  await writeFile(join(origin, "test", "sum.test.mjs"), [
    'import assert from "node:assert/strict";', 'import { test } from "node:test";',
    'import { sum } from "../src/sum.mjs";', 'test("sum", () => assert.equal(sum(2, 3), 5));', "",
  ].join("\n"));
  await writeFile(join(workspaceRoot, "src", "sum.mjs"), candidateSource);
  const candidate = { schemaVersion: 1, workspaceId: "fixture", baselineHash: "0".repeat(64), files: [{
    path: "src/sum.mjs", value: { kind: "file", links: 1, mode: "0644", hex: Buffer.from(candidateSource).toString("hex") },
  }] };
  const workspace = { workspaceRoot, inspectCandidate: async () => structuredClone(candidate) };
  return { origin, workspace, candidate };
}

const testArgv = [process.execPath, "--test", "test/sum.test.mjs"];

test("command verifier config accepts argv only, without a shell, and bounded timeouts", () => {
  assert.deepEqual(goalCommandVerifierConfigIssues({ argv: ["node", "--test"], timeoutMs: 60_000, cwd: "pkg" }), []);
  assert.ok(goalCommandVerifierConfigIssues({ argv: "node --test" }).length, "a shell string is rejected");
  assert.ok(goalCommandVerifierConfigIssues({ argv: [] }).length);
  assert.ok(goalCommandVerifierConfigIssues({ argv: ["node"], timeoutMs: 10 }).length);
  assert.ok(goalCommandVerifierConfigIssues({ argv: ["node"], cwd: "../escape" }).length);
  assert.ok(goalCommandVerifierConfigIssues({ argv: ["node"], env: { SECRET: "x" } }).length);
});

test("Goal definitions accept a candidate command criterion and reject other shapes", () => {
  const definition = (verifier) => ({ schemaVersion: 1, name: "cmd", goal: {
    objective: "Make the tests pass", criteria: [{ id: "tests", verifier }],
    authority: { allowedPaths: ["src/sum.mjs"], protectedPaths: ["test"], allowedEffects: ["read", "candidate-write", "verify", "workflow-create"] },
  } });
  const valid = { kind: "deterministic", producerId: "command-exit-v1", target: "candidate",
    subject: { resultSlot: "result", artifact: "control" }, config: { argv: ["node", "--test"] } };
  assert.doesNotThrow(() => parseGoalWorkflowSpec(definition(valid)));
  assert.throws(() => parseGoalWorkflowSpec(definition({ ...valid, target: "artifact" })), /command-exit-v1 requires target candidate/);
  assert.throws(() => parseGoalWorkflowSpec(definition({ ...valid, config: { argv: "node --test" } })), /argv/);
  assert.throws(() => parseGoalWorkflowSpec(definition({ ...valid, producerId: "json-exact-value-v1" })));
});

test("the exit code of the user command on the candidate copy is the verdict", sandboxed, async () => {
  const failing = await fixture("export const sum = (a, b) => a - b;\n");
  const failed = await runGoalCommandVerifier({ originRoot: failing.origin, workspace: failing.workspace, config: { argv: testArgv } });
  assert.equal(failed.sandbox, "macos-seatbelt");
  assert.notEqual(failed.exitCode, 0);
  assert.equal(goalCommandVerdict(failed), "not-met");
  assert.match(failed.stdoutTail, /not ok|fail/i, "the failing test output is retained as feedback");

  const passing = await fixture("export const sum = (a, b) => a + b;\n");
  const passed = await runGoalCommandVerifier({ originRoot: passing.origin, workspace: passing.workspace,
    config: { argv: testArgv }, expectedCandidateHash: goalHash(passing.candidate) });
  assert.equal(passed.exitCode, 0, passed.stdoutTail + passed.stderrTail);
  assert.equal(goalCommandVerdict(passed), "met");
  assert.equal(await readFile(join(passing.origin, "src", "sum.mjs"), "utf8"), "export const sum = (a, b) => a - b;\n",
    "the origin is never written; the candidate is overlaid on a copy");
});

test("a changed candidate is not run against the observed subject", sandboxed, async () => {
  const f = await fixture("export const sum = (a, b) => a + b;\n");
  await assert.rejects(runGoalCommandVerifier({ originRoot: f.origin, workspace: f.workspace,
    config: { argv: testArgv }, expectedCandidateHash: "f".repeat(64) }), /candidate changed/);
});

test("the sandbox denies writes outside the copy, network access and credential reads", sandboxed, async () => {
  const f = await fixture("export const sum = (a, b) => a + b;\n");
  const escape = join(homedir(), `goal-command-escape-${process.pid}.txt`);
  const probe = await runGoalCommandVerifier({ originRoot: f.origin, workspace: f.workspace, config: { argv: [process.execPath, "-e", `
    const fs = require("fs"), net = require("net");
    const results = {};
    try { fs.writeFileSync(${JSON.stringify(escape)}, "x"); results.outside = "written"; } catch (e) { results.outside = e.code; }
    try { fs.writeFileSync("inside.txt", "x"); results.inside = "written"; } catch (e) { results.inside = e.code; }
    try { fs.readdirSync(${JSON.stringify(join(homedir(), ".ssh"))}); results.ssh = "read"; } catch (e) { results.ssh = e.code; }
    const socket = net.connect(443, "1.1.1.1");
    socket.on("error", e => { results.network = e.code; console.log(JSON.stringify(results)); });
    socket.on("connect", () => { results.network = "connected"; console.log(JSON.stringify(results)); socket.destroy(); });
  `] } });
  const results = JSON.parse(probe.stdoutTail.trim());
  assert.equal(results.inside, "written");
  assert.notEqual(results.outside, "written");
  assert.notEqual(results.ssh, "read");
  assert.notEqual(results.network, "connected");
  assert.equal(existsSync(escape), false);
});

test("the host overlay never writes through a symlinked directory into the origin", sandboxed, async () => {
  const f = await fixture("export const sum = (a, b) => a + b;\n");
  await mkdir(join(f.origin, "node_modules", "dep"), { recursive: true });
  await writeFile(join(f.origin, "node_modules", "dep", "index.js"), "original\n");
  const candidate = { schemaVersion: 1, workspaceId: "fixture", baselineHash: "0".repeat(64), files: [{
    path: "node_modules/dep/index.js", value: { kind: "file", links: 1, mode: "0644", hex: Buffer.from("hijack\n").toString("hex") },
  }] };
  await mkdir(join(f.workspace.workspaceRoot, "node_modules", "dep"), { recursive: true });
  await writeFile(join(f.workspace.workspaceRoot, "node_modules", "dep", "index.js"), "hijack\n");
  const workspace = { workspaceRoot: f.workspace.workspaceRoot, inspectCandidate: async () => structuredClone(candidate) };
  await assert.rejects(runGoalCommandVerifier({ originRoot: f.origin, workspace, config: { argv: testArgv } }),
    /crosses a non-directory/);
  assert.equal(await readFile(join(f.origin, "node_modules", "dep", "index.js"), "utf8"), "original\n");
});

test("output held open by an escaped descendant does not stall the verdict", sandboxed, async () => {
  const f = await fixture("export const sum = (a, b) => a + b;\n");
  const started = Date.now();
  const result = await runGoalCommandVerifier({ originRoot: f.origin, workspace: f.workspace, config: { argv: [process.execPath, "-e",
    "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { detached: true, stdio: 'inherit' }).unref(); console.log('parent done')"],
    timeoutMs: 30000 } });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdoutTail, /parent done/);
  assert.ok(Date.now() - started < 7000, "the verifier stops reading shortly after the command exits");
});

test("a command over its time limit is killed and is not met", sandboxed, async () => {
  const f = await fixture("export const sum = (a, b) => a + b;\n");
  const slow = await runGoalCommandVerifier({ originRoot: f.origin, workspace: f.workspace,
    config: { argv: [process.execPath, "-e", "setTimeout(() => {}, 60000)"], timeoutMs: 1000 } });
  assert.equal(slow.timedOut, true);
  assert.equal(goalCommandVerdict(slow), "not-met");
});
