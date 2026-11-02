import type {
	GoalAcceptedEvent,
	GoalAcceptedObservations,
	GoalActor,
	GoalAuthority,
	GoalBinding,
	GoalContract,
	GoalCommittedSnapshot,
	GoalEventData,
	GoalObservations,
	GoalProfileCapture,
	GoalReceipt,
} from "./goal-types.js";
import {
	arr,
	bool,
	digest,
	frozen,
	goalHash,
	goalJson,
	id,
	nat,
	nullable,
	obj,
	one,
	parse,
	positive,
	str,
	unique,
	type Check,
} from "./goal-json.js";
import { parseGoalProbeRecord } from "./goal-probe.js";
import { THINKING_LEVELS, WORKFLOW_PROFILE_ROLES } from "./types.js";
export { goalHash, goalJson } from "./goal-json.js";

const version = one(1);
const kind = one("deterministic", "model-rubric", "human");
const binding = obj({
	subjectDigest: digest,
	environmentDigest: digest,
	verifierId: id,
	producerLineageDigest: digest,
	codeDigest: digest,
	configDigest: digest,
	target: one("artifact", "candidate", "origin"),
});
const authority = obj({
	schemaVersion: version,
	goalId: id,
	revision: positive,
	issuer: id,
	actorReceipt: digest,
	scopeDigest: digest,
	allowedEffects: arr(
		one("read", "candidate-write", "verify", "origin-apply", "workflow-create"),
		1,
	),
	roots: arr(str),
	protectedPaths: arr(str, 1),
	applyMode: one("confirm", "preauthorized"),
	backgroundAllowed: bool,
	resumePredicates: arr(id),
	revocationGeneration: nat,
});
const profile = obj({
	schemaVersion: version,
	name: str,
	source: one("builtin", "custom"),
	templateFingerprint: digest,
	environmentDigest: digest,
	roles: arr(
		obj({
			role: one(...WORKFLOW_PROFILE_ROLES),
			model: str,
			thinking: one(...THINKING_LEVELS),
			origin: obj({
				model: one("fixed", "inherit"),
				thinking: one("fixed", "inherit"),
			}),
		}),
		WORKFLOW_PROFILE_ROLES.length,
		WORKFLOW_PROFILE_ROLES.length,
	),
});
const criterion = obj({
	id,
	statement: str,
	required: bool,
	kind,
	binding,
	acceptanceDigest: digest,
	maxAgeMs: positive,
});
const contractShape = obj({
	schemaVersion: version,
	goalId: id,
	revision: positive,
	previousHash: nullable(digest),
	requestDigest: digest,
	subjectScope: arr(str),
	criteria: arr(criterion, 1),
	authority,
	authorityHash: digest,
	profile,
	profileHash: digest,
	executionMode: one("foreground", "background"),
	completionTarget: one("artifact", "origin", "unresolved"),
	limits: obj({ requests: nullable(nat), costMicros: nullable(nat) }),
	exclusions: arr(str),
});
export function parseGoalAuthority(input: unknown): GoalAuthority {
	const data = parse<GoalAuthority>(input, authority);
	unique(data.allowedEffects);
	unique(data.roots);
	unique(data.protectedPaths);
	unique(data.resumePredicates);
	if (
		data.applyMode === "preauthorized" &&
		!data.allowedEffects.includes("origin-apply")
	)
		throw new Error("Goal preauthorized apply lacks scope");
	if (
		data.roots.length === 0 &&
		(data.allowedEffects.includes("candidate-write") ||
			data.allowedEffects.includes("origin-apply"))
	)
		throw new Error("Goal rootless authority cannot allow filesystem effects");
	return data;
}
export function parseGoalProfile(input: unknown): GoalProfileCapture {
	const data = parse<GoalProfileCapture>(input, profile);
	unique(data.roles.map((r) => r.role));
	return data;
}
export function parseGoalContract(input: unknown): GoalContract {
	const data = parse<GoalContract>(input, contractShape);
	parseGoalAuthority(data.authority);
	parseGoalProfile(data.profile);
	for (const effect of data.authority.allowedEffects) {
		if (data.exclusions.includes(effect))
			throw new Error("Goal effect cannot be both allowed and excluded");
	}
	unique(data.criteria.map((c) => c.id));
	unique(data.subjectScope);
	if (
		(data.authority.roots.length === 0) !== (data.subjectScope.length === 0)
	)
		throw new Error("Goal roots and subject scope must be empty together");
	if (!data.criteria.some((c) => c.required))
		throw new Error("Goal requires a required criterion");
	if ((data.revision === 1) !== (data.previousHash === null))
		throw new Error("Goal revision predecessor mismatch");
	if (
		data.authority.goalId !== data.goalId ||
		data.authority.revision !== data.revision ||
		goalHash(data.authority) !== data.authorityHash ||
		goalHash(data.profile) !== data.profileHash
	)
		throw new Error("Goal authority/profile binding mismatch");
	if (data.executionMode === "background" && !data.authority.backgroundAllowed)
		throw new Error("Goal background not authorized");
	if (
		data.completionTarget === "origin" &&
		!data.criteria.some((c) => c.required && c.binding.target === "origin")
	)
		throw new Error("Goal origin requires origin criterion");
	if (data.authority.roots.length === 0) {
		if (
			data.subjectScope.length !== 0 ||
			data.completionTarget !== "artifact" ||
			data.criteria.some((criterion) => criterion.binding.target !== "artifact") ||
			data.authority.allowedEffects.includes("candidate-write") ||
			data.authority.allowedEffects.includes("origin-apply")
		)
			throw new Error("Goal rootless scope must be artifact-only");
	}
	return data;
}
export function assertGoalRevision(
	previous: GoalContract,
	next: GoalContract,
): void {
	parseGoalContract(previous);
	parseGoalContract(next);
	if (
		next.goalId !== previous.goalId ||
		next.revision !== previous.revision + 1 ||
		next.previousHash !== goalHash(previous)
	)
		throw new Error("Goal revision chain mismatch");
	// Model changes require a separate Goal; revisions cannot silently re-resolve capture.
	if (
		next.profileHash !== previous.profileHash ||
		next.authority.revocationGeneration < previous.authority.revocationGeneration
	)
		throw new Error("Goal revision profile/revocation regression");
}
const receiptShape = obj({
	schemaVersion: version,
	id,
	contractHash: digest,
	criterionId: id,
	binding,
	kind,
	acceptanceDigest: digest,
	result: one("pass", "fail", "unknown"),
	observedAt: nat,
	validUntil: nat,
	evidenceRefs: arr(digest, 1),
	producer: obj({ id, lineageDigest: digest }),
	model: nullable(
		obj({
			model: str,
			thinking: one(...THINKING_LEVELS),
			accessDigest: digest,
			judgment: str,
			counterexamples: arr(str),
			limitations: arr(str),
		}),
	),
	humanRequestHash: nullable(digest),
});
export function parseGoalReceipt(input: unknown): GoalReceipt {
	const data = parse<GoalReceipt>(input, receiptShape);
	if (
		data.validUntil < data.observedAt ||
		(data.kind === "model-rubric") !== (data.model !== null) ||
		(data.kind === "human") !== (data.humanRequestHash !== null)
	)
		throw new Error("Goal receipt semantics mismatch");
	return data;
}
const blocker = obj({
	id,
	criterionId: id,
	errorClass: one(
		"dependency",
		"availability",
		"authority",
		"human",
		"origin-conflict",
		"no-progress",
		"effect-unknown",
	),
	resource: str,
	predicateId: id,
	instanceDigest: digest,
	diagnosis: str,
	requiredInput: str,
});
const base = { schemaVersion: version, id, contractHash: digest };
const eventChecks: Record<GoalEventData["type"], Check> = {
	start: obj({ ...base, type: one("start") }),
	reconcile: obj({ ...base, type: one("reconcile") }),
	"receipt": obj({
		...base,
		type: one("receipt"),
		receipt: (v) => {
			parseGoalReceipt(v);
		},
	}),
	plan: obj({
		...base,
		type: one("plan"),
		planId: id,
		effectId: id,
		actionKey: digest,
		proposalHash: digest,
		criterionIds: arr(id, 1, 128),
	}),
	"binding-updated": obj({
		...base,
		type: one("binding-updated"),
		criterionId: id,
		previousBindingHash: digest,
		binding,
		subjectScope: str,
		authorityHash: digest,
		evidenceRefs: arr(digest, 1),
	}),
	"blocker-resolved": obj({
		...base,
		type: one("blocker-resolved"),
		blockerId: id,
		instanceDigest: digest,
		blockerEventId: id,
		authorityHash: digest,
		evidenceRefs: arr(digest, 1),
	}),
	"evidence-resolved": obj({
		...base,
		type: one("evidence-resolved"),
		criterionId: id,
		bindingHash: digest,
		receiptIds: arr(id, 1),
		replacementReceiptId: id,
		evidenceRefs: arr(digest, 1),
		rationale: str,
	}),
	effect: obj({
		...base,
		type: one("effect"),
		effectId: id,
		kind: one("child", "probe", "apply", "stop", "verifier", "helper"),
		state: one("active", "unknown", "drained"),
	}),
	probe: obj({
		...base,
		type: one("probe"),
		record: (v) => {
			parseGoalProbeRecord(v);
		},
	}),
	"effect-usage": obj({
		...base,
		type: one("effect-usage"),
		effectId: id,
		requestEventHash: digest,
		usage: obj({ requests: nat, costMicros: nat }),
		evidenceRefs: arr(digest, 1),
	}),
	control: obj({
		...base,
		type: one("control"),
		action: one("pause", "cancel", "resume", "revoke"),
	}),
	revision: obj({
		...base,
		type: one("revision"),
		contract: (v) => {
			parseGoalContract(v);
		},
	}),
	blocker: obj({ ...base, type: one("blocker"), blocker }),
	resume: obj({
		...base,
		type: one("resume"),
		blockerId: id,
		blockerEventId: id,
		instanceDigest: digest,
		predicateId: id,
		condition: bool,
		ownerPresent: bool,
	}),
	attempt: obj({
		...base,
		type: one("attempt"),
		operationId: id,
		consumed: nullable(positive),
		usage: obj({ requests: nullable(nat), costMicros: nullable(nat) }),
	}),
	progress: obj({
		...base,
		type: one("progress"),
		criterionId: id,
		strategyDigest: digest,
		delta: one(
			"new_relevant_observation",
			"hypothesis_refuted",
			"criterion_coverage_increased",
			"candidate_improved",
			"none",
			"unknown",
		),
		beforeDigest: digest,
		afterDigest: digest,
		evidenceRefs: arr(digest),
		confidence: one("deterministic", "model-based", "unknown"),
	}),
	apply: obj({
		...base,
		type: one("apply"),
		intentHash: digest,
		applyJournalHead: obj({ seq: nat, hash: digest }),
		originIdentity: id,
		originDigest: digest,
		at: nat,
		state: one("verified", "partial", "unknown"),
	}),
	terminal: obj({
		...base,
		type: one("terminal"),
		lifecycle: one("achieved", "cancelled", "failed"),
		at: nat,
	}),
	note: obj({ ...base, type: one("note"), text: str }),
};
export function parseGoalEvent(input: unknown): GoalEventData {
	const data = parse<GoalEventData>(input, (v) => {
		const type = (v as { type?: string } | null)?.type;
		if (!type || !Object.hasOwn(eventChecks, type))
			throw new Error("Goal unknown event type");
		eventChecks[type as GoalEventData["type"]](v);
	});
	if (
		data.type === "binding-updated" ||
		data.type === "blocker-resolved" ||
		data.type === "evidence-resolved"
	)
		unique(data.evidenceRefs);
	if (data.type === "evidence-resolved") {
		unique(data.receiptIds);
		if (data.receiptIds.includes(data.replacementReceiptId))
			throw new Error("Goal replacement cannot supersede itself");
	}
	return data;
}
export function parseGoalObservations(input: unknown): GoalObservations {
	const data = parse<GoalObservations>(
		input,
		obj({
			schemaVersion: version,
			at: nat,
			effectsKnown: bool,
			effects: arr(
				obj({
					id,
					kind: one("child", "probe", "apply", "stop", "verifier", "helper"),
					state: one("active", "unknown", "drained"),
				}),
			),
			bindings: arr(obj({ criterionId: id, binding })),
		}),
	);
	unique(data.effects.map((e) => e.id));
	unique(data.bindings.map((b) => b.criterionId));
	return data;
}
export function humanGoalRequestHash(
	contractHash: string,
	criterionId: string,
	current: GoalBinding,
): string {
	return goalHash({
		schemaVersion: 1,
		contractHash,
		criterionId,
		binding: current,
		action: "accept-human",
	});
}

const acceptedEvents = new WeakSet<object>();
const acceptedObservations = new WeakSet<object>();
const acceptedContracts = new WeakSet<object>();
const acceptedCommittedSnapshots = new WeakSet<object>();
/** HOST ONLY. Keep this closure out of tools/worker arguments. This is NOT user,
 * worker or broker authentication. P1 fixtures stand in for those future adapters.
 * Any code executing in the host is trusted; serialized flags/signatures grant nothing.
 */
export function createGoalHostIngress() {
	return Object.freeze({
		contract(input: unknown, actorInput: GoalActor): GoalContract {
			const actor = parse<GoalActor>(actorInput, obj({ kind: one("user"), id }));
			const data = parseGoalContract(input);
			if (actor.id !== data.authority.issuer)
				throw new Error("Goal issuer mismatch");
			acceptedContracts.add(data);
			return data;
		},
		event(
			input: unknown,
			actorInput: GoalActor,
			observationsInput: unknown,
		): GoalAcceptedEvent {
			const data = parseGoalEvent(input);
			const actor = parse<GoalActor>(
				actorInput,
				obj({ kind: one("host", "user", "verifier"), id }),
			);
			const userControl =
				data.type === "control" ||
				data.type === "revision" ||
				data.type === "blocker-resolved";
			if (userControl && actor.kind !== "user")
				throw new Error("Goal user ingress required");
			if (data.type === "receipt") {
				if (
					actor.kind !== (data.receipt.kind === "human" ? "user" : "verifier") ||
					data.receipt.producer.id !== actor.id
				)
					throw new Error("Goal receipt producer ingress mismatch");
			} else if (data.type === "evidence-resolved") {
				if (actor.kind !== "user" && actor.kind !== "verifier")
					throw new Error("Goal evidence resolution needs verifier/user ingress");
			} else if (!userControl && actor.kind !== "host")
				throw new Error("Goal host ingress required");
			const accepted = frozen({
				data,
				actor,
				observations: parseGoalObservations(observationsInput),
			});
			acceptedEvents.add(accepted);
			return accepted;
		},
		observations(input: unknown): GoalAcceptedObservations {
			const accepted = frozen({ data: parseGoalObservations(input) });
			acceptedObservations.add(accepted);
			return accepted;
		},
		/** Fixture host attestation only. Shape, journal and reducer consistency are
		 * validated by the consumer; this is not durable-store provenance. */
		committedSnapshot(input: GoalCommittedSnapshot): GoalCommittedSnapshot {
			goalJson(input);
			const accepted = frozen(input);
			acceptedCommittedSnapshots.add(accepted);
			return accepted;
		},
	});
}
export function assertAcceptedGoalContract(value: GoalContract): void {
	if (!acceptedContracts.has(value))
		throw new Error("Goal contract needs host user ingress");
}
export function assertAcceptedGoalEvent(value: GoalAcceptedEvent): void {
	if (!acceptedEvents.has(value))
		throw new Error("Goal event needs host ingress, not serialized trust");
}
export function assertAcceptedGoalObservations(
	value: GoalAcceptedObservations,
): void {
	if (!acceptedObservations.has(value))
		throw new Error("Goal observations need host ingress");
}
export function assertAcceptedGoalCommittedSnapshot(
	value: GoalCommittedSnapshot,
): void {
	if (!acceptedCommittedSnapshots.has(value))
		throw new Error("Goal committed snapshot needs host ingress");
}
