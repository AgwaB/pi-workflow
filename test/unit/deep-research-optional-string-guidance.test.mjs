import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { compileWorkflow } from "../../.tmp/unit/compiler.js";
import { validateJsonSchema } from "../../.tmp/unit/json-schema.js";
import { loadWorkflowSpec } from "../../.tmp/unit/schema.js";
import { validateWorkflowOutputForBundle } from "../../.tmp/unit/workflow-output-artifacts.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const specPath = join(repoRoot, "workflows/deep-research/spec.json");
const schemaPath = join(
	repoRoot,
	"workflows/deep-research/schemas/deep-research-research-questions-control.schema.json",
);
const omissionGuidance =
	"All dateOrYear and quote values in extractedFacts, claims, and sources must be JSON strings when present; if unknown or not applicable, omit the field and never emit JSON null.";

function rawOutput(control) {
	return [
		`<control>${JSON.stringify(control)}</control>`,
		"<analysis>Optional string omission fixture.</analysis>",
		"<refs>[]</refs>",
	].join("\n");
}

const omittedOptionalStrings = {
	schema: "stage-control-v1",
	digest: "optional strings omitted",
	questionId: "rq-001",
	question: "What is the observed behavior?",
	extractedFacts: [
		{
			slotId: "slot-001",
			value: "Observed behavior",
			sourceUrls: ["https://example.invalid/source"],
		},
	],
	claims: [
		{
			claim: "The behavior was observed.",
			sourceUrls: ["https://example.invalid/source"],
		},
	],
	sources: [
		{
			sourceRef: "source-001",
			sourceUrl: "https://example.invalid/source",
		},
	],
};
