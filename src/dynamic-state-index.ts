import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { dynamicRunDir } from "./dynamic-events.js";
import type { DynamicOutputProfile } from "./dynamic-profiles.js";
import { ensureDir, writeJsonAtomic } from "./store.js";

export const DYNAMIC_ARTIFACT_EXTRACT_SCHEMA =
	"dynamic-artifact-extract-v1" as const;
export const DYNAMIC_STATE_INDEX_SCHEMA = "dynamic-state-index-v1" as const;
export const DYNAMIC_STATE_INDEX_EXTRACTOR_VERSION =
	"dynamic-state-index-extractor-v1";

export type DynamicFindingSeverity =
	| "critical"
	| "high"
	| "medium"
	| "low"
	| "info"
	| "unknown";
export type DynamicFindingConfidence = "high" | "medium" | "low" | "unknown";
export type DynamicVerificationStatus =
	| "unverified"
	| "verified"
	| "rejected"
	| "weakened"
	| "inconclusive";
export type DynamicClaimSupportStatus =
	| "supports"
	| "partial"
	| "contradicts"
	| "unsupported"
	| "inconclusive";

export interface DynamicStateArtifactRef {
	taskId: string;
	artifact?: string;
	digest?: string;
}

export interface DynamicStateFinding {
	id: string;
	title: string;
	severity: DynamicFindingSeverity;
	confidence: DynamicFindingConfidence;
	evidenceRefs: DynamicStateArtifactRef[];
	verificationStatus: DynamicVerificationStatus;
	sourceTaskIds: string[];
	lineage?: string[];
}

export interface DynamicStateVerification {
	findingId: string;
	status: Exclude<DynamicVerificationStatus, "unverified">;
	confidence: DynamicFindingConfidence;
	evidenceRefs: DynamicStateArtifactRef[];
	sourceTaskId: string;
	notes?: string;
}

export interface DynamicStateClaimSupport {
	findingId?: string;
	claim: string;
	status: DynamicClaimSupportStatus;
	confidence: DynamicFindingConfidence;
	sourceRefs: DynamicStateArtifactRef[];
	sourceLocators: string[];
	sourceTaskId: string;
	excerpt?: string;
	notes?: string;
}

export interface DynamicClaimSupportSummary {
	positiveVerifications: number;
	positiveVerificationsWithClaimSupport: number;
	positiveVerificationsMissingClaimSupport: number;
	claimSupports: number;
	positiveClaimSupports: number;
}

export interface DynamicStateCoverage {
	criterionId: string;
	status: "satisfied" | "unsatisfied" | "partial" | "unknown";
	evidenceRefs: DynamicStateArtifactRef[];
	sourceTaskId: string;
	notes?: string;
}

export interface DynamicStateIssue {
	id: string;
	message: string;
	severity?: DynamicFindingSeverity;
	sourceTaskIds: string[];
	relatedFindingIds?: string[];
}

export interface DynamicArtifactExtract {
	schema: typeof DYNAMIC_ARTIFACT_EXTRACT_SCHEMA;
	extractorVersion: typeof DYNAMIC_STATE_INDEX_EXTRACTOR_VERSION;
	source: {
		taskId: string;
		artifactRef?: DynamicStateArtifactRef;
		outputProfile: DynamicOutputProfile;
		status: "completed" | "failed" | "partial";
	};
	findings: DynamicStateFinding[];
	verifications: DynamicStateVerification[];
	claimSupports: DynamicStateClaimSupport[];
	coverage: DynamicStateCoverage[];
	gaps: DynamicStateIssue[];
	blockers: DynamicStateIssue[];
	conflicts: DynamicStateIssue[];
	extractionErrors: string[];
	omissions: string[];
}

export interface DynamicStateIndex {
	schema: typeof DYNAMIC_STATE_INDEX_SCHEMA;
	extractorVersion: typeof DYNAMIC_STATE_INDEX_EXTRACTOR_VERSION;
	digest: string;
	completedWork: Array<{ taskId: string; outputProfile: DynamicOutputProfile }>;
	failedWork: Array<{
		taskId: string;
		outputProfile: DynamicOutputProfile;
		status: string;
	}>;
	findings: DynamicStateFinding[];
	verifications: DynamicStateVerification[];
	claimSupports: DynamicStateClaimSupport[];
	claimSupportSummary: DynamicClaimSupportSummary;
	criteriaCoverage: DynamicStateCoverage[];
	gaps: DynamicStateIssue[];
	blockers: DynamicStateIssue[];
	conflicts: DynamicStateIssue[];
	omissions: string[];
	sourceExtracts: Array<{
		taskId: string;
		outputProfile: DynamicOutputProfile;
		digest: string;
	}>;
}

export interface ExtractDynamicStateArtifactInput {
	taskId: string;
	outputProfile: DynamicOutputProfile;
	control?: Record<string, unknown>;
	analysis?: string;
	refs?: unknown;
	artifactRef?: DynamicStateArtifactRef;
	status?: "completed" | "failed" | "partial";
	maxFindings?: number;
}

export interface AssembleDynamicStateIndexOptions {
	requiredFindingIds?: readonly string[];
	maxFindings?: number;
}

export interface DynamicStateIndexArtifactWriteInput {
	cwd: string;
	runId: string;
	controllerSpecId: string;
	round: number;
	extracts: DynamicArtifactExtract[];
	index: DynamicStateIndex;
}

export interface DynamicStateIndexArtifactWriteResult {
	directory: string;
	extractsPath: string;
	indexPath: string;
	digest: string;
}

export function extractDynamicStateArtifact(
	input: ExtractDynamicStateArtifactInput,
): DynamicArtifactExtract {
	const extract: DynamicArtifactExtract = {
		schema: DYNAMIC_ARTIFACT_EXTRACT_SCHEMA,
		extractorVersion: DYNAMIC_STATE_INDEX_EXTRACTOR_VERSION,
		source: {
			taskId: input.taskId,
			artifactRef: input.artifactRef,
			outputProfile: input.outputProfile,
			status: input.status ?? "completed",
		},
		findings: [],
		verifications: [],
		claimSupports: [],
		coverage: [],
		gaps: [],
		blockers: [],
		conflicts: [],
		extractionErrors: [],
		omissions: [],
	};
	const control = input.control ?? {};
	if (input.outputProfile === "candidate_findings_v1") {
		extractCandidateFindings(input, control, extract);
	} else if (input.outputProfile === "verification_result_v1") {
		extractVerificationResult(input, control, extract);
	} else if (input.outputProfile === "coverage_assessment_v1") {
		extractCoverage(input, control, extract);
	} else if (input.analysis?.trim()) {
		extract.gaps.push(
			issue(
				"generic-summary",
				"Generic summary requires manual review before clean synthesis",
				input.taskId,
			),
		);
	}
	copyIssues(
		control.gaps,
		"gap",
		input.taskId,
		extract.gaps,
		extract.extractionErrors,
	);
	copyIssues(
		control.blockers,
		"blocker",
		input.taskId,
		extract.blockers,
		extract.extractionErrors,
	);
	copyIssues(
		control.conflicts,
		"conflict",
		input.taskId,
		extract.conflicts,
		extract.extractionErrors,
	);
	copyOmissions(control.omissions, input.taskId, extract);
	return sortExtract(extract);
}

export function assembleDynamicStateIndex(
	extracts: readonly DynamicArtifactExtract[],
	options: AssembleDynamicStateIndexOptions = {},
): DynamicStateIndex {
	const findingMap = new Map<string, DynamicStateFinding>();
	const verifications: DynamicStateVerification[] = [];
	const claimSupports: DynamicStateClaimSupport[] = [];
	const criteriaCoverage: DynamicStateCoverage[] = [];
	const gaps: DynamicStateIssue[] = [];
	const blockers: DynamicStateIssue[] = [];
	const conflicts: DynamicStateIssue[] = [];
	const omissions: string[] = [];
	const completedWork: DynamicStateIndex["completedWork"] = [];
	const failedWork: DynamicStateIndex["failedWork"] = [];
	const sourceExtracts: DynamicStateIndex["sourceExtracts"] = [];

	for (const extract of extracts) {
		sourceExtracts.push({
			taskId: extract.source.taskId,
			outputProfile: extract.source.outputProfile,
			digest: hashDynamicStateExtract(extract),
		});
		if (extract.source.status === "completed")
			completedWork.push({
				taskId: extract.source.taskId,
				outputProfile: extract.source.outputProfile,
			});
		else
			failedWork.push({
				taskId: extract.source.taskId,
				outputProfile: extract.source.outputProfile,
				status: extract.source.status,
			});
		for (const error of extract.extractionErrors)
			blockers.push(
				issue(
					`extract-${extract.source.taskId}`,
					error,
					extract.source.taskId,
					"high",
				),
			);
		for (const finding of extract.findings) mergeFinding(findingMap, finding);
		verifications.push(...extract.verifications);
		claimSupports.push(...extract.claimSupports);
		criteriaCoverage.push(...extract.coverage);
		gaps.push(...extract.gaps);
		blockers.push(...extract.blockers);
		conflicts.push(...extract.conflicts);
		omissions.push(...extract.omissions);
	}

	for (const verification of verifications.sort(compareVerification)) {
		const finding = findingMap.get(verification.findingId);
		if (!finding) {
			blockers.push(
				issue(
					`verify-${verification.findingId}`,
					`Verification references unknown finding ${verification.findingId}`,
					verification.sourceTaskId,
					"high",
					[verification.findingId],
				),
			);
			continue;
		}
		finding.verificationStatus = verification.status;
		finding.confidence = verification.confidence;
		finding.evidenceRefs = mergeRefs(
			finding.evidenceRefs,
			verification.evidenceRefs,
		);
		finding.sourceTaskIds = uniqueSorted([
			...finding.sourceTaskIds,
			verification.sourceTaskId,
		]);
		finding.lineage = uniqueSorted([
			...(finding.lineage ?? []),
			verification.sourceTaskId,
		]);
	}

	for (const requiredFindingId of options.requiredFindingIds ?? []) {
		if (!findingMap.has(requiredFindingId))
			blockers.push(
				issue(
					`missing-${requiredFindingId}`,
					`Required finding ${requiredFindingId} was dropped from the state index`,
					"state-index",
					"high",
					[requiredFindingId],
				),
			);
	}

	let findings = [...findingMap.values()].sort(compareById);
	if (
		options.maxFindings !== undefined &&
		findings.length > options.maxFindings
	) {
		const required = new Set(options.requiredFindingIds ?? []);
		const kept: typeof findings = [];
		const overflow: typeof findings = [];
		for (const finding of findings) {
			if (required.has(finding.id) && kept.length < options.maxFindings)
				kept.push(finding);
			else overflow.push(finding);
		}
		for (const finding of overflow) {
			if (kept.length < options.maxFindings) kept.push(finding);
			else
				omissions.push(
					`omitted finding ${finding.id} due to maxFindings=${options.maxFindings}`,
				);
		}
		const keptIds = new Set(kept.map((finding) => finding.id));
		for (const requiredFindingId of required) {
			if (!keptIds.has(requiredFindingId))
				blockers.push(
					issue(
						`missing-${requiredFindingId}`,
						`Required finding ${requiredFindingId} was dropped from the state index`,
						"state-index",
						"high",
						[requiredFindingId],
					),
				);
		}
		findings = kept.sort(compareById);
	}
	for (const finding of findings) {
		if (
			(finding.severity === "critical" || finding.severity === "high") &&
			finding.verificationStatus === "unverified"
		) {
			blockers.push(
				issue(
					`unverified-${finding.id}`,
					`High-risk finding ${finding.id} remains unverified`,
					finding.sourceTaskIds[0] ?? "state-index",
					finding.severity,
					[finding.id],
				),
			);
		}
		if (finding.evidenceRefs.length === 0 && finding.confidence !== "high") {
			gaps.push(
				issue(
					`weak-evidence-${finding.id}`,
					`Finding ${finding.id} has weak or missing evidence`,
					finding.sourceTaskIds[0] ?? "state-index",
					"medium",
					[finding.id],
				),
			);
		}
	}

	const sortedVerifications = verifications.sort(compareVerification);
	const sortedClaimSupports = claimSupports.sort(compareClaimSupport);
	const indexWithoutDigest = {
		schema: DYNAMIC_STATE_INDEX_SCHEMA,
		extractorVersion: DYNAMIC_STATE_INDEX_EXTRACTOR_VERSION,
		completedWork: completedWork.sort(compareTaskProfile),
		failedWork: failedWork.sort(compareTaskProfile),
		findings: findings.map(sortFinding),
		verifications: sortedVerifications,
		claimSupports: sortedClaimSupports,
		claimSupportSummary: summarizeClaimSupport(
			sortedVerifications,
			sortedClaimSupports,
		),
		criteriaCoverage: criteriaCoverage.sort(compareCoverage),
		gaps: dedupeIssues(gaps),
		blockers: dedupeIssues(blockers),
		conflicts: dedupeIssues(conflicts),
		omissions: uniqueSorted(omissions),
		sourceExtracts: sourceExtracts.sort(compareTaskProfile),
	} satisfies Omit<DynamicStateIndex, "digest">;
	return {
		...indexWithoutDigest,
		digest: hashDynamicStateIndex(indexWithoutDigest),
	};
}

export function hashDynamicStateExtract(
	extract: DynamicArtifactExtract,
): string {
	return hashStable(extract);
}

export function hashDynamicStateIndex(index: unknown): string {
	const withoutDigest = isRecord(index)
		? { ...index, digest: undefined }
		: index;
	return hashStable(pruneUndefined(withoutDigest));
}

export async function writeDynamicStateIndexArtifacts(
	input: DynamicStateIndexArtifactWriteInput,
): Promise<DynamicStateIndexArtifactWriteResult> {
	const directory = join(
		dynamicRunDir(input.cwd, input.runId),
		"state-indexes",
		sanitizeSegment(input.controllerSpecId),
		`round-${String(input.round).padStart(3, "0")}`,
	);
	await ensureDir(directory);
	const extractsPath = join(directory, "extracts.json");
	const indexPath = join(directory, "index.json");
	await assertExistingStateIndexDigestMatches(indexPath, input.index.digest);
	await writeJsonAtomic(extractsPath, input.extracts);
	await writeJsonAtomic(indexPath, input.index);
	return { directory, extractsPath, indexPath, digest: input.index.digest };
}

async function assertExistingStateIndexDigestMatches(
	indexPath: string,
	expectedDigest: string,
): Promise<void> {
	let existingText: string;
	try {
		existingText = await readFile(indexPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	const existing = JSON.parse(existingText) as { digest?: unknown };
	if (existing.digest !== expectedDigest) {
		throw new Error(
			`dynamic state index artifact already exists with divergent digest: ${String(existing.digest)} != ${expectedDigest}`,
		);
	}
}

function extractCandidateFindings(
	input: ExtractDynamicStateArtifactInput,
	control: Record<string, unknown>,
	extract: DynamicArtifactExtract,
): void {
	const findings = control.findings;
	if (findings === undefined) return;
	if (!Array.isArray(findings)) {
		extract.extractionErrors.push(
			"candidate_findings_v1 findings must be an array",
		);
		return;
	}
	const maxFindings = input.maxFindings;
	for (const [index, raw] of findings.entries()) {
		if (maxFindings !== undefined && extract.findings.length >= maxFindings) {
			extract.omissions.push(
				`omitted candidate finding at index ${index} due to maxFindings=${maxFindings}`,
			);
			continue;
		}
		if (!isRecord(raw)) {
			extract.extractionErrors.push(`finding[${index}] must be an object`);
			continue;
		}
		const id =
			stringField(raw.id) ??
			`finding-${sanitizeSegment(input.taskId)}-${String(index + 1).padStart(3, "0")}`;
		const title = stringField(raw.title) ?? stringField(raw.summary) ?? id;
		extract.findings.push({
			id,
			title,
			severity: severityField(raw.severity),
			confidence: confidenceField(raw.confidence),
			evidenceRefs: refsField(raw.evidenceRefs, input.taskId),
			verificationStatus: "unverified",
			sourceTaskIds: [input.taskId],
		});
	}
}

function extractVerificationResult(
	input: ExtractDynamicStateArtifactInput,
	control: Record<string, unknown>,
	extract: DynamicArtifactExtract,
): void {
	const findingId = stringField(control.findingId);
	if (!findingId) {
		extract.extractionErrors.push(
			"verification_result_v1 findingId is required",
		);
		return;
	}
	const verdict =
		stringField(control.verdict) ??
		stringField(control.status) ??
		"inconclusive";
	if (!["verified", "rejected", "weakened", "inconclusive"].includes(verdict)) {
		extract.extractionErrors.push(
			`verification_result_v1 verdict ${verdict} is unsupported`,
		);
		return;
	}
	const claimSupports = claimSupportsField(
		control,
		input.taskId,
		findingId,
		verdict as DynamicStateVerification["status"],
		extract.extractionErrors,
	);
	extract.verifications.push({
		findingId,
		status: verdict as DynamicStateVerification["status"],
		confidence: confidenceField(control.confidence),
		evidenceRefs: refsField(control.evidenceRefs, input.taskId),
		sourceTaskId: input.taskId,
		notes: stringField(control.notes),
	});
	extract.claimSupports.push(...claimSupports);
	if (
		(verdict === "verified" || verdict === "weakened") &&
		!claimSupports.some(isPositiveClaimSupport)
	) {
		extract.gaps.push(
			issue(
				`missing-claim-support-${sanitizeSegment(findingId)}`,
				`Verification ${findingId} returned ${verdict} without structured positive claim-source support`,
				input.taskId,
				"medium",
				[findingId],
			),
		);
	}
}

function extractCoverage(
	input: ExtractDynamicStateArtifactInput,
	control: Record<string, unknown>,
	extract: DynamicArtifactExtract,
): void {
	const coverage = control.criteriaCoverage ?? control.coverage;
	if (coverage === undefined) return;
	const entries = Array.isArray(coverage)
		? coverage
		: isRecord(coverage)
			? Object.entries(coverage).map(([criterionId, value]) =>
					isRecord(value)
						? { criterionId, ...value }
						: { criterionId, status: value },
				)
			: undefined;
	if (!entries) {
		extract.extractionErrors.push(
			"coverage_assessment_v1 criteriaCoverage must be an array or object",
		);
		return;
	}
	for (const [index, raw] of entries.entries()) {
		if (!isRecord(raw)) {
			extract.extractionErrors.push(
				`criteriaCoverage[${index}] must be an object`,
			);
			continue;
		}
		const criterionId = stringField(raw.criterionId ?? raw.id);
		if (!criterionId) {
			extract.extractionErrors.push(
				`criteriaCoverage[${index}].criterionId is required`,
			);
			continue;
		}
		const status = stringField(raw.status) ?? "unknown";
		extract.coverage.push({
			criterionId,
			status: ["satisfied", "unsatisfied", "partial", "unknown"].includes(
				status,
			)
				? (status as DynamicStateCoverage["status"])
				: "unknown",
			evidenceRefs: refsField(raw.evidenceRefs, input.taskId),
			sourceTaskId: input.taskId,
			notes: stringField(raw.notes),
		});
	}
}

function copyIssues(
	value: unknown,
	prefix: string,
	taskId: string,
	target: DynamicStateIssue[],
	errors: string[],
): void {
	if (value === undefined) return;
	if (!Array.isArray(value)) {
		errors.push(`${prefix}s must be an array`);
		return;
	}
	for (const [index, item] of value.entries()) {
		if (typeof item === "string") {
			target.push(
				issue(
					`${prefix}-${sanitizeSegment(taskId)}-${index + 1}`,
					item,
					taskId,
				),
			);
			continue;
		}
		if (!isRecord(item)) {
			errors.push(`${prefix}[${index}] must be a string or object`);
			continue;
		}
		const id =
			stringField(item.id) ??
			`${prefix}-${sanitizeSegment(taskId)}-${index + 1}`;
		const message =
			stringField(item.message) ?? stringField(item.summary) ?? id;
		target.push(
			issue(
				id,
				message,
				taskId,
				severityField(item.severity),
				optionalStringArray(item.relatedFindingIds),
			),
		);
	}
}

function copyOmissions(
	value: unknown,
	taskId: string,
	extract: DynamicArtifactExtract,
): void {
	if (value === undefined) return;
	if (!Array.isArray(value)) {
		extract.extractionErrors.push("omissions must be an array");
		return;
	}
	for (const item of value) {
		if (typeof item === "string") extract.omissions.push(`${taskId}: ${item}`);
		else extract.extractionErrors.push("omissions entries must be strings");
	}
}

function mergeFinding(
	findingMap: Map<string, DynamicStateFinding>,
	finding: DynamicStateFinding,
): void {
	const current = findingMap.get(finding.id);
	if (!current) {
		findingMap.set(finding.id, sortFinding(finding));
		return;
	}
	current.evidenceRefs = mergeRefs(current.evidenceRefs, finding.evidenceRefs);
	current.sourceTaskIds = uniqueSorted([
		...current.sourceTaskIds,
		...finding.sourceTaskIds,
	]);
	current.severity = maxSeverity(current.severity, finding.severity);
	current.confidence = maxConfidence(current.confidence, finding.confidence);
	if (current.title !== finding.title)
		current.lineage = uniqueSorted([
			...(current.lineage ?? []),
			...finding.sourceTaskIds,
		]);
}

function claimSupportsField(
	control: Record<string, unknown>,
	fallbackTaskId: string,
	fallbackFindingId: string,
	verificationStatus: DynamicStateVerification["status"],
	errors: string[],
): DynamicStateClaimSupport[] {
	const raw =
		control.claimSupports ??
		control.sourceSupports ??
		control.claimSourceSupport ??
		control.sourceSupport;
	const entries = claimSupportEntries(raw, control);
	if (entries === undefined) return [];
	if (!entries) {
		errors.push(
			"verification_result_v1 claimSupports must be an object or array",
		);
		return [];
	}
	const supports: DynamicStateClaimSupport[] = [];
	for (const [index, item] of entries.entries()) {
		if (!isRecord(item)) {
			errors.push(`claimSupports[${index}] must be an object`);
			continue;
		}
		const claim =
			stringField(item.claim) ??
			stringField(item.summary) ??
			stringField(control.claim) ??
			fallbackFindingId;
		const sourceLocators = uniqueSorted([
			...sourceLocatorsField(item.sourceLocators),
			...sourceLocatorsField(item.locators),
			...sourceLocatorsField(item.sources),
			...sourceLocatorsField(item.refs),
			...sourceLocatorsField(item.urls),
			...sourceLocatorFromRecord(item),
		]);
		supports.push(
			sortClaimSupport({
				findingId: stringField(item.findingId) ?? fallbackFindingId,
				claim,
				status: claimSupportStatusField(
					item.status ?? item.supportStatus ?? item.support ?? item.verdict,
					verificationStatus,
				),
				confidence: confidenceField(item.confidence ?? control.confidence),
				sourceRefs: refsField(
					item.sourceRefs ?? item.evidenceRefs,
					fallbackTaskId,
				),
				sourceLocators,
				sourceTaskId: fallbackTaskId,
				excerpt: stringField(item.excerpt) ?? stringField(item.quote),
				notes: stringField(item.notes),
			}),
		);
	}
	return supports;
}

function claimSupportEntries(
	raw: unknown,
	control: Record<string, unknown>,
): unknown[] | undefined | false {
	if (raw === undefined) {
		return hasTopLevelClaimSupportFields(control) ? [control] : undefined;
	}
	if (Array.isArray(raw)) return raw;
	if (isRecord(raw)) return [raw];
	return false;
}

function hasTopLevelClaimSupportFields(
	control: Record<string, unknown>,
): boolean {
	return [
		"claim",
		"sourceLocators",
		"locators",
		"sources",
		"sourceRefs",
		"excerpt",
		"quote",
	].some((key) => control[key] !== undefined);
}

function claimSupportStatusField(
	value: unknown,
	verificationStatus: DynamicStateVerification["status"],
): DynamicClaimSupportStatus {
	if (
		value === "supports" ||
		value === "partial" ||
		value === "contradicts" ||
		value === "unsupported" ||
		value === "inconclusive"
	)
		return value;
	if (verificationStatus === "verified") return "supports";
	if (verificationStatus === "weakened") return "partial";
	if (verificationStatus === "rejected") return "unsupported";
	return "inconclusive";
}

function isPositiveClaimSupport(support: DynamicStateClaimSupport): boolean {
	return support.status === "supports" || support.status === "partial";
}

function sourceLocatorsField(value: unknown): string[] {
	if (typeof value === "string" && value.trim()) return [value.trim()];
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		const locator = workflowSourceLocator(item);
		return locator ? [locator] : [];
	});
}

function sourceLocatorFromRecord(record: Record<string, unknown>): string[] {
	const locator = workflowSourceLocator(record);
	return locator ? [locator] : [];
}

function workflowSourceLocator(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim()) return value.trim();
	if (!isRecord(value)) return undefined;
	for (const key of ["url", "ref", "path", "taskId", "source", "locator"]) {
		const item = value[key];
		if (typeof item === "string" && item.trim()) return item.trim();
	}
	return undefined;
}

function refsField(
	value: unknown,
	fallbackTaskId: string,
): DynamicStateArtifactRef[] {
	if (!Array.isArray(value)) return [];
	const refs: DynamicStateArtifactRef[] = [];
	for (const item of value) {
		if (typeof item === "string") {
			refs.push({ taskId: fallbackTaskId, artifact: item });
			continue;
		}
		if (!isRecord(item)) continue;
		const taskId = stringField(item.taskId) ?? fallbackTaskId;
		refs.push(
			pruneUndefined({
				taskId,
				artifact: stringField(item.artifact),
				digest: stringField(item.digest),
			}) as DynamicStateArtifactRef,
		);
	}
	return refs.sort(compareRef);
}

function issue(
	id: string,
	message: string,
	taskId: string,
	severity: DynamicFindingSeverity = "medium",
	relatedFindingIds?: string[],
): DynamicStateIssue {
	return pruneUndefined({
		id,
		message,
		severity,
		sourceTaskIds: [taskId],
		relatedFindingIds: relatedFindingIds?.length
			? uniqueSorted(relatedFindingIds)
			: undefined,
	}) as DynamicStateIssue;
}

function dedupeIssues(issues: DynamicStateIssue[]): DynamicStateIssue[] {
	const byId = new Map<string, DynamicStateIssue>();
	for (const item of issues) {
		const current = byId.get(item.id);
		if (!current) {
			byId.set(item.id, {
				...item,
				sourceTaskIds: uniqueSorted(item.sourceTaskIds),
			});
			continue;
		}
		current.sourceTaskIds = uniqueSorted([
			...current.sourceTaskIds,
			...item.sourceTaskIds,
		]);
		current.relatedFindingIds = uniqueSorted([
			...(current.relatedFindingIds ?? []),
			...(item.relatedFindingIds ?? []),
		]);
	}
	return [...byId.values()].sort(compareById);
}

function sortExtract(extract: DynamicArtifactExtract): DynamicArtifactExtract {
	return {
		...extract,
		findings: extract.findings.map(sortFinding).sort(compareById),
		verifications: extract.verifications.sort(compareVerification),
		claimSupports: extract.claimSupports.sort(compareClaimSupport),
		coverage: extract.coverage.sort(compareCoverage),
		gaps: dedupeIssues(extract.gaps),
		blockers: dedupeIssues(extract.blockers),
		conflicts: dedupeIssues(extract.conflicts),
		extractionErrors: uniqueSorted(extract.extractionErrors),
		omissions: uniqueSorted(extract.omissions),
	};
}

function sortFinding(finding: DynamicStateFinding): DynamicStateFinding {
	return pruneUndefined({
		...finding,
		evidenceRefs: mergeRefs([], finding.evidenceRefs),
		sourceTaskIds: uniqueSorted(finding.sourceTaskIds),
		lineage: finding.lineage ? uniqueSorted(finding.lineage) : undefined,
	});
}

function sortClaimSupport(
	support: DynamicStateClaimSupport,
): DynamicStateClaimSupport {
	return pruneUndefined({
		...support,
		sourceRefs: mergeRefs([], support.sourceRefs),
		sourceLocators: uniqueSorted(support.sourceLocators),
	});
}

function summarizeClaimSupport(
	verifications: readonly DynamicStateVerification[],
	claimSupports: readonly DynamicStateClaimSupport[],
): DynamicClaimSupportSummary {
	const positiveVerifications = verifications.filter(
		(verification) =>
			verification.status === "verified" || verification.status === "weakened",
	);
	const positiveSupports = claimSupports.filter(isPositiveClaimSupport);
	const positiveSupportFindingIds = new Set(
		positiveSupports.flatMap((support) =>
			support.findingId ? [support.findingId] : [],
		),
	);
	const withSupport = positiveVerifications.filter((verification) =>
		positiveSupportFindingIds.has(verification.findingId),
	).length;
	return {
		positiveVerifications: positiveVerifications.length,
		positiveVerificationsWithClaimSupport: withSupport,
		positiveVerificationsMissingClaimSupport:
			positiveVerifications.length - withSupport,
		claimSupports: claimSupports.length,
		positiveClaimSupports: positiveSupports.length,
	};
}

function mergeRefs(
	base: DynamicStateArtifactRef[],
	extra: DynamicStateArtifactRef[],
): DynamicStateArtifactRef[] {
	const byKey = new Map<string, DynamicStateArtifactRef>();
	for (const ref of [...base, ...extra])
		byKey.set(`${ref.taskId}:${ref.artifact ?? ""}:${ref.digest ?? ""}`, ref);
	return [...byKey.values()].sort(compareRef);
}

function severityField(value: unknown): DynamicFindingSeverity {
	return value === "critical" ||
		value === "high" ||
		value === "medium" ||
		value === "low" ||
		value === "info"
		? value
		: "unknown";
}

function confidenceField(value: unknown): DynamicFindingConfidence {
	return value === "high" || value === "medium" || value === "low"
		? value
		: "unknown";
}

function maxSeverity(
	a: DynamicFindingSeverity,
	b: DynamicFindingSeverity,
): DynamicFindingSeverity {
	const rank: Record<DynamicFindingSeverity, number> = {
		unknown: 0,
		info: 1,
		low: 2,
		medium: 3,
		high: 4,
		critical: 5,
	};
	return rank[b] > rank[a] ? b : a;
}

function maxConfidence(
	a: DynamicFindingConfidence,
	b: DynamicFindingConfidence,
): DynamicFindingConfidence {
	const rank: Record<DynamicFindingConfidence, number> = {
		unknown: 0,
		low: 1,
		medium: 2,
		high: 3,
	};
	return rank[b] > rank[a] ? b : a;
}

function compareTaskProfile(
	a: { taskId: string; outputProfile: string },
	b: { taskId: string; outputProfile: string },
): number {
	return (
		a.taskId.localeCompare(b.taskId) ||
		a.outputProfile.localeCompare(b.outputProfile)
	);
}

function compareById(a: { id: string }, b: { id: string }): number {
	return a.id.localeCompare(b.id);
}

function compareVerification(
	a: DynamicStateVerification,
	b: DynamicStateVerification,
): number {
	return (
		a.findingId.localeCompare(b.findingId) ||
		a.sourceTaskId.localeCompare(b.sourceTaskId)
	);
}

function compareClaimSupport(
	a: DynamicStateClaimSupport,
	b: DynamicStateClaimSupport,
): number {
	return (
		(a.findingId ?? "").localeCompare(b.findingId ?? "") ||
		a.claim.localeCompare(b.claim) ||
		a.sourceTaskId.localeCompare(b.sourceTaskId)
	);
}

function compareCoverage(
	a: DynamicStateCoverage,
	b: DynamicStateCoverage,
): number {
	return (
		a.criterionId.localeCompare(b.criterionId) ||
		a.sourceTaskId.localeCompare(b.sourceTaskId)
	);
}

function compareRef(
	a: DynamicStateArtifactRef,
	b: DynamicStateArtifactRef,
): number {
	return (
		a.taskId.localeCompare(b.taskId) ||
		(a.artifact ?? "").localeCompare(b.artifact ?? "") ||
		(a.digest ?? "").localeCompare(b.digest ?? "")
	);
}

function uniqueSorted(values: readonly string[]): string[] {
	return [...new Set(values.filter(Boolean))].sort();
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value
		.filter(
			(item): item is string => typeof item === "string" && item.trim() !== "",
		)
		.map((item) => item.trim());
}

function hashStable(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(toStableJson(toJson(value))))
		.digest("hex");
}

function toJson(value: unknown): unknown {
	const text = JSON.stringify(value);
	return text === undefined ? null : JSON.parse(text);
}

function toStableJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => toStableJson(item));
	if (!isRecord(value)) return value;
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort())
		result[key] = toStableJson(value[key]);
	return result;
}

function pruneUndefined<T>(value: T): T {
	if (Array.isArray(value))
		return value.map((item) => pruneUndefined(item)) as T;
	if (!isRecord(value)) return value;
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (item !== undefined) result[key] = pruneUndefined(item);
	}
	return result as T;
}

function sanitizeSegment(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "") || "item"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
