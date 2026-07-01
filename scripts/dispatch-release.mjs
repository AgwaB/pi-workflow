#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const usage = `Usage: npm run release:dispatch -- <version> [--watch]

Dispatches .github/workflows/publish.yml on origin/main. Run only after an
approved release plan (target version, changelog, validation, npm target, and
downstream impact) has been reviewed.
`;

const args = process.argv.slice(2);
const version = args.find((arg) => !arg.startsWith("--"));
const watch = args.includes("--watch");

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
	console.error(usage);
	process.exit(1);
}

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (pkg.name !== "@agwab/pi-workflow") {
	console.error(`Refusing to dispatch release for unexpected package ${pkg.name}`);
	process.exit(1);
}

run("git", ["fetch", "origin"]);
const branch = capture("git", ["branch", "--show-current"]).trim();
if (branch !== "main") {
	console.error(`Release dispatch must run from main; current branch is ${branch || "(detached)"}.`);
	process.exit(1);
}
const status = capture("git", ["status", "--short"]);
if (status.trim()) {
	console.error(`Working tree is not clean:\n${status}`);
	process.exit(1);
}
const divergence = capture("git", ["rev-list", "--left-right", "--count", "origin/main...HEAD"]).trim();
if (divergence !== "0\t0") {
	console.error(`main must match origin/main before dispatch; divergence is ${divergence}.`);
	process.exit(1);
}

const workflowFile = "publish.yml";
const headSha = capture("git", ["rev-parse", "HEAD"]).trim();
const previousRunIds = watch ? listWorkflowDispatchRunIds(workflowFile, headSha) : new Set();

console.log(`Dispatching Publish for ${pkg.name}@${version} on origin/main...`);
run("gh", ["workflow", "run", workflowFile, "--ref", "main", "-f", `version=${version}`]);
if (watch) {
	const runId = waitForNewWorkflowDispatchRunId(workflowFile, headSha, previousRunIds);
	run("gh", ["run", "watch", runId, "--exit-status"]);
}

function run(command, args) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(command, args, { stdio: "inherit", shell: false });
	if (result.status !== 0) process.exit(result.status ?? 1);
}

function capture(command, args) {
	const result = spawnSync(command, args, { encoding: "utf8", shell: false });
	if (result.status !== 0) {
		process.stderr.write(result.stderr || result.stdout);
		process.exit(result.status ?? 1);
	}
	return result.stdout;
}

function waitForNewWorkflowDispatchRunId(workflowFile, headSha, previousRunIds) {
	console.log(`Waiting for dispatched ${workflowFile} run on ${headSha.slice(0, 12)}...`);
	for (let attempt = 0; attempt < 30; attempt += 1) {
		const runIds = listWorkflowDispatchRunIds(workflowFile, headSha);
		for (const runId of runIds) {
			if (!previousRunIds.has(runId)) return runId;
		}
		sleep(2_000);
	}
	console.error(`Timed out waiting for dispatched ${workflowFile} run on ${headSha}.`);
	process.exit(1);
}

function listWorkflowDispatchRunIds(workflowFile, headSha) {
	const output = capture("gh", [
		"run",
		"list",
		"--workflow",
		workflowFile,
		"--branch",
		"main",
		"--limit",
		"20",
		"--json",
		"databaseId,event,headSha,createdAt",
	]);
	const runs = JSON.parse(output);
	return new Set(
		runs
			.filter((run) => run.event === "workflow_dispatch" && run.headSha === headSha)
			.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
			.map((run) => String(run.databaseId)),
	);
}

function sleep(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
