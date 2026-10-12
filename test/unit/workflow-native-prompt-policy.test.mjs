import { readFile } from "node:fs/promises";
import {
	assert, join, test, makeProject, writeAgent, artifactGraphWorkflowSpec,
	compileWorkflow, launchSubagentTask, setSubagentApiForTests,
} from "./unit-test-support.mjs";
import { createRunRecord } from "../../.tmp/unit/store.js";
import { prepareDagTask, prepareArtifactGraphRetryTask } from "../../.tmp/unit/artifact-graph-runtime.js";
import { prepareSubagentTaskLaunch } from "../../.tmp/unit/subagent-backend.js";
import { createLaunchBootstrapProvenance } from "../../.tmp/unit/launch-bootstrap-provenance.js";

for (const native of [false, true]) {
	for (const empty of [false, true]) {
		for (const noArtifacts of [false, true]) {
			for (const retry of [false, true]) {
				test(`sealed prompt parity: native=${native}, empty=${empty}, artifacts=${!noArtifacts}, retry=${retry}`, async () => {
					const cwd = makeProject();
					writeAgent(cwd, "unit-scout", "read");
					const spec = artifactGraphWorkflowSpec();
					spec.defaults.worktreePolicy = "off";
					spec.artifactGraph.stages[0].tools = empty ? [] : ["read"];
					if (noArtifacts) spec.artifactGraph.stages[0].inputPolicy = { artifactAccess: "none" };
					const nativeHost = native ? { version: 1, cwd, agentDir: join(cwd, "agent"), projectTrusted: true } : undefined;
					const compiled = await compileWorkflow(spec, { cwd, nativeHost: nativeHost ?? null });
					const original = JSON.stringify(compiled);
					const { run } = await createRunRecord(cwd, compiled, join(cwd, "spec.json"));
					if (nativeHost) run.nativeHost = nativeHost;
					const task = run.tasks[0];
					let preparedTask = await prepareDagTask(cwd, run, compiled, 0);
					if (retry) {
						task.outputRetry = { attempts: 1, message: "offline malformed-output fixture" };
						preparedTask = await prepareArtifactGraphRetryTask(cwd, task, preparedTask);
						assert.match(preparedTask.compiledPrompt, /Workflow Output Retry Instructions/);
					}
					const prepared = await prepareSubagentTaskLaunch(cwd, run, task, preparedTask);
					const provenance = await createLaunchBootstrapProvenance(cwd, run, task, preparedTask, "pi-subagent/headless", prepared);
					const expected = [
						...(empty ? [] : ["read"]),
						...(native && !empty ? ["codemode", "tool_search", "mcp__*", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"] : []),
						...(noArtifacts ? [] : ["workflow_artifact"]),
					];
					assert.deepEqual(new Set(provenance.effectivePolicy.tools), new Set(expected));
					assert.equal(prepared.generatedExtensions.some(entry => entry.kind === "native-host"), native && !empty);
					let captured;
					setSubagentApiForTests({
						supportsExplicitExtensionIsolation: () => true,
						async runSubagent(options) { captured = options; return { runId: "run_prompt_fixture", attemptId: "attempt_prompt_fixture", status: "running" }; },
						async getSubagentStatus() { return null; },
						async reconcileSubagentRun() { return {}; },
						async interruptSubagent() { return {}; },
					});
					try {
						assert.equal((await launchSubagentTask(cwd, run, task, preparedTask, undefined, undefined, prepared)).kind, "launched");
						assert.deepEqual(captured.tools, provenance.effectivePolicy.tools);
						const policyLine = captured.systemPrompt.split("\n").find(line => /^(Only these tools|No tools)/.test(line));
						assert.equal(policyLine, captured.tools.length ? `Only these tools are enabled for this workflow task: ${captured.tools.join(", ")}.` : "No tools are enabled for this workflow task.");
						assert.equal(await readFile(join(cwd, task.files.systemPrompt), "utf8"), captured.systemPrompt);
						assert.equal(JSON.stringify(compiled), original);
					} finally {
						setSubagentApiForTests(undefined);
					}
				});
			}
		}
	}
}
