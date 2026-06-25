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

console.log(`Dispatching Publish for ${pkg.name}@${version} on origin/main...`);
run("gh", ["workflow", "run", "publish.yml", "--ref", "main", "-f", `version=${version}`]);
if (watch) run("gh", ["run", "watch"]);

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
