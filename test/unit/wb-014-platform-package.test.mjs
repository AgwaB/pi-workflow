import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const readRoot = (path) => readFileSync(join(root, path), "utf8");
const parseJson = (text, label) => {
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new Error(`failed to parse ${label}: ${error.message}`);
	}
};
const bundleSpecs = [
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

test("CI validates the complete package surface on macOS and Linux with pinned actions", () => {
	const ci = readRoot(".github/workflows/ci.yml");
	assert.match(
		ci,
		/matrix:\s*\n\s+os:\s*\n\s+- ubuntu-latest\s*\n\s+- macos-latest/,
	);
	assert.match(ci, /runs-on: \$\{\{ matrix\.os \}\}/);
	assert.match(ci, /timeout-minutes: 30/);
	for (const command of [
		"npm run validate",
		"npm run e2e",
		"npm run pack:dry",
	]) {
		assert.ok(ci.includes(command));
	}
	for (const line of ci
		.split("\n")
		.filter((candidate) => /\buses:/.test(candidate))) {
		assert.match(line, /uses:\s+[^@\s]+@[0-9a-f]{40}(?:\s+#\s+v\d+)?$/);
	}
	assert.match(ci, /persist-credentials: false/);
	assert.match(readRoot("README.md"), /macOS or Linux/);
});

test("release checker is shell-free and requires all official default, public variant, and scaffold bundle specs", () => {
	const source = readRoot("tools/release/release-check.mjs");
	assert.match(source, /shell: false/);
	assert.doesNotMatch(source, /sha256sum|readlink|\bstat\s|\bsed\s|\bxargs\s/);
	assert.match(source, /workflows\/README\.md/);
	assert.match(source, /skills\/workflow-guide\/scaffolds\/README\.md/);
	for (const specPath of bundleSpecs)
		assert.ok(source.includes(specPath), specPath);
	for (const forbidden of [
		"workflows/deep-research/batched-verification.spec.json",
		"workflows/deep-review/batched-devil-advocate.spec.json",
		"workflows/spec-review/batched-verification.spec.json",
	]) {
		assert.doesNotMatch(
			source,
			new RegExp(`\\"${forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\"`),
			forbidden,
		);
	}
	assert.match(source, /missing referenced workflow\/scaffold assets/i);
	assert.match(source, /FORBIDDEN_CANDIDATE_PATTERN/);
});

test("publish workflow parses npm pack JSON from a temporary file instead of argv", () => {
	const publish = readRoot(".github/workflows/publish.yml");
	assert.match(publish, /pack_json_file="\$\(mktemp\)"/);
	assert.match(publish, /trap cleanup_pack_json EXIT/);
	assert.match(
		publish,
		/npm pack --ignore-scripts --json > "\$pack_json_file"/,
	);
	assert.match(publish, /readFileSync\(process\.argv\[1\], "utf8"\)/);
	assert.doesNotMatch(
		publish,
		/pack_json="\$\(npm pack --ignore-scripts --json\)"/,
	);
	assert.doesNotMatch(publish, /JSON\.parse\(process\.argv\[1\]\)/);
	assert.doesNotMatch(publish, /"\$pack_json"/);
});

// npm treats a bare path with one slash, such as release-artifact/pkg.tgz, as
// GitHub shorthand. The publish job must hand npm an explicit path instead.
test("publish workflow passes npm an unambiguous tarball path", () => {
	const publish = readRoot(".github/workflows/publish.yml");
	assert.doesNotMatch(
		publish,
		/npm publish\s+"release-artifact\/\$(?:package_file|expected_file)"/,
	);
	assert.match(
		publish,
		/expected_file="agwab-pi-workflow-\$TARGET_VERSION\.tgz"/,
	);
	assert.match(
		publish,
		/package_path="\$PWD\/release-artifact\/\$expected_file"/,
	);
	assert.match(publish, /test -f "\$package_path"/);
	assert.match(
		publish,
		/npm publish "\$package_path" --access public --provenance --ignore-scripts/,
	);
});

test("release pack JSON parser handles the real dry-run manifest from a file path", () => {
	const output = execFileSync(
		"npm",
		["pack", "--dry-run", "--json", "--ignore-scripts"],
		{
			cwd: root,
			encoding: "utf8",
			timeout: 180_000,
		},
	);
	const tmp = mkdtempSync(join(tmpdir(), "pi-workflow-pack-json-"));
	try {
		const manifestPath = join(tmp, "pack.json");
		writeFileSync(manifestPath, output);
		const expected = parseJson(output, "npm pack dry-run output")[0].filename;
		const actual = execFileSync(
			process.execPath,
			[
				"-e",
				"const fs=require('node:fs'); const [p]=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); process.stdout.write(p.filename)",
				manifestPath,
			],
			{ cwd: root, encoding: "utf8" },
		);
		assert.equal(actual, expected);
		assert.ok(output.length > 0, "expected npm pack to emit JSON");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("npm publish dry-run accepts the same safe absolute tarball path form", () => {
	const tmp = mkdtempSync(join(tmpdir(), "pi-workflow-publish-dry-run-"));
	try {
		const packageRoot = join(tmp, "package");
		execFileSync(process.execPath, [
			"-e",
			"require('node:fs').mkdirSync(process.argv[1])",
			packageRoot,
		]);
		writeFileSync(
			join(packageRoot, "package.json"),
			`${JSON.stringify(
				{
					name: `pi-workflow-tarball-path-regression-${process.pid}`,
					version: "0.0.0",
					description: "local npm publish dry-run path regression fixture",
					license: "UNLICENSED",
				},
				null,
				2,
			)}\n`,
		);
		writeFileSync(
			join(packageRoot, "README.md"),
			"# tarball path regression fixture\n",
		);
		const packOutput = execFileSync(
			"npm",
			["pack", "--json", "--ignore-scripts", "--pack-destination", tmp],
			{ cwd: packageRoot, encoding: "utf8", timeout: 180_000 },
		);
		const [summary] = parseJson(packOutput, "npm pack fixture output");
		const packagePath = join(tmp, summary.filename);
		assert.ok(packagePath.startsWith(`${tmp}/`), packagePath);

		const publish = spawnSync(
			"npm",
			[
				"publish",
				packagePath,
				"--dry-run",
				"--ignore-scripts",
				"--access",
				"public",
			],
			{ cwd: root, encoding: "utf8", timeout: 180_000 },
		);
		const combinedOutput = `${publish.stdout}\n${publish.stderr}`;
		assert.equal(
			publish.status,
			0,
			`npm publish --dry-run failed with ${publish.status}: ${combinedOutput}`,
		);
		assert.match(
			combinedOutput,
			/npm notice Publishing to .* with tag latest and public access \(dry-run\)/,
		);
		assert.doesNotMatch(combinedOutput, /\+\s+@agwab\/pi-workflow@/);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("npm dry-run package contains every local asset referenced by official, opt-in, and scaffold specs", () => {
	const output = execFileSync(
		"npm",
		["pack", "--dry-run", "--json", "--ignore-scripts"],
		{
			cwd: root,
			encoding: "utf8",
			timeout: 180_000,
		},
	);
	const [summary] = parseJson(output, "npm pack dry-run output");
	const packed = new Set(summary.files.map((file) => file.path));
	for (const required of [
		"workflows/README.md",
		"skills/workflow-guide/scaffolds/README.md",
		...bundleSpecs,
	]) {
		assert.ok(packed.has(required), `package missing ${required}`);
	}
	for (const file of packed) {
		assert.ok(
			!file.startsWith("internal/"),
			`package must not include ${file}`,
		);
		assert.doesNotMatch(
			file,
			/workflows\/(?:deep-research\/batched-verification|deep-review\/batched-devil-advocate|spec-review\/batched-verification)\.spec\.json|batch-verification-candidates\.mjs|batch-control\.schema\.json/,
		);
	}
	for (const specPath of bundleSpecs) {
		const spec = parseJson(readRoot(specPath), specPath);
		for (const relativeRef of localFileRefs(spec)) {
			const assetPath = posix.normalize(
				posix.join(posix.dirname(specPath), relativeRef),
			);
			assert.ok(
				packed.has(assetPath),
				`${specPath} references unpacked ${assetPath}`,
			);
		}
	}
});

function localFileRefs(value) {
	const refs = [];
	visit(value);
	return [...new Set(refs)];

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
