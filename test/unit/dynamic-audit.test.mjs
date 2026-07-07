import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
	auditDynamicClaimSupport,
	formatDynamicAuditSummary,
} from "../../.tmp/unit/dynamic-audit.js";
import { buildDynamicGeneratedCompiledTask } from "../../.tmp/unit/dynamic-generated-task-runtime.js";
import { dynamicSynthesisHandoffPrompt } from "../../.tmp/unit/dynamic-loop-prompts.js";
import { compileWorkflow } from "../../.tmp/unit/compiler.js";
import { formatRun, scheduleRun } from "../../.tmp/unit/engine.js";
import {
	createWorkflowRunRecord,
	readRunRecord,
	setTaskTerminal,
	writeRunRecord,
	writeStaticRunArtifacts,
} from "../../.tmp/unit/store.js";
import { setSubagentApiForTests } from "../../.tmp/unit/subagent-backend.js";
import { writeWorkflowTaskArtifactBundle } from "../../.tmp/unit/workflow-output-artifacts.js";

test("auditDynamicClaimSupport counts sourced claims via URL and ref-id joins", () => {
	const audit = auditDynamicClaimSupport({
		synthesis: [
			{
				taskId: "adaptive.synthesis",
				control: {
					schema: "stage-control-v1",
					claims: [
						{
							id: "c-url",
							text: "URL-backed claim",
							sourceUrls: ["https://example.com/evidence"],
						},
						{
							id: "c-ref",
							text: "artifact-backed claim",
							sourceRefs: [{ taskId: "adaptive.research" }],
						},
					],
				},
			},
		],
		collected: [
			{
				taskId: "task-2",
				specId: "adaptive.research",
				refs: [
					"https://example.com/evidence",
					{ url: "https://example.com/other#fragment" },
				],
			},
		],
	});
	assert.equal(audit.claimsTotal, 2);
	assert.equal(audit.claimsWithSources, 2);
	assert.equal(audit.claimsWithoutSources, 0);
	assert.equal(audit.refsTotal, 2);
	assert.equal(audit.uniqueSourceUrls, 2);
	assert.equal(audit.sourceRefJoinFailures, 0);
	assert.deepEqual(audit.unsupportedClaimIds, []);
	assert.deepEqual(audit.countedClaimKeys, ["claims"]);
	assert.deepEqual(audit.synthesisTaskIds, ["adaptive.synthesis"]);
	assert.equal(
		formatDynamicAuditSummary(audit),
		"audit: 2/2 claims sourced, joins 0",
	);
});

test("auditDynamicClaimSupport joins keyFindings evidenceRefs to generated task refs", () => {
	const audit = auditDynamicClaimSupport({
		synthesis: [
			{
				taskId: "adaptive.synthesis",
				control: {
					keyFindings: [
						{
							id: "f-evidence-ref",
							summary: "artifact-ref-backed finding",
							evidenceRefs: ["workflow_artifact:adaptive.research.refs"],
						},
					],
				},
			},
		],
		collected: [{ taskId: "research", specId: "adaptive.research" }],
	});
	assert.equal(audit.claimsTotal, 1);
	assert.equal(audit.claimsWithSources, 1);
	assert.equal(audit.claimsWithoutSources, 0);
	assert.equal(audit.sourceRefJoinFailures, 0);
	assert.deepEqual(audit.countedClaimKeys, ["keyFindings"]);
});

test("auditDynamicClaimSupport counts unsourced claims and join failures", () => {
	const audit = auditDynamicClaimSupport({
		synthesis: [
			{
				taskId: "adaptive.synthesis",
				control: {
					claims: [
						{ id: "c-none", text: "claim with no sources at all" },
						{
							id: "c-join-fail",
							text: "claim citing an uncollected source",
							sourceRefs: ["https://missing.example.com/nope"],
						},
					],
					keyFindings: [
						{
							id: "f-ok",
							summary: "sourced finding",
							refs: ["https://example.com/evidence/"],
						},
					],
				},
			},
		],
		collected: [
			{
				taskId: "task-2",
				specId: "adaptive.research",
				refs: ["https://example.com/evidence"],
			},
		],
	});
	assert.equal(audit.claimsTotal, 3);
	assert.equal(audit.claimsWithSources, 1);
	assert.equal(audit.claimsWithoutSources, 2);
	assert.equal(audit.sourceRefJoinFailures, 1);
	assert.deepEqual(audit.unsupportedClaimIds, ["c-none", "c-join-fail"]);
	assert.deepEqual(audit.countedClaimKeys, ["claims", "keyFindings"]);
	assert.equal(
		formatDynamicAuditSummary(audit),
		"audit: 1/3 claims sourced, joins 1",
	);
});

test("auditDynamicClaimSupport falls back to URLs embedded in claim text", () => {
	const audit = auditDynamicClaimSupport({
		synthesis: [
			{
				taskId: "adaptive.synthesis",
				control: {
					statements: [
						"Latency dropped 40% per https://example.com/evidence#metrics",
						"Unverifiable statement with no citation",
					],
				},
			},
		],
		collected: [
			{
				taskId: "task-2",
				specId: "adaptive.research",
				refs: [{ url: "https://EXAMPLE.com/evidence" }],
			},
		],
	});
	assert.equal(audit.claimsTotal, 2);
	assert.equal(audit.claimsWithSources, 1);
	assert.equal(audit.claimsWithoutSources, 1);
	assert.equal(audit.sourceRefJoinFailures, 0);
	assert.deepEqual(audit.unsupportedClaimIds, [
		"adaptive.synthesis:statements[1]",
	]);
});

test("auditDynamicClaimSupport bounds unsupportedClaimIds to 24 entries", () => {
	const audit = auditDynamicClaimSupport({
		synthesis: [
			{
				taskId: "adaptive.synthesis",
				control: {
					claims: Array.from({ length: 30 }, (_, index) => ({
						id: `claim-${index + 1}`,
						text: "unsourced",
					})),
				},
			},
		],
		collected: [],
	});
	assert.equal(audit.claimsTotal, 30);
	assert.equal(audit.claimsWithoutSources, 30);
	assert.equal(audit.unsupportedClaimIds.length, 24);
	assert.equal(audit.unsupportedClaimIds[0], "claim-1");
	assert.equal(audit.unsupportedClaimIds[23], "claim-24");
});

test("auditDynamicClaimSupport handles missing synthesis control and empty refs", () => {
	const audit = auditDynamicClaimSupport({ synthesis: [], collected: [] });
	assert.equal(audit.claimsTotal, 0);
	assert.equal(audit.claimsWithSources, 0);
	assert.equal(audit.refsTotal, 0);
	assert.equal(audit.uniqueSourceUrls, 0);
	assert.deepEqual(audit.synthesisTaskIds, []);
	assert.equal(
		formatDynamicAuditSummary(audit),
		"audit: 0/0 claims sourced, joins 0",
	);
	assert.equal(
		formatDynamicAuditSummary({ error: "boom" }),
		"audit: error (boom)",
	);
});

function writeAgent(cwd, name) {
	const dir = join(cwd, ".pi", "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${name}.md`),
		`---\ndescription: ${name}\ntools: ["read"]\nreadOnly: true\n---\n# ${name}\n\nUse repository evidence.\n`,
	);
}

test("dynamic synthesis prompts require structured claim source refs", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "workflow-dynamic-contract-"));
	try {
		writeAgent(cwd, "unit-scout");
		const handoff = dynamicSynthesisHandoffPrompt(
			{
				type: "synthesize",
				actionId: "act-synthesize",
				prompt: "Synthesize accepted findings.",
				inputRefs: [
					{
						taskId: "adaptive.research",
						artifact: "refs",
						digest: "sha256:research",
					},
				],
			},
			"synthesis_v1",
		);
		assert.match(handoff, /claims or keyFindings/);
		assert.match(handoff, /sourceRefs or evidenceRefs/);

		const controllerCompiledTask = {
			id: "adaptive.controller",
			key: "adaptive.controller",
			specId: "adaptive.controller",
			taskId: "controller",
			stageId: "adaptive",
			agent: "dynamic",
			agentPath: "./controller.mjs",
			agentSystemPrompt: "",
			roleNames: [],
			task: "Run controller.",
			cwd,
			explicitCwd: false,
			explicitWorktreePolicy: false,
			runtime: { approvalMode: "non-interactive" },
			safety: {
				readOnlyDeclared: true,
				capability: "read-only",
				sharedCwdSafe: true,
				worktreePolicy: "off",
				requiresWorktree: false,
				permission: { status: "pending" },
			},
			compiledPrompt: "Run controller.",
			kind: "dynamic",
		};
		const generated = await buildDynamicGeneratedCompiledTask({
			cwd,
			run: {
				runId: "workflow_dynamic_contract",
				provenance: { mode: "direct-dynamic" },
				tasks: [
					{
						specId: "adaptive.controller",
						stageId: "adaptive",
						taskId: "controller",
						status: "running",
					},
				],
			},
			compiledFlow: { tasks: [controllerCompiledTask] },
			controllerCompiledTask,
			controllerSpecId: "adaptive.controller",
			controllerStageId: "adaptive",
			generatedSpecId: "adaptive.synthesis",
			opId: "op-synthesis",
			requestHash: "hash-synthesis",
			request: {
				id: "synthesis",
				agent: "unit-scout",
				prompt: "Synthesize the final answer.",
				tools: ["read"],
				outputProfile: "synthesis_v1",
				inputs: [],
				requiredReads: [],
				compact: false,
			},
			dynamic: {
				uses: "./controller.mjs",
				mode: "graph-splice",
				budget: {
					maxAgents: 10,
					maxConcurrency: 2,
					maxRuntimeMs: 1000,
					maxGraphMutations: 10,
				},
				permissions: {
					approval: "auto",
					allowDynamicRoles: true,
					allowDynamicTools: true,
				},
				helpers: {},
				workflows: {},
				decisionLoop: {
					allowedAgents: ["unit-scout"],
					allowedTools: ["read"],
					allowedOutputProfiles: ["synthesis_v1"],
				},
			},
		});
		assert.match(generated.compiledPrompt, /dynamic-task-result-v1/);
		assert.match(generated.compiledPrompt, /claims` or `keyFindings/);
		assert.match(generated.compiledPrompt, /sourceRefs` or `evidenceRefs/);
		assert.match(generated.compiledPrompt, /joinable/);
		assert.equal(generated.artifactGraph.output.refsMinItems, 1);
		assert.equal(generated.artifactGraph.output.refsUrlValidation, true);
	} finally {
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 10,
		});
	}
});

async function completeGeneratedTask(cwd, task, control, refs) {
	setTaskTerminal(task, "completed", "completed", {
		exitCode: 0,
		lastMessage: "completed",
	});
	await writeWorkflowTaskArtifactBundle({
		taskDir: dirname(join(cwd, task.files.result)),
		rawOutput: [
			"<control>",
			JSON.stringify({
				schema: "stage-control-v1",
				digest: `${task.specId} completed`,
				...control,
			}),
			"</control>",
			"<analysis>",
			`${task.specId} analysis`,
			"</analysis>",
			"<refs>",
			JSON.stringify(refs ?? []),
			"</refs>",
		].join("\n"),
		completedAt: new Date().toISOString(),
	});
}

test("direct dynamic run records dynamicAudit after synthesis completes", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "workflow-dynamic-audit-"));
	try {
		writeAgent(cwd, "unit-scout");
		let launchCount = 0;
		setSubagentApiForTests({
			async runSubagent() {
				launchCount += 1;
				return {
					runId: `run_audit_${launchCount}`,
					attemptId: `attempt_audit_${launchCount}`,
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

		const workflowDir = join(cwd, "workflows", "bundle");
		mkdirSync(join(workflowDir, "helpers"), { recursive: true });
		writeFileSync(
			join(workflowDir, "helpers", "controller.mjs"),
			[
				"export default async function controller(ctx) {",
				"  const worker = await ctx.agent({ id: 'research', agent: 'unit-scout', tools: ['read'], prompt: 'Collect evidence.' });",
				"  const synth = await ctx.agent({ id: 'synthesis', agent: 'unit-scout', tools: ['read'], outputProfile: 'synthesis_v1', prompt: 'Synthesize the final answer.' });",
				"  return { control: { schema: 'dynamic-controller-result-v1', digest: 'done', generatedTasks: [worker.specId, synth.specId], outputTasks: [synth.specId] }, analysis: 'done', refs: [] };",
				"}",
			].join("\n"),
		);
		const spec = {
			schemaVersion: 1,
			name: "unit-dynamic-audit",
			defaults: { agent: "unit-scout", readOnly: true, tools: ["read"] },
			artifactGraph: {
				stages: [
					{
						id: "adaptive",
						type: "dynamic",
						dynamic: { uses: "./helpers/controller.mjs" },
					},
				],
			},
		};
		const specPath = join(workflowDir, "spec.json");
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, {
			cwd,
			task: "Audit dynamically.",
			specPath,
		});
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		run.provenance = {
			mode: "direct-dynamic",
			requestedWorkflow: null,
			specPath: null,
			userSelectedWorkflow: false,
			generatedSpec: false,
		};
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);

		let updated = run;
		for (let attempt = 0; attempt < 10; attempt += 1) {
			await scheduleRun(cwd, run.runId);
			updated = await readRunRecord(cwd, run.runId);
			const controller = updated.tasks.find(
				(task) => task.specId === "adaptive.controller",
			);
			if (controller?.status === "completed") break;
			const research = updated.tasks.find(
				(task) => task.specId === "adaptive.research",
			);
			if (research?.status === "running") {
				await completeGeneratedTask(
					cwd,
					research,
					{ summary: "collected evidence" },
					[
						"https://example.com/evidence",
						{ url: "https://example.com/other" },
					],
				);
				await writeRunRecord(cwd, updated);
				continue;
			}
			const synthesis = updated.tasks.find(
				(task) => task.specId === "adaptive.synthesis",
			);
			if (synthesis?.status === "running") {
				await completeGeneratedTask(
					cwd,
					synthesis,
					{
						summary: "final answer",
						claims: [
							{
								id: "c1",
								text: "URL-sourced claim",
								sourceUrls: ["https://example.com/evidence"],
							},
							{ id: "c2", text: "unsourced claim" },
							{
								id: "c3",
								text: "ref-id sourced claim",
								sourceRefs: [{ taskId: "adaptive.research" }],
							},
							{
								id: "c4",
								text: "join-failure claim",
								sourceRefs: ["https://missing.example.com/nope"],
							},
						],
					},
					["https://example.com/evidence"],
				);
				await writeRunRecord(cwd, updated);
			}
		}

		const controllerTask = updated.tasks.find(
			(task) => task.specId === "adaptive.controller",
		);
		assert.equal(controllerTask?.status, "completed");
		assert.ok(updated.dynamicAudit, "dynamicAudit must be populated");
		assert.equal(updated.dynamicAudit.claimsTotal, 4);
		assert.equal(updated.dynamicAudit.claimsWithSources, 2);
		assert.equal(updated.dynamicAudit.claimsWithoutSources, 2);
		assert.equal(updated.dynamicAudit.refsTotal, 2);
		assert.equal(updated.dynamicAudit.uniqueSourceUrls, 2);
		assert.equal(updated.dynamicAudit.sourceRefJoinFailures, 1);
		assert.deepEqual(updated.dynamicAudit.unsupportedClaimIds, ["c2", "c4"]);
		assert.deepEqual(updated.dynamicAudit.synthesisTaskIds, [
			"adaptive.synthesis",
		]);
		assert.match(formatRun(updated), /audit: 2\/4 claims sourced, joins 1/);
	} finally {
		setSubagentApiForTests(undefined);
		rmSync(cwd, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 10,
		});
	}
});
