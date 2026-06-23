import type { WorkflowRunRecord, WorkflowTaskRunRecord } from "./types.js";

type StatusCounts = Partial<Record<WorkflowTaskRunRecord["status"], number>>;

type OutputRepairCounts = WorkflowTelemetrySummary["outputRepairCounts"];

interface WorkflowTelemetryAccumulator {
	outputRetries: number;
	launchRetries: number;
	resumeEvents: number;
	resumedTasks: number;
	retryReasons: WorkflowTelemetrySummary["retryReasons"];
	resumeStatusCounts: StatusCounts;
	outputRepairCounts: OutputRepairCounts;
}

export interface WorkflowTelemetrySummary {
	taskCount: number;
	wallClockMs: number | null;
	statusCounts: StatusCounts;
	retryCounts: { output: number; launch: number };
	retryReasons: {
		output: Record<string, number>;
		launch: Record<string, number>;
	};
	resumeCounts: { events: number; tasks: number };
	resumeStatusCounts: StatusCounts;
	outputRepairCounts: {
		sameSession: number;
		newSession: number;
		unknown: number;
	};
	outputBytes: number;
	stages: Record<
		string,
		{
			taskCount: number;
			statusCounts: StatusCounts;
			durationMs: number;
			outputBytes: number;
		}
	>;
}

export function summarizeWorkflowTelemetry(
	run: Pick<WorkflowRunRecord, "createdAt" | "updatedAt"> & {
		tasks?: Array<Partial<WorkflowTaskRunRecord>>;
	},
	options: { outputBytesByTaskId?: Record<string, number> } = {},
): WorkflowTelemetrySummary {
	const tasks = run.tasks ?? [];
	const statusCounts: StatusCounts = {};
	const stages: WorkflowTelemetrySummary["stages"] = {};
	let outputBytes = 0;
	const accumulator = createWorkflowTelemetryAccumulator();

	for (const task of tasks) {
		const status = task.status;
		if (status) statusCounts[status] = (statusCounts[status] ?? 0) + 1;
		accumulateTaskReliability(task, accumulator);

		const outputKey = task.files?.output ?? task.taskId ?? task.specId ?? "";
		const taskOutputBytes = options.outputBytesByTaskId?.[outputKey] ?? 0;
		outputBytes += taskOutputBytes;

		const stageId = task.stageId ?? "(none)";
		const stage = (stages[stageId] ??= {
			taskCount: 0,
			statusCounts: {},
			durationMs: 0,
			outputBytes: 0,
		});
		stage.taskCount += 1;
		if (status)
			stage.statusCounts[status] = (stage.statusCounts[status] ?? 0) + 1;
		stage.durationMs += taskDurationMs(task);
		stage.outputBytes += taskOutputBytes;
	}

	return {
		taskCount: tasks.length,
		wallClockMs: durationBetween(run.createdAt, run.updatedAt),
		statusCounts,
		retryCounts: {
			output: accumulator.outputRetries,
			launch: accumulator.launchRetries,
		},
		retryReasons: accumulator.retryReasons,
		resumeCounts: {
			events: accumulator.resumeEvents,
			tasks: accumulator.resumedTasks,
		},
		resumeStatusCounts: accumulator.resumeStatusCounts,
		outputRepairCounts: accumulator.outputRepairCounts,
		outputBytes,
		stages,
	};
}

function createWorkflowTelemetryAccumulator(): WorkflowTelemetryAccumulator {
	return {
		outputRetries: 0,
		launchRetries: 0,
		resumeEvents: 0,
		resumedTasks: 0,
		retryReasons: { output: {}, launch: {} },
		resumeStatusCounts: {},
		outputRepairCounts: { sameSession: 0, newSession: 0, unknown: 0 },
	};
}

function accumulateTaskReliability(
	task: Partial<WorkflowTaskRunRecord>,
	accumulator: WorkflowTelemetryAccumulator,
): void {
	const currentOutputAttempts = positiveCount(task.outputRetry?.attempts);
	accumulator.outputRetries += currentOutputAttempts;
	if (currentOutputAttempts > 0) {
		countReason(accumulator.retryReasons.output, task.outputRetry?.reason);
		countRepairMode(
			accumulator.outputRepairCounts,
			task.outputRetry?.repairMode,
		);
	}

	const currentLaunchAttempts = positiveCount(task.launchRetry?.attempts);
	accumulator.launchRetries += currentLaunchAttempts;
	if (currentLaunchAttempts > 0)
		countReason(accumulator.retryReasons.launch, task.launchRetry?.reason);

	const resumeEvents = Array.isArray(task.resumeEvents)
		? task.resumeEvents
		: [];
	if (resumeEvents.length === 0) return;
	accumulator.resumedTasks += 1;
	accumulator.resumeEvents += resumeEvents.length;
	for (const event of resumeEvents) accumulateResumeEvent(event, accumulator);
}

function accumulateResumeEvent(
	event: NonNullable<WorkflowTaskRunRecord["resumeEvents"]>[number],
	accumulator: WorkflowTelemetryAccumulator,
): void {
	accumulator.resumeStatusCounts[event.fromStatus] =
		(accumulator.resumeStatusCounts[event.fromStatus] ?? 0) + 1;
	const previousOutputAttempts = positiveCount(event.outputRetryAttempts);
	accumulator.outputRetries += previousOutputAttempts;
	if (previousOutputAttempts === 0) return;
	countReason(accumulator.retryReasons.output, event.outputRetryReason);
	countRepairMode(accumulator.outputRepairCounts, event.outputRetryRepairMode);
}

function positiveCount(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return 0;
	return Math.max(0, Math.floor(value));
}

function countReason(
	counts: Record<string, number>,
	reason: string | undefined,
): void {
	const key = reason && reason.trim().length > 0 ? reason : "unknown";
	counts[key] = (counts[key] ?? 0) + 1;
}

function countRepairMode(
	counts: OutputRepairCounts,
	mode: "same_session" | "new_session" | undefined,
): void {
	if (mode === "same_session") counts.sameSession += 1;
	else if (mode === "new_session") counts.newSession += 1;
	else counts.unknown += 1;
}

export interface SourceContextPacket {
	tasks: SourceContextTask[];
	byStage: Record<
		string,
		{
			taskCount: number;
			statusCounts: StatusCounts;
		}
	>;
}

export interface SourceContextTask {
	taskId?: string;
	specId?: string;
	stageId: string;
	status?: WorkflowTaskRunRecord["status"];
	structuredOutput?: unknown;
	outputPreview?: string;
	projectionWarnings?: Array<{
		path: string;
		reason: "missing";
	}>;
	omittedOutput?: {
		reason: "packet_budget_exhausted";
		originalChars?: number;
	};
}

export interface SourceContextPacketOptions {
	structuredOutputsByTaskId?: Record<string, unknown>;
	rawOutputsByTaskId?: Record<string, string>;
	maxPreviewChars?: number;
	maxStructuredChars?: number;
	maxStructuredCharsByStage?: Record<string, number>;
	structuredOutputPathsByStage?: Record<string, string[]>;
	maxPacketChars?: number;
}

export function buildSourceContextPacket(
	run: { tasks?: Array<Partial<WorkflowTaskRunRecord>> },
	options: SourceContextPacketOptions = {},
): SourceContextPacket {
	const maxPreviewChars = Math.max(
		0,
		Math.floor(options.maxPreviewChars ?? 1200),
	);
	const maxStructuredChars = normalizeOptionalCharCap(
		options.maxStructuredChars,
	);
	const maxStructuredCharsByStage = Object.fromEntries(
		Object.entries(options.maxStructuredCharsByStage ?? {}).map(
			([stage, cap]) => [stage, Math.max(0, Math.floor(cap))],
		),
	);
	const maxPacketChars = normalizeOptionalCharCap(options.maxPacketChars);
	const packet: SourceContextPacket = { tasks: [], byStage: {} };
	let packetChars = 0;

	for (const task of run.tasks ?? []) {
		const taskId = task.taskId;
		const stageId = task.stageId ?? "(none)";
		const structuredOutput = taskId
			? options.structuredOutputsByTaskId?.[taskId]
			: undefined;
		const projection = projectStructuredOutput(
			structuredOutput,
			options.structuredOutputPathsByStage?.[stageId],
		);
		const rawOutput = taskId ? options.rawOutputsByTaskId?.[taskId] : undefined;
		const status = task.status;
		const stageStructuredChars =
			maxStructuredCharsByStage[stageId] ?? maxStructuredChars;
		const entry = fitSourceContextTaskToBudget(
			{
				taskId,
				specId: task.specId,
				stageId,
				status,
				structuredOutput: capStructuredOutput(
					projection.value,
					stageStructuredChars,
				),
				outputPreview:
					structuredOutput === undefined && rawOutput !== undefined
						? preview(rawOutput, maxPreviewChars)
						: undefined,
				projectionWarnings:
					projection.missingPaths.length > 0
						? projection.missingPaths.map((path) => ({
								path,
								reason: "missing",
							}))
						: undefined,
			},
			maxPacketChars,
			packetChars,
		);

		packet.tasks.push(entry);
		packetChars += JSON.stringify(entry).length;

		const stage = (packet.byStage[stageId] ??= {
			taskCount: 0,
			statusCounts: {},
		});
		stage.taskCount += 1;
		if (status)
			stage.statusCounts[status] = (stage.statusCounts[status] ?? 0) + 1;
	}

	return packet;
}

export interface StructuredContract {
	requiredPaths?: string[];
	arrays?: Array<{ path: string; minItems?: number; maxItems?: number }>;
	maxStringChars?: Array<{ path: string; maxChars: number }>;
}

export interface StructuredContractIssue {
	path: string;
	message: string;
}

export function validateStructuredContract(
	value: unknown,
	contract: StructuredContract,
): { valid: boolean; issues: StructuredContractIssue[] } {
	const issues: StructuredContractIssue[] = [];

	for (const path of contract.requiredPaths ?? []) {
		const resolved = resolvePath(value, path);
		if (
			!resolved.exists ||
			resolved.value === undefined ||
			resolved.value === null
		)
			issues.push({ path, message: "required path is missing" });
	}

	for (const rule of contract.arrays ?? []) {
		const resolved = resolvePath(value, rule.path);
		if (!resolved.exists || !Array.isArray(resolved.value)) {
			issues.push({ path: rule.path, message: "expected array" });
			continue;
		}
		if (rule.minItems !== undefined && resolved.value.length < rule.minItems) {
			issues.push({
				path: rule.path,
				message: `expected at least ${rule.minItems} items`,
			});
		}
		if (rule.maxItems !== undefined && resolved.value.length > rule.maxItems) {
			issues.push({
				path: rule.path,
				message: `expected at most ${rule.maxItems} items`,
			});
		}
	}

	for (const rule of contract.maxStringChars ?? []) {
		const resolved = resolvePath(value, rule.path);
		if (!resolved.exists) continue;
		if (typeof resolved.value !== "string") {
			issues.push({ path: rule.path, message: "expected string" });
			continue;
		}
		if (resolved.value.length > rule.maxChars) {
			issues.push({
				path: rule.path,
				message: `expected string length <= ${rule.maxChars}`,
			});
		}
	}

	return { valid: issues.length === 0, issues };
}

function taskDurationMs(task: Partial<WorkflowTaskRunRecord>): number {
	const duration = durationBetween(task.startedAt, task.completedAt);
	return duration ?? 0;
}

function durationBetween(
	start: string | undefined,
	end: string | undefined,
): number | null {
	if (!start || !end) return null;
	const startMs = Date.parse(start);
	const endMs = Date.parse(end);
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs)
		return null;
	return endMs - startMs;
}

function normalizeOptionalCharCap(
	value: number | undefined,
): number | undefined {
	return value === undefined ? undefined : Math.max(0, Math.floor(value));
}

function fitSourceContextTaskToBudget(
	entry: SourceContextTask,
	maxPacketChars: number | undefined,
	usedChars: number,
): SourceContextTask {
	if (
		maxPacketChars === undefined ||
		usedChars + JSON.stringify(entry).length <= maxPacketChars
	)
		return entry;

	const originalOutputChars = outputChars(entry);
	const metadataOnly: SourceContextTask = {
		taskId: entry.taskId,
		specId: entry.specId,
		stageId: entry.stageId,
		status: entry.status,
		projectionWarnings: entry.projectionWarnings,
		omittedOutput: {
			reason: "packet_budget_exhausted",
			originalChars: originalOutputChars,
		},
	};
	const metadataChars = JSON.stringify(metadataOnly).length;
	const remaining = maxPacketChars - usedChars - metadataChars;
	if (remaining <= 24) return metadataOnly;

	if (entry.structuredOutput !== undefined) {
		const serialized = JSON.stringify(entry.structuredOutput);
		return {
			taskId: entry.taskId,
			specId: entry.specId,
			stageId: entry.stageId,
			status: entry.status,
			structuredOutput: {
				truncated: true,
				originalChars: serialized.length,
				preview: preview(serialized, remaining),
			},
			projectionWarnings: entry.projectionWarnings,
		};
	}

	if (entry.outputPreview !== undefined) {
		return {
			taskId: entry.taskId,
			specId: entry.specId,
			stageId: entry.stageId,
			status: entry.status,
			outputPreview: preview(entry.outputPreview, remaining),
			projectionWarnings: entry.projectionWarnings,
		};
	}

	return metadataOnly;
}

function outputChars(entry: SourceContextTask): number | undefined {
	if (entry.structuredOutput !== undefined)
		return JSON.stringify(entry.structuredOutput).length;
	if (entry.outputPreview !== undefined) return entry.outputPreview.length;
	return undefined;
}

function projectStructuredOutput(
	value: unknown,
	paths: string[] | undefined,
): { value: unknown; missingPaths: string[] } {
	if (value === undefined || !paths || paths.length === 0)
		return { value, missingPaths: [] };
	const projected: Record<string, unknown> = {};
	const missingPaths: string[] = [];
	for (const path of paths) {
		const resolved = resolvePath(value, path);
		if (!resolved.exists) {
			missingPaths.push(path);
			continue;
		}
		setProjectedPath(projected, tokenizePath(path), resolved.value);
	}
	return {
		value: Object.keys(projected).length > 0 ? projected : undefined,
		missingPaths,
	};
}

function setProjectedPath(
	target: Record<string, unknown>,
	tokens: Array<string | number>,
	value: unknown,
): void {
	let current: Record<string, unknown> = target;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (typeof token === "number") return;
		if (index === tokens.length - 1) {
			current[token] = value;
			return;
		}
		const nextToken = tokens[index + 1];
		if (typeof nextToken === "number") return;
		const next = current[token];
		if (!next || typeof next !== "object" || Array.isArray(next))
			current[token] = {};
		current = current[token] as Record<string, unknown>;
	}
}

function capStructuredOutput(
	value: unknown,
	maxChars: number | undefined,
): unknown {
	if (value === undefined || maxChars === undefined) return value;
	const serialized = JSON.stringify(value);
	if (serialized.length <= maxChars) return value;
	return {
		truncated: true,
		originalChars: serialized.length,
		preview: preview(serialized, maxChars),
	};
}

function preview(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}…`;
}

function resolvePath(
	value: unknown,
	path: string,
): { exists: boolean; value?: unknown } {
	if (!path.startsWith("$")) return { exists: false };
	const tokens = tokenizePath(path);
	let current: unknown = value;
	for (const token of tokens) {
		if (typeof token === "number") {
			if (!Array.isArray(current) || token < 0 || token >= current.length)
				return { exists: false };
			current = current[token];
			continue;
		}
		if (
			!current ||
			typeof current !== "object" ||
			!Object.hasOwn(current, token)
		)
			return { exists: false };
		current = (current as Record<string, unknown>)[token];
	}
	return { exists: true, value: current };
}

function tokenizePath(path: string): Array<string | number> {
	const tokens: Array<string | number> = [];
	const pattern = /\.([A-Za-z_][A-Za-z0-9_-]*)|\[(\d+)\]/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(path)) !== null) {
		if (match[1] !== undefined) tokens.push(match[1]);
		else if (match[2] !== undefined) tokens.push(Number(match[2]));
	}
	return tokens;
}
