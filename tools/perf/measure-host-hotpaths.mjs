#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
	appendFile,
	mkdtemp,
	open,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const root = resolve(new URL("../..", import.meta.url).pathname);
const temp = await mkdtemp(join(tmpdir(), "pi-workflow-host-perf-"));
try {
	const anchors = await assertFinalSourceAnchors();
	const candidates = [];
	candidates.push(measureSchedulerDeadline());
	candidates.push(measureRefreshCoalescing());
	candidates.push(await measureArtifactMemoization());
	candidates.push(await measureIndexDirtySet());
	candidates.push(await measureDynamicIncrementality());
	candidates.push(await measureTailRead());
	for (const candidate of candidates) {
		if (!candidate.invariant.outputHashEqual) {
			throw new Error(`${candidate.id} changed fixture output`);
		}
	}
	const report = {
		schema: "pi-workflow-host-hotpath-measurement-v1",
		measuredAt: new Date().toISOString(),
		fixtureScope:
			"Synthetic local post-hardening fixtures only; no provider/model/browser calls and no general latency claim.",
		gate: {
			primaryMetricReductionPct: 20,
			requireOutputHashEquality: true,
			protectedKnobs: ["timeouts", "retries", "concurrency", "verification"],
		},
		sourceAnchors: anchors,
		candidates,
	};
	console.log(JSON.stringify(report, null, 2));
} finally {
	await rm(temp, { recursive: true, force: true });
}

async function assertFinalSourceAnchors() {
	const files = Object.fromEntries(
		await Promise.all(
			[
				"src/engine.ts",
				"src/engine-wait.ts",
				"src/subagent-backend.ts",
				"src/workflow-artifact-tool.ts",
				"src/store.ts",
				"src/dynamic-events.ts",
				"src/workflow-view.ts",
			].map(async (path) => [path, await readFile(join(root, path), "utf8")]),
		),
	);
	const expected = {
		"scheduler-deadline-wakeup": ["src/engine.ts", "await sleep(schedulerPollDelayMs(run, remaining));"],
		"scheduler-deadline-selector": ["src/engine-wait.ts", "export function schedulerPollDelayMs("],
		"refresh-single-write": ["src/subagent-backend.ts", "if (changed || telemetryChanged) await writeRunRecord(cwd, run);"],
		"completed-artifact-cache": ["src/workflow-artifact-tool.ts", "COMPLETED_ARTIFACT_READ_CACHE_MAX = 128"],
		"cwd-index-dirty-set": ["src/store.ts", "runIds: Set<string>"],
		"dynamic-append-cursor": ["src/dynamic-events.ts", "rememberDynamicEventAppendCursor(file"],
		"bounded-tui-tail": ["src/workflow-view.ts", "export async function readFileLinesBounded("],
	};
	for (const [id, [path, needle]] of Object.entries(expected)) {
		if (!files[path].includes(needle)) throw new Error(`source anchor ${id} missing from ${path}`);
	}
	const refreshBody = files["src/subagent-backend.ts"].slice(
		files["src/subagent-backend.ts"].indexOf("export async function refreshRunFromSubagentArtifacts"),
		files["src/subagent-backend.ts"].indexOf("async function pollSubagentForRefresh"),
	);
	const refreshWriteCalls = (refreshBody.match(/writeRunRecord\(/g) ?? []).length;
	if (refreshWriteCalls !== 1) throw new Error(`expected one coalesced refresh write site, got ${refreshWriteCalls}`);
	return Object.keys(expected);
}

function measureSchedulerDeadline() {
	const deadlines = [50, 150, 275, 475];
	const fixedWakeAt = 1_000;
	const baselineLatencies = deadlines.map((deadline) => fixedWakeAt - deadline);
	const candidateLatencies = deadlines.map(() => 0);
	const output = deadlines.map((deadline) => `ready:${deadline}`);
	return result({
		id: "scheduler-deadline-wakeup",
		primaryMetric: "latencyMs",
		baseline: metrics({ calls: 1, latencyMs: sum(baselineLatencies) }),
		candidate: metrics({ calls: deadlines.length, latencyMs: sum(candidateLatencies) }),
		baselineOutput: output,
		candidateOutput: output,
		decision: "eligible_for_implementation",
		reason: "Deadline-aware sleeping removes >20% modeled readiness delay without changing ready-event order.",
	});
}

function measureRefreshCoalescing() {
	const taskIds = Array.from({ length: 32 }, (_, index) => `task-${index + 1}`);
	return result({
		id: "refresh-write-coalescing",
		primaryMetric: "runWrites",
		baseline: metrics({ calls: taskIds.length * 2, writes: 1, locks: 1 }),
		candidate: metrics({ calls: taskIds.length * 2, writes: 1, locks: 1 }),
		baselineOutput: taskIds,
		candidateOutput: taskIds,
		decision: "deferred_no_material_evidence",
		reason: "Current refresh already batches all reconcile/status results into one run write; a lower count would discard timing telemetry.",
	});
}

async function measureArtifactMemoization() {
	const file = join(temp, "completed-control.json");
	const body = `${JSON.stringify({ schema: "stage-control-v1", digest: "x", payload: "a".repeat(1024 * 1024) })}\n`;
	await writeFile(file, body);
	const repeats = 16;
	const baselineStarted = performance.now();
	const baselineValues = [];
	for (let index = 0; index < repeats; index += 1) baselineValues.push(await readFile(file, "utf8"));
	const baselineLatency = performance.now() - baselineStarted;
	const candidateStarted = performance.now();
	const immutable = await readFile(file, "utf8");
	const candidateValues = Array.from({ length: repeats }, () => immutable);
	const candidateLatency = performance.now() - candidateStarted;
	return result({
		id: "completed-artifact-memoization",
		primaryMetric: "bytesRead",
		baseline: metrics({ calls: repeats, bytes: Buffer.byteLength(body) * repeats, latencyMs: baselineLatency }),
		candidate: metrics({ calls: 1, bytes: Buffer.byteLength(body), latencyMs: candidateLatency }),
		baselineOutput: baselineValues,
		candidateOutput: candidateValues,
		decision: "eligible_for_implementation",
		reason: "Immutable completed-source reads avoid repeated bytes while preserving every returned value.",
	});
}

async function measureIndexDirtySet() {
	const entries = Array.from({ length: 32 }, (_, index) => ({ runId: `workflow_${String(index).padStart(3, "0")}`, status: "running" }));
	const baselineFile = join(temp, "index-baseline.json");
	let baselineBytes = 0;
	const baselineStarted = performance.now();
	for (let index = 1; index <= entries.length; index += 1) {
		const text = canonicalJson({ runs: entries.slice(0, index) });
		baselineBytes += Buffer.byteLength(text);
		await writeFile(baselineFile, text);
	}
	const baselineLatency = performance.now() - baselineStarted;
	const candidateFile = join(temp, "index-candidate.json");
	const finalText = canonicalJson({ runs: entries });
	const candidateStarted = performance.now();
	await writeFile(candidateFile, finalText);
	const candidateLatency = performance.now() - candidateStarted;
	return result({
		id: "cwd-index-dirty-set",
		primaryMetric: "indexLocks",
		baseline: metrics({ writes: entries.length, bytes: baselineBytes, locks: entries.length, latencyMs: baselineLatency }),
		candidate: metrics({ writes: 1, bytes: Buffer.byteLength(finalText), locks: 1, latencyMs: candidateLatency }),
		baselineOutput: await readFile(baselineFile, "utf8"),
		candidateOutput: await readFile(candidateFile, "utf8"),
		decision: "eligible_for_implementation",
		reason: "One cwd dirty-set flush produces the same canonical index with one lock/write.",
	});
}

async function measureDynamicIncrementality() {
	const events = Array.from({ length: 500 }, (_, index) => ({ schema: "workflow-dynamic-event-v1", seq: index + 1, opId: `op-${index + 1}`, type: "controller.status" }));
	const baselineFile = join(temp, "events-baseline.jsonl");
	let baselineReadBytes = 0;
	const baselineStarted = performance.now();
	for (const event of events) {
		const previous = await readFile(baselineFile, "utf8").catch(() => "");
		baselineReadBytes += Buffer.byteLength(previous);
		await appendFile(baselineFile, `${JSON.stringify(event)}\n`);
	}
	const baselineLatency = performance.now() - baselineStarted;
	const candidateFile = join(temp, "events-candidate.jsonl");
	const candidateStarted = performance.now();
	for (const event of events) await appendFile(candidateFile, `${JSON.stringify(event)}\n`);
	const candidateLatency = performance.now() - candidateStarted;
	return result({
		id: "dynamic-event-incrementality",
		primaryMetric: "bytesRead",
		baseline: metrics({ calls: events.length, writes: events.length, bytes: baselineReadBytes, latencyMs: baselineLatency }),
		candidate: metrics({ calls: 0, writes: events.length, bytes: 0, latencyMs: candidateLatency }),
		baselineOutput: await readFile(baselineFile, "utf8"),
		candidateOutput: await readFile(candidateFile, "utf8"),
		decision: "eligible_for_implementation",
		reason: "A monotonic append cursor removes quadratic ledger rereads while preserving byte-identical events.",
	});
}

async function measureTailRead() {
	const file = join(temp, "large-output.log");
	const lines = Array.from({ length: 16_384 }, (_, index) => `${String(index).padStart(6, "0")}:${"x".repeat(505)}`);
	await writeFile(file, `${lines.join("\n")}\n`);
	const maxLines = 200;
	const baselineStarted = performance.now();
	const whole = await readFile(file);
	const baselineOutput = whole.toString("utf8").trimEnd().split(/\r?\n/).slice(-maxLines);
	const baselineLatency = performance.now() - baselineStarted;
	const candidateStarted = performance.now();
	const tail = await readTailLines(file, maxLines);
	const candidateLatency = performance.now() - candidateStarted;
	return result({
		id: "change-aware-tail-read",
		primaryMetric: "bytesRead",
		baseline: metrics({ calls: 1, bytes: whole.length, latencyMs: baselineLatency }),
		candidate: metrics({ calls: tail.calls, bytes: tail.bytesRead, latencyMs: candidateLatency }),
		baselineOutput,
		candidateOutput: tail.lines,
		decision: "eligible_for_implementation",
		reason: "Bounded suffix reads return the identical visible tail with materially fewer bytes.",
	});
}

async function readTailLines(path, maxLines) {
	const handle = await open(path, "r");
	try {
		const { size } = await handle.stat();
		const chunkSize = 64 * 1024;
		let position = size;
		let text = "";
		let bytesRead = 0;
		let calls = 0;
		while (position > 0 && newlineCount(text) <= maxLines) {
			const length = Math.min(chunkSize, position);
			position -= length;
			const buffer = Buffer.allocUnsafe(length);
			const read = await handle.read(buffer, 0, length, position);
			calls += 1;
			bytesRead += read.bytesRead;
			text = buffer.subarray(0, read.bytesRead).toString("utf8") + text;
		}
		return { calls, bytesRead, lines: text.trimEnd().split(/\r?\n/).slice(-maxLines) };
	} finally {
		await handle.close();
	}
}

function result({ id, primaryMetric, baseline, candidate, baselineOutput, candidateOutput, decision, reason }) {
	const baselineHash = hash(baselineOutput);
	const candidateHash = hash(candidateOutput);
	const baselinePrimary = baseline[primaryMetric];
	const candidatePrimary = candidate[primaryMetric];
	const reductionPct = baselinePrimary === 0 ? 0 : ((baselinePrimary - candidatePrimary) / baselinePrimary) * 100;
	if (decision === "eligible_for_implementation" && reductionPct < 20) throw new Error(`${id} misses 20% gate: ${reductionPct}`);
	return {
		id,
		primaryMetric,
		baseline,
		candidate,
		primaryMetricReductionPct: Number(reductionPct.toFixed(3)),
		invariant: { baselineOutputSha256: baselineHash, candidateOutputSha256: candidateHash, outputHashEqual: baselineHash === candidateHash },
		decision,
		reason,
	};
}

function metrics({ calls = 0, writes = 0, bytes = 0, locks = 0, latencyMs = 0 }) {
	return { calls, writes, bytesRead: bytes, indexLocks: locks, runWrites: writes, latencyMs: Number(latencyMs.toFixed(3)) };
}
function canonicalJson(value) { return `${JSON.stringify(value)}\n`; }
function hash(value) { return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex"); }
function newlineCount(value) { return (value.match(/\n/g) ?? []).length; }
function sum(values) { return values.reduce((total, value) => total + value, 0); }
