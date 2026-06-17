import fs from "node:fs";

export function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

export function extractFindingsJson(text) {
  const blocks = [];
  const fenceRe = /```([^\n`]*)\n([\s\S]*?)```/g;
  let match;
  while ((match = fenceRe.exec(text))) {
    const lang = String(match[1] ?? "").trim().toLowerCase();
    const body = String(match[2] ?? "").trim();
    blocks.push({ lang, body });
  }

  const orderedBlocks = [
    ...blocks.filter((block) => block.lang === "json" || block.lang === "json findings" || block.lang === "findings"),
    ...blocks.filter((block) => !(block.lang === "json" || block.lang === "json findings" || block.lang === "findings")),
  ];
  const candidates = [...orderedBlocks.map((block) => block.body), text.trim()].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && Array.isArray(parsed.findings) && typeof parsed.noMaterialIssues === "boolean") {
        return { ok: true, extractionMode: orderedBlocks.some((block) => block.body === candidate) ? "json_block" : "whole_output_json", data: parsed };
      }
    } catch {
      // Try next candidate.
    }
  }
  return {
    ok: false,
    extractionMode: "missing_or_invalid_json",
    data: { findings: [], noMaterialIssues: false },
    error: "No valid candidate findings JSON block found",
  };
}

export function validateCandidateFindings(data) {
  const issues = [];
  if (!data || typeof data !== "object") issues.push("candidate output is not an object");
  if (!Array.isArray(data?.findings)) issues.push("findings must be an array");
  if (typeof data?.noMaterialIssues !== "boolean") issues.push("noMaterialIssues must be boolean");
  for (const [index, finding] of (data?.findings ?? []).entries()) {
    const prefix = `findings[${index}]`;
    if (!["critical", "high", "medium", "low"].includes(finding.severity)) issues.push(`${prefix}.severity invalid`);
    for (const key of ["file", "claim", "evidenceQuote", "fix"]) {
      if (typeof finding[key] !== "string" || !finding[key].trim()) issues.push(`${prefix}.${key} missing`);
    }
    if (finding.line !== undefined && (!Number.isInteger(finding.line) || finding.line < 1)) issues.push(`${prefix}.line invalid`);
    if (finding.lineEnd !== undefined && (!Number.isInteger(finding.lineEnd) || finding.lineEnd < 1)) issues.push(`${prefix}.lineEnd invalid`);
    if (finding.locations !== undefined) {
      if (!Array.isArray(finding.locations)) issues.push(`${prefix}.locations must be an array`);
      for (const [locationIndex, location] of (Array.isArray(finding.locations) ? finding.locations : []).entries()) {
        const locationPrefix = `${prefix}.locations[${locationIndex}]`;
        if (!location || typeof location !== "object") {
          issues.push(`${locationPrefix} must be an object`);
          continue;
        }
        if (typeof location.file !== "string" || !location.file.trim()) issues.push(`${locationPrefix}.file missing`);
        for (const key of ["line", "lineEnd", "startLine", "endLine"]) {
          if (location[key] !== undefined && (!Number.isInteger(location[key]) || location[key] < 1)) issues.push(`${locationPrefix}.${key} invalid`);
        }
        if (location.symbol !== undefined && (typeof location.symbol !== "string" || !location.symbol.trim())) issues.push(`${locationPrefix}.symbol invalid`);
      }
    }
    if (finding.confidence !== undefined && (typeof finding.confidence !== "number" || finding.confidence < 0 || finding.confidence > 1)) issues.push(`${prefix}.confidence invalid`);
  }
  if (data?.noMaterialIssues === true && (data?.findings ?? []).length > 0) issues.push("noMaterialIssues=true conflicts with non-empty findings");
  return issues;
}

export function severityWeight(severity) {
  return { critical: 4, high: 3, medium: 2, low: 1 }[severity] ?? 1;
}

function normalizeTokens(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_./:-]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !new Set(["the", "and", "that", "this", "with", "from", "into", "must", "should"]).has(t));
}

function tokenOverlap(a, b) {
  const aa = new Set(normalizeTokens(a));
  const bb = new Set(normalizeTokens(b));
  if (!aa.size || !bb.size) return 0;
  let hit = 0;
  for (const t of aa) if (bb.has(t)) hit++;
  return hit / Math.max(aa.size, bb.size);
}

function quoteVariants(value) {
  const text = String(value ?? "");
  return [...new Set([
    text,
    text.replace(/\\\\([bBdDsSwW(){}[\].+*?|^$\\])/g, "\\$1"),
    text.replace(/\\\\/g, "\\"),
  ])];
}

function quoteMatches(value, evidence) {
  const textVariants = quoteVariants(value);
  const quoteVariantsList = quoteVariants(evidence.quote);
  if (evidence.matchMode === "exact") {
    return textVariants.some((text) => quoteVariantsList.some((quote) => text.trim() === quote.trim()));
  }
  if (evidence.matchMode === "regex") return textVariants.some((text) => new RegExp(evidence.quote, "i").test(text));
  return textVariants.some((text) => quoteVariantsList.some((quote) => text.toLowerCase().includes(quote.toLowerCase())));
}

function lineOverlaps(location, region) {
  const line = location.line ?? location.startLine;
  const lineEnd = location.lineEnd ?? location.endLine ?? line;
  if (!line || !region.startLine) return true;
  const a0 = line;
  const a1 = lineEnd;
  const b0 = region.startLine;
  const b1 = region.endLine ?? region.startLine;
  return Math.max(a0, b0) <= Math.min(a1, b1);
}

function candidateLocations(finding) {
  const locations = [];
  if (Array.isArray(finding.locations)) {
    for (const location of finding.locations) {
      if (location && typeof location === "object" && location.file) locations.push(location);
    }
  }
  if (finding.file) {
    locations.push({
      file: finding.file,
      ...(finding.line !== undefined ? { line: finding.line } : {}),
      ...(finding.lineEnd !== undefined ? { lineEnd: finding.lineEnd } : {}),
    });
  }
  const seen = new Set();
  return locations.filter((location) => {
    const key = `${location.file}:${location.line ?? location.startLine ?? ""}:${location.lineEnd ?? location.endLine ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findingMatchesRegion(finding, region) {
  return candidateLocations(finding).some((location) => location.file === region.file && lineOverlaps(location, region));
}

export function scoreFindings(gold, candidate) {
  const bugs = gold.bugs ?? [];
  const findings = candidate.findings ?? [];
  const matchedFinding = new Set();
  const matches = [];

  for (const bug of bugs) {
    let best = null;
    for (const [index, finding] of findings.entries()) {
      if (matchedFinding.has(index)) continue;
      const fileMatch = (bug.locations ?? []).some((loc) => findingMatchesRegion(finding, loc));
      if (!fileMatch) continue;
      const evidenceScore = (bug.requiredEvidence ?? []).some((e) => candidateLocations(finding).some((location) => location.file === e.file) && quoteMatches(finding.evidenceQuote, e)) ? 1 : 0;
      const semanticScore = Math.max(tokenOverlap(finding.claim, bug.summary), tokenOverlap(finding.claim, bug.impact));
      const score = evidenceScore * 2 + semanticScore;
      if (score > 0.2 && (!best || score > best.score)) best = { index, finding, score, evidenceScore, semanticScore };
    }
    if (best) {
      matchedFinding.add(best.index);
      matches.push({ bugId: bug.bugId, findingIndex: best.index, evidenceScore: best.evidenceScore, semanticScore: best.semanticScore });
    }
  }

  const falsePositives = findings.map((finding, index) => ({ finding, index })).filter((item) => !matchedFinding.has(item.index));
  const goldWeight = bugs.reduce((sum, bug) => sum + severityWeight(bug.severity), 0);
  const matchedGoldWeight = matches.reduce((sum, m) => sum + severityWeight(bugs.find((b) => b.bugId === m.bugId)?.severity), 0);
  const findingWeight = findings.reduce((sum, f) => sum + severityWeight(f.severity), 0);
  const matchedFindingWeight = [...matchedFinding].reduce((sum, index) => sum + severityWeight(findings[index]?.severity), 0);

  const precision = findingWeight ? matchedFindingWeight / findingWeight : (bugs.length ? 1 : 1);
  const recall = goldWeight ? matchedGoldWeight / goldWeight : (findings.length ? 0 : 1);
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;

  const evidence = matches.length ? matches.reduce((sum, m) => sum + m.evidenceScore, 0) / matches.length : (bugs.length ? 0 : 1);
  const falsePositivePenalty = falsePositives.reduce((sum, item) => sum + severityWeight(item.finding.severity), 0) / Math.max(1, goldWeight + findingWeight);
  const noIssueHallucinationPenalty = bugs.length === 0 ? falsePositives.length : 0;
  const objectiveScore = Math.max(0, Math.min(1, 0.65 * f1 + 0.2 * evidence + 0.15 * (1 - falsePositivePenalty) - (bugs.length === 0 ? Math.min(1, noIssueHallucinationPenalty) : 0)));

  return {
    taskId: gold.taskId,
    candidateId: gold.candidateId,
    objectiveScore,
    precision,
    recall,
    f1,
    evidence,
    falsePositiveCount: falsePositives.length,
    noIssueHallucinationPenalty,
    matches,
    missed: bugs.filter((bug) => !matches.some((m) => m.bugId === bug.bugId)).map((bug) => bug.bugId),
  };
}
