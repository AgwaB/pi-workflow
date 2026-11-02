import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface CommittedArtifactRootIdentity {
	readonly root: string;
	readonly dev: number;
	readonly ino: number;
	readonly uid: number;
}

export interface CommittedArtifactRootVersion {
	readonly dev: bigint;
	readonly ino: bigint;
	readonly uid: bigint;
	readonly gid: bigint;
	readonly mode: bigint;
	readonly nlink: bigint;
	readonly size: bigint;
	readonly mtimeNs: bigint;
	readonly ctimeNs: bigint;
	readonly birthtimeNs: bigint;
}

export interface CommittedArtifactReadRoot extends CommittedArtifactRootIdentity {
	readonly version: CommittedArtifactRootVersion;
}

function fail(message: string): never {
	throw new Error(message);
}

interface CommittedArtifactFileVersion {
	readonly dev: bigint;
	readonly ino: bigint;
	readonly uid: bigint;
	readonly gid: bigint;
	readonly mode: bigint;
	readonly nlink: bigint;
	readonly size: bigint;
	readonly mtimeNs: bigint;
	readonly ctimeNs: bigint;
	readonly birthtimeNs: bigint;
}

function committedFileVersion(info: BigIntStats): CommittedArtifactFileVersion {
	return Object.freeze({
		dev: info.dev,
		ino: info.ino,
		uid: info.uid,
		gid: info.gid,
		mode: info.mode,
		nlink: info.nlink,
		size: info.size,
		mtimeNs: info.mtimeNs,
		ctimeNs: info.ctimeNs,
		birthtimeNs: info.birthtimeNs,
	});
}

function sameCommittedFileVersion(
	left: CommittedArtifactFileVersion,
	right: CommittedArtifactFileVersion,
): boolean {
	return left.dev === right.dev &&
		left.ino === right.ino &&
		left.uid === right.uid &&
		left.gid === right.gid &&
		left.mode === right.mode &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs &&
		left.birthtimeNs === right.birthtimeNs;
}

function requireCommittedFile(
	info: BigIntStats,
	expectedLength: number,
	label: string,
): void {
	if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n ||
		info.uid !== BigInt(process.getuid?.() ?? -1) || (info.mode & 0o022n) !== 0n ||
		info.size !== BigInt(expectedLength))
		fail(`${label} is not an exact private regular file`);
}

function committedRootVersion(info: BigIntStats): CommittedArtifactRootVersion {
	return Object.freeze({
		dev: info.dev,
		ino: info.ino,
		uid: info.uid,
		gid: info.gid,
		mode: info.mode,
		nlink: info.nlink,
		size: info.size,
		mtimeNs: info.mtimeNs,
		ctimeNs: info.ctimeNs,
		birthtimeNs: info.birthtimeNs,
	});
}

function sameCommittedRootVersion(
	left: CommittedArtifactRootVersion,
	right: CommittedArtifactRootVersion,
): boolean {
	return left.dev === right.dev &&
		left.ino === right.ino &&
		left.uid === right.uid &&
		left.gid === right.gid &&
		left.mode === right.mode &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs &&
		left.birthtimeNs === right.birthtimeNs;
}

function requireCommittedRootIdentity(
	info: BigIntStats,
	expected: CommittedArtifactRootIdentity,
	label: string,
): void {
	if (!info.isDirectory() || info.isSymbolicLink() ||
		Number(info.dev) !== expected.dev || Number(info.ino) !== expected.ino ||
		Number(info.uid) !== expected.uid || info.uid !== BigInt(process.getuid?.() ?? -1) ||
		(info.mode & 0o022n) !== 0n)
		fail(`${label} containment root identity changed`);
}

function requireCommittedRootVersion(
	info: BigIntStats,
	expected: CommittedArtifactReadRoot,
	label: string,
): void {
	requireCommittedRootIdentity(info, expected, label);
	if (!sameCommittedRootVersion(committedRootVersion(info), expected.version))
		fail(`${label} containment root version changed`);
}

function inside(root: string, path: string): boolean {
	const child = relative(root, path);
	return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

async function readExactDescriptor(
	file: FileHandle,
	expectedLength: number,
	label: string,
): Promise<Buffer> {
	const bytes = Buffer.allocUnsafe(expectedLength + 1);
	let offset = 0;
	while (offset < bytes.length) {
		const read = await file.read(bytes, offset, bytes.length - offset, offset);
		if (read.bytesRead === 0) break;
		offset += read.bytesRead;
	}
	if (offset !== expectedLength)
		fail(`${label} length changed during bounded read`);
	return bytes.subarray(0, expectedLength);
}

export interface CommittedArtifactExactRead {
	readonly path: string;
	readonly expectedBytes: Buffer;
	readonly label: string;
}

interface HeldCommittedArtifact {
	readonly file: FileHandle;
	readonly path: string;
	readonly expectedLength: number;
	readonly label: string;
	readonly version: CommittedArtifactFileVersion;
}

interface AdmittedCommittedArtifactRead {
	status: "pending" | "fulfilled" | "rejected";
	error?: unknown;
	readonly settled: Promise<void>;
}

interface CommittedArtifactReadSession {
	readonly containmentRoot: CommittedArtifactReadRoot;
	readonly rootPath: string;
	readonly root: FileHandle;
	readonly rootVersion: CommittedArtifactRootVersion;
	readonly held: HeldCommittedArtifact[];
	readonly owned: Set<FileHandle>;
	readonly reads: AdmittedCommittedArtifactRead[];
	phase: "callback" | "draining" | "proof" | "closing" | "closed";
}

const COMMITTED_ARTIFACT_READ_SESSION =
	new AsyncLocalStorage<CommittedArtifactReadSession>();

interface CommittedArtifactCleanupFailure extends AggregateError {
	readonly retryCleanup: () => Promise<void>;
}

async function closeOwnedHandlesOnce(
	owned: Set<FileHandle>,
): Promise<unknown[]> {
	const handles = [...owned];
	const settled = await Promise.allSettled(handles.map(
		handle => Promise.resolve().then(() => handle.close()),
	));
	const errors: unknown[] = [];
	for (let index = 0; index < settled.length; index += 1) {
		const result = settled[index]!;
		const handle = handles[index]!;
		if (result.status === "fulfilled") owned.delete(handle);
		else errors.push(result.reason);
	}
	return errors;
}

async function closeOwnedHandles(
	owned: Set<FileHandle>,
	message: string,
): Promise<void> {
	const errors = await closeOwnedHandlesOnce(owned);
	if (errors.length === 0) return;
	let retried = false;
	const failure = new AggregateError(errors, message) as CommittedArtifactCleanupFailure;
	Object.defineProperty(failure, "retryCleanup", {
		enumerable: false,
		value: async (): Promise<void> => {
			if (retried) fail("committed artifact cleanup retry was already attempted");
			retried = true;
			const retryErrors = await closeOwnedHandlesOnce(owned);
			if (retryErrors.length > 0)
				throw new AggregateError(retryErrors, `${message} after one retry`);
		},
	});
	throw failure;
}

function combinePrimaryAndCleanup(
	primary: unknown,
	cleanup: unknown,
	message: string,
): AggregateError {
	return new AggregateError([primary, cleanup], message);
}

async function openCommittedArtifactReadSession(
	containmentRoot: CommittedArtifactReadRoot,
	label: string,
): Promise<CommittedArtifactReadSession> {
	const rootPath = resolve(containmentRoot.root);
	if (rootPath !== containmentRoot.root)
		fail(`${label} containment root is not canonical`);
	const root = await open(
		rootPath,
		constants.O_RDONLY | constants.O_DIRECTORY |
			constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	const owned = new Set<FileHandle>([root]);
	try {
		const [descriptor, named, canonical] = await Promise.all([
			root.stat({ bigint: true }),
			lstat(rootPath, { bigint: true }),
			realpath(rootPath),
		]);
		requireCommittedRootVersion(descriptor, containmentRoot, label);
		requireCommittedRootVersion(named, containmentRoot, label);
		const rootVersion = committedRootVersion(descriptor);
		if (canonical !== rootPath ||
			!sameCommittedRootVersion(rootVersion, committedRootVersion(named)))
			fail(`${label} containment root is not canonical`);
		return {
			containmentRoot,
			rootPath,
			root,
			rootVersion,
			held: [],
			owned,
			reads: [],
			phase: "callback",
		};
	} catch (error) {
		try {
			await closeOwnedHandles(owned, "committed artifact root descriptor failed to close");
		} catch (cleanupError) {
			throw combinePrimaryAndCleanup(
				error,
				cleanupError,
				"committed artifact root validation and cleanup failed",
			);
		}
		throw error;
	}
}

function requireSessionRoot(
	session: CommittedArtifactReadSession,
	containmentRoot: CommittedArtifactReadRoot,
	label: string,
): void {
	if (session.rootPath !== containmentRoot.root ||
		!sameCommittedRootVersion(session.containmentRoot.version, containmentRoot.version))
		fail(`${label} aggregate containment root differs`);
}

async function readCommittedArtifactInSession(
	session: CommittedArtifactReadSession,
	options: CommittedArtifactExactRead,
): Promise<Buffer> {
	const path = resolve(options.path);
	const expectedLength = options.expectedBytes.length;
	if (!inside(session.rootPath, path) || await realpath(path) !== path)
		fail(`${options.label} path is outside canonical containment`);
	const pathBefore = await lstat(path, { bigint: true });
	requireCommittedFile(pathBefore, expectedLength, options.label);
	const file = await open(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	session.owned.add(file);
	const descriptorBefore = await file.stat({ bigint: true });
	requireCommittedFile(descriptorBefore, expectedLength, options.label);
	const version = committedFileVersion(descriptorBefore);
	if (!sameCommittedFileVersion(
		committedFileVersion(pathBefore),
		version,
	))
		fail(`${options.label} path and descriptor identity differ`);
	session.held.push({
		file,
		path,
		expectedLength,
		label: options.label,
		version,
	});
	const bytes = await readExactDescriptor(file, expectedLength, options.label);
	if (!bytes.equals(options.expectedBytes))
		fail(`${options.label} bytes differ from the retained commitment`);
	return bytes;
}

function admitCommittedArtifactRead(
	session: CommittedArtifactReadSession,
	options: CommittedArtifactExactRead,
): Promise<Buffer> {
	if (session.phase !== "callback")
		return Promise.reject(new Error(
			`${options.label} committed artifact aggregate is no longer accepting reads`,
		));
	let settle!: () => void;
	const admitted: AdmittedCommittedArtifactRead = {
		status: "pending",
		settled: new Promise<void>(resolveSettled => {
			settle = resolveSettled;
		}),
	};
	session.reads.push(admitted);
	const operation = readCommittedArtifactInSession(session, options);
	void operation.then(
		() => {
			admitted.status = "fulfilled";
			settle();
		},
		error => {
			admitted.status = "rejected";
			admitted.error = error;
			settle();
		},
	);
	return operation;
}

async function proveCommittedArtifactReadSession(
	session: CommittedArtifactReadSession,
	label: string,
): Promise<void> {
	const artifactChecks = session.held.map(async held => {
		const [descriptor, named, canonical] = await Promise.all([
			held.file.stat({ bigint: true }),
			lstat(held.path, { bigint: true }),
			realpath(held.path),
		]);
		requireCommittedFile(descriptor, held.expectedLength, held.label);
		requireCommittedFile(named, held.expectedLength, held.label);
		if (canonical !== held.path ||
			!sameCommittedFileVersion(held.version, committedFileVersion(descriptor)) ||
			!sameCommittedFileVersion(held.version, committedFileVersion(named)))
			fail(`${held.label} changed during bounded aggregate read`);
	});
	const rootCheck = (async () => {
		const [descriptor, named, canonical] = await Promise.all([
			session.root.stat({ bigint: true }),
			lstat(session.rootPath, { bigint: true }),
			realpath(session.rootPath),
		]);
		requireCommittedRootVersion(descriptor, session.containmentRoot, label);
		requireCommittedRootVersion(named, session.containmentRoot, label);
		if (canonical !== session.rootPath ||
			!sameCommittedRootVersion(
				session.rootVersion,
				committedRootVersion(descriptor),
			) ||
			!sameCommittedRootVersion(
				session.rootVersion,
				committedRootVersion(named),
			))
			fail(`${label} containment root changed during bounded aggregate read`);
	})();
	await Promise.all([...artifactChecks, rootCheck]);
}

async function closeCommittedArtifactReadSession(
	session: CommittedArtifactReadSession,
): Promise<void> {
	await closeOwnedHandles(
		session.owned,
		"committed artifact descriptors failed to close",
	);
}

/**
 * Retain all descriptors and exact file versions until the callback has read
 * every committed artifact and one aggregate proof has crossed its boundary.
 */
export async function withCommittedArtifactReadAggregate<T>(
	containmentRoot: CommittedArtifactReadRoot,
	label: string,
	read: () => Promise<T>,
): Promise<T> {
	if (COMMITTED_ARTIFACT_READ_SESSION.getStore() !== undefined)
		fail(`${label} nested committed artifact aggregate is not allowed`);
	const session = await openCommittedArtifactReadSession(containmentRoot, label);
	let result!: T;
	const primaryErrors: unknown[] = [];
	try {
		try {
			result = await COMMITTED_ARTIFACT_READ_SESSION.run(session, read);
		} catch (error) {
			primaryErrors.push(error);
		}
		session.phase = "draining";
		const pendingAtCallbackReturn = session.reads.filter(
			admitted => admitted.status === "pending",
		);
		await Promise.all(session.reads.map(admitted => admitted.settled));
		for (const admitted of session.reads) {
			if (admitted.status === "rejected" &&
				!primaryErrors.includes(admitted.error))
				primaryErrors.push(admitted.error);
		}
		if (pendingAtCallbackReturn.length > 0)
			primaryErrors.push(new Error(
				`${label} callback returned with ${pendingAtCallbackReturn.length} pending committed artifact read(s)`,
			));
		if (primaryErrors.length === 0) {
			session.phase = "proof";
			try {
				await proveCommittedArtifactReadSession(session, label);
			} catch (error) {
				primaryErrors.push(error);
			}
		}
	} finally {
		session.phase = "closing";
		try {
			await closeCommittedArtifactReadSession(session);
		} catch (cleanupError) {
			const primary = primaryErrors.length === 1
				? primaryErrors[0]
				: new AggregateError(primaryErrors, "committed artifact aggregate failed");
			if (primaryErrors.length > 0)
				throw combinePrimaryAndCleanup(
					primary,
					cleanupError,
					"committed artifact aggregate and cleanup failed",
				);
			throw cleanupError;
		} finally {
			session.phase = "closed";
		}
	}
	if (primaryErrors.length === 1) throw primaryErrors[0];
	if (primaryErrors.length > 1)
		throw new AggregateError(primaryErrors, "committed artifact aggregate failed");
	return result;
}

/** Read a fixed set under one retained root and one aggregate proof boundary. */
export async function readCommittedArtifactsExact(options: {
	readonly containmentRoot: CommittedArtifactReadRoot;
	readonly artifacts: readonly CommittedArtifactExactRead[];
	readonly label: string;
}): Promise<readonly Buffer[]> {
	return withCommittedArtifactReadAggregate(
		options.containmentRoot,
		options.label,
		async () => {
			const bytes: Buffer[] = [];
			for (const artifact of options.artifacts) {
				bytes.push(await readCommittedArtifactExact({
					...artifact,
					containmentRoot: options.containmentRoot,
				}));
			}
			return bytes;
		},
	);
}

/**
 * Capture a post-publication root version while retaining prepare-time root
 * identity as the authority. The returned data is process-local read custody.
 */
export async function captureCommittedArtifactReadRoot(
	retainedRoot: CommittedArtifactRootIdentity,
	label: string,
): Promise<CommittedArtifactReadRoot> {
	const path = resolve(retainedRoot.root);
	if (path !== retainedRoot.root)
		fail(`${label} containment root is not canonical`);
	const root = await open(
		path,
		constants.O_RDONLY | constants.O_DIRECTORY |
			constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	const owned = new Set<FileHandle>([root]);
	let primaryError: unknown;
	let failed = false;
	try {
		const descriptorBefore = await root.stat({ bigint: true });
		const [named, canonical] = await Promise.all([
			lstat(path, { bigint: true }),
			realpath(path),
		]);
		const descriptorAfter = await root.stat({ bigint: true });
		requireCommittedRootIdentity(descriptorBefore, retainedRoot, label);
		requireCommittedRootIdentity(descriptorAfter, retainedRoot, label);
		requireCommittedRootIdentity(named, retainedRoot, label);
		const version = committedRootVersion(descriptorBefore);
		if (canonical !== path ||
			!sameCommittedRootVersion(version, committedRootVersion(named)) ||
			!sameCommittedRootVersion(version, committedRootVersion(descriptorAfter)))
			fail(`${label} containment root changed during version capture`);
		return Object.freeze({ ...retainedRoot, version });
	} catch (error) {
		failed = true;
		primaryError = error;
		throw error;
	} finally {
		try {
			await closeOwnedHandles(
				owned,
				"committed artifact root capture descriptor failed to close",
			);
		} catch (cleanupError) {
			if (failed)
				throw combinePrimaryAndCleanup(
					primaryError,
					cleanupError,
					"committed artifact root capture and cleanup failed",
				);
			throw cleanupError;
		}
	}
}

/**
 * Read and prove caller-retained bytes without deriving authority from disk.
 * The allocation and descriptor reads are bounded to retained bytes plus one.
 */
export async function readCommittedArtifactExact(options: {
	readonly path: string;
	readonly containmentRoot: CommittedArtifactReadRoot;
	readonly expectedBytes: Buffer;
	readonly label: string;
}): Promise<Buffer> {
	const session = COMMITTED_ARTIFACT_READ_SESSION.getStore();
	if (session !== undefined) {
		if (session.phase !== "callback")
			fail(`${options.label} committed artifact aggregate is no longer accepting reads`);
		requireSessionRoot(session, options.containmentRoot, options.label);
		return admitCommittedArtifactRead(session, options);
	}
	const [bytes] = await readCommittedArtifactsExact({
		containmentRoot: options.containmentRoot,
		artifacts: [options],
		label: options.label,
	});
	return bytes!;
}

/** A bounded range read over a caller-retained immutable artifact commitment.
 * The supplied locator remains a filename only after the owner has selected it
 * from its private catalog; this function never turns serialized metadata into
 * authority. */
export async function readCommittedArtifactPage(options: {
	readonly path: string;
	readonly containmentRoot: CommittedArtifactReadRoot;
	readonly expectedSha256: string;
	readonly expectedLength: number;
	readonly offset: number;
	readonly maximumBytes: number;
	readonly label: string;
}): Promise<{ readonly bytes: Buffer; readonly eof: boolean }> {
	if (!/^[a-f0-9]{64}$/.test(options.expectedSha256) ||
		!Number.isSafeInteger(options.expectedLength) || options.expectedLength < 0 ||
		!Number.isSafeInteger(options.offset) || options.offset < 0 ||
		!Number.isSafeInteger(options.maximumBytes) || options.maximumBytes < 1 ||
		options.offset > options.expectedLength)
		fail(`${options.label} invalid committed artifact page request`);
	const rootPath = options.containmentRoot.root;
	const path = resolve(options.path);
	if (!inside(rootPath, path) || await realpath(rootPath) !== rootPath || await realpath(path) !== path)
		fail(`${options.label} path is outside canonical containment`);
	const root = await open(rootPath, constants.O_RDONLY | constants.O_DIRECTORY |
		constants.O_NOFOLLOW | constants.O_NONBLOCK);
	let file: FileHandle | undefined;
	let failed = false, failure: unknown;
	try {
		file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const [rootBefore, namedBefore, descriptorBefore] = await Promise.all([
			root.stat({ bigint: true }), lstat(rootPath, { bigint: true }), file.stat({ bigint: true }),
		]);
		requireCommittedRootVersion(rootBefore, options.containmentRoot, options.label);
		requireCommittedRootVersion(namedBefore, options.containmentRoot, options.label);
		requireCommittedFile(descriptorBefore, options.expectedLength, options.label);
		const version = committedFileVersion(descriptorBefore);
		const named = await lstat(path, { bigint: true });
		if (!sameCommittedFileVersion(version, committedFileVersion(named)))
			fail(`${options.label} path and descriptor identity differ`);
		const end = Math.min(options.expectedLength, options.offset + options.maximumBytes);
		const page = Buffer.allocUnsafe(end - options.offset);
		const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, options.expectedLength)));
		const hash = createHash("sha256");
		let position = 0, pageOffset = 0;
		for (;;) {
			const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
			if (bytesRead === 0) break;
			if (position + bytesRead > options.expectedLength)
				fail(`${options.label} exceeds retained byte census`);
			const value = chunk.subarray(0, bytesRead);
			hash.update(value);
			const from = Math.max(position, options.offset);
			const to = Math.min(position + bytesRead, end);
			if (to > from) {
				value.copy(page, pageOffset, from - position, to - position);
				pageOffset += to - from;
			}
			position += bytesRead;
		}
		if (position !== options.expectedLength || pageOffset !== page.length ||
			hash.digest("hex") !== options.expectedSha256)
			fail(`${options.label} bytes differ from retained commitment`);
		const [rootAfter, namedRootAfter, descriptorAfter, namedAfter, canonicalRoot, canonical] = await Promise.all([
			root.stat({ bigint: true }), lstat(rootPath, { bigint: true }), file.stat({ bigint: true }),
			lstat(path, { bigint: true }), realpath(rootPath), realpath(path),
		]);
		requireCommittedRootVersion(rootAfter, options.containmentRoot, options.label);
		requireCommittedRootVersion(namedRootAfter, options.containmentRoot, options.label);
		requireCommittedFile(descriptorAfter, options.expectedLength, options.label);
		requireCommittedFile(namedAfter, options.expectedLength, options.label);
		if (canonicalRoot !== rootPath || canonical !== path ||
			!sameCommittedFileVersion(version, committedFileVersion(descriptorAfter)) ||
			!sameCommittedFileVersion(version, committedFileVersion(namedAfter)))
			fail(`${options.label} changed during bounded page read`);
		return Object.freeze({ bytes: page, eof: end === options.expectedLength });
	} catch (error) {
		failed = true;
		failure = error;
		throw error;
	} finally {
		const results = await Promise.allSettled((file ? [file, root] : [root]).map(handle => handle.close()));
		const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
		if (errors.length > 0)
			throw new AggregateError(failed ? [failure, ...errors] : errors,
				"Committed artifact page descriptor cleanup failed");
	}
}
