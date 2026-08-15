#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const workflowText = readFileSync(".github/workflows/publish.yml", "utf8");
const workflow = parse(workflowText);
validateWorkflow(workflow);

const negativeFixtures = [
	[
		"source cannot acquire OIDC authority",
		(candidate) => {
			candidate.jobs.source.permissions["id-token"] = "write";
		},
	],
	[
		"source push must remain atomic",
		(candidate) => {
			step(candidate.jobs.source, "Atomically push the independently reconstructed commit and tag").run =
				step(candidate.jobs.source, "Atomically push the independently reconstructed commit and tag").run.replace(
					"git push --atomic",
					"git push",
				);
		},
	],
	[
		"source push cannot substitute an unbound main ref",
		(candidate) => {
			step(candidate.jobs.source, "Atomically push the independently reconstructed commit and tag").run =
				step(candidate.jobs.source, "Atomically push the independently reconstructed commit and tag").run.replace(
					'"$RELEASE_COMMIT:refs/heads/main"',
					'"HEAD:refs/heads/main"',
				);
		},
	],
	[
		"source push cannot add another privileged refspec",
		(candidate) => {
			step(candidate.jobs.source, "Atomically push the independently reconstructed commit and tag").run =
				step(candidate.jobs.source, "Atomically push the independently reconstructed commit and tag").run.replace(
					'"$RELEASE_COMMIT:refs/tags/v$TARGET_VERSION"',
					'"$RELEASE_COMMIT:refs/tags/v$TARGET_VERSION" \\\n              "$RELEASE_COMMIT:refs/heads/other"',
				);
		},
	],
	[
		"post-push tag identity cannot be omitted",
		(candidate) => {
			step(candidate.jobs.source, "Verify remote release identity").run =
				step(candidate.jobs.source, "Verify remote release identity").run.replace(
					'test "$remote_tag" = "$RELEASE_COMMIT"',
					'true # tag check removed',
				);
		},
	],
	[
		"publish cannot omit remote-main equality",
		(candidate) => {
			step(candidate.jobs.publish, "Verify source identity and publish the fixed-path tarball").run =
				step(candidate.jobs.publish, "Verify source identity and publish the fixed-path tarball").run.replace(
					'test "$remote_main" = "$RELEASE_COMMIT"',
					'true # main check removed',
				);
		},
	],
	[
		"artifact metadata cannot select the package path",
		(candidate) => {
			step(candidate.jobs.publish, "Verify source identity and publish the fixed-path tarball").run =
				step(candidate.jobs.publish, "Verify source identity and publish the fixed-path tarball").run.replace(
					'expected_file="agwab-pi-workflow-$TARGET_VERSION.tgz"',
					'expected_file="$(node -p "require(\'./release-artifact/release-metadata.json\').packageFile")"',
				);
		},
	],
	[
		"publish must depend on source promotion",
		(candidate) => {
			candidate.jobs.publish.needs = ["build"];
		},
	],
	[
		"GitHub release must depend on npm publish",
		(candidate) => {
			candidate.jobs.release.needs = ["build", "source"];
		},
	],
];

for (const [name, mutate] of negativeFixtures) {
	const candidate = structuredClone(workflow);
	mutate(candidate);
	assert.throws(
		() => validateWorkflow(candidate),
		{ name: "AssertionError" },
		name,
	);
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
}, null, 2));

function validateWorkflow(candidate) {
	assert.deepEqual(candidate.permissions, {});
	assert.deepEqual(Object.keys(candidate.jobs), ["build", "source", "publish", "release"]);

	const { build, source, publish, release } = candidate.jobs;
	assert.deepEqual(build.permissions, { contents: "read" });
	assert.deepEqual(source.permissions, { contents: "write", "id-token": "none" });
	assert.deepEqual(publish.permissions, {
		actions: "read",
		contents: "read",
		"id-token": "write",
	});
	assert.deepEqual(release.permissions, { contents: "write", "id-token": "none" });
	assert.equal(source.needs, "build");
	assert.deepEqual(publish.needs, ["build", "source"]);
	assert.deepEqual(release.needs, ["build", "source", "publish"]);

	for (const [name, job] of Object.entries(candidate.jobs)) {
		if (name !== "publish") assert.notEqual(job.permissions?.["id-token"], "write");
		if (name !== "source" && name !== "release") {
			assert.notEqual(job.permissions?.contents, "write");
		}
	}

	const sourcePrepare = step(source, "Independently reconstruct the validated release tree").run;
	assert.match(sourcePrepare, /npm version "\$TARGET_VERSION" --no-git-tag-version --ignore-scripts/);
	assert.match(sourcePrepare, /release_tree="\$\(git write-tree\)"/);
	assert.match(sourcePrepare, /test "\$release_tree" = "\$EXPECTED_RELEASE_TREE"/);
	assert.match(sourcePrepare, /base_commit="\$\{\{ github\.sha \}\}"/);
	assert.match(sourcePrepare, /release_commit="\$\(git rev-parse HEAD\)"/);
	assert.match(sourcePrepare, /remote_main="\$\(git ls-remote origin refs\/heads\/main/);
	assert.match(sourcePrepare, /remote_tag="\$\(git ls-remote origin "refs\/tags\/v\$TARGET_VERSION"/);
	assert.match(sourcePrepare, /test "\$\(git rev-parse "\$release_commit\^"\)" = "\$base_commit"/);
	assert.match(sourcePrepare, /test "\$\(git rev-parse "\$release_commit\^\{tree\}"\)" = "\$EXPECTED_RELEASE_TREE"/);
	assert.doesNotMatch(sourcePrepare, /release-metadata|packageFile|package_file|releaseCommit/);

	const sourcePush = step(
		source,
		"Atomically push the independently reconstructed commit and tag",
	).run;
	assert.deepEqual(
		logicalCommands(sourcePush).filter((command) => command.startsWith("git push")),
		[
			'git push --atomic "$remote" "$RELEASE_COMMIT:refs/heads/main" "$RELEASE_COMMIT:refs/tags/v$TARGET_VERSION"',
		],
	);
	assert.doesNotMatch(sourcePush, /release-metadata|packageFile|package_file/);

	const sourceVerify = step(source, "Verify remote release identity").run;
	assert.match(sourceVerify, /remote_main="\$\(git ls-remote origin refs\/heads\/main \| awk '\{print \$1\}'\)"/);
	assert.match(sourceVerify, /remote_tag="\$\(git ls-remote origin "refs\/tags\/v\$TARGET_VERSION" \| awk '\{print \$1\}'\)"/);
	assert.match(sourceVerify, /test "\$remote_main" = "\$RELEASE_COMMIT"/);
	assert.match(sourceVerify, /test "\$remote_tag" = "\$RELEASE_COMMIT"/);

	const publishRun = step(
		publish,
		"Verify source identity and publish the fixed-path tarball",
	).run;
	const publishOffset = publishRun.indexOf("npm publish");
	assert.ok(publishOffset > 0);
	for (const requiredBeforePublish of [
		'expected_file="agwab-pi-workflow-$TARGET_VERSION.tgz"',
		'package_path="$PWD/release-artifact/$expected_file"',
		'test "$remote_main" = "$RELEASE_COMMIT"',
		'test "$remote_tag" = "$RELEASE_COMMIT"',
		'test "$(node -p "require(\'./$metadata\').packageFile")" = "$expected_file"',
		'test "$actual_sha" = "$BUILD_PACKAGE_SHA"',
		'tar -tzf "$package_path"',
	]) {
		const offset = publishRun.indexOf(requiredBeforePublish);
		assert.ok(offset >= 0, `missing publish guard: ${requiredBeforePublish}`);
		assert.ok(offset < publishOffset, `publish guard occurs after npm publish: ${requiredBeforePublish}`);
	}
	assert.match(
		publishRun,
		/npm publish "\$package_path" --access public --provenance --ignore-scripts/,
	);
	assert.doesNotMatch(publishRun, /package_file=|\$package_file|\.\.\//);

	assert.doesNotMatch(jobText(build), /\bnpm publish\b|\bgit push\b/);
	assert.doesNotMatch(jobText(source), /\bnpm publish\b/);
	assert.doesNotMatch(jobText(publish), /\bgit push\b/);
	assert.doesNotMatch(jobText(release), /\bnpm publish\b|\bgit push\b/);
}

function step(job, name) {
	const match = job.steps.find((candidate) => candidate.name === name);
	assert.ok(match, `missing workflow step: ${name}`);
	assert.equal(typeof match.run, "string", `workflow step must be a run step: ${name}`);
	return match;
}

function logicalCommands(script) {
	return script
		.replace(/\\\n\s*/g, " ")
		.split("\n")
		.map((line) => line.trim().replace(/\s+/g, " "))
		.filter(Boolean);
}

function jobText(job) {
	return job.steps.map((candidate) => candidate.run ?? "").join("\n");
}
