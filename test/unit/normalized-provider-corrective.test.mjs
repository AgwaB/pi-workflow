import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { compileWorkflow } from "../../.tmp/unit/compiler.js";
import {
  buildWorkflowWebSourceExtensionWrapper,
  registerWorkflowWebSourceExtension,
} from "../../.tmp/unit/workflow-web-source-extension.js";

const body = (result) => JSON.parse(result.content[0].text);
const project = () => mkdtempSync(join(tmpdir(), "normalized-provider-corrective-"));
const cleanup = (path) => rmSync(path, { recursive: true, force: true });

function register(config, extensions) {
  const tools = new Map();
  registerWorkflowWebSourceExtension({ registerTool(tool) { tools.set(tool.name, tool); } }, config, extensions);
  return tools;
}

function config(cwd, cacheDir, provider, tools) {
  return {
    schema: "workflow-web-source-launch-config-v1",
    runId: "corrective",
    taskId: "task",
    cwd,
    cacheDir,
    provider,
    securityPolicy: { allowPrivateHosts: false, cacheRawProviderPayloads: false },
    exposedWorkflowTools: tools,
    requiredProviderTools: tools.includes("workflow_web_search") ? ["web_search"] : [],
  };
}

test("corrective normalized provider fetch honors only explicit host policy", async () => {
  const cwd = project();
  try {
    let calls = 0;
    const provider = (pi) => pi.registerTool({
      name: "fetch_content",
      async execute() {
        calls += 1;
        return { content: [{ type: "text", text: "public provider body" }] };
      },
    });
    const trusted = register(config(cwd, join(cwd, "trusted"), {
      kind: "extension", extensionPaths: ["/validated/provider.mjs"], trustedCustomProvider: true,
    }, ["workflow_web_fetch_source"]), provider);
    const success = body(await trusted.get("workflow_web_fetch_source").execute("public", { url: "http://1.1.1.1/public" }));
    assert.equal(success.status, "ok");
    assert.equal(calls, 1);

    const untrusted = register({
      ...config(cwd, join(cwd, "untrusted"), { kind: "extension" }, ["workflow_web_fetch_source"]),
      securityPolicy: { allowPrivateHosts: true, cacheRawProviderPayloads: false },
    }, provider);
    const explicitlyAllowed = body(await untrusted.get("workflow_web_fetch_source").execute("explicit", { url: "http://1.1.1.1/public" }));
    assert.equal(explicitlyAllowed.status, "ok");
    assert.equal(calls, 2);
  } finally { cleanup(cwd); }
});

test("compile to prepare preserves supported normalized owners and re-exports shared tools", async () => {
  const cwd = project();
  try {
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "agents", "owner.md"), `---\nname: owner\ndescription: owner\ntools: [workflow_web_search, workflow_web_fetch_source, code_search]\nreadOnly: true\n---\nOwner.\n`);
    writeFileSync(join(cwd, "provider.mjs"), `export default pi => {\n  pi.registerTool({ name: "web_search", async execute() { return { content: [{ type: "text", text: "search" }] }; } });\n  pi.registerTool({ name: "code_search", async execute() { return { content: [{ type: "text", text: "code" }] }; } });\n  pi.registerTool({ name: "not_selected", async execute() {} });\n};\n`);
    const spec = {
      schemaVersion: 1,
      name: "owner",
      defaults: {
        agent: "owner",
        tools: [
          { name: "workflow_web_search", extensions: ["./provider.mjs"], classification: "read-only" },
          { name: "workflow_web_fetch_source", classification: "read-only" },
          { name: "code_search", extensions: ["./provider.mjs"], classification: "read-only" },
        ],
      },
      artifactGraph: { stages: [{ id: "main", type: "single", prompt: "Use web tools." }] },
    };
    const compiled = await compileWorkflow(spec, { cwd, task: "check" });
    assert.deepEqual(compiled.tasks[0].runtime.toolProviders, {
      workflow_web_search: { extensions: ["./provider.mjs"], classification: "read-only" },
      workflow_web_fetch_source: { classification: "read-only" },
      code_search: { extensions: ["./provider.mjs"], classification: "read-only" },
    });
    const prepared = await (await import("../../.tmp/unit/subagent-backend.js")).prepareSubagentTaskLaunch(
      cwd, { runId: "compile-prepare" }, { taskId: "task", files: { result: ".tmp/result.json" } }, compiled.tasks[0],
    );
    const wrapper = prepared.generatedExtensions.find((entry) => entry.kind === "web-source");
    assert(wrapper);
    assert.match(wrapper.expectedBytes, /file:.*provider\.mjs/);
    assert.match(wrapper.expectedBytes, /"passthroughProviderTools": \[\s*"code_search"\s*\]/);
    assert.equal(prepared.extensions.includes(join(cwd, "provider.mjs")), false);

    const sdk = await import("@earendil-works/pi-coding-agent");
    const loader = new sdk.DefaultResourceLoader({ cwd, agentDir: join(cwd, "agent"), additionalExtensionPaths: prepared.extensions, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    const names = loaded.extensions.flatMap((entry) => [...entry.tools.keys()]);
    assert.deepEqual(names.sort(), ["code_search", "workflow_web_fetch_source", "workflow_web_search"]);
  } finally { cleanup(cwd); }
});

test("compile to prepare rejects custom normalized fetch ownership before dispatch", async () => {
  const cwd = project();
  try {
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "agents", "owner.md"), `---\nname: owner\ndescription: owner\ntools: [workflow_web_fetch_source]\nreadOnly: true\n---\nOwner.\n`);
    writeFileSync(join(cwd, "provider.mjs"), "export default pi => pi.registerTool({ name: 'fetch_content', async execute() {} });\n");
    const compiled = await compileWorkflow({ schemaVersion: 1, name: "owner", defaults: { agent: "owner", tools: [{ name: "workflow_web_fetch_source", extensions: ["./provider.mjs"], classification: "read-only" }] }, artifactGraph: { stages: [{ id: "main", type: "single", prompt: "Fetch." }] } }, { cwd, task: "check" });
    await assert.rejects(
      () => import("../../.tmp/unit/subagent-backend.js").then(({ prepareSubagentTaskLaunch }) => prepareSubagentTaskLaunch(cwd, { runId: "reject" }, { taskId: "task", files: { result: ".tmp/result.json" } }, compiled.tasks[0])),
      /unsupported normalized provider ownership/,
    );
  } finally { cleanup(cwd); }
});

test("shared legacy provider wrapper re-exports selected code_search exactly once", async () => {
  const cwd = project();
  try {
    writeFileSync(join(cwd, "shared.mjs"), `export default pi => {\n  pi.registerTool({ name: "fetch_content", async execute() { return { content: [{ type: "text", text: "fetch" }] }; } });\n  pi.registerTool({ name: "code_search", async execute() { return { content: [{ type: "text", text: "code" }] }; } });\n  pi.registerTool({ name: "not_selected", async execute() {} });\n};\n`);
    const prepared = await (await import("../../.tmp/unit/subagent-backend.js")).prepareSubagentTaskLaunch(
      cwd, { runId: "legacy-shared" }, { taskId: "task", files: { result: ".tmp/result.json" } }, {
        runtime: {
          tools: ["fetch_content", "code_search"],
          toolProviders: {
            fetch_content: { extensions: [join(cwd, "shared.mjs")] },
            code_search: { extensions: [join(cwd, "shared.mjs")] },
          },
        },
      },
    );
    const sdk = await import("@earendil-works/pi-coding-agent");
    const loader = new sdk.DefaultResourceLoader({ cwd, agentDir: join(cwd, "agent"), additionalExtensionPaths: prepared.extensions, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    const names = loaded.extensions.flatMap((entry) => [...entry.tools.keys()]);
    assert.deepEqual(names.sort(), ["code_search", "fetch_content"]);
  } finally { cleanup(cwd); }
});

test("legacy ownership rejects missing and multi-entry refs while relative refs resolve from workflow cwd", async () => {
  const cwd = project();
  try {
    writeFileSync(join(cwd, "legacy.mjs"), "export default pi => pi.registerTool({ name: 'fetch_content', async execute() {} });\n");
    const { prepareSubagentTaskLaunch } = await import("../../.tmp/unit/subagent-backend.js");
    const run = { runId: "legacy-contract" };
    const task = { taskId: "task", files: { result: ".tmp/result.json" } };
    const runtime = (extensions) => ({ runtime: { tools: ["fetch_content"], toolProviders: { fetch_content: { extensions } } } });
    const relativePrepared = await prepareSubagentTaskLaunch(cwd, run, task, runtime(["./legacy.mjs"]));
    assert.equal(relativePrepared.generatedExtensions.length, 1);
    assert.match(relativePrepared.generatedExtensions[0].expectedBytes, /file:.*legacy\.mjs/);
    await assert.rejects(
      () => prepareSubagentTaskLaunch(cwd, run, task, runtime(["./missing.mjs"])),
      /provider extension reference .*missing/,
    );
    await assert.rejects(
      () => prepareSubagentTaskLaunch(cwd, run, task, runtime(["./legacy.mjs", "./legacy.mjs"])),
      /legacy provider ownership is incompatible/,
    );
  } finally { cleanup(cwd); }
});

test("corrective normalized provider wrapper invokes ordered extensions through one capture proxy", () => {
  const wrapper = buildWorkflowWebSourceExtensionWrapper({
    importPath: "/pkg/workflow-web-source-extension.js",
    providerExtensionPaths: ["/pkg/a.mjs", "/pkg/b.mjs"],
    config: config("/project", "/cache", { kind: "extension", extensionPaths: ["/pkg/a.mjs", "/pkg/b.mjs"], trustedCustomProvider: true }, ["workflow_web_search"]),
  });
  assert.match(wrapper, /providerExtension0/);
  assert.match(wrapper, /providerExtension1/);
  assert.match(wrapper, /\[providerExtension0, providerExtension1\]/);
});

test("provider progress callbacks are recursively safe, budgeted, and inert after settlement", async () => {
  const cwd = project();
  try {
    const updates = [];
    const lateSecret = "late-callback-secret";
    const tools = register({
      ...config(cwd, join(cwd, "callback"), { kind: "extension" }, ["workflow_web_search"]),
      webSourcePolicy: { perTaskVisibleCharBudget: 20 },
    }, (pi) => pi.registerTool({
      name: "web_search",
      async execute(_id, _params, _signal, onUpdate) {
        onUpdate({
          content: [{ type: "text", text: "token=callback-secret and more" }],
          details: { status: "running", message: "nested secret=callback-secret", unknown: lateSecret, nested: { token: lateSecret } },
          providerSecret: lateSecret,
        });
        setTimeout(() => onUpdate({ content: [{ type: "text", text: lateSecret }] }), 0);
        return { content: [{ type: "text", text: "https://example.test/result" }], details: { successfulQueries: 1, totalResults: 1 } };
      },
    }));
    const result = body(await tools.get("workflow_web_search").execute("callback", { query: "q" }, undefined, (update) => updates.push(update)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(result.status, "ok");
    assert.equal(updates.length, 1);
    assert.equal(JSON.stringify(updates).includes(lateSecret), false);
    assert.equal(JSON.stringify(updates).includes("providerSecret"), false);
    assert.equal(JSON.stringify(updates).includes("unknown"), false);
    assert.ok(updates[0].content[0].text.length <= 20);
  } finally { cleanup(cwd); }
});

test("corrective reserved provider selectors remain selection metadata, never attribution", async () => {
  const cwd = project();
  try {
    const tools = register(config(cwd, join(cwd, "search"), { kind: "extension" }, ["workflow_web_search"]), (pi) => pi.registerTool({
      name: "web_search",
      async execute() { return { content: [{ type: "text", text: "https://1.1.1.1/result" }], details: { provider: "all", actualProvider: "all", actualProviders: ["auto", "all"], providers: ["all"], successfulQueries: 1, totalResults: 1 } }; },
    }));
    const result = body(await tools.get("workflow_web_search").execute("selectors", { query: "q" }));
    assert.deepEqual(result.provenance.providers, []);
    assert.equal(result.provenance.attributionAvailable, false);
    assert.deepEqual(result.provenance.selectedProviders, ["all"]);
  } finally { cleanup(cwd); }
});

test("corrective aliases converge across concurrent reverse-order fetches and reload", async () => {
  const cwd = project();
  try {
    const cacheDir = join(cwd, "aliases");
    let calls = 0;
    const provider = (pi) => pi.registerTool({
      name: "fetch_content",
      async execute() {
        calls += 1;
        return { content: [{ type: "text", text: "same alias body" }], details: { finalUrl: "http://1.1.1.1/b" } };
      },
    });
    const make = () => register(config(cwd, cacheDir, { kind: "extension", extensionPaths: ["/validated/provider.mjs"], trustedCustomProvider: true }, ["workflow_web_fetch_source"]), provider);
    const first = make().get("workflow_web_fetch_source");
    const [a, b] = await Promise.all([
      first.execute("a", { url: "http://1.1.1.1/a" }),
      first.execute("b", { url: "http://1.1.1.1/b" }),
    ]);
    const firstCard = body(a).card;
    const secondCard = body(b).card;
    assert.equal(firstCard.sourceRef, secondCard.sourceRef);
    assert.ok(calls >= 1 && calls <= 2);
    const reloaded = make().get("workflow_web_fetch_source");
    const replay = body(await reloaded.execute("replay", { url: "http://1.1.1.1/b" }));
    assert.equal(replay.card.sourceRef, firstCard.sourceRef);
    assert.equal(replay.card.duplicate, true);
  } finally { cleanup(cwd); }
});

test("corrective late fetch waiter replaces an aborted never-resolving flight", async () => {
  const cwd = project();
  try {
    const cacheDir = join(cwd, "late-flight");
    let calls = 0;
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const provider = (pi) => pi.registerTool({
      name: "fetch_content",
      async execute(_id, params, signal) {
        calls += 1;
        if (calls === 1) {
          markStarted();
          // Deliberately ignore AbortSignal. The durable lock must still be
          // released when the last waiter leaves, while this generation is
          // fenced from publishing any late result.
          return new Promise(() => {});
        }
        return { content: [{ type: "text", text: `replacement body for ${params.url}` }] };
      },
    });
    const tools = register(config(cwd, cacheDir, { kind: "extension", extensionPaths: ["/validated/provider.mjs"], trustedCustomProvider: true }, ["workflow_web_fetch_source"]), provider);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = tools.get("workflow_web_fetch_source").execute("first", { url: "http://1.1.1.1/source" }, firstController.signal);
    const second = tools.get("workflow_web_fetch_source").execute("second", { url: "http://1.1.1.1/source" }, secondController.signal);
    await started;
    firstController.abort();
    secondController.abort();
    const cancelled = await Promise.all([first, second]);
    assert.ok(cancelled.every((result) => body(result).status === "cancelled"));
    const replacementPending = tools.get("workflow_web_fetch_source").execute("replacement", { url: "http://1.1.1.1/source" });
    const replacement = body(await Promise.race([
      replacementPending,
      new Promise((_, reject) => setTimeout(() => reject(new Error("replacement remained blocked by old lock")), 1_000)),
    ]));
    assert.equal(replacement.status, "ok");
    assert.equal(calls, 2);
  } finally { cleanup(cwd); }
});

test("corrective late search cancellation leaves a held durable budget lock unchanged", async () => {
  const cwd = project();
  try {
    const cacheDir = join(cwd, "cancel");
    const lockKey = createHash("sha256").update("corrective\0task").digest("hex");
    const lockDir = join(cacheDir, "visible-budget-locks", lockKey);
    mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ ownerId: "held" }));
    const tools = register(config(cwd, cacheDir, { kind: "extension" }, ["workflow_web_search"]), (pi) => pi.registerTool({
      name: "web_search",
      async execute() { return { content: [{ type: "text", text: "https://1.1.1.1/result" }], details: { successfulQueries: 1, totalResults: 1 } }; },
    }));
    const controller = new AbortController();
    const pending = tools.get("workflow_web_search").execute("cancel", { query: "q" }, controller.signal);
    setTimeout(() => controller.abort(), 20);
    const result = body(await pending);
    assert.equal(result.status, "cancelled");
    assert.deepEqual(result.candidates, []);
    assert.equal(result.budget.used, 0);
    assert.equal(existsSync(join(cacheDir, "visible-budget-ledger")), false);
  } finally { cleanup(cwd); }
});
