import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

const logPath = resolve(process.argv[2] ?? "workflow-native-host-mcp.jsonl");
const scope = process.env.MCP_FIXTURE_SCOPE ?? "unset";
const pending = new Map();

mkdirSync(dirname(logPath), { recursive: true });

function record(event) {
	appendFileSync(logPath, `${JSON.stringify({ scope, ...event })}\n`, "utf8");
}

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
	send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
	send({ jsonrpc: "2.0", id, error: { code, message } });
}

const tools = [
	{
		name: "inspect",
		description: "Return the isolated fixture scope and process working directory.",
		inputSchema: {
			type: "object",
			properties: { label: { type: "string" } },
			additionalProperties: false,
		},
		outputSchema: {
			type: "object",
			properties: {
				scope: { type: "string" },
				cwd: { type: "string" },
				label: { type: "string" },
			},
			required: ["scope", "cwd", "label"],
			additionalProperties: false,
		},
	},
	{
		name: "fail",
		description: "Return an intentional MCP tool error result.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		outputSchema: {
			type: "object",
			properties: { kind: { type: "string" } },
			required: ["kind"],
			additionalProperties: false,
		},
	},
	{
		name: "blocked",
		description: "Must be blocked by the host hook before reaching this fixture.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "slow",
		description: "Wait until the host cancels the MCP request.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
];

function handleNotification(message) {
	if (message.method !== "notifications/cancelled") return;
	const requestId = message.params?.requestId;
	const request = pending.get(requestId);
	if (request) {
		clearTimeout(request.timer);
		pending.delete(requestId);
	}
	record({ event: "cancelled", requestId, reason: String(message.params?.reason ?? "") });
}

function handleRequest(message) {
	const { id, method, params } = message;
	record({ event: "request", method });
	switch (method) {
		case "initialize":
			respond(id, {
				protocolVersion: params?.protocolVersion ?? "2025-11-25",
				capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
				serverInfo: { name: `workflow-native-host-${scope}`, version: "1.0.0" },
				instructions: `Disposable offline fixture ${scope}`,
			});
			return;
		case "ping":
			respond(id, {});
			return;
		case "tools/list":
			respond(id, { tools });
			return;
		case "resources/list":
			respond(id, { resources: [{ uri: `fixture://${scope}/document`, name: "document", mimeType: "text/plain" }] });
			return;
		case "resources/templates/list":
			respond(id, { resourceTemplates: [{ uriTemplate: `fixture://${scope}/{name}`, name: "fixture-template" }] });
			return;
		case "resources/read":
			if (params?.uri !== `fixture://${scope}/document`) {
				respondError(id, -32602, "Unknown fixture resource");
				return;
			}
			respond(id, { contents: [{ uri: params.uri, mimeType: "text/plain", text: `MCP_RESOURCE_${scope}` }] });
			return;
		case "tools/call": {
			const name = params?.name;
			record({ event: "tool-call", tool: name, phase: "start" });
			if (name === "inspect") {
				const payload = {
					scope,
					cwd: process.cwd(),
					label: typeof params?.arguments?.label === "string" ? params.arguments.label : "",
				};
				respond(id, {
					content: [{ type: "text", text: `MCP_FIXTURE_INSPECT ${JSON.stringify(payload)}` }],
					structuredContent: payload,
				});
				return;
			}
			if (name === "fail") {
				respond(id, {
					content: [{ type: "text", text: "MCP_FIXTURE_EXPECTED_ERROR" }],
					structuredContent: { kind: "expected-error" },
					isError: true,
				});
				return;
			}
			if (name === "blocked") {
				respond(id, {
					content: [{ type: "text", text: "MCP_FIXTURE_BLOCK_BYPASS" }],
					isError: true,
				});
				return;
			}
			if (name === "slow") {
				const timer = setTimeout(() => {
					pending.delete(id);
					record({ event: "tool-call", tool: name, phase: "late-completion" });
					respond(id, { content: [{ type: "text", text: "MCP_FIXTURE_SLOW_LATE" }] });
				}, 60_000);
				pending.set(id, { timer });
				return;
			}
			respondError(id, -32602, `Unknown fixture tool: ${String(name)}`);
			return;
		}
		default:
			respondError(id, -32601, `Method not found: ${method}`);
	}
}

const input = createInterface({ input: process.stdin, terminal: false });
input.on("line", (line) => {
	if (!line.trim()) return;
	try {
		const message = JSON.parse(line);
		if (Object.hasOwn(message, "id")) handleRequest(message);
		else handleNotification(message);
	} catch (error) {
		record({ event: "fixture-error", message: error instanceof Error ? error.message : String(error) });
	}
});
input.on("close", () => {
	for (const request of pending.values()) clearTimeout(request.timer);
	pending.clear();
});
