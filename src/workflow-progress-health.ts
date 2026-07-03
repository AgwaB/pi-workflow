import type {
	TaskRunStatus,
	WorkflowRunRecord,
	WorkflowRunStatus,
	WorkflowTaskRunRecord,
} from "./types.js";

export type WorkflowHealthState =
	| "completed"
	| "pending"
	| "active"
	| "long-tail"
	| "stalled"
	| "likely-stuck"
	| "needs-action";

export type WorkflowHealthTone =
	| "success"
	| "accent"
	| "warning"
	| "error"
	| "dim";
export type WorkflowDurationClass = "short" | "medium" | "long";
export type WorkflowHealthSuggestion = "wait" | "inspect" | "resume" | "review";

export interface WorkflowHealthTaskSummary {
	taskId?: string;
	displayName?: string;
	stageId?: string;
	status?: TaskRunStatus;
	elapsedMs?: number;
}

export interface WorkflowProgressHealth {
	state: WorkflowHealthState;
	label: string;
	summary: string;
	tone: WorkflowHealthTone;
	suggestion: WorkflowHealthSuggestion;
	reason: string;
	durationClass?: WorkflowDurationClass;
	currentTask?: WorkflowHealthTaskSummary;
	lastActivityAt?: string;
	lastActivityAgeMs?: number;
	heartbeatAt?: string;
	heartbeatAgeMs?: number;
}

type TaskHealthInput = Pick<
	WorkflowTaskRunRecord,
	| "taskId"
	| "specId"
	| "displayName"
	| "status"
	| "statusDetail"
	| "stageId"
	| "kind"
	| "startedAt"
	| "lastMessage"
	| "runtime"
	| "backendHandle"
	| "pid"
>;

type RunHealthInput = Pick<
	WorkflowRunRecord,
	"status" | "taskSummary" | "createdAt" | "updatedAt"
> & {
	tasks?: TaskHealthInput[];
};

type RunningTaskContext = {
	task: TaskHealthInput;
	nowMs: number;
	durationClass: WorkflowDurationClass;
	elapsedMs?: number;
	activityAt?: string;
	lastActivityAgeMs?: number;
	heartbeatAt?: string;
	heartbeatAgeMs?: number;
	hasBackendSignal: boolean;
	staleMs: number;
};

export interface WorkflowHealthOptions {
	nowMs?: number;
}

const ACTIVE_ACTIVITY_MS = 2 * 60_000;
const LONG_TAIL_ELAPSED_MS = 8 * 60_000;
const STALL_BY_DURATION: Record<WorkflowDurationClass, number> = {
	short: 5 * 60_000,
	medium: 10 * 60_000,
	long: 20 * 60_000,
};
const STUCK_BY_DURATION: Record<WorkflowDurationClass, number> = {
	short: 15 * 60_000,
	medium: 30 * 60_000,
	long: 60 * 60_000,
};

export function diagnoseWorkflowRunHealth(
	run: RunHealthInput,
	options: WorkflowHealthOptions = {},
): WorkflowProgressHealth {
	const nowMs = options.nowMs ?? Date.now();
	const problem = (run.tasks ?? []).find((task) =>
		isProblemStatus(task.status),
	);
	if (problem) return problemRunHealth(problem, nowMs);
	if (isProblemStatus(run.status)) return problemWorkflowHealth(run.status);
	if (run.status === "completed") return completedWorkflowHealth();

	const runningTask = currentRunningTask(run.tasks ?? []);
	if (runningTask)
		return diagnoseWorkflowTaskHealth(runningTask, run, { nowMs });
	return waitingWorkflowHealth(run, nowMs);
}

export function diagnoseWorkflowTaskHealth(
	task: TaskHealthInput,
	run?: Pick<WorkflowRunRecord, "updatedAt">,
	options: WorkflowHealthOptions = {},
): WorkflowProgressHealth {
	const nowMs = options.nowMs ?? Date.now();
	if (task.status !== "running") return terminalTaskHealth(task, nowMs);
	return runningTaskHealth(runningContext(task, run, nowMs));
}

export function classifyWorkflowTaskDuration(
	task: Pick<
		WorkflowTaskRunRecord,
		"stageId" | "displayName" | "specId" | "kind" | "statusDetail" | "runtime"
	>,
): WorkflowDurationClass {
	const text = [
		task.stageId,
		task.displayName,
		task.specId,
		task.kind,
		task.statusDetail,
	]
		.filter(Boolean)
		.join(" ")
		.toLowerCase();
	const maxRuntimeMs = task.runtime?.maxRuntimeMs;
	if (maxRuntimeMs !== undefined && Number.isFinite(maxRuntimeMs)) {
		if (maxRuntimeMs <= 5 * 60_000) return "short";
		if (maxRuntimeMs >= 60 * 60_000) return "long";
	}
	if (task.kind === "support") return "short";
	if (
		/\b(research|audit|synthesi[sz]e?r?|review(?:er|ers|ing|s)?|verif(?:y|ier|iers|ication)|normaliz(?:e|er|ing|ation)?|plan(?:ning)?|impact|spec)\b/.test(
			text,
		)
	)
		return "long";
	if (/\b(render|helper|support|schema|partition|gate)\b/.test(text))
		return "short";
	return "medium";
}

function currentRunningTask(
	tasks: TaskHealthInput[],
): TaskHealthInput | undefined {
	return tasks
		.filter((task) => task.status === "running")
		.sort(
			(left, right) =>
				(parseTime(left.startedAt) ?? Number.POSITIVE_INFINITY) -
				(parseTime(right.startedAt) ?? Number.POSITIVE_INFINITY),
		)[0];
}

function completedWorkflowHealth(): WorkflowProgressHealth {
	return {
		state: "completed",
		label: "completed",
		summary: "run completed",
		tone: "success",
		suggestion: "review",
		reason: "all tasks reached a terminal successful state",
	};
}

function problemWorkflowHealth(
	status: WorkflowRunStatus,
): WorkflowProgressHealth {
	return {
		state: "needs-action",
		label: "needs action",
		summary: `run ${status}`,
		tone: "error",
		suggestion: "inspect",
		reason: `workflow status is ${status}`,
	};
}

function problemRunHealth(
	task: TaskHealthInput,
	nowMs: number,
): WorkflowProgressHealth {
	return {
		state: "needs-action",
		label: "needs action",
		summary: `${task.displayName ?? task.taskId ?? "task"} needs attention`,
		tone: "error",
		suggestion: "inspect",
		reason: task.lastMessage ?? task.statusDetail ?? "task did not complete",
		currentTask: taskSummary(task, nowMs),
	};
}

function waitingWorkflowHealth(
	run: RunHealthInput,
	nowMs: number,
): WorkflowProgressHealth {
	const hasPending = run.taskSummary.pending > 0;
	const lastActivityAgeMs = ageMs(run.updatedAt, nowMs);
	if (hasPending && lastActivityAgeMs !== undefined) {
		if (lastActivityAgeMs >= STUCK_BY_DURATION.medium) {
			return {
				state: "likely-stuck",
				label: "scheduler stuck",
				summary: "pending tasks have not scheduled",
				tone: "error",
				suggestion: "resume",
				reason: "no task is running and run activity is stale",
				lastActivityAt: run.updatedAt,
				lastActivityAgeMs,
			};
		}
		if (lastActivityAgeMs >= STALL_BY_DURATION.medium) {
			return {
				state: "stalled",
				label: "scheduler quiet",
				summary: "pending tasks are waiting without recent activity",
				tone: "warning",
				suggestion: "inspect",
				reason: "no task is running and run activity is stale",
				lastActivityAt: run.updatedAt,
				lastActivityAgeMs,
			};
		}
	}
	return {
		state: hasPending ? "pending" : "active",
		label: hasPending ? "pending" : "active",
		summary: hasPending
			? "waiting for the next schedulable task"
			: "run is active",
		tone: hasPending ? "dim" : "accent",
		suggestion: "wait",
		reason: hasPending
			? "no task is currently running"
			: "workflow is still in progress",
		lastActivityAt: run.updatedAt,
		lastActivityAgeMs,
	};
}

function runningTaskHealth(
	context: RunningTaskContext,
): WorkflowProgressHealth {
	return (
		runtimeExceededHealth(context) ??
		staleRunningHealth(context) ??
		longTailHealth(context) ??
		activeRunningHealth(context)
	);
}

function runtimeExceededHealth(
	context: RunningTaskContext,
): WorkflowProgressHealth | undefined {
	const maxRuntimeMs = context.task.runtime?.maxRuntimeMs;
	const hasElapsed = context.elapsedMs !== undefined;
	const hasBudget = maxRuntimeMs !== undefined && Number.isFinite(maxRuntimeMs);
	if (!hasElapsed || !hasBudget) return undefined;
	if (maxRuntimeMs <= 0 || context.elapsedMs! <= maxRuntimeMs) return undefined;
	return runningHealth(context, {
		state: "likely-stuck",
		label: "runtime exceeded",
		summary: "task exceeded its runtime budget",
		tone: "error",
		suggestion: "resume",
		reason: "elapsed time is past runtime.maxRuntimeMs",
	});
}

function staleRunningHealth(
	context: RunningTaskContext,
): WorkflowProgressHealth | undefined {
	if (
		context.staleMs >= STUCK_BY_DURATION[context.durationClass] &&
		!context.hasBackendSignal
	) {
		return runningHealth(context, {
			state: "likely-stuck",
			label: "likely stuck",
			summary: "no fresh backend or activity signal",
			tone: "error",
			suggestion: "resume",
			reason: "running task has no backend signal and activity is stale",
		});
	}
	if (context.staleMs < STALL_BY_DURATION[context.durationClass])
		return undefined;
	return runningHealth(context, {
		state: "stalled",
		label: "possibly stalled",
		summary: "no recent visible progress",
		tone: "warning",
		suggestion: "inspect",
		reason: context.hasBackendSignal
			? "backend signal exists, but activity is stale"
			: "activity is stale",
	});
}

function longTailHealth(
	context: RunningTaskContext,
): WorkflowProgressHealth | undefined {
	const isLongTail =
		context.durationClass === "long" &&
		context.elapsedMs !== undefined &&
		context.elapsedMs >= LONG_TAIL_ELAPSED_MS;
	if (!isLongTail) return undefined;
	return runningHealth(context, {
		state: "long-tail",
		label: "long-tail active",
		summary: "slow task with fresh liveness signals",
		tone: "accent",
		suggestion: "wait",
		reason:
			context.staleMs <= ACTIVE_ACTIVITY_MS
				? "liveness signal is fresh"
				: "long-running stage is still within the stale threshold",
	});
}

function activeRunningHealth(
	context: RunningTaskContext,
): WorkflowProgressHealth {
	return runningHealth(context, {
		state: "active",
		label: "active",
		summary: "task is running",
		tone: "accent",
		suggestion: "wait",
		reason:
			context.staleMs <= ACTIVE_ACTIVITY_MS
				? "liveness signal is fresh"
				: "activity remains within the expected window",
	});
}

function runningContext(
	task: TaskHealthInput,
	run: Pick<WorkflowRunRecord, "updatedAt"> | undefined,
	nowMs: number,
): RunningTaskContext {
	const durationClass = classifyWorkflowTaskDuration(task);
	const startedAtMs = parseTime(task.startedAt);
	const heartbeatAt = parseHeartbeatAt(task.lastMessage);
	const heartbeatAgeMs = ageMs(heartbeatAt, nowMs);
	const activityAt = latestIso([heartbeatAt, run?.updatedAt, task.startedAt]);
	const lastActivityAgeMs = ageMs(activityAt, nowMs);
	const hasFreshHeartbeat =
		heartbeatAgeMs !== undefined &&
		heartbeatAgeMs <= STALL_BY_DURATION[durationClass];
	return {
		task,
		nowMs,
		durationClass,
		elapsedMs:
			startedAtMs === undefined ? undefined : Math.max(0, nowMs - startedAtMs),
		activityAt,
		lastActivityAgeMs,
		heartbeatAt,
		heartbeatAgeMs,
		hasBackendSignal: Boolean(task.pid || hasFreshHeartbeat),
		staleMs: lastActivityAgeMs ?? Number.POSITIVE_INFINITY,
	};
}

function terminalTaskHealth(
	task: TaskHealthInput,
	nowMs: number,
): WorkflowProgressHealth {
	if (task.status === "completed" || task.status === "skipped") {
		return {
			state: "completed",
			label: task.status === "skipped" ? "skipped" : "completed",
			summary: task.status === "skipped" ? "task skipped" : "task completed",
			tone: "success",
			suggestion: "review",
			reason: task.statusDetail,
			currentTask: taskSummary(task, nowMs),
		};
	}
	if (task.status === "pending") {
		return {
			state: "pending",
			label: "pending",
			summary: "waiting for dependencies or scheduler",
			tone: "dim",
			suggestion: "wait",
			reason: task.statusDetail,
			currentTask: taskSummary(task, nowMs),
		};
	}
	return {
		state: "needs-action",
		label: "needs action",
		summary: `${task.status} task needs attention`,
		tone: "error",
		suggestion: "inspect",
		reason: task.lastMessage ?? task.statusDetail,
		currentTask: taskSummary(task, nowMs),
	};
}

function runningHealth(
	context: RunningTaskContext,
	health: Pick<
		WorkflowProgressHealth,
		"state" | "label" | "summary" | "tone" | "suggestion" | "reason"
	>,
): WorkflowProgressHealth {
	return {
		...health,
		durationClass: context.durationClass,
		currentTask: taskSummary(context.task, context.nowMs),
		lastActivityAt: context.activityAt,
		lastActivityAgeMs: context.lastActivityAgeMs,
		heartbeatAt: context.heartbeatAt,
		heartbeatAgeMs: context.heartbeatAgeMs,
	};
}

function taskSummary(
	task: TaskHealthInput,
	nowMs: number,
): WorkflowHealthTaskSummary {
	const startedAtMs = parseTime(task.startedAt);
	return {
		taskId: task.taskId,
		displayName: task.displayName,
		stageId: task.stageId,
		status: task.status,
		...(startedAtMs === undefined
			? {}
			: { elapsedMs: Math.max(0, nowMs - startedAtMs) }),
	};
}

function isProblemStatus(status: TaskRunStatus | WorkflowRunStatus): boolean {
	return (
		status === "failed" || status === "blocked" || status === "interrupted"
	);
}

function parseHeartbeatAt(message: string | undefined): string | undefined {
	if (!message) return undefined;
	const match = /heartbeat\s+(\d{4}-\d{2}-\d{2}T\S+?Z)/i.exec(message);
	if (!match) return undefined;
	const value = match[1];
	return parseTime(value) === undefined ? undefined : value;
}

function latestIso(values: Array<string | undefined>): string | undefined {
	let latest: string | undefined;
	let latestMs = Number.NEGATIVE_INFINITY;
	for (const value of values) {
		const time = parseTime(value);
		if (time === undefined || time <= latestMs) continue;
		latest = value;
		latestMs = time;
	}
	return latest;
}

function ageMs(value: string | undefined, nowMs: number): number | undefined {
	const time = parseTime(value);
	return time === undefined ? undefined : Math.max(0, nowMs - time);
}

function parseTime(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}
