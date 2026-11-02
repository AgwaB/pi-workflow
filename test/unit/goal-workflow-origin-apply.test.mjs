import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareGoalWorkspaceHost } from "../../.tmp/unit/goal-workspace-host.js";
import { applyGoalCandidateToOrigin } from "../../.tmp/unit/goal-workflow-origin-apply.js";

const guard = { assertCurrent: () => undefined, assertLive: () => undefined };

async function fixture(t, { git = false, files = {}, scope, protectedPaths = [] } = {}) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "goal-origin-apply-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const origin = join(root, "origin");
	await mkdir(origin);
	for (const [path, content] of Object.entries(files)) {
		await mkdir(join(origin, path, ".."), { recursive: true });
		await writeFile(join(origin, path), content);
	}
	if (git) {
		const run = (...args) => execFileSync("git", args, { cwd: origin, stdio: "pipe" });
		run("init", "-q");
		run("-c", "user.email=t@example.com", "-c", "user.name=t", "add", "-A");
		run("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "base");
	}
	const workspace = await prepareGoalWorkspaceHost({
		originRoot: origin, workspaceRoot: join(root, "candidate"), artifactRoot: join(root, "artifacts"),
		workspaceId: "origin-apply-fixture", mode: "mutation", repository: git ? "git" : "nonGit",
		scope: scope ?? Object.keys(files).sort(), protectedPaths,
	}, guard);
	t.after(() => workspace.cleanup().catch(() => undefined));
	return { root, origin, workspace };
}

/** The workspace host write precondition is the digest of the current candidate value. */
async function candidateWrite(workspace, path, content) {
	const candidate = await workspace.inspectCandidate();
	const { goalHash } = await import("../../.tmp/unit/goal-json.js");
	const value = candidate.files.find(file => file.path === path)?.value ?? null;
	const expectedDigest = goalHash(value);
	return workspace.writeCandidate(path, expectedDigest, content);
}

test("origin apply copies an achieved candidate update and leaves protected and out-of-scope files untouched", async t => {
	const { origin, workspace } = await fixture(t, {
		files: { "a.txt": "original", "protected.txt": "protected", "other.txt": "other" },
		scope: ["a.txt"], protectedPaths: ["protected.txt"],
	});
	await candidateWrite(workspace, "a.txt", "correct");
	assert.equal(await readFile(join(origin, "a.txt"), "utf8"), "original", "candidate writes never touch origin");
	const progress = [];
	const record = await applyGoalCandidateToOrigin({ originRoot: origin, workspace, controlRoots: [],
		onProgress: async value => { progress.push(structuredClone(value)); } });
	assert.equal(record.status, "applied", JSON.stringify(record));
	assert.deepEqual(record.paths.map(({ path, action, state }) => ({ path, action, state })),
		[{ path: "a.txt", action: "update", state: "applied" }]);
	assert.equal(progress[0].paths[0].state, "pending", "progress is published before the first write");
	assert.equal(await readFile(join(origin, "a.txt"), "utf8"), "correct");
	assert.equal(await readFile(join(origin, "protected.txt"), "utf8"), "protected");
	assert.equal(await readFile(join(origin, "other.txt"), "utf8"), "other");
});

test("origin apply refuses every write when any scoped origin path changed after the baseline", async t => {
	const { origin, workspace } = await fixture(t, { files: { "a.txt": "a", "b.txt": "b" } });
	await candidateWrite(workspace, "a.txt", "a2");
	await candidateWrite(workspace, "b.txt", "b2");
	await writeFile(join(origin, "b.txt"), "user edit");
	const record = await applyGoalCandidateToOrigin({ originRoot: origin, workspace, controlRoots: [] });
	assert.equal(record.status, "conflict");
	assert.deepEqual(record.paths.map(({ path, state }) => ({ path, state })), [{ path: "b.txt", state: "conflict" }]);
	assert.equal(await readFile(join(origin, "a.txt"), "utf8"), "a", "no partial application on conflict");
	assert.equal(await readFile(join(origin, "b.txt"), "utf8"), "user edit", "user work is never overwritten");
});

test("origin apply creates new scoped files with parents and reports no-changes for an untouched candidate", async t => {
	const created = await fixture(t, { files: { "a.txt": "a" }, scope: ["a.txt", "src/new.txt"] });
	await candidateWrite(created.workspace, "src/new.txt", "fresh\n");
	const record = await applyGoalCandidateToOrigin({ originRoot: created.origin, workspace: created.workspace, controlRoots: [] });
	assert.equal(record.status, "applied", JSON.stringify(record));
	assert.deepEqual(record.paths.map(({ path, action }) => ({ path, action })), [{ path: "src/new.txt", action: "create" }]);
	assert.equal(await readFile(join(created.origin, "src", "new.txt"), "utf8"), "fresh\n");
	assert.equal((await stat(join(created.origin, "src", "new.txt"))).mode & 0o777, 0o644);

	const untouched = await fixture(t, { files: { "a.txt": "a" } });
	const none = await applyGoalCandidateToOrigin({ originRoot: untouched.origin, workspace: untouched.workspace, controlRoots: [] });
	assert.deepEqual(none, { status: "no-changes", paths: [] });
});

test("origin apply stops before writing when the Goal was stopped", async t => {
	const { origin, workspace } = await fixture(t, { files: { "a.txt": "a" } });
	await candidateWrite(workspace, "a.txt", "changed");
	const stop = new AbortController();
	stop.abort();
	const record = await applyGoalCandidateToOrigin({ originRoot: origin, workspace, controlRoots: [], signal: stop.signal });
	assert.equal(record.status, "interrupted");
	assert.equal(record.paths[0].state, "pending");
	assert.equal(await readFile(join(origin, "a.txt"), "utf8"), "a");
});

test("origin apply in a Git origin changes only the working tree, not HEAD or the index", async t => {
	const { origin, workspace } = await fixture(t, { git: true, files: { "a.txt": "base\n", "b.txt": "keep\n" }, scope: ["a.txt"] });
	const git = (...args) => execFileSync("git", args, { cwd: origin, encoding: "utf8" });
	const head = git("rev-parse", "HEAD");
	await candidateWrite(workspace, "a.txt", "goal result\n");
	const record = await applyGoalCandidateToOrigin({ originRoot: origin, workspace, controlRoots: [] });
	assert.equal(record.status, "applied", JSON.stringify(record));
	assert.equal(await readFile(join(origin, "a.txt"), "utf8"), "goal result\n");
	assert.equal(git("rev-parse", "HEAD"), head);
	assert.equal(git("diff", "--cached", "--name-only"), "", "nothing is staged");
	assert.equal(git("diff", "--name-only").trim(), "a.txt");
});

test("origin apply refuses a Git origin whose HEAD moved after the baseline", async t => {
	const { origin, workspace } = await fixture(t, { git: true, files: { "a.txt": "base\n", "b.txt": "keep\n" }, scope: ["a.txt"] });
	await candidateWrite(workspace, "a.txt", "goal result\n");
	await writeFile(join(origin, "b.txt"), "user commit\n");
	execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-am", "user"], { cwd: origin });
	const record = await applyGoalCandidateToOrigin({ originRoot: origin, workspace, controlRoots: [] });
	assert.equal(record.status, "conflict", JSON.stringify(record));
	assert.equal(await readFile(join(origin, "a.txt"), "utf8"), "base\n");
});

test("origin apply rechecks the whole scope after the progress record and before the first write", async t => {
	const { origin, workspace } = await fixture(t, { files: { "a.txt": "a", "b.txt": "b" } });
	await candidateWrite(workspace, "a.txt", "a2");
	let calls = 0;
	const record = await applyGoalCandidateToOrigin({ originRoot: origin, workspace, controlRoots: [],
		onProgress: async () => { if (calls++ === 0) await writeFile(join(origin, "b.txt"), "user edit"); } });
	assert.equal(record.status, "conflict", JSON.stringify(record));
	assert.equal(await readFile(join(origin, "a.txt"), "utf8"), "a", "an untouched scoped path drifting blocks every write");
	assert.equal(await readFile(join(origin, "b.txt"), "utf8"), "user edit");
});

test("origin apply keeps a user edit made while the replacement is staged", async t => {
	const { origin, workspace } = await fixture(t, { files: { "a.txt": "a" } });
	await candidateWrite(workspace, "a.txt", "goal");
	const states = [];
	const record = await applyGoalCandidateToOrigin({ originRoot: origin, workspace, controlRoots: [],
		onProgress: async value => {
			states.push(value.paths[0].state);
			if (value.paths[0].state === "unknown") await writeFile(join(origin, "a.txt"), "user save");
		} });
	assert.equal(record.status, "conflict", JSON.stringify(record));
	assert.equal(record.paths[0].state, "conflict");
	assert.deepEqual(states.slice(0, 2), ["pending", "unknown"], "the in-flight state is durable before the effect");
	assert.equal(await readFile(join(origin, "a.txt"), "utf8"), "user save", "the concurrent save is not replaced");
});

test("origin apply refuses an origin directory replaced by a symlink after preflight", async t => {
	const { root, origin, workspace } = await fixture(t, { files: { "a.txt": "a" } });
	await candidateWrite(workspace, "a.txt", "goal");
	const elsewhere = join(root, "elsewhere");
	await mkdir(elsewhere);
	await writeFile(join(elsewhere, "a.txt"), "a");
	const { rename, symlink } = await import("node:fs/promises");
	let swapped = false;
	const record = await applyGoalCandidateToOrigin({ originRoot: origin, workspace, controlRoots: [],
		onProgress: async () => {
			if (swapped) return;
			swapped = true;
			await rename(origin, join(root, "origin-moved"));
			await symlink(elsewhere, origin);
		} });
	assert.notEqual(record.status, "applied", JSON.stringify(record));
	assert.equal(await readFile(join(elsewhere, "a.txt"), "utf8"), "a", "nothing is written through the replaced root");
	assert.equal(await readFile(join(root, "origin-moved", "a.txt"), "utf8"), "a");
});

test("origin apply revalidates untouched scope and root after each durable in-flight record", async t => {
	const scoped = await fixture(t, { files: { "a.txt": "a", "b.txt": "b" } });
	await candidateWrite(scoped.workspace, "a.txt", "a2");
	const record = await applyGoalCandidateToOrigin({ originRoot: scoped.origin, workspace: scoped.workspace, controlRoots: [],
		onProgress: async value => { if (value.paths[0].state === "unknown") await writeFile(join(scoped.origin, "b.txt"), "user edit"); } });
	assert.equal(record.status, "conflict", JSON.stringify(record));
	assert.equal(await readFile(join(scoped.origin, "a.txt"), "utf8"), "a");
	assert.equal(await readFile(join(scoped.origin, "b.txt"), "utf8"), "user edit");

	const created = await fixture(t, { files: { "a.txt": "a" }, scope: ["a.txt", "src/new.txt"] });
	await candidateWrite(created.workspace, "src/new.txt", "fresh\n");
	const elsewhere = join(created.root, "elsewhere");
	await mkdir(elsewhere);
	await writeFile(join(elsewhere, "a.txt"), "a");
	const { rename, symlink, readdir } = await import("node:fs/promises");
	let swapped = false;
	const swappedRecord = await applyGoalCandidateToOrigin({ originRoot: created.origin, workspace: created.workspace, controlRoots: [],
		onProgress: async value => {
			if (swapped || value.paths[0].state !== "unknown") return;
			swapped = true;
			await rename(created.origin, join(created.root, "origin-moved"));
			await symlink(elsewhere, created.origin);
		} });
	assert.equal(swappedRecord.status, "conflict", JSON.stringify(swappedRecord));
	assert.deepEqual(await readdir(elsewhere), ["a.txt"], "no directory or staged file is created through the replaced root");
});

test("origin apply writes several changed paths in order and accepts its own earlier writes", async t => {
	const { origin, workspace } = await fixture(t, { git: true, files: { "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" }, scope: ["a.txt", "b.txt", "c.txt"] });
	await candidateWrite(workspace, "a.txt", "a2\n");
	await candidateWrite(workspace, "c.txt", "c2\n");
	const record = await applyGoalCandidateToOrigin({ originRoot: origin, workspace, controlRoots: [] });
	assert.equal(record.status, "applied", JSON.stringify(record));
	assert.deepEqual(record.paths.map(({ path, state }) => [path, state]), [["a.txt", "applied"], ["c.txt", "applied"]]);
	assert.deepEqual(await Promise.all(["a.txt", "b.txt", "c.txt"].map(name => readFile(join(origin, name), "utf8"))), ["a2\n", "b\n", "c2\n"]);
});
