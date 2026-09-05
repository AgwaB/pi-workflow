import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import renderSpecReviewReport from "../../workflows/spec-review/helpers/render-spec-review-report.mjs";
import renderImpactReport from "../../workflows/impact-review/helpers/render-impact-report.mjs";

function completeContext(cwd) {
	return {
		cwd,
		runId: "workflow_spec_report_contract",
		taskId: "task-final",
		sourceStatuses: [
			{
				source: "partition-findings",
				specId: "partition-findings.main",
				stageId: "partition-findings",
				taskId: "task-partition",
				status: "completed",
			},
			{
				source: "report",
				specId: "report.main",
				stageId: "report",
				taskId: "task-report",
				status: "completed",
			},
		],
	};
}

function cleanPartition() {
	return {
		schema: "spec-review-partition-v1",
		digest: "partition-digest",
		sourceStatusSummary: {
			metadataAvailable: true,
			total: 4,
			completed: 4,
			nonCompleted: 0,
			partialFailures: [],
		},
		verifierCoverage: {
			complete: true,
			candidateCount: 3,
			uniqueCandidateCount: 3,
			verifierCount: 3,
			uniqueVerifierCount: 3,
			verifiedCandidateCount: 3,
			missingIds: [],
			duplicateCandidateIds: [],
			duplicateVerifierIds: [],
			orphanVerifierIds: [],
			ownerLedger: [
				{ source: "verify-findings.FINDING-KEEP", stageId: "verify-findings", specId: "verify-findings.FINDING-KEEP", taskId: "task-keep", itemIdentity: "FINDING-KEEP", placeholderSpecId: "verify-findings.item", status: "completed" },
				{ source: "verify-findings.FINDING-DROP", stageId: "verify-findings", specId: "verify-findings.FINDING-DROP", taskId: "task-drop", itemIdentity: "FINDING-DROP", placeholderSpecId: "verify-findings.item", status: "completed" },
				{ source: "verify-findings.FINDING-HUMAN", stageId: "verify-findings", specId: "verify-findings.FINDING-HUMAN", taskId: "task-human", itemIdentity: "FINDING-HUMAN", placeholderSpecId: "verify-findings.item", status: "completed" },
			],
			verifierRows: [
				{ id: "FINDING-KEEP", owner: { source: "verify-findings.FINDING-KEEP", stageId: "verify-findings", specId: "verify-findings.FINDING-KEEP", taskId: "task-keep", itemIdentity: "FINDING-KEEP", placeholderSpecId: "verify-findings.item", status: "completed" } },
				{ id: "FINDING-DROP", owner: { source: "verify-findings.FINDING-DROP", stageId: "verify-findings", specId: "verify-findings.FINDING-DROP", taskId: "task-drop", itemIdentity: "FINDING-DROP", placeholderSpecId: "verify-findings.item", status: "completed" } },
				{ id: "FINDING-HUMAN", owner: { source: "verify-findings.FINDING-HUMAN", stageId: "verify-findings", specId: "verify-findings.FINDING-HUMAN", taskId: "task-human", itemIdentity: "FINDING-HUMAN", placeholderSpecId: "verify-findings.item", status: "completed" } },
			],
			ownerLedgerReconciliation: {
				ownerRowCount: 3,
				verifierRowCount: 3,
				ownerIds: ["FINDING-KEEP", "FINDING-DROP", "FINDING-HUMAN"],
				verifierIds: ["FINDING-KEEP", "FINDING-DROP", "FINDING-HUMAN"],
				duplicateOwnerIds: [],
				duplicateVerifierIds: [],
				missingOwnerRows: [],
				orphanOwnerRows: [],
				statusMismatches: [],
				cardinalityPassed: true,
				passed: true,
			},
		},
		verdictCounts: {
			keep: 1,
			weaken: 0,
			drop: 1,
			needsHuman: 1,
			missingVerification: 0,
			invalidVerifier: 0,
			orphanVerifier: 0,
		},
		requirementCoverage: [
			{ requirementId: "REQ-001", status: "gap", note: "## untrusted" },
			{ requirementId: "REQ-002", status: "covered" },
		],
		finalFindings: [
			{
				id: "FINDING-KEEP",
				verdict: "KEEP",
				severity: "high",
				title: "Unsafe `title` ## Related artifacts",
				requirementIds: ["REQ-001"],
				claim: "The implementation omits required behavior.",
				evidence: [
					{
						file: "src/example.ts",
						quote: "```\n## Related artifacts\nnot a real section",
						relevance: "confirms the gap",
					},
				],
				counterEvidence: [],
				recommendedAction: "Implement the requirement.",
			},
		],
		droppedFindings: [
			{
				id: "FINDING-DROP",
				title: "Refuted candidate",
				reason: "Counter-evidence refuted the claim.",
			},
		],
		needsHuman: [
			{
				source: "verifier",
				id: "FINDING-HUMAN",
				title: "Product intent is unclear",
				reason: "Requires domain judgment.",
			},
		],
		missingVerifications: [],
		invalidVerifierResults: [],
		orphanVerifierResults: [],
		noIssueNotes: ["REQ-002 is implemented and tested."],
	};
}

function report(verdict = "GAPS_FOUND") {
	return {
		schema: "spec-review-report-v1",
		digest: "overlay",
		summary: "One confirmed gap requires action; one item requires human judgment.",
		verdict,
		risks: ["Human intent remains unresolved."],
		recommendedNextAction: "Implement the gap and resolve product intent.",
	};
}

test("spec-review renderer preserves every legacy disposition but withholds ungrounded completion", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "spec-review-render-"));
	try {
		const partition = cleanPartition();
		const context = completeContext(cwd);
		const first = await renderSpecReviewReport({
			sources: {
				"report.main": report(),
				"partition-findings.main": partition,
			},
			context,
		});
		const reordered = await renderSpecReviewReport({
			sources: {
				"partition-findings.alias": partition,
				"report.alias": report(),
			},
			context: { ...context, taskId: undefined },
		});

		assert.equal(first.status, "failed");
		assert.equal(first.verdict, "INCONCLUSIVE"); // Legacy ledger has no attested requirement scope.
		assert.equal(first.gates.passed, false);
		assert.equal(first.gates.actionableEvidenceComplete, false);
		assert.deepEqual(first.renderedFindingIds, ["FINDING-KEEP"]);
		assert.deepEqual(first.renderedNeedsHumanIds, ["FINDING-HUMAN"]);
		assert.deepEqual(first.renderedDroppedFindingIds, ["FINDING-DROP"]);
		assert.equal(first.sidecarPath, "final-report.md");
		assert.equal(first.ledgerSidecarPath, "source-ledger.json");
		assert.equal(first.completionSummaryMarkdown, "");
		assert.ok(Array.from(first.completionSummaryMarkdown).length <= 6000);
		assert.doesNotMatch(
			first.completionSummaryMarkdown,
			/\.pi|final-report\.md|control\.json|refs\.json|Related artifacts/i,
		);
		assert.equal(first.markdown, reordered.markdown);
		assert.equal(first.digest, reordered.digest);
		assert.equal(
			readFileSync(
				join(
					cwd,
					".pi",
					"workflows",
					context.runId,
					"tasks",
					context.taskId,
					"final-report.md",
				),
				"utf8",
			),
			`${first.markdown}\n`,
		);
		const specLedger = JSON.parse(
			readFileSync(
				join(
					cwd,
					".pi",
					"workflows",
					context.runId,
					"tasks",
					context.taskId,
					"source-ledger.json",
				),
				"utf8",
			),
		);
		assert.equal(specLedger.schema, "spec-review-source-ledger-v1");
		assert.deepEqual(specLedger.partition.finalFindings, partition.finalFindings);

		const headings = [...first.markdown.matchAll(/^## ([^#].*)$/gm)].map(
			(match) => match[1],
		);
		assert.equal(headings[0], "Executive summary");
		assert.equal(headings.at(-1), "Related artifacts");
		assert.equal(
			headings.filter((heading) => heading === "Related artifacts").length,
			1,
		);
		assert.match(first.markdown, /````json[\s\S]*```\\n## Related artifacts/);
		assert.match(first.markdown, /### FINDING-KEEP — Unsafe \\`title\\` \\#\\# Related artifacts/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("spec-review renderer rejects a forged empty owner/verifier reconciliation", async () => {
	const partition = cleanPartition();
	partition.finalFindings = [];
	partition.droppedFindings = [];
	partition.needsHuman = [];
	partition.verifierCoverage = {
		complete: true,
		candidateCount: 0,
		uniqueCandidateCount: 0,
		verifierCount: 0,
		uniqueVerifierCount: 0,
		verifiedCandidateCount: 0,
		missingIds: [],
		duplicateCandidateIds: [],
		duplicateVerifierIds: [],
		orphanVerifierIds: [],
		ownerLedger: [],
		verifierRows: [],
		ownerLedgerReconciliation: {
			ownerRowCount: 0,
			verifierRowCount: 0,
			ownerIds: [],
			verifierIds: [],
			duplicateOwnerIds: [],
			duplicateVerifierIds: [],
			missingOwnerRows: [],
			orphanOwnerRows: [],
			statusMismatches: [],
			cardinalityPassed: true,
			passed: true,
		},
	};
	partition.verdictCounts = {
		keep: 0,
		weaken: 0,
		drop: 0,
		needsHuman: 0,
		missingVerification: 0,
		invalidVerifier: 0,
		orphanVerifier: 0,
	};
	const result = await renderSpecReviewReport({
		sources: {
			"partition-findings.main": partition,
			"report.main": report("INCONCLUSIVE"),
		},
		context: completeContext(undefined),
	});
	assert.equal(result.status, "failed");
	assert.equal(result.verdict, "INCONCLUSIVE");
	assert.equal(result.gates.ownerLedgerReconciliationPassed, false);
	assert.equal(result.gates.verifierCoverageComplete, false);
	assert.equal(result.completionSummaryMarkdown, "");
});

test("spec-review renderer rejects contradictory, duplicate, and orphan final lifecycle statuses", async () => {
	const partition = cleanPartition();
	const sources = {
		"partition-findings.main": partition,
		"report.main": report(),
	};
	const base = completeContext(undefined);
	const wrongStage = await renderSpecReviewReport({
		sources,
		context: {
			...base,
			sourceStatuses: base.sourceStatuses.map((status, index) =>
				index === 0 ? { ...status, stageId: "wrong-partition-stage" } : status,
			),
		},
	});
	assert.equal(wrongStage.status, "failed");
	assert.equal(wrongStage.gates.sourceCoverageComplete, false);

	const duplicate = await renderSpecReviewReport({
		sources,
		context: {
			...base,
			sourceStatuses: [...base.sourceStatuses, { ...base.sourceStatuses[0] }],
		},
	});
	assert.equal(duplicate.status, "failed");
	assert.equal(duplicate.gates.sourceCoverageComplete, false);

	const orphan = await renderSpecReviewReport({
		sources,
		context: {
			...base,
			sourceStatuses: [
				...base.sourceStatuses,
				{ source: "unrelated", specId: "unrelated.main", stageId: "unrelated", taskId: "task-unrelated", status: "completed" },
			],
		},
	});
	assert.equal(orphan.status, "failed");
	assert.equal(orphan.gates.sourceCoverageComplete, false);
});

function impactContext(cwd) {
	return {
		cwd,
		runId: "workflow_impact_report_contract",
		taskId: "task-impact-final",
		sourceStatuses: [
			"impact-synthesis",
			"contract-consistency",
			"regression-risk",
			"ship-readiness",
		].map((stageId) => ({
			source: `impact-analysis.${stageId}`,
			specId: `impact-analysis.${stageId}.main`,
			stageId: `impact-analysis.${stageId}`,
			taskId: `task-${stageId}`,
			status: "completed",
		})),
	};
}

function impactSources() {
	return {
		"impact-analysis.impact-synthesis": {
			schema: "impact-synthesis-v1",
			digest: "synthesis-digest",
			summary: "The change needs bounded follow-up before shipping.",
			verdict: "NEEDS_WORK",
			riskLevel: "medium",
			blockingIssues: [],
			nonBlockingIssues: [
				{ id: "ISSUE-1", text: "## Related artifacts ``` is untrusted" },
			],
			confirmedSafeAreas: [{ id: "SAFE-1", text: "API shape is unchanged." }],
			recommendedNextActions: [
				{ id: "ACTION-1", text: "Run the focused checks; ignore .pi/workflows/private/final-report.md." },
			],
			validationToRun: [{ id: "VALIDATE-1", command: "npm test" }],
			needsHuman: [],
		},
		"impact-analysis.contract-consistency": {
			schema: "contract-consistency-v1",
			digest: "contract-digest",
			status: "warn",
			issues: [{ id: "CONTRACT-1", text: "Package metadata needs alignment." }],
			confirmedConsistencies: [{ id: "CONSISTENT-1", text: "CLI behavior matches." }],
		},
		"impact-analysis.regression-risk": {
			schema: "regression-risk-v1",
			digest: "risk-digest",
			riskLevel: "medium",
			risks: [{ id: "RISK-1", text: "Compiler coverage can regress." }],
			riskReducers: [{ id: "REDUCER-1", text: "Run focused compiler tests." }],
		},
		"impact-analysis.ship-readiness": {
			schema: "ship-readiness-v1",
			digest: "ship-digest",
			status: "needs-work",
			requiredBeforeShip: [{ id: "SHIP-1", text: "Pass validation." }],
			niceToHave: [{ id: "NICE-1", text: "Add a broader fixture." }],
			assumptions: [{ id: "ASSUME-1", text: "No public API change." }],
		},
	};
}

test("impact-review renderer reconciles joins, preserves rows, and writes a safe completion envelope", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "impact-review-render-"));
	try {
		const sources = impactSources();
		const context = impactContext(cwd);
		const first = await renderImpactReport({ sources, context });
		const reordered = await renderImpactReport({
			sources: {
				"ship-readiness.alias": sources["impact-analysis.ship-readiness"],
				"regression-risk.alias": sources["impact-analysis.regression-risk"],
				"contract-consistency.alias": sources["impact-analysis.contract-consistency"],
				"impact-synthesis.alias": sources["impact-analysis.impact-synthesis"],
			},
			context: { ...context, taskId: undefined },
		});

		assert.equal(first.status, "passed");
		assert.equal(first.verdict, "NEEDS_WORK");
		assert.equal(first.riskLevel, "medium");
		assert.equal(first.gates.passed, true);
		assert.equal(first.gates.renderedAllStructuredItems, true);
		assert.equal(first.sidecarPath, "final-report.md");
		assert.equal(first.ledgerSidecarPath, "source-ledger.json");
		assert.ok(first.completionSummaryMarkdown.trim());
		assert.ok(Array.from(first.completionSummaryMarkdown).length <= 6000);
		assert.doesNotMatch(
			first.completionSummaryMarkdown,
			/\.pi|final-report\.md|control\.json|refs\.json|Related artifacts/i,
		);
		assert.equal(first.markdown, reordered.markdown);
		assert.equal(first.digest, reordered.digest);
		assert.equal(
			readFileSync(
				join(
					cwd,
					".pi",
					"workflows",
					context.runId,
					"tasks",
					context.taskId,
					"final-report.md",
				),
				"utf8",
			),
			`${first.markdown}\n`,
		);
		const impactLedger = JSON.parse(
			readFileSync(
				join(
					cwd,
					".pi",
					"workflows",
					context.runId,
					"tasks",
					context.taskId,
					"source-ledger.json",
				),
				"utf8",
			),
		);
		assert.equal(impactLedger.schema, "impact-review-source-ledger-v1");
		assert.deepEqual(
			impactLedger.shipReadiness,
			sources["impact-analysis.ship-readiness"],
		);
		const headings = [...first.markdown.matchAll(/^## ([^#].*)$/gm)].map(
			(match) => match[1],
		);
		assert.equal(headings[0], "Executive summary");
		assert.equal(headings.at(-1), "Related artifacts");
		assert.equal(headings.filter((heading) => heading === "Related artifacts").length, 1);
		for (const id of [
			"ISSUE-1",
			"SAFE-1",
			"ACTION-1",
			"VALIDATE-1",
			"CONTRACT-1",
			"CONSISTENT-1",
			"RISK-1",
			"REDUCER-1",
			"SHIP-1",
			"NICE-1",
			"ASSUME-1",
		]) assert.match(first.markdown, new RegExp(id));
		assert.match(first.markdown, /\\#\\# Related artifacts \\`\\`\\` is untrusted/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("impact-review renderer applies blocking and unknown precedence and fails closed on contradictions", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "impact-review-render-fail-"));
	try {
		const context = impactContext(cwd);
		const blocking = impactSources();
		blocking["impact-analysis.impact-synthesis"].verdict = "BLOCKED";
		blocking["impact-analysis.impact-synthesis"].riskLevel = "high";
		blocking["impact-analysis.impact-synthesis"].blockingIssues = [
			{ id: "BLOCK-1", text: "Release cannot proceed." },
		];
		blocking["impact-analysis.ship-readiness"].status = "blocked";
		const blockedVerdict = await renderImpactReport({ sources: blocking, context });
		assert.equal(blockedVerdict.status, "passed");
		assert.equal(blockedVerdict.verdict, "BLOCKED");

		const unknown = impactSources();
		unknown["impact-analysis.impact-synthesis"].verdict = "UNKNOWN";
		unknown["impact-analysis.impact-synthesis"].riskLevel = "unknown";
		unknown["impact-analysis.impact-synthesis"].needsHuman = [
			{ id: "HUMAN-1", text: "Confirm product intent." },
		];
		unknown["impact-analysis.regression-risk"].riskLevel = "unknown";
		const unknownVerdict = await renderImpactReport({ sources: unknown, context });
		assert.equal(unknownVerdict.status, "failed");
		assert.equal(unknownVerdict.verdict, "UNKNOWN");
		assert.equal(unknownVerdict.gates.riskGatePassed, false);
		assert.match(unknownVerdict.markdown, /HUMAN-1/);

		const contradiction = impactSources();
		contradiction["impact-analysis.impact-synthesis"].verdict = "READY";
		const contradictionResult = await renderImpactReport({
			sources: contradiction,
			context,
		});
		assert.equal(contradictionResult.status, "failed");
		assert.equal(contradictionResult.gates.verdictConsistent, false);
		assert.equal(contradictionResult.completionSummaryMarkdown, "");

		const understated = impactSources();
		understated["impact-analysis.impact-synthesis"].riskLevel = "low";
		understated["impact-analysis.regression-risk"].riskLevel = "high";
		const understatedResult = await renderImpactReport({ sources: understated, context });
		assert.equal(understatedResult.status, "failed");
		assert.equal(understatedResult.riskLevel, "high");
		assert.equal(understatedResult.gates.riskFloorConsistent, false);

		const missing = impactSources();
		delete missing["impact-analysis.ship-readiness"];
		const missingResult = await renderImpactReport({ sources: missing, context });
		assert.equal(missingResult.status, "blocked");
		assert.equal(missingResult.gates.allLedgerSourcesAvailable, false);
		assert.match(missingResult.markdown, /RISK-1/);

		const nonTerminalContext = impactContext(cwd);
		nonTerminalContext.sourceStatuses[3].status = "failed";
		const nonTerminal = await renderImpactReport({
			sources: impactSources(),
			context: nonTerminalContext,
		});
		assert.equal(nonTerminal.status, "blocked");
		assert.equal(nonTerminal.verdict, "UNKNOWN");
		assert.equal(nonTerminal.gates.sourceCoverageComplete, false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("spec-review renderer fails closed on verdict, source, evidence, and verifier-integrity gaps", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "spec-review-render-fail-"));
	try {
		const context = completeContext(cwd);
		const contradiction = await renderSpecReviewReport({
			sources: {
				"partition-findings.main": cleanPartition(),
				"report.main": report("CONFORMS"),
			},
			context,
		});
		assert.equal(contradiction.status, "failed");
		assert.equal(contradiction.gates.reportVerdictConsistent, false);
		assert.equal(contradiction.completionSummaryMarkdown, "");

		const partial = cleanPartition();
		partial.sourceStatusSummary = {
			metadataAvailable: true,
			total: 4,
			completed: 3,
			nonCompleted: 1,
			partialFailures: [{ specId: "verify-findings.missing", status: "failed" }],
		};
		const partialResult = await renderSpecReviewReport({
			sources: {
				"partition-findings.main": partial,
				"report.main": report("INCONCLUSIVE"),
			},
			context,
		});
		assert.equal(partialResult.verdict, "INCONCLUSIVE");
		assert.equal(partialResult.status, "failed");
		assert.equal(partialResult.gates.sourceCoverageComplete, false);

		const coverageMismatch = cleanPartition();
		coverageMismatch.finalFindings = [];
		coverageMismatch.droppedFindings = [];
		coverageMismatch.needsHuman = [];
		coverageMismatch.verifierCoverage = {
			candidateCount: 0,
			uniqueCandidateCount: 0,
			verifierCount: 1,
			uniqueVerifierCount: 1,
			verifiedCandidateCount: 0,
			missingIds: [],
			duplicateCandidateIds: [],
			duplicateVerifierIds: [],
			orphanVerifierIds: [],
		};
		coverageMismatch.verdictCounts = {
			keep: 0,
			weaken: 0,
			drop: 0,
			needsHuman: 0,
			missingVerification: 0,
			invalidVerifier: 0,
			orphanVerifier: 0,
		};
		const coverageMismatchResult = await renderSpecReviewReport({
			sources: {
				"partition-findings.main": coverageMismatch,
				"report.main": report("INCONCLUSIVE"),
			},
			context,
		});
		assert.equal(coverageMismatchResult.status, "failed");
		assert.equal(coverageMismatchResult.verdict, "INCONCLUSIVE");
		assert.equal(
			coverageMismatchResult.gates.verifierCoverageComplete,
			false,
		);

		const missingDisposition = cleanPartition();
		missingDisposition.finalFindings = [];
		missingDisposition.droppedFindings = [];
		missingDisposition.needsHuman = [];
		missingDisposition.verifierCoverage = {
			candidateCount: 1,
			uniqueCandidateCount: 1,
			verifierCount: 1,
			uniqueVerifierCount: 1,
			verifiedCandidateCount: 1,
			missingIds: [],
			duplicateCandidateIds: [],
			duplicateVerifierIds: [],
			orphanVerifierIds: [],
		};
		missingDisposition.verdictCounts = {
			keep: 0,
			weaken: 0,
			drop: 0,
			needsHuman: 0,
			missingVerification: 0,
			invalidVerifier: 0,
			orphanVerifier: 0,
		};
		const missingDispositionResult = await renderSpecReviewReport({
			sources: {
				"partition-findings.main": missingDisposition,
				"report.main": report("INCONCLUSIVE"),
			},
			context,
		});
		assert.equal(missingDispositionResult.status, "failed");
		assert.equal(missingDispositionResult.verdict, "INCONCLUSIVE");
		assert.equal(
			missingDispositionResult.gates.verifierCoverageComplete,
			false,
		);

		const excessDisposition = structuredClone(missingDisposition);
		excessDisposition.droppedFindings = [
			{ id: "DROP-1", reason: "first" },
			{ id: "DROP-2", reason: "second" },
		];
		excessDisposition.verdictCounts.drop = 2;
		const excessDispositionResult = await renderSpecReviewReport({
			sources: {
				"partition-findings.main": excessDisposition,
				"report.main": report("INCONCLUSIVE"),
			},
			context,
		});
		assert.equal(excessDispositionResult.status, "failed");
		assert.equal(excessDispositionResult.verdict, "INCONCLUSIVE");
		assert.equal(
			excessDispositionResult.gates.verifierCoverageComplete,
			false,
		);

		for (const invalidCount of ["0", -1]) {
			const invalidDomains = structuredClone(coverageMismatch);
			for (const key of [
				"candidateCount",
				"uniqueCandidateCount",
				"verifierCount",
				"uniqueVerifierCount",
				"verifiedCandidateCount",
			]) invalidDomains.verifierCoverage[key] = invalidCount;
			for (const key of Object.keys(invalidDomains.verdictCounts))
				invalidDomains.verdictCounts[key] = invalidCount;
			const invalidDomainResult = await renderSpecReviewReport({
				sources: {
					"partition-findings.main": invalidDomains,
					"report.main": report("INCONCLUSIVE"),
				},
				context,
			});
			assert.equal(invalidDomainResult.status, "failed");
			assert.equal(invalidDomainResult.verdict, "INCONCLUSIVE");
			assert.equal(
				invalidDomainResult.gates.verifierCoverageComplete,
				false,
			);
		}

		const noEvidence = cleanPartition();
		noEvidence.finalFindings[0].evidence = [];
		const noEvidenceResult = await renderSpecReviewReport({
			sources: {
				"partition-findings.main": noEvidence,
				"report.main": report(),
			},
			context,
		});
		assert.equal(noEvidenceResult.status, "failed");
		assert.equal(noEvidenceResult.gates.actionableEvidenceComplete, false);

		const integrity = cleanPartition();
		integrity.finalFindings = [];
		integrity.droppedFindings = [];
		integrity.needsHuman = [
			{ source: "missing-verification", id: "FINDING-MISSING", reason: "missing" },
			{ source: "orphan-verifier", id: "FINDING-ORPHAN", reason: "orphan" },
			{ source: "batch-integrity", id: "FINDING-BATCH", reason: "batch mismatch" },
			{ source: "invalid-verifier", reason: "missing id" },
		];
		integrity.missingVerifications = [{ id: "FINDING-MISSING", reason: "missing" }];
		integrity.orphanVerifierResults = [{ id: "FINDING-ORPHAN", verdict: "KEEP" }];
		integrity.invalidVerifierResults = [{ reason: "missing_id", result: {} }];
		integrity.batchIntegrityIssues = [{ id: "FINDING-BATCH", reason: "title_mismatch" }];
		integrity.verifierCoverage = {
			candidateCount: 2,
			uniqueCandidateCount: 2,
			verifierCount: 3,
			uniqueVerifierCount: 2,
			verifiedCandidateCount: 1,
			missingIds: ["FINDING-MISSING"],
			duplicateCandidateIds: [],
			duplicateVerifierIds: [],
			orphanVerifierIds: ["FINDING-ORPHAN"],
		};
		integrity.verdictCounts = {
			keep: 0,
			weaken: 0,
			drop: 0,
			needsHuman: 4,
			missingVerification: 1,
			invalidVerifier: 1,
			orphanVerifier: 1,
			batchIntegrity: 1,
		};
		const integrityResult = await renderSpecReviewReport({
			sources: {
				"partition-findings.main": integrity,
				"report.main": report("NEEDS_HUMAN"),
			},
			context,
		});
		assert.equal(integrityResult.verdict, "INCONCLUSIVE"); // Missing requirement proof takes precedence.
		assert.equal(integrityResult.status, "failed");
		assert.equal(integrityResult.gates.verifierCoverageComplete, false);
		assert.deepEqual(integrityResult.renderedNeedsHumanIds, [
			"FINDING-MISSING",
			"FINDING-ORPHAN",
			"FINDING-BATCH",
			"needs-human-row-004",
		]);
		for (const id of integrityResult.renderedNeedsHumanIds)
			assert.match(integrityResult.markdown, new RegExp(id));

		const noMetadata = await renderSpecReviewReport({
			sources: {
				"partition-findings.main": cleanPartition(),
				"report.main": report("INCONCLUSIVE"),
			},
			context: {},
		});
		assert.equal(noMetadata.status, "failed");
		assert.equal(noMetadata.verdict, "INCONCLUSIVE");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
