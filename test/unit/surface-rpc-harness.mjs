import assert from "node:assert/strict";
import { spawn } from "node:child_process";

// Test-only, single-process RPC session. Startup and post-ready operation budgets
// are chosen separately by the caller. Completion includes drained stdio.
export function startRpcSession({ command, args, cwd, env }) {
	const proc = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
	const events = [];
	let buffer = "", stderr = "", failure, closed = false;
	proc.stdout.setEncoding("utf8");
	proc.stderr.setEncoding("utf8");
	proc.on("error", (error) => { failure = error; });
	proc.stdin.on("error", (error) => { failure ??= error; });
	proc.stderr.on("data", (chunk) => { stderr += chunk; });
	proc.stdout.on("data", (chunk) => {
		buffer += chunk;
		let end;
		while ((end = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, end);
			buffer = buffer.slice(end + 1);
			try { events.push(JSON.parse(line)); }
			catch { events.push({ invalid: line }); }
		}
	});
	const exited = new Promise((resolve) => proc.once("close", (code, signal) => {
		closed = true;
		resolve({ code, signal });
	}));
	const diagnostic = (label, reason) =>
		`${label}: ${reason}; ${JSON.stringify({ events, stderr })}`;

	async function closesWithin(ms) {
		let timer;
		try {
			return await Promise.race([
				exited.then(() => true),
				new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
			]);
		} finally { clearTimeout(timer); }
	}

	return {
		proc, events, exited,
		get stderr() { return stderr; },
		send(message) {
			try { proc.stdin.write(`${JSON.stringify(message)}\n`); }
			catch (error) { failure ??= error; }
		},
		async waitFor(predicate, { budget, label }) {
			const deadline = performance.now() + budget;
			for (;;) {
				if (failure) assert.fail(diagnostic(label, `subprocess/pipe error: ${failure.message}`));
				const value = events.find(predicate);
				if (value) return value;
				if (closed) {
					assert.fail(diagnostic(label, `subprocess exited early (code=${proc.exitCode}, signal=${proc.signalCode}) before a matching response`));
				}
				if (performance.now() >= deadline) {
					assert.fail(diagnostic(label, `no matching event within ${budget}ms`));
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		},
		async close({ graceMs = 2000 } = {}) {
			if (closed) return exited;
			if (proc.pid && proc.exitCode === null && proc.signalCode === null) proc.kill("SIGTERM");
			if (await closesWithin(graceMs)) return exited;
			if (proc.pid && proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
			if (await closesWithin(2000)) return exited;
			assert.fail(diagnostic("cleanup", `subprocess ${proc.pid} did not close after bounded SIGTERM/SIGKILL shutdown`));
		},
	};
}
