import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
	assertWorkflowResourcePolicyMatchesTask,
	resourceInheritanceWarnings,
	resolveWorkflowResourcePolicy,
	WORKFLOW_RESOURCE_POLICY_VERSION,
} from "../../.tmp/unit/resource-inheritance.js";
import {
	canonicalLaunchBootstrapBytes,
	createLaunchBootstrapProvenance,
	recordLaunchBootstrapProvenance,
} from "../../.tmp/unit/launch-bootstrap-provenance.js";
import {
	foreachBatchExecutionSurfaceSha256,
	canonicalJson,
} from "../../.tmp/unit/foreach-batch-runtime.js";
import { workflowTaskSessionId } from "../../.tmp/unit/launch-session.js";
import { flushPendingIndexUpdatesForTests } from "../../.tmp/unit/store.js";
import {
	launchSubagentTask,
	prepareSubagentTaskLaunch,
	setSubagentApiForTests,
	setSubagentLaunchControlsForTests,
} from "../../.tmp/unit/subagent-backend.js";

const ROOT = await mkdtemp(join(tmpdir(), "piwf-resource-inheritance-"));

after(async () => {
	setSubagentApiForTests(undefined);
	setSubagentLaunchControlsForTests({ releaseDelayMs: 0, retryJitterMs: 0 });
	await flushPendingIndexUpdatesForTests();
	await rm(ROOT, { recursive: true, force: true });
});

async function fixture(name, options = {}) {
	const cwd = await mkdtemp(join(ROOT, `${name}-`));
	const now = new Date().toISOString();
	const artifactGraph = {
		enabled: true,
		output: { analysisRequired: true, refsRequired: true },
		requiredReads: [],
		artifactAccess: "none",
	};
	const task = {
		taskId: "task-1",
		specId: `${name}.main`,
		displayName: `${name}.main`,
		agent: "unit-scout",
		agentFile: ".pi/agents/unit-scout.md",
		roles: [],
		status: "pending",
		statusDetail: "pending",
		runtime: {
			model: "unit-model",
			thinking: "high",
			approvalMode: "non-interactive",
		},
		cwd,
		worktree: {
			enabled: false,
			path: null,
			branch: null,
			baseCwd: null,
			warning: null,
		},
		backendTaskId: "",
		artifactGraph: structuredClone(artifactGraph),
		files: {
			systemPrompt: `.pi/workflows/workflow_${name}/tasks/task-1/system.md`,
			taskPrompt: `.pi/workflows/workflow_${name}/tasks/task-1/task.md`,
			output: `.pi/workflows/workflow_${name}/tasks/task-1/output.log`,
			stderr: `.pi/workflows/workflow_${name}/tasks/task-1/stderr.log`,
			result: `.pi/workflows/workflow_${name}/tasks/task-1/result.json`,
		},
	};
	const run = {
		schemaVersion: 1,
		runId: `workflow_${name}`,
		type: "artifact-graph",
		status: "running",
		taskSummary: {
			pending: 1,
			running: 0,
			blocked: 0,
			completed: 0,
			failed: 0,
			skipped: 0,
			interrupted: 0,
			total: 1,
		},
		cwd,
		backend: { type: "local-pi", mode: "headless" },
		createdAt: now,
		updatedAt: now,
		specPath: "workflow.json",
		tasks: [task],
	};
	const compiledTask = {
		id: `${name}.main`,
		specId: `${name}.main`,
		taskId: "task-1",
		agent: "unit-scout",
		agentPath: ".pi/agents/unit-scout.md",
		agentSystemPrompt: "Unit agent system prompt.",
		...(options.resourcePolicyVersion === undefined
			? {}
			: { resourcePolicyVersion: options.resourcePolicyVersion }),
		...(options.inheritSkills === undefined
			? {}
			: { inheritSkills: options.inheritSkills }),
		...(options.inheritProjectContext === undefined
			? {}
			: { inheritProjectContext: options.inheritProjectContext }),
		roleNames: [],
		task: "Do the work.",
		cwd,
		explicitCwd: false,
		explicitWorktreePolicy: false,
		runtime: {
			model: "unit-model",
			thinking: "high",
			fast: "off",
			approvalMode: "non-interactive",
			tools: ["read", "grep"],
		},
		safety: {
			readOnlyDeclared: true,
			capability: "read-only",
			sharedCwdSafe: true,
			worktreePolicy: "off",
			requiresWorktree: false,
			permission: { status: "pending" },
		},
		compiledPrompt: "Unit launch prompt.",
		artifactGraph: structuredClone(artifactGraph),
	};
	return { cwd, run, task, compiledTask };
}

function installFakeApi(captured) {
	setSubagentApiForTests({
		async runSubagent(options) {
			captured.push(structuredClone(options));
			return {
				runId: `fake-run-${captured.length}`,
				attemptId: `fake-attempt-${captured.length}`,
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
	setSubagentLaunchControlsForTests({ releaseDelayMs: 0, retryJitterMs: 0 });
}

async function launchCapture(name, options) {
	const value = await fixture(name, options);
	const captured = [];
	try {
		const prepared = await prepareSubagentTaskLaunch(
			value.cwd,
			value.run,
			value.task,
			value.compiledTask,
		);
		const expectedSessionId = workflowTaskSessionId(value.run, value.task);
		prepared.extensions = ["/required-first.mjs", "/required-second.mjs"];
		installFakeApi(captured);
		const result = await launchSubagentTask(
			value.cwd,
			value.run,
			value.task,
			value.compiledTask,
			undefined,
			undefined,
			prepared,
		);
		assert.equal(result.kind, "launched");
		assert.equal(captured.length, 1);
		return { ...value, prepared, expectedSessionId, options: captured[0] };
	} finally {
		setSubagentApiForTests(undefined);
		setSubagentLaunchControlsForTests({ releaseDelayMs: 0, retryJitterMs: 0 });
	}
}

function legacySurface(task) {
	return {
		kind: task.kind,
		agent: task.agent,
		agentPath: task.agentPath,
		agentSystemPrompt: task.agentSystemPrompt,
		systemPromptMode: task.systemPromptMode,
		inheritProjectContext: task.inheritProjectContext,
		inheritSkills: task.inheritSkills,
		roleNames: task.roleNames,
		cwd: task.cwd,
		explicitCwd: task.explicitCwd,
		explicitWorktreePolicy: task.explicitWorktreePolicy,
		runtime: task.runtime,
		safety: task.safety,
		artifactGraph: task.artifactGraph,
	};
}

function resign(record) {
	const { identitySha256: _identitySha256, ...body } = record;
	return {
		...body,
		identitySha256: createHash("sha256")
			.update(canonicalLaunchBootstrapBytes(body))
			.digest("hex"),
	};
}

test("resolver preserves legacy behavior and emits warning-only raw diagnostics", () => {
	assert.equal(
		resolveWorkflowResourcePolicy({ inheritSkills: false }),
		undefined,
	);
	assert.deepEqual(
		resolveWorkflowResourcePolicy({
			resourcePolicyVersion: WORKFLOW_RESOURCE_POLICY_VERSION,
			inheritSkills: false,
		}),
		{ version: 1, skillDiscovery: "disabled", contextFiles: "disabled" },
	);
	for (const inheritSkills of [undefined, true]) {
		assert.deepEqual(
			resolveWorkflowResourcePolicy({
				resourcePolicyVersion: WORKFLOW_RESOURCE_POLICY_VERSION,
				inheritSkills,
			}),
			{ version: 1, skillDiscovery: "ambient", contextFiles: "disabled" },
		);
	}
	assert.deepEqual(
		resolveWorkflowResourcePolicy({
			resourcePolicyVersion: WORKFLOW_RESOURCE_POLICY_VERSION,
			inheritSkills: "false",
			inheritProjectContext: true,
		}),
		{ version: 1, skillDiscovery: "ambient", contextFiles: "disabled" },
	);
	assert.throws(
		() => resolveWorkflowResourcePolicy({ resourcePolicyVersion: 2 }),
		/unsupported/,
	);
	const warnings = resourceInheritanceWarnings({
		displayName: "unit-agent",
		frontmatter: {
			inheritSkills: "false",
			inheritProjectContext: true,
		},
	});
	assert.equal(warnings.length, 2);
	assert.match(warnings[0], /non-boolean inheritSkills/);
	assert.match(warnings[1], /project context discovery remains disabled/);
	assert.match(
		resourceInheritanceWarnings({
			displayName: "unit-agent",
			frontmatter: { inheritProjectContext: "true" },
		})[0],
		/non-boolean inheritProjectContext/,
	);
});

test("sealed launch applies skills only for current false and preserves tools, extensions, and sessions", async () => {
	const cases = [
		{ name: "legacy-false", resourcePolicyVersion: undefined, inheritSkills: false, skills: undefined },
		{ name: "current-false", resourcePolicyVersion: 1, inheritSkills: false, skills: [] },
		{ name: "current-undefined", resourcePolicyVersion: 1, inheritSkills: undefined, skills: undefined },
		{ name: "current-true", resourcePolicyVersion: 1, inheritSkills: true, skills: undefined },
	];
	for (const item of cases) {
		const launched = await launchCapture(item.name, item);
		assert.deepEqual(launched.options.extensions, [
			"/required-first.mjs",
			"/required-second.mjs",
		]);
		assert.deepEqual(launched.options.tools, ["read", "grep"]);
		assert.equal(launched.options.model, "unit-model");
		assert.equal(launched.options.thinking, "high");
		assert.equal(launched.options.task, "Unit launch prompt.");
		assert.equal(launched.options.sessionId, launched.expectedSessionId);
		assert.equal(Object.hasOwn(launched.options, "noContextFiles"), false);
		if (item.skills === undefined) {
			assert.equal(Object.hasOwn(launched.options, "skills"), false);
		} else {
			assert.deepEqual(launched.options.skills, item.skills);
		}
		assert.equal(
			launched.task.launchBootstrap.records[0].schema,
			item.resourcePolicyVersion === undefined
				? "pi-workflow-launch-bootstrap-provenance-v1"
				: "pi-workflow-launch-bootstrap-provenance-v2",
		);
	}
});

test("prepared policy omission, toggles, and unsupported versions fail before a fake launch", async () => {
	const value = await fixture("prepared-drift", {
		resourcePolicyVersion: 1,
		inheritSkills: false,
	});
	const captured = [];
	try {
		const prepared = await prepareSubagentTaskLaunch(
			value.cwd,
			value.run,
			value.task,
			value.compiledTask,
		);
		installFakeApi(captured);
		await assert.rejects(
			launchSubagentTask(
				value.cwd,
				value.run,
				value.task,
				value.compiledTask,
				undefined,
				undefined,
				{ ...prepared, resourcePolicy: undefined },
			),
			/resource policy drifted/,
		);
		assert.equal(captured.length, 0);

		value.task.status = "pending";
		value.task.backendHandle = undefined;
		await assert.rejects(
			launchSubagentTask(
				value.cwd,
				value.run,
				value.task,
				value.compiledTask,
				undefined,
				undefined,
				{
					...prepared,
					resourcePolicy: {
						version: 1,
						skillDiscovery: "ambient",
						contextFiles: "disabled",
					},
				},
			),
			/resource policy drifted/,
		);
		assert.equal(captured.length, 0);

		const invalid = await fixture("unsupported-version", {
			resourcePolicyVersion: 2,
		});
		await assert.rejects(
			prepareSubagentTaskLaunch(
				invalid.cwd,
				invalid.run,
				invalid.task,
				invalid.compiledTask,
			),
			/unsupported/,
		);
	} finally {
		setSubagentApiForTests(undefined);
		setSubagentLaunchControlsForTests({ releaseDelayMs: 0, retryJitterMs: 0 });
	}
});

test("legacy provenance stays v1 while current records require a closed v2 policy schema", async () => {
	const legacy = await fixture("legacy-provenance", { inheritSkills: false });
	const legacyDefault = await createLaunchBootstrapProvenance(
		legacy.cwd,
		legacy.run,
		legacy.task,
		legacy.compiledTask,
		"pi-subagent/headless",
	);
	const legacyExplicit = await createLaunchBootstrapProvenance(
		legacy.cwd,
		legacy.run,
		legacy.task,
		legacy.compiledTask,
		"pi-subagent/headless",
		{ extensions: [], generatedExtensions: [], captureToolCalls: false },
	);
	assert.equal(legacyDefault.schema, "pi-workflow-launch-bootstrap-provenance-v1");
	assert.equal(Object.hasOwn(legacyDefault, "resourcePolicy"), false);
	assert.deepEqual(
		canonicalLaunchBootstrapBytes(legacyDefault),
		canonicalLaunchBootstrapBytes(legacyExplicit),
	);
	recordLaunchBootstrapProvenance(legacy.task, legacyDefault);
	legacy.task.launchRetry = { attempts: 1 };
	const legacyRetry = await createLaunchBootstrapProvenance(
		legacy.cwd,
		legacy.run,
		legacy.task,
		legacy.compiledTask,
		"pi-subagent/headless",
	);
	assert.equal(legacyRetry.schema, "pi-workflow-launch-bootstrap-provenance-v1");
	recordLaunchBootstrapProvenance(legacy.task, legacyRetry);
	assert.deepEqual(
		legacy.task.launchBootstrap.records.map((record) => record.schema),
		[
			"pi-workflow-launch-bootstrap-provenance-v1",
			"pi-workflow-launch-bootstrap-provenance-v1",
		],
	);
	assert.throws(
		() =>
			recordLaunchBootstrapProvenance(
				structuredClone(legacy.task),
				resign({
					...legacyDefault,
					resourcePolicy: {
						version: 1,
						skillDiscovery: "disabled",
						contextFiles: "disabled",
					},
				}),
			),
		/launch-bootstrap provenance is malformed/,
	);

	const current = await fixture("current-provenance", {
		resourcePolicyVersion: 1,
		inheritSkills: false,
	});
	const prepared = await prepareSubagentTaskLaunch(
		current.cwd,
		current.run,
		current.task,
		current.compiledTask,
	);
	const currentRecord = await createLaunchBootstrapProvenance(
		current.cwd,
		current.run,
		current.task,
		current.compiledTask,
		"pi-subagent/headless",
		prepared,
	);
	assert.equal(currentRecord.schema, "pi-workflow-launch-bootstrap-provenance-v2");
	assert.deepEqual(currentRecord.resourcePolicy, {
		version: 1,
		skillDiscovery: "disabled",
		contextFiles: "disabled",
	});
	for (const malformed of [
		resign((() => {
			const copy = structuredClone(currentRecord);
			delete copy.resourcePolicy;
			return copy;
		})()),
		resign({ ...currentRecord, unexpected: true }),
		resign({
			...currentRecord,
			resourcePolicy: { ...currentRecord.resourcePolicy, unexpected: true },
		}),
		resign({
			...currentRecord,
			resourcePolicy: { ...currentRecord.resourcePolicy, version: 2 },
		}),
	]) {
		assert.throws(
			() => recordLaunchBootstrapProvenance(structuredClone(current.task), malformed),
			/launch-bootstrap provenance is malformed/,
		);
	}
	recordLaunchBootstrapProvenance(current.task, currentRecord);
	const toggled = resign({
		...currentRecord,
		resourcePolicy: {
			...currentRecord.resourcePolicy,
			skillDiscovery: "ambient",
		},
	});
	assert.throws(
		() => recordLaunchBootstrapProvenance(current.task, toggled),
		/launch-bootstrap provenance mismatch/,
	);
	assert.throws(
		() =>
			assertWorkflowResourcePolicyMatchesTask(current.compiledTask, undefined),
		/resource policy drifted/,
	);
});

test("foreach hashes retain exact legacy bytes and bind new resolved policy semantics", async () => {
	const legacy = await fixture("foreach-legacy", { inheritSkills: false });
	const expectedLegacyCanonical = canonicalJson(legacySurface(legacy.compiledTask));
	assert.ok(expectedLegacyCanonical);
	assert.equal(
		foreachBatchExecutionSurfaceSha256(legacy.compiledTask),
		createHash("sha256").update(expectedLegacyCanonical).digest("hex"),
	);

	const disabled = await fixture("foreach-disabled", {
		resourcePolicyVersion: 1,
		inheritSkills: false,
	});
	const ambient = await fixture("foreach-ambient", {
		resourcePolicyVersion: 1,
	});
	const explicitAmbient = await fixture("foreach-explicit-ambient", {
		resourcePolicyVersion: 1,
		inheritSkills: true,
	});
	const disabledHash = foreachBatchExecutionSurfaceSha256(disabled.compiledTask);
	assert.equal(
		disabledHash,
		foreachBatchExecutionSurfaceSha256(structuredClone(disabled.compiledTask)),
	);
	assert.notEqual(disabledHash, foreachBatchExecutionSurfaceSha256(ambient.compiledTask));
	assert.notEqual(
		foreachBatchExecutionSurfaceSha256(ambient.compiledTask),
		foreachBatchExecutionSurfaceSha256(explicitAmbient.compiledTask),
	);
	assert.notEqual(disabledHash, foreachBatchExecutionSurfaceSha256(legacy.compiledTask));
	assert.throws(
		() =>
			foreachBatchExecutionSurfaceSha256({
				...disabled.compiledTask,
				resourcePolicyVersion: 99,
			}),
		/unsupported/,
	);
});
