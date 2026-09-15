import { assertInventory, reconcileExactSources } from "./exact-source-join.mjs";

// Untrusted text is inline data, never Markdown structure, URLs, HTML, fences or protocol tags.
export function inlineText(value) {
  return value.replace(/[\x00-\x2f\x3a-\x40\x5b-\x60\x7b-\x9f\u2028-\u202e\u2066-\u2069]/gu,
    (char) => char === " " ? " " : `&#${char.codePointAt(0)};`);
}

export default function pipeline({ sources = {}, options, context = {} }) {
  context.signal?.throwIfAborted();
  if (options?.mode === "inventory") {
    const items = assertInventory(options.items);
    return { schema: "fixed-inventory-v1", digest: `${items.length} authored documents; existence and access not verified.`, items };
  }
  if (options?.mode !== "final") throw new Error("expected inventory or final mode");
  const joined = reconcileExactSources({ sources, sourceStatuses: context.sourceStatuses,
    inventoryOwner: { stageId: "inventory", specId: "inventory.main" },
    workerOwner: { stageId: "questions", placeholderSpecId: "questions.item" } });
  const complete = joined.complete && joined.rows.every((row) => row.documentStatus === "read");
  const { complete: ownershipComplete, ...ledger } = joined;
  const digest = `${joined.acceptedIds.length}/${joined.plannedIds.length} document outputs joined; ${complete ? "complete" : "partial"} document processing coverage.`;
  const lines = ["# Document questions", "", "## Executive summary", "", digest,
    "", "Questions derived from the authored inventory; no implementation or factual audit performed.",
    "Access status is worker-reported, not independent evidence. Grouping is deterministic, not semantic synthesis.",
    `Ownership join: ${ownershipComplete ? "complete" : "incomplete"}.`, "", "## Per-document results"];
  for (const row of joined.rows) {
    lines.push("", `### ${inlineText(row.id)}`, "", `Document: ${inlineText(row.path)}`,
      `Availability: ${row.availability}; access: ${row.documentStatus ?? "unavailable"}.`);
    if (row.owner) lines.push(`Owner: ${inlineText(JSON.stringify(row.owner))}`);
    for (const question of row.questions) lines.push(`- ${inlineText(question)}`);
    if (!row.questions.length) lines.push("No questions available; this is not a no-issues verdict.");
    for (const limitation of row.limitations) lines.push(`- Limitation: ${inlineText(limitation)}`);
  }
  lines.push("", "## Integrity diagnostics");
  if (!joined.issues.length) lines.push("", "No ownership integrity errors detected.");
  for (const issue of joined.issues) lines.push(`- ${inlineText(issue.code)} / ${inlineText(issue.source)}: ${inlineText(issue.detail)}`);
  const executiveMarkdown = lines.join("\n").trim();
  if (new TextEncoder().encode(executiveMarkdown).length > 131072) throw new Error("render exceeds 128 KiB; authoritative accounting was not truncated");
  context.signal?.throwIfAborted();
  // Flat return is intentional. Runtime writes analysis.md; no helper filesystem sidecars.
  return { schema: "fixed-final-v1", digest, status: complete ? "completed" : "failed",
    coverage: complete ? "complete" : "partial", ...ledger, executiveMarkdown, refs: [] };
}
