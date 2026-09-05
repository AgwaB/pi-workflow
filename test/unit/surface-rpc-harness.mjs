import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

// Test-only RPC harness for the real locked Pi subprocess. It deliberately keeps
// two distinct budgets: a generous startup-readiness allowance for the first
// response (cold subprocess boot + extension compile, which scales with parallel
// CI load) and a tight post-ready operation budget for individual RPC replies.
// It never silently burns a full deadline on a dead child: early subprocess exit
// becomes a prompt diagnostic carrying exit code, signal, captured events, and
// stderr. Cleanup joins the child exit under a bounded SIGTERM->SIGKILL escalation.
export function startRpcSession({ command, args, cwd, env }) {
	const proc = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
	const events = [];
	let buffer = '';
	let stderr = '';
	proc.stdout.setEncoding('utf8');
	proc.stderr.setEncoding('utf8');
	proc.stderr.on('data', (chunk) => {
		stderr += chunk;
	});
	proc.stdout.on('data', (chunk) => {
		buffer += chunk;
		let end;
		while ((end = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, end);
			buffer = buffer.slice(end + 1);
			try {
				events.push(JSON.parse(line));
			} catch {
				events.push({ invalid: line });
			}
		}
	});
	const exited = new Promise((resolve) =>
		proc.on('exit', (code, signal) => resolve({ code, signal })),
	);

	function diagnostic(label, reason) {
		return `${label}: ${reason}; ${JSON.stringify({ events, stderr })}`;
	}

	return {
		proc,
		events,
		exited,
		get stderr() {
			return stderr;
		},
		send(message) {
			proc.stdin.write(`${JSON.stringify(message)}\n`);
		},
		// Wait for a matching event within an explicit budget. `budget` is chosen by
		// the caller: a large startup-readiness allowance for the first response, a
		// tight operation budget for everything after ready. Early child exit fails
		// fast rather than waiting out the deadline.
		async waitFor(predicate, { budget, label }) {
			const deadline = Date.now() + budget;
			for (;;) {
				const value = events.find(predicate);
				if (value) return value;
				if (proc.exitCode !== null || proc.signalCode !== null) {
					assert.fail(
						diagnostic(
							label,
							`subprocess exited early (code=${proc.exitCode}, signal=${proc.signalCode}) before a matching response`,
						),
					);
				}
				if (Date.now() >= deadline) {
					assert.fail(diagnostic(label, `no matching event within ${budget}ms`));
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		},
		// Bounded cleanup with a joined child exit: request graceful shutdown, then
		// force-kill if the child ignores SIGTERM, and always await the real exit so
		// no orphaned subprocess or unsettled handle leaks out of the test.
		async close({ graceMs = 2000 } = {}) {
			if (proc.exitCode === null && proc.signalCode === null) {
				proc.kill('SIGTERM');
				const timer = setTimeout(() => {
					try {
						proc.kill('SIGKILL');
					} catch {
						/* already gone */
					}
				}, graceMs);
				await exited;
				clearTimeout(timer);
			} else {
				await exited;
			}
		},
	};
}
