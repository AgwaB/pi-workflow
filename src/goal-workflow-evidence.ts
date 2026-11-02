import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";

import type { WorkflowTaskRunRecord } from "./types.js";
import { parseWorkflowOutput } from "./workflow-output-artifacts.js";

const MAX_PUBLISHED_WORKFLOW_GOAL_RAW_BYTES = 8 * 1024 * 1024;
const SAFE_WORKFLOW_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;

async function canonicalRawPath(cwd: string, path: string): Promise<string> {
	const root = await realpath(cwd);
	let file = root;
	for (const segment of path.split("/")) {
		file = join(file, segment);
		const entry = await lstat(file);
		if (entry.isSymbolicLink())
			throw new Error("Ordinary Goal reads cannot traverse symbolic links");
	}
	return file;
}

async function readCanonicalRawBytes(file: string): Promise<Buffer> {
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > MAX_PUBLISHED_WORKFLOW_GOAL_RAW_BYTES)
			throw new Error("Ordinary Goal raw read exceeds bounded regular-file scope");
		const bytes = Buffer.alloc(stat.size + 1);
		const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
		if (bytesRead !== stat.size)
			throw new Error("Ordinary Goal raw changed during bounded read");
		return bytes.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

/**
 * Reads the exact raw policy publication anchored by the original host task.
 * This authenticates persisted bytes only; it grants no live authority.
 */
export async function readPublishedWorkflowGoalPolicyControl(
	cwd: string,
	runId: string,
	task: WorkflowTaskRunRecord,
): Promise<Record<string, unknown>> {
	const taskId = task.taskId;
	if (!SAFE_WORKFLOW_ID.test(runId) || !SAFE_WORKFLOW_ID.test(taskId))
		throw new Error("Ordinary Goal published policy task identity invalid");
	const directory = `.pi/workflows/${runId}/tasks/${taskId}`;
	if (task.files.result !== `${directory}/result.json`)
		throw new Error("Ordinary Goal published policy result path mismatch");

	// Snapshot the host anchor before any filesystem await. Disk content never
	// mints or replaces this authority-bearing run-record observation.
	const recorded = task.rawArtifactIntegrity;
	const anchor = recorded && {
		version: recorded.version,
		owner: recorded.owner,
		bytes: recorded.bytes,
		sha256: recorded.sha256,
	};
	if (!anchor || anchor.version !== 1 || !SHA256.test(anchor.owner) ||
		!SHA256.test(anchor.sha256) || !Number.isSafeInteger(anchor.bytes) ||
		anchor.bytes <= 0 || anchor.bytes > MAX_PUBLISHED_WORKFLOW_GOAL_RAW_BYTES)
		throw new Error("Ordinary Goal published raw integrity unavailable");

	const raw = await readCanonicalRawBytes(
		await canonicalRawPath(cwd, `${directory}/raw.md`),
	);
	if (raw.length !== anchor.bytes ||
		createHash("sha256").update(raw).digest("hex") !== anchor.sha256)
		throw new Error("Ordinary Goal published raw integrity mismatch");
	const parsed = parseWorkflowOutput(raw.toString("utf8"), {
		analysisRequired: true,
		refsRequired: true,
	});
	if (!parsed.valid || !parsed.control)
		throw new Error("Ordinary Goal published policy output invalid");
	return parsed.control;
}
