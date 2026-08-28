#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";

import { isRegistryFreeValidationOnly } from "./release-policy.mjs";
import { assertPackedTypeScriptClosure } from "./typescript-package-closure.mjs";

const BUNDLE_SPEC_FILES = [
	"workflows/deep-research/spec.json",
	"workflows/deep-review/spec.json",
	"workflows/spec-review/spec.json",
	"workflows/impact-review/spec.json",
	"workflows/deep-research/tiered-verification.spec.json",
	"skills/workflow-guide/scaffolds/analysis-dossier/spec.json",
	"skills/workflow-guide/scaffolds/dag-required-reads/spec.json",
	"skills/workflow-guide/scaffolds/foreach-reduce/spec.json",
	"skills/workflow-guide/scaffolds/matrix-dag/spec.json",
	"skills/workflow-guide/scaffolds/object-tool-fallback/spec.json",
	"skills/workflow-guide/scaffolds/support-partition/spec.json",
];

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
	"skills/workflow-guide/scaffolds/README.md",
	"skills/execution-router/SKILL.md",
	"workflows/README.md",
	...BUNDLE_SPEC_FILES,
	"src/extension.ts",
	"src/index.ts",
	"src/code-search-compat-extension.ts",
	"dist/index.js",
	"dist/code-search-compat-extension.js",
	"node_modules/pi-web-access/package.json",
	"node_modules/pi-web-access/index.ts",
	"node_modules/pi-web-access/storage.ts",
	"node_modules/pi-web-access/exa.ts",
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

const FORBIDDEN_CANDIDATE_PATTERN = /workflows\/(?:deep-research\/batched-verification|deep-review\/batched-devil-advocate|spec-review\/batched-verification)\.spec\.json|deep-research-batched-verification-opt-in|deep-review-batched-devil-advocate-opt-in|spec-review-batched-verification-opt-in|batch-verification-candidates\.mjs|deep-research-verify-claims-batch-control\.schema\.json|deep-review-devil-advocate-batch-control\.schema\.json|spec-review-verify-findings-batch-control\.schema\.json|PI_WORKFLOW_CAMPAIGN/;

const SECRET_PATTERN = /\/Users\/toby|\/var\/folders|Desktop|clipboard|Screenshot|API[_-]?KEY|SECRET|PASSWORD|PRIVATE KEY|BEGIN [A-Z ]*PRIVATE KEY|npm_[A-Za-z0-9]{20,}|(^|[^a-zA-Z])sk-[A-Za-z0-9]{20,}/;

const NPM_REGISTRY = "https://registry.npmjs.org";
const NPM_DIST_TAG = "latest";
const npmConfigDir = mkdtempSync(join(tmpdir(), "pi-release-check-"));
const npmEnv = {
	...process.env,
	NPM_CONFIG_USERCONFIG: join(npmConfigDir, "user.npmrc"),
	NPM_CONFIG_GLOBALCONFIG: join(npmConfigDir, "global.npmrc"),
	NPM_CONFIG_REGISTRY: NPM_REGISTRY,
	NPM_CONFIG_TAG: NPM_DIST_TAG,
};
writeFileSync(npmEnv.NPM_CONFIG_USERCONFIG, `registry=${NPM_REGISTRY}/\ntag=${NPM_DIST_TAG}\n`, { mode: 0o600 });
writeFileSync(npmEnv.NPM_CONFIG_GLOBALCONFIG, `registry=${NPM_REGISTRY}/\n`, { mode: 0o600 });
process.on("exit", () => rmSync(npmConfigDir, { recursive: true, force: true }));

function run(command, args, options = {}) {
	console.log(`\n$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(command, args, {
		stdio: "inherit",
		shell: false,
		env: { ...npmEnv, ...(options.env ?? {}) },
		...options,
	});
	if (result.status !== 0) process.exit(result.status ?? 1);
}

function capture(command, args, options = {}) {
	return spawnSync(command, args, {
		encoding: "utf8",
		shell: false,
		env: { ...npmEnv, ...(options.env ?? {}) },
		...options,
	});
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
if (JSON.stringify(pkg.publishConfig) !== '{"access":"public"}') {
	console.error('package.json publishConfig must be exactly {"access":"public"} with no registry or tag.');
	process.exit(1);
}
const trackedFiles = capture("git", ["ls-files", "-z"]);
if (trackedFiles.status !== 0) {
	console.error("unable to inspect tracked files for npm configuration");
	process.exit(trackedFiles.status ?? 1);
}
const trackedNpmrc = trackedFiles.stdout
	.split("\0")
	.filter((path) => path && path.split("/").at(-1) === ".npmrc");
if (trackedNpmrc.length > 0) {
	console.error(`tracked .npmrc is forbidden: ${trackedNpmrc.join(", ")}`);
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

const lock = JSON.parse(
	readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"),
);
const lockedPiWebAccessVersion =
	lock.packages?.["node_modules/pi-web-access"]?.version;
if (
	typeof lockedPiWebAccessVersion !== "string" ||
	!lockedPiWebAccessVersion.trim()
) {
	console.error("package-lock.json must pin node_modules/pi-web-access.");
	process.exit(1);
}
const bundledPiWebAccess = JSON.parse(
	readFileSync(
		new URL("../../node_modules/pi-web-access/package.json", import.meta.url),
		"utf8",
	),
);
if (bundledPiWebAccess.version !== lockedPiWebAccessVersion) {
	console.error(
		`bundled pi-web-access must match package-lock.json (${lockedPiWebAccessVersion}); found ${bundledPiWebAccess.version}`,
	);
	process.exit(1);
}

const allowPublishedVersion = process.env.PI_WORKFLOW_ALLOW_PUBLISHED_VERSION === "1";
const registryFreeValidationOnly = isRegistryFreeValidationOnly(process.env);

if (registryFreeValidationOnly) {
	console.log("Skipping npm whoami in the GitHub Actions validation-only environment.");
} else if (process.env.GITHUB_ACTIONS === "true") {
	console.log("Skipping npm whoami in GitHub Actions; publish authentication is handled by trusted publishing/OIDC.");
} else {
	const npmWhoami = capture("npm", ["whoami", "--registry", NPM_REGISTRY]);
	if (npmWhoami.status !== 0) {
		console.error("npm whoami failed. Run npm login first or use the GitHub Actions release workflow.");
		process.exit(npmWhoami.status ?? 1);
	}
	console.log(`npm user: ${npmWhoami.stdout.trim()}`);
}

let versionAlreadyPublished = false;
if (registryFreeValidationOnly) {
	console.log("Skipping npm view in the GitHub Actions validation-only environment.");
} else {
	const versionView = capture("npm", ["view", `${pkg.name}@${pkg.version}`, "version", "--registry", NPM_REGISTRY, "--tag", NPM_DIST_TAG]);
	if (versionView.status !== 0) {
		if (!/npm (ERR!|error) code E404/i.test(`${versionView.stdout}\n${versionView.stderr}`)) {
			console.error("npm view failed; refusing to reinterpret an unavailable registry response as a new version.");
			process.exit(versionView.status ?? 1);
		}
	} else if (versionView.stdout.trim() === pkg.version) {
		versionAlreadyPublished = true;
		if (!allowPublishedVersion) {
			console.error(`${pkg.name}@${pkg.version} already exists on npm. Bump version before publishing, or set PI_WORKFLOW_ALLOW_PUBLISHED_VERSION=1 for validation-only reruns.`);
			process.exit(1);
		}
		console.log(`${pkg.name}@${pkg.version} already exists on npm; running validation-only checks.`);
	} else {
		console.error("npm view returned an unexpected version; refusing to continue.");
		process.exit(1);
	}
}

run("npm", ["run", "check:scripts"]);
run("npm", ["run", "check:release-workflow"]);
run("npm", ["run", "check:public-surface"]);
run("npm", ["run", "typecheck"]);
run("npm", ["run", "test:unit"]);
run("npm", ["run", "e2e"]);
run("npm", ["run", "build"]);

const NPM_PACK_JSON_MAX_BUFFER = 8 * 1024 * 1024;

console.log("\n$ npm pack --dry-run --json --ignore-scripts");
const pack = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts", "--registry", NPM_REGISTRY, "--tag", NPM_DIST_TAG], {
	encoding: "utf8",
	maxBuffer: NPM_PACK_JSON_MAX_BUFFER,
	env: npmEnv,
});
const [summary] = JSON.parse(pack);
const files = summary.files.map((file) => file.path);

const missing = REQUIRED_FILES.filter((path) => !files.includes(path));
if (missing.length > 0) {
	console.error(`Package is missing required files: ${missing.join(", ")}`);
	process.exit(1);
}

const piWebAccessPrefix = "node_modules/pi-web-access/";
try {
	assertPackedTypeScriptClosure({
		packageRoot: "node_modules/pi-web-access",
		entryPaths: ["index.ts", "storage.ts"],
		packedPaths: files
			.filter((path) => path.startsWith(piWebAccessPrefix))
			.map((path) => path.slice(piWebAccessPrefix.length)),
	});
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}

const missingBundleAssets = [];
for (const specPath of BUNDLE_SPEC_FILES) {
	const spec = JSON.parse(readFileSync(specPath, "utf8"));
	for (const relativeRef of localFileRefs(spec)) {
		const assetPath = posix.normalize(
			posix.join(posix.dirname(specPath), relativeRef),
		);
		if (!files.includes(assetPath)) missingBundleAssets.push(assetPath);
	}
}
if (missingBundleAssets.length > 0) {
	console.error(
		`Package is missing referenced workflow/scaffold assets: ${[...new Set(missingBundleAssets)].join(", ")}`,
	);
	process.exit(1);
}

const forbidden = files.filter((path) =>
	FORBIDDEN_PACKAGE_PREFIXES.some((prefix) => path.startsWith(prefix)),
);
if (forbidden.length > 0) {
	console.error(`Package includes local/internal files:\n${forbidden.join("\n")}`);
	process.exit(1);
}

const forbiddenCandidateFiles = files.filter((path) => FORBIDDEN_CANDIDATE_PATTERN.test(path));
if (forbiddenCandidateFiles.length > 0) {
	console.error(`Package includes internalized workflow-specific batched candidate assets:\n${forbiddenCandidateFiles.join("\n")}`);
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

if (registryFreeValidationOnly) {
	console.log("\nSkipping npm publish --dry-run in the GitHub Actions validation-only environment.");
} else if (versionAlreadyPublished) {
	console.log("\nSkipping npm publish --dry-run because this version already exists on npm.");
} else {
	run("npm", ["publish", "--dry-run", "--access", "public", "--registry", NPM_REGISTRY, "--tag", NPM_DIST_TAG]);
}
console.log("\nRelease check passed. Prefer the GitHub Actions Publish workflow for real releases.");

function localFileRefs(value) {
	const refs = [];
	visit(value);
	return refs;

	function visit(candidate) {
		if (typeof candidate === "string") {
			if (/^\.\/.+\.(?:json|mjs|js)$/.test(candidate)) refs.push(candidate);
			return;
		}
		if (Array.isArray(candidate)) {
			for (const item of candidate) visit(item);
			return;
		}
		if (!candidate || typeof candidate !== "object") return;
		for (const item of Object.values(candidate)) visit(item);
	}
}
