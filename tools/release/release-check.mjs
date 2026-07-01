#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const REQUIRED_FILES = [
	"README.md",
	"docs/usage.md",
	"docs/assets/readme/logo.svg",
	"docs/assets/readme/stage-types.png",
	"docs/assets/readme/deep-research-flow.png",
	"docs/assets/readme/deep-review-flow.png",
	"docs/assets/readme/spec-review-flow.png",
	"docs/assets/readme/impact-review-flow.png",
	"docs/assets/readme/workflow-board-runs.png",
	"docs/assets/readme/workflow-board-stages.png",
	"docs/assets/readme/workflow-board-tasks.png",
	"docs/assets/readme/workflow-board-task-detail.png",
	"agents/researcher.md",
	"agents/scout.md",
	"skills/workflow-guide/SKILL.md",
	"skills/execution-router/SKILL.md",
	"workflows/deep-research/spec.json",
	"workflows/deep-review/spec.json",
	"workflows/spec-review/spec.json",
	"workflows/impact-review/spec.json",
	"src/extension.ts",
	"src/index.ts",
	"dist/index.js",
	"package.json",
	"LICENSE",
];

const FORBIDDEN_PACKAGE_PREFIXES = [
	".git/",
	".github/",
	".harness/",
	".pi/",
	".tmp/",
	".worktrees/",
	"cache/",
	"dist/.tmp/",
	"docker/",
	"internal/",
	"test/",
];

const SECRET_PATTERN = /\/Users\/toby|\/var\/folders|Desktop|clipboard|Screenshot|API[_-]?KEY|SECRET|PASSWORD|PRIVATE KEY|BEGIN [A-Z ]*PRIVATE KEY|npm_[A-Za-z0-9]{20,}|(^|[^a-zA-Z])sk-[A-Za-z0-9]{20,}/;

function run(command, args, options = {}) {
	console.log(`\n$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(command, args, {
		stdio: "inherit",
		shell: false,
		...options,
	});
	if (result.status !== 0) process.exit(result.status ?? 1);
}

function capture(command, args) {
	return spawnSync(command, args, { encoding: "utf8", shell: false });
}

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

if (pkg.private === true) {
	console.error("package.json has private:true; refusing release check.");
	process.exit(1);
}
if (pkg.name !== "@agwab/pi-workflow") {
	console.error(`unexpected package name: ${pkg.name}`);
	process.exit(1);
}
if (pkg.publishConfig?.access !== "public") {
	console.error('package.json publishConfig.access must be "public".');
	process.exit(1);
}
if (!pkg.keywords?.includes("pi-package")) {
	console.error('package.json keywords must include "pi-package".');
	process.exit(1);
}
if (!pkg.pi?.extensions?.length) {
	console.error("package.json must declare pi.extensions.");
	process.exit(1);
}
if (!pkg.pi?.skills?.length) {
	console.error("package.json must declare pi.skills.");
	process.exit(1);
}
for (const dependency of ["@agwab/pi-subagent", "pi-web-access"]) {
	if (!pkg.dependencies?.[dependency]) {
		console.error(`package.json dependencies must include ${dependency}.`);
		process.exit(1);
	}
	if (!pkg.bundleDependencies?.includes(dependency)) {
		console.error(`package.json bundleDependencies must include ${dependency}.`);
		process.exit(1);
	}
}

if (process.env.GITHUB_ACTIONS === "true") {
	console.log("Skipping npm whoami in GitHub Actions; publish authentication is handled by trusted publishing/OIDC.");
} else {
	const npmWhoami = capture("npm", ["whoami"]);
	if (npmWhoami.status !== 0) {
		console.error("npm whoami failed. Run npm login first or use the GitHub Actions release workflow.");
		process.exit(npmWhoami.status ?? 1);
	}
	console.log(`npm user: ${npmWhoami.stdout.trim()}`);
}

const allowPublishedVersion = process.env.PI_WORKFLOW_ALLOW_PUBLISHED_VERSION === "1";
let versionAlreadyPublished = false;
const versionView = capture("npm", ["view", `${pkg.name}@${pkg.version}`, "version"]);
if (versionView.status === 0 && versionView.stdout.trim() === pkg.version) {
	versionAlreadyPublished = true;
	if (!allowPublishedVersion) {
		console.error(`${pkg.name}@${pkg.version} already exists on npm. Bump version before publishing, or set PI_WORKFLOW_ALLOW_PUBLISHED_VERSION=1 for validation-only reruns.`);
		process.exit(1);
	}
	console.log(`${pkg.name}@${pkg.version} already exists on npm; running validation-only checks.`);
}

run("npm", ["run", "check:scripts"]);
run("npm", ["run", "typecheck"]);
run("npm", ["run", "test:unit"]);
run("npm", ["run", "e2e"]);
run("npm", ["run", "build"]);

console.log("\n$ npm pack --dry-run --json");
const pack = execFileSync("npm", ["pack", "--dry-run", "--json"], {
	encoding: "utf8",
});
const [summary] = JSON.parse(pack);
const files = summary.files.map((file) => file.path);

const missing = REQUIRED_FILES.filter((path) => !files.includes(path));
if (missing.length > 0) {
	console.error(`Package is missing required files: ${missing.join(", ")}`);
	process.exit(1);
}

const forbidden = files.filter((path) =>
	FORBIDDEN_PACKAGE_PREFIXES.some((prefix) => path.startsWith(prefix)),
);
if (forbidden.length > 0) {
	console.error(`Package includes local/internal files:\n${forbidden.join("\n")}`);
	process.exit(1);
}

const ownTextFiles = files.filter(
	(path) =>
		!path.startsWith("node_modules/") &&
		!path.match(/\.(png|jpg|jpeg|gif|webp|svg)$/i) &&
		existsSync(path),
);
for (const path of ownTextFiles) {
	const text = readFileSync(path, "utf8");
	if (SECRET_PATTERN.test(text)) {
		console.error(`Package file contains local path or secret-like text: ${path}`);
		process.exit(1);
	}
}

console.log(JSON.stringify({
	name: summary.name,
	version: summary.version,
	filename: summary.filename,
	entryCount: summary.entryCount,
	packageSize: summary.size,
	unpackedSize: summary.unpackedSize,
}, null, 2));

if (versionAlreadyPublished) {
	console.log("\nSkipping npm publish --dry-run because this version already exists on npm.");
} else {
	run("npm", ["publish", "--dry-run", "--access", "public"]);
}
console.log("\nRelease check passed. Prefer the GitHub Actions Publish workflow for real releases.");
