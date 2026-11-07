import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { collectWorkflowProfileStageSlots, workflowDefinitionFingerprint } from "../../.tmp/unit/execution-profile.js";
import {
	createCustomProfileFromBuiltin,
	loadWorkflowProfilePreference,
	resolveSavedWorkflowExecutionProfile,
	saveWorkflowProfilePreference,
	workflowProfileIdentity,
} from "../../.tmp/unit/workflow-profile-settings.js";

const ROOT = mkdtempSync(join(tmpdir(), "piwf-profile-routing-"));
const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
after(() => {
	if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
	rmSync(ROOT, { recursive: true, force: true });
});
const SOL = "openai-codex/gpt-6.1-sol";
const MODELS = [{ provider: "openai-codex", id: "gpt-6.1-sol", fullId: SOL, reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } }];
const ROUTING = { useWhen: ["Review code."], avoidWhen: ["Implement a patch."], outputs: ["Review report."] };
const MAX_ISO_TIMESTAMP = "9999-12-31T23:59:59.999Z";

function fixture() {
	const root = mkdtempSync(join(ROOT, "case-"));
	process.env.PI_CODING_AGENT_DIR = join(root, "agent-home");
	const spec = {
		schemaVersion: 1,
		name: "review",
		defaults: { agent: "scout", readOnly: true, tools: ["read"] },
		artifactGraph: { stages: [
			{ id: "plan", type: "single", profileRole: "planning", prompt: "Plan the review." },
			{ id: "review", type: "single", profileRole: "verification", prompt: "Review the evidence." },
		] },
	};
	const specPath = join(root, "spec.json");
	writeFileSync(specPath, JSON.stringify(spec));
	return { spec, specPath, availableModels: MODELS, currentRuntime: { model: SOL, thinking: "high" } };
}

async function writeLegacyPreference(
	context,
	selectedProfile = "codex-high",
	custom,
	updatedAt = "2026-01-01T00:00:00.000Z",
) {
	const identity = await workflowProfileIdentity(context.spec, context.specPath);
	const fingerprint = workflowDefinitionFingerprint(context.spec);
	const path = join(dirname(identity.settingsFile), `${fingerprint}.json`);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(
		path,
		JSON.stringify({
			schemaVersion: 1,
			definitionFingerprint: fingerprint,
			workflowName: context.spec.name,
			sourcePathHashes: [identity.sourcePathHash],
			selectedProfile,
			stages: collectWorkflowProfileStageSlots(context.spec).map(
				({ id, profileRole }) => ({ id, profileRole }),
			),
			...(custom ? { custom } : {}),
			updatedAt,
		}),
		{ mode: 0o600 },
	);
	return path;
}



for (const [name, change] of [
	["prompt", (spec) => { spec.artifactGraph.stages[0].prompt = "Changed task."; }],
	["agent", (spec) => { spec.defaults.agent = "other-agent"; }],
	["tools", (spec) => { spec.defaults.tools = ["read", "bash"]; }],
	["write posture", (spec) => { spec.defaults.readOnly = false; }],
	["approval", (spec) => { spec.defaults.approvalMode = "required"; }],
	["model", (spec) => { spec.defaults.model = "other/model"; }],
	["thinking", (spec) => { spec.defaults.thinking = "medium"; }],
	["profile role", (spec) => { spec.artifactGraph.stages[0].profileRole = "synthesis"; }],
	["stage", (spec) => { spec.artifactGraph.stages.push({ id: "extra", type: "single", profileRole: "verification", prompt: "Extra work." }); }],
	["helper", (spec) => { spec.artifactGraph.stages.push({ id: "prepare", type: "support", uses: "./helpers/prepare.mjs" }); }],
	["output contract", (spec) => { spec.artifactGraph.stages[0].output = { analysis: { required: true } }; }],
]) {
	test(`routing compatibility still rejects an execution definition change: ${name}`, async () => {
		const context = fixture();
		context.spec.routing = ROUTING;
		await saveWorkflowProfilePreference(context, { selectedProfile: "codex-high" });
		const identity = await workflowProfileIdentity(context.spec, context.specPath);
		const bytes = readFileSync(identity.settingsFile);
		const changed = structuredClone(context.spec);
		change(changed);
		const loaded = await loadWorkflowProfilePreference(changed, context.specPath);
		assert.equal(loaded.preference, undefined);
		assert.ok(loaded.stalePreference);
		await assert.rejects(resolveSavedWorkflowExecutionProfile({ ...context, spec: changed }), /older definition/);
		assert.deepEqual(readFileSync(identity.settingsFile), bytes);
	});
}



test("future legacy clocks cannot override sequential explicit saves on reload or launch", async () => {
	const context = fixture();
	context.spec.routing = ROUTING;
	const future = "2099-06-01T00:00:00.000Z";
	const legacy = await writeLegacyPreference(
		context,
		"mixed",
		undefined,
		future,
	);
	const before = readFileSync(legacy);
	const first = await saveWorkflowProfilePreference(context, {
		selectedProfile: "codex",
	});
	const second = await saveWorkflowProfilePreference(context, {
		selectedProfile: "codex-high",
	});
	assert.ok(first.updatedAt > future);
	assert.ok(second.updatedAt > first.updatedAt);
	assert.equal(
		(await loadWorkflowProfilePreference(context.spec, context.specPath))
			.preference.selectedProfile,
		"codex-high",
	);
	const captured = await resolveSavedWorkflowExecutionProfile(context);
	assert.equal(captured.stageOverrides.plan.model, SOL);
	assert.equal(captured.stageOverrides.plan.thinking, "xhigh");
	assert.equal(
		captured.definitionFingerprint,
		workflowDefinitionFingerprint(context.spec),
	);
	assert.deepEqual(readFileSync(legacy), before);
});

test("clock rollback cannot reverse explicit save order", async (t) => {
	const context = fixture();
	context.spec.routing = ROUTING;
	t.mock.timers.enable({
		apis: ["Date"],
		now: Date.parse("2030-01-01T00:00:00.000Z"),
	});
	const first = await saveWorkflowProfilePreference(context, {
		selectedProfile: "codex",
	});
	t.mock.timers.setTime(Date.parse("2020-01-01T00:00:00.000Z"));
	const second = await saveWorkflowProfilePreference(context, {
		selectedProfile: "codex-high",
	});
	assert.ok(second.updatedAt > first.updatedAt);
	assert.equal(
		(await loadWorkflowProfilePreference(context.spec, context.specPath))
			.preference.selectedProfile,
		"codex-high",
	);
});


test("an explicit save wins at the maximum canonical ISO timestamp without overflow", async () => {
	const context = fixture();
	context.spec.routing = ROUTING;
	const legacy = await writeLegacyPreference(
		context,
		"mixed",
		undefined,
		MAX_ISO_TIMESTAMP,
	);
	const before = readFileSync(legacy);
	const first = await saveWorkflowProfilePreference(context, {
		selectedProfile: "codex",
	});
	const second = await saveWorkflowProfilePreference(context, {
		selectedProfile: "codex-high",
	});
	assert.equal(first.updatedAt, MAX_ISO_TIMESTAMP);
	assert.equal(second.updatedAt, MAX_ISO_TIMESTAMP);
	assert.equal(
		(await loadWorkflowProfilePreference(context.spec, context.specPath))
			.preference.selectedProfile,
		"codex-high",
	);
	assert.equal(
		(await resolveSavedWorkflowExecutionProfile(context)).stageOverrides.plan
			.thinking,
		"xhigh",
	);
	assert.deepEqual(readFileSync(legacy), before);
});

test("legacy full hashes that cannot prove compatibility remain stale even with identical stage roles", async () => {
	const context = fixture();
	context.spec.routing = ROUTING;
	const legacy = await writeLegacyPreference(context);
	const bytes = readFileSync(legacy);
	context.spec.routing = { ...ROUTING, outputs: ["Changed old routing text."] };
	await assert.rejects(resolveSavedWorkflowExecutionProfile(context), /older definition/);
	assert.deepEqual(readFileSync(legacy), bytes);
});
