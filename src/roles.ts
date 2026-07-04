import { compactStrings } from "./strings.js";
import type { AgentDefinition, CompiledRole, RoleSpec } from "./types.js";

export const DEFAULT_SAFE_SECTIONS = [
  "Core Principles",
  "Domain Expertise",
  "Safety Review",
  "Rules",
  "Research Manifest",
] as const;

const ALWAYS_EXCLUDED_SECTIONS = [
  "Output Format",
  "Direct Response Format",
  "Exit Criteria",
  "Subagent Delegation Instructions",
  "Delegation Instructions",
  "Workflow Orchestration Instructions",
  "Stage Orchestration Instructions",
] as const;

const DEFAULT_MAX_ROLE_CHARS = 12_000;

export function compileRole(name: string, spec: RoleSpec, sourceAgent?: AgentDefinition): CompiledRole {
  const maxChars = spec.maxChars ?? DEFAULT_MAX_ROLE_CHARS;
  const includeSections = spec.includeSections ?? [...DEFAULT_SAFE_SECTIONS];
  const excludedSections = [...ALWAYS_EXCLUDED_SECTIONS, ...(spec.excludeSections ?? [])];
  const parts = compactStrings([
    sourceAgent ? extractMarkdownSections(sourceAgent.body, includeSections, excludedSections) : undefined,
    spec.prompt,
  ], { unique: false });

  const fullContent = parts.join("\n\n");
  const truncated = fullContent.length > maxChars;

  return {
    name,
    fromAgent: spec.fromAgent,
    sourcePath: sourceAgent?.sourcePath,
    content: truncated ? fullContent.slice(0, maxChars).trimEnd() : fullContent,
    maxChars,
    truncated,
    includedSections: includeSections,
    excludedSections,
  };
}

interface HeadingRange {
  title: string;
  normalizedTitle: string;
  level: number;
  start: number;
  end: number;
}

export function extractMarkdownSections(markdown: string, includeSections: readonly string[], excludeSections: readonly string[]): string {
  const lines = markdown.split(/\r?\n/);
  const headings = buildHeadingRanges(lines);
  if (headings.length === 0) return "";

  const includeRanges = headings.filter((heading) => matchesAny(heading.normalizedTitle, includeSections));
  const excludeRanges = headings.filter((heading) => matchesAny(heading.normalizedTitle, excludeSections));
  const selected = new Set<number>();

  for (const range of includeRanges) {
    for (let index = range.start; index < range.end; index += 1) selected.add(index);
  }

  for (const range of excludeRanges) {
    for (let index = range.start; index < range.end; index += 1) selected.delete(index);
  }

  return lines.filter((_, index) => selected.has(index)).join("\n").trim();
}

function buildHeadingRanges(lines: string[]): HeadingRange[] {
  const headings: Omit<HeadingRange, "end">[] = [];

  lines.forEach((line, index) => {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!match) return;

    const title = (match[2] ?? "").replace(/#+$/, "").trim();
    headings.push({
      title,
      normalizedTitle: normalizeTitle(title),
      level: match[1]!.length,
      start: index,
    });
  });

  return headings.map((heading, index) => {
    const nextSibling = headings.findIndex((candidate, candidateIndex) => (
      candidateIndex > index && candidate.level <= heading.level
    ));

    return {
      ...heading,
      end: nextSibling === -1 ? lines.length : headings[nextSibling]!.start,
    };
  });
}

function matchesAny(normalizedTitle: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesTitle(normalizedTitle, normalizeTitle(pattern)));
}

function matchesTitle(normalizedTitle: string, normalizedPattern: string): boolean {
  return normalizedTitle === normalizedPattern
    || normalizedTitle.startsWith(`${normalizedPattern} `)
    || normalizedTitle.startsWith(`${normalizedPattern} /`)
    || normalizedTitle.includes(` / ${normalizedPattern}`);
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
}
