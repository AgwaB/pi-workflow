#!/usr/bin/env node
/**
 * Dist-parameterized before/after harness for the planner prompt render.
 *
 * Renders `defaultPlannerPrompt` against a fixed fixture using a caller-
 * supplied compiled `dist` directory. When that dist ships the coordination
 * projection module (`dynamic-state-projection.js`), the harness folds the
 * fixture's state index into a ledger and attaches `input.coordination`
 * before rendering; on baseline dists that lack the module, it renders
 * without coordination. This lets the same script diff "before" and "after"
 * prompt output across S1/S2 dists.
 *
 * Usage:
 *   node test/eval/coordproj-prompt-render.mjs --dist <dir> --out <file>
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
	const args = { dist: undefined, out: undefined };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--dist") {
			args.dist = argv[++i];
		} else if (arg === "--out") {
			args.out = argv[++i];
		}
	}
	return args;
}

function buildFixtureInput() {
	return {
		round: 2,
		task: "Coordinate dynamic decision loop planning for the analyze stage.",
		generatedTaskIds: ["t-analyze"],
		config: {
			allowedOutputProfiles: ["candidate_findings_v1"],
			maxActionsPerRound: 3,
		},
		previousDecisions: [],
		latestStateIndex: {
			digest: "fixture-digest-0001",
			index: {
				completedWork: [],
				failedWork: [],
				findings: [],
				verifications: [],
				claimSupports: [],
				criteriaCoverage: [],
				gaps: [],
				blockers: [
					{
						id: "B1",
						message: "required DB schema artifact is missing for t-analyze",
						severity: "high",
						sourceTaskIds: ["t-analyze"],
						relatedFindingIds: [],
					},
				],
				conflicts: [],
				omissions: [],
			},
			artifacts: {
				index: ".pi/workflows/fixture/dynamic/state-indexes/ctrl/round-002/index.json",
			},
		},
	};
}

async function main() {
	const { dist, out } = parseArgs(process.argv.slice(2));
	if (!dist || !out) {
		console.error(
			"Usage: node test/eval/coordproj-prompt-render.mjs --dist <dir> --out <file>",
		);
		process.exitCode = 1;
		return;
	}

	const distDir = resolve(dist);
	const outPath = resolve(out);

	const promptsUrl = pathToFileURL(
		resolve(distDir, "dynamic-loop-prompts.js"),
	).href;
	const { defaultPlannerPrompt } = await import(promptsUrl);

	const input = buildFixtureInput();

	let projection;
	try {
		const projectionUrl = pathToFileURL(
			resolve(distDir, "dynamic-state-projection.js"),
		).href;
		projection = await import(projectionUrl);
	} catch {
		projection = undefined;
	}

	if (projection) {
		const { addRoundToCoordinationLedger, buildPlannerCoordination, createCoordinationLedger } =
			projection;
		let ledger = createCoordinationLedger();
		ledger = addRoundToCoordinationLedger(
			ledger,
			0,
			input.latestStateIndex.index,
		);
		input.coordination = buildPlannerCoordination(ledger, {
			digest: input.latestStateIndex.digest,
			artifactPath: input.latestStateIndex.artifacts.index,
		});
	}

	const rendered = defaultPlannerPrompt(input);

	await mkdir(dirname(outPath), { recursive: true });
	await writeFile(outPath, rendered, "utf8");

	const digest = createHash("sha256").update(rendered, "utf8").digest("hex");
	console.log(`${outPath} sha256:${digest}`);
}

await main();
