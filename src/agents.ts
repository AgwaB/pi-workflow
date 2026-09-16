import type { Dirent } from "node:fs";
import { lstat, open, opendir, readdir, readFile, realpath } from "node:fs/promises";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { fileURLToPath } from "node:url";

import { piAgentDir } from "./pi-agent-dir.js";
import {
	APPROVAL_MODES,
	type AgentDefinition,
	FAST_MODES,
	WorkflowValidationError,
	THINKING_LEVELS,
	type ValidationIssue,
} from "./types.js";

type AgentScope = AgentDefinition["scope"];

export interface AgentRegistry {
	agents: AgentDefinition[];
	byAlias: Map<string, AgentDefinition>;
}

/** Only frontmatter is needed for bounded local routing safety checks. */
export interface BoundedAgentMetadata {
	agent: AgentDefinition;
	bytes: number;
}

export const WORKFLOW_AGENT_METADATA_MAX_BYTES = 16_384;

/** Optional routing-owned reservation hook for every metadata file read. */
export interface AgentMetadataLoadOptions {
	beforeRead?: () => void;
	maxAliasCandidates?: number;
	maxAliasRootEntries?: number;
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export async function discoverAgents(cwd: string): Promise<AgentRegistry> {
	const byAlias = new Map<string, AgentDefinition>();
	const byPath = new Map<string, AgentDefinition>();

	for (const root of agentRoots(cwd)) {
		const files = await listMarkdownFiles(root.path, root.scope);
		for (const file of files) {
			const agent = await readAgentFile(file, root.path, root.scope);
			let accepted = false;

			for (const alias of agent.aliases) {
				if (!byAlias.has(alias)) {
					byAlias.set(alias, agent);
					accepted = true;
				}
			}

			if (accepted && !byPath.has(agent.sourcePath)) {
				byPath.set(agent.sourcePath, agent);
			}
		}
	}

	return {
		agents: [...byPath.values()].sort((left, right) =>
			left.displayName.localeCompare(right.displayName),
		),
		byAlias,
	};
}

export async function loadAgentByName(
	name: string,
	cwd: string,
): Promise<AgentDefinition | undefined> {
	if (!isSafeAgentName(name)) return undefined;

	for (const candidate of candidateAgentPaths(name, cwd)) {
		try {
			return await readAgentFile(
				candidate.file,
				candidate.root,
				candidate.scope,
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			if (isProjectRootSymlinkError(error)) continue;
			throw error;
		}
	}

	const registry = await discoverAgents(cwd);
	return registry.byAlias.get(name);
}

/**
 * Read only a bounded agent frontmatter prefix for routing metadata. This
 * intentionally does not fall back to full registry discovery: aliases that
 * cannot be resolved by a direct bounded path stay needs-check until selected.
 */
export async function loadAgentMetadataByName(
	name: string,
	cwd: string,
	maxBytes = WORKFLOW_AGENT_METADATA_MAX_BYTES,
	options: AgentMetadataLoadOptions = {},
): Promise<BoundedAgentMetadata | undefined> {
	if (!isSafeAgentName(name) || !Number.isSafeInteger(maxBytes) || maxBytes < 1)
		return undefined;
	const seen = new Set<string>();
	const read = async (candidate: {
		file: string;
		root: string;
		scope: AgentScope;
	}): Promise<BoundedAgentMetadata | undefined> => {
		const file = resolve(candidate.file);
		if (seen.has(file)) return undefined;
		seen.add(file);
		// Missing direct candidates are not metadata reads. Do the bounded source
		// open only after an lstat confirms that a candidate exists.
		try {
			await lstat(file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		options.beforeRead?.();
		return await readAgentMetadataFile(
			candidate.file,
			candidate.root,
			candidate.scope,
			maxBytes,
		);
	};
	for (const candidate of candidateAgentPaths(name, cwd)) {
		try {
			const result = await read(candidate);
			if (result) return result;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			if (isProjectRootSymlinkError(error)) continue;
			throw error;
		}
	}

	// A frontmatter `name`/package alias can differ from its file name. Keep
	// that compatibility without falling back to unbounded full-body registry
	// discovery. File reads remain charged to the caller-owned budget.
	const maxCandidates = Math.max(
		1,
		Math.min(64, Math.floor(options.maxAliasCandidates ?? 32)),
	);
	const maxRootEntries = Math.max(
		1,
		Math.min(256, Math.floor(options.maxAliasRootEntries ?? 64)),
	);
	let examined = 0;
	for (const root of agentRoots(cwd)) {
		const files = await listAgentMetadataFiles(
			root.path,
			root.scope,
			maxRootEntries,
		);
		for (const file of files) {
			if (examined >= maxCandidates) return undefined;
			examined += 1;
			try {
				const result = await read({ file, root: root.path, scope: root.scope });
				if (result?.agent.aliases.includes(name)) return result;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				if (isProjectRootSymlinkError(error)) continue;
				throw error;
			}
		}
	}
	return undefined;
}

export function parseAgentMarkdown(
	markdown: string,
	sourcePath: string,
	scope: AgentScope,
	rootPath?: string,
): AgentDefinition {
	const { frontmatter, body } = splitFrontmatter(markdown);
	const fileBaseName = basename(sourcePath, ".md");
	const relativeName = rootPath
		? toDottedName(relative(rootPath, sourcePath).replace(/\.md$/, ""))
		: fileBaseName;
	const name = stringValue(frontmatter.name) ?? fileBaseName;
	const packageName = stringValue(frontmatter.package);
	const displayName = packageName
		? `${packageName}.${name}`
		: relativeName || name;
	const aliases = uniqueStrings([
		displayName,
		relativeName,
		name,
		packageName ? `${packageName}.${name}` : undefined,
		dirname(relativeName) !== "."
			? `${dirname(relativeName).split(sep).join(".")}.${name}`
			: undefined,
	]);

	return {
		name,
		displayName,
		description: stringValue(frontmatter.description),
		packageName,
		aliases,
		sourcePath,
		scope,
		frontmatter,
		body,
		model: stringValue(frontmatter.model),
		thinking: enumValue(frontmatter.thinking, THINKING_LEVELS),
		fast: enumValue(frontmatter.fast, FAST_MODES),
		tools: toolsValue(frontmatter.tools),
		readOnly: booleanValue(frontmatter.readOnly),
		approvalMode: enumValue(frontmatter.approvalMode, APPROVAL_MODES),
		maxSubagentDepth: numberValue(frontmatter.maxSubagentDepth) ?? 0,
		systemPromptMode: stringValue(frontmatter.systemPromptMode),
		inheritProjectContext: booleanValue(frontmatter.inheritProjectContext),
		inheritSkills: booleanValue(frontmatter.inheritSkills),
	};
}

function agentRoots(cwd: string): Array<{ path: string; scope: AgentScope }> {
	return [
		{ path: resolve(cwd, ".pi", "agents"), scope: "project" },
		{ path: join(piAgentDir(), "agents"), scope: "user" },
		...bundledAgentRoots().map((path) => ({ path, scope: "bundled" as const })),
	];
}

function bundledAgentRoots(): string[] {
	return uniquePaths([
		resolve(MODULE_DIR, "..", "agents"),
		resolve(MODULE_DIR, "..", "..", "agents"),
	]);
}

function candidateAgentPaths(
	name: string,
	cwd: string,
): Array<{ file: string; root: string; scope: AgentScope }> {
	if (!isSafeAgentName(name)) return [];

	const roots = agentRoots(cwd);
	const pathName = name.replaceAll(".", sep);
	const relativeCandidates = uniqueStrings([`${pathName}.md`, `${name}.md`]);

	return roots.flatMap((root) => {
		const rootPath = resolve(root.path);
		return relativeCandidates.flatMap((relativePath) => {
			const file = resolve(rootPath, relativePath);
			if (!isPathInside(rootPath, file)) return [];
			return [{ file, root: rootPath, scope: root.scope }];
		});
	});
}

async function listAgentMetadataFiles(
	root: string,
	scope: AgentScope,
	maxEntries: number,
): Promise<string[]> {
	const files: string[] = [];
	let entriesSeen = 0;
	const visit = async (directoryPath: string, remainingDepth: number): Promise<void> => {
		if (
			files.length >= maxEntries ||
			entriesSeen >= maxEntries ||
			remainingDepth < 0
		)
			return;
		let directory: Awaited<ReturnType<typeof opendir>>;
		try {
			if (scope === "project" && (await lstat(directoryPath)).isSymbolicLink())
				return;
			directory = await opendir(directoryPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		const entries: Dirent[] = [];
		for await (const entry of directory) {
			if (entriesSeen >= maxEntries) break;
			entriesSeen += 1;
			entries.push(entry);
		}
		for (const entry of entries.sort((left, right) =>
			left.name.localeCompare(right.name),
		)) {
			if (files.length >= maxEntries) return;
			const path = join(directoryPath, entry.name);
			if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
			else if (entry.isDirectory()) await visit(path, remainingDepth - 1);
		}
	};
	await visit(resolve(root), 4);
	return files;
}

async function readAgentMetadataFile(
	file: string,
	root: string,
	scope: AgentScope,
	maxBytes: number,
): Promise<BoundedAgentMetadata> {
	const rootPath = resolve(root);
	const sourcePath = resolve(file);
	const rootStat = await lstat(rootPath);
	if (scope === "project" && rootStat.isSymbolicLink()) {
		throw new WorkflowValidationError([
			{
				path: "$agent",
				message: `agent root must not be a symlink: ${rootPath}`,
			},
		]);
	}
	if (!isPathInside(rootPath, sourcePath)) {
		throw new WorkflowValidationError([
			{ path: "$agent", message: `agent path escapes root: ${sourcePath}` },
		]);
	}
	const realRoot = await realpath(rootPath);
	const realSource = await realpath(sourcePath);
	if (!isPathInside(realRoot, realSource)) {
		throw new WorkflowValidationError([
			{ path: "$agent", message: `agent symlink escapes root: ${sourcePath}` },
		]);
	}
	const pathBefore = await lstat(realSource);
	if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
		throw new WorkflowValidationError([
			{ path: "$agent", message: `agent source must be a regular file: ${sourcePath}` },
		]);
	}
	const handle = await open(realSource, "r");
	try {
		const before = await handle.stat();
		if (
			!before.isFile() ||
			before.dev !== pathBefore.dev ||
			before.ino !== pathBefore.ino
		) {
			throw new Error("agent metadata changed while opened");
		}
		// Read exactly through the closing frontmatter delimiter. In particular, do
		// not use a max-sized prefix read: a short agent body would otherwise be
		// fully read merely to derive routing facts.
		const result = await readBoundedAgentFrontmatter(handle, before.size, maxBytes);
		const [after, pathAfter] = await Promise.all([handle.stat(), lstat(realSource)]);
		if (
			after.size !== before.size ||
			after.dev !== before.dev ||
			after.ino !== before.ino ||
			!pathAfter.isFile() ||
			pathAfter.isSymbolicLink() ||
			pathAfter.dev !== before.dev ||
			pathAfter.ino !== before.ino
		) {
			throw new Error("agent metadata changed while read");
		}
		if (result.frontmatter === undefined)
			throw new Error(`agent metadata frontmatter exceeds ${maxBytes} UTF-8 bytes`);
		const parsed = parseAgentMarkdown(
			result.frontmatter,
			realSource,
			scope,
			realRoot,
		);
		return { agent: { ...parsed, body: "" }, bytes: result.bytes };
	} finally {
		await handle.close();
	}
}

async function readBoundedAgentFrontmatter(
	handle: Awaited<ReturnType<typeof open>>,
	fileBytes: number,
	maxBytes: number,
): Promise<{ frontmatter: string | undefined; bytes: number }> {
	const collected: number[] = [];
	const oneByte = Buffer.allocUnsafe(1);
	let lineStart = 0;
	let sawOpeningDelimiter = false;
	const delimiterAt = (start: number, end: number): boolean => {
		let left = start;
		let right = end;
		while (left < right && (collected[left] === 0x20 || collected[left] === 0x09))
			left += 1;
		while (
			right > left &&
			(collected[right - 1] === 0x20 ||
				collected[right - 1] === 0x09 ||
				collected[right - 1] === 0x0d)
		)
			right -= 1;
		return (
			right - left === 3 &&
			collected[left] === 0x2d &&
			collected[left + 1] === 0x2d &&
			collected[left + 2] === 0x2d
		);
	};
	const completeLine = (end: number): string | undefined | null => {
		const delimiter = delimiterAt(lineStart, end);
		if (!sawOpeningDelimiter) {
			if (!delimiter) return "";
			sawOpeningDelimiter = true;
			lineStart = end + 1;
			return null;
		}
		if (delimiter) return Buffer.from(collected).toString("utf8");
		lineStart = end + 1;
		return null;
	};

	while (collected.length < maxBytes && collected.length < fileBytes) {
		const { bytesRead } = await handle.read(oneByte, 0, 1, collected.length);
		if (bytesRead !== 1) break;
		collected.push(oneByte[0]!);
		// `splitFrontmatter()` only recognizes a delimiter at byte zero. Reject a
		// normal body as soon as that prefix is impossible instead of scanning to
		// its first newline (which an adversarial body may omit).
		if (
			!sawOpeningDelimiter &&
			((collected.length === 3 &&
				(collected[0] !== 0x2d ||
					collected[1] !== 0x2d ||
					collected[2] !== 0x2d)) ||
				(collected.length > 3 &&
					oneByte[0] !== 0x20 &&
					oneByte[0] !== 0x09 &&
					oneByte[0] !== 0x0d &&
					oneByte[0] !== 0x0a))
		)
			return { frontmatter: "", bytes: collected.length };
		if (oneByte[0] !== 0x0a) continue;
		const complete = completeLine(collected.length - 1);
		if (complete !== null)
			return { frontmatter: complete, bytes: collected.length };
	}
	// A final delimiter does not need a trailing newline. Conversely, a file
	// without an opening delimiter is metadata-empty and must not cause a body
	// read beyond its first line.
	if (collected.length === fileBytes) {
		const complete = completeLine(collected.length);
		if (complete !== null)
			return { frontmatter: complete, bytes: collected.length };
	}
	return {
		frontmatter: sawOpeningDelimiter ? undefined : "",
		bytes: collected.length,
	};
}

async function readAgentFile(
	file: string,
	root: string,
	scope: AgentScope,
): Promise<AgentDefinition> {
	const rootPath = resolve(root);
	const sourcePath = resolve(file);
	const rootStat = await lstat(rootPath);
	if (scope === "project" && rootStat.isSymbolicLink()) {
		throw new WorkflowValidationError([
			{
				path: "$agent",
				message: `agent root must not be a symlink: ${rootPath}`,
			},
		]);
	}
	if (!isPathInside(rootPath, sourcePath)) {
		throw new WorkflowValidationError([
			{ path: "$agent", message: `agent path escapes root: ${sourcePath}` },
		]);
	}

	const realRoot = await realpath(rootPath);
	const realSource = await realpath(sourcePath);
	if (!isPathInside(realRoot, realSource)) {
		throw new WorkflowValidationError([
			{ path: "$agent", message: `agent symlink escapes root: ${sourcePath}` },
		]);
	}

	return parseAgentMarkdown(
		await readFile(realSource, "utf8"),
		realSource,
		scope,
		realRoot,
	);
}

function isProjectRootSymlinkError(error: unknown): boolean {
	return (
		error instanceof WorkflowValidationError &&
		error.issues.some((issue) =>
			issue.message.startsWith("agent root must not be a symlink:"),
		)
	);
}

function isSafeAgentName(name: string): boolean {
	if (!/^[A-Za-z0-9_.-]+$/.test(name)) return false;
	return name
		.split(".")
		.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isPathInside(root: string, candidate: string): boolean {
	const relativePath = relative(root, candidate);
	return (
		relativePath === "" ||
		(!relativePath.startsWith("..") && !isAbsolute(relativePath))
	);
}

async function listMarkdownFiles(
	root: string,
	scope: AgentScope,
): Promise<string[]> {
	try {
		const rootStat = await lstat(root);
		if (scope === "project" && rootStat.isSymbolicLink()) return [];

		const entries = await readdir(root, { withFileTypes: true });
		const nested = await Promise.all(
			entries.map((entry) => {
				const path = join(root, entry.name);
				if (entry.isDirectory()) return listMarkdownFiles(path, scope);
				if (entry.isFile() && entry.name.endsWith(".md")) return [path];
				return [];
			}),
		);
		return nested.flat();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

function splitFrontmatter(markdown: string): {
	frontmatter: Record<string, unknown>;
	body: string;
} {
	if (!markdown.startsWith("---")) return { frontmatter: {}, body: markdown };

	const lines = markdown.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return { frontmatter: {}, body: markdown };

	const end = lines.findIndex(
		(line, index) => index > 0 && line.trim() === "---",
	);
	if (end === -1) return { frontmatter: {}, body: markdown };

	return {
		frontmatter: parseSimpleYaml(lines.slice(1, end).join("\n")),
		body: lines
			.slice(end + 1)
			.join("\n")
			.replace(/^\s+/, ""),
	};
}

function parseSimpleYaml(yaml: string): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	let currentListKey: string | undefined;

	for (const rawLine of yaml.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) continue;

		const listItem = rawLine.match(/^\s+-\s*(.*)$/);
		if (listItem) {
			if (!currentListKey || !Array.isArray(result[currentListKey])) {
				throw new WorkflowValidationError([
					{
						path: "$agent.frontmatter",
						message: `unsupported YAML list item: ${line}`,
					},
				]);
			}
			(result[currentListKey] as string[]).push(
				stripQuotes(listItem[1]!.trim()),
			);
			continue;
		}

		if (/^\s/.test(rawLine)) {
			throw new WorkflowValidationError([
				{
					path: "$agent.frontmatter",
					message: `unsupported indented YAML: ${line}`,
				},
			]);
		}

		const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!match) {
			throw new WorkflowValidationError([
				{
					path: "$agent.frontmatter",
					message: `unsupported YAML frontmatter line: ${line}`,
				},
			]);
		}

		const key = match[1]!;
		const rawValue = match[2] ?? "";
		if (rawValue.trim() === "") {
			result[key] = [];
			currentListKey = key;
			continue;
		}

		currentListKey = undefined;
		result[key] = parseScalar(key, rawValue);
	}

	return result;
}

function parseScalar(key: string, value: string): unknown {
	const trimmed = value.trim();
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);

	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		return splitCommaList(trimmed.slice(1, -1));
	}

	if (key === "tools" && trimmed.includes(",")) return splitCommaList(trimmed);
	return stripQuotes(trimmed);
}

function splitCommaList(value: string): string[] {
	return value
		.split(",")
		.map((part) => stripQuotes(part.trim()))
		.filter(Boolean);
}

function stripQuotes(value: string): string {
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1);
	}
	return value;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function toolsValue(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		const tools = value.filter(
			(item): item is string => typeof item === "string" && item.trim() !== "",
		);
		return tools.length > 0 ? tools : undefined;
	}
	if (typeof value === "string" && value.trim() !== "")
		return splitCommaList(value);
	return undefined;
}

function enumValue<T extends readonly string[]>(
	value: unknown,
	values: T,
): T[number] | undefined {
	return typeof value === "string" && values.includes(value as never)
		? (value as T[number])
		: undefined;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
	const issues: ValidationIssue[] = [];
	const unique = values.filter(
		(value): value is string =>
			typeof value === "string" && value.trim() !== "",
	);
	if (unique.length === 0)
		throw new WorkflowValidationError([
			{ path: "$agent", message: "agent has no valid name" },
		]);
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of unique) {
		if (!seen.has(value)) {
			seen.add(value);
			result.push(value);
		}
	}
	if (issues.length > 0) throw new WorkflowValidationError(issues);
	return result;
}

function uniquePaths(values: string[]): string[] {
	return [...new Set(values)];
}

function toDottedName(path: string): string {
	return path.split(sep).join(".");
}
