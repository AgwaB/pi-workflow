import { createRequire } from "node:module";
import {
	assert,
	join,
	launchSubagentTask,
	makeProject,
	makeSubagentLaunchFixture,
	mkdirSync,
	setSubagentApiForTests,
	test,
	writeFileSync,
} from "./unit-test-support.mjs";
import { prepareSubagentTaskLaunch } from "../../.tmp/unit/subagent-backend.js";
import { DefaultResourceLoader } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.js";
import { SettingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js";

const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url, { fsCache: false, moduleCache: false });
const { buildPiArgv } = jiti("../../node_modules/@agwab/pi-subagent/src/runners/headless-model.ts");
const tools = [
	"read", "grep", "find", "ls", "workflow_web_search",
	"workflow_web_fetch_source", "workflow_web_source_read",
];

function writeFixture(path, body) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, body);
}

function writeSkill(path, name) {
	writeFixture(path, `---\nname: ${name}\ndescription: Offline resource fixture.\n---\nNo execution.\n`);
}

// Real builders and resource discovery only. The backend is injected and
// extensions are not executed; this is not a durable-worker or provider test.
test("resource policy reaches bundled argv and locked SDK discovery", async (t) => {
	const previousFetch = globalThis.fetch;
	let fetchCalls = 0;
	globalThis.fetch = () => {
		fetchCalls += 1;
		throw new Error("network forbidden in resource inheritance regression");
	};
	try {
		for (const version of [undefined, 1]) {
			for (const inheritSkills of [undefined, false, true]) {
				for (const inheritProjectContext of version === 1 ? [undefined, false, true] : [true]) {
					await t.test(`${version ?? "legacy"}/${inheritSkills}/${inheritProjectContext}`, async () => {
						const cwd = makeProject();
						const agentDir = join(cwd, "resource-home");
						writeSkill(join(cwd, ".pi/skills/ambient/SKILL.md"), "ambient");
						writeFixture(join(cwd, "AGENTS.md"), "CONTEXT_SHOULD_NOT_LOAD\n");
						writeFixture(join(cwd, ".pi/APPEND_SYSTEM.md"), "APPEND_IS_SEPARATE\n");
						mkdirSync(agentDir, { recursive: true });
						const { run, task, compiledTask } = makeSubagentLaunchFixture(cwd, "resource-sdk");
						Object.assign(compiledTask, { inheritSkills, inheritProjectContext });
						if (version !== undefined) {
							compiledTask.resourcePolicyVersion = version;
							task.artifactGraph = { enabled: true, artifactAccess: "none" };
						}
						compiledTask.runtime.tools = [...tools];
						let captured;
						setSubagentApiForTests({
							async runSubagent(options) {
								captured = options;
								return { runId: "run_resource_sdk", attemptId: "attempt_resource_sdk", status: "running" };
							},
							async getSubagentStatus() { return null; },
							async reconcileSubagentRun() { return {}; },
							async interruptSubagent() { return {}; },
						});
						const prepared = await prepareSubagentTaskLaunch(cwd, run, task, compiledTask);
						const result = await launchSubagentTask(cwd, run, task, compiledTask, undefined, undefined, prepared);
						assert.equal(result.kind, "launched");
						assert.ok(captured);
						const disabled = version === 1 && inheritSkills === false;
						assert.equal(Object.hasOwn(captured, "skills"), disabled);
						assert.deepEqual(captured.tools, tools);
						assert.deepEqual(captured.extensions, prepared.extensions);
						assert.ok(captured.extensions.length > 0, "required web extension must remain");
						const argv = buildPiArgv(captured);
						assert.equal(argv.includes("--no-skills"), disabled);
						assert.ok(argv.includes("--no-context-files"));
						assert.ok(!argv.includes("--no-extensions"));
						assert.equal(argv[argv.indexOf("--tools") + 1], tools.join(","));
						if (version === undefined) {
							assert.equal(captured.sessionId, undefined);
							assert.ok(argv.includes("--no-session"));
							assert.ok(!argv.includes("--session-id"));
						} else {
							assert.equal(typeof captured.sessionId, "string");
							assert.ok(argv.includes("--session-id"));
							assert.equal(argv[argv.indexOf("--session-id") + 1], captured.sessionId);
							assert.ok(!argv.includes("--no-session"));
						}
						assert.deepEqual(argv.flatMap((value, index) => value === "--extension" ? [argv[index + 1]] : []), captured.extensions);
						const withoutSkills = { ...captured };
						delete withoutSkills.skills;
						assert.deepEqual(argv.filter((value) => value !== "--no-skills"), buildPiArgv(withoutSkills));

						const loader = new DefaultResourceLoader({
							cwd, agentDir,
							settingsManager: SettingsManager.inMemory({}, { projectTrusted: true }),
							noSkills: argv.includes("--no-skills"),
							noContextFiles: argv.includes("--no-context-files"),
							noExtensions: true, noThemes: true, noPromptTemplates: true,
							systemPrompt: captured.systemPrompt,
						});
						await loader.reload();
						assert.deepEqual(loader.getExtensions().extensions, []);
						assert.deepEqual(loader.getExtensions().errors, []);
						assert.deepEqual(loader.getSkills().diagnostics.filter((entry) => entry.type === "error"), []);
						assert.deepEqual(loader.getSkills().skills.map((skill) => skill.name), disabled ? [] : ["ambient"]);
						assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
						assert.ok(loader.getAppendSystemPrompt().some((body) => body.includes("APPEND_IS_SEPARATE")));
						if (disabled) {
							const explicit = join(cwd, "explicit/SKILL.md");
							writeSkill(explicit, "explicit");
							loader.extendResources({ skillPaths: [{ path: explicit, metadata: { source: "fixture", scope: "temporary", origin: "top-level" } }] });
							assert.deepEqual(loader.getSkills().skills.map((skill) => skill.name), ["explicit"]);
						}
					});
				}
			}
		}
		assert.equal(fetchCalls, 0);
	} finally {
		globalThis.fetch = previousFetch;
		setSubagentApiForTests(undefined);
	}
});
