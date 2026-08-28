import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const root = new URL("../..", import.meta.url);
const workflowPath = new URL(".github/workflows/publish.yml", root);
const checkerPath = new URL("tools/release/check-publish-workflow.mjs", root);
const dispatcherPath = new URL("tools/release/dispatch-release.mjs", root);
const workflow = () => readFile(workflowPath, "utf8");

function rubyYaml() {
	return spawnSync("ruby", ["-ryaml", "-e", "YAML.safe_load(File.read(ARGV.fetch(0)), aliases: true)", workflowPath.pathname], { encoding: "utf8" });
}
function runScripts() {
	const result = spawnSync("ruby", ["-ryaml", "-rjson", "-e", `
document = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: true)
runs = []
walk = lambda do |value, path|
  case value
  when Hash
    value.each { |key, child| child_path = path + [key.to_s]; runs << { path: child_path.join("."), script: child } if key.to_s == "run" && child.is_a?(String); walk.call(child, child_path) }
  when Array
    value.each_with_index { |child, index| walk.call(child, path + [index.to_s]) }
  end
end
walk.call(document, [])
STDOUT.write(JSON.generate(runs))
`, workflowPath.pathname], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout);
}
function shellForSyntax(script) { return script.replace(/\$\{\{[^\n]*?\}\}/g, "__GITHUB_ACTIONS_EXPRESSION__"); }

 test("WB-009 YAML, pinned actions, and shell syntax are valid", async () => {
	assert.equal(rubyYaml().status, 0, rubyYaml().stderr);
	const text = await workflow();
	const uses = [...text.matchAll(/^\s*- uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)].map((m) => m[1]);
	assert.ok(uses.length > 0);
	for (const use of uses) {
		const match = use.match(/^([^@]+)@([0-9a-f]{40})$/);
		assert.ok(match, `unpinned action: ${use}`);
		assert.deepEqual({
			"actions/checkout": "df4cb1c069e1874edd31b4311f1884172cec0e10",
			"actions/setup-node": "48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
			"actions/upload-artifact": "ea165f8d65b6e75b540449e92b4886f43607fa02",
			"actions/download-artifact": "634f93cb2916e3fdff6788551b99b062d0335ce0",
		}[match[1]], match[2]);
	}
	for (const { path, script } of runScripts()) {
		const result = spawnSync("bash", ["-n"], { input: shellForSyntax(script), encoding: "utf8" });
		assert.equal(result.status, 0, `${path}: ${result.stderr}`);
	}
});

test("WB-009 build and source tag checks peel annotated tags and accept lightweight tags offline", async () => {
	const scripts = runScripts();
	const jobs = ["build", "source"];
	const fixtures = ["annotated-ls-remote.txt", "lightweight-ls-remote.txt"];
	const expectedSha = "0123456789abcdef0123456789abcdef01234567";
	const fixtureRoot = new URL("../fixtures/release-tags/", import.meta.url);
	for (const job of jobs) {
		const entry = scripts.find(({ path, script }) => path.startsWith(`jobs.${job}.`) && script.includes('tag_ref="refs/tags/v$TARGET_VERSION"'));
		assert.ok(entry, `${job} tag-check script`);
		const start = entry.script.indexOf('tag_ref="refs/tags/v$TARGET_VERSION"');
		const end = entry.script.indexOf("\necho ", start);
		assert.ok(start >= 0 && end > start, `${job} tag-check boundaries`);
		const tagScript = entry.script.slice(start, end).replace(/\$\{\{\s*github\.sha\s*\}\}/g, "$EXPECTED_SHA");
		for (const fixture of fixtures) {
			const cwd = await mkdtemp(join(tmpdir(), "pi-wb009-tag-"));
			try {
				const fakeGit = join(cwd, "git");
				await writeFile(fakeGit, '#!/usr/bin/env bash\nset -euo pipefail\ntest "$#" -eq 4\ntest "$1" = ls-remote\ntest "$2" = origin\ntest "$3" = "refs/tags/v$TARGET_VERSION"\ntest "$4" = "refs/tags/v$TARGET_VERSION^{}"\ncat "$FIXTURE"\n');
				await chmod(fakeGit, 0o755);
				const fixturePath = new URL(fixture, fixtureRoot).pathname;
				const result = spawnSync("bash", ["-c", tagScript], {
					cwd: cwd,
					encoding: "utf8",
					env: { ...process.env, PATH: `${cwd}:${process.env.PATH}`, TARGET_VERSION: "0.12.0", EXPECTED_SHA: expectedSha, FIXTURE: fixturePath },
				});
				assert.equal(result.status, 0, `${job}/${fixture}: ${result.stderr}`);
			} finally {
				await rm(cwd, { recursive: true, force: true });
			}
		}
	}
});

test("WB-009 privileged npm OIDC job is repository-free and verification is subsequent read-only", async () => {
	const text = await workflow();
	const publish = text.split("\n  publish:\n")[1].split("\n  verification:\n")[0];
	const verification = text.split("\n  verification:\n")[1].split("\n  release:\n")[0];
	const release = text.split("\n  release:\n")[1];
	assert.match(publish, /id-token: write/);
	assert.doesNotMatch(publish, /actions\/checkout|tools\/release|npm audit|npm run|npm (?:ci|install)/);
	assert.match(publish, /npm publish "\$package_path" --access public --provenance --ignore-scripts --registry https:\/\/registry\.npmjs\.org --tag latest/);
	assert.match(publish, /npm view "\$NPM_PACKAGE@\$TARGET_VERSION" name version dist --registry https:\/\/registry\.npmjs\.org --tag latest --json/);
	assert.match(publish, /publication-before\.json/);
	assert.match(publish, /publication-after\.json/);
	assert.match(verification, /actions\/checkout@[0-9a-f]{40}/);
	assert.match(verification, /id-token: none/);
	assert.match(verification, /npm audit signatures --json --include-attestations --package-lock-only --registry https:\/\/registry\.npmjs\.org --ignore-scripts/);
	assert.match(verification, /node tools\/release\/verify-npm-publication\.mjs/);
	assert.match(verification, /EXPECTED_REPOSITORY: AgwaB\/pi-workflow/);
	assert.match(verification, /needs: \[build, source, publish\]/);
	assert.match(release, /needs: \[build, source, publish, verification\]/);
	assert.match(release, /id-token: none/);
});

test("WB-009 exact graph checker rejects privilege and producer drift", () => {
	const result = spawnSync(process.execPath, [checkerPath.pathname], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	const report = JSON.parse(result.stdout);
	assert.equal(report.privilegeSeparated, true);
	assert.equal(report.cryptographicGate, "npm-audit-signatures");
	assert.ok(report.negativeFixtures >= 10);
});

test("WB-009 workflow and local dispatcher accept prereleases but reject build metadata", async () => {
	const text = await workflow();
	const dispatcher = await readFile(dispatcherPath, "utf8");
	const validationLine = 'if ! [[ "$TARGET_VERSION" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then';
	assert.ok(text.includes(validationLine));
	assert.ok(dispatcher.includes('if (!version || !/^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))'));

	const version = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
	for (const candidate of ["0.12.0", "1.2.3-alpha", "1.2.3-rc.1"]) assert.equal(version.test(candidate), true, candidate);
	for (const candidate of ["0.12.0+build.1", "1.2.3-alpha+build.1", "v1.2.3", "1.2", "1.2.3-"]) assert.equal(version.test(candidate), false, candidate);
});

test("WB-009 workflow has no mutation outside the single npm publish", async () => {
	const text = await workflow();
	assert.equal((text.match(/\bnpm\s+publish\b/g) ?? []).length, 1);
	assert.equal((text.match(/\bgit\s+push\b/g) ?? []).length, 0);
	assert.equal((text.match(/\bnpm\s+view\b[^\n]*name version dist/g) ?? []).length, 2);
	assert.match(text, /EXPECTED_WORKFLOW_REF: refs\/heads\/main/);
	assert.match(text, /EXPECTED_WORKFLOW_PATH: \.github\/workflows\/publish\.yml/);
});

test("WB-009 repository checkout is absent from OIDC job and present in verifier", async () => {
	const text = await workflow();
	const publish = text.slice(text.indexOf("\n  publish:\n"), text.indexOf("\n  verification:\n"));
	const verification = text.slice(text.indexOf("\n  verification:\n"), text.indexOf("\n  release:\n"));
	assert.doesNotMatch(publish, /checkout@/);
	assert.match(verification, /ref: \$\{\{ needs\.source\.outputs\.release-commit \}\}/);
	assert.match(verification, /contents: read/);
	assert.match(verification, /id-token: none/);
});
