import {
	dispatchedCalls,
	dynamicLoopConfig,
	dynamicLoopInvalidDecision,
	dynamicLoopPersistedDecision,
	makeDynamicDecisionLoopCtx,
	plannerCalls,
	runDynamicDecisionLoop,
} from "./unit-test-support.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import {
	MAX_LEDGER_ENTRIES,
	MAX_MESSAGE_CHARS,
	MAX_PROJECTED_ISSUES,
	MAX_SUMMARY_CHARS,
	addRoundToCoordinationLedger,
	buildPlannerCoordination,
	createCoordinationLedger,
	renderCoordinationSummary,
} from "../../.tmp/unit/dynamic-state-projection.js";

function issue(id, message, extra = {}) {
	return { id, message, sourceTaskIds: [], ...extra };
}

test("renderCoordinationSummary orders the full severity domain (critical..unknown) descending, absent severity treated as unknown", () => {
	let ledger = createCoordinationLedger();
	ledger = addRoundToCoordinationLedger(ledger, 0, {
		blockers: [
			issue("b-info", "info blocker", { severity: "info" }),
			issue("b-crit", "critical blocker", { severity: "critical" }),
			issue("b-none", "no severity blocker"),
			issue("b-unknown", "unknown blocker", { severity: "unknown" }),
			issue("b-low", "low blocker", { severity: "low" }),
			issue("b-med", "medium blocker", { severity: "medium" }),
			issue("b-high", "high blocker", { severity: "high" }),
		],
	});

	const summary = renderCoordinationSummary(ledger);
	const ids = [...summary.matchAll(/\] (b-\w+):/g)].map((m) => m[1]);
	assert.deepEqual(ids, [
		"b-crit",
		"b-high",
		"b-med",
		"b-low",
		"b-info",
		"b-none",
		"b-unknown",
	]);
});

test("renderCoordinationSummary breaks ties by kind (blocker>conflict>gap>omission)", () => {
	let ledger = createCoordinationLedger();
	ledger = addRoundToCoordinationLedger(ledger, 0, {
		blockers: [issue("x", "a blocker", { severity: "high" })],
		conflicts: [issue("x", "a conflict", { severity: "high" })],
		gaps: [issue("x", "a gap", { severity: "high" })],
		omissions: ["an omission at severity-equivalent unknown but same tier check"],
	});

	const summary = renderCoordinationSummary(ledger);
	const kindOrder = [...summary.matchAll(/- \[(blocker|conflict|gap|omission)\]/g)].map(
		(m) => m[1],
	);
	assert.deepEqual(kindOrder.slice(0, 3), ["blocker", "conflict", "gap"]);
});

test("renderCoordinationSummary breaks ties by firstSeenRound then id lexicographically", () => {
	let ledger = createCoordinationLedger();
	ledger = addRoundToCoordinationLedger(ledger, 3, {
		gaps: [issue("g-z", "later round gap")],
	});
	ledger = addRoundToCoordinationLedger(ledger, 1, {
		gaps: [issue("g-b", "earlier round gap b"), issue("g-a", "earlier round gap a")],
	});

	const summary = renderCoordinationSummary(ledger);
	const ids = [...summary.matchAll(/g-\w/g)].map((m) => m[0]);
	assert.deepEqual(ids, ["g-a", "g-b", "g-z"]);
});

test("renderCoordinationSummary caps at MAX_PROJECTED_ISSUES lines and reports true totals with showing counts", () => {
	let ledger = createCoordinationLedger();
	const gaps = [];
	for (let i = 0; i < MAX_PROJECTED_ISSUES + 5; i++) {
		gaps.push(issue(`g${String(i).padStart(2, "0")}`, `gap ${i}`, { severity: "medium" }));
	}
	ledger = addRoundToCoordinationLedger(ledger, 0, { gaps });

	const summary = renderCoordinationSummary(ledger);
	const lines = summary.split("\n");
	assert.equal(lines.length - 1, MAX_PROJECTED_ISSUES);
	assert.match(lines[0], new RegExp(`gaps ${gaps.length} \\(showing ${MAX_PROJECTED_ISSUES}\\)`));
	assert.match(lines[0], /blockers 0,/);
	assert.match(lines[0], /failed work 0$/);
});

test("renderCoordinationSummary truncates messages to MAX_MESSAGE_CHARS with a trailing ellipsis", () => {
	let ledger = createCoordinationLedger();
	const longMessage = "m".repeat(MAX_MESSAGE_CHARS + 50);
	ledger = addRoundToCoordinationLedger(ledger, 0, {
		gaps: [issue("g1", longMessage, { severity: "high" })],
	});

	const summary = renderCoordinationSummary(ledger);
	const line = summary.split("\n")[1];
	const rendered = line.slice(line.indexOf("g1: ") + "g1: ".length);
	assert.equal(rendered.length, MAX_MESSAGE_CHARS);
	assert.ok(rendered.endsWith("…"));
});

test("renderCoordinationSummary drops whole items (never a partial line) once MAX_SUMMARY_CHARS would be exceeded", () => {
	let ledger = createCoordinationLedger();
	const gaps = [];
	for (let i = 0; i < MAX_PROJECTED_ISSUES; i++) {
		gaps.push(
			issue(`g${i}`, "x".repeat(MAX_MESSAGE_CHARS), {
				severity: "medium",
				sourceTaskIds: Array.from({ length: 10 }, (_, j) => `task-${i}-${j}`),
				relatedFindingIds: Array.from({ length: 10 }, (_, j) => `finding-${i}-${j}`),
			}),
		);
	}
	ledger = addRoundToCoordinationLedger(ledger, 0, { gaps });

	const summary = renderCoordinationSummary(ledger);
	assert.ok(summary.length <= MAX_SUMMARY_CHARS);
	const lines = summary.split("\n");
	for (const line of lines.slice(1)) {
		assert.ok(line.startsWith("- [gap]"));
		assert.ok(line.includes("x".repeat(MAX_MESSAGE_CHARS)));
	}
	// Fewer than the full candidate set should have survived the byte budget.
	assert.ok(lines.length - 1 < MAX_PROJECTED_ISSUES);
	assert.match(lines[0], /gaps 8 \(showing \d+\)/);
});

test("omissions dedupe by full string, render without id or severity tag", () => {
	let ledger = createCoordinationLedger();
	ledger = addRoundToCoordinationLedger(ledger, 0, {
		omissions: ["missing coverage for X", "missing coverage for X", "second omission"],
	});
	ledger = addRoundToCoordinationLedger(ledger, 1, {
		omissions: ["missing coverage for X"],
	});

	const summary = renderCoordinationSummary(ledger);
	assert.match(summary, /omissions 2,/);
	const omissionLines = summary.split("\n").filter((l) => l.startsWith("- [omission]"));
	assert.equal(omissionLines.length, 2);
	assert.match(omissionLines[0], /^- \[omission\]\[since r0\] missing coverage for X$/);
	assert.doesNotMatch(omissionLines[0], /\[unknown\]|\[high\]/);
});

test("degradation: undefined/non-object/{}/missing-array index contributes nothing and never throws", () => {
	const base = createCoordinationLedger();
	for (const bad of [undefined, null, "str", 42, [], {}, { gaps: "nope" }, { blockers: 5 }]) {
		const next = addRoundToCoordinationLedger(base, 0, bad);
		assert.equal(next.entries.length, 0);
		assert.equal(next.failedTaskIds.length, 0);
		assert.equal(renderCoordinationSummary(next), undefined);
	}
});

test("ledger dedupe: re-observed (kind,id) keeps latest message/severity but preserves firstSeenRound", () => {
	let ledger = createCoordinationLedger();
	ledger = addRoundToCoordinationLedger(ledger, 0, {
		blockers: [issue("B1", "first observation", { severity: "low" })],
	});
	ledger = addRoundToCoordinationLedger(ledger, 5, {
		blockers: [issue("B1", "latest observation", { severity: "critical" })],
	});

	assert.equal(ledger.entries.length, 1);
	const entry = ledger.entries[0];
	assert.equal(entry.message, "latest observation");
	assert.equal(entry.severity, "critical");
	assert.equal(entry.firstSeenRound, 0);

	const summary = renderCoordinationSummary(ledger);
	assert.match(summary, /\[critical\]\[since r0\] B1: latest observation/);
});

test("MAX_LEDGER_ENTRIES eviction is deterministic and keeps the top-ranked entries", () => {
	let ledger = createCoordinationLedger();
	const gaps = [];
	for (let i = 0; i < MAX_LEDGER_ENTRIES + 10; i++) {
		gaps.push(issue(`g${String(i).padStart(3, "0")}`, `gap ${i}`, { severity: "low" }));
	}
	// One high severity item should always survive eviction.
	gaps.push(issue("g-important", "must survive", { severity: "high" }));

	ledger = addRoundToCoordinationLedger(ledger, 0, { gaps });
	assert.equal(ledger.entries.length, MAX_LEDGER_ENTRIES);
	assert.ok(ledger.entries.some((e) => e.id === "g-important"));

	// Re-running the same fold from scratch is deterministic.
	let ledger2 = createCoordinationLedger();
	ledger2 = addRoundToCoordinationLedger(ledger2, 0, { gaps });
	const ids1 = ledger.entries.map((e) => e.id).sort();
	const ids2 = ledger2.entries.map((e) => e.id).sort();
	assert.deepEqual(ids1, ids2);
});

test("folding the same round sequence twice yields byte-identical summaries", () => {
	const rounds = [
		{ round: 0, index: { gaps: [issue("g1", "gap one", { severity: "medium" })] } },
		{
			round: 1,
			index: {
				blockers: [issue("b1", "blocker one", { severity: "high", sourceTaskIds: ["t1"] })],
				omissions: ["missed something"],
				failedWork: [{ taskId: "t2" }],
			},
		},
		{
			round: 2,
			index: {
				conflicts: [issue("c1", "conflict one", { severity: "critical" })],
				gaps: [issue("g1", "gap one updated", { severity: "low" })],
			},
		},
	];

	const fold = () => {
		let ledger = createCoordinationLedger();
		for (const r of rounds) {
			ledger = addRoundToCoordinationLedger(ledger, r.round, r.index);
		}
		return renderCoordinationSummary(ledger);
	};

	const first = fold();
	const second = fold();
	assert.equal(first, second);
	assert.equal(typeof first, "string");
});

test("failedWork accumulates as a distinct ordered set reflected in the header count only", () => {
	let ledger = createCoordinationLedger();
	ledger = addRoundToCoordinationLedger(ledger, 0, {
		failedWork: [{ taskId: "t1" }, { taskId: "t2" }, { taskId: "t1" }],
	});
	ledger = addRoundToCoordinationLedger(ledger, 1, {
		failedWork: [{ taskId: "t2" }, { taskId: "t3" }],
	});

	assert.deepEqual(ledger.failedTaskIds, ["t1", "t2", "t3"]);
	const summary = renderCoordinationSummary(ledger);
	assert.match(summary, /failed work 3$/);
	assert.doesNotMatch(summary, /t1|t2|t3/);
});

test("renderCoordinationSummary returns undefined for an empty ledger with no failed work", () => {
	const ledger = createCoordinationLedger();
	assert.equal(renderCoordinationSummary(ledger), undefined);
});

test("renderCoordinationSummary returns a header-only summary when only failedWork is present", () => {
	let ledger = createCoordinationLedger();
	ledger = addRoundToCoordinationLedger(ledger, 0, { failedWork: [{ taskId: "t1" }] });
	const summary = renderCoordinationSummary(ledger);
	assert.equal(summary, "Coordination state (cumulative): blockers 0, conflicts 0, gaps 0, omissions 0, failed work 1");
});

test("addRoundToCoordinationLedger does not mutate the input ledger", () => {
	const ledger = createCoordinationLedger();
	const next = addRoundToCoordinationLedger(ledger, 0, {
		gaps: [issue("g1", "gap", { severity: "high" })],
	});
	assert.equal(ledger.entries.length, 0);
	assert.equal(next.entries.length, 1);
	assert.notEqual(ledger, next);
});

test("buildPlannerCoordination copies digest/artifactPath from latest and is undefined when summary is undefined", () => {
	const empty = createCoordinationLedger();
	assert.equal(buildPlannerCoordination(empty, { digest: "d1", artifactPath: "p1" }), undefined);
	assert.equal(buildPlannerCoordination(empty), undefined);

	let ledger = createCoordinationLedger();
	ledger = addRoundToCoordinationLedger(ledger, 0, {
		gaps: [issue("g1", "gap", { severity: "high" })],
	});

	const withLatest = buildPlannerCoordination(ledger, { digest: "d2", artifactPath: "p2" });
	assert.equal(withLatest.digest, "d2");
	assert.equal(withLatest.artifactPath, "p2");
	assert.equal(typeof withLatest.summary, "string");

	const withoutLatest = buildPlannerCoordination(ledger);
	assert.equal(withoutLatest.digest, undefined);
	assert.equal(withoutLatest.artifactPath, undefined);
});
test("round-0 planner prompt has no coordination block and keeps the digest-absent line", async () => {
	const config = dynamicLoopConfig({ maxDecisionRounds: 1 });
	const decideR0 = dynamicLoopPersistedDecision({
		round: 0,
		status: "stop",
		nextActions: [{ type: "stop", actionId: "act-stop", reason: "done" }],
	});
	const { ctx, calls } = makeDynamicDecisionLoopCtx({
		config,
		persistedDecisions: [decideR0],
	});

	const outcome = await runDynamicDecisionLoop(ctx);
	assert.equal(outcome.control.status, "stopped");

	const planners = plannerCalls(calls);
	assert.equal(planners.length, 1);
	assert.equal(planners[0].prompt.includes("No state index yet."), true);
	assert.equal(
		planners[0].prompt.includes("Coordination state (cumulative)"),
		false,
	);
});

test("round-0 blocker surfaces in round-1 planner prompt with header, advisory locator, and remediation policy", async () => {
	const config = dynamicLoopConfig({ maxDecisionRounds: 2 });
	const decideR0 = dynamicLoopPersistedDecision({
		round: 0,
		status: "continue",
		nextActions: [
			{
				type: "add_work_item",
				actionId: "act-r0",
				workItemId: "t1",
				agent: "unit-scout",
				prompt: "Inspect DB schema.",
				tools: ["read"],
				outputProfile: "candidate_findings_v1",
			},
		],
	});
	const decideR1 = dynamicLoopPersistedDecision({
		round: 1,
		status: "stop",
		nextActions: [{ type: "stop", actionId: "act-stop", reason: "done" }],
	});
	const { ctx, calls } = makeDynamicDecisionLoopCtx({
		config,
		persistedDecisions: [decideR0, decideR1],
		stateIndexResults: [
			{
				digest: "d0",
				index: {
					blockers: [
						{
							id: "B1",
							message: "required DB schema artifact is missing",
							severity: "high",
							sourceTaskIds: ["t1"],
						},
					],
				},
				artifacts: { index: "runs/fixture/round-0/index.json" },
			},
		],
	});

	const outcome = await runDynamicDecisionLoop(ctx);
	assert.equal(outcome.control.status, "stopped");

	const planners = plannerCalls(calls);
	assert.equal(planners.length, 2);
	assert.equal(
		planners[0].prompt.includes("Coordination state (cumulative)"),
		false,
	);

	const round1Prompt = planners[1].prompt;
	assert.equal(
		round1Prompt.includes(
			"Coordination state (cumulative): blockers 1, conflicts 0, gaps 0, omissions 0, failed work 0",
		),
		true,
	);
	assert.equal(round1Prompt.includes("[blocker][high][since r0] B1:"), true);
	assert.equal(
		round1Prompt.includes(
			"If you have read access, the full state index is at runs/fixture/round-0/index.json (digest d0). This locator is advisory; do not treat it as a required read.",
		),
		true,
	);
	assert.equal(
		round1Prompt.includes(
			"Coordination remediation policy: prefer exactly one focused action this round for the highest-ranked unresolved issue.",
		),
		true,
	);
});

test("a round-0 blocker persists into the round-2 prompt with since r0 even when round 1's index omits it", async () => {
	const config = dynamicLoopConfig({ maxDecisionRounds: 3 });
	const decideR0 = dynamicLoopPersistedDecision({
		round: 0,
		status: "continue",
		nextActions: [
			{
				type: "add_work_item",
				actionId: "act-r0",
				workItemId: "t1",
				agent: "unit-scout",
				prompt: "Inspect DB schema.",
				tools: ["read"],
				outputProfile: "candidate_findings_v1",
			},
		],
	});
	const decideR1 = dynamicLoopPersistedDecision({
		round: 1,
		status: "continue",
		nextActions: [
			{
				type: "add_work_item",
				actionId: "act-r1",
				workItemId: "t2",
				agent: "unit-scout",
				prompt: "Inspect unrelated coverage.",
				tools: ["read"],
				outputProfile: "candidate_findings_v1",
			},
		],
	});
	const decideR2 = dynamicLoopPersistedDecision({
		round: 2,
		status: "stop",
		nextActions: [{ type: "stop", actionId: "act-stop", reason: "done" }],
	});
	const { ctx, calls } = makeDynamicDecisionLoopCtx({
		config,
		persistedDecisions: [decideR0, decideR1, decideR2],
		stateIndexResults: [
			{
				digest: "d0",
				index: {
					blockers: [
						{
							id: "B1",
							message: "required DB schema artifact is missing",
							severity: "high",
							sourceTaskIds: ["t1"],
						},
					],
				},
				artifacts: { index: "runs/fixture/round-0/index.json" },
			},
			{ digest: "d1", index: {} },
		],
	});

	const outcome = await runDynamicDecisionLoop(ctx);
	assert.equal(outcome.control.status, "stopped");

	const planners = plannerCalls(calls);
	assert.equal(planners.length, 3);
	assert.equal(planners[2].prompt.includes("[blocker][high][since r0] B1:"), true);
});

test("scripted follow-up decision naming a surfaced issue id dispatches exactly one follow-up worker task", async () => {
	const config = dynamicLoopConfig({ maxDecisionRounds: 3 });
	const decideR0 = dynamicLoopPersistedDecision({
		round: 0,
		status: "continue",
		nextActions: [
			{
				type: "add_work_item",
				actionId: "act-r0",
				workItemId: "t1",
				agent: "unit-scout",
				prompt: "Inspect DB schema.",
				tools: ["read"],
				outputProfile: "candidate_findings_v1",
			},
		],
	});
	const decideR1 = dynamicLoopPersistedDecision({
		round: 1,
		status: "continue",
		nextActions: [
			{
				type: "add_work_item",
				actionId: "act-r1",
				workItemId: "resolve-B1",
				agent: "unit-scout",
				prompt: "Add the missing DB schema artifact referenced by B1.",
				tools: ["read"],
				outputProfile: "candidate_findings_v1",
			},
		],
	});
	const decideR2 = dynamicLoopPersistedDecision({
		round: 2,
		status: "stop",
		nextActions: [{ type: "stop", actionId: "act-stop", reason: "resolved" }],
	});
	const { ctx, calls } = makeDynamicDecisionLoopCtx({
		config,
		persistedDecisions: [decideR0, decideR1, decideR2],
		stateIndexResults: [
			{
				digest: "d0",
				index: {
					blockers: [
						{
							id: "B1",
							message: "required DB schema artifact is missing",
							severity: "high",
							sourceTaskIds: ["t1"],
						},
					],
				},
				artifacts: { index: "runs/fixture/round-0/index.json" },
			},
		],
	});

	const outcome = await runDynamicDecisionLoop(ctx);
	assert.equal(outcome.control.status, "stopped");

	const dispatched = dispatchedCalls(calls);
	assert.equal(dispatched.length, 2);
	const followUp = dispatched.filter((request) => request.id === "resolve-B1");
	assert.equal(followUp.length, 1);
	assert.equal(followUp[0].prompt.includes("B1"), true);
});

test("repair attempts within the same round reuse a byte-identical coordination block", async () => {
	const config = dynamicLoopConfig({
		maxDecisionRounds: 2,
		repair: { maxAttempts: 1 },
	});
	const decideR0 = dynamicLoopPersistedDecision({
		round: 0,
		status: "continue",
		nextActions: [
			{
				type: "add_work_item",
				actionId: "act-r0",
				workItemId: "t1",
				agent: "unit-scout",
				prompt: "Inspect DB schema.",
				tools: ["read"],
				outputProfile: "candidate_findings_v1",
			},
		],
	});
	const invalidR1 = dynamicLoopInvalidDecision(["missing nextActions"]);
	const decideR1 = dynamicLoopPersistedDecision({
		round: 1,
		status: "stop",
		nextActions: [{ type: "stop", actionId: "act-stop", reason: "done" }],
	});
	const { ctx, calls } = makeDynamicDecisionLoopCtx({
		config,
		persistedDecisions: [decideR0, invalidR1, decideR1],
		stateIndexResults: [
			{
				digest: "d0",
				index: {
					blockers: [
						{
							id: "B1",
							message: "required DB schema artifact is missing",
							severity: "high",
							sourceTaskIds: ["t1"],
						},
					],
				},
				artifacts: { index: "runs/fixture/round-0/index.json" },
			},
		],
	});

	const outcome = await runDynamicDecisionLoop(ctx);
	assert.equal(outcome.control.status, "stopped");

	const planners = plannerCalls(calls);
	assert.equal(planners.length, 3);
	assert.deepEqual(
		planners.map((request) => request.id),
		["decide-r0", "decide-r1", "decide-r1-repair-1"],
	);

	const extractCoordinationBlock = (prompt) => {
		const start = prompt.indexOf("Coordination state (cumulative)");
		const markerEnd = "Coordination remediation policy";
		const end = prompt.indexOf(markerEnd) + markerEnd.length;
		return prompt.slice(start, end);
	};
	const first = extractCoordinationBlock(planners[1].prompt);
	const second = extractCoordinationBlock(planners[2].prompt);
	assert.notEqual(first.indexOf("Coordination state (cumulative)"), -1);
	assert.equal(first, second);
});

test("a replan prompt contains both the replan block and the coordination block", async () => {
	const config = dynamicLoopConfig({
		maxDecisionRounds: 3,
		stopPolicy: { maxStalls: 1 },
	});
	const decideR0 = dynamicLoopPersistedDecision({
		round: 0,
		status: "continue",
		nextActions: [
			{
				type: "add_work_item",
				actionId: "act-r0",
				workItemId: "t1",
				agent: "unit-scout",
				prompt: "Inspect DB schema.",
				tools: ["read"],
				outputProfile: "candidate_findings_v1",
			},
		],
	});
	const decideR1 = dynamicLoopPersistedDecision({
		round: 1,
		status: "continue",
		nextActions: [],
	});
	const decideR2 = dynamicLoopPersistedDecision({
		round: 2,
		status: "stop",
		nextActions: [{ type: "stop", actionId: "act-stop", reason: "replanned" }],
	});
	const { ctx, calls } = makeDynamicDecisionLoopCtx({
		config,
		persistedDecisions: [decideR0, decideR1, decideR2],
		stateIndexResults: [
			{
				digest: "d0",
				index: {
					blockers: [
						{
							id: "B1",
							message: "required DB schema artifact is missing",
							severity: "high",
							sourceTaskIds: ["t1"],
						},
					],
				},
				artifacts: { index: "runs/fixture/round-0/index.json" },
			},
		],
	});

	const outcome = await runDynamicDecisionLoop(ctx);
	assert.equal(outcome.control.status, "stopped");

	const planners = plannerCalls(calls);
	assert.equal(planners.length, 3);
	const round2Prompt = planners[2].prompt;
	assert.equal(round2Prompt.includes("Replan requested"), true);
	assert.equal(round2Prompt.includes("Coordination state (cumulative)"), true);
	assert.equal(round2Prompt.includes("[blocker][high][since r0] B1:"), true);
});

test("digest-only stateIndex results contribute nothing to the coordination block and never throw", async () => {
	const config = dynamicLoopConfig({ maxDecisionRounds: 2 });
	const decideR0 = dynamicLoopPersistedDecision({
		round: 0,
		status: "continue",
		nextActions: [
			{
				type: "add_work_item",
				actionId: "act-r0",
				workItemId: "t1",
				agent: "unit-scout",
				prompt: "Inspect DB schema.",
				tools: ["read"],
				outputProfile: "candidate_findings_v1",
			},
		],
	});
	const decideR1 = dynamicLoopPersistedDecision({
		round: 1,
		status: "stop",
		nextActions: [{ type: "stop", actionId: "act-stop", reason: "done" }],
	});
	const { ctx, calls } = makeDynamicDecisionLoopCtx({
		config,
		persistedDecisions: [decideR0, decideR1],
		stateIndexResults: [{ digest: "only-digest" }],
	});

	const outcome = await runDynamicDecisionLoop(ctx);
	assert.equal(outcome.control.status, "stopped");

	const planners = plannerCalls(calls);
	assert.equal(planners.length, 2);
	assert.equal(
		planners[1].prompt.includes("Latest state index digest: only-digest"),
		true,
	);
	assert.equal(
		planners[1].prompt.includes("Coordination state (cumulative)"),
		false,
	);
});
