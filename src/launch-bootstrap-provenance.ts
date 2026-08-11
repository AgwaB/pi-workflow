import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { PreparedWorkflowTaskLaunch } from "./backend.js";
import { workflowArtifactExtensionImportPath } from "./artifact-graph-runtime.js";
import { buildWorkflowArtifactExtensionWrapper } from "./workflow-artifact-extension.js";
import {
	WORKFLOW_SOURCE_MANIFEST_SCHEMA,
	normalizeWorkflowSourceManifest,
} from "./workflow-artifact-tool.js";
import { fromProjectPath, workflowRunDir } from "./store.js";
import { workflowStateRootIdentity } from "./workflow-state-root.js";
import {
	isWorkflowTaskSessionIdentity,
	workflowTaskAttemptIdentity,
	workflowTaskSessionId,
} from "./launch-session.js";
import type {
	CompiledTask,
	LaunchBootstrapProvenanceHistory,
	LaunchBootstrapProvenanceRecord,
	WorkflowRunRecord,
	WorkflowTaskRunRecord,
} from "./types.js";

export const LAUNCH_BOOTSTRAP_PROVENANCE_SCHEMA =
	"pi-workflow-launch-bootstrap-provenance-v1" as const;
export const EXTERNAL_LAUNCH_GRANT_SHA256_ENV =
	"PI_WORKFLOW_EXTERNAL_LAUNCH_GRANT_SHA256" as const;
export const REQUIRE_EXTERNAL_LAUNCH_GRANT_ENV =
	"PI_WORKFLOW_REQUIRE_EXTERNAL_LAUNCH_GRANT" as const;

function externalLaunchGrantSha256(): string | undefined {
	const value = process.env[EXTERNAL_LAUNCH_GRANT_SHA256_ENV];
	if (
		value === undefined &&
		process.env[REQUIRE_EXTERNAL_LAUNCH_GRANT_ENV] === "1"
	)
		throw new Error("required external launch grant digest is absent");
	if (value === undefined) return undefined;
	if (!/^[a-f0-9]{64}$/u.test(value))
		throw new Error("external launch grant digest must be lowercase SHA-256");
	return value;
}

export async function createLaunchBootstrapProvenance(
	cwd: string,
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	preparedTask: CompiledTask,
	backendId: string,
	preparedLaunch: PreparedWorkflowTaskLaunch = {
		extensions: [],
		generatedExtensions: [],
		captureToolCalls: false,
	},
): Promise<LaunchBootstrapProvenanceRecord> {
	const sessionId = workflowTaskSessionId(run, task);
	const artifactIdentities = await artifactIdentity(cwd, run, task);
	const stateRootIdentity = await workflowStateRootIdentity(cwd);
	const externalGrantSha256 = externalLaunchGrantSha256();
	const record: Omit<LaunchBootstrapProvenanceRecord, "identitySha256"> = {
		schema: LAUNCH_BOOTSTRAP_PROVENANCE_SCHEMA,
		workflow: {
			type: run.type,
			specPathSha256: sha256Text(run.specPath),
		},
		runId: run.runId,
		task: {
			taskId: task.taskId,
			specId: task.specId,
			...(task.generation === undefined ? {} : { generation: task.generation }),
		},
		attempt: {
			key: workflowTaskAttemptIdentity(task, sessionId),
			launchRetry: task.launchRetry?.attempts ?? 0,
			outputRetry: task.outputRetry?.attempts ?? 0,
			resume: task.resumeEvents?.length ?? 0,
		},
		...(sessionId === undefined ? {} : { sessionId }),
		backend: { id: backendId, type: run.backend.type, mode: run.backend.mode },
		prompt: {
			sha256: sha256Text(preparedTask.compiledPrompt),
			bytes: Buffer.byteLength(preparedTask.compiledPrompt, "utf8"),
		},
		...(artifactIdentities === undefined
			? {}
			: { artifacts: artifactIdentities }),
		effectiveLaunch: launchIdentity(preparedLaunch),
		effectivePolicy: {
			tools: [...(preparedTask.runtime.tools ?? [])],
			toolProvidersSha256: sha256Canonical(
				preparedTask.runtime.toolProviders ?? {},
			),
			...(externalGrantSha256 === undefined
				? {}
				: { externalLaunchGrantSha256: externalGrantSha256 }),
			...(preparedTask.runtime.model === undefined
				? {}
				: { model: preparedTask.runtime.model }),
			...(preparedTask.runtime.thinking === undefined
				? {}
				: { thinking: preparedTask.runtime.thinking }),
			...(preparedTask.runtime.fast === undefined
				? {}
				: { fast: preparedTask.runtime.fast }),
			approvalMode: preparedTask.runtime.approvalMode,
			...(preparedTask.runtime.maxRuntimeMs === undefined
				? {}
				: { maxRuntimeMs: preparedTask.runtime.maxRuntimeMs }),
			cwdSha256: sha256Text(task.cwd),
			stateRootSha256: stateRootIdentity.identitySha256,
			worktree: {
				enabled: task.worktree.enabled,
				...(task.worktree.path === null
					? {}
					: { pathSha256: sha256Text(task.worktree.path) }),
				...(task.worktree.branch === null
					? {}
					: { branchSha256: sha256Text(task.worktree.branch) }),
				...(task.worktree.baseCwd === null
					? {}
					: { baseCwdSha256: sha256Text(task.worktree.baseCwd) }),
			},
		},
		sourceDependencies: {
			contextDependsOn: [...(preparedTask.contextDependsOn ?? [])],
			...(preparedTask.artifactGraph?.sourceProjection === undefined
				? {}
				: { sourceProjection: preparedTask.artifactGraph.sourceProjection }),
			...(preparedTask.artifactGraph?.requiredReads === undefined
				? {}
				: { requiredReads: preparedTask.artifactGraph.requiredReads }),
			...(preparedTask.artifactGraph?.requiredReadPolicy === undefined
				? {}
				: {
						requiredReadPolicy: preparedTask.artifactGraph.requiredReadPolicy,
					}),
			...(preparedTask.artifactGraph?.artifactAccess === undefined
				? {}
				: { artifactAccess: preparedTask.artifactGraph.artifactAccess }),
		},
	};
	return { ...record, identitySha256: sha256Canonical(record) };
}

/** Persist only an exact deterministic replay of a known attempt. */
export function recordLaunchBootstrapProvenance(
	task: WorkflowTaskRunRecord,
	record: LaunchBootstrapProvenanceRecord,
): void {
	const history: LaunchBootstrapProvenanceHistory = task.launchBootstrap ?? {
		version: 1,
		records: [],
	};
	if (!isValidHistory(history) || !isValidLaunchBootstrapRecord(record))
		throw new Error("launch-bootstrap provenance is malformed");
	const attempts = new Set<string>();
	for (const candidate of history.records) {
		if (
			!isValidLaunchBootstrapRecord(candidate) ||
			!hasSameHistoryOwner(candidate, record) ||
			attempts.has(candidate.attempt.key)
		)
			throw new Error("launch-bootstrap provenance is malformed");
		attempts.add(candidate.attempt.key);
	}
	const existing = history.records.find(
		(candidate) => candidate.attempt.key === record.attempt.key,
	);
	if (existing && canonicalJson(existing) !== canonicalJson(record))
		throw new Error(
			"launch-bootstrap provenance mismatch for existing attempt",
		);
	if (!existing) history.records.push(record);
	task.launchBootstrap = history;
}

export function canonicalLaunchBootstrapBytes(value: unknown): Buffer {
	return Buffer.from(canonicalJson(value), "utf8");
}

export function assertRecordedLaunchBootstrapProvenance(
	task: WorkflowTaskRunRecord,
	identitySha256: string,
): LaunchBootstrapProvenanceRecord {
	const history = task.launchBootstrap;
	if (!isValidHistory(history))
		throw new Error("launch-bootstrap provenance is unavailable");
	const attempts = new Set<string>();
	let owner: LaunchBootstrapProvenanceRecord | undefined;
	let matched: LaunchBootstrapProvenanceRecord | undefined;
	for (const candidate of history.records) {
		if (
			!isValidLaunchBootstrapRecord(candidate) ||
			(owner !== undefined && !hasSameHistoryOwner(candidate, owner)) ||
			attempts.has(candidate.attempt.key)
		)
			throw new Error("launch-bootstrap provenance is malformed");
		owner ??= candidate;
		attempts.add(candidate.attempt.key);
		if (candidate.identitySha256 === identitySha256) matched = candidate;
	}
	if (!matched)
		throw new Error("launch-bootstrap provenance identity is unavailable");
	return matched;
}

export async function assertPreparedLaunchMatchesRecordedProvenance(
	cwd: string,
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
	preparedTask: CompiledTask,
	backendId: string,
	preparedLaunch: PreparedWorkflowTaskLaunch,
	identitySha256: string,
): Promise<void> {
	const recorded = assertRecordedLaunchBootstrapProvenance(
		task,
		identitySha256,
	);
	const current = await createLaunchBootstrapProvenance(
		cwd,
		run,
		task,
		preparedTask,
		backendId,
		preparedLaunch,
	);
	if (canonicalJson(recorded) !== canonicalJson(current))
		throw new Error("workflow launch authority sealed launch mismatch");
}

function launchIdentity(
	preparedLaunch: PreparedWorkflowTaskLaunch,
): LaunchBootstrapProvenanceRecord["effectiveLaunch"] {
	if (
		!Array.isArray(preparedLaunch.extensions) ||
		new Set(preparedLaunch.extensions).size !== preparedLaunch.extensions.length
	)
		throw new Error("launch-bootstrap prepared extensions are invalid");
	const generated = new Map(
		preparedLaunch.generatedExtensions.map((extension) => [
			extension.path,
			extension,
		]),
	);
	if (
		generated.size !== preparedLaunch.generatedExtensions.length ||
		preparedLaunch.generatedExtensions.some(
			(extension) => !preparedLaunch.extensions.includes(extension.path),
		)
	)
		throw new Error("launch-bootstrap prepared extensions are invalid");
	return {
		extensions: preparedLaunch.extensions.map((path) => {
			if (typeof path !== "string" || path.length === 0)
				throw new Error("launch-bootstrap prepared extensions are invalid");
			const extension = generated.get(path);
			return {
				pathSha256: sha256Text(path),
				...(extension === undefined
					? {}
					: {
							generated: {
								kind: extension.kind,
								wrapperSha256: sha256Text(extension.expectedBytes),
								configSha256: sha256Canonical(extension.config),
							},
						}),
			};
		}),
		captureToolCalls: preparedLaunch.captureToolCalls,
		...(preparedLaunch.toolResultBudget === undefined
			? {}
			: {
					toolResultBudgetSha256: sha256Canonical(
						preparedLaunch.toolResultBudget,
					),
				}),
		...(preparedLaunch.artifactBinding === undefined
			? {}
			: {
					artifactBinding: {
						manifestPathSha256: sha256Text(
							preparedLaunch.artifactBinding.manifestPath,
						),
						manifestBytesSha256: sha256Text(
							preparedLaunch.artifactBinding.expectedManifestBytes,
						),
						wrapperPathSha256: sha256Text(
							preparedLaunch.artifactBinding.wrapperPath,
						),
						wrapperBytesSha256: sha256Text(
							preparedLaunch.artifactBinding.expectedWrapperBytes,
						),
					},
				}),
	};
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(normalizeCanonical(value));
}

function normalizeCanonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeCanonical);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([, entry]) => entry !== undefined)
				.sort(([left], [right]) => compareCanonicalKeys(left, right))
				.map(([key, entry]) => [key, normalizeCanonical(entry)]),
		);
	}
	return value;
}

function compareCanonicalKeys(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

function isValidHistory(
	value: unknown,
): value is LaunchBootstrapProvenanceHistory {
	return (
		isRecord(value) &&
		hasExactKeys(value, ["version", "records"]) &&
		value.version === 1 &&
		Array.isArray(value.records)
	);
}

function isValidLaunchBootstrapRecord(
	value: unknown,
): value is LaunchBootstrapProvenanceRecord {
	if (
		!isRecord(value) ||
		!hasAllowedKeys(value, recordKeys) ||
		!hasRequiredKeys(value, requiredRecordKeys)
	)
		return false;
	if (
		value.schema !== LAUNCH_BOOTSTRAP_PROVENANCE_SCHEMA ||
		!isSha256(value.identitySha256) ||
		!isWorkflow(value.workflow) ||
		!nonEmptyString(value.runId) ||
		!isTask(value.task) ||
		!isAttempt(value.attempt) ||
		(value.sessionId !== undefined && !isSessionId(value.sessionId)) ||
		!isBackend(value.backend) ||
		!isPrompt(value.prompt) ||
		(value.artifacts !== undefined && !isArtifacts(value.artifacts)) ||
		!isEffectiveLaunch(value.effectiveLaunch) ||
		!isEffectivePolicy(value.effectivePolicy) ||
		!isSourceDependencies(value.sourceDependencies)
	)
		return false;
	const attempt = value.attempt as {
		key: string;
		launchRetry: number;
		outputRetry: number;
		resume: number;
	};
	if (
		attempt.key !==
		[
			`launch-retry:${attempt.launchRetry}`,
			`output-retry:${attempt.outputRetry}`,
			`resume:${attempt.resume}`,
			`session:${value.sessionId ?? "none"}`,
		].join(";") ||
		(value.sessionId !== undefined &&
			!isWorkflowTaskSessionIdentity({
				runId: value.runId as string,
				taskId: (value.task as { taskId: string }).taskId,
				launchRetry: attempt.launchRetry,
				outputRetry: attempt.outputRetry,
				resume: attempt.resume,
				sessionId: value.sessionId as string,
			}))
	)
		return false;
	const { identitySha256, ...identity } = value;
	return identitySha256 === sha256Canonical(identity);
}

function hasSameHistoryOwner(
	candidate: LaunchBootstrapProvenanceRecord,
	current: LaunchBootstrapProvenanceRecord,
): boolean {
	return (
		candidate.runId === current.runId &&
		canonicalJson(candidate.workflow) === canonicalJson(current.workflow) &&
		canonicalJson(candidate.task) === canonicalJson(current.task) &&
		canonicalJson(candidate.backend) === canonicalJson(current.backend) &&
		(candidate.sessionId === undefined) === (current.sessionId === undefined)
	);
}

const recordKeys = [
	"schema",
	"identitySha256",
	"workflow",
	"runId",
	"task",
	"attempt",
	"sessionId",
	"backend",
	"prompt",
	"artifacts",
	"effectiveLaunch",
	"effectivePolicy",
	"sourceDependencies",
] as const;
const requiredRecordKeys = [
	"schema",
	"identitySha256",
	"workflow",
	"runId",
	"task",
	"attempt",
	"backend",
	"prompt",
	"effectiveLaunch",
	"effectivePolicy",
	"sourceDependencies",
] as const;

function isWorkflow(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasExactKeys(value, ["type", "specPathSha256"]) &&
		nonEmptyString(value.type) &&
		isSha256(value.specPathSha256)
	);
}

function isTask(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasAllowedKeys(value, ["taskId", "specId", "generation"]) &&
		nonEmptyString(value.taskId) &&
		nonEmptyString(value.specId) &&
		(value.generation === undefined || nonNegativeInteger(value.generation))
	);
}

function isAttempt(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasExactKeys(value, ["key", "launchRetry", "outputRetry", "resume"]) &&
		nonEmptyString(value.key) &&
		nonNegativeInteger(value.launchRetry) &&
		nonNegativeInteger(value.outputRetry) &&
		nonNegativeInteger(value.resume)
	);
}

function isBackend(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasExactKeys(value, ["id", "type", "mode"]) &&
		nonEmptyString(value.id) &&
		nonEmptyString(value.type) &&
		nonEmptyString(value.mode)
	);
}

function isPrompt(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasExactKeys(value, ["sha256", "bytes"]) &&
		isSha256(value.sha256) &&
		nonNegativeInteger(value.bytes)
	);
}

function isArtifacts(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasExactKeys(value, ["manifestSha256", "wrapperSha256", "configSha256"]) &&
		isSha256(value.manifestSha256) &&
		isSha256(value.wrapperSha256) &&
		isSha256(value.configSha256)
	);
}

function isEffectiveLaunch(value: unknown): boolean {
	if (
		!isRecord(value) ||
		!hasAllowedKeys(value, [
			"extensions",
			"captureToolCalls",
			"toolResultBudgetSha256",
			"artifactBinding",
		]) ||
		!Array.isArray(value.extensions) ||
		typeof value.captureToolCalls !== "boolean" ||
		!optionalSha256(value.toolResultBudgetSha256) ||
		(value.artifactBinding !== undefined &&
			!isArtifactBindingIdentity(value.artifactBinding))
	)
		return false;
	return value.extensions.every((extension) => isExtensionIdentity(extension));
}

function isArtifactBindingIdentity(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasExactKeys(value, [
			"manifestPathSha256",
			"manifestBytesSha256",
			"wrapperPathSha256",
			"wrapperBytesSha256",
		]) &&
		isSha256(value.manifestPathSha256) &&
		isSha256(value.manifestBytesSha256) &&
		isSha256(value.wrapperPathSha256) &&
		isSha256(value.wrapperBytesSha256)
	);
}

function isExtensionIdentity(value: unknown): boolean {
	if (
		!isRecord(value) ||
		!hasAllowedKeys(value, ["pathSha256", "generated"]) ||
		!isSha256(value.pathSha256)
	)
		return false;
	if (value.generated === undefined) return true;
	return (
		isRecord(value.generated) &&
		hasExactKeys(value.generated, ["kind", "wrapperSha256", "configSha256"]) &&
		(value.generated.kind === "fetch-cache" ||
			value.generated.kind === "web-source") &&
		isSha256(value.generated.wrapperSha256) &&
		isSha256(value.generated.configSha256)
	);
}

function isEffectivePolicy(value: unknown): boolean {
	if (
		!isRecord(value) ||
		!hasAllowedKeys(value, [
			"tools",
			"toolProvidersSha256",
			"externalLaunchGrantSha256",
			"model",
			"thinking",
			"fast",
			"approvalMode",
			"maxRuntimeMs",
			"cwdSha256",
			"stateRootSha256",
			"worktree",
		]) ||
		!Array.isArray(value.tools) ||
		!value.tools.every(nonEmptyString) ||
		!isSha256(value.toolProvidersSha256) ||
		!optionalSha256(value.externalLaunchGrantSha256) ||
		!optionalString(value.model) ||
		!optionalString(value.thinking) ||
		!optionalString(value.fast) ||
		!nonEmptyString(value.approvalMode) ||
		(value.maxRuntimeMs !== undefined &&
			!positiveInteger(value.maxRuntimeMs)) ||
		!isSha256(value.cwdSha256) ||
		!optionalSha256(value.stateRootSha256)
	)
		return false;
	return isWorktree(value.worktree);
}

function isWorktree(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasAllowedKeys(value, [
			"enabled",
			"pathSha256",
			"branchSha256",
			"baseCwdSha256",
		]) &&
		typeof value.enabled === "boolean" &&
		optionalSha256(value.pathSha256) &&
		optionalSha256(value.branchSha256) &&
		optionalSha256(value.baseCwdSha256)
	);
}

function isSourceDependencies(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasAllowedKeys(value, [
			"contextDependsOn",
			"sourceProjection",
			"requiredReads",
			"requiredReadPolicy",
			"artifactAccess",
		]) &&
		Array.isArray(value.contextDependsOn) &&
		value.contextDependsOn.every(nonEmptyString) &&
		new Set(value.contextDependsOn).size === value.contextDependsOn.length &&
		optionalJson(value.sourceProjection) &&
		optionalJson(value.requiredReads) &&
		optionalJson(value.requiredReadPolicy) &&
		optionalString(value.artifactAccess)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return (
		Boolean(value) &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

function hasExactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	return (
		hasAllowedKeys(value, keys) && Object.keys(value).length === keys.length
	);
}

function hasAllowedKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	return (
		Object.keys(value).every((key) => keys.includes(key)) &&
		Object.values(value).every((entry) => entry !== undefined)
	);
}

function hasRequiredKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	return keys.every((key) => Object.hasOwn(value, key));
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function optionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

function isSessionId(value: unknown): boolean {
	return typeof value === "string" && value.length > 0 && value.length <= 64;
}

function isSha256(value: unknown): boolean {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function optionalSha256(value: unknown): boolean {
	return value === undefined || isSha256(value);
}

function nonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
	return nonNegativeInteger(value) && value > 0;
}

function optionalJson(value: unknown): boolean {
	return value === undefined || isJson(value);
}

function isJson(value: unknown): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJson);
	return isRecord(value) && Object.values(value).every(isJson);
}

function sha256Canonical(value: unknown): string {
	return createHash("sha256")
		.update(canonicalLaunchBootstrapBytes(value))
		.digest("hex");
}

function sha256Text(value: string): string {
	return createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
}

async function artifactIdentity(
	cwd: string,
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
): Promise<LaunchBootstrapProvenanceRecord["artifacts"] | undefined> {
	if (
		!task.artifactGraph?.enabled ||
		task.artifactGraph.artifactAccess === "none"
	)
		return undefined;
	const directory = dirname(fromProjectPath(cwd, task.files.result));
	const manifestPath = join(directory, "source-manifest.json");
	const wrapperPath = join(directory, "workflow-artifact-extension.ts");
	let manifest: unknown;
	try {
		manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	} catch {
		throw new Error(
			"launch-bootstrap artifact manifest is unavailable or invalid",
		);
	}
	if (!isClosedArtifactManifest(manifest, cwd, run, task))
		throw new Error("launch-bootstrap artifact manifest identity is invalid");
	const config = {
		runId: run.runId,
		taskId: task.taskId,
		manifestPath,
		ledgerPath: join(directory, "read-ledger.jsonl"),
		accessMode: "workflow-task" as const,
		runDir: workflowRunDir(cwd, run.runId),
	};
	const expectedWrapper = buildWorkflowArtifactExtensionWrapper({
		importPath: workflowArtifactExtensionImportPath(),
		config,
	});
	let wrapper: string;
	try {
		wrapper = await readFile(wrapperPath, "utf8");
	} catch {
		throw new Error("launch-bootstrap artifact extension is unavailable");
	}
	if (wrapper !== expectedWrapper)
		throw new Error("launch-bootstrap artifact extension binding is invalid");
	return {
		manifestSha256: sha256Canonical(manifest),
		wrapperSha256: sha256Text(wrapper),
		configSha256: sha256Canonical(config),
	};
}

function isClosedArtifactManifest(
	value: unknown,
	cwd: string,
	run: WorkflowRunRecord,
	task: WorkflowTaskRunRecord,
): boolean {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["schema", "runId", "taskId", "sources", "policy"])
	)
		return false;
	if (
		value.schema !== WORKFLOW_SOURCE_MANIFEST_SCHEMA ||
		value.runId !== run.runId ||
		value.taskId !== task.taskId ||
		!Array.isArray(value.sources) ||
		!isRecord(value.policy) ||
		!hasExactKeys(value.policy, ["accessMode"]) ||
		value.policy.accessMode !== "workflow-task"
	)
		return false;
	try {
		normalizeWorkflowSourceManifest(value, {
			runDir: workflowRunDir(cwd, run.runId),
		});
		return true;
	} catch {
		return false;
	}
}
