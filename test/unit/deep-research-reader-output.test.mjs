import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateJsonSchema } from "../../.tmp/unit/json-schema.js";
import finalPacket from "../../workflows/deep-research/helpers/final-audit-packet.mjs";
import render from "../../workflows/deep-research/helpers/render-executive.mjs";

const fixture = JSON.parse(await readFile(new URL("../fixtures/deep-research/max-synthesis-handoff-replay.json", import.meta.url), "utf8"));
const schema = JSON.parse(await readFile(new URL("../../workflows/deep-research/schemas/deep-research-final-synthesis-v2-control.schema.json", import.meta.url), "utf8"));
async function inputs() {
	const packet = await finalPacket({ sources: structuredClone(fixture.sources) });
	const synthesis = {
		bottomLine: "문서상 기능은 확인했지만 실제 수요와 기능 부재는 확인하지 못했습니다.",
		comparisonRows: ["A", "B", "C"].map(area => ({ area, subjectStatus: "Current", referencePattern: "Reference", assessment: "Unknown is not absent", supportingClaimIds: ["claim-001"] })),
		keyFindingIds: ["claim-001"],
		recommendations: [{ recommendation: "조건 확인 + 안전한 복구를 먼저 검증하세요.", supportingClaimIds: ["claim-001"] }],
		actionPlan: [],
		caveatNotes: [{ note: "claim-001 source-ref join: schema cap and fact slots require audit.", relatedClaimIds: ["claim-001"], gapIds: ["gap-remaining-001"] }],
		parentDecisionNotes: [],
	};
	return { "final-audit-packet": packet, "final-audit": { schema: "deep-research-final-synthesis-v2", digest: "Reader-facing result", synthesis } };
}

test("historical synthesis stays readable without copying audit-only caveats or changing source evidence", async () => {
	const sources = await inputs();
	const before = structuredClone(sources);
	const result = await render({ sources });
	assert.equal(result.status, "passed", JSON.stringify(result.gates));
	assert.deepEqual(sources, before);
	assert.doesNotMatch(result.completionSummaryMarkdown, /Audited claims|Fact slots|schema.cap|fact slots|claim-001|source-ref|denominator|evidence:/);
	assert.match(result.completionSummaryMarkdown, /추가로 확인할 질문이 남아/);
	assert.match(result.auditMarkdown, /claim-001 source-ref join/);
	assert.match(result.auditMarkdown, /Audited claims \(48 total\)/);
	assert.equal(result.claimSummary.total, 48);
});

test("completion escapes raw prose exactly once including comparison cells", async () => {
	const sources = await inputs();
	const synthesis = sources["final-audit"].synthesis;
	synthesis.recommendations[0].recommendation = "A + B <script> & *literal* [text](target)";
	synthesis.comparisonRows[0].assessment = "A + B | C <script>\nnew line";
	const result = await render({ sources });
	assert.equal(result.status, "passed");
	assert.ok(result.completionSummaryMarkdown.includes("A \\+ B &lt;script&gt; &amp; \\*literal\\* \\[text\\](target)"));
	assert.ok(result.completionSummaryMarkdown.includes("A \\+ B \\| C &lt;script&gt; new line"));
	assert.ok(!result.completionSummaryMarkdown.includes("\\\\\\+"));
	assert.doesNotMatch(result.completionSummaryMarkdown, /<script>|&amp;lt;/);
});

test("reader limitations are distinct and bounded while all audit notes remain", async () => {
	const sources = await inputs();
	const synthesis = sources["final-audit"].synthesis;
	synthesis.caveatNotes = Array.from({ length: 10 }, (_, i) => ({
		note: `Internal audit detail ${i}: claim-001`,
		readerNote: `Practical limitation ${Math.floor(i / 2)} changes the decision.`,
		relatedClaimIds: ["claim-001"],
	}));
	assert.equal(validateJsonSchema(sources["final-audit"], schema).valid, true);
	const result = await render({ sources });
	assert.equal(result.status, "passed");
	assert.equal((result.completionSummaryMarkdown.match(/Practical limitation/g) ?? []).length, 4);
	assert.doesNotMatch(result.completionSummaryMarkdown, /Internal audit detail|Practical limitation 4/);
	for (let i = 0; i < 10; i++) assert.ok(result.auditMarkdown.includes(`Internal audit detail ${i}`));
});

test("invalid readerNote is rejected by schema and renderer rather than object-stringified", async () => {
	for (const readerNote of [[], {}, "", "x".repeat(1201)]) {
		const sources = await inputs();
		sources["final-audit"].synthesis.caveatNotes[0].readerNote = readerNote;
		assert.equal(validateJsonSchema(sources["final-audit"], schema).valid, false);
		const result = await render({ sources });
		assert.equal(result.status, "blocked");
		assert.equal(result.completionSummaryMarkdown, "");
	}
});

test("reader prose cannot bypass the canonical reconciliation gate", async () => {
	const sources = await inputs();
	sources["final-audit"].synthesis.caveatNotes[0].readerNote = "Everything is ready.";
	sources["final-audit-packet"].packet.verdictCounts.verified += 1;
	const result = await render({ sources });
	assert.equal(result.status, "failed");
	assert.equal(result.gates.packetReconciliationPassed, false);
	assert.equal(result.completionSummaryMarkdown, "");
});

for (const [status, qualifier] of [
	["partially_supported", "Only partly supported by the available sources"],
	["unsupported", "Insufficient supporting evidence"],
	["conflicting", "Sources disagree"],
	["verification_blocked", "Could not be checked"],
	["unverified", "Not yet checked"],
]) {
	test(`reader wording preserves the ${status} evidence boundary on historical controls`, async () => {
		const result = await render({ sources: { "final-audit": {
			schema: "legacy-audit", digest: "Investigate before committing.",
			finalReport: {
				summary: "Investigate before committing.", researchMetadata: {}, coverageSummary: {},
				factSlotCoverage: [], mainFindings: [], actionPlan: [], remainingGaps: [],
				parentDecisionNotes: [], unverifiedButRelevant: [],
				recommendations: [{ recommendation: "Check the dependency.", evidenceStatus: status }],
			},
			claimVerdictIndex: { claims: [{ id: "claim-001", status }] },
		} } });
		assert.equal(result.status, "passed");
		assert.ok(result.completionSummaryMarkdown.includes(qualifier));
		assert.match(result.completionSummaryMarkdown, /not enough verified evidence/);
		assert.match(result.completionSummaryMarkdown, /does not establish that all requested areas were covered/);
		assert.doesNotMatch(result.completionSummaryMarkdown, /claim-001|evidence:|Fact slots/);
		if (status === "conflicting") assert.match(result.completionSummaryMarkdown, /Some sources disagree/);
		assert.match(result.auditMarkdown, /claim-001/);
	});
}

test("a verified subset does not hide unclassified legacy evidence or coverage", async () => {
	for (const kind of ["unclassified-claim", "unknown-slot", "unverified-lead", "contested", "unsupported"]) {
		const control = {
			schema: "legacy-audit", digest: "Check before committing.",
			finalReport: {
				summary: "Check before committing.", researchMetadata: {},
				coverageSummary: { preserved: 0, omittedPreserved: 0, omittedVerificationCandidates: 0, coverageGaps: 0 },
				factSlotCoverage: [{ status: kind === "unknown-slot" ? "unknown" : "filled" }],
				mainFindings: [], recommendations: [], actionPlan: [], remainingGaps: [], parentDecisionNotes: [],
				unverifiedButRelevant: kind === "unverified-lead" ? [{ note: "Demand is unknown." }] : [],
				contestedFindings: kind === "contested" ? [{ note: "Sources disagree." }] : [],
				unsupportedFindings: kind === "unsupported" ? [{ note: "No support found." }] : [],
			},
			claimVerdictIndex: { claims: [{ id: "claim-001", status: "verified" }] },
		};
		if (kind === "unclassified-claim") control.claimVerdictIndex.claims.push({ id: "claim-002", status: "unverified" });
		const result = await render({ sources: { "final-audit": control } });
		assert.equal(result.status, "passed");
		assert.match(result.completionSummaryMarkdown, /Some evidence could not be fully checked|Questions remain unanswered|Some sources disagree/, kind);
	}
});

test("both research prompts separate plain reader notes from audit bookkeeping", async () => {
	for (const name of ["spec.json", "tiered-verification.spec.json"]) {
		const spec = JSON.parse(await readFile(new URL(`../../workflows/deep-research/${name}`, import.meta.url), "utf8"));
		const prompt = spec.artifactGraph.stages.find(stage => stage.id === "final-audit").prompt;
		assert.match(prompt, /Separate reader-facing prose from audit bookkeeping/);
		assert.match(prompt, /at most 4 distinct/);
		assert.match(prompt, /plain text, not pre-escaped Markdown/);
		assert.match(prompt, /"readerNote":"The available evidence/);
		assert.equal(spec.artifactGraph.stages.find(stage => stage.id === "final-audit").inputPolicy.requiredReads.length, 9);
	}
});
