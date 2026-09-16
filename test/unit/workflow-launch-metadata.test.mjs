import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	chmod,
	link,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runDynamicTask, runWorkflowSpec } from "../../.tmp/unit/engine.js";
import {
	isWorkflowRunLaunchMetadata,
	readWorkflowLaunchCommandArtifact,
	setWorkflowLaunchArtifactTestHooksForTests,
	workflowRunDir,
	workflowRunPath,
	writeWorkflowLaunchCommandArtifact,
} from "../../.tmp/unit/store.js";

function launchWith(command) {
	return {
		schema: "pi-workflow-run-launch-v1",
		source: { kind: "slash-command", action: "run" },
		requestKind: "named-workflow",
		routingMode: "default-on",
		profile: { kind: "named", name: "medium" },
		task: { characters: 18, lines: 2 },
		command,
	};
}

test("launch command artifact is exact, private, integrity-linked, and absent from metadata JSON", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "piwf-launch-"));
	const runId = "workflow_launch_private";
	const text = '/workflow run  --profile medium review "line one\nline two 🚀"';
	try {
		const command = await writeWorkflowLaunchCommandArtifact(cwd, runId, text);
		const run = { runId, launch: launchWith(command) };
		const artifact = join(workflowRunDir(cwd, runId), "launch-command.txt");

		assert.equal(await readFile(artifact, "utf8"), text);
		assert.equal((await stat(artifact)).mode & 0o777, 0o600);
		assert.equal((await stat(workflowRunDir(cwd, runId))).mode & 0o777, 0o700);
		assert.equal(command.bytes, Buffer.byteLength(text, "utf8"));
		assert.match(command.sha256, /^[0-9a-f]{64}$/);
		assert.equal(await readWorkflowLaunchCommandArtifact(cwd, run), text);
		assert.equal(JSON.stringify(run).includes(text), false);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("launch metadata validation is closed and artifact reads fail closed on tampering", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "piwf-launch-tamper-"));
	const runId = "workflow_launch_tamper";
	try {
		const command = await writeWorkflowLaunchCommandArtifact(
			cwd,
			runId,
			"/workflow dynamic secret",
		);
		const launch = launchWith(command);
		assert.equal(isWorkflowRunLaunchMetadata(launch), true);
		assert.equal(
			isWorkflowRunLaunchMetadata({
				schema: "pi-workflow-run-launch-v1",
				source: { kind: "tool", name: "workflow_dynamic" },
				requestKind: "direct-dynamic",
				routingMode: "off",
				profile: { kind: "not-applicable" },
				task: { characters: 12, lines: 1 },
				command: { state: "unavailable", reason: "not-a-command" },
			}),
			true,
		);
		assert.equal(
			isWorkflowRunLaunchMetadata({ ...launch, unexpected: true }),
			false,
		);
		for (const invalid of [
			{ ...launch, source: { kind: "slash-command", action: "resume" } },
			{ ...launch, task: { characters: -1, lines: 2 } },
			{ ...launch, command: { ...command, sha256: "A".repeat(64) } },
			{ ...launch, command: { ...command, artifact: "../launch-command.txt" } },
		]) {
			assert.equal(isWorkflowRunLaunchMetadata(invalid), false);
		}

		const run = { runId, launch };
		await writeFile(
			join(workflowRunDir(cwd, runId), "launch-command.txt"),
			"tampered",
		);
		await assert.rejects(
			() => readWorkflowLaunchCommandArtifact(cwd, run),
			/verification failed/,
		);
		await assert.rejects(
			() =>
				readWorkflowLaunchCommandArtifact(cwd, {
					runId,
					launch: { ...launch, unexpected: true },
				}),
			/metadata malformed/,
		);

		await writeWorkflowLaunchCommandArtifact(
			cwd,
			runId,
			"/workflow dynamic secret",
		);
		await chmod(join(workflowRunDir(cwd, runId), "launch-command.txt"), 0o644);
		await assert.rejects(
			() => readWorkflowLaunchCommandArtifact(cwd, run),
			/verification failed/,
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("v2 auto launch metadata is distinct, strict, and cannot widen v1", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "piwf-launch-auto-v2-"));
	const runId = "workflow_auto_v2";
	try {
		const command = await writeWorkflowLaunchCommandArtifact(
			cwd,
			runId,
			'/workflow auto "review this"',
		);
		const task = "review this";
		const launch = {
			schema: "pi-workflow-run-launch-v2",
			source: { kind: "slash-command", action: "auto" },
			requestKind: "named-workflow",
			routingMode: "auto-confirmed",
			profile: { kind: "base" },
			task: { characters: task.length, lines: 1 },
			selection: {
				recommendation: "named-workflow",
				selected: "named-workflow",
				candidateId: "a".repeat(64),
				candidateIdentitySha256: "b".repeat(64),
				taskSha256: createHash("sha256").update(task).digest("hex"),
				confirmed: true,
				effectiveRuntime: { thinking: "medium" },
			},
			command,
		};
		assert.equal(isWorkflowRunLaunchMetadata(launch), true);
		assert.equal(
			isWorkflowRunLaunchMetadata({
				...launch,
				selection: { ...launch.selection, recommendation: null },
			}),
			true,
			"an explicitly unranked local manual fallback is valid v2 provenance",
		);
		assert.equal(
			isWorkflowRunLaunchMetadata({
				...launch,
				selection: { ...launch.selection, recommendation: "direct" },
			}),
			false,
		);
		assert.equal(
			isWorkflowRunLaunchMetadata({
				...launch,
				selection: { ...launch.selection, confirmed: false },
			}),
			false,
		);
		assert.equal(
			isWorkflowRunLaunchMetadata({
				...launch,
				source: { kind: "slash-command", action: "run" },
			}),
			false,
		);
		assert.equal(
			isWorkflowRunLaunchMetadata({
				...launch,
				requestKind: "direct-dynamic",
				selection: { ...launch.selection, selected: "named-workflow" },
			}),
			false,
		);
		assert.equal(
			isWorkflowRunLaunchMetadata({
				...launch,
				schema: "pi-workflow-run-launch-v1",
				routingMode: "auto-confirmed",
			}),
			false,
		);
		const specPath = join(cwd, "workflows", "missing-binding", "spec.json");
		await mkdir(join(cwd, "workflows", "missing-binding"), { recursive: true });
		await writeFile(
			specPath,
			JSON.stringify({
				schemaVersion: 1,
				name: "missing-binding",
				defaults: { agent: "scout", readOnly: true, tools: ["read"] },
				artifactGraph: {
					stages: [{ id: "main", type: "single", prompt: "Check." }],
				},
			}),
		);
		await assert.rejects(
			() =>
				runWorkflowSpec(specPath, cwd, {
					task,
					launch: {
						...launch,
						command: { state: "captured", text: '/workflow auto "review this"' },
					},
				}),
			/missing its in-memory selection binding/,
		);
		await assert.rejects(
			() =>
				runWorkflowSpec(specPath, cwd, {
					task,
					launch: {
						...launch,
						command: {
							state: "captured",
							text: '/workflow run missing-binding "review this"',
						},
					},
				}),
			/Invalid workflow launch metadata/,
		);
		const forgedDynamic = {
			...launch,
			requestKind: "direct-dynamic",
			profile: { kind: "not-applicable" },
			selection: {
				...launch.selection,
				recommendation: "direct-dynamic",
				selected: "direct-dynamic",
			},
		};
		assert.equal(isWorkflowRunLaunchMetadata(forgedDynamic), true);
		await assert.rejects(
			() =>
				runWorkflowSpec(specPath, cwd, {
					task,
					launch: {
						...forgedDynamic,
						command: { state: "captured", text: '/workflow auto "review this"' },
					},
				}),
			/does not match the requested execution path/,
		);
		await assert.rejects(
			() =>
				runDynamicTask(cwd, {
					task,
					launch: {
						...forgedDynamic,
						command: { state: "captured", text: '/workflow auto "review this"' },
					},
				}),
			/missing its in-memory selection binding/,
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("launch artifact rejects symlinked workflow roots, run directories, and artifacts", {
	skip: process.platform === "win32",
}, async () => {
	const secret = "/workflow run symlink-sensitive";
	const rootCwd = await mkdtemp(join(tmpdir(), "piwf-launch-root-link-"));
	const runCwd = await mkdtemp(join(tmpdir(), "piwf-launch-run-link-"));
	const artifactCwd = await mkdtemp(
		join(tmpdir(), "piwf-launch-artifact-link-"),
	);
	const outside = await mkdtemp(join(tmpdir(), "piwf-launch-outside-"));
	try {
		await mkdir(join(rootCwd, ".pi"), { recursive: true });
		await symlink(outside, join(rootCwd, ".pi", "workflows"));
		await assert.rejects(
			() =>
				writeWorkflowLaunchCommandArtifact(rootCwd, "workflow_root_link", secret),
			/Unsafe workflow launch artifact path/,
		);

		await mkdir(join(runCwd, ".pi", "workflows"), { recursive: true });
		await symlink(outside, workflowRunDir(runCwd, "workflow_run_link"));
		await assert.rejects(
			() =>
				writeWorkflowLaunchCommandArtifact(runCwd, "workflow_run_link", secret),
			/Unsafe workflow launch artifact path/,
		);

		const runId = "workflow_artifact_link";
		const command = await writeWorkflowLaunchCommandArtifact(
			artifactCwd,
			runId,
			secret,
		);
		const artifact = join(
			workflowRunDir(artifactCwd, runId),
			"launch-command.txt",
		);
		const outsideTarget = join(outside, "outside-command.txt");
		await writeFile(outsideTarget, "outside remains unchanged", { mode: 0o600 });
		await rm(artifact);
		await symlink(outsideTarget, artifact);
		await assert.rejects(
			() =>
				readWorkflowLaunchCommandArtifact(artifactCwd, {
					runId,
					launch: launchWith(command),
				}),
			/verification failed/,
		);
		await assert.rejects(
			() => writeWorkflowLaunchCommandArtifact(artifactCwd, runId, secret),
			/Unsafe workflow launch artifact path/,
		);
		assert.equal(
			await readFile(outsideTarget, "utf8"),
			"outside remains unchanged",
		);
		assert.equal(
			(await readdir(outside)).some((name) => name === "launch-command.txt"),
			false,
		);
	} finally {
		await rm(rootCwd, { recursive: true, force: true });
		await rm(runCwd, { recursive: true, force: true });
		await rm(artifactCwd, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test("launch artifact read and commit reject path swaps without disclosing command bytes", {
	skip: process.platform === "win32",
}, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "piwf-launch-swap-"));
	const outside = await mkdtemp(join(tmpdir(), "piwf-launch-swap-outside-"));
	const readRunId = "workflow_read_swap";
	const writeRunId = "workflow_write_swap";
	const readSecret = "/workflow run original-read-command";
	const writeSecret = "/workflow run original-write-command";
	try {
		const command = await writeWorkflowLaunchCommandArtifact(
			cwd,
			readRunId,
			readSecret,
		);
		setWorkflowLaunchArtifactTestHooksForTests({
			async onAfterReadOpen({ artifactPath }) {
				await rename(artifactPath, `${artifactPath}.opened`);
				await symlink(join(outside, "replacement.txt"), artifactPath);
			},
		});
		await writeFile(join(outside, "replacement.txt"), readSecret, {
			mode: 0o600,
		});
		await assert.rejects(
			() =>
				readWorkflowLaunchCommandArtifact(cwd, {
					runId: readRunId,
					launch: launchWith(command),
				}),
			/verification failed/,
		);

		setWorkflowLaunchArtifactTestHooksForTests({
			async onBeforeWriteRename() {
				const original = workflowRunDir(cwd, writeRunId);
				await rename(original, join(outside, "detached-run"));
				await mkdir(join(outside, "replacement-run"));
				await symlink(join(outside, "replacement-run"), original);
			},
		});
		await assert.rejects(
			() => writeWorkflowLaunchCommandArtifact(cwd, writeRunId, writeSecret),
			/Unsafe workflow launch artifact path/,
		);
		assert.deepEqual(await readdir(join(outside, "replacement-run")), []);
		for (const name of await readdir(join(outside, "detached-run"))) {
			const contents = await readFile(join(outside, "detached-run", name));
			assert.equal(contents.includes(Buffer.from(writeSecret)), false);
		}
	} finally {
		setWorkflowLaunchArtifactTestHooksForTests();
		await rm(cwd, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test("launch artifact hard-link races fail closed and zero escaped command bytes", {
	skip: process.platform === "win32",
}, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "piwf-launch-hardlink-"));
	const outside = await mkdtemp(join(tmpdir(), "piwf-launch-hardlink-outside-"));
	const secret = "/workflow run hardlink-race-secret";
	try {
		for (const phase of ["before", "after"]) {
			const runId = `workflow_hardlink_${phase}`;
			const escaped = join(outside, `${phase}.txt`);
			setWorkflowLaunchArtifactTestHooksForTests(
				phase === "before"
					? {
							async onBeforeWriteRename({ tempPath }) {
								await link(tempPath, escaped);
							},
						}
					: {
							async onAfterWriteRename({ artifactPath }) {
								await link(artifactPath, escaped);
							},
						},
			);
			await assert.rejects(
				() => writeWorkflowLaunchCommandArtifact(cwd, runId, secret),
				/Unsafe workflow launch artifact path/,
			);
			assert.equal(await readFile(escaped, "utf8"), "");
			await assert.rejects(() => stat(workflowRunPath(cwd, runId)), {
				code: "ENOENT",
			});
			await assert.rejects(
				() => stat(join(workflowRunDir(cwd, runId), "launch-command.txt")),
				{ code: "ENOENT" },
			);
			setWorkflowLaunchArtifactTestHooksForTests();
		}
	} finally {
		setWorkflowLaunchArtifactTestHooksForTests();
		await rm(cwd, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test("sidecar write failure prevents run record publication", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "piwf-launch-write-failure-"));
	const runId = "workflow_sidecar_write_failure";
	const exact = "/workflow run write-failure";
	try {
		await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
		await writeFile(
			join(cwd, ".pi", "agents", "launch-worker.md"),
			'---\ndescription: launch worker\ntools: ["read"]\nreadOnly: true\n---\n# Launch worker\n',
		);
		await writeFile(
			join(cwd, "workflow.json"),
			JSON.stringify({
				schemaVersion: 1,
				name: "launch-write-failure",
				defaults: {
					agent: "launch-worker",
					readOnly: true,
					tools: ["read"],
				},
				artifactGraph: {
					stages: [{ id: "main", type: "single", prompt: "Do work." }],
				},
			}),
		);
		setWorkflowLaunchArtifactTestHooksForTests({
			onBeforeWriteRename() {
				throw new Error("injected sidecar commit failure");
			},
		});
		await assert.rejects(
			() =>
				runWorkflowSpec("workflow.json", cwd, {
					runId,
					task: "Do work.",
					launch: {
						schema: "pi-workflow-run-launch-v1",
						source: { kind: "slash-command", action: "run" },
						requestKind: "named-workflow",
						routingMode: "off",
						profile: { kind: "base" },
						task: { characters: 8, lines: 1 },
						command: { state: "captured", text: exact },
					},
				}),
			/injected sidecar commit failure/,
		);
		await assert.rejects(() => stat(workflowRunPath(cwd, runId)), {
			code: "ENOENT",
		});
		await assert.rejects(
			() => stat(join(workflowRunDir(cwd, runId), "launch-command.txt")),
			{ code: "ENOENT" },
		);
		for (const name of await readdir(workflowRunDir(cwd, runId))) {
			const path = join(workflowRunDir(cwd, runId), name);
			const entry = await stat(path);
			if (entry.isFile())
				assert.equal((await readFile(path)).includes(Buffer.from(exact)), false);
		}
	} finally {
		setWorkflowLaunchArtifactTestHooksForTests();
		await rm(cwd, { recursive: true, force: true });
	}
});
