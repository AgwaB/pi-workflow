import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";
import {
  goalCommandSandboxAvailable,
  goalCommandVerdict,
  goalCommandVerifierConfigIssues,
  goalCommandVerifierPreflightIssues,
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

test("a command that cannot start is a configuration error, not a candidate verdict", sandboxed, async () => {
  const f = await fixture("export const sum = (a, b) => a + b;\n");
  await assert.rejects(runGoalCommandVerifier({ originRoot: f.origin, workspace: f.workspace,
    config: { argv: ["definitely-not-a-goal-command"] } }), /could not start "definitely-not-a-goal-command"/);
  await assert.rejects(runGoalCommandVerifier({ originRoot: f.origin, workspace: f.workspace,
    config: { argv: [process.execPath, "-e", "0"], cwd: "missing" } }), /cwd is not a directory in the working tree: missing/);
});

test("preflight refuses a command or cwd that cannot run before consent", async () => {
  const f = await fixture("export const sum = (a, b) => a + b;\n");
  assert.deepEqual(await goalCommandVerifierPreflightIssues(f.origin, { argv: ["node", "--test"] }), []);
  assert.deepEqual(await goalCommandVerifierPreflightIssues(f.origin, { argv: [process.execPath, "--test"], cwd: "test" }), []);
  assert.match((await goalCommandVerifierPreflightIssues(f.origin, { argv: ["definitely-not-a-goal-command"] }))[0], /not found on PATH/);
  assert.match((await goalCommandVerifierPreflightIssues(f.origin, { argv: ["./scripts/missing.sh"] }))[0], /not an executable file/);
  assert.match((await goalCommandVerifierPreflightIssues(f.origin, { argv: ["node"], cwd: "nope" }))[0], /cwd "nope" is not a directory/);
  assert.match((await goalCommandVerifierPreflightIssues(f.origin, { argv: ["./test"] }))[0], /not an executable file/,
    "a directory is not an executable command");
});

test("a candidate whose bytes changed after its snapshot is not verified", sandboxed, async () => {
  const f = await fixture("export const sum = (a, b) => a + b;\n");
  await writeFile(join(f.workspace.workspaceRoot, "src", "sum.mjs"), "export const sum = () => 5;\n");
  await assert.rejects(runGoalCommandVerifier({ originRoot: f.origin, workspace: f.workspace,
    config: { argv: testArgv } }), /candidate bytes changed before command verification: src\/sum.mjs/);
});

test("preflight resolves relative PATH entries against the command directory, like the run", async () => {
  const f = await fixture("export const sum = (a, b) => a + b;\n");
  await mkdir(join(f.origin, "tools"));
  await writeFile(join(f.origin, "tools", "check-sum"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const previous = process.env.PATH;
  try {
    process.env.PATH = `tools${delimiter}${previous}`;
    assert.deepEqual(await goalCommandVerifierPreflightIssues(f.origin, { argv: ["check-sum"] }), []);
    if (goalCommandSandboxAvailable()) {
      const ran = await runGoalCommandVerifier({ originRoot: f.origin, workspace: f.workspace, config: { argv: ["check-sum"] } });
      assert.equal(goalCommandVerdict(ran), "met", "the sandboxed run finds the same relative PATH entry in the copy");
    }
    process.env.PATH = previous;
    assert.match((await goalCommandVerifierPreflightIssues(f.origin, { argv: ["check-sum"] }))[0], /not found on PATH/);
  } finally { process.env.PATH = previous; }
});

test("a stop during preparation never starts the command", sandboxed, async () => {
  const f = await fixture("export const sum = (a, b) => a + b;\n");
  const stop = new AbortController();
  // The stop arrives while the candidate is being overlaid onto the copy.
  const workspace = { workspaceRoot: f.workspace.workspaceRoot,
    inspectCandidate: async () => { const candidate = await f.workspace.inspectCandidate(); stop.abort(new Error("stopped during overlay")); return candidate; } };
  const started = Date.now();
  await assert.rejects(runGoalCommandVerifier({ originRoot: f.origin, workspace, signal: stop.signal,
    config: { argv: [process.execPath, "-e", "setTimeout(() => {}, 5000)"] } }), /stopped during overlay/);
  assert.ok(Date.now() - started < 3000, "the 5 s command was never started");
});

test("cwd cannot leave the copy through a symbolic link", sandboxed, async () => {
  const f = await fixture("export const sum = (a, b) => a + b;\n");
  const outside = await mkdtemp(join(tmpdir(), "goal-command-outside-"));
  roots.push(outside);
  await mkdir(join(outside, "sub"));
  await symlink(outside, join(f.origin, "alias"));
  assert.match((await goalCommandVerifierPreflightIssues(f.origin, { argv: ["node"], cwd: "alias/sub" }))[0],
    /leaves the working tree through a symbolic link/);
  await assert.rejects(runGoalCommandVerifier({ originRoot: f.origin, workspace: f.workspace,
    config: { argv: [process.execPath, "-e", "0"], cwd: "alias/sub" } }), /leaves the working tree copy/);
});

test("a command that exits before its deadline is not timed out by output held open afterwards", sandboxed, async () => {
  const f = await fixture("export const sum = (a, b) => a + b;\n");
  const result = await runGoalCommandVerifier({ originRoot: f.origin, workspace: f.workspace, config: {
    argv: [process.execPath, "-e",
      "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], { detached: true, stdio: 'inherit' }).unref()"],
    timeoutMs: 1000 } });
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(goalCommandVerdict(result), "met");
});

test("the overlay adds new candidate files and removes deleted ones only in the copy", sandboxed, async () => {
  const f = await fixture("export const sum = (a, b) => a + b;\n");
  await writeFile(join(f.origin, "src", "old.mjs"), "old\n");
  const added = "export const extra = 1;\n";
  await writeFile(join(f.workspace.workspaceRoot, "src", "extra.mjs"), added);
  const candidate = { ...f.candidate, files: [...f.candidate.files,
    { path: "src/extra.mjs", value: { kind: "file", links: 1, mode: "0644", hex: Buffer.from(added).toString("hex") } },
    { path: "src/old.mjs", value: null }] };
  const workspace = { workspaceRoot: f.workspace.workspaceRoot, inspectCandidate: async () => structuredClone(candidate) };
  const result = await runGoalCommandVerifier({ originRoot: f.origin, workspace, config: { argv: [process.execPath, "-e",
    "const fs=require('fs'); console.log(JSON.stringify({ extra: fs.existsSync('src/extra.mjs'), old: fs.existsSync('src/old.mjs') }))"] } });
  assert.deepEqual(JSON.parse(result.stdoutTail), { extra: true, old: false });
  assert.equal(await readFile(join(f.origin, "src", "old.mjs"), "utf8"), "old\n", "deletion happens in the copy only");
  assert.equal(existsSync(join(f.origin, "src", "extra.mjs")), false);
});

test("a stop while the command runs kills it and yields no verdict", sandboxed, async () => {
  const f = await fixture("export const sum = (a, b) => a + b;\n");
  const stop = new AbortController();
  setTimeout(() => stop.abort(new Error("stopped while running")), 300);
  const started = Date.now();
  await assert.rejects(runGoalCommandVerifier({ originRoot: f.origin, workspace: f.workspace, signal: stop.signal,
    config: { argv: [process.execPath, "-e", "setTimeout(() => {}, 10000)"] } }), /stopped while running/);
  assert.ok(Date.now() - started < 5000, "the running command was killed");
});

test("a working tree above the copy ceilings is refused, not partially verified", sandboxed, async () => {
  const f = await fixture("export const sum = (a, b) => a + b;\n");
  await assert.rejects(runGoalCommandVerifier({ originRoot: f.origin, workspace: f.workspace,
    config: { argv: [process.execPath, "-e", "0"] }, copyLimits: { files: 1 } }), /too large to copy/);
  await assert.rejects(runGoalCommandVerifier({ originRoot: f.origin, workspace: f.workspace,
    config: { argv: [process.execPath, "-e", "0"] }, copyLimits: { bytes: 10 } }), /too large to copy/);
});

test("huge, binary and signal outcomes stay bounded and are not met unless exit 0", sandboxed, async () => {
  const f = await fixture("export const sum = (a, b) => a + b;\n");
  const huge = await runGoalCommandVerifier({ originRoot: f.origin, workspace: f.workspace, config: {
    argv: [process.execPath, "-e", "process.stdout.write('z'.repeat(5e6)); process.exit(1)"] } });
  assert.equal(goalCommandVerdict(huge), "not-met");
  assert.ok(huge.stdoutTail.length <= 8_193 && huge.stdoutTail.startsWith("…"),
    "the tail fits bounded Goal JSON strings with room to spare");
  const multibyte = await runGoalCommandVerifier({ originRoot: f.origin, workspace: f.workspace, config: {
    argv: [process.execPath, "-e", "process.stdout.write('é'.repeat(9000)); process.exit(1)"] } });
  assert.match(multibyte.stdoutTail, /^…é+$/u, "the tail starts on a character boundary");
  const binary = await runGoalCommandVerifier({ originRoot: f.origin, workspace: f.workspace, config: {
    argv: [process.execPath, "-e", "process.stdout.write(Buffer.from([0xff, 0xfe, 0, 1])); process.exit(0)"] } });
  assert.equal(goalCommandVerdict(binary), "met", "binary output does not affect the exit verdict");
  const signalled = await runGoalCommandVerifier({ originRoot: f.origin, workspace: f.workspace, config: {
    argv: [process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')"] } });
  assert.equal(signalled.signal, "SIGTERM");
  assert.equal(goalCommandVerdict(signalled), "not-met");
});
