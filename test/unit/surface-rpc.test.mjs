import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { startRpcSession } from "./surface-rpc-harness.mjs";

// Startup readiness (cold subprocess boot + extension compile) is budgeted apart
// from post-ready RPC operations: the first get_commands response absorbs boot
// latency, which grows under parallel CI load, while every command afterwards is
// held to a tight operation deadline. The whole test carries a finite timeout so
// a wedged child fails the case instead of hanging the run.
const STARTUP_BUDGET_MS = 30000;
const OPERATION_BUDGET_MS = 10000;

// A real locked Pi subprocess. Only registered custom commands are sent: no
// provider credentials, model request, workflow launch, or user configuration.
test("actual Pi RPC /workflow emits fallback and malformed launch commands stop before scheduling", {
 timeout: 60000,
}, async (t) => {
 const cwd = await mkdtemp(join(tmpdir(), "surface-rpc-"));
 const home = join(cwd, "home"),
  agent = join(home, "agent");
 await mkdir(agent, { recursive: true });
 const guard = join(cwd, "guard.ts");
 await writeFile(
  guard,
  `export default function(pi) {
 pi.on('before_provider_request', () => { throw new Error('MODEL_CALL_FORBIDDEN'); });
 pi.registerCommand('surface-context', {handler: async (_args,ctx) => ctx.ui.notify('mode='+ctx.mode+';hasUI='+ctx.hasUI,'info')});
 pi.registerCommand('surface-exit', {handler: async (_args,ctx) => ctx.shutdown()});
 }`,
 );
 const session = startRpcSession({
  command: process.execPath,
  args: [
   resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
   "--mode",
   "rpc",
   "--no-session",
   "--offline",
   "--no-extensions",
   "--no-skills",
   "--no-prompt-templates",
   "--no-themes",
   "--no-context-files",
   "--no-tools",
   "-e",
   resolve("src/extension.ts"),
   "-e",
   guard,
  ],
  cwd,
  env: {
   PATH: process.env.PATH,
   HOME: home,
   PI_CODING_AGENT_DIR: agent,
   PI_OFFLINE: "1",
   PI_WORKFLOW_ROLE: "parent",
  },
 });
 const { events, send } = session;
 t.after(async () => {
  await session.close();
  await rm(cwd, { recursive: true, force: true });
 });
 const op = (predicate, label) =>
  session.waitFor(predicate, { budget: OPERATION_BUDGET_MS, label });
 send({ id: "commands", type: "get_commands" });
 const commands = await session.waitFor((e) => e.id === "commands", {
  budget: STARTUP_BUDGET_MS,
  label: "initial get_commands (startup readiness)",
 });
 assert.equal(commands.success, true);
 assert.ok(commands.data.commands.some((c) => c.name === "workflow"));
 send({ id: "context", type: "prompt", message: "/surface-context" });
 await op(
  (e) => e.method === "notify" && e.message === "mode=rpc;hasUI=true",
  "surface-context notify",
 );
 send({ id: "board", type: "prompt", message: "/workflow" });
 await op(
  (e) =>
   e.method === "notify" && /No workflow runs|Workflow runs/i.test(e.message),
  "/workflow board notify",
 );
 for (const [id, message] of [
  ["missing", '/workflow run deep-research "task" --model'],
  ["dynamic", '/workflow dynamic --profile high "task"'],
 ]) {
  send({ id, type: "prompt", message });
  await op(
   (e) =>
    e.method === "notify" &&
    e.notifyType === "error" &&
    (id === "missing"
     ? /requires a value/.test(e.message)
     : /does not support --profile/.test(e.message)),
   `malformed ${id}`,
  );
 }
 for (const [id, message, expected] of [
  [
   "model-prefix",
   '/workflow run --model A --model B deep-research "task"',
   /Duplicate/,
  ],
  [
   "model-suffix",
   '/workflow run deep-research "task" --model A --model B',
   /Duplicate/,
  ],
  [
   "model-mixed",
   '/workflow run --model A deep-research "task" --model B',
   /Duplicate/,
  ],
  [
   "route-prefix",
   '/workflow run --route --no-route deep-research "task"',
   /Conflicting/,
  ],
  [
   "route-suffix",
   '/workflow run deep-research "task" --route --no-route',
   /Conflicting/,
  ],
  [
   "profile",
   '/workflow run deep-research "task" --profile low --profile high',
   /Duplicate/,
  ],
  [
   "reasoning",
   '/workflow dynamic --thinking low "task" --reasoning high',
   /Duplicate/,
  ],
  [
   "unsafe-keep",
   "/workflow prune --keep 9007199254740992",
   /non-negative integer/,
  ],
  ["duplicate-keep", "/workflow prune --keep 1 --keep 2", /Duplicate/],
 ]) {
  const start = events.length;
  send({ id, type: "prompt", message });
  await op(
   (e) =>
    events.indexOf(e) >= start &&
    e.method === "notify" &&
    e.notifyType === "error" &&
    expected.test(e.message),
   `malformed ${id}`,
  );
 }
 assert.equal(
  events.some((e) => e.type === "agent_start"),
  false,
  "custom commands must not invoke an agent",
 );
 assert.doesNotMatch(session.stderr, /MODEL_CALL_FORBIDDEN/);
 send({ id: "quit", type: "prompt", message: "/surface-exit" });
 await session.exited;
 assert.equal(session.proc.exitCode, 0, session.stderr);
});
