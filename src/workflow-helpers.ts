import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { WorkflowValidationError } from "./types.js";

export interface WorkflowHelperContext {
  specPath: string;
  originalSpecPath?: string;
  workflowRoot?: string;
  stageId?: string;
  taskId?: string;
  runId?: string;
  cwd: string;
}

export interface WorkflowHelperInput {
  sources: Record<string, unknown>;
  options?: Record<string, unknown>;
  context: WorkflowHelperContext;
}

export type WorkflowHelper = (input: WorkflowHelperInput) => unknown | Promise<unknown>;

export interface ResolvedWorkflowHelper {
  ref: string;
  path: string;
}

export async function resolveWorkflowHelperRef(
  ref: string,
  specPath: string,
  options: { label?: string } = {},
): Promise<ResolvedWorkflowHelper> {
  const label = options.label ?? "helper";
  const issues = validateHelperRef(ref, label);
  if (issues.length > 0) throw new WorkflowValidationError(issues);

  const specDirectory = await realpath(resolve(specPath, ".."));
  const candidate = resolve(specDirectory, ref);
  const candidateRealpath = await realpath(candidate).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new WorkflowValidationError([{ path: ref, message: `${label} file not found` }]);
    }
    throw error;
  });

  if (!isPathInside(candidateRealpath, specDirectory)) {
    throw new WorkflowValidationError([{ path: ref, message: `${label} path must stay inside the workflow directory` }]);
  }
  if (!candidateRealpath.endsWith(".mjs")) {
    throw new WorkflowValidationError([{ path: ref, message: `${label} must be a relative .mjs file` }]);
  }
  if (!(await stat(candidateRealpath)).isFile()) {
    throw new WorkflowValidationError([{ path: ref, message: `${label} must be a file` }]);
  }

  return { ref, path: candidateRealpath };
}

export async function loadWorkflowHelper(ref: string, specPath: string): Promise<WorkflowHelper> {
  const resolved = await resolveWorkflowHelperRef(ref, specPath);
  const imported = await import(pathToFileURL(resolved.path).href);
  if (typeof imported.default !== "function") {
    throw new WorkflowValidationError([{ path: ref, message: "helper must default-export a function" }]);
  }
  return imported.default as WorkflowHelper;
}

function validateHelperRef(ref: string, label = "helper"): Array<{ path: string; message: string }> {
  const issues: Array<{ path: string; message: string }> = [];
  if (typeof ref !== "string" || ref.trim() === "") {
    return [{ path: "$helper", message: `${label} must be a non-empty string` }];
  }
  if (!ref.startsWith("./")) {
    issues.push({ path: ref, message: `${label} must be a directory-local relative path starting with ./` });
  }
  if (isAbsolute(ref) || ref.startsWith("~/") || ref.includes("://") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(ref)) {
    issues.push({ path: ref, message: `${label} must not be absolute, home-relative, or protocol-based` });
  }
  if (ref.split(/[\\/]+/).includes("..")) {
    issues.push({ path: ref, message: `${label} must not contain parent-directory segments` });
  }
  if (!ref.endsWith(".mjs")) {
    issues.push({ path: ref, message: `${label} must be a relative .mjs file` });
  }
  return issues;
}

function isPathInside(child: string, parent: string): boolean {
  const normalizedParent = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return child === parent || child.startsWith(normalizedParent);
}
