import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

function readJson(...parts) {
	return JSON.parse(readFileSync(join(process.cwd(), ...parts), "utf8"));
}

function stageMap(spec) {
	return new Map(spec.artifactGraph.stages.map((stage) => [stage.id, stage]));
}

const WORKFLOWS = [
	{
		id: "deep-review",
		defaultPath: ["workflows", "deep-review", "spec.json"],
		batchedPath: [
			"workflows",
			"deep-review",
			"batched-devil-advocate.spec.json",
		],
		allowedChangedStages: new Set([
			"devil-advocate-batches",
			"devil-advocate",
			"partition-verdicts",
		]),
		batchStage: "devil-advocate-batches",
	},
	{
		id: "deep-research",
		defaultPath: ["workflows", "deep-research", "spec.json"],
		batchedPath: [
			"workflows",
			"deep-research",
			"batched-verification.spec.json",
		],
		allowedChangedStages: new Set([
			"verification-batches",
			"verify-claims",
			"audit-claims",
		]),
		batchStage: "verification-batches",
	},
	{
		id: "spec-review",
		defaultPath: ["workflows", "spec-review", "spec.json"],
		batchedPath: ["workflows", "spec-review", "batched-verification.spec.json"],
		allowedChangedStages: new Set([
			"verification-batches",
			"verify-findings",
			"partition-findings",
		]),
		batchStage: "verification-batches",
	},
];

test("default-flip release gate: bundled default specs contain no batching stages or batch schemas", () => {
	for (const workflow of WORKFLOWS) {
		const defaultSpec = readJson(...workflow.defaultPath);
		const defaultStages = stageMap(defaultSpec);
		assert.ok(
			!defaultStages.has(workflow.batchStage),
			`${workflow.id} default spec must not contain batching stage ${workflow.batchStage}; a default flip requires a separately approved readiness decision`,
		);
		const rawDefault = JSON.stringify(defaultSpec);
		assert.ok(
			!/batch-control\.schema\.json/.test(rawDefault),
			`${workflow.id} default spec must not reference a batch control schema`,
		);
		assert.ok(
			!/batch-(devil-advocate|candidates|verification-candidates)/.test(
				rawDefault,
			),
			`${workflow.id} default spec must not invoke batch planning helper modes`,
		);
	}
});

test("batched variants only drift from defaults in explicit batching stages", () => {
	for (const workflow of WORKFLOWS) {
		const defaultSpec = readJson(...workflow.defaultPath);
		const batchedSpec = readJson(...workflow.batchedPath);
		assert.notEqual(
			batchedSpec.name,
			defaultSpec.name,
			`${workflow.id} batched path must not replace the default name`,
		);
		assert.match(
			batchedSpec.name,
			/opt-in$/,
			`${workflow.id} batched variant must stay opt-in`,
		);

		const defaultStages = stageMap(defaultSpec);
		const batchedStages = stageMap(batchedSpec);
		for (const [stageId, defaultStage] of defaultStages) {
			assert.ok(
				batchedStages.has(stageId),
				`${workflow.id} batched spec is missing default stage ${stageId}`,
			);
			if (workflow.allowedChangedStages.has(stageId)) continue;
			assert.deepEqual(
				batchedStages.get(stageId),
				defaultStage,
				`${workflow.id} non-batching stage drifted: ${stageId}`,
			);
		}

		for (const stageId of batchedStages.keys()) {
			if (defaultStages.has(stageId)) continue;
			assert.ok(
				workflow.allowedChangedStages.has(stageId),
				`${workflow.id} has unexpected added stage ${stageId}`,
			);
		}
		assert.ok(
			batchedStages.get(workflow.batchStage)?.support,
			`${workflow.id} batch stage must be deterministic support code`,
		);
	}
});

test("batched verifier schemas and prompts preserve strict row identity contracts", () => {
	const cases = [
		{
			id: "deep-review",
			specPath: [
				"workflows",
				"deep-review",
				"batched-devil-advocate.spec.json",
			],
			stageId: "devil-advocate",
			schemaPath: [
				"workflows",
				"deep-review",
				"schemas",
				"deep-review-devil-advocate-batch-control.schema.json",
			],
			schemaLiteral: "deep-review-devil-advocate-batch-v2",
		},
		{
			id: "deep-research",
			specPath: [
				"workflows",
				"deep-research",
				"batched-verification.spec.json",
			],
			stageId: "verify-claims",
			schemaPath: [
				"workflows",
				"deep-research",
				"schemas",
				"deep-research-verify-claims-batch-control.schema.json",
			],
			schemaLiteral: "deep-research-verify-claims-batch-v1",
		},
		{
			id: "spec-review",
			specPath: ["workflows", "spec-review", "batched-verification.spec.json"],
			stageId: "verify-findings",
			schemaPath: [
				"workflows",
				"spec-review",
				"schemas",
				"spec-review-verify-findings-batch-control.schema.json",
			],
			schemaLiteral: "spec-review-verify-findings-batch-v1",
		},
	];

	for (const item of cases) {
		const spec = readJson(...item.specPath);
		const stage = stageMap(spec).get(item.stageId);
		const prompt = stage?.each?.prompt ?? "";
		const schema = readJson(...item.schemaPath);
		assert.equal(schema.additionalProperties, false, item.id);
		assert.deepEqual(schema.required, ["schema", "digest", "results"], item.id);
		assert.deepEqual(
			schema.properties.schema.enum,
			[item.schemaLiteral],
			item.id,
		);
		assert.equal(schema.properties.results.type, "array", item.id);
		assert.equal(
			schema.properties.results.items.additionalProperties,
			false,
			item.id,
		);
		if (item.id === "deep-research") {
			assert.deepEqual(schema.properties.results.items.required, [
				"id",
				"status",
				"confidence",
				"verdictDigest",
				"evidence",
				"caveats",
				"correctionOrCounterclaim",
			]);
			assert.deepEqual(
				schema.properties.results.items.properties.evidence.items.required,
				["quote"],
			);
			assert.match(prompt, /confidence to be a number from 0 to 1/);
			const evidenceProperties =
				schema.properties.results.items.properties.evidence.items.properties;
			for (const field of [
				"line",
				"lineStart",
				"lineEnd",
				"lines",
				"excerptLocation",
			]) {
				assert.ok(evidenceProperties[field], `deep-research schema missing ${field}`);
				assert.match(prompt, new RegExp(`\\b${field}\\b`));
			}
			assert.ok(prompt.includes('"results":['));
			assert.ok(prompt.includes('"verdictDigest":{'));
			assert.match(prompt, /"evidence"\s*:\s*\[\]/);
			assert.ok(prompt.includes('"caveats":[]'));
			assert.doesNotMatch(
				prompt,
				/objects with source, url, dateOrYear, quote, and relevance/,
			);
			assert.match(
				prompt,
				/schema-aligned fields source, url, sourceRef, file, repo, line, lineStart, lineEnd, lines, excerptLocation/,
			);
			const defaultPrompt =
				stageMap(
					readJson("workflows", "deep-research", "spec.json"),
				).get("verify-claims")?.each?.prompt ?? "";
			assert.ok(defaultPrompt.includes('"verdictDigest":{'));
			assert.match(defaultPrompt, /"evidence"\s*:\s*\[\]/);
			assert.ok(defaultPrompt.includes('"caveats":[]'));
			assert.doesNotMatch(
				defaultPrompt,
				/objects with source, url, dateOrYear, quote, and relevance/,
			);
			assert.match(
				defaultPrompt,
				/schema-aligned fields source, url, sourceRef, file, repo, line, lineStart, lineEnd, lines, excerptLocation/,
			);
		}
		assert.match(prompt, /root schema value must be exactly/, item.id);
		assert.match(prompt, /never use the controlSchema file path/, item.id);
		assert.match(prompt, /results\[\]/, item.id);
		assert.ok(
			prompt.includes(`"${item.schemaLiteral}"`),
			`${item.id} prompt must show the exact schema literal`,
		);
	}
});

test("deep-research batched verifier keeps default audit guardrails while adding batch input", () => {
	const defaultSpec = readJson("workflows", "deep-research", "spec.json");
	const batchedSpec = readJson(
		"workflows",
		"deep-research",
		"batched-verification.spec.json",
	);
	const defaultAudit = stageMap(defaultSpec).get("audit-claims");
	const batchedAudit = stageMap(batchedSpec).get("audit-claims");

	assert.deepEqual(batchedAudit.support, defaultAudit.support);
	assert.deepEqual(batchedAudit.from, [
		"plan",
		"normalize-input-packet",
		"normalize-claims",
		"sanitize-claims",
		"verification-batches",
		"verify-claims",
	]);
});

test("batch partition helpers reject normalized but non-exact title echoes", async () => {
	const specReviewHelper = (
		await import(
			`../../workflows/spec-review/helpers/spec-review-pipeline.mjs?test=${Date.now()}`
		)
	).default;
	const specCandidates = [
		{
			id: "CF-001",
			title: "Alpha Gap",
			severity: "medium",
			requirementIds: ["REQ-001"],
			claim: "claim",
			specEvidence: "spec",
			implementationEvidence: "impl",
			testEvidence: "test",
			uncertainty: "low",
		},
	];
	const specBatches = await specReviewHelper({
		sources: { "candidate-findings": { candidateFindings: specCandidates } },
		options: { mode: "batch-candidates", maxBatchSize: 4 },
		context: {},
	});
	const specPartition = await specReviewHelper({
		sources: {
			"candidate-findings": { candidateFindings: specCandidates },
			"verification-batches": specBatches,
			"verify-findings.vbatch-001": {
				schema: "spec-review-verify-findings-batch-v1",
				digest: "case-only title drift",
				results: [
					{
						id: "CF-001",
						title: "alpha gap",
						verdict: "KEEP",
						severity: "medium",
						evidence: ["src/example.ts:1: evidence"],
						counterEvidence: [],
						finalClaim: "claim",
						recommendedAction: "fix",
					},
				],
			},
		},
		options: { mode: "partition" },
		context: {},
	});
	assert.deepEqual(specPartition.finalFindings, []);
	assert.equal(
		specPartition.needsHuman[0]?.batchIntegrityIssue?.reason,
		"batch_row_title_mismatch",
	);

	const deepReviewHelper = (
		await import(
			`../../workflows/deep-review/helpers/finding-pipeline.mjs?test=${Date.now()}`
		)
	).default;
	const findings = [
		{
			id: "F-001",
			findingId: "F-001",
			rootCauseId: "R-001",
			severity: "medium",
			title: "Alpha Runtime Regression",
			file: "src/example.ts",
			locations: [{ file: "src/example.ts", line: 1 }],
			evidenceQuotes: ["quote"],
		},
	];
	const reviewBatches = await deepReviewHelper({
		sources: { "dedup-findings.main": { findings } },
		options: {
			mode: "batch-devil-advocate",
			dedupStage: "dedup-findings",
			maxBatchSize: 4,
		},
	});
	const reviewPartition = await deepReviewHelper({
		sources: {
			"dedup-findings.main": { findings },
			"devil-advocate-batches.main": reviewBatches,
			"devil-advocate.dabatch-001": {
				schema: "deep-review-devil-advocate-batch-v2",
				digest: "case-only title drift",
				results: [
					{
						findingId: "F-001",
						title: "alpha runtime regression",
						verdict: "KEEP",
						evidenceSourceType: "concrete_artifact",
						evidence: ["src/example.ts:1: quote"],
						counterEvidence: [],
						recommendedAction: "fix",
					},
				],
			},
		},
		options: {
			mode: "partition",
			dedupStage: "dedup-findings",
			devilAdvocateBatchStage: "devil-advocate-batches",
		},
	});
	assert.deepEqual(reviewPartition.partitions.keep, []);
	assert.equal(
		reviewPartition.partitions.needsHuman[0]?.batchIntegrityIssue?.reason,
		"batch_result_title_mismatch",
	);
});
