import { AsyncLocalStorage } from "node:async_hooks";
import {
	cp,
	link,
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
import { randomBytes } from "node:crypto";

import { parseWorkflow } from "./schema.js";
import {
	type CompiledWorkflow,
	type CompiledTask,
	type CompiledLoopStageRecord,
	WORKFLOW_RUN_TYPE,
	type WorkflowIndexRecord,
	type WorkflowRunRecord,
	type WorkflowRunStatus,
	type WorkflowTaskRunRecord,
	type WorkflowTaskResumeEvent,
	type TaskRunStatus,
	type TaskSummary,
} from "./types.js";

const TERMINAL_INDEX_LIMIT = 50;
const LEASE_STALE_MS = 30_000;
const LEASE_ABSOLUTE_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const INDEX_LOCK_WAIT_MS = 5_000;
const INDEX_LOCK_RETRY_MS = 50;
const DEFAULT_INDEX_UPDATE_DEBOUNCE_MS = 500;
let indexUpdateDebounceMs = DEFAULT_INDEX_UPDATE_DEBOUNCE_MS;
const pendingIndexUpdates = new Map<
	string,
	{ cwd: string; runId: string; timer: ReturnType<typeof setTimeout> }
>();
const runLeaseContext = new AsyncLocalStorage<{
	cwd: string;
	runId: string;
	ownerId: string;
	abortSignal: AbortSignal;
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
};
let runLeaseTestHooks: RunLeaseTestHooks = {};
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

export function workflowsRoot(cwd: string): string {
	return join(cwd, ".pi", "workflows");
}

export function workflowRunDir(cwd: string, runId: string): string {
	return join(workflowsRoot(cwd), runId);
}

export function workflowRunPath(cwd: string, runId: string): string {
	return join(workflowRunDir(cwd, runId), "run.json");
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
): Promise<void> {
	await ensureDir(dirname(file));
	const temp = join(
		dirname(file),
		`.${Date.now().toString(36)}-${randomBytes(3).toString("hex")}.tmp`,
	);
	await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await rename(temp, file);
}

export function setRunLeaseTestHooksForTests(hooks?: RunLeaseTestHooks): void {
	runLeaseTestHooks = hooks ?? {};
}

export async function withRunLease<T>(
	cwd: string,
	runId: string,
	action: (abortSignal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
	const dir = workflowRunDir(cwd, runId);
	await ensureDir(dir);
	const lockFile = join(dir, "supervisor.lock");
	const ownerId = `${process.pid}-${randomBytes(3).toString("hex")}`;
	const lock = await acquireLock(lockFile, ownerId);
	if (!lock) return undefined;

	const abortController = new AbortController();
	const abortLease = (error: unknown): void => {
		if (abortController.signal.aborted) return;
		abortController.abort(asLeaseError(error));
	};
	const supervisorFile = join(dir, "supervisor.json");
	const heartbeat = async (): Promise<void> => {
		assertLeaseNotAborted(abortController.signal);
		await assertLockOwner(lockFile, ownerId);
		const timestamp = nowIso();
		const now = new Date();
		await utimes(lockFile, now, now);
		await writeJsonAtomic(supervisorFile, {
			schemaVersion: 1,
			ownerId,
			pid: process.pid,
			updatedAt: timestamp,
			lockFile: toProjectPath(cwd, lockFile),
		});
	};

	await heartbeat();
	const heartbeatTimer = setInterval(() => {
		void heartbeat().catch(abortLease);
	}, runLeaseHeartbeatIntervalMs());
	heartbeatTimer.unref?.();

	try {
		const result = await runLeaseContext.run(
			{ cwd, runId, ownerId, abortSignal: abortController.signal },
			() => action(abortController.signal),
		);
		assertLeaseNotAborted(abortController.signal);
		return result;
	} finally {
		clearInterval(heartbeatTimer);
		await releaseLock(lockFile, ownerId);
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

function assertLeaseNotAborted(signal: AbortSignal): void {
	if (signal.aborted) throw abortSignalError(signal);
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
	if (!isReclaimableLockSnapshot(snapshot)) return false;

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
	if (!isReclaimableLockSnapshot(claimed)) {
		await restoreReclaimFile(reclaimFile, lockFile);
		return false;
	}

	await unlink(reclaimFile).catch(() => undefined);
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

function isReclaimableLockSnapshot(snapshot: LockSnapshot): boolean {
	const now = Date.now();
	const leaseStale = now - snapshot.mtimeMs > LEASE_STALE_MS;
	const absoluteStale =
		now - (snapshot.createdAtMs ?? snapshot.mtimeMs) > LEASE_ABSOLUTE_STALE_MS;
	if (!leaseStale && !absoluteStale) return false;
	if (
		snapshot.pid !== undefined &&
		isProcessAlive(snapshot.pid) &&
		!absoluteStale
	)
		return false;
	return true;
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

export async function createRunRecord(
	cwd: string,
	compiled: CompiledWorkflow,
	specPath: string,
	options: { runId?: string; parentRunId?: string; rootRunId?: string } = {},
): Promise<{ run: WorkflowRunRecord; runDir: string }> {
	const runId = options.runId ?? makeRunId();
	const runDir = workflowRunDir(cwd, runId);
	await ensureDir(runDir);
	await ensureDir(join(runDir, "tasks"));

	const createdAt = nowIso();
	const tasks = compiled.tasks.map((task, index) =>
		createTaskRunRecord(cwd, runId, task, index),
	);
	const hasDynamicController = compiledWorkflowHasDynamicController(compiled);
	if (hasDynamicController) await ensureDir(join(runDir, "dynamic"));
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

	return { run, runDir };
}

export async function writeRunRecord(
	cwd: string,
	run: WorkflowRunRecord,
): Promise<void> {
	await assertActiveRunLease(cwd, run.runId);
	run.updatedAt = nowIso();
	const derived = deriveRunStatus(run);
	Object.assign(run, derived);
	await writeJsonAtomic(workflowRunPath(cwd, run.runId), run);
	scheduleIndexUpdate(cwd, run.runId, {
		immediate: isTerminalWorkflowStatus(run.status),
	});
}

function indexUpdateKey(cwd: string, runId: string): string {
	return `${cwd}\0${runId}`;
}

function scheduleIndexUpdate(
	cwd: string,
	runId: string,
	options: { immediate: boolean },
): void {
	const key = indexUpdateKey(cwd, runId);
	const existing = pendingIndexUpdates.get(key);
	if (existing) {
		clearTimeout(existing.timer);
		pendingIndexUpdates.delete(key);
	}

	const runUpdate = (): void => {
		pendingIndexUpdates.delete(key);
		void updateIndex(cwd, runId).catch(() => undefined);
	};

	if (options.immediate) {
		runUpdate();
		return;
	}

	// Pending debounced index writes are intentionally not flushed on process exit:
	// the next explicit index rebuild/read path self-heals from run.json records.
	const timer = setTimeout(runUpdate, indexUpdateDebounceMs);
	timer.unref?.();
	pendingIndexUpdates.set(key, { cwd, runId, timer });
}

export async function flushPendingIndexUpdatesForTests(): Promise<void> {
	const pending = [...pendingIndexUpdates.values()];
	pendingIndexUpdates.clear();
	for (const item of pending) clearTimeout(item.timer);
	await Promise.all(pending.map((item) => updateIndex(item.cwd, item.runId)));
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
			if (seenCode.has(ref) || !/\.(mjs|cjs|js)$/.test(ref)) continue;
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
	if (/\.(mjs|cjs|js|json)$/.test(ref)) return [ref];
	const candidates = [
		`${ref}.js`,
		`${ref}.cjs`,
		`${ref}.json`,
		join(ref, "index.js"),
		join(ref, "index.cjs"),
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
		`workflow bundle import cannot be resolved: ${specifier} in ${ownerRef}; use a bundle-local file with an explicit extension or a resolvable .js/.cjs/.json/index file`,
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

async function assertActiveRunLease(cwd: string, runId: string): Promise<void> {
	const context = runLeaseContext.getStore();
	if (!context) return;
	if (context.cwd !== cwd || context.runId !== runId) return;
	assertLeaseNotAborted(context.abortSignal);
	await assertLockOwner(
		join(workflowRunDir(cwd, runId), "supervisor.lock"),
		context.ownerId,
	);
}

export async function findRunRecordPath(
	cwd: string,
	runIdOrPrefix: string,
): Promise<string | undefined> {
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
			(entry) => entry === runIdOrPrefix || entry.startsWith(runIdOrPrefix),
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

export async function readRunRecord(
	cwd: string,
	runIdOrPrefix: string,
): Promise<WorkflowRunRecord> {
	const file = await findRunRecordPath(cwd, runIdOrPrefix);
	if (!file) throw new Error(`Flow run not found: ${runIdOrPrefix}`);

	const run = await readJson<WorkflowRunRecord>(file);
	if (!run?.runId || !Array.isArray(run.tasks))
		throw new Error(`Invalid workflow run record: ${file}`);
	return deriveRunStatus(run);
}

export async function readIndex(
	cwd: string,
): Promise<WorkflowIndexRecord | undefined> {
	return readJson<WorkflowIndexRecord>(workflowIndexPath(cwd));
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
			const file = join(root, entry, "run.json");
			try {
				const fileStat = await stat(file);
				if (!fileStat.isFile()) return undefined;
				const parsed = JSON.parse(
					await readFile(file, "utf8"),
				) as WorkflowRunRecord;
				if (!isRunRecordLike(parsed)) return undefined;
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
	changedRunId?: string,
): Promise<WorkflowIndexRecord> {
	const lockFile = join(workflowsRoot(cwd), "index.lock");
	const ownerId = `${process.pid}-${randomBytes(3).toString("hex")}`;
	await ensureDir(workflowsRoot(cwd));
	await acquireLockWithWait(lockFile, ownerId);

	try {
		const index = changedRunId
			? await updateIndexIncremental(cwd, changedRunId)
			: await rebuildIndex(cwd);
		await writeJsonAtomic(workflowIndexPath(cwd), index);
		return index;
	} finally {
		await releaseLock(lockFile, ownerId);
	}
}

type WorkflowIndexRunEntry = WorkflowIndexRecord["runs"][number];

async function updateIndexIncremental(
	cwd: string,
	changedRunId: string,
): Promise<WorkflowIndexRecord> {
	const existing = await readIndexForIncremental(cwd);
	if (!existing) return rebuildIndex(cwd);

	let changedRun: WorkflowRunRecord;
	try {
		changedRun = await readRunRecord(cwd, changedRunId);
	} catch {
		return rebuildIndex(cwd);
	}

	const changedEntry = buildIndexEntry(cwd, changedRun);
	const entries = existing.runs
		.filter((entry) => entry.runId !== changedRun.runId)
		.map(stripIndexTaskRows)
		.concat(changedEntry);
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
		index = await readIndex(cwd);
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

function stripIndexTaskRows(entry: WorkflowIndexRunEntry): WorkflowIndexRunEntry {
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
	return next;
}

export function summarizeTasks(tasks: WorkflowTaskRunRecord[]): TaskSummary {
	const summary = emptySummary();
	for (const task of tasks) {
		summary[task.status] += 1;
		summary.total += 1;
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
	return true;
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
		artifactGraph: taskArtifactGraph,
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
	return join(cwd, ".pi", "workflows", runId, "supervisor-lease.json");
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
