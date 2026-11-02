import { constants, type Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
	acquireRunFileLease,
	acquireWorkflowTopologyLease,
	deriveRunStatus,
	isSafeRunId,
	isTerminalWorkflowStatus,
	isWorkflowRunLeaseLive,
	TERMINAL_INDEX_LIMIT,
	updateIndex,
	workflowsRoot,
} from "./store.js";
import {
	GoalStore,
	assertGoalHostEffectsDrained,
	goalAdmittedChildReferences,
} from "./goal-store.js";
import { goalHash } from "./goal-contract.js";
import { canonicalWorkflowLaunchAuthorityBytes } from "./launch-authority.js";
import { readWorkflowDurableLaunchBarrierState } from "./subagent-backend.js";
import { workflowDefinitionFingerprint } from "./execution-profile.js";
import { parseGoalWorkflowSpec } from "./goal-workflow-schema.js";
import { parseArtifactGraphWorkflowSpec } from "./artifact-graph-schema.js";
import { lowerArtifactGraphPrompt } from "./compiler.js";
import { readSimpleJsonPath } from "./workflow-runtime.js";
import { hashDynamicRequest, parseDynamicEventsText } from "./dynamic-events.js";
import { readDynamicState } from "./dynamic-state.js";
import { establishRawOwner, checkRawLinks, recheckRawOwner, sameRawVersion, hashRawDescriptor, type RawOwner } from "./workflow-raw-contract.js";
import {
	completeGoalRetentionClosure,
	hasCurrentGoalHostWriteLease,
	publishGoalRetentionClosure,
	readGoalRetentionClosure,
	withGoalHostWriteLocks,
} from "./goal-host-write-lock.js";
import type { WorkflowRunRecord, WorkflowRunStatus } from "./types.js";

export interface WorkflowPruneOptions {
	keep?: number;
	olderThanDays?: number;
	yes?: boolean;
	/**
	 * Reserved for an explicit, atomically retained Goal-family closure.
	 * Ordinary run pruning never removes current Goal stores.
	 */
	terminalGoalFamilyRoots?: string[];
	/** Exact ordinary Goal closure root with checked standalone Goal descendants; never a private Goal ID. */
	terminalWorkflowGoalRoot?: string;
}

export interface WorkflowPruneRun {
	runId: string;
	name?: string;
	status: WorkflowRunStatus;
	updatedAt: string;
	bytes: number;
	selected: boolean;
	protected: boolean;
	deleted: boolean;
	/** Canonical identity removed, even if recovery evidence is retained. */
	detached?: boolean;
	purged?: boolean;
	retainedEvidencePath?: string;
	retainedMirrorPath?: string;
	error?: string;
}

export interface WorkflowPruneSummary {
	dryRun: boolean;
	keep: number;
	olderThanDays?: number;
	runs: WorkflowPruneRun[];
	totalBytes: number;
	deletedBytes: number;
	indexUpdated: boolean;
	error?: string;
}

interface Candidate {
	run: WorkflowRunRecord;
	runDir: string;
	mirrorDir: string;
	bytes: number;
	identity: { dev: number; ino: number };
}

let beforeDeleteForTests: (() => void | Promise<void>) | undefined;
let afterQuarantineForTests: (() => void | Promise<void>) | undefined;
let beforePrimaryDetachForTests: (() => void | Promise<void>) | undefined;
let beforeGoalRetentionDetachCommitForTests: (() => void | Promise<void>) | undefined;
let afterGoalRetentionDetachCommitForTests: (() => void | Promise<void>) | undefined;
export function setWorkflowPruneBeforePrimaryDetachForTests(hook?: () => void | Promise<void>): void {
	beforePrimaryDetachForTests = hook;
}
export function setWorkflowPruneAfterQuarantineForTests(hook?: () => void | Promise<void>): void {
	afterQuarantineForTests = hook;
}
export function setWorkflowPruneBeforeDeleteForTests(hook?: () => void | Promise<void>): void {
	beforeDeleteForTests = hook;
}
export function setGoalRetentionAfterDetachCommitForTests(
	hook?: () => void | Promise<void>,
): void {
	afterGoalRetentionDetachCommitForTests = hook;
}
export function setGoalRetentionBeforeDetachCommitForTests(
	hook?: () => void | Promise<void>,
): void {
	beforeGoalRetentionDetachCommitForTests = hook;
}

export async function pruneWorkflowRuns(
	cwd: string,
	options: WorkflowPruneOptions = {},
): Promise<WorkflowPruneSummary> {
	cwd = await realpath(resolve(cwd));
	const keep = normalizeNonNegativeInteger(options.keep, TERMINAL_INDEX_LIMIT);
	const olderThanDays = options.olderThanDays;
	if (options.terminalWorkflowGoalRoot !== undefined) {
		if (!isSafeRunId(options.terminalWorkflowGoalRoot))
			throw new Error("terminalWorkflowGoalRoot requires an exact safe workflow run ID");
		if (options.terminalGoalFamilyRoots !== undefined || options.keep !== undefined || olderThanDays !== undefined)
			throw new Error("ordinary Goal selector cannot mix private Goal selectors or retention filters");
	}
	if (
		options.terminalGoalFamilyRoots !== undefined &&
		(!Array.isArray(options.terminalGoalFamilyRoots) ||
			!options.terminalGoalFamilyRoots.every(isSafeRunId))
	)
		throw new Error("terminalGoalFamilyRoots requires Goal root IDs");
	if (options.terminalGoalFamilyRoots?.length && !options.yes)
		throw new Error("terminal Goal-family pruning requires explicit yes");
	if (olderThanDays !== undefined && (!Number.isFinite(olderThanDays) || olderThanDays < 0))
		throw new Error("--older-than requires a non-negative number of days");

	// No topology lock (or any filesystem writes) for a preview.
	if (!options.yes) return prunePlan(cwd, options, keep, olderThanDays);
	if (!(await physicalRetentionRoot(workflowsRoot(cwd)).catch(() => undefined)))
		return prunePlan(cwd, options, keep, olderThanDays);
	const topology = await acquireWorkflowTopologyLease(cwd);
	if (!topology) return { dryRun: false, keep, olderThanDays, runs: [], totalBytes: 0, deletedBytes: 0, indexUpdated: false, error: "workflow topology lease unavailable" };
	try {
		if (options.terminalGoalFamilyRoots?.length)
			return await pruneTerminalGoalFamilies(
				cwd,
				options,
				keep,
				olderThanDays,
				topology.assertOwner,
			);
		return await prunePlan(cwd, options, keep, olderThanDays, topology.assertOwner);
	} finally {
		await topology.release();
	}
}

interface RetentionPlan {
	candidates: Candidate[];
	children: Map<string, Set<string>>;
	goalChildren: Map<string, Set<string>>;
	currentGoalReferences: Map<string, Set<string>>;
	ordinaryGoalEvidence: Set<string>;
	uncertain: boolean;
}
type GoalParents = Map<string, Map<string, Set<string>>>;

interface OrdinaryGoalFamilySelection {
	candidates: Candidate[];
	context: OrdinaryGoalFamilyContext;
}

async function selectOrdinaryGoalFamily(
	candidate: Candidate,
	plan: RetentionPlan,
): Promise<OrdinaryGoalFamilySelection> {
	const root = candidate.run;
	if (root.parentRunId !== undefined || (root.rootRunId !== undefined && root.rootRunId !== root.runId) ||
		Object.hasOwn(root, "goalChild") || root.status !== "completed")
		throw new Error("ordinary Goal selector requires a standalone completed root");
	const policyTasks = root.tasks.filter((task) => task.goalRoot !== undefined || task.goal !== undefined);
	if (policyTasks.length !== 1 || policyTasks[0].kind !== "goal")
		throw new Error("ordinary Goal selector requires one Goal policy root");
	const candidates = new Map(plan.candidates.map((value) => [value.run.runId, value]));
	const members = new Map<string, Candidate>([[root.runId, candidate]]);
	// Newly admitted members extend this parent-before-child census. Repeated
	// identities (including cycles or shared children) are never reconsidered.
	for (const parent of members.values()) {
		const parentPolicies = parent.run.tasks.filter(task => task.goalRoot !== undefined || task.goal !== undefined);
		if (parentPolicies.length !== 1 || parentPolicies[0].kind !== "goal")
			throw new Error("ordinary Goal family member lacks one original Goal policy");
		const generations = evidenceObject(parentPolicies[0].goalRoot).generations;
		if (!Array.isArray(generations) || generations.length === 0)
			throw new Error("ordinary Goal member has no complete generation lineage");
		for (const generationValue of generations) {
		const generation = evidenceObject(generationValue);
		const slots = evidenceObject(generation.slots);
		const children = generation.children === undefined ? {} : evidenceObject(generation.children);
		for (const [slot, childValue] of Object.entries(children)) {
			const child = evidenceObject(childValue);
			const childId = slots[slot];
			if (typeof childId !== "string" || child.runId !== childId || !isSafeRunId(childId) ||
				typeof child.workflowId !== "string" || typeof child.specHash !== "string" ||
				typeof child.requestHash !== "string")
				throw new Error("ordinary Goal child lineage does not join its parent generation");
			const childCandidate = candidates.get(childId);
			if (!childCandidate || childCandidate.run.parentRunId !== parent.run.runId ||
				childCandidate.run.rootRunId !== root.runId)
				throw new Error("ordinary Goal child run lineage is absent or foreign");
			const marker = evidenceObject(childCandidate.run.goalChild);
			for (const [key, expected] of Object.entries({
				parentRunId: parent.run.runId,
				policySpecId: parentPolicies[0].specId,
				generation: generation.generation,
				slot,
				runId: childId,
				workflowId: child.workflowId,
				specHash: child.specHash,
				requestHash: child.requestHash,
			})) {
				if (marker[key] !== expected) throw new Error("ordinary Goal child marker does not match parent lineage");
			}
			if (marker.controllerTaskId !== parentPolicies[0].taskId ||
				marker.controllerSpecId !== generation.workerControllerSpecId ||
				!["standalone-goal", "artifact-graph"].includes(String(marker.definitionKind)) ||
				typeof marker.sourceHash !== "string" || typeof marker.definitionFingerprint !== "string")
				throw new Error("ordinary Goal child controller identity mismatch");
			if (members.has(childId)) throw new Error("ordinary Goal lineage reuses a child run");
			members.set(childId, childCandidate);
		}
		}
	}
	for (const value of plan.candidates) {
		const run = value.run;
		if (run.runId === root.runId) continue;
		if ((run.parentRunId && members.has(run.parentRunId)) || run.rootRunId === root.runId ||
			(run.goalChild && members.has(String(evidenceObject(run.goalChild).parentRunId)))) {
			if (!members.has(run.runId)) throw new Error("ordinary Goal family has an external child reference");
		}
	}
	if (members.size === 1) throw new Error("ordinary Goal family has no child generation");
	const requests = evidenceObject(evidenceObject(policyTasks[0].goal).usage).requests;
	if (typeof requests !== "number" || !Number.isSafeInteger(requests) || requests < 0)
		throw new Error("ordinary Goal root request snapshot is unavailable");
	return {
		candidates: [...members.values()],
		context: {
			rootRunId: root.runId,
			memberRunIds: new Set(members.keys()),
			members,
			requests,
			requestsSeen: { value: 0 },
			requestIds: new Set(),
			candidateIds: new Set(),
			ownedQuarantines: new Set(),
			ownedPrimary: new Map(),
			ownedMirror: new Map(),
			definitions: new Map(),
			policyPaths: new Map(),
			ordinaryPrefixes: new Map(),
			remainingDepth: new Map(),
			observedUsage: new Map(),
			taskRequestCounts: new Map(),
			childOrder: new Map(),
		},
	};
}

async function prunePlan(
	cwd: string, options: WorkflowPruneOptions, keep: number, olderThanDays?: number,
	assertTopologyOwner?: () => Promise<void>,
): Promise<WorkflowPruneSummary> {
	const plan = await findRetentionPlan(cwd);
	if (options.terminalWorkflowGoalRoot !== undefined) {
		const selected = plan.candidates.find((value) => value.run.runId === options.terminalWorkflowGoalRoot);
		const hasChildren = selected?.run.tasks.some((task) => {
			const lineage = task.goalRoot as { generations?: Array<{ children?: Record<string, unknown> }> } | undefined;
			return lineage?.generations?.some((generation) => Object.keys(generation.children ?? {}).length) ?? false;
		});
		if (hasChildren)
			return pruneOrdinaryGoalFamily(cwd, options, keep, olderThanDays, plan, assertTopologyOwner);
	}
	const candidates = plan.candidates;
	candidates.sort((left, right) => Date.parse(right.run.updatedAt) - Date.parse(left.run.updatedAt));
	const cutoff = olderThanDays === undefined ? undefined : Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
	const summaryRuns: WorkflowPruneRun[] = [];
	const detachedRunIds: string[] = [];
	const purgedRunIds = new Set<string>();
	const selected = candidates.filter((candidate, index) => index >= keep &&
		(cutoff === undefined || Date.parse(candidate.run.updatedAt) < cutoff));
	if (options.terminalWorkflowGoalRoot !== undefined) {
		selected.splice(0, selected.length, ...candidates.filter(candidate =>
			candidate.run.runId === options.terminalWorkflowGoalRoot));
		if (selected.length !== 1) return {
			dryRun: !options.yes, keep, runs: [], totalBytes: 0, deletedBytes: 0, indexUpdated: false,
			error: `ordinary Goal root ${options.terminalWorkflowGoalRoot} is absent, nonterminal, or unreadable`,
		};
	}
	const selectedRunIds = new Set(selected.map((candidate) => candidate.run.runId));

	for (const candidate of childrenFirst(selected, plan.children, plan.goalChildren)) {
		const entry: WorkflowPruneRun = {
			runId: candidate.run.runId,
			...(candidate.run.name === undefined ? {} : { name: candidate.run.name }),
			status: candidate.run.status,
			updatedAt: candidate.run.updatedAt,
			bytes: candidate.bytes,
			selected: true,
			protected: false,
			deleted: false,
		};
		let closureSnapshot: string | undefined;
		const closureCustody: OrdinaryClosureCustody = { owners: new Map(), census: new Map() };
		if (options.terminalWorkflowGoalRoot !== undefined) {
			try {
				if ((await readdir(join(cwd, ".pi", "workflow-subagents")).catch((error: NodeJS.ErrnoException) => {
					if (error.code === "ENOENT") return [];
					throw error;
				})).some(name => name.startsWith(".prune-"))) throw new Error("mirror recovery residue");
				closureSnapshot = await isolatedOrdinaryGoalSnapshot(cwd, candidate, plan, closureCustody);
			} catch (error) {
				entry.protected = true;
				entry.error = `ordinary Goal closure refused: ${errorMessage(error)}`;
				summaryRuns.push(entry);
				continue;
			}
		}
		const referenceError = await retainedChildReason(
			cwd,
			candidate.run.runId,
			plan,
			purgedRunIds,
			selectedRunIds,
			!options.yes,
			closureSnapshot !== undefined,
		);
		if (referenceError) {
			entry.protected = true;
			entry.error = referenceError;
			summaryRuns.push(entry);
			continue;
		}
		if (await isWorkflowRunLeaseLive(cwd, candidate.run.runId)) {
			entry.protected = true;
			entry.error = "live or indeterminate supervisor lease";
			summaryRuns.push(entry);
			continue;
		}
		if (!options.yes) {
			summaryRuns.push(entry);
			continue;
		}
		await beforeDeleteForTests?.();
		const deletion = await deleteCandidate(cwd, candidate, async (pendingQuarantine, mirror) => {
			await assertTopologyOwner?.();
			// Selection is not a marker snapshot: re-read the reference graph at
			// every existing detach fence, including newly protected relatives.
			const currentPlan = await findRetentionPlan(cwd, pendingQuarantine);
			if (closureSnapshot !== undefined) {
				try {
					if (await isolatedOrdinaryGoalSnapshot(cwd, candidate, currentPlan, closureCustody, pendingQuarantine, mirror) !== closureSnapshot)
						return "ordinary Goal closure evidence changed since selection";
				} catch (error) { return `ordinary Goal closure refused: ${errorMessage(error)}`; }
			}
			return await retainedChildReason(cwd, candidate.run.runId, currentPlan, purgedRunIds, selectedRunIds, false, closureSnapshot !== undefined) ??
				await retainedChildReason(cwd, candidate.run.runId, plan, purgedRunIds, selectedRunIds, false, closureSnapshot !== undefined);
		});
		Object.assign(entry, deletion);
		if (deletion.detached) detachedRunIds.push(candidate.run.runId);
		if (deletion.purged) purgedRunIds.add(candidate.run.runId);
		summaryRuns.push(entry);
	}

	let indexUpdated = false;
	const failures = summaryRuns.filter((run) => !run.protected && run.error);
	let error = failures.length > 0 ? `${failures.length} selected run(s) failed to purge` : undefined;
	if (options.terminalWorkflowGoalRoot !== undefined && summaryRuns.some(run => run.error))
		error ??= summaryRuns.find(run => run.error)?.error;
	if (options.yes && detachedRunIds.length > 0) {
		try {
			await updateIndex(cwd);
			indexUpdated = true;
		} catch (indexError) {
			error = `${error ? `${error}; ` : ""}index update failed: ${errorMessage(indexError)}`;
		}
	}
	return {
		dryRun: !options.yes,
		keep,
		...(olderThanDays === undefined ? {} : { olderThanDays }),
		runs: summaryRuns,
		totalBytes: summaryRuns.reduce((total, run) => total + (run.protected ? 0 : run.bytes), 0),
		deletedBytes: summaryRuns.reduce((total, run) => total + (run.deleted ? run.bytes : 0), 0),
		indexUpdated,
		...(error === undefined ? {} : { error }),
	};
}

async function pruneOrdinaryGoalFamily(
	cwd: string,
	options: WorkflowPruneOptions,
	keep: number,
	olderThanDays: number | undefined,
	plan: RetentionPlan,
	assertTopologyOwner?: () => Promise<void>,
): Promise<WorkflowPruneSummary> {
	const candidate = plan.candidates.find((value) => value.run.runId === options.terminalWorkflowGoalRoot);
	if (!candidate)
		return { ...goalFamilyRefusal(keep, olderThanDays, `ordinary Goal root ${options.terminalWorkflowGoalRoot} is absent, nonterminal, or unreadable`), dryRun: !options.yes };
	let selection: OrdinaryGoalFamilySelection;
	try { selection = await selectOrdinaryGoalFamily(candidate, plan); }
	catch (error) { return { ...goalFamilyRefusal(keep, olderThanDays, errorMessage(error)), dryRun: !options.yes }; }
	const custody = new Map<string, OrdinaryClosureCustody>();
	for (const member of selection.candidates)
		custody.set(member.run.runId, { owners: new Map(), census: new Map() });
	let rows: WorkflowPruneRun[] = [];
	let indexUpdated = false;
	let deletedBytes = 0;
	const snapshots = async (targetRunId?: string, pending?: string, mirror?: Quarantine): Promise<string> => {
		selection.context.requestsSeen.value = 0;
		selection.context.requestIds.clear();
		selection.context.candidateIds.clear();
		selection.context.definitions.clear();
		selection.context.policyPaths.clear();
		selection.context.ordinaryPrefixes.clear();
		selection.context.remainingDepth.clear();
		selection.context.observedUsage.clear();
		selection.context.taskRequestCounts.clear();
		selection.context.childOrder.clear();
		const values: string[] = [];
		const mirrorRoot = join(cwd, ".pi", "workflow-subagents");
		for (const name of await readdir(mirrorRoot)) {
			if (!name.startsWith(".prune-")) continue;
			const container = join(mirrorRoot, name);
			const owned = [mirror, ...selection.context.ownedMirror.values()]
				.find(value => value?.container === container);
			const identity = await lstat(container);
			if (!owned || !identity.isDirectory() || identity.isSymbolicLink() ||
				owned.directory !== join(container, "run") ||
				(await readdir(container)).join() !== "run")
				throw new Error("foreign or changed family mirror quarantine");
		}
		const currentPlan = await findRetentionPlan(cwd, pending, selection.context);
		for (const member of selection.candidates) {
			values.push(await isolatedOrdinaryGoalSnapshot(
				cwd,
				member,
				currentPlan,
				custody.get(member.run.runId)!,
				member.run.runId === targetRunId ? pending : undefined,
				member.run.runId === targetRunId ? mirror : undefined,
				selection.context,
			));
		}
		if (selection.context.requestsSeen.value !== selection.context.requests)
			throw new Error("ordinary Goal family request census unavailable");
		const consumed = new Set<string>();
		let prefix = 0;
		const consume = (memberId: string, specId: string): void => {
			const count = selection.context.taskRequestCounts.get(memberId)?.get(specId) ?? 0;
			if (!Number.isSafeInteger(count) || count < 1)
				throw new Error("ordinary Goal request task has no complete receipt census");
			const key = `${memberId}\0${specId}`;
			if (consumed.has(key)) throw new Error("ordinary Goal request task consumed twice");
			consumed.add(key);
			prefix += count;
		};
		const visit = (memberId: string): void => {
			const member = selection.context.members.get(memberId);
			if (!member) throw new Error("ordinary Goal request member is absent");
			const ordinary = selection.context.ordinaryPrefixes.get(memberId);
			if (ordinary) consume(memberId, ordinary);
			const policy = member.run.tasks.find(task => task.goalRoot !== undefined || task.goal !== undefined);
			if (!policy?.goalRoot) throw new Error("ordinary Goal request lineage is absent");
			for (const generation of policy.goalRoot.generations) {
				consume(memberId, generation.plannerSpecId);
				const children = Object.entries(generation.children ?? {}).map(([slot, value]) => {
					const childId = String(evidenceObject(value).runId);
					return { slot, childId };
				});
				const order = selection.context.childOrder.get(memberId) ?? [];
				if (children.some(child => !order.includes(child.childId)) ||
					order.filter(childId => children.some(child => child.childId === childId)).length !== children.length)
					throw new Error("ordinary Goal child order is ambiguous");
				for (const childId of order.filter(id => children.some(child => child.childId === id)))
					visit(childId);
				const childSpecs = new Set(children.map(child => String(generation.slots[child.slot])));
				for (const specId of Object.values(generation.slots))
					if (!childSpecs.has(String(specId))) consume(memberId, String(specId));
				for (const specId of Object.values(generation.verifiers ?? {}))
					consume(memberId, String(specId));
			}
			const observed = selection.context.observedUsage.get(memberId);
			if (observed !== prefix) throw new Error("ordinary Goal family request prefix mismatch");
		};
		visit(selection.context.rootRunId);
		for (const [memberId, tasks] of selection.context.taskRequestCounts) {
			for (const [specId, count] of tasks)
				if (count > 0 && !consumed.has(`${memberId}\0${specId}`))
					throw new Error(`ordinary Goal request task is unconsumed: ${memberId}/${specId}`);
		}
		if (prefix !== selection.context.requests || prefix !== selection.context.observedUsage.get(selection.context.rootRunId))
			throw new Error("ordinary Goal family request final census mismatch");
		return workflowDefinitionFingerprint(values);
	};
	try {
		for (const member of selection.candidates)
			if (await isWorkflowRunLeaseLive(cwd, member.run.runId))
				throw new Error(`live or indeterminate supervisor lease: ${member.run.runId}`);
		const initial = await snapshots();
		rows = selection.candidates.map((value) => ({
			runId: value.run.runId,
			...(value.run.name === undefined ? {} : { name: value.run.name }),
			status: value.run.status,
			updatedAt: value.run.updatedAt,
			bytes: value.bytes,
			selected: true,
			protected: false,
			deleted: false,
		} satisfies WorkflowPruneRun));
		if (!options.yes) return {
			dryRun: true, keep, runs: rows, totalBytes: rows.reduce((total, row) => total + row.bytes, 0),
			deletedBytes: 0, indexUpdated: false,
		};
		const leases = await acquireRetentionRunLeases(cwd, selection.candidates.map((value) => value.run.runId));
		const quarantines: Quarantine[] = [];
		try {
			for (const lease of leases.values()) await lease!.assertOwner();
			await assertTopologyOwner?.();
			const lockObservations = new Map<string, { version: Stats; bytes: Buffer }>();
			const observeLock = async (path: string) => {
				const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
				try {
					const version = await handle.stat();
					if (!version.isFile() || version.nlink !== 1 || version.size > 1024)
						throw new Error("original family supervisor lock custody unavailable");
					const bytes = await handle.readFile();
					if (!sameRawVersion(version, await handle.stat()) || !sameRawVersion(version, await lstat(path)))
						throw new Error("original family supervisor lock changed during observation");
					return { version, bytes };
				} finally { await handle.close(); }
			};
			for (const member of selection.candidates) {
				lockObservations.set(member.run.runId, await observeLock(join(member.runDir, "supervisor.lock")));
				await leases.get(member.run.runId)!.assertOwner();
			}
			const transactionId = randomUUID();
			const transaction: GoalRetentionTransaction = {
				schema: "pi-goal-retention-transaction-v1",
				transactionId,
				state: "prepared",
				goals: [],
				workflows: selection.candidates.map((value) => ({
					runId: value.run.runId,
					primary: value.runDir,
					dev: value.identity.dev,
					ino: value.identity.ino,
					mirror: value.mirrorDir,
				})),
				createdAt: new Date().toISOString(),
			};
			const recheck = async (targetRunId: string, pending?: string, mirror?: Quarantine): Promise<string | undefined> => {
				if (pending) selection.context.ownedQuarantines.add(pending);
				if (mirror) selection.context.ownedQuarantines.add(mirror.container);
				selection.context.requestsSeen.value = 0;
				try {
					await assertTopologyOwner?.();
					for (const [id, lease] of leases) {
						const retained = selection.context.ownedPrimary.get(id);
						if (!retained) { await lease!.assertOwner(); continue; }
						// Renaming the run ends its original pathname lease.
						// Under the still-held topology lease, only observe the
						// original moved lock; never reissue execution ownership.
						try {
							await lstat(selection.context.members.get(id)!.runDir);
							throw new Error("detached family run name was recreated");
						} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
						const original = lockObservations.get(id)!;
						const current = await observeLock(join(retained.directory, "supervisor.lock"));
						if (original.version.dev !== current.version.dev || original.version.ino !== current.version.ino ||
							!original.bytes.equals(current.bytes))
							throw new Error("original quarantined family supervisor lock changed");
					}
					if (await snapshots(targetRunId, pending, mirror) !== initial)
						return "ordinary Goal family evidence changed since selection";
					return undefined;
				} catch (error) { return `ordinary Goal closure refused: ${errorMessage(error)}`; }
			};
			const initialError = await recheck("");
			if (initialError) throw new Error(initialError);
			await publishGoalRetentionTransaction(cwd, transaction);
			selection.context.transaction = await captureOrdinaryRetentionTransaction(cwd, transaction);
			for (const member of selection.candidates) {
				const outcome = await deleteCandidate(
					cwd,
					member,
					(pending, mirror) => recheck(member.run.runId, pending, mirror),
					leases.get(member.run.runId),
					quarantines,
				);
				Object.assign(rows.find((row) => row.runId === member.run.runId)!, outcome);
				if (outcome.error || !outcome.detached) throw new Error(outcome.error ?? "ordinary Goal family detach incomplete");
				const row = rows.find((value) => value.runId === member.run.runId)!;
				if (!row.retainedEvidencePath || !row.retainedMirrorPath)
					throw new Error("ordinary Goal family quarantine evidence incomplete");
				selection.context.ownedPrimary.set(member.run.runId, {
					container: dirname(row.retainedEvidencePath),
					directory: row.retainedEvidencePath,
				});
				selection.context.ownedMirror.set(member.run.runId, {
					container: dirname(row.retainedMirrorPath),
					directory: row.retainedMirrorPath,
				});
			}
			const finalError = await recheck("");
			if (finalError) throw new Error(finalError);
			const detached: GoalRetentionTransaction = {
				...transaction,
				state: "detached",
				workflows: transaction.workflows.map((workflow) => ({
					...workflow,
					quarantine: selection.context.ownedPrimary.get(workflow.runId)?.directory,
					mirrorQuarantine: selection.context.ownedMirror.get(workflow.runId)?.directory,
				})),
			};
			await publishGoalRetentionTransaction(cwd, detached);
			selection.context.transaction = await captureOrdinaryRetentionTransaction(cwd, detached);
			const committedError = await recheck("");
			if (committedError) throw new Error(committedError);
			const inventories = new Map<string, Awaited<ReturnType<typeof capturePurgeInventory>>>();
			const remainingInodes = new Map<string, { size: number; roots: Set<string> }>();
			for (const member of selection.candidates) {
				const id = member.run.runId;
				let bytes = 0;
				for (const [quarantine, primary] of [
					[selection.context.ownedMirror.get(id)!, false],
					[selection.context.ownedPrimary.get(id)!, true],
				] as const) {
					const inventory = await capturePurgeInventory(quarantine.directory, primary);
					if (!inventory) throw new Error("ordinary Goal purge inventory disappeared");
					inventories.set(quarantine.directory, inventory);
					for (const file of inventory.values()) {
						if (file.directory) continue;
						const identity = `${file.dev}:${file.ino}`;
						let inode = remainingInodes.get(identity);
						if (!inode) {
							inode = { size: file.size, roots: new Set() };
							remainingInodes.set(identity, inode);
							bytes += file.size;
						} else if (inode.size !== file.size) throw new Error("ordinary Goal purge inode size changed");
						inode.roots.add(quarantine.directory);
					}
				}
				rows.find(row => row.runId === id)!.bytes = bytes;
			}
			const inventoryError = await recheck("");
			if (inventoryError) throw new Error(inventoryError);
			await updateIndex(cwd);
			indexUpdated = true;
			// A failed descendant purge must retain every ancestor. Within each
			// member, preserve its primary evidence until its mirror is gone.
			for (const member of [...selection.candidates].reverse()) {
				const id = member.run.runId;
				const row = rows.find(value => value.runId === id)!;
				for (const [quarantine, field, primary] of [
					[selection.context.ownedMirror.get(id)!, "retainedMirrorPath", false],
					[selection.context.ownedPrimary.get(id)!, "retainedEvidencePath", true],
				] as const) {
					let failure: unknown;
					try { await rm(quarantine.container, { recursive: true, force: true }); }
					catch (error) { failure = error; }
					try {
						const before = inventories.get(quarantine.directory)!;
						const after = await capturePurgeInventory(quarantine.directory, primary, true);
						for (const [path, current] of after ?? []) {
							const original = before.get(path);
							if (!original || original.dev !== current.dev || original.ino !== current.ino ||
								original.directory !== current.directory || original.size !== current.size)
								throw new Error("ordinary Goal purge inventory changed unexpectedly");
						}
						const remaining = new Set([...(after?.values() ?? [])].filter(file => !file.directory)
							.map(file => `${file.dev}:${file.ino}`));
						const original = new Set([...before.values()].filter(file => !file.directory)
							.map(file => `${file.dev}:${file.ino}`));
						for (const identity of original) {
							if (remaining.has(identity)) continue;
							const inode = remainingInodes.get(identity)!;
							if (inode.roots.delete(quarantine.directory) && !inode.roots.size) deletedBytes += inode.size;
						}
						if (!after) row[field] = undefined;
						row.deleted = !row.retainedMirrorPath && !row.retainedEvidencePath;
						row.purged = row.deleted;
						if (after && failure === undefined)
							failure = new Error("ordinary Goal purge returned with retained evidence");
					} catch (observationError) {
						row.error = `${failure === undefined ? "" : `${errorMessage(failure)}; `}purge observation incomplete: ${errorMessage(observationError)}`;
						throw new Error(row.error);
					}
					if (failure !== undefined) {
						row.error = errorMessage(failure);
						throw failure;
					}
				}
			}
			return {
				dryRun: false, keep, runs: rows,
				totalBytes: rows.reduce((total, row) => total + row.bytes, 0),
				deletedBytes,
				indexUpdated: true,
			};
		} finally { await releaseRetentionRunLeases(leases); }
	} catch (error) {
		return {
			dryRun: !options.yes,
			keep,
			...(olderThanDays === undefined ? {} : { olderThanDays }),
			runs: rows,
			totalBytes: rows.reduce((total, row) => total + (row.protected ? 0 : row.bytes), 0),
			deletedBytes,
			indexUpdated,
			error: errorMessage(error),
		};
	}
}

async function capturePurgeInventory(
	directory: string, primary: boolean, allowMissing = false,
): Promise<Map<string, { dev: number; ino: number; size: number; directory: boolean }> | undefined> {
	try {
		const root = await lstat(directory);
		if (!root.isDirectory() || root.isSymbolicLink() || await realpath(directory) !== directory)
			throw new Error("ordinary Goal purge directory is not physical");
	} catch (error) {
		if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	const files = new Map<string, { dev: number; ino: number; size: number; directory: boolean }>();
	async function walk(current: string): Promise<void> {
		const directoryInfo = await lstat(current);
		if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || await realpath(current) !== current)
			throw new Error("ordinary Goal purge directory changed");
		files.set(relative(directory, current), { dev: directoryInfo.dev, ino: directoryInfo.ino, size: 0, directory: true });
		for (const name of await readdir(current)) {
			// This operation's supervisor lease is not selected user evidence.
			if (primary && current === directory && name === "supervisor.lock") continue;
			const path = join(current, name), info = await lstat(path);
			if (info.isSymbolicLink()) throw new Error("ordinary Goal purge inventory contains a symlink");
			if (info.isDirectory()) await walk(path);
			else if (info.isFile()) files.set(relative(directory, path), { dev: info.dev, ino: info.ino, size: info.size, directory: false });
			else throw new Error("ordinary Goal purge inventory contains a nonregular file");
		}
	}
	await walk(directory);
	return files;
}

function evidenceObject(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("incomplete Goal evidence object");
	return value as Record<string, unknown>;
}

/** Deletion eligibility only: these observations never restore admission,
 * request custody, resume permission, or transmission authority. */
interface OrdinaryClosureCustody {
	owners: Map<string, RawOwner>;
	census: Map<string, { version: Stats; digest: string }>;
	barriers?: Map<string, {
		recordHash: string;
		state: Awaited<ReturnType<typeof readWorkflowDurableLaunchBarrierState>>;
		files: Map<string, { version: Stats; digest: string }>;
	}>;
}

interface OrdinaryGoalFamilyContext {
	rootRunId: string;
	memberRunIds: Set<string>;
	members: Map<string, Candidate>;
	requests: number;
	requestsSeen: { value: number };
	requestIds: Set<string>;
	candidateIds: Set<string>;
	ownedQuarantines: Set<string>;
	ownedPrimary: Map<string, Quarantine>;
	ownedMirror: Map<string, Quarantine>;
	definitions: Map<string, ReturnType<typeof parseGoalWorkflowSpec>>;
	policyPaths: Map<string, string>;
	ordinaryPrefixes: Map<string, string>;
	remainingDepth: Map<string, number>;
	observedUsage: Map<string, number>;
	taskRequestCounts: Map<string, Map<string, number>>;
	childOrder: Map<string, string[]>;
	transaction?: { path: string; bytes: string; version: Stats };
}

async function captureOrdinaryRetentionTransaction(
	cwd: string, transaction: GoalRetentionTransaction,
): Promise<{ path: string; bytes: string; version: Stats }> {
	const path = join(workflowsRoot(cwd), `.goal-retention-${transaction.transactionId}.json`);
	const bytes = JSON.stringify(transaction);
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const version = await handle.stat();
		if (!version.isFile() || version.nlink !== 1 || await handle.readFile("utf8") !== bytes ||
			!sameRawVersion(version, await handle.stat()) || !sameRawVersion(version, await lstat(path)))
			throw new Error("original retention transaction publication changed");
		return { path, bytes, version };
	} finally { await handle.close(); }
}

async function isolatedOrdinaryGoalSnapshot(
	cwd: string, candidate: Candidate, plan: RetentionPlan, custody: OrdinaryClosureCustody,
	pendingQuarantine?: string, mirror?: Quarantine, family?: OrdinaryGoalFamilyContext,
): Promise<string> {
	if (plan.uncertain) throw new Error("uncertain workflow or private Goal references");
	const physicalRoot = await realpath(cwd);
	const rootIdentity = await lstat(physicalRoot);
	const sameRoot = async (value: unknown): Promise<boolean> => {
		if (typeof value !== "string" || !isAbsolute(value)) return false;
		const canonical = await realpath(value);
		const identity = await lstat(canonical);
		return canonical === physicalRoot && identity.dev === rootIdentity.dev && identity.ino === rootIdentity.ino;
	};
	const primary = family?.ownedPrimary.get(candidate.run.runId);
	const retainedMirror = mirror ?? family?.ownedMirror.get(candidate.run.runId);
	const runDirectory = primary?.directory ?? candidate.runDir;
	const run = await readTerminalCandidate(runDirectory);
	if (family && workflowDefinitionFingerprint(run) !== workflowDefinitionFingerprint(candidate.run))
		throw new Error("ordinary Goal family run changed since selection");
	if (run.runId !== candidate.run.runId || !await sameRoot(run.cwd) ||
		(!family && run.parentRunId !== undefined) ||
		(!family && run.rootRunId !== undefined && run.rootRunId !== run.runId) ||
		(family && run.runId !== family.rootRunId &&
			(run.rootRunId !== family.rootRunId || !family.memberRunIds.has(run.runId))) ||
		run.status !== "completed" ||
		run.tasks.some(task => task.status !== "completed" || task.goalRequestUsageIncomplete))
		throw new Error("requires one completed standalone root with complete terminal tasks");
	if ((!family && Object.hasOwn(run, "goalChild")) || run.goal !== undefined ||
		(run.invalidationJournal !== undefined || run.foreachBatches !== undefined) ||
		!run.goalParticipation || run.goalParticipation.schemaVersion !== 1 || run.goalParticipation.resumeRequired !== false)
		throw new Error("unsupported or recovery-required Goal root");
	if (!family && (plan.children.get(run.runId)?.size || plan.goalChildren.get(run.runId)?.size ||
		plan.currentGoalReferences.get(run.runId)?.size))
		throw new Error("related children or external Goal references");
	if (family && (
		plan.currentGoalReferences.get(run.runId)?.size ||
		[...(plan.children.get(run.runId) ?? new Set()), ...(plan.goalChildren.get(run.runId) ?? new Set())]
			.some(child => !family.memberRunIds.has(child))
	))
		throw new Error("ordinary Goal family has retained external references");
	const roots = run.tasks.filter(task => task.goalRoot !== undefined || task.goal !== undefined);
	if (roots.length !== 1) throw new Error("requires exactly one ordinary Goal policy root");
	const root = roots[0];
	const lineage = root.goalRoot, goal = root.goal;
	if (root.kind !== "goal" || !lineage || !goal || goal.state !== "engine:achieved" ||
		goal.goalId !== `goal_engine_${goal.contractHash.slice(0, 32)}` || !/^[a-f0-9]{64}$/.test(goal.contractHash) ||
		!Array.isArray(lineage.generations) || !lineage.generations.length ||
		lineage.generations.some((generation, index) => generation.generation !== index ||
			generation.outcome !== (index === lineage.generations.length - 1 ? "achieved" : "not-achieved")) ||
		!Number.isSafeInteger(goal.usage?.requests) || (goal.usage?.requests ?? -1) < 0)
		throw new Error("current final achieved generation or complete request coverage unavailable");
	// Match the existing Goal catalog source capture ceiling; arbitrary artifacts
	// are streamed, while only interpreted JSON/ledger evidence is retained.
	const maximumEvidenceBytes = 4 * 1024 * 1024;
	const files = new Map<string, { digest: string; size: number; dev: number; ino: number }>();
	const texts = new Map<string, string>();
	const policyArtifactDirectory = relative(candidate.runDir, join(cwd, dirname(root.files.result)));
	if (policyArtifactDirectory.startsWith("..") || isAbsolute(policyArtifactDirectory))
		throw new Error("foreign Goal publication reference");
	const rawOwners = custody.owners;
	const originalMirror = resolve(candidate.mirrorDir);
	const relocated = (path: string): string => {
		// sameRoot above proves this original cwd spelling names the same
		// physical root. Normalize observations, never persisted descriptors.
		const authoredRoot = resolve(run.cwd);
		if (path === authoredRoot || isInside(authoredRoot, path))
			path = join(physicalRoot, relative(authoredRoot, path));
		if (primary && (path === candidate.runDir || isInside(candidate.runDir, path)))
			return join(primary.directory, relative(candidate.runDir, path));
		if (retainedMirror && (path === originalMirror || isInside(originalMirror, path)))
			return join(retainedMirror.directory, relative(originalMirror, path));
		return path;
	};
	async function rawVersion(path: string): Promise<{ version: Stats; digest: string }> {
		const file = await open(relocated(path), constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const version = await file.stat();
			if (!version.isFile()) throw new Error("raw closure census is not a regular file");
			const digest = await hashRawDescriptor(file, version.size);
			if (!sameRawVersion(version, await file.stat()) || !sameRawVersion(version, await lstat(relocated(path))))
				throw new Error("raw closure census changed during read");
			return { version, digest };
		} finally { await file.close(); }
	}
	async function checkOwner(owner: RawOwner, info: Stats): Promise<void> {
		if (!retainedMirror) {
			await recheckRawOwner(owner);
			await checkRawLinks(owner, info);
		} else {
			try {
				await lstat(originalMirror);
				throw new Error("original mirror name replaced after quarantine");
			} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			if (retainedMirror.directory !== join(retainedMirror.container, "run") || dirname(retainedMirror.container) !== dirname(originalMirror) ||
				!basename(retainedMirror.container).startsWith(".prune-") || await realpath(retainedMirror.directory) !== retainedMirror.directory ||
				(await readdir(retainedMirror.container)).join() !== "run")
				throw new Error("raw closure mirror relocation is not owned quarantine");
			const originalIdentity = owner.directories.get(originalMirror);
			if (owner.attempt && !originalIdentity) throw new Error("raw closure mirror identity unavailable");
			for (const [path, before] of owner.directories) {
				const current = await lstat(relocated(path));
				if (!current.isDirectory() || current.isSymbolicLink() || before.dev !== current.dev || before.ino !== current.ino)
					throw new Error("raw closure directory identity changed");
			}
			for (const [path, before] of owner.metadata) {
				const current = await lstat(relocated(path));
				if (!current.isFile() || current.isSymbolicLink() || !sameRawVersion(before, current))
					throw new Error("raw closure metadata changed after mirror detach");
			}
			// Only this live operation's original quarantine remaps filesystem
			// observations; persisted owner descriptors and authority stay untouched.
			await checkRawLinks({ ...owner, raw: relocated(owner.raw), output: relocated(owner.output),
				attempt: owner.attempt ? relocated(owner.attempt) : undefined }, info);
		}
		for (const path of [owner.raw, owner.output, ...(owner.attempt ? [owner.attempt] : [])]) {
			const before = custody.census.get(path);
			if (!before) throw new Error("raw closure original census unavailable");
			const current = await rawVersion(path);
			if (!sameRawVersion(before.version, current.version) || before.digest !== current.digest)
				throw new Error("raw closure original census changed");
		}
	}
	async function rawOwner(path: string): Promise<RawOwner | undefined> {
		const match = /^tasks\/([^/]+)\/(raw\.md|output\.log)$/.exec(path);
		if (!match) return undefined;
		let owner = rawOwners.get(match[1]);
		if (!owner) {
			if (mirror) throw new Error("raw closure original owner unavailable after mirror detach");
			owner = await establishRawOwner(join(candidate.runDir, "tasks", match[1]));
			await recheckRawOwner(owner);
			for (const name of [owner.raw, owner.output, ...(owner.attempt ? [owner.attempt] : [])])
				custody.census.set(name, await rawVersion(name));
			rawOwners.set(match[1], owner);
		}
		return owner;
	}
	// writeStaticRunArtifacts creates only this exact identical named pair.
	// No other JSON or arbitrary in-run alias can acquire a link allowance.
	async function checkSpecPair(path: string, info: Stats): Promise<void> {
		if (path !== "spec.json" && path !== "bundle/spec.json") throw new Error(`Goal evidence unaccounted links: ${path}`);
		const pair = await Promise.all(["spec.json", "bundle/spec.json"].map(name => lstat(relocated(join(candidate.runDir, name)))));
		if (info.nlink !== 2 || pair.some(version => !version.isFile() || version.isSymbolicLink() || !sameRawVersion(info, version)))
			throw new Error(`Goal evidence spec pair custody changed: ${path}`);
	}
	async function checkBarrierPair(path: string, info: Stats): Promise<boolean> {
		const match = /^tasks\/([^/]+)\/(\.launch-barrier-[^/]+)\/decision-v2\.json(?:\.txn)?$/.exec(path);
		if (!match) return false;
		const fail = (reason: string): never => { throw new Error(`Goal evidence barrier custody refused (${reason}): ${path}`); };
		const task = run.tasks.find(task => task.taskId === match[1]);
		const directory = relocated(resolve(candidate.runDir, "tasks", match[1], match[2]));
		if (!task || task.durableLaunchBarrier?.version !== 2) return fail("descriptor history");
		const expectedDirectory = await lstat(directory);
		const taskDirectory = await realpath(dirname(directory));
		if (!expectedDirectory.isDirectory() || expectedDirectory.isSymbolicLink() ||
			await realpath(directory) !== directory) return fail("descriptor owned directory");
		const matches = await Promise.all(task.durableLaunchBarrier.records.map(async record => {
			const original = record.descriptor.directory;
			if (!isAbsolute(original) || resolve(original) !== original || basename(original) !== match[2]) return false;
			try {
				const identity = await lstat(relocated(original));
				return identity.isDirectory() && !identity.isSymbolicLink() &&
					await realpath(dirname(relocated(original))) === taskDirectory && await realpath(relocated(original)) === directory &&
					identity.dev === expectedDirectory.dev && identity.ino === expectedDirectory.ino;
			} catch { return false; }
		}));
		const records = task.durableLaunchBarrier.records.filter((_, index) => matches[index]);
		if (records.length !== 1) return fail("descriptor physical match");
		const record = records[0];
		const descriptor = {
			...record.descriptor,
			directory,
			readyPath: relocated(record.descriptor.readyPath),
			decisionPath: relocated(record.descriptor.decisionPath),
			ackPath: relocated(record.descriptor.ackPath),
		};
		for (const [name, original] of [["ready-v2.json", descriptor.readyPath], ["decision-v2.json", descriptor.decisionPath],
			["ack-v2.json", descriptor.ackPath]]) {
			if (original !== join(descriptor.directory, name) || await realpath(original) !== join(directory, name))
				return fail("descriptor path confinement");
		}
		const grants = task.launchAuthority?.records.filter(grant => grant.grant.attemptKey === record.attemptKey);
		if (grants?.length !== 1) return fail("grant match");
		const grant = grants[0];
		if (!["released", "acknowledged"].includes(record.phase) || record.releaseWinner !== true || record.cancellation ||
			grant.state.phase !== "consumed" || grant.grant.backendId !== "pi-subagent/headless" ||
			grant.grant.runId !== run.runId || grant.grant.task.taskId !== task.taskId || grant.grant.task.specId !== task.specId ||
			record.launchAuthoritySha256 !== grant.grant.identitySha256 || descriptor.subjectSha256 !== grant.grant.identitySha256 ||
			record.authorityBindingSha256 !== descriptor.authorityBindingSha256 ||
			record.backendRunId !== grant.state.backendRunId || record.backendAttemptId !== grant.state.backendAttemptId)
			return fail("grant backend winner join");
		const pair = await Promise.all([descriptor.decisionPath, `${descriptor.decisionPath}.txn`].map(name => lstat(name)));
		if (info.nlink !== 2 || pair.some(version => !version.isFile() || version.isSymbolicLink() || !sameRawVersion(info, version))) return fail("decision link census");
		const checkNames = async (): Promise<void> => {
			for (const name of await readdir(directory))
				if (!["ready-v2.json", "decision-v2.json", "decision-v2.json.txn", "ack-v2.json"].includes(name)) return fail("directory residue");
		};
		await checkNames();
		const observations = await Promise.all([descriptor.readyPath, descriptor.ackPath].map(name => lstat(name)));
		if (observations.some(version => !version.isFile() || version.isSymbolicLink() || version.nlink !== 1)) return fail("READY ACK link census");
		// The SDK reader requires the exact original descriptor. A quarantine
		// cannot manufacture a replacement native binding: retain its original
		// read-only observation and prove every original byte/inode unchanged.
		const key = path.replace(/\.txn$/, "");
		const recordHash = workflowDefinitionFingerprint(record);
		const barrierPaths = [record.descriptor.readyPath, record.descriptor.decisionPath,
			`${record.descriptor.decisionPath}.txn`, record.descriptor.ackPath];
		const versions = new Map(await Promise.all(barrierPaths.map(async name => [name, await rawVersion(name)] as const)));
		const prior = custody.barriers?.get(key);
		if (primary && (!prior || prior.recordHash !== recordHash ||
			barrierPaths.some(name => {
				const before = prior.files.get(name), current = versions.get(name)!;
				return !before || before.digest !== current.digest || !sameRawVersion(before.version, current.version);
			}))) return fail("original barrier custody changed after detach");
		const observed = primary ? prior!.state :
			await readWorkflowDurableLaunchBarrierState(record.descriptor).catch(() => fail("public state observation"));
		for (const name of barrierPaths) {
			const before = versions.get(name)!, current = await rawVersion(name);
			if (before.digest !== current.digest || !sameRawVersion(before.version, current.version))
				return fail("barrier changed during original observation");
		}
		if (!primary) {
			custody.barriers ??= new Map();
			custody.barriers.set(key, { recordHash, state: observed, files: versions });
		}
		const { ready, decision, ack } = observed;
		if (!ready || decision?.kind !== "released" || !ack ||
			ready.runId !== record.backendRunId || ready.attemptId !== record.backendAttemptId ||
			ready.readySha256 !== record.readySha256 || ready.launchPayloadSha256 !== record.launchPayloadSha256 ||
			ready.executionPlanSha256 !== record.executionPlanSha256 || decision.decisionSha256 !== record.decisionSha256 ||
			decision.releasePayloadSha256 !== record.releasePayloadSha256 || ack.ackSha256 !== record.ackSha256) return fail("public state join");
		const payload = createHash("sha256").update(canonicalWorkflowLaunchAuthorityBytes({ schema: "pi-workflow-consumed-launch-release-v1", runId: run.runId,
			taskId: task.taskId, attemptKey: grant.grant.attemptKey, launchAuthoritySha256: grant.grant.identitySha256,
			launchBootstrapSha256: grant.grant.launchBootstrapSha256, backendRunId: record.backendRunId,
			backendAttemptId: record.backendAttemptId, readySha256: ready.readySha256,
			launchPayloadSha256: ready.launchPayloadSha256, executionPlanSha256: ready.executionPlanSha256, authorityPhase: "consumed",
			...(record.authorityBindingSha256 === undefined ? {} : { authorityBindingSha256: record.authorityBindingSha256,
				externalLaunchGrantSha256: record.authorityBindingSha256 }) })).digest("hex");
		if (payload !== record.releasePayloadSha256) return fail("release payload digest");
		await checkNames();
		for (const [index, name] of [descriptor.readyPath, descriptor.ackPath].entries())
			if (!sameRawVersion(observations[index], await lstat(name))) return fail("READY ACK changed");
		for (const name of [descriptor.decisionPath, `${descriptor.decisionPath}.txn`])
			if (!sameRawVersion(info, await lstat(name))) return fail("decision pair changed");
		const currentDirectory = await lstat(descriptor.directory);
		if (!currentDirectory.isDirectory() || currentDirectory.isSymbolicLink() ||
			currentDirectory.dev !== expectedDirectory.dev || currentDirectory.ino !== expectedDirectory.ino ||
			await realpath(descriptor.directory) !== directory || await realpath(dirname(descriptor.directory)) !== taskDirectory)
			return fail("descriptor directory changed");
		return true;
	}
	async function capture(directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const file = join(directory, entry.name);
			if (directory === runDirectory && entry.name === "supervisor.lock") continue;
			const info = await lstat(file);
			const path = relative(runDirectory, file);
			if (info.isSymbolicLink() || !(info.isDirectory() || info.isFile())) throw new Error(`unsafe or active Goal evidence path: ${path}`);
			if ((entry.name.endsWith(".txn") && !await checkBarrierPair(path, info)) ||
				entry.name.endsWith(".pending") || entry.name.endsWith(".tmp") || entry.name.includes(".release-") || entry.name.endsWith(".lock"))
				throw new Error(`Goal recovery residue or active effect lease: ${path}`);
			if (info.isDirectory()) await capture(file);
			else {
				const interpreted = path === "compiled.json" || path === "dynamic/events.jsonl" || path === "dynamic/state.json" ||
					path === join(policyArtifactDirectory, "control.json") || path === join(policyArtifactDirectory, "refs.json") ||
					path.includes("/goal-evidence/") || path.includes("/request-reservations/") || path.includes("/candidate-operations/");
				const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
				try {
					const before = await handle.stat();
					if (!before.isFile() || !sameRawVersion(before, info))
						throw new Error(`Goal evidence identity changed during capture: ${path}`);
					let owner: RawOwner | undefined;
					try {
						const retainedTask = /^tasks\/([^/]+)\/(raw\.md|output\.log)$/.exec(path)?.[1];
						owner = before.nlink !== 1 || (retainedTask !== undefined && rawOwners.has(retainedTask)) ? await rawOwner(path) : undefined;
						if (owner) await checkOwner(owner, before);
						else if (before.nlink !== 1 && !await checkBarrierPair(path, before)) await checkSpecPair(path, before);
					} catch (error) { throw new Error(`Goal evidence link custody refused: ${path}: ${errorMessage(error)}`); }
					if (interpreted && before.size > maximumEvidenceBytes) throw new Error("Goal evidence exceeds capture byte limit");
					const hash = createHash("sha256"), chunks: Buffer[] = [];
					const buffer = Buffer.alloc(64 * 1024);
					let size = 0;
					for (;;) {
						const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
						if (!bytesRead) break;
						size += bytesRead;
						if (interpreted && size > maximumEvidenceBytes) throw new Error("Goal evidence exceeds capture byte limit");
						const chunk = buffer.subarray(0, bytesRead);
						hash.update(chunk);
						if (interpreted) chunks.push(Buffer.from(chunk));
					}
					const digest = owner ? await hashRawDescriptor(handle, before.size) : hash.digest("hex");
					if (owner?.integrity && (owner.integrity.owner !== owner.identity || owner.integrity.bytes !== size || owner.integrity.sha256 !== digest))
						throw new Error(`Goal evidence raw integrity changed: ${path}`);
					try {
						if (owner) await checkOwner(owner, before);
						else if (before.nlink !== 1 && !await checkBarrierPair(path, before)) await checkSpecPair(path, before);
					} catch (error) { throw new Error(`Goal evidence link custody refused: ${path}: ${errorMessage(error)}`); }
					const after = await handle.stat(), current = await lstat(file);
					if (size !== before.size || !sameRawVersion(before, after) || !sameRawVersion(before, current) ||
						current.isSymbolicLink()) throw new Error(`Goal evidence changed during capture: ${path}`);
					files.set(path, { digest, size, dev: before.dev, ino: before.ino });
					if (interpreted) texts.set(path, new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
				} finally { await handle.close(); }
			}
		}
	}
	await capture(runDirectory);
	const json = (path: string): Record<string, unknown> => {
		const text = texts.get(path);
		if (text === undefined) throw new Error(`missing original Goal evidence: ${path}`);
		return evidenceObject(JSON.parse(text));
	};
	const compiled = json("compiled.json");
	if (!Array.isArray(compiled.tasks)) throw new Error("missing compiled Goal tasks");
	const policy = compiled.tasks.map(evidenceObject).find(task => task.id === root.specId);
	if (!policy || policy.kind !== "goal") throw new Error("missing original compiled Goal policy");
	const policyGoal = evidenceObject(policy.goal);
	const definition = parseGoalWorkflowSpec(policyGoal.definition);
	if (workflowDefinitionFingerprint(definition) !== lineage.definitionFingerprint ||
		policyGoal.definitionFingerprint !== lineage.definitionFingerprint)
		throw new Error("immutable Goal definition mismatch");
	family?.definitions.set(run.runId, definition);
	if (family) {
		if (typeof policyGoal.usesPath !== "string" || !isAbsolute(policyGoal.usesPath))
			throw new Error("original Goal policy source path unavailable");
		family.policyPaths.set(run.runId, policyGoal.usesPath);
		const inherited = run.runId === family.rootRunId ? Infinity :
			(family.remainingDepth.get(run.parentRunId ?? "") ?? 0) - 1;
		const remaining = Math.min(inherited, definition.goal.nesting?.maxDepth ?? 3);
		if (remaining < 1) throw new Error("ordinary Goal family exceeds original ancestor depth");
		family.remainingDepth.set(run.runId, remaining);
	}
	if (family && run.goalChild) {
		const marker = run.goalChild;
		const catalog = family.definitions.get(marker.parentRunId)?.goal.workflows?.[marker.workflowId];
		if (!catalog || typeof compiled.task !== "string" ||
			hashDynamicRequest({ workflowId: marker.workflowId, uses: catalog.uses,
				specHash: marker.specHash, input: { task: compiled.task, wait: true } }) !== marker.requestHash)
			throw new Error("original child input/catalog request binding mismatch");
		if (typeof marker.sourceBytesHex !== "string" ||
			marker.sourceBytesHex.length > maximumEvidenceBytes * 2 ||
			!/^(?:[a-f0-9]{2})+$/.test(marker.sourceBytesHex))
			throw new Error("original child definition/source capture mismatch");
		const bytes = Buffer.from(marker.sourceBytesHex, "hex");
		const sourceText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		const captured = marker.definitionKind === "standalone-goal"
			? parseGoalWorkflowSpec(JSON.parse(sourceText)) : parseArtifactGraphWorkflowSpec(JSON.parse(sourceText));
		if (createHash("sha256").update(bytes).digest("hex") !== marker.sourceHash ||
			hashDynamicRequest(sourceText) !== marker.specHash ||
			workflowDefinitionFingerprint(captured) !== marker.definitionFingerprint)
			throw new Error("original child source bytes do not bind its compiler definition");
		if ("goal" in captured) {
			if (marker.definitionFingerprint !== lineage.definitionFingerprint)
				throw new Error("original child definition/source capture mismatch");
		} else {
			const [preworkStage, terminalStage] = captured.artifactGraph.stages;
			if (captured.artifactGraph.stages.length !== 2 || !preworkStage || !terminalStage ||
				(preworkStage.type !== undefined && preworkStage.type !== "single") ||
				terminalStage.type !== "goal" || terminalStage.after !== preworkStage.id ||
				preworkStage.after !== undefined || captured.roles || captured.executionProfiles ||
				captured.defaultExecutionProfile || captured.defaults)
				throw new Error("unsupported original mixed Goal wrapper");
			const prework = evidenceObject(preworkStage), terminal = evidenceObject(terminalStage);
			const goalSource = evidenceObject(terminal.goal);
			if (typeof prework.agent !== "string" || typeof prework.prompt !== "string" ||
				!Array.isArray(prework.tools) || prework.tools.length || prework.readOnly !== true ||
				evidenceObject(prework.inputPolicy).artifactAccess !== "none" ||
				(prework.profileRole !== undefined &&
					!["planning", "research-execution", "verification"].includes(String(prework.profileRole))) ||
				Object.keys(prework).some(key => !["id", "type", "agent", "tools", "readOnly", "inputPolicy", "prompt", "profileRole"].includes(key)) ||
				Object.keys(terminal).some(key => !["id", "type", "after", "goal"].includes(key)) ||
				Object.keys(goalSource).some(key => key !== "uses") || typeof goalSource.uses !== "string")
				throw new Error("unsupported original mixed Goal prework");
			const sources = marker.embeddedGoalSources;
			const parentPath = family.policyPaths.get(marker.parentRunId);
			if (!parentPath || !Array.isArray(sources) || sources.length !== 1)
				throw new Error("original embedded Goal source capture unavailable");
			const embedded = sources[0];
			const wrapperPath = resolve(dirname(parentPath), catalog.uses);
			if (embedded.stageId !== terminalStage.id || policy.stageId !== terminalStage.id ||
				embedded.usesPath !== resolve(dirname(wrapperPath), goalSource.uses) ||
				embedded.usesPath !== policyGoal.usesPath ||
				embedded.definitionFingerprint !== lineage.definitionFingerprint ||
				typeof embedded.sourceBytesHex !== "string" || embedded.sourceBytesHex.length > maximumEvidenceBytes * 2 ||
				!/^(?:[a-f0-9]{2})+$/.test(embedded.sourceBytesHex))
				throw new Error("original embedded Goal source binding mismatch");
			const embeddedBytes = Buffer.from(embedded.sourceBytesHex, "hex");
			const embeddedDefinition = parseGoalWorkflowSpec(JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(embeddedBytes)));
			if (createHash("sha256").update(embeddedBytes).digest("hex") !== embedded.sourceHash ||
				workflowDefinitionFingerprint(embeddedDefinition) !== lineage.definitionFingerprint)
				throw new Error("original embedded Goal source bytes mismatch");
			const ordinary = compiled.tasks.map(evidenceObject).filter(task => task.stageId === preworkStage.id);
			if (ordinary.length !== 1) throw new Error("original mixed Goal prework inventory mismatch");
			const source = ordinary[0], runtime = evidenceObject(source.runtime), safety = evidenceObject(source.safety);
			const artifact = evidenceObject(source.artifactGraph), profile = marker.ordinaryProfile;
			if (source.kind !== "single" || typeof source.id !== "string" ||
				source.agent !== prework.agent || source.task !== lowerArtifactGraphPrompt(preworkStage) ||
				source.goal !== undefined || source.support !== undefined || source.dynamic !== undefined ||
				source.foreach !== undefined || source.dynamicGenerated !== undefined ||
				!Array.isArray(source.dependsOn) || source.dependsOn.length ||
				!Array.isArray(runtime.tools) || runtime.tools.length ||
				!profile || typeof profile.model !== "string" || runtime.model !== profile.model ||
				runtime.thinking !== profile.thinking || safety.readOnlyDeclared !== true || safety.capability !== "read-only" ||
				artifact.enabled !== true || artifact.artifactAccess !== "none" ||
				!Array.isArray(artifact.requiredReads) || artifact.requiredReads.length)
				throw new Error("original mixed Goal prework binding mismatch");
			const planner = compiled.tasks.map(evidenceObject).find(task => task.id === lineage.generations[0].plannerSpecId);
			if (!planner || workflowDefinitionFingerprint(planner.dependsOn) !== workflowDefinitionFingerprint([source.id]))
				throw new Error("original mixed Goal prework ordering mismatch");
			family.ordinaryPrefixes.set(run.runId, source.id);
		}
	}
	const generations = lineage.generations;
	const generationMembers = new Map<number, Set<string>>();
	const allMembers = new Set<string>();
	for (const generation of generations) {
		for (const [slot, child] of Object.entries(generation.children ?? {})) {
			const member = family?.members.get(child.runId);
			const marker = member?.run.goalChild;
			if (!member || !marker || generation.slots[slot] !== child.runId ||
				member.run.parentRunId !== run.runId || member.run.rootRunId !== family?.rootRunId ||
				marker.parentRunId !== run.runId || marker.policySpecId !== root.specId ||
				marker.controllerTaskId !== root.taskId || marker.controllerSpecId !== generation.workerControllerSpecId ||
				marker.generation !== generation.generation || marker.slot !== slot ||
				marker.runId !== child.runId || marker.workflowId !== child.workflowId ||
				marker.specHash !== child.specHash || marker.requestHash !== child.requestHash)
				throw new Error("original child generation membership mismatch");
		}
		const childSlots = new Set(Object.values(generation.slots).filter((id) =>
			typeof id === "string" && family?.members.has(id) && id !== run.runId));
		const members = [generation.plannerSpecId, ...Object.values(generation.slots).filter((id) => !childSlots.has(id)),
			...Object.values(generation.verifiers ?? {})];
		const controller = generation.generation === 0 ? root.specId : `${root.specId}.$generation${generation.generation}.workers`;
		if (!Object.keys(generation.slots).length || new Set(members).size !== members.length ||
			generation.workerControllerSpecId !== controller ||
			childSlots.size !== Object.keys(generation.children ?? {}).length ||
			members.some(id => typeof id !== "string" || allMembers.has(id) ||
				run.tasks.filter(task => task.specId === id).length !== 1))
			throw new Error("incomplete original generation membership");
		for (const id of members) {
			const task = run.tasks.find(value => value.specId === id)!;
			if (task.kind === "goal") throw new Error("invalid original Goal generation member");
			const sources = compiled.tasks.map(evidenceObject).filter(source => source.id === id);
			if (sources.length !== 1 || (Object.values(generation.slots).includes(id) &&
				evidenceObject(sources[0].dynamicGenerated).controllerSpecId !== controller))
				throw new Error("incomplete original generation source binding");
			allMembers.add(id);
		}
		generationMembers.set(generation.generation, new Set(Object.values(generation.slots).filter((id) => !childSlots.has(id))));
	}
	const ordinaryPrefix = family?.ordinaryPrefixes.get(run.runId);
	if (ordinaryPrefix) {
		const expected = new Set([...allMembers, ordinaryPrefix, root.specId]);
		if (compiled.tasks.length !== expected.size || run.tasks.length !== expected.size ||
			compiled.tasks.map(evidenceObject).some(task => typeof task.id !== "string" || !expected.has(task.id)) ||
			run.tasks.some(task => !expected.has(task.specId)))
			throw new Error("original mixed Goal executable inventory mismatch");
	}
	const receiptDirectory = relative(candidate.runDir, join(cwd, dirname(root.files.result), "goal-evidence"));
	if (receiptDirectory.startsWith("..") || isAbsolute(receiptDirectory)) throw new Error("foreign Goal evidence reference");
	const oracleRefs: string[] = [];
	const oracleByGeneration = new Map<number, { path: string; evidence: Record<string, unknown> }>();
	let settledRequests = 0;
	const requestTaskIds = new Map<string, string>();
	for (const task of run.tasks) {
		if (typeof task.files?.result !== "string")
			throw new Error("ordinary Goal request task owner is unmapped");
		const taskDirectory = relative(candidate.runDir, dirname(resolve(cwd, task.files.result)));
		if (!taskDirectory || taskDirectory.startsWith("..") || isAbsolute(taskDirectory))
			throw new Error("ordinary Goal request task owner is unmapped");
		if (requestTaskIds.has(taskDirectory))
			throw new Error("ordinary Goal request task owner is ambiguous");
		requestTaskIds.set(taskDirectory, task.taskId);
	}
	for (const [path] of files) {
		if (path.startsWith(`${receiptDirectory}/`)) {
			const receipt = json(path), evidence = evidenceObject(receipt.evidence);
			const generation = typeof evidence.generation === "number" ? evidence.generation : -1;
			const expectedGeneration = generations[generation];
			if (receipt.schema !== "goal-oracle-receipt-v1" || receipt.digest !== workflowDefinitionFingerprint(evidence) ||
				basename(path) !== `${receipt.digest}.json` || evidence.schema !== "goal-oracle-observation-v1" ||
				evidence.runId !== run.runId ||
				evidence.rootRunId !== (family?.rootRunId ?? run.runId) || !await sameRoot(evidence.cwd) ||
				evidence.policyTaskId !== root.taskId || evidence.policySpecId !== root.specId ||
				evidence.contractHash !== goal.contractHash || evidence.definitionFingerprint !== lineage.definitionFingerprint ||
				!Number.isSafeInteger(generation) || !expectedGeneration ||
				typeof evidence.policyAttemptKey !== "string" || oracleByGeneration.has(generation) ||
				!Array.isArray(evidence.observations) || evidence.observations.length !== definition.goal.criteria.length)
				throw new Error("unknown or foreign immutable oracle evidence");
			const candidateSubjects: { criterionId: string; value: unknown }[] = [];
			for (const [index, observationValue] of evidence.observations.entries()) {
				const observation = evidenceObject(observationValue), criterion = definition.goal.criteria[index], verifier = criterion.verifier;
				const config = evidenceObject(verifier.config);
				if (workflowDefinitionFingerprint(observation.criterion) !== workflowDefinitionFingerprint(criterion) ||
					!["met", "not-met"].includes(String(observation.verdict)) || observation.reason !== null || verifier.kind !== "deterministic" ||
					verifier.producerId !== "json-exact-value-v1" || verifier.target !== "artifact" || verifier.subject.artifact !== "control" ||
					config.comparison !== "canonical-json-equality" || !Object.hasOwn(config, "expected") ||
					!Array.isArray(observation.sources) || observation.sources.length !== 1)
					throw new Error("unsupported or unachieved original oracle");
				const source = evidenceObject(observation.sources[0]), identity = evidenceObject(source.identity);
				const slotTarget = expectedGeneration.slots[verifier.subject.resultSlot];
				const sourceRun = family && typeof slotTarget === "string"
					? family.members.get(slotTarget)?.run ?? run
					: run;
				const sourceSpecId = sourceRun.runId === run.runId
					? slotTarget
					: sourceRun.tasks.find(task => task.kind === "goal")?.specId;
				const worker = sourceRun?.tasks.find(task =>
					task.taskId === identity.taskId && task.specId === identity.specId);
				const value = verifier.subject.path ? readSimpleJsonPath(source.control, verifier.subject.path) : source.control;
				if (!worker || worker.specId !== sourceSpecId || source.taskId !== verifier.subject.resultSlot ||
					identity.runId !== (sourceRun?.runId ?? run.runId) ||
					identity.taskId !== worker.taskId || identity.specId !== worker.specId ||
					value === undefined || source.controlHash !== workflowDefinitionFingerprint(source.control) ||
					observation.expectedHash !== workflowDefinitionFingerprint(config.expected) ||
					observation.valueHash !== workflowDefinitionFingerprint(value) ||
					(observation.verdict === "met") !== (observation.valueHash === observation.expectedHash) ||
					identity.generation !== generation)
					throw new Error("incomplete original oracle source binding");
				candidateSubjects.push({ criterionId: criterion.id, value });
			}
			const met = evidence.observations.every(value => evidenceObject(value).verdict === "met");
			if (met !== (expectedGeneration.outcome === "achieved") ||
				(expectedGeneration.outcome === "not-achieved" && met))
				throw new Error("original oracle outcome mismatch");
			if (expectedGeneration.outcome === "not-achieved" &&
				expectedGeneration.failedCandidateFingerprint !== workflowDefinitionFingerprint(candidateSubjects))
				throw new Error("original oracle failed-candidate history mismatch");
			oracleByGeneration.set(generation, { path, evidence });
			oracleRefs.push(join(dirname(root.files.result), "goal-evidence", basename(path)));
		}
		if (path.includes("/request-reservations/")) {
			const receipt = json(path);
			if (receipt.schema !== "goal-request-reservation-v1" || receipt.phase !== "settled" ||
				typeof receipt.id !== "string" || basename(path) !== `${goalHash(receipt.id)}.json` ||
				!/^[a-f0-9]{64}:/.test(receipt.id) || receipt.id.length > 193 ||
				typeof receipt.authority !== "string" || !/^[a-f0-9]{64}$/.test(receipt.authority) ||
				typeof receipt.commitment !== "string" || !/^[a-f0-9]{64}$/.test(receipt.commitment))
				throw new Error("unknown or unsettled request receipt");
			const owners = [...requestTaskIds.entries()].filter(([directory]) =>
				path.startsWith(`${directory}/artifacts/request-reservations/`));
			if (owners.length !== 1) throw new Error("ordinary Goal request receipt owner is ambiguous");
			const task = run.tasks.find(value => value.taskId === owners[0][1]);
			if (!task) throw new Error("ordinary Goal request receipt owner is unmapped");
			const grants = task.launchAuthority?.records.filter(grant => {
				const state = grant.state;
				if (state.phase !== "consumed" || grant.grant.backendId !== "pi-subagent/headless" ||
					grant.grant.runId !== run.runId || grant.grant.task.taskId !== task.taskId ||
					grant.grant.task.specId !== task.specId) return false;
				return task.durableLaunchBarrier?.records.some(barrier =>
					barrier.attemptKey === grant.grant.attemptKey &&
					["released", "acknowledged"].includes(barrier.phase) && barrier.releaseWinner &&
					!barrier.cancellation && barrier.launchAuthoritySha256 === grant.grant.identitySha256 &&
					barrier.backendRunId === state.backendRunId &&
					barrier.backendAttemptId === state.backendAttemptId &&
					receipt.authority === goalHash({ grant: grant.grant.identitySha256,
						backendRunId: state.backendRunId, backendAttemptId: state.backendAttemptId,
						barrier: barrier.launchAuthoritySha256 }));
			});
			if (grants?.length !== 1)
				throw new Error("ordinary Goal request receipt does not bind its original native attempt");
			if (family && family.requestIds.has(receipt.id))
				throw new Error("duplicate original request receipt");
			family?.requestIds.add(receipt.id);
			if (family) {
				const byTask = family.taskRequestCounts.get(run.runId) ?? new Map<string, number>();
				byTask.set(task.specId, (byTask.get(task.specId) ?? 0) + 1);
				family.taskRequestCounts.set(run.runId, byTask);
			}
			settledRequests++;
		}
		if (path.includes("/candidate-operations/")) {
			const receipt = json(path), intent = evidenceObject(receipt.intent);
			if (intent.schema !== "goal-candidate-operation-v1" || receipt.phase !== "settled" ||
				typeof intent.toolCallId !== "string" || basename(path) !== `${goalHash(intent.toolCallId)}.json` ||
				typeof intent.authority !== "string" || !receipt.result ||
				!["ok", "blocked"].includes(String(evidenceObject(receipt.result).status)))
				throw new Error("unknown or unsettled candidate effect receipt");
			const identity = evidenceObject(intent.identity);
			const generation = typeof identity.generation === "number" ? identity.generation : -1;
			const task = run.tasks.find(value => value.taskId === identity.taskId && value.specId === identity.specId);
			if (!await sameRoot(identity.cwd) || identity.runId !== run.runId ||
				!Number.isSafeInteger(generation) || !generationMembers.get(generation)?.has(String(identity.specId)) ||
				!task || typeof intent.attemptKey !== "string" ||
				!task.launchAuthority?.records.some(record => record.grant.attemptKey === intent.attemptKey &&
					record.grant.task.taskId === task.taskId && record.grant.task.specId === task.specId))
				throw new Error("foreign candidate effect receipt");
			const candidateKey = `${run.runId}\0${task.taskId}\0${intent.attemptKey}\0${intent.toolCallId}`;
			if (family && family.candidateIds.has(candidateKey))
				throw new Error("duplicate original candidate effect receipt");
			family?.candidateIds.add(candidateKey);
		}
	}
	for (const generation of generations) {
		if (!oracleByGeneration.has(generation.generation)) throw new Error("missing immutable original oracle receipt");
	}
	const publication = json(join(policyArtifactDirectory, "control.json"));
	const retainedReferences = publication.retainedEvidenceRefs;
	const refsText = texts.get(join(policyArtifactDirectory, "refs.json"));
	const refsValue: unknown = refsText === undefined ? undefined : JSON.parse(refsText);
	const refs = Array.isArray(refsValue) ? refsValue : evidenceObject(refsValue).refs;
	const finalOracleRef = join(dirname(root.files.result), "goal-evidence",
		basename(oracleByGeneration.get(generations.at(-1)!.generation)!.path));
	const retainedOracleRefs = [...oracleByGeneration.values()].map(value => join(dirname(root.files.result), "goal-evidence", basename(value.path)));
	if (oracleRefs.length !== generations.length ||
		!Array.isArray(publication.evidenceRefs) || publication.evidenceRefs.length !== 1 ||
		publication.evidenceRefs[0] !== finalOracleRef ||
		!Array.isArray(retainedReferences) || retainedReferences.length !== retainedOracleRefs.length ||
		new Set(retainedReferences).size !== retainedOracleRefs.length ||
		retainedOracleRefs.some(path => !retainedReferences.includes(path)) ||
		!Array.isArray(refs) || refs.length !== retainedOracleRefs.length ||
		new Set(refs.map(value => evidenceObject(value).path)).size !== retainedOracleRefs.length ||
		retainedOracleRefs.some(path => !refs.some(value => evidenceObject(value).path === path)))
		throw new Error("Goal oracle publication references mismatch");
	if (family) {
		family.requestsSeen.value += settledRequests;
		if (family.observedUsage.has(run.runId))
			throw new Error("ordinary Goal member request snapshot observed twice");
		family.observedUsage.set(run.runId, goal.usage!.requests!);
	} else if (settledRequests !== goal.usage?.requests) throw new Error("incomplete original request receipt coverage");
	const dynamic = texts.get("dynamic/events.jsonl");
	const events = dynamic === undefined ? [] : parseDynamicEventsText(dynamic);
	if (!family && events.some(event =>
		event.type === "workflow.started" || event.type === "workflow.completed" || event.type === "approval.pending"))
		throw new Error("nested child reservations or approval history unsupported");
	const state = family ? undefined : await readDynamicState(cwd, run.runId);
	if (!family && state && Object.values(state.controllers).some(controller => controller.nestedWorkflowRunIds.length ||
		controller.waitingNestedWorkflowRunIds.length || controller.pendingUiApproval ||
		controller.branches.some(branch => branch.type === "workflow"))) throw new Error("nested workflow reservation unsupported");
	if (family) {
		const children = new Map([...family.members].filter(([, member]) => member.run.parentRunId === run.runId));
		const started = new Map<string, string>(), completed = new Set<string>();
		const order: string[] = [];
		for (const event of events) {
			if (event.type === "approval.pending") throw new Error("unresolved family approval history");
			if (event.type !== "workflow.started" && event.type !== "workflow.completed") continue;
			const payload = evidenceObject(event.payload);
			const id = String(payload.runId), child = children.get(id), marker = child?.run.goalChild;
			if (!child || !marker || event.runId !== run.runId ||
				event.controllerSpecId !== marker.controllerSpecId || event.requestHash !== marker.requestHash ||
				payload.workflowId !== marker.workflowId || !event.opId || completed.has(id))
				throw new Error("foreign or replayed family reservation event");
			if (event.type === "workflow.started") {
				if (started.has(id) && started.get(id) !== event.opId)
					throw new Error("family reservation operation changed");
				if (!["starting", "running"].includes(String(payload.status)))
					throw new Error("unsettled family reservation");
				if (!started.has(id)) {
					const prior = order.at(-1);
					if (prior !== undefined && !completed.has(prior))
						throw new Error("ambiguous or concurrent family child order");
					order.push(id);
					started.set(id, event.opId);
				}
			} else {
				const result = evidenceObject(payload.result);
				if (started.get(id) !== event.opId || result.runId !== id || result.status !== "completed")
					throw new Error("family completion lacks its original reservation");
				completed.add(id);
			}
		}
		if (completed.size !== children.size) throw new Error("missing original family completion");
		const stateText = texts.get("dynamic/state.json");
		const observed = new Set<string>();
		if (stateText !== undefined) {
			const retained = evidenceObject(JSON.parse(stateText));
			if (retained.runId !== run.runId || retained.schema !== "pi-workflow-dynamic-state-v1")
				throw new Error("foreign family controller state");
			for (const [id, value] of Object.entries(evidenceObject(retained.controllers))) {
				const controller = evidenceObject(value);
				if (controller.controllerSpecId !== id || !Array.isArray(controller.nestedWorkflowRunIds) ||
					!Array.isArray(controller.waitingNestedWorkflowRunIds) || controller.waitingNestedWorkflowRunIds.length ||
					controller.pendingUiApproval || !Array.isArray(controller.branches) ||
					controller.branches.some(branch => evidenceObject(branch).type === "workflow"))
					throw new Error("unsettled family controller state");
				for (const childId of controller.nestedWorkflowRunIds) {
					if (typeof childId !== "string" || observed.has(childId) ||
						children.get(childId)?.run.goalChild?.controllerSpecId !== id || !completed.has(childId))
						throw new Error("family controller reservation mismatch");
					observed.add(childId);
				}
			}
		}
		if (observed.size !== children.size) throw new Error("missing original family controller reservation");
		family.childOrder.set(run.runId, order);
	}
	for (const entry of await readdir(workflowsRoot(cwd), { withFileTypes: true })) {
		if (entry.name.startsWith(".prune-")) {
			if (family?.ownedQuarantines.has(join(workflowsRoot(cwd), entry.name))) continue;
			if (pendingQuarantine !== undefined && join(workflowsRoot(cwd), entry.name) === pendingQuarantine &&
				entry.isDirectory() && !entry.isSymbolicLink() &&
				(await readdir(pendingQuarantine)).length === 0) continue;
			throw new Error("workflow recovery residue");
		}
		if (!entry.isDirectory() || !isSafeRunId(entry.name) || entry.name === run.runId) continue;
		const other = await readTerminalCandidate(join(workflowsRoot(cwd), entry.name));
		if (family && family.memberRunIds.has(other.runId)) continue;
		if (other.rootRunId === run.runId || other.parentRunId === run.runId ||
			other.goalChild?.parentRunId === run.runId ||
			other.tasks.some(task => task.goal?.goalId === goal.goalId))
			throw new Error("external workflow Goal reference");
		const eventsFile = join(workflowsRoot(cwd), entry.name, "dynamic", "events.jsonl");
		let text: string;
		try { text = await readFile(eventsFile, "utf8"); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
		if (parseDynamicEventsText(text).some(event => JSON.stringify(event.payload).includes(run.runId)))
			throw new Error("external dynamic workflow reference");
	}
	return workflowDefinitionFingerprint({ root: { path: physicalRoot, dev: rootIdentity.dev, ino: rootIdentity.ino },
		files: [...files].sort(([left], [right]) => left.localeCompare(right)) });
}

interface TerminalGoalFamily {
	hostRoot: string;
	storeRoot: string;
	goalId: string;
	children: string[];
	contractHash: string;
	ownerId: string;
	ownerEpoch: number;
	head: { seq: number; hash: string };
	identity: { dev: number; ino: number };
}

interface GoalRetentionTransaction {
	schema: "pi-goal-retention-transaction-v1";
	transactionId: string;
	state: "prepared" | "detached";
	goals: { goalId: string; hostRoot: string; dev: number; ino: number; contractHash: string; head: { seq: number; hash: string }; quarantine?: string }[];
	workflows: { runId: string; primary: string; dev: number; ino: number; mirror: string; quarantine?: string; mirrorQuarantine?: string }[];
	createdAt: string;
}

async function syncRetentionDirectory(path: string): Promise<void> {
	const handle = await open(path, constants.O_RDONLY);
	try { await handle.sync(); } finally { await handle.close(); }
}

async function publishGoalRetentionTransaction(
	cwd: string,
	transaction: GoalRetentionTransaction,
): Promise<void> {
	const root = workflowsRoot(cwd);
	const target = join(root, `.goal-retention-${transaction.transactionId}.json`);
	const temporary = `${target}.txn`;
	await writeFile(temporary, JSON.stringify(transaction), { mode: 0o600, flag: "wx" });
	try {
		const handle = await open(temporary, constants.O_RDONLY);
		try { await handle.sync(); } finally { await handle.close(); }
		await rename(temporary, target);
		await syncRetentionDirectory(root);
	} finally {
		await unlink(temporary).catch(() => undefined);
	}
}

async function acquireRetentionRunLeases(
	cwd: string,
	runIds: Iterable<string>,
): Promise<Map<string, Awaited<ReturnType<typeof acquireRunFileLease>>>> {
	const leases = new Map<string, Awaited<ReturnType<typeof acquireRunFileLease>>>();
	try {
		for (const runId of [...new Set(runIds)].sort()) {
			const lease = await acquireRunFileLease(cwd, runId, "supervisor");
			if (!lease) throw new Error(`supervisor lease unavailable: ${runId}`);
			leases.set(runId, lease);
		}
		return leases;
	} catch (error) {
		await Promise.all([...leases.values()].reverse().map((lease) => lease!.release()));
		throw error;
	}
}

async function releaseRetentionRunLeases(
	leases: Map<string, Awaited<ReturnType<typeof acquireRunFileLease>>>,
): Promise<void> {
	await Promise.all([...leases.values()].reverse().map((lease) => lease!.release()));
}



async function pruneTerminalGoalFamilies(
	cwd: string,
	options: WorkflowPruneOptions,
	keep: number,
	olderThanDays: number | undefined,
	assertTopologyOwner: () => Promise<void>,
): Promise<WorkflowPruneSummary> {
	const roots = new Set(options.terminalGoalFamilyRoots ?? []);
	const plan = await findRetentionPlan(cwd);
	let families: TerminalGoalFamily[];
	try {
		families = await terminalGoalFamilies(cwd, roots);
	} catch (error) {
		return goalFamilyRefusal(keep, olderThanDays, errorMessage(error));
	}
	if (plan.uncertain)
		return goalFamilyRefusal(keep, olderThanDays, "uncertain current Goal or workflow references");
	const familyChildren = new Set(families.flatMap((family) => family.children));
	const admittedGoalChildren = new Set(familyChildren);
	let expanded = true;
	while (expanded) {
		expanded = false;
		for (const childrenByParent of [plan.children, plan.goalChildren]) {
			for (const [parent, children] of childrenByParent) {
			if (!familyChildren.has(parent) && ![...children].some((child) => familyChildren.has(child)))
				continue;
			if (!familyChildren.has(parent)) {
				familyChildren.add(parent);
				expanded = true;
			}
			for (const child of children)
				if (!familyChildren.has(child)) {
					familyChildren.add(child);
					expanded = true;
				}
			}
		}
	}
	for (const [runId, references] of plan.currentGoalReferences) {
		if (!familyChildren.has(runId)) continue;
		if ([...references].some((goalId) => !roots.has(goalId)))
			return goalFamilyRefusal(keep, olderThanDays, `external retained Goal reference for ${runId}`);
	}
	for (const family of families)
		for (const child of family.children) {
			const goals = plan.currentGoalReferences.get(child) ?? new Set<string>();
			goals.add(family.goalId);
			plan.currentGoalReferences.set(child, goals);
		}
	const candidates = new Map(plan.candidates.map((candidate) => [candidate.run.runId, candidate]));
	if ([...familyChildren].some((id) => !candidates.has(id)))
		return goalFamilyRefusal(keep, olderThanDays, "Goal family has nonterminal or missing workflow member");
	for (const runId of familyChildren) {
		const bindings = taskGoalIds(candidates.get(runId)!.run);
		if (bindings === undefined)
			return goalFamilyRefusal(keep, olderThanDays, `Goal task binding is malformed: ${runId}`);
		for (const goalId of bindings.keys())
			if (!roots.has(goalId))
				return goalFamilyRefusal(
					keep,
					olderThanDays,
					`workflow family member ${runId} references retained Goal ${goalId}`,
				);
	}
	for (const candidate of [...familyChildren].map((id) => candidates.get(id)!)) {
		if (await isWorkflowRunLeaseLive(cwd, candidate.run.runId))
			return goalFamilyRefusal(keep, olderThanDays, `live or indeterminate supervisor lease: ${candidate.run.runId}`);
	}
	const transactionId = randomUUID();
	const createdAt = new Date().toISOString();
	let transactionRows: WorkflowPruneRun[] = [];
	const close = async (): Promise<WorkflowPruneSummary> => {
		return withGoalHostWriteLocks(
			families.flatMap((family) => [family.hostRoot, dirname(family.storeRoot)]),
			async (markWriting) => {
			await assertTopologyOwner();
			// Every source observation is reloaded under the actual writer leases.
			families = await terminalGoalFamilies(cwd, roots);
			const leases = await acquireRetentionRunLeases(cwd, familyChildren);
			try {
				for (const lease of leases.values()) await lease!.assertOwner();
				const recheckedFamilies = await terminalGoalFamilies(cwd, roots);
				const recheckedChildren = new Set(
					recheckedFamilies.flatMap((family) => family.children),
				);
				if (
					recheckedChildren.size !== admittedGoalChildren.size ||
					[...recheckedChildren].some((id) => !admittedGoalChildren.has(id))
				)
					throw new Error("Goal family child references changed under lease");
				if (
					recheckedFamilies.length !== families.length ||
					recheckedFamilies.some((next) => {
						const prior = families.find((family) => family.goalId === next.goalId);
						return !prior ||
							prior.hostRoot !== next.hostRoot ||
							prior.identity.dev !== next.identity.dev ||
							prior.identity.ino !== next.identity.ino ||
							prior.contractHash !== next.contractHash ||
							prior.ownerId !== next.ownerId ||
							prior.ownerEpoch !== next.ownerEpoch ||
							prior.head.seq !== next.head.seq ||
							prior.head.hash !== next.head.hash;
					})
				)
					throw new Error("Goal family identity changed under lease");
				families = recheckedFamilies;
				const recheckedPlan = await findRetentionPlan(cwd);
				if (recheckedPlan.uncertain)
					throw new Error("current Goal or workflow references became uncertain under lease");
				for (const runId of familyChildren) {
					const refs = recheckedPlan.currentGoalReferences.get(runId) ?? new Set<string>();
					if ([...refs].some((goalId) => !roots.has(goalId)))
						throw new Error(`external retained Goal reference for ${runId}`);
				}
				for (const family of families) markWriting(family.hostRoot);
				for (const family of families) {
					await publishGoalRetentionClosure(family.hostRoot, {
						schema: "pi-goal-retention-closure-v1",
						state: "prepared",
						transactionId,
						goalId: family.goalId,
						contractHash: family.contractHash,
						ownerId: family.ownerId,
						ownerEpoch: family.ownerEpoch,
						head: family.head,
						workflowRunIds: [...familyChildren].sort(),
						createdAt,
					});
				}
				const rows: WorkflowPruneRun[] = [];
				transactionRows = rows;
				const quarantines: Quarantine[] = [];
				const transaction: GoalRetentionTransaction = {
					schema: "pi-goal-retention-transaction-v1",
					transactionId,
					state: "prepared",
					goals: await Promise.all(families.map(async (family) => {
						const identity = await lstat(family.hostRoot);
						if (!identity.isDirectory() || identity.isSymbolicLink())
							throw new Error(`Goal family ${family.goalId} host root changed`);
						return {
							goalId: family.goalId,
							hostRoot: family.hostRoot,
							dev: identity.dev,
							ino: identity.ino,
							contractHash: family.contractHash,
							head: family.head,
						};
					})),
					workflows: [...familyChildren].sort().map((runId) => {
						const candidate = candidates.get(runId)!;
						return {
							runId,
							primary: candidate.runDir,
							dev: candidate.identity.dev,
							ino: candidate.identity.ino,
							mirror: candidate.mirrorDir,
						};
					}),
					createdAt,
				};
				await publishGoalRetentionTransaction(cwd, transaction);
				for (const candidate of childrenFirst(
					[...familyChildren].map((id) => candidates.get(id)!),
					plan.children,
					plan.goalChildren,
				)) {
					const entry: WorkflowPruneRun = {
						runId: candidate.run.runId,
						status: candidate.run.status,
						updatedAt: candidate.run.updatedAt,
						bytes: candidate.bytes,
						selected: true,
						protected: false,
						deleted: false,
					};
					const outcome = await deleteCandidate(cwd, candidate, async () => {
						await assertTopologyOwner();
						await leases.get(candidate.run.runId)!.assertOwner();
						return undefined;
					}, leases.get(candidate.run.runId)!, quarantines);
					Object.assign(entry, outcome);
					rows.push(entry);
				}
				if (rows.some((row) => !row.detached))
					throw new Error("Goal family workflow detach incomplete; prepared closure retained");
				const goalQuarantines: Quarantine[] = [];
				for (const family of families) {
					goalQuarantines.push(await detachClosedGoalStore(family, transactionId));
				}
				await beforeGoalRetentionDetachCommitForTests?.();
				// This is the durable detach-all commit point: workflow index and
				// every Goal host marker record that all identities are detached.
				await updateIndex(cwd);
				await publishGoalRetentionTransaction(cwd, {
					...transaction,
					state: "detached",
					goals: transaction.goals.map((goal) => ({
						...goal,
						quarantine: goalQuarantines.find((quarantine) =>
							quarantine.directory.startsWith(goal.hostRoot),
						)?.directory,
					})),
					workflows: transaction.workflows.map((workflow) => ({
						...workflow,
						quarantine: rows.find((row) =>
							row.runId === workflow.runId,
						)?.retainedEvidencePath,
						mirrorQuarantine: rows.find((row) =>
							row.runId === workflow.runId,
						)?.retainedMirrorPath,
					})),
				});
				await afterGoalRetentionDetachCommitForTests?.();
				for (const family of families) {
					await completeGoalRetentionClosure(family.hostRoot, {
						schema: "pi-goal-retention-closure-v1",
						state: "detached",
						transactionId,
						goalId: family.goalId,
						contractHash: family.contractHash,
						ownerId: family.ownerId,
						ownerEpoch: family.ownerEpoch,
						head: family.head,
						workflowRunIds: [...familyChildren].sort(),
						createdAt,
					});
				}
				for (const quarantine of quarantines)
					await rm(quarantine.container, { recursive: true, force: true });
				for (const quarantine of goalQuarantines)
					await rm(quarantine.container, { recursive: true, force: true });
				for (const family of families) {
					await completeGoalRetentionClosure(family.hostRoot, {
						schema: "pi-goal-retention-closure-v1",
						state: "complete",
						transactionId,
						goalId: family.goalId,
						contractHash: family.contractHash,
						ownerId: family.ownerId,
						ownerEpoch: family.ownerEpoch,
						head: family.head,
						workflowRunIds: [...familyChildren].sort(),
						createdAt,
					});
				}
				for (const row of rows) {
					row.retainedEvidencePath = undefined;
					row.retainedMirrorPath = undefined;
					row.purged = true;
					row.deleted = true;
				}
				return {
					dryRun: false,
					keep,
					...(olderThanDays === undefined ? {} : { olderThanDays }),
					runs: rows,
					totalBytes: rows.reduce((total, row) => total + row.bytes, 0),
					deletedBytes: rows.reduce((total, row) => total + (row.deleted ? row.bytes : 0), 0),
					indexUpdated: true,
				};
			} finally {
				await releaseRetentionRunLeases(leases);
			}
			},
		);
	};
	try {
		return await close();
	} catch (error) {
		if (transactionRows.length) {
			return {
				dryRun: false,
				keep,
				...(olderThanDays === undefined ? {} : { olderThanDays }),
				runs: transactionRows,
				totalBytes: transactionRows.reduce((total, row) => total + row.bytes, 0),
				deletedBytes: 0,
				indexUpdated: transactionRows.some((row) => row.detached),
				error: errorMessage(error),
			};
		}
		return goalFamilyRefusal(keep, olderThanDays, errorMessage(error));
	}
}

function goalFamilyRefusal(
	keep: number,
	olderThanDays: number | undefined,
	error: string,
): WorkflowPruneSummary {
	return {
		dryRun: false,
		keep,
		...(olderThanDays === undefined ? {} : { olderThanDays }),
		runs: [],
		totalBytes: 0,
		deletedBytes: 0,
		indexUpdated: false,
		error,
	};
}

async function terminalGoalFamilies(
	cwd: string,
	roots: Set<string>,
): Promise<TerminalGoalFamily[]> {
	const current = join(cwd, ".pi", "goals", "current");
	const currentReal = await physicalRetentionRoot(current);
	const result: TerminalGoalFamily[] = [];
	for (const goalId of roots) {
		const hostRoot = join(current, goalId);
		const hostInfo = await lstat(hostRoot);
		if (!hostInfo.isDirectory() || hostInfo.isSymbolicLink() ||
			!isInside(currentReal, await realpath(hostRoot)))
			throw new Error(`Goal family ${goalId} host root is unsafe`);
		if (await hasGoalTransactionResidue(hostRoot))
			throw new Error(`Goal family ${goalId} has transaction residue`);
		const direct = new GoalStore(hostRoot).load();
		let storeRoot = hostRoot;
		let snapshot = await direct;
		if (snapshot.status === "missing") {
			storeRoot = join(hostRoot, "goal");
			snapshot = await new GoalStore(storeRoot).load();
		} else {
			try {
				const nested = await lstat(join(hostRoot, "goal"));
				if (nested.isDirectory()) throw new Error(`Goal family ${goalId} has dual layouts`);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		if (
			snapshot.status !== "ok" ||
			snapshot.contract.goalId !== goalId ||
			snapshot.evidence.length ||
			!["achieved", "failed", "cancelled"].includes(snapshot.decision.lifecycle) ||
			snapshot.decision.pendingEffects.length ||
			!snapshot.events.at(-1)?.observations.effectsKnown ||
			snapshot.events.at(-1)!.observations.effects.some(
				(effect) => effect.state !== "drained",
			) ||
			(await readGoalRetentionClosure(hostRoot)) !== null
		)
			throw new Error(`Goal family ${goalId} is not terminal and drained`);
		await assertGoalHostEffectsDrained(hostRoot, storeRoot, snapshot);
		const references = goalAdmittedChildReferences(snapshot, storeRoot);
		if (references.uncertain) throw new Error(`Goal family ${goalId} child references are uncertain`);
		result.push({
			hostRoot,
			storeRoot,
			goalId,
			children: references.runIds,
			contractHash: goalHash(snapshot.currentContract),
			ownerId: snapshot.ownerId,
			ownerEpoch: snapshot.epoch,
			head: { seq: snapshot.seq, hash: snapshot.hash },
			identity: { dev: hostInfo.dev, ino: hostInfo.ino },
		});
	}
	return result;
}

async function hasGoalTransactionResidue(root: string): Promise<boolean> {
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (entry.name.startsWith(".txn-") || entry.name.endsWith(".txn"))
			return true;
		if (entry.isSymbolicLink()) throw new Error("Goal host contains symlink");
		if (entry.isDirectory() && await hasGoalTransactionResidue(join(root, entry.name)))
			return true;
	}
	return false;
}

/** Detaches the entire selected Goal host namespace. Callers retain the
 * quarantine as recovery evidence until the detached transaction commits. */
async function detachClosedGoalStore(
	family: TerminalGoalFamily,
	transactionId: string,
): Promise<Quarantine> {
	const identity = await lstat(family.hostRoot);
	if (
		!identity.isDirectory() ||
		identity.isSymbolicLink() ||
		identity.dev !== family.identity.dev ||
		identity.ino !== family.identity.ino
	)
		throw new Error(`Goal family ${family.goalId} host root changed before detach`);
	const quarantine = join(
		family.hostRoot,
		`.goal-retention-quarantine-${transactionId}`,
	);
	await mkdir(quarantine, { mode: 0o700 });
	for (const entry of await readdir(family.hostRoot)) {
		if (
			entry === ".goal-host-write-lock" ||
			entry === ".goal-retention-closed.json" ||
			entry === basename(quarantine)
		)
			continue;
		await rename(join(family.hostRoot, entry), join(quarantine, entry));
	}
	return { container: quarantine, directory: quarantine };
}

export function formatWorkflowPruneSummary(summary: WorkflowPruneSummary): string {
	const lines = [summary.dryRun ? "Workflow prune (dry run)" : "Workflow prune"];
	if (summary.runs.length === 0) {
		lines.push("No terminal runs are beyond the retention filters.");
	} else {
		lines.push(summary.dryRun ? "Runs that would be deleted:" : "Runs selected for deletion:");
		for (const run of summary.runs) {
			lines.push(
				`- ${run.runId} ${run.name ?? "(unnamed)"} ${run.status} ${run.updatedAt} ${run.bytes} bytes${run.protected ? ` — protected: ${run.error}` : run.error ? ` — ${run.error}` : run.deleted ? " — deleted" : ""}`,
			);
			if (run.retainedEvidencePath) lines.push(`  Retained run evidence: ${run.retainedEvidencePath}`);
			if (run.retainedMirrorPath) lines.push(`  Retained mirror evidence: ${run.retainedMirrorPath}`);
		}
	}
	lines.push(`Total bytes: ${summary.totalBytes} (logical file bytes; hard links counted once, so du may report more)`);
	if (!summary.dryRun) lines.push(`Deleted bytes: ${summary.deletedBytes}`);
	if (summary.error) lines.push(`Error: ${summary.error}`);
	return lines.join("\n");
}

async function findRetentionPlan(cwd: string, pendingQuarantine?: string, family?: OrdinaryGoalFamilyContext): Promise<RetentionPlan> {
	const plan: RetentionPlan = {
		candidates: [],
		children: new Map(),
		goalChildren: new Map(),
		currentGoalReferences: new Map(),
		ordinaryGoalEvidence: new Set(),
		uncertain: false,
	};
	const goalParents: GoalParents = new Map();
	const root = workflowsRoot(cwd);
	const rootReal = await physicalRetentionRoot(root).catch(() => undefined);
	if (!rootReal) return plan;
	const entries = await readdir(root, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.name.startsWith(".goal-retention-")) {
			const own = family?.transaction;
			if (own?.path === join(root, entry.name)) {
				const handle = await open(own.path, constants.O_RDONLY | constants.O_NOFOLLOW);
				try {
					if (!sameRawVersion(own.version, await handle.stat()) ||
						await handle.readFile("utf8") !== own.bytes ||
						!sameRawVersion(own.version, await handle.stat()) ||
						!sameRawVersion(own.version, await lstat(own.path)))
						throw new Error("owned retention transaction changed");
				} finally { await handle.close(); }
				continue;
			}
			// Retention transactions are permanent recovery evidence, never
			// generic workspace metadata that a subsequent prune may ignore.
			plan.uncertain = true;
			continue;
		}
		const quarantine = entry.name.startsWith(".prune-");
		if (!quarantine && !isSafeRunId(entry.name)) continue;
		// Ordinary root metadata (index, lock) is not a run directory.
		if (!quarantine && entry.isFile()) continue;
		const runDir = join(root, entry.name, ...(quarantine ? ["run"] : []));
		try {
			// Only this deletion's freshly allocated, still-empty container has
			// no record yet. All other quarantines remain reference evidence.
			if (quarantine && pendingQuarantine !== undefined && join(root, entry.name) === pendingQuarantine &&
				entry.isDirectory() && !entry.isSymbolicLink() &&
				(await readdir(pendingQuarantine)).length === 0) continue;
			if (!(await isContainedDirectory(rootReal, runDir))) throw new Error("uncertain run directory");
			const run = await readTerminalCandidate(runDir);
			if (!isSafeRunId(run.runId) || (!quarantine && run.runId !== entry.name) ||
				(run.parentRunId !== undefined && !isSafeRunId(run.parentRunId)) ||
				(run.rootRunId !== undefined && !isSafeRunId(run.rootRunId)) ||
				(!run.parentRunId && run.rootRunId !== undefined && run.rootRunId !== run.runId)) throw new Error("uncertain run identity");
			let referenceId = entry.name;
			const own = family?.ownedPrimary.get(run.runId);
			if (quarantine && own?.directory === runDir) {
				const expected = family!.members.get(run.runId)!.identity;
				const actual = await lstat(runDir);
				if (actual.dev !== expected.dev || actual.ino !== expected.ino ||
					own.container !== dirname(runDir) ||
					(await readdir(own.container)).join() !== "run")
					throw new Error("owned primary quarantine identity changed");
				referenceId = run.runId;
			}
			if (run.parentRunId) {
				const children = plan.children.get(run.parentRunId) ?? new Set<string>();
				children.add(referenceId);
				plan.children.set(run.parentRunId, children);
			}
			if (hasOrdinaryGoalEvidence(run)) {
				plan.ordinaryGoalEvidence.add(entry.name);
				if (run.rootRunId) plan.ordinaryGoalEvidence.add(run.rootRunId);
			}
			const goalIds = taskGoalIds(run);
			if (goalIds === undefined) {
				plan.uncertain = true;
				continue;
			}
			for (const [goalId, hashes] of goalIds) {
				const byHash = goalParents.get(goalId) ?? new Map<string, Set<string>>();
				for (const hash of hashes) {
					const parents = byHash.get(hash) ?? new Set<string>();
					parents.add(run.runId);
					byHash.set(hash, parents);
				}
				goalParents.set(goalId, byHash);
			}
			if (quarantine || !isTerminalWorkflowStatus(run.status) || !Number.isFinite(Date.parse(run.updatedAt))) continue;
			const mirrorDir = join(cwd, ".pi", "workflow-subagents", entry.name);
			const seen = new Set<string>();
			const bytes = (await directoryBytes(runDir, seen)) + (await containedDirectoryBytes(cwd, mirrorDir, seen));
			plan.candidates.push({ run, runDir, mirrorDir, bytes, identity: await lstat(runDir) });
		} catch {
			// An unreadable record may reference ANY candidate. Do not guess.
			plan.uncertain = true;
		}
	}
	await addGoalChildReferences(cwd, goalParents, plan);
	// Retaining evidence also retains its ancestry and descendants. A selected
	// ordinary Goal child must not make its parent appear disposable in preview.
	let expanded = true;
	while (expanded) {
		expanded = false;
		for (const [parent, children] of plan.children) {
			if (!plan.ordinaryGoalEvidence.has(parent) &&
				![...children].some(child => plan.ordinaryGoalEvidence.has(child))) continue;
			for (const id of [parent, ...children]) {
				if (plan.ordinaryGoalEvidence.has(id)) continue;
				plan.ordinaryGoalEvidence.add(id);
				expanded = true;
			}
		}
	}
	return plan;
}

function hasOrdinaryGoalEvidence(run: WorkflowRunRecord): boolean {
	// These are retention hints only, never admission or resume authority.
	// Presence protects even null/partial markers from an interrupted writer.
	return Object.hasOwn(run, "goalChild") || Object.hasOwn(run, "goalParticipation") || run.tasks.some(task =>
		Object.hasOwn(task, "goalRoot") || Object.hasOwn(task, "goalParticipation") ||
		(typeof task.goal?.state === "string" && task.goal.state.startsWith("engine:")) ||
		(typeof task.goal?.goalId === "string" && task.goal.goalId.startsWith("goal_engine_")));
}

function taskGoalIds(run: WorkflowRunRecord): Map<string, Set<string>> | undefined {
	const ids = new Map<string, Set<string>>();
	for (const task of run.tasks) {
		if (task.goal === undefined) continue;
		if (
			!task.goal ||
			typeof task.goal.goalId !== "string" ||
			typeof task.goal.contractHash !== "string" ||
			task.goal.goalId.length === 0 ||
			!/^[a-f0-9]{64}$/.test(task.goal.contractHash)
		)
			return undefined;
		const hashes = ids.get(task.goal.goalId) ?? new Set<string>();
		hashes.add(task.goal.contractHash);
		ids.set(task.goal.goalId, hashes);
	}
	return ids;
}

async function addGoalChildReferences(
	cwd: string,
	goalParents: GoalParents,
	plan: RetentionPlan,
): Promise<void> {
	const root = join(cwd, ".pi", "goals", "current");
	let rootReal: string;
	try {
		rootReal = await physicalRetentionRoot(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		plan.uncertain = true;
		return;
	}
	try {
		for (const entry of await readdir(root, { withFileTypes: true })) {
			if (
				entry.name === ".goal-host-write-lock" &&
				entry.isDirectory() &&
				!entry.isSymbolicLink() &&
				await hasCurrentGoalHostWriteLease(root)
			)
				continue;
			if (!entry.isDirectory() || entry.isSymbolicLink())
				throw new Error("invalid current Goal directory");
			const directory = join(root, entry.name);
			const closed = await readGoalRetentionClosure(directory);
			if (closed === "uncertain") throw new Error("Goal closure marker uncertain");
			if (closed?.state === "complete") {
				if (closed.goalId !== entry.name)
					throw new Error("Goal closure marker root identity mismatch");
				continue;
			}
			if (closed !== null) throw new Error("Goal closure remains prepared");
			let locator = directory;
			let snapshot = await new GoalStore(locator).load();
			if (snapshot.status !== "ok") {
				const nested = join(directory, "goal");
				const nestedInfo = await lstat(nested);
				if (!nestedInfo.isDirectory() || nestedInfo.isSymbolicLink())
					throw new Error("Goal locator unreadable");
				locator = nested;
				snapshot = await new GoalStore(locator).load();
			} else {
				try {
					const nested = await lstat(join(directory, "goal"));
					if (nested.isDirectory()) throw new Error("Goal locator has dual layouts");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			}
			if (!isInside(rootReal, await realpath(locator)))
				throw new Error("Goal locator outside current root");
			if (
				snapshot.status !== "ok" ||
				snapshot.contract.goalId !== entry.name ||
				snapshot.evidence.length
			)
				throw new Error("Goal locator unreadable");
			const references = goalAdmittedChildReferences(snapshot, locator);
			if (references.uncertain) throw new Error("Goal child journal unresolved");
			for (const child of references.runIds) {
				const goals = plan.currentGoalReferences.get(child) ?? new Set<string>();
				goals.add(entry.name);
				plan.currentGoalReferences.set(child, goals);
			}
			const parents = new Set<string>();
			const hashes = new Set([
				goalHash(snapshot.contract),
				goalHash(snapshot.currentContract),
			]);
			for (const [hash, referencedBy] of goalParents.get(entry.name) ?? [])
				if (hashes.has(hash))
					for (const parent of referencedBy) parents.add(parent);
				else throw new Error("Goal task contract locator mismatch");
			for (const child of references.runIds) {
				for (const parent of parents) {
					const children = plan.goalChildren.get(parent) ?? new Set<string>();
					children.add(child);
					plan.goalChildren.set(parent, children);
				}
			}
		}
	} catch {
		// Every current Goal is retained reader evidence until an explicit,
		// atomic Goal-family operation exists.
		plan.uncertain = true;
	}
}

function childrenFirst(
	candidates: Candidate[],
	children: Map<string, Set<string>>,
	goalChildren: Map<string, Set<string>>,
): Candidate[] {
	const selected = new Map(candidates.map((candidate) => [candidate.run.runId, candidate]));
	const pending = new Map<string, number>();
	const parents = new Map<string, Set<string>>();
	for (const runId of selected.keys()) {
		const childIds = [...new Set([
			...(children.get(runId) ?? []),
			...(goalChildren.get(runId) ?? []),
		])].filter((id) => selected.has(id));
		pending.set(runId, childIds.length);
		for (const child of childIds) {
			const childParents = parents.get(child) ?? new Set<string>();
			childParents.add(runId);
			parents.set(child, childParents);
		}
	}
	const queue = candidates.filter((candidate) => pending.get(candidate.run.runId) === 0);
	const visited = new Set<string>();
	for (let index = 0; index < queue.length; index += 1) {
		const candidate = queue[index];
		visited.add(candidate.run.runId);
		for (const parent of parents.get(candidate.run.runId) ?? []) {
			pending.set(parent, pending.get(parent)! - 1);
			if (pending.get(parent) === 0) queue.push(selected.get(parent)!);
		}
	}
	// Cycles remain protected by their references, rather than being omitted.
	return [...queue, ...candidates.filter((candidate) => !visited.has(candidate.run.runId))];
}

async function retainedChildReason(
	cwd: string,
	runId: string,
	plan: RetentionPlan,
	purged: Set<string>,
	selected: Set<string>,
	planOnly: boolean,
	isolatedOrdinaryClosure = false,
): Promise<string | undefined> {
	if (!isolatedOrdinaryClosure && plan.ordinaryGoalEvidence.has(runId))
		return "retained ordinary Goal evidence or related workflow";
	const goalIds = plan.currentGoalReferences.get(runId);
	if (goalIds?.size)
		return `current Goal reference: ${[...goalIds].sort().join(", ")}`;
	if (plan.uncertain) return "uncertain run references";
	for (const child of plan.children.get(runId) ?? []) {
		if (!purged.has(child) && !(planOnly && selected.has(child)))
			return `retained direct child: ${child}`;
		// A selected child was purged, but its canonical name may have been
		// recreated. Never remove its ancestor based on the old generation.
		try {
			await lstat(join(workflowsRoot(cwd), child));
			return `recreated direct child: ${child}`;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return `uncertain direct child: ${child}`;
		}
	}
	for (const child of plan.goalChildren.get(runId) ?? []) {
		// Current Goal stores are retained reader evidence. Their lifecycle is
		// deliberately outside ordinary workflow pruning.
		return `retained Goal child: ${child}`;
	}
	for (const [parent, children] of plan.goalChildren) {
		if (parent === runId || !children.has(runId)) continue;
		return `current Goal reference: ${parent}`;
	}
	return undefined;
}

type DeletionOutcome = Pick<WorkflowPruneRun, "deleted" | "detached" | "purged" | "protected" | "error" | "retainedEvidencePath" | "retainedMirrorPath">;

async function deleteCandidate(
	cwd: string,
	candidate: Candidate,
	recheckReferences: (pendingQuarantine?: string, mirror?: Quarantine) => Promise<string | undefined>,
	heldLease?: Awaited<ReturnType<typeof acquireRunFileLease>>,
	deferredQuarantines?: Quarantine[],
): Promise<DeletionOutcome> {
	const root = workflowsRoot(cwd);
	let lease: Awaited<ReturnType<typeof acquireRunFileLease>>;
	const outcome: DeletionOutcome = { deleted: false, detached: false, purged: false, protected: false };
	let primary: Quarantine | undefined;
	let mirror: Quarantine | undefined;
	try {
		await physicalRetentionRoot(root);
		const identity = await lstat(candidate.runDir);
		if (!identity.isDirectory() || identity.isSymbolicLink() ||
			identity.dev !== candidate.identity.dev || identity.ino !== candidate.identity.ino)
			throw new Error("run directory changed since selection");
		if (!heldLease && await isWorkflowRunLeaseLive(cwd, candidate.run.runId))
			return { ...outcome, protected: true, error: "live or indeterminate supervisor lease" };
		lease = heldLease ?? await acquireRunFileLease(cwd, candidate.run.runId, "supervisor");
		if (!lease) return { ...outcome, protected: true, error: "supervisor lease acquired concurrently" };
		const current = await readTerminalCandidate(candidate.runDir);
		if (current.runId !== candidate.run.runId || current.updatedAt !== candidate.run.updatedAt ||
			!isTerminalWorkflowStatus(current.status))
			return { ...outcome, protected: true, error: "run changed since selection" };
		const reason = await recheckReferences();
		if (reason) return { ...outcome, protected: true, error: reason };
		await lease.assertOwner();
		// No irreversible removal until BOTH generations are safely detached.
		mirror = await quarantineContainedDirectory(join(cwd, ".pi", "workflow-subagents"), candidate.mirrorDir);
		outcome.retainedMirrorPath = mirror?.directory;
		await beforePrimaryDetachForTests?.();
		await lease.assertOwner();
		const finalReason = await recheckReferences(undefined, mirror);
		if (finalReason) {
			outcome.protected = true;
			throw new Error(finalReason);
		}
		primary = await quarantineContainedDirectory(root, candidate.runDir, candidate.identity, async (container) => {
			await lease!.assertOwner();
			const reason = await recheckReferences(container, mirror);
			if (reason) {
				outcome.protected = true;
				throw new Error(reason);
			}
		});
		if (!primary) throw new Error("selected run disappeared before detach");
		outcome.detached = true;
		outcome.retainedEvidencePath = primary.directory;
		await afterQuarantineForTests?.();
		if (deferredQuarantines) {
			if (mirror) deferredQuarantines.push(mirror);
			deferredQuarantines.push(primary);
			return outcome;
		}
		if (mirror) {
			await rm(mirror.container, { recursive: true, force: true });
			outcome.retainedMirrorPath = undefined;
		}
		await rm(primary.container, { recursive: true, force: true });
		outcome.retainedEvidencePath = undefined;
		outcome.purged = true;
		outcome.deleted = true;
	} catch (error) {
		outcome.error = errorMessage(error);
	} finally {
		try { if (!heldLease) await lease?.release(); }
		catch (error) { outcome.error = `${outcome.error ? `${outcome.error}; ` : ""}lease release failed: ${errorMessage(error)}`; }
	}
	return outcome;
}

async function readTerminalCandidate(runDir: string): Promise<WorkflowRunRecord> {
	const file = join(runDir, "run.json");
	const info = await lstat(file);
	if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("unsafe run record");
	const run = JSON.parse(await readFile(file, "utf8")) as WorkflowRunRecord;
	const statuses = new Set(["pending", "running", "blocked", "completed", "failed", "skipped", "interrupted"]);
	if (!Array.isArray(run.tasks) || !run.tasks.every(task => task && statuses.has(task.status)))
		throw new Error("invalid task statuses");
	return deriveRunStatus(run);
}

async function physicalRetentionRoot(root: string): Promise<string> {
	// cwd has been canonicalized, but application-owned ancestors must never
	// be canonicalized through a symlink into an unrelated retention tree.
	for (const path of [resolve(root, ".."), root]) {
		const info = await lstat(path);
		if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe retention root");
	}
	const physical = await realpath(root);
	if (physical !== resolve(root)) throw new Error("retention root changed");
	return physical;
}

interface Quarantine { container: string; directory: string }

async function quarantineContainedDirectory(
	root: string, directory: string, identity?: { dev: number; ino: number },
	commitFence?: (container: string) => Promise<void>,
): Promise<Quarantine | undefined> {
	let rootReal: string;
	try {
		rootReal = await physicalRetentionRoot(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	let info;
	try {
		info = await lstat(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("path is not a real directory");
	if (identity && (info.dev !== identity.dev || info.ino !== identity.ino)) throw new Error("run directory changed since selection");
	const directoryReal = await realpath(directory);
	if (!isInside(rootReal, directoryReal)) throw new Error("path is outside retention root");
	// Detach the selected generation before recursive removal can unlink its
	// supervisor.lock. An unlocked/recreated original name is not our target.
	// The container has no run.json, so index readers ignore it during removal.
	const container = await mkdtemp(join(rootReal, ".prune-"));
	const detached = join(container, "run");
	let moved = false;
	try {
		await physicalRetentionRoot(root);
		const current = await lstat(directory);
		if (current.dev !== info.dev || current.ino !== info.ino) throw new Error("directory changed before quarantine");
		await commitFence?.(container);
		await rename(directory, detached);
		moved = true;
		return { container, directory: detached };
	} catch (error) {
		if (!moved) await rm(container, { recursive: true, force: true }).catch(() => undefined);
		throw new Error(`${errorMessage(error)}${moved ? `; detached evidence retained at ${detached}` : ""}`);
	}
}

async function containedDirectoryBytes(cwd: string, directory: string, seen: Set<string>): Promise<number> {
	const root = join(cwd, ".pi", "workflow-subagents");
	try {
		if (!(await isContainedDirectory(await physicalRetentionRoot(root), directory))) return 0;
		return await directoryBytes(directory, seen);
	} catch {
		return 0;
	}
}

async function isContainedDirectory(root: string, directory: string): Promise<boolean> {
	try {
		const info = await lstat(directory);
		if (!info.isDirectory() || info.isSymbolicLink()) return false;
		return isInside(root, await realpath(directory));
	} catch {
		return false;
	}
}

async function directoryBytes(directory: string, seen: Set<string>): Promise<number> {
	async function walk(current: string): Promise<number> {
		const entries = await readdir(current, { withFileTypes: true });
		let total = 0;
		for (const entry of entries) {
			if (entry.isSymbolicLink()) continue;
			const file = join(current, entry.name);
			if (entry.isDirectory()) {
				total += await walk(file);
			} else if (entry.isFile()) {
				const info = await lstat(file);
				const identity = `${info.dev}:${info.ino}`;
				if (!seen.has(identity)) {
					seen.add(identity);
					total += info.size;
				}
			}
		}
		return total;
	}
	return walk(directory).catch(() => 0);
}

function isInside(root: string, child: string): boolean {
	const rel = relative(resolve(root), resolve(child));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) throw new Error("--keep requires a non-negative integer");
	return value;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
