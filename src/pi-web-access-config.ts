import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CANONICAL_TOOL_KEYS = {
	web_search: "webSearch",
	fetch_content: "fetchContent",
	get_search_content: "getSearchContent",
} as const;
const ALL_TOOL_KEYS = [
	"webSearch",
	"sourceCheck",
	"fetchContent",
	"getSearchContent",
] as const;
const DEFAULT_TOOL_NAMES: Record<(typeof ALL_TOOL_KEYS)[number], string> = {
	webSearch: "web_search",
	sourceCheck: "source_check",
	fetchContent: "fetch_content",
	getSearchContent: "get_search_content",
};
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

type CanonicalToolName = keyof typeof CANONICAL_TOOL_KEYS;
type ToolKey = (typeof ALL_TOOL_KEYS)[number];
type JsonObject = Record<string, unknown>;

/** Mirrors pi-web-access@0.24.2's effective web-search.json root resolution. */
export function piWebAccessConfigPath(): string {
	const configuredAgentDir = process.env.PI_CODING_AGENT_DIR;
	if (configuredAgentDir) return join(configuredAgentDir, "web-search.json");
	const xdgConfigHome = process.env.XDG_CONFIG_HOME;
	if (xdgConfigHome) return join(xdgConfigHome, "pi", "web-search.json");
	return join(homedir(), ".pi", "web-search.json");
}

/**
 * Fail-closed validation for the v0.24.2 initialization fields that determine
 * canonical tool registration. Diagnostics deliberately contain no config
 * values, file contents, or parser snippets.
 */
export function assertPiWebAccessEffectiveConfig(
	requiredCanonicalTools: readonly string[],
): void {
	const config = readPiWebAccessConfig();
	const webSearch = optionalObject(config, "webSearch");
	const tools = optionalObject(config, "tools");
	const toolNames = optionalObject(config, "toolNames");

	if (webSearch && webSearch.enabled !== undefined && typeof webSearch.enabled !== "boolean") {
		configFailure("invalid_web_search_configuration");
	}

	const enabled = new Map<ToolKey, boolean>();
	const names = new Map<ToolKey, string>();
	for (const key of ALL_TOOL_KEYS) {
		const tool = tools ? optionalObject(tools, key) : undefined;
		if (tool && tool.enabled !== undefined && typeof tool.enabled !== "boolean") {
			configFailure("invalid_tool_configuration");
		}
		const override = tool?.enabled;
		enabled.set(
			key,
			typeof override === "boolean"
				? override
				: key !== "webSearch" && key !== "sourceCheck"
					? true
					: webSearch?.enabled !== false,
		);

		const configuredName = toolNames?.[key];
		if (configuredName !== undefined && typeof configuredName !== "string") {
			configFailure("invalid_tool_name_configuration");
		}
		const name =
			typeof configuredName === "string" ? configuredName.trim() : DEFAULT_TOOL_NAMES[key];
		if (!TOOL_NAME_PATTERN.test(name)) configFailure("invalid_tool_name_configuration");
		names.set(key, name);
	}

	const seenNames = new Set<string>();
	for (const key of ALL_TOOL_KEYS) {
		if (!enabled.get(key)) continue;
		const name = names.get(key)!;
		if (seenNames.has(name)) configFailure("duplicate_tool_name");
		seenNames.add(name);
	}

	for (const canonical of requiredCanonicalTools) {
		if (!isCanonicalToolName(canonical)) continue;
		const key = CANONICAL_TOOL_KEYS[canonical];
		if (!enabled.get(key)) configFailure("required_tool_disabled", canonical);
		if (names.get(key) !== canonical) configFailure("required_tool_renamed", canonical);
	}
}

function readPiWebAccessConfig(): JsonObject {
	const path = piWebAccessConfigPath();
	if (!existsSync(path)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		configFailure("invalid_json");
	}
	if (!isObject(parsed)) configFailure("invalid_root");
	return parsed;
}

function optionalObject(parent: JsonObject, key: string): JsonObject | undefined {
	const value = parent[key];
	if (value === undefined) return undefined;
	if (!isObject(value)) configFailure(`invalid_${key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`);
	return value;
}

function isCanonicalToolName(value: string): value is CanonicalToolName {
	return Object.hasOwn(CANONICAL_TOOL_KEYS, value);
}

function isObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function configFailure(code: string, canonical?: CanonicalToolName): never {
	throw new Error(
		`pi-web-access configuration preflight failed [${code}]${canonical ? `: ${canonical}` : ""}`,
	);
}
