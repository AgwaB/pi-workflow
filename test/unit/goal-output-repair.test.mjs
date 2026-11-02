import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWorkflowOutputForBundle } from "../../.tmp/unit/workflow-output-artifacts.js";

const truncated = '<control>\n{"schema":"dynamic-task-result-v1","digest":"d","score":0,"reason":"r"}\n</control>\n<analysis>\nTrace cut off';
const options = { analysisRequired: true, refsRequired: true, maxDigestChars: 1000 };

test("ordinary parsing salvages an unterminated envelope; strict sections reject it", () => {
  assert.equal(parseWorkflowOutputForBundle(truncated, options).valid, true,
    "ordinary tasks keep the existing missing-tail salvage");
  const strict = parseWorkflowOutputForBundle(truncated, { ...options, strictSections: true });
  assert.equal(strict.valid, false, "a Goal verifier envelope is never salvaged into a verdict");
  assert.ok(strict.issues.some(issue => issue.section === "refs"));
});

test("strict sections accept a complete envelope", () => {
  const complete = `${truncated}\n</analysis>\n<refs>\n[]\n</refs>`;
  assert.equal(parseWorkflowOutputForBundle(complete, { ...options, strictSections: true }).valid, true);
});
