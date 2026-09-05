import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse } from "yaml";

const checker = fileURLToPath(new URL("../../tools/release/check-scripts.mjs", import.meta.url));
function fixture(change) {
	const cwd = mkdtempSync(join(tmpdir(), "workflow-lock-check-"));
	const manifest = { name: "fixture", version: "1.0.0", dependencies: { pkg: "^1.0.0" } };
	const lock = { lockfileVersion: 3, packages: {
		"": structuredClone(manifest),
		"node_modules/pkg": { version: "1.0.1" },
		"node_modules/pkg/node_modules/child": { version: "2.0.0" },
		"node_modules/@scope/platform": { version: "3.0.0", optional: true },
	} };
	const files = { "node_modules/pkg/package.json": { version: "1.0.1" },
		"node_modules/pkg/node_modules/child/package.json": { version: "2.0.0" } };
	try {
		change?.({ manifest, lock, files });
		files["package.json"] = manifest;
		files["package-lock.json"] = lock;
		for (const [path, value] of Object.entries(files)) {
			mkdirSync(dirname(join(cwd, path)), { recursive: true });
			writeFileSync(join(cwd, path), typeof value === "string" ? value : JSON.stringify(value));
		}
		const before = Object.keys(files).map((path) => [path, readFileSync(join(cwd, path))]);
		const result = spawnSync(process.execPath, [checker], { cwd, encoding: "utf8" });
		for (const [path, bytes] of before) assert.deepEqual(readFileSync(join(cwd, path)), bytes);
		return result;
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

test("dependency checker accepts exact versions and absent platform-optional packages", () => {
	const result = fixture();
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /2 installed package versions/);
});
for (const [name, change, message] of [
	["declaration drift", ({ manifest }) => { manifest.dependencies.pkg = "^2.0.0"; }, /dependencies differs/],
	["missing direct lock entry", ({ lock }) => { delete lock.packages["node_modules/pkg"]; }, /missing lock entry/],
	["transitive installed drift", ({ files }) => { files["node_modules/pkg/node_modules/child/package.json"].version = "2.1.0"; }, /installed 2.1.0, locked 2.0.0/],
	["missing required install", ({ files }) => { delete files["node_modules/pkg/package.json"]; }, /cannot read node_modules\/pkg/],
	["malformed installed metadata", ({ files }) => { files["node_modules/pkg/package.json"] = "{"; }, /cannot read node_modules\/pkg/],
	["installed optional drift", ({ files }) => { files["node_modules/@scope/platform/package.json"] = { version: "4.0.0" }; }, /installed 4.0.0, locked 3.0.0/],
	["unsafe lock path", ({ lock }) => { lock.packages["node_modules/../../outside"] = { version: "1.0.0" }; }, /unsupported lock package path/],
]) {
	test(`dependency checker rejects ${name} without changing files`, () => {
		const result = fixture(change);
		assert.equal(result.status, 1);
		assert.match(result.stderr, message);
	});
}

test("CI tests minimum Node and current Node 24 on both platforms with pinned actions", () => {
	const workflow = parse(readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"));
	const job = workflow.jobs.checks;
	assert.deepEqual(job.strategy.matrix.node, ["22.19.0", "24"]);
	assert.deepEqual(job.strategy.matrix.os, ["ubuntu-latest", "macos-latest"]);
	assert.equal(job.steps.find((step) => step.uses?.startsWith("actions/setup-node@")).with["node-version"], "${{ matrix.node }}");
	assert.deepEqual(job.steps.filter((step) => step.uses).map((step) => step.uses), [
		"actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10",
		"actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
	]);
});
