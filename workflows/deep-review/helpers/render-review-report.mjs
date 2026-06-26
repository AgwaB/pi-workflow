// Deterministic evidence-backed renderer for deep-review.
//
// Finding cards are rendered from partition-verdicts.control.json, the
// deterministic post-processing ledger. The model-authored report stage is used
// only for narrative summary/verdict/risk fields.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info", "unknown"];

function findSource(sources, stageId) {
	for (const [specId, source] of Object.entries(sources ?? {})) {
		if (specId === stageId || specId.startsWith(`${stageId}.`)) return source;
	}
	return null;
}

function asArray(value) {
	return Array.isArray(value) ? value : [];
}

function cleanText(value) {
	return String(value ?? "")
		.replace(/\s+/g, " ")
		.replace(/\s+([,.;:!?])/g, "$1")
		.trim();
}

function evidenceText(value) {
	return String(value ?? "")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.trim();
}

function escapeTableCell(value) {
	return cleanText(value).replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

function inlineCode(value) {
	return `\`${escapeTableCell(value).replace(/`/g, "\\`")}\``;
}

function severityOf(finding) {
	const raw = cleanText(finding?.severity).toLowerCase();
	if (SEVERITY_ORDER.includes(raw)) return raw;
	return raw || "unknown";
}

function severityRank(severity) {
	const index = SEVERITY_ORDER.indexOf(severityOf({ severity }));
	return index === -1 ? SEVERITY_ORDER.length : index;
}

function titleOf(finding) {
	return cleanText(
		finding?.title ??
			finding?.finding ??
			finding?.summary ??
			"Untitled finding",
	);
}

function findingIdOf(finding, index) {
	return cleanText(
		finding?.findingId ??
			finding?.id ??
			`finding-${String(index + 1).padStart(3, "0")}`,
	);
}

function rootCauseIdOf(finding) {
	return cleanText(finding?.rootCauseId ?? "");
}

function locationKey(location) {
	return `${location.file ?? ""}|${location.line ?? ""}|${location.lineEnd ?? ""}|${location.symbol ?? ""}`;
}

function normalizeLocation(location) {
	if (!location || typeof location !== "object") return null;
	const file = cleanText(location.file);
	if (!file) return null;
	const line = Number.isFinite(Number(location.line))
		? Number(location.line)
		: undefined;
	const lineEnd = Number.isFinite(Number(location.lineEnd))
		? Number(location.lineEnd)
		: undefined;
	const symbol = cleanText(location.symbol);
	return {
		file,
		...(line !== undefined ? { line } : {}),
		...(lineEnd !== undefined ? { lineEnd } : {}),
		...(symbol ? { symbol } : {}),
	};
}

function locationsOf(finding) {
	const seen = new Set();
	const out = [];
	for (const raw of asArray(finding?.locations)) {
		const location = normalizeLocation(raw);
		if (!location) continue;
		const key = locationKey(location);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(location);
	}
	return out;
}

function evidenceQuotesOf(finding) {
	const seen = new Set();
	const out = [];
	for (const quote of asArray(finding?.evidenceQuotes)) {
		const text = evidenceText(quote);
		if (!text || seen.has(text)) continue;
		seen.add(text);
		out.push(text);
	}
	return out;
}

function markdownFenceInfo(quote) {
	if (
		/^\s*(const|let|var|function|export|import|await|return|if|for|while)\b/.test(
			quote,
		)
	)
		return "ts";
	if (/^\s*(FROM|ENV|RUN|CMD|COPY|WORKDIR|EXPOSE)\b/i.test(quote))
		return "dockerfile";
	if (/^\s*[{}[]/.test(quote)) return "json";
	return "text";
}

function renderLocationsTable(locations) {
	if (locations.length === 0) return ["Locations: _not provided_", ""];
	return [
		"Locations:",
		"",
		"| File | Line | Symbol |",
		"|---|---:|---|",
		...locations.map((location) => {
			const line =
				location.line === undefined
					? "—"
					: location.lineEnd !== undefined && location.lineEnd !== location.line
						? `${location.line}-${location.lineEnd}`
						: `${location.line}`;
			return `| ${inlineCode(location.file)} | ${escapeTableCell(line)} | ${location.symbol ? inlineCode(location.symbol) : "—"} |`;
		}),
		"",
	];
}

function renderEvidenceQuotes(quotes) {
	if (quotes.length === 0) return [];
	const out = ["Evidence:", ""];
	for (const quote of quotes) {
		const info = markdownFenceInfo(quote);
		out.push(`\`\`\`${info}`);
		out.push(quote);
		out.push("```", "");
	}
	return out;
}

function renderCounterEvidence(finding) {
	const counter = asArray(finding?.counterEvidence)
		.map((item) =>
			typeof item === "string"
				? item
				: (item?.evidence ??
					item?.reason ??
					item?.note ??
					JSON.stringify(item)),
		)
		.map((item) => cleanText(item))
		.filter(Boolean);
	if (counter.length === 0 && !finding?.note) return [];
	return [
		"Caveat / counter-evidence:",
		"",
		...(finding?.note ? [`- ${cleanText(finding.note)}`] : []),
		...counter.map((item) => `- ${item}`),
		"",
	];
}

function normalizeFinding(finding, index, verdict) {
	return {
		...finding,
		findingId: findingIdOf(finding, index),
		rootCauseId: rootCauseIdOf(finding),
		title: titleOf(finding),
		severity: severityOf(finding),
		verdict,
	};
}

function partitionFindings(partition) {
	const keep = asArray(partition?.reportContext?.keep).map((finding, index) =>
		normalizeFinding(finding, index, "KEEP"),
	);
	const weaken = asArray(partition?.reportContext?.weaken).map(
		(finding, index) =>
			normalizeFinding(finding, keep.length + index, "WEAKEN"),
	);
	return { keep, weaken, all: [...keep, ...weaken] };
}

function expectedFindingCount(partition, allFindings) {
	const summary = partition?.partitionSummary;
	const keep = Number(summary?.keep);
	const weaken = Number(summary?.weaken);
	if (Number.isFinite(keep) || Number.isFinite(weaken)) {
		return (
			(Number.isFinite(keep) ? keep : 0) +
			(Number.isFinite(weaken) ? weaken : 0)
		);
	}
	return allFindings.length;
}

function groupBySeverity(findings) {
	const grouped = new Map();
	for (const finding of findings) {
		const severity = severityOf(finding);
		if (!grouped.has(severity)) grouped.set(severity, []);
		grouped.get(severity).push(finding);
	}
	return [...grouped.entries()].sort(
		([a], [b]) => severityRank(a) - severityRank(b) || a.localeCompare(b),
	);
}

function severityCounts(findings) {
	const counts = {};
	for (const finding of findings) {
		const severity = severityOf(finding);
		counts[severity] = (counts[severity] ?? 0) + 1;
	}
	return counts;
}

function renderSeveritySummary(findings) {
	const counts = severityCounts(findings);
	if (Object.keys(counts).length === 0) return [];
	return [
		"## Finding summary",
		"",
		"| Severity | Count |",
		"|---|---:|",
		...Object.entries(counts)
			.sort(
				([a], [b]) => severityRank(a) - severityRank(b) || a.localeCompare(b),
			)
			.map(([severity, count]) => `| ${severity} | ${count} |`),
		"",
	];
}

function renderFindingCard(finding) {
	const locations = locationsOf(finding);
	const quotes = evidenceQuotesOf(finding);
	const out = [
		`### ${finding.findingId} — ${finding.title}`,
		"",
		`Severity: **${finding.severity}**  `,
		...(finding.rootCauseId
			? [`Root cause: \`${finding.rootCauseId}\`  `]
			: []),
		...(finding.verdict && finding.verdict !== "KEEP"
			? [`Verifier verdict: **${finding.verdict}**  `]
			: []),
		"",
		...renderLocationsTable(locations),
		...renderEvidenceQuotes(quotes),
	];
	const action = cleanText(
		finding.recommendedAction ?? finding.concreteFix ?? "",
	);
	if (action) {
		out.push("Recommended action:", "", action, "");
	}
	out.push(...renderCounterEvidence(finding));
	return out;
}

function renderFindings(findings) {
	if (findings.length === 0)
		return [
			"## Findings",
			"",
			"No kept or weakened findings were present in the partition ledger.",
			"",
		];
	const representedIds = findings.map((finding) => finding.findingId);
	const out = [];
	for (const [severity, group] of groupBySeverity(findings)) {
		out.push(
			`## ${severity[0].toUpperCase()}${severity.slice(1)} findings`,
			"",
		);
		for (const finding of group) out.push(...renderFindingCard(finding));
	}
	return { lines: out, representedIds };
}

function renderNeedsHuman(partition) {
	const items = asArray(partition?.reportContext?.needsHuman);
	if (items.length === 0) return [];
	const out = ["## Needs human review", ""];
	for (const raw of items) {
		const finding = normalizeFinding(raw, 0, "NEEDS_HUMAN");
		out.push(
			`- **${finding.severity}** ${finding.findingId} — ${finding.title}`,
		);
	}
	out.push("");
	return out;
}

function renderRisks(report, partition) {
	const risks = asArray(report?.risks).map((risk) =>
		typeof risk === "string"
			? risk
			: (risk?.risk ?? risk?.note ?? risk?.summary ?? JSON.stringify(risk)),
	);
	const partialFailures = [
		...asArray(partition?.sourceStatusSummary?.partialFailures),
		...asArray(partition?.reportContext?.partialFailures),
	];
	const notes = asArray(partition?.normalizationNotes).map((note) =>
		typeof note === "string" ? note : JSON.stringify(note),
	);
	if (risks.length === 0 && partialFailures.length === 0 && notes.length === 0)
		return [];
	const out = ["## Risks and partial-review limitations", ""];
	for (const risk of risks) out.push(`- ${cleanText(risk)}`);
	for (const failure of partialFailures) {
		out.push(
			`- Partial source: ${cleanText(failure.displayName ?? failure.specId ?? failure.source ?? JSON.stringify(failure))} (${failure.status ?? "unknown"})`,
		);
	}
	for (const note of notes)
		out.push(`- Normalization note: ${cleanText(note)}`);
	out.push("");
	return out;
}

function stringifySummary(report) {
	const summary = report?.summary;
	if (typeof summary === "string" && cleanText(summary))
		return cleanText(summary);
	if (summary && typeof summary === "object") {
		return cleanText(
			summary.summary ??
				report?.digest ??
				summary.verdict ??
				JSON.stringify(summary),
		);
	}
	if (typeof report?.digest === "string" && report.digest.trim()) {
		return cleanText(report.digest);
	}
	return "Deep review completed.";
}

function renderMarkdown({ report, partition, findingCountMismatch }) {
	const { all } = partitionFindings(partition);
	const sortedFindings = all.sort(
		(a, b) =>
			severityRank(a.severity) - severityRank(b.severity) ||
			a.findingId.localeCompare(b.findingId),
	);
	const rendered = renderFindings(sortedFindings);
	const representedIds = rendered.representedIds ?? [];
	const lines = [
		"# Deep review report",
		"",
		`Verdict: **${cleanText(report?.verdict ?? "review_complete") || "review_complete"}**`,
		"",
		"## Summary",
		"",
		stringifySummary(report),
		"",
		...renderSeveritySummary(sortedFindings),
	];
	if (findingCountMismatch) {
		lines.push(
			"## Renderer warning",
			"",
			"The deterministic renderer found a mismatch between expected findings from `partition-verdicts` and represented finding IDs. Inspect `partition-verdicts.control.json` before acting on this report.",
			"",
		);
	}
	lines.push(...(rendered.lines ?? rendered));
	lines.push(...renderNeedsHuman(partition));
	lines.push(...renderRisks(report, partition));
	const nextAction = cleanText(report?.recommendedNextAction ?? "");
	if (nextAction) {
		lines.push("## Recommended next action", "", nextAction, "");
	}
	lines.push(
		"## Evidence source",
		"",
		"Finding cards are rendered from deterministic `partition-verdicts.control.json`; summary/verdict/risk prose comes from `report.control.json` when available.",
		"",
	);
	return {
		markdown: lines
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim(),
		representedIds,
	};
}

export default async function renderReviewReport({ sources, context = {} }) {
	const partition = findSource(sources, "partition-verdicts");
	const report = findSource(sources, "report") ?? {};
	if (!partition || typeof partition !== "object") {
		return {
			schema: "deep-review-render-v1",
			digest:
				"Deep review rendering failed: missing partition-verdicts control source.",
			status: "blocked",
			blockers: ["missing partition-verdicts control source"],
			markdown: "",
			findingSummary: { total: 0, bySeverity: {} },
			renderedFindingIds: [],
			sourceArtifacts: [],
			gates: {
				renderedAllFindings: false,
				findingCountMismatch: true,
				passed: false,
			},
		};
	}

	const { all } = partitionFindings(partition);
	const expected = expectedFindingCount(partition, all);
	const findingCountMismatch = expected !== all.length;
	const rendered = renderMarkdown({
		report,
		partition,
		findingCountMismatch,
	});
	const bySeverity = severityCounts(all);
	const renderedAllFindings = rendered.representedIds.length === all.length;
	const passed = !findingCountMismatch && renderedAllFindings;

	let sidecarPath;
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
			sidecarPath = join(taskDir, "review.md");
			await writeFile(sidecarPath, `${rendered.markdown}\n`, "utf8");
		}
	} catch {
		// Sidecar is non-authoritative; keep control output deterministic.
	}

	return {
		schema: "deep-review-render-v1",
		digest: `Rendered ${all.length} findings: ${
			Object.entries(bySeverity)
				.sort(
					([a], [b]) => severityRank(a) - severityRank(b) || a.localeCompare(b),
				)
				.map(([severity, count]) => `${severity}=${count}`)
				.join(", ") || "none"
		}.`,
		status: passed ? "passed" : "failed",
		markdown: rendered.markdown,
		findingSummary: { total: all.length, bySeverity },
		renderedFindingIds: rendered.representedIds,
		expectedFindingCount: expected,
		sourceArtifacts: [
			"partition-verdicts.control.json",
			...(report ? ["report.control.json"] : []),
		],
		gates: {
			renderedAllFindings,
			findingCountMismatch,
			passed,
		},
		...(sidecarPath ? { sidecarPath } : {}),
	};
}
