// Only runtime-owned manifest chains locate requirement controls. Saved gate
// metadata, model aliases, titles and row positions are never source authority.
import { createHash } from "node:crypto";
import { readLocalText, localRange } from "./local-evidence-reader.mjs";

const safeId = value => typeof value === "string" && /^[a-zA-Z0-9_-]+$/.test(value);
const normalizeId = value => typeof value === "string" && value.trim() ? value.trim() : "";
const sha256 = text => createHash("sha256").update(text, "utf8").digest("hex");
const citationShape = value => Boolean(
  value && typeof value === "object" && !Array.isArray(value) &&
  typeof value.file === "string" && value.file.trim() &&
  Number.isSafeInteger(value.lineStart) && Number.isSafeInteger(value.lineEnd) &&
  value.lineStart > 0 && value.lineEnd >= value.lineStart &&
  typeof value.quote === "string" && value.quote.trim(),
);
const sourceFiles = sources => (Array.isArray(sources) ? sources : [])
  .map(source => typeof source === "string" ? source.trim() : source?.file?.trim())
  .filter(Boolean);
const sourceCitations = value => Array.isArray(value) ? value : [value];

function candidateUniverse(control, proof) {
  const rows = Array.isArray(control?.candidateFindings) ? control.candidateFindings : [];
  const ids = rows.map(row => typeof row?.id === "string" && row.id.length > 0 ? row.id : "");
  const validIds = ids.filter(Boolean);
  const duplicateIds = [...new Set(validIds.filter((id, index) => validIds.indexOf(id) !== index))].sort();
  const sortedIds = [...validIds].sort();
  return {
    schema: "spec-review-runtime-candidate-universe-v1",
    count: rows.length,
    uniqueCount: new Set(validIds).size,
    ids: sortedIds,
    duplicateIds,
    invalidRowCount: rows.length - validIds.length,
    proof: proof ?? null,
  };
}
const taskPath = (context, taskId, file) => {
  if (!safeId(context.runId) || !safeId(taskId)) throw new Error("unsafe runtime source identity");
  return `.pi/workflows/${context.runId}/tasks/${taskId}/${file}`;
};
async function readManifest(context, taskId) {
  const text = await readLocalText(context.cwd, taskPath(context, taskId, "source-manifest.json"), context.signal);
  const manifest = JSON.parse(text);
  if (manifest.schema !== "workflow-source-manifest-v1" || manifest.runId !== context.runId || manifest.taskId !== taskId || !Array.isArray(manifest.sources)) throw new Error("invalid runtime source manifest");
  return { manifest, sha256: sha256(text) };
}
function exactSource(rows, stage) {
  const matches = rows.filter(row => row.stageId === stage && row.source === stage && row.specId === `${stage}.main`);
  if (matches.length !== 1 || matches[0].status !== "completed" || !matches[0].artifacts?.control?.path || !safeId(matches[0].taskId)) throw new Error(`missing_or_incomplete_upstream_source:${stage}`);
  return matches[0];
}

async function verifyRequirementSources(control, context) {
  const specSources = sourceFiles(control?.specSources);
  const rows = [];
  for (const requirement of Array.isArray(control?.requirements) ? control.requirements : []) {
    const id = normalizeId(requirement?.id);
    const citations = sourceCitations(requirement?.specEvidence);
    const checked = [];
    for (const citation of citations) {
      if (!citationShape(citation)) {
        checked.push({ status: "unverified", reason: "typed local spec citation required" });
        continue;
      }
      if (!specSources.includes(citation.file.trim())) {
        checked.push({ status: "unverified", reason: "citation file is not declared in specSources" });
        continue;
      }
      try {
        const text = await readLocalText(context.cwd, citation.file, context.signal);
        const range = localRange(text, citation.lineStart, citation.lineEnd);
        checked.push({
          citation,
          status: range.includes(citation.quote) ? "verified" : "mismatch",
          sha256: sha256(text),
        });
      } catch (error) {
        context.signal?.throwIfAborted();
        checked.push({ citation, status: "unreadable", reason: error.code ?? error.message });
      }
    }
    rows.push({ id, complete: specSources.length > 0 && checked.length > 0 && checked.every(row => row.status === "verified"), checked });
  }
  return rows;
}

export async function candidateUpstreamFailures(context, owner) {
  try {
    if (owner?.stageId !== "candidate-findings" || owner.specId !== "candidate-findings.main" || owner.status !== "completed") throw new Error("invalid candidate owner");
    const { manifest, sha256: manifestSha256 } = await readManifest(context, owner.taskId);
    const failures = [];
    let extracted;
    let mapped;
    let inspected;
    for (const stage of ["extract-spec", "map-implementation", "inspect-tests"]) {
      try {
        const source = exactSource(manifest.sources, stage);
        const text = await readLocalText(context.cwd, taskPath(context, source.taskId, "control.json"), context.signal);
        const control = JSON.parse(text);
        const readProof = { source, control, sha256: sha256(text) };
        if (stage === "extract-spec") extracted = readProof;
        if (stage === "map-implementation") mapped = readProof;
        if (stage === "inspect-tests") inspected = readProof;
      } catch (error) {
        context.signal?.throwIfAborted();
        failures.push({ source: stage, status: "unverifiable_upstream_source", lastMessage: error.code ?? error.message });
      }
    }
    const candidateText = await readLocalText(context.cwd, taskPath(context, owner.taskId, "control.json"), context.signal);
    const candidate = JSON.parse(candidateText);
    const proof = { runId: context.runId, candidateTaskId: owner.taskId, candidateControlSha256: sha256(candidateText), candidateManifestSha256: manifestSha256, extractTaskId: extracted?.source?.taskId ?? "", extractControlSha256: extracted?.sha256 ?? "", mapTaskId: mapped?.source?.taskId ?? "", mapControlSha256: mapped?.sha256 ?? "", inspectTestsTaskId: inspected?.source?.taskId ?? "", inspectTestsControlSha256: inspected?.sha256 ?? "" };
    const runtimeCandidateUniverse = candidateUniverse(candidate, proof);
    const requirementSource = extracted ? {
      proof,
      requirements: extracted.control.requirements,
      candidate,
      complete: failures.length === 0,
      requirementSourceEvidence: await verifyRequirementSources(extracted.control, context),
    } : null;
    return { failures, runtimeCandidateUniverse, requirementSource };
  } catch (error) {
    context.signal?.throwIfAborted();
    return { failures: [{ source: "candidate-findings", status: "unverifiable_upstream_sources", lastMessage: error.code ?? error.message }], runtimeCandidateUniverse: null, requirementSource: null };
  }
}

export async function rendererCandidateUniverse(context) {
  try {
    const owners = (Array.isArray(context.sourceStatuses) ? context.sourceStatuses : []).filter(row => row?.stageId === "partition-findings" && row.specId === "partition-findings.main" && ["partition-findings", "partition-findings.main"].includes(row.source));
    if (owners.length !== 1 || owners[0].status !== "completed") return null;
    const { manifest } = await readManifest(context, owners[0].taskId);
    const candidateOwner = exactSource(manifest.sources, "candidate-findings");
    return (await candidateUpstreamFailures(context, candidateOwner)).runtimeCandidateUniverse;
  } catch (error) {
    context.signal?.throwIfAborted();
    void error;
    return null;
  }
}

// Independently walk final context -> real partition manifest -> candidate
// manifest -> extract control. Never follow a locator stored in reconciliation.
export async function rendererRequirementSource(context) {
  try {
    const owners = (Array.isArray(context.sourceStatuses) ? context.sourceStatuses : []).filter(row => row?.stageId === "partition-findings" && row.specId === "partition-findings.main" && ["partition-findings", "partition-findings.main"].includes(row.source));
    if (owners.length !== 1 || owners[0].status !== "completed") return null;
    const { manifest } = await readManifest(context, owners[0].taskId);
    const candidate = exactSource(manifest.sources, "candidate-findings");
    return (await candidateUpstreamFailures(context, candidate)).requirementSource;
  } catch (error) {
    context.signal?.throwIfAborted();
    void error;
    return null;
  }
}
