import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { discoverAgents } from "../../dist/agents.js";
import { piAgentDir } from "../../dist/pi-agent-dir.js";
import { listWorkflows, resolveWorkflowRef } from "../../dist/workflow-specs.js";

const VALID_SPEC = `${JSON.stringify({
	schemaVersion: 1,
	defaults: { agent: "scout", readOnly: true, tools: ["read"] },
	artifactGraph: { stages: [{ id: "main", type: "single", prompt: "Check." }] },
})}\n`;

const AGENT_MD = `---
name: override-only-agent
description: Agent that only exists under the PI_CODING_AGENT_DIR override.
tools: read
readOnly: true
---

# override-only-agent
`;

function withEnv(name, value, fn) {
	const previous = process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
	return Promise.resolve()
		.then(fn)
		.finally(() => {
			if (previous === undefined) delete process.env[name];
			else process.env[name] = previous;
		});
}

test("piAgentDir defaults to ~/.pi/agent and honors PI_CODING_AGENT_DIR", async () => {
	await withEnv("PI_CODING_AGENT_DIR", undefined, () => {
		assert.equal(piAgentDir(), join(homedir(), ".pi", "agent"));
	});
	await withEnv("PI_CODING_AGENT_DIR", "  ", () => {
		assert.equal(piAgentDir(), join(homedir(), ".pi", "agent"));
	});
	await withEnv("PI_CODING_AGENT_DIR", "/tmp/pi-agent-override", () => {
		assert.equal(piAgentDir(), resolve("/tmp/pi-agent-override"));
	});
	assert.equal(
		piAgentDir({ PI_CODING_AGENT_DIR: "/explicit/env" }),
		resolve("/explicit/env"),
	);
});

test("user/global workflows and agents follow PI_CODING_AGENT_DIR like Pi does", async () => {
	const scratch = await mkdtemp(join(tmpdir(), "pi-workflow-agent-dir-"));
	const cwd = join(scratch, "project");
	const home = join(scratch, "home");
	const override = join(scratch, "pi-agent-override");
	await mkdir(cwd, { recursive: true });
	await mkdir(join(home, ".pi", "agent"), { recursive: true });
	const previousHome = process.env.HOME;
	process.env.HOME = home;
	try {
		const spec = join(override, "workflows", "override-only", "spec.json");
		await mkdir(dirname(spec), { recursive: true });
		await writeFile(spec, VALID_SPEC);
		const agent = join(override, "agents", "override-only-agent.md");
		await mkdir(dirname(agent), { recursive: true });
		await writeFile(agent, AGENT_MD);

		await withEnv("PI_CODING_AGENT_DIR", undefined, async () => {
			const names = (await listWorkflows(cwd)).map((entry) => entry.name);
			assert.ok(!names.includes("override-only"), "override root must not leak without the env var");
			const registry = await discoverAgents(cwd);
			assert.ok(!registry.agents.some((entry) => entry.name === "override-only-agent"));
		});

		await withEnv("PI_CODING_AGENT_DIR", override, async () => {
			assert.equal((await resolveWorkflowRef("override-only", cwd)).specPath, spec);
			const registry = await discoverAgents(cwd);
			const found = registry.agents.find((entry) => entry.name === "override-only-agent");
			assert.ok(found, "user agent under PI_CODING_AGENT_DIR must be discovered");
			assert.equal(found.scope, "user");
		});
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		await rm(scratch, { recursive: true, force: true });
	}
});
