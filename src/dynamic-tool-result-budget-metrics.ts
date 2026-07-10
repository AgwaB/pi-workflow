import type {
	TaskRunStatus,
	WorkflowRunRecord,
	WorkflowRunStatus,
	WorkflowTaskRunRecord,
	WorkflowTaskToolResultBudgetAggregateRecord,
	WorkflowTaskToolResultBudgetAttemptRecord,
} from "./types.js";

export const DYNAMIC_TOOL_RESULT_BUDGET_METRICS_SCHEMA_VERSION = 1;

export type DynamicToolResultBudgetMetricsSchemaVersion =
	typeof DYNAMIC_TOOL_RESULT_BUDGET_METRICS_SCHEMA_VERSION;

type ToolResultBudgetNormalizedValues = Partial<
	Pick<
		WorkflowTaskToolResultBudgetAttemptRecord,
		| "enabled"
		| "maxTotalChars"
		| "warning"
		| "toolResults"
		| "retainedChars"
		| "evictedCount"
		| "evictedChars"
		| "evictableCount"
		| "forcedEvictionApplied"
	>
>;

export interface DynamicToolResultBudgetStatusCounts {
	pending: number;
	running: number;
	blocked: number;
	completed: number;
	failed: number;
	skipped: number;
	interrupted: number;
	total: number;
}

export interface DynamicToolResultBudgetRollup {
	tasks: number;
	terminalTasks: number;
	reportingTasks: number;
	fullyReportingTasks: number;
	partiallyReportingTasks: number;
	unavailableTasks: number;
	disabledTasks: number;
	pendingTelemetryTasks: number;
	completeTaskReportingRate: number | null;
	statusCounts: DynamicToolResultBudgetStatusCounts;
	attempts: number;
	terminalAttempts: number;
	pendingAttempts: number;
	reportingAttempts: number;
	unavailableAttempts: number;
	configuredAttempts: number;
	disabledConfigurationAttempts: number;
	backendEnabledAttempts: number;
	backendDisabledAttempts: number;
	evictionCounterExpectedAttempts: number;
	evictionCounterReportingAttempts: number;
	observedEvictedCount: number;
	observedEvictedChars: number;
	evictionAttempts: number;
	warningAttempts: number;
	forcedEvictionAttempts: number;
	contextRecoveryAttempts: number;
	contextRecoveredAttempts: number;
	contextOverflowRecoveredAttempts: number;
	contextLengthExceededAttempts: number;
	maxToolResults: number | null;
	maxRetainedChars: number | null;
	maxEvictableCount: number | null;
	maxUtilization: number | null;
	utilizationSamples: number[];
	configuredCapValues: number[];
	backendCapValues: number[];
	incomplete: boolean;
}

export interface DynamicToolResultBudgetTaskMetrics
	extends DynamicToolResultBudgetRollup {
	taskId: string;
	specId: string;
	controllerSpecId: string;
	status: TaskRunStatus;
}

export interface DynamicToolResultBudgetControllerMetrics
	extends DynamicToolResultBudgetRollup {
	controllerSpecId: string;
}

export interface DynamicToolResultBudgetRunMetrics {
	schemaVersion: DynamicToolResultBudgetMetricsSchemaVersion;
	run: {
		runId: string;
		name?: string;
		status: WorkflowRunStatus;
		createdAt: string;
		updatedAt: string;
	};
	totals: DynamicToolResultBudgetRollup;
	byController: DynamicToolResultBudgetControllerMetrics[];
	byTask: DynamicToolResultBudgetTaskMetrics[];
	metadata: {
		dynamicTaskIds: string[];
		reportingTaskIds: string[];
		fullyReportingTaskIds: string[];
		partiallyReportingTaskIds: string[];
		unavailableTaskIds: string[];
		disabledTaskIds: string[];
		pendingTelemetryTaskIds: string[];
		incomplete: boolean;
	};
}

const TERMINAL_TASK_STATUSES = new Set<TaskRunStatus>([
	"completed",
	"failed",
	"skipped",
	"interrupted",
]);

type TaskTelemetryClass =
	| "fully-reporting"
	| "partially-reporting"
	| "unavailable"
	| "disabled"
	| "pending";

function finiteNonNegative(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}

function positive(value: unknown): number | undefined {
	const normalized = finiteNonNegative(value);
	return normalized !== undefined && normalized > 0 ? normalized : undefined;
}

export function normalizedToolResultBudgetValues(
	raw: unknown,
): ToolResultBudgetNormalizedValues {
	if (!isPlainRecord(raw)) return {};
	const values: ToolResultBudgetNormalizedValues = {};
	if (typeof raw.enabled === "boolean") values.enabled = raw.enabled;
	const maxTotalChars = positive(raw.maxTotalChars);
	if (maxTotalChars !== undefined) values.maxTotalChars = maxTotalChars;
	if (typeof raw.warning === "string" && raw.warning.trim()) {
		values.warning = raw.warning.trim();
	}
	for (const key of [
		"toolResults",
		"retainedChars",
		"evictedCount",
		"evictedChars",
		"evictableCount",
	] as const) {
		const value = finiteNonNegative(raw[key]);
		if (value !== undefined) values[key] = value;
	}
	if (typeof raw.forcedEvictionApplied === "boolean") {
		values.forcedEvictionApplied = raw.forcedEvictionApplied;
	}
	return values;
}

export function summarizeToolResultBudgetAttempts(
	attempts: readonly WorkflowTaskToolResultBudgetAttemptRecord[],
): WorkflowTaskToolResultBudgetAggregateRecord {
	const unavailableAttempts = attempts.filter(
		(attempt) =>
			attempt.unavailable === true && attempt.configured !== false,
	).length;
	const evictionCounterExpectedAttempts = attempts.filter(
		(attempt) => attempt.reported === true && attempt.enabled !== false,
	).length;
	const evictionCounterReportingAttempts = attempts.filter(
		(attempt) =>
			attempt.reported === true &&
			attempt.enabled !== false &&
			finiteNonNegative(attempt.evictedCount) !== undefined &&
			finiteNonNegative(attempt.evictedChars) !== undefined,
	).length;
	const utilization = attempts.flatMap((attempt) => {
		const retainedChars = finiteNonNegative(attempt.retainedChars);
		const cap =
			positive(attempt.maxTotalChars) ??
			positive(attempt.configuredMaxTotalChars);
		return retainedChars === undefined || cap === undefined
			? []
			: [retainedChars / cap];
	});
	const configuredMaxTotalChars = consistentValue(
		attempts.flatMap((attempt) => {
			const value = positive(attempt.configuredMaxTotalChars);
			return value === undefined ? [] : [value];
		}),
	);
	const backendMaxTotalChars = consistentValue(
		attempts.flatMap((attempt) => {
			const value = positive(attempt.maxTotalChars);
			return value === undefined ? [] : [value];
		}),
	);
	const incomplete =
		unavailableAttempts > 0 ||
		evictionCounterReportingAttempts < evictionCounterExpectedAttempts;
	return {
		attempts: attempts.length,
		terminalAttempts: attempts.filter((attempt) => attempt.terminal === true)
			.length,
		pendingAttempts: attempts.filter((attempt) => attempt.terminal !== true)
			.length,
		reportingAttempts: attempts.filter((attempt) => attempt.reported === true)
			.length,
		unavailableAttempts,
		configuredAttempts: attempts.filter(
			(attempt) => attempt.configured === true,
		).length,
		disabledConfigurationAttempts: attempts.filter(
			(attempt) => attempt.configured === false,
		).length,
		backendEnabledAttempts: attempts.filter(
			(attempt) => attempt.enabled === true,
		).length,
		backendDisabledAttempts: attempts.filter(
			(attempt) => attempt.enabled === false,
		).length,
		evictionCounterExpectedAttempts,
		evictionCounterReportingAttempts,
		observedEvictedCount: attempts.reduce(
			(total, attempt) => total + (finiteNonNegative(attempt.evictedCount) ?? 0),
			0,
		),
		observedEvictedChars: attempts.reduce(
			(total, attempt) => total + (finiteNonNegative(attempt.evictedChars) ?? 0),
			0,
		),
		evictionAttempts: attempts.filter(
			(attempt) =>
				(finiteNonNegative(attempt.evictedCount) ?? 0) > 0 ||
				(finiteNonNegative(attempt.evictedChars) ?? 0) > 0,
		).length,
		warningAttempts: attempts.filter(
			(attempt) =>
				typeof attempt.warning === "string" && attempt.warning.trim().length > 0,
		).length,
		forcedEvictionAttempts: attempts.filter(
			(attempt) => attempt.forcedEvictionApplied === true,
		).length,
		contextRecoveryAttempts: attempts.filter(
			(attempt) =>
				attempt.contextRecovered === true ||
				attempt.contextOverflowRecovered === true,
		).length,
		contextRecoveredAttempts: attempts.filter(
			(attempt) => attempt.contextRecovered === true,
		).length,
		contextOverflowRecoveredAttempts: attempts.filter(
			(attempt) => attempt.contextOverflowRecovered === true,
		).length,
		contextLengthExceededAttempts: attempts.filter(
			(attempt) => attempt.contextLengthExceeded === true,
		).length,
		...(configuredMaxTotalChars === undefined
			? {}
			: { configuredMaxTotalChars }),
		...(backendMaxTotalChars === undefined ? {} : { backendMaxTotalChars }),
		...optionalMaximum(
			"maxToolResults",
			attempts.map((attempt) => finiteNonNegative(attempt.toolResults)),
		),
		...optionalMaximum(
			"maxRetainedChars",
			attempts.map((attempt) => finiteNonNegative(attempt.retainedChars)),
		),
		...optionalMaximum(
			"maxEvictableCount",
			attempts.map((attempt) => finiteNonNegative(attempt.evictableCount)),
		),
		...optionalMaximum("maxUtilization", utilization),
		...(incomplete ? { incomplete: true } : {}),
	};
}

function buildRollup(
	tasks: WorkflowTaskRunRecord[],
): DynamicToolResultBudgetRollup {
	const attempts = tasks.flatMap(taskAttempts);
	const summary = summarizeToolResultBudgetAttempts(attempts);
	const statusCounts = emptyStatusCounts();
	for (const task of tasks) {
		statusCounts[task.status] += 1;
		statusCounts.total += 1;
	}
	const classes = tasks.map(taskTelemetryClass);
	const fullyReportingTasks = count(classes, "fully-reporting");
	const partiallyReportingTasks = count(classes, "partially-reporting");
	const unavailableTasks = count(classes, "unavailable");
	const eligibleTerminalTasks =
		fullyReportingTasks + partiallyReportingTasks + unavailableTasks;
	const utilizationSamples = attempts.flatMap((attempt) => {
		const retainedChars = finiteNonNegative(attempt.retainedChars);
		const cap =
			positive(attempt.maxTotalChars) ??
			positive(attempt.configuredMaxTotalChars);
		return retainedChars === undefined || cap === undefined
			? []
			: [retainedChars / cap];
	});
	const incomplete =
		partiallyReportingTasks > 0 ||
		unavailableTasks > 0 ||
		summary.incomplete === true;
	return {
		tasks: tasks.length,
		terminalTasks: tasks.filter((task) => TERMINAL_TASK_STATUSES.has(task.status))
			.length,
		reportingTasks: fullyReportingTasks + partiallyReportingTasks,
		fullyReportingTasks,
		partiallyReportingTasks,
		unavailableTasks,
		disabledTasks: count(classes, "disabled"),
		pendingTelemetryTasks: count(classes, "pending"),
		completeTaskReportingRate:
			eligibleTerminalTasks === 0
				? null
				: fullyReportingTasks / eligibleTerminalTasks,
		statusCounts,
		attempts: summary.attempts,
		terminalAttempts: summary.terminalAttempts,
		pendingAttempts: summary.pendingAttempts,
		reportingAttempts: summary.reportingAttempts,
		unavailableAttempts: summary.unavailableAttempts,
		configuredAttempts: summary.configuredAttempts,
		disabledConfigurationAttempts: summary.disabledConfigurationAttempts,
		backendEnabledAttempts: summary.backendEnabledAttempts,
		backendDisabledAttempts: summary.backendDisabledAttempts,
		evictionCounterExpectedAttempts: summary.evictionCounterExpectedAttempts,
		evictionCounterReportingAttempts: summary.evictionCounterReportingAttempts,
		observedEvictedCount: summary.observedEvictedCount,
		observedEvictedChars: summary.observedEvictedChars,
		evictionAttempts: summary.evictionAttempts,
		warningAttempts: summary.warningAttempts,
		forcedEvictionAttempts: summary.forcedEvictionAttempts,
		contextRecoveryAttempts: summary.contextRecoveryAttempts,
		contextRecoveredAttempts: summary.contextRecoveredAttempts,
		contextOverflowRecoveredAttempts:
			summary.contextOverflowRecoveredAttempts,
		contextLengthExceededAttempts: summary.contextLengthExceededAttempts,
		maxToolResults: summary.maxToolResults ?? null,
		maxRetainedChars: summary.maxRetainedChars ?? null,
		maxEvictableCount: summary.maxEvictableCount ?? null,
		maxUtilization: summary.maxUtilization ?? null,
		utilizationSamples,
		configuredCapValues: sortedUnique(
			attempts.flatMap((attempt) => {
				const value = positive(attempt.configuredMaxTotalChars);
				return value === undefined ? [] : [value];
			}),
		),
		backendCapValues: sortedUnique(
			attempts.flatMap((attempt) => {
				const value = positive(attempt.maxTotalChars);
				return value === undefined ? [] : [value];
			}),
		),
		incomplete,
	};
}

export function buildDynamicToolResultBudgetMetrics(
	run: WorkflowRunRecord,
): DynamicToolResultBudgetRunMetrics {
	const dynamicTasks = run.tasks.filter(
		(task) => task.dynamicGenerated !== undefined,
	);
	const byTask = dynamicTasks.map((task) => ({
		...buildRollup([task]),
		taskId: task.taskId,
		specId: task.specId,
		controllerSpecId: task.dynamicGenerated!.controllerSpecId,
		status: task.status,
	}));
	const controllerIds = sortedUniqueStrings(
		dynamicTasks.map((task) => task.dynamicGenerated!.controllerSpecId),
	);
	const byController = controllerIds.map((controllerSpecId) => ({
		...buildRollup(
			dynamicTasks.filter(
				(task) => task.dynamicGenerated!.controllerSpecId === controllerSpecId,
			),
		),
		controllerSpecId,
	}));
	const classes = new Map(
		dynamicTasks.map((task) => [task.taskId, taskTelemetryClass(task)]),
	);
	const idsFor = (value: TaskTelemetryClass) =>
		dynamicTasks
			.filter((task) => classes.get(task.taskId) === value)
			.map((task) => task.taskId);
	const fullyReportingTaskIds = idsFor("fully-reporting");
	const partiallyReportingTaskIds = idsFor("partially-reporting");
	const totals = buildRollup(dynamicTasks);
	return {
		schemaVersion: DYNAMIC_TOOL_RESULT_BUDGET_METRICS_SCHEMA_VERSION,
		run: {
			runId: run.runId,
			...(run.name === undefined ? {} : { name: run.name }),
			status: run.status,
			createdAt: run.createdAt,
			updatedAt: run.updatedAt,
		},
		totals,
		byController,
		byTask,
		metadata: {
			dynamicTaskIds: dynamicTasks.map((task) => task.taskId),
			reportingTaskIds: [
				...fullyReportingTaskIds,
				...partiallyReportingTaskIds,
			],
			fullyReportingTaskIds,
			partiallyReportingTaskIds,
			unavailableTaskIds: idsFor("unavailable"),
			disabledTaskIds: idsFor("disabled"),
			pendingTelemetryTaskIds: idsFor("pending"),
			incomplete: totals.incomplete,
		},
	};
}

function taskAttempts(
	task: WorkflowTaskRunRecord,
): WorkflowTaskToolResultBudgetAttemptRecord[] {
	const attempts = task.toolResultBudget?.attempts;
	return Array.isArray(attempts) ? attempts : [];
}

function taskTelemetryClass(task: WorkflowTaskRunRecord): TaskTelemetryClass {
	if (!TERMINAL_TASK_STATUSES.has(task.status)) return "pending";
	const attempts = taskAttempts(task);
	const eligible = attempts.filter((attempt) => attempt.configured !== false);
	const reporting = eligible.filter((attempt) => attempt.reported === true);
	const missing = eligible.some(
		(attempt) =>
			attempt.terminal !== true ||
			attempt.unavailable === true ||
			attempt.reported !== true ||
			(attempt.enabled !== false &&
				(finiteNonNegative(attempt.evictedCount) === undefined ||
					finiteNonNegative(attempt.evictedChars) === undefined)),
	);
	if (reporting.length > 0) {
		return missing ? "partially-reporting" : "fully-reporting";
	}
	if (
		attempts.length > 0 &&
		attempts.every((attempt) => attempt.configured === false)
	) {
		return "disabled";
	}
	return "unavailable";
}

function emptyStatusCounts(): DynamicToolResultBudgetStatusCounts {
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

function consistentValue(values: number[]): number | null | undefined {
	if (values.length === 0) return undefined;
	const first = values[0];
	return values.every((value) => value === first) ? first : null;
}

function optionalMaximum<Key extends string>(
	key: Key,
	values: Array<number | undefined>,
): Partial<Record<Key, number>> {
	const present = values.filter((value): value is number => value !== undefined);
	return present.length === 0
		? {}
		: ({ [key]: Math.max(...present) } as Partial<Record<Key, number>>);
}

function sortedUnique(values: number[]): number[] {
	return [...new Set(values)].sort((left, right) => left - right);
}

function sortedUniqueStrings(values: string[]): string[] {
	return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function count(values: TaskTelemetryClass[], value: TaskTelemetryClass): number {
	return values.filter((candidate) => candidate === value).length;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
