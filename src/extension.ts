import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
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
	refreshRun,
	resumeRun,
	resumeSupervisors,
	runDynamicTask,
	runWorkflowSpec,
	waitForRun,
	formatRun,
} from "./engine.js";
import { WORKFLOW_COMMAND, WORKFLOW_HELP } from "./index.js";
import { showWorkflowView } from "./workflow-view.js";
import {
	assertWorkflowActionAllowedForRole,
	assertWorkflowToolAllowedForRole,
	isWorkflowSupervisorEnabled,
} from "./process-role.js";
import { readIndex, readRunRecord } from "./store.js";
import { loadWorkflowSpec } from "./schema.js";
import { listWorkflows, resolveWorkflowRef } from "./workflow-specs.js";
import {
	type CompiledWorkflow,
	type ThinkingLevel,
	WorkflowValidationError,
} from "./types.js";

const UNFINISHED_RUN_NOTICE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const UNFINISHED_RUN_NOTICE_MAX_RUNS = 5;
const RUN_FEEDBACK_POLL_MS = 2_000;
const runFeedbackTimers = new Map<string, ReturnType<typeof setInterval>>();

export const WORKFLOW_LIST_TOOL = "workflow_list" as const;
export const WORKFLOW_RUN_TOOL = "workflow_run" as const;
export const WORKFLOW_DYNAMIC_TOOL = "workflow_dynamic" as const;

const WORKFLOW_LIST_TOOL_PARAMETERS = {
	type: "object",
	additionalProperties: false,
	properties: {},
} as const;

const WORKFLOW_RUN_TOOL_PARAMETERS = {
	type: "object",
	additionalProperties: false,
	properties: {
		workflow: {
			type: "string",
			description:
				'Exact workflow name or spec path, for example "deep-research".',
		},
		task: {
			type: "string",
			description:
				"Full runtime task for the workflow. Preserve the user's language, file references, and constraints.",
		},
		detach: {
			type: "boolean",
			description:
				"Optional. When true, spawn a standalone supervisor so the run keeps progressing after this Pi session exits.",
		},
	},
	required: ["workflow", "task"],
} as const;

const WORKFLOW_DYNAMIC_TOOL_PARAMETERS = {
	type: "object",
	additionalProperties: false,
	properties: {
		task: {
			type: "string",
			description:
				"Full runtime task for spec-less direct dynamic workflow execution. Preserve the user's language, file references, constraints, and requested depth.",
		},
		detach: {
			type: "boolean",
			description:
				"Optional. When true, spawn a standalone supervisor so the dynamic run keeps progressing after this Pi session exits.",
		},
		model: {
			type: "string",
			description: "Optional model override for this dynamic workflow run.",
		},
		thinking: {
			type: "string",
			description: "Optional thinking/reasoning level override.",
			enum: ["off", "minimal", "low", "medium", "high", "xhigh"],
		},
	},
	required: ["task"],
} as const;

export default function workflowExtension(pi: ExtensionAPI): void {
	let workflowCompletionCache: Array<{ name: string }> = [];
	pi.on("session_start", async (_event, ctx) => {
		if (!isWorkflowSupervisorEnabled()) return;
		workflowCompletionCache = await listWorkflows(ctx.cwd).catch(
			() => workflowCompletionCache,
		);
		await resumeSupervisors(ctx.cwd, {
			dynamicUi: dynamicUiFromContext(ctx),
		}).catch(() => undefined);
		await notifyUnfinishedRuns(ctx.cwd, (message, type) =>
			ctx.ui.notify(message, type),
		).catch(() => undefined);
	});

	registerWorkflowNaturalLanguageTools(pi);

	pi.registerCommand(WORKFLOW_COMMAND, {
		description: "Open the workflow board and inspect runs",
		getArgumentCompletions(prefix) {
			return (
				workflowArgumentCompletions(prefix, workflowCompletionCache) ?? null
			);
		},
		handler: async (args, ctx) => {
			await handleWorkflowCommand(args, ctx, pi);
		},
	});
}

export function registerWorkflowNaturalLanguageTools(
	pi: ExtensionAPI,
	env: NodeJS.ProcessEnv = process.env,
): void {
	if (!isWorkflowSupervisorEnabled(env)) return;

	pi.registerTool({
		name: WORKFLOW_LIST_TOOL,
		label: "List Workflows",
		description:
			"List pi-workflow specs discoverable from the current project and installed package.",
		promptSnippet:
			"List available pi-workflow workflow names, descriptions, and spec paths.",
		promptGuidelines: [
			"Use workflow_list when the user asks what workflows exist or asks you to choose a workflow but did not name one.",
			"Use workflow_list before workflow_run when the requested workflow name is uncertain; do not guess workflow names.",
		],
		parameters: WORKFLOW_LIST_TOOL_PARAMETERS as any,
		async execute(
			_toolCallId: string,
			params: unknown,
			_signal: AbortSignal,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			assertWorkflowToolAllowedForRole();
			parseWorkflowListToolParams(params);
			const workflows = await listWorkflowSummaries(ctx.cwd);
			return {
				content: [
					{ type: "text", text: formatWorkflowListToolResult(workflows) },
				],
				details: { workflows },
			};
		},
	} as any);

	pi.registerTool({
		name: WORKFLOW_RUN_TOOL,
		label: "Run Workflow",
		description:
			"Start a named pi-workflow run from an explicit natural-language user request.",
		promptSnippet:
			"Start a pi-workflow by exact workflow name/path and full runtime task text.",
		promptGuidelines: [
			"Use workflow_run when the user explicitly asks to run, start, execute, or use a pi-workflow by name, including non-English requests that explicitly name a workflow.",
			"Do not use workflow_run for ordinary research, review, or coding requests unless the user asks to use a workflow.",
			"Do not call workflow_run unless both an exact workflow name/path and a concrete task are known; ask a clarifying question if either is missing.",
			"Preserve the user's task language, file references, constraints, and requested depth in workflow_run.task; do not reduce it to 'run the workflow'.",
		],
		parameters: WORKFLOW_RUN_TOOL_PARAMETERS as any,
		async execute(
			_toolCallId: string,
			params: unknown,
			_signal: AbortSignal,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			assertWorkflowToolAllowedForRole();
			const request = parseWorkflowRunToolParams(params);
			const result = await startWorkflowRunFromRequest(request, ctx, pi);
			return {
				content: [{ type: "text", text: result.text }],
				details: {
					runId: result.run.runId,
					status: result.run.status,
					specPath: toDisplayPath(result.run.specPath, ctx.cwd),
					taskSummary: result.run.taskSummary,
					openCommand: `/workflow ${result.run.runId}`,
				},
			};
		},
	} as any);

	pi.registerTool({
		name: WORKFLOW_DYNAMIC_TOOL,
		label: "Run Dynamic Workflow",
		description:
			"Start a spec-less direct dynamic pi-workflow run from an explicit dynamic-workflow request.",
		promptSnippet:
			"Start a spec-less direct dynamic pi-workflow run from full runtime task text.",
		promptGuidelines: [
			"Use workflow_dynamic only when the user explicitly asks for dynamic workflow, dynamic research, adaptive/direct dynamic execution, or /workflow dynamic semantics and provides a concrete task.",
			"Do not use workflow_dynamic for ordinary research, review, or coding requests unless the user explicitly asks for dynamic workflow execution.",
			"If the user names a workflow such as deep-research or adaptive-research, use workflow_run instead.",
			"Do not call workflow_dynamic unless a concrete task is known; ask a clarifying question if it is missing.",
			"Preserve the user's task language, file references, constraints, and requested depth in workflow_dynamic.task.",
		],
		parameters: WORKFLOW_DYNAMIC_TOOL_PARAMETERS as any,
		async execute(
			_toolCallId: string,
			params: unknown,
			_signal: AbortSignal,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			assertWorkflowToolAllowedForRole();
			const request = parseWorkflowDynamicToolParams(params);
			const result = await startDynamicRunFromRequest(request, ctx, pi);
			return {
				content: [{ type: "text", text: result.text }],
				details: {
					runId: result.run.runId,
					status: result.run.status,
					mode: "direct-dynamic",
					provenance: result.run.provenance,
					taskSummary: result.run.taskSummary,
					openCommand: `/workflow ${result.run.runId}`,
				},
			};
		},
	} as any);
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

function watchWorkflowFeedback(ctx: ExtensionContext, runId: string): void {
	const printMode =
		process.argv.includes("--print") || process.argv.includes("-p");
	if (!ctx.hasUI || printMode) return;

	const key = `${ctx.cwd}\0${runId}`;
	if (runFeedbackTimers.has(key)) return;

	const clear = () => {
		const existing = runFeedbackTimers.get(key);
		if (existing) clearInterval(existing);
		runFeedbackTimers.delete(key);
	};

	const timer = setInterval(() => {
		void (async () => {
			let run;
			try {
				run = await refreshRun(ctx.cwd, runId);
			} catch {
				clear();
				return;
			}
			if (run.status === "running") return;

			clear();
			const summary = run.taskSummary;
			const firstProblem = run.tasks.find((task) =>
				["failed", "blocked", "interrupted"].includes(task.status),
			);
			const problem = firstProblem
				? `\n${firstProblem.displayName ?? firstProblem.specId}: ${firstProblem.lastMessage ?? firstProblem.statusDetail}`
				: "";
			const type = run.status === "completed" ? "info" : "error";
			ctx.ui.notify(
				`Workflow ${run.runId} ${run.status} (${summary.completed}/${summary.total} completed, ${summary.failed} failed, ${summary.interrupted} interrupted).${problem}\nOpen: /workflow ${run.runId}`,
				type,
			);
		})().catch(() => clear());
	}, RUN_FEEDBACK_POLL_MS);
	timer.unref?.();
	runFeedbackTimers.set(key, timer);
}

interface WorkflowListSummary {
	name: string;
	aliases: string[];
	specPath: string;
	description?: string;
	agent?: string;
	readOnly?: boolean;
}

interface WorkflowRunToolRequest {
	workflow: string;
	task: string;
	detach: boolean;
	runtimeDefaults?: { model?: string; thinking?: ThinkingLevel };
}

interface WorkflowDynamicToolRequest {
	task: string;
	detach: boolean;
	runtimeDefaults?: { model?: string; thinking?: ThinkingLevel };
}

function parseWorkflowListToolParams(params: unknown): void {
	if (params === undefined || params === null) return;
	if (!isPlainRecord(params))
		throw new Error("workflow_list input must be an object");
	const keys = Object.keys(params);
	if (keys.length > 0)
		throw new Error(
			`workflow_list does not accept arguments: ${keys.join(", ")}`,
		);
}

function parseWorkflowRunToolParams(params: unknown): WorkflowRunToolRequest {
	if (!isPlainRecord(params))
		throw new Error("workflow_run input must be an object");
	const workflow = stringParam(params, "workflow", "workflow_run").trim();
	const task = stringParam(params, "task", "workflow_run").trim();
	if (!workflow) throw new Error("workflow_run requires workflow");
	if (!task) throw new Error("workflow_run requires a concrete task");
	const detachValue = params.detach;
	if (detachValue !== undefined && typeof detachValue !== "boolean")
		throw new Error("workflow_run detach must be a boolean when provided");
	return { workflow, task, detach: detachValue === true };
}

function parseWorkflowDynamicToolParams(
	params: unknown,
): WorkflowDynamicToolRequest {
	if (!isPlainRecord(params))
		throw new Error("workflow_dynamic input must be an object");
	const task = stringParam(params, "task", "workflow_dynamic").trim();
	if (!task) throw new Error("workflow_dynamic requires a concrete task");
	const detachValue = params.detach;
	if (detachValue !== undefined && typeof detachValue !== "boolean")
		throw new Error("workflow_dynamic detach must be a boolean when provided");
	const model = optionalStringParam(
		params,
		"model",
		"workflow_dynamic",
	)?.trim();
	const rawThinking = optionalStringParam(
		params,
		"thinking",
		"workflow_dynamic",
	)?.trim();
	const thinking = rawThinking ? parseThinkingLevel(rawThinking) : undefined;
	const runtimeDefaults =
		model || thinking ? { model: model || undefined, thinking } : undefined;
	return { task, detach: detachValue === true, runtimeDefaults };
}

function stringParam(
	params: Record<string, unknown>,
	key: string,
	toolName: string,
): string {
	const value = params[key];
	if (typeof value !== "string")
		throw new Error(`${toolName} ${key} must be a string`);
	return value;
}

function optionalStringParam(
	params: Record<string, unknown>,
	key: string,
	toolName: string,
): string | undefined {
	const value = params[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string")
		throw new Error(`${toolName} ${key} must be a string when provided`);
	return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function listWorkflowSummaries(
	cwd: string,
): Promise<WorkflowListSummary[]> {
	const workflows = await listWorkflows(cwd);
	return await Promise.all(
		workflows.map(async (workflow) => {
			let description: string | undefined;
			let agent: string | undefined;
			let readOnly: boolean | undefined;
			try {
				const loaded = await loadWorkflowSpec(workflow.specPath, cwd);
				description = loaded.spec.description;
				agent = (loaded.spec.defaults as { agent?: string } | undefined)?.agent;
				readOnly = loaded.spec.defaults?.readOnly;
			} catch {
				// listWorkflows already filters runnable specs; omit optional metadata if a
				// workflow disappears between discovery and summary formatting.
			}
			return {
				name: workflow.name,
				aliases: workflow.aliases,
				specPath: toDisplayPath(workflow.specPath, cwd),
				...(description ? { description } : {}),
				...(agent ? { agent } : {}),
				...(readOnly !== undefined ? { readOnly } : {}),
			};
		}),
	);
}

function formatWorkflowListToolResult(
	workflows: WorkflowListSummary[],
): string {
	if (workflows.length === 0) return "No workflows found.";
	return [
		"Available workflows:",
		...workflows.map((workflow) => {
			const aliases = workflow.aliases
				.filter((alias) => alias !== workflow.name)
				.join(", ");
			const metadata = [
				workflow.agent ? `agent=${workflow.agent}` : undefined,
				workflow.readOnly !== undefined
					? `readOnly=${workflow.readOnly}`
					: undefined,
			]
				.filter((item): item is string => item !== undefined)
				.join(", ");
			return [
				`- ${workflow.name}${aliases ? ` (aliases: ${aliases})` : ""}: ${workflow.description ?? "No description."}`,
				`  spec: ${workflow.specPath}${metadata ? `; ${metadata}` : ""}`,
			].join("\n");
		}),
	].join("\n");
}

async function startWorkflowRunFromRequest(
	request: WorkflowRunToolRequest,
	ctx: ExtensionContext,
	api: ExtensionAPI,
): Promise<{ run: Awaited<ReturnType<typeof runWorkflowSpec>>; text: string }> {
	const workflow = request.workflow.trim();
	const task = request.task.trim();
	if (!workflow) throw new Error("workflow name or spec path is required");
	if (!task)
		throw new Error(
			'This workflow needs a task. Usage: /workflow run <workflow-name-or-path> "<task>"',
		);
	const run = await runWorkflowSpec(workflow, ctx.cwd, {
		task,
		runtimeDefaults:
			request.runtimeDefaults ?? currentRuntimeDefaults(ctx, api),
		dynamicUi: dynamicUiFromContext(ctx),
	});
	const verb = workflowRunStartVerb(run.status);
	if (run.status === "running") watchWorkflowFeedback(ctx, run.runId);

	let detachNote = "";
	if (request.detach && run.status === "running") {
		const supervisor = spawnDetachedSupervisor(ctx.cwd, run.runId);
		detachNote = `\nDetached supervisor pid ${supervisor.pid ?? "?"} — survives this session; log: ${toDisplayPath(supervisor.logPath, ctx.cwd)}`;
	}

	return {
		run,
		text: `Workflow run ${run.runId} ${verb}.\nSpec: ${toDisplayPath(run.specPath, ctx.cwd)}\n${formatRun(run)}${detachNote}\nOpen: /workflow ${run.runId}`,
	};
}

async function startDynamicRunFromRequest(
	request: WorkflowDynamicToolRequest,
	ctx: ExtensionContext,
	api: ExtensionAPI,
): Promise<{ run: Awaited<ReturnType<typeof runDynamicTask>>; text: string }> {
	const task = request.task.trim();
	if (!task)
		throw new Error(
			'This dynamic workflow needs a task. Usage: /workflow dynamic "<task>"',
		);
	const run = await runDynamicTask(ctx.cwd, {
		task,
		runtimeDefaults:
			request.runtimeDefaults ?? currentRuntimeDefaults(ctx, api),
		dynamicUi: dynamicUiFromContext(ctx),
	});
	const verb = workflowRunStartVerb(run.status);
	if (run.status === "running") watchWorkflowFeedback(ctx, run.runId);

	let detachNote = "";
	if (request.detach && run.status === "running") {
		const supervisor = spawnDetachedSupervisor(ctx.cwd, run.runId);
		detachNote = `\nDetached supervisor pid ${supervisor.pid ?? "?"} — survives this session; log: ${toDisplayPath(supervisor.logPath, ctx.cwd)}`;
	}

	return {
		run,
		text: `Dynamic workflow run ${run.runId} ${verb}.\nMode: direct-dynamic (spec-less)\n${formatRun(run)}${detachNote}\nOpen: /workflow ${run.runId}`,
	};
}

function workflowRunStartVerb(status: string): string {
	return status === "blocked"
		? "created but blocked"
		: status === "failed"
			? "created but failed to launch"
			: "started";
}

async function openWorkflowBoard(
	ctx: ExtensionCommandContext,
	runId?: string,
): Promise<void> {
	const printMode =
		process.argv.includes("--print") || process.argv.includes("-p");
	if (!ctx.hasUI || printMode) {
		emit(
			ctx,
			runId
				? await formatRunStatus(ctx.cwd, runId)
				: await formatStatus(ctx.cwd),
			"info",
		);
		return;
	}
	await showWorkflowView(ctx, runId, ctx.cwd);
}

function isWorkflowRunRef(token: string): boolean {
	return token.startsWith("workflow_");
}

function dynamicUiFromContext(ctx: ExtensionContext): {
	hasUI: boolean;
	confirm: (
		title: string,
		message: string,
		options?: Parameters<ExtensionContext["ui"]["confirm"]>[2],
	) => Promise<boolean>;
} {
	const printMode =
		process.argv.includes("--print") || process.argv.includes("-p");
	return {
		hasUI: ctx.hasUI && !printMode,
		confirm: (title, message, options) =>
			ctx.ui.confirm(title, message, options),
	};
}

function currentRuntimeDefaults(
	ctx: ExtensionContext,
	api: ExtensionAPI,
): {
	model?: string;
	thinking?: ThinkingLevel;
} {
	const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	const rawThinking = api.getThinkingLevel();
	const thinking = isThinkingLevel(rawThinking) ? rawThinking : undefined;
	return {
		...(model ? { model } : {}),
		...(thinking ? { thinking } : {}),
	};
}

function isThinkingLevel(value: string | undefined): value is ThinkingLevel {
	return (
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh"
	);
}

const WORKFLOW_KNOWN_ACTIONS = new Set([
	"help",
	"list",
	"validate",
	"roles",
	"agents",
	"run",
	"dynamic",
	"status",
	"show",
	"logs",
	"wait",
	"resume",
	"--help",
	"-h",
]);

export async function notifyUnfinishedRuns(
	cwd: string,
	notify: (message: string, type?: "info" | "warning" | "error") => void,
	nowMs: number = Date.now(),
): Promise<void> {
	const index = await readIndex(cwd);
	if (!index?.runs?.length) return;
	const unfinished = [];
	for (const run of index.runs) {
		if (run.parentRunId && run.status !== "blocked") continue;
		const updatedAtMs = Date.parse(run.updatedAt ?? "");
		if (
			!Number.isFinite(updatedAtMs) ||
			nowMs - updatedAtMs > UNFINISHED_RUN_NOTICE_MAX_AGE_MS
		) {
			continue;
		}
		if (
			!run.parentRunId &&
			(run.status === "failed" || run.status === "interrupted")
		) {
			unfinished.push(run);
			continue;
		}
		if (run.status !== "blocked") continue;
		const fullRun = await readRunRecord(cwd, run.runId).catch(() => undefined);
		const resumableDynamicApproval = fullRun?.tasks.some(
			(task) =>
				task.status === "blocked" &&
				(task.statusDetail === "dynamic_ui_unavailable" ||
					task.statusDetail === "dynamic_approval_timeout"),
		);
		if (resumableDynamicApproval) unfinished.push(run);
	}
	if (unfinished.length === 0) return;

	const lines = unfinished
		.slice(0, UNFINISHED_RUN_NOTICE_MAX_RUNS)
		.map((run) => {
			const summary = run.taskSummary;
			const blocked =
				(summary as { blocked?: number } | undefined)?.blocked ?? 0;
			const counts = summary
				? ` (${summary.completed}/${summary.total} tasks completed, ${summary.failed} failed, ${summary.interrupted} interrupted${blocked ? `, ${blocked} blocked` : ""})`
				: "";
			const parent = run.parentRunId ? ` parent=${run.parentRunId}` : "";
			return `- ${run.name ?? "(unnamed)"} ${run.runId}${parent}: ${run.status}${counts} — /workflow resume ${run.runId}`;
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
	api: ExtensionAPI,
): Promise<void> {
	const tokens = splitArgs(args);

	try {
		if (tokens.length === 0) {
			assertWorkflowActionAllowedForRole("board");
			await openWorkflowBoard(ctx);
			return;
		}

		const action = tokens[0] ?? "help";
		if (
			tokens.length === 1 &&
			!WORKFLOW_KNOWN_ACTIONS.has(action) &&
			isWorkflowRunRef(action)
		) {
			assertWorkflowActionAllowedForRole("board");
			await openWorkflowBoard(ctx, action);
			return;
		}

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
			const runtimeDefaults =
				parsed.model || parsed.thinking
					? { model: parsed.model, thinking: parsed.thinking }
					: undefined;
			const result = await startWorkflowRunFromRequest(
				{
					workflow: specPath,
					task: parsed.task,
					detach: parsed.detach,
					runtimeDefaults,
				},
				ctx,
				api,
			);
			emitRunStartResult(ctx, result.run.status, result.text);
			return;
		}

		if (action === "dynamic") {
			const parsed = parseWorkflowDynamicArgs(args);
			const runtimeDefaults =
				parsed.model || parsed.thinking
					? { model: parsed.model, thinking: parsed.thinking }
					: undefined;
			const result = await startDynamicRunFromRequest(
				{
					task: parsed.task,
					detach: parsed.detach,
					runtimeDefaults,
				},
				ctx,
				api,
			);
			emitRunStartResult(ctx, result.run.status, result.text);
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
				{ dynamicUi: dynamicUiFromContext(ctx) },
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
			const { run, resetTaskIds } = await resumeRun(ctx.cwd, runId, {
				dynamicUi: dynamicUiFromContext(ctx),
			});
			emit(
				ctx,
				[
					`Reset ${resetTaskIds.length} task(s) to pending: ${resetTaskIds.join(", ")}`,
					formatRun(run, "full"),
				].join("\n"),
				run.status === "completed"
					? "info"
					: run.status === "blocked"
						? "warning"
						: "error",
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

function emitRunStartResult(
	ctx: ExtensionCommandContext,
	status: string,
	text: string,
): void {
	emit(
		ctx,
		text,
		status === "failed" ? "error" : status === "blocked" ? "warning" : "info",
	);
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
	const parsed: WorkflowRunParsedOptions = { detach: false };
	const body = stripWorkflowRunCommand(args.trim());
	const tokens = tokenizeWorkflowRunArgs(body);

	let cursor = 0;
	while (cursor < tokens.length) {
		const consumed = consumeLeadingRunOptionTokens(tokens, cursor, parsed);
		if (consumed === 0) break;
		cursor += consumed;
	}

	const specToken = tokens[cursor];
	if (!specToken) return { specPath: "", task: "", ...parsed };

	let taskTokenEnd = tokens.length;
	while (taskTokenEnd > cursor + 1) {
		const nextEnd = consumeTrailingRunOptionTokens(
			tokens,
			taskTokenEnd,
			parsed,
		);
		if (nextEnd === taskTokenEnd) break;
		taskTokenEnd = nextEnd;
	}

	let taskStart = specToken.end;
	while (taskStart < body.length && /\s/.test(body[taskStart] ?? ""))
		taskStart += 1;
	const taskEnd =
		taskTokenEnd < tokens.length
			? trimEndBefore(body, tokens[taskTokenEnd]!.start)
			: body.length;
	const task = unquoteWorkflowTask(body.slice(taskStart, taskEnd));

	return { specPath: specToken.text, task, ...parsed };
}

export function parseWorkflowDynamicArgs(args: string): {
	task: string;
	detach: boolean;
	model?: string;
	thinking?: ThinkingLevel;
} {
	const parsed: WorkflowRunParsedOptions = { detach: false };
	const body = stripWorkflowDynamicCommand(args.trim());
	const tokens = tokenizeWorkflowRunArgs(body);

	let cursor = 0;
	while (cursor < tokens.length) {
		const consumed = consumeLeadingRunOptionTokens(tokens, cursor, parsed);
		if (consumed === 0) break;
		cursor += consumed;
	}

	let taskTokenEnd = tokens.length;
	while (taskTokenEnd > cursor) {
		const nextEnd = consumeTrailingRunOptionTokens(
			tokens,
			taskTokenEnd,
			parsed,
		);
		if (nextEnd === taskTokenEnd) break;
		taskTokenEnd = nextEnd;
	}

	const taskStartToken = tokens[cursor];
	if (!taskStartToken || taskTokenEnd <= cursor) return { task: "", ...parsed };
	const taskEnd =
		taskTokenEnd < tokens.length
			? trimEndBefore(body, tokens[taskTokenEnd]!.start)
			: body.length;
	const task = unquoteWorkflowTask(body.slice(taskStartToken.start, taskEnd));
	return { task, ...parsed };
}

type WorkflowRunParsedOptions = {
	detach: boolean;
	model?: string;
	thinking?: ThinkingLevel;
};

interface WorkflowRunArgToken {
	text: string;
	start: number;
	end: number;
	quoted: boolean;
}

function stripWorkflowRunCommand(input: string): string {
	return input === "run"
		? ""
		: input.startsWith("run ")
			? input.slice(4).trimStart()
			: input;
}

function stripWorkflowDynamicCommand(input: string): string {
	return input === "dynamic"
		? ""
		: input.startsWith("dynamic ")
			? input.slice("dynamic".length + 1).trimStart()
			: input;
}

function tokenizeWorkflowRunArgs(input: string): WorkflowRunArgToken[] {
	const tokens: WorkflowRunArgToken[] = [];
	let index = 0;

	while (index < input.length) {
		while (index < input.length && /\s/.test(input[index] ?? "")) index += 1;
		if (index >= input.length) break;

		const start = index;
		const quote = input[index];
		if (quote === '"' || quote === "'") {
			index += 1;
			let text = "";
			let escaped = false;
			while (index < input.length) {
				const char = input[index] ?? "";
				index += 1;
				if (escaped) {
					text += char;
					escaped = false;
					continue;
				}
				if (char === "\\") {
					escaped = true;
					continue;
				}
				if (char === quote) break;
				text += char;
			}
			tokens.push({ text, start, end: index, quoted: true });
			continue;
		}

		while (index < input.length && !/\s/.test(input[index] ?? "")) index += 1;
		tokens.push({
			text: input.slice(start, index),
			start,
			end: index,
			quoted: false,
		});
	}

	return tokens;
}

function consumeLeadingRunOptionTokens(
	tokens: readonly WorkflowRunArgToken[],
	index: number,
	parsed: WorkflowRunParsedOptions,
): number {
	const token = tokens[index];
	if (!token || token.quoted) return 0;

	if (token.text === "--detach") {
		parsed.detach = true;
		return 1;
	}

	const model = optionValueFromEquals(token.text, "--model");
	if (model !== undefined) {
		parsed.model = model;
		return 1;
	}
	if (token.text === "--model") {
		parsed.model = requiredOptionValue(tokens[index + 1], "--model");
		return 2;
	}

	const thinking =
		optionValueFromEquals(token.text, "--thinking") ??
		optionValueFromEquals(token.text, "--reasoning");
	if (thinking !== undefined) {
		parsed.thinking = parseThinkingLevel(thinking);
		return 1;
	}
	if (token.text === "--thinking" || token.text === "--reasoning") {
		parsed.thinking = parseThinkingLevel(
			requiredOptionValue(tokens[index + 1], token.text),
		);
		return 2;
	}

	return 0;
}

function consumeTrailingRunOptionTokens(
	tokens: readonly WorkflowRunArgToken[],
	end: number,
	parsed: WorkflowRunParsedOptions,
): number {
	const last = tokens[end - 1];
	if (!last) return end;

	if (!last.quoted && last.text === "--detach") {
		parsed.detach = true;
		return end - 1;
	}

	const model = !last.quoted
		? optionValueFromEquals(last.text, "--model")
		: undefined;
	if (model !== undefined) {
		parsed.model = model;
		return end - 1;
	}

	const thinking = !last.quoted
		? (optionValueFromEquals(last.text, "--thinking") ??
			optionValueFromEquals(last.text, "--reasoning"))
		: undefined;
	if (thinking !== undefined) {
		parsed.thinking = parseThinkingLevel(thinking);
		return end - 1;
	}

	const option = tokens[end - 2];
	if (!option || option.quoted) return end;
	if (option.text === "--model") {
		parsed.model = last.text;
		return end - 2;
	}
	if (option.text === "--thinking" || option.text === "--reasoning") {
		parsed.thinking = parseThinkingLevel(last.text);
		return end - 2;
	}

	return end;
}

function optionValueFromEquals(
	text: string,
	option: string,
): string | undefined {
	return text.startsWith(`${option}=`)
		? text.slice(option.length + 1)
		: undefined;
}

function requiredOptionValue(
	token: WorkflowRunArgToken | undefined,
	option: string,
): string {
	if (!token) throw new Error(`Workflow run option ${option} requires a value`);
	return token.text;
}

function trimEndBefore(input: string, index: number): number {
	let end = index;
	while (end > 0 && /\s/.test(input[end - 1] ?? "")) end -= 1;
	return end;
}

function unquoteWorkflowTask(input: string): string {
	const trimmed = input.trim();
	const tokens = tokenizeWorkflowRunArgs(trimmed);
	const only = tokens[0];
	if (
		only?.quoted &&
		tokens.length === 1 &&
		only.start === 0 &&
		only.end === trimmed.length
	)
		return only.text;
	return trimmed;
}

function parseThinkingLevel(value: string): ThinkingLevel {
	if (isThinkingLevel(value)) return value;
	throw new Error(
		`Invalid workflow thinking level "${value}". Supported: off, minimal, low, medium, high, xhigh`,
	);
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
	{
		value: "dynamic",
		label: "dynamic",
		description: "Start a spec-less direct dynamic workflow run",
	},
	{ value: "status", label: "status", description: "Show workflow run status" },
	{ value: "show", label: "show", description: "Show a run or workflow spec" },
	{ value: "logs", label: "logs", description: "Show workflow task logs" },
	{ value: "wait", label: "wait", description: "Wait for a workflow run" },
	{
		value: "resume",
		label: "resume",
		description: "Resume a failed, interrupted, or resumable blocked run",
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
