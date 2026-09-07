// Local byte grounding only: never fetch URLs or interpret opaque web refs.
// A quote may be an exact substring of a declared numeric range. Legacy
// textual excerpt locations have no range grammar, so their quote is checked
// against the bounded file and explicitly recorded with matchScope=file.
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const MAX_BYTES = 4 * 1024 * 1024;

// A locator can be an explicitly local path, a remotely attested workflow/web
// reference, or an opaque value whose meaning is not known from its spelling.
// Opaque values are allowed into the local byte gate only as a fail-closed
// probe; they are never treated as remote URLs or as proof of local bytes.
export function classifyLocator(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "opaque";
  if (/^(?:https?):\/\//i.test(text) || /^wsrc_[a-f0-9]{32}$/i.test(text))
    return "remote";
  if (/^(?:file|repo):/i.test(text)) return "local";
  const path = text.split("#", 1)[0];
  if (
    path.startsWith("./") ||
    path.startsWith("../") ||
    path.includes("/") ||
    /^[\w.-]+\.[\w-]+$/u.test(path)
  )
    return "local";
  return "opaque";
}

export function isLocalLocator(value) {
  return classifyLocator(value) === "local";
}

// A small, conservative compatibility allowance for extensionless repository
// documents.  It is still byte-gated below; the name alone never verifies a
// quote.  Arbitrary opaque values (including opaque web references) are not
// treated as paths.
const EXTENSIONLESS_LOCAL_NAME_RE = /^README$/u;

export function isConservativeLocalLocator(value) {
  const text = typeof value === "string" ? value.trim().split("#", 1)[0] : "";
  return (
    classifyLocator(value) === "local" ||
    (text.length > 0 && EXTENSIONLESS_LOCAL_NAME_RE.test(text))
  );
}

const TYPED_LOCAL_ALIASES = ["file", "path", "repoPath", "localPath"];
const AMBIGUOUS_LOCATOR_ALIASES = ["source", "sourceRef", "url", "sourceUrl"];

function hasRemoteLocator(row) {
  return [...TYPED_LOCAL_ALIASES, ...AMBIGUOUS_LOCATOR_ALIASES].some(
    (key) => classifyLocator(row?.[key]) === "remote",
  );
}

// Resolve aliases with their field semantics before reading. `source` is often
// a display label, so a typed local locator wins and the label is ignored.
// An extensionless source/sourceRef is accepted only for the conservative
// README compatibility case and only when no remote citation is present.
export function localEvidenceRefs(row, isLocalRef = isLocalLocator) {
  if (!row || typeof row !== "object") return [];
  const hasTypedLocal = TYPED_LOCAL_ALIASES.some((key) =>
    isConservativeLocalLocator(row[key]),
  );
  const hasRemote = hasRemoteLocator(row);
  const refs = [];
  const seen = new Set();
  const add = (key) => {
    const value = row[key];
    if (typeof value !== "string" || !value.trim()) return;
    const kind = classifyLocator(value);
    if (kind === "remote") return;
    const extensionless = isConservativeLocalLocator(value) && kind === "opaque";
    const typed = TYPED_LOCAL_ALIASES.includes(key);
    const sourceLabel = key === "source" && hasTypedLocal;
    const ambiguousExtensionless =
      extensionless &&
      (key === "url" || key === "sourceUrl" || key === "sourceRef" ||
        (key === "source" && !hasTypedLocal && !hasRemote));
    if (sourceLabel || (!typed && !isLocalRef(value) && !ambiguousExtensionless))
      return;
    const text = value.trim();
    if (!seen.has(text)) {
      seen.add(text);
      refs.push(text);
    }
  };
  for (const key of [...TYPED_LOCAL_ALIASES, ...AMBIGUOUS_LOCATOR_ALIASES])
    add(key);
  return refs;
}

async function readLocalText(cwd, file, signal) {
  signal?.throwIfAborted();
  const root = await realpath(resolve(cwd));
  const target = resolve(root, file);
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error("path escapes workflow cwd");
  let path = root;
  for (const part of rel.split(sep)) {
    path = resolve(path, part);
    if ((await lstat(path)).isSymbolicLink())
      throw new Error("symlinked evidence path");
  }
  const handle = await open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.size > MAX_BYTES ||
      (await realpath(target)) !== target
    )
      throw new Error("not a bounded regular file inside workflow cwd");
    const buffer = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(
        buffer,
        size,
        buffer.length - size,
        size,
      );
      if (!bytesRead) break;
      size += bytesRead;
    }
    const after = await handle.stat();
    const current = await lstat(target);
    if (
      size > MAX_BYTES ||
      size !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      current.isSymbolicLink() ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      (await realpath(target)) !== target
    )
      throw new Error("evidence file changed during read");
    return new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, size),
    );
  } finally {
    await handle.close();
  }
}

function rangeOf(row, fragment) {
  const ranges = [];
  const number = (value) =>
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  const add = (start, end = start) => {
    start = number(start);
    end = number(end);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 1 ||
      end < start
    )
      throw new Error("invalid local line range");
    ranges.push([start, end]);
  };
  if (row.lineStart !== undefined || row.lineEnd !== undefined)
    add(row.lineStart ?? row.line, row.lineEnd ?? row.lineStart ?? row.line);
  else if (row.line !== undefined) add(row.line);
  if (
    row.lineStart !== undefined &&
    row.line !== undefined &&
    number(row.line) !== number(row.lineStart)
  )
    throw new Error("conflicting local line range");
  for (const location of [fragment, row.lines, row.excerptLocation]) {
    if (location === undefined || location === "") continue;
    const match = String(location).match(
      /^(?:#?L|lines?\s*)?(\d+)(?:\s*-\s*L?(\d+))?$/i,
    );
    if (match) add(match[1], match[2] ?? match[1]);
    else if (location === fragment || location === row.lines)
      throw new Error("unparseable local line range");
  }
  if (ranges.some(([a, b]) => a !== ranges[0][0] || b !== ranges[0][1]))
    throw new Error("conflicting local line ranges");
  return ranges[0];
}

export default async function localQuoteGate(
  evidence,
  context,
  isLocalRef = isLocalLocator,
) {
  const rows = [];
  const cache = new Map();
  for (const [index, row] of (Array.isArray(evidence)
    ? evidence
    : []
  ).entries()) {
    if (!row || typeof row !== "object") continue;
    const refs = localEvidenceRefs(row, isLocalRef);
    for (const ref of refs) {
      context.signal?.throwIfAborted();
      const [file, fragment] = ref
        .trim()
        .replace(/^(?:file|repo):/i, "")
        .split("#");
      try {
        const range = rangeOf(row, fragment);
        if (!context.cwd) throw new Error("workflow cwd unavailable");
        if (!cache.has(file))
          cache.set(
            file,
            await readLocalText(context.cwd, file, context.signal),
          );
        const text = cache.get(file);
        const lines = text.split("\n");
        if (range && range[1] > lines.length)
          throw new Error("local range beyond end of file");
        const excerpt = range
          ? lines.slice(range[0] - 1, range[1]).join("\n")
          : text;
        const matches =
          typeof row.quote === "string" &&
          row.quote.trim().length > 0 &&
          excerpt.includes(row.quote);
        rows.push({
          index,
          file,
          matchScope: range ? "range" : "file",
          ...(range ? { lineStart: range[0], lineEnd: range[1] } : {}),
          status: matches ? "verified" : "mismatch",
        });
      } catch (error) {
        context.signal?.throwIfAborted();
        rows.push({
          index,
          file,
          status: "unreadable",
          reason: error.code ?? error.message,
        });
      }
    }
  }
  return rows;
}
