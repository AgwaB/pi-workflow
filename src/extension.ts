import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { relative } from "node:path";

import { discoverAgents } from "./agents.js";
import { compileFlowSpec } from "./compiler.js";
import {
  formatLogs,
  formatRunDetails,
  formatRunStatus,
  formatStatus,
  resumeSupervisors,
  runFlowSpec,
  waitForRun,
  formatRun,
} from "./engine.js";
import { FLOW_COMMAND, FLOW_HELP } from "./index.js";
import { loadFlowSpec } from "./schema.js";
import { CompiledFlow, FlowValidationError } from "./types.js";

export default function flowExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    await resumeSupervisors(ctx.cwd).catch(() => undefined);
  });

  pi.registerCommand(FLOW_COMMAND, {
    description: "Run and inspect spec-defined Pi subagent flows",
    handler: async (args, ctx) => {
      await handleFlowCommand(args, ctx);
    },
  });
}

async function handleFlowCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const tokens = splitArgs(args);
  const action = tokens[0] ?? "help";

  try {
    if (action === "help" || action === "--help" || action === "-h") {
      emit(ctx, FLOW_HELP, "info");
      return;
    }

    if (action === "validate") {
      const specPath = requireArg(tokens, 1, "/flow validate <spec.json|yaml|recipe-name>");
      const loaded = await loadAndCompile(specPath, ctx.cwd);
      emit(ctx, formatValidationSummary(loaded, ctx.cwd), "info");
      return;
    }

    if (action === "roles") {
      const specPath = requireArg(tokens, 1, "/flow roles <spec.json|yaml|recipe-name>");
      const loaded = await loadAndCompile(specPath, ctx.cwd);
      emit(ctx, `${formatResolvedSpec(loaded.loaded, ctx.cwd)}\n\n${formatRoles(loaded.compiled)}`, "info");
      return;
    }

    if (action === "agents") {
      const registry = await discoverAgents(ctx.cwd);
      emit(ctx, formatAgents(registry.agents), "info");
      return;
    }

    if (action === "run") {
      const specPath = requireArg(tokens, 1, "/flow run <spec.json|yaml|recipe-name>");
      const run = await runFlowSpec(specPath, ctx.cwd);
      const verb = run.status === "blocked" ? "created but blocked" : run.status === "failed" ? "created but failed to launch" : "started";
      emit(ctx, `Flow run ${run.runId} ${verb}.\nSpec: ${toDisplayPath(run.specPath, ctx.cwd)}\n${formatRun(run)}`, run.status === "failed" ? "error" : run.status === "blocked" ? "warning" : "info");
      return;
    }

    if (action === "status") {
      const text = tokens[1] ? await formatRunStatus(ctx.cwd, tokens[1]) : await formatStatus(ctx.cwd);
      emit(ctx, text, "info");
      return;
    }

    if (action === "show") {
      const runId = requireArg(tokens, 1, "/flow show <run-id>");
      emit(ctx, await formatRunDetails(ctx.cwd, runId), "info");
      return;
    }

    if (action === "logs") {
      const runId = requireArg(tokens, 1, "/flow logs <run-id> [task-id] [lines]");
      const taskId = tokens[2] ?? "task-1";
      const lineText = tokens[3];
      emit(ctx, await formatLogs(ctx.cwd, runId, taskId, lineText ? Number(lineText) : undefined), "info");
      return;
    }

    if (action === "wait") {
      const runId = requireArg(tokens, 1, "/flow wait <run-id> [timeout-ms]");
      const run = await waitForRun(ctx.cwd, runId, tokens[2] ? Number(tokens[2]) : undefined);
      emit(ctx, formatRun(run, "full"), run.status === "completed" ? "info" : run.status === "blocked" ? "warning" : "error");
      return;
    }

    throw new Error(`Unknown /flow action "${action}". Try /flow help.`);
  } catch (error) {
    emit(ctx, formatError(error), "error");
    if (!ctx.hasUI) process.exitCode = 1;
  }
}

async function loadAndCompile(specPath: string, cwd: string): Promise<{ loaded: Awaited<ReturnType<typeof loadFlowSpec>>; compiled: CompiledFlow }> {
  const loaded = await loadFlowSpec(specPath, cwd);
  return { loaded, compiled: await compileFlowSpec(loaded.spec, { cwd }) };
}

function formatValidationSummary(result: { loaded: Awaited<ReturnType<typeof loadFlowSpec>>; compiled: CompiledFlow }, cwd: string): string {
  const { loaded, compiled } = result;
  const blocked = compiled.tasks.filter((task) => task.safety.permission.status === "blocked");
  const lines = [
    `Flow spec valid: ${compiled.name ?? "(unnamed)"}`,
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

function formatResolvedSpec(loaded: Awaited<ReturnType<typeof loadFlowSpec>>, cwd: string): string {
  const recipe = loaded.recipeName ? ` (recipe: ${loaded.recipeName})` : "";
  return `Spec: ${toDisplayPath(loaded.specPath, cwd)}${recipe}`;
}

function toDisplayPath(path: string, cwd: string): string {
  const display = relative(cwd, path);
  if (display === "") return path;
  return display.startsWith("..") ? path : display;
}

function formatRoles(compiled: CompiledFlow): string {
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
  if (error instanceof FlowValidationError) {
    return `Flow validation failed:\n${error.issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n")}`;
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

function splitArgs(args: string): string[] {
  return args.trim().split(/\s+/).filter(Boolean);
}

function requireArg(tokens: string[], index: number, usage: string): string {
  const value = tokens[index];
  if (!value) throw new Error(`Missing argument. Usage: ${usage}`);
  return value;
}
