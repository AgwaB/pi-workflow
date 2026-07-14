import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

const expectedPins = new Map([
	["actions/checkout", "df4cb1c069e1874edd31b4311f1884172cec0e10"],
	["actions/setup-node", "48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e"],
	["actions/upload-artifact", "ea165f8d65b6e75b540449e92b4886f43607fa02"],
	["actions/download-artifact", "634f93cb2916e3fdff6788551b99b062d0335ce0"],
]);

async function workflow(name) {
	return readFile(
		new URL(`../../.github/workflows/${name}`, import.meta.url),
		"utf8",
	);
}

function assertYamlParses(name) {
	const path = new URL(`../../.github/workflows/${name}`, import.meta.url);
	const result = spawnSync(
		"ruby",
		[
			"-ryaml",
			"-e",
			"YAML.safe_load(File.read(ARGV.fetch(0)), aliases: true)",
			path.pathname,
		],
		{ encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
}

function decodedRunScripts(name) {
	const path = new URL(`../../.github/workflows/${name}`, import.meta.url);
	const result = spawnSync(
		"ruby",
		[
			"-ryaml",
			"-rjson",
			"-e",
			`
document = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: true)
runs = []
walk = lambda do |value, path|
  case value
  when Hash
    value.each do |key, child|
      child_path = path + [key.to_s]
      runs << { path: child_path.join("."), script: child } if key.to_s == "run" && child.is_a?(String)
      walk.call(child, child_path)
    end
  when Array
    value.each_with_index { |child, index| walk.call(child, path + [index.to_s]) }
  end
end
walk.call(document, [])
STDOUT.write(JSON.generate(runs))
`,
			path.pathname,
		],
		{ encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
	try {
		return JSON.parse(result.stdout);
	} catch (error) {
		throw new Error(
			`failed to parse decoded workflow scripts: ${error.message}`,
		);
	}
}

function shellScriptForSyntaxCheck(script) {
	return script.replace(/\$\{\{[^\n]*?\}\}/g, "__GITHUB_ACTIONS_EXPRESSION__");
}

function assertRunScriptsPassBashSyntax(name) {
	const scripts = decodedRunScripts(name);
	assert.ok(scripts.length > 0, `${name} contains no run scripts`);
	for (const { path, script } of scripts) {
		const result = spawnSync("bash", ["-n"], {
			encoding: "utf8",
			input: shellScriptForSyntaxCheck(script),
		});
		assert.equal(result.status, 0, `${name}:${path}\n${result.stderr}`);
	}
}

function assertPinnedUses(text) {
	const uses = [...text.matchAll(/^\s*- uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)].map(
		(match) => match[1],
	);
	assert.ok(uses.length > 0);
	for (const value of uses) {
		if (value.startsWith("./")) continue;
		const match = value.match(/^([^@]+)@([0-9a-f]{40})$/);
		assert.ok(match, `third-party action is not full-SHA pinned: ${value}`);
		assert.equal(match[2], expectedPins.get(match[1]), value);
	}
}

test("WB-009 workflow YAML parses and every third-party Action uses a verified full SHA", async () => {
	for (const name of ["ci.yml", "publish.yml"]) {
		assertYamlParses(name);
		assertPinnedUses(await workflow(name));
	}
});

test("WB-009 decoded workflow run scripts pass Bash syntax", () => {
	for (const name of ["ci.yml", "publish.yml"]) {
		assertRunScriptsPassBashSyntax(name);
	}
});

test("WB-009 CI and release checkout never persist credentials", async () => {
	const ci = await workflow("ci.yml");
	const publish = await workflow("publish.yml");
	assert.match(
		ci,
		/actions\/checkout@[0-9a-f]{40}[^]*persist-credentials: false/,
	);
	for (const checkout of publish.split(/- uses: actions\/checkout@/).slice(1)) {
		assert.match(
			checkout.split(/\n\s*- (?:uses|name):/)[0],
			/persist-credentials: false/,
		);
	}
});

test("WB-009 privileged jobs consume the exact artifact without install or build lifecycle", async () => {
	const publishWorkflow = await workflow("publish.yml");
	const publishJob = publishWorkflow
		.split("\n  publish:\n")[1]
		.split("\n  release:\n")[0];
	const releaseJob = publishWorkflow.split("\n  release:\n")[1];
	assert.match(publishJob, /environment: npm-publish/);
	assert.match(publishJob, /id-token: write/);
	assert.match(publishJob, /actions\/download-artifact@[0-9a-f]{40}/);
	assert.match(
		publishJob,
		/BUILD_PACKAGE_SHA: \$\{\{ needs\.build\.outputs\.package-sha \}\}/,
	);
	assert.match(publishJob, /test "\$expected_sha" = "\$BUILD_PACKAGE_SHA"/);
	assert.match(publishJob, /test "\$actual_sha" = "\$BUILD_PACKAGE_SHA"/);
	assert.doesNotMatch(publishJob, /npm (?:ci|install)|npm run|npm pack/);
	assert.match(
		publishJob,
		/package_path="\$PWD\/release-artifact\/\$package_file"/,
	);
	assert.match(publishJob, /test -f "\$package_path"/);
	assert.match(publishJob, /npm publish "\$package_path"/);
	assert.match(publishJob, /--ignore-scripts/);

	assert.match(releaseJob, /contents: write/);
	assert.match(releaseJob, /id-token: none/);
	assert.doesNotMatch(
		releaseJob,
		/npm (?:ci|install)|npm run|npm pack|npm publish/,
	);
	assert.match(releaseJob, /git bundle verify/);
	assert.match(
		releaseJob,
		/BUILD_PACKAGE_SHA: \$\{\{ needs\.build\.outputs\.package-sha \}\}/,
	);
	assert.match(releaseJob, /test "\$package_sha" = "\$BUILD_PACKAGE_SHA"/);
	assert.match(releaseJob, /sha256sum[^\n]+BUILD_PACKAGE_SHA/);
	assert.match(releaseJob, /remote_main[^]*github\.sha/);
	assert.match(releaseJob, /registry\/package artifact integrity mismatch/);
});

test("WB-009 read-only build creates and hashes the only publishable tarball", async () => {
	const publishWorkflow = await workflow("publish.yml");
	const buildJob = publishWorkflow
		.split("\n  build:\n")[1]
		.split("\n  publish:\n")[0];
	assert.match(buildJob, /permissions:\n\s+contents: read/);
	assert.doesNotMatch(buildJob, /id-token: write|contents: write/);
	assert.match(buildJob, /npm ci --legacy-peer-deps --ignore-scripts/);
	assert.match(buildJob, /npm pack --ignore-scripts --json/);
	assert.match(
		buildJob,
		/package-sha: \$\{\{ steps\.package\.outputs\.package-sha \}\}/,
	);
	assert.match(
		buildJob,
		/id: package[^]*echo "package-sha=\$package_sha" >> "\$GITHUB_OUTPUT"/,
	);
	assert.match(buildJob, /packageSha256/);
	assert.match(buildJob, /release\.bundle/);
	assert.match(buildJob, /actions\/upload-artifact@[0-9a-f]{40}/);
});
