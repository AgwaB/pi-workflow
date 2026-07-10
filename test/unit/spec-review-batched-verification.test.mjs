import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { compileWorkflow } from "../../.tmp/unit/compiler.js";
import { parseWorkflow } from "../../.tmp/unit/schema.js";

const BATCH_CONTROL_SCHEMA = "spec-review-verify-findings-batch-v1";

async function loadHelper(tag) {
	return (
		await import(
			`../../workflows/spec-review/helpers/spec-review-pipeline.mjs?${tag}=${Date.now()}`
		)
	).default;
}

function candidate(id, title, severity = "medium") {
	return {
		id,
		title,
		severity,
		requirementIds: ["REQ-001"],
		claim: `claim for ${title}`,
		specEvidence: "docs/spec.md: relevant requirement text",
		implementationEvidence: "src/impl.ts: relevant implementation",
		testEvidence: "test/impl.test.ts: relevant test",
		uncertainty: "low",
	};
}

function validRow(id, title, verdict, severity = "medium") {
	return {
		id,
		title,
		verdict,
		severity,
		evidence: [`src/impl.ts:12: evidence for ${id}`],
		counterEvidence: [],
		finalClaim: `final claim ${id}`,
		recommendedAction: `action ${id}`,
	};
}

test("spec-review batch-candidates mode plans deterministic id-sorted batches", async () => {
	const helper = await loadHelper("plan");
	const result = await helper({
		sources: {
			"candidate-findings": {
				candidateFindings: [
					candidate("FINDING-003", "Gamma gap", "low"),
					candidate("FINDING-001", "Alpha gap", "high"),
					{ title: "No id gap", severity: "medium", claim: "missing id" },
					candidate("FINDING-002", "Beta gap"),
					candidate("FINDING-001", "Alpha gap duplicate", "high"),
				],
			},
		},
		options: { mode: "batch-candidates", maxBatchSize: 2 },
		context: {},
	});

	assert.equal(result.schema, "spec-review-verification-batches-v1");
	assert.equal(result.candidateCount, 4);
	assert.equal(result.batchCount, 2);
	assert.equal(result.maxBatchSize, 2);
	assert.deepEqual(result.duplicateCandidateIds, ["FINDING-001"]);
	assert.deepEqual(
		result.batches.map((batch) => batch.id),
		["vbatch-001", "vbatch-002"],
	);
	assert.deepEqual(
		result.batches.map((batch) => batch.candidateIds),
		[
			["candidate-003", "FINDING-001"],
			["FINDING-002", "FINDING-003"],
		],
	);
	// The id-less candidate is cloned with its deterministic fallback id so it
	// still receives verification coverage.
	const fallback = result.batches[0].candidates.find(
		(item) => item.id === "candidate-003",
	);
	assert.equal(fallback.title, "No id gap");
	// The duplicate id keeps its first occurrence only.
	const first = result.batches[0].candidates.find(
		(item) => item.id === "FINDING-001",
	);
	assert.equal(first.title, "Alpha gap");
	assert.match(result.digest, /2 verification batch\(es\), 4 candidate\(s\)/);
});

test("spec-review batched partition joins rows by id and fails closed on coverage gaps", async () => {
	const helper = await loadHelper("roundtrip");
	const candidates = [
		candidate("CF-001", "Alpha gap", "high"),
		candidate("CF-002", "Beta gap", "medium"),
		candidate("CF-003", "Gamma gap", "low"),
		candidate("CF-004", "Delta gap"),
		candidate("CF-005", "Epsilon gap"),
		candidate("CF-006", "Zeta gap"),
	];
	const batches = await helper({
		sources: { "candidate-findings": { candidateFindings: candidates } },
		options: { mode: "batch-candidates", maxBatchSize: 3 },
		context: {},
	});
	assert.deepEqual(
		batches.batches.map((batch) => batch.candidateIds),
		[
			["CF-001", "CF-002", "CF-003"],
			["CF-004", "CF-005", "CF-006"],
		],
	);

	const result = await helper({
		sources: {
			"candidate-findings": {
				candidateFindings: candidates,
				requirementCoverage: [{ requirementId: "REQ-001", status: "partial" }],
				needsHuman: [{ question: "Spec ambiguity?" }],
				noIssueNotes: ["REQ-009 satisfied"],
			},
			"verification-batches": batches,
			// First foreach child is exposed under the bare stage name; the batch id
			// must resolve through context.sourceStatuses.
			"verify-findings": {
				schema: BATCH_CONTROL_SCHEMA,
				digest: "batch one",
				results: [
					validRow("CF-001", "Alpha gap", "KEEP", "high"),
					validRow("CF-002", "Beta gap", "WEAKEN", "low"),
					validRow("CF-003", "Gamma gap", "DROP", "low"),
				],
			},
			"verify-findings.vbatch-002": {
				schema: BATCH_CONTROL_SCHEMA,
				digest: "batch two",
				results: [
					validRow("CF-004", "Delta gap", "NEEDS_HUMAN"),
					validRow("CF-006", "Zeta gap", "KEEP"),
					validRow("CF-006", "Zeta gap", "WEAKEN"),
					validRow("CF-999", "Unknown row", "KEEP"),
				],
			},
		},
		options: { mode: "partition" },
		context: {
			cwd: process.cwd(),
			sourceStatuses: [
				{
					source: "verify-findings",
					specId: "verify-findings.vbatch-001",
					stageId: "verify-findings",
					status: "completed",
				},
				{
					source: "verify-findings.vbatch-002",
					specId: "verify-findings.vbatch-002",
					stageId: "verify-findings",
					status: "completed",
				},
			],
		},
	});

	assert.equal(result.schema, "spec-review-partition-v1");
	assert.deepEqual(
		result.finalFindings.map((finding) => [finding.id, finding.verdict]),
		[
			["CF-001", "KEEP"],
			["CF-002", "WEAKEN"],
		],
	);
	assert.equal(result.finalFindings[0].severity, "high");
	assert.equal(result.finalFindings[1].severity, "low");
	assert.equal(result.finalFindings[0].claim, "final claim CF-001");
	assert.deepEqual(result.finalFindings[0].evidence, [
		"src/impl.ts:12: evidence for CF-001",
	]);
	assert.deepEqual(
		result.droppedFindings.map((finding) => finding.id),
		["CF-003"],
	);
	assert(
		result.needsHuman.some(
			(item) => item.source === "verifier" && item.id === "CF-004",
		),
	);
	assert.deepEqual(result.verifierCoverage.missingIds, ["CF-005"]);
	assert(
		result.needsHuman.some(
			(item) => item.source === "missing-verification" && item.id === "CF-005",
		),
	);
	assert.deepEqual(result.verifierCoverage.duplicateVerifierIds, ["CF-006"]);
	assert(
		result.needsHuman.some(
			(item) =>
				item.source === "batch-integrity" &&
				item.id === "CF-006" &&
				item.batchIntegrityIssue?.reason === "duplicate_batch_row_for_candidate",
		),
	);
	assert.deepEqual(result.verifierCoverage.orphanVerifierIds, ["CF-999"]);
	assert(
		result.needsHuman.some(
			(item) => item.source === "orphan-verifier" && item.id === "CF-999",
		),
	);
	assert(
		result.needsHuman.some((item) => item.source === "candidate-findings"),
	);
	assert.equal(result.verdictCounts.keep, 1);
	assert.equal(result.verdictCounts.weaken, 1);
	assert.equal(result.verdictCounts.drop, 1);
	assert.equal(result.verdictCounts.missingVerification, 1);
	assert.equal(result.verdictCounts.batchIntegrity, 2);
	assert.equal(result.verdictCounts.needsHuman, 5);
	assert.deepEqual(result.verifierCoverage.batch, {
		batchCount: 2,
		memberCount: 6,
		rowCount: 7,
		integrityIssueCount: 2,
	});
	assert.equal(result.batchIntegrityIssues.length, 2);
	assert.deepEqual(result.noIssueNotes, ["REQ-009 satisfied"]);
});

test("spec-review batched partition rejects malformed batch outputs and rows", async () => {
	const helper = await loadHelper("malformed");
	const candidates = [
		candidate("CF-001", "Alpha gap"),
		candidate("CF-002", "Beta gap"),
		candidate("CF-003", "Gamma gap"),
		candidate("CF-004", "Delta gap"),
		candidate("CF-005", "Epsilon gap"),
	];
	const batches = await helper({
		sources: { "candidate-findings": { candidateFindings: candidates } },
		options: { mode: "batch-candidates", maxBatchSize: 3 },
		context: {},
	});

	const result = await helper({
		sources: {
			"candidate-findings": { candidateFindings: candidates },
			"verification-batches": batches,
			// Wrong root schema literal: the whole batch is rejected, so even its
			// well-formed rows must not produce findings.
			"verify-findings": {
				schema: "./schemas/spec-review-verify-findings-batch-control.schema.json",
				digest: "wrong schema",
				results: [validRow("CF-001", "Alpha gap", "KEEP")],
			},
			"verify-findings.vbatch-002": {
				schema: BATCH_CONTROL_SCHEMA,
				digest: "batch two",
				results: [
					{ ...validRow("CF-004", "Delta gap", "KEEP"), unexpected: true },
					validRow("CF-005", "Wrong title echo", "KEEP"),
				],
			},
		},
		options: { mode: "partition" },
		context: {
			sourceStatuses: [
				{
					source: "verify-findings",
					specId: "verify-findings.vbatch-001",
					stageId: "verify-findings",
					status: "completed",
				},
			],
		},
	});

	assert.deepEqual(result.finalFindings, []);
	assert.deepEqual(result.droppedFindings, []);
	assert.deepEqual(result.verifierCoverage.missingIds, [
		"CF-001",
		"CF-002",
		"CF-003",
	]);
	assert(
		result.batchIntegrityIssues.some(
			(issue) =>
				issue.reason === "malformed_batch_output_invalid_schema" &&
				issue.batchId === "vbatch-001",
		),
	);
	assert(
		result.needsHuman.some(
			(item) =>
				item.source === "batch-integrity" &&
				item.id === "CF-004" &&
				item.batchIntegrityIssue?.reason === "malformed_batch_row_extra_fields",
		),
	);
	assert(
		result.needsHuman.some(
			(item) =>
				item.source === "batch-integrity" &&
				item.id === "CF-005" &&
				item.batchIntegrityIssue?.reason === "batch_row_title_mismatch",
		),
	);
	assert.equal(result.verdictCounts.keep, 0);
	assert.equal(result.verdictCounts.batchIntegrity, 3);
});

test("spec-review batched partition voids rows with invalid shape or stray batch ids", async () => {
	const helper = await loadHelper("void");
	const candidates = [
		candidate("CF-001", "Alpha gap"),
		candidate("CF-002", "Beta gap"),
		candidate("CF-003", "Gamma gap"),
		candidate("CF-004", "Delta gap"),
	];
	const batches = await helper({
		sources: { "candidate-findings": { candidateFindings: candidates } },
		options: { mode: "batch-candidates", maxBatchSize: 4 },
		context: {},
	});
	assert.equal(batches.batchCount, 1);

	const invalidVerdict = validRow("CF-002", "Beta gap", "KEEP");
	invalidVerdict.verdict = "keep";
	const stringEvidence = validRow("CF-003", "Gamma gap", "KEEP");
	stringEvidence.evidence = "should be an array";
	const missingSeverity = validRow("CF-004", "Delta gap", "KEEP");
	delete missingSeverity.severity;

	const result = await helper({
		sources: {
			"candidate-findings": { candidateFindings: candidates },
			"verification-batches": batches,
			"verify-findings": {
				schema: BATCH_CONTROL_SCHEMA,
				digest: "batch one",
				results: [
					validRow("CF-001", "Alpha gap", "KEEP"),
					invalidVerdict,
					stringEvidence,
					missingSeverity,
				],
			},
			// A stray output claiming an unknown batch id references CF-001; the
			// integrity gate must void CF-001's otherwise-valid row.
			"verify-findings.vbatch-999": {
				schema: BATCH_CONTROL_SCHEMA,
				digest: "stray batch",
				results: [validRow("CF-001", "Alpha gap", "KEEP")],
			},
		},
		options: { mode: "partition" },
		context: {
			sourceStatuses: [
				{
					source: "verify-findings",
					specId: "verify-findings.vbatch-001",
					stageId: "verify-findings",
					status: "completed",
				},
			],
		},
	});

	assert.deepEqual(result.finalFindings, []);
	assert.equal(result.verdictCounts.keep, 0);
	for (const [id, reason] of [
		["CF-001", "unknown_verification_batch_id"],
		["CF-002", "malformed_batch_row_invalid_verdict"],
		["CF-003", "malformed_batch_row_missing_evidence_array"],
		["CF-004", "malformed_batch_row_invalid_severity"],
	]) {
		assert(
			result.needsHuman.some(
				(item) =>
					item.source === "batch-integrity" &&
					item.id === id &&
					item.batchIntegrityIssue?.reason === reason,
			),
			`${id} should be NEEDS_HUMAN with ${reason}`,
		);
	}
	assert.deepEqual(result.verifierCoverage.missingIds, []);
});

test("spec-review partition without a batch stage keeps legacy single-verifier behavior", async () => {
	const helper = await loadHelper("legacy");
	const result = await helper({
		sources: {
			"candidate-findings.main": {
				candidateFindings: [
					candidate("FINDING-001", "Kept issue", "high"),
					candidate("FINDING-002", "Dropped issue"),
				],
			},
			"verify-findings.finding-001": {
				id: "FINDING-001",
				verdict: "KEEP",
				severity: "high",
				evidence: [{ file: "src/a.ts", quote: "a", relevance: "r" }],
				finalClaim: "Kept final claim",
			},
			"verify-findings.finding-002": {
				id: "FINDING-002",
				verdict: "DROP",
				finalClaim: "Not supported",
			},
		},
		options: { mode: "partition" },
		context: { cwd: process.cwd() },
	});

	assert.deepEqual(
		result.finalFindings.map((finding) => finding.id),
		["FINDING-001"],
	);
	assert.deepEqual(
		result.droppedFindings.map((finding) => finding.id),
		["FINDING-002"],
	);
	// Legacy mode keeps object-shaped evidence rows and gains no batch fields.
	assert.deepEqual(result.finalFindings[0].evidence, [
		{ file: "src/a.ts", quote: "a", relevance: "r" },
	]);
	assert.equal(result.batchIntegrityIssues, undefined);
	assert.equal(result.verdictCounts.batchIntegrity, undefined);
	assert.equal(result.verifierCoverage.batch, undefined);
});

test("spec-review batched verification variant is path-ref opt-in", async () => {
	const specPath = join(
		process.cwd(),
		"workflows",
		"spec-review",
		"batched-verification.spec.json",
	);
	const spec = parseWorkflow(JSON.parse(readFileSync(specPath, "utf8")));
	assert.equal(spec.name, "spec-review-batched-verification-opt-in");

	const compiled = await compileWorkflow(spec, {
		cwd: process.cwd(),
		task: "Compare docs/API_SPEC.md to src implementation and tests.",
		specPath,
	});
	const byKey = new Map(compiled.tasks.map((task) => [task.key, task]));

	const verificationBatches = byKey.get("verification-batches.main");
	assert.equal(verificationBatches?.kind, "support");
	assert.deepEqual(verificationBatches.dependsOn, ["candidate-findings.main"]);
	assert.equal(
		verificationBatches.support.uses,
		"./helpers/spec-review-pipeline.mjs",
	);
	assert.deepEqual(verificationBatches.support.options, {
		mode: "batch-candidates",
		candidateStage: "candidate-findings",
		maxBatchSize: 4,
	});

	const verifier = byKey.get("verify-findings.item");
	assert.equal(verifier?.kind, "foreach");
	assert.deepEqual(verifier.dependsOn, ["verification-batches.main"]);
	assert.deepEqual(verifier.foreach.from, {
		stage: "verification-batches",
		path: "$.batches",
	});
	assert.match(verifier.compiledPrompt ?? verifier.task ?? "", /results\[\]/);
	assert.ok(
		verifier.artifactGraph.output.controlSchemaPath.endsWith(
			join(
				"workflows",
				"spec-review",
				"schemas",
				"spec-review-verify-findings-batch-control.schema.json",
			),
		),
	);

	const partition = byKey.get("partition-findings.main");
	assert.equal(partition?.kind, "support");
	assert.deepEqual(partition.dependsOn, [
		"candidate-findings.main",
		"verification-batches.main",
		"verify-findings.item",
	]);
	assert.deepEqual(partition.support.options, {
		mode: "partition",
		candidateStage: "candidate-findings",
		verifyStage: "verify-findings",
		batchStage: "verification-batches",
	});

	const report = byKey.get("report.main");
	assert.equal(report?.kind, "reduce");
	assert.deepEqual(report.dependsOn, ["partition-findings.main"]);
	const reportStage = compiled.stages.find((stage) => stage.id === "report");
	assert.equal(reportStage.sourcePolicy, "require-success");
});

test("spec-review batched verifier prompt and schema demand strict row identity", () => {
	const specPath = join(
		process.cwd(),
		"workflows",
		"spec-review",
		"batched-verification.spec.json",
	);
	const schemaPath = join(
		process.cwd(),
		"workflows",
		"spec-review",
		"schemas",
		"spec-review-verify-findings-batch-control.schema.json",
	);
	const spec = JSON.parse(readFileSync(specPath, "utf8"));
	const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
	const stage = spec.artifactGraph.stages.find(
		(candidateStage) => candidateStage.id === "verify-findings",
	);
	const prompt = stage?.each?.prompt ?? "";

	assert.match(prompt, /root schema value must be exactly/);
	assert.match(prompt, /never use the controlSchema file path/);
	assert.match(prompt, /"schema":"spec-review-verify-findings-batch-v1"/);
	assert.match(prompt, /exactly one row for every input candidates\[\] item/);
	assert.match(prompt, /preserving each original candidate id and title exactly/);
	assert.match(
		prompt,
		/evidence and counterEvidence must be JSON arrays of strings/,
	);
	assert.match(prompt, /never emit either field as a string/);
	assert.match(prompt, /Row-local evidence only/);
	assert.match(prompt, /Example one-row <control>/);
	assert.match(prompt, /routed to NEEDS_HUMAN, never KEEP/);
	assert.match(prompt, /route those rows to NEEDS_HUMAN/);

	assert.equal(schema.additionalProperties, false);
	assert.deepEqual(schema.properties.schema.enum, [
		"spec-review-verify-findings-batch-v1",
	]);
	const rowSchema = schema.properties.results.items;
	assert.equal(rowSchema.additionalProperties, false);
	assert.deepEqual(rowSchema.required, [
		"id",
		"title",
		"verdict",
		"severity",
		"evidence",
		"counterEvidence",
		"finalClaim",
		"recommendedAction",
	]);
	assert.deepEqual(rowSchema.properties.verdict.enum, [
		"KEEP",
		"WEAKEN",
		"DROP",
		"NEEDS_HUMAN",
	]);
	assert.deepEqual(rowSchema.properties.severity.enum, [
		"high",
		"medium",
		"low",
		"info",
	]);
	assert.deepEqual(rowSchema.properties.evidence, {
		type: "array",
		items: { type: "string" },
	});
	assert.deepEqual(rowSchema.properties.counterEvidence, {
		type: "array",
		items: { type: "string" },
	});
});
