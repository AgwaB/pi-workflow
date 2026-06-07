import { TaskRunStatus, TaskSummary, WorkflowRunStatus, WorkflowTaskRunRecord } from "./types.js";

export const TASK_STATUSES: Array<keyof Omit<TaskSummary, "total">> = [
  "pending",
  "running",
  "blocked",
  "completed",
  "failed",
  "skipped",
  "interrupted",
];

export function emptyTaskSummary(): TaskSummary {
  return TASK_STATUSES.reduce((summary, status) => {
    summary[status] = 0;
    return summary;
  }, { total: 0 } as TaskSummary);
}

export function summarizeTasks(tasks: Array<Pick<WorkflowTaskRunRecord, "status">>): TaskSummary {
  const summary = emptyTaskSummary();
  for (const task of tasks) {
    summary[task.status] += 1;
    summary.total += 1;
  }
  return summary;
}

export function deriveWorkflowStatus(summary: TaskSummary): WorkflowRunStatus {
  if (summary.running > 0) return "running";
  if (summary.blocked > 0) return "blocked";
  if (summary.pending > 0) return "running";
  if (summary.total > 0 && summary.completed === summary.total) return "completed";
  if (summary.failed > 0 || summary.interrupted > 0) return "failed";
  return "interrupted";
}

export function isActiveTaskStatus(status: TaskRunStatus): boolean {
  return status === "pending" || status === "running";
}

export function isStageFailureTaskStatus(status: TaskRunStatus): boolean {
  return status === "failed" || status === "interrupted" || status === "skipped" || status === "blocked";
}

export function isTerminalWorkflowStatus(status: WorkflowRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "interrupted";
}

export function isTerminalTaskStatus(status: TaskRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "skipped" || status === "interrupted" || status === "blocked";
}
