import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const backendModuleUrl = new URL(
	"../../.tmp/unit/subagent-backend.js",
	import.meta.url,
).href;

async function recordInChild(home, model, backoffMs) {
	const script = `
		const backend = await import(process.argv[1]);
		await backend.recordSharedModelRateLimitBackoffForTests(process.argv[2], Number(process.argv[3]));
	`;
	await execFileAsync(
		process.execPath,
		["--input-type=module", "-e", script, backendModuleUrl, model, String(backoffMs)],
		{
			env: { ...process.env, HOME: home },
			maxBuffer: 1024 * 1024,
		},
	);
}

test("WB-006 concurrent processes preserve distinct keys and the longest same-key cooldown", async () => {
	const home = await mkdtemp(join(tmpdir(), "piwf-wb006-home-"));
	const startedAt = Date.now();
	await Promise.all([
		recordInChild(home, "provider-a/model", 70_000),
		recordInChild(home, "provider-b/model", 80_000),
		recordInChild(home, "provider-c/model", 90_000),
		recordInChild(home, "provider-shared/model-a", 15_000),
		recordInChild(home, "provider-shared/model-b", 120_000),
		recordInChild(home, "provider-shared/model-c", 25_000),
	]);

	const file = join(home, ".pi", "agent", "model-rate-limit-backoff.json");
	const persisted = JSON.parse(await readFile(file, "utf8"));
	assert.deepEqual(
		Object.keys(persisted).sort(),
		["provider-a", "provider-b", "provider-c", "provider-shared"],
	);
	assert.ok(persisted["provider-a"].nextEligibleAtMs >= startedAt + 60_000);
	assert.ok(persisted["provider-b"].nextEligibleAtMs >= startedAt + 70_000);
	assert.ok(persisted["provider-c"].nextEligibleAtMs >= startedAt + 80_000);
	assert.ok(
		persisted["provider-shared"].nextEligibleAtMs >= startedAt + 110_000,
		"a shorter same-provider writer must not overwrite the longest cooldown",
	);
});
