import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { compileWorkflow } from "../../.tmp/unit/compiler.js";
import {
	formatHumanRunDetails,
	formatHumanRunStatus,
	formatLoopSummaryLines,
} from "../../.tmp/unit/engine-format.js";
import { loadWorkflowSpec } from "../../.tmp/unit/schema.js";
import { resolveWorkflowRef } from "../../.tmp/unit/workflow-specs.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(root, "src", "cli.mjs");
const evidenceGateHelper = join(
	root,
	"skills/workflow-guide/scaffolds/support-partition/helpers/evidence-gate.mjs",
);

const VALID_SPEC = {
	schemaVersion: 1,
	defaults: { agent: "scout", readOnly: true, tools: ["read"] },
	artifactGraph: { stages: [{ id: "main", type: "single", prompt: "Check." }] },
};

async function scratch(prefix) {
	return mkdtemp(join(tmpdir(), `pi-workflow-${prefix}-`));
}

function runInspect(cwd, args) {
	return spawnSync(process.execPath, [cli, "inspect", ...args], {
		cwd,
		encoding: "utf8",
	});
}

test("a bundle directory containing spec.json resolves as a workflow path", async () => {
	const cwd = await scratch("bundle-dir");
	try {
		const spec = join(cwd, ".pi", "workflows", "bundle-form", "spec.json");
		await mkdir(dirname(spec), { recursive: true });
		await writeFile(spec, `${JSON.stringify(VALID_SPEC)}\n`);
		assert.equal((await resolveWorkflowRef(".pi/workflows/bundle-form", cwd)).specPath, spec);
		assert.equal((await resolveWorkflowRef("./.pi/workflows/bundle-form/", cwd)).specPath, spec);
		assert.equal((await loadWorkflowSpec(".pi/workflows/bundle-form", cwd)).specPath, spec);
		await assert.rejects(
			resolveWorkflowRef(".pi/workflows/missing", cwd),
			/bundle directory containing spec\.json/,
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("inspect --failures --results falls back to every task result on a clean run", async () => {
	const cwd = await scratch("inspect-flags");
	try {
		const runDir = join(cwd, ".pi", "workflows", "workflow_gate");
		await mkdir(join(runDir, "tasks", "task-1"), { recursive: true });
		await writeFile(join(runDir, "tasks", "task-1", "result.md"), "FINAL RESULT BODY\n");
		await writeFile(
			join(runDir, "run.json"),
			`${JSON.stringify({
				runId: "workflow_gate",
				name: "unit",
				type: "artifact-graph",
				status: "completed",
				tasks: [
					{
						taskId: "task-1",
						status: "completed",
						statusDetail: "completed",
						files: { result: ".pi/workflows/workflow_gate/tasks/task-1/result.md" },
					},
				],
			})}\n`,
		);
		const combined = runInspect(cwd, ["workflow_gate", "--failures", "--results"]);
		assert.equal(combined.status, 0, combined.stderr);
		assert.match(combined.stdout, /failures: none \(showing every task result\)/);
		assert.match(combined.stdout, /FINAL RESULT BODY/);
		const failuresOnly = runInspect(cwd, ["workflow_gate", "--failures"]);
		assert.equal(failuresOnly.status, 0, failuresOnly.stderr);
		assert.doesNotMatch(failuresOnly.stdout, /task-1/);
		assert.doesNotMatch(failuresOnly.stdout, /showing every task result/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("inspect --failures --results keeps failure-only listing when a task failed", async () => {
	const cwd = await scratch("inspect-failures");
	try {
		const runDir = join(cwd, ".pi", "workflows", "workflow_fail");
		await mkdir(join(runDir, "tasks", "task-2"), { recursive: true });
		await writeFile(join(runDir, "tasks", "task-2", "result.md"), "FAILED BODY\n");
		await writeFile(
			join(runDir, "run.json"),
			`${JSON.stringify({
				runId: "workflow_fail",
				name: "unit",
				type: "artifact-graph",
				status: "failed",
				tasks: [
					{ taskId: "task-1", status: "completed", statusDetail: "completed" },
					{
						taskId: "task-2",
						status: "failed",
						statusDetail: "failed",
						files: { result: ".pi/workflows/workflow_fail/tasks/task-2/result.md" },
					},
				],
			})}\n`,
		);
		const result = runInspect(cwd, ["workflow_fail", "--failures", "--results"]);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /task-2: failed/);
		assert.match(result.stdout, /FAILED BODY/);
		assert.doesNotMatch(result.stdout, /task-1/);
		assert.doesNotMatch(result.stdout, /showing every task result/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("nested-shape warning names a non-empty skeleton when the schema forbids an empty array", async () => {
	const cwd = await scratch("shape-warning");
	try {
		const schemaDir = join(cwd, "schemas");
		await mkdir(schemaDir, { recursive: true });
		await writeFile(
			join(schemaDir, "report.schema.json"),
			JSON.stringify({
				type: "object",
				required: ["schema", "digest", "defects"],
				properties: {
					schema: { type: "string" },
					digest: { type: "string" },
					defects: {
						type: "array",
						minItems: 1,
						items: {
							type: "object",
							required: ["id", "evidence"],
							properties: {
								id: { type: "string" },
								evidence: { type: "array", minItems: 1, items: { type: "object" } },
							},
						},
					},
				},
			}),
		);
		const specPath = join(cwd, "spec.json");
		await writeFile(
			specPath,
			JSON.stringify({
				schemaVersion: 1,
				defaults: { agent: "scout", readOnly: true, tools: ["read"] },
				artifactGraph: {
					stages: [
						{
							id: "report",
							type: "single",
							prompt: 'Return <control> with schema, digest, and defects. Each defect has id and evidence. Example: {"schema":"stage-control-v1","digest":"d","defects":[{"id":"x"}]}',
							output: { controlSchema: "./schemas/report.schema.json" },
						},
					],
				},
			}),
		);
		const loaded = await loadWorkflowSpec(specPath, cwd);
		const compiled = await compileWorkflow(loaded.spec, { cwd, specPath: loaded.specPath });
		const warning = compiled.warnings.find((entry) => /\$\.defects\[\]\.evidence/.test(entry));
		assert.ok(warning, `expected an evidence shape warning, got ${JSON.stringify(compiled.warnings)}`);
		assert.match(warning, /"evidence": \[ \.\.\. \]/);
		assert.match(warning, /requires a non-empty array/);
		assert.doesNotMatch(warning, /"evidence": \[\] control shape/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("status and details show loop rounds and outcome", () => {
	const run = {
		schemaVersion: 1,
		runId: "workflow_loop",
		name: "doc-sync-loop",
		type: "artifact-graph",
		status: "completed",
		taskSummary: { total: 5, pending: 0, running: 0, blocked: 0, completed: 5, failed: 0, skipped: 0, interrupted: 0 },
		cwd: "/tmp/x",
		backend: { type: "local-pi", mode: "headless" },
		createdAt: "2026-09-02T05:15:47.320Z",
		updatedAt: "2026-09-02T05:20:35.457Z",
		tasks: [],
		loopStates: [{ loopId: "doc-sync-loop", round: 2, status: "exhausted", awaitingOnExhausted: false }],
	};
	assert.deepEqual(formatLoopSummaryLines(run), [
		"Loop doc-sync-loop: 2 rounds · exhausted: maxRounds reached before the until condition was met",
	]);
	assert.match(formatHumanRunStatus(run), /Loop doc-sync-loop: 2 rounds · exhausted/);
	assert.match(formatHumanRunDetails(run), /Loop doc-sync-loop: 2 rounds · exhausted/);
	assert.deepEqual(
		formatLoopSummaryLines({ ...run, loopStates: [{ loopId: "l", round: 1, status: "completed" }] }),
		["Loop l: 1 round · stopped: until condition met"],
	);
	assert.deepEqual(
		formatLoopSummaryLines({ ...run, loopStates: [{ loopId: "l", round: 3 }] }),
		["Loop l: 3 rounds · in progress"],
	);
	assert.deepEqual(formatLoopSummaryLines({ ...run, loopStates: undefined }), []);
});

test("scaffold evidence gate verifies quotes against cited file ranges and demotes mismatches", async () => {
	const cwd = await scratch("evidence-gate");
	try {
		await mkdir(join(cwd, "src"), { recursive: true });
		await writeFile(
			join(cwd, "src", "cache.ts"),
			["line one", "  set(key) {", "    if (this.size > this.max) {", "      evict();", "    }", "  }", ""].join("\n"),
		);
		const { default: gate } = await import(`${evidenceGateHelper}?t=${Date.now()}`);
		const finding = (id, extra) => ({
			findingId: id,
			title: id,
			severity: "medium",
			verdict: "KEEP",
			locations: [{ file: "src/cache.ts", line: 2, lineEnd: 5 }],
			recommendedAction: "fix",
			...extra,
		});
		const sources = {
			"partition-verdicts": {
				schema: "helper-output-v1",
				digest: "x",
				value: {
					partitions: {
						keep: [
							finding("OK-001", { evidenceQuotes: ["if (this.size > this.max) {"] }),
							finding("BAD-001", { evidenceQuotes: ["if (this.size >= this.max) {"] }),
							finding("MISSING-001", { locations: [{ file: "src/nope.ts", line: 1 }], evidenceQuotes: ["anything"] }),
							finding("ESCAPE-001", { locations: [{ file: "../outside.ts" }], evidenceQuotes: ["x"] }),
						],
						weaken: [finding("W-001", { evidenceQuotes: ["evict();"] })],
						drop: [],
						needsHuman: [],
					},
					reportContext: { keep: [], weaken: [], needsHuman: [] },
					partitionSummary: { keep: 4, weaken: 1, drop: 0, needsHuman: 0, verdictsReceived: 5, candidates: 5 },
					normalizationNotes: [],
				},
			},
		};
		const result = await gate({ sources, options: { partitionStage: "partition-verdicts" }, context: { cwd } });
		const value = result.value;
		assert.deepEqual(value.partitions.keep.map((row) => row.findingId), ["OK-001"]);
		assert.deepEqual(value.partitions.weaken.map((row) => row.findingId), ["W-001"]);
		assert.deepEqual(
			value.partitions.needsHuman.map((row) => [row.findingId, row.evidenceGate]),
			[["BAD-001", "mismatch"], ["MISSING-001", "unreadable"], ["ESCAPE-001", "unreadable"]],
		);
		assert.equal(value.evidenceGate.integrity, "partial");
		assert.equal(value.evidenceGate.verified, 2);
		assert.equal(value.evidenceGate.mismatch, 1);
		assert.equal(value.evidenceGate.unreadable, 2);
		assert.deepEqual(value.evidenceGate.demoted, ["BAD-001", "MISSING-001", "ESCAPE-001"]);
		assert.equal(value.partitionSummary.keep, 1);
		assert.equal(value.partitionSummary.needsHuman, 3);
		assert.equal(value.partitionSummary.integrity, "partial");
		assert.deepEqual(value.reportContext.keep.map((row) => row.findingId), ["OK-001"]);
		assert.match(value.normalizationNotes.at(-1), /evidence gate: 2 verified, 1 mismatch, 2 unreadable/);

		const clean = await gate({
			sources: {
				"partition-verdicts": {
					...sources["partition-verdicts"],
					value: {
						...sources["partition-verdicts"].value,
						partitions: { keep: [finding("OK-001", { evidenceQuotes: ["evict();"] })], weaken: [], drop: [], needsHuman: [] },
					},
				},
			},
			options: {},
			context: { cwd },
		});
		assert.equal(clean.value.evidenceGate.integrity, "complete");
		assert.equal(clean.value.partitions.keep[0].evidenceGate, "verified");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
