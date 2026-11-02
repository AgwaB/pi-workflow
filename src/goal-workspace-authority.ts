import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isProxy } from "node:util/types";
import { goalHash } from "./goal-contract.js";
import {
	GoalHostEffects,
	type GoalHostEffectCensus,
	type GoalHostEffectOperation,
} from "./goal-host-effects.js";
import {
	assertGoalHostSessionIssuer,
	type GoalHostSessionIssuer,
	type GoalHostSessionLease,
} from "./goal-host-session.js";
import { withGoalHostWriteLock } from "./goal-host-write-lock.js";
import { GoalStore, type GoalStoreOwner, type GoalStoreSnapshot } from "./goal-store.js";
import type { GoalAcceptedObservations } from "./goal-types.js";
import {
	prepareGoalWorkspaceHost,
	type GoalWorkspaceCleanupResult,
	type GoalWorkspaceHostHandle,
	type GoalWorkspaceHostRequest,
	type GoalCandidateReplacementBegin,
	type GoalCandidateReplacementAppend,
	type GoalCandidateReplacementCommit,
	type GoalCandidateReplacementReceipt,
	type GoalSourcePage,
} from "./goal-workspace-host.js";
import type { GoalWorkspaceCandidate } from "./goal-workspace.js";

export interface GoalWorkspaceAuthorityInput {
	readonly hostRoot: string;
	readonly store: GoalStore;
	readonly owner: GoalStoreOwner;
	readonly sessionIssuer: GoalHostSessionIssuer;
	readonly sessionLease: GoalHostSessionLease;
	readonly sessionDigest: string;
	readonly observe: () => Promise<GoalAcceptedObservations>;
	readonly workspace: GoalWorkspaceHostRequest;
	readonly childScope?: Readonly<{
		parentBindingHash: string;
		childId: string;
		runId: string;
		requestHash: string;
		intentId: string;
		intentDigest: string;
	}>;
}

export interface GoalAuthorizedWorkspaceBinding {
	readonly id: string;
	readonly root: string;
	readonly revision: number;
	readonly digest: string;
}

export interface GoalAuthorizedWorkspaceHostHandle extends GoalWorkspaceHostHandle {
	readonly binding: GoalAuthorizedWorkspaceBinding;
}

/**
 * Source-owned physical custody transfer. It permanently fences the admitted
 * workspace writer while retaining its already-inspected files for the origin
 * writer; it is not cleanup and never removes or relabels those files.
 */
export async function retireGoalAuthorizedWorkspace(
	handle: GoalAuthorizedWorkspaceHostHandle,
): Promise<void> {
	const state = AUTHORIZED_STATE.get(handle as object);
	if (!state) throw new Error("Goal workspace retirement requires an authorized handle");
	await state.retire();
}

const AUTHORIZED_HANDLES = new WeakSet<object>();
const AUTHORIZED_STATE = new WeakMap<
	object,
	Readonly<{
		effects: GoalHostEffects;
		inspect(): Promise<GoalHostEffectCensus>;
		retire(): Promise<void>;
		assertExecutionCurrent(): void;
		issuer: GoalHostSessionIssuer;
		lease: GoalHostSessionLease;
		childScope: GoalWorkspaceAuthorityInput["childScope"];
	}>
>();
const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
export function assertGoalAuthorizedWorkspaceExecutionCurrent(value: unknown, expected?: Readonly<{ session: GoalHostSessionIssuer; lease: GoalHostSessionLease }>): void {
	assertGoalAuthorizedWorkspaceHostHandle(value);
	const source = AUTHORIZED_STATE.get(value)!;
	if (expected !== undefined && (source.issuer !== expected.session || source.lease !== expected.lease))
		throw new Error("Goal workspace executor original session or lease differs");
	source.assertExecutionCurrent();
}

function captureChildScope(value: unknown): NonNullable<GoalWorkspaceAuthorityInput["childScope"]> {
	const names = ["parentBindingHash", "childId", "runId", "requestHash", "intentId", "intentDigest"] as const;
	if (value === null || typeof value !== "object" || isProxy(value) ||
		(Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))
		throw new Error("Goal child workspace scope invalid");
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const keys = Reflect.ownKeys(value);
	if (keys.length !== names.length || keys.some((key) => typeof key !== "string" || !names.includes(key as typeof names[number])))
		throw new Error("Goal child workspace scope invalid");
	const record = value as Record<(typeof names)[number], unknown>;
	for (const name of names) {
		const descriptor = descriptors[name];
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
			throw new Error("Goal child workspace scope invalid");
	}
	if (![record.parentBindingHash, record.requestHash, record.intentDigest].every(
		(item) => typeof item === "string" && DIGEST.test(item),
	) || ![record.childId, record.runId, record.intentId].every(
		(item) => typeof item === "string" && ID.test(item),
	))
		throw new Error("Goal child workspace scope invalid");
	return Object.freeze({
		parentBindingHash: record.parentBindingHash as string,
		childId: record.childId as string,
		runId: record.runId as string,
		requestHash: record.requestHash as string,
		intentId: record.intentId as string,
		intentDigest: record.intentDigest as string,
	});
}

function workspaceEffectsRoot(hostRoot: string, workspaceId: string): string {
	return join(
		hostRoot,
		"workspace-effects",
		goalHash({ schema: "goal-workspace-effect-scope-v1", workspaceId }),
	);
}

function workspaceRequestDigest(request: GoalWorkspaceHostRequest): string {
	return goalHash({
		originRoot: resolve(request.originRoot),
		...(request.workspaceRoot === undefined
			? {}
			: { workspaceRoot: resolve(request.workspaceRoot) }),
		workspaceId: request.workspaceId,
		mode: request.mode,
		repository: request.repository,
		scope: [...request.scope],
		protectedPaths: [...(request.protectedPaths ?? [])],
		controlRoots: [...(request.controlRoots ?? [])].map((root) => resolve(root)),
	});
}

function resultDigest(value: unknown): string {
	return goalHash(value);
}

export function assertGoalAuthorizedWorkspaceHostHandle(
	value: unknown,
): asserts value is GoalAuthorizedWorkspaceHostHandle {
	if (
		value === null ||
		typeof value !== "object" ||
		!AUTHORIZED_HANDLES.has(value) ||
		!AUTHORIZED_STATE.has(value)
	)
		throw new Error("Goal authorized workspace handle invalid");
}

export async function inspectGoalAuthorizedWorkspaceEffects(
	handle: GoalAuthorizedWorkspaceHostHandle,
): Promise<GoalHostEffectCensus> {
	assertGoalAuthorizedWorkspaceHostHandle(handle);
	return AUTHORIZED_STATE.get(handle)!.inspect();
}

/** Validate that a live authorized workspace was minted for this exact child. */
export function assertGoalAuthorizedChildWorkspaceScope(
	handle: GoalAuthorizedWorkspaceHostHandle,
	expected: NonNullable<GoalWorkspaceAuthorityInput["childScope"]>,
): void {
	assertGoalAuthorizedWorkspaceHostHandle(handle);
	const captured = AUTHORIZED_STATE.get(handle)!.childScope;
	if (captured === undefined ||
		captured.parentBindingHash !== expected.parentBindingHash ||
		captured.childId !== expected.childId ||
		captured.runId !== expected.runId ||
		captured.requestHash !== expected.requestHash ||
		captured.intentId !== expected.intentId ||
		captured.intentDigest !== expected.intentDigest)
		throw new Error("Goal authorized child workspace scope invalid");
}

/** Cold read-only recovery inspection. It cannot mint workspace authority. */
export async function inspectGoalWorkspaceAuthorityPublication(
	hostRoot: string,
	workspaceId: string,
): Promise<GoalHostEffectCensus> {
	if (!ID.test(workspaceId))
		throw new Error("Goal workspace identifier invalid");
	const canonicalHostRoot = await realpath(resolve(hostRoot));
	const reader = await GoalHostEffects.open(
		workspaceEffectsRoot(canonicalHostRoot, workspaceId),
	);
	return reader.inspect();
}

/**
 * Source-only DP07 bridge. It binds filesystem mechanics to exact process-local
 * Goal owner/session capabilities and a dedicated durable effect ledger. It is
 * not a worker mount, sandbox, production adapter, or runtime qualification.
 */
export async function prepareGoalAuthorizedWorkspaceHost(
	input: GoalWorkspaceAuthorityInput,
): Promise<GoalAuthorizedWorkspaceHostHandle> {
	if (!(input.store instanceof GoalStore))
		throw new Error("Goal workspace authority requires a Goal store");
	assertGoalHostSessionIssuer(input.sessionIssuer);
	input.sessionIssuer.assertCurrent(input.sessionLease);
	if (!DIGEST.test(input.sessionDigest))
		throw new Error("Goal workspace session digest invalid");
	if (!ID.test(input.workspace.workspaceId))
		throw new Error("Goal workspace identifier invalid");
	let childScope: GoalWorkspaceAuthorityInput["childScope"];
	if (input.childScope !== undefined) {
		childScope = captureChildScope(input.childScope);
	}
	if (typeof input.observe !== "function")
		throw new Error("Goal workspace observation port invalid");
	const hostRoot = await realpath(resolve(input.hostRoot));
	const storeHostRoot = await realpath(dirname(input.store.root));
	if (storeHostRoot !== hostRoot)
		throw new Error("Goal workspace and store must share one host lock root");
	const canonicalOriginRoot = await realpath(resolve(input.workspace.originRoot));
	const observe = input.observe;
	const issuer: GoalHostSessionIssuer = input.sessionIssuer;
	const lease: GoalHostSessionLease = input.sessionLease;
	const store = input.store;
	const owner = input.owner;
	let staleReason: string | null = null;
	let uncertain = false;
	let closed = false;
	let closing = false;
	let cleanupPromise: Promise<GoalWorkspaceCleanupResult> | undefined;
	let queue: Promise<void> = Promise.resolve();
	let ordinal = 0;
	const knownObservations = async (): Promise<GoalAcceptedObservations> => {
		const observations = await observe();
		if (
			!observations.data.effectsKnown ||
			observations.data.effects.some((effect) => effect.state === "unknown")
		)
			throw new Error("Goal workspace observation uncertainty requires recovery");
		return observations;
	};
	const producerId = `workspace-${input.workspace.workspaceId}`;
	const setup = await withGoalHostWriteLock(hostRoot, async () => {
		const firstObservations = await knownObservations();
		const initial = await store.assertCurrentOwner(owner, firstObservations);
		const releaseOwnerActivity = store.bindOwnerActivity(owner);
		try {
			const effectsParent = join(hostRoot, "workspace-effects");
			try {
				await mkdir(effectsParent, { mode: 0o700 });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			const parentInfo = await lstat(effectsParent);
			if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink())
				throw new Error("Goal workspace effects parent is unsafe");
			const effects = await GoalHostEffects.create(
				workspaceEffectsRoot(hostRoot, input.workspace.workspaceId),
				{
					goalId: initial.contract.goalId,
					scopeId: goalHash({
						workspaceId: input.workspace.workspaceId,
						childScope: childScope ?? null,
					}),
					ownerEpoch: owner.epoch,
					sessionDigest: input.sessionDigest,
				},
			);
			await effects.record({
				type: "producer-opened",
				producerId,
				kind: "workspace",
			});
			return { initial, effects, releaseOwnerActivity };
		} catch (error) {
			releaseOwnerActivity();
			throw error;
		}
	});
	const { initial, effects, releaseOwnerActivity } = setup;
	const goalId = initial.contract.goalId;
	const contractHash = initial.decision.contractHash;
	let fenceCleanup: (() => Promise<void>) | undefined;
	let creationFailed = false;
	let resolveFenceReady!: () => void;
	const fenceReady = new Promise<void>((resolve) => { resolveFenceReady = resolve; });
	try {
		issuer.bindFence(lease, async (event) => {
			staleReason ??= `session-${event.reason}`;
			await fenceReady;
			if (creationFailed || fenceCleanup === undefined)
				throw new Error("Goal workspace creation requires recovery");
			await fenceCleanup();
		});
	} catch (error) {
		try {
			let census = await effects.record({ type: "fenced", reason: "session-lost" });
			census = await effects.record({
				type: "producer-closed",
				producerId,
				outcome: "never-started",
				observationDigest: goalHash({ workspace: "never-started" }),
			});
			await effects.record({
				type: "sealed",
				previousHead: census.head,
				censusDigest: goalHash(census),
			});
			releaseOwnerActivity();
		} catch {
			// Durable initialization uncertainty keeps the owner activity fenced.
		}
		resolveFenceReady();
		throw error;
	}

	const authoritySnapshot = async (
		allowSessionStale = false,
	): Promise<GoalStoreSnapshot> => {
		const sessionStale = staleReason?.startsWith("session-") ?? false;
		if (staleReason !== null && !(allowSessionStale && sessionStale))
			throw new Error(`Goal workspace authority stale: ${staleReason}`);
		if (uncertain)
			throw new Error("Goal workspace authority recovery is required");
		try {
			if (!allowSessionStale) issuer.assertCurrent(lease);
			const observations = await knownObservations();
			if (!allowSessionStale) issuer.assertCurrent(lease);
			const snapshot = await store.assertCurrentOwner(owner, observations);
			if (
				snapshot.contract.goalId !== goalId ||
				snapshot.decision.contractHash !== contractHash
			)
				throw new Error("Goal workspace contract authority changed");
			return snapshot;
		} catch (error) {
			staleReason ??= "owner-session-or-contract-changed";
			throw error;
		}
	};
	const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
		const run = queue.then(operation, operation);
		queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};
	let retired = false;
	let retiring = false;
	const assertCandidateWriteLive = (): void => {
		issuer.assertCurrent(lease);
		if (staleReason !== null || closing || closed || uncertain || retired || retiring)
			throw new Error("Goal workspace execution authority is fenced or retired");
	};
	const candidateWriteGuard = Object.freeze({
		assertLive: assertCandidateWriteLive,
		async assertCurrent(): Promise<void> {
			assertCandidateWriteLive();
			await authoritySnapshot();
			assertCandidateWriteLive();
		},
	});
	const runEffect = async <T>(
		operation: Extract<
			GoalHostEffectOperation,
			"workspace-create" | "workspace-write" | "workspace-cleanup"
		>,
		request: unknown,
		action: () => Promise<T>,
		result: (value: T) => unknown,
		allowSessionStale = false,
	): Promise<T> =>
		enqueue(async () => {
			const effectOrdinal = ++ordinal;
			const effectId = `workspace-effect-${effectOrdinal}`;
			const execute = () => withGoalHostWriteLock(hostRoot, async (markWriting) => {
				// runCurrent already admitted the exact lease before any lifecycle fence.
				const before = await authoritySnapshot(true);
				let requestCensus: GoalHostEffectCensus;
				try {
					requestCensus = await effects.record({
						type: "requested",
						effectId,
						producerId,
						operation,
						requestDigest: resultDigest(request),
						goalHead: { seq: before.seq, hash: before.hash },
					});
				} catch (error) {
					uncertain = true;
					throw error;
				}
				await authoritySnapshot(true);
				markWriting();
				let value: T;
				try {
					value = await action();
					await authoritySnapshot(true);
				} catch (error) {
					uncertain = true;
					try {
						await effects.record({
							type: "result",
							effectId,
							requestSeq: requestCensus.head.seq,
							outcome: "unknown",
							resultDigest: resultDigest({ operation, outcome: "unknown" }),
						});
					} catch {
						// The first result publication may be durable. Never retry it.
					}
					throw error;
				}
				try {
					await effects.record({
						type: "result",
						effectId,
						requestSeq: requestCensus.head.seq,
						outcome: "acknowledged",
						resultDigest: resultDigest(result(value)),
					});
				} catch (error) {
					uncertain = true;
					throw error;
				}
				return value;
			});
			return allowSessionStale
				? execute()
				: issuer.runCurrent(lease, execute);
		});

	const creation = await runEffect(
		"workspace-create",
		{ workspace: workspaceRequestDigest(input.workspace) },
		async () => {
			const handle = await prepareGoalWorkspaceHost(input.workspace, candidateWriteGuard);
			const executionRoot = await realpath(
				handle.workspaceRoot ?? canonicalOriginRoot,
			);
			if (handle.workspaceRoot !== null && executionRoot !== handle.workspaceRoot)
				throw new Error("Goal workspace root identity changed during creation");
			await handle.inspectCandidate();
			return { handle, executionRoot };
		},
		(value) => ({
			baseline: goalHash(value.handle.baseline),
			root: value.executionRoot,
		}),
	).catch((error: unknown) => {
		creationFailed = true;
		// Durable ledger evidence, not a leaked in-memory token, now fences handoff.
		releaseOwnerActivity();
		resolveFenceReady();
		throw new Error(
			"Goal workspace creation failed; durable recovery required",
			{ cause: error },
		);
	});
	const base = creation.handle;
	const executionRoot = creation.executionRoot;
	const binding = Object.freeze({
		id: base.baseline.workspaceId,
		root: executionRoot,
		revision: initial.contract.revision,
		digest: goalHash({
			goalId,
			contractHash,
			ownerId: owner.ownerId,
			ownerEpoch: owner.epoch,
			sessionDigest: input.sessionDigest,
			workspaceId: base.baseline.workspaceId,
			workspaceRoot: executionRoot,
			baselineHash: goalHash(base.baseline),
			childScope: childScope ?? null,
		}),
	});
	let cleanupResult: GoalWorkspaceCleanupResult | undefined;
	const handle: GoalAuthorizedWorkspaceHostHandle = Object.freeze({
		baseline: base.baseline,
		workspaceRoot: base.workspaceRoot,
		sourceCatalog: base.sourceCatalog,
		binding,
		async readSourcePage(path: string, cursor?: string): Promise<GoalSourcePage> {
			assertCandidateWriteLive();
			return enqueue(async () => {
				await candidateWriteGuard.assertCurrent();
				try {
					const page = await base.readSourcePage(path, cursor);
					await candidateWriteGuard.assertCurrent();
					return page;
				} catch (error) {
					staleReason ??= "workspace-observation-failed";
					throw error;
				}
			});
		},
		async beginCandidateReplacement(input: GoalCandidateReplacementBegin): Promise<GoalCandidateReplacementReceipt> {
			const captured = Object.freeze({ ...input });
			await candidateWriteGuard.assertCurrent();
			return runEffect(
				"workspace-write",
				{ operation: "begin", input: captured },
				() => base.beginCandidateReplacement(captured),
				receipt => receipt,
			);
		},
		async appendCandidateReplacement(input: GoalCandidateReplacementAppend): Promise<GoalCandidateReplacementReceipt> {
			const captured = Object.freeze({ ...input });
			await candidateWriteGuard.assertCurrent();
			return runEffect(
				"workspace-write",
				{ operation: "chunk", inputDigest: goalHash(captured) },
				() => base.appendCandidateReplacement(captured),
				receipt => receipt,
			);
		},
		async commitCandidateReplacement(input: GoalCandidateReplacementCommit): Promise<GoalWorkspaceCandidate> {
			const captured = Object.freeze({ ...input });
			await candidateWriteGuard.assertCurrent();
			return runEffect(
				"workspace-write",
				{ operation: "commit", input: captured },
				() => base.commitCandidateReplacement(captured),
				candidate => ({ candidateHash: goalHash(candidate) }),
			);
		},
		async inspectCandidate(): Promise<GoalWorkspaceCandidate> {
			if (closing || closed || retiring) throw new Error("Goal workspace custody is closing");
			return enqueue(async () => {
				if (closing || closed || retiring) throw new Error("Goal workspace custody is closing");
				await authoritySnapshot();
				try {
					const candidate = await base.inspectCandidate();
					await authoritySnapshot();
					return candidate;
				} catch (error) {
					staleReason ??= "workspace-observation-failed";
					throw error;
				}
			});
		},
		async writeCandidate(
			path: string,
			expectedDigest: string,
			content: string,
		): Promise<GoalWorkspaceCandidate> {
			if (closing || closed || retiring) throw new Error("Goal workspace custody is closing");
			await authoritySnapshot();
			if (base.baseline.mode === "read-only")
				throw new Error("Goal read-only workspace rejects writes");
			if (!base.baseline.scope.includes(path))
				throw new Error("Goal workspace resource is outside the manifest");
			if (!DIGEST.test(expectedDigest))
				throw new Error("Goal workspace expected digest is invalid");
			const before = await base.inspectCandidate();
			await candidateWriteGuard.assertCurrent();
			const current = before.files.find((file) => file.path === path);
			if (current === undefined || goalHash(current.value) !== expectedDigest)
				throw new Error("Goal workspace resource digest changed");
			return runEffect(
				"workspace-write",
				{ path, expectedDigest, contentDigest: goalHash(content) },
				() => base.writeCandidate(path, expectedDigest, content),
				(candidate) => ({ candidateHash: goalHash(candidate) }),
			);
		},
		cleanup(): Promise<GoalWorkspaceCleanupResult> {
			if (retired)
				return Promise.reject(new Error("Goal retired workspace cannot be cleaned up"));
			if (retiring)
				return Promise.reject(new Error("Goal workspace retirement is in progress"));
			if (cleanupResult !== undefined) return Promise.resolve(cleanupResult);
			if (cleanupPromise !== undefined) return cleanupPromise;
			closing = true;
			cleanupPromise = (async () => {
			const sessionCleanup = staleReason?.startsWith("session-") ?? false;
			await authoritySnapshot(sessionCleanup);
			const value = await runEffect(
				"workspace-cleanup",
				{ bindingDigest: binding.digest },
				async () => {
					const candidate = await base.cleanup();
					if (candidate.status === "retained")
						throw new Error(`Goal workspace cleanup uncertain: ${candidate.reason}`);
					return candidate;
				},
				(candidate) => candidate,
				staleReason?.startsWith("session-") ?? false,
			);
			try {
				let census = await effects.record({ type: "fenced", reason: "complete" });
				census = await effects.record({
					type: "producer-closed",
					producerId,
					outcome: "closed",
					observationDigest: goalHash(value),
				});
				await effects.record({
					type: "sealed",
					previousHead: census.head,
					censusDigest: goalHash(census),
				});
			} catch (error) {
				uncertain = true;
				throw error;
			}
			closed = true;
			releaseOwnerActivity();
			cleanupResult = value;
			return value;
			})();
			return cleanupPromise;
		},
	});
	AUTHORIZED_HANDLES.add(handle);
	AUTHORIZED_STATE.set(
		handle,
		Object.freeze({
			issuer, lease,
			assertExecutionCurrent: () => {
				issuer.assertCurrent(lease);
				if (closing || closed || uncertain || retired || retiring)
					throw new Error("Goal workspace execution authority is fenced or retired");
			},
			effects,
			childScope,
			inspect: async () => {
				await queue;
				const census = await effects.inspect();
				if (closed && (!census.sealed || !census.bookkeepingComplete))
					throw new Error("Goal workspace closed bookkeeping changed");
				return census;
			},
			retire: async () => {
				if (retired) return;
				if (retiring || closing || closed || uncertain)
					throw new Error("Goal workspace retirement requires live known custody");
				// Latch before queueing: no subsequent workspace read/write/cleanup
				// can be admitted while this retirement joins prior work.
				retiring = true;
				try {
					await enqueue(async () => {
					if (retired) return;
					if (closing || closed || uncertain)
						throw new Error("Goal workspace retirement requires live known custody");
					await authoritySnapshot();
					const candidate = await base.inspectCandidate();
					const candidateDigest = goalHash(candidate);
					await authoritySnapshot();
					await withGoalHostWriteLock(hostRoot, async (markWriting) => {
						await authoritySnapshot();
						const currentCandidate = await base.inspectCandidate();
						if (goalHash(currentCandidate) !== candidateDigest)
							throw new Error("Goal workspace candidate changed during retirement");
						await authoritySnapshot();
						const census = await effects.inspect();
						if (census.pendingEffects.length || census.unknownEffects.length ||
							census.conflicts.length ||
							census.openProducers.filter(id => id !== producerId).length)
							throw new Error("Goal workspace retirement effects are not known");
						markWriting();
						await effects.record({ type: "fenced", reason: "complete" });
						const closedCensus = await effects.record({
							type: "producer-closed",
							producerId,
							outcome: "closed",
							observationDigest: goalHash({
								retired: true,
								binding: binding.digest,
								candidateDigest,
							}),
						});
						await authoritySnapshot();
						await effects.record({
							type: "sealed",
							previousHead: closedCensus.head,
							censusDigest: goalHash(closedCensus),
						});
					});
					retired = true;
					closed = true;
					releaseOwnerActivity();
					});
				} catch (error) {
					// The latch remains set and activity stays retained. Never
					// re-admit or retry after a retirement whose durable closure
					// may be uncertain.
					uncertain = true;
					throw error;
				}
			},
		}),
	);
	fenceCleanup = async () => {
		if (uncertain)
			throw new Error("Goal workspace fence requires recovery");
		if (retired) return;
		if (!closed) await handle.cleanup();
	};
	resolveFenceReady();
	return handle;
}
