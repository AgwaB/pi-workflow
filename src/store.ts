import { AsyncLocalStorage } from "node:async_hooks";
import { constants as fsConstants, type Stats } from "node:fs";
import {
	cp,
	link,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	stat,
	unlink,
	utimes,
	writeFile,
	type FileHandle,
} from "node:fs/promises";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	normalize,
	relative,
	resolve,
	sep,
} from "node:path";
import { createHash, randomBytes } from "node:crypto";

import { parseWorkflow } from "./schema.js";
import {
	type CompiledWorkflow,
	type CompiledTask,
	type CompiledLoopStageRecord,
	WORKFLOW_RUN_TYPE,
	type WorkflowIndexRecord,
	type WorkflowRunDegradation,
	type WorkflowRunLaunchCapture,
	type WorkflowRunLaunchCommandMetadata,
	type WorkflowRunLaunchMetadata,
	type WorkflowRunProvenance,
	type WorkflowRunRecord,
	type WorkflowRunStatus,
	type WorkflowRunUsageRollup,
	type WorkflowSupervisorRecord,
	type WorkflowTaskRunRecord,
	type WorkflowTaskResumeEvent,
	type TaskRunStatus,
	type TaskSummary,
} from "./types.js";
import { buildWorkflowRunMetrics } from "./workflow-metrics.js";
import { assertUniqueRunTaskIds } from "./foreach-batch-runtime.js";

const TERMINAL_INDEX_LIMIT = 50;
export const LEASE_STALE_MS = 30_000;
export const FAIL_FAST_CANCELLED_STATUS_DETAIL = "fail_fast_cancelled";
const LEASE_ABSOLUTE_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const INDEX_LOCK_WAIT_MS = 5_000;
const INDEX_LOCK_RETRY_MS = 50;
const DEFAULT_INDEX_UPDATE_DEBOUNCE_MS = 500;
const RUN_FILE_LEASE_RELEASE_RETRY_DELAYS_MS = [0, 10, 25] as const;
let indexUpdateDebounceMs = DEFAULT_INDEX_UPDATE_DEBOUNCE_MS;
const pendingIndexUpdates = new Map<
	string,
	{ cwd: string; runIds: Set<string>; timer: ReturnType<typeof setTimeout> }
>();
const runLeaseContext = new AsyncLocalStorage<{
	cwd: string;
	runId: string;
	ownerId: string;
	abortSignal: AbortSignal;
	abortLease: (error: unknown) => void;
}>();
type RunLeaseTestHooks = {
	heartbeatIntervalMs?: number;
	onAfterReclaimRename?: (context: {
		lockFile: string;
		reclaimFile: string;
	}) => void | Promise<void>;
	onBeforeRestoreReclaimFile?: (context: {
		lockFile: string;
		reclaimFile: string;
	}) => void | Promise<void>;
	onBeforeReleaseLockRename?: (context: {
		lockFile: string;
		releaseFile: string;
		ownerId: string;
	}) => void | Promise<void>;
	onBeforeHeartbeat?: (context: {
		cwd: string;
		runId: string;
		name: string;
		initial: boolean;
	}) => void | Promise<void>;
	onBeforeAtomicRename?: (context: { file: string }) => void | Promise<void>;
	onBeforeExclusiveLink?: (context: { file: string }) => void | Promise<void>;
	onAfterAtomicRename?: (context: {
		file: string;
		abortLease: (error: unknown) => void;
	}) => void | Promise<void>;
	onBeforeLeaseOwnershipCheck?: (context: {
		cwd: string;
		runId: string;
		ownerId: string;
	}) => void | Promise<void>;
};
let runLeaseTestHooks: RunLeaseTestHooks = {};
type RunProgressSnapshot = {
	lastTaskTransitionAt?: string;
	taskStatusCounts?: TaskSummary;
};
// In-memory per-(cwd,runId) task-progress registry. Heartbeats and run-record
// writes happen in the same supervisor process, so writeRunRecord stamps a
// transition timestamp here whenever any task status changes and the run-lease
// heartbeat mirrors it into supervisor.json.
const runProgressByRun = new Map<
	string,
	RunProgressSnapshot & { taskStatuses: Map<string, TaskRunStatus> }
>();
const TASK_STATUSES: Array<keyof Omit<TaskSummary, "total">> = [
	"pending",
	"running",
	"blocked",
	"completed",
	"failed",
	"skipped",
	"interrupted",
];

export function nowIso(): string {
	return new Date().toISOString();
}

export function makeRunId(): string {
	return `workflow_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
}

export function assertSafeRunId(runId: string): void {
	if (
		typeof runId !== "string" ||
		runId.length === 0 ||
		runId === "." ||
		runId === ".." ||
		runId.includes("/") ||
		runId.includes("\\") ||
		runId.includes("\0") ||
		isAbsolute(runId) ||
		basename(runId) !== runId
	) {
		throw new Error(`Invalid workflow run id: ${String(runId)}`);
	}
}

function isSafeRunId(runId: unknown): runId is string {
	try {
		assertSafeRunId(runId as string);
		return true;
	} catch {
		return false;
	}
}

export function workflowsRoot(cwd: string): string {
	return join(cwd, ".pi", "workflows");
}

export function workflowRunDir(cwd: string, runId: string): string {
	assertSafeRunId(runId);
	return join(workflowsRoot(cwd), runId);
}

export function workflowRunPath(cwd: string, runId: string): string {
	return join(workflowRunDir(cwd, runId), "run.json");
}

export function workflowStopIntentPath(cwd: string, runId: string): string {
	return join(workflowRunDir(cwd, runId), "stop-intent.json");
}

export function workflowIndexPath(cwd: string): string {
	return join(workflowsRoot(cwd), "index.json");
}

export function compiledWorkflowPath(cwd: string, runId: string): string {
	return join(workflowRunDir(cwd, runId), "compiled.json");
}

export function supervisorPath(cwd: string, runId: string): string {
	return join(workflowRunDir(cwd, runId), "supervisor.json");
}

const WORKFLOW_LAUNCH_COMMAND_ARTIFACT = "launch-command.txt" as const;
const NOFOLLOW_DIRECTORY_FLAGS =
	fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;

type WorkflowLaunchArtifactTestHooks = {
	onAfterReadOpen?: (context: {
		artifactPath: string;
	}) => void | Promise<void>;
	onBeforeWriteRename?: (context: {
		artifactPath: string;
		tempPath: string;
	}) => void | Promise<void>;
	onAfterWriteRename?: (context: {
		artifactPath: string;
	}) => void | Promise<void>;
};

let workflowLaunchArtifactTestHooks: WorkflowLaunchArtifactTestHooks = {};

export function setWorkflowLaunchArtifactTestHooksForTests(
	hooks: WorkflowLaunchArtifactTestHooks = {},
): void {
	workflowLaunchArtifactTestHooks = hooks;
}

type PhysicalWorkflowLaunchRunDirectory = {
	piPath: string;
	rootPath: string;
	runPath: string;
	piStat: Stats;
	rootStat: Stats;
	runStat: Stats;
	rootHandle: FileHandle;
	runHandle: FileHandle;
};

function unsafeWorkflowLaunchArtifactPath(): Error {
	return new Error("Unsafe workflow launch artifact path");
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

async function ensurePhysicalDirectoryComponent(
	path: string,
	mode?: number,
): Promise<Stats> {
	try {
		await mkdir(path, mode === undefined ? undefined : { mode });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const entry = await lstat(path);
	if (entry.isSymbolicLink() || !entry.isDirectory())
		throw unsafeWorkflowLaunchArtifactPath();
	return entry;
}

async function existingPhysicalDirectoryComponent(path: string): Promise<Stats> {
	const entry = await lstat(path);
	if (entry.isSymbolicLink() || !entry.isDirectory())
		throw unsafeWorkflowLaunchArtifactPath();
	return entry;
}

async function assertPhysicalWorkflowLaunchRunDirectory(
	directory: PhysicalWorkflowLaunchRunDirectory,
	requirePrivateMode = true,
): Promise<void> {
	const [piStat, rootStat, runStat, rootHandleStat, runHandleStat, rootReal, runReal] =
		await Promise.all([
			lstat(directory.piPath),
			lstat(directory.rootPath),
			lstat(directory.runPath),
			directory.rootHandle.stat(),
			directory.runHandle.stat(),
			realpath(directory.rootPath),
			realpath(directory.runPath),
		]);
	if (
		piStat.isSymbolicLink() ||
		rootStat.isSymbolicLink() ||
		runStat.isSymbolicLink() ||
		!piStat.isDirectory() ||
		!rootStat.isDirectory() ||
		!runStat.isDirectory() ||
		!rootHandleStat.isDirectory() ||
		!runHandleStat.isDirectory() ||
		!sameFileIdentity(directory.piStat, piStat) ||
		!sameFileIdentity(directory.rootStat, rootStat) ||
		!sameFileIdentity(directory.runStat, runStat) ||
		!sameFileIdentity(rootStat, rootHandleStat) ||
		!sameFileIdentity(runStat, runHandleStat) ||
		rootReal !== directory.rootPath ||
		runReal !== directory.runPath ||
		dirname(runReal) !== rootReal ||
		(requirePrivateMode && (runHandleStat.mode & 0o777) !== 0o700)
	) {
		throw unsafeWorkflowLaunchArtifactPath();
	}
}

async function openPhysicalWorkflowLaunchRunDirectory(
	cwd: string,
	runId: string,
	create: boolean,
): Promise<PhysicalWorkflowLaunchRunDirectory> {
	assertSafeRunId(runId);
	const physicalCwd = await realpath(resolve(cwd));
	const piPath = join(physicalCwd, ".pi");
	const rootPath = join(piPath, "workflows");
	const runPath = join(rootPath, runId);
	const directoryComponent = create
		? ensurePhysicalDirectoryComponent
		: existingPhysicalDirectoryComponent;
	const piStat = await directoryComponent(piPath);
	await directoryComponent(rootPath);
	const initialRunStat = await directoryComponent(
		runPath,
		create ? 0o700 : undefined,
	);
	let rootHandle: FileHandle | undefined;
	let runHandle: FileHandle | undefined;
	try {
		rootHandle = await open(rootPath, NOFOLLOW_DIRECTORY_FLAGS);
		runHandle = await open(runPath, NOFOLLOW_DIRECTORY_FLAGS);
		const directory: PhysicalWorkflowLaunchRunDirectory = {
			piPath,
			rootPath,
			runPath,
			piStat,
			rootStat: await rootHandle.stat(),
			runStat: initialRunStat,
			rootHandle,
			runHandle,
		};
		// Establish physical containment before mutating permissions. This prevents
		// a swapped parent from being chmodded before its identity is verified.
		await assertPhysicalWorkflowLaunchRunDirectory(directory, false);
		if (create) {
			await runHandle.chmod(0o700);
			directory.runStat = await runHandle.stat();
		}
		await assertPhysicalWorkflowLaunchRunDirectory(directory);
		return directory;
	} catch (error) {
		await runHandle?.close().catch(() => undefined);
		await rootHandle?.close().catch(() => undefined);
		throw error;
	}
}

async function closePhysicalWorkflowLaunchRunDirectory(
	directory: PhysicalWorkflowLaunchRunDirectory | undefined,
): Promise<void> {
	if (!directory) return;
	await directory.runHandle.close().catch(() => undefined);
	await directory.rootHandle.close().catch(() => undefined);
}

async function assertLaunchArtifactReplaceable(
	artifactPath: string,
): Promise<void> {
	try {
		const artifactStat = await lstat(artifactPath);
		if (artifactStat.isSymbolicLink() || !artifactStat.isFile())
			throw unsafeWorkflowLaunchArtifactPath();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

async function syncDirectoryHandle(directory: FileHandle): Promise<void> {
	try {
		await directory.sync();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EPERM")
			throw error;
	}
}

async function removeOwnedLaunchArtifact(
	directory: PhysicalWorkflowLaunchRunDirectory,
	path: string,
	identity: Stats,
): Promise<void> {
	try {
		await assertPhysicalWorkflowLaunchRunDirectory(directory);
		const current = await lstat(path);
		if (
			current.isFile() &&
			!current.isSymbolicLink() &&
			sameFileIdentity(current, identity)
		)
			await unlink(path);
	} catch {
		// A failed containment check must never turn cleanup into an unrelated unlink.
	}
}

export async function prepareWorkflowLaunchCommandArtifactPath(
	cwd: string,
	runId: string,
): Promise<void> {
	let directory: PhysicalWorkflowLaunchRunDirectory | undefined;
	try {
		directory = await openPhysicalWorkflowLaunchRunDirectory(cwd, runId, true);
		await assertLaunchArtifactReplaceable(
			join(directory.runPath, WORKFLOW_LAUNCH_COMMAND_ARTIFACT),
		);
	} finally {
		await closePhysicalWorkflowLaunchRunDirectory(directory);
	}
}

export async function writeWorkflowLaunchCommandArtifact(
	cwd: string,
	runId: string,
	text: string,
): Promise<Extract<WorkflowRunLaunchCommandMetadata, { state: "captured" }>> {
	assertSafeRunId(runId);
	if (typeof text !== "string")
		throw new Error("Invalid workflow launch command capture");
	const bytes = Buffer.from(text, "utf8");
	let directory: PhysicalWorkflowLaunchRunDirectory | undefined;
	let file: FileHandle | undefined;
	let fileStat: Stats | undefined;
	let tempPath = "";
	let committed = false;
	let verified = false;
	try {
		directory = await openPhysicalWorkflowLaunchRunDirectory(cwd, runId, true);
		const artifactPath = join(
			directory.runPath,
			WORKFLOW_LAUNCH_COMMAND_ARTIFACT,
		);
		await assertLaunchArtifactReplaceable(artifactPath);
		tempPath = `${artifactPath}.${randomBytes(12).toString("hex")}.tmp`;
		file = await open(
			tempPath,
			fsConstants.O_WRONLY |
				fsConstants.O_CREAT |
				fsConstants.O_EXCL |
				fsConstants.O_NOFOLLOW,
			0o600,
		);
		await file.chmod(0o600);
		await assertPhysicalWorkflowLaunchRunDirectory(directory);
		await file.writeFile(bytes);
		await file.sync();
		fileStat = await file.stat();
		if (
			!fileStat.isFile() ||
			fileStat.nlink !== 1 ||
			(fileStat.mode & 0o777) !== 0o600 ||
			fileStat.size !== bytes.byteLength
		)
			throw unsafeWorkflowLaunchArtifactPath();
		await assertPhysicalWorkflowLaunchRunDirectory(directory);
		await workflowLaunchArtifactTestHooks.onBeforeWriteRename?.({
			artifactPath,
			tempPath,
		});
		await assertPhysicalWorkflowLaunchRunDirectory(directory);
		const preRenameStat = await file.stat();
		if (
			!sameFileIdentity(fileStat, preRenameStat) ||
			!preRenameStat.isFile() ||
			preRenameStat.nlink !== 1 ||
			(preRenameStat.mode & 0o777) !== 0o600 ||
			preRenameStat.size !== bytes.byteLength
		)
			throw unsafeWorkflowLaunchArtifactPath();
		await assertLaunchArtifactReplaceable(artifactPath);
		await rename(tempPath, artifactPath);
		committed = true;
		await workflowLaunchArtifactTestHooks.onAfterWriteRename?.({
			artifactPath,
		});
		await assertPhysicalWorkflowLaunchRunDirectory(directory);
		const committedHandleStat = await file.stat();
		const committedStat = await lstat(artifactPath);
		if (
			committedStat.isSymbolicLink() ||
			!committedStat.isFile() ||
			!sameFileIdentity(fileStat, committedHandleStat) ||
			!sameFileIdentity(fileStat, committedStat) ||
			committedHandleStat.nlink !== 1 ||
			committedStat.nlink !== 1 ||
			(committedHandleStat.mode & 0o777) !== 0o600 ||
			(committedStat.mode & 0o777) !== 0o600 ||
			committedHandleStat.size !== bytes.byteLength ||
			committedStat.size !== bytes.byteLength
		)
			throw unsafeWorkflowLaunchArtifactPath();
		await syncDirectoryHandle(directory.runHandle);
		await assertPhysicalWorkflowLaunchRunDirectory(directory);
		const finalHandleStat = await file.stat();
		const finalPathStat = await lstat(artifactPath);
		if (
			!sameFileIdentity(fileStat, finalHandleStat) ||
			!sameFileIdentity(fileStat, finalPathStat) ||
			finalHandleStat.nlink !== 1 ||
			finalPathStat.nlink !== 1
		)
			throw unsafeWorkflowLaunchArtifactPath();
		verified = true;
		return {
			state: "captured",
			artifact: WORKFLOW_LAUNCH_COMMAND_ARTIFACT,
			encoding: "utf-8",
			bytes: bytes.byteLength,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			fidelity: "pi-extension-command-v1",
			sensitivity: "user-input",
			disclosure: "explicit-only",
		};
	} finally {
		if (!verified && file) {
			await file.truncate(0).catch(() => undefined);
			await file.sync().catch(() => undefined);
		}
		await file?.close().catch(() => undefined);
		if (!verified && directory && fileStat) {
			await removeOwnedLaunchArtifact(
				directory,
				committed
					? join(directory.runPath, WORKFLOW_LAUNCH_COMMAND_ARTIFACT)
					: tempPath,
				fileStat,
			);
		}
		await closePhysicalWorkflowLaunchRunDirectory(directory);
	}
}

function workflowLaunchArtifactReadError(error: unknown): Error {
	const code = (error as NodeJS.ErrnoException).code;
	if (code === "ENOENT")
		return new Error("launch command unavailable: artifact missing");
	if (
		code === "ELOOP" ||
		(error instanceof Error &&
			error.message === "Unsafe workflow launch artifact path")
	)
		return new Error("launch command unavailable: verification failed");
	return new Error("launch command unavailable: artifact read failed");
}

export async function readWorkflowLaunchCommandArtifact(
	cwd: string,
	run: Pick<WorkflowRunRecord, "runId" | "launch">,
): Promise<string> {
	assertSafeRunId(run.runId);
	if (!isWorkflowRunLaunchMetadata(run.launch))
		throw new Error("launch command unavailable: metadata malformed");
	if (run.launch.command.state !== "captured")
		throw new Error("launch command unavailable: tool launch");
	const command = run.launch.command;
	let directory: PhysicalWorkflowLaunchRunDirectory | undefined;
	let file: FileHandle | undefined;
	try {
		directory = await openPhysicalWorkflowLaunchRunDirectory(
			cwd,
			run.runId,
			false,
		);
		const artifactPath = join(
			directory.runPath,
			WORKFLOW_LAUNCH_COMMAND_ARTIFACT,
		);
		file = await open(
			artifactPath,
			fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
		);
		const openedStat = await file.stat();
		if (
			!openedStat.isFile() ||
			openedStat.nlink !== 1 ||
			(openedStat.mode & 0o777) !== 0o600 ||
			openedStat.size !== command.bytes
		)
			throw unsafeWorkflowLaunchArtifactPath();
		await workflowLaunchArtifactTestHooks.onAfterReadOpen?.({ artifactPath });
		await assertPhysicalWorkflowLaunchRunDirectory(directory);
		const bytes = await file.readFile();
		const readStat = await file.stat();
		await assertPhysicalWorkflowLaunchRunDirectory(directory);
		const currentStat = await lstat(artifactPath);
		if (
			!sameFileIdentity(openedStat, readStat) ||
			!sameFileIdentity(openedStat, currentStat) ||
			currentStat.isSymbolicLink() ||
			!currentStat.isFile() ||
			readStat.nlink !== 1 ||
			currentStat.nlink !== 1 ||
			(readStat.mode & 0o777) !== 0o600 ||
			readStat.size !== command.bytes
		)
			throw unsafeWorkflowLaunchArtifactPath();
		const digest = createHash("sha256").update(bytes).digest("hex");
		if (bytes.byteLength !== command.bytes || digest !== command.sha256)
			throw unsafeWorkflowLaunchArtifactPath();
		return bytes.toString("utf8");
	} catch (error) {
		if (
			error instanceof Error &&
			error.message.startsWith("launch command unavailable:")
		)
			throw error;
		throw workflowLaunchArtifactReadError(error);
	} finally {
		await file?.close().catch(() => undefined);
		await closePhysicalWorkflowLaunchRunDirectory(directory);
	}
}

export function isWorkflowRunLaunchMetadata(
	value: unknown,
): value is WorkflowRunLaunchMetadata {
	if (
		!isPlainRecordWithKeys(value, [
			"schema",
			"source",
			"requestKind",
			"routingMode",
			"profile",
			"task",
			"command",
		])
	)
		return false;
	if (value.schema !== "pi-workflow-run-launch-v1") return false;
	if (!isWorkflowLaunchSource(value.source)) return false;
	if (
		value.requestKind !== "named-workflow" &&
		value.requestKind !== "direct-dynamic"
	)
		return false;
	if (
		value.routingMode !== "default-on" &&
		value.routingMode !== "explicit-on" &&
		value.routingMode !== "off"
	)
		return false;
	if (!isWorkflowLaunchProfile(value.profile)) return false;
	if (!isWorkflowLaunchTask(value.task)) return false;
	if (!isWorkflowLaunchMetadataCommand(value.command)) return false;
	return isWorkflowLaunchSemanticCombination(value);
}

export function assertValidWorkflowRunLaunchCapture(
	value: unknown,
): asserts value is WorkflowRunLaunchCapture {
	if (!isWorkflowRunLaunchCapture(value))
		throw new Error("Invalid workflow launch metadata");
}

function isWorkflowRunLaunchCapture(
	value: unknown,
): value is WorkflowRunLaunchCapture {
	if (
		!isPlainRecordWithKeys(value, [
			"schema",
			"source",
			"requestKind",
			"routingMode",
			"profile",
			"task",
			"command",
		])
	)
		return false;
	if (value.schema !== "pi-workflow-run-launch-v1") return false;
	if (!isWorkflowLaunchSource(value.source)) return false;
	if (
		value.requestKind !== "named-workflow" &&
		value.requestKind !== "direct-dynamic"
	)
		return false;
	if (
		value.routingMode !== "default-on" &&
		value.routingMode !== "explicit-on" &&
		value.routingMode !== "off"
	)
		return false;
	if (!isWorkflowLaunchProfile(value.profile)) return false;
	if (!isWorkflowLaunchTask(value.task)) return false;
	if (
		!isPlainRecordWithKeys(value.command, ["state", "text"]) &&
		!isPlainRecordWithKeys(value.command, ["state", "reason"])
	)
		return false;
	if (
		value.command.state === "captured"
			? typeof value.command.text !== "string"
			: value.command.state !== "unavailable" ||
				value.command.reason !== "not-a-command"
	)
		return false;
	return isWorkflowLaunchSemanticCombination(value);
}

function isWorkflowLaunchSource(value: unknown): boolean {
	if (isPlainRecordWithKeys(value, ["kind", "action"]))
		return (
			value.kind === "slash-command" &&
			(value.action === "run" || value.action === "dynamic")
		);
	if (isPlainRecordWithKeys(value, ["kind", "name"]))
		return (
			value.kind === "tool" &&
			(value.name === "workflow_run" || value.name === "workflow_dynamic")
		);
	return false;
}

function isWorkflowLaunchProfile(value: unknown): boolean {
	if (isPlainRecordWithKeys(value, ["kind"]))
		return value.kind === "base" || value.kind === "not-applicable";
	return (
		isPlainRecordWithKeys(value, ["kind", "name"]) &&
		value.kind === "named" &&
		typeof value.name === "string" &&
		value.name.length > 0
	);
}

function isWorkflowLaunchTask(value: unknown): boolean {
	return (
		isPlainRecordWithKeys(value, ["characters", "lines"]) &&
		isNonNegativeSafeInteger(value.characters) &&
		isNonNegativeSafeInteger(value.lines)
	);
}

function isWorkflowLaunchMetadataCommand(value: unknown): boolean {
	if (isPlainRecordWithKeys(value, ["state", "reason"]))
		return value.state === "unavailable" && value.reason === "not-a-command";
	return (
		isPlainRecordWithKeys(value, [
			"state",
			"artifact",
			"encoding",
			"bytes",
			"sha256",
			"fidelity",
			"sensitivity",
			"disclosure",
		]) &&
		value.state === "captured" &&
		value.artifact === WORKFLOW_LAUNCH_COMMAND_ARTIFACT &&
		value.encoding === "utf-8" &&
		isNonNegativeSafeInteger(value.bytes) &&
		typeof value.sha256 === "string" &&
		/^[0-9a-f]{64}$/.test(value.sha256) &&
		value.fidelity === "pi-extension-command-v1" &&
		value.sensitivity === "user-input" &&
		value.disclosure === "explicit-only"
	);
}

function isWorkflowLaunchSemanticCombination(
	value: Record<string, unknown>,
): boolean {
	const source = value.source as Record<string, unknown>;
	const command = value.command as Record<string, unknown>;
	if (source.kind === "slash-command") {
		if (command.state !== "captured") return false;
		if (source.action === "run" && value.requestKind !== "named-workflow")
			return false;
		if (source.action === "dynamic" && value.requestKind !== "direct-dynamic")
			return false;
		if (source.action === "dynamic" && value.routingMode === "default-on")
			return false;
		return true;
	}
	if (command.state !== "unavailable" || value.routingMode !== "off")
		return false;
	if (source.name === "workflow_run")
		return (
			value.requestKind === "named-workflow" &&
			(value.profile as Record<string, unknown>).kind !== "not-applicable"
		);
	return (
		value.requestKind === "direct-dynamic" &&
		(value.profile as Record<string, unknown>).kind === "not-applicable"
	);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPlainRecordWithKeys(
	value: unknown,
	keys: readonly string[],
): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const actual = Object.keys(value);
	if (actual.length !== keys.length) return false;
	const expected = new Set(keys);
	return actual.every((key) => expected.has(key));
}

export function indexSupervisorErrorPath(cwd: string): string {
	return join(workflowsRoot(cwd), "supervisor-error.json");
}

export function taskDir(cwd: string, runId: string, taskId: string): string {
	return join(workflowRunDir(cwd, runId), "tasks", taskId);
}

export function managedWorktreePath(
	cwd: string,
	runId: string,
	taskId: string,
): string {
	return join(workflowRunDir(cwd, runId), "worktrees", taskId);
}

export function toProjectPath(cwd: string, filePath: string): string {
	return isAbsolute(filePath) ? relative(cwd, filePath) || "." : filePath;
}

export function fromProjectPath(cwd: string, filePath: string): string {
	return isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
}

export async function ensureDir(dir: string): Promise<void> {
	await assertLeaseContextOwnership();
	await mkdir(dir, { recursive: true });
}

export async function readJson<T>(file: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(file, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export async function writeJsonAtomic(
	file: string,
	value: unknown,
	abortSignal?: AbortSignal,
	commitFence?: () => void | Promise<void>,
): Promise<void> {
	const lease = runLeaseContext.getStore();
	const activeAbortSignal = abortSignal ?? lease?.abortSignal;
	assertLeaseNotAborted(activeAbortSignal);
	await assertLeaseContextOwnership(lease);
	await ensureDir(dirname(file));
	assertLeaseNotAborted(activeAbortSignal);
	await assertLeaseContextOwnership(lease);
	const temp = join(
		dirname(file),
		`.${Date.now().toString(36)}-${randomBytes(3).toString("hex")}.tmp`,
	);
	assertLeaseNotAborted(activeAbortSignal);
	await assertLeaseContextOwnership(lease);
	await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	assertLeaseNotAborted(activeAbortSignal);
	await assertLeaseContextOwnership(lease);
	await commitFence?.();
	await runLeaseTestHooks.onBeforeAtomicRename?.({ file });
	await assertLeaseContextOwnership(lease);
	await commitFence?.();
	assertLeaseNotAborted(activeAbortSignal);
	await rename(temp, file);
	if (lease) {
		await runLeaseTestHooks.onAfterAtomicRename?.({
			file,
			abortLease: lease.abortLease,
		});
	}
	assertLeaseNotAborted(activeAbortSignal);
}

export async function syncFileAndDirectory(file: string): Promise<void> {
	const fileHandle = await open(file, fsConstants.O_RDONLY);
	try {
		await fileHandle.sync();
	} finally {
		await fileHandle.close();
	}
	const directoryHandle = await open(dirname(file), fsConstants.O_RDONLY);
	try {
		await directoryHandle.sync();
	} finally {
		await directoryHandle.close();
	}
}

export async function writeJsonAtomicDurable(
	file: string,
	value: unknown,
	abortSignal?: AbortSignal,
	commitFence?: () => void | Promise<void>,
): Promise<void> {
	await writeJsonAtomic(file, value, abortSignal, commitFence);
	await syncFileAndDirectory(file);
}

export async function writeJsonExclusive(
	file: string,
	value: unknown,
	abortSignal?: AbortSignal,
	commitFence?: () => void | Promise<void>,
): Promise<boolean> {
	const lease = runLeaseContext.getStore();
	const activeAbortSignal = abortSignal ?? lease?.abortSignal;
	assertLeaseNotAborted(activeAbortSignal);
	await assertLeaseContextOwnership(lease);
	await ensureDir(dirname(file));
	const temp = join(
		dirname(file),
		`.${Date.now().toString(36)}-${randomBytes(6).toString("hex")}.tmp`,
	);
	try {
		await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
		});
		assertLeaseNotAborted(activeAbortSignal);
		await assertLeaseContextOwnership(lease);
		await commitFence?.();
		await runLeaseTestHooks.onBeforeExclusiveLink?.({ file });
		try {
			// link(2) is the commit: it atomically creates this epoch's immutable
			// receipt and can never replace a receipt committed by another owner.
			await link(temp, file);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw error;
		}
	} finally {
		await unlink(temp).catch(() => undefined);
	}
}

export interface WorkflowStopIntentRecord {
	schemaVersion: 1;
	runId: string;
	requestedAt: string;
	reason: "user";
}

export async function requestWorkflowStop(
	cwd: string,
	runId: string,
): Promise<WorkflowStopIntentRecord> {
	const intent: WorkflowStopIntentRecord = {
		schemaVersion: 1,
		runId,
		requestedAt: nowIso(),
		reason: "user",
	};
	await writeJsonAtomic(workflowStopIntentPath(cwd, runId), intent);
	return intent;
}

export async function readWorkflowStopIntent(
	cwd: string,
	runId: string,
): Promise<WorkflowStopIntentRecord | undefined> {
	const value = await readJson<Partial<WorkflowStopIntentRecord>>(
		workflowStopIntentPath(cwd, runId),
	);
	if (!value || value.schemaVersion !== 1 || value.runId !== runId)
		return undefined;
	return {
		schemaVersion: 1,
		runId,
		requestedAt:
			typeof value.requestedAt === "string" ? value.requestedAt : nowIso(),
		reason: "user",
	};
}

export async function clearWorkflowStopIntent(
	cwd: string,
	runId: string,
): Promise<void> {
	await unlink(workflowStopIntentPath(cwd, runId)).catch((error) => {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	});
}

export function setRunLeaseTestHooksForTests(hooks?: RunLeaseTestHooks): void {
	runLeaseTestHooks = hooks ?? {};
}

function runProgressKey(cwd: string, runId: string): string {
	return `${cwd}\0${runId}`;
}

function recordRunProgress(cwd: string, run: WorkflowRunRecord): void {
	const key = runProgressKey(cwd, run.runId);
	const taskStatuses = new Map(
		run.tasks.map((task) => [task.taskId, task.status]),
	);
	const taskStatusCounts: TaskSummary = { ...run.taskSummary };
	const previous = runProgressByRun.get(key);
	if (!previous) {
		// First write in this process establishes the baseline only; a
		// transition timestamp is recorded once a later write changes a status.
		runProgressByRun.set(key, { taskStatuses, taskStatusCounts });
		return;
	}
	const changed =
		taskStatuses.size !== previous.taskStatuses.size ||
		[...taskStatuses].some(
			([taskId, status]) => previous.taskStatuses.get(taskId) !== status,
		);
	runProgressByRun.set(key, {
		taskStatuses,
		taskStatusCounts,
		lastTaskTransitionAt: changed ? nowIso() : previous.lastTaskTransitionAt,
	});
}

export function runProgressSnapshot(
	cwd: string,
	runId: string,
): RunProgressSnapshot | undefined {
	const entry = runProgressByRun.get(runProgressKey(cwd, runId));
	if (!entry) return undefined;
	return {
		lastTaskTransitionAt: entry.lastTaskTransitionAt,
		taskStatusCounts: entry.taskStatusCounts,
	};
}

export interface RunFileLease {
	ownerId: string;
	signal: AbortSignal;
	assertOwner: () => Promise<void>;
	release: () => Promise<void>;
}

export async function acquireRunFileLease(
	cwd: string,
	runId: string,
	name: string,
	waitMs = 0,
	acquireSignal?: AbortSignal,
): Promise<RunFileLease | undefined> {
	assertSafeRunId(runId);
	if (!/^[a-z0-9-]+$/.test(name))
		throw new Error(`Unsafe run-file lease name: ${name}`);
	const dir = workflowRunDir(cwd, runId);
	await ensureDir(dir);
	const lockFile = join(dir, `${name}.lock`);
	const ownerId = `${process.pid}-${randomBytes(6).toString("hex")}`;
	const deadline = Date.now() + Math.max(0, waitMs);
	acquireSignal?.throwIfAborted();
	while (!(await acquireLock(lockFile, ownerId))) {
		acquireSignal?.throwIfAborted();
		if (Date.now() >= deadline) return undefined;
		await sleepWithSignal(
			Math.min(INDEX_LOCK_RETRY_MS, deadline - Date.now()),
			acquireSignal,
		);
	}
	if (acquireSignal?.aborted) {
		try {
			await releaseRunFileLockWithRetries(lockFile, ownerId);
		} catch (releaseError) {
			throw new AggregateError(
				[abortSignalError(acquireSignal), releaseError],
				`Failed to release cancelled run-file lease: ${lockFile}`,
			);
		}
		acquireSignal.throwIfAborted();
	}

	const abortController = new AbortController();
	let released = false;
	let releaseInFlight: Promise<void> | undefined;
	let heartbeatCount = 0;
	let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	let heartbeatInFlight: Promise<void> | undefined;
	const heartbeat = async (): Promise<void> => {
		const initial = heartbeatCount === 0;
		heartbeatCount += 1;
		await runLeaseTestHooks.onBeforeHeartbeat?.({
			cwd,
			runId,
			name,
			initial,
		});
		await assertLockOwner(lockFile, ownerId);
		const now = new Date();
		await utimes(lockFile, now, now);
		await assertLockOwner(lockFile, ownerId);
	};
	const runHeartbeat = (): Promise<void> => {
		const previous = heartbeatInFlight;
		const next = (async () => {
			if (previous) await previous;
			await heartbeat();
		})();
		heartbeatInFlight = next;
		void next.catch((error) => {
			if (!abortController.signal.aborted) abortController.abort(error);
		});
		return next;
	};
	const startHeartbeat = (): void => {
		if (released || heartbeatTimer) return;
		heartbeatTimer = setInterval(
			() => void runHeartbeat(),
			runLeaseHeartbeatIntervalMs(),
		);
		heartbeatTimer.unref?.();
	};
	try {
		await runHeartbeat();
	} catch (heartbeatError) {
		try {
			await releaseRunFileLockWithRetries(lockFile, ownerId);
		} catch (releaseError) {
			throw new AggregateError(
				[heartbeatError, releaseError],
				`Failed to initialize and release run-file lease: ${lockFile}`,
			);
		}
		throw heartbeatError;
	}
	startHeartbeat();

	return {
		ownerId,
		signal: abortController.signal,
		assertOwner: async () => {
			abortController.signal.throwIfAborted();
			await assertLockOwner(lockFile, ownerId);
			abortController.signal.throwIfAborted();
		},
		release: async () => {
			if (released) return;
			if (releaseInFlight) return releaseInFlight;
			const attempt = (async () => {
				if (heartbeatTimer) clearInterval(heartbeatTimer);
				heartbeatTimer = undefined;
				await heartbeatInFlight?.catch(() => undefined);
				heartbeatInFlight = undefined;
				try {
					await releaseRunFileLockWithRetries(lockFile, ownerId);
				} catch (error) {
					if (!abortController.signal.aborted) abortController.abort(error);
					throw error;
				} finally {
					released = true;
				}
			})();
			releaseInFlight = attempt;
			try {
				await attempt;
			} finally {
				if (releaseInFlight === attempt) releaseInFlight = undefined;
			}
		},
	};
}

export async function withRunLease<T>(
	cwd: string,
	runId: string,
	action: (abortSignal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
	assertSafeRunId(runId);
	const dir = workflowRunDir(cwd, runId);
	await ensureDir(dir);
	const lockFile = join(dir, "supervisor.lock");
	const ownerId = `${process.pid}-${randomBytes(3).toString("hex")}`;
	let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	let heartbeatInFlight: Promise<void> | undefined;
	const lock = await acquireLock(lockFile, ownerId);
	if (!lock) return undefined;
	let callerOutcomeSettled = false;
	try {
		const abortController = new AbortController();
		const abortLease = (error: unknown): void => {
			if (abortController.signal.aborted) return;
			abortController.abort(asLeaseError(error));
		};
		const supervisorFile = join(dir, "supervisor.json");
		// Progress fields written by a previous lease owner are carried forward so
		// short-lived lease holders (for example status refreshers in another
		// process) never erase the run's last known task-progress signal.
		const carriedProgress = await readJson<WorkflowSupervisorRecord>(
			supervisorFile,
		)
			.then(
				(record): RunProgressSnapshot => ({
					lastTaskTransitionAt: record?.lastTaskTransitionAt,
					taskStatusCounts: record?.taskStatusCounts,
				}),
			)
			.catch((): RunProgressSnapshot => ({}));
		let heartbeatCount = 0;
		const heartbeat = async (): Promise<void> => {
			const initial = heartbeatCount === 0;
			heartbeatCount += 1;
			await runLeaseTestHooks.onBeforeHeartbeat?.({
				cwd,
				runId,
				name: "run",
				initial,
			});
			assertLeaseNotAborted(abortController.signal);
			await assertLockOwner(lockFile, ownerId);
			const timestamp = nowIso();
			const now = new Date();
			await utimes(lockFile, now, now).catch((error: unknown) => {
				if ((error as NodeJS.ErrnoException).code === "ENOENT")
					throw new Error(`Lost supervisor lease: ${lockFile}`);
				throw error;
			});
			const progress = runProgressSnapshot(cwd, runId);
			const lastTaskTransitionAt =
				progress?.lastTaskTransitionAt ?? carriedProgress.lastTaskTransitionAt;
			const taskStatusCounts =
				progress?.taskStatusCounts ?? carriedProgress.taskStatusCounts;
			await assertLockOwner(lockFile, ownerId);
			await writeJsonAtomic(supervisorFile, {
				schemaVersion: 1,
				ownerId,
				pid: process.pid,
				updatedAt: timestamp,
				lockFile: toProjectPath(cwd, lockFile),
				...(lastTaskTransitionAt ? { lastTaskTransitionAt } : {}),
				...(taskStatusCounts ? { taskStatusCounts } : {}),
			});
		};
		const runHeartbeat = (): Promise<void> => {
			const previous = heartbeatInFlight;
			const next = (async () => {
				if (previous) await previous;
				await heartbeat();
			})();
			heartbeatInFlight = next;
			void next.catch(abortLease);
			return next;
		};

		await runHeartbeat();
		heartbeatTimer = setInterval(() => {
			void runHeartbeat();
		}, runLeaseHeartbeatIntervalMs());
		heartbeatTimer.unref?.();

		const result = await runLeaseContext.run(
			{
				cwd,
				runId,
				ownerId,
				abortSignal: abortController.signal,
				abortLease,
			},
			() => action(abortController.signal),
		);
		if (heartbeatTimer) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = undefined;
		}
		await heartbeatInFlight;
		assertLeaseNotAborted(abortController.signal);
		await assertLockOwner(lockFile, ownerId);
		assertLeaseNotAborted(abortController.signal);
		callerOutcomeSettled = true;
		return result;
	} catch (error) {
		// Cleanup must not replace the action's result or error. The release
		// helper still publishes an abandonment marker before bounded retries, so
		// a persistent cleanup failure leaves this live-PID lock reclaimable.
		callerOutcomeSettled = true;
		throw error;
	} finally {
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		heartbeatTimer = undefined;
		await heartbeatInFlight?.catch(() => undefined);
		heartbeatInFlight = undefined;
		try {
			await releaseRunFileLockWithRetries(lockFile, ownerId);
		} catch (releaseError) {
			if (!callerOutcomeSettled) throw releaseError;
		}
	}
}

function runLeaseHeartbeatIntervalMs(): number {
	return Math.max(
		1,
		Math.floor(
			runLeaseTestHooks.heartbeatIntervalMs ??
				Math.max(1000, Math.floor(LEASE_STALE_MS / 3)),
		),
	);
}

function assertLeaseNotAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortSignalError(signal);
}

function abortSignalError(signal: AbortSignal): Error {
	return asLeaseError((signal as AbortSignal & { reason?: unknown }).reason);
}

function asLeaseError(error: unknown): Error {
	if (error instanceof Error) return error;
	return new Error(
		error === undefined
			? "Lost supervisor lease"
			: `Lost supervisor lease: ${String(error)}`,
	);
}

async function acquireLock(
	lockFile: string,
	ownerId: string,
): Promise<boolean> {
	const tryCreate = async (): Promise<boolean> => {
		try {
			const handle = await open(lockFile, "wx");
			try {
				await handle.writeFile(
					`${ownerId}\n${process.pid}\n${nowIso()}\n`,
					"utf8",
				);
			} finally {
				await handle.close();
			}
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			return false;
		}
	};

	if (await tryCreate()) return true;
	if (await reclaimStaleLock(lockFile)) return tryCreate();
	return false;
}

async function reclaimStaleLock(lockFile: string): Promise<boolean> {
	const snapshot = await readLockSnapshot(lockFile);
	if (!snapshot) return true;
	const initialDecision = await lockReclaimDecision(lockFile, snapshot);
	if (!initialDecision.reclaimable) return false;

	const reclaimFile = `${lockFile}.reclaim-${process.pid}-${randomBytes(3).toString("hex")}`;
	try {
		await rename(lockFile, reclaimFile);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		return false;
	}
	await runLeaseTestHooks.onAfterReclaimRename?.({ lockFile, reclaimFile });

	const claimed = await readLockSnapshot(reclaimFile);
	if (!claimed) return true;
	if (!sameLockOwnerSnapshot(snapshot, claimed)) {
		await restoreReclaimFile(reclaimFile, lockFile);
		return false;
	}
	// A validated abandonment marker is a one-way declaration made only after
	// heartbeats stop. Latch that decision across rename: the releaser may see
	// the original path missing and clear the sidecar while this reclaim is in
	// flight, but restoring the quiesced live-PID lock would orphan it.
	if (!initialDecision.durablyAbandoned) {
		const claimedDecision = await lockReclaimDecision(lockFile, claimed);
		if (!claimedDecision.reclaimable) {
			await restoreReclaimFile(reclaimFile, lockFile);
			return false;
		}
	}

	await unlink(reclaimFile).catch(() => undefined);
	await clearRunFileLeaseAbandonment(lockFile, claimed.ownerId);
	return true;
}

async function restoreReclaimFile(
	reclaimFile: string,
	lockFile: string,
): Promise<void> {
	await runLeaseTestHooks.onBeforeRestoreReclaimFile?.({
		lockFile,
		reclaimFile,
	});
	try {
		await link(reclaimFile, lockFile);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new Error(
				`Could not restore reclaimed lock because another owner acquired ${lockFile}`,
				{ cause: error },
			);
		}
		throw error;
	}
	await unlink(reclaimFile).catch(() => undefined);
}

interface LockReclaimDecision {
	reclaimable: boolean;
	durablyAbandoned: boolean;
}

async function lockReclaimDecision(
	lockFile: string,
	snapshot: LockSnapshot,
): Promise<LockReclaimDecision> {
	if (await isRunFileLeaseDurablyAbandoned(lockFile, snapshot.ownerId))
		return { reclaimable: true, durablyAbandoned: true };
	const now = Date.now();
	const leaseStale = now - snapshot.mtimeMs > LEASE_STALE_MS;
	const absoluteStale =
		now - (snapshot.createdAtMs ?? snapshot.mtimeMs) > LEASE_ABSOLUTE_STALE_MS;
	if (!leaseStale) return { reclaimable: false, durablyAbandoned: false };
	if (
		snapshot.pid !== undefined &&
		isProcessAlive(snapshot.pid) &&
		!absoluteStale
	)
		return { reclaimable: false, durablyAbandoned: false };
	return { reclaimable: true, durablyAbandoned: false };
}

function runFileLeaseAbandonmentPath(
	lockFile: string,
	ownerId: string,
): string | undefined {
	return /^[a-zA-Z0-9-]+$/.test(ownerId)
		? `${lockFile}.abandoned-${ownerId}`
		: undefined;
}

async function markRunFileLeaseAbandoned(
	lockFile: string,
	ownerId: string,
): Promise<void> {
	const file = runFileLeaseAbandonmentPath(lockFile, ownerId);
	if (!file) throw new Error(`Unsafe run-file lease owner: ${ownerId}`);
	try {
		await writeFile(file, `${ownerId}\n`, { encoding: "utf8", flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		if ((await readFile(file, "utf8")) !== `${ownerId}\n`) throw error;
	}
}

async function isRunFileLeaseDurablyAbandoned(
	lockFile: string,
	ownerId: string,
): Promise<boolean> {
	const file = runFileLeaseAbandonmentPath(lockFile, ownerId);
	if (!file) return false;
	try {
		return (await readFile(file, "utf8")) === `${ownerId}\n`;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function clearRunFileLeaseAbandonment(
	lockFile: string,
	ownerId: string,
): Promise<void> {
	const file = runFileLeaseAbandonmentPath(lockFile, ownerId);
	if (file) await unlink(file).catch(() => undefined);
}

function sameLockOwnerSnapshot(
	left: LockSnapshot,
	right: LockSnapshot,
): boolean {
	return (
		left.ownerId === right.ownerId &&
		left.pid === right.pid &&
		left.createdAtMs === right.createdAtMs
	);
}

type LockSnapshot = {
	ownerId: string;
	pid?: number;
	mtimeMs: number;
	createdAtMs?: number;
};

async function readLockSnapshot(
	lockFile: string,
): Promise<LockSnapshot | undefined> {
	try {
		const [fileStat, text] = await Promise.all([
			stat(lockFile),
			readFile(lockFile, "utf8"),
		]);
		const [ownerId = "", pidText, createdAtText] = text.split(/\r?\n/);
		const pid = Number.parseInt(pidText ?? "", 10);
		const createdAtMs = Date.parse(createdAtText ?? "");
		return {
			ownerId,
			pid: Number.isFinite(pid) ? pid : undefined,
			mtimeMs: fileStat.mtimeMs,
			createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : undefined,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "EPERM";
	}
}

async function acquireLockWithWait(
	lockFile: string,
	ownerId: string,
): Promise<void> {
	const deadline = Date.now() + INDEX_LOCK_WAIT_MS;
	while (!(await acquireLock(lockFile, ownerId))) {
		if (Date.now() >= deadline)
			throw new Error(`Timed out waiting for lock: ${lockFile}`);
		await sleep(INDEX_LOCK_RETRY_MS);
	}
}

async function releaseRunFileLockWithRetries(
	lockFile: string,
	ownerId: string,
): Promise<void> {
	// Heartbeats are stopped before this function is called. Publish the exact
	// owner token before attempting the fallible rename so another process can
	// reclaim immediately if every release attempt fails while this PID lives.
	let abandonmentError: unknown;
	try {
		await markRunFileLeaseAbandoned(lockFile, ownerId);
	} catch (error) {
		abandonmentError = error;
	}
	let lastError: unknown;
	for (const delayMs of RUN_FILE_LEASE_RELEASE_RETRY_DELAYS_MS) {
		if (delayMs > 0) await sleep(delayMs);
		try {
			await releaseLock(lockFile, ownerId);
			await clearRunFileLeaseAbandonment(lockFile, ownerId);
			return;
		} catch (error) {
			lastError = error;
		}
	}
	if (abandonmentError)
		throw new AggregateError(
			[asLeaseError(lastError), abandonmentError],
			`Failed to release and durably abandon run-file lease: ${lockFile}`,
		);
	throw asLeaseError(lastError);
}

async function releaseLock(lockFile: string, ownerId: string): Promise<void> {
	const snapshot = await readLockSnapshot(lockFile);
	if (!snapshot || snapshot.ownerId !== ownerId) return;
	const releaseFile = `${lockFile}.release-${process.pid}-${randomBytes(3).toString("hex")}`;
	await runLeaseTestHooks.onBeforeReleaseLockRename?.({
		lockFile,
		releaseFile,
		ownerId,
	});
	try {
		await rename(lockFile, releaseFile);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	const claimed = await readLockSnapshot(releaseFile);
	if (!claimed) return;
	if (sameLockOwnerSnapshot(snapshot, claimed)) {
		await unlink(releaseFile).catch(() => undefined);
		return;
	}
	await restoreReclaimFile(releaseFile, lockFile);
}

async function assertLockOwner(
	lockFile: string,
	ownerId: string,
): Promise<void> {
	if (!(await ownsLock(lockFile, ownerId)))
		throw new Error(`Lost supervisor lease: ${lockFile}`);
}

async function ownsLock(lockFile: string, ownerId: string): Promise<boolean> {
	try {
		const [currentOwner] = (await readFile(lockFile, "utf8")).split(/\r?\n/);
		return currentOwner === ownerId;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export async function assertWorkflowRunAvailable(
	cwd: string,
	runId: string,
): Promise<void> {
	const runDir = workflowRunDir(cwd, runId);
	try {
		await stat(runDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	const entries = await readdir(runDir);
	const validStopIntent = await readWorkflowStopIntent(cwd, runId);
	const collisionEntries = entries.filter(
		(entry) =>
			entry !== "supervisor.lock" &&
			entry !== "supervisor.json" &&
			!(entry === "stop-intent.json" && validStopIntent !== undefined),
	);
	if (
		(!entries.includes("supervisor.lock") && validStopIntent === undefined) ||
		collisionEntries.length > 0
	) {
		throw new Error(
			`Cannot initialize workflow run ${runId}: a persisted run already exists`,
		);
	}
}

async function assertWorkflowRunDoesNotExist(
	cwd: string,
	runId: string,
): Promise<void> {
	const runDir = workflowRunDir(cwd, runId);
	try {
		await stat(runDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	throw new Error(`Workflow run directory already exists: ${runId}`);
}

export async function initializeRunRecordDirectories(
	cwd: string,
	run: WorkflowRunRecord,
): Promise<void> {
	const runDir = workflowRunDir(cwd, run.runId);
	await ensureDir(runDir);
	await ensureDir(join(runDir, "tasks"));
	if (run.dynamic) await ensureDir(join(runDir, "dynamic"));
}

export async function createRunRecord(
	cwd: string,
	compiled: CompiledWorkflow,
	specPath: string,
	options: {
		runId?: string;
		parentRunId?: string;
		rootRunId?: string;
		initialize?: boolean;
	} = {},
): Promise<{ run: WorkflowRunRecord; runDir: string }> {
	const runId = options.runId ?? makeRunId();
	assertSafeRunId(runId);
	const runDir = workflowRunDir(cwd, runId);
	const createdAt = nowIso();
	const tasks = compiled.tasks.map((task, index) =>
		createTaskRunRecord(cwd, runId, task, index),
	);
	const hasDynamicController = compiledWorkflowHasDynamicController(compiled);
	const run = deriveRunStatus({
		schemaVersion: 1,
		runId,
		name: compiled.name,
		description: compiled.description,
		type: compiled.type,
		artifactGraph: compiled.artifactGraph,
		status: "running",
		taskSummary: emptySummary(),
		cwd: compiled.cwd,
		backend: compiled.backend,
		...(compiled.failurePolicy
			? { failurePolicy: compiled.failurePolicy }
			: {}),
		...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
		...(options.rootRunId ? { rootRunId: options.rootRunId } : {}),
		...(hasDynamicController
			? {
					dynamic: {
						events: toProjectPath(cwd, join(runDir, "dynamic", "events.jsonl")),
						state: toProjectPath(cwd, join(runDir, "dynamic", "state.json")),
					},
				}
			: {}),
		createdAt,
		updatedAt: createdAt,
		specPath,
		tasks,
	});
	if (options.initialize !== false) {
		await assertWorkflowRunDoesNotExist(cwd, runId);
		await initializeRunRecordDirectories(cwd, run);
	}
	return { run, runDir };
}

function runUsageRollup(run: WorkflowRunRecord): WorkflowRunUsageRollup {
	const observed = buildWorkflowRunMetrics(run).totals.usage.observed;
	return {
		source: "task-rollup",
		capturedAt: nowIso(),
		taskCount: run.tasks.length,
		tasksReporting: observed.contributingTaskIds.length,
		...(observed.inputTokens === null
			? {}
			: { inputTokens: observed.inputTokens }),
		...(observed.outputTokens === null
			? {}
			: { outputTokens: observed.outputTokens }),
		...(observed.totalTokens === null
			? {}
			: { totalTokens: observed.totalTokens }),
		...(observed.cachedInputTokens === null
			? {}
			: { cachedInputTokens: observed.cachedInputTokens }),
		...(observed.cacheCreationInputTokens === null
			? {}
			: { cacheCreationInputTokens: observed.cacheCreationInputTokens }),
		...(observed.cacheReadInputTokens === null
			? {}
			: { cacheReadInputTokens: observed.cacheReadInputTokens }),
		...(observed.reasoningTokens === null
			? {}
			: { reasoningTokens: observed.reasoningTokens }),
		...(observed.costUsd === null ? {} : { costUsd: observed.costUsd }),
	};
}

export async function writeRunRecord(
	cwd: string,
	run: WorkflowRunRecord,
	abortSignal?: AbortSignal,
): Promise<void> {
	await assertActiveRunLease(cwd, run.runId, abortSignal);
	assertLeaseNotAborted(abortSignal);
	const runFile = workflowRunPath(cwd, run.runId);
	let firstWrite = false;
	try {
		await stat(runFile);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		firstWrite = true;
	}
	assertLeaseNotAborted(abortSignal);
	run.updatedAt = nowIso();
	const derived = deriveRunStatus(run);
	Object.assign(run, derived);
	if (isTerminalWorkflowStatus(run.status)) run.usage = runUsageRollup(run);
	await writeJsonAtomic(runFile, run, abortSignal);
	assertLeaseNotAborted(abortSignal);
	if (isTerminalWorkflowStatus(run.status))
		runProgressByRun.delete(runProgressKey(cwd, run.runId));
	else recordRunProgress(cwd, run);
	if (firstWrite || isTerminalWorkflowStatus(run.status)) {
		cancelScheduledIndexUpdate(cwd, run.runId);
		await updateIndex(cwd, run.runId, abortSignal);
		assertLeaseNotAborted(abortSignal);
	} else {
		scheduleIndexUpdate(cwd, run.runId);
	}
}

function indexUpdateKey(cwd: string): string {
	return resolve(cwd);
}

function cancelScheduledIndexUpdate(cwd: string, runId: string): void {
	const key = indexUpdateKey(cwd);
	const existing = pendingIndexUpdates.get(key);
	if (!existing) return;
	existing.runIds.delete(runId);
	if (existing.runIds.size > 0) return;
	clearTimeout(existing.timer);
	pendingIndexUpdates.delete(key);
}

function scheduleIndexUpdate(cwd: string, runId: string): void {
	const key = indexUpdateKey(cwd);
	const existing = pendingIndexUpdates.get(key);
	const runIds = existing?.runIds ?? new Set<string>();
	runIds.add(runId);
	if (existing) clearTimeout(existing.timer);

	const runUpdate = (): void => {
		pendingIndexUpdates.delete(key);
		void updateIndex(cwd, [...runIds]).catch(() => undefined);
	};

	// Hot nonterminal updates share one per-cwd dirty set. Correctness-sensitive
	// readers use readFreshIndex(), which reconciles from run.json if this advisory
	// rebuild is delayed or lost. First and terminal writes remain awaited above.
	const timer = runLeaseContext.exit(() =>
		setTimeout(runUpdate, indexUpdateDebounceMs),
	);
	timer.unref?.();
	pendingIndexUpdates.set(key, { cwd, runIds, timer });
}

export async function writeRunRecordDurable(
	cwd: string,
	run: WorkflowRunRecord,
	abortSignal?: AbortSignal,
): Promise<void> {
	await writeRunRecord(cwd, run, abortSignal);
	await syncFileAndDirectory(workflowRunPath(cwd, run.runId));
}

export async function flushPendingIndexUpdatesForTests(): Promise<number> {
	const pending = [...pendingIndexUpdates.values()];
	pendingIndexUpdates.clear();
	for (const item of pending) clearTimeout(item.timer);
	await Promise.all(
		pending.map((item) => updateIndex(item.cwd, [...item.runIds])),
	);
	return pending.length;
}

export function setIndexUpdateDebounceMsForTests(value?: number): void {
	indexUpdateDebounceMs =
		value === undefined
			? DEFAULT_INDEX_UPDATE_DEBOUNCE_MS
			: Math.max(0, Math.floor(value));
}

export async function writeCompiledRunArtifact(
	cwd: string,
	runId: string,
	compiled: CompiledWorkflow,
): Promise<void> {
	const runDir = workflowRunDir(cwd, runId);
	await writeJsonAtomic(
		join(runDir, "compiled.json"),
		rewriteCompiledBundlePaths(compiled, join(runDir, "bundle")),
	);
}

export async function writeStaticRunArtifacts(
	cwd: string,
	run: WorkflowRunRecord,
	compiled: CompiledWorkflow,
	originalSpec: unknown,
): Promise<void> {
	const runDir = workflowRunDir(cwd, run.runId);
	await writeJsonAtomic(join(runDir, "spec.json"), originalSpec);
	await writeCompiledRunArtifact(cwd, run.runId, compiled);
	await copyWorkflowBundleArtifacts(
		cwd,
		run.specPath,
		join(runDir, "bundle"),
		originalSpec,
	);
	rewriteCompiledBundlePathsInValue(run, join(runDir, "bundle"));
	rewriteCompiledBundlePathsInValue(compiled, join(runDir, "bundle"));
}

function rewriteCompiledBundlePaths(
	compiled: CompiledWorkflow,
	bundleDir: string,
): CompiledWorkflow {
	const rewritten = JSON.parse(JSON.stringify(compiled)) as CompiledWorkflow;
	rewriteCompiledBundlePathsInValue(rewritten, bundleDir);
	return rewritten;
}

function rewriteCompiledBundlePathsInValue(
	value: unknown,
	bundleDir: string,
): void {
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const item of value)
			rewriteCompiledBundlePathsInValue(item, bundleDir);
		return;
	}
	const record = value as Record<string, any>;
	if (Array.isArray(record.extensions)) {
		record.extensions = record.extensions.map((extension: unknown) =>
			typeof extension === "string" && extension.startsWith("./")
				? join(bundleDir, stripBundleRefPrefix(extension))
				: extension,
		);
	}
	const output = record.artifactGraph?.output;
	if (output?.controlSchema) {
		output.controlSchemaPath = join(
			bundleDir,
			stripBundleRefPrefix(output.controlSchema),
		);
	}
	if (record.kind === "dynamic" && record.dynamic?.uses) {
		record.agentPath = join(
			bundleDir,
			stripBundleRefPrefix(record.dynamic.uses),
		);
	}
	if (record.kind === "support" && record.support?.uses) {
		record.agentPath = join(
			bundleDir,
			stripBundleRefPrefix(record.support.uses),
		);
	}
	if (record.dynamic) {
		const dynamic = record.dynamic;
		if (dynamic.uses) {
			dynamic.usesPath = join(bundleDir, stripBundleRefPrefix(dynamic.uses));
		}
		for (const helper of Object.values(dynamic.helpers ?? {}) as any[]) {
			if (helper.uses) {
				helper.usesPath = join(bundleDir, stripBundleRefPrefix(helper.uses));
			}
			if (helper.inputSchema) {
				helper.inputSchemaPath = join(
					bundleDir,
					stripBundleRefPrefix(helper.inputSchema),
				);
			}
			if (helper.outputSchema) {
				helper.outputSchemaPath = join(
					bundleDir,
					stripBundleRefPrefix(helper.outputSchema),
				);
			}
		}
		for (const workflow of Object.values(dynamic.workflows ?? {}) as any[]) {
			if (workflow.uses) {
				workflow.usesPath = join(
					bundleDir,
					stripBundleRefPrefix(workflow.uses),
				);
			}
		}
	}
	for (const item of Object.values(record)) {
		rewriteCompiledBundlePathsInValue(item, bundleDir);
	}
}

function stripBundleRefPrefix(ref: string): string {
	return ref.startsWith("./") ? ref.slice(2) : ref;
}

async function copyWorkflowBundleArtifacts(
	cwd: string,
	specPath: string,
	targetDir: string,
	spec: unknown,
): Promise<void> {
	const sourceSpecPath = isAbsolute(specPath)
		? specPath
		: resolve(cwd, specPath);
	const sourceDir = dirname(sourceSpecPath);
	if (resolve(sourceDir) === resolve(targetDir)) return;
	let sourceRoot: string;
	try {
		sourceRoot = await realpath(sourceDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	const entrySpecName = basename(sourceSpecPath);
	const collection = collectWorkflowBundleRefs(spec);
	collection.refs.add(entrySpecName);
	await collectNestedWorkflowBundleRefs(sourceRoot, collection);
	for (const ref of collection.refs) {
		await copyWorkflowBundleFile(sourceRoot, targetDir, ref);
	}
}

interface WorkflowBundleRefCollection {
	refs: Set<string>;
	schemaRefs: Set<string>;
	workflowRefs: Set<string>;
}

async function collectNestedWorkflowBundleRefs(
	sourceRoot: string,
	collection: WorkflowBundleRefCollection,
): Promise<void> {
	const seenWorkflow = new Set<string>();
	const seenSchema = new Set<string>();
	const seenCode = new Set<string>();
	let changed = true;
	while (changed) {
		changed = false;
		for (const ref of [...collection.workflowRefs]) {
			if (seenWorkflow.has(ref) || !ref.endsWith(".json")) continue;
			seenWorkflow.add(ref);
			const nested = await readJsonBundleFile(sourceRoot, ref);
			if (nested === undefined) continue;
			parseWorkflow(nested);
			const nestedPrefix = dirname(ref);
			const nestedCollection = collectWorkflowBundleRefs(nested);
			for (const nestedRef of nestedCollection.refs) {
				const combined =
					nestedPrefix === "." ? nestedRef : join(nestedPrefix, nestedRef);
				if (!collection.refs.has(combined)) {
					collection.refs.add(combined);
					changed = true;
				}
			}
			for (const nestedRef of nestedCollection.workflowRefs) {
				const combined =
					nestedPrefix === "." ? nestedRef : join(nestedPrefix, nestedRef);
				if (!collection.workflowRefs.has(combined)) {
					collection.workflowRefs.add(combined);
					changed = true;
				}
			}
			for (const nestedRef of nestedCollection.schemaRefs) {
				const combined =
					nestedPrefix === "." ? nestedRef : join(nestedPrefix, nestedRef);
				if (!collection.schemaRefs.has(combined)) {
					collection.schemaRefs.add(combined);
					changed = true;
				}
			}
		}
		for (const ref of [...collection.schemaRefs]) {
			if (seenSchema.has(ref) || !ref.endsWith(".json")) continue;
			seenSchema.add(ref);
			const schema = await readJsonBundleFile(sourceRoot, ref);
			if (schema === undefined) continue;
			for (const schemaRef of collectJsonSchemaBundleRefs(schema)) {
				const combined = normalizeBundleRelativeRef(
					dirname(ref) === "." ? schemaRef : join(dirname(ref), schemaRef),
				);
				if (!combined) {
					throw new Error(
						`workflow bundle schema ref escapes workflow directory: ${schemaRef} in ${ref}`,
					);
				}
				if (!collection.refs.has(combined)) {
					collection.refs.add(combined);
					changed = true;
				}
				if (!collection.schemaRefs.has(combined)) {
					collection.schemaRefs.add(combined);
					changed = true;
				}
			}
		}
		for (const ref of [...collection.refs]) {
			if (seenCode.has(ref) || !/\.(mjs|cjs|js|mts|cts|ts)$/.test(ref))
				continue;
			seenCode.add(ref);
			const source = await readBundleText(sourceRoot, ref);
			if (source === undefined) continue;
			for (const imported of await collectLocalEsModuleRefs(
				sourceRoot,
				source,
				ref,
			)) {
				if (!collection.refs.has(imported)) {
					collection.refs.add(imported);
					changed = true;
				}
				if (imported.endsWith(".js") || imported.endsWith(".cjs")) {
					for (const packageRef of await packageJsonRefsForJsImport(
						sourceRoot,
						imported,
					)) {
						if (!collection.refs.has(packageRef)) {
							collection.refs.add(packageRef);
							changed = true;
						}
					}
				}
			}
		}
	}
}

async function readJsonBundleFile(
	sourceRoot: string,
	ref: string,
): Promise<unknown | undefined> {
	const text = await readBundleText(sourceRoot, ref);
	return text === undefined ? undefined : JSON.parse(text);
}

async function readBundleText(
	sourceRoot: string,
	ref: string,
): Promise<string | undefined> {
	const normalized = normalizeBundleRelativeRef(ref);
	if (!normalized) return undefined;
	const candidate = resolve(sourceRoot, normalized);
	let realSource: string;
	try {
		realSource = await realpath(candidate);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const sourceRelative = relative(sourceRoot, realSource);
	if (
		sourceRelative === ".." ||
		sourceRelative.startsWith(`..${sep}`) ||
		isAbsolute(sourceRelative)
	) {
		return undefined;
	}
	return readFile(realSource, "utf8");
}

async function packageJsonRefsForJsImport(
	sourceRoot: string,
	importedRef: string,
): Promise<string[]> {
	let current = dirname(importedRef);
	while (true) {
		const candidate =
			current === "." ? "package.json" : join(current, "package.json");
		const text = await readBundleText(sourceRoot, candidate).catch(
			() => undefined,
		);
		if (text !== undefined) return [candidate];
		if (current === "." || current === "") return [];
		current = dirname(current);
	}
}

function collectWorkflowBundleRefs(
	value: unknown,
): WorkflowBundleRefCollection {
	const collection: WorkflowBundleRefCollection = {
		refs: new Set<string>(),
		schemaRefs: new Set<string>(),
		workflowRefs: new Set<string>(),
	};
	visitWorkflowBundleRefs(value, collection);
	return collection;
}

function visitWorkflowBundleRefs(
	value: unknown,
	collection: WorkflowBundleRefCollection,
): void {
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const item of value) visitWorkflowBundleRefs(item, collection);
		return;
	}
	const record = value as Record<string, unknown>;
	if (Array.isArray(record.extensions)) {
		for (const extension of record.extensions) {
			if (typeof extension === "string") {
				addWorkflowBundleRef(collection, extension, "file");
			}
		}
	}
	if (
		record.defaults &&
		typeof record.defaults === "object" &&
		!Array.isArray(record.defaults)
	) {
		visitWorkflowBundleRefs(record.defaults, collection);
	}
	if (Array.isArray(record.tools)) {
		visitWorkflowBundleRefs(record.tools, collection);
	}
	if (typeof record.controlSchema === "string") {
		addWorkflowBundleRef(collection, record.controlSchema, "schema");
	}
	if (
		record.support &&
		typeof record.support === "object" &&
		!Array.isArray(record.support)
	) {
		const support = record.support as Record<string, unknown>;
		if (typeof support.uses === "string") {
			addWorkflowBundleRef(collection, support.uses, "file");
		}
	}
	if (
		record.dynamic &&
		typeof record.dynamic === "object" &&
		!Array.isArray(record.dynamic)
	) {
		const dynamic = record.dynamic as Record<string, unknown>;
		if (typeof dynamic.uses === "string") {
			addWorkflowBundleRef(collection, dynamic.uses, "file");
		}
		if (
			dynamic.helpers &&
			typeof dynamic.helpers === "object" &&
			!Array.isArray(dynamic.helpers)
		) {
			for (const helper of Object.values(dynamic.helpers)) {
				if (!helper || typeof helper !== "object" || Array.isArray(helper))
					continue;
				const helperRecord = helper as Record<string, unknown>;
				if (typeof helperRecord.uses === "string")
					addWorkflowBundleRef(collection, helperRecord.uses, "file");
				if (typeof helperRecord.inputSchema === "string")
					addWorkflowBundleRef(collection, helperRecord.inputSchema, "schema");
				if (typeof helperRecord.outputSchema === "string")
					addWorkflowBundleRef(collection, helperRecord.outputSchema, "schema");
			}
		}
		if (
			dynamic.workflows &&
			typeof dynamic.workflows === "object" &&
			!Array.isArray(dynamic.workflows)
		) {
			for (const workflow of Object.values(dynamic.workflows)) {
				if (
					!workflow ||
					typeof workflow !== "object" ||
					Array.isArray(workflow)
				)
					continue;
				const workflowRecord = workflow as Record<string, unknown>;
				if (typeof workflowRecord.uses === "string")
					addWorkflowBundleRef(collection, workflowRecord.uses, "workflow");
			}
		}
		if (
			dynamic.decisionLoop &&
			typeof dynamic.decisionLoop === "object" &&
			!Array.isArray(dynamic.decisionLoop)
		) {
			const decisionLoop = dynamic.decisionLoop as Record<string, unknown>;
			for (const profileName of [
				"planner",
				"workerDefaults",
				"verifier",
				"synthesis",
			]) {
				const profile = decisionLoop[profileName];
				if (!profile || typeof profile !== "object" || Array.isArray(profile))
					continue;
				const tools = (profile as Record<string, unknown>).tools;
				if (Array.isArray(tools)) visitWorkflowBundleRefs(tools, collection);
			}
			if (Array.isArray(decisionLoop.allowedTools))
				visitWorkflowBundleRefs(decisionLoop.allowedTools, collection);
		}
	}
	if (
		record.output &&
		typeof record.output === "object" &&
		!Array.isArray(record.output)
	) {
		visitWorkflowBundleRefs(record.output, collection);
	}
	if (
		record.each &&
		typeof record.each === "object" &&
		!Array.isArray(record.each)
	) {
		visitWorkflowBundleRefs(record.each, collection);
	}
	if (
		record.onExhausted &&
		typeof record.onExhausted === "object" &&
		!Array.isArray(record.onExhausted)
	) {
		visitWorkflowBundleRefs(record.onExhausted, collection);
	}
	if (Array.isArray(record.stages)) {
		for (const stage of record.stages)
			visitWorkflowBundleRefs(stage, collection);
	}
	if (record.artifactGraph && typeof record.artifactGraph === "object") {
		visitWorkflowBundleRefs(record.artifactGraph, collection);
	}
}

function collectJsonSchemaBundleRefs(value: unknown): Set<string> {
	const refs = new Set<string>();
	visitJsonSchemaBundleRefs(value, refs);
	return refs;
}

function visitJsonSchemaBundleRefs(value: unknown, refs: Set<string>): void {
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const item of value) visitJsonSchemaBundleRefs(item, refs);
		return;
	}
	const record = value as Record<string, unknown>;
	if (typeof record.$ref === "string")
		addJsonSchemaBundleRef(refs, record.$ref);
	for (const item of Object.values(record))
		visitJsonSchemaBundleRefs(item, refs);
}

function addWorkflowBundleRef(
	collection: WorkflowBundleRefCollection,
	ref: string,
	kind: "file" | "schema" | "workflow",
): void {
	if (!ref.startsWith("./")) return;
	const normalized = normalizeBundleRelativeRef(ref.slice(2));
	if (!normalized) {
		throw new Error(`workflow bundle ref escapes workflow directory: ${ref}`);
	}
	collection.refs.add(normalized);
	if (kind === "schema") collection.schemaRefs.add(normalized);
	if (kind === "workflow") collection.workflowRefs.add(normalized);
}

function addJsonSchemaBundleRef(refs: Set<string>, ref: string): void {
	const [pathPart] = ref.split("#");
	if (!pathPart) return;
	if (
		isAbsolute(pathPart) ||
		pathPart.includes("\\") ||
		pathPart.includes("://") ||
		/^[A-Za-z][A-Za-z0-9+.-]*:/.test(pathPart)
	) {
		return;
	}
	refs.add(pathPart.startsWith("./") ? pathPart.slice(2) : pathPart);
}

async function collectLocalEsModuleRefs(
	sourceRoot: string,
	source: string,
	ownerRef: string,
): Promise<string[]> {
	const refs: string[] = [];
	const importPattern =
		/(?:import|export)\s*(?:[^'";]*?\s*from\s*)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*(?:,[^)]*)?\)|require\s*\(\s*["']([^"']+)["']\s*\)/g;
	const sourceForScan = stripJavaScriptComments(source);
	for (const match of sourceForScan.matchAll(importPattern)) {
		if (
			match.index !== undefined &&
			isInsideJavaScriptString(sourceForScan, match.index)
		)
			continue;
		const specifier = match[1] ?? match[2] ?? match[3];
		if (!specifier?.startsWith(".")) continue;
		const combined = normalizeBundleRelativeRef(
			join(dirname(ownerRef), specifier),
		);
		if (!combined) {
			throw new Error(
				`workflow bundle import escapes workflow directory: ${specifier} in ${ownerRef}`,
			);
		}
		refs.push(
			...(await resolveLocalBundleImportRefs(
				sourceRoot,
				combined,
				specifier,
				ownerRef,
			)),
		);
	}
	return uniqueStringArray(refs);
}

async function resolveLocalBundleImportRefs(
	sourceRoot: string,
	ref: string,
	specifier: string,
	ownerRef: string,
): Promise<string[]> {
	if (/\.(mjs|cjs|js|mts|cts|ts|json)$/.test(ref)) return [ref];
	const candidates = [
		`${ref}.js`,
		`${ref}.cjs`,
		`${ref}.mjs`,
		`${ref}.ts`,
		`${ref}.cts`,
		`${ref}.mts`,
		`${ref}.json`,
		join(ref, "index.js"),
		join(ref, "index.cjs"),
		join(ref, "index.mjs"),
		join(ref, "index.ts"),
		join(ref, "index.cts"),
		join(ref, "index.mts"),
		join(ref, "index.json"),
	].map((candidate) => normalizeBundleRelativeRef(candidate));
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			if ((await stat(resolve(sourceRoot, candidate))).isFile())
				return [candidate];
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	throw new Error(
		`workflow bundle import cannot be resolved: ${specifier} in ${ownerRef}; use a bundle-local file with an explicit extension or a resolvable JavaScript, TypeScript, JSON, or index file`,
	);
}

function isInsideJavaScriptString(source: string, index: number): boolean {
	let quote: '"' | "'" | "`" | undefined;
	for (let i = 0; i < index; i += 1) {
		const char = source[i]!;
		if (quote) {
			if (char === "\\") {
				i += 1;
				continue;
			}
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") quote = char;
	}
	return quote !== undefined;
}

function stripJavaScriptComments(source: string): string {
	let result = "";
	let i = 0;
	let quote: '"' | "'" | "`" | undefined;
	while (i < source.length) {
		const char = source[i]!;
		const next = source[i + 1];
		if (quote) {
			result += char;
			if (char === "\\") {
				if (next !== undefined) result += next;
				i += 2;
				continue;
			}
			if (char === quote) quote = undefined;
			i += 1;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			quote = char;
			result += char;
			i += 1;
			continue;
		}
		if (char === "/" && next === "/") {
			while (i < source.length && source[i] !== "\n") {
				result += " ";
				i += 1;
			}
			continue;
		}
		if (char === "/" && next === "*") {
			result += "  ";
			i += 2;
			while (
				i < source.length &&
				!(source[i] === "*" && source[i + 1] === "/")
			) {
				result += source[i] === "\n" ? "\n" : " ";
				i += 1;
			}
			if (i < source.length) {
				result += "  ";
				i += 2;
			}
			continue;
		}
		result += char;
		i += 1;
	}
	return result;
}

function normalizeBundleRelativeRef(ref: string): string | undefined {
	const normalized = normalize(ref).replaceAll("\\", "/");
	if (
		normalized === "." ||
		isAbsolute(normalized) ||
		normalized === ".." ||
		normalized.startsWith("../")
	) {
		return undefined;
	}
	return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

function uniqueStringArray(values: string[]): string[] {
	return [...new Set(values)];
}

async function copyWorkflowBundleFile(
	sourceRoot: string,
	targetDir: string,
	ref: string,
): Promise<void> {
	const source = resolve(sourceRoot, ref);
	const realSource = await realpath(source);
	const sourceRelative = relative(sourceRoot, realSource);
	if (
		sourceRelative === ".." ||
		sourceRelative.startsWith(`..${sep}`) ||
		isAbsolute(sourceRelative)
	) {
		throw new Error(`workflow bundle ref escapes workflow directory: ${ref}`);
	}
	const fileStat = await stat(realSource);
	if (!fileStat.isFile()) {
		throw new Error(`workflow bundle ref is not a file: ${ref}`);
	}
	const target = resolve(targetDir, ref);
	await mkdir(dirname(target), { recursive: true });
	await cp(realSource, target, { force: true, errorOnExist: false });
}

async function assertLeaseContextOwnership(
	context = runLeaseContext.getStore(),
): Promise<void> {
	if (!context) return;
	assertLeaseNotAborted(context.abortSignal);
	await runLeaseTestHooks.onBeforeLeaseOwnershipCheck?.({
		cwd: context.cwd,
		runId: context.runId,
		ownerId: context.ownerId,
	});
	assertLeaseNotAborted(context.abortSignal);
	await assertLockOwner(
		join(workflowRunDir(context.cwd, context.runId), "supervisor.lock"),
		context.ownerId,
	);
	assertLeaseNotAborted(context.abortSignal);
}

export async function assertRunLeaseOwnership(
	cwd: string,
	runId: string,
	abortSignal?: AbortSignal,
): Promise<void> {
	assertSafeRunId(runId);
	assertLeaseNotAborted(abortSignal);
	const context = runLeaseContext.getStore();
	if (!context || context.cwd !== cwd || context.runId !== runId) {
		throw new Error(`Missing supervisor lease for workflow run ${runId}`);
	}
	assertLeaseNotAborted(context.abortSignal);
	await assertLeaseContextOwnership(context);
	assertLeaseNotAborted(abortSignal);
	assertLeaseNotAborted(context.abortSignal);
}

async function assertActiveRunLease(
	cwd: string,
	runId: string,
	abortSignal?: AbortSignal,
): Promise<void> {
	assertSafeRunId(runId);
	assertLeaseNotAborted(abortSignal);
	const context = runLeaseContext.getStore();
	if (!context || context.cwd !== cwd || context.runId !== runId) return;
	await assertLeaseContextOwnership(context);
	assertLeaseNotAborted(abortSignal);
}

export async function findRunRecordPath(
	cwd: string,
	runIdOrPrefix: string,
): Promise<string | undefined> {
	assertSafeRunId(runIdOrPrefix);
	const root = workflowsRoot(cwd);
	let entries: string[];
	try {
		entries = await readdir(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}

	const matches = entries
		.filter(
			(entry) =>
				isSafeRunId(entry) &&
				(entry === runIdOrPrefix || entry.startsWith(runIdOrPrefix)),
		)
		.sort();
	if (matches.length === 0) return undefined;
	if (matches.length > 1 && !matches.includes(runIdOrPrefix)) {
		throw new Error(
			`Ambiguous workflow run id prefix "${runIdOrPrefix}": ${matches.slice(0, 8).join(", ")}`,
		);
	}
	const runId = matches.includes(runIdOrPrefix) ? runIdOrPrefix : matches[0]!;
	return workflowRunPath(cwd, runId);
}

/**
 * True when a run was produced by a mock/fixture pipeline (for example
 * `provenance.mode: "mock-screenshot"`) rather than a real execution. Mock
 * runs must never surface in unfinished-run notices and are annotated in
 * status listings.
 */
export function isMockRunProvenance(
	provenance: WorkflowRunProvenance | undefined,
): boolean {
	const mode = provenance?.mode;
	if (typeof mode !== "string") return false;
	return mode === "mock" || mode.startsWith("mock-");
}

export async function readRunRecord(
	cwd: string,
	runIdOrPrefix: string,
): Promise<WorkflowRunRecord> {
	const file = await findRunRecordPath(cwd, runIdOrPrefix);
	if (!file) throw new Error(`Flow run not found: ${runIdOrPrefix}`);

	const containingRunId = basename(dirname(file));
	assertSafeRunId(containingRunId);
	const run = await readJson<WorkflowRunRecord>(file);
	if (!run?.runId || !Array.isArray(run.tasks))
		throw new Error(`Invalid workflow run record: ${file}`);
	// Reject ambiguous task identity at the persistence boundary, before any
	// scheduler recovery, foreach batch lookup, or terminal demux can build a
	// taskId map that silently selects one duplicate.
	assertUniqueRunTaskIds(run);
	if (run.runId !== containingRunId) {
		throw new Error(
			`Workflow run record identity does not match containing directory: ${file}`,
		);
	}
	return deriveRunStatus(run);
}

async function readIndexUnchecked(
	cwd: string,
): Promise<WorkflowIndexRecord | undefined> {
	return readJson<WorkflowIndexRecord>(workflowIndexPath(cwd));
}

export async function readIndex(
	cwd: string,
): Promise<WorkflowIndexRecord | undefined> {
	return readIndexUnchecked(cwd);
}

export async function readFreshIndex(
	cwd: string,
): Promise<WorkflowIndexRecord | undefined> {
	let current: WorkflowIndexRecord | undefined;
	try {
		current = await readIndexUnchecked(cwd);
	} catch {
		current = undefined;
	}
	const rebuilt = await rebuildIndex(cwd);
	if (isIndexRecordLike(current) && indexEntriesEqual(current, rebuilt)) {
		return current;
	}
	if (!current && rebuilt.runs.length === 0) return undefined;
	return updateIndex(cwd);
}

export async function listRunRecords(
	cwd: string,
): Promise<WorkflowRunRecord[]> {
	const root = workflowsRoot(cwd);
	let entries: string[];
	try {
		entries = await readdir(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}

	const records = await Promise.all(
		entries.map(async (entry) => {
			if (!isSafeRunId(entry)) return undefined;
			const file = workflowRunPath(cwd, entry);
			try {
				const fileStat = await stat(file);
				if (!fileStat.isFile()) return undefined;
				const parsed = JSON.parse(
					await readFile(file, "utf8"),
				) as WorkflowRunRecord;
				if (!isRunRecordLike(parsed)) return undefined;
				if (parsed.runId !== entry) {
					throw new Error(
						`Workflow run record identity does not match containing directory: ${file}`,
					);
				}
				// Keep list and point reads equally strict. Callers commonly build
				// taskId maps from listings during recovery and demux.
				assertUniqueRunTaskIds(parsed);
				return deriveRunStatus(parsed);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ENOENT" || code === "ENOTDIR") return undefined;
				if (error instanceof SyntaxError) return undefined;
				throw error;
			}
		}),
	);

	return records.filter((record): record is WorkflowRunRecord =>
		Boolean(record),
	);
}

function isRunRecordLike(value: unknown): value is WorkflowRunRecord {
	if (!value || typeof value !== "object") return false;
	const run = value as Partial<WorkflowRunRecord>;
	if (typeof run.runId !== "string" || !Array.isArray(run.tasks)) return false;
	return run.tasks.every((task) =>
		Boolean(
			task &&
				typeof task === "object" &&
				typeof (task as WorkflowTaskRunRecord).status === "string" &&
				TASK_STATUSES.includes(
					(task as WorkflowTaskRunRecord).status as keyof Omit<
						TaskSummary,
						"total"
					>,
				),
		),
	);
}

export async function updateIndex(
	cwd: string,
	changedRunId?: string | readonly string[],
	abortSignal?: AbortSignal,
): Promise<WorkflowIndexRecord> {
	assertLeaseNotAborted(abortSignal);
	const lockFile = join(workflowsRoot(cwd), "index.lock");
	const ownerId = `${process.pid}-${randomBytes(3).toString("hex")}`;
	await ensureDir(workflowsRoot(cwd));
	assertLeaseNotAborted(abortSignal);
	await acquireLockWithWait(lockFile, ownerId);
	let callerOutcomeSettled = false;

	try {
		assertLeaseNotAborted(abortSignal);
		const changedRunIds =
			typeof changedRunId === "string" ? [changedRunId] : changedRunId;
		const index =
			changedRunIds && changedRunIds.length > 0
				? await updateIndexIncremental(cwd, changedRunIds)
				: await rebuildIndex(cwd);
		assertLeaseNotAborted(abortSignal);
		await writeJsonAtomic(workflowIndexPath(cwd), index, abortSignal);
		assertLeaseNotAborted(abortSignal);
		callerOutcomeSettled = true;
		return index;
	} catch (error) {
		// Preserve the index operation's outcome while ensuring a failed release
		// has already made this live-PID lock durably reclaimable.
		callerOutcomeSettled = true;
		throw error;
	} finally {
		try {
			await releaseRunFileLockWithRetries(lockFile, ownerId);
		} catch (releaseError) {
			if (!callerOutcomeSettled) throw releaseError;
		}
	}
}

type WorkflowIndexRunEntry = WorkflowIndexRecord["runs"][number];

async function updateIndexIncremental(
	cwd: string,
	changedRunIds: readonly string[],
): Promise<WorkflowIndexRecord> {
	const existing = await readIndexForIncremental(cwd);
	if (!existing) return rebuildIndex(cwd);

	let changedRuns: WorkflowRunRecord[];
	try {
		changedRuns = await Promise.all(
			[...new Set(changedRunIds)].map((runId) => readRunRecord(cwd, runId)),
		);
	} catch {
		return rebuildIndex(cwd);
	}

	const changedIds = new Set(changedRuns.map((run) => run.runId));
	const entries = existing.runs
		.filter((entry) => !changedIds.has(entry.runId))
		.map(stripIndexTaskRows)
		.concat(changedRuns.map((run) => buildIndexEntry(cwd, run)));
	return {
		schemaVersion: 1,
		updatedAt: nowIso(),
		runs: selectIndexEntries(entries),
	};
}

async function readIndexForIncremental(
	cwd: string,
): Promise<WorkflowIndexRecord | undefined> {
	let index: WorkflowIndexRecord | undefined;
	try {
		index = await readIndexUnchecked(cwd);
	} catch {
		return undefined;
	}
	if (!isIndexRecordLike(index)) return undefined;
	return index;
}

async function rebuildIndex(cwd: string): Promise<WorkflowIndexRecord> {
	const runs = await listRunRecords(cwd);
	return {
		schemaVersion: 1,
		updatedAt: nowIso(),
		runs: selectIndexEntries(runs.map((run) => buildIndexEntry(cwd, run))),
	};
}

function selectIndexEntries(
	entries: WorkflowIndexRunEntry[],
): WorkflowIndexRunEntry[] {
	const sorted = [...entries].sort((left, right) =>
		right.updatedAt.localeCompare(left.updatedAt),
	);
	const active = sorted.filter(
		(entry) => !isTerminalWorkflowStatus(entry.status),
	);
	const terminal = sorted
		.filter((entry) => isTerminalWorkflowStatus(entry.status))
		.slice(0, TERMINAL_INDEX_LIMIT);
	return [...active, ...terminal].sort((left, right) =>
		right.updatedAt.localeCompare(left.updatedAt),
	);
}

function stripIndexTaskRows(
	entry: WorkflowIndexRunEntry,
): WorkflowIndexRunEntry {
	const { tasks: _tasks, ...slim } = entry;
	return slim;
}

function buildIndexEntry(
	cwd: string,
	run: WorkflowRunRecord,
): WorkflowIndexRunEntry {
	return {
		runId: run.runId,
		name: run.name,
		type: run.type,
		artifactGraph: run.artifactGraph,
		status: run.status,
		...(run.degradation ? { degradation: run.degradation } : {}),
		taskSummary: run.taskSummary,
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
		parentRunId: run.parentRunId,
		rootRunId: run.rootRunId,
		round: run.round,
		fanout: run.fanout,
		runJson: toProjectPath(cwd, workflowRunPath(cwd, run.runId)),
	};
}

function indexEntriesEqual(
	left: WorkflowIndexRecord,
	right: WorkflowIndexRecord,
): boolean {
	return JSON.stringify(left.runs) === JSON.stringify(right.runs);
}

function isIndexRecordLike(
	value: WorkflowIndexRecord | undefined,
): value is WorkflowIndexRecord {
	return (
		value?.schemaVersion === 1 &&
		Array.isArray(value.runs) &&
		value.runs.every((entry) => {
			if (!entry || typeof entry !== "object") return false;
			const tasks = (entry as { tasks?: unknown }).tasks;
			return (
				typeof entry.runId === "string" &&
				typeof entry.updatedAt === "string" &&
				typeof entry.status === "string" &&
				(tasks === undefined || Array.isArray(tasks))
			);
		})
	);
}

export function deriveRunStatus(run: WorkflowRunRecord): WorkflowRunRecord {
	const next = { ...run, tasks: run.tasks };
	next.taskSummary = summarizeTasks(next.tasks);
	next.status = deriveWorkflowStatus(next.taskSummary);
	next.degradation = computeRunDegradation(next);
	return next;
}

/**
 * Final-stage tasks are structural graph leaves: tasks whose specId no other
 * task depends on. Helper leaves (support/dynamic controller tasks) are
 * excluded when at least one regular leaf exists, so a trailing sanitizer or
 * controller never masquerades as the run's final output.
 */
export function finalStageTasks(
	tasks: WorkflowTaskRunRecord[],
): WorkflowTaskRunRecord[] {
	const dependedOn = new Set<string>();
	for (const task of tasks) {
		for (const dependency of task.dependsOn ?? []) dependedOn.add(dependency);
	}
	const leaves = tasks.filter((task) => !dependedOn.has(task.specId));
	const regularLeaves = leaves.filter(
		(task) => task.kind !== "support" && task.kind !== "dynamic",
	);
	return regularLeaves.length > 0 ? regularLeaves : leaves;
}

/**
 * Computes degradation metadata for a run in a terminal "completed" or
 * "failed" status. Returns undefined (no degradation field) when the status
 * already tells the whole story: a clean success, or a failure where the
 * final-stage tasks did not complete either. Helper degradation is detected
 * from what the run record already knows (completed support tasks that needed
 * output repair, `outputRetry.attempts > 0`); artifact files such as
 * control.json are intentionally not read here — this runs synchronously on
 * every run-record write and read.
 */
export function computeRunDegradation(
	run: WorkflowRunRecord,
): WorkflowRunDegradation | undefined {
	if (run.status !== "failed" && run.status !== "completed") return undefined;
	const failedTaskIds = run.tasks
		.filter((task) => task.status === "failed")
		.map((task) => task.taskId);
	const degradedHelperTaskIds = run.tasks
		.filter(
			(task) =>
				task.kind === "support" &&
				task.status === "completed" &&
				(task.outputRetry?.attempts ?? 0) > 0,
		)
		.map((task) => task.taskId);
	const finalTasks = finalStageTasks(run.tasks);
	const finalOutputRendered =
		finalTasks.length > 0 &&
		finalTasks.every((task) => task.status === "completed");
	const degradedDelivery = failedTaskIds.length > 0 && finalOutputRendered;
	if (!degradedDelivery && degradedHelperTaskIds.length === 0) return undefined;
	const parts = [finalOutputRendered ? "final rendered" : "final not rendered"];
	if (failedTaskIds.length > 0)
		parts.push(
			`${failedTaskIds.length}/${run.tasks.length} task${run.tasks.length === 1 ? "" : "s"} failed`,
		);
	if (degradedHelperTaskIds.length > 0)
		parts.push(
			`${degradedHelperTaskIds.length} helper task${degradedHelperTaskIds.length === 1 ? "" : "s"} degraded`,
		);
	return {
		finalOutputRendered,
		failedTaskIds,
		degradedHelperTaskIds,
		summary: parts.join(", "),
	};
}

export function summarizeTasks(tasks: WorkflowTaskRunRecord[]): TaskSummary {
	const summary = emptySummary();
	for (const task of tasks) {
		summary[task.status] += 1;
		summary.total += 1;
	}
	return summary;
}

export interface TaskFailureClassSummary {
	failed: number;
	failFastCancelled: number;
	otherInterrupted: number;
}

export function summarizeTaskFailureClasses(
	tasks: Pick<WorkflowTaskRunRecord, "status" | "statusDetail">[],
): TaskFailureClassSummary {
	const summary: TaskFailureClassSummary = {
		failed: 0,
		failFastCancelled: 0,
		otherInterrupted: 0,
	};
	for (const task of tasks) {
		if (task.status === "failed") {
			summary.failed += 1;
			continue;
		}
		if (task.status !== "interrupted") continue;
		if (task.statusDetail === FAIL_FAST_CANCELLED_STATUS_DETAIL)
			summary.failFastCancelled += 1;
		else summary.otherInterrupted += 1;
	}
	return summary;
}

export function deriveWorkflowStatus(summary: TaskSummary): WorkflowRunStatus {
	if (summary.blocked > 0) return "blocked";
	if (summary.running > 0 || summary.pending > 0) return "running";
	if (summary.total > 0 && summary.completed === summary.total)
		return "completed";
	if (summary.failed > 0) return "failed";
	if (summary.interrupted > 0) return "interrupted";
	return "interrupted";
}

export function isTerminalWorkflowStatus(status: WorkflowRunStatus): boolean {
	return (
		status === "completed" || status === "failed" || status === "interrupted"
	);
}

export function isTerminalTaskStatus(status: TaskRunStatus): boolean {
	return (
		status === "completed" ||
		status === "failed" ||
		status === "skipped" ||
		status === "interrupted" ||
		status === "blocked"
	);
}

export function setTaskTerminal(
	task: WorkflowTaskRunRecord,
	status: TaskRunStatus,
	statusDetail: string,
	options: {
		completedAt?: string;
		exitCode?: number;
		lastMessage?: string;
	} = {},
): boolean {
	if (isTerminalTaskStatus(task.status)) return false;
	task.status = status;
	task.statusDetail = statusDetail;
	task.completedAt = options.completedAt ?? nowIso();
	task.exitCode = options.exitCode;
	task.lastMessage = options.lastMessage;
	return true;
}

const RESUMABLE_TASK_STATUSES = new Set<TaskRunStatus>([
	"failed",
	"interrupted",
	"skipped",
]);
const RESUMABLE_BLOCKED_STATUS_DETAILS = new Set([
	"dynamic_ui_unavailable",
	"dynamic_approval_timeout",
]);

export function isBlockedTaskResumableForResume(
	task: Pick<WorkflowTaskRunRecord, "status" | "statusDetail">,
): boolean {
	return (
		task.status === "blocked" &&
		RESUMABLE_BLOCKED_STATUS_DETAILS.has(task.statusDetail)
	);
}

export function resetTaskForResume(task: WorkflowTaskRunRecord): boolean {
	if (
		!RESUMABLE_TASK_STATUSES.has(task.status) &&
		!isBlockedTaskResumableForResume(task)
	) {
		return false;
	}
	recordTaskResumeEvent(task);
	resetTaskRuntimeState(task);
	return true;
}

export function invalidateTaskForDependencyResume(
	task: WorkflowTaskRunRecord,
): boolean {
	if (task.status === "pending") return false;
	recordTaskResumeEvent(task);
	resetTaskRuntimeState(task);
	return true;
}

function resetTaskRuntimeState(task: WorkflowTaskRunRecord): void {
	task.status = "pending";
	task.statusDetail = "pending";
	task.startedAt = undefined;
	task.completedAt = undefined;
	task.elapsedMs = undefined;
	task.exitCode = undefined;
	task.pid = undefined;
	task.launchToken = undefined;
	task.backendHandle = undefined;
	task.backendFiles = undefined;
	task.lastMessage = undefined;
	task.outputRetry = undefined;
	task.promptMetadata = undefined;
}

function recordTaskResumeEvent(task: WorkflowTaskRunRecord): void {
	task.resumeEvents ??= [];
	task.resumeEvents.push(buildTaskResumeEvent(task));
}

function buildTaskResumeEvent(
	task: WorkflowTaskRunRecord,
): WorkflowTaskResumeEvent {
	const backendRunId = taskBackendHandleString(task, "runId");
	const backendAttemptId = taskBackendHandleString(task, "attemptId");
	return {
		at: nowIso(),
		fromStatus: task.status,
		fromStatusDetail: task.statusDetail,
		...(task.lastMessage === undefined
			? {}
			: { lastMessage: task.lastMessage }),
		...(task.outputRetry?.attempts === undefined
			? {}
			: { outputRetryAttempts: task.outputRetry.attempts }),
		...(task.outputRetry?.reason === undefined
			? {}
			: { outputRetryReason: task.outputRetry.reason }),
		...(task.outputRetry?.repairMode === undefined
			? {}
			: { outputRetryRepairMode: task.outputRetry.repairMode }),
		...(task.launchRetry?.attempts === undefined
			? {}
			: { launchRetryAttempts: task.launchRetry.attempts }),
		...(task.launchRetry?.reason === undefined
			? {}
			: { launchRetryReason: task.launchRetry.reason }),
		...(backendRunId === undefined ? {} : { backendRunId }),
		...(backendAttemptId === undefined ? {} : { backendAttemptId }),
	};
}

function taskBackendHandleString(
	task: WorkflowTaskRunRecord,
	key: string,
): string | undefined {
	const handle = task.backendHandle;
	if (!handle || typeof handle !== "object" || Array.isArray(handle)) {
		return undefined;
	}
	const value = handle[key];
	return typeof value === "string" ? value : undefined;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
	if (!signal) return sleep(ms);
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function compiledWorkflowHasDynamicController(
	compiled: CompiledWorkflow,
): boolean {
	return (
		compiled.tasks.some(compiledTaskHasDynamicController) ||
		(compiled.stages ?? []).some(compiledStageRecordHasDynamicController)
	);
}

function compiledTaskHasDynamicController(task: CompiledTask): boolean {
	return task.kind === "dynamic";
}

function compiledStageRecordHasDynamicController(
	record: Record<string, unknown> | CompiledLoopStageRecord,
): boolean {
	if (
		"childTemplates" in record &&
		Array.isArray(record.childTemplates) &&
		record.childTemplates.some(compiledTaskHasDynamicController)
	) {
		return true;
	}
	if ("onExhausted" in record) {
		const onExhausted = record.onExhausted;
		if (
			onExhausted &&
			typeof onExhausted === "object" &&
			"template" in onExhausted &&
			onExhausted.template &&
			compiledTaskHasDynamicController(onExhausted.template as CompiledTask)
		) {
			return true;
		}
	}
	return false;
}

export function createTaskRunRecord(
	cwd: string,
	runId: string,
	task: CompiledTask,
	index: number,
): WorkflowTaskRunRecord {
	const taskId = `task-${index + 1}`;
	const dir = taskDir(cwd, runId, taskId);
	const files = {
		systemPrompt: toProjectPath(cwd, join(dir, "system-prompt.md")),
		taskPrompt: toProjectPath(cwd, join(dir, "task.md")),
		output: toProjectPath(cwd, join(dir, "output.log")),
		stderr: toProjectPath(cwd, join(dir, "stderr.log")),
		result: toProjectPath(cwd, join(dir, "result.json")),
	};
	const blocked = task.safety.permission.status === "blocked";
	const bundleDir = join(workflowRunDir(cwd, runId), "bundle");
	const agentFile =
		task.kind === "dynamic" && task.dynamic?.uses
			? toProjectPath(
					cwd,
					join(bundleDir, stripBundleRefPrefix(task.dynamic.uses)),
				)
			: task.kind === "support" && task.support?.uses
				? toProjectPath(
						cwd,
						join(bundleDir, stripBundleRefPrefix(task.support.uses)),
					)
				: task.agentPath;
	const taskArtifactGraph = task.artifactGraph
		? (JSON.parse(
				JSON.stringify(task.artifactGraph),
			) as typeof task.artifactGraph)
		: undefined;
	if (taskArtifactGraph) {
		rewriteCompiledBundlePathsInValue(
			{ artifactGraph: taskArtifactGraph },
			bundleDir,
		);
	}

	return {
		taskId,
		specId: task.id,
		displayName: task.id,
		agent: task.agent,
		agentDescription: task.agentDescription,
		agentFile,
		roles: task.roleNames,
		status: blocked ? "blocked" : "pending",
		statusDetail: blocked
			? (task.safety.permission.statusDetail ?? "needs_attention")
			: "pending",
		runtime: {
			model: task.runtime.model,
			thinking: task.runtime.thinking,
			thinkingResolution: task.runtime.thinkingResolution,
			approvalMode: task.runtime.approvalMode,
			maxRuntimeMs: task.runtime.maxRuntimeMs,
		},
		tools: task.runtime.tools,
		cwd: task.cwd,
		worktree: {
			enabled: false,
			path: null,
			branch: null,
			baseCwd: null,
			warning: null,
		},
		backendTaskId: taskId,
		kind: task.kind,
		stageId: task.stageId,
		dependsOn: task.dependsOn,
		...(taskArtifactGraph?.inputPolicy?.terminalBarrier === "all-sources"
			? {
					terminalBarrier: {
						mode: "all-sources" as const,
						sourceSpecIds: [...new Set(task.dependsOn ?? [])],
					},
				}
			: {}),
		artifactGraph: taskArtifactGraph,
		...(task.generation === undefined ? {} : { generation: task.generation }),
		sourceGeneration: task.sourceGeneration,
		dynamicGenerated: task.dynamicGenerated,
		foreachGenerated: task.foreachGenerated,
		files,
		lastMessage: blocked ? task.safety.permission.reason : undefined,
	};
}

function emptySummary(): TaskSummary {
	return TASK_STATUSES.reduce(
		(summary, status) => {
			summary[status] = 0;
			return summary;
		},
		{ total: 0 } as TaskSummary,
	);
}

export async function resolveFlowsCwd(cwd: string): Promise<string> {
	let current = cwd;
	while (true) {
		try {
			const found = await readJson(workflowIndexPath(current));
			if (found) return current;
		} catch {
			// Parent directories without a workflow index are expected during lookup.
		}
		const parent = dirname(current);
		if (parent === current) return cwd;
		current = parent;
	}
}

export async function createWorkflowRunRecord(
	cwd: string,
	compiled: CompiledWorkflow,
	specPath: string,
): Promise<{ run: WorkflowRunRecord; runDir: string }> {
	const result = await createRunRecord(cwd, compiled, specPath);
	result.run.type = WORKFLOW_RUN_TYPE as any;
	return result;
}

export function supervisorLeasePath(cwd: string, runId: string): string {
	return join(workflowRunDir(cwd, runId), "supervisor-lease.json");
}
const TEST_OWNER_ID = `pi-workflow-${process.pid}`;
export function workflowSupervisorOwnerIdForTests(): string {
	return TEST_OWNER_ID;
}
export function workflowProcessRoleForTests(): string {
	return process.env.PI_WORKFLOW_ROLE ?? "supervisor";
}
export async function acquireSupervisorLease(
	cwd: string,
	runId: string,
): Promise<boolean> {
	if (
		process.env.PI_WORKFLOW_ROLE === "worker" ||
		process.env.PI_WORKFLOW_ROLE === "disabled"
	)
		return false;
	const path = supervisorLeasePath(cwd, runId);
	try {
		const current = (await readJson(path)) as any;
		if (
			current?.ownerId &&
			current.ownerId !== TEST_OWNER_ID &&
			current.pid === process.pid
		)
			return false;
	} catch {
		// Missing or unreadable lease files are treated as available for tests.
	}
	await writeJsonAtomic(path, {
		schemaVersion: 1,
		ownerId: TEST_OWNER_ID,
		pid: process.pid,
		role: "supervisor",
		startedAt: new Date().toISOString(),
		heartbeatAt: new Date().toISOString(),
	});
	return true;
}
export async function heartbeatSupervisorLease(
	cwd: string,
	runId: string,
): Promise<boolean> {
	const path = supervisorLeasePath(cwd, runId);
	const current = (await readJson(path)) as any;
	if (!current || current.ownerId !== TEST_OWNER_ID) return false;
	await writeJsonAtomic(path, {
		...current,
		heartbeatAt: new Date().toISOString(),
	});
	return true;
}
