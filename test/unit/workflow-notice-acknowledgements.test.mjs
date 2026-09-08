import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	mkdtemp,
	mkdir,
	readFile,
	writeFile,
	readdir,
	realpath,
	rm,
	symlink,
	link,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import extension, {
	notifyUnfinishedRuns,
	WORKFLOW_KNOWN_ACTIONS,
} from "../../.tmp/unit/extension.js";
import { WORKFLOW_HELP } from "../../.tmp/unit/index.js";
import {
	executeWorkflowNoticesCommand as command,
	parseWorkflowNoticesArgs,
} from "../../.tmp/unit/workflow-notices.js";
import {
	readRunRecord,
	setRunLeaseTestHooksForTests,
} from "../../.tmp/unit/store.js";

const exec = promisify(execFile);
const cli = resolve("src/cli.mjs");
const sidecarName = "notice-acknowledgements.json";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const env = { ...process.env, PI_WORKFLOW_ROLE: "supervisor" };

async function project(t) {
	const cwd = await realpath(
		await mkdtemp(join(tmpdir(), "workflow-notice-ack-")),
	);
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await mkdir(join(cwd, ".pi", "workflows"), { recursive: true });
	return cwd;
}
const root = (cwd) => join(cwd, ".pi", "workflows");
const sidecar = (cwd) => join(root(cwd), sidecarName);
const runFile = (cwd, id) => join(root(cwd), id, "run.json");
async function fixture(cwd, id, overrides = {}) {
	const status = overrides.status ?? "failed";
	const updatedAt = new Date(Date.now() - 60_000).toISOString();
	const run = {
		schemaVersion: 1,
		runId: id,
		name: "notice fixture",
		type: "artifact-graph",
		status,
		cwd,
		createdAt: updatedAt,
		updatedAt,
		specPath: "fixture.json",
		backend: { type: "local-pi", mode: "headless" },
		tasks: [
			{
				taskId: "task-1",
				specId: "task-1",
				displayName: "fixture",
				agent: "scout",
				status,
				statusDetail: status,
				backendTaskId: "",
				files: {},
			},
		],
		...overrides,
	};
	await mkdir(join(root(cwd), id, "attempts"), { recursive: true });
	await writeFile(runFile(cwd, id), JSON.stringify(run));
	await writeFile(
		join(root(cwd), id, "attempts", "raw.md"),
		"original fixture evidence\n",
	);
	return run;
}
async function list(cwd) {
	return JSON.parse(await command(cwd, ["list", "--json"]));
}
async function ack(
	cwd,
	id,
	reason = "Reviewed; preserve without further work",
) {
	const run = (await list(cwd)).notices.find((run) => run.runId === id);
	assert.ok(run);
	await command(cwd, [
		"acknowledge",
		id,
		"--state",
		run.sha256,
		"--reason",
		reason,
	]);
	return run;
}
async function warnings(cwd, now = Date.now()) {
	const messages = [];
	await notifyUnfinishedRuns(
		cwd,
		(message, level) => {
			assert.equal(level, "warning");
			messages.push(message);
		},
		now,
	);
	return messages.join("\n");
}
async function hashes(directory) {
	const result = {};
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) Object.assign(result, await hashes(path));
		else result[path] = digest(await readFile(path));
	}
	return result;
}
async function slash(cwd, text) {
	let handler;
	extension({
		on() {},
		registerTool() {},
		registerCommand(name, definition) {
			assert.equal(name, "workflow");
			handler = definition.handler;
		},
	});
	const output = [];
	await handler(text, {
		cwd,
		hasUI: true,
		ui: {
			notify(text, level) {
				output.push({ text, level });
			},
		},
	});
	assert.equal(output.length, 1);
	return output[0];
}

test("notices list/ack/clear preserve all original files and leave status/inspect visible", async (t) => {
	const cwd = await project(t);
	await fixture(cwd, "workflow_preserved");
	await warnings(cwd, Date.now() - 1_000); // Existing index and notice timestamps are part of the baseline.
	const before = await hashes(root(cwd));
	const listed = await list(cwd);
	assert.equal(
		listed.notices[0].sha256,
		digest(await readFile(runFile(cwd, "workflow_preserved"))),
	);
	await ack(cwd, "workflow_preserved");
	assert.equal((await list(cwd)).acknowledgements[0].active, true);
	assert.equal(
		(await readRunRecord(cwd, "workflow_preserved")).status,
		"failed",
	);
	const inspected = await exec(
		process.execPath,
		[cli, "inspect", "workflow_preserved", "--json"],
		{ cwd, env },
	);
	assert.equal(JSON.parse(inspected.stdout).status, "failed");
	await command(cwd, ["clear", "workflow_preserved"]);
	assert.deepEqual((await list(cwd)).acknowledgements, []);
	for (const [path, original] of Object.entries(before))
		assert.equal(digest(await readFile(path)), original, path);
	const added = Object.keys(await hashes(root(cwd))).filter(
		(path) => !(path in before),
	);
	assert.deepEqual(added, [sidecar(cwd)]);
	assert.match(
		await warnings(cwd, Date.now() + 7 * 60 * 60 * 1_000),
		/workflow_preserved/,
	);
});

test("only exact acknowledged failures, interruptions and eligible approval blocks are suppressed", async (t) => {
	const cwd = await project(t);
	await fixture(cwd, "workflow_failed");
	await fixture(cwd, "workflow_interrupted", { status: "interrupted" });
	await fixture(cwd, "workflow_blocked", {
		status: "blocked",
		parentRunId: "workflow_parent",
		tasks: [
			{
				taskId: "task-1",
				specId: "task-1",
				status: "blocked",
				statusDetail: "dynamic_ui_unavailable",
				files: {},
			},
		],
	});
	for (const id of [
		"workflow_failed",
		"workflow_interrupted",
		"workflow_blocked",
	])
		await ack(cwd, id);
	assert.equal(await warnings(cwd), "");
	await fixture(cwd, "workflow_new");
	const message = await warnings(cwd);
	assert.match(message, /workflow_new/);
	assert.doesNotMatch(
		message,
		/workflow_failed|workflow_interrupted|workflow_blocked/,
	);
	assert.equal((await list(cwd)).acknowledgements.length, 3);
});

for (const change of ["status", "updatedAt", "content"]) {
	test(`changed ${change} invalidates acknowledgement and returns to normal deduplication`, async (t) => {
		const cwd = await project(t);
		const id = "workflow_changed";
		const run = await fixture(cwd, id);
		await warnings(cwd, Date.now() - 1_000);
		const observed = await ack(cwd, id);
		assert.equal(await warnings(cwd), "");
		if (change === "status") {
			run.status = "interrupted";
			run.tasks[0].status = "interrupted";
		} else if (change === "updatedAt") run.updatedAt = new Date().toISOString();
		else
			run.tasks[0].lastMessage =
				"different failure with identical status/update timestamp";
		await writeFile(runFile(cwd, id), JSON.stringify(run));
		assert.equal((await list(cwd)).acknowledgements[0].active, false);
		await assert.rejects(
			command(cwd, [
				"acknowledge",
				id,
				"--state",
				observed.sha256,
				"--reason",
				"stale observation",
			]),
			/state changed/,
		);
		const now = Date.now() + 1_000;
		assert.match(await warnings(cwd, now), /workflow_changed/);
		assert.equal(await warnings(cwd, now + 1_000), "");
		await ack(cwd, id, "Reviewed changed state");
		assert.equal(await warnings(cwd, now + 7 * 60 * 60 * 1_000), "");
	});
}

test("ineligible runs and prefixes cannot be acknowledged; stale and unrelated entries survive clear", async (t) => {
	const cwd = await project(t);
	await fixture(cwd, "workflow_keep");
	const changing = await fixture(cwd, "workflow_stale");
	await ack(cwd, "workflow_keep");
	await ack(cwd, "workflow_stale");
	changing.tasks[0].lastMessage = "changed";
	await writeFile(runFile(cwd, "workflow_stale"), JSON.stringify(changing));
	const retained = (await list(cwd)).acknowledgements.find(
		(entry) => entry.runId === "workflow_stale",
	);
	await command(cwd, ["clear", "workflow_keep"]);
	assert.deepEqual((await list(cwd)).acknowledgements, [retained]);
	for (const [id, overrides] of [
		["workflow_done", { status: "completed" }],
		["workflow_running", { status: "running" }],
		["workflow_child", { parentRunId: "workflow_keep" }],
		["workflow_other_block", { status: "blocked" }],
		["workflow_mock", { provenance: { mode: "mock" } }],
	]) {
		await fixture(cwd, id, overrides);
		await assert.rejects(
			command(cwd, [
				"acknowledge",
				id,
				"--state",
				"a".repeat(64),
				"--reason",
				"reviewed",
			]),
			/not an eligible/,
		);
	}
	await assert.rejects(
		command(cwd, [
			"acknowledge",
			"workflow_sta",
			"--state",
			"a".repeat(64),
			"--reason",
			"reviewed",
		]),
	);
});

test("malformed/invalid sidecars never suppress and mutations preserve their exact bytes", async (t) => {
	const cwd = await project(t);
	await fixture(cwd, "workflow_invalid");
	await ack(cwd, "workflow_invalid");
	const valid = JSON.parse(await readFile(sidecar(cwd), "utf8"));
	const entry = valid.acknowledgements[0];
	const invalid = [
		"{broken",
		"null",
		"[]",
		JSON.stringify({ ...valid, schema: "future" }),
		...[
			{ ...entry, reason: "" },
			{ ...entry, sha256: "bad" },
			{ ...entry, status: "completed" },
			{ ...entry, updatedAt: "invalid" },
			{ ...entry, updatedAt: "1" },
			{ ...entry, acknowledgedAt: null },
			{ ...entry, runId: "../escape" },
			{ ...entry, unknownField: true },
		].map((value) => JSON.stringify({ ...valid, acknowledgements: [value] })),
		JSON.stringify({ ...valid, acknowledgements: [entry, entry] }),
		JSON.stringify({ ...valid, acknowledgements: [entry, { bad: true }] }),
	];
	let now = Date.now();
	for (const bytes of invalid) {
		await writeFile(sidecar(cwd), bytes);
		await assert.rejects(list(cwd));
		await assert.rejects(command(cwd, ["clear", "workflow_invalid"]));
		await assert.rejects(
			command(cwd, [
				"acknowledge",
				"workflow_invalid",
				"--state",
				entry.sha256,
				"--reason",
				"reviewed",
			]),
		);
		assert.equal(await readFile(sidecar(cwd), "utf8"), bytes);
		assert.match(await warnings(cwd, now), /workflow_invalid/);
		now += 7 * 60 * 60 * 1_000;
	}
});

test("independent concurrent CLI acknowledgements keep every entry and leave run evidence untouched", async (t) => {
	const cwd = await project(t);
	for (let index = 0; index < 8; index++)
		await fixture(cwd, `workflow_concurrent_${index}`);
	const before = await hashes(root(cwd));
	const notices = (await list(cwd)).notices;
	const outcomes = await Promise.allSettled(
		notices.map((run) =>
			exec(
				process.execPath,
				[
					cli,
					"notices",
					"acknowledge",
					run.runId,
					"--state",
					run.sha256,
					"--reason",
					`Explicit reason for ${run.runId}`,
				],
				{ cwd, env },
			),
		),
	);
	// Join every subprocess even on failure before test teardown removes its fixture.
	for (const outcome of outcomes)
		assert.equal(
			outcome.status,
			"fulfilled",
			outcome.status === "rejected" ? String(outcome.reason) : "",
		);
	const result = await list(cwd);
	assert.deepEqual(
		result.acknowledgements.map((entry) => entry.runId).sort(),
		notices.map((run) => run.runId).sort(),
	);
	assert.ok(
		result.acknowledgements.every(
			(entry) =>
				entry.active && entry.reason === `Explicit reason for ${entry.runId}`,
		),
	);
	for (const [path, original] of Object.entries(before))
		assert.equal(digest(await readFile(path)), original);
	assert.equal(await warnings(cwd), "");
});

test("ID/argument validation rejects paths, traversal, missing state/reason and extra options", () => {
	for (const id of [
		"../escape",
		"/absolute",
		"..",
		".",
		"a/b",
		"a\\b",
		"a\0b",
		"--all",
		"a:b",
		"a b",
	]) {
		assert.throws(() => parseWorkflowNoticesArgs(["clear", id]));
		assert.throws(() =>
			parseWorkflowNoticesArgs([
				"acknowledge",
				id,
				"--state",
				"a".repeat(64),
				"--reason",
				"reviewed",
			]),
		);
	}
	for (const args of [
		["list", "--all"],
		["clear", "workflow_a", "--all"],
		["acknowledge", "workflow_a"],
		["acknowledge", "workflow_a", "--state", "a".repeat(64), "--reason", ""],
		[
			"acknowledge",
			"workflow_a",
			"--state",
			"a".repeat(64),
			"--reason",
			"x".repeat(2_001),
		],
		[
			"acknowledge",
			"workflow_a",
			"--state",
			"a".repeat(64),
			"--reason",
			"unsafe\nreason",
		],
	])
		assert.throws(() => parseWorkflowNoticesArgs(args));
});

test("symlink and hard-link evidence escapes are rejected without touching valid targets", async (t) => {
	for (const target of [
		".pi",
		"workflows",
		"run-dir",
		"run-file",
		"sidecar",
		"lock",
		"hard-linked-run",
		"hard-linked-sidecar",
		"hard-linked-lock",
	]) {
		const cwd = await project(t);
		const outside = await project(t);
		await fixture(cwd, "workflow_escape");
		const observed = await ack(cwd, "workflow_escape");
		await fixture(outside, "workflow_escape");
		await writeFile(runFile(outside, "workflow_escape"), await readFile(runFile(cwd, "workflow_escape")));
		await writeFile(sidecar(outside), await readFile(sidecar(cwd)));
		const validDestination = await list(outside);
		assert.equal(validDestination.notices[0].sha256, observed.sha256);
		assert.equal(validDestination.acknowledgements[0].active, true);
		let path;
		let destination;
		let safetyError;
		if (target === ".pi") {
			path = join(cwd, ".pi");
			destination = join(outside, ".pi");
			safetyError = "Unsafe workflow notices root.";
		} else if (target === "workflows") {
			path = root(cwd);
			destination = root(outside);
			safetyError = "Unsafe workflow notices root.";
		} else if (target === "run-dir") {
			path = join(root(cwd), "workflow_escape");
			destination = join(root(outside), "workflow_escape");
			safetyError = "Unsafe workflow run directory.";
		} else if (target === "lock" || target === "hard-linked-lock") {
			path = `${sidecar(cwd)}.lock`;
			destination = `${sidecar(outside)}.lock`;
			await writeFile(destination, `${JSON.stringify({ pid: process.pid })}\n`);
			safetyError = "Unsafe notices lock.";
		} else {
			const isRun = target === "run-file" || target === "hard-linked-run";
			path = isRun ? runFile(cwd, "workflow_escape") : sidecar(cwd);
			destination = isRun ? runFile(outside, "workflow_escape") : sidecar(outside);
			safetyError = target.startsWith("hard-linked-") ? "Unsafe workflow notices file." : "ELOOP";
		}
		await rm(path, { recursive: true, force: true });
		if (target.startsWith("hard-linked-")) await link(destination, path);
		else await symlink(destination, path);
		const before = await hashes(outside);
		await assert.rejects(
			command(cwd, [
				"acknowledge",
				"workflow_escape",
				"--state",
				observed.sha256,
				"--reason",
				"reviewed",
			]),
			(error) => safetyError === "ELOOP" ? error.code === "ELOOP" : error.message === safetyError,
			target,
		);
		assert.deepEqual(await hashes(outside), before, target);
	}
});

test("slash/standalone commands share list, acknowledge, clear, errors and help registration", async (t) => {
	const cwd = await project(t);
	await fixture(cwd, "workflow_parity");
	assert.ok(WORKFLOW_KNOWN_ACTIONS.has("notices"));
	assert.match(WORKFLOW_HELP, /\/workflow notices acknowledge/);
	const cliList = await exec(
		process.execPath,
		[cli, "notices", "list", "--json"],
		{ cwd, env },
	);
	const slashList = await slash(cwd, "notices list --json");
	assert.equal(slashList.level, "info");
	assert.deepEqual(JSON.parse(slashList.text), JSON.parse(cliList.stdout));
	const state = JSON.parse(cliList.stdout).notices[0].sha256;
	assert.equal(
		(
			await slash(
				cwd,
				`notices acknowledge workflow_parity --state ${state} --reason "Explicit  parity reason"`,
			)
		).level,
		"info",
	);
	assert.equal(
		(await list(cwd)).acknowledgements[0].reason,
		"Explicit  parity reason",
	);
	assert.equal(
		(
			await slash(
				cwd,
				`notices acknowledge workflow_parity --state ${state} --reason "unterminated`,
			)
		).level,
		"error",
	);
	const cleared = await exec(
		process.execPath,
		[cli, "notices", "clear", "workflow_parity", "--json"],
		{ cwd, env },
	);
	assert.equal(JSON.parse(cleared.stdout).notificationOnly, true);
	await exec(
		process.execPath,
		[
			cli,
			"notices",
			"acknowledge",
			"workflow_parity",
			"--state",
			state,
			"--reason",
			"CLI parity reason",
		],
		{ cwd, env },
	);
	assert.equal(
		(await slash(cwd, "notices clear workflow_parity")).level,
		"info",
	);
	assert.deepEqual((await list(cwd)).acknowledgements, []);
	assert.equal((await slash(cwd, "notices clear ../escape")).level, "error");
	await assert.rejects(
		exec(process.execPath, [cli, "notices", "clear", "../escape"], { cwd, env }),
		(error) => error.code === 1,
	);
	await assert.rejects(
		exec(process.execPath, [cli, "notices", "list"], {
			cwd,
			env: { ...env, PI_WORKFLOW_ROLE: "worker" },
		}),
		/not allowed/,
	);
	assert.equal(
		(await readdir(root(cwd))).some(
			(name) => name.includes("supervisor") || name.includes("supervise"),
		),
		false,
	);
});

test("empty list is read-only and creates neither roots nor sidecars", async (t) => {
	const cwd = await project(t);
	const missing = join(cwd, "empty");
	await mkdir(missing);
	assert.deepEqual(await list(missing), {
		notices: [],
		acknowledgements: [],
		warnings: [],
	});
	assert.deepEqual(await readdir(missing), []);
});

for (const change of ["sidecar", "run"]) {
	test(`commit fence preserves concurrently changed ${change} evidence`, async (t) => {
		const cwd = await project(t);
		const id = "workflow_fenced";
		const run = await fixture(cwd, id);
		await ack(cwd, id);
		const observed = (await list(cwd)).notices[0];
		const originalSidecar = await readFile(sidecar(cwd), "utf8");
		const corrupt = "{concurrent invalid evidence";
		let injected = false;
		setRunLeaseTestHooksForTests({
			onBeforeAtomicRename: async ({ file }) => {
				if (file !== sidecar(cwd) || injected) return;
				injected = true;
				if (change === "sidecar") await writeFile(sidecar(cwd), corrupt);
				else {
					run.tasks[0].lastMessage = "Changed at the commit boundary";
					await writeFile(runFile(cwd, id), JSON.stringify(run));
				}
			},
		});
		try {
			await assert.rejects(
				command(cwd, [
					"acknowledge",
					id,
					"--state",
					observed.sha256,
					"--reason",
					"new reason",
				]),
				/changed/,
			);
			assert.ok(injected);
			assert.equal(
				await readFile(sidecar(cwd), "utf8"),
				change === "sidecar" ? corrupt : originalSidecar,
			);
			assert.equal(await readFile(runFile(cwd, id), "utf8"), JSON.stringify(run));
			assert.equal(
				(await readdir(root(cwd))).some(
					(name) => name.endsWith(".lock") || name.endsWith(".tmp"),
				),
				false,
			);
		} finally {
			setRunLeaseTestHooksForTests();
		}
	});
}
