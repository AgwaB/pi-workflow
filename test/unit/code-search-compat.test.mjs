import assert from "node:assert/strict";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const builtExtensionPath = join(
	root,
	".tmp/unit/code-search-compat-extension.js",
);
let importSequence = 0;

function writeCodeSearchOwner(directory, name, markerPath) {
	const extensionPath = join(directory, name);
	writeFileSync(
		extensionPath,
		`import { appendFileSync } from "node:fs";

export default function customCodeSearchOwner(pi) {
	appendFileSync(${JSON.stringify(markerPath)}, "initialized\\n");
	pi.registerTool({
		name: "code_search",
		label: "Custom Code Search",
		description: "A test-owned code search provider.",
		parameters: {
			type: "object",
			properties: { query: { type: "string" } },
			required: ["query"]
		},
		async execute() {
			return { content: [{ type: "text", text: "custom code search" }] };
		}
	});
}
`,
	);
	return extensionPath;
}

async function loadTool() {
	const moduleUrl = pathToFileURL(builtExtensionPath);
	moduleUrl.searchParams.set("test", String(importSequence++));
	const extension = await import(moduleUrl.href);
	const registered = [];
	extension.default({
		registerTool(tool) {
			registered.push(tool);
		},
	});
	assert.deepEqual(Object.keys(extension), ["default"]);
	assert.equal(registered.length, 1);
	return registered[0];
}

function mcpResponse(text, options = {}) {
	return new Response(
		JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			result: {
				content: [{ type: "text", text }],
				...(options.isError ? { isError: true } : {}),
			},
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

function execute(tool, params, signal) {
	return tool.execute("call-1", params, signal);
}

test("registers only the legacy code_search public contract", async () => {
	const tool = await loadTool();
	assert.deepEqual(Object.keys(tool).sort(), [
		"description",
		"execute",
		"label",
		"name",
		"parameters",
		"promptSnippet",
	]);
	assert.equal(tool.name, "code_search");
	assert.equal(tool.label, "Code Search");
	assert.equal(
		tool.description,
		"Search for code examples, documentation, and API references. Returns relevant code snippets and docs from GitHub, Stack Overflow, and official documentation. Use for any programming question — API usage, library examples, debugging help.",
	);
	assert.equal(
		tool.promptSnippet,
		"Use for programming/API/library questions to retrieve concrete examples and docs before implementing or debugging code.",
	);

	const schema = tool.parameters;
	assert.equal(schema.type, "object");
	assert.equal(Object.hasOwn(schema, "additionalProperties"), false);
	assert.deepEqual(schema.required, ["query"]);
	assert.deepEqual(Object.keys(schema.properties), ["query", "maxTokens"]);
	assert.deepEqual(schema.properties.query, {
		type: "string",
		description:
			"Programming question, API, library, or debugging topic to search for",
	});
	assert.deepEqual(schema.properties.maxTokens, {
		type: "integer",
		minimum: 1000,
		maximum: 50000,
		description:
			"Maximum tokens of code/documentation context to return (default: 5000)",
	});
	assert.equal(Object.hasOwn(schema.properties.maxTokens, "default"), false);
});

test("blank queries retain the old resolved error and default details", async () => {
	const previousFetch = globalThis.fetch;
	let fetches = 0;
	globalThis.fetch = async () => {
		fetches += 1;
		throw new Error("unexpected fetch");
	};
	try {
		const tool = await loadTool();
		assert.deepEqual(await execute(tool, { query: " \n\t " }), {
			content: [{ type: "text", text: "Error: No query provided." }],
			details: {
				query: "",
				maxTokens: 5000,
				error: "No query provided",
			},
		});
		assert.equal(fetches, 0);
	} finally {
		globalThis.fetch = previousFetch;
	}
});

test("primary code-context requests use the fixed Exa JSON-RPC transport", async () => {
	const previousFetch = globalThis.fetch;
	const requests = [];
	globalThis.fetch = async (url, options) => {
		requests.push({ url, options });
		return mcpResponse("code context");
	};
	try {
		const tool = await loadTool();
		const caller = new AbortController();
		assert.deepEqual(
			await execute(
				tool,
				{ query: "  Node.js AbortSignal.any example  ", maxTokens: 1000 },
				caller.signal,
			),
			{
				content: [{ type: "text", text: "code context" }],
				details: {
					query: "Node.js AbortSignal.any example",
					maxTokens: 1000,
					mode: "code-context",
				},
			},
		);
		assert.equal(requests.length, 1);
		const [{ url, options }] = requests;
		assert.equal(
			url,
			"https://mcp.exa.ai/mcp?tools=get_code_context_exa",
		);
		assert.equal(options.method, "POST");
		assert.deepEqual(options.headers, {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"x-exa-source": "pi-web-access",
		});
		assert.deepEqual(JSON.parse(options.body), {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "get_code_context_exa",
				arguments: {
					query: "Node.js AbortSignal.any example",
					tokensNum: 1000,
				},
			},
		});
		assert(options.signal instanceof AbortSignal);
		assert.notEqual(options.signal, caller.signal);
	} finally {
		globalThis.fetch = previousFetch;
	}
});

test("missing code-context tool permanently switches that module to the legacy fallback", async () => {
	const previousFetch = globalThis.fetch;
	const requests = [];
	globalThis.fetch = async (url, options) => {
		requests.push({ url, body: JSON.parse(options.body) });
		if (requests.length === 1) {
			const payload = JSON.stringify({
				result: {
					isError: true,
					content: [
						{ type: "text", text: "Requested TOOL was NOT FOUND" },
					],
				},
			});
			return new Response(`event: message\ndata: ${payload}\n\n`);
		}
		return mcpResponse("x".repeat(4500));
	};
	try {
		const tool = await loadTool();
		const first = await execute(tool, {
			query: "binary tree traversal",
			maxTokens: 1000,
		});
		assert.equal(first.details.mode, "web-search-fallback");
		assert.equal(first.details.query, "binary tree traversal");
		assert.equal(first.details.maxTokens, 1000);
		assert.equal(first.content[0].text.startsWith("x".repeat(4000)), true);
		assert.match(first.content[0].text, /\[Truncated by code_search/);

		const second = await execute(tool, {
			query: "another topic",
			maxTokens: 2000,
		});
		assert.equal(second.details.mode, "web-search-fallback");
		assert.deepEqual(
			requests.map((request) => request.url),
			[
				"https://mcp.exa.ai/mcp?tools=get_code_context_exa",
				"https://mcp.exa.ai/mcp?tools=web_search_exa",
				"https://mcp.exa.ai/mcp?tools=web_search_exa",
			],
		);
		assert.deepEqual(requests[1].body.params, {
			name: "web_search_exa",
			arguments: {
				query:
					"binary tree traversal code examples documentation GitHub Stack Overflow official docs",
				numResults: 5,
				livecrawl: "fallback",
				type: "auto",
				contextMaxCharacters: 4000,
			},
		});
	} finally {
		globalThis.fetch = previousFetch;
	}
});

test("HTTP, parse, RPC, and empty-content failures do not broaden fallback authority", async () => {
	const previousFetch = globalThis.fetch;
	const responses = [
		new Response("unauthorized", { status: 401 }),
		new Response("limited", { status: 429 }),
		new Response("provider failed", { status: 500 }),
		new Response("not JSON or SSE"),
		new Response(JSON.stringify({ error: { code: -32000, message: "bad RPC" } })),
		new Response(JSON.stringify({ result: { content: [] } })),
	];
	const urls = [];
	globalThis.fetch = async (url) => {
		urls.push(url);
		return responses.shift();
	};
	try {
		const tool = await loadTool();
		for (let index = 0; index < 6; index += 1) {
			const result = await execute(tool, { query: `failure ${index}` });
			assert.match(result.content[0].text, /^Error: /);
			assert.equal(typeof result.details.error, "string");
			assert.equal(Object.hasOwn(result.details, "mode"), false);
		}
		assert.equal(urls.length, 6);
		assert(
			urls.every(
				(url) =>
					url ===
					"https://mcp.exa.ai/mcp?tools=get_code_context_exa",
			),
		);
	} finally {
		globalThis.fetch = previousFetch;
	}
});

test("caller cancellation and transport timeout reject with the original value", async () => {
	const previousFetch = globalThis.fetch;
	try {
		const tool = await loadTool();
		let capturedSignal;
		let fetches = 0;
		globalThis.fetch = async (_url, options) => {
			fetches += 1;
			capturedSignal = options.signal;
			return new Promise((_resolve, reject) => {
				options.signal.addEventListener(
					"abort",
					() => reject(options.signal.reason),
					{ once: true },
				);
			});
		};
		const controller = new AbortController();
		const reason = new Error("tool not found");
		const cancelled = execute(tool, { query: "cancel me" }, controller.signal);
		await Promise.resolve();
		controller.abort(reason);
		await assert.rejects(cancelled, (error) => error === reason);
		assert.equal(capturedSignal.aborted, true);
		assert.equal(capturedSignal.reason, reason);
		assert.equal(fetches, 1, "cancellation must not trigger fallback");

		const timeout = new DOMException("operation timed out", "TimeoutError");
		globalThis.fetch = async () => {
			throw timeout;
		};
		await assert.rejects(
			execute(tool, { query: "timeout" }),
			(error) => error === timeout,
		);
	} finally {
		globalThis.fetch = previousFetch;
	}
});

test("built launch selection isolates code_search and preserves additive custom providers", async () => {
	const { prepareSubagentTaskLaunch } = await import(
		pathToFileURL(join(root, ".tmp/unit/subagent-backend.js")).href
	);
	const previousExtra = process.env.PI_WORKFLOW_SUBAGENT_EXTRA_EXTENSIONS;
	delete process.env.PI_WORKFLOW_SUBAGENT_EXTRA_EXTENSIONS;
	const launch = async (tools, toolProviders) =>
		prepareSubagentTaskLaunch(
			root,
			{ runId: "code-search-test" },
			{
				taskId: "main",
				files: { result: ".tmp/code-search-test-result.json" },
			},
			{ runtime: { tools, toolProviders } },
		);
	try {
		const isolated = await launch(["code_search"]);
		assert.equal(isolated.extensions.length, 1);
		assert.match(
			isolated.extensions[0],
			/[\\/]code-search-compat-extension\.js$/,
		);
		assert.doesNotMatch(
			isolated.extensions[0],
			/node_modules[\\/]pi-web-access[\\/]index\.ts$/,
		);

		const combined = await launch(["code_search", "web_search"], {
			code_search: { extensions: ["custom-code-provider.mjs"] },
		});
		assert.equal(
			combined.extensions.filter((entry) =>
				entry.endsWith("code-search-compat-extension.js"),
			).length,
			0,
		);
		assert.equal(
			combined.extensions.filter((entry) =>
				/[\\/]pi-web-access[\\/]index\.ts$/.test(entry),
			).length,
			0,
		);
		assert.equal(
			combined.extensions.filter((entry) =>
				entry.endsWith("workflow-fetch-cache-extension.ts"),
			).length,
			1,
		);
		assert(combined.extensions.includes("custom-code-provider.mjs"));
	} finally {
		if (previousExtra === undefined) {
			delete process.env.PI_WORKFLOW_SUBAGENT_EXTRA_EXTENSIONS;
		} else {
			process.env.PI_WORKFLOW_SUBAGENT_EXTRA_EXTENSIONS = previousExtra;
		}
	}
});

test("explicit custom code_search owner registers once and keeps web provider additive", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-code-search-owner-"));
	const markerPath = join(directory, "initializations.log");
	try {
		const customPath = writeCodeSearchOwner(
			directory,
			"custom-code-provider.mjs",
			markerPath,
		);
		const { prepareSubagentTaskLaunch } = await import(
			pathToFileURL(join(root, ".tmp/unit/subagent-backend.js")).href
		);
		const prepared = await prepareSubagentTaskLaunch(
			root,
			{ runId: "code-search-custom-owner" },
			{
				taskId: "custom-owner",
				files: {
					result: ".tmp/code-search-custom-owner-result.json",
				},
			},
			{
				runtime: {
					tools: ["code_search", "web_search"],
					toolProviders: {
						code_search: { extensions: [customPath] },
					},
				},
			},
		);
		assert.equal(
			prepared.extensions.filter((entry) => entry === customPath).length,
			1,
		);
		assert.equal(
			prepared.extensions.filter((entry) =>
				entry.endsWith("code-search-compat-extension.js"),
			).length,
			0,
		);
		assert.equal(
			prepared.extensions.filter((entry) =>
				entry.endsWith("workflow-fetch-cache-extension.ts"),
			).length,
			1,
		);

		const piSdk = await import("@earendil-works/pi-coding-agent");
		const loader = new piSdk.DefaultResourceLoader({
			cwd: root,
			agentDir: join(directory, "agent"),
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
		const registeredToolNames = loaded.extensions.flatMap((extension) => [
			...extension.tools.keys(),
		]);
		assert.equal(
			registeredToolNames.filter((name) => name === "code_search").length,
			1,
		);
		assert.equal(
			registeredToolNames.filter((name) => name === "web_search").length,
			1,
		);
		assert.deepEqual(readFileSync(markerPath, "utf8"), "initialized\n");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("multiple explicit code_search owners retain duplicate preflight failure semantics", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-code-search-duplicate-"));
	const markerPath = join(directory, "initializations.log");
	try {
		const firstPath = writeCodeSearchOwner(
			directory,
			"first-code-provider.mjs",
			markerPath,
		);
		const secondPath = writeCodeSearchOwner(
			directory,
			"second-code-provider.mjs",
			markerPath,
		);
		const { prepareSubagentTaskLaunch } = await import(
			pathToFileURL(join(root, ".tmp/unit/subagent-backend.js")).href
		);
		const prepared = await prepareSubagentTaskLaunch(
			root,
			{ runId: "code-search-duplicate-owner" },
			{
				taskId: "duplicate-owner",
				files: { result: ".tmp/code-search-duplicate-owner-result.json" },
			},
			{
				runtime: {
					tools: ["code_search"],
					toolProviders: {
						code_search: { extensions: [firstPath, secondPath] },
					},
				},
			},
		);
		assert.equal(
			prepared.extensions.filter((entry) =>
				entry.endsWith("code-search-compat-extension.js"),
			).length,
			0,
		);
		const piSdk = await import("@earendil-works/pi-coding-agent");
		const loader = new piSdk.DefaultResourceLoader({
			cwd: root,
			agentDir: join(directory, "agent"),
			additionalExtensionPaths: prepared.extensions,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		const loaded = loader.getExtensions();
		assert.equal(loaded.extensions.length, 2);
		assert.equal(
			loaded.errors.filter(({ error }) =>
				error.includes('Tool "code_search" conflicts with'),
			).length,
			1,
		);
		assert.deepEqual(readFileSync(markerPath, "utf8"), "initialized\ninitialized\n");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("source and build map only code_search to the sibling compatibility extension", () => {
	const source = readFileSync(join(root, "src/subagent-backend.ts"), "utf8");
	const built = readFileSync(join(root, "dist/subagent-backend.js"), "utf8");
	for (const text of [source, built]) {
		assert.match(
			text,
			/code_search:\s*\[CODE_SEARCH_COMPAT_EXTENSION\]/,
		);
		for (const toolName of [
			"web_search",
			"fetch_content",
			"get_search_content",
		]) {
			assert.match(
				text,
				new RegExp(
					`${toolName}:\\s*\\[BUNDLED_PI_WEB_ACCESS_EXTENSION\\]`,
				),
			);
		}
	}
	assert.match(
		source,
		/`code-search-compat-extension\$\{extname\(MODULE_PATH\)\}`/,
	);
	assert.doesNotMatch(
		readFileSync(
			join(root, "src/code-search-compat-extension.ts"),
			"utf8",
		),
		/from ["']pi-web-access(?:\/|["'])/,
	);
});
