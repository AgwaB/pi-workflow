import { randomUUID } from "node:crypto";
import {
	chmod,
	mkdir,
	open,
	rename,
	rm,
	type FileHandle,
} from "node:fs/promises";
import { dirname } from "node:path";

let tempSuffixForTests: (() => string) | undefined;

export function setSecureAtomicTempSuffixForTests(
	factory: (() => string) | undefined,
): void {
	tempSuffixForTests = factory;
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	await chmod(path, 0o700);
}

export async function writePrivateFileAtomic(
	path: string,
	content: string | Uint8Array,
): Promise<void> {
	const parent = dirname(path);
	await ensurePrivateDirectory(parent);
	const suffix = tempSuffixForTests?.() ?? randomUUID();
	const tmp = `${path}.${suffix}.tmp`;
	let file: FileHandle | undefined;
	try {
		file = await open(tmp, "wx", 0o600);
		await file.writeFile(content);
		await file.sync();
		await file.close();
		file = undefined;
		await rename(tmp, path);
		await chmod(path, 0o600);
		await syncDirectory(parent);
	} finally {
		await file?.close().catch(() => undefined);
		await rm(tmp, { force: true }).catch(() => undefined);
	}
}

async function syncDirectory(path: string): Promise<void> {
	let directory: FileHandle | undefined;
	try {
		directory = await open(path, "r");
		await directory.sync();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EPERM") {
			throw error;
		}
	} finally {
		await directory?.close().catch(() => undefined);
	}
}
