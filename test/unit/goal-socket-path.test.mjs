// Goal private socket directories must stay listenable when TMPDIR is long.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { goalSocketTemporaryParent } = await import("../../.tmp/unit/goal-workflow-runtime.js");

// Resolves with whether the endpoint exists at the full path while listening:
// the Goal channel lstat()s that path right after listen. Node 24 rejects an
// over-long path; Node 22 binds a shortened path instead, so neither can serve.
const listen = path => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(path, () => { const present = existsSync(path); server.close(() => resolve(present)); });
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
    assert.ok(Buffer.byteLength(join(naive, relative)) > 103, "the previous location is over the socket path limit");
    const naiveEndpoint = await listen(join(naive, relative)).catch(error => {
      assert.match(error.code, /^(EINVAL|ENAMETOOLONG)$/);
      return false;
    });
    assert.equal(naiveEndpoint, false, "the previous location cannot hold a Goal endpoint at its full path");
    const parent = goalSocketTemporaryParent(prefix, relative);
    assert.equal(parent, "/tmp");
    const directory = await mkdtemp(join(parent, prefix));
    created.push(directory);
    await mkdir(join(directory, "rpc"));
    assert.equal(await listen(join(directory, relative)), true, "the fallback endpoint exists at its full path");
  }
});
