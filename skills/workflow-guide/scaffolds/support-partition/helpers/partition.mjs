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
      verifications.push({ source: key, verification: value });
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
  return String(finding?.id ?? finding?.findingId ?? fallback);
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

function exactId(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value ? value : undefined;
}

function groupById(rows, getId) {
  const map = new Map();
  for (const row of rows) {
    const id = getId(row);
    if (id) map.set(id, [...(map.get(id) ?? []), row]);
  }
  return map;
}

export default async function helper({ sources, options = {}, context = {} }) {
  const candidateStage = String(options.candidateStage ?? "collect-candidates");
  const verificationStage = String(options.verificationStage ?? "verify-candidates");
  const candidates = collectCandidates(sources, candidateStage);
  const verifications = collectVerifications(sources, verificationStage);
  const candidateById = groupById(candidates, (row) => exactId(row.id));
  const verifierById = groupById(verifications, (row) => exactId(row.verification.candidateId));
  const normalizationNotes = [];
  const issues = [];
  const verifiedIds = [];
  const partitions = { keep: [], weaken: [], drop: [], needsHuman: [] };
  const candidateSources = sourceValues(sources).filter(({ key }) => key === candidateStage || key.startsWith(`${candidateStage}.`));
  if (candidateSources.length !== 1 || !Array.isArray(candidateSources[0]?.value.candidates) || candidateSources[0].value.candidates.length !== candidates.length) {
    issues.push({ reason: "missing or ambiguous candidate source" });
  }
  const statuses = Array.isArray(context.sourceStatuses) ? context.sourceStatuses : [];
  const owners = statuses.filter((row) => row.stageId === verificationStage && row.specId !== `${verificationStage}.item`);
  // Source names route controls to status records; only explicit itemIdentity
  // binds an assignment. Never derive identity from aliases, titles or order.
  for (const row of verifications) {
    const id = exactId(row.verification.candidateId);
    const matches = owners.filter((owner) => owner.source === row.source);
    const owner = matches[0];
    row.valid = Boolean(id && candidateById.get(id)?.length === 1 &&
      verifierById.get(id)?.length === 1 && exactId(row.verification.finding?.id) === id &&
      (row.verification.finding?.findingId === undefined || row.verification.finding.findingId === id) &&
      matches.length === 1 && owner.itemIdentity === id && owner.status === "completed" &&
      exactId(owner.taskId) && exactId(owner.specId) && owner.specId.startsWith(`${verificationStage}.`) &&
      owner.placeholderSpecId === `${verificationStage}.item` &&
      owners.filter((other) => other.itemIdentity === id || other.taskId === owner.taskId || other.specId === owner.specId).length === 1);
    if (!row.valid) issues.push({ source: row.source, candidateId: id ?? null, echoedId: row.verification.finding?.id ?? null, reason: "invalid, duplicate, unknown or mismatched verifier assignment" });
  }
  for (const owner of owners) {
    if (!verifications.some((row) => row.source === owner.source && row.valid)) {
      issues.push({ source: owner.source, candidateId: owner.itemIdentity ?? null, reason: "materialized assignment has no valid verifier control" });
    }
  }
  candidates.forEach((candidate, index) => {
    const id = exactId(candidate.id);
    const row = id && verifierById.get(id)?.find((entry) => entry.valid);
    if (!row || candidateSources.length !== 1) {
      partitions.needsHuman.push({
        ...compactFinding(candidate, {}, "NEEDS_HUMAN", index),
        note: "no unique identity-matched verifier verdict received for this candidate"
      });
      issues.push({ candidateId: id ?? null, reason: "candidate has no unique valid verifier assignment" });
      return;
    }
    const { verification } = row;
    const verdict = normalizeVerdict(verification.verdict, normalizationNotes, id);
    const item = { ...compactFinding(verification.finding, verification, verdict, index), findingId: id };
    verifiedIds.push(id);
    if (verdict === "KEEP") partitions.keep.push(item);
    else if (verdict === "WEAKEN") partitions.weaken.push(item);
    else if (verdict === "DROP") partitions.drop.push(item);
    else partitions.needsHuman.push(item);
  });
  const identityIntegrity = { plannedIds: candidates.map((row) => exactId(row.id) ?? null), verifiedIds, issues, complete: issues.length === 0 };
  normalizationNotes.push(...issues.map((issue) => `identity integrity: ${issue.reason} (${issue.candidateId ?? issue.source ?? "source"})`));

  const partitionSummary = {
    keep: partitions.keep.length,
    weaken: partitions.weaken.length,
    drop: partitions.drop.length,
    needsHuman: partitions.needsHuman.length,
    verdictsReceived: verifications.length,
    candidates: candidates.length,
    integrity: identityIntegrity.complete ? "complete" : "partial"
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
      identityIntegrity,
      helperContext: {
        specPath: context?.specPath ? String(context.specPath) : "",
        candidateStage,
        verificationStage
      }
    }
  };
}
