import { randomUUID } from "node:crypto";
import { constants, lstatSync } from "node:fs";
import {
	link,
	lstat,
	mkdir,
	open,
	opendir,
	realpath,
	rm,
	rename,
	stat,
	type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { isProxy } from "node:util/types";

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
export const PRIVATE_DIRECTORY_READ_BATCH_MAX = 4;

/**
 * Open every ancestor with O_NOFOLLOW, retain all descriptors during
 * traversal, and retain the destination descriptor during publication. Path
 * operations are paired with descriptor/name identity checks.
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

/** Read a bounded private regular file without following path symlinks. */
export async function readPrivateFileText(
	path: string,
	maxBytes = 1_048_576,
): Promise<string> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 16_777_216)
		throw new Error("private file size limit is invalid");
	const absolute = resolve(path);
	const parent = await openPrivateDirectory(dirname(absolute), false);
	try {
		return await readPrivateFileFromDirectory(parent, absolute, maxBytes);
	} finally {
		await parent.handle.close().catch(() => undefined);
	}
}

/** Retain only a directory descriptor within one read operation. Every file
 * rechecks named ancestors and its own descriptor; no file bytes are cached. */
export async function withPrivateDirectoryReader<T>(
	path: string,
	operation: (
		read: (name: string, maxBytes: number) => Promise<string>,
		readBatch: (
			names: readonly string[],
			maxBytes: number,
		) => Promise<readonly string[]>,
	) => Promise<T>,
): Promise<T> {
	const absolute = resolve(path);
	const ancestors: Array<{ path: string; dev: number; ino: number; mode: number; uid: number }> = [];
	const paths = new Set<string>();
	// Pin both spellings of the allowed platform aliases, including ancestors
	// such as /private which do not appear in a caller's /var spelling.
	for (const spelling of [absolute, await canonicalDirectoryPath(absolute)]) {
		let cursor: string = sep;
		for (const component of ["", ...spelling.slice(1).split(sep).filter(Boolean)]) {
			if (component) cursor = join(cursor, component);
			if (paths.has(cursor)) continue;
			paths.add(cursor);
			const info = await lstat(cursor);
			if (!info.isDirectory() && !(info.isSymbolicLink() && isAllowedSystemDirectoryAlias(cursor)))
				throw new Error("secure directory ancestor must not be a symlink");
			ancestors.push({ path: cursor, dev: info.dev, ino: info.ino, mode: info.mode, uid: info.uid });
		}
	}
	const parent = await openPrivateDirectory(absolute, false);
	let active = true;
	let pending: Promise<unknown> | undefined;
	const assertAncestors = async (): Promise<void> => {
		// A finite already-captured path inventory; keep every fresh no-follow
		// identity check without scheduling a thread-pool round trip per ancestor.
		// File opens/reads and the descriptor/name check still yield to controls.
		for (const before of ancestors) {
			const now = lstatSync(before.path);
			if (!sameIdentity(before, now) || before.mode !== now.mode || before.uid !== now.uid)
				throw new Error("secure directory ancestor changed during read");
		}
		await assertNamedDirectory(parent);
	};
	try {
		await assertAncestors();
		const admit = (): Error | undefined => {
			if (!active || pending !== undefined)
				return new Error("private directory reader is closed or busy");
		};
		const settle = <R>(reading: Promise<R>): Promise<R> => {
			pending = reading;
			void reading.then(() => { pending = undefined; }, () => { pending = undefined; });
			return reading;
		};
		const read = (name: string, maxBytes: number): Promise<string> => {
			const denied = admit();
			if (denied) return Promise.reject(denied);
			if (!name || name === "." || name === ".." || basename(name) !== name ||
				name.includes("\\") || name.includes("\0"))
				return Promise.reject(new Error("private directory reader requires one file name"));
			const reading = readPrivateFileFromDirectory(parent, join(absolute, name), maxBytes, assertAncestors);
			return settle(reading);
		};
		const readBatch = (
			input: readonly string[],
			maxBytes: number,
		): Promise<readonly string[]> => {
			const denied = admit();
			if (denied) return Promise.reject(denied);
			if (isProxy(input) || !Array.isArray(input) ||
				Object.getPrototypeOf(input) !== Array.prototype ||
				input.length < 1 || input.length > PRIVATE_DIRECTORY_READ_BATCH_MAX)
				return Promise.reject(new Error("private directory reader batch requires 1 to 4 file names"));
			const ownNames = Object.getOwnPropertyNames(input);
			if (ownNames.length !== input.length + 1 ||
				ownNames[ownNames.length - 1] !== "length" ||
				Object.getOwnPropertySymbols(input).length !== 0)
				return Promise.reject(new Error("private directory reader batch requires own data file names"));
			const descriptors = Object.getOwnPropertyDescriptors(input);
			const names: string[] = [];
			const unique = new Set<string>();
			for (let index = 0; index < input.length; index++) {
				const descriptor = descriptors[String(index)];
				if (descriptor === undefined || !("value" in descriptor))
					return Promise.reject(new Error("private directory reader batch requires own data file names"));
				const name = descriptor.value;
				if (typeof name !== "string" || !name || name === "." || name === ".." ||
					basename(name) !== name || name.includes("\\") || name.includes("\0"))
					return Promise.reject(new Error("private directory reader requires one file name"));
				if (unique.has(name))
					return Promise.reject(new Error("private directory reader batch file names must be unique"));
				unique.add(name);
				names.push(name);
			}
			if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 16_777_216)
				return Promise.reject(new Error("private file size limit is invalid"));
			const readings = names.map((name) =>
				readPrivateFileFromDirectory(parent, join(absolute, name), maxBytes, assertAncestors));
			const reading = Promise.allSettled(readings).then((results) => {
				const failures: unknown[] = [];
				const values: string[] = [];
				for (const result of results) {
					if (result.status === "rejected") failures.push(result.reason);
					else values.push(result.value);
				}
				if (failures.length === 1) throw failures[0];
				if (failures.length > 1) {
					const first = failures[0];
					throw new AggregateError(
						failures,
						first instanceof Error ? first.message : String(first),
					);
				}
				return values;
			});
			return settle(reading);
		};
		return await operation(read, readBatch);
	} finally {
		active = false;
		try {
			await pending;
		} finally {
			await parent.handle.close().catch(() => undefined);
		}
	}
}

async function readPrivateFileFromDirectory(
	parent: OpenDirectory,
	absolute: string,
	maxBytes: number,
	assertParent: () => Promise<void> = () => assertNamedDirectory(parent),
): Promise<string> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 16_777_216)
		throw new Error("private file size limit is invalid");
	const target = join(parent.namedPath, basename(absolute));
	let file: FileHandle | undefined;
	try {
		await assertParent();
		file = await open(
			target,
			constants.O_RDONLY | NOFOLLOW | constants.O_NONBLOCK,
		);
		await assertSingleRegularFile(file, target);
		const info = await file.stat();
		if (info.size > maxBytes) throw new Error("private file exceeds size limit");
		let content = Buffer.allocUnsafe(
			Math.min(maxBytes + 1, Math.max(4_096, info.size + 1)),
		);
		let bytesRead = 0;
		for (; ;) {
			if (bytesRead === content.length) {
				if (content.length === maxBytes + 1) break;
				const grown = Buffer.allocUnsafe(
					Math.min(maxBytes + 1, content.length * 2),
				);
				content.copy(grown);
				content = grown;
			}
			const next = await file.read(
				content,
				bytesRead,
				content.length - bytesRead,
				bytesRead,
			);
			if (next.bytesRead === 0) break;
			bytesRead += next.bytesRead;
		}
		if (bytesRead > maxBytes) throw new Error("private file exceeds size limit");
		await assertSingleRegularFile(file, target);
		await assertParent();
		return new TextDecoder("utf-8", { fatal: true }).decode(
			content.subarray(0, bytesRead),
		);
	} finally {
		await file?.close().catch(() => undefined);
	}
}

/** List a bounded private directory only while its path identity stays fixed. */
export async function readPrivateDirectoryNames(
	path: string,
	maxEntries = 10_000,
): Promise<string[]> {
	if (
		!Number.isSafeInteger(maxEntries) ||
		maxEntries <= 0 ||
		maxEntries > 100_000
	) {
		throw new Error("private directory entry limit is invalid");
	}
	const directory = await openPrivateDirectory(path, false);
	let opened: Awaited<ReturnType<typeof opendir>> | undefined;
	try {
		await assertNamedDirectory(directory);
		opened = await opendir(directory.namedPath);
		const names: string[] = [];
		for (;;) {
			const entry = await opened.read();
			if (!entry) break;
			names.push(entry.name);
			if (names.length > maxEntries)
				throw new Error("private directory exceeds entry limit");
		}
		await assertNamedDirectory(directory);
		return names;
	} finally {
		await opened?.close().catch(() => undefined);
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
		await assertSingleRegularFile(file, target);
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
		await assertSingleRegularFile(file, tmp);
		await file.writeFile(content);
		await file.sync();
		await assertSingleRegularFile(file, tmp);
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
): Promise<Readonly<{ dev: number; ino: number; nlink: number }>> {
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
		const identity = await generation.stat();
		await assertDestinationAbsent(parent, basename(absolute));
		await beforeRenameForTests?.(absolute, temporaryPath);
		await assertNamedDirectory(parent);
		// Recheck after the hook: generation publication must not replace a
		// destination created while the generation was being prepared.
		await assertDestinationAbsent(parent, basename(absolute));
		await assertDirectoryHandleMatchesPath(generation, temporary);
		await rename(temporary, join(parent.namedPath, basename(absolute)));
		await assertDirectoryHandleMatchesPath(generation, absolute);
		await parent.handle.sync().catch(ignoreDirectorySyncError);
		await assertNamedDirectory(parent);
		await assertDirectoryHandleMatchesPath(generation, absolute);
		const current = await generation.stat();
		if (current.nlink !== identity.nlink || current.mode !== identity.mode)
			throw new Error("secure generation changed during publication");
		return Object.freeze({ dev: identity.dev, ino: identity.ino, nlink: identity.nlink });
	} finally {
		// A substituted preparation name is not owned cleanup work.
		if (generation) {
			try {
				await assertDirectoryHandleMatchesPath(generation, temporary);
				await removeTemporaryPath(parent, temporary, true);
			} catch {
				// Preserve absent, substituted, or unobservable names.
			}
		}
		await generation?.close().catch(() => undefined);
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

async function openPrivateDirectory(
	path: string,
	create: boolean,
): Promise<OpenDirectory> {
	const absolute = resolve(path);
	if (process.platform === "win32" || constants.O_NOFOLLOW === undefined) {
		throw new Error("secure filesystem containment is unavailable on this platform");
	}
	const canonical = await canonicalDirectoryPath(absolute);
	const opened: Array<{ handle: FileHandle; path: string }> = [
		{ handle: await open(sep, READ_DIRECTORY), path: sep },
	];
	let currentPath: string = sep;
	try {
		for (const component of canonical.slice(1).split(sep).filter(Boolean)) {
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
			opened.push({ handle: next, path: nextPath });
			currentPath = nextPath;
		}
		for (const ancestor of opened) {
			await assertDirectoryHandleMatchesPath(ancestor.handle, ancestor.path);
		}
		const destination = opened.at(-1)!;
		for (const ancestor of opened.slice(0, -1)) await ancestor.handle.close();
		return { handle: destination.handle, namedPath: absolute };
	} catch (error) {
		await Promise.all(
			opened.map(({ handle }) => handle.close().catch(() => undefined)),
		);
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
		throw new Error("secure path is not a stable regular file");
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
