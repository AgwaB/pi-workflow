import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateJsonSchema } from "../../.tmp/unit/json-schema.js";
import { parseWorkflowOutput } from "../../.tmp/unit/workflow-output-artifacts.js";
import finalPacket from "../../workflows/deep-research/helpers/final-audit-packet.mjs";
import render from "../../workflows/deep-research/helpers/render-executive.mjs";
import { buildSynthesisPages } from "../../workflows/deep-research/helpers/synthesis-pages.mjs";

const fixture = JSON.parse(
	await readFile(
		new URL(
			"../fixtures/deep-research/max-synthesis-handoff-replay.json",
			import.meta.url,
		),
		"utf8",
	),
);
const synthesisSchema = JSON.parse(
	await readFile(
		new URL(
			"../../workflows/deep-research/schemas/deep-research-final-synthesis-v2-control.schema.json",
			import.meta.url,
		),
		"utf8",
	),
);

function synthesis(comparisonRows) {
	return {
		schema: "deep-research-final-synthesis-v2",
		digest: "Evidence-qualified comparison with explicit denominator limits.",
		synthesis: {
			bottomLine:
				"The subject has verified strengths, but the evidence does not establish every reference capability.",
			comparisonRows,
			keyFindingIds: ["claim-001", "claim-018", "claim-019"],
			recommendations: [
				{
					recommendation: "Prioritize the verified gap before broadening scope.",
					supportingClaimIds: ["claim-019"],
					evidenceStatus: "partially supported",
				},
			],
			actionPlan: [],
			caveatNotes: [
				{
					note: "Unverified leads remain outside the audited claim denominator.",
					readerNote: "Actual demand has not been established; validate it before investing.",
					relatedClaimIds: ["claim-019"],
					gapIds: ["gap-remaining-001"],
				},
			],
			parentDecisionNotes: [],
		},
	};
}

const comparisonRows = [
	{
		area: "Primary capability",
		subjectStatus: "Verified in current evidence.",
		referencePattern: "Commonly supported by the reference set.",
		assessment: "A demonstrated strength.",
		supportingClaimIds: ["claim-001"],
		evidenceStatus: "verified",
	},
	{
		area: "Historical compatibility",
		subjectStatus: "Not established by the available evidence.",
		referencePattern: "Documented by selected references.",
		assessment: "Treat as unknown, not absent.",
		supportingClaimIds: ["claim-019"],
		evidenceStatus: "partially supported",
	},
	{
		area: "Operational maturity",
		subjectStatus: "Roadmap-only in the audited packet.",
		referencePattern: "Production guidance is available elsewhere.",
		assessment: "Do not present planned work as current capability.",
		supportingClaimIds: ["claim-018"],
		evidenceStatus: "partially supported",
	},
];

test("deep-research v2 renders a side-by-side completion with explicit evidence boundaries", async () => {
	const sources = structuredClone(fixture.sources);
	sources["normalize-claims"].sanitizerDiagnostics = {
		schemaCapDrops: [
			{
				path: "claimInventory.preservedClaims",
				maxItems: 24,
				inputCount: 47,
				outputCount: 24,
				droppedCount: 23,
			},
		],
	};
	const packet = await finalPacket({ sources });
	const overlay = synthesis(comparisonRows);
	assert.equal(validateJsonSchema(overlay, synthesisSchema).valid, true);

	const result = await render({
		sources: {
			"final-audit-packet": packet,
			"final-audit": overlay,
		},
	});

	assert.equal(result.status, "passed", JSON.stringify(result.gates));
	assert.equal(result.gates.expectedOutputShapeSatisfied, true);
	assert.equal(result.sectionCounts.comparisonRows, 3);
	assert.match(result.completionSummaryMarkdown, /## Comparison snapshot/);
	assert.match(result.reportMarkdown, /## Comparison snapshot/);
	assert.match(
		result.completionSummaryMarkdown,
		/\| Primary capability \| Verified in current evidence\./,
	);
	assert.match(result.completionSummaryMarkdown, /Treat as unknown, not absent/);
	assert.match(result.auditMarkdown, /Audited claims \(48 total\)/);
	assert.match(
		result.auditMarkdown,
		/Outside the audited-claim denominator: 24 preserved unverified leads available to synthesis, 23 additional leads omitted by a schema cap/,
	);
	assert.match(
		result.auditMarkdown,
		/zero unsupported\/conflicting\/blocked counts apply only to the 48 audited claims/,
	);
	assert.match(result.auditMarkdown, /Unverified leads remain outside the audited claim denominator/);
	assert.match(result.completionSummaryMarkdown, /Actual demand has not been established/);
	assert.match(result.completionSummaryMarkdown, /Questions remain unanswered/);
	assert.doesNotMatch(result.completionSummaryMarkdown, /Audited claims|Fact slots|schema.cap|denominator|evidence:|claim-\d/);
	assert.doesNotMatch(result.completionSummaryMarkdown, /final-report\.md|audit\.md/);
});

test("deep-research v2 keeps omitted verification candidates outside the audited denominator", async () => {
	const packet = await finalPacket({ sources: fixture.sources });
	packet.packet.invariantChecks.candidateCount += 1;
	packet.packet.invariantChecks.candidateIds.push("claim-omitted-001");
	packet.packet.invariantChecks.omittedCandidateIds.push("claim-omitted-001");
	packet.packet.overflowLedger.omittedVerificationCandidateCount += 1;
	packet.packet.synthesisInput = buildSynthesisPages(packet.packet);

	const result = await render({
		sources: {
			"final-audit-packet": packet,
			"final-audit": synthesis(comparisonRows),
		},
	});

	assert.equal(result.status, "passed", JSON.stringify(result.gates));
	assert.equal(result.claimSummary.total, 48);
	assert.match(result.auditMarkdown, /Audited claims \(48 total\)/);
	assert.match(result.auditMarkdown, /1 verification candidate omitted from audit/);
	assert.doesNotMatch(result.auditMarkdown, /Audited claims \(49 total\)/);
	assert.match(result.completionSummaryMarkdown, /Questions remain unanswered/);
	assert.doesNotMatch(result.completionSummaryMarkdown, /candidate omitted|denominator|Audited claims/);
});

test("deep-research v2 does not infer zero schema-cap omissions when diagnostics are absent", async () => {
	const packet = await finalPacket({ sources: fixture.sources });
	const result = await render({
		sources: {
			"final-audit-packet": packet,
			"final-audit": synthesis(comparisonRows),
		},
	});

	assert.equal(result.status, "passed", JSON.stringify(result.gates));
	assert.match(
		result.auditMarkdown,
		/additional schema-cap omission count unavailable/,
	);
	assert.doesNotMatch(
		result.auditMarkdown,
		/0 additional leads omitted by a schema cap/,
	);
});

test("deep-research v2 fails closed when a requested comparison has no rows", async () => {
	const packet = await finalPacket({ sources: fixture.sources });
	const overlay = synthesis([]);
	assert.equal(validateJsonSchema(overlay, synthesisSchema).valid, true);

	const result = await render({
		sources: {
			"final-audit-packet": packet,
			"final-audit": overlay,
		},
	});

	assert.equal(result.status, "failed");
	assert.equal(result.gates.expectedOutputShapeSatisfied, false);
	assert.equal(result.gates.passed, false);
	assert.deepEqual(
		result.renderWarnings.filter((warning) => warning.section === "comparisonRows"),
		[
			{
				section: "comparisonRows",
				label: "expected 3-8 side-by-side comparison rows",
				total: 1,
				rendered: 0,
			},
		],
	);
});

test("deep-research v2 output repair applies comparison row and supporting-id caps", () => {
	const rows = Array.from({ length: 10 }, (_, index) => ({
		area: `Area ${index + 1}`,
		subjectStatus: "Current state.",
		referencePattern: "Reference pattern.",
		assessment: "Assessment.",
		supportingClaimIds: Array.from(
			{ length: 10 },
			(_, claimIndex) => `claim-${String(claimIndex + 1).padStart(3, "0")}`,
		),
	}));
	const parsed = parseWorkflowOutput(
		[
			"<control>",
			JSON.stringify(synthesis(rows)),
			"</control>",
			"<analysis>analysis</analysis>",
			"<refs>[]</refs>",
		].join("\n"),
		{ controlJsonSchema: synthesisSchema },
	);

	assert.equal(parsed.valid, true, JSON.stringify(parsed.issues));
	assert.equal(parsed.control.synthesis.comparisonRows.length, 8);
	assert.equal(
		parsed.control.synthesis.comparisonRows[0].supportingClaimIds.length,
		8,
	);
	assert.deepEqual(
		parsed.repairs?.map((repair) => repair.code),
		["control_final_synthesis_array_caps"],
	);
	assert.match(parsed.repairs?.[0]?.message ?? "", /comparisonRows:-2/);
	assert.match(
		parsed.repairs?.[0]?.message ?? "",
		/comparisonRows\.supportingClaimIds:-16/,
	);
});
