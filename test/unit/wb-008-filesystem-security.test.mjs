import assert from "node:assert/strict";
import {
	link,
	mkdir,
	mkdtemp,
	readFile,
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
	setSecureAtomicTempSuffixForTests,
	writePrivateFileAtomic,
} from "../../.tmp/unit/secure-atomic-write.js";

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
