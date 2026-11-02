import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("E2E guard allows only same-process listening Unix IPC, never external or retired sockets", async t => {
  const root = await mkdtemp(join(tmpdir(), "goal-ipc-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = join(root, "process.jsonl");
  const script = `
    import assert from 'node:assert/strict';
    import net from 'node:net';
    import { once } from 'node:events';
    import { execFile } from 'node:child_process';
    import { promisify } from 'node:util';
    const run = promisify(execFile);
    const commandResult = await run(process.execPath, ['-e', 'process.stdout.write("out");process.stderr.write("err")']);
    assert.deepEqual(commandResult, {stdout:'out',stderr:'err'});
    await assert.rejects(run(process.execPath, ['-e', 'process.stderr.write("failure");process.exit(3)']),
      error => error.code === 3 && error.stderr === 'failure' && error.stdout === '');
    assert.throws(() => run('curl', ['https://example.invalid']), /guard blocked/);
    const path = ${JSON.stringify(join(root, "owned.sock"))};
    assert.throws(() => net.createConnection({path}), /guard blocked/);
    const server = net.createServer(socket => socket.end('local'));
    server.listen(path); await once(server, 'listening');
    assert.throws(() => net.connect({host:'127.0.0.1',port:12345}), /guard blocked/);
    assert.throws(() => net.connect({path,host:'example.invalid',port:443}), /guard blocked/);
    assert.throws(() => new net.Socket().connect({path:path+'-foreign'}), /guard blocked/);
    const client = net.createConnection({path});
    let result = ''; client.on('data', bytes => result += bytes);
    await once(client,'close'); assert.equal(result,'local');
    server.close(); await once(server,'close');
    assert.throws(() => net.createConnection({path}), /guard blocked/);
  `;
  const child = spawnSync(process.execPath, ["--import=" + resolve("test/e2e/no-external-actions-guard.mjs"), "--input-type=module", "-e", script], {
    encoding: "utf8", timeout: 15000,
    env: { ...process.env, PI_WORKFLOW_E2E_NO_EXTERNAL_ACTIONS: "1", PI_WORKFLOW_E2E_PROCESS_LOG: log },
  });
  assert.equal(child.status, 0, child.stderr);
  const records = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(records.filter(record => record.type === "local-ipc").length, 1);
  assert.equal(records.filter(record => record.type === "network-attempt").length, 5);
  assert.equal(records.filter(record => record.type === "blocked-command").length, 1);
});
