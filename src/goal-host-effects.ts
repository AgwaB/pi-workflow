import {
	digest,
	frozen,
	goalHash,
	goalInput,
	id,
	nat,
	obj,
	one,
	parse,
	positive,
	type Check,
} from "./goal-json.js";
import {
	GoalHostJournal,
	type GoalHostJournalSnapshot,
} from "./goal-host-journal.js";

/** Durable host bookkeeping, NOT execution permission, provenance or kernel drain. */
export interface GoalHostEffectScope {
	goalId: string;
	scopeId: string;
	ownerEpoch: number;
	sessionDigest: string;
}
export type GoalHostEffectOperation =
	| "spawn"
	| "release"
	| "tool"
	| "stop"
	| "inspect"
	| "remove"
	| "apply"
	| "verify"
	| "workspace-create"
	| "workspace-write"
	| "workspace-cleanup";
export type GoalHostEffectRecord =
	| { type: "opened"; scope: GoalHostEffectScope }
	| {
			type: "producer-opened";
			producerId: string;
			kind:
				| "sdk"
				| "container"
				| "observer"
				| "verifier"
				| "helper"
				| "workspace"
				| "apply";
	  }
	| {
			type: "producer-bound";
			producerId: string;
			incarnationDigest: string;
			channelDigest: string;
	  }
	| {
			type: "requested";
			effectId: string;
			producerId: string;
			operation: GoalHostEffectOperation;
			requestDigest: string;
			goalHead: { seq: number; hash: string };
	  }
	| {
			type: "consent-bound";
			effectId: string;
			requestDigest: string;
			consentHash: string;
			grantId: string;
			stateDigest: string;
			expiresAt: number;
	  }
	| {
			type: "result";
			effectId: string;
			requestSeq: number;
			outcome: "acknowledged" | "rejected" | "unknown";
			resultDigest: string;
	  }
	| {
			type: "callback";
			producerId: string;
			ordinal: number;
			kind: "ready" | "tool" | "diagnostic" | "final";
			frameDigest: string;
	  }
	| {
			type: "fenced";
			reason: "stop" | "complete" | "owner-lost" | "session-lost" | "protocol";
	  }
	| {
			type: "producer-fenced";
			producerId: string;
			reason: "stop" | "complete";
	  }
	| {
			type: "producer-closed";
			producerId: string;
			outcome: "closed" | "never-started" | "unknown";
			observationDigest: string;
	  }
	| { type: "contradiction"; code: string; evidenceDigest: string }
	| {
			type: "sealed";
			previousHead: { seq: number; hash: string };
			censusDigest: string;
	  };

const constructionKey = Symbol("fresh Goal effect ledger construction");
const headCheck = obj({ seq: nat, hash: digest });
const scopeCheck = obj({
	goalId: id,
	scopeId: id,
	ownerEpoch: nat,
	sessionDigest: digest,
});
const checks: Record<GoalHostEffectRecord["type"], Check> = {
	opened: obj({ type: one("opened"), scope: scopeCheck }),
	"producer-opened": obj({
		type: one("producer-opened"),
		producerId: id,
		kind: one(
			"sdk",
			"container",
			"observer",
			"verifier",
			"helper",
			"workspace",
			"apply",
		),
	}),
	"producer-bound": obj({
		type: one("producer-bound"),
		producerId: id,
		incarnationDigest: digest,
		channelDigest: digest,
	}),
	requested: obj({
		type: one("requested"),
		effectId: id,
		producerId: id,
		operation: one(
			"spawn",
			"release",
			"tool",
			"stop",
			"inspect",
			"remove",
			"apply",
			"verify",
			"workspace-create",
			"workspace-write",
			"workspace-cleanup",
		),
		requestDigest: digest,
		goalHead: headCheck,
	}),
	result: obj({
		type: one("result"),
		effectId: id,
		requestSeq: positive,
		outcome: one("acknowledged", "rejected", "unknown"),
		resultDigest: digest,
	}),
	"consent-bound": obj({
		type: one("consent-bound"),
		effectId: id,
		requestDigest: digest,
		consentHash: digest,
		grantId: id,
		stateDigest: digest,
		expiresAt: positive,
	}),
	callback: obj({
		type: one("callback"),
		producerId: id,
		ordinal: positive,
		kind: one("ready", "tool", "diagnostic", "final"),
		frameDigest: digest,
	}),
	fenced: obj({
		type: one("fenced"),
		reason: one("stop", "complete", "owner-lost", "session-lost", "protocol"),
	}),
	"producer-fenced": obj({
		type: one("producer-fenced"),
		producerId: id,
		reason: one("stop", "complete"),
	}),
	"producer-closed": obj({
		type: one("producer-closed"),
		producerId: id,
		outcome: one("closed", "never-started", "unknown"),
		observationDigest: digest,
	}),
	contradiction: obj({
		type: one("contradiction"),
		code: id,
		evidenceDigest: digest,
	}),
	sealed: obj({
		type: one("sealed"),
		previousHead: headCheck,
		censusDigest: digest,
	}),
};
export function parseGoalHostEffectRecord(
	input: unknown,
): GoalHostEffectRecord {
	return parse<GoalHostEffectRecord>(input, (value) => {
		if (
			!value ||
			typeof value !== "object" ||
			!("type" in value) ||
			typeof value.type !== "string" ||
			!Object.hasOwn(checks, value.type)
		)
			throw new Error("Unknown Goal host effect record");
		checks[value.type as GoalHostEffectRecord["type"]](value);
	});
}

interface Producer {
	kind: Extract<GoalHostEffectRecord, { type: "producer-opened" }>["kind"];
	bound: boolean;
	ordinal: number;
	final: boolean;
	localFenced: boolean;
	closed: boolean;
}
interface Request {
	producerId: string;
	seq: number;
	operation: GoalHostEffectOperation;
	outcome: "pending" | "acknowledged" | "rejected" | "unknown";
	requestDigest: string;
	consentBound: boolean;
}
export interface GoalHostEffectCensus {
	readonly scope: Readonly<GoalHostEffectScope>;
	readonly head: { readonly seq: number; readonly hash: string };
	readonly fenced: boolean;
	readonly sealed: boolean;
	readonly pendingEffects: readonly string[];
	readonly unknownEffects: readonly string[];
	readonly openProducers: readonly string[];
	readonly conflicts: readonly string[];
	/** Only a control-plane precondition for an independent physical census. */
	readonly bookkeepingComplete: boolean;
	readonly goalDrain: "not-established";
}
function requireState(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`Goal host effects: ${message}`);
}

/** Replays COMPLETE journal history. A caller-created snapshot has no host authority. */
export function inspectGoalHostEffects(
	snapshot: GoalHostJournalSnapshot,
): GoalHostEffectCensus {
	let scope: GoalHostEffectScope | undefined;
	let fenced = false;
	let sealed = false;
	let priorHash = "0".repeat(64);
	const producers = new Map<string, Producer>();
	const requests = new Map<string, Request>();
	const grants = new Set<string>();
	const conflicts: string[] = [];
	const producer = (key: string): Producer => {
		const value = producers.get(key);
		requireState(value, "producer was not durably opened");
		return value;
	};
	const complete = (): boolean =>
		fenced &&
		conflicts.length === 0 &&
		[...producers.values()].every((p) => p.closed) &&
		[...requests.values()].every(
			(r) => r.outcome === "acknowledged" || r.outcome === "rejected",
		);
	for (let index = 0; index < snapshot.records.length; index += 1) {
		const entry = snapshot.records[index];
		requireState(
			entry.version === 1 &&
				entry.seq === index + 1 &&
				entry.previousHash === priorHash,
			"journal sequence or predecessor differs",
		);
		requireState(
			entry.hash ===
				goalHash({
					version: entry.version,
					seq: entry.seq,
					previousHash: entry.previousHash,
					payload: entry.payload,
				}),
			"journal record hash differs",
		);
		const record = parseGoalHostEffectRecord(entry.payload);
		if (!scope)
			requireState(
				record.type === "opened" && index === 0,
				"scope genesis required",
			);
		if (sealed)
			requireState(
				record.type === "callback" ||
					record.type === "contradiction" ||
					record.type === "result" ||
					(record.type === "requested" &&
						(record.operation === "remove" || record.operation === "inspect")),
				"sealed scope only permits accounted inspection/removal and late-conflict evidence",
			);
		switch (record.type) {
			case "opened":
				requireState(!scope && index === 0, "duplicate scope genesis");
				scope = record.scope;
				break;
			case "producer-opened":
				requireState(
					!fenced && !producers.has(record.producerId),
					"fenced or duplicate producer",
				);
				producers.set(record.producerId, {
					kind: record.kind,
					bound: false,
					ordinal: 0,
					final: false,
					localFenced: false,
					closed: false,
				});
				break;
			case "producer-bound": {
				const p = producer(record.producerId);
				requireState(
					!fenced && !p.localFenced && !p.closed && !p.bound,
					"producer binding is closed or repeated",
				);
				p.bound = true;
				break;
			}
			case "requested": {
				const p = producer(record.producerId);
				requireState(
					!requests.has(record.effectId),
					"effect identifier already consumed",
				);
				const cleanup =
					record.operation === "stop" ||
					record.operation === "inspect" ||
					record.operation === "remove";
				requireState(
					cleanup || (!fenced && !p.localFenced && !p.closed),
					"new effect after fencing/producer close",
				);
				requireState(
					record.operation !== "remove" || (sealed && complete()),
					"removal requires sealed complete bookkeeping plus independent host authorization",
				);
				requireState(
					record.operation !== "release" || p.bound,
					"release before physical/channel binding",
				);
				requests.set(record.effectId, {
					producerId: record.producerId,
					seq: entry.seq,
					operation: record.operation,
					outcome: "pending",
					requestDigest: record.requestDigest,
					consentBound: false,
				});
				break;
			}
			case "consent-bound": {
				const request = requests.get(record.effectId);
				requireState(request !== undefined && !fenced &&
					!producer(request.producerId).localFenced &&
					!producer(request.producerId).closed &&
					request.outcome === "pending" && !request.consentBound &&
					request.requestDigest === record.requestDigest && !grants.has(record.grantId),
					"consent binding requires its unique pending request and live producer");
				request.consentBound = true;
				grants.add(record.grantId);
				break;
			}
			case "result": {
				const r = requests.get(record.effectId);
				requireState(
					r && r.seq === record.requestSeq && r.outcome === "pending",
					"unknown, duplicate or misbound result",
				);
				r.outcome = record.outcome;
				break;
			}
			case "callback": {
				const p = producers.get(record.producerId);
				if (
					!p ||
					!p.bound ||
					p.localFenced ||
					p.closed ||
					p.final ||
					sealed ||
					record.ordinal !== p.ordinal + 1
				) {
					conflicts.push(`callback:${entry.seq}`);
					fenced = true;
				}
				if (p) {
					p.ordinal = Math.max(p.ordinal, record.ordinal);
					p.final ||= record.kind === "final";
				}
				break;
			}
			case "fenced":
				fenced = true;
				break;
			case "producer-fenced": {
				const p = producer(record.producerId);
				requireState(!p.localFenced && !p.closed && !sealed,
					"producer fence is repeated or closed");
				p.localFenced = true;
				break;
			}
			case "producer-closed": {
				const p = producer(record.producerId);
				requireState((fenced || p.localFenced) && !p.closed,
					"close requires fence and cannot repeat");
				if (record.outcome === "closed")
					requireState([...requests.values()].every((r) =>
						r.producerId !== record.producerId ||
						r.outcome === "acknowledged" || r.outcome === "rejected"),
						"closed producer has unresolved effects");
				if (record.outcome === "unknown")
					conflicts.push(`unknown-producer:${record.producerId}`);
				if (record.outcome === "never-started") {
					const own = [...requests.values()].filter(
						(r) => r.producerId === record.producerId,
					);
					requireState(
						!p.bound && p.ordinal === 0 && own.every((r) => r.outcome === "rejected"),
						"never-started contradicts observed activity",
					);
				} else if (
					(p.kind === "sdk" || p.kind === "verifier") &&
					(!p.bound || !p.final)
				) {
					conflicts.push(`missing-final:${record.producerId}`);
				}
				p.closed = record.outcome !== "unknown";
				break;
			}
			case "contradiction":
				conflicts.push(`${record.code}:${entry.seq}`);
				fenced = true;
				break;
			case "sealed":
				requireState(complete(), "unresolved controls cannot be sealed");
				requireState(
					record.previousHead.seq === index &&
						record.previousHead.hash === priorHash,
					"seal names stale/incomplete head",
				);
				sealed = true;
				break;
		}
		priorHash = entry.hash;
	}
	requireState(scope, "empty effect scope");
	requireState(
		snapshot.head.seq === snapshot.records.length &&
			snapshot.head.hash === priorHash,
		"head omits or contradicts history",
	);
	return frozen({
		scope,
		head: { ...snapshot.head },
		fenced,
		sealed: sealed && complete(),
		pendingEffects: [...requests]
			.filter(([, r]) => r.outcome === "pending")
			.map(([key]) => key)
			.sort(),
		unknownEffects: [...requests]
			.filter(([, r]) => r.outcome === "unknown")
			.map(([key]) => key)
			.sort(),
		openProducers: [...producers]
			.filter(([, p]) => !p.closed)
			.map(([key]) => key)
			.sort(),
		conflicts,
		bookkeepingComplete: complete(),
		goalDrain: "not-established",
	});
}

/**
 * Bookkeeping only: this class does not own a dispatcher and cannot enforce
 * ordering on arbitrary caller effects. The still-required concrete private host
 * must structurally append requested before entering its non-exported transport;
 * calling record() is not that integration, an execution grant or provenance.
 * An ambiguous append must never be retried or used as permission to dispatch.
 */
export class GoalHostEffects {
	readonly #journal: GoalHostJournal;
	#queue: Promise<void> = Promise.resolve();
	#poisoned = false;
	#seenHead = { seq: 0, hash: "0".repeat(64) };
	private constructor(journal: GoalHostJournal, key: symbol) {
		if (key !== constructionKey)
			throw new Error("Goal effect ledger construction is private");
		this.#journal = journal;
	}
	static async create(
		root: string,
		scope: GoalHostEffectScope,
	): Promise<GoalHostEffects> {
		const record = parseGoalHostEffectRecord({ type: "opened", scope });
		const journal = await GoalHostJournal.create(root);
		const host = new GoalHostEffects(journal, constructionKey);
		await host.#append(record);
		return host;
	}
	/** Read-only recovery inspection. No writer/owner/dispatcher is activated. */
	static async open(
		root: string,
	): Promise<{ inspect(): Promise<GoalHostEffectCensus> }> {
		const reader = await GoalHostJournal.open(root);
		inspectGoalHostEffects(await reader.load());
		return Object.freeze({
			inspect: async () => inspectGoalHostEffects(await reader.load()),
		});
	}
	async inspect(): Promise<GoalHostEffectCensus> {
		await this.#queue;
		return inspectGoalHostEffects(await this.#readPinned());
	}
	record(input: GoalHostEffectRecord): Promise<GoalHostEffectCensus> {
		const captured = parseGoalHostEffectRecord(input);
		const action = this.#queue.then(() => this.#append(captured));
		this.#queue = action.then(
			() => {},
			() => {},
		);
		return action;
	}
	async #readPinned(): Promise<GoalHostJournalSnapshot> {
		requireState(
			!this.#poisoned,
			"journal uncertainty requires independent recovery",
		);
		try {
			const snapshot = await this.#journal.load();
			requireState(
				snapshot.head.seq >= this.#seenHead.seq,
				"observed journal head rolled back",
			);
			if (this.#seenHead.seq > 0)
				requireState(
					snapshot.records[this.#seenHead.seq - 1]?.hash === this.#seenHead.hash,
					"observed journal history forked",
				);
			// Pin complete newer history BEFORE event eligibility/authorization checks.
			this.#seenHead = { ...snapshot.head };
			return snapshot;
		} catch (cause) {
			this.#poisoned = true;
			throw new Error(
				"Goal host journal observation uncertain; recovery required",
				{ cause },
			);
		}
	}
	async #append(record: GoalHostEffectRecord): Promise<GoalHostEffectCensus> {
		const before = await this.#readPinned();
		const payload = goalInput(record);
		requireState(
			payload !== null && typeof payload === "object" && !Array.isArray(payload),
			"record is not an object",
		);
		const unsigned = {
			version: 1 as const,
			seq: before.head.seq + 1,
			previousHash: before.head.hash,
			payload,
		};
		const entry = { ...unsigned, hash: goalHash(unsigned) };
		// Reject unsafe intent BEFORE durable publication and before caller dispatch.
		inspectGoalHostEffects({
			records: [...before.records, entry],
			head: { seq: entry.seq, hash: entry.hash },
		});
		try {
			const committed = await this.#journal.append(before.head, unsigned.payload);
			this.#seenHead = { ...committed.head };
			return inspectGoalHostEffects(committed);
		} catch (cause) {
			this.#poisoned = true;
			throw new Error("Goal host effect append uncertain; no dispatch or retry", {
				cause,
			});
		}
	}
}
