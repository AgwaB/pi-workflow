#!/usr/bin/env node
// E2E for `pi-workflow supervise`: the parent only creates a run record (no
// scheduling, no in-process watch timers), then a standalone supervise child
// process must drive the run to completion with real subagents.
//
// Prereq: `npm test` (builds .tmp/unit). Spawns real Pi subagents (model calls).
import { spawn } from "node:child_process";
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

const { compileWorkflow } = await import(join(build, "compiler.js"));
const {
	createWorkflowRunRecord,
	readRunRecord,
	writeRunRecord,
	writeStaticRunArtifacts,
} = await import(join(build, "store.js"));

const MODEL = process.env.RESUME_E2E_MODEL ?? "anthropic/claude-sonnet-4-6";
const SUPERVISE_TIMEOUT_MS = 300_000;

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const cwd = join(
	root,
	".tmp",
	"test-results",
	"manual",
	`supervise-e2e-${stamp}`,
);
mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
mkdirSync(join(cwd, "workflows"), { recursive: true });

writeFileSync(
	join(cwd, ".pi", "agents", "e2e-echo.md"),
	[
		"---",
		"description: E2E echo agent for supervise testing",
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

const spec = {
	schemaVersion: 1,
	name: "e2e-supervise",
	description: "Two-step echo workflow for supervise E2E.",
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
};
const specPath = join(cwd, "workflows", "e2e-supervise.json");
writeFileSync(specPath, JSON.stringify(spec, null, 2));

console.log(`[supervise-e2e] project: ${cwd}`);
console.log(`[supervise-e2e] model: ${MODEL}`);

// Create the run record only — nothing is scheduled in this process.
const compiled = await compileWorkflow(spec, {
	cwd,
	task: "Supervise E2E check",
	specPath,
});
const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
await writeStaticRunArtifacts(cwd, run, compiled, spec);
await writeRunRecord(cwd, run);
console.log(
	`[supervise-e2e] created ${run.runId} (status: ${run.status}); handing off to standalone supervise`,
);

const cliPath = join(root, "src", "cli.mjs");
const exitCode = await new Promise((resolveExit, rejectExit) => {
	const child = spawn(
		process.execPath,
		[cliPath, "supervise", run.runId, "--poll-ms", "1000"],
		{ cwd, stdio: ["ignore", "pipe", "pipe"] },
	);
	const timer = setTimeout(() => {
		child.kill("SIGKILL");
		rejectExit(
			new Error(`supervise did not finish within ${SUPERVISE_TIMEOUT_MS}ms`),
		);
	}, SUPERVISE_TIMEOUT_MS);
	child.stdout.on("data", (chunk) => process.stdout.write(`  ${chunk}`));
	child.stderr.on("data", (chunk) => process.stderr.write(`  ${chunk}`));
	child.on("exit", (code) => {
		clearTimeout(timer);
		resolveExit(code);
	});
	child.on("error", (error) => {
		clearTimeout(timer);
		rejectExit(error);
	});
});

const finished = await readRunRecord(cwd, run.runId);
const checks = [
	["supervise exit code 0", exitCode === 0],
	["run completed", finished.status === "completed"],
	...finished.tasks.map((task) => [
		`${task.specId} completed`,
		task.status === "completed",
	]),
];
for (const task of finished.tasks) {
	let structured;
	try {
		structured = JSON.parse(
			readFileSync(join(cwd, task.files.result), "utf8"),
		)?.structuredOutput;
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
	console.log(`[supervise-e2e] ${ok ? "PASS" : "FAIL"} — ${label}`);
	if (!ok) pass = false;
}
if (!pass) {
	console.error(`[supervise-e2e] FAIL — evidence: ${cwd}`);
	process.exit(1);
}
console.log(`[supervise-e2e] PASS — evidence: ${cwd}`);
