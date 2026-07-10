import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const ROOT = mkdtempSync(join(tmpdir(), "workflow-forensics-"));

after(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

function writeJson(file, value) {
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, JSON.stringify(value, null, 2));
}

function writeRun(runId) {
	const runDir = join(ROOT, ".pi", "workflows", runId);
	const taskDir = join(runDir, "tasks", "task-1");
	mkdirSync(taskDir, { recursive: true });
	writeJson(join(runDir, "run.json"), {
		runId,
		name: "synthetic-validity",
		status: "completed",
		createdAt: "2026-07-09T00:00:00.000Z",
		updatedAt: "2026-07-09T00:00:05.000Z",
		tasks: [
			{
				taskId: "task-1",
				specId: "normalize-output",
				stageId: "normalize",
				status: "completed",
				createdAt: "2026-07-09T00:00:00.000Z",
				startedAt: "2026-07-09T00:00:01.000Z",
				completedAt: "2026-07-09T00:00:04.000Z",
			},
		],
	});
	writeJson(join(taskDir, "result.invalid-attempt-1.json"), {
		issues: [
			{
				instancePath: "/evidence",
				message: "must be array",
			},
		],
	});
}

test("workflow forensics aggregates repeated first-attempt validation failures", () => {
	const indexDir = join(ROOT, ".pi", "workflows");
	mkdirSync(indexDir, { recursive: true });
	writeRun("run_a");
	writeRun("run_b");
	writeJson(join(indexDir, "index.json"), {
		runs: [
			{ runId: "run_a", runJson: ".pi/workflows/run_a/run.json" },
			{ runId: "run_b", runJson: ".pi/workflows/run_b/run.json" },
		],
	});
	const outJson = join(ROOT, "out.json");
	const outMd = join(ROOT, "out.md");
	execFileSync("node", ["tools/workflow-forensics.mjs", ROOT, outJson, outMd], {
		cwd: process.cwd(),
		stdio: "pipe",
	});
	const out = JSON.parse(readFileSync(outJson, "utf8"));
	assert.equal(out.validationFailureSignatures.length, 1);
	assert.equal(
		out.validationFailureSignatures[0].workflow,
		"synthetic-validity",
	);
	assert.equal(out.validationFailureSignatures[0].stageId, "normalize");
	assert.equal(out.validationFailureSignatures[0].schemaPath, "/evidence");
	assert.equal(out.validationFailureSignatures[0].message, "must be array");
	assert.equal(
		out.validationFailureSignatures[0].triageCategory,
		"triage-needed",
	);
	assert.equal(
		out.validationFailureSignatures[0].benchmarkValiditySignal,
		"unknown",
	);
	assert.equal(out.validationFailureSignatures[0].count, 2);
	assert.equal(out.validationFailureSignatures[0].runCount, 2);
	assert.equal(
		out.validationFailureSignatures[0].validitySignal,
		"repeated-validation-signature",
	);
	const md = readFileSync(outMd, "utf8");
	assert.match(md, /Repeated output-validation failure signatures/);
	assert.match(md, /benchmark signal/);
});

test("workflow forensics triages schema enum failures as contract drift", () => {
	const indexDir = join(ROOT, ".pi", "workflows");
	mkdirSync(indexDir, { recursive: true });
	const runId = "run_schema_enum";
	const runDir = join(indexDir, runId);
	const taskDir = join(runDir, "tasks", "task-1");
	mkdirSync(taskDir, { recursive: true });
	writeJson(join(runDir, "run.json"), {
		runId,
		name: "synthetic-schema",
		status: "completed",
		createdAt: "2026-07-09T00:00:00.000Z",
		updatedAt: "2026-07-09T00:00:05.000Z",
		tasks: [
			{
				taskId: "task-1",
				specId: "devil-advocate",
				stageId: "devil-advocate",
				status: "completed",
				createdAt: "2026-07-09T00:00:00.000Z",
				startedAt: "2026-07-09T00:00:01.000Z",
				completedAt: "2026-07-09T00:00:04.000Z",
			},
		],
	});
	writeJson(join(taskDir, "result.invalid-attempt-1.json"), {
		outputValidation: {
			issues: [
				{
					path: "$.schema",
					message:
						"control JSON schema failed: value must match one of schema enum",
				},
			],
		},
	});
	writeJson(join(indexDir, "index.json"), {
		runs: [{ runId, runJson: `.pi/workflows/${runId}/run.json` }],
	});
	const outJson = join(ROOT, "schema-out.json");
	const outMd = join(ROOT, "schema-out.md");
	execFileSync("node", ["tools/workflow-forensics.mjs", ROOT, outJson, outMd], {
		cwd: process.cwd(),
		stdio: "pipe",
	});
	const out = JSON.parse(readFileSync(outJson, "utf8"));
	const signature = out.validationFailureSignatures.find(
		(item) => item.workflow === "synthetic-schema",
	);
	assert.equal(signature.triageCategory, "schema-contract-drift");
	assert.equal(signature.benchmarkValiditySignal, "agent-output-contract");
});
