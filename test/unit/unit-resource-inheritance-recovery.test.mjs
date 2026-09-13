import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { compileWorkflow } from "../../.tmp/unit/compiler.js";
import { hashDynamicRequest } from "../../.tmp/unit/dynamic-events.js";
import {
	buildDynamicGeneratedCompiledTask,
	normalizeDynamicAgentRequest,
} from "../../.tmp/unit/dynamic-generated-task-runtime.js";
import { recordDynamicEventAndUpdateState } from "../../.tmp/unit/dynamic-state.js";
import { resolveWorkflowResourcePolicy } from "../../.tmp/unit/resource-inheritance.js";
import {
	compiledWorkflowPath,
	createRunRecord,
	flushPendingIndexUpdatesForTests,
	readRunRecord,
	writeRunRecord,
	writeStaticRunArtifacts,
} from "../../.tmp/unit/store.js";

// Expose the real private recovery functions without changing their bodies or
// adding test-only exports to the product. Relative imports keep the same modules.
const engineFixtureUrl = new URL(
	`../../.tmp/unit/engine-resource-recovery-${randomUUID()}.mjs`,
	import.meta.url,
);
writeFileSync(
	engineFixtureUrl,
	readFileSync(new URL("../../.tmp/unit/engine.js", import.meta.url), "utf8") +
		"\nexport { repairMissingDynamicGeneratedTask, runDynamicAgentRequest };\n",
);
after(() => rmSync(engineFixtureUrl));
const { repairMissingDynamicGeneratedTask, runDynamicAgentRequest } = await import(
	engineFixtureUrl.href
);

const cases = [
	{
		name: "current explicit false and context request",
		marker: 1,
		fields: "inheritSkills: false\ninheritProjectContext: true",
		warningCount: 1,
	},
	{
		name: "current invalid frontmatter",
		marker: 1,
		fields: "inheritSkills: [false]\ninheritProjectContext: [true]",
		warningCount: 2,
	},
	{
		name: "legacy explicit false and context request",
		marker: undefined,
		fields: "inheritSkills: false\ninheritProjectContext: true",
		warningCount: 0,
	},
];

for (const path of ["resume repair", "repeated request"]) {
	for (const scenario of cases) {
		test(`dynamic inheritance warnings survive event-only ${path}: ${scenario.name}`, async () => {
			const cwd = mkdtempSync(join(tmpdir(), "piwf-resource-recovery-"));
			try {
				const agentPath = join(cwd, ".pi", "agents", "warning-agent.md");
				mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
				writeFileSync(
					agentPath,
					`---\ndescription: warning agent\ntools: [read]\nreadOnly: true\n${scenario.fields}\n---\nInspect locally.\n`,
				);
				writeFileSync(join(cwd, "controller.mjs"), "export default async () => {};\n");
				const spec = {
					schemaVersion: 1,
					name: "warning-recovery",
					defaults: { model: "fixture/model", thinking: "high" },
					artifactGraph: {
						stages: [{
							id: "adaptive",
							type: "dynamic",
							dynamic: {
								uses: "./controller.mjs",
								budget: { maxAgents: 10, maxConcurrency: 1, maxRuntimeMs: 1000 },
							},
						}],
					},
				};
				writeFileSync(join(cwd, "workflow.json"), JSON.stringify(spec));
				const compiled = await compileWorkflow(spec, { cwd, task: "Fixture." });
				const controller = compiled.tasks[0];
				if (scenario.marker === undefined) delete controller.resourcePolicyVersion;
				compiled.warnings.push("pre-existing warning");
				const { run } = await createRunRecord(cwd, compiled, "workflow.json");
				await writeStaticRunArtifacts(cwd, run, compiled, spec);
				await writeRunRecord(cwd, run);
				const request = normalizeDynamicAgentRequest({
					id: "warning-child", agent: "warning-agent", prompt: "Inspect locally.",
					inputs: [], requiredReads: [], compact: true,
				});
				const opId = `${controller.specId}:agent:${request.id}`;
				const requestHash = hashDynamicRequest(request);
				const eventTask = await buildDynamicGeneratedCompiledTask({
					cwd, run, compiledFlow: compiled, controllerCompiledTask: controller,
					controllerSpecId: controller.specId, controllerStageId: "adaptive",
					generatedSpecId: "adaptive.warning-child", opId, requestHash, request,
					dynamic: controller.dynamic,
				});
				const expectedWarnings = [...compiled.warnings];
				assert.equal(expectedWarnings.length, 1 + scenario.warningCount);
				const expectedPolicy = resolveWorkflowResourcePolicy(eventTask);
				await recordDynamicEventAndUpdateState(cwd, run.runId, {
					controllerSpecId: controller.specId, type: "task.generated", opId, requestHash,
					payload: { taskId: eventTask.id, request, compiledTask: eventTask },
				});

				// Only the event is durable. Recovery must use its captured diagnostics,
				// not today's agent file (invalid raw values are already normalized away).
				rmSync(agentPath);
				const recoveredFlow = JSON.parse(readFileSync(compiledWorkflowPath(cwd, run.runId), "utf8"));
				const recoveredRun = await readRunRecord(cwd, run.runId);
				assert.deepEqual(recoveredFlow.warnings, ["pre-existing warning"]);
				const input = {
					cwd, run: recoveredRun, compiledFlow: recoveredFlow, controllerIndex: 0,
					controllerTask: recoveredRun.tasks[0], controllerCompiledTask: recoveredFlow.tasks[0],
					dynamic: recoveredFlow.tasks[0].dynamic, request, generatedTaskIds: [],
				};
				for (let replay = 0; replay < 2; replay++) {
					if (path === "resume repair") {
						const result = await repairMissingDynamicGeneratedTask(input, eventTask.id);
						assert.equal(result.specId, eventTask.id);
					} else {
						await assert.rejects(runDynamicAgentRequest(input), /waiting for dynamic generated task/);
					}
					const persisted = JSON.parse(readFileSync(compiledWorkflowPath(cwd, run.runId), "utf8"));
					assert.deepEqual(persisted.warnings, expectedWarnings, "recovery must preserve and deduplicate inheritance diagnostics");
					const recoveredTask = persisted.tasks.find((task) => task.id === eventTask.id);
					assert.deepEqual(resolveWorkflowResourcePolicy(recoveredTask), expectedPolicy);
					assert.equal(Object.hasOwn(recoveredTask, "resourcePolicyVersion"), scenario.marker !== undefined);
					assert.deepEqual(recoveredTask, JSON.parse(JSON.stringify(eventTask)), "recovery must not alter the captured task");
					// A second run-record repair with compiled state already present must
					// neither duplicate diagnostics nor require rediscovering the agent.
					recoveredRun.tasks.splice(1);
				}
			} finally {
				await flushPendingIndexUpdatesForTests();
				rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
			}
		});
	}
}
