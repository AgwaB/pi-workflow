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
		.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
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

function stageMatches(value, stageId) {
	const text = cleanText(value);
	return (
		text === stageId ||
		text.startsWith(`${stageId}.`) ||
		text.endsWith(`.${stageId}`) ||
		text.includes(`.${stageId}.`)
	);
}

function findSource(sources, stageId) {
	const matches = Object.entries(sources ?? {})
		.filter(([alias]) => stageMatches(alias, stageId))
		.sort(([a], [b]) => a.localeCompare(b));
	if (matches.length > 1) {
		throw new Error(
			`impact-review renderer: ambiguous ${stageId} source (${matches.map(([alias]) => alias).join(", ")})`,
		);
	}
	return matches[0]?.[1] ?? null;
}

function canonicalImpactStage(value) {
	let text = cleanText(value);
	if (text.startsWith("impact-analysis.")) text = text.slice("impact-analysis.".length);
	if (text.endsWith(".main")) text = text.slice(0, -".main".length);
	return text;
}

function sourceStatusMatches(status, stageId) {
	const source = canonicalImpactStage(status?.source);
	const spec = canonicalImpactStage(status?.specId);
	const stage = canonicalImpactStage(status?.stageId);
	return source === stageId && spec === stageId && stage === stageId;
}

function impactSourceCoverage(context) {
	const statuses = Array.isArray(context?.sourceStatuses) ? context.sourceStatuses : [];
	const expected = STAGES.map((stageId) => ({ stageId }));
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
		// Source and spec are mutually agreeing lifecycle identities. The stage
		// field is checked separately so a copied alias cannot hide a wrong task.
		const matches = statuses
			.map((status, index) => ({ status, index }))
			.filter(({ status }) =>
				isRecord(status) &&
				canonicalImpactStage(status.source) === target.stageId &&
				canonicalImpactStage(status.specId) === target.stageId,
			);
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
			sourceId: cleanText(status.source),
			stageId: target.stageId,
			statusSpecId: cleanText(status.specId),
			statusSource: cleanText(status.source),
			taskId: cleanText(status.taskId),
		});
		if (canonicalImpactStage(status.stageId) !== target.stageId ||
			cleanText(status.status) !== "completed" ||
			!cleanText(status.taskId)) {
			wrongStage.push({
				stageId: target.stageId,
				statusSource: cleanText(status.source),
				statusSpecId: cleanText(status.specId),
				claimedStageId: cleanText(status.stageId),
				status: cleanText(status.status),
			});
		}
	}
	statuses.forEach((status, index) => {
		if (!assignedIndexes.has(index)) {
			orphan.push({ index, source: cleanText(status?.source), specId: cleanText(status?.specId), stageId: cleanText(status?.stageId) });
		}
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
		bijection: Array.isArray(context?.sourceStatuses) &&
			missing.length === 0 && duplicate.length === 0 && wrongStage.length === 0 &&
			orphan.length === 0 && duplicateTaskIds.length === 0 &&
			assignments.length === expected.length && statuses.length === expected.length,
	};
}

function sourceCoverageComplete(context) {
	return impactSourceCoverage(context).bijection;
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
		regression.riskLevel === "medium" ||
		regression.riskLevel === "high" ||
		asArray(ship.requiredBeforeShip).length > 0 ||
		asArray(synthesis.nonBlockingIssues).length > 0
	)
		return "NEEDS_WORK";
	return "READY";
}

function riskFloorConsistent(synthesisRisk, regressionRisk) {
	if (!RISK_LEVELS.has(synthesisRisk) || !RISK_LEVELS.has(regressionRisk))
		return false;
	if (regressionRisk === "unknown") return synthesisRisk === "unknown";
	if (synthesisRisk === "unknown") return true;
	return RISKS.indexOf(synthesisRisk) >= RISKS.indexOf(regressionRisk);
}

function effectiveRiskLevel(synthesisRisk, regressionRisk) {
	if (synthesisRisk === "unknown" || regressionRisk === "unknown") return "unknown";
	const synthesisIndex = RISKS.indexOf(synthesisRisk);
	const regressionIndex = RISKS.indexOf(regressionRisk);
	if (synthesisIndex < 0 && regressionIndex < 0) return "unknown";
	return RISKS[Math.max(synthesisIndex, regressionIndex)] ?? "unknown";
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
		["blockingIssues", "Blocking issues", synthesis.blockingIssues, "No blocking issue was recorded."],
		["nonBlockingIssues", "Non-blocking issues", synthesis.nonBlockingIssues, "No non-blocking issue was recorded."],
		["recommendedNextActions", "Recommended next actions", synthesis.recommendedNextActions, "No recommended action was recorded."],
		["validationToRun", "Validation to run", synthesis.validationToRun, "No validation command was recorded."],
		["needsHuman", "Needs human review", synthesis.needsHuman, "No needs-human row was recorded."],
		["confirmedSafeAreas", "Confirmed safe areas", synthesis.confirmedSafeAreas, "No confirmed-safe row was recorded."],
		["contractIssues", "Contract issues", contract.issues, "No contract inconsistency was recorded."],
		["confirmedConsistencies", "Confirmed consistencies", contract.confirmedConsistencies, "No confirmed consistency was recorded."],
		["regressionRisks", "Regression risks", regression.risks, "No regression-risk row was recorded."],
		["riskReducers", "Risk reducers", regression.riskReducers, "No risk-reducer row was recorded."],
		["requiredBeforeShip", "Required before ship", ship.requiredBeforeShip, "No required-before-ship row was recorded."],
		["niceToHave", "Nice to have", ship.niceToHave, "No nice-to-have row was recorded."],
		["readinessAssumptions", "Readiness assumptions", ship.assumptions, "No readiness assumption was recorded."],
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

function actionSummaryRows(synthesis) {
	return [
		...asArray(synthesis.blockingIssues),
		...asArray(synthesis.nonBlockingIssues),
		...asArray(synthesis.recommendedNextActions),
		...asArray(synthesis.validationToRun),
		...asArray(synthesis.needsHuman),
	].slice(0, 5);
}

function renderCompletionSummary({ verdict, riskLevel, synthesis, ship, summary, limitations }) {
	const actions = actionSummaryRows(synthesis);
	const out = [
		"## Core conclusion",
		"",
		`Verdict: **${verdict}**; risk: **${riskLevel}**. ${completionText(synthesis.summary, 850)}`,
		"",
		"## Key actions",
		"",
	];
	if (actions.length === 0) out.push("- No blocking issue, follow-up action, or validation command was recorded.");
	else actions.forEach((row) => out.push(`- ${completionText(typeof row === "string" ? row : stableStringify(row), 420)}`));
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
	if (importantLimitations.length === 0) out.push("- No source-coverage, open-decision, readiness-assumption, or renderer-integrity limitation was recorded.");
	else importantLimitations.slice(0, 8).forEach((row) => out.push(`- ${completionText(typeof row === "string" ? row : stableStringify(row), 300)}`));
	return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function renderMarkdown({ verdict, riskLevel, synthesis, contract, regression, ship, collections, completionSummaryMarkdown, limitations }) {
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
			: ["- No source-coverage, contradiction, risk-floor, or rendering limitation was recorded."]),
		"",
		"## Related artifacts",
		"",
		"- [Machine-readable renderer control](control.json)",
		"- [Structured source references](refs.json)",
		"- [Canonical impact source ledger](source-ledger.json)",
	];
	return {
		markdown: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
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
		return blockedImpactResult(error instanceof Error ? error.message : String(error));
	}
	const validity = {
		"impact-synthesis": synthesisValid(synthesis),
		"contract-consistency": contractValid(contract),
		"regression-risk": regressionValid(regression),
		"ship-readiness": shipValid(ship),
	};
	const allLedgerSourcesAvailable = Object.values(validity).every(Boolean);
	const sourceCoverage = impactSourceCoverage(context);
	const coverageComplete = sourceCoverage.bijection;
	const safeSynthesis = isRecord(synthesis) ? synthesis : {};
	const safeContract = isRecord(contract) ? contract : {};
	const safeRegression = isRecord(regression) ? regression : {};
	const safeShip = isRecord(ship) ? ship : {};
	const proposedVerdict = allLedgerSourcesAvailable && coverageComplete
		? requiredVerdict({ synthesis: safeSynthesis, contract: safeContract, regression: safeRegression, ship: safeShip })
		: "UNKNOWN";
	const synthesisRisk = cleanText(safeSynthesis.riskLevel);
	const regressionRisk = cleanText(safeRegression.riskLevel);
	const riskLevel = effectiveRiskLevel(synthesisRisk, regressionRisk);
	const synthesisRiskUnknown = !RISK_LEVELS.has(synthesisRisk) || synthesisRisk === "unknown";
	const regressionRiskUnknown = !RISK_LEVELS.has(regressionRisk) || regressionRisk === "unknown";
	// Unknown risk is an explicit uncertainty state, never a successful
	// readiness gate, even when all joined controls agree on UNKNOWN.
	const riskGatePassed = !synthesisRiskUnknown && !regressionRiskUnknown;
	const verdict = riskGatePassed ? proposedVerdict : "UNKNOWN";
	const verdictConsistent =
		allLedgerSourcesAvailable &&
		coverageComplete &&
		cleanText(safeSynthesis.verdict) === verdict;
	const riskConsistent =
		allLedgerSourcesAvailable && riskFloorConsistent(synthesisRisk, regressionRisk);
	const collections = rowCollections({
		synthesis: safeSynthesis,
		contract: safeContract,
		regression: safeRegression,
		ship: safeShip,
	});
	const summary = issueSummary(collections);
	const limitations = [];
	if (!allLedgerSourcesAvailable) {
		const unavailable = STAGES.filter((stageId) => !validity[stageId]);
		limitations.push(`Missing or malformed canonical source control(s): ${unavailable.join(", ")}.`);
	}
	if (!coverageComplete)
		limitations.push("Canonical source lifecycle metadata is missing, duplicated, non-terminal, or incomplete.");
	if (allLedgerSourcesAvailable && !verdictConsistent)
		limitations.push(`Synthesis verdict ${cleanText(safeSynthesis.verdict) || "unavailable"} contradicts required verdict ${verdict}.`);
	if (allLedgerSourcesAvailable && !riskConsistent)
		limitations.push(`Synthesis risk ${synthesisRisk || "unavailable"} understates or obscures canonical regression risk ${regressionRisk || "unavailable"}.`);
	if (!riskGatePassed)
		limitations.push("Unknown impact risk prevents a successful readiness gate.");
	const provisional = renderMarkdown({
		verdict,
		riskLevel,
		synthesis: safeSynthesis,
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
		limitations.push("At least one structured issue, action, validation, needs-human, or readiness row was not rendered.");
	const passed =
		allLedgerSourcesAvailable &&
		coverageComplete &&
		verdictConsistent &&
		riskConsistent &&
		riskGatePassed &&
		renderedAllStructuredItems;
	const status = !allLedgerSourcesAvailable || !coverageComplete
		? "blocked"
		: passed
			? "passed"
			: "failed";
	const completionSummaryMarkdown = passed
		? renderCompletionSummary({ verdict, riskLevel, synthesis: safeSynthesis, ship: safeShip, summary, limitations })
		: "";
	const rendered = renderMarkdown({
		verdict,
		riskLevel,
		synthesis: safeSynthesis,
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
		passed,
	};
	const controlForDigest = {
		status,
		verdict,
		riskLevel,
		issueSummary: summary,
		gates,
		markdown: rendered.markdown,
	};
	let sidecarPath;
	let ledgerSidecarPath;
	try {
		if (context.cwd && context.runId && context.taskId) {
			const taskDir = join(context.cwd, ".pi", "workflows", context.runId, "tasks", context.taskId);
			await mkdir(taskDir, { recursive: true });
			await writeFile(join(taskDir, "final-report.md"), `${rendered.markdown}\n`, "utf8");
			await writeFile(
				join(taskDir, "source-ledger.json"),
				`${stableStringify({
					schema: "impact-review-source-ledger-v1",
					impactSynthesis: safeSynthesis,
					contractConsistency: safeContract,
					regressionRisk: safeRegression,
					shipReadiness: safeShip,
				})}\n`,
				"utf8",
			);
			sidecarPath = "final-report.md";
			ledgerSidecarPath = "source-ledger.json";
		}
	} catch {
		// Sidecars are non-authoritative; the control remains deterministic.
	}
	return {
		schema: "impact-review-render-v1",
		digest: `sha256:${createHash("sha256").update(stableStringify(controlForDigest)).digest("hex")}`,
		status,
		...(limitations.length > 0 ? { blockers: limitations.slice(0, 32) } : {}),
		completionSummaryMarkdown,
		markdown: rendered.markdown,
		verdict,
		riskLevel,
		issueSummary: summary,
		sourceCoverage,
		sourceArtifacts: STAGES.filter((stageId) => validity[stageId]).map((stageId) => `${stageId}.control.json`),
		gates,
		...(sidecarPath ? { sidecarPath } : {}),
		...(ledgerSidecarPath ? { ledgerSidecarPath } : {}),
	};
}
