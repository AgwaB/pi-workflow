import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { WorkflowValidationError } from "./types.js";

const SPEC_EXTENSIONS = new Set([".json", ".yaml", ".yml"]);
const PACKAGE_WORKFLOW_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "workflows");
const RESERVED_WORKFLOW_FILES = new Set(["index.json", "index-supervisor-error.json"]);

export interface ResolvedWorkflowSpecRef {
  inputRef: string;
  specPath: string;
  workflowName?: string;
  workflowRoot?: string;
}

export interface WorkflowSpecRecord {
  name: string;
  fileName: string;
  aliases: string[];
  specPath: string;
  workflowRoot: string;
  legacy?: boolean;
}

export interface WorkflowCatalogMetadata {
  useWhen?: string[];
  avoidWhen?: string[];
  similarWorkflows?: string[];
  mutationRisk?: string;
  naturalLanguageTriggers?: string[];
}

export interface WorkflowRecommendation {
  workflow: WorkflowSpecRecord;
  score: number;
  reasons: string[];
  cautions: string[];
  catalog: WorkflowCatalogMetadata;
}

interface WorkflowCandidate {
  name: string;
  file: string;
  root: string;
}

interface WorkflowRoot {
  path: string;
  legacy?: boolean;
}

export async function resolveWorkflowRef(ref: string, cwd: string): Promise<ResolvedWorkflowSpecRef> {
  const trimmed = ref.trim();
  if (trimmed === "") {
    throw new WorkflowValidationError([{ path: "$spec", message: "workflow name or spec path is required" }]);
  }

  const pathCandidate = resolve(cwd, trimmed);
  if (await isFile(pathCandidate)) {
    return { inputRef: ref, specPath: pathCandidate };
  }

  if (isPathLike(trimmed)) {
    throw new WorkflowValidationError([{ path: trimmed, message: "workflow spec file not found" }]);
  }

  validateWorkflowName(trimmed);
  const matches = await findWorkflowCandidates(trimmed, cwd);
  if (matches.length === 0) {
    throw new WorkflowValidationError([{ path: trimmed, message: "workflow name or spec file not found" }]);
  }
  if (matches.length > 1) {
    throw new WorkflowValidationError([{
      path: trimmed,
      message: `ambiguous workflow name; matches: ${matches.map((match) => relative(cwd, match.file) || match.file).join(", ")}`,
    }]);
  }

  const [match] = matches;
  return {
    inputRef: ref,
    specPath: match!.file,
    workflowName: match!.name,
    workflowRoot: match!.root,
  };
}

export function isSpecFileName(fileName: string): boolean {
  return SPEC_EXTENSIONS.has(extname(fileName).toLowerCase()) && !RESERVED_WORKFLOW_FILES.has(fileName);
}

export async function recommendWorkflows(request: string, cwd: string, limit = 5): Promise<WorkflowRecommendation[]> {
  const query = tokenize(request);
  if (query.length === 0) return [];

  const workflows = await listWorkflows(cwd);
  const recommendations = await Promise.all(workflows.map(async (workflow) => scoreWorkflow(workflow, query)));
  return recommendations
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.workflow.name.localeCompare(right.workflow.name))
    .slice(0, Math.max(1, limit));
}

export async function listWorkflows(cwd: string): Promise<WorkflowSpecRecord[]> {
  const roots = workflowRoots(cwd);
  const nested = await Promise.all(roots.map(async (root) => {
    const files = await listSpecFiles(root.path);
    return files.map((file) => {
      const aliases = aliasesFor(file, root.path);
      return {
        name: aliases[1] ?? aliases[0]!,
        fileName: basename(file),
        aliases,
        specPath: file,
        workflowRoot: workflowRootFor(file, root.path),
        legacy: root.legacy,
      };
    });
  }));

  return nested.flat().sort((left, right) => {
    const byName = left.name.localeCompare(right.name);
    return byName !== 0 ? byName : left.specPath.localeCompare(right.specPath);
  });
}

function workflowRoots(cwd: string): WorkflowRoot[] {
  return uniqueWorkflowRoots([
    { path: resolve(cwd, ".pi", "workflows") },
    { path: resolve(cwd, "workflows") },
    { path: PACKAGE_WORKFLOW_ROOT },
    { path: join(homedir(), ".pi", "agent", "workflows") },
  ]);
}

function uniqueWorkflowRoots(roots: WorkflowRoot[]): WorkflowRoot[] {
  const seen = new Set<string>();
  const unique: WorkflowRoot[] = [];
  for (const root of roots) {
    const key = resolve(root.path);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(root);
  }
  return unique;
}

async function scoreWorkflow(workflow: WorkflowSpecRecord, query: string[]): Promise<WorkflowRecommendation> {
  const catalog = await readWorkflowCatalog(workflow.specPath);
  const haystacks = [workflow.name, workflow.fileName, ...workflow.aliases, ...(catalog.naturalLanguageTriggers ?? []), ...(catalog.useWhen ?? [])];
  const avoid = catalog.avoidWhen ?? [];
  const reasons: string[] = [];
  const cautions: string[] = [];
  let score = 0;

  for (const text of haystacks) {
    const tokens = new Set(tokenize(text));
    const matched = query.filter((token) => tokens.has(token));
    if (matched.length === 0) continue;
    const weight = catalog.naturalLanguageTriggers?.includes(text) ? 4 : catalog.useWhen?.includes(text) ? 3 : 1;
    score += matched.length * weight;
    if (reasons.length < 4) reasons.push(`matched "${text}" (${matched.join(", ")})`);
  }

  for (const text of avoid) {
    const tokens = new Set(tokenize(text));
    const matched = query.filter((token) => tokens.has(token));
    if (matched.length === 0) continue;
    score -= matched.length * 3;
    cautions.push(`avoidWhen matched "${text}" (${matched.join(", ")})`);
  }

  if (catalog.mutationRisk && query.includes("write") && catalog.mutationRisk.includes("read-only")) {
    cautions.push(`mutationRisk=${catalog.mutationRisk}`);
  }

  return { workflow, score, reasons, cautions, catalog };
}

async function readWorkflowCatalog(specPath: string): Promise<WorkflowCatalogMetadata> {
  if (!specPath.endsWith(".json")) return {};
  try {
    const parsed = JSON.parse(await readFile(specPath, "utf8")) as { catalog?: WorkflowCatalogMetadata };
    return parsed.catalog ?? {};
  } catch {
    return {};
  }
}

const RECOMMEND_STOP_WORDS = new Set(["a", "an", "and", "are", "as", "be", "do", "for", "in", "is", "it", "of", "or", "please", "the", "this", "to", "with"]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !RECOMMEND_STOP_WORDS.has(token));
}

async function findWorkflowCandidates(name: string, cwd: string): Promise<WorkflowCandidate[]> {
  const roots = workflowRoots(cwd);
  const nested = await Promise.all(roots.map(async (root) => {
    const files = await listSpecFiles(root.path);
    return files.flatMap((file) => aliasesFor(file, root.path).includes(name) ? [{ name, file, root: workflowRootFor(file, root.path) }] : []);
  }));
  return nested.flat().sort((left, right) => left.file.localeCompare(right.file));
}

async function listSpecFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const flatFiles = entries
    .filter((entry) => entry.isFile() && isSpecFileName(entry.name))
    .map((entry) => join(root, entry.name));

  const bundleSpecs = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && !isWorkflowRunDirName(entry.name))
    .map(async (entry) => {
      const bundleSpec = join(root, entry.name, "spec.json");
      return (await isFile(bundleSpec)) ? bundleSpec : null;
    }));

  return [...flatFiles, ...bundleSpecs.filter((spec): spec is string => spec !== null)];
}

// Run-state directories under .pi/workflows/ contain a spec.json snapshot of
// the workflow that produced them; they are records, not registrable bundles.
function isWorkflowRunDirName(name: string): boolean {
  return /^workflow_[a-z0-9]+_[a-f0-9]+$/.test(name);
}

function isBundleSpec(file: string, searchRoot: string): boolean {
  return basename(file) === "spec.json" && resolve(dirname(file)) !== resolve(searchRoot);
}

function aliasesFor(file: string, searchRoot: string): string[] {
  const name = basename(file);
  const extension = extname(name);
  if (isBundleSpec(file, searchRoot)) return [basename(dirname(file))];
  return [name, name.slice(0, -extension.length)];
}

function workflowRootFor(file: string, searchRoot: string): string {
  return isBundleSpec(file, searchRoot) ? dirname(file) : searchRoot;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isPathLike(ref: string): boolean {
  return isAbsolute(ref)
    || ref === "."
    || ref === ".."
    || ref.startsWith("./")
    || ref.startsWith("../")
    || ref.includes("/")
    || ref.includes("\\");
}

function validateWorkflowName(name: string): void {
  if (name.startsWith(".")) {
    throw new WorkflowValidationError([{ path: name, message: "workflow names may not start with dot" }]);
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new WorkflowValidationError([{ path: name, message: "workflow names may contain only letters, numbers, dot, underscore, and dash" }]);
  }
}
