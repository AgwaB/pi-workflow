import assert from "node:assert/strict";
import test from "node:test";

import { add } from "./math.js";

test("add returns numeric sums", () => {
  assert.equal(add(1, 2), 3);
  assert.equal(add(-1, 1), 0);
});

test("add handles decimal sums", () => {
  assert.ok(Math.abs(add(0.1, 0.2) - 0.3) < Number.EPSILON * 2);
});
