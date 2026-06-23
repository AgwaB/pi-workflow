// Deterministic executive renderer for deep-research-compact-v2.
//
// Input: final-audit.control.json from the full deep-research final stage.
// Output: compact executiveMarkdown in control plus an executive.md sidecar.
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

function collectUrls(value, urls = []) {
	if (typeof value === "string") {
		for (const match of value.matchAll(/https?:\/\/[^\s)\]}"`]+/g))
			urls.push(match[0].replace(/[.,;:]+$/, ""));
		return urls;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectUrls(item, urls);
		return urls;
	}
	if (value && typeof value === "object") {
		for (const item of Object.values(value)) collectUrls(item, urls);
	}
	return urls;
}

function collectSourceLocators(value, locators = [], fieldName = "") {
	if (typeof value === "string") {
		const urls = collectUrls(value, []);
		if (urls.length > 0) locators.push(...urls);
		else if (
			/^(sourceUrls?|sourceRefs?|sourcePaths?|urls?|paths?)$/i.test(fieldName)
		) {
			const trimmed = value.trim();
			if (trimmed) locators.push(trimmed);
		}
		return locators;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectSourceLocators(item, locators, fieldName);
		return locators;
	}
	if (value && typeof value === "object") {
		for (const [key, item] of Object.entries(value)) {
			collectSourceLocators(item, locators, key);
		}
	}
	return locators;
}

function itemText(item, kind) {
	if (typeof item === "string") return cleanText(item);
	if (!item || typeof item !== "object") return "";
	const fields =
		kind === "recommendation"
			? ["recommendation", "step", "action", "note", "finding", "gap"]
			: kind === "gap"
				? ["gap", "note", "finding", "whyItMatters", "parentImpact"]
				: ["finding", "summary", "bestValue", "recommendation", "step", "note"];
	for (const field of fields) {
		if (typeof item[field] === "string" && item[field].trim())
			return cleanText(item[field]);
	}
	return cleanText(JSON.stringify(item));
}

function sourceSuffix(item, state, options) {
	const urls = [...new Set(collectUrls(item))].filter(Boolean);
	const selected = [];
	for (const url of urls) {
		if (state.urls.size >= options.maxUrls) break;
		if (state.urls.has(url)) continue;
		state.urls.add(url);
		selected.push(url);
		if (selected.length >= 1) break; // one URL per bullet keeps memo compact
	}
	if (selected.length === 0) return "";
	return ` (${selected.map((url) => hostOf(url)).join(", ")}: ${selected.join(" ")})`;
}

function bulletLines(items, kind, limit, state, options, perItemWords = 34) {
	const out = [];
	for (const item of asArray(items)) {
		if (out.length >= limit) break;
		const text = truncateWords(itemText(item, kind), perItemWords);
		if (!text) continue;
		out.push(`- ${text}${sourceSuffix(item, state, options)}`);
	}
	return out;
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
	const coverage = control?.finalReport?.coverageSummary;
	if (coverage && typeof coverage === "object") {
		return {
			total:
				Number(coverage.verificationCandidates ?? counts.total) || counts.total,
			verified: Number(coverage.verified ?? counts.verified) || counts.verified,
			partially_supported:
				Number(coverage.partiallySupported ?? counts.partially_supported) ||
				counts.partially_supported,
			unsupported:
				Number(coverage.unsupported ?? counts.unsupported) ||
				counts.unsupported,
			conflicting:
				Number(coverage.conflicting ?? counts.conflicting) ||
				counts.conflicting,
		};
	}
	return counts;
}

function renderExecutiveMarkdown(control, options) {
	const report = control?.finalReport ?? {};
	const state = { urls: new Set() };
	const maxWords = options.maxWords;
	const counts = claimCounts(control);
	const factSlots = asArray(report.factSlotCoverage);
	const filledSlots = factSlots.filter(
		(slot) => slot?.status === "filled",
	).length;
	const partialSlots = factSlots.filter(
		(slot) => slot?.status === "partial",
	).length;
	const missingSlots = factSlots.filter((slot) =>
		["missing", "gap", "conflicting"].includes(slot?.status),
	).length;

	const sections = [];
	sections.push("# Executive summary");
	sections.push("");
	sections.push(
		`**Bottom line:** ${truncateWords(report.summary ?? control.digest ?? "Research completed with audited evidence.", 85)}`,
	);
	sections.push("");

	const findings = bulletLines(
		report.mainFindings,
		"finding",
		options.maxFindings,
		state,
		options,
	);
	if (findings.length) {
		sections.push("**Top findings**");
		sections.push(...findings);
		sections.push("");
	}

	const recommendations = bulletLines(
		report.recommendations?.length ? report.recommendations : report.actionPlan,
		"recommendation",
		options.maxRecommendations,
		state,
		options,
		32,
	);
	if (recommendations.length) {
		sections.push("**Recommended next steps**");
		sections.push(...recommendations);
		sections.push("");
	}

	const caveatItems = [
		...asArray(report.caveatedFindings),
		...asArray(report.remainingGaps),
		...asArray(report.parentDecisionNotes),
	];
	const gaps = bulletLines(
		caveatItems,
		"gap",
		options.maxGaps,
		state,
		options,
		30,
	);
	if (gaps.length) {
		sections.push("**Key caveats / gaps**");
		sections.push(...gaps);
		sections.push("");
	}

	sections.push(
		`**Audit trail:** Full evidence remains in \`final-audit.control.json\`: ${counts.verified} verified, ${counts.partially_supported} partially supported, ${counts.unsupported} unsupported, ${counts.conflicting} conflicting claims; fact slots ${filledSlots} filled, ${partialSlots} partial, ${missingSlots} missing/conflicting.`,
	);

	let markdown = sections
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	let truncated = false;
	if (countWords(markdown) > maxWords) {
		truncated = true;
		markdown = truncateWords(markdown, maxWords);
	}
	for (const locator of [...new Set(collectSourceLocators(control))]) {
		if (state.urls.size >= options.maxUrls) break;
		state.urls.add(locator);
	}
	return {
		markdown,
		truncated,
		sourceUrls: [...state.urls],
		counts,
		factSlots: {
			total: factSlots.length,
			filled: filledSlots,
			partial: partialSlots,
			missingOrConflicting: missingSlots,
		},
	};
}

export default async function renderExecutive({
	sources,
	options = {},
	context = {},
}) {
	const control =
		findSource(sources, "final-audit") ??
		sources?.[Object.keys(sources ?? {})[0]];
	const opts = {
		maxWords: Number(options.maxWords ?? 600),
		maxUrls: Number(options.maxUrls ?? 5),
		maxFindings: Number(options.maxFindings ?? 3),
		maxRecommendations: Number(options.maxRecommendations ?? 3),
		maxGaps: Number(options.maxGaps ?? 2),
	};
	if (!control || typeof control !== "object") {
		return {
			schema: "deep-research-executive-render-v1",
			digest: "Executive rendering failed: missing final-audit control source.",
			status: "blocked",
			blockers: ["missing final-audit control source"],
			executiveMarkdown: "",
			wordCount: 0,
			sourceUrlCount: 0,
			gates: { maxWords: opts.maxWords, maxUrls: opts.maxUrls, passed: false },
		};
	}

	const rendered = renderExecutiveMarkdown(control, opts);
	const wordCount = countWords(rendered.markdown);
	const sourceUrlCount = rendered.sourceUrls.length;
	const passed = wordCount <= opts.maxWords && sourceUrlCount <= opts.maxUrls;

	// Best-effort sidecar for local inspection. The control field is still the
	// authoritative workflow artifact; this file is a convenience view.
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
			sidecarPath = join(taskDir, "executive.md");
			await writeFile(sidecarPath, `${rendered.markdown}\n`, "utf8");
		}
	} catch {
		// Sidecar is non-authoritative; keep control output deterministic.
	}

	return {
		schema: "deep-research-executive-render-v1",
		digest: truncateWords(
			rendered.markdown.replace(/^# Executive summary\s*/i, ""),
			45,
		),
		status: passed ? "passed" : "failed",
		executiveMarkdown: rendered.markdown,
		wordCount,
		sourceUrlCount,
		sourceUrls: rendered.sourceUrls,
		claimSummary: rendered.counts,
		factSlotSummary: rendered.factSlots,
		gates: {
			maxWords: opts.maxWords,
			maxUrls: opts.maxUrls,
			maxFindings: opts.maxFindings,
			maxRecommendations: opts.maxRecommendations,
			maxGaps: opts.maxGaps,
			truncated: rendered.truncated,
			passed,
		},
		auditArtifact: "final-audit.control.json",
		...(sidecarPath ? { sidecarPath } : {}),
	};
}
