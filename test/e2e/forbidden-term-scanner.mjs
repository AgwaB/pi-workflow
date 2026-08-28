#!/usr/bin/env node
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Keep the scan surface identical to the former grep probe. Historical handoff
// records live under ignored .tmp/.pi paths and are intentionally excluded.
export const LEGACY_TERM_SCAN_PATHS = Object.freeze([
	"src",
	"test",
	"README.md",
	"docs",
	"workflows",
	"package.json",
]);
export const LEGACY_TERM_EXCLUSIONS = Object.freeze([
	".tmp/**",
	".pi/**",
]);
export const LEGACY_TERM_PATTERNS = Object.freeze([
	"rec" + "ipe",
	"Rec" + "ipe",
	"rec" + "ipes",
	"Rec" + "ipes",
	"/fl" + "ow",
	"fl" + "ow-rec" + "ipes",
	"workfl" + "ow-rec" + "ipes",
	"\\.pi/fl" + "ows",
]);

const EXIT_CODES = Object.freeze({
	clean: 0,
	"forbidden-match": 2,
	"read/setup-error": 3,
});

export function scanForbiddenTerms({
	root = process.cwd(),
	paths = LEGACY_TERM_SCAN_PATHS,
	patterns = LEGACY_TERM_PATTERNS,
	exclusions = LEGACY_TERM_EXCLUSIONS,
} = {}) {
	const packageRoot = resolve(root);
	const files = [];
	const errors = [];
	try {
		for (const path of paths)
			collectFiles(resolve(packageRoot, path), packageRoot, exclusions, files);
	} catch (error) {
		errors.push(`${error.code ?? "E_SCAN"}: ${error.message}`);
	}
	if (errors.length > 0) return { status: "read/setup-error", errors };

	const matches = [];
	for (const file of files.toSorted()) {
		let source;
		try {
			source = readFileSync(file, "utf8");
		} catch (error) {
			errors.push(`${error.code ?? "E_READ"}: ${relative(packageRoot, file)}: ${error.message}`);
			continue;
		}
		for (const pattern of patterns) {
			const match = new RegExp(pattern).exec(source);
			if (!match) continue;
			const before = source.slice(0, match.index);
			const line = before.split("\n").length;
			const lineStart = before.lastIndexOf("\n") + 1;
			matches.push({
				path: relative(packageRoot, file).split(sep).join("/"),
				line,
				column: match.index - lineStart + 1,
				pattern,
			});
		}
	}
	if (errors.length > 0) return { status: "read/setup-error", errors };
	if (matches.length > 0)
		return { status: "forbidden-match", matches: matches.toSorted(compareMatches) };
	return { status: "clean", matches: [] };
}

function collectFiles(path, root, exclusions, files) {
	const relativePath = relative(root, path).split(sep).join("/");
	if (relativePath === ".." || relativePath.startsWith("../"))
		throw new Error(`scan path escapes root: ${relativePath}`);
	if (isExcluded(relativePath, exclusions)) return;
	const entry = lstatSync(path);
	if (entry.isSymbolicLink())
		throw new Error(`symbolic links are not supported by the scanner: ${relativePath}`);
	if (entry.isFile()) {
		files.push(path);
		return;
	}
	if (!entry.isDirectory()) return;
	for (const child of readdirSync(path).toSorted())
		collectFiles(resolve(path, child), root, exclusions, files);
}

function isExcluded(path, exclusions) {
	return exclusions.some((exclusion) => {
		const prefix = exclusion.endsWith("/**")
			? exclusion.slice(0, -3)
			: exclusion;
		return path === prefix || path.startsWith(`${prefix}/`);
	});
}

function compareMatches(left, right) {
	return `${left.path}\0${left.line}\0${left.column}\0${left.pattern}`.localeCompare(
		`${right.path}\0${right.line}\0${right.column}\0${right.pattern}`,
	);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	const result = scanForbiddenTerms();
	process.stdout.write(`${JSON.stringify(result)}\n`);
	process.exitCode = EXIT_CODES[result.status];
}
