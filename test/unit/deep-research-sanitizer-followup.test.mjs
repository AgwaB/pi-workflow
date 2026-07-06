import assert from "node:assert/strict";
import { test } from "node:test";

test("deep-research sanitizer rewrites unquoted obligations and augments exact Docker option sources", async () => {
	const { default: helper } = await import(
		`../../workflows/deep-research/helpers/sanitize-verification-candidates.mjs?test=${Date.now()}`
	);
	const claudeRef = "wsrc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
	const owaspRef = "wsrc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
	const dockerRef = "wsrc_cccccccccccccccccccccccccccccccc";
	const result = await helper({
		sources: {
			"normalize-input-packet.main": {
				packet: {
					research: {
						extractedFacts: [
							{
								slotId: "slot-ci",
								quote:
									"Trust verification is disabled when running non-interactively with the -p flag",
								sourceRefs: [claudeRef],
								sourceUrls: [
									"https://docs.anthropic.test/claude-code/security",
								],
								sourceQuality: "primary",
							},
							{
								slotId: "slot-prompt",
								quote:
									"Segregate and identify external content. Separate and clearly denote untrusted content to limit its influence on user prompts.",
								sourceRefs: [owaspRef],
								sourceUrls: [
									"https://genai.owasp.test/llmrisk/llm01-prompt-injection/",
								],
								sourceQuality: "primary",
							},
							{
								slotId: "slot-fs",
								quote:
									"Docker --read-only mounts the container root filesystem as read only; --tmpfs mounts a tmpfs directory.",
								sourceRefs: [dockerRef],
								sourceUrls: ["https://docs.docker.com/engine/containers/run/"],
								sourceQuality: "primary",
							},
						],
					},
				},
			},
			"normalize-claims.main": {
				claimInventory: {
					verificationCandidates: [
						{
							id: "claim-ci",
							claim:
								"Claude Code -p flag disables trust verification; teams must pre-configure allowedTools before bypassing the interactive approval gate.",
							factSlotIds: ["slot-ci"],
							sourceRefs: [claudeRef],
							sourceUrls: ["https://docs.anthropic.test/claude-code/security"],
						},
						{
							id: "claim-owasp",
							claim:
								"OWASP recommends privilege control, delimiters, and human approval for high-privilege operations.",
							factSlotIds: ["slot-prompt"],
							sourceRefs: [owaspRef],
							sourceUrls: [
								"https://genai.owasp.test/llmrisk/llm01-prompt-injection/",
							],
						},
						{
							id: "claim-docker",
							claim:
								"Docker --read-only makes the container root filesystem immutable; --tmpfs /tmp allows ephemeral writable scratch space.",
							factSlotIds: ["slot-fs"],
							sourceRefs: [dockerRef],
							sourceUrls: ["https://docs.docker.com/engine/containers/run/"],
						},
					],
					preservedClaims: [],
					duplicates: [],
				},
				factSlotCoverage: [],
				coverageGaps: [],
			},
		},
	});

	const claims = result.claimInventory.verificationCandidates;
	assert.deepEqual(
		claims.map((claim) => claim.id),
		["claim-ci", "claim-owasp", "claim-docker"],
	);
	assert.equal(
		claims[0].claim,
		"Trust verification is disabled when running non-interactively with the -p flag",
	);
	assert.equal(
		claims[1].claim,
		"Segregate and identify external content. Separate and clearly denote untrusted content to limit its influence on user prompts.",
	);
	assert.ok(
		claims[2].sourceUrls.includes(
			"https://docs.docker.com/reference/cli/docker/container/run/",
		),
	);
	assert.ok(
		claims[2].sourceUrls.includes("https://docs.docker.com/engine/storage/tmpfs/"),
	);
	assert.deepEqual(result.sanitizerDiagnostics.rewriteReasonCounts, {
		unsupported_normative_prerequisite: 1,
		source_hint_claim_mismatch: 1,
		unquoted_named_mitigation: 1,
	});
	assert.equal(result.sanitizerDiagnostics.rewrittenCandidateCount, 2);
});
