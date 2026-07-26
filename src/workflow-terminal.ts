import { dirname, join } from "node:path";

import {
	finalStageTasks,
	fromProjectPath,
	isTerminalWorkflowStatus,
	readJson,
	workflowRunDir,
} from "./store.js";
import type { WorkflowRunRecord } from "./types.js";

export type WorkflowSemanticStatus =
	| "running"
	| "blocked"
	| "failed"
	| "interrupted"
	| "completed"
	| "completed_degraded"
	| "synthesized"
	| "exhausted_with_output"
	| "exhausted_without_output"
	| "dynamic_blocked"
	| "dynamic_incomplete"
	| "dynamic_stopped"
	| "completed_without_semantic_result";

export interface WorkflowTerminalSummary {
	terminal: boolean;
	engineStatus: WorkflowRunRecord["status"];
	semanticStatus: WorkflowSemanticStatus;
	outputTaskIds: string[];
	outputRetryAttempts: number;
	launchRetryAttempts: number;
	artifactRoot: string;
}

interface DynamicControllerControl {
	schema?: unknown;
	status?: unknown;
	outputTasks?: unknown;
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

async function readDynamicControllerControl(
	cwd: string,
	run: WorkflowRunRecord,
): Promise<DynamicControllerControl | undefined> {
	const controller = run.tasks.find(
		(task) =>
			task.specId === "dynamic.controller" ||
			task.statusDetail === "dynamic_completed",
	);
	if (!controller) return undefined;
	const taskOutput = fromProjectPath(cwd, controller.files.output);
	return await readJson<DynamicControllerControl>(
		join(dirname(taskOutput), "control.json"),
	).catch(() => undefined);
}

function nonDynamicSemanticStatus(
	run: WorkflowRunRecord,
): WorkflowSemanticStatus {
	if (run.status === "completed")
		return run.degradation ? "completed_degraded" : "completed";
	return run.status;
}

export async function summarizeWorkflowTerminal(
	cwd: string,
	run: WorkflowRunRecord,
): Promise<WorkflowTerminalSummary> {
	const terminal = isTerminalWorkflowStatus(run.status);
	let semanticStatus: WorkflowSemanticStatus = nonDynamicSemanticStatus(run);
	let outputTaskIds = finalStageTasks(run.tasks).map((task) => task.specId);

	if (terminal && run.provenance?.mode === "direct-dynamic") {
		const control = await readDynamicControllerControl(cwd, run);
		outputTaskIds = stringArray(control?.outputTasks);
		const incomplete = run.tasks.some(
			(task) => task.statusDetail === "dynamic_incomplete",
		);
		if (incomplete) semanticStatus = "dynamic_incomplete";
		else if (control?.status === "synthesized") semanticStatus = "synthesized";
		else if (control?.status === "exhausted")
			semanticStatus =
				outputTaskIds.length > 0
					? "exhausted_with_output"
					: "exhausted_without_output";
		else if (control?.status === "blocked") semanticStatus = "dynamic_blocked";
		else if (control?.status === "stopped") semanticStatus = "dynamic_stopped";
		else semanticStatus = "completed_without_semantic_result";
	}

	return {
		terminal,
		engineStatus: run.status,
		semanticStatus,
		outputTaskIds,
		outputRetryAttempts: run.tasks.reduce(
			(total, task) => total + (task.outputRetry?.attempts ?? 0),
			0,
		),
		launchRetryAttempts: run.tasks.reduce(
			(total, task) => total + (task.launchRetry?.attempts ?? 0),
			0,
		),
		artifactRoot: workflowRunDir(cwd, run.runId),
	};
}
