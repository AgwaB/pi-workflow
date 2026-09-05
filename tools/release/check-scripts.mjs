#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

try {
	checkDependencyLock();
} catch (error) {
	console.error(`Dependency lock check failed: ${error.message}`);
	process.exit(1);
}

const roots = ["tools/release", "test"].filter((path) => existsDir(path));
const files = roots.flatMap((root) => listMjs(root)).sort();

if (files.length === 0) {
	console.log("No .mjs files found for syntax check.");
	process.exit(0);
}

for (const file of files) {
	console.log(`$ node --check ${file}`);
	const result = spawnSync(process.execPath, ["--check", file], {
		stdio: "inherit",
	});
	if (result.status !== 0) process.exit(result.status ?? 1);
}

// Read-only consistency check, not a package integrity/security verifier. Never
// resolves ranges, installs packages, or repairs the checkout during validation.
function checkDependencyLock() {
	const manifest = JSON.parse(readFileSync("package.json", "utf8"));
	const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
	if (lock.lockfileVersion !== 3 || !lock.packages?.[""])
		throw new Error("expected a v3 package-lock.json with a root package");
	const root = lock.packages[""];
	for (const field of [
		"name",
		"version",
		"dependencies",
		"devDependencies",
		"optionalDependencies",
		"peerDependencies",
		"peerDependenciesMeta",
		"bundleDependencies",
		"engines",
	]) {
		if (!isDeepStrictEqual(manifest[field], root[field]))
			throw new Error(`package.json ${field} differs from package-lock.json`);
	}
	for (const name of Object.keys({
		...manifest.dependencies,
		...manifest.devDependencies,
		...manifest.optionalDependencies,
	})) {
		if (!Object.hasOwn(lock.packages, `node_modules/${name}`))
			throw new Error(`missing lock entry for ${name}`);
	}
	let checked = 0;
	for (const [path, entry] of Object.entries(lock.packages)) {
		if (path === "") continue;
		// Accept only npm package locations, never arbitrary paths from lock data.
		if (
			!/^(?:node_modules\/(?:@[a-zA-Z0-9_~.-]+\/)?[a-zA-Z0-9_~-][a-zA-Z0-9_~.-]*)(?:\/node_modules\/(?:@[a-zA-Z0-9_~.-]+\/)?[a-zA-Z0-9_~-][a-zA-Z0-9_~.-]*)*$/.test(
				path,
			) ||
			path.split("/").some((part) => part === "." || part === "..")
		)
			throw new Error(`unsupported lock package path: ${path}`);
		let installed;
		try {
			installed = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
		} catch (error) {
			if (error.code === "ENOENT" && entry.optional) continue;
			throw new Error(
				`cannot read ${path}/package.json; run an exact npm ci (${error.message})`,
			);
		}
		if (typeof entry.version !== "string" || installed.version !== entry.version)
			throw new Error(
				`${path}: installed ${installed.version}, locked ${entry.version}; run an exact npm ci`,
			);
		checked += 1;
	}
	console.log(
		`Dependency lock check passed (${checked} installed package versions).`,
	);
}

function existsDir(path) {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function listMjs(root) {
	const entries = readdirSync(root, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) files.push(...listMjs(path));
		else if (entry.isFile() && path.endsWith(".mjs")) files.push(path);
	}
	return files;
}
