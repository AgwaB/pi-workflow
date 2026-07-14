#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const tracked = execFileSync("git", ["-C", root, "ls-files", "-z"], {
	encoding: "utf8",
})
	.split("\0")
	.filter(Boolean)
	.sort();

const violations = [];
const forbiddenExact = new Set(["AGENTS.md", "CHANGELOG.md"]);
const forbiddenPrefixes = ["docs/maintenance/", "internal/"];

for (const path of tracked) {
	if (forbiddenExact.has(path)) {
		violations.push(`${path}: local maintenance surface must not be tracked`);
	}
	if (forbiddenPrefixes.some((prefix) => path.startsWith(prefix))) {
		violations.push(`${path}: local maintenance surface must not be tracked`);
	}
	if (path.startsWith("tools/") && !path.startsWith("tools/release/")) {
		violations.push(
			`${path}: public tools are allowlisted under tools/release/ only; move maintenance, measurement, or forensics tools under ignored internal/`,
		);
	}
	if (isTextFile(path)) {
		try {
			const text = readFileSync(join(root, path), "utf8");
			if (/\/Users\/[A-Za-z0-9._-]+\//.test(text)) {
				violations.push(`${path}: contains a local macOS home path`);
			}
		} catch (error) {
			violations.push(`${path}: could not inspect tracked text (${errorMessage(error)})`);
		}
	}
}

let packageJson;
try {
	packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
} catch (error) {
	console.error(`Unable to inspect package.json: ${errorMessage(error)}`);
	process.exit(1);
}
for (const path of packageJson.files ?? []) {
	if (
		path === "AGENTS.md" ||
		path === "CHANGELOG.md" ||
		path === "internal" ||
		path.startsWith("internal/") ||
		path === "tools" ||
		path.startsWith("tools/") ||
		path === "docs/maintenance" ||
		path.startsWith("docs/maintenance/")
	) {
		violations.push(`package.json files exposes non-product surface: ${path}`);
	}
}

if (violations.length > 0) {
	console.error(`Public surface check failed:\n${violations.map((item) => `- ${item}`).join("\n")}`);
	process.exit(1);
}

console.log(
	`Public surface check passed (${tracked.length} tracked files; tools allowlist: tools/release/).`,
);

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

function isTextFile(path) {
	if (["LICENSE", ".gitignore"].includes(path)) return true;
	return new Set([
		".cjs",
		".css",
		".html",
		".js",
		".json",
		".md",
		".mjs",
		".ts",
		".tsx",
		".txt",
		".yaml",
		".yml",
	]).has(extname(path));
}
