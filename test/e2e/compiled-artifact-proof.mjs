import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	closeSync, constants, fstatSync, lstatSync, openSync, readSync,
	readdirSync, realpathSync, writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TREE_BYTES = 64 * 1024 * 1024;
const MAX_PACKED_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 4096;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const canonical = value => `${JSON.stringify(value)}\n`;
const identity = info => Object.fromEntries([
	"dev", "ino", "mode", "nlink", "uid", "gid", "size",
	"mtimeNs", "ctimeNs", "birthtimeNs",
].map(key => [key, String(info[key])]));

export function recordArtifactPath(path, seen) {
	assert.ok(typeof path === "string" && path.split("/").every(name =>
		/^[A-Za-z0-9_.-]+$/.test(name) && name !== "." && name !== ".."), "unsafe artifact name");
	assert.ok(!seen.has(path.toLowerCase()), "case-colliding artifact path");
	seen.add(path.toLowerCase());
	assert.ok(seen.size <= MAX_ENTRIES, "artifact entry bound exceeded");
}

export function captureArtifactFile(path) {
	const before = lstatSync(path, { bigint: true });
	assert.ok(before.isFile() && before.nlink === 1n, "artifact must be a singly linked regular file");
	assert.ok(before.size <= BigInt(MAX_FILE_BYTES), "artifact exceeds byte bound");
	const version = identity(before);
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		assert.deepEqual(identity(fstatSync(fd, { bigint: true })), version, "artifact changed before open");
		const bytes = Buffer.alloc(Number(before.size));
		let offset = 0;
		while (offset < bytes.length) {
			const count = readSync(fd, bytes, offset, bytes.length - offset, null);
			assert.ok(count > 0, "artifact truncated during read");
			offset += count;
		}
		assert.equal(readSync(fd, Buffer.alloc(1), 0, 1, null), 0, "artifact grew during read");
		assert.deepEqual(identity(fstatSync(fd, { bigint: true })), version, "artifact changed during read");
		assert.deepEqual(identity(lstatSync(path, { bigint: true })), version, "artifact path changed during read");
		return { bytes, size: bytes.length, sha256: hash(bytes), identity: version };
	} finally {
		closeSync(fd);
	}
}

export function assertArtifactFileUnchanged(path, captured) {
	const current = captureArtifactFile(path);
	assert.deepEqual(current.identity, captured.identity, "artifact physical identity changed");
	assert.equal(current.sha256, captured.sha256, "artifact bytes changed");
	assert.equal(current.size, captured.size, "artifact size changed");
}

function capturePackedArchiveFile(path) {
	const before = lstatSync(path, { bigint: true });
	assert.ok(before.isFile() && before.nlink === 1n, "packed archive must be a singly linked regular file");
	assert.ok(before.size > 0n, "packed archive is empty");
	assert.ok(before.size <= BigInt(MAX_PACKED_ARCHIVE_BYTES), "packed archive exceeds 64 MiB byte bound");
	const version = identity(before);
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		assert.deepEqual(identity(fstatSync(fd, { bigint: true })), version, "packed archive changed before open");
		const buffer = Buffer.alloc(64 * 1024);
		const digest = createHash("sha256");
		const size = Number(before.size);
		let offset = 0;
		while (offset < size) {
			const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), null);
			assert.ok(count > 0, "packed archive truncated during read");
			digest.update(buffer.subarray(0, count));
			offset += count;
		}
		assert.equal(readSync(fd, buffer, 0, 1, null), 0, "packed archive grew during read");
		assert.deepEqual(identity(fstatSync(fd, { bigint: true })), version, "packed archive changed during read");
		assert.deepEqual(identity(lstatSync(path, { bigint: true })), version, "packed archive path changed during read");
		return { size, sha256: digest.digest("hex"), identity: version };
	} finally {
		closeSync(fd);
	}
}

export function assertPackedArchiveUnchanged(path, captured) {
	const current = capturePackedArchiveFile(path);
	assert.deepEqual(current.identity, captured.identity, "packed archive physical identity changed");
	assert.equal(current.sha256, captured.sha256, "packed archive bytes changed");
	assert.equal(current.size, captured.size, "packed archive size changed");
}

export function capturePackedArchive(directory, output) {
	assert.match(output, /^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz(?:\r?\n)?$/, "ambiguous or unsafe pack output");
	const name = output.replace(/\r?\n$/, "");
	assert.deepEqual(readdirSync(directory).sort(), [name], "pack directory must contain exactly the named archive");
	const path = join(directory, name);
	const captured = capturePackedArchiveFile(path);
	return { path, size: captured.size, sha256: captured.sha256, identity: captured.identity };
}

export function captureCompiledTree(directory) {
	const root = resolve(directory);
	assert.equal(realpathSync(root), root, "artifact root must be canonical and unaliased");
	const directories = [];
	const files = [];
	const seen = new Set();
	let totalBytes = 0;
	function visit(relative) {
		const path = relative ? join(root, ...relative.split("/")) : root;
		const info = lstatSync(path, { bigint: true });
		assert.ok(info.isDirectory(), "artifact directory must be physical");
		const version = identity(info);
		directories.push({ path: relative, identity: version });
		for (const name of readdirSync(path).sort()) {
			const child = relative ? `${relative}/${name}` : name;
			recordArtifactPath(child, seen);
			const childPath = join(path, name);
			const childInfo = lstatSync(childPath, { bigint: true });
			if (childInfo.isDirectory()) {
				visit(child);
			} else {
				assert.ok(childInfo.isFile(), "artifact tree contains a nonregular entry");
				assert.ok(BigInt(totalBytes) + childInfo.size <= BigInt(MAX_TREE_BYTES), "artifact tree byte bound exceeded");
				const captured = captureArtifactFile(childPath);
				assert.deepEqual(captured.identity, identity(childInfo), "artifact entry changed before capture");
				totalBytes += captured.size;
				files.push({ path: child, size: captured.size, sha256: captured.sha256, identity: captured.identity });
			}
		}
		assert.deepEqual(identity(lstatSync(path, { bigint: true })), version, "artifact directory changed during capture");
	}
	visit("");
	assert.ok(files.length > 0, "artifact inventory must not be empty");
	files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
	directories.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
	for (const entry of [...directories, ...files]) {
		assert.deepEqual(identity(lstatSync(join(root, entry.path), { bigint: true })), entry.identity, "artifact version changed during inventory");
	}
	const contents = files.map(({ path, size, sha256 }) => ({ path, size, sha256 }));
	return {
		schema: "compiled-artifact-tree-v1", root, directories, files,
		fileCount: files.length, totalBytes, contentSha256: hash(canonical(contents)),
	};
}

export function assertCompiledTreeUnchanged(snapshot) {
	assert.deepEqual(captureCompiledTree(snapshot.root), snapshot, "compiled artifact tree changed");
}

export function assertCompiledTreesEqual(left, right) {
	assert.deepEqual(left.files.map(file => file.path), right.files.map(file => file.path), "compiled artifact path inventory differs");
	for (let index = 0; index < left.files.length; index += 1) {
		const a = left.files[index];
		const b = right.files[index];
		const currentA = captureArtifactFile(join(left.root, a.path));
		const currentB = captureArtifactFile(join(right.root, b.path));
		for (const [current, retained] of [[currentA, a], [currentB, b]]) {
			assert.deepEqual(current.identity, retained.identity, "compiled artifact identity changed");
			assert.equal(current.size, retained.size, "compiled artifact size changed");
			assert.equal(current.sha256, retained.sha256, "compiled artifact hash changed");
		}
		assert.ok(currentA.bytes.equals(currentB.bytes), `compiled artifact bytes differ: ${a.path}`);
	}
	assertCompiledTreeUnchanged(left);
	assertCompiledTreeUnchanged(right);
}

export function writeCompiledManifest(path, snapshot) {
	assertCompiledTreeUnchanged(snapshot);
	writeFileSync(path, canonical(snapshot), { flag: "wx", mode: 0o600 });
	assertCompiledTreeUnchanged(snapshot);
	return captureArtifactFile(path);
}

export function readCompiledManifest(path, expectedRoot) {
	const captured = captureArtifactFile(path);
	const tree = JSON.parse(captured.bytes.toString("utf8"));
	assert.equal(canonical(tree), captured.bytes.toString("utf8"), "compiled manifest is not canonical JSON");
	// Comparing the whole freshly derived schema rejects duplicate/unknown fields,
	// forged digests/counts, unsafe paths and a stale or foreign physical root.
	assert.deepEqual(tree, captureCompiledTree(expectedRoot), "compiled manifest does not bind the current tree");
	return { tree, sha256: captured.sha256, size: captured.size, identity: captured.identity };
}
