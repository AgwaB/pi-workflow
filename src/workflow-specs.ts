import {
	lstat,
	open,
	opendir,
	readFile,
	readdir,
	realpath,
	stat,
} from "node:fs/promises";
import {
	basename,
	dirname,
	extname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
	isArtifactGraphWorkflowSpecShape,
	parseArtifactGraphWorkflowSpec,
} from "./artifact-graph-schema.js";
import { piAgentDir } from "./pi-agent-dir.js";
import {
	type ArtifactGraphWorkflowSpec,
	WorkflowValidationError,
} from "./types.js";

const SPEC_EXTENSIONS = new Set([".json"]);
const PACKAGE_WORKFLOW_ROOT = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"workflows",
);
const RESERVED_WORKFLOW_FILES = new Set([
	"index.json",
	"index-supervisor-error.json",
]);
const SPEC_SCAN_CONCURRENCY = 16;

/** Frozen auto-routing catalog bounds; see internal/maintenance/.../BOUNDS.md. */
export const WORKFLOW_ROUTING_CATALOG_BOUNDS = Object.freeze({
	maxCandidates: 48,
	maxSpecBytes: 65_536,
	maxAggregateBytes: 524_288,
	maxRootEntries: 256,
	maxJsonDepth: 16,
	maxJsonNodes: 4_096,
	ioConcurrency: 8,
});

class RoutingCatalogAggregateLimitError extends Error {}

function assertBoundedRoutingCatalogJson(value: unknown): void {
	const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
	let nodes = 0;
	while (stack.length > 0) {
		const item = stack.pop()!;
		if (item.depth > WORKFLOW_ROUTING_CATALOG_BOUNDS.maxJsonDepth)
			throw new Error(
				`metadata exceeds JSON depth limit ${WORKFLOW_ROUTING_CATALOG_BOUNDS.maxJsonDepth}`,
			);
		nodes += 1;
		if (nodes > WORKFLOW_ROUTING_CATALOG_BOUNDS.maxJsonNodes)
			throw new Error(
				`metadata exceeds JSON node limit ${WORKFLOW_ROUTING_CATALOG_BOUNDS.maxJsonNodes}`,
			);
		if (!item.value || typeof item.value !== "object") continue;
		for (const child of Array.isArray(item.value)
			? item.value
			: Object.values(item.value as Record<string, unknown>))
			stack.push({ value: child, depth: item.depth + 1 });
	}
}

// Order-preserving bounded-concurrency map: keeps result[i] aligned with
// items[i] while capping simultaneous filesystem operations so large workflow
// roots do not spawn an unbounded Promise.all fan-out.
async function mapBounded<T, R>(
	items: readonly T[],
	limit: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	const workerCount = Math.min(
		Math.max(1, Math.floor(limit)),
		items.length || 1,
	);
	await Promise.all(
		Array.from({ length: workerCount }, async () => {
			while (true) {
				const index = nextIndex;
				nextIndex += 1;
				if (index >= items.length) return undefined;
				results[index] = await worker(items[index]!, index);
			}
		}),
	);
	return results;
}
export interface ResolvedWorkflowSpecRef {
	inputRef: string;
	specPath: string;
	workflowName?: string;
	workflowRoot?: string;
}

export interface WorkflowSpecRecord {
	name: string;
	fileName: string;
	aliases: string[];
	specPath: string;
	workflowRoot: string;
}

interface WorkflowCandidate {
	name: string;
	file: string;
	root: string;
	priority: number;
}

interface WorkflowRoot {
	path: string;
	priority: number;
	scope: WorkflowRoutingScope;
}

export type WorkflowRoutingScope =
	| "project-shared"
	| "project-private"
	| "user"
	| "package";

/** A parsed, bounded metadata-only record for `/workflow auto`. */
export interface WorkflowRoutingSpecRecord extends WorkflowSpecRecord {
	scope: WorkflowRoutingScope;
	priority: number;
	bytes: number;
	specSha256: string;
	spec: ArtifactGraphWorkflowSpec;
	ambiguousAliases: string[];
}

export interface WorkflowRoutingCatalog {
	records: WorkflowRoutingSpecRecord[];
	/** Candidates enumerated before the fixed cap; not a claim of full-root total. */
	totalDiscovered: number;
	partial: boolean;
	issues: Array<{ specPath?: string; reason: string }>;
}

export async function resolveWorkflowRef(
	ref: string,
	cwd: string,
): Promise<ResolvedWorkflowSpecRef> {
	const trimmed = ref.trim();
	if (trimmed === "") {
		throw new WorkflowValidationError([
			{ path: "$spec", message: "workflow name or spec path is required" },
		]);
	}

	const pathCandidate = resolve(cwd, trimmed);
	if (await isFile(pathCandidate)) {
		return { inputRef: ref, specPath: pathCandidate };
	}

	// A bundle directory (`<name>/spec.json` alongside schemas/helpers) is the
	// documented storage form, so accept the directory itself as a path ref.
	const bundleCandidate = join(pathCandidate, "spec.json");
	if (
		(isPathLike(trimmed) || (await isDirectory(pathCandidate))) &&
		(await isFile(bundleCandidate))
	) {
		return { inputRef: ref, specPath: bundleCandidate };
	}

	if (isPathLike(trimmed)) {
		throw new WorkflowValidationError([
			{
				path: trimmed,
				message:
					"workflow spec file not found (expected a .json spec or a bundle directory containing spec.json)",
			},
		]);
	}

	validateWorkflowName(trimmed);
	const matches = await findWorkflowCandidates(trimmed, cwd);
	if (matches.length === 0) {
		throw new WorkflowValidationError([
			{ path: trimmed, message: "workflow name or spec file not found" },
		]);
	}
	if (matches.length > 1) {
		throw new WorkflowValidationError([
			{
				path: trimmed,
				message: `ambiguous workflow name; matches: ${matches.map((match) => relative(cwd, match.file) || match.file).join(", ")}`,
			},
		]);
	}

	const [match] = matches;
	return {
		inputRef: ref,
		specPath: match!.file,
		workflowName: match!.name,
		workflowRoot: match!.root,
	};
}

export function isSpecFileName(fileName: string): boolean {
	return (
		SPEC_EXTENSIONS.has(extname(fileName).toLowerCase()) &&
		!RESERVED_WORKFLOW_FILES.has(fileName)
	);
}

export async function listWorkflows(
	cwd: string,
): Promise<WorkflowSpecRecord[]> {
	const roots = workflowRoots(cwd);
	const nested = await Promise.all(
		roots.map(async (root) => {
			const files = await listSpecFiles(root.path);
			return files.flatMap((file) => {
				const aliases = aliasesFor(file, root.path);
				// Discovery is a user-facing registry. Do not advertise a ref that
				// the name resolver would reject (explicit path refs remain valid).
				if (aliases.length === 0) return [];
				return [
					{
						name: aliases[1] ?? aliases[0]!,
						fileName: basename(file),
						aliases,
						specPath: file,
						workflowRoot: workflowRootFor(file, root.path),
						priority: root.priority,
					},
				];
			});
		}),
	);

	return dedupeWorkflowRecords(nested.flat()).sort((left, right) => {
		const byName = left.name.localeCompare(right.name);
		return byName !== 0 ? byName : left.specPath.localeCompare(right.specPath);
	});
}

/**
 * Registry-equivalent, metadata-only catalog for auto routing. It reads only
 * direct JSON specs/bundle `spec.json` files under the normal four roots; it
 * never imports helpers/controllers, validates external schemas, or scans run
 * snapshots. Oversize and malformed entries are reported rather than parsed
 * partially or silently substituted.
 */
export async function listWorkflowRoutingSpecs(
	cwd: string,
): Promise<WorkflowRoutingCatalog> {
	const bounds = WORKFLOW_ROUTING_CATALOG_BOUNDS;
	const issues: WorkflowRoutingCatalog["issues"] = [];
	const candidates: Array<{ file: string; root: WorkflowRoot }> = [];
	// Even an unreadable/oversize entry can win normal resolver precedence.
	// Reserve its aliases without reading beyond the metadata budget.
	const aliasClaims: Array<{ file: string; root: WorkflowRoot }> = [];
	const resolvedPaths = new Map<string, string>();
	let uncertainPriority = Number.POSITIVE_INFINITY;
	for (const root of workflowRoots(cwd)) {
		let discovered: { files: string[]; truncated: boolean };
		try {
			discovered = await listRoutingSpecFiles(root.path, bounds.maxRootEntries);
		} catch (error) {
			uncertainPriority = Math.min(uncertainPriority, root.priority);
			issues.push({
				specPath: root.path,
				reason: `partial-catalog: could not enumerate workflow root: ${error instanceof Error ? error.message : String(error)}`,
			});
			continue;
		}
		if (discovered.truncated) {
			uncertainPriority = Math.min(uncertainPriority, root.priority);
			issues.push({
				specPath: root.path,
				reason: `partial-catalog: root entry limit ${bounds.maxRootEntries} reached`,
			});
		}
		aliasClaims.push(...discovered.files.map((file) => ({ file, root })));
		for (const file of discovered.files) {
			if (candidates.length >= bounds.maxCandidates) {
				issues.push({
					reason: `partial-catalog: candidate limit ${bounds.maxCandidates} reached`,
				});
				break;
			}
			candidates.push({ file, root });
		}
		// Reaching the cap means lower-priority roots may not have been scanned,
		// even when this root happened to contain exactly the final record.
		if (candidates.length >= bounds.maxCandidates) {
			if (
				!issues.some(
					(issue) =>
						issue.reason ===
						`partial-catalog: candidate limit ${bounds.maxCandidates} reached`,
				)
			)
				issues.push({
					reason: `partial-catalog: candidate limit ${bounds.maxCandidates} reached`,
				});
			break;
		}
	}

	let aggregateBytes = 0;
	const records: WorkflowRoutingSpecRecord[] = [];
	for (const candidate of candidates) {
		let text: string;
		let bytes: number;
		let safeFile: string;
		try {
			safeFile = await resolveRoutingSpecPath(candidate.file, candidate.root.path);
			const result = await readUtf8SpecBounded(
				safeFile,
				bounds.maxSpecBytes,
				bounds.maxAggregateBytes - aggregateBytes,
			);
			text = result.text;
			bytes = result.bytes;
		} catch (error) {
			if (error instanceof RoutingCatalogAggregateLimitError) {
				issues.push({
					specPath: candidate.file,
					reason: `partial-catalog: aggregate UTF-8 limit ${bounds.maxAggregateBytes} reached`,
				});
				break;
			}
			issues.push({
				specPath: candidate.file,
				reason: error instanceof Error ? error.message : String(error),
			});
			continue;
		}
		if (aggregateBytes + bytes > bounds.maxAggregateBytes) {
			issues.push({
				specPath: candidate.file,
				reason: `partial-catalog: aggregate UTF-8 limit ${bounds.maxAggregateBytes} reached`,
			});
			break;
		}
		aggregateBytes += bytes;
		let spec: ArtifactGraphWorkflowSpec;
		try {
			const parsed = JSON.parse(text);
			assertBoundedRoutingCatalogJson(parsed);
			if (!isArtifactGraphWorkflowSpecShape(parsed))
				throw new Error("not an artifact-graph workflow spec");
			spec = parseArtifactGraphWorkflowSpec(parsed);
		} catch (error) {
			issues.push({
				specPath: candidate.file,
				reason: `invalid metadata: ${error instanceof Error ? error.message : String(error)}`,
			});
			continue;
		}
		const aliases = aliasesFor(candidate.file, candidate.root.path);
		if (aliases.length === 0) continue;
		resolvedPaths.set(candidate.file, safeFile);
		records.push({
			name: aliases[1] ?? aliases[0]!,
			fileName: basename(candidate.file),
			aliases,
			specPath: safeFile,
			workflowRoot: workflowRootFor(candidate.file, candidate.root.path),
			scope: candidate.root.scope,
			priority: candidate.root.priority,
			bytes,
			specSha256: createHash("sha256").update(text, "utf8").digest("hex"),
			spec,
			ambiguousAliases: [],
		});
	}

	const winning = resolveRoutingCatalogAliasWinners(
		records,
		aliasClaims.map(({ file, root }) => ({
			specPath: resolvedPaths.get(file) ?? file,
			aliases: aliasesFor(file, root.path),
			priority: root.priority,
		})),
		uncertainPriority,
	);
	return {
		records: winning,
		totalDiscovered: candidates.length,
		// Any excluded file means this is not a complete comparison universe.
		// Keep invalid/oversize records visible as issues rather than claiming them unfit.
		partial: issues.length > 0,
		issues,
	};
}

/**
 * Resolve catalog precedence by every runnable alias, not just each record's
 * display name. A lower-priority collision must not make the actual resolver's
 * higher-priority winner look ambiguous. Collapse aliases that resolve to the
 * same real spec so one physical workflow cannot create duplicate auto cards.
 */
function resolveRoutingCatalogAliasWinners(
	records: readonly WorkflowRoutingSpecRecord[],
	claims: readonly Pick<WorkflowRoutingSpecRecord, "specPath" | "aliases" | "priority">[],
	uncertainPriority: number,
): WorkflowRoutingSpecRecord[] {
	const byIdentity = new Map<string, WorkflowRoutingSpecRecord[]>();
	for (const record of records) {
		const group = byIdentity.get(record.specPath) ?? [];
		group.push(record);
		byIdentity.set(record.specPath, group);
	}

	const aliasPriorities = new Map<string, Map<string, number>>();
	for (const claim of claims) {
		for (const alias of claim.aliases) {
			const identities = aliasPriorities.get(alias) ?? new Map<string, number>();
			const previous = identities.get(claim.specPath);
			if (previous === undefined || claim.priority < previous)
				identities.set(claim.specPath, claim.priority);
			aliasPriorities.set(alias, identities);
		}
	}

	const winnersByIdentity = new Map<
		string,
		{ aliases: string[]; unambiguousAliases: string[]; ambiguousAliases: string[] }
	>();
	for (const [alias, identities] of aliasPriorities) {
		const priority = Math.min(...identities.values());
		const winners = [...identities.entries()]
			.filter(([, candidatePriority]) => candidatePriority === priority)
			.map(([identity]) => identity);
		for (const identity of winners) {
			const current = winnersByIdentity.get(identity) ?? {
				aliases: [],
				unambiguousAliases: [],
				ambiguousAliases: [],
			};
			current.aliases.push(alias);
			if (winners.length === 1 && priority < uncertainPriority)
				current.unambiguousAliases.push(alias);
			else current.ambiguousAliases.push(alias);
			winnersByIdentity.set(identity, current);
		}
	}

	const winners: WorkflowRoutingSpecRecord[] = [];
	for (const [identity, group] of byIdentity) {
		const aliases = winnersByIdentity.get(identity);
		if (!aliases) continue;
		const base = [...group].sort(
			(left, right) =>
				left.priority - right.priority ||
				left.specPath.localeCompare(right.specPath),
		)[0]!;
		const preferred = base.aliases[1] ?? base.aliases[0];
		const orderedAliases = [...new Set(aliases.aliases)].sort();
		const orderedUnambiguous = [...new Set(aliases.unambiguousAliases)].sort();
		const launchAliases = orderedUnambiguous.length
			? orderedUnambiguous
			: orderedAliases;
		const name =
			(preferred && launchAliases.includes(preferred) ? preferred : undefined) ??
			launchAliases[0]!;
		winners.push({
			...base,
			name,
			aliases: orderedAliases,
			// Excluded entries and unenumerated higher/equal roots cannot grant
			// an alias to a lower source merely because it fit the read budget.
			ambiguousAliases:
				orderedUnambiguous.length === 0
					? [...new Set(aliases.ambiguousAliases)].sort()
					: [],
		});
	}
	return winners.sort(
		(left, right) =>
			left.name.localeCompare(right.name) ||
			left.specPath.localeCompare(right.specPath),
	);
}

async function listRoutingSpecFiles(
	root: string,
	maxEntries: number,
): Promise<{ files: string[]; truncated: boolean }> {
	let directory: Awaited<ReturnType<typeof opendir>>;
	try {
		directory = await opendir(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { files: [], truncated: false };
		throw error;
	}
	const entries: Array<{
		name: string;
		isFile(): boolean;
		isDirectory(): boolean;
	}> = [];
	let truncated = false;
	for await (const entry of directory) {
		if (entries.length >= maxEntries) {
			truncated = true;
			break;
		}
		entries.push(entry);
	}
	const files: string[] = [];
	for (const entry of entries.sort((left, right) =>
		left.name.localeCompare(right.name),
	)) {
		if (entry.isFile() && isSpecFileName(entry.name)) {
			files.push(join(root, entry.name));
			continue;
		}
		if (!entry.isDirectory()) continue;
		const bundleRoot = join(root, entry.name);
		if (await isWorkflowRunStateDirectory(bundleRoot)) continue;
		const spec = join(bundleRoot, "spec.json");
		if (await isFile(spec)) files.push(spec);
	}
	return { files, truncated };
}

/** Auto discovery does not follow a bundle spec symlink outside its declared root. */
async function resolveRoutingSpecPath(
	file: string,
	root: string,
): Promise<string> {
	const entry = await lstat(file);
	if (!entry.isFile() || entry.isSymbolicLink())
		throw new Error("workflow metadata must be a regular non-symlink spec file");
	const [resolvedRoot, resolvedFile] = await Promise.all([
		realpath(root),
		realpath(file),
	]);
	const escaped = relative(resolvedRoot, resolvedFile);
	if (escaped === ".." || escaped.startsWith(`..${sep}`) || isAbsolute(escaped))
		throw new Error("workflow metadata path escapes its discovery root");
	return resolvedFile;
}

async function readUtf8SpecBounded(
	file: string,
	maxBytes: number,
	remainingAggregateBytes: number,
): Promise<{ text: string; bytes: number }> {
	const pathBefore = await lstat(file);
	if (!pathBefore.isFile() || pathBefore.isSymbolicLink())
		throw new Error("not a regular non-symlink workflow spec file");
	const handle = await open(file, "r");
	try {
		const before = await handle.stat();
		if (
			!before.isFile() ||
			before.dev !== pathBefore.dev ||
			before.ino !== pathBefore.ino
		)
			throw new Error("workflow spec path changed while metadata was opened");
		if (before.size > maxBytes)
			throw new Error(`metadata exceeds per-spec UTF-8 limit ${maxBytes}`);
		if (before.size > remainingAggregateBytes)
			throw new RoutingCatalogAggregateLimitError();
		const buffer = Buffer.alloc(before.size);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const [after, pathAfter] = await Promise.all([handle.stat(), lstat(file)]);
		if (
			bytesRead !== before.size ||
			after.size !== before.size ||
			after.dev !== before.dev ||
			after.ino !== before.ino ||
			!pathAfter.isFile() ||
			pathAfter.isSymbolicLink() ||
			pathAfter.dev !== before.dev ||
			pathAfter.ino !== before.ino
		)
			throw new Error("workflow spec changed while metadata was read");
		return { text: buffer.toString("utf8"), bytes: buffer.byteLength };
	} finally {
		await handle.close();
	}
}

function dedupeWorkflowRecords(
	records: Array<WorkflowSpecRecord & { priority: number }>,
): WorkflowSpecRecord[] {
	const byName = new Map<
		string,
		Array<WorkflowSpecRecord & { priority: number }>
	>();
	for (const record of records) {
		const group = byName.get(record.name) ?? [];
		group.push(record);
		byName.set(record.name, group);
	}

	return [...byName.values()].flatMap((group) => {
		const bestPriority = Math.min(...group.map((record) => record.priority));
		return group
			.filter((record) => record.priority === bestPriority)
			.map(({ priority: _priority, ...record }) => record);
	});
}

function workflowRoots(cwd: string): WorkflowRoot[] {
	return uniqueWorkflowRoots([
		{ path: resolve(cwd, "workflows"), priority: 0, scope: "project-shared" },
		{
			path: resolve(cwd, ".pi", "workflows"),
			priority: 1,
			scope: "project-private",
		},
		{ path: join(piAgentDir(), "workflows"), priority: 2, scope: "user" },
		{ path: PACKAGE_WORKFLOW_ROOT, priority: 3, scope: "package" },
	]);
}

function uniqueWorkflowRoots(roots: WorkflowRoot[]): WorkflowRoot[] {
	const seen = new Set<string>();
	const unique: WorkflowRoot[] = [];
	for (const root of roots) {
		const key = resolve(root.path);
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(root);
	}
	return unique;
}

async function findWorkflowCandidates(
	name: string,
	cwd: string,
): Promise<WorkflowCandidate[]> {
	const roots = workflowRoots(cwd);
	const nested = await Promise.all(
		roots.map(async (root) => {
			const files = await listSpecFiles(root.path);
			return files.flatMap((file) =>
				aliasesFor(file, root.path).includes(name)
					? [
							{
								name,
								file,
								root: workflowRootFor(file, root.path),
								priority: root.priority,
							},
						]
					: [],
			);
		}),
	);
	const matches = nested.flat();
	if (matches.length === 0) return [];
	const bestPriority = Math.min(...matches.map((match) => match.priority));
	return matches
		.filter((match) => match.priority === bestPriority)
		.sort((left, right) => left.file.localeCompare(right.file));
}

async function listSpecFiles(root: string): Promise<string[]> {
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}

	const flatFiles = entries
		.filter((entry) => entry.isFile() && isSpecFileName(entry.name))
		.map((entry) => join(root, entry.name));

	const directoryEntries = entries.filter((entry) => entry.isDirectory());
	const bundleSpecs = await mapBounded(
		directoryEntries,
		SPEC_SCAN_CONCURRENCY,
		async (entry) => {
			const bundleRoot = join(root, entry.name);
			if (await isWorkflowRunStateDirectory(bundleRoot)) return null;
			const bundleSpec = join(bundleRoot, "spec.json");
			return (await isFile(bundleSpec)) ? bundleSpec : null;
		},
	);

	return await filterRunnableSpecFiles([
		...flatFiles,
		...bundleSpecs.filter((spec): spec is string => spec !== null),
	]);
}

async function filterRunnableSpecFiles(
	files: readonly string[],
): Promise<string[]> {
	const checked = await mapBounded(files, SPEC_SCAN_CONCURRENCY, async (file) =>
		(await isRunnableSpecFile(file)) ? file : null,
	);
	return checked.filter((file): file is string => file !== null);
}

async function isRunnableSpecFile(file: string): Promise<boolean> {
	if (extname(file).toLowerCase() !== ".json") return false;
	try {
		return isArtifactGraphWorkflowSpecShape(
			JSON.parse(await readFile(file, "utf8")),
		);
	} catch {
		return false;
	}
}

// Run-state directories under .pi/workflows/ contain a spec.json snapshot of
// the workflow that produced them; they are records, not registrable bundles.
// Older dogfood/eval run ids used descriptive workflow_* names, so prefer the
// run.json marker over run-id shape when filtering registry candidates.
async function isWorkflowRunStateDirectory(path: string): Promise<boolean> {
	return await isFile(join(path, "run.json"));
}

function isBundleSpec(file: string, searchRoot: string): boolean {
	return (
		basename(file) === "spec.json" &&
		resolve(dirname(file)) !== resolve(searchRoot)
	);
}

function aliasesFor(file: string, searchRoot: string): string[] {
	const name = basename(file);
	const extension = extname(name);
	const aliases = isBundleSpec(file, searchRoot)
		? [basename(dirname(file))]
		: [name, name.slice(0, -extension.length)];
	return aliases.filter(isValidWorkflowName);
}

function workflowRootFor(file: string, searchRoot: string): string {
	return isBundleSpec(file, searchRoot) ? dirname(file) : searchRoot;
}

async function isFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function isPathLike(ref: string): boolean {
	return (
		isAbsolute(ref) ||
		ref === "." ||
		ref === ".." ||
		ref.startsWith("./") ||
		ref.startsWith("../") ||
		ref.includes("/") ||
		ref.includes("\\")
	);
}

function isValidWorkflowName(name: string): boolean {
	return !name.startsWith(".") && /^[A-Za-z0-9_.-]+$/.test(name);
}

function validateWorkflowName(name: string): void {
	if (name.startsWith(".")) {
		throw new WorkflowValidationError([
			{ path: name, message: "workflow names may not start with dot" },
		]);
	}
	if (!isValidWorkflowName(name)) {
		throw new WorkflowValidationError([
			{
				path: name,
				message:
					"workflow names may contain only letters, numbers, dot, underscore, and dash",
			},
		]);
	}
}
