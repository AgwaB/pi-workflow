// Shard selection for goal-public-runtime-shared.mjs. That module registers
// about 260 slow Goal scenarios; one serial file took ~28 min, the critical path
// of the whole unit run. Each goal-public-runtime-N.test.mjs file imports the
// shared module in its own process with a different shard, so the scenarios run
// in parallel files. Assignment is round-robin over registration order, so
// every registered test belongs to exactly one shard.

export const GOAL_RUNTIME_SHARDS = 4;

let selected;
let inventory;
const registered = [];

/** Must run before the shared module is imported. */
export function setGoalRuntimeShard(index, count) {
  if (selected !== undefined || inventory !== undefined) throw new Error("Goal runtime shard is already selected");
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(index) || index < 0 || index >= count)
    throw new Error(`Invalid Goal runtime shard ${index} of ${count}`);
  selected = { index, count };
}

/** Lists every test name the shared module registers, without registering any. */
export function listGoalRuntimeTests() {
  if (selected !== undefined || inventory !== undefined) throw new Error("Goal runtime shard is already selected");
  inventory = true;
}

/** Called by the shared module for every top-level test it would register. */
export function goalRuntimeShardAdmits(name) {
  if (selected === undefined && inventory === undefined)
    throw new Error("Import goal-public-runtime-shared.mjs through a shard file");
  const index = registered.length;
  registered.push(name);
  if (inventory) return false;
  return index % selected.count === selected.index;
}

export function registeredGoalRuntimeTests() {
  return [...registered];
}
