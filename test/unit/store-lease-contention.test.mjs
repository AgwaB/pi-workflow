import test from "node:test";
import { runContention } from "../fixtures/lease-handoff/contention.mjs";

// Real child processes, default product lease budgets/heartbeats, no caller
// retries. The fixture also supports bounded longer evidence runs directly.
for (const mode of ["topology", "publication", "usage", "mixed"]) {
  test(`four-process ${mode} handoffs repeatedly settle with exact durable counts`, { timeout: 250_000 }, async () => {
    await runContention({ mode, iterations: 30, repeats: 2 });
  });
}
