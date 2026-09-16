import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
	assertWorkflowAutoResolvedCandidateSafety,
	buildWorkflowAutoCandidates,
	recommendWorkflowAuto,
} from "../../.tmp/unit/workflow-router.js";
import { listWorkflowRoutingSpecs, resolveWorkflowRef, WORKFLOW_ROUTING_CATALOG_BOUNDS } from "../../.tmp/unit/workflow-specs.js";
import { compileWorkflow } from "../../.tmp/unit/compiler.js";
import { setSubagentApiForTests } from "../../.tmp/unit/subagent-backend.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "piwf-auto-negative-")));
after(() => {
	setSubagentApiForTests(undefined);
	rmSync(root, { recursive: true, force: true });
});
function project() {
	const cwd = mkdtempSync(join(root, "project-"));
	mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "agents", "unit-agent.md"), '---\ndescription: fixture\ntools: ["read", "bash"]\nreadOnly: false\n---\n# fixture\n');
	return cwd;
}
function spec(name, readOnly = true) {
	return { schemaVersion: 1, name, defaults: { agent: "unit-agent", readOnly, tools: readOnly ? ["read"] : ["bash"] }, artifactGraph: { stages: [{ id: "main", type: "single", prompt: "Review." }] } };
}
function put(cwd, relativePath, value) {
	const path = join(cwd, relativePath);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(value));
	return path;
}

for (const task of [
	"Do not write to disk; do not use the network.",
	"Don't edit files; never access the internet.",
	"You must not modify code or use the network. Offline only.",
]) {
	test(`negative network constraints prevent classification and workflow choices: ${task}`, async () => {
		const cwd = project();
		put(cwd, "workflows/write-to-disk.json", spec("write-to-disk", false));
		let calls = 0;
		setSubagentApiForTests({
			async runSubagent() {
				calls += 1;
				throw new Error("forbidden transport");
			},
		});
		const result = await recommendWorkflowAuto({
			cwd,
			task,
			transmissionPolicy: "allowed",
			availableAgentNames: ["unit-agent"],
		});
		assert.equal(calls, 0);
		assert.notEqual(result.transmission, "allowed");
		assert.equal(result.localChoiceScope, "none");
		assert.ok(result.candidates.length > 0);
		assert.ok(result.candidates.every((item) => !item.readiness.startAllowed));
		assert.equal(
			result.candidates.some((item) => item.kind === "direct"),
			false,
		);
	});
}

for (const task of [
	"Do not write to disk.",
	"Don't change code.",
	"Never edit or modify files.",
	"Do not modify the source; review it.",
]) {
	test(`negative write verbs remain safety gates after classifier failure: ${task}`, async () => {
		const cwd = project();
		const unsafeSpec = spec("write-to-disk", false);
		const path = put(cwd, "workflows/write-to-disk.json", unsafeSpec);
		const safePath = put(
			cwd,
			"workflows/review-source.json",
			spec("review-source"),
		);
		let calls = 0;
		setSubagentApiForTests({
			async runSubagent() {
				calls += 1;
				throw new Error("offline classifier failure");
			},
		});
		const result = await recommendWorkflowAuto({
			cwd,
			task,
			transmissionPolicy: "allowed",
			availableAgentNames: ["unit-agent"],
		});
		assert.equal(calls, 1);
		assert.equal(result.status, "routing-unavailable");
		const unsafe = result.candidates.find((item) => item.specPath === path);
		assert.equal(unsafe.readiness.startAllowed, false);
		assert.match(unsafe.readiness.blockers.join(" "), /read-only/);
		assert.equal(
			result.candidates.find((item) => item.specPath === safePath).readiness
				.startAllowed,
			true,
			"a negated write verb must not block a read-only report as a patch request",
		);
		const compiled = await compileWorkflow(unsafeSpec, {
			cwd,
			specPath: path,
			task,
		});
		assert.throws(
			() => assertWorkflowAutoResolvedCandidateSafety(unsafe, compiled, task),
			/incompatible/,
		);
	});
}

test("positive mutation request remains positive, not a read-only permission", async () => {
	const cwd = project();
	const path = put(
		cwd,
		"workflows/write-to-disk.json",
		spec("write-to-disk", false),
	);
	const readPath = put(cwd, "workflows/review.json", spec("review"));
	setSubagentApiForTests({
		async runSubagent() {
			throw new Error("offline");
		},
	});
	const result = await recommendWorkflowAuto({
		cwd,
		task: "Modify and fix the source.",
		transmissionPolicy: "allowed",
		availableAgentNames: ["unit-agent"],
	});
	assert.equal(
		result.candidates.find((item) => item.specPath === path).readiness
			.startAllowed,
		true,
	);
	assert.equal(
		result.candidates.find((item) => item.specPath === readPath).readiness
			.startAllowed,
		false,
	);
});

test("oversize higher-priority resolver owner cannot donate its alias to a catalog fallback", async () => {
	const cwd = project();
	const high = put(cwd, "workflows/foo.json", { ...spec("shared"), description: "x".repeat(WORKFLOW_ROUTING_CATALOG_BOUNDS.maxSpecBytes) });
	const low = put(cwd, ".pi/workflows/foo/spec.json", spec("private"));
	const catalog = await listWorkflowRoutingSpecs(cwd);
	assert.equal(catalog.partial, true);
	assert.equal((await resolveWorkflowRef("foo", cwd)).specPath, high);
	assert.equal(catalog.records.some((item) => item.specPath === low), false);
	assert.equal(buildWorkflowAutoCandidates(catalog).some((item) => item.specPath === low), false);
});

test("excluded same-priority alias owner blocks an apparently unique bundle", async () => {
	const cwd = project();
	put(cwd, "workflows/foo.json", { ...spec("flat"), description: "x".repeat(WORKFLOW_ROUTING_CATALOG_BOUNDS.maxSpecBytes) });
	const bundle = put(cwd, "workflows/foo/spec.json", spec("bundle"));
	const catalog = await listWorkflowRoutingSpecs(cwd);
	await assert.rejects(() => resolveWorkflowRef("foo", cwd), /ambiguous/);
	const candidate = buildWorkflowAutoCandidates(catalog, undefined, ["unit-agent"]).find((item) => item.specPath === bundle);
	assert.ok(candidate);
	assert.equal(candidate.readiness.startAllowed, false);
});

test("candidate read cap retains alias reservations for unparsed entries", async () => {
	const cwd = project();
	for (let i = 0; i < WORKFLOW_ROUTING_CATALOG_BOUNDS.maxCandidates - 1; i += 1)
		put(cwd, `workflows/a${String(i).padStart(3, "0")}.json`, spec(`a${i}`));
	const bundle = put(cwd, "workflows/z/spec.json", spec("bundle"));
	put(cwd, "workflows/z.json", spec("unparsed-flat"));
	const catalog = await listWorkflowRoutingSpecs(cwd);
	assert.equal(catalog.partial, true);
	assert.equal(catalog.records.some((item) => item.spec.name === "unparsed-flat"), false);
	const candidate = buildWorkflowAutoCandidates(catalog, undefined, ["unit-agent"]).find((item) => item.specPath === bundle);
	assert.ok(candidate);
	assert.equal(candidate.readiness.startAllowed, false);
	await assert.rejects(() => resolveWorkflowRef("z", cwd), /ambiguous/);
});

test("truncated root enumeration cannot prove a lower-priority alias safe", async () => {
	const cwd = project();
	mkdirSync(join(cwd, "workflows"), { recursive: true });
	for (let i = 0; i <= WORKFLOW_ROUTING_CATALOG_BOUNDS.maxRootEntries; i += 1)
		writeFileSync(join(cwd, "workflows", `ignored-${i}.txt`), "not a workflow");
	const low = put(cwd, ".pi/workflows/foo/spec.json", spec("private"));
	const catalog = await listWorkflowRoutingSpecs(cwd);
	assert.ok(catalog.issues.some((issue) => /root entry limit/.test(issue.reason)));
	const candidate = buildWorkflowAutoCandidates(catalog, undefined, ["unit-agent"]).find((item) => item.specPath === low);
	assert.ok(candidate);
	assert.equal(candidate.readiness.startAllowed, false);
});
