const VERDICTS = new Set(["KEEP", "WEAKEN", "DROP", "NEEDS_HUMAN"]);

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function asArray(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [];
}

function strings(value) {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

function dedupeStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function sourceValues(sources) {
  return Object.entries(asObject(sources) ?? {}).map(([key, value]) => ({ key, value: asObject(value) })).filter((entry) => entry.value);
}

function collectCandidates(sources, candidateStage) {
  const candidates = [];
  for (const { key, value } of sourceValues(sources)) {
    if (key === candidateStage || key.startsWith(`${candidateStage}.`)) {
      candidates.push(...asArray(value.candidates));
    }
  }
  return candidates;
}

function collectVerifications(sources, verificationStage) {
  const verifications = [];
  for (const { key, value } of sourceValues(sources)) {
    if (key === verificationStage || key.startsWith(`${verificationStage}.`)) {
      if (value.verdict || value.finding || value.candidateId) verifications.push(value);
    }
  }
  return verifications;
}

function normalizeVerdict(value, notes, label) {
  const raw = String(value ?? "").trim().toUpperCase().replace(/[ -]+/g, "_");
  if (VERDICTS.has(raw)) return raw;
  if (raw.startsWith("KEEP")) {
    notes.push(`normalized verdict for ${label} to KEEP`);
    return "KEEP";
  }
  if (raw.startsWith("WEAK")) {
    notes.push(`normalized verdict for ${label} to WEAKEN`);
    return "WEAKEN";
  }
  if (raw.startsWith("DROP") || raw.startsWith("REJECT")) {
    notes.push(`normalized verdict for ${label} to DROP`);
    return "DROP";
  }
  notes.push(`unrecognized verdict for ${label}; routed to NEEDS_HUMAN`);
  return "NEEDS_HUMAN";
}

function findingId(finding, fallback) {
  return String(finding?.findingId ?? finding?.id ?? fallback);
}

function compactFinding(finding, verification, verdict, index) {
  const source = asObject(finding) ?? {};
  const fallback = `finding-${String(index + 1).padStart(3, "0")}`;
  return {
    findingId: findingId(source, fallback),
    title: String(source.title ?? verification?.title ?? fallback),
    severity: String(source.severity ?? "unknown"),
    verdict,
    locations: asArray(source.locations),
    evidenceQuotes: dedupeStrings([
      ...strings(source.evidenceQuotes),
      ...strings(verification?.evidenceQuotes)
    ]),
    counterEvidence: dedupeStrings(strings(verification?.counterEvidence)),
    recommendedAction: String(verification?.recommendedAction ?? source.recommendedAction ?? "")
  };
}

function candidateKey(candidate) {
  return String(candidate?.id ?? candidate?.findingId ?? candidate?.title ?? "").toLowerCase();
}

function buildCandidateMap(candidates) {
  const map = new Map();
  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    if (key && !map.has(key)) map.set(key, candidate);
  }
  return map;
}

export default async function helper({ sources, options = {}, context = {} }) {
  const candidateStage = String(options.candidateStage ?? "collect-candidates");
  const verificationStage = String(options.verificationStage ?? "verify-candidates");
  const candidates = collectCandidates(sources, candidateStage);
  const verifications = collectVerifications(sources, verificationStage);
  const candidateByKey = buildCandidateMap(candidates);
  const seen = new Set();
  const normalizationNotes = [];
  const partitions = { keep: [], weaken: [], drop: [], needsHuman: [] };

  verifications.forEach((verification, index) => {
    const candidateId = String(verification.candidateId ?? "");
    const echoedFinding = asObject(verification.finding) ?? {};
    const candidate = candidateByKey.get(candidateId.toLowerCase()) ?? candidateByKey.get(candidateKey(echoedFinding));
    const finding = Object.keys(echoedFinding).length > 0 ? echoedFinding : candidate;
    const label = candidateId || finding?.title || `verification ${index + 1}`;
    const verdict = normalizeVerdict(verification.verdict, normalizationNotes, label);
    const item = compactFinding(finding, verification, verdict, index);
    const key = item.findingId.toLowerCase();
    if (key) seen.add(key);
    if (verdict === "KEEP") partitions.keep.push(item);
    else if (verdict === "WEAKEN") partitions.weaken.push(item);
    else if (verdict === "DROP") partitions.drop.push(item);
    else partitions.needsHuman.push(item);
  });

  candidates.forEach((candidate, index) => {
    const key = findingId(candidate, `candidate-${index + 1}`).toLowerCase();
    if (seen.has(key)) return;
    partitions.needsHuman.push({
      ...compactFinding(candidate, { recommendedAction: "Human review required because no verifier verdict was produced." }, "NEEDS_HUMAN", index),
      note: "no verifier verdict received for this candidate"
    });
    normalizationNotes.push(`candidate ${key} had no verifier verdict; routed to NEEDS_HUMAN`);
  });

  const partitionSummary = {
    keep: partitions.keep.length,
    weaken: partitions.weaken.length,
    drop: partitions.drop.length,
    needsHuman: partitions.needsHuman.length,
    verdictsReceived: verifications.length,
    candidates: candidates.length
  };
  const reportContext = {
    keep: partitions.keep,
    weaken: partitions.weaken,
    needsHuman: partitions.needsHuman
  };

  return {
    schema: "helper-output-v1",
    digest: `partition: keep=${partitionSummary.keep}, weaken=${partitionSummary.weaken}, drop=${partitionSummary.drop}, needsHuman=${partitionSummary.needsHuman}`,
    value: {
      partitions,
      reportContext,
      partitionSummary,
      normalizationNotes,
      helperContext: {
        specPath: context?.specPath ? String(context.specPath) : "",
        candidateStage,
        verificationStage
      }
    }
  };
}
