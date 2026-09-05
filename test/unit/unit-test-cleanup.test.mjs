import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

for (const mode of ["pending", "inflight"]) {
	test(`global test cleanup drains ${mode} index work before removing its root`, { timeout: 60000 }, () => {
		const evidence = mkdtempSync(join(tmpdir(), "workflow-cleanup-control-"));
		const trace = join(evidence, "trace.jsonl");
		try {
			const result = spawnSync(process.execPath, ["--test", resolve("test/fixtures/unit-cleanup-lifecycle.mjs")], {
				cwd: process.cwd(), encoding: "utf8", timeout: 45000, killSignal: "SIGKILL",
				env: {
					PATH: process.env.PATH, HOME: evidence, USERPROFILE: evidence,
					PI_OFFLINE: "1", CLEANUP_CONTROL_MODE: mode, CLEANUP_CONTROL_TRACE: trace,
				},
			});
			assert.equal(result.error, undefined, String(result.error));
			assert.equal(result.status, 0, result.stdout + result.stderr);
			const events = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
			const cleanup = events.filter((event) => event.phase === "root-cleanup");
			assert.ok(cleanup.length > 0, "cleanup must execute, not be skipped");
			assert.ok(cleanup.every((event) => event.entered && event.completed), JSON.stringify(events));
			assert.equal(existsSync(cleanup[0].root), false, "the child must leave no test root");
		} finally { rmSync(evidence, { recursive: true, force: true }); }
	});
}
