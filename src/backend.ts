import { CompiledTask, WorkflowRunRecord, WorkflowTaskRunRecord } from "./types.js";
import { cleanupSubagentRun, launchSubagentTask, refreshRunFromSubagentArtifacts } from "./subagent-backend.js";

export type BackendLaunchResult =
  | { kind: "launched" }
  | { kind: "capacity"; message: string; retryAfterMs?: number }
  | { kind: "fatal"; message: string };

export interface WorkflowBackend {
  readonly id: string;
  refreshRun(cwd: string, run: WorkflowRunRecord): Promise<WorkflowRunRecord>;
  launchTask(cwd: string, run: WorkflowRunRecord, task: WorkflowTaskRunRecord, compiledTask: CompiledTask): Promise<BackendLaunchResult>;
  cleanupRun(cwd: string, run: WorkflowRunRecord): Promise<void>;
}

const subagentHeadlessBackend: WorkflowBackend = {
  id: "pi-subagent/headless",
  refreshRun: refreshRunFromSubagentArtifacts,
  cleanupRun: cleanupSubagentRun,
  async launchTask(cwd, run, task, compiledTask) {
    try {
      return await launchSubagentTask(cwd, run, task, compiledTask);
    } catch (error) {
      return { kind: "fatal", message: error instanceof Error ? error.message : String(error) };
    }
  },
};

export function resolveWorkflowBackend(run: WorkflowRunRecord): WorkflowBackend {
  if (run.backend.type === "local-pi" && run.backend.mode === "headless") return subagentHeadlessBackend;
  throw new Error(`Unsupported workflow backend: ${run.backend.type}/${run.backend.mode}`);
}
