import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { startRpcSession } from "./surface-rpc-harness.mjs";
import workflowExtension, { GOAL_TOOL } from "../../.tmp/unit/extension.js";

// Startup readiness (cold subprocess boot + built extension load) is budgeted apart
// from post-ready RPC operations: the first get_commands response absorbs boot
// latency, which grows under parallel CI load, while every command afterwards is
// held to a tight operation deadline. The whole test carries a finite timeout so
// a wedged child fails the case instead of hanging the run.
const STARTUP_BUDGET_MS = 30000;
const OPERATION_BUDGET_MS = 10000;

function fakeWorkflowSurface() {
 const commands = new Map(), tools = [];
 workflowExtension({
  on() {},
  registerCommand(name, command) { commands.set(name, command); },
  registerTool(tool) { tools.push(tool); },
  getThinkingLevel() { return "medium"; },
 });
 return { workflow: commands.get("workflow"), tools };
}

test("registered /workflow goal authoring preserves literal JSON and save-only has no execution effect", async (t) => {
 const cwd = await mkdtemp(join(tmpdir(), "surface-goal-author-"));
 t.after(() => rm(cwd, { recursive: true, force: true }));
 const { workflow, tools } = fakeWorkflowSurface();
 assert.equal(tools.find(tool => tool.name === GOAL_TOOL)?.name, "workflow_goal");
 let confirmations = 0;
 const notices = [];
 const choices = [
  "Deterministic exact JSON value",
  "Read and verify only",
  "Save definition",
 ];
 const inputs = [
  '{"reserved":{"constructor":["x"],"__proto__":0},"fraction":1.5}',
  "",
  "",
  "",
  "",
  "goals/literal.json",
 ];
 const ctx = {
  cwd, hasUI: true, mode: "tui",
  model: { provider: "fixture", id: "model" },
  modelRegistry: { getAvailable() { return []; } },
  ui: {
   input: async () => inputs.shift(),
   select: async () => choices.shift(),
   confirm: async () => { confirmations++; return true; },
   notify: (text, level) => notices.push({ text, level }),
  },
 };
 await workflow.handler("goal create preserve literal JSON", ctx);
 const saved = JSON.parse(await readFile(join(cwd, "goals", "literal.json"), "utf8"));
 assert.deepEqual(
  saved.goal.criteria[0].verifier.config.expected,
  JSON.parse('{"reserved":{"constructor":["x"],"__proto__":0},"fraction":1.5}'),
 );
 assert.deepEqual(saved.goal.criteria[0].verifier.subject, {
  resultSlot: "result", artifact: "control", path: "$.result",
 });
 assert.equal(confirmations, 0, "save-only does not request execution confirmation");
 assert.ok(notices.some(({ text }) => /no run was created/i.test(text)));
 assert.equal((await readFile(join(cwd, ".pi", "goals", "current"), "utf8").catch(error => error.code)), "ENOENT");
 await assert.rejects(() => tools.find(tool => tool.name === GOAL_TOOL).execute(
  "call", { action: "create", request: "must not mutate" }, new AbortController().signal, undefined, { cwd },
 ), /rejects unknown fields and accessors/);
 await assert.rejects(() => tools.find(tool => tool.name === GOAL_TOOL).execute(
  "call", { action: "create" }, new AbortController().signal, undefined, { cwd },
 ), /Ordinary Goal tool is read-only/);
 assert.equal((await readFile(join(cwd, ".pi", "goals", "current"), "utf8").catch(error => error.code)), "ENOENT");
});

test("registered /workflow goal rubric authoring selects the ordinary engine producer", async (t) => {
 const cwd = await mkdtemp(join(tmpdir(), "surface-goal-rubric-"));
 t.after(() => rm(cwd, { recursive: true, force: true }));
 const { workflow } = fakeWorkflowSurface();
 const statement = "Compare both original sources and preserve contradictions and unknowns.";
 const inputs = [statement, "inputs", "", "", "", "goals/research.json"];
 const choices = ["Model-rubric statement", "Read and verify only", "Save definition"];
 const notices = [];
 await workflow.handler("goal create compare original sources", {
  cwd, hasUI: true, mode: "tui",
  ui: {
   input: async () => inputs.shift(),
   select: async () => choices.shift(),
   confirm: async () => { throw new Error("save-only must not execute or overwrite"); },
   notify: (text) => notices.push(text),
  },
 });
 assert.ok(notices.some(text => /no run was created/i.test(text)), JSON.stringify(notices));
 const saved = JSON.parse(await readFile(join(cwd, "goals/research.json"), "utf8"));
 assert.deepEqual(saved.goal.criteria[0].verifier, {
  kind: "model-rubric",
  producerId: "json-control-rubric-v1",
  target: "artifact",
  subject: { resultSlot: "result", artifact: "control", path: "$.result" },
  config: { rubric: { statement }, minScore: 1 },
 });
 assert.equal(inputs.length, 0);
 assert.equal(choices.length, 0);
});

test("registered /workflow goal cancellation and readonly dispatch do not enter authoring", async (t) => {
 const cwd = await mkdtemp(join(tmpdir(), "surface-goal-cancel-"));
 t.after(() => rm(cwd, { recursive: true, force: true }));
 const { workflow } = fakeWorkflowSurface();
 const notices = [];
 let inputs = 0;
 const ctx = {
  cwd, hasUI: true, mode: "tui",
  ui: {
   input: async () => { inputs++; return undefined; },
   select: async () => undefined,
   confirm: async () => { throw new Error("confirmation must not occur"); },
   notify: (text, level) => notices.push({ text, level }),
  },
 };
 await workflow.handler("goal", ctx);
 assert.equal(inputs, 1);
 assert.equal(notices.some(({ text }) => /cancelled/i.test(text)), true);
 await workflow.handler("goal list", ctx);
 assert.equal(inputs, 1, "read-only list never prompts for authoring");
 assert.ok(notices.some(({ text }) => /No goals found/i.test(text)));
 const scopeCancelled = {
  ...ctx,
  ui: {
   input: async (title) => title === "Allowed scope paths (comma-separated; blank for none)" ? undefined : "1",
   select: async (title) => title === "Completion criterion semantics" ? "Deterministic exact JSON value" : undefined,
   confirm: async () => { throw new Error("scope cancellation must not confirm"); },
   notify: (text, level) => notices.push({ text, level }),
  },
 };
 await workflow.handler("goal create cancelled scope", scopeCancelled);
 assert.equal((await readFile(join(cwd, ".pi", "goals", "current"), "utf8").catch(error => error.code)), "ENOENT");
});

test("registered /workflow goal save-only retains every JSON literal shape without a runtime", async (t) => {
 const cwd = await mkdtemp(join(tmpdir(), "surface-goal-literals-"));
 t.after(() => rm(cwd, { recursive: true, force: true }));
 const literals = [
  "true",
  "1.5",
  '["a",2,null]',
  '{"__proto__":{"constructor":"reserved"},"nested":{"x":0}}',
 ];
 for (const [index, literal] of literals.entries()) {
  const { workflow } = fakeWorkflowSurface();
  const notices = [];
  const inputs = [literal, "", "", "", "", `goals/literal-${index}.json`];
  const choices = ["Deterministic exact JSON value", "Read and verify only", "Save definition"];
  await workflow.handler(`goal create literal ${index}`, {
   cwd, hasUI: true, mode: "tui",
   ui: {
    input: async () => inputs.shift(),
    select: async () => choices.shift(),
    confirm: async () => { throw new Error("new save must not overwrite or execute"); },
    notify: (text, level) => notices.push({ text, level }),
   },
  });
  const saved = JSON.parse(await readFile(join(cwd, `goals/literal-${index}.json`), "utf8"));
  assert.deepEqual(saved.goal.criteria[0].verifier.config.expected, JSON.parse(literal));
  assert.ok(notices.some(({ text }) => /no run was created/i.test(text)));
 }
 assert.equal((await readFile(join(cwd, ".pi", "goals", "current"), "utf8").catch(error => error.code)), "ENOENT");
});

test("registered /workflow goal authors a sandboxed command criterion without a shell", async (t) => {
 const cwd = await mkdtemp(join(tmpdir(), "surface-goal-command-"));
 t.after(() => rm(cwd, { recursive: true, force: true }));
 const author = (command, effects, path) => {
  const inputs = [command, "src/a.mjs", "test/a.test.mjs", "", "", path];
  const choices = ["Command exit code (sandboxed)", effects, "Save definition"];
  const previews = [], notices = [];
  return { previews, notices, ctx: {
   cwd, hasUI: true, mode: "tui",
   ui: {
    input: async () => inputs.shift(),
    select: async (title) => { previews.push(title); return choices.shift(); },
    confirm: async () => { throw new Error("new save must not overwrite or execute"); },
    notify: (text, level) => notices.push({ text, level }),
   },
  } };
 };
 const words = author("node --test test/a.test.mjs", "Candidate writes, read, and verify", "goals/words.json");
 await fakeWorkflowSurface().workflow.handler("goal create make tests pass", words.ctx);
 const saved = JSON.parse(await readFile(join(cwd, "goals/words.json"), "utf8"));
 assert.deepEqual(saved.goal.criteria[0].verifier, {
  kind: "deterministic", producerId: "command-exit-v1", target: "candidate",
  subject: { resultSlot: "result", artifact: "control" },
  config: { argv: ["node", "--test", "test/a.test.mjs"] },
 });
 assert.match(words.previews.at(-1), /macOS sandbox/);
 const json = author('["node","-e","process.exit(0)"]', "Candidate writes, read, and verify", "goals/json.json");
 await fakeWorkflowSurface().workflow.handler("goal create json argv", json.ctx);
 assert.deepEqual(JSON.parse(await readFile(join(cwd, "goals/json.json"), "utf8")).goal.criteria[0].verifier.config.argv,
  ["node", "-e", "process.exit(0)"], "a JSON argv keeps arguments containing spaces");
 const readOnly = author("node --test", "Read and verify only", "goals/read-only.json");
 await fakeWorkflowSurface().workflow.handler("goal create read only", readOnly.ctx);
 assert.ok(readOnly.notices.some(({ text, level }) => level === "error" && /candidate-writing effect/.test(text)),
  "a read-only command criterion is refused");
 assert.equal(await readFile(join(cwd, "goals/read-only.json"), "utf8").catch(error => error.code), "ENOENT");
});

test("registered /workflow goal create writes nothing when cancelled at any prompt", async (t) => {
 const cwd = await mkdtemp(join(tmpdir(), "surface-goal-cancel-each-"));
 t.after(() => rm(cwd, { recursive: true, force: true }));
 const { readdir } = await import("node:fs/promises");
 // The complete authoring dialog in order: [kind, answer].
 const dialog = [
  ["select", "Deterministic exact JSON value"], ["input", "true"], ["input", "src/a.mjs"], ["input", ""],
  ["select", "Candidate writes, read, and verify"], ["input", ""], ["input", ""], ["input", "goals/out.json"],
  ["select", "Save definition"],
 ];
 const author = async (cancelAt) => {
  let step = 0;
  const answer = (kind) => {
   const current = step++;
   assert.equal(dialog[current]?.[0], kind, `prompt ${current} is a ${dialog[current]?.[0]}`);
   return current === cancelAt ? undefined : dialog[current][1];
  };
  await fakeWorkflowSurface().workflow.handler("goal create make a true", {
   cwd, hasUI: true, mode: "tui",
   ui: { input: async () => answer("input"), select: async () => answer("select"),
    confirm: async () => { throw new Error("cancelled authoring must not confirm"); }, notify() {} },
  });
  return step;
 };
 for (let cancelAt = 0; cancelAt < dialog.length; cancelAt++) {
  const asked = await author(cancelAt);
  assert.equal(asked, cancelAt + 1, `authoring stops at the cancelled prompt ${cancelAt}`);
  assert.deepEqual(await readdir(cwd), [], `cancelling prompt ${cancelAt} writes nothing`);
 }
 assert.equal(await author(-1), dialog.length);
 assert.equal(JSON.parse(await readFile(join(cwd, "goals", "out.json"), "utf8")).goal.objective, "make a true",
  "the same dialog without cancellation saves the definition");
});

test("registered /workflow goal actions never fall through to authoring", async (t) => {
 const cwd = await mkdtemp(join(tmpdir(), "surface-goal-actions-"));
 t.after(() => rm(cwd, { recursive: true, force: true }));
 const { workflow } = fakeWorkflowSurface();
 let prompts = 0;
 const ctx = {
  cwd, hasUI: true, mode: "tui",
  ui: {
   input: async () => { prompts++; throw new Error("action must not author"); },
   select: async () => { prompts++; throw new Error("action must not author"); },
   confirm: async () => { prompts++; throw new Error("action must not author"); },
   notify() {},
  },
 };
 for (const action of [
  "list", "status", "criteria missing-goal", "evidence missing-goal",
  "wait missing-goal", "pause missing-goal", "resume missing-goal",
  "cancel missing-goal", "apply missing-goal", "recover missing-goal",
  "background missing-goal revoke",
 ]) await workflow.handler(`goal ${action}`, ctx);
 assert.equal(prompts, 0);
});

test("registered /workflow goal rejects symlink definitions and fences overwrite changes", async (t) => {
 const cwd = await mkdtemp(join(tmpdir(), "surface-goal-persistence-"));
 t.after(() => rm(cwd, { recursive: true, force: true }));
 await mkdir(join(cwd, "outside"));
 await writeFile(join(cwd, "outside", "definition.json"), "{}");
 await symlink(join(cwd, "outside"), join(cwd, "linked"));
 const { workflow } = fakeWorkflowSurface();
 const author = (path, onConfirm = async () => true) => {
  const inputs = ["true", "", "", "", "", path];
  const choices = ["Deterministic exact JSON value", "Read and verify only", "Save definition"];
  return {
   cwd, hasUI: true, mode: "tui",
   ui: {
    input: async () => inputs.shift(),
    select: async () => choices.shift(),
    confirm: onConfirm,
    notify() {},
   },
  };
 };
 await workflow.handler("goal create symlink", author("linked/definition.json"));
 assert.equal(await readFile(join(cwd, "outside", "definition.json"), "utf8"), "{}");
 await mkdir(join(cwd, "goals"));
 const target = join(cwd, "goals", "race.json");
 await writeFile(target, '{"old":true}\n');
 await workflow.handler("goal create race", author("goals/race.json", async () => {
  await writeFile(target, '{"changed":true}\n');
  return true;
 }));
 assert.equal(await readFile(target, "utf8"), '{"changed":true}\n');
});

test("registered /workflow goal profile path saves the definition without a runtime or execution", async (t) => {
 const cwd = await mkdtemp(join(tmpdir(), "surface-goal-profile-"));
 t.after(() => rm(cwd, { recursive: true, force: true }));
 const { workflow } = fakeWorkflowSurface();
 const inputs = ["true", "", "", "", "", "goals/profile.json"];
 const notices = [];
 await workflow.handler("goal create profile save", {
  cwd, hasUI: true, mode: "tui",
  ui: {
   input: async () => inputs.shift(),
   select: async (title) => title.startsWith("Completion")
    ? "Deterministic exact JSON value"
    : title === "Allowed effects"
     ? "Read and verify only"
     : title.startsWith("Goal preview")
      ? "Save definition and select execution profile"
      : undefined,
   confirm: async () => { throw new Error("profile-only must not confirm execution"); },
   notify: (text, level) => notices.push({ text, level }),
  },
 });
 assert.equal(JSON.parse(await readFile(join(cwd, "goals/profile.json"), "utf8")).goal.objective, "profile save");
 assert.ok(notices.some(({ text }) => /profile selection cancelled/i.test(text)));
 assert.equal((await readFile(join(cwd, ".pi", "goals", "current"), "utf8").catch(error => error.code)), "ENOENT");
});

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
   resolve(".tmp/unit/extension.js"),
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
 assert.equal(
  commands.data.commands.some((c) => c.name === "goal"),
  false,
  "Goal is available only as /workflow goal, never as a standalone slash command",
 );
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
 send({ id: "goal-list", type: "prompt", message: "/workflow goal list" });
 await op(
  (e) =>
   e.method === "notify" &&
   /^No goals found in ordinary workflow-engine records\./.test(e.message),
  "/workflow goal list read-only dispatch",
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
   /no longer supported/,
  ],
  [
   "route-suffix",
   '/workflow run deep-research "task" --route --no-route',
   /no longer supported/,
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
