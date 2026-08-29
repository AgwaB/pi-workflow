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
	assert.match(publish, /registry_error_is_permanent\(\)/);
	assert.match(publish, /registry_error_is_retryable\(\)/);
	assert.match(publish, /observe_registry_until_visible\(\)/);
	assert.match(publish, /max_attempts=30/);
	assert.match(publish, /latest dist-tag has not converged/);
	assert.match(publish, /observe_registry_until_visible publication-after\.json dist-tags\.json/);
	assert.match(publish, /publication-before\.json/);
	assert.match(publish, /publication-after\.json/);
	assert.match(verification, /actions\/checkout@[0-9a-f]{40}/);
	assert.match(verification, /id-token: none/);
	assert.match(verification, /npm audit signatures --json --include-attestations --package-lock-only --registry https:\/\/registry\.npmjs\.org --ignore-scripts/);
	assert.match(verification, /audit_max_attempts=30/);
	assert.match(verification, /value\.invalid\.length>0/);
	assert.match(verification, /value\.missing\.length>0 \|\| value\.verified\.length===0/);
	assert.match(verification, /audit_error_is_permanent\(\)/);
	assert.match(verification, /audit_error_is_retryable\(\)/);
	assert.match(verification, /if \[ "\$audit_retryable" -ne 1 \]/);
	assert.match(verification, /npm provenance was not visible after \$audit_max_attempts attempts/);
	assert.match(verification, /node tools\/release\/verify-npm-publication\.mjs/);
	assert.match(verification, /EXPECTED_REPOSITORY: AgwaB\/pi-workflow/);
	assert.match(verification, /needs: \[build, source, publish\]/);
	assert.match(release, /needs: \[build, source, publish, verification\]/);
	assert.match(release, /id-token: none/);
});

test("WB-009 registry visibility helper retries transient absence and stale latest but stays bounded", async () => {
	const publishScript = runScripts().find(({ path, script }) => path.startsWith("jobs.publish.") && path.endsWith(".run") && script.includes("# registry visibility retry start"));
	assert.ok(publishScript);
	const start = publishScript.script.indexOf("# registry visibility retry start");
	const endMarker = "# registry visibility retry end";
	const end = publishScript.script.indexOf(endMarker, start);
	assert.ok(start >= 0 && end > start);
	const helper = publishScript.script.slice(start, end + endMarker.length);
	assert.doesNotMatch(helper, /\bnpm publish\b/);

	const cwd = await mkdtemp(join(tmpdir(), "pi-wb009-registry-"));
	try {
		const fakeNpm = join(cwd, "npm");
		const fakeSleep = join(cwd, "sleep");
		const stateFile = join(cwd, "state");
		const sleepFile = join(cwd, "sleeps");
		const errorFile = join(cwd, "registry-error");
		const metadataFile = join(cwd, "metadata.json");
		const tagsFile = join(cwd, "tags.json");
		await writeFile(fakeNpm, `#!/usr/bin/env bash
set -euo pipefail
count=0
if [ -f "$STATE_FILE" ]; then count="$(cat "$STATE_FILE")"; fi
count=$((count + 1))
printf '%s' "$count" > "$STATE_FILE"
test "$1" = view
if [ "$FAKE_MODE" = auth ]; then echo 'npm error code E401' >&2; exit 1; fi
if [ "$FAKE_MODE" = mixed ]; then printf '%s\n' 'npm error code E401' 'npm error code E500' >&2; exit 1; fi
if [ "$FAKE_MODE" = missing ]; then echo 'npm error code E404' >&2; exit 1; fi
if [ "$FAKE_MODE" = rate ] && [ "$count" -eq 1 ]; then echo 'npm error code E429' >&2; exit 1; fi
if [ "$FAKE_MODE" = server ] && [ "$count" -eq 1 ]; then echo 'npm error code E599' >&2; exit 1; fi
if [ "$FAKE_MODE" = network ] && [ "$count" -eq 1 ]; then echo 'npm error code ECONNREFUSED' >&2; exit 1; fi
if [[ " $* " == *" name version dist "* ]]; then
  if [ "$FAKE_MODE" = eventual ] && [ "$count" -eq 1 ]; then echo 'npm error code E404' >&2; exit 1; fi
  printf '{"name":"%s","version":"%s","dist":{"integrity":"fixture"}}\\n' "$NPM_PACKAGE" "$TARGET_VERSION"
  exit 0
fi
if [[ " $* " == *" dist-tags "* ]]; then
  if [ "$FAKE_MODE" = eventual ] && [ "$count" -eq 3 ]; then printf '{"latest":"0.0.0"}\\n'; else printf '{"latest":"%s"}\\n' "$TARGET_VERSION"; fi
  exit 0
fi
echo "unexpected npm command: $*" >&2
exit 2
`);
		await writeFile(fakeSleep, "#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' \"$1\" >> \"$SLEEP_FILE\"\n");
		await chmod(fakeNpm, 0o755);
		await chmod(fakeSleep, 0o755);
		const baseEnv = {
			...process.env,
			PATH: `${cwd}:${process.env.PATH}`,
			STATE_FILE: stateFile,
			SLEEP_FILE: sleepFile,
			ERROR_FILE: errorFile,
			METADATA_FILE: metadataFile,
			TAGS_FILE: tagsFile,
			NPM_PACKAGE: "@agwab/pi-workflow",
			TARGET_VERSION: "1.2.3",
		};
		const invoke = (body, mode) => spawnSync("bash", ["-c", `set -euo pipefail\n${body}\npublication_error="$ERROR_FILE"\nobserve_registry_until_visible "$METADATA_FILE" "$TAGS_FILE"\n`], {
			cwd, encoding: "utf8", env: { ...baseEnv, FAKE_MODE: mode },
		});

		const recovered = invoke(helper, "eventual");
		assert.equal(recovered.status, 0, recovered.stderr);
		assert.equal(await readFile(stateFile, "utf8"), "5");
		assert.deepEqual(JSON.parse(await readFile(metadataFile, "utf8")), { name: "@agwab/pi-workflow", version: "1.2.3", dist: { integrity: "fixture" } });
		assert.deepEqual(JSON.parse(await readFile(tagsFile, "utf8")), { latest: "1.2.3" });
		assert.deepEqual((await readFile(sleepFile, "utf8")).trim().split("\n"), ["2", "4"]);

		for (const mode of ["rate", "server", "network"]) {
			await writeFile(stateFile, "0");
			const transient = invoke(helper, mode);
			assert.equal(transient.status, 0, `${mode}: ${transient.stderr}`);
			assert.equal(await readFile(stateFile, "utf8"), "3");
		}

		for (const mode of ["auth", "mixed"]) {
			await writeFile(stateFile, "0");
			const forbidden = invoke(helper, mode);
			assert.notEqual(forbidden.status, 0);
			assert.equal(await readFile(stateFile, "utf8"), "1");
			assert.match(forbidden.stderr, /E401/);
		}

		await writeFile(stateFile, "0");
		const bounded = invoke(helper.replace("max_attempts=30", "max_attempts=3"), "missing");
		assert.notEqual(bounded.status, 0);
		assert.equal(await readFile(stateFile, "utf8"), "3");
		assert.match(bounded.stderr, /after 3 attempts/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("WB-009 provenance visibility retry accepts delayed evidence, rejects invalid evidence, and stays bounded", async () => {
	const verificationScript = runScripts().find(({ path, script }) => path.startsWith("jobs.verification.") && path.endsWith(".run") && script.includes("# provenance visibility retry start"));
	assert.ok(verificationScript);
	const start = verificationScript.script.indexOf("# provenance visibility retry start");
	const endMarker = "# provenance visibility retry end";
	const end = verificationScript.script.indexOf(endMarker, start);
	assert.ok(start >= 0 && end > start);
	const retry = verificationScript.script.slice(start, end + endMarker.length);
	assert.doesNotMatch(retry, /\bnpm publish\b/);

	const cwd = await mkdtemp(join(tmpdir(), "pi-wb009-provenance-"));
	try {
		const fakeNpm = join(cwd, "npm");
		const fakeSleep = join(cwd, "sleep");
		const stateFile = join(cwd, "state");
		const sleepFile = join(cwd, "sleeps");
		const auditFile = join(cwd, "audit.json");
		const auditTmp = join(cwd, "audit.tmp");
		const auditError = join(cwd, "audit.error");
		await writeFile(fakeNpm, `#!/usr/bin/env bash
set -euo pipefail
count=0
if [ -f "$STATE_FILE" ]; then count="$(cat "$STATE_FILE")"; fi
count=$((count + 1))
printf '%s' "$count" > "$STATE_FILE"
test "$1" = audit
test "$2" = signatures
case "$FAKE_MODE" in
  eventual)
    if [ "$count" -eq 1 ]; then printf '{"invalid":[],"missing":[],"verified":[]}\\n'; else printf '{"invalid":[],"missing":[],"verified":[{}]}\\n'; fi
    ;;
  transient)
    if [ "$count" -eq 1 ]; then echo 'npm error code ECONNREFUSED' >&2; exit 1; else printf '{"invalid":[],"missing":[],"verified":[{}]}\\n'; fi
    ;;
  rate)
    if [ "$count" -eq 1 ]; then echo 'npm error code E429' >&2; exit 1; else printf '{"invalid":[],"missing":[],"verified":[{}]}\\n'; fi
    ;;
  server)
    if [ "$count" -eq 1 ]; then printf '{"error":{"code":"E599"}}\\n'; exit 1; else printf '{"invalid":[],"missing":[],"verified":[{}]}\\n'; fi
    ;;
  invalid) printf '{"invalid":[{}],"missing":[],"verified":[]}\\n' ;;
  auth) echo 'npm error code E403' >&2; exit 1 ;;
  integrity) echo 'npm error code EINTEGRITY' >&2; exit 1 ;;
  mixed) printf '{"invalid":[],"missing":[],"verified":[]}\\n'; printf '%s\\n' 'npm error code E401' 'npm error code E500' >&2; exit 1 ;;
  missing) printf '{"invalid":[],"missing":[{}],"verified":[]}\\n' ;;
  *) exit 2 ;;
esac
`);
		await writeFile(fakeSleep, "#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' \"$1\" >> \"$SLEEP_FILE\"\n");
		await chmod(fakeNpm, 0o755);
		await chmod(fakeSleep, 0o755);
		const baseEnv = {
			...process.env,
			PATH: `${cwd}:${process.env.PATH}`,
			STATE_FILE: stateFile,
			SLEEP_FILE: sleepFile,
			GATE_DIR: cwd,
			AUDIT_JSON: auditFile,
			AUDIT_TMP: auditTmp,
			AUDIT_ERROR: auditError,
		};
		const invoke = (body, mode) => spawnSync("bash", ["-c", `set -euo pipefail\ngate_dir="$GATE_DIR"\naudit_json="$AUDIT_JSON"\naudit_tmp="$AUDIT_TMP"\naudit_error="$AUDIT_ERROR"\n${body}\n`], {
			cwd, encoding: "utf8", env: { ...baseEnv, FAKE_MODE: mode },
		});

		const recovered = invoke(retry, "eventual");
		assert.equal(recovered.status, 0, recovered.stderr);
		assert.equal(await readFile(stateFile, "utf8"), "2");
		assert.deepEqual(JSON.parse(await readFile(auditFile, "utf8")), { invalid: [], missing: [], verified: [{}] });
		assert.deepEqual((await readFile(sleepFile, "utf8")).trim().split("\n"), ["2"]);

		for (const mode of ["transient", "rate", "server"]) {
			await writeFile(stateFile, "0");
			const transient = invoke(retry, mode);
			assert.equal(transient.status, 0, `${mode}: ${transient.stderr}`);
			assert.equal(await readFile(stateFile, "utf8"), "2");
		}

		await writeFile(stateFile, "0");
		const invalid = invoke(retry, "invalid");
		assert.notEqual(invalid.status, 0);
		assert.equal(await readFile(stateFile, "utf8"), "1");
		assert.match(invalid.stderr, /invalid evidence/);

		for (const mode of ["auth", "integrity", "mixed"]) {
			await writeFile(stateFile, "0");
			const permanent = invoke(retry, mode);
			assert.notEqual(permanent.status, 0);
			assert.equal(await readFile(stateFile, "utf8"), "1");
			assert.match(permanent.stderr, /permanent error/);
		}

		await writeFile(stateFile, "0");
		const bounded = invoke(retry.replace("audit_max_attempts=30", "audit_max_attempts=3"), "missing");
		assert.notEqual(bounded.status, 0);
		assert.equal(await readFile(stateFile, "utf8"), "3");
		assert.match(bounded.stderr, /not visible after 3 attempts/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("WB-009 exact graph checker rejects privilege and producer drift", () => {
	const result = spawnSync(process.execPath, [checkerPath.pathname], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	const report = JSON.parse(result.stdout);
	assert.equal(report.privilegeSeparated, true);
	assert.equal(report.cryptographicGate, "npm-audit-signatures");
	assert.equal(report.registryVisibilityRetry, true);
	assert.equal(report.provenanceVisibilityRetry, true);
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
