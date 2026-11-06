import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import {
	link,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	readWorkflowArtifact,
	setArtifactValidatedHookForTests,
} from "../../.tmp/unit/workflow-artifact-tool.js";
import {
	publishPrivateGenerationDirectory,
	setSecureAtomicBeforeRenameHookForTests,
	setSecureAtomicTempSuffixForTests,
	writePrivateFileAtomic,
} from "../../.tmp/unit/secure-atomic-write.js";


test("private generation publication preserves a byte-identical substituted preparation", async () => {
	const root = await mkdtemp(join(tmpdir(), "piwf-wb008-generation-substitution-"));
	const target = join(root, "lock"), retained = join(root, "original");
	let substituted;
	const owner = '{"ownerId":"test"}\\n';
	try {
		setSecureAtomicBeforeRenameHookForTests(async (_path, temporary) => {
			substituted = temporary;
			await rename(temporary, retained);
			await mkdir(temporary, { mode: 0o700 });
			await writeFile(join(temporary, "owner.json"), owner, { mode: 0o600 });
			await writeFile(join(temporary, "foreign"), "preserve");
		});
		await assert.rejects(publishPrivateGenerationDirectory(target, "owner.json", owner),
			/secure directory changed during write/);
		assert.equal(await readFile(join(substituted, "owner.json"), "utf8"), owner);
		assert.equal(await readFile(join(substituted, "foreign"), "utf8"), "preserve");
		assert.equal(await readFile(join(retained, "owner.json"), "utf8"), owner);
		await assert.rejects(stat(target), { code: "ENOENT" });
	} finally {
		setSecureAtomicBeforeRenameHookForTests(undefined);
		await rm(root, { recursive: true, force: true });
	}
});

test("private generation publication rejects replacement after rename", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "piwf-wb008-generation-published-")));
	const target = join(root, "lock"), retained = join(root, "original");
	const owner = '{"ownerId":"test"}\\n';
	const originalRename = fsPromises.rename;
	let substituted = false;
	try {
		t.mock.method(fsPromises, "rename", async (from, to) => {
			await originalRename(from, to);
			if (to === target && !substituted) {
				substituted = true;
				await originalRename(target, retained);
				await mkdir(target, { mode: 0o700 });
				await writeFile(join(target, "owner.json"), owner, { mode: 0o600 });
				await writeFile(join(target, "foreign"), "preserve");
			}
		});
		syncBuiltinESMExports();
		await assert.rejects(publishPrivateGenerationDirectory(target, "owner.json", owner),
			/secure directory changed during write/);
		assert.equal(substituted, true);
		assert.equal(await readFile(join(target, "owner.json"), "utf8"), owner);
		assert.equal(await readFile(join(target, "foreign"), "utf8"), "preserve");
		assert.equal(await readFile(join(retained, "owner.json"), "utf8"), owner);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		await rm(root, { recursive: true, force: true });
	}
});

function manifest(path) {
	return {
		schema: "workflow-source-manifest-v1",
		sources: [
			{
				source: "source",
				artifacts: { analysis: { path, mediaType: "text/plain" } },
			},
		],
	};
}

async function readAnalysis(path, runDir) {
	return readWorkflowArtifact(manifest(path), "source", "analysis", {
		runDir,
	});
}

test("WB-008 rejects a final-file symlink swap after validation", async (t) => {
	t.after(() => setArtifactValidatedHookForTests(undefined));
	const root = await mkdtemp(join(tmpdir(), "piwf-wb008-final-"));
	const runDir = join(root, "run");
	const artifact = join(runDir, "analysis.md");
	const secret = join(root, "secret.md");
	await mkdir(runDir, { recursive: true });
	await writeFile(artifact, "safe");
	await writeFile(secret, "SECRET");
	setArtifactValidatedHookForTests(async () => {
		setArtifactValidatedHookForTests(undefined);
		await rm(artifact);
		await symlink(secret, artifact);
	});
	await assert.rejects(() => readAnalysis(artifact, runDir));
});

test("WB-008 detects an ancestor-directory swap by descriptor identity", async (t) => {
	t.after(() => setArtifactValidatedHookForTests(undefined));
	const root = await mkdtemp(join(tmpdir(), "piwf-wb008-ancestor-"));
	const runDir = join(root, "run");
	const taskDir = join(runDir, "task");
	const artifact = join(taskDir, "analysis.md");
	const externalDir = join(root, "external");
	await mkdir(taskDir, { recursive: true });
	await mkdir(externalDir, { recursive: true });
	await writeFile(artifact, "safe");
	await writeFile(join(externalDir, "analysis.md"), "SECRET");
	setArtifactValidatedHookForTests(async () => {
		setArtifactValidatedHookForTests(undefined);
		await rename(taskDir, `${taskDir}-original`);
		await symlink(externalDir, taskDir);
	});
	await assert.rejects(
		() => readAnalysis(artifact, runDir),
		/changed during validation/,
	);
});

test("WB-008 explicitly rejects hard-linked artifacts", async () => {
	const root = await mkdtemp(join(tmpdir(), "piwf-wb008-hardlink-"));
	const runDir = join(root, "run");
	const secret = join(root, "secret.md");
	const artifact = join(runDir, "analysis.md");
	await mkdir(runDir, { recursive: true });
	await writeFile(secret, "SECRET");
	await link(secret, artifact);
	await assert.rejects(
		() => readAnalysis(artifact, runDir),
		/must not be hard-linked/,
	);
});

test("WB-008 private atomic writer refuses precreated temp symlinks and enforces modes", async (t) => {
	t.after(() => setSecureAtomicTempSuffixForTests(undefined));
	const root = await mkdtemp(join(tmpdir(), "piwf-wb008-atomic-"));
	const cacheDir = join(root, "cache");
	const target = join(cacheDir, "object.json");
	const victim = join(root, "victim.txt");
	await mkdir(cacheDir, { recursive: true });
	await writeFile(victim, "unchanged");
	setSecureAtomicTempSuffixForTests(() => "attack");
	await symlink(victim, `${target}.attack.tmp`);
	await assert.rejects(() => writePrivateFileAtomic(target, "malicious"));
	assert.equal(await readFile(victim, "utf8"), "unchanged");

	setSecureAtomicTempSuffixForTests(undefined);
	await writePrivateFileAtomic(target, "private");
	assert.equal(await readFile(target, "utf8"), "private");
	if (process.platform !== "win32") {
		assert.equal((await stat(cacheDir)).mode & 0o777, 0o700);
		assert.equal((await stat(target)).mode & 0o777, 0o600);
	}
});
