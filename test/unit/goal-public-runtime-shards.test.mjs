// The Goal runtime shards together register every test of the shared module once.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GOAL_RUNTIME_SHARDS, listGoalRuntimeTests, registeredGoalRuntimeTests } from "./goal-public-runtime-shard.mjs";

const unitDir = dirname(fileURLToPath(import.meta.url));
listGoalRuntimeTests();
await import("./goal-public-runtime-shared.mjs");
const names = registeredGoalRuntimeTests();

test("Goal runtime shard files cover each shard exactly once", () => {
  const files = readdirSync(unitDir).filter(name => /^goal-public-runtime-\d+\.test\.mjs$/.test(name)).sort();
  assert.deepEqual(files, Array.from({ length: GOAL_RUNTIME_SHARDS }, (_, i) => `goal-public-runtime-${i + 1}.test.mjs`));
  for (const [i, file] of files.entries()) {
    const source = readFileSync(join(unitDir, file), "utf8");
    assert.match(source, new RegExp(`setGoalRuntimeShard\\(${i}, GOAL_RUNTIME_SHARDS\\);`), file);
    assert.match(source, /await import\("\.\/goal-public-runtime-shared\.mjs"\);/, file);
  }
  assert.equal(readdirSync(unitDir).includes("goal-public-runtime.test.mjs"), false, "no unsharded copy runs as well");
});

test("Goal runtime shards partition the shared tests", () => {
  // Static registrations in the shared module; a count change must be deliberate.
  assert.equal(names.length, 254, "registered Goal runtime tests");
  assert.ok(names.every(name => typeof name === "string" && name.length > 0));
  const shards = Array.from({ length: GOAL_RUNTIME_SHARDS }, (_, shard) =>
    names.filter((_, index) => index % GOAL_RUNTIME_SHARDS === shard));
  assert.equal(shards.flat().length, names.length);
  assert.ok(shards.every(shard => shard.length > 0));
});
