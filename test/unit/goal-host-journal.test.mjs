import test, { after } from "node:test";
import assert from "node:assert/strict";
import fsPromises, {
	chmod,
	link,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readFile,
	readdir,
	rename,
	rm,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import {
	syncBuiltinESMExports,
} from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const compileRoot = process.env.PI_GOAL_HOST_JOURNAL_COMPILE_ROOT
	? resolve(process.env.PI_GOAL_HOST_JOURNAL_COMPILE_ROOT)
	: resolve(".tmp/unit");
const journalModule = await import(
	pathToFileURL(join(compileRoot, "goal-host-journal.js")).href
);
const jsonModule = await import(
	pathToFileURL(join(compileRoot, "goal-json.js")).href
);
const { GoalHostJournal, setGoalHostJournalCrashHookForTests } = journalModule;
const { goalHash } = jsonModule;
const { withPrivateDirectoryReader } = await import(
	pathToFileURL(join(compileRoot, "secure-atomic-write.js")).href
);

const ZERO = "0".repeat(64);
const suiteRoot = await mkdtemp(join(tmpdir(), "goal-host-journal-test-"));
after(async () => {
	await rm(suiteRoot, { recursive: true, force: true });
});

async function fresh(label = "case") {
	const parent = await mkdtemp(join(suiteRoot, `${label}-`));
	const root = join(parent, "journal");
	const journal = await GoalHostJournal.create(root);
	return { parent, root, journal };
}

async function appendTwo(journal) {
	const first = await journal.append(
		{ seq: 0, hash: ZERO },
		{ kind: "first", count: 1 },
	);
	const second = await journal.append(first.head, {
		kind: "second",
		nested: { ok: true },
	});
	return { first, second };
}

async function retainedTree(root) {
	const names = (await readdir(root)).sort();
	return Promise.all(
		names.map(async (name) => {
			const path = join(root, name);
			const info = await lstat(path);
			return [
				name,
				info.isFile() ? await readFile(path) : `${info.mode}:${info.size}`,
			];
		}),
	);
}

async function expectRetainedFailure(root, mutate, pattern) {
	const journal = await GoalHostJournal.open(root);
	await mutate();
	const before = await retainedTree(root);
	await assert.rejects(journal.load(), pattern);
	const afterFailure = await retainedTree(root);
	assert.deepEqual(afterFailure, before);
	await assert.rejects(journal.load(), /poisoned/);
	assert.deepEqual(await retainedTree(root), before);
}

test("operation-scoped directory reader reads fresh bytes and expires without retaining authority", async () => {
	const { root } = await fresh("reader");
	const path = join(root, "input");
	await writeFile(path, "first", { mode: 0o600 });
	let escaped;
	await withPrivateDirectoryReader(root, async read => {
		escaped = read;
		assert.equal(await read("input", 16), "first");
		await writeFile(path, "second", { mode: 0o600 });
		assert.equal(await read("input", 16), "second", "bytes are never cached");
		for (const name of ["../input", "/input", ".", "..", "a\\b", "a\0b"])
			await assert.rejects(read(name, 16), /one file name/);
		await assert.rejects(read("input", 1), /size limit/);
		await unlink(path);
		await symlink("manifest.json", path);
		await assert.rejects(read("input", 1024));
	});
	await assert.rejects(escaped("input", 16), /closed/);
});

for (const drift of ["ancestor-symlink", "directory-replacement", "ancestor-mode", "hardlink"]) {
	test(`operation-scoped directory reader rejects ${drift} between files`, async () => {
		const { parent, root } = await fresh(drift);
		await writeFile(join(root, "input"), "bytes", { mode: 0o600 });
		await withPrivateDirectoryReader(root, async read => {
			assert.equal(await read("input", 16), "bytes");
			if (drift === "ancestor-symlink") {
				await rename(parent, `${parent}-retained`);
				await symlink(`${parent}-retained`, parent);
			} else if (drift === "directory-replacement") {
				await rename(root, `${root}-retained`);
				await mkdir(root, { mode: 0o700 });
				await writeFile(join(root, "input"), "bytes", { mode: 0o600 });
			} else if (drift === "ancestor-mode") {
				await chmod(parent, 0o755);
			} else {
				await link(join(root, "input"), join(root, "alias"));
			}
			await assert.rejects(read("input", 16), /ancestor changed|hard-linked/);
		});
	});
}

test("operation-scoped reader detects ancestor drift during an actual file read", async t => {
	const { parent, root } = await fresh("during-read");
	const path = join(root, "input");
	await writeFile(path, "bytes", { mode: 0o600 });
	const handle = await open(path, "r");
	const prototype = Object.getPrototypeOf(handle);
	const original = prototype.read;
	await handle.close();
	const entered = Promise.withResolvers(), release = Promise.withResolvers();
	let first = true;
	t.mock.method(prototype, "read", async function (...args) {
		const result = await original.apply(this, args);
		if (first) { first = false; entered.resolve(); await release.promise; }
		return result;
	});
	const operation = withPrivateDirectoryReader(root, read => read("input", 16))
		.then(() => undefined, error => error);
	await entered.promise;
	await rename(parent, `${parent}-retained`);
	await symlink(`${parent}-retained`, parent);
	release.resolve();
	assert.match((await operation).message, /ancestor changed/);
});


test("operation-scoped reader batches four concurrent reads and returns input order", async t => {
	const { root } = await fresh("batch-order");
	const names = ["four", "one", "three", "two"];
	for (const name of names)
		await writeFile(join(root, name), name, { mode: 0o600 });
	const handle = await open(join(root, names[0]), "r");
	const prototype = Object.getPrototypeOf(handle);
	const original = prototype.read;
	await handle.close();
	const release = Promise.withResolvers();
	let entered = 0, active = 0, peak = 0;
	t.mock.method(prototype, "read", async function (...args) {
		active++;
		peak = Math.max(peak, active);
		if (++entered === 4) release.resolve();
		await release.promise;
		try {
			return await original.apply(this, args);
		} finally {
			active--;
		}
	});
	await withPrivateDirectoryReader(root, async (_read, readBatch) => {
		assert.deepEqual(await readBatch(names, 16), names);
	});
	assert.equal(peak, 4);
});

test("operation-scoped reader rejects invalid batches before any file open or supplied behavior", async t => {
	const { root } = await fresh("batch-invalid");
	for (const name of ["a", "b", "c", "d", "e"])
		await writeFile(join(root, name), name, { mode: 0o600 });
	const originalOpen = fsPromises.open;
	let callbackStarted = false, fileOpens = 0, invoked = 0;
	t.mock.method(fsPromises, "open", (...args) => {
		if (callbackStarted) fileOpens++;
		return originalOpen(...args);
	});
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	const accessor = Object.defineProperty(["a"], "0", {
		configurable: true,
		enumerable: true,
		get() { invoked++; return "a"; },
	});
	const proxy = new Proxy(["a"], {
		get() { invoked++; return ["a"]; },
		ownKeys() { invoked++; return ["0", "length"]; },
	});
	await withPrivateDirectoryReader(root, async (_read, readBatch) => {
		callbackStarted = true;
		for (const [names, limit, pattern] of [
			[[], 16, /1 to 4/],
			[["a", "b", "c", "d", "e"], 16, /1 to 4/],
			[["a", "a"], 16, /unique/],
			[["../a"], 16, /one file name/],
			[["a"], 0, /size limit/],
			[accessor, 16, /own data/],
			[proxy, 16, /1 to 4/],
		]) await assert.rejects(readBatch(names, limit), pattern);
	});
	assert.equal(invoked, 0);
	assert.equal(fileOpens, 0);
});

test("operation-scoped reader admits only one serial or batch operation at a time", async t => {
	const { root } = await fresh("batch-busy");
	for (const name of ["a", "b"])
		await writeFile(join(root, name), name, { mode: 0o600 });
	const originalOpen = fsPromises.open;
	const serialEntered = Promise.withResolvers();
	const serialRelease = Promise.withResolvers();
	const batchEntered = Promise.withResolvers();
	const batchRelease = Promise.withResolvers();
	t.mock.method(fsPromises, "open", async (path, ...args) => {
		if (resolve(path) === join(root, "a")) {
			serialEntered.resolve();
			await serialRelease.promise;
		} else if (resolve(path) === join(root, "b")) {
			batchEntered.resolve();
			await batchRelease.promise;
		}
		return originalOpen(path, ...args);
	});
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	await withPrivateDirectoryReader(root, async (read, readBatch) => {
		const serial = read("a", 16);
		await serialEntered.promise;
		await assert.rejects(readBatch(["b"], 16), /busy/);
		serialRelease.resolve();
		assert.equal(await serial, "a");
		const batch = readBatch(["b"], 16);
		await batchEntered.promise;
		await assert.rejects(read("a", 16), /busy/);
		batchRelease.resolve();
		assert.deepEqual(await batch, ["b"]);
	});
});

test("an expired asynchronous batch callback rejects before opening a file", async t => {
	const { root } = await fresh("batch-expired");
	await writeFile(join(root, "a"), "a", { mode: 0o600 });
	const originalOpen = fsPromises.open;
	let escaped, completed = false, lateOpens = 0;
	t.mock.method(fsPromises, "open", (...args) => {
		if (completed && resolve(args[0]) === join(root, "a")) lateOpens++;
		return originalOpen(...args);
	});
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	await withPrivateDirectoryReader(root, async (_read, readBatch) => {
		escaped = readBatch;
	});
	completed = true;
	await assert.rejects(escaped(["a"], 16), /closed/);
	assert.equal(lateOpens, 0);
});

test("operation-scoped reader drains a detached failed batch before closing its root", async t => {
	const { root } = await fresh("batch-detached");
	const canonicalRoot = await fsPromises.realpath(root);
	await writeFile(join(root, "a"), "a", { mode: 0o600 });
	const originalOpen = fsPromises.open;
	const entered = Promise.withResolvers(), release = Promise.withResolvers();
	const failure = new Error("held batch failure");
	let rootClosed = false, finished = false, reading;
	t.mock.method(fsPromises, "open", async (path, ...args) => {
		const handle = await originalOpen(path, ...args);
		if (resolve(path) === canonicalRoot) {
			const close = handle.close.bind(handle);
			handle.close = async () => {
				rootClosed = true;
				return close();
			};
		} else if (resolve(path) === join(root, "a")) {
			await handle.close();
			entered.resolve();
			await release.promise;
			throw failure;
		}
		return handle;
	});
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	const operation = withPrivateDirectoryReader(root, async (_read, readBatch) => {
		reading = readBatch(["a"], 16);
		await entered.promise;
	}).then(() => { finished = true; }, error => { finished = true; return error; });
	await entered.promise;
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(finished, false);
	assert.equal(rootClosed, false);
	release.resolve();
	assert.strictEqual(await operation, failure);
	assert.equal(rootClosed, true);
	await assert.rejects(reading, error => error === failure);
});

test("batch reads retain every failure and do not reject while another member is held", async t => {
	const { root } = await fresh("batch-failures");
	for (const name of ["a", "b", "c"])
		await writeFile(join(root, name), name, { mode: 0o600 });
	const originalOpen = fsPromises.open;
	const held = Promise.withResolvers(), release = Promise.withResolvers();
	const first = new Error("first batch failure");
	const second = new Error("second batch failure");
	t.mock.method(fsPromises, "open", async (path, ...args) => {
		if (resolve(path) === join(root, "a")) throw first;
		if (resolve(path) === join(root, "b")) {
			held.resolve();
			await release.promise;
			throw second;
		}
		return originalOpen(path, ...args);
	});
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	await withPrivateDirectoryReader(root, async (_read, readBatch) => {
		let settled = false;
		const reading = readBatch(["a", "b", "c"], 16);
		void reading.then(() => { settled = true; }, () => { settled = true; });
		await held.promise;
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(settled, false);
		release.resolve();
		await assert.rejects(reading, error => {
			assert.equal(error instanceof AggregateError, true);
			assert.deepEqual(error.errors, [first, second]);
			assert.equal(error.message, first.message);
			return true;
		});
	});
});

test("concurrent batch reads all reject ancestor drift against the pinned closure", async t => {
	const { parent, root } = await fresh("batch-drift");
	const names = ["a", "b", "c", "d"];
	for (const name of names)
		await writeFile(join(root, name), name, { mode: 0o600 });
	const handle = await open(join(root, "a"), "r");
	const prototype = Object.getPrototypeOf(handle);
	const original = prototype.read;
	await handle.close();
	const entered = Promise.withResolvers(), release = Promise.withResolvers();
	let reads = 0;
	t.mock.method(prototype, "read", async function (...args) {
		const result = await original.apply(this, args);
		if (++reads === 4) entered.resolve();
		await release.promise;
		return result;
	});
	await withPrivateDirectoryReader(root, async (_read, readBatch) => {
		const reading = readBatch(names, 16);
		await entered.promise;
		await rename(parent, `${parent}-retained`);
		await symlink(`${parent}-retained`, parent);
		release.resolve();
		await assert.rejects(reading, error => {
			assert.equal(error instanceof AggregateError, true);
			assert.equal(error.errors.length, 4);
			for (const failure of error.errors)
				assert.match(failure.message, /ancestor changed/);
			return true;
		});
	});
});


test("journal replay reuses canonical record text without changing body hash identity", async () => {
	const { root, journal } = await fresh("canonical-record");
	const snapshot = await journal.append(
		{ seq: 0, hash: ZERO },
		{
			kind: "original",
			hash: "payload-root",
			nested: { hash: "payload-nested", value: "값🙂" },
		},
	);
	const path = join(root, "0000000001.json");
	const stored = JSON.parse(await readFile(path, "utf8"));
	const { hash: storedHash, ...body } = stored;
	const independentlyComputedHash = goalHash(body);
	assert.equal(storedHash, independentlyComputedHash);
	assert.equal(snapshot.head.hash, independentlyComputedHash);

	const reorderedAndEscaped =
		`{"version":1,"se\\u0071":1,"previous\\u0048ash":"${ZERO}",` +
		`"payload":{"nested":{"value":"값🙂","ha\\u0073h":"payload-nested"},` +
		`"kind":"original","ha\\u0073h":"payload-root"},` +
		`"ha\\u0073h":"${independentlyComputedHash}"}`;
	await writeFile(path, reorderedAndEscaped);
	const loaded = await (await GoalHostJournal.open(root)).load();
	assert.deepEqual(loaded, snapshot);
	assert.equal(loaded.records[0].hash, independentlyComputedHash);
});

test("journal replay preserves record schema and hash rejection precedence", async t => {
	for (const [label, mutate, pattern] of [
		[
			"altered-body",
			record => { record.payload.value = "altered"; },
			/hash mismatch/,
		],
		[
			"altered-hash",
			record => { record.hash = "f".repeat(64); },
			/hash mismatch/,
		],
		[
			"unknown-field-before-invalid-hash",
			record => {
				record.unknown = true;
				record.hash = "invalid";
			},
			/unknown\/missing key/,
		],
	]) await t.test(label, async () => {
		const { root, journal } = await fresh(`canonical-${label}`);
		await journal.append({ seq: 0, hash: ZERO }, { value: "original" });
		const path = join(root, "0000000001.json");
		const record = JSON.parse(await readFile(path, "utf8"));
		mutate(record);
		await writeFile(path, JSON.stringify(record));
		await assert.rejects(GoalHostJournal.open(root), pattern);
	});
});

test("journal replay reads record chunks at width four and preserves the exact snapshot", async t => {
	const { root, journal } = await fresh("batch-journal");
	let expected = await journal.load();
	for (let seq = 1; seq <= 9; seq++)
		expected = await journal.append(expected.head, { seq, marker: `record-${seq}` });
	const originalOpen = fsPromises.open;
	let attempts = 0, active = 0, peak = 0;
	let wave = [];
	t.mock.method(fsPromises, "open", async (path, ...args) => {
		if (!/^\d{10}\.json$/.test(String(path).split("/").at(-1)))
			return originalOpen(path, ...args);
		attempts++;
		active++;
		peak = Math.max(peak, active);
		const barrier = Promise.withResolvers();
		wave.push(barrier);
		if (wave.length === 4 || attempts === 9) {
			const admitted = wave;
			wave = [];
			for (const member of admitted) member.resolve();
		}
		await barrier.promise;
		try {
			return await originalOpen(path, ...args);
		} finally {
			active--;
		}
	});
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	assert.deepEqual(await journal.load(), expected);
	assert.equal(attempts, 9);
	assert.equal(peak, 4);
});

test("a failed journal chunk drains every admitted read, retains evidence, and poisons the writer", async t => {
	const { root, journal } = await fresh("batch-journal-failure");
	let snapshot = await journal.load();
	for (let seq = 1; seq <= 5; seq++)
		snapshot = await journal.append(snapshot.head, { seq });
	const before = await retainedTree(root);
	const originalOpen = fsPromises.open;
	const held = Promise.withResolvers(), release = Promise.withResolvers();
	const first = new Error("first record read failed");
	const second = new Error("held record read failed");
	let settled = false;
	t.mock.method(fsPromises, "open", async (path, ...args) => {
		const name = String(path).split("/").at(-1);
		if (name === "0000000001.json") throw first;
		if (name === "0000000002.json") {
			held.resolve();
			await release.promise;
			throw second;
		}
		return originalOpen(path, ...args);
	});
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	const loading = journal.load();
	void loading.then(() => { settled = true; }, () => { settled = true; });
	await held.promise;
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(settled, false);
	release.resolve();
	await assert.rejects(loading, error => {
		assert.match(error.message, /failed closed/);
		assert.equal(error.cause instanceof AggregateError, true);
		assert.deepEqual(error.cause.errors, [first, second]);
		return true;
	});
	assert.deepEqual(await retainedTree(root), before);
	await assert.rejects(journal.load(), /poisoned/);
	assert.deepEqual(await retainedTree(root), before);
});

test("a crash after record publication deterministically exposes exactly one contiguous adopted head", async () => {
	const { root, journal } = await fresh("record-before-manifest");
	setGoalHostJournalCrashHookForTests((point) => {
		if (point === "after-record-before-manifest")
			throw new Error("simulated record/manifest crash");
	});
	try {
		await assert.rejects(
			journal.append({ seq: 0, hash: ZERO }, { durable: "request" }),
			/simulated record\/manifest crash/,
		);
	} finally {
		setGoalHostJournalCrashHookForTests(undefined);
	}
	const manifest = JSON.parse(
		await readFile(join(root, "manifest.json"), "utf8"),
	);
	assert.equal(manifest.head.seq, 0);
	const adopted = await (await GoalHostJournal.open(root)).load();
	assert.equal(adopted.head.seq, 1);
	assert.equal(adopted.records[0].payload.durable, "request");
	assert.equal(
		(await readdir(root)).filter((name) => /^\d{10}\.json$/.test(name)).length,
		1,
	);
});

test("root admission is absolute and create never adopts or replaces an existing exact root", async () => {
	await assert.rejects(GoalHostJournal.create("relative/journal"), /absolute/);
	await assert.rejects(GoalHostJournal.open("relative/journal"), /absolute/);
	const parent = await mkdtemp(join(suiteRoot, "existing-"));
	const root = join(parent, "journal");
	await mkdir(root, { mode: 0o700 });
	await writeFile(join(root, "owned-evidence"), "retain", { mode: 0o600 });
	await assert.rejects(GoalHostJournal.create(root), /already exists/);
	assert.equal(await readFile(join(root, "owned-evidence"), "utf8"), "retain");
});

test("expected head mismatch and oversized input reject before publication", async () => {
	const { root, journal } = await fresh("admission");
	const initial = await journal.load();
	const before = await retainedTree(root);
	await assert.rejects(
		journal.append({ seq: 0, hash: "1".repeat(64) }, { nope: true }),
		/expected head conflict/,
	);
	await assert.rejects(
		journal.append({ seq: 1, hash: ZERO }, { nope: true }),
		/expected head conflict/,
	);
	const oversized = Object.fromEntries(
		Array.from({ length: 18 }, (_, index) => [
			`part${index}`,
			"x".repeat(16_000),
		]),
	);
	await assert.rejects(journal.append(initial.head, oversized), /byte limit/);
	assert.deepEqual(await retainedTree(root), before);
	assert.deepEqual(await journal.load(), initial);
});

test("journal payload constraints reject before publication without invoking supplied behavior", async t => {
	let invoked = 0;
	const accessor = Object.defineProperty({}, "field", {
		enumerable: true, get() { invoked++; return "forbidden"; },
	});
	const proxy = new Proxy({}, { ownKeys() { invoked++; return []; } });
	const deep = Array.from({ length: 26 }).reduce(value => ({ value }), {});
	for (const [label, payload, pattern] of [
		["accessor", accessor, /accessor/],
		["proxy", proxy, /non-data/],
		["symbol", { [Symbol("field")]: 1 }, /symbol/],
		["prototype", Object.create({ inherited: true }), /prototype/],
		["integer", { value: Number.MAX_SAFE_INTEGER + 1 }, /non-data/],
		["string", { value: "x".repeat(16385) }, /string limit/],
		["encoding", { value: "\uD800" }, /string limit\/encoding/],
		["depth", deep, /complexity limit/],
		["array", [], /payload must be an object/],
		["null", null, /payload must be an object/],
	]) await t.test(label, async () => {
		const { root, journal } = await fresh(label);
		const before = await retainedTree(root);
		await assert.rejects(journal.append({ seq: 0, hash: ZERO }, payload), pattern);
		assert.deepEqual(await retainedTree(root), before);
		assert.equal(invoked, 0);
	});
});

test("journal replay validates fresh nested payload bytes before accepting their hash", async () => {
	const { root, journal } = await fresh("replay-payload-limit");
	await journal.append({ seq: 0, hash: ZERO }, { value: "valid" });
	await expectRetainedFailure(root, async () => {
		const path = join(root, "0000000001.json");
		const record = JSON.parse(await readFile(path, "utf8"));
		record.payload.value = "x".repeat(16385);
		await writeFile(path, JSON.stringify(record));
	}, /invalid JSON data|string limit/);
});


test("restart exposes only immutable read access, never a reconstructable writer", async () => {
	const { root, journal } = await fresh("read-only-restart");
	await appendTwo(journal);
	const reader = await GoalHostJournal.open(root);
	assert.deepEqual(Object.keys(reader), ["load"]);
	assert.equal(reader.append, undefined);
	assert.equal(Object.isFrozen(reader), true);
	assert.throws(() => new GoalHostJournal(root, {}, "a".repeat(64)), /private/);
	await assert.rejects(GoalHostJournal.create(root), /already exists/);
});

test("live writer and reader pin a previously observed complete head against coherent rollback", async () => {
	const { root, journal } = await fresh("rollback-pin");
	const first = await journal.append({ seq: 0, hash: ZERO }, { first: true });
	const oldManifest = await readFile(join(root, "manifest.json"));
	await journal.append(first.head, { newerDenial: true });
	const reader = await GoalHostJournal.open(root);
	await rm(join(root, "0000000002.json"));
	await writeFile(join(root, "manifest.json"), oldManifest);
	await assert.rejects(journal.load(), /rolled back|forked/);
	await assert.rejects(reader.load(), /rolled back|forked/);
	// A new read may expose old internally consistent bytes, NOT current authority.
	const historical = await GoalHostJournal.open(root);
	assert.equal((await historical.load()).head.seq, 1);
	assert.equal(historical.append, undefined);
});

test("competing fresh creators cannot adopt each other's nonempty initialized root", async () => {
	const parent = await mkdtemp(join(suiteRoot, "create-race-"));
	const root = join(parent, "journal");
	const results = await Promise.allSettled([
		GoalHostJournal.create(root),
		GoalHostJournal.create(root),
	]);
	assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
	assert.equal(results.filter((r) => r.status === "rejected").length, 1);
	assert.equal((await (await GoalHostJournal.open(root)).load()).head.seq, 0);
});

for (const corruption of [
	"record-hash",
	"chain",
	"gap",
	"omission",
	"manifest-head",
]) {
	test(`${corruption} fails closed without deleting or rewriting evidence`, async () => {
		const { root, journal } = await fresh(`corrupt-${corruption}`);
		await appendTwo(journal);
		await expectRetainedFailure(
			root,
			async () => {
				const firstPath = join(root, "0000000001.json");
				const secondPath = join(root, "0000000002.json");
				if (corruption === "record-hash") {
					const record = JSON.parse(await readFile(firstPath, "utf8"));
					record.payload.count = 2;
					await writeFile(firstPath, JSON.stringify(record));
				} else if (corruption === "chain") {
					const record = JSON.parse(await readFile(secondPath, "utf8"));
					record.previousHash = "a".repeat(64);
					const { hash: _oldHash, ...body } = record;
					record.hash = goalHash(body);
					await writeFile(secondPath, JSON.stringify(record));
				} else if (corruption === "gap") {
					await rename(firstPath, join(root, "0000000003.json"));
				} else if (corruption === "omission") {
					await unlink(secondPath);
				} else {
					const path = join(root, "manifest.json");
					const value = JSON.parse(await readFile(path, "utf8"));
					value.head.hash = "b".repeat(64);
					await writeFile(path, JSON.stringify(value));
				}
			},
			/(hash|chain|gap|census|head)/,
		);
	});
}

test("symlink, hardlink, private-mode, and root-mode violations fail closed", async (t) => {
	await t.test("record symlink", async () => {
		const { root, journal } = await fresh("symlink");
		await journal.append({ seq: 0, hash: ZERO }, { ok: true });
		const record = join(root, "0000000001.json");
		const saved = join(dirname(root), "saved-record");
		await rename(record, saved);
		await symlink(saved, record);
		const before = await retainedTree(root);
		await assert.rejects(GoalHostJournal.open(root), /regular file|stable/);
		assert.deepEqual(await retainedTree(root), before);
	});
	await t.test("manifest hardlink", async () => {
		const { root } = await fresh("hardlink");
		await link(
			join(root, "manifest.json"),
			join(root, "manifest.json.12345678-1234-4123-8123-123456789abc.tmp"),
		);
		const before = await retainedTree(root);
		await assert.rejects(GoalHostJournal.open(root), /hard-linked|residue/);
		assert.deepEqual(await retainedTree(root), before);
	});
	await t.test("record permissions", async () => {
		const { root, journal } = await fresh("file-mode");
		await journal.append({ seq: 0, hash: ZERO }, { ok: true });
		await chmod(join(root, "0000000001.json"), 0o644);
		await assert.rejects(GoalHostJournal.open(root), /mode 0600/);
	});
	await t.test("root permissions", async () => {
		const { root } = await fresh("root-mode");
		await chmod(root, 0o755);
		try {
			await assert.rejects(GoalHostJournal.open(root), /mode 0700/);
		} finally {
			await chmod(root, 0o700);
		}
	});
});

test("an opened instance detects exact-root replacement and cannot adopt replacement JSON identity", async () => {
	const { parent, root, journal } = await fresh("replacement");
	await journal.append({ seq: 0, hash: ZERO }, { original: true });
	const displaced = join(parent, "displaced");
	await rename(root, displaced);
	const replacement = await GoalHostJournal.create(root);
	await replacement.append({ seq: 0, hash: ZERO }, { replacement: true });
	await assert.rejects(journal.load(), /failed closed/);
	await assert.rejects(journal.load(), /poisoned/);
	assert.equal((await replacement.load()).records[0].payload.replacement, true);
	assert.equal(
		(await (await GoalHostJournal.open(displaced)).load()).records[0].payload
			.original,
		true,
	);
});

test("unknown and explicitly recognized transaction residue are retained and reject census", async (t) => {
	for (const [label, name, pattern] of [
		["unknown", "foreign.txt", /unknown entry/],
		[
			"residue",
			"0000000001.json.12345678-1234-4123-8123-123456789abc.tmp",
			/transaction residue retained/,
		],
	]) {
		await t.test(label, async () => {
			const { root } = await fresh(`entry-${label}`);
			await writeFile(join(root, name), "retained crash evidence", {
				mode: 0o600,
			});
			const before = await retainedTree(root);
			await assert.rejects(GoalHostJournal.open(root), pattern);
			assert.deepEqual(await retainedTree(root), before);
		});
	}
});

test("record census count is bounded before record content allocation", async () => {
	const { root } = await fresh("count-bound");
	for (let seq = 1; seq <= 4097; seq++) {
		await writeFile(
			join(root, `${String(seq).padStart(10, "0")}.json`),
			"not allocated as record JSON",
			{ mode: 0o600 },
		);
	}
	await assert.rejects(GoalHostJournal.open(root), /record census|record limit/);
	assert.equal((await readdir(root)).length, 4098);
});

test("aggregate census byte bound rejects a sparse residue before content allocation and retains it", async () => {
	const { root } = await fresh("aggregate");
	const residue = join(
		root,
		"0000000001.json.12345678-1234-4123-8123-123456789abc.tmp",
	);
	const handle = await open(residue, "wx", 0o600);
	try {
		await handle.truncate(64 * 1024 * 1024 + 1);
	} finally {
		await handle.close();
	}
	await assert.rejects(GoalHostJournal.open(root), /aggregate byte limit/);
	assert.equal((await lstat(residue)).size, 64 * 1024 * 1024 + 1);
});
