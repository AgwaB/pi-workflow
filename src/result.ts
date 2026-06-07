import { readFile } from "node:fs/promises";

import { WorkflowTaskRunRecord } from "./types.js";
import {
  fromProjectPath,
  nowIso,
  setTaskTerminal,
  writeJsonAtomic,
} from "./store.js";

export interface TaskResultArtifact {
  resultFile: string;
  result: Record<string, unknown>;
  status: WorkflowTaskRunRecord["status"];
  completedAfterTimeout: boolean;
}

export async function readTaskResultArtifact(cwd: string, task: WorkflowTaskRunRecord): Promise<TaskResultArtifact | undefined> {
  const resultFile = fromProjectPath(cwd, task.files.result);
  const result = await readJsonLoose<Record<string, unknown>>(resultFile);
  const status = typeof result?.status === "string" ? normalizeTerminalTaskStatus(result.status) : undefined;
  if (!status || typeof result?.completedAt !== "string" || !canAcceptTerminalResult(task, result)) return undefined;

  return {
    resultFile,
    result,
    status,
    completedAfterTimeout: resultCompletedAfterTimeout(task, result.completedAt),
  };
}

export function isTaskTimedOut(task: WorkflowTaskRunRecord): boolean {
  if (!task.startedAt || !task.runtime.maxRuntimeMs) return false;
  return Date.now() - Date.parse(task.startedAt) > task.runtime.maxRuntimeMs;
}

export function markTaskTimedOut(task: WorkflowTaskRunRecord): void {
  setTaskTerminal(task, "failed", "timeout", {
    exitCode: 124,
    lastMessage: `task exceeded timeout=${task.runtime.maxRuntimeMs}`,
  });
}

export async function applyTaskResultArtifact(cwd: string, task: WorkflowTaskRunRecord, artifact: TaskResultArtifact): Promise<boolean> {
  const rawCompletedAt = typeof artifact.result.completedAt === "string" ? artifact.result.completedAt : undefined;
  const completedAt = rawCompletedAt && Number.isFinite(Date.parse(rawCompletedAt)) ? rawCompletedAt : nowIso();
  let nextStatus = artifact.status;
  let detail: string = artifact.status;
  let exitCode = typeof artifact.result.exitCode === "number" ? artifact.result.exitCode : undefined;
  let lastMessage = typeof artifact.result.errorMessage === "string" ? artifact.result.errorMessage : "completed";

  if (artifact.status === "completed" && task.output) {
    const validation = await validateTaskOutput(cwd, task);
    task.outputValidation = {
      format: task.output.format,
      status: validation.valid ? "valid" : task.output.onInvalid === "fail" ? "invalid" : "warning",
      message: validation.message,
      structured: validation.structuredOutput !== undefined,
    };

    const nextResult: Record<string, unknown> = {
      ...artifact.result,
      outputValidation: task.outputValidation,
    };
    if (validation.structuredOutput !== undefined) nextResult.structuredOutput = validation.structuredOutput;

    if (!validation.valid && task.output.onInvalid === "fail") {
      nextStatus = "failed";
      detail = "output_invalid";
      exitCode = 1;
      lastMessage = validation.message;
      nextResult.status = "failed";
      nextResult.exitCode = 1;
      nextResult.failureKind = "output_invalid";
      nextResult.errorMessage = validation.message;
    } else if (!validation.valid) {
      lastMessage = `completed with output warning: ${validation.message}`;
    }

    await writeJsonAtomic(artifact.resultFile, nextResult);
  }

  return setTaskTerminal(task, nextStatus, detail, {
    completedAt,
    exitCode,
    lastMessage,
  });
}

async function validateTaskOutput(cwd: string, task: WorkflowTaskRunRecord): Promise<{ valid: boolean; message: string; structuredOutput?: unknown }> {
  if (!task.output) return { valid: true, message: "no output contract" };
  if (task.output.format !== "json") return { valid: true, message: `${task.output.format} output accepted` };

  const text = await readFile(fromProjectPath(cwd, task.files.output), "utf8").catch(() => "");
  const trimmed = normalizeJsonOutputText(text);
  if (!trimmed) return { valid: false, message: "expected JSON output, got empty output" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { valid: false, message: `expected valid JSON output: ${message}` };
  }

  const requiredKeys = Array.isArray(task.output.requiredKeys) ? task.output.requiredKeys : [];
  if (requiredKeys.length > 0) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { valid: false, message: "expected top-level JSON object for requiredKeys validation", structuredOutput: parsed };
    }
    const object = parsed as Record<string, unknown>;
    const missing = requiredKeys.filter((key) => !Object.prototype.hasOwnProperty.call(object, key));
    if (missing.length > 0) return { valid: false, message: `JSON output missing required keys: ${missing.join(", ")}`, structuredOutput: parsed };
  }

  return { valid: true, message: "JSON output valid", structuredOutput: parsed };
}

function canAcceptTerminalResult(task: WorkflowTaskRunRecord, result: Record<string, unknown>): boolean {
  if (task.launchToken !== undefined) return typeof result.launchToken === "string" && result.launchToken === task.launchToken;
  return Boolean(task.paneId || task.pid);
}

function resultCompletedAfterTimeout(task: WorkflowTaskRunRecord, completedAt: string): boolean {
  if (!task.startedAt || !task.runtime.maxRuntimeMs) return false;
  const startedAtMs = Date.parse(task.startedAt);
  const completedAtMs = Date.parse(completedAt);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(completedAtMs)) return false;
  return completedAtMs - startedAtMs > task.runtime.maxRuntimeMs;
}

function normalizeJsonOutputText(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i);
  return fenced ? fenced[1]!.trim() : trimmed;
}

function normalizeTerminalTaskStatus(status: string): WorkflowTaskRunRecord["status"] | undefined {
  if (status === "completed" || status === "failed" || status === "interrupted" || status === "blocked" || status === "skipped") return status;
  return undefined;
}

async function readJsonLoose<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}
