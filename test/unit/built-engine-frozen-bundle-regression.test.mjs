import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";

import { runWorkflowSpec, waitForRun } from "../../.tmp/unit/engine.js";
import { withMaterializedRawHost } from './raw-host-fixture.mjs';
const setSubagentApiForTests = withMaterializedRawHost(setRawApi);
import { setSubagentApiForTests as setRawApi } from "../../.tmp/unit/subagent-backend.js";
import { workflowRunDir } from "../../.tmp/unit/store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(__dirname, "../fixtures/built-engine-frozen-bundle");
const SPEC_PATH = join(FIXTURE_DIR, "spec.json");
const UNIT_TEST_HOME = mkdtempSync(join(tmpdir(), "built-engine-frozen-bundle-home-"));

process.env.HOME = UNIT_TEST_HOME;
process.env.USERPROFILE = UNIT_TEST_HOME;

after(() => {
	rmSync(UNIT_TEST_HOME, { recursive: true, force: true });
});

function makeProject() {
	const cwd = mkdtempSync(join(tmpdir(), "built-engine-frozen-bundle-"));
	const agentDir = join(cwd, ".pi", "agents");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "unit-scout.md"),
		[
			"---",
			"description: deterministic frozen bundle scout",
			'tools: ["read", "paid_campaign_send"]',
			"readOnly: true",
			"---",
			"# Unit Scout",
			"Return only the workflow output contract.",
			"",
		].join("\n"),
	);
	return cwd;
}

function writeSubagentArtifacts(cwd, runsDir, runId, attemptId, outputText) {
	const artifactDir = join(cwd, runsDir, runId, "attempts", attemptId);
	mkdirSync(artifactDir, { recursive: true });
	writeFileSync(join(artifactDir, "output.log"), outputText);
	writeFileSync(join(artifactDir, "stderr.log"), "");
	writeFileSync(
		join(artifactDir, "result.json"),
		JSON.stringify({
			status: "completed",
			completedAt: new Date().toISOString(),
			startedAt: new Date(Date.now() - 1000).toISOString(),
			exitCode: 0,
		}),
	);
	return artifactDir;
}

function guardedOutput(receipt) {
	return [
		"<control>",
		JSON.stringify(receipt),
		"</control>",
		"<analysis>",
		`Frozen bundle guard receipt: ${receipt.seedCampaignId}/${receipt.seedNonce}.`,
		"</analysis>",
		"<refs>",
		"[]",
		"</refs>",
	].join("\n");
}

function bundledFilePath(cwd, workflowRunId, fileName) {
	const root = join(workflowRunDir(cwd, workflowRunId), "bundle");
	const pending = [root];
	while (pending.length > 0) {
		const directory = pending.pop();
		if (!directory || !existsSync(directory)) continue;
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) pending.push(path);
			else if (entry.isFile() && entry.name === fileName) return path;
		}
	}
	return join(root, fileName);
}

function bundleGuardPath(cwd, workflowRunId) {
	return bundledFilePath(cwd, workflowRunId, "generated-guard-extension.mjs");
}

function bundleSeedPath(cwd, workflowRunId) {
	return bundledFilePath(cwd, workflowRunId, "seed.json");
}

async function coldLoadGuardReceipt(cwd, workflowRunId, cacheKey, assertSeedCopied = true) {
	const guardPath = bundleGuardPath(cwd, workflowRunId);
	assert.equal(
		existsSync(guardPath),
		true,
		"copied run bundle contains generated guard before provider-like send",
	);
	if (assertSeedCopied) {
		assert.equal(
			existsSync(bundleSeedPath(cwd, workflowRunId)),
			true,
			"copied run bundle contains workflow-local seed before cold-load",
		);
	}
	const guard = await import(`${pathToFileURL(guardPath).href}?${cacheKey}`);
	return guard.validateFrozenBundleGuard();
}

function makeFakeSubagentApi({ cwd, counters, omitCopiedSeed }) {
	const runs = new Map();
	return {
		async runSubagent(options) {
			counters.launches += 1;
			const workflowRunId = omitCopiedSeed
				? "run_frozen_bundle_missing_seed"
				: "run_frozen_bundle_success";
			assert.match(
				String(options.correlationId),
				new RegExp(`^${workflowRunId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`),
				"subagent launch correlation binds the workflow run id",
			);
			assert.deepEqual(
				options.tools,
				["read", "paid_campaign_send", "workflow_artifact"],
				"built engine injects the artifact tool without dropping the provider-like tool contract",
			);
			assert.ok(
				options.extensions.includes(bundleGuardPath(cwd, workflowRunId)),
				"built engine dispatch rewrites the generated guard extension to the frozen run bundle",
			);
			assert.equal(
				options.extensions.includes("./generated-guard-extension.mjs"),
				false,
				"built engine never dispatches the mutable source-relative guard path",
			);

			if (omitCopiedSeed) {
				assert.equal(
					existsSync(bundleSeedPath(cwd, workflowRunId)),
					true,
					"parent launch checkpoint copied workflow-local seed before omission",
				);
				unlinkSync(bundleSeedPath(cwd, workflowRunId));
			}
			const receipt = await coldLoadGuardReceipt(
				cwd,
				workflowRunId,
				`${omitCopiedSeed ? "missing" : "success"}-${counters.launches}`,
				!omitCopiedSeed,
			);
			counters.providerLikeSends += 1;
			const runId = `run_frozen_bundle_${counters.launches}`;
			const attemptId = `attempt_frozen_bundle_${counters.launches}`;
			const runsDir = String(options.runsDir ?? ".pi/agent/runs");
			const artifactDir = writeSubagentArtifacts(
				cwd,
				runsDir,
				runId,
				attemptId,
				guardedOutput(receipt),
			);
			runs.set(runId, { runId, attemptId, artifactDir });
			return { runId, attemptId, status: "running" };
		},
		async reconcileSubagentRun() {
			return {};
		},
		async getSubagentStatus({ runId }) {
			const run = runs.get(runId);
			assert.ok(run, `missing subagent run ${runId}`);
			return {
				runId,
				attemptId: run.attemptId,
				backend: "headless",
				status: "completed",
				failureKind: null,
				startedAt: new Date(Date.now() - 1000).toISOString(),
				completedAt: new Date().toISOString(),
				logs: [
					{ type: "output", path: "output.log", artifactCwd: run.artifactDir },
					{ type: "stderr", path: "stderr.log", artifactCwd: run.artifactDir },
					{ type: "result", path: "result.json", artifactCwd: run.artifactDir },
				],
				metadata: { contextLengthExceeded: false },
				attempts: [{ attemptId: run.attemptId, status: "completed" }],
			};
		},
		async interruptSubagent() {
			return {};
		},
	};
}

async function withNetworkAttemptCounter(callback) {
	let networkAttempts = 0;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => {
		networkAttempts += 1;
		throw new Error("real network disabled in frozen bundle regression");
	};
	try {
		await callback(() => networkAttempts);
	} finally {
		globalThis.fetch = originalFetch;
	}
}

test("built engine copies and cold-loads workflow-local seed before deterministic provider shutdown", async () => {
	const cwd = makeProject();
	const counters = { launches: 0, providerLikeSends: 0 };
	try {
		await withNetworkAttemptCounter(async (networkAttempts) => {
			setSubagentApiForTests(makeFakeSubagentApi({ cwd, counters }));

			const started = await runWorkflowSpec(SPEC_PATH, cwd, {
				task: "Exercise the frozen bundle seed guard.",
				runId: "run_frozen_bundle_success",
			});
			const completed = await waitForRun(cwd, started.runId, 20_000);

			assert.equal(
				completed.status,
				"completed",
				JSON.stringify({
					statusDetail: completed.tasks[0].statusDetail,
					lastMessage: completed.tasks[0].lastMessage,
					error: completed.tasks[0].error,
				}),
			);
			assert.equal(completed.tasks[0].status, "completed");
			assert.equal(counters.providerLikeSends, 1);
			assert.equal(networkAttempts(), 0);

			const control = JSON.parse(
				readFileSync(
					join(dirname(join(cwd, completed.tasks[0].files.result)), "control.json"),
					"utf8",
				),
			);
			assert.deepEqual(control, {
				schema: "built-engine-frozen-bundle-guard-receipt-v1",
				digest: "frozen-bundle-pass",
				seedCampaignId: "paid-campaign-regression",
				seedNonce: "seed-20260716",
				providerDispatch: "shutdown-before-provider-send",
			});
		});
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
	}
});

test("built engine fails terminally before provider-like send when copied seed cold-load is missing", async () => {
	const cwd = makeProject();
	const counters = { launches: 0, providerLikeSends: 0 };
	try {
		await withNetworkAttemptCounter(async (networkAttempts) => {
			setSubagentApiForTests(
				makeFakeSubagentApi({ cwd, counters, omitCopiedSeed: true }),
			);

			const started = await runWorkflowSpec(SPEC_PATH, cwd, {
				task: "Exercise missing copied seed fail-closed behavior.",
				runId: "run_frozen_bundle_missing_seed",
			});
			const failed = await waitForRun(cwd, started.runId, 20_000);

			assert.equal(failed.status, "failed");
			assert.equal(failed.tasks[0].status, "failed");
			assert.equal(
				existsSync(bundleSeedPath(cwd, failed.runId)),
				false,
				"missing copied seed remains absent after terminal pre-provider failure",
			);
			assert.equal(
				counters.providerLikeSends,
				0,
				"missing seed cold-load fails before provider-like send",
			);
			assert.equal(
				networkAttempts(),
				0,
				"missing seed cold-load failure does not attempt real network",
			);
		});
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
	}
});
