import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import ts from "typescript";

const RESOLUTION_EXTENSIONS = [
	".ts",
	".tsx",
	".mts",
	".cts",
	".d.ts",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".json",
];
const MODULE_SOURCE_PATTERN = /(?:\.d)?\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
const JAVASCRIPT_TO_TYPESCRIPT_EXTENSIONS = new Map([
	[".js", [".ts", ".tsx", ".d.ts"]],
	[".jsx", [".tsx", ".ts", ".d.ts"]],
	[".mjs", [".mts", ".d.mts"]],
	[".cjs", [".cts", ".d.cts"]],
]);

/**
 * Prove that every local module reachable from the supplied TypeScript entries
 * exists in a packed manifest and remains inside packageRoot.
 */
export function assertPackedTypeScriptClosure({
	packageRoot,
	entryPaths,
	packedPaths,
}) {
	const root = realpathSync(resolve(packageRoot));
	const included = new Set([...packedPaths].map(normalizeManifestPath));
	const pending = [...new Set(entryPaths.map(normalizeManifestPath))].sort();
	const visited = new Set();
	const edges = [];
	const failures = [];

	for (const entry of pending) {
		if (!included.has(entry)) {
			failures.push(`${entry}: packed entry is missing`);
		}
	}

	while (pending.length > 0) {
		const importer = pending.shift();
		if (!importer || visited.has(importer) || !included.has(importer)) continue;
		visited.add(importer);
		const importerPath = resolve(root, importer);
		if (!isWithinRoot(root, importerPath) || !isFile(importerPath)) {
			failures.push(`${importer}: source entry is unavailable`);
			continue;
		}
		// JSON and other packed assets are terminal nodes. Supported TypeScript
		// and JavaScript module importers are parsed with the TypeScript parser.
		if (!MODULE_SOURCE_PATTERN.test(importer)) continue;

		const source = readFileSync(importerPath, "utf8");
		const sourceFile = ts.createSourceFile(
			importerPath,
			source,
			ts.ScriptTarget.Latest,
			true,
			scriptKind(importerPath),
		);
		const references = collectLocalModuleReferences(sourceFile);
		for (const reference of references) {
			const unresolvedPath = resolve(dirname(importerPath), reference.specifier);
			if (!isWithinRoot(root, unresolvedPath)) {
				failures.push(
					`${importer} -> ${JSON.stringify(reference.specifier)}: package root escape`,
				);
				continue;
			}
			const targetPath = resolveLocalModule(unresolvedPath);
			if (!targetPath) {
				failures.push(
					`${importer} -> ${JSON.stringify(reference.specifier)}: local target is missing`,
				);
				continue;
			}
			if (!isWithinRoot(root, targetPath)) {
				failures.push(
					`${importer} -> ${JSON.stringify(reference.specifier)}: package root escape`,
				);
				continue;
			}
			const target = normalizeManifestPath(relative(root, targetPath));
			edges.push({
				from: importer,
				kind: reference.kind,
				specifier: reference.specifier,
				to: target,
			});
			if (!included.has(target)) {
				failures.push(
					`${importer} -> ${JSON.stringify(reference.specifier)}: packed target is missing (${target})`,
				);
				continue;
			}
			if (!visited.has(target) && !pending.includes(target)) {
				pending.push(target);
				pending.sort();
			}
		}
	}

	if (failures.length > 0) {
		throw new Error(
			`Packed TypeScript closure is incomplete:\n${[...new Set(failures)]
				.sort()
				.map((failure) => `- ${failure}`)
				.join("\n")}`,
		);
	}

	return {
		files: [...visited].sort(),
		edges: edges.toSorted((left, right) =>
			`${left.from}\0${left.specifier}\0${left.kind}\0${left.to}`.localeCompare(
				`${right.from}\0${right.specifier}\0${right.kind}\0${right.to}`,
			),
		),
	};
}

function collectLocalModuleReferences(sourceFile) {
	const references = [];
	const add = (kind, literal) => {
		if (!literal || !ts.isStringLiteral(literal)) return;
		if (!isRelativeSpecifier(literal.text)) return;
		references.push({ kind, specifier: literal.text });
	};

	for (const statement of sourceFile.statements) {
		if (ts.isImportDeclaration(statement)) {
			add("import", statement.moduleSpecifier);
		} else if (ts.isExportDeclaration(statement)) {
			add("export", statement.moduleSpecifier);
		} else if (
			ts.isImportEqualsDeclaration(statement) &&
			ts.isExternalModuleReference(statement.moduleReference)
		) {
			add("import-equals", statement.moduleReference.expression);
		}
	}

	visit(sourceFile);
	return references.toSorted((left, right) =>
		`${left.specifier}\0${left.kind}`.localeCompare(
			`${right.specifier}\0${right.kind}`,
		),
	);

	function visit(node) {
		if (ts.isCallExpression(node) && node.arguments.length === 1) {
			if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
				add("dynamic-import", node.arguments[0]);
			} else if (
				ts.isIdentifier(node.expression) &&
				node.expression.text === "require"
			) {
				add("require", node.arguments[0]);
			}
		}
		ts.forEachChild(node, visit);
	}
}

function resolveLocalModule(basePath) {
	for (const candidate of resolutionCandidates(basePath)) {
		if (isFile(candidate)) return realpathSync(resolve(candidate));
	}
	return undefined;
}

function resolutionCandidates(basePath) {
	const extension = extname(basePath).toLowerCase();
	if (extension) {
		const mapped = JAVASCRIPT_TO_TYPESCRIPT_EXTENSIONS.get(extension) ?? [];
		const stem = basePath.slice(0, -extension.length);
		return [
			...mapped.map((candidateExtension) => `${stem}${candidateExtension}`),
			basePath,
		];
	}
	return [
		basePath,
		...RESOLUTION_EXTENSIONS.map((candidateExtension) =>
			`${basePath}${candidateExtension}`,
		),
		...RESOLUTION_EXTENSIONS.map((candidateExtension) =>
			resolve(basePath, `index${candidateExtension}`),
		),
	];
}

function isRelativeSpecifier(specifier) {
	return specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../");
}

function isWithinRoot(root, target) {
	const pathFromRoot = relative(root, target);
	return (
		pathFromRoot === "" ||
		(!pathFromRoot.startsWith(`..${sep}`) &&
			pathFromRoot !== ".." &&
			!isAbsolute(pathFromRoot))
	);
}

function normalizeManifestPath(path) {
	return String(path).replaceAll("\\", "/").replace(/^\.\//, "");
}

function isFile(path) {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function scriptKind(path) {
	if (/\.tsx$/i.test(path)) return ts.ScriptKind.TSX;
	if (/\.(?:mts|cts|ts)$/i.test(path)) return ts.ScriptKind.TS;
	if (/\.jsx$/i.test(path)) return ts.ScriptKind.JSX;
	if (/\.(?:mjs|cjs|js)$/i.test(path)) return ts.ScriptKind.JS;
	return ts.ScriptKind.Unknown;
}
