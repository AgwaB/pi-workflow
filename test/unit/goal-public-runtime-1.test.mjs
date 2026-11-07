// Goal runtime tests, shard 1 of 4 (see goal-public-runtime-shard.mjs).
import { GOAL_RUNTIME_SHARDS, setGoalRuntimeShard } from "./goal-public-runtime-shard.mjs";
setGoalRuntimeShard(0, GOAL_RUNTIME_SHARDS);
await import("./goal-public-runtime-shared.mjs");
