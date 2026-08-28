import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildWorkflowWebSourceCard,
  createWorkflowWebSource,
  readWorkflowWebSource,
  writeWorkflowWebSource,
} from "../../.tmp/unit/workflow-web-source.js";
import {
  registerWorkflowFetchCacheExtension,
} from "../../.tmp/unit/workflow-fetch-cache-extension.js";
import { foreachBatchTasks } from "../../.tmp/unit/foreach-batch-runtime.js";

const body = (result) => result.content?.[0]?.text ?? "";
const project = () => mkdtempSync(join(tmpdir(), "product-corrective-12-"));
const cleanup = (path) => rmSync(path, { recursive: true, force: true });

function registerFetch(config, provider, storage = {}) {
  const registered = new Map();
  const appended = [];
  registerWorkflowFetchCacheExtension(
    {
      registerTool(tool) { registered.set(tool.name, tool); },
      appendEntry(type, data) { appended.push({ type, data }); },
      on() {},
    },
    config,
    provider,
    { generateId: () => "replay-id", storeResult() {}, ...storage },
  );
  return { tool: registered.get("fetch_content"), appended };
}

function fetchData(id, url, content = "provider content") {
  return {
    id,
    type: "fetch",
    timestamp: Date.now(),
    urls: [{
      url,
      title: "Provider title",
      content,
      error: null,
      status: 200,
      mimeType: "text/html",
    }],
  };
}

const baseConfig = (cacheDir, overrides = {}) => ({
  runId: "run-corrective-12",
  taskId: "task-corrective-12",
  cacheDir,
  requiredProviderTools: ["fetch_content"],
  exposedProviderTools: ["fetch_content"],
  ...overrides,
});

test("legacy provider onUpdate is allowlisted, redacted, and inert after settlement", async () => {
  const cwd = project();
  try {
    const updates = [];
    const lateSecret = "late-legacy-callback-secret";
    const { tool } = registerFetch(
      baseConfig(join(cwd, "cache"), { cacheEnabled: false }),
      (pi) => pi.registerTool({
        name: "fetch_content",
        async execute(_id, _params, _signal, onUpdate) {
          onUpdate({
            content: [{ type: "text", text: "token=legacy-callback-secret" }],
            details: { status: "running", unknown: lateSecret, nested: { password: lateSecret } },
            rawProviderField: lateSecret,
          });
          setTimeout(() => onUpdate({ content: [{ type: "text", text: lateSecret }] }), 0);
          return { content: [{ type: "text", text: "safe" }], details: { responseId: "legacy-callback" } };
        },
      }),
    );
    await tool.execute("callback", { url: "https://example.test/callback", auth: false }, undefined, (update) => updates.push(update));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(updates.length, 1);
    assert.equal(JSON.stringify(updates).includes(lateSecret), false);
    assert.equal(JSON.stringify(updates).includes("rawProviderField"), false);
    assert.equal(JSON.stringify(updates).includes("unknown"), false);
  } finally { cleanup(cwd); }
});

test("legacy fetch owns direct callbacks and discards callbacks retained after execute", async () => {
  const cwd = project();
  try {
    const lateSecret = "late-provider-secret-12";
    const { tool, appended } = registerFetch(
      baseConfig(join(cwd, "cache"), { cacheEnabled: false }),
      (pi) => pi.registerTool({
        name: "fetch_content",
        async execute(_id, params) {
          pi.appendEntry("web-search-results", fetchData("direct-id", params.url, "token=direct-secret"));
          setTimeout(() => pi.appendEntry("web-search-results", fetchData("late-id", params.url, lateSecret)), 0);
          return { content: [{ type: "text", text: "token=returned-secret" }], details: { responseId: "direct-id" } };
        },
      }),
    );
    const result = await tool.execute("call", { url: "https://example.test/direct", auth: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(body(result), /REDACTED/);
    assert.equal(appended.length, 1);
    assert.equal(JSON.stringify(appended).includes(lateSecret), false);
    assert.equal(JSON.stringify(appended).includes("direct-secret"), false);
  } finally { cleanup(cwd); }
});

test("legacy cache skip branches discard unvalidated captured provider records", async () => {
  const reasons = [
    "missing-stored-data",
    "unsupported-result-shape",
    "error-result",
    "missing-response-id",
    "no-successes",
  ];
  for (const [index, reason] of reasons.entries()) {
    const cwd = project();
    try {
      const url = `https://example.test/skip-${index}`;
      const id = `skip-id-${index}`;
      const { tool, appended } = registerFetch(
        baseConfig(join(cwd, "cache")),
        (pi) => pi.registerTool({
          name: "fetch_content",
          async execute() {
            pi.appendEntry("web-search-results", { id, type: "fetch", secret: "token=raw-skip-secret", urls: [] });
            if (reason === "missing-response-id") return { content: [{ type: "text", text: "token=raw-skip-secret" }], details: {} };
            if (reason === "unsupported-result-shape") return { content: [{ type: "image", data: "token=raw-skip-secret" }], details: { responseId: id } };
            const details = { responseId: id, ...(reason === "error-result" ? { error: "raw-provider-error" } : {}), ...(reason === "no-successes" ? { successful: 0 } : { successful: 1 }) };
            return { content: [{ type: "text", text: "token=raw-skip-secret" }], details };
          },
        }),
        reason === "missing-stored-data" ? {} : { getResult: () => fetchData(id, url) },
      );
      const result = await tool.execute(`skip-${index}`, { url });
      assert.equal(appended.length, 0, reason);
      assert.equal(JSON.stringify(result).includes("raw-skip-secret"), false, reason);
    } finally { cleanup(cwd); }
  }
});

test("legacy fetch provider exceptions become generic safe failures while cancellation stays cancellation", async () => {
  const cwd = project();
  try {
    const { tool } = registerFetch(
      baseConfig(join(cwd, "cache"), { cacheEnabled: false }),
      (pi) => pi.registerTool({
        name: "fetch_content",
        async execute() { throw new Error("provider secret https://example.test/?token=raw"); },
      }),
    );
    const failed = await tool.execute("failed", { url: "https://example.test/exception", auth: false });
    assert.equal(body(failed), "Fetch failed.");
    assert.equal(JSON.stringify(failed).includes("provider secret"), false);

    const { tool: cancelledTool } = registerFetch(
      baseConfig(join(cwd, "cancel-cache"), { cacheEnabled: false }),
      (pi) => pi.registerTool({
        name: "fetch_content",
        async execute() { throw Object.assign(new Error("AbortError"), { name: "AbortError" }); },
      }),
    );
    const cancelled = await cancelledTool.execute("cancelled", { url: "https://example.test/cancel", auth: false });
    assert.equal(cancelled.details.error, "aborted");
  } finally { cleanup(cwd); }
});

test("source persistence and cards sanitize effectiveUrl and every alias", async () => {
  const cwd = project();
  try {
    const config = { runId: "run", taskId: "task", cacheDir: join(cwd, "sources") };
    const original = createWorkflowWebSource({ config, url: "https://example.test/requested", text: "safe" });
    const written = await writeWorkflowWebSource(config, {
      ...original,
      effectiveUrl: "https://example.test/effective?token=raw-effective",
      aliases: ["https://example.test/alias?password=raw-alias", "https://example.test/safe-alias"],
    });
    assert.equal(written.effectiveUrl, undefined);
    assert.deepEqual(written.aliases, ["https://example.test/safe-alias"]);
    const reloaded = await readWorkflowWebSource(config, written.sourceRef);
    assert.equal(reloaded.effectiveUrl, undefined);
    assert.deepEqual(reloaded.aliases, ["https://example.test/safe-alias"]);

    const card = buildWorkflowWebSourceCard({
      source: { ...original, effectiveUrl: "https://example.test/?token=raw-card", aliases: ["https://example.test/?secret=raw-card"] },
      policy: { previewChars: 100, duplicatePreviewChars: 10, sourceReadMaxChars: 100, searchSnippetChars: 10, perTaskVisibleCharBudget: 1000 },
      budget: { limit: 1000, used: 0 },
    });
    assert.equal(JSON.stringify(card).includes("raw-card"), false);
    assert.equal(card.effectiveUrl, undefined);
    assert.deepEqual(card.aliases, undefined);
  } finally { cleanup(cwd); }
});

test("foreach batch lookup rejects duplicate run taskIds before demux", () => {
  assert.throws(
    () => foreachBatchTasks({ tasks: [{ taskId: "duplicate", specId: "a" }, { taskId: "duplicate", specId: "b" }] }, {}),
    /duplicate taskId/,
  );
});
