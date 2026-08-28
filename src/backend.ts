import type {
	CompiledTask,
	CompiledToolProvider,
	WorkflowRunRecord,
	WorkflowLaunchAuthorityGrant,
	WorkflowTaskRunRecord,
	WorkflowToolResultBudgetConfigurationSource,
} from "./types.js";
import {
	cleanupSubagentRun,
	launchSubagentTask,
	prepareSubagentTaskLaunch,
	refreshRunFromSubagentArtifacts,
} from "./subagent-backend.js";
import { isWorkflowStopRequestedError } from "./workflow-stop.js";

export type BackendLaunchResult =
	| { kind: "launched" }
	| { kind: "capacity"; message: string; retryAfterMs?: number }
	| { kind: "fatal"; message: string };

export interface PreparedWorkflowTaskLaunch {
	extensions: string[];
	/** Provider metadata retained for launch auditing and wrapper preparation. */
	toolProviders?: Record<string, CompiledToolProvider>;
	generatedExtensions: Array<{
		kind: "fetch-cache" | "web-source";
		path: string;
		expectedBytes: string;
		config: unknown;
	}>;
	captureToolCalls: boolean;
	toolResultBudget?: {
		configured: boolean;
		source: WorkflowToolResultBudgetConfigurationSource;
		maxTotalChars?: number;
	};
	artifactBinding?: {
		manifestPath: string;
		expectedManifestBytes: string;
		wrapperPath: string;
		expectedWrapperBytes: string;
	};
	authority?: WorkflowLaunchAuthorityGrant;
}

export interface WorkflowBackend {
	readonly id: string;
	refreshRun(cwd: string, run: WorkflowRunRecord): Promise<WorkflowRunRecord>;
	prepareTaskLaunch(
		cwd: string,
		run: WorkflowRunRecord,
		task: WorkflowTaskRunRecord,
		compiledTask: CompiledTask,
	): Promise<PreparedWorkflowTaskLaunch>;
	launchTask(
		cwd: string,
		run: WorkflowRunRecord,
		task: WorkflowTaskRunRecord,
		compiledTask: CompiledTask,
		leaseSignal?: AbortSignal,
		workflowStopSignal?: AbortSignal,
		preparedLaunch?: PreparedWorkflowTaskLaunch,
	): Promise<BackendLaunchResult>;
	cleanupRun(cwd: string, run: WorkflowRunRecord): Promise<void>;
}

const subagentHeadlessBackend: WorkflowBackend = {
	id: "pi-subagent/headless",
	refreshRun: refreshRunFromSubagentArtifacts,
	cleanupRun: cleanupSubagentRun,
	async prepareTaskLaunch(cwd, run, task, compiledTask) {
		return prepareSubagentTaskLaunch(cwd, run, task, compiledTask, true);
	},
	async launchTask(
		cwd,
		run,
		task,
		compiledTask,
		leaseSignal,
		workflowStopSignal,
		preparedLaunch,
	) {
		try {
			return await launchSubagentTask(
				cwd,
				run,
				task,
				compiledTask,
				leaseSignal,
				workflowStopSignal,
				preparedLaunch,
			);
		} catch (error) {
			if (
				leaseSignal?.aborted ||
				workflowStopSignal?.aborted ||
				isWorkflowStopRequestedError(error)
			) {
				throw error;
			}
			return {
				kind: "fatal",
				message: error instanceof Error ? error.message : String(error),
			};
		}
	},
};

export function resolveWorkflowBackend(
	run: WorkflowRunRecord,
): WorkflowBackend {
	if (run.backend.type === "local-pi" && run.backend.mode === "headless")
		return subagentHeadlessBackend;
	throw new Error(
		`Unsupported workflow backend: ${run.backend.type}/${run.backend.mode}`,
	);
}
