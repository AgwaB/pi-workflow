import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FlowValidationError } from "./types.js";

const SPEC_EXTENSIONS = new Set([".json", ".yaml", ".yml"]);
const PACKAGE_RECIPE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "flows");

export interface ResolvedFlowSpecRef {
  inputRef: string;
  specPath: string;
  recipeName?: string;
  recipeRoot?: string;
}

export interface FlowRecipeRecord {
  name: string;
  fileName: string;
  aliases: string[];
  specPath: string;
  recipeRoot: string;
}

interface RecipeCandidate {
  name: string;
  file: string;
  root: string;
}

export async function resolveFlowSpecRef(ref: string, cwd: string): Promise<ResolvedFlowSpecRef> {
  const trimmed = ref.trim();
  if (trimmed === "") {
    throw new FlowValidationError([{ path: "$spec", message: "spec path or recipe name is required" }]);
  }

  const pathCandidate = resolve(cwd, trimmed);
  if (await isFile(pathCandidate)) {
    return { inputRef: ref, specPath: pathCandidate };
  }

  if (isPathLike(trimmed)) {
    throw new FlowValidationError([{ path: trimmed, message: "spec file not found" }]);
  }

  validateRecipeName(trimmed);
  const matches = await findRecipeCandidates(trimmed, cwd);
  if (matches.length === 0) {
    throw new FlowValidationError([{ path: trimmed, message: "spec file or exact recipe not found" }]);
  }
  if (matches.length > 1) {
    throw new FlowValidationError([{
      path: trimmed,
      message: `ambiguous recipe name; matches: ${matches.map((match) => relative(cwd, match.file) || match.file).join(", ")}`,
    }]);
  }

  const [match] = matches;
  return {
    inputRef: ref,
    specPath: match!.file,
    recipeName: match!.name,
    recipeRoot: match!.root,
  };
}

export function isSpecFileName(fileName: string): boolean {
  return SPEC_EXTENSIONS.has(extname(fileName).toLowerCase());
}

export async function listFlowRecipes(cwd: string): Promise<FlowRecipeRecord[]> {
  const roots = recipeRoots(cwd);
  const nested = await Promise.all(roots.map(async (root) => {
    const files = await listSpecFiles(root);
    return files.map((file) => {
      const aliases = aliasesFor(file);
      return {
        name: aliases[1] ?? aliases[0]!,
        fileName: basename(file),
        aliases,
        specPath: file,
        recipeRoot: root,
      };
    });
  }));

  return nested.flat().sort((left, right) => {
    const byName = left.name.localeCompare(right.name);
    return byName !== 0 ? byName : left.specPath.localeCompare(right.specPath);
  });
}

function recipeRoots(cwd: string): string[] {
  return uniquePaths([
    resolve(cwd, ".pi", "flow-recipes"),
    resolve(cwd, "flows"),
    PACKAGE_RECIPE_ROOT,
    join(homedir(), ".pi", "agent", "flow-recipes"),
  ]);
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const path of paths) {
    const key = resolve(path);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(path);
  }
  return unique;
}

async function findRecipeCandidates(name: string, cwd: string): Promise<RecipeCandidate[]> {
  const roots = recipeRoots(cwd);
  const nested = await Promise.all(roots.map(async (root) => {
    const files = await listSpecFiles(root);
    return files.flatMap((file) => aliasesFor(file).includes(name) ? [{ name, file, root }] : []);
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

  return entries
    .filter((entry) => entry.isFile() && isSpecFileName(entry.name))
    .map((entry) => join(root, entry.name));
}

function aliasesFor(file: string): string[] {
  const name = basename(file);
  const extension = extname(name);
  return [name, name.slice(0, -extension.length)];
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

function validateRecipeName(name: string): void {
  if (name.startsWith(".")) {
    throw new FlowValidationError([{ path: name, message: "recipe names may not start with dot" }]);
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new FlowValidationError([{ path: name, message: "recipe names may contain only letters, numbers, dot, underscore, and dash" }]);
  }
}
