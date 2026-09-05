// Current local bytes, not historical attestation or a same-UID OS sandbox.
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const MAX_FILE_BYTES = 4 * 1024 * 1024;
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const sameFile = (a, b) => sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

export async function readLocalText(cwd, file, signal) {
  signal?.throwIfAborted();
  if (typeof cwd !== "string" || !cwd || typeof file !== "string" || !file || /^[a-z][a-z0-9+.-]*:/i.test(file)) throw new Error("local cwd and file required");
  // Canonical cwd is the trust root (e.g. macOS /var -> /private/var).
  const root = await realpath(resolve(cwd));
  const target = resolve(root, file);
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("path escapes workflow cwd");
  const ancestors = [];
  let path = root;
  for (const part of ["", ...rel.split(sep).slice(0, -1)]) {
    path = resolve(path, part);
    const stat = await lstat(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("symlinked or non-directory evidence ancestor");
    ancestors.push({ path, stat });
  }
  const leaf = await lstat(target, { bigint: true });
  if (!leaf.isFile() || leaf.isSymbolicLink() || leaf.size > BigInt(MAX_FILE_BYTES)) throw new Error("not a bounded regular evidence file");
  const checkPath = async () => {
    for (const ancestor of ancestors) {
      const current = await lstat(ancestor.path, { bigint: true });
      if (!current.isDirectory() || !sameIdentity(ancestor.stat, current)) throw new Error("evidence ancestry changed");
    }
    if (!sameFile(leaf, await lstat(target, { bigint: true })) || await realpath(target) !== target) throw new Error("evidence path changed");
  };
  signal?.throwIfAborted();
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameFile(leaf, before) || before.size > BigInt(MAX_FILE_BYTES)) throw new Error("evidence changed before read");
    await checkPath();
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let size = 0;
    while (size < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, size, Math.min(64 * 1024, buffer.length - size), size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    signal?.throwIfAborted();
    if (BigInt(size) !== before.size || !sameFile(before, await handle.stat({ bigint: true }))) throw new Error("evidence file changed during read");
    await checkPath();
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, size));
  } finally {
    await handle.close();
  }
}

// Inclusive 1-based LF-delimited lines. CR and whitespace are significant.
// A terminal LF creates an empty last line. The quote may be a substring of
// the selected range, but may not cross its boundary; end is never clamped.
export function localRange(text, start, end) {
  const lines = text.split("\n");
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > lines.length) throw new Error("invalid or out-of-bounds local line range");
  return lines.slice(start - 1, end).join("\n");
}
