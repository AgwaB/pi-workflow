import { createHash, randomBytes } from "node:crypto";
import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
	GOAL_MAX_BYTES,
	GOAL_MAX_EVENTS,
	digest,
	goalHash,
	goalInput,
	goalJson,
	nat,
	obj,
	one,
	parse,
	parseGoalJsonTextWithCanonical,
	positive,
} from "./goal-json.js";
import {
	PRIVATE_DIRECTORY_READ_BATCH_MAX,
	publishPrivateGenerationDirectory,
	readPrivateDirectoryNames,
	withPrivateDirectoryReader,
	writePrivateFileAtomic,
	writePrivateFileNoReplace,
} from "./secure-atomic-write.js";
import { withGoalHostWriteLock } from "./goal-host-write-lock.js";
import {
	assertGoalOriginCustodyLease,
	type GoalOriginCustodyLease,
} from "./goal-origin-custody.js";

export type GoalJsonValue =
	| null
	| boolean
	| string
	| number
	| readonly GoalJsonValue[]
	| GoalJsonObject;
export interface GoalJsonObject {
	readonly [key: string]: GoalJsonValue;
}

export interface GoalHostJournalRecord {
	readonly version: 1;
	readonly seq: number;
	readonly previousHash: string;
	readonly payload: GoalJsonObject;
	readonly hash: string;
}
export interface GoalHostJournalSnapshot {
	readonly records: readonly GoalHostJournalRecord[];
	readonly head: { readonly seq: number; readonly hash: string };
}
/** Restart inspection is read-only; persisted bytes never reopen a writer. */
export interface GoalHostJournalReader {
	load(): Promise<GoalHostJournalSnapshot>;
}

export type GoalHostJournalCrashPoint = "after-record-before-manifest";
let crashForTests:
	| ((point: GoalHostJournalCrashPoint) => void | Promise<void>)
	| undefined;
/** Test-only deterministic abrupt-failure injection. */
export function setGoalHostJournalCrashHookForTests(
	hook: ((point: GoalHostJournalCrashPoint) => void | Promise<void>) | undefined,
): void {
	crashForTests = hook;
}

const constructionKey = Symbol("fresh Goal journal construction");
const RESUMED_CUSTODY = new WeakSet<object>();

interface GoalHostJournalManifest {
	readonly version: 1;
	readonly nonce: string;
	readonly head: { readonly seq: number; readonly hash: string };
}
interface RootIdentity {
	readonly dev: number;
	readonly ino: number;
	readonly uid: number;
}

const ZERO_HASH = "0".repeat(64);
const MANIFEST_NAME = "manifest.json";
const RECORD_NAME = /^(\d{10})\.json$/;
const TRANSACTION_RESIDUE =
	/^(?:manifest\.json|\d{10}\.json)\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/;
const MAX_AGGREGATE_BYTES = 64 * 1024 * 1024;
const MAX_CENSUS_ENTRIES = GOAL_MAX_EVENTS * 2 + 2;

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException)?.code;
}

function absoluteRoot(root: string): string {
	if (typeof root !== "string" || !isAbsolute(root))
		throw new Error("Goal host journal root must be absolute");
	return resolve(root);
}

function currentUid(): number {
	const uid = process.geteuid?.() ?? process.getuid?.();
	if (uid === undefined)
		throw new Error("Goal host journal owner identity is unavailable");
	return uid;
}

async function rootIdentity(root: string): Promise<RootIdentity> {
	const info = await lstat(root);
	if (!info.isDirectory() || info.isSymbolicLink())
		throw new Error("Goal host journal root must be a real directory");
	if ((info.mode & 0o7777) !== 0o700)
		throw new Error("Goal host journal root must have mode 0700");
	const uid = currentUid();
	if (info.uid !== uid)
		throw new Error("Goal host journal root must be owned by the current user");
	return { dev: info.dev, ino: info.ino, uid: info.uid };
}

function sameRoot(left: RootIdentity, right: RootIdentity): boolean {
	return (
		left.dev === right.dev && left.ino === right.ino && left.uid === right.uid
	);
}

async function assertRootBinding(
	root: string,
	expected: RootIdentity,
): Promise<void> {
	const actual = await rootIdentity(root);
	if (!sameRoot(actual, expected))
		throw new Error("Goal host journal root identity changed");
}

function manifest(input: unknown): GoalHostJournalManifest {
	return parse<GoalHostJournalManifest>(
		input,
		obj({
			version: one(1),
			nonce: digest,
			head: obj({ seq: nat, hash: digest }),
		}),
	);
}

function payloadObject(value: unknown): void {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Goal host journal payload must be an object");
}

function journalRecord(input: string): GoalHostJournalRecord {
	const { value, canonicalText } = parseGoalJsonTextWithCanonical(input);
	obj({
		version: one(1),
		seq: positive,
		previousHash: digest,
		payload: payloadObject,
		hash: digest,
	})(value);
	const parsed = value as unknown as GoalHostJournalRecord;
	const prefix = `{"hash":"${parsed.hash}",`;
	if (canonicalText.slice(0, prefix.length) !== prefix)
		throw new Error("Goal host journal record canonical hash prefix mismatch");
	const actualHash = createHash("sha256")
		.update("{", "utf8")
		.update(canonicalText.slice(prefix.length), "utf8")
		.digest("hex");
	if (parsed.hash !== actualHash)
		throw new Error("Goal host journal record hash mismatch");
	return parsed;
}

async function assertPrivateFile(
	path: string,
	root: RootIdentity,
): Promise<number> {
	const info = await lstat(path);
	if (!info.isFile() || info.isSymbolicLink())
		throw new Error("Goal host journal entry must be a regular file");
	if (info.nlink !== 1)
		throw new Error("Goal host journal entry must not be hard-linked");
	if ((info.mode & 0o7777) !== 0o600)
		throw new Error("Goal host journal entry must have mode 0600");
	if (info.uid !== root.uid)
		throw new Error("Goal host journal entry owner mismatch");
	if (!Number.isSafeInteger(info.size) || info.size < 0)
		throw new Error("Goal host journal entry size is invalid");
	return info.size;
}

async function censusJournal(
	root: string,
	identity: RootIdentity,
): Promise<Map<number, string>> {
	await assertRootBinding(root, identity);
	const names = await readPrivateDirectoryNames(root, MAX_CENSUS_ENTRIES);
	await assertRootBinding(root, identity);
	if (!names.includes(MANIFEST_NAME))
		throw new Error("Goal host journal manifest is missing");

	const recordsBySequence = new Map<number, string>();
	const residue: string[] = [];
	for (const name of names) {
		if (name === MANIFEST_NAME) continue;
		const match = RECORD_NAME.exec(name);
		if (match) {
			const seq = Number(match[1]);
			if (seq < 1 || seq > GOAL_MAX_EVENTS || recordsBySequence.has(seq))
				throw new Error("Goal host journal record census is invalid");
			recordsBySequence.set(seq, name);
			continue;
		}
		if (TRANSACTION_RESIDUE.test(name)) {
			residue.push(name);
			continue;
		}
		throw new Error(`Goal host journal unknown entry: ${name}`);
	}

	let aggregateBytes = 0;
	for (const name of names) {
		aggregateBytes += await assertPrivateFile(join(root, name), identity);
		if (aggregateBytes > MAX_AGGREGATE_BYTES)
			throw new Error("Goal host journal aggregate byte limit exceeded");
	}
	await assertRootBinding(root, identity);
	if (residue.length) {
		residue.sort((left, right) => left.localeCompare(right));
		throw new Error(
			`Goal host journal transaction residue retained: ${residue[0]}`,
		);
	}
	return recordsBySequence;
}

async function readJournal(
	root: string,
	identity: RootIdentity,
	expectedNonce?: string,
): Promise<{
	snapshot: GoalHostJournalSnapshot;
	nonce: string;
	manifestHead: Readonly<{ seq: number; hash: string }>;
}> {
	const recordsBySequence = await censusJournal(root, identity);
	return withPrivateDirectoryReader(root, async (read, readBatch) => {
		const parsedManifest = manifest(
			await read(MANIFEST_NAME, GOAL_MAX_BYTES),
		);
		if (expectedNonce !== undefined && parsedManifest.nonce !== expectedNonce)
			throw new Error("Goal host journal manifest identity changed");
		if (parsedManifest.head.seq > GOAL_MAX_EVENTS)
			throw new Error("Goal host journal manifest head exceeds record limit");
		// A no-replace record is fully fsynced before its final name is linked. The
		// sole valid census ahead of the manifest is therefore exactly one
		// contiguous record from an append interrupted before manifest publication.
		if (
			recordsBySequence.size < parsedManifest.head.seq ||
			recordsBySequence.size > parsedManifest.head.seq + 1
		)
			throw new Error("Goal host journal manifest/record census mismatch");

		const records: GoalHostJournalRecord[] = [];
		let previousHash = ZERO_HASH;
		for (
			let firstSeq = 1;
			firstSeq <= recordsBySequence.size;
			firstSeq += PRIVATE_DIRECTORY_READ_BATCH_MAX
		) {
			const names: string[] = [];
			const lastSeq = Math.min(
				recordsBySequence.size,
				firstSeq + PRIVATE_DIRECTORY_READ_BATCH_MAX - 1,
			);
			for (let seq = firstSeq; seq <= lastSeq; seq++) {
				const expectedName = `${String(seq).padStart(10, "0")}.json`;
				if (recordsBySequence.get(seq) !== expectedName)
					throw new Error("Goal host journal record gap");
				names.push(expectedName);
			}
			const encodedRecords = await readBatch(names, GOAL_MAX_BYTES);
			for (let offset = 0; offset < encodedRecords.length; offset++) {
				const seq = firstSeq + offset;
				const parsedRecord = journalRecord(encodedRecords[offset]);
				if (parsedRecord.seq !== seq || parsedRecord.previousHash !== previousHash)
					throw new Error("Goal host journal chain mismatch");
				records.push(parsedRecord);
				previousHash = parsedRecord.hash;
				if (
					seq === parsedManifest.head.seq &&
					parsedManifest.head.hash !== previousHash
				)
					throw new Error("Goal host journal manifest head mismatch");
			}
		}
		if (
			(parsedManifest.head.seq === 0 && parsedManifest.head.hash !== ZERO_HASH) ||
			(parsedManifest.head.seq > 0 && records.length < parsedManifest.head.seq)
		)
			throw new Error("Goal host journal manifest head mismatch");
		await assertRootBinding(root, identity);
		const adoptedHead = records.at(-1)
			? { seq: records.length, hash: records.at(-1)!.hash }
			: { seq: 0, hash: ZERO_HASH };
		const snapshot = Object.freeze({
			records: Object.freeze(records),
			head: Object.freeze(adoptedHead),
		});
		return {
			snapshot,
			nonce: parsedManifest.nonce,
			manifestHead: Object.freeze({ ...parsedManifest.head }),
		};
	});
}

/**
 * Bounded host-owned journal storage only. It does not mint writer, Goal,
 * qualification, provenance, callback, registration, or process authority.
 * The host must separately enforce a single-writer lifecycle. Exclusive-link
 * record publication prevents replacement and arbitrates equal-head appends.
 * Portable path checks reduce accidental races but do not claim atomic safety
 * against a hostile same-user process on every filesystem.
 */
export class GoalHostJournal {
	readonly root: string;
	readonly #identity: RootIdentity;
	readonly #nonce: string;
	#poisoned: Error | undefined;
	#seenHead = { seq: 0, hash: ZERO_HASH };
	#queue: Promise<void> = Promise.resolve();

	private constructor(
		root: string,
		identity: RootIdentity,
		nonce: string,
		key: symbol,
	) {
		if (key !== constructionKey)
			throw new Error("Goal journal construction is private");
		this.root = root;
		this.#identity = identity;
		this.#nonce = nonce;
	}

	static async create(root: string): Promise<GoalHostJournal> {
		const absolute = absoluteRoot(root);
		try {
			await lstat(absolute);
			throw new Error("Goal host journal root already exists");
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
		}
		const nonce = randomBytes(32).toString("hex");
		const initialManifest: GoalHostJournalManifest = {
			version: 1,
			nonce,
			head: { seq: 0, hash: ZERO_HASH },
		};
		await publishPrivateGenerationDirectory(
			absolute,
			MANIFEST_NAME,
			goalJson(initialManifest),
		);
		const identity = await rootIdentity(absolute);
		const inspected = await readJournal(absolute, identity, nonce);
		if (inspected.snapshot.head.seq !== 0)
			throw new Error("Goal host journal initialization is not empty");
		return new GoalHostJournal(absolute, identity, nonce, constructionKey);
	}

	static async open(root: string): Promise<GoalHostJournalReader> {
		const absolute = absoluteRoot(root);
		const identity = await rootIdentity(absolute);
		const inspected = await readJournal(absolute, identity);
		await assertRootBinding(absolute, identity);
		const reader = new GoalHostJournal(
			absolute,
			identity,
			inspected.nonce,
			constructionKey,
		);
		reader.#pin(inspected.snapshot);
		return Object.freeze({ load: () => reader.load() });
	}

	/** Resume only an exact head while holding live physical-origin custody. */
	static async resume(
		root: string,
		expected: { readonly seq: number; readonly hash: string },
		custody: GoalOriginCustodyLease,
	): Promise<GoalHostJournal> {
		const absolute = absoluteRoot(root);
		const pinned = parse<{ seq: number; hash: string }>(
			expected,
			obj({ seq: nat, hash: digest }),
		);
		assertGoalOriginCustodyLease(custody);
		if (RESUMED_CUSTODY.has(custody as object))
			throw new Error("Goal custody lease already resumed a journal writer");
		RESUMED_CUSTODY.add(custody as object);
		await custody.assertCurrent();
		const identity = await rootIdentity(absolute);
		let inspected = await readJournal(absolute, identity);
		if (
			inspected.snapshot.head.seq !== pinned.seq ||
			inspected.snapshot.head.hash !== pinned.hash
		)
			throw new Error("Goal journal recovery head conflict");
		if (
			inspected.manifestHead.seq !== inspected.snapshot.head.seq ||
			inspected.manifestHead.hash !== inspected.snapshot.head.hash
		) {
			await custody.assertCurrent();
			await writePrivateFileAtomic(
				join(absolute, MANIFEST_NAME),
				goalJson({
					version: 1,
					nonce: inspected.nonce,
					head: inspected.snapshot.head,
				}),
			);
			await custody.assertCurrent();
			inspected = await readJournal(absolute, identity, inspected.nonce);
			if (
				inspected.manifestHead.seq !== pinned.seq ||
				inspected.manifestHead.hash !== pinned.hash
			)
				throw new Error("Goal journal interrupted record adoption failed");
		}
		const writer = new GoalHostJournal(
			absolute,
			identity,
			inspected.nonce,
			constructionKey,
		);
		writer.#pin(inspected.snapshot);
		return writer;
	}

	async load(): Promise<GoalHostJournalSnapshot> {
		await this.#queue;
		this.#assertUsable();
		try {
			const snapshot = (await readJournal(this.root, this.#identity, this.#nonce))
				.snapshot;
			this.#pin(snapshot);
			return snapshot;
		} catch (cause) {
			throw this.#poison(cause, "Goal host journal load failed closed");
		}
	}

	async append(
		expected: { seq: number; hash: string },
		payload: GoalJsonObject,
	): Promise<GoalHostJournalSnapshot> {
		const head = parse<{ seq: number; hash: string }>(
			expected,
			obj({ seq: nat, hash: digest }),
		);
		const captured = parse<GoalJsonObject>(payload, payloadObject);
		const action = this.#queue.then(() =>
			withGoalHostWriteLock(dirname(this.root), (writing) =>
				this.#append(head, captured, writing),
			),
		);
		this.#queue = action.then(
			() => {},
			() => {},
		);
		return action;
	}

	async #append(
		expected: { seq: number; hash: string },
		payload: GoalJsonObject,
		writing: () => void,
	): Promise<GoalHostJournalSnapshot> {
		this.#assertUsable();
		const acceptedExpected = parse<{ seq: number; hash: string }>(
			expected,
			obj({ seq: nat, hash: digest }),
		);
		const acceptedPayload = goalInput(goalJson(payload));
		payloadObject(acceptedPayload);

		let current: GoalHostJournalSnapshot;
		try {
			current = (await readJournal(this.root, this.#identity, this.#nonce))
				.snapshot;
			this.#pin(current);
		} catch (cause) {
			throw this.#poison(
				cause,
				"Goal host journal append admission failed closed",
			);
		}
		if (
			current.head.seq !== acceptedExpected.seq ||
			current.head.hash !== acceptedExpected.hash
		)
			throw new Error("Goal host journal expected head conflict");
		if (current.head.seq >= GOAL_MAX_EVENTS)
			throw new Error("Goal host journal record limit exceeded");

		const body = {
			version: 1 as const,
			seq: current.head.seq + 1,
			previousHash: current.head.hash,
			payload: acceptedPayload as GoalJsonObject,
		};
		const next: GoalHostJournalRecord = { ...body, hash: goalHash(body) };
		const recordText = goalJson(next);
		const recordPath = join(
			this.root,
			`${String(next.seq).padStart(10, "0")}.json`,
		);
		try {
			await assertRootBinding(this.root, this.#identity);
			writing();
			await writePrivateFileNoReplace(recordPath, recordText);
			await crashForTests?.("after-record-before-manifest");
		} catch (cause) {
			if (errorCode(cause) === "EEXIST") {
				try {
					await assertRootBinding(this.root, this.#identity);
				} catch (bindingCause) {
					throw this.#poison(
						bindingCause,
						"Goal host journal concurrent append became ambiguous",
					);
				}
				throw new Error("Goal host journal concurrent append conflict", { cause });
			}
			throw this.#poison(
				cause,
				"Goal host journal record publication became ambiguous",
			);
		}

		const nextManifest: GoalHostJournalManifest = {
			version: 1,
			nonce: this.#nonce,
			head: { seq: next.seq, hash: next.hash },
		};
		try {
			await writePrivateFileAtomic(
				join(this.root, MANIFEST_NAME),
				goalJson(nextManifest),
			);
			await assertRootBinding(this.root, this.#identity);
			const committed = (await readJournal(this.root, this.#identity, this.#nonce))
				.snapshot;
			this.#pin(committed);
			return committed;
		} catch (cause) {
			throw this.#poison(
				cause,
				"Goal host journal manifest publication became ambiguous",
			);
		}
	}

	#pin(snapshot: GoalHostJournalSnapshot): void {
		if (
			snapshot.head.seq < this.#seenHead.seq ||
			(this.#seenHead.seq > 0 &&
				snapshot.records[this.#seenHead.seq - 1]?.hash !== this.#seenHead.hash)
		)
			throw new Error("Goal host journal observed history rolled back or forked");
		this.#seenHead = { ...snapshot.head };
	}

	#assertUsable(): void {
		if (this.#poisoned)
			throw new Error("Goal host journal instance is poisoned", {
				cause: this.#poisoned,
			});
	}

	#poison(cause: unknown, message: string): Error {
		const detail = cause instanceof Error ? cause.message : String(cause);
		const error = new Error(`${message}: ${detail}`, { cause });
		this.#poisoned ??= error;
		return error;
	}
}

/** Publication observation only: no journal reader or resume writer is returned. */
export async function inspectGoalHostJournalPublication(root: string): Promise<{
	readonly snapshot: GoalHostJournalSnapshot;
	readonly manifestHead: { readonly seq: number; readonly hash: string };
}> {
	const absolute = absoluteRoot(root);
	const identity = await rootIdentity(absolute);
	const first = await readJournal(absolute, identity);
	const second = await readJournal(absolute, identity, first.nonce);
	await assertRootBinding(absolute, identity);
	if (first.snapshot.head.seq !== second.snapshot.head.seq ||
		first.snapshot.head.hash !== second.snapshot.head.hash ||
		first.manifestHead.seq !== second.manifestHead.seq ||
		first.manifestHead.hash !== second.manifestHead.hash)
		throw new Error("Goal host journal publication changed during inspection");
	return Object.freeze({ snapshot: second.snapshot, manifestHead: second.manifestHead });
}
