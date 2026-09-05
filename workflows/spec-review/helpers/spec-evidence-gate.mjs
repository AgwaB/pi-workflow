// Typed local citations are the only byte evidence protocol. Strings are
// display-only, including file:line, URLs and opaque source refs. No network.
import { createHash } from "node:crypto";
import { readLocalText, localRange } from "./local-evidence-reader.mjs";

export const EVIDENCE_PROTOCOL = "spec-local-evidence-v1";
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function isLocalCitation(row) {
  return row && typeof row === "object" && !Array.isArray(row) &&
    typeof row.file === "string" && row.file.length > 0 &&
    Number.isSafeInteger(row.lineStart) && Number.isSafeInteger(row.lineEnd) &&
    row.lineStart > 0 && row.lineEnd >= row.lineStart &&
    typeof row.quote === "string" && row.quote.trim().length > 0;
}

async function checkRows(value, field, context) {
  const rows = [];
  for (const [index, citation] of (Array.isArray(value) ? value : []).entries()) {
    context.signal?.throwIfAborted();
    const base = { field, index, citation };
    if (typeof citation === "string") {
      rows.push({ ...base, status: "unverified", reason: "legacy locator/text is display-only, not byte evidence" });
      continue;
    }
    if (!isLocalCitation(citation)) {
      rows.push({ ...base, status: "unverified", reason: "typed local file/range/quote required; remote snapshots unsupported" });
      continue;
    }
    try {
      const text = await readLocalText(context.cwd, citation.file, context.signal);
      const range = localRange(text, citation.lineStart, citation.lineEnd);
      const status = range.includes(citation.quote) ? "verified" : "mismatch";
      rows.push({ ...base, status, sha256: createHash("sha256").update(text, "utf8").digest("hex") });
    } catch (error) {
      context.signal?.throwIfAborted();
      rows.push({ ...base, status: "unreadable", reason: error.code ?? error.message });
    }
  }
  return rows;
}

export async function gateDisposition(id, verdict, evidence, counterEvidence, context = {}) {
  const rows = [...await checkRows(evidence, "evidence", context), ...await checkRows(counterEvidence, "counterEvidence", context)];
  const requiredField = verdict === "DROP" ? "counterEvidence" : "evidence";
  const typed = rows.filter(row => typeof row.citation !== "string");
  const complete = ["KEEP", "WEAKEN", "DROP"].includes(verdict) &&
    typed.some(row => row.field === requiredField && row.status === "verified") &&
    typed.every(row => row.status === "verified");
  return { id, verdict, complete, rows };
}

export async function gateRequirementCoverage(coverage, context = {}) {
  const rows = [];
  for (const [index, row] of (Array.isArray(coverage) ? coverage : []).entries()) {
    // Gap/uncertainty is not a positive conformance claim. Unknown status is
    // conservative, not an escape hatch for an unrecognized positive label.
    const positive = !["gap", "unclear", "needsHuman", "needs_human", "NEEDS_HUMAN"].includes(row?.status);
    const result = await gateDisposition(String(row?.requirementId ?? row?.id ?? index), "KEEP", row?.evidence, [], context);
    rows.push({ index, ...result, complete: positive ? result.complete : true, positive });
  }
  return rows;
}

// The renderer reconciles canonical rows and recomputes actual bytes. It does
// not accept fabricated verified flags or a reused gate for different quotes.
export async function partitionEvidenceComplete(partition, context = {}) {
  const gate = partition?.evidenceGate;
  if (gate?.protocol !== EVIDENCE_PROTOCOL || gate.complete !== true || !Array.isArray(gate.findings) || !Array.isArray(gate.coverage)) return false;
  if (!Array.isArray(partition.needsHuman) || partition.needsHuman.length) return false;
  const dispositions = [...(partition.finalFindings ?? []), ...(partition.droppedFindings ?? [])];
  if (!dispositions.length || gate.findings.length !== dispositions.length || new Set(gate.findings.map(row => row.id)).size !== dispositions.length) return false;
  for (const finding of dispositions) {
    const verdict = finding.verdict ?? "DROP";
    const saved = gate.findings.find(row => row.id === finding.id);
    const checked = await gateDisposition(finding.id, verdict, finding.evidence, finding.counterEvidence, context);
    if (!checked.complete || canonical(saved) !== canonical(checked)) return false;
  }
  const coverage = await gateRequirementCoverage(partition.requirementCoverage, context);
  return coverage.every(row => row.complete) && canonical(gate.coverage) === canonical(coverage);
}
