#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    run: null,
    out: null,
    markdown: null,
    task: null,
    arm: "workflow",
    plainRun: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--run") args.run = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--markdown") args.markdown = argv[++i];
    else if (arg === "--task") args.task = argv[++i];
    else if (arg === "--arm") args.arm = argv[++i];
    else if (arg === "--plain-run") args.plainRun = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      usage(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!args.run) usage(1);
  return args;
}

function usage(code) {
  const text = `Usage: node .pi/eval/bug-forge/scripts/measure-context.mjs --run <run-dir> [options]\n\nOptions:\n  --out <path>       Write JSON summary (default: <run-dir>/context-summary.json)\n  --markdown <path>  Write Markdown summary (default with --out omitted: <run-dir>/context-summary.md)\n  --task <task-id>   Limit to one task directory\n  --arm <arm>        Arm to analyze (default: workflow)\n  --plain-run <dir>  Use another run's plain outputs for output expansion\n`;
  if (code === 0) console.log(text);
  else console.error(text);
  process.exit(code);
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function fileSize(file) {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

function listDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function titleKey(item) {
  return normalizeText(item?.title ?? item?.claim ?? item?.summary ?? "");
}

function locationKey(location) {
  if (!location || typeof location !== "object") return "";
  const file = String(location.file ?? "").trim();
  const line = location.line ?? location.startLine ?? "";
  const lineEnd = location.lineEnd ?? location.endLine ?? "";
  const symbol = String(location.symbol ?? "").trim();
  if (!file && !line && !symbol) return "";
  return [file, line, lineEnd, symbol].join(":");
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function byteLength(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}

function collectEvidenceQuotes(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectEvidenceQuotes(item, out);
    return out;
  }
  if (!value || typeof value !== "object") return out;
  for (const key of ["evidenceQuotes", "evidence", "counterEvidence"]) {
    const candidate = value[key];
    if (Array.isArray(candidate)) {
      for (const quote of candidate) {
        if (typeof quote === "string" && quote.trim()) out.push(quote.trim());
      }
    } else if (typeof candidate === "string" && candidate.trim()) {
      out.push(candidate.trim());
    }
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") collectEvidenceQuotes(child, out);
  }
  return out;
}

function countGenericDigests(taskControls) {
  const generic = [];
  for (const task of taskControls) {
    const digest = String(task.control?.digest ?? "").trim();
    if (!digest) continue;
    if (/^(support helper completed\.?|completed\.?|done\.?)$/i.test(digest)) {
      generic.push({ taskId: task.taskId, stageId: task.stageId, digest });
    }
  }
  return generic;
}

function parseLedger(file) {
  const text = readText(file);
  if (!text) return [];
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      rows.push({ parseError: true, raw: line });
    }
  }
  return rows;
}

function findWorkflowRoot(armDir, runResult) {
  const controlPath = runResult?.collected?.controlPath;
  if (controlPath && existsSync(controlPath)) {
    return path.dirname(path.dirname(path.dirname(controlPath)));
  }
  const runId = runResult?.runId;
  if (runId) {
    const candidate = path.join(armDir, "workspace", ".pi", "workflows", runId);
    if (existsSync(candidate)) return candidate;
  }
  const workflowsDir = path.join(armDir, "workspace", ".pi", "workflows");
  for (const dir of listDirs(workflowsDir)) {
    const candidate = path.join(workflowsDir, dir);
    if (existsSync(path.join(candidate, "run.json"))) return candidate;
  }
  return null;
}

function taskDirFor(workflowRoot, task) {
  const resultFile = task?.files?.result;
  if (resultFile) {
    const absolute = path.isAbsolute(resultFile)
      ? resultFile
      : path.join(workflowRoot, "..", "..", "..", resultFile);
    const dir = path.dirname(absolute);
    if (existsSync(dir)) return dir;
  }
  return path.join(workflowRoot, "tasks", task.taskId);
}

function readTaskControls(workflowRoot, runJson) {
  const rows = [];
  for (const task of toArray(runJson?.tasks)) {
    const dir = taskDirFor(workflowRoot, task);
    const controlPath = path.join(dir, "control.json");
    const rawPath = path.join(dir, "raw.md");
    const analysisPath = path.join(dir, "analysis.md");
    const taskPath = path.join(dir, "task.md");
    const sourceManifestPath = path.join(dir, "source-manifest.json");
    const ledgerPath = path.join(dir, "read-ledger.jsonl");
    rows.push({
      taskId: task.taskId,
      specId: task.specId,
      stageId: task.stageId,
      kind: task.kind,
      status: task.status,
      statusDetail: task.statusDetail,
      lastMessage: task.lastMessage,
      dir,
      controlPath,
      control: readJson(controlPath, null),
      sizes: {
        controlBytes: fileSize(controlPath),
        rawBytes: fileSize(rawPath),
        analysisBytes: fileSize(analysisPath),
        taskPromptBytes: fileSize(taskPath),
        sourceManifestBytes: fileSize(sourceManifestPath),
      },
      ledger: parseLedger(ledgerPath),
    });
  }
  return rows;
}

function stageControls(taskControls, stageId) {
  return taskControls.filter((task) => task.stageId === stageId && task.control);
}

function findingsFromControl(control) {
  if (!control || typeof control !== "object") return [];
  const arrays = [
    control.findings,
    control.candidateFindings,
    control.needsHuman,
    control.partitions?.keep,
    control.partitions?.weaken,
    control.partitions?.drop,
    control.partitions?.needsHuman,
    control.reportContext?.keep,
    control.reportContext?.weaken,
    control.reportContext?.needsHuman,
  ];
  return arrays.flatMap((value) => toArray(value));
}

function collectReviewerFindings(taskControls) {
  return stageControls(taskControls, "reviewers").flatMap((task) => findingsFromControl(task.control));
}

function partitionControl(taskControls) {
  return stageControls(taskControls, "partition-verdicts").at(-1)?.control ?? null;
}

function reportControl(taskControls, runResult) {
  const collectedPath = runResult?.collected?.controlPath;
  if (collectedPath) {
    const control = readJson(collectedPath, null);
    if (control) return control;
  }
  return stageControls(taskControls, "report").at(-1)?.control ?? null;
}

function matchReportItems(partitionItems, reportItems) {
  const reportById = new Map();
  const reportByTitle = new Map();
  for (const item of reportItems) {
    if (item?.findingId) reportById.set(String(item.findingId), item);
    const key = titleKey(item);
    if (key && !reportByTitle.has(key)) reportByTitle.set(key, item);
  }
  return partitionItems.map((item) => {
    const byId = item?.findingId ? reportById.get(String(item.findingId)) : null;
    return { partition: item, report: byId ?? reportByTitle.get(titleKey(item)) ?? null };
  });
}

function preservationMetrics(partition, report) {
  const keepWeaken = [
    ...toArray(partition?.partitions?.keep),
    ...toArray(partition?.partitions?.weaken),
  ];
  const reportFindings = toArray(report?.findings);
  const matches = matchReportItems(keepWeaken, reportFindings);
  let locationSourceCount = 0;
  let locationPreservedCount = 0;
  let evidenceSourceCount = 0;
  let evidencePreservedCount = 0;
  let severityDriftCount = 0;

  for (const { partition: source, report: target } of matches) {
    if (!target) continue;
    const sourceLocations = new Set(toArray(source.locations).map(locationKey).filter(Boolean));
    const targetLocations = new Set(toArray(target.locations).map(locationKey).filter(Boolean));
    locationSourceCount += sourceLocations.size;
    for (const key of sourceLocations) {
      if (targetLocations.has(key)) locationPreservedCount += 1;
    }

    const sourceQuotes = toArray(source.evidenceQuotes).filter((quote) => typeof quote === "string" && quote.trim());
    const targetText = JSON.stringify([target.evidenceQuotes, target.evidence, target.counterEvidence]);
    evidenceSourceCount += sourceQuotes.length;
    for (const quote of sourceQuotes) {
      const normalizedQuote = quote.trim();
      if (normalizedQuote && targetText.includes(normalizedQuote)) evidencePreservedCount += 1;
    }
    if (String(source.severity ?? "") && String(target.severity ?? "") && source.severity !== target.severity) {
      severityDriftCount += 1;
    }
  }

  return {
    reportMatchedKeepWeaken: matches.filter((match) => match.report).length,
    reportFindings: reportFindings.length,
    locationSourceCount,
    locationPreservedCount,
    locationPreservationRatio: locationSourceCount ? locationPreservedCount / locationSourceCount : null,
    evidenceQuoteSourceCount: evidenceSourceCount,
    evidenceQuotePreservedCount: evidencePreservedCount,
    evidenceQuotePreservationRatio: evidenceSourceCount ? evidencePreservedCount / evidenceSourceCount : null,
    severityDriftCount,
  };
}

function objectiveScoreOf(scoreFile) {
  return scoreFile?.score?.objectiveScore ?? scoreFile?.objectiveScore ?? null;
}

function measureCell(runRoot, taskId, arm, options = {}) {
  const taskDir = path.join(runRoot, taskId);
  const armDir = path.join(taskDir, arm);
  const runResult = readJson(path.join(armDir, "run-result.json"), null);
  const workflowRoot = findWorkflowRoot(armDir, runResult);
  const localPlainOutputBytes = fileSize(path.join(taskDir, "plain", "output.md"));
  const baselinePlainOutputBytes = options.plainRun
    ? fileSize(path.join(options.plainRun, taskId, "plain", "output.md"))
    : 0;
  const plainOutputBytes = localPlainOutputBytes || baselinePlainOutputBytes;
  const workflowOutputBytes = fileSize(path.join(armDir, "output.md"));
  const score = readJson(path.join(armDir, "score.json"), null);

  if (!workflowRoot) {
    return {
      taskId,
      arm,
      available: false,
      reason: "missing workflow root",
      score: objectiveScoreOf(score),
      outputBytes: workflowOutputBytes,
      plainOutputBytes,
      outputExpansion: plainOutputBytes ? workflowOutputBytes / plainOutputBytes : null,
    };
  }

  const runJson = readJson(path.join(workflowRoot, "run.json"), null);
  const taskControls = readTaskControls(workflowRoot, runJson);
  const failedTasks = toArray(runJson?.tasks)
    .filter((task) => task.status && task.status !== "completed")
    .map((task) => ({
      taskId: task.taskId,
      specId: task.specId,
      stageId: task.stageId,
      status: task.status,
      statusDetail: task.statusDetail,
      lastMessage: task.lastMessage,
    }));
  const report = reportControl(taskControls, runResult);
  const partition = partitionControl(taskControls);
  const reviewerFindings = collectReviewerFindings(taskControls);
  const dedup = stageControls(taskControls, "dedup-findings").at(-1)?.control ?? null;
  const genericDigests = countGenericDigests(taskControls);
  const allQuotes = taskControls.flatMap((task) => collectEvidenceQuotes(task.control));
  const uniqueQuotes = [...new Set(allQuotes)];
  const totalQuoteBytes = allQuotes.reduce((sum, quote) => sum + byteLength(quote), 0);
  const uniqueQuoteBytes = uniqueQuotes.reduce((sum, quote) => sum + byteLength(quote), 0);
  const ledgerRows = taskControls.flatMap((task) => task.ledger.map((entry) => ({ ...entry, readerTaskId: task.taskId, readerStageId: task.stageId })));
  const readRows = ledgerRows.filter((entry) => entry.schema === "workflow-artifact-read-v1");
  const missingVerdictNeedsHuman = toArray(partition?.partitions?.needsHuman).filter((item) =>
    /no\s+devil(?:['’]s)?[-\s]?advocate\s+verdict|no\s+verdict/i.test(String(item?.note ?? "")),
  ).length;
  const sourceStatusPartialFailures = [
    ...toArray(dedup?.sourceStatusSummary?.partialFailures),
    ...toArray(partition?.sourceStatusSummary?.partialFailures),
    ...toArray(partition?.reportContext?.partialFailures),
  ];

  const sizes = taskControls.reduce(
    (acc, task) => {
      for (const [key, value] of Object.entries(task.sizes)) acc[key] += value;
      return acc;
    },
    { controlBytes: 0, rawBytes: 0, analysisBytes: 0, taskPromptBytes: 0, sourceManifestBytes: 0 },
  );

  return {
    taskId,
    arm,
    available: true,
    score: objectiveScoreOf(score),
    workflowRunId: runJson?.runId ?? runResult?.runId ?? null,
    runStatus: runJson?.status ?? runResult?.collected?.runStatus ?? null,
    reportCollected: Boolean(report),
    failedTaskCount: failedTasks.length,
    failedButReportCollected: failedTasks.length > 0 && Boolean(report),
    failedTasks,
    reviewerFindings: reviewerFindings.length,
    dedupUnique: dedup?.dedupSummary?.uniqueCount ?? (toArray(dedup?.findings).length || null),
    partitionSummary: partition?.partitionSummary ?? null,
    missingVerdictNeedsHuman,
    sourceStatusPartialFailureCount: sourceStatusPartialFailures.length,
    sourceStatusPartialFailures,
    preservation: preservationMetrics(partition, report),
    genericDigestCount: genericDigests.length,
    genericDigests,
    readLedger: {
      readCount: readRows.length,
      upstreamReadBytes: readRows.reduce((sum, row) => sum + Number(row.returnedBytes ?? row.bytes ?? 0), 0),
      truncatedReads: readRows.filter((row) => row.truncated).length,
      parseErrorCount: ledgerRows.filter((row) => row.parseError).length,
    },
    sizes: {
      ...sizes,
      outputBytes: workflowOutputBytes,
      plainOutputBytes,
      outputExpansion: plainOutputBytes ? workflowOutputBytes / plainOutputBytes : null,
    },
    evidenceDuplication: {
      quoteCount: allQuotes.length,
      uniqueQuoteCount: uniqueQuotes.length,
      totalQuoteBytes,
      uniqueQuoteBytes,
      duplicationRatio: uniqueQuoteBytes ? totalQuoteBytes / uniqueQuoteBytes : null,
    },
  };
}

function aggregate(cells) {
  const available = cells.filter((cell) => cell.available);
  const numericAvg = (selector) => {
    const values = available.map(selector).filter((value) => typeof value === "number" && Number.isFinite(value));
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };
  return {
    taskCount: cells.length,
    availableTaskCount: available.length,
    failedButReportCollected: available.filter((cell) => cell.failedButReportCollected).length,
    failedTaskCount: available.reduce((sum, cell) => sum + cell.failedTaskCount, 0),
    genericDigestCount: available.reduce((sum, cell) => sum + cell.genericDigestCount, 0),
    missingVerdictNeedsHuman: available.reduce((sum, cell) => sum + cell.missingVerdictNeedsHuman, 0),
    truncatedReads: available.reduce((sum, cell) => sum + cell.readLedger.truncatedReads, 0),
    upstreamReadBytes: available.reduce((sum, cell) => sum + cell.readLedger.upstreamReadBytes, 0),
    controlBytes: available.reduce((sum, cell) => sum + cell.sizes.controlBytes, 0),
    outputExpansionAvg: numericAvg((cell) => cell.sizes.outputExpansion),
    locationPreservationAvg: numericAvg((cell) => cell.preservation.locationPreservationRatio),
    evidenceQuotePreservationAvg: numericAvg((cell) => cell.preservation.evidenceQuotePreservationRatio),
    evidenceDuplicationAvg: numericAvg((cell) => cell.evidenceDuplication.duplicationRatio),
  };
}

function markdownReport(summary) {
  const lines = [];
  lines.push(`# Context metrics for ${summary.runRoot}`);
  lines.push("");
  lines.push("Diagnostic only; not part of objective score.");
  lines.push("");
  lines.push("## Aggregate");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---:|");
  for (const [key, value] of Object.entries(summary.aggregate)) {
    lines.push(`| ${key} | ${formatValue(value)} |`);
  }
  lines.push("");
  lines.push("## Cells");
  lines.push("");
  lines.push("| Task | Score | Run status | Failed tasks | Failed+report | Missing verdicts | Generic digests | Read KB | Output x | Loc preserve | Quote preserve |");
  lines.push("|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const cell of summary.cells) {
    if (!cell.available) {
      lines.push(`| ${cell.taskId} | ${formatValue(cell.score)} | unavailable: ${cell.reason} |  |  |  |  |  |  |  |  |`);
      continue;
    }
    lines.push(
      `| ${cell.taskId} | ${formatValue(cell.score)} | ${cell.runStatus ?? ""} | ${cell.failedTaskCount} | ${cell.failedButReportCollected ? 1 : 0} | ${cell.missingVerdictNeedsHuman} | ${cell.genericDigestCount} | ${formatValue(cell.readLedger.upstreamReadBytes / 1024)} | ${formatValue(cell.sizes.outputExpansion)} | ${formatValue(cell.preservation.locationPreservationRatio)} | ${formatValue(cell.preservation.evidenceQuotePreservationRatio)} |`,
    );
  }
  lines.push("");
  lines.push("## Failed tasks");
  lines.push("");
  for (const cell of summary.cells.filter((item) => item.available && item.failedTasks.length > 0)) {
    lines.push(`### ${cell.taskId}`);
    for (const task of cell.failedTasks) {
      lines.push(`- ${task.specId ?? task.taskId}: ${task.status}${task.lastMessage ? ` — ${task.lastMessage}` : ""}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function formatValue(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(3);
  if (typeof value === "boolean") return value ? "1" : "0";
  return String(value);
}

function main() {
  const args = parseArgs(process.argv);
  const runRoot = path.resolve(args.run);
  if (!existsSync(runRoot)) throw new Error(`run directory not found: ${runRoot}`);
  const taskIds = args.task ? [args.task] : listDirs(runRoot).filter((name) => name.startsWith("review-case-"));
  const plainRun = args.plainRun ? path.resolve(args.plainRun) : null;
  const cells = taskIds.map((taskId) => measureCell(runRoot, taskId, args.arm, { plainRun }));
  const summary = {
    schema: "bug-forge-context-metrics-v1",
    generatedAt: new Date().toISOString(),
    runRoot,
    arm: args.arm,
    ...(plainRun ? { plainRun } : {}),
    aggregate: aggregate(cells),
    cells,
  };

  const out = path.resolve(args.out ?? path.join(runRoot, "context-summary.json"));
  writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
  const markdown = args.markdown ?? (!args.out ? path.join(runRoot, "context-summary.md") : null);
  if (markdown) writeFileSync(path.resolve(markdown), markdownReport(summary));
  console.log(`Wrote ${out}`);
  if (markdown) console.log(`Wrote ${path.resolve(markdown)}`);
}

main();
