import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
	copyFile,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readlink,
	realpath,
	rm,
	symlink,
	writeFile,
	chmod,
	unlink,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { constants } from "node:fs";
import { goalHash } from "./goal-json.js";
import { goalFileContentIdentity, goalWorkspacePathCheck, type GoalFileValue } from "./goal-workspace.js";
import type { GoalWorkspaceHostHandle } from "./goal-workspace-host.js";

/** Producer of a Goal criterion judged by a user-authored command's exit code. */
export const GOAL_COMMAND_VERIFIER_PRODUCER = "command-exit-v1";
export const GOAL_COMMAND_DEFAULT_TIMEOUT_MS = 120_000;
export const GOAL_COMMAND_MAX_TIMEOUT_MS = 600_000;
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const OUTPUT_TAIL_BYTES = 16_384;
/** After exit or timeout, stop waiting for output held open by escaped descendants. */
const OUTPUT_DRAIN_GRACE_MS = 2_000;
const MAX_COPY_FILES = 50_000;
const MAX_COPY_BYTES = 512 * 1024 * 1024;

export interface GoalCommandVerifierConfig {
	readonly argv: readonly string[];
	readonly timeoutMs?: number;
	/** Relative working directory inside the verification copy. */
	readonly cwd?: string;
}

export interface GoalCommandVerification {
	readonly schema: "goal-command-verification-v1";
	readonly argv: readonly string[];
	readonly cwd: string;
	readonly sandbox: "macos-seatbelt";
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly timedOut: boolean;
	readonly durationMs: number;
	readonly stdoutTail: string;
	readonly stderrTail: string;
}

/** Validate an authored command verifier config; returns issue messages. */
export function goalCommandVerifierConfigIssues(value: unknown): string[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return ["must be an object"];
	const config = value as Record<string, unknown>;
	const issues: string[] = [];
	for (const key of Object.keys(config))
		if (!["argv", "timeoutMs", "cwd"].includes(key)) issues.push(`unknown key ${key}`);
	const argv = config.argv;
	if (!Array.isArray(argv) || argv.length < 1 || argv.length > 64 ||
		argv.some(part => typeof part !== "string" || part.length > 4096 || part.includes("\0")) ||
		!(argv[0] as string).trim())
		issues.push("argv must be 1-64 non-empty-first strings without NUL (no shell is used)");
	if (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) ||
		(config.timeoutMs as number) < 1_000 || (config.timeoutMs as number) > GOAL_COMMAND_MAX_TIMEOUT_MS))
		issues.push(`timeoutMs must be an integer between 1000 and ${GOAL_COMMAND_MAX_TIMEOUT_MS}`);
	if (config.cwd !== undefined) {
		try { goalWorkspacePathCheck(config.cwd); }
		catch { issues.push("cwd must be a safe relative path"); }
	}
	return issues;
}

/** The command verifier only runs under the macOS Seatbelt sandbox. */
export function goalCommandSandboxAvailable(): boolean {
	return process.platform === "darwin" && existsSync(SANDBOX_EXEC);
}

function sbplString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Seatbelt profile: writes only inside the verification root and device
 * nodes, no IP networking (local Unix sockets stay available), and no reads
 * of common credential stores. Everything else keeps default access, matching
 * the workspace-write sandboxes of other coding agents.
 */
export function goalCommandSandboxProfile(writableRoot: string, home = homedir()): string {
	const deniedReads = [".ssh", ".aws", ".gnupg", ".config", ".pi", ".gjc", ".docker", ".kube", ".netrc",
		".npmrc", ".pypirc", ".git-credentials", "Library/Keychains"].map(path => join(home, path));
	return [
		"(version 1)",
		"(allow default)",
		"(deny network-outbound (remote ip))",
		"(deny network-inbound (local ip))",
		"(deny network-bind (local ip))",
		`(deny file-read* ${deniedReads.map(path => `(subpath ${sbplString(path)})`).join(" ")})`,
		"(deny file-write*)",
		`(allow file-write* (subpath ${sbplString(writableRoot)}) (literal "/dev/null") (literal "/dev/zero")`,
		'  (regex #"^/dev/fd/") (regex #"^/dev/tty"))',
	].join("\n");
}

async function copyTree(source: string, target: string, budget: { files: number; bytes: number },
	top = true): Promise<void> {
	await mkdir(target, { recursive: true });
	for (const entry of await readdir(source, { withFileTypes: true })) {
		// Repository metadata and workflow run state are not part of the tree under test.
		if (top && (entry.name === ".git" || entry.name === ".pi")) continue;
		const from = join(source, entry.name), to = join(target, entry.name);
		if (entry.name === "node_modules" && entry.isDirectory()) {
			// Dependencies are shared read-only: the sandbox denies writes outside the copy.
			await symlink(from, to);
			continue;
		}
		if (entry.isSymbolicLink()) { await symlink(await readlink(from), to); continue; }
		if (entry.isDirectory()) { await copyTree(from, to, budget, false); continue; }
		if (!entry.isFile()) continue;
		const info = await lstat(from);
		budget.files += 1; budget.bytes += info.size;
		if (budget.files > MAX_COPY_FILES || budget.bytes > MAX_COPY_BYTES)
			throw new Error("Goal command verifier workspace is too large to copy");
		await copyFile(from, to);
		await chmod(to, info.mode & 0o777);
	}
}

async function readCandidateFile(path: string): Promise<{ bytes: Buffer; mode: GoalFileValue["mode"] } | null> {
	const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return null;
		throw error;
	});
	if (!info) return null;
	if (!info.isFile() || info.nlink !== 1) throw new Error("Goal candidate path is not a single-link regular file");
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try { return { bytes: await handle.readFile(), mode: (info.mode & 0o111) ? "0755" : "0644" }; }
	finally { await handle.close(); }
}

/**
 * The overlay is written by the unsandboxed host, so no directory on the way
 * to a candidate path may be a symbolic link (for example the shared
 * node_modules link or a symlinked directory copied from the origin).
 */
async function assertRealDirectoryPath(work: string, relativePath: string): Promise<void> {
	const parts = relativePath.split("/");
	let current = work;
	for (const part of parts.slice(0, -1)) {
		current = join(current, part);
		const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});
		if (!info) return;
		if (!info.isDirectory())
			throw new Error(`Goal candidate path crosses a non-directory in the verification copy: ${relativePath}`);
	}
}

function tail(chunks: Buffer[], total: number): string {
	const all = Buffer.concat(chunks);
	const kept = all.length > OUTPUT_TAIL_BYTES ? all.subarray(all.length - OUTPUT_TAIL_BYTES) : all;
	return (total > kept.length ? "…" : "") + kept.toString("utf8");
}

/**
 * Run a user-authored verification command against a copy of the origin
 * working tree with the current candidate files overlaid. The origin and the
 * candidate workspace are never written. The verdict is the exit code.
 */
export async function runGoalCommandVerifier(input: {
	readonly originRoot: string;
	readonly workspace: GoalWorkspaceHostHandle;
	readonly config: GoalCommandVerifierConfig;
	readonly signal?: AbortSignal;
	/** The candidate observed as the criterion subject; a different candidate is not run. */
	readonly expectedCandidateHash?: string;
}): Promise<GoalCommandVerification> {
	const issues = goalCommandVerifierConfigIssues(input.config);
	if (issues.length) throw new Error(`Goal command verifier config invalid: ${issues.join("; ")}`);
	if (!goalCommandSandboxAvailable())
		throw new Error("Goal command verifier requires the macOS sandbox (sandbox-exec); the command was not run");
	if (!input.workspace.workspaceRoot)
		throw new Error("Goal command verifier requires a candidate workspace");
	input.signal?.throwIfAborted();
	const root = await realpath(await mkdtemp(join(tmpdir(), "goal-verify-")));
	try {
		const work = join(root, "work");
		await copyTree(await realpath(input.originRoot), work, { files: 0, bytes: 0 });
		const candidate = await input.workspace.inspectCandidate();
		if (input.expectedCandidateHash !== undefined && goalHash(candidate) !== input.expectedCandidateHash)
			throw new Error("Goal candidate changed before command verification");
		for (const file of candidate.files) {
			goalWorkspacePathCheck(file.path);
			const target = join(work, ...file.path.split("/"));
			await assertRealDirectoryPath(work, file.path);
			if (file.value === null) { await unlink(target).catch(() => undefined); continue; }
			const loaded = await readCandidateFile(join(input.workspace.workspaceRoot, ...file.path.split("/")));
			if (!loaded || goalHash(goalFileContentIdentity({ kind: "file", links: 1, mode: loaded.mode,
				hex: loaded.bytes.toString("hex") })) !== goalHash(goalFileContentIdentity(file.value)))
				throw new Error(`Goal candidate bytes changed before command verification: ${file.path}`);
			await mkdir(dirname(target), { recursive: true });
			await rm(target, { force: true });
			await writeFile(target, loaded.bytes, { mode: loaded.mode === "0755" ? 0o755 : 0o644 });
		}
		const home = join(root, "home"), temp = join(root, "tmp");
		await mkdir(home); await mkdir(temp);
		const cwd = input.config.cwd ? join(work, ...input.config.cwd.split("/")) : work;
		const timeoutMs = input.config.timeoutMs ?? GOAL_COMMAND_DEFAULT_TIMEOUT_MS;
		const started = Date.now();
		const outcome = await new Promise<{ exitCode: number | null; signal: string | null; timedOut: boolean;
			stdout: string; stderr: string }>((resolve, reject) => {
			const child = spawn(SANDBOX_EXEC, ["-p", goalCommandSandboxProfile(root), ...input.config.argv], {
				cwd, detached: true, stdio: ["ignore", "pipe", "pipe"],
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: temp, LANG: "en_US.UTF-8",
					TERM: "dumb", CI: "1", NO_COLOR: "1" },
			});
			const capture = () => { const chunks: Buffer[] = []; let kept = 0, total = 0;
				return { chunks, add(chunk: Buffer) { total += chunk.length; chunks.push(chunk); kept += chunk.length;
					while (chunks.length > 1 && kept - chunks[0]!.length >= OUTPUT_TAIL_BYTES) kept -= chunks.shift()!.length; },
				get total() { return total; } }; };
			const stdout = capture(), stderr = capture();
			child.stdout!.on("data", chunk => stdout.add(chunk));
			child.stderr!.on("data", chunk => stderr.add(chunk));
			let timedOut = false, drain: NodeJS.Timeout | undefined;
			const killGroup = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already exited */ } };
			// A descendant that left the process group can hold the output pipes
			// open; stop reading after a short grace so the verdict is not delayed.
			const drainSoon = () => { drain ??= setTimeout(() => {
				child.stdout!.destroy(); child.stderr!.destroy(); }, OUTPUT_DRAIN_GRACE_MS); };
			const timer = setTimeout(() => { timedOut = true; killGroup(); drainSoon(); }, timeoutMs);
			const onAbort = () => { killGroup(); drainSoon(); };
			input.signal?.addEventListener("abort", onAbort, { once: true });
			child.once("error", error => { clearTimeout(timer); clearTimeout(drain);
				input.signal?.removeEventListener("abort", onAbort); reject(error); });
			child.once("exit", () => { killGroup(); drainSoon(); });
			child.once("close", (exitCode, signal) => {
				clearTimeout(timer); clearTimeout(drain); input.signal?.removeEventListener("abort", onAbort);
				killGroup();
				resolve({ exitCode, signal, timedOut, stdout: tail(stdout.chunks, stdout.total), stderr: tail(stderr.chunks, stderr.total) });
			});
		});
		input.signal?.throwIfAborted();
		return Object.freeze({
			schema: "goal-command-verification-v1" as const,
			argv: Object.freeze([...input.config.argv]),
			cwd: input.config.cwd ?? ".",
			sandbox: "macos-seatbelt" as const,
			exitCode: outcome.exitCode, signal: outcome.signal, timedOut: outcome.timedOut,
			durationMs: Date.now() - started,
			stdoutTail: outcome.stdout, stderrTail: outcome.stderr,
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

/** A command criterion is met only by a clean zero exit within the time limit. */
export function goalCommandVerdict(verification: GoalCommandVerification): "met" | "not-met" {
	return verification.exitCode === 0 && verification.signal === null && !verification.timedOut ? "met" : "not-met";
}

export function isGoalCommandVerification(value: unknown): value is GoalCommandVerification {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const v = value as Record<string, unknown>;
	return v.schema === "goal-command-verification-v1" && Array.isArray(v.argv) &&
		v.argv.every(part => typeof part === "string") && typeof v.cwd === "string" && v.sandbox === "macos-seatbelt" &&
		(v.exitCode === null || Number.isSafeInteger(v.exitCode)) && (v.signal === null || typeof v.signal === "string") &&
		typeof v.timedOut === "boolean" && Number.isSafeInteger(v.durationMs) &&
		typeof v.stdoutTail === "string" && typeof v.stderrTail === "string";
}
