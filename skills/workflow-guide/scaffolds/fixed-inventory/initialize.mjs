#!/usr/bin/env node
import { constants } from "node:fs";
import {
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	rmdir,
	unlink,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertInventory } from "./helpers/exact-source-join.mjs";

export const BINDING_VERSION = "fixed-inventory-binding-v1";
export const MAX_BINDING_BYTES = 65_536;
export const OUTPUT_FILES = Object.freeze([
	"spec.json",
	"helpers/exact-source-join.mjs",
	"helpers/pipeline.mjs",
	"schemas/final-control.schema.json",
	"schemas/inventory-control.schema.json",
	"schemas/item-control.schema.json",
]);

const SOURCE_ROOT = dirname(fileURLToPath(import.meta.url));
const BINDING_KEYS = new Set(["description", "items", "name"]);
const WORKFLOW_NAME = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

/** Validate and clone the deliberately small caller-fixed inventory binding. */
export function validateFixedInventoryBinding(input) {
	if (!record(input)) throw new Error("binding must be a JSON object");
	if (!Object.hasOwn(input, "name") || !Object.hasOwn(input, "items"))
		throw new Error("binding must own name and items fields");
	const unknown = Object.keys(input).filter((key) => !BINDING_KEYS.has(key));
	if (unknown.length > 0)
		throw new Error(`binding has unsupported keys: ${unknown.sort().join(", ")}`);
	if (
		!text(input.name, 64) ||
		!WORKFLOW_NAME.test(input.name) ||
		input.name.endsWith("-")
	)
		throw new Error(
			"binding.name must be a lower-case workflow name (1-64 letters, numbers, dot, underscore, or dash; no trailing dash)",
		);
	if (
		Object.hasOwn(input, "description") &&
		!safeDescription(input.description)
	)
		throw new Error(
			"binding.description must contain 1-500 visible single-line characters without control or bidi formatting characters",
		);
	let items;
	try {
		items = assertInventory(input.items);
	} catch (error) {
		throw new Error(`binding.items is invalid: ${errorMessage(error)}`);
	}
	const normalized = {
		name: input.name,
		items: Object.freeze(items.map((item) => Object.freeze(item))),
	};
	if (Object.hasOwn(input, "description"))
		normalized.description = input.description;
	return Object.freeze(normalized);
}

/** Read a bounded, stable, non-symlinked UTF-8 JSON binding file. */
export async function readFixedInventoryBindingFile(
	filePath,
	cwd = process.cwd(),
) {
	if (!text(filePath, 4_096))
		throw new Error("binding file path must be a non-empty string");
	const requested = resolve(cwd, filePath);
	const requestedStat = await lstatBigInt(requested, "binding file");
	if (requestedStat.isSymbolicLink())
		throw new Error("binding file cannot be a symlink");
	if (!requestedStat.isFile())
		throw new Error("binding file must be a regular file");
	const target = await realpath(requested);
	await assertNoSymlinkComponents(target, "binding file");
	const pathBefore = await lstatBigInt(target, "binding file");
	assertSameFile(requestedStat, pathBefore, "binding file changed before read");
	if (pathBefore.size > BigInt(MAX_BINDING_BYTES))
		throw new Error(`binding file exceeds ${MAX_BINDING_BYTES} bytes`);

	const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
	let handle;
	try {
		handle = await open(target, flags);
	} catch (error) {
		throw new Error(`cannot open binding file: ${errorMessage(error)}`);
	}
	try {
		const descriptorBefore = await handle.stat({ bigint: true });
		assertSameFile(pathBefore, descriptorBefore, "binding file changed before read");
		const buffer = Buffer.alloc(MAX_BINDING_BYTES + 1);
		let offset = 0;
		while (offset < buffer.byteLength) {
			const { bytesRead } = await handle.read(
				buffer,
				offset,
				buffer.byteLength - offset,
				offset,
			);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		if (offset > MAX_BINDING_BYTES)
			throw new Error(`binding file exceeds ${MAX_BINDING_BYTES} bytes`);
		const descriptorAfter = await handle.stat({ bigint: true });
		const pathAfter = await lstatBigInt(target, "binding file");
		const requestedAfter = await lstatBigInt(requested, "binding file");
		assertSameFile(descriptorBefore, descriptorAfter, "binding file changed during read");
		assertSameFile(descriptorAfter, pathAfter, "binding file was replaced during read");
		assertSameFile(
			descriptorAfter,
			requestedAfter,
			"binding file path was replaced during read",
		);
		let source;
		try {
			source = new TextDecoder("utf-8", { fatal: true }).decode(
				buffer.subarray(0, offset),
			);
		} catch {
			throw new Error("binding file must be valid UTF-8");
		}
		let parsed;
		try {
			parsed = JSON.parse(source);
		} catch (error) {
			throw new Error(`binding file is not valid JSON: ${errorMessage(error)}`);
		}
		return parsed;
	} finally {
		await handle.close();
	}
}

/** Create one self-contained fixed-inventory workflow bundle without launching a model. */
export async function initializeFixedInventoryBundle(
	binding,
	destination,
	options = {},
) {
	const normalized = validateFixedInventoryBinding(binding);
	const cwd = resolve(options.cwd ?? process.cwd());
	if (!text(destination, 4_096) || destination.includes("\0"))
		throw new Error("destination must be a non-empty path string");
	const requestedTarget = resolve(cwd, destination);
	if (requestedTarget === parse(requestedTarget).root)
		throw new Error("destination cannot be a filesystem root");

	// Read, parse, and bind every trusted source asset before destination mutation.
	const assets = await readSourceAssets();
	const output = buildOutput(normalized, assets);
	const target = await canonicalDestination(requestedTarget);
	await assertNoSymlinkComponents(target, "destination");
	const targetState = await inspectDestination(target);
	const createdFiles = [];
	const createdDirectories = [];
	try {
		if (!targetState.exists) {
			createdDirectories.push(...(await createMissingDirectories(target)));
		}
		for (const relativePath of OUTPUT_FILES) {
			const parent = dirname(join(target, ...relativePath.split("/")));
			createdDirectories.push(...(await createMissingDirectories(parent)));
		}
		await assertNoSymlinkComponents(target, "destination");
		for (const relativePath of OUTPUT_FILES) {
			const filePath = join(target, ...relativePath.split("/"));
			await assertNoSymlinkComponents(dirname(filePath), "destination");
			await writeFile(filePath, output.get(relativePath), {
				encoding: "utf8",
				flag: "wx",
				mode: 0o600,
			});
			createdFiles.push(filePath);
		}
		await assertExactLayout(target);
	} catch (error) {
		const cleanupErrors = await cleanCreated(
			createdFiles,
			createdDirectories,
		);
		const cleanupDetail = cleanupErrors.length
			? `; cleanup incomplete: ${cleanupErrors.join("; ")}`
			: "";
		throw new Error(
			`fixed-inventory initialization failed: ${errorMessage(error)}${cleanupDetail}`,
		);
	}
	return Object.freeze({
		version: BINDING_VERSION,
		destination: target,
		files: [...OUTPUT_FILES],
	});
}

function buildOutput(binding, assets) {
	let spec;
	try {
		spec = JSON.parse(assets.get("spec.json"));
	} catch (error) {
		throw new Error(`template spec is invalid JSON: ${errorMessage(error)}`);
	}
	const stages = spec?.artifactGraph?.stages;
	const inventory = Array.isArray(stages)
		? stages.find((stage) => stage?.id === "inventory")
		: undefined;
	const questions = Array.isArray(stages)
		? stages.find((stage) => stage?.id === "questions")
		: undefined;
	const final = Array.isArray(stages)
		? stages.find((stage) => stage?.id === "final")
		: undefined;
	if (
		!inventory?.support?.options ||
		inventory.support.options.mode !== "inventory" ||
		questions?.type !== "foreach" ||
		questions.profileRole !== "research-execution" ||
		final?.support?.options?.mode !== "final"
	)
		throw new Error("fixed-inventory template contract has drifted");

	spec.name = binding.name;
	spec.description =
		binding.description ??
		`Fixed document inventory to stakeholder questions for ${binding.name}; editorial extraction only, not an audit.`;
	inventory.support.options.items = binding.items.map(({ id, path }) => ({
		id,
		path,
	}));

	const output = new Map();
	output.set("spec.json", `${JSON.stringify(spec, null, 2)}\n`);
	for (const relativePath of OUTPUT_FILES.slice(1))
		output.set(relativePath, assets.get(relativePath));
	for (const relativePath of OUTPUT_FILES) {
		if (typeof output.get(relativePath) !== "string")
			throw new Error(`missing generated output ${relativePath}`);
	}
	return output;
}

async function readSourceAssets() {
	const assets = new Map();
	for (const relativePath of OUTPUT_FILES) {
		const sourcePath = join(SOURCE_ROOT, ...relativePath.split("/"));
		const sourceStat = await lstatBigInt(sourcePath, `source asset ${relativePath}`);
		if (!sourceStat.isFile())
			throw new Error(`source asset is not a regular file: ${relativePath}`);
		assets.set(relativePath, await readFile(sourcePath, "utf8"));
	}
	return assets;
}

async function canonicalDestination(target) {
	const missing = [];
	let cursor = target;
	while (true) {
		try {
			const info = await lstat(cursor);
			if (cursor === target && info.isSymbolicLink())
				throw new Error("destination cannot be a symlink");
			const canonical = await realpath(cursor);
			return join(canonical, ...missing);
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
			missing.unshift(basename(cursor));
			const parent = dirname(cursor);
			if (parent === cursor) throw new Error("cannot resolve destination root");
			cursor = parent;
		}
	}
}

async function inspectDestination(target) {
	let info;
	try {
		info = await lstat(target);
	} catch (error) {
		if (error?.code === "ENOENT") return { exists: false };
		throw error;
	}
	if (info.isSymbolicLink()) throw new Error("destination cannot be a symlink");
	if (!info.isDirectory()) throw new Error("destination must be a directory");
	const entries = await readdir(target);
	if (entries.length > 0)
		throw new Error("destination must be absent or empty");
	return { exists: true };
}

async function createMissingDirectories(target) {
	const missing = [];
	let cursor = target;
	while (true) {
		try {
			const info = await lstat(cursor);
			if (info.isSymbolicLink())
				throw new Error(`directory path contains a symlink: ${cursor}`);
			if (!info.isDirectory())
				throw new Error(`directory path contains a non-directory: ${cursor}`);
			break;
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
			missing.unshift(cursor);
			const parent = dirname(cursor);
			if (parent === cursor) throw new Error("cannot create destination root");
			cursor = parent;
		}
	}
	const created = [];
	for (const path of missing) {
		try {
			await mkdir(path, { mode: 0o700 });
			created.push(path);
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
			const info = await lstat(path);
			if (info.isSymbolicLink() || !info.isDirectory())
				throw new Error(`unsafe destination directory: ${path}`);
		}
	}
	return created;
}

async function assertNoSymlinkComponents(target, label) {
	const absolute = resolve(target);
	const root = parse(absolute).root;
	const tail = relative(root, absolute);
	let cursor = root;
	for (const part of tail ? tail.split(sep) : []) {
		cursor = join(cursor, part);
		try {
			const info = await lstat(cursor);
			if (info.isSymbolicLink())
				throw new Error(`${label} path contains a symlink: ${cursor}`);
		} catch (error) {
			if (error?.code === "ENOENT") return;
			throw error;
		}
	}
}

async function assertExactLayout(target) {
	const expectedFiles = new Set(OUTPUT_FILES);
	const expectedDirectories = new Set(["helpers", "schemas"]);
	const actual = await walkLayout(target);
	actual.files.sort();
	actual.directories.sort();
	if (
		actual.files.length !== expectedFiles.size ||
		actual.files.some((entry) => !expectedFiles.has(entry)) ||
		actual.directories.length !== expectedDirectories.size ||
		actual.directories.some((entry) => !expectedDirectories.has(entry))
	)
		throw new Error(
			`destination layout is not exact: files=${actual.files.join(", ")}; directories=${actual.directories.join(", ")}`,
		);
}

async function walkLayout(
	root,
	directory = root,
	actual = { files: [], directories: [] },
) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const fullPath = join(directory, entry.name);
		const relativePath = relative(root, fullPath).split(sep).join("/");
		if (entry.isSymbolicLink())
			throw new Error(`destination contains a symlink: ${fullPath}`);
		if (entry.isDirectory()) {
			actual.directories.push(relativePath);
			await walkLayout(root, fullPath, actual);
		} else if (entry.isFile()) actual.files.push(relativePath);
		else throw new Error(`destination contains an unsupported entry: ${fullPath}`);
	}
	return actual;
}

async function cleanCreated(files, directories) {
	const failures = [];
	for (const file of files.toReversed()) {
		try {
			await unlink(file);
		} catch (error) {
			failures.push(`${file}: ${errorMessage(error)}`);
		}
	}
	for (const directory of [...new Set(directories)].toReversed()) {
		try {
			await rmdir(directory);
		} catch (error) {
			failures.push(`${directory}: ${errorMessage(error)}`);
		}
	}
	return failures;
}

async function lstatBigInt(path, label) {
	try {
		return await lstat(path, { bigint: true });
	} catch (error) {
		throw new Error(`${label} cannot be inspected: ${errorMessage(error)}`);
	}
}

function assertSameFile(left, right, message) {
	if (
		!left.isFile() ||
		!right.isFile() ||
		left.dev !== right.dev ||
		left.ino !== right.ino ||
		left.size !== right.size ||
		left.mtimeNs !== right.mtimeNs ||
		left.ctimeNs !== right.ctimeNs
	)
		throw new Error(message);
}

function record(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value, max) {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		![...value].some((character) => character === "\0") &&
		[...value].length <= max
	);
}

function safeDescription(value) {
	return (
		text(value, 500) &&
		value.trim().length > 0 &&
		!/[\x00-\x1f\x7f\u2028-\u202e\u2066-\u2069]/u.test(value)
	);
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

async function main(argv) {
	if (argv.length !== 2)
		throw new Error("usage: initialize.mjs <binding.json> <destination>");
	const binding = await readFixedInventoryBindingFile(argv[0]);
	const result = await initializeFixedInventoryBundle(binding, argv[1]);
	process.stdout.write(
		`Initialized ${result.version} at ${result.destination} (${result.files.length} files).\n`,
	);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
	main(process.argv.slice(2)).catch((error) => {
		process.stderr.write(`${errorMessage(error)}\n`);
		process.exitCode = 1;
	});
}
