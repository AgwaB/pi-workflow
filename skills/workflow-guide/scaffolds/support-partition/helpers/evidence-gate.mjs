// Byte-level evidence gate for repository citations.
//
// A JSON Schema can require `file`/`line`/`lineEnd`/`evidenceQuotes`, but it
// cannot tell whether a quote really is the text at that range. Models
// routinely add a trailing brace, drop a line, or paraphrase. This helper
// reads every cited file range from the workflow cwd and checks that each
// quote is present verbatim inside one of the finding's cited ranges. Rows
// with a mismatch or an unreadable citation are demoted to needsHuman and the
// summary is marked partial, so a report stage cannot claim a clean pass over
// unverified evidence.
//
// Read-only: it only reads files under the workflow cwd; it never writes.

import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const DEFAULT_BUCKETS = ["keep", "weaken"];
const MAX_FILE_BYTES = 4 * 1024 * 1024;

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function quotes(value) {
  return asArray(value)
    .map((item) => (typeof item === "string" ? item : typeof item?.quote === "string" ? item.quote : ""))
    .map((text) => text.replace(/\r\n/g, "\n"))
    .filter((text) => text.trim() !== "");
}

function locations(value) {
  return asArray(value)
    .map((item) => asObject(item))
    .filter((item) => item && typeof item.file === "string" && item.file.trim() !== "");
}

function insideRoot(root, file) {
  const target = resolve(root, file);
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes("..")
    ? target
    : undefined;
}

async function readRange(cache, root, location) {
  const target = insideRoot(root, location.file);
  if (!target) return { status: "unreadable", reason: "path escapes workflow cwd" };
  let text = cache.get(target);
  if (text === undefined) {
    try {
      const raw = await readFile(target);
      if (raw.byteLength > MAX_FILE_BYTES) return { status: "unreadable", reason: "file too large" };
      text = raw.toString("utf8").replace(/\r\n/g, "\n");
      cache.set(target, text);
    } catch (error) {
      return { status: "unreadable", reason: error?.code ?? "read failed" };
    }
  }
  const lines = text.split("\n");
  const start = Number.isInteger(location.line) && location.line > 0 ? location.line : 1;
  const end = Number.isInteger(location.lineEnd) && location.lineEnd >= start ? location.lineEnd : Number.isInteger(location.line) ? start : lines.length;
  if (start > lines.length) return { status: "unreadable", reason: `line ${start} beyond end of file (${lines.length} lines)` };
  return { status: "ok", text: lines.slice(start - 1, Math.min(end, lines.length)).join("\n") };
}

function normalizeForFallback(text) {
  return text.split("\n").map((line) => line.trimEnd()).join("\n").trim();
}

async function gateFinding(finding, root, cache, options) {
  const cited = locations(finding.locations);
  const quoteList = quotes(finding.evidenceQuotes);
  const rows = [];
  const ranges = [];
  for (const location of cited) {
    const range = await readRange(cache, root, location);
    ranges.push({ location, range });
  }
  for (const quote of quoteList) {
    let status = "mismatch";
    let matchedIn;
    let reason;
    for (const { location, range } of ranges) {
      if (range.status !== "ok") {
        reason ??= `${location.file}: ${range.reason}`;
        continue;
      }
      if (range.text.includes(quote)) {
        status = "verified";
        matchedIn = location;
        break;
      }
      if (options.allowTrailingWhitespaceDrift && normalizeForFallback(range.text).includes(normalizeForFallback(quote))) {
        status = "verified";
        matchedIn = location;
        reason = "matched after trailing-whitespace normalization";
        break;
      }
    }
    if (status === "mismatch" && ranges.length > 0 && ranges.every((entry) => entry.range.status !== "ok")) status = "unreadable";
    if (ranges.length === 0) {
      status = "unreadable";
      reason = "finding cites no locations";
    }
    rows.push({ quote, status, ...(matchedIn ? { file: matchedIn.file, line: matchedIn.line ?? null, lineEnd: matchedIn.lineEnd ?? null } : {}), ...(reason ? { reason } : {}) });
  }
  if (quoteList.length === 0) rows.push({ quote: "", status: "unreadable", reason: "finding has no evidenceQuotes" });
  return rows;
}

export default async function helper({ sources, options = {}, context = {} }) {
  const partitionStage = String(options.partitionStage ?? "partition-verdicts");
  const gatedBuckets = asArray(options.buckets).length > 0 ? asArray(options.buckets).map(String) : DEFAULT_BUCKETS;
  const root = resolve(String(options.root ?? context.cwd ?? process.cwd()));
  const upstream = asObject(sources?.[partitionStage]) ?? asObject(Object.values(asObject(sources) ?? {}).find((entry) => asObject(entry)?.value?.partitions));
  const value = asObject(upstream?.value);
  if (!value) {
    return {
      schema: "helper-output-v1",
      digest: "evidence gate could not find partition output; result is partial",
      value: {
        partitions: { keep: [], weaken: [], drop: [], needsHuman: [] },
        reportContext: { keep: [], weaken: [], needsHuman: [] },
        partitionSummary: { keep: 0, weaken: 0, drop: 0, needsHuman: 0, verdictsReceived: 0, candidates: 0 },
        normalizationNotes: [`evidence gate: no partition output from ${partitionStage}`],
        evidenceGate: { integrity: "partial", verified: 0, mismatch: 0, unreadable: 0, demoted: [], rows: [] },
      },
    };
  }

  const partitions = { keep: [], weaken: [], drop: [], needsHuman: [] };
  for (const bucket of Object.keys(partitions)) partitions[bucket] = asArray(value.partitions?.[bucket]).map((item) => ({ ...item }));
  const cache = new Map();
  const gateRows = [];
  const demoted = [];
  let verified = 0;
  let mismatch = 0;
  let unreadable = 0;

  for (const bucket of gatedBuckets) {
    if (!(bucket in partitions)) continue;
    const kept = [];
    for (const finding of partitions[bucket]) {
      if (context.signal?.aborted) throw new Error("evidence gate aborted");
      const rows = await gateFinding(finding, root, cache, options);
      const findingId = String(finding.findingId ?? finding.id ?? "");
      for (const row of rows) {
        gateRows.push({ findingId, bucket, ...row });
        if (row.status === "verified") verified += 1;
        else if (row.status === "mismatch") mismatch += 1;
        else unreadable += 1;
      }
      const failed = rows.filter((row) => row.status !== "verified");
      if (failed.length === 0) {
        kept.push({ ...finding, evidenceGate: "verified" });
        continue;
      }
      demoted.push(findingId);
      partitions.needsHuman.push({
        ...finding,
        verdict: "NEEDS_HUMAN",
        evidenceGate: failed.some((row) => row.status === "unreadable") ? "unreadable" : "mismatch",
        note: `evidence gate demoted from ${bucket}: ${failed.map((row) => `${row.status}${row.reason ? ` (${row.reason})` : ""}`).join("; ")}`,
      });
    }
    partitions[bucket] = kept;
  }

  const summary = asObject(value.partitionSummary) ?? {};
  const partitionSummary = {
    ...summary,
    keep: partitions.keep.length,
    weaken: partitions.weaken.length,
    drop: partitions.drop.length,
    needsHuman: partitions.needsHuman.length,
    verdictsReceived: Number(summary.verdictsReceived ?? 0),
    candidates: Number(summary.candidates ?? 0),
  };
  const integrity = mismatch === 0 && unreadable === 0 ? (value.partitionSummary?.integrity ?? "complete") : "partial";
  const normalizationNotes = [
    ...asArray(value.normalizationNotes).map(String),
    `evidence gate: ${verified} verified, ${mismatch} mismatch, ${unreadable} unreadable${demoted.length ? `; demoted ${demoted.join(", ")}` : ""}`,
  ];

  return {
    schema: "helper-output-v1",
    digest: `evidence gate ${integrity}: ${verified} verified, ${mismatch} mismatch, ${unreadable} unreadable, ${demoted.length} demoted`,
    value: {
      ...value,
      partitions,
      reportContext: { ...(asObject(value.reportContext) ?? {}), keep: partitions.keep, weaken: partitions.weaken, needsHuman: partitions.needsHuman },
      partitionSummary: { ...partitionSummary, integrity },
      normalizationNotes,
      evidenceGate: { integrity, verified, mismatch, unreadable, demoted, rows: gateRows },
    },
  };
}
