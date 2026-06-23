import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";

import { hashDynamicRequest } from "./dynamic-events.js";
import { fromProjectPath, readJson, workflowRunDir } from "./store.js";
import type {
	CompiledTask,
	WorkflowRunRecord,
	WorkflowTaskRunRecord,
} from "./types.js";
import {
	buildSourceContextPacket,
	summarizeWorkflowTelemetry,
} from "./workflow-artifacts.js";
import type { SourceContextPacketOptions } from "./workflow-artifacts.js";

const SOURCE_CONTEXT_PREVIEW_CHARS = 1_200;
const SOURCE_CONTEXT_STRUCTURED_CHARS = 6_000;
const SOURCE_CONTEXT_MAX_PACKET_CHARS = 48_000;

export async function workflowBundleFingerprint(
	cwd: string,
	run: WorkflowRunRecord,
): Promise<{ files: Array<{ path: string; hash: string }> } | undefined> {
	const bundleDir = join(workflowRunDir(cwd, run.runId), "bundle");
	const files = await listWorkflowBundleFiles(bundleDir).catch((error) => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	});
	if (!files) return undefined;
	return {
		files: await Promise.all(
			files.map(async (path) => ({
				path,
				hash: hashDynamicRequest(await readFile(join(bundleDir, path), "utf8")),
			})),
		),
	};
}

async function listWorkflowBundleFiles(
	root: string,
	dir = root,
): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await listWorkflowBundleFiles(root, path)));
		} else if (entry.isFile()) {
			files.push(relative(root, path).replaceAll("\\", "/"));
		}
	}
	return files.sort();
}

export async function workflowBundleSpecPath(
	cwd: string,
	run: WorkflowRunRecord,
	options: { required?: boolean } = {},
): Promise<string> {
	const bundleDir = join(workflowRunDir(cwd, run.runId), "bundle");
	const candidateSpecPaths = [
		join(bundleDir, basename(run.specPath)),
		join(bundleDir, "spec.json"),
	];
	for (const artifactSpecPath of candidateSpecPaths) {
		try {
			if ((await stat(artifactSpecPath)).isFile()) return artifactSpecPath;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	if (options.required) {
		throw new Error(
			`workflow run bundle is required for dynamic workflow replay: ${run.runId}`,
		);
	}
	return run.specPath;
}

export function sourceContextOptions(
	task: Pick<CompiledTask, "sourceContext">,
): SourceContextPacketOptions {
	const sourceContext = task.sourceContext ?? {};
	return {
		maxPreviewChars:
			sourceContext.maxPreviewChars ?? SOURCE_CONTEXT_PREVIEW_CHARS,
		maxStructuredChars:
			sourceContext.maxStructuredChars ?? SOURCE_CONTEXT_STRUCTURED_CHARS,
		maxStructuredCharsByStage: sourceContext.maxStructuredCharsByStage,
		structuredOutputPathsByStage: sourceContext.structuredOutputPathsByStage,
		maxPacketChars:
			sourceContext.maxPacketChars ?? SOURCE_CONTEXT_MAX_PACKET_CHARS,
	};
}

export async function buildRunSourceContext(
	cwd: string,
	run: Pick<WorkflowRunRecord, "createdAt" | "updatedAt"> & {
		tasks: WorkflowTaskRunRecord[];
	},
	sourceTasks: WorkflowTaskRunRecord[],
	options: Pick<
		SourceContextPacketOptions,
		| "maxPreviewChars"
		| "maxStructuredChars"
		| "maxStructuredCharsByStage"
		| "structuredOutputPathsByStage"
		| "maxPacketChars"
	> = {},
): Promise<{
	telemetry: ReturnType<typeof summarizeWorkflowTelemetry>;
	packet: ReturnType<typeof buildSourceContextPacket>;
}> {
	const maxPreviewChars =
		options.maxPreviewChars ?? SOURCE_CONTEXT_PREVIEW_CHARS;
	const maxStructuredChars =
		options.maxStructuredChars ?? SOURCE_CONTEXT_STRUCTURED_CHARS;
	const maxPacketChars =
		options.maxPacketChars ?? SOURCE_CONTEXT_MAX_PACKET_CHARS;
	const structuredOutputsByTaskId: Record<string, unknown> = {};
	const rawOutputsByTaskId: Record<string, string> = {};
	const outputBytesByTaskId: Record<string, number> = {};

	await Promise.all(
		sourceTasks.map(async (task) => {
			const [result, output] = await Promise.all([
				readJson<{ structuredOutput?: unknown }>(
					fromProjectPath(cwd, task.files.result),
				).catch(() => undefined),
				readOutputText(cwd, task.files.output),
			]);
			if (result && Object.hasOwn(result, "structuredOutput"))
				structuredOutputsByTaskId[task.taskId] = result.structuredOutput;
			rawOutputsByTaskId[task.taskId] = output.text;
			outputBytesByTaskId[task.files.output] = output.bytes;
		}),
	);

	return {
		telemetry: summarizeWorkflowTelemetry(run, { outputBytesByTaskId }),
		packet: buildSourceContextPacket(
			{ tasks: sourceTasks },
			{
				structuredOutputsByTaskId,
				rawOutputsByTaskId,
				maxPreviewChars,
				maxStructuredChars,
				maxStructuredCharsByStage: options.maxStructuredCharsByStage,
				structuredOutputPathsByStage: options.structuredOutputPathsByStage,
				maxPacketChars,
			},
		),
	};
}

export async function readOutputText(
	cwd: string,
	projectPath: string,
): Promise<{ text: string; bytes: number }> {
	try {
		const text = await readFile(fromProjectPath(cwd, projectPath), "utf8");
		return { text, bytes: Buffer.byteLength(text, "utf8") };
	} catch {
		return { text: "", bytes: 0 };
	}
}
