import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { discoverAgents } from "./agents.js";
import { compileWorkflow } from "./compiler.js";
import {
	formatLogs,
	formatRunDetails,
	formatRunStatus,
	formatStatus,
	resumeRun,
	resumeSupervisors,
	runWorkflowSpec,
	waitForRun,
	formatRun,
} from "./engine.js";
import { WORKFLOW_COMMAND, WORKFLOW_HELP } from "./index.js";
import {
	assertWorkflowActionAllowedForRole,
	isWorkflowSupervisorEnabled,
} from "./process-role.js";
import { readIndex } from "./store.js";
import { loadWorkflowSpec } from "./schema.js";
import { listWorkflows, resolveWorkflowRef } from "./workflow-specs.js";
import {
	THINKING_LEVELS,
	type CompiledWorkflow,
	type ThinkingLevel,
	WorkflowValidationError,
} from "./types.js";

const UNFINISHED_RUN_NOTICE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const UNFINISHED_RUN_NOTICE_MAX_RUNS = 5;

export default function workflowExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (!isWorkflowSupervisorEnabled()) return;
		await resumeSupervisors(ctx.cwd).catch(() => undefined);
		await notifyUnfinishedRuns(ctx.cwd, (message, type) =>
			ctx.ui.notify(message, type),
		).catch(() => undefined);
	});

	pi.registerCommand(WORKFLOW_COMMAND, {
		description: "Run and inspect workflow-defined Pi subagent runs",
		getArgumentCompletions(prefix) {
			return workflowArgumentCompletions(prefix) ?? null;
		},
		handler: async (args, ctx) => {
			await handleWorkflowCommand(args, ctx);
		},
	});
}

function spawnDetachedSupervisor(
	cwd: string,
	runId: string,
): { pid: number | undefined; logPath: string } {
	const cliPath = fileURLToPath(new URL("./cli.mjs", import.meta.url));
	const logPath = join(cwd, ".pi", "workflows", runId, "supervise.log");
	const fd = openSync(logPath, "a");
	try {
		const child = spawn(process.execPath, [cliPath, "supervise", runId], {
			cwd,
			detached: true,
			stdio: ["ignore", fd, fd],
		});
		child.unref();
		return { pid: child.pid, logPath };
	} finally {
		closeSync(fd);
	}
}

export async function notifyUnfinishedRuns(
	cwd: string,
	notify: (message: string, type?: "info" | "warning" | "error") => void,
	nowMs: number = Date.now(),
): Promise<void> {
	const index = await readIndex(cwd);
	if (!index?.runs?.length) return;
	const unfinished = index.runs.filter((run) => {
		if (run.parentRunId) return false;
		if (run.status !== "failed" && run.status !== "interrupted") return false;
		const updatedAtMs = Date.parse(run.updatedAt ?? "");
		return (
			Number.isFinite(updatedAtMs) &&
			nowMs - updatedAtMs <= UNFINISHED_RUN_NOTICE_MAX_AGE_MS
		);
	});
	if (unfinished.length === 0) return;

	const lines = unfinished
		.slice(0, UNFINISHED_RUN_NOTICE_MAX_RUNS)
		.map((run) => {
			const summary = run.taskSummary;
			const counts = summary
				? ` (${summary.completed}/${summary.total} tasks completed, ${summary.failed} failed, ${summary.interrupted} interrupted)`
				: "";
			return `- ${run.name ?? "(unnamed)"} ${run.runId}: ${run.status}${counts} — /workflow resume ${run.runId}`;
		});
	if (unfinished.length > UNFINISHED_RUN_NOTICE_MAX_RUNS)
		lines.push(
			`- … and ${unfinished.length - UNFINISHED_RUN_NOTICE_MAX_RUNS} more (/workflow status)`,
		);
	notify(
		[
			`Unfinished workflow run${unfinished.length > 1 ? "s" : ""} in this project:`,
			...lines,
		].join("\n"),
		"warning",
	);
}

async function handleWorkflowCommand(
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const tokens = splitArgs(args);
	const action = tokens[0] ?? "help";

	try {
		assertWorkflowActionAllowedForRole(action);
		if (action === "help" || action === "--help" || action === "-h") {
			emit(ctx, WORKFLOW_HELP, "info");
			return;
		}

		if (action === "validate") {
			const specPath = requireArg(
				tokens,
				1,
				"/workflow validate <workflow-name-or-path>",
			);
			const loaded = await loadAndCompile(specPath, ctx.cwd);
			emit(ctx, formatValidationSummary(loaded, ctx.cwd), "info");
			return;
		}

		if (action === "roles") {
			const specPath = requireArg(
				tokens,
				1,
				"/workflow roles <workflow-name-or-path>",
			);
			const loaded = await loadAndCompile(specPath, ctx.cwd);
			emit(
				ctx,
				`${formatResolvedSpec(loaded.loaded, ctx.cwd)}\n\n${formatRoles(loaded.compiled)}`,
				"info",
			);
			return;
		}

		if (action === "agents") {
			const registry = await discoverAgents(ctx.cwd);
			emit(ctx, formatAgents(registry.agents), "info");
			return;
		}

		if (action === "list") {
			const workflows = await listWorkflows(ctx.cwd);
			emit(
				ctx,
				workflows.length === 0
					? "No workflows found."
					: workflows
							.map(
								(workflow) =>
									`${workflow.name}\t${toDisplayPath(workflow.specPath, ctx.cwd)}`,
							)
							.join("\n"),
				"info",
			);
			return;
		}

		if (action === "run") {
			const parsed = parseWorkflowRunArgs(args);
			const specPath =
				parsed.specPath ||
				requireArg(tokens, 1, '/workflow run <workflow-name-or-path> "<task>"');
			if (!parsed.task.trim())
				throw new Error(
					'This workflow needs a task. Usage: /workflow run <workflow-name-or-path> "<task>"',
				);
			const run = await runWorkflowSpec(specPath, ctx.cwd, {
				task: parsed.task,
				runtimeDefaults:
					parsed.model || parsed.thinking
						? { model: parsed.model, thinking: parsed.thinking }
						: undefined,
			});
			const verb =
				run.status === "blocked"
					? "created but blocked"
					: run.status === "failed"
						? "created but failed to launch"
						: "started";
			let detachNote = "";
			if (parsed.detach && run.status === "running") {
				const supervisor = spawnDetachedSupervisor(ctx.cwd, run.runId);
				detachNote = `\nDetached supervisor pid ${supervisor.pid ?? "?"} — survives this session; log: ${toDisplayPath(supervisor.logPath, ctx.cwd)}`;
			}
			emit(
				ctx,
				`Workflow run ${run.runId} ${verb}.\nSpec: ${toDisplayPath(run.specPath, ctx.cwd)}\n${formatRun(run)}${detachNote}`,
				run.status === "failed"
					? "error"
					: run.status === "blocked"
						? "warning"
						: "info",
			);
			return;
		}

		if (action === "status") {
			const text = tokens[1]
				? await formatRunStatus(ctx.cwd, tokens[1])
				: await formatStatus(ctx.cwd);
			emit(ctx, text, "info");
			return;
		}

		if (action === "show") {
			const ref = requireArg(
				tokens,
				1,
				"/workflow show <run-id-or-workflow-name>",
			);
			if (ref.startsWith("workflow_")) {
				emit(ctx, await formatRunDetails(ctx.cwd, ref), "info");
			} else {
				const resolved = await resolveWorkflowRef(ref, ctx.cwd);
				emit(ctx, await readFile(resolved.specPath, "utf8"), "info");
			}
			return;
		}

		if (action === "logs") {
			const runId = requireArg(
				tokens,
				1,
				"/workflow logs <run-id> [task-id] [lines]",
			);
			const taskId = tokens[2] ?? "task-1";
			const lineText = tokens[3];
			emit(
				ctx,
				await formatLogs(
					ctx.cwd,
					runId,
					taskId,
					lineText ? Number(lineText) : undefined,
				),
				"info",
			);
			return;
		}

		if (action === "wait") {
			const runId = requireArg(
				tokens,
				1,
				"/workflow wait <run-id> [timeout-ms]",
			);
			const run = await waitForRun(
				ctx.cwd,
				runId,
				tokens[2] ? Number(tokens[2]) : undefined,
			);
			emit(
				ctx,
				formatRun(run, "full"),
				run.status === "completed"
					? "info"
					: run.status === "blocked"
						? "warning"
						: "error",
			);
			return;
		}

		if (action === "resume") {
			const runId = requireArg(tokens, 1, "/workflow resume <run-id>");
			const { run, resetTaskIds } = await resumeRun(ctx.cwd, runId);
			emit(
				ctx,
				[
					`Reset ${resetTaskIds.length} task(s) to pending: ${resetTaskIds.join(", ")}`,
					formatRun(run, "full"),
				].join("\n"),
				"info",
			);
			return;
		}

		throw new Error(
			`Unknown /workflow action "${action}". Try /workflow help.`,
		);
	} catch (error) {
		emit(ctx, formatError(error), "error");
		if (!ctx.hasUI) process.exitCode = 1;
	}
}

async function loadAndCompile(
	specPath: string,
	cwd: string,
): Promise<{
	loaded: Awaited<ReturnType<typeof loadWorkflowSpec>>;
	compiled: CompiledWorkflow;
}> {
	const loaded = await loadWorkflowSpec(specPath, cwd);
	return {
		loaded,
		compiled: await compileWorkflow(loaded.spec, {
			cwd,
			specPath: loaded.specPath,
		}),
	};
}

function formatValidationSummary(
	result: {
		loaded: Awaited<ReturnType<typeof loadWorkflowSpec>>;
		compiled: CompiledWorkflow;
	},
	cwd: string,
): string {
	const { loaded, compiled } = result;
	const blocked = compiled.tasks.filter(
		(task) => task.safety.permission.status === "blocked",
	);
	const lines = [
		`Workflow spec valid: ${compiled.name ?? "(unnamed)"}`,
		formatResolvedSpec(loaded, cwd),
		`Type: ${compiled.type}`,
		`Backend: ${compiled.backend.type}/${compiled.backend.mode}`,
		`Tasks: ${compiled.tasks.length}`,
		`Roles: ${compiled.roles.length}`,
		`Max concurrency: ${compiled.maxConcurrency}`,
	];

	if (blocked.length > 0) {
		lines.push("Blocked permission previews:");
		for (const task of blocked) {
			lines.push(
				`- ${task.id}: blocked/${task.safety.permission.statusDetail} — ${task.safety.permission.reason ?? "needs attention"}`,
			);
		}
	}

	if (compiled.warnings.length > 0) {
		lines.push("Warnings:");
		for (const warning of compiled.warnings) lines.push(`- ${warning}`);
	}

	return lines.join("\n");
}

function formatResolvedSpec(
	loaded: Awaited<ReturnType<typeof loadWorkflowSpec>>,
	cwd: string,
): string {
	const workflow = loaded.workflowName
		? ` (workflow: ${loaded.workflowName})`
		: "";
	return `Spec: ${toDisplayPath(loaded.specPath, cwd)}${workflow}`;
}

function toDisplayPath(path: string, cwd: string): string {
	const display = relative(cwd, path);
	if (display === "") return path;
	return display.startsWith("..") ? path : display;
}

function formatRoles(compiled: CompiledWorkflow): string {
	if (compiled.roles.length === 0) return "No roles compiled.";

	return compiled.roles
		.map((role) => {
			const lines = [
				`# Role: ${role.name}`,
				role.fromAgent ? `fromAgent: ${role.fromAgent}` : undefined,
				role.sourcePath ? `sourcePath: ${role.sourcePath}` : undefined,
				`includedSections: ${role.includedSections.join(", ")}`,
				`excludedSections: ${role.excludedSections.join(", ")}`,
				role.truncated
					? `truncated: true (maxChars=${role.maxChars})`
					: `truncated: false (maxChars=${role.maxChars})`,
				"",
				role.content || "(empty role content)",
			].filter((line): line is string => line !== undefined);

			return lines.join("\n");
		})
		.join("\n\n---\n\n");
}

function formatAgents(
	agents: Awaited<ReturnType<typeof discoverAgents>>["agents"],
): string {
	if (agents.length === 0) return "No Pi agents found.";

	return agents
		.map((agent) => {
			const runtime =
				[
					agent.model ? `model=${agent.model}` : undefined,
					agent.thinking ? `thinking=${agent.thinking}` : undefined,
					agent.fast ? `fast=${agent.fast}` : undefined,
				]
					.filter(Boolean)
					.join(" ") || "runtime=(Pi default)";

			return [
				agent.displayName,
				agent.description ? `  ${agent.description}` : undefined,
				`  ${runtime}`,
				`  tools=${agent.tools?.join(",") ?? "(Pi default)"}`,
				`  source=${agent.sourcePath}`,
			]
				.filter((line): line is string => line !== undefined)
				.join("\n");
		})
		.join("\n\n");
}

function formatError(error: unknown): string {
	if (error instanceof WorkflowValidationError) {
		return `Workflow validation failed:\n${error.issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n")}`;
	}
	return error instanceof Error ? error.message : String(error);
}

function emit(
	ctx: ExtensionCommandContext,
	text: string,
	level: "info" | "warning" | "error",
): void {
	const printMode =
		process.argv.includes("--print") || process.argv.includes("-p");
	if (ctx.hasUI && !printMode) {
		ctx.ui.notify(text, level);
		return;
	}

	const stream = level === "error" ? process.stderr : process.stdout;
	stream.write(`${text}\n`);
}

export function parseWorkflowRunArgs(args: string): {
	specPath: string;
	task: string;
	detach: boolean;
	model?: string;
	thinking?: ThinkingLevel;
} {
	const parsed: {
		detach: boolean;
		model?: string;
		thinking?: ThinkingLevel;
	} = { detach: false };
	const trimmed = args.trim();
	let withoutRun = trimmed.startsWith("run ") ? trimmed.slice(4) : trimmed;
	withoutRun = consumeLeadingRunOptions(withoutRun, parsed);
	withoutRun = consumeTrailingRunOptions(withoutRun, parsed);

	const match = withoutRun.match(/^(\S+)\s+([\s\S]*)$/);
	if (!match) return { specPath: withoutRun, task: "", ...parsed };
	let task = match[2] ?? "";
	const quoted = task.match(/^"([\s\S]*)"$/);
	if (quoted) task = quoted[1] ?? "";
	return { specPath: match[1] ?? "", task, ...parsed };
}

function consumeLeadingRunOptions(
	input: string,
	parsed: { detach: boolean; model?: string; thinking?: ThinkingLevel },
): string {
	let rest = input.trim();
	while (true) {
		const next = consumeSingleLeadingRunOption(rest, parsed);
		if (next === rest) return rest;
		rest = next.trim();
	}
}

function consumeTrailingRunOptions(
	input: string,
	parsed: { detach: boolean; model?: string; thinking?: ThinkingLevel },
): string {
	let rest = input.trim();
	while (true) {
		const next = consumeSingleTrailingRunOption(rest, parsed);
		if (next === rest) return rest;
		rest = next.trim();
	}
}

function consumeSingleLeadingRunOption(
	input: string,
	parsed: { detach: boolean; model?: string; thinking?: ThinkingLevel },
): string {
	const detach = input.match(/^--detach(?:\s+|$)([\s\S]*)$/);
	if (detach) {
		parsed.detach = true;
		return detach[1] ?? "";
	}
	const model = input.match(/^--model(?:=|\s+)(\S+)(?:\s+|$)([\s\S]*)$/);
	if (model) {
		parsed.model = model[1];
		return model[2] ?? "";
	}
	const thinking = input.match(
		/^--(?:thinking|reasoning)(?:=|\s+)(\S+)(?:\s+|$)([\s\S]*)$/,
	);
	if (thinking) {
		parsed.thinking = parseThinkingLevel(thinking[1] ?? "");
		return thinking[2] ?? "";
	}
	return input;
}

function consumeSingleTrailingRunOption(
	input: string,
	parsed: { detach: boolean; model?: string; thinking?: ThinkingLevel },
): string {
	const detach = input.match(/([\s\S]*?)(?:\s+)--detach$/);
	if (detach) {
		parsed.detach = true;
		return detach[1] ?? "";
	}
	const model = input.match(/([\s\S]*?)(?:\s+)--model(?:=|\s+)(\S+)$/);
	if (model) {
		parsed.model = model[2];
		return model[1] ?? "";
	}
	const thinking = input.match(
		/([\s\S]*?)(?:\s+)--(?:thinking|reasoning)(?:=|\s+)(\S+)$/,
	);
	if (thinking) {
		parsed.thinking = parseThinkingLevel(thinking[2] ?? "");
		return thinking[1] ?? "";
	}
	return input;
}

function parseThinkingLevel(value: string): ThinkingLevel {
	if (isThinkingLevel(value)) return value;
	throw new Error(
		`Invalid workflow thinking level "${value}". Supported: ${THINKING_LEVELS.join(", ")}`,
	);
}

function isThinkingLevel(value: string): value is ThinkingLevel {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}

const WORKFLOW_ACTION_COMPLETIONS = [
	{ value: "help", label: "help", description: "Show /workflow help" },
	{ value: "list", label: "list", description: "List discoverable workflows" },
	{
		value: "validate",
		label: "validate",
		description: "Validate a workflow spec",
	},
	{
		value: "roles",
		label: "roles",
		description: "Show compiled workflow role context",
	},
	{
		value: "agents",
		label: "agents",
		description: "List discoverable Pi agents",
	},
	{ value: "run", label: "run", description: "Start a workflow run" },
	{ value: "status", label: "status", description: "Show workflow run status" },
	{ value: "show", label: "show", description: "Show a run or workflow spec" },
	{ value: "logs", label: "logs", description: "Show workflow task logs" },
	{ value: "wait", label: "wait", description: "Wait for a workflow run" },
	{
		value: "resume",
		label: "resume",
		description: "Resume a failed or interrupted run",
	},
];

export function workflowArgumentCompletions(
	args: string,
	workflows: Array<{ name: string }> = [],
): Array<{ value: string; label: string; description?: string }> | undefined {
	const trimmed = args.trimStart();
	if (!trimmed.includes(" ")) {
		const prefix = trimmed.trim();
		const matches = WORKFLOW_ACTION_COMPLETIONS.filter((item) =>
			item.value.startsWith(prefix),
		);
		return matches.length > 0 ? matches : undefined;
	}

	const workflowNameCommands = ["run", "validate", "roles", "show"];
	for (const command of workflowNameCommands) {
		if (!trimmed.startsWith(`${command} `)) continue;
		const prefix = trimmed.slice(command.length + 1).trim();
		if (prefix.includes(" ")) return undefined;
		const matches = workflows
			.filter((workflow) => workflow.name.startsWith(prefix))
			.map((workflow) => ({
				value: `${command} ${workflow.name}`,
				label: workflow.name,
				description: `Use workflow ${workflow.name}`,
			}));
		return matches.length > 0 ? matches : undefined;
	}
	return undefined;
}

function splitArgs(args: string): string[] {
	return args.trim().split(/\s+/).filter(Boolean);
}

function requireArg(tokens: string[], index: number, usage: string): string {
	const value = tokens[index];
	if (!value) throw new Error(`Missing argument. Usage: ${usage}`);
	return value;
}
