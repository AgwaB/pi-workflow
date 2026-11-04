import assert from "node:assert/strict";
import { test } from "node:test";
import { firstParagraph, firstSentence, lineDiffStats, requestLanguage, summarizeCommandOutput } from "../../.tmp/unit/goal-report.js";

test("command output is read as a short pass/fail summary and the first failures", () => {
  const node = '✔ "a,b" (0.6ms)\n✖ " a , b " (0.5ms)\n✖ "ab\\"c,d" (0.1ms)\nℹ tests 12\nℹ suites 0\nℹ pass 10\nℹ fail 2\nℹ duration_ms 44\n' +
    '\n✖ failing tests:\n\ntest at test/csv.test.mjs:4:51\n✖ " a , b " (0.5ms)';
  assert.deepEqual(summarizeCommandOutput(node), { summary: "tests 12, pass 10, fail 2", failed: ['" a , b "', '"ab\\"c,d"'] });
  assert.deepEqual(summarizeCommandOutput("Tests:       1 failed, 4 passed, 5 total\nFAIL src/a.test.ts"),
    { summary: "Tests: 1 failed, 4 passed, 5 total", failed: ["src/a.test.ts"] });
  assert.deepEqual(summarizeCommandOutput("collected 3 items\n===== 1 failed, 2 passed in 0.12s ====="),
    { summary: "===== 1 failed, 2 passed in 0.12s =====", failed: [] });
  assert.deepEqual(summarizeCommandOutput("", "error: cannot find module"), { summary: "error: cannot find module", failed: [] });
  assert.deepEqual(summarizeCommandOutput(""), { failed: [] });
});

test("line diff counts are exact for ordinary edits", () => {
  assert.deepEqual(lineDiffStats("a\nb\nc\n", "a\nb\nc\n"), { added: 0, removed: 0 });
  assert.deepEqual(lineDiffStats("a\nb\nc\n", "a\nB\nc\nd\n"), { added: 2, removed: 1 });
  assert.deepEqual(lineDiffStats("export function f() {\n  return 1;\n}\n", "export function f() {\n  const x = 1;\n  return x;\n}\n"),
    { added: 2, removed: 1 });
  assert.deepEqual(lineDiffStats("", "x\ny"), { added: 2, removed: 1 });
});

test("a worker note is its first paragraph on one bounded line", () => {
  assert.equal(firstParagraph("Changed only src/csv.mjs.\nAdded quote tracking.\n\nDetails follow."), "Changed only src/csv.mjs. Added quote tracking.");
  assert.equal(firstParagraph("x".repeat(300)).length, 220);
  assert.equal(firstParagraph("\n\n"), "");
});

test("a worker digest is reduced to its first sentence", () => {
  assert.equal(firstSentence("Updated src/csv.mjs to trim unquoted fields. The tests could not be run."),
    "Updated src/csv.mjs to trim unquoted fields.");
  assert.equal(firstSentence("No sentence end here"), "No sentence end here");
  assert.equal(firstSentence("Version 1.5 works fine. Next."), "Version 1.5 works fine.", "a decimal point is not a sentence end");
});

test("the request's language is named from its script, never from Latin text", () => {
  assert.equal(requestLanguage("CSV 파서를 테스트에 맞게 고쳐줘"), "Korean");
  assert.equal(requestLanguage("パーサーを直して"), "Japanese");
  assert.equal(requestLanguage("修复解析器"), "Chinese");
  assert.equal(requestLanguage("Исправь парсер"), "Russian");
  assert.equal(requestLanguage("Fix the CSV parser"), undefined);
  assert.equal(requestLanguage(undefined), undefined);
});

test("a unified line diff lists removals before additions with context", async () => {
  const { unifiedLineDiff } = await import("../../.tmp/unit/goal-report.js");
  assert.deepEqual(unifiedLineDiff("a\nb\nc\nd\ne\nf\ng\nh", "a\nB\nc\nd\ne\nf\ng\nh\ni"),
    ["@@ -1,4 +1,4 @@", " a", "-b", "+B", " c", " d", "@@ -7,2 +7,3 @@", " g", " h", "+i"]);
  assert.deepEqual(unifiedLineDiff("same", "same"), []);
  assert.deepEqual(unifiedLineDiff("", "x\ny"), ["@@ -0,0 +1,2 @@", "+x", "+y"]);
  assert.equal(unifiedLineDiff("a\n".repeat(2001), "b\n".repeat(2001)), undefined, "too large to compare");
});
