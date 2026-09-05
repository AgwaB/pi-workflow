// Deterministic completion renderer for spec-review.
//
// partition-findings is the canonical ledger. The model-authored report is a
// bounded narrative overlay and cannot add, remove, or reclassify findings.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { partitionEvidenceComplete } from "./spec-evidence-gate.mjs";

const REPORT_VERDICTS = new Set([
	"CONFORMS",
	"GAPS_FOUND",
	"NEEDS_HUMAN",
	"INCONCLUSIVE",
]);

function findSource(sources, stageId) {
	const matches = Object.entries(sources ?? {})
		.filter(([specId]) => specId === stageId || specId.startsWith(`${stageId}.`))
		.sort(([a], [b]) => a.localeCompare(b));
	if (matches.length > 1) {
		throw new Error(
			`spec-review renderer: ambiguous ${stageId} source (${matches.map(([specId]) => specId).join(", ")})`,
		);
	}
	return matches[0]?.[1] ?? null;
}

function asArray(value) {
	return Array.isArray(value) ? value : [];
}

function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function cleanText(value) {
	return String(value ?? "")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.replace(/\s+([,.;:!?])/g, "$1")
		.trim();
}

function safeInline(value) {
	return cleanText(value)
		.replace(/\\/g, "\\\\")
		.replace(/([`*_[\]{}#+|>])/g, "\\$1")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function safeHeading(value) {
	return safeInline(value);
}

function tableCell(value) {
	return safeInline(value).replace(/\|/g, "\\|");
}

function completionText(value, maxChars = 220) {
	const sanitized = safeInline(value)
		.replace(/(?:^|[\\/])\.pi[\\/]workflows(?:[\\/][^\s]*)?/gi, "[artifact omitted]")
		.replace(/\b(?:final-report|audit|review|executive)\.md\b/gi, "[artifact omitted]")
		.replace(/\b(?:refs|control)\.json\b/gi, "[artifact omitted]")
		.replace(/\brelated[\s-]+artifacts\b/gi, "[section title omitted]")
		.replace(/\bworkflow[_-][\w.-]+\b/gi, "[run omitted]")
		.replace(/\btask[_-][\w.-]+\b/gi, "[task omitted]");
	const chars = Array.from(sanitized);
	return chars.length <= maxChars
		? sanitized
		: `${chars.slice(0, Math.max(1, maxChars - 1)).join("")}…`;
}

function stableStringify(value) {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function fenced(value, info = "text") {
	const text = typeof value === "string" ? value : stableStringify(value);
	const longestRun = Math.max(
		0,
		...[...String(text).matchAll(/`+/g)].map((match) => match[0].length),
	);
	const fence = "`".repeat(Math.max(3, longestRun + 1));
	return [
		`${fence}${info}`,
		String(text),
		fence,
	];
}

function rowIdentity(row, prefix, index) {
	const id = cleanText(row?.id ?? row?.findingId ?? "");
	return id || `${prefix}-row-${String(index + 1).padStart(3, "0")}`;
}

function rowTitle(row, fallback) {
	return cleanText(row?.title ?? row?.finding ?? row?.claim ?? row?.question ?? fallback);
}

function reportAvailable(report) {
	return Boolean(
		isRecord(report) &&
		cleanText(report.summary) &&
		REPORT_VERDICTS.has(cleanText(report.verdict)) &&
		Array.isArray(report.risks) &&
		cleanText(report.recommendedNextAction),
	);
}

function partitionSourceCoverageComplete(partition) {
	const summary = partition?.sourceStatusSummary;
	if (!isRecord(summary) || summary.metadataAvailable !== true) return false;
	const total = Number(summary.total);
	const completed = Number(summary.completed);
	const nonCompleted = Number(summary.nonCompleted);
	if (![total, completed, nonCompleted].every(Number.isInteger)) return false;
	if (total < 1 || completed < 0 || nonCompleted < 0) return false;
	if (completed + nonCompleted !== total) return false;
	if (completed !== total || nonCompleted !== 0) return false;
	return asArray(summary.partialFailures).length === 0;
}

const FINAL_SOURCE_STAGES = ["partition-findings", "report"];

function canonicalFinalSourceStage(value, stageId) {
	const text = cleanText(value);
	return text === stageId || text.startsWith(`${stageId}.`) ? stageId : "";
}

function finalSourceCoverageComplete(context) {
	if (!Array.isArray(context?.sourceStatuses)) return false;
	const statuses = context.sourceStatuses.filter(isRecord);
	if (statuses.length !== context.sourceStatuses.length) return false;

	const taskOwners = new Map();
	for (const status of statuses) {
		const taskId = typeof status.taskId === "string" ? status.taskId.trim() : "";
		if (!taskId) continue;
		const owners = taskOwners.get(taskId) ?? [];
		owners.push(status);
		taskOwners.set(taskId, owners);
	}
	if ([...taskOwners.values()].some((owners) => owners.length !== 1)) return false;

	const assigned = new Set();
	for (const stageId of FINAL_SOURCE_STAGES) {
		const matches = statuses
			.map((status, index) => ({ status, index }))
			.filter(({ status }) =>
				canonicalFinalSourceStage(status.stageId, stageId) === stageId &&
				canonicalFinalSourceStage(status.source, stageId) === stageId &&
				canonicalFinalSourceStage(status.specId, stageId) === stageId,
			);
		if (matches.length !== 1) return false;
		const [{ status, index }] = matches;
		if (
			assigned.has(index) ||
			cleanText(status.stageId) !== stageId ||
			cleanText(status.status) !== "completed" ||
			typeof status.taskId !== "string" ||
			!status.taskId.trim()
		)
			return false;
		assigned.add(index);
	}

	// Only the two canonical final-stage sources may participate in this join.
	// A completed but unrelated status is an orphan, not harmless extra context.
	return assigned.size === statuses.length;
}

function setEquals(left, right) {
	if (left.size !== right.size) return false;
	return [...left].every((item) => right.has(item));
}

function ownerKey(owner) {
	return [
		owner?.source,
		owner?.stageId,
		owner?.specId,
		owner?.taskId,
		owner?.itemIdentity,
		owner?.placeholderSpecId,
		owner?.batchId ?? "",
		owner?.status,
	].map((value) => String(value ?? "")).join("\u001f");
}

function exactOwnerShape(owner) {
	return isRecord(owner) &&
		["source", "stageId", "specId", "taskId", "itemIdentity", "placeholderSpecId", "status"]
			.every((field) => typeof owner[field] === "string" && owner[field].trim()) &&
		owner.status === "completed" &&
		(typeof owner.batchId === "undefined" || (typeof owner.batchId === "string" && owner.batchId.trim())) &&
		owner.specId === `${owner.stageId}.${owner.batchId ?? owner.itemIdentity}` &&
		owner.placeholderSpecId === `${owner.stageId}.item` &&
		(owner.batchId === undefined || owner.itemIdentity === owner.batchId);
}

function verifierOwnerLedgerComplete(partition) {
	const coverage = partition?.verifierCoverage;
	if (!isRecord(coverage) || !Array.isArray(coverage.ownerLedger) || !Array.isArray(coverage.verifierRows) || !isRecord(coverage.ownerLedgerReconciliation)) return false;
	const owners = coverage.ownerLedger;
	const rows = coverage.verifierRows;
	const reconciliation = coverage.ownerLedgerReconciliation;
	// An empty join is never a successful final render, including a forged 0/0
	// reconciliation. A batch carrier may own several verifier rows, but it
	// cannot make either side of the join vacuously complete.
	if (owners.length < 1 || rows.length < 1) return false;
	if (
		reconciliation.ownerRowCount !== owners.length ||
		reconciliation.verifierRowCount !== rows.length ||
		reconciliation.cardinalityPassed !== true ||
		reconciliation.passed !== true
	) return false;
	if (
		!Array.isArray(reconciliation.ownerIds) ||
		!Array.isArray(reconciliation.verifierIds) ||
		reconciliation.ownerIds.some((id) => typeof id !== "string" || !id.trim()) ||
		reconciliation.verifierIds.some((id) => typeof id !== "string" || !id.trim()) ||
		asArray(reconciliation.duplicateOwnerIds).length > 0 ||
		asArray(reconciliation.duplicateVerifierIds).length > 0 ||
		asArray(reconciliation.missingOwnerRows).length > 0 ||
		asArray(reconciliation.orphanOwnerRows).length > 0 ||
		asArray(reconciliation.statusMismatches).length > 0
	) return false;
	const ownerKeys = new Set();
	const ownerIds = [];
	for (const owner of owners) {
		if (!exactOwnerShape(owner)) return false;
		const key = ownerKey(owner);
		const id = cleanText(owner.batchId ?? owner.itemIdentity);
		if (!key || ownerKeys.has(key) || !id || ownerIds.includes(id)) return false;
		ownerKeys.add(key);
		ownerIds.push(id);
	}
	const verifierIds = [];
	for (const row of rows) {
		const id = cleanText(row?.id);
		if (!id || verifierIds.includes(id) || !exactOwnerShape(row?.owner) || !ownerKeys.has(ownerKey(row.owner))) return false;
		verifierIds.push(id);
		// Singleton ownership is one-to-one. A batch carrier is the only
		// permitted many-to-one owner relationship.
		if (!row.owner.batchId && cleanText(row.owner.itemIdentity) !== id) return false;
	}
	return (
		setEquals(new Set(reconciliation.ownerIds), new Set(ownerIds)) &&
		setEquals(new Set(reconciliation.verifierIds), new Set(verifierIds)) &&
		reconciliation.ownerIds.length === ownerIds.length &&
		reconciliation.verifierIds.length === verifierIds.length
	);
}

function verifierCoverageComplete(partition) {
	const coverage = partition?.verifierCoverage;
	const counts = partition?.verdictCounts;
	if (!verifierOwnerLedgerComplete(partition)) return false;
	if (!isRecord(coverage) || !isRecord(counts) || coverage.complete !== true) return false;
	const candidateCount = coverage.candidateCount;
	const uniqueCandidateCount = coverage.uniqueCandidateCount;
	const verifierCount = coverage.verifierCount;
	const uniqueVerifierCount = coverage.uniqueVerifierCount;
	const verifiedCandidateCount = coverage.verifiedCandidateCount;
	if (
		![
			candidateCount,
			uniqueCandidateCount,
			verifierCount,
			uniqueVerifierCount,
			verifiedCandidateCount,
		].every((value) => Number.isInteger(value) && value >= 0)
	)
		return false;
	const missingIds = asArray(coverage.missingIds).map(cleanText).filter(Boolean);
	const missingRows = asArray(partition.missingVerifications)
		.map((row) => cleanText(row?.id))
		.filter(Boolean);
	const orphanIds = asArray(coverage.orphanVerifierIds).map(cleanText).filter(Boolean);
	const orphanRows = asArray(partition.orphanVerifierResults)
		.map((row) => cleanText(row?.id))
		.filter(Boolean);
	const batchIssues = asArray(partition.batchIntegrityIssues);
	const finalFindings = asArray(partition.finalFindings);
	const actualKeep = finalFindings.filter(
		(row) => cleanText(row?.verdict) === "KEEP",
	).length;
	const actualWeaken = finalFindings.filter(
		(row) => cleanText(row?.verdict) === "WEAKEN",
	).length;
	const countFields = [
		"keep",
		"weaken",
		"drop",
		"needsHuman",
		"missingVerification",
		"invalidVerifier",
		"orphanVerifier",
	];
	if (
		!countFields.every(
			(field) => Number.isInteger(counts[field]) && counts[field] >= 0,
		)
	)
		return false;
	const candidateNeedsHumanSources = new Set([
		"candidate-findings",
		"evidence-gate",
		"verifier",
		"invalid-verdict",
		"missing-verification",
		"batch-integrity",
	]);
	const candidateNeedsHumanRows = asArray(partition.needsHuman).filter((row) =>
		candidateNeedsHumanSources.has(cleanText(row?.source)),
	).length;
	const canonicalCandidateDispositions =
		finalFindings.length +
		asArray(partition.droppedFindings).length +
		candidateNeedsHumanRows;
	if (canonicalCandidateDispositions !== uniqueCandidateCount) return false;
	const candidateDispositionRows = [
		...finalFindings,
		...asArray(partition.droppedFindings),
		...asArray(partition.needsHuman).filter((row) =>
			candidateNeedsHumanSources.has(cleanText(row?.source)),
		),
	];
	const candidateIds = candidateDispositionRows.map((row) => cleanText(row?.id));
	const verifierRows = asArray(coverage.verifierRows);
	const verifierIds = verifierRows.map((row) => cleanText(row?.id));
	if (
		candidateIds.some((id) => !id) ||
		new Set(candidateIds).size !== candidateIds.length ||
		verifierIds.some((id) => !id) ||
		new Set(verifierIds).size !== verifierIds.length ||
		candidateIds.length !== uniqueCandidateCount ||
		verifierIds.length !== uniqueVerifierCount ||
		!setEquals(new Set(candidateIds), new Set(verifierIds))
	) return false;
	return (
		candidateCount === uniqueCandidateCount &&
		verifierCount === verifierRows.length &&
		verifierCount === uniqueCandidateCount &&
		uniqueVerifierCount === uniqueCandidateCount &&
		verifiedCandidateCount + new Set(missingIds).size === uniqueCandidateCount &&
		setEquals(new Set(missingIds), new Set(missingRows)) &&
		setEquals(new Set(orphanIds), new Set(orphanRows)) &&
		asArray(coverage.duplicateCandidateIds).length === 0 &&
		asArray(coverage.duplicateVerifierIds).length === 0 &&
		missingIds.length === 0 &&
		orphanIds.length === 0 &&
		asArray(partition.invalidVerifierResults).length === 0 &&
		batchIssues.length === 0 &&
		counts.keep === actualKeep &&
		counts.weaken === actualWeaken &&
		counts.drop === asArray(partition.droppedFindings).length &&
		counts.needsHuman === asArray(partition.needsHuman).length &&
		counts.missingVerification === missingRows.length &&
		counts.invalidVerifier === asArray(partition.invalidVerifierResults).length &&
		counts.orphanVerifier === orphanRows.length &&
		(!Object.hasOwn(counts, "batchIntegrity") ||
			(Number.isInteger(counts.batchIntegrity) &&
				counts.batchIntegrity >= 0 &&
				counts.batchIntegrity === batchIssues.length))
	);
}

function duplicateCanonicalIds(finalFindings, needsHuman, droppedFindings) {
	const seen = new Set();
	const duplicates = new Set();
	for (const row of [...finalFindings, ...needsHuman, ...droppedFindings]) {
		const id = cleanText(row?.id ?? row?.findingId ?? "");
		if (!id) continue;
		if (seen.has(id)) duplicates.add(id);
		else seen.add(id);
	}
	return [...duplicates].sort();
}

function requiredVerdict(
	partition,
	sourceCoverageComplete,
	verifierCoverageIsComplete,
) {
	if (!sourceCoverageComplete) return "INCONCLUSIVE";
	const coverage = partition?.verifierCoverage ?? {};
	const integrityRows =
		asArray(partition?.missingVerifications).length +
		asArray(partition?.invalidVerifierResults).length +
		asArray(partition?.orphanVerifierResults).length +
		asArray(partition?.batchIntegrityIssues).length +
		asArray(coverage.duplicateCandidateIds).length +
		asArray(coverage.duplicateVerifierIds).length;
	const unresolvedRows = asArray(partition?.needsHuman).length;
	if (!verifierCoverageIsComplete)
		return integrityRows > 0 || unresolvedRows > 0
			? "NEEDS_HUMAN"
			: "INCONCLUSIVE";
	if (asArray(partition?.finalFindings).length > 0) return "GAPS_FOUND";
	if (integrityRows > 0 || unresolvedRows > 0) return "NEEDS_HUMAN";
	return "CONFORMS";
}

function renderEvidence(evidence) {
	const rows = asArray(evidence);
	if (rows.length === 0) return ["Evidence: _not provided_", ""];
	const out = ["Evidence:", ""];
	for (const row of rows) out.push(...fenced(row, isRecord(row) ? "json" : "text"), "");
	return out;
}

function renderFinalFindings(rows) {
	const out = ["## Actionable conformance gaps", ""];
	if (rows.length === 0) {
		out.push("No actionable KEEP or WEAKEN finding is present in the canonical ledger.", "");
		return out;
	}
	rows.forEach((row, index) => {
		const id = rowIdentity(row, "finding", index);
		out.push(
			`### ${safeHeading(id)} — ${safeHeading(rowTitle(row, "Untitled finding"))}`,
			"",
			`- Disposition: **${safeInline(row?.verdict)}**`,
			`- Severity: **${safeInline(row?.severity ?? "unknown")}**`,
			`- Requirements: ${asArray(row?.requirementIds).length ? asArray(row.requirementIds).map(safeInline).join(", ") : "not specified"}`,
			`- Claim: ${safeInline(row?.claim ?? "not specified")}`,
			`- Recommended action: ${safeInline(row?.recommendedAction ?? "not specified")}`,
			"",
			...renderEvidence(row?.evidence),
		);
	});
	return out;
}

function renderDispositionRows(heading, rows, prefix, emptyText) {
	const out = [`## ${heading}`, ""];
	if (rows.length === 0) return [...out, emptyText, ""];
	rows.forEach((row, index) => {
		const id = rowIdentity(row, prefix, index);
		out.push(
			`### ${safeHeading(id)} — ${safeHeading(rowTitle(row, heading))}`,
			"",
			`- Source/disposition: ${safeInline(row?.source ?? row?.verdict ?? prefix)}`,
			`- Reason: ${safeInline(row?.reason ?? row?.claim ?? row?.message ?? "not specified")}`,
			"",
		);
		if (asArray(row?.evidence).length > 0) out.push(...renderEvidence(row.evidence));
		if (asArray(row?.counterEvidence).length > 0) {
			out.push("Counter-evidence:", "");
			for (const evidence of row.counterEvidence)
				out.push(...fenced(evidence, isRecord(evidence) ? "json" : "text"), "");
		}
	});
	return out;
}

function renderRequirementCoverage(rows) {
	const out = ["## Requirement coverage", ""];
	if (rows.length === 0) return [...out, "No requirement-coverage rows were recorded.", ""];
	out.push("| Requirement | Status | Notes |", "|---|---|---|");
	for (const row of rows) {
		out.push(
			`| ${tableCell(row?.requirementId ?? row?.id ?? "unknown")} | ${tableCell(row?.status ?? "unknown")} | ${tableCell(row?.reason ?? row?.note ?? row?.summary ?? "")} |`,
		);
	}
	out.push("");
	return out;
}

function renderNoIssueNotes(rows) {
	const out = ["## Preliminary no-issue observations (unverified)", "", "These model-authored notes are not independent conformance evidence.", ""];
	if (rows.length === 0) return [...out, "No no-issue observations were recorded.", ""];
	for (const row of rows) {
		const text = typeof row === "string" ? row : stableStringify(row);
		out.push(`- ${safeInline(text)}`);
	}
	out.push("");
	return out;
}

function renderVerifierIntegrity(partition) {
	const coverage = partition.verifierCoverage ?? {};
	const out = [
		"## Verifier integrity",
		"",
		`- Candidates: ${Number(coverage.candidateCount ?? 0)} total; ${Number(coverage.uniqueCandidateCount ?? 0)} unique.`,
		`- Verifier rows: ${Number(coverage.verifierCount ?? 0)} total; ${Number(coverage.uniqueVerifierCount ?? 0)} unique.`,
		`- Missing verification rows: ${asArray(partition.missingVerifications).length} (their dispositions are rendered once under Needs human review).`,
		`- Orphan verifier rows: ${asArray(partition.orphanVerifierResults).length} (their dispositions are rendered once under Needs human review).`,
		`- Invalid verifier rows: ${asArray(partition.invalidVerifierResults).length}.`,
		`- Batch-integrity rows: ${asArray(partition.batchIntegrityIssues).length} (affected dispositions are rendered once under Needs human review).`,
		`- Owner ledger: ${asArray(coverage.ownerLedger).length} owner row(s), ${asArray(coverage.verifierRows).length} verifier row(s); reconciliation ${coverage.ownerLedgerReconciliation?.passed === true ? "passed" : "failed"}.`,
		"",
	];
	for (const [label, rows] of [
		["Duplicate candidate IDs", coverage.duplicateCandidateIds],
		["Duplicate verifier IDs", coverage.duplicateVerifierIds],
	]) {
		if (asArray(rows).length > 0)
			out.push(`- ${label}: ${asArray(rows).map(safeInline).join(", ")}`);
	}
	if (asArray(partition.invalidVerifierResults).length > 0) {
		out.push("", "Invalid verifier details:", "");
		for (const row of partition.invalidVerifierResults) out.push(...fenced(row, "json"), "");
	}
	return out;
}

function limitationRows({ sourceCoverageComplete, coverageComplete, duplicates, evidenceComplete, reportPresent, verdictConsistent }) {
	const rows = [];
	if (!sourceCoverageComplete)
		rows.push("Source lifecycle metadata is missing, partial, or inconsistent; complete conformance cannot be claimed.");
	if (!coverageComplete)
		rows.push("Candidate-to-verifier coverage or verifier integrity is incomplete or inconsistent.");
	if (duplicates.length > 0)
		rows.push(`Canonical disposition IDs are duplicated: ${duplicates.join(", ")}.`);
	if (!evidenceComplete)
		rows.push("Local byte evidence is incomplete, changed, or unverified for a disposition or positive requirement-coverage claim; legacy locators cannot establish support or justify removal.");
	if (!reportPresent)
		rows.push("The narrative report synthesis is absent or malformed.");
	else if (!verdictConsistent)
		rows.push("The narrative report verdict contradicts the deterministic ledger verdict.");
	return rows;
}

function renderCompletionSummary({ verdict, report, partition, limitations }) {
	const finalFindings = asArray(partition.finalFindings);
	const needsHuman = asArray(partition.needsHuman);
	const keyRows = [
		...finalFindings.map((row) => ({ label: row.verdict, row })),
		...needsHuman.map((row) => ({ label: "NEEDS_HUMAN", row })),
	].slice(0, 4);
	const out = [
		"## Core conclusion",
		"",
		`Verdict: **${verdict}**. ${completionText(report.summary, 800)}`,
		"",
		"## Key gaps and actions",
		"",
	];
	if (keyRows.length === 0) out.push("- No actionable or unresolved finding disposition remains.");
	else {
		for (const { label, row } of keyRows) {
			const action = cleanText(row?.recommendedAction ?? row?.reason ?? "");
			out.push(
				`- **${safeInline(label)}:** ${completionText(rowTitle(row, "Unresolved item"), 220)}${action ? ` — Action: ${completionText(action, 240)}` : ""}`,
			);
		}
		out.push(`- **Next action:** ${completionText(report.recommendedNextAction, 350)}`);
		const omitted = finalFindings.length + needsHuman.length - keyRows.length;
		if (omitted > 0) out.push(`- ${omitted} additional disposition row(s) are covered in the full report.`);
	}
	out.push(
		"",
		"## Evidence level",
		"",
		`- ${finalFindings.length} actionable, ${needsHuman.length} needs-human, and ${asArray(partition.droppedFindings).length} dropped canonical disposition row(s).`,
		"- Source lifecycle and candidate/verifier accounting passed deterministic completeness checks.",
		"",
		"## Important limitations",
		"",
	);
	const reportRisks = asArray(report.risks).map(cleanText).filter(Boolean);
	const combined = [...limitations, ...reportRisks];
	if (combined.length === 0) out.push("- No source-coverage or renderer-integrity limitation was recorded.");
	else for (const row of combined.slice(0, 6)) out.push(`- ${completionText(row, 220)}`);
	return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function renderMarkdown({ verdict, report, partition, completionSummaryMarkdown, limitations }) {
	const executive = completionSummaryMarkdown
		? completionSummaryMarkdown.replace(/^## /gm, "### ")
		: `### Core conclusion\n\nRenderer status is not passed. The effective deterministic verdict is **${verdict}**; inspect Evidence and limitations before relying on this report.`;
	const lines = [
		"# Spec review report",
		"",
		"## Executive summary",
		"",
		executive,
		"",
		"## Conformance conclusion",
		"",
		`- Effective verdict: **${verdict}**`,
		`- Narrative summary: ${safeInline(report?.summary ?? "Narrative synthesis unavailable.")}`,
		"",
		...renderFinalFindings(asArray(partition.finalFindings)),
		...renderRequirementCoverage(asArray(partition.requirementCoverage)),
		...renderDispositionRows(
			"Needs human review",
			asArray(partition.needsHuman),
			"needs-human",
			"No needs-human disposition is present in the canonical ledger.",
		),
		...renderDispositionRows(
			"Dropped findings",
			asArray(partition.droppedFindings),
			"dropped",
			"No dropped finding is present in the canonical ledger.",
		),
		...renderNoIssueNotes(asArray(partition.noIssueNotes)),
		...renderVerifierIntegrity(partition),
		"## Byte evidence audit",
		"",
		...fenced(partition.evidenceGate ?? { complete: false, reason: "legacy partition has no byte gate" }, "json"),
		"",
		"## Recommended next action",
		"",
		safeInline(report?.recommendedNextAction ?? "Resolve renderer blockers, then rerun the spec review."),
		"",
		"## Evidence and limitations",
		"",
		`- Partition source lifecycle: ${partitionSourceCoverageComplete(partition) ? "complete" : "partial, missing, or inconsistent"}.`,
		`- Canonical counts: ${asArray(partition.finalFindings).length} actionable, ${asArray(partition.needsHuman).length} needs-human, ${asArray(partition.droppedFindings).length} dropped.`,
		"- The deterministic partition ledger controls findings, dispositions, counts, and the effective verdict; narrative synthesis cannot override it.",
		...(limitations.length > 0
			? limitations.map((row) => `- ${safeInline(row)}`)
			: ["- No source-coverage or renderer-integrity limitation was recorded."]),
		"",
		"## Related artifacts",
		"",
		"- [Machine-readable renderer control](control.json)",
		"- [Structured source references](refs.json)",
		"- [Canonical disposition ledger](source-ledger.json)",
	];
	return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function blockedResult(reason) {
	return {
		schema: "spec-review-render-v1",
		digest: `Spec review rendering blocked: ${reason}.`,
		status: "blocked",
		blockers: [reason],
		completionSummaryMarkdown: "",
		markdown: "",
		verdict: "INCONCLUSIVE",
		findingSummary: { final: 0, needsHuman: 0, dropped: 0 },
		renderedFindingIds: [],
		renderedNeedsHumanIds: [],
		renderedDroppedFindingIds: [],
		sourceArtifacts: [],
		gates: {
			partitionAvailable: false,
			reportSynthesisAvailable: false,
			ownerLedgerReconciliationPassed: false,
			sourceCoverageComplete: false,
			verifierCoverageComplete: false,
			reportVerdictConsistent: false,
			renderedAllCanonicalRows: false,
			duplicateCanonicalIds: [],
			actionableEvidenceComplete: false,
			passed: false,
		},
	};
}

export default async function renderSpecReviewReport({ sources, context = {} }) {
	let partition;
	let report;
	try {
		partition = findSource(sources, "partition-findings");
		report = findSource(sources, "report");
	} catch (error) {
		return blockedResult(error instanceof Error ? error.message : String(error));
	}
	if (!isRecord(partition)) return blockedResult("missing partition-findings control source");
	const reportPresent = reportAvailable(report);
	const finalFindings = asArray(partition.finalFindings);
	const needsHuman = asArray(partition.needsHuman);
	const droppedFindings = asArray(partition.droppedFindings);
	const renderedFindingIds = finalFindings.map((row, index) => rowIdentity(row, "finding", index));
	const renderedNeedsHumanIds = needsHuman.map((row, index) => rowIdentity(row, "needs-human", index));
	const renderedDroppedFindingIds = droppedFindings.map((row, index) => rowIdentity(row, "dropped", index));
	const missingRequiredIds = [
		...finalFindings.filter((row) => !cleanText(row?.id)),
		...droppedFindings.filter((row) => !cleanText(row?.id)),
	].length;
	const duplicates = duplicateCanonicalIds(finalFindings, needsHuman, droppedFindings);
	const renderedAllCanonicalRows =
		missingRequiredIds === 0 &&
		renderedFindingIds.length === finalFindings.length &&
		renderedNeedsHumanIds.length === needsHuman.length &&
		renderedDroppedFindingIds.length === droppedFindings.length;
	const sourceCoverageComplete =
		partitionSourceCoverageComplete(partition) && finalSourceCoverageComplete(context);
	const ownerLedgerReconciliationPassed = verifierOwnerLedgerComplete(partition);
	const coverageComplete = verifierCoverageComplete(partition);
	const evidenceComplete = await partitionEvidenceComplete(partition, context);
	const ledgerVerdict = requiredVerdict(
		partition,
		sourceCoverageComplete,
		coverageComplete,
	);
	const verdict = !evidenceComplete && ledgerVerdict === "CONFORMS" ? "INCONCLUSIVE" : ledgerVerdict;
	const verdictConsistent = reportPresent && cleanText(report.verdict) === verdict;
	const limitations = limitationRows({
		sourceCoverageComplete,
		coverageComplete,
		duplicates,
		evidenceComplete,
		reportPresent,
		verdictConsistent,
	});
	const passed =
		reportPresent &&
		sourceCoverageComplete &&
		coverageComplete &&
		verdictConsistent &&
		renderedAllCanonicalRows &&
		duplicates.length === 0 &&
		evidenceComplete;
	const completionSummaryMarkdown = passed
		? renderCompletionSummary({ verdict, report, partition, limitations })
		: "";
	const markdown = renderMarkdown({
		verdict,
		report: report ?? {},
		partition,
		completionSummaryMarkdown,
		limitations,
	});
	const blockers = limitations.slice(0, 32);
	const controlForDigest = {
		verdict,
		findingSummary: {
			final: finalFindings.length,
			needsHuman: needsHuman.length,
			dropped: droppedFindings.length,
		},
		renderedFindingIds,
		renderedNeedsHumanIds,
		renderedDroppedFindingIds,
		passed,
		markdown,
	};

	let sidecarPath;
	let ledgerSidecarPath;
	try {
		if (context.cwd && context.runId && context.taskId) {
			const taskDir = join(
				context.cwd,
				".pi",
				"workflows",
				context.runId,
				"tasks",
				context.taskId,
			);
			await mkdir(taskDir, { recursive: true });
			await writeFile(join(taskDir, "final-report.md"), `${markdown}\n`, "utf8");
			await writeFile(
				join(taskDir, "source-ledger.json"),
				`${stableStringify({ schema: "spec-review-source-ledger-v1", partition })}\n`,
				"utf8",
			);
			sidecarPath = "final-report.md";
			ledgerSidecarPath = "source-ledger.json";
		}
	} catch {
		// Sidecars are non-authoritative; control remains deterministic.
	}

	return {
		schema: "spec-review-render-v1",
		digest: `sha256:${createHash("sha256").update(stableStringify(controlForDigest)).digest("hex")}`,
		status: passed ? "passed" : "failed",
		...(blockers.length > 0 ? { blockers } : {}),
		completionSummaryMarkdown,
		markdown,
		verdict,
		findingSummary: controlForDigest.findingSummary,
		renderedFindingIds,
		renderedNeedsHumanIds,
		renderedDroppedFindingIds,
		sourceArtifacts: [
			"partition-findings.control.json",
			...(reportPresent ? ["report.control.json"] : []),
		],
		gates: {
			partitionAvailable: true,
			reportSynthesisAvailable: reportPresent,
			sourceCoverageComplete,
			verifierCoverageComplete: coverageComplete,
			ownerLedgerReconciliationPassed,
			reportVerdictConsistent: verdictConsistent,
			renderedAllCanonicalRows,
			duplicateCanonicalIds: duplicates,
			actionableEvidenceComplete: evidenceComplete,
			passed,
		},
		...(sidecarPath ? { sidecarPath } : {}),
		...(ledgerSidecarPath ? { ledgerSidecarPath } : {}),
	};
}
