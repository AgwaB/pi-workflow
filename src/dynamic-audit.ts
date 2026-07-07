// Deterministic claim-support audit for direct dynamic runs.
//
// Mirrors the counting semantics of the static deep-research audit helpers
// (workflows/deep-research/helpers/claim-evidence-gate.mjs): claims come from
// the synthesis control JSON's claim-bearing arrays, and a claim only counts
// as sourced when at least one of the source locators it carries resolves
// against the refs/sources the dynamic workers actually collected (join by
// generated-task ref id or by URL). This is fail-open accounting, not a gate:
// callers must never fail a run on audit results or audit errors.

import type { WorkflowDynamicRunAudit } from "./types.js";

/**
 * Claim-bearing top-level arrays counted from the synthesis control JSON, in
 * priority order. `synthesis_v1` has no fixed schema, so every present key
 * whose value is an array contributes its entries as claims.
 */
export const DYNAMIC_AUDIT_CLAIM_KEYS = [
	"claims",
	"keyFindings",
	"key_findings",
	"findings",
	"statements",
	"conclusions",
	"recommendations",
] as const;

const CLAIM_SOURCE_FIELDS = [
	"sourceRefs",
	"sourceUrls",
	"sourceLocators",
	"sources",
	"refs",
	"urls",
	"evidenceRefs",
	"citations",
] as const;

const LOCATOR_OBJECT_KEYS = [
	"url",
	"ref",
	"path",
	"taskId",
	"source",
	"locator",
] as const;

const TASK_ARTIFACT_NAMES = ["control", "analysis", "refs", "raw"] as const;

export const DYNAMIC_AUDIT_MAX_UNSUPPORTED_CLAIM_IDS = 24;

const URL_PATTERN = /https?:\/\/[^\s<>()[\]{}"']+/g;

export interface DynamicAuditSynthesisInput {
	/** Task id (spec id) of the synthesis worker that produced the control. */
	taskId: string;
	/** Parsed control JSON of the synthesis worker (control.json). */
	control?: unknown;
}

export interface DynamicAuditCollectedRefsInput {
	/** Run-scoped task id of the worker that collected the refs. */
	taskId: string;
	/** Stable spec id of the worker (join-by-ref-id also accepts this). */
	specId?: string;
	/** Parsed refs.json content (expected to be an array). */
	refs?: unknown;
}

export interface DynamicAuditInput {
	synthesis: readonly DynamicAuditSynthesisInput[];
	collected: readonly DynamicAuditCollectedRefsInput[];
}

interface CollectedRefIndex {
	locators: Set<string>;
	urls: Set<string>;
	refsTotal: number;
}

/**
 * Deterministic claim-support accounting for a dynamic run.
 *
 * Counting semantics:
 * - claimsTotal: entries of every claim-bearing array
 *   (DYNAMIC_AUDIT_CLAIM_KEYS) present at the top level of each synthesis
 *   control JSON. String and object entries both count.
 * - A claim's carried source locators are the union of its structured source
 *   fields (sourceRefs/sourceUrls/sourceLocators/sources/refs/urls/
 *   evidenceRefs/citations; string items or objects with
 *   url/ref/path/taskId/source/locator) and any URLs embedded anywhere in the
 *   claim entry (URL fallback, mirroring the deep-research collectUrls scan).
 * - claimsWithSources: claims where at least one carried locator resolves
 *   against the collected worker refs: exact locator match, normalized URL
 *   match, or generated-task ref-id match (taskId/specId, optionally with an
 *   `.control/.analysis/.refs/.raw` suffix or `workflow_artifact:` prefix).
 * - sourceRefJoinFailures: carried locators (across all claims) that failed
 *   to resolve against the collected refs.
 * - refsTotal / uniqueSourceUrls: entry count and unique normalized URL count
 *   across the collected workers' refs.json arrays.
 * - unsupportedClaimIds: ids of claims without a resolving source, in
 *   encounter order, bounded to DYNAMIC_AUDIT_MAX_UNSUPPORTED_CLAIM_IDS.
 */
export function auditDynamicClaimSupport(
	input: DynamicAuditInput,
): WorkflowDynamicRunAudit {
	const collected = indexCollectedRefs(input.collected);
	const countedClaimKeys = new Set<string>();
	const unsupportedClaimIds: string[] = [];
	let claimsTotal = 0;
	let claimsWithSources = 0;
	let sourceRefJoinFailures = 0;

	for (const synthesis of input.synthesis) {
		const control = isRecord(synthesis.control) ? synthesis.control : undefined;
		if (!control) continue;
		for (const key of DYNAMIC_AUDIT_CLAIM_KEYS) {
			const entries = control[key];
			if (!Array.isArray(entries)) continue;
			countedClaimKeys.add(key);
			for (const [index, entry] of entries.entries()) {
				claimsTotal += 1;
				const locators = claimSourceLocators(entry);
				let resolved = false;
				for (const locator of locators) {
					if (locatorResolves(locator, collected)) resolved = true;
					else sourceRefJoinFailures += 1;
				}
				if (resolved) {
					claimsWithSources += 1;
					continue;
				}
				if (
					unsupportedClaimIds.length < DYNAMIC_AUDIT_MAX_UNSUPPORTED_CLAIM_IDS
				) {
					unsupportedClaimIds.push(
						claimId(entry, synthesis.taskId, key, index),
					);
				}
			}
		}
	}

	return {
		claimsTotal,
		claimsWithSources,
		claimsWithoutSources: claimsTotal - claimsWithSources,
		refsTotal: collected.refsTotal,
		uniqueSourceUrls: collected.urls.size,
		sourceRefJoinFailures,
		unsupportedClaimIds,
		countedClaimKeys: [...countedClaimKeys],
		synthesisTaskIds: input.synthesis.map((item) => item.taskId),
	};
}

export function formatDynamicAuditSummary(
	audit: WorkflowDynamicRunAudit | { error: string },
): string {
	if (!("claimsTotal" in audit)) {
		return `audit: error (${audit.error})`;
	}
	return `audit: ${audit.claimsWithSources}/${audit.claimsTotal} claims sourced, joins ${audit.sourceRefJoinFailures}`;
}

function indexCollectedRefs(
	collected: readonly DynamicAuditCollectedRefsInput[],
): CollectedRefIndex {
	const locators = new Set<string>();
	const urls = new Set<string>();
	let refsTotal = 0;
	for (const worker of collected) {
		addTaskJoinIds(locators, worker.taskId);
		if (worker.specId) addTaskJoinIds(locators, worker.specId);
		if (!Array.isArray(worker.refs)) continue;
		refsTotal += worker.refs.length;
		for (const entry of worker.refs) {
			for (const locator of entryLocators(entry)) {
				locators.add(locator);
				const url = normalizeUrl(locator);
				if (url) urls.add(url);
			}
			for (const url of extractUrls(entry)) urls.add(url);
		}
	}
	return { locators, urls, refsTotal };
}

function addTaskJoinIds(locators: Set<string>, id: string): void {
	const trimmed = id.trim();
	if (!trimmed) return;
	locators.add(trimmed);
	locators.add(`workflow_artifact:${trimmed}`);
	for (const artifact of TASK_ARTIFACT_NAMES) {
		locators.add(`${trimmed}.${artifact}`);
		locators.add(`workflow_artifact:${trimmed}.${artifact}`);
	}
}

function claimSourceLocators(entry: unknown): string[] {
	const locators = new Set<string>();
	if (typeof entry === "string") {
		for (const url of extractUrls(entry)) locators.add(url);
		return [...locators];
	}
	if (!isRecord(entry)) return [];
	for (const field of CLAIM_SOURCE_FIELDS) {
		const value = entry[field];
		if (typeof value === "string" && value.trim()) {
			locators.add(value.trim());
			continue;
		}
		if (!Array.isArray(value)) continue;
		for (const item of value) {
			for (const locator of entryLocators(item)) locators.add(locator);
		}
	}
	for (const url of extractUrls(entry)) locators.add(url);
	return [...locators];
}

function entryLocators(entry: unknown): string[] {
	if (typeof entry === "string" && entry.trim()) return [entry.trim()];
	if (!isRecord(entry)) return [];
	const locators: string[] = [];
	for (const key of LOCATOR_OBJECT_KEYS) {
		const value = entry[key];
		if (typeof value === "string" && value.trim())
			locators.push(value.trim());
	}
	return locators;
}

function locatorResolves(locator: string, index: CollectedRefIndex): boolean {
	if (index.locators.has(locator)) return true;
	const url = normalizeUrl(locator);
	return url !== undefined && index.urls.has(url);
}

function extractUrls(value: unknown, urls = new Set<string>()): Set<string> {
	if (typeof value === "string") {
		for (const match of value.matchAll(URL_PATTERN)) {
			const url = normalizeUrl(match[0]);
			if (url) urls.add(url);
		}
		return urls;
	}
	if (Array.isArray(value)) {
		for (const item of value) extractUrls(item, urls);
		return urls;
	}
	if (isRecord(value)) {
		for (const item of Object.values(value)) extractUrls(item, urls);
	}
	return urls;
}

function normalizeUrl(value: string): string | undefined {
	const trimmed = value.trim();
	if (!/^https?:\/\//i.test(trimmed)) return undefined;
	const withoutFragment = trimmed.split("#", 1)[0] ?? trimmed;
	const withoutTrailingSlash = withoutFragment.replace(/\/+$/, "");
	const match = /^(https?:\/\/[^/]+)(.*)$/i.exec(withoutTrailingSlash);
	if (!match) return withoutTrailingSlash;
	return `${match[1]!.toLowerCase()}${match[2] ?? ""}`;
}

function claimId(
	entry: unknown,
	taskId: string,
	key: string,
	index: number,
): string {
	if (isRecord(entry)) {
		for (const idKey of ["id", "claimId", "findingId"]) {
			const value = entry[idKey];
			if (typeof value === "string" && value.trim()) return value.trim();
		}
	}
	return `${taskId}:${key}[${index}]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
