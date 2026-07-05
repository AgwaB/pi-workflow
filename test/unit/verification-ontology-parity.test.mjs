import assert from "node:assert/strict";
import test from "node:test";

import * as tsOntology from "../../.tmp/unit/verification-ontology.js";
import * as mjsOntology from "../../workflows/deep-research/helpers/verification-ontology.mjs";

// Guard: the package TypeScript ontology (src/verification-ontology.ts, compiled
// to .tmp/unit) and the bundle-local twin used by deep-research support helpers
// (workflows/deep-research/helpers/verification-ontology.mjs) must stay in
// semantic parity. This test fails if either side drifts on the frozen constant
// sets or on canonicalization/classification behavior.

const CONSTANT_EXPORTS = [
	"VERIFICATION_STATUS",
	"VERIFICATION_STATUS_VALUES",
	"VERIFICATION_STATUS_BUCKETS",
	"VERIFICATION_STATUS_LABELS",
];

const FUNCTION_EXPORTS = [
	"canonicalVerificationStatus",
	"verificationStatusBucket",
	"isVerifiedStatus",
	"isVerificationBlockedStatus",
	"isNonVerifiedTerminalStatus",
];

// Inputs spanning canonical values, aliases, blocked synonyms, camelCase bucket
// names, empty/invalid, and non-string values.
const STATUS_INPUTS = [
	"verified",
	"partially_supported",
	"partiallySupported",
	"unsupported",
	"conflicting",
	"verification_blocked",
	"verificationBlocked",
	"blocked",
	"unverified",
	"",
	"   ",
	"bogus",
	undefined,
	null,
	42,
];

test("verification ontology TS and mjs twins export identical constant sets", () => {
	for (const name of CONSTANT_EXPORTS) {
		assert.ok(name in tsOntology, `TS ontology missing ${name}`);
		assert.ok(name in mjsOntology, `mjs ontology missing ${name}`);
		assert.deepEqual(
			mjsOntology[name],
			tsOntology[name],
			`ontology constant ${name} drifted between TS and mjs twins`,
		);
	}
});

test("verification ontology TS and mjs twins expose identical function behavior", () => {
	for (const name of FUNCTION_EXPORTS) {
		assert.equal(
			typeof tsOntology[name],
			"function",
			`TS ontology missing function ${name}`,
		);
		assert.equal(
			typeof mjsOntology[name],
			"function",
			`mjs ontology missing function ${name}`,
		);
		for (const input of STATUS_INPUTS) {
			assert.deepEqual(
				mjsOntology[name](input),
				tsOntology[name](input),
				`ontology function ${name}(${String(input)}) drifted between twins`,
			);
		}
	}
});
