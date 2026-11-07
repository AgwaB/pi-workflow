import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, connect, type Server as NetServer, type Socket } from "node:net";
import { link, lstat, rename, unlink } from "node:fs/promises";
import ssh2, { type Connection, type Channel } from "ssh2";

const { Client, Server, utils } = ssh2;

const USERNAME = "goal-local";
const SUBSYSTEM = "pi-workflow-goal-v1";
const DEFAULT_LIMIT = 32_768;
export const GOAL_AUTHENTICATED_RESPONSE_LIMIT = 131_072;
const FRAME_OVERHEAD = 2_048;
export const GOAL_AUTHENTICATED_ACTIVE_TIMEOUT = 30_000;
const SSH_ED25519 = Buffer.from("ssh-ed25519");

function sshString(value: Buffer): Buffer {
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(value.length);
  return Buffer.concat([length, value]);
}

function opensshPrivateKey(publicKey: Buffer, privateSeed: Buffer): Buffer {
  if (publicKey.length !== 32 || privateSeed.length !== 32)
    throw new Error("Goal Ed25519 host key has an invalid raw key length");
  const privateJwk = { kty: "OKP", crv: "Ed25519", x: publicKey.toString("base64url"), d: privateSeed.toString("base64url") };
  const privateObject = createPrivateKey({ key: privateJwk, format: "jwk" });
  const derivedPublic = Buffer.from(createPublicKey(privateObject).export({ format: "jwk" }).x!, "base64url");
  if (!timingSafeEqual(publicKey, derivedPublic))
    throw new Error("Goal Ed25519 host key public/private material does not match");
  const publicBlob = Buffer.concat([sshString(SSH_ED25519), sshString(publicKey)]);
  const check = randomBytes(4);
  const privateBlock = Buffer.concat([
    check, check, sshString(SSH_ED25519), sshString(publicKey), sshString(Buffer.concat([privateSeed, publicKey])),
    sshString(Buffer.from("pi-workflow-goal")),
  ]);
  const paddingLength = 8 - (privateBlock.length % 8);
  const padding = Buffer.allocUnsafe(paddingLength);
  for (let i = 0; i < paddingLength; i++) padding[i] = i + 1;
  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0"), sshString(Buffer.from("none")), sshString(Buffer.from("none")), sshString(Buffer.alloc(0)),
    Buffer.from([0, 0, 0, 1]), sshString(publicBlob), sshString(Buffer.concat([privateBlock, padding])),
  ]);
  return Buffer.from(`-----BEGIN OPENSSH PRIVATE KEY-----\n${body.toString("base64").match(/.{1,70}/g)!.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`);
}

export function createGoalAuthenticatedLocalHostKey(publicKey: Buffer, privateSeed: Buffer): Buffer {
  return opensshPrivateKey(publicKey, privateSeed);
}

export function generateGoalAuthenticatedLocalHostKey(): Buffer {
  const generated = generateKeyPairSync("ed25519");
  const publicJwk = createPublicKey(generated.privateKey).export({ format: "jwk" });
  const privateJwk = generated.privateKey.export({ format: "jwk" });
  return opensshPrivateKey(Buffer.from(publicJwk.x!, "base64url"), Buffer.from(privateJwk.d!, "base64url"));
}

type Json = Record<string, unknown>;
type Phase = "request" | "result" | "ack" | "settled";
type Frame = { version: 1; attemptKey: string; channelId: string; operationId: string; fingerprint: string; nonce: string; phase: Phase; payload: Json; digest: string };

export interface GoalAuthenticatedLocalClient {
  socketPath: string; attemptKey: string; channelId: string; secret: string; hostKeyPin: string;
}
export interface GoalAuthenticatedLocalSession {
  exchange(payload: Json, identity: { operationId: string; fingerprint: string }, signal?: AbortSignal): Promise<Json>;
  close(): Promise<void>;
}
export function goalAuthenticatedRequestWasSent(error: unknown): boolean {
  return error instanceof Error && (error as Error & { requestSent?: boolean }).requestSent === true;
}
export interface GoalAuthenticatedLocalPeer { readonly connection: symbol }
export interface GoalAuthenticatedLocalServer extends GoalAuthenticatedLocalClient { drain(): Promise<void> }

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const safeEqual = (left: Buffer, right: Buffer) => left.length === right.length && timingSafeEqual(left, right);
function exact(value: unknown, keys: readonly string[]): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}
function parse(bytes: Buffer, maximum: number, expected: Omit<Frame, "payload" | "digest">, expectedPayloadKeys?: readonly string[]): Frame {
  if (bytes.length > maximum) throw new Error("Goal authenticated frame exceeds payload bound");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Goal authenticated frame malformed"); }
  if (!exact(value, ["version", "attemptKey", "channelId", "operationId", "fingerprint", "nonce", "phase", "payload", "digest"]) ||
      value.version !== 1 || value.attemptKey !== expected.attemptKey || value.channelId !== expected.channelId ||
      (expected.operationId !== "" && value.operationId !== expected.operationId) ||
      (expected.fingerprint !== "" && value.fingerprint !== expected.fingerprint) ||
      (expected.nonce !== "" && value.nonce !== expected.nonce) || value.phase !== expected.phase ||
      typeof value.attemptKey !== "string" || value.attemptKey.length > 256 ||
      typeof value.operationId !== "string" || value.operationId.length < 1 || value.operationId.length > 256 ||
      typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.fingerprint) ||
      typeof value.nonce !== "string" || !/^[a-f0-9]{48}$/.test(value.nonce) ||
      typeof value.payload !== "object" || value.payload === null || Array.isArray(value.payload) ||
      (expectedPayloadKeys && !exact(value.payload, expectedPayloadKeys)) || typeof value.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.digest) || value.digest !== sha(value.payload) || Buffer.from(JSON.stringify(value)).compare(bytes) !== 0)
    throw new Error("Goal authenticated frame binding/canonical encoding mismatch");
  return value as Frame;
}
function encode(descriptor: GoalAuthenticatedLocalClient, operationId: string, fingerprint: string, nonce: string, phase: Phase, payload: Json, maxPayload: number): Buffer {
  const value: Frame = { version: 1, attemptKey: descriptor.attemptKey, channelId: descriptor.channelId, operationId, fingerprint, nonce, phase, payload, digest: sha(payload) };
  const body = Buffer.from(JSON.stringify(value));
  if (Buffer.byteLength(JSON.stringify(payload)) > maxPayload) throw new Error("Goal authenticated payload exceeds bound");
  const prefix = Buffer.allocUnsafe(4); prefix.writeUInt32BE(body.length);
  return Buffer.concat([prefix, body]);
}
class Frames {
  #buffer = Buffer.alloc(0); #failure?: Error; #ended = false;
  #waiters: Array<{ resolve(value: Buffer): void; reject(error: Error): void; partialTimeout: boolean }> = [];
  constructor(private readonly stream: Channel, private readonly maximumFrame: number) {
    stream.on("data", (chunk: Buffer) => {
      if (this.#failure) return;
      if (this.#waiters.length === 0) { this.fail(new Error("Goal authenticated unsolicited/trailing frame")); stream.destroy(); return; }
      if (this.#buffer.length === 0 && this.#waiters[0]!.partialTimeout) {
        this.#partialTimer = setTimeout(() => { this.fail(new Error("Goal authenticated partial frame timed out")); stream.destroy(); }, GOAL_AUTHENTICATED_ACTIVE_TIMEOUT);
      }
      const length = this.#buffer.length + chunk.length;
      if (length > this.maximumFrame + 4) { this.fail(new Error("Goal authenticated frame buffer exceeds bound")); stream.destroy(); return; }
      this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : Buffer.from(chunk);
      this.flush();
    });
    stream.on("error", (error: Error) => this.fail(error));
    stream.on("end", () => { this.#ended = true; this.flush(); });
    stream.on("close", () => { this.#ended = true; this.flush(); });
  }
  #partialTimer?: NodeJS.Timeout;
  read(signal?: AbortSignal, partialTimeout = false): Promise<Buffer> {
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#ended) { this.fail(new Error("Goal authenticated stream closed")); return Promise.reject(this.#failure); }
    if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Goal exchange aborted"));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, partialTimeout }; this.#waiters.push(waiter);
      const abort = () => {
        const i = this.#waiters.indexOf(waiter);
        if (i >= 0) this.#waiters.splice(i, 1);
        if (!this.#waiters.length && this.#partialTimer) { clearTimeout(this.#partialTimer); this.#partialTimer = undefined; }
        reject(signal?.reason instanceof Error ? signal.reason : new Error("Goal exchange aborted"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      const wrapped = waiter.resolve;
      waiter.resolve = value => { signal?.removeEventListener("abort", abort); wrapped(value); };
      const wrappedReject = waiter.reject;
      waiter.reject = error => { signal?.removeEventListener("abort", abort); wrappedReject(error); };
      this.flush();
    });
  }
  fail(error: Error): void {
    if (this.#failure) return; this.#failure = error;
    if (this.#partialTimer) { clearTimeout(this.#partialTimer); this.#partialTimer = undefined; }
    while (this.#waiters.length) this.#waiters.shift()!.reject(error);
  }
  private flush(): void {
    if (this.#failure) return;
    while (this.#waiters.length && this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32BE(0);
      if (!length || length > this.maximumFrame) { this.fail(new Error("Goal authenticated frame length invalid")); this.stream.destroy(); return; }
      if (this.#buffer.length < length + 4) break;
      const body = this.#buffer.subarray(4, length + 4);
      this.#buffer = this.#buffer.subarray(length + 4);
      if (this.#buffer.length) { this.fail(new Error("Goal authenticated coalesced/trailing frame")); this.stream.destroy(); return; }
      if (this.#partialTimer) { clearTimeout(this.#partialTimer); this.#partialTimer = undefined; }
      this.#waiters.shift()!.resolve(body);
    }
    if (this.#ended) {
      if (this.#buffer.length || this.#waiters.length) this.fail(new Error("Goal authenticated frame truncated or trailing"));
    }
  }
}

export async function openGoalAuthenticatedLocalChannel(input: {
  socketPath: string; attemptKey: string; stopped: AbortSignal; requestLimit?: number;
  onRequest(payload: Json, peer: GoalAuthenticatedLocalPeer): Promise<Json>;
  onAcknowledged(payload: Json, result: Json, peer: GoalAuthenticatedLocalPeer): Promise<Json>;
  onDisconnect?(peer: GoalAuthenticatedLocalPeer): Promise<void> | void;
}): Promise<GoalAuthenticatedLocalServer> {
  const hostKey = generateGoalAuthenticatedLocalHostKey();
  const parsed = utils.parseKey(hostKey);
  if (parsed instanceof Error || Array.isArray(parsed))
    throw new Error("Goal SSH host key generation failed", { cause: parsed });
  const descriptor: GoalAuthenticatedLocalClient = Object.freeze({ socketPath: input.socketPath, attemptKey: input.attemptKey,
    channelId: randomBytes(24).toString("hex"), secret: randomBytes(32).toString("hex"),
    hostKeyPin: createHash("sha256").update(parsed.getPublicSSH()).digest("hex") });
  const sockets = new Set<Socket>(), connections = new Set<Connection>(), inFlight = new Set<Connection>(), work = new Set<Promise<unknown>>();
  let closed = false, draining: Promise<void> | undefined;
  const track = (promise: Promise<unknown>) => { work.add(promise); void promise.then(() => work.delete(promise), () => work.delete(promise)); };
  const server = new Server({ hostKeys: [hostKey], ident: "SSH-2.0-pi-workflow-goal" }, connection => {
    const peer: GoalAuthenticatedLocalPeer = Object.freeze({ connection: Symbol("authenticated-goal-peer") });
    connections.add(connection); connection.once("close", () => connections.delete(connection)); connection.on("error", () => {});
    connection.once("close", () => { track(Promise.resolve().then(() => input.onDisconnect?.(peer))); });
    connection.on("authentication", context => {
      if (closed || input.stopped.aborted) { context.reject(); return; }
      let valid = false;
      if (context.method === "password" && context.username === USERNAME && typeof context.password === "string")
        valid = safeEqual(Buffer.from(context.password), Buffer.from(descriptor.secret));
      if (valid) context.accept(); else context.reject(["password"]);
    });
    connection.on("tcpip", (_accept, reject) => reject());
    connection.on("openssh.streamlocal", (_accept, reject) => reject());
    connection.on("request", (_accept, reject) => reject?.());
    connection.on("ready", () => connection.on("session", (accept, reject) => {
      if (closed) { reject(); return; }
      const session = accept();
      session.on("pty", (_accept, deny) => deny()); session.on("env", (_accept, deny) => deny());
      session.on("window-change", (_accept, deny) => deny()); session.on("signal", (_accept, deny) => deny());
      session.on("shell", (_accept, deny) => deny()); session.on("exec", (_accept, deny) => deny());
      session.on("sftp", (_accept, deny) => deny()); session.on("x11", (_accept, deny) => deny());
      session.on("auth-agent", (_accept, deny) => deny());
      session.on("subsystem", (acceptSubsystem, deny, info) => {
        if (info.name !== SUBSYSTEM || closed) { deny(); return; }
        const channel = acceptSubsystem(); channel.on("error", () => {});
        const frames = new Frames(channel, GOAL_AUTHENTICATED_RESPONSE_LIMIT + FRAME_OVERHEAD);
        track((async () => {
          let exchanges = 0, first = true;
          try {
            while (!closed) {
              const bytes = first ? await active(frames, input.stopped) : await frames.read(input.stopped, true);
              first = false;
              const request = parse(bytes, GOAL_AUTHENTICATED_RESPONSE_LIMIT + FRAME_OVERHEAD,
                { version: 1, attemptKey: descriptor.attemptKey, channelId: descriptor.channelId,
                  operationId: "", fingerprint: "", nonce: "", phase: "request" });
              if (Buffer.byteLength(JSON.stringify(request.payload)) > (input.requestLimit ?? DEFAULT_LIMIT))
                throw new Error("Goal authenticated request payload exceeds bound");
              const { operationId, fingerprint, nonce } = request;
              const identity = { version: 1 as const, attemptKey: descriptor.attemptKey, channelId: descriptor.channelId, operationId, fingerprint, nonce };
              inFlight.add(connection);
              const requestWork = Promise.resolve().then(() => input.onRequest(request.payload, peer));
              track(requestWork);
              const result = await timed(() => requestWork, input.stopped);
              channel.write(encode(descriptor, operationId, fingerprint, nonce, "result", result, GOAL_AUTHENTICATED_RESPONSE_LIMIT));
              const ack = parse(await active(frames, input.stopped), DEFAULT_LIMIT + FRAME_OVERHEAD, { ...identity, phase: "ack" }, ["resultDigest"]);
              if (ack.payload.resultDigest !== sha(result)) throw new Error("Goal authenticated acknowledgement digest mismatch");
              const ackWork = Promise.resolve().then(() => input.onAcknowledged(request.payload, result, peer));
              track(ackWork);
              const settled = await timed(() => ackWork, input.stopped);
              channel.write(encode(descriptor, operationId, fingerprint, nonce, "settled", settled, GOAL_AUTHENTICATED_RESPONSE_LIMIT));
              inFlight.delete(connection);
              exchanges++;
              if (exchanges > 10_000) throw new Error("Goal authenticated session exchange ceiling exceeded");
            }
          } catch { inFlight.delete(connection); channel.destroy(); }
        })());
      });
    }));
  });
  const listener: NetServer = createServer(socket => {
    sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket));
    if (closed) { socket.destroy(); return; } server.injectSocket(socket);
  });
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(input.socketPath, resolve); });
  const originalEndpoint = await lstat(input.socketPath);
  const endpointIdentity = { dev: originalEndpoint.dev, ino: originalEndpoint.ino };
  const drain = () => draining ??= (async () => {
    closed = true;
    let quarantine: string | undefined;
    let quarantinedIdentity: { dev: number; ino: number; mode: number; nlink: number } | undefined;
    try {
      const current = await lstat(input.socketPath);
      if (current.dev !== endpointIdentity.dev || current.ino !== endpointIdentity.ino) {
        for (let attempt = 0; attempt < 8; attempt++) {
          const candidate = `${input.socketPath}.goal-retired-${randomBytes(16).toString("hex")}`;
          try { await lstat(candidate); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            await rename(input.socketPath, candidate);
            quarantine = candidate;
            const moved = await lstat(candidate);
            if (moved.dev !== current.dev || moved.ino !== current.ino ||
                moved.mode !== current.mode || moved.nlink !== current.nlink)
              throw new Error(`Goal endpoint quarantine identity changed; retained at ${candidate}`);
            quarantinedIdentity = current;
            break;
          }
        }
        if (!quarantine) throw new Error("Goal endpoint quarantine path could not be reserved");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const listenerClosed = new Promise<void>(resolve => listener.close(() => resolve()));
    await new Promise<void>(resolve => setImmediate(resolve));
    const ownedConnections = [...connections], ownedSockets = [...sockets];
    const activeConnections = new Set(ownedConnections.filter(connection => inFlight.has(connection)));
    const connectionClosures = ownedConnections.map(connection => new Promise<void>(resolve => connection.once("close", resolve)));
    const socketClosures = ownedSockets.map(socket => new Promise<void>(resolve => socket.destroyed ? resolve() : socket.once("close", resolve)));
    for (const connection of ownedConnections) if (!activeConnections.has(connection)) connection.end();
    while (work.size) await Promise.all([...work]);
    for (const connection of activeConnections) connection.end();
    for (const socket of ownedSockets) socket.destroy();
    await Promise.all(connectionClosures);
    await Promise.all(socketClosures);
    await listenerClosed;
    while (work.size) await Promise.all([...work]);
    if (quarantine) {
      const retained = await lstat(quarantine);
      if (!quarantinedIdentity || retained.dev !== quarantinedIdentity.dev ||
          retained.ino !== quarantinedIdentity.ino || retained.mode !== quarantinedIdentity.mode ||
          retained.nlink !== quarantinedIdentity.nlink)
        throw new Error(`Goal endpoint quarantine identity changed; retained at ${quarantine}`);
      try { await link(quarantine, input.socketPath); }
      catch (cause) {
        throw new Error(`Goal endpoint restoration failed without replacement; retained at ${quarantine}`, { cause });
      }
      const restored = await lstat(input.socketPath), held = await lstat(quarantine);
      if (restored.dev !== retained.dev || restored.ino !== retained.ino ||
          held.dev !== retained.dev || held.ino !== retained.ino ||
          held.nlink !== retained.nlink + 1 || restored.nlink !== held.nlink)
        throw new Error(`Goal endpoint restoration identity changed; retained at ${quarantine}`);
      await unlink(quarantine);
    }
  })();
  const abort = () => { void drain().catch(() => undefined); }; input.stopped.addEventListener("abort", abort, { once: true });
  return Object.freeze({ ...descriptor, drain: async () => { await drain(); input.stopped.removeEventListener("abort", abort); } });
}
async function timed<T>(run: () => Promise<T>, stopped: AbortSignal): Promise<T> {
  stopped.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Goal authenticated exchange timed out")), GOAL_AUTHENTICATED_ACTIVE_TIMEOUT);
      abort = () => reject(stopped.reason instanceof Error ? stopped.reason : new Error("Goal exchange aborted"));
      stopped.addEventListener("abort", abort, { once: true });
      // The caller retains ownership of run(); timeout ends only observation.
      run().then(resolve, reject);
    });
  } finally {
    clearTimeout(timer);
    if (abort) stopped.removeEventListener("abort", abort);
  }
}
async function active(frames: Frames, stopped: AbortSignal): Promise<Buffer> {
  stopped.throwIfAborted();
  const controller = new AbortController();
  return await new Promise<Buffer>((resolve, reject) => {
    const timeout = setTimeout(() => {
      const error = new Error("Goal authenticated exchange timed out"); controller.abort(error); reject(error);
    }, GOAL_AUTHENTICATED_ACTIVE_TIMEOUT);
    const abort = () => {
      const error = stopped.reason instanceof Error ? stopped.reason : new Error("Goal exchange aborted");
      controller.abort(error); reject(error);
    };
    stopped.addEventListener("abort", abort, { once: true });
    frames.read(controller.signal).then(resolve, reject).finally(() => {
      clearTimeout(timeout); stopped.removeEventListener("abort", abort);
    });
  });
}

export async function openGoalAuthenticatedLocalSession(client: GoalAuthenticatedLocalClient, signal?: AbortSignal): Promise<GoalAuthenticatedLocalSession> {
  signal?.throwIfAborted();
  const endpoint = await lstat(client.socketPath); if (!endpoint.isSocket()) throw new Error("Goal channel endpoint is not a Unix socket");
  const socket = connect({ path: client.socketPath }); const ssh = new Client(); let stream: Channel | undefined, frames: Frames | undefined, closed = false;
  let started = false;
  const sshClosed = new Promise<void>(resolve => ssh.once("close", resolve));
  const socketClosed = new Promise<void>(resolve => socket.once("close", resolve));
  let abortSession: (() => void) | undefined;
  const close = () => {
    if (closed) return; closed = true;
    if (abortSession) signal?.removeEventListener("abort", abortSession);
    socket.destroy(); ssh.end();
  };
  const connected = new Promise<void>((resolve, reject) => {
    const fail = (error: Error) => { if (!closed) reject(error); };
    ssh.on("error", fail); socket.on("error", fail);
    ssh.once("ready", () => ssh.subsys(SUBSYSTEM, (error, channel) => { if (error) fail(error); else { stream = channel; channel.on("error", fail); frames = new Frames(channel, GOAL_AUTHENTICATED_RESPONSE_LIMIT + FRAME_OVERHEAD); resolve(); } }));
    socket.once("connect", () => { started = true; ssh.connect({ sock: socket, username: USERNAME, password: client.secret, authHandler: ["password"],
      hostVerifier: (key: Buffer) => safeEqual(createHash("sha256").update(key).digest(), Buffer.from(client.hostKeyPin, "hex")),
      readyTimeout: GOAL_AUTHENTICATED_ACTIVE_TIMEOUT, algorithms: { serverHostKey: ["ssh-ed25519"] } }); });
    abortSession = () => {
      const reason = signal?.reason instanceof Error ? signal.reason : new Error("Goal authenticated session aborted");
      close(); fail(reason);
    };
    signal?.addEventListener("abort", abortSession, { once: true });
  });
  try { await timed(() => connected, signal ?? new AbortController().signal); }
  catch (error) {
    close(); await socketClosed;
    if (started) await sshClosed;
    throw error;
  }
  let chain = Promise.resolve();
  return {
    exchange(payload, identity, exchangeSignal) {
      const { operationId, fingerprint } = identity;
      if (typeof operationId !== "string" || operationId.length < 1 || operationId.length > 256 ||
          typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint))
        return Promise.reject(new Error("Goal authenticated operation fingerprint invalid"));
      const nonce = randomBytes(24).toString("hex");
      let requestSent = false;
      const task = chain.then(async () => {
        if (closed || !stream || !frames) throw new Error("Goal authenticated session closed");
        const max = Buffer.byteLength(JSON.stringify(payload));
        const request = encode(client, operationId, fingerprint, nonce, "request", payload, max);
        stream.write(request);
        requestSent = true;
        const identity = { version: 1 as const, attemptKey: client.attemptKey, channelId: client.channelId, operationId, fingerprint, nonce };
        const result = parse(await active(frames, exchangeSignal ?? signal ?? new AbortController().signal), GOAL_AUTHENTICATED_RESPONSE_LIMIT, { ...identity, phase: "result" });
        stream.write(encode(client, operationId, fingerprint, nonce, "ack", { resultDigest: result.digest }, 4096));
        const settled = parse(await active(frames, exchangeSignal ?? signal ?? new AbortController().signal), GOAL_AUTHENTICATED_RESPONSE_LIMIT, { ...identity, phase: "settled" });
        if (settled.payload.status === "acknowledged") return result.payload;
        if (settled.payload.status === "blocked" || settled.payload.status === "unknown") return settled.payload;
        throw new Error("Goal authenticated operation settlement rejected");
      });
      chain = task.then(() => undefined, error => {
        if (requestSent && error instanceof Error) Object.assign(error, { requestSent: true });
        close();
      });
      return task;
    },
    async close() {
      close(); let failure: unknown;
      try { await chain; } catch (error) { failure = error; }
      await Promise.all([sshClosed, socketClosed]);
      if (failure) throw failure;
    },
  };
}
export async function exchangeGoalAuthenticatedLocalChannel(client: GoalAuthenticatedLocalClient, payload: Json, signal?: AbortSignal): Promise<Json> {
  const session = await openGoalAuthenticatedLocalSession(client, signal);
  const operationId = `exchange-${randomBytes(16).toString("hex")}`;
  const fingerprint = sha(payload);
  try { return await session.exchange(payload, { operationId, fingerprint }, signal); } finally { await session.close(); }
}
