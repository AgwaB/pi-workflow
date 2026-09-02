#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	accessSync,
	chmodSync,
	constants,
	copyFileSync,
	mkdirSync,
	writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const resultRoot = join(root, ".tmp", "test-results", "e2e");
const stamp = new Date().toISOString().replace(/[-:.]/g, "");
const resultDir = join(
	resultRoot,
	`run-${stamp}-${randomUUID().slice(0, 8)}`,
);
mkdirSync(resultDir, { recursive: true });

const processLog = join(resultDir, "process-tree.jsonl");
const guardModule = join(root, "test", "e2e", "no-external-actions-guard.mjs");
const commandShimSource = join(
	root,
	"test",
	"e2e",
	"no-external-actions-command-shim.mjs",
);
const commandShimDir = join(resultDir, "command-shims");
const isolatedRoot = join(resultDir, "isolated-roots");
const realNpm = findExecutable("npm", process.env.PATH);
mkdirSync(commandShimDir, { recursive: true });
for (const command of ["npm", "npx", "pnpm", "yarn", "bun", "curl", "wget", "pi"]) {
	const shim = join(commandShimDir, command);
	copyFileSync(commandShimSource, shim);
	chmodSync(shim, 0o700);
}
const isolatedEnvironment = {
	HOME: join(isolatedRoot, "home"),
	PI_CODING_AGENT_DIR: join(isolatedRoot, "pi-agent"),
	XDG_CONFIG_HOME: join(isolatedRoot, "xdg-config"),
	XDG_CACHE_HOME: join(isolatedRoot, "xdg-cache"),
	XDG_DATA_HOME: join(isolatedRoot, "xdg-data"),
	XDG_STATE_HOME: join(isolatedRoot, "xdg-state"),
};
for (const path of Object.values(isolatedEnvironment)) {
	mkdirSync(path, { recursive: true });
}
Object.assign(process.env, isolatedEnvironment, {
	PATH: `${commandShimDir}${delimiter}${process.env.PATH ?? ""}`,
	PI_WORKFLOW_E2E_NO_EXTERNAL_ACTIONS: "1",
	PI_WORKFLOW_E2E_PROCESS_LOG: processLog,
	PI_WORKFLOW_E2E_REAL_NPM: realNpm,
	npm_config_offline: "true",
	npm_config_audit: "false",
	npm_config_fund: "false",
	npm_config_update_notifier: "false",
	npm_config_userconfig: join(isolatedRoot, "npmrc"),
	NODE_OPTIONS: [
		process.env.NODE_OPTIONS,
		`--import=${pathToFileURL(guardModule).href}`,
	].filter(Boolean).join(" "),
});
await import(pathToFileURL(guardModule).href);

const rows = [];
let failed = false;

function record(label, command, result, options) {
	const expectedExitCodes = options.expectedExitCodes ?? [0];
	const statusMatches =
		result.status !== null && expectedExitCodes.includes(result.status);
	const stderrMatches =
		!options.stderrPattern || options.stderrPattern.test(result.stderr ?? "");
	const pass = statusMatches && stderrMatches && !result.error;
	const excerptSource = (result.stderr || result.stdout || result.error?.message || "")
		.trim()
		.replace(/\s+/g, " ");
	rows.push({
		label,
		command: command.join(" "),
		status: result.status,
		signal: result.signal,
		error: result.error?.code ?? "",
		durationMs: options.durationMs,
		expected: expectedExitCodes.join(" or "),
		stdout: relative(root, options.stdoutPath),
		stderr: relative(root, options.stderrPath),
		excerpt: excerptSource.slice(0, 240),
		result: pass ? "PASS" : "FAIL",
	});
	if (!pass) failed = true;
}

function skip(label, command, reason) {
	const out = join(resultDir, `${label}.out`);
	const err = join(resultDir, `${label}.err`);
	writeFileSync(out, "");
	writeFileSync(err, `${reason}\n`);
	rows.push({
		label,
		command: command.join(" "),
		status: null,
		signal: null,
		error: "",
		durationMs: 0,
		expected: "skipped",
		stdout: relative(root, out),
		stderr: relative(root, err),
		excerpt: reason,
		result: "SKIP",
	});
}

function insideGitWorktree() {
	const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
		cwd: root,
		encoding: "utf8",
	});
	return result.status === 0 && result.stdout.trim() === "true";
}

function run(label, command, args = [], options = {}) {
	const out = join(resultDir, `${label}.out`);
	const err = join(resultDir, `${label}.err`);
	const startedAt = Date.now();
	const result = spawnSync(command, args, {
		cwd: options.cwd ?? root,
		encoding: "utf8",
		timeout: options.timeoutMs ?? 120_000,
		killSignal: "SIGTERM",
		maxBuffer: 10 * 1024 * 1024,
		env: {
			...process.env,
			PI_WORKFLOW_ROLE:
				options.role ?? process.env.PI_WORKFLOW_ROLE ?? "disabled",
		},
	});
	writeFileSync(out, result.stdout ?? "");
	writeFileSync(err, result.stderr ?? "");
	record(label, [command, ...args], result, {
		...options,
		durationMs: Date.now() - startedAt,
		stdoutPath: out,
		stderrPath: err,
	});
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
	run("test-build", "npm", ["run", "test:build"], {
		timeoutMs: 180_000,
	});
}

function assertNoLegacyTerms() {
	// The scanner uses distinct clean, forbidden-match, and read/setup-error
	// statuses. Only its clean exit code is accepted by the E2E gate.
	const result = run(
		"forbidden-term-scan",
		process.execPath,
		[join(root, "test", "e2e", "forbidden-term-scanner.mjs")],
		{ expectedExitCodes: [0] },
	);
	return result;
}

function main() {
	console.log(`Writing E2E evidence to ${relative(root, resultDir)}`);

	ensureCompiledArtifacts();
	// `git diff --check` only has meaning inside a Git worktree. A git-archive
	// export or packed consumer has no repository, so record an explicit skip
	// instead of failing the whole smoke on exit 129.
	if (insideGitWorktree()) run("diff-check", "git", ["diff", "--check"]);
	else
		skip(
			"diff-check",
			["git", "diff", "--check"],
			"skipped: source root is not inside a Git worktree",
		);
	assertNoLegacyTerms();
	run("cli-help", process.execPath, ["src/cli.mjs", "--help"]);
	run("cli-unknown-command", process.execPath, ["src/cli.mjs", "nope"], {
		expectedExitCodes: [1],
		stderrPattern: /unknown command/i,
	});
	run(
		"packed-web-loader",
		process.execPath,
		[join(root, "test", "e2e", "cases", "packed-web-loader.mjs")],
		{ timeoutMs: 300_000 },
	);
	run("cli-inspect-reliability", "bash", [
		"-lc",
		`set -euo pipefail
        tmp="$(mktemp -d)"
        mkdir -p "$tmp/.pi/workflows/workflow_e2e"
        cat > "$tmp/.pi/workflows/workflow_e2e/run.json" <<'JSON'
{"runId":"workflow_e2e","name":"unit","type":"artifact-graph","status":"completed","tasks":[{"taskId":"task-1","status":"completed","statusDetail":"completed","outputRetry":{"attempts":1,"reason":"workflow_output_invalid"},"resumeEvents":[{"at":"2026-06-08T00:00:00.000Z","fromStatus":"failed","fromStatusDetail":"context_or_request_too_large"}]}]}
JSON
        cd "$tmp"
        output="$(${process.execPath} ${JSON.stringify(join(root, "src", "cli.mjs"))} inspect workflow_e2e)"
        printf '%s\n' "$output"
        grep -q 'completion: repaired' <<<"$output"
        grep -q 'retries: output=1, launch=0, resumes=1, contextLimitFailures=1' <<<"$output"`,
	]);

	nodeEval(
		"workflow-registry",
		`
    import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { listWorkflows, resolveWorkflowRef } from './.tmp/unit/workflow-specs.js';
    const cwd = mkdtempSync(join(tmpdir(), 'pi-workflow-registry-e2e-'));
    try {
      mkdirSync(join(cwd, 'workflows'), { recursive: true });
      const spec = {
        schemaVersion: 1,
        name: 'review-artifact',
        defaults: { agent: 'unit-scout', readOnly: true, tools: ['read'] },
        artifactGraph: { stages: [{ id: 'main', type: 'single', prompt: 'Review.' }] }
      };
      writeFileSync(join(cwd, 'workflows', 'review-artifact.json'), JSON.stringify(spec));
      writeFileSync(join(cwd, 'workflows', 'invalid.json'), JSON.stringify({ schemaVersion: 1, unsupported: true }));
      const workflows = await listWorkflows(cwd);
      const names = workflows.map((item) => item.name).sort();
      if (!names.includes('review-artifact')) throw new Error('missing local workflow: ' + names.join(','));
      if (names.includes('invalid')) throw new Error('invalid workflow should be hidden: ' + names.join(','));
      const resolved = await resolveWorkflowRef('review-artifact', cwd);
      if (!resolved.specPath.endsWith('workflows/review-artifact.json')) throw new Error('bad resolved path: ' + resolved.specPath);
      await resolveWorkflowRef('invalid', cwd).then(() => { throw new Error('invalid workflow should not resolve'); }, (error) => { if (!/workflow name or spec file not found/.test(String(error))) throw error; });
      for (const bundled of ['spec-review', 'deep-review', 'deep-research', 'impact-review']) {
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
    const publicSpec = parseWorkflow({ schemaVersion: 1, artifactGraph: { stages: [{ id: 'main', type: 'single', prompt: 'Do it.' }] } });
    if (publicSpec.schemaVersion !== 1) throw new Error('bad artifact graph schema');
    if (!publicSpec.artifactGraph?.stages?.length) throw new Error('missing artifact graph stages');
    const bundled = [
      ['spec-review', 'workflows/spec-review/spec.json', 'final'],
      ['deep-review', 'workflows/deep-review/spec.json', 'final'],
      ['deep-research', 'workflows/deep-research/spec.json', 'final'],
      ['impact-review', 'workflows/impact-review/spec.json', 'impact-analysis.final'],
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
		"workflow-web-source-cache",
		`
    import { mkdtempSync, rmSync, existsSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { registerWorkflowWebSourceExtension } from './.tmp/unit/workflow-web-source-extension.js';
    import { createWorkflowWebSource, writeWorkflowWebSource } from './.tmp/unit/workflow-web-source.js';
    const cwd = mkdtempSync(join(tmpdir(), 'pi-workflow-web-source-e2e-'));
    try {
      const cacheDir = join(cwd, '.pi', 'workflows', 'workflow_e2e', 'web-source-cache');
      const config = { runId: 'workflow_e2e', taskId: 'task-1', cacheDir };
      const source = createWorkflowWebSource({ config, url: 'https://example.test/source', text: 'Exact source quote: alpha beta gamma.', provider: 'provider-free-e2e-fixture' });
      await writeWorkflowWebSource(config, source);
      const registered = new Map();
      registerWorkflowWebSourceExtension(
        { registerTool(tool) { registered.set(tool.name, tool); } },
        { schema: 'workflow-web-source-launch-config-v1', ...config, cwd, provider: { kind: 'none' }, exposedWorkflowTools: ['workflow_web_source_read'], webSourcePolicy: { sourceReadMaxChars: 80, perTaskVisibleCharBudget: 320 } },
      );
      if (registered.size !== 1 || !registered.has('workflow_web_source_read')) throw new Error('unexpected provider-free tool inventory');
      const read = await registered.get('workflow_web_source_read').execute('read', { sourceRef: source.sourceRef, query: 'alpha beta gamma' });
      if (!read.content[0].text.includes('alpha beta gamma')) throw new Error('source-read quote missing');
      const batch = await registered.get('workflow_web_source_read').execute('read-batch', { sourceRef: source.sourceRef, reads: [{ query: 'Exact source quote' }, { claim: 'alpha beta gamma source quote', terms: ['alpha beta', 'gamma'] }, { query: 'missing phrase' }] });
      const batchBody = JSON.parse(batch.content[0].text);
      if (!Array.isArray(batchBody.results) || batchBody.results.length !== 3) throw new Error('batch source-read results missing');
      if (batchBody.results[0].status !== 'ok' || batchBody.results[1].status !== 'candidate' || batchBody.results[1].matchType !== 'terms' || batchBody.results[2].status !== 'not_found') throw new Error('batch source-read statuses wrong');
      if (!existsSync(join(cacheDir, 'events.jsonl'))) throw new Error('missing telemetry events');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
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

	nodeEval(
		"no-external-actions",
		`
    import { readFileSync } from 'node:fs';
    const lines = readFileSync(${JSON.stringify(processLog)}, 'utf8').trim().split(/\\r?\\n/).filter(Boolean);
    const events = lines.map((line) => JSON.parse(line));
    if (!events.some((event) => event.type === 'process-start')) throw new Error('missing process-tree startup instrumentation');
    if (!events.some((event) => event.type === 'child-process')) throw new Error('missing child-process instrumentation');
    if (!events.some((event) => event.type === 'command-shim' && event.command === 'npm' && event.classification === 'allowed')) throw new Error('npm pack/run shim was not exercised');
    const forbidden = events.filter((event) => ['blocked-command', 'network-attempt', 'provider-tool-execution'].includes(event.type));
    if (forbidden.length > 0) throw new Error('forbidden E2E process activity: ' + JSON.stringify(forbidden));
    console.log(JSON.stringify({ processEvents: events.length, forbiddenEvents: forbidden.length }));
  `,
	);

	writeReport();
	if (failed) process.exitCode = 1;
}

function findExecutable(name, pathValue) {
	for (const directory of String(pathValue ?? "").split(delimiter)) {
		if (!directory) continue;
		const candidate = join(directory, name);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Continue searching PATH.
		}
	}
	throw new Error(`required executable not found on PATH: ${name}`);
}

function writeReport() {
	const lines = [
		"# pi-workflow E2E Smoke Report",
		"",
		`Result: ${failed ? "FAIL" : "PASS"}`,
		"",
		"| Check | Expected exit | Status | Signal/error | Duration | Result | Evidence | Excerpt |",
		"|---|---:|---:|---|---:|---|---|---|",
		...rows.map((row) => {
			const signalError = [row.signal, row.error].filter(Boolean).join("/") || "—";
			const evidence = `\`${row.stdout}\` / \`${row.stderr}\``;
			return `| ${reportCell(row.label)} | ${row.expected} | ${row.status ?? "null"} | ${reportCell(signalError)} | ${row.durationMs}ms | ${row.result} | ${evidence} | ${reportCell(row.excerpt || "—")} |`;
		}),
	];
	writeFileSync(join(resultDir, "report.md"), `${lines.join("\n")}\n`);
	writeFileSync(
		join(root, ".tmp", "test-results", "e2e-report.md"),
		`${lines.join("\n")}\n`,
	);
}

function reportCell(value) {
	return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

main();
