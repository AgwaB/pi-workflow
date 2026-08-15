#!/usr/bin/env node
import assert from "node:assert/strict";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [workflowRoot, consumerRoot] = process.argv.slice(2);
if (!workflowRoot || !consumerRoot)
	throw new Error("packed durable barrier case needs workflow and consumer roots");

const require = createRequire(join(workflowRoot, "package.json"));
const api = await import(pathToFileURL(require.resolve("@agwab/pi-subagent/api")).href);
for (const name of [
	"createDurableLaunchBarrierV2",
	"resolveDurableLaunchBarrierV2Release",
	"revokeDurableLaunchBarrierV2",
	"waitForDurableLaunchBarrierV2Ready",
	"waitForDurableLaunchBarrierV2Ack",
	"waitForSubagent",
])
	assert.equal(typeof api[name], "function", `missing ${name}`);

const root = join(consumerRoot, "packed-durable-barrier-v2");
const bin = join(root, "bin");
const fakePi = join(bin, "pi");
const cwd = join(root, "project");
const runsDir = join(cwd, "runs");
await rm(root, { recursive: true, force: true });
await mkdir(bin, { recursive: true });
await mkdir(cwd, { recursive: true });
const priorPath = process.env.PATH;
process.env.PATH = `${bin}:${priorPath ?? ""}`;

async function installFakePi(marker) {
	await writeFile(
		fakePi,
		`#!/usr/bin/env node\nconst { writeFileSync } = require("node:fs");\nwriteFileSync(${JSON.stringify(marker)}, "provider-entered\\n");\nprocess.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "provider-free fixture" }], provider: "fake", model: "fake/model", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end" } }) + "\\n");\n`,
		"utf8",
	);
	await chmod(fakePi, 0o700);
}

async function launch(descriptor, suffix) {
	return api.runSubagent({
		backend: "headless",
		task: `provider-free durable barrier ${suffix}`,
		systemPrompt: "Return fixture output.",
		model: "fake/model",
		thinking: "off",
		tools: [],
		skills: [],
		extensions: [],
		cwd,
		async: true,
		onComplete: "detach",
		workspace: "shared",
		worktreePolicy: "never",
		runsDir,
		durableLaunchBarrier: descriptor,
	});
}

try {
	const releaseMarker = join(root, "release-provider-marker.txt");
	await installFakePi(releaseMarker);
	const releaseDescriptor = await api.createDurableLaunchBarrierV2({
		directory: join(root, "release-barrier"),
		subjectSha256: "a".repeat(64),
		authorityBindingSha256: "b".repeat(64),
		timeoutMs: 30_000,
		pollIntervalMs: 5,
	});
	const releasedRun = await launch(releaseDescriptor, "release");
	const ready = await api.waitForDurableLaunchBarrierV2Ready(releaseDescriptor);
	assert.equal(ready.runId, releasedRun.runId);
	assert.equal(ready.attemptId, releasedRun.attemptId);
	assert.equal(ready.authorityBindingSha256, "b".repeat(64));
	const release = await api.resolveDurableLaunchBarrierV2Release(
		releaseDescriptor,
		ready,
		"c".repeat(64),
	);
	assert.equal(release.outcome, "released");
	const ack = await api.waitForDurableLaunchBarrierV2Ack(
		releaseDescriptor,
		release.decision,
	);
	assert.equal(ack.decisionSha256, release.decision.decisionSha256);
	const releasedTerminal = await api.waitForSubagent({
		cwd,
		runsDir,
		runId: releasedRun.runId,
		attemptId: releasedRun.attemptId,
		timeoutMs: 30_000,
		pollIntervalMs: 20,
	});
	assert.equal(releasedTerminal.snapshot?.status, "completed");
	assert.equal(
		await import("node:fs/promises").then(({ readFile }) =>
			readFile(releaseMarker, "utf8"),
		),
		"provider-entered\n",
	);

	const revokeMarker = join(root, "revoke-provider-marker.txt");
	await installFakePi(revokeMarker);
	const revokeDescriptor = await api.createDurableLaunchBarrierV2({
		directory: join(root, "revoke-barrier"),
		subjectSha256: "d".repeat(64),
		authorityBindingSha256: "e".repeat(64),
		timeoutMs: 30_000,
		pollIntervalMs: 5,
	});
	const revokedRun = await launch(revokeDescriptor, "revoke");
	const revokeReady = await api.waitForDurableLaunchBarrierV2Ready(
		revokeDescriptor,
	);
	const revoked = await api.revokeDurableLaunchBarrierV2(revokeDescriptor, {
		cancellationId: "packed-e2e-revocation",
		reasonSha256: "f".repeat(64),
	});
	assert.equal(revoked.outcome, "revoked");
	const releaseAfterRevoke = await api.resolveDurableLaunchBarrierV2Release(
		revokeDescriptor,
		revokeReady,
		"0".repeat(64),
	);
	assert.equal(releaseAfterRevoke.outcome, "revoked");
	const revokedTerminal = await api.waitForSubagent({
		cwd,
		runsDir,
		runId: revokedRun.runId,
		attemptId: revokedRun.attemptId,
		timeoutMs: 30_000,
		pollIntervalMs: 20,
	});
	assert.equal(revokedTerminal.snapshot?.status, "cancelled");
	await assert.rejects(
		import("node:fs/promises").then(({ access }) => access(revokeMarker)),
	);
	console.log("packed durable launch barrier v2 release/revoke passed");
} finally {
	if (priorPath === undefined) delete process.env.PATH;
	else process.env.PATH = priorPath;
	await rm(root, { recursive: true, force: true });
}
