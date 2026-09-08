import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	assertSafeRunId,
	isMockRunProvenance,
	writeJsonAtomic,
} from "./store.js";
import { assertWorkflowActionAllowedForRole } from "./process-role.js";
import type { WorkflowRunRecord } from "./types.js";

const SIDECAR = "notice-acknowledgements.json";
const SCHEMA = "workflow-notice-acknowledgements-v1";
const LOCK_WAIT_MS = 5_000;
type NoticeStatus = "failed" | "interrupted" | "blocked";
interface ObservedNotice {
	runId: string;
	status: NoticeStatus;
	updatedAt: string;
	sha256: string;
}
interface Acknowledgement extends ObservedNotice {
	reason: string;
	acknowledgedAt: string;
}
export interface NoticeAcknowledgements {
	schema: typeof SCHEMA;
	acknowledgements: Acknowledgement[];
}

function exactRunId(value: unknown): asserts value is string {
	assertSafeRunId(value as string);
	if (
		typeof value !== "string" ||
		!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(value)
	)
		throw new Error(
			"Notices require an exact, safe run id (no paths or prefixes).",
		);
}
function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validDate(value: unknown): value is string {
	return (
		typeof value === "string" &&
		Number.isFinite(Date.parse(value)) &&
		new Date(value).toISOString() === value
	);
}
function validHash(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function validReason(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.trim().length > 0 &&
		value.length <= 2_000 &&
		!/[\x00-\x1f\x7f]/.test(value)
	);
}
function noticeStatus(value: unknown): value is NoticeStatus {
	return value === "failed" || value === "interrupted" || value === "blocked";
}
function hash(bytes: string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

// Canonicalize the caller-owned cwd, but never follow application-owned links.
async function noticeRoot(cwd: string): Promise<string> {
	const base = await realpath(cwd);
	const root = join(base, ".pi", "workflows");
	for (const path of [join(base, ".pi"), root]) {
		const info = await lstat(path);
		if (
			!info.isDirectory() ||
			info.isSymbolicLink() ||
			(await realpath(path)) !== resolve(path)
		)
			throw new Error("Unsafe workflow notices root.");
	}
	return root;
}

async function readRegular(file: string): Promise<string> {
	const handle = await open(
		file,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.nlink !== 1)
			throw new Error("Unsafe workflow notices file.");
		// Reject invalid UTF-8 rather than hash a lossy replacement-character view.
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
			await handle.readFile(),
		);
	} finally {
		await handle.close();
	}
}
async function sidecarBytes(root: string): Promise<string | undefined> {
	try {
		return await readRegular(join(root, SIDECAR));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}
function parseNoticeJson(bytes: string): unknown {
	try {
		return JSON.parse(bytes);
	} catch {
		throw new Error("Invalid workflow notice JSON; preserved without changes.");
	}
}
function parseSidecar(bytes: string | undefined): NoticeAcknowledgements {
	if (bytes === undefined) return { schema: SCHEMA, acknowledgements: [] };
	const value = parseNoticeJson(bytes);
	if (
		!object(value) ||
		value.schema !== SCHEMA ||
		!Array.isArray(value.acknowledgements) ||
		Object.keys(value).some(
			(key) => !["schema", "acknowledgements"].includes(key),
		)
	)
		throw new Error(
			"Invalid notice acknowledgement sidecar; preserved without changes.",
		);
	const seen = new Set<string>();
	const acknowledgements: Acknowledgement[] = [];
	for (const entry of value.acknowledgements) {
		if (!object(entry)) throw new Error("Invalid notice acknowledgement entry.");
		exactRunId(entry.runId);
		if (
			seen.has(entry.runId) ||
			!noticeStatus(entry.status) ||
			!validDate(entry.updatedAt) ||
			!validHash(entry.sha256) ||
			!validDate(entry.acknowledgedAt) ||
			!validReason(entry.reason) ||
			Object.keys(entry).some(
				(key) =>
					![
						"runId",
						"status",
						"updatedAt",
						"sha256",
						"reason",
						"acknowledgedAt",
					].includes(key),
			)
		)
			throw new Error(
				"Invalid notice acknowledgement entry; preserved without changes.",
			);
		seen.add(entry.runId);
		acknowledgements.push({
			runId: entry.runId,
			status: entry.status,
			updatedAt: entry.updatedAt,
			sha256: entry.sha256,
			reason: entry.reason,
			acknowledgedAt: entry.acknowledgedAt,
		});
	}
	return { schema: SCHEMA, acknowledgements };
}

async function observe(root: string, runId: string): Promise<ObservedNotice> {
	exactRunId(runId);
	const dir = join(root, runId);
	const info = await lstat(dir);
	if (
		!info.isDirectory() ||
		info.isSymbolicLink() ||
		(await realpath(dir)) !== dir
	)
		throw new Error("Unsafe workflow run directory.");
	const bytes = await readRegular(join(dir, "run.json"));
	const run = parseNoticeJson(bytes);
	if (
		!object(run) ||
		run.runId !== runId ||
		!noticeStatus(run.status) ||
		!validDate(run.updatedAt) ||
		!Array.isArray(run.tasks) ||
		isMockRunProvenance(run.provenance as WorkflowRunRecord["provenance"])
	)
		throw new Error("Run is not an eligible unfinished notice.");
	const eligible =
		run.status === "blocked"
			? run.tasks.some(
					(task) =>
						object(task) &&
						task.status === "blocked" &&
						(task.statusDetail === "dynamic_ui_unavailable" ||
							task.statusDetail === "dynamic_approval_timeout"),
				)
			: !run.parentRunId;
	if (!eligible) throw new Error("Run is not an eligible unfinished notice.");
	return {
		runId,
		status: run.status,
		updatedAt: run.updatedAt,
		sha256: hash(bytes),
	};
}

/** Invalid data is deliberately not usable by the notifier. Mutations use the strict reader. */
export async function readNoticeAcknowledgements(
	cwd: string,
): Promise<NoticeAcknowledgements> {
	return parseSidecar(await sidecarBytes(await noticeRoot(cwd)));
}

/** Compare both the indexed state and exact run.json bytes; never grants runtime authority. */
export async function noticeAcknowledgementMatch(
	cwd: string,
	state: NoticeAcknowledgements,
	run: { runId: string; status: string; updatedAt?: string },
): Promise<"none" | "acknowledged" | "changed"> {
	const entry = state.acknowledgements.find((item) => item.runId === run.runId);
	if (!entry) return "none";
	try {
		const current = await observe(await noticeRoot(cwd), run.runId);
		return current.sha256 === entry.sha256 &&
			current.status === entry.status &&
			current.updatedAt === entry.updatedAt &&
			run.status === entry.status &&
			run.updatedAt === entry.updatedAt
			? "acknowledged"
			: "changed";
	} catch {
		return "changed";
	}
}

async function listNotices(cwd: string) {
	let root: string;
	try {
		root = await noticeRoot(cwd);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { notices: [], acknowledgements: [], warnings: [] };
		throw error;
	}
	const state = parseSidecar(await sidecarBytes(root));
	const notices: ObservedNotice[] = [];
	const warnings: string[] = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		try {
			notices.push(await observe(root, entry.name));
		} catch (error) {
			// Ineligible runs are ordinary history, not list failures.
			if (
				!(
					error instanceof Error &&
					error.message === "Run is not an eligible unfinished notice."
				)
			)
				warnings.push(
					`${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
				);
		}
	}
	notices.sort((a, b) => a.runId.localeCompare(b.runId));
	return {
		notices,
		acknowledgements: state.acknowledgements.map((entry) => ({
			...entry,
			active: notices.some(
				(run) =>
					run.runId === entry.runId &&
					run.status === entry.status &&
					run.updatedAt === entry.updatedAt &&
					run.sha256 === entry.sha256,
			),
		})),
		warnings,
	};
}

// Dedicated bounded exclusive lock: never reclaim/delete unknown or crashed-owner evidence.
async function withNoticeLock<T>(
	cwd: string,
	action: (root: string, assertOwner: () => Promise<void>) => Promise<T>,
): Promise<T> {
	const root = await noticeRoot(cwd);
	const rootInfo = await lstat(root);
	const file = join(root, `${SIDECAR}.lock`);
	const deadline = Date.now() + LOCK_WAIT_MS;
	let handle;
	while (!handle) {
		if ((await noticeRoot(cwd)) !== root)
			throw new Error("Workflow notices root changed.");
		try {
			handle = await open(file, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const info = await lstat(file).catch((statError: NodeJS.ErrnoException) => {
				if (statError.code === "ENOENT") return undefined; // Owner just released it.
				throw statError;
			});
			// lstat can observe the releasing owner's already-unlinked regular inode
			// (nlink=0). This is only a wait observation, never lock ownership/reclamation.
			if (
				info &&
				(!info.isFile() ||
					info.isSymbolicLink() ||
					(info.nlink !== 0 && info.nlink !== 1))
			)
				throw new Error("Unsafe notices lock.");
			if (Date.now() >= deadline)
				throw new Error(
					"Notices lock busy; retry later. An abandoned lock requires manual inspection.",
				);
			await new Promise((done) => setTimeout(done, 20));
		}
	}
	const identity = await handle.stat();
	const assertOwner = async () => {
		if ((await noticeRoot(cwd)) !== root)
			throw new Error("Workflow notices root changed.");
		const current = await lstat(root);
		const lock = await lstat(file);
		if (
			current.dev !== rootInfo.dev ||
			current.ino !== rootInfo.ino ||
			lock.dev !== identity.dev ||
			lock.ino !== identity.ino ||
			lock.isSymbolicLink() ||
			lock.nlink !== 1
		)
			throw new Error("Workflow notices lock or root changed.");
	};
	try {
		await handle.writeFile(`${JSON.stringify({ pid: process.pid })}\n`);
		await assertOwner();
		return await action(root, assertOwner);
	} finally {
		await handle.close();
		if ((await noticeRoot(cwd)) === root) {
			const current = await lstat(file);
			if (
				current.dev === identity.dev &&
				current.ino === identity.ino &&
				!current.isSymbolicLink()
			)
				await unlink(file);
		}
	}
}

type NoticesCommand =
	| { action: "list"; json: boolean }
	| { action: "clear"; runId: string; json: boolean }
	| {
			action: "acknowledge";
			runId: string;
			sha256: string;
			reason: string;
			json: boolean;
	  };
const USAGE =
	"notices list [--json] | notices acknowledge <exact-run-id> --state <sha256> --reason <text> | notices clear <exact-run-id> [--json]";

export function parseWorkflowNoticesArgs(argv: string[]): NoticesCommand {
	const args = [...argv];
	const action = args.shift() ?? "list";
	if (
		action === "list" &&
		(args.length === 0 || (args.length === 1 && args[0] === "--json"))
	)
		return { action, json: args.length === 1 };
	const runId = args.shift();
	exactRunId(runId);
	if (
		action === "clear" &&
		(args.length === 0 || (args.length === 1 && args[0] === "--json"))
	)
		return { action, runId, json: args.length === 1 };
	if (
		action === "acknowledge" &&
		args[0] === "--state" &&
		validHash(args[1]) &&
		args[2] === "--reason"
	) {
		const reason = args.slice(3).join(" ").trim();
		if (validReason(reason))
			return { action, runId, sha256: args[1], reason, json: false };
	}
	throw new Error(`Usage: ${USAGE}`);
}

/** Shared slash/standalone boundary. Does not load the engine or start a supervisor. */
export async function executeWorkflowNoticesCommand(
	cwd: string,
	argv: string[],
): Promise<string> {
	assertWorkflowActionAllowedForRole("notices");
	const command = parseWorkflowNoticesArgs(argv);
	if (command.action === "list") {
		const result = await listNotices(cwd);
		if (command.json) return JSON.stringify(result, null, 2);
		return [
			"Workflow notices (notification-only; run history and resume authority unchanged):",
			...result.notices.map(
				(run) =>
					`${run.runId} ${run.status} ${run.updatedAt} --state ${run.sha256}`,
			),
			...result.acknowledgements.map(
				(entry) =>
					`acknowledged ${entry.runId} (${entry.active ? "active" : "stale"}): ${entry.reason}`,
			),
			...result.warnings.map((warning) => `warning: ${warning}`),
			...(result.notices.length === 0 && result.acknowledgements.length === 0
				? ["No eligible notices or acknowledgements."]
				: []),
		].join("\n");
	}
	return withNoticeLock(cwd, async (root, assertOwner) => {
		const previous = await sidecarBytes(root);
		const state = parseSidecar(previous);
		const observed =
			command.action === "acknowledge"
				? await observe(root, command.runId)
				: undefined;
		if (
			observed &&
			command.action === "acknowledge" &&
			observed.sha256 !== command.sha256
		)
			throw new Error(
				"Run state changed; list notices again before acknowledging.",
			);
		const entries = state.acknowledgements.filter(
			(entry) => entry.runId !== command.runId,
		);
		if (observed && command.action === "acknowledge")
			entries.push({
				...observed,
				reason: command.reason,
				acknowledgedAt: new Date().toISOString(),
			});
		if (previous !== undefined || entries.length > 0) {
			await writeJsonAtomic(
				join(root, SIDECAR),
				{ schema: SCHEMA, acknowledgements: entries },
				undefined,
				async () => {
					await assertOwner();
					if ((await sidecarBytes(root)) !== previous)
						throw new Error(
							"Notice sidecar changed concurrently; preserved without changes.",
						);
					if (
						observed &&
						(await observe(root, command.runId)).sha256 !== observed.sha256
					)
						throw new Error(
							"Run state changed; list notices again before acknowledging.",
						);
				},
			);
		}
		const result = {
			action: command.action,
			runId: command.runId,
			notificationOnly: true,
		};
		return command.json
			? JSON.stringify(result, null, 2)
			: `${command.action === "clear" ? "Cleared acknowledgement for" : "Acknowledged notice for"} ${command.runId}. Run history and resume authority unchanged.`;
	});
}
