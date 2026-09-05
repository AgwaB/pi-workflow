// Typed local citations are the only byte evidence protocol. Strings are
// display-only, including file:line, URLs and opaque source refs. No network.
import { createHash } from "node:crypto";
import { readLocalText, localRange } from "./local-evidence-reader.mjs";
import { rendererRequirementSource } from "./spec-requirement-source.mjs";

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

export const COVERAGE_STATUSES = ["covered", "gap", "partial", "unclear", "needsHuman"];
export const exactRequirementId = value => typeof value === "string" && value.length > 0 && value === value.trim() && !/[\s\u0000-\u001f\u007f-\u009f]/u.test(value);

export async function gateRequirementCoverage(coverage, context = {}, finalFindings = []) {
  const rows = [];
  for (const [index, row] of (Array.isArray(coverage) ? coverage : []).entries()) {
    const id = exactRequirementId(row?.requirementId) ? row.requirementId : "";
    const positive = row?.status === "covered";
    const result = await gateDisposition(id, "KEEP", row?.evidence, [], context);
    const accountedBy = ["gap", "partial"].includes(row?.status)
      ? finalFindings.filter(finding => ["KEEP", "WEAKEN"].includes(finding.verdict) && finding.requirementIds?.includes(id)).map(finding => finding.id).sort()
      : [];
    // Partial is a known remaining gap, never positive coverage. Unclear and
    // needsHuman remain unresolved even with a retained finding. DROP cannot
    // resolve a gap. Bad extra typed citations poison every status.
    const bytesValid = result.rows.filter(item => typeof item.citation !== "string").every(item => item.status === "verified");
    const complete = Boolean(id && COVERAGE_STATUSES.includes(row?.status) && bytesValid &&
      (positive ? result.complete : accountedBy.length > 0));
    rows.push({ index, ...result, status: typeof row?.status === "string" ? row.status : "", complete, positive, accountedBy });
  }
  return rows;
}

// Persist both the exact universe and its actual runtime/control-byte binding.
// A set alone is insufficient: stale controls with unchanged IDs also fail.
export function reconcileRequirementCoverage(coverage, checked, finalFindings, source) {
  const issues = [];
  const requirements = Array.isArray(source?.requirements) ? source.requirements : [];
  const requirementIds = [];
  if (!source?.complete || !source?.proof) issues.push("missing_requirement_source_proof");
  if (!requirements.length || requirements.length > 40) issues.push("absent_or_invalid_requirement_scope");
  for (const row of requirements) {
    if (!exactRequirementId(row?.id)) issues.push("invalid_extracted_requirement_id");
    else if (requirementIds.includes(row.id)) issues.push(`duplicate_extracted_requirement_id:${row.id}`);
    else requirementIds.push(row.id);
  }
  requirementIds.sort();
  if (!Array.isArray(coverage) || coverage.length > 40) issues.push("missing_or_invalid_coverage_array");
  const coverageIds = [];
  for (const row of Array.isArray(coverage) ? coverage : []) {
    if (!exactRequirementId(row?.requirementId)) issues.push("invalid_coverage_requirement_id");
    else {
      if (coverageIds.includes(row.requirementId)) issues.push(`duplicate_coverage_requirement_id:${row.requirementId}`);
      if (!requirementIds.includes(row.requirementId)) issues.push(`unknown_coverage_requirement_id:${row.requirementId}`);
      coverageIds.push(row.requirementId);
    }
    if (!COVERAGE_STATUSES.includes(row?.status)) issues.push("invalid_coverage_status");
  }
  const missingIds = requirementIds.filter(id => !coverageIds.includes(id));
  if (missingIds.length) issues.push("missing_requirement_coverage");
  if (canonical(coverage) !== canonical(source?.candidate?.requirementCoverage)) issues.push("coverage_differs_from_candidate_control");
  // Accounted gaps must use the candidate's exact explicit linkage, not a
  // post-hoc forged finding link, alias, title or inferred positional ID.
  for (const finding of finalFindings) {
    const candidates = (Array.isArray(source?.candidate?.candidateFindings) ? source.candidate.candidateFindings : []).filter(row => row?.id === finding.id);
    const ids = finding.requirementIds;
    if (candidates.length !== 1 || !Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length ||
      ids.some(id => !exactRequirementId(id) || !requirementIds.includes(id)) || canonical(ids) !== canonical(candidates[0]?.requirementIds)) issues.push(`invalid_finding_requirement_link:${finding.id}`);
  }
  const unresolvedIds = checked.filter(row => !row.complete).map(row => row.id);
  const complete = issues.length === 0 && checked.length === requirements.length && unresolvedIds.length === 0;
  return { protocol: "spec-requirement-reconciliation-v1", proof: source?.proof ?? null, requirementIds, coverageIds, missingIds, unresolvedIds, issues, complete, allCovered: complete && checked.every(row => row.positive) };
}

export async function partitionRequirementReconciliation(partition, context = {}) {
  const source = await rendererRequirementSource(context);
  const checked = await gateRequirementCoverage(partition?.requirementCoverage, context, partition?.finalFindings ?? []);
  const actual = reconcileRequirementCoverage(partition?.requirementCoverage, checked, partition?.finalFindings ?? [], source);
  return { ...actual, complete: actual.complete && canonical(actual) === canonical(partition?.evidenceGate?.requirementReconciliation) };
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
  const coverage = await gateRequirementCoverage(partition.requirementCoverage, context, partition.finalFindings ?? []);
  const reconciliation = await partitionRequirementReconciliation(partition, context);
  return reconciliation.complete && coverage.every(row => row.complete) && canonical(gate.coverage) === canonical(coverage);
}
