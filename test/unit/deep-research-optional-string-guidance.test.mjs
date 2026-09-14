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

test("deep-research aligns optional string prompt guidance with the output contract", async () => {
	const loaded = await loadWorkflowSpec(specPath, repoRoot);
	const compiled = await compileWorkflow(loaded.spec, {
		cwd: repoRoot,
		specPath,
		task: "Research the optional-string output contract.",
	});
	const researchQuestions = compiled.tasks.find(
		(task) => task.stageId === "research-questions",
	);
	assert.ok(researchQuestions);
	assert.equal(
		researchQuestions.compiledPrompt.includes(omissionGuidance),
		true,
	);
	assert.equal(
		researchQuestions.compiledPrompt.includes(
			"sourceTitleOrPublisher, dateOrYear when relevant, sourceQuality, confidence, quote, and notes",
		),
		false,
	);

	const schema = JSON.parse(await readFile(schemaPath, "utf8"));
	assert.deepEqual(validateJsonSchema(omittedOptionalStrings, schema), {
		valid: true,
		issues: [],
	});
	const accepted = await validateWorkflowOutputForBundle(
		rawOutput(omittedOptionalStrings),
		{ controlJsonSchema: schema },
	);
	assert.equal(accepted.valid, true, JSON.stringify(accepted.issues));

	const nullOptionalStrings = structuredClone(omittedOptionalStrings);
	nullOptionalStrings.extractedFacts[0].dateOrYear = null;
	nullOptionalStrings.extractedFacts[0].quote = null;
	nullOptionalStrings.claims[0].quote = null;
	nullOptionalStrings.sources[0].quote = null;
	const rejected = await validateWorkflowOutputForBundle(
		rawOutput(nullOptionalStrings),
		{ controlJsonSchema: schema },
	);
	assert.equal(rejected.valid, false);
	const issuePaths = new Set(rejected.issues.map((issue) => issue.path));
	for (const path of [
		"$.extractedFacts[0].dateOrYear",
		"$.extractedFacts[0].quote",
		"$.claims[0].quote",
		"$.sources[0].quote",
	]) {
		assert.ok(issuePaths.has(path), `${path}: ${JSON.stringify(rejected.issues)}`);
	}
});
