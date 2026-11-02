import {
	arr,
	digest,
	frozen,
	goalHash,
	GOAL_MAX_EVENTS,
	id,
	nat,
	obj,
	one,
	parse,
	unique,
	type Check,
} from "./goal-json.js";
import type {
	GoalAcceptedEvent,
	GoalProbeEpisodeBinding,
	GoalProbeRecord,
} from "./goal-types.js";

/** Design proposal only, unmeasured. NOT engine defaults or a running scheduler. */
export const GOAL_PROBE_PROPOSAL_POLICY = frozen({
	schemaVersion: 1,
	id: "goal-p5-unmeasured-probe-6",
	maxProbes: 6,
	delaysMs: [30_000, 120_000, 600_000, 600_000, 600_000, 600_000],
	deadlineMs: 5_000,
	maxOutstanding: 1,
	maxEpisodeWindowMs: 2_580_000,
});

const bindingCheck = obj({
	contractHash: digest,
	profileHash: digest,
	authorityHash: digest,
	revocationGeneration: nat,
	registryHash: digest,
	blockerId: id,
	blockerEventId: id,
	instanceDigest: digest,
	family: digest,
	predicateId: id,
});
const recordCheck: Check = (value) => {
	const base = { schemaVersion: one(1) };
	switch ((value as GoalProbeRecord)?.type) {
		case "open":
			return obj({ ...base, type: one("open"), episode: bindingCheck })(value);
		case "claim":
			return obj({
				...base,
				type: one("claim"),
				episodeHash: digest,
				probeId: id,
				ownerHash: digest,
				controlHash: digest,
			})(value);
		case "result":
			return obj({
				...base,
				type: one("result"),
				episodeHash: digest,
				probeId: id,
				claimEventId: id,
				outcome: one("true", "false", "error"),
				evidenceRefs: arr(digest, 1),
			})(value);
		case "drain":
			return obj({
				...base,
				type: one("drain"),
				episodeHash: digest,
				probeId: id,
				claimEventId: id,
				resultEventId: id,
				evidenceRefs: arr(digest, 1),
			})(value);
		case "abandoned-drain":
			return obj({
				...base,
				type: one("abandoned-drain"),
				episodeHash: digest,
				probeId: id,
				claimEventId: id,
				reasonDigest: digest,
				evidenceRefs: arr(digest, 1),
			})(value);
		case "disarm":
			return obj({
				...base,
				type: one("disarm"),
				episodeHash: digest,
				reason: one("pause", "cancel", "revoke", "manual"),
			})(value);
		default:
			throw new Error("Goal unknown probe record");
	}
};

/** Strict data validation only. A typed record is still not actor, adapter, or
 * effect-census provenance; that boundary remains host-owned and unavailable. */
export function parseGoalProbeRecord(input: unknown): GoalProbeRecord {
	const record = parse<GoalProbeRecord>(input, recordCheck);
	if (
		record.type === "result" ||
		record.type === "drain" ||
		record.type === "abandoned-drain"
	)
		unique(record.evidenceRefs);
	return record;
}

export interface GoalProbeAttempt {
	probeId: string;
	claimEventId: string;
	startedAt: number;
	deadlineAt: number;
	ownerHash: string;
	controlHash: string;
	outcome: "true" | "false" | "error" | null;
	resultEventId: string | null;
	resultAt: number | null;
	drained: boolean;
}
export interface GoalProbeEpisode {
	binding: GoalProbeEpisodeBinding;
	episodeHash: string;
	openedAt: number;
	disarmed: boolean;
	attempts: GoalProbeAttempt[];
	nextProbeAt: number | null;
}
export interface GoalProbeReplay {
	episodes: GoalProbeEpisode[];
	pendingEffects: string[];
}
export interface GoalProbeFold {
	accept(event: GoalAcceptedEvent): void;
	hasProbeId(probeId: string): boolean;
	pendingEffects(): string[];
	replay(): GoalProbeReplay;
}

function addTime(at: number, delay: number): number {
	const sum = at + delay;
	nat(sum);
	return sum;
}
function cloneEpisode(episode: GoalProbeEpisode): GoalProbeEpisode {
	return {
		...episode,
		binding: { ...episode.binding },
		attempts: episode.attempts.map((attempt) => ({ ...attempt })),
	};
}

/** Independent bounded state-machine fold. It performs no trust admission, IO,
 * clocks, timers, execution, or callbacks. Callers must separately require
 * host-accepted events. A claim consumes its episode slot immediately; only a
 * matching result lineage plus a complete known drained probe census can drain. */
export function createGoalProbeFold(): GoalProbeFold {
	const episodes = new Map<string, GoalProbeEpisode>();
	const probeIds = new Set<string>();
	const eventIds = new Set<string>();
	let at = 0;
	let count = 0;

	const fold = {
		accept(event: GoalAcceptedEvent): void {
			if (++count > GOAL_MAX_EVENTS) throw new Error("Goal probe journal bound");
			if (eventIds.has(event.data.id))
				throw new Error("Goal duplicate probe journal event");
			eventIds.add(event.data.id);
			if (event.observations.at < at)
				throw new Error("Goal probe clock regressed");
			at = event.observations.at;
			if (
				(event.data.type === "control" && event.data.action !== "resume") ||
				event.data.type === "revision"
			) {
				for (const episode of episodes.values()) episode.disarmed = true;
			}
			if (event.data.type !== "probe") return;
			const record = parseGoalProbeRecord(event.data.record);
			if (record.type === "open") {
				const episodeHash = goalHash(record.episode);
				if (
					record.episode.contractHash !== event.data.contractHash ||
					episodes.has(episodeHash) ||
					[...episodes.values()].some(
						(episode) =>
							episode.binding.blockerEventId === record.episode.blockerEventId ||
							(episode.binding.family === record.episode.family &&
								episode.binding.instanceDigest === record.episode.instanceDigest),
					)
				)
					throw new Error("Goal duplicate/mismatched probe episode");
				episodes.set(episodeHash, {
					binding: record.episode,
					episodeHash,
					openedAt: at,
					disarmed: false,
					attempts: [],
					nextProbeAt: addTime(at, GOAL_PROBE_PROPOSAL_POLICY.delaysMs[0]),
				});
				return;
			}
			const episode = episodes.get(record.episodeHash);
			if (!episode) throw new Error("Goal unknown probe episode");
			if (record.type === "disarm") {
				episode.disarmed = true;
				return;
			}
			const last = episode.attempts.at(-1);
			if (record.type === "claim") {
				if (
					episode.disarmed ||
					episode.binding.contractHash !== event.data.contractHash ||
					episode.attempts.length >= GOAL_PROBE_PROPOSAL_POLICY.maxProbes ||
					(last && (!last.drained || last.outcome === "true")) ||
					episode.nextProbeAt === null ||
					at < episode.nextProbeAt ||
					addTime(at, GOAL_PROBE_PROPOSAL_POLICY.deadlineMs) >
						addTime(
							episode.openedAt,
							GOAL_PROBE_PROPOSAL_POLICY.maxEpisodeWindowMs,
						) ||
					probeIds.has(record.probeId)
				)
					throw new Error(
						"Goal probe claim early/exhausted/outstanding/disarmed/reused",
					);
				if (
					[...episodes.values()].some((candidate) =>
						candidate.attempts.some((attempt) => !attempt.drained),
					)
				)
					throw new Error("Goal observer already outstanding");
				probeIds.add(record.probeId);
				episode.attempts.push({
					probeId: record.probeId,
					claimEventId: event.data.id,
					startedAt: at,
					deadlineAt: addTime(at, GOAL_PROBE_PROPOSAL_POLICY.deadlineMs),
					ownerHash: record.ownerHash,
					controlHash: record.controlHash,
					outcome: null,
					resultEventId: null,
					resultAt: null,
					drained: false,
				});
				episode.nextProbeAt = null;
				return;
			}
			if (
				!last ||
				last.probeId !== record.probeId ||
				last.claimEventId !== record.claimEventId
			)
				throw new Error("Goal stale probe callback lineage");
			if (record.type === "result") {
				if (
					last.outcome !== null ||
					last.drained ||
					(record.outcome !== "error" && (episode.disarmed || at > last.deadlineAt))
				)
					throw new Error("Goal duplicate/late/disarmed probe result");
				last.outcome = record.outcome;
				last.resultEventId = event.data.id;
				last.resultAt = at;
				return;
			}
			if (last.drained)
				throw new Error("Goal duplicate probe drain requires result lineage");
			if (record.type === "drain") {
				if (last.outcome === null)
					throw new Error("Goal drain requires result and exact census evidence");
				if (last.resultEventId !== record.resultEventId)
					throw new Error("Goal stale probe drain lineage");
			} else {
				if (last.outcome !== null || last.resultEventId !== null)
					throw new Error("Goal abandoned drain requires missing result");
				last.outcome = "error";
				last.resultEventId = event.data.id;
				last.resultAt = at;
			}
			const census = event.observations.effects.find(
				(effect) => effect.id === record.probeId,
			);
			if (
				!event.observations.effectsKnown ||
				!census ||
				census.kind !== "probe" ||
				census.state !== "drained"
			)
				throw new Error("Goal drain requires explicit known drained probe census");
			last.drained = true;
			episode.nextProbeAt =
				episode.attempts.length < GOAL_PROBE_PROPOSAL_POLICY.maxProbes &&
				last.outcome !== "true"
					? addTime(at, GOAL_PROBE_PROPOSAL_POLICY.delaysMs[episode.attempts.length])
					: null;
		},
		hasProbeId(probeId: string): boolean {
			return probeIds.has(probeId);
		},
		pendingEffects(): string[] {
			return [...episodes.values()]
				.flatMap((episode) =>
					episode.attempts.flatMap((attempt) =>
						attempt.drained ? [] : [attempt.probeId],
					),
				)
				.sort((a, b) => a.localeCompare(b));
		},
		replay(): GoalProbeReplay {
			return frozen({
				episodes: [...episodes.values()].map(cloneEpisode),
				pendingEffects: fold.pendingEffects(),
			});
		},
	};
	return Object.freeze(fold);
}

export function replayGoalProbeJournal(
	events: readonly GoalAcceptedEvent[],
): GoalProbeReplay {
	const fold = createGoalProbeFold();
	for (const event of events) fold.accept(event);
	return fold.replay();
}
