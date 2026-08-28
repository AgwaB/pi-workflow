import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const CODE_CONTEXT_TOOL = "get_code_context_exa";
const WEB_SEARCH_TOOL = "web_search_exa";
const DEFAULT_MAX_TOKENS = 5000;
const EXA_MCP_TIMEOUT_MS = 60_000;

type ExaMcpTool = typeof CODE_CONTEXT_TOOL | typeof WEB_SEARCH_TOOL;
type CodeSearchMode = "code-context" | "web-search-fallback";

interface ExaMcpRpcResponse {
	result?: {
		content?: Array<{ type?: string; text?: string }>;
		isError?: boolean;
	};
	error?: {
		code?: number;
		message?: string;
	};
}

interface CodeSearchDetails {
	query: string;
	maxTokens: number;
	error?: string;
	mode?: CodeSearchMode;
}

interface CodeSearchResult {
	content: Array<{ type: "text"; text: string }>;
	details: CodeSearchDetails;
}

let codeContextToolMissing = false;

function isMissingMcpToolError(message: string): boolean {
	const normalized = message.toLowerCase();
	return normalized.includes("tool") && normalized.includes("not found");
}

function isAbortError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const name = "name" in error ? String(error.name) : "";
	return name === "AbortError" || name === "TimeoutError";
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(EXA_MCP_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function parsedRpcPayload(payload: string): ExaMcpRpcResponse | undefined {
	try {
		const candidate = JSON.parse(payload) as ExaMcpRpcResponse;
		return candidate?.result || candidate?.error ? candidate : undefined;
	} catch {
		return undefined;
	}
}

function parseMcpBody(body: string): ExaMcpRpcResponse | undefined {
	for (const line of body.split("\n")) {
		if (!line.startsWith("data:")) continue;
		const parsed = parsedRpcPayload(line.slice(5).trim());
		if (parsed) return parsed;
	}
	return parsedRpcPayload(body);
}

function mcpResultText(parsed: ExaMcpRpcResponse): string {
	if (parsed.error) {
		const code =
			typeof parsed.error.code === "number" ? ` ${parsed.error.code}` : "";
		throw new Error(
			`Exa MCP error${code}: ${parsed.error.message || "Unknown error"}`,
		);
	}
	const textItem = parsed.result?.content?.find(
		(item) => item.type === "text" && typeof item.text === "string",
	);
	const text = textItem?.text?.trim();
	if (parsed.result?.isError)
		throw new Error(text || "Exa MCP returned an error");
	if (!text) throw new Error("Exa MCP returned empty content");
	return textItem?.text ?? text;
}

async function callExaMcp(
	toolName: ExaMcpTool,
	args: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<string> {
	const response = await fetch(`${EXA_MCP_URL}?tools=${toolName}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"x-exa-source": "pi-web-access",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: toolName,
				arguments: args,
			},
		}),
		signal: requestSignal(signal),
	});
	if (!response.ok) {
		const errorText = await response.text();
		if (response.status === 429)
			throw new Error(
				`Exa MCP rate limit reached (429): ${errorText.slice(0, 200)}`,
			);
		throw new Error(
			`Exa MCP error ${response.status}: ${errorText.slice(0, 300)}`,
		);
	}
	const parsed = parseMcpBody(await response.text());
	if (!parsed) throw new Error("Exa MCP returned an empty response");
	return mcpResultText(parsed);
}

function buildFallbackQuery(query: string): string {
	const normalized = query.toLowerCase();
	const hasCodeTerms =
		/\b(api|code|docs?|documentation|example|github|implementation|library|source|stackoverflow|stack overflow)\b/.test(
			normalized,
		);
	return hasCodeTerms
		? query
		: `${query} code examples documentation GitHub Stack Overflow official docs`;
}

function maxTokensToResultCount(maxTokens: number): number {
	return Math.min(20, Math.max(5, Math.ceil(maxTokens / 1000)));
}

function trimApproxTokens(text: string, maxTokens: number): string {
	const maxCharacters = Math.max(1000, maxTokens * 4);
	if (text.length <= maxCharacters) return text;
	return `${text.slice(0, maxCharacters).trimEnd()}\n\n[Truncated by code_search to approximately ${maxTokens} tokens.]`;
}

async function executeFallbackSearch(
	query: string,
	maxTokens: number,
	signal?: AbortSignal,
): Promise<string> {
	const text = await callExaMcp(
		WEB_SEARCH_TOOL,
		{
			query: buildFallbackQuery(query),
			numResults: maxTokensToResultCount(maxTokens),
			livecrawl: "fallback",
			type: "auto",
			contextMaxCharacters: Math.min(
				50000,
				Math.max(1000, maxTokens * 4),
			),
		},
		signal,
	);
	return trimApproxTokens(text, maxTokens);
}

async function executeCodeSearch(
	params: { query: string; maxTokens?: number },
	signal?: AbortSignal,
): Promise<CodeSearchResult> {
	const query = params.query.trim();
	if (!query) {
		return {
			content: [{ type: "text", text: "Error: No query provided." }],
			details: {
				query: "",
				maxTokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
				error: "No query provided",
			},
		};
	}

	const maxTokens = params.maxTokens ?? DEFAULT_MAX_TOKENS;
	try {
		let mode: CodeSearchMode = "web-search-fallback";
		let text: string;

		if (codeContextToolMissing) {
			text = await executeFallbackSearch(query, maxTokens, signal);
		} else {
			try {
				text = await callExaMcp(
					CODE_CONTEXT_TOOL,
					{ query, tokensNum: maxTokens },
					signal,
				);
				mode = "code-context";
			} catch (error) {
				if (signal?.aborted || isAbortError(error)) throw error;
				const message =
					error instanceof Error ? error.message : String(error);
				if (!isMissingMcpToolError(message)) throw error;
				codeContextToolMissing = true;
				text = await executeFallbackSearch(query, maxTokens, signal);
			}
		}

		return {
			content: [{ type: "text", text }],
			details: { query, maxTokens, mode },
		};
	} catch (error) {
		if (signal?.aborted || isAbortError(error)) throw error;
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Error: ${message}` }],
			details: { query, maxTokens, error: message },
		};
	}
}

export default function codeSearchCompatExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "code_search",
		label: "Code Search",
		description:
			"Search for code examples, documentation, and API references. Returns relevant code snippets and docs from GitHub, Stack Overflow, and official documentation. Use for any programming question — API usage, library examples, debugging help.",
		promptSnippet:
			"Use for programming/API/library questions to retrieve concrete examples and docs before implementing or debugging code.",
		parameters: Type.Object({
			query: Type.String({
				description:
					"Programming question, API, library, or debugging topic to search for",
			}),
			maxTokens: Type.Optional(
				Type.Integer({
					minimum: 1000,
					maximum: 50000,
					description:
						"Maximum tokens of code/documentation context to return (default: 5000)",
				}),
			),
		}),
		async execute(_toolCallId, params, signal) {
			return executeCodeSearch(params, signal);
		},
	});
}
