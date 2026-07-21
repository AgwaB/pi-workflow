import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
	assertPromptSchemaDiagnosticsAllowRun,
	buildPromptSchemaDiagnosticNotice,
	formatPromptSchemaDiagnostics,
	promptSchemaDiagnosticDigest,
	promptSchemaDiagnosticsApply,
	workflowPromptSchemaDiagnostics,
} from "../../.tmp/unit/prompt-schema-diagnostics.js";

const actionable =
	'stage "plan" requires $.items[].claim but the prompt does not show the exact JSON key "claim". Add a small <control> JSON skeleton or few-shot example using that key to avoid model drift to aliases such as name/claim/title.';
const advisory =
	'reduce stage "finish" fans in foreach outputs with 6 projected paths (maxChars 60000) and a large control schema (6 top-level arrays: a, b, c, d, e, f). High length-cutoff/control-bloat risk: split into intermediate reducers/support helpers, cap evidence indexes, and keep large narrative in <analysis>.';

test("internal diagnostics preserve legacy warning bytes and order", () => {
	const compiled = { warnings: [advisory, actionable] };
	const before = JSON.stringify(compiled.warnings);
	const diagnostics = workflowPromptSchemaDiagnostics(compiled);

	assert.equal(JSON.stringify(compiled.warnings), before);
	assert.deepEqual(
		diagnostics.map((diagnostic) => diagnostic.message),
		compiled.warnings,
	);
	assert.deepEqual(
		diagnostics.map(({ code, level, strictBlocking }) => ({
			code,
			level,
			strictBlocking,
		})),
		[
			{
				code: "prompt.control_bloat_advisory",
				level: "warning",
				strictBlocking: false,
			},
			{
				code: "prompt.required_key_undocumented",
				level: "warning",
				strictBlocking: true,
			},
		],
	);
	assert.equal(
		promptSchemaDiagnosticDigest(diagnostics),
		promptSchemaDiagnosticDigest(workflowPromptSchemaDiagnostics(compiled)),
	);
});

test("diagnostics applicability is an explicit named-workflow policy", () => {
	assert.equal(promptSchemaDiagnosticsApply("named-workflow"), true);
	assert.equal(promptSchemaDiagnosticsApply("excluded-direct-dynamic"), false);
});

test("resume consumes the frozen compiled artifact without recompiling or resurfacing named diagnostics", () => {
	const engineSource = readFileSync(new URL("../../src/engine.ts", import.meta.url), "utf8");
	const resumeStart = engineSource.indexOf("export async function resumeRun(");
	const resumeEnd = engineSource.indexOf("\nexport ", resumeStart + 1);
	const resumeSource = engineSource.slice(
		resumeStart,
		resumeEnd === -1 ? undefined : resumeEnd,
	);
	assert.match(resumeSource, /readCompiledWorkflow\(cwd, run\.runId\)/);
	assert.doesNotMatch(resumeSource, /compileWorkflow|workflowPromptSchemaDiagnostics|DIAGNOSTIC_SINK/);
});

test("strict prompt/schema mode is explicit and rejects only actionable diagnostics", () => {
	const diagnostics = workflowPromptSchemaDiagnostics({
		warnings: [advisory, actionable],
	});
	assert.doesNotThrow(() =>
		assertPromptSchemaDiagnosticsAllowRun(diagnostics, {}),
	);
	assert.throws(
		() =>
			assertPromptSchemaDiagnosticsAllowRun(diagnostics, {
				PI_WORKFLOW_STRICT_PROMPT_SCHEMA: "1",
			}),
		/Strict prompt\/schema validation rejected.*prompt\.required_key_undocumented/s,
	);
	assert.doesNotThrow(() =>
		assertPromptSchemaDiagnosticsAllowRun(
			workflowPromptSchemaDiagnostics({ warnings: [advisory] }),
			{ PI_WORKFLOW_STRICT_PROMPT_SCHEMA: "1" },
		),
	);
});

test("one run-start notice retains warning order without validate formatting", () => {
	const notice = formatPromptSchemaDiagnostics(
		workflowPromptSchemaDiagnostics({ warnings: [actionable, advisory] }),
	);
	assert.equal(
		notice,
		`Workflow prompt/schema warnings:\n- ${actionable}\n- ${advisory}`,
	);
	assert.equal(formatPromptSchemaDiagnostics([]), undefined);
	assert.deepEqual(
		buildPromptSchemaDiagnosticNotice(
			workflowPromptSchemaDiagnostics({ warnings: [actionable, advisory] }),
		),
		{
			digest: promptSchemaDiagnosticDigest(
				workflowPromptSchemaDiagnostics({ warnings: [actionable, advisory] }),
			),
			text: notice,
		},
	);
});
