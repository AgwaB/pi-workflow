import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	link,
	lstat,
	mkdir,
	open,
	realpath,
	rm,
	rename,
	stat,
	type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

let tempSuffixForTests: (() => string) | undefined;
let beforeRenameForTests:
	| ((path: string, temporaryPath: string) => void | Promise<void>)
	| undefined;

export function setSecureAtomicTempSuffixForTests(
	factory: (() => string) | undefined,
): void {
	tempSuffixForTests = factory;
}

/** Test-only fault injection immediately before the atomic rename commit. */
export function setSecureAtomicBeforeRenameHookForTests(
	hook:
		| ((path: string, temporaryPath: string) => void | Promise<void>)
		| undefined,
): void {
	beforeRenameForTests = hook;
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;
const READ_DIRECTORY = constants.O_RDONLY | DIRECTORY | NOFOLLOW;
const PRIVATE_FILE =
	constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW;

/**
 * Open every ancestor with O_NOFOLLOW and retain its descriptor while doing
 * the publication. Path operations are paired with descriptor/name identity
 * checks; a path-only mkdir/open would allow an ancestor swap to escape.
 */
export async function ensurePrivateDirectory(path: string): Promise<void> {
	const directory = await openPrivateDirectory(path, true);
	try {
		await assertNamedDirectory(directory);
		await directory.handle.chmod(0o700);
		await directory.handle.sync().catch(ignoreDirectorySyncError);
	} finally {
		await directory.handle.close().catch(() => undefined);
	}
}

export async function appendPrivateFile(
	path: string,
	content: string | Uint8Array,
): Promise<void> {
	const parent = await openPrivateParent(path);
	const target = join(parent.namedPath, basename(resolve(path)));
	let file: FileHandle | undefined;
	try {
		await assertNamedDirectory(parent);
		file = await open(target, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | NOFOLLOW, 0o600);
		await assertSingleRegularFile(file, target);
		await file.chmod(0o600);
		await file.writeFile(content);
		await file.sync();
		await assertNamedDirectory(parent);
	} finally {
		await file?.close().catch(() => undefined);
		await parent.handle.close().catch(() => undefined);
	}
}

export async function writePrivateFileAtomic(
	path: string,
	content: string | Uint8Array,
	options: { signal?: AbortSignal } = {},
): Promise<void> {
	const absolute = resolve(path);
	const parent = await openPrivateParent(absolute);
	const suffix = tempSuffixForTests?.() ?? randomUUID();
	const logicalTmp = `${absolute}.${suffix}.tmp`;
	const tmp = join(parent.namedPath, basename(logicalTmp));
	let file: FileHandle | undefined;
	try {
		await assertNamedDirectory(parent);
		file = await open(tmp, PRIVATE_FILE, 0o600);
		await file.writeFile(content);
		await file.sync();
		await file.close();
		file = undefined;
		// Cancellation is checked before the commit. Once rename starts, commit
		// wins and the caller must observe its result.
		if (options.signal?.aborted) throw options.signal.reason ?? new Error("aborted");
		await beforeRenameForTests?.(absolute, logicalTmp);
		if (options.signal?.aborted) throw options.signal.reason ?? new Error("aborted");
		await assertNamedDirectory(parent);
		await rename(tmp, join(parent.namedPath, basename(absolute)));
		const publishedPath = join(parent.namedPath, basename(absolute));
		const published = await open(publishedPath, constants.O_RDONLY | NOFOLLOW);
		try {
			await assertSingleRegularFile(published, publishedPath);
			await published.chmod(0o600);
		} finally {
			await published.close().catch(() => undefined);
		}
		await parent.handle.sync().catch(ignoreDirectorySyncError);
	} finally {
		await file?.close().catch(() => undefined);
		await removeTemporaryPath(parent, tmp, false);
		await parent.handle.close().catch(() => undefined);
	}
}

/** Publish a fully initialized private lock generation without following ancestors. */
export async function publishPrivateGenerationDirectory(
	path: string,
	ownerName: string,
	ownerContent: string | Uint8Array,
): Promise<void> {
	const absolute = resolve(path);
	if (!ownerName || basename(ownerName) !== ownerName || ownerName === "." || ownerName === "..")
		throw new Error("generation owner name must be a single path component");
	const parent = await openPrivateParent(absolute);
	const temporaryPath = `${absolute}.generation-${randomUUID()}`;
	const temporary = join(parent.namedPath, basename(temporaryPath));
	let generation: FileHandle | undefined;
	try {
		await assertNamedDirectory(parent);
		await mkdir(temporary, { mode: 0o700 });
		generation = await open(temporary, READ_DIRECTORY);
		await assertDirectoryHandleMatchesPath(generation, temporary);
		await generation.chmod(0o700);
		const owner = await open(join(temporary, ownerName), PRIVATE_FILE, 0o600);
		try {
			await owner.writeFile(ownerContent);
			await owner.sync();
		} finally {
			await owner.close().catch(() => undefined);
		}
		await generation.sync().catch(ignoreDirectorySyncError);
		await assertDestinationAbsent(parent, basename(absolute));
		await beforeRenameForTests?.(absolute, temporaryPath);
		await assertNamedDirectory(parent);
		// Recheck after the hook: generation publication must not replace a
		// destination created while the generation was being prepared.
		await assertDestinationAbsent(parent, basename(absolute));
		await rename(temporary, join(parent.namedPath, basename(absolute)));
		const published = await open(join(parent.namedPath, basename(absolute)), READ_DIRECTORY);
		await published.close().catch(() => undefined);
		await parent.handle.sync().catch(ignoreDirectorySyncError);
	} finally {
		await generation?.close().catch(() => undefined);
		await removeTemporaryPath(parent, temporary, true);
		await parent.handle.close().catch(() => undefined);
	}
}

/** Publish a private file without replacing an existing target. */
export async function writePrivateFileNoReplace(
	path: string,
	content: string | Uint8Array,
	options: { signal?: AbortSignal } = {},
): Promise<void> {
	const absolute = resolve(path);
	const parent = await openPrivateParent(absolute);
	const logicalTmp = `${absolute}.${randomUUID()}.tmp`;
	const tmp = join(parent.namedPath, basename(logicalTmp));
	let file: FileHandle | undefined;
	try {
		await assertNamedDirectory(parent);
		file = await open(tmp, PRIVATE_FILE, 0o600);
		await file.writeFile(content);
		await file.sync();
		await file.close();
		file = undefined;
		if (options.signal?.aborted) throw options.signal.reason ?? new Error("aborted");
		await assertNamedDirectory(parent);
		await link(tmp, join(parent.namedPath, basename(absolute)));
		await assertNamedDirectory(parent);
		await removeTemporaryPath(parent, tmp, false);
		await parent.handle.sync().catch(ignoreDirectorySyncError);
	} finally {
		await file?.close().catch(() => undefined);
		await removeTemporaryPath(parent, tmp, false);
		await parent.handle.close().catch(() => undefined);
	}
}

async function removeTemporaryPath(
	parent: OpenDirectory,
	path: string,
	recursive: boolean,
): Promise<void> {
	try {
		await assertNamedDirectory(parent);
		const info = await lstat(path);
		if (info.isSymbolicLink()) return;
		await rm(path, { force: true, ...(recursive ? { recursive: true } : {}) });
	} catch {
		// Never clean through a path whose ancestor identity changed. The
		// descriptor remains authoritative; an orphaned temp is safer than
		// deleting an attacker-controlled external file.
	}
}

type OpenDirectory = { handle: FileHandle; namedPath: string };

async function openPrivateParent(path: string): Promise<OpenDirectory> {
	const absolute = resolve(path);
	const parent = await openPrivateDirectory(dirname(absolute), true);
	try {
		await assertNamedDirectory(parent);
		if (parent.namedPath !== sep) await parent.handle.chmod(0o700);
		return parent;
	} catch (error) {
		await parent.handle.close().catch(() => undefined);
		throw error;
	}
}

async function openPrivateDirectory(path: string, create: boolean): Promise<OpenDirectory> {
	const absolute = resolve(path);
	if (process.platform === "win32" || constants.O_NOFOLLOW === undefined) {
		throw new Error("secure filesystem containment is unavailable on this platform");
	}
	const canonical = await canonicalDirectoryPath(absolute);
	let current = await open(sep, READ_DIRECTORY);
	let currentPath: string = sep;
	try {
		for (const component of canonical.slice(1).split(sep).filter(Boolean) ) {
			const nextPath = join(currentPath, component);
			if (create) {
				try {
					await mkdir(nextPath, { mode: 0o700 });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				}
			}
			const next = await open(nextPath, READ_DIRECTORY);
			await assertDirectoryHandleMatchesPath(next, nextPath);
			await current.close();
			current = next;
			currentPath = nextPath;
		}
		return { handle: current, namedPath: absolute };
	} catch (error) {
		await current.close().catch(() => undefined);
		throw error;
	}
}

async function canonicalDirectoryPath(path: string): Promise<string> {
	const absolute = resolve(path);
	let existing = absolute;
	const missing: string[] = [];
	for (;;) {
		try {
			const info = await lstat(existing);
			if (!info.isDirectory()) throw new Error("secure directory is not a directory");
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = dirname(existing);
			if (parent === existing) throw error;
			missing.unshift(basename(existing));
			existing = parent;
		}
	}
	// Do not silently canonicalize an attacker-controlled symlink. macOS
	// exposes /var as a system symlink, so that one stable platform alias is
	// accepted; all application ancestors must be real directories.
	let cursor: string = sep;
	for (const component of existing.slice(1).split(sep).filter(Boolean)) {
		cursor = join(cursor, component);
		const info = await lstat(cursor);
		if (info.isSymbolicLink() && !isAllowedSystemDirectoryAlias(cursor))
			throw new Error("secure directory ancestor must not be a symlink");
	}
	return join(await realpath(existing), ...missing);
}

function isAllowedSystemDirectoryAlias(path: string): boolean {
	return process.platform === "darwin" && (path === "/var" || path === "/tmp");
}

async function assertDirectoryHandleMatchesPath(
	directory: FileHandle,
	path: string,
): Promise<void> {
	const opened = await directory.stat();
	const named = await lstat(path);
	if (!opened.isDirectory() || !sameIdentity(opened, named))
		throw new Error("secure directory changed during write");
}

async function assertNamedDirectory(directory: OpenDirectory): Promise<void> {
	const opened = await directory.handle.stat();
	const named = await stat(directory.namedPath);
	if (!opened.isDirectory() || !sameIdentity(opened, named)) {
		throw new Error("secure directory changed during write");
	}
}

async function assertDestinationAbsent(
	parent: OpenDirectory,
	name: string,
): Promise<void> {
	try {
		await lstat(join(parent.namedPath, name));
		throw Object.assign(new Error("destination already exists"), { code: "EEXIST" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

async function assertSingleRegularFile(
	file: FileHandle,
	path: string,
): Promise<void> {
	const opened = await file.stat();
	const named = await lstat(path);
	if (!opened.isFile() || !sameIdentity(opened, named))
		throw new Error("secure file changed during write");
	if (opened.nlink !== 1) throw new Error("private file must not be hard-linked");
}

function sameIdentity(
	left: { dev: number; ino: number },
	right: { dev: number; ino: number },
): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function ignoreDirectorySyncError(error: unknown): void {
	const code = (error as NodeJS.ErrnoException).code;
	if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EPERM") throw error;
}
