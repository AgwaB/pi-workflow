import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { setWorkflowOutputArtifactWriteHookForTests, writeWorkflowTaskArtifactBundle } from "../../.tmp/unit/workflow-output-artifacts.js";

const raw = '<control>{"schema":"fixture","digest":"done"}</control>\n<analysis>fixture</analysis>\n<refs>[]</refs>';
for (const failure of ["raw.md", "analysis.md"]) {
	test(`bundle failure in ${failure} waits for all started sidecar writes`, async () => {
		const root = await mkdtemp(join(tmpdir(), "piwf-sidecar-settlement-"));
		const expected = ["control.json", "analysis.md", "refs.json", "raw.md", "stderr.log"].filter(name => name !== failure);
		const finished = new Set();
		const resolvers = new Map();
		const writes = expected.map(name => new Promise(resolve => resolvers.set(name, resolve)));
		setWorkflowOutputArtifactWriteHookForTests(async event => {
			const name = basename(event.file);
			if (event.phase === "before") {
				if (name === failure) throw new Error(`injected ${failure} failure`);
				if (name === "stderr.log") await new Promise(resolve => setTimeout(resolve, 60));
			} else if (resolvers.has(name)) {
				finished.add(name);
				resolvers.get(name)();
			}
		});
		let timeout;
		try {
			await assert.rejects(writeWorkflowTaskArtifactBundle({ taskDir: root, rawOutput: raw, stderr: "diagnostic" }), new RegExp(`injected ${failure}`));
			assert.deepEqual([...finished].sort(), [...expected].sort(), "failed publication must not settle while sibling writes still run");
			await assert.rejects(access(join(root, "result.json")), { code: "ENOENT" });
		} finally {
			// Also join the broken baseline's siblings before removing its fixture.
			await Promise.race([Promise.all(writes), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("sidecars did not settle")), 3000); })]);
			clearTimeout(timeout);
			setWorkflowOutputArtifactWriteHookForTests(undefined);
			await rm(root, { recursive: true, force: true });
		}
	});
}
