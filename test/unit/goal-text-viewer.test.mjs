import assert from "node:assert/strict";
import { test } from "node:test";
import { GoalTextViewer, showGoalTextViewer } from "../../.tmp/unit/goal-text-viewer.js";

const text = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join("\n");
function viewer(rows = 20) {
  let closed = 0, renders = 0;
  const view = new GoalTextViewer({ requestRender() { renders++; }, terminal: { rows } }, { bold: value => value },
    "Details", text, () => { closed++; });
  return { view, closed: () => closed, renders: () => renders };
}

test("the viewer opens at the top and scrolls by line, page and to the ends", () => {
  const { view, closed, renders } = viewer(20);
  let page = view.render(80);
  assert.equal(page[0], "Details");
  assert.equal(page[2], " line 1", "opens at the top");
  assert.match(page.at(-1), /lines 1-12 of 50$/);
  view.handleInput("\u001b[B");
  assert.equal(view.render(80)[2], " line 2");
  view.handleInput("\u001b[6~");
  assert.equal(view.render(80)[2], " line 14");
  view.handleInput("G");
  page = view.render(80);
  assert.equal(page[2], " line 39");
  assert.match(page.at(-1), /lines 39-50 of 50$/);
  view.handleInput("g");
  assert.equal(view.render(80)[2], " line 1");
  view.handleInput("\u001b[A");
  assert.equal(view.render(80)[2], " line 1", "does not scroll above the top");
  view.handleInput("x");
  assert.equal(renders(), 5, "unrelated keys do not re-render");
  view.handleInput("\r");
  assert.equal(closed(), 1);
});

test("long lines wrap and a host without custom components gets the editor", async () => {
  const wide = new GoalTextViewer({ requestRender() {}, terminal: { rows: 30 } }, {}, "T", "x".repeat(150), () => {});
  const lines = wide.render(60);
  assert.ok(lines.slice(2, 5).every(line => line.length <= 60));
  assert.equal(lines.filter(line => line.includes("x")).length, 3);
  const opened = [];
  await showGoalTextViewer({ ui: { editor: async (title, value) => { opened.push([title, value]); } } }, "T", "body");
  assert.deepEqual(opened, [["T", "body"]]);
});
