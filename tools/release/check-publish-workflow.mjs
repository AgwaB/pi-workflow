#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

const ACTIONS = {
	checkout: "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10",
	setupNode: "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
	upload: "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
	download: "actions/download-artifact@634f93cb2916e3fdff6788551b99b062d0335ce0",
};
const EXACT_VERSION_VALIDATION_LINE = 'if ! [[ "$TARGET_VERSION" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then';
const npmEnv = {
	NPM_CONFIG_USERCONFIG: "${{ runner.temp }}/pi-workflow-npmrc",
	NPM_CONFIG_GLOBALCONFIG: "${{ runner.temp }}/pi-workflow-global-npmrc",
	NPM_CONFIG_REGISTRY: "https://registry.npmjs.org",
	NPM_CONFIG_TAG: "latest",
};
const runDigests = {
	"build:Show Node/npm versions": "24ae972eceaee3a47fd480d1184f72dd5074bd646e7fcf63c4dc80f3ec245a66",
	"build:Validate already-versioned release source": "6790707e933f8e0fc31169622503fbaa4cd754d882cf96b73df23a9cda2a2525",
	"build:Install locked dependencies without lifecycle scripts": "f8e5d4fa5255e87e4bd6614017874bb5bf5e72fbf295bea339bd16f7e9fa2908",
	"build:Release validation in read-only privilege context": "2dcf0cae26e5fbb692c48fcf6d85a57e02342aeb1e23fdb76311b35245c7c01e",
	"build:Create exact package and source-tree metadata": "62304bd3eccd8703a5af4380b5c5a556e6156acf16f40db4da61dec51ed301ca",
	"source:Verify promoted release source identity": "b3f7b5a016768071b5bec9b71e0717c834ceb06ea8c5c186caf5222ad38d46b0",
	"publish:Publish exact promoted tarball and record registry envelopes": "a72a66c0375ad982e072ca511c14d8b4b2e376727421fde4ee4b8c3a76ea9090",
	"verification:Cryptographically gate and verify exact npm provenance": "ff3b05b74bf1fe6daee60657a68ec4f40205370d8bc57cfb2cbb5aaeea86978f",
	"release:Create GitHub release for the exact published commit": "08c06410736e237e6beedb4f15cf4d2ce23b330d5bf22577d119a2e1db337c34",
};

const workflow = parse(readFileSync(".github/workflows/publish.yml", "utf8"));
validateWorkflow(workflow);

const negativeFixtures = [
	["unexpected top-level key", (c) => { c.env = {}; }],
	["missing verification job", (c) => { delete c.jobs.verification; }],
	["verification job has OIDC authority", (c) => { c.jobs.verification.permissions["id-token"] = "write"; }],
	["repository-controlled execution in OIDC job", (c) => { c.jobs.publish.steps[0] = { uses: ACTIONS.checkout, with: { ref: "main", "fetch-depth": 1, "persist-credentials": false } }; }],
	["privileged job executes repository verifier", (c) => { c.jobs.publish.steps[2].run += "\nnode tools/release/verify-npm-publication.mjs"; }],
	["release does not depend on verification", (c) => { c.jobs.release.needs = ["build", "source", "publish"]; }],
	["release is not guarded before GitHub release operation", (c) => { c.jobs.release.steps[0].run = c.jobs.release.steps[0].run.replace("\nverify_release_tag\nif gh release view", "\nif gh release view"); }],
	["release is not guarded after GitHub release operation", (c) => { c.jobs.release.steps[0].run = c.jobs.release.steps[0].run.replace("\nfi\nverify_release_tag", "\nfi"); }],
	["release tag identity check is missing", (c) => { c.jobs.release.steps[0].run = c.jobs.release.steps[0].run.replace('test "$dereferenced_tag" = "$RELEASE_COMMIT"', "true # tag identity check removed"); }],
	["release tag is not dereferenced through GitHub API", (c) => { c.jobs.release.steps[0].run = c.jobs.release.steps[0].run.replace('gh api --method GET "repos/$GITHUB_REPOSITORY/git/tags/$tag_object_sha" --jq \'.object.sha\'', "true # tag dereference removed"); }],
	["release tag protection policy is missing", (c) => { c.jobs.release.steps[0].run = c.jobs.release.steps[0].run.replace('gh api --method GET "repos/$GITHUB_REPOSITORY/tags/protection"', "printf '[]'"); }],
	["publish is granted contents write", (c) => { c.jobs.publish.permissions.contents = "write"; }],
	["publish lacks contents read", (c) => { delete c.jobs.publish.permissions.contents; }],
	["publish tag identity check is missing", (c) => { c.jobs.publish.steps[2].run = c.jobs.publish.steps[2].run.replace('test "$dereferenced_tag" = "$RELEASE_COMMIT"', "true # tag identity check removed"); }],
	["publish annotated/lightweight tag handling drifts", (c) => { c.jobs.publish.steps[2].run = c.jobs.publish.steps[2].run.replace('commit) dereferenced_tag="$tag_object_sha" ;;', 'commit) dereferenced_tag="" ;;'); }],
	["publish tag is not dereferenced through GitHub API", (c) => { c.jobs.publish.steps[2].run = c.jobs.publish.steps[2].run.replace('git/tags/$tag_object_sha', 'git/tag-object/$tag_object_sha'); }],
	["publish tag protection policy is missing", (c) => { c.jobs.publish.steps[2].run = c.jobs.publish.steps[2].run.replace('gh api --method GET "repos/$GITHUB_REPOSITORY/tags/protection"', "printf '[]'"); }],
	["verification checkout ref drifts", (c) => { c.jobs.verification.steps[0].with.ref = "main"; }],
	["unrelated action ref", (c) => { c.jobs.verification.steps[1].uses = "actions/setup-node@v6"; }],
	["wrong registry", (c) => { c.jobs.publish.steps[2].run = c.jobs.publish.steps[2].run.replaceAll("https://registry.npmjs.org", "https://evil.example"); }],
	["wrong npm tag", (c) => { c.jobs.publish.steps[2].run = c.jobs.publish.steps[2].run.replaceAll("--tag latest", "--tag next"); }],
	["single-field npm view drift", (c) => { c.jobs.publish.steps[2].run = c.jobs.publish.steps[2].run.replace("name version dist", "dist"); }],
	["missing cryptographic gate", (c) => { c.jobs.verification.steps[4].run = c.jobs.verification.steps[4].run.replace("npm audit signatures", "npm audit"); }],
	["missing exact verifier", (c) => { c.jobs.verification.steps[4].run = c.jobs.verification.steps[4].run.replace("tools/release/verify-npm-publication.mjs", "true"); }],
	["missing provenance publish flag", (c) => { c.jobs.publish.steps[2].run = c.jobs.publish.steps[2].run.replace("--provenance", ""); }],
	["second registry mutation", (c) => { c.jobs.publish.steps[2].run += "\nnpm unpublish @agwab/pi-workflow@0.0.0"; }],
	["unapproved shell wrapper", (c) => { c.jobs.verification.steps[4].run = `bash -c ${JSON.stringify(c.jobs.verification.steps[4].run)}`; }],
	["staged/index changes bypass package guard", (c) => { c.jobs.build.steps[6].run = c.jobs.build.steps[6].run.replace("git diff --cached --exit-code\n", ""); }],
	["build tag peeling is missing", (c) => { c.jobs.build.steps[3].run = c.jobs.build.steps[3].run.replace('"$tag_ref^{}"', '"$tag_ref"'); }],
	["source tag peeling is missing", (c) => { c.jobs.source.steps[1].run = c.jobs.source.steps[1].run.replace('"$tag_ref^{}"', '"$tag_ref"'); }],
];
for (const [name, mutate] of negativeFixtures) {
	const candidate = structuredClone(workflow);
	mutate(candidate);
	assert.throws(() => validateWorkflow(candidate), { name: "AssertionError" }, name);
}

console.log(JSON.stringify({
	name: "check-publish-workflow",
	status: "completed",
	order: Object.keys(workflow.jobs),
	negativeFixtures: negativeFixtures.length,
	artifactSelectedRefs: false,
	fixedPackagePath: true,
	publishAfterRemoteIdentity: true,
	privilegeSeparated: true,
	cryptographicGate: "npm-audit-signatures",
}, null, 2));

function validateWorkflow(candidate) {
	assertExactKeys(candidate, ["name", "on", "permissions", "concurrency", "jobs"], "workflow");
	assert.equal(candidate.name, "Publish");
	assert.deepEqual(candidate.on, { workflow_dispatch: { inputs: { version: {
		description: "Version to publish, e.g. 0.11.1 or 0.12.0", required: true, type: "string",
	} } } });
	assertExactObject(candidate.permissions, {}, "workflow.permissions");
	assertExactObject(candidate.concurrency, { group: "publish-${{ github.ref }}", "cancel-in-progress": false }, "workflow.concurrency");
	assertExactKeys(candidate.jobs, ["build", "source", "publish", "verification", "release"], "workflow.jobs");
	const { build, source, publish, verification, release } = candidate.jobs;
	assertExactKeys(build, ["if", "runs-on", "permissions", "env", "outputs", "steps"], "build");
	assert.deepEqual(build.if, "github.ref == 'refs/heads/main'");
	assert.equal(build["runs-on"], "ubuntu-latest");
	assert.deepEqual(build.permissions, { contents: "read" });
	assert.deepEqual(build.env, npmEnv);
	assert.deepEqual(build.outputs, { "package-sha": "${{ steps.package.outputs.package-sha }}", "release-tree": "${{ steps.package.outputs.release-tree }}", version: "${{ steps.version.outputs.version }}" });
	assertExactKeys(source, ["needs", "runs-on", "permissions", "outputs", "steps"], "source");
	assert.deepEqual(source.needs, "build");
	assert.equal(source["runs-on"], "ubuntu-latest");
	assert.deepEqual(source.permissions, { contents: "read", "id-token": "none" });
	assert.deepEqual(source.outputs, { "release-commit": "${{ steps.verify.outputs.release-commit }}" });
	assertExactKeys(publish, ["needs", "runs-on", "environment", "permissions", "env", "steps"], "publish");
	assert.deepEqual(publish.needs, ["build", "source"]);
	assert.equal(publish["runs-on"], "ubuntu-latest");
	assert.equal(publish.environment, "npm-publish");
	assert.deepEqual(publish.permissions, { actions: "read", contents: "read", "id-token": "write" });
	assert.deepEqual(publish.env, npmEnv);
	assertExactKeys(verification, ["needs", "runs-on", "permissions", "env", "steps"], "verification");
	assert.deepEqual(verification.needs, ["build", "source", "publish"]);
	assert.equal(verification["runs-on"], "ubuntu-latest");
	assert.deepEqual(verification.permissions, { actions: "read", contents: "read", "id-token": "none" });
	assert.deepEqual(verification.env, { ...npmEnv, EXPECTED_REPOSITORY: "AgwaB/pi-workflow", EXPECTED_WORKFLOW_REF: "refs/heads/main", EXPECTED_WORKFLOW_PATH: ".github/workflows/publish.yml" });
	assertExactKeys(release, ["needs", "runs-on", "permissions", "steps"], "release");
	assert.deepEqual(release.needs, ["build", "source", "publish", "verification"]);
	assert.equal(release["runs-on"], "ubuntu-latest");
	assert.deepEqual(release.permissions, { contents: "write", "id-token": "none" });
	for (const [jobName, job] of Object.entries(candidate.jobs)) validateSteps(jobName, job.steps);

	assert.equal(publish.steps.some((s) => s.uses === ACTIONS.checkout), false, "OIDC job cannot checkout repository");
	assert.equal(verification.steps.filter((s) => s.uses === ACTIONS.checkout).length, 1);
	assert.equal(verification.steps.find((s) => s.uses === ACTIONS.checkout).with.ref, "${{ needs.source.outputs.release-commit }}");
	const versionRun = step(build, "Validate already-versioned release source").run;
	assert.ok(versionRun.split("\n").includes(EXACT_VERSION_VALIDATION_LINE), "release version validation must accept x.y.z with optional prerelease and reject build metadata");
	const sourceRun = step(source, "Verify promoted release source identity").run;
	for (const [jobName, tagRun] of [["build", versionRun], ["source", sourceRun]]) {
		assert.ok(tagRun.includes('tag_ref="refs/tags/v$TARGET_VERSION"'), `${jobName} must name the exact release tag ref`);
		assert.ok(tagRun.includes('git ls-remote origin "$tag_ref" "$tag_ref^{}"'), `${jobName} must request both direct and peeled tag refs`);
		assert.ok(tagRun.includes('BEGIN { peeled_ref = ref "^{}" }'), `${jobName} must identify the peeled tag record`);
		assert.ok(tagRun.includes("$2 == peeled_ref"), `${jobName} must prefer the peeled tag commit`);
		assert.ok(tagRun.includes("if (peeled_count == 1) print peeled_sha"), `${jobName} must prefer the peeled tag commit`);
		assert.ok(tagRun.includes("else print direct_sha"), `${jobName} must retain lightweight-tag fallback`);
		assert.ok(tagRun.includes('test "$dereferenced_tag" = "${{ github.sha }}"'), `${jobName} must compare the peeled tag to github.sha`);
		assert.equal(tagRun.includes('git ls-remote origin "refs/tags/v$TARGET_VERSION"'), false, `${jobName} must not compare the unpeeled remote tag object`);
	}
	const buildPackRun = step(build, "Create exact package and source-tree metadata").run;
	const publishStep = step(publish, "Publish exact promoted tarball and record registry envelopes");
	const publishRun = publishStep.run;
	const verifyRun = step(verification, "Cryptographically gate and verify exact npm provenance").run;
	const releaseRun = step(release, "Create GitHub release for the exact published commit").run;
	const packOffset = buildPackRun.indexOf("npm pack --ignore-scripts");
	assert.ok(packOffset >= 0, "build must pack the package");
	for (const guard of [
		"git diff --exit-code",
		"git diff --cached --exit-code",
		"test -z \"$(git ls-files --others --exclude-standard)\"",
	]) {
		const guardOffset = buildPackRun.indexOf(guard);
		assert.ok(guardOffset >= 0, `missing pre-pack worktree guard: ${guard}`);
		assert.ok(guardOffset < packOffset, `worktree guard occurs after packing: ${guard}`);
	}
	assert.equal((publishRun.match(/\bnpm\s+publish\b/g) ?? []).length, 1);
	assert.equal((jobText(candidate).match(/\bnpm\s+publish\b/g) ?? []).length, 1);
	assert.match(publishRun, /npm publish "\$package_path" --access public --provenance --ignore-scripts --registry https:\/\/registry\.npmjs\.org --tag latest/);
	assert.equal((publishRun.match(/npm view[^\n]*/g) ?? []).filter((x) => x.includes("name version dist")).length, 2);
	for (const command of [...jobText(candidate).matchAll(/\bnpm\s+(?:view|publish)\b[^\n;&|]*/g)].map((m) => m[0])) {
		assert.match(command, /--registry https:\/\/registry\.npmjs\.org\b/);
		assert.match(command, /--tag latest\b/);
	}
	assert.match(publishRun, /publication-before\.json/);
	assert.match(publishRun, /publication-after\.json/);
	assert.equal(publishStep.env.RELEASE_COMMIT, "${{ needs.source.outputs.release-commit }}");
	assert.equal(publishStep.env.GH_TOKEN, "${{ github.token }}");
	assert.match(publishRun, /gh api --method GET "repos\/\$GITHUB_REPOSITORY\/git\/ref\/tags\/\$tag_name"/);
	assert.match(publishRun, /gh api --method GET "repos\/\$GITHUB_REPOSITORY\/git\/tags\/\$tag_object_sha" --jq '\.object\.sha'/);
	assert.match(publishRun, /test "\$dereferenced_tag" = "\$RELEASE_COMMIT"/);
	assert.match(publishRun, /gh api --method GET "repos\/\$GITHUB_REPOSITORY\/tags\/protection"/);
	assert.match(publishRun, /protected-tag pattern/);
	assert.equal(normalizedFunction(publishRun, "verify_release_tag"), normalizedFunction(releaseRun, "verify_release_tag"), "OIDC and post-release tag gates must be exact duplicates");
	assert.match(publishRun, /\n[ \t]*verify_release_tag\n[ \t]*npm publish "\$package_path"/, "publish must verify the protected tag immediately before npm publish");
	assert.equal((publishRun.match(/^[ \t]*verify_release_tag$/gm) ?? []).length, 1, "publish tag must be checked exactly before npm publish");
	assert.doesNotMatch(publishRun, /verify-npm-publication|npm audit signatures|git\s+(?:push|commit|tag)|npm (?:ci|install|run)/);
	assert.match(verifyRun, /npm audit signatures --json --include-attestations --package-lock-only --registry https:\/\/registry\.npmjs\.org --ignore-scripts/);
	assert.match(verifyRun, /tools\/release\/verify-npm-publication\.mjs/);
	assert.match(verifyRun, /EXPECTED_REPOSITORY/);
	assert.doesNotMatch(jobText(publish), /checkout|tools\/release|npm audit|npm run|npm (?:ci|install)/i);
	assert.equal(registryMutations(jobText(candidate)).length, 1);
	assert.deepEqual(ghApiCommands(publishRun), ghApiCommands(releaseRun), "OIDC and post-release tag API command sets must match");
	assert.deepEqual(ghCommands(jobText(candidate)), [...ghCommands(publishRun), ...ghCommands(releaseRun)], "only OIDC and post-release jobs may use GitHub API commands");
	assert.match(releaseRun, /gh api --method GET "repos\/\$GITHUB_REPOSITORY\/git\/ref\/tags\/\$tag_name"/);
	assert.match(releaseRun, /gh api --method GET "repos\/\$GITHUB_REPOSITORY\/git\/tags\/\$tag_object_sha" --jq '\.object\.sha'/);
	assert.match(releaseRun, /test "\$dereferenced_tag" = "\$RELEASE_COMMIT"/);
	assert.match(releaseRun, /gh api --method GET "repos\/\$GITHUB_REPOSITORY\/tags\/protection"/);
	assert.match(releaseRun, /protected-tag pattern/);
	assert.doesNotMatch(releaseRun, /git\s+ls-remote/);
	assert.equal((releaseRun.match(/^verify_release_tag$/gm) ?? []).length, 2, "release tag must be checked exactly before and after the GitHub operation");
	assert.ok(releaseRun.includes("\nverify_release_tag\nif gh release view"), "missing pre-operation release-tag guard");
	assert.ok(releaseRun.includes("\nfi\nverify_release_tag"), "missing post-operation release-tag guard");
	assert.doesNotMatch(jobText(source), /npm (?:ci|install|run|pack|publish)|git (?:push|commit|tag)/);
}

function validateSteps(jobName, steps) {
	const catalogs = {
		build: [
			["action", ACTIONS.checkout, { "fetch-depth": 0, "persist-credentials": false }],
			["action", ACTIONS.setupNode, { "node-version": 24, "package-manager-cache": false }],
			["run", "Show Node/npm versions"], ["run", "Validate already-versioned release source"],
			["run", "Install locked dependencies without lifecycle scripts"], ["run", "Release validation in read-only privilege context"],
			["run", "Create exact package and source-tree metadata"], ["action", ACTIONS.upload, { name: "release-artifact", path: "release-metadata.json\nagwab-pi-workflow-${{ steps.version.outputs.version }}.tgz\n", "if-no-files-found": "error", "retention-days": 7 }, "Upload exact release artifact"],
		],
		source: [["action", ACTIONS.checkout, { ref: "${{ github.sha }}", "fetch-depth": 0, "persist-credentials": false }], ["run", "Verify promoted release source identity"]],
		publish: [["action", ACTIONS.setupNode, { "node-version": 24, "package-manager-cache": false }], ["action", ACTIONS.download, { name: "release-artifact", path: "release-artifact" }], ["run", "Publish exact promoted tarball and record registry envelopes"], ["action", ACTIONS.upload, { name: "publication-evidence", path: "publication-before.json\npublication-after.json\ndist-tags.json\n", "if-no-files-found": "error", "retention-days": 7 }, "Upload registry evidence"]],
		verification: [["action", ACTIONS.checkout, { ref: "${{ needs.source.outputs.release-commit }}", "fetch-depth": 1, "persist-credentials": false }], ["action", ACTIONS.setupNode, { "node-version": 24, "package-manager-cache": false }], ["action", ACTIONS.download, { name: "release-artifact", path: "release-artifact" }], ["action", ACTIONS.download, { name: "publication-evidence", path: "publication-evidence" }], ["run", "Cryptographically gate and verify exact npm provenance"]],
		release: [["run", "Create GitHub release for the exact published commit"]],
	};
	assert.ok(catalogs[jobName]);
	assert.equal(steps.length, catalogs[jobName].length, `${jobName} step count`);
	for (const [index, spec] of catalogs[jobName].entries()) {
		const actual = steps[index];
		if (spec[0] === "action") {
			assertExactKeys(actual, spec[3] ? ["name", "uses", "with"] : ["uses", "with"], `${jobName} step ${index}`);
			if (spec[3]) assert.equal(actual.name, spec[3]);
			assert.equal(actual.uses, spec[1]);
			assertExactObject(actual.with, spec[2], `${jobName} step ${index}.with`);
		} else {
			const keys = ["Show Node/npm versions", "Install locked dependencies without lifecycle scripts"].includes(spec[1]) ? ["name", "run"] : ["Validate already-versioned release source", "Create exact package and source-tree metadata"].includes(spec[1]) || spec[1] === "Verify promoted release source identity" ? ["name", "id", "env", "run"] : ["name", "env", "run"];
			assertExactKeys(actual, keys, `${jobName} step ${index}`);
			assert.equal(actual.name, spec[1]);
			assert.equal(createHash("sha256").update(actual.run).digest("hex"), runDigests[`${jobName}:${spec[1]}`]);
			assert.doesNotMatch(actual.run, /(?:^|[\n;&|])\s*(?:bash|sh|zsh|dash)\s+-c(?:\s|$)/);
		}
	}
}

function assertExactKeys(value, expected, label) { assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} mapping`); assert.deepEqual(Object.keys(value), expected, `${label} keys`); }
function assertExactObject(value, expected, label) { assertExactKeys(value, Object.keys(expected), label); assert.deepEqual(value, expected, label); }
function step(job, name) { const found = job.steps.filter((s) => s.name === name); assert.equal(found.length, 1); return found[0]; }
function jobText(value) {
	const jobs = value.jobs ? Object.values(value.jobs) : [value];
	return jobs.map((j) => j.steps.map((s) => s.run ?? "").join("\n")).join("\n");
}
function registryMutations(text) { return [...text.matchAll(/\bnpm\s+(?:publish|unpublish|deprecate|dist-tag|access|owner|token|login|adduser|profile|org|team)\b|\bnpm\s+config\s+(?:set|delete)\b/gi)]; }
function ghCommands(text) { return [...text.matchAll(/\bgh\s+[^\n;&|)]+/g)].map((m) => m[0].trim()); }
function ghApiCommands(text) { return ghCommands(text).filter((command) => command.startsWith("gh api ")); }
function normalizedFunction(text, name) {
	const start = text.indexOf(`${name}() {`);
	assert.ok(start >= 0, `missing ${name} function`);
	const end = text.indexOf("\n}", start);
	assert.ok(end > start, `unterminated ${name} function`);
	return text.slice(start, end + 2).split("\n").map((line) => line.trim()).join("\n");
}
