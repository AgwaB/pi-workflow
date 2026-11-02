import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID, type Hash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
	lstat,
	link,
	mkdir,
	open,
	readdir,
	realpath,
	rename,
	rmdir,
	rm,
	unlink,
	type FileHandle,
} from "node:fs/promises";
import { devNull } from "node:os";
import { promisify } from "node:util";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";

import { frozen, goalHash } from "./goal-json.js";
import {
	initialGoalCandidate,
	parseGoalWorkspaceBaseline,
	parseGoalWorkspaceCandidate,
	type GoalFileBytes,
	type GoalFileArtifact,
	type GoalFileValue,
	type GoalOriginObservation,
	type GoalWorkspaceBaseline,
	type GoalWorkspaceCandidate,
} from "./goal-workspace.js";
import {
	captureCommittedArtifactReadRoot,
	readCommittedArtifactPage,
	type CommittedArtifactRootIdentity,
} from "./committed-artifact-read.js";

const execFileAsync = promisify(execFile);
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;
const MAX_FILE_BYTES = 8_192;
const MAX_INDEX_BYTES = 64 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_GIT_COMMAND_MS = 30_000;
const SAFE_GIT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin";
const HANDLES = new WeakSet<object>();

interface PhysicalIdentity {
	path: string;
	dev: number;
	ino: number;
	size?: number;
	mtimeMs?: number;
	ctimeMs?: number;
	mode?: number;
	nlink?: number;
}

interface ProtectedObservation {
	path: string;
	value: GoalFileValue | null;
}

export interface GoalWorkspaceHostRequest {
	/** Trusted host-selected physical root. Never a child cwd fallback. */
	originRoot: string;
	/** Dedicated, initially absent path. Required only for mutation mode. */
	workspaceRoot?: string;
	workspaceId: string;
	mode: "read-only" | "mutation";
	repository: "git" | "nonGit";
	/** Complete sorted bounded input/change manifest, including absent paths. */
	scope: readonly string[];
	protectedPaths?: readonly string[];
	/** Host control roots which must not overlap the dedicated workspace. */
	controlRoots?: readonly string[];
	/** Trusted, initially absent, run-owned private evidence directory. */
	artifactRoot: string;
}

export interface GoalWorkspaceCleanupResult {
	status: "removed" | "not-created" | "retained";
	reason?: string;
}

/** Process-local restriction on an already scoped host handle, not an issuer.
 * Kept separate from serialized requests and digests. Missing guards deny writes.
 * assertCurrent checks original durable authority; assertLive synchronously
 * fences revocation across its awaits. A failed check permanently fences writes.
 */
export interface GoalWorkspaceWriteGuard {
	assertCurrent(): void | Promise<void>;
	assertLive(): void;
}

/**
 * Nonserializable host-owned handle. Serialized paths, baselines, candidates,
 * and digests are evidence only and cannot reconstruct this authority.
 */
export interface GoalWorkspaceHostHandle {
	readonly baseline: GoalWorkspaceBaseline;
	readonly workspaceRoot: string | null;
	readonly sourceCatalog: { readonly digest: string; readonly files: number; readonly bytes: number };
	inspectCandidate(): Promise<GoalWorkspaceCandidate>;
	readSourcePage(path: string, cursor?: string): Promise<GoalSourcePage>;
	writeCandidate(
		path: string,
		expectedDigest: string,
		content: string,
	): Promise<GoalWorkspaceCandidate>;
	beginCandidateReplacement(input: GoalCandidateReplacementBegin): Promise<GoalCandidateReplacementReceipt>;
	appendCandidateReplacement(input: GoalCandidateReplacementAppend): Promise<GoalCandidateReplacementReceipt>;
	commitCandidateReplacement(input: GoalCandidateReplacementCommit): Promise<GoalWorkspaceCandidate>;
	cleanup(): Promise<GoalWorkspaceCleanupResult>;
}

export interface GoalCandidateReplacementBegin {
	readonly path: string; readonly expectedDigest: string; readonly attemptKey: string;
	readonly operationId: string; readonly bytes: number; readonly sha256?: string;
}
export interface GoalCandidateReplacementAppend {
	readonly path: string; readonly uploadId: string; readonly attemptKey: string;
	readonly operationId: string; readonly offset: number; readonly hex: string;
}
export interface GoalCandidateReplacementCommit {
	readonly path: string; readonly uploadId: string; readonly attemptKey: string;
	readonly operationId: string;
}
export interface GoalCandidateReplacementReceipt {
	readonly uploadId: string; readonly receivedBytes: number;
}

export interface GoalSourcePage {
	readonly status: "ok";
	readonly path: string;
	readonly artifact: GoalFileArtifact;
	readonly page: {
		readonly encoding: "utf8" | "base64";
		readonly content: string;
		readonly returnedBytes: number;
		readonly returnedLines: number;
		readonly nextCursor: string | null;
		readonly eof: boolean;
	};
}

interface PreparedConfiguration {
	workspaceId: string;
	mode: "read-only" | "mutation";
	repository: "git" | "nonGit";
	scope: string[];
	protectedPaths: string[];
}

interface GitObservation {
	observation: GoalOriginObservation;
	headOid: string;
	indexIdentity: PhysicalIdentity;
}

interface MutationWorkspaceState {
	root: string;
	identity: PhysicalIdentity;
	git?: {
		controlIdentity: PhysicalIdentity;
		controlDigest: string;
		indexIdentity: PhysicalIdentity;
		indexDigest: string;
	};
}

/** Complete source evidence only: no publication, candidate, catalog, or read
 * capability is created. Cold inspection and pre-consent comparison must not
 * manufacture a workspace owner merely to observe an origin's current bytes. */
export async function observeGoalWorkspaceOrigin(
	request: Pick<GoalWorkspaceHostRequest, "originRoot" | "repository" | "scope" | "protectedPaths" | "controlRoots">,
): Promise<GoalOriginObservation> {
	if (process.platform === "win32" || NOFOLLOW === 0)
		throw new Error("Goal workspace secure no-follow observation is unavailable");
	const configuration = validateConfiguration({
		...request, workspaceId: "origin-observation", mode: "read-only",
	});
	const originRoot = await canonicalExistingDirectory(request.originRoot, "origin");
	const originIdentity = await directoryIdentity(originRoot);
	const controlRoots = await Promise.all((request.controlRoots ?? []).map(root =>
		canonicalExistingDirectory(root, "control root")));
	for (const path of [...configuration.scope, ...configuration.protectedPaths]) {
		const physical = resolve(originRoot, ...path.split("/"));
		if (controlRoots.some(root => pathsOverlap(physical, root)))
			throw new Error(`Goal manifest overlaps a host control root: ${path}`);
	}
	const protectedObservation = await observeProtectedPaths(originRoot, configuration.protectedPaths);
	let git: GitObservation | undefined;
	let origin: GoalOriginObservation;
	if (configuration.repository === "git") {
		git = await observeGitOrigin(originRoot, originIdentity, configuration.scope);
		origin = git.observation;
	} else {
		await assertNotGitRoot(originRoot);
		origin = await observeNonGitOrigin(originRoot, originIdentity, configuration.scope);
	}
	await assertOriginUnchanged(originRoot, originIdentity, configuration, origin, git, protectedObservation);
	return frozen(parseGoalWorkspaceBaseline({
		schemaVersion: 1, workspaceId: configuration.workspaceId, mode: configuration.mode,
		scope: configuration.scope, protectedPaths: configuration.protectedPaths,
		inputManifest: configuration.scope, origin,
	}).origin);
}

/**
 * Trusted-host constructor. It accepts only policy plus physical roots and
 * performs every live observation itself; it never accepts a JSON baseline,
 * candidate, Git digest, or physical identity as provenance.
 *
 * Portable Node descriptor/path checks here reject stable aliases and catch
 * observed replacement. They are not an OS sandbox or an atomic guarantee
 * against a hostile same-user writer.
 */
export async function prepareGoalWorkspaceHost(
	request: GoalWorkspaceHostRequest,
	writeGuard?: GoalWorkspaceWriteGuard,
): Promise<GoalWorkspaceHostHandle> {
	const current = writeGuard?.assertCurrent.bind(writeGuard);
	const live = writeGuard?.assertLive.bind(writeGuard);
	let writeRevoked = false;
	const assertWriteLive = (): void => {
		if (!current || !live || writeRevoked)
			throw new Error("Goal workspace candidate write guard unavailable or revoked");
		try {
			live();
		} catch (error) {
			writeRevoked = true;
			throw error;
		}
	};
	const assertWriteCurrent = async (): Promise<void> => {
		if (!current || !live || writeRevoked)
			throw new Error("Goal workspace candidate write guard unavailable or revoked");
		try {
			live();
			await current();
			live();
		} catch (error) {
			writeRevoked = true;
			throw error;
		}
	};
	if (process.platform === "win32" || constants.O_NOFOLLOW === undefined) {
		throw new Error("Goal workspace secure no-follow observation is unavailable");
	}
	const configuration = validateConfiguration(request);
	let assertArtifactCurrent: (() => Promise<void>) | undefined;
	const assertPreparationCurrent = async (): Promise<void> => {
		// Publication captures original bytes even for a read-only candidate.
		// The prepared owner, rather than a future execution release, authorizes it.
		await assertWriteCurrent();
		await assertArtifactCurrent?.();
		assertWriteLive();
	};
	await assertPreparationCurrent();
	const originRoot = await canonicalExistingDirectory(
		request.originRoot,
		"origin",
	);
	await assertPreparationCurrent();
	const originIdentity = await directoryIdentity(originRoot);
	await assertPreparationCurrent();
	const controlRoots = await Promise.all(
		(request.controlRoots ?? []).map((root) =>
			canonicalExistingDirectory(root, "control root"),
		),
	);
	await assertPreparationCurrent();
	const requestedArtifactRoot = resolve(request.artifactRoot);
	const requestedWorkspaceRoot = request.workspaceRoot ? resolve(request.workspaceRoot) : null;
	for (const path of [...configuration.scope, ...configuration.protectedPaths]) {
		const physical = resolve(originRoot, ...path.split("/"));
		if (pathsOverlap(requestedArtifactRoot, physical))
			throw new Error(`Goal artifact root overlaps an origin input: ${path}`);
	}
	if (requestedWorkspaceRoot && pathsOverlap(requestedArtifactRoot, requestedWorkspaceRoot))
		throw new Error("Goal artifact root overlaps the candidate workspace");
	if (pathsOverlap(requestedArtifactRoot, originRoot) &&
		!controlRoots.some((root) => {
			const rel = relative(root, requestedArtifactRoot);
			return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
		}))
		throw new Error("Goal artifact root inside origin requires a host control root");
	for (const path of [...configuration.scope, ...configuration.protectedPaths]) {
		const physical = resolve(originRoot, ...path.split("/"));
		if (controlRoots.some((root) => pathsOverlap(physical, root))) {
			throw new Error(`Goal manifest overlaps a host control root: ${path}`);
		}
	}
	const preparedArtifactRoot = await prepareArtifactRoot(request.artifactRoot, assertWriteCurrent, assertWriteLive);
	const artifactRoot = preparedArtifactRoot.identity.root;
	const artifactIdentity = preparedArtifactRoot.identity;
	assertArtifactCurrent = preparedArtifactRoot.assertCurrent;
	await assertPreparationCurrent();
	await mkdir(join(artifactRoot, "source"), { mode: 0o700 });
	await assertPreparationCurrent();
	await mkdir(join(artifactRoot, "uploads"), { mode: 0o700 });
	await assertPreparationCurrent();
	const uploadDirectoryIdentity = await directoryIdentity(join(artifactRoot, "uploads"));
	await assertPreparationCurrent();

	const protectedObservation = await observeProtectedPaths(
		originRoot,
		configuration.protectedPaths,
	);
	await assertPreparationCurrent();
	let git: GitObservation | undefined;
	let origin: GoalOriginObservation;
	if (configuration.repository === "git") {
		git = await observeGitOrigin(originRoot, originIdentity, configuration.scope, artifactRoot);
		await assertPreparationCurrent();
		origin = git.observation;
	} else {
		await assertNotGitRoot(originRoot);
		await assertPreparationCurrent();
		origin = await observeNonGitOrigin(
			originRoot,
			originIdentity,
			configuration.scope,
			artifactRoot,
		);
		await assertPreparationCurrent();
	}
	const baseline = frozen(
		parseGoalWorkspaceBaseline({
			schemaVersion: 1,
			workspaceId: configuration.workspaceId,
			mode: configuration.mode,
			scope: configuration.scope,
			protectedPaths: configuration.protectedPaths,
			inputManifest: configuration.scope,
			origin,
		}),
	);
	const committedArtifactRoot = await captureCommittedArtifactReadRoot(
		artifactIdentity, "Goal source artifact root",
	);
	await assertPreparationCurrent();
	const sourceArtifacts = new Map<string, GoalFileArtifact>();
	for (const file of baseline.origin.files) {
		for (const value of [file.head, file.index, file.worktree])
			if (value?.kind === "artifact") sourceArtifacts.set(value.locator, value);
	}
	const sourceCatalog = Object.freeze({
		digest: goalHash([...sourceArtifacts.entries()].sort(([left], [right]) => left.localeCompare(right))),
		files: sourceArtifacts.size,
		bytes: [...sourceArtifacts.values()].reduce((sum, value) => sum + value.bytes, 0),
	});
	const materializeArtifact = async (value: GoalFileArtifact, target: FileHandle): Promise<void> => {
		const retained = sourceArtifacts.get(value.locator);
		if (retained !== value)
			throw new Error("Goal materialization requires an original source catalog entry");
		let offset = 0;
		for (;;) {
			await assertPreparationCurrent();
			const page = await readCommittedArtifactPage({
				path: join(artifactRoot, retained.locator), containmentRoot: committedArtifactRoot,
				expectedSha256: retained.sha256, expectedLength: retained.bytes,
				offset, maximumBytes: 4096, label: "Goal source materialization",
			});
			await assertPreparationCurrent();
			if (page.bytes.length === 0 && !page.eof)
				throw new Error("Goal source materialization failed to advance");
			let written = 0;
			while (written < page.bytes.length) {
				await assertPreparationCurrent();
				const result = await target.write(page.bytes, written, page.bytes.length - written, null);
				await assertPreparationCurrent();
				if (result.bytesWritten <= 0)
					throw new Error("Goal source materialization write failed to advance");
				written += result.bytesWritten;
			}
			offset += page.bytes.length;
			if (page.eof) {
				if (offset !== retained.bytes)
					throw new Error("Goal source materialization byte census changed");
				break;
			}
		}
	};

	let mutation: MutationWorkspaceState | null = null;
	if (configuration.mode === "mutation") {
		if (!request.workspaceRoot)
			throw new Error("Goal mutation requires a dedicated workspace root");
		const root = await prepareAbsentWorkspacePath(request.workspaceRoot, assertWriteCurrent);
		await assertWriteCurrent();
		if (pathsOverlap(root, originRoot))
			throw new Error("Goal workspace must be physically separate from origin");
		if (controlRoots.some((controlRoot) => pathsOverlap(root, controlRoot)))
			throw new Error("Goal workspace overlaps a host control root");

		if (configuration.repository === "git") {
			if (!git) throw new Error("Goal internal Git observation is unavailable");
			await assertWriteCurrent();
			assertWriteLive();
			await gitCommand(originRoot, [
				"worktree",
				"add",
				"--detach",
				"--no-checkout",
				root,
				git.headOid,
			]);
			await assertWriteCurrent();
			const identity = await directoryIdentity(root);
			await assertWriteCurrent();
			const control = await hashStableFile(join(root, ".git"), 64 * 1024, false);
			await assertWriteCurrent();
			assertWriteLive();
			await gitCommand(root, ["read-tree", git.headOid]);
			await assertWriteCurrent();
			await materializeValues(
				root,
				baseline.origin.files.map(({ path, head }) => ({ path, value: head })),
				assertWriteCurrent,
				assertWriteLive,
				materializeArtifact,
			);
			await assertWriteCurrent();
			// Deliberate second phase: exact immutable HEAD baseline, then the
			// source checkout's scoped staged/unstaged/untracked working bytes.
			await materializeValues(
				root,
				baseline.origin.files.map(({ path, worktree }) => ({
					path,
					value: worktree,
				})),
				assertWriteCurrent,
				assertWriteLive,
				materializeArtifact,
			);
			await assertWriteCurrent();
			const workspaceIndex = await inspectGitIndex(root);
			await assertWriteCurrent();
			mutation = {
				root,
				identity,
				git: {
					controlIdentity: control.identity,
					controlDigest: control.digest,
					indexIdentity: workspaceIndex.identity,
					indexDigest: workspaceIndex.digest,
				},
			};
		} else {
			await assertWriteCurrent();
			assertWriteLive();
			await mkdir(root, { mode: 0o700 });
			await assertWriteCurrent();
			const identity = await directoryIdentity(root);
			await assertWriteCurrent();
			await materializeValues(
				root,
				baseline.origin.files.map(({ path, worktree }) => ({
					path,
					value: worktree,
				})),
				assertWriteCurrent,
				assertWriteLive,
				materializeArtifact,
			);
			await assertWriteCurrent();
			mutation = { root, identity };
		}
		await assertExactWorkspaceCensus(
			mutation.root,
			baseline.scope,
			Boolean(mutation.git),
		);
		await assertWriteCurrent();
	}
	const workspaceRoot = mutation?.root ?? null;

	await assertOriginUnchanged(
		originRoot,
		originIdentity,
		configuration,
		origin,
		git,
		protectedObservation,
	);
	await assertPreparationCurrent();

	let cleaned = false;
	const candidateArtifacts = new Map<string, GoalFileArtifact>();
	const artifactKey = (path: string, value: GoalFileArtifact) =>
		goalHash({ path, fingerprint: sourceFingerprint(value) });
	for (const file of baseline.origin.files) {
		for (const value of [file.head, file.index, file.worktree])
			if (value?.kind === "artifact") candidateArtifacts.set(artifactKey(file.path, value), value);
	}
	const sourceCursors = new Map<string, {
		path: string; locator: string; digest: string; offset: number;
	}>();
	const uploads = new Map<string, {
		path: string; expectedDigest: string; attemptKey: string; operationId: string;
		bytes: number; sha256: string | undefined; receivedBytes: number; file: string; mode: "0644" | "0755";
		contentHash: Hash;
		version: Stats;
		chunks: Map<string, { fingerprint: string; receivedBytes: number }>;
		failed: boolean;
		committed?: { operationId: string; candidate: GoalWorkspaceCandidate };
	}>();
	const assertUploadStorage = async () => {
		await assertPreparationCurrent();
		await assertDirectoryIdentity(uploadDirectoryIdentity);
		await assertPreparationCurrent();
	};
	const assertUploadFile = async (
		upload: NonNullable<ReturnType<typeof uploads.get>>,
		file?: FileHandle,
		expectedBytes = upload.receivedBytes,
		checkVersion = true,
	) => {
		await assertUploadStorage();
		const named = await lstat(upload.file);
		const held = file ? await file.stat() : named;
		for (const info of [named, held]) {
			if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o7777) !== 0o600 ||
				info.dev !== upload.version.dev || info.ino !== upload.version.ino ||
				info.size !== expectedBytes ||
				(checkVersion && (info.mtimeMs !== upload.version.mtimeMs || info.ctimeMs !== upload.version.ctimeMs)))
				throw new Error("Goal candidate upload physical identity or version changed");
		}
		await assertUploadStorage();
		return held;
	};
	let operationQueue = Promise.resolve();
	const enqueueSerialized = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = operationQueue.then(operation, operation);
		operationQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};
	const inspectCandidateNow = async (): Promise<GoalWorkspaceCandidate> => {
		if (cleaned) throw new Error("Goal workspace was already cleaned");
		await assertOriginUnchanged(
			originRoot,
			originIdentity,
			configuration,
			origin,
			git,
			protectedObservation,
		);
		if (mutation === null) return initialGoalCandidate(baseline);
		await assertDirectoryIdentity(mutation.identity);
		if (mutation.git) {
			await assertStableFile(
				join(mutation.root, ".git"),
				mutation.git.controlIdentity,
				mutation.git.controlDigest,
				64 * 1024,
			);
			await assertGitIndexUnchanged(
				mutation.root,
				mutation.git.indexIdentity,
				mutation.git.indexDigest,
			);
		}
		await assertExactWorkspaceCensus(
			mutation.root,
			baseline.scope,
			Boolean(mutation.git),
		);
		const files = await Promise.all(baseline.scope.map(async (path) => {
			const observed = await observeManifestFile(mutation.root, path);
			if (observed?.kind !== "artifact") return { path, value: observed };
			let retained = candidateArtifacts.get(artifactKey(path, observed));
			if (!retained) {
				await assertWriteCurrent();
				const captured = await observeManifestFile(
					mutation.root, path, artifactRoot, `candidate-${randomUUID()}`,
				);
				await assertWriteCurrent();
				if (captured?.kind !== "artifact" || sourceFingerprint(captured) !== sourceFingerprint(observed))
					throw new Error("Goal candidate changed during artifact publication");
				retained = captured;
			}
			// Metadata from a fresh observation cannot mint artifact authority.
			// Reuse only an originally captured value and prove its complete bytes.
			await readCommittedArtifactPage({
				path: join(artifactRoot, retained.locator), containmentRoot: committedArtifactRoot,
				expectedSha256: retained.sha256, expectedLength: retained.bytes,
				offset: 0, maximumBytes: 1, label: `Goal candidate artifact ${path}`,
			});
			candidateArtifacts.set(artifactKey(path, retained), retained);
			return { path, value: retained };
		}));
		for (const { value } of files)
			if (value?.kind === "artifact") sourceArtifacts.set(value.locator, value);
		await assertDirectoryIdentity(mutation.identity);
		await assertOriginUnchanged(
			originRoot,
			originIdentity,
			configuration,
			origin,
			git,
			protectedObservation,
		);
		return parseGoalWorkspaceCandidate({
			schemaVersion: 1,
			workspaceId: baseline.workspaceId,
			baselineHash: goalHash(baseline),
			files,
		});
	};
	const handle: GoalWorkspaceHostHandle = Object.freeze({
		baseline,
		workspaceRoot,
		sourceCatalog,
		async readSourcePage(path: string, cursor?: string): Promise<GoalSourcePage> {
			assertLiveHandle(handle);
			assertWriteLive();
			return enqueueSerialized(async () => {
				await assertWriteCurrent();
				if (!baseline.scope.includes(path)) throw new Error("Goal source path outside manifest");
				await assertOriginUnchanged(originRoot, originIdentity, configuration, origin, git, protectedObservation);
				await assertWriteCurrent();
				const candidate = await inspectCandidateNow();
				await assertWriteCurrent();
				const source = candidate.files.find(file => file.path === path)?.value;
				if (source === undefined) throw new Error("Goal source candidate path unavailable");
				if (source === null) throw new Error("Goal source path is absent");
				const artifact = source.kind === "artifact" ? source : inlineArtifact(path, source);
				const digest = sourceFingerprint(artifact);
				const state = cursor === undefined
					? { path, locator: artifact.locator, digest, offset: 0 }
					: sourceCursors.get(cursor);
				if (!state || state.path !== path || state.digest !== digest)
					throw new Error("Goal source cursor is foreign, stale, or malformed");
				if (source.kind === "file") {
					const bytes = Buffer.from(source.hex, "hex");
					assertWriteLive();
					return sourcePage(path, artifact, bytes.subarray(state.offset, state.offset + 4096),
						state.offset, sourceCursors, digest, state.offset + 4096 >= bytes.length);
				}
				const retained = sourceArtifacts.get(state.locator);
				if (!retained || sourceFingerprint(retained) !== sourceFingerprint(source))
					throw new Error("Goal source catalog identity changed");
				const page = await readCommittedArtifactPage({
					path: join(artifactRoot, retained.locator), containmentRoot: committedArtifactRoot,
					expectedSha256: retained.sha256, expectedLength: retained.bytes,
					offset: state.offset, maximumBytes: 4096, label: `Goal source ${path}`,
				});
				await assertWriteCurrent();
				await assertOriginUnchanged(originRoot, originIdentity, configuration, origin, git, protectedObservation);
				await assertWriteCurrent();
				return sourcePage(path, retained, page.bytes, state.offset, sourceCursors, digest, page.eof);
			});
		},
		async inspectCandidate(): Promise<GoalWorkspaceCandidate> {
			assertLiveHandle(handle);
			return enqueueSerialized(inspectCandidateNow);
		},
		async writeCandidate(
			path: string,
			expectedDigest: string,
			content: string,
		): Promise<GoalWorkspaceCandidate> {
			assertLiveHandle(handle);
			return enqueueSerialized(async () => {
				if (mutation === null)
					throw new Error("Goal read-only workspace rejects writes");
				await assertWriteCurrent();
				if (!baseline.scope.includes(path))
					throw new Error("Goal workspace resource is outside the manifest");
				if (!/^[a-f0-9]{64}$/.test(expectedDigest))
					throw new Error("Goal workspace expected digest is invalid");
				const bytes = Buffer.from(content, "utf8");
				if (bytes.length > MAX_FILE_BYTES)
					throw new Error("Goal workspace write exceeds the file bound");
				const before = await inspectCandidateNow();
				await assertWriteCurrent();
				const current = before.files.find((file) => file.path === path);
				if (current === undefined || goalHash(current.value) !== expectedDigest)
					throw new Error("Goal workspace resource digest changed");
				const baselineFile = baseline.origin.files.find((file) => file.path === path);
				const mode = current.value?.mode ?? baselineFile?.worktree?.mode ?? "0644";
				await writeCandidateValue(
					mutation.root,
					path,
					current.value,
					{ kind: "file", links: 1, mode, hex: bytes.toString("hex") },
					assertWriteCurrent,
					assertWriteLive,
				);
				await assertWriteCurrent();
				const candidate = await inspectCandidateNow();
				await assertWriteCurrent();
				return candidate;
			});
		},
		async beginCandidateReplacement(input: GoalCandidateReplacementBegin) {
			assertLiveHandle(handle);
			return enqueueSerialized(async () => {
				if (mutation === null) throw new Error("Goal read-only workspace rejects writes");
				await assertWriteCurrent();
				if (!baseline.scope.includes(input.path) || !/^[a-f0-9]{64}$/.test(input.expectedDigest) ||
					(input.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(input.sha256)) ||
					!Number.isSafeInteger(input.bytes) || input.bytes < 0 ||
					!input.attemptKey || !input.operationId)
					throw new Error("Goal candidate replacement request is invalid");
				for (const [uploadId, existing] of uploads) {
					if (existing.attemptKey === input.attemptKey && existing.operationId === input.operationId) {
						if (existing.path !== input.path || existing.expectedDigest !== input.expectedDigest ||
							existing.bytes !== input.bytes || existing.sha256 !== input.sha256)
							throw new Error("Goal candidate replacement operation changed");
						if (existing.failed) throw new Error("Goal candidate replacement retains an uncertain outcome");
						return { uploadId, receivedBytes: 0 };
					}
				}
				const candidate = await inspectCandidateNow();
				const current = candidate.files.find(file => file.path === input.path)?.value;
				if (current === undefined || goalHash(current) !== input.expectedDigest)
					throw new Error("Goal workspace resource digest changed");
				const uploadId = randomUUID();
				const file = join(artifactRoot, "uploads", uploadId);
				const mode = current?.mode ?? baseline.origin.files.find(file => file.path === input.path)?.worktree?.mode ?? "0644";
				await assertUploadStorage();
				const created = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
				let version: Stats;
				try {
					version = await created.stat();
					await assertUploadStorage();
					const named = await lstat(file);
					if (named.dev !== version.dev || named.ino !== version.ino || !version.isFile() ||
						version.nlink !== 1 || version.size !== 0 || (version.mode & 0o7777) !== 0o600)
						throw new Error("Goal candidate upload creation identity changed");
				} finally { await created.close(); }
				uploads.set(uploadId, {
					path: input.path, expectedDigest: input.expectedDigest, attemptKey: input.attemptKey,
					operationId: input.operationId, bytes: input.bytes, sha256: input.sha256,
					receivedBytes: 0, file, mode, version, chunks: new Map(), contentHash: createHash("sha256"), failed: false,
				});
				await assertUploadFile(uploads.get(uploadId)!);
				await assertWriteCurrent();
				return { uploadId, receivedBytes: 0 };
			});
		},
		async appendCandidateReplacement(input: GoalCandidateReplacementAppend) {
			assertLiveHandle(handle);
			return enqueueSerialized(async () => {
				const upload = uploads.get(input.uploadId);
				if (!upload || upload.path !== input.path || upload.attemptKey !== input.attemptKey)
					throw new Error("Goal candidate replacement upload is foreign or stale");
				await assertWriteCurrent();
				if (upload.failed) throw new Error("Goal candidate replacement retains an uncertain outcome");
				if (typeof input.operationId !== "string" || !input.operationId.length ||
					input.operationId.length > 256 || input.operationId === upload.operationId ||
					!Number.isSafeInteger(input.offset) || input.offset < 0 || typeof input.hex !== "string" ||
					!input.hex.length || input.hex.length > MAX_FILE_BYTES * 2 ||
					! /^(?:[a-f0-9]{2})+$/.test(input.hex))
					throw new Error("Goal candidate replacement chunk is invalid");
				const fingerprint = goalHash(input);
				const previous = upload.chunks.get(input.operationId);
				if (previous) {
					if (previous.fingerprint !== fingerprint)
						throw new Error("Goal candidate replacement chunk replay changed");
					return { uploadId: input.uploadId, receivedBytes: previous.receivedBytes };
				}
				if (upload.committed) throw new Error("Goal candidate replacement is already committed");
				const bytes = Buffer.from(input.hex, "hex");
				if (input.offset !== upload.receivedBytes)
					throw new Error("Goal candidate replacement chunk is out of order");
				if (bytes.length > MAX_FILE_BYTES || upload.receivedBytes + bytes.length > upload.bytes)
					throw new Error("Goal candidate replacement chunk exceeds its commitment");
				await assertWriteCurrent();
				try {
					await assertUploadFile(upload);
					const file = await open(upload.file, constants.O_WRONLY | constants.O_APPEND | NOFOLLOW);
					try {
						await assertUploadFile(upload, file);
						let written = 0;
						while (written < bytes.length) {
							await assertUploadFile(upload, file, upload.receivedBytes + written, written === 0);
							const result = await file.write(bytes, written, bytes.length - written);
							if (!result.bytesWritten) throw new Error("Goal replacement chunk write made no progress");
							written += result.bytesWritten;
							await assertUploadFile(upload, file, upload.receivedBytes + written, false);
						}
						await file.sync();
						upload.version = await assertUploadFile(upload, file, upload.receivedBytes + written, false);
					} finally { await file.close(); }
					upload.contentHash.update(bytes);
					upload.receivedBytes += bytes.length;
					await assertWriteCurrent();
					upload.chunks.set(input.operationId, { fingerprint, receivedBytes: upload.receivedBytes });
				} catch (error) {
					upload.failed = true;
					throw error;
				}
				return { uploadId: input.uploadId, receivedBytes: upload.receivedBytes };
			});
		},
		async commitCandidateReplacement(input: GoalCandidateReplacementCommit) {
			assertLiveHandle(handle);
			return enqueueSerialized(async () => {
				const upload = uploads.get(input.uploadId);
				if (!upload || upload.path !== input.path || upload.attemptKey !== input.attemptKey)
					throw new Error("Goal candidate replacement upload is foreign or stale");
				await assertWriteCurrent();
				if (upload.failed) throw new Error("Goal candidate replacement retains an uncertain outcome");
				if (typeof input.operationId !== "string" || !input.operationId.length || input.operationId.length > 256 ||
					input.operationId === upload.operationId || upload.chunks.has(input.operationId))
					throw new Error("Goal candidate replacement commit operation changed");
				if (upload.committed) {
					if (upload.committed.operationId !== input.operationId)
						throw new Error("Goal candidate replacement is already committed");
					return upload.committed.candidate;
				}
				if (upload.receivedBytes !== upload.bytes)
					throw new Error("Goal candidate replacement upload is incomplete");
				await assertWriteCurrent();
				await assertUploadFile(upload);
				const stagedSha256 = await sha256File(upload.file);
				await assertUploadFile(upload);
				if (stagedSha256 !== upload.contentHash.copy().digest("hex"))
					throw new Error("Goal candidate replacement bytes differ from admitted chunks");
				if (upload.sha256 !== undefined && stagedSha256 !== upload.sha256)
					throw new Error("Goal candidate replacement digest differs from commitment");
				const before = await inspectCandidateNow();
				const current = before.files.find(file => file.path === upload.path)?.value;
				if (current === undefined || goalHash(current) !== upload.expectedDigest)
					throw new Error("Goal workspace resource digest changed");
				try {
					await replaceCandidateFromUpload(mutation!.root, upload.path, upload.file, upload.bytes, stagedSha256, upload.mode,
						async () => { await assertUploadFile(upload); }, assertWriteLive);
					await assertWriteCurrent();
					const candidate = await inspectCandidateNow();
					upload.committed = { operationId: input.operationId, candidate };
					return candidate;
				} catch (error) {
					upload.failed = true;
					throw error;
				}
			});
		},
		async cleanup(): Promise<GoalWorkspaceCleanupResult> {
			assertLiveHandle(handle);
			return enqueueSerialized(async () => {
				if (cleaned) return { status: "not-created" };
				try {
					await assertOriginUnchanged(
						originRoot,
						originIdentity,
						configuration,
						origin,
						git,
						protectedObservation,
					);
					if (mutation === null) {
						cleaned = true;
						return { status: "not-created" };
					}
					await assertDirectoryIdentity(mutation.identity);
					await assertExactWorkspaceCensus(
						mutation.root,
						baseline.scope,
						Boolean(mutation.git),
					);
					await Promise.all(
						baseline.scope.map((path) => observeManifestFile(mutation.root, path)),
					);
					if (mutation.git) {
						await assertStableFile(
							join(mutation.root, ".git"),
							mutation.git.controlIdentity,
							mutation.git.controlDigest,
							64 * 1024,
						);
						await assertGitIndexUnchanged(
							mutation.root,
							mutation.git.indexIdentity,
							mutation.git.indexDigest,
						);
						await gitCommand(originRoot, [
							"worktree",
							"remove",
							"--force",
							mutation.root,
						]);
					} else {
						await rm(mutation.root, { recursive: true });
					}
					cleaned = true;
					return { status: "removed" };
				} catch (error) {
					return {
						status: "retained",
						reason: error instanceof Error ? error.message : String(error),
					};
				}
			});
		},
	});
	HANDLES.add(handle);
	return handle;
}

export function assertGoalWorkspaceHostHandle(
	value: unknown,
): asserts value is GoalWorkspaceHostHandle {
	if (!value || typeof value !== "object" || !HANDLES.has(value))
		throw new Error("live Goal workspace host handle required");
}

function assertLiveHandle(value: GoalWorkspaceHostHandle): void {
	assertGoalWorkspaceHostHandle(value);
}

function validateConfiguration(
	request: Pick<GoalWorkspaceHostRequest, "scope" | "protectedPaths" | "repository" | "workspaceId" | "mode">,
): PreparedConfiguration {
	const scope = [...request.scope];
	const protectedPaths = [...(request.protectedPaths ?? [])];
	const git = request.repository === "git";
	const placeholderDigest = "0".repeat(64);
	const checked = parseGoalWorkspaceBaseline({
		schemaVersion: 1,
		workspaceId: request.workspaceId,
		mode: request.mode,
		scope,
		protectedPaths,
		inputManifest: scope,
		origin: {
			schemaVersion: 1,
			originId: "physical-origin-pending",
			repository: request.repository,
			headDigest: git ? placeholderDigest : null,
			indexDigest: git ? placeholderDigest : null,
			files: scope.map((path) => ({
				path,
				head: null,
				index: null,
				worktree: null,
			})),
		},
	});
	return {
		workspaceId: checked.workspaceId,
		mode: checked.mode,
		repository: checked.origin.repository,
		scope: checked.scope,
		protectedPaths: checked.protectedPaths,
	};
}

async function prepareArtifactRoot(
	input: string,
	assertCurrent: () => Promise<void>,
	assertLive: () => void,
): Promise<{
	identity: CommittedArtifactRootIdentity;
	assertCurrent: () => Promise<void>;
}> {
	const root = resolve(input);
	if (root !== input || !isAbsolute(root)) throw new Error("Goal artifact root must be canonical");
	const parent = await canonicalExistingDirectory(dirname(root), "artifact parent");
	if (parent !== dirname(root)) throw new Error("Goal artifact root must be physically canonical");
	const parentIdentity = await directoryIdentity(parent);
	await assertCurrent();
	await assertDirectoryIdentity(parentIdentity);
	assertLive();
	try {
		await mkdir(root, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST")
			throw new Error("Goal artifact root already exists");
		throw error;
	}
	await assertDirectoryIdentity(parentIdentity);
	await assertCurrent();
	const info = await lstat(root);
	if (!info.isDirectory() || info.isSymbolicLink() || info.nlink !== 2 ||
		info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0)
		throw new Error("Goal artifact root is not exclusive private storage");
	const identity: CommittedArtifactRootIdentity = Object.freeze({
		root, dev: info.dev, ino: info.ino, uid: info.uid,
	});
	const assertPreparedCurrent = async (): Promise<void> => {
		await assertDirectoryIdentity(parentIdentity);
		const observed = await lstat(root);
		if (!observed.isDirectory() || observed.isSymbolicLink() ||
			observed.dev !== identity.dev || observed.ino !== identity.ino ||
			observed.uid !== identity.uid || observed.mode !== info.mode)
			throw new Error("Goal artifact root physical identity changed");
		await assertDirectoryIdentity(parentIdentity);
	};
	await assertCurrent();
	await assertPreparedCurrent();
	assertLive();
	return { identity, assertCurrent: assertPreparedCurrent };
}

function sourcePage(
	path: string,
	artifact: GoalFileArtifact,
	input: Buffer,
	offset: number,
	cursors: Map<string, { path: string; locator: string; digest: string; offset: number }>,
	catalogDigest: string,
	knownEof = false,
): GoalSourcePage {
	let bytes = input;
	let encoding: "utf8" | "base64" = "utf8";
	let content: string;
	try {
		content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
			.decode(bytes, { stream: !knownEof });
		bytes = bytes.subarray(0, Buffer.byteLength(content, "utf8"));
		if (bytes.length === 0 && input.length > 0) throw new Error("Incomplete UTF-8 source page");
	} catch {
		bytes = input;
		encoding = "base64";
		content = bytes.toString("base64");
	}
	if (encoding === "utf8" && content.length <= 4096) {
		let lines = content.split("\n").length - 1;
		if (lines > 31) {
			let end = 0, seen = 0;
			for (let index = 0; index < bytes.length; index += 1) {
				if (bytes[index] === 10 && ++seen === 32) { end = index + 1; break; }
			}
			if (end > 0) { bytes = bytes.subarray(0, end); content = bytes.toString("utf8"); lines = 32; }
		}
	} else if (encoding === "utf8") {
		encoding = "base64"; content = bytes.toString("base64");
		if (content.length > 8192) {
			bytes = bytes.subarray(0, Math.floor(8192 / 4) * 3);
			content = bytes.toString("base64");
		}
	}
	if (bytes.length === 0 && offset < artifact.bytes) throw new Error("Goal source page made no progress");
	const nextOffset = offset + bytes.length;
	const eof = knownEof && nextOffset === artifact.bytes;
	const cursor = eof ? null : goalHash({ catalogDigest, path, locator: artifact.locator, sha256: artifact.sha256, bytes: artifact.bytes, offset: nextOffset });
	if (cursor) cursors.set(cursor, {
		path, locator: artifact.locator, digest: sourceFingerprint(artifact), offset: nextOffset,
	});
	return Object.freeze({
		status: "ok", path, artifact,
		page: Object.freeze({
			encoding, content, returnedBytes: bytes.length,
			returnedLines: byteLines(bytes),
			nextCursor: cursor, eof,
		}),
	});
}

function inlineArtifact(path: string, value: GoalFileBytes): GoalFileArtifact {
	const bytes = Buffer.from(value.hex, "hex");
	return {
		kind: "artifact",
		links: 1,
		mode: value.mode,
		locator: `source/${goalHash({ path, inline: value.hex })}`,
		sha256: sha256(bytes),
		bytes: bytes.length,
		lines: byteLines(bytes),
	};
}

function sourceFingerprint(value: GoalFileValue): string {
	if (value.kind === "file") return goalHash(value);
	return goalHash({
		kind: value.kind, links: value.links, mode: value.mode, sha256: value.sha256,
		bytes: value.bytes, lines: value.lines,
	});
}

function byteLines(bytes: Buffer): number {
	if (bytes.length === 0) return 0;
	let newlines = 0;
	for (const byte of bytes) if (byte === 10) newlines += 1;
	return newlines + (bytes.at(-1) === 10 ? 0 : 1);
}

async function observeGitOrigin(
	originRoot: string,
	originIdentity: PhysicalIdentity,
	scope: string[],
	artifactRoot?: string,
): Promise<GitObservation> {
	await assertDirectoryIdentity(originIdentity);
	const topLevel = await gitText(originRoot, ["rev-parse", "--show-toplevel"]);
	const canonicalTopLevel = await realpath(topLevel.trim());
	if (canonicalTopLevel !== originRoot)
		throw new Error("Goal Git origin must be the repository root");
	const headOutput = await gitText(originRoot, [
		"rev-parse",
		"--verify",
		"HEAD^{commit}",
	]);
	const headOid = headOutput.trim();
	if (!/^[a-f0-9]{40,64}$/u.test(headOid))
		throw new Error("Goal Git HEAD object ID is unsupported");
	const index = await inspectGitIndex(originRoot);
	const files = [];
	for (const path of scope) {
		files.push({
			path,
			head: await readGitHeadFile(originRoot, headOid, path, artifactRoot),
			index: await readGitIndexFile(originRoot, path, artifactRoot),
			worktree: await observeManifestFile(originRoot, path, artifactRoot, "worktree"),
		});
	}
	await assertDirectoryIdentity(originIdentity);
	return {
		observation: {
			schemaVersion: 1,
			originId: physicalOriginId(originIdentity),
			repository: "git",
			headDigest: sha256(Buffer.from(`${headOid}\n`, "utf8")),
			indexDigest: index.digest,
			files,
		},
		headOid,
		indexIdentity: index.identity,
	};
}

async function observeNonGitOrigin(
	originRoot: string,
	originIdentity: PhysicalIdentity,
	scope: string[],
	artifactRoot?: string,
): Promise<GoalOriginObservation> {
	await assertDirectoryIdentity(originIdentity);
	const files = await Promise.all(
		scope.map(async (path) => ({
			path,
			head: null,
			index: null,
			worktree: await observeManifestFile(originRoot, path, artifactRoot, "worktree"),
		})),
	);
	await assertDirectoryIdentity(originIdentity);
	return {
		schemaVersion: 1,
		originId: physicalOriginId(originIdentity),
		repository: "nonGit",
		headDigest: null,
		indexDigest: null,
		files,
	};
}

async function assertOriginUnchanged(
	originRoot: string,
	originIdentity: PhysicalIdentity,
	configuration: PreparedConfiguration,
	expected: GoalOriginObservation,
	git: GitObservation | undefined,
	protectedExpected: ProtectedObservation[],
): Promise<void> {
	await assertDirectoryIdentity(originIdentity);
	const current =
		configuration.repository === "git"
			? await observeGitOrigin(originRoot, originIdentity, configuration.scope)
			: {
					observation: await observeNonGitOrigin(
						originRoot,
						originIdentity,
						configuration.scope,
					),
				};
	if (goalHash(current.observation) !== goalHash(expected))
		throw new Error(
			"Goal protected origin inputs, HEAD, index, or bytes drifted",
		);
	if (git && "headOid" in current) {
		if (current.headOid !== git.headOid) throw new Error("Goal Git HEAD drifted");
		if (!sameFileIdentity(current.indexIdentity, git.indexIdentity))
			throw new Error("Goal Git index physical identity changed");
	}
	const protectedCurrent = await observeProtectedPaths(
		originRoot,
		configuration.protectedPaths,
	);
	if (goalHash(protectedCurrent) !== goalHash(protectedExpected))
		throw new Error("Goal protected input drifted");
	await assertDirectoryIdentity(originIdentity);
}

async function observeProtectedPaths(
	root: string,
	paths: string[],
): Promise<ProtectedObservation[]> {
	return Promise.all(
		paths.map(async (path) => ({
			path,
			value: await observeManifestFile(root, path),
		})),
	);
}

async function observeManifestFile(
	root: string,
	relativePath: string,
	artifactRoot?: string,
	version = "worktree",
): Promise<GoalFileValue | null> {
	const opened = await openPathWithPinnedAncestors(root, relativePath);
	if (opened === null) return null;
	let temporary: string | undefined;
	let stagedIdentity: Stats | undefined;
	let failure: unknown;
	let stagingParent: { target: string; ancestors: OpenedPath["ancestors"] } | undefined;
	try {
		const before = await opened.file.stat();
		if (!before.isFile() || before.nlink !== 1)
			throw new Error(`Goal path is not a one-link regular file: ${relativePath}`);
		const mode = before.mode & 0o777;
		if (mode !== 0o644 && mode !== 0o755)
			throw new Error(`Goal path mode is unsupported: ${relativePath}`);
		const chunks: Buffer[] = [];
		const hash = createHash("sha256");
		const locator = `source/${goalHash({ relativePath, version })}`;
		const published = artifactRoot ? join(artifactRoot, locator) : undefined;
		stagingParent = artifactRoot ? await openParentWithPinnedAncestors(artifactRoot, locator) : undefined;
		if (stagingParent && stagingParent.target !== published)
			throw new Error("Goal artifact staging path escaped its private root");
		temporary = published ? `${published}.stage-${randomUUID()}` : undefined;
		const destination = temporary
			? await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600)
			: undefined;
		if (destination) stagedIdentity = await destination.stat();
		const chunk = Buffer.allocUnsafe(64 * 1024);
		let bytesRead = 0, newlines = 0, lastByte = -1;
		try {
			for (;;) {
				const read = await opened.file.read(chunk, 0, chunk.length, bytesRead);
				if (!read.bytesRead) break;
				const value = chunk.subarray(0, read.bytesRead);
				hash.update(value);
				for (const byte of value) if (byte === 10) newlines += 1;
				if (bytesRead < MAX_FILE_BYTES)
					chunks.push(Buffer.from(value.subarray(0, MAX_FILE_BYTES - bytesRead)));
				if (destination) {
					let written = 0;
					while (written < value.length) {
						const result = await destination.write(value, written, value.length - written, null);
						if (result.bytesWritten <= 0)
							throw new Error("Goal artifact write made no progress");
						written += result.bytesWritten;
					}
				}
				lastByte = value[read.bytesRead - 1]!;
				bytesRead += read.bytesRead;
			}
			await destination?.sync();
		} finally { await destination?.close(); }
		if (bytesRead !== before.size)
			throw new Error(`Goal path changed during observation: ${relativePath}`);
		const after = await opened.file.stat();
		const named = await lstat(opened.path);
		if (
			!sameStableStat(before, after) ||
			!sameStableStat(after, named) ||
			after.nlink !== 1
		)
			throw new Error(`Goal path changed during observation: ${relativePath}`);
		await revalidateAncestors(opened.ancestors);
		if (temporary && published) {
			const staged = await lstat(temporary);
			if (!staged.isFile() || staged.isSymbolicLink() || staged.nlink !== 1 ||
				staged.size !== bytesRead || (staged.mode & 0o777) !== 0o600)
				throw new Error("Goal artifact staging descriptor changed");
			if (!sameIdentity(stagedIdentity!, staged))
				throw new Error("Goal artifact staging descriptor changed");
			if (bytesRead > MAX_FILE_BYTES) {
				if (await sha256File(temporary) !== hash.copy().digest("hex"))
					throw new Error("Goal artifact staging bytes changed");
				await link(temporary, published);
				await unlinkOwnedTemporary(temporary, staged, stagingParent!.ancestors, true);
				temporary = undefined;
			} else {
				await unlinkOwnedTemporary(temporary, staged, stagingParent!.ancestors);
				temporary = undefined;
			}
		}
		const normalizedMode = mode === 0o755 ? "0755" : "0644";
		if (bytesRead <= MAX_FILE_BYTES) return {
			kind: "file", links: 1, mode: normalizedMode,
			hex: Buffer.concat(chunks).toString("hex"),
		};
		return {
			kind: "artifact", links: 1, mode: normalizedMode, locator,
			sha256: hash.digest("hex"), bytes: bytesRead,
			lines: bytesRead === 0 ? 0 : newlines + (lastByte === 10 ? 0 : 1),
		};
	} catch (error) {
		failure = error;
		throw error;
	} finally {
		const cleanups: unknown[] = [];
		if (temporary && stagedIdentity) {
			try {
				await unlinkOwnedTemporary(temporary, stagedIdentity, stagingParent!.ancestors);
			} catch (cleanup) { cleanups.push(cleanup); }
		}
		try { await opened.file.close(); } catch (cleanup) { cleanups.push(cleanup); }
		try { await closeAncestors(opened.ancestors); } catch (cleanup) { cleanups.push(cleanup); }
		if (stagingParent) {
			try { await closeAncestors(stagingParent.ancestors); }
			catch (cleanup) { cleanups.push(cleanup); }
		}
		if (cleanups.length)
			throw failure
				? new AggregateError([failure, ...cleanups], "Goal artifact capture failed and cleanup failed")
				: new AggregateError(cleanups, "Goal artifact capture cleanup failed");
	}
}

interface OpenedPath {
	file: FileHandle;
	path: string;
	ancestors: Array<{
		handle: FileHandle;
		path: string;
		identity: PhysicalIdentity;
	}>;
}

async function openParentWithPinnedAncestors(
	root: string,
	relativePath: string,
): Promise<{ target: string; ancestors: OpenedPath["ancestors"] }> {
	const ancestors: OpenedPath["ancestors"] = [];
	let current = root;
	try {
		const rootHandle = await open(root, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
		const rootStat = await rootHandle.stat();
		ancestors.push({
			handle: rootHandle, path: root,
			identity: { path: root, dev: rootStat.dev, ino: rootStat.ino },
		});
		const parts = relativePath.split("/");
		for (const part of parts.slice(0, -1)) {
			current = join(current, part);
			const handle = await open(current, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
			const info = await handle.stat();
			if (!info.isDirectory()) throw new Error(`Goal path ancestor is not a directory: ${relativePath}`);
			ancestors.push({
				handle, path: current,
				identity: { path: current, dev: info.dev, ino: info.ino },
			});
		}
		const finalPart = parts.at(-1);
		if (!finalPart) throw new Error("Goal manifest path is empty");
		return { target: join(current, finalPart), ancestors };
	} catch (error) {
		await closeAncestors(ancestors);
		throw error;
	}
}

async function lstatOptional(path: string): Promise<Stats | undefined> {
	try {
		return await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function unlinkOwnedTemporary(
	temporary: string,
	expected: Stats,
	ancestors: OpenedPath["ancestors"],
	linked = false,
): Promise<void> {
	await revalidateAncestors(ancestors);
	const named = await lstatOptional(temporary);
	if (!named || !sameIdentity(expected, named) || named.isSymbolicLink() ||
		named.nlink !== expected.nlink + (linked ? 1 : 0))
		throw new Error("Goal temporary staging descriptor changed before cleanup");
	await unlink(temporary);
}

/** Rename and link update ctime/nlink; retain the preimage's content version. */
function sameMovedPreimage(expected: Stats, moved: Stats): boolean {
	return sameIdentity(expected, moved) &&
		expected.size === moved.size &&
		expected.mtimeMs === moved.mtimeMs &&
		expected.mode === moved.mode &&
		moved.nlink === 1;
}

/** A hard-link publication changes ctime and raises the shared link count to two. */
function samePublishedLink(expected: Stats, observed: Stats): boolean {
	return sameIdentity(expected, observed) &&
		expected.size === observed.size &&
		expected.mtimeMs === observed.mtimeMs &&
		expected.mode === observed.mode &&
		observed.nlink === 2;
}

async function removeOwnedDisplaced(
	displaced: string,
	expected: Stats,
	ancestors: OpenedPath["ancestors"],
): Promise<void> {
	try {
		await revalidateAncestors(ancestors);
		const named = await lstat(displaced);
		if (!sameStableStat(expected, named))
			throw new Error("displaced preimage descriptor changed");
		await unlink(displaced);
	} catch (error) {
		throw new Error(
			`Goal materialization displaced bytes retained at ${displaced}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

async function restoreDisplacedTarget(
	target: string,
	displaced: string,
	handle: FileHandle,
	ancestors: OpenedPath["ancestors"],
): Promise<void> {
	let preservedForeign: FileHandle | undefined;
	let restorationFailure: Error | undefined;
	try {
		await revalidateAncestors(ancestors);
		let moved = await handle.stat();
		const named = await lstat(displaced);
		if (!sameStableStat(moved, named)) {
			// Restoration only: retain foreign bytes, never authorize their
			// deletion or replacement. The final link cannot overwrite a name.
			preservedForeign = await open(displaced, constants.O_RDONLY | NOFOLLOW);
			moved = await preservedForeign.stat();
			if (!moved.isFile() || moved.nlink !== 1 ||
				!sameStableStat(moved, named) ||
				!sameStableStat(moved, await lstat(displaced)))
				throw new Error("displaced foreign descriptor changed");
			await revalidateAncestors(ancestors);
		}
		if (await lstatOptional(target))
			throw new Error("target is no longer absent");
		await link(displaced, target);
		const restored = await lstat(target);
		if (!samePublishedLink(moved, restored))
			throw new Error("restored target descriptor changed");
	} catch (error) {
		restorationFailure = new Error(
			`Goal materialization displaced bytes retained at ${displaced}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		throw restorationFailure;
	} finally {
		try {
			await preservedForeign?.close();
		} catch (error) {
			throw new AggregateError([
				...(restorationFailure ? [restorationFailure] : []), error,
			], `Goal materialization recovery descriptor close failed; displaced bytes retained at ${displaced}`);
		}
	}
}

async function openPathWithPinnedAncestors(
	root: string,
	relativePath: string,
	writable = false,
): Promise<OpenedPath | null> {
	const ancestors: OpenedPath["ancestors"] = [];
	let current = root;
	try {
		const rootHandle = await open(
			root,
			constants.O_RDONLY | DIRECTORY | NOFOLLOW,
		);
		const rootStat = await rootHandle.stat();
		ancestors.push({
			handle: rootHandle,
			path: root,
			identity: { path: root, dev: rootStat.dev, ino: rootStat.ino },
		});
		const parts = relativePath.split("/");
		for (const part of parts.slice(0, -1)) {
			current = join(current, part);
			let handle: FileHandle;
			try {
				handle = await open(current, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					await revalidateAncestors(ancestors);
					await closeAncestors(ancestors);
					return null;
				}
				throw error;
			}
			const info = await handle.stat();
			if (!info.isDirectory())
				throw new Error(`Goal path ancestor is not a directory: ${relativePath}`);
			ancestors.push({
				handle,
				path: current,
				identity: { path: current, dev: info.dev, ino: info.ino },
			});
		}
		const finalPart = parts.at(-1);
		if (!finalPart) throw new Error("Goal manifest path is empty");
		const target = join(current, finalPart);
		let file: FileHandle;
		try {
			file = await open(
				target,
				(writable ? constants.O_RDWR : constants.O_RDONLY) |
					NOFOLLOW |
					constants.O_NONBLOCK,
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				await revalidateAncestors(ancestors);
				await closeAncestors(ancestors);
				return null;
			}
			throw error;
		}
		return { file, path: target, ancestors };
	} catch (error) {
		await closeAncestors(ancestors);
		throw error;
	}
}

async function revalidateAncestors(
	ancestors: OpenedPath["ancestors"],
): Promise<void> {
	for (const ancestor of ancestors) {
		const [opened, named] = await Promise.all([
			ancestor.handle.stat(),
			lstat(ancestor.path),
		]);
		if (
			!opened.isDirectory() ||
			named.isSymbolicLink() ||
			!sameIdentity(opened, named) ||
			!sameIdentity(opened, ancestor.identity)
		) {
			throw new Error("Goal path ancestor changed during observation");
		}
	}
}

async function closeAncestors(
	ancestors: OpenedPath["ancestors"],
): Promise<void> {
	await Promise.all(ancestors.map(({ handle }) => handle.close()));
}

async function copyArtifactToFile(
	source: string,
	target: FileHandle,
	expectedBytes: number,
	expectedSha256: string,
	assertCurrent: () => Promise<void>,
): Promise<void> {
	await assertCurrent();
	const input = await open(source, constants.O_RDONLY | NOFOLLOW);
	try {
		await assertCurrent();
		const before = await input.stat();
		if (!before.isFile() || before.nlink !== 1 || before.size !== expectedBytes ||
			before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600 ||
			!sameStableStat(before, await lstat(source)))
			throw new Error("Goal replacement source is not an exact private regular file");
		const hash = createHash("sha256");
		const chunk = Buffer.allocUnsafe(64 * 1024);
		let offset = 0;
		for (;;) {
			await assertCurrent();
			const { bytesRead } = await input.read(chunk, 0, chunk.length, offset);
			await assertCurrent();
			if (!bytesRead) break;
			if (offset + bytesRead > expectedBytes)
				throw new Error("Goal replacement source exceeds its retained byte census");
			hash.update(chunk.subarray(0, bytesRead));
			let written = 0;
			while (written < bytesRead) {
				await assertCurrent();
				const result = await target.write(chunk, written, bytesRead - written, null);
				await assertCurrent();
				if (result.bytesWritten <= 0)
					throw new Error("Goal replacement copy write failed to advance");
				written += result.bytesWritten;
			}
			offset += bytesRead;
		}
		if (offset !== expectedBytes || hash.digest("hex") !== expectedSha256)
			throw new Error("Goal replacement source differs from admitted chunks during copy");
		if (!sameStableStat(before, await input.stat()) ||
			!sameStableStat(before, await lstat(source)) || await realpath(source) !== source)
			throw new Error("Goal replacement source physical version changed during copy");
		await assertCurrent();
	} finally {
		await input.close();
	}
}

async function sha256File(path: string): Promise<string> {
	const file = await open(path, constants.O_RDONLY | NOFOLLOW);
	try {
		const hash = createHash("sha256");
		const chunk = Buffer.allocUnsafe(64 * 1024);
		let position = 0;
		for (;;) {
			const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
			if (!bytesRead) break;
			hash.update(chunk.subarray(0, bytesRead));
			position += bytesRead;
		}
		return hash.digest("hex");
	} finally {
		await file.close();
	}
}

async function replaceCandidateFromUpload(
	root: string,
	path: string,
	upload: string,
	expectedBytes: number,
	expectedSha256: string,
	mode: "0644" | "0755",
	assertWriteCurrent: () => Promise<void>,
	assertWriteLive: () => void,
): Promise<void> {
	const target = resolve(root, ...path.split("/"));
	await ensureWorkspaceParent(root, dirname(target), assertWriteCurrent, assertWriteLive);
	const parent = await openParentWithPinnedAncestors(root, path);
	let opened: OpenedPath | null;
	try {
		opened = await openPathWithPinnedAncestors(root, path, true);
	} catch (error) {
		await closeAncestors(parent.ancestors);
		throw error;
	}
	const temporary = join(dirname(target), `.${basename(target)}.goal-${randomUUID()}`);
	let output: FileHandle | undefined;
	let temporaryIdentity: Stats | undefined;
	let failure: unknown;
	try {
		const before = opened ? await opened.file.stat() : undefined;
		if (before && (!before.isFile() || before.nlink !== 1))
			throw new Error(`Goal candidate write target is unsafe: ${path}`);
		await assertWriteCurrent();
		assertWriteLive();
		output = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, Number.parseInt(mode, 8));
		temporaryIdentity = await output.stat();
		await copyArtifactToFile(upload, output, expectedBytes, expectedSha256, assertWriteCurrent);
		await output.sync();
		temporaryIdentity = await output.stat();
		if (!sameIdentity(temporaryIdentity, await lstat(temporary)) || temporaryIdentity.size !== expectedBytes)
			throw new Error("Goal candidate replacement staging descriptor changed");
		await output.close();
		output = undefined;
		await assertWriteCurrent();
		assertWriteLive();
		await revalidateAncestors(parent.ancestors);
		const namedBefore = await lstatOptional(target);
		if (opened) {
			if (!namedBefore || !sameStableStat(before!, namedBefore))
				throw new Error(`Goal candidate replacement target changed: ${path}`);
			await rename(temporary, target);
		} else {
			if (namedBefore)
				throw new Error(`Goal candidate replacement target was concurrently created: ${path}`);
			// link is an atomic no-overwrite publication for an exact null CAS.
			await link(temporary, target);
			await unlinkOwnedTemporary(temporary, temporaryIdentity, parent.ancestors, true);
		}
		await assertWriteCurrent();
		const named = await lstat(target);
		if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size !== expectedBytes)
			throw new Error(`Goal candidate replacement target changed: ${path}`);
		await revalidateAncestors(parent.ancestors);
	} catch (error) {
		failure = error;
		throw error;
	} finally {
		const cleanups: unknown[] = [];
		if (output) {
			try { await output.close(); } catch (cleanup) { cleanups.push(cleanup); }
		}
		if (temporaryIdentity) {
			try {
				const staged = await lstatOptional(temporary);
				if (staged) await unlinkOwnedTemporary(temporary, temporaryIdentity, parent.ancestors);
			} catch (cleanup) { cleanups.push(cleanup); }
		}
		if (opened) {
			try { await opened.file.close(); } catch (cleanup) { cleanups.push(cleanup); }
			try { await closeAncestors(opened.ancestors); } catch (cleanup) { cleanups.push(cleanup); }
		}
		try { await closeAncestors(parent.ancestors); } catch (cleanup) { cleanups.push(cleanup); }
		if (cleanups.length)
			throw failure
				? new AggregateError([failure, ...cleanups], "Goal candidate replacement failed and cleanup failed")
				: new AggregateError(cleanups, "Goal candidate replacement cleanup failed");
	}
}

async function materializeValues(
	root: string,
	files: Array<{ path: string; value: GoalFileValue | null }>,
	assertWriteCurrent: () => Promise<void>,
	assertWriteLive: () => void,
	materializeArtifact: (value: GoalFileArtifact, target: FileHandle) => Promise<void>,
): Promise<void> {
	for (const { path, value } of files) {
		await assertWriteCurrent();
		const target = resolve(root, ...path.split("/"));
		if (value === null) {
			const opened = await openPathWithPinnedAncestors(root, path, true);
			if (opened) {
				let failure: unknown;
				try {
					const before = await opened.file.stat();
					if (!before.isFile() || before.nlink !== 1)
						throw new Error(`Goal materialization target is unsafe: ${path}`);
					await assertWriteCurrent();
					assertWriteLive();
					await revalidateAncestors(opened.ancestors);
					const named = await lstat(target);
					if (!sameStableStat(before, named))
						throw new Error(`Goal materialization target changed: ${path}`);
					await unlink(target);
				} catch (error) {
					failure = error;
					throw error;
				} finally {
					try {
						await opened.file.close();
						await closeAncestors(opened.ancestors);
					} catch (cleanup) {
						throw failure
							? new AggregateError([failure, cleanup], "Goal materialization deletion and handle cleanup failed")
							: cleanup;
					}
				}
			}
			await assertWriteCurrent();
			continue;
		}
		await ensureWorkspaceParent(root, dirname(target), assertWriteCurrent, assertWriteLive);
		const parent = await openParentWithPinnedAncestors(root, path);
		const targetBefore = await lstatOptional(target);
		if (targetBefore && (!targetBefore.isFile() || targetBefore.isSymbolicLink() || targetBefore.nlink !== 1)) {
			await closeAncestors(parent.ancestors);
			throw new Error(`Goal materialization target is unsafe: ${path}`);
		}
		let file: FileHandle | undefined;
		const temporary = join(dirname(target), `.${basename(target)}.goal-materialize-${randomUUID()}`);
		const displaced = join(dirname(target), `.${basename(target)}.goal-displaced-${randomUUID()}`);
		let displacedFile: FileHandle | undefined;
		let displacedIdentity: Stats | undefined;
		let displacedMoved = false;
		let published = false;
		let temporaryIdentity: Stats | undefined;
		let failure: unknown;
		try {
			await assertWriteCurrent();
			assertWriteLive();
			file = await open(
				temporary,
				constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
				Number.parseInt(value.mode, 8),
			);
			await assertWriteCurrent();
			const before = await file.stat();
			temporaryIdentity = before;
			await assertWriteCurrent();
			if (!before.isFile() || before.nlink !== 1)
				throw new Error(`Goal materialization target is unsafe: ${path}`);
			assertWriteLive();
			if (value.kind === "file") {
				const bytes = Buffer.from(value.hex, "hex");
				let written = 0;
				while (written < bytes.length) {
					const result = await file.write(bytes, written, bytes.length - written, null);
					if (result.bytesWritten <= 0) throw new Error("Goal materialization write failed to advance");
					written += result.bytesWritten;
				}
			} else await materializeArtifact(value, file);
			await assertWriteCurrent();
			assertWriteLive();
			await file.chmod(Number.parseInt(value.mode, 8));
			await assertWriteCurrent();
			assertWriteLive();
			await file.sync();
			await assertWriteCurrent();
			const after = await file.stat();
			const expected = value.kind === "artifact" ? value : inlineArtifact(path, value);
			const hash = createHash("sha256");
			const chunk = Buffer.allocUnsafe(64 * 1024);
			let verifiedBytes = 0, newlines = 0, lastByte = -1;
			for (;;) {
				await assertWriteCurrent();
				const { bytesRead } = await file.read(chunk, 0, chunk.length, verifiedBytes);
				await assertWriteCurrent();
				if (bytesRead === 0) break;
				verifiedBytes += bytesRead;
				if (verifiedBytes > expected.bytes)
					throw new Error("Goal materialization output exceeds retained byte census");
				const bytes = chunk.subarray(0, bytesRead);
				hash.update(bytes);
				for (const byte of bytes) if (byte === 10) newlines++;
				lastByte = bytes.at(-1)!;
			}
			const lines = verifiedBytes === 0 ? 0 : newlines + (lastByte === 10 ? 0 : 1);
			if (verifiedBytes !== expected.bytes || hash.digest("hex") !== expected.sha256 ||
				lines !== expected.lines || !sameStableStat(after, await file.stat()))
				throw new Error("Goal materialization output differs from retained commitment");
			await assertWriteCurrent();
			const named = await lstat(temporary);
			await assertWriteCurrent();
			if (
				!sameIdentity(before, after) ||
				!sameStableStat(after, named) ||
				after.nlink !== 1
			)
				throw new Error(`Goal materialization target changed: ${path}`);
			temporaryIdentity = named;
			await revalidateAncestors(parent.ancestors);
			await assertWriteCurrent();
			assertWriteLive();
			await revalidateAncestors(parent.ancestors);
			const targetNow = await lstatOptional(target);
			if (targetBefore === undefined) {
				if (targetNow !== undefined)
					throw new Error(`Goal materialization target was concurrently created: ${path}`);
				await link(temporary, target);
				await unlinkOwnedTemporary(temporary, temporaryIdentity, parent.ancestors, true);
			} else {
				if (!targetNow || !sameStableStat(targetBefore, targetNow))
					throw new Error(`Goal materialization target changed: ${path}`);
				displacedFile = await open(target, constants.O_RDONLY | NOFOLLOW);
				displacedIdentity = await displacedFile.stat();
				if (!sameStableStat(targetBefore, displacedIdentity))
					throw new Error(`Goal materialization target changed: ${path}`);
				await assertWriteCurrent();
				assertWriteLive();
				await revalidateAncestors(parent.ancestors);
				if (await lstatOptional(displaced))
					throw new Error(`Goal materialization quarantine name is occupied: ${path}`);
				await rename(target, displaced);
				displacedMoved = true;
				const moved = await displacedFile.stat();
				const namedDisplaced = await lstat(displaced);
				if (!sameMovedPreimage(targetBefore, moved) || !sameStableStat(moved, namedDisplaced))
					throw new Error(`Goal materialization target changed: ${path}`);
				if (await lstatOptional(target))
					throw new Error(`Goal materialization target was concurrently created: ${path}`);
				await link(temporary, target);
				const publishedDescriptor = await file.stat();
				const publishedName = await lstat(target);
				if (!samePublishedLink(temporaryIdentity, publishedDescriptor) ||
					!samePublishedLink(publishedDescriptor, publishedName))
					throw new Error(`Goal materialization target changed during publication: ${path}`);
				await unlinkOwnedTemporary(temporary, temporaryIdentity, parent.ancestors, true);
				const finalPublished = await lstat(target);
				if (!sameIdentity(publishedDescriptor, finalPublished) || finalPublished.nlink !== 1 ||
					finalPublished.size !== publishedDescriptor.size ||
					finalPublished.mtimeMs !== publishedDescriptor.mtimeMs ||
					finalPublished.mode !== publishedDescriptor.mode)
					throw new Error(`Goal materialization target changed during publication: ${path}`);
				published = true;
				await removeOwnedDisplaced(displaced, moved, parent.ancestors);
			}
			published = true;
		} catch (error) {
			failure = error;
			throw error;
		} finally {
			const cleanups: unknown[] = [];
			if (!published && displacedMoved && displacedFile && displacedIdentity) {
				try {
					await restoreDisplacedTarget(
						target, displaced, displacedFile, parent.ancestors,
					);
				} catch (cleanup) { cleanups.push(cleanup); }
			}
			if (file) {
				try { await file.close(); } catch (cleanup) { cleanups.push(cleanup); }
			}
			if (displacedFile) {
				try { await displacedFile.close(); } catch (cleanup) { cleanups.push(cleanup); }
			}
			if (!published && temporaryIdentity) {
				try { await unlinkOwnedTemporary(temporary, temporaryIdentity, parent.ancestors); }
				catch (cleanup) { cleanups.push(cleanup); }
			}
			try { await closeAncestors(parent.ancestors); } catch (cleanup) { cleanups.push(cleanup); }
			if (cleanups.length)
				throw failure
					? new AggregateError([failure, ...cleanups], "Goal materialization failed and cleanup failed")
					: new AggregateError(cleanups, "Goal materialization cleanup failed");
		}
		await assertWriteCurrent();
	}
	await pruneEmptyWorkspaceParents(root, files, assertWriteCurrent, assertWriteLive);
	await assertWriteCurrent();
}

async function writeCandidateValue(
	root: string,
	path: string,
	expected: GoalFileValue | null,
	value: GoalFileBytes,
	assertWriteCurrent: () => Promise<void>,
	assertWriteLive: () => void,
): Promise<void> {
	const target = resolve(root, ...path.split("/"));
	if (expected === null) {
		await ensureWorkspaceParent(root, dirname(target), assertWriteCurrent, assertWriteLive);
		let created: FileHandle | undefined;
		try {
			await assertWriteCurrent();
			assertWriteLive();
			created = await open(
				target,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
				Number.parseInt(value.mode, 8),
			);
			await assertWriteCurrent();
			const before = await created.stat();
			await assertWriteCurrent();
			if (!before.isFile() || before.nlink !== 1)
				throw new Error(`Goal candidate write target is unsafe: ${path}`);
			await assertWriteCurrent();
			assertWriteLive();
			await created.writeFile(Buffer.from(value.hex, "hex"));
			await assertWriteCurrent();
			assertWriteLive();
			await created.chmod(Number.parseInt(value.mode, 8));
			await assertWriteCurrent();
			assertWriteLive();
			await created.sync();
			await assertWriteCurrent();
			const after = await created.stat();
			const named = await lstat(target);
			if (!sameIdentity(before, after) || !sameStableStat(after, named))
				throw new Error(`Goal candidate write target changed: ${path}`);
		} finally {
			await created?.close().catch(() => undefined);
		}
		return;
	}
	const opened = await openPathWithPinnedAncestors(root, path, true);
	if (opened === null)
		throw new Error("Goal workspace resource digest changed");
	try {
		await assertWriteCurrent();
		const before = await opened.file.stat();
		await assertWriteCurrent();
		if (!before.isFile() || before.nlink !== 1 || before.size > MAX_FILE_BYTES)
			throw new Error(`Goal candidate write target is unsafe: ${path}`);
		const currentMode = before.mode & 0o777;
		if (currentMode !== 0o644 && currentMode !== 0o755)
			throw new Error(`Goal candidate write target mode changed: ${path}`);
		const current: GoalFileBytes = {
			kind: "file",
			links: 1,
			mode: currentMode === 0o755 ? "0755" : "0644",
			hex: (await readBoundedHandle(opened.file, MAX_FILE_BYTES)).toString("hex"),
		};
		await assertWriteCurrent();
		const observed = await opened.file.stat();
		await assertWriteCurrent();
		if (
			!sameStableStat(before, observed) ||
			goalHash(current) !== goalHash(expected)
		)
			throw new Error("Goal workspace resource digest changed");
		await assertWriteCurrent();
		assertWriteLive();
		await opened.file.truncate(0);
		await assertWriteCurrent();
		assertWriteLive();
		await opened.file.writeFile(Buffer.from(value.hex, "hex"));
		await assertWriteCurrent();
		assertWriteLive();
		await opened.file.chmod(Number.parseInt(value.mode, 8));
		await assertWriteCurrent();
		assertWriteLive();
		await opened.file.sync();
		await assertWriteCurrent();
		const after = await opened.file.stat();
		const named = await lstat(target);
		if (
			!sameIdentity(before, after) ||
			!sameStableStat(after, named) ||
			after.nlink !== 1
		)
			throw new Error(`Goal candidate write target changed: ${path}`);
		await revalidateAncestors(opened.ancestors);
	} finally {
		await opened.file.close().catch(() => undefined);
		await closeAncestors(opened.ancestors);
	}
}

async function pruneEmptyWorkspaceParents(
	root: string,
	files: Array<{ path: string; value: GoalFileValue | null }>,
	assertWriteCurrent: () => Promise<void>,
	assertWriteLive: () => void,
): Promise<void> {
	for (const { path, value } of files) {
		if (value !== null) continue;
		let current = dirname(resolve(root, ...path.split("/")));
		for (;;) {
			const rel = relative(root, current);
			if (
				rel === "" ||
				isAbsolute(rel) ||
				rel === ".." ||
				rel.startsWith(`..${sep}`)
			)
				break;
			let info;
			try {
				info = await lstat(current);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
				throw error;
			}
			await assertWriteCurrent();
			if (!info.isDirectory() || info.isSymbolicLink())
				throw new Error("Goal workspace ancestor is unsafe");
			try {
				assertWriteLive();
				await rmdir(current);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ENOTEMPTY" || code === "EEXIST") break;
				throw error;
			}
			await assertWriteCurrent();
			current = dirname(current);
		}
	}
}

async function ensureWorkspaceParent(
	root: string,
	targetParent: string,
	assertWriteCurrent?: () => Promise<void>,
	assertWriteLive?: () => void,
): Promise<void> {
	const rel = relative(root, targetParent);
	if (rel === "") return;
	if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
		throw new Error("Goal workspace path escaped root");
	let current = root;
	for (const component of rel.split(sep)) {
		current = join(current, component);
		try {
			if (assertWriteCurrent) await assertWriteCurrent();
			assertWriteLive?.();
			await mkdir(current, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		if (assertWriteCurrent) await assertWriteCurrent();
		const info = await lstat(current);
		if (assertWriteCurrent) await assertWriteCurrent();
		if (!info.isDirectory() || info.isSymbolicLink())
			throw new Error("Goal workspace ancestor is unsafe");
	}
}

async function assertExactWorkspaceCensus(
	root: string,
	scope: string[],
	allowGitControl: boolean,
): Promise<void> {
	const expectedFiles = new Set(scope);
	const allowedDirectoryPrefixes = new Set<string>();
	for (const path of scope) {
		const parts = path.split("/");
		for (let index = 1; index < parts.length; index++)
			allowedDirectoryPrefixes.add(parts.slice(0, index).join("/"));
	}
	const actualFiles = new Set<string>();
	const actualDirectories = new Set<string>();
	async function visit(directory: string, prefix: string): Promise<void> {
		const entries = await readdir(directory, { withFileTypes: true });
		const folded = new Set<string>();
		for (const entry of entries) {
			const lower = entry.name.toLowerCase();
			if (folded.has(lower))
				throw new Error("Goal workspace contains a case collision");
			folded.add(lower);
			if (prefix === "" && entry.name === ".git" && allowGitControl) continue;
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			const path = join(directory, entry.name);
			const info = await lstat(path);
			if (info.isSymbolicLink())
				throw new Error(`Goal workspace symlink rejected: ${rel}`);
			if (info.isDirectory()) {
				if (!allowedDirectoryPrefixes.has(rel))
					throw new Error(`Goal workspace extra directory rejected: ${rel}`);
				actualDirectories.add(rel);
				await visit(path, rel);
			} else if (info.isFile()) {
				if (!expectedFiles.has(rel))
					throw new Error(`Goal workspace extra write rejected: ${rel}`);
				actualFiles.add(rel);
			} else {
				throw new Error(`Goal workspace unsupported object rejected: ${rel}`);
			}
		}
	}
	await visit(root, "");
	const requiredDirectories = new Set<string>();
	for (const path of actualFiles) {
		const parts = path.split("/");
		for (let index = 1; index < parts.length; index++)
			requiredDirectories.add(parts.slice(0, index).join("/"));
	}
	for (const path of actualDirectories) {
		if (!requiredDirectories.has(path))
			throw new Error(`Goal workspace extra directory rejected: ${path}`);
	}
}

async function readGitHeadFile(
	root: string,
	headOid: string,
	path: string,
	artifactRoot?: string,
): Promise<GoalFileValue | null> {
	const output = await gitBuffer(root, [
		"ls-tree",
		"-z",
		headOid,
		"--",
		`:(literal)${path}`,
	]);
	if (output.length === 0) return null;
	const entries = output.toString("utf8").split("\0").filter(Boolean);
	if (entries.length !== 1)
		throw new Error(`Goal Git HEAD path is ambiguous: ${path}`);
	const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t(.+)$/u.exec(
		entries[0],
	);
	if (!match || match[3] !== path)
		throw new Error(`Goal Git HEAD path type is unsupported: ${path}`);
	return gitBlob(root, match[2], match[1], artifactRoot, `head:${path}`);
}

async function readGitIndexFile(
	root: string,
	path: string,
	artifactRoot?: string,
): Promise<GoalFileValue | null> {
	const output = await gitBuffer(root, [
		"ls-files",
		"--stage",
		"-z",
		"--",
		`:(literal)${path}`,
	]);
	if (output.length === 0) return null;
	const entries = output.toString("utf8").split("\0").filter(Boolean);
	if (entries.length !== 1)
		throw new Error(`Goal Git index path is unmerged/ambiguous: ${path}`);
	const match = /^(100644|100755) ([a-f0-9]{40,64}) 0\t(.+)$/u.exec(entries[0]);
	if (!match || match[3] !== path || /^0+$/u.test(match[2]))
		throw new Error(`Goal Git index path type is unsupported: ${path}`);
	return gitBlob(root, match[2], match[1], artifactRoot, `index:${path}`);
}

async function gitBlob(
	root: string,
	objectId: string,
	mode: string,
	artifactRoot?: string,
	version = "blob",
): Promise<GoalFileValue> {
	const chunks: Buffer[] = [], hash = createHash("sha256");
	const locator = `source/${goalHash({ objectId, version })}`;
	const published = artifactRoot ? join(artifactRoot, locator) : undefined;
	const stagingParent = artifactRoot ? await openParentWithPinnedAncestors(artifactRoot, locator) : undefined;
	if (stagingParent && stagingParent.target !== published)
		throw new Error("Goal Git artifact staging path escaped its private root");
	const temporary = published ? `${published}.stage-${randomUUID()}` : undefined;
	const destination = temporary
		? await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600)
		: undefined;
	let bytes = 0, newlines = 0, lastByte = -1, stderr = "";
	let child: ReturnType<typeof spawn> | undefined;
	let exited: Promise<number | null> | undefined;
	let failed = false, failure: unknown;
	let original: Stats | undefined;
	try {
		original = await destination?.stat();
		if (original && (!original.isFile() || original.nlink !== 1 ||
			original.uid !== process.getuid?.()))
			throw new Error("Goal Git artifact descriptor is not private regular storage");
		const started = spawn("git", gitArguments(["cat-file", "blob", objectId]), {
			cwd: root, env: gitEnvironment(), stdio: ["ignore", "pipe", "pipe"],
			timeout: MAX_GIT_COMMAND_MS, killSignal: "SIGKILL", windowsHide: true,
		});
		child = started;
		let spawnError: Error | undefined;
		started.once("error", error => { spawnError = error; });
		exited = new Promise(resolveCode => { started.once("close", resolveCode); });
		if (!started.stdout || !started.stderr) throw new Error("Goal Git blob stream unavailable");
		started.stderr.setEncoding("utf8"); started.stderr.on("data", value => {
			if (stderr.length < MAX_GIT_OUTPUT_BYTES) stderr += value.slice(0, MAX_GIT_OUTPUT_BYTES - stderr.length);
		});
		for await (const value of started.stdout) {
			const chunk = Buffer.from(value);
			hash.update(chunk);
			for (const byte of chunk) if (byte === 10) newlines += 1;
			if (bytes < MAX_FILE_BYTES) chunks.push(Buffer.from(chunk.subarray(0, MAX_FILE_BYTES - bytes)));
			if (destination) {
				let offset = 0;
				while (offset < chunk.length) {
					const written = await destination.write(chunk, offset, chunk.length - offset, null);
					if (written.bytesWritten <= 0) throw new Error("Goal Git artifact write made no progress");
					offset += written.bytesWritten;
				}
			}
			lastByte = chunk[chunk.length - 1]!;
			bytes += chunk.length;
		}
		const code = await exited;
		if (spawnError) throw new Error("Goal Git blob launch failed", { cause: spawnError });
		if (code !== 0) throw new Error(`Goal Git blob read failed: ${stderr}`);
		if (destination && original && temporary) {
			await destination.sync();
			const [observed, named] = await Promise.all([
				destination.stat(), lstat(temporary),
			]);
			if (!observed.isFile() || observed.nlink !== 1 || observed.size !== bytes ||
				observed.mode !== original.mode || observed.uid !== original.uid ||
				!sameIdentity(original, observed) || !sameStableStat(observed, named))
				throw new Error("Goal Git artifact descriptor changed during publication");
			if (await sha256File(temporary) !== hash.copy().digest("hex"))
				throw new Error("Goal Git artifact bytes changed during publication");
		}
	} catch (error) {
		failed = true;
		failure = error;
	} finally {
		if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await exited;
		try {
			await destination?.close();
		} catch (error) {
			if (failed) failure = new AggregateError([failure, error], "Goal Git blob failed and descriptor cleanup failed");
			else {
				failed = true;
				failure = error;
			}
		}
	}
	if (failed) {
		try {
			if (temporary && original) await unlinkOwnedTemporary(temporary, original, stagingParent!.ancestors);
		} catch (cleanup) {
			throw new AggregateError([failure, cleanup], "Goal Git blob failed and staging cleanup failed");
		} finally {
			if (stagingParent) await closeAncestors(stagingParent.ancestors);
		}
		throw failure;
	}
	if (temporary && published) {
		try {
			await revalidateAncestors(stagingParent!.ancestors);
			const staged = await lstat(temporary);
			if (!original || !sameIdentity(original, staged) || !staged.isFile() || staged.isSymbolicLink() ||
				staged.nlink !== 1 || staged.size !== bytes)
				throw new Error("Goal Git artifact descriptor changed during publication");
			if (bytes > MAX_FILE_BYTES) {
				await link(temporary, published);
				await unlinkOwnedTemporary(temporary, original, stagingParent!.ancestors, true);
			} else await unlinkOwnedTemporary(temporary, original, stagingParent!.ancestors);
		} catch (error) {
			try {
				if (original) await unlinkOwnedTemporary(temporary, original, stagingParent!.ancestors);
			} catch (cleanup) {
				throw new AggregateError([error, cleanup], "Goal Git artifact publication and cleanup failed");
			}
			throw error;
		} finally {
			await closeAncestors(stagingParent!.ancestors);
		}
	}
	const normalizedMode = mode === "100755" ? "0755" : "0644";
	if (bytes <= MAX_FILE_BYTES) return {
		kind: "file", links: 1, mode: normalizedMode, hex: Buffer.concat(chunks).toString("hex"),
	};
	return {
		kind: "artifact", links: 1, mode: normalizedMode, locator,
		sha256: hash.digest("hex"), bytes, lines: bytes === 0 ? 0 : newlines + (lastByte === 10 ? 0 : 1),
	};
}

async function inspectGitIndex(
	root: string,
): Promise<{ identity: PhysicalIdentity; digest: string }> {
	const rawIndexPath = await gitText(root, ["rev-parse", "--git-path", "index"]);
	const indexPathOutput = rawIndexPath.trim();
	const indexPath = isAbsolute(indexPathOutput)
		? indexPathOutput
		: resolve(root, indexPathOutput);
	return hashStableFile(indexPath, MAX_INDEX_BYTES, true);
}

async function assertGitIndexUnchanged(
	root: string,
	identity: PhysicalIdentity,
	digest: string,
): Promise<void> {
	const current = await inspectGitIndex(root);
	if (!sameFileIdentity(current.identity, identity) || current.digest !== digest)
		throw new Error("Goal workspace Git index changed");
}

async function hashStableFile(
	path: string,
	maxBytes: number,
	requireOneLink: boolean,
): Promise<{ identity: PhysicalIdentity; digest: string }> {
	const handle = await open(
		path,
		constants.O_RDONLY | NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const before = await handle.stat();
		if (
			!before.isFile() ||
			(requireOneLink && before.nlink !== 1) ||
			before.size > maxBytes
		)
			throw new Error("Goal protected file identity/size is unsupported");
		const bytes = await readBoundedHandle(handle, maxBytes);
		const [after, named] = await Promise.all([handle.stat(), lstat(path)]);
		if (!sameStableStat(before, after) || !sameStableStat(after, named))
			throw new Error("Goal protected file changed during observation");
		return {
			identity: {
				path,
				dev: after.dev,
				ino: after.ino,
				size: after.size,
				mtimeMs: after.mtimeMs,
				ctimeMs: after.ctimeMs,
				mode: after.mode,
				nlink: after.nlink,
			},
			digest: sha256(bytes),
		};
	} finally {
		await handle.close();
	}
}

async function assertStableFile(
	path: string,
	identity: PhysicalIdentity,
	digest: string,
	maxBytes: number,
): Promise<void> {
	const current = await hashStableFile(path, maxBytes, false);
	if (!sameFileIdentity(current.identity, identity) || current.digest !== digest)
		throw new Error("Goal protected workspace control changed");
}

async function readBoundedHandle(
	handle: FileHandle,
	maxBytes: number,
): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let offset = 0;
	for (;;) {
		const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - offset));
		if (chunk.length === 0) throw new Error("Goal bounded read exceeded limit");
		const result = await handle.read(chunk, 0, chunk.length, offset);
		if (result.bytesRead === 0) break;
		chunks.push(chunk.subarray(0, result.bytesRead));
		offset += result.bytesRead;
		if (offset > maxBytes) throw new Error("Goal bounded read exceeded limit");
	}
	return Buffer.concat(chunks, offset);
}

async function prepareAbsentWorkspacePath(
	path: string,
	assertWriteCurrent: () => Promise<void>,
): Promise<string> {
	const absolute = resolve(path);
	const parent = dirname(absolute);
	const canonicalParent = await canonicalExistingDirectory(
		parent,
		"workspace parent",
	);
	await assertWriteCurrent();
	const target = join(canonicalParent, basename(absolute));
	try {
		await lstat(target);
		throw new Error("Goal workspace path must be initially absent");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await assertWriteCurrent();
	return target;
}

async function canonicalExistingDirectory(
	path: string,
	label: string,
): Promise<string> {
	const absolute = resolve(path);
	const canonical = await realpath(absolute);
	const info = await lstat(canonical);
	if (!info.isDirectory() || info.isSymbolicLink())
		throw new Error(`Goal ${label} is not a real directory`);
	await assertNoApplicationSymlinkAncestors(absolute);
	return canonical;
}

async function assertNoApplicationSymlinkAncestors(
	path: string,
): Promise<void> {
	let current: string = sep;
	for (const component of resolve(path).slice(1).split(sep).filter(Boolean)) {
		current = join(current, component);
		const info = await lstat(current);
		if (info.isSymbolicLink() && !isAllowedSystemAlias(current))
			throw new Error("Goal filesystem ancestor must not be a symlink");
	}
}

function isAllowedSystemAlias(path: string): boolean {
	return process.platform === "darwin" && (path === "/var" || path === "/tmp");
}

async function directoryIdentity(path: string): Promise<PhysicalIdentity> {
	const info = await lstat(path);
	if (!info.isDirectory() || info.isSymbolicLink())
		throw new Error("Goal directory physical identity mismatch");
	return { path, dev: info.dev, ino: info.ino };
}

async function assertDirectoryIdentity(
	identity: PhysicalIdentity,
): Promise<void> {
	const info = await lstat(identity.path);
	if (
		!info.isDirectory() ||
		info.isSymbolicLink() ||
		!sameIdentity(info, identity)
	)
		throw new Error("Goal directory physical identity changed");
}

async function assertNotGitRoot(root: string): Promise<void> {
	const gitControlPresent = await hasGitControlAncestor(root);
	try {
		await gitText(root, ["rev-parse", "--show-toplevel"]);
	} catch (error) {
		if (!gitControlPresent && isExpectedNotGitRepositoryFailure(error)) return;
		throw new Error(
			"Goal nonGit mode Git probe failed; refusing to assume a non-Git origin",
			{ cause: error },
		);
	}
	throw new Error("Goal nonGit mode refuses a Git origin");
}

async function hasGitControlAncestor(root: string): Promise<boolean> {
	let current = resolve(root);
	for (;;) {
		try {
			await lstat(join(current, ".git"));
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const parent = dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

function isExpectedNotGitRepositoryFailure(error: unknown): boolean {
	const candidate = error as { code?: unknown; stderr?: unknown };
	return (
		(candidate.code === 128 || candidate.code === "128") &&
		typeof candidate.stderr === "string" &&
		/\bnot a git repository\b/u.test(candidate.stderr)
	);
}

function physicalOriginId(identity: PhysicalIdentity): string {
	return `origin-${sha256(Buffer.from(`${identity.path}\0${identity.dev}\0${identity.ino}`)).slice(0, 40)}`;
}

function pathsOverlap(left: string, right: string): boolean {
	const rel = relative(left, right);
	const reverse = relative(right, left);
	return (
		rel === "" ||
		(!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)) ||
		(!isAbsolute(reverse) && reverse !== ".." && !reverse.startsWith(`..${sep}`))
	);
}

function sameIdentity(
	left: { dev: number; ino: number },
	right: { dev: number; ino: number },
): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function sameStableStat(left: Stats, right: Stats): boolean {
	return (
		sameIdentity(left, right) &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs &&
		left.mode === right.mode &&
		left.nlink === right.nlink
	);
}

function sameFileIdentity(
	left: PhysicalIdentity,
	right: PhysicalIdentity,
): boolean {
	return (
		sameIdentity(left, right) &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs &&
		left.mode === right.mode &&
		left.nlink === right.nlink
	);
}

function sha256(value: Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

async function gitCommand(root: string, args: string[]): Promise<void> {
	await execFileAsync("git", gitArguments(args), {
		...gitExecOptions(root, MAX_GIT_OUTPUT_BYTES),
		encoding: "buffer",
	});
}

async function gitText(root: string, args: string[]): Promise<string> {
	const result = await execFileAsync("git", gitArguments(args), {
		...gitExecOptions(root, MAX_GIT_OUTPUT_BYTES),
		encoding: "utf8",
	});
	return result.stdout;
}

async function gitBuffer(
	root: string,
	args: string[],
	maxBuffer = MAX_GIT_OUTPUT_BYTES,
): Promise<Buffer> {
	const result = await execFileAsync("git", gitArguments(args), {
		...gitExecOptions(root, maxBuffer),
		encoding: "buffer",
	});
	return result.stdout;
}

function gitExecOptions(root: string, maxBuffer: number) {
	return {
		cwd: root,
		maxBuffer,
		timeout: MAX_GIT_COMMAND_MS,
		killSignal: "SIGKILL" as const,
		windowsHide: true,
		env: gitEnvironment(),
	};
}

function gitArguments(args: string[]): string[] {
	return [
		"--no-pager",
		"-c",
		"core.hooksPath=/dev/null",
		"-c",
		"core.fsmonitor=false",
		"-c",
		"core.untrackedCache=false",
		...args,
	];
}

function gitEnvironment(): NodeJS.ProcessEnv {
	return {
		PATH: SAFE_GIT_PATH,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_SYSTEM: devNull,
		GIT_CONFIG_GLOBAL: devNull,
		GIT_CONFIG_COUNT: "0",
		GIT_TERMINAL_PROMPT: "0",
		GIT_PAGER: "cat",
		PAGER: "cat",
		LC_ALL: "C",
		LANG: "C",
	};
}
