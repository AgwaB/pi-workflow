import { createHash } from "node:crypto";

import type { CompiledWorkflow } from "./types.js";

export const STRICT_PROMPT_SCHEMA_ENV = "PI_WORKFLOW_STRICT_PROMPT_SCHEMA";

export type WorkflowDiagnosticLevel = "warning";
export type PromptSchemaDiagnosticsPolicy =
	| "named-workflow"
	| "excluded-direct-dynamic";

export function promptSchemaDiagnosticsApply(
	policy: PromptSchemaDiagnosticsPolicy,
): boolean {
	return policy === "named-workflow";
}

export interface WorkflowCompileDiagnostic {
	code: string;
	level: WorkflowDiagnosticLevel;
	stageId?: string;
	path?: string;
	message: string;
	strictBlocking: boolean;
}

/**
 * Internal projection of the legacy warning list. It deliberately does not add
 * fields to CompiledWorkflow or serialized run artifacts.
 */
export function workflowPromptSchemaDiagnostics(
	compiled: Pick<CompiledWorkflow, "warnings">,
): readonly WorkflowCompileDiagnostic[] {
	return compiled.warnings.map(classifyWarning);
}

export function promptSchemaDiagnosticDigest(
	diagnostics: readonly WorkflowCompileDiagnostic[],
): string {
	return createHash("sha256")
		.update(JSON.stringify(diagnostics))
		.digest("hex");
}

export function assertPromptSchemaDiagnosticsAllowRun(
	diagnostics: readonly WorkflowCompileDiagnostic[],
	env: NodeJS.ProcessEnv = process.env,
): void {
	if (env[STRICT_PROMPT_SCHEMA_ENV] !== "1") return;
	const blocking = diagnostics.filter((diagnostic) => diagnostic.strictBlocking);
	if (blocking.length === 0) return;
	throw new Error(
		`Strict prompt/schema validation rejected the workflow before launch:\n${blocking
			.map((diagnostic) => `- [${diagnostic.code}] ${diagnostic.message}`)
			.join("\n")}`,
	);
}

export interface WorkflowCompileDiagnosticNotice {
	digest: string;
	text: string;
}

export function buildPromptSchemaDiagnosticNotice(
	diagnostics: readonly WorkflowCompileDiagnostic[],
): WorkflowCompileDiagnosticNotice | undefined {
	const text = formatPromptSchemaDiagnostics(diagnostics);
	if (!text) return undefined;
	return { digest: promptSchemaDiagnosticDigest(diagnostics), text };
}

export function formatPromptSchemaDiagnostics(
	diagnostics: readonly WorkflowCompileDiagnostic[],
): string | undefined {
	if (diagnostics.length === 0) return undefined;
	return `Workflow prompt/schema warnings:\n${diagnostics
		.map((diagnostic) => `- ${diagnostic.message}`)
		.join("\n")}`;
}

function classifyWarning(message: string): WorkflowCompileDiagnostic {
	const stageId = /(?:foreach |reduce )?stage "([^"]+)"/.exec(message)?.[1];
	const path = /(?:reads|projects|itemIdentityPath|itemPayloadPath) "([^"]+)"/.exec(
		message,
	)?.[1];

	let code = "workflow.advisory";
	let strictBlocking = false;
	if (/prompt asks for .* but .* defines/.test(message)) {
		code = "prompt.control_schema_mismatch";
		strictBlocking = true;
	} else if (/prompt does not show the exact JSON key/.test(message)) {
		code = "prompt.required_key_undocumented";
		strictBlocking = true;
	} else if (/prompt does not show an exact .* control shape/.test(message)) {
		code = "prompt.control_shape_undocumented";
		strictBlocking = true;
	} else if (/foreach stage .* reads .* not a property/.test(message)) {
		code = "control_schema.foreach_path_missing";
		strictBlocking = true;
	} else if (/foreach stage .* (?:itemIdentityPath|itemPayloadPath)/.test(message)) {
		code = "control_schema.foreach_item_path_invalid";
		strictBlocking = true;
	} else if (/projects .* via sourceProjection/.test(message)) {
		code = "control_schema.source_projection_missing";
		strictBlocking = true;
	} else if (/declares readOnly: true/.test(message)) {
		code = "tools.read_only_capability_advisory";
	} else if (/High length-cutoff\/control-bloat risk/.test(message)) {
		code = "prompt.control_bloat_advisory";
	}

	return {
		code,
		level: "warning",
		...(stageId ? { stageId } : {}),
		...(path ? { path } : {}),
		message,
		strictBlocking,
	};
}
