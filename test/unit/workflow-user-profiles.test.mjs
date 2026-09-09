import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import {
	applyExecutionProfileStageOverrides,
	collectWorkflowProfileStageSlots,
} from "../../.tmp/unit/execution-profile.js";
import { parseArtifactGraphWorkflowSpec } from "../../.tmp/unit/artifact-graph-schema.js";
import { resolveWorkflowExecutionProfileForLaunch } from "../../.tmp/unit/extension.js";
import { loadWorkflowSpec } from "../../.tmp/unit/schema.js";
import {
	WORKFLOW_BUILTIN_PROFILE_IDS,
	buildWorkflowExecutionProfile,
	createCustomProfileFromBuiltin,
	loadWorkflowProfilePreference,
	profileRuntimeForRole,
	resolveSavedWorkflowExecutionProfile,
	saveWorkflowProfilePreference,
	workflowProfileIdentity,
} from "../../.tmp/unit/workflow-profile-settings.js";
import { configureWorkflowExecutionProfile } from "../../.tmp/unit/workflow-profile-ui.js";

const ROOT = mkdtempSync(join(tmpdir(), "pi-workflow-user-profiles-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

after(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	if (process.exitCode) {
		console.error(`workflow user profile test artifacts retained at ${ROOT}`);
		return;
	}
	rmSync(ROOT, { recursive: true, force: true });
});

const SOL = "openai-codex/gpt-5.6-sol";
const LUNA = "openai-codex/gpt-5.6-luna";
const OPUS = "anthropic/claude-opus-4-8";
const OTHER = "local/other";
const MODELS = [
	{
		provider: "openai-codex",
		id: "gpt-5.6-sol",
		fullId: SOL,
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh" },
	},
	{
		provider: "openai-codex",
		id: "gpt-5.6-luna",
		fullId: LUNA,
		reasoning: true,
	},
	{
		provider: "anthropic",
		id: "claude-opus-4-8",
		fullId: OPUS,
		reasoning: true,
	},
	{
		provider: "local",
		id: "other",
		fullId: OTHER,
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh" },
	},
];

function output() {
	return { analysis: { required: true }, refs: { required: true } };
}

function roleSpec(name = "role-profile") {
	return {
		schemaVersion: 1,
		name,
		defaults: { agent: "scout", readOnly: true, tools: ["read"] },
		artifactGraph: {
			stages: [
				stage("plan", "planning"),
				stage("research", "research-execution"),
				stage("synthesize", "synthesis"),
				stage("verify", "verification"),
				stage("judge", "final-judgment"),
			],
		},
	};
}

function stage(id, profileRole) {
	return {
		id,
		type: "single",
		profileRole,
		prompt: id,
		output: output(),
	};
}

function setup(name) {
	const root = join(ROOT, name);
	const agentDir = join(root, "agent-home");
	const workflowPath = join(root, "workflow", "spec.json");
	mkdirSync(dirname(workflowPath), { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;
	return { root, agentDir, workflowPath };
}

function writeSpec(path, spec) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(spec, null, 2)}\n`);
}

function context(spec, specPath, overrides = {}) {
	return {
		spec,
		specPath,
		availableModels: MODELS,
		currentRuntime: { model: OTHER, thinking: "medium" },
		...overrides,
	};
}

class ScriptedUi {
	constructor(script) {
		this.script = [...script];
		this.calls = [];
		this.notifications = [];
	}

	async select(title, options) {
		this.calls.push({ title, options: [...options] });
		const next = this.script.shift();
		return typeof next === "function" ? next(title, options) : next;
	}

	notify(message, level) {
		this.notifications.push({ message, level });
	}
}

test("profileRole validates independently from agent-context role", () => {
	const parsed = parseArtifactGraphWorkflowSpec({
		...roleSpec(),
		artifactGraph: {
			stages: [
				{
					...stage("plan", "planning"),
					role: "existing-agent-context-role",
				},
			],
		},
	});
	assert.equal(parsed.artifactGraph.stages[0].role, "existing-agent-context-role");
	assert.equal(parsed.artifactGraph.stages[0].profileRole, "planning");

	assert.throws(
		() =>
			parseArtifactGraphWorkflowSpec({
				...roleSpec(),
				artifactGraph: {
					stages: [{ ...stage("bad", "stage-name-guess") }],
				},
			}),
		/profileRole.*must be one of/,
	);
	assert.throws(
		() =>
			parseArtifactGraphWorkflowSpec({
				...roleSpec(),
				artifactGraph: {
					stages: [
						{
							id: "container",
							type: "dag",
							profileRole: "planning",
							stages: [stage("child", "research-execution")],
						},
					],
				},
			}),
		/only valid on model-backed/,
	);
	const dynamic = parseArtifactGraphWorkflowSpec({
		...roleSpec(),
		executionProfiles: {
			dynamic: {
				adaptive: { model: "worker/model", thinking: "medium" },
				"adaptive.$planner": { model: "planner/model", thinking: "high" },
			},
		},
		artifactGraph: {
			stages: [
				{
					id: "adaptive",
					type: "dynamic",
					profileRole: "research-execution",
					dynamic: {
						uses: "./helpers/controller.mjs",
						decisionLoop: {
							planner: { profileRole: "planning" },
						},
					},
				},
			],
		},
	});
	assert.equal(
		dynamic.artifactGraph.stages[0].profileRole,
		"research-execution",
	);
	assert.equal(
		dynamic.artifactGraph.stages[0].dynamic.decisionLoop.planner.profileRole,
		"planning",
	);
	assert.equal(dynamic.executionProfiles.dynamic.adaptive.model, "worker/model");
	assert.equal(
		dynamic.executionProfiles.dynamic["adaptive.$planner"].model,
		"planner/model",
	);
});

test("canonical profile slots cover nested dag, loop exhaustion, foreach runtime, and dynamic decision profiles", () => {
	const spec = {
		schemaVersion: 1,
		name: "nested-profile-addresses",
		artifactGraph: {
			stages: [
				{
					id: "outer",
					type: "dag",
					stages: [stage("child", "research-execution")],
				},
				{
					id: "repeat",
					type: "loop",
					stages: [stage("step", "verification")],
					onExhausted: stage("fallback", "final-judgment"),
				},
				{
					id: "items",
					type: "foreach",
					profileRole: "research-execution",
					each: { prompt: "item" },
				},
				{
					id: "adaptive",
					type: "dynamic",
					profileRole: "research-execution",
					dynamic: {
						decisionLoop: {
							planner: { profileRole: "planning" },
							workerDefaults: { profileRole: "research-execution" },
							verifier: { profileRole: "verification" },
							synthesis: { profileRole: "synthesis" },
						},
					},
				},
			],
		},
	};
	assert.deepEqual(
		collectWorkflowProfileStageSlots(spec).map(({ id }) => id),
		[
			"outer.child",
			"repeat.step",
			"repeat.$onExhausted",
			"items",
			"adaptive",
			"adaptive.$planner",
			"adaptive.$workerDefaults",
			"adaptive.$verifier",
			"adaptive.$synthesis",
		],
	);
	const mapping = Object.fromEntries(
		collectWorkflowProfileStageSlots(spec).map(({ id }, index) => [
			id,
			{ model: `model/${index}`, thinking: "high" },
		]),
	);
	const applied = applyExecutionProfileStageOverrides(spec, mapping, {
		foreachRuntimeTarget: "each",
	});
	assert.equal(applied.artifactGraph.stages[0].stages[0].model, "model/0");
	assert.equal(applied.artifactGraph.stages[1].stages[0].model, "model/1");
	assert.equal(applied.artifactGraph.stages[1].onExhausted.model, "model/2");
	assert.equal(applied.artifactGraph.stages[2].each.model, "model/3");
	assert.equal(applied.artifactGraph.stages[3].model, "model/4");
	assert.equal(
		applied.artifactGraph.stages[3].dynamic.decisionLoop.planner.model,
		"model/5",
	);
	assert.equal(
		applied.artifactGraph.stages[3].dynamic.decisionLoop.synthesis.model,
		"model/8",
	);
	assert.equal(spec.artifactGraph.stages[2].each.model, undefined);
});

test("all four built-ins use the approved exact role matrix", () => {
	const { workflowPath } = setup("builtin-matrix");
	const spec = roleSpec();
	writeSpec(workflowPath, spec);
	for (const profileId of WORKFLOW_BUILTIN_PROFILE_IDS) {
		const built = buildWorkflowExecutionProfile(
			context(spec, workflowPath),
			profileId,
		);
		for (const slot of collectWorkflowProfileStageSlots(spec)) {
			assert.deepEqual(
				built.stageOverrides[slot.id],
				profileRuntimeForRole(profileId, slot.profileRole),
				`${profileId}/${slot.profileRole}`,
			);
		}
	}
	assert.deepEqual(profileRuntimeForRole("codex", "planning"), {
		model: SOL,
		thinking: "high",
	});
	assert.deepEqual(profileRuntimeForRole("mixed", "verification"), {
		model: LUNA,
		thinking: "high",
	});
	assert.deepEqual(profileRuntimeForRole("codex-high", "final-judgment"), {
		model: SOL,
		thinking: "xhigh",
	});
});

test("bundled workflows and authoring scaffolds expose complete built-in profile coverage", async () => {
	for (const specPath of [
		"workflows/deep-research/spec.json",
		"workflows/deep-research/tiered-verification.spec.json",
		"workflows/deep-review/spec.json",
		"workflows/spec-review/spec.json",
		"workflows/impact-review/spec.json",
		"skills/workflow-guide/scaffolds/analysis-dossier/spec.json",
		"skills/workflow-guide/scaffolds/dag-required-reads/spec.json",
		"skills/workflow-guide/scaffolds/foreach-reduce/spec.json",
		"skills/workflow-guide/scaffolds/matrix-dag/spec.json",
		"skills/workflow-guide/scaffolds/object-tool-fallback/spec.json",
		"skills/workflow-guide/scaffolds/support-partition/spec.json",
	]) {
		const loaded = await loadWorkflowSpec(specPath, process.cwd());
		const slots = collectWorkflowProfileStageSlots(loaded.spec);
		assert.ok(slots.length > 0, specPath);
		assert.ok(slots.every(({ profileRole }) => profileRole), specPath);
		for (const profileId of WORKFLOW_BUILTIN_PROFILE_IDS) {
			const built = buildWorkflowExecutionProfile(
				context(loaded.spec, loaded.specPath),
				profileId,
			);
			assert.equal(
				Object.keys(built.stageOverrides).filter((id) =>
					slots.some((slot) => slot.id === id),
				).length,
				slots.length,
				`${specPath}/${profileId}`,
			);
			if (specPath === "workflows/deep-research/spec.json") {
				assert.deepEqual(built.stageOverrides["verify-claims"].foreachBatch, {
					maxItems: 2,
					groupBy: ["$.sourceRefs", "$.sourceUrls"],
				});
			}
		}
	}
});

test("missing models, unsupported thinking, and missing roles fail without substitution", () => {
	const { workflowPath } = setup("profile-fail-closed");
	const spec = roleSpec();
	writeSpec(workflowPath, spec);
	assert.throws(
		() =>
			buildWorkflowExecutionProfile(
				context(spec, workflowPath, { availableModels: MODELS.slice(1) }),
				"codex",
			),
		/profile cannot be applied.*model openai-codex\/gpt-5\.6-sol is not available/s,
	);
	assert.doesNotThrow(() =>
		buildWorkflowExecutionProfile(
			context(spec, workflowPath, {
				availableModels: MODELS.slice(1),
				runtimeOverrides: { model: OTHER, thinking: "low" },
			}),
			"codex",
		),
	);
	assert.throws(
		() =>
			buildWorkflowExecutionProfile(
				context(spec, workflowPath, {
					availableModels: MODELS.map((model) =>
						model.fullId === SOL
							? { ...model, thinkingLevelMap: undefined }
							: model,
					),
				}),
				"codex-high",
			),
		/thinking xhigh is not supported.*supported:/s,
	);
	const missingRole = roleSpec();
	delete missingRole.artifactGraph.stages[2].profileRole;
	assert.throws(
		() =>
			buildWorkflowExecutionProfile(
				context(missingRole, workflowPath),
				"mixed",
			),
		/roles are missing.*synthesize/s,
	);
});

test("Custom fixed and inherited values resolve once at run start", () => {
	const { workflowPath } = setup("custom-capture");
	const spec = roleSpec();
	writeSpec(workflowPath, spec);
	const custom = createCustomProfileFromBuiltin(spec, "mixed");
	custom.stages.plan.model = { kind: "inherit" };
	custom.stages.plan.thinking = { kind: "inherit" };
	custom.stages.research.model = { kind: "fixed", value: OTHER };
	custom.stages.research.thinking = { kind: "fixed", value: "low" };
	const currentRuntime = { model: OTHER, thinking: "medium" };
	const built = buildWorkflowExecutionProfile(
		context(spec, workflowPath, { currentRuntime }),
		"custom",
		custom,
	);
	currentRuntime.model = SOL;
	currentRuntime.thinking = "xhigh";
	assert.deepEqual(built.stageOverrides.plan, {
		model: OTHER,
		thinking: "medium",
	});
	assert.deepEqual(built.stageOverrides.research, {
		model: OTHER,
		thinking: "low",
	});
});

test("private atomic preferences reuse identical definitions and separate changed ones", async () => {
	const { root, agentDir, workflowPath } = setup("settings-identity");
	const spec = roleSpec("same-name");
	writeSpec(workflowPath, spec);
	await saveWorkflowProfilePreference(
		{ spec, specPath: workflowPath },
		{ selectedProfile: "mixed" },
	);
	const identity = await workflowProfileIdentity(spec, workflowPath);
	assert.equal(statSync(identity.settingsFile).mode & 0o777, 0o600);
	assert.equal(statSync(dirname(identity.settingsFile)).mode & 0o777, 0o700);
	assert.throws(
		() => statSync(join(dirname(identity.settingsFile), ".settings.lock")),
		/ENOENT/,
	);
	assert.ok(identity.settingsFile.startsWith(agentDir));

	const copiedPath = join(root, "other-project", "spec.json");
	writeSpec(copiedPath, spec);
	const copied = await loadWorkflowProfilePreference(spec, copiedPath);
	assert.equal(copied.preference?.selectedProfile, "mixed");
	await saveWorkflowProfilePreference(
		{ spec, specPath: copiedPath },
		{ selectedProfile: "mixed" },
	);
	assert.equal(
		JSON.parse(readFileSync(identity.settingsFile, "utf8")).sourcePathHashes
			.length,
		2,
	);

	const unrelated = roleSpec("same-name");
	unrelated.artifactGraph.stages.push(stage("new-stage", "verification"));
	const unrelatedPath = join(root, "unrelated", "spec.json");
	writeSpec(unrelatedPath, unrelated);
	const separated = await loadWorkflowProfilePreference(unrelated, unrelatedPath);
	assert.equal(separated.preference, undefined);
	assert.equal(separated.stalePreference, undefined);

	const corruptCandidateFingerprint =
		identity.definitionFingerprint === "f".repeat(64)
			? "e".repeat(64)
			: "f".repeat(64);
	const corruptCandidate = join(
		dirname(identity.settingsFile),
		`${corruptCandidateFingerprint}.json`,
	);
	writeFileSync(corruptCandidate, "{ broken stale candidate");
	await assert.rejects(
		() => loadWorkflowProfilePreference(unrelated, unrelatedPath),
		/unreadable or invalid.*file was not changed/s,
	);
	rmSync(corruptCandidate);

	writeSpec(copiedPath, unrelated);
	const copiedStale = await loadWorkflowProfilePreference(unrelated, copiedPath);
	assert.equal(copiedStale.stalePreference?.selectedProfile, "mixed");

	writeSpec(workflowPath, unrelated);
	const stale = await loadWorkflowProfilePreference(unrelated, workflowPath);
	assert.equal(stale.preference, undefined);
	assert.equal(stale.stalePreference?.selectedProfile, "mixed");
	await assert.rejects(
		() =>
			resolveSavedWorkflowExecutionProfile(
				context(unrelated, workflowPath),
			),
		/older definition.*added: new-stage.*not changed or migrated/s,
	);
});

test("Custom settings preserve stage ids that overlap object prototype names", async () => {
	const { workflowPath } = setup("settings-prototype-stage-id");
	const spec = roleSpec("prototype-stage-id");
	spec.artifactGraph.stages = [
		stage("__proto__", "planning"),
		stage("other", "verification"),
	];
	spec.executionProfiles = { partial: { other: { thinking: "low" } } };
	spec.defaultExecutionProfile = "partial";
	writeSpec(workflowPath, spec);
	const custom = createCustomProfileFromBuiltin(spec, "codex");
	await saveWorkflowProfilePreference(
		{ spec, specPath: workflowPath },
		{ selectedProfile: "custom", custom },
	);
	const loaded = await loadWorkflowProfilePreference(spec, workflowPath);
	assert.ok(Object.hasOwn(loaded.preference.custom.stages, "__proto__"));
	const built = buildWorkflowExecutionProfile(
		context(spec, workflowPath),
		"custom",
		loaded.preference.custom,
	);
	assert.ok(Object.hasOwn(built.stageOverrides, "__proto__"));
	assert.equal(built.stageOverrides.__proto__.model, SOL);
	assert.equal(built.stageOverrides.other.thinking, "high");
});

test("invalid, corrupt, and simultaneous writes preserve complete unrelated settings", async () => {
	const { agentDir, workflowPath } = setup("settings-failures");
	const spec = roleSpec();
	writeSpec(workflowPath, spec);
	await saveWorkflowProfilePreference(
		{ spec, specPath: workflowPath },
		{ selectedProfile: "codex" },
	);
	const identity = await workflowProfileIdentity(spec, workflowPath);
	const before = readFileSync(identity.settingsFile, "utf8");
	await assert.rejects(
		() =>
			saveWorkflowProfilePreference(
				{ spec, specPath: workflowPath },
				{
					selectedProfile: "custom",
					custom: { baseProfile: "current", stages: {} },
				},
			),
		/Custom workflow profile stage settings do not match/,
	);
	assert.equal(readFileSync(identity.settingsFile, "utf8"), before);
	const malformedCustom = createCustomProfileFromBuiltin(spec, "codex");
	malformedCustom.stages.plan.model = {
		kind: "inherit",
		unexpected: true,
	};
	await assert.rejects(
		() =>
			saveWorkflowProfilePreference(
				{ spec, specPath: workflowPath },
				{ selectedProfile: "custom", custom: malformedCustom },
			),
		/unknown field unexpected/,
	);
	assert.equal(readFileSync(identity.settingsFile, "utf8"), before);

	const unrelatedFile = join(agentDir, "unrelated.json");
	writeFileSync(unrelatedFile, "keep-me\n");
	const concurrentCustom = createCustomProfileFromBuiltin(spec, "claude");
	concurrentCustom.stages.plan.model = { kind: "fixed", value: OTHER };
	await Promise.all([
		saveWorkflowProfilePreference(
			{ spec, specPath: workflowPath },
			{ selectedProfile: "custom", custom: concurrentCustom },
		),
		saveWorkflowProfilePreference(
			{ spec, specPath: workflowPath },
			{ selectedProfile: "mixed" },
		),
	]);
	const complete = JSON.parse(readFileSync(identity.settingsFile, "utf8"));
	assert.ok(["custom", "mixed"].includes(complete.selectedProfile));
	assert.equal(complete.stages.length, 5);
	assert.equal(complete.custom.stages.plan.model.value, OTHER);
	assert.equal(readFileSync(unrelatedFile, "utf8"), "keep-me\n");

	const mismatched = structuredClone(complete);
	mismatched.stages[0].profileRole = "verification";
	writeFileSync(identity.settingsFile, JSON.stringify(mismatched));
	const mismatchedBytes = readFileSync(identity.settingsFile, "utf8");
	await assert.rejects(
		() => loadWorkflowProfilePreference(spec, workflowPath),
		/settings are corrupt.*stage metadata does not match.*file was not changed/s,
	);
	await assert.rejects(
		() =>
			saveWorkflowProfilePreference(
				{ spec, specPath: workflowPath },
				{ selectedProfile: "mixed" },
			),
		/settings are corrupt.*file was not changed/s,
	);
	assert.equal(readFileSync(identity.settingsFile, "utf8"), mismatchedBytes);

	const unknownField = { ...complete, unexpected: true };
	writeFileSync(identity.settingsFile, JSON.stringify(unknownField));
	const unknownBytes = readFileSync(identity.settingsFile, "utf8");
	await assert.rejects(
		() => loadWorkflowProfilePreference(spec, workflowPath),
		/unknown field unexpected.*file was not changed/s,
	);
	assert.equal(readFileSync(identity.settingsFile, "utf8"), unknownBytes);

	const wrongFingerprint =
		identity.definitionFingerprint === "0".repeat(64)
			? "1".repeat(64)
			: "0".repeat(64);
	writeFileSync(
		identity.settingsFile,
		JSON.stringify({ ...complete, definitionFingerprint: wrongFingerprint }),
	);
	await assert.rejects(
		() => loadWorkflowProfilePreference(spec, workflowPath),
		/definitionFingerprint does not match the settings filename.*file was not changed/s,
	);

	writeFileSync(identity.settingsFile, Buffer.from([0xff]));
	await assert.rejects(
		() => loadWorkflowProfilePreference(spec, workflowPath),
		/unreadable or invalid.*utf-8.*file was not changed/s,
	);

	writeFileSync(identity.settingsFile, "x".repeat(1_048_577));
	await assert.rejects(
		() => loadWorkflowProfilePreference(spec, workflowPath),
		/exceeds size limit.*file was not changed/s,
	);
	rmSync(identity.settingsFile);
	mkdirSync(identity.settingsFile);
	await assert.rejects(
		() => loadWorkflowProfilePreference(spec, workflowPath),
		/not a stable regular file.*file was not changed/s,
	);
	rmSync(identity.settingsFile, { recursive: true });
	symlinkSync(unrelatedFile, identity.settingsFile);
	await assert.rejects(
		() => loadWorkflowProfilePreference(spec, workflowPath),
		/ELOOP|symbolic|too many symbolic links/i,
	);
	assert.equal(readFileSync(unrelatedFile, "utf8"), "keep-me\n");
	rmSync(identity.settingsFile);

	writeFileSync(identity.settingsFile, "{ definitely broken");
	const corruptBytes = readFileSync(identity.settingsFile, "utf8");
	await assert.rejects(
		() => loadWorkflowProfilePreference(spec, workflowPath),
		/unreadable or invalid.*file was not changed/s,
	);
	assert.deepEqual(
		await resolveWorkflowExecutionProfileForLaunch(
			workflowPath,
			dirname(workflowPath),
			"declared-recovery",
		),
		{ executionProfile: "declared-recovery" },
	);
	assert.equal(readFileSync(identity.settingsFile, "utf8"), corruptBytes);
});

test("unsafe settings lock evidence is rejected and never reclaimed", async () => {
	const { workflowPath } = setup("unsafe-settings-lock");
	const spec = roleSpec();
	writeSpec(workflowPath, spec);
	await saveWorkflowProfilePreference(
		{ spec, specPath: workflowPath },
		{ selectedProfile: "codex" },
	);
	const identity = await workflowProfileIdentity(spec, workflowPath);
	const target = join(ROOT, "unsafe-settings-lock-target");
	writeFileSync(target, "owner-unknown\n");
	const lockFile = join(dirname(identity.settingsFile), ".settings.lock");
	symlinkSync(target, lockFile);
	await assert.rejects(
		() =>
			saveWorkflowProfilePreference(
				{ spec, specPath: workflowPath },
				{ selectedProfile: "mixed" },
			),
		/Unsafe workflow profile settings lock/,
	);
	assert.ok(readdirSync(dirname(identity.settingsFile)).includes(".settings.lock"));
	assert.equal(readFileSync(target, "utf8"), "owner-unknown\n");
});

test("preference reads and writes reject a symlinked settings ancestor", async () => {
	const { agentDir, workflowPath } = setup("unsafe-settings-root");
	const spec = roleSpec();
	writeSpec(workflowPath, spec);
	const outside = join(ROOT, "unsafe-settings-outside");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(outside, { recursive: true });
	symlinkSync(outside, join(agentDir, "workflow-profiles"), "dir");
	await assert.rejects(
		() => loadWorkflowProfilePreference(spec, workflowPath),
		/not a directory|must not be a symlink/,
	);
	await assert.rejects(
		() =>
			saveWorkflowProfilePreference(
				{ spec, specPath: workflowPath },
				{ selectedProfile: "codex" },
			),
		/not a directory|must not be a symlink/,
	);
	assert.deepEqual(readdirSync(outside), []);
});

test("profile picker exposes five choices and cancel performs no write", async () => {
	const { agentDir, workflowPath } = setup("ui-cancel");
	const spec = roleSpec();
	writeSpec(workflowPath, spec);
	const ui = new ScriptedUi([undefined]);
	const result = await configureWorkflowExecutionProfile({
		ui,
		...context(spec, workflowPath),
	});
	assert.equal(result.status, "cancelled");
	assert.equal(ui.calls[0].options.length, 5);
	assert.deepEqual(
		ui.calls[0].options.map((label) => label.split(" ")[0]),
		["Codex", "Codex", "Claude", "Mixed", "Custom"],
	);
	assert.throws(() => statSync(agentDir), /ENOENT/);
});

test("stage previews page through bounded rows without writing settings", async () => {
	const { agentDir, workflowPath } = setup("ui-preview-pages");
	const spec = roleSpec();
	for (const [id, profileRole] of [
		["extra-plan", "planning"],
		["extra-research", "research-execution"],
		["extra-final", "final-judgment"],
	]) {
		spec.artifactGraph.stages.push(stage(id, profileRole));
	}
	writeSpec(workflowPath, spec);
	const ui = new ScriptedUi([
		"Codex",
		"Next preview page",
		"Back to profiles",
		undefined,
	]);
	const result = await configureWorkflowExecutionProfile({
		ui,
		...context(spec, workflowPath),
	});
	assert.equal(result.status, "cancelled");
	const previews = ui.calls.filter(({ title }) =>
		title.startsWith("Codex — stage preview"),
	);
	assert.match(previews[0].title, /\(1\/2\)/);
	assert.match(previews[1].title, /\(2\/2\)/);
	assert.throws(() => statSync(agentDir), /ENOENT/);
});

test("Custom starts from the browsed profile and an existing draft survives builtin browsing", async () => {
	const first = setup("ui-custom-seed");
	const spec = roleSpec();
	writeSpec(first.workflowPath, spec);
	const seededUi = new ScriptedUi([
		"Claude",
		"Back to profiles",
		"Custom",
		undefined,
	]);
	await configureWorkflowExecutionProfile({
		ui: seededUi,
		...context(spec, first.workflowPath),
	});
	const customPreview = seededUi.calls.find(({ title }) =>
		title.startsWith("Custom — stage preview"),
	);
	assert.match(customPreview.title, new RegExp(OPUS));
	const seededProfileCalls = seededUi.calls.filter(({ title }) =>
		title.startsWith("Workflow execution profile"),
	);
	assert.equal(seededProfileCalls[1].options[0], "Claude");

	const second = setup("ui-custom-restore");
	writeSpec(second.workflowPath, spec);
	const custom = createCustomProfileFromBuiltin(spec, "mixed");
	custom.stages.plan.model = { kind: "fixed", value: OTHER };
	custom.stages.plan.thinking = { kind: "fixed", value: "low" };
	await saveWorkflowProfilePreference(
		{ spec, specPath: second.workflowPath },
		{ selectedProfile: "custom", custom },
	);
	const restoredUi = new ScriptedUi([
		"Codex",
		"Back to profiles",
		"Custom (saved)",
		undefined,
	]);
	await configureWorkflowExecutionProfile({
		ui: restoredUi,
		...context(spec, second.workflowPath),
	});
	assert.equal(restoredUi.calls[0].options[0], "Custom (saved)");
	const restoredPreview = restoredUi.calls.find(({ title }) =>
		title.startsWith("Custom — stage preview"),
	);
	assert.match(restoredPreview.title, new RegExp(OTHER));
});

test("saving a built-in keeps the latest persisted Custom draft", async () => {
	const { workflowPath } = setup("ui-builtin-preserves-custom");
	const spec = roleSpec();
	writeSpec(workflowPath, spec);
	const custom = createCustomProfileFromBuiltin(spec, "mixed");
	custom.stages.plan.model = { kind: "fixed", value: OTHER };
	await saveWorkflowProfilePreference(
		{ spec, specPath: workflowPath },
		{ selectedProfile: "custom", custom },
	);
	await configureWorkflowExecutionProfile({
		ui: new ScriptedUi(["Codex", "Save for next run"]),
		...context(spec, workflowPath),
	});
	const loaded = await loadWorkflowProfilePreference(spec, workflowPath);
	assert.equal(loaded.preference.selectedProfile, "codex");
	assert.equal(loaded.preference.custom.stages.plan.model.value, OTHER);
});

test("stage-edit cancellation restores the draft and saving applies only on confirmation", async () => {
	const cancelled = setup("ui-edit-cancel");
	const spec = roleSpec();
	writeSpec(cancelled.workflowPath, spec);
	const cancelledUi = new ScriptedUi([
		"Codex",
		"Back to profiles",
		"Custom",
		"Edit a stage…",
		"plan — planning",
		"Model only",
		undefined,
		undefined,
	]);
	const cancelledResult = await configureWorkflowExecutionProfile({
		ui: cancelledUi,
		...context(spec, cancelled.workflowPath),
	});
	assert.equal(cancelledResult.status, "cancelled");
	const absent = await loadWorkflowProfilePreference(spec, cancelled.workflowPath);
	assert.equal(absent.preference, undefined);

	const saved = setup("ui-save");
	writeSpec(saved.workflowPath, spec);
	const savedUi = new ScriptedUi([
		"Codex",
		"Back to profiles",
		"Custom",
		"Edit a stage…",
		"plan — planning",
		"Model and thinking",
		OTHER,
		"low",
		"Save for next run",
	]);
	const savedResult = await configureWorkflowExecutionProfile({
		ui: savedUi,
		...context(spec, saved.workflowPath),
	});
	assert.equal(savedResult.status, "saved");
	assert.equal(savedResult.preference.selectedProfile, "custom");
	assert.deepEqual(savedResult.preference.custom.stages.plan, {
		model: { kind: "fixed", value: OTHER },
		thinking: { kind: "fixed", value: "low" },
	});
});

test("launch precedence is explicit, then saved, then the legacy declared selector", async () => {
	const { workflowPath } = setup("launch-precedence");
	const spec = roleSpec();
	writeSpec(workflowPath, spec);
	let selected = 0;
	const explicit = await resolveWorkflowExecutionProfileForLaunch(
		workflowPath,
		dirname(workflowPath),
		"declared-fast",
		{
			select: async () => {
				selected += 1;
				return undefined;
			},
		},
	);
	assert.deepEqual(explicit, { executionProfile: "declared-fast" });
	assert.equal(selected, 0);

	await saveWorkflowProfilePreference(
		{ spec, specPath: workflowPath },
		{ selectedProfile: "claude" },
	);
	const loadedWorkflow = { spec, specPath: workflowPath };
	const saved = await resolveWorkflowExecutionProfileForLaunch(
		workflowPath,
		dirname(workflowPath),
		undefined,
		{
			loadedWorkflow,
			availableModels: MODELS,
			currentRuntime: { model: OTHER, thinking: "medium" },
			select: async () => {
				selected += 1;
				return undefined;
			},
		},
	);
	assert.equal(saved.executionProfileOverride.name, "Claude");
	assert.equal(saved.executionProfile, undefined);
	assert.equal(selected, 0);

	const resolved = await resolveSavedWorkflowExecutionProfile(
		context(spec, workflowPath),
	);
	assert.equal(
		resolved.definitionFingerprint,
		(await workflowProfileIdentity(spec, workflowPath)).definitionFingerprint,
	);
	assert.deepEqual(saved.executionProfileOverride, resolved);
});
