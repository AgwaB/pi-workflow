// @ts-nocheck
import { readFile } from "node:fs/promises";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
	workflowRunPath,
	fromProjectPath,
	listRunRecords,
	readIndex,
	readRunRecord,
} from "./store.js";
import {
	type WorkflowIndexRecord,
	type WorkflowRunRecord,
	type WorkflowRunStatus,
	type WorkflowTaskRunRecord,
	WORKFLOW_RUN_TYPE,
	type TaskRunStatus,
	type TaskSummary,
} from "./types.js";

const REFRESH_INTERVAL_MS = 1_000;
const OUTPUT_PREVIEW_LINES = 8;
const TASK_PROMPT_PREVIEW_LINES = 12;
const MAX_LIST_ROWS = 18;
const MAX_STAGE_TASK_ROWS = 18;

type Component = {
	render(width: number): string[];
	handleInput?(data: string): void;
	invalidate(): void;
	dispose?(): void;
};

type TUI = {
	requestRender(): void;
};

type WorkflowSummary = WorkflowIndexRecord["runs"][number];
type ViewMode = "runs" | "stages" | "tasks" | "task";
type Theme = {
	fg?: (color: string, text: string) => string;
	bg?: (color: string, text: string) => string;
	bold?: (text: string) => string;
};

export async function showWorkflowView(
	ctx: ExtensionCommandContext,
	initialRunId?: string,
	workflowCwd = ctx.cwd,
): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		const view = new WorkflowView(
			workflowCwd,
			tui,
			theme as Theme,
			done,
			initialRunId,
		);
		view.start();
		return view;
	});
}

export class WorkflowView implements Component {
	private mode: ViewMode = "runs";
	private flows: WorkflowSummary[] = [];
	private selectedFlow = 0;
	private selectedStage = 0;
	private selectedTask = 0;
	private detailRun?: WorkflowRunRecord;
	private outputPreview = "";
	private taskPromptPreview = "";
	private message = "";
	private error = "";
	private loading = true;
	private reloadActive = false;
	private timer?: ReturnType<typeof setInterval>;

	constructor(
		private readonly cwd: string,
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly done: () => void,
		private readonly initialRunId?: string,
	) {}

	start(): void {
		void this.reload(true);
		this.timer = setInterval(
			() => void this.reload(false),
			REFRESH_INTERVAL_MS,
		);
		this.timer.unref?.();
	}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.isCloseInput(data)) {
			this.close();
			return;
		}

		if (data === "r" || data === "R") {
			this.message = "refreshing";
			void this.reload(true);
			this.tui.requestRender();
			return;
		}

		if (this.mode === "task") {
			this.handleTaskInput(data);
			return;
		}

		this.handleBoardInput(data);
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width || 1));
		const selectedTask = this.selectedTaskRecord();
		const lines =
			this.mode === "task" && this.detailRun && selectedTask
				? this.renderTaskDetail(safeWidth, this.detailRun, selectedTask)
				: this.renderBoard(safeWidth);
		return lines.map((line) => fit(line, safeWidth));
	}

	private handleBoardInput(data: string): void {
		if (matchesKey(data, "escape") || this.isBackInput(data)) {
			this.drillUp();
			return;
		}

		if (data === "[" || data === "p" || data === "P") {
			this.moveModeSelection(-1);
			return;
		}
		if (data === "]" || data === "n" || data === "N") {
			this.moveModeSelection(1);
			return;
		}

		if (matchesKey(data, "left") || data === "h" || data === "H") {
			this.drillUp();
			return;
		}
		if (matchesKey(data, "right") || data === "l" || data === "L") {
			this.drillDown();
			return;
		}

		if (matchesKey(data, "up") || data === "k" || data === "K") {
			this.moveModeSelection(-1);
			return;
		}
		if (matchesKey(data, "down") || data === "j" || data === "J") {
			this.moveModeSelection(1);
			return;
		}

		if (
			matchesKey(data, "enter") ||
			matchesKey(data, "return") ||
			data === "\r"
		) {
			this.drillDown();
		}
	}

	private handleTaskInput(data: string): void {
		if (matchesKey(data, "escape") || this.isBackInput(data)) {
			this.mode = "tasks";
			this.message = "";
			this.tui.requestRender();
			return;
		}

		if (data === "[" || data === "p" || data === "P") {
			this.moveTask(-1);
			return;
		}
		if (data === "]" || data === "n" || data === "N") {
			this.moveTask(1);
			return;
		}

		if (data === "l" || data === "L") {
			const task = this.selectedTaskRecord();
			this.message = task ? `log ${task.files.output}` : "no selected task";
			this.tui.requestRender();
		}
	}

	private async reload(forceDetail: boolean): Promise<void> {
		if (this.reloadActive) return;
		this.reloadActive = true;
		try {
			const flows = await loadFlowSummaries(this.cwd, this.initialRunId);
			this.flows = flows;
			this.selectedFlow = clampIndex(this.selectedFlow, flows.length);
			const initialRunId = this.initialRunId;
			if (initialRunId && this.loading) {
				const initialIndex = flows.findIndex(
					(flow) =>
						flow.runId === initialRunId || flow.runId.startsWith(initialRunId),
				);
				if (initialIndex >= 0) {
					this.selectedFlow = initialIndex;
					this.mode = "stages";
				}
			}

			if (
				(this.mode === "runs" ||
					this.mode === "stages" ||
					this.mode === "tasks" ||
					this.mode === "task" ||
					forceDetail) &&
				flows.length > 0
			) {
				const selected = flows[this.selectedFlow];
				if (selected) {
					this.detailRun = await readRunRecord(this.cwd, selected.runId);
					this.clampStageAndTask();
					await this.updateTaskPreviews();
				}
			}

			this.error = "";
			if (this.message === "refreshing") this.message = "refreshed";
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.loading = false;
			this.reloadActive = false;
			this.tui.requestRender();
		}
	}

	private async updateTaskPreviews(): Promise<void> {
		const task = this.selectedTaskRecord();
		if (!task) {
			this.outputPreview = "";
			this.taskPromptPreview = "";
			return;
		}

		const [outputPreview, taskPromptPreview] = await Promise.all([
			readFilePreview(this.cwd, task.files.output, OUTPUT_PREVIEW_LINES),
			readFilePreview(
				this.cwd,
				task.files.taskPrompt,
				TASK_PROMPT_PREVIEW_LINES,
			),
		]);
		this.outputPreview = outputPreview;
		this.taskPromptPreview = taskPromptPreview;
	}

	private renderBoard(width: number): string[] {
		const lines = [...this.renderDrilldownHeader(width)];

		if (this.loading && this.flows.length === 0) {
			lines.push(
				...boxed(this.theme, "Loading", width, [
					placeholder(this.theme, "loading workflows..."),
				]),
			);
		} else if (this.flows.length === 0) {
			lines.push(
				...boxed(this.theme, "Runs", width, [
					placeholder(this.theme, "no workflow runs found"),
				]),
			);
		} else if (this.mode === "runs") {
			lines.push(...this.renderRunsScreen(width));
		} else if (this.mode === "stages" && this.detailRun) {
			lines.push(...this.renderStagesScreen(width, this.detailRun));
		} else if (this.mode === "tasks" && this.detailRun) {
			lines.push(...this.renderTasksScreen(width, this.detailRun));
		} else if (this.detailRun) {
			lines.push(...this.renderTasksScreen(width, this.detailRun));
		}

		lines.push("", this.footer(this.footerText(width)));
		if (this.message) lines.push(messageText(this.theme, this.message));
		if (this.error) lines.push(errorText(this.theme, this.error));
		return lines;
	}

	private renderDrilldownHeader(width: number): string[] {
		const active = this.flows.filter(
			(flow) => flow.status === "running",
		).length;
		const blocked = this.flows.filter(
			(flow) => flow.status === "blocked",
		).length;
		const failed = this.flows.filter(
			(flow) => flow.status === "failed" || flow.status === "interrupted",
		).length;
		const completed = this.flows.filter(
			(flow) => flow.status === "completed",
		).length;
		const lines = [
			`${chip(this.theme, "mode", this.mode === "task" ? "detail" : this.mode, "accent")} ${chip(this.theme, "running", String(active), "accent")} ${chip(this.theme, "blocked", String(blocked), "warning")} ${chip(this.theme, "failed", String(failed), "error")} ${chip(this.theme, "done", String(completed), "success")}`,
			`${metaLabel(this.theme, "path")} ${metaValue(this.theme, this.breadcrumbText())} ${muted(this.theme, "·")} ${metaLabel(this.theme, "source")} ${pathText(this.theme, `${this.cwd}/.pi/workflows/index.json`)}`,
		];
		return [
			...boxed(this.theme, "✦ Flow Board", width, lines, "borderAccent"),
			"",
		];
	}

	private renderRunsScreen(width: number): string[] {
		const selected = this.flows[this.selectedFlow];
		const sideLines = [
			accent(this.theme, "All runs"),
			kvRow(this.theme, "total", String(this.flows.length)),
			kvRow(
				this.theme,
				"running",
				String(this.flows.filter((flow) => flow.status === "running").length),
			),
			"",
			accent(this.theme, "Selected"),
			...(selected
				? this.runSummaryLines(selected)
				: [placeholder(this.theme, "none")]),
		];
		return this.renderTwoPane(
			width,
			"Filters / Summary",
			sideLines,
			"Runs",
			this.runLines(Math.max(1, this.mainPaneBodyWidth(width))),
			32,
		);
	}

	private renderStagesScreen(width: number, run: WorkflowRunRecord): string[] {
		const sideLines = [
			...this.runDetailSummaryLines(run),
			"",
			accent(this.theme, "Navigation"),
			navHint(this.theme, "Enter/right: tasks"),
			navHint(this.theme, "b/Esc/left: runs"),
		];
		return this.renderTwoPane(
			width,
			"Run Summary",
			sideLines,
			"Stages",
			this.stageLines(run, Math.max(1, this.mainPaneBodyWidth(width))),
			34,
		);
	}

	private renderTasksScreen(width: number, run: WorkflowRunRecord): string[] {
		const stage = this.currentStageSummary(run);
		const task = this.selectedTaskRecord();
		const sideLines = [
			accent(this.theme, stage ? stage.id : "Stage"),
			...(stage
				? [
						progressBar(this.theme, stage.summary, 10),
						kvRow(
							this.theme,
							"completed",
							`${stage.summary.completed}/${stage.summary.total}`,
						),
					]
				: [placeholder(this.theme, "no selected stage")]),
			"",
			...this.stageContextLines(run),
			"",
			accent(this.theme, "Navigation"),
			navHint(this.theme, "Enter/right: detail"),
			navHint(this.theme, "b/Esc/left: stages"),
		];
		const lines = this.renderTwoPane(
			width,
			"Stage Summary",
			sideLines,
			`${this.currentStageId(run) ?? "Stage"} tasks`,
			this.taskLines(run, Math.max(1, this.mainPaneBodyWidth(width))),
			34,
		);
		if (task)
			lines.push(
				"",
				...boxed(
					this.theme,
					"Selected Task Preview",
					width,
					this.taskPreviewLines(task, width - 4),
					statusColor(task.status),
				),
			);
		return lines;
	}

	private renderTwoPane(
		width: number,
		leftTitle: string,
		leftLines: string[],
		rightTitle: string,
		rightLines: string[],
		preferredLeftWidth: number,
	): string[] {
		if (width < 92) {
			return [
				...boxed(this.theme, leftTitle, width, leftLines),
				"",
				...boxed(this.theme, rightTitle, width, rightLines, "borderAccent"),
			];
		}

		const leftWidth = Math.min(
			Math.max(28, preferredLeftWidth),
			Math.max(28, Math.floor(width * 0.32)),
		);
		const rightWidth = Math.max(40, width - leftWidth - 1);
		const left = boxed(this.theme, leftTitle, leftWidth, leftLines);
		const right = boxed(
			this.theme,
			rightTitle,
			rightWidth,
			rightLines,
			"borderAccent",
		);
		const maxRows = Math.max(left.length, right.length);
		const rendered: string[] = [];
		for (let index = 0; index < maxRows; index += 1) {
			rendered.push(
				joinFixedColumns(
					[left[index] ?? "", right[index] ?? ""],
					[leftWidth, rightWidth],
				),
			);
		}
		return rendered;
	}

	private mainPaneBodyWidth(width: number): number {
		if (width < 92) return width - 4;
		const leftWidth = Math.min(34, Math.max(28, Math.floor(width * 0.32)));
		return width - leftWidth - 5;
	}

	private renderTaskDetail(
		width: number,
		run: WorkflowRunRecord,
		task: WorkflowTaskRunRecord,
	): string[] {
		const lines = [
			...boxed(
				this.theme,
				"Task Detail",
				width,
				[
					`${statusGlyph(this.theme, task.status)} ${strong(this.theme, task.displayName)} ${statusBadge(this.theme, task.status)} ${muted(this.theme, this.breadcrumbText())}`,
					taskMetaLine(this.theme, [
						["agent", task.agent],
						["stage", task.stageId ?? "(none)"],
						["runtime", taskRuntimeSummary(task)],
						["elapsed", taskElapsed(task)],
					]),
				],
				statusColor(task.status),
			),
			"",
		];

		if (width >= 170) {
			const overviewWidth = 36;
			const timelineWidth = 38;
			const activityWidth = Math.min(
				82,
				Math.max(62, Math.floor(width * 0.36)),
			);
			const artifactWidth = Math.max(
				44,
				width - overviewWidth - timelineWidth - activityWidth - 3,
			);
			const widths = [
				overviewWidth,
				timelineWidth,
				activityWidth,
				artifactWidth,
			];
			const overview = boxed(
				this.theme,
				"Task / Runtime",
				overviewWidth,
				this.taskOverviewLines(run, task, overviewWidth - 4),
				statusColor(task.status),
			);
			const timeline = boxed(
				this.theme,
				"Timeline",
				timelineWidth,
				this.taskTimelineLines(run, task, timelineWidth - 4),
			);
			const activity = boxed(
				this.theme,
				"Contract / Output",
				activityWidth,
				this.taskActivityLines(task, activityWidth - 4),
				"borderAccent",
			);
			const artifacts = boxed(
				this.theme,
				"Artifacts / Commands",
				artifactWidth,
				this.taskArtifactLines(run, task, artifactWidth - 4),
			);
			const maxRows = Math.max(
				overview.length,
				timeline.length,
				activity.length,
				artifacts.length,
			);
			for (let index = 0; index < maxRows; index += 1) {
				lines.push(
					joinFixedColumns(
						[
							overview[index] ?? "",
							timeline[index] ?? "",
							activity[index] ?? "",
							artifacts[index] ?? "",
						],
						widths,
					),
				);
			}
		} else if (width >= 118) {
			const leftWidth = 42;
			const mainWidth = Math.max(60, width - leftWidth - 1);
			const widths = [leftWidth, mainWidth];
			const left = boxed(
				this.theme,
				"Task / Runtime",
				leftWidth,
				this.taskOverviewLines(run, task, leftWidth - 4),
				statusColor(task.status),
			);
			const main = boxed(
				this.theme,
				"Activity",
				mainWidth,
				this.taskActivityLines(task, mainWidth - 4),
				"borderAccent",
			);
			const maxRows = Math.max(left.length, main.length);
			for (let index = 0; index < maxRows; index += 1) {
				lines.push(
					joinFixedColumns([left[index] ?? "", main[index] ?? ""], widths),
				);
			}
			lines.push(
				"",
				...boxed(this.theme, "Timeline / Artifacts", width, [
					...this.taskTimelineLines(run, task, width - 4),
					"",
					...this.taskArtifactLines(run, task, width - 4),
				]),
			);
		} else {
			lines.push(
				...boxed(
					this.theme,
					"Agent / Timeline",
					width,
					this.taskIdentityLines(run, task, width - 4),
				),
				"",
				...boxed(
					this.theme,
					"Activity",
					width,
					this.taskActivityLines(task, width - 4),
					"borderAccent",
				),
				"",
				...boxed(
					this.theme,
					"Artifacts / Commands",
					width,
					this.taskArtifactLines(run, task, width - 4),
				),
			);
		}

		lines.push("", this.footer(this.footerText(width)));
		if (this.message) lines.push(messageText(this.theme, this.message));
		if (this.error) lines.push(errorText(this.theme, this.error));
		return lines;
	}

	private runLines(width: number): string[] {
		const window = visibleWindow(this.flows, this.selectedFlow, MAX_LIST_ROWS);
		const lines: string[] = [];
		if (window.hiddenBefore > 0)
			lines.push(
				scrollIndicator(this.theme, `  ${window.hiddenBefore} more runs above`),
			);
		for (const { item: flow, index } of window.rows) {
			const selected = index === this.selectedFlow;
			const prefix = selected ? accent(this.theme, "› ") : "  ";
			const marker = statusGlyph(this.theme, flow.status);
			const name = flow.name ?? flow.type;
			const left = `${prefix}${marker} ${selected ? strong(this.theme, name) : name}`;
			const right = `${statusBadge(this.theme, flow.status, runStatusLabel(flow))} ${progressBar(this.theme, flow.taskSummary, 6)} ${metaValue(this.theme, shortId(flow.runId))} ${muted(this.theme, "·")} ${metaLabel(this.theme, "started")} ${metaValue(this.theme, timestampText(flow.createdAt))} ${muted(this.theme, "·")} ${metaValue(this.theme, elapsedText(flow.createdAt, flow.updatedAt, flow.status === "running"))}`;
			const line = joinColumns(
				left,
				right,
				width,
				Math.max(18, Math.floor(width * 0.48)),
			);
			lines.push(selectedLine(this.theme, line, width, selected, true));
		}
		if (window.hiddenAfter > 0)
			lines.push(
				scrollIndicator(this.theme, `  ${window.hiddenAfter} more runs below`),
			);
		return lines;
	}

	private stageLines(run: WorkflowRunRecord, width: number): string[] {
		const stages = stageSummaries(run);
		const currentStage = this.currentStageId(run);
		return stages.map((stage) => {
			const selected = stage.id === currentStage;
			const status = statusForSummary(stage.summary);
			const prefix = selected ? accent(this.theme, "› ") : "  ";
			const label = `${prefix}${statusGlyph(this.theme, status)} ${selected ? strong(this.theme, stage.id) : stage.id}`;
			const right = `${statusBadge(this.theme, status)} ${progressBar(this.theme, stage.summary, 8)}`;
			const line = joinColumns(
				label,
				right,
				width,
				Math.max(16, Math.floor(width * 0.52)),
			);
			return selectedLine(this.theme, line, width, selected, true);
		});
	}

	private taskLines(run: WorkflowRunRecord, width: number): string[] {
		const allTasks = this.tasksForSelectedStage(run);
		const window = visibleWindow(
			allTasks,
			this.selectedTask,
			MAX_STAGE_TASK_ROWS,
		);
		const lines: string[] = [];
		if (window.hiddenBefore > 0)
			lines.push(
				scrollIndicator(
					this.theme,
					`  ${window.hiddenBefore} more tasks above`,
				),
			);
		for (const { item: task, index } of window.rows) {
			const selected = index === this.selectedTask;
			const prefix = selected ? accent(this.theme, "› ") : "  ";
			const left = `${prefix}${statusGlyph(this.theme, task.status)} ${selected ? strong(this.theme, task.displayName) : task.displayName}`;
			const right = `${taskMetaLine(this.theme, [
				["agent", task.agent],
				["rt", taskRuntimeSummary(task)],
				["elapsed", taskElapsed(task)],
			])} ${statusBadge(this.theme, task.status)}${task.lastMessage ? ` ${muted(this.theme, "·")} ${metaValue(this.theme, task.lastMessage)}` : ""}`;
			const line = joinColumns(
				left,
				metaByStatus(this.theme, task.status, right),
				width,
				Math.max(22, Math.floor(width * 0.45)),
			);
			lines.push(selectedLine(this.theme, line, width, selected, true));
		}
		if (window.hiddenAfter > 0)
			lines.push(
				scrollIndicator(this.theme, `  ${window.hiddenAfter} more tasks below`),
			);
		return lines.length > 0
			? lines
			: [placeholder(this.theme, "  no tasks in selected stage")];
	}

	private taskPreviewLines(
		task: WorkflowTaskRunRecord,
		width: number,
	): string[] {
		const preview = previewLines(this.outputPreview, "(empty log)", 3).map(
			(line) => fit(previewText(this.theme, line), width),
		);
		const lines = [
			`${statusGlyph(this.theme, task.status)} ${strong(this.theme, task.displayName)} ${statusBadge(this.theme, task.status)} ${taskMetaLine(
				this.theme,
				[
					["agent", task.agent],
					["rt", taskRuntimeSummary(task)],
				],
			)}`,
			taskMetaLine(this.theme, [
				[
					"elapsed",
					`${taskElapsed(task)}${task.lastMessage ? ` · ${task.lastMessage}` : ""}`,
				],
			]),
			pathRow(this.theme, "output", task.files.output),
			"",
			accent(this.theme, "Live output"),
			...preview,
		];
		return lines.map((line) => fit(line, width));
	}

	private taskIdentityLines(
		run: WorkflowRunRecord,
		task: WorkflowTaskRunRecord,
		width: number,
	): string[] {
		return [
			...this.taskOverviewLines(run, task, width),
			"",
			...this.taskTimelineLines(run, task, width),
		];
	}

	private taskOverviewLines(
		run: WorkflowRunRecord,
		task: WorkflowTaskRunRecord,
		width: number,
	): string[] {
		const lines = [
			`${statusGlyph(this.theme, task.status)} ${strong(this.theme, task.displayName)}`,
			kvRow(this.theme, "run", run.runId),
			kvRow(this.theme, "stage", task.stageId ?? "(none)"),
			kvRow(this.theme, "task", task.taskId),
			"",
			accent(this.theme, "Runtime"),
			kvRow(this.theme, "agent", task.agent, "syntaxType"),
			kvRow(this.theme, "model", task.runtime.model ?? "(not recorded)"),
			kvRow(this.theme, "thinking", task.runtime.thinking ?? "(not recorded)"),
			kvRow(this.theme, "tools", (task.tools ?? []).join(",") || "(default)"),
		];
		return lines.map((line) => fit(line, width));
	}

	private taskTimelineLines(
		run: WorkflowRunRecord,
		task: WorkflowTaskRunRecord,
		width: number,
	): string[] {
		const lines = [timelineLine(this.theme, "created", run.createdAt, "dim")];
		if (task.startedAt)
			lines.push(timelineLine(this.theme, "started", task.startedAt, "accent"));
		if (task.completedAt)
			lines.push(
				timelineLine(
					this.theme,
					"completed",
					task.completedAt,
					statusColor(task.status),
				),
			);
		lines.push(
			timelineLine(
				this.theme,
				"elapsed",
				taskElapsed(task),
				statusColor(task.status),
			),
		);
		if (task.lastMessage)
			lines.push(timelineLine(this.theme, "last", task.lastMessage, "warning"));
		if (task.outputValidation)
			lines.push(
				timelineLine(
					this.theme,
					"contract",
					task.outputValidation.status,
					task.outputValidation.status === "valid"
						? "success"
						: task.outputValidation.status === "invalid"
							? "error"
							: "warning",
				),
			);
		return lines.map((line) => fit(line, width));
	}

	private taskActivityLines(
		task: WorkflowTaskRunRecord,
		width: number,
	): string[] {
		const lines = [
			accent(this.theme, "Task contract"),
			...previewLines(
				this.taskPromptPreview,
				"(task prompt unavailable)",
				TASK_PROMPT_PREVIEW_LINES,
			).map((line) => fit(previewText(this.theme, line), width)),
			"",
			accent(this.theme, "Live output preview"),
			...previewLines(
				this.outputPreview,
				"(empty log)",
				OUTPUT_PREVIEW_LINES,
			).map((line) => fit(previewText(this.theme, line), width)),
		];
		if (task.outputValidation) {
			lines.push(
				"",
				accent(this.theme, "Output contract"),
				validationLine(
					this.theme,
					task.outputValidation.status,
					task.outputValidation.message ?? "",
				),
			);
		}
		return lines;
	}

	private taskArtifactLines(
		run: WorkflowRunRecord,
		task: WorkflowTaskRunRecord,
		width: number,
	): string[] {
		const lines = [
			accent(this.theme, "Files"),
			pathRow(this.theme, "output", task.files.output),
			pathRow(this.theme, "result", task.files.result),
			pathRow(this.theme, "prompt", task.files.taskPrompt),
			pathRow(this.theme, "system", task.files.systemPrompt),
			"",
			accent(this.theme, "Agent-only controls"),
			commandLine(this.theme, `/workflow logs ${run.runId} ${task.taskId}`),
			commandLine(this.theme, `/workflow wait ${run.runId} 60000`),
		];
		if (task.backendHandle?.display)
			lines.push(
				"",
				accent(this.theme, "Backend"),
				metaValue(this.theme, task.backendHandle.display),
			);
		return lines.map((line) => fit(line, width));
	}

	private moveModeSelection(delta: number): void {
		if (this.mode === "runs") {
			this.moveRun(delta);
			return;
		}
		if (this.mode === "stages") {
			this.moveStage(delta);
			return;
		}
		if (this.mode === "tasks") this.moveTask(delta);
	}

	private drillUp(): void {
		if (this.mode === "task") {
			this.mode = "tasks";
			this.message = "";
			this.tui.requestRender();
			return;
		}
		if (this.mode === "tasks") {
			this.mode = "stages";
			this.message = "";
			this.tui.requestRender();
			return;
		}
		if (this.mode === "stages") {
			this.mode = "runs";
			this.message = "";
			this.tui.requestRender();
			return;
		}
		this.close();
	}

	private drillDown(): void {
		if (this.mode === "runs") {
			if (this.flows.length === 0) return;
			this.mode = "stages";
			this.message = "";
			void this.reload(true);
			this.tui.requestRender();
			return;
		}
		if (this.mode === "stages") {
			if (!this.detailRun) return;
			this.mode = "tasks";
			this.message = "";
			void this.updateTaskPreviews();
			this.tui.requestRender();
			return;
		}
		if (this.mode === "tasks") {
			if (!this.selectedTaskRecord()) return;
			this.mode = "task";
			this.message = "";
			void this.updateTaskPreviews();
			this.tui.requestRender();
		}
	}

	private moveRun(delta: number): void {
		if (this.flows.length <= 0) return;
		this.selectedFlow = wrapIndex(this.selectedFlow + delta, this.flows.length);
		this.selectedStage = 0;
		this.selectedTask = 0;
		this.message = "";
		void this.reload(true);
		this.tui.requestRender();
	}

	private moveStage(delta: number): void {
		if (!this.detailRun) return;
		const stages = stageSummaries(this.detailRun);
		this.selectedStage = wrapIndex(this.selectedStage + delta, stages.length);
		this.selectedTask = 0;
		this.message = "";
		void this.updateTaskPreviews();
		this.tui.requestRender();
	}

	private moveTask(delta: number): void {
		if (!this.detailRun) return;
		const tasks = this.tasksForSelectedStage(this.detailRun);
		this.selectedTask = wrapIndex(this.selectedTask + delta, tasks.length);
		this.message = "";
		void this.updateTaskPreviews();
		this.tui.requestRender();
	}

	private clampStageAndTask(): void {
		if (!this.detailRun) return;
		const stages = stageSummaries(this.detailRun);
		this.selectedStage = clampIndex(this.selectedStage, stages.length);
		const tasks = this.tasksForSelectedStage(this.detailRun);
		this.selectedTask = clampIndex(this.selectedTask, tasks.length);
	}

	private currentStageId(run: WorkflowRunRecord): string | undefined {
		const stages = stageSummaries(run);
		return stages[this.selectedStage]?.id;
	}

	private tasksForSelectedStage(
		run: WorkflowRunRecord,
	): WorkflowTaskRunRecord[] {
		const stageId = this.currentStageId(run);
		if (!stageId) return run.tasks;
		if (run.type !== WORKFLOW_RUN_TYPE) return run.tasks;
		return run.tasks.filter((task) => (task.stageId ?? "unknown") === stageId);
	}

	private selectedTaskRecord(): WorkflowTaskRunRecord | undefined {
		if (!this.detailRun) return undefined;
		return this.tasksForSelectedStage(this.detailRun)[this.selectedTask];
	}

	private currentStageSummary(
		run: WorkflowRunRecord,
	): { id: string; summary: TaskSummary } | undefined {
		return stageSummaries(run)[this.selectedStage];
	}

	private breadcrumbText(): string {
		const parts = ["workflow"];
		const flow = this.flows[this.selectedFlow];
		if (flow && this.mode !== "runs")
			parts.push(flow.name ?? shortId(flow.runId));
		const stageId = this.detailRun
			? this.currentStageId(this.detailRun)
			: undefined;
		if (stageId && (this.mode === "tasks" || this.mode === "task"))
			parts.push(stageId);
		const task = this.selectedTaskRecord();
		if (task && this.mode === "task") parts.push(task.displayName);
		return parts.join(" › ");
	}

	private runSummaryLines(flow: WorkflowSummary): string[] {
		return [
			`${statusGlyph(this.theme, flow.status)} ${strong(this.theme, flow.name ?? flow.type)} ${statusBadge(this.theme, flow.status, runStatusLabel(flow))}`,
			progressBar(this.theme, flow.taskSummary, 8),
			taskMetaLine(this.theme, [
				["run", shortId(flow.runId)],
				["started", timestampText(flow.createdAt)],
			]),
			taskMetaLine(this.theme, [
				["updated", timestampText(flow.updatedAt)],
				[
					"elapsed",
					elapsedText(
						flow.createdAt,
						flow.updatedAt,
						flow.status === "running",
					),
				],
			]),
		];
	}

	private runDetailSummaryLines(run: WorkflowRunRecord): string[] {
		const lines = [
			`${statusGlyph(this.theme, run.status)} ${strong(this.theme, run.name ?? run.type)} ${statusBadge(this.theme, run.status)}`,
			progressBar(this.theme, run.taskSummary, 10),
			taskMetaLine(this.theme, [
				["tasks", `${run.taskSummary.completed}/${run.taskSummary.total}`],
				[
					"elapsed",
					elapsedText(run.createdAt, run.updatedAt, run.status === "running"),
				],
			]),
			taskMetaLine(this.theme, [
				["started", timestampText(run.createdAt)],
				["updated", timestampText(run.updatedAt)],
			]),
			kvRow(this.theme, "run", shortId(run.runId)),
		];
		if (run.fanout && run.fanout.length > 0) {
			lines.push("", accent(this.theme, "Fanout"));
			for (const item of run.fanout.slice(0, 3)) {
				lines.push(
					taskMetaLine(this.theme, [
						[item.stageId, `expanded=${item.expandedCount}`],
						["max", String(item.maxConcurrency)],
					]),
				);
			}
		}
		return lines;
	}

	private stageContextLines(run: WorkflowRunRecord): string[] {
		const stageId = this.currentStageId(run);
		const lines = [kvRow(this.theme, "run", shortId(run.runId))];
		if (stageId) lines.push(kvRow(this.theme, "stage", stageId));
		if (run.fanout?.some((item) => item.stageId === stageId))
			lines.push(warning(this.theme, "fanout stage"));
		return lines;
	}

	private footerText(width: number): string {
		if (width < 72) {
			if (this.mode === "task")
				return "b/Esc back · l log · r refresh · q close";
			if (this.mode === "tasks")
				return "Enter detail · ←/→ nav · ↑/↓ move · q close";
			if (this.mode === "stages")
				return "Enter tasks · ←/→ nav · ↑/↓ move · q close";
			return "Enter stages · ↑/↓ move · q/Esc close";
		}
		if (this.mode === "task")
			return "b/Esc/← back to tasks · [/]/n/p sibling task · l show log path · r refresh · q close";
		if (this.mode === "tasks")
			return "Enter/→ detail · b/Esc/← stages · ↑/↓ move · [/]/n/p sibling · r refresh · q close";
		if (this.mode === "stages")
			return "Enter/→ tasks · b/Esc/← runs · ↑/↓ move · [/]/n/p sibling · r refresh · q close";
		return "Enter/→ stages · ↑/↓ move · [/]/n/p sibling · r refresh · q/Esc close";
	}

	private footer(text: string): string {
		return navHint(this.theme, text);
	}

	private isCloseInput(data: string): boolean {
		return (
			data === "q" ||
			data === "Q" ||
			matchesKey(data, "ctrl+c") ||
			matchesKey(data, "ctrl+d")
		);
	}

	private isBackInput(data: string): boolean {
		return (
			data === "b" ||
			data === "B" ||
			matchesKey(data, "left") ||
			matchesKey(data, "backspace")
		);
	}

	private close(): void {
		this.dispose();
		this.done();
	}
}

async function loadFlowSummaries(
	cwd: string,
	initialRunId?: string,
): Promise<WorkflowSummary[]> {
	const index = await readIndex(cwd).catch(() => undefined);
	let flows = index?.runs ?? [];
	if (flows.length === 0) {
		const records = await listRunRecords(cwd);
		flows = records
			.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
			.map((run) => runToSummary(cwd, run));
	}

	if (
		initialRunId &&
		!flows.some(
			(flow) =>
				flow.runId === initialRunId || flow.runId.startsWith(initialRunId),
		)
	) {
		const run = await readRunRecord(cwd, initialRunId).catch(() => undefined);
		if (run) flows = [runToSummary(cwd, run), ...flows];
	}

	return flows;
}

function runToSummary(cwd: string, run: WorkflowRunRecord): WorkflowSummary {
	return {
		runId: run.runId,
		name: run.name,
		type: run.type,
		status: run.status,
		taskSummary: run.taskSummary,
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
		runJson: workflowRunPath(cwd, run.runId),
		parentRunId: run.parentRunId,
		rootRunId: run.rootRunId,
		round: run.round,
		fanout: run.fanout,
		tasks: run.tasks.map((task) => ({
			taskId: task.taskId,
			displayName: task.displayName,
			kind: task.kind,
			stageId: task.stageId,
			agent: task.agent,
			status: task.status,
			statusDetail: task.statusDetail,
			backendHandle: task.backendHandle,
			lastMessage: task.lastMessage,
		})),
	};
}

async function readFilePreview(
	cwd: string,
	projectPath: string,
	maxLines: number,
): Promise<string> {
	const text = await readFile(fromProjectPath(cwd, projectPath), "utf8").catch(
		(error) => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
			throw error;
		},
	);
	return text.split(/\r?\n/).slice(-maxLines).join("\n").trim();
}

function stageSummaries(
	run: WorkflowRunRecord,
): Array<{ id: string; summary: TaskSummary }> {
	if (run.type !== WORKFLOW_RUN_TYPE)
		return [{ id: String(run.type), summary: run.taskSummary }];
	const order: string[] = [];
	const byStage = new Map<string, WorkflowTaskRunRecord[]>();
	for (const task of run.tasks) {
		const stageId = task.stageId ?? "unknown";
		if (!byStage.has(stageId)) {
			byStage.set(stageId, []);
			order.push(stageId);
		}
		byStage.get(stageId)?.push(task);
	}
	return order.map((id) => ({
		id,
		summary: summarizeTasks(byStage.get(id) ?? []),
	}));
}

function summarizeTasks(tasks: WorkflowTaskRunRecord[]): TaskSummary {
	const summary: TaskSummary = {
		pending: 0,
		running: 0,
		blocked: 0,
		completed: 0,
		failed: 0,
		skipped: 0,
		interrupted: 0,
		total: 0,
	};
	for (const task of tasks) {
		summary[task.status] += 1;
		summary.total += 1;
	}
	return summary;
}

function statusForSummary(summary: TaskSummary): WorkflowRunStatus {
	if (summary.running > 0 || summary.pending > 0) return "running";
	if (summary.blocked > 0) return "blocked";
	if (summary.failed > 0 || summary.interrupted > 0) return "failed";
	if (summary.total > 0 && summary.completed === summary.total)
		return "completed";
	return "interrupted";
}

function taskElapsed(task: WorkflowTaskRunRecord): string {
	if (task.elapsedMs !== undefined) return formatDuration(task.elapsedMs);
	if (task.startedAt && task.status === "running")
		return formatDuration(Date.now() - Date.parse(task.startedAt));
	return task.status;
}

function taskRuntimeSummary(task: WorkflowTaskRunRecord): string {
	const model = task.runtime.model
		? shortModelName(task.runtime.model)
		: "not-recorded";
	const thinking = task.runtime.thinking ?? "not-recorded";
	return `${model}/${thinking}`;
}

function shortModelName(model: string): string {
	return model.split("/").pop() || model;
}

function elapsedText(
	createdAt: string,
	updatedAt: string,
	running: boolean,
): string {
	const start = Date.parse(createdAt);
	const end = running ? Date.now() : Date.parse(updatedAt);
	if (!Number.isFinite(start) || !Number.isFinite(end)) return "unknown";
	return formatDuration(Math.max(0, end - start));
}

function timestampText(value: string): string {
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) return value;
	const pad = (part: number) => String(part).padStart(2, "0");
	const currentYear = new Date().getFullYear();
	const datePart =
		date.getFullYear() === currentYear
			? `${pad(date.getMonth() + 1)}/${pad(date.getDate())}`
			: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
	return `${datePart} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

function statusGlyph(
	theme: Theme,
	status: WorkflowRunStatus | TaskRunStatus,
): string {
	if (status === "completed") return success(theme, "✓");
	if (status === "running") return accent(theme, "↻");
	if (status === "blocked") return warning(theme, "◆");
	if (status === "failed" || status === "interrupted")
		return errorText(theme, "✕");
	if (status === "skipped") return muted(theme, "↷");
	return muted(theme, "•");
}

function metaByStatus(
	theme: Theme,
	status: WorkflowRunStatus | TaskRunStatus,
	content: string,
): string {
	if (status === "running") return accent(theme, content);
	if (status === "blocked") return warning(theme, content);
	if (status === "failed" || status === "interrupted")
		return errorText(theme, content);
	return content;
}

function statusBadge(
	theme: Theme,
	status: WorkflowRunStatus | TaskRunStatus,
	label = statusText(status),
): string {
	const content = ` ${label.toUpperCase().replace(/_/g, " ")} `;
	const colored = fg(theme, statusColor(status), strong(theme, content));
	return theme.bg
		? bgBand(theme, statusBgColor(status), colored)
		: fg(theme, statusColor(status), strong(theme, `[${content.trim()}]`));
}

function statusBgColor(status: WorkflowRunStatus | TaskRunStatus): string {
	if (status === "completed") return "toolSuccessBg";
	if (status === "failed" || status === "interrupted") return "toolErrorBg";
	if (status === "running" || status === "blocked") return "toolPendingBg";
	return "customMessageBg";
}

function progressBar(
	theme: Theme,
	summary: TaskSummary,
	cells: number,
): string {
	const safeCells = Math.max(1, cells);
	const filled =
		summary.total <= 0
			? 0
			: Math.max(
					0,
					Math.min(
						safeCells,
						Math.round((summary.completed / summary.total) * safeCells),
					),
				);
	const bar = `${"▰".repeat(filled)}${"▱".repeat(safeCells - filled)}`;
	return fg(
		theme,
		statusColor(statusForSummary(summary)),
		`${bar} ${summary.completed}/${summary.total}`,
	);
}

function statusColor(status: WorkflowRunStatus | TaskRunStatus): string {
	if (status === "completed") return "success";
	if (status === "running") return "accent";
	if (status === "blocked") return "warning";
	if (status === "failed" || status === "interrupted") return "error";
	return "dim";
}

function statusText(status: WorkflowRunStatus | TaskRunStatus): string {
	return status;
}

function runStatusLabel(flow: WorkflowSummary): string {
	return statusText(flow.status);
}

function shortId(runId: string): string {
	return runId.replace(/^workflow_/, "workflow_").slice(0, 24);
}

function previewLines(
	text: string,
	fallback: string,
	maxLines: number,
): string[] {
	const trimmed = text.trim();
	if (!trimmed) return [fallback];
	return trimmed.split(/\r?\n/).slice(-maxLines);
}

function visibleWindow<T>(
	items: T[],
	selectedIndex: number,
	maxRows: number,
): {
	rows: Array<{ item: T; index: number }>;
	hiddenBefore: number;
	hiddenAfter: number;
} {
	const total = items.length;
	if (total === 0) return { rows: [], hiddenBefore: 0, hiddenAfter: 0 };
	const safeMaxRows = Math.max(1, maxRows);
	const selected = clampIndex(selectedIndex, total);
	const start =
		total <= safeMaxRows
			? 0
			: Math.max(
					0,
					Math.min(selected - Math.floor(safeMaxRows / 2), total - safeMaxRows),
				);
	const end = Math.min(total, start + safeMaxRows);
	return {
		rows: items
			.slice(start, end)
			.map((item, offset) => ({ item, index: start + offset })),
		hiddenBefore: start,
		hiddenAfter: Math.max(0, total - end),
	};
}

function wrapIndex(index: number, length: number): number {
	if (length <= 0) return 0;
	return (index + length) % length;
}

function clampIndex(index: number, length: number): number {
	if (length <= 0) return 0;
	return Math.max(0, Math.min(index, length - 1));
}

const MOD_CTRL = 4;
const ARROW_CODEPOINTS = { up: -1, down: -2, right: -3, left: -4 } as const;
const KITTY_FUNCTIONAL_EQUIVALENTS = new Map<number, number>([
	[57414, 13],
	[57417, ARROW_CODEPOINTS.left],
	[57418, ARROW_CODEPOINTS.right],
	[57419, ARROW_CODEPOINTS.up],
	[57420, ARROW_CODEPOINTS.down],
]);

function matchesKey(data: string, key: string): boolean {
	if (key === "escape")
		return data === "\u001b" || matchesSpecialKey(data, 27, 0);
	if (key === "up")
		return (
			matchesArrowKey(data, "up") ||
			matchesSpecialKey(data, ARROW_CODEPOINTS.up, 0)
		);
	if (key === "down")
		return (
			matchesArrowKey(data, "down") ||
			matchesSpecialKey(data, ARROW_CODEPOINTS.down, 0)
		);
	if (key === "left")
		return (
			matchesArrowKey(data, "left") ||
			matchesSpecialKey(data, ARROW_CODEPOINTS.left, 0)
		);
	if (key === "right")
		return (
			matchesArrowKey(data, "right") ||
			matchesSpecialKey(data, ARROW_CODEPOINTS.right, 0)
		);
	if (key === "enter" || key === "return")
		return (
			data === "\r" ||
			data === "\n" ||
			data === "\u001bOM" ||
			matchesSpecialKey(data, 13, 0)
		);
	if (key === "backspace")
		return (
			data === "\u007f" || data === "\b" || matchesSpecialKey(data, 127, 0)
		);
	if (key === "ctrl+c")
		return data === "\u0003" || matchesSpecialKey(data, 99, MOD_CTRL);
	if (key === "ctrl+d")
		return data === "\u0004" || matchesSpecialKey(data, 100, MOD_CTRL);
	return data === key || matchesPrintableKey(data, key);
}

function matchesArrowKey(
	data: string,
	key: keyof typeof ARROW_CODEPOINTS,
): boolean {
	const legacy = {
		up: ["\u001b[A", "\u001bOA"],
		down: ["\u001b[B", "\u001bOB"],
		left: ["\u001b[D", "\u001bOD"],
		right: ["\u001b[C", "\u001bOC"],
	}[key];
	if (legacy.includes(data)) return true;

	const arrowMatch = /^\u001b\[1;(\d+)(?::(\d+))?([ABCD])$/.exec(data);
	if (!arrowMatch) return false;
	const modifier = Number(arrowMatch[1]) - 1;
	if (modifier !== 0) return false;
	const codepoint = {
		A: ARROW_CODEPOINTS.up,
		B: ARROW_CODEPOINTS.down,
		C: ARROW_CODEPOINTS.right,
		D: ARROW_CODEPOINTS.left,
	}[arrowMatch[3] as "A" | "B" | "C" | "D"];
	return codepoint === ARROW_CODEPOINTS[key];
}

function matchesSpecialKey(
	data: string,
	expectedCodepoint: number,
	expectedModifier: number,
): boolean {
	const parsed = parseKittySequence(data) ?? parseModifyOtherKeysSequence(data);
	if (!parsed) return false;
	const codepoint =
		KITTY_FUNCTIONAL_EQUIVALENTS.get(parsed.codepoint) ?? parsed.codepoint;
	return (
		codepoint === expectedCodepoint && parsed.modifier === expectedModifier
	);
}

function matchesPrintableKey(data: string, key: string): boolean {
	if (key.length !== 1) return false;
	const parsed = parseKittySequence(data);
	if (!parsed || parsed.modifier !== 0) return false;
	return parsed.codepoint === key.charCodeAt(0);
}

function parseKittySequence(
	data: string,
): { codepoint: number; modifier: number } | undefined {
	const csiUMatch =
		/^\u001b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/.exec(data);
	if (csiUMatch) {
		return {
			codepoint: Number(csiUMatch[1]),
			modifier: Number(csiUMatch[4] ?? "1") - 1,
		};
	}

	const arrowMatch = /^\u001b\[1;(\d+)(?::(\d+))?([ABCD])$/.exec(data);
	if (arrowMatch) {
		const codepoint = {
			A: ARROW_CODEPOINTS.up,
			B: ARROW_CODEPOINTS.down,
			C: ARROW_CODEPOINTS.right,
			D: ARROW_CODEPOINTS.left,
		}[arrowMatch[3] as "A" | "B" | "C" | "D"];
		return { codepoint, modifier: Number(arrowMatch[1]) - 1 };
	}

	return undefined;
}

function parseModifyOtherKeysSequence(
	data: string,
): { codepoint: number; modifier: number } | undefined {
	const match = /^\u001b\[27;(\d+);(\d+)~$/.exec(data);
	if (!match) return undefined;
	return { modifier: Number(match[1]) - 1, codepoint: Number(match[2]) };
}

function joinFixedColumns(columns: string[], widths: number[]): string {
	return columns
		.map((column, index) =>
			padAnsi(fit(column, widths[index] ?? 1), widths[index] ?? 1),
		)
		.join(" ");
}

function boxed(
	theme: Theme,
	titleText: string,
	width: number,
	content: string[],
	color = "borderMuted",
): string[] {
	const safeWidth = Math.max(8, width);
	const bodyWidth = Math.max(1, safeWidth - 4);
	const topLabel = `╭─ ${titleText} `;
	const top = `${topLabel}${"─".repeat(Math.max(0, safeWidth - visibleWidth(topLabel) - 1))}╮`;
	const bottom = `╰${"─".repeat(Math.max(0, safeWidth - 2))}╯`;
	const body = content.length > 0 ? content : [""];
	return [
		fg(theme, color, top),
		...body.map(
			(line) =>
				`${fg(theme, color, "│")} ${padAnsi(fit(line, bodyWidth), bodyWidth)} ${fg(theme, color, "│")}`,
		),
		fg(theme, color, bottom),
	];
}

function joinColumns(
	left: string,
	right: string,
	width: number,
	leftWidth: number,
): string {
	const safeLeftWidth = Math.max(1, Math.min(leftWidth, width - 1));
	const safeRightWidth = Math.max(1, width - safeLeftWidth - 1);
	const leftText = fit(left, safeLeftWidth);
	const rightText = fit(right, safeRightWidth);
	return `${padAnsi(leftText, safeLeftWidth)} ${rightText}`;
}

function padAnsi(text: string, width: number): string {
	const visible = visibleWidth(text);
	return visible >= width ? text : `${text}${" ".repeat(width - visible)}`;
}

function fit(text: string, width: number): string {
	return truncateToWidth(text, Math.max(1, width));
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
	granularity: "grapheme",
});

function visibleWidth(text: string): number {
	const clean = stripAnsi(text);
	let width = 0;
	for (const { segment } of GRAPHEME_SEGMENTER.segment(clean)) {
		width += graphemeWidth(segment);
	}
	return width;
}

function truncateToWidth(text: string, width: number): string {
	const safeWidth = Math.max(0, Math.floor(width || 0));
	if (safeWidth === 0) return "";
	if (visibleWidth(text) <= safeWidth) return text;

	const ellipsis = "…";
	const ellipsisWidth = visibleWidth(ellipsis);
	const limit = Math.max(0, safeWidth - ellipsisWidth);
	let visible = 0;
	let output = "";
	for (let index = 0; index < text.length; ) {
		const ansi = readAnsi(text, index);
		if (ansi) {
			output += ansi.value;
			index = ansi.nextIndex;
			continue;
		}

		const codePoint = text.codePointAt(index);
		if (codePoint === undefined) break;
		const char = String.fromCodePoint(codePoint);
		const charWidth = graphemeWidth(char);
		if (visible + charWidth > limit) break;
		output += char;
		visible += charWidth;
		index += char.length;
	}
	return `${output}${ellipsis}`;
}

function stripAnsi(text: string): string {
	let output = "";
	for (let index = 0; index < text.length; ) {
		const ansi = readAnsi(text, index);
		if (ansi) {
			index = ansi.nextIndex;
			continue;
		}
		const codePoint = text.codePointAt(index);
		if (codePoint === undefined) break;
		const char = String.fromCodePoint(codePoint);
		output += char;
		index += char.length;
	}
	return output;
}

function readAnsi(
	text: string,
	index: number,
): { value: string; nextIndex: number } | undefined {
	if (text.charCodeAt(index) !== 0x1b) return undefined;
	const next = text[index + 1];
	if (next === "[") return readCsi(text, index);
	if (next === "]") return readTerminatedEscape(text, index, 2);
	if (next === "_") return readTerminatedEscape(text, index, 2);
	return undefined;
}

function readCsi(
	text: string,
	index: number,
): { value: string; nextIndex: number } | undefined {
	let nextIndex = index + 2;
	while (nextIndex < text.length) {
		const code = text.charCodeAt(nextIndex);
		nextIndex += 1;
		if (code >= 0x40 && code <= 0x7e)
			return { value: text.slice(index, nextIndex), nextIndex };
	}
	return { value: text.slice(index), nextIndex: text.length };
}

function readTerminatedEscape(
	text: string,
	index: number,
	bodyOffset: number,
): { value: string; nextIndex: number } | undefined {
	let nextIndex = index + bodyOffset;
	while (nextIndex < text.length) {
		if (text[nextIndex] === "\x07") {
			const end = nextIndex + 1;
			return { value: text.slice(index, end), nextIndex: end };
		}
		if (text[nextIndex] === "\x1b" && text[nextIndex + 1] === "\\") {
			const end = nextIndex + 2;
			return { value: text.slice(index, end), nextIndex: end };
		}
		nextIndex += 1;
	}
	return { value: text.slice(index), nextIndex: text.length };
}

function graphemeWidth(segment: string): number {
	if (segment.length === 0) return 0;
	if (segment === "\t") return 3;
	if (/^[\p{Mark}\p{Control}\p{Surrogate}\u200d\ufe0e\ufe0f]+$/u.test(segment))
		return 0;
	if (isEmojiLike(segment)) return 2;
	const base = segment.replace(
		/^[\p{Mark}\p{Control}\p{Format}\p{Surrogate}]+/u,
		"",
	);
	const codePoint = base.codePointAt(0);
	if (codePoint === undefined) return 0;
	return isWideCodePoint(codePoint) ? 2 : 1;
}

function isEmojiLike(segment: string): boolean {
	if (/[\ufe0f\u200d]/u.test(segment)) return true;
	const codePoint = segment.codePointAt(0);
	if (codePoint === undefined) return false;
	return (
		(codePoint >= 0x1f000 && codePoint <= 0x1fbff) ||
		(codePoint >= 0x2600 && codePoint <= 0x27bf) ||
		(codePoint >= 0x2b50 && codePoint <= 0x2b55)
	);
}

function isWideCodePoint(codePoint: number): boolean {
	return (
		(codePoint >= 0x1100 && codePoint <= 0x115f) ||
		codePoint === 0x2329 ||
		codePoint === 0x232a ||
		(codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
		(codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
		(codePoint >= 0xf900 && codePoint <= 0xfaff) ||
		(codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
		(codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
		(codePoint >= 0xff00 && codePoint <= 0xff60) ||
		(codePoint >= 0xffe0 && codePoint <= 0xffe6)
	);
}

function placeholder(theme: Theme, text: string): string {
	return muted(theme, text);
}

function messageText(theme: Theme, text: string): string {
	return accent(theme, text);
}

function scrollIndicator(theme: Theme, text: string): string {
	return muted(theme, text);
}

function metaLabel(theme: Theme, text: string): string {
	return muted(theme, text);
}

function metaValue(theme: Theme, text: string): string {
	return fg(theme, "text", text);
}

function agentText(theme: Theme, text: string): string {
	return fg(theme, "syntaxType", text);
}

function kvRow(
	theme: Theme,
	key: string,
	value: string,
	valueColor = "text",
): string {
	return `${metaLabel(theme, `${key}:`)} ${fg(theme, valueColor, value)}`;
}

function taskMetaLine(theme: Theme, pairs: Array<[string, string]>): string {
	return pairs
		.map(([key, value]) => kvRow(theme, key, value))
		.join(` ${muted(theme, "·")} `);
}

function pathRow(theme: Theme, label: string, projectPath: string): string {
	return `${metaLabel(theme, label)} ${pathText(theme, projectPath)}`;
}

function pathText(theme: Theme, projectPath: string): string {
	const lastSlash = projectPath.lastIndexOf("/");
	if (lastSlash < 0) return fg(theme, "mdLinkUrl", projectPath);
	return `${dim(theme, projectPath.slice(0, lastSlash + 1))}${metaValue(theme, projectPath.slice(lastSlash + 1))}`;
}

function commandLine(theme: Theme, command: string): string {
	const parts = command.split(" ");
	const head = parts.length >= 2 ? parts.slice(0, 2).join(" ") : command;
	const rest = parts.length >= 2 ? parts.slice(2).join(" ") : "";
	return rest
		? `${accent(theme, head)} ${muted(theme, rest)}`
		: accent(theme, head);
}

function navHint(theme: Theme, text: string): string {
	return text
		.split(" · ")
		.map((part) => {
			const firstSpace = part.indexOf(" ");
			if (firstSpace < 0) return accent(theme, part);
			return `${accent(theme, part.slice(0, firstSpace))}${muted(theme, part.slice(firstSpace))}`;
		})
		.join(` ${muted(theme, "·")} `);
}

function timelineLine(
	theme: Theme,
	label: string,
	value: string,
	color: string,
): string {
	const glyph = color === "success" ? "✓" : color === "error" ? "✕" : "●";
	return `${fg(theme, color, glyph)} ${metaLabel(theme, label)} ${metaValue(theme, value)}`;
}

function validationLine(theme: Theme, status: string, message: string): string {
	const color =
		status === "valid" ? "success" : status === "invalid" ? "error" : "warning";
	const suffix = message
		? ` ${muted(theme, "·")} ${metaValue(theme, message)}`
		: "";
	return `${fg(theme, color, strong(theme, status))}${suffix}`;
}

function previewText(theme: Theme, line: string): string {
	if (/^\([^)]*\)$/.test(line)) return placeholder(theme, line);
	const trimmedStart = line.trimStart();
	const indent = line.slice(0, line.length - trimmedStart.length);
	if (/^#{1,6}\s/.test(trimmedStart))
		return `${indent}${fg(theme, "mdHeading", strong(theme, trimmedStart))}`;
	if (/^```/.test(trimmedStart)) return fg(theme, "mdCodeBlockBorder", line);
	if (/^(?:\/\/|<!--)/.test(trimmedStart))
		return fg(theme, "syntaxComment", line);

	const bullet = /^(\s*)([-*])\s+(.*)$/.exec(line);
	if (bullet)
		return `${bullet[1]}${fg(theme, "mdListBullet", bullet[2] ?? "-")} ${inlinePreviewText(theme, bullet[3] ?? "")}`;

	const keyValue = /^(\s*(?:"[^"]+"|[A-Za-z0-9_.-]+)\s*[:=])(\s*)(.*)$/.exec(
		line,
	);
	if (keyValue)
		return `${fg(theme, "syntaxVariable", keyValue[1] ?? "")}${keyValue[2] ?? ""}${inlinePreviewText(theme, keyValue[3] ?? "")}`;

	return inlinePreviewText(theme, line);
}

function inlinePreviewText(theme: Theme, text: string): string {
	return text
		.split(/(`[^`]*`|[A-Z][A-Z0-9_]{3,}|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g)
		.map((part) => {
			if (!part) return "";
			if (/^`[^`]*`$/.test(part)) return fg(theme, "mdCode", part);
			if (/^[A-Z][A-Z0-9_]{3,}$/.test(part)) return fg(theme, "mdCode", part);
			if (/^"(?:[^"\\]|\\.)*"$/.test(part) || /^'(?:[^'\\]|\\.)*'$/.test(part))
				return fg(theme, "syntaxString", part);
			return metaValue(theme, part);
		})
		.join("");
}

function bgBand(theme: Theme, color: string, text: string): string {
	if (!theme.bg) return text;
	const marker = "__PI_WORKFLOW_BG_MARKER__";
	const wrapped = theme.bg(color, marker);
	const markerIndex = wrapped.indexOf(marker);
	if (markerIndex < 0) return theme.bg(color, text);
	const prefix = wrapped.slice(0, markerIndex);
	const suffix = wrapped.slice(markerIndex + marker.length);
	return `${prefix}${text.replace(/\u001b\[0m/g, `\u001b[0m${prefix}`)}${suffix}`;
}

function chip(
	theme: Theme,
	label: string,
	value: string,
	color: string,
): string {
	const content = ` ${label} ${value} `;
	return fg(theme, color, strong(theme, `●${content}`));
}

function rule(theme: Theme, width: number): string {
	return fg(
		theme,
		"borderMuted",
		"─".repeat(Math.max(1, Math.min(width, 160))),
	);
}

function selectedLine(
	theme: Theme,
	line: string,
	width: number,
	selected: boolean,
	active: boolean,
): string {
	if (!selected) return line;
	const padded = padAnsi(line, width);
	if (active && theme.bg) return bgBand(theme, "selectedBg", padded);
	return active ? accent(theme, padded) : muted(theme, padded);
}

function strong(theme: Theme, text: string): string {
	return theme.bold ? theme.bold(text) : text;
}

function fg(theme: Theme, color: string, text: string): string {
	return theme.fg ? theme.fg(color, text) : text;
}

function accent(theme: Theme, text: string): string {
	return fg(theme, "accent", text);
}

function muted(theme: Theme, text: string): string {
	return fg(theme, "muted", text);
}

function dim(theme: Theme, text: string): string {
	return fg(theme, "dim", text);
}

function success(theme: Theme, text: string): string {
	return fg(theme, "success", text);
}

function warning(theme: Theme, text: string): string {
	return fg(theme, "warning", text);
}

function errorText(theme: Theme, text: string): string {
	return fg(theme, "error", text);
}
