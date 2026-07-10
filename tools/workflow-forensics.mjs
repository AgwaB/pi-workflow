import {
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";

const ROOT = process.argv[2] || "/Users/toby/pi";
const OUT_JSON = process.argv[3] || ".tmp/slow-workflow-forensics.json";
const OUT_MD = process.argv[4] || ".tmp/slow-workflow-forensics.md";
const NOW = Date.now();

if (ROOT === "--help" || ROOT === "-h") {
	console.log(
		"Usage: node tools/workflow-forensics.mjs [root=/Users/toby/pi] [outJson=.tmp/slow-workflow-forensics.json] [outMd=.tmp/slow-workflow-forensics.md]",
	);
	process.exit(0);
}
if (!existsSync(ROOT) || !statSync(ROOT).isDirectory()) {
	throw new Error(`scan root does not exist or is not a directory: ${ROOT}`);
}

const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	".next",
	"coverage",
]);

function fmt(ms) {
	if (!Number.isFinite(ms)) return "n/a";
	const sign = ms < 0 ? "-" : "";
	ms = Math.max(0, Math.round(Math.abs(ms)));
	const s = Math.floor(ms / 1000);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	if (h) return `${sign}${h}h ${m}m ${sec}s`;
	if (m) return `${sign}${m}m ${sec}s`;
	return `${sign}${sec}s`;
}
function ts(v) {
	const n = Date.parse(v || "");
	return Number.isFinite(n) ? n : undefined;
}
function minDefined(vals) {
	const xs = vals.filter(Number.isFinite);
	return xs.length ? Math.min(...xs) : undefined;
}
function maxDefined(vals) {
	const xs = vals.filter(Number.isFinite);
	return xs.length ? Math.max(...xs) : undefined;
}
function quantile(sorted, q) {
	if (!sorted.length) return undefined;
	const idx = Math.ceil(sorted.length * q) - 1;
	return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}
function stats(values) {
	const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
	const sum = xs.reduce((a, b) => a + b, 0);
	return {
		n: xs.length,
		sum,
		mean: xs.length ? sum / xs.length : undefined,
		min: xs[0],
		p50: quantile(xs, 0.5),
		p75: quantile(xs, 0.75),
		p90: quantile(xs, 0.9),
		p95: quantile(xs, 0.95),
		max: xs[xs.length - 1],
		sumFmt: fmt(sum),
		meanFmt: fmt(xs.length ? sum / xs.length : undefined),
		minFmt: fmt(xs[0]),
		p50Fmt: fmt(quantile(xs, 0.5)),
		p75Fmt: fmt(quantile(xs, 0.75)),
		p90Fmt: fmt(quantile(xs, 0.9)),
		p95Fmt: fmt(quantile(xs, 0.95)),
		maxFmt: fmt(xs[xs.length - 1]),
	};
}
function safeReadJson(file) {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}
function taskArtifactDir(sessionRoot, run, task) {
	return path.join(
		sessionRoot,
		".pi",
		"workflows",
		run.runId || "",
		"tasks",
		task.taskId || "",
	);
}
function invalidAttemptIndex(file) {
	const base = path.basename(file);
	const match = base.match(/invalid-attempt[-_](\d+)/i);
	return match ? Number(match[1]) : undefined;
}
function issuePath(issue = {}) {
	const raw =
		issue.instancePath ??
		issue.schemaPath ??
		issue.path ??
		issue.keywordLocation ??
		issue.absoluteKeywordLocation ??
		issue.dataPath;
	if (Array.isArray(raw)) return raw.map(String).join(".") || "/";
	if (typeof raw === "string" && raw.trim()) return raw.trim();
	return "/";
}
function issueMessage(issue = {}) {
	return String(
		issue.message ??
			issue.error ??
			issue.reason ??
			issue.summary ??
			"validation failure",
	).slice(0, 240);
}
function validationIssuesFrom(value) {
	if (!value || typeof value !== "object") return [];
	const candidates = [
		value.issues,
		value.errors,
		value.validationErrors,
		value.diagnostics,
		value.error?.issues,
		value.error?.errors,
		value.validation?.issues,
		value.validation?.errors,
		value.outputValidation?.issues,
		value.outputValidation?.errors,
	].filter(Array.isArray);
	const issues = candidates.flat();
	if (issues.length) return issues.filter((x) => x && typeof x === "object");
	const message =
		value.message ??
		value.error?.message ??
		value.validationError ??
		value.outputValidation?.message;
	return message ? [{ message }] : [];
}
function invalidAttemptFiles(taskDir) {
	try {
		return readdirSync(taskDir)
			.filter((name) => /invalid-attempt.*\.json$/i.test(name))
			.map((name) => path.join(taskDir, name))
			.sort((a, b) => {
				const ai = invalidAttemptIndex(a);
				const bi = invalidAttemptIndex(b);
				if (Number.isFinite(ai) && Number.isFinite(bi)) return ai - bi;
				if (Number.isFinite(ai)) return -1;
				if (Number.isFinite(bi)) return 1;
				return a.localeCompare(b);
			});
	} catch {
		return [];
	}
}
function taskValidationFailures(run, task, sessionRoot) {
	const taskDir = taskArtifactDir(sessionRoot, run, task);
	const files = invalidAttemptFiles(taskDir);
	const firstIndex = minDefined(files.map(invalidAttemptIndex));
	const firstFiles = Number.isFinite(firstIndex)
		? files.filter((file) => invalidAttemptIndex(file) === firstIndex)
		: files.slice(0, 1);
	const failures = [];
	for (const file of firstFiles) {
		const json = safeReadJson(file);
		for (const issue of validationIssuesFrom(json)) {
			failures.push({
				workflow: run.name || "unknown",
				runId: run.runId,
				taskId: task.taskId,
				specId: task.specId,
				stageId:
					task.stageId || String(task.specId || "").split(".")[0] || "unknown",
				attemptIndex: invalidAttemptIndex(file),
				schemaPath: issuePath(issue),
				message: issueMessage(issue),
				evidencePath: file,
			});
		}
	}
	return failures;
}
function validationFailureTriage(signature = {}) {
	const schemaPath = String(signature.schemaPath || "").toLowerCase();
	const message = String(signature.message || "").toLowerCase();
	if (schemaPath.endsWith("schema") || schemaPath === "$.schema") {
		return {
			triageCategory: "schema-contract-drift",
			benchmarkValiditySignal: "agent-output-contract",
			recommendedAction:
				"Make the required schema literal unambiguous in the prompt or schema contract; keep validation fail-closed.",
		};
	}
	if (message.includes("array length") || message.includes("must be <=")) {
		return {
			triageCategory: "over-strict-output-limit",
			benchmarkValiditySignal: "overly-strict-test",
			recommendedAction:
				"Review whether the cap measures task quality or only output-shape compliance before using it as benchmark evidence.",
		};
	}
	if (message.includes("required") || message.includes("missing")) {
		return {
			triageCategory: "underspecified-required-field",
			benchmarkValiditySignal: "underspecified-prompt-or-contract",
			recommendedAction:
				"Clarify the required field in the prompt/schema and add focused validation coverage.",
		};
	}
	if (message.includes("type object") || message.includes("must be of type")) {
		return {
			triageCategory: "schema-shape-mismatch",
			benchmarkValiditySignal: "agent-output-contract",
			recommendedAction:
				"Inspect examples for repeated shape confusion and harden the prompt/schema without weakening validation.",
		};
	}
	return {
		triageCategory: "triage-needed",
		benchmarkValiditySignal: "unknown",
		recommendedAction:
			"Inspect representative invalid attempts before treating this as benchmark or model quality evidence.",
	};
}
function aggregateValidationFailures(records) {
	const by = new Map();
	for (const rec of records) {
		for (const failure of rec.validationFailures || []) {
			const key = [
				rec.name,
				failure.stageId,
				failure.schemaPath,
				failure.message,
			].join("\u0000");
			const cur = by.get(key) || {
				workflow: rec.name,
				stageId: failure.stageId,
				schemaPath: failure.schemaPath,
				message: failure.message,
				count: 0,
				runIds: new Set(),
				taskIds: new Set(),
				examples: [],
			};
			cur.count += 1;
			cur.runIds.add(rec.runId);
			cur.taskIds.add(failure.taskId);
			if (cur.examples.length < 5) cur.examples.push(failure);
			by.set(key, cur);
		}
	}
	return [...by.values()]
		.map((x) => {
			const signature = {
				workflow: x.workflow,
				stageId: x.stageId,
				schemaPath: x.schemaPath,
				message: x.message,
				count: x.count,
				runCount: x.runIds.size,
				taskCount: x.taskIds.size,
				validitySignal:
					x.runIds.size >= 2 || x.count >= 2
						? "repeated-validation-signature"
						: "single-validation-signature",
				examples: x.examples,
			};
			return { ...signature, ...validationFailureTriage(signature) };
		})
		.sort((a, b) => b.count - a.count || b.runCount - a.runCount);
}
function walkIndexes(root) {
	const out = [];
	function rec(dir, depth = 0) {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		if (
			path.basename(dir) === "workflows" &&
			path.basename(path.dirname(dir)) === ".pi"
		) {
			const idx = path.join(dir, "index.json");
			if (existsSync(idx)) out.push(idx);
			// still recurse in case nested? no need inside workflow run dirs
			return;
		}
		for (const ent of entries) {
			if (!ent.isDirectory()) continue;
			if (SKIP_DIRS.has(ent.name)) continue;
			rec(path.join(dir, ent.name), depth + 1);
		}
	}
	rec(root);
	return out;
}
function sessionRootFromIndex(indexPath) {
	return path.resolve(path.dirname(indexPath), "..", "..");
}
function resolveRunJson(sessionRoot, indexRun) {
	if (!indexRun?.runJson)
		return path.join(
			sessionRoot,
			".pi",
			"workflows",
			indexRun?.runId || "",
			"run.json",
		);
	return path.isAbsolute(indexRun.runJson)
		? indexRun.runJson
		: path.join(sessionRoot, indexRun.runJson);
}
function fallbackTaskInterval(task) {
	const start =
		ts(task.startedAt) ??
		ts(task.timing?.launchStartedAt) ??
		ts(task.createdAt);
	// Perceived workflow duration should include late task-record updates, not just
	// the child process completion stamp. Older runs sometimes updated workflow
	// task records minutes after completedAt, which is exactly one slowdown class.
	const end = maxDefined([
		ts(task.completedAt),
		ts(task.updatedAt),
		ts(task.timing?.capturedAt),
	]);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
		return undefined;
	return { task, start, end, source: "top-level", attemptIndex: undefined };
}
function attemptInterval(task, attempt, index) {
	const start =
		ts(attempt?.launchStartedAt) ??
		ts(attempt?.launchQueuedAt) ??
		ts(attempt?.executionStartedAt) ??
		ts(attempt?.startedAt);
	const end = maxDefined([
		ts(attempt?.capturedAt),
		ts(attempt?.executionCompletedAt),
		ts(attempt?.completedAt),
		ts(attempt?.launchCompletedAt),
	]);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
		return undefined;
	return { task, start, end, source: "attempt", attemptIndex: index };
}
function taskActiveIntervals(task) {
	const attempts = Array.isArray(task.timing?.attempts)
		? task.timing.attempts
				.map((attempt, index) => attemptInterval(task, attempt, index))
				.filter(Boolean)
		: [];
	if (attempts.length > 0) return attempts;
	const fallback = fallbackTaskInterval(task);
	return fallback ? [fallback] : [];
}
function intervalBounds(ints) {
	return {
		start: minDefined(ints.map((it) => it.start)),
		end: maxDefined(ints.map((it) => it.end)),
	};
}
function unionDurationMs(ints) {
	const sorted = ints
		.filter(
			(it) =>
				Number.isFinite(it.start) &&
				Number.isFinite(it.end) &&
				it.end >= it.start,
		)
		.sort((a, b) => a.start - b.start);
	let total = 0;
	let activeStart;
	let activeEnd;
	for (const it of sorted) {
		if (!Number.isFinite(activeEnd) || it.start > activeEnd) {
			if (Number.isFinite(activeStart) && Number.isFinite(activeEnd))
				total += activeEnd - activeStart;
			activeStart = it.start;
			activeEnd = it.end;
		} else if (it.end > activeEnd) {
			activeEnd = it.end;
		}
	}
	if (Number.isFinite(activeStart) && Number.isFinite(activeEnd))
		total += activeEnd - activeStart;
	return total;
}
function taskTimingSummary(task) {
	const ints = taskActiveIntervals(task);
	const bounds = intervalBounds(ints);
	const durationMs = ints.length > 0 ? unionDurationMs(ints) : undefined;
	const attemptCount = Array.isArray(task.timing?.attempts)
		? task.timing.attempts.length
		: (task.timing?.aggregate?.attempts ?? task.outputRetry?.attempts ?? 1);
	return {
		intervals: ints,
		start: bounds.start,
		end: bounds.end,
		durationMs,
		attemptCount,
		retryCount: Math.max(0, Number(attemptCount || 1) - 1),
		timingBasis: ints.some((it) => it.source === "attempt")
			? "attempt-windows"
			: "top-level-fallback",
	};
}
function taskEnd(task) {
	return taskTimingSummary(task).end;
}
function workflowDuration(run) {
	const timings = run.tasks?.map(taskTimingSummary) ?? [];
	const first =
		minDefined(timings.map((timing) => timing.start)) ?? ts(run.createdAt);
	const last =
		maxDefined(timings.map((timing) => timing.end)) ?? ts(run.updatedAt);
	const dur =
		Number.isFinite(first) && Number.isFinite(last) ? last - first : undefined;
	return { first, last, durationMs: dur };
}
function intervals(run) {
	return (run.tasks || [])
		.flatMap((task) => taskActiveIntervals(task))
		.filter(
			(x) =>
				Number.isFinite(x.start) && Number.isFinite(x.end) && x.end >= x.start,
		)
		.sort((a, b) => a.start - b.start);
}
function idleGaps(run) {
	const ints = intervals(run);
	if (!ints.length) return [];
	const gaps = [];
	let activeEnd = ints[0].end;
	let prevTask = ints[0].task;
	for (let i = 1; i < ints.length; i++) {
		const it = ints[i];
		if (it.start > activeEnd) {
			gaps.push({
				start: activeEnd,
				end: it.start,
				ms: it.start - activeEnd,
				afterTaskId: prevTask?.taskId,
				afterSpecId: prevTask?.specId,
				beforeTaskId: it.task?.taskId,
				beforeSpecId: it.task?.specId,
			});
		}
		if (it.end > activeEnd) {
			activeEnd = it.end;
			prevTask = it.task;
		}
	}
	return gaps.sort((a, b) => b.ms - a.ms);
}
function stageSummary(run) {
	const by = new Map();
	for (const t of run.tasks || []) {
		const stage =
			t.stageId || String(t.specId || "").split(".")[0] || "unknown";
		const timing = taskTimingSummary(t);
		const start = timing.start,
			end = timing.end,
			dur = timing.durationMs;
		const cur = by.get(stage) || {
			stage,
			count: 0,
			sumMs: 0,
			maxMs: 0,
			retryTaskCount: 0,
			retryCount: 0,
			attemptWindowTasks: 0,
			fallbackTaskCount: 0,
			wallStart: undefined,
			wallEnd: undefined,
			tokens: 0,
			costUsd: 0,
			thinking: new Map(),
			statuses: {},
		};
		cur.count++;
		if (Number.isFinite(dur)) {
			cur.sumMs += dur;
			cur.maxMs = Math.max(cur.maxMs, dur);
		}
		if (timing.retryCount > 0) {
			cur.retryTaskCount += 1;
			cur.retryCount += timing.retryCount;
		}
		if (timing.timingBasis === "attempt-windows") cur.attemptWindowTasks += 1;
		else cur.fallbackTaskCount += 1;
		if (Number.isFinite(start))
			cur.wallStart =
				cur.wallStart === undefined ? start : Math.min(cur.wallStart, start);
		if (Number.isFinite(end))
			cur.wallEnd =
				cur.wallEnd === undefined ? end : Math.max(cur.wallEnd, end);
		cur.tokens += Number(
			t.usage?.totalTokens || t.usage?.aggregate?.totalTokens || 0,
		);
		cur.costUsd += Number(t.usage?.costUsd || t.usage?.aggregate?.costUsd || 0);
		const th = t.runtime?.thinking || t.usage?.thinking;
		if (th) cur.thinking.set(th, (cur.thinking.get(th) || 0) + 1);
		cur.statuses[t.status || "unknown"] =
			(cur.statuses[t.status || "unknown"] || 0) + 1;
		by.set(stage, cur);
	}
	return [...by.values()]
		.map((x) => ({
			stage: x.stage,
			count: x.count,
			wallMs:
				Number.isFinite(x.wallStart) && Number.isFinite(x.wallEnd)
					? x.wallEnd - x.wallStart
					: undefined,
			sumTaskMs: x.sumMs,
			maxTaskMs: x.maxMs,
			retryTaskCount: x.retryTaskCount,
			retryCount: x.retryCount,
			attemptWindowTasks: x.attemptWindowTasks,
			fallbackTaskCount: x.fallbackTaskCount,
			timingBasis:
				x.attemptWindowTasks > 0 ? "attempt-windows" : "top-level-fallback",
			tokens: x.tokens || undefined,
			costUsd: x.costUsd || undefined,
			thinking: Object.fromEntries(x.thinking),
			statuses: x.statuses,
			wallFmt: fmt(
				Number.isFinite(x.wallStart) && Number.isFinite(x.wallEnd)
					? x.wallEnd - x.wallStart
					: undefined,
			),
			sumTaskFmt: fmt(x.sumMs),
			maxTaskFmt: fmt(x.maxMs),
		}))
		.sort((a, b) => (b.wallMs || 0) - (a.wallMs || 0));
}
function usageSummary(run) {
	let totalTokens = 0,
		outputTokens = 0,
		reasoningTokens = 0,
		costUsd = 0;
	const thinking = {};
	const models = {};
	for (const t of run.tasks || []) {
		totalTokens += Number(
			t.usage?.totalTokens || t.usage?.aggregate?.totalTokens || 0,
		);
		outputTokens += Number(
			t.usage?.outputTokens || t.usage?.aggregate?.outputTokens || 0,
		);
		reasoningTokens += Number(
			t.usage?.reasoningTokens || t.usage?.aggregate?.reasoningTokens || 0,
		);
		costUsd += Number(t.usage?.costUsd || t.usage?.aggregate?.costUsd || 0);
		const th = t.runtime?.thinking || t.usage?.thinking;
		if (th) thinking[th] = (thinking[th] || 0) + 1;
		const model = t.runtime?.model || t.usage?.model;
		if (model) models[model] = (models[model] || 0) + 1;
	}
	return {
		totalTokens: totalTokens || undefined,
		outputTokens: outputTokens || undefined,
		reasoningTokens: reasoningTokens || undefined,
		costUsd: costUsd || undefined,
		thinking,
		models,
	};
}
function candidateBackendRunJson(sessionRoot, run, task) {
	const dirs = [];
	if (task.backendTaskId)
		dirs.push(
			path.join(
				sessionRoot,
				".pi",
				"workflow-subagents",
				run.runId,
				task.taskId,
				task.backendTaskId,
				"run.json",
			),
		);
	const taskDir = path.join(
		sessionRoot,
		".pi",
		"workflow-subagents",
		run.runId,
		task.taskId,
	);
	try {
		for (const ent of readdirSync(taskDir, { withFileTypes: true })) {
			if (ent.isDirectory() && ent.name.startsWith("run_"))
				dirs.push(path.join(taskDir, ent.name, "run.json"));
		}
	} catch {}
	return [...new Set(dirs)].find(existsSync);
}
function captureGaps(run, sessionRoot) {
	const out = [];
	for (const t of run.tasks || []) {
		const taskDone = taskEnd(t);
		if (!Number.isFinite(taskDone)) continue;
		const backendPath = candidateBackendRunJson(sessionRoot, run, t);
		if (!backendPath) continue;
		const br = safeReadJson(backendPath);
		const backendDone = ts(br?.completedAt) ?? ts(br?.updatedAt);
		if (!Number.isFinite(backendDone)) continue;
		const gap = taskDone - backendDone;
		if (gap > 0)
			out.push({
				ms: gap,
				taskId: t.taskId,
				specId: t.specId,
				stageId: t.stageId,
				backendRunId: br.runId,
				workflowTaskDone: new Date(taskDone).toISOString(),
				backendDone: new Date(backendDone).toISOString(),
				backendRunJson: backendPath,
			});
	}
	return out.sort((a, b) => b.ms - a.ms);
}
function longestTasks(run, n = 8) {
	return (run.tasks || [])
		.map((t) => {
			const timing = taskTimingSummary(t);
			const d = timing.durationMs;
			return {
				taskId: t.taskId,
				specId: t.specId,
				stageId: t.stageId,
				status: t.status,
				ms: d,
				fmt: fmt(d),
				retryCount: timing.retryCount,
				attemptCount: timing.attemptCount,
				timingBasis: timing.timingBasis,
				thinking: t.runtime?.thinking || t.usage?.thinking,
				model: t.runtime?.model || t.usage?.model,
				tokens: t.usage?.totalTokens || t.usage?.aggregate?.totalTokens,
				costUsd: t.usage?.costUsd || t.usage?.aggregate?.costUsd,
				startedAt: t.startedAt,
				completedAt: t.completedAt,
			};
		})
		.filter((x) => Number.isFinite(x.ms))
		.sort((a, b) => b.ms - a.ms)
		.slice(0, n);
}
function taskIntervals(run) {
	return intervals(run).map((it) => ({
		start: it.start,
		end: it.end,
		startIso: new Date(it.start).toISOString(),
		endIso: new Date(it.end).toISOString(),
		taskId: it.task?.taskId,
		specId: it.task?.specId,
		stageId: it.task?.stageId,
		source: it.source,
		attemptIndex: it.attemptIndex,
	}));
}
function batchRootFor(sessionRoot) {
	const normalized = path.resolve(sessionRoot).split(path.sep).join("/");
	for (const marker of ["/worktrees/", "/runs/"]) {
		const idx = normalized.lastIndexOf(marker);
		if (idx > 0) return normalized.slice(0, idx);
	}
	return normalized;
}
function overlapMs(aStart, aEnd, bStart, bEnd) {
	const start = Math.max(aStart, bStart);
	const end = Math.min(aEnd, bEnd);
	return Math.max(0, end - start);
}
function annotateIdleGapConcurrency(records) {
	const runIntervals = records.map((record) => ({
		runId: record.runId,
		name: record.name,
		sessionRoot: record.sessionRoot,
		batchRoot: record.batchRoot,
		intervals: record.activeIntervals || [],
	}));
	for (const record of records) {
		let queueTotalMs = 0;
		let sameBatchOverlapTotalMs = 0;
		let trueIdleTotalMs = 0;
		let maxQueueingGapMs = 0;
		let maxTrueIdleGapMs = 0;
		for (const gap of record.topIdleGaps || []) {
			const sameBatchOverlaps = [];
			const globalOverlaps = [];
			for (const other of runIntervals) {
				if (other.runId === record.runId) continue;
				let runOverlap = 0;
				for (const interval of other.intervals) {
					runOverlap += overlapMs(
						gap.start,
						gap.end,
						interval.start,
						interval.end,
					);
				}
				if (runOverlap <= 0) continue;
				const row = {
					runId: other.runId,
					name: other.name,
					overlapMs: runOverlap,
					overlapFmt: fmt(runOverlap),
					sessionRoot: other.sessionRoot,
				};
				globalOverlaps.push(row);
				if (other.batchRoot === record.batchRoot) sameBatchOverlaps.push(row);
			}
			sameBatchOverlaps.sort((a, b) => b.overlapMs - a.overlapMs);
			globalOverlaps.sort((a, b) => b.overlapMs - a.overlapMs);
			gap.sameBatchActiveCount = sameBatchOverlaps.length;
			gap.globalActiveCount = globalOverlaps.length;
			gap.sameBatchActiveRuns = sameBatchOverlaps.slice(0, 5);
			gap.globalActiveRuns = globalOverlaps.slice(0, 5);
			if (sameBatchOverlaps.length > 0) {
				sameBatchOverlapTotalMs += gap.ms;
				if (gap.ms >= 10 * 60_000) {
					gap.classification = "experiment-queueing";
					queueTotalMs += gap.ms;
					maxQueueingGapMs = Math.max(maxQueueingGapMs, gap.ms);
				} else {
					gap.classification = "same-batch-overlap";
				}
			} else {
				gap.classification = "true-idle";
				trueIdleTotalMs += gap.ms;
				maxTrueIdleGapMs = Math.max(maxTrueIdleGapMs, gap.ms);
			}
		}
		record.sameBatchOverlapTotalMs = sameBatchOverlapTotalMs;
		record.sameBatchOverlapTotalFmt = fmt(sameBatchOverlapTotalMs);
		record.queueTotalMs = queueTotalMs;
		record.queueTotalFmt = fmt(queueTotalMs);
		record.trueIdleTotalMs = trueIdleTotalMs;
		record.trueIdleTotalFmt = fmt(trueIdleTotalMs);
		record.maxQueueingGapMs = maxQueueingGapMs;
		record.maxQueueingGapFmt = fmt(maxQueueingGapMs);
		record.maxTrueIdleGapMs = maxTrueIdleGapMs;
		record.maxTrueIdleGapFmt = fmt(maxTrueIdleGapMs);
	}
}
function classifyRun(rec) {
	const reasons = [];
	if ((rec.maxQueueingGapMs || 0) >= 10 * 60_000)
		reasons.push("experiment-queueing");
	const idleForEngineMs = rec.maxTrueIdleGapMs ?? rec.maxIdleMs;
	if (idleForEngineMs >= 60 * 60_000) reasons.push("huge-idle-gap");
	else if (idleForEngineMs >= 10 * 60_000) reasons.push("idle-gap");
	if (rec.maxCaptureGapMs >= 10 * 60_000) reasons.push("terminal-capture-gap");
	else if (rec.maxCaptureGapMs >= 2 * 60_000) reasons.push("capture-gap");
	if (rec.name !== "deep-research" && (rec.usage?.thinking?.xhigh || 0) >= 1)
		reasons.push("xhigh-thinking");
	if ((rec.taskCount || 0) >= 30) reasons.push("many-tasks");
	if (
		rec.name === "deep-review" &&
		(rec.stageSummaries?.find((s) => s.stage === "devil-advocate")?.count ||
			0) >= 10
	)
		reasons.push("per-finding-devil-advocate-fanout");
	if (rec.name === "deep-research" && (rec.taskCount || 0) >= 30)
		reasons.push("deep-research-wide-fanout");
	if (rec.usage?.totalTokens >= 2_000_000)
		reasons.push("multi-million-token-run");
	return reasons;
}

const indexes = walkIndexes(ROOT);
const all = [];
const missing = [];
for (const indexPath of indexes) {
	const idx = safeReadJson(indexPath);
	const sessionRoot = sessionRootFromIndex(indexPath);
	for (const ir of idx?.runs || []) {
		const runJson = resolveRunJson(sessionRoot, ir);
		if (!existsSync(runJson)) {
			missing.push({ indexPath, runId: ir.runId, runJson });
			continue;
		}
		const run = safeReadJson(runJson);
		if (!run) continue;
		const wd = workflowDuration(run);
		const gaps = idleGaps(run);
		const caps = captureGaps(run, sessionRoot);
		const usage = usageSummary(run);
		const validationFailures = (run.tasks || []).flatMap((task) =>
			taskValidationFailures(run, task, sessionRoot),
		);
		const failedTasks = (run.tasks || []).filter((t) =>
			["failed", "interrupted"].includes(t.status),
		).length;
		const rec = {
			runId: run.runId || ir.runId,
			name: run.name || ir.name || "unknown",
			status: run.status || ir.status,
			createdAt: run.createdAt || ir.createdAt,
			updatedAt: run.updatedAt || ir.updatedAt,
			durationMs: wd.durationMs,
			durationFmt: fmt(wd.durationMs),
			firstTaskAt: wd.first ? new Date(wd.first).toISOString() : undefined,
			lastTaskAt: wd.last ? new Date(wd.last).toISOString() : undefined,
			taskCount: (run.tasks || []).length,
			taskSummary: run.taskSummary,
			failedTasks,
			sessionRoot,
			batchRoot: batchRootFor(sessionRoot),
			runJson,
			specPath: run.specPath,
			cwd: run.cwd,
			idleTotalMs: gaps.reduce((a, g) => a + g.ms, 0),
			idleTotalFmt: fmt(gaps.reduce((a, g) => a + g.ms, 0)),
			maxIdleMs: gaps[0]?.ms || 0,
			maxIdleFmt: fmt(gaps[0]?.ms || 0),
			topIdleGaps: gaps.slice(0, 5).map((g) => ({
				...g,
				startIso: new Date(g.start).toISOString(),
				endIso: new Date(g.end).toISOString(),
				fmt: fmt(g.ms),
			})),
			maxCaptureGapMs: caps[0]?.ms || 0,
			maxCaptureGapFmt: fmt(caps[0]?.ms || 0),
			topCaptureGaps: caps.slice(0, 5).map((g) => ({ ...g, fmt: fmt(g.ms) })),
			usage,
			validationFailures,
			validationFailureCount: validationFailures.length,
			stageSummaries: stageSummary(run),
			longestTasks: longestTasks(run),
			activeIntervals: taskIntervals(run),
			successful: run.status === "completed" && failedTasks === 0,
			ageOrElapsedMs:
				run.status === "running"
					? ts(run.updatedAt)
						? NOW - ts(run.updatedAt)
						: NOW - (ts(run.createdAt) || NOW)
					: wd.durationMs,
		};
		all.push(rec);
	}
}

annotateIdleGapConcurrency(all);
for (const rec of all) rec.classification = classifyRun(rec);

const completed = all.filter(
	(r) => r.successful && Number.isFinite(r.durationMs),
);
const nonSuccess = all.filter((r) => !r.successful);
const overall = stats(completed.map((r) => r.durationMs));
const thresholdP90 = overall.p90;
const thresholdP95 = overall.p95;
const slowP95 = completed
	.filter((r) => r.durationMs >= thresholdP95)
	.sort((a, b) => b.durationMs - a.durationMs);
const slowP90 = completed
	.filter((r) => r.durationMs >= thresholdP90)
	.sort((a, b) => b.durationMs - a.durationMs);
const byName = [
	...completed.reduce((m, r) => {
		const a = m.get(r.name) || [];
		a.push(r.durationMs);
		m.set(r.name, a);
		return m;
	}, new Map()),
]
	.map(([name, vals]) => ({ name, ...stats(vals) }))
	.sort((a, b) => b.sum - a.sum);
const stageAggMap = new Map();
for (const r of completed) {
	for (const s of r.stageSummaries || []) {
		const key = `${r.name}\u0000${s.stage}`;
		const cur = stageAggMap.get(key) || {
			name: r.name,
			stage: s.stage,
			runs: 0,
			taskCount: 0,
			wallValues: [],
			sumTaskMs: 0,
			maxTaskMs: 0,
			tokens: 0,
			costUsd: 0,
		};
		cur.runs += 1;
		cur.taskCount += s.count || 0;
		if (Number.isFinite(s.wallMs)) cur.wallValues.push(s.wallMs);
		cur.sumTaskMs += s.sumTaskMs || 0;
		cur.maxTaskMs = Math.max(cur.maxTaskMs, s.maxTaskMs || 0);
		cur.tokens += s.tokens || 0;
		cur.costUsd += s.costUsd || 0;
		stageAggMap.set(key, cur);
	}
}
const stageAggregates = [...stageAggMap.values()]
	.map((x) => {
		const st = stats(x.wallValues);
		return {
			name: x.name,
			stage: x.stage,
			runs: x.runs,
			taskCount: x.taskCount,
			wall: st,
			sumTaskMs: x.sumTaskMs,
			sumTaskFmt: fmt(x.sumTaskMs),
			maxTaskMs: x.maxTaskMs,
			maxTaskFmt: fmt(x.maxTaskMs),
			tokens: x.tokens || undefined,
			costUsd: x.costUsd || undefined,
		};
	})
	.sort((a, b) => (b.wall.sum || 0) - (a.wall.sum || 0));
const topIdleGaps = completed
	.flatMap((r) =>
		r.topIdleGaps.map((g) => ({
			runId: r.runId,
			name: r.name,
			runJson: r.runJson,
			sessionRoot: r.sessionRoot,
			...g,
		})),
	)
	.sort((a, b) => b.ms - a.ms)
	.slice(0, 30);
const topCaptureGaps = completed
	.flatMap((r) =>
		r.topCaptureGaps.map((g) => ({
			runId: r.runId,
			name: r.name,
			runJson: r.runJson,
			sessionRoot: r.sessionRoot,
			...g,
		})),
	)
	.sort((a, b) => b.ms - a.ms)
	.slice(0, 30);
const topTasks = completed
	.flatMap((r) =>
		r.longestTasks.map((t) => ({
			runId: r.runId,
			name: r.name,
			runJson: r.runJson,
			durationMs: r.durationMs,
			...t,
		})),
	)
	.sort((a, b) => b.ms - a.ms)
	.slice(0, 50);
const nonSuccessTop = nonSuccess
	.map((r) => ({
		...r,
		sortMs: r.status === "running" ? r.ageOrElapsedMs : r.durationMs,
	}))
	.sort((a, b) => (b.sortMs || 0) - (a.sortMs || 0))
	.slice(0, 40);
const validationFailureSignatures = aggregateValidationFailures(all);

const out = {
	generatedAt: new Date().toISOString(),
	root: ROOT,
	indexesScanned: indexes.length,
	runsScanned: all.length,
	missingRunJson: missing.length,
	completed: completed.length,
	nonSuccess: nonSuccess.length,
	overall,
	thresholds: {
		p90: thresholdP90,
		p90Fmt: fmt(thresholdP90),
		p95: thresholdP95,
		p95Fmt: fmt(thresholdP95),
	},
	byName,
	stageAggregates,
	slowP95: slowP95.slice(0, 50),
	slowP90: slowP90.slice(0, 80),
	topIdleGaps,
	topCaptureGaps,
	topTasks,
	nonSuccessTop,
	validationFailureSignatures,
};
writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));

function mdTable(rows, headers) {
	const h = `| ${headers.map((x) => x[0]).join(" | ")} |\n| ${headers.map(() => "---").join(" | ")} |`;
	const b = rows
		.map(
			(row) =>
				`| ${headers
					.map(([_, fn]) =>
						String(fn(row) ?? "")
							.replace(/\n/g, "<br>")
							.replace(/\|/g, "\\|"),
					)
					.join(" | ")} |`,
		)
		.join("\n");
	return `${h}\n${b}`;
}
const lines = [];
lines.push(`# Slow workflow forensics`);
lines.push(``);
lines.push(`Generated: ${out.generatedAt}`);
lines.push(`Root: ${ROOT}`);
lines.push(
	`Indexes scanned: ${out.indexesScanned}; runs scanned: ${out.runsScanned}; completed-success: ${out.completed}; non-success: ${out.nonSuccess}; missing run.json: ${out.missingRunJson}.`,
);
lines.push(
	`Completed duration: total ${overall.sumFmt}; mean ${overall.meanFmt}; p50 ${overall.p50Fmt}; p90 ${overall.p90Fmt}; p95 ${overall.p95Fmt}; max ${overall.maxFmt}.`,
);
lines.push(``);
lines.push(`## By workflow`);
lines.push(
	mdTable(byName, [
		["workflow", (r) => r.name],
		["n", (r) => r.n],
		["total", (r) => r.sumFmt],
		["mean", (r) => r.meanFmt],
		["p50", (r) => r.p50Fmt],
		["p90", (r) => r.p90Fmt],
		["p95", (r) => r.p95Fmt],
		["max", (r) => r.maxFmt],
	]),
);
lines.push(``);
lines.push(`## Top workflow stages by cumulative stage wall time`);
lines.push(
	mdTable(stageAggregates.slice(0, 25), [
		["workflow", (r) => r.name],
		["stage", (r) => r.stage],
		["runs", (r) => r.runs],
		["tasks", (r) => r.taskCount],
		["cum stage wall", (r) => r.wall.sumFmt],
		["mean wall", (r) => r.wall.meanFmt],
		["p95 wall", (r) => r.wall.p95Fmt],
		["max wall", (r) => r.wall.maxFmt],
		["sum task", (r) => r.sumTaskFmt],
		["max task", (r) => r.maxTaskFmt],
	]),
);
lines.push(``);
lines.push(`## P95+ completed runs`);
lines.push(
	mdTable(slowP95, [
		["duration", (r) => r.durationFmt],
		["workflow", (r) => r.name],
		["runId", (r) => r.runId],
		["tasks", (r) => r.taskCount],
		["idle", (r) => r.idleTotalFmt],
		["material queue", (r) => r.queueTotalFmt],
		["same-batch overlap", (r) => r.sameBatchOverlapTotalFmt],
		["engine-idle", (r) => r.trueIdleTotalFmt],
		["max capture", (r) => r.maxCaptureGapFmt],
		["tags", (r) => r.classification.join(", ")],
		["root", (r) => r.sessionRoot.replace(ROOT, "…")],
	]),
);
lines.push(``);
lines.push(`## Top idle gaps`);
lines.push(
	mdTable(topIdleGaps.slice(0, 15), [
		["gap", (r) => r.fmt],
		["class", (r) => r.classification],
		["same-batch active", (r) => r.sameBatchActiveCount],
		["workflow", (r) => r.name],
		["runId", (r) => r.runId],
		["after", (r) => r.afterSpecId],
		["before", (r) => r.beforeSpecId],
		[
			"active sibling examples",
			(r) =>
				(r.sameBatchActiveRuns || [])
					.map((x) => `${x.runId} ${x.overlapFmt}`)
					.join("<br>"),
		],
		["start", (r) => r.startIso],
		["end", (r) => r.endIso],
	]),
);
lines.push(``);
lines.push(`## Top terminal capture gaps`);
lines.push(
	mdTable(topCaptureGaps.slice(0, 15), [
		["gap", (r) => r.fmt],
		["workflow", (r) => r.name],
		["runId", (r) => r.runId],
		["task", (r) => r.specId],
		["backend done", (r) => r.backendDone],
		["workflow done", (r) => r.workflowTaskDone],
	]),
);
lines.push(``);
lines.push(`## Longest individual tasks`);
lines.push(
	mdTable(topTasks.slice(0, 25), [
		["task duration", (r) => r.fmt],
		["workflow", (r) => r.name],
		["runId", (r) => r.runId],
		["task", (r) => r.specId],
		["thinking", (r) => r.thinking],
		["tokens", (r) => r.tokens || ""],
		["cost", (r) => (r.costUsd ? `$${Number(r.costUsd).toFixed(3)}` : "")],
	]),
);
lines.push(``);
lines.push(`## Repeated output-validation failure signatures`);
if (validationFailureSignatures.length) {
	lines.push(
		mdTable(validationFailureSignatures.slice(0, 25), [
			["count", (r) => r.count],
			["runs", (r) => r.runCount],
			["workflow", (r) => r.workflow],
			["stage", (r) => r.stageId],
			["schema path", (r) => r.schemaPath],
			["signal", (r) => r.validitySignal],
			["triage", (r) => r.triageCategory],
			["benchmark signal", (r) => r.benchmarkValiditySignal],
			["message", (r) => r.message],
			[
				"examples",
				(r) =>
					(r.examples || [])
						.map((x) => `${x.runId}/${x.taskId}: ${x.evidencePath}`)
						.join("<br>"),
			],
		]),
	);
} else {
	lines.push(`No invalid-attempt validation failure artifacts found.`);
}
lines.push(``);
lines.push(`## Non-success / potentially stale`);
lines.push(
	mdTable(nonSuccessTop.slice(0, 25), [
		["status", (r) => r.status],
		["elapsed/age", (r) => fmt(r.sortMs)],
		["workflow", (r) => r.name],
		["runId", (r) => r.runId],
		["tasks", (r) => r.taskCount],
		["summary", (r) => JSON.stringify(r.taskSummary || {})],
		["root", (r) => r.sessionRoot.replace(ROOT, "…")],
	]),
);
writeFileSync(OUT_MD, lines.join("\n"));
console.log(
	JSON.stringify(
		{
			outJson: OUT_JSON,
			outMd: OUT_MD,
			...out.thresholds,
			indexes: indexes.length,
			runs: all.length,
			completed: completed.length,
			nonSuccess: nonSuccess.length,
		},
		null,
		2,
	),
);
