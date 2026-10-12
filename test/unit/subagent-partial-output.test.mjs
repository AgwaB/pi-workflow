import { withMaterializedRawHost } from "./raw-host-fixture.mjs";
import {
	assert, compileWorkflow, createWorkflowRunRecord, dirname, existsSync, join,
	makeProject, mkdirSync, readFileSync, readRunRecord,
	refreshRunFromSubagentArtifacts, rmSync, setSubagentApiForTests as setRawApi,
	test, workflowSpec, writeAgent, writeFileSync, writeRunRecord,
	writeStaticRunArtifacts,
} from "./unit-test-support.mjs";

const setSubagentApiForTests = withMaterializedRawHost(setRawApi);
const cases = [
	{ name: "snapshot partial flag", snapshotPartial: true },
	{ name: "persisted partial flag", resultPartial: true },
	{ name: "snapshot true overrides persisted false", snapshotPartial: true, resultPartial: false },
	{ name: "persisted true overrides snapshot false", snapshotPartial: false, resultPartial: true },
	{ name: "context recovery cannot salvage partial sections", resultPartial: true, context: true },
	{ name: "cancelled partial output stays interrupted", resultPartial: true, status: "cancelled", failureKind: "cancelled", expected: "interrupted" },
	{ name: "timed-out partial output stays failed", snapshotPartial: true, failureKind: "timeout" },
	{ name: "inconsistent completed partial output fails closed", resultPartial: true, status: "completed" },
];

for (const scenario of cases) {
	test(`pi-subagent 0.7: ${scenario.name}`, async () => {
		const cwd = makeProject();
		try {
			writeAgent(cwd, "unit-scout", "read");
			const spec = workflowSpec("unit-scout", {
				artifactGraph: { stages: [{ id: "main", type: "single", prompt: "Return workflow output." }] },
			});
			const compiled = await compileWorkflow(spec, { cwd, task: "Partial output regression" });
			const { run } = await createWorkflowRunRecord(cwd, compiled, join(cwd, "workflows", "unit.json"));
			await writeStaticRunArtifacts(cwd, run, compiled, spec);
			const task = run.tasks[0];
			task.status = "running";
			task.statusDetail = "running";
			task.startedAt = new Date().toISOString();
			task.backendHandle = {
				engine: "pi-subagent", backend: "headless", runId: "run_partial",
				attemptId: "attempt_partial", cwd, runsDir: ".pi/workflow-subagents/partial",
				display: "pi-subagent/headless run_partial/attempt_partial",
			};
			const relative = ".fake-partial-subagent";
			const artifactDir = join(cwd, relative);
			mkdirSync(artifactDir, { recursive: true });
			const output = '<control>{"schema":"stage-control-v1","digest":"partial","ok":true}</control><analysis>Unverified recovery text.</analysis><refs>[]</refs>';
			writeFileSync(join(artifactDir, "output.log"), output);
			writeFileSync(join(artifactDir, "stderr.log"), "");
			const metadata = { contextLengthExceeded: scenario.context ?? false, stopReason: "stop" };
			const status = scenario.status ?? "failed";
			const failureKind = status === "completed" ? null : (scenario.failureKind ?? "model");
			const completedAt = new Date().toISOString();
			writeFileSync(join(artifactDir, "result.json"), JSON.stringify({
				status, failureKind, startedAt: task.startedAt, completedAt, exitCode: 0, cwd,
				metadata: { ...metadata, ...(scenario.resultPartial === undefined ? {} : { outputPartial: scenario.resultPartial }) },
			}));
			setSubagentApiForTests({
				async runSubagent() { throw new Error("No retry or provider launch permitted"); },
				async reconcileSubagentRun() { return {}; },
				async interruptSubagent() { return {}; },
				async getSubagentStatus() {
					return {
						runId: "run_partial", attemptId: "attempt_partial", backend: "headless",
						status, failureKind, startedAt: task.startedAt, completedAt,
						logs: [
							{ type: "output", path: `${relative}/output.log`, artifactCwd: cwd },
							{ type: "stderr", path: `${relative}/stderr.log`, artifactCwd: cwd },
							{ type: "result", path: `${relative}/result.json`, artifactCwd: cwd },
						],
						metadata: { ...metadata, ...(scenario.snapshotPartial === undefined ? {} : { outputPartial: scenario.snapshotPartial }) },
						attempts: [{ attemptId: "attempt_partial", status, pid: 99999999 }],
					};
				},
			});
			await writeRunRecord(cwd, run);
			const refreshed = await refreshRunFromSubagentArtifacts(cwd, await readRunRecord(cwd, run.runId));
			const current = refreshed.tasks[0];
			const result = JSON.parse(readFileSync(join(cwd, current.files.result), "utf8"));
			assert.equal(current.status, scenario.expected ?? "failed");
			assert.equal(result.status, scenario.expected ?? "failed");
			assert.equal(result.subagent.metadata.outputPartial, true);
			assert.equal(readFileSync(join(cwd, current.files.output), "utf8"), output);
			assert.equal(existsSync(join(dirname(join(cwd, current.files.result)), "control.json")), false);
			assert.equal(result.outputValidation?.valid, undefined);
			assert.equal(current.launchRetry?.attempts ?? 0, 0);
		} finally {
			setSubagentApiForTests(undefined);
			rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
		}
	});
}
