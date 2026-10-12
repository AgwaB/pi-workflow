import {
	assert, join, test, makeProject, makeSubagentLaunchFixture,
	launchSubagentTask, setSubagentApiForTests,
} from "./unit-test-support.mjs";
import { prepareSubagentTaskLaunch } from "../../.tmp/unit/subagent-backend.js";
import {
	createLaunchBootstrapProvenance, recordLaunchBootstrapProvenance,
	assertPreparedLaunchMatchesRecordedProvenance,
} from "../../.tmp/unit/launch-bootstrap-provenance.js";

for (const downgrade of [false, true]) {
	test(`extension isolation is sealed and capability-checked at dispatch: downgrade=${downgrade}`, async () => {
		const cwd = makeProject();
		const { run, task, compiledTask } = makeSubagentLaunchFixture(cwd, "isolated-native");
		run.nativeHost = { version: 1, cwd, agentDir: join(cwd, "agent"), projectTrusted: true };
		compiledTask.runtime.tools = ["read"];
		let supported = true;
		let captured;
		setSubagentApiForTests({
			supportsExplicitExtensionIsolation: () => supported,
			async runSubagent(options) {
				captured = options;
				return { runId: "run_isolation", attemptId: "attempt_isolation", status: "running" };
			},
			async getSubagentStatus() { return null; },
			async reconcileSubagentRun() { return {}; },
			async interruptSubagent() { return {}; },
		});
		try {
			const prepared = await prepareSubagentTaskLaunch(cwd, run, task, compiledTask);
			assert.equal(prepared.noExtensions, true);
			assert.ok(prepared.extensions.length > 0);
			const backend = "pi-subagent/headless";
			const provenance = await createLaunchBootstrapProvenance(cwd, run, task, compiledTask, backend, prepared);
			assert.equal(provenance.effectiveLaunch.noExtensions, true);
			recordLaunchBootstrapProvenance(task, provenance);
			await assertPreparedLaunchMatchesRecordedProvenance(cwd, run, task, compiledTask, backend, prepared, provenance.identitySha256);
			await assert.rejects(() => assertPreparedLaunchMatchesRecordedProvenance(
				cwd, run, task, compiledTask, backend, { ...prepared, noExtensions: undefined }, provenance.identitySha256,
			), /workflow launch authority sealed launch mismatch/);
			await assert.rejects(() => createLaunchBootstrapProvenance(
				cwd, run, task, compiledTask, backend, { ...prepared, noExtensions: false },
			), /prepared extensions are invalid/);
			supported = !downgrade;
			if (downgrade) {
				await assert.rejects(() => launchSubagentTask(cwd, run, task, compiledTask, undefined, undefined, prepared), /does not support explicit extension isolation/);
				assert.equal(captured, undefined, "capability loss cannot launch an additive child");
			} else {
				assert.equal((await launchSubagentTask(cwd, run, task, compiledTask, undefined, undefined, prepared)).kind, "launched");
				assert.equal(captured.noExtensions, true);
				assert.deepEqual(captured.extensions, prepared.extensions);
			}
		} finally {
			setSubagentApiForTests(undefined);
		}
	});
}
