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
	// Dated handoff records may mention banned terms as policy statements;
	// they are internal historical notes, not public usage.
	const result = run(
		"grep-forbidden-terms",
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
	run("cli-help", process.execPath, ["src/cli.mjs", "--help"]);
	run("cli-unknown-command", process.execPath, ["src/cli.mjs", "nope"], {
		expectFailure: true,
	});
	run("consumer-install-cli", "bash", [
		"-lc",
		`set -euo pipefail
        tmp="$(mktemp -d)"
        tarball="$(npm pack --pack-destination "$tmp" --silent | tail -1)"
        cd "$tmp"
        npm init -y >/dev/null
        peer_flag="--leg""acy-peer-deps"
        npm install "$peer_flag" "./$tarball" >/dev/null
        node node_modules/@agwab/pi-workflow/src/cli.mjs --help >/dev/null
        ./node_modules/.bin/pi-workflow --help >/dev/null
        PI_WORKFLOW_ROLE=supervisor ./node_modules/.bin/pi-workflow supervise --all --poll-ms 250 --max-runtime-ms 1000 >/dev/null
        node --input-type=module -e "import { parseWorkflow, WORKFLOW_COMMAND } from '@agwab/pi-workflow'; if (typeof parseWorkflow !== 'function' || WORKFLOW_COMMAND !== 'workflow') throw new Error('bad public import')"`,
	]);

	nodeEval(
		"workflow-registry",
		`
    import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { listWorkflows, recommendWorkflows, resolveWorkflowRef } from './.tmp/unit/workflow-specs.js';
    const cwd = mkdtempSync(join(tmpdir(), 'pi-workflow-registry-e2e-'));
    try {
      mkdirSync(join(cwd, 'workflows'), { recursive: true });
      const spec = {
        schemaVersion: 1,
        name: 'review-artifact',
        catalog: { useWhen: ['artifact graph review'], naturalLanguageTriggers: ['review artifact graph'] },
        defaults: { agent: 'unit-scout', readOnly: true, tools: ['read'] },
        artifactGraph: { stages: [{ id: 'main', type: 'task', prompt: 'Review.' }] }
      };
      writeFileSync(join(cwd, 'workflows', 'review-artifact.json'), JSON.stringify(spec));
      writeFileSync(join(cwd, 'workflows', 'invalid.json'), JSON.stringify({ schemaVersion: 1, unsupported: true }));
      const workflows = await listWorkflows(cwd);
      const names = workflows.map((item) => item.name).sort();
      if (names.join(',') !== 'review-artifact') throw new Error('unexpected workflows: ' + names.join(','));
      const resolved = await resolveWorkflowRef('review-artifact', cwd);
      if (!resolved.specPath.endsWith('workflows/review-artifact.json')) throw new Error('bad resolved path: ' + resolved.specPath);
      const recs = await recommendWorkflows('please review artifact graph', cwd);
      if (recs[0]?.workflow.name !== 'review-artifact') throw new Error('review-artifact not recommended');
      await resolveWorkflowRef('invalid', cwd).then(() => { throw new Error('invalid workflow should not resolve'); }, (error) => { if (!/workflow name or spec file not found/.test(String(error))) throw error; });
      for (const bundled of ['change-impact-review', 'spec-review', 'deep-review', 'deep-research', 'deep-execution-review', 'implement-loop']) {
        const resolvedBundled = await resolveWorkflowRef(bundled, process.cwd());
        if (!resolvedBundled.specPath.includes('/workflows/')) throw new Error('bad bundled path for ' + bundled + ': ' + resolvedBundled.specPath);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  `,
	);

	nodeEval(
		"workflow-parse-compile",
		`
    import { readFile } from 'node:fs/promises';
    import { parseWorkflow } from './.tmp/unit/schema.js';
    import { compileWorkflow } from './.tmp/unit/compiler.js';
    const publicSpec = parseWorkflow({ schemaVersion: 1, artifactGraph: { stages: [{ id: 'main', type: 'task', prompt: 'Do it.' }] } });
    if (publicSpec.schemaVersion !== 1) throw new Error('bad artifact graph schema');
    if (!publicSpec.artifactGraph?.stages?.length) throw new Error('missing artifact graph stages');
    const bundled = [
      ['change-impact-review', 'workflows/change-impact-review/spec.json', 'impact-analysis.impact-synthesis'],
      ['spec-review', 'workflows/spec-review/spec.json', 'report'],
      ['deep-review', 'workflows/deep-review/spec.json', 'report'],
      ['deep-research', 'workflows/deep-research/spec.json', 'final'],
      ['deep-execution-review', 'workflows/deep-execution-review/spec.json', 'synthesis'],
      ['implement-loop', 'workflows/implement-loop/spec.json', 'fix-loop'],
    ];
    for (const [name, specPath, expectedStage] of bundled) {
      const spec = parseWorkflow(JSON.parse(await readFile(specPath, 'utf8')));
      const compiled = await compileWorkflow(spec, { cwd: process.cwd(), task: name + ' smoke', specPath: process.cwd() + '/' + specPath });
      if (!compiled.artifactGraph?.enabled) throw new Error(name + ' did not compile as artifact graph');
      if (!compiled.tasks.some((task) => task.stageId === expectedStage)) throw new Error('missing expected stage for ' + name + ': ' + expectedStage);
    }
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
      writeFileSync(join(cwd, 'workflows', 'unit.json'), JSON.stringify({ schemaVersion: 1, unsupported: true }));
      await runWorkflow('unit', cwd).then(() => { throw new Error('expected missing task rejection'); }, (error) => { if (!/workflow needs a task/.test(String(error))) throw error; });
      await runWorkflow('workflows/unit.json', cwd, { task: 'Do it.' }).then(() => { throw new Error('expected invalid spec rejection'); }, (error) => { if (!/unknown field/.test(String(error))) throw error; });
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
