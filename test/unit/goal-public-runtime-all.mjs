// Every Goal runtime test in one process. Not matched by test/unit/*.test.mjs;
// the producer scenarios run it in a separate test runner with a name pattern.
import { setGoalRuntimeShard } from "./goal-public-runtime-shard.mjs";
setGoalRuntimeShard(0, 1);
await import("./goal-public-runtime-shared.mjs");
