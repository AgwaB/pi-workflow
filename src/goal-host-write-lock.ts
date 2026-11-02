import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, realpath, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { goalInput } from "./goal-json.js";

const LOCK_NAME = ".goal-host-write-lock";
const RETENTION_CLOSURE_NAME = ".goal-retention-closed.json";
const RETENTION_CLOSURE_SCHEMA = "pi-goal-retention-closure-v1";
export interface GoalRetentionClosure {
	readonly schema: typeof RETENTION_CLOSURE_SCHEMA;
	readonly state: "prepared" | "detached" | "complete";
	readonly transactionId: string;
	readonly goalId: string;
	readonly contractHash: string;
	readonly ownerId: string;
	readonly ownerEpoch: number;
	readonly head: { readonly seq: number; readonly hash: string };
	readonly workflowRunIds: readonly string[];
	readonly createdAt: string;
}
interface GoalHostWriteLease {
	readonly kind: "goal-host-write-lease";
	readonly rootDev: number;
	readonly rootIno: number;
	readonly lockDev: number;
	readonly lockIno: number;
}
interface GoalHostWriteContext {
	readonly leases: ReadonlyMap<string, GoalHostWriteLease>;
	readonly markWriting: () => void;
}
const context = new AsyncLocalStorage<GoalHostWriteContext>();

async function matchesLease(root: string, lease: GoalHostWriteLease): Promise<boolean> {
	try {
		const host = await lstat(root);
		const lock = await lstat(join(root, LOCK_NAME));
		return host.isDirectory() && !host.isSymbolicLink() &&
			lock.isDirectory() && !lock.isSymbolicLink() &&
			host.dev === lease.rootDev && host.ino === lease.rootIno &&
			lock.dev === lease.lockDev && lock.ino === lease.lockIno;
	} catch {
		return false;
	}
}

/** True only for the exact physical root currently owned by this async chain. */
export async function hasCurrentGoalHostWriteLease(root: string): Promise<boolean> {
	try {
		const physical = await realpath(resolve(root));
		const lease = context.getStore()?.leases.get(physical);
		if (!lease) return false;
		return matchesLease(physical, lease);
	} catch {
		return false;
	}
}

async function syncDirectory(path: string): Promise<void> {
	const handle = await open(path, constants.O_RDONLY);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}
function closure(value: unknown): GoalRetentionClosure | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	const state = record.state;
	const transactionId = record.transactionId;
	const createdAt = record.createdAt;
	const workflowRunIds = record.workflowRunIds;
	const goalId = record.goalId;
	const contractHash = record.contractHash;
	const ownerId = record.ownerId;
	const ownerEpoch = record.ownerEpoch;
	const head = record.head;
	if (
		record.schema !== RETENTION_CLOSURE_SCHEMA ||
		(state !== "prepared" && state !== "detached" && state !== "complete") ||
		typeof transactionId !== "string" ||
		typeof goalId !== "string" || !safeId(goalId) ||
		typeof contractHash !== "string" || !hash(contractHash) ||
		typeof ownerId !== "string" || !safeId(ownerId) ||
		typeof ownerEpoch !== "number" ||
		!Number.isSafeInteger(ownerEpoch) ||
		ownerEpoch < 0 ||
		!head ||
		typeof head !== "object" ||
		typeof (head as Record<string, unknown>).seq !== "number" ||
		!Number.isSafeInteger((head as Record<string, unknown>).seq) ||
		typeof (head as Record<string, unknown>).hash !== "string" ||
		!hash((head as Record<string, unknown>).hash) ||
		typeof createdAt !== "string" ||
		!Number.isFinite(Date.parse(createdAt)) ||
		!Array.isArray(workflowRunIds) ||
		!workflowRunIds.every(
			(id) =>
				typeof id === "string" &&
				id.length > 0 &&
				id.length <= 512 &&
				!id.includes("/") &&
				!id.includes("\\") &&
				!id.includes("\0"),
		) ||
		Object.keys(record).length !== 10 ||
		Object.keys(head as Record<string, unknown>).length !== 2
	) return null;
	return {
		schema: RETENTION_CLOSURE_SCHEMA,
		state,
		transactionId,
		goalId,
		contractHash,
		ownerId,
		ownerEpoch,
		head: {
			seq: (record.head as Record<string, number>).seq,
			hash: (record.head as Record<string, string>).hash,
		},
		workflowRunIds: [...workflowRunIds],
		createdAt,
	};
}
function safeId(value: string): boolean {
	return value.length > 0 && value.length <= 512 && !value.includes("/") &&
		!value.includes("\\") && !value.includes("\0");
}
function hash(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
/** Read-only: malformed or incomplete closure evidence is intentionally visible. */
export async function readGoalRetentionClosure(
	hostRoot: string,
): Promise<GoalRetentionClosure | null | "uncertain"> {
	try {
		return closure(goalInput(await readFile(join(resolve(hostRoot), RETENTION_CLOSURE_NAME), "utf8"))) ?? "uncertain";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		return "uncertain";
	}
}
export function goalRetentionClosureMatches(
	closure: GoalRetentionClosure,
	expected: Pick<GoalRetentionClosure, "goalId" | "contractHash" | "ownerId" | "ownerEpoch" | "head">,
): boolean {
	return (
		closure.goalId === expected.goalId &&
		closure.contractHash === expected.contractHash &&
		closure.ownerId === expected.ownerId &&
		closure.ownerEpoch === expected.ownerEpoch &&
		closure.head.seq === expected.head.seq &&
		closure.head.hash === expected.head.hash
	);
}
/** Goal stores may be direct host roots or nested `host/goal` stores. */
export async function assertGoalStoreOpenForWrite(storeRoot: string): Promise<void> {
	const root = resolve(storeRoot);
	const direct = await readGoalRetentionClosure(root);
	const host = await readGoalRetentionClosure(resolve(root, ".."));
	if (direct !== null || host !== null)
		throw new Error("Goal store retention-closed or closure state uncertain");
}
/** Caller must already own the host writer lease. Published markers are never removed. */
export async function publishGoalRetentionClosure(
	hostRoot: string,
	value: GoalRetentionClosure,
): Promise<void> {
	if (closure(value) === null)
		throw new Error("Goal retention closure payload invalid");
	const root = resolve(hostRoot);
	await assertGoalHostWriteLease(root);
	if ((await readGoalRetentionClosure(root)) !== null)
		throw new Error("Goal retention closure already exists or is uncertain");
	const temporary = join(root, `.${RETENTION_CLOSURE_NAME}.${value.transactionId}.txn`);
	const target = join(root, RETENTION_CLOSURE_NAME);
	await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
	try {
		const file = await open(temporary, constants.O_RDONLY);
		try { await file.sync(); } finally { await file.close(); }
		await link(temporary, target);
		await syncDirectory(root);
	} finally {
		await unlink(temporary).catch(() => undefined);
	}
}
/** Caller owns the same host writer lease and may only advance its marker. */
export async function completeGoalRetentionClosure(
	hostRoot: string,
	value: GoalRetentionClosure,
): Promise<void> {
	if (closure(value) === null)
		throw new Error("Goal retention closure payload invalid");
	const root = resolve(hostRoot);
	await assertGoalHostWriteLease(root);
	const current = await readGoalRetentionClosure(root);
	if (
		current === "uncertain" ||
		current === null ||
		current.transactionId !== value.transactionId ||
		!((current.state === "prepared" && value.state === "detached") ||
			(current.state === "detached" && value.state === "complete")) ||
		!sameClosureIdentity(current, value)
	)
		throw new Error("Goal retention closure cannot be finalized");
	const temporary = join(root, `.${RETENTION_CLOSURE_NAME}.${value.transactionId}.complete`);
	const target = join(root, RETENTION_CLOSURE_NAME);
	await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
	try {
		const file = await open(temporary, constants.O_RDONLY);
		try { await file.sync(); } finally { await file.close(); }
		await rename(temporary, target);
		await syncDirectory(root);
	} finally {
		await unlink(temporary).catch(() => undefined);
	}
}
function sameClosureIdentity(
	left: GoalRetentionClosure,
	right: GoalRetentionClosure,
): boolean {
	return left.goalId === right.goalId &&
		left.contractHash === right.contractHash &&
		left.ownerId === right.ownerId &&
		left.ownerEpoch === right.ownerEpoch &&
		left.head.seq === right.head.seq &&
		left.head.hash === right.head.hash &&
		left.createdAt === right.createdAt &&
		left.workflowRunIds.length === right.workflowRunIds.length &&
		left.workflowRunIds.every((id, index) => id === right.workflowRunIds[index]);
}
async function assertGoalHostWriteLease(root: string): Promise<void> {
	if (!(await hasCurrentGoalHostWriteLease(root)))
		throw new Error("Goal retention closure requires exact held host writer lease");
}

/**
 * Cross-journal host writer exclusion. Nested writes in the same async call
 * chain reuse an unexported lease. A failure after markWriting retains the
 * lock as ambiguity evidence; it is never swept by PID, time or retry logic.
 */
export async function withGoalHostWriteLock<T>(
	hostRoot: string,
	action: (markWriting: () => void) => Promise<T>,
): Promise<T> {
	const absolute = await realpath(resolve(hostRoot));
	const current = context.getStore();
	if (await hasCurrentGoalHostWriteLease(absolute)) {
		if (!current) throw new Error("Goal host writer context lost");
		return action(current.markWriting);
	}
	if ((await readGoalRetentionClosure(absolute)) !== null)
		throw new Error("Goal host retention-closed or closure state uncertain");
	const path = join(absolute, LOCK_NAME);
	await mkdir(path, { mode: 0o700 });
	await syncDirectory(absolute);
	if ((await readGoalRetentionClosure(absolute)) !== null) {
		await rmdir(path);
		await syncDirectory(absolute);
		throw new Error("Goal host retention-closed or closure state uncertain");
	}
	const rootIdentity = await lstat(absolute);
	const lockIdentity = await lstat(path);
	if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink() ||
		!lockIdentity.isDirectory() || lockIdentity.isSymbolicLink())
		throw new Error("Goal host write lock root changed");
	let clean = true;
	const markWriting = (): void => {
		clean = false;
	};
	const lease = Object.freeze({
		kind: "goal-host-write-lease" as const,
		rootDev: rootIdentity.dev,
		rootIno: rootIdentity.ino,
		lockDev: lockIdentity.dev,
		lockIno: lockIdentity.ino,
	});
	try {
		const leases = new Map(current?.leases ?? []);
		leases.set(absolute, lease);
		const result = await context.run(
			Object.freeze({ leases, markWriting }),
			() => action(markWriting),
		);
		clean = true;
		return result;
	} finally {
		if (clean) {
			if (await matchesLease(absolute, lease)) {
				await rmdir(path);
				await syncDirectory(absolute);
			} else throw new Error("Goal host write lock identity changed before release");
		}
	}
}

/** Acquires every distinct physical host mutex in lexical order. A lease for
 * one root never authorizes writes to a descendant or sibling root. */
export async function withGoalHostWriteLocks<T>(
	hostRoots: readonly string[],
	action: (markWriting: (root: string) => void) => Promise<T>,
): Promise<T> {
	const roots = [...new Set(await Promise.all(hostRoots.map((root) => realpath(resolve(root)))))]
		.sort();
	const acquire = async (
		index: number,
		marks: readonly (() => void)[],
	): Promise<T> => {
		if (index === roots.length)
			return action((root) => {
				const position = roots.indexOf(resolve(root));
				if (position < 0) throw new Error("Goal host write root is not held");
				marks[position]();
			});
		return withGoalHostWriteLock(roots[index], (mark) =>
			acquire(index + 1, [...marks, mark]));
	};
	return acquire(0, []);
}
