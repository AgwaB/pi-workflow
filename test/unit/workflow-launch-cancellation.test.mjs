import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import { initTheme } from "@earendil-works/pi-coding-agent";

import workflowExtension from "../../.tmp/unit/extension.js";
import { resumeRun, setDynamicControllerHooksForTests, stopRun } from "../../.tmp/unit/engine.js";
import { setSupportHelperPreparedHookForTests } from "../../.tmp/unit/artifact-graph-runtime.js";
import { bindWorkflowLaunchSignal, throwIfWorkflowStopRequested } from "../../.tmp/unit/workflow-stop.js";
import { setSubagentApiForTests } from "../../.tmp/unit/subagent-backend.js";
import { WORKFLOW_AUTO_COMPARE_CORRELATION_ID } from "../../.tmp/unit/workflow-router.js";
import {
	readRunRecord,
	setRunLeaseTestHooksForTests,
	setWorkflowLaunchArtifactTestHooksForTests,
	withRunLease,
} from "../../.tmp/unit/store.js";

initTheme(undefined, false);

function writeAgent(cwd, name, tools = ["read"]) {
	const directory = join(cwd, ".pi", "agents");
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, `${name}.md`),
		`---\ndescription: ${name}\ntools: ${JSON.stringify(tools)}\nreadOnly: true\n---\n# ${name}\n`,
	);
}

function writeNamedSupportWorkflow(cwd, markerPath) {
	const directory = join(cwd, "workflows", "bound-support");
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "helper.mjs"),
		`import { writeFileSync } from "node:fs";\nexport default () => { writeFileSync(${JSON.stringify(markerPath)}, "executed"); return { control: {} }; };\n`,
	);
	writeFileSync(
		join(directory, "spec.json"),
		JSON.stringify({
			schemaVersion: 1,
			name: "bound-support",
			description: "A local support-only cancellation witness.",
			routing: {
				useWhen: ["Use for a bounded local support witness."],
				avoidWhen: ["Avoid when no workflow is needed."],
				outputs: ["A local witness."],
			},
			defaults: { agent: "unit-agent", readOnly: true, tools: ["read"] },
			artifactGraph: {
				stages: [{ id: "first", support: { uses: "./helper.mjs" } }],
			},
		}),
	);
}

function writeAutoComparisonOutput(cwd, runId, attemptId, output) {
	const directory = join(
		cwd,
		".pi",
		"workflows",
		"auto-router-runs",
		runId,
		"attempts",
		attemptId,
	);
	mkdirSync(directory, { recursive: true });
	const path = join(directory, "output.log");
	writeFileSync(path, output);
	return path;
}

function comparisonFor(options, selectedKind) {
	const packet = JSON.parse(options.task);
	const selected = packet.candidateCards.find(
		(candidate) => candidate.kind === selectedKind,
	);
	assert.ok(selected, `missing ${selectedKind} auto candidate`);
	return JSON.stringify({
		status: "recommendation",
		recommendation: {
			candidateId: selected.candidateId,
			confidence: "high",
			reason: "The local test selects this bounded candidate.",
			alternatives: packet.candidateCards
				.filter((candidate) => candidate.candidateId !== selected.candidateId)
				.slice(0, 2)
				.map((candidate) => candidate.candidateId),
		},
		assessments: packet.candidateCards.map((candidate) => ({
			candidateId: candidate.candidateId,
			fit: candidate.candidateId === selected.candidateId ? "complete" : "partial",
			reason: "Bounded local test comparison.",
			evidence: ["task", "routing.useWhen"],
		})),
		questions: [],
		unknowns: [],
	});
}

function installAutoApi(cwd, selectedKind, calls) {
	setSubagentApiForTests({
		async runSubagent(options) {
			if (options.correlationId !== WORKFLOW_AUTO_COMPARE_CORRELATION_ID) {
				calls.execution += 1;
				throw new Error("a cancelled launch must not create a provider action");
			}
			calls.comparison += 1;
			const runId = `auto-cancel-${calls.comparison}`;
			const attemptId = "attempt";
			const path = writeAutoComparisonOutput(
				cwd,
				runId,
				attemptId,
				comparisonFor(options, selectedKind),
			);
			return {
				runId,
				attemptId,
				status: "completed",
				cwd,
				artifacts: [{ type: "output", path }],
			};
		},
	});
}

function registerWorkflowHandler(events) {
	let handler;
	workflowExtension({
		on(name, callback) { events.set(name, callback); },
		registerCommand(name, definition) {
			if (name === "workflow") handler = definition.handler;
		},
		registerTool() {},
		sendMessage() {},
		getThinkingLevel() {
			return undefined;
		},
	});
	assert.ok(handler, "workflow command was not registered");
	return handler;
}

function interactiveContext(cwd, startLoaders, notices) {
	const keybindings = {
		matches(data, action) {
			return data === action;
		},
	};
	return {
		cwd,
		hasUI: true,
		mode: "tui",
		sessionManager: { getSessionId: () => "launch-cancellation-test" },
		ui: {
			custom(factory) {
				return new Promise((resolve) => {
					let component;
					const done = (value) => {
						component?.dispose?.();
						resolve(value);
					};
					component = factory(
						{ terminal: { rows: 24 }, requestRender() {} },
						{
							fg(_role, value) {
								return value;
							},
							bold(value) {
								return value;
							},
						},
						keybindings,
						done,
					);
					const screen = component.render?.(100).join("\n") ?? "";
					if (/Choose how to run/.test(screen)) {
						queueMicrotask(() => component.handleInput("tui.select.confirm"));
					} else if (/Starting /.test(screen)) {
						startLoaders.push(component);
					}
				});
			},
			confirm: async () => true,
			select: async (_title, options) => options[0],
			getEditorText: () => "",
			setEditorText() {},
			notify(message, level) {
				notices.push({ message, level });
			},
			setStatus() {},
			setWidget() {},
		},
	};
}

async function waitFor(predicate, message, attempts = 200) {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(message);
}

async function setup(selectedKind) {
	const cwd = await mkdtemp(join(tmpdir(), "piwf-launch-cancellation-"));
	const markerPath = join(cwd, "first-support-action.txt");
	writeAgent(cwd, "unit-agent");
	writeAgent(cwd, "researcher", [
		"read",
		"grep",
		"find",
		"ls",
		"workflow_web_search",
		"workflow_web_fetch_source",
		"workflow_web_source_read",
	]);
	writeNamedSupportWorkflow(cwd, markerPath);
	const calls = { comparison: 0, execution: 0 };
	installAutoApi(cwd, selectedKind, calls);
	const startLoaders = [];
	const notices = [];
	const events = new Map();
	return {
		events,
		cwd,
		markerPath,
		calls,
		startLoaders,
		notices,
		ctx: interactiveContext(cwd, startLoaders, notices),
		handler: registerWorkflowHandler(events),
	};
}

async function cleanup(cwd) {
	setSupportHelperPreparedHookForTests();
	setDynamicControllerHooksForTests();
	setWorkflowLaunchArtifactTestHooksForTests();
	setRunLeaseTestHooksForTests();
	setSubagentApiForTests(undefined);
	if (cwd) rmSync(cwd, { recursive: true, force: true });
}

for (const selectedKind of ["named-workflow", "direct-dynamic"]) {
	for (const cancellation of ["Escape", "session invalidation"]) {
	test(`auto ${selectedKind} ${cancellation} before publication reaches the engine dispatch boundary`, async () => {
		let fixture;
		let runDirectory;
		try {
			fixture = await setup(selectedKind);
			setWorkflowLaunchArtifactTestHooksForTests({
				async onAfterWriteRename({ artifactPath }) {
					runDirectory = dirname(artifactPath);
					assert.equal(existsSync(join(runDirectory, "run.json")), false);
					assert.equal(existsSync(fixture.markerPath), false);
					const loader = fixture.startLoaders.at(-1);
					assert.ok(loader, "the actual foreground start loader was not rendered");
					if (cancellation === "Escape") loader.handleInput("\u001b");
					else await fixture.events.get("session_shutdown")({}, fixture.ctx);
				},
			});
			await fixture.handler(`auto "Cancel ${selectedKind} before dispatch."`, fixture.ctx);
			await waitFor(
				() => runDirectory !== undefined && !existsSync(runDirectory),
				`aborted unpublished run directory was not cleaned up: ${runDirectory ? readdirSync(runDirectory).join(", ") : "no sidecar hook"}; notices=${JSON.stringify(fixture.notices)}`,
			);
			assert.equal(fixture.calls.comparison, 1);
			assert.equal(fixture.calls.execution, 0);
			assert.equal(existsSync(fixture.markerPath), false);
			assert.equal(
				fixture.notices.some(({ message }) => /Workflow (started|completed)|Dynamic workflow started/.test(message)),
				false,
			);
		} finally {
			await cleanup(fixture?.cwd);
		}
	});
	}
}

test("uncancelled auto named launch still executes its first support action", async () => {
	let fixture;
	try {
		fixture = await setup("named-workflow");
		await fixture.handler('auto "Run the bounded support control."', fixture.ctx);
		assert.equal(fixture.calls.comparison, 1);
		assert.equal(fixture.calls.execution, 0);
		assert.equal(existsSync(fixture.markerPath), true);
		const notice = fixture.notices.find(({ message }) => /Workflow (started|completed): bound-support/.test(message));
		assert.ok(notice, JSON.stringify(fixture.notices));
		const runId = notice.message.match(/Run: (\S+)/)?.[1];
		assert.ok(runId);
		await waitFor(async () => (await readRunRecord(fixture.cwd, runId)).status === "completed", "support control did not complete");
	} finally {
		await cleanup(fixture?.cwd);
	}
});

for (const selectedKind of ["named-workflow", "direct-dynamic"]) {
test(`auto ${selectedKind} Escape after run publication uses exact-run stop semantics`, async () => {
	let fixture;
	let runDirectory;
	let cancelled = false;
	try {
		fixture = await setup(selectedKind);
		setWorkflowLaunchArtifactTestHooksForTests({
			onAfterWriteRename({ artifactPath }) {
				runDirectory = dirname(artifactPath);
			},
		});
		setRunLeaseTestHooksForTests({
			onAfterAtomicRename({ file }) {
				if (
					cancelled ||
					!runDirectory ||
					basename(file) !== "run.json" ||
					realpathSync(file) !== realpathSync(join(runDirectory, "run.json"))
				)
					return;
				cancelled = true;
				const loader = fixture.startLoaders.at(-1);
				assert.ok(loader, "the actual foreground start loader was not rendered");
				loader.handleInput("\u001b");
			},
		});
		await fixture.handler('auto "Cancel after the run is created."', fixture.ctx);
		let latestStatus;
		await waitFor(async () => {
			if (!runDirectory || !existsSync(join(runDirectory, "run.json"))) return false;
			latestStatus = (await readRunRecord(fixture.cwd, basename(runDirectory))).status;
			return latestStatus === "interrupted";
		}, `created run was not stopped after foreground cancellation (cancelled=${cancelled}, status=${latestStatus})`);
		const run = await readRunRecord(fixture.cwd, basename(runDirectory));
		assert.equal(cancelled, true);
		assert.equal(run.status, "interrupted");
		assert.equal(fixture.calls.execution, 0);
		assert.equal(existsSync(fixture.markerPath), false);
	} finally {
		await cleanup(fixture?.cwd);
	}
});
}

test("uncancelled auto dynamic launch reaches its first controller provider action", async () => {
	let fixture;
	let runDirectory;
	try {
		fixture = await setup("direct-dynamic");
		setWorkflowLaunchArtifactTestHooksForTests({ onAfterWriteRename({ artifactPath }) { runDirectory = dirname(artifactPath); } });
		await fixture.handler('auto "Run the dynamic dispatch control."', fixture.ctx);
		assert.ok(runDirectory, "dynamic control never published its launch");
		assert.ok(fixture.calls.execution > 0, JSON.stringify(fixture.notices));
		// The fake backend intentionally fails rather than using a real provider.
		// This is a dispatch-positive control, not a successful research workflow.
	} finally {
		if (fixture && runDirectory && existsSync(join(runDirectory, "run.json")))
			await stopRun(fixture.cwd, basename(runDirectory));
		await cleanup(fixture?.cwd);
	}
});

for (const selectedKind of ["named-workflow", "direct-dynamic"]) {
	test(`auto ${selectedKind} cancellation during directory preparation removes the unpublished root`, async () => {
		let fixture;
		let prepared;
		let sidecar = false;
		try {
			fixture = await setup(selectedKind);
			setWorkflowLaunchArtifactTestHooksForTests({
				onAfterPrepare({ runPath }) {
					prepared = runPath;
					assert.ok(existsSync(runPath));
					fixture.startLoaders.at(-1).handleInput("\u001b");
				},
				onAfterWriteRename() { sidecar = true; },
			});
			await fixture.handler('auto "Cancel during directory preparation."', fixture.ctx);
			await waitFor(() => prepared && !existsSync(prepared), "unpublished prepared directory remains");
			assert.equal(sidecar, false);
			assert.equal(fixture.calls.execution, 0);
			assert.equal(existsSync(fixture.markerPath), false);
		} finally { await cleanup(fixture?.cwd); }
	});

	for (const contention of selectedKind === "named-workflow" ? ["none", "temporary", "deadline"] : ["none"]) {
	test(`auto ${selectedKind} cancellation fences first dispatch while durable stop publication is delayed (${contention} lease contention)`, async () => {
		let fixture;
		let runDirectory;
		let releaseStop;
		let stopStarted = false;
		let stopCommitted = false;
		let prepared = false;
		let competing = false;
		let competitor;
		let releaseCompetitor;
		const competitorGate = new Promise((resolve) => { releaseCompetitor = resolve; });
		const stopGate = new Promise((resolve) => { releaseStop = resolve; });
		try {
			fixture = await setup(selectedKind);
			setWorkflowLaunchArtifactTestHooksForTests({ onAfterWriteRename({ artifactPath }) { runDirectory = dirname(artifactPath); } });
			setRunLeaseTestHooksForTests({
				async onBeforeAtomicRename({ file }) {
					if (basename(file) !== "stop-intent.json") return;
					stopStarted = true;
					await stopGate;
				},
				onAfterStopIntentWrite({ file }) {
					assert.equal(basename(file), "stop-intent.json");
					stopCommitted = true;
				},
			});
			const cancel = async () => {
				prepared = true;
				assert.ok(existsSync(join(runDirectory, "run.json")));
				assert.equal(existsSync(fixture.markerPath), false);
				assert.equal(fixture.calls.execution, 0);
				fixture.startLoaders.at(-1).handleInput("\u001b");
				await waitFor(() => stopStarted, "stop write did not reach the delayed rename");
			};
			if (selectedKind === "named-workflow") setSupportHelperPreparedHookForTests(cancel);
			else setDynamicControllerHooksForTests({ beforeControllerWorkerLaunch: cancel });
			await fixture.handler('auto "Cancel at the prepared first action."', fixture.ctx);
			await waitFor(async () => fixture.calls.execution > 0 || existsSync(fixture.markerPath) ||
				(runDirectory && (await readRunRecord(fixture.cwd, basename(runDirectory))).status === "interrupted"),
				"dispatch did not observe the synchronous launch cancellation");
			assert.equal(prepared, true);
			assert.equal(stopStarted, true);
			assert.equal(stopCommitted, false, "stop persistence must still be held for the race witness");
			assert.equal(fixture.calls.execution, 0);
			assert.equal(existsSync(fixture.markerPath), false);
			if (contention !== "none") {
				await waitFor(async () => {
					let entered;
					const entry = new Promise((resolve) => { entered = resolve; });
					competitor = withRunLease(fixture.cwd, basename(runDirectory), async () => {
						competing = true;
						entered();
						await competitorGate;
					});
					await Promise.race([entry, competitor]);
					return competing;
				}, "competing supervisor did not acquire its lease");
			}
			releaseStop();
			await waitFor(() => stopCommitted, "durable stop was not published");
			if (contention === "deadline") {
				// New deadline case: wait beyond the unchanged 1500ms stop budget.
				await waitFor(() => fixture.notices.some(({ message, level }) =>
					level === "warning" && message.includes("cancellation is still pending") && message.includes(basename(runDirectory))),
					"pending cancellation was hidden by the dismissed loader", 600);
				assert.ok(existsSync(join(runDirectory, "stop-intent.json")));
			} else if (contention === "temporary") {
				await new Promise((resolve) => setTimeout(resolve, 100));
				assert.ok(existsSync(join(runDirectory, "stop-intent.json")));
			}
			releaseCompetitor();
			await competitor;
			if (contention === "deadline")
				await stopRun(fixture.cwd, basename(runDirectory));
			await waitFor(async () => {
				if (existsSync(join(runDirectory, "stop-intent.json"))) return false;
				try { await throwIfWorkflowStopRequested(fixture.cwd, basename(runDirectory)); return true; }
				catch { return false; }
			}, "durable stop/fence was not reconciled after the lease was released");
			assert.equal((await readRunRecord(fixture.cwd, basename(runDirectory))).status, "interrupted");
			if (contention !== "none") {
				setSupportHelperPreparedHookForTests();
				setRunLeaseTestHooksForTests();
				await resumeRun(fixture.cwd, basename(runDirectory));
				await waitFor(async () => (await readRunRecord(fixture.cwd, basename(runDirectory))).status === "completed", "explicit resume remained poisoned by cancellation intent");
				assert.equal(await readFile(fixture.markerPath, "utf8"), "executed");
			}
		} finally {
			releaseStop();
			releaseCompetitor();
			await competitor;
			await cleanup(fixture?.cwd);
		}
	});
	}
}

test("launch cancellation fences are run-scoped and released by their owner", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "piwf-launch-signal-scope-"));
	const controller = new AbortController();
	const dispose = bindWorkflowLaunchSignal(cwd, "workflow_owned", controller.signal);
	try {
		controller.abort();
		await assert.rejects(() => throwIfWorkflowStopRequested(cwd, "workflow_owned"), { name: "WorkflowStopRequested" });
		await throwIfWorkflowStopRequested(cwd, "workflow_other");
		dispose();
		await throwIfWorkflowStopRequested(cwd, "workflow_owned");
	} finally { dispose(); await cleanup(cwd); }
});
