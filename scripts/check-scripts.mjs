#!/usr/bin/env node
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const roots = ["scripts", "test"].filter((path) => existsDir(path));
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
