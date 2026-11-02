import { goalHash, humanGoalRequestHash } from "./goal-contract.js";
import type {
	GoalActor,
	GoalBinding,
	GoalContract,
	GoalCriterion,
	GoalEventData,
	GoalObservations,
	GoalReceipt,
} from "./goal-types.js";

export interface GoalEvidenceContext {
	contract: GoalContract;
	criterion: GoalCriterion;
	binding: GoalBinding;
	observations: GoalObservations;
	receipts: readonly GoalReceipt[];
	superseded: ReadonlySet<string>;
	apply: { at: number; state: "verified" | "partial" | "unknown" } | null;
}

/** Immutable verifier policy is distinct from a host-attested current subject. */
export function assertGoalBindingUpdate(
	contract: GoalContract,
	current: GoalBinding,
	event: Extract<GoalEventData, { type: "binding-updated" }>,
	observations: GoalObservations,
): void {
	const { subjectDigest: previousSubject, ...policy } = current;
	const { subjectDigest: nextSubject, ...nextPolicy } = event.binding;
	const observed = observations.bindings.find(
		(b) => b.criterionId === event.criterionId,
	)?.binding;
	if (
		event.previousBindingHash !== goalHash(current) ||
		previousSubject === nextSubject
	) {
		throw new Error("Goal binding predecessor/no-op mismatch");
	}
	if (goalHash(policy) !== goalHash(nextPolicy))
		throw new Error("Goal binding policy change requires revision");
	if (
		event.authorityHash !== contract.authorityHash ||
		!contract.subjectScope.includes(event.subjectScope)
	) {
		throw new Error("Goal binding scope/authority mismatch");
	}
	if (
		!contract.authority.allowedEffects.includes("read") ||
		!contract.authority.allowedEffects.includes("verify")
	) {
		throw new Error("Goal binding observation outside authority");
	}
	if (!observed || goalHash(observed) !== goalHash(event.binding))
		throw new Error("Goal binding host observation mismatch");
	// The host broker must attest actual membership in subjectScope. A digest/ref
	// or this pure allowlist check is not filesystem confinement or authentication.
}

export function validGoalReceipts(context: GoalEvidenceContext): GoalReceipt[] {
	const {
		contract,
		criterion,
		binding,
		observations,
		receipts,
		superseded,
		apply,
	} = context;
	const current = observations.bindings.find(
		(b) => b.criterionId === criterion.id,
	)?.binding;
	if (!current || goalHash(current) !== goalHash(binding)) return [];
	const contractHash = goalHash(contract);
	const bindingHash = goalHash(binding);
	return receipts.filter((receipt) => {
		if (superseded.has(receipt.id) || receipt.criterionId !== criterion.id)
			return false;
		if (
			receipt.contractHash !== contractHash ||
			receipt.kind !== criterion.kind ||
			receipt.acceptanceDigest !== criterion.acceptanceDigest
		)
			return false;
		if (
			goalHash(receipt.binding) !== bindingHash ||
			receipt.producer.id !== binding.verifierId ||
			receipt.producer.lineageDigest !== binding.producerLineageDigest
		)
			return false;
		if (
			receipt.observedAt > observations.at ||
			receipt.validUntil < observations.at ||
			observations.at - receipt.observedAt > criterion.maxAgeMs
		)
			return false;
		if (
			contract.completionTarget === "origin" &&
			binding.target === "origin" &&
			(apply?.state !== "verified" || receipt.observedAt < apply.at)
		)
			return false;
		if (
			criterion.kind === "human" &&
			receipt.humanRequestHash !==
				humanGoalRequestHash(contractHash, criterion.id, binding)
		)
			return false;
		if (criterion.kind === "model-rubric") {
			const profile = contract.profile.roles.find(
				(p) => p.role === "verification",
			);
			if (
				receipt.model?.model !== profile?.model ||
				receipt.model?.thinking !== profile?.thinking
			)
				return false;
		}
		return true;
	});
}

/** Explicit, scoped evidence retirement. It never deletes source receipts or
 * substitutes majority/latest-wins for the registered verifier's fresh decision. */
export function assertGoalEvidenceResolution(
	context: GoalEvidenceContext,
	event: Extract<GoalEventData, { type: "evidence-resolved" }>,
	actor: GoalActor,
): void {
	const { criterion, binding } = context;
	const expectedKind = criterion.kind === "human" ? "user" : "verifier";
	if (actor.kind !== expectedKind || actor.id !== binding.verifierId)
		throw new Error("Goal resolution verifier mismatch");
	if (event.bindingHash !== goalHash(binding))
		throw new Error("Goal resolution binding mismatch");
	const valid = validGoalReceipts(context);
	const replacement = valid.find((r) => r.id === event.replacementReceiptId);
	if (
		!replacement ||
		replacement.result === "unknown" ||
		(replacement.model?.counterexamples.length ?? 0) > 0
	) {
		throw new Error("Goal resolution requires definitive valid replacement");
	}
	const previous = valid.filter((r) => r.id !== replacement.id);
	const expected = previous.map((r) => r.id).sort();
	if (
		!previous.length ||
		goalHash(expected) !== goalHash([...event.receiptIds].sort())
	) {
		throw new Error("Goal resolution must cover all current evidence");
	}
	if (
		!previous.some(
			(r) =>
				r.result !== replacement.result ||
				(r.model?.counterexamples.length ?? 0) > 0,
		)
	) {
		throw new Error("Goal resolution has no conflict/unknown to resolve");
	}
	if (previous.some((r) => replacement.observedAt <= r.observedAt))
		throw new Error("Goal resolution requires a newer observation");
	const oldEvidence = new Set(previous.flatMap((r) => r.evidenceRefs));
	if (!replacement.evidenceRefs.some((ref) => !oldEvidence.has(ref)))
		throw new Error("Goal resolution needs fresh verification evidence");
	// evidenceRefs/rationale describe the actual resolution at a future broker.
	// P1 validates their binding/cardinality; it does not judge semantic truth.
}
