import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { WorkflowIndexRecord } from "./types.js";

export const WORKFLOW_ACTIVE_STATUS_KEY = "pi-workflow-active";
export const WORKFLOW_ACTIVE_WIDGET_KEY = "pi-workflow-active";
export const WORKFLOW_LAUNCH_STATUS_KEY = "pi-workflow-launch";
export const WORKFLOW_LAUNCH_WIDGET_KEY = "pi-workflow-launch";

const ACTIVE_WORKFLOW_LIMIT = 5;
const LAUNCH_FRAMES = ["◐", "◓", "◑", "◒"] as const;

type WorkflowIndexRun = WorkflowIndexRecord["runs"][number];
type WorkflowUiContext = Pick<ExtensionContext, "hasUI" | "ui">;

export function activeTopLevelWorkflowRuns(
	index: WorkflowIndexRecord | undefined,
): WorkflowIndexRun[] {
	return (index?.runs ?? [])
		.filter((run) => !run.parentRunId && run.status === "running")
		.sort((left, right) => {
			const updatedDelta =
				Date.parse(right.updatedAt ?? "") - Date.parse(left.updatedAt ?? "");
			if (Number.isFinite(updatedDelta) && updatedDelta !== 0)
				return updatedDelta;
			return right.runId.localeCompare(left.runId);
		});
}

export function formatActiveWorkflowLines(
	runs: WorkflowIndexRun[],
	nowMs = Date.now(),
): string[] {
	if (runs.length === 0) return [];
	const visible = runs.slice(0, ACTIVE_WORKFLOW_LIMIT);
	const lines = [
		"Active workflows",
		...visible.map((run) => {
			const createdAtMs = Date.parse(run.createdAt ?? "");
			const elapsed = Number.isFinite(createdAtMs)
				? ` · ${formatElapsed(nowMs - createdAtMs)}`
				: "";
			return `● ${truncateLabel(run.name ?? run.runId, 28)} ${run.taskSummary.completed}/${run.taskSummary.total} running${elapsed}`;
		}),
	];
	if (runs.length > visible.length)
		lines.push(`… and ${runs.length - visible.length} more`);
	return lines;
}

export function renderActiveWorkflowUi(
	ctx: WorkflowUiContext,
	index: WorkflowIndexRecord | undefined,
	nowMs = Date.now(),
): void {
	if (!ctx.hasUI) return;
	const runs = activeTopLevelWorkflowRuns(index);
	if (runs.length === 0) {
		clearActiveWorkflowUi(ctx);
		return;
	}
	const status =
		runs.length === 1
			? `● ${truncateLabel(runs[0].name ?? runs[0].runId, 18)} ${runs[0].taskSummary.completed}/${runs[0].taskSummary.total}`
			: `● workflows ${runs.length} active`;
	safeUiCall(() => ctx.ui.setStatus(WORKFLOW_ACTIVE_STATUS_KEY, status));
	safeUiCall(() =>
		ctx.ui.setWidget(
			WORKFLOW_ACTIVE_WIDGET_KEY,
			formatActiveWorkflowLines(runs, nowMs),
			{ placement: "belowEditor" },
		),
	);
}

export function clearActiveWorkflowUi(ctx: WorkflowUiContext): void {
	if (!ctx.hasUI) return;
	safeUiCall(() => ctx.ui.setStatus(WORKFLOW_ACTIVE_STATUS_KEY, undefined));
	safeUiCall(() =>
		ctx.ui.setWidget(WORKFLOW_ACTIVE_WIDGET_KEY, undefined, {
			placement: "belowEditor",
		}),
	);
}

export async function withWorkflowLaunchForeground<T>(
	ctx: WorkflowUiContext,
	label: string,
	operation: () => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	if (!ctx.hasUI || signal?.aborted) return operation();
	let frameIndex = 0;
	let timer: ReturnType<typeof setInterval> | undefined;
	let cleared = false;
	const clear = () => {
		if (cleared) return;
		cleared = true;
		if (timer) clearInterval(timer);
		safeUiCall(() =>
			ctx.ui.setStatus(WORKFLOW_LAUNCH_STATUS_KEY, undefined),
		);
		safeUiCall(() =>
			ctx.ui.setWidget(WORKFLOW_LAUNCH_WIDGET_KEY, undefined, {
				placement: "belowEditor",
			}),
		);
	};
	const render = () => {
		if (signal?.aborted) {
			clear();
			return;
		}
		const frame = LAUNCH_FRAMES[frameIndex % LAUNCH_FRAMES.length];
		frameIndex += 1;
		safeUiCall(() =>
			ctx.ui.setStatus(
				WORKFLOW_LAUNCH_STATUS_KEY,
				`${frame} Starting ${label}`,
			),
		);
		safeUiCall(() =>
			ctx.ui.setWidget(
				WORKFLOW_LAUNCH_WIDGET_KEY,
				["Starting workflow", `${frame} ${label} — routing, validating, and launching`],
				{ placement: "belowEditor" },
			),
		);
	};
	signal?.addEventListener("abort", clear, { once: true });
	render();
	timer = setInterval(render, 180);
	timer.unref?.();
	try {
		return await operation();
	} finally {
		signal?.removeEventListener("abort", clear);
		clear();
	}
}

function truncateLabel(value: string, maxCodePoints: number): string {
	const points = Array.from(value);
	if (points.length <= maxCodePoints) return value;
	return `${points.slice(0, Math.max(1, maxCodePoints - 1)).join("")}…`;
}

function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remainder = minutes % 60;
	return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}

function safeUiCall(call: () => void): void {
	try {
		call();
	} catch {
		// Workflow execution must not depend on optional TUI rendering.
	}
}
