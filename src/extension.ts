import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { relative } from "node:path";

import { discoverAgents } from "./agents.js";
import { compileWorkflowSpec } from "./compiler.js";
import {
  formatLogs,
  formatRunDetails,
  formatRunStatus,
  formatStatus,
  resumeSupervisors,
  runWorkflowSpec,
  waitForRun,
  formatRun,
} from "./engine.js";
import { WORKFLOW_COMMAND, WORKFLOW_HELP } from "./index.js";
import { loadWorkflowSpec } from "./schema.js";
import { listWorkflows, recommendWorkflows, resolveWorkflowRef } from "./workflow-specs.js";
import { CompiledWorkflow, WorkflowValidationError } from "./types.js";

export default function workflowExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    await resumeSupervisors(ctx.cwd).catch(() => undefined);
  });

  pi.registerCommand(WORKFLOW_COMMAND, {
    description: "Run and inspect workflow-defined Pi subagent runs",
    handler: async (args, ctx) => {
      await handleWorkflowCommand(args, ctx);
    },
  });
}

async function handleWorkflowCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const tokens = splitArgs(args);
  const action = tokens[0] ?? "help";

  try {
    if (action === "help" || action === "--help" || action === "-h") {
      emit(ctx, WORKFLOW_HELP, "info");
      return;
    }

    if (action === "validate") {
      const specPath = requireArg(tokens, 1, "/workflow validate <workflow-name-or-path>");
      const loaded = await loadAndCompile(specPath, ctx.cwd);
      emit(ctx, formatValidationSummary(loaded, ctx.cwd), "info");
      return;
    }

    if (action === "roles") {
      const specPath = requireArg(tokens, 1, "/workflow roles <workflow-name-or-path>");
      const loaded = await loadAndCompile(specPath, ctx.cwd);
      emit(ctx, `${formatResolvedSpec(loaded.loaded, ctx.cwd)}\n\n${formatRoles(loaded.compiled)}`, "info");
      return;
    }

    if (action === "agents") {
      const registry = await discoverAgents(ctx.cwd);
      emit(ctx, formatAgents(registry.agents), "info");
      return;
    }

    if (action === "list") {
      const workflows = await listWorkflows(ctx.cwd);
      emit(ctx, workflows.length === 0 ? "No workflows found." : workflows.map((workflow) => `${workflow.name}\t${toDisplayPath(workflow.specPath, ctx.cwd)}`).join("\n"), "info");
      return;
    }

    if (action === "recommend") {
      const request = args.slice(args.indexOf("recommend") + "recommend".length).trim();
      const recommendations = await recommendWorkflows(request, ctx.cwd);
      emit(ctx, recommendations.length === 0 ? "No workflow recommendations." : recommendations.map((item) => `${item.workflow.name}\tscore=${item.score}\t${item.reasons.join("; ")}`).join("\n"), "info");
      return;
    }

    if (action === "run") {
      const parsed = parseWorkflowRunArgs(args);
      const specPath = parsed.specPath || requireArg(tokens, 1, "/workflow run <workflow-name-or-path> \"<task>\"");
      if (!parsed.task.trim()) throw new Error("This workflow needs a task. Usage: /workflow run <workflow-name-or-path> \"<task>\"");
      const run = await runWorkflowSpec(specPath, ctx.cwd, { task: parsed.task });
      const verb = run.status === "blocked" ? "created but blocked" : run.status === "failed" ? "created but failed to launch" : "started";
      emit(ctx, `Workflow run ${run.runId} ${verb}.\nSpec: ${toDisplayPath(run.specPath, ctx.cwd)}\n${formatRun(run)}`, run.status === "failed" ? "error" : run.status === "blocked" ? "warning" : "info");
      return;
    }

    if (action === "status") {
      const text = tokens[1] ? await formatRunStatus(ctx.cwd, tokens[1]) : await formatStatus(ctx.cwd);
      emit(ctx, text, "info");
      return;
    }

    if (action === "show") {
      const ref = requireArg(tokens, 1, "/workflow show <run-id-or-workflow-name>");
      if (ref.startsWith("workflow_")) {
        emit(ctx, await formatRunDetails(ctx.cwd, ref), "info");
      } else {
        const resolved = await resolveWorkflowRef(ref, ctx.cwd);
        emit(ctx, await readFile(resolved.specPath, "utf8"), "info");
      }
      return;
    }

    if (action === "logs") {
      const runId = requireArg(tokens, 1, "/workflow logs <run-id> [task-id] [lines]");
      const taskId = tokens[2] ?? "task-1";
      const lineText = tokens[3];
      emit(ctx, await formatLogs(ctx.cwd, runId, taskId, lineText ? Number(lineText) : undefined), "info");
      return;
    }

    if (action === "wait") {
      const runId = requireArg(tokens, 1, "/workflow wait <run-id> [timeout-ms]");
      const run = await waitForRun(ctx.cwd, runId, tokens[2] ? Number(tokens[2]) : undefined);
      emit(ctx, formatRun(run, "full"), run.status === "completed" ? "info" : run.status === "blocked" ? "warning" : "error");
      return;
    }

    throw new Error(`Unknown /workflow action "${action}". Try /workflow help.`);
  } catch (error) {
    emit(ctx, formatError(error), "error");
    if (!ctx.hasUI) process.exitCode = 1;
  }
}

async function loadAndCompile(specPath: string, cwd: string): Promise<{ loaded: Awaited<ReturnType<typeof loadWorkflowSpec>>; compiled: CompiledWorkflow }> {
  const loaded = await loadWorkflowSpec(specPath, cwd);
  return { loaded, compiled: await compileWorkflowSpec(loaded.spec, { cwd }) };
}

function formatValidationSummary(result: { loaded: Awaited<ReturnType<typeof loadWorkflowSpec>>; compiled: CompiledWorkflow }, cwd: string): string {
  const { loaded, compiled } = result;
  const blocked = compiled.tasks.filter((task) => task.safety.permission.status === "blocked");
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
      lines.push(`- ${task.id}: blocked/${task.safety.permission.statusDetail} — ${task.safety.permission.reason ?? "needs attention"}`);
    }
  }

  if (compiled.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of compiled.warnings) lines.push(`- ${warning}`);
  }

  return lines.join("\n");
}

function formatResolvedSpec(loaded: Awaited<ReturnType<typeof loadWorkflowSpec>>, cwd: string): string {
  const workflow = loaded.workflowName ? ` (workflow: ${loaded.workflowName})` : "";
  return `Spec: ${toDisplayPath(loaded.specPath, cwd)}${workflow}`;
}

function toDisplayPath(path: string, cwd: string): string {
  const display = relative(cwd, path);
  if (display === "") return path;
  return display.startsWith("..") ? path : display;
}

function formatRoles(compiled: CompiledWorkflow): string {
  if (compiled.roles.length === 0) return "No roles compiled.";

  return compiled.roles.map((role) => {
    const lines = [
      `# Role: ${role.name}`,
      role.fromAgent ? `fromAgent: ${role.fromAgent}` : undefined,
      role.sourcePath ? `sourcePath: ${role.sourcePath}` : undefined,
      `includedSections: ${role.includedSections.join(", ")}`,
      `excludedSections: ${role.excludedSections.join(", ")}`,
      role.truncated ? `truncated: true (maxChars=${role.maxChars})` : `truncated: false (maxChars=${role.maxChars})`,
      "",
      role.content || "(empty role content)",
    ].filter((line): line is string => line !== undefined);

    return lines.join("\n");
  }).join("\n\n---\n\n");
}

function formatAgents(agents: Awaited<ReturnType<typeof discoverAgents>>["agents"]): string {
  if (agents.length === 0) return "No Pi agents found.";

  return agents.map((agent) => {
    const runtime = [
      agent.model ? `model=${agent.model}` : undefined,
      agent.thinking ? `thinking=${agent.thinking}` : undefined,
      agent.fast ? `fast=${agent.fast}` : undefined,
    ].filter(Boolean).join(" ") || "runtime=(Pi default)";

    return [
      agent.displayName,
      agent.description ? `  ${agent.description}` : undefined,
      `  ${runtime}`,
      `  tools=${agent.tools?.join(",") ?? "(Pi default)"}`,
      `  source=${agent.sourcePath}`,
    ].filter((line): line is string => line !== undefined).join("\n");
  }).join("\n\n");
}

function formatError(error: unknown): string {
  if (error instanceof WorkflowValidationError) {
    return `Workflow validation failed:\n${error.issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n")}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function emit(ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error"): void {
  const printMode = process.argv.includes("--print") || process.argv.includes("-p");
  if (ctx.hasUI && !printMode) {
    ctx.ui.notify(text, level);
    return;
  }

  const stream = level === "error" ? process.stderr : process.stdout;
  stream.write(`${text}\n`);
}

export function parseWorkflowRunArgs(args: string): { specPath: string; task: string } {
  const trimmed = args.trim();
  const withoutRun = trimmed.startsWith("run ") ? trimmed.slice(4) : trimmed;
  const match = withoutRun.match(/^(\S+)\s+([\s\S]*)$/);
  if (!match) return { specPath: withoutRun, task: "" };
  let task = match[2] ?? "";
  const quoted = task.match(/^"([\s\S]*)"$/);
  if (quoted) task = quoted[1] ?? "";
  return { specPath: match[1] ?? "", task };
}

export function workflowArgumentCompletions(args: string, workflows: Array<{ name: string }> = []): Array<{ value: string }> | undefined {
  if (args === "workflow ") return [{ value: "workflow list" }, { value: "workflow show" }];
  if (args.startsWith("run ")) {
    const prefix = args.slice(4).trim();
    return workflows.filter((workflow) => workflow.name.startsWith(prefix)).map((workflow) => ({ value: `run ${workflow.name}` }));
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
