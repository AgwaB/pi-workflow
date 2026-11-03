import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
import { acquireRunFileLease, isWorkflowRunLeaseLive, listRunRecords, readCompiledWorkflow, readRunRecord, workflowRunDir,
	writeJsonAtomicDurable } from "./store.js";
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
const MAX_RECEIPT_BYTES = 4 * 1024 * 1024;

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

interface RecoveryMarker {
	readonly schema: "goal-recovery-marker-v1";
	readonly state: "recovered";
	readonly recoveredRunId: string;
	readonly at: string;
}

async function readMarker(cwd: string, runId: string): Promise<RecoveryMarker | null> {
	try {
		const value = JSON.parse(await readFile(join(workflowRunDir(cwd, runId), MARKER), "utf8")) as RecoveryMarker;
		return value?.schema === "goal-recovery-marker-v1" && value.state === "recovered" &&
			typeof value.recoveredRunId === "string" ? value : null;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		// An unreadable marker is not authority; the successor's own record decides.
		return null;
	}
}

/**
 * The run that recovered this one, if any. The successor's run record (written
 * when it is created) is authoritative; the marker only speeds up the lookup
 * and survives a crash between the two writes in either order.
 */
export async function readWorkflowGoalRecoveredBy(cwd: string, runId: string,
	records?: readonly WorkflowRunRecord[]): Promise<string | null> {
	const successor = (records ?? await listRunRecords(cwd).catch(() => [] as WorkflowRunRecord[]))
		.find(record => record.goalRecovery?.fromRunId === runId);
	if (successor) return successor.runId;
	return (await readMarker(cwd, runId))?.recoveredRunId ?? null;
}

/**
 * Hold the interrupted run's recovery lease for the whole recover command, so
 * a second recovery (in this or another session) is refused while consent is
 * pending. The store lease reclaims the lease of a dead owner.
 */
export async function claimWorkflowGoalRecovery(cwd: string, runId: string): Promise<() => Promise<void>> {
	const lease = await acquireRunFileLease(cwd, runId, "goal-recovery", 0);
	if (!lease) throw new Error(`Goal run ${runId} is being recovered by another command; try again after it finishes`);
	return () => lease.release();
}

export async function completeWorkflowGoalRecovery(cwd: string, runId: string, recoveredRunId: string): Promise<void> {
	await writeJsonAtomicDurable(join(workflowRunDir(cwd, runId), MARKER), { schema: "goal-recovery-marker-v1",
		state: "recovered", recoveredRunId, at: new Date().toISOString() } satisfies RecoveryMarker);
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
	const criteria = policy.goal?.definition && "goal" in policy.goal.definition
		? policy.goal.definition.goal.criteria : [];
	const generations = root.goalRoot?.generations.length ?? 0;
	let latest: (OracleReceipt & { mtimeMs: number }) | null = null;
	for (const name of names.filter(value => /^[a-f0-9]{64}\.json$/.test(value)).sort()) {
		const path = join(directory, name);
		// Regular, bounded files only; anything else is not original evidence.
		const info = await lstat(path).catch(() => null);
		if (!info?.isFile() || info.size > MAX_RECEIPT_BYTES) continue;
		let receipt: { digest?: unknown; evidence?: Record<string, unknown> };
		try { receipt = JSON.parse(await readFile(path, "utf8")); } catch { continue; }
		const evidence = receipt?.evidence;
		// Only self-consistent receipts of a generation this run recorded, for
		// exactly the consented criteria, feed recovery.
		if (!evidence || receipt.digest !== name.slice(0, -5) || workflowDefinitionFingerprint(evidence) !== receipt.digest ||
			evidence.schema !== "goal-oracle-observation-v1" || evidence.runId !== run.runId ||
			evidence.definitionFingerprint !== policy.goal?.definitionFingerprint ||
			!Number.isSafeInteger(evidence.generation) || (evidence.generation as number) < 0 ||
			(evidence.generation as number) >= generations ||
			!Array.isArray(evidence.observations) || evidence.observations.length !== criteria.length ||
			(evidence.observations as Record<string, unknown>[]).some((observation, index) =>
				workflowDefinitionFingerprint(observation?.criterion ?? null) !== workflowDefinitionFingerprint(criteria[index])))
			continue;
		const generation = evidence.generation as number;
		// Within a generation (for example pending then decided human judgment)
		// the most recently written receipt is the last observation.
		if (!latest || generation > latest.generation || (generation === latest.generation && info.mtimeMs > latest.mtimeMs))
			latest = { generation, observations: evidence.observations as Record<string, unknown>[], mtimeMs: info.mtimeMs };
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
 * reason when the run cannot be recovered. Changes nothing durable (a free
 * supervisor lease may be taken and released to prove no owner holds it).
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
	// Only a run of a top-level Goal definition is recovered: an embedded Goal
	// stage would otherwise be relaunched without its surrounding workflow.
	if (!compiled || policies.length !== 1 || !policy?.goal || !root || policy.stageId !== "goal" ||
		typeof run.specPath !== "string" || resolve(run.specPath) !== resolve(policy.goal.usesPath))
		throw new Error("Goal recovery supports runs of a top-level Goal definition; recover workflows with an embedded Goal stage by running them again");
	if (root.goal?.state === "engine:achieved") throw new Error(`Goal run ${run.runId} already achieved its Goal`);
	// A paused or blocked run of this session may still hold work; it continues
	// with resume. A finished run (for example replanning exhausted) cannot
	// usefully resume and may be recovered as a new run.
	if (isLive(run.runId) && run.status !== "failed" && run.status !== "completed")
		throw new Error(`Goal run ${run.runId} is still live in this session; use /workflow goal resume ${run.runId}`);
	const records = await listRunRecords(cwd);
	const family = records.filter(record => record.runId === run.runId ||
		(record.rootRunId ?? record.runId) === run.runId);
	if (!family.some(record => record.runId === run.runId)) family.push(run);
	// The heartbeat check is conservative (a run finished seconds ago still
	// looks live); a supervisor lease that can actually be taken proves no
	// owner holds the run.
	for (const member of family) {
		if (!await isWorkflowRunLeaseLive(cwd, member.runId)) continue;
		const supervisor = await acquireRunFileLease(cwd, member.runId, "supervisor", 0);
		if (!supervisor)
			throw new Error(`Goal run ${member.runId} is still owned by a live session; recover it after that session ends`);
		await supervisor.release();
	}
	const recoveredBy = await readWorkflowGoalRecoveredBy(cwd, run.runId, records);
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
	// A named profile the definition declares is selected again; any other
	// (ad-hoc) profile is chosen afresh at the new launch.
	const recordedProfile = run.executionProfile?.name;
	const executionProfile = recordedProfile && definition.executionProfiles &&
		Object.hasOwn(definition.executionProfiles, recordedProfile) ? recordedProfile : undefined;
	return {
		specPath: usesPath,
		task: compiled.task ?? definition.goal.objective,
		...(executionProfile ? { executionProfile } : {}),
		plan: Object.freeze({
			schema: "goal-recovery-plan-v1" as const,
			fromRunId: run.runId,
			definitionFingerprint: policy.goal.definitionFingerprint,
			priorRequests,
			priorGenerations: (run.goalRecovery?.priorGenerations ?? 0) + (root.goalRoot?.generations.length ?? 0),
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
export function goalRecoveryPreview(plan: WorkflowGoalRecoveryPlan, requestCap: number | null | undefined,
	generationLimit?: number) {
	return {
		fromRunId: plan.fromRunId,
		priorRequests: plan.priorRequests,
		remainingRequests: requestCap == null ? null : Math.max(0, requestCap - plan.priorRequests),
		priorGenerations: plan.priorGenerations,
		...(generationLimit === undefined ? {} : { remainingGenerations: Math.max(0, generationLimit - plan.priorGenerations) }),
		feedbackGeneration: plan.feedbackGeneration,
		feedbackCriteria: plan.feedback.map(entry => `${entry.criterionId}: ${entry.verdict}`),
		carriedCandidate: plan.seed ? plan.seed.files.map(file => file.path) : [],
		...(plan.seedSkipped ? { candidateNotCarried: plan.seedSkipped } : {}),
	};
}
