import assert from "node:assert/strict";
import test from "node:test";

import { buildFanoutBranchPlanRequests } from "../../.tmp/unit/dynamic-loop-actions.js";
import { normalizeDynamicFanoutPlanRequest } from "../../.tmp/unit/dynamic-control-ops.js";
import { sanitizeTaskId } from "../../.tmp/unit/engine-run-graph.js";

// Regression: planner action ids containing uppercase (e.g. "act-verify-F1",
// observed in the 2026-07-12 S6 canary run workflow_mrhwcxc4_65f790) used to
// fail the whole dynamic run with "ctx.fanout.plan() branches[N].requestId
// must match agentRequest.id", because the declared requestId was the raw
// request id while validation compares against the sanitized
// (normalizeDynamicAgentRequest -> sanitizeTaskId) id.
test("fanout branch requestId matches sanitized agent request id for uppercase action ids", () => {
	const ctx = { graph: {} };
	const actions = [
		{
			type: "verify",
			actionId: "act-verify-F1",
			targetFindingId: "F1-INVERTED-EXPIRY",
			prompt: "Verify the inverted expiry finding against src/auth.js.",
			outputProfile: "verification_result_v1",
		},
		{
			type: "add_work_item",
			actionId: "act-Add-Followup",
			workItemId: "wi-Followup-Auth",
			prompt: "Investigate the auth follow-up.",
			outputProfile: "candidate_findings_v1",
		},
	];
	const branches = buildFanoutBranchPlanRequests(ctx, actions, 1);
	assert.equal(branches.length, 2);
	for (const branch of branches) {
		assert.equal(branch.requestId, sanitizeTaskId(branch.agentRequest.id));
	}
	assert.equal(branches[0].requestId, "act-verify-f1");
	assert.equal(branches[1].requestId, "wi-followup-auth");

	// The exact validation path that failed in the canary must now accept the
	// planned branches unchanged.
	const normalized = normalizeDynamicFanoutPlanRequest({
		round: 1,
		decisionHash: "hash-r1",
		branches,
	});
	assert.equal(normalized.branches.length, 2);
	assert.equal(normalized.branches[0].requestId, "act-verify-f1");
	assert.equal(normalized.branches[0].agentRequest.id, "act-verify-f1");
	assert.equal(normalized.branches[1].requestId, "wi-followup-auth");
});
