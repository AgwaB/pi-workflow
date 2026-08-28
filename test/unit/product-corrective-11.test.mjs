import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  registerWorkflowFetchCacheExtension,
  setWorkflowFetchCachePublicationHookForTests,
  setWorkflowFetchCachePublicationHooksForTests,
} from "../../.tmp/unit/workflow-fetch-cache-extension.js";
import { registerWorkflowWebSourceExtension } from "../../.tmp/unit/workflow-web-source-extension.js";
import {
  buildWorkflowWebSourceCard,
  createWorkflowWebSource,
  createWorkflowWebVisibleBudget,
  readWorkflowWebSource,
  readWorkflowWebSourceSnippet,
  recordWorkflowWebSourceEvent,
  sourceRefFor,
  sanitizeUrlForModel,
  writeWorkflowWebSource,
} from "../../.tmp/unit/workflow-web-source.js";
import { redactSensitiveWorkflowText } from "../../.tmp/unit/workflow-sensitive-query.js";

const project = () => mkdtempSync(join(tmpdir(), "workflow-product-corrective-11-"));
const cleanup = (cwd) => rmSync(cwd, { recursive: true, force: true });
const body = (result) => JSON.parse(result.content[0].text);

function inlineData(id, url, content) {
  return {
    id,
    type: "fetch",
    timestamp: Date.now(),
    urls: [{ url, title: id, content, error: null, status: 200, mimeType: "text/plain" }],
  };
}

function cacheKey(url) {
  return createHash("sha256").update(JSON.stringify({ urls: [url], mode: "readable" })).digest("hex");
}

test("cache-object EEXIST materializes the validated durable winner", async () => {
  const cwd = project();
  try {
    const url = "https://winner.example/source";
    const cacheDir = join(cwd, "cache");
    const registered = new Map();
    const appended = [];
    let winner;
    const pi = {
      registerTool(tool) { registered.set(tool.name, tool); },
      appendEntry(type, data) { appended.push({ type, data }); },
      on() {},
    };
    const provider = (providerPi) => providerPi.registerTool({
      name: "fetch_content",
      async execute() {
        const loser = inlineData("loser", url, "losing provider bytes");
        winner = {
          schema: "workflow-fetch-content-cache-v1",
          key: cacheKey(url),
          createdAt: new Date().toISOString(),
          responseId: "winner",
          result: {
            content: [{ type: "text", text: "durable winner bytes" }],
            details: { responseId: "winner", urls: [url], urlCount: 1, successful: 1 },
          },
          storedData: inlineData("winner", url, "durable winner bytes"),
        };
        providerPi.appendEntry("web-search-results", loser);
        return {
          content: [{ type: "text", text: "losing provider bytes" }],
          details: { responseId: "loser", urls: [url], urlCount: 1, successful: 1 },
        };
      },
    });
    const storage = {
      generateId: () => "replay",
      storeResult() {},
    };
    registerWorkflowFetchCacheExtension(
      pi,
      { runId: "run", taskId: "task", cacheDir, requiredProviderTools: ["fetch_content"], exposedProviderTools: ["fetch_content"] },
      provider,
      storage,
    );
    setWorkflowFetchCachePublicationHooksForTests({
      beforePublication(key) {
        mkdirSync(join(cacheDir, "objects"), { recursive: true, mode: 0o700 });
        writeFileSync(join(cacheDir, "objects", `${key}.json`), `${JSON.stringify(winner)}\n`, { mode: 0o600 });
      },
    });
    const result = await registered.get("fetch_content").execute("race", { url });
    assert.match(result.content[0].text, /durable winner bytes/);
    assert.doesNotMatch(result.content[0].text, /losing provider bytes/);
    assert.equal(result.details.cache.hit, true);
    assert.equal(readFileSync(join(cacheDir, "objects", `${cacheKey(url)}.json`), "utf8").includes("losing provider bytes"), false);
    assert.equal(appended.filter((entry) => entry.type === "web-search-results").at(-1).data.urls[0].content, "durable winner bytes");
  } finally {
    setWorkflowFetchCachePublicationHookForTests(undefined);
    cleanup(cwd);
  }
});

test("provider URL validation abort does not publish a negative cache or source", async () => {
  const cwd = project();
  try {
    const cacheDir = join(cwd, "web-cache");
    const registered = new Map();
    const controller = new AbortController();
    const pi = { registerTool(tool) { registered.set(tool.name, tool); } };
    registerWorkflowWebSourceExtension(pi, {
      schema: "workflow-web-source-launch-config-v1",
      runId: "run", taskId: "task", cwd, cacheDir,
      provider: { kind: "extension", trustedCustomProvider: true },
      securityPolicy: { allowPrivateHosts: false, cacheRawProviderPayloads: false },
      exposedWorkflowTools: ["workflow_web_fetch_source"],
    }, (providerPi) => providerPi.registerTool({
      name: "fetch_content",
      async execute() {
        setImmediate(() => controller.abort());
        const urls = Array.from({ length: 100 }, (_, index) => `http://1.1.1.1/result-${index}`);
        return { content: [{ type: "text", text: "provider body" }], details: { urls, urlCount: urls.length } };
      },
    }));
    const result = body(await registered.get("workflow_web_fetch_source").execute("cancel-validation", { url: "http://1.1.1.1/source" }, controller.signal));
    assert.equal(result.status, "cancelled");
    assert.equal(readdirSync(cacheDir, { withFileTypes: true }).some((entry) => entry.name === "sources"), false);
    assert.equal(readdirSync(cacheDir, { withFileTypes: true }).some((entry) => entry.name === "fetch-negative-cache"), false);
  } finally {
    cleanup(cwd);
  }
});

test("WEB-SEC-001 redacts URL fragments through direct, persisted, hydrated, card, event, and read paths", async () => {
  const cwd = project();
  try {
    const config = { runId: "run", taskId: "task", cacheDir: join(cwd, "sources") };
    const sentinels = [
      "web-sec-001-fragment-secret",
      "web-sec-001-encoded-secret",
      "web-sec-001-whole-secret",
      "WEB-SEC-001-ENCODED-SEPARATOR-REPRO",
    ];
    const encodedSeparatorUrl =
      `https://provider.example/callback#foo=bar%26access_token%3D${sentinels[3]}`;
    assert.equal(
      redactSensitiveWorkflowText(encodedSeparatorUrl),
      "https://provider.example/callback#foo=bar&access_token=REDACTED",
    );
    assert.equal(
      sanitizeUrlForModel(encodedSeparatorUrl),
      "https://provider.example/callback#foo=bar&access_token=REDACTED",
    );
    const benignEncodedValue =
      "https://provider.example/docs#foo=bar%26label%3Dvisible";
    assert.equal(redactSensitiveWorkflowText(benignEncodedValue), benignEncodedValue);
    const malformedFragment =
      `https://provider.example/callback#foo=bar%ZZaccess_token%3D${sentinels[3]}`;
    const malformedRedacted = redactSensitiveWorkflowText(malformedFragment);
    assert.doesNotMatch(malformedRedacted, new RegExp(sentinels[3]));
    assert.match(malformedRedacted, /REDACTED/);
    const providerText = [
      `primary https://provider.example/callback#access_token=${sentinels[0]}`,
      `encoded https://provider.example/callback#access%5Ftoken=${sentinels[1]}`,
      `whole https://provider.example/callback#%61ccess_token%3D${sentinels[2]}`,
      `nested ${encodedSeparatorUrl}`,
      "benign https://provider.example/docs#section-2",
    ].join(" | ");
    const direct = redactSensitiveWorkflowText(providerText);
    for (const sentinel of sentinels) assert.equal(direct.includes(sentinel), false);
    assert.match(direct, /#access_token=REDACTED/);
    assert.match(direct, /#section-2/);

    const source = await writeWorkflowWebSource(config, createWorkflowWebSource({
      config,
      url: encodedSeparatorUrl,
      text: providerText,
    }));
    await recordWorkflowWebSourceEvent(config, "provider-result", {
      text: providerText,
      nested: { callback: `https://provider.example/callback#access_token=${sentinels[0]}` },
    });
    const card = buildWorkflowWebSourceCard({
      source,
      policy: {
        previewChars: 1000,
        duplicatePreviewChars: 1000,
        sourceReadMaxChars: 1000,
        searchSnippetChars: 1000,
        perTaskVisibleCharBudget: 1000,
      },
      budget: createWorkflowWebVisibleBudget(1000),
    });
    const hydrated = await readWorkflowWebSource(config, source.sourceRef);
    assert(hydrated);
    const read = readWorkflowWebSourceSnippet({
      source: hydrated,
      query: "access_token=REDACTED",
      maxChars: 1000,
      budget: createWorkflowWebVisibleBudget(1000),
    });
    const visible = JSON.stringify({ source, card, hydrated, read });
    const persisted = [
      ...readdirSync(join(config.cacheDir, "sources"))
        .map((name) => readFileSync(join(config.cacheDir, "sources", name), "utf8")),
      readFileSync(join(config.cacheDir, "events.jsonl"), "utf8"),
      readFileSync(join(config.cacheDir, "index-events.jsonl"), "utf8"),
      readFileSync(join(config.cacheDir, "index.json"), "utf8"),
    ].join("\\n");
    for (const sentinel of sentinels) {
      assert.equal(visible.includes(sentinel), false, `visible sentinel: ${sentinel}`);
      assert.equal(persisted.includes(sentinel), false, `persisted sentinel: ${sentinel}`);
    }
    assert.match(visible, /section-2/);
  } finally {
    cleanup(cwd);
  }
});

test("writeWorkflowWebSource redacts direct-writer text and read rejects a raw legacy identity", async () => {
  const cwd = project();
  try {
    const config = { runId: "run", taskId: "task", cacheDir: join(cwd, "sources") };
    const url = "https://writer.example/source";
    const safeText = redactSensitiveWorkflowText("Authorization: Bearer direct-writer-secret");
    const base = createWorkflowWebSource({ config, url, text: "safe" });
    const unsafe = { ...base, text: "Authorization: Bearer direct-writer-secret", sourceRef: sourceRefFor(url, "Authorization: Bearer direct-writer-secret") };
    const written = await writeWorkflowWebSource(config, unsafe);
    assert.equal(written.text, safeText);
    assert.equal(written.sourceRef, sourceRefFor(url, safeText));
    const persisted = readdirSync(join(config.cacheDir, "sources")).map((name) => readFileSync(join(config.cacheDir, "sources", name), "utf8")).join("\n");
    assert.doesNotMatch(persisted, /direct-writer-secret/);
    assert.equal((await readWorkflowWebSource(config, written.sourceRef)).text, safeText);

    const legacyRef = sourceRefFor(url, "raw legacy secret");
    writeFileSync(join(config.cacheDir, "sources", `${legacyRef}.json`), JSON.stringify({
      schema: "workflow-web-source-cache-v1", sourceRef: legacyRef, createdAt: new Date().toISOString(),
      runId: config.runId, taskId: config.taskId, url, redactedUrl: url,
      text: "Authorization: Bearer raw legacy secret",
    }));
    assert.equal(await readWorkflowWebSource(config, legacyRef), undefined);
  } finally {
    cleanup(cwd);
  }
});
