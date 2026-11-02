import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";
import {
	assertPackedArchiveUnchanged, assertCompiledTreesEqual, assertCompiledTreeUnchanged,
	captureArtifactFile, captureCompiledTree, capturePackedArchive,
	readCompiledManifest, recordArtifactPath, writeCompiledManifest,
} from "../e2e/compiled-artifact-proof.mjs";

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
	"skills/workflow-guide/scaffolds/fixed-inventory/spec.json",
	"skills/workflow-guide/scaffolds/matrix-dag/spec.json",
	"skills/workflow-guide/scaffolds/object-tool-fallback/spec.json",
	"skills/workflow-guide/scaffolds/support-partition/spec.json",
];

test("C06 package surface: CI validates the complete package surface on macOS and Linux with pinned actions", () => {
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

test("package validation pack commands never run lifecycle builds", () => {
	const packageJson = parseJson(readRoot("package.json"), "package.json");
	assert.match(packageJson.scripts["pack:dry"], /npm pack .*--ignore-scripts/);

	const releaseCheck = readRoot("tools/release/release-check.mjs");
	assert.match(
		releaseCheck,
		/\["pack", "--dry-run", "--json", "--ignore-scripts", "--registry"/,
	);

	const packedLoader = readRoot("test/e2e/cases/packed-web-loader.mjs");
	assert.match(
		packedLoader,
		/\["pack", "--pack-destination", packDir, "--silent", "--ignore-scripts"\]/,
	);
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
	for (const requiredPath of [
		"skills/workflow-guide/scaffolds/fixed-inventory/initialize.mjs",
		"skills/workflow-guide/scaffolds/fixed-inventory/helpers/exact-source-join.mjs",
		"src/code-search-compat-extension.ts",
		"dist/code-search-compat-extension.js",
		"node_modules/pi-web-access/package.json",
		"node_modules/pi-web-access/index.ts",
		"node_modules/pi-web-access/storage.ts",
		"node_modules/pi-web-access/exa.ts",
	]) {
		assert.ok(source.includes(requiredPath), requiredPath);
	}
	assert.match(
		source,
		/lock\.packages\?\.\["node_modules\/pi-web-access"\]\?\.version/,
	);
	assert.match(source, /bundled pi-web-access must match package-lock\.json/);
	assert.match(source, /assertPackedTypeScriptClosure/);
	assert.match(source, /entryPaths: \["index\.ts", "storage\.ts"\]/);
	assert.match(source, /registryFreeValidationOnly/);
	assert.match(
		source,
		/const NPM_PACK_JSON_MAX_BUFFER = 8 \* 1024 \* 1024;/,
	);
	assert.match(
		source,
		/execFileSync\("npm", \["pack", "--dry-run", "--json", "--ignore-scripts", "--registry", NPM_REGISTRY, "--tag", NPM_DIST_TAG\], \{[\s\S]*?maxBuffer: NPM_PACK_JSON_MAX_BUFFER,[\s\S]*?\}\);/,
	);
});

test("publish workflow parses npm pack JSON from a temporary file instead of argv", () => {
	const publish = readRoot(".github/workflows/publish.yml");
	assert.match(publish, /pack_json_file="\$\(mktemp\)"/);
	assert.match(publish, /trap cleanup_pack_json EXIT/);
	assert.match(
		publish,
		/npm pack --ignore-scripts --registry https:\/\/registry\.npmjs\.org --tag latest --json > "\$pack_json_file"/
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
		/npm publish "\$package_path" --access public --provenance --ignore-scripts --registry https:\/\/registry\.npmjs\.org --tag latest/,
	);
	const commands = [...publish.matchAll(/^\s*npm publish[^\n]*$/gm)];
	assert.equal(commands.length, 1, "exactly one active publication command");
	assert.equal(commands[0][0].trim(),
		'npm publish "$package_path" --access public --provenance --ignore-scripts --registry https://registry.npmjs.org --tag latest');
	const publicationOffset = commands[0].index;
	for (const required of [
		'test -f "$package_path"',
		'actual_sha="$(sha256sum "$package_path" | awk \'{print $1}\')"',
		'test "$actual_sha" = "$BUILD_PACKAGE_SHA"',
	]) {
		const offset = publish.indexOf(required);
		assert.ok(offset >= 0 && offset < publicationOffset, required);
	}
	assert.deepEqual(JSON.parse(readRoot("package.json")).publishConfig, { access: "public" });
	assert.ok(publish.includes('JSON.stringify(pkg.publishConfig) !== \'{"access":"public"}\''));
	assert.ok(publish.includes('JSON.stringify(p.publishConfig)'));
	assert.ok(publish.includes('test "$packed_config" = \'{"access":"public"}\''));
});

test("release pack JSON parser handles the real dry-run manifest from a file path", () => {
	const output = execFileSync(
		"npm",
		["pack", "--dry-run", "--json", "--ignore-scripts"],
		{
			cwd: root,
			encoding: "utf8",
			timeout: 180_000,
			maxBuffer: 8 * 1024 * 1024,
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
		assert.ok(
			Buffer.byteLength(output, "utf8") < 8 * 1024 * 1024,
			"pack manifest must remain within the bounded release-check buffer",
		);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

// Executable package-spec coverage, not publish-subcommand or registry evidence.
// Actual publish dry-run remains a separately authorized release-context check.
test("offline npm pack resolves the absolute tarball operand used by publication", () => {
	const tmp = mkdtempSync(join(tmpdir(), "pi-workflow-tarball-path-"));
	try {
		const packageRoot = join(tmp, "package");
		const packageName = `pi-workflow-tarball-path-regression-${process.pid}`;
		execFileSync(process.execPath, [
			"-e",
			"require('node:fs').mkdirSync(process.argv[1])",
			packageRoot,
		]);
		writeFileSync(
			join(packageRoot, "package.json"),
			`${JSON.stringify(
				{
					name: packageName,
					version: "0.0.0",
					description: "offline npm tarball package-spec regression fixture",
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
			["pack", "--json", "--ignore-scripts", "--offline", "--pack-destination", tmp],
			{ cwd: packageRoot, encoding: "utf8", timeout: 180_000, maxBuffer: 1024 * 1024 },
		);
		const summaries = parseJson(packOutput, "npm pack fixture output");
		assert.equal(summaries.length, 1);
		const [summary] = summaries;
		const packagePath = realpathSync(join(tmp, summary.filename));
		assert.equal(dirname(packagePath), realpathSync(tmp));
		assert.ok(packagePath.endsWith(".tgz"), packagePath);

		const resolved = execFileSync(
			"npm",
			[
				"pack",
				packagePath,
				"--dry-run",
				"--json",
				"--ignore-scripts",
				"--offline",
			],
			{ cwd: root, encoding: "utf8", timeout: 180_000, maxBuffer: 1024 * 1024 },
		);
		const parsed = parseJson(resolved, "npm absolute tarball dry-run output");
		assert.equal(parsed.length, 1);
		assert.equal(parsed[0].name, packageName);
		assert.equal(parsed[0].version, "0.0.0");
		assert.deepEqual(parsed[0].files.map(file => file.path).sort(),
			summary.files.map(file => file.path).sort());
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("C06 npm dry-run package contains required public assets and excludes internal or experimental artifacts", () => {
	const output = execFileSync(
		"npm",
		["pack", "--dry-run", "--json", "--ignore-scripts"],
		{
			cwd: root,
			encoding: "utf8",
			timeout: 180_000,
			maxBuffer: 8 * 1024 * 1024,
		},
	);
	const [summary] = parseJson(output, "npm pack dry-run output");
	const packed = new Set(summary.files.map((file) => file.path));
	for (const required of [
		"workflows/README.md",
		"skills/workflow-guide/scaffolds/README.md",
		"skills/workflow-guide/scaffolds/fixed-inventory/initialize.mjs",
		"skills/workflow-guide/scaffolds/fixed-inventory/helpers/exact-source-join.mjs",
		"src/code-search-compat-extension.ts",
		"dist/code-search-compat-extension.js",
		"node_modules/pi-web-access/package.json",
		"node_modules/pi-web-access/index.ts",
		"node_modules/pi-web-access/storage.ts",
		"node_modules/pi-web-access/exa.ts",
		...bundleSpecs,
	]) {
		assert.ok(packed.has(required), `package missing ${required}`);
	}
	assert.equal(
		parseJson(
			readRoot("node_modules/pi-web-access/package.json"),
			"bundled pi-web-access package.json",
		).version,
		parseJson(readRoot("package-lock.json"), "package-lock.json").packages[
			"node_modules/pi-web-access"
		].version,
	);
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

function compiledFixture(t) {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "compiled-artifact-proof-")));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const roots = ["compiled", "dist", "packed"].map(name => join(directory, name));
	for (const root of roots) {
		mkdirSync(join(root, "nested"), { recursive: true });
		writeFileSync(join(root, "index.js"), "export const value = 1;\n");
		writeFileSync(join(root, "nested", "index.d.ts"), "export declare const value = 1;\n");
	}
	return { directory, roots };
}

test("compiled artifact proof binds equal bytes and exclusive fresh manifest", t => {
	const { directory, roots } = compiledFixture(t);
	const snapshots = roots.map(captureCompiledTree);
	assertCompiledTreesEqual(snapshots[0], snapshots[1]);
	assertCompiledTreesEqual(snapshots[0], snapshots[2]);
	const path = join(directory, "compile.json");
	const record = writeCompiledManifest(path, snapshots[0]);
	const read = readCompiledManifest(path, roots[0]);
	assert.equal(read.sha256, record.sha256);
	assert.deepEqual(read.tree, snapshots[0]);
	assert.throws(() => writeCompiledManifest(path, snapshots[0]), { code: "EEXIST" });
	assert.throws(() => readCompiledManifest(path, roots[1]), /does not bind/);
	writeFileSync(join(roots[2], "index.js"), "export const value = 2;\n");
	assert.throws(() => assertCompiledTreeUnchanged(snapshots[2]), /tree changed/);
});

for (const mutation of ["missing", "extra", "renamed", "same-size", "different-size"]) {
	test(`compiled artifact proof rejects ${mutation} packed output`, t => {
		const { roots } = compiledFixture(t);
		const original = captureCompiledTree(roots[0]);
		const target = join(roots[2], "index.js");
		if (mutation === "missing") rmSync(target);
		if (mutation === "extra") writeFileSync(join(roots[2], "extra.js"), "");
		if (mutation === "renamed") renameSync(target, join(roots[2], "renamed.js"));
		if (mutation === "same-size") writeFileSync(target, "export const value = 2;\n");
		if (mutation === "different-size") writeFileSync(target, "changed\n");
		assert.throws(() => assertCompiledTreesEqual(original, captureCompiledTree(roots[2])), /inventory differs|bytes differ/);
	});
}

for (const mutation of ["file-symlink", "directory-symlink", "hard-link", "fifo", "unsafe-name", "empty", "oversized"]) {
	test(`compiled artifact proof rejects ${mutation} inventory`, t => {
		const { roots } = compiledFixture(t);
		const root = roots[1];
		if (mutation === "file-symlink") symlinkSync(join(roots[0], "index.js"), join(root, "linked.js"));
		if (mutation === "directory-symlink") symlinkSync(roots[0], join(root, "linked-directory"), "dir");
		if (mutation === "hard-link") linkSync(join(root, "index.js"), join(root, "linked.js"));
		if (mutation === "fifo") execFileSync("mkfifo", ["-m", "600", join(root, "pipe")], { timeout: 30000 });
		if (mutation === "unsafe-name") writeFileSync(join(root, "bad\\name.js"), "");
		if (mutation === "empty") {
			rmSync(root, { recursive: true });
			mkdirSync(root);
		}
		if (mutation === "oversized") truncateSync(join(root, "index.js"), 16 * 1024 * 1024 + 1);
		assert.throws(() => captureCompiledTree(root), /nonregular|singly linked|case-colliding|unsafe|empty|byte bound/);
	});
}

test("compiled artifact proof rejects same-byte physical replacement and version drift", t => {
	const { roots } = compiledFixture(t);
	for (const [index, mutation] of ["replace", "version"].entries()) {
		const root = roots[index];
		const snapshot = captureCompiledTree(root);
		const path = join(root, "index.js");
		if (mutation === "replace") {
			writeFileSync(join(root, "replacement"), readFileSync(path));
			renameSync(join(root, "replacement"), path);
		} else {
			utimesSync(path, new Date(0), new Date(1000));
		}
		assert.equal(captureCompiledTree(root).contentSha256, snapshot.contentSha256);
		assert.throws(() => assertCompiledTreeUnchanged(snapshot), /tree changed/);
	}
});

test("compiled artifact proof rejects unsafe, duplicate, case-colliding and excessive paths", () => {
	for (const path of ["", ".", "..", "../escape", "/absolute", "a/../b", "a\\b", "a//b", "a/"]) {
		assert.throws(() => recordArtifactPath(path, new Set()), /unsafe/);
	}
	for (const duplicate of ["nested/index.js", "NESTED/INDEX.JS"]) {
		const seen = new Set();
		recordArtifactPath("nested/index.js", seen);
		assert.throws(() => recordArtifactPath(duplicate, seen), /case-colliding/);
	}
	const seen = new Set();
	for (let index = 0; index < 4096; index += 1) recordArtifactPath(`file-${index}.js`, seen);
	assert.throws(() => recordArtifactPath("one-too-many.js", seen), /entry bound/);
});

test("compiled artifact proof rejects missing and malformed manifest claims", t => {
	const { directory, roots } = compiledFixture(t);
	const snapshot = captureCompiledTree(roots[0]);
	const path = join(directory, "compile.json");
	assert.throws(() => readCompiledManifest(path, roots[0]), { code: "ENOENT" });
	const candidates = [
		"{",
		`${JSON.stringify(snapshot).slice(0, -1)},"fileCount":${snapshot.fileCount}}\n`,
		`${JSON.stringify({ ...snapshot, extra: true })}\n`,
		`${JSON.stringify({ ...snapshot, schema: "foreign" })}\n`,
		`${JSON.stringify({ ...snapshot, fileCount: 0 })}\n`,
		`${JSON.stringify({ ...snapshot, totalBytes: 0 })}\n`,
		`${JSON.stringify({ ...snapshot, contentSha256: "0".repeat(64) })}\n`,
		`${JSON.stringify({ ...snapshot, files: [...snapshot.files].reverse() })}\n`,
		`${JSON.stringify({ ...snapshot, files: [snapshot.files[0], snapshot.files[0]] })}\n`,
		`${JSON.stringify({ ...snapshot, files: [{ ...snapshot.files[0], path: "../escape" }] })}\n`,
	];
	for (const raw of candidates) {
		writeFileSync(path, raw);
		assert.throws(() => readCompiledManifest(path, roots[0]), /JSON|does not bind/);
	}
	writeCompiledManifest(join(directory, "original.json"), snapshot);
	writeFileSync(join(roots[0], "index.js"), "changed");
	assert.throws(() => readCompiledManifest(join(directory, "original.json"), roots[0]), /does not bind/);
});

test("compiled artifact proof rejects ambiguous archives and detects replacement", t => {
	const { directory } = compiledFixture(t);
	const pack = join(directory, "pack");
	mkdirSync(pack);
	assert.throws(() => capturePackedArchive(pack, "package.tgz\n"), /exactly/);
	writeFileSync(join(pack, "package.tgz"), "original archive bytes");
	const original = capturePackedArchive(pack, "package.tgz\n");
	assertPackedArchiveUnchanged(original.path, original);
	for (const output of ["", "../package.tgz\n", "/package.tgz\n", "a\\b.tgz\n", "package.tgz\nextra\n", "package.tgz\n\n"]) {
		assert.throws(() => capturePackedArchive(pack, output), /unsafe pack output/);
	}
	writeFileSync(join(pack, "extra.tgz"), "another");
	assert.throws(() => capturePackedArchive(pack, "package.tgz\n"), /exactly/);
	rmSync(join(pack, "extra.tgz"));
	writeFileSync(join(pack, "replacement"), readFileSync(original.path));
	renameSync(join(pack, "replacement"), original.path);
	assert.throws(() => assertPackedArchiveUnchanged(original.path, original), /physical identity changed/);
	writeFileSync(original.path, "");
	assert.throws(() => capturePackedArchive(pack, "package.tgz\n"), /empty/);
});

test("compiled artifact proof rejects a file changed after tree admission before byte capture", t => {
	const { roots } = compiledFixture(t);
	const target = join(roots[1], "index.js");
	const originalLstat = fs.lstatSync;
	let changed = false;
	t.mock.method(fs, "lstatSync", (path, options) => {
		const info = originalLstat(path, options);
		if (path === target && !changed) {
			changed = true;
			writeFileSync(target, "changed after tree size admission\n");
		}
		return info;
	});
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	assert.throws(() => captureCompiledTree(roots[1]), /artifact entry changed before capture/);
	assert.equal(changed, true, "the mutation occurred between the tree stat and regular-file capture");
});

for (const size of [16 * 1024 * 1024 + 1, 64 * 1024 * 1024]) {
	test(`compiled artifact proof streams packed archive size ${size}`, t => {
		const { directory } = compiledFixture(t);
		const pack = join(directory, "pack");
		mkdirSync(pack);
		const path = join(pack, "package.tgz");
		writeFileSync(path, "");
		truncateSync(path, size);
		assert.throws(() => captureArtifactFile(path), /artifact exceeds byte bound/);
		const originalRead = fs.readSync;
		let reads = 0;
		t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
		t.mock.method(fs, "readSync", (fd, buffer, offset, length, position) => {
			assert.equal(buffer.length, 64 * 1024);
			assert.ok(length <= 64 * 1024);
			reads++;
			return originalRead(fd, buffer, offset, length, position);
		});
		syncBuiltinESMExports();
		const captured = capturePackedArchive(pack, "package.tgz");
		assert.equal(captured.size, size);
		assert.equal(Object.hasOwn(captured, "bytes"), false);
		const digest = createHash("sha256");
		const zeros = Buffer.alloc(64 * 1024);
		for (let offset = 0; offset < size; offset += zeros.length) {
			digest.update(zeros.subarray(0, Math.min(zeros.length, size - offset)));
		}
		assert.equal(captured.sha256, digest.digest("hex"));
		assert.equal(reads, Math.ceil(size / zeros.length) + 1);
		assertPackedArchiveUnchanged(path, captured);
	});
}

for (const size of [0, 64 * 1024 * 1024 + 1]) {
	test(`compiled artifact proof refuses archive size ${size} before I/O allocation`, t => {
		const { directory } = compiledFixture(t);
		const pack = join(directory, "pack");
		mkdirSync(pack);
		const path = join(pack, "package.tgz");
		writeFileSync(path, "");
		truncateSync(path, size);
		t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
		const calls = [];
		t.mock.method(fs, "openSync", () => { calls.push("open"); throw new Error("unexpected open"); });
		t.mock.method(fs, "readSync", () => { calls.push("read"); throw new Error("unexpected read"); });
		t.mock.method(Buffer, "alloc", () => { calls.push("allocate"); throw new Error("unexpected allocation"); });
		syncBuiltinESMExports();
		assert.throws(() => capturePackedArchive(pack, "package.tgz"), /empty|64 MiB byte bound/);
		assert.deepEqual(calls, []);
	});
}

for (const fault of ["partial", "early-eof", "growth", "replacement", "in-place"]) {
	test(`compiled artifact proof handles archive streaming ${fault}`, t => {
		const { directory } = compiledFixture(t);
		const pack = join(directory, "pack");
		mkdirSync(pack);
		const path = join(pack, "package.tgz");
		const bytes = Buffer.alloc(128 * 1024, 37);
		writeFileSync(path, bytes);
		const originalRead = fs.readSync;
		let reads = 0;
		t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
		t.mock.method(fs, "readSync", (fd, buffer, offset, length, position) => {
			reads++;
			if (fault === "early-eof") return 0;
			const count = originalRead(fd, buffer, offset, Math.min(length, 1031), position);
			if (reads === 1) {
				if (fault === "growth") fs.appendFileSync(path, "x");
				if (fault === "replacement") {
					renameSync(path, join(directory, "original.tgz"));
					writeFileSync(path, bytes);
				}
				if (fault === "in-place") writeFileSync(path, Buffer.alloc(bytes.length, 38));
			}
			return count;
		});
		syncBuiltinESMExports();
		if (fault === "partial") {
			const captured = capturePackedArchive(pack, "package.tgz");
			assert.equal(captured.sha256, createHash("sha256").update(bytes).digest("hex"));
			assert.ok(reads > 2);
		} else {
			assert.throws(() => capturePackedArchive(pack, "package.tgz"), /truncated|grew|changed/);
		}
	});
}

test("compiled artifact proof refuses archive substitution before allocating or reading", t => {
	const { directory } = compiledFixture(t);
	const pack = join(directory, "pack");
	mkdirSync(pack);
	const path = join(pack, "package.tgz");
	const replacement = join(directory, "replacement.tgz");
	writeFileSync(path, "same bytes");
	writeFileSync(replacement, "same bytes");
	const originalOpen = fs.openSync;
	const calls = [];
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	t.mock.method(fs, "openSync", (target, flags) => {
		renameSync(replacement, target);
		return originalOpen(target, flags);
	});
	t.mock.method(fs, "readSync", () => { calls.push("read"); throw new Error("unexpected read"); });
	t.mock.method(Buffer, "alloc", () => { calls.push("allocate"); throw new Error("unexpected allocation"); });
	syncBuiltinESMExports();
	assert.throws(() => capturePackedArchive(pack, "package.tgz"), /changed before open/);
	assert.deepEqual(calls, []);
});

test("compiled artifact proof archive recapture rejects changed digest", t => {
	const { directory } = compiledFixture(t);
	const pack = join(directory, "pack");
	mkdirSync(pack);
	writeFileSync(join(pack, "package.tgz"), "original bytes");
	const captured = capturePackedArchive(pack, "package.tgz");
	assert.throws(() => assertPackedArchiveUnchanged(captured.path, {
		...captured, sha256: "0".repeat(64),
	}), /bytes changed/);
});

for (const kind of ["symlink", "hardlink"]) {
	test(`compiled artifact proof rejects packed archive ${kind} before open`, t => {
		const { directory } = compiledFixture(t);
		const pack = join(directory, "pack");
		mkdirSync(pack);
		const source = join(directory, "payload");
		const path = join(pack, "package.tgz");
		writeFileSync(source, "original bytes");
		if (kind === "symlink") symlinkSync(source, path);
		else linkSync(source, path);
		let opens = 0;
		t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
		t.mock.method(fs, "openSync", () => { opens++; throw new Error("unexpected open"); });
		syncBuiltinESMExports();
		assert.throws(() => capturePackedArchive(pack, "package.tgz"), /singly linked regular/);
		assert.equal(opens, 0);
	});
}
