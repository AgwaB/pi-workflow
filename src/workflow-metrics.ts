import type {
	TaskRunStatus,
	WorkflowRunRecord,
	WorkflowRunStatus,
	WorkflowRunType,
	WorkflowTaskRunRecord,
	WorkflowTaskUsageValues,
} from "./types.js";

export const WORKFLOW_METRICS_SCHEMA_VERSION = 1;
export const WORKFLOW_METRICS_PRICING_MODEL_VERSION = "provider-reported-v1";

export type WorkflowMetricsSchemaVersion =
	typeof WORKFLOW_METRICS_SCHEMA_VERSION;
export type WorkflowMetricsPricingModelVersion =
	typeof WORKFLOW_METRICS_PRICING_MODEL_VERSION;
export type WorkflowMetricsPricingSource = "provider-reported";
export type WorkflowMetricValue = number | null;

export interface WorkflowObservedUsageMetrics {
	inputTokens: WorkflowMetricValue;
	outputTokens: WorkflowMetricValue;
	totalTokens: WorkflowMetricValue;
	cachedInputTokens: WorkflowMetricValue;
	cacheCreationInputTokens: WorkflowMetricValue;
	cacheReadInputTokens: WorkflowMetricValue;
	reasoningTokens: WorkflowMetricValue;
	costUsd: WorkflowMetricValue;
	contributingTaskIds: string[];
	omittedTaskIds: string[];
}

export interface WorkflowUsageMetrics {
	inputTokens: WorkflowMetricValue;
	outputTokens: WorkflowMetricValue;
	totalTokens: WorkflowMetricValue;
	cachedInputTokens: WorkflowMetricValue;
	cacheCreationInputTokens: WorkflowMetricValue;
	cacheReadInputTokens: WorkflowMetricValue;
	reasoningTokens: WorkflowMetricValue;
	/**
	 * Provider-reported cost only. This helper intentionally never derives cost
	 * from token counts or model names.
	 */
	costUsd: WorkflowMetricValue;
	observed: WorkflowObservedUsageMetrics;
	attempts: number;
	unavailable: boolean;
	incomplete: boolean;
	unavailableTaskIds: string[];
	incompleteTaskIds: string[];
}

export interface WorkflowLaunchTimingMetrics {
	launchWaitMs: WorkflowMetricValue;
	launchDurationMs: WorkflowMetricValue;
	executionMs: WorkflowMetricValue;
	totalMs: WorkflowMetricValue;
	terminalCaptureLagMs: WorkflowMetricValue;
	launchSlotReleaseDelayMs: WorkflowMetricValue;
	refreshReconcileMs: WorkflowMetricValue;
	refreshStatusPollMs: WorkflowMetricValue;
	terminalOutputCopyMs: WorkflowMetricValue;
	terminalStderrCopyMs: WorkflowMetricValue;
	terminalOutputBytes: WorkflowMetricValue;
	terminalStderrBytes: WorkflowMetricValue;
	terminalArtifactMaterializeMs: WorkflowMetricValue;
	terminalArtifactBundleWriteMs: WorkflowMetricValue;
	attempts: number;
	unavailable: boolean;
	incomplete: boolean;
	unavailableTaskIds: string[];
	incompleteTaskIds: string[];
}

export interface WorkflowRetryMetrics {
	launchRetries: number;
	outputRetries: number;
	resumeEvents: number;
	totalRetryEvents: number;
	tasksWithRetries: number;
}

export interface WorkflowTaskStatusCounts {
	pending: number;
	running: number;
	blocked: number;
	completed: number;
	failed: number;
	skipped: number;
	interrupted: number;
	total: number;
}

export interface WorkflowRunMetricsRollup {
	taskCount: number;
	statusCounts: WorkflowTaskStatusCounts;
	usage: WorkflowUsageMetrics;
	launchTiming: WorkflowLaunchTimingMetrics;
	retries: WorkflowRetryMetrics;
}

export interface WorkflowTaskMetrics {
	taskId: string;
	specId: string;
	displayName: string;
	agent: string;
	status: TaskRunStatus;
	statusDetail: string;
	stageId: string | null;
	kind: string | null;
	provider: string | null;
	model: string | null;
	thinking: string | null;
	usage: WorkflowUsageMetrics;
	launchTiming: WorkflowLaunchTimingMetrics;
	retries: WorkflowRetryMetrics;
}

export interface WorkflowStageMetrics extends WorkflowRunMetricsRollup {
	stageId: string | null;
}

export interface WorkflowMissingMetricEntry {
	taskId: string;
	metrics: string[];
}

export interface WorkflowRunMetricsMetadata {
	usageUnavailableTaskIds: string[];
	usageIncompleteTaskIds: string[];
	usageMissingMetricsByTask: WorkflowMissingMetricEntry[];
	launchTimingUnavailableTaskIds: string[];
	launchTimingIncompleteTaskIds: string[];
	launchTimingMissingMetricsByTask: WorkflowMissingMetricEntry[];
	incomplete: boolean;
	unavailable: boolean;
}

export interface WorkflowRunMetrics {
	schemaVersion: WorkflowMetricsSchemaVersion;
	pricingModelVersion: WorkflowMetricsPricingModelVersion;
	pricingSource: WorkflowMetricsPricingSource;
	costsAreProviderReported: true;
	run: {
		runId: string;
		name?: string;
		type: WorkflowRunType;
		status: WorkflowRunStatus;
		createdAt: string;
		updatedAt: string;
	};
	totals: WorkflowRunMetricsRollup;
	byStage: WorkflowStageMetrics[];
	byTask: WorkflowTaskMetrics[];
	metadata: WorkflowRunMetricsMetadata;
}

type UsageMetricKey = keyof WorkflowTaskUsageValues;
type TimingMetricKey =
	| "launchWaitMs"
	| "launchDurationMs"
	| "executionMs"
	| "totalMs"
	| "launchSlotReleaseDelayMs"
	| "refreshReconcileMs"
	| "refreshStatusPollMs"
	| "terminalOutputCopyMs"
	| "terminalStderrCopyMs"
	| "terminalOutputBytes"
	| "terminalStderrBytes"
	| "terminalArtifactMaterializeMs"
	| "terminalArtifactBundleWriteMs";

const USAGE_METRIC_KEYS: UsageMetricKey[] = [
	"inputTokens",
	"outputTokens",
	"totalTokens",
	"cachedInputTokens",
	"cacheCreationInputTokens",
	"cacheReadInputTokens",
	"reasoningTokens",
	"costUsd",
];

const TIMING_METRIC_KEYS: TimingMetricKey[] = [
	"launchWaitMs",
	"launchDurationMs",
	"executionMs",
	"totalMs",
	"launchSlotReleaseDelayMs",
	"refreshReconcileMs",
	"refreshStatusPollMs",
	"terminalOutputCopyMs",
	"terminalStderrCopyMs",
	"terminalOutputBytes",
	"terminalStderrBytes",
	"terminalArtifactMaterializeMs",
	"terminalArtifactBundleWriteMs",
];

const REQUIRED_TIMING_METRIC_KEYS: TimingMetricKey[] = [
	"launchWaitMs",
	"launchDurationMs",
	"executionMs",
	"totalMs",
	"launchSlotReleaseDelayMs",
];

const DIRECT_TIMING_METRIC_KEYS = new Set<TimingMetricKey>([
	"launchSlotReleaseDelayMs",
	"refreshReconcileMs",
	"refreshStatusPollMs",
	"terminalOutputCopyMs",
	"terminalStderrCopyMs",
	"terminalOutputBytes",
	"terminalStderrBytes",
	"terminalArtifactMaterializeMs",
	"terminalArtifactBundleWriteMs",
]);

function metricValue(
	record: object | undefined,
	key: string,
): WorkflowMetricValue {
	if (!record || !Object.hasOwn(record, key)) return null;
	const value = (record as Record<string, unknown>)[key];
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: null;
}

function metricString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value : null;
}

function sumMetricValues(values: WorkflowMetricValue[]): {
	value: WorkflowMetricValue;
	incomplete: boolean;
} {
	if (values.length === 0) return { value: null, incomplete: true };
	let total = 0;
	for (const value of values) {
		if (value === null) return { value: null, incomplete: true };
		total += value;
	}
	return { value: total, incomplete: false };
}

function sumObservedMetricValues(
	values: WorkflowMetricValue[],
): WorkflowMetricValue {
	let total = 0;
	let count = 0;
	for (const value of values) {
		if (value === null) continue;
		total += value;
		count += 1;
	}
	return count > 0 ? total : null;
}

function observedUsageForTasks(
	tasks: Array<{ taskId: string; usage: WorkflowUsageMetrics }>,
): WorkflowObservedUsageMetrics {
	const contributingTaskIds = tasks
		.filter((task) => USAGE_METRIC_KEYS.some((key) => task.usage[key] !== null))
		.map((task) => task.taskId);
	const omittedTaskIds = tasks
		.filter((task) =>
			USAGE_METRIC_KEYS.every((key) => task.usage[key] === null),
		)
		.map((task) => task.taskId);
	return {
		inputTokens: sumObservedMetricValues(
			tasks.map((task) => task.usage.inputTokens),
		),
		outputTokens: sumObservedMetricValues(
			tasks.map((task) => task.usage.outputTokens),
		),
		totalTokens: sumObservedMetricValues(
			tasks.map((task) => task.usage.totalTokens),
		),
		cachedInputTokens: sumObservedMetricValues(
			tasks.map((task) => task.usage.cachedInputTokens),
		),
		cacheCreationInputTokens: sumObservedMetricValues(
			tasks.map((task) => task.usage.cacheCreationInputTokens),
		),
		cacheReadInputTokens: sumObservedMetricValues(
			tasks.map((task) => task.usage.cacheReadInputTokens),
		),
		reasoningTokens: sumObservedMetricValues(
			tasks.map((task) => task.usage.reasoningTokens),
		),
		costUsd: sumObservedMetricValues(tasks.map((task) => task.usage.costUsd)),
		contributingTaskIds,
		omittedTaskIds,
	};
}

function sumOptionalMetricValues(values: WorkflowMetricValue[]): {
	value: WorkflowMetricValue;
	incomplete: boolean;
} {
	let total = 0;
	let observed = false;
	for (const value of values) {
		if (value === null) continue;
		observed = true;
		total += value;
	}
	return { value: observed ? total : null, incomplete: false };
}

function usageAttempts(task: WorkflowTaskRunRecord): number {
	return task.usage?.aggregate?.attempts ?? task.usage?.attempts?.length ?? 0;
}

function timingAttempts(task: WorkflowTaskRunRecord): number {
	return task.timing?.aggregate?.attempts ?? task.timing?.attempts?.length ?? 0;
}

function terminalCaptureLagMs(
	timing: WorkflowTaskRunRecord["timing"],
): WorkflowMetricValue {
	if (!timing?.capturedAt || !timing.executionCompletedAt) return null;
	const capturedAt = Date.parse(timing.capturedAt);
	const completedAt = Date.parse(timing.executionCompletedAt);
	if (!Number.isFinite(capturedAt) || !Number.isFinite(completedAt))
		return null;
	const lagMs = capturedAt - completedAt;
	return lagMs >= 0 ? lagMs : null;
}

function taskUsageMetrics(task: WorkflowTaskRunRecord): WorkflowUsageMetrics {
	const usage = task.usage;
	const source = usage?.aggregate ?? usage;
	const unavailable =
		usage === undefined ||
		usage.attempts?.some((attempt) => attempt.unavailable) === true;
	const metrics = Object.fromEntries(
		USAGE_METRIC_KEYS.map((key) => [key, metricValue(source, key)]),
	) as Record<UsageMetricKey, WorkflowMetricValue>;
	const incomplete =
		unavailable ||
		usage?.incomplete === true ||
		usage?.aggregate?.incomplete === true ||
		USAGE_METRIC_KEYS.some((key) => metrics[key] === null);
	const hasObserved = USAGE_METRIC_KEYS.some((key) => metrics[key] !== null);
	return {
		inputTokens: metrics.inputTokens,
		outputTokens: metrics.outputTokens,
		totalTokens: metrics.totalTokens,
		cachedInputTokens: metrics.cachedInputTokens,
		cacheCreationInputTokens: metrics.cacheCreationInputTokens,
		cacheReadInputTokens: metrics.cacheReadInputTokens,
		reasoningTokens: metrics.reasoningTokens,
		costUsd: metrics.costUsd,
		observed: {
			...metrics,
			contributingTaskIds: hasObserved ? [task.taskId] : [],
			omittedTaskIds: hasObserved ? [] : [task.taskId],
		},
		attempts: usageAttempts(task),
		unavailable,
		incomplete,
		unavailableTaskIds: unavailable ? [task.taskId] : [],
		incompleteTaskIds: incomplete ? [task.taskId] : [],
	};
}

function taskLaunchTimingMetrics(
	task: WorkflowTaskRunRecord,
): WorkflowLaunchTimingMetrics {
	const timing = task.timing;
	const aggregateSource = timing?.aggregate ?? timing;
	const unavailable = timing === undefined;
	const metrics = Object.fromEntries(
		TIMING_METRIC_KEYS.map((key) => [
			key,
			metricValue(
				DIRECT_TIMING_METRIC_KEYS.has(key) ? timing : aggregateSource,
				key,
			),
		]),
	) as Record<TimingMetricKey, WorkflowMetricValue>;
	const incomplete =
		unavailable ||
		timing?.aggregate?.incomplete === true ||
		REQUIRED_TIMING_METRIC_KEYS.some((key) => metrics[key] === null);
	return {
		launchWaitMs: metrics.launchWaitMs,
		launchDurationMs: metrics.launchDurationMs,
		executionMs: metrics.executionMs,
		totalMs: metrics.totalMs,
		terminalCaptureLagMs: terminalCaptureLagMs(timing),
		launchSlotReleaseDelayMs: metrics.launchSlotReleaseDelayMs,
		refreshReconcileMs: metrics.refreshReconcileMs,
		refreshStatusPollMs: metrics.refreshStatusPollMs,
		terminalOutputCopyMs: metrics.terminalOutputCopyMs,
		terminalStderrCopyMs: metrics.terminalStderrCopyMs,
		terminalOutputBytes: metrics.terminalOutputBytes,
		terminalStderrBytes: metrics.terminalStderrBytes,
		terminalArtifactMaterializeMs: metrics.terminalArtifactMaterializeMs,
		terminalArtifactBundleWriteMs: metrics.terminalArtifactBundleWriteMs,
		attempts: timingAttempts(task),
		unavailable,
		incomplete,
		unavailableTaskIds: unavailable ? [task.taskId] : [],
		incompleteTaskIds: incomplete ? [task.taskId] : [],
	};
}

function sumResumeRetryAttempts(
	task: WorkflowTaskRunRecord,
	key: "launchRetryAttempts" | "outputRetryAttempts",
): number {
	return (task.resumeEvents ?? []).reduce((total, event) => {
		const attempts = event[key];
		return typeof attempts === "number" && Number.isFinite(attempts)
			? total + attempts
			: total;
	}, 0);
}

function taskRetryMetrics(task: WorkflowTaskRunRecord): WorkflowRetryMetrics {
	const launchRetries =
		(task.launchRetry?.attempts ?? 0) +
		sumResumeRetryAttempts(task, "launchRetryAttempts");
	const outputRetries =
		(task.outputRetry?.attempts ?? 0) +
		sumResumeRetryAttempts(task, "outputRetryAttempts");
	const resumeEvents = task.resumeEvents?.length ?? 0;
	const totalRetryEvents = launchRetries + outputRetries + resumeEvents;
	return {
		launchRetries,
		outputRetries,
		resumeEvents,
		totalRetryEvents,
		tasksWithRetries: totalRetryEvents > 0 ? 1 : 0,
	};
}

function emptyStatusCounts(): WorkflowTaskStatusCounts {
	return {
		pending: 0,
		running: 0,
		blocked: 0,
		completed: 0,
		failed: 0,
		skipped: 0,
		interrupted: 0,
		total: 0,
	};
}

function rollupUsage(tasks: WorkflowTaskMetrics[]): WorkflowUsageMetrics {
	const rollup = Object.fromEntries(
		USAGE_METRIC_KEYS.map((key) => [
			key,
			sumMetricValues(tasks.map((task) => task.usage[key])),
		]),
	) as Record<UsageMetricKey, ReturnType<typeof sumMetricValues>>;
	const unavailableTaskIds = tasks.flatMap(
		(task) => task.usage.unavailableTaskIds,
	);
	const incompleteTaskIds = tasks.flatMap(
		(task) => task.usage.incompleteTaskIds,
	);
	return {
		inputTokens: rollup.inputTokens.value,
		outputTokens: rollup.outputTokens.value,
		totalTokens: rollup.totalTokens.value,
		cachedInputTokens: rollup.cachedInputTokens.value,
		cacheCreationInputTokens: rollup.cacheCreationInputTokens.value,
		cacheReadInputTokens: rollup.cacheReadInputTokens.value,
		reasoningTokens: rollup.reasoningTokens.value,
		costUsd: rollup.costUsd.value,
		observed: observedUsageForTasks(tasks),
		attempts: tasks.reduce((total, task) => total + task.usage.attempts, 0),
		unavailable: unavailableTaskIds.length > 0,
		incomplete:
			incompleteTaskIds.length > 0 ||
			USAGE_METRIC_KEYS.some((key) => rollup[key].incomplete),
		unavailableTaskIds,
		incompleteTaskIds,
	};
}

function rollupLaunchTiming(
	tasks: WorkflowTaskMetrics[],
): WorkflowLaunchTimingMetrics {
	const rollup = Object.fromEntries(
		TIMING_METRIC_KEYS.map((key) => [
			key,
			REQUIRED_TIMING_METRIC_KEYS.includes(key)
				? sumMetricValues(tasks.map((task) => task.launchTiming[key]))
				: sumOptionalMetricValues(tasks.map((task) => task.launchTiming[key])),
		]),
	) as Record<TimingMetricKey, ReturnType<typeof sumMetricValues>>;
	const unavailableTaskIds = tasks.flatMap(
		(task) => task.launchTiming.unavailableTaskIds,
	);
	const incompleteTaskIds = tasks.flatMap(
		(task) => task.launchTiming.incompleteTaskIds,
	);
	return {
		launchWaitMs: rollup.launchWaitMs.value,
		launchDurationMs: rollup.launchDurationMs.value,
		executionMs: rollup.executionMs.value,
		totalMs: rollup.totalMs.value,
		terminalCaptureLagMs: sumOptionalMetricValues(
			tasks.map((task) => task.launchTiming.terminalCaptureLagMs),
		).value,
		launchSlotReleaseDelayMs: rollup.launchSlotReleaseDelayMs.value,
		refreshReconcileMs: rollup.refreshReconcileMs.value,
		refreshStatusPollMs: rollup.refreshStatusPollMs.value,
		terminalOutputCopyMs: rollup.terminalOutputCopyMs.value,
		terminalStderrCopyMs: rollup.terminalStderrCopyMs.value,
		terminalOutputBytes: rollup.terminalOutputBytes.value,
		terminalStderrBytes: rollup.terminalStderrBytes.value,
		terminalArtifactMaterializeMs: rollup.terminalArtifactMaterializeMs.value,
		terminalArtifactBundleWriteMs: rollup.terminalArtifactBundleWriteMs.value,
		attempts: tasks.reduce(
			(total, task) => total + task.launchTiming.attempts,
			0,
		),
		unavailable: unavailableTaskIds.length > 0,
		incomplete:
			incompleteTaskIds.length > 0 ||
			REQUIRED_TIMING_METRIC_KEYS.some((key) => rollup[key].incomplete),
		unavailableTaskIds,
		incompleteTaskIds,
	};
}

function rollupRetries(tasks: WorkflowTaskMetrics[]): WorkflowRetryMetrics {
	const launchRetries = tasks.reduce(
		(total, task) => total + task.retries.launchRetries,
		0,
	);
	const outputRetries = tasks.reduce(
		(total, task) => total + task.retries.outputRetries,
		0,
	);
	const resumeEvents = tasks.reduce(
		(total, task) => total + task.retries.resumeEvents,
		0,
	);
	return {
		launchRetries,
		outputRetries,
		resumeEvents,
		totalRetryEvents: launchRetries + outputRetries + resumeEvents,
		tasksWithRetries: tasks.reduce(
			(total, task) => total + task.retries.tasksWithRetries,
			0,
		),
	};
}

function statusCounts(tasks: WorkflowTaskMetrics[]): WorkflowTaskStatusCounts {
	const counts = emptyStatusCounts();
	for (const task of tasks) {
		if (Object.hasOwn(counts, task.status)) {
			counts[task.status] += 1;
		}
		counts.total += 1;
	}
	return counts;
}

function rollupTasks(tasks: WorkflowTaskMetrics[]): WorkflowRunMetricsRollup {
	return {
		taskCount: tasks.length,
		statusCounts: statusCounts(tasks),
		usage: rollupUsage(tasks),
		launchTiming: rollupLaunchTiming(tasks),
		retries: rollupRetries(tasks),
	};
}

function missingUsageMetricsByTask(
	tasks: WorkflowTaskMetrics[],
): WorkflowMissingMetricEntry[] {
	return tasks.flatMap((task) => {
		const metrics = USAGE_METRIC_KEYS.filter((key) => task.usage[key] === null);
		return metrics.length === 0 ? [] : [{ taskId: task.taskId, metrics }];
	});
}

function missingLaunchTimingMetricsByTask(
	tasks: WorkflowTaskMetrics[],
): WorkflowMissingMetricEntry[] {
	return tasks.flatMap((task) => {
		const metrics = TIMING_METRIC_KEYS.filter(
			(key) => task.launchTiming[key] === null,
		);
		return metrics.length === 0 ? [] : [{ taskId: task.taskId, metrics }];
	});
}

function stageMetrics(tasks: WorkflowTaskMetrics[]): WorkflowStageMetrics[] {
	const stageIds: Array<string | null> = [];
	for (const task of tasks) {
		if (!stageIds.includes(task.stageId)) stageIds.push(task.stageId);
	}
	return stageIds.map((stageId) => ({
		stageId,
		...rollupTasks(tasks.filter((task) => task.stageId === stageId)),
	}));
}

function taskMetrics(task: WorkflowTaskRunRecord): WorkflowTaskMetrics {
	return {
		taskId: task.taskId,
		specId: task.specId,
		displayName: task.displayName,
		agent: task.agent,
		status: task.status,
		statusDetail: task.statusDetail,
		stageId: task.stageId ?? null,
		kind: task.kind ?? null,
		provider: metricString(task.usage?.provider),
		model: metricString(task.usage?.model ?? task.runtime.model),
		thinking: metricString(task.usage?.thinking ?? task.runtime.thinking),
		usage: taskUsageMetrics(task),
		launchTiming: taskLaunchTimingMetrics(task),
		retries: taskRetryMetrics(task),
	};
}

/**
 * Build a deterministic, JSON-serializable metrics export from a persisted
 * workflow run record. The helper is intentionally pure: it reads only the
 * supplied record, performs no pricing inference, and does not mutate the run.
 */
export function buildWorkflowRunMetrics(
	run: WorkflowRunRecord,
): WorkflowRunMetrics {
	const byTask = run.tasks.map((task) => taskMetrics(task));
	const totals = rollupTasks(byTask);
	return {
		schemaVersion: WORKFLOW_METRICS_SCHEMA_VERSION,
		pricingModelVersion: WORKFLOW_METRICS_PRICING_MODEL_VERSION,
		pricingSource: "provider-reported",
		costsAreProviderReported: true,
		run: {
			runId: run.runId,
			...(run.name === undefined ? {} : { name: run.name }),
			type: run.type,
			status: run.status,
			createdAt: run.createdAt,
			updatedAt: run.updatedAt,
		},
		totals,
		byStage: stageMetrics(byTask),
		byTask,
		metadata: {
			usageUnavailableTaskIds: [...totals.usage.unavailableTaskIds],
			usageIncompleteTaskIds: [...totals.usage.incompleteTaskIds],
			usageMissingMetricsByTask: missingUsageMetricsByTask(byTask),
			launchTimingUnavailableTaskIds: [
				...totals.launchTiming.unavailableTaskIds,
			],
			launchTimingIncompleteTaskIds: [...totals.launchTiming.incompleteTaskIds],
			launchTimingMissingMetricsByTask:
				missingLaunchTimingMetricsByTask(byTask),
			incomplete: totals.usage.incomplete || totals.launchTiming.incomplete,
			unavailable: totals.usage.unavailable || totals.launchTiming.unavailable,
		},
	};
}
