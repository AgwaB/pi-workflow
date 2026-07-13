import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const readRoot = (path) => readFileSync(join(root, path), "utf8");
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
	for (const command of ["npm run validate", "npm run e2e", "npm run pack:dry"]) {
		assert.ok(ci.includes(command));
	}
	for (const line of ci.split("\n").filter((candidate) => /\buses:/.test(candidate))) {
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
	for (const specPath of bundleSpecs) assert.ok(source.includes(specPath), specPath);
	for (const forbidden of [
		"workflows/deep-research/batched-verification.spec.json",
		"workflows/deep-review/batched-devil-advocate.spec.json",
		"workflows/spec-review/batched-verification.spec.json",
	]) {
		assert.doesNotMatch(source, new RegExp(`\\"${forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\"`), forbidden);
	}
	assert.match(source, /missing referenced workflow\/scaffold assets/i);
	assert.match(source, /FORBIDDEN_CANDIDATE_PATTERN/);
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
	const [summary] = JSON.parse(output);
	const packed = new Set(summary.files.map((file) => file.path));
	for (const required of [
		"workflows/README.md",
		"skills/workflow-guide/scaffolds/README.md",
		...bundleSpecs,
	]) {
		assert.ok(packed.has(required), `package missing ${required}`);
	}
	for (const file of packed) {
		assert.ok(!file.startsWith("internal/"), `package must not include ${file}`);
		assert.doesNotMatch(file, /workflows\/(?:deep-research\/batched-verification|deep-review\/batched-devil-advocate|spec-review\/batched-verification)\.spec\.json|batch-verification-candidates\.mjs|batch-control\.schema\.json/);
	}
	for (const specPath of bundleSpecs) {
		const spec = JSON.parse(readRoot(specPath));
		for (const relativeRef of localFileRefs(spec)) {
			const assetPath = posix.normalize(
				posix.join(posix.dirname(specPath), relativeRef),
			);
			assert.ok(packed.has(assetPath), `${specPath} references unpacked ${assetPath}`);
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
