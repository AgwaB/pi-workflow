import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isRegistryFreeValidationOnly } from "../../tools/release/release-policy.mjs";
import { assertPackedTypeScriptClosure } from "../../tools/release/typescript-package-closure.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureRoot = join(root, "test", "fixtures", "package-closure");
const completeFixtureFiles = [
	"cycle/a.ts",
	"cycle/b.ts",
	"extract.ts",
	"feature/index.ts",
	"index.ts",
	"required.ts",
	"storage.ts",
	"types.ts",
];
const completeJsBridgeFixtureFiles = [
	"bridge.cjs",
	"bridge.js",
	"bridge.json",
	"bridge.jsx",
	"bridge.mjs",
	"js-bridge.ts",
];

test("WB-003 TypeScript closure follows type imports, re-exports, dynamic imports, require, index resolution, and cycles", () => {
	const result = assertPackedTypeScriptClosure({
		packageRoot: join(fixtureRoot, "package"),
		entryPaths: ["index.ts", "storage.ts"],
		packedPaths: completeFixtureFiles,
	});
	assert.deepEqual(result.files, completeFixtureFiles);
	assert.deepEqual(
		new Set(result.edges.map((edge) => edge.kind)),
		new Set(["import", "export", "dynamic-import", "require"]),
	);
	assert.ok(
		result.edges.some(
			(edge) =>
				edge.specifier === "./feature" && edge.to === "feature/index.ts",
		),
	);
});

test("WB-003 package closure traverses complete JS, JSX, MJS, and CJS bridges", () => {
	const result = assertPackedTypeScriptClosure({
		packageRoot: join(fixtureRoot, "package"),
		entryPaths: ["js-bridge.ts"],
		packedPaths: completeJsBridgeFixtureFiles,
	});
	assert.deepEqual(result.files, completeJsBridgeFixtureFiles);
	assert.deepEqual(
		result.edges.map((edge) => `${edge.from} -> ${edge.to}`),
		[
			"bridge.cjs -> bridge.json",
			"bridge.js -> bridge.jsx",
			"bridge.jsx -> bridge.mjs",
			"bridge.mjs -> bridge.cjs",
			"js-bridge.ts -> bridge.js",
		],
	);
});

test("WB-003 package closure reports an omitted transitive JS bridge deterministically", () => {
	const packedPaths = JSON.parse(
		readFileSync(
			join(fixtureRoot, "packed-js-bridge-without-transitive.json"),
			"utf8",
		),
	);
	const invoke = () =>
		assertPackedTypeScriptClosure({
			packageRoot: join(fixtureRoot, "package"),
			entryPaths: ["js-bridge.ts"],
			packedPaths,
		});
	const expected =
		'Packed TypeScript closure is incomplete:\n- bridge.mjs -> "./bridge.cjs": packed target is missing (bridge.cjs)';
	assert.throws(invoke, (error) => error.message === expected);
	assert.throws(invoke, (error) => error.message === expected);
});

test("WB-003 TypeScript closure reports omitted dynamic extract target deterministically", () => {
	const packedPaths = JSON.parse(
		readFileSync(
			join(fixtureRoot, "packed-without-dynamic-extract.json"),
			"utf8",
		),
	);
	const invoke = () =>
		assertPackedTypeScriptClosure({
			packageRoot: join(fixtureRoot, "package"),
			entryPaths: ["index.ts", "storage.ts"],
			packedPaths,
		});
	const expected =
		'Packed TypeScript closure is incomplete:\n- index.ts -> "./extract.ts": packed target is missing (extract.ts)';
	assert.throws(invoke, (error) => error.message === expected);
	assert.throws(invoke, (error) => error.message === expected);
});

test("WB-003 TypeScript closure rejects package-root escapes", () => {
	assert.throws(
		() =>
			assertPackedTypeScriptClosure({
				packageRoot: join(fixtureRoot, "escape-package"),
				entryPaths: ["index.ts"],
				packedPaths: ["index.ts"],
			}),
		(error) =>
			error.message ===
			'Packed TypeScript closure is incomplete:\n- index.ts -> "../outside.ts": package root escape',
	);
});

test("WB-003 real dry-run pack contains storage and the recursive pi-web-access closure", () => {
	const output = execFileSync(
		"npm",
		["pack", "--dry-run", "--json", "--ignore-scripts"],
		{
			cwd: root,
			encoding: "utf8",
			timeout: 180_000,
			maxBuffer: 8 * 1024 * 1024,
			env: {
				...process.env,
				npm_config_offline: "true",
				npm_config_audit: "false",
				npm_config_fund: "false",
				npm_config_update_notifier: "false",
			},
		},
	);
	const [summary] = JSON.parse(output);
	const paths = summary.files.map((file) => file.path);
	const prefix = "node_modules/pi-web-access/";
	assert.ok(paths.includes(`${prefix}storage.ts`));
	const result = assertPackedTypeScriptClosure({
		packageRoot: join(root, "node_modules", "pi-web-access"),
		entryPaths: ["index.ts", "storage.ts"],
		packedPaths: paths
			.filter((path) => path.startsWith(prefix))
			.map((path) => path.slice(prefix.length)),
	});
	assert.ok(result.files.includes("extract.ts"));
	assert.ok(
		result.edges.some(
			(edge) =>
				edge.kind === "dynamic-import" && edge.specifier === "./extract.ts",
		),
	);
});

test("WB-003 required E2E inventory is no-install, isolated, instrumented, and release-check retained", () => {
	const runner = readFileSync(join(root, "test", "e2e", "run.mjs"), "utf8");
	const packedLoader = readFileSync(
		join(root, "test", "e2e", "cases", "packed-web-loader.mjs"),
		"utf8",
	);
	const releaseCheck = readFileSync(
		join(root, "tools", "release", "release-check.mjs"),
		"utf8",
	);
	const packageInstallPattern = new RegExp(
		`(?:npm\\s+(?:${["inst", "all"].join("")}|ci|add)|pnpm\\s+(?:${["inst", "all"].join("")}|add)|yarn\\s+(?:${["inst", "all"].join("")}|add))`,
		"i",
	);
	for (const [name, source] of [
		["E2E runner", runner],
		["packed loader", packedLoader],
		["release check", releaseCheck],
	]) {
		assert.doesNotMatch(source, packageInstallPattern, name);
	}
	assert.doesNotMatch(runner, new RegExp(["consumer", "install", "cli"].join("-")));
	assert.doesNotMatch(runner, /packed-durable-barrier-v2|providerPi|provider-tool-fixture/);
	assert.match(runner, /packed-web-loader/);
	assert.match(runner, /PI_WORKFLOW_E2E_NO_EXTERNAL_ACTIONS/);
	assert.match(runner, /PI_CODING_AGENT_DIR/);
	assert.match(runner, /XDG_CONFIG_HOME/);
	assert.match(runner, /blocked-command.*network-attempt.*provider-tool-execution/s);
	assert.match(packedLoader, /DefaultResourceLoader/);
	assert.match(packedLoader, /packed-workflows\.mjs/);
	assert.match(packedLoader, /consumerRequire\.resolve\("@agwab\/pi-workflow"\)/);
	assert.match(packedLoader, /loadedToolExecutions, 0/);
	assert.match(releaseCheck, /run\("npm", \["run", "e2e"\]\)/);
	assert.match(releaseCheck, /run\("npm", \["publish", "--dry-run", "--access", "public", "--registry", NPM_REGISTRY, "--tag", NPM_DIST_TAG\]\)/);
});

test("WB-003 registry-free validation mode is limited to the exact approved environment", () => {
	assert.equal(
		isRegistryFreeValidationOnly({
			PI_WORKFLOW_ALLOW_PUBLISHED_VERSION: "1",
			GITHUB_ACTIONS: "true",
		}),
		true,
	);
	for (const env of [
		{},
		{ PI_WORKFLOW_ALLOW_PUBLISHED_VERSION: "1" },
		{ GITHUB_ACTIONS: "true" },
		{
			PI_WORKFLOW_ALLOW_PUBLISHED_VERSION: "true",
			GITHUB_ACTIONS: "true",
		},
		{
			PI_WORKFLOW_ALLOW_PUBLISHED_VERSION: "1",
			GITHUB_ACTIONS: "1",
		},
	]) {
		assert.equal(isRegistryFreeValidationOnly(env), false);
	}
	const source = readFileSync(
		join(root, "tools", "release", "release-check.mjs"),
		"utf8",
	);
	assert.match(source, /registryFreeValidationOnly/);
	assert.match(source, /Skipping npm view/);
	assert.match(source, /Skipping npm publish --dry-run/);
	assert.match(source, /Skipping npm whoami/);
});
