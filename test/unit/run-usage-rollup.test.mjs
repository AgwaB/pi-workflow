import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readRunRecord, writeRunRecord } from "../../.tmp/unit/store.js";

function taskRecord(taskId, usageValues) {
	return {
		taskId,
		specId: taskId,
		displayName: taskId,
		agent: "worker",
		status: "completed",
		statusDetail: "completed",
		kind: "main",
		runtime: { approvalMode: "never" },
		cwd: "/tmp/rollup",
		worktree: {
			enabled: false,
			path: null,
			branch: null,
			baseCwd: null,
			warning: null,
		},
		backendTaskId: taskId,
		files: {
			output: "",
			stderr: "",
			result: "",
			systemPrompt: "",
			taskPrompt: "",
		},
		...(usageValues
			? {
					usage: {
						source: "pi-subagent",
						capturedAt: "2026-07-07T00:00:00.000Z",
						...usageValues,
						aggregate: { attempts: 1, ...usageValues },
						attempts: [],
					},
				}
			: {}),
	};
}

function runRecord(runId, tasks) {
	return {
		schemaVersion: 1,
		runId,
		name: "rollup-test",
		type: "workflow",
		status: "completed",
		taskSummary: {
			total: tasks.length,
			pending: 0,
			running: 0,
			completed: tasks.length,
			blocked: 0,
			failed: 0,
			skipped: 0,
			interrupted: 0,
		},
		cwd: "/tmp/rollup",
		backend: { type: "local-pi", mode: "headless" },
		createdAt: "2026-07-07T00:00:00.000Z",
		updatedAt: "2026-07-07T00:00:00.000Z",
		specPath: "spec.json",
		tasks,
	};
}
