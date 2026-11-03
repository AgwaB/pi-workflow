import test from "node:test";
import assert from "node:assert/strict";
import childProcess, { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { channel as diagnosticsChannel } from "node:diagnostics_channel";
import { constants } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import ssh2 from "ssh2";

import {
  assertGoalWorkspaceHostHandle,
  observeGoalWorkspaceOrigin,
  prepareGoalWorkspaceHost as preparePhysicalWorkspaceHost,
} from "../../.tmp/unit/goal-workspace-host.js";
import { GOAL_MAX_BYTES, goalHash } from "../../.tmp/unit/goal-json.js";
import {
  captureCommittedArtifactReadRoot,
  readCommittedArtifactPage,
} from "../../.tmp/unit/committed-artifact-read.js";
import {
  captureGoalNativeReadWitness,
  createGoalRequestBudget,
  openGoalCandidateToolChannel,
  openGoalRequestBudgetChannel,
  registerGoalCandidateTools,
  registerGoalRequestBudget,
} from "../../.tmp/unit/workflow-goal-workspace-tools.js";
import { openGoalAuthenticatedLocalSession } from "../../.tmp/unit/goal-authenticated-local-channel.js";

const exec = promisify(execFile);
const decode = (value) =>
  value === null ? null : Buffer.from(value.hex, "hex").toString();
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const encodeRawGoalFrame = (binding, identity, phase, payload) => {
  const frame = {
    version: 1,
    attemptKey: binding.attemptKey,
    channelId: binding.channelId,
    ...identity,
    phase,
    payload,
    digest: sha256(JSON.stringify(payload)),
  };
  const body = Buffer.from(JSON.stringify(frame));
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(body.length);
  return Buffer.concat([prefix, body]);
};

const rawGoalFrameReader = stream => {
  let buffer = Buffer.alloc(0);
  let failure;
  const waiters = [];
  const flush = () => {
    while (waiters.length && buffer.length >= 4) {
      const length = buffer.readUInt32BE(0);
      if (!length || length > 133_120) {
        failure = new Error("Raw Goal SSH frame length invalid");
        break;
      }
      if (buffer.length < length + 4) return;
      const body = buffer.subarray(4, length + 4);
      buffer = buffer.subarray(length + 4);
      waiters.shift().resolve(body);
    }
    if (failure) {
      while (waiters.length) waiters.shift().reject(failure);
    }
  };
  const fail = error => {
    failure ??= error;
    flush();
  };
  stream.on("data", chunk => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk);
    flush();
  });
  stream.on("error", fail);
  stream.on("end", () => fail(new Error("Raw Goal SSH stream ended")));
  stream.on("close", () => fail(new Error("Raw Goal SSH stream closed")));
  return () => {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      waiters.push({ resolve, reject });
      flush();
    });
  };
};

async function openRawGoalSession(binding) {
  const socket = net.createConnection({ path: binding.socketPath });
  const client = new ssh2.Client();
  let stream;
  try {
    await new Promise((resolve, reject) => {
      client.once("error", reject);
      socket.once("error", reject);
      client.once("ready", () => client.subsys("pi-workflow-goal-v1", (error, opened) => {
        if (error) reject(error);
        else {
          stream = opened;
          stream.on("error", () => {});
          resolve();
        }
      }));
      socket.once("connect", () => client.connect({
        sock: socket,
        username: "goal-local",
        password: binding.secret,
        authHandler: ["password"],
        algorithms: { serverHostKey: ["ssh-ed25519"] },
        hostVerifier: key => sha256(key) === binding.hostKeyPin,
      }));
    });
  } catch (error) {
    stream?.destroy();
    socket.destroy();
    client.end();
    throw error;
  }
  const read = rawGoalFrameReader(stream);
  let closed = false;
  const parse = async (identity, phase) => {
    const bytes = await read();
    const frame = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    assert.deepEqual(
      {
        version: frame.version,
        attemptKey: frame.attemptKey,
        channelId: frame.channelId,
        operationId: frame.operationId,
        fingerprint: frame.fingerprint,
        nonce: frame.nonce,
        phase: frame.phase,
      },
      { version: 1, attemptKey: binding.attemptKey, channelId: binding.channelId, ...identity, phase },
    );
    assert.equal(frame.digest, sha256(JSON.stringify(frame.payload)));
    assert.deepEqual(Buffer.from(JSON.stringify(frame)), bytes);
    return frame;
  };
  return {
    async begin(payload) {
      const identity = {
        operationId: payload.id,
        fingerprint: payload.commitment,
        nonce: randomBytes(24).toString("hex"),
      };
      stream.write(encodeRawGoalFrame(binding, identity, "request", payload));
      return { identity, result: await parse(identity, "result") };
    },
    sendAcknowledgement(exchange) {
      stream.write(encodeRawGoalFrame(binding, exchange.identity, "ack", {
        resultDigest: exchange.result.digest,
      }));
    },
    readSettlement(exchange) {
      return parse(exchange.identity, "settled");
    },
    async exchange(payload) {
      const exchange = await this.begin(payload);
      this.sendAcknowledgement(exchange);
      const settled = await this.readSettlement(exchange);
      assert.equal(settled.payload.status, "acknowledged");
      return exchange.result.payload;
    },
    async close() {
      if (closed) return;
      closed = true;
      const socketClosed = socket.destroyed
        ? Promise.resolve()
        : new Promise(resolve => socket.once("close", resolve));
      stream.destroy();
      socket.destroy();
      client.end();
      await socketClosed;
    },
  };
}

async function openRawNativeSettlementFixture(name, current) {
  const root = await mkdtemp(join(tmpdir(), "gnw-"));
  const evidenceRoot = join(root, "e");
  const budget = createGoalRequestBudget(1);
  let request;
  try {
    request = await openGoalRequestBudgetChannel({
      directory: join(root, "r"),
      evidenceRoot,
      identity: { test: name },
      attemptKey: name,
      model: "fixture/model",
      budget,
      current,
      live() {},
      stopped: new AbortController().signal,
      captureNativeReads: true,
    });
    const extension = await readFile(request.extensionPath, "utf8");
    const marker = "registerGoalRequestBudget(pi, ";
    const binding = JSON.parse(extension.slice(
      extension.indexOf(marker) + marker.length,
      extension.lastIndexOf(', "fixture/model", true);'),
    ));
    return { root, evidenceRoot, budget, request, binding };
  } catch (error) {
    await request?.drain().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function readOnlyRequestReceipt(evidenceRoot) {
  const names = await fsPromises.readdir(evidenceRoot);
  assert.equal(names.length, 1);
  return JSON.parse(await readFile(join(evidenceRoot, names[0]), "utf8"));
}

// Offline mechanics fixtures, not original issued callback authority.
// Artifact publication needs an explicit fixture owner even for read-only input.
const prepareGoalWorkspaceHost = async (request, guard) => {
  const stop = new AbortController();
  const artifactRoot = join(await realpath(dirname(request.originRoot)), `source-artifacts-${randomUUID()}`);
  return preparePhysicalWorkspaceHost({ ...request, artifactRoot }, guard ?? {
    assertCurrent: () => stop.signal.throwIfAborted(),
    assertLive: () => stop.signal.throwIfAborted(),
  });
};

test("materialization rejects a substituted workspace root before publishing into its sentinel namespace", async t => {
  const root = await realpath(await disposableRoot(t));
  const origin = join(root, "origin"), workspace = join(root, "workspace"), moved = join(root, "workspace-original");
  await mkdir(origin);
  await writeFile(join(origin, "input.txt"), "complete input");
  const originalLink = fsPromises.link;
  let substituted = false;
  fsPromises.link = async function(source, target, ...args) {
    if (!substituted && String(target) === join(workspace, "input.txt")) {
      substituted = true;
      await fsPromises.rename(workspace, moved);
      await mkdir(workspace);
      await writeFile(join(workspace, "sentinel"), "foreign");
    }
    return originalLink.call(this, source, target, ...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(prepareGoalWorkspaceHost({
      originRoot: origin, workspaceRoot: workspace, workspaceId: "root-substitution",
      mode: "mutation", repository: "nonGit", scope: ["input.txt"],
    }), error => {
      assert.ok(error instanceof AggregateError);
      assert.ok(error.errors.some(value => /ancestor changed|ENOENT/.test(value.message)));
      return true;
    });
    assert.equal(substituted, true);
    assert.equal(await readFile(join(workspace, "sentinel"), "utf8"), "foreign");
    assert.equal((await fsPromises.readdir(moved)).some(name => name.includes(".input.txt.goal-materialize-")), true);
  } finally {
    fsPromises.link = originalLink;
    syncBuiltinESMExports();
  }
});

test("materialization rejects a replaced target preimage without overwriting foreign bytes", async t => {
  const fixture = await gitFixture(t);
  const workspace = join(await realpath(fixture.workspaces), "preimage-replacement");
  const originalRename = fsPromises.rename;
  let replaced = false;
  fsPromises.rename = async function(source, target, ...args) {
    if (!replaced && String(source) === join(workspace, "a.txt") &&
        String(target).includes(".a.txt.goal-displaced-")) {
      replaced = true;
      await unlink(source);
      await writeFile(source, "foreign preimage");
    }
    return originalRename.call(this, source, target, ...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(prepareGoalWorkspaceHost({
      ...workspaceRequest(fixture, "preimage-replacement"), workspaceRoot: workspace,
    }), /target changed/);
    assert.equal(replaced, true);
    assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "foreign preimage");
  } finally {
    fsPromises.rename = originalRename;
    syncBuiltinESMExports();
  }
});

test("materialization exposes displaced recovery when final hard-link publication sees EEXIST", async t => {
  const fixture = await gitFixture(t);
  const workspace = join(await realpath(fixture.workspaces), "publication-eexist");
  const originalLink = fsPromises.link;
  let replaced = false, publications = 0;
  fsPromises.link = async function(source, target, ...args) {
    if (!replaced && String(source).includes(".a.txt.goal-materialize-") &&
        String(target) === join(workspace, "a.txt") && ++publications === 2) {
      replaced = true;
      await writeFile(target, "foreign preimage");
    }
    return originalLink.call(this, source, target, ...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(prepareGoalWorkspaceHost({
      ...workspaceRequest(fixture, "publication-eexist"), workspaceRoot: workspace,
    }), error => {
      assert.ok(error instanceof AggregateError);
      assert.ok(error.errors.some(value => /EEXIST/.test(value.message)));
      assert.ok(error.errors.some(value => /retained at/.test(value.message)));
      return true;
    });
    assert.equal(replaced, true);
    assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "foreign preimage");
  } finally {
    fsPromises.link = originalLink;
    syncBuiltinESMExports();
  }
});

test("foreign restoration preserves recovery location when restoration and descriptor close fail", async t => {
  const fixture = await gitFixture(t);
  const workspace = join(await realpath(fixture.workspaces), "foreign-close-failure");
  const targetPath = join(workspace, "a.txt");
  const originalRename = fsPromises.rename;
  const originalOpen = fsPromises.open;
  const originalLink = fsPromises.link;
  let displacedPath;
  fsPromises.rename = async function(source, target, ...args) {
    if (String(source) === targetPath && String(target).includes(".goal-displaced-")) {
      displacedPath = String(target);
      await unlink(source);
      await writeFile(source, "retained foreign bytes");
    }
    return originalRename.call(this, source, target, ...args);
  };
  fsPromises.open = async function(path, ...args) {
    const handle = await originalOpen.call(this, path, ...args);
    if (String(path) === displacedPath) {
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); throw new Error("fixture recovery descriptor close failure"); };
    }
    return handle;
  };
  fsPromises.link = async function(source, target, ...args) {
    if (String(source) === displacedPath && String(target) === targetPath)
      await writeFile(target, "concurrent destination", { flag: "wx" });
    return originalLink.call(this, source, target, ...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(prepareGoalWorkspaceHost({
      ...workspaceRequest(fixture, "foreign-close-failure"), workspaceRoot: workspace,
    }), error => {
      const messages = [];
      const visit = value => { messages.push(value.message); for (const child of value.errors ?? []) visit(child); };
      visit(error);
      assert.ok(messages.some(message => message.includes("target changed")));
      assert.ok(messages.some(message => message.includes("EEXIST")));
      assert.ok(messages.some(message => message.includes("fixture recovery descriptor close failure")));
      assert.ok(messages.some(message => message.includes(`retained at ${displacedPath}`)));
      return true;
    });
    assert.equal(await readFile(displacedPath, "utf8"), "retained foreign bytes");
    assert.equal(await readFile(targetPath, "utf8"), "concurrent destination");
  } finally {
    fsPromises.rename = originalRename;
    fsPromises.open = originalOpen;
    fsPromises.link = originalLink;
    syncBuiltinESMExports();
  }
});

test("nested materialization hard-links both absent and displaced targets", async t => {
  const fixture = await gitFixture(t);
  const workspace = join(fixture.workspaces, "nested-publication");
  await mkdir(join(fixture.origin, "nested"));
  await writeFile(join(fixture.origin, "nested", "a.txt"), "head nested");
  await git(fixture.origin, "add", "nested/a.txt");
  await git(fixture.origin, "commit", "-qm", "nested materialization fixture");
  await writeFile(join(fixture.origin, "nested", "a.txt"), "worktree nested");
  const handle = await prepareGoalWorkspaceHost({
    ...workspaceRequest(fixture, "nested-publication"), workspaceRoot: workspace,
    scope: ["nested/a.txt"], protectedPaths: [],
  });
  assert.equal(await readFile(join(workspace, "nested", "a.txt"), "utf8"), "worktree nested");
  assert.equal((await handle.cleanup()).status, "removed");
});

test("nested displaced cleanup failures retain the recovery proof", async t => {
  const fixture = await gitFixture(t);
  const workspace = join(fixture.workspaces, "nested-cleanup");
  await mkdir(join(fixture.origin, "nested"));
  await writeFile(join(fixture.origin, "nested", "a.txt"), "head nested");
  await git(fixture.origin, "add", "nested/a.txt");
  await git(fixture.origin, "commit", "-qm", "nested cleanup fixture");
  await writeFile(join(fixture.origin, "nested", "a.txt"), "worktree nested");
  const originalUnlink = fsPromises.unlink;
  let displaced;
  fsPromises.unlink = async function(path, ...args) {
    if (String(path).includes(".a.txt.goal-displaced-")) {
      displaced = String(path);
      const error = new Error("fixture displaced unlink failure");
      error.code = "EIO";
      throw error;
    }
    return originalUnlink.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(prepareGoalWorkspaceHost({
      ...workspaceRequest(fixture, "nested-cleanup"), workspaceRoot: workspace,
      scope: ["nested/a.txt"], protectedPaths: [],
    }), /retained at/);
    assert.ok(displaced);
    assert.equal(await readFile(join(workspace, "nested", "a.txt"), "utf8"), "worktree nested");
    assert.equal(await readFile(displaced, "utf8"), "head nested");
  } finally {
    fsPromises.unlink = originalUnlink;
    syncBuiltinESMExports();
  }
});

test("materialization surfaces an owned staging unlink fault without deleting the retained proof", async t => {
  const root = await realpath(await disposableRoot(t));
  const origin = join(root, "origin"), workspace = join(root, "workspace");
  await mkdir(origin);
  await writeFile(join(origin, "input.txt"), "complete input");
  const originalOpen = fsPromises.open, originalUnlink = fsPromises.unlink;
  let temporary;
  fsPromises.open = async function(path, ...args) {
    const file = await originalOpen.call(this, path, ...args);
    if (String(path).includes(".input.txt.goal-materialize-")) {
      temporary = String(path);
      file.write = async () => { throw new Error("fixture staging write failure"); };
    }
    return file;
  };
  fsPromises.unlink = async function(path, ...args) {
    if (String(path) === temporary) {
      const error = new Error("fixture staging unlink failure");
      error.code = "EIO";
      throw error;
    }
    return originalUnlink.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(prepareGoalWorkspaceHost({
      originRoot: origin, workspaceRoot: workspace, workspaceId: "unlink-fault",
      mode: "mutation", repository: "nonGit", scope: ["input.txt"],
    }), error => {
      assert.ok(error instanceof AggregateError);
      assert.ok(error.errors.some(value => /fixture staging write failure/.test(value.message)));
      assert.ok(error.errors.some(value => /fixture staging unlink failure/.test(value.message)));
      return true;
    });
    assert.ok(temporary);
    assert.equal((await fsPromises.lstat(temporary)).isFile(), true);
  } finally {
    fsPromises.open = originalOpen;
    fsPromises.unlink = originalUnlink;
    syncBuiltinESMExports();
  }
});

test("NONAUTHORITY preparation guard fences observation and retains partial creation without rollback", async t => {
  for (const stage of ["missing", "revoked", "origin-observation", "root-created", "seed-open", "parent-created"]) {
    await t.test(stage, async t => {
      const root = await realpath(await disposableRoot(t));
      const origin = join(root, "origin"), candidateRoot = join(root, "candidate");
      await mkdir(origin);
      await mkdir(join(origin, "nested"));
      await writeFile(join(origin, "nested/input.txt"), "original");
      const stop = new AbortController();
      if (stage === "revoked") stop.abort(new Error("fixture preparation stop"));
      const guard = {
        assertCurrent: () => stop.signal.throwIfAborted(),
        assertLive: () => stop.signal.throwIfAborted(),
      };
      const originalOpen = fsPromises.open, originalMkdir = fsPromises.mkdir;
      let caught = false;
      fsPromises.open = async function(path, ...args) {
        const file = await originalOpen.call(this, path, ...args);
        if ((stage === "origin-observation" && String(path) === join(origin, "nested/input.txt")) ||
            (stage === "seed-open" && String(path).startsWith(join(candidateRoot, "nested/.input.txt.goal-materialize-")))) {
          caught = true;
          stop.abort(new Error("fixture preparation stop"));
        }
        return file;
      };
      fsPromises.mkdir = async function(path, ...args) {
        const result = await originalMkdir.call(this, path, ...args);
        if ((stage === "root-created" && String(path) === candidateRoot) ||
            (stage === "parent-created" && String(path) === join(candidateRoot, "nested"))) {
          caught = true;
          stop.abort(new Error("fixture preparation stop"));
        }
        return result;
      };
      syncBuiltinESMExports();
      try {
        await assert.rejects(preparePhysicalWorkspaceHost({ originRoot: origin, workspaceRoot: candidateRoot,
          artifactRoot: join(root, "artifacts"),
          workspaceId: "preparation-guard", mode: "mutation", repository: "nonGit", scope: ["nested/input.txt"] },
          stage === "missing" ? undefined : guard), /guard unavailable|fixture preparation stop/);
        if (["missing", "revoked", "origin-observation"].includes(stage)) {
          await assert.rejects(fsPromises.lstat(candidateRoot), { code: "ENOENT" });
        } else {
          // Already dispatched creation remains until test-only teardown.
          assert.equal((await fsPromises.lstat(candidateRoot)).isDirectory(), true);
          await assert.rejects(fsPromises.lstat(join(candidateRoot, "nested/input.txt")), { code: "ENOENT" });
          if (stage === "root-created") assert.deepEqual(await fsPromises.readdir(candidateRoot), []);
        }
        if (!["missing", "revoked"].includes(stage)) assert.equal(caught, true);
        assert.equal(await readFile(join(origin, "nested/input.txt"), "utf8"), "original");
      } finally {
        fsPromises.open = originalOpen; fsPromises.mkdir = originalMkdir;
        syncBuiltinESMExports();
      }
    });
  }
});

test("NONAUTHORITY candidate guards fence awaited reads, absent creation and queued writes", async t => {
  for (const stage of ["live", "stat", "read", "absent", "parent", "queued", "post-create"]) {
    await t.test(stage, async t => {
      const root = await realpath(await disposableRoot(t));
      const origin = join(root, "origin"), candidateRoot = join(root, "candidate");
      await mkdir(origin);
      await writeFile(join(origin, "a.txt"), "original");
      await writeFile(join(origin, "protected.txt"), "protected");
      const stop = new AbortController();
      let checks = 0, release, entered, writingStarted = false;
      const ready = new Promise(resolve => { entered = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      const guard = {
        assertLive() { stop.signal.throwIfAborted(); },
        async assertCurrent() {
          stop.signal.throwIfAborted();
          if (!writingStarted) return;
          checks++;
          if ((stage === "absent" || stage === "parent") && checks === 3)
            stop.abort(new Error("stop before creation"));
          if (stage === "queued" && checks === 1) { entered(); await gate; }
          stop.signal.throwIfAborted();
        },
      };
      const host = await prepareGoalWorkspaceHost({ originRoot: origin, workspaceRoot: candidateRoot,
        workspaceId: "guard-regression", mode: "mutation", repository: "nonGit",
        scope: ["a.txt", "missing.txt", "nested/new.txt"], protectedPaths: ["protected.txt"] },
        guard);
      const before = await host.inspectCandidate();
      writingStarted = true;
      const originalOpen = fsPromises.open;
      fsPromises.open = async function(path, flags, ...args) {
        const file = await originalOpen.call(this, path, flags, ...args);
        if (String(path) === join(candidateRoot, "a.txt") && (flags & constants.O_RDWR) === constants.O_RDWR) {
          const method = stage === "stat" ? "stat" : stage === "read" ? "read" : null;
          if (method) {
            const original = file[method].bind(file);
            file[method] = async (...args) => {
              const value = await original(...args);
              stop.abort(new Error("stop after awaited descriptor observation"));
              return value;
            };
          }
        }
        if (stage === "post-create" && String(path) === join(candidateRoot, "missing.txt") &&
            (flags & constants.O_CREAT) !== 0)
          stop.abort(new Error("stop after admitted creation"));
        return file;
      };
      syncBuiltinESMExports();
      try {
        const path = stage === "parent" ? "nested/new.txt" :
          ["absent", "post-create"].includes(stage) ? "missing.txt" : "a.txt";
        const digest = goalHash(before.files.find(f => f.path === path).value);
        const writing = host.writeCandidate(path, digest, "live-write");
        if (stage === "live") {
          const result = await writing;
          assert.equal(decode(result.files.find(f => f.path === path).value), "live-write");
          const next = await host.inspectCandidate();
          await host.writeCandidate("nested/new.txt", goalHash(next.files.find(f => f.path === "nested/new.txt").value), "created-live");
          assert.equal(await readFile(join(candidateRoot, "nested/new.txt"), "utf8"), "created-live");
          for (const invalid of ["protected.txt", "../outside", join(root, "absolute")])
            await assert.rejects(host.writeCandidate(invalid, digest, "bad"), /manifest/);
          await symlink(join(origin, "a.txt"), join(candidateRoot, "missing.txt"));
          await assert.rejects(host.writeCandidate("missing.txt", goalHash(null), "bad"));
          await unlink(join(candidateRoot, "missing.txt"));
        } else if (stage === "queued") {
          const rejected = assert.rejects(writing, /stop/);
          await ready;
          const queued = assert.rejects(host.writeCandidate(path, digest, "queued"), /revoked/);
          stop.abort(new Error("queued stop")); release();
          await Promise.all([rejected, queued]);
          assert.deepEqual((await host.inspectCandidate()).files, before.files);
        } else {
          await assert.rejects(writing, /guard unavailable|stop/);
          if (stage === "post-create") {
            // O_CREAT was already dispatched. Retain the empty admitted effect;
            // no rollback or byte-unchanged claim for in-flight mutation.
            assert.equal(await readFile(join(candidateRoot, "missing.txt"), "utf8"), "");
          } else assert.deepEqual((await host.inspectCandidate()).files, before.files);
          if (stage === "parent") await assert.rejects(fsPromises.lstat(join(candidateRoot, "nested")), { code: "ENOENT" });
        }
        assert.equal(await readFile(join(origin, "a.txt"), "utf8"), "original");
        assert.equal(await readFile(join(origin, "protected.txt"), "utf8"), "protected");
        await assert.rejects(fsPromises.lstat(join(root, "outside")), { code: "ENOENT" });
      } finally {
        fsPromises.open = originalOpen; syncBuiltinESMExports();
        assert.equal((await host.cleanup()).status, "removed");
      }
    });
  }
});

async function git(cwd, ...args) {
  const result = await exec(
    "git",
    ["-c", "core.hooksPath=/dev/null", ...args],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
  return result.stdout.trim();
}

async function disposableRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "goal-workspace-host-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test("NONAUTHORITY metadata-only origin observations preserve whole bytes without publication authority", async t => {
  for (const repository of ["git", "nonGit"]) {
    await t.test(repository, async t => {
      const root = await realpath(await disposableRoot(t));
      const origin = join(root, "origin");
      await mkdir(origin);
      const original = Buffer.from("whole source λ🙂\n".repeat(12000));
      const current = Buffer.concat([original, Buffer.from("last-byte-tail")]);
      const source = join(origin, "input.txt");
      await writeFile(source, original);
      if (repository === "git") {
        await git(origin, "init", "-q");
        await git(origin, "config", "user.name", "Goal Test");
        await git(origin, "config", "user.email", "goal@example.invalid");
        await git(origin, "add", "input.txt");
        await git(origin, "commit", "-qm", "fixture");
      }
      await writeFile(source, current);
      const indexBefore = repository === "git" ? await readFile(join(origin, ".git", "index")) : null;
      const originalOpen = fsPromises.open;
      fsPromises.open = async function(path, flags, ...args) {
        assert.equal(flags & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT |
          constants.O_TRUNC | constants.O_APPEND), 0, "observation must not open a writable descriptor");
        return originalOpen.call(this, path, flags, ...args);
      };
      syncBuiltinESMExports();
      try {
        const observed = await observeGoalWorkspaceOrigin({ originRoot: origin, repository, scope: ["input.txt"] });
        assert.equal(observed.files[0].worktree.kind, "artifact");
        assert.equal(observed.files[0].worktree.bytes, current.length);
        assert.equal(observed.files[0].worktree.sha256, sha256(current));
        assert.equal(observed.files[0].worktree.lines, 12001);
        if (repository === "git") {
          assert.equal(observed.files[0].head.sha256, sha256(original));
          assert.equal(observed.files[0].index.sha256, sha256(original));
          assert.deepEqual(await readFile(join(origin, ".git", "index")), indexBefore);
        }
        assert.throws(() => assertGoalWorkspaceHostHandle(observed), /live Goal workspace host handle required/);
        assert.deepEqual(await fsPromises.readdir(root), ["origin"]);
        assert.deepEqual((await fsPromises.readdir(origin)).sort(),
          repository === "git" ? [".git", "input.txt"] : ["input.txt"]);
        assert.deepEqual(await readFile(source), current);
      } finally {
        fsPromises.open = originalOpen;
        syncBuiltinESMExports();
      }
    });
  }
  await t.test("protected drift remains a rejection without publication", async t => {
    const root = await realpath(await disposableRoot(t));
    await writeFile(join(root, "input.txt"), "original");
    await writeFile(join(root, "protected.txt"), "protected");
    const originalOpen = fsPromises.open;
    let reads = 0;
    fsPromises.open = async function(path, ...args) {
      const file = await originalOpen.call(this, path, ...args);
      if (String(path) === join(root, "input.txt") && ++reads === 2)
        await writeFile(join(root, "protected.txt"), "changed");
      return file;
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(observeGoalWorkspaceOrigin({
        originRoot: root, repository: "nonGit", scope: ["input.txt"], protectedPaths: ["protected.txt"],
      }), /protected input drifted/);
      assert.deepEqual((await fsPromises.readdir(root)).sort(), ["input.txt", "protected.txt"]);
    } finally {
      fsPromises.open = originalOpen;
      syncBuiltinESMExports();
    }
  });
});

test("NONAUTHORITY artifact publication retains its original parent and directory identity", async t => {
  for (const stage of ["parent-before-create", "parent-after-create", "root-after-create", "parent-during-source"]) {
    await t.test(stage, async t => {
      const root = await realpath(await disposableRoot(t));
      const origin = join(root, "origin"), parent = join(root, "evidence");
      const artifactRoot = join(parent, "artifacts");
      await mkdir(origin);
      await mkdir(parent);
      const bytes = Buffer.from("complete original source\n".repeat(900));
      await writeFile(join(origin, "input.txt"), bytes);
      const originalMkdir = fsPromises.mkdir, originalOpen = fsPromises.open;
      let replaced = false;
      const replaceParent = async () => {
        replaced = true;
        await fsPromises.rename(parent, join(root, "retained-original-parent"));
        await originalMkdir(parent);
        if (stage === "parent-during-source")
          await fsPromises.rename(join(root, "retained-original-parent", "artifacts"), artifactRoot);
        else if (stage !== "parent-before-create") await originalMkdir(artifactRoot);
      };
      fsPromises.mkdir = async function(path, ...args) {
        if (String(path) === artifactRoot && stage === "parent-before-create") await replaceParent();
        const result = await originalMkdir.call(this, path, ...args);
        if (String(path) === artifactRoot && stage === "parent-after-create") await replaceParent();
        return result;
      };
      fsPromises.open = async function(path, ...args) {
        const file = await originalOpen.call(this, path, ...args);
        if (String(path) === join(origin, "input.txt") && !replaced) {
          if (stage === "parent-during-source") await replaceParent();
          if (stage === "root-after-create") {
            replaced = true;
            await fsPromises.rename(artifactRoot, join(parent, "retained-original-root"));
            await originalMkdir(artifactRoot);
          }
        }
        return file;
      };
      syncBuiltinESMExports();
      try {
        await assert.rejects(preparePhysicalWorkspaceHost({
          originRoot: origin, artifactRoot, workspaceId: "publication-custody",
          mode: "read-only", repository: "nonGit", scope: ["input.txt"],
        }, { assertCurrent() {}, assertLive() {} }), /physical identity changed|ENOENT/);
        assert.equal(replaced, true);
        assert.deepEqual((await fsPromises.readdir(artifactRoot)).sort(),
          stage === "parent-during-source" ? ["source", "uploads"] : []);
        assert.deepEqual(await readFile(join(origin, "input.txt")), bytes);
      } finally {
        fsPromises.mkdir = originalMkdir;
        fsPromises.open = originalOpen;
        syncBuiltinESMExports();
      }
    });
  }
});

test("NONAUTHORITY bounded artifacts cover whole sources and staged replacements", async t => {
  const fixture = async (t, bytes, mode) => {
    const root = await realpath(await disposableRoot(t));
    const origin = join(root, "origin");
    await mkdir(origin);
    await writeFile(join(origin, "input.txt"), bytes);
    const stop = new AbortController();
    const handle = await preparePhysicalWorkspaceHost({
      originRoot: origin, workspaceRoot: join(root, "candidate"),
      artifactRoot: join(root, "artifacts"), workspaceId: "large-artifact-fixture",
      mode, repository: "nonGit", scope: ["input.txt"],
    }, {
      assertCurrent: async () => stop.signal.throwIfAborted(),
      assertLive: () => stop.signal.throwIfAborted(),
    });
    return { root, origin, stop, handle };
  };
  const collect = async (handle, expected) => {
    const chunks = [], cursors = new Set();
    let cursor;
    for (;;) {
      const result = await handle.readSourcePage("input.txt", cursor);
      const page = result.page;
      const bytes = Buffer.from(page.content, page.encoding === "utf8" ? "utf8" : "base64");
      assert.equal(result.artifact.sha256, sha256(expected));
      assert.equal(result.artifact.bytes, expected.length);
      assert.equal(bytes.length, page.returnedBytes);
      assert.ok(bytes.length > 0 && bytes.length <= 4096);
      if (page.encoding === "utf8") assert.ok(page.returnedLines <= 32);
      else assert.ok(page.content.length <= 8192);
      chunks.push(bytes);
      if (page.eof) { assert.equal(page.nextCursor, null); break; }
      assert.equal(typeof page.nextCursor, "string");
      assert.equal(cursors.has(page.nextCursor), false, "continuation cannot revisit the first page");
      cursors.add(page.nextCursor);
      assert.ok(cursors.size <= expected.length, "every page advances");
      cursor = page.nextCursor;
    }
    assert.deepEqual(Buffer.concat(chunks), expected, "all bytes, including the tail, remain accessible");
  };
  for (const [name, bytes] of [
    ["inline with many lines", Buffer.from("x\n".repeat(900))],
    ["large UTF8 and binary tail", Buffer.concat([Buffer.from("원문 Ω\n".repeat(1900)), Buffer.from([255, 0, 240])])],
  ]) await t.test(name, async t => {
    const f = await fixture(t, bytes, "read-only");
    assert.equal(f.handle.workspaceRoot, null);
    await collect(f.handle, bytes);
    await assert.rejects(f.handle.readSourcePage("input.txt", "forged"), /cursor/);
    assert.deepEqual(await readFile(join(f.origin, "input.txt")), bytes);
    f.stop.abort(new Error("fixture read revoked"));
    await assert.rejects(f.handle.readSourcePage("input.txt"), /revoked/);
  });
  for (const [name, character] of [["two-byte", "é"], ["three-byte", "한"], ["four-byte", "𐐷"]]) {
    await t.test(`UTF-8 character crossing a page boundary: ${name}`, async t => {
      const prefix = Buffer.from("a".repeat(4096 - Buffer.byteLength(character) + 1));
      const bytes = Buffer.concat([prefix, Buffer.from(character), Buffer.from(" 끝\n")]);
      const f = await fixture(t, bytes, "read-only");
      const pages = [];
      let cursor;
      for (;;) {
        const result = await f.handle.readSourcePage("input.txt", cursor);
        const page = result.page;
        assert.equal(page.encoding, "utf8");
        assert.equal(Buffer.byteLength(page.content, "utf8"), page.returnedBytes);
        assert.ok(page.returnedBytes > 0 && page.returnedBytes <= 4096);
        pages.push(Buffer.from(page.content, "utf8"));
        if (page.eof) {
          assert.equal(page.nextCursor, null);
          break;
        }
        cursor = page.nextCursor;
      }
      assert.deepEqual(Buffer.concat(pages), bytes);
      await collect(f.handle, bytes);
    });
  }
  await t.test("multi-page Korean text remains UTF-8", async t => {
    const bytes = Buffer.from("한국어 원문 경계 보존\n".repeat(1200));
    const f = await fixture(t, bytes, "read-only");
    let cursor;
    let pageCount = 0;
    const chunks = [];
    for (;;) {
      const page = (await f.handle.readSourcePage("input.txt", cursor)).page;
      assert.equal(page.encoding, "utf8");
      assert.ok(page.returnedLines <= 32);
      chunks.push(Buffer.from(page.content, "utf8"));
      pageCount += 1;
      if (page.eof) break;
      cursor = page.nextCursor;
    }
    assert.ok(pageCount > 2);
    assert.deepEqual(Buffer.concat(chunks), bytes);
    await collect(f.handle, bytes);
  });
  await t.test("BOM survives and malformed or truncated UTF-8 remains byte-exact base64", async t => {
    for (const [name, bytes] of [
      ["BOM", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("한글\n")])],
      ["illegal interior sequence", Buffer.from([0x61, 0xff, 0x62])],
      ["truncated EOF sequence", Buffer.from([0x61, 0xe2, 0x82])],
    ]) {
      await t.test(name, async t => {
        const f = await fixture(t, bytes, "read-only");
        const result = await f.handle.readSourcePage("input.txt");
        assert.equal(result.page.encoding, name === "BOM" ? "utf8" : "base64");
        assert.equal(Buffer.from(result.page.content, result.page.encoding === "utf8" ? "utf8" : "base64").equals(bytes), true);
        await collect(f.handle, bytes);
      });
    }
  });
  await t.test("distinct operation IDs, original replay and atomic commit", async t => {
    const original = Buffer.from("original line\n".repeat(1200));
    const replacement = Buffer.from("changed 원문\n".repeat(1800));
    const f = await fixture(t, original, "mutation");
    const before = await f.handle.inspectCandidate();
    assert.deepEqual(await f.handle.inspectCandidate(), before, "observation cannot churn artifact identity");
    const oldPage = await f.handle.readSourcePage("input.txt");
    const begin = { path: "input.txt", expectedDigest: goalHash(before.files[0].value),
      attemptKey: "attempt-1", operationId: "begin-1", bytes: replacement.length };
    const upload = await f.handle.beginCandidateReplacement(begin);
    assert.equal(upload.receivedBytes, 0);
    for (let offset = 0; offset < replacement.length; offset += 4096) {
      const bytes = replacement.subarray(offset, offset + 4096);
      const chunk = { path: "input.txt", uploadId: upload.uploadId, attemptKey: "attempt-1",
        operationId: `chunk-${offset}`, offset, hex: bytes.toString("hex") };
      const receipt = await f.handle.appendCandidateReplacement(chunk);
      assert.equal(receipt.receivedBytes, offset + bytes.length);
      assert.deepEqual(await f.handle.appendCandidateReplacement(chunk), receipt);
      const changed = Buffer.from(bytes); changed[0] ^= 1;
      await assert.rejects(f.handle.appendCandidateReplacement({ ...chunk, hex: changed.toString("hex") }), /replay changed/);
      assert.deepEqual(await readFile(join(f.handle.workspaceRoot, "input.txt")), original);
    }
    assert.deepEqual(await f.handle.beginCandidateReplacement(begin), upload, "begin replay retains its original receipt");
    const commit = { path: "input.txt", uploadId: upload.uploadId, attemptKey: "attempt-1", operationId: "commit-1" };
    await assert.rejects(f.handle.commitCandidateReplacement({ ...commit, attemptKey: "foreign" }), /foreign|stale/);
    const candidate = await f.handle.commitCandidateReplacement(commit);
    assert.deepEqual(await f.handle.commitCandidateReplacement(commit), candidate);
    assert.deepEqual(await readFile(join(f.handle.workspaceRoot, "input.txt")), replacement);
    assert.deepEqual(await readFile(join(f.origin, "input.txt")), original);
    await assert.rejects(f.handle.readSourcePage("input.txt", oldPage.page.nextCursor), /stale/);
    await collect(f.handle, replacement);
  });
  for (const drift of ["file", "directory", "hardlink", "mode", "after-open"]) {
    await t.test(`upload rejects original custody loss before append: ${drift}`, async t => {
      const original = Buffer.from("original\n".repeat(1200));
      const f = await fixture(t, original, "mutation");
      const before = await f.handle.inspectCandidate();
      const upload = await f.handle.beginCandidateReplacement({
        path: "input.txt", expectedDigest: goalHash(before.files[0].value),
        attemptKey: "attempt-1", operationId: "begin", bytes: 3,
      });
      const directory = join(f.root, "artifacts", "uploads");
      const staged = join(directory, upload.uploadId);
      const originalOpen = fsPromises.open;
      let intercepted = false;
      if (drift === "file") {
        await fsPromises.rename(staged, join(f.root, "retained-upload"));
        await writeFile(staged, "", { mode: 0o600 });
      } else if (drift === "directory") {
        const retained = join(f.root, "retained-uploads");
        await fsPromises.rename(directory, retained);
        await mkdir(directory, { mode: 0o700 });
        await fsPromises.rename(join(retained, upload.uploadId), staged);
      } else if (drift === "hardlink") {
        await fsPromises.link(staged, join(f.root, "upload-alias"));
      } else if (drift === "mode") {
        await fsPromises.chmod(staged, 0o644);
      } else {
        fsPromises.open = async function(path, flags, ...args) {
          const file = await originalOpen.call(this, path, flags, ...args);
          if (String(path) === staged && (flags & constants.O_APPEND) && !intercepted) {
            intercepted = true;
            await fsPromises.rename(staged, join(f.root, "retained-upload"));
            await writeFile(staged, "", { mode: 0o600 });
          }
          return file;
        };
        syncBuiltinESMExports();
      }
      const chunk = { path: "input.txt", uploadId: upload.uploadId, attemptKey: "attempt-1",
        operationId: "chunk", offset: 0, hex: Buffer.from("new").toString("hex") };
      try {
        await assert.rejects(f.handle.appendCandidateReplacement(chunk), /physical identity|version changed/);
      } finally {
        fsPromises.open = originalOpen;
        syncBuiltinESMExports();
      }
      if (drift === "after-open") {
        assert.equal(intercepted, true);
        assert.equal((await readFile(join(f.root, "retained-upload"))).length, 0);
      }
      assert.equal((await readFile(staged)).length, 0, "no append through a changed custody path");
      await assert.rejects(f.handle.appendCandidateReplacement(chunk), /uncertain outcome/);
      assert.deepEqual(await readFile(join(f.handle.workspaceRoot, "input.txt")), original);
      assert.deepEqual(await readFile(join(f.origin, "input.txt")), original);
    });
  }
  await t.test("staged bytes must match admitted chunks without a caller SHA", async t => {
    const original = Buffer.from("original\n".repeat(1200));
    const f = await fixture(t, original, "mutation");
    const before = await f.handle.inspectCandidate();
    const upload = await f.handle.beginCandidateReplacement({
      path: "input.txt", expectedDigest: goalHash(before.files[0].value), attemptKey: "attempt-1",
      operationId: "begin", bytes: 3,
    });
    await f.handle.appendCandidateReplacement({
      path: "input.txt", uploadId: upload.uploadId, attemptKey: "attempt-1",
      operationId: "chunk", offset: 0, hex: Buffer.from("new").toString("hex"),
    });
    await writeFile(join(f.root, "artifacts", "uploads", upload.uploadId), "bad");
    await assert.rejects(f.handle.commitCandidateReplacement({
      path: "input.txt", uploadId: upload.uploadId, attemptKey: "attempt-1", operationId: "commit",
    }), /physical identity or version changed/);
    assert.deepEqual(await readFile(join(f.handle.workspaceRoot, "input.txt")), original);
    assert.deepEqual(await readFile(join(f.origin, "input.txt")), original);
  });
  for (const stage of ["same-length-change", "hardlink", "short-write"]) {
    await t.test(`replacement copy retains admitted bytes: ${stage}`, async t => {
      const original = Buffer.from("original\n".repeat(1200));
      const replacement = Buffer.from("complete replacement\n".repeat(4500));
      const f = await fixture(t, original, "mutation");
      const before = await f.handle.inspectCandidate();
      const upload = await f.handle.beginCandidateReplacement({
        path: "input.txt", expectedDigest: goalHash(before.files[0].value),
        attemptKey: "attempt-1", operationId: "begin", bytes: replacement.length,
      });
      for (let offset = 0; offset < replacement.length; offset += 4096) {
        await f.handle.appendCandidateReplacement({
          path: "input.txt", uploadId: upload.uploadId, attemptKey: "attempt-1",
          operationId: `chunk-${offset}`, offset,
          hex: replacement.subarray(offset, offset + 4096).toString("hex"),
        });
      }
      const originalOpen = fsPromises.open;
      let intercepted = false, writes = 0;
      fsPromises.open = async function(path, ...args) {
        const file = await originalOpen.call(this, path, ...args);
        if (!intercepted && String(path).startsWith(join(f.handle.workspaceRoot, ".input.txt.goal-"))) {
          intercepted = true;
          const source = join(f.root, "artifacts", "uploads", upload.uploadId);
          if (stage === "same-length-change") await writeFile(source, Buffer.alloc(replacement.length, 88));
          else if (stage === "hardlink") await fsPromises.link(source, join(f.root, "upload-alias"));
          else {
            const write = file.write.bind(file);
            file.write = async (buffer, offset = 0, length = buffer.length - offset, position = null) => {
              writes++;
              return write(buffer, offset, Math.min(length, 137), position);
            };
          }
        }
        return file;
      };
      syncBuiltinESMExports();
      const commit = { path: "input.txt", uploadId: upload.uploadId,
        attemptKey: "attempt-1", operationId: "commit" };
      try {
        if (stage === "short-write") {
          await f.handle.commitCandidateReplacement(commit);
          assert.ok(writes > 2);
          assert.deepEqual(await readFile(join(f.handle.workspaceRoot, "input.txt")), replacement);
        } else {
          await assert.rejects(f.handle.commitCandidateReplacement(commit), /physical identity or version changed/);
          assert.deepEqual(await readFile(join(f.handle.workspaceRoot, "input.txt")), original);
          await assert.rejects(f.handle.commitCandidateReplacement(commit), /uncertain outcome/);
        }
        assert.equal(intercepted, true);
        assert.deepEqual(await readFile(join(f.origin, "input.txt")), original);
      } finally {
        fsPromises.open = originalOpen;
        syncBuiltinESMExports();
      }
    });
  }
});

test("NONAUTHORITY large replacement atomically creates an originally absent target", async t => {
  const root = await realpath(await disposableRoot(t));
  const origin = join(root, "origin");
  const workspaceRoot = join(root, "candidate");
  const artifactRoot = join(root, "artifacts");
  await mkdir(origin);
  const bytes = Buffer.from("new absent target\n".repeat(900));
  const host = await preparePhysicalWorkspaceHost({
    originRoot: origin, workspaceRoot, artifactRoot, workspaceId: "absent-large-upload",
    mode: "mutation", repository: "nonGit", scope: ["missing.txt"],
  }, { assertCurrent() {}, assertLive() {} });
  const before = await host.inspectCandidate();
  const upload = await host.beginCandidateReplacement({
    path: "missing.txt", expectedDigest: goalHash(before.files[0].value),
    attemptKey: "absent-attempt", operationId: "absent-begin", bytes: bytes.length,
  });
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    await host.appendCandidateReplacement({
      path: "missing.txt", uploadId: upload.uploadId, attemptKey: "absent-attempt",
      operationId: `absent-chunk-${offset}`, offset,
      hex: bytes.subarray(offset, offset + 4096).toString("hex"),
    });
  }
  await host.commitCandidateReplacement({
    path: "missing.txt", uploadId: upload.uploadId, attemptKey: "absent-attempt",
    operationId: "absent-commit",
  });
  assert.deepEqual(await readFile(join(workspaceRoot, "missing.txt")), bytes);
});

test("NONAUTHORITY rejects artifact storage that collides with origin inputs before publication", async t => {
  const root = await realpath(await disposableRoot(t));
  const origin = join(root, "origin");
  await mkdir(origin);
  await writeFile(join(origin, "input.txt"), "input");
  await assert.rejects(preparePhysicalWorkspaceHost({
    originRoot: origin, artifactRoot: join(origin, "input.txt"),
    workspaceId: "artifact-input-collision", mode: "read-only", repository: "nonGit",
    scope: ["input.txt"],
  }, { assertCurrent() {}, assertLive() {} }), /artifact root overlaps an origin input/);
  assert.equal(await readFile(join(origin, "input.txt"), "utf8"), "input");
});

async function gitFixture(t) {
  const root = await disposableRoot(t);
  const origin = join(root, "origin");
  const workspaces = join(root, "workspaces");
  const controls = join(root, "controls");
  await Promise.all([mkdir(origin), mkdir(workspaces), mkdir(controls)]);
  await git(origin, "init", "-q");
  await git(origin, "config", "user.name", "Goal Test");
  await git(origin, "config", "user.email", "goal@example.invalid");
  await writeFile(join(origin, "a.txt"), "head-a");
  await writeFile(join(origin, "stable.txt"), "stable");
  await writeFile(join(origin, "protected.txt"), "protected");
  await chmod(join(origin, "a.txt"), 0o644);
  await chmod(join(origin, "stable.txt"), 0o755);
  await chmod(join(origin, "protected.txt"), 0o644);
  await git(origin, "add", "a.txt", "stable.txt", "protected.txt");
  await git(origin, "commit", "-qm", "fixture");
  return { root, origin, workspaces, controls };
}

function workspaceRequest(fixture, suffix = "candidate") {
  return {
    originRoot: fixture.origin,
    workspaceRoot: join(fixture.workspaces, suffix),
    workspaceId: `workspace-${suffix}`,
    mode: "mutation",
    repository: "git",
    scope: ["a.txt", "missing.txt", "new.txt", "stable.txt"],
    protectedPaths: ["protected.txt"],
    controlRoots: [fixture.controls],
  };
}

async function withEnvironment(values, action) {
  const previous = new Map(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await action();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("NONAUTHORITY committed page failures close original descriptors and retain errors", async t => {
  for (const stage of ["file-open", "file-close", "read-and-close"]) {
    await t.test(stage, async t => {
      const root = await realpath(await disposableRoot(t));
      const source = join(root, "source");
      const bytes = Buffer.from("complete retained file");
      await writeFile(source, bytes, { mode: 0o600 });
      const info = await fsPromises.stat(root);
      const containmentRoot = await captureCommittedArtifactReadRoot({
        root, dev: info.dev, ino: info.ino, uid: info.uid,
      }, "fixture committed root");
      const originalOpen = fsPromises.open;
      const opened = [];
      let rootClosed = false;
      fsPromises.open = async function(path, ...args) {
        if (String(path) === source && stage === "file-open")
          throw new Error("fixture committed file open failure");
        const file = await originalOpen.call(this, path, ...args);
        const close = file.close.bind(file);
        opened.push(close);
        file.close = async () => {
          await close();
          if (String(path) === root) rootClosed = true;
          if (String(path) === source) throw new Error("fixture committed file close failure");
        };
        if (String(path) === source && stage === "read-and-close")
          file.read = async () => { throw new Error("fixture committed file read failure"); };
        return file;
      };
      syncBuiltinESMExports();
      try {
        await assert.rejects(readCommittedArtifactPage({
          path: source, containmentRoot, expectedSha256: sha256(bytes),
          expectedLength: bytes.length, offset: 0, maximumBytes: 4096, label: "fixture page",
        }), error => {
          if (stage === "file-open") {
            assert.match(error.message, /fixture committed file open failure/);
          } else {
            assert.ok(error instanceof AggregateError);
            assert.ok(error.errors.some(value => /fixture committed file close failure/.test(value.message)));
            if (stage === "read-and-close")
              assert.ok(error.errors.some(value => /fixture committed file read failure/.test(value.message)));
          }
          return true;
        });
        assert.equal(rootClosed, true);
      } finally {
        fsPromises.open = originalOpen;
        syncBuiltinESMExports();
        // Also retire leaked descriptors when this regression runs on old code.
        for (const close of opened) await close();
      }
    });
  }
});

test("NONAUTHORITY materialization uses committed source bytes and complete writes", async t => {
  for (const stage of ["same-length-change", "hardlink", "short-write", "corrupt-output", "dropped-output"]) {
    await t.test(stage, async t => {
      const root = await realpath(await disposableRoot(t));
      const origin = join(root, "origin"), artifactRoot = join(root, "artifacts");
      const workspaceRoot = join(root, "candidate");
      await mkdir(origin);
      const bytes = Buffer.from("complete materialized source\n".repeat(900));
      await writeFile(join(origin, "a.txt"), bytes);
      const originalOpen = fsPromises.open;
      let intercepted = false, writes = 0;
      fsPromises.open = async function(path, ...args) {
        const file = await originalOpen.call(this, path, ...args);
        if (String(path).startsWith(join(workspaceRoot, ".a.txt.goal-materialize-")) && !intercepted) {
          intercepted = true;
          const sources = await fsPromises.readdir(join(artifactRoot, "source"));
          assert.equal(sources.length, 1);
          const source = join(artifactRoot, "source", sources[0]);
          if (stage === "same-length-change") {
            await writeFile(source, Buffer.alloc(bytes.length, 88));
          } else if (stage === "hardlink") {
            await fsPromises.link(source, join(root, "alias"));
          } else {
            const write = file.write.bind(file);
            file.write = async (buffer, offset = 0, length = buffer.length - offset, position = null) => {
              writes++;
              if (stage === "corrupt-output") return write(Buffer.alloc(length, 88), 0, length, position);
              if (stage === "dropped-output") return { bytesWritten: length, buffer };
              return write(buffer, offset, Math.min(length, 137), position);
            };
          }
        }
        return file;
      };
      syncBuiltinESMExports();
      try {
        const pending = preparePhysicalWorkspaceHost({
          originRoot: origin, workspaceRoot, artifactRoot, workspaceId: "materialization-custody",
          mode: "mutation", repository: "nonGit", scope: ["a.txt"],
        }, { assertCurrent() {}, assertLive() {} });
        if (stage === "short-write") {
          await pending;
          assert.ok(writes > 1);
          assert.deepEqual(await readFile(join(workspaceRoot, "a.txt")), bytes);
        } else {
          await assert.rejects(pending, /bytes differ from retained commitment|exact private regular file|materialization output differs from retained commitment/);
          await assert.rejects(fsPromises.lstat(join(workspaceRoot, "a.txt")), { code: "ENOENT" });
        }
        assert.equal(intercepted, true);
        assert.deepEqual(await readFile(join(origin, "a.txt")), bytes);
      } finally {
        fsPromises.open = originalOpen;
        syncBuiltinESMExports();
      }
    });
  }
});

test("NONAUTHORITY Git stream preserves partial writes and original descriptor custody", async t => {
  for (const stage of ["partial-write", "replacement", "write-failure"]) {
    await t.test(stage, async t => {
      const fixture = await gitFixture(t);
      const bytes = Buffer.from("whole committed Git source\n".repeat(stage === "write-failure" ? 27000 : 900));
      await writeFile(join(fixture.origin, "a.txt"), bytes);
      await git(fixture.origin, "add", "a.txt");
      await git(fixture.origin, "commit", "-qm", "large source");
      const objectId = await git(fixture.origin, "rev-parse", "HEAD:a.txt");
      const artifactRoot = join(await realpath(fixture.root), "stream-artifacts");
      const target = join(artifactRoot, "source", goalHash({ objectId, version: "head:a.txt" }));
      const originalOpen = fsPromises.open;
      const originalSpawn = childProcess.spawn;
      let intercepted = false, writes = 0, substitutedPath;
      let blobChild, blobClosed = false;
      childProcess.spawn = function(command, args, options) {
        const child = originalSpawn.call(this, command, args, options);
        if (args.includes("cat-file")) {
          blobChild = child;
          child.once("close", () => { blobClosed = true; });
        }
        return child;
      };
      fsPromises.open = async function(path, ...args) {
        const file = await originalOpen.call(this, path, ...args);
        if (String(path).startsWith(`${target}.stage-`) && !intercepted) {
          intercepted = true;
          if (stage === "replacement") {
            await fsPromises.rename(path, `${path}.retained`);
            await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
            substitutedPath = path;
          } else if (stage === "write-failure") {
            file.write = async () => { throw new Error("fixture Git destination write failure"); };
          } else {
            const write = file.write.bind(file);
            file.write = async (buffer, offset = 0, length = buffer.length - offset, position = null) => {
              writes++;
              return write(buffer, offset, Math.min(length, 137), position);
            };
          }
        }
        return file;
      };
      syncBuiltinESMExports();
      try {
        const pending = preparePhysicalWorkspaceHost({
          ...workspaceRequest(fixture), artifactRoot, scope: ["a.txt"],
        }, { assertCurrent() {}, assertLive() {} });
        if (stage === "replacement") {
          await assert.rejects(pending, error => {
            assert.ok(error instanceof AggregateError);
            assert.ok(error.errors.some(value => /Git artifact descriptor changed/.test(value.message)));
            assert.ok(error.errors.some(value => /temporary staging descriptor changed/.test(value.message)));
            return true;
          });
          assert.equal(await readFile(substitutedPath, "utf8"), bytes.toString());
          await assert.rejects(readFile(target), { code: "ENOENT" });
        } else if (stage === "write-failure") {
          await assert.rejects(pending, /fixture Git destination write failure/);
          assert.ok(blobChild);
          assert.equal(blobClosed, true);
          assert.ok(blobChild.exitCode !== null || blobChild.signalCode !== null);
        } else {
          const host = await pending;
          assert.ok(writes > 1);
          assert.equal(host.baseline.origin.files[0].head.sha256, sha256(bytes));
          assert.deepEqual(await readFile(target), bytes);
          assert.deepEqual(await readFile(join(host.workspaceRoot, "a.txt")), bytes);
        }
        assert.equal(intercepted, true);
      } finally {
        fsPromises.open = originalOpen;
        childProcess.spawn = originalSpawn;
        syncBuiltinESMExports();
      }
    });
  }
});

test("real Git observation preserves HEAD/index/source bytes and reuses one dirty candidate", async (t) => {
  const fixture = await gitFixture(t);
  await writeFile(join(fixture.origin, "a.txt"), "staged-a");
  await git(fixture.origin, "add", "a.txt");
  await writeFile(join(fixture.origin, "a.txt"), "staged-plus-unstaged-a");
  await writeFile(join(fixture.origin, "new.txt"), "scoped-untracked");
  await chmod(join(fixture.origin, "new.txt"), 0o644);

  const sourceHeadBefore = await git(fixture.origin, "rev-parse", "HEAD");
  const sourceIndexBefore = await readFile(
    join(fixture.origin, ".git", "index"),
  );
  const sourceA = await readFile(join(fixture.origin, "a.txt"));
  const handle = await prepareGoalWorkspaceHost(workspaceRequest(fixture));
  assertGoalWorkspaceHostHandle(handle);
  assert.throws(
    () =>
      assertGoalWorkspaceHostHandle(
        structuredClone({ baseline: handle.baseline }),
      ),
    /live/,
  );
  assert.equal(Object.isFrozen(handle.baseline), true);
  assert.equal(Object.isFrozen(handle.baseline.origin.files[0]), true);
  assert.throws(
    () => handle.baseline.scope.push("caller-mutation.txt"),
    TypeError,
  );
  assert.throws(() => {
    handle.baseline.origin.files[0].worktree.hex = "00";
  }, TypeError);

  const byPath = Object.fromEntries(
    handle.baseline.origin.files.map((value) => [value.path, value]),
  );
  assert.equal(decode(byPath["a.txt"].head), "head-a");
  assert.equal(decode(byPath["a.txt"].index), "staged-a");
  assert.equal(decode(byPath["a.txt"].worktree), "staged-plus-unstaged-a");
  assert.equal(byPath["missing.txt"].head, null);
  assert.equal(byPath["missing.txt"].index, null);
  assert.equal(byPath["missing.txt"].worktree, null);
  assert.equal(decode(byPath["new.txt"].worktree), "scoped-untracked");
  assert.equal(byPath["stable.txt"].head.mode, "0755");
  assert.equal(byPath["stable.txt"].index.mode, "0755");
  assert.equal(byPath["stable.txt"].worktree.mode, "0755");
  assert.equal(
    await readFile(join(handle.workspaceRoot, "a.txt"), "utf8"),
    "staged-plus-unstaged-a",
  );
  assert.equal(
    await readFile(join(handle.workspaceRoot, "stable.txt"), "utf8"),
    "stable",
  );

  await writeFile(join(handle.workspaceRoot, "a.txt"), "goal-child-one");
  const first = await handle.inspectCandidate();
  await writeFile(join(handle.workspaceRoot, "new.txt"), "goal-child-two");
  const second = await handle.inspectCandidate();
  assert.equal(first.workspaceId, second.workspaceId);
  assert.equal(first.baselineHash, second.baselineHash);
  assert.equal(
    await realpath(handle.workspaceRoot),
    await realpath(workspaceRequest(fixture).workspaceRoot),
  );
  assert.equal(
    decode(second.files.find((value) => value.path === "a.txt").value),
    "goal-child-one",
  );
  assert.equal(
    decode(second.files.find((value) => value.path === "new.txt").value),
    "goal-child-two",
  );

  assert.equal(
    await git(fixture.origin, "rev-parse", "HEAD"),
    sourceHeadBefore,
  );
  assert.equal(
    sha256(await readFile(join(fixture.origin, ".git", "index"))),
    sha256(sourceIndexBefore),
  );
  assert.deepEqual(await readFile(join(fixture.origin, "a.txt")), sourceA);
  assert.equal((await handle.cleanup()).status, "removed");
});

test("Git host commands ignore ambient repository and config environment overrides", async (t) => {
  const fixture = await gitFixture(t);
  const decoy = join(fixture.root, "decoy.git");
  await mkdir(decoy);
  await git(decoy, "init", "--bare", "-q");
  await withEnvironment(
    {
      GIT_DIR: decoy,
      GIT_WORK_TREE: fixture.root,
      GIT_INDEX_FILE: join(fixture.root, "decoy-index"),
      GIT_COMMON_DIR: decoy,
      GIT_OBJECT_DIRECTORY: decoy,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: decoy,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.bare",
      GIT_CONFIG_VALUE_0: "true",
      GIT_CONFIG_PARAMETERS: "'core.bare'='true'",
      GIT_CONFIG_GLOBAL: join(fixture.root, "missing-global-config"),
      GIT_CEILING_DIRECTORIES: fixture.root,
    },
    async () => {
      const handle = await prepareGoalWorkspaceHost({
        ...workspaceRequest(fixture, "sanitized-env"),
        scope: ["a.txt"],
        protectedPaths: [],
      });
      assert.equal(decode(handle.baseline.origin.files[0].head), "head-a");
      assert.equal((await handle.cleanup()).status, "removed");
    },
  );
});

test("Git workspace creation uses no checkout filters/hooks and records raw scoped bytes", async (t) => {
  const fixture = await gitFixture(t);
  const marker = join(fixture.root, "untrusted-executed");
  const hook = join(fixture.origin, ".git", "hooks", "post-checkout");
  await writeFile(hook, `#!/bin/sh\necho hook > ${JSON.stringify(marker)}\n`);
  await chmod(hook, 0o755);
  await writeFile(
    join(fixture.origin, ".gitattributes"),
    "a.txt filter=goal-evil\n",
  );
  await git(fixture.origin, "add", ".gitattributes");
  await git(fixture.origin, "commit", "-qm", "attributes");
  await git(
    fixture.origin,
    "config",
    "filter.goal-evil.smudge",
    `sh -c 'echo filter > ${marker}; cat'`,
  );
  const request = { ...workspaceRequest(fixture), scope: ["a.txt"] };
  const handle = await prepareGoalWorkspaceHost(request);
  assert.equal(
    await readFile(join(handle.workspaceRoot, "a.txt"), "utf8"),
    "head-a",
  );
  await assert.rejects(readFile(marker), (error) => error.code === "ENOENT");
  assert.equal((await handle.cleanup()).status, "removed");
});

test("nested staged deletions do not leave empty candidate directories", async (t) => {
  const fixture = await gitFixture(t);
  const nested = join(fixture.origin, "nested");
  const deleted = join(nested, "deleted.txt");
  await mkdir(nested);
  await writeFile(deleted, "will-delete");
  await git(fixture.origin, "add", "nested/deleted.txt");
  await git(fixture.origin, "commit", "-qm", "nested fixture");
  await unlink(deleted);
  await git(fixture.origin, "add", "-u", "nested/deleted.txt");

  const handle = await prepareGoalWorkspaceHost({
    ...workspaceRequest(fixture, "nested-delete"),
    scope: ["nested/deleted.txt"],
    protectedPaths: [],
  });
  const baselineFile = handle.baseline.origin.files[0];
  assert.notEqual(baselineFile.head, null);
  assert.equal(baselineFile.index, null);
  assert.equal(baselineFile.worktree, null);
  const candidate = await handle.inspectCandidate();
  assert.equal(candidate.files[0].value, null);
  await assert.rejects(
    realpath(join(handle.workspaceRoot, "nested")),
    /ENOENT/,
  );
  assert.equal((await handle.cleanup()).status, "removed");
});

test("candidate inspection and cleanup are serialized on one workspace", async (t) => {
  const fixture = await gitFixture(t);
  const handle = await prepareGoalWorkspaceHost({
    ...workspaceRequest(fixture, "serialized"),
    scope: ["a.txt"],
    protectedPaths: [],
  });
  await writeFile(join(handle.workspaceRoot, "a.txt"), "serialized-candidate");
  const inspectionPromise = handle.inspectCandidate();
  const cleanupPromise = handle.cleanup();
  const [candidate, cleanup] = await Promise.all([
    inspectionPromise,
    cleanupPromise,
  ]);
  assert.equal(decode(candidate.files[0].value), "serialized-candidate");
  assert.equal(cleanup.status, "removed");
  await assert.rejects(handle.inspectCandidate(), /already cleaned/);
});

test("non-Git mutation uses explicit staging, declared absence, exact census, and no origin fallback", async (t) => {
  const root = await disposableRoot(t);
  const origin = join(root, "plain-origin");
  const workspaceParent = join(root, "staging");
  const controls = join(root, "controls");
  await Promise.all([mkdir(origin), mkdir(workspaceParent), mkdir(controls)]);
  await writeFile(join(origin, "input.txt"), "plain");
  await chmod(join(origin, "input.txt"), 0o644);
  const workspaceRoot = join(workspaceParent, "goal");
  const handle = await prepareGoalWorkspaceHost({
    originRoot: origin,
    workspaceRoot,
    workspaceId: "plain-workspace",
    mode: "mutation",
    repository: "nonGit",
    scope: ["absent.txt", "input.txt"],
    protectedPaths: [],
    controlRoots: [controls],
  });
  assert.notEqual(handle.workspaceRoot, origin);
  assert.equal(
    await readFile(join(workspaceRoot, "input.txt"), "utf8"),
    "plain",
  );
  await writeFile(join(workspaceRoot, "input.txt"), "candidate");
  const candidate = await handle.inspectCandidate();
  assert.equal(decode(candidate.files[1].value), "candidate");
  assert.equal(await readFile(join(origin, "input.txt"), "utf8"), "plain");
  assert.equal((await handle.cleanup()).status, "removed");
});

test("read-only creates no workspace and detects source drift", async (t) => {
  const root = await disposableRoot(t);
  const origin = join(root, "origin");
  await mkdir(origin);
  await writeFile(join(origin, "input.txt"), "before");
  await chmod(join(origin, "input.txt"), 0o644);
  const requestedWorkspace = join(root, "must-not-exist");
  const handle = await prepareGoalWorkspaceHost({
    originRoot: origin,
    workspaceRoot: requestedWorkspace,
    workspaceId: "read-only-workspace",
    mode: "read-only",
    repository: "nonGit",
    scope: ["input.txt"],
  });
  assert.equal(handle.workspaceRoot, null);
  assert.equal(
    decode((await handle.inspectCandidate()).files[0].value),
    "before",
  );
  await writeFile(join(origin, "input.txt"), "after");
  await assert.rejects(handle.inspectCandidate(), /drifted/);
  const cleanup = await handle.cleanup();
  assert.equal(cleanup.status, "retained");
  assert.match(cleanup.reason, /drifted/);
});

test("candidate control metadata changes fail closed", async (t) => {
  const fixture = await gitFixture(t);
  const handle = await prepareGoalWorkspaceHost({
    ...workspaceRequest(fixture, "control-metadata"),
    scope: ["a.txt"],
    protectedPaths: [],
  });
  await chmod(join(handle.workspaceRoot, ".git"), 0o600);
  await assert.rejects(
    handle.inspectCandidate(),
    /protected workspace control changed/,
  );
  assert.equal((await handle.cleanup()).status, "retained");
});

test("candidate census rejects extra files/directories and explicit cleanup retains uncertainty", async (t) => {
  const fixture = await gitFixture(t);
  const request = { ...workspaceRequest(fixture), scope: ["a.txt"] };
  const handle = await prepareGoalWorkspaceHost(request);
  await mkdir(join(handle.workspaceRoot, "extra"));
  await writeFile(join(handle.workspaceRoot, "extra", "write.txt"), "escape");
  await assert.rejects(handle.inspectCandidate(), /extra/);
  const retained = await handle.cleanup();
  assert.equal(retained.status, "retained");
  assert.match(retained.reason, /extra/);

  const boundedFixture = await gitFixture(t);
  const boundedHandle = await prepareGoalWorkspaceHost({
    ...workspaceRequest(boundedFixture, "bounded-census"),
    scope: ["a.txt"],
    protectedPaths: [],
  });
  const undeclared = join(boundedHandle.workspaceRoot, "undeclared");
  await mkdir(undeclared);
  await chmod(undeclared, 0o000);
  try {
    await assert.rejects(
      boundedHandle.inspectCandidate(),
      /extra directory rejected/,
    );
  } finally {
    await chmod(undeclared, 0o700);
    await rm(undeclared, { recursive: true, force: true });
  }
  assert.equal((await boundedHandle.cleanup()).status, "removed");
});

test("candidate census rejects symlink, hardlink, unsupported mode, and workspace index writes", async (t) => {
  await t.test("symlink", async (t) => {
    const fixture = await gitFixture(t);
    const handle = await prepareGoalWorkspaceHost({
      ...workspaceRequest(fixture),
      scope: ["a.txt"],
    });
    await unlink(join(handle.workspaceRoot, "a.txt"));
    await symlink(
      join(fixture.origin, "a.txt"),
      join(handle.workspaceRoot, "a.txt"),
    );
    await assert.rejects(handle.inspectCandidate(), /symlink|one-link/);
  });
  await t.test("hardlink", async (t) => {
    const fixture = await gitFixture(t);
    const handle = await prepareGoalWorkspaceHost({
      ...workspaceRequest(fixture),
      scope: ["a.txt"],
    });
    await link(
      join(handle.workspaceRoot, "a.txt"),
      join(fixture.root, "alias"),
    );
    await assert.rejects(handle.inspectCandidate(), /one-link/);
  });
  await t.test("mode", async (t) => {
    const fixture = await gitFixture(t);
    const handle = await prepareGoalWorkspaceHost({
      ...workspaceRequest(fixture),
      scope: ["a.txt"],
    });
    await chmod(join(handle.workspaceRoot, "a.txt"), 0o600);
    await assert.rejects(handle.inspectCandidate(), /mode/);
  });
  await t.test("index", async (t) => {
    const fixture = await gitFixture(t);
    const handle = await prepareGoalWorkspaceHost({
      ...workspaceRequest(fixture),
      scope: ["a.txt"],
    });
    await writeFile(join(handle.workspaceRoot, "a.txt"), "candidate");
    await git(handle.workspaceRoot, "add", "a.txt");
    await assert.rejects(handle.inspectCandidate(), /index changed/);
  });
});

test("source aliases and protected drift fail closed while large originals remain complete", async (t) => {
  await t.test("source symlink", async (t) => {
    const root = await disposableRoot(t);
    const origin = join(root, "origin");
    await mkdir(origin);
    await writeFile(join(root, "outside"), "outside");
    await symlink(join(root, "outside"), join(origin, "input.txt"));
    await assert.rejects(
      prepareGoalWorkspaceHost({
        originRoot: origin,
        workspaceRoot: join(root, "workspace"),
        workspaceId: "symlink-source",
        mode: "mutation",
        repository: "nonGit",
        scope: ["input.txt"],
      }),
      /one-link|regular|loop|symlink/i,
    );
  });
  await t.test("source hardlink", async (t) => {
    const root = await disposableRoot(t);
    const origin = join(root, "origin");
    await mkdir(origin);
    await writeFile(join(origin, "input.txt"), "linked");
    await link(join(origin, "input.txt"), join(root, "alias"));
    await assert.rejects(
      prepareGoalWorkspaceHost({
        originRoot: origin,
        workspaceRoot: join(root, "workspace"),
        workspaceId: "hardlink-source",
        mode: "mutation",
        repository: "nonGit",
        scope: ["input.txt"],
      }),
      /one-link/,
    );
  });
  await t.test("8192-byte inline bound uses a complete artifact", async (t) => {
    const root = await disposableRoot(t);
    const origin = join(root, "origin");
    await mkdir(origin);
    const bytes = Buffer.alloc(8193);
    await writeFile(join(origin, "input.txt"), bytes);
    const handle = await prepareGoalWorkspaceHost({
        originRoot: origin,
        workspaceRoot: join(root, "workspace"),
        workspaceId: "oversize-source",
        mode: "mutation",
        repository: "nonGit",
        scope: ["input.txt"],
      });
    const value = handle.baseline.origin.files[0].worktree;
    assert.equal(value.kind, "artifact");
    assert.equal(value.bytes, bytes.length);
    assert.equal(value.sha256, sha256(bytes));
    assert.deepEqual(await readFile(join(handle.workspaceRoot, "input.txt")), bytes);
  });
  await t.test("protected drift", async (t) => {
    const fixture = await gitFixture(t);
    const handle = await prepareGoalWorkspaceHost({
      ...workspaceRequest(fixture),
      scope: ["a.txt"],
    });
    await writeFile(join(fixture.origin, "protected.txt"), "changed");
    await assert.rejects(handle.inspectCandidate(), /protected input drifted/);
    assert.equal((await handle.cleanup()).status, "retained");
  });
});

test("non-Git mode fails closed when Git metadata is malformed", async (t) => {
  const root = await disposableRoot(t);
  const origin = join(root, "origin");
  await mkdir(origin);
  await writeFile(join(origin, ".git"), "gitdir: /does/not/exist\\n");
  await assert.rejects(
    prepareGoalWorkspaceHost({
      originRoot: origin,
      workspaceId: "malformed-git-control",
      mode: "read-only",
      repository: "nonGit",
      scope: ["input.txt"],
    }),
    /Git probe failed/,
  );
});

test("invalid nested workspace requests do not create parents before overlap checks", async (t) => {
  const fixture = await gitFixture(t);
  const missingParent = join(fixture.origin, "not-created", "candidate");
  await assert.rejects(
    prepareGoalWorkspaceHost({
      ...workspaceRequest(fixture, "unused"),
      workspaceRoot: missingParent,
      scope: ["a.txt"],
      protectedPaths: [],
    }),
    /ENOENT|workspace parent/,
  );
  await assert.rejects(realpath(join(fixture.origin, "not-created")), /ENOENT/);
});

test("unsafe/colliding scope, existing workspace, origin/control overlap, and repository-mode mismatch reject", async (t) => {
  const fixture = await gitFixture(t);
  for (const scope of [
    [".git/config"],
    [".pi/control"],
    ["A", "a"],
    ["a", "a/child"],
    ["../outside"],
  ]) {
    await assert.rejects(
      prepareGoalWorkspaceHost({
        ...workspaceRequest(fixture, `reject-${Math.random()}`),
        scope,
      }),
    );
  }
  const existing = join(fixture.workspaces, "existing");
  await mkdir(existing);
  await assert.rejects(
    prepareGoalWorkspaceHost({
      ...workspaceRequest(fixture),
      workspaceRoot: existing,
    }),
    /initially absent/,
  );
  await assert.rejects(
    prepareGoalWorkspaceHost({
      ...workspaceRequest(fixture),
      workspaceRoot: join(fixture.origin, "nested"),
    }),
    /separate/,
  );
  await assert.rejects(
    prepareGoalWorkspaceHost({
      ...workspaceRequest(fixture),
      workspaceRoot: join(fixture.controls, "nested"),
    }),
    /control root/,
  );
  await assert.rejects(
    prepareGoalWorkspaceHost({
      ...workspaceRequest(fixture),
      repository: "nonGit",
    }),
    /refuses a Git origin/,
  );
});

test("registered candidate read batches authenticated pages without changing the one-page wire request", async t => {
  const root = await disposableRoot(t);
  const origin = join(root, "origin");
  await mkdir(origin);
  const source = Buffer.from("0123456789abcdef".repeat(5_717) + "x", "utf8");
  const largerSource = Buffer.from("abcdefghijklmnop".repeat(10_632) + "123456789abcdef", "utf8");
  assert.equal(source.length, 91_473);
  assert.equal(largerSource.length, 170_127);
  await writeFile(join(origin, "input.txt"), source);
  await writeFile(join(origin, "large.bin"), largerSource);
  const workspace = await prepareGoalWorkspaceHost({
    originRoot: origin, workspaceRoot: join(root, "workspace"), workspaceId: "paged-read",
    mode: "read-only", repository: "nonGit", scope: ["input.txt", "large.bin"],
  });
  const stopped = new AbortController();
  const order = [];
  let channelAlias;
  let mutateAfterFirstBatchAck = false;
  let foreignRequests = 0;
  const observer = diagnosticsChannel("pi-workflow:goal-candidate-request");
  const onReceived = event => {
    if (event.phase === "received" && event.attemptKey === "paging-attempt")
      order.push({ phase: "request", toolCallId: event.toolCallId, fingerprint: event.fingerprint });
    if (event.phase === "received" && event.attemptKey === "paging-foreign") foreignRequests++;
  };
  observer.subscribe(onReceived);
  const opened = await openGoalCandidateToolChannel({
    directory: join(root, "channel"), evidenceRoot: join(root, "evidence"), identity: { test: "paging" },
    attemptKey: "paging-attempt", workspace, tools: ["goal_candidate_read"],
    sourceProgress: {
      resolve: (_path, cursor) => cursor === "" ? undefined : cursor,
      settle: receipt => {
        order.push({ phase: "ack", cursor: receipt.cursor, nextCursor: receipt.nextCursor });
        if (mutateAfterFirstBatchAck) {
          mutateAfterFirstBatchAck = false;
          Object.assign(channelAlias, foreign.channel);
        }
      },
      handoff: () => [], invalidate: () => {},
    },
    assertCurrent: async () => "paging-authority", assertLive: () => {}, stopped: stopped.signal,
  });
  const foreign = await openGoalCandidateToolChannel({
    directory: join(root, "foreign-channel"), evidenceRoot: join(root, "foreign-evidence"), identity: { test: "paging-foreign" },
    attemptKey: "paging-foreign", workspace, tools: ["goal_candidate_read"],
    assertCurrent: async () => "paging-authority", assertLive: () => {}, stopped: stopped.signal,
  });
  channelAlias = { ...opened.channel, tools: [...opened.channel.tools] };
  t.after(async () => {
    observer.unsubscribe(onReceived);
    await foreign.drain().catch(() => undefined);
    await opened.drain().catch(() => undefined);
    await workspace.cleanup();
  });
  const registrations = new Map();
  registerGoalCandidateTools({
    registerTool(tool) { registrations.set(tool.name, tool); },
    setActiveTools() {}, on() {},
  }, channelAlias);
  const read = registrations.get("goal_candidate_read");
  const one = await read.execute("one-page", { path: "input.txt" });
  const explicitOne = await read.execute("explicit-one", { path: "input.txt", maxPages: 1 });
  assert.equal(one.details.status, "ok");
  assert.equal(explicitOne.details.status, "ok");
  assert.deepEqual(one.details.page, explicitOne.details.page);
  const oneFingerprints = order.filter(value => value.phase === "request" &&
    ["one-page", "explicit-one"].includes(value.toolCallId)).map(value => value.fingerprint);
  assert.equal(oneFingerprints.length, 2);
  assert.equal(oneFingerprints[0], oneFingerprints[1]);
  mutateAfterFirstBatchAck = true;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const batchTimers = new Set();
  const disposedBatchTimers = new Set();
  globalThis.setTimeout = function(callback, delay, ...args) {
    const timer = originalSetTimeout(callback, delay, ...args);
    if (delay === 30_000 && String(callback).includes("Goal candidate batch timed out")) batchTimers.add(timer);
    return timer;
  };
  globalThis.clearTimeout = function(timer) {
    if (batchTimers.has(timer)) disposedBatchTimers.add(timer);
    return originalClearTimeout(timer);
  };
  let batch;
  try {
    batch = await read.execute("thirty-two-pages", { path: "input.txt", maxPages: 32 });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
  assert.equal(batchTimers.size, 1);
  assert.equal(disposedBatchTimers.size, 1);
  assert.equal(foreignRequests, 0);
  Object.assign(channelAlias, opened.channel);
  assert.equal(batch.details.schema, "goal-candidate-read-batch-v1");
  assert.equal(batch.details.eof, true);
  assert.ok(batch.details.returnedPages > 2);
  assert.equal(batch.details.pages.every(value => value.sourceEvidence === undefined), true);
  assert.ok(batch.details.sourceReceiptIdentity,
    "the batch retains its acknowledged shared receipt identity exactly once");
  assert.deepEqual(Object.keys(batch.details.sourceReceiptIdentity).sort(),
    ["expectedDigest", "path", "sourceDigest"]);
  assert.ok(batch.details.pages.every(value => value.sourceReceipt.path === undefined &&
    value.sourceReceipt.expectedDigest === undefined && value.sourceReceipt.sourceDigest === undefined &&
    value.sourceReceipt.content === undefined && value.sourceReceipt.encoding === undefined));
  const settledReceipts = await Promise.all(batch.details.pages.map(async value => {
    const evidence = JSON.parse(await readFile(value.sourceReceipt.evidenceRef, "utf8"));
    assert.equal(evidence.phase, "settled");
    return evidence.result.sourceReceipt;
  }));
  assert.deepEqual(batch.details.pages.map(value => ({
    ...(value.sourceReceiptIdentity ?? batch.details.sourceReceiptIdentity), ...value.sourceReceipt,
  })), settledReceipts);
  const factoredReceiptBytes = Buffer.byteLength(JSON.stringify({
    sourceReceiptIdentity: batch.details.sourceReceiptIdentity, pages: batch.details.pages,
  }));
  const repeatedReceiptBytes = Buffer.byteLength(JSON.stringify({ pages: batch.details.pages.map(value => ({
    ...value,
    sourceReceipt: { ...batch.details.sourceReceiptIdentity, ...value.sourceReceipt },
  })) }));
  assert.ok(factoredReceiptBytes < repeatedReceiptBytes);
  const requests = order.map((value, index) => ({ ...value, index })).filter(value => value.phase === "request");
  for (let index = 1; index < requests.length; index++)
    assert.ok(order.slice(requests[index - 1].index + 1, requests[index].index).some(value => value.phase === "ack"),
      "each later authenticated request follows a settled ACK");
  assert.ok(requests.some(value => value.toolCallId.startsWith("goal-candidate-read-page-")));
  assert.deepEqual(Buffer.concat(batch.details.pages.map(value =>
    Buffer.from(value.page.content, value.page.encoding))), source);
  const largePages = [];
  let cursor;
  for (let call = 0; call < 4; call++) {
    const result = await read.execute(`large-${call}`, {
      path: "large.bin", ...(cursor === undefined ? {} : { cursor }), maxPages: 32,
    });
    largePages.push(...result.details.pages);
    if (result.details.eof) break;
    assert.equal(result.details.status, "partial");
    assert.notEqual(result.details.nextCursor, null);
    cursor = result.details.nextCursor;
  }
  assert.ok(largePages.length > 32);
  assert.equal(largePages.at(-1).page.eof, true);
  assert.deepEqual(Buffer.concat(largePages.map(value =>
    Buffer.from(value.page.content, value.page.encoding))), largerSource);
  assert.deepEqual(read.parameters.properties.maxPages, { type: "integer", minimum: 1, maximum: 32 });
});

test("registered candidate read paging preserves authenticated identity, negative checks, and pre-intent denial", async t => {
  const root = await disposableRoot(t);
  const origin = join(root, "origin");
  await mkdir(origin);
  await writeFile(join(origin, "readable.txt"), "x".repeat(20_000));
  const workspace = await prepareGoalWorkspaceHost({
    originRoot: origin, workspaceRoot: join(root, "workspace"), workspaceId: "paging-negatives",
    mode: "mutation", repository: "nonGit", scope: ["missing.txt", "readable.txt"],
  });
  let authority = "current";
  const acknowledgedCursors = new Set();
  const stopped = new AbortController();
  const received = [];
  const observer = diagnosticsChannel("pi-workflow:goal-candidate-request");
  const onReceived = event => {
    if (event.phase === "received" && event.attemptKey === "paging-negatives")
      received.push(event);
  };
  observer.subscribe(onReceived);
  const opened = await openGoalCandidateToolChannel({
    directory: join(root, "channel"), evidenceRoot: join(root, "evidence"), identity: { test: "paging-negatives" },
    attemptKey: "paging-negatives", workspace, tools: ["goal_candidate_read", "goal_candidate_write"],
    sourceProgress: {
      resolve: (_path, cursor) => {
        if (cursor !== undefined && cursor !== "" && !acknowledgedCursors.has(cursor))
          throw new Error("cursor lacks an original acknowledged source receipt");
        return cursor === "" ? undefined : cursor;
      },
      settle: receipt => { if (receipt.nextCursor) acknowledgedCursors.add(receipt.nextCursor); },
      handoff: () => [], invalidate: () => acknowledgedCursors.clear(),
    },
    assertCurrent: async () => authority, assertLive: () => {}, stopped: stopped.signal,
  });
  t.after(async () => {
    observer.unsubscribe(onReceived);
    await opened.drain().catch(() => undefined);
    await workspace.cleanup();
  });
  const registrations = new Map();
  registerGoalCandidateTools({ registerTool(tool) { registrations.set(tool.name, tool); }, setActiveTools() {}, on() {} },
    opened.channel);
  const read = registrations.get("goal_candidate_read");
  for (const [id, maxPages] of [["zero", 0], ["thirty-three", 33], ["text", "2"], ["array", [2]]]) {
    const result = await read.execute(id, { path: "readable.txt", maxPages });
    assert.equal(result.details.status, "blocked");
    assert.equal(result.details.denial, true);
  }
  const beforeFraction = received.length;
  await assert.rejects(read.execute("fraction", { path: "readable.txt", maxPages: 1.5 }),
    /Goal JSON non-data value/);
  assert.equal(received.length, beforeFraction, "strict authority JSON rejects fractional counters before transmission");
  const two = await read.execute("same-id", { path: "readable.txt", maxPages: 2 });
  assert.equal(two.details.requestedPages, 2);
  assert.equal(two.details.returnedPages, 2);
  assert.equal(two.details.status, "partial");
  const firstReplaySequence = received.filter(event => event.toolCallId === "same-id" ||
    event.toolCallId.startsWith("goal-candidate-read-page-")).map(event => event.toolCallId);
  assert.equal(firstReplaySequence[0], "same-id");
  assert.ok(firstReplaySequence.slice(1).every(toolCallId => toolCallId.startsWith("goal-candidate-read-page-")));
  const replayBoundary = received.length;
  const replay = await read.execute("same-id", { path: "readable.txt", maxPages: 2 });
  assert.deepEqual(replay.details, two.details);
  assert.deepEqual(received.slice(replayBoundary).map(event => event.toolCallId), firstReplaySequence);
  for (const changed of [
    { path: "readable.txt", maxPages: 3 },
    { path: "readable.txt", cursor: "", maxPages: 2 },
    { path: "outside.txt", maxPages: 2 },
  ]) {
    const changedBoundary = received.length;
    const result = await read.execute("same-id", changed);
    assert.equal(result.details.status, "blocked");
    assert.equal(result.details.denial, true);
    assert.deepEqual(received.slice(changedBoundary).map(event => event.toolCallId), ["same-id"]);
  }
  const forged = await read.execute("forged", { path: "readable.txt", cursor: "forged", maxPages: 2 });
  assert.equal(forged.details.status, "blocked");
  assert.equal(forged.details.denial, true);
  const beforeMissing = received.length;
  const absent = await read.execute("missing", { path: "missing.txt", maxPages: 2 });
  assert.equal(absent.details.status, "ok");
  assert.equal(absent.details.artifact, null);
  assert.equal(absent.details.sourceAbsent, true);
  assert.equal(absent.details.sourceReceipt, undefined);
  assert.equal(absent.details.sourceReceiptIdentity, undefined);
  assert.equal(absent.details.pages.length, 1);
  assert.equal(absent.details.pages[0].page.eof, true);
  assert.equal(absent.details.eof, true);
  assert.equal(received.length, beforeMissing + 1);
  const outOfScope = await read.execute("out-of-scope", { path: "outside.txt", maxPages: 2 });
  assert.equal(outOfScope.details.status, "blocked");
  assert.equal(outOfScope.details.denial, true);
  const mutable = { path: "readable.txt", maxPages: 2 };
  const mutation = read.execute("immutable-input", mutable);
  mutable.path = "missing.txt";
  const immutable = await mutation;
  assert.equal(immutable.details.returnedPages, 2);
  assert.equal(immutable.details.path, "readable.txt");
  const candidate = await workspace.inspectCandidate();
  const sourceFile = candidate.files.find(file => file.path === "readable.txt");
  const write = registrations.get("goal_candidate_write");
  const begun = await write.execute("replace-readable-begin", { path: "readable.txt", operation: "begin",
    expectedDigest: goalHash(sourceFile.value), bytes: Buffer.byteLength("replacement") });
  assert.equal(begun.details.status, "ok");
  const chunk = await write.execute("replace-readable-chunk", { path: "readable.txt", operation: "chunk",
    uploadId: begun.details.uploadId, offset: 0, encoding: "utf8", content: "replacement" });
  assert.equal(chunk.details.status, "ok");
  const replacement = await write.execute("replace-readable-commit",
    { path: "readable.txt", operation: "commit", uploadId: begun.details.uploadId });
  assert.equal(replacement.details.status, "ok");
  assert.equal(acknowledgedCursors.size, 0, "the real write ACK invalidates the original read epoch");
  const staleCursor = two.details.nextCursor;
  const stale = await read.execute("stale", { path: "readable.txt", cursor: staleCursor, maxPages: 2 });
  assert.equal(stale.details.status, "blocked");
  assert.equal(stale.details.denial, true);
  authority = "revoked";
  const revoked = await read.execute("revoked", { path: "readable.txt", maxPages: 2 });
  assert.equal(revoked.details.status, "blocked");
  assert.equal(revoked.details.denial, true);
  assert.ok(received.length >= 3);
});

test("registered candidate paging reserves JSON aggregate capacity before an unseen control-heavy page", async t => {
  const root = await disposableRoot(t);
  const origin = join(root, "origin");
  await mkdir(origin);
  await writeFile(join(origin, "controls.bin"), Buffer.alloc(200_000, 0));
  await writeFile(join(origin, "utf8.txt"), "é€😀".repeat(4_000));
  await writeFile(join(origin, "binary.bin"), Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x61]).subarray(0));
  const workspace = await prepareGoalWorkspaceHost({
    originRoot: origin, workspaceRoot: join(root, "workspace"), workspaceId: "paging-budget",
    mode: "read-only", repository: "nonGit", scope: ["binary.bin", "controls.bin", "utf8.txt"],
  });
  const stopped = new AbortController();
  const received = [];
  const observer = diagnosticsChannel("pi-workflow:goal-candidate-request");
  const onReceived = event => {
    if (event.phase === "received" && event.attemptKey === "paging-budget") received.push(event);
  };
  observer.subscribe(onReceived);
  const opened = await openGoalCandidateToolChannel({
    directory: join(root, "channel"), evidenceRoot: join(root, "evidence"), identity: { test: "paging-budget" },
    attemptKey: "paging-budget", workspace, tools: ["goal_candidate_read"],
    assertCurrent: async () => "budget", assertLive: () => {}, stopped: stopped.signal,
  });
  t.after(async () => {
    observer.unsubscribe(onReceived);
    await opened.drain().catch(() => undefined);
    await workspace.cleanup();
  });
  const registrations = new Map();
  registerGoalCandidateTools({ registerTool(tool) { registrations.set(tool.name, tool); }, setActiveTools() {}, on() {} },
    opened.channel);
  const result = await registrations.get("goal_candidate_read").execute("controls", { path: "controls.bin", maxPages: 32 });
  assert.equal(result.details.status, "partial");
  assert.equal(result.details.stopReason, "aggregate-limit");
  assert.equal(result.details.eof, false);
  assert.equal(received.length, result.details.returnedPages);
  assert.ok(Buffer.byteLength(JSON.stringify(result.details), "utf8") <= GOAL_MAX_BYTES);
  assert.ok(result.details.pages.every(value => value.page.returnedBytes <= 4096 && value.page.returnedLines <= 32));
  const utf8 = await registrations.get("goal_candidate_read").execute("utf8", { path: "utf8.txt", maxPages: 2 });
  const binary = await registrations.get("goal_candidate_read").execute("binary", { path: "binary.bin", maxPages: 2 });
  assert.equal(utf8.details.pages[0].page.encoding, "utf8");
  assert.equal(binary.details.pages[0].page.encoding, "base64");
  assert.ok(Buffer.byteLength(JSON.stringify(utf8.details), "utf8") <= GOAL_MAX_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(binary.details), "utf8") <= GOAL_MAX_BYTES);
});

test("registered candidate paging retains only acknowledged history on abort, revocation, and source drift", async t => {
  const root = await disposableRoot(t);
  const origin = join(root, "origin");
  await mkdir(origin);
  await writeFile(join(origin, "source.txt"), "abcdefghijklmnop".repeat(4_000));
  const workspace = await prepareGoalWorkspaceHost({
    originRoot: origin, workspaceRoot: join(root, "workspace"), workspaceId: "paging-terminal",
    mode: "read-only", repository: "nonGit", scope: ["source.txt"],
  });
  let authority = "terminal";
  let settleAction;
  let abortAfterSentSecond;
  const stopped = new AbortController();
  const received = [];
  const observer = diagnosticsChannel("pi-workflow:goal-candidate-request");
  const onReceived = event => {
    if (event.phase !== "received" ||
        !["paging-terminal", "paging-between-abort", "paging-unknown", "paging-drift"].includes(event.attemptKey)) return;
    received.push(event);
    if (abortAfterSentSecond && event.toolCallId.startsWith("goal-candidate-read-page-")) {
      const abort = abortAfterSentSecond;
      abortAfterSentSecond = undefined;
      abort.abort(new Error("test sent request acknowledgement loss"));
    }
  };
  observer.subscribe(onReceived);
  const opened = await openGoalCandidateToolChannel({
    directory: join(root, "channel"), evidenceRoot: join(root, "evidence"), identity: { test: "paging-terminal" },
    attemptKey: "paging-terminal", workspace, tools: ["goal_candidate_read"],
    sourceProgress: {
      resolve: (_path, cursor) => cursor === "" ? undefined : cursor,
      settle: receipt => settleAction?.(receipt), handoff: () => [], invalidate: () => {},
    },
    assertCurrent: async () => authority, assertLive: () => {}, stopped: stopped.signal,
  });
  t.after(async () => {
    observer.unsubscribe(onReceived);
    await opened.drain().catch(() => undefined);
    await workspace.cleanup();
  });
  const registrations = new Map();
  registerGoalCandidateTools({ registerTool(tool) { registrations.set(tool.name, tool); }, setActiveTools() {}, on() {} },
    opened.channel);
  const read = registrations.get("goal_candidate_read");
  const preIntentAbort = new AbortController();
  preIntentAbort.abort(new Error("test pre-intent abort"));
  const beforePreIntentAbort = received.length;
  await assert.rejects(read.execute("abort-before-first", { path: "source.txt", maxPages: 32 }, preIntentAbort.signal),
    /test pre-intent abort/);
  assert.equal(received.length, beforePreIntentAbort);
  settleAction = () => { authority = "revoked"; };
  const beforeRevocation = received.length;
  const revoked = await read.execute("revocation-after-ack", { path: "source.txt", maxPages: 32 });
  assert.equal(revoked.details.status, "blocked");
  assert.equal(revoked.details.denial, true);
  assert.equal(revoked.details.returnedPages, 1);
  assert.equal(received.length, beforeRevocation + 2);
  authority = "terminal";
  settleAction = undefined;
  const betweenWorkspace = await prepareGoalWorkspaceHost({
    originRoot: origin, workspaceRoot: join(root, "between-workspace"), workspaceId: "paging-between-abort",
    mode: "read-only", repository: "nonGit", scope: ["source.txt"],
  });
  const betweenAbort = new AbortController();
  const betweenOpened = await openGoalCandidateToolChannel({
    directory: join(root, "between-channel"), evidenceRoot: join(root, "between-evidence"),
    identity: { test: "paging-between-abort" }, attemptKey: "paging-between-abort", workspace: betweenWorkspace,
    tools: ["goal_candidate_read"],
    sourceProgress: {
      resolve: (_path, cursor) => cursor === "" ? undefined : cursor,
      settle: () => {},
      handoff: () => [], invalidate: () => {},
    },
    assertCurrent: async () => authority, assertLive: () => {}, stopped: stopped.signal,
  });
  t.after(async () => {
    await betweenOpened.drain().catch(() => undefined);
    await betweenWorkspace.cleanup();
  });
  const betweenRegistrations = new Map();
  registerGoalCandidateTools({ registerTool(tool) { betweenRegistrations.set(tool.name, tool); }, setActiveTools() {}, on() {} },
    betweenOpened.channel);
  const beforeBetweenAbort = received.length;
  const { default: ssh2 } = await import("ssh2");
  const originalEnd = ssh2.Client.prototype.end;
  let clientEnds = 0, betweenAbortResult;
  const endObserver = t.mock.method(ssh2.Client.prototype, "end", function (...args) {
    const result = Reflect.apply(originalEnd, this, args);
    // The client closes only after receiving the authenticated ACK settlement.
    // Aborting in the server's settle callback instead loses that ACK.
    if (++clientEnds === 1) betweenAbort.abort(new Error("test between-page unsent abort"));
    return result;
  });
  try {
    betweenAbortResult = await betweenRegistrations.get("goal_candidate_read").execute(
      "between-page-unsent", { path: "source.txt", maxPages: 32 }, betweenAbort.signal);
  } finally {
    endObserver.mock.restore();
  }
  assert.equal(clientEnds, 1);
  assert.equal(betweenAbortResult.details.status, "blocked");
  assert.equal(betweenAbortResult.details.denial, true);
  assert.equal(betweenAbortResult.details.returnedPages, 1);
  assert.equal(betweenAbortResult.details.historicalPages, true);
  assert.equal(received.length, beforeBetweenAbort + 1);
  const unknownWorkspace = await prepareGoalWorkspaceHost({
    originRoot: origin, workspaceRoot: join(root, "unknown-workspace"), workspaceId: "paging-unknown",
    mode: "read-only", repository: "nonGit", scope: ["source.txt"],
  });
  const unknownOpened = await openGoalCandidateToolChannel({
    directory: join(root, "unknown-channel"), evidenceRoot: join(root, "unknown-evidence"),
    identity: { test: "paging-unknown" }, attemptKey: "paging-unknown", workspace: unknownWorkspace,
    tools: ["goal_candidate_read"],
    sourceProgress: {
      resolve: (_path, cursor) => cursor === "" ? undefined : cursor,
      settle: () => {}, handoff: () => [], invalidate: () => {},
    },
    assertCurrent: async () => authority, assertLive: () => {}, stopped: stopped.signal,
  });
  t.after(async () => {
    await unknownOpened.drain().catch(() => undefined);
    await unknownWorkspace.cleanup();
  });
  const unknownRegistrations = new Map();
  registerGoalCandidateTools({ registerTool(tool) { unknownRegistrations.set(tool.name, tool); }, setActiveTools() {}, on() {} },
    unknownOpened.channel);
  const unknownAbort = new AbortController();
  const beforeUnknown = received.length;
  abortAfterSentSecond = unknownAbort;
  const unknown = await unknownRegistrations.get("goal_candidate_read").execute(
    "unknown-after-ack", { path: "source.txt", maxPages: 32 }, unknownAbort.signal);
  assert.equal(unknown.details.status, "unknown");
  assert.equal(unknown.details.returnedPages, 1);
  assert.equal(unknown.details.pages.length, 1);
  assert.equal(unknown.details.historicalPages, true);
  assert.equal(received.length, beforeUnknown + 2);
  const unknownExpected = (await unknownWorkspace.inspectCandidate()).files;
  assert.throws(() => unknownOpened.assertCompleteSourceReadCoverage(unknownExpected), /UNKNOWN|settled/);
  const driftWorkspace = await prepareGoalWorkspaceHost({
    originRoot: origin, workspaceRoot: join(root, "drift-workspace"), workspaceId: "paging-drift",
    mode: "mutation", repository: "nonGit", scope: ["source.txt"],
  });
  const driftBefore = await driftWorkspace.inspectCandidate();
  let driftMutationWork, driftMutationComplete = false;
  const driftOpened = await openGoalCandidateToolChannel({
    directory: join(root, "drift-channel"), evidenceRoot: join(root, "drift-evidence"), identity: { test: "paging-drift" },
    attemptKey: "paging-drift", workspace: driftWorkspace, tools: ["goal_candidate_read"],
    sourceProgress: {
      resolve: (_path, cursor) => cursor === "" ? undefined : cursor,
      settle: () => {
        driftMutationWork ??= (async () => {
          const content = Buffer.from("changed".repeat(1_000));
          const upload = await driftWorkspace.beginCandidateReplacement({
            path: "source.txt", expectedDigest: goalHash(driftBefore.files[0].value),
            bytes: content.length, attemptKey: "drift-writer", operationId: "drift-begin",
          });
          for (let offset = 0; offset < content.length; offset += 4096)
            await driftWorkspace.appendCandidateReplacement({
              path: "source.txt", uploadId: upload.uploadId, offset,
              hex: content.subarray(offset, offset + 4096).toString("hex"),
              attemptKey: "drift-writer", operationId: `drift-chunk-${offset}`,
            });
          await driftWorkspace.commitCandidateReplacement({
            path: "source.txt", uploadId: upload.uploadId,
            attemptKey: "drift-writer", operationId: "drift-commit",
          });
          driftMutationComplete = true;
        })();
      }, handoff: () => [], invalidate: () => {},
    },
    assertCurrent: async () => { await driftMutationWork; return authority; },
    assertLive: () => {}, stopped: stopped.signal,
  });
  t.after(async () => {
    await driftOpened.drain().catch(() => undefined);
    await driftWorkspace.cleanup();
  });
  const driftRegistrations = new Map();
  registerGoalCandidateTools({ registerTool(tool) { driftRegistrations.set(tool.name, tool); }, setActiveTools() {}, on() {} },
    driftOpened.channel);
  const driftRead = driftRegistrations.get("goal_candidate_read");
  const beforeDrift = received.length;
  const drift = await driftRead.execute("drift-after-ack", { path: "source.txt", maxPages: 32 });
  assert.equal(drift.details.status, "unknown",
    JSON.stringify({ message: drift.details.message, stopReason: drift.details.stopReason,
      returnedPages: drift.details.returnedPages, driftMutationComplete }));
  assert.equal(drift.details.stopReason, "unknown");
  assert.equal(drift.details.historicalPages, true);
  assert.equal(drift.details.inconsistentPages, undefined,
    "the host refuses the changed source before a second page can be ACKed");
  assert.equal(drift.details.returnedPages, 1);
  assert.equal(received.length, beforeDrift + 2);
  assert.equal(driftMutationComplete, true);
  assert.deepEqual(Buffer.from(drift.details.pages[0].page.content, drift.details.pages[0].page.encoding),
    Buffer.from("abcdefghijklmnop".repeat(256)));
  assert.equal(drift.details.pages.length, 1, "never expose the failed changed-source observation");

  const acknowledgedDriftWorkspace = await prepareGoalWorkspaceHost({
    originRoot: origin, workspaceRoot: join(root, "acknowledged-drift-workspace"),
    workspaceId: "paging-acknowledged-drift", mode: "mutation", repository: "nonGit", scope: ["source.txt"],
  });
  const acknowledgedDriftBefore = await acknowledgedDriftWorkspace.inspectCandidate();
  let acknowledgedDriftMutationWork, acknowledgedDriftMutationComplete = false;
  const acknowledgedDriftOpened = await openGoalCandidateToolChannel({
    directory: join(root, "ack-drift"), evidenceRoot: join(root, "acknowledged-drift-evidence"),
    identity: { test: "paging-acknowledged-drift" }, attemptKey: "paging-acknowledged-drift",
    workspace: acknowledgedDriftWorkspace, tools: ["goal_candidate_read"],
    sourceProgress: {
      resolve: () => undefined,
      settle: () => {
        acknowledgedDriftMutationWork ??= (async () => {
          const content = Buffer.from("changed".repeat(1_000));
          const upload = await acknowledgedDriftWorkspace.beginCandidateReplacement({
            path: "source.txt", expectedDigest: goalHash(acknowledgedDriftBefore.files[0].value),
            bytes: content.length, attemptKey: "acknowledged-drift-writer", operationId: "acknowledged-drift-begin",
          });
          for (let offset = 0; offset < content.length; offset += 4096)
            await acknowledgedDriftWorkspace.appendCandidateReplacement({
              path: "source.txt", uploadId: upload.uploadId, offset,
              hex: content.subarray(offset, offset + 4096).toString("hex"),
              attemptKey: "acknowledged-drift-writer", operationId: `acknowledged-drift-chunk-${offset}`,
            });
          await acknowledgedDriftWorkspace.commitCandidateReplacement({
            path: "source.txt", uploadId: upload.uploadId,
            attemptKey: "acknowledged-drift-writer", operationId: "acknowledged-drift-commit",
          });
          acknowledgedDriftMutationComplete = true;
        })();
      }, handoff: () => [], invalidate: () => {},
    },
    assertCurrent: async () => { await acknowledgedDriftMutationWork; return authority; },
    assertLive: () => {}, stopped: stopped.signal,
  });
  t.after(async () => {
    await acknowledgedDriftOpened.drain().catch(() => undefined);
    await acknowledgedDriftWorkspace.cleanup();
  });
  const acknowledgedDriftRegistrations = new Map();
  registerGoalCandidateTools({
    registerTool(tool) { acknowledgedDriftRegistrations.set(tool.name, tool); }, setActiveTools() {}, on() {},
  }, acknowledgedDriftOpened.channel);
  const acknowledgedDrift = await acknowledgedDriftRegistrations.get("goal_candidate_read").execute(
    "acknowledged-drift-after-ack", { path: "source.txt", maxPages: 32 });
  assert.equal(acknowledgedDriftMutationComplete, true);
  assert.equal(acknowledgedDrift.details.status, "blocked");
  assert.equal(acknowledgedDrift.details.stopReason, "drift");
  assert.equal(acknowledgedDrift.details.historicalPages, true);
  assert.equal(acknowledgedDrift.details.inconsistentPages, true);
  assert.equal(acknowledgedDrift.details.returnedPages, 2);
  assert.notDeepEqual(acknowledgedDrift.details.pages[1].sourceReceiptIdentity,
    acknowledgedDrift.details.sourceReceiptIdentity);
  assert.deepEqual(
    { ...acknowledgedDrift.details.sourceReceiptIdentity, ...acknowledgedDrift.details.pages[0].sourceReceipt },
    JSON.parse(await readFile(acknowledgedDrift.details.pages[0].sourceReceipt.evidenceRef, "utf8")).result.sourceReceipt,
  );
  assert.deepEqual(
    { ...acknowledgedDrift.details.pages[1].sourceReceiptIdentity, ...acknowledgedDrift.details.pages[1].sourceReceipt },
    JSON.parse(await readFile(acknowledgedDrift.details.pages[1].sourceReceipt.evidenceRef, "utf8")).result.sourceReceipt,
  );
});

test("channel-owned source coverage proves complete UTF-8, binary, and absent reads after clean drain", async t => {
  const root = await disposableRoot(t);
  const origin = join(root, "origin");
  await mkdir(origin);
  await writeFile(join(origin, "utf8.txt"), "é€😀".repeat(3_000));
  await writeFile(join(origin, "binary.bin"), Buffer.from(Array.from({ length: 9_000 }, (_value, index) => index % 251)));
  const workspace = await prepareGoalWorkspaceHost({
    originRoot: origin, workspaceRoot: join(root, "workspace"), workspaceId: "coverage-complete",
    mode: "read-only", repository: "nonGit", scope: ["binary.bin", "missing.txt", "utf8.txt"],
  });
  const stopped = new AbortController();
  const opened = await openGoalCandidateToolChannel({
    directory: join(root, "channel"), evidenceRoot: join(root, "evidence"), identity: { test: "coverage-complete" },
    attemptKey: "coverage-complete", workspace, tools: ["goal_candidate_read"],
    sourceProgress: {
      resolve: (_path, cursor) => cursor === "" ? undefined : cursor,
      settle: receipt => { receipt.content = "callback mutation cannot alter retained proof"; },
      handoff: () => [], invalidate: () => {},
    },
    assertCurrent: async () => "coverage-authority", assertLive: () => {}, stopped: stopped.signal,
  });
  t.after(async () => {
    await opened.drain().catch(() => undefined);
    await workspace.cleanup();
  });
  const registrations = new Map();
  registerGoalCandidateTools({
    registerTool(tool) { registrations.set(tool.name, tool); }, setActiveTools() {}, on() {},
  }, opened.channel);
  assert.equal("assertCompleteSourceReadCoverage" in opened.channel, false);
  const read = registrations.get("goal_candidate_read");
  for (const path of ["utf8.txt", "binary.bin", "missing.txt"]) {
    const result = await read.execute(`coverage-${path}`, { path, maxPages: 32 });
    assert.equal(result.details.status, "ok");
    assert.equal(result.details.eof, true);
  }
  const expected = (await workspace.inspectCandidate()).files;
  assert.equal(opened.assertCompleteSourceReadCoverage(expected), undefined);
  let invokedInputCode = 0;
  const proxy = new Proxy(expected, { get() { invokedInputCode++; throw new Error("proxy invoked"); } });
  assert.throws(() => opened.assertCompleteSourceReadCoverage(proxy), /non-data/);
  const getterValue = { ...expected[0].value };
  Object.defineProperty(getterValue, "kind", {
    enumerable: true, get() { invokedInputCode++; return "artifact"; },
  });
  assert.throws(() => opened.assertCompleteSourceReadCoverage([
    { path: expected[0].path, value: getterValue },
  ]), /accessor/);
  assert.equal(invokedInputCode, 0, "coverage validation never executes caller input");
  const draining = opened.drain();
  assert.throws(() => opened.assertCompleteSourceReadCoverage(expected), /drain settlement/);
  await draining;
  assert.doesNotThrow(() => opened.assertCompleteSourceReadCoverage(expected),
    "a cleanly drained original channel retains only its settled observations");
  await assert.rejects(read.execute("coverage-after-drain", { path: "utf8.txt" }));
  assert.doesNotThrow(() => opened.assertCompleteSourceReadCoverage(expected));
});

test("omitted candidate read cursor resumes prior ACKed EOF while empty cursor starts fresh coverage", async t => {
  const root = await disposableRoot(t);
  const origin = join(root, "origin");
  await mkdir(origin);
  const source = Buffer.from("0123456789abcdef".repeat(5_717) + "x", "utf8");
  await writeFile(join(origin, "source.txt"), source);
  const workspace = await prepareGoalWorkspaceHost({
    originRoot: origin, workspaceRoot: join(root, "workspace"), workspaceId: "coverage-resume",
    mode: "read-only", repository: "nonGit", scope: ["source.txt"],
  });
  const expected = (await workspace.inspectCandidate()).files;
  const stopped = new AbortController();
  const openedChannels = [];
  let acknowledgedPosition;
  const sourceProgress = {
    resolve: (_path, cursor) => cursor === "" ? undefined : cursor ?? acknowledgedPosition,
    settle: receipt => {
      if (receipt.nextCursor !== null) acknowledgedPosition = receipt.nextCursor;
      else if (receipt.cursor !== null) acknowledgedPosition = receipt.cursor;
    },
    handoff: () => [],
    invalidate: () => { acknowledgedPosition = undefined; },
  };
  let directoryId = 0;
  const open = async attemptKey => {
    const opened = await openGoalCandidateToolChannel({
      directory: join(root, `r${directoryId++}`), evidenceRoot: join(root, `${attemptKey}-evidence`),
      identity: { test: attemptKey }, attemptKey, workspace, tools: ["goal_candidate_read"],
      sourceProgress,
      assertCurrent: async () => "coverage-resume-authority",
      assertLive: () => {},
      stopped: stopped.signal,
    });
    openedChannels.push(opened);
    const registrations = new Map();
    registerGoalCandidateTools({
      registerTool(tool) { registrations.set(tool.name, tool); }, setActiveTools() {}, on() {},
    }, opened.channel);
    return { opened, read: registrations.get("goal_candidate_read") };
  };
  t.after(async () => {
    await Promise.all(openedChannels.map(opened => opened.drain().catch(() => undefined)));
    await workspace.cleanup();
  });

  const first = await open("coverage-resume-first");
  const initial = await first.read.execute("initial-complete", {
    path: "source.txt", cursor: "", maxPages: 32,
  });
  assert.equal(initial.details.status, "ok");
  assert.equal(initial.details.eof, true);
  assert.ok(initial.details.returnedPages > 1);
  assert.equal(typeof acknowledgedPosition, "string",
    "the shared continuation retains the original ACKed cursor for the EOF page");
  const priorEofCursor = acknowledgedPosition;
  assert.doesNotThrow(() => first.opened.assertCompleteSourceReadCoverage(expected));

  const second = await open("coverage-resume-second");
  assert.match(second.read.description,
    /Omitting cursor can resume the same path from an acknowledged position retained by a prior inspection or attempt/);
  assert.match(second.read.description,
    /Every fresh complete inspection must start each path with cursor:""/);
  assert.match(second.read.description,
    /EOF alone proves only that the requested position reached the end, not that the full prefix was inspected/);
  const cursorGuidance = second.read.parameters.properties.cursor.description;
  assert.match(cursorGuidance, /Omitting cursor can resume an acknowledged position retained by a prior inspection or attempt/);
  assert.match(cursorGuidance, /pass cursor:"" for each path/);
  assert.match(cursorGuidance, /EOF alone is not proof that the full prefix was inspected/);
  assert.match(cursorGuidance, /Never reset or replay after blocked or UNKNOWN/);

  const resumed = await second.read.execute("omitted-resumes", {
    path: "source.txt", maxPages: 32,
  });
  assert.equal(resumed.details.status, "ok");
  assert.equal(resumed.details.eof, true);
  assert.equal(resumed.details.returnedPages, 1);
  assert.equal(resumed.details.pages[0].sourceReceipt.cursor, priorEofCursor);
  assert.deepEqual(resumed.details.pages[0].page, initial.details.pages.at(-1).page,
    "omission resumes at the prior ACKed EOF-page cursor instead of starting at the prefix");
  assert.ok(resumed.details.pages[0].page.returnedBytes < source.length);
  assert.throws(() => second.opened.assertCompleteSourceReadCoverage(expected), /cursor gap|EOF/,
    "tail EOF without this channel's prefix is not complete source coverage");

  const fresh = await second.read.execute("explicit-fresh-start", {
    path: "source.txt", cursor: "", maxPages: 32,
  });
  assert.equal(fresh.details.status, "ok");
  assert.equal(fresh.details.eof, true);
  assert.deepEqual(Buffer.concat(fresh.details.pages.map(value =>
    Buffer.from(value.page.content, value.page.encoding))), source);
  assert.doesNotThrow(() => second.opened.assertCompleteSourceReadCoverage(expected),
    "the new channel's own empty-cursor ACK chain proves full-prefix coverage");
});

test("channel-owned source coverage rejects partial, foreign, stale, and read-write observations", async t => {
  const root = await disposableRoot(t);
  const origin = join(root, "origin");
  await mkdir(origin);
  await writeFile(join(origin, "source.txt"), "0123456789abcdef".repeat(1_000));
  await writeFile(join(origin, "other.txt"), "other source".repeat(1_000));
  const workspace = await prepareGoalWorkspaceHost({
    originRoot: origin, workspaceRoot: join(root, "workspace"), workspaceId: "coverage-negative",
    mode: "mutation", repository: "nonGit", scope: ["other.txt", "source.txt"],
  });
  const stopped = new AbortController();
  let directoryId = 0;
  const open = async (name, tools = ["goal_candidate_read"], sourceProgress) => {
    const opened = await openGoalCandidateToolChannel({
      directory: join(root, `c${directoryId++}`), evidenceRoot: join(root, `${name}-evidence`),
      identity: { test: name }, attemptKey: name, workspace, tools,
      ...(sourceProgress ? { sourceProgress } : {}),
      assertCurrent: async () => "coverage-authority", assertLive: () => {}, stopped: stopped.signal,
    });
    const registrations = new Map();
    registerGoalCandidateTools({
      registerTool(tool) { registrations.set(tool.name, tool); }, setActiveTools() {}, on() {},
    }, opened.channel);
    return { opened, read: registrations.get("goal_candidate_read") };
  };
  const partial = await open("coverage-partial");
  const suffix = await open("coverage-suffix");
  const priorReceipts = [];
  const foreign = await open("coverage-foreign", undefined, {
    resolve: (_path, cursor) => cursor === "" ? undefined : cursor,
    settle: receipt => priorReceipts.push({ ...receipt }),
    handoff: () => [], invalidate: () => {},
  });
  const inherited = await open("coverage-inherited", undefined, {
    resolve: (_path, cursor) => cursor === "" ? undefined : cursor,
    settle: () => {}, handoff: () => priorReceipts, invalidate: () => {},
  });
  const writable = await open("coverage-writable", ["goal_candidate_read", "goal_candidate_write"]);
  t.after(async () => {
    await Promise.all([partial.opened.drain().catch(() => undefined), suffix.opened.drain().catch(() => undefined),
      foreign.opened.drain().catch(() => undefined), inherited.opened.drain().catch(() => undefined),
      writable.opened.drain().catch(() => undefined)]);
    await workspace.cleanup();
  });
  const before = await workspace.inspectCandidate();
  const source = before.files.find(file => file.path === "source.txt");
  const other = before.files.find(file => file.path === "other.txt");
  const first = await partial.read.execute("coverage-partial-page", { path: "source.txt", maxPages: 1 });
  assert.equal(first.details.page.eof, false);
  assert.throws(() => partial.opened.assertCompleteSourceReadCoverage([source]), /cursor gap|EOF/);
  const suffixOnly = await suffix.read.execute("coverage-suffix-only", {
    path: "source.txt", cursor: first.details.page.nextCursor, maxPages: 32,
  });
  assert.equal(suffixOnly.details.eof, true);
  assert.throws(() => suffix.opened.assertCompleteSourceReadCoverage([source]), /cursor gap|EOF/);
  const foreignComplete = await foreign.read.execute("coverage-foreign-complete", { path: "source.txt", maxPages: 32 });
  assert.equal(foreignComplete.details.eof, true);
  assert.ok(priorReceipts.length);
  assert.throws(() => inherited.opened.assertCompleteSourceReadCoverage([source]), /receipt/,
    "prior sourceProgress handoff evidence is not coverage for this channel");
  assert.throws(() => partial.opened.assertCompleteSourceReadCoverage([source]), /cursor gap|EOF/,
    "another authenticated channel cannot fill this channel's receipt chain");
  assert.throws(() => writable.opened.assertCompleteSourceReadCoverage([source]), /read-only channel/);
  assert.throws(() => foreign.opened.assertCompleteSourceReadCoverage([source, other]), /receipt/,
    "one fully read expected source cannot cover another expected path");
  assert.throws(() => foreign.opened.assertCompleteSourceReadCoverage([source, source]), /duplicate/);
  assert.throws(() => foreign.opened.assertCompleteSourceReadCoverage([]), /nonempty/);
  assert.throws(() => foreign.opened.assertCompleteSourceReadCoverage([{ path: "foreign.txt", value: source.value }]), /foreign/);
  const wrong = { ...source, value: { ...source.value, mode: source.value.mode === "0644" ? "0755" : "0644" } };
  assert.throws(() => foreign.opened.assertCompleteSourceReadCoverage([wrong]), /epoch|receipt|mismatch/);
  const replacement = Buffer.from("changed");
  const upload = await workspace.beginCandidateReplacement({
    path: "source.txt", expectedDigest: goalHash(source.value), bytes: replacement.length,
    attemptKey: "coverage-writer", operationId: "coverage-begin",
  });
  await workspace.appendCandidateReplacement({
    path: "source.txt", uploadId: upload.uploadId, offset: 0, hex: replacement.toString("hex"),
    attemptKey: "coverage-writer", operationId: "coverage-chunk",
  });
  await workspace.commitCandidateReplacement({
    path: "source.txt", uploadId: upload.uploadId,
    attemptKey: "coverage-writer", operationId: "coverage-commit",
  });
  const changed = (await workspace.inspectCandidate()).files.find(file => file.path === "source.txt");
  const refreshed = await foreign.read.execute("coverage-foreign-changed", { path: "source.txt", maxPages: 32 });
  assert.equal(refreshed.details.eof, true);
  assert.throws(() => foreign.opened.assertCompleteSourceReadCoverage([source]), /epoch/,
    "later same-channel receipts cannot resurrect the old epoch");
  assert.throws(() => foreign.opened.assertCompleteSourceReadCoverage([changed]), /epoch/,
    "mixed epochs fail closed instead of selecting the new receipts");
});

test("channel-owned source coverage rejects foreign paths and conflicting authenticated page observations", async t => {
  const root = await disposableRoot(t);
  const origin = join(root, "origin");
  await mkdir(origin);
  await writeFile(join(origin, "a.txt"), "same\n");
  await writeFile(join(origin, "b.txt"), "same\n");
  const workspace = await prepareGoalWorkspaceHost({
    originRoot: origin, workspaceRoot: join(root, "workspace"), workspaceId: "coverage-conflict",
    mode: "read-only", repository: "nonGit", scope: ["a.txt", "b.txt"],
  });
  const expected = [(await workspace.inspectCandidate()).files.find(file => file.path === "a.txt")];
  const openedChannels = [];
  t.after(async () => {
    await Promise.all(openedChannels.map(channel => channel.drain()));
    await workspace.cleanup();
  });
  for (const scenario of ["foreign", "conflict"]) {
    let reads = 0;
    // NONAUTHORITY malformed-host fixture: real reads and original transport
    // ACKs, but deliberately inconsistent page observations, never forged proof.
    const observedWorkspace = Object.freeze({
      ...workspace,
      async readSourcePage(...args) {
        const result = await workspace.readSourcePage(...args);
        reads++;
        if (scenario === "foreign") return { ...result, path: "b.txt" };
        return reads === 1 ? result : { ...result, page: { ...result.page, content: "fake\n" } };
      },
    });
    const stopped = new AbortController();
    const opened = await openGoalCandidateToolChannel({
      directory: join(root, scenario), evidenceRoot: join(root, `${scenario}-evidence`),
      identity: { test: scenario }, attemptKey: scenario,
      workspace: observedWorkspace, tools: ["goal_candidate_read"],
      assertCurrent: async () => "coverage-authority", assertLive: () => {}, stopped: stopped.signal,
    });
    openedChannels.push(opened);
    const registrations = new Map();
    registerGoalCandidateTools({
      registerTool(tool) { registrations.set(tool.name, tool); }, setActiveTools() {}, on() {},
    }, opened.channel);
    const read = registrations.get("goal_candidate_read");
    const first = await read.execute(`${scenario}-first`, { path: "a.txt", cursor: "" });
    assert.equal(first.details.status, "ok");
    if (scenario === "conflict") {
      assert.doesNotThrow(() => opened.assertCompleteSourceReadCoverage(expected));
      const second = await read.execute(`${scenario}-second`, { path: "a.txt", cursor: "" });
      assert.equal(second.details.status, "ok");
    }
    assert.throws(() => opened.assertCompleteSourceReadCoverage(expected), /epoch|conflicting/);
  }
});

test("channel-owned source coverage rejects reentry before continuation settlement and retains UNKNOWN", async t => {
  const root = await disposableRoot(t);
  const origin = join(root, "origin");
  await mkdir(origin);
  await writeFile(join(origin, "source.txt"), "original source");
  const workspace = await prepareGoalWorkspaceHost({
    originRoot: origin, workspaceRoot: join(root, "workspace"), workspaceId: "coverage-reentry",
    mode: "read-only", repository: "nonGit", scope: ["source.txt"],
  });
  const expected = (await workspace.inspectCandidate()).files;
  const stopped = new AbortController();
  let opened, rejectedReentry = false, receiptPath;
  opened = await openGoalCandidateToolChannel({
    directory: join(root, "channel"), evidenceRoot: join(root, "evidence"),
    identity: { test: "coverage-reentry" }, attemptKey: "coverage-reentry",
    workspace, tools: ["goal_candidate_read"],
    sourceProgress: {
      resolve: (_path, cursor) => cursor === "" ? undefined : cursor,
      settle(receipt) {
        receiptPath = receipt.evidenceRef;
        assert.throws(() => opened.assertCompleteSourceReadCoverage(expected), /settled/);
        rejectedReentry = true;
        throw new Error("original continuation settlement failed");
      },
      handoff: () => [], invalidate: () => {},
    },
    assertCurrent: async () => "coverage-authority", assertLive: () => {}, stopped: stopped.signal,
  });
  t.after(async () => {
    await opened.drain().catch(() => undefined);
    await workspace.cleanup();
  });
  const registrations = new Map();
  registerGoalCandidateTools({
    registerTool(tool) { registrations.set(tool.name, tool); }, setActiveTools() {}, on() {},
  }, opened.channel);
  const result = await registrations.get("goal_candidate_read").execute(
    "coverage-reentry", { path: "source.txt", maxPages: 2 });
  assert.equal(rejectedReentry, true, "coverage cannot succeed inside a still-fallible continuation callback");
  assert.equal(result.details.status, "unknown");
  assert.equal(JSON.parse(await readFile(receiptPath, "utf8")).phase, "unknown");
  assert.throws(() => opened.assertCompleteSourceReadCoverage(expected), /UNKNOWN/);
  await assert.rejects(opened.drain(), /UNKNOWN/);
  assert.throws(() => opened.assertCompleteSourceReadCoverage(expected), /UNKNOWN/);
});

function nativeReadTurn(toolCallId, params, result) {
  return [
    { role: "assistant", content: [
      { type: "toolCall", id: toolCallId, name: "goal_candidate_read", arguments: params },
    ] },
    { role: "toolResult", toolCallId, toolName: "goal_candidate_read",
      content: result.content, isError: false },
  ];
}

async function nativeReadFixture(t, root, name, attemptKey = name) {
  const origin = join(root, `${name}-origin`);
  await mkdir(origin);
  await writeFile(join(origin, "single.txt"), "single authentic page\n");
  await writeFile(join(origin, "batch.txt"), "0123456789abcdef".repeat(16_350));
  const workspace = await prepareGoalWorkspaceHost({
    originRoot: origin, workspaceRoot: join(root, `${name}-workspace`), workspaceId: name,
    mode: "read-only", repository: "nonGit", scope: ["batch.txt", "missing.txt", "single.txt"],
  });
  const stopped = new AbortController();
  const opened = await openGoalCandidateToolChannel({
    directory: join(root, `c-${goalHash(name).slice(0, 8)}`), evidenceRoot: join(root, `${name}-evidence`),
    identity: { test: name }, attemptKey, workspace, tools: ["goal_candidate_read"],
    sourceProgress: {
      resolve: (_path, cursor) => cursor === "" ? undefined : cursor,
      settle() {}, handoff: () => [], invalidate() {},
    },
    assertCurrent: async () => `${name}-authority`, assertLive() {}, stopped: stopped.signal,
  });
  const registrations = new Map();
  registerGoalCandidateTools({
    registerTool(tool) { registrations.set(tool.name, tool); }, setActiveTools() {}, on() {},
  }, opened.channel);
  t.after(async () => {
    await opened.drain().catch(() => undefined);
    await workspace.cleanup();
  });
  return { workspace, opened, read: registrations.get("goal_candidate_read"), attemptKey };
}

async function nativeRequestWrapperFixture(t, root, name, { serviceTier, captureNativeReads = true } = {}) {
  const budget = createGoalRequestBudget(1);
  const request = await openGoalRequestBudgetChannel({
    directory: join(root, `r-${goalHash(name).slice(0, 8)}`), evidenceRoot: join(root, `${name}-request-evidence`),
    identity: { test: name }, attemptKey: name, model: "openai/native-fixture", budget,
    current: async () => `${name}-authority`, live() {}, stopped: new AbortController().signal,
    ...(captureNativeReads ? { captureNativeReads: true } : {}), ...(serviceTier ? { serviceTier } : {}),
  });
  const extension = await readFile(request.extensionPath, "utf8");
  const marker = "registerGoalRequestBudget(pi, ";
  const suffix = serviceTier ? `, "openai/native-fixture", ${captureNativeReads}, ${JSON.stringify(serviceTier)});`
    : captureNativeReads ? ', "openai/native-fixture", true);' : ', "openai/native-fixture");';
  assert.ok(extension.endsWith(`${suffix}\n`), "the generated extension carries exactly the admitted arguments");
  const binding = JSON.parse(extension.slice(extension.indexOf(marker) + marker.length, extension.lastIndexOf(suffix)));
  const model = { provider: "openai", id: "native-fixture", api: "openai-responses" };
  const counters = { providerCalls: 0, reservations: 0, physicalFetches: 0 };
  const bodies = [];
  const originalStream = (_actual, context, options) => {
    counters.providerCalls++;
    return (async function* () {
      let payload = options.fixturePayload === undefined
        ? {
          model: model.id,
          instructions: context.systemPrompt,
          input: context.messages,
          stream: true,
          prompt_cache_key: undefined,
          ...(context.tools?.length ? {
            tools: context.tools.map(tool => Object.fromEntries(
              Object.entries(tool).filter(([key]) => key !== "execute"),
            )),
          } : {}),
        }
        : options.fixturePayload;
      const nextPayload = await options.onPayload?.(payload, model);
      if (nextPayload !== undefined) payload = nextPayload;
      const body = JSON.stringify(payload);
      bodies.push(JSON.parse(body));
      await options.fetch("https://native-fixture.invalid/v1/responses", {
        method: "POST", body,
      });
      yield {
        type: "done",
        message: {
          role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
          usage: {
            input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop", timestamp: Date.now(),
        },
      };
    })();
  };
  const original = { stream: originalStream, streamSimple: originalStream };
  const handlers = new Map();
  let registered;
  registerGoalRequestBudget({
    on(name, handler) { handlers.set(name, handler); },
    registerProvider(provider) { registered = provider; },
  }, binding, "openai/native-fixture", captureNativeReads, serviceTier);
  handlers.get("session_start")({}, {
    model,
    modelRegistry: {
      getRegisteredProviderConfig() { return undefined; },
      getRegisteredNativeProvider() { return undefined; },
      getProvider() { return original; },
      find() { return model; },
    },
  });
  const observer = diagnosticsChannel("pi-workflow:goal-candidate-request");
  const onReceived = event => {
    if (event.phase === "received" && event.attemptKey === name &&
        event.tool === "request-budget:reserve") counters.reservations++;
  };
  observer.subscribe(onReceived);
  t.after(async () => {
    observer.unsubscribe(onReceived);
    await request.drain().catch(() => undefined);
  });
  return {
    counters,
    bodies,
    request,
    async run(context, hook = payload => payload, fixturePayload) {
      const events = [];
      for await (const event of registered.streamSimple(model, context, {
        onPayload: hook,
        fixturePayload,
        fetch: async () => {
          counters.physicalFetches++;
          return { ok: true };
        },
      })) events.push(event);
      return events;
    },
  };
}

test("native model-input witness matches original single, batched, and absent ACK-settled reads", async t => {
  const root = await disposableRoot(t);
  const fixture = await nativeReadFixture(t, root, "native-complete");
  const singleParams = { path: "single.txt" };
  const batchParams = { path: "batch.txt", maxPages: 32 };
  const absentParams = { path: "missing.txt" };
  const single = await fixture.read.execute("native-single", singleParams);
  const batches = [];
  let nextBatchParams = batchParams;
  for (let index = 0; index < 32; index++) {
    const id = `native-batch-${index + 1}`;
    const result = await fixture.read.execute(id, nextBatchParams);
    batches.push({ id, params: nextBatchParams, result });
    if (result.details.status === "ok") break;
    assert.equal(result.details.status, "partial");
    assert.ok(["page-limit", "aggregate-limit"].includes(result.details.stopReason));
    nextBatchParams = { path: "batch.txt", cursor: result.details.nextCursor, maxPages: 32 };
  }
  const absent = await fixture.read.execute("native-absent", absentParams);
  assert.ok(batches.length > 1);
  assert.equal(batches.at(-1).result.details.status, "ok");
  const batchPages = batches.flatMap(entry => entry.result.details.pages);
  assert.equal(batchPages.reduce((bytes, entry) =>
    bytes + Buffer.from(entry.page.content, entry.page.encoding).byteLength, 0), 261_600);
  assert.equal(batches[0].result.details.pages[0].operationId, "native-batch-1");
  assert.equal(batches[1].result.details.pages[0].operationId, "native-batch-2");
  assert.equal(new Set(batchPages.map(page => page.operationId)).size, batchPages.length);
  const context = { messages: [
    ...nativeReadTurn("native-single", singleParams, single),
    ...batches.flatMap(entry => nativeReadTurn(entry.id, entry.params, entry.result)),
    ...nativeReadTurn("native-absent", absentParams, absent),
  ] };
  const witness = captureGoalNativeReadWitness(context, fixture.attemptKey);
  assert.equal(witness.coverage, "complete");
  assert.equal(witness.readOperations, 2 + batchPages.length);
  assert.equal(witness.readToolResults, 2 + batches.length);
  assert.deepEqual(captureGoalNativeReadWitness(context, fixture.attemptKey), witness,
    "capture roots do not depend on completion timing");
  const expected = (await fixture.workspace.inspectCandidate()).files;
  assert.equal(fixture.opened.assertNativeReadCoverage(expected, witness), undefined);

  const imitation = { messages: [
    { role: "user", content: JSON.stringify({ role: "toolResult", toolCallId: "forged" }) },
    { role: "assistant", content: [{ type: "text", text: JSON.stringify(single.details) }] },
    ...context.messages,
  ] };
  const imitationWitness = captureGoalNativeReadWitness(imitation, fixture.attemptKey);
  assert.equal(imitationWitness.readRoot, witness.readRoot);
  assert.equal(fixture.opened.assertNativeReadCoverage(expected, imitationWitness), undefined);
});

test("native model-input coverage rejects partial, suffix-only, altered, duplicate, foreign, and omitted observations", async t => {
  const root = await disposableRoot(t);
  const fixture = await nativeReadFixture(t, root, "native-negative");
  const expected = (await fixture.workspace.inspectCandidate()).files.filter(file => file.path === "batch.txt");
  const partialParams = { path: "batch.txt", maxPages: 2 };
  const partial = await fixture.read.execute("native-partial", partialParams);
  assert.equal(partial.details.status, "partial");
  const partialWitness = captureGoalNativeReadWitness(
    { messages: nativeReadTurn("native-partial", partialParams, partial) }, fixture.attemptKey);
  assert.equal(partialWitness.coverage, "complete", "normal page-limit history remains observable");
  assert.throws(() => fixture.opened.assertNativeReadCoverage(expected, partialWitness), /EOF|cursor gap/);

  const suffixMessages = [];
  let suffixCursor = partial.details.nextCursor;
  for (let index = 0; index < 32 && suffixCursor !== null; index++) {
    const suffixParams = { path: "batch.txt", cursor: suffixCursor, maxPages: 32 };
    const id = `native-suffix-${index}`;
    const suffix = await fixture.read.execute(id, suffixParams);
    assert.ok(["ok", "partial"].includes(suffix.details.status));
    suffixMessages.push(...nativeReadTurn(id, suffixParams, suffix));
    suffixCursor = suffix.details.nextCursor;
  }
  assert.equal(suffixCursor, null, "the authentic suffix reaches EOF without this Context's prefix");
  const suffixWitness = captureGoalNativeReadWitness(
    { messages: suffixMessages }, fixture.attemptKey);
  assert.throws(() => fixture.opened.assertNativeReadCoverage(expected, suffixWitness), /does not match/);

  const smallFixture = await nativeReadFixture(t, root, "native-altered");
  const params = { path: "single.txt" };
  const original = await smallFixture.read.execute("native-original", params);
  const altered = JSON.parse(original.content[0].text);
  altered.page.content = `X${altered.page.content.slice(1)}`;
  const alteredResult = { content: [{ type: "text", text: JSON.stringify(altered) }] };
  const alteredWitness = captureGoalNativeReadWitness(
    { messages: nativeReadTurn("native-original", params, alteredResult) }, smallFixture.attemptKey);
  const smallExpected = (await smallFixture.workspace.inspectCandidate()).files.filter(file => file.path === "single.txt");
  assert.throws(() => smallFixture.opened.assertNativeReadCoverage(smallExpected, alteredWitness), /does not match/,
    "actual page bytes override unchanged self-claimed identities");

  const turn = nativeReadTurn("native-original", params, original);
  assert.throws(() => captureGoalNativeReadWitness({ messages: [...turn, turn[1]] }, smallFixture.attemptKey),
    /duplicated/);
  const foreignIdTurn = nativeReadTurn("native-foreign-id", params, original);
  const foreignIdWitness = captureGoalNativeReadWitness({ messages: foreignIdTurn }, smallFixture.attemptKey);
  assert.throws(() => smallFixture.opened.assertNativeReadCoverage(smallExpected, foreignIdWitness), /does not match/);
  const foreignAttempt = captureGoalNativeReadWitness({ messages: turn }, "another-attempt");
  assert.throws(() => smallFixture.opened.assertNativeReadCoverage(smallExpected, foreignAttempt), /another attempt/);

  const foreign = await nativeReadFixture(t, root, "native-foreign-channel", smallFixture.attemptKey);
  const foreignResult = await foreign.read.execute("native-original", params);
  const foreignWitness = captureGoalNativeReadWitness(
    { messages: nativeReadTurn("native-original", params, foreignResult) }, smallFixture.attemptKey);
  assert.throws(() => smallFixture.opened.assertNativeReadCoverage(smallExpected, foreignWitness), /does not match/);

  const missing = captureGoalNativeReadWitness({ messages: [turn[0]] }, smallFixture.attemptKey);
  assert.equal(missing.coverage, "incomplete");
  assert.throws(() => smallFixture.opened.assertNativeReadCoverage(smallExpected, missing), /incomplete/);
  const evicted = captureGoalNativeReadWitness({ messages: [] }, smallFixture.attemptKey);
  assert.equal(evicted.coverage, "none");
  assert.throws(() => smallFixture.opened.assertNativeReadCoverage(smallExpected, evicted), /incomplete/);
});

test("native model-input capture rejects unsafe or oversized Context without invoking caller code", () => {
  let invoked = 0;
  const proxy = new Proxy({ messages: [] }, {
    get() { invoked++; throw new Error("proxy trap invoked"); },
    ownKeys() { invoked++; throw new Error("proxy trap invoked"); },
  });
  assert.throws(() => captureGoalNativeReadWitness(proxy, "safe-attempt"), /proxy/);
  const accessor = {};
  Object.defineProperty(accessor, "messages", {
    enumerable: true, get() { invoked++; throw new Error("getter invoked"); },
  });
  assert.throws(() => captureGoalNativeReadWitness(accessor, "safe-attempt"), /accessor/);
  const withToJSON = { messages: [], toJSON() { invoked++; throw new Error("toJSON invoked"); } };
  assert.throws(() => captureGoalNativeReadWitness(withToJSON, "safe-attempt"), /toJSON/);
  const nestedToJSON = {
    messages: [], metadata: { toJSON() { invoked++; throw new Error("nested toJSON invoked"); } },
  };
  assert.throws(() => captureGoalNativeReadWitness(nestedToJSON, "safe-attempt"), /toJSON/);
  const nestedFunction = {
    messages: [], metadata: { callback() { invoked++; throw new Error("function invoked"); } },
  };
  assert.throws(() => captureGoalNativeReadWitness(nestedFunction, "safe-attempt"), /function/);
  const asyncTool = {
    name: "goal_candidate_read", label: "goal_candidate_read", executionMode: "sequential",
    description: "registered native read", parameters: { type: "object", properties: {} },
    async execute() { invoked++; throw new Error("execute invoked"); },
  };
  const normalTool = {
    name: "normal_callback", label: "normal_callback", description: "normal callback shape",
    parameters: { type: "object", properties: {} },
    execute: function execute() { invoked++; throw new Error("execute invoked"); },
  };
  assert.equal(captureGoalNativeReadWitness(
    { messages: [], tools: [asyncTool, normalTool] }, "safe-attempt").coverage, "none");
  assert.throws(() => captureGoalNativeReadWitness({
    messages: [], tools: [asyncTool], metadata: asyncTool,
  }, "safe-attempt"), /function/,
    "sharing a native tool into serialized metadata must not reuse its execute exception");
  const executeToJSON = async function execute() { invoked++; throw new Error("execute invoked"); };
  executeToJSON.toJSON = () => { invoked++; throw new Error("execute toJSON invoked"); };
  assert.throws(() => captureGoalNativeReadWitness({
    messages: [], tools: [{ ...asyncTool, execute: executeToJSON }],
  }, "safe-attempt"), /toJSON/);
  const executeGetter = async function execute() { invoked++; throw new Error("execute invoked"); };
  Object.defineProperty(executeGetter, "toJSON", {
    configurable: true, get() { invoked++; throw new Error("execute getter invoked"); },
  });
  assert.throws(() => captureGoalNativeReadWitness({
    messages: [], tools: [{ ...asyncTool, execute: executeGetter }],
  }, "safe-attempt"), /toJSON|accessor/);
  const executeAccessorTool = { ...asyncTool };
  Object.defineProperty(executeAccessorTool, "execute", {
    enumerable: true, get() { invoked++; throw new Error("tool execute getter invoked"); },
  });
  assert.throws(() => captureGoalNativeReadWitness({
    messages: [], tools: [executeAccessorTool],
  }, "safe-attempt"), /accessor/);
  const executeProxy = new Proxy(
    async function execute() { invoked++; throw new Error("execute invoked"); },
    {
      get() { invoked++; throw new Error("execute proxy get invoked"); },
      getOwnPropertyDescriptor() { invoked++; throw new Error("execute proxy descriptor invoked"); },
      getPrototypeOf() { invoked++; throw new Error("execute proxy prototype invoked"); },
      ownKeys() { invoked++; throw new Error("execute proxy keys invoked"); },
    });
  assert.throws(() => captureGoalNativeReadWitness({
    messages: [], tools: [{ ...asyncTool, execute: executeProxy }],
  }, "safe-attempt"), /proxy/);
  const executePrototypeHook = function execute() { invoked++; throw new Error("execute invoked"); };
  executePrototypeHook.prototype.toJSON =
    () => { invoked++; throw new Error("execute prototype toJSON invoked"); };
  assert.throws(() => captureGoalNativeReadWitness({
    messages: [], tools: [{ ...asyncTool, execute: executePrototypeHook }],
  }, "safe-attempt"), /prototype metadata/);
  const nestedAccessor = { messages: [], metadata: {} };
  Object.defineProperty(nestedAccessor.metadata, "value", {
    enumerable: true, get() { invoked++; throw new Error("nested getter invoked"); },
  });
  assert.throws(() => captureGoalNativeReadWitness(nestedAccessor, "safe-attempt"), /accessor/);
  const nestedProxy = new Proxy({ value: "hidden" }, {
    get() { invoked++; throw new Error("nested proxy trap invoked"); },
    ownKeys() { invoked++; throw new Error("nested proxy trap invoked"); },
  });
  assert.throws(() => captureGoalNativeReadWitness(
    { messages: [], metadata: nestedProxy }, "safe-attempt"), /proxy/);
  const cycle = {};
  cycle.self = cycle;
  assert.throws(() => captureGoalNativeReadWitness(
    { messages: [], metadata: cycle }, "safe-attempt"), /cycle/);
  const symbol = Symbol("unsafe");
  assert.throws(() => captureGoalNativeReadWitness(
    { messages: [], metadata: { [symbol]: "hidden" } }, "safe-attempt"), /symbol/);
  assert.throws(() => captureGoalNativeReadWitness(
    { messages: [], metadata: new Date(0) }, "safe-attempt"), /nonplain/);
  assert.throws(() => captureGoalNativeReadWitness(
    { messages: [], metadata: new Array(4_097).fill(null) }, "safe-attempt"), /unbounded/);
  const shared = { source: "shared noncyclic metadata" };
  assert.equal(captureGoalNativeReadWitness(
    { messages: [], first: shared, second: shared }, "safe-attempt").coverage, "none");
  assert.equal(captureGoalNativeReadWitness({
    systemPrompt: "s".repeat(261_600),
    messages: [],
    metadata: { retainedToolChars: "t".repeat(320_000), optional: undefined },
  }, "safe-attempt").coverage, "none");
  const oversized = { messages: [
    { role: "assistant", content: [
      { type: "toolCall", id: "oversized", name: "goal_candidate_read", arguments: { path: "single.txt" } },
    ] },
    { role: "toolResult", toolCallId: "oversized", toolName: "goal_candidate_read",
      content: [{ type: "text", text: "x".repeat(320_001) }], isError: false },
  ] };
  assert.throws(() => captureGoalNativeReadWitness(oversized, "safe-attempt"), /exceeds its ceiling/);
  assert.equal(invoked, 0);
});

test("native request wrapper denies unmatched reads pre-provider and allows ACKed partial progress", async t => {
  const root = await disposableRoot(t);
  const deniedName = "native-wrapper-incomplete";
  const denied = await nativeRequestWrapperFixture(t, root, deniedName);
  const unmatched = nativeReadTurn("native-unmatched", { path: "single.txt" }, { content: [] })[0];
  const deniedEvents = await denied.run({ messages: [unmatched] });
  assert.equal(deniedEvents.at(-1)?.type, "error");
  assert.deepEqual(denied.counters, {
    providerCalls: 0,
    reservations: 0,
    physicalFetches: 0,
  });
  await denied.request.drain();

  const allowedName = "native-wrapper-partial";
  const source = await nativeReadFixture(t, root, `${allowedName}-source`, allowedName);
  const params = { path: "batch.txt", maxPages: 2 };
  const partial = await source.read.execute("native-partial-progress", params);
  assert.equal(partial.details.status, "partial");
  assert.equal(partial.details.eof, false);
  assert.ok(["page-limit", "aggregate-limit"].includes(partial.details.stopReason));
  const allowed = await nativeRequestWrapperFixture(t, root, allowedName);
  const allowedEvents = await allowed.run({
    messages: nativeReadTurn("native-partial-progress", params, partial),
    tools: [source.read],
  });
  assert.equal(allowedEvents.at(-1)?.type, "done");
  assert.deepEqual(allowed.counters, {
    providerCalls: 1,
    reservations: 1,
    physicalFetches: 1,
  });
  await allowed.request.drain();
  const witness = allowed.request.lastSettledNativeReadWitness();
  assert.equal(witness.coverage, "complete");
  assert.ok(witness.sourceChars > 0 && witness.sourceChars < 261_600);
});

test("Goal Fast requests the priority tier inside the guarded request, for plain and source-reading requests", async t => {
  const root = await disposableRoot(t);
  const plain = await nativeRequestWrapperFixture(t, root, "fast-plain", { serviceTier: "priority", captureNativeReads: false });
  // A later payload hook that drops the tier cannot remove it.
  const events = await plain.run({ messages: [] }, payload => ({ ...payload, service_tier: undefined, extra: true }));
  assert.equal(events.at(-1)?.type, "done");
  assert.equal(plain.bodies[0].service_tier, "priority");
  assert.equal(plain.bodies[0].extra, true, "other payload hooks still apply");
  assert.deepEqual(plain.counters, { providerCalls: 1, reservations: 1, physicalFetches: 1 });
  await plain.request.drain();

  const unset = await nativeRequestWrapperFixture(t, root, "fast-unset", { captureNativeReads: false });
  assert.equal((await unset.run({ messages: [] })).at(-1)?.type, "done");
  assert.equal(Object.hasOwn(unset.bodies[0], "service_tier"), false, "no tier without the Goal opt-in");
  await unset.request.drain();

  const mismatched = await nativeRequestWrapperFixture(t, root, "fast-mismatch", { serviceTier: "priority", captureNativeReads: false });
  const mismatchEvents = await mismatched.run({ messages: [] }, undefined, { model: "another-model", input: [] });
  assert.equal(mismatchEvents.at(-1)?.type, "error", "a payload for another model is not tiered or sent");
  assert.equal(mismatched.counters.physicalFetches, 0);
  await mismatched.request.drain();

  const name = "fast-source";
  const source = await nativeReadFixture(t, root, `${name}-source`, name);
  const params = { path: "batch.txt", maxPages: 2 };
  const partial = await source.read.execute("fast-source-read", params);
  const native = await nativeRequestWrapperFixture(t, root, name, { serviceTier: "priority" });
  const nativeEvents = await native.run({ messages: nativeReadTurn("fast-source-read", params, partial), tools: [source.read] });
  assert.equal(nativeEvents.at(-1)?.type, "done");
  assert.equal(native.bodies[0].service_tier, "priority", "the source verifier's frozen payload carries the tier");
  await native.request.drain();
  assert.equal(native.request.lastSettledNativeReadWitness().coverage, "complete");

  await assert.rejects(openGoalRequestBudgetChannel({ directory: join(root, "bad-tier"), evidenceRoot: join(root, "bad-tier-evidence"),
    identity: {}, attemptKey: "bad", model: "openai/native-fixture", budget: createGoalRequestBudget(1),
    current: async () => "a", live() {}, stopped: new AbortController().signal, serviceTier: "flex" }), /must be priority/);
});

test("source-qualified payload hook permits only frozen identity or undefined observation", async t => {
  const root = await disposableRoot(t);
  const identity = await nativeRequestWrapperFixture(t, root, "native-payload-identity");
  let identitySnapshot;
  const largeSource = "s".repeat(261_600);
  const identityEvents = await identity.run({
    systemPrompt: largeSource,
    messages: [{ role: "user", content: "retain the full source" }],
  }, payload => {
    identitySnapshot = payload;
    return payload;
  });
  assert.equal(identityEvents.at(-1)?.type, "done");
  assert.equal(Object.getPrototypeOf(identitySnapshot), null);
  assert.equal(Object.isFrozen(identitySnapshot), true);
  assert.equal(Object.isFrozen(identitySnapshot.input), true);
  assert.equal(identitySnapshot.prompt_cache_key, undefined,
    "the locked Responses adapter's explicit undefined fields remain supported");
  assert.equal(identity.bodies[0].instructions.length, 261_600,
    "source size is not treated as a global payload authority cap");
  assert.deepEqual(identity.counters, {
    providerCalls: 1,
    reservations: 1,
    physicalFetches: 1,
  });

  const undefinedObservation = await nativeRequestWrapperFixture(
    t, root, "native-payload-undefined-observation");
  let undefinedSnapshot;
  const undefinedEvents = await undefinedObservation.run({
    messages: [{ role: "user", content: "ordinary input" }],
  }, payload => {
    undefinedSnapshot = payload;
    return undefined;
  });
  assert.equal(undefinedEvents.at(-1)?.type, "done");
  assert.equal(Object.isFrozen(undefinedSnapshot.input[0]), true);
  assert.deepEqual(undefinedObservation.counters, {
    providerCalls: 1,
    reservations: 1,
    physicalFetches: 1,
  });

  const replacement = await nativeRequestWrapperFixture(t, root, "native-payload-equal-replacement");
  const replacementEvents = await replacement.run({ messages: [] }, payload => ({ ...payload }));
  assert.equal(replacementEvents.at(-1)?.type, "error");
  assert.deepEqual(replacement.counters, {
    providerCalls: 1,
    reservations: 0,
    physicalFetches: 0,
  }, "even a value-equal no-source replacement is denied before reservation");
  assert.deepEqual(replacement.bodies, []);
});

test("source-qualified payload snapshot cannot lose native read input through mutation or replacement", async t => {
  const root = await disposableRoot(t);
  const openSourceCase = async name => {
    const source = await nativeReadFixture(t, root, `${name}-source`, name);
    const params = { path: "single.txt" };
    const result = await source.read.execute(`${name}-read`, params);
    assert.equal(result.details.status, "ok");
    const wrapped = await nativeRequestWrapperFixture(t, root, name);
    return {
      wrapped,
      context: {
        messages: nativeReadTurn(`${name}-read`, params, result),
        tools: [source.read],
        metadata: {
          nativeReadWitness: {
            coverage: "complete",
            sourceChars: 999_999,
            readRoot: "caller-controlled-imitation",
          },
        },
      },
    };
  };

  const replaced = await openSourceCase("native-payload-source-replaced");
  const replacedEvents = await replaced.wrapped.run(
    replaced.context, payload => ({ ...payload, input: [] }));
  assert.equal(replacedEvents.at(-1)?.type, "error");
  assert.deepEqual(replaced.wrapped.counters, {
    providerCalls: 1,
    reservations: 0,
    physicalFetches: 0,
  }, "source removal by replacement is denied before reservation");
  assert.deepEqual(replaced.wrapped.bodies, []);

  const mutated = await openSourceCase("native-payload-source-mutated");
  const mutatedEvents = await mutated.wrapped.run(mutated.context, payload => {
    payload.input[1].content[0].text = "removed source";
    return payload;
  });
  assert.equal(mutatedEvents.at(-1)?.type, "error");
  assert.deepEqual(mutated.wrapped.counters, {
    providerCalls: 1,
    reservations: 0,
    physicalFetches: 0,
  }, "nested mutation fails against the private recursively frozen snapshot");
  assert.deepEqual(mutated.wrapped.bodies, []);

  const retained = await openSourceCase("native-payload-source-retained");
  let retainedInput;
  let deferredMutationError;
  const retainedEvents = await retained.wrapped.run(retained.context, payload => {
    retainedInput = payload.input;
    queueMicrotask(() => {
      try { retainedInput.splice(0); }
      catch (error) { deferredMutationError = error; }
    });
    return payload;
  });
  assert.equal(retainedEvents.at(-1)?.type, "done");
  assert.ok(deferredMutationError instanceof TypeError);
  assert.equal(Object.isFrozen(retainedInput), true);
  assert.equal(retained.wrapped.bodies[0].input.length, retained.context.messages.length);
  assert.equal(retained.wrapped.bodies[0].tools[0].execute, undefined,
    "the actual-shaped adapter payload projects definitions rather than native execute");
  assert.deepEqual(retained.wrapped.counters, {
    providerCalls: 1,
    reservations: 1,
    physicalFetches: 1,
  });
  await retained.wrapped.request.drain();
  const witness = retained.wrapped.request.lastSettledNativeReadWitness();
  assert.equal(witness.coverage, "complete");
  assert.equal(witness.readOperations, 1);
  assert.notEqual(witness.readRoot, "caller-controlled-imitation");
});

test("source-qualified payload inspection rejects hooks, functions, proxies, cycles, and unsafe prototypes", async t => {
  const root = await disposableRoot(t);
  const fixture = await nativeRequestWrapperFixture(t, root, "native-payload-unsafe");
  let invoked = 0;
  let hookCalls = 0;
  const getterPayload = { model: "native-fixture", input: [] };
  Object.defineProperty(getterPayload, "hidden", {
    enumerable: true,
    get() { invoked++; throw new Error("payload getter invoked"); },
  });
  const proxyPayload = new Proxy({ model: "native-fixture", input: [] }, {
    get() { invoked++; throw new Error("payload proxy get invoked"); },
    getOwnPropertyDescriptor() { invoked++; throw new Error("payload proxy descriptor invoked"); },
    getPrototypeOf() { invoked++; throw new Error("payload proxy prototype invoked"); },
    ownKeys() { invoked++; throw new Error("payload proxy keys invoked"); },
  });
  const toJSONPayload = {
    model: "native-fixture",
    input: [],
    toJSON() { invoked++; throw new Error("payload toJSON invoked"); },
  };
  const executePayload = {
    model: "native-fixture",
    input: [],
    tools: [{ name: "unsafe", execute() { invoked++; throw new Error("payload execute invoked"); } }],
  };
  const cyclicPayload = { model: "native-fixture", input: [] };
  cyclicPayload.self = cyclicPayload;
  const unsafePrototypePayload = Object.assign(
    Object.create({ inherited: "not plain data" }), { model: "native-fixture", input: [] });
  const payloads = [
    getterPayload,
    proxyPayload,
    toJSONPayload,
    executePayload,
    cyclicPayload,
    unsafePrototypePayload,
  ];
  for (const payload of payloads) {
    const events = await fixture.run({ messages: [] }, observed => {
      hookCalls++;
      return observed;
    }, payload);
    assert.equal(events.at(-1)?.type, "error");
  }
  assert.equal(invoked, 0, "payload inspection never invokes caller-controlled traps or hooks");
  assert.equal(hookCalls, 0, "unsafe adapter payloads never reach the original observation hook");
  assert.deepEqual(fixture.counters, {
    providerCalls: payloads.length,
    reservations: 0,
    physicalFetches: 0,
  });
  assert.deepEqual(fixture.bodies, []);
});

test("request channel retains only the immutable last settled native witness and UNKNOWN poisons observation", async t => {
  const root = await disposableRoot(t);
  const open = async (name, limit = 2, sharedBudget) => {
    const budget = sharedBudget ?? createGoalRequestBudget(limit);
    const stopped = new AbortController();
    const request = await openGoalRequestBudgetChannel({
      directory: join(root, `r-${goalHash(name).slice(0, 8)}`), evidenceRoot: join(root, `${name}-evidence`),
      identity: { test: name }, attemptKey: name, model: "fixture/model", budget,
      current: async () => `${name}-authority`, live() {}, stopped: stopped.signal,
      captureNativeReads: true,
    });
    t.after(async () => { await request.drain().catch(() => undefined); });
    const extension = await readFile(request.extensionPath, "utf8");
    const marker = "registerGoalRequestBudget(pi, ";
    const binding = JSON.parse(extension.slice(extension.indexOf(marker) + marker.length,
      extension.lastIndexOf(', "fixture/model", true);')));
    return { request, binding };
  };
  const source = await nativeReadFixture(t, root, "native-request-source", "native-request-settled");
  const sourceParams = { path: "single.txt" };
  const sourceResult = await source.read.execute("native-request-read", sourceParams);
  const witness = captureGoalNativeReadWitness({
    messages: nativeReadTurn("native-request-read", sourceParams, sourceResult),
  }, "native-request-settled");
  const settled = await open("native-request-settled", 2);
  const session = await openGoalAuthenticatedLocalSession(settled.binding);
  const exchange = (id, commitment, action, known, nativeReadWitness) => session.exchange({
    id, commitment, action, ...(known === undefined ? {} : { known }),
    ...(nativeReadWitness === undefined ? {} : { nativeReadWitness }),
  }, { operationId: id, fingerprint: commitment });
  const commitment = goalHash({ test: "native-request-settled" });
  await exchange("request-1", commitment, "reserve", undefined, witness);
  await exchange("request-1", commitment, "release");
  await exchange("request-1", commitment, "settle", true);
  const reducedWitness = captureGoalNativeReadWitness({ messages: [] }, "native-request-settled");
  const reducedCommitment = goalHash({ test: "native-request-reduced" });
  await exchange("request-2", reducedCommitment, "reserve", undefined, reducedWitness);
  await exchange("request-2", reducedCommitment, "release");
  await exchange("request-2", reducedCommitment, "settle", true);
  assert.throws(() => settled.request.lastSettledNativeReadWitness(), /successful.*drain/);
  await session.close();
  await settled.request.drain();
  assert.deepEqual(settled.request.lastSettledNativeReadWitness(), reducedWitness,
    "the last physical request cannot inherit fuller earlier native context");
  assert.equal(Object.isFrozen(settled.request.lastSettledNativeReadWitness()), true);
  const sourceExpected = (await source.workspace.inspectCandidate()).files.filter(file => file.path === "single.txt");
  assert.throws(() => source.opened.assertNativeReadCoverage(
    sourceExpected, settled.request.lastSettledNativeReadWitness()), /incomplete/);

  const unknown = await open("native-request-unknown");
  const unknownSession = await openGoalAuthenticatedLocalSession(unknown.binding);
  const unknownWitness = captureGoalNativeReadWitness({ messages: [] }, "native-request-unknown");
  const firstCommitment = goalHash({ test: "known-first" });
  const first = (action, known) => unknownSession.exchange({
    id: "known-first", commitment: firstCommitment, action, ...(known === undefined ? {} : { known }),
    ...(action === "reserve" ? { nativeReadWitness: unknownWitness } : {}),
  }, { operationId: "known-first", fingerprint: firstCommitment });
  await first("reserve"); await first("release"); await first("settle", true);
  const lostCommitment = goalHash({ test: "lost-second" });
  await unknownSession.exchange({
    id: "lost-second", commitment: lostCommitment, action: "reserve", nativeReadWitness: unknownWitness,
  }, { operationId: "lost-second", fingerprint: lostCommitment });
  await assert.rejects(unknownSession.exchange({
    id: "lost-second", commitment: lostCommitment, action: "release", nativeReadWitness: {
      ...unknownWitness, contextRoot: "0".repeat(64),
    },
  }, { operationId: "lost-second", fingerprint: lostCommitment }),
  /^Error: Goal authenticated frame truncated or trailing$/);
  await unknownSession.close().catch(() => undefined);
  await assert.rejects(unknown.request.drain(), /UNKNOWN|unsettled/);
  assert.throws(() => unknown.request.lastSettledNativeReadWitness(), /successful.*drain/);

  const sharedBudget = createGoalRequestBudget(2);
  const own = await open("native-own", 2, sharedBudget);
  const sibling = await open("native-sibling", 2, sharedBudget);
  const ownSession = await openGoalAuthenticatedLocalSession(own.binding);
  const siblingSession = await openGoalAuthenticatedLocalSession(sibling.binding);
  const ownWitness = captureGoalNativeReadWitness({ messages: [] }, "native-own");
  const siblingWitness = captureGoalNativeReadWitness({ messages: [] }, "native-sibling");
  const send = (session, id, action, witness) => {
    const commitment = goalHash({ test: id });
    return session.exchange({
      id, commitment, action, ...(action === "reserve" ? { nativeReadWitness: witness } : {}),
      ...(action === "settle" ? { known: true } : {}),
    }, { operationId: id, fingerprint: commitment });
  };
  try {
    await send(ownSession, "own", "reserve", ownWitness);
    await send(ownSession, "own", "release");
    await send(ownSession, "own", "settle");
    await send(siblingSession, "sibling", "reserve", siblingWitness);
    await send(siblingSession, "sibling", "release");
    await ownSession.close();
    await own.request.drain();
    assert.deepEqual(own.request.lastSettledNativeReadWitness(), ownWitness,
      "an unrelated live prefix does not replace or invalidate this original settled request");
    await siblingSession.close();
    await assert.rejects(sibling.request.drain(), /UNKNOWN|unsettled/);
    assert.throws(() => own.request.lastSettledNativeReadWitness(), /UNKNOWN|unsettled/,
      "a later shared-budget UNKNOWN still poisons the previously observed prefix");
  } finally {
    await ownSession.close().catch(() => undefined);
    await siblingSession.close().catch(() => undefined);
  }
});

test("source request settlement lost before its authenticated result ACK becomes sticky UNKNOWN", { timeout: 10_000 }, async () => {
  const attemptKey = "native-lost-settle-ack";
  const fixture = await openRawNativeSettlementFixture(attemptKey, async () => "original-authority");
  let raw;
  try {
    raw = await openRawGoalSession(fixture.binding);
    const id = "lost-settle-ack";
    const commitment = goalHash({ test: id });
    const witness = captureGoalNativeReadWitness({ messages: [] }, attemptKey);
    await raw.exchange({ id, commitment, action: "reserve", nativeReadWitness: witness });
    await raw.exchange({ id, commitment, action: "release" });
    assert.equal((await readOnlyRequestReceipt(fixture.evidenceRoot)).phase, "released",
      "the unrelated release exchange completed its authentic ACK");

    const settlement = await raw.begin({ id, commitment, action: "settle", known: true });
    assert.deepEqual(settlement.result.payload, { status: "acknowledged" });
    assert.equal((await readOnlyRequestReceipt(fixture.evidenceRoot)).phase, "released",
      "settlement result does not publish terminal evidence before its ACK");
    await raw.close();
    await assert.rejects(fixture.request.drain(), /UNKNOWN|unsettled/);

    const receipt = await readOnlyRequestReceipt(fixture.evidenceRoot);
    assert.equal(receipt.phase, "unknown");
    assert.equal(await fixture.budget.settledRequestCount(), null);
    assert.throws(() => fixture.request.lastSettledNativeReadWitness(), /successful.*drain/);
  } finally {
    await raw?.close().catch(() => undefined);
    await fixture.request.drain().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("source request authentic ACK completes witness publication before a lost final settled envelope", { timeout: 10_000 }, async () => {
  const attemptKey = "native-lost-final";
  let holdAcknowledgement = false;
  let acknowledgementChecks = 0;
  let enteredResolve;
  let releaseResolve;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const release = new Promise(resolve => { releaseResolve = resolve; });
  const fixture = await openRawNativeSettlementFixture(attemptKey, async () => {
    if (holdAcknowledgement && ++acknowledgementChecks === 2) {
      holdAcknowledgement = false;
      enteredResolve();
      await release;
    }
    return "original-authority";
  });
  let raw;
  try {
    raw = await openRawGoalSession(fixture.binding);
    const id = "lost-final-envelope";
    const commitment = goalHash({ test: id });
    const witness = captureGoalNativeReadWitness({ messages: [] }, attemptKey);
    await raw.exchange({ id, commitment, action: "reserve", nativeReadWitness: witness });
    await raw.exchange({ id, commitment, action: "release" });
    const released = await readOnlyRequestReceipt(fixture.evidenceRoot);
    assert.equal(released.phase, "released");
    const prefix = released.id.slice(0, released.id.indexOf(":"));

    const settlement = await raw.begin({ id, commitment, action: "settle", known: true });
    holdAcknowledgement = true;
    raw.sendAcknowledgement(settlement);
    await entered;
    assert.throws(() => fixture.budget.lastSettledNativeReadWitness(prefix), /settled original request custody/,
      "reentrant observation cannot expose a witness while post-publication ACK currentness is held");
    assert.equal((await readOnlyRequestReceipt(fixture.evidenceRoot)).phase, "settled",
      "the authentic ACK publication is durable while its final currentness check remains nonterminal");
    releaseResolve();
    assert.equal(await fixture.budget.settledRequestCount(), 1,
      "the original authenticated ACK completes publication before transport loss");
    assert.equal((await readOnlyRequestReceipt(fixture.evidenceRoot)).phase, "settled");

    await raw.close();
    await fixture.request.drain();
    assert.deepEqual(fixture.request.lastSettledNativeReadWitness(), witness);
  } finally {
    releaseResolve();
    await raw?.close().catch(() => undefined);
    await fixture.request.drain().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("source request ACK with changed currentness cannot expose a native witness", { timeout: 10_000 }, async () => {
  const attemptKey = "native-changed-ack";
  let authority = "original-authority";
  let observeFailedAcknowledgement = false;
  let fixture;
  let prefix = "";
  fixture = await openRawNativeSettlementFixture(attemptKey, async () => {
    if (observeFailedAcknowledgement) {
      observeFailedAcknowledgement = false;
      assert.throws(() => fixture.budget.lastSettledNativeReadWitness(prefix), /settled original request custody/,
        "failed ACK currentness cannot expose a settling witness reentrantly");
    }
    return authority;
  });
  let raw;
  try {
    raw = await openRawGoalSession(fixture.binding);
    const id = "changed-currentness";
    const commitment = goalHash({ test: id });
    const witness = captureGoalNativeReadWitness({ messages: [] }, attemptKey);
    await raw.exchange({ id, commitment, action: "reserve", nativeReadWitness: witness });
    await raw.exchange({ id, commitment, action: "release" });
    const released = await readOnlyRequestReceipt(fixture.evidenceRoot);
    assert.equal(released.phase, "released");
    prefix = released.id.slice(0, released.id.indexOf(":"));

    const settlement = await raw.begin({ id, commitment, action: "settle", known: true });
    const finalEnvelope = raw.readSettlement(settlement);
    authority = "changed-authority";
    observeFailedAcknowledgement = true;
    raw.sendAcknowledgement(settlement);
    await assert.rejects(finalEnvelope, /closed|ended/);
    await raw.close().catch(() => undefined);
    await assert.rejects(fixture.request.drain(), /UNKNOWN|unsettled/);

    assert.equal((await readOnlyRequestReceipt(fixture.evidenceRoot)).phase, "unknown");
    assert.equal(await fixture.budget.settledRequestCount(), null);
    assert.throws(() => fixture.budget.lastSettledNativeReadWitness(prefix), /UNKNOWN|unsettled/);
    assert.throws(() => fixture.request.lastSettledNativeReadWitness(), /successful.*drain/);
  } finally {
    await raw?.close().catch(() => undefined);
    await fixture.request.drain().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true });
  }
});
