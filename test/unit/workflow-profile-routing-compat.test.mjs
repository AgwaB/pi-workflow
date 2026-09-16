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
const SOL = "openai-codex/gpt-5.6-sol";
const MODELS = [{ provider: "openai-codex", id: "gpt-5.6-sol", fullId: SOL, reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } }];
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

test("pre-routing saved profile survives routing add/edit/remove without writes; launch capture stays exact", async () => {
	const context = fixture();
	await saveWorkflowProfilePreference(context, { selectedProfile: "codex-high" });
	const identity = await workflowProfileIdentity(context.spec, context.specPath);
	assert.equal(identity.definitionFingerprint, workflowDefinitionFingerprint(context.spec));
	const bytes = readFileSync(identity.settingsFile);
	const names = readdirSync(dirname(identity.settingsFile));
	for (const routing of [ROUTING, { ...ROUTING, useWhen: ["Different comparison hint."] }, undefined]) {
		const spec = { ...context.spec, ...(routing ? { routing } : {}) };
		const loaded = await loadWorkflowProfilePreference(spec, context.specPath);
		assert.equal(loaded.identity.settingsFile, identity.settingsFile);
		assert.equal(loaded.stalePreference, undefined);
		assert.equal(loaded.preference.selectedProfile, "codex-high");
		const captured = await resolveSavedWorkflowExecutionProfile({ ...context, spec });
		assert.equal(captured.definitionFingerprint, workflowDefinitionFingerprint(spec));
		assert.equal(captured.stageOverrides.plan.model, SOL);
		assert.equal(captured.stageOverrides.plan.thinking, "xhigh");
		if (routing) assert.notEqual(captured.definitionFingerprint, identity.definitionFingerprint);
	}
	assert.deepEqual(readFileSync(identity.settingsFile), bytes);
	assert.deepEqual(readdirSync(dirname(identity.settingsFile)), names);
});

test("new saved profiles share identity across routing edits and retain exact Custom assignments", async () => {
	const context = fixture();
	context.spec.routing = ROUTING;
	const custom = createCustomProfileFromBuiltin(context.spec, "codex-high");
	custom.stages.review.thinking = { kind: "fixed", value: "medium" };
	await saveWorkflowProfilePreference(context, { selectedProfile: "custom", custom });
	const current = await workflowProfileIdentity(context.spec, context.specPath);
	context.spec.routing = { ...ROUTING, outputs: ["Updated comparison wording."] };
	const loaded = await loadWorkflowProfilePreference(context.spec, context.specPath);
	assert.equal(loaded.identity.settingsFile, current.settingsFile);
	assert.deepEqual(JSON.parse(JSON.stringify(loaded.preference.custom)), custom);
	const captured = await resolveSavedWorkflowExecutionProfile(context);
	assert.equal(captured.stageOverrides.review.thinking, "medium");
	assert.equal(captured.definitionFingerprint, workflowDefinitionFingerprint(context.spec));
});

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

test("legacy full-definition settings remain readable and an explicit save preserves the Custom draft", async () => {
	const context = fixture();
	context.spec.routing = ROUTING;
	const custom = createCustomProfileFromBuiltin(context.spec, "codex-high");
	custom.stages.review.thinking = { kind: "fixed", value: "low" };
	const legacyPath = await writeLegacyPreference(context, "custom", custom);
	const bytes = readFileSync(legacyPath);
	const loaded = await loadWorkflowProfilePreference(context.spec, context.specPath);
	assert.equal(loaded.preference.selectedProfile, "custom");
	assert.equal(loaded.preference.definitionFingerprint, loaded.identity.definitionFingerprint);
	assert.notEqual(loaded.identity.settingsFile, legacyPath);
	assert.deepEqual(readdirSync(dirname(legacyPath)), [legacyPath.split("/").at(-1)]);
	assert.equal((await resolveSavedWorkflowExecutionProfile(context)).stageOverrides.review.thinking, "low");
	await saveWorkflowProfilePreference(context, { selectedProfile: "codex-high" });
	const saved = await loadWorkflowProfilePreference(context.spec, context.specPath);
	assert.equal(saved.preference.selectedProfile, "codex-high");
	assert.deepEqual(JSON.parse(JSON.stringify(saved.preference.custom)), custom);
	assert.deepEqual(readFileSync(legacyPath), bytes);
});

test("the latest provably compatible choice wins over an older pre-routing setting", async () => {
	const context = fixture();
	await saveWorkflowProfilePreference(context, { selectedProfile: "codex" });
	const canonical = (await workflowProfileIdentity(context.spec, context.specPath)).settingsFile;
	const old = JSON.parse(readFileSync(canonical, "utf8"));
	old.updatedAt = "2025-01-01T00:00:00.000Z";
	writeFileSync(canonical, JSON.stringify(old));
	context.spec.routing = ROUTING;
	const legacy = await writeLegacyPreference(context);
	const before = readFileSync(legacy);
	assert.equal((await loadWorkflowProfilePreference(context.spec, context.specPath)).preference.selectedProfile, "codex-high");
	await saveWorkflowProfilePreference(context, { selectedProfile: "mixed" });
	assert.equal((await loadWorkflowProfilePreference(context.spec, context.specPath)).preference.selectedProfile, "mixed");
	assert.deepEqual(readFileSync(legacy), before);
});

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

test("concurrent explicit saves receive commit-ordered timestamps under the settings lock", async (t) => {
	const context = fixture();
	t.mock.timers.enable({
		apis: ["Date"],
		now: Date.parse("2030-01-01T00:00:00.000Z"),
	});
	const saves = await Promise.all([
		saveWorkflowProfilePreference(context, { selectedProfile: "codex" }),
		saveWorkflowProfilePreference(context, { selectedProfile: "codex-high" }),
	]);
	assert.notEqual(saves[0].updatedAt, saves[1].updatedAt);
	const committedLast =
		saves[0].updatedAt > saves[1].updatedAt ? saves[0] : saves[1];
	const loaded = await loadWorkflowProfilePreference(
		context.spec,
		context.specPath,
	);
	assert.equal(loaded.preference.updatedAt, committedLast.updatedAt);
	assert.equal(loaded.preference.selectedProfile, committedLast.selectedProfile);
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

test("a corrupt legacy exact file is not silently bypassed by the normalized identity", async () => {
	const context = fixture();
	await saveWorkflowProfilePreference(context, { selectedProfile: "codex" });
	context.spec.routing = ROUTING;
	const legacy = await writeLegacyPreference(context);
	const corrupt = JSON.parse(readFileSync(legacy, "utf8"));
	corrupt.definitionFingerprint = "a".repeat(64);
	writeFileSync(legacy, JSON.stringify(corrupt));
	await assert.rejects(
		loadWorkflowProfilePreference(context.spec, context.specPath),
		/definitionFingerprint does not match the settings filename/,
	);
});
