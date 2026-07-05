import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import {
	basename,
	dirname,
	extname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

import { isArtifactGraphWorkflowSpecShape } from "./artifact-graph-schema.js";
import { WorkflowValidationError } from "./types.js";

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
				if (index >= items.length) return;
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

	if (isPathLike(trimmed)) {
		throw new WorkflowValidationError([
			{ path: trimmed, message: "workflow spec file not found" },
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
			return files.map((file) => {
				const aliases = aliasesFor(file, root.path);
				return {
					name: aliases[1] ?? aliases[0]!,
					fileName: basename(file),
					aliases,
					specPath: file,
					workflowRoot: workflowRootFor(file, root.path),
					priority: root.priority,
				};
			});
		}),
	);

	return dedupeWorkflowRecords(nested.flat()).sort((left, right) => {
		const byName = left.name.localeCompare(right.name);
		return byName !== 0 ? byName : left.specPath.localeCompare(right.specPath);
	});
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
		{ path: resolve(cwd, "workflows"), priority: 0 },
		{ path: resolve(cwd, ".pi", "workflows"), priority: 1 },
		{ path: join(homedir(), ".pi", "agent", "workflows"), priority: 2 },
		{ path: PACKAGE_WORKFLOW_ROOT, priority: 3 },
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
	const checked = await mapBounded(
		files,
		SPEC_SCAN_CONCURRENCY,
		async (file) => ((await isRunnableSpecFile(file)) ? file : null),
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
	if (isBundleSpec(file, searchRoot)) return [basename(dirname(file))];
	return [name, name.slice(0, -extension.length)];
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

function validateWorkflowName(name: string): void {
	if (name.startsWith(".")) {
		throw new WorkflowValidationError([
			{ path: name, message: "workflow names may not start with dot" },
		]);
	}
	if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
		throw new WorkflowValidationError([
			{
				path: name,
				message:
					"workflow names may contain only letters, numbers, dot, underscore, and dash",
			},
		]);
	}
}
