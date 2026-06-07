#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultRoot = join(root, "e2e-test", "results");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const resultDir = join(resultRoot, `run-${stamp}`);
const STAGE_FIRST_RUN_TYPE = "stage-v2";
const piArgs = [
  "--offline",
  "--no-session",
  "--no-context-files",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--model",
  E2E_MODEL,
  "--thinking",
  E2E_THINKING,
  "-e",
  root,
];

mkdirSync(resultDir, { recursive: true });

const commandLog = [];
const validationRows = [];
const runtimeRows = [];
let failed = false;

const runtimeScenarios = [
  "01-single-token.json",
  "02-parallel-tokens.json",
  "03-chain-context.json",
  "04-role-injection.json",
  "05-managed-worktree-git.json",
  "06-blocked-on-request.json",
  "07-worktree-nongit-fail.json",
  "08-bootstrap-cwd-fail.json",
  "09-auto-worktree-mutation.json",
  "10-chain-failure-skip.json",
  "11-timeout.json",
  "12-unknown-custom-tool-blocked.json",
  "13-status-reconciles-without-wait.json",
  "14-parallel-aggregate.json",
  "15-dag-topology.json",
  "16-map-splitter.json",
  "17-route-splitter.json",
  "18-vote-helper.json",
  "19-retry-helper.json",
  "20-tree-topology.json",
  "21-tree-failure-skip.json",
  "22-retry-exhaustion.json",
  "23-partition-splitter.json",
  "24-until-pass-helper.json",
  "25-until-pass-exhaustion.json",
  "27-synthesize-helper.json",
];

const runtimeRecipeScenarios = [
  {
    label: "28-named-recipe",
    ref: "quick-check",
    assertion: "28-named-recipe",
    task: "Reply exactly FLOW_RECIPE_QUICK_CHECK_OK and do not inspect or modify files.",
  },
];

const DEFAULT_STAGE_FIRST_E2E_TASK = "Run this e2e scenario. Follow the stage instructions exactly and do not modify files.";

const runtimeRecipeScenarios = [
  { label: "14-named-recipe", ref: "e2e-single-recipe", assertion: "14-named-recipe" },
];

const runtimeRecipeScenarios = [
  { label: "14-named-recipe", ref: "e2e-single-recipe", assertion: "14-named-recipe" },
];

const runtimeRecipeScenarios = [
  { label: "14-named-recipe", ref: "e2e-single-recipe", assertion: "14-named-recipe" },
];

try {
  await main();
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  const lockCount = countFlowLocks();
  const paneCount = countProjectTmuxPanes();
  if (lockCount !== 0) failed = true;
  if (paneCount !== 0) failed = true;
  writeReport({ lockCount, paneCount });
}

if (failed) process.exitCode = 1;

async function main() {
  console.log(`Writing E2E evidence to ${relative(root, resultDir)}`);
  console.log(`E2E model: ${E2E_MODEL} thinking=${E2E_THINKING}`);

  runLocal("setup-fixtures", "bash", ["e2e-test/setup-fixtures.sh"]);
  runLocal("typecheck", "npm", ["run", "typecheck"]);
  runPi("flow-help", "/flow help");
  runPi("flow-recipe-list", "/flow recipe list");
  runPi("flow-recipe-show-quick-check", "/flow recipe show quick-check");

  for (const file of listSpecFiles(join(root, "examples"))) {
    runPi(`validate-example-${basename(file, ".json")}`, `/flow validate ${toProjectPath(file)}`);
    validationRows.push({ scenario: toProjectPath(file), expected: "valid", result: "PASS" });
  }

  for (const name of runtimeScenarios) {
    const file = join(root, "e2e-test", "scenarios", name);
    runPi(`validate-${basename(name, ".json")}`, `/flow validate ${toProjectPath(file)}`);
    validationRows.push({ scenario: toProjectPath(file), expected: "valid", result: "PASS" });
  }

  for (const recipe of runtimeRecipeScenarios) {
    runPi(`validate-recipe-${recipe.ref}`, `/flow validate ${recipe.ref}`);
    validationRows.push({ scenario: recipe.ref, expected: "valid recipe", result: "PASS" });
  }

  for (const recipe of runtimeRecipeScenarios) {
    runPi(`validate-recipe-${recipe.ref}`, `/flow validate ${recipe.ref}`);
    validationRows.push({ scenario: recipe.ref, expected: "valid recipe", result: "PASS" });
  }

  for (const recipe of runtimeRecipeScenarios) {
    runPi(`validate-recipe-${recipe.ref}`, `/flow validate ${recipe.ref}`);
    validationRows.push({ scenario: recipe.ref, expected: "valid recipe", result: "PASS" });
  }

  for (const file of listSpecFiles(join(root, "flows"))) {
    runPi(`validate-flow-recipe-${basenameWithoutSpecExtension(file)}`, `/flow validate ${basenameWithoutSpecExtension(file)}`);
    validationRows.push({ scenario: basenameWithoutSpecExtension(file), expected: "valid recipe", result: "PASS" });
  }

  for (const file of listSpecFiles(join(root, "e2e-test", "scenarios", "invalid"))) {
    const result = runPi(`validate-invalid-${basename(file, ".json")}`, `/flow validate ${toProjectPath(file)}`, { expectFailure: true });
    validationRows.push({
      scenario: toProjectPath(file),
      expected: "invalid",
      result: result.status === 0 ? "FAIL" : "PASS",
    });
  }

  for (const name of runtimeScenarios) {
    await runRuntimeScenario(name);
  }
  for (const recipe of runtimeRecipeScenarios) {
    await runRuntimeSpec(recipe);
  }
  for (const recipe of runtimeRecipeScenarios) {
    await runRuntimeSpec(recipe);
  }
  for (const recipe of runtimeRecipeScenarios) {
    await runRuntimeSpec(recipe);
  }
  for (const recipe of runtimeRecipeScenarios) {
    await runRuntimeSpec(recipe);
  }

  runLocal("pack-dry", "npm", ["run", "pack:dry"]);
}

function runLocal(label, command, args, options = {}) {
  return runCommand(label, command, args, options);
}

function runPi(label, prompt, options = {}) {
  return runCommand(label, "pi", [...piArgs, "-p", prompt], options);
}

function runCommand(label, command, args, options = {}) {
  const evidence = join(resultDir, `${safeName(label)}.out`);
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  const status = result.status ?? (result.error ? 1 : 0);
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const commandText = [command, ...args].map(shellDisplay).join(" ");
  const body = [
    `$ ${commandText}`,
    `startedAt=${startedAt}`,
    `exitCode=${status}`,
    "",
    "## stdout",
    stdout,
    "",
    "## stderr",
    stderr,
    result.error ? `\n## spawn error\n${result.error.message}` : "",
  ].join("\n");
  writeFileSync(evidence, body);

  const ok = options.expectFailure ? status !== 0 : (options.okCodes ?? [0]).includes(status);
  const commandRecord = { label, command: commandText, exitCode: status, evidence: toProjectPath(evidence), ok };
  if (options.record !== false) {
    commandLog.push(commandRecord);
    console.log(`${ok ? "✓" : "✗"} ${label}`);
  }
  if (!ok) {
    failed = true;
    throw new Error(`Command failed for ${label}; see ${toProjectPath(evidence)}`);
  }

  return { status, stdout, stderr, evidence, commandRecord };
}

async function runRuntimeScenario(name) {
  const scenarioPath = join(root, "e2e-test", "scenarios", name);
  const spec = JSON.parse(readFileSync(scenarioPath, "utf8"));
  await runRuntimeSpec({
    label: basename(name, ".json"),
    ref: toProjectPath(scenarioPath),
    assertion: name,
    task: spec.schemaVersion === 1 ? DEFAULT_STAGE_FIRST_E2E_TASK : undefined,
  });
}

async function runRuntimeSpec(scenario) {
  const task = scenario.task ? ` ${scenario.task}` : "";
  const runResult = runPi(`${scenario.label}-run`, `/flow run ${scenario.ref}${task}`);
  const runId = extractRunId(runResult.stdout + "\n" + runResult.stderr);
  if (!runId) throw new Error(`Could not find flow run id for ${scenario.ref}; see ${toProjectPath(runResult.evidence)}`);

  let statusEvidence = runResult.evidence;
  if (scenario.assertion === "13-status-reconciles-without-wait.json") {
    statusEvidence = await waitViaGlobalStatus(scenario.label, runId);
  } else {
    const waitResult = runPi(`${scenario.label}-wait`, `/flow wait ${runId} 240000`, { okCodes: [0, 1] });
    statusEvidence = waitResult.evidence;
  }

  let run = readRun(runId);
  if (scenario.assertion === "36-v2-continuation-continue.json") {
    runPi(`${scenario.label}-continue`, `/flow continue ${runId}`, { okCodes: [0, 1] });
    run = readRun(runId);
  }
  if ((scenario.assertion === "33-v2-continuation-auto.json" || scenario.assertion === "36-v2-continuation-continue.json") && run.continuation?.childRunId) {
    runPi(`${scenario.label}-child-wait`, `/flow wait ${run.continuation.childRunId} 240000`, { okCodes: [0, 1] });
    const childRun = readRun(run.continuation.childRunId);
    copyRunEvidence(`${scenario.label}-child`, childRun.runId, childRun);
    run = readRun(runId);
  }
  copyRunEvidence(scenario.label, runId, run);
  const assertion = assertScenario(scenario.assertion, run);
  runtimeRows.push({
    scenario: scenario.ref,
    runId,
    expected: assertion.expected,
    result: assertion.ok ? "PASS" : "FAIL",
    detail: assertion.detail,
    evidence: toProjectPath(join(resultDir, `${scenario.label}-run.json`)),
    statusEvidence: toProjectPath(statusEvidence),
  });
  if (!assertion.ok) {
    failed = true;
    throw new Error(`Runtime assertion failed for ${scenario.ref}: ${assertion.detail}`);
  }
  console.log(`✓ ${scenario.label} assertions`);
}

async function waitViaGlobalStatus(scenarioName, runId) {
  let lastEvidence;
  for (let attempt = 1; attempt <= 90; attempt += 1) {
    const result = runPi(`${scenarioName}-status`, "/flow status", { record: false });
    lastEvidence = result.evidence;
    const text = result.stdout + "\n" + result.stderr;
    if (new RegExp(`${escapeRegExp(runId)} \\[completed\\]`).test(text)) {
      recordCommand(result.commandRecord);
      return lastEvidence;
    }
    if (new RegExp(`${escapeRegExp(runId)} \\[(failed|blocked|interrupted)\\]`).test(text)) {
      recordCommand(result.commandRecord);
      return lastEvidence;
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${runId} through /flow status; see ${toProjectPath(lastEvidence)}`);
}

function recordCommand(commandRecord) {
  commandLog.push(commandRecord);
  console.log(`${commandRecord.ok ? "✓" : "✗"} ${commandRecord.label}`);
}

function recordCommand(commandRecord) {
  commandLog.push(commandRecord);
  console.log(`${commandRecord.ok ? "✓" : "✗"} ${commandRecord.label}`);
}

function recordCommand(commandRecord) {
  commandLog.push(commandRecord);
  console.log(`${commandRecord.ok ? "✓" : "✗"} ${commandRecord.label}`);
}

function recordCommand(commandRecord) {
  commandLog.push(commandRecord);
  console.log(`${commandRecord.ok ? "✓" : "✗"} ${commandRecord.label}`);
}

function assertScenario(name, run) {
  const first = run.tasks[0];
  const second = run.tasks[1];
  switch (name) {
    case "01-single-token.json":
      return expect(run.status === "completed" && taskHasOutput(first, "E2E_SINGLE_OK"), "completed + E2E_SINGLE_OK", run);
    case "02-parallel-tokens.json":
      return expect(
        run.status === "completed" && taskHasOutput(first, "E2E_PARALLEL_A_OK") && taskHasOutput(second, "E2E_PARALLEL_B_OK"),
        "two completed tasks + distinct tokens",
        run,
      );
    case "03-chain-context.json":
      return expect(run.status === "completed" && taskHasOutput(second, "E2E_CHAIN_CONTEXT_OK"), "chain step 2 sees step 1 token", run);
    case "04-role-injection.json":
      return expect(run.status === "completed" && taskHasOutput(first, "E2E_ROLE_CONTEXT_OK"), "role context visible to child task", run);
    case "05-managed-worktree-git.json":
      return expect(
        run.status === "completed" && first?.worktree?.enabled === true && taskHasOutput(first, "E2E_WORKTREE_GIT_OK"),
        "explicit managed worktree + token",
        run,
      );
    case "06-blocked-on-request.json":
      return expect(
        run.status === "completed" && first?.worktree?.enabled === false && taskHasOutput(first, "E2E_WORKTREE_OFF_OK"),
        "worktreePolicy off launches without managed worktree",
        run,
      );
    case "07-worktree-nongit-fail.json":
      return expect(
        run.status === "completed" && first?.worktree?.enabled === true && taskHasOutput(first, "E2E_REQUIRED_WORKTREE_OK"),
        "required managed worktree + token",
        run,
      );
    case "08-bootstrap-cwd-fail.json":
      return expect(run.status === "completed" && taskHasOutput(first, "E2E_BOOTSTRAP_PROJECT_CWD_OK"), "project cwd bootstrap + token", run);
    case "09-auto-worktree-mutation.json":
      return expect(
        run.status === "completed" && first?.worktree?.enabled === true && taskHasOutput(first, "E2E_AUTO_WORKTREE_OK"),
        "auto managed worktree + token",
        run,
      );
    case "10-chain-failure-skip.json":
      return expect(run.status === "failed" && first?.status === "failed" && second?.status === "skipped" && second?.statusDetail === "skipped_after_stage_failure", "failed first stage skips dependent reduce", run);
    case "11-timeout.json":
      return expect(run.status === "failed" && first?.status === "failed" && first?.statusDetail === "timeout" && first?.exitCode === 124 && !taskHasOutput(first, "E2E_TIMEOUT_SHOULD_NOT_APPEAR"), "timeout becomes failed/timeout exit 124", run);
    case "12-unknown-custom-tool-blocked.json":
      return expect(run.status === "blocked" && first?.status === "blocked" && first?.statusDetail === "needs_attention" && !first?.paneId, "unknown custom tool blocks with no pane", run);
    case "13-status-reconciles-without-wait.json":
      return expect(run.status === "completed" && taskHasOutput(first, "E2E_STATUS_RECONCILE_OK"), "global status reconciles completion without wait", run);
    case "14-parallel-aggregate.json": {
      const aggregate = run.tasks[2];
      return expect(
        run.status === "failed" && first?.status === "completed" && second?.status === "failed" && aggregate?.taskId === "aggregate.main" && aggregate?.status === "completed" && taskHasOutput(aggregate, "E2E_AGGREGATE_OK"),
        "aggregate receives completed/failed task context and emits token",
        run,
      );
    }
    case "15-dag-topology.json": {
      const join = run.tasks[2];
      return expect(
        run.status === "completed" && first?.status === "completed" && second?.status === "completed" && join?.taskId === "dag-join.main" && join?.status === "completed" && taskHasOutput(join, "E2E_DAG_JOIN_OK"),
        "roots complete before dependent reduce join with source context",
        run,
      );
    }
    case "16-map-splitter.json": {
      const aggregate = run.tasks[2];
      return expect(
        run.status === "completed" && first?.taskId === "items.alpha" && second?.taskId === "items.beta" && aggregate?.taskId === "aggregate.main" && taskHasOutput(first, "MAP_ALPHA_TOKEN") && taskHasOutput(second, "MAP_BETA_TOKEN") && taskHasOutput(aggregate, "E2E_MAP_AGGREGATE_OK"),
        "map items expand into tasks and aggregate receives output previews",
        run,
      );
    }
    case "17-route-splitter.json": {
      const aggregate = run.tasks[2];
      return expect(
        run.status === "completed" && first?.taskId === "routes.ui" && second?.taskId === "routes.api" && aggregate?.taskId === "aggregate.main" && taskHasOutput(first, "ROUTE_UI_TOKEN") && taskHasOutput(second, "ROUTE_API_TOKEN") && taskHasOutput(aggregate, "E2E_ROUTE_AGGREGATE_OK"),
        "route items dispatch to route tasks and aggregate receives output previews",
        run,
      );
    }
    case "18-vote-helper.json": {
      const vote = run.tasks[2];
      return expect(
        run.status === "completed" && vote?.taskId === "vote.main" && taskHasOutput(vote, "E2E_VOTE_OK"),
        "vote helper receives branch output previews",
        run,
      );
    }
    case "19-retry-helper.json":
      return expect(
        run.status === "completed" && run.tasks.length === 1 && first?.status === "completed" && taskHasOutput(first, "E2E_RETRY_FIRST_OK"),
        "explicit retry-style first attempt completes",
        run,
      );
    case "20-tree-topology.json":
      return expect(run.status === "completed" && taskHasOutput(second, "E2E_TREE_CHILD_OK"), "tree parent dependency context reaches child", run);
    case "21-tree-failure-skip.json":
      return expect(
        run.status === "failed" && first?.status === "failed" && second?.status === "skipped" && second?.statusDetail === "skipped_after_stage_failure" && !second?.paneId,
        "child-style reduce skips when source fails",
        run,
      );
    case "22-retry-exhaustion.json":
      return expect(
        run.status === "failed" && first?.status === "failed" && second?.status === "failed",
        "retry helper launches next attempt after failure and fails after exhaustion",
        run,
      );
    case "23-partition-splitter.json": {
      const aggregate = run.tasks[2];
      return expect(
        run.status === "completed" && first?.taskId === "partitions.package-a" && second?.taskId === "partitions.package-b" && aggregate?.taskId === "aggregate.main" && taskHasOutput(first, "PARTITION_A_TOKEN") && taskHasOutput(second, "PARTITION_B_TOKEN") && taskHasOutput(aggregate, "E2E_PARTITION_AGGREGATE_OK"),
        "partition items expand into scoped tasks and aggregate receives output previews",
        run,
      );
    }
    case "24-until-pass-helper.json":
      return expect(
        run.status === "completed" && first?.taskId === "work.main" && second?.taskId === "check.main" && taskHasOutput(second, "PASS E2E_UNTIL_PASS_OK"),
        "explicit work/check stages pass after source context check",
        run,
      );
    case "25-until-pass-exhaustion.json":
      return expect(
        run.status === "completed" && run.tasks.length === 2 && taskHasOutput(second, "FAIL still not good"),
        "explicit work/check stages can report a failing check result without hidden loop semantics",
        run,
      );
    case "28-named-recipe":
      return expect(run.status === "completed" && run.specPath.endsWith("flows/quick-check.json") && taskHasOutput(first, "FLOW_RECIPE_QUICK_CHECK_OK"), "named recipe resolves and runs by exact name", run);
    case "14-named-recipe":
      return expect(run.status === "completed" && run.specPath.endsWith("flows/e2e-single-recipe.yaml") && taskHasOutput(first, "E2E_RECIPE_OK"), "named recipe resolves and runs by exact name", run);
    case "14-named-recipe":
      return expect(run.status === "completed" && run.specPath.endsWith("flows/e2e-single-recipe.yaml") && taskHasOutput(first, "E2E_RECIPE_OK"), "named recipe resolves and runs by exact name", run);
    case "14-named-recipe":
      return expect(run.status === "completed" && run.specPath.endsWith("flows/e2e-single-recipe.yaml") && taskHasOutput(first, "E2E_RECIPE_OK"), "named recipe resolves and runs by exact name", run);
    default:
      return { ok: false, expected: "known scenario", detail: `no assertion for ${name}` };
  }
}

function expect(ok, expected, run) {
  return {
    ok,
    expected,
    detail: ok ? "ok" : `run status=${run.status}; tasks=${run.tasks.map((task) => `${task.taskId}:${task.status}/${task.statusDetail}`).join(",")}`,
  };
}

function taskHasOutput(task, token) {
  if (!task?.files?.output) return false;
  const path = fromProjectPath(task.files.output);
  if (!existsSync(path)) return false;
  return readFileSync(path, "utf8").includes(token);
}

function taskResult(task) {
  if (!task?.files?.result) return undefined;
  const path = fromProjectPath(task.files.result);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8"));
}

function readRun(runId) {
  const runPath = join(root, ".pi", "flows", runId, "run.json");
  return JSON.parse(readFileSync(runPath, "utf8"));
}

function copyRunEvidence(scenarioName, runId, run) {
  const runPath = join(root, ".pi", "flows", runId, "run.json");
  copyIfExists(runPath, join(resultDir, `${scenarioName}-run.json`));
  for (const task of run.tasks) {
    for (const key of ["output", "stderr", "result"]) {
      const artifact = task.files?.[key];
      if (artifact) copyIfExists(fromProjectPath(artifact), join(resultDir, `${scenarioName}-${task.taskId}-${key}.log`));
    }
  }
}

function copyIfExists(source, target) {
  if (!existsSync(source)) return;
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

function listSpecFiles(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json") || name.endsWith(".yaml") || name.endsWith(".yml"))
    .sort()
    .map((name) => join(dir, name));
}

function basenameWithoutSpecExtension(file) {
  return basename(file).replace(/\.(json|ya?ml)$/i, "");
}

function basenameWithoutSpecExtension(file) {
  return basename(file).replace(/\.(json|ya?ml)$/i, "");
}

function basenameWithoutSpecExtension(file) {
  return basename(file).replace(/\.(json|ya?ml)$/i, "");
}

function basenameWithoutSpecExtension(file) {
  return basename(file).replace(/\.(json|ya?ml)$/i, "");
}

function extractRunId(text) {
  return text.match(/flow_[a-z0-9_]+/)?.[0];
}

function fromProjectPath(path) {
  return isAbsolute(path) ? path : join(root, path);
}

function toProjectPath(path) {
  return relative(root, path).replaceAll("\\", "/");
}

function safeName(name) {
  return name.replace(/[^a-zA-Z0-9_.-]+/g, "-");
}

function shellDisplay(value) {
  if (/^[a-zA-Z0-9_./:=@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function countFlowLocks() {
  const result = spawnSync("find", [join(root, ".pi", "flows"), "-name", "*.lock", "-type", "f"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) return 0;
  return result.stdout.split(/\r?\n/).filter(Boolean).length;
}

function countProjectTmuxPanes() {
  const result = spawnSync("tmux", ["list-panes", "-a", "-F", "#{pane_id} #{pane_current_command} #{pane_current_path}"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) return 0;
  return result.stdout.split(/\r?\n/).filter((line) => line.includes(root)).length;
}

function writeReport({ lockCount, paneCount }) {
  const passRuntime = runtimeRows.filter((row) => row.result === "PASS").length;
  const passValidation = validationRows.filter((row) => row.result === "PASS").length;
  const report = [
    "# pi-subagent-flow E2E report",
    "",
    `Date: ${new Date().toISOString()}`,
    `Result: ${failed ? "FAIL" : "PASS"}`,
    `Evidence: ${toProjectPath(resultDir)}`,
    "",
    "## Summary",
    "",
    `- Runtime scenarios: ${runtimeRows.length} total, ${passRuntime} passed, ${runtimeRows.length - passRuntime} failed`,
    `- Validation scenarios: ${validationRows.length} total, ${passValidation} passed, ${validationRows.length - passValidation} failed`,
    `- Remaining project tmux panes: ${paneCount}`,
    `- Remaining flow lock files: ${lockCount}`,
    "",
    "## Commands",
    "",
    "| Label | Exit | Result | Evidence |",
    "|---|---:|---:|---|",
    ...commandLog.map((row) => `| ${row.label} | ${row.exitCode} | ${row.ok ? "PASS" : "FAIL"} | \`${row.evidence}\` |`),
    "",
    "## Runtime scenarios",
    "",
    "| Scenario | Run ID | Expected | Result | Evidence |",
    "|---|---|---|---:|---|",
    ...runtimeRows.map((row) => `| \`${row.scenario}\` | \`${row.runId}\` | ${row.expected} | ${row.result} | \`${row.evidence}\` |`),
    "",
    "## Validation scenarios",
    "",
    "| Scenario | Expected | Result |",
    "|---|---|---:|",
    ...validationRows.map((row) => `| \`${row.scenario}\` | ${row.expected} | ${row.result} |`),
    "",
    "## Notes",
    "",
    "- Positive runtime scenarios launch real child `pi` agents through tmux.",
    "- Invalid scenarios are expected to fail closed during `/flow validate`.",
    "- The runner prepares the git worktree fixture before validation and runtime scenarios.",
    "- `e2e-test/results/` is ignored; this file records the latest compact report.",
    "",
  ].join("\n");

  const reportPath = join(resultDir, "report.md");
  writeFileSync(reportPath, report);
  writeFileSync(join(root, "e2e-test", "report.md"), report);
  console.log(`Report written to ${toProjectPath(reportPath)} and e2e-test/report.md`);
}
