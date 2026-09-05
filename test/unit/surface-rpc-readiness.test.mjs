import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { startRpcSession } from './surface-rpc-harness.mjs';

// Regression coverage for the RPC startup-readiness lifecycle. These cases pin
// the harness contract that hardens test/unit/surface-rpc.test.mjs against the
// 0.13.6 CI blocker (Ubuntu Node22.19: first get_commands wait timed out after
// 10s with an empty event stream under parallel load). They use controlled
// delayed-start, never-ready, and early-exit child processes plus the real
// locked Pi subprocess. They intentionally do not send provider credentials,
// model requests, or workflow launches.

const REAL_CLI = resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
const EXTENSION = resolve('src/extension.ts');

async function makeCwd() {
	const cwd = await mkdtemp(join(tmpdir(), 'surface-rpc-readiness-'));
	const home = join(cwd, 'home');
	const agent = join(home, 'agent');
	await mkdir(agent, { recursive: true });
	return { cwd, home, agent };
}

// A delayed-start shim: sleep, then exec the real locked Pi CLI with forwarded
// args. Demonstrates that a slow cold start within the startup allowance still
// succeeds, while a slow start beyond a tight operation budget would not.
async function writeDelayedShim(cwd) {
	const shim = join(cwd, 'delayed-cli.mjs');
	await writeFile(
		shim,
		`import { spawn } from 'node:child_process';\n` +
			`const delay = Number(process.env.DELAY_MS || '0');\n` +
			`const real = process.env.REAL_CLI;\n` +
			`setTimeout(() => { const c = spawn(process.execPath, [real, ...process.argv.slice(2)], { stdio: 'inherit' }); c.on('exit', (code) => process.exit(code ?? 0)); }, delay);\n`,
	);
	return shim;
}

async function writeGuard(cwd) {
	const guard = join(cwd, 'guard.ts');
	await writeFile(
		guard,
		`export default function(pi) {\n` +
			` pi.on('before_provider_request', () => { throw new Error('MODEL_CALL_FORBIDDEN'); });\n` +
			` pi.registerCommand('surface-exit', {handler: async (_args, ctx) => ctx.shutdown()});\n` +
			`}`,
	);
	return guard;
}

const cliArgs = (extension, guard) => [
	'--mode', 'rpc', '--no-session', '--offline', '--no-extensions', '--no-skills',
	'--no-prompt-templates', '--no-themes', '--no-context-files', '--no-tools',
	'-e', extension, '-e', guard,
];

const baseEnv = (home, agent) => ({
	PATH: process.env.PATH,
	HOME: home,
	PI_CODING_AGENT_DIR: agent,
	PI_OFFLINE: '1',
	PI_WORKFLOW_ROLE: 'parent',
});

// A deliberately delayed cold start still resolves under the startup-readiness
// allowance. The injected delay demonstrates the harness's sensitivity to boot
// latency; it is not a claim about any specific CI machine's root cause.
test('delayed cold start still becomes ready within the startup allowance', { timeout: 60000 }, async (t) => {
	const { cwd, home, agent } = await makeCwd();
	const shim = await writeDelayedShim(cwd);
	const guard = await writeGuard(cwd);
	const session = startRpcSession({
		command: process.execPath,
		args: [shim, ...cliArgs(EXTENSION, guard)],
		cwd,
		env: { ...baseEnv(home, agent), DELAY_MS: '1500', REAL_CLI: REAL_CLI },
	});
	t.after(async () => { await session.close(); await rm(cwd, { recursive: true, force: true }); });
	session.send({ id: 'commands', type: 'get_commands' });
	const commands = await session.waitFor((e) => e.id === 'commands', { budget: 30000, label: 'delayed startup readiness' });
	assert.equal(commands.success, true);
	assert.ok(commands.data.commands.some((c) => c.name === 'workflow'));
	session.send({ id: 'quit', type: 'prompt', message: '/surface-exit' });
	await session.exited;
});

// A tight operation budget must trip when a delayed start exceeds it, and the
// failure diagnostic must carry the captured (empty) event stream and stderr,
// exactly reproducing the CI blocker signature under controlled conditions.
test('a startup slower than the operation budget fails fast with an event/stderr diagnostic', { timeout: 30000 }, async (t) => {
	const { cwd, home, agent } = await makeCwd();
	const shim = await writeDelayedShim(cwd);
	const guard = await writeGuard(cwd);
	const session = startRpcSession({
		command: process.execPath,
		args: [shim, ...cliArgs(EXTENSION, guard)],
		cwd,
		env: { ...baseEnv(home, agent), DELAY_MS: '20000', REAL_CLI: REAL_CLI },
	});
	t.after(async () => { await session.close(); await rm(cwd, { recursive: true, force: true }); });
	session.send({ id: 'commands', type: 'get_commands' });
	await assert.rejects(
		session.waitFor((e) => e.id === 'commands', { budget: 1500, label: 'tight-budget startup' }),
		(error) => {
			assert.match(error.message, /tight-budget startup/);
			assert.match(error.message, /no matching event within 1500ms/);
			assert.match(error.message, /"events":\[\]/);
			assert.match(error.message, /"stderr":""/);
			return true;
		},
	);
});

// An early-exiting child must fail immediately (not burn the whole budget) and
// the diagnostic must surface exit code and captured stderr for triage.
test('early subprocess exit fails immediately with an exit-code diagnostic', { timeout: 30000 }, async (t) => {
	const { cwd, home, agent } = await makeCwd();
	const crasher = join(cwd, 'early-exit.mjs');
	await writeFile(crasher, `process.stderr.write('STARTUP_FATAL: simulated early exit\\n'); process.exit(7);`);
	const session = startRpcSession({
		command: process.execPath,
		args: [crasher],
		cwd,
		env: baseEnv(home, agent),
	});
	t.after(async () => { await session.close(); await rm(cwd, { recursive: true, force: true }); });
	session.send({ id: 'commands', type: 'get_commands' });
	const startedAt = Date.now();
	await assert.rejects(
		session.waitFor((e) => e.id === 'commands', { budget: 10000, label: 'early-exit startup' }),
		(error) => {
			assert.match(error.message, /early-exit startup/);
			assert.match(error.message, /subprocess exited early/);
			assert.match(error.message, /code=7/);
			assert.match(error.message, /STARTUP_FATAL: simulated early exit/);
			return true;
		},
	);
	assert.ok(Date.now() - startedAt < 5000, 'early exit must fail fast, not wait out the budget');
});

// A never-ready child must trip the bounded budget rather than hang, and the
// bounded cleanup must still join the child exit (SIGTERM->SIGKILL escalation).
test('a never-ready subprocess trips the bounded budget and cleanup joins its exit', { timeout: 30000 }, async (t) => {
	const { cwd, home, agent } = await makeCwd();
	const idler = join(cwd, 'never-ready.mjs');
	await writeFile(idler, `process.stdin.resume(); setInterval(() => {}, 1 << 30);`);
	const session = startRpcSession({
		command: process.execPath,
		args: [idler],
		cwd,
		env: baseEnv(home, agent),
	});
	t.after(async () => { await rm(cwd, { recursive: true, force: true }); });
	session.send({ id: 'commands', type: 'get_commands' });
	await assert.rejects(
		session.waitFor((e) => e.id === 'commands', { budget: 1000, label: 'never-ready startup' }),
		(error) => {
			assert.match(error.message, /never-ready startup/);
			assert.match(error.message, /no matching event within 1000ms/);
			return true;
		},
	);
	await session.close({ graceMs: 500 });
	const { code, signal } = await session.exited;
	assert.ok(code !== null || signal !== null, 'cleanup must join a real child exit');
});
