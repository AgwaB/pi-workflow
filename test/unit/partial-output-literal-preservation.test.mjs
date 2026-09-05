import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWorkflowOutput, parseWorkflowOutputForBundle } from "../../.tmp/unit/workflow-output-artifacts.js";
import { parseWorkflowPartialOutput, stripWorkflowPartialOutputSections, hasFatalPartialOutputIssue } from "../../.tmp/unit/workflow-partial-output.js";

const publication = (text = "stable") => `<partial-control>${JSON.stringify({ schema: "workflow-partial-output-v1", path: "$.items", items: [{ id: "one", text }] })}</partial-control>`;
const output = (literal) => `<control>${JSON.stringify({ schema: "stage-control-v1", digest: literal })}</control>\n<analysis>${literal}</analysis>\n<refs>${JSON.stringify([{ note: literal }])}</refs>`;

for (const literal of ["literal <partial-control>example</partial-control> retained", '`<partial-control>example</partial-control>`', `Quoted publication:\n\`\`\`json\n${publication()}\n\`\`\``]) {
 test(`final literal partial markers remain exact data: ${literal.slice(0, 35)}`, () => {
  const raw = output(literal);
  for (const parser of [parseWorkflowOutput, parseWorkflowOutputForBundle]) {
   const parsed = parser(raw);
   assert.equal(parsed.valid, true, JSON.stringify(parsed.issues));
   assert.equal(parsed.raw, raw);
   assert.equal(parsed.control.digest, literal);
   assert.equal(parsed.analysis, literal);
   assert.deepEqual(parsed.refs, [{ note: literal }]);
  }
  assert.deepEqual(parseWorkflowPartialOutput(raw).items, []);
  assert.equal(stripWorkflowPartialOutputSections(raw), raw);
 });
}

test("real leading partial publications remain available and immutable", () => {
 const raw = `${publication()}\n${publication()}\n${output("done")}`;
 const ledger = parseWorkflowPartialOutput(raw, { allowedPaths: ["$.items"] });
 assert.equal(ledger.items.length, 1);
 assert.deepEqual(ledger.issues, []);
 assert.equal(parseWorkflowOutput(raw).valid, true);
 const changed = parseWorkflowPartialOutput(`${publication()}\n${publication("changed")}`);
 assert.equal(hasFatalPartialOutputIssue(changed)?.code, "duplicate_item_id");
 assert.equal(changed.items[0].item.text, "stable");
 assert.equal(parseWorkflowOutputForBundle(`${publication()}\n${publication("changed")}\n${output("done")}`).valid, false);
});

test("partial JSON strings may themselves contain literal closing markers", () => {
 const literal = "quoted </partial-control> and <partial-control> are data";
 const raw = `${publication(literal)}\n${output("done")}`;
 const ledger = parseWorkflowPartialOutput(raw);
 assert.deepEqual(ledger.issues, []);
 assert.equal(ledger.items[0].item.text, literal);
 assert.equal(parseWorkflowOutput(raw).valid, true);
});

test("fenced or inline examples are not streaming publications", () => {
 for (const raw of [`\`\`\`json\n${publication()}\n\`\`\``, `Example: ${publication()} retained`]) {
  assert.deepEqual(parseWorkflowPartialOutput(raw).items, []);
  assert.equal(stripWorkflowPartialOutputSections(raw), raw);
 }
});

test("invalid and undeclared publications are not silently erased or repaired away", () => {
 for (const raw of [`<partial-control>not JSON</partial-control>\n${output("done")}`, `${publication()}\n${output("done")}`]) {
  const parsed = parseWorkflowOutputForBundle(raw, { partialPaths: [] });
  assert.equal(parsed.valid, false);
  assert.equal(parsed.raw, raw);
 }
 assert.equal(parseWorkflowOutputForBundle(`${publication()}\n${output("done")}`, { partialPaths: ["$.items"] }).valid, true);
});

test("standalone publications survive progress prose and neighboring fenced examples", () => {
 const raw = `Preparing items.\n\`\`\`json\n${publication("example")}\n\`\`\`\n${publication()}\nStill working.\n${publication()}\n${output("done")}`;
 const ledger = parseWorkflowPartialOutput(raw, { allowedPaths: ["$.items"] });
 assert.deepEqual(ledger.issues, []);
 assert.equal(ledger.items.length, 1);
 assert.equal(ledger.items[0].item.text, "stable");
 // Fenced examples are preserved rather than silently erased, even in preamble.
 assert.match(stripWorkflowPartialOutputSections(raw), /example/);
 const withoutExample = `Preparing items.\n${publication()}\nStill working.\n${publication()}\n${output("done")}`;
 assert.equal(parseWorkflowOutputForBundle(withoutExample).valid, true);
 const invalid = `Preparing items.\n<partial-control>invalid JSON</partial-control>\n${output("done")}`;
 assert.equal(parseWorkflowOutputForBundle(invalid).valid, false);
});

test("partial publications do not hide genuinely duplicate final sections", () => {
 const raw = `${publication()}\n${output("done")}\n<refs>[]</refs>`;
 for (const parser of [parseWorkflowOutput, parseWorkflowOutputForBundle]) {
  const parsed = parser(raw);
  assert.equal(parsed.valid, false);
  assert.ok(parsed.issues.some((issue) => issue.code === "duplicate_section" && issue.section === "refs"));
 }
});
