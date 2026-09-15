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
const specPath = join(repoRoot, "workflows/impact-review/spec.json");

const cases = [
	{
		stageId: "api-contract-impact",
		schemaFile: "api-contract-impact-control.schema.json",
		example: {
			schema: "stage-control-v1",
			digest: "Brief assessment.",
			status: "unknown",
			impacts: [],
			assumptions: [],
		},
		guidance:
			'status: none|low|medium|high|unknown; use impacts for blockers, never "blocked" in status.',
		invalidPath: "$.status",
		invalidValue: "blocked",
	},
	{
		stageId: "state-data-impact",
		schemaFile: "api-contract-impact-control.schema.json",
		example: {
			schema: "stage-control-v1",
			digest: "Brief assessment.",
			status: "unknown",
			impacts: [],
			assumptions: [],
		},
		guidance:
			'status: none|low|medium|high|unknown; use impacts for blockers, never "blocked" in status.',
		invalidPath: "$.status",
		invalidValue: "blocked",
	},
	{
		stageId: "validation-impact",
		schemaFile: "validation-impact-control.schema.json",
		example: {
			schema: "stage-control-v1",
			digest: "Brief assessment.",
			coverageStatus: "unknown",
			coveredAreas: [],
			missingValidation: [],
			recommendedCommands: [],
			assumptions: [],
		},
		guidance:
			'coverageStatus: none|partial|strong|unknown; put gaps in missingValidation, never "insufficient" in coverageStatus.',
		invalidPath: "$.coverageStatus",
		invalidValue: "insufficient",
	},
	{
		stageId: "contract-consistency",
		schemaFile: "contract-consistency-control.schema.json",
		example: {
			schema: "stage-control-v1",
			digest: "Brief assessment.",
			status: "unknown",
			issues: [],
			confirmedConsistencies: [],
		},
		guidance:
			'status: pass|warn|fail|unknown; put severity in issues, never "high" or "blocked" in status.',
		invalidPath: "$.status",
		invalidValue: "high",
	},
	{
		stageId: "regression-risk",
		schemaFile: "regression-risk-control.schema.json",
		example: {
			schema: "stage-control-v1",
			digest: "Brief assessment.",
			riskLevel: "unknown",
			risks: [],
			riskReducers: [],
		},
		guidance:
			'riskLevel: none|low|medium|high|unknown; put blockers in risks, never "blocker" in riskLevel.',
		invalidPath: "$.riskLevel",
		invalidValue: "blocker",
	},
];

function rawOutput(control) {
	return [
		`<control>${JSON.stringify(control)}</control>`,
		"<analysis>Provider-free enum guidance fixture.</analysis>",
		"<refs>[]</refs>",
	].join("\n");
}

test("impact-review enum-bearing reducers show schema-valid controls and reject measured drift values", async () => {
	const loaded = await loadWorkflowSpec(specPath, repoRoot);
	const compiled = await compileWorkflow(loaded.spec, {
		cwd: repoRoot,
		specPath,
		task: "Review a fixture change without provider calls.",
	});

	for (const fixture of cases) {
		const task = compiled.tasks.find(
			(candidate) =>
				candidate.stageId === `impact-analysis.${fixture.stageId}`,
		);
		assert.ok(task, `missing compiled task for ${fixture.stageId}`);
		const exampleText = `using this schema-valid shape (choose values from evidence): ${JSON.stringify(fixture.example)}.`;
		assert.ok(
			task.compiledPrompt.includes(exampleText),
			`${fixture.stageId} prompt omitted ${exampleText}`,
		);
		assert.ok(
			task.compiledPrompt.includes(fixture.guidance),
			`${fixture.stageId} prompt omitted enum guidance`,
		);

		const schemaPath = join(
			repoRoot,
			"workflows/impact-review/schemas",
			fixture.schemaFile,
		);
		const schema = JSON.parse(await readFile(schemaPath, "utf8"));
		assert.deepEqual(validateJsonSchema(fixture.example, schema), {
			valid: true,
			issues: [],
		});
		const accepted = await validateWorkflowOutputForBundle(
			rawOutput(fixture.example),
			{ controlJsonSchema: schema },
		);
		assert.equal(
			accepted.valid,
			true,
			`${fixture.stageId}: ${JSON.stringify(accepted.issues)}`,
		);

		const historicalDrift = {
			...fixture.example,
			[fixture.invalidPath.slice(2)]: fixture.invalidValue,
		};
		const rejected = await validateWorkflowOutputForBundle(
			rawOutput(historicalDrift),
			{ controlJsonSchema: schema },
		);
		assert.equal(rejected.valid, false, fixture.stageId);
		assert.ok(
			rejected.issues.some((issue) => issue.path === fixture.invalidPath),
			`${fixture.stageId}: ${JSON.stringify(rejected.issues)}`,
		);
	}
});
