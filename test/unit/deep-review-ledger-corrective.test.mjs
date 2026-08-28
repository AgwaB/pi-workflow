import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = join(process.cwd(), "workflows", "deep-review", "helpers");
const pipeline = (await import(pathToFileURL(join(root, "finding-pipeline.mjs")).href)).default;
const render = (await import(pathToFileURL(join(root, "render-review-report.mjs")).href)).default;

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
