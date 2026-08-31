import assert from "node:assert/strict";
import {
	chmodSync,
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
import { join, resolve } from "node:path";
import test from "node:test";
import { Value } from "typebox/value";

import {
	registerWorkflowWebSourceExtension,
	safeFetchWorkflowWebText,
} from "../../.tmp/unit/workflow-web-source-extension.js";
import {
	WORKFLOW_WEB_DIRECT_FETCHER,
	WORKFLOW_WEB_DIRECT_FETCH_POLICY,
	buildWorkflowWebSourceCard,
	createWorkflowWebSource,
	sanitizeUrlForModel,
	validateWorkflowWebUrl,
	createWorkflowWebVisibleBudget,
	findWorkflowWebSourceByUrl,
	readWorkflowWebSource,
	readWorkflowWebSourceIndex,
	recordWorkflowWebSourceEvent,
	writeWorkflowWebSource,
} from "../../.tmp/unit/workflow-web-source.js";

function makeProject() {
	return mkdtempSync(join(tmpdir(), "workflow-wb002-"));
}

function removeProject(cwd) {
	rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

function repeatedlyEncoded(value, depth) {
	let encoded = value;
	for (let index = 0; index < depth; index += 1) encoded = encodeURIComponent(encoded);
	return encoded;
}

function allFiles(path) {
	if (!existsSync(path)) return [];
	const files = [];
	for (const entry of readdirSync(path)) {
		const child = join(path, entry);
		if (statSync(child).isDirectory()) files.push(...allFiles(child));
		else files.push(child);
	}
	return files;
}

test("WB-002 URL security fails closed for malformed and over-depth sensitive query encoding", async () => {
	const cases = [
		"https://encoding.example/?api%ZZKey=secret-value",
		"https://encoding.example/?api%25Key%=secret-value",
		`https://encoding.example/?${repeatedlyEncoded("api key", 10)}=secret-value`,
	];
	for (const url of cases) {
		assert.deepEqual(validateWorkflowWebUrl(url, { allowPrivateHosts: true, cacheRawProviderPayloads: false }), {
			ok: false,
			reason: "sensitive_url_query",
		});
		const sanitized = sanitizeUrlForModel(url);
		assert.doesNotMatch(sanitized, /secret-value/);
		assert.match(sanitized, /REDACTED/);
	}

	const cwd = makeProject();
	try {
		const cacheDir = join(cwd, "legacy-encoding-cache");
		const sourceRef = "wsrc_00000000000000000000000000000000";
		mkdirSync(join(cacheDir, "sources"), { recursive: true });
		writeFileSync(
			join(cacheDir, "sources", `${sourceRef}.json`),
			JSON.stringify({
				schema: "workflow-web-source-cache-v1",
				sourceRef,
				createdAt: new Date().toISOString(),
				runId: "legacy",
				taskId: "task",
				url: cases[0],
				redactedUrl: sanitizeUrlForModel(cases[0]),
				text: "legacy body",
			}),
		);
		assert.equal(await readWorkflowWebSource({ runId: "legacy", taskId: "task", cacheDir }, sourceRef), undefined);

		const redactedUrl = cases[0].replace("secret-value", "REDACTED");
		writeFileSync(
			join(cacheDir, "sources", `${sourceRef}.json`),
			JSON.stringify({
				schema: "workflow-web-source-cache-v1",
				sourceRef,
				createdAt: new Date().toISOString(),
				runId: "legacy",
				taskId: "task",
				url: redactedUrl,
				redactedUrl: sanitizeUrlForModel(redactedUrl),
				text: "legacy body",
			}),
		);
		assert.ok(await readWorkflowWebSource({ runId: "legacy", taskId: "task", cacheDir }, sourceRef));
	} finally {
		removeProject(cwd);
	}
});

let registrationSequence = 0;

function registerSearch(cwd, execute, options = {}) {
	const registered = new Map();
	registrationSequence += 1;
	const cacheDir = options.cacheDir ?? join(cwd, `cache-${registrationSequence}`);
	registerWorkflowWebSourceExtension(
		{
			registerTool(tool) {
				registered.set(tool.name, tool);
			},
		},
		{
			schema: "workflow-web-source-launch-config-v1",
			runId: options.runId ?? "workflow_wb002",
			taskId: options.taskId ?? "task-1",
			cwd,
			cacheDir,
			...(options.webSourcePolicy ? { webSourcePolicy: options.webSourcePolicy } : {}),
			provider: { kind: "extension" },
			exposedWorkflowTools: ["workflow_web_search"],
			requiredProviderTools: ["web_search"],
		},
		(pi) => pi.registerTool({ name: "web_search", execute }),
	);
	return { tool: registered.get("workflow_web_search"), cacheDir };
}

function body(result) {
	return JSON.parse(result.content[0].text);
}

function registerOrdinaryPiWebSearch(cwd, execute) {
	const registered = new Map();
	const forwardedEntries = [];
	registrationSequence += 1;
	const cacheDir = join(cwd, `ordinary-cache-${registrationSequence}`);
	const previousConfigDir = process.env.PI_CODING_AGENT_DIR;
	const configDir = join(cwd, `ordinary-config-${registrationSequence}`);
	mkdirSync(configDir, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = configDir;
	try {
		registerWorkflowWebSourceExtension(
			{
				registerTool(tool) {
					registered.set(tool.name, tool);
				},
				appendEntry(type, data) {
					forwardedEntries.push({ type, data });
				},
			},
			{
				schema: "workflow-web-source-launch-config-v1",
				runId: "workflow_wb002_ordinary",
				taskId: "task-1",
				cwd,
				cacheDir,
				provider: { kind: "pi-web-access" },
				exposedWorkflowTools: ["workflow_web_search"],
				requiredProviderTools: ["web_search"],
			},
			(providerPi) => providerPi.registerTool({
				name: "web_search",
				execute: (...args) => execute(providerPi, ...args),
			}),
		);
	} finally {
		if (previousConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousConfigDir;
	}
	return {
		tool: registered.get("workflow_web_search"),
		cacheDir,
		forwardedEntries,
	};
}

function ordinarySearchRecord(id, queries) {
	return {
		id,
		type: "search",
		timestamp: 1_787_720_000_000,
		queries,
	};
}

function ordinarySearchResult(url, overrides = {}) {
	return {
		content: [{ type: "text", text: `Result ${url}` }],
		details: {
			queryCount: 1,
			successfulQueries: 1,
			totalResults: 1,
			...overrides,
		},
	};
}

test("WB-002 normalized numResults schema accepts only integers from 1 through 20", () => {
	const cwd = makeProject();
	try {
		const { tool } = registerSearch(cwd, async () => ({ content: [] }));
		for (const value of [0, 1.5, 21]) {
			assert.equal(Value.Check(tool.parameters, { query: "q", numResults: value }), false, String(value));
		}
		for (const value of [1, 20]) {
			assert.equal(Value.Check(tool.parameters, { query: "q", numResults: value }), true, String(value));
		}
		assert.equal(tool.parameters.properties.numResults.minimum, 1);
		assert.equal(tool.parameters.properties.numResults.maximum, 20);
		assert.equal(tool.parameters.properties.numResults.type, "integer");
	} finally {
		removeProject(cwd);
	}
});

test("WB-002 search status precedence covers success, partial, empty, failures, and cancellation without raw leakage", async () => {
	const cwd = makeProject();
	try {
		const fixtures = [
			{
				name: "success",
				execute: async () => ({
					content: [{ type: "text", text: "A https://one.example/a B https://two.example/b" }],
					details: { queryCount: 1, successfulQueries: 1, totalResults: 2 },
				}),
				status: "ok",
			},
			{
				name: "all-error",
				execute: async () => ({
					content: [{ type: "text", text: "Error: upstream credential secret-value" }],
					details: { queryCount: 2, successfulQueries: 0, totalResults: 0 },
				}),
				status: "failed",
				code: "search_failed",
			},
			{
				name: "partial",
				execute: async () => ({
					content: [{ type: "text", text: "A https://partial.example/a" }],
					details: { queryCount: 2, successfulQueries: 1, totalResults: 1 },
				}),
				status: "partial",
			},
			{
				name: "empty",
				execute: async () => ({
					content: [{ type: "text", text: "No provider sources were returned." }],
					details: { queryCount: 1, successfulQueries: 1, totalResults: 0 },
				}),
				status: "empty",
				code: "no_results",
			},
			{
				name: "positive-count-without-candidates",
				execute: async () => ({
					content: [{ type: "text", text: "   " }],
					details: { queryCount: 1, successfulQueries: 1, totalResults: 1 },
				}),
				status: "failed",
				code: "search_failed",
				nextPattern: /no usable candidate URL/,
			},
			{
				name: "returned-cancel",
				execute: async () => ({
					content: [{ type: "text", text: "cancelled with raw-secret-value" }],
					details: {
						cancelled: true,
						error: "raw-secret-value",
						queryCount: 2,
						successfulQueries: 0,
					},
				}),
				status: "cancelled",
				code: "search_cancelled",
			},
			{
				name: "returned-error",
				execute: async () => ({
					content: [{ type: "text", text: "provider exploded raw-secret-value" }],
					details: { error: "provider exploded raw-secret-value", successfulQueries: 1 },
				}),
				status: "failed",
				code: "search_failed",
			},
		];
		for (const fixture of fixtures) {
			const { tool, cacheDir } = registerSearch(cwd, fixture.execute);
			const payload = body(await tool.execute(`call-${fixture.name}`, { query: fixture.name }));
			assert.equal(payload.status, fixture.status, fixture.name);
			assert.equal(payload.code, fixture.code, fixture.name);
			assert.equal(payload.tool, "workflow_web_search");
			assert.ok(Array.isArray(payload.candidates));
			assert.equal(typeof payload.candidateCountTotal, "number");
			assert.equal(typeof payload.candidateCountReturned, "number");
			assert.equal(typeof payload.candidateTruncated, "boolean");
			assert.equal(typeof payload.upstreamTruncated, "boolean");
			assert.equal(typeof payload.truncated, "boolean");
			assert.ok(payload.budget);
			assert.equal(typeof payload.next, "string");
			if (fixture.nextPattern) assert.match(payload.next, fixture.nextPattern);
			assert.doesNotMatch(JSON.stringify(payload), /raw-secret-value|credential secret-value/);
			const persisted = allFiles(cacheDir).map((file) => readFileSync(file, "utf8")).join("\n");
			assert.doesNotMatch(persisted, /raw-secret-value|credential secret-value/);
		}

		const thrownAbort = registerSearch(cwd, async () => {
			throw new DOMException("raw abort secret", "AbortError");
		});
		const abortPayload = body(await thrownAbort.tool.execute("abort", { query: "abort" }));
		assert.equal(abortPayload.status, "cancelled");
		assert.equal(abortPayload.code, "search_cancelled");
		assert.doesNotMatch(JSON.stringify(abortPayload), /raw abort secret/);

		const thrownFailure = registerSearch(cwd, async () => {
			throw new Error("top-level provider secret");
		});
		const failurePayload = body(await thrownFailure.tool.execute("failure", { query: "failure" }));
		assert.equal(failurePayload.status, "failed");
		assert.equal(failurePayload.code, "search_failed");
		assert.doesNotMatch(JSON.stringify(failurePayload), /top-level provider secret/);

		const aborted = new AbortController();
		aborted.abort();
		const ignoredAbort = registerSearch(cwd, async () => ({
			content: [{ type: "text", text: "https://ignored.example" }],
			details: { successfulQueries: 1, totalResults: 1 },
		}));
		const ignoredPayload = body(await ignoredAbort.tool.execute("ignored-abort", { query: "q" }, aborted.signal));
		assert.equal(ignoredPayload.status, "cancelled");
		assert.equal(ignoredPayload.code, "search_cancelled");
		assert.deepEqual(ignoredPayload.candidates, []);
		assert.equal(ignoredPayload.candidateCountTotal, 0);
		assert.equal(ignoredPayload.candidateCountReturned, 0);
		assert.equal(ignoredPayload.budget.used, 0);
		assert.equal(ignoredPayload.budget.truncated, false);
		assert.match(ignoredPayload.next, /do not fetch/);
	} finally {
		removeProject(cwd);
	}
});

test("WB-002 search counts distinguish candidate, upstream, and aggregate truncation and bound attribution", async () => {
	const cwd = makeProject();
	try {
		const twelveUrls = Array.from({ length: 12 }, (_, index) => `https://source-${index}.example/item`).join(" ");
		const candidateFixture = registerSearch(cwd, async () => ({
			content: [{ type: "text", text: twelveUrls }],
			details: { queryCount: 1, successfulQueries: 1, totalResults: 10 },
		}));
		const candidatePayload = body(await candidateFixture.tool.execute("candidate-truncation", { query: "q" }));
		assert.equal(candidatePayload.candidateCountTotal, 12);
		assert.equal(candidatePayload.candidateCountReturned, 10);
		assert.equal(candidatePayload.candidateTruncated, true);
		assert.equal(candidatePayload.upstreamTruncated, false);
		assert.equal(candidatePayload.truncated, true);

		const providers = Array.from({ length: 12 }, (_, index) => ({ provider: `Provider-${index}` }));
		providers.push({ provider: "token=must-not-leak" });
		const reportedFixture = registerSearch(cwd, async () => ({
			content: [{
				type: "text",
				text: Array.from({ length: 5 }, (_, index) => `https://reported-${index}.example/item`).join(" "),
			}],
			details: {
				queryCount: 1,
				successfulQueries: 1,
				totalResults: 25,
				searchId: "safe-search-id",
				provider: "all",
				actualProviders: providers.map((entry) => entry.provider),
			},
		}));
		const reportedPayload = body(await reportedFixture.tool.execute("reported-truncation", { query: "q" }));
		assert.equal(reportedPayload.candidateCountTotal, 5);
		assert.equal(reportedPayload.candidateCountReturned, 5);
		assert.equal(reportedPayload.sourceCountReported, 25);
		assert.equal(reportedPayload.candidateTruncated, false);
		assert.equal(reportedPayload.upstreamTruncated, true);
		assert.equal(reportedPayload.truncated, true);
		assert.equal(reportedPayload.provenance.adapter, "extension-formatted-text");
		assert.equal(reportedPayload.provenance.attributionAvailable, true);
		assert.equal(reportedPayload.provenance.searchId, "safe-search-id");
		assert.equal(reportedPayload.provenance.providerCountTotal, 12);
		assert.equal(reportedPayload.provenance.providerCountReturned, 10);
		assert.equal(reportedPayload.provenance.providers.length, 10);
		assert.deepEqual(reportedPayload.provenance.selectedProviders, ["all"]);
		assert.equal(reportedPayload.provenance.truncated, true);
		assert.doesNotMatch(JSON.stringify(reportedPayload), /token=must-not-leak/);
	} finally {
		removeProject(cwd);
	}
});

test("WB-002 actual ordinary v0.24.2 append shape retains available provider attribution", async () => {
	const cwd = makeProject();
	try {
		const fixture = registerOrdinaryPiWebSearch(
			cwd,
			async (providerPi, _toolCallId, params) => {
				assert.equal(params.workflow, "none");
				providerPi.appendEntry(
					"web-search-results",
					ordinarySearchRecord("ordinary-search-id", [
						{
							query: params.query,
							answer: "",
							results: [{ url: "https://ordinary.example/result" }],
							error: null,
							provider: "brave",
						},
					]),
				);
				return ordinarySearchResult("https://ordinary.example/result");
			},
		);
		const payload = body(
			await fixture.tool.execute("ordinary", { query: "ordinary shape" }),
		);
		assert.equal(payload.status, "ok");
		assert.equal(payload.candidateCountTotal, 1);
		assert.equal(payload.candidateCountReturned, 1);
		assert.equal(payload.candidateTruncated, false);
		assert.equal(payload.upstreamTruncated, false);
		assert.equal(payload.truncated, false);
		assert.deepEqual(payload.provenance, {
			adapter: "pi-web-access-formatted-text",
			attributionAvailable: true,
			providers: ["brave"],
			providerCountTotal: 1,
			providerCountReturned: 1,
			truncated: false,
		});
		assert.deepEqual(fixture.forwardedEntries, []);
	} finally {
		removeProject(cwd);
	}
});

test("WB-002 ordinary provider attribution remains invocation-scoped across concurrent searches", async () => {
	const cwd = makeProject();
	try {
		const gates = new Map();
		const started = new Map();
		for (const query of ["alpha", "beta"]) {
			let release;
			let markStarted;
			gates.set(query, new Promise((resolve) => { release = resolve; }));
			started.set(query, {
				promise: new Promise((resolve) => { markStarted = resolve; }),
				release,
				markStarted,
			});
		}
		const fixture = registerOrdinaryPiWebSearch(
			cwd,
			async (providerPi, _toolCallId, params) => {
				const provider = params.query === "alpha" ? "brave" : "exa";
				started.get(params.query).markStarted();
				await gates.get(params.query);
				providerPi.appendEntry(
					"web-search-results",
					ordinarySearchRecord(`search-${params.query}`, [
						{ query: params.query, results: [], error: null, provider },
					]),
				);
				return ordinarySearchResult(`https://${params.query}.example/result`);
			},
		);
		const alphaResult = fixture.tool.execute("call-alpha", { query: "alpha" });
		const betaResult = fixture.tool.execute("call-beta", { query: "beta" });
		await Promise.all([
			started.get("alpha").promise,
			started.get("beta").promise,
		]);
		started.get("beta").release();
		const betaPayload = body(await betaResult);
		started.get("alpha").release();
		const alphaPayload = body(await alphaResult);
		assert.deepEqual(alphaPayload.provenance.providers, ["brave"]);
		assert.deepEqual(betaPayload.provenance.providers, ["exa"]);
		assert.equal(alphaPayload.provenance.providerCountTotal, 1);
		assert.equal(betaPayload.provenance.providerCountTotal, 1);
		assert.deepEqual(fixture.forwardedEntries, []);
	} finally {
		removeProject(cwd);
	}
});

test("WB-002 ordinary attribution reports and bounds more than ten validated providers", async () => {
	const cwd = makeProject();
	try {
		const providers = [
			"openai",
			"brave",
			"parallel",
			"parallel-mcp",
			"tinyfish",
			"search1api",
			"searchinfinity",
			"querit",
			"tavily",
			"firecrawl",
			"jina",
			"searxng",
		];
		const fixture = registerOrdinaryPiWebSearch(
			cwd,
			async (providerPi) => {
				providerPi.appendEntry(
					"web-search-results",
					ordinarySearchRecord(
						"many-providers",
						providers.map((provider, index) => ({
							query: `q-${index}`,
							results: [],
							error: null,
							provider,
						})),
					),
				);
				return ordinarySearchResult("https://many.example/result", {
					queryCount: 12,
					successfulQueries: 12,
					totalResults: 1,
				});
			},
		);
		const payload = body(await fixture.tool.execute("many", { queries: ["many"] }));
		assert.equal(payload.status, "ok");
		assert.equal(payload.candidateTruncated, false);
		assert.equal(payload.upstreamTruncated, false);
		assert.equal(payload.truncated, false);
		assert.equal(payload.provenance.providerCountTotal, 12);
		assert.equal(payload.provenance.providerCountReturned, 10);
		assert.deepEqual(payload.provenance.providers, providers.slice(0, 10));
		assert.equal(payload.provenance.truncated, true);
	} finally {
		removeProject(cwd);
	}
});

test("WB-002 ordinary attribution discards secret-bearing metadata and invalid provider identifiers", async () => {
	const cwd = makeProject();
	try {
		const fixture = registerOrdinaryPiWebSearch(
			cwd,
			async (providerPi) => {
				providerPi.appendEntry(
					"web-search-results",
					ordinarySearchRecord("secret-metadata", [
						{
							query: "safe",
							results: [{
								url: "https://safe.example/result",
								metadata: {
									provider: "NestedSecretProvider",
									authorization: "Bearer must-not-retain",
								},
							}],
							error: null,
							provider: "brave",
							secretMetadata: {
								token: "must-not-retain",
								apiKey: "must-not-retain",
							},
						},
						{
							query: "invalid",
							results: [],
							error: null,
							provider: "BearerSecretMustNotRetain",
						},
					]),
				);
				return ordinarySearchResult("https://safe.example/result");
			},
		);
		const payload = body(await fixture.tool.execute("secret", { query: "safe" }));
		assert.deepEqual(payload.provenance.providers, ["brave"]);
		assert.equal(payload.provenance.providerCountTotal, 1);
		assert.doesNotMatch(
			JSON.stringify(payload),
			/must-not-retain|BearerSecretMustNotRetain|NestedSecretProvider|secretMetadata|authorization|apiKey/,
		);
		assert.deepEqual(fixture.forwardedEntries, []);
		const persisted = allFiles(fixture.cacheDir)
			.map((file) => readFileSync(file, "utf8"))
			.join("\n");
		assert.doesNotMatch(
			persisted,
			/must-not-retain|BearerSecretMustNotRetain|NestedSecretProvider|secretMetadata|authorization|apiKey/,
		);
	} finally {
		removeProject(cwd);
	}
});

test("WB-002 selector-only metadata is not actual provider attribution", async () => {
	const cwd = makeProject();
	try {
		const fixture = registerSearch(cwd, async () => ({
			content: [{ type: "text", text: "https://selector.example/result" }],
			details: {
				provider: "auto",
				providers: ["all"],
				queryCount: 1,
				successfulQueries: 1,
				totalResults: 1,
			},
		}));
		const payload = body(await fixture.tool.execute("selector", { query: "q" }));
		assert.deepEqual(payload.provenance.providers, []);
		assert.equal(payload.provenance.attributionAvailable, false);
		assert.deepEqual(payload.provenance.selectedProviders, ["auto", "all"]);
	} finally {
		removeProject(cwd);
	}
});

test("WB-002 aggregate search budget reports clipping, not candidate omission", async () => {
	const cwd = makeProject();
	try {
		const urls = Array.from(
			{ length: 10 },
			(_, index) => `https://aggregate-${index}.example/${"x".repeat(20)}`,
		).join(" ");
		const fixture = registerSearch(
			cwd,
			async () => ({
				content: [{ type: "text", text: urls }],
				details: { queryCount: 1, successfulQueries: 1, totalResults: 10 },
			}),
			{ webSourcePolicy: { searchSnippetChars: 1000, perTaskVisibleCharBudget: 100 } },
		);
		const payload = body(await fixture.tool.execute("aggregate", { query: "q" }));
		assert.equal(payload.candidates.length, 10);
		assert.equal(payload.budget.truncated, true);
		assert.equal(payload.candidates[0].budget.truncated, true);
		assert.equal(payload.budget.used, 100);
	} finally {
		removeProject(cwd);
	}
});

test("WB-002 fetch batch budget reports only visible clipping", async () => {
	const cwd = makeProject();
	try {
		const register = (name, execute, perTaskVisibleCharBudget) => {
			const registered = new Map();
			registerWorkflowWebSourceExtension(
				{ registerTool(tool) { registered.set(tool.name, tool); } },
				{
					schema: "workflow-web-source-launch-config-v1",
					runId: `workflow_wb002_batch_${name}`,
					taskId: "task-1",
					cwd,
					cacheDir: join(cwd, `batch-${name}`),
					provider: { kind: "extension", extensionPaths: ["/validated/provider.mjs"], trustedCustomProvider: true },
					securityPolicy: { allowPrivateHosts: true },
					webSourcePolicy: { previewChars: 100, perTaskVisibleCharBudget },
					exposedWorkflowTools: ["workflow_web_fetch_source"],
				},
				(pi) => pi.registerTool({ name: "fetch_content", execute }),
			);
			return registered.get("workflow_web_fetch_source");
		};
		const clipped = register("clipped", async () => ({
			content: [{ type: "text", text: "visible ".repeat(40) }],
		}), 50);
		const clippedPayload = body(await clipped.execute("clipped", {
			urls: ["https://batch.example/a", "https://batch.example/b"],
		}));
		assert.equal(clippedPayload.status, "ok");
		assert.equal(clippedPayload.budget.truncated, true);
		assert.equal(clippedPayload.cards.some((card) => card.budget.truncated), true);

		let calls = 0;
		const partial = register("partial", async () => {
			calls += 1;
			return calls === 1
				? { content: [{ type: "text", text: "short" }] }
				: { content: [] };
		}, 100);
		const partialPayload = body(await partial.execute("partial", {
			urls: ["https://batch.example/ok", "https://batch.example/empty"],
		}));
		assert.equal(partialPayload.status, "partial");
		assert.equal(partialPayload.budget.truncated, false);
	} finally {
		removeProject(cwd);
	}
});

test("WB-002 source reads reject over-limit terms and requests atomically", async () => {
	const cwd = makeProject();
	try {
		const runId = "workflow_wb002_limits";
		const taskId = "task-1";
		const cacheDir = join(cwd, "limits-cache");
		const sourceConfig = { runId, taskId, cacheDir };
		const words = Array.from({ length: 20 }, (_, index) => `needle-${index}`);
		const source = createWorkflowWebSource({
			config: sourceConfig,
			url: "https://limits.example/source",
			text: words.join(" "),
		});
		await writeWorkflowWebSource(sourceConfig, source);
		const registered = new Map();
		registerWorkflowWebSourceExtension(
			{ registerTool(tool) { registered.set(tool.name, tool); } },
			{
				schema: "workflow-web-source-launch-config-v1",
				runId,
				taskId,
				cwd,
				cacheDir,
				provider: { kind: "none" },
				securityPolicy: { allowPrivateHosts: true },
				webSourcePolicy: { perTaskVisibleCharBudget: 1000 },
			},
		);
		const tool = registered.get("workflow_web_source_read");
		const tooManyTerms = body(await tool.execute("terms", {
			sourceRef: source.sourceRef,
			terms: Array.from({ length: 17 }, (_, index) => `needle-${index}`),
		}));
		assert.equal(tooManyTerms.status, "blocked");
		assert.equal(tooManyTerms.code, "invalid_params");
		assert.equal(tooManyTerms.reason, "source_read_term_limit_exceeded");
		assert.equal(tooManyTerms.maximum, 16);
		assert.equal(tooManyTerms.requested, 17);
		const tooManyReads = body(await tool.execute("reads", {
			sourceRef: source.sourceRef,
			reads: Array.from({ length: 21 }, (_, index) => ({ query: `needle-${index % 20}` })),
		}));
		assert.equal(tooManyReads.code, "invalid_params");
		assert.equal(tooManyReads.reason, "source_read_batch_limit_exceeded");
		assert.equal(tooManyReads.requested, 21);
		assert.equal(existsSync(join(cacheDir, "visible-budget-ledger")), false);
		const boundary = body(await tool.execute("boundary", {
			sourceRef: source.sourceRef,
			reads: words.map((query) => ({ query })),
		}));
		assert.equal(boundary.results.length, 20);
		assert.equal(boundary.budget.used > 0, true);
	} finally {
		removeProject(cwd);
	}
});

test("WB-002 redirect aliases and visible budget survive worker reload with task isolation", async () => {
	const cwd = makeProject();
	try {
		const cacheDir = join(cwd, "reload-cache");
		const config = (taskId) => ({
			schema: "workflow-web-source-launch-config-v1",
			runId: "workflow_wb002_reload",
			taskId,
			cwd,
			cacheDir,
			provider: { kind: "extension", extensionPaths: ["/validated/provider.mjs"], trustedCustomProvider: true },
			securityPolicy: { allowPrivateHosts: true },
			webSourcePolicy: { previewChars: 20, sourceReadMaxChars: 40, perTaskVisibleCharBudget: 40 },
			exposedWorkflowTools: ["workflow_web_fetch_source", "workflow_web_source_read"],
		});
		let providerCalls = 0;
		const register = (taskId) => {
			const registered = new Map();
			registerWorkflowWebSourceExtension(
				{ registerTool(tool) { registered.set(tool.name, tool); } },
				config(taskId),
				(pi) => pi.registerTool({
					name: "fetch_content",
					async execute() {
						providerCalls += 1;
						return {
							content: [{ type: "text", text: "durable source body " + "x".repeat(100) }],
							details: { finalUrl: "https://reload.example/effective" },
						};
					},
				}),
			);
			return registered;
		};
		const first = register("task-1");
		const firstCard = body(await first.get("workflow_web_fetch_source").execute("a", { url: "https://reload.example/requested" })).card;
		assert.equal(firstCard.url, "https://reload.example/requested");
		assert.equal(firstCard.effectiveUrl, "https://reload.example/effective");
		assert.deepEqual(firstCard.aliases, ["https://reload.example/effective"]);
		const firstRead = body(await first.get("workflow_web_source_read").execute("r", {
			sourceRef: firstCard.sourceRef,
			query: "durable source body",
		}));
		assert.equal(firstRead.budget.used > 0, true);
		const retry = register("task-1");
		const duplicate = body(await retry.get("workflow_web_fetch_source").execute("b", { url: "https://reload.example/effective" }));
		assert.equal(duplicate.card.duplicate, true);
		assert.equal(duplicate.card.sourceRef, firstCard.sourceRef);
		assert.equal(providerCalls, 1);
		const isolated = register("task-2");
		const isolatedRead = body(await isolated.get("workflow_web_source_read").execute("r2", {
			sourceRef: firstCard.sourceRef,
			query: "durable source body",
		}));
		assert.equal(isolatedRead.status, "ok");
		// The configured limit change is fail-closed against the same ledger.
		const mismatchConfig = { ...config("task-1"), webSourcePolicy: { perTaskVisibleCharBudget: 41 } };
		const mismatchTools = new Map();
		registerWorkflowWebSourceExtension({ registerTool(tool) { mismatchTools.set(tool.name, tool); } }, mismatchConfig);
		const mismatchRead = body(await mismatchTools.get("workflow_web_source_read").execute("m", { sourceRef: firstCard.sourceRef, query: "durable" }));
		assert.equal(mismatchRead.code, "visible_budget_limit_mismatch");
	} finally {
		removeProject(cwd);
	}
});

test("WB-002 sensitive normalized fetch URLs fail before single/batch default/custom dispatch or cache state", async () => {
	const cwd = makeProject();
	const previousConfigDir = process.env.PI_CODING_AGENT_DIR;
	const originalFetch = globalThis.fetch;
	try {
		process.env.PI_CODING_AGENT_DIR = join(cwd, "pi-config");
		mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
		let networkCalls = 0;
		globalThis.fetch = async () => {
			networkCalls += 1;
			throw new Error("network must not be called");
		};
		const sensitiveUrls = [
			"https://user:pass@example.test/private",
			"https://example.test/private?token=secret",
			"https://example.test/private?X-Amz-Credential=secret",
			"https://example.test/private?X-Amz-Signature=secret",
			"https://example.test/private?session_id=secret",
			"https://example.test/private?apiKey=secret",
			"https://example.test/private?apikey=secret",
			"https://example.test/private?apisecret=secret",
			"https://example.test/private?accesskey=secret",
			"https://example.test/private?secretkey=secret",
			"https://example.test/private?sessiontoken=secret",
			"https://example.test/private?APIToken=secret",
			"https://example.test/private?JWTToken=secret",
			"https://example.test/private?authToken=secret",
			"https://example.test/private?accessToken=secret",
			"https://example.test/private?clientSecret=secret",
			"https://example.test/private?authorization=secret",
			"https://example.test/private?sessionId=secret",
			"https://example.test/private?%58-%41mz-%43redential=secret",
		];

		for (const providerKind of ["pi-web-access", "extension"]) {
			const cacheDir = join(cwd, `${providerKind}-cache`);
			const registered = new Map();
			let providerCalls = 0;
			registerWorkflowWebSourceExtension(
				{
					registerTool(tool) {
						registered.set(tool.name, tool);
					},
				},
				{
					schema: "workflow-web-source-launch-config-v1",
					runId: `security-${providerKind}`,
					taskId: "task-1",
					cwd,
					cacheDir,
					provider: { kind: providerKind },
					securityPolicy: {
						allowPrivateHosts: providerKind === "extension",
						cacheRawProviderPayloads: false,
					},
					exposedWorkflowTools: ["workflow_web_fetch_source"],
				},
				(pi) => pi.registerTool({
					name: "fetch_content",
					async execute() {
						providerCalls += 1;
						return { content: [{ type: "text", text: "must not run" }] };
					},
				}),
			);
			const tool = registered.get("workflow_web_fetch_source");
			for (const [index, url] of sensitiveUrls.entries()) {
				const payload = body(await tool.execute(`single-${index}`, { url }));
				assert.equal(payload.code, "blocked_url");
				assert.match(payload.reason, /^sensitive_url_/);
				assert.doesNotMatch(JSON.stringify(payload), /secret|user:pass/);
			}
			const batchPayload = body(await tool.execute("batch", {
				sources: [
					{ url: "https://safe.example.test/public" },
					{ url: "https://signed.example.test/private?X-Amz-Signature=secret" },
				],
			}));
			assert.equal(batchPayload.code, "blocked_url");
			assert.equal(batchPayload.reason, "sensitive_url_query");
			assert.doesNotMatch(JSON.stringify(batchPayload), /secret/);
			assert.equal(providerCalls, 0, providerKind);
			assert.equal(existsSync(cacheDir), false, providerKind);
		}
		assert.equal(networkCalls, 0);
	} finally {
		globalThis.fetch = originalFetch;
		if (previousConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousConfigDir;
		removeProject(cwd);
	}
});

test("REV-003 rejects sensitive or excessive combined fetch batches before all side effects", async () => {
	const cwd = makeProject();
	const cacheDir = join(cwd, "atomic-batch-cache");
	const originalFetch = globalThis.fetch;
	try {
		let networkCalls = 0;
		let providerCalls = 0;
		globalThis.fetch = async () => {
			networkCalls += 1;
			throw new Error("network must not be called");
		};
		const registered = new Map();
		registerWorkflowWebSourceExtension(
			{
				registerTool(tool) {
					registered.set(tool.name, tool);
				},
			},
			{
				schema: "workflow-web-source-launch-config-v1",
				runId: "rev-003-atomic-batch",
				taskId: "task-1",
				cwd,
				cacheDir,
				provider: { kind: "extension" },
				securityPolicy: {
					allowPrivateHosts: true,
					cacheRawProviderPayloads: false,
				},
				exposedWorkflowTools: ["workflow_web_fetch_source"],
			},
			(pi) => pi.registerTool({
				name: "fetch_content",
				async execute() {
					providerCalls += 1;
					return { content: [{ type: "text", text: "must not run" }] };
				},
			}),
		);
		const tool = registered.get("workflow_web_fetch_source");
		const safeUrls = Array.from(
			{ length: 21 },
			(_, index) => `https://safe-${index}.example.test/article`,
		);
		const signedUrl =
			"https://signed.example.test/private?X-Amz-Signature=must-not-retain";

		const sensitiveTail = body(await tool.execute("sensitive-tail", {
			urls: [...safeUrls.slice(0, 20), signedUrl],
		}));
		assert.equal(sensitiveTail.code, "blocked_url");
		assert.equal(sensitiveTail.reason, "sensitive_url_query");
		assert.doesNotMatch(JSON.stringify(sensitiveTail), /must-not-retain/);

		const sensitiveScalar = body(await tool.execute("sensitive-scalar", {
			sources: safeUrls.slice(0, 20).map((url) => ({ url })),
			url: signedUrl,
		}));
		assert.equal(sensitiveScalar.code, "blocked_url");
		assert.equal(sensitiveScalar.reason, "sensitive_url_query");
		assert.doesNotMatch(JSON.stringify(sensitiveScalar), /must-not-retain/);

		const excessiveCombined = body(await tool.execute("excessive-combined", {
			sources: safeUrls.slice(0, 10).map((url) => ({ url })),
			urls: safeUrls.slice(10, 20),
			url: safeUrls[20],
		}));
		assert.equal(excessiveCombined.code, "invalid_params");
		assert.equal(
			excessiveCombined.reason,
			"fetch_source_batch_limit_exceeded",
		);
		assert.equal(excessiveCombined.maximum, 20);
		assert.equal(excessiveCombined.requested, 21);

		const duplicateUrl = "https://duplicate.example.test/article";
		const excessiveDuplicates = body(await tool.execute("excessive-duplicates", {
			urls: Array.from({ length: 20 }, () => duplicateUrl),
			url: duplicateUrl,
		}));
		assert.equal(excessiveDuplicates.code, "invalid_params");
		assert.equal(
			excessiveDuplicates.reason,
			"fetch_source_batch_limit_exceeded",
		);
		assert.equal(excessiveDuplicates.requested, 21);

		assert.equal(providerCalls, 0);
		assert.equal(networkCalls, 0);
		assert.equal(existsSync(cacheDir), false);
	} finally {
		globalThis.fetch = originalFetch;
		removeProject(cwd);
	}
});

test("REV-003 accepts exactly 20 combined fetch entries and deduplicates only after cardinality validation", async () => {
	const cwd = makeProject();
	try {
		const cacheDir = join(cwd, "max-batch-cache");
		const registered = new Map();
		let providerCalls = 0;
		registerWorkflowWebSourceExtension(
			{
				registerTool(tool) {
					registered.set(tool.name, tool);
				},
			},
			{
				schema: "workflow-web-source-launch-config-v1",
				runId: "rev-003-valid-max-batch",
				taskId: "task-1",
				cwd,
				cacheDir,
				provider: { kind: "extension", extensionPaths: ["/validated/provider.mjs"], trustedCustomProvider: true },
				securityPolicy: {
					allowPrivateHosts: true,
					cacheRawProviderPayloads: false,
				},
				exposedWorkflowTools: ["workflow_web_fetch_source"],
			},
			(pi) => pi.registerTool({
				name: "fetch_content",
				async execute(_toolCallId, params) {
					providerCalls += 1;
					return {
						content: [{ type: "text", text: `Content for ${params.url}` }],
					};
				},
			}),
		);
		const tool = registered.get("workflow_web_fetch_source");
		const safeUrls = Array.from(
			{ length: 20 },
			(_, index) => `https://valid-${index}.example.test/article`,
		);
		const maxPayload = body(await tool.execute("valid-max", {
			sources: safeUrls.slice(0, 10).map((url) => ({ url })),
			urls: safeUrls.slice(10, 19),
			url: safeUrls[19],
		}));
		assert.equal(maxPayload.status, "ok");
		assert.equal(maxPayload.results.length, 20);
		assert.equal(maxPayload.cards.length, 20);
		assert.equal(providerCalls, 20);

		const duplicatePayload = body(await tool.execute("valid-duplicates", {
			urls: Array.from(
				{ length: 20 },
				() => "https://dedupe.example.test/article",
			),
		}));
		assert.equal(duplicatePayload.status, "ok");
		assert.equal(duplicatePayload.results.length, 1);
		assert.equal(duplicatePayload.cards.length, 1);
		assert.equal(providerCalls, 21);
		assert.ok(allFiles(cacheDir).length > 0);
	} finally {
		removeProject(cwd);
	}
});

test("WB-002 direct-safe-fetch provenance persists on source cards and private pi-web config cannot relax policy", async () => {
	const cwd = makeProject();
	const previousConfigDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = join(cwd, "pi-config");
		mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
		writeFileSync(
			join(process.env.PI_CODING_AGENT_DIR, "web-search.json"),
			JSON.stringify({
				authProfiles: { secretProfile: { token: "must-not-appear" } },
				routing: { fetch: "hosted" },
				proxy: { trust: true },
				ssrf: { allowRanges: ["127.0.0.0/8", "10.0.0.0/8"] },
			}),
		);
		const strictSecurity = { allowPrivateHosts: false, cacheRawProviderPayloads: false };
		const blocked = await safeFetchWorkflowWebText("http://127.0.0.1/private", strictSecurity);
		assert.deepEqual(blocked, { ok: false, reason: "private_host_blocked", url: "http://127.0.0.1/private" });

		const registered = new Map();
		let capturedProviderCalls = 0;
		registerWorkflowWebSourceExtension(
			{
				registerTool(tool) {
					registered.set(tool.name, tool);
				},
			},
			{
				schema: "workflow-web-source-launch-config-v1",
				runId: "workflow_wb002_strict",
				taskId: "task-1",
				cwd,
				cacheDir: join(cwd, "strict-cache"),
				provider: { kind: "pi-web-access" },
				securityPolicy: strictSecurity,
				exposedWorkflowTools: ["workflow_web_fetch_source"],
			},
			(pi) => pi.registerTool({
				name: "fetch_content",
				async execute() {
					capturedProviderCalls += 1;
					return { content: [{ type: "text", text: "must not run" }] };
				},
			}),
		);
		const blockedPayload = body(
			await registered.get("workflow_web_fetch_source").execute(
				"blocked-private",
				{ url: "http://127.0.0.1/private" },
			),
		);
		assert.equal(blockedPayload.code, "blocked_url");
		assert.equal(blockedPayload.reason, "private_host_blocked");
		assert.equal(capturedProviderCalls, 0);

		assert.throws(
			() => registerWorkflowWebSourceExtension(
				{ registerTool() {} },
				{
					schema: "workflow-web-source-launch-config-v1",
					runId: "workflow_wb002",
					taskId: "task-1",
					cwd,
					cacheDir: join(cwd, "reject-cache"),
					provider: { kind: "pi-web-access" },
					securityPolicy: { allowPrivateHosts: true },
				},
			),
			/public-host enforcement/,
		);

		const config = { runId: "workflow_wb002", taskId: "task-1", cacheDir: join(cwd, "source-cache") };
		const source = createWorkflowWebSource({
			config,
			url: "https://public.example/source",
			text: "Public source text",
			provider: WORKFLOW_WEB_DIRECT_FETCHER,
			provenance: {
				fetcher: WORKFLOW_WEB_DIRECT_FETCHER,
				policy: WORKFLOW_WEB_DIRECT_FETCH_POLICY,
			},
		});
		await writeWorkflowWebSource(config, source);
		const reloaded = await readWorkflowWebSource(config, source.sourceRef);
		assert.ok(reloaded);
		const card = buildWorkflowWebSourceCard({
			source: reloaded,
			policy: {
				previewChars: 80,
				duplicatePreviewChars: 20,
				sourceReadMaxChars: 80,
				searchSnippetChars: 40,
				perTaskVisibleCharBudget: 100,
			},
			budget: createWorkflowWebVisibleBudget(100),
		});
		assert.deepEqual(card.provenance, {
			fetcher: "pi-workflow-direct-safe-fetch",
			policy: "pi-workflow-strict-public-http-v1",
		});
		assert.doesNotMatch(JSON.stringify(card), /must-not-appear|secretProfile|hosted|allowRanges/);
	} finally {
		if (previousConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousConfigDir;
		removeProject(cwd);
	}
});

test("WB-002 direct-safe refetch upgrades weaker provenance and retains only validated aliases", async () => {
	const cwd = makeProject();
	try {
		const config = { runId: "upgrade", taskId: "task", cacheDir: join(cwd, "upgrade-cache") };
		const weak = createWorkflowWebSource({
			config,
			url: "https://upgrade.example/requested",
			text: "weak body",
			provider: "legacy-provider",
			effectiveUrl: "https://upgrade.example/effective",
		});
		await writeWorkflowWebSource(config, weak);
		const direct = createWorkflowWebSource({
			config,
			url: "https://upgrade.example/requested",
			text: "canonical body",
			provider: WORKFLOW_WEB_DIRECT_FETCHER,
			provenance: {
				fetcher: WORKFLOW_WEB_DIRECT_FETCHER,
				policy: WORKFLOW_WEB_DIRECT_FETCH_POLICY,
			},
			effectiveUrl: "https://upgrade.example/effective",
			aliases: ["https://upgrade.example/also-effective?token=must-not-be-an-alias"],
		});
		const upgraded = await writeWorkflowWebSource(config, direct);
		assert.deepEqual(upgraded.provenance, direct.provenance);
		assert.deepEqual(upgraded.aliases, ["https://upgrade.example/effective"]);
		const index = await readWorkflowWebSourceIndex(config);
		assert.deepEqual(index.sources.map((entry) => entry.sourceRef), [direct.sourceRef]);
		const reloaded = await readWorkflowWebSource(config, direct.sourceRef);
		assert.deepEqual(reloaded.provenance, direct.provenance);
		assert.equal((await findWorkflowWebSourceByUrl(config, "https://upgrade.example/requested")).provenance.fetcher, WORKFLOW_WEB_DIRECT_FETCHER);
	} finally {
		removeProject(cwd);
	}
});

test("WB-002 event and source metadata redaction applies the shared policy recursively", async () => {
	const cwd = makeProject();
	try {
		const config = { runId: "recursive-redaction", taskId: "task", cacheDir: join(cwd, "recursive-cache") };
		const source = createWorkflowWebSource({
			config,
			url: "https://recursive.example/source",
			text: "safe",
			metadata: {
				outer: "visible",
				apiKey: "metadata-secret",
				attempt: 2,
			},
		});
		assert.deepEqual(source.metadata, { outer: "visible", apiKey: "REDACTED", attempt: 2 });
		await recordWorkflowWebSourceEvent(config, "recursive", {
			outer: { nested: { token: "event-secret", value: "visible" } },
			items: [{ password: "array-secret", value: "visible" }],
		});
		const event = JSON.parse(readFileSync(join(config.cacheDir, "events.jsonl"), "utf8"));
		assert.deepEqual(event.outer, { nested: { token: "REDACTED", value: "visible" } });
		assert.deepEqual(event.items, [{ password: "REDACTED", value: "visible" }]);
	} finally {
		removeProject(cwd);
	}
});

test("WB-002 cache ledgers and source objects enforce private POSIX modes", async (t) => {
	if (process.platform === "win32") {
		t.skip("POSIX mode assertions are not portable to Windows");
		return;
	}
	const cwd = makeProject();
	try {
		const cacheDir = join(cwd, "permissions-cache");
		mkdirSync(cacheDir, { recursive: true, mode: 0o755 });
		const eventPath = join(cacheDir, "events.jsonl");
		writeFileSync(eventPath, "old\\n");
		chmodSync(cacheDir, 0o755);
		chmodSync(eventPath, 0o644);
		const config = { runId: "permissions", taskId: "task", cacheDir };
		const source = createWorkflowWebSource({
			config,
			url: "https://permissions.example/source",
			text: "private source text",
		});
		await writeWorkflowWebSource(config, source);
		await recordWorkflowWebSourceEvent(config, "permission_check", {
			url: source.url,
		});
		const mode = (path) => statSync(path).mode & 0o777;
		assert.equal(mode(cacheDir), 0o700);
		assert.equal(mode(join(cacheDir, "sources")), 0o700);
		assert.equal(mode(join(cacheDir, "sources", `${source.sourceRef}.json`)), 0o600);
		assert.equal(mode(join(cacheDir, "index.json")), 0o600);
		assert.equal(mode(join(cacheDir, "index-events.jsonl")), 0o600);
		assert.equal(mode(eventPath), 0o600);
	} finally {
		removeProject(cwd);
	}
});

test("WB-002 fetch lock roots and owners use private modes while held", async (t) => {
	if (process.platform === "win32") {
		t.skip("POSIX mode assertions are not portable to Windows");
		return;
	}
	const cwd = makeProject();
	try {
		const cacheDir = join(cwd, "lock-permissions-cache");
		const registered = new Map();
		let lockSnapshot;
		registerWorkflowWebSourceExtension(
			{ registerTool(tool) { registered.set(tool.name, tool); } },
			{
				schema: "workflow-web-source-launch-config-v1",
				runId: "lock-permissions",
				taskId: "task",
				cwd,
				cacheDir,
				provider: { kind: "extension", extensionPaths: ["/validated/provider.mjs"], trustedCustomProvider: true },
				securityPolicy: { allowPrivateHosts: true, cacheRawProviderPayloads: false },
				exposedWorkflowTools: ["workflow_web_fetch_source"],
			},
			(pi) => pi.registerTool({
				name: "fetch_content",
				async execute() {
					const lockRoot = join(cacheDir, "fetch-locks");
					const lockDir = join(lockRoot, readdirSync(lockRoot)[0]);
					lockSnapshot = {
						root: statSync(lockRoot).mode & 0o777,
						dir: statSync(lockDir).mode & 0o777,
						owner: statSync(join(lockDir, "owner.json")).mode & 0o777,
					};
					return { content: [{ type: "text", text: "locked content" }] };
				},
			}),
		);
		const result = await registered.get("workflow_web_fetch_source").execute(
			"lock",
			{ url: "http://127.0.0.1/locked" },
		);
		assert.equal(body(result).status, "ok");
		assert.deepEqual(lockSnapshot, { root: 0o700, dir: 0o700, owner: 0o600 });
	} finally {
		removeProject(cwd);
	}
});

test("WB-002 detailed web compatibility contracts live in usage, not README", () => {
	const root = resolve(import.meta.dirname, "../..");
	const readme = readFileSync(join(root, "README.md"), "utf8");
	const usage = readFileSync(join(root, "docs/usage.md"), "utf8");
	assert.match(usage, /canonical/i);
	assert.match(usage, /fail(?:s|ed)? fast|fail-fast|failure fast/i);
	assert.match(usage, /readable/);
	assert.match(usage, /raw/);
	assert.match(usage, /answer/);
	assert.match(usage, /auth/);
	assert.match(usage, /responseId/);
	assert.match(usage, /get_search_content/);
	assert.match(usage, /offset/);
	assert.match(usage, /limit/);
	assert.match(usage, /nextOffset/);
	assert.match(usage, /truncated/);
	assert.match(usage, /findText/);
	assert.match(usage, /findMode/);
	assert.match(usage, /pi-workflow-direct-safe-fetch/);
	assert.match(usage, /pi-workflow-strict-public-http-v1/);
	assert.match(usage, /allowRanges/);
	assert.match(usage, /proxy/);
	assert.match(readme, /\[`docs\/usage\.md`\]\(\.\/docs\/usage\.md\)/);
	assert.doesNotMatch(readme, /providerKind: "extension"|nextOffset|pi-workflow-direct-safe-fetch/);
});
