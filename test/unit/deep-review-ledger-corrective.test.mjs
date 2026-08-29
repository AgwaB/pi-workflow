import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { validateJsonSchema } from "../../.tmp/unit/json-schema.js";

const workflowRoot = join(process.cwd(), "workflows", "deep-review");
const root = join(workflowRoot, "helpers");
const pipeline = (await import(pathToFileURL(join(root, "finding-pipeline.mjs")).href)).default;
const render = (await import(pathToFileURL(join(root, "render-review-report.mjs")).href)).default;
const workflowSpec = JSON.parse(
	readFileSync(join(workflowRoot, "spec.json"), "utf8"),
);
const reviewerSchema = JSON.parse(
	readFileSync(
		join(
			workflowRoot,
			"schemas",
			"deep-review-reviewers-control.schema.json",
		),
		"utf8",
	),
);
const renderSchema = JSON.parse(
	readFileSync(
		join(workflowRoot, "schemas", "deep-review-render-control.schema.json"),
		"utf8",
	),
);

const finding = (id, file, extra = {}) => ({
	findingId: id,
	rootCauseId: `rc-${id}`,
	title: `${id} behavioral finding`,
	severity: "high",
	file,
	locations: [{ file, line: 4 }],
	evidence: `Observed ${id}`,
	evidenceQuotes: [`${id}()`],
	rationale: `Risk from ${id}`,
	recommendedAction: `Fix ${id}`,
	confidence: "high",
	...extra,
});

const verdict = (id, value, title = `${id} behavioral finding`) => ({
	findingId: id,
	finding: title,
	verdict: value,
	evidence: [`checked ${id}`],
	counterEvidence: [],
	recommendedAction: `Act on ${id}`,
});

test("deep-review replays partial consumers after a dependency resume", () => {
	const stages = new Map(
		workflowSpec.artifactGraph.stages.map((stage) => [stage.id, stage]),
	);
	for (const stageId of ["dedup-findings", "partition-verdicts", "final"]) {
		const stage = stages.get(stageId);
		assert.equal(stage.sourcePolicy, "partial", stageId);
		assert.equal(
			stage.inputPolicy?.invalidateOnDependencyResume,
			true,
			stageId,
		);
	}
});

test("deep-review verifies exact read/OCR coverage and fails partial rendering closed", async (t) => {
	const schemaControl = {
		schema: "stage-control-v1",
		digest: "coverage schema fixture",
		lens: "runtime",
		findings: [],
		evidenceChecked: ["src/runtime.ts"],
		sourceCoverage: [
			{
				path: "src/runtime.ts",
				status: "read",
				evidence: "function run()",
				artifact: "",
				reason: "",
			},
		],
		noIssueNotes: ["No issue."],
	};
	assert.equal(validateJsonSchema(schemaControl, reviewerSchema).valid, true);
	for (const sourceCoverage of [
		[{ ...schemaControl.sourceCoverage[0], evidence: "" }],
		[{
			...schemaControl.sourceCoverage[0],
			status: "ocr-extracted",
			artifact: "",
		}],
		[{
			...schemaControl.sourceCoverage[0],
			status: "metadata-only",
			evidence: "forged",
			reason: "metadata only",
		}],
		[{
			...schemaControl.sourceCoverage[0],
			status: "unreadable",
			evidence: "",
			reason: "",
		}],
	]) {
		assert.equal(
			validateJsonSchema(
				{ ...schemaControl, sourceCoverage },
				reviewerSchema,
			).valid,
			false,
		);
	}

	const coverageRoot = mkdtempSync(
		join(tmpdir(), "pi-workflow-deep-review-coverage-"),
	);
	t.after(() => rmSync(coverageRoot, { recursive: true, force: true }));
	mkdirSync(join(coverageRoot, "src"), { recursive: true });
	mkdirSync(join(coverageRoot, ".pi", "ocr-artifacts"), {
		recursive: true,
	});
	writeFileSync(
		join(coverageRoot, "src", "runtime.ts"),
		"export function run() { return true; }\n",
	);
	const sourceBytes = "%PDF fixture\n";
	const artifactBytes = "Finding QS-1\n";
	writeFileSync(join(coverageRoot, "image-only.pdf"), sourceBytes);
	writeFileSync(
		join(coverageRoot, ".pi", "ocr-artifacts", "image-only.ocr.txt"),
		artifactBytes,
	);
	writeFileSync(
		join(coverageRoot, ".pi", "ocr-artifacts", "unbound.ocr.txt"),
		artifactBytes,
	);
	mkdirSync(join(coverageRoot, "outside-ocr"), { recursive: true });
	writeFileSync(
		join(coverageRoot, "outside-ocr", "linked.ocr.txt"),
		artifactBytes,
	);
	symlinkSync(
		join(coverageRoot, "outside-ocr"),
		join(coverageRoot, ".pi", "ocr-artifacts", "linked"),
		"dir",
	);
	writeFileSync(
		join(
			coverageRoot,
			".pi",
			"ocr-artifacts",
			"image-only.ocr.txt.binding.json",
		),
		JSON.stringify({
			schema: "deep-review-ocr-binding-v1",
			sourcePath: "image-only.pdf",
			sourceSha256: createHash("sha256").update(sourceBytes).digest("hex"),
			artifactPath: ".pi/ocr-artifacts/image-only.ocr.txt",
			artifactSha256: createHash("sha256")
				.update(artifactBytes)
				.digest("hex"),
		}),
	);

	const statuses = [
		{ source: "triage", specId: "triage", taskId: "triage-task", stageId: "triage", status: "completed" },
		{ source: "reviewers.runtime", specId: "reviewers.runtime", taskId: "reviewer-task", stageId: "reviewers", itemIdentity: "runtime", placeholderSpecId: "reviewers.item", status: "completed" },
	];
	const context = { cwd: coverageRoot, sourceStatuses: statuses };
	const triage = {
		reviewLenses: [{
			id: "runtime",
			evidenceToInspect: ["image-only.pdf", "src/runtime.ts"],
		}],
	};
	const coverageFinding = finding(
		"runtime-coverage",
		"src/runtime.ts",
	);
	const reviewer = {
		lens: "runtime",
		findings: [coverageFinding],
		evidenceChecked: ["image-only.pdf", "src/runtime.ts"],
		sourceCoverage: [
			{ path: "image-only.pdf", status: "unreadable", evidence: "", artifact: "", reason: "OCR unavailable" },
			{ path: "src/runtime.ts", status: "read", evidence: "function run()", artifact: "", reason: "" },
		],
		noIssueNotes: ["No issue in the readable scope."],
	};
	const dedup = await pipeline({
		sources: { triage, "reviewers.runtime": reviewer },
		context,
		options: { mode: "dedup" },
	});
	assert.equal(dedup.reviewerLedger.complete, true);
	assert.equal(dedup.findings[0].sourceCoverageComplete, false);
	assert.equal(dedup.sourceStatusSummary.nonCompleted, 1);
	assert.equal(
		dedup.sourceStatusSummary.partialFailures[0].status,
		"source_coverage_incomplete",
	);
	assert.equal(
		dedup.sourceStatusSummary.partialFailures[0].sourcePath,
		"image-only.pdf",
	);

	const partition = await pipeline({
		sources: {
			"dedup-findings.main": dedup,
			"devil-advocate.runtime-coverage": verdict(
				"runtime-coverage",
				"KEEP",
				coverageFinding.title,
			),
		},
		context: {
			sourceStatuses: [
				{
					source: "dedup-findings.main",
					specId: "dedup-findings.main",
					taskId: "dedup-task",
					status: "completed",
				},
				{
					source: "devil-advocate.runtime-coverage",
					specId: "devil-advocate.runtime-coverage",
					taskId: "verifier-task",
					stageId: "devil-advocate",
					itemIdentity: "runtime-coverage",
					placeholderSpecId: "devil-advocate.item",
					status: "completed",
				},
			],
		},
		options: { mode: "partition", dedupStage: "dedup-findings" },
	});
	assert.equal(partition.partitionSummary.keep, 0);
	assert.equal(partition.partitionSummary.needsHuman, 1);
	assert.match(
		partition.partitions.needsHuman[0].note,
		/originating reviewer did not complete required source coverage/u,
	);
	const output = await render({
		sources: {
			"partition-verdicts.main": partition,
			report: { summary: "Required PDF was unreadable.", verdict: "PARTIAL_REVIEW" },
		},
	});
	assert.equal(output.status, "failed", JSON.stringify(output.gates));
	assert.equal(output.verdict, "PARTIAL_REVIEW");
	assert.equal(output.gates.passed, false);
	assert.equal(validateJsonSchema(output, renderSchema).valid, true);
	for (const mutate of [
		(value) => {
			value.verdict = "NEEDS_WORK";
		},
		(value) => {
			value.gates.passed = true;
		},
		(value) => {
			value.blockers = ["unexpected blocker"];
		},
	]) {
		const invalid = structuredClone(output);
		mutate(invalid);
		assert.equal(validateJsonSchema(invalid, renderSchema).valid, false);
	}
	assert.match(output.markdown, /Verdict: \*\*PARTIAL_REVIEW\*\*/u);
	assert.match(output.markdown, /Required source coverage gaps/u);
	assert.match(output.markdown, /image-only\.pdf/u);
	assert.match(output.markdown, /unreadable/u);

	const validCoverage = [
		{ path: "image-only.pdf", status: "ocr-extracted", evidence: "Finding QS-1", artifact: ".pi/ocr-artifacts/image-only.ocr.txt", reason: "" },
		{ path: "src/runtime.ts", status: "read", evidence: "function run()", artifact: "", reason: "" },
	];
	const ocrDedup = await pipeline({
		sources: {
			triage,
			"reviewers.runtime": { ...reviewer, sourceCoverage: validCoverage },
		},
		context,
		options: { mode: "dedup" },
	});
	assert.equal(ocrDedup.sourceStatusSummary.nonCompleted, 0);

	for (const [name, sourceCoverage, expectedReason] of [
		[
			"unlinked OCR",
			validCoverage.map((row) =>
				row.path === "image-only.pdf" ? { ...row, artifact: "" } : row,
			),
			/OCR artifact missing/u,
		],
		[
			"whitespace OCR artifact",
			validCoverage.map((row) =>
				row.path === "image-only.pdf"
					? { ...row, artifact: " .pi/ocr-artifacts/image-only.ocr.txt" }
					: row,
			),
			/OCR artifact path is invalid/u,
		],
		[
			"symlinked OCR parent",
			validCoverage.map((row) =>
				row.path === "image-only.pdf"
					? {
							...row,
							artifact:
								".pi/ocr-artifacts/linked/linked.ocr.txt",
						}
					: row,
			),
			/OCR artifact resolves outside|symlinked directory/u,
		],
		[
			"unbound OCR artifact",
			validCoverage.map((row) =>
				row.path === "image-only.pdf"
					? { ...row, artifact: ".pi/ocr-artifacts/unbound.ocr.txt" }
					: row,
			),
			/OCR source binding is unavailable/u,
		],
		[
			"forged OCR quote",
			validCoverage.map((row) =>
				row.path === "image-only.pdf" ? { ...row, evidence: "fabricated OCR quote" } : row,
			),
			/OCR quote was not found/u,
		],
		[
			"forged read quote",
			validCoverage.map((row) =>
				row.path === "src/runtime.ts" ? { ...row, evidence: "fabricated source quote" } : row,
			),
			/content quote was not found/u,
		],
		[
			"whitespace-normalized path",
			validCoverage.map((row) =>
				row.path === "src/runtime.ts" ? { ...row, path: "src/runtime.ts " } : row,
			),
			/unexpected coverage row/u,
		],
	]) {
		const invalid = await pipeline({
			sources: {
				triage,
				"reviewers.runtime": { ...reviewer, sourceCoverage },
			},
			context,
			options: { mode: "dedup" },
		});
		assert.equal(invalid.sourceStatusSummary.nonCompleted, 1, name);
		assert.match(
			invalid.sourceStatusSummary.partialFailures[0].statusDetail,
			expectedReason,
			name,
		);
	}

	const duplicatePlan = await pipeline({
		sources: {
			triage: {
				reviewLenses: [{
					id: "runtime",
					evidenceToInspect: ["src/runtime.ts", "src/runtime.ts"],
				}],
			},
			"reviewers.runtime": {
				...reviewer,
				evidenceChecked: ["src/runtime.ts"],
				sourceCoverage: [validCoverage[1]],
			},
		},
		context,
		options: { mode: "dedup" },
	});
	assert.equal(duplicatePlan.sourceStatusSummary.nonCompleted, 1);
	assert.match(
		duplicatePlan.sourceStatusSummary.partialFailures[0].statusDetail,
		/planned coverage path is duplicated/u,
	);
});

test("deep-review duplicate merge remains incomplete in either reviewer order", async (t) => {
	const coverageRoot = mkdtempSync(
		join(tmpdir(), "pi-workflow-deep-review-merge-"),
	);
	t.after(() => rmSync(coverageRoot, { recursive: true, force: true }));
	mkdirSync(join(coverageRoot, "src"), { recursive: true });
	writeFileSync(join(coverageRoot, "src", "shared.ts"), "sharedExact()\n");
	const lenses = ["first", "second"];
	const triage = {
		reviewLenses: lenses.map((id) => ({
			id,
			evidenceToInspect: ["src/shared.ts"],
		})),
	};
	const statuses = [
		{ source: "triage", specId: "triage", taskId: "triage-task", stageId: "triage", status: "completed" },
		...lenses.map((id) => ({
			source: `reviewers.${id}`,
			specId: `reviewers.${id}`,
			taskId: `${id}-task`,
			stageId: "reviewers",
			itemIdentity: id,
			placeholderSpecId: "reviewers.item",
			status: "completed",
		})),
	];
	for (const incompleteLens of lenses) {
		const reviewerSources = Object.fromEntries(
			lenses.map((id) => [
				`reviewers.${id}`,
				{
					lens: id,
					findings: [
						finding(`shared-${id}`, "src/shared.ts", {
							title: "Shared duplicate finding",
							rootCauseId: "root-shared",
							locations: [{ file: "src/shared.ts", line: 1 }],
							evidence: "sharedExact()",
							evidenceQuotes: ["sharedExact()"],
						}),
					],
					evidenceChecked: ["src/shared.ts"],
					sourceCoverage: [
						{
							path: id === incompleteLens ? "src/shared.ts " : "src/shared.ts",
							status: "read",
							evidence: "sharedExact()",
							artifact: "",
							reason: "",
						},
					],
					noIssueNotes: [],
				},
			]),
		);
		const result = await pipeline({
			sources: { triage, ...reviewerSources },
			options: { mode: "dedup" },
			context: { cwd: coverageRoot, sourceStatuses: statuses },
		});
		assert.equal(result.findings.length, 1, incompleteLens);
		assert.equal(result.findings[0].sourceCoverageComplete, false, incompleteLens);
		assert.ok(result.findings[0].sourceCoverageIssuePaths.length > 0);
	}
});

test("deep-review grounds structured singleton verifier evidence", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-workflow-deep-review-verifier-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	mkdirSync(join(cwd, "src"), { recursive: true });
	writeFileSync(join(cwd, "src", "verifier.ts"), "const danger = true;\n");
	const verifierFinding = finding("verifier-grounding", "src/verifier.ts", {
		title: "Verifier grounding finding",
		locations: [{ file: "src/verifier.ts", line: 1 }],
		evidence: "const danger = true;",
		evidenceQuotes: ["const danger = true;"],
	});
	const statuses = [
		{ source: "triage", specId: "triage", taskId: "triage-task", stageId: "triage", status: "completed" },
		{ source: "reviewers.runtime", specId: "reviewers.runtime", taskId: "reviewer-task", stageId: "reviewers", itemIdentity: "runtime", placeholderSpecId: "reviewers.item", status: "completed" },
		{ source: "devil-advocate.verifier-grounding", specId: "devil-advocate.verifier-grounding", taskId: "verifier-task", stageId: "devil-advocate", itemIdentity: "verifier-grounding", placeholderSpecId: "devil-advocate.item", status: "completed" },
	];
	const dedup = await pipeline({
		sources: {
			triage: {
				reviewLenses: [{
					id: "runtime",
					evidenceToInspect: ["src/verifier.ts:1"],
				}],
			},
			"reviewers.runtime": {
				lens: "runtime",
				findings: [verifierFinding],
				evidenceChecked: ["src/verifier.ts:1"],
				sourceCoverage: [
					{
						path: "src/verifier.ts:1",
						status: "read",
						evidence: "const danger = true;",
						artifact: "",
						reason: "",
					},
				],
				noIssueNotes: [],
			},
		},
		context: { cwd, sourceStatuses: statuses.slice(0, 2) },
		options: { mode: "dedup" },
	});
	const partitionFor = (quote) =>
		pipeline({
			sources: {
				"dedup-findings.main": dedup,
				"devil-advocate.verifier-grounding": {
					findingId: "verifier-grounding",
					finding: verifierFinding.title,
					verdict: "KEEP",
					evidence: [{ file: "src/verifier.ts", line: 1, quote }],
					counterEvidence: [],
					recommendedAction: "Disable danger.",
				},
			},
			context: { cwd, sourceStatuses: statuses },
			options: { mode: "partition", dedupStage: "dedup-findings" },
		});
	const valid = await partitionFor("const danger = true;");
	assert.equal(valid.partitionSummary.keep, 1);
	assert.equal(valid.partitionSummary.partialFailures, 0);
	const forged = await partitionFor("fabricated danger quote");
	assert.equal(forged.partitionSummary.keep, 0);
	assert.equal(forged.partitionSummary.needsHuman, 1);
	assert.equal(forged.partitionSummary.partialFailures, 1);
	assert.match(
		forged.partitions.needsHuman[0].note,
		/verifier evidence was not grounded/u,
	);
});

test("deep-review carries 26 mixed legacy recommendations through schema-valid partition and final rendering", async (t) => {
	const coverageRoot = mkdtempSync(
		join(tmpdir(), "pi-workflow-deep-review-recommendations-"),
	);
	t.after(() => rmSync(coverageRoot, { recursive: true, force: true }));
	mkdirSync(join(coverageRoot, "src"), { recursive: true });
	for (const file of ["correctness.ts", "reliability.ts", "test-quality.ts"]) {
		writeFileSync(
			join(coverageRoot, "src", file),
			`read src/${file}\n`,
		);
	}
	const devilSchema = JSON.parse(
		readFileSync(
			join(workflowRoot, "schemas", "deep-review-devil-advocate-control.schema.json"),
			"utf8",
		),
	);
	const partitionSchema = JSON.parse(
		readFileSync(
			join(workflowRoot, "schemas", "deep-review-partition-control.schema.json"),
			"utf8",
		),
	);
	const packetSchema = JSON.parse(
		readFileSync(
			join(workflowRoot, "schemas", "deep-review-report-packet-control.schema.json"),
			"utf8",
		),
	);
	const ids = Array.from(
		{ length: 26 },
		(_, index) => `finding-${String(index + 1).padStart(3, "0")}`,
	);
	const findings = ids.map((id, index) =>
		finding(id, `src/recommendation-${index + 1}.ts`),
	);
	const lenses = [
		{ id: "correctness", evidenceToInspect: ["src/correctness.ts"], findings: findings.slice(0, 9) },
		{ id: "reliability", evidenceToInspect: ["src/reliability.ts"], findings: findings.slice(9, 18) },
		{ id: "test-quality", evidenceToInspect: ["src/test-quality.ts"], findings: findings.slice(18) },
	];
	const dedupSources = {
		triage: {
			reviewLenses: lenses.map(({ id, evidenceToInspect }) => ({
				id,
				evidenceToInspect,
			})),
		},
	};
	const dedupStatuses = [
		{ source: "triage", specId: "triage", taskId: "triage-task", stageId: "triage", status: "completed" },
	];
	for (const lens of lenses) {
		const source = `reviewers.${lens.id}`;
		dedupSources[source] = {
			lens: lens.id,
			findings: lens.findings,
			evidenceChecked: [...lens.evidenceToInspect],
			sourceCoverage: lens.evidenceToInspect.map((path) => ({
				path,
				status: "read",
				evidence: `read ${path}`,
				artifact: "",
				reason: "",
			})),
			noIssueNotes: [],
		};
		dedupStatuses.push({
			source,
			specId: source,
			taskId: `${lens.id}-task`,
			stageId: "reviewers",
			itemIdentity: lens.id,
			placeholderSpecId: "reviewers.item",
			status: "completed",
		});
	}
	const dedup = await pipeline({
		sources: dedupSources,
		options: { mode: "dedup" },
		context: { cwd: coverageRoot, sourceStatuses: dedupStatuses },
	});
	assert.equal(dedup.findings.length, 26);
	assert.equal(dedup.reviewerLedger.complete, true);

	const structuredAction = {
		fix: "preserve the recommendation",
		validation: ["npm test"],
	};
	const objectControl = {
		schema: "stage-control-v1",
		digest: "legacy object action",
		findingId: ids[0],
		finding: findings[0].title,
		verdict: "KEEP",
		evidence: [
			{
				file: "src/correctness.ts",
				line: 1,
				quote: "read src/correctness.ts",
			},
		],
		counterEvidence: [],
		recommendedAction: structuredAction,
	};
	const rejectedObject = validateJsonSchema(objectControl, devilSchema);
	assert.equal(rejectedObject.valid, false);
	assert.ok(
		rejectedObject.issues.some(
			(issue) => issue.path === "$.recommendedAction",
		),
	);
	assert.equal(
		validateJsonSchema(
			{ ...objectControl, recommendedAction: "Preserve the recommendation." },
			devilSchema,
		).valid,
		true,
	);

	const partitionSources = { "dedup-findings.main": dedup };
	const partitionStatuses = [{
		source: "dedup-findings.main",
		specId: "dedup-findings.main",
		taskId: "dedup-task",
		stageId: "dedup-findings",
		status: "completed",
	}];
	const legacyIds = new Set([ids[0], ids[6], ids[12], ids[18]]);
	for (const item of findings) {
		const source = `devil-advocate.${item.findingId}`;
		partitionSources[source] = {
			schema: "stage-control-v1",
			digest: `verdict for ${item.findingId}`,
			...verdict(item.findingId, "KEEP", item.title),
			recommendedAction: legacyIds.has(item.findingId)
				? structuredAction
				: `Act on ${item.findingId}`,
		};
		partitionStatuses.push({
			source,
			specId: source,
			taskId: `${item.findingId}-task`,
			stageId: "devil-advocate",
			itemIdentity: item.findingId,
			placeholderSpecId: "devil-advocate.item",
			status: "completed",
		});
	}
	const partition = await pipeline({
		sources: partitionSources,
		options: { mode: "partition", dedupStage: "dedup-findings" },
		context: { sourceStatuses: partitionStatuses },
	});
	assert.equal(partition.partitionSummary.keep, 26);
	assert.equal(partition.partitionSummary.needsHuman, 0);
	assert.equal(partition.verifierCoverage.complete, true);
	assert.equal(
		partition.normalizationNotes.filter((note) =>
			note.includes("legacy recommendedAction"),
		).length,
		4,
	);
	for (const bucket of Object.values(partition.partitions)) {
		for (const item of bucket) {
			assert.equal(typeof item.recommendedAction, "string");
		}
	}
	for (const bucket of ["keep", "weaken", "needsHuman"]) {
		for (const item of partition.reportContext[bucket]) {
			assert.equal(typeof item.recommendedAction, "string");
		}
		for (const item of partition.reportPacket.reportContext[bucket]) {
			assert.equal(typeof item.recommendedAction, "string");
		}
	}
	assert.doesNotMatch(JSON.stringify(partition), /\[object Object\]/u);
	assert.deepEqual(
		validateJsonSchema(
			{ schema: "stage-control-v1", ...partition },
			partitionSchema,
		),
		{ valid: true, issues: [] },
	);

	const packet = await pipeline({
		sources: { "partition-verdicts.main": partition },
		options: { mode: "report-packet", partitionStage: "partition-verdicts" },
	});
	assert.deepEqual(validateJsonSchema(packet, packetSchema), {
		valid: true,
		issues: [],
	});
	const output = await render({
		sources: {
			"partition-verdicts.main": partition,
			report: {
				summary: "All 26 findings retained.",
				verdict: "NEEDS_WORK",
			},
		},
	});
	assert.equal(output.status, "passed", JSON.stringify(output.gates));
	assert.equal(
		new Set(
			output.emissionRows
				.filter((row) => row.kind === "top-level")
				.map((row) => row.id),
		).size,
		26,
	);
	assert.doesNotMatch(output.markdown, /\[object Object\]/u);
});

test("deep-review ledger counts recursive lineage across every disposition and validates support target classes", async () => {
	const support = finding("support", "test/support.test.ts", {
		classification: "support-only",
		supportingFindingId: "rc-keep",
		mergedFindings: [finding("support-merged", "test/support.test.ts")],
	});
	const invalidDropTarget = finding("support-drop", "test/drop.test.ts", {
		classification: "support-only",
		supportingFindingId: "drop",
	});
	const invalidHumanTarget = finding("support-human", "test/human.test.ts", {
		classification: "support-only",
		supportingFindingId: "human",
	});
	const invalidSupportTarget = finding("support-support", "test/support-target.test.ts", {
		classification: "support-only",
		supportingFindingId: "support",
	});
	const human = finding("human", "src/human.ts", {
		mergedFindings: [{
			...finding("human-merged", "src/human.ts"),
			mergedFindings: [finding("human-merged-nested", "src/human.ts")],
		}],
	});
	const drop = finding("drop", "src/drop.ts", {
		mergedFindings: [finding("drop-merged", "src/drop.ts")],
	});
	const items = [
		finding("keep", "src/keep.ts"),
		finding("weaken", "src/weaken.ts"),
		drop,
		human,
		support,
		invalidDropTarget,
		invalidHumanTarget,
		invalidSupportTarget,
	];
	const sources = { "dedup-findings.main": { findings: items } };
	for (const item of items) {
		const disposition = item.findingId === "keep" ? "KEEP" :
			item.findingId === "weaken" ? "WEAKEN" :
			item.findingId === "drop" ? "DROP" :
			item.findingId === "human" ? "NEEDS_HUMAN" : "KEEP";
		sources[`devil-advocate.${item.findingId}`] = verdict(item.findingId, disposition);
	}
	const result = await pipeline({
		sources,
		options: { mode: "partition", dedupStage: "dedup-findings" },
	});

	assert.deepEqual(result.partitions.keep.map((item) => item.findingId), ["keep"]);
	assert.deepEqual(result.partitions.weaken.map((item) => item.findingId), ["weaken"]);
	assert.deepEqual(result.partitions.drop.map((item) => item.findingId), ["drop"]);
	assert.equal(result.supportNotes.length, 1);
	assert.equal(result.supportNotes[0].supportingFindingId, "rc-keep");
	assert.deepEqual(
		result.partitions.needsHuman.filter((item) => item.findingId.startsWith("support-")).map((item) => [item.findingId, item.supportingFindingId]),
		[["support-drop", undefined], ["support-human", undefined], ["support-support", undefined]],
	);
	assert.equal(result.partitionSummary.mergedFindings, 4);
});

test("deep-review support rendering preserves exact provenance and structured emission rows", async () => {
	const statuses = [
		{ source: "triage", specId: "triage", taskId: "triage-task", stageId: "triage", status: "completed" },
		{ source: "reviewers.runtime", specId: "reviewers.runtime", taskId: "reviewer-task", stageId: "reviewers", itemIdentity: "runtime", placeholderSpecId: "reviewers.item", status: "completed" },
		{ source: "devil-advocate.root", specId: "devil-advocate.root", taskId: "root-task", stageId: "devil-advocate", itemIdentity: "root", placeholderSpecId: "devil-advocate.item", status: "completed" },
		{ source: "devil-advocate.support", specId: "devil-advocate.support", taskId: "support-task", stageId: "devil-advocate", itemIdentity: "support", placeholderSpecId: "devil-advocate.item", status: "completed" },
	];
	const rootFinding = finding("root", "src/root.ts", { title: "Runtime root", rootCauseId: "root-cause" });
	const supportFinding = finding("support", "test/root.test.ts", {
		classification: "support-only",
		supportingFindingId: "root-cause",
		title: "Regression coverage",
	});
	const dedup = await pipeline({
		sources: {
			triage: { reviewLenses: [{ id: "runtime" }] },
			"reviewers.runtime": { lens: "runtime", findings: [rootFinding, supportFinding], evidenceChecked: ["src/root.ts:4"], noIssueNotes: [] },
		},
		context: { sourceStatuses: statuses },
		options: { mode: "dedup" },
	});
	const partition = await pipeline({
		sources: {
			"dedup-findings.main": dedup,
			"devil-advocate.root": verdict("root", "KEEP", rootFinding.title),
			"devil-advocate.support": verdict("support", "KEEP", supportFinding.title),
		},
		context: { sourceStatuses: statuses },
		options: { mode: "partition", dedupStage: "dedup-findings" },
	});
	const output = await render({
		sources: {
			"partition-verdicts.main": partition,
			report: { summary: "Work remains", verdict: "NEEDS_WORK" },
		},
	});
	assert.equal(output.status, "passed", JSON.stringify(output.gates));
	assert.deepEqual(output.emissionRows, output.expectedEmissionRows);
	const supportRow = output.emissionRows.find((row) => row.kind === "support");
	assert.equal(supportRow.findingId, "support");
	assert.equal(supportRow.originalFindingId, "support");
	assert.equal(supportRow.rootCauseId, "rc-support");
	assert.equal(supportRow.supportingFindingId, "root-cause");
	assert.match(output.markdown, /Original finding ID: `support`/u);
	assert.match(output.markdown, /Root cause ID: `rc-support`/u);
	assert.match(output.markdown, /Supporting finding ID: `root-cause`/u);
	assert.match(output.markdown, /Reviewer owner:/u);
	assert.match(output.markdown, /Source lineage:/u);
});
