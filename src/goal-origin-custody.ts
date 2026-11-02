import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
	link,
	lstat,
	mkdir,
	open,
	realpath,
	rename,
	readdir,
	rm,
	stat,
	type FileHandle,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { goalHash } from "./goal-contract.js";
import {
	goalFileContentIdentity,
	goalWorkspaceDelta,
	type GoalFileValue,
	type GoalOriginObservation,
	type GoalWorkspaceBaseline,
	type GoalWorkspaceCandidate,
} from "./goal-workspace.js";
import { observeGoalWorkspaceOrigin, type GoalWorkspaceHostHandle } from "./goal-workspace-host.js";
import {
	assertGoalAuthorizedWorkspaceExecutionCurrent,
	assertGoalAuthorizedWorkspaceHostHandle,
} from "./goal-workspace-authority.js";
import {
	ensurePrivateDirectory,
	publishPrivateGenerationDirectory,
	readPrivateFileText,
	writePrivateFileAtomic,
} from "./secure-atomic-write.js";

/**
 * Supported threat model: Goal descendants never receive this capability or a
 * writable origin descriptor. All Goal writes use this host broker. Brokers
 * sharing custodyRoot serialize atomically. An unrelated unsandboxed same-UID
 * writer cannot be excluded by Node; its changes are detected as drift.
 */

export const GOAL_ORIGIN_CUSTODY_THREAT_MODEL = Object.freeze({
	workerOriginWriteAuthority: "none",
	goalWrites: "host-broker-only",
	concurrentGoalWriters: "atomically-serialized",
	unrelatedSameUidWriters:
		"detected-as-drift-or-conflict-not-universally-excluded",
} as const);

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;

interface Identity {
	readonly path: string;
	readonly dev: number;
	readonly ino: number;
}

export interface GoalOriginCustodyAcquireInput {
	readonly originRoot: string;
	readonly scope: readonly string[];
	readonly repository: "git" | "nonGit";
	readonly expectedOriginId?: string;
}

export interface GoalOriginCustodyWrite {
	readonly path: string;
	readonly before: GoalFileValue | null;
	readonly after: GoalFileValue | null;
}

/** Opaque process-local source custody. It exposes no paths or bytes. */
export interface GoalOriginCandidateCustody {
	assertCurrent(): Promise<void>;
	close(options?: { readonly retainEvidence: true }): Promise<void>;
}

export interface GoalOriginCustodyLease {
	readonly originId: string;
	readonly generation: number;
	inspect(): Promise<GoalOriginObservation>;
	compareAndWrite(
		change: GoalOriginCustodyWrite,
		candidate: GoalOriginCandidateCustody,
		beforeMutation?: () => void,
	): Promise<GoalOriginObservation>;
	assertCurrent(): Promise<void>;
	release(): Promise<void>;
}

export interface GoalOriginCustodyRecoveryGrant {
	readonly qualification: "HOST_ONLY";
	readonly productionUse: "RECOVERY_ONLY";
}

export interface GoalOriginCustodyBroker {
	acquire(input: GoalOriginCustodyAcquireInput): Promise<GoalOriginCustodyLease>;
	captureCandidate(
		workspace: GoalWorkspaceHostHandle,
		baseline: GoalWorkspaceBaseline,
		candidate: GoalWorkspaceCandidate,
	): Promise<GoalOriginCandidateCustody>;
	grantRecovery(
		input: GoalOriginCustodyAcquireInput & {
			readonly expectedGeneration: number;
			readonly proveOldWriterGone: () => boolean | Promise<boolean>;
		},
	): Promise<GoalOriginCustodyRecoveryGrant>;
	recover(
		grant: GoalOriginCustodyRecoveryGrant,
	): Promise<GoalOriginCustodyLease>;
	/** Completes the single attempted recovery handoff for an activated lease. */
	commitRecovery(
		grant: GoalOriginCustodyRecoveryGrant,
		lease: GoalOriginCustodyLease,
	): void;
}

interface GrantState {
	readonly broker: object;
	readonly input: GoalOriginCustodyAcquireInput;
	readonly expectedGeneration: number;
	phase: "available" | "attempted" | "consumed";
	readonly allowMissingOwner: boolean;
	activeLease?: GoalOriginCustodyLease;
	retirement?: OriginalGenerationRetirement;
	leaseIdentity?: RetiredLeaseIdentity;
	liveLeaseIdentity?: RetiredLeaseIdentity;
	liveGeneration?: number;
}

interface RetiredLeaseIdentity {
	readonly dev: number;
	readonly ino: number;
	readonly nlink: number;
	readonly nonce: string;
}

interface OriginalGenerationRetirement {
	readonly path: string;
	readonly identity: RetiredLeaseIdentity;
	state: "planned" | "moved" | "removed" | "durable" | "uncertain";
}

const LEASES = new WeakSet<object>();
const GRANTS = new WeakMap<object, GrantState>();
interface StagedCandidateFile {
	readonly handle: FileHandle;
	readonly value: GoalFileValue;
	readonly path: string;
	readonly dev: number;
	readonly ino: number;
	readonly size: number;
	readonly mode: number;
	readonly links: number;
	readonly mtimeMs: number;
	readonly ctimeMs: number;
}
interface NamedFileIdentity {
	readonly dev: number;
	readonly ino: number;
	readonly links: number;
}
interface CandidateState {
	readonly broker: object;
	readonly baselineHash: string;
	readonly candidateHash: string;
	readonly directories: readonly (Identity & { readonly mode: number })[];
	readonly files: Map<string, StagedCandidateFile>;
	readonly delta: ReadonlyMap<string, GoalOriginCustodyWrite>;
	closed: boolean;
	activeCopies: number;
	closeDrain?: () => void;
	closePromise?: Promise<void>;
	retainEvidence?: true;
}
const CANDIDATES = new WeakMap<object, CandidateState>();

function sha(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function sameContent(left: GoalFileValue | null, right: GoalFileValue | null): boolean {
	return goalHash(goalFileContentIdentity(left)) === goalHash(goalFileContentIdentity(right));
}

async function assertCandidateRoot(state: Pick<CandidateState, "directories">): Promise<void> {
	for (const directory of state.directories) {
		const info = await lstat(directory.path);
		if (!info.isDirectory() || info.isSymbolicLink() ||
			info.dev !== directory.dev || info.ino !== directory.ino || info.mode !== directory.mode)
			throw new Error("Goal candidate custody root or ancestor changed");
	}
}

async function verifyStagedDescriptor(
	source: StagedCandidateFile,
	assertRoots: () => Promise<void>,
): Promise<void> {
	const expected = goalFileContentIdentity(source.value);
	if (expected === null) throw new Error("Goal candidate custody source missing");
	const verifyVersion = async (): Promise<void> => {
	await assertRoots();
	const info = await source.handle.stat();
	const named = await lstat(source.path);
	if (
		!info.isFile() || info.dev !== source.dev || info.ino !== source.ino ||
		info.size !== source.size || info.mode !== source.mode ||
		info.nlink !== source.links || info.size !== expected.bytes ||
		!named.isFile() || named.dev !== source.dev || named.ino !== source.ino ||
		named.size !== source.size || named.mode !== source.mode ||
		named.nlink !== source.links ||
		info.mtimeMs !== source.mtimeMs || info.ctimeMs !== source.ctimeMs ||
		named.mtimeMs !== source.mtimeMs || named.ctimeMs !== source.ctimeMs
	)
		throw new Error("Goal candidate custody source descriptor changed");
	await assertRoots();
	};
	await verifyVersion();
	const hash = createHash("sha256");
	const buffer = Buffer.allocUnsafe(64 * 1024);
	let offset = 0;
	let newlines = 0;
	let lastByte = -1;
	for (;;) {
		await verifyVersion();
		const { bytesRead } = await source.handle.read(buffer, 0, buffer.length, offset);
		await verifyVersion();
		if (bytesRead === 0) break;
		const chunk = buffer.subarray(0, bytesRead);
		hash.update(chunk);
		newlines += chunk.reduce((count, byte) => count + (byte === 10 ? 1 : 0), 0);
		lastByte = chunk[chunk.length - 1]!;
		offset += bytesRead;
	}
	const lines = offset === 0 ? 0 : newlines + (lastByte === 10 ? 0 : 1);
	if (offset !== expected.bytes || lines !== expected.lines || hash.digest("hex") !== expected.sha256)
		throw new Error("Goal candidate custody source digest/census mismatch");
	await verifyVersion();
}

async function beginCandidateCopy(state: CandidateState): Promise<() => void> {
	if (state.closed) throw new Error("Goal candidate custody is closed");
	await assertCandidateRoot(state);
	if (state.closed) throw new Error("Goal candidate custody is closed");
	state.activeCopies += 1;
	return () => {
		state.activeCopies -= 1;
		if (state.activeCopies === 0) state.closeDrain?.();
	};
}

function pageBytes(page: {
	encoding: "utf8" | "base64"; content: string; returnedBytes: number; returnedLines: number;
}): Buffer {
	if ((page.encoding !== "utf8" && page.encoding !== "base64") ||
		typeof page.content !== "string" || !Number.isSafeInteger(page.returnedBytes) ||
		page.returnedBytes < 0 || page.returnedBytes > 4096)
		throw new Error("Goal candidate source page encoding or byte bound invalid");
	const bytes = Buffer.from(page.content, page.encoding);
	const lines = bytes.length === 0 ? 0 :
		bytes.reduce((count, byte) => count + (byte === 10 ? 1 : 0), 0) + (bytes.at(-1) === 10 ? 0 : 1);
	if (bytes.length !== page.returnedBytes ||
		bytes.toString(page.encoding) !== page.content || lines !== page.returnedLines)
		throw new Error("Goal candidate source page census mismatch");
	return bytes;
}

async function copyCandidateSource(
	workspace: GoalWorkspaceHostHandle,
	path: string,
	value: GoalFileValue,
	target: FileHandle,
	assertRoots: () => Promise<void>,
): Promise<void> {
	const expected = goalFileContentIdentity(value) as Exclude<ReturnType<typeof goalFileContentIdentity>, null> & {
		sha256: string; bytes: number; lines: number;
	};
	let cursor: string | undefined;
	let bytes = 0, newlines = 0, lastByte = -1;
	const cursors = new Set<string>();
	const hash = createHash("sha256");
	for (;;) {
		assertGoalAuthorizedWorkspaceExecutionCurrent(workspace);
		await assertRoots();
		const source = await workspace.readSourcePage(path, cursor);
		await assertRoots();
		assertGoalAuthorizedWorkspaceExecutionCurrent(workspace);
		if (source.status !== "ok" || source.path !== path ||
			!sameContent(source.artifact, value) ||
			source.artifact.links !== 1 || source.artifact.mode !== value.mode)
			throw new Error("Goal candidate source page identity mismatch");
		const chunk = pageBytes(source.page);
		if (bytes + chunk.length > expected.bytes)
			throw new Error("Goal candidate source page exceeds census");
		for (let written = 0; written < chunk.length;) {
			assertGoalAuthorizedWorkspaceExecutionCurrent(workspace);
			await assertRoots();
			const result = await target.write(chunk, written, chunk.length - written);
			await assertRoots();
			assertGoalAuthorizedWorkspaceExecutionCurrent(workspace);
			if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0 ||
				result.bytesWritten > chunk.length - written)
				throw new Error("Goal candidate capture write made invalid progress");
			written += result.bytesWritten;
		}
		hash.update(chunk);
		bytes += chunk.length;
		newlines += chunk.reduce((count, byte) => count + (byte === 10 ? 1 : 0), 0);
		if (chunk.length) lastByte = chunk[chunk.length - 1]!;
		if (source.page.eof) {
			if (source.page.nextCursor !== null) throw new Error("Goal candidate source EOF cursor invalid");
			break;
		}
		if (!source.page.nextCursor || cursors.has(source.page.nextCursor) || chunk.length === 0)
			throw new Error("Goal candidate source page made no progress");
		cursors.add(source.page.nextCursor);
		cursor = source.page.nextCursor;
	}
	const lines = bytes === 0 ? 0 : newlines + (lastByte === 10 ? 0 : 1);
	if (bytes !== expected.bytes || lines !== expected.lines || hash.digest("hex") !== expected.sha256)
		throw new Error("Goal candidate source digest/census mismatch");
	assertGoalAuthorizedWorkspaceExecutionCurrent(workspace);
}

function privateJson(text: string, label: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (cause) {
		throw new Error(`Goal custody ${label} is invalid`, { cause });
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`Goal custody ${label} is invalid`);
	return value as Record<string, unknown>;
}

function generationRecord(text: string): number {
	const value = privateJson(text, "generation record");
	if (
		Reflect.ownKeys(value).length !== 2 ||
		value.version !== 1 ||
		!Number.isSafeInteger(value.generation) ||
		(value.generation as number) < 0
	)
		throw new Error("Goal custody generation record is invalid");
	return value.generation as number;
}

function ownerRecord(text: string): { generation: number; originId: string; nonce: string } {
	const value = privateJson(text, "owner record");
	if (
		Reflect.ownKeys(value).length !== 4 ||
		value.version !== 1 ||
		!Number.isSafeInteger(value.generation) ||
		(value.generation as number) < 1 ||
		typeof value.originId !== "string" ||
		typeof value.nonce !== "string" ||
		!/^[a-f0-9]{64}$/u.test(value.nonce)
	)
		throw new Error("Goal custody owner record is invalid");
	return { generation: value.generation as number, originId: value.originId, nonce: value.nonce };
}

function recoveryTransitionRecord(text: string): {
	readonly generation: number; readonly successorGeneration: number; readonly originId: string;
} {
	const value = privateJson(text, "recovery transition record");
	if (
		Reflect.ownKeys(value).length !== 4 ||
		value.version !== 1 ||
		!Number.isSafeInteger(value.generation) ||
		!Number.isSafeInteger(value.successorGeneration) ||
		(value.generation as number) < 1 ||
		(value.successorGeneration as number) !== (value.generation as number) + 1 ||
		typeof value.originId !== "string"
	)
		throw new Error("Goal custody recovery transition record is invalid");
	return {
		generation: value.generation as number,
		successorGeneration: value.successorGeneration as number,
		originId: value.originId as string,
	};
}

function validRelativePath(path: string): void {
	if (
		typeof path !== "string" ||
		!path ||
		isAbsolute(path) ||
		path.includes("\\") ||
		path.split("/").some((part) => !part || part === "." || part === "..")
	)
		throw new Error("Goal origin custody path invalid");
}

function validateScope(scope: readonly string[]): string[] {
	if (!Array.isArray(scope) || !scope.length || scope.length > 4096)
		throw new Error("Goal origin custody scope invalid");
	const result = scope.map((path) => {
		validRelativePath(path);
		return path;
	});
	if (new Set(result).size !== result.length)
		throw new Error("Goal origin custody scope contains duplicates");
	return result;
}

async function originIdentity(path: string): Promise<Identity> {
	const canonical = await realpath(resolve(path));
	const info = await lstat(canonical);
	if (!info.isDirectory() || info.isSymbolicLink())
		throw new Error("Goal origin custody root must be a real directory");
	return { path: canonical, dev: info.dev, ino: info.ino };
}

function originId(identity: Identity): string {
	return `origin-${sha(`${identity.path}\0${identity.dev}\0${identity.ino}`).slice(0, 40)}`;
}

async function assertIdentity(expected: Identity): Promise<void> {
	const current = await originIdentity(expected.path);
	if (current.dev !== expected.dev || current.ino !== expected.ino)
		throw new Error("Goal origin custody root identity changed");
}

interface PinnedParent {
	readonly handle: FileHandle;
	readonly path: string;
	readonly dev: number;
	readonly ino: number;
}

async function pinParent(
	root: Identity,
	relativePath: string,
): Promise<PinnedParent[]> {
	validRelativePath(relativePath);
	const result: PinnedParent[] = [];
	let current = root.path;
	try {
		for (const [index, part] of ["", ...relativePath.split("/").slice(0, -1)].entries()) {
			if (part) current = join(current, part);
			const handle = await open(
				current,
				constants.O_RDONLY | DIRECTORY | NOFOLLOW,
			);
			const info = await handle.stat();
			if (!info.isDirectory())
				throw new Error("Goal origin ancestor is not a directory");
			if (index === 0 && (info.dev !== root.dev || info.ino !== root.ino))
				throw new Error("Goal origin root ancestor changed");
			result.push({ handle, path: current, dev: info.dev, ino: info.ino });
		}
		await recheckParents(result);
		return result;
	} catch (error) {
		const failures: unknown[] = [];
		await Promise.all(result.map(async (entry) => {
			try {
				await entry.handle.close();
			} catch (closeError) {
				failures.push(closeError);
			}
		}));
		if (failures.length)
			throw new AggregateError(
				[error, ...failures],
				"Goal origin ancestor cleanup failed",
			);
		throw error;
	}
}

async function recheckParents(parents: readonly PinnedParent[]): Promise<void> {
	for (const parent of parents) {
		const opened = await parent.handle.stat();
		const named = await lstat(parent.path);
		if (
			!opened.isDirectory() ||
			!named.isDirectory() ||
			opened.dev !== parent.dev ||
			opened.ino !== parent.ino ||
			named.dev !== parent.dev ||
			named.ino !== parent.ino
		)
			throw new Error("Goal origin ancestor changed");
	}
}









async function inspectOrigin(identity: Identity, scope: readonly string[], repository: "git" | "nonGit"): Promise<GoalOriginObservation> {
 await assertIdentity(identity);
 const observed = await observeGoalWorkspaceOrigin({ originRoot: identity.path, scope, repository });
 await assertIdentity(identity);
 if (observed.originId !== originId(identity)) throw new Error("Goal custody physical origin identity changed");
 return observed;
}

async function syncDirectory(path: string): Promise<void> {
	const handle = await open(path, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
	try {
		await handle.sync().catch((error: NodeJS.ErrnoException) => {
			if (!["EINVAL", "ENOTSUP", "EPERM"].includes(error.code ?? "")) throw error;
		});
	} finally {
		await handle.close();
	}
}

async function compareAndWrite(
	identity: Identity,
	scope: readonly string[],
	repository: "git" | "nonGit",
	change: GoalOriginCustodyWrite,
	candidate: GoalOriginCandidateCustody,
	beforeMutation?: () => void,
): Promise<GoalOriginObservation> {
	if (!scope.includes(change.path))
		throw new Error("Goal origin write is outside custody scope");
	const staged = CANDIDATES.get(candidate as object);
	if (!staged || staged.closed)
		throw new Error("Goal exact live candidate custody required");
	const admitted = staged.delta.get(change.path);
	if (!admitted || !sameContent(change.before, admitted.before) ||
		!sameContent(change.after, admitted.after))
		throw new Error("Goal candidate custody delta mismatch");
	await candidate.assertCurrent();
	const source = change.after === null ? undefined : staged.files.get(change.path);
	if (change.after !== null && (!source || !sameContent(source.value, change.after)))
		throw new Error("Goal candidate custody manifest mismatch");
	const beforeOrigin = await inspectOrigin(identity, scope, repository);
	const current = beforeOrigin.files.find(
		(entry) => entry.path === change.path,
	)!.worktree;
	if (!sameContent(current, change.before))
		throw new Error("Goal origin preimage conflict");
	const parents = await pinParent(identity, change.path);
	const parent = parents.at(-1)!;
	const target = join(parent.path, basename(change.path));
	let file: FileHandle | undefined;
	let temporary: string | undefined;
	let temporaryIdentity: NamedFileIdentity | undefined;
	let temporarySource: StagedCandidateFile | undefined;
	let endCopy: (() => void) | undefined;
	let failure: unknown;
	try {
		endCopy = await beginCandidateCopy(staged);
		if (source) {
			await verifyStagedDescriptor(source, () => assertCandidateRoot(staged));
		}
		await recheckParents(parents);
		if (change.after === null) {
			if (change.before === null)
				throw new Error("Goal origin no-op delete rejected");
			file = await open(
				target,
				constants.O_RDONLY | NOFOLLOW | constants.O_NONBLOCK,
			);
			const info = await file.stat();
			if (!info.isFile() || info.nlink !== 1)
				throw new Error("Goal origin delete target is unsafe");
			// Mirror replacement's late preimage fence. The open-handle/name identity
			// check prevents deleting a swapped ordinary target; arbitrary same-UID
			// races remain outside the explicitly supported threat model.
			const latest = (await inspectOrigin(identity, [change.path], repository)).files[0]!.worktree;
			if (!sameContent(latest, change.before))
				throw new Error("Goal origin preimage conflict");
			await recheckParents(parents);
			const named = await lstat(target);
			if (named.dev !== info.dev || named.ino !== info.ino || named.nlink !== 1)
				throw new Error("Goal origin delete target identity changed");
			await file.close();
			file = undefined;
			beforeMutation?.();
			await rm(target);
		} else {
			temporary = join(
				parent.path,
				`.${basename(change.path)}.goal-${randomBytes(16).toString("hex")}.tmp`,
			);
			beforeMutation?.();
			file = await open(
				temporary,
				constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
				Number.parseInt(change.after.mode, 8),
			);
			const created = await file.stat();
			const createdName = await lstat(temporary);
			if (
				!created.isFile() || created.nlink !== 1 ||
				!createdName.isFile() || createdName.dev !== created.dev ||
				createdName.ino !== created.ino
			)
				throw new Error("Goal origin temporary descriptor is unsafe");
			temporaryIdentity = { dev: created.dev, ino: created.ino, links: created.nlink };
			beforeMutation?.();
			const info = await source!.handle.stat();
			const expected = goalFileContentIdentity(change.after) as {
				sha256: string; bytes: number; lines: number;
			};
			if (
				!info.isFile() || info.dev !== source!.dev || info.ino !== source!.ino ||
				info.mode !== source!.mode || info.nlink !== source!.links ||
				info.size !== source!.size || info.size !== expected.bytes
			)
				throw new Error("Goal candidate custody source changed");
			const hash = createHash("sha256");
			let offset = 0;
			let newlines = 0;
			let lastByte = -1;
			const chunk = Buffer.allocUnsafe(64 * 1024);
			for (;;) {
				await candidate.assertCurrent();
				await recheckParents(parents);
				beforeMutation?.();
				const { bytesRead } = await source!.handle.read(chunk, 0, chunk.length, offset);
				await recheckParents(parents);
				await candidate.assertCurrent();
				beforeMutation?.();
				if (bytesRead === 0) break;
				const copied = chunk.subarray(0, bytesRead);
				for (let written = 0; written < copied.length;) {
					await candidate.assertCurrent();
					await recheckParents(parents);
					beforeMutation?.();
					const result = await file.write(copied, written, copied.length - written);
					await recheckParents(parents);
					beforeMutation?.();
					await candidate.assertCurrent();
					if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0 ||
						result.bytesWritten > copied.length - written)
						throw new Error("Goal origin staged write made invalid progress");
					written += result.bytesWritten;
				}
				hash.update(copied);
				newlines += copied.reduce((count, byte) => count + (byte === 10 ? 1 : 0), 0);
				lastByte = copied[copied.length - 1]!;
				offset += bytesRead;
			}
			const lines = offset === 0 ? 0 : newlines + (lastByte === 10 ? 0 : 1);
			if (
				offset !== expected.bytes || lines !== expected.lines ||
				hash.digest("hex") !== expected.sha256
			)
				throw new Error("Goal candidate custody source digest mismatch");
			await file.chmod(Number.parseInt(change.after.mode, 8));
			await file.sync();
			const temporaryInfo = await file.stat();
			const temporaryName = await lstat(temporary);
			if (
				!temporaryInfo.isFile() || temporaryInfo.nlink !== 1 ||
				temporaryName.dev !== temporaryInfo.dev ||
				temporaryName.ino !== temporaryInfo.ino ||
				temporaryName.nlink !== 1
			)
				throw new Error("Goal origin temporary descriptor changed");
			temporaryIdentity = {
				dev: temporaryInfo.dev, ino: temporaryInfo.ino, links: temporaryInfo.nlink,
			};
			temporarySource = {
				handle: file, value: change.after, path: temporary,
				dev: temporaryInfo.dev, ino: temporaryInfo.ino,
				size: temporaryInfo.size, mode: temporaryInfo.mode,
				links: temporaryInfo.nlink, mtimeMs: temporaryInfo.mtimeMs,
				ctimeMs: temporaryInfo.ctimeMs,
			};
			await verifyStagedDescriptor(temporarySource, () => recheckParents(parents));
			// Re-inspect immediately before the atomic name commit. This detects
			// ordinary external drift; arbitrary same-UID exclusion is not claimed.
			const latest = (await inspectOrigin(identity, [change.path], repository)).files[0]!.worktree;
			if (!sameContent(latest, change.before))
				throw new Error("Goal origin preimage conflict");
			await recheckParents(parents);
			await verifyStagedDescriptor(temporarySource, () => recheckParents(parents));
			await file.close();
			file = undefined;
			if (change.before === null) {
				// Hard-link publication is atomic and refuses replacement. The
				// temporary and target briefly have two links while both are host-owned.
				beforeMutation?.();
				await link(temporary, target);
				await rm(temporary);
				temporary = undefined;
				temporaryIdentity = undefined;
			} else {
				const { rename } = await import("node:fs/promises");
				beforeMutation?.();
				await rename(temporary, target);
				temporary = undefined;
				temporaryIdentity = undefined;
			}
		}
		await syncDirectory(parent.path);
		await recheckParents(parents);
	} catch (error) {
		failure = error;
		throw error;
	} finally {
		const cleanupErrors: unknown[] = [];
		if (file) {
			try { await file.close(); } catch (error) { cleanupErrors.push(error); }
		}
		if (temporary && temporaryIdentity) {
			try {
				await recheckParents(parents);
				const named = await lstat(temporary);
				if (
					named.dev !== temporaryIdentity.dev || named.ino !== temporaryIdentity.ino ||
					named.nlink !== temporaryIdentity.links
				)
					throw new Error("Goal origin temporary name identity changed");
				await rm(temporary);
			} catch (error) {
				cleanupErrors.push(error);
			}
		}
		await Promise.all(parents.map(async (entry) => {
			try { await entry.handle.close(); } catch (error) { cleanupErrors.push(error); }
		}));
		endCopy?.();
		if (cleanupErrors.length) {
			if (failure)
				throw new AggregateError([failure, ...cleanupErrors], "Goal origin write cleanup failed");
			throw new AggregateError(cleanupErrors, "Goal origin write cleanup failed");
		}
	}
	const after = await inspectOrigin(identity, scope, repository);
	const result = after.files.find(
		(entry) => entry.path === change.path,
	)!.worktree;
	if (!sameContent(result, change.after))
		throw new Error("Goal origin postimage is uncertain");
	return after;
}

export async function createGoalOriginCustodyBroker(
	custodyRootInput: string,
): Promise<GoalOriginCustodyBroker> {
	if (typeof custodyRootInput !== "string" || !isAbsolute(custodyRootInput))
		throw new Error("Goal custody root must be absolute");
	const requestedRoot = resolve(custodyRootInput);
	await ensurePrivateDirectory(requestedRoot);
	const custodyRoot = await realpath(requestedRoot);
	const brokerIdentity = await stat(custodyRoot);
	const directories: (Identity & { readonly mode: number })[] = [];
	for (let path = custodyRoot;; path = dirname(path)) {
		const info = await lstat(path);
		if (!info.isDirectory() || info.isSymbolicLink())
			throw new Error("Goal custody broker ancestor unsafe");
		directories.push({ path, dev: info.dev, ino: info.ino, mode: info.mode });
		if (dirname(path) === path) break;
	}
	const broker = {} as GoalOriginCustodyBroker;
	const retirementPrefix = (key: string) => `${key}.retirement-`;
	const assertNoRetirement = async (key: string): Promise<void> => {
		const names = await readdir(custodyRoot);
		if (names.some((name) => name.startsWith(retirementPrefix(key))))
			throw new Error("Goal custody original retirement unresolved");
	};
	const assertRetiredGeneration = async (
		retirement: OriginalGenerationRetirement,
		generation: number,
		originId: string,
	): Promise<void> => {
		for (const directory of directories) {
			const ancestor = await lstat(directory.path);
			if (!ancestor.isDirectory() || ancestor.isSymbolicLink() ||
				ancestor.dev !== directory.dev || ancestor.ino !== directory.ino ||
				ancestor.mode !== directory.mode)
				throw new Error("Goal custody broker ancestor changed");
		}
		const before = await lstat(retirement.path);
		if (
			!before.isDirectory() || before.isSymbolicLink() ||
			(before.mode & 0o777) !== 0o700 || before.nlink !== retirement.identity.nlink ||
			before.dev !== retirement.identity.dev || before.ino !== retirement.identity.ino
		)
			throw new Error("Goal custody retired lease identity changed");
		const entries = await readdir(retirement.path);
		if (entries.length !== 1 || entries[0] !== "owner.json")
			throw new Error("Goal custody retired lease contains foreign entries");
		const owner = ownerRecord(await readPrivateFileText(join(retirement.path, "owner.json")));
		const after = await lstat(retirement.path);
		if (
			after.dev !== before.dev || after.ino !== before.ino ||
			after.mode !== before.mode || after.nlink !== before.nlink ||
			owner.generation !== generation || owner.originId !== originId ||
			owner.nonce !== retirement.identity.nonce
		)
			throw new Error("Goal custody retired lease generation changed");
	};
	const retireOriginalGeneration = async (
		key: string,
		lockPath: string,
		generation: number,
		originId: string,
		current: () => Promise<void>,
		existing?: OriginalGenerationRetirement,
		identity?: RetiredLeaseIdentity,
		remember?: (retirement: OriginalGenerationRetirement) => void,
	): Promise<OriginalGenerationRetirement> => {
		let retirement = existing;
		if (!retirement) {
			if (!identity) throw new Error("Goal custody original lease identity unavailable");
			retirement = {
			path: join(custodyRoot, `${retirementPrefix(key)}${randomBytes(32).toString("hex")}`),
			identity,
			state: "planned",
			};
			remember?.(retirement);
		}
		if (retirement.state === "planned" || retirement.state === "uncertain") {
			if (retirement.state === "planned") await assertNoRetirement(key);
			await current();
			if (retirement.state === "uncertain") {
				try {
					const moved = await lstat(retirement.path);
					if (!moved.isDirectory() || moved.dev !== retirement.identity.dev ||
						moved.ino !== retirement.identity.ino)
						throw new Error("Goal custody uncertain retirement is foreign");
					retirement.state = "moved";
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			}
			if (retirement.state === "planned" || retirement.state === "uncertain") {
			try {
				await rename(lockPath, retirement.path);
				retirement.state = "moved";
			} catch (error) {
				retirement.state = "uncertain";
				throw error;
			}
			}
		}
		await assertRetiredGeneration(retirement, generation, originId);
		return retirement;
	};
	const removeRetiredGeneration = async (
		retirement: OriginalGenerationRetirement,
		generation: number,
		originId: string,
	): Promise<void> => {
		if (retirement.state === "removed" || retirement.state === "durable") return;
		await assertRetiredGeneration(retirement, generation, originId);
		await rm(retirement.path, { recursive: true });
		retirement.state = "removed";
	};

	const capture = async (input: GoalOriginCustodyAcquireInput) => {
		if (
			!input ||
			typeof input !== "object" ||
			(input.repository !== "git" && input.repository !== "nonGit")
		)
			throw new Error("Goal custody request invalid");
		const scope = validateScope(input.scope);
		const identity = await originIdentity(input.originRoot);
		const id = originId(identity);
		if (input.expectedOriginId !== undefined && input.expectedOriginId !== id)
			throw new Error("Goal custody physical origin identity mismatch");
		const key = sha(`${identity.path}\0${identity.dev}\0${identity.ino}`);
		return {
			input: {
				originRoot: identity.path,
				scope,
				repository: input.repository,
				expectedOriginId: id,
			},
			identity,
			id,
			key,
		};
	};

	const activate = async (
		captured: Awaited<ReturnType<typeof capture>>,
		replacement?: {
			readonly generation: number;
			readonly allowMissingOwner: boolean;
			readonly leaseIdentity?: RetiredLeaseIdentity;
			readonly liveLeaseIdentity?: RetiredLeaseIdentity;
			readonly liveGeneration?: number;
			retirement?: OriginalGenerationRetirement;
			rememberRetirement?: (retirement: OriginalGenerationRetirement) => void;
			rememberLiveLease?: (identity: RetiredLeaseIdentity, generation: number) => void;
		},
		onRelease?: (generation: number, lease: GoalOriginCustodyLease) => void,
	): Promise<GoalOriginCustodyLease> => {
		const generationPath = join(custodyRoot, `${captured.key}.generation.json`);
		const lockPath = join(custodyRoot, `${captured.key}.lease`);
		const transitionPath = join(custodyRoot, `${captured.key}.recovery.json`);
		let generation = 0;
		let retirement: OriginalGenerationRetirement | undefined;
		let originalLeaseIdentity = replacement?.retirement?.identity ?? replacement?.leaseIdentity;
		let liveLeaseIdentity: RetiredLeaseIdentity | undefined;
		if (replacement) {
			retirement = replacement.retirement;
			let ownerPresent = false;
			if (!retirement) {
				try {
					const owner = ownerRecord(
						await readPrivateFileText(join(lockPath, "owner.json")),
					);
					if (
						owner.generation !== replacement.generation ||
						owner.originId !== captured.id
					)
						throw new Error("Goal custody recovery generation conflict");
					ownerPresent = true;
				} catch (error) {
					if (
						(error as NodeJS.ErrnoException).code !== "ENOENT" ||
						!replacement.allowMissingOwner
					)
						throw error;
					try {
						await lstat(lockPath);
						throw new Error("Goal custody recovery owner record unavailable");
					} catch (leaseError) {
						if ((leaseError as NodeJS.ErrnoException).code !== "ENOENT")
							throw leaseError;
					}
				}
				if (ownerPresent) {
					const leaseInfo = await lstat(lockPath);
					const originalOwner = ownerRecord(await readPrivateFileText(join(lockPath, "owner.json")));
					const observedIdentity = { dev: leaseInfo.dev, ino: leaseInfo.ino, nlink: leaseInfo.nlink, nonce: originalOwner.nonce };
					if (replacement.leaseIdentity &&
						(replacement.leaseIdentity.dev !== observedIdentity.dev ||
						 replacement.leaseIdentity.ino !== observedIdentity.ino ||
						 replacement.leaseIdentity.nlink !== observedIdentity.nlink ||
						 replacement.leaseIdentity.nonce !== observedIdentity.nonce))
						throw new Error("Goal custody recovery original lease identity changed");
					originalLeaseIdentity = replacement.leaseIdentity ?? observedIdentity;
					retirement = await retireOriginalGeneration(
						captured.key, lockPath, replacement.generation, captured.id,
						async () => undefined, undefined, originalLeaseIdentity,
						(value) => { replacement.retirement = value; replacement.rememberRetirement?.(value); },
					);
					replacement.retirement = retirement;
					replacement.rememberRetirement?.(retirement);
				} else {
					const durableGeneration = generationRecord(
						await readPrivateFileText(generationPath),
					);
					if (durableGeneration !== replacement.generation) {
						const transition = recoveryTransitionRecord(
							await readPrivateFileText(transitionPath),
						);
						if (
							transition.generation !== replacement.generation ||
							transition.successorGeneration !== durableGeneration ||
							transition.originId !== captured.id
						)
							throw new Error("Goal custody recovery generation conflict");
					}
				}
			}
			try {
				const transition = recoveryTransitionRecord(
					await readPrivateFileText(transitionPath),
				);
				if (
					transition.generation !== replacement.generation ||
					transition.originId !== captured.id
				)
					throw new Error("Goal custody recovery generation conflict");
				generation = transition.successorGeneration;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				generation = replacement.generation + 1;
				await writePrivateFileAtomic(
					transitionPath,
					JSON.stringify({
						version: 1,
						generation: replacement.generation,
						successorGeneration: generation,
						originId: captured.id,
					}),
				);
			}
			await writePrivateFileAtomic(
				generationPath,
				JSON.stringify({ version: 1, generation }),
			);
			if (replacement?.liveGeneration !== undefined && replacement.liveGeneration !== generation)
				throw new Error("Goal custody recovered generation changed");
		} else {
			await assertNoRetirement(captured.key);
			try {
				generation = generationRecord(await readPrivateFileText(generationPath));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			generation += 1;
			await writePrivateFileAtomic(
				generationPath,
				JSON.stringify({ version: 1, generation }),
			);
		}
		try {
			// The visible lease name is published only after owner metadata and the
			// prepared directory are durable. A crash can leave an unreachable
			// generation gap or uniquely named preparation residue, never an
			// ownerless lease that blocks explicit recovery.
			const nonce = replacement?.liveLeaseIdentity?.nonce ?? randomBytes(32).toString("hex");
			if (replacement?.liveLeaseIdentity) {
				const current = await lstat(lockPath);
				const owner = ownerRecord(await readPrivateFileText(join(lockPath, "owner.json")));
				if (current.dev !== replacement.liveLeaseIdentity.dev ||
					current.ino !== replacement.liveLeaseIdentity.ino ||
					current.nlink !== replacement.liveLeaseIdentity.nlink || owner.nonce !== nonce ||
					owner.generation !== generation || owner.originId !== captured.id)
					throw new Error("Goal custody recovered live lease identity changed");
				liveLeaseIdentity = replacement.liveLeaseIdentity;
			} else {
				const identity = await publishPrivateGenerationDirectory(
				lockPath,
				"owner.json",
				JSON.stringify({
					version: 1,
					generation,
					nonce,
					originId: captured.id,
				}),
				);
				liveLeaseIdentity = { ...identity, nonce };
			}
			const published = await lstat(lockPath);
			if (!published.isDirectory() || published.isSymbolicLink() ||
				published.dev !== liveLeaseIdentity.dev || published.ino !== liveLeaseIdentity.ino ||
				published.nlink !== liveLeaseIdentity.nlink)
				throw new Error("Goal custody published lease physical identity changed");
			replacement?.rememberLiveLease?.(liveLeaseIdentity, generation);
			if (!replacement || !retirement) await assertNoRetirement(captured.key);
			if (retirement) {
				if (!replacement) throw new Error("Goal custody retirement lacks original recovery ownership");
				await removeRetiredGeneration(retirement, replacement.generation, captured.id);
				await syncDirectory(custodyRoot);
				retirement.state = "durable";
			}
			if (replacement) await rm(transitionPath);
		} catch (error) {
			// Never remove the visible name here: EEXIST belongs to a current
			// lease, while any error after atomic rename leaves a complete owner
			// generation that must require explicit old-writer-gone recovery.
			throw error;
		}
		let released = false;
		let retiring = false;
		let removed = false;
		let durable = false;
		let releasing: Promise<void> | undefined;
		let leaseRetirement: OriginalGenerationRetirement | undefined;
		const assertLeaseIdentity = async (): Promise<void> => {
			const checkBroker = async () => {
				for (const directory of directories) {
					const info = await lstat(directory.path);
					if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== directory.dev ||
						info.ino !== directory.ino || info.mode !== directory.mode)
						throw new Error("Goal custody broker root or ancestor changed");
				}
				const currentBroker = await stat(custodyRoot);
				if (currentBroker.dev !== brokerIdentity.dev || currentBroker.ino !== brokerIdentity.ino)
					throw new Error("Goal custody broker root changed");
			};
			await checkBroker();
			const owner = ownerRecord(await readPrivateFileText(join(lockPath, "owner.json")));
			const leaseInfo = await lstat(lockPath);
			if (!liveLeaseIdentity || leaseInfo.dev !== liveLeaseIdentity.dev ||
				leaseInfo.ino !== liveLeaseIdentity.ino || leaseInfo.nlink !== liveLeaseIdentity.nlink ||
				owner.nonce !== liveLeaseIdentity.nonce ||
				owner.generation !== generation || owner.originId !== captured.id)
				throw new Error("Goal custody generation changed");
			await assertIdentity(captured.identity);
			await checkBroker();
		};
		const assertCurrent = async (): Promise<void> => {
			const live = () => {
				if (released) throw new Error("Goal origin custody lease released");
				if (retiring) throw new Error("Goal origin custody lease retiring");
			};
			live();
			await assertLeaseIdentity();
			live();
		};
		let lease: GoalOriginCustodyLease;
		lease = Object.freeze({
			originId: captured.id,
			generation,
			async inspect() {
				await assertCurrent();
				const value = await inspectOrigin(
					captured.identity,
					captured.input.scope,
					captured.input.repository,
				);
				await assertCurrent();
				return value;
			},
			async compareAndWrite(change: GoalOriginCustodyWrite, candidate: GoalOriginCandidateCustody, beforeMutation?: () => void) {
				await assertCurrent();
				const candidateState = CANDIDATES.get(candidate as object);
				if (!candidateState || candidateState.broker !== broker)
					throw new Error("Goal candidate custody broker mismatch");
				const value = await compareAndWrite(
					captured.identity,
					captured.input.scope,
					captured.input.repository,
					change,
					candidate,
					beforeMutation,
				);
				await assertCurrent();
				return value;
			},
			assertCurrent,
			async release() {
				if (released) return;
				retiring = true;
				if (!releasing) {
					releasing = (async () => {
						if (!removed) {
							leaseRetirement = await retireOriginalGeneration(
								captured.key, lockPath, generation, captured.id, assertLeaseIdentity, leaseRetirement,
								liveLeaseIdentity,
								(value) => { leaseRetirement = value; },
							);
							await removeRetiredGeneration(leaseRetirement, generation, captured.id);
							removed = true;
						}
						if (!durable) {
							await syncDirectory(custodyRoot);
							durable = true;
							if (leaseRetirement) leaseRetirement.state = "durable";
						}
						onRelease?.(generation, lease);
						released = true;
					})();
				}
				try {
					await releasing;
				} finally {
					if (!released) releasing = undefined;
				}
			},
		});
		LEASES.add(lease as object);
		return lease;
	};
	const inspectRecoveryBaseline = async (
		captured: Awaited<ReturnType<typeof capture>>,
		expectedGeneration: number,
	): Promise<{ allowMissingOwner: boolean; leaseIdentity?: RetiredLeaseIdentity }> => {
		const generationPath = join(custodyRoot, `${captured.key}.generation.json`);
		const lockPath = join(custodyRoot, `${captured.key}.lease`);
		const transitionPath = join(custodyRoot, `${captured.key}.recovery.json`);
		try {
			const owner = ownerRecord(
				await readPrivateFileText(join(lockPath, "owner.json")),
			);
			if (
				owner.generation !== expectedGeneration ||
				owner.originId !== captured.id
			)
				throw new Error("Goal custody recovery generation conflict");
			const info = await lstat(lockPath);
			const confirmed = ownerRecord(await readPrivateFileText(join(lockPath, "owner.json")));
			const after = await lstat(lockPath);
			if (info.dev !== after.dev || info.ino !== after.ino || info.nlink !== after.nlink ||
				info.mode !== after.mode ||
				confirmed.nonce !== owner.nonce || confirmed.generation !== owner.generation ||
				confirmed.originId !== owner.originId)
				throw new Error("Goal custody recovery baseline changed");
			return { allowMissingOwner: false, leaseIdentity: { dev: info.dev, ino: info.ino, nlink: info.nlink, nonce: owner.nonce } };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			try {
				await lstat(lockPath);
				throw new Error("Goal custody recovery owner record unavailable");
			} catch (leaseError) {
				if ((leaseError as NodeJS.ErrnoException).code !== "ENOENT")
					throw leaseError;
			}
			const durableGeneration = generationRecord(await readPrivateFileText(generationPath));
			if (durableGeneration !== expectedGeneration) {
				const transition = recoveryTransitionRecord(
					await readPrivateFileText(transitionPath),
				);
				if (
					transition.generation !== expectedGeneration ||
					transition.successorGeneration !== durableGeneration ||
					transition.originId !== captured.id
				)
					throw new Error("Goal custody recovery generation conflict");
			}
			return { allowMissingOwner: true };
		}
	};
	const captureCandidate = async (
		workspace: GoalWorkspaceHostHandle,
		baselineInput: GoalWorkspaceBaseline,
		candidateInput: GoalWorkspaceCandidate,
	): Promise<GoalOriginCandidateCustody> => {
		assertGoalAuthorizedWorkspaceHostHandle(workspace);
		assertGoalAuthorizedWorkspaceExecutionCurrent(workspace);
		const baselineHash = goalHash(workspace.baseline);
		if (baselineHash !== goalHash(baselineInput))
			throw new Error("Goal candidate custody workspace baseline mismatch");
		const observed = await workspace.inspectCandidate();
		assertGoalAuthorizedWorkspaceExecutionCurrent(workspace);
		const candidateHash = goalHash(observed);
		if (candidateHash !== goalHash(candidateInput))
			throw new Error("Goal candidate custody workspace candidate mismatch");
		const delta = goalWorkspaceDelta(workspace.baseline, observed);
		const root = join(custodyRoot, `candidate-${randomBytes(24).toString("hex")}`);
		const files = new Map<string, StagedCandidateFile>();
		await assertCandidateRoot({ directories });
		await mkdir(root, { mode: 0o700 });
		await assertCandidateRoot({ directories });
		const rootInfo = await lstat(root);
		if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || rootInfo.mode !== 0o40700)
			throw new Error("Goal candidate custody root unsafe");
		const state: CandidateState = {
			broker, baselineHash, candidateHash,
			directories: [{ path: root, dev: rootInfo.dev, ino: rootInfo.ino, mode: rootInfo.mode }, ...directories],
			files, delta: new Map(delta.paths.map(change => [change.path, change])),
			closed: false, activeCopies: 0,
		};
		try {
			for (const change of delta.paths) {
				if (change.after === null) continue;
				await assertCandidateRoot(state);
				const staged = join(root, sha(change.path));
				const handle = await open(
					staged,
					constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
					0o600,
				);
				try {
					await copyCandidateSource(workspace, change.path, change.after, handle, () => assertCandidateRoot(state));
					await handle.sync();
					await assertCandidateRoot(state);
					const info = await handle.stat();
					if (!info.isFile() || info.nlink !== 1 || info.mode !== 0o100600)
						throw new Error("Goal candidate custody staged file unsafe");
					const descriptor = {
						handle, value: change.after, path: staged, dev: info.dev, ino: info.ino,
						size: info.size, mode: info.mode, links: info.nlink,
						mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs,
					};
					await verifyStagedDescriptor(descriptor, () => assertCandidateRoot(state));
					files.set(change.path, descriptor);
				} catch (error) {
					try {
						await handle.close();
					} catch (closeError) {
						throw new AggregateError(
							[error, closeError],
							"Goal candidate custody staged descriptor cleanup failed",
						);
					}
					throw error;
				}
				assertGoalAuthorizedWorkspaceExecutionCurrent(workspace);
			}
			const finalCandidate = await workspace.inspectCandidate();
			assertGoalAuthorizedWorkspaceExecutionCurrent(workspace);
			if (goalHash(finalCandidate) !== candidateHash)
				throw new Error("Goal candidate changed during custody capture");
			await assertCandidateRoot(state);
			let token: GoalOriginCandidateCustody;
			token = Object.freeze({
				async assertCurrent() {
					if (state.closed || CANDIDATES.get(token as object) !== state)
						throw new Error("Goal candidate custody is closed");
					const endRead = await beginCandidateCopy(state);
					try {
						for (const source of state.files.values())
							await verifyStagedDescriptor(source, () => assertCandidateRoot(state));
						await assertCandidateRoot(state);
						if (state.closed) throw new Error("Goal candidate custody is closed");
					} finally { endRead(); }
				},
				close(options?: { readonly retainEvidence: true }) {
					if (options?.retainEvidence) state.retainEvidence = true;
					if (state.closePromise) return state.closePromise;
					state.closed = true;
					state.closePromise = (async () => {
					const failures: unknown[] = [];
					if (state.activeCopies) await new Promise<void>(resolve => {
						state.closeDrain = resolve;
					});
					await Promise.all([...files.values()].map(async ({ handle }) => {
						try { await handle.close(); } catch (error) { failures.push(error); }
					}));
					if (!state.retainEvidence && !failures.length) {
						try {
							await assertCandidateRoot(state);
							await rm(root, { recursive: true });
						} catch (error) {
							failures.push(error);
						}
					}
					if (failures.length) throw new AggregateError(failures, "Goal candidate custody cleanup failed");
					})().catch(error => {
						// Retry is cleanup of these original descriptors only;
						// state.closed permanently fences reads and writes.
						state.closePromise = undefined;
						throw error;
					});
					return state.closePromise;
				},
			});
			CANDIDATES.set(token as object, state);
			return token;
		} catch (error) {
			const failures: unknown[] = [];
			await Promise.all([...files.values()].map(async ({ handle }) => {
				try { await handle.close(); } catch (closeError) { failures.push(closeError); }
			}));
			try {
				await assertCandidateRoot(state);
				await rm(root, { recursive: true });
			} catch (cleanupError) { failures.push(cleanupError); }
			if (failures.length) throw new AggregateError([error, ...failures], "Goal candidate custody capture cleanup failed");
			throw error;
		}
	};

	Object.assign(broker, {
		captureCandidate,
		async acquire(input: GoalOriginCustodyAcquireInput) {
			try {
				return await activate(await capture(input));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST")
					throw new Error("Goal physical origin is already in custody", {
						cause: error,
					});
				throw error;
			}
		},
		async grantRecovery(
			input: GoalOriginCustodyAcquireInput & {
				expectedGeneration: number;
				proveOldWriterGone: () => boolean | Promise<boolean>;
			},
		) {
			if (
				!Number.isSafeInteger(input.expectedGeneration) ||
				input.expectedGeneration < 1 ||
				typeof input.proveOldWriterGone !== "function"
			)
				throw new Error("Goal custody recovery request invalid");
			const captured = await capture(input);
			const baseline = await inspectRecoveryBaseline(
				captured,
				input.expectedGeneration,
			);
			if (!(await input.proveOldWriterGone()))
				throw new Error("Goal custody old writer is not proven gone");
			const rechecked = await capture(input);
			const recheckedBaseline = await inspectRecoveryBaseline(
				rechecked,
				input.expectedGeneration,
			);
			if (
				rechecked.key !== captured.key ||
				rechecked.id !== captured.id ||
				recheckedBaseline.allowMissingOwner !== baseline.allowMissingOwner ||
				JSON.stringify(recheckedBaseline.leaseIdentity) !== JSON.stringify(baseline.leaseIdentity)
			)
				throw new Error("Goal custody recovery baseline changed");
			const grant = Object.freeze({
				qualification: "HOST_ONLY" as const,
				productionUse: "RECOVERY_ONLY" as const,
			});
			GRANTS.set(grant, {
				broker,
				input: rechecked.input,
				expectedGeneration: input.expectedGeneration,
				phase: "available",
				allowMissingOwner: baseline.allowMissingOwner,
				leaseIdentity: baseline.leaseIdentity,
			});
			return grant;
		},
		async recover(grant: GoalOriginCustodyRecoveryGrant) {
			const state = GRANTS.get(grant as object);
			if (!state || state.broker !== broker || state.phase !== "available")
				throw new Error("Goal exact unused custody recovery grant required");
			state.phase = "attempted";
			try {
				const captured = await capture(state.input);
				const lease = await activate(
					captured,
					{
						generation: state.expectedGeneration,
						allowMissingOwner: state.allowMissingOwner,
						leaseIdentity: state.leaseIdentity,
						liveLeaseIdentity: state.liveLeaseIdentity,
						liveGeneration: state.liveGeneration,
						retirement: state.retirement,
						rememberRetirement: (retirement) => { state.retirement = retirement; },
						rememberLiveLease: (identity, generation) => {
							state.liveLeaseIdentity = identity;
							state.liveGeneration = generation;
						},
					},
					(_generation, releasedLease) => {
						if (state.activeLease === releasedLease)
							state.activeLease = undefined;
					},
				);
				state.activeLease = lease;
				return lease;
			} catch (error) {
				// A recovery grant is process-local and remains the only authority
				// that can resume a prepared transition; durable records never mint it.
				state.phase = "available";
				throw error;
			}
		},
		commitRecovery(
			grant: GoalOriginCustodyRecoveryGrant,
			lease: GoalOriginCustodyLease,
		) {
			const state = GRANTS.get(grant as object);
			if (
				!state ||
				state.broker !== broker ||
				state.phase !== "attempted" ||
				state.activeLease !== lease
			)
				throw new Error("Goal active custody recovery handoff required");
			state.phase = "consumed";
			state.activeLease = undefined;
		},
	});
	return Object.freeze(broker);
}

export function assertGoalOriginCustodyLease(
	value: unknown,
): asserts value is GoalOriginCustodyLease {
	if (!value || typeof value !== "object" || !LEASES.has(value))
		throw new Error("Goal origin custody lease capability required");
}

export function assertGoalOriginCandidateCustody(
	value: unknown,
	baseline: GoalWorkspaceBaseline,
	candidate: GoalWorkspaceCandidate,
): asserts value is GoalOriginCandidateCustody {
	const state = value && typeof value === "object" ? CANDIDATES.get(value) : undefined;
	if (!state || state.closed || state.baselineHash !== goalHash(baseline) ||
		state.candidateHash !== goalHash(candidate))
		throw new Error("Goal exact candidate custody capability required");
}
