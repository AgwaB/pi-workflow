// Only runtime-owned manifest chains locate requirement controls. Saved gate
// metadata, model aliases, titles and row positions are never source authority.
import { createHash } from "node:crypto";
import { readLocalText } from "./local-evidence-reader.mjs";

const safeId = value => typeof value === "string" && /^[a-zA-Z0-9_-]+$/.test(value);
const sha256 = text => createHash("sha256").update(text, "utf8").digest("hex");
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

export async function candidateUpstreamFailures(context, owner) {
  try {
    if (owner?.stageId !== "candidate-findings" || owner.specId !== "candidate-findings.main" || owner.status !== "completed") throw new Error("invalid candidate owner");
    const { manifest, sha256: manifestSha256 } = await readManifest(context, owner.taskId);
    const failures = [];
    let extracted;
    for (const stage of ["extract-spec", "map-implementation", "inspect-tests"]) {
      try {
        const source = exactSource(manifest.sources, stage);
        const text = await readLocalText(context.cwd, taskPath(context, source.taskId, "control.json"), context.signal);
        const control = JSON.parse(text);
        if (stage === "extract-spec") extracted = { source, control, sha256: sha256(text) };
      } catch (error) {
        context.signal?.throwIfAborted();
        failures.push({ source: stage, status: "unverifiable_upstream_source", lastMessage: error.code ?? error.message });
      }
    }
    const candidateText = await readLocalText(context.cwd, taskPath(context, owner.taskId, "control.json"), context.signal);
    const candidate = JSON.parse(candidateText);
    return {
      failures,
      requirementSource: extracted ? {
        proof: { runId: context.runId, candidateTaskId: owner.taskId, candidateControlSha256: sha256(candidateText), candidateManifestSha256: manifestSha256, extractTaskId: extracted.source.taskId, extractControlSha256: extracted.sha256 },
        requirements: extracted.control.requirements,
        candidate,
        complete: failures.length === 0,
      } : null,
    };
  } catch (error) {
    context.signal?.throwIfAborted();
    return { failures: [{ source: "candidate-findings", status: "unverifiable_upstream_sources", lastMessage: error.code ?? error.message }], requirementSource: null };
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
    return null;
  }
}
