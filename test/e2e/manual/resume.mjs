#!/usr/bin/env node
// E2E for /workflow resume: run a tiny 2-stage workflow with real subagents,
// interrupt it mid-flight so the run fails, then resumeRun() and assert the
// run completes with completed work preserved on disk.
//
// Prereq: `npm test` (builds .tmp/unit). Spawns real Pi subagents (model calls).
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const e2eDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(e2eDir, "../../..");
const build = join(root, ".tmp", "unit");
if (!existsSync(join(build, "engine.js"))) {
	console.error("Missing build at .tmp/unit — run `npm test` first.");
	process.exit(2);
}

const { resumeRun, runWorkflowSpec, scheduleRun } = await import(
	join(build, "engine.js")
);
const { readRunRecord } = await import(join(build, "store.js"));
const { cleanupSubagentRun } = await import(join(build, "subagent-backend.js"));

const MODEL = process.env.RESUME_E2E_MODEL ?? "anthropic/claude-sonnet-4-6";
const FAIL_TIMEOUT_MS = 120_000;
const COMPLETE_TIMEOUT_MS = 300_000;
const POLL_MS = 1_000;

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const cwd = join(root, ".tmp", "test-results", "manual", `resume-e2e-${stamp}`);
mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
mkdirSync(join(cwd, "workflows"), { recursive: true });

writeFileSync(
	join(cwd, ".pi", "agents", "e2e-echo.md"),
	[
		"---",
		"description: E2E echo agent for resume testing",
		'tools: ["read"]',
		"readOnly: true",
		`model: ${MODEL}`,
		"---",
		"# e2e-echo",
		"",
		"Respond with <control>, <analysis>, and <refs> sections. Put requested JSON in <control>.",
		"",
	].join("\n"),
);

const specPath = join(cwd, "workflows", "e2e-resume.json");
writeFileSync(
	specPath,
	JSON.stringify(
		{
			schemaVersion: 1,
			name: "e2e-resume",
			description: "Two-step echo workflow for resume E2E.",
			defaults: { agent: "e2e-echo", readOnly: true, tools: ["read"] },
			artifactGraph: {
				stages: [
					{
						id: "one",
						type: "task",
						prompt:
							'Put {"schema":"stage-control-v1","digest":"one done","ok":true,"step":"one"} in <control>.',
					},
					{
						id: "two",
						type: "reduce",
						from: "one",
						prompt:
							'Put {"schema":"stage-control-v1","digest":"two done","ok":true,"step":"two"} in <control>.',
					},
				],
			},
		},
		null,
		2,
	),
);

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil(runId, predicate, timeoutMs, label) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await scheduleRun(cwd, runId).catch(() => undefined);
		const run = await readRunRecord(cwd, runId);
		if (predicate(run)) return run;
		await sleep(POLL_MS);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

function taskBy(run, specId) {
	return run.tasks.find((task) => task.specId === specId);
}

console.log(`[resume-e2e] project: ${cwd}`);
console.log(`[resume-e2e] model: ${MODEL}`);

// Phase A — launch and interrupt mid-flight so the run fails.
const started = await runWorkflowSpec(specPath, cwd, {
	task: "Resume E2E check",
});
console.log(
	`[resume-e2e] started ${started.runId} (status: ${started.status})`,
);
await cleanupSubagentRun(cwd, await readRunRecord(cwd, started.runId));
console.log("[resume-e2e] interrupted in-flight tasks");

const failed = await pollUntil(
	started.runId,
	(run) => run.status !== "running",
	FAIL_TIMEOUT_MS,
	"run to leave running after interrupt",
);
if (failed.status === "completed") {
	console.log(
		"[resume-e2e] INCONCLUSIVE — run completed before the interrupt landed; re-run the script.",
	);
	process.exit(3);
}
if (failed.status !== "failed" && failed.status !== "interrupted") {
	console.error(
		`[resume-e2e] FAIL — expected failed/interrupted run, got ${failed.status}`,
	);
	process.exit(1);
}
console.log(
	`[resume-e2e] run is ${failed.status}: tasks ${failed.tasks.map((task) => `${task.specId}=${task.status}`).join(", ")}`,
);

// Phase B — resume and drive to completion.
const { run: resumed, resetTaskIds } = await resumeRun(cwd, started.runId);
console.log(
	`[resume-e2e] resumed (reset: ${resetTaskIds.join(", ")}); status: ${resumed.status}`,
);

const finished = await pollUntil(
	started.runId,
	(run) => run.status !== "running",
	COMPLETE_TIMEOUT_MS,
	"resumed run to finish",
);
const one = taskBy(finished, "one.main");
const two = taskBy(finished, "two.main");
const checks = [
	["run completed", finished.status === "completed"],
	["task one completed", one?.status === "completed"],
	["task two completed", two?.status === "completed"],
];
for (const task of [one, two].filter(Boolean)) {
	const resultPath = join(cwd, task.files.result);
	let structured;
	try {
		structured = JSON.parse(readFileSync(resultPath, "utf8"))?.structuredOutput;
	} catch {
		structured = undefined;
	}
	checks.push([
		`${task.specId} result ok:true on disk`,
		structured?.ok === true,
	]);
}

let pass = true;
for (const [label, ok] of checks) {
	console.log(`[resume-e2e] ${ok ? "PASS" : "FAIL"} — ${label}`);
	if (!ok) pass = false;
}
if (!pass) {
	console.error(`[resume-e2e] FAIL — evidence: ${cwd}`);
	process.exit(1);
}
console.log(`[resume-e2e] PASS — evidence: ${cwd}`);
