#!/usr/bin/env node
import {
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

const HELP = `Usage: node tools/dynamic-tool-result-budget-cohort.mjs <path> [...]

Each explicit path must be one of:
  - a workflow run.json file
  - a .pi/workflows/<run-id> directory
  - a .pi/workflows directory
  - a project directory containing .pi/workflows

The collector follows no out-of-root run links, writes no files, performs no
workflow/provider calls, and emits one JSON document to stdout.`;
const RUN_STATUSES = new Set([
	"running",
	"blocked",
	"completed",
	"failed",
	"interrupted",
]);
const TASK_STATUSES = new Set([
	"pending",
	"running",
	"blocked",
	"completed",
	"failed",
	"skipped",
	"interrupted",
]);

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
	console.log(HELP);
	process.exit(0);
}
if (args.length === 0 || args.some((arg) => arg.startsWith("-"))) {
	console.error(HELP);
	process.exit(2);
}

let buildDynamicToolResultBudgetMetrics;
try {
	({ buildDynamicToolResultBudgetMetrics } = await import(
		"../dist/dynamic-tool-result-budget-metrics.js"
	));
} catch (error) {
	console.error(
		`Unable to load built metrics; run npm run build first: ${errorMessage(error)}`,
	);
	process.exit(1);
}

const inputs = args.map((input) => resolve(input));
const errors = [];
const discovered = [];
for (const input of inputs) {
	try {
		discovered.push(...discoverRunFiles(input));
	} catch (error) {
		errors.push({ path: input, error: errorMessage(error) });
	}
}
const runFiles = [...new Set(discovered)].sort();
const runs = [];
for (const runFile of runFiles) {
	try {
		const run = JSON.parse(readFileSync(runFile, "utf8"));
		assertRunRecord(run, runFile);
		runs.push({
			path: runFile,
			run,
			metrics: buildDynamicToolResultBudgetMetrics(run),
		});
	} catch (error) {
		errors.push({ path: runFile, error: errorMessage(error) });
	}
}

const output = {
	schemaVersion: 1,
	generatedAt: new Date().toISOString(),
	inputs,
	runsDiscovered: runFiles.length,
	runsRead: runs.length,
	cohort: buildCohort(runs),
	runs: runs.map(({ path, run, metrics }) => ({
		path,
		runId: run.runId,
		status: run.status,
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
		provenanceMode: run.provenance?.mode ?? null,
		dynamicAudit: isAuditRecord(run.dynamicAudit) ? run.dynamicAudit : null,
		metrics,
	})),
	errors,
};
console.log(JSON.stringify(output, null, 2));
if (errors.length > 0 || runs.length === 0) process.exitCode = 1;

function discoverRunFiles(input) {
	if (!existsSync(input)) throw new Error("path does not exist");
	const canonicalInput = realpathSync(input);
	const info = statSync(canonicalInput);
	if (info.isFile()) {
		if (basename(input) !== "run.json") {
			throw new Error("file input must be named run.json");
		}
		return [canonicalInput];
	}
	if (!info.isDirectory()) throw new Error("path is not a file or directory");

	const directRun = join(canonicalInput, "run.json");
	if (existsSync(directRun) && statSync(directRun).isFile()) {
		return [containedRunFile(canonicalInput, directRun)];
	}

	const projectWorkflowPath = join(canonicalInput, ".pi", "workflows");
	let workflowRoot = canonicalInput;
	if (existsSync(projectWorkflowPath)) {
		const canonicalWorkflowRoot = realpathSync(projectWorkflowPath);
		assertContained(canonicalInput, canonicalWorkflowRoot);
		if (!statSync(canonicalWorkflowRoot).isDirectory()) {
			throw new Error(".pi/workflows is not a directory");
		}
		workflowRoot = canonicalWorkflowRoot;
	}
	const files = [];
	for (const entry of readdirSync(workflowRoot, { withFileTypes: true })) {
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		const candidate = join(workflowRoot, entry.name, "run.json");
		if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
		files.push(containedRunFile(workflowRoot, candidate));
	}
	if (files.length === 0) {
		throw new Error("no immediate workflow run.json files found");
	}
	return files;
}

function containedRunFile(root, candidate) {
	const canonical = realpathSync(candidate);
	assertContained(root, canonical);
	return canonical;
}

function assertContained(root, candidate) {
	const pathFromRoot = relative(root, candidate);
	if (
		pathFromRoot === ".." ||
		pathFromRoot.startsWith(`..${sep}`) ||
		isAbsolute(pathFromRoot)
	) {
		throw new Error(`run path escapes explicit root: ${candidate}`);
	}
}

function assertRunRecord(run, path) {
	if (!isPlainRecord(run)) {
		throw new Error(`${path}: run.json must contain an object`);
	}
	if (typeof run.runId !== "string" || !run.runId.trim()) {
		throw new Error(`${path}: runId must be a non-empty string`);
	}
	if (!RUN_STATUSES.has(run.status)) {
		throw new Error(`${path}: invalid run status`);
	}
	if (typeof run.createdAt !== "string" || typeof run.updatedAt !== "string") {
		throw new Error(`${path}: createdAt and updatedAt must be strings`);
	}
	if (!Array.isArray(run.tasks)) {
		throw new Error(`${path}: tasks must be an array`);
	}
	for (const [index, task] of run.tasks.entries()) {
		if (!isPlainRecord(task)) {
			throw new Error(`${path}: task ${index} must be an object`);
		}
		if (typeof task.taskId !== "string" || typeof task.specId !== "string") {
			throw new Error(`${path}: task ${index} must have taskId and specId`);
		}
		if (!TASK_STATUSES.has(task.status)) {
			throw new Error(`${path}: task ${index} has invalid status`);
		}
		if (task.dynamicGenerated !== undefined) {
			if (
				!isPlainRecord(task.dynamicGenerated) ||
				typeof task.dynamicGenerated.controllerSpecId !== "string" ||
				!task.dynamicGenerated.controllerSpecId.trim()
			) {
				throw new Error(
					`${path}: task ${index} has invalid dynamicGenerated metadata`,
				);
			}
		}
		if (task.toolResultBudget !== undefined) {
			if (
				!isPlainRecord(task.toolResultBudget) ||
				!Array.isArray(task.toolResultBudget.attempts) ||
				task.toolResultBudget.attempts.some(
					(attempt) => !isPlainRecord(attempt),
				)
			) {
				throw new Error(
					`${path}: task ${index} has invalid toolResultBudget telemetry`,
				);
			}
		}
	}
}

function buildCohort(entries) {
	const totals = entries.map((entry) => entry.metrics.totals);
	const utilizationSamples = totals
		.flatMap((entry) => entry.utilizationSamples)
		.filter(Number.isFinite)
		.sort((left, right) => left - right);
	const fullyReportingTasks = sum(totals, "fullyReportingTasks");
	const partiallyReportingTasks = sum(totals, "partiallyReportingTasks");
	const unavailableTasks = sum(totals, "unavailableTasks");
	const eligibleTasks =
		fullyReportingTasks + partiallyReportingTasks + unavailableTasks;
	const auditRecords = entries
		.map((entry) => entry.run.dynamicAudit)
		.filter(isAuditRecord);
	return {
		runs: entries.length,
		runsWithDynamicTasks: totals.filter((entry) => entry.tasks > 0).length,
		runsWithBudgetSignals: totals.filter(hasBudgetSignal).length,
		runsIncomplete: totals.filter((entry) => entry.incomplete).length,
		runStatusCounts: countBy(entries.map((entry) => entry.run.status)),
		dynamicTasks: sum(totals, "tasks"),
		terminalDynamicTasks: sum(totals, "terminalTasks"),
		reportingTasks: sum(totals, "reportingTasks"),
		fullyReportingTasks,
		partiallyReportingTasks,
		unavailableTasks,
		disabledTasks: sum(totals, "disabledTasks"),
		pendingTelemetryTasks: sum(totals, "pendingTelemetryTasks"),
		completeTaskReportingRate:
			eligibleTasks === 0 ? null : fullyReportingTasks / eligibleTasks,
		attempts: sum(totals, "attempts"),
		terminalAttempts: sum(totals, "terminalAttempts"),
		reportingAttempts: sum(totals, "reportingAttempts"),
		unavailableAttempts: sum(totals, "unavailableAttempts"),
		disabledConfigurationAttempts: sum(
			totals,
			"disabledConfigurationAttempts",
		),
		evictionCounterExpectedAttempts: sum(
			totals,
			"evictionCounterExpectedAttempts",
		),
		evictionCounterReportingAttempts: sum(
			totals,
			"evictionCounterReportingAttempts",
		),
		observedEvictedCount: sum(totals, "observedEvictedCount"),
		observedEvictedChars: sum(totals, "observedEvictedChars"),
		evictionAttempts: sum(totals, "evictionAttempts"),
		warningAttempts: sum(totals, "warningAttempts"),
		forcedEvictionAttempts: sum(totals, "forcedEvictionAttempts"),
		contextRecoveryAttempts: sum(totals, "contextRecoveryAttempts"),
		contextLengthExceededAttempts: sum(
			totals,
			"contextLengthExceededAttempts",
		),
		configuredCapValues: sortedUnique(
			totals.flatMap((entry) => entry.configuredCapValues),
		),
		backendCapValues: sortedUnique(
			totals.flatMap((entry) => entry.backendCapValues),
		),
		utilization: {
			samples: utilizationSamples.length,
			p50: quantile(utilizationSamples, 0.5),
			p95: quantile(utilizationSamples, 0.95),
			max: utilizationSamples.at(-1) ?? null,
		},
		dynamicAudit: {
			runsReporting: auditRecords.length,
			claimsTotal: sum(auditRecords, "claimsTotal"),
			claimsWithSources: sum(auditRecords, "claimsWithSources"),
			claimsWithoutSources: sum(auditRecords, "claimsWithoutSources"),
			sourceRefJoinFailures: sum(auditRecords, "sourceRefJoinFailures"),
		},
	};
}

function hasBudgetSignal(totals) {
	return (
		totals.evictionAttempts > 0 ||
		totals.forcedEvictionAttempts > 0 ||
		totals.contextRecoveryAttempts > 0 ||
		totals.contextLengthExceededAttempts > 0 ||
		totals.warningAttempts > 0
	);
}

function sum(records, key) {
	return records.reduce((total, record) => {
		const value = record?.[key];
		return total + (typeof value === "number" && Number.isFinite(value) ? value : 0);
	}, 0);
}

function countBy(values) {
	const counts = Object.create(null);
	for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
	return counts;
}

function isAuditRecord(value) {
	return isPlainRecord(value) && !("error" in value);
}

function isPlainRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sortedUnique(values) {
	return [...new Set(values.filter(Number.isFinite))].sort(
		(left, right) => left - right,
	);
}

function quantile(sorted, fraction) {
	if (sorted.length === 0) return null;
	const index = Math.max(
		0,
		Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1),
	);
	return sorted[index];
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
