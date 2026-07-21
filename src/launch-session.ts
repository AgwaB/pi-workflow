import { createHash } from "node:crypto";

import type { WorkflowRunRecord, WorkflowTaskRunRecord } from "./types.js";

const MAX_SUBAGENT_SESSION_ID_LENGTH = 64;

/**
 * Derives the task session from the authoritative retry/resume fields shared
 * by launch and launch-bootstrap provenance. It does not allocate a session.
 */
export function workflowTaskSessionId(
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
): string | undefined {
	if (!task.artifactGraph?.enabled) return undefined;
	const baseSessionId = workflowTaskBaseSessionId(run.runId, task.taskId);
	if (task.outputRetry?.sessionId) return task.outputRetry.sessionId;
	const launchAttempt = task.launchRetry?.attempts ?? 0;
	if (launchAttempt > 0)
		return boundedWorkflowSessionId(
			`${baseSessionId}.launch-retry-${launchAttempt}`,
		);
	const resumeAttempt = task.resumeEvents?.length ?? 0;
	if (resumeAttempt > 0)
		return boundedWorkflowSessionId(`${baseSessionId}.resume-${resumeAttempt}`);
	return baseSessionId;
}

export function workflowTaskAttemptIdentity(
	task: WorkflowTaskRunRecord,
	sessionId: string | undefined,
): string {
	return [
		`launch-retry:${task.launchRetry?.attempts ?? 0}`,
		`output-retry:${task.outputRetry?.attempts ?? 0}`,
		`resume:${task.resumeEvents?.length ?? 0}`,
		`session:${sessionId ?? "none"}`,
	].join(";");
}

export function retryWorkflowTaskSessionId(
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	attempt: number,
): string {
	return boundedWorkflowSessionId(
		`${workflowTaskBaseSessionId(run.runId, task.taskId)}.retry-${attempt}`,
	);
}

export function isWorkflowTaskSessionIdentity(input: {
	runId: string;
	taskId: string;
	launchRetry: number;
	outputRetry: number;
	resume: number;
	sessionId: string;
}): boolean {
	const base = workflowTaskBaseSessionId(input.runId, input.taskId);
	if (input.outputRetry > 0) {
		return new Set([
			base,
			boundedWorkflowSessionId(`${base}.launch-retry-${input.launchRetry}`),
			boundedWorkflowSessionId(`${base}.resume-${input.resume}`),
			boundedWorkflowSessionId(`${base}.retry-${input.outputRetry}`),
		]).has(input.sessionId);
	}
	if (input.launchRetry > 0)
		return (
			input.sessionId ===
			boundedWorkflowSessionId(`${base}.launch-retry-${input.launchRetry}`)
		);
	if (input.resume > 0)
		return (
			input.sessionId === boundedWorkflowSessionId(`${base}.resume-${input.resume}`)
		);
	return input.sessionId === base;
}

function workflowTaskBaseSessionId(runId: string, taskId: string): string {
	return boundedWorkflowSessionId(`pi-workflow.${runId}.${taskId}`);
}

function boundedWorkflowSessionId(value: string): string {
	const sanitized = value.replace(/[^A-Za-z0-9._-]/g, "-");
	if (sanitized.length <= MAX_SUBAGENT_SESSION_ID_LENGTH) return sanitized;
	const digest = createHash("sha256")
		.update(sanitized)
		.digest("hex")
		.slice(0, 16);
	const suffix = sanitized.split(".").at(-1) || "session";
	const prefix = `piwf.${digest}`;
	const maxSuffixLength = MAX_SUBAGENT_SESSION_ID_LENGTH - prefix.length - 1;
	const boundedSuffix = suffix.slice(-Math.max(1, maxSuffixLength));
	return `${prefix}.${boundedSuffix}`;
}
