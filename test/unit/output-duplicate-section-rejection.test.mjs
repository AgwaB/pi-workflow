import assert from "node:assert/strict";
import { test } from "node:test";

import {
	parseWorkflowOutput,
	parseWorkflowOutputForBundle,
} from "../../.tmp/unit/workflow-output-artifacts.js";

const VALID_OUTPUT = [
	'<control>{"schema":"stage-control-v1","digest":"first"}</control>',
	"<analysis>valid analysis</analysis>",
	"<refs>[]</refs>",
].join("\n");

const DUPLICATED_CONTROL_OUTPUT = [
	VALID_OUTPUT,
	'<control>{"schema":"stage-control-v1","digest":"second"}</control>',
].join("\n");

test("parseWorkflowOutput rejects repeated control sections with duplicate_section", () => {
	const parsed = parseWorkflowOutput(DUPLICATED_CONTROL_OUTPUT);
	assert.equal(parsed.valid, false);
	const duplicate = parsed.issues.find(
		(issue) => issue.code === "duplicate_section",
	);
	assert.ok(duplicate, "expected a duplicate_section issue");
	assert.equal(duplicate.section, "control");
	assert.match(duplicate.message, /exactly once; found 2/);
});

test("parseWorkflowOutputForBundle must not sanitize away a repeated section", () => {
	const parsed = parseWorkflowOutputForBundle(DUPLICATED_CONTROL_OUTPUT);
	assert.equal(parsed.valid, false);
	assert.ok(
		parsed.issues.some((issue) => issue.code === "duplicate_section"),
		"sanitized recovery must not erase the duplicate_section evidence",
	);
});

test("parseWorkflowOutput rejects a repeated analysis section with duplicate_section", () => {
	const parsed = parseWorkflowOutput(
		`${VALID_OUTPUT}\n<analysis>second analysis</analysis>`,
	);
	assert.equal(parsed.valid, false);
	assert.ok(
		parsed.issues.some(
			(issue) =>
				issue.code === "duplicate_section" && issue.section === "analysis",
		),
	);
});

test("parseWorkflowOutput still rejects a trailing repeated refs section", () => {
	// The trailing block is absorbed into the refs span (last section has no
	// next-tag anchor), so rejection comes from refs JSON validation rather
	// than duplicate_section; either way the output must not be valid.
	const parsed = parseWorkflowOutput(`${VALID_OUTPUT}\n<refs>[]</refs>`);
	assert.equal(parsed.valid, false);
});

test("literal opening tags inside section content stay tolerated", () => {
	const raw = [
		"<control>",
		JSON.stringify({
			schema: "stage-control-v1",
			digest: "quoted protocol",
			evidence:
				"Return <control>{}</control> <analysis>...</analysis> <refs>[]</refs> exactly.",
		}),
		"</control>",
		"<analysis>",
		"Analysis may mention <analysis> as literal text.",
		"</analysis>",
		"<refs>",
		"[]",
		"</refs>",
	].join("\n");
	const parsed = parseWorkflowOutput(raw);
	assert.equal(parsed.valid, true, JSON.stringify(parsed.issues));
});

test("parseWorkflowOutput keeps accepting exactly one section of each kind", () => {
	const parsed = parseWorkflowOutput(VALID_OUTPUT);
	assert.equal(parsed.valid, true);
	assert.deepEqual(parsed.issues, []);
});
