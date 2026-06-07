import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  APPROVAL_MODES,
  AgentDefinition,
  FAST_MODES,
  WorkflowValidationError,
  THINKING_LEVELS,
  ValidationIssue,
} from "./types.js";

export interface AgentRegistry {
  agents: AgentDefinition[];
  byAlias: Map<string, AgentDefinition>;
}

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
    agents: [...byPath.values()].sort((left, right) => left.displayName.localeCompare(right.displayName)),
    byAlias,
  };
}

export async function loadAgentByName(name: string, cwd: string): Promise<AgentDefinition | undefined> {
  if (!isSafeAgentName(name)) return undefined;

  for (const candidate of candidateAgentPaths(name, cwd)) {
    try {
      return await readAgentFile(candidate.file, candidate.root, candidate.scope);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      if (isProjectRootSymlinkError(error)) continue;
      throw error;
    }
  }

  const registry = await discoverAgents(cwd);
  return registry.byAlias.get(name);
}

export function parseAgentMarkdown(
  markdown: string,
  sourcePath: string,
  scope: "project" | "user",
  rootPath?: string,
): AgentDefinition {
  const { frontmatter, body } = splitFrontmatter(markdown);
  const fileBaseName = basename(sourcePath, ".md");
  const relativeName = rootPath ? toDottedName(relative(rootPath, sourcePath).replace(/\.md$/, "")) : fileBaseName;
  const name = stringValue(frontmatter.name) ?? fileBaseName;
  const packageName = stringValue(frontmatter.package);
  const displayName = packageName ? `${packageName}.${name}` : relativeName || name;
  const aliases = uniqueStrings([
    displayName,
    relativeName,
    name,
    packageName ? `${packageName}.${name}` : undefined,
    dirname(relativeName) !== "." ? `${dirname(relativeName).split(sep).join(".")}.${name}` : undefined,
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

function agentRoots(cwd: string): Array<{ path: string; scope: "project" | "user" }> {
  return [
    { path: resolve(cwd, ".pi", "agents"), scope: "project" },
    { path: join(homedir(), ".pi", "agent", "agents"), scope: "user" },
  ];
}

function candidateAgentPaths(name: string, cwd: string): Array<{ file: string; root: string; scope: "project" | "user" }> {
  if (!isSafeAgentName(name)) return [];

  const roots = agentRoots(cwd);
  const pathName = name.replaceAll(".", sep);
  const relativeCandidates = uniqueStrings([
    `${pathName}.md`,
    `${name}.md`,
  ]);

  return roots.flatMap((root) => {
    const rootPath = resolve(root.path);
    return relativeCandidates.flatMap((relativePath) => {
      const file = resolve(rootPath, relativePath);
      if (!isPathInside(rootPath, file)) return [];
      return [{ file, root: rootPath, scope: root.scope }];
    });
  });
}

async function readAgentFile(file: string, root: string, scope: "project" | "user"): Promise<AgentDefinition> {
  const rootPath = resolve(root);
  const sourcePath = resolve(file);
  const rootStat = await lstat(rootPath);
  if (scope === "project" && rootStat.isSymbolicLink()) {
    throw new WorkflowValidationError([{ path: "$agent", message: `agent root must not be a symlink: ${rootPath}` }]);
  }
  if (!isPathInside(rootPath, sourcePath)) {
    throw new WorkflowValidationError([{ path: "$agent", message: `agent path escapes root: ${sourcePath}` }]);
  }

  const realRoot = await realpath(rootPath);
  const realSource = await realpath(sourcePath);
  if (!isPathInside(realRoot, realSource)) {
    throw new WorkflowValidationError([{ path: "$agent", message: `agent symlink escapes root: ${sourcePath}` }]);
  }

  return parseAgentMarkdown(await readFile(realSource, "utf8"), realSource, scope, realRoot);
}

function isProjectRootSymlinkError(error: unknown): boolean {
  return error instanceof WorkflowValidationError
    && error.issues.some((issue) => issue.message.startsWith("agent root must not be a symlink:"));
}

function isSafeAgentName(name: string): boolean {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return false;
  return name.split(".").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isPathInside(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

async function listMarkdownFiles(root: string, scope: "project" | "user"): Promise<string[]> {
  try {
    const rootStat = await lstat(root);
    if (scope === "project" && rootStat.isSymbolicLink()) return [];

    const entries = await readdir(root, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return listMarkdownFiles(path, scope);
      if (entry.isFile() && entry.name.endsWith(".md")) return [path];
      return [];
    }));
    return nested.flat();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function splitFrontmatter(markdown: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!markdown.startsWith("---")) return { frontmatter: {}, body: markdown };

  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { frontmatter: {}, body: markdown };

  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) return { frontmatter: {}, body: markdown };

  return {
    frontmatter: parseSimpleYaml(lines.slice(1, end).join("\n")),
    body: lines.slice(end + 1).join("\n").replace(/^\s+/, ""),
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
        throw new WorkflowValidationError([{ path: "$agent.frontmatter", message: `unsupported YAML list item: ${line}` }]);
      }
      (result[currentListKey] as string[]).push(stripQuotes(listItem[1]!.trim()));
      continue;
    }

    if (/^\s/.test(rawLine)) {
      throw new WorkflowValidationError([{ path: "$agent.frontmatter", message: `unsupported indented YAML: ${line}` }]);
    }

    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      throw new WorkflowValidationError([{ path: "$agent.frontmatter", message: `unsupported YAML frontmatter line: ${line}` }]);
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
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
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
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toolsValue(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const tools = value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
    return tools.length > 0 ? tools : undefined;
  }
  if (typeof value === "string" && value.trim() !== "") return splitCommaList(value);
  return undefined;
}

function enumValue<T extends readonly string[]>(value: unknown, values: T): T[number] | undefined {
  return typeof value === "string" && values.includes(value as never) ? (value as T[number]) : undefined;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const issues: ValidationIssue[] = [];
  const unique = values.filter((value): value is string => typeof value === "string" && value.trim() !== "");
  if (unique.length === 0) throw new WorkflowValidationError([{ path: "$agent", message: "agent has no valid name" }]);
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

function toDottedName(path: string): string {
  return path.split(sep).join(".");
}
