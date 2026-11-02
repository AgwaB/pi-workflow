import type { ThinkingLevel, WorkflowProfileRole } from "./types.js";

/** Dormant Goal P1 data contracts. Digests identify bytes, not actors or sandboxes. */
export type Digest = string;
export type AcceptanceKind = "deterministic" | "model-rubric" | "human";
export type CriterionState =
	| "met"
	| "unmet"
	| "unknown"
	| "stale"
	| "conflicted";
export type GoalLifecycle =
	| "draft"
	| "running"
	| "waiting_user"
	| "blocked"
	| "pausing"
	| "paused"
	| "cancelling"
	| "cancelled"
	| "achieved"
	| "failed";
export type GoalEffectKind =
	| "child"
	| "probe"
	| "apply"
	| "stop"
	| "verifier"
	| "helper";
export interface GoalBinding {
	subjectDigest: Digest;
	environmentDigest: Digest;
	verifierId: string;
	producerLineageDigest: Digest;
	codeDigest: Digest;
	configDigest: Digest;
	target: "artifact" | "candidate" | "origin";
}
export interface GoalCriterion {
	id: string;
	statement: string;
	required: boolean;
	kind: AcceptanceKind;
	binding: GoalBinding;
	acceptanceDigest: Digest;
	maxAgeMs: number;
}
export interface GoalAuthority {
	schemaVersion: 1;
	goalId: string;
	revision: number;
	issuer: string;
	actorReceipt: Digest;
	scopeDigest: Digest;
	allowedEffects: ("read" | "candidate-write" | "verify" | "origin-apply" | "workflow-create")[];
	roots: string[];
	protectedPaths: string[];
	applyMode: "confirm" | "preauthorized";
	backgroundAllowed: boolean;
	resumePredicates: string[];
	revocationGeneration: number;
}
export interface GoalProfileCapture {
	schemaVersion: 1;
	name: string;
	source: "builtin" | "custom";
	templateFingerprint: Digest;
	environmentDigest: Digest;
	roles: {
		role: WorkflowProfileRole;
		model: string;
		thinking: ThinkingLevel;
		origin: { model: "fixed" | "inherit"; thinking: "fixed" | "inherit" };
	}[];
}
/** Run-local configuration evidence, never an execution or confirmation capability. */
export interface GoalProfileScope {
	rootRunId: string;
	/** Original source execution namespace evidence, never admission or authority. */
	executionRunId: string;
	goalPath: readonly {
		policySpecId: string;
		definitionFingerprint: Digest;
		child?: {
			generation: number;
			slot: string;
			workflowId: string;
			specHash: Digest;
			requestHash: Digest;
		};
	}[];
	template: string;
	role: WorkflowProfileRole;
	item?: {
		placeholderSpecId: string;
		itemIdentity: string;
		itemHash: Digest;
		sourceGeneration: number;
		dispatchDigest: Digest;
		materializedTaskId: string;
		materializedSpecId: string;
		itemSourceTaskId: string;
		itemSourceSpecId: string;
		itemSourceKind: "control" | "partial";
		itemRef: string;
	};
}
export type GoalProfileRuntimePatch =
	| { model: string; thinking?: ThinkingLevel }
	| { model?: string; thinking: ThinkingLevel };
export interface GoalProfileCaptureRevisionProposal {
	schemaVersion: 1;
	captureRevision: number;
	previousCaptureHash: Digest | null;
	rootProfileHash: Digest;
	/** Only fields actually present at initial capture; never repairs invalid roles. */
	initialBase: { model?: string; thinking?: ThinkingLevel };
	exceptions: readonly {
		scope: GoalProfileScope;
		runtime: GoalProfileRuntimePatch;
		reason: string;
	}[];
}
export interface GoalProfileCaptureRevision extends GoalProfileCaptureRevisionProposal {
	/** Audit data only. The original live host must independently confirm and bind it. */
	confirmation: {
		provenance: "original-live-tui";
		previewHash: Digest;
		confirmedAt: string;
	};
}
/** Immutable per-policy profile publication record; never a live admission. */
export interface WorkflowGoalProfileConfiguration {
	schemaVersion: 1;
	policyDefinitionFingerprint: Digest;
	confirmationRootProfile: GoalProfileCapture;
	/** Complete immutable chain; publication/currentness validation requires revision 1 and at least one entry. */
	acceptedRevisions: readonly GoalProfileCaptureRevision[];
}
export interface GoalContract {
	schemaVersion: 1;
	goalId: string;
	revision: number;
	previousHash: Digest | null;
	requestDigest: Digest;
	subjectScope: string[];
	criteria: GoalCriterion[];
	authority: GoalAuthority;
	authorityHash: Digest;
	profile: GoalProfileCapture;
	profileHash: Digest;
	executionMode: "foreground" | "background";
	completionTarget: "artifact" | "origin" | "unresolved";
	limits: { requests: number | null; costMicros: number | null };
	exclusions: string[];
}
export interface GoalReceipt {
	schemaVersion: 1;
	id: string;
	contractHash: Digest;
	criterionId: string;
	binding: GoalBinding;
	kind: AcceptanceKind;
	acceptanceDigest: Digest;
	result: "pass" | "fail" | "unknown";
	observedAt: number;
	validUntil: number;
	evidenceRefs: Digest[];
	producer: { id: string; lineageDigest: Digest };
	model: {
		model: string;
		thinking: ThinkingLevel;
		accessDigest: Digest;
		judgment: string;
		counterexamples: string[];
		limitations: string[];
	} | null;
	// Must match the exact host-created human pending request, not just a subject.
	humanRequestHash: Digest | null;
}
export interface GoalBlocker {
	id: string;
	criterionId: string;
	errorClass:
		| "dependency"
		| "availability"
		| "authority"
		| "human"
		| "origin-conflict"
		| "no-progress"
		| "effect-unknown";
	resource: string;
	predicateId: string;
	instanceDigest: Digest;
	diagnosis: string;
	requiredInput: string;
}
export interface GoalProbeEpisodeBinding {
	contractHash: Digest;
	profileHash: Digest;
	authorityHash: Digest;
	revocationGeneration: number;
	registryHash: Digest;
	blockerId: string;
	blockerEventId: string;
	instanceDigest: Digest;
	family: Digest;
	predicateId: string;
}
/** Typed journal data is not probe-adapter or effect-census provenance. */
export type GoalProbeRecord =
	| { schemaVersion: 1; type: "open"; episode: GoalProbeEpisodeBinding }
	| {
			schemaVersion: 1;
			type: "claim";
			episodeHash: Digest;
			probeId: string;
			ownerHash: Digest;
			controlHash: Digest;
	  }
	| {
			schemaVersion: 1;
			type: "result";
			episodeHash: Digest;
			probeId: string;
			claimEventId: string;
			outcome: "true" | "false" | "error";
			evidenceRefs: Digest[];
	  }
	| {
			schemaVersion: 1;
			type: "drain";
			episodeHash: Digest;
			probeId: string;
			claimEventId: string;
			resultEventId: string;
			evidenceRefs: Digest[];
	  }
	| {
			schemaVersion: 1;
			type: "abandoned-drain";
			episodeHash: Digest;
			probeId: string;
			claimEventId: string;
			reasonDigest: Digest;
			evidenceRefs: Digest[];
	  }
	| {
			schemaVersion: 1;
			type: "disarm";
			episodeHash: Digest;
			reason: "pause" | "cancel" | "revoke" | "manual";
	  };
export type GoalEventData =
	| {
			schemaVersion: 1;
			id: string;
			contractHash: Digest;
			type: "start" | "reconcile";
	  }
	| {
			schemaVersion: 1;
			id: string;
			contractHash: Digest;
			type: "plan";
			planId: string;
			effectId: string;
			actionKey: Digest;
			proposalHash: Digest;
			criterionIds: string[];
	  }
	| {
			schemaVersion: 1;
			id: string;
			contractHash: Digest;
			type: "receipt";
			receipt: GoalReceipt;
	  }
	| {
			schemaVersion: 1;
			id: string;
			contractHash: Digest;
			type: "binding-updated";
			criterionId: string;
			previousBindingHash: Digest;
			binding: GoalBinding;
			subjectScope: string;
			authorityHash: Digest;
			evidenceRefs: Digest[];
	  }
	| {
			schemaVersion: 1;
			id: string;
			contractHash: Digest;
			type: "blocker-resolved";
			blockerId: string;
			instanceDigest: Digest;
			blockerEventId: string;
			authorityHash: Digest;
			evidenceRefs: Digest[];
	  }
	| {
			schemaVersion: 1;
			id: string;
			contractHash: Digest;
			type: "evidence-resolved";
			criterionId: string;
			bindingHash: Digest;
			receiptIds: string[];
			replacementReceiptId: string;
			evidenceRefs: Digest[];
			rationale: string;
	  }
	| {
			schemaVersion: 1;
			id: string;
			contractHash: Digest;
			type: "effect";
			effectId: string;
			kind: GoalEffectKind;
			state: "active" | "unknown" | "drained";
	  }
	| {
			schemaVersion: 1;
			id: string;
			contractHash: Digest;
			type: "probe";
			record: GoalProbeRecord;
	  }
	| {
			schemaVersion: 1;
			id: string;
			contractHash: Digest;
			type: "effect-usage";
			effectId: string;
			requestEventHash: Digest;
			usage: { requests: number; costMicros: number };
			evidenceRefs: Digest[];
	  }
	| {
			schemaVersion: 1;
			id: string;
			contractHash: Digest;
			type: "control";
			action: "pause" | "cancel" | "resume" | "revoke";
	  }
	| {
			schemaVersion: 1;
			id: string;
			contractHash: Digest;
			type: "revision";
			contract: GoalContract;
	  }
	| {
			schemaVersion: 1;
			id: string;
			contractHash: Digest;
			type: "blocker";
			blocker: GoalBlocker;
	  }
	| {
			schemaVersion: 1;
			id: string;
			contractHash: Digest;
			type: "resume";
			blockerId: string;
			blockerEventId: string;
			instanceDigest: Digest;
			predicateId: string;
			condition: boolean;
			ownerPresent: boolean;
	  }
	| {
			schemaVersion: 1;
			id: string;
			contractHash: Digest;
			type: "attempt";
			operationId: string;
			consumed: number | null;
			usage: { requests: number | null; costMicros: number | null };
	  }
	| {
			schemaVersion: 1;
			id: string;
			contractHash: Digest;
			type: "progress";
			criterionId: string;
			strategyDigest: Digest;
			delta:
				| "new_relevant_observation"
				| "hypothesis_refuted"
				| "criterion_coverage_increased"
				| "candidate_improved"
				| "none"
				| "unknown";
			beforeDigest: Digest;
			afterDigest: Digest;
			evidenceRefs: Digest[];
			confidence: "deterministic" | "model-based" | "unknown";
	  }
	| {
			schemaVersion: 1;
			id: string;
			contractHash: Digest;
			type: "apply";
			intentHash: Digest;
			applyJournalHead: { seq: number; hash: Digest };
			originIdentity: string;
			originDigest: Digest;
			at: number;
			state: "verified" | "partial" | "unknown";
	  }
	| {
			schemaVersion: 1;
			id: string;
			contractHash: Digest;
			type: "terminal";
			lifecycle: "achieved" | "cancelled" | "failed";
			at: number;
	  }
	| {
			schemaVersion: 1;
			id: string;
			contractHash: Digest;
			type: "note";
			text: string;
	  };
export interface GoalActor {
	kind: "user" | "verifier" | "host";
	id: string;
}
export interface GoalAcceptedEvent {
	readonly data: GoalEventData;
	readonly actor: GoalActor;
	readonly observations: GoalObservations;
}
export interface GoalObservations {
	schemaVersion: 1;
	at: number;
	// Complete host inventory: no inventory is not evidence of no effects.
	effectsKnown: boolean;
	effects: {
		id: string;
		kind: GoalEffectKind;
		state: "active" | "unknown" | "drained";
	}[];
	bindings: { criterionId: string; binding: GoalBinding }[];
}
export interface GoalAcceptedObservations {
	readonly data: GoalObservations;
}
/** Store-compatible committed journal snapshot. Host acceptance remains a
 * fixture capability, not proof of durable origin or provenance. */
export interface GoalCommittedSnapshot {
	readonly status: "ok";
	readonly contract: GoalContract;
	readonly events: GoalAcceptedEvent[];
	readonly decision: GoalDecision;
	readonly seq: number;
	readonly hash: Digest;
	readonly ownerId: string;
	readonly epoch: number;
	readonly evidence: string[];
}
export interface GoalDecision {
	schemaVersion: 1;
	contractHash: Digest;
	lifecycle: GoalLifecycle;
	phase: "observe" | "plan" | "reconcile" | "verify" | "apply";
	reasons: string[];
	criteria: {
		id: string;
		kind: AcceptanceKind;
		state: CriterionState;
		receiptIds: string[];
		supersededReceiptIds: string[];
	}[];
	pendingEffects: string[];
	blockers: GoalBlocker[];
	resolvedBlockers: {
		blocker: GoalBlocker;
		blockerEventId: string;
		resolutionEventId: string;
		evidenceRefs: Digest[];
	}[];
	counters: {
		attempts: Record<string, number | null>;
		noProgress: number;
		progress: number;
		unknownProgress: number;
		resumes: Record<string, number>;
		requests: number | null;
		costMicros: number | null;
	};
	proposals: {
		type:
			| "admit"
			| "clarify-target"
			| "verify"
			| "human-acceptance"
			| "reconcile"

			| "apply"
			| "stop"
			| "finalize";
		criterionId: string | null;
	}[];
}
