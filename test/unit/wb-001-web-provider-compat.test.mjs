import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";

import {
	buildWorkflowFetchCacheExtensionWrapper,
	registerWorkflowFetchCacheExtension,
} from "../../.tmp/unit/workflow-fetch-cache-extension.js";
import {
	buildWorkflowWebSourceExtensionWrapper,
	registerWorkflowWebSourceExtension,
} from "../../.tmp/unit/workflow-web-source-extension.js";
import { isSensitiveWorkflowQueryKey } from "../../.tmp/unit/workflow-sensitive-query.js";
import {
	runOneShotSubagentCall,
	setSubagentApiForTests,
	prepareSubagentTaskLaunch,
	assertSubagentExtensionsLoadable,
} from "../../.tmp/unit/subagent-backend.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const actualWebAccessExtension = join(root, "node_modules/pi-web-access/index.ts");
const actualWebAccessStorage = join(root, "node_modules/pi-web-access/storage.ts");
const fetchCacheAdapter = join(root, ".tmp/unit/workflow-fetch-cache-extension.js");

function makeProject() {
	return mkdtempSync(join(tmpdir(), "workflow-wb001-"));
}

function removeProject(cwd) {
	rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

function allFiles(path) {
	if (!existsSync(path)) return [];
	const result = [];
	for (const entry of readdirSync(path)) {
		const child = join(path, entry);
		if (statSync(child).isDirectory()) result.push(...allFiles(child));
		else result.push(child);
	}
	return result;
}

function inlineFetchData(id, url, content, extra = {}) {
	return {
		id,
		type: "fetch",
		timestamp: Date.now(),
		urls: [
			{
				url,
				title: `Title containing [${id}] and responseId: "${id}"`,
				content,
				error: null,
				status: 200,
				mimeType: "text/html",
				...extra,
			},
		],
	};
}

function fetchResult(id, url, text) {
	return {
		content: [
			{
				type: "text",
				text: `${text}\n\n---\nShowing 120 of 240 chars, 120 of 240 bytes, and 3 of 6 lines. Use get_search_content({ responseId: "${id}", urlIndex: 0, offset: 120 }) for the next slice.`,
			},
		],
		details: {
			urls: [url],
			urlCount: 1,
			successful: 1,
			responseId: id,
			totalChars: text.length,
			mode: "readable",
			truncated: true,
		},
	};
}

test("WB-001 shared query classifier catches credential compounds without substring false positives", () => {
	for (const key of [
		"apiKey",
		"apikey",
		"authkey",
		"authKey",
		"apiSecret",
		"apisecret",
		"APIToken",
		"JWTToken",
		"authToken",
		"accessToken",
		"accesskey",
		"clientSecret",
		"secretkey",
		"authorization",
		"sessionId",
		"sessiontoken",
		"session_id",
		"X-Amz-Credential",
	]) {
		assert.equal(isSensitiveWorkflowQueryKey(key), true, key);
	}
	for (const key of ["monkey", "keynote", "authentication", "apikeyleak"]) {
		assert.equal(isSensitiveWorkflowQueryKey(key), false, key);
	}
});

test("WB-001 repeated percent decoding catches deeper encoded credential keys and fails closed on residual escapes", () => {
	const repeatedlyEncoded = (value, depth) => {
		let encoded = value;
		for (let index = 0; index < depth; index += 1) encoded = encodeURIComponent(encoded);
		return encoded;
	};
	assert.equal(isSensitiveWorkflowQueryKey(repeatedlyEncoded("api key", 7)), true);
	assert.equal(isSensitiveWorkflowQueryKey(repeatedlyEncoded("session token", 8)), true);
	assert.equal(isSensitiveWorkflowQueryKey(repeatedlyEncoded("api key", 9)), true);
	assert.equal(isSensitiveWorkflowQueryKey("api%ZZKey"), true);
	assert.equal(isSensitiveWorkflowQueryKey("api%25Key%"), true);
});

test("WB-001 hydrates the actual pi-web-access 0.24.2 storage shape and replays identity only", async () => {
	const cwd = makeProject();
	const previousConfigDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = join(cwd, "pi-config");
		const jiti = createJiti(import.meta.url, { moduleCache: false });
		const storage = await jiti.import(actualWebAccessStorage);
		storage.clearResults();
		const cacheDir = join(cwd, ".pi/workflows/run/source-cache/fetch-content");
		const registered = new Map();
		const appended = [];
		const hooks = [];
		let originCalls = 0;
		let generatedIds = 0;
		const pi = {
			registerTool(tool) {
				registered.set(tool.name, tool);
			},
			appendEntry(type, data) {
				appended.push({ type, data });
			},
			on(...args) {
				hooks.push(args);
			},
		};
		const provider = (providerPi) => {
			for (const lifecycle of ["session_start", "session_tree"]) {
				providerPi.on(lifecycle, async (_event, ctx) => {
					storage.restoreFromSession(ctx);
				});
			}
			providerPi.registerTool({
				name: "fetch_content",
				async execute(_id, params, _signal, _update, ctx) {
					assert.equal(ctx.marker, "extension-context");
					originCalls += 1;
					const responseId = "origin-identity-123";
					const body =
						"Page body [origin-identity-123] and responseId: \"origin-identity-123\" must remain byte-exact.";
					const data = inlineFetchData(responseId, params.url, body);
					data.timestamp = Date.now() - 1_000;
					const metadata = storage.storeFetchedContentResult(
						responseId,
						data,
					);
					providerPi.appendEntry("web-search-results", metadata);
					return fetchResult(responseId, params.url, body);
				},
			});
			providerPi.registerTool({
				name: "get_search_content",
				async execute(_id, params) {
					const stored = storage.getResult(params.responseId);
					return {
						content: [{ type: "text", text: stored.urls[params.urlIndex].content }],
						details: { responseId: params.responseId },
					};
				},
			});
		};
		const wrappedStorage = {
			...storage,
			generateId() {
				generatedIds += 1;
				return `replay-${generatedIds}`;
			},
		};
		registerWorkflowFetchCacheExtension(
			pi,
			{
				runId: "run",
				taskId: "task",
				cacheDir,
				requiredProviderTools: ["fetch_content", "get_search_content"],
				exposedProviderTools: ["fetch_content", "get_search_content"],
			},
			provider,
			wrappedStorage,
		);

		const ctx = { marker: "extension-context" };
		const sourceUrl =
			'https://example.test/[origin-identity-123]?note=responseId:%20"origin-identity-123"';
		const first = await registered
			.get("fetch_content")
			.execute("first", { url: sourceUrl }, undefined, undefined, ctx);
		const second = await registered
			.get("fetch_content")
			.execute("second", { url: sourceUrl }, undefined, undefined, ctx);

		assert.equal(originCalls, 1);
		assert.equal(first.details.cache.hit, false);
		assert.equal(second.details.cache.hit, true);
		assert.equal(second.details.responseId, "replay-1");
		const body =
			"Page body [origin-identity-123] and responseId: \"origin-identity-123\" must remain byte-exact.";
		assert.equal(second.content[0].text.startsWith(body), true);
		assert.match(second.content[0].text, /responseId: "replay-1".*for the next slice\.$/);
		assert.equal(
			second.content[0].text.slice(0, body.length),
			body,
			"fetched inline body bytes must not be rewritten",
		);
		const replay = storage.getResult("replay-1");
		assert.equal(replay.id, "replay-1");
		assert.ok(replay.timestamp > Date.now() - 500);
		assert.equal(replay.urls[0].url, sourceUrl);
		assert.equal(
			replay.urls[0].title,
			'Title containing [origin-identity-123] and responseId: "origin-identity-123"',
		);
		assert.equal(replay.urls[0].content, body);
		const retrieved = await registered
			.get("get_search_content")
			.execute("retrieve", { responseId: "replay-1", urlIndex: 0 });
		assert.equal(retrieved.content[0].text, body);
		assert.equal(retrieved.details.responseId, "replay-1");
		// The workflow alias is the durable fallback even when pi-web-access's
		// in-memory/session entry has expired or is not available yet.
		storage.clearResults();
		const aliasRestored = await registered
			.get("get_search_content")
			.execute("alias-restore", { responseId: "replay-1", urlIndex: 0 });
		assert.equal(aliasRestored.content[0].text, body);
		assert.ok(storage.getResult("replay-1").timestamp > Date.now() - 500);
		assert.deepEqual(appended.at(-1).data.urls, replay.urls);
		assert.equal(appended.at(-1).data.fetchCache, undefined);

		const replayEntry = appended.at(-1).data;
		assert.ok(Array.isArray(replayEntry.urls));
		for (const lifecycle of ["session_start", "session_tree"]) {
			storage.clearResults();
			const hook = hooks.find(([name]) => name === lifecycle)?.[1];
			assert.equal(typeof hook, "function", lifecycle);
			await hook({}, {
				sessionManager: { getBranch: () => [{
					type: "custom",
					customType: "web-search-results",
					data: replayEntry,
				}] },
			});
			const restored = await registered
				.get("get_search_content")
				.execute("restored", { responseId: "replay-1", urlIndex: 0 });
			assert.equal(restored.content[0].text, body);
		}

		const objectFile = allFiles(join(cacheDir, "objects"))[0];
		const persisted = JSON.parse(readFileSync(objectFile, "utf8"));
		assert.equal(persisted.storedData.fetchCache, undefined);
		assert.equal(persisted.storedData.urls[0].content, replay.urls[0].content);
		assert.deepEqual(appended.at(-1).data.urls, persisted.storedData.urls);
	} finally {
		if (previousConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousConfigDir;
		removeProject(cwd);
	}
});

test("WB-001 response aliases fail closed when tampered and do not intercept unmapped ids", async () => {
	const cwd = makeProject();
	try {
		const cacheDir = join(cwd, "alias-cache");
		const registered = new Map();
		const stored = new Map();
		let providerFetches = 0;
		let providerReads = 0;
		const pi = {
			registerTool(tool) { registered.set(tool.name, tool); },
			appendEntry() {},
			on() {},
		};
		const storage = {
			generateId() { return "alias-replay"; },
			storeResult(id, data) { stored.set(id, data); },
			getResult(id) { return stored.get(id); },
		};
		registerWorkflowFetchCacheExtension(
			pi,
			{
				runId: "run",
				taskId: "task",
				cacheDir,
				requiredProviderTools: ["fetch_content", "get_search_content"],
				exposedProviderTools: ["fetch_content", "get_search_content"],
			},
			(providerPi) => {
				providerPi.registerTool({
					name: "fetch_content",
					async execute(_id, params) {
						providerFetches += 1;
						const data = inlineFetchData("alias-origin", params.url, "durable");
						stored.set(data.id, data);
						return fetchResult(data.id, params.url, "durable");
					},
				});
				providerPi.registerTool({
					name: "get_search_content",
					async execute(_id, params) {
						providerReads += 1;
						const data = stored.get(params.responseId);
						return data
							? { content: [{ type: "text", text: data.urls[0].content }], details: { responseId: params.responseId } }
							: { content: [{ type: "text", text: "unmapped provider result" }], details: { responseId: params.responseId } };
					},
				});
			},
			storage,
		);
		await registered.get("fetch_content").execute("fetch", { url: "https://alias.example/page" });
		const aliases = allFiles(join(cacheDir, "aliases"));
		assert.equal(aliases.length, 1);
		assert.equal(statSync(aliases[0]).mode & 0o777, 0o600);
		assert.equal(statSync(join(cacheDir, "aliases")).mode & 0o777, 0o700);
		writeFileSync(aliases[0], JSON.stringify({ schema: "tampered" }));
		const tampered = await registered.get("get_search_content").execute("tampered", {
			responseId: "alias-origin",
			urlIndex: 0,
		});
		assert.equal(tampered.details.error, "Workflow response alias unavailable");
		assert.equal(providerReads, 0);
		const unmapped = await registered.get("get_search_content").execute("unmapped", {
			responseId: "ordinary-web-id",
			urlIndex: 0,
		});
		assert.equal(unmapped.content[0].text, "unmapped provider result");
		assert.equal(providerReads, 1);
		assert.equal(providerFetches, 1);
	} finally {
		removeProject(cwd);
	}
});

test("WB-001 mapped paging never splits astral characters and limit one advances", async () => {
	const cwd = makeProject();
	try {
		const cacheDir = join(cwd, "paging-cache");
		const registered = new Map();
		const stored = new Map();
		const content = "A😀BC";
		const pi = {
			registerTool(tool) { registered.set(tool.name, tool); },
			appendEntry() {},
			on() {},
		};
		const storage = {
			generateId() { return "paging-replay"; },
			storeResult(id, data) { stored.set(id, data); },
			getResult(id) { return stored.get(id); },
		};
		registerWorkflowFetchCacheExtension(
			pi,
			{
				runId: "run",
				taskId: "task",
				cacheDir,
				requiredProviderTools: ["fetch_content", "get_search_content"],
				exposedProviderTools: ["fetch_content", "get_search_content"],
			},
			(providerPi) => {
				providerPi.registerTool({
					name: "fetch_content",
					async execute(_id, params) {
						const data = inlineFetchData("paging-origin", params.url, content);
						stored.set(data.id, data);
						return fetchResult(data.id, params.url, content);
					},
				});
				providerPi.registerTool({
					name: "get_search_content",
					async execute(_id, params) {
						const data = stored.get(params.responseId);
						const url = data.urls[params.urlIndex];
						const end = Math.min(params.offset + params.limit, url.content.length);
						const slice = url.content.slice(params.offset, end);
						const more = end < url.content.length;
						const newline = String.fromCharCode(10);
						let text = [`# ${url.title}`, "", slice].join(newline);
						if (more || params.offset > 0) {
							text += ["", "", "---", `Showing chars ${params.offset}-${end} of ${url.content.length}.`].join(newline);
							if (more) text += ` Use get_search_content({ responseId: "${params.responseId}", urlIndex: ${params.urlIndex}, offset: ${end}, limit: ${params.limit} }) for the next slice.`;
						}
						return {
							content: [{ type: "text", text }],
							details: { url: url.url, title: url.title, contentLength: url.content.length, offset: params.offset, limit: params.limit, returnedChars: slice.length, nextOffset: more ? end : null, truncated: more },
						};
					},
				});
			},
			storage,
		);
		await registered.get("fetch_content").execute("fetch", { url: "https://paging.example/page" });
		const hit = await registered.get("fetch_content").execute("hit", { url: "https://paging.example/page" });
		const responseId = hit.details.responseId;
		const read = (offset) => registered.get("get_search_content").execute("read", { responseId, urlIndex: 0, offset, limit: 1 });
		const first = await read(0);
		assert.equal(first.details.offset, 0);
		assert.equal(first.details.returnedChars, 1);
		assert.equal(first.details.nextOffset, 1);
		const astral = await read(1);
		assert.equal(astral.details.offset, 1);
		assert.equal(astral.details.returnedChars, 2);
		assert.equal(astral.details.nextOffset, 3);
		assert.match(astral.content[0].text, /offset: 3, limit: 1/);
		const afterLow = await read(2);
		assert.equal(afterLow.details.offset, 3);
		assert.equal(afterLow.details.returnedChars, 1);
		assert.equal(afterLow.content[0].text.includes("😀"), false);
	} finally {
		removeProject(cwd);
	}
});

test("WB-001 cache-hit inline records restore one and multi-URL content through lifecycle hooks", async () => {
	const cwd = makeProject();
	const previousConfigDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = join(cwd, "pi-config");
		const jiti = createJiti(import.meta.url, { moduleCache: false });
		const storage = await jiti.import(actualWebAccessStorage);
		storage.clearResults();
		const registered = new Map();
		const appended = [];
		const hooks = [];
		let originCalls = 0;
		const pi = {
			registerTool(tool) { registered.set(tool.name, tool); },
			appendEntry(type, data) { appended.push({ type, data }); },
			on(...args) { hooks.push(args); },
		};
		const provider = (providerPi) => {
			for (const lifecycle of ["session_start", "session_tree"]) {
				providerPi.on(lifecycle, async (_event, ctx) => storage.restoreFromSession(ctx));
			}
			providerPi.registerTool({
				name: "fetch_content",
				async execute(_id, params) {
					originCalls += 1;
					const id = "multi-origin";
					const urls = params.urls ?? [params.url];
					const data = {
						id, type: "fetch", timestamp: Date.now(),
						urls: urls.map((url, index) => ({
							url, title: `Title ${index}`, content: `Content ${index}`, error: null,
						})),
					};
					const metadata = storage.storeFetchedContentResult(id, data);
					providerPi.appendEntry("web-search-results", metadata);
					return {
						content: [{ type: "text", text: "multi result" }],
						details: { responseId: id, urlCount: urls.length, successful: urls.length, urls },
					};
				},
			});
			providerPi.registerTool({
				name: "get_search_content",
				async execute(_id, params) {
					const data = storage.getResult(params.responseId);
					return { content: [{ type: "text", text: data.urls[params.urlIndex].content }], details: { responseId: params.responseId } };
				},
			});
		};
		const wrappedStorage = { ...storage, generateId: () => "multi-replay" };
		registerWorkflowFetchCacheExtension(
			pi,
			{ runId: "run", taskId: "task", cacheDir: join(cwd, "cache"), requiredProviderTools: ["fetch_content", "get_search_content"], exposedProviderTools: ["fetch_content", "get_search_content"] },
			provider,
			wrappedStorage,
		);
		const params = { urls: ["https://one.example.test", "https://two.example.test"] };
		await registered.get("fetch_content").execute("first", params);
		const hit = await registered.get("fetch_content").execute("hit", params);
		assert.equal(originCalls, 1);
		const replay = appended.at(-1).data;
		assert.deepEqual(replay.urls.map((item) => item.content), ["Content 0", "Content 1"]);
		assert.equal(replay.fetchCache, undefined);
		for (const lifecycle of ["session_start", "session_tree"]) {
			storage.clearResults();
			const hook = hooks.find(([name]) => name === lifecycle)?.[1];
			await hook({}, { sessionManager: { getBranch: () => [{ type: "custom", customType: "web-search-results", data: replay }] } });
			for (const [urlIndex, expected] of ["Content 0", "Content 1"].entries()) {
				const result = await registered.get("get_search_content").execute("read", { responseId: hit.details.responseId, urlIndex });
				assert.equal(result.content[0].text, expected);
			}
		}
	} finally {
		if (previousConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousConfigDir;
		removeProject(cwd);
	}
});

test("WB-001 bypasses auth, answer, invalid, userinfo, fragment, and credential URLs before cache state", async () => {
	const cwd = makeProject();
	try {
		const cacheDir = join(cwd, "workflow-cache");
		const registered = new Map();
		const contexts = [];
		let calls = 0;
		const secret = "WB001-DO-NOT-PERSIST-SECRET";
		const pi = {
			registerTool(tool) {
				registered.set(tool.name, tool);
			},
			appendEntry() {},
			on() {},
		};
		const storage = {
			generateId() {
				return "never";
			},
			storeResult() {},
			getResult() {
				throw new Error("cache hydration must not run for bypassed calls");
			},
		};
		registerWorkflowFetchCacheExtension(
			pi,
			{ runId: "run", taskId: "task", cacheDir, maxInlineChars: 4 },
			(providerPi) => {
				providerPi.registerTool({
					name: "fetch_content",
					async execute(_id, _params, _signal, _update, ctx) {
						calls += 1;
						contexts.push(ctx);
						return {
							content: [{ type: "text", text: secret }],
							details: { successful: 1 },
						};
					},
				});
			},
			storage,
		);
		const requests = [
			{ url: "https://example.test/auth", auth: undefined },
			{ url: "https://example.test/auth-false", auth: false },
			{ url: "https://example.test/answer", mode: "answer", prompt: secret },
			{ url: "not a url" },
			{ url: "file:///tmp/secret" },
			{ url: "https://user:pass@example.test/private" },
			{ url: "https://example.test/page#section" },
			{ url: "https://example.test/?token=value" },
			{ url: "https://example.test/?X-Amz-Credential=value" },
			{ url: "https://example.test/?X-Amz-Signature=value" },
			{ url: "https://example.test/?session_id=value" },
			{ url: "https://example.test/?apiKey=value" },
			{ url: "https://example.test/?apikey=value" },
			{ url: "https://example.test/?apisecret=value" },
			{ url: "https://example.test/?accesskey=value" },
			{ url: "https://example.test/?secretkey=value" },
			{ url: "https://example.test/?sessiontoken=value" },
			{ url: "https://example.test/?APIToken=value" },
			{ url: "https://example.test/?JWTToken=value" },
			{ url: "https://example.test/?authToken=value" },
			{ url: "https://example.test/?accessToken=value" },
			{ url: "https://example.test/?clientSecret=value" },
			{ url: "https://example.test/?authorization=value" },
			{ url: "https://example.test/?sessionId=value" },
			{ url: "https://example.test/?%58-%41mz-%43redential=value" },
		];
		const context = { marker: "fifth-context" };
		for (const params of requests) {
			const result = await registered
				.get("fetch_content")
				.execute("bypass", params, undefined, undefined, context);
			assert.equal(result.content[0].text, secret);
		}
		assert.equal(calls, requests.length);
		assert.equal(contexts.every((value) => value === context), true);
		assert.equal(existsSync(cacheDir), false);
	} finally {
		removeProject(cwd);
	}
});

test("WB-001 separates readable/raw keys and invocation-scopes concurrent append fallback", async () => {
	const cwd = makeProject();
	try {
		const cacheDir = join(cwd, "workflow-cache");
		const registered = new Map();
		const stored = new Map();
		let replayId = 0;
		let origins = 0;
		const pi = {
			registerTool(tool) {
				registered.set(tool.name, tool);
			},
			appendEntry() {},
			on() {},
		};
		const storage = {
			generateId() {
				replayId += 1;
				return `replay-${replayId}`;
			},
			storeResult(id, data) {
				stored.set(id, data);
			},
		};
		registerWorkflowFetchCacheExtension(
			pi,
			{ runId: "run", taskId: "task", cacheDir },
			(providerPi) => {
				providerPi.registerTool({
					name: "fetch_content",
					async execute(_id, params) {
						origins += 1;
						const id = "shared-origin-id";
						const delay = params.url.includes("slow") ? 30 : 0;
						await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
						const body = `${params.mode ?? "readable"}:${params.url}`;
						providerPi.appendEntry(
							"web-search-results",
							inlineFetchData(id, params.url, body, {
								authorization: "credential-secret-value",
							}),
						);
						return fetchResult(id, params.url, body);
					},
				});
			},
			storage,
		);
		const tool = registered.get("fetch_content");
		await Promise.all([
			tool.execute("slow", { url: "https://slow.example.test/page" }),
			tool.execute("fast", { url: "https://fast.example.test/page" }),
		]);
		const slow = await tool.execute("slow-hit", {
			url: "https://slow.example.test/page",
		});
		const fast = await tool.execute("fast-hit", {
			url: "https://fast.example.test/page",
		});
		await tool.execute("readable", { url: "https://mode.example.test/page" });
		await tool.execute("raw", {
			url: "https://mode.example.test/page",
			mode: "raw",
		});
		await tool.execute("readable-hit", {
			url: "https://mode.example.test/page",
			mode: "readable",
		});
		await tool.execute("raw-hit", {
			url: "https://mode.example.test/page",
			mode: "raw",
		});

		assert.match(stored.get(slow.details.responseId).urls[0].content, /^readable:https:\/\/slow/);
		assert.match(stored.get(fast.details.responseId).urls[0].content, /^readable:https:\/\/fast/);
		assert.equal(origins, 4);
		const cacheText = allFiles(cacheDir)
			.map((file) => readFileSync(file, "utf8"))
			.join("\n");
		assert.doesNotMatch(cacheText, /auth|password|credential-secret-value/);
	} finally {
		removeProject(cwd);
	}
});

test("WB-001 mixed registration is canonical, buffered, selected, and has one legacy hook set", () => {
	const registered = new Map();
	const hooks = [];
	const commands = [];
	const shortcuts = [];
	const pi = {
		registerTool(tool) {
			registered.set(tool.name, tool);
		},
		on(...args) {
			hooks.push(args);
		},
		registerCommand(...args) {
			commands.push(args);
		},
		registerShortcut(...args) {
			shortcuts.push(args);
		},
		appendEntry() {},
	};
	const provider = (providerPi) => {
		providerPi.on("session_start", () => undefined);
		providerPi.registerShortcut("ctrl+x", {});
		providerPi.registerCommand("search", {});
		for (const name of [
			"web_search",
			"source_check",
			"fetch_content",
			"get_search_content",
			"renamed_fetch",
			"unknown_tool",
		]) {
			providerPi.registerTool({ name, async execute() { return { content: [] }; } });
		}
	};
	const storage = {
		generateId() {
			return "id";
		},
		storeResult() {},
	};
	registerWorkflowFetchCacheExtension(
		pi,
		{
			runId: "run",
			taskId: "task",
			cacheDir: "/unused",
			requiredProviderTools: ["fetch_content"],
			exposedProviderTools: ["fetch_content"],
		},
		provider,
		storage,
	);
	registerWorkflowWebSourceExtension(
		pi,
		{
			schema: "workflow-web-source-launch-config-v1",
			runId: "run",
			taskId: "task",
			cwd: "/unused",
			cacheDir: "/unused",
			provider: { kind: "extension" },
			securityPolicy: { allowPrivateHosts: true },
			exposedWorkflowTools: ["workflow_web_search", "workflow_web_source_read"],
			requiredProviderTools: ["web_search"],
		},
		provider,
	);

	assert.deepEqual([...registered.keys()].sort(), [
		"fetch_content",
		"workflow_web_search",
		"workflow_web_source_read",
	]);
	assert.equal(hooks.length, 1);
	assert.equal(commands.length, 0);
	assert.equal(shortcuts.length, 0);

	const atomicTools = [];
	const atomicHooks = [];
	assert.throws(
		() =>
			registerWorkflowFetchCacheExtension(
				{
					registerTool(tool) {
						atomicTools.push(tool.name);
					},
					on(...args) {
						atomicHooks.push(args);
					},
				},
				{
					runId: "run",
					taskId: "task",
					cacheDir: "/unused",
					requiredProviderTools: ["fetch_content"],
				},
				(providerPi) => {
					providerPi.on("session_start", () => undefined);
					providerPi.registerTool({ name: "renamed_fetch", async execute() {} });
				},
				storage,
			),
		/missing required tool\(s\): fetch_content/,
	);
	assert.deepEqual(atomicTools, []);
	assert.deepEqual(atomicHooks, []);
});

test("WB-001 actual 0.24.2 mixed loader exposes selected tools and one lifecycle hook set", async () => {
	const cwd = makeProject();
	const previousConfigDir = process.env.PI_CODING_AGENT_DIR;
	try {
		const configDir = join(cwd, "pi-config");
		mkdirSync(configDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = configDir;
		const legacyWrapper = join(cwd, "legacy-wrapper.ts");
		const normalizedWrapper = join(cwd, "normalized-wrapper.ts");
		writeFileSync(
			legacyWrapper,
			buildWorkflowFetchCacheExtensionWrapper({
				importPath: fetchCacheAdapter,
				webAccessExtensionPath: actualWebAccessExtension,
				webAccessStoragePath: actualWebAccessStorage,
				config: {
					runId: "run",
					taskId: "task",
					cacheDir: join(cwd, "legacy-cache"),
					providerKind: "pi-web-access",
					requiredProviderTools: ["fetch_content"],
					exposedProviderTools: ["fetch_content"],
				},
			}),
		);
		writeFileSync(
			normalizedWrapper,
			buildWorkflowWebSourceExtensionWrapper({
				importPath: join(root, ".tmp/unit/workflow-web-source-extension.js"),
				providerExtensionPath: actualWebAccessExtension,
				config: {
					schema: "workflow-web-source-launch-config-v1",
					runId: "run",
					taskId: "task",
					cwd,
					cacheDir: join(cwd, "normalized-cache"),
					provider: { kind: "pi-web-access" },
					securityPolicy: {
						allowPrivateHosts: false,
						cacheRawProviderPayloads: false,
					},
					exposedWorkflowTools: [
						"workflow_web_search",
						"workflow_web_source_read",
					],
					requiredProviderTools: ["web_search"],
				},
			}),
		);
		const piSdk = await import("@earendil-works/pi-coding-agent");
		const loader = new piSdk.DefaultResourceLoader({
			cwd,
			agentDir: join(cwd, "agent"),
			additionalExtensionPaths: [legacyWrapper, normalizedWrapper],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		const loaded = loader.getExtensions();
		assert.deepEqual(loaded.errors, []);
		const toolNames = loaded.extensions.flatMap((extension) => [
			...extension.tools.keys(),
		]);
		assert.deepEqual(toolNames.sort(), [
			"fetch_content",
			"workflow_web_search",
			"workflow_web_source_read",
		]);
		assert.equal(
			loaded.extensions.reduce(
				(total, extension) => total + extension.handlers.size,
				0,
			),
			3,
		);
		assert.equal(
			loaded.extensions.reduce(
				(total, extension) => total + extension.commands.size,
				0,
			),
			0,
		);
		assert.equal(
			loaded.extensions.reduce(
				(total, extension) => total + extension.shortcuts.size,
				0,
			),
			0,
		);
		assert.equal(toolNames.includes("source_check"), false);
		assert.equal(toolNames.includes("get_search_content"), false);
		assert.equal(toolNames.includes("workflow_web_fetch_source"), false);
	} finally {
		if (previousConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousConfigDir;
		removeProject(cwd);
	}
});

test("WB-001 legacy custom ownership is wrapped, preflighted, and mixed tools remain additive", async () => {
	const cwd = makeProject();
	try {
		const customProvider = join(cwd, "custom-legacy-provider.mjs");
		const unrelatedProvider = join(cwd, "unrelated-provider.mjs");
		writeFileSync(customProvider, `export default function customLegacyProvider(pi) {
	pi.registerTool({ name: "fetch_content", async execute() { return { content: [{ type: "text", text: "custom fetch" }], details: { responseId: "custom-id" } }; } });
	pi.registerTool({ name: "get_search_content", async execute() { return { content: [{ type: "text", text: "custom read" }], details: { responseId: "custom-id" } }; } });
}
`);
		writeFileSync(unrelatedProvider, `export default function unrelatedProvider(pi) {
	pi.registerTool({ name: "custom_tool", async execute() { return { content: [{ type: "text", text: "unrelated" }] }; } });
}
`);
		const prepared = await prepareSubagentTaskLaunch(
			cwd,
			{ runId: "legacy-custom-owner" },
			{ taskId: "task", files: { result: ".tmp/legacy-custom-result.json" } },
			{
				runtime: {
					tools: ["fetch_content", "get_search_content", "custom_tool"],
					toolProviders: {
						fetch_content: { extensions: [customProvider], classification: "read-only" },
						get_search_content: { extensions: [customProvider], classification: "read-only" },
						custom_tool: { extensions: [unrelatedProvider], classification: "read-only" },
					},
				},
			},
		);
		const wrapperPath = prepared.extensions.find((entry) => entry.endsWith("workflow-fetch-cache-extension.ts"));
		assert(wrapperPath);
		const wrapperText = readFileSync(wrapperPath, "utf8");
		assert.match(wrapperText, /import webAccessExtension from .*custom-legacy-provider.mjs/);
		assert.match(wrapperText, /"providerKind": "extension"/);
		assert.equal(wrapperText.includes("node_modules/pi-web-access/storage.ts"), true);
		assert.equal(prepared.extensions.includes(customProvider), false);
		assert.equal(prepared.extensions.includes(unrelatedProvider), true);
		assert.deepEqual(prepared.toolProviders, {
			fetch_content: { extensions: [customProvider], classification: "read-only" },
			get_search_content: { extensions: [customProvider], classification: "read-only" },
			custom_tool: { extensions: [unrelatedProvider], classification: "read-only" },
		});
		await assertSubagentExtensionsLoadable({ cwd, extensions: prepared.extensions });
		const piSdk = await import("@earendil-works/pi-coding-agent");
		const loader = new piSdk.DefaultResourceLoader({
			cwd,
			agentDir: join(cwd, "agent"),
			additionalExtensionPaths: prepared.extensions,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		const loaded = loader.getExtensions();
		assert.deepEqual(loaded.errors, []);
		const names = loaded.extensions.flatMap((extension) => [...extension.tools.keys()]);
		assert.equal(names.filter((name) => name === "fetch_content").length, 1);
		assert.equal(names.filter((name) => name === "get_search_content").length, 1);
		assert.equal(names.filter((name) => name === "custom_tool").length, 1);
		await assert.rejects(
			() => prepareSubagentTaskLaunch(cwd, { runId: "legacy-split" }, { taskId: "task", files: { result: ".tmp/legacy-split-result.json" } }, { runtime: { tools: ["fetch_content", "get_search_content"], toolProviders: { fetch_content: { extensions: [customProvider] } } } }),
			/legacy provider ownership is split/,
		);
		await assert.rejects(
			() => prepareSubagentTaskLaunch(cwd, { runId: "legacy-multiple" }, { taskId: "task", files: { result: ".tmp/legacy-multiple-result.json" } }, { runtime: { tools: ["fetch_content"], toolProviders: { fetch_content: { extensions: [customProvider, unrelatedProvider] } } } }),
			/legacy provider ownership is incompatible/,
		);
	} finally {
		removeProject(cwd);
	}
});

test("WB-001 fresh-process effective config matrix fails before upstream initialization for every canonical capability and root", () => {
	const capabilities = {
		web_search: "webSearch",
		fetch_content: "fetchContent",
		get_search_content: "getSearchContent",
	};
	const roots = ["PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "HOME"];
	const fixtures = [
		{ name: "default", content: (_key) => "{}", ok: true },
		{
			name: "renamed",
			content: (key) => JSON.stringify({ toolNames: { [key]: `renamed_${key}` } }),
			ok: false,
			code: "required_tool_renamed",
		},
		{
			name: "disabled",
			content: (key) => JSON.stringify({ tools: { [key]: { enabled: false } } }),
			ok: false,
			code: "required_tool_disabled",
		},
		{
			name: "malformed-json",
			content: () => '{"TOP-SECRET-SENTINEL":',
			ok: false,
			code: "invalid_json",
		},
		{
			name: "malformed-field",
			content: (key) =>
				JSON.stringify({ toolNames: { [key]: { secret: "TOP-SECRET-SENTINEL" } } }),
			ok: false,
			code: "invalid_tool_name_configuration",
		},
	];
	const cwd = makeProject();
	try {
		const childPath = join(cwd, "preflight-child.mjs");
		writeFileSync(
			childPath,
			`import { createJiti } from ${JSON.stringify(import.meta.resolve("jiti"))};
import { registerWorkflowFetchCacheExtension } from ${JSON.stringify(pathToFileURL(fetchCacheAdapter).href)};
const required = process.argv[2];
const jiti = createJiti(import.meta.url, { moduleCache: false });
const actualWebAccessModule = await jiti.import(process.argv[3]);
const actualWebAccessExtension = actualWebAccessModule.default ?? actualWebAccessModule;
let upstreamInitializations = 0;
let providerDispatches = 0;
globalThis.fetch = async () => {
  providerDispatches += 1;
  throw new Error("provider/network dispatch must not run during preflight");
};
let modelDispatches = 0;
let backendDispatches = 0;
let registrations = 0;
try {
  registerWorkflowFetchCacheExtension(
    { registerTool() { registrations += 1; }, on() {} },
    { runId: "run", taskId: "task", cacheDir: "/unused", providerKind: "pi-web-access", requiredProviderTools: [required], exposedProviderTools: [required] },
    (pi) => {
      upstreamInitializations += 1;
      actualWebAccessExtension(pi);
    },
    { generateId() { return "id"; }, storeResult() {} },
  );
  console.log(JSON.stringify({ ok: true, upstreamInitializations, providerDispatches, modelDispatches, backendDispatches, registrations }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error), upstreamInitializations, providerDispatches, modelDispatches, backendDispatches, registrations }));
}
`,
		);

		for (const [capability, key] of Object.entries(capabilities)) {
			for (const rootKind of roots) {
				for (const fixture of fixtures) {
					const configRoot = join(cwd, capability, rootKind, fixture.name);
					const configDir =
						rootKind === "PI_CODING_AGENT_DIR"
							? configRoot
							: rootKind === "XDG_CONFIG_HOME"
								? join(configRoot, "pi")
								: join(configRoot, ".pi");
					mkdirSync(configDir, { recursive: true });
					writeFileSync(join(configDir, "web-search.json"), fixture.content(key));
					const env = { ...process.env, HOME: join(cwd, "unused-home") };
					delete env.PI_CODING_AGENT_DIR;
					delete env.XDG_CONFIG_HOME;
					env[rootKind] = configRoot;
					const child = spawnSync(
						process.execPath,
						[childPath, capability, actualWebAccessExtension],
						{
							env,
							encoding: "utf8",
						},
					);
					assert.equal(child.status, 0, `${capability}/${rootKind}/${fixture.name}: ${child.stderr}`);
					const result = JSON.parse(child.stdout.trim());
					assert.equal(
						result.ok,
						fixture.ok,
						`${capability}/${rootKind}/${fixture.name}: ${result.message ?? "no error"}`,
					);
					assert.equal(result.providerDispatches, 0);
					assert.equal(result.modelDispatches, 0);
					assert.equal(result.backendDispatches, 0);
					if (fixture.ok) {
						assert.equal(result.upstreamInitializations, 1);
						assert.equal(result.registrations, 1);
					} else {
						assert.equal(result.upstreamInitializations, 0);
						assert.equal(result.registrations, 0);
						assert.match(result.message, new RegExp(`\\[${fixture.code}\\]`));
						assert.doesNotMatch(result.message, /TOP-SECRET-SENTINEL|web-search\\.json/);
					}
				}
			}
		}
	} finally {
		removeProject(cwd);
	}
});

test("WB-001 normalized pi-web-access registration validates config before provider initialization", () => {
	const cwd = makeProject();
	const previousConfigDir = process.env.PI_CODING_AGENT_DIR;
	try {
		const configDir = join(cwd, "pi-config");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "web-search.json"), '{"secret":"TOP-SECRET-SENTINEL"');
		process.env.PI_CODING_AGENT_DIR = configDir;
		let providerInitializations = 0;
		assert.throws(
			() => registerWorkflowWebSourceExtension(
				{ registerTool() {} },
				{
					schema: "workflow-web-source-launch-config-v1",
					runId: "run",
					taskId: "task",
					cwd,
					cacheDir: join(cwd, "cache"),
					provider: { kind: "pi-web-access" },
					requiredProviderTools: ["web_search"],
				},
				() => { providerInitializations += 1; },
			),
			/pi-web-access configuration preflight failed \[invalid_json\]/,
		);
		assert.equal(providerInitializations, 0);
		assert.equal(existsSync(join(cwd, "cache")), false);
	} finally {
		if (previousConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousConfigDir;
		removeProject(cwd);
	}
});

test("WB-001 actual 0.24.2 config incompatibility aborts loader preflight with zero backend dispatch", async () => {
	const cases = [
		{
			name: "renamed",
			content: JSON.stringify({ toolNames: { fetchContent: "fetch_page" } }),
			code: "required_tool_renamed",
		},
		{
			name: "disabled",
			content: JSON.stringify({ tools: { fetchContent: { enabled: false } } }),
			code: "required_tool_disabled",
		},
		{
			name: "malformed-json",
			content: '{"TOP-SECRET-SENTINEL":',
			code: "invalid_json",
		},
		{
			name: "malformed-field",
			content: JSON.stringify({ tools: { fetchContent: { enabled: "TOP-SECRET-SENTINEL" } } }),
			code: "invalid_tool_configuration",
		},
	];
	const previousConfigDir = process.env.PI_CODING_AGENT_DIR;
	try {
		for (const fixture of cases) {
			const cwd = makeProject();
			try {
				const configDir = join(cwd, "pi-config");
				mkdirSync(configDir, { recursive: true });
				writeFileSync(join(configDir, "web-search.json"), fixture.content);
				process.env.PI_CODING_AGENT_DIR = configDir;
				const wrapperPath = join(cwd, `${fixture.name}-wrapper.ts`);
				writeFileSync(
					wrapperPath,
					buildWorkflowFetchCacheExtensionWrapper({
						importPath: fetchCacheAdapter,
						webAccessExtensionPath: actualWebAccessExtension,
						webAccessStoragePath: actualWebAccessStorage,
						config: {
							runId: "run",
							taskId: "task",
							cacheDir: join(cwd, "workflow-cache"),
							providerKind: "pi-web-access",
							requiredProviderTools: ["fetch_content"],
							exposedProviderTools: ["fetch_content"],
						},
					}),
				);
				let backendCalls = 0;
				setSubagentApiForTests({
					async runSubagent() {
						backendCalls += 1;
						throw new Error("backend must not be called");
					},
				});
				await assert.rejects(
					() =>
						runOneShotSubagentCall({
							cwd,
							agent: "unit",
							task: "must not prompt",
							extensions: [wrapperPath],
						}),
					new RegExp(
						`Subagent extension preflight failed.*pi-web-access configuration preflight failed \\[${fixture.code}\\]`,
						"s",
					),
				);
				assert.equal(backendCalls, 0);
				assert.equal(existsSync(join(cwd, "workflow-cache")), false);
			} finally {
				setSubagentApiForTests(undefined);
				removeProject(cwd);
			}
		}
	} finally {
		if (previousConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousConfigDir;
	}
});
