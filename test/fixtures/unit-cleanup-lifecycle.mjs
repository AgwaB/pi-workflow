// Disposable child-test observation of the real store's deferred index writer.
// The gate changes scheduling, not filesystem results; no errno is fabricated.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { dirname, join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";

const mode = process.env.CLEANUP_CONTROL_MODE;
const trace = process.env.CLEANUP_CONTROL_TRACE;
assert.ok(mode === "pending" || mode === "inflight");
let root, target, armed = false, entered = false, completed = false;
let enter;
const writerEntered = new Promise((resolve) => { enter = resolve; });
const note = (phase) => fs.appendFileSync(trace, `${JSON.stringify({ phase, root, entered, completed })}\n`);
const mkdir = fsp.mkdir;
fsp.mkdir = function (path, options) {
	if (armed && !entered && String(path) === target && new Error().stack.includes("updateIndex")) {
		entered = true;
		note("writer-entered");
		enter();
		// Test completion runs before this check-phase release. An awaited drain
		// yields to the release; a synchronous early cleanup does not.
		return new Promise((resolve, reject) => setImmediate(() => {
			mkdir(path, options).then((value) => {
				completed = true;
				note("mkdir-completed");
				resolve(value);
			}, reject);
		}));
	}
	return mkdir(path, options);
};
const remove = fs.rmSync;
fs.rmSync = function (path, options) {
	if (String(path) === root) note("root-cleanup");
	return remove(path, options);
};
syncBuiltinESMExports();

const support = await import("../unit/unit-test-support.mjs");
test(`root teardown drains ${mode} advisory index work`, { timeout: 30000 }, async () => {
	const cwd = support.makeProject();
	root = dirname(cwd);
	target = join(cwd, ".pi", "workflows");
	support.writeAgent(cwd, "unit-scout", "read");
	const { run } = await support.createLoopRun(cwd);
	// Only the subsequent nonterminal write belongs to this control.
	await support.flushPendingIndexUpdatesForTests();
	support.setIndexUpdateDebounceMsForTests(mode === "pending" ? 60000 : 0);
	armed = true;
	await support.writeRunRecord(cwd, run);
	assert.equal(run.status, "running");
	if (mode === "inflight") {
		let watchdog;
		try {
			await Promise.race([
				writerEntered,
				new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error("real index writer did not enter")), 20000); }),
			]);
		} finally { clearTimeout(watchdog); }
	}
	note("test-body-completed");
});
