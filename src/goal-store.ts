import { constants } from "node:fs";
import {
	link,
	lstat,
	mkdir,
	open,
	readdir,
	rename,
	rmdir,
	unlink,
} from "node:fs/promises";
import {
	createHash,
	createPublicKey,
	KeyObject,
	randomUUID,
	verify,
} from "node:crypto";
import { dirname, join, resolve } from "node:path";
import {
	assertAcceptedGoalContract,
	assertAcceptedGoalEvent,
	assertAcceptedGoalObservations,
	createGoalHostIngress,
	goalHash,
	goalJson,
	parseGoalContract,
	parseGoalEvent,
	parseGoalObservations,
} from "./goal-contract.js";
import { reduceGoal } from "./goal-decision.js";
import {
	bool,
	digest,
	GOAL_MAX_BYTES,
	GOAL_MAX_EVENTS,
	id,
	nat,
	nullable,
	obj,
	one,
	parse,
	str,
} from "./goal-json.js";
import type {
	GoalAcceptedEvent,
	GoalAcceptedObservations,
	GoalContract,
	GoalDecision,
	GoalObservations,
} from "./goal-types.js";
import { GoalHostEffects } from "./goal-host-effects.js";
import {
	assertGoalStoreOpenForWrite,
	withGoalHostWriteLock,
} from "./goal-host-write-lock.js";

interface JournalRecord {
	schemaVersion: 1;
	seq: number;
	previousHash: string;
	hash: string;
	ownerId: string;
	epoch: number;
	kind: "genesis" | "event" | "handoff" | "lifecycle-custody";
	payload: unknown;
}
interface Genesis {
	contractHash: string;
	observations: GoalObservations;
}
interface Handoff {
	nextOwnerId: string;
	observations: GoalObservations;
}
interface LifecycleCustodyIssuanceData {
	schemaVersion: 1;
	issuanceId: string;
	ownerId: string;
	incarnation: string;
	creationReceiptHash: string;
	previousIssuanceHash: string | null;
	authorityDigest: string;
	takeover: boolean;
}
export interface GoalLifecycleCustodyIssuance
	extends LifecycleCustodyIssuanceData {
	readonly generation: number;
	readonly receiptHash: string;
}
export interface GoalStoreOwner {
	readonly ownerId: string;
	readonly epoch: number;
}
export interface GoalStoreSnapshot {
	status: "ok";
	/** Genesis is the mandatory starting point for replaying revision events. */
	contract: GoalContract;
	currentContract: GoalContract;
	events: GoalAcceptedEvent[];
	decision: GoalDecision;
	seq: number;
	hash: string;
	ownerId: string;
	epoch: number;
	creationReceiptHash: string;
	lifecycleCustodyIssuances: GoalLifecycleCustodyIssuance[];
	evidence: string[];
}

export interface GoalAdmittedChildReferences {
	runIds: string[];
	/** A fixture child-journal entry could not be safely resolved. */
	uncertain: boolean;
}
export type GoalStoreLoad =
	| GoalStoreSnapshot
	| {
			status: "missing" | "corrupt" | "inaccessible" | "observation-rejected";
			diagnostic: string;
	  };
export type GoalStoreFaultPoint =
	| "temp-written"
	| "file-synced"
	| "published"
	| "directory-synced"
	| "before-projection";
export interface GoalStoreOptions {
	/** HOST TEST ONLY: synchronous crash/barrier injection, never passed to untrusted tools. */
	fault?: (point: GoalStoreFaultPoint, path: string) => void | Promise<void>;
}
const lifecycleCustodyTakeoverBrand: unique symbol = Symbol(
	"goal-lifecycle-custody-takeover-authorization",
);
export interface GoalLifecycleCustodyTakeoverAuthorization {
	readonly [lifecycleCustodyTakeoverBrand]: never;
}
const lifecycleTakeoverEvidenceBrand: unique symbol = Symbol(
	"goal-test-only-lifecycle-takeover-evidence",
);
export interface GoalTestOnlyLifecycleTakeoverEvidence {
	readonly [lifecycleTakeoverEvidenceBrand]: never;
}
const supervisorLifecycleTakeoverEvidenceBrand: unique symbol = Symbol(
	"goal-supervisor-lifecycle-takeover-evidence",
);
export interface GoalSupervisorLifecycleTakeoverEvidence {
	readonly [supervisorLifecycleTakeoverEvidenceBrand]: never;
}
export type GoalLifecycleTakeoverEvidence =
	| GoalTestOnlyLifecycleTakeoverEvidence
	| GoalSupervisorLifecycleTakeoverEvidence;
export interface GoalTestOnlyLifecycleTakeoverEvidencePayload {
	readonly schemaVersion: 1;
	readonly environment: "TEST_ONLY";
	readonly supervisorId: string;
	readonly root: string;
	readonly current: {
		readonly ownerId: string;
		readonly epoch: number;
		readonly seq: number;
		readonly hash: string;
	};
	readonly previousCustody: {
		readonly issuanceId: string;
		readonly receiptHash: string;
		readonly ownerId: string;
		readonly generation: number;
		readonly incarnation: string;
	};
	readonly witnessedProcessIncarnation: string;
}
export interface GoalSupervisorLifecycleTakeoverEvidencePayload {
	readonly schemaVersion: 1;
	readonly environment: "PRODUCTION_SUPERVISOR";
	readonly mode: "PRODUCTION" | "TEST_ONLY";
	readonly supervisorProvision: {
		readonly policyDigest: string;
		readonly supervisorChannelBindingSha256: string;
		readonly ledgerIdentitySha256: string;
		readonly serviceIdentitySha256: string;
	};
	readonly requestDigest: string;
	readonly ledgerOutcome: "OBSERVED";
	readonly ledgerReceiptHash: string;
	readonly request: {
		readonly schema: "goal-production-lifecycle-takeover-observation/v1";
		readonly takeoverNonce: string;
		readonly root: string;
		readonly creationReceiptHash: string;
		readonly current: {
			readonly ownerId: string;
			readonly epoch: number;
			readonly seq: number;
			readonly hash: string;
		};
		readonly previousCustody: {
			readonly issuanceId: string;
			readonly receiptHash: string;
			readonly ownerId: string;
			readonly generation: number;
			readonly incarnation: string;
		};
		readonly workerDrain: {
			readonly disposition: "drained";
			readonly processIncarnation: string;
			readonly drainReceiptHash: string;
		};
	};
}
export interface GoalTestOnlyOldOwnerGoneObservation {
	readonly schemaVersion: 1;
	readonly environment: "TEST_ONLY";
	readonly supervisorId: string;
	readonly root: string;
	readonly ownerId: string;
	readonly epoch: number;
	readonly issuanceId: string;
	readonly receiptHash: string;
	readonly processIncarnation: string;
	readonly disposition: "gone";
}
const oldOwnerGoneWitnessBrand: unique symbol = Symbol(
	"goal-test-only-old-owner-gone-witness",
);
export interface GoalTestOnlyOldOwnerGoneWitness {
	readonly [oldOwnerGoneWitnessBrand]: never;
}
export interface GoalTestOnlyLifecycleTakeoverEvidenceSource {
	captureOldOwnerGone(input: {
		readonly store: GoalStore;
		readonly owner: GoalStoreOwner;
		readonly observations: GoalAcceptedObservations;
		readonly observation: GoalTestOnlyOldOwnerGoneObservation;
		readonly signature: string;
	}): Promise<GoalTestOnlyOldOwnerGoneWitness>;
	capture(input: {
		readonly witness: GoalTestOnlyOldOwnerGoneWitness;
		readonly payload: GoalTestOnlyLifecycleTakeoverEvidencePayload;
		readonly signature: string;
	}): GoalTestOnlyLifecycleTakeoverEvidence;
}
interface CapturedLifecycleTakeoverEvidence {
	readonly payload: GoalTestOnlyLifecycleTakeoverEvidencePayload;
	readonly signature: string;
	readonly witness: CapturedOldOwnerGoneWitness;
	readonly digest: string;
}
interface CapturedOldOwnerGoneWitness {
	readonly observation: GoalTestOnlyOldOwnerGoneObservation;
	readonly signature: string;
	readonly supervisorId: string;
	readonly keyFingerprint: string;
}
const lifecycleTakeoverEvidence = new WeakMap<
	object,
	CapturedLifecycleTakeoverEvidence
>();
interface CapturedSupervisorLifecycleTakeoverEvidence {
	readonly payload: GoalSupervisorLifecycleTakeoverEvidencePayload;
	readonly digest: string;
}
const supervisorLifecycleTakeoverEvidence = new WeakMap<
	object,
	CapturedSupervisorLifecycleTakeoverEvidence
>();
const oldOwnerGoneWitnesses = new WeakMap<
	object,
	CapturedOldOwnerGoneWitness
>();

function takeoverEvidencePayload(
	value: unknown,
): GoalTestOnlyLifecycleTakeoverEvidencePayload {
	try {
		return parse<GoalTestOnlyLifecycleTakeoverEvidencePayload>(
			value,
			obj({
				schemaVersion: one(1),
				environment: one("TEST_ONLY"),
				supervisorId: str,
				root: str,
				current: obj({ ownerId: str, epoch: nat, seq: nat, hash: digest }),
				previousCustody: obj({
					issuanceId: str,
					receiptHash: digest,
					ownerId: str,
					generation: nat,
					incarnation: str,
				}),
				witnessedProcessIncarnation: str,
			}),
		);
	} catch (cause) {
		throw new Error("Goal TEST_ONLY takeover evidence payload invalid", { cause });
	}
}

function oldOwnerGoneObservation(
	value: unknown,
): GoalTestOnlyOldOwnerGoneObservation {
	try {
		return parse<GoalTestOnlyOldOwnerGoneObservation>(
			value,
			obj({
				schemaVersion: one(1),
				environment: one("TEST_ONLY"),
				supervisorId: str,
				root: str,
				ownerId: str,
				epoch: nat,
				issuanceId: str,
				receiptHash: digest,
				processIncarnation: str,
				disposition: one("gone"),
			}),
		);
	} catch (cause) {
		throw new Error("Goal TEST_ONLY old-owner observation invalid", { cause });
	}
}

function supervisorLifecycleTakeoverPayload(
	value: unknown,
): GoalSupervisorLifecycleTakeoverEvidencePayload {
	try {
		return parse<GoalSupervisorLifecycleTakeoverEvidencePayload>(
			value,
			obj({
				schemaVersion: one(1),
				environment: one("PRODUCTION_SUPERVISOR"),
				mode: one("PRODUCTION", "TEST_ONLY"),
				supervisorProvision: obj({
					policyDigest: digest,
					supervisorChannelBindingSha256: digest,
					ledgerIdentitySha256: digest,
					serviceIdentitySha256: digest,
				}),
				requestDigest: digest,
				ledgerOutcome: one("OBSERVED"),
				ledgerReceiptHash: digest,
				request: obj({
					schema: one("goal-production-lifecycle-takeover-observation/v1"),
					takeoverNonce: str,
					root: str,
					creationReceiptHash: digest,
					current: obj({ ownerId: str, epoch: nat, seq: nat, hash: digest }),
					previousCustody: obj({
						issuanceId: str,
						receiptHash: digest,
						ownerId: str,
						generation: nat,
						incarnation: str,
					}),
					workerDrain: obj({
						disposition: one("drained"),
						processIncarnation: str,
						drainReceiptHash: digest,
					}),
				}),
			}),
		);
	} catch (cause) {
		throw new Error("Goal supervisor takeover evidence payload invalid", { cause });
	}
}

export function captureGoalSupervisorLifecycleTakeoverEvidenceFromProvision(
	value: unknown,
): GoalSupervisorLifecycleTakeoverEvidence {
	const input = captureArgument(
		value,
		["payload"],
		"Goal supervisor takeover evidence capture arguments invalid",
	);
	const payload = supervisorLifecycleTakeoverPayload(input.payload);
	if (
		payload.requestDigest !==
			goalHash({
				schema: "goal-production-lifecycle-takeover-request-digest/v1",
				supervisorProvision: payload.supervisorProvision,
				request: payload.request,
			}) ||
		payload.ledgerReceiptHash !==
			goalHash({
				schema: "goal-production-lifecycle-takeover-ledger-receipt/v1",
				requestDigest: payload.requestDigest,
				outcome: payload.ledgerOutcome,
			})
	)
		throw new Error("Goal supervisor takeover evidence ledger binding invalid");
	const evidence = Object.freeze(
		Object.create(null),
	) as GoalSupervisorLifecycleTakeoverEvidence;
	supervisorLifecycleTakeoverEvidence.set(evidence, {
		payload,
		digest: goalHash({
			domain: "goal-supervisor-lifecycle-takeover-authority/v1",
			payload,
		}),
	});
	return evidence;
}

function captureArgument(
	value: unknown,
	keys: readonly string[],
	error: string,
): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		(Object.getPrototypeOf(value) !== Object.prototype &&
			Object.getPrototypeOf(value) !== null)
	)
		throw new Error(error);
	const descriptors = Object.getOwnPropertyDescriptors(value);
	if (
		Reflect.ownKeys(value).some(key => typeof key !== "string") ||
		Object.keys(descriptors).length !== keys.length ||
		keys.some(key => !Object.hasOwn(descriptors, key)) ||
		Object.values(descriptors).some(
			descriptor => !("value" in descriptor) || !descriptor.enumerable,
		)
	)
		throw new Error(error);
	return Object.freeze(
		Object.fromEntries(keys.map(key => [key, descriptors[key].value])),
	);
}

function ed25519Signature(value: unknown, error: string): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value))
		throw new Error(error);
	const signature = Buffer.from(value, "base64url");
	if (signature.length !== 64 || signature.toString("base64url") !== value)
		throw new Error(error);
	return value;
}

/** TEST ONLY. The verification key is captured when this trusted source is
 * provisioned; grant requests never select a key or assert old-owner death. */
export function createGoalTestOnlyLifecycleTakeoverEvidenceSource(input: {
	readonly trustAnchor: KeyObject | string | Buffer;
	readonly supervisorId: string;
}): GoalTestOnlyLifecycleTakeoverEvidenceSource {
	const anchor = input.trustAnchor instanceof KeyObject && input.trustAnchor.type === "public"
		? input.trustAnchor
		: createPublicKey(input.trustAnchor);
	const supervisorId = input.supervisorId;
	if (anchor.asymmetricKeyType !== "ed25519")
		throw new Error("Goal TEST_ONLY takeover trust anchor must be Ed25519");
	if (typeof supervisorId !== "string" || supervisorId.length === 0)
		throw new Error("Goal TEST_ONLY supervisor identity invalid");
	const keyFingerprint = createHash("sha256")
		.update(anchor.export({ format: "der", type: "spki" }))
		.digest("hex");
	return Object.freeze({
		async captureOldOwnerGone(value: Parameters<GoalTestOnlyLifecycleTakeoverEvidenceSource["captureOldOwnerGone"]>[0]) {
			const input = captureArgument(
				value,
				["store", "owner", "observations", "observation", "signature"],
				"Goal TEST_ONLY old-owner capture arguments invalid",
			);
			if (!(input.store instanceof GoalStore))
				throw new Error("Goal TEST_ONLY old-owner store invalid");
			const store = input.store;
			const owner = input.owner as GoalStoreOwner;
			const ownerCapability = ownerCapabilities.get(owner);
			if (!ownerCapability || ownerCapability.root !== store.root ||
				ownerCapability.ownerId !== owner.ownerId || ownerCapability.epoch !== owner.epoch)
				throw new Error("Goal TEST_ONLY old-owner capability invalid");
			const observations = input.observations as GoalAcceptedObservations;
			const observation = oldOwnerGoneObservation(input.observation);
			const signature = ed25519Signature(
				input.signature,
				"Goal TEST_ONLY old-owner observation signature invalid",
			);
			if (
				observation.supervisorId !== supervisorId ||
				!verify(
					null,
					Buffer.from(goalJson(observation)),
					anchor,
					Buffer.from(signature, "base64url"),
				)
			)
				throw new Error("Goal TEST_ONLY old-owner observation signature invalid");
			assertAcceptedGoalObservations(observations);
			const snapshot = await store.load(observations);
			if (snapshot.status !== "ok" || snapshot.evidence.length ||
				snapshot.decision.pendingEffects.length ||
				snapshot.epoch !== owner.epoch + 1 || snapshot.ownerId === owner.ownerId)
				throw new Error("Goal TEST_ONLY old-owner observation requires drained successor handoff");
			const custody = snapshot.lifecycleCustodyIssuances.at(-1);
			if (
				!custody ||
				observation.root !== store.root ||
				observation.ownerId !== owner.ownerId ||
				observation.epoch !== owner.epoch ||
				observation.issuanceId !== custody.issuanceId ||
				observation.receiptHash !== custody.receiptHash ||
				custody.ownerId !== owner.ownerId ||
				observation.processIncarnation !== custody.incarnation
			)
				throw new Error("Goal TEST_ONLY old-owner observation is stale");
			const witness = Object.freeze(
				Object.create(null),
			) as GoalTestOnlyOldOwnerGoneWitness;
			oldOwnerGoneWitnesses.set(
				witness,
				Object.freeze({
					observation,
					signature,
					supervisorId,
					keyFingerprint,
				}),
			);
			return witness;
		},
		capture(value: Parameters<GoalTestOnlyLifecycleTakeoverEvidenceSource["capture"]>[0]) {
			const input = captureArgument(
				value,
				["witness", "payload", "signature"],
				"Goal TEST_ONLY takeover capture arguments invalid",
			);
			const payload = takeoverEvidencePayload(input.payload);
			const signature = ed25519Signature(
				input.signature,
				"Goal TEST_ONLY takeover evidence signature invalid",
			);
			const witness = oldOwnerGoneWitnesses.get(input.witness as object);
			if (
				!witness ||
				payload.supervisorId !== supervisorId ||
				witness.supervisorId !== supervisorId ||
				witness.keyFingerprint !== keyFingerprint ||
				payload.root !== witness.observation.root ||
				payload.previousCustody.ownerId !== witness.observation.ownerId ||
				payload.previousCustody.generation !== witness.observation.epoch ||
				payload.previousCustody.issuanceId !== witness.observation.issuanceId ||
				payload.previousCustody.receiptHash !== witness.observation.receiptHash ||
				payload.previousCustody.incarnation !== witness.observation.processIncarnation ||
				payload.witnessedProcessIncarnation !== witness.observation.processIncarnation ||
				!verify(
					null,
					Buffer.from(goalJson(payload)),
					anchor,
					Buffer.from(signature, "base64url"),
				)
			)
				throw new Error("Goal TEST_ONLY takeover evidence signature invalid");
			const evidence = Object.freeze(
				Object.create(null),
			) as GoalTestOnlyLifecycleTakeoverEvidence;
			lifecycleTakeoverEvidence.set(evidence, {
				payload,
				signature,
				witness,
				digest: goalHash({
					domain: "goal-test-only-lifecycle-takeover-authority/v1",
					supervisorId,
					keyFingerprint,
					oldOwnerGone: {
						observation: witness.observation,
						signature: witness.signature,
					},
					takeover: { payload, signature },
				}),
			});
			return evidence;
		},
	});
}
const lifecycleCustodyTakeovers = new WeakMap<
	object,
	{
		readonly root: string;
		readonly ownerId: string;
		readonly epoch: number;
		readonly head: { readonly seq: number; readonly hash: string };
		readonly authorityDigest: string;
	}
>();
const ZERO = "0".repeat(64);
const ownerCapabilities = new WeakMap<
	object,
	{ root: string; ownerId: string; epoch: number }
>();
const ownerActivities = new Map<string, Map<string, Set<object>>>();
const GOAL_CHILD_JOURNAL_PREFIX = "goal-p2-fixture-v1:";

/**
 * Read-only retention locator for children durably admitted by this Goal store.
 * Only exact reservation records identify a workflow run; opaque evidence
 * digests deliberately remain non-locating.
 */
export function goalAdmittedChildReferences(
	snapshot: GoalStoreSnapshot,
	storeRoot: string,
): GoalAdmittedChildReferences {
	const runIds = new Set<string>();
	let uncertain = false;
	for (const event of snapshot.events) {
		if (
			event.data.type !== "note" ||
			!event.data.text.startsWith(GOAL_CHILD_JOURNAL_PREFIX)
		)
			continue;
		try {
			const action = JSON.parse(
				event.data.text.slice(GOAL_CHILD_JOURNAL_PREFIX.length),
			) as unknown;
			if (
				!action ||
				typeof action !== "object"
			) {
				uncertain = true;
				continue;
			}
			const type = (action as { type?: unknown }).type;
			if (type !== "reserve") {
				if (
					(type === "claim" &&
						typeof (action as { bindingHash?: unknown }).bindingHash === "string" &&
						/^[a-f0-9]{64}$/.test(
							(action as { bindingHash: string }).bindingHash,
						)) ||
					(type === "fence" &&
						["pause", "cancel", "revoke"].includes(
							(action as { action?: unknown }).action as string,
						)) ||
					(type === "observe" &&
						typeof (action as { observation?: unknown }).observation === "object" &&
						action !== null &&
						typeof ((action as { observation: { bindingHash?: unknown } })
							.observation.bindingHash) === "string" &&
						/^[a-f0-9]{64}$/.test(
							(action as { observation: { bindingHash: string } }).observation
								.bindingHash,
						))
				) {
					continue;
				} else
					uncertain = true;
				continue;
			}
			const binding = (action as { binding?: unknown }).binding;
			if (
				!binding ||
				typeof binding !== "object" ||
				typeof (binding as { runId?: unknown }).runId !== "string" ||
				typeof (binding as { storeRoot?: unknown }).storeRoot !== "string" ||
				(binding as { runId: string }).runId.length === 0 ||
				(binding as { storeRoot: string }).storeRoot !== storeRoot
			) {
				uncertain = true;
				continue;
			}
			runIds.add((binding as { runId: string }).runId);
		} catch {
			uncertain = true;
		}
	}
	return { runIds: [...runIds], uncertain };
}
function code(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException)?.code;
}

/** Read-only terminal-retention census for source-owned host bookkeeping.
 * This proves neither kernel/process drain nor native endpoint authentication;
 * callers must retain an unavailable native drain as a refusal, not infer it
 * from sealed bookkeeping. */
export async function assertGoalHostEffectsDrained(
	hostRoot: string,
	storeRoot: string,
	snapshot: GoalStoreSnapshot,
): Promise<void> {
	if (resolve(hostRoot) !== resolve(storeRoot) &&
		resolve(storeRoot) !== join(resolve(hostRoot), "goal"))
		throw new Error("Goal terminal retention host/store layout mismatch");
	for (const ledger of ["workspace-effects", "verifier-effects", "apply-effects", "successor-verifier-effects"] as const) {
		const root = join(resolve(hostRoot), ledger);
		try {
			await directory(root);
		} catch (error) {
			if (code(error) === "ENOENT") continue;
			throw error;
		}
		const roots = ledger === "workspace-effects" || ledger === "successor-verifier-effects"
			? await Promise.all((await readdir(root, { withFileTypes: true })).map(async (entry) => {
				const path = join(root, entry.name);
				const info = await lstat(path);
				if (!entry.isDirectory() || !info.isDirectory() || info.isSymbolicLink() ||
					!/^[a-f0-9]{64}$/.test(entry.name))
					throw new Error("Goal workspace effect ledger path is invalid");
				return path;
			}))
			: [root];
		for (const effectRoot of roots) {
			const census = await GoalHostEffects.open(effectRoot).then((reader) => reader.inspect());
			if (
				census.scope.goalId !== snapshot.contract.goalId ||
				census.scope.ownerEpoch !== snapshot.epoch ||
				(ledger === "successor-verifier-effects" &&
					(census.scope.ownerEpoch < 1 || census.scope.ownerEpoch > snapshot.epoch)) ||
				!census.sealed || !census.bookkeepingComplete ||
				census.pendingEffects.length > 0 || census.unknownEffects.length > 0 ||
				census.openProducers.length > 0 || census.conflicts.length > 0
			)
				throw new Error("Goal terminal retention requires drained effects");
			// A GoalStore snapshot authenticates no host scope/session digest.
			// Do not qualify present effect bookkeeping as a native drain without
			// an exact source-owned binding supplied by the caller.
			throw new Error(
				"Goal terminal retention cannot bind host effect scope/session to current Goal identity",
			);
		}
	}
}
async function syncDirectory(path: string): Promise<void> {
	const fd = await open(path, constants.O_RDONLY);
	try {
		await fd.sync();
	} finally {
		await fd.close();
	}
}
async function directory(path: string): Promise<void> {
	const info = await lstat(path);
	if (!info.isDirectory() || info.isSymbolicLink())
		throw new Error(`Goal invalid directory: ${path}`);
}
async function readBounded(path: string): Promise<string> {
	const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = await fd.stat();
		if (!info.isFile() || info.size > GOAL_MAX_BYTES)
			throw new Error(`Goal invalid file/size: ${path}`);
		// Bound even a concurrently growing file. Host-owned storage is a prerequisite.
		const buffer = Buffer.alloc(GOAL_MAX_BYTES + 1);
		let size = 0;
		while (size < buffer.length) {
			const result = await fd.read(buffer, size, buffer.length - size, null);
			if (!result.bytesRead) break;
			size += result.bytesRead;
		}
		if (size > GOAL_MAX_BYTES) throw new Error("Goal growing file exceeds bound");
		return new TextDecoder("utf-8", { fatal: true }).decode(
			buffer.subarray(0, size),
		);
	} finally {
		await fd.close();
	}
}
function record(input: unknown): JournalRecord {
	const r = parse<JournalRecord>(
		input,
		obj({
			schemaVersion: one(1),
			seq: nat,
			previousHash: digest,
			hash: digest,
			ownerId: id,
			epoch: nat,
			kind: one("genesis", "event", "handoff", "lifecycle-custody"),
			payload: () => {},
		}),
	);
	const { hash, ...body } = r;
	if (hash !== goalHash(body)) throw new Error("Goal journal hash mismatch");
	return r;
}
function acceptedRecord(input: unknown): GoalAcceptedEvent {
	const value = parse<GoalAcceptedEvent>(
		input,
		obj({
			data: (v) => {
				parseGoalEvent(v);
			},
			actor: obj({ kind: one("host", "user", "verifier"), id }),
			observations: (v) => {
				parseGoalObservations(v);
			},
		}),
	);
	// HOST-ONLY replay of a validated, host-controlled journal. Hashes alone do not
	// authenticate this filesystem. A future protected backend must keep writers out.
	return createGoalHostIngress().event(
		value.data,
		value.actor,
		value.observations,
	);
}

/** Local single-writer mechanics, not a sandbox or Goal effect broker.
 * Filesystem must support fsync and exclusive hard-link publication. No unsafe stale
 * lock deletion, PID/expiry takeover, or automatic crash-lock recovery is provided.
 * The root and its ancestors must be controlled by the trusted host.
 */
export class GoalStore {
	readonly root: string;
	constructor(
		root: string,
		private readonly options: GoalStoreOptions = {},
	) {
		this.root = resolve(root);
	}
	/** HOST ONLY capability minting; not callable from JSON/tool ingress. */
	hostOwner(ownerId: string, epoch: number): GoalStoreOwner {
		id(ownerId);
		nat(epoch);
		const owner = Object.freeze({ ownerId, epoch });
		ownerCapabilities.set(owner, { root: this.root, ownerId, epoch });
		return owner;
	}
	private owner(owner: GoalStoreOwner): void {
		const accepted = ownerCapabilities.get(owner);
		if (
			!accepted ||
			accepted.root !== this.root ||
			accepted.ownerId !== owner.ownerId ||
			accepted.epoch !== owner.epoch
		)
			throw new Error("Goal store requires host owner capability");
	}
	/** Host-only in-memory drain guard. Durable effect evidence remains authoritative after restart. */
	bindOwnerActivity(owner: GoalStoreOwner): () => void {
		this.owner(owner);
		const key = `${owner.ownerId}\u0000${owner.epoch}`;
		const token = Object.freeze(Object.create(null) as object);
		const byOwner =
			ownerActivities.get(this.root) ?? new Map<string, Set<object>>();
		const activities = byOwner.get(key) ?? new Set<object>();
		activities.add(token);
		byOwner.set(key, activities);
		ownerActivities.set(this.root, byOwner);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			activities.delete(token);
			if (activities.size === 0) byOwner.delete(key);
			if (byOwner.size === 0) ownerActivities.delete(this.root);
		};
	}
	private ownerHasActivity(owner: GoalStoreOwner): boolean {
		return (
			(ownerActivities.get(this.root)?.get(`${owner.ownerId}\u0000${owner.epoch}`)
				?.size ?? 0) > 0
		);
	}
	private async assertWorkspaceActivityDrained(
		owner: GoalStoreOwner,
		snapshot: GoalStoreSnapshot,
	): Promise<void> {
		if (this.ownerHasActivity(owner))
			throw new Error("Goal handoff requires distinct owner and drained effects");
		for (const ledger of ["workspace-effects", "verifier-effects", "apply-effects", "successor-verifier-effects"] as const) {
			const root = join(dirname(this.root), ledger);
			try {
				await directory(root);
			} catch (error) {
				if (code(error) === "ENOENT") continue;
				throw error;
			}
			{
				const roots = ledger === "workspace-effects" || ledger === "successor-verifier-effects"
					? await Promise.all((await readdir(root, { withFileTypes: true })).map(async (entry) => {
						const path = join(root, entry.name);
						const info = await lstat(path);
						if (!entry.isDirectory() || !info.isDirectory() || info.isSymbolicLink() ||
							!/^[a-f0-9]{64}$/.test(entry.name))
							throw new Error("Goal workspace effect ledger path is invalid");
						return path;
					}))
					: [root];
				for (const effectRoot of roots) {
					const reader = await GoalHostEffects.open(effectRoot);
					const census = await reader.inspect();
					if (
						census.scope.goalId !== snapshot.contract.goalId ||
						(ledger === "successor-verifier-effects" &&
							(census.scope.ownerEpoch < 1 || census.scope.ownerEpoch > owner.epoch)) ||
						!census.sealed ||
						!census.bookkeepingComplete ||
						census.pendingEffects.length > 0 ||
						census.unknownEffects.length > 0 ||
						census.openProducers.length > 0 ||
						census.conflicts.length > 0
					)
						throw new Error(
							"Goal handoff requires distinct owner and drained effects",
						);
				}
			}
		}
	}
	async load(observations?: GoalAcceptedObservations): Promise<GoalStoreLoad> {
		if (observations) assertAcceptedGoalObservations(observations);
		try {
			await directory(this.root);
		} catch (error) {
			return {
				status:
					code(error) === "ENOENT"
						? "missing"
						: code(error) === "EACCES" || code(error) === "EPERM"
							? "inaccessible"
							: "corrupt",
				diagnostic: String(error),
			};
		}
		try {
			await directory(join(this.root, "journal"));
			const contract = parseGoalContract(
				await readBounded(join(this.root, "contract.json")),
			);
			const host = createGoalHostIngress();
			const acceptedContract = host.contract(contract, {
				kind: "user",
				id: contract.authority.issuer,
			});
			const names = await readdir(join(this.root, "journal"));
			const evidence = names.filter((n) => n.startsWith(".txn-"));
			const files = names.filter((n) => /^\d{10}\.json$/.test(n)).sort();
			if (
				files.length < 1 ||
				files.length > GOAL_MAX_EVENTS ||
				names.length > GOAL_MAX_EVENTS * 2 ||
				names.some((n) => !files.includes(n) && !evidence.includes(n))
			)
				throw new Error("Goal journal cardinality/unknown entry");
			let hash = ZERO;
			let ownerId = "";
			let epoch = 0;
			let creationReceiptHash = "";
			let lastObservations: GoalAcceptedObservations | undefined;
			const events: GoalAcceptedEvent[] = [];
			let effectiveContract = acceptedContract;
			const lifecycleCustodyIssuances: GoalLifecycleCustodyIssuance[] = [];
			for (let seq = 0; seq < files.length; seq++) {
				const previousAt = lastObservations?.data.at ?? 0;
				if (files[seq] !== `${String(seq).padStart(10, "0")}.json`)
					throw new Error("Goal journal missing sequence");
				const r = record(await readBounded(join(this.root, "journal", files[seq])));
				if (r.seq !== seq || r.previousHash !== hash)
					throw new Error("Goal journal chain mismatch");
				if (seq === 0) {
					if (r.kind !== "genesis" || r.epoch !== 0)
						throw new Error("Goal genesis mismatch");
					const payload = parse<Genesis>(
						r.payload,
						obj({
							contractHash: digest,
							observations: (v) => {
								parseGoalObservations(v);
							},
						}),
					);
					if (payload.contractHash !== goalHash(contract))
						throw new Error("Goal contract digest mismatch");
					ownerId = r.ownerId;
					creationReceiptHash = r.hash;
					lastObservations = host.observations(payload.observations);
				} else {
					if (r.ownerId !== ownerId || r.epoch !== epoch)
						throw new Error("Goal journal owner epoch mismatch");
					if (r.kind === "event") {
						const event = acceptedRecord(r.payload);
						events.push(event);
						if (event.data.type === "revision")
							effectiveContract = host.contract(event.data.contract, event.actor);
						lastObservations = host.observations(event.observations);
					} else if (r.kind === "handoff") {
						const payload = parse<Handoff>(
							r.payload,
							obj({
								nextOwnerId: id,
								observations: (v) => {
									parseGoalObservations(v);
								},
							}),
						);
						lastObservations = host.observations(payload.observations);
						const decision = reduceGoal(acceptedContract, events, lastObservations);
						if (
							decision.pendingEffects.length ||
							["achieved", "failed", "cancelled"].includes(decision.lifecycle) ||
							payload.nextOwnerId === ownerId
						)
							throw new Error("Goal handoff not drained/nonterminal");
						ownerId = payload.nextOwnerId;
						epoch++;
					} else if (r.kind === "lifecycle-custody") {
						const payload = parse<LifecycleCustodyIssuanceData>(
							r.payload,
							obj({
								schemaVersion: one(1),
								issuanceId: id,
								ownerId: id,
								incarnation: str,
								creationReceiptHash: digest,
								previousIssuanceHash: nullable(digest),
								authorityDigest: digest,
								takeover: bool,
							}),
						);
						const previous = lifecycleCustodyIssuances.at(-1);
						if (
							payload.ownerId !== r.ownerId ||
							payload.creationReceiptHash !== creationReceiptHash ||
							payload.previousIssuanceHash !== (previous?.receiptHash ?? null) ||
							lifecycleCustodyIssuances.some(
								(candidate) => candidate.issuanceId === payload.issuanceId,
							)
						)
							throw new Error("Goal lifecycle custody issuance chain mismatch");
						lifecycleCustodyIssuances.push({
							...payload,
							generation: r.epoch,
							receiptHash: r.hash,
						});
					} else throw new Error("Goal duplicate genesis");
				}
				if (lastObservations!.data.at < previousAt)
					throw new Error("Goal journal observation time regressed");
				hash = r.hash;
			}
			if (observations && observations.data.at < lastObservations!.data.at) {
				return {
					status: "observation-rejected",
					diagnostic: "Goal current observation time regressed behind journal head",
				};
			}
			const decision = reduceGoal(
				acceptedContract,
				events,
				observations ?? lastObservations!,
			);
			return {
				status: "ok",
				contract: acceptedContract,
				currentContract: effectiveContract,
				events,
				decision,
				seq: files.length - 1,
				hash,
				ownerId,
				epoch,
				creationReceiptHash,
				lifecycleCustodyIssuances,
				evidence,
			};
		} catch (error) {
			return {
				status: ["EACCES", "EPERM", "EIO", "EMFILE", "ENFILE"].includes(
					code(error) ?? "",
				)
					? "inaccessible"
					: "corrupt",
				diagnostic: String(error),
			};
		}
	}
	private async publish(
		path: string,
		value: unknown,
		inject = false,
	): Promise<void> {
		const temp = join(dirname(path), `.txn-${randomUUID()}`);
		const fd = await open(temp, "wx", 0o600);
		try {
			await fd.writeFile(goalJson(value));
			if (inject) await this.options.fault?.("temp-written", temp);
			await fd.sync();
			if (inject) await this.options.fault?.("file-synced", temp);
		} finally {
			await fd.close();
		}
		await link(temp, path); // Exclusive publication: never rename over a sequence.
		if (inject) await this.options.fault?.("published", path);
		await syncDirectory(dirname(path));
		if (inject) await this.options.fault?.("directory-synced", path);
		await unlink(temp);
		await syncDirectory(dirname(path));
	}
	private async exclusive<T>(
		action: (writing: () => void) => Promise<T>,
	): Promise<T> {
		return withGoalHostWriteLock(dirname(this.root), async (hostWriting) => {
			await assertGoalStoreOpenForWrite(this.root);
			const lock = join(this.root, ".commit-lock");
			await mkdir(lock, { mode: 0o700 }); // EEXIST is busy/unknown, never stale-deleted.
			await syncDirectory(this.root);
			let clean = true;
			try {
				const result = await action(() => {
					clean = false;
					hostWriting();
				});
				clean = true;
				return result;
			} finally {
				// Failures after writes may be ambiguous: retain both locks. Pure
				// admission rejection releases only locks acquired by this invocation.
				if (clean) {
					await rmdir(lock);
					await syncDirectory(this.root);
				}
			}
		});
	}
	async create(
		contract: GoalContract,
		owner: GoalStoreOwner,
		observations: GoalAcceptedObservations,
	): Promise<GoalStoreSnapshot> {
		assertAcceptedGoalContract(contract);
		assertAcceptedGoalObservations(observations);
		this.owner(owner);
		if (contract.revision !== 1 || owner.epoch !== 0)
			throw new Error("Goal creation requires genesis");
		// Only create explicitly; parent must already exist. Status/load never mkdir.
		await mkdir(this.root, { mode: 0o700 });
		await syncDirectory(dirname(this.root));
		return this.exclusive(async (writing) => {
			writing();
			await mkdir(join(this.root, "journal"), { mode: 0o700 });
			await syncDirectory(this.root);
			await this.publish(join(this.root, "contract.json"), contract);
			await this.append(0, ZERO, owner, "genesis", {
				contractHash: goalHash(contract),
				observations: observations.data,
			});
			const snapshot = await this.requireLoad(observations);
			await this.projection(snapshot);
			return snapshot;
		});
	}
	private async requireLoad(
		observations?: GoalAcceptedObservations,
	): Promise<GoalStoreSnapshot> {
		const loaded = await this.load(observations);
		if (loaded.status !== "ok")
			throw new Error(`Goal store ${loaded.status}: ${loaded.diagnostic}`);
		return loaded;
	}
	private async append(
		seq: number,
		previousHash: string,
		owner: GoalStoreOwner,
		kind: JournalRecord["kind"],
		payload: unknown,
	): Promise<void> {
		if (seq >= GOAL_MAX_EVENTS) throw new Error("Goal journal full");
		const body = {
			schemaVersion: 1,
			seq,
			previousHash,
			ownerId: owner.ownerId,
			epoch: owner.epoch,
			kind,
			payload,
		};
		await this.publish(
			join(this.root, "journal", `${String(seq).padStart(10, "0")}.json`),
			{ ...body, hash: goalHash(body) },
			true,
		);
	}
	/** Read-only validation for host capabilities that must follow the current owner. */
	async assertCurrentOwner(
		owner: GoalStoreOwner,
		observations: GoalAcceptedObservations,
	): Promise<GoalStoreSnapshot> {
		this.owner(owner);
		assertAcceptedGoalObservations(observations);
		const snapshot = await this.requireLoad(observations);
		if (snapshot.epoch !== owner.epoch || snapshot.ownerId !== owner.ownerId)
			throw new Error("Goal stale owner epoch");
		if (snapshot.evidence.length)
			throw new Error("Goal transaction residue; automatic recovery unavailable");
		if (["achieved", "failed", "cancelled"].includes(snapshot.decision.lifecycle))
			throw new Error("Goal terminal immutable");
		return snapshot;
	}
	private async checkExpected(
		owner: GoalStoreOwner,
		expected: { seq: number; hash: string },
		observations: GoalAcceptedObservations,
	): Promise<GoalStoreSnapshot> {
		nat(expected.seq);
		digest(expected.hash);
		const snapshot = await this.assertCurrentOwner(owner, observations);
		if (snapshot.seq !== expected.seq || snapshot.hash !== expected.hash)
			throw new Error("Goal expected sequence/hash conflict");
		return snapshot;
	}

	/** Explicitly mint one head-bound, process-local takeover authorization. */
	async authorizeLifecycleCustodyTakeover(
		owner: GoalStoreOwner,
		expected: { seq: number; hash: string },
		observations: GoalAcceptedObservations,
		evidence: GoalLifecycleTakeoverEvidence,
	): Promise<GoalLifecycleCustodyTakeoverAuthorization> {
		this.owner(owner);
		const capturedTestOnly = lifecycleTakeoverEvidence.get(evidence as object);
		const capturedSupervisor = supervisorLifecycleTakeoverEvidence.get(
			evidence as object,
		);
		if (!capturedTestOnly && !capturedSupervisor)
			throw new Error("Goal lifecycle takeover evidence is untrusted");
		const snapshot = await this.checkExpected(owner, expected, observations);
		const previousCustody = snapshot.lifecycleCustodyIssuances.at(-1);
		const claim = capturedTestOnly?.payload ?? capturedSupervisor!.payload.request;
		const supervisorClaim = capturedSupervisor?.payload.request;
		if (
			claim.root !== this.root ||
			claim.current.ownerId !== owner.ownerId ||
			claim.current.epoch !== owner.epoch ||
			claim.current.seq !== snapshot.seq ||
			claim.current.hash !== snapshot.hash ||
			previousCustody === undefined ||
			claim.previousCustody.issuanceId !== previousCustody.issuanceId ||
			claim.previousCustody.receiptHash !== previousCustody.receiptHash ||
			claim.previousCustody.ownerId !== previousCustody.ownerId ||
			claim.previousCustody.generation !== previousCustody.generation ||
			claim.previousCustody.incarnation !== previousCustody.incarnation ||
			snapshot.epoch !== previousCustody.generation + 1 ||
			(supervisorClaim !== undefined &&
				(supervisorClaim.creationReceiptHash !== snapshot.creationReceiptHash ||
					supervisorClaim.workerDrain.disposition !== "drained" ||
					supervisorClaim.workerDrain.processIncarnation !==
						previousCustody.incarnation))
		)
			throw new Error("Goal lifecycle takeover evidence does not match custody");
		const authorization = Object.freeze(
			Object.create(null),
		) as GoalLifecycleCustodyTakeoverAuthorization;
		lifecycleCustodyTakeovers.set(authorization, {
			root: this.root,
			ownerId: owner.ownerId,
			epoch: owner.epoch,
			head: { seq: snapshot.seq, hash: snapshot.hash },
			authorityDigest: (capturedTestOnly ?? capturedSupervisor)!.digest,
		});
		return authorization;
	}

	/** Atomically records one lifecycle-custody issuance. The first epoch-zero
	 * issuance is chained to genesis; every replacement requires an exact
	 * process-local takeover authorization, consumed only after durable append. */
	async issueLifecycleCustody(
		owner: GoalStoreOwner,
		expected: { seq: number; hash: string },
		observations: GoalAcceptedObservations,
		request: {
			readonly incarnation: string;
			readonly takeoverAuthorization: GoalLifecycleCustodyTakeoverAuthorization | null;
		},
	): Promise<{
		readonly snapshot: GoalStoreSnapshot;
		readonly receipt: GoalLifecycleCustodyIssuance;
	}> {
		this.owner(owner);
		str(request.incarnation);
		assertAcceptedGoalObservations(observations);
		const authorization =
			request.takeoverAuthorization === null
				? undefined
				: lifecycleCustodyTakeovers.get(request.takeoverAuthorization as object);
		if (
			request.takeoverAuthorization !== null &&
			(!authorization ||
				authorization.root !== this.root ||
				authorization.ownerId !== owner.ownerId ||
				authorization.epoch !== owner.epoch ||
				authorization.head.seq !== expected.seq ||
				authorization.head.hash !== expected.hash)
		)
			throw new Error(
				"Goal lifecycle takeover authorization is stale or untrusted",
			);
		return this.exclusive(async (writing) => {
			const snapshot = await this.checkExpected(owner, expected, observations);
			const prior = snapshot.lifecycleCustodyIssuances.at(-1);
			const takeover = authorization !== undefined;
			if (
				takeover
					? owner.epoch === 0 ||
						prior === undefined ||
						prior.generation !== owner.epoch - 1
					: owner.epoch !== 0 || prior !== undefined
			)
				throw new Error(
					takeover
						? "Goal lifecycle takeover has no prior custody issuance"
						: "Goal initial lifecycle custody was already issued",
				);
			const issuanceId = `custody-${randomUUID()}`;
			const authorityDigest =
				authorization?.authorityDigest ??
				goalHash({
					initial: true,
					generation: 0,
					creationReceiptHash: snapshot.creationReceiptHash,
				});
			writing();
			await this.append(
				snapshot.seq + 1,
				snapshot.hash,
				owner,
				"lifecycle-custody",
				{
					schemaVersion: 1,
					issuanceId,
					ownerId: owner.ownerId,
					incarnation: request.incarnation,
					creationReceiptHash: snapshot.creationReceiptHash,
					previousIssuanceHash: prior?.receiptHash ?? null,
					authorityDigest,
					takeover,
				} satisfies LifecycleCustodyIssuanceData,
			);
			const updated = await this.requireLoad(observations);
			const receipt = updated.lifecycleCustodyIssuances.at(-1);
			if (!receipt || receipt.issuanceId !== issuanceId)
				throw new Error("Goal lifecycle custody issuance acknowledgement missing");
			if (request.takeoverAuthorization)
				lifecycleCustodyTakeovers.delete(request.takeoverAuthorization as object);
			await this.projection(updated);
			return { snapshot: updated, receipt };
		});
	}

	async commitEvent(
		owner: GoalStoreOwner,
		expected: { seq: number; hash: string },
		event: GoalAcceptedEvent,
	): Promise<GoalStoreSnapshot> {
		return this.commitAcceptedEvent(owner, expected, event, "ordinary");
	}
	/** Host lifecycle bookkeeping may finish an already-claimed probe after a
	 * concurrent terminal control event. This cannot claim, wake, or revive the
	 * Goal; it only records the exact result/drain needed to close that effect. */
	async commitLifecycleEvent(
		owner: GoalStoreOwner,
		expected: { seq: number; hash: string },
		event: GoalAcceptedEvent,
	): Promise<GoalStoreSnapshot> {
		this.owner(owner);
		assertAcceptedGoalEvent(event);
		if (
			event.data.type !== "probe" ||
			(event.data.record.type !== "result" &&
				event.data.record.type !== "drain" &&
				event.data.record.type !== "abandoned-drain")
		)
			throw new Error("Goal lifecycle commit accepts probe result/drain only");
		return this.commitAcceptedEvent(
			owner,
			expected,
			event,
			"lifecycle-bookkeeping",
		);
	}
	private async commitAcceptedEvent(
		owner: GoalStoreOwner,
		expected: { seq: number; hash: string },
		event: GoalAcceptedEvent,
		mode: "ordinary" | "lifecycle-bookkeeping",
	): Promise<GoalStoreSnapshot> {
		this.owner(owner);
		assertAcceptedGoalEvent(event);
		const observations = createGoalHostIngress().observations(event.observations);
		return this.exclusive(async (writing) => {
			let snapshot: GoalStoreSnapshot;
			if (mode === "lifecycle-bookkeeping") {
				nat(expected.seq);
				digest(expected.hash);
				snapshot = await this.requireLoad(observations);
				if (snapshot.epoch !== owner.epoch || snapshot.ownerId !== owner.ownerId)
					throw new Error("Goal stale owner epoch");
				if (snapshot.evidence.length)
					throw new Error(
						"Goal transaction residue; automatic recovery unavailable",
					);
				if (snapshot.seq !== expected.seq || snapshot.hash !== expected.hash)
					throw new Error("Goal expected sequence/hash conflict");
			} else snapshot = await this.checkExpected(owner, expected, observations);
			if (snapshot.events.some((e) => e.data.id === event.data.id))
				throw new Error("Goal duplicate committed event");
			const updatedDecision = reduceGoal(
				snapshot.contract,
				[...snapshot.events, event],
				observations,
			); // Validate BEFORE authoritative publish.
			if (
				mode === "lifecycle-bookkeeping" &&
				["achieved", "failed", "cancelled"].includes(snapshot.decision.lifecycle) &&
				updatedDecision.lifecycle !== snapshot.decision.lifecycle
			)
				throw new Error("Goal terminal lifecycle bookkeeping cannot revive Goal");
			writing();
			await this.append(snapshot.seq + 1, snapshot.hash, owner, "event", event);
			const updated = await this.requireLoad(observations);
			await this.options.fault?.("before-projection", this.root);
			await this.projection(updated);
			return updated;
		});
	}
	/** Voluntary old-owner release only. Caller must have reconciled the complete
	 * effect inventory. Expiry/PID death cannot mint a successor owner epoch. */
	async handoff(
		owner: GoalStoreOwner,
		expected: { seq: number; hash: string },
		nextOwnerId: string,
		observations: GoalAcceptedObservations,
	): Promise<GoalStoreSnapshot> {
		this.owner(owner);
		id(nextOwnerId);
		assertAcceptedGoalObservations(observations);
		return this.exclusive(async (writing) => {
			const snapshot = await this.checkExpected(owner, expected, observations);
			if (nextOwnerId === owner.ownerId || snapshot.decision.pendingEffects.length)
				throw new Error("Goal handoff requires distinct owner and drained effects");
			await this.assertWorkspaceActivityDrained(owner, snapshot);
			writing();
			await this.append(snapshot.seq + 1, snapshot.hash, owner, "handoff", {
				nextOwnerId,
				observations: observations.data,
			});
			const updated = await this.requireLoad(observations);
			await this.projection(updated);
			return updated;
		});
	}
	requestTakeover(
		_oldOwnerState: "live" | "unknown" | "dead",
		_expired: boolean,
	): never {
		throw new Error(
			"Goal automatic owner recovery unavailable; PID/expiry is not authority",
		);
	}
	private async projection(snapshot: GoalStoreSnapshot): Promise<void> {
		const path = join(this.root, "projection.json");
		const temp = join(this.root, `.projection-${randomUUID()}`);
		await this.publish(temp, {
			schemaVersion: 1,
			seq: snapshot.seq,
			hash: snapshot.hash,
			decision: snapshot.decision,
		});
		// Preserve even corrupt previous cache bytes. Cache is never read as authority.
		try {
			await link(path, join(this.root, `.projection-evidence-${randomUUID()}`));
		} catch (error) {
			if (code(error) !== "ENOENT") throw error;
		}
		await rename(temp, path);
		await syncDirectory(this.root);
	}
	async rebuildProjection(
		observations?: GoalAcceptedObservations,
	): Promise<GoalStoreSnapshot> {
		if (observations) assertAcceptedGoalObservations(observations);
		// A prior crash lock blocks writes, but load still reconstructs in memory.
		return this.exclusive(async (writing) => {
			const snapshot = await this.requireLoad(observations);
			writing();
			await this.projection(snapshot);
			return snapshot;
		});
	}
}
