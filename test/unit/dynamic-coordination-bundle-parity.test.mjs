import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { defaultPlannerPrompt } from "../../.tmp/unit/dynamic-loop-prompts.js";
import {
	addRoundToCoordinationLedger,
	buildPlannerCoordination,
	createCoordinationLedger,
} from "../../.tmp/unit/dynamic-state-projection.js";
import {
	DIRECT_DYNAMIC_RUNTIME_VERSION,
	directDynamicControllerSource,
} from "../../.tmp/unit/dynamic-runtime-bundle.js";

const COORDINATION_START_MARKER = "Coordination state (cumulative):";
const COORDINATION_END_MARKER =
	"against tasks already listed in Generated tasks.";

function extractCoordinationBlock(prompt) {
	const start = prompt.indexOf(COORDINATION_START_MARKER);
	assert.notEqual(start, -1, "coordination block start marker missing");
	const endMarkerIndex = prompt.indexOf(COORDINATION_END_MARKER, start);
	assert.notEqual(endMarkerIndex, -1, "coordination block end marker missing");
	const end = endMarkerIndex + COORDINATION_END_MARKER.length;
	return prompt.slice(start, end);
}

async function loadBundledPlannerPrompt() {
	const dir = mkdtempSync(join(tmpdir(), "dynamic-coordination-bundle-"));
	const controllerPath = join(dir, "controller.mjs");
	writeFileSync(controllerPath, directDynamicControllerSource(), "utf8");
	const imported = await import(pathToFileURL(controllerPath).href);
	assert.equal(typeof imported.default, "function");
	assert.equal(typeof imported.directDynamicPlannerPrompt, "function");
	return imported.directDynamicPlannerPrompt;
}

function baseFixtureInput(coordination) {
	return {
		round: 2,
		task: "Research dynamic workflow evaluation methods.",
		config: {
			maxActionsPerRound: 4,
			allowedOutputProfiles: [
				"candidate_findings_v1",
				"verification_result_v1",
				"coverage_assessment_v1",
				"generic_summary_v1",
				"synthesis_v1",
			],
		},
		previousDecisions: [],
		latestStateIndex: { digest: "d1" },
		generatedTaskIds: ["t1"],
		coordination,
	};
}

function buildCoordinationFixture() {
	let ledger = createCoordinationLedger();
	ledger = addRoundToCoordinationLedger(ledger, 0, {
		blockers: [
			{
				id: "B1",
				message: "required DB schema artifact is missing",
				severity: "high",
				sourceTaskIds: ["t1"],
			},
		],
	});
	return buildPlannerCoordination(ledger, {
		digest: "d0",
		artifactPath: "runs/fixture/round-0/index.json",
	});
}

test("bundled direct-dynamic planner prompt renders a byte-identical coordination block to the package planner prompt", async () => {
	const coordination = buildCoordinationFixture();
	assert.ok(coordination);
	const input = baseFixtureInput(coordination);

	const directDynamicPlannerPrompt = await loadBundledPlannerPrompt();
	const bundledPrompt = directDynamicPlannerPrompt(input);
	const packagePrompt = defaultPlannerPrompt(input);

	const bundledBlock = extractCoordinationBlock(bundledPrompt);
	const packageBlock = extractCoordinationBlock(packagePrompt);
	assert.equal(bundledBlock, packageBlock);

	assert.equal(bundledBlock.includes(coordination.summary), true);
	assert.equal(
		bundledBlock.includes(
			"If you have read access, the full state index is at runs/fixture/round-0/index.json (digest d0). This locator is advisory; do not treat it as a required read.",
		),
		true,
	);
	assert.equal(
		bundledBlock.includes(
			"Coordination remediation policy: prefer exactly one focused action this round for the highest-ranked unresolved issue.",
		),
		true,
	);
});

test("bundled direct-dynamic planner prompt omits the coordination block and keeps the digest-only line when coordination is absent", async () => {
	const input = baseFixtureInput(undefined);

	const directDynamicPlannerPrompt = await loadBundledPlannerPrompt();
	const bundledPrompt = directDynamicPlannerPrompt(input);

	assert.equal(bundledPrompt.includes("Coordination state"), false);
	assert.equal(
		bundledPrompt.includes("Latest state index digest: d1"),
		true,
	);
});

test("direct-dynamic runtime bundle version label is bumped to v2", () => {
	assert.equal(DIRECT_DYNAMIC_RUNTIME_VERSION, "direct-dynamic-runtime-v2");
	assert.match(DIRECT_DYNAMIC_RUNTIME_VERSION, /-v2$/);
	assert.equal(DIRECT_DYNAMIC_RUNTIME_VERSION.includes("v1"), false);
});
