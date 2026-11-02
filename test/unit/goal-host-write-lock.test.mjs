import assert from "node:assert/strict";
import { test } from "node:test";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasCurrentGoalHostWriteLease, withGoalHostWriteLock } from "../../.tmp/unit/goal-host-write-lock.js";

test("nested host journals require exact physical leases and cannot inherit an occupied sibling lock", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "goal-host-write-lock-"));
	t.after(async () => rm(base, { recursive: true, force: true }));
	const root = join(base, "root");
	const child = join(root, "workspace-effects", "child");
	const sibling = join(base, "sibling");
	const occupiedLock = join(sibling, ".goal-host-write-lock");
	await mkdir(child, { recursive: true });
	await mkdir(occupiedLock, { recursive: true });
	const occupiedIdentity = await lstat(occupiedLock);
	let nestedRan = false;
	await withGoalHostWriteLock(root, async () => {
		assert.equal(await hasCurrentGoalHostWriteLease(root), true);
		assert.equal(await hasCurrentGoalHostWriteLease(child), false);
		assert.equal(await hasCurrentGoalHostWriteLease(sibling), false);
		await assert.rejects(
			withGoalHostWriteLock(join(root, "missing"), async () => {
				assert.fail("a missing physical root must not enter the write callback");
			}),
			{ code: "ENOENT" },
		);
		await withGoalHostWriteLock(child, async () => {
			assert.equal(await hasCurrentGoalHostWriteLease(root), true);
			assert.equal(await hasCurrentGoalHostWriteLease(child), true);
			assert.equal(await hasCurrentGoalHostWriteLease(sibling), false);
			nestedRan = true;
		});
		assert.equal(await hasCurrentGoalHostWriteLease(child), false);
		await assert.rejects(
			withGoalHostWriteLock(sibling, async () => {
				assert.fail("the parent lease must not bypass a sibling's physical lock");
			}),
			{ code: "EEXIST" },
		);
	});
	assert.equal(nestedRan, true);
	assert.equal(await hasCurrentGoalHostWriteLease(root), false);
	assert.equal((await lstat(occupiedLock)).ino, occupiedIdentity.ino);
});
