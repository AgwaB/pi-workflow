// Deterministic post-processing for deep-review.
//
// Two modes (options.mode):
//   "dedup"     — sources: reviewer foreach outputs ({ lens, findings, ... }).
//                 Flattens findings, normalizes shape, drops duplicates by
//                 (file, normalized title) so the devil-advocate stage verifies
//                 each distinct defect once instead of once per lens.
//   "partition" — sources: dedup output + devil-advocate foreach outputs
//                 ({ finding, verdict, ... }). Normalizes verdict enums,
//                 partitions findings into keep/weaken/drop/needsHuman in code,
//                 and joins reviewer severity back onto KEEP findings so the
//                 report stage cannot silently drop findings or drift severity.

const VERDICTS = ["KEEP", "WEAKEN", "DROP", "NEEDS_HUMAN"];

function asObjects(value) {
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === "object");
  return [];
}

function findingsOf(source) {
  if (!source || typeof source !== "object") return [];
  if (Array.isArray(source.findings)) return asObjects(source.findings);
  if (Array.isArray(source.dedupedFindings)) return asObjects(source.dedupedFindings);
  return [];
}

function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[`"'()[\]{}]/g, " ")
    .replace(/[^a-z0-9.:/_$-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Extract the most file-like token from evidence/title so dedup keys do not
// depend on prose phrasing.
function fileKeyOf(finding) {
  const candidates = [finding.file, finding.evidence, finding.title]
    .map((value) => String(value ?? ""))
    .join(" ");
  const match = candidates.match(/[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|zig|java|rb|c|h|cpp|hpp|json|yaml|yml|md)\b/);
  return match ? match[0].replace(/^\.\//, "") : "";
}

function titleTokens(finding) {
  const stop = new Set(["the", "a", "an", "is", "are", "was", "were", "of", "in", "to", "for", "and", "or", "with", "from", "by", "on", "its", "this", "that", "now", "no", "longer", "test", "tests", "would", "could", "should", "fail", "fails", "failure", "removed", "dropped"]);
  return new Set(normalizeText(finding.title).split(" ").filter((token) => token.length > 1 && !stop.has(token)));
}

function tokenOverlap(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

const DUPLICATE_OVERLAP = 0.7;

function normalizeFinding(finding, index) {
  return {
    id: typeof finding.id === "string" && finding.id ? finding.id : `finding-${String(index + 1).padStart(3, "0")}`,
    severity: String(finding.severity ?? "unknown"),
    title: String(finding.title ?? "").trim(),
    evidence: finding.evidence ?? "",
    rationale: finding.rationale ?? "",
    recommendedAction: finding.recommendedAction ?? "",
    confidence: finding.confidence ?? "unknown",
  };
}

function dedupFindings(sources) {
  const flattened = [];
  for (const source of Object.values(sources ?? {})) {
    for (const finding of findingsOf(source)) flattened.push(finding);
  }
  // Duplicate when two findings share the same file (or both lack one) and
  // their title tokens largely overlap. Deterministic, order-stable: the first
  // occurrence wins unless a later duplicate carries more evidence text.
  const kept = [];
  const duplicates = [];
  for (const finding of flattened) {
    const file = fileKeyOf(finding);
    const tokens = titleTokens(finding);
    const existing = kept.find((candidate) => candidate.file === file && tokenOverlap(candidate.tokens, tokens) >= DUPLICATE_OVERLAP);
    if (!existing) {
      kept.push({ file, tokens, finding });
      continue;
    }
    const incomingEvidence = String(finding.evidence ?? "").length;
    const existingEvidence = String(existing.finding.evidence ?? "").length;
    const dropped = incomingEvidence > existingEvidence ? existing.finding : finding;
    if (incomingEvidence > existingEvidence) {
      existing.finding = finding;
      existing.tokens = tokens;
    }
    duplicates.push({ file, keptTitle: String(existing.finding.title ?? ""), droppedTitle: String(dropped.title ?? "") });
  }
  const findings = kept.map((entry, index) => normalizeFinding(entry.finding, index));
  return {
    findings,
    dedupSummary: {
      rawCount: flattened.length,
      uniqueCount: findings.length,
      duplicateCount: duplicates.length,
      duplicates,
    },
  };
}

function normalizeVerdict(value) {
  const raw = normalizeText(value).replace(/[\s-]+/g, "_").toUpperCase();
  if (VERDICTS.includes(raw)) return { verdict: raw, normalized: false };
  if (/^KEEP|^KEPT/.test(raw)) return { verdict: "KEEP", normalized: true };
  if (/^WEAK/.test(raw)) return { verdict: "WEAKEN", normalized: true };
  if (/^DROP|^REJECT|^DISCARD/.test(raw)) return { verdict: "DROP", normalized: true };
  if (/HUMAN|AMBIG|UNCLEAR/.test(raw)) return { verdict: "NEEDS_HUMAN", normalized: true };
  return { verdict: "NEEDS_HUMAN", normalized: true, invalid: String(value ?? "") };
}

function verdictEntryOf(source) {
  if (!source || typeof source !== "object") return null;
  if (!("verdict" in source) && !("finding" in source)) return null;
  return source;
}

function findingTitleOf(entry) {
  const finding = entry.finding;
  if (finding && typeof finding === "object") return String(finding.title ?? "");
  return String(finding ?? entry.title ?? "");
}

function partitionVerdicts(sources, options = {}) {
  const dedupStageId = String(options.dedupStage ?? "dedup-findings");
  let reviewerFindings = [];
  const verdictEntries = [];
  for (const [specId, source] of Object.entries(sources ?? {})) {
    if (specId.startsWith(`${dedupStageId}.`) || specId === dedupStageId) {
      reviewerFindings = findingsOf(source);
      continue;
    }
    const entry = verdictEntryOf(source);
    if (entry) verdictEntries.push(entry);
  }

  const byTitle = new Map();
  for (const finding of reviewerFindings) {
    byTitle.set(normalizeText(finding.title), finding);
  }
  const findMatch = (title) => {
    const key = normalizeText(title);
    const exact = byTitle.get(key);
    if (exact) return { finding: exact, key: normalizeText(exact.title) };
    const tokens = titleTokens({ title });
    for (const finding of reviewerFindings) {
      if (tokenOverlap(titleTokens(finding), tokens) >= DUPLICATE_OVERLAP) {
        return { finding, key: normalizeText(finding.title) };
      }
    }
    return { finding: null, key };
  };

  const partitions = { keep: [], weaken: [], drop: [], needsHuman: [] };
  const normalizationNotes = [];
  const matchedTitles = new Set();

  for (const entry of verdictEntries) {
    const title = findingTitleOf(entry);
    const { finding: reviewerFinding, key: titleKey } = findMatch(title);
    if (reviewerFinding) matchedTitles.add(titleKey);
    const { verdict, normalized, invalid } = normalizeVerdict(entry.verdict);
    if (invalid !== undefined) {
      normalizationNotes.push(`unrecognized verdict ${JSON.stringify(invalid)} for "${title}" routed to NEEDS_HUMAN`);
    } else if (normalized) {
      normalizationNotes.push(`verdict "${String(entry.verdict)}" normalized to ${verdict} for "${title}"`);
    }
    const item = {
      title,
      verdict,
      // KEEP findings carry the reviewer severity verbatim (code-enforced join);
      // WEAKEN severity reduction is the report stage's job, with cited counter-evidence.
      severity: reviewerFinding ? reviewerFinding.severity : (entry.finding && typeof entry.finding === "object" ? String(entry.finding.severity ?? "unknown") : "unknown"),
      reviewerFinding,
      evidence: entry.evidence ?? [],
      counterEvidence: entry.counterEvidence ?? [],
      recommendedAction: entry.recommendedAction ?? "",
    };
    if (verdict === "KEEP") partitions.keep.push(item);
    else if (verdict === "WEAKEN") partitions.weaken.push(item);
    else if (verdict === "DROP") partitions.drop.push(item);
    else partitions.needsHuman.push(item);
  }

  // Findings the devil-advocate stage never returned a verdict for must not
  // vanish silently: route them to needsHuman.
  for (const finding of reviewerFindings) {
    const titleKey = normalizeText(finding.title);
    if (matchedTitles.has(titleKey)) continue;
    partitions.needsHuman.push({
      title: String(finding.title ?? ""),
      verdict: "NEEDS_HUMAN",
      severity: finding.severity,
      reviewerFinding: finding,
      evidence: [],
      counterEvidence: [],
      recommendedAction: "",
      note: "no devil-advocate verdict received for this finding",
    });
    normalizationNotes.push(`reviewer finding "${String(finding.title ?? "")}" had no verdict; routed to NEEDS_HUMAN`);
  }

  return {
    partitions,
    partitionSummary: {
      keep: partitions.keep.length,
      weaken: partitions.weaken.length,
      drop: partitions.drop.length,
      needsHuman: partitions.needsHuman.length,
      verdictsReceived: verdictEntries.length,
      reviewerFindings: reviewerFindings.length,
    },
    normalizationNotes,
  };
}

export default async function findingPipeline({ sources, options = {} }) {
  const mode = String(options.mode ?? "");
  if (mode === "dedup") return dedupFindings(sources);
  if (mode === "partition") return partitionVerdicts(sources, options);
  throw new Error(`finding-pipeline: unknown mode "${mode}" (expected "dedup" or "partition")`);
}
