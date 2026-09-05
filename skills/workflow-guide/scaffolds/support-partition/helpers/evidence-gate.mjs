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

import { resolve } from "node:path";
import { readLocalText, localRange } from "./local-evidence-reader.mjs";

const DEFAULT_BUCKETS = ["keep", "weaken"];

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function quotes(value) {
  return asArray(value)
    .map((item) => (typeof item === "string" ? item : typeof item?.quote === "string" ? item.quote : ""))
    .filter((text) => text.trim() !== "");
}

function locations(value) {
  return asArray(value)
    .map((item) => asObject(item))
    .filter((item) => item && typeof item.file === "string" && item.file.trim() !== "");
}

async function readRange(root, location, signal) {
  try {
    const text = await readLocalText(root, location.file, signal);
    const start = location.line ?? 1;
    const end = location.lineEnd ?? (location.line === undefined ? text.split("\n").length : start);
    return { status: "ok", text: localRange(text, start, end) };
  } catch (error) {
    signal?.throwIfAborted();
    return { status: "unreadable", reason: error?.code ?? error.message };
  }
}

async function gateFinding(finding, root, signal) {
  const cited = locations(finding.locations);
  const quoteList = quotes(finding.evidenceQuotes);
  const rows = [];
  const ranges = [];
  for (const location of cited) {
    const range = await readRange(root, location, signal);
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
    }
    if (status === "mismatch" && ranges.length > 0 && ranges.every((entry) => entry.range.status !== "ok")) status = "unreadable";
    if (ranges.length === 0) {
      status = "unreadable";
      reason = "finding cites no locations";
    }
    rows.push({ quote, status, ...(matchedIn ? { file: matchedIn.file, line: matchedIn.line ?? null, lineEnd: matchedIn.lineEnd ?? null } : {}), ...(reason ? { reason } : {}) });
  }
  for (const { location, range } of ranges) {
    if (range.status !== "ok" && !rows.some(row => row.status === "unreadable" && row.reason?.includes(`${location.file}:`))) {
      rows.push({ quote: "", file: location.file, status: "unreadable", reason: range.reason });
    }
  }
  if (quoteList.length === 0) rows.push({ quote: "", status: "unreadable", reason: "finding has no evidenceQuotes" });
  return rows;
}

export default async function helper({ sources, options = {}, context = {} }) {
  const partitionStage = String(options.partitionStage ?? "partition-verdicts");
  const gatedBuckets = asArray(options.buckets).length > 0 ? asArray(options.buckets).map(String) : DEFAULT_BUCKETS;
  const root = resolve(String(options.root ?? context.cwd ?? process.cwd()));
  const matches = Object.entries(asObject(sources) ?? {}).filter(([source]) => source === partitionStage || source.startsWith(`${partitionStage}.`));
  const value = matches.length === 1 ? asObject(asObject(matches[0][1])?.value) : undefined;
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
      const rows = await gateFinding(finding, root, context.signal);
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
  const identity = asObject(value.identityIntegrity);
  const plannedIds = asArray(identity?.plannedIds);
  const verifiedIds = asArray(identity?.verifiedIds);
  const outputIds = Object.values(partitions).flat().map((row) => row.findingId);
  const sameIds = (ids) => ids.length === plannedIds.length && new Set(ids).size === ids.length && ids.every((id) => typeof id === "string" && plannedIds.includes(id));
  const identityComplete = identity?.complete === true && Array.isArray(identity.issues) && identity.issues.length === 0 &&
    new Set(plannedIds).size === plannedIds.length && sameIds(verifiedIds) && sameIds(outputIds) &&
    summary.candidates === plannedIds.length && summary.verdictsReceived === verifiedIds.length && summary.integrity === "complete";
  const integrity = mismatch === 0 && unreadable === 0 && identityComplete ? "complete" : "partial";
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
