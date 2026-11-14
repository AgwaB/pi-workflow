import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	EXPERIMENTAL_SAME_SESSION_REPAIR_ENV, makeProject, runWorkflowSpec,
	setSubagentApiForTests, waitForRun, workflowSpec, writeAgent,
} from "./unit-test-support.mjs";
import { drainWorkflowFixture } from "./workflow-fixture-lifecycle.mjs";
import { prepareArtifactGraphRetryTask } from "../../.tmp/unit/artifact-graph-runtime.js";
import { validateJsonSchema } from "../../.tmp/unit/json-schema.js";
import { ensureManagedWorktree } from "../../.tmp/unit/worktree.js";

const bundledSpec = JSON.parse(readFileSync(new URL("../../workflows/spec-review/spec.json", import.meta.url), "utf8"));
const candidatePrompt = bundledSpec.artifactGraph.stages.find(stage => stage.id === "candidate-findings").prompt;
const schema = JSON.parse(readFileSync(new URL(
	"../../workflows/spec-review/schemas/spec-review-candidate-findings-control.schema.json",
	import.meta.url,
), "utf8"));

function git(cwd, args) {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commitFixture(cwd) {
	git(cwd, ["init", "-q"]);
	git(cwd, ["add", "."]);
	git(cwd, ["-c", "user.name=pi-workflow-test", "-c", "user.email=pi-workflow-test@example.invalid",
		"commit", "--no-gpg-sign", "--no-verify", "-qm", "fixture"]);
}

function output(control) {
	return `<control>${JSON.stringify(control)}</control>\n<analysis>Offline retry fixture.</analysis>\n<refs>[]</refs>`;
}

for (const [dirty, artifacts] of [[false, false], [true, false], [false, true], [true, true]]) {
	test(`managed worktree schema retry preserves edits: dirty=${dirty}, artifacts=${artifacts}`, async () => {
		const cwd = realpathSync(makeProject());
		const previousRepair = process.env[EXPERIMENTAL_SAME_SESSION_REPAIR_ENV];
		process.env[EXPERIMENTAL_SAME_SESSION_REPAIR_ENV] = "0";
		let started;
		try {
			writeFileSync(join(cwd, ".gitignore"), ".pi/\n");
			writeFileSync(join(cwd, "tracked.txt"), "original\n");
			writeAgent(cwd, "unit-scout", "read");
			const specDir = join(cwd, "workflows", "retry");
			mkdirSync(specDir, { recursive: true });
			writeFileSync(join(specDir, "control.schema.json"), JSON.stringify(schema));
			const specPath = join(specDir, "spec.json");
			writeFileSync(specPath, JSON.stringify(workflowSpec("unit-scout", {
				worktreePolicy: "on",
				artifactGraph: { stages: [{
					id: "review", type: "single", prompt: candidatePrompt,
					...(artifacts ? {} : { inputPolicy: { artifactAccess: "none" } }),
					output: { controlSchema: "./control.schema.json", analysis: { required: true }, refs: { required: true } },
				}] },
			})));
			commitFixture(cwd);
			if (dirty) {
				writeFileSync(join(cwd, "tracked.txt"), "dirty source\n");
				writeFileSync(join(cwd, "untracked.txt"), "untracked source\n");
			}
			const sourceStatus = git(cwd, ["status", "--porcelain"]);
			const launched = [];
			const attempts = new Map();
			setSubagentApiForTests({
				supportsExplicitExtensionIsolation: () => true,
				async runSubagent(options) {
					launched.push(options);
					assert.notEqual(options.cwd, cwd);
					assert.equal(readFileSync(join(options.cwd, "tracked.txt"), "utf8"), dirty ? "dirty source\n" : "original\n");
					if (dirty) assert.equal(readFileSync(join(options.cwd, "untracked.txt"), "utf8"), "untracked source\n");
					const marker = join(options.cwd, "attempt-only.txt");
					if (launched.length === 1) writeFileSync(marker, "preserve first attempt\n");
					else {
						assert.equal(options.cwd, launched[0].cwd);
						assert.equal(readFileSync(marker, "utf8"), "preserve first attempt\n");
						assert.match(options.task, /Workflow Output Retry Instructions/);
					}
					const runId = `run_worktree_retry_${launched.length}`;
					const attemptId = `attempt_worktree_retry_${launched.length}`;
					const artifactDir = join(options.cwd, options.runsDir, runId, "attempts", attemptId);
					mkdirSync(artifactDir, { recursive: true });
					const control = {
						schema: "stage-control-v1", digest: "reviewed", candidateFindings: [], requirementCoverage: [],
						needsHuman: launched.length === 1 ? [{ issue: "Missing required source." }] : [{ reason: "Missing required source." }],
					};
					assert.equal(validateJsonSchema(control, schema).valid, launched.length > 1);
					const now = new Date().toISOString();
					writeFileSync(join(artifactDir, "output.log"), output(control));
					writeFileSync(join(artifactDir, "stderr.log"), "");
					writeFileSync(join(options.cwd, options.runsDir, runId, "run.json"), JSON.stringify({
						runId, correlationId: options.correlationId, status: "completed", latestAttemptId: attemptId,
						attempts: [{ attemptId, status: "completed" }],
					}));
					writeFileSync(join(artifactDir, "result.json"), JSON.stringify({
						runId, attemptId, status: "completed", startedAt: now, completedAt: now, exitCode: 0,
						metadata: { contextLengthExceeded: false, sessionId: options.sessionId },
					}));
					attempts.set(runId, { runId, attemptId, artifactDir, now });
					return { runId, attemptId, status: "running" };
				},
				async getSubagentStatus({ runId }) {
					const attempt = attempts.get(runId);
					assert.ok(attempt);
					return {
						runId, attemptId: attempt.attemptId, backend: "headless", status: "completed", failureKind: null,
						startedAt: attempt.now, completedAt: attempt.now,
						logs: [
							{ type: "output", path: "output.log", artifactCwd: attempt.artifactDir },
							{ type: "stderr", path: "stderr.log", artifactCwd: attempt.artifactDir },
							{ type: "result", path: "result.json", artifactCwd: attempt.artifactDir },
						],
						metadata: { contextLengthExceeded: false },
						attempts: [{ attemptId: attempt.attemptId, status: "completed" }],
					};
				},
				async reconcileSubagentRun() { return {}; },
				async interruptSubagent({ runId, attemptId }) {
					return { runId, status: "already-terminal", record: { attempts: [{ attemptId, status: "completed" }] } };
				},
			});
			started = await runWorkflowSpec(specPath, cwd, { task: "Reproduce issue 19 without a provider.", nativeHost: null });
			const completed = await waitForRun(cwd, started.runId, 10_000);
			const task = completed.tasks[0];
			assert.equal(completed.status, "completed", `${task.statusDetail}: ${task.lastMessage}`);
			assert.equal(launched.length, 2);
			assert.equal(task.outputRetry.repairMode, "new_session");
			assert.equal(task.outputRetry.attempts, 1);
			assert.notEqual(launched[0].sessionId, launched[1].sessionId);
			assert.equal(task.worktree.baseCwd, cwd);
			assert.equal(task.worktree.snapshot.sourceGitRoot, cwd);
			assert.equal(task.worktree.snapshot.dirty, dirty);
			assert.equal(git(cwd, ["status", "--porcelain"]), sourceStatus);
			assert.equal(existsSync(join(cwd, "attempt-only.txt")), false);
			assert.equal(readFileSync(join(task.cwd, "attempt-only.txt"), "utf8"), "preserve first attempt\n");
			const taskDir = dirname(join(cwd, task.files.result));
			assert.ok(existsSync(join(taskDir, "raw.invalid-attempt-1.md")));
			assert.deepEqual(JSON.parse(readFileSync(join(taskDir, "control.json"), "utf8")).needsHuman,
				[{ reason: "Missing required source." }]);
		} finally {
			let drained = false;
			try {
				if (started) await drainWorkflowFixture(cwd, started.runId);
				drained = true;
			} finally {
				setSubagentApiForTests(undefined);
				if (previousRepair === undefined) delete process.env[EXPERIMENTAL_SAME_SESSION_REPAIR_ENV];
				else process.env[EXPERIMENTAL_SAME_SESSION_REPAIR_ENV] = previousRepair;
				if (drained) rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
			}
		}
	});
}

test("managed worktree rejects itself as source before deleting files or replacing its snapshot", async (t) => {
	const cwd = realpathSync(makeProject());
	t.after(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 }));
	writeFileSync(join(cwd, "tracked.txt"), "original\n");
	commitFixture(cwd);
	const run = { runId: "workflow_self_source" };
	const task = { taskId: "task-1", cwd, worktree: { enabled: false, path: null } };
	const compiled = { cwd, safety: { requiresWorktree: true } };
	await ensureManagedWorktree(cwd, run, task, compiled);
	const marker = join(task.cwd, "attempt-only.txt");
	writeFileSync(marker, "preserve worktree\n");
	const metadata = join(cwd, ".pi", "workflows", run.runId, "worktree-snapshots", task.taskId, "metadata.json");
	const before = readFileSync(metadata, "utf8");
	await assert.rejects(ensureManagedWorktree(cwd, run, task, { ...compiled, cwd: task.cwd }),
		/managed worktree source .* must not be inside its managed destination/);
	assert.equal(readFileSync(marker, "utf8"), "preserve worktree\n");
	assert.equal(readFileSync(metadata, "utf8"), before);
	assert.equal(task.worktree.baseCwd, cwd);
});

test("output retry without a required worktree preserves the execution cwd", async () => {
	const task = { cwd: "/runtime-cwd", files: { result: "result.json", output: "raw.md" }, outputRetry: { attempts: 1 } };
	const prepared = { id: "task-1", cwd: "/source-cwd", compiledPrompt: "Review.", safety: { requiresWorktree: false } };
	const retry = await prepareArtifactGraphRetryTask("/unavailable-fixture", task, prepared);
	assert.equal(retry.cwd, task.cwd);
	assert.equal(prepared.cwd, "/source-cwd");
});

test("spec-review candidate prompt shows a schema-valid needsHuman item with reason", () => {
	const match = candidatePrompt.match(/Example needsHuman item: (\{.*?\})\./);
	assert.ok(match, "candidate-findings must show a nonempty needsHuman item");
	const item = JSON.parse(match[1]);
	assert.equal(typeof item.reason, "string");
	assert.ok(item.reason.length > 0);
	assert.deepEqual(validateJsonSchema(item, schema.properties.needsHuman.items), { valid: true, issues: [] });
	assert.equal(validateJsonSchema({ issue: item.reason }, schema.properties.needsHuman.items).valid, false);
});
