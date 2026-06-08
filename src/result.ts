import { copyFile, readFile } from "node:fs/promises";

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

    if (!validation.valid && task.output.onInvalid === "fail") {
      const attempts = (task.outputRetry?.attempts ?? 0) + 1;
      await copyFile(fromProjectPath(cwd, task.files.output), `${fromProjectPath(cwd, task.files.output)}.invalid-attempt-${attempts}`).catch(() => undefined);
      await copyFile(artifact.resultFile, `${artifact.resultFile}.invalid-attempt-${attempts}`).catch(() => undefined);
      task.status = "pending";
      task.statusDetail = "retry_output_invalid";
      task.startedAt = undefined;
      task.completedAt = undefined;
      task.exitCode = undefined;
      task.paneId = undefined;
      task.pid = undefined;
      task.launchToken = undefined;
      task.outputRetry = { attempts, maxAttempts: 1, reason: "output_invalid", message: validation.message, requiredKeys: task.output.requiredKeys ?? [] };
      return true;
    }
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

  const requiredKeys = Array.isArray(task.output.requiredKeys) ? task.output.requiredKeys : [];
  const parsed = parseJsonOutput(trimmed, requiredKeys);
  if (!parsed.valid) {
    return { valid: false, message: `expected valid JSON output: ${parsed.message ?? "invalid JSON"}`, structuredOutput: parsed.structuredOutput };
  }

  return { valid: true, message: "JSON output valid", structuredOutput: parsed.structuredOutput };
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

export function extractJsonOutput(output: string): { text: string; extracted: boolean } {
  const trimmed = output.trim();
  const fence = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/i);
  if (fence) return { text: fence[1]!.trim(), extracted: false };
  try { JSON.parse(trimmed); return { text: trimmed, extracted: false }; } catch {}
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return { text: trimmed.slice(start, end + 1), extracted: true };
  return { text: trimmed, extracted: false };
}

export function parseJsonOutput(output: string, requiredKeys: string[] = []): { valid: boolean; extracted: boolean; structuredOutput?: unknown; message?: string } {
  const candidates = collectJsonObjectCandidates(output);
  const ordered = candidates.length > 0 ? candidates : [extractJsonOutput(output).text];
  let lastError = "invalid JSON";
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const text = ordered[index]!;
    try {
      const parsed = JSON.parse(text);
      if (requiredKeys.length && (!parsed || typeof parsed !== "object" || Array.isArray(parsed))) continue;
      const missing = requiredKeys.filter((key) => !Object.prototype.hasOwnProperty.call(parsed as Record<string, unknown>, key));
      if (missing.length > 0) continue;
      return { valid: true, extracted: output.trim() !== text.trim(), structuredOutput: parsed };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { valid: false, extracted: true, message: lastError };
}

function collectJsonObjectCandidates(output: string): string[] {
  const candidates: string[] = [];
  for (let start = output.indexOf("{"); start !== -1; start = output.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < output.length; index += 1) {
      const ch = output[index]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          candidates.push(output.slice(start, index + 1));
          break;
        }
      }
    }
  }
  return candidates;
}

export function buildJsonOutputRetryInstructions(task: Pick<WorkflowTaskRunRecord, "output" | "outputRetry">): string {
  const keys = task.output?.requiredKeys ?? task.outputRetry?.requiredKeys ?? [];
  return [
    `Validation error: ${task.outputRetry?.message ?? "invalid JSON output"}`,
    "Return only valid JSON. JSON.parse(finalAnswer) would succeed.",
    "Invalid JSON: {\"item\": true",
    `Valid shape: {${keys.map((key) => `\"${key}\": {}`).join(",")}}`,
  ].join("\n");
}
