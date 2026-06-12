#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const resultRoot = join(root, ".tmp", "test-results", "e2e");
const stamp = new Date()
	.toISOString()
	.replace(/[-:]/g, "")
	.replace(/\.\d{3}Z$/, "Z");
const resultDir = join(resultRoot, `run-${stamp}`);
mkdirSync(resultDir, { recursive: true });

const rows = [];
let failed = false;

function record(label, command, status, expectFailure = false) {
	const pass = expectFailure ? status !== 0 : status === 0;
	rows.push({
		label,
		command: command.join(" "),
		status,
		expected: expectFailure ? "failure" : "success",
		result: pass ? "PASS" : "FAIL",
	});
	if (!pass) failed = true;
}

function run(label, command, args = [], options = {}) {
	const out = join(resultDir, `${label}.out`);
	const err = join(resultDir, `${label}.err`);
	const result = spawnSync(command, args, {
		cwd: root,
		encoding: "utf8",
		env: {
			...process.env,
			PI_WORKFLOW_ROLE:
				options.role ?? process.env.PI_WORKFLOW_ROLE ?? "disabled",
		},
	});
	writeFileSync(out, result.stdout ?? "");
	writeFileSync(err, result.stderr ?? "");
	record(
		label,
		[command, ...args],
		result.status ?? 1,
		Boolean(options.expectFailure),
	);
	return result;
}

function nodeEval(label, code, options = {}) {
	return run(
		label,
		process.execPath,
		["--input-type=module", "-e", code],
		options,
	);
}

function ensureCompiledArtifacts() {
	if (existsSync(join(root, ".tmp", "unit", "workflow-specs.js"))) return;
	run("test-build", "npm", ["run", "test:build"]);
}

function assertNoLegacyTerms() {
	const forbidden = [
		"rec" + "ipe",
		"Rec" + "ipe",
		"rec" + "ipes",
		"Rec" + "ipes",
		"/fl" + "ow",
		"fl" + "ow-rec" + "ipes",
		"workfl" + "ow-rec" + "ipes",
		"\\.pi/fl" + "ows",
	];
	// Dated handoff records may mention banned terms as policy statements
	// (e.g. "terminology is workflow, not <legacy term>"); they are internal
	// historical notes, not public usage.
	const result = run(
		"grep-legacy-terms",
		"bash",
		[
			"-lc",
			`grep -RInE '${forbidden.join("|")}' src test README.md docs workflows package.json 2>/dev/null`,
		],
		{ expectFailure: true },
	);
	return result;
}

function main() {
	console.log(`Writing E2E evidence to ${relative(root, resultDir)}`);

	ensureCompiledArtifacts();
	run("diff-check", "git", ["diff", "--check"]);
	assertNoLegacyTerms();

	nodeEval(
		"workflow-registry",
		`
    import { listWorkflows, recommendWorkflows, resolveWorkflowRef } from './.tmp/unit/workflow-specs.js';
    const cwd = process.cwd();
    const workflows = await listWorkflows(cwd);
    const names = workflows.map((item) => item.name).sort();
    const expected = ['deep-research', 'deep-review', 'implement-loop', 'test-repair-loop'];
    for (const name of expected) {
      if (!names.includes(name)) throw new Error('missing workflow: ' + name + ' in ' + names.join(','));
    }
    const resolved = await resolveWorkflowRef('deep-research', cwd);
    if (!resolved.specPath.endsWith('workflows/deep-research/spec.json')) throw new Error('bad resolved path: ' + resolved.specPath);
    const recs = await recommendWorkflows('need detailed accurate research with verification', cwd);
    if (!recs.some((item) => item.workflow.name === 'deep-research')) throw new Error('deep-research not recommended');
  `,
	);

	nodeEval(
		"workflow-parse-compile",
		`
    import { readFile } from 'node:fs/promises';
    import { parseWorkflow } from './.tmp/unit/schema.js';
    import { compileWorkflow } from './.tmp/unit/compiler.js';
    const reviewSpec = parseWorkflow(JSON.parse(await readFile('workflows/deep-review/spec.json', 'utf8')));
    if (reviewSpec.schemaVersion !== 1) throw new Error('bad review schema');
    if (!reviewSpec.workflow?.stages?.length) throw new Error('missing review workflow stages');
    const researchSpec = parseWorkflow(JSON.parse(await readFile('workflows/deep-research/spec.json', 'utf8')));
    const compiledResearch = await compileWorkflow(researchSpec, { cwd: process.cwd(), task: 'Research smoke', specPath: process.cwd() + '/workflows/deep-research/spec.json' });
    const audit = compiledResearch.tasks.find((task) => task.stageId === 'audit-claims');
    if (!audit || audit.kind !== 'support') throw new Error('missing deep-research audit support');
    if (!audit.dependsOn?.includes('verify-claims.item')) throw new Error('bad audit dependency: ' + JSON.stringify(audit.dependsOn));
  `,
	);

	nodeEval(
		"workflow-run-boundary",
		`
    import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { runWorkflow } from './.tmp/unit/engine.js';
    const cwd = mkdtempSync(join(tmpdir(), 'pi-workflow-e2e-'));
    try {
      mkdirSync(join(cwd, '.pi', 'agents'), { recursive: true });
      writeFileSync(join(cwd, '.pi', 'agents', 'unit-scout.md'), '---\\ndescription: unit\\ntools: [read]\\nreadOnly: true\\n---\\n# unit\\n');
      mkdirSync(join(cwd, 'workflows'), { recursive: true });
      writeFileSync(join(cwd, 'workflows', 'unit.json'), JSON.stringify({ schemaVersion: 1, agent: 'unit-scout', readOnly: true, tools: ['read'], workflow: { stages: [{ id: 'main', type: 'task', prompt: 'Do it.' }] } }));
      await runWorkflow('unit', cwd).then(() => { throw new Error('expected missing task rejection'); }, (error) => { if (!/workflow needs a task/.test(String(error))) throw error; });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  `,
	);

	writeReport();
	if (failed) process.exitCode = 1;
}

function writeReport() {
	const lines = [
		"# pi-workflow E2E Smoke Report",
		"",
		`Result: ${failed ? "FAIL" : "PASS"}`,
		"",
		"| Check | Expected | Status | Result |",
		"|---|---:|---:|---|",
		...rows.map(
			(row) =>
				`| ${row.label} | ${row.expected} | ${row.status} | ${row.result} |`,
		),
	];
	writeFileSync(join(resultDir, "report.md"), `${lines.join("\n")}\n`);
	writeFileSync(
		join(root, ".tmp", "test-results", "e2e-report.md"),
		`${lines.join("\n")}\n`,
	);
}

main();
