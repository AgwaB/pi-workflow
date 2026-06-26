// Deterministic evidence-backed renderer for deep-research.
//
// Input: final-audit.control.json from the full deep-research final stage.
// Output: a parent-facing research report in executiveMarkdown plus sidecars.
//
// This intentionally treats final-audit.control.json as the source of truth and
// renders a bounded view. It does not re-verify or invent evidence.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

function findSource(sources, stageId) {
	for (const [specId, source] of Object.entries(sources ?? {})) {
		if (specId === stageId || specId.startsWith(`${stageId}.`)) return source;
	}
	return null;
}

function asArray(value) {
	return Array.isArray(value) ? value : [];
}

function words(text) {
	return (
		String(text ?? "")
			.trim()
			.match(/\S+/g) ?? []
	);
}

function countWords(text) {
	return words(text).length;
}

function cleanText(value) {
	return String(value ?? "")
		.replace(/\s+/g, " ")
		.replace(/\s+([,.;:!?])/g, "$1")
		.trim();
}

function escapeTableCell(value) {
	return cleanText(value).replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

function stringifyItem(item) {
	if (typeof item === "string") return cleanText(item) || "(empty string)";
	try {
		const json = JSON.stringify(item);
		if (json) return cleanText(json);
	} catch {
		// Fall through to String below.
	}
	return cleanText(String(item)) || "(empty item)";
}

function truncateWords(text, maxWords) {
	const items = words(text);
	if (items.length <= maxWords) return cleanText(text);
	return `${items
		.slice(0, maxWords)
		.join(" ")
		.replace(/[,:;]$/, "")}…`;
}

function hostOf(url) {
	try {
		return new URL(url).host.replace(/^www\./, "");
	} catch {
		return "source";
	}
}

function normalizeUrl(url) {
	if (typeof url !== "string") return null;
	const trimmed = url.trim().replace(/[.,;:]+$/, "");
	if (!/^https?:\/\//i.test(trimmed)) return null;
	try {
		const parsed = new URL(trimmed);
		parsed.hash = "";
		return parsed.toString();
	} catch {
		return trimmed;
	}
}

function collectStructuredUrls(value, urls = []) {
	if (!value || typeof value !== "object") return urls;
	if (Array.isArray(value)) {
		for (const item of value) collectStructuredUrls(item, urls);
		return urls;
	}
	for (const [key, item] of Object.entries(value)) {
		if (
			/^(sourceUrls?|evidenceUrls?|urls?|url|uri|href|links?|references?|refs?|basis|sources)$/i.test(
				key,
			)
		) {
			for (const candidate of asArray(item).length ? item : [item]) {
				const normalized = normalizeUrl(candidate);
				if (normalized) urls.push(normalized);
				else if (candidate && typeof candidate === "object") {
					collectStructuredUrls(candidate, urls);
				}
			}
			continue;
		}
		if (item && typeof item === "object") collectStructuredUrls(item, urls);
	}
	return urls;
}

function uniqueStructuredUrls(...values) {
	const out = [];
	const seen = new Set();
	for (const value of values) {
		for (const url of collectStructuredUrls(value, [])) {
			if (seen.has(url)) continue;
			seen.add(url);
			out.push(url);
		}
	}
	return out;
}

function urlsOf(item, limit = 3) {
	return uniqueStructuredUrls(item).slice(0, limit);
}

function markdownLinkList(urls, maxItems = 3) {
	return urls
		.slice(0, maxItems)
		.map((url) => `[${hostOf(url)}](${url})`)
		.join(", ");
}

function itemText(item, fields, fallback = "") {
	if (typeof item === "string") return cleanText(item) || fallback;
	if (!item || typeof item !== "object") return fallback;
	for (const field of fields) {
		if (typeof item[field] === "string" && item[field].trim()) {
			return cleanText(item[field]);
		}
	}
	return fallback;
}

function evidenceStatusOf(item) {
	if (!item || typeof item !== "object") return "not specified";
	return cleanText(
		item.evidenceStatus ??
			item.status ??
			item.confidence ??
			item.sourceQuality ??
			"not specified",
	);
}

function confidenceOf(item) {
	if (!item || typeof item !== "object") return "";
	return cleanText(item.confidence ?? item.evidenceStatus ?? "");
}

function finiteNumber(value) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function coverageCounts(coverage, fallback) {
	if (!coverage || typeof coverage !== "object") return null;
	return {
		total: finiteNumber(coverage.verificationCandidates) ?? fallback.total,
		verified: finiteNumber(coverage.verified) ?? fallback.verified,
		partially_supported:
			finiteNumber(coverage.partiallySupported) ?? fallback.partially_supported,
		unsupported: finiteNumber(coverage.unsupported) ?? fallback.unsupported,
		conflicting: finiteNumber(coverage.conflicting) ?? fallback.conflicting,
	};
}

function claimCounts(control) {
	const claims = asArray(control?.claimVerdictIndex?.claims);
	const counts = {
		total: claims.length,
		verified: 0,
		partially_supported: 0,
		unsupported: 0,
		conflicting: 0,
	};
	for (const claim of claims) {
		const status = claim?.status;
		if (status && Object.hasOwn(counts, status)) counts[status] += 1;
	}
	const coverage = coverageCounts(
		control?.finalReport?.coverageSummary,
		counts,
	);
	if (claims.length === 0 && coverage) return coverage;
	if (!coverage) return counts;

	const mismatches = [];
	for (const key of [
		"total",
		"verified",
		"partially_supported",
		"unsupported",
		"conflicting",
	]) {
		if (coverage[key] !== counts[key]) {
			mismatches.push({
				field: key,
				claimVerdictIndex: counts[key],
				coverageSummary: coverage[key],
			});
		}
	}
	return mismatches.length > 0
		? { ...counts, coverageSummaryMismatch: mismatches }
		: counts;
}

function factSlotSummary(factSlots) {
	return {
		total: factSlots.length,
		filled: factSlots.filter((slot) => slot?.status === "filled").length,
		partial: factSlots.filter((slot) => slot?.status === "partial").length,
		missingOrConflicting: factSlots.filter((slot) =>
			["missing", "gap", "conflicting"].includes(slot?.status),
		).length,
	};
}

function statusRank(item) {
	const status =
		`${item?.evidenceStatus ?? item?.status ?? item?.confidence ?? ""}`.toLowerCase();
	if (
		status.includes("missing") ||
		status.includes("gap") ||
		status.includes("conflict")
	) {
		return 0;
	}
	if (status.includes("unsupported")) return 1;
	if (status.includes("partial")) return 2;
	if (status.includes("verified") && !status.includes("partial")) return 3;
	if (status.includes("filled") || status.includes("high")) return 4;
	return 5;
}

function sortedFactSlots(report) {
	return asArray(report.factSlotCoverage)
		.slice()
		.sort(
			(a, b) =>
				statusRank(a) - statusRank(b) ||
				cleanText(a?.slotId ?? a?.label).localeCompare(
					cleanText(b?.slotId ?? b?.label),
				),
		);
}

function renderEvidenceStrength(report) {
	const slots = sortedFactSlots(report);
	const rows = slots.map((slot) => {
		const area = escapeTableCell(
			slot.label ?? slot.slotId ?? slot.bestValue ?? "Evidence area",
		);
		const status = escapeTableCell(evidenceStatusOf(slot));
		const evidence = escapeTableCell(
			markdownLinkList(urlsOf(slot, 2), 2) || "—",
		);
		const impact = escapeTableCell(
			slot.parentImpact ?? slot.whyItMatters ?? slot.notes ?? "",
		);
		return `| ${area || "Evidence area"} | ${status || "—"} | ${evidence} | ${impact || "—"} |`;
	});
	if (rows.length === 0) return [];
	return [
		"## Evidence strength",
		"",
		"| Area | Status | Evidence | Why it matters |",
		"|---|---|---|---|",
		...rows,
		"",
	];
}

function mainFindingEntries(report) {
	return asArray(report.mainFindings).map((item) => ({
		item,
		text: itemText(
			item,
			["finding", "summary", "bestValue", "claim"],
			stringifyItem(item),
		),
	}));
}

function recommendationEntries(report) {
	return asArray(report.recommendations).map((item) => ({
		item,
		text: itemText(
			item,
			["recommendation", "action", "step", "note"],
			stringifyItem(item),
		),
	}));
}

function actionEntries(report) {
	return asArray(report.actionPlan).map((item) => ({
		item,
		text:
			itemText(item, ["action", "recommendation", "note"]) ||
			(typeof item?.step === "string" && cleanText(item.step)) ||
			stringifyItem(item),
	}));
}

function renderMainFindings(report) {
	const findings = mainFindingEntries(report);
	if (findings.length === 0) return [];
	const out = ["## Main findings", ""];
	findings.forEach(({ item: finding, text }, index) => {
		const status = evidenceStatusOf(finding);
		const confidence = confidenceOf(finding);
		const urls = markdownLinkList(urlsOf(finding, 4), 4);
		out.push(`### ${index + 1}. ${text}`);
		out.push("");
		out.push(
			`Evidence status: **${status || "not specified"}**${confidence && confidence !== status ? `  \nConfidence: **${confidence}**` : ""}`,
		);
		if (urls) out.push(`Sources: ${urls}`);
		const explanation = itemText(finding, [
			"rationale",
			"explanation",
			"details",
			"notes",
		]);
		if (explanation && explanation !== text) out.push("", explanation);
		out.push("");
	});
	return out;
}

function renderRecommendations(report) {
	const recommendations = recommendationEntries(report);
	if (recommendations.length === 0) return [];
	const out = ["## Recommendations", ""];
	recommendations.forEach(({ item, text }, index) => {
		const status = evidenceStatusOf(item);
		const urls = markdownLinkList(urlsOf(item, 4), 4);
		out.push(`${index + 1}. **${text}**`);
		out.push(`   - Evidence status: ${status || "not specified"}`);
		if (urls) out.push(`   - Sources: ${urls}`);
		out.push("");
	});
	return out;
}

function renderActionPlan(report) {
	const actions = actionEntries(report);
	if (actions.length === 0) return [];
	const out = ["## Action plan", ""];
	actions.forEach(({ item, text }, index) => {
		const numericStep = Number(item?.step);
		const step = Number.isFinite(numericStep) ? numericStep : index + 1;
		const urls = markdownLinkList(urlsOf(item, 3), 3);
		const evidence = evidenceStatusOf(item);
		out.push(`${step}. ${text}`);
		if (evidence && evidence !== "not specified")
			out.push(`   - Evidence: ${evidence}`);
		if (urls) out.push(`   - Sources: ${urls}`);
		out.push("");
	});
	return out;
}

function caveatText(item) {
	return itemText(
		item,
		["gap", "finding", "claim", "note", "whyItMatters", "parentImpact"],
		stringifyItem(item),
	);
}

function caveatCategories(report) {
	return [
		{ kind: "Gap", items: asArray(report.remainingGaps) },
		{ kind: "Unsupported", items: asArray(report.notableUnsupportedClaims) },
		{ kind: "Contested", items: asArray(report.contestedAreas) },
		{ kind: "Caveat", items: asArray(report.caveatedFindings) },
		{ kind: "Unverified lead", items: asArray(report.unverifiedButRelevant) },
		{ kind: "Decision note", items: asArray(report.parentDecisionNotes) },
	]
		.map((category) => ({
			kind: category.kind,
			entries: category.items
				.map((item) => ({ item, text: caveatText(item) }))
				.filter((entry) => entry.text),
		}))
		.filter((category) => category.entries.length > 0);
}

function selectCaveats(report) {
	const categories = caveatCategories(report);
	const selected = [];
	for (const category of categories) {
		for (const entry of category.entries) {
			selected.push({ kind: category.kind, ...entry });
		}
	}
	return {
		selected,
		total: selected.length,
	};
}

function renderCaveats(report) {
	const selection = selectCaveats(report);
	if (selection.total === 0) return [];
	const out = ["## Caveats and remaining gaps", ""];
	for (const { kind, item, text } of selection.selected) {
		const urls = markdownLinkList(urlsOf(item, 3), 3);
		out.push(`- **${kind}:** ${text}${urls ? ` (${urls})` : ""}`);
	}
	out.push("");
	return out;
}

function renderSourceIndex(sourceIndex) {
	if (sourceIndex.length === 0) return [];
	const grouped = new Map();
	for (const url of sourceIndex) {
		const host = hostOf(url);
		if (!grouped.has(host)) grouped.set(host, []);
		grouped.get(host).push(url);
	}
	const out = ["## Source index", ""];
	for (const [host, urls] of grouped) {
		out.push(
			`- **${host}**: ${urls.map((url) => `[${url}](${url})`).join(", ")}`,
		);
	}
	out.push("");
	return out;
}

function renderAuditSummary(control, claimSummary, slots) {
	const coverage = control?.finalReport?.coverageSummary ?? {};
	const mismatches = asArray(claimSummary.coverageSummaryMismatch);
	return [
		"## Audit summary",
		"",
		`- Claims: ${claimSummary.verified} verified, ${claimSummary.partially_supported} partially supported, ${claimSummary.unsupported} unsupported, ${claimSummary.conflicting} conflicting.`,
		`- Fact slots: ${slots.filled} filled, ${slots.partial} partial, ${slots.missingOrConflicting} missing/conflicting, ${slots.total} total.`,
		...(mismatches.length > 0
			? [
					`- Coverage summary mismatch: displayed claim counts come from \`claimVerdictIndex\`; model coverageSummary disagreed on ${mismatches
						.map((mismatch) => mismatch.field)
						.join(", ")}.`,
				]
			: []),
		...(coverage.researchQuestions != null
			? [`- Research questions: ${coverage.researchQuestions}.`]
			: []),
		"- Audit artifact: `final-audit.control.json`.",
		"",
	];
}

function renderWarnings(sectionCounts) {
	const checks = [
		["findings", "renderedFindings", "findings"],
		["recommendations", "renderedRecommendations", "recommendations"],
		["actionItems", "renderedActionItems", "action items"],
		["caveatsAndGaps", "renderedCaveatsAndGaps", "caveats/gaps"],
		["factSlots", "renderedFactSlots", "fact slots"],
		["sourceUrls", "renderedSourceUrls", "source URLs"],
	];
	return checks
		.filter(([totalKey, renderedKey]) => {
			const total = Number(sectionCounts[totalKey] ?? 0);
			const rendered = Number(sectionCounts[renderedKey] ?? 0);
			return total !== rendered;
		})
		.map(([totalKey, renderedKey, label]) => ({
			section: totalKey,
			label,
			total: sectionCounts[totalKey],
			rendered: sectionCounts[renderedKey],
		}));
}

function renderResearchMarkdown(control) {
	const report = control?.finalReport ?? {};
	const claimSummary = claimCounts(control);
	const factSlots = sortedFactSlots(report);
	const slots = factSlotSummary(asArray(report.factSlotCoverage));
	const findings = mainFindingEntries(report);
	const recommendations = recommendationEntries(report);
	const actions = actionEntries(report);
	const caveats = selectCaveats(report);
	const allSourceIndex = uniqueStructuredUrls(
		report.factSlotCoverage,
		report.mainFindings,
		report.recommendations,
		report.actionPlan,
		report.caveatedFindings,
		report.contestedAreas,
		report.notableUnsupportedClaims,
		report.remainingGaps,
		report.parentDecisionNotes,
		report.unverifiedButRelevant,
		control?.claimVerdictIndex?.claims,
	);
	const sourceIndex = allSourceIndex;
	const sectionCounts = {
		findings: asArray(report.mainFindings).length,
		renderedFindings: findings.length,
		recommendations: asArray(report.recommendations).length,
		renderedRecommendations: recommendations.length,
		actionItems: asArray(report.actionPlan).length,
		renderedActionItems: actions.length,
		caveatsAndGaps:
			asArray(report.remainingGaps).length +
			asArray(report.notableUnsupportedClaims).length +
			asArray(report.contestedAreas).length +
			asArray(report.caveatedFindings).length +
			asArray(report.unverifiedButRelevant).length +
			asArray(report.parentDecisionNotes).length,
		renderedCaveatsAndGaps: caveats.selected.length,
		factSlots: asArray(report.factSlotCoverage).length,
		renderedFactSlots: factSlots.length,
		sourceUrls: allSourceIndex.length,
		renderedSourceUrls: sourceIndex.length,
	};
	const warnings = renderWarnings(sectionCounts);

	const sections = [
		"# Research report",
		"",
		"## Bottom line",
		"",
		cleanText(
			report.summary ??
				control.digest ??
				"Research completed with audited evidence.",
		),
		"",
		...renderEvidenceStrength(report),
		...renderMainFindings(report),
		...renderRecommendations(report),
		...renderActionPlan(report),
		...renderCaveats(report),
		...renderSourceIndex(sourceIndex),
		...renderAuditSummary(control, claimSummary, slots),
	];

	const markdown = sections
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return {
		markdown,
		sourceIndex,
		allSourceIndex,
		claimSummary,
		factSlotSummary: slots,
		sectionCounts,
		renderWarnings: warnings,
	};
}

function stripLeadingHeading(markdown) {
	return String(markdown ?? "").replace(/^#\s+[^\n]+\n*/i, "");
}

export default async function renderExecutive({ sources, context = {} }) {
	const control =
		findSource(sources, "final-audit") ??
		sources?.[Object.keys(sources ?? {})[0]];
	if (!control || typeof control !== "object") {
		return {
			schema: "deep-research-executive-render-v1",
			digest:
				"Research report rendering failed: missing final-audit control source.",
			status: "blocked",
			blockers: ["missing final-audit control source"],
			executiveMarkdown: "",
			reportMarkdown: "",
			wordCount: 0,
			sourceUrlCount: 0,
			renderWarnings: [],
			gates: {
				renderedAllStructuredItems: false,
				passed: false,
			},
		};
	}

	const rendered = renderResearchMarkdown(control);
	const wordCount = countWords(rendered.markdown);
	const sourceUrlCount = rendered.sourceIndex.length;
	const renderedAllStructuredItems = rendered.renderWarnings.length === 0;
	const passed = renderedAllStructuredItems;

	let executiveSidecarPath;
	let reportSidecarPath;
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
			executiveSidecarPath = join(taskDir, "executive.md");
			reportSidecarPath = join(taskDir, "report.md");
			await writeFile(executiveSidecarPath, `${rendered.markdown}\n`, "utf8");
			await writeFile(reportSidecarPath, `${rendered.markdown}\n`, "utf8");
		}
	} catch {
		// Sidecars are non-authoritative; keep control output deterministic.
	}

	return {
		schema: "deep-research-executive-render-v1",
		digest: truncateWords(stripLeadingHeading(rendered.markdown), 45),
		status: passed ? "passed" : "failed",
		renderMode: "evidence-backed-report",
		executiveMarkdown: rendered.markdown,
		reportMarkdown: rendered.markdown,
		wordCount,
		sourceUrlCount,
		totalSourceUrlCount: rendered.allSourceIndex.length,
		sourceUrls: rendered.sourceIndex,
		sourceIndex: rendered.sourceIndex.map((url) => ({
			url,
			host: hostOf(url),
		})),
		claimSummary: rendered.claimSummary,
		factSlotSummary: rendered.factSlotSummary,
		sectionCounts: rendered.sectionCounts,
		renderWarnings: rendered.renderWarnings,
		gates: {
			renderedAllStructuredItems,
			passed,
		},
		auditArtifact: "final-audit.control.json",
		...(executiveSidecarPath ? { sidecarPath: executiveSidecarPath } : {}),
		...(reportSidecarPath ? { reportSidecarPath } : {}),
	};
}
