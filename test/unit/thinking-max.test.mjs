import assert from "node:assert/strict";
import { test } from "node:test";

import { parseAgentMarkdown } from "../../.tmp/unit/agents.js";
import { parseArtifactGraphWorkflowSpec } from "../../.tmp/unit/artifact-graph-schema.js";
import { parseWorkflowDynamicArgs, parseWorkflowRunArgs } from "../../.tmp/unit/extension.js";
import { THINKING_LEVELS } from "../../.tmp/unit/types.js";
import { clampSupportedThinkingLevel, getSupportedThinkingLevels } from "../../.tmp/unit/workflow-runtime.js";

function workflow(stage = {}) {
	return {
		schemaVersion: 1,
		name: "thinking-max-test",
		defaults: { agent: "scout", tools: ["read"], readOnly: true },
		artifactGraph: { stages: [{ id: "main", type: "single", prompt: "Inspect.", ...stage }] },
	};
}

test("max is the highest workflow thinking level", () => {
	assert.deepEqual(THINKING_LEVELS, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
});

test("max is offered only when the model maps it, mirroring pi-ai", () => {
	const gen6 = { reasoning: true, thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } };
	const xhighOnly = { reasoning: true, thinkingLevelMap: { xhigh: "max" } };
	assert.ok(getSupportedThinkingLevels(gen6).includes("max"));
	assert.equal(getSupportedThinkingLevels(xhighOnly).includes("max"), false);
	assert.equal(clampSupportedThinkingLevel(getSupportedThinkingLevels(xhighOnly), "max"), "xhigh");
	assert.ok(getSupportedThinkingLevels(undefined).includes("max"));
});

test("specs, agent frontmatter, and launch arguments accept max", () => {
	assert.doesNotThrow(() => parseArtifactGraphWorkflowSpec(workflow({ thinking: "max" })));
	assert.throws(() => parseArtifactGraphWorkflowSpec(workflow({ thinking: "ultra" })));
	const agent = parseAgentMarkdown("---\ndescription: Deep\nthinking: max\n---\nBody", "deep.md", "project");
	assert.equal(agent.thinking, "max");
	assert.equal(parseWorkflowRunArgs('run review "Fix the thing" --thinking max').thinking, "max");
	assert.equal(parseWorkflowDynamicArgs('dynamic --thinking max "Research adaptive workflows"').thinking, "max");
	assert.throws(() => parseWorkflowRunArgs('run review "Fix the thing" --thinking ultra'), /xhigh, max/);
});
