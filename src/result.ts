import { copyFile, readFile } from "node:fs/promises";

import type { WorkflowTaskRunRecord } from "./types.js";
import {
	formatOutputTemplateSection,
	validateStructuredContract,
} from "./workflow-artifacts.js";
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

export async function readTaskResultArtifact(
	cwd: string,
	task: WorkflowTaskRunRecord,
): Promise<TaskResultArtifact | undefined> {
	const resultFile = fromProjectPath(cwd, task.files.result);
	const result = await readJsonLoose<Record<string, unknown>>(resultFile);
	const status =
		typeof result?.status === "string"
			? normalizeTerminalTaskStatus(result.status)
			: undefined;
	if (
		!status ||
		typeof result?.completedAt !== "string" ||
		!canAcceptTerminalResult(task, result)
	)
		return undefined;

	return {
		resultFile,
		result,
		status,
		completedAfterTimeout: resultCompletedAfterTimeout(
			task,
			result.completedAt,
		),
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

export async function applyTaskResultArtifact(
	cwd: string,
	task: WorkflowTaskRunRecord,
	artifact: TaskResultArtifact,
): Promise<boolean> {
	const rawCompletedAt =
		typeof artifact.result.completedAt === "string"
			? artifact.result.completedAt
			: undefined;
	const completedAt =
		rawCompletedAt && Number.isFinite(Date.parse(rawCompletedAt))
			? rawCompletedAt
			: nowIso();
	let nextStatus = artifact.status;
	let detail: string = artifact.status;
	let exitCode =
		typeof artifact.result.exitCode === "number"
			? artifact.result.exitCode
			: undefined;
	let lastMessage =
		typeof artifact.result.errorMessage === "string"
			? artifact.result.errorMessage
			: "completed";

	const shouldValidateOutput =
		task.output &&
		(artifact.status === "completed" || isOutputSalvageCandidate(artifact));
	const validation = shouldValidateOutput
		? await validateTaskOutput(cwd, task)
		: undefined;
	let nextResult: Record<string, unknown> | undefined;

	if (task.output && validation) {
		task.outputValidation = {
			format: task.output.format,
			status: validation.valid
				? "valid"
				: task.output.onInvalid === "fail"
					? "invalid"
					: "warning",
			message: validation.message,
			structured: validation.structuredOutput !== undefined,
		};

		nextResult = {
			...artifact.result,
			outputValidation: task.outputValidation,
		};
		if (validation.structuredOutput !== undefined)
			nextResult.structuredOutput = validation.structuredOutput;

		if (
			artifact.status !== "completed" &&
			isOutputSalvageCandidate(artifact) &&
			validation.valid
		) {
			const originalFailureKind =
				typeof artifact.result.failureKind === "string"
					? artifact.result.failureKind
					: undefined;
			nextResult.status = "completed";
			nextResult.exitCode = 0;
			nextResult.outputSalvaged = true;
			nextResult.salvagedFrom = {
				status: artifact.status,
				failureKind: originalFailureKind ?? null,
				exitCode:
					typeof artifact.result.exitCode === "number"
						? artifact.result.exitCode
						: null,
			};
			nextResult.failureKind = "timeout_output_salvaged";
			nextResult.errorMessage = undefined;
			await writeJsonAtomic(artifact.resultFile, nextResult);
			return setTaskTerminal(task, "completed", "timeout_output_salvaged", {
				completedAt,
				exitCode: 0,
				lastMessage: `completed using valid output after ${originalFailureKind ?? artifact.status}: ${validation.message}`,
			});
		}

		if (artifact.status === "completed") {
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

			if (!validation.valid && task.output.onInvalid === "fail") {
				const attempts = (task.outputRetry?.attempts ?? 0) + 1;
				const maxAttempts = task.outputRetry?.maxAttempts ?? 1;
				const exhausted = attempts > maxAttempts;
				nextResult.failureKind = exhausted
					? "output_invalid_exhausted"
					: "output_invalid";
				nextResult.errorMessage = exhausted
					? `output invalid after ${maxAttempts} retry attempt${maxAttempts === 1 ? "" : "s"}: ${validation.message}`
					: validation.message;
				await writeJsonAtomic(artifact.resultFile, nextResult);
				await copyFile(
					fromProjectPath(cwd, task.files.output),
					`${fromProjectPath(cwd, task.files.output)}.invalid-attempt-${attempts}`,
				).catch(() => undefined);
				await copyFile(
					artifact.resultFile,
					`${artifact.resultFile}.invalid-attempt-${attempts}`,
				).catch(() => undefined);
				task.startedAt = undefined;
				task.completedAt = undefined;
				task.exitCode = undefined;
				task.pid = undefined;
				task.launchToken = undefined;
				task.backendHandle = undefined;
				task.backendFiles = undefined;
				task.outputRetry = {
					attempts,
					maxAttempts,
					reason: exhausted ? "output_invalid_exhausted" : "output_invalid",
					message: validation.message,
				};
				if (exhausted) {
					return setTaskTerminal(task, "failed", "output_invalid_exhausted", {
						exitCode: 1,
						lastMessage: String(nextResult.errorMessage),
					});
				}
				task.status = "pending";
				task.statusDetail = "retry_output_invalid";
				return true;
			}

			await writeJsonAtomic(artifact.resultFile, nextResult);
		} else {
			await writeJsonAtomic(artifact.resultFile, nextResult);
		}
	}

	if (artifact.completedAfterTimeout && nextStatus !== "completed") {
		markTaskTimedOut(task);
		return true;
	}

	return setTaskTerminal(task, nextStatus, detail, {
		completedAt,
		exitCode,
		lastMessage,
	});
}

function isOutputSalvageCandidate(artifact: TaskResultArtifact): boolean {
	if (artifact.status !== "failed") return false;
	const failureKind =
		typeof artifact.result.failureKind === "string"
			? artifact.result.failureKind
			: undefined;
	return failureKind === "timeout" || artifact.completedAfterTimeout;
}

async function validateTaskOutput(
	cwd: string,
	task: WorkflowTaskRunRecord,
): Promise<{ valid: boolean; message: string; structuredOutput?: unknown }> {
	if (!task.output) return { valid: true, message: "no output contract" };
	if (task.output.format !== "json")
		return { valid: true, message: `${task.output.format} output accepted` };

	const text = await readFile(
		fromProjectPath(cwd, task.files.output),
		"utf8",
	).catch(() => "");
	const trimmed = normalizeJsonOutputText(text);
	if (!trimmed)
		return { valid: false, message: "expected JSON output, got empty output" };

	const selectorPaths = task.output.contract?.requiredPaths ?? [];
	const parsed = parseJsonOutput(trimmed, selectorPaths);
	if (!parsed.valid) {
		return {
			valid: false,
			message: `expected valid JSON output: ${parsed.message ?? "invalid JSON"}`,
			structuredOutput: parsed.structuredOutput,
		};
	}

	if (task.output.contract) {
		const contract = validateStructuredContract(
			parsed.structuredOutput,
			task.output.contract,
		);
		if (!contract.valid) {
			return {
				valid: false,
				message: `structured output contract failed: ${contract.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`,
				structuredOutput: parsed.structuredOutput,
			};
		}
	}

	return {
		valid: true,
		message: "JSON output valid",
		structuredOutput: parsed.structuredOutput,
	};
}

function canAcceptTerminalResult(
	task: WorkflowTaskRunRecord,
	result: Record<string, unknown>,
): boolean {
	if (task.launchToken !== undefined)
		return (
			typeof result.launchToken === "string" &&
			result.launchToken === task.launchToken
		);
	return Boolean(task.pid || task.backendHandle);
}

function resultCompletedAfterTimeout(
	task: WorkflowTaskRunRecord,
	completedAt: string,
): boolean {
	if (!task.startedAt || !task.runtime.maxRuntimeMs) return false;
	const startedAtMs = Date.parse(task.startedAt);
	const completedAtMs = Date.parse(completedAt);
	if (!Number.isFinite(startedAtMs) || !Number.isFinite(completedAtMs))
		return false;
	return completedAtMs - startedAtMs > task.runtime.maxRuntimeMs;
}

function normalizeJsonOutputText(text: string): string {
	const trimmed = text.trim();
	const fenced = trimmed.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i);
	return fenced ? fenced[1]!.trim() : trimmed;
}

function normalizeTerminalTaskStatus(
	status: string,
): WorkflowTaskRunRecord["status"] | undefined {
	if (
		status === "completed" ||
		status === "failed" ||
		status === "interrupted" ||
		status === "blocked" ||
		status === "skipped"
	)
		return status;
	return undefined;
}

async function readJsonLoose<T>(file: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}

export function extractJsonOutput(output: string): {
	text: string;
	extracted: boolean;
} {
	const trimmed = output.trim();
	const fence = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/i);
	if (fence) return { text: fence[1]!.trim(), extracted: false };
	try {
		JSON.parse(trimmed);
		return { text: trimmed, extracted: false };
	} catch {
		// Fall through to extracting the outermost JSON object from mixed output.
	}
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start >= 0 && end > start)
		return { text: trimmed.slice(start, end + 1), extracted: true };
	return { text: trimmed, extracted: false };
}

export function parseJsonOutput(
	output: string,
	selectorPaths: string[] = [],
): {
	valid: boolean;
	extracted: boolean;
	structuredOutput?: unknown;
	message?: string;
} {
	const candidates = collectJsonObjectCandidates(output);
	const ordered =
		candidates.length > 0 ? candidates : [extractJsonOutput(output).text];
	let lastError = "invalid JSON";
	let fallback: { text: string; parsed: unknown } | undefined;
	for (let index = ordered.length - 1; index >= 0; index -= 1) {
		const text = ordered[index]!;
		try {
			const parsed = JSON.parse(text);
			fallback ??= { text, parsed };
			if (
				selectorPaths.length > 0 &&
				!selectorPaths.every((path) => jsonPathExists(parsed, path))
			)
				continue;
			return {
				valid: true,
				extracted: output.trim() !== text.trim(),
				structuredOutput: parsed,
			};
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
	}
	if (fallback)
		return {
			valid: true,
			extracted: output.trim() !== fallback.text.trim(),
			structuredOutput: fallback.parsed,
		};
	return { valid: false, extracted: true, message: lastError };
}

function jsonPathExists(value: unknown, path: string): boolean {
	if (!path.startsWith("$")) return false;
	const pattern = /\.([A-Za-z_][A-Za-z0-9_-]*)|\[(\d+)\]/g;
	let current = value;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(path)) !== null) {
		if (match[1] !== undefined) {
			const key = match[1];
			if (
				!current ||
				typeof current !== "object" ||
				Array.isArray(current) ||
				!Object.hasOwn(current, key)
			)
				return false;
			current = (current as Record<string, unknown>)[key];
			continue;
		}
		const index = Number(match[2]);
		if (!Array.isArray(current) || index < 0 || index >= current.length)
			return false;
		current = current[index];
	}
	return true;
}

function collectJsonObjectCandidates(output: string): string[] {
	const candidates: string[] = [];
	for (
		let start = output.indexOf("{");
		start !== -1;
		start = output.indexOf("{", start + 1)
	) {
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

export function buildJsonOutputRetryInstructions(
	task: Pick<WorkflowTaskRunRecord, "output" | "outputRetry">,
): string {
	const template = formatOutputTemplateSection(task.output);
	const requiredPaths = task.output?.contract?.requiredPaths;
	return [
		`Validation error: ${task.outputRetry?.message ?? "invalid JSON output"}`,
		"Return only valid JSON. JSON.parse(finalAnswer) would succeed.",
		'Invalid JSON: {"item": true',
		requiredPaths && requiredPaths.length > 0
			? `Required JSON paths: ${requiredPaths.join(", ")}`
			: undefined,
		template,
	]
		.filter(Boolean)
		.join("\n");
}
