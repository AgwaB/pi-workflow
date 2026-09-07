// Deterministic completion renderer for impact-review.
//
// The three readiness joins and impact-synthesis keep their workflow-specific
// ontologies. This helper reconciles them conservatively, renders every
// structured row, and never lets narrative synthesis override canonical risk.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const STAGES = [
	"impact-synthesis",
	"contract-consistency",
	"regression-risk",
	"ship-readiness",
];
const LEDGER_STAGES = [
	"change-scope",
	"implementation-map",
	"validation-map",
	"api-contract-impact",
	"state-data-impact",
	"validation-impact",
	"docs-release-impact",
	"security-performance-impact",
	"contract-consistency",
	"regression-risk",
	"ship-readiness",
	"impact-synthesis",
];
const VERDICTS = new Set(["READY", "NEEDS_WORK", "BLOCKED", "UNKNOWN"]);
const RISKS = ["none", "low", "medium", "high"];
const RISK_LEVELS = new Set([...RISKS, "unknown"]);
const CONTRACT_STATES = new Set(["pass", "warn", "fail", "unknown"]);
const SHIP_STATES = new Set(["ready", "needs-work", "blocked", "unknown"]);

function asArray(value) {
	return Array.isArray(value) ? value : [];
}

function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function cleanText(value) {
	return String(value ?? "")
		.replace(
			/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g,
			" ",
		)
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

function canonicalSourceKey(stageId) {
	return `impact-analysis.${stageId}`;
}

function findSource(sources, stageId) {
	const key = canonicalSourceKey(stageId);
	return isRecord(sources) && isRecord(sources[key]) ? sources[key] : null;
}

function statusStageMatches(status, stageId) {
	const source = canonicalSourceKey(stageId);
	const stage = cleanText(status?.stageId);
	const specId = cleanText(status?.specId);
	return (
		(stage === stageId || stage === source) &&
		(specId === source || specId === `${source}.main`)
	);
}

// The runtime manifest, rather than model-produced origin/sourceIds, owns the
// source identity.  Only the shipped 12-source bundle is accepted here; old
// four-source captures must not silently enter the fresh protocol.
function impactSourceCoverage(context) {
	const statuses = Array.isArray(context?.sourceStatuses)
		? context.sourceStatuses
		: [];
	const expected = LEDGER_STAGES.map((stageId) => ({
		stageId,
		source: canonicalSourceKey(stageId),
	}));
	const missing = [];
	const duplicate = [];
	const wrongStage = [];
	const orphan = [];
	const assignments = [];
	const assignedIndexes = new Set();
	const taskOwners = new Map();
	for (const [index, status] of statuses.entries()) {
		const taskId = cleanText(status?.taskId);
		if (!taskId) continue;
		if (taskOwners.has(taskId)) taskOwners.get(taskId).push(index);
		else taskOwners.set(taskId, [index]);
	}
	const duplicateTaskIds = [...taskOwners.entries()]
		.filter(([, indexes]) => indexes.length > 1)
		.map(([taskId]) => taskId);
	for (const target of expected) {
		const matches = statuses
			.map((status, index) => ({ status, index }))
			.filter(({ status }) => cleanText(status?.source) === target.source);
		if (matches.length === 0) {
			missing.push(target);
			continue;
		}
		if (matches.length !== 1) {
			duplicate.push({ target, statusIndexes: matches.map(({ index }) => index) });
			continue;
		}
		const [{ status, index }] = matches;
		assignedIndexes.add(index);
		assignments.push({
			sourceId: target.source,
			stageId: target.stageId,
			statusSpecId: cleanText(status.specId),
			statusSource: cleanText(status.source),
			taskId: cleanText(status.taskId),
		});
		if (
			!statusStageMatches(status, target.stageId) ||
			cleanText(status.status) !== "completed" ||
			!cleanText(status.taskId)
		)
			wrongStage.push({
				stageId: target.stageId,
				statusSource: cleanText(status.source),
				statusSpecId: cleanText(status.specId),
				claimedStageId: cleanText(status.stageId),
				status: cleanText(status.status),
			});
	}
	statuses.forEach((status, index) => {
		if (!assignedIndexes.has(index))
			orphan.push({
				index,
				source: cleanText(status?.source),
				specId: cleanText(status?.specId),
				stageId: cleanText(status?.stageId),
			});
	});
	return {
		available: Array.isArray(context?.sourceStatuses),
		expected,
		assignments,
		missing,
		duplicate,
		wrongStage,
		orphan,
		duplicateTaskIds,
		statusCount: statuses.length,
		expectedCount: expected.length,
		bijection:
			Array.isArray(context?.sourceStatuses) &&
			missing.length === 0 &&
			duplicate.length === 0 &&
			wrongStage.length === 0 &&
			orphan.length === 0 &&
			duplicateTaskIds.length === 0 &&
			assignments.length === expected.length &&
			statuses.length === expected.length,
	};
}

// These are the producer-owned observations.  The final helper reads them
// directly; no model is asked to recopy a second identity-bearing ledger.
const ORIGINAL_FIELDS = {
	"change-scope": [
		["changeInputs", "scope"],
		["affectedFiles", "scope"],
		["affectedComponents", "scope"],
		["publicSurfaces", "scope"],
		["assumptions", "assumption"],
		["outOfScope", "scope"],
	],
	"implementation-map": [
		["components", "scope"],
		["entryPoints", "scope"],
		["dataFlows", "scope"],
		["unknowns", "gap"],
	],
	"validation-map": [
		["tests", "scope"],
		["docs", "scope"],
		["releaseArtifacts", "scope"],
		["validationCommandsMentioned", "action"],
		["knownGaps", "gap"],
	],
	"validation-impact": [
		["coveredAreas", "scope"],
		["missingValidation", "gap"],
		["recommendedCommands", "action"],
		["assumptions", "assumption"],
	],
	"api-contract-impact": [["impacts", "issue"], ["assumptions", "assumption"]],
	"state-data-impact": [["impacts", "issue"], ["assumptions", "assumption"]],
	"docs-release-impact": [["impacts", "issue"], ["assumptions", "assumption"]],
	"security-performance-impact": [
		["impacts", "risk"],
		["assumptions", "assumption"],
	],
	"contract-consistency": [
		["issues", "issue"],
		["confirmedConsistencies", "assumption"],
	],
	"regression-risk": [["risks", "risk"], ["riskReducers", "action"]],
	"ship-readiness": [
		["requiredBeforeShip", "action"],
		["niceToHave", "action"],
		["assumptions", "assumption"],
	],
	"impact-synthesis": [
		["blockingIssues", "blocker"],
		["nonBlockingIssues", "issue"],
		["confirmedSafeAreas", "assumption"],
		["recommendedNextActions", "action"],
		["validationToRun", "action"],
		["needsHuman", "gap"],
	],
};

function optionalString(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function contentHash(value) {
	return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function originalRowId(stageId, field, item, occurrence) {
	const producerId = optionalString(item?.id);
	const base = producerId
		? `${canonicalSourceKey(stageId)}:${field}:${producerId}`
		: `${canonicalSourceKey(stageId)}:${field}:payload-${contentHash(item).slice(7)}`;
	return occurrence > 1 ? `${base}#${occurrence}` : base;
}

function originalRow(stageId, field, kind, item, index, occurrence, taskId) {
	const record = isRecord(item) ? item : { text: String(item ?? "") };
	const declaredSeverity = cleanText(record.severity ?? record.riskLevel).toLowerCase();
	// An omitted optional severity is not an assertion that risk is unknown.
	// Preserve explicit uncertainty and conservatively handle unknown labels.
	const severity = declaredSeverity === "critical"
		? "high"
		: RISK_LEVELS.has(declaredSeverity)
			? declaredSeverity
			: declaredSeverity || record.scope === "unknown"
				? "unknown"
				: "none";
	const source = canonicalSourceKey(stageId);
	return {
		id: originalRowId(stageId, field, record, occurrence),
		text: optionalString(record.text) || stableStringify(record),
		kind: [
			"issue",
			"risk",
			"scope",
			"assumption",
			"gap",
			"blocker",
			"action",
		].includes(record.kind)
			? record.kind
			: kind,
		severity,
		scope: ["known", "unknown"].includes(record.scope) ? record.scope : "known",
		resolution: ["unresolved", "resolved", "accepted", "not-applicable"].includes(
			record.resolution,
		)
			? record.resolution
			: "unresolved",
		resolutionNote:
			optionalString(record.resolutionNote) ||
			`No resolution was established for original ${field} row.`,
		// These are host-derived identities.  Producer sourceIds/origin fields
		// remain part of the original control but cannot replace this provenance.
		origin: stageId,
		sourceIds: [source],
		provenance: {
			source,
			stage: stageId,
			...(taskId ? { taskId } : {}),
			field,
			index,
		},
		contentHash: contentHash(item),
		...(typeof record.owner === "string" && record.owner.trim()
			? { owner: record.owner }
			: {}),
		...(Array.isArray(record.resolutionEvidence) &&
		record.resolutionEvidence.every(
			(item) =>
				isRecord(item) &&
				typeof item.type === "string" &&
				item.type.trim() &&
				typeof item.ref === "string" &&
				item.ref.trim(),
		)
			? { resolutionEvidence: record.resolutionEvidence }
			: {}),
	};
}

function originalRowsForStage(stageId, value, taskId) {
	const rows = [];
	for (const [field, kind] of ORIGINAL_FIELDS[stageId] ?? []) {
		const occurrences = new Map();
		for (const [index, item] of asArray(value?.[field]).entries()) {
			const key = optionalString(item?.id)
				? `id:${optionalString(item.id)}`
				: `payload:${contentHash(item)}`;
			const occurrence = (occurrences.get(key) ?? 0) + 1;
			occurrences.set(key, occurrence);
			rows.push({
				field,
				index,
				source: item,
				row: originalRow(stageId, field, kind, item, index, occurrence, taskId),
			});
		}
	}
	return rows;
}

function sourceControlFailures(stageId, value) {
	if (!isRecord(value)) return [`${stageId}:missing-control`];
	return (ORIGINAL_FIELDS[stageId] ?? [])
		.filter(([field]) => !Array.isArray(value[field]))
		.map(([field]) => `${stageId}:missing-original-field:${field}`);
}

function resolutionClaimNeedsVerification(row) {
	return Boolean(row && (["resolved", "accepted"].includes(row.resolution) || (row.resolution === "not-applicable" && row.severity !== "none")));
}

function reconcileImpactLedger(sources, context = {}) {
	const assignments = new Map(
		impactSourceCoverage(context).assignments.map((item) => [item.stageId, item]),
	);
	const canonicalRows = {};
	const allRows = [];
	const stageFailures = [];
	const unverifiedResolutions = new Set();
	const ids = new Set();
	const expectedSources = new Set(LEDGER_STAGES.map(canonicalSourceKey));
	for (const sourceKey of Object.keys(sources ?? {}))
		if (!expectedSources.has(sourceKey))
			stageFailures.push(`runtime-sources:unexpected-source-key:${sourceKey}`);
	for (const stageId of LEDGER_STAGES) {
		const value = findSource(sources, stageId);
		const taskId = assignments.get(stageId)?.taskId;
		stageFailures.push(...sourceControlFailures(stageId, value));
		const rows = originalRowsForStage(stageId, value, taskId).map(({ row }) => row);
		for (const row of rows) {
			if (ids.has(row.id)) stageFailures.push(`${stageId}:${row.id}:identity-collision`);
			ids.add(row.id);
			if (resolutionClaimNeedsVerification(row)) unverifiedResolutions.add(row.id);
		}
		canonicalRows[stageId] = rows;
		allRows.push(...rows);
	}
	const sourceCoverage = impactSourceCoverage(context);
	if (!sourceCoverage.bijection)
		stageFailures.push("runtime-source-statuses:incomplete-12-source-bijection");
	const complete = stageFailures.length === 0 && unverifiedResolutions.size === 0;
	return {
		mode: "ledger",
		status: complete ? "complete" : "invalid",
		impactLedger: allRows,
		missingIds: [],
		duplicateIds: [...new Set(stageFailures.filter((item) => item.includes("identity-collision")).map((item) => item.split(":")[1]))].sort(),
		fabricatedSourceIds: [],
		stageFailures: [...new Set(stageFailures)].sort(),
		unverifiedResolutions: [...unverifiedResolutions].sort(),
		canonicalRows,
		complete,
	};
}

function synthesisValid(value) {
	return Boolean(
		isRecord(value) &&
			cleanText(value.schema) &&
			cleanText(value.digest) &&
			cleanText(value.summary) &&
			VERDICTS.has(cleanText(value.verdict)) &&
			RISK_LEVELS.has(cleanText(value.riskLevel)) &&
			[
				"blockingIssues",
				"nonBlockingIssues",
				"confirmedSafeAreas",
				"recommendedNextActions",
				"validationToRun",
				"needsHuman",
			].every((key) => Array.isArray(value[key])),
	);
}

function contractValid(value) {
	return Boolean(
		isRecord(value) &&
			cleanText(value.schema) &&
			cleanText(value.digest) &&
			CONTRACT_STATES.has(cleanText(value.status)) &&
			Array.isArray(value.issues) &&
			Array.isArray(value.confirmedConsistencies),
	);
}

function regressionValid(value) {
	return Boolean(
		isRecord(value) &&
			cleanText(value.schema) &&
			cleanText(value.digest) &&
			RISK_LEVELS.has(cleanText(value.riskLevel)) &&
			Array.isArray(value.risks) &&
			Array.isArray(value.riskReducers),
	);
}

function shipValid(value) {
	return Boolean(
		isRecord(value) &&
			cleanText(value.schema) &&
			cleanText(value.digest) &&
			SHIP_STATES.has(cleanText(value.status)) &&
			Array.isArray(value.requiredBeforeShip) &&
			Array.isArray(value.niceToHave) &&
			Array.isArray(value.assumptions),
	);
}

function requiredVerdict({ synthesis, contract, regression, ship }) {
	if (ship.status === "blocked" || asArray(synthesis.blockingIssues).length > 0)
		return "BLOCKED";
	if (
		ship.status === "unknown" ||
		contract.status === "unknown" ||
		regression.riskLevel === "unknown" ||
		asArray(synthesis.needsHuman).length > 0
	)
		return "UNKNOWN";
	if (
		ship.status === "needs-work" ||
		contract.status === "warn" ||
		contract.status === "fail" ||
		asArray(ship.requiredBeforeShip).length > 0 ||
		asArray(synthesis.nonBlockingIssues).length > 0
	)
		return "NEEDS_WORK";
	return "READY";
}

function riskFloorConsistent(
	synthesisRisk,
	regressionRisk,
	canonicalRisk = "none",
) {
	if (
		!RISK_LEVELS.has(synthesisRisk) ||
		!RISK_LEVELS.has(regressionRisk) ||
		!RISK_LEVELS.has(canonicalRisk)
	)
		return false;
	if (canonicalRisk === "unknown")
		return synthesisRisk === "unknown" && regressionRisk === "unknown";
	if (regressionRisk === "unknown") return synthesisRisk === "unknown";
	if (synthesisRisk === "unknown") return true;
	return (
		RISKS.indexOf(synthesisRisk) >= RISKS.indexOf(regressionRisk) &&
		RISKS.indexOf(synthesisRisk) >= RISKS.indexOf(canonicalRisk) &&
		RISKS.indexOf(regressionRisk) >= RISKS.indexOf(canonicalRisk)
	);
}

function effectiveRiskLevel(
	synthesisRisk,
	regressionRisk,
	canonicalRisk = "none",
) {
	if (
		synthesisRisk === "unknown" ||
		regressionRisk === "unknown" ||
		canonicalRisk === "unknown"
	)
		return "unknown";
	const indexes = [synthesisRisk, regressionRisk, canonicalRisk].map((risk) =>
		RISKS.indexOf(risk),
	);
	if (indexes.every((index) => index < 0)) return "unknown";
	return RISKS[Math.max(...indexes)] ?? "unknown";
}

function informationalUnknown(row) {
	if (row?.severity !== "unknown") return false;
	const text = cleanText(row.text).toLowerCase();
	return /out[- ]of[- ]scope|read[- ]only|unknown caller|caller(?:s)? unavailable|informational note/.test(text) &&
		!/(required|missing|block|must|unavailable baseline|cannot|critical)/.test(text);
}

function summarizeCanonicalRisk(rows, unverifiedResolutions = []) {
	const unverified = new Set(unverifiedResolutions);
	const observationIds = new Set();
	let knownFloor = "none";
	for (const row of rows) {
		// Unbound resolution claims cannot remove either a known risk or an
		// unquantified observation. Unknown is not an ordinal above "high".
		if (row.resolution !== "unresolved" && !unverified.has(row.id)) continue;
		if (row.severity === "unknown") {
			if (!informationalUnknown(row)) observationIds.add(row.id ?? `${row.stageId}.status`);
			continue;
		}
		if (RISKS.indexOf(row.severity) > RISKS.indexOf(knownFloor)) knownFloor = row.severity;
	}
	return { present: observationIds.size > 0, knownFloor, observationIds: [...observationIds].sort() };
}

function rowText(row) {
	return safeInline(typeof row === "string" ? row : stableStringify(row));
}

function renderRows(heading, rows, emptyText) {
	const values = asArray(rows);
	const lines = [`### ${heading}`, ""];
	if (values.length === 0) lines.push(emptyText);
	else values.forEach((row) => lines.push(`- ${rowText(row)}`));
	lines.push("");
	return { lines, rendered: values.length };
}

function rowCollections({ synthesis, contract, regression, ship }) {
	return [
		[
			"blockingIssues",
			"Blocking issues",
			synthesis.blockingIssues,
			"No blocking issue was recorded.",
		],
		[
			"nonBlockingIssues",
			"Non-blocking issues",
			synthesis.nonBlockingIssues,
			"No non-blocking issue was recorded.",
		],
		[
			"recommendedNextActions",
			"Recommended next actions",
			synthesis.recommendedNextActions,
			"No recommended action was recorded.",
		],
		[
			"validationToRun",
			"Validation to run",
			synthesis.validationToRun,
			"No validation command was recorded.",
		],
		[
			"needsHuman",
			"Needs human review",
			synthesis.needsHuman,
			"No needs-human row was recorded.",
		],
		[
			"confirmedSafeAreas",
			"Confirmed safe areas",
			synthesis.confirmedSafeAreas,
			"No confirmed-safe row was recorded.",
		],
		[
			"contractIssues",
			"Contract issues",
			contract.issues,
			"No contract inconsistency was recorded.",
		],
		[
			"confirmedConsistencies",
			"Confirmed consistencies",
			contract.confirmedConsistencies,
			"No confirmed consistency was recorded.",
		],
		[
			"regressionRisks",
			"Regression risks",
			regression.risks,
			"No regression-risk row was recorded.",
		],
		[
			"riskReducers",
			"Risk reducers",
			regression.riskReducers,
			"No risk-reducer row was recorded.",
		],
		[
			"requiredBeforeShip",
			"Required before ship",
			ship.requiredBeforeShip,
			"No required-before-ship row was recorded.",
		],
		[
			"niceToHave",
			"Nice to have",
			ship.niceToHave,
			"No nice-to-have row was recorded.",
		],
		[
			"readinessAssumptions",
			"Readiness assumptions",
			ship.assumptions,
			"No readiness assumption was recorded.",
		],
	];
}

function issueSummary(collections) {
	return Object.fromEntries(
		collections.map(([key, _heading, rows]) => [key, asArray(rows).length]),
	);
}

function completionText(value, maxChars = 300) {
	const sanitized = safeInline(value)
		.replace(/\.pi\b(?:[\\/][^\s]*)?/gi, "[artifact omitted]")
		.replace(
			/\b(?:final-report|audit|review|executive)\.md\b/gi,
			"[artifact omitted]",
		)
		.replace(/\b(?:refs|control)\.json\b/gi, "[artifact omitted]")
		.replace(/\brelated[\s-]+artifacts\b/gi, "[section title omitted]")
		.replace(/\bworkflow[_-][\w.-]+\b/gi, "[run omitted]")
		.replace(/\btask[_-][\w.-]+\b/gi, "[task omitted]");
	const chars = Array.from(sanitized);
	return chars.length <= maxChars
		? sanitized
		: `${chars.slice(0, Math.max(1, maxChars - 1)).join("")}…`;
}

function actionSummaryRows(synthesis, ship) {
	const rows = [
		...asArray(ship.requiredBeforeShip),
		...asArray(synthesis.blockingIssues),
		...asArray(synthesis.nonBlockingIssues),
		...asArray(synthesis.recommendedNextActions),
		...asArray(synthesis.validationToRun),
		...asArray(synthesis.needsHuman),
	];
	const seen = new Set();
	return rows
		.filter((row) => {
			const key =
				isRecord(row) && cleanText(row.id)
					? `id:${cleanText(row.id)}`
					: `row:${stableStringify(row)}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
}

function renderCompletionSummary({
	verdict,
	riskLevel,
	synthesis,
	ship,
	summary,
	limitations,
}) {
	const actions = actionSummaryRows(synthesis, ship);
	const out = [
		"## Core conclusion",
		"",
		`Verdict: **${verdict}**; risk: **${riskLevel}**. ${completionText(synthesis.summary, 850)}`,
		"",
		"## Key actions",
		"",
	];
	if (actions.length === 0)
		out.push(
			"- No blocking issue, follow-up action, or validation command was recorded.",
		);
	else
		actions.forEach((row) =>
			out.push(
				`- ${completionText(typeof row === "string" ? row : stableStringify(row), 420)}`,
			),
		);
	out.push(
		"",
		"## Evidence level",
		"",
		`- Deterministic joins recorded ${summary.contractIssues} contract issue(s), ${summary.regressionRisks} regression risk(s), and ${summary.requiredBeforeShip} required-before-ship row(s).`,
		"- Contract consistency, regression risk, ship readiness, and synthesis controls passed source-completeness checks.",
		"",
		"## Important limitations",
		"",
	);
	const importantLimitations = [
		...limitations,
		...asArray(synthesis.needsHuman),
		...asArray(ship.assumptions),
	];
	if (importantLimitations.length === 0)
		out.push(
			"- No source-coverage, open-decision, readiness-assumption, or renderer-integrity limitation was recorded.",
		);
	else
		importantLimitations
			.slice(0, 8)
			.forEach((row) =>
				out.push(
					`- ${completionText(typeof row === "string" ? row : stableStringify(row), 300)}`,
				),
			);
	return out
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function renderMarkdown({
	verdict,
	riskLevel,
	synthesis,
	contract,
	regression,
	ship,
	collections,
	completionSummaryMarkdown,
	limitations,
}) {
	const executive = completionSummaryMarkdown
		? completionSummaryMarkdown.replace(/^## /gm, "### ")
		: [
				"### Core conclusion",
				"",
				`Renderer status is not passed. The conservative verdict is **${verdict}** with **${riskLevel}** risk.`,
				"",
				`Narrative synthesis: ${safeInline(synthesis.summary ?? "unavailable")}`,
			].join("\n");
	const rendered = Object.fromEntries(
		collections.map(([key, heading, rows, emptyText]) => [
			key,
			renderRows(heading, rows, emptyText),
		]),
	);
	const lines = [
		"# Impact review report",
		"",
		"## Executive summary",
		"",
		executive,
		"",
		"## Impact conclusion",
		"",
		`- Effective verdict: **${verdict}**`,
		`- Effective risk level: **${riskLevel}**`,
		`- Synthesis verdict/risk: **${safeInline(synthesis.verdict ?? "unavailable")}** / **${safeInline(synthesis.riskLevel ?? "unavailable")}**`,
		`- Ship readiness: **${safeInline(ship.status ?? "unavailable")}**`,
		`- Contract consistency: **${safeInline(contract.status ?? "unavailable")}**`,
		"",
		"## Findings and actions",
		"",
		...rendered.blockingIssues.lines,
		...rendered.nonBlockingIssues.lines,
		...rendered.recommendedNextActions.lines,
		...rendered.validationToRun.lines,
		...rendered.needsHuman.lines,
		...rendered.confirmedSafeAreas.lines,
		"## Contract consistency",
		"",
		...rendered.contractIssues.lines,
		...rendered.confirmedConsistencies.lines,
		"## Regression risk",
		"",
		`Canonical risk level: **${safeInline(regression.riskLevel ?? "unavailable")}**`,
		"",
		...rendered.regressionRisks.lines,
		...rendered.riskReducers.lines,
		"## Ship readiness",
		"",
		...rendered.requiredBeforeShip.lines,
		...rendered.niceToHave.lines,
		...rendered.readinessAssumptions.lines,
		"## Evidence and limitations",
		"",
		"- The three joined controls are authoritative for contract state, regression risk, and ship readiness; synthesis cannot lower their verdict or risk floor.",
		...(limitations.length > 0
			? limitations.map((row) => `- ${safeInline(row)}`)
			: [
					"- No source-coverage, contradiction, risk-floor, or rendering limitation was recorded.",
				]),
		"",
		"## Related artifacts",
		"",
		"- [Machine-readable renderer control](control.json)",
		"- [Structured source references](refs.json)",
		"- [Canonical impact source ledger](source-ledger.json)",
	];
	return {
		markdown: lines
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim(),
		renderedCounts: Object.fromEntries(
			Object.entries(rendered).map(([key, value]) => [key, value.rendered]),
		),
	};
}

function blockedImpactResult(reason) {
	return {
		schema: "impact-review-render-v1",
		digest: `Impact rendering blocked: ${reason}`,
		status: "blocked",
		completionSummaryMarkdown: "",
		markdown: "",
		verdict: "UNKNOWN",
		riskLevel: "unknown",
		issueSummary: {
			blockingIssues: 0,
			nonBlockingIssues: 0,
			recommendedNextActions: 0,
			validationToRun: 0,
			needsHuman: 0,
			confirmedSafeAreas: 0,
			contractIssues: 0,
			confirmedConsistencies: 0,
			regressionRisks: 0,
			riskReducers: 0,
			requiredBeforeShip: 0,
			niceToHave: 0,
			readinessAssumptions: 0,
		},
		sourceArtifacts: [],
		blockers: [reason],
		impactLedger: [],
		ledgerCoverage: {
			mode: "ledger",
			status: "invalid",
			missingIds: [],
			duplicateIds: [],
			fabricatedSourceIds: [],
			stageFailures: [reason],
		},
		sourceCoverage: impactSourceCoverage({ sourceStatuses: [] }),
		gates: {
			allLedgerSourcesAvailable: false,
			sourceCoverageComplete: false,
			verdictConsistent: false,
			riskFloorConsistent: false,
			synthesisRiskUnknown: true,
			regressionRiskUnknown: true,
			riskGatePassed: false,
			renderedAllStructuredItems: false,
			ledgerComplete: false,
			sidecarPublished: false,
			byteAssuranceLimited: true,
			passed: false,
		},
	};
}

export default async function renderImpactReport({ sources, context = {} }) {
	let synthesis;
	let contract;
	let regression;
	let ship;
	try {
		synthesis = findSource(sources, "impact-synthesis") ?? {};
		contract = findSource(sources, "contract-consistency") ?? {};
		regression = findSource(sources, "regression-risk") ?? {};
		ship = findSource(sources, "ship-readiness") ?? {};
	} catch (error) {
		return blockedImpactResult(
			error instanceof Error ? error.message : String(error),
		);
	}
	const validity = {
		"impact-synthesis": synthesisValid(synthesis),
		"contract-consistency": contractValid(contract),
		"regression-risk": regressionValid(regression),
		"ship-readiness": shipValid(ship),
	};
	let ledgerCoverage;
	try {
		ledgerCoverage = reconcileImpactLedger(sources, context);
	} catch (error) {
		return blockedImpactResult(
			error instanceof Error ? error.message : String(error),
		);
	}
	const ledgerMode = ledgerCoverage.mode === "ledger";
	const sourceCoverage = impactSourceCoverage(context, ledgerMode);
	const coverageComplete = sourceCoverage.bijection;
	const canonicalSourcesAvailable = Object.values(validity).every(Boolean);
	const ledgerStatusComplete =
		!ledgerMode ||
		(ledgerCoverage.complete &&
			ledgerCoverage.status === "complete" &&
			ledgerCoverage.unverifiedResolutions.length === 0);
	const allLedgerSourcesAvailable =
		canonicalSourcesAvailable && ledgerStatusComplete;
	const safeSynthesis = isRecord(synthesis) ? synthesis : {};
	const safeContract = isRecord(contract) ? contract : {};
	const safeRegression = isRecord(regression) ? regression : {};
	const safeShip = isRecord(ship) ? ship : {};
	const unverifiedResolutionNeedsHuman = ledgerCoverage.unverifiedResolutions.map(
		(id) => ({
			id: `UNVERIFIED-RESOLUTION-${id}`,
			text: `Resolution claim for ${id} is model-assessed only; verify owner authority and evidence before relying on it.`,
			kind: "gap",
			severity: "unknown",
			scope: "known",
			resolution: "unresolved",
			resolutionNote: "No externally bound approval or evidence was supplied.",
			origin: "impact-renderer",
			sourceIds: [id],
		}),
	);
	const effectiveSynthesis =
		unverifiedResolutionNeedsHuman.length === 0
			? safeSynthesis
			: {
					...safeSynthesis,
					needsHuman: [
						...asArray(safeSynthesis.needsHuman),
						...unverifiedResolutionNeedsHuman,
					],
				};
	const sourceVerdict = canonicalSourcesAvailable && coverageComplete
		? requiredVerdict({ synthesis: effectiveSynthesis, contract: safeContract, regression: safeRegression, ship: safeShip })
		: "UNKNOWN";
	const proposedVerdict = allLedgerSourcesAvailable || sourceVerdict === "BLOCKED"
		? sourceVerdict
		: "UNKNOWN";
	const synthesisRisk = cleanText(safeSynthesis.riskLevel);
	const regressionRisk = cleanText(safeRegression.riskLevel);
	// Lens-level risk assessments are also original source judgments, even
	// when their individual observations omit an optional severity field.
	const sourceRiskRows = ["api-contract-impact", "state-data-impact", "docs-release-impact", "security-performance-impact"]
		.map((stageId) => ({ stageId, severity: cleanText(findSource(sources, stageId)?.status) }))
		.filter((row) => RISK_LEVELS.has(row.severity))
		.map((row) => ({ ...row, resolution: "unresolved", text: `${row.stageId} aggregate risk` }));
	const riskUncertainty = ledgerMode
		? summarizeCanonicalRisk([...ledgerCoverage.impactLedger, ...sourceRiskRows], ledgerCoverage.unverifiedResolutions)
		: { present: false, knownFloor: "none", observationIds: [] };
	const canonicalRisk = riskUncertainty.knownFloor;
	const riskLevel = riskUncertainty.present && proposedVerdict === "READY"
		? "unknown"
		: effectiveRiskLevel(synthesisRisk, regressionRisk, canonicalRisk);
	const synthesisRiskUnknown =
		!RISK_LEVELS.has(synthesisRisk) || synthesisRisk === "unknown";
	const regressionRiskUnknown =
		!RISK_LEVELS.has(regressionRisk) || regressionRisk === "unknown";
	// Unquantified observations cannot establish READY. They also cannot erase
	// a coherent known BLOCKED/NEEDS_WORK assessment with a stated risk floor.
	const uncertaintyBlocksConclusion = riskUncertainty.present && !["BLOCKED", "NEEDS_WORK"].includes(proposedVerdict);
	const riskGatePassed = !synthesisRiskUnknown && !regressionRiskUnknown && !uncertaintyBlocksConclusion;
	const riskConsistent =
		allLedgerSourcesAvailable &&
		riskFloorConsistent(synthesisRisk, regressionRisk, canonicalRisk);
	// A known blocker remains authoritative even when another risk dimension is
	// unknown; an understated risk cannot support a READY label.
	const verdict =
		proposedVerdict === "BLOCKED"
			? "BLOCKED"
			: riskGatePassed && (proposedVerdict !== "READY" || riskConsistent)
				? proposedVerdict
				: "UNKNOWN";
	const verdictConsistent =
		allLedgerSourcesAvailable &&
		coverageComplete &&
		cleanText(safeSynthesis.verdict) === verdict;
	const collections = rowCollections({
		synthesis: effectiveSynthesis,
		contract: safeContract,
		regression: safeRegression,
		ship: safeShip,
	});
	const summary = issueSummary(collections);
	const limitations = [];
	if (!canonicalSourcesAvailable) {
		const unavailable = STAGES.filter((stageId) => !validity[stageId]);
		limitations.push(
			`Missing or malformed canonical source control(s): ${unavailable.join(", ") || "unknown"}.`,
		);
	}
	if (!ledgerStatusComplete && canonicalSourcesAvailable)
		limitations.push("Canonical source controls or runtime source provenance are incomplete.");
	if (ledgerMode && !ledgerCoverage.complete) {
		limitations.push(
			`Impact ledger reconciliation failed: missing=${ledgerCoverage.missingIds.length}, duplicate=${ledgerCoverage.duplicateIds.length}, fabricated=${ledgerCoverage.fabricatedSourceIds.length}.`,
		);
	}
	if (ledgerMode && ledgerCoverage.status !== "complete")
		limitations.push(
			`Impact ledger status is ${ledgerCoverage.status}; only complete ledger status can pass.`,
		);
	if (ledgerMode && ledgerCoverage.unverifiedResolutions.length > 0)
		limitations.push(
			`Resolution claims are model-assessed and lack externally bound approval/evidence authority: ${ledgerCoverage.unverifiedResolutions.join(", ")}.`,
		);
	if (ledgerMode && canonicalRisk !== "none")
		limitations.push(`Known canonical impact risk floor is ${canonicalRisk}.`);
	if (riskUncertainty.present)
		limitations.push(`${riskUncertainty.observationIds.length} original risk observations remain unquantified; they are retained separately from the known risk floor and cannot establish READY.`);
	limitations.push(
		"Impact review does not attest historical source-file bytes; content hashes cover host-supplied control values only, and citations are unverified unless an authoritative byte snapshot is supplied.",
	);
	if (!coverageComplete)
		limitations.push(
			"Canonical source lifecycle metadata is missing, duplicated, non-terminal, or incomplete.",
		);
	if (allLedgerSourcesAvailable && !verdictConsistent)
		limitations.push(
			`Synthesis verdict ${cleanText(safeSynthesis.verdict) || "unavailable"} contradicts required verdict ${verdict}.`,
		);
	if (allLedgerSourcesAvailable && !riskConsistent)
		limitations.push(
			`Synthesis risk ${synthesisRisk || "unavailable"} understates or obscures the known source risk floor ${canonicalRisk} (regression risk ${regressionRisk || "unavailable"}).`,
		);
	if (!riskGatePassed)
		limitations.push("Unknown impact risk prevents a successful readiness gate.");
	const provisional = renderMarkdown({
		verdict,
		riskLevel,
		synthesis: effectiveSynthesis,
		contract: safeContract,
		regression: safeRegression,
		ship: safeShip,
		collections,
		completionSummaryMarkdown: "",
		limitations,
	});
	const renderedAllStructuredItems = Object.keys(summary).every(
		(key) => summary[key] === provisional.renderedCounts[key],
	);
	if (!renderedAllStructuredItems)
		limitations.push(
			"At least one structured issue, action, validation, needs-human, or readiness row was not rendered.",
		);
	const passed =
		allLedgerSourcesAvailable &&
		coverageComplete &&
		verdictConsistent &&
		riskConsistent &&
		riskGatePassed &&
		renderedAllStructuredItems;
	let status =
		!allLedgerSourcesAvailable || !coverageComplete
			? "blocked"
			: passed
				? "passed"
				: "failed";
	let completionSummaryMarkdown = passed
		? renderCompletionSummary({
				verdict,
				riskLevel,
				synthesis: effectiveSynthesis,
				ship: safeShip,
				summary,
				limitations,
			})
		: "";
	let rendered = renderMarkdown({
		verdict,
		riskLevel,
		synthesis: effectiveSynthesis,
		contract: safeContract,
		regression: safeRegression,
		ship: safeShip,
		collections,
		completionSummaryMarkdown,
		limitations,
	});
	const gates = {
		allLedgerSourcesAvailable,
		sourceCoverageComplete: coverageComplete,
		verdictConsistent,
		riskFloorConsistent: riskConsistent,
		synthesisRiskUnknown,
		regressionRiskUnknown,
		riskGatePassed,
		renderedAllStructuredItems,
		ledgerComplete: !ledgerMode || ledgerStatusComplete,
		sidecarPublished: true,
		byteAssuranceLimited: true,
		passed,
	};
	let sidecarPath;
	let ledgerSidecarPath;
	let sidecarError;
	const sidecarRequired = Boolean(
		context.cwd && context.runId && context.taskId,
	);
	try {
		if (sidecarRequired) {
			const taskDir = join(
				context.cwd,
				".pi",
				"workflows",
				context.runId,
				"tasks",
				context.taskId,
			);
			await mkdir(taskDir, { recursive: true });
			await writeFile(
				join(taskDir, "final-report.md"),
				`${rendered.markdown}\n`,
				"utf8",
			);
			await writeFile(
				join(taskDir, "source-ledger.json"),
					`${stableStringify({
						schema: "impact-review-source-ledger-v1",
						sourceControls: Object.fromEntries(
							LEDGER_STAGES.map((stageId) => [
								stageId,
								findSource(sources, stageId),
							]),
						),
						impactSynthesis: safeSynthesis,
						contractConsistency: safeContract,
						regressionRisk: safeRegression,
						shipReadiness: safeShip,
						impactLedger: ledgerCoverage.impactLedger,
						ledgerCoverage,
						})}\n`,
				"utf8",
			);
			sidecarPath = "final-report.md";
			ledgerSidecarPath = "source-ledger.json";
		}
	} catch {
		sidecarError =
			"Sidecar publication failed; final report and source ledger were not written.";
		limitations.push(sidecarError);
	}
	if (sidecarRequired && !sidecarPath) {
		status = "failed";
		completionSummaryMarkdown = "";
		rendered = renderMarkdown({
			verdict,
			riskLevel,
			synthesis: effectiveSynthesis,
			contract: safeContract,
			regression: safeRegression,
			ship: safeShip,
			collections,
			completionSummaryMarkdown,
			limitations,
		});
	}
	gates.sidecarPublished = !sidecarRequired || Boolean(sidecarPath);
	gates.passed = gates.passed && gates.sidecarPublished;
	const controlForDigestFinal = {
		status,
		verdict,
		riskLevel,
		riskUncertainty,
		issueSummary: summary,
		gates,
		ledgerCoverage,
		markdown: rendered.markdown,
	};
	return {
		schema: "impact-review-render-v1",
		digest: `sha256:${createHash("sha256").update(stableStringify(controlForDigestFinal)).digest("hex")}`,
		status,
		...(limitations.length > 0 ? { blockers: limitations.slice(0, 32) } : {}),
		completionSummaryMarkdown,
		markdown: rendered.markdown,
		verdict,
		riskLevel,
		riskUncertainty,
		issueSummary: summary,
		sourceCoverage,
		sourceArtifacts: STAGES.filter((stageId) => validity[stageId]).map(
			(stageId) => `${stageId}.control.json`,
		),
		impactLedger: ledgerCoverage.impactLedger,
		ledgerCoverage: {
			mode: ledgerCoverage.mode,
			status: ledgerCoverage.status,
			missingIds: ledgerCoverage.missingIds,
			duplicateIds: ledgerCoverage.duplicateIds,
			fabricatedSourceIds: ledgerCoverage.fabricatedSourceIds,
			stageFailures: ledgerCoverage.stageFailures,
		},
		gates,
		...(sidecarError ? { sidecarError } : {}),
		...(sidecarPath ? { sidecarPath } : {}),
		...(ledgerSidecarPath ? { ledgerSidecarPath } : {}),
	};
}
