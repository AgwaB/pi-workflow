import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { compileWorkflow } from "../../.tmp/unit/compiler.js";
import { parseWorkflow, loadWorkflowSpec } from "../../.tmp/unit/schema.js";
import { validateJsonSchema, validateJsonSchemaSubset } from "../../.tmp/unit/json-schema.js";
import { projectArtifactGraphControl } from "../../.tmp/unit/artifact-graph-runtime.js";
import { writeJsonAtomic, writeRunRecord } from "../../.tmp/unit/store.js";
import { completeTask, createWorkflowRunRecord, makeProject, scheduleRun, setSubagentApiForTests, writeAgent, writeStaticRunArtifacts } from "./unit-test-support.mjs";

function graph(stages) {
	return { schemaVersion: 1, defaults: { agent: "unit-scout", tools: ["read"], readOnly: true }, artifactGraph: { stages } };
}

for (const depth of [1, 2]) {
	test(`scheduler executes every identified foreach item from a ${depth}-level nested producer output`, async () => {
		const cwd = makeProject();
		try {
			writeAgent(cwd, "unit-scout", "read");
			const specPath = join(cwd, "workflows", "spec.json");
			mkdirSync(dirname(specPath), { recursive: true });
			writeFileSync(join(dirname(specPath), "produce.mjs"), 'export default () => ({schema:"items-v1",digest:"two items",items:[{id:"alpha",text:"first"},{id:"beta",text:"second"}]});');
			let producer = { id: "inner", type: "dag", stages: [{ id: "produce", support: { uses: "./produce.mjs" } }] };
			if (depth === 2) producer = { id: "inner", type: "dag", stages: [{ ...producer, id: "deeper" }] };
			const spec = parseWorkflow(graph([{ id: "outer", type: "dag", stages: [producer, { id: "each", type: "foreach", from: { source: "inner", path: "$.items" }, each: { prompt: "Handle ${item}", itemIdentityPath: "$.id" } }] }]));
			writeFileSync(specPath, JSON.stringify(spec));
			const compiled = await compileWorkflow(spec, { cwd, specPath, task: "Handle the exact two items." });
			const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
			await writeStaticRunArtifacts(cwd, run, compiled, spec);
			await writeRunRecord(cwd, run);
			const launches = [];
			setSubagentApiForTests({
				async runSubagent(options) { launches.push(options); return { runId: `run_graph_${depth}_${launches.length}`, attemptId: `attempt_graph_${depth}_${launches.length}`, status: "running" }; },
				async getSubagentStatus() { return null; }, async reconcileSubagentRun() { return {}; }, async interruptSubagent() { return {}; },
			});
			let current = await scheduleRun(cwd, run.runId);
			const generated = current.tasks.filter(task => task.foreachGenerated);
			assert.equal(generated.length, 2);
			assert.equal(launches.length, 2);
			assert.deepEqual(generated.map(task => task.foreachGenerated.itemIdentity).sort(), ["alpha", "beta"]);
			const sourceId = depth === 1 ? "outer.inner.produce.main" : "outer.inner.deeper.produce.main";
			assert.equal(current.tasks.find(task => task.specId === sourceId).status, "completed");
			for (const task of generated) {
				assert.equal(task.status, "running");
				assert.equal(task.foreachGenerated.itemSourceSpecId, sourceId);
				await completeTask(cwd, task, { handled: task.foreachGenerated.itemIdentity });
			}
			await writeRunRecord(cwd, current);
			current = await scheduleRun(cwd, run.runId);
			assert.equal(current.status, "completed");
			assert.equal(current.tasks.filter(task => task.foreachGenerated && task.status === "completed").length, 2);
			assert.equal(launches.length, 2);
		} finally { setSubagentApiForTests(undefined); rmSync(cwd, { recursive: true, force: true }); }
	});
}

for (const [mode, name] of [
	["missing", "scheduler blocks a missing authoritative foreach source instead of completing an empty fanout"],
	["invalid", "scheduler blocks an authoritative non-array foreach value"],
	["empty", "scheduler completes a genuinely empty authoritative foreach array without launches"],
]) test(name, async () => {
	const cwd = makeProject();
	try {
		writeAgent(cwd, "unit-scout", "read");
		const specPath = join(cwd, "spec.json");
		const spec = parseWorkflow(graph([{ id: "producer", type: "single", prompt: "Produce." }, { id: "each", type: "foreach", from: { source: "producer", path: "$.items" }, each: { prompt: "Handle ${item}" } }]));
		writeFileSync(specPath, JSON.stringify(spec));
		const compiled = await compileWorkflow(spec, { cwd, specPath, task: "Handle items." });
		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await completeTask(cwd, run.tasks[0], { items: mode === "empty" ? [] : mode === "invalid" ? "not an array" : [{ id: "alpha" }] });
		await writeRunRecord(cwd, run);
		if (mode === "missing") compiled.tasks[1].foreach.from.stage = "missing.container";
		await writeJsonAtomic(join(cwd, ".pi", "workflows", run.runId, "compiled.json"), compiled);
		setSubagentApiForTests({ async runSubagent() { assert.fail("must not launch"); }, async getSubagentStatus() { return null; }, async reconcileSubagentRun() { return {}; }, async interruptSubagent() { return {}; } });
		const current = await scheduleRun(cwd, run.runId);
		const placeholder = current.tasks.find(task => task.specId === "each.item");
		if (mode === "empty") {
			assert.equal(placeholder.statusDetail, "foreach_empty");
			assert.equal(current.status, "completed");
			assert.equal(current.tasks.length, 2);
		} else {
			assert.equal(placeholder.status, "blocked");
			assert.equal(placeholder.statusDetail, "foreach_expansion_blocked");
			assert.match(placeholder.lastMessage, mode === "missing" ? /missing.*source|source.*missing/i : /array/);
			assert.notEqual(current.status, "completed");
		}
	} finally { setSubagentApiForTests(undefined); rmSync(cwd, { recursive: true, force: true }); }
});

const invalidSchemas = [
	["unknown type", { type: "boolen" }], ["non-string type", { type: 4 }], ["empty type union", { type: [] }], ["duplicate type", { type: ["string", "string"] }], ["invalid union member", { type: ["string", null] }],
	["required string", { required: "flag" }], ["required member", { required: [3] }], ["duplicate required", { required: ["flag", "flag"] }],
	["enum scalar", { enum: "a" }], ["empty enum", { enum: [] }], ["duplicate object enum", { enum: [{ a: 1, b: 2 }, { b: 2, a: 1 }] }],
	...["minItems", "maxItems", "minLength", "maxLength"].flatMap(key => [ -1, 0.5, "2", null, Infinity ].map(value => [key + " " + value, { [key]: value }])),
	...["minimum", "maximum"].flatMap(key => ["2", null, Infinity, NaN].map(value => [key + " " + value, { [key]: value }])),
	...["$schema", "$id", "title", "description"].map(key => [key, { [key]: 3 }]),
	...["allOf", "anyOf", "oneOf"].flatMap(key => [[key + " scalar", { [key]: true }], [key + " empty", { [key]: [] }]]),
	["empty tuple", { items: [] }], ["bad properties", { properties: [] }], ["bad child", { items: { required: "flag" } }], ["bad additional", { additionalProperties: 3 }],
	["unsupported pattern", { pattern: ".*" }], ["unsupported reference", { $ref: "#" }],
];
for (const [name, schema] of invalidSchemas) test(`control schema rejects malformed ${name}`, () => {
	assert.equal(validateJsonSchemaSubset(schema).valid, false);
});

test("workflow loader rejects malformed supported schema keyword values", async () => {
	const cwd = makeProject();
	try {
		writeFileSync(join(cwd, "invalid.json"), JSON.stringify({ type: "object", required: "flag", properties: { flag: { type: "boolen" } } }));
		writeFileSync(join(cwd, "spec.json"), JSON.stringify(graph([{ id: "one", type: "single", prompt: "Work.", output: { controlSchema: "./invalid.json" } }])));
		await assert.rejects(loadWorkflowSpec(join(cwd, "spec.json"), cwd), /required|type/);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("direct value validation fails closed on malformed schemas", () => {
	assert.equal(validateJsonSchema({ flag: "not boolean" }, { type: "object", required: "flag", properties: { flag: { type: "boolen" } } }).valid, false);
});

test("object const and enum compare recursively without depending on key order", () => {
	const first = JSON.parse('{"a":[{"x":1,"y":2}],"b":2,"__proto__":{"safe":true}}');
	const reordered = JSON.parse('{"__proto__":{"safe":true},"b":2,"a":[{"y":2,"x":1}]}');
	for (const schema of [{ const: first }, { enum: [first] }]) {
		assert.equal(validateJsonSchema(reordered, schema).valid, true);
		assert.equal(validateJsonSchema({ ...reordered, b: 3 }, schema).valid, false);
	}
	assert.equal(validateJsonSchema([2, 1], { const: [1, 2] }).valid, false);
	assert.equal(validateJsonSchema({ a: 1 }, { const: { a: "1" } }).valid, false);
});

test("string bounds count Unicode code points rather than UTF-16 units or graphemes", () => {
	assert.equal(validateJsonSchema("😀", { minLength: 2 }).valid, false);
	assert.equal(validateJsonSchema("😀", { maxLength: 1 }).valid, true);
	assert.equal(validateJsonSchema("😀a", { minLength: 2, maxLength: 2 }).valid, true);
	assert.equal(validateJsonSchema("e\u0301", { maxLength: 1 }).valid, false);
});

test("supported valid constraints and every bundled schema retain compatibility", () => {
	for (const schema of [true, false, {}, { type: ["object", "null"], required: [], properties: { value: { type: "integer" } }, additionalProperties: false }, { items: [true, { type: "string" }], minItems: 0 }, { minLength: 3, maxLength: 1 }, { minimum: -2.5, maximum: 2.5 }, { allOf: [true], anyOf: [false, {}], oneOf: [{}] }]) assert.equal(validateJsonSchemaSubset(schema).valid, true, JSON.stringify(schema));
	let count = 0;
	function visit(path) { for (const entry of readdirSync(path, { withFileTypes: true })) { const file = join(path, entry.name); if (entry.isDirectory()) visit(file); else if (entry.name.endsWith(".schema.json")) { const result = validateJsonSchemaSubset(JSON.parse(readFileSync(file, "utf8"))); assert.equal(result.valid, true, `${file}: ${JSON.stringify(result.issues)}`); count++; } } }
	visit("workflows"); visit("skills/workflow-guide/scaffolds"); assert.ok(count > 20);
});

function loopSpec(until) { return graph([{ id: "cycle", type: "loop", maxRounds: 2, until, stages: [{ id: "work", type: "single", prompt: "Work." }, { id: "check", type: "single", prompt: "Check." }] }]); }
for (const [name, leaf, pattern] of [
	["unknown", { stage: "absent", path: "$.done", equals: true }, /until\.all\[0\]\.any\[1\]\.stage.*unknown/],
	["nonfinal", { stage: "work", path: "$.done", equals: true }, /until\.all\[0\]\.any\[1\]\.stage.*final/],
	["contradictory aliases", { stage: "work", source: "check", path: "$.done", equals: true }, /until\.all\[0\]\.any\[1\].*(same|agree|conflict)/],
	["missing child reference", { path: "$.done", equals: true }, /until\.all\[0\]\.any\[1\].*(stage|source)/],
]) test(`nested loop predicates reject ${name} leaves with indexed diagnostics`, () => {
	assert.throws(() => parseWorkflow(loopSpec({ all: [{ any: [{ stage: "check", path: "$.done", equals: true }, leaf] }] })), pattern);
});

test("nested loop leaves accept the final child and agreeing source aliases", () => {
	assert.doesNotThrow(() => parseWorkflow(loopSpec({ all: [{ any: [{ stage: "check", source: "check", path: "$.done", equals: true }, { source: "check", path: "$.done", exists: true }] }] })));
});

for (const control of [{ a: 1, items: [{ id: "a" }] }, [1, 2], "😀", null, false, 0, {}, []]) test(`root control projection preserves ${JSON.stringify(control)}`, () => {
	assert.deepEqual(projectArtifactGraphControl(control, { include: ["$"] }), { value: control, missingPaths: [], truncated: false });
});

test("root control projection preserves caps, missing paths and prototype-safe input without mutation", () => {
	const control = JSON.parse('{"a":{"b":2},"__proto__":{"polluted":true}}');
	const before = JSON.stringify(control);
	for (const include of [["$", "$.a.b", "$.missing"], ["$.a.b", "$", "$.missing"]]) {
		const projected = projectArtifactGraphControl(control, { include, maxChars: 1000 });
		assert.deepEqual(projected.value, control);
		assert.deepEqual(projected.missingPaths, ["$.missing"]);
		const capped = projectArtifactGraphControl(control, { include, maxChars: 10 });
		assert.equal(capped.truncated, true);
		assert.equal(capped.value.originalChars, before.length);
		assert.ok(capped.value.preview.length <= 10);
	}
	assert.equal(JSON.stringify(control), before);
	assert.equal({}.polluted, undefined);
});

test("public TypeScript workflow authors can declare injectRuntimeTask without casts", () => {
	const cwd = makeProject();
	try {
		const file = join(cwd, "consumer.mts");
		const scope = join(cwd, "node_modules", "@agwab");
		mkdirSync(scope, { recursive: true });
		symlinkSync(resolve("."), join(scope, "pi-workflow"), "dir");
		writeFileSync(file, `import type { ArtifactGraphStageSpec } from "@agwab/pi-workflow";\nconst stage: ArtifactGraphStageSpec = { id: "report", type: "reduce", from: "scan", prompt: "Report", injectRuntimeTask: true };\nexport { stage };\n`);
		const program = ts.createProgram([file], { noEmit: true, strict: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, typeRoots: [resolve("node_modules/@types")] });
		const diagnostics = program.getSemanticDiagnostics(program.getSourceFile(file));
		assert.deepEqual(diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n")), []);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});
