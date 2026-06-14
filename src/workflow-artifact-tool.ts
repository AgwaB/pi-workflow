import {
	appendFile,
	lstat,
	mkdir,
	open,
	readFile,
	realpath,
	stat,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export const WORKFLOW_SOURCE_MANIFEST_SCHEMA =
	"workflow-source-manifest-v1" as const;
export const WORKFLOW_ARTIFACT_READ_SCHEMA =
	"workflow-artifact-read-v1" as const;

export const WORKFLOW_TASK_ARTIFACT_KINDS = [
	"control",
	"analysis",
	"refs",
	"raw",
] as const;
export const WORKFLOW_DEBUG_ARTIFACT_KINDS = [
	"prompt",
	"system-prompt",
	"stderr",
	"result",
] as const;
export const WORKFLOW_ARTIFACT_KINDS = [
	...WORKFLOW_TASK_ARTIFACT_KINDS,
	...WORKFLOW_DEBUG_ARTIFACT_KINDS,
] as const;

export type WorkflowArtifactKind = (typeof WORKFLOW_ARTIFACT_KINDS)[number];
export type WorkflowArtifactAccessMode = "workflow-task" | "human-debug";

export interface WorkflowArtifactRef {
	path: string;
	mediaType?: string;
}

export interface WorkflowSourceManifestSource {
	source: string;
	displayName?: string;
	taskId?: string;
	specId?: string;
	digest?: string;
	controlProjection?: unknown;
	projectionMissingPaths?: string[];
	projectionTruncated?: boolean;
	artifacts: Partial<Record<WorkflowArtifactKind, WorkflowArtifactRef>>;
}

export interface WorkflowSourceManifest {
	schema: typeof WORKFLOW_SOURCE_MANIFEST_SCHEMA;
	runId: string;
	taskId: string;
	sources: WorkflowSourceManifestSource[];
	policy?: {
		accessMode?: WorkflowArtifactAccessMode;
		debugArtifacts?: boolean;
	};
}

export interface WorkflowArtifactReadLedgerRecord {
	schema: typeof WORKFLOW_ARTIFACT_READ_SCHEMA;
	runId: string;
	taskId: string;
	source: string;
	artifact: WorkflowArtifactKind;
	at: string;
	bytes: number;
	returnedBytes: number;
	truncated: boolean;
}

export interface WorkflowArtifactToolConfig {
	runId: string;
	taskId: string;
	manifestPath: string;
	ledgerPath: string;
	accessMode?: WorkflowArtifactAccessMode;
	runDir?: string;
	maxBytes?: number;
	maxLines?: number;
}

export interface WorkflowArtifactListEntry {
	source: string;
	displayName?: string;
	taskId?: string;
	specId?: string;
	digest?: string;
	controlProjection?: unknown;
	projectionMissingPaths?: string[];
	projectionTruncated?: boolean;
	artifacts: WorkflowArtifactKind[];
}

export interface WorkflowArtifactReadResult {
	source: string;
	artifact: WorkflowArtifactKind;
	content: string;
	bytes: number;
	returnedBytes: number;
	truncated: boolean;
	mediaType?: string;
}

export interface WorkflowArtifactToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

type JsonRecord = Record<string, unknown>;

const WORKFLOW_ARTIFACT_KIND_SET = new Set<string>(WORKFLOW_ARTIFACT_KINDS);
const DEFAULT_MAX_BYTES = 50 * 1024;
const DEFAULT_MAX_LINES = 2000;
const SOURCE_NAME_PATTERN = /^[A-Za-z0-9_.:-]+$/;

export async function loadWorkflowSourceManifest(
	manifestPath: string,
	options: { runDir?: string } = {},
): Promise<WorkflowSourceManifest> {
	const absoluteManifestPath = resolve(manifestPath);
	const runDir = resolve(
		options.runDir ?? inferRunDirFromManifestPath(absoluteManifestPath),
	);
	const raw = JSON.parse(
		await readFile(absoluteManifestPath, "utf8"),
	) as unknown;
	return normalizeWorkflowSourceManifest(raw, { runDir });
}

export function normalizeWorkflowSourceManifest(
	value: unknown,
	options: { runDir: string },
): WorkflowSourceManifest {
	if (!isRecord(value)) throw new Error("source manifest must be an object");
	if (value.schema !== WORKFLOW_SOURCE_MANIFEST_SCHEMA)
		throw new Error(
			`source manifest schema must be ${WORKFLOW_SOURCE_MANIFEST_SCHEMA}`,
		);
	const runId = requiredString(value.runId, "runId");
	const taskId = requiredString(value.taskId, "taskId");
	if (!Array.isArray(value.sources))
		throw new Error("source manifest sources must be an array");

	const seen = new Set<string>();
	const sources = value.sources.map((sourceValue, index) => {
		if (!isRecord(sourceValue))
			throw new Error(`source manifest sources[${index}] must be an object`);
		const source = requiredString(
			sourceValue.source,
			`sources[${index}].source`,
		);
		validateSourceName(source, `sources[${index}].source`);
		if (seen.has(source))
			throw new Error(`duplicate source in source manifest: ${source}`);
		seen.add(source);

		const artifactsValue = sourceValue.artifacts;
		if (!isRecord(artifactsValue))
			throw new Error(`sources[${index}].artifacts must be an object`);

		const artifacts: Partial<
			Record<WorkflowArtifactKind, WorkflowArtifactRef>
		> = {};
		for (const [artifact, refValue] of Object.entries(artifactsValue)) {
			assertArtifactKind(artifact, `sources[${index}].artifacts`);
			if (!isRecord(refValue))
				throw new Error(
					`sources[${index}].artifacts.${artifact} must be an object`,
				);
			const path = requiredString(
				refValue.path,
				`sources[${index}].artifacts.${artifact}.path`,
			);
			const absolutePath = resolveArtifactPath(path, options.runDir, {
				field: `sources[${index}].artifacts.${artifact}.path`,
			});
			const mediaType = optionalString(
				refValue.mediaType,
				`sources[${index}].artifacts.${artifact}.mediaType`,
			);
			artifacts[artifact] = mediaType
				? { path: absolutePath, mediaType }
				: { path: absolutePath };
		}

		return {
			source,
			displayName: optionalString(
				sourceValue.displayName,
				`sources[${index}].displayName`,
			),
			taskId: optionalString(sourceValue.taskId, `sources[${index}].taskId`),
			specId: optionalString(sourceValue.specId, `sources[${index}].specId`),
			digest: optionalString(sourceValue.digest, `sources[${index}].digest`),
			controlProjection: sourceValue.controlProjection,
			projectionMissingPaths: optionalStringArray(
				sourceValue.projectionMissingPaths,
				`sources[${index}].projectionMissingPaths`,
			),
			projectionTruncated: optionalBoolean(
				sourceValue.projectionTruncated,
				`sources[${index}].projectionTruncated`,
			),
			artifacts,
		};
	});

	const policy = normalizePolicy(value.policy);
	return policy
		? {
				schema: WORKFLOW_SOURCE_MANIFEST_SCHEMA,
				runId,
				taskId,
				sources,
				policy,
			}
		: { schema: WORKFLOW_SOURCE_MANIFEST_SCHEMA, runId, taskId, sources };
}

export function allowedWorkflowArtifactKinds(
	accessMode: WorkflowArtifactAccessMode = "workflow-task",
): WorkflowArtifactKind[] {
	return accessMode === "human-debug"
		? [...WORKFLOW_ARTIFACT_KINDS]
		: [...WORKFLOW_TASK_ARTIFACT_KINDS];
}

export function listWorkflowArtifactSources(
	manifest: WorkflowSourceManifest,
	options: { accessMode?: WorkflowArtifactAccessMode } = {},
): WorkflowArtifactListEntry[] {
	const allowed = new Set(allowedWorkflowArtifactKinds(options.accessMode));
	return manifest.sources.map((source) => {
		const artifacts = Object.keys(source.artifacts).filter(
			(artifact): artifact is WorkflowArtifactKind =>
				allowed.has(artifact as WorkflowArtifactKind),
		);
		return {
			source: source.source,
			displayName: source.displayName,
			taskId: source.taskId,
			specId: source.specId,
			digest: source.digest,
			controlProjection: source.controlProjection,
			projectionMissingPaths: source.projectionMissingPaths,
			projectionTruncated: source.projectionTruncated,
			artifacts,
		};
	});
}

export function resolveWorkflowArtifact(
	manifest: WorkflowSourceManifest,
	sourceName: string,
	artifact: string,
	options: { accessMode?: WorkflowArtifactAccessMode } = {},
): {
	source: WorkflowSourceManifestSource;
	artifact: WorkflowArtifactKind;
	ref: WorkflowArtifactRef;
} {
	validateSourceName(sourceName, "source");
	assertArtifactKind(artifact, "artifact");
	const accessMode =
		options.accessMode ?? manifest.policy?.accessMode ?? "workflow-task";
	if (!allowedWorkflowArtifactKinds(accessMode).includes(artifact)) {
		throw new Error(
			`artifact ${artifact} is not available in ${accessMode} access mode`,
		);
	}
	const source = manifest.sources.find(
		(candidate) => candidate.source === sourceName,
	);
	if (!source)
		throw new Error(`unknown workflow artifact source: ${sourceName}`);
	const ref = source.artifacts[artifact];
	if (!ref)
		throw new Error(
			`source ${sourceName} did not produce artifact ${artifact}`,
		);
	return { source, artifact, ref };
}

export async function readWorkflowArtifact(
	manifest: WorkflowSourceManifest,
	sourceName: string,
	artifact: string,
	options: {
		accessMode?: WorkflowArtifactAccessMode;
		maxBytes?: number;
		maxLines?: number;
		runDir?: string;
	} = {},
): Promise<WorkflowArtifactReadResult> {
	const resolved = resolveWorkflowArtifact(
		manifest,
		sourceName,
		artifact,
		options,
	);
	const artifactPath = resolved.ref.path;
	const linkStat = await lstat(artifactPath);
	if (linkStat.isSymbolicLink()) {
		throw new Error(
			`workflow artifact must not be a symlink: ${sourceName}.${artifact}`,
		);
	}
	const fileStat = await stat(artifactPath);
	if (!fileStat.isFile())
		throw new Error(
			`workflow artifact is not a regular file: ${sourceName}.${artifact}`,
		);
	if (options.runDir) {
		const [realRunDir, realArtifactPath] = await Promise.all([
			realpath(resolve(options.runDir)),
			realpath(artifactPath),
		]);
		if (!isInsidePath(realRunDir, realArtifactPath)) {
			throw new Error(
				`workflow artifact must stay inside the workflow run directory: ${sourceName}.${artifact}`,
			);
		}
	}
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const sizeTruncated = fileStat.size > maxBytes;
	const text = sizeTruncated
		? await readUtf8Prefix(artifactPath, maxBytes)
		: await readFile(artifactPath, "utf8");
	const bytes = fileStat.size;
	const truncated = truncateHead(text, {
		maxBytes,
		maxLines,
	});
	return {
		source: resolved.source.source,
		artifact: resolved.artifact,
		content: truncated.content,
		bytes,
		returnedBytes: Buffer.byteLength(truncated.content, "utf8"),
		truncated: truncated.truncated || sizeTruncated,
		mediaType: resolved.ref.mediaType,
	};
}

export async function appendWorkflowArtifactReadLedger(
	ledgerPath: string,
	record: WorkflowArtifactReadLedgerRecord,
): Promise<void> {
	await mkdir(dirname(resolve(ledgerPath)), { recursive: true });
	await appendFile(resolve(ledgerPath), `${JSON.stringify(record)}\n`, "utf8");
}

export async function readWorkflowArtifactReadLedger(
	ledgerPath: string,
): Promise<WorkflowArtifactReadLedgerRecord[]> {
	let text: string;
	try {
		text = await readFile(resolve(ledgerPath), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return text
		.split(/\r?\n/)
		.filter((line) => line.trim().length > 0)
		.map((line, index) =>
			normalizeReadLedgerRecord(JSON.parse(line), index + 1),
		);
}

export async function handleWorkflowArtifactToolCall(
	params: unknown,
	config: WorkflowArtifactToolConfig,
): Promise<WorkflowArtifactToolResult> {
	const input = normalizeToolInput(params);
	const runDir = resolve(
		config.runDir ?? inferRunDirFromManifestPath(resolve(config.manifestPath)),
	);
	const manifest = await loadWorkflowSourceManifest(config.manifestPath, {
		runDir,
	});
	if (manifest.runId !== config.runId)
		throw new Error(
			`source manifest runId mismatch: expected ${config.runId}, got ${manifest.runId}`,
		);
	if (manifest.taskId !== config.taskId)
		throw new Error(
			`source manifest taskId mismatch: expected ${config.taskId}, got ${manifest.taskId}`,
		);
	const accessMode =
		config.accessMode ?? manifest.policy?.accessMode ?? "workflow-task";

	if (input.action === "list") {
		const result = {
			runId: manifest.runId,
			taskId: manifest.taskId,
			sources: listWorkflowArtifactSources(manifest, { accessMode }),
		};
		return {
			content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			details: {
				action: "list",
				runId: manifest.runId,
				taskId: manifest.taskId,
				sourceCount: result.sources.length,
			},
		};
	}

	if (!input.source) throw new Error("workflow_artifact read requires source");
	if (!input.artifact)
		throw new Error("workflow_artifact read requires artifact");
	const read = await readWorkflowArtifact(
		manifest,
		input.source,
		input.artifact,
		{
			accessMode,
			maxBytes: config.maxBytes,
			maxLines: config.maxLines,
			runDir,
		},
	);
	await appendWorkflowArtifactReadLedger(config.ledgerPath, {
		schema: WORKFLOW_ARTIFACT_READ_SCHEMA,
		runId: config.runId,
		taskId: config.taskId,
		source: read.source,
		artifact: read.artifact,
		at: new Date().toISOString(),
		bytes: read.bytes,
		returnedBytes: read.returnedBytes,
		truncated: read.truncated,
	});
	const truncation = read.truncated
		? `\n\n[workflow_artifact output truncated: returned ${read.returnedBytes} of ${read.bytes} bytes.]`
		: "";
	return {
		content: [
			{
				type: "text",
				text: `# workflow_artifact: ${read.source}.${read.artifact}\n\n${read.content}${truncation}`,
			},
		],
		details: {
			action: "read",
			runId: config.runId,
			taskId: config.taskId,
			source: read.source,
			artifact: read.artifact,
			bytes: read.bytes,
			returnedBytes: read.returnedBytes,
			truncated: read.truncated,
			mediaType: read.mediaType,
		},
	};
}

export function inferRunDirFromManifestPath(manifestPath: string): string {
	return resolve(dirname(resolve(manifestPath)), "..", "..");
}

function normalizeReadLedgerRecord(
	value: unknown,
	lineNumber: number,
): WorkflowArtifactReadLedgerRecord {
	if (!isRecord(value))
		throw new Error(`read ledger line ${lineNumber} must be an object`);
	if (value.schema !== WORKFLOW_ARTIFACT_READ_SCHEMA)
		throw new Error(`read ledger line ${lineNumber} has unsupported schema`);
	const runId = requiredString(value.runId, `line ${lineNumber}.runId`);
	const taskId = requiredString(value.taskId, `line ${lineNumber}.taskId`);
	const source = requiredString(value.source, `line ${lineNumber}.source`);
	validateSourceName(source, `line ${lineNumber}.source`);
	const artifact = requiredString(
		value.artifact,
		`line ${lineNumber}.artifact`,
	);
	assertArtifactKind(artifact, `line ${lineNumber}.artifact`);
	const at = requiredString(value.at, `line ${lineNumber}.at`);
	const bytes = requiredNumber(value.bytes, `line ${lineNumber}.bytes`);
	const returnedBytes = requiredNumber(
		value.returnedBytes,
		`line ${lineNumber}.returnedBytes`,
	);
	const truncated = requiredBoolean(
		value.truncated,
		`line ${lineNumber}.truncated`,
	);
	return {
		schema: WORKFLOW_ARTIFACT_READ_SCHEMA,
		runId,
		taskId,
		source,
		artifact,
		at,
		bytes,
		returnedBytes,
		truncated,
	};
}

function normalizeToolInput(
	value: unknown,
):
	| { action: "list"; source?: string; artifact?: string }
	| { action: "read"; source?: string; artifact?: string } {
	if (!isRecord(value))
		throw new Error("workflow_artifact input must be an object");
	const action = requiredString(value.action, "action");
	if (action !== "list" && action !== "read")
		throw new Error("workflow_artifact action must be list or read");
	const source = optionalString(value.source, "source");
	const artifact = optionalString(value.artifact, "artifact");
	if (source !== undefined) validateSourceName(source, "source");
	if (artifact !== undefined) assertArtifactKind(artifact, "artifact");
	return { action, source, artifact };
}

function normalizePolicy(
	value: unknown,
): WorkflowSourceManifest["policy"] | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value))
		throw new Error("source manifest policy must be an object");
	const accessMode = optionalString(value.accessMode, "policy.accessMode");
	if (
		accessMode !== undefined &&
		accessMode !== "workflow-task" &&
		accessMode !== "human-debug"
	) {
		throw new Error("policy.accessMode must be workflow-task or human-debug");
	}
	const debugArtifacts =
		value.debugArtifacts === undefined
			? undefined
			: requiredBoolean(value.debugArtifacts, "policy.debugArtifacts");
	return accessMode || debugArtifacts !== undefined
		? {
				accessMode: accessMode as WorkflowArtifactAccessMode | undefined,
				debugArtifacts,
			}
		: undefined;
}

function resolveArtifactPath(
	path: string,
	runDir: string,
	options: { field: string },
): string {
	if (!isAbsolute(path)) throw new Error(`${options.field} must be absolute`);
	const absolutePath = resolve(path);
	if (!isInsidePath(resolve(runDir), absolutePath))
		throw new Error(
			`${options.field} must be inside the workflow run directory`,
		);
	return absolutePath;
}

function validateSourceName(value: string, field: string): void {
	if (!SOURCE_NAME_PATTERN.test(value) || value.includes(".."))
		throw new Error(
			`${field} must be a canonical workflow artifact source name`,
		);
}

function assertArtifactKind(
	value: string,
	field: string,
): asserts value is WorkflowArtifactKind {
	if (!WORKFLOW_ARTIFACT_KIND_SET.has(value))
		throw new Error(
			`${field} must be one of: ${WORKFLOW_ARTIFACT_KINDS.join(", ")}`,
		);
}

function isInsidePath(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function readUtf8Prefix(path: string, maxBytes: number): Promise<string> {
	if (maxBytes <= 0) return "";
	const file = await open(path, "r");
	try {
		const buffer = Buffer.alloc(maxBytes);
		const { bytesRead } = await file.read(buffer, 0, maxBytes, 0);
		return buffer.subarray(0, bytesRead).toString("utf8");
	} finally {
		await file.close();
	}
}

function truncateHead(
	text: string,
	options: { maxBytes: number; maxLines: number },
): { content: string; truncated: boolean } {
	const lines = text.split(/\r?\n/);
	let content =
		lines.length > options.maxLines
			? lines.slice(0, options.maxLines).join("\n")
			: text;
	let truncated = content !== text;
	if (Buffer.byteLength(content, "utf8") > options.maxBytes) {
		content = truncateToUtf8Bytes(content, options.maxBytes);
		truncated = true;
	}
	return { content, truncated };
}

function truncateToUtf8Bytes(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	let low = 0;
	let high = text.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) low = mid;
		else high = mid - 1;
	}
	return text.slice(0, low);
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0)
		throw new Error(`${field} must be a non-empty string`);
	return value;
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`${field} must be a string`);
	return value;
}

function optionalStringArray(
	value: unknown,
	field: string,
): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
	for (const [index, item] of value.entries()) {
		if (typeof item !== "string")
			throw new Error(`${field}[${index}] must be a string`);
	}
	return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
	return value;
}

function requiredNumber(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value))
		throw new Error(`${field} must be a finite number`);
	return value;
}

function requiredBoolean(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
	return value;
}
