#!/usr/bin/env node
import assert from "node:assert/strict";
import { access, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [packageRootArg, consumerCwdArg] = process.argv.slice(2);
if (!packageRootArg || !consumerCwdArg) {
	throw new Error("usage: packed-workflows.mjs <installed-package-root> <consumer-cwd>");
}
const packageRoot = await realpath(packageRootArg);
const consumerCwd = resolve(consumerCwdArg);
const api = await import(pathToFileURL(join(packageRoot, "dist", "index.js")));
const { compileWorkflow } = await import(
	pathToFileURL(join(packageRoot, "dist", "compiler.js"))
);

const officialNames = [
	"deep-research",
	"deep-review",
	"impact-review",
	"spec-review",
];
const listed = (await api.listWorkflows(consumerCwd))
	.map((item) => item.name)
	.sort();
assert.deepEqual(listed, officialNames);

for (const name of officialNames) {
	const resolvedRef = await api.resolveWorkflowRef(name, consumerCwd);
	const expectedSpec = join(packageRoot, "workflows", name, "spec.json");
	assert.equal(await realpath(resolvedRef.specPath), await realpath(expectedSpec));
	const loaded = await api.loadWorkflowSpec(name, consumerCwd);
	const compiled = await compileWorkflow(loaded.spec, {
		cwd: consumerCwd,
		task: `Packed ${name} contract check`,
		specPath: loaded.specPath,
	});
	assert.ok(compiled.artifactGraph?.enabled, `${name} did not compile as artifact graph`);
	assert.ok(compiled.tasks.length > 0, `${name} compiled without tasks`);
	for (const relativeRef of localFileRefs(loaded.spec)) {
		await access(resolve(dirname(loaded.specPath), relativeRef));
	}
	for (const task of compiled.tasks) {
		const agent = task.runtime?.agent;
		if (typeof agent !== "string" || !agent) continue;
		await access(join(packageRoot, "agents", `${agent}.md`));
	}
}

function localFileRefs(value) {
	const refs = [];
	visit(value);
	return [...new Set(refs)];

	function visit(candidate) {
		if (typeof candidate === "string") {
			if (/^\.\/.+\.(?:json|mjs|js)$/.test(candidate)) refs.push(candidate);
			return;
		}
		if (Array.isArray(candidate)) {
			for (const item of candidate) visit(item);
			return;
		}
		if (!candidate || typeof candidate !== "object") return;
		for (const item of Object.values(candidate)) visit(item);
	}
}

console.log(`validated installed workflows: ${officialNames.join(", ")}`);
