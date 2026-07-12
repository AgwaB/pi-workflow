import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
	mkdirSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
	cleanupSubagentRun,
	launchSubagentTask,
	refreshRunFromSubagentArtifacts,
	resolveCampaignAccountingConfigurationForTests,
	runOneShotSubagentCall,
	setSubagentApiForTests,
} from "../../.tmp/unit/subagent-backend.js";
import { writeRunRecord } from "../../.tmp/unit/store.js";
import { makeSubagentLaunchFixture } from "./unit-test-support.mjs";

const CAMPAIGN_KEYS = [
	"PI_WORKFLOW_CAMPAIGN_ID",
	"PI_WORKFLOW_CAMPAIGN_PACKET_HASH",
	"PI_WORKFLOW_CAMPAIGN_PACKET_PATH",
	"PI_WORKFLOW_CAMPAIGN_LEDGER_PATH",
	"PI_WORKFLOW_CAMPAIGN_EXTENSION",
	"PI_WORKFLOW_CAMPAIGN_EXTENSION_SHA256",
	"PI_WORKFLOW_CAMPAIGN_FROZEN_SETTINGS",
	"PI_WORKFLOW_MAX_CONCURRENT_LAUNCHES",
	"PI_WORKFLOW_MAX_LIVE_MODEL_WORKERS",
	"PI_WORKFLOW_ADAPTIVE_LIVE_WORKERS",
	"PI_WORKFLOW_TRANSIENT_MODEL_FAILURE_RETRIES",
	"PI_WORKFLOW_ARTIFACT_OUTPUT_RETRIES",
	"PI_WORKFLOW_CAMPAIGN_CONTEXT",
	"PI_WORKFLOW_SUBAGENT_EXTRA_EXTENSIONS",
	"OPENAI_API_KEY",
	"PI_CODING_AGENT_DIR",
];

const FROZEN_SETTINGS = Object.freeze({
	schema: "campaign-frozen-settings-v1",
	provider: "openai-codex",
	model: "gpt-5.5",
	thinking: "low",
	workers: 1,
	inFlight: 1,
	adaptive: false,
	maxRetries: 0,
	transport: "sse",
	noSend: true,
	transientModelFailureRetries: 0,
	artifactOutputRetries: 0,
});

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value) {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, canonicalize(value[key])]),
		);
	return value;
}

function canonicalPacketBytes(value) {
	return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function saveEnvironment() {
	return Object.fromEntries(
		CAMPAIGN_KEYS.map((key) => [key, process.env[key]]),
	);
}

function restoreEnvironment(saved) {
	for (const key of CAMPAIGN_KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
}

const RUNNER_ROOT = "/Users/toby/pi/piwf-batched-default-20260712/runner";
const PRODUCT_PATH = realpathSync(resolve(".tmp/unit/subagent-backend.js"));
const REAL_INTEGRATION_PATHS = Object.freeze({
	product: PRODUCT_PATH,
	campaignExtension: realpathSync(join(RUNNER_ROOT, "campaign-extension.mjs")),
	ledger: realpathSync(join(RUNNER_ROOT, "ledger.mjs")),
	adapter: realpathSync(join(RUNNER_ROOT, "adapter.mjs")),
	driver: realpathSync(join(RUNNER_ROOT, "freeze.mjs")),
});

function integrationEntries(paths) {
	return Object.fromEntries(
		Object.entries(paths).map(([key, file]) => [
			key,
			{ path: file, sha256: sha256(readFileSync(file)) },
		]),
	);
}

function writeSyntheticIntegrationFiles(root) {
	const files = {
		product: PRODUCT_PATH,
		campaignExtension: resolve(root, "campaign-extension.mjs"),
		ledger: resolve(root, "ledger.mjs"),
		adapter: resolve(root, "adapter.mjs"),
		driver: resolve(root, "freeze.mjs"),
	};
	for (const [key, file] of Object.entries(files)) {
		if (key === "product") continue;
		writeFileSync(file, `// synthetic ${key} integration fixture\n`);
	}
	return files;
}

function realCampaignExtensionPath() {
	return REAL_INTEGRATION_PATHS.campaignExtension;
}

function installCampaignEnvironment(root) {
	root = realpathSync(root);
	const packetPath = resolve(root, "packet.json");
	const ledgerPath = resolve(root, "campaign-ledger.json");
	const integrationPaths = writeSyntheticIntegrationFiles(root);
	const extensionPath = integrationPaths.campaignExtension;
	const extensionSha256 = sha256(readFileSync(extensionPath));
	const scorerHash = sha256("campaign-unit-scorer");
	const caps = { provider_request: 4, model_attempt: 4, repair: 0 };
	const unsignedPacket = {
		schema: "pi-workflow-campaign-packet-v1",
		schemaVersion: 2,
		authority: {
			noSend: true,
			providerSend: false,
			childLaunch: "offline-NO_SEND-only",
			approval: false,
			paidModeApprovalArtifact: null,
		},
		source: {
			head: "0".repeat(40),
			tree: "0".repeat(40),
			statusPorcelainV1Z: "",
		},
		fixture: { candidateHash: sha256("fixture") },
		sourceInventory: { files: [] },
		scorerAndRubric: { sha256: scorerHash },
		settings: {
			noSend: true,
			network: "forbidden",
			execution: "offline-NO_SEND-only",
			providerSend: false,
			providerCalls: 0,
			model: "openai-codex/gpt-5.5",
			thinking: "low",
			concurrency: {
				mode: "serial",
				workflowRuns: 1,
				providerRequestsInFlight: 1,
				adaptive: false,
			},
			retries: {
				PI_WORKFLOW_TRANSIENT_MODEL_FAILURE_RETRIES: 0,
				PI_WORKFLOW_ARTIFACT_OUTPUT_RETRIES: 0,
			},
			caps,
		},
		integrations: integrationEntries(integrationPaths),
	};
	const packetHash = sha256(canonicalPacketBytes(unsignedPacket));
	writeFileSync(
		packetPath,
		canonicalPacketBytes({ ...unsignedPacket, packetHash }),
	);
	writeFileSync(
		ledgerPath,
		`${JSON.stringify({ schemaVersion: 2, packetHash, scorerHash, caps, sequence: 0, cancelled: false, terminal: null, events: [], reservations: [] })}\n`,
	);
	Object.assign(process.env, {
		PI_WORKFLOW_CAMPAIGN_ID: "campaign-unit",
		PI_WORKFLOW_CAMPAIGN_PACKET_HASH: packetHash,
		PI_WORKFLOW_CAMPAIGN_PACKET_PATH: packetPath,
		PI_WORKFLOW_CAMPAIGN_LEDGER_PATH: ledgerPath,
		PI_WORKFLOW_CAMPAIGN_EXTENSION: extensionPath,
		PI_WORKFLOW_CAMPAIGN_EXTENSION_SHA256: extensionSha256,
		PI_WORKFLOW_CAMPAIGN_FROZEN_SETTINGS: JSON.stringify(FROZEN_SETTINGS),
		PI_WORKFLOW_MAX_CONCURRENT_LAUNCHES: "1",
		PI_WORKFLOW_MAX_LIVE_MODEL_WORKERS: "1",
		PI_WORKFLOW_ADAPTIVE_LIVE_WORKERS: "0",
		PI_WORKFLOW_TRANSIENT_MODEL_FAILURE_RETRIES: "0",
		PI_WORKFLOW_ARTIFACT_OUTPUT_RETRIES: "0",
	});
	return { extensionPath, packetPath, ledgerPath };
}

function rewriteCampaignPacket(config, mutate) {
	const packet = JSON.parse(readFileSync(config.packetPath, "utf8"));
	delete packet.packetHash;
	mutate(packet);
	const packetHash = sha256(canonicalPacketBytes(packet));
	writeFileSync(
		config.packetPath,
		canonicalPacketBytes({ ...packet, packetHash }),
	);
	const ledger = JSON.parse(readFileSync(config.ledgerPath, "utf8"));
	ledger.packetHash = packetHash;
	writeFileSync(config.ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
	process.env.PI_WORKFLOW_CAMPAIGN_PACKET_HASH = packetHash;
}

function installRealOfflineNoSendCampaignEnvironment(root) {
	root = realpathSync(root);
	const packetPath = resolve(root, "packet.json");
	const ledgerPath = resolve(root, "campaign-ledger.json");
	const extensionPath = realCampaignExtensionPath();
	const extensionSha256 = sha256(readFileSync(extensionPath));
	const scorerHash = sha256("clean-source-integration-scorer");
	const caps = { provider_request: 4, model_attempt: 4, repair: 0 };
	const unsignedPacket = {
		schema: "pi-workflow-campaign-packet-v1",
		schemaVersion: 2,
		authority: {
			noSend: true,
			providerSend: false,
			childLaunch: "offline-NO_SEND-only",
			approval: false,
			paidModeApprovalArtifact: null,
		},
		source: {
			head: "0".repeat(40),
			tree: "0".repeat(40),
			statusPorcelainV1Z: "",
		},
		fixture: { candidateHash: sha256("offline-no-send-e2e") },
		sourceInventory: { files: [] },
		scorerAndRubric: { sha256: scorerHash },
		settings: {
			noSend: true,
			network: "forbidden",
			execution: "offline-NO_SEND-only",
			providerSend: false,
			providerCalls: 0,
			model: "openai-codex/gpt-5.5",
			thinking: "low",
			concurrency: {
				mode: "serial",
				workflowRuns: 1,
				providerRequestsInFlight: 1,
				adaptive: false,
			},
			retries: {
				PI_WORKFLOW_TRANSIENT_MODEL_FAILURE_RETRIES: 0,
				PI_WORKFLOW_ARTIFACT_OUTPUT_RETRIES: 0,
			},
			caps,
		},
		integrations: integrationEntries(REAL_INTEGRATION_PATHS),
	};
	const packetHash = sha256(canonicalPacketBytes(unsignedPacket));
	writeFileSync(
		packetPath,
		canonicalPacketBytes({ ...unsignedPacket, packetHash }),
	);
	writeFileSync(
		ledgerPath,
		`${JSON.stringify({ schemaVersion: 2, packetHash, scorerHash, caps, sequence: 0, cancelled: false, terminal: null, events: [], reservations: [] }, null, 2)}\n`,
		{ mode: 0o600 },
	);
	Object.assign(process.env, {
		PI_WORKFLOW_CAMPAIGN_ID: "campaign-real-offline-no-send",
		PI_WORKFLOW_CAMPAIGN_PACKET_HASH: packetHash,
		PI_WORKFLOW_CAMPAIGN_PACKET_PATH: packetPath,
		PI_WORKFLOW_CAMPAIGN_LEDGER_PATH: ledgerPath,
		PI_WORKFLOW_CAMPAIGN_EXTENSION: extensionPath,
		PI_WORKFLOW_CAMPAIGN_EXTENSION_SHA256: extensionSha256,
		PI_WORKFLOW_CAMPAIGN_FROZEN_SETTINGS: JSON.stringify(FROZEN_SETTINGS),
		PI_WORKFLOW_MAX_CONCURRENT_LAUNCHES: "1",
		PI_WORKFLOW_MAX_LIVE_MODEL_WORKERS: "1",
		PI_WORKFLOW_ADAPTIVE_LIVE_WORKERS: "0",
		PI_WORKFLOW_TRANSIENT_MODEL_FAILURE_RETRIES: "0",
		PI_WORKFLOW_ARTIFACT_OUTPUT_RETRIES: "0",
	});
	return { packetPath, ledgerPath, extensionPath, packetHash, scorerHash };
}

function prepareLaunch(root, suffix, retry = {}) {
	const fixture = makeSubagentLaunchFixture(root, suffix);
	fixture.compiledTask.runtime.model = "openai-codex/gpt-5.5";
	fixture.compiledTask.runtime.thinking = "low";
	fixture.task.launchRetry = retry.launchRetry;
	fixture.task.outputRetry = retry.outputRetry;
	mkdirSync(join(root, ".pi", "workflows"), { recursive: true });
	return fixture;
}

test("campaign configuration is default-off and partial, relative, drifted, or non-serial configuration fails closed", async () => {
	const saved = saveEnvironment();
	const root = mkdtempSync(join(tmpdir(), "workflow-campaign-config-"));
	try {
		for (const key of CAMPAIGN_KEYS) delete process.env[key];
		assert.equal(
			await resolveCampaignAccountingConfigurationForTests(),
			undefined,
		);
		process.env.PI_WORKFLOW_CAMPAIGN_CONTEXT = resolve(root, "orphan.json");
		await assert.rejects(
			resolveCampaignAccountingConfigurationForTests(),
			/orphan_context/,
		);
		delete process.env.PI_WORKFLOW_CAMPAIGN_CONTEXT;
		process.env.PI_WORKFLOW_CAMPAIGN_ID = "partial";
		await assert.rejects(
			resolveCampaignAccountingConfigurationForTests(),
			/campaign_configuration_partial/,
		);
		delete process.env.PI_WORKFLOW_CAMPAIGN_ID;
		const config = installCampaignEnvironment(root);
		assert.equal(
			(await resolveCampaignAccountingConfigurationForTests()).campaignId,
			"campaign-unit",
		);
		process.env.PI_WORKFLOW_CAMPAIGN_PACKET_PATH = "packet.json";
		await assert.rejects(
			resolveCampaignAccountingConfigurationForTests(),
			/relative_path:packet/,
		);
		process.env.PI_WORKFLOW_CAMPAIGN_PACKET_PATH = config.packetPath;
		process.env.PI_WORKFLOW_MAX_CONCURRENT_LAUNCHES = "2";
		await assert.rejects(
			resolveCampaignAccountingConfigurationForTests(),
			/not_serial/,
		);
		process.env.PI_WORKFLOW_MAX_CONCURRENT_LAUNCHES = "1";
		writeFileSync(config.extensionPath, "// drift\n");
		await assert.rejects(
			resolveCampaignAccountingConfigurationForTests(),
			/drift:extension/,
		);
	} finally {
		restoreEnvironment(saved);
		rmSync(root, { recursive: true, force: true });
	}
});

test("campaign packet contract fails closed for missing integration, hash drift, and dirty source", async () => {
	const saved = saveEnvironment();
	const root = mkdtempSync(join(tmpdir(), "workflow-campaign-contract-"));
	try {
		for (const key of CAMPAIGN_KEYS) delete process.env[key];
		const config = installCampaignEnvironment(root);
		rewriteCampaignPacket(config, (packet) => {
			delete packet.integrations.product;
		});
		await assert.rejects(
			resolveCampaignAccountingConfigurationForTests(),
			/drift:integrations/,
		);

		installCampaignEnvironment(root);
		writeFileSync(resolve(root, "adapter.mjs"), "// drifted adapter\n");
		await assert.rejects(
			resolveCampaignAccountingConfigurationForTests(),
			/drift:integration:adapter/,
		);

		const wrongProductConfig = installCampaignEnvironment(root);
		rewriteCampaignPacket(wrongProductConfig, (packet) => {
			const adapterPath = resolve(root, "adapter.mjs");
			packet.integrations.product = {
				path: realpathSync(adapterPath),
				sha256: sha256(readFileSync(adapterPath)),
			};
		});
		await assert.rejects(
			resolveCampaignAccountingConfigurationForTests(),
			/drift:integration:product/,
		);

		const dirtyConfig = installCampaignEnvironment(root);
		rewriteCampaignPacket(dirtyConfig, (packet) => {
			packet.source.statusPorcelainV1Z = " M src/subagent-backend.ts\0";
		});
		await assert.rejects(
			resolveCampaignAccountingConfigurationForTests(),
			/dirty_source/,
		);
		assert.equal(
			(
				await resolveCampaignAccountingConfigurationForTests(process.env, {
					allowDirtySourceForTests: true,
				})
			).campaignId,
			"campaign-unit",
		);
	} finally {
		restoreEnvironment(saved);
		rmSync(root, { recursive: true, force: true });
	}
});

test("campaign launch uses a self-hashed task-local wrapper without parent env handoff", async () => {
	const saved = saveEnvironment();
	const root = mkdtempSync(join(tmpdir(), "workflow-campaign-launch-"));
	try {
		for (const key of CAMPAIGN_KEYS) delete process.env[key];
		const { extensionPath } = installCampaignEnvironment(root);
		const { run, task, compiledTask } = prepareLaunch(root, "correlation");
		const normalExtensionPath = resolve(root, "normal-extension.mjs");
		writeFileSync(
			normalExtensionPath,
			"export default function normalExtension() {}\n",
		);
		process.env.PI_WORKFLOW_SUBAGENT_EXTRA_EXTENSIONS = normalExtensionPath;
		let captured;
		let releaseAck;
		const ack = new Promise((resolveAck) => {
			releaseAck = resolveAck;
		});
		setSubagentApiForTests({
			async runSubagent(options) {
				assert.equal(process.env.PI_WORKFLOW_CAMPAIGN_CONTEXT, undefined);
				if (options.onComplete !== "detach")
					return { status: "completed", output: "ordinary" };
				assert.equal(options.extensions.length, 2);
				assert.equal(options.extensions[0], normalExtensionPath);
				assert.notEqual(options.extensions[1], extensionPath);
				const wrapper = readFileSync(options.extensions[1], "utf8");
				const contextPath = JSON.parse(
					wrapper.match(/const contextPath = (.*);/)[1],
				);
				captured = {
					options,
					contextPath,
					context: JSON.parse(readFileSync(contextPath, "utf8")),
					wrapper,
				};
				await ack;
				assert.equal(process.env.PI_WORKFLOW_CAMPAIGN_CONTEXT, undefined);
				return {
					runId: "campaign-child",
					attemptId: "campaign-attempt",
					status: "running",
				};
			},
			async getSubagentStatus() {
				return null;
			},
			async reconcileSubagentRun() {
				return {};
			},
			async interruptSubagent() {
				return {};
			},
		});
		await writeRunRecord(root, run);
		const campaignLaunch = launchSubagentTask(root, run, task, compiledTask);
		while (!captured)
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 1));
		const ordinary = await runOneShotSubagentCall({ task: "ordinary" });
		assert.equal(ordinary.output, "ordinary");
		releaseAck();
		await campaignLaunch;
		assert.match(captured.wrapper, /campaign_extension_hash_drift/);
		assert.equal(captured.context.workflowRunId, run.runId);
		assert.equal(captured.context.workflowTaskId, task.taskId);
		assert.equal(captured.context.workflowSpecId, task.specId);
		assert.equal(captured.context.launchRetryIndex, 0);
		assert.equal(captured.context.outputRetryIndex, 0);
		assert.match(captured.context.campaignLaunchAttemptId, /^[a-f0-9-]{36}$/);
		assert.match(captured.context.contextHash, /^[a-f0-9]{64}$/);
		assert.deepEqual(captured.context.frozenSettings, FROZEN_SETTINGS);
		assert.equal(process.env.PI_WORKFLOW_CAMPAIGN_CONTEXT, undefined);
		assert.equal(readFileSync(captured.contextPath).length > 0, true);
		await cleanupSubagentRun(root, run);
	} finally {
		setSubagentApiForTests(undefined);
		restoreEnvironment(saved);
		rmSync(root, { recursive: true, force: true });
	}
});

test("real pi-subagent child honors campaign offline NO_SEND from launch boundary", async () => {
	const saved = saveEnvironment();
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "workflow-campaign-real-nosend-")),
	);
	let run;
	try {
		for (const key of CAMPAIGN_KEYS) delete process.env[key];
		assert.equal(process.env.PI_WORKFLOW_CAMPAIGN_CONTEXT, undefined);
		const { ledgerPath } = installRealOfflineNoSendCampaignEnvironment(root);
		const agentDir = resolve(root, "agent-home");
		mkdirSync(agentDir, { recursive: true, mode: 0o700 });
		writeFileSync(
			resolve(agentDir, "auth.json"),
			`${JSON.stringify(
				{
					"openai-codex": {
						type: "api_key",
						key: "pi-workflow-offline-nosend-test-dummy-key",
					},
					openai: {
						type: "api_key",
						key: "pi-workflow-offline-nosend-test-dummy-key",
					},
				},
				null,
				2,
			)}\n`,
			{ mode: 0o600 },
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.OPENAI_API_KEY = "pi-workflow-offline-nosend-test-dummy-key";
		const fixture = prepareLaunch(root, "real-nosend");
		({ run } = fixture);
		const { task, compiledTask } = fixture;
		compiledTask.compiledPrompt = "Say one short sentence. Do not use tools.";
		await writeRunRecord(root, run);
		const launch = await launchSubagentTask(root, run, task, compiledTask);
		assert.equal(launch.kind, "launched");
		assert.equal(process.env.PI_WORKFLOW_CAMPAIGN_CONTEXT, undefined);
		assert.equal(task.status, "running");
		const campaignLaunchAttemptId = task.backendFiles.campaignLaunchAttemptId;
		assert.match(campaignLaunchAttemptId, /^[a-f0-9-]{36}$/);
		assert.ok(task.backendHandle?.runId);
		assert.notEqual(task.backendHandle.runId, run.runId);
		assert.notEqual(
			task.backendFiles.campaignLaunchAttemptId,
			task.backendHandle.runId,
		);

		let refreshed = run;
		const deadline = Date.now() + 30000;
		while (Date.now() < deadline) {
			refreshed = await refreshRunFromSubagentArtifacts(root, refreshed);
			if (
				["completed", "failed", "interrupted"].includes(
					refreshed.tasks[0].status,
				)
			)
				break;
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
		}
		const finalTask = refreshed.tasks[0];
		assert.equal(finalTask.status, "failed");
		const resultPath = resolve(root, finalTask.files.result);
		const stderrPath = resolve(root, finalTask.files.stderr);
		const transientResultPath = resolve(
			root,
			finalTask.files.result.replace(
				/result\.json$/,
				"result.transient-model-failure-1.json",
			),
		);
		const resultText = [
			existsSync(resultPath) ? readFileSync(resultPath, "utf8") : "",
			existsSync(transientResultPath)
				? readFileSync(transientResultPath, "utf8")
				: "",
			existsSync(stderrPath) ? readFileSync(stderrPath, "utf8") : "",
			JSON.stringify(finalTask),
		].join("\n");
		assert.match(resultText, /campaign_no_send_intercepted/);

		const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
		const modelAttempts = ledger.reservations.filter(
			(row) => row.kind === "model_attempt",
		);
		const providerRequests = ledger.reservations.filter(
			(row) => row.kind === "provider_request",
		);
		const repairs = ledger.reservations.filter((row) => row.kind === "repair");
		assert.equal(modelAttempts.length, 1);
		assert.equal(providerRequests.length, 1);
		assert.equal(repairs.length, 0);
		assert.equal(modelAttempts[0].meta.provider, "openai-codex");
		assert.equal(modelAttempts[0].meta.model, "gpt-5.5");
		assert.equal(providerRequests[0].meta.provider, "openai-codex");
		assert.equal(providerRequests[0].meta.model, "gpt-5.5");
		assert.equal(providerRequests[0].sent, false);
		assert.equal(providerRequests[0].disposition, "not_sent");
		assert.equal(
			ledger.reservations.some(
				(row) =>
					row.sent &&
					["completed", "aborted_after_send"].includes(row.disposition),
			),
			false,
		);
		assert.equal(
			new Set(ledger.reservations.map((row) => row.id)).size,
			ledger.reservations.length,
		);
		assert.equal(
			new Set(
				ledger.reservations.map((row) => row.meta.campaignLaunchAttemptId),
			).size,
			1,
		);
		assert.equal(
			ledger.reservations[0].meta.campaignLaunchAttemptId,
			campaignLaunchAttemptId,
		);
		assert.equal(process.env.PI_WORKFLOW_CAMPAIGN_CONTEXT, undefined);
	} finally {
		restoreEnvironment(saved);
		if (run) await cleanupSubagentRun(root, run).catch(() => undefined);
		rmSync(root, { recursive: true, force: true });
	}
});

test("campaign zero-retry posture rejects retry metadata before claim or API call", async () => {
	const saved = saveEnvironment();
	const root = mkdtempSync(join(tmpdir(), "workflow-campaign-retry-"));
	try {
		for (const key of CAMPAIGN_KEYS) delete process.env[key];
		installCampaignEnvironment(root);
		let apiCalls = 0;
		setSubagentApiForTests({
			async runSubagent() {
				apiCalls += 1;
				throw new Error("must not launch");
			},
		});
		for (const retry of [
			{ launchRetry: { attempts: 1 } },
			{ outputRetry: { attempts: 1 } },
			{ launchRetry: { attempts: 0, maxAttempts: 1 } },
			{ outputRetry: { attempts: 0, maxAttempts: 1 } },
		]) {
			const fixture = prepareLaunch(
				root,
				randomBytes(4).toString("hex"),
				retry,
			);
			await assert.rejects(
				launchSubagentTask(
					root,
					fixture.run,
					fixture.task,
					fixture.compiledTask,
				),
				/campaign_retry_forbidden/,
			);
			assert.equal(fixture.task.status, "pending");
			assert.equal(fixture.task.backendHandle, undefined);
		}
		assert.equal(apiCalls, 0);
	} finally {
		setSubagentApiForTests(undefined);
		restoreEnvironment(saved);
		rmSync(root, { recursive: true, force: true });
	}
});

test("ordinary launch does not inject campaign extension or context", async () => {
	const saved = saveEnvironment();
	const root = mkdtempSync(join(tmpdir(), "workflow-campaign-ordinary-"));
	try {
		for (const key of CAMPAIGN_KEYS) delete process.env[key];
		const { run, task, compiledTask } = makeSubagentLaunchFixture(
			root,
			"ordinary",
		);
		let captured;
		setSubagentApiForTests({
			async runSubagent(options) {
				captured = {
					options,
					context: process.env.PI_WORKFLOW_CAMPAIGN_CONTEXT,
				};
				return {
					runId: "ordinary-child",
					attemptId: "ordinary-attempt",
					status: "running",
				};
			},
			async getSubagentStatus() {
				return null;
			},
			async reconcileSubagentRun() {
				return {};
			},
			async interruptSubagent() {
				return {};
			},
		});
		mkdirSync(join(root, ".pi", "workflows"), { recursive: true });
		await writeRunRecord(root, run);
		await launchSubagentTask(root, run, task, compiledTask);
		assert.equal(captured.context, undefined);
		assert.equal(
			captured.options.extensions.some((value) =>
				value.includes("campaign-extension"),
			),
			false,
		);
		await cleanupSubagentRun(root, run);
	} finally {
		setSubagentApiForTests(undefined);
		restoreEnvironment(saved);
		rmSync(root, { recursive: true, force: true });
	}
});

test("distinct campaign launches receive unique wrappers and cannot exchange context", async () => {
	const saved = saveEnvironment();
	const root = mkdtempSync(join(tmpdir(), "workflow-campaign-serial-"));
	try {
		for (const key of CAMPAIGN_KEYS) delete process.env[key];
		installCampaignEnvironment(root);
		const leftRoot = join(root, "left");
		const rightRoot = join(root, "right");
		mkdirSync(leftRoot, { recursive: true });
		mkdirSync(rightRoot, { recursive: true });
		const left = prepareLaunch(leftRoot, "left");
		const right = prepareLaunch(rightRoot, "right");
		const observed = [];
		setSubagentApiForTests({
			async runSubagent(options) {
				assert.equal(process.env.PI_WORKFLOW_CAMPAIGN_CONTEXT, undefined);
				const wrapper = readFileSync(options.extensions[0], "utf8");
				const contextPath = JSON.parse(
					wrapper.match(/const contextPath = (.*);/)[1],
				);
				const context = JSON.parse(readFileSync(contextPath, "utf8"));
				await new Promise((resolveDelay) => setTimeout(resolveDelay, 15));
				assert.equal(process.env.PI_WORKFLOW_CAMPAIGN_CONTEXT, undefined);
				observed.push({
					workflowRunId: context.workflowRunId,
					campaignLaunchAttemptId: context.campaignLaunchAttemptId,
					contextPath,
				});
				return {
					runId: `child-${observed.length}`,
					attemptId: `attempt-${observed.length}`,
					status: "running",
				};
			},
			async getSubagentStatus() {
				return null;
			},
			async reconcileSubagentRun() {
				return {};
			},
			async interruptSubagent() {
				return {};
			},
		});
		await Promise.all([
			writeRunRecord(leftRoot, left.run),
			writeRunRecord(rightRoot, right.run),
		]);
		const firstResults = await Promise.all([
			launchSubagentTask(leftRoot, left.run, left.task, left.compiledTask),
			launchSubagentTask(rightRoot, right.run, right.task, right.compiledTask),
		]);
		assert.equal(observed.length, 1);
		assert.equal(
			firstResults.filter((result) => result.kind === "capacity").length,
			1,
		);
		const launched = left.task.status === "running" ? left : right;
		const deferred = left.task.status === "pending" ? left : right;
		await cleanupSubagentRun(
			launched === left ? leftRoot : rightRoot,
			launched.run,
		);
		await launchSubagentTask(
			deferred === left ? leftRoot : rightRoot,
			deferred.run,
			deferred.task,
			deferred.compiledTask,
		);
		assert.deepEqual(
			new Set(observed.map((row) => row.workflowRunId)),
			new Set([left.run.runId, right.run.runId]),
		);
		assert.equal(
			new Set(observed.map((row) => row.campaignLaunchAttemptId)).size,
			2,
		);
		assert.equal(new Set(observed.map((row) => row.contextPath)).size, 2);
		assert.equal(process.env.PI_WORKFLOW_CAMPAIGN_CONTEXT, undefined);
		await cleanupSubagentRun(
			deferred === left ? leftRoot : rightRoot,
			deferred.run,
		);
	} finally {
		setSubagentApiForTests(undefined);
		restoreEnvironment(saved);
		rmSync(root, { recursive: true, force: true });
	}
});
