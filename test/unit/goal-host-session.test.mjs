import assert from "node:assert/strict";
import { test } from "node:test";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const build = resolve(process.env.GOAL_HOST_SESSION_TEST_BUILD_ROOT ?? ".tmp/unit");
const { installGoalHostSessionIssuer } = await import(pathToFileURL(join(build, "goal-host-session.js")));

function fakeExtensionApi() {
	const handlers = new Map();
	const api = {
		on(name, handler) {
			const existing = handlers.get(name) ?? [];
			existing.push(handler);
			handlers.set(name, existing);
		},
	};
	return {
		api,
		call(name, event, ctx) {
			const registered = handlers.get(name) ?? [];
			assert.equal(registered.length, 1, `expected one ${name} handler`);
			return registered[0](event, ctx);
		},
		eventNames() {
			return [...handlers.keys()];
		},
	};
}

function fakeSessionManager({
	id = "session-a",
	cwd = "/fixture/project",
	file = "/fixture/session-a.jsonl",
} = {}) {
	return {
		id,
		cwd,
		file,
		getSessionId() {
			return this.id;
		},
		getCwd() {
			return this.cwd;
		},
		getSessionFile() {
			return this.file;
		},
	};
}

function context(sessionManager) {
	return { cwd: sessionManager.getCwd(), sessionManager };
}

function startFixture(options) {
	const host = fakeExtensionApi();
	const issuer = installGoalHostSessionIssuer(host.api);
	const manager = fakeSessionManager(options);
	const ctx = context(manager);
	host.call("session_start", { type: "session_start", reason: "startup" }, ctx);
	return { host, issuer, manager, ctx };
}

const assertStale = (issuer, lease) =>
	assert.throws(() => issuer.assertCurrent(lease), /stale or untrusted/);

test("shutdown during a tree fence is permanent and cannot be overwritten by its continuation", async () => {
	const { host, issuer, ctx } = startFixture();
	const lease = issuer.currentLease();
	issuer.bindFence(lease, () => host.call("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx));
	assert.deepEqual(await host.call("session_before_tree", { type: "session_before_tree" }, ctx), { cancel: true });
	await host.call("session_tree", { type: "session_tree" }, ctx);
	assertStale(issuer, lease);
	assert.throws(() => issuer.currentLease(), /not current/);
});

test("observed identity drift invokes registered fences once instead of discarding them", async () => {
	const { host, issuer, manager, ctx } = startFixture();
	const lease = issuer.currentLease();
	const reasons = [];
	issuer.bindFence(lease, (event) => reasons.push(event.reason));
	manager.id = "unexpected-session";
	assertStale(issuer, lease);
	assert.deepEqual(reasons, ["lifecycle-mismatch"]);
	manager.id = "session-a";
	await host.call("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
	assert.deepEqual(reasons, ["lifecycle-mismatch"]);
	assertStale(issuer, lease);
});

test("issuer subscribes only to locked Pi session lifecycle event names", () => {
	const host = fakeExtensionApi();
	installGoalHostSessionIssuer(host.api);
	assert.deepEqual(host.eventNames(), [
		"session_start",
		"session_before_switch",
		"session_before_fork",
		"session_before_tree",
		"session_tree",
		"session_shutdown",
	]);
});

test("lease is minted by session_start and exact object identity is required", () => {
	const host = fakeExtensionApi();
	const issuer = installGoalHostSessionIssuer(host.api);
	assert.throws(() => issuer.currentLease(), /not current/);

	const manager = fakeSessionManager();
	host.call(
		"session_start",
		{ type: "session_start", reason: "startup" },
		context(manager),
	);
	const lease = issuer.currentLease();
	assert.equal(
		issuer.currentLease(),
		lease,
		"accessor must not mint another lease",
	);
	assert.doesNotThrow(() => issuer.assertCurrent(lease));

	for (const forgery of [
		{ ...lease },
		structuredClone(lease),
		JSON.parse(JSON.stringify(lease)),
		{ sessionId: manager.getSessionId() },
		{ digest: "same-looking-digest" },
	]) {
		assertStale(issuer, forgery);
	}
});

test("switch invalidates synchronously before fencing and never revives after a veto elsewhere", async () => {
	const { host, issuer, ctx } = startFixture();
	const lease = issuer.currentLease();
	let releaseFence;
	const fenceGate = new Promise((resolve) => {
		releaseFence = resolve;
	});
	const seen = [];
	issuer.bindFence(lease, async (event) => {
		seen.push(event);
		assertStale(issuer, lease);
		await fenceGate;
	});

	const transition = host.call(
		"session_before_switch",
		{
			type: "session_before_switch",
			reason: "resume",
			targetSessionFile: "/fixture/session-b.jsonl",
		},
		ctx,
	);
	assertStale(issuer, lease);
	assert.throws(() => issuer.currentLease(), /not current/);
	releaseFence();
	assert.equal(await transition, undefined);
	assert.deepEqual(seen, [
		{ reason: "resume", targetSessionFile: "/fixture/session-b.jsonl" },
	]);

	assert.deepEqual(
		await host.call(
			"session_before_switch",
			{ type: "session_before_switch", reason: "new" },
			ctx,
		),
		{ cancel: true },
		"a cancelled downstream transition cannot revive or replace the old lease",
	);
});

test("session transition starts fences immediately and still waits for admitted work to drain", async () => {
	const { host, issuer, ctx } = startFixture();
	const lease = issuer.currentLease();
	let releaseAction;
	const actionGate = new Promise((resolve) => { releaseAction = resolve; });
	let fenceObserved = false;
	const admitted = issuer.runCurrent(lease, async () => {
		await actionGate;
		return "settled";
	});
	issuer.bindFence(lease, () => { fenceObserved = true; });
	const transition = host.call(
		"session_before_switch",
		{ type: "session_before_switch", reason: "new" },
		ctx,
	);
	assertStale(issuer, lease);
	let transitioned = false;
	void transition.then(() => { transitioned = true; });
	await Promise.resolve();
	assert.equal(fenceObserved, true);
	assert.equal(transitioned, false);
	releaseAction();
	assert.equal(await admitted, "settled");
	assert.equal(await transition, undefined);
	assert.equal(fenceObserved, true);
});

test("session stop callback releases its own inflight operation without a drain deadlock", { timeout: 2000 }, async () => {
	const { host, issuer, ctx } = startFixture();
	const lease = issuer.currentLease();
	let stop;
	const childExit = new Promise(resolve => { stop = resolve; });
	let effectSignal;
	const operation = issuer.runCurrent(lease, async signal => {
		effectSignal = signal;
		await childExit;
		return "stopped";
	});
	issuer.bindFence(lease, () => {
		assert.equal(effectSignal.aborted, true);
		stop();
	});
	const shutdown = host.call("session_shutdown", { reason: "quit" }, ctx);
	assertStale(issuer, lease);
	assert.equal(await operation, "stopped");
	await shutdown;
	assertStale(issuer, lease);
});

test("fork fences permanently and callback failure is converted to a fail-closed veto", async () => {
	const { host, issuer, ctx } = startFixture();
	const lease = issuer.currentLease();
	issuer.bindFence(lease, async () => {
		throw new Error("fixture drain uncertainty");
	});

	assert.deepEqual(
		await host.call(
			"session_before_fork",
			{ type: "session_before_fork", entryId: "entry-a", position: "before" },
			ctx,
		),
		{ cancel: true },
	);
	assertStale(issuer, lease);
	assert.throws(() => issuer.currentLease(), /not current/);
});

test("successful tree callback alone mints a new exact lease after pre-tree invalidation", async () => {
	const { host, issuer, manager, ctx } = startFixture();
	const oldLease = issuer.currentLease();
	const reasons = [];
	issuer.bindFence(oldLease, (event) => reasons.push(event.reason));

	assert.equal(
		await host.call(
			"session_before_tree",
			{
				type: "session_before_tree",
				preparation: {},
				signal: new AbortController().signal,
			},
			ctx,
		),
		undefined,
	);
	assertStale(issuer, oldLease);
	assert.throws(() => issuer.currentLease(), /not current/);

	host.call(
		"session_tree",
		{ type: "session_tree", oldLeafId: "old", newLeafId: "new" },
		context(manager),
	);
	const newLease = issuer.currentLease();
	assert.notEqual(newLease, oldLease);
	assert.doesNotThrow(() => issuer.assertCurrent(newLease));
	assertStale(issuer, oldLease);
	assert.deepEqual(reasons, ["tree"]);
});

test("mismatched host context and in-place session replacement both fail closed", async () => {
	const first = startFixture();
	const lease = first.issuer.currentLease();
	const other = fakeSessionManager({ id: "session-b" });
	assert.deepEqual(
		await first.host.call(
			"session_before_switch",
			{ type: "session_before_switch", reason: "resume" },
			context(other),
		),
		{ cancel: true },
	);
	assertStale(first.issuer, lease);

	const second = startFixture();
	const replacedLease = second.issuer.currentLease();
	second.manager.id = "session-mutated-without-lifecycle";
	assertStale(second.issuer, replacedLease);
	second.manager.id = "session-a";
	assertStale(second.issuer, replacedLease);
	assert.throws(() => second.issuer.currentLease(), /not current/);
});

test("shutdown invalidates before awaiting cleanup and contains cleanup errors", async () => {
	const { host, issuer, ctx } = startFixture();
	const lease = issuer.currentLease();
	let observedStale = false;
	issuer.bindFence(lease, async () => {
		assert.throws(() => issuer.assertCurrent(lease), /stale or untrusted/);
		observedStale = true;
		throw new Error("fixture shutdown cleanup failed");
	});

	await assert.doesNotReject(() =>
		host.call(
			"session_shutdown",
			{ type: "session_shutdown", reason: "quit" },
			ctx,
		),
	);
	assert.equal(observedStale, true);
	assertStale(issuer, lease);
	assert.throws(() => issuer.currentLease(), /not current/);
});
