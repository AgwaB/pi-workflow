import {
	assertAcceptedGoalContract,
	assertAcceptedGoalEvent,
	assertAcceptedGoalObservations,
	assertGoalRevision,
	goalHash,
} from "./goal-contract.js";
import {
	assertGoalBindingUpdate,
	assertGoalEvidenceResolution,
	validGoalReceipts,
} from "./goal-evidence.js";
import { frozen, GOAL_MAX_EVENTS } from "./goal-json.js";
import { createGoalProbeFold } from "./goal-probe.js";
import type {
	CriterionState,
	GoalAcceptedEvent,
	GoalAcceptedObservations,
	GoalBlocker,
	GoalContract,
	GoalDecision,
	GoalObservations,
	GoalReceipt,
} from "./goal-types.js";

/** Initial, unmeasured proposal, NOT an engine default or a transport cap guarantee. */
export const GOAL_RUNTIME_POLICY = Object.freeze({
	schemaVersion: 1,
	id: "goal-p1-unmeasured-3-2-3",
	transientAttempts: 3,
	noProgressReplans: 2,
	familyResumes: 3,
});
export function goalBlockerFamily(
	goalId: string,
	blocker: GoalBlocker,
): string {
	return goalHash({
		goalId,
		criterionId: blocker.criterionId,
		errorClass: blocker.errorClass,
		resource: blocker.resource,
		predicateId: blocker.predicateId,
	});
}
function sum(a: number | null, b: number | null): number | null {
	if (a === null || b === null) return null;
	const value = a + b;
	if (!Number.isSafeInteger(value)) throw new Error("Goal counter overflow");
	return value;
}
/** Pure fold. Only nonserializable host-accepted inputs carry authority. No IO,
 * clock reads, scheduling, model evaluation, transport reservation or execution.
 * Terminal verdicts require an explicit terminal event with its historical inventory.
 */
export function reduceGoal(
	initial: GoalContract,
	events: readonly GoalAcceptedEvent[],
	observations: GoalAcceptedObservations,
): GoalDecision {
	assertAcceptedGoalContract(initial);
	assertAcceptedGoalObservations(observations);
	if (events.length > GOAL_MAX_EVENTS)
		throw new Error("Goal event bound exceeded");
	let contract = initial;
	let started = false;
	let needsReconcile = false;
	let latch: "pause" | "cancel" | "revoke" | null = null;
	let receipts: GoalReceipt[] = [];
	let apply: {
		originDigest: string;
		at: number;
		state: "verified" | "partial" | "unknown";
	} | null = null;
	const effects = new Map<string, { kind: string; state: string }>();
	const effectRequests = new Map<string, string>();
	const unaccountedEffects = new Set<string>();
	let unaccountedProbeUsage = false;
	const usageEvidence = new Set<string>();
	const measuredUsage: { requests: number | null; costMicros: number | null } = {
		requests: 0, costMicros: 0,
	};
	const probes = createGoalProbeFold();
	const blockers = new Map<string, GoalBlocker>();
	const blockerEvents = new Map<string, string>();
	const resolvedBlockers: GoalDecision["resolvedBlockers"] = [];
	const superseded = new Set<string>();
	let bindings = new Map(contract.criteria.map((c) => [c.id, c.binding]));
	let lastObservationAt = 0;
	const seen = new Map<string, string>();
	const receiptIds = new Set<string>();
	const plans = new Map<string, { eventIndex: number }>();
	const latestReceiptEvent = new Map<string, number>();
	const planIds = new Set<string>();
	const planActionKeys = new Set<string>();
	const counters: GoalDecision["counters"] = {
		attempts: Object.create(null) as Record<string, number | null>,
		noProgress: 0,
		progress: 0,
		unknownProgress: 0,
		resumes: Object.create(null) as Record<string, number>,
		requests: 0,
		costMicros: 0,
	};
	let terminal: GoalDecision | null = null;

	const project = (obs: GoalObservations): GoalDecision => {
		for (const unit of ["requests", "costMicros"] as const)
			counters[unit] = unaccountedEffects.size || unaccountedProbeUsage ? null : measuredUsage[unit];
		const contractHash = goalHash(contract);
		const pending = new Set<string>();
		if (!obs.effectsKnown) pending.add("inventory:unknown");
		if (apply && apply.state !== "verified") pending.add("apply:unreconciled");
		for (const probeId of probes.pendingEffects()) pending.add(probeId);
		for (const [key, effect] of effects)
			if (effect.state !== "drained") pending.add(key);
		// Current inventory can add blockers, but cannot erase journal-known effects.
		for (const effect of obs.effects)
			if (effect.state !== "drained") pending.add(effect.id);
		const criteria = contract.criteria.map((c) => {
			const candidates = receipts.filter((r) => r.criterionId === c.id);
			const valid = validGoalReceipts({
				contract,
				criterion: c,
				binding: bindings.get(c.id) ?? c.binding,
				observations: obs,
				receipts: candidates,
				superseded,
				apply,
			});
			const pass = valid.some((r) => r.result === "pass");
			const fail = valid.some(
				(r) => r.result === "fail" || (r.model?.counterexamples.length ?? 0) > 0,
			);
			const unknown = valid.some((r) => r.result === "unknown");
			const state: CriterionState =
				pass && fail
					? "conflicted"
					: fail
						? "unmet"
						: unknown
							? "unknown"
							: pass
								? "met"
								: candidates.length
									? "stale"
									: "unknown";
			return {
				id: c.id,
				kind: c.kind,
				state,
				receiptIds: valid.map((r) => r.id),
				supersededReceiptIds: candidates
					.filter((r) => superseded.has(r.id))
					.map((r) => r.id),
			};
		});
		const decision: GoalDecision = {
			schemaVersion: 1,
			contractHash,
			lifecycle: started ? "running" : "draft",
			phase: "observe",
			reasons: [],
			criteria,
			pendingEffects: [...pending].sort(),
			blockers: [...blockers.values()],
			resolvedBlockers: [...resolvedBlockers],
			counters: structuredClone(counters),
			proposals: [],
		};
		if (latch) {
			decision.lifecycle = latch === "cancel" ? "cancelling" : "pausing";
			decision.reasons.push(latch);
			decision.proposals.push({
				type: pending.size ? "stop" : "finalize",
				criterionId: null,
			});
			if (!pending.size && latch !== "cancel") decision.lifecycle = "paused";
			return decision;
		}
		if (!started) return decision;
		if (pending.size) {
			decision.phase = "reconcile";
			decision.reasons.push("effects-pending");
			decision.proposals.push({ type: "reconcile", criterionId: null });
			return decision;
		}
		if (contract.completionTarget === "unresolved") {
			decision.lifecycle = "waiting_user";
			decision.reasons.push("completion-target-ambiguous");
			decision.proposals.push({ type: "clarify-target", criterionId: null });
			return decision;
		}
		if (
			blockers.size ||
			counters.noProgress + counters.unknownProgress >=
				GOAL_RUNTIME_POLICY.noProgressReplans ||
			Object.values(counters.attempts).some(
				(n) => n === null || n >= GOAL_RUNTIME_POLICY.transientAttempts,
			)
		) {
			decision.lifecycle = "blocked";
			decision.reasons.push(
				blockers.size
					? "blocker"
					: counters.noProgress + counters.unknownProgress >=
							GOAL_RUNTIME_POLICY.noProgressReplans
						? "no-progress-limit"
						: "attempt-limit-or-unknown",
			);
			return decision;
		}
		for (const unit of ["requests", "costMicros"] as const) {
			const limit = contract.limits[unit];
			if (
				limit !== null &&
				(counters[unit] === null || counters[unit]! >= limit)
			) {
				decision.lifecycle = "blocked";
				decision.reasons.push(`${unit}-limit-or-unknown`);
				return decision;
			}
		}
		if (needsReconcile) {
			decision.phase = "reconcile";
			decision.reasons.push("resume-reconcile-required");
			decision.proposals.push({ type: "reconcile", criterionId: null });
			return decision;
		}
		const candidatePending = contract.criteria.some(c => c.required && c.binding.target === "candidate" &&
			criteria.find(state => state.id === c.id)?.state !== "met");
		if (contract.completionTarget === "origin" && !candidatePending) {
			const origins = contract.criteria.filter(
				(c) => c.required && c.binding.target === "origin",
			);
			if (
				apply?.state !== "verified" ||
				!origins.every(
					(c) =>
						(bindings.get(c.id) ?? c.binding).subjectDigest === apply!.originDigest,
				)
			) {
				const preauthorized = contract.authority.applyMode === "preauthorized";
				decision.lifecycle = apply
					? "blocked"
					: preauthorized
						? "running"
						: "blocked";
				decision.phase = "apply";
				decision.reasons.push("origin-application-unverified");
				if (apply || preauthorized) decision.proposals.push({
					type: apply ? "reconcile" : "apply", criterionId: null,
				});
				else decision.reasons.push("initial-origin-consent-unavailable");
				return decision;
			}
		}
		for (const c of contract.criteria.filter((c) => c.required)) {
			if (contract.completionTarget === "origin" && candidatePending && c.binding.target === "origin") continue;
			if (criteria.find((s) => s.id === c.id)!.state === "met") continue;
			if (c.kind === "human") {
				decision.phase = "verify";
				decision.lifecycle = "waiting_user";
				decision.proposals.push({ type: "human-acceptance", criterionId: c.id });
				continue;
			}
			const plan = plans.get(c.id);
			const latestReceipt = latestReceiptEvent.get(c.id) ?? -1;
			if (plan === undefined || plan.eventIndex <= latestReceipt) {
				decision.phase = "plan";
				decision.proposals.push({ type: "admit", criterionId: c.id });
			} else {
				decision.phase = "verify";
				decision.proposals.push({ type: "verify", criterionId: c.id });
			}
		}
		if (decision.proposals.length) return decision;
		decision.reasons.push("ready-to-finalize");
		decision.proposals.push({ type: "finalize", criterionId: null });
		return decision;
	};

	for (const [eventIndex, accepted] of events.entries()) {
		assertAcceptedGoalEvent(accepted);
		const e = accepted.data;
		const fingerprint = goalHash(accepted);
		if (seen.has(e.id)) {
			if (seen.get(e.id) !== fingerprint)
				throw new Error("Goal conflicting duplicate event");
			continue;
		}
		if (terminal)
			throw new Error("Goal terminal is immutable; create a new Goal");
		seen.set(e.id, fingerprint);
		if (accepted.observations.at < lastObservationAt)
			throw new Error("Goal event observation time regressed");
		lastObservationAt = accepted.observations.at;
		if (e.contractHash !== goalHash(contract))
			throw new Error("Goal event revision mismatch");
		if (
			(e.type === "control" ||
				e.type === "revision" ||
				e.type === "blocker-resolved") &&
			accepted.actor.id !== contract.authority.issuer
		)
			throw new Error("Goal control actor mismatch");
		if (e.type === "plan" && accepted.actor.kind !== "host")
			throw new Error("Goal plan admission requires host actor");
		if (e.type === "effect" && probes.hasProbeId(e.effectId))
			throw new Error("Goal generic effect aliases typed probe ownership");
		if (
			e.type === "probe" &&
			(e.record.type === "open" || e.record.type === "claim") &&
			latch
		)
			throw new Error("Goal probe fenced by control");
		if (
			e.type === "probe" &&
			e.record.type === "claim" &&
			effects.has(e.record.probeId)
		)
			throw new Error("Goal typed probe aliases generic effect ownership");
		probes.accept(accepted);
		switch (e.type) {
			case "start":
				if (started) throw new Error("Goal already started");
				started = true;
				break;
			case "reconcile":
				if (latch || project(accepted.observations).pendingEffects.length)
					throw new Error("Goal reconciliation requires drained inventory");
				needsReconcile = false;
				break;
			case "note":
				break; // Child completion, loop cap and prose have no evidentiary meaning.
			case "receipt":
				if (e.receipt.observedAt > accepted.observations.at)
					throw new Error("Goal future receipt at event admission");
				if (receiptIds.has(e.receipt.id)) throw new Error("Goal reused receipt ID");
				if (
					e.receipt.contractHash !== e.contractHash ||
					!contract.criteria.some((c) => c.id === e.receipt.criterionId)
				)
					throw new Error("Goal receipt binding mismatch");
				receiptIds.add(e.receipt.id);
				receipts.push(e.receipt);
				latestReceiptEvent.set(e.receipt.criterionId, eventIndex);
				break;
			case "plan": {
				const effect = effects.get(e.effectId);
				if (latch || effect?.kind !== "child" || effect.state !== "active")
					throw new Error("Goal plan admission requires its active child effect and no control latch");
				const current = project(accepted.observations);
				if (planIds.has(e.planId) || planActionKeys.has(e.actionKey) ||
					new Set(e.criterionIds).size !== e.criterionIds.length ||
					e.criterionIds.some((id) => {
						const definition = contract.criteria.find((c) => c.id === id);
						const state = current.criteria.find((criterion) => criterion.id === id)?.state;
						return !definition?.required || definition.kind === "human" || state === "met";
					}))
					throw new Error("Goal plan admission criteria invalid");
				planIds.add(e.planId);
				planActionKeys.add(e.actionKey);
				for (const criterionId of e.criterionIds)
					plans.set(criterionId, { eventIndex });
				break;
			}
			case "binding-updated": {
				if (latch || project(accepted.observations).pendingEffects.length)
					throw new Error(
						"Goal binding update requires drained effects and no control latch",
					);
				const current = bindings.get(e.criterionId);
				if (!current) throw new Error("Goal binding criterion unknown");
				assertGoalBindingUpdate(contract, current, e, accepted.observations);
				bindings.set(e.criterionId, e.binding);
				if (e.binding.target === "origin") apply = null;
				break;
			}
			case "evidence-resolved": {
				if (latch || project(accepted.observations).pendingEffects.length)
					throw new Error(
						"Goal evidence resolution requires drained effects and no control latch",
					);
				const criterion = contract.criteria.find((c) => c.id === e.criterionId);
				const current = bindings.get(e.criterionId);
				if (!criterion || !current)
					throw new Error("Goal resolution criterion unknown");
				assertGoalEvidenceResolution(
					{
						contract,
						criterion,
						binding: current,
						observations: accepted.observations,
						receipts,
						superseded,
						apply,
					},
					e,
					accepted.actor,
				);
				for (const receiptId of e.receiptIds) superseded.add(receiptId);
				break;
			}
			case "blocker-resolved": {
				if (latch || project(accepted.observations).pendingEffects.length)
					throw new Error(
						"Goal blocker resolution requires drained effects and no control latch",
					);
				const entry = [...blockers.entries()].find(([, b]) => b.id === e.blockerId);
				if (!entry) throw new Error("Goal stale blocker resolution");
				const [family, b] = entry;
				if (
					b.instanceDigest !== e.instanceDigest ||
					blockerEvents.get(family) !== e.blockerEventId ||
					e.authorityHash !== contract.authorityHash
				)
					throw new Error("Goal blocker resolution instance/authority mismatch");
				resolvedBlockers.push({
					blocker: b,
					blockerEventId: e.blockerEventId,
					resolutionEventId: e.id,
					evidenceRefs: e.evidenceRefs,
				});
				blockers.delete(family);
				blockerEvents.delete(family);
				needsReconcile = true;
				break;
			}
			case "probe":
				// Atomic durable claim: the probe fold has consumed the bounded slot and
				// project() now exposes the same ID as pending. Typed fixture data does
				// not make transport usage known or prove observer provenance.
				if (e.record.type === "claim") {
					unaccountedProbeUsage = true;
				}
				break;
			case "effect-usage": {
				const effect = effects.get(e.effectId);
				if (effect?.state !== "drained" ||
					!unaccountedEffects.has(e.effectId) ||
					effectRequests.get(e.effectId) !== e.requestEventHash ||
					!accepted.observations.effectsKnown ||
					accepted.observations.effects.some(item => item.id === e.effectId && item.state !== "drained") ||
					new Set(e.evidenceRefs).size !== e.evidenceRefs.length ||
					e.evidenceRefs.some(ref => usageEvidence.has(ref)))
					throw new Error("Goal effect usage requires unique measured evidence for its exact drained request");
				for (const ref of e.evidenceRefs) usageEvidence.add(ref);
				unaccountedEffects.delete(e.effectId);
				for (const unit of ["requests", "costMicros"] as const)
					measuredUsage[unit] = sum(measuredUsage[unit], e.usage[unit]);
				break;
			}
			case "effect": {
				const old = effects.get(e.effectId);
				if (
					old &&
					(old.kind !== e.kind || (old.state === "drained" && e.state !== "drained"))
				)
					throw new Error("Goal effect identity reused");
				if (!old && e.state === "drained")
					throw new Error("Goal drain without intent");
				if (latch && e.state === "active" && e.kind !== "stop")
					throw new Error("Goal effect fenced by control");
				// Drain alone is not usage evidence. Only exact host-attested
				// accounting can resolve this effect's unknown contribution.
				if (!old && ["child", "verifier", "helper", "probe"].includes(e.kind)) {
					unaccountedEffects.add(e.effectId);
					effectRequests.set(e.effectId, goalHash(accepted));
				}
				effects.set(e.effectId, { kind: e.kind, state: e.state });
				break;
			}
			case "control":
				if (e.action === "resume") {
					if (
						latch === "cancel" ||
						latch === "revoke" ||
						project(accepted.observations).pendingEffects.length
					)
						throw new Error("Goal resume fenced");
					latch = null;
					needsReconcile = true;
				} else if (latch !== "cancel" && latch !== "revoke") latch = e.action;
				else if (e.action === "cancel") latch = "cancel";
				break;
			case "revision":
				if (latch || project(accepted.observations).pendingEffects.length)
					throw new Error(
						"Goal revision requires drained effects and no control latch",
					);
				assertGoalRevision(contract, e.contract);
				contract = e.contract;
				apply = null;
				needsReconcile = true;
				bindings = new Map(contract.criteria.map((c) => [c.id, c.binding]));
				// Retain old receipts as stale evidence and all lifetime accounting/blockers.
				break;
			case "blocker": {
				if (!contract.criteria.some((c) => c.id === e.blocker.criterionId))
					throw new Error("Goal blocker criterion unknown");
				const family = goalBlockerFamily(contract.goalId, e.blocker);
				if (
					[...blockers.entries()].some(
						([key, b]) => key !== family && b.id === e.blocker.id,
					)
				)
					throw new Error("Goal duplicate active blocker ID");
				blockers.set(family, e.blocker);
				blockerEvents.set(family, e.id);
				break;
			}
			case "resume": {
				const entry = [...blockers.entries()].find(([, b]) => b.id === e.blockerId);
				if (!entry) throw new Error("Goal stale wake");
				const [family, b] = entry;
				if (blockerEvents.get(family) !== e.blockerEventId)
					throw new Error("Goal stale blocker wake");
				if (
					latch ||
					!e.condition ||
					!e.ownerPresent ||
					b.instanceDigest !== e.instanceDigest ||
					b.predicateId !== e.predicateId ||
					!contract.authority.resumePredicates.includes(e.predicateId) ||
					!["dependency", "availability"].includes(b.errorClass) ||
					project(accepted.observations).pendingEffects.length ||
					(counters.resumes[family] ?? 0) >= GOAL_RUNTIME_POLICY.familyResumes
				)
					throw new Error("Goal resume admission rejected");
				counters.resumes[family] = (counters.resumes[family] ?? 0) + 1;
				blockers.delete(family);
				blockerEvents.delete(family);
				needsReconcile = true;
				break;
			}
			case "attempt":
				counters.attempts[e.operationId] = sum(
					Object.hasOwn(counters.attempts, e.operationId)
						? counters.attempts[e.operationId]
						: 0,
					e.consumed,
				);
				measuredUsage.requests = sum(measuredUsage.requests, e.usage.requests);
				measuredUsage.costMicros = sum(measuredUsage.costMicros, e.usage.costMicros);
				break;
			case "progress":
				if (!contract.criteria.some((c) => c.id === e.criterionId))
					throw new Error("Goal progress criterion unknown");
				if (e.delta === "unknown" || e.confidence === "unknown")
					counters.unknownProgress++;
				else if (e.delta === "none" || !e.evidenceRefs.length)
					counters.noProgress++;
				else counters.progress++; // Typed host-accepted evidence; never a hash/text-based reset.
				break;
			case "apply":
				if (!contract.authority.allowedEffects.includes("origin-apply"))
					throw new Error("Goal apply outside authority");
				apply = { originDigest: e.originDigest, at: e.at, state: e.state };
				break;
			case "terminal": {
				if (e.at !== accepted.observations.at)
					throw new Error("Goal terminal time mismatch");
				const candidate = project(accepted.observations);
				if (candidate.pendingEffects.length)
					throw new Error("Goal terminal effects pending");
				if (
					e.lifecycle === "achieved" &&
					!candidate.reasons.includes("ready-to-finalize")
				)
					throw new Error("Goal achievement not established");
				if (e.lifecycle === "cancelled" && latch !== "cancel")
					throw new Error("Goal cancellation not requested");
				terminal = {
					...candidate,
					lifecycle: e.lifecycle,
					proposals: [],
					reasons: [e.lifecycle],
				};
				break;
			}
		}
	}
	if (observations.data.at < lastObservationAt)
		throw new Error("Goal current observation time regressed");
	return frozen(terminal ?? project(observations.data));
}
