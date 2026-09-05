import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { startRpcSession } from "./surface-rpc-harness.mjs";

const REAL_CLI = resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const EXTENSION = resolve("src/extension.ts");

async function fixture(t) {
	const cwd = await mkdtemp(join(tmpdir(), "surface-rpc-readiness-"));
	const home = join(cwd, "home"), agent = join(home, "agent");
	await mkdir(agent, { recursive: true });
	let session;
	t.after(async () => {
		if (session) await session.close();
		await rm(cwd, { recursive: true, force: true });
	});
	return {
		cwd,
		start(args, command = process.execPath) {
			assert.equal(session, undefined, "one owned process per fixture");
			session = startRpcSession({ command, args, cwd, env: {
				PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: agent,
				PI_OFFLINE: "1", PI_WORKFLOW_ROLE: "parent",
			} });
			return session;
		},
	};
}

// --import delays the real CLI in the SAME PID: no wrapper/grandchild can outlive
// session.close(), and a signalled real Pi cannot be translated into exit zero.
async function delayedCliArgs(cwd, delay) {
	const preload = join(cwd, "delay.mjs"), guard = join(cwd, "guard.ts");
	await writeFile(preload, `await new Promise(resolve => setTimeout(resolve, ${delay}));\n`);
	await writeFile(guard, `export default function(pi) {
 pi.on('before_provider_request', () => { throw new Error('MODEL_CALL_FORBIDDEN'); });
 }`);
	return ["--import", pathToFileURL(preload).href, REAL_CLI, "--mode", "rpc",
		"--no-session", "--offline", "--no-extensions", "--no-skills",
		"--no-prompt-templates", "--no-themes", "--no-context-files", "--no-tools",
		"-e", EXTENSION, "-e", guard];
}

const isReady = (event) => event.id === "ready";
const idleScript = 'process.stdin.resume(); setInterval(() => {}, 1000);';

test("delayed real Pi startup becomes ready and cleanup joins that same process", { timeout: 60000 }, async (t) => {
	const f = await fixture(t);
	const session = f.start(await delayedCliArgs(f.cwd, 1500));
	session.send({ id: "commands", type: "get_commands" });
	const commands = await session.waitFor((e) => e.id === "commands", { budget: 30000, label: "delayed startup" });
	assert.equal(commands.success, true);
	assert.ok(commands.data.commands.some((c) => c.name === "workflow"));
	assert.equal(session.events.some((e) => e.type === "agent_start"), false);
	assert.doesNotMatch(session.stderr, /MODEL_CALL_FORBIDDEN/);
	const terminal = await session.close();
	assert.ok(terminal.code !== null || terminal.signal !== null, "real Pi closed after readiness");
	assert.deepEqual(await session.exited, terminal);
});

test("startup exceeding its budget fails with captured empty events and stderr", { timeout: 30000 }, async (t) => {
	const f = await fixture(t);
	const session = f.start(await delayedCliArgs(f.cwd, 20000));
	session.send({ id: "commands", type: "get_commands" });
	await assert.rejects(session.waitFor((e) => e.id === "commands", { budget: 200, label: "tight startup" }), (error) => {
		assert.match(error.message, /tight startup: no matching event within 200ms/);
		assert.match(error.message, /"events":\[\],"stderr":""/);
		return true;
	});
});

test("observed early exit reports code and drained stderr instead of a timeout", { timeout: 30000 }, async (t) => {
	const f = await fixture(t);
	const session = f.start(["-e", "process.stderr.write('STARTUP_FATAL'); process.exitCode = 7;"]);
	await session.exited;
	await assert.rejects(session.waitFor(isReady, { budget: 10000, label: "early exit" }), (error) => {
		assert.match(error.message, /subprocess exited early \(code=7/);
		assert.match(error.message, /STARTUP_FATAL/);
		return true;
	});
});

test("never-ready process fails within its startup budget and is joined", { timeout: 30000 }, async (t) => {
	const f = await fixture(t);
	const session = f.start(["-e", idleScript]);
	await assert.rejects(session.waitFor(isReady, { budget: 200, label: "never ready" }), /never ready: no matching event within 200ms/);
	const terminal = await session.close();
	assert.ok(terminal.code !== null || terminal.signal !== null);
});

test("missing executable yields a spawn diagnostic and settled cleanup", { timeout: 30000 }, async (t) => {
	const f = await fixture(t);
	const session = f.start([], join(f.cwd, "missing-executable"));
	await assert.rejects(session.waitFor(isReady, { budget: 10000, label: "spawn" }), /subprocess\/pipe error:.*ENOENT/);
	const terminal = await session.close();
	assert.notEqual(terminal.code, 0);
});

test("closed child stdin yields a pipe diagnostic without an unhandled error", { timeout: 30000 }, async (t) => {
	const f = await fixture(t);
	const session = f.start(["-e", 'require("node:fs").closeSync(0); process.stdout.write(\'{"id":"ready"}\\n\'); setInterval(() => {}, 1000);']);
	await session.waitFor(isReady, { budget: 30000, label: "closed stdin readiness" });
	session.send({ id: "unanswered", type: "get_commands" });
	await assert.rejects(session.waitFor((e) => e.id === "unanswered", { budget: 10000, label: "closed stdin" }), /subprocess\/pipe error:.*EPIPE/);
});

test("post-ready response keeps its separate bounded operation deadline", { timeout: 30000 }, async (t) => {
	const f = await fixture(t);
	const session = f.start(["-e", 'process.stdout.write(\'{"id":"ready"}\\n\');' + idleScript]);
	await session.waitFor(isReady, { budget: 30000, label: "readiness" });
	session.send({ id: "unanswered", type: "get_commands" });
	await assert.rejects(session.waitFor((e) => e.id === "unanswered", { budget: 200, label: "operation" }), /operation: no matching event within 200ms/);
});

test("cleanup escalates an already-ready SIGTERM-ignoring process and joins close", { timeout: 30000 }, async (t) => {
	const f = await fixture(t);
	const session = f.start(["-e", 'process.on("SIGTERM", () => {}); process.stdout.write(\'{"id":"ready"}\\n\');' + idleScript]);
	await session.waitFor(isReady, { budget: 30000, label: "signal handler readiness" });
	const terminal = await session.close({ graceMs: 100 });
	assert.equal(terminal.signal, "SIGKILL");
	assert.deepEqual(await session.exited, terminal);
});
