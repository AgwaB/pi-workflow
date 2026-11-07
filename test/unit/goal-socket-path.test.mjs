// Goal private socket directories must stay listenable when TMPDIR is long.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { goalSocketTemporaryParent } = await import("../../.tmp/unit/goal-workflow-runtime.js");

const listen = path => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(path, () => server.close(() => resolve()));
});

test("Goal socket directories fall back to /tmp only when TMPDIR is too long for a Unix socket", async t => {
  const original = process.env.TMPDIR;
  const owned = await mkdtemp("/tmp/goal-socket-path-");
  const long = join(owned, "x".repeat(Math.max(1, 80 - owned.length)));
  await mkdir(long);
  const created = [];
  t.after(async () => {
    if (original === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = original;
    for (const directory of created) await rm(directory, { recursive: true, force: true });
    await rm(owned, { recursive: true, force: true });
  });
  for (const [prefix, socket] of [["pi-goal-requests-", "requests.sock"], ["pi-goal-candidate-rpc-", "tools.sock"]]) {
    const relative = join("rpc", socket);
    process.env.TMPDIR = owned;
    assert.equal(goalSocketTemporaryParent(prefix, relative), owned, "a short TMPDIR is used as is");
    process.env.TMPDIR = long;
    assert.equal(tmpdir(), long);
    // The previous location really cannot listen.
    const naive = await mkdtemp(join(tmpdir(), prefix));
    created.push(naive);
    await mkdir(join(naive, "rpc"));
    await assert.rejects(listen(join(naive, relative)), { code: /^(EINVAL|ENAMETOOLONG)$/ });
    const parent = goalSocketTemporaryParent(prefix, relative);
    assert.equal(parent, "/tmp");
    const directory = await mkdtemp(join(parent, prefix));
    created.push(directory);
    await mkdir(join(directory, "rpc"));
    await listen(join(directory, relative));
  }
});
