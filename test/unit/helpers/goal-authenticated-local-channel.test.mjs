import assert from "node:assert/strict";
import { createHash, createPrivateKey } from "node:crypto";
import fsPromises, { lstat, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import ssh2 from "ssh2";

import {
  exchangeGoalAuthenticatedLocalChannel,
  createGoalAuthenticatedLocalHostKey,
  generateGoalAuthenticatedLocalHostKey,
  goalAuthenticatedRequestWasSent,
  openGoalAuthenticatedLocalChannel,
  openGoalAuthenticatedLocalSession,
} from "../../../.tmp/unit/goal-authenticated-local-channel.js";
import { callGoalCandidateTool, createGoalRequestBudget, openGoalCandidateToolChannel, openGoalRequestBudgetChannel } from "../../../.tmp/unit/workflow-goal-workspace-tools.js";
import { prepareGoalWorkspaceHost } from "../../../.tmp/unit/goal-workspace-host.js";
import { goalHash } from "../../../.tmp/unit/goal-json.js";
import { setRunLeaseTestHooksForTests } from "../../../.tmp/unit/store.js";

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "goal-ssh-"));
  const stopped = new AbortController();
  const requests = [];
  const server = await openGoalAuthenticatedLocalChannel({
    socketPath: join(directory, "channel.sock"), attemptKey: "attempt", stopped: stopped.signal,
    async onRequest(value, peer) { requests.push(value); return overrides.onRequest ? overrides.onRequest(value, peer) : { status: "ok", echo: value.id }; },
    async onAcknowledged(request, result, peer) { return overrides.onAcknowledged ? overrides.onAcknowledged(request, result, peer) : { status: result.status === "ok" ? "acknowledged" : "blocked" }; },
    async onDisconnect(peer) { await overrides.onDisconnect?.(peer); },
  });
  t.after(async () => {
    if (overrides.expectedDrainFailure) await assert.rejects(server.drain(), overrides.expectedDrainFailure);
    else await server.drain();
    await rm(directory, { recursive: true, force: true });
  });
  return { server, requests };
}

test("Ed25519 SSH host keys preserve zero-prefixed public octets", { timeout: 20_000 }, async t => {
  const publicKey = Buffer.from("AAAfi-pCs8dMUKo1ibGqBl8ZaFfbl6deSlSVPwk-Z3I", "base64url");
  const privateSeed = Buffer.from("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACQ", "base64url");
  assert.equal(publicKey.length, 32);
  assert.equal(privateSeed.length, 32);
  assert.equal(publicKey[0], 0, "fixture exercises the leading-zero encoding boundary");

  const privateObject = createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", x: publicKey.toString("base64url"), d: privateSeed.toString("base64url") },
    format: "jwk",
  });
  const legacyPem = privateObject.export({ format: "pem", type: "pkcs8" });
  const legacyParsed = ssh2.utils.parseKey(legacyPem);
  assert.ok(legacyParsed instanceof Error, "ssh2's PEM conversion rejects the valid zero-prefixed public key");

  const hostKey = createGoalAuthenticatedLocalHostKey(publicKey, privateSeed);
  assert.throws(() => createGoalAuthenticatedLocalHostKey(publicKey, Buffer.alloc(32)), /material does not match/);
  const parsed = ssh2.utils.parseKey(hostKey);
  assert.ok(!(parsed instanceof Error) && !Array.isArray(parsed));
  assert.equal(parsed.isPrivateKey(), true);
  const expectedPublic = Buffer.concat([
    Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"),
    Buffer.from([0, 0, 0, 32]), publicKey,
  ]);
  assert.deepEqual(parsed.getPublicSSH(), expectedPublic);
  const endpoint = join(await mkdtemp(join(tmpdir(), "goal-ed25519-zero-")), "ssh.sock");
  const sshServer = new ssh2.Server({ hostKeys: [hostKey] }, connection => {
    connection.on("authentication", context => context.accept());
  });
  const listener = net.createServer(socket => sshServer.injectSocket(socket));
  const client = new ssh2.Client();
  t.after(async () => {
    client.end();
    await new Promise(resolve => listener.close(() => resolve()));
    await rm(dirname(endpoint), { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(endpoint, resolve);
  });
  const expectedPin = createHash("sha256").update(expectedPublic).digest("hex");
  await new Promise((resolve, reject) => {
    client.once("error", reject);
    client.once("ready", resolve);
    client.connect({ sock: net.createConnection(endpoint), username: "fixture", password: "fixture",
      authHandler: ["password"], algorithms: { serverHostKey: ["ssh-ed25519"] },
      hostVerifier: key => createHash("sha256").update(key).digest("hex") === expectedPin });
  });
  client.end();

  for (let i = 0; i < 512; i++) {
    const generated = ssh2.utils.parseKey(generateGoalAuthenticatedLocalHostKey());
    assert.ok(!(generated instanceof Error) && !Array.isArray(generated), `generated key ${i} parses`);
    assert.equal(generated.isPrivateKey(), true);
    assert.equal(generated.getPublicSSH().length, 51, `generated key ${i} retains a 32-byte public key`);
  }
});

test("authenticated local SSH uses one pinned Unix socket through result and ACK", async t => {
  const { server, requests } = await fixture(t);
  const result = await exchangeGoalAuthenticatedLocalChannel(server, { id: "one" });
  assert.deepEqual(result, { status: "ok", echo: "one" });
  assert.deepEqual(requests, [{ id: "one" }]);
});

test("candidate UNKNOWN replay survives authority mutation without changing its receipt", { timeout: 10_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gc-")));
  const rpcParent = await realpath(await mkdtemp(join("/tmp", "r-")));
  const rpc = join(rpcParent, "c");
  const stopped = new AbortController();
  let authority = "original", writes = 0;
  await fsPromises.mkdir(join(root, "origin"));
  await writeFile(join(root, "origin", "a.txt"), "before");
  const guard = { assertCurrent: () => stopped.signal.throwIfAborted(), assertLive: () => stopped.signal.throwIfAborted() };
  const physical = await prepareGoalWorkspaceHost({ originRoot: join(root, "origin"), workspaceRoot: join(root, "candidate"),
    artifactRoot: join(root, "artifacts"), workspaceId: "unknown-replay", repository: "nonGit", mode: "mutation",
    scope: ["a.txt"], protectedPaths: [] }, guard);
  const workspace = { ...physical, async writeCandidate(...args) {
    writes++;
    const result = await physical.writeCandidate(...args);
    authority = "mutated";
    return result;
  } };
  const channel = await openGoalCandidateToolChannel({ directory: rpc, evidenceRoot: join(root, "evidence"),
    identity: { run: "fixture", generation: 1 }, attemptKey: "attempt", workspace,
    tools: ["goal_candidate_read", "goal_candidate_write"], assertCurrent: async () => authority,
    assertLive: guard.assertLive, stopped: stopped.signal });
  t.after(async () => { await channel.drain().catch(() => undefined); await fsPromises.rm(root, { recursive: true, force: true }); await fsPromises.rm(rpcParent, { recursive: true, force: true }); });
  const read = await callGoalCandidateTool(channel.channel, "read", "goal_candidate_read", { path: "a.txt" });
  const params = { path: "a.txt", expectedDigest: read.expectedDigest, content: "after" };
  assert.equal((await callGoalCandidateTool(channel.channel, "write", "goal_candidate_write", params)).status, "unknown");
  const directory = (await readdir(join(root, "evidence")))[0];
  const receiptPath = join(root, "evidence", directory, `${goalHash("write")}.json`);
  const originalReceipt = await readFile(receiptPath, "utf8");
  assert.equal(JSON.parse(originalReceipt).phase, "unknown");
  assert.equal((await callGoalCandidateTool(channel.channel, "write", "goal_candidate_write", params)).status, "unknown",
    "exact replay preserves UNKNOWN despite invalid current authority");
  assert.equal((await callGoalCandidateTool(channel.channel, "write", "goal_candidate_write", { ...params, content: "changed" })).status, "blocked");
  assert.equal((await callGoalCandidateTool(channel.channel, "write-new", "goal_candidate_write", params)).status, "blocked");
  assert.equal(await readFile(receiptPath, "utf8"), originalReceipt, "replay and changed IDs preserve original UNKNOWN receipt");
  assert.equal(writes, 1, "neither exact nor changed request can repeat the effect");
});

test("invalid envelope identity is rejected before request transmission", async t => {
  const { server, requests } = await fixture(t);
  const session = await openGoalAuthenticatedLocalSession(server);
  try {
    await assert.rejects(session.exchange({ id: "not-sent" },
      { operationId: "pre-send", fingerprint: "invalid" }));
    assert.equal(requests.length, 0);
  } finally { await session.close(); }
});

test("foreign host pin and password are rejected before request admission", async t => {
  const { server, requests } = await fixture(t);
  await assert.rejects(exchangeGoalAuthenticatedLocalChannel({ ...server, hostKeyPin: "00".repeat(32) }, { id: "pin" }));
  await assert.rejects(exchangeGoalAuthenticatedLocalChannel({ ...server, secret: "00".repeat(32) }, { id: "secret" }));
  assert.equal(requests.length, 0);
});

test("wrong-length authentication secrets and pins fail closed", async t => {
  const { server, requests } = await fixture(t);
  await assert.rejects(exchangeGoalAuthenticatedLocalChannel({ ...server, secret: "short" }, { id: "short-secret" }));
  await assert.rejects(exchangeGoalAuthenticatedLocalChannel({ ...server, hostKeyPin: "abc" }, { id: "short-pin" }));
  assert.equal(requests.length, 0);
});

test("multiple operation phases share one authenticated SSH session", async t => {
  const { server, requests } = await fixture(t);
  const session = await openGoalAuthenticatedLocalSession(server);
  const fingerprint = createHash("sha256").update("original-provider-request").digest("hex");
  try {
    assert.deepEqual(await session.exchange({ id: "reserve", operationId: "provider-1", fingerprint }, { operationId: "provider-1", fingerprint }),
      { status: "ok", echo: "reserve" });
    assert.deepEqual(await session.exchange({ id: "release", operationId: "provider-1", fingerprint }, { operationId: "provider-1", fingerprint }),
      { status: "ok", echo: "release" });
    assert.deepEqual(await session.exchange({ id: "settle", operationId: "provider-1", fingerprint }, { operationId: "provider-1", fingerprint }),
      { status: "ok", echo: "settle" });
  } finally { await session.close(); }
  assert.deepEqual(requests, [{ id: "reserve", operationId: "provider-1", fingerprint },
    { id: "release", operationId: "provider-1", fingerprint }, { id: "settle", operationId: "provider-1", fingerprint }]);
});

test("payload cap excludes SSH frame envelope overhead", async t => {
  const { server } = await fixture(t);
  const exact = { value: "x".repeat(32768 - Buffer.byteLength(JSON.stringify({ value: "" }))) };
  assert.equal(Buffer.byteLength(JSON.stringify(exact)), 32768);
  const result = await exchangeGoalAuthenticatedLocalChannel(server, exact);
  assert.equal(result.status, "ok");
  const oversized = { value: `${exact.value}x` };
  await assert.rejects(exchangeGoalAuthenticatedLocalChannel(server, oversized));
});

test("lost connection fences peer and joins the actual callback", async t => {
  let startedResolve, finishResolve, disconnectedResolve;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const finish = new Promise(resolve => { finishResolve = resolve; });
  const disconnected = new Promise(resolve => { disconnectedResolve = resolve; });
  let effectFinished = false;
  const { server } = await fixture(t, {
    async onRequest() { startedResolve(); await finish; effectFinished = true; return { status: "possible-effect" }; },
    onDisconnect() { disconnectedResolve(); },
  });
  const session = await openGoalAuthenticatedLocalSession(server);
  const request = session.exchange({ id: "lost" }, { operationId: "lost-op", fingerprint: createHash("sha256").update("lost-op").digest("hex") });
  const rejected = assert.rejects(request, /truncated|closed/);
  try {
    await started;
    await session.close();
    await rejected;
    await assert.rejects(request, error => goalAuthenticatedRequestWasSent(error));
    await disconnected;
    assert.equal(effectFinished, false);
    finishResolve();
    await server.drain();
    assert.equal(effectFinished, true);
  } finally {
    finishResolve();
    await session.close().catch(() => undefined);
  }
});

test("another authenticated connection cannot settle an original peer reservation", async t => {
  const directory = await mkdtemp(join(tmpdir(), "goal-ssh-budget-peer-"));
  const evidenceRoot = join(directory, "reservations");
  const budget = createGoalRequestBudget(1);
  const server = await openGoalRequestBudgetChannel({
    directory: join(directory, "rpc"), evidenceRoot, identity: { fixture: "original-peer" },
    attemptKey: "original-attempt", model: "fixture/model", budget,
    current: async () => "original-authority", live() {}, stopped: new AbortController().signal,
  });
  t.after(async () => { await server.drain(); await rm(directory, { recursive: true, force: true }); });
  const extension = await readFile(server.extensionPath, "utf8");
  const prefix = "registerGoalRequestBudget(pi, ";
  const binding = JSON.parse(extension.slice(extension.indexOf(prefix) + prefix.length,
    extension.lastIndexOf(', "fixture/model");')));
  const original = await openGoalAuthenticatedLocalSession(binding);
  const commitment = createHash("sha256").update("budget-commitment").digest("hex");
  let impostor;
  try {
    await original.exchange({ id: "reservation", commitment, action: "reserve" }, { operationId: "reservation", fingerprint: commitment });
    await original.exchange({ id: "reservation", commitment, action: "release" }, { operationId: "reservation", fingerprint: commitment });
    const records = await readdir(evidenceRoot);
    assert.equal(records.length, 1);
    const recordPath = join(evidenceRoot, records[0]);
    const before = await readFile(recordPath, "utf8");
    assert.equal(JSON.parse(before).phase, "released");
    impostor = await openGoalAuthenticatedLocalSession(binding);
    await assert.rejects(impostor.exchange({ id: "reservation", commitment, action: "settle", known: true }, { operationId: "reservation", fingerprint: commitment }));
    await impostor.close().catch(() => undefined);
    assert.equal(await readFile(recordPath, "utf8"), before, "wrong peer cannot rewrite original reservation evidence");
    await original.exchange({ id: "reservation", commitment, action: "settle", known: true }, { operationId: "reservation", fingerprint: commitment });
    assert.equal(JSON.parse(await readFile(recordPath, "utf8")).phase, "settled");
    assert.equal(await budget.settledRequestCount(), 1);
  } finally {
    await impostor?.close().catch(() => undefined);
    await original.close().catch(() => undefined);
  }
});

test("disconnect during original reservation publication persists owned UNKNOWN", { timeout: 10_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "goal-ssh-budget-loss-"));
  const evidenceRoot = join(directory, "reservations"), release = [];
  let enteredResolve;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const budget = createGoalRequestBudget(1);
  const server = await openGoalRequestBudgetChannel({ directory: join(directory, "rpc"), evidenceRoot,
    identity: { fixture: "reservation-publication-loss" }, attemptKey: "original-attempt",
    model: "fixture/model", budget, current: async () => "original-authority", live() {},
    stopped: new AbortController().signal });
  t.after(async () => { setRunLeaseTestHooksForTests(); await server.drain().catch(() => undefined); await rm(directory, { recursive: true, force: true }); });
  const extension = await readFile(server.extensionPath, "utf8"), marker = "registerGoalRequestBudget(pi, ";
  const binding = JSON.parse(extension.slice(extension.indexOf(marker) + marker.length,
    extension.lastIndexOf(', "fixture/model");')));
  const original = await openGoalAuthenticatedLocalSession(binding);
  const id = "disconnect-during-reserve", commitment = createHash("sha256").update("reserve-content").digest("hex");
  let admissionPaused = false;
  setRunLeaseTestHooksForTests({ async onBeforeExclusiveLink({ file }) {
    if (!file.startsWith(`${evidenceRoot}/`) || admissionPaused) return;
    admissionPaused = true;
    enteredResolve(); await new Promise(resolve => release.push(resolve));
  } });
  const reserve = original.exchange({ id, commitment, action: "reserve" }, { operationId: id, fingerprint: commitment });
  const rejected = assert.rejects(reserve);
  try {
    await entered;
    await original.close().catch(() => undefined);
    release.forEach(resolve => resolve());
    await rejected;
    const deadline = Date.now() + 2_000;
    let name, record;
    do {
      name = (await readdir(evidenceRoot)).find(value => value.endsWith(".json"));
      record = name && JSON.parse(await readFile(join(evidenceRoot, name), "utf8"));
      if (record?.phase === "unknown") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    setRunLeaseTestHooksForTests();
    assert.ok(name, "owned UNKNOWN receipt publication completes before evidence inspection");
    assert.equal(record?.phase, "unknown", "disconnect callback joins reservation UNKNOWN publication");
    const path = join(evidenceRoot, name);
    assert.match(record.id, /^[a-f0-9]{64}:/);
    assert.equal(record.id.slice(-id.length), id);
    assert.equal(record.commitment, commitment);
    assert.equal(record.phase, "unknown");
    assert.equal(await budget.settledRequestCount(), null);
    const impostor = await openGoalAuthenticatedLocalSession(binding);
    try {
      await assert.rejects(impostor.exchange({ id, commitment, action: "release" }, { operationId: id, fingerprint: commitment }));
      await assert.rejects(impostor.exchange({ id, commitment, action: "settle", known: true }, { operationId: id, fingerprint: commitment }));
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), record, "foreign peer cannot modify original UNKNOWN receipt");
    } finally { await impostor.close().catch(() => undefined); }
  } finally {
    release.forEach(resolve => resolve()); setRunLeaseTestHooksForTests(); await original.close().catch(() => undefined);
  }
});

test("substituted non-socket endpoint is rejected without a request", async t => {
  const { server, requests } = await fixture(t);
  await assert.rejects(exchangeGoalAuthenticatedLocalChannel({ ...server, socketPath: join(tmpdir(), "not-a-goal-socket") }, { id: "substituted" }));
  assert.equal(requests.length, 0);
});

test("drain preserves a foreign replacement Unix listener", async t => {
  const { server } = await fixture(t);
  const held = `${server.socketPath}.held`;
  const foreignPath = `${server.socketPath}.foreign`;
  await rename(server.socketPath, held);
  const sockets = new Set();
  const foreign = net.createServer(socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  let probe;
  try {
    await new Promise((resolve, reject) => { foreign.once("error", reject); foreign.listen(foreignPath, resolve); });
    const identity = await lstat(foreignPath);
    await rename(foreignPath, server.socketPath);
    await server.drain();
    const preserved = await lstat(server.socketPath);
    assert.equal(preserved.dev, identity.dev);
    assert.equal(preserved.ino, identity.ino);
    assert.equal(foreign.listening, true);
    // The unchanged guard tracks actual bound names, not renamed aliases.
    // Restore this verified foreign inode to its own still-listening name.
    await rename(server.socketPath, foreignPath);
    probe = net.connect({ path: foreignPath });
    await new Promise((resolve, reject) => { probe.once("connect", resolve); probe.once("error", reject); });
  } finally {
    probe?.destroy();
    for (const socket of sockets) socket.destroy();
    if (foreign.listening)
      await new Promise((resolve, reject) => foreign.close(error => error ? reject(error) : resolve()));
  }
});

test("drain joins accepted SSH work and fences new admission", async t => {
  const { server } = await fixture(t);
  await server.drain();
  await assert.rejects(exchangeGoalAuthenticatedLocalChannel(server, { id: "closed" }));
});

test("drain closes an active persistent session after its authentic ACK", { timeout: 10_000 }, async t => {
  let enteredResolve, releaseResolve;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const release = new Promise(resolve => { releaseResolve = resolve; });
  const { server } = await fixture(t, { async onRequest(value) {
    enteredResolve(); await release; return { status: "ok", echo: value.id };
  } });
  const session = await openGoalAuthenticatedLocalSession(server);
  let request, drain;
  try {
    request = session.exchange({ id: "held-open" }, {
      operationId: "held-open-operation", fingerprint: createHash("sha256").update("held-open-request").digest("hex"),
    });
    await entered;
    drain = server.drain();
    releaseResolve();
    assert.deepEqual(await request, { status: "ok", echo: "held-open" }, "admitted exchange receives authentic result and ACK");
    const outcome = await Promise.race([
      drain.then(() => "drained"),
      new Promise(resolve => setTimeout(() => resolve("blocked"), 2_000)),
    ]);
    assert.equal(outcome, "drained", "server drain closes its owned persistent session without client.close");
  } finally {
    releaseResolve();
    await session.close().catch(() => undefined);
    await drain?.catch(() => undefined);
  }
});

test("endpoint restoration never replaces a newly occupied destination", async t => {
  const expected = /Goal endpoint restoration failed without replacement/;
  const { server } = await fixture(t, { expectedDrainFailure: expected });
  const held = `${server.socketPath}.held`, foreignPath = `${server.socketPath}.foreign`;
  await rename(server.socketPath, held);
  const foreign = net.createServer();
  const originalRename = fsPromises.rename, originalLink = fsPromises.link;
  let injected = false;
  try {
    await new Promise((resolve, reject) => { foreign.once("error", reject); foreign.listen(foreignPath, resolve); });
    const identity = await lstat(foreignPath);
    await rename(foreignPath, server.socketPath);
    const occupy = async (from, to) => {
      if (!injected && String(from).includes(".goal-retired-") && to === server.socketPath) {
        injected = true;
        await writeFile(to, "second foreign owner", { flag: "wx", mode: 0o600 });
      }
    };
    t.mock.method(fsPromises, "rename", async (from, to) => {
      await occupy(from, to);
      return originalRename(from, to);
    });
    t.mock.method(fsPromises, "link", async (from, to) => {
      await occupy(from, to);
      return originalLink(from, to);
    });
    syncBuiltinESMExports();
    await assert.rejects(server.drain(), expected);
    assert.equal(injected, true);
    assert.equal(await readFile(server.socketPath, "utf8"), "second foreign owner");
    const directory = dirname(server.socketPath);
    const retained = (await readdir(directory)).filter(name => name.includes(".goal-retired-"));
    assert.equal(retained.length, 1);
    const preserved = await lstat(join(directory, retained[0]));
    assert.equal(preserved.dev, identity.dev);
    assert.equal(preserved.ino, identity.ino);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (foreign.listening)
      await new Promise((resolve, reject) => foreign.close(error => error ? reject(error) : resolve()));
  }
});
