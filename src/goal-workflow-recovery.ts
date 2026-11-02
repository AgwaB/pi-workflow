import { lstat, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { goalHash } from "./goal-json.js";
import { workflowDefinitionFingerprint } from "./execution-profile.js";
import { parseGoalWorkflowSpec } from "./goal-workflow-schema.js";
import { loadWorkflowSpec } from "./schema.js";
import { isGoalCommandVerification } from "./goal-command-verifier.js";
import { createHash } from "node:crypto";
import { observeGoalWorkspaceOrigin, type GoalWorkspaceHostHandle } from "./goal-workspace-host.js";
import {
	goalFileContentIdentity,
	parseGoalWorkspaceBaseline,
	parseGoalWorkspaceCandidate,
	type GoalOriginObservation,
	type GoalWorkspaceCandidate,
	type GoalWorkspacePath,
} from "./goal-workspace.js";
import { isWorkflowRunLeaseLive, listRunRecords, readCompiledWorkflow, readRunRecord, workflowRunDir } from "./store.js";
import type { CompiledTask, GoalWorkflowSpec, WorkflowRunRecord } from "./types.js";

/**
 * Cold recovery of an ordinary Goal run whose Pi session ended. A recovery is
 * a new run of the same consented definition: it is shown at a fresh consent,
 * counts every request the interrupted run family may have sent against the
 * request cap, passes the last original oracle feedback to the planner as
 * untrusted data, and may start from the last host-observed candidate when the
 * origin is exactly as that candidate saw it. The interrupted run is never
 * resumed or rewritten; only a recovery marker is added next to it.
 */

const FEEDBACK_TEXT_LIMIT = 4_096;
const FEEDBACK_TOTAL_LIMIT = 16_384;
const MARKER = "goal-recovery.json";

export interface WorkflowGoalRecoveryFeedback {
	readonly criterionId: string;
	readonly verdict: string;
	readonly reason: string | null;
	readonly detail?: unknown;
}

export interface WorkflowGoalRecoverySeed {
	readonly generation: number;
	readonly workspaceId: string;
	readonly baselineHash: string;
	/** Scope paths whose candidate bytes differ from the current origin. */
	readonly files: readonly GoalWorkspacePath[];
}

export interface WorkflowGoalRecoveryPlan {
	readonly schema: "goal-recovery-plan-v1";
	readonly fromRunId: string;
	readonly definitionFingerprint: string;
	/** Conservative: every request reservation of the interrupted family (and its own recoveries). */
	readonly priorRequests: number;
	readonly priorGenerations: number;
	readonly feedbackGeneration: number | null;
	readonly feedback: readonly WorkflowGoalRecoveryFeedback[];
	readonly seed: WorkflowGoalRecoverySeed | null;
	/** Why the last candidate is not carried over, when one existed. */
	readonly seedSkipped: string | null;
}

/** Persisted on the recovered run. */
export interface WorkflowGoalRecoveryRecord {
	readonly fromRunId: string;
	readonly priorRequests: number;
	readonly feedbackGeneration: number | null;
	readonly seededPaths: readonly string[];
}

export interface WorkflowGoalRecoveryLaunch {
	readonly specPath: string;
	readonly task: string;
	readonly executionProfile?: string;
	readonly plan: WorkflowGoalRecoveryPlan;
}

type RecoveryMarker =
	| { schema: "goal-recovery-marker-v1"; state: "claimed"; pid: number; at: string }
	| { schema: "goal-recovery-marker-v1"; state: "recovered"; recoveredRunId: string; at: string };

function isProcessAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function readMarker(cwd: string, runId: string): Promise<RecoveryMarker | null> {
	try {
		const value = JSON.parse(await readFile(join(workflowRunDir(cwd, runId), MARKER), "utf8")) as RecoveryMarker;
		return value?.schema === "goal-recovery-marker-v1" ? value : null;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

/** The run that recovered this one, if any. */
export async function readWorkflowGoalRecoveredBy(cwd: string, runId: string): Promise<string | null> {
	const marker = await readMarker(cwd, runId).catch(() => null);
	return marker?.state === "recovered" ? marker.recoveredRunId : null;
}

/**
 * Exclusively claim recovery of a run so two sessions cannot recover it at
 * once. A stale claim of a dead process is replaced.
 */
export async function claimWorkflowGoalRecovery(cwd: string, runId: string): Promise<() => Promise<void>> {
	const file = join(workflowRunDir(cwd, runId), MARKER);
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
			try {
				await handle.writeFile(JSON.stringify({ schema: "goal-recovery-marker-v1", state: "claimed",
					pid: process.pid, at: new Date().toISOString() } satisfies RecoveryMarker));
				await handle.sync();
			} finally { await handle.close(); }
			return async () => {
				const current = await readMarker(cwd, runId).catch(() => null);
				if (current?.state === "claimed" && current.pid === process.pid) await rm(file, { force: true });
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const existing = await readMarker(cwd, runId);
			if (existing?.state === "recovered")
				throw new Error(`Goal run ${runId} was already recovered as ${existing.recoveredRunId}; recover that run instead`);
			if (existing?.state === "claimed" && existing.pid !== process.pid && isProcessAlive(existing.pid))
				throw new Error(`Goal run ${runId} is being recovered by another session (pid ${existing.pid})`);
			await rm(file, { force: true });
		}
	}
	throw new Error(`Goal recovery claim for ${runId} could not be created`);
}

export async function completeWorkflowGoalRecovery(cwd: string, runId: string, recoveredRunId: string): Promise<void> {
	await writeFile(join(workflowRunDir(cwd, runId), MARKER), JSON.stringify({ schema: "goal-recovery-marker-v1",
		state: "recovered", recoveredRunId, at: new Date().toISOString() } satisfies RecoveryMarker));
}

async function countRequestReservations(cwd: string, runId: string): Promise<number> {
	const tasksDir = join(workflowRunDir(cwd, runId), "tasks");
	let count = 0;
	const tasks = await readdir(tasksDir).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return [] as string[];
		throw error;
	});
	for (const task of tasks) {
		const names = await readdir(join(tasksDir, task, "artifacts", "request-reservations")).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT" || error.code === "ENOTDIR") return [] as string[];
			throw error;
		});
		count += names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).length;
	}
	return count;
}

function bounded(text: unknown, limit = FEEDBACK_TEXT_LIMIT): string | undefined {
	if (typeof text !== "string") return undefined;
	return text.length > limit ? `…${text.slice(text.length - limit)}` : text;
}

function feedbackDetail(observation: Record<string, unknown>): unknown {
	const verification = observation.verification;
	if (isGoalCommandVerification(verification))
		return { exitCode: verification.exitCode, signal: verification.signal, timedOut: verification.timedOut,
			stdoutTail: bounded(verification.stdoutTail), stderrTail: bounded(verification.stderrTail, 2_048) };
	const control = (verification as { control?: Record<string, unknown> } | undefined)?.control;
	if (control && typeof control === "object")
		return { score: control.score, reason: bounded(control.reason) };
	return undefined;
}

interface OracleReceipt {
	readonly generation: number;
	readonly observations: readonly Record<string, unknown>[];
}

async function latestOracleReceipt(cwd: string, run: WorkflowRunRecord, root: WorkflowRunRecord["tasks"][number],
	policy: CompiledTask): Promise<OracleReceipt | null> {
	const resultFile = root.files?.result;
	if (typeof resultFile !== "string") return null;
	const directory = join(cwd, dirname(resultFile), "goal-evidence");
	const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return [] as string[];
		throw error;
	});
	let latest: OracleReceipt | null = null;
	for (const name of names.filter(value => /^[a-f0-9]{64}\.json$/.test(value)).sort()) {
		const receipt = JSON.parse(await readFile(join(directory, name), "utf8")) as { digest?: unknown; evidence?: Record<string, unknown> };
		const evidence = receipt.evidence;
		// Only original, self-consistent receipts of this run and definition feed recovery.
		if (!evidence || receipt.digest !== name.slice(0, -5) || workflowDefinitionFingerprint(evidence) !== receipt.digest ||
			evidence.schema !== "goal-oracle-observation-v1" || evidence.runId !== run.runId ||
			evidence.definitionFingerprint !== policy.goal?.definitionFingerprint ||
			!Number.isSafeInteger(evidence.generation) || !Array.isArray(evidence.observations))
			continue;
		const generation = evidence.generation as number;
		if (!latest || generation > latest.generation)
			latest = { generation, observations: evidence.observations as Record<string, unknown>[] };
	}
	return latest;
}

function receiptCandidate(receipt: OracleReceipt): GoalWorkspaceCandidate | null {
	for (const observation of receipt.observations) {
		const sources = Array.isArray(observation.sources) ? observation.sources as Record<string, unknown>[] : [];
		for (const source of sources) {
			const identity = source.identity as Record<string, unknown> | undefined;
			const control = source.control as Record<string, unknown> | undefined;
			if (identity?.kind !== "host-candidate-snapshot" || control?.schema !== "goal-candidate-evidence-v1") continue;
			try { return parseGoalWorkspaceCandidate(control.candidate); } catch { return null; }
		}
	}
	return null;
}

async function observeRecoveryOrigin(cwd: string, definition: GoalWorkflowSpec): Promise<GoalOriginObservation> {
	const authority = definition.goal.authority;
	const repository = await lstat(join(cwd, ".git")).then(() => "git" as const, (error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
		return "nonGit" as const;
	});
	const controlRoots = await lstat(join(cwd, ".pi")).then(() => [join(cwd, ".pi")], (error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
		return [];
	});
	return observeGoalWorkspaceOrigin({ originRoot: cwd, repository,
		scope: [...authority.allowedPaths].sort(), protectedPaths: [...authority.protectedPaths].sort(), controlRoots });
}

/** Rebuild the interrupted candidate's baseline over the given origin observation. */
export function goalRecoveryBaselineHash(definition: GoalWorkflowSpec, workspaceId: string,
	origin: GoalOriginObservation): string {
	const scope = [...definition.goal.authority.allowedPaths].sort();
	return goalHash(parseGoalWorkspaceBaseline({ schemaVersion: 1, workspaceId, mode: "mutation", scope,
		protectedPaths: [...definition.goal.authority.protectedPaths].sort(), inputManifest: scope, origin }));
}

async function recoverySeed(cwd: string, definition: GoalWorkflowSpec, generation: number,
	candidate: GoalWorkspaceCandidate | null): Promise<{ seed: WorkflowGoalRecoverySeed | null; skipped: string | null }> {
	if (!candidate) return { seed: null, skipped: null };
	if (!definition.goal.authority.allowedEffects.includes("candidate-write"))
		return { seed: null, skipped: null };
	const origin = await observeRecoveryOrigin(cwd, definition);
	if (goalRecoveryBaselineHash(definition, candidate.workspaceId, origin) !== candidate.baselineHash)
		return { seed: null, skipped: "the origin changed since the interrupted candidate was observed" };
	const changed = candidate.files.filter(file => {
		const originFile = origin.files.find(entry => entry.path === file.path);
		return goalHash(goalFileContentIdentity(file.value)) !== goalHash(goalFileContentIdentity(originFile?.worktree ?? null));
	});
	if (!changed.length) return { seed: null, skipped: null };
	if (changed.some(file => file.value === null))
		return { seed: null, skipped: "the interrupted candidate removed a file, which cannot be carried over" };
	if (changed.some(file => file.value?.kind !== "file"))
		return { seed: null, skipped: "a changed candidate file is too large to carry over" };
	// Candidate writes keep the origin mode (new files are 0644).
	if (changed.some(file => file.value!.mode !==
		(origin.files.find(entry => entry.path === file.path)?.worktree?.mode ?? "0644")))
		return { seed: null, skipped: "a candidate file mode change cannot be carried over" };
	return { seed: { generation, workspaceId: candidate.workspaceId, baselineHash: candidate.baselineHash, files: changed },
		skipped: null };
}

/**
 * Inspect an interrupted root Goal run and plan its recovery. Throws with the
 * reason when the run cannot be recovered. Reads only; claims nothing.
 */
export async function planWorkflowGoalRecovery(cwd: string, runIdOrPrefix: string,
	isLive: (runId: string) => boolean): Promise<WorkflowGoalRecoveryLaunch> {
	const run = await readRunRecord(cwd, runIdOrPrefix);
	if (run.parentRunId || run.goalChild)
		throw new Error("Goal recovery applies to a root Goal run; recover its root run instead");
	if (!run.goalParticipation) throw new Error(`Run ${run.runId} is not an ordinary Goal run`);
	const compiled = await readCompiledWorkflow(cwd, run.runId);
	const policies = compiled?.tasks.filter(task => task.kind === "goal") ?? [];
	const policy = policies[0];
	const root = policy && run.tasks.find(task => task.specId === policy.id);
	if (!compiled || policies.length !== 1 || !policy?.goal || !root)
		throw new Error("Goal recovery supports a single top-level Goal definition run");
	if (root.goal?.state === "engine:achieved") throw new Error(`Goal run ${run.runId} already achieved its Goal`);
	if (isLive(run.runId))
		throw new Error(`Goal run ${run.runId} is still live in this session; use /workflow goal resume ${run.runId}`);
	const family = (await listRunRecords(cwd)).filter(record => record.runId === run.runId ||
		(record.rootRunId ?? record.runId) === run.runId);
	if (!family.some(record => record.runId === run.runId)) family.push(run);
	for (const member of family)
		if (await isWorkflowRunLeaseLive(cwd, member.runId))
			throw new Error(`Goal run ${member.runId} is still owned by a live session; recover it after that session ends`);
	const recoveredBy = await readWorkflowGoalRecoveredBy(cwd, run.runId);
	if (recoveredBy) throw new Error(`Goal run ${run.runId} was already recovered as ${recoveredBy}; recover that run instead`);

	// The current definition must be exactly the one originally consented to.
	const usesPath = policy.goal.usesPath;
	let definition: GoalWorkflowSpec;
	try {
		const loaded = (await loadWorkflowSpec(usesPath, cwd)).spec;
		if (!("goal" in loaded)) throw new Error("not a Goal definition");
		definition = parseGoalWorkflowSpec(loaded);
	} catch (error) {
		throw new Error(`Goal recovery cannot read the original definition ${usesPath}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (workflowDefinitionFingerprint(definition) !== policy.goal.definitionFingerprint)
		throw new Error(`Goal definition ${usesPath} changed since run ${run.runId}; start it fresh with /workflow goal run`);

	let priorRequests = run.goalRecovery?.priorRequests ?? 0;
	for (const member of family) priorRequests += await countRequestReservations(cwd, member.runId);

	const receipt = await latestOracleReceipt(cwd, run, root, policy);
	const feedback: WorkflowGoalRecoveryFeedback[] = [];
	if (receipt) {
		let total = 0;
		for (const observation of receipt.observations) {
			const criterion = observation.criterion as { id?: unknown } | undefined;
			const entry: WorkflowGoalRecoveryFeedback = {
				criterionId: typeof criterion?.id === "string" ? criterion.id : "unknown",
				verdict: typeof observation.verdict === "string" ? observation.verdict : "unknown",
				reason: typeof observation.reason === "string" ? bounded(observation.reason)! : null,
				...(feedbackDetail(observation) === undefined ? {} : { detail: feedbackDetail(observation) }),
			};
			total += JSON.stringify(entry).length;
			if (total > FEEDBACK_TOTAL_LIMIT) break;
			feedback.push(entry);
		}
	}
	const { seed, skipped } = receipt
		? await recoverySeed(cwd, definition, receipt.generation, receiptCandidate(receipt))
		: { seed: null, skipped: null };
	const executionProfile = run.executionProfile?.name;
	return {
		specPath: usesPath,
		task: compiled.task ?? definition.goal.objective,
		...(executionProfile ? { executionProfile } : {}),
		plan: Object.freeze({
			schema: "goal-recovery-plan-v1" as const,
			fromRunId: run.runId,
			definitionFingerprint: policy.goal.definitionFingerprint,
			priorRequests,
			priorGenerations: root.goalRoot?.generations.length ?? 0,
			feedbackGeneration: receipt?.generation ?? null,
			feedback,
			seed,
			seedSkipped: skipped,
		}),
	};
}

/**
 * Re-check, against the new run's actual workspace baseline, that the seed
 * still matches the origin it was observed on. Returns the files to write.
 */
export function assertGoalRecoverySeedCurrent(definition: GoalWorkflowSpec, seed: WorkflowGoalRecoverySeed,
	origin: GoalOriginObservation): readonly GoalWorkspacePath[] {
	if (goalRecoveryBaselineHash(definition, seed.workspaceId, origin) !== seed.baselineHash)
		throw new Error("Goal recovery candidate no longer matches the origin; the origin changed after consent");
	return seed.files;
}

/**
 * Write the recovery seed into a fresh candidate workspace through its normal
 * guarded replacement operations, then confirm the exact bytes landed.
 */
export async function seedWorkflowGoalRecoveryCandidate(workspace: GoalWorkspaceHostHandle,
	definition: GoalWorkflowSpec, plan: WorkflowGoalRecoveryPlan): Promise<readonly string[]> {
	if (!plan.seed) return [];
	const files = assertGoalRecoverySeedCurrent(definition, plan.seed, workspace.baseline.origin);
	const attemptKey = `goal-recovery-seed:${plan.fromRunId}`;
	for (const [index, file] of files.entries()) {
		if (file.value?.kind !== "file") throw new Error("Goal recovery seed holds a non-inline file");
		const current = (await workspace.inspectCandidate()).files.find(entry => entry.path === file.path);
		if (current === undefined) throw new Error(`Goal recovery seed path is outside the scope: ${file.path}`);
		const bytes = Buffer.from(file.value.hex, "hex");
		const begun = await workspace.beginCandidateReplacement({ path: file.path, expectedDigest: goalHash(current.value),
			attemptKey, operationId: `seed-${index}-begin`, bytes: bytes.length,
			sha256: createHash("sha256").update(bytes).digest("hex") });
		if (bytes.length)
			await workspace.appendCandidateReplacement({ path: file.path, uploadId: begun.uploadId, attemptKey,
				operationId: `seed-${index}-append`, offset: 0, hex: file.value.hex });
		await workspace.commitCandidateReplacement({ path: file.path, uploadId: begun.uploadId, attemptKey,
			operationId: `seed-${index}-commit` });
	}
	const seeded = await workspace.inspectCandidate();
	for (const file of files) {
		const value = seeded.files.find(entry => entry.path === file.path)?.value ?? null;
		if (goalHash(goalFileContentIdentity(value)) !== goalHash(goalFileContentIdentity(file.value)))
			throw new Error(`Goal recovery seed did not reproduce the interrupted candidate: ${file.path}`);
	}
	return files.map(file => file.path);
}

/** Consent and status view of a recovery plan. */
export function goalRecoveryPreview(plan: WorkflowGoalRecoveryPlan, requestCap: number | null | undefined) {
	return {
		fromRunId: plan.fromRunId,
		priorRequests: plan.priorRequests,
		remainingRequests: requestCap == null ? null : Math.max(0, requestCap - plan.priorRequests),
		priorGenerations: plan.priorGenerations,
		feedbackGeneration: plan.feedbackGeneration,
		feedbackCriteria: plan.feedback.map(entry => `${entry.criterionId}: ${entry.verdict}`),
		carriedCandidate: plan.seed ? plan.seed.files.map(file => file.path) : [],
		...(plan.seedSkipped ? { candidateNotCarried: plan.seedSkipped } : {}),
	};
}
