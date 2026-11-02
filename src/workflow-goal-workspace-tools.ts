import { createHash, randomBytes } from "node:crypto";
import { channel as diagnosticChannel } from "node:diagnostics_channel";
import { isDeepStrictEqual, types as utilTypes } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GoalWorkspaceHostHandle } from "./goal-workspace-host.js";
import type { GoalCandidateSourceReadContinuation, GoalCandidateSourceReadReceipt } from "./types.js";
import { GOAL_MAX_BYTES, goalHash, goalJson } from "./goal-json.js";
import { goalFileContentIdentity, goalFileValueCheck, goalWorkspacePathCheck, type GoalWorkspacePath } from "./goal-workspace.js";
import { writeJsonExclusive, writeJsonAtomicDurable, syncFileAndDirectory, outsideRunLeaseContext } from "./store.js";
import { createAssistantMessageEventStream, type Provider } from "@earendil-works/pi-ai";
import { exchangeGoalAuthenticatedLocalChannel, openGoalAuthenticatedLocalChannel, openGoalAuthenticatedLocalSession,
  GOAL_AUTHENTICATED_ACTIVE_TIMEOUT, GOAL_AUTHENTICATED_RESPONSE_LIMIT, goalAuthenticatedRequestWasSent,
  type GoalAuthenticatedLocalClient, type GoalAuthenticatedLocalPeer } from "./goal-authenticated-local-channel.js";

const requestDiagnostics = diagnosticChannel("pi-workflow:goal-request");
const candidateRequestDiagnostics = diagnosticChannel("pi-workflow:goal-candidate-request");
function publishCandidateReceived(metadata: Readonly<Record<string, string>>) {
  if (!candidateRequestDiagnostics.hasSubscribers) return;
  try { candidateRequestDiagnostics.publish(Object.freeze({ phase: "received", ...metadata })); }
  catch { /* Observation cannot authorize, reject, or reorder host work. */ }
}

export const GOAL_CANDIDATE_TOOLS = ["goal_candidate_read", "goal_candidate_write"] as const;
export type GoalCandidateTool = typeof GOAL_CANDIDATE_TOOLS[number];
export interface GoalCandidateToolChannel extends GoalAuthenticatedLocalClient { tools: readonly GoalCandidateTool[] }
type Result = Record<string, unknown>;
type Operation = { fingerprint: string; authority?: string; promise: Promise<Result>; result?: Result;
  phase: "pending" | "awaiting-ack" | "settled" | "unknown"; intent: unknown; path: string; owned: boolean;
  acknowledged: boolean; peer?: GoalAuthenticatedLocalPeer;
  sourceReceipt?: Readonly<GoalCandidateSourceReadReceipt>;
  sourceInvalidation?: { path: string; expectedDigest: string } };

const GOAL_NATIVE_READ_CONTENT_CHARS = 320_000;
const GOAL_NATIVE_CONTEXT_STRUCTURE_LIMIT = 4_096 * 16;
const GOAL_NATIVE_READ_HASH = /^[a-f0-9]{64}$/;
const GOAL_NATIVE_READ_SCHEMA = "goal-native-read-context-v1" as const;

export type GoalNativeReadWitness = Readonly<{
  schema: typeof GOAL_NATIVE_READ_SCHEMA;
  attemptRoot: string;
  contextRoot: string;
  readRoot: string;
  coverage: "none" | "complete" | "incomplete";
  readOperations: number;
  readToolResults: number;
  sourceChars: number;
  retainedToolResultChars: number;
}>;

type NativeReadLeaf = Readonly<{ operationId: string; hash: string; sourceChars: number }>;

function nativeReadAttemptRoot(attemptKey: string): string {
  return goalHash({ domain: "goal-native-read-attempt-v1", attemptKey });
}

const NATIVE_ASYNC_FUNCTION_PROTOTYPE = Object.getPrototypeOf(async function () {});

function assertSafeNativeToolExecute(value: unknown): void {
  if (typeof value !== "function")
    throw new Error("Goal native read tool execute is not a function");
  if (utilTypes.isProxy(value))
    throw new Error("Goal native read tool execute contains a proxy");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Function.prototype && prototype !== NATIVE_ASYNC_FUNCTION_PROTOTYPE)
    throw new Error("Goal native read tool execute has an unsafe prototype");
  if ((prototype === NATIVE_ASYNC_FUNCTION_PROTOTYPE &&
      Object.getPrototypeOf(prototype) !== Function.prototype) ||
      Object.getPrototypeOf(Function.prototype) !== Object.prototype ||
      Object.getPrototypeOf(Object.prototype) !== null)
    throw new Error("Goal native read tool execute has an unsafe prototype chain");
  for (const inherited of prototype === Function.prototype
    ? [Function.prototype, Object.prototype] : [prototype, Function.prototype, Object.prototype]) {
    if (Object.getOwnPropertyDescriptor(inherited, "toJSON") !== undefined)
      throw new Error("Goal native read tool execute contains inherited toJSON behavior");
  }
  const ownKeys = Reflect.ownKeys(value);
  const allowed = new Set(["length", "name", "arguments", "caller", "prototype"]);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (descriptors.toJSON !== undefined)
    throw new Error("Goal native read tool execute contains toJSON behavior");
  if (Object.values(descriptors).some(descriptor => !("value" in descriptor)))
    throw new Error("Goal native read tool execute contains an accessor");
  if (ownKeys.length > allowed.size || ownKeys.some(key => typeof key !== "string" || !allowed.has(key)))
    throw new Error("Goal native read tool execute contains unsafe metadata");
  const length = descriptors.length?.value;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 ||
      typeof descriptors.name?.value !== "string" ||
      descriptors.arguments !== undefined && descriptors.arguments.value !== null ||
      descriptors.caller !== undefined && descriptors.caller.value !== null)
    throw new Error("Goal native read tool execute has an invalid intrinsic shape");
  const callbackPrototype = descriptors.prototype?.value;
  if (callbackPrototype !== undefined) {
    if (callbackPrototype === null || typeof callbackPrototype !== "object" ||
        utilTypes.isProxy(callbackPrototype) ||
        Object.getPrototypeOf(callbackPrototype) !== Object.prototype)
      throw new Error("Goal native read tool execute has an unsafe callback prototype");
    const callbackPrototypeKeys = Reflect.ownKeys(callbackPrototype);
    const callbackPrototypeDescriptors = Object.getOwnPropertyDescriptors(callbackPrototype);
    if (callbackPrototypeKeys.length !== 1 || callbackPrototypeKeys[0] !== "constructor" ||
        !("value" in callbackPrototypeDescriptors.constructor) ||
        callbackPrototypeDescriptors.constructor.value !== value)
      throw new Error("Goal native read tool execute has unsafe callback prototype metadata");
  }
}

function assertSafeNativeContext(value: unknown): void {
  type Position = "context" | "tools" | "tool" | "execute" | "other";
  type Inspection = Readonly<{ value: unknown; position: Position; exiting?: true }>;
  const visiting = new WeakSet<object>();
  const done = new WeakMap<object, Set<Position>>();
  const pending: Inspection[] = [{ value, position: "context" }];
  let nodes = 0, keys = 0;
  while (pending.length) {
    const inspection = pending.pop()!;
    const current = inspection.value;
    if (inspection.position === "tools" && current !== undefined && !Array.isArray(current))
      throw new Error("Goal native read context tools must be an array");
    if (inspection.position === "tool" &&
        (current === null || typeof current !== "object" || Array.isArray(current)))
      throw new Error("Goal native read context tool must be a record");
    if (inspection.position === "execute") {
      assertSafeNativeToolExecute(current);
      continue;
    }
    if (current === null || current === undefined ||
        ["string", "number", "boolean"].includes(typeof current)) continue;
    if (typeof current === "function")
      throw new Error("Goal native read context contains a function");
    if (typeof current === "symbol")
      throw new Error("Goal native read context contains a symbol");
    if (typeof current === "bigint")
      throw new Error("Goal native read context contains a non-JSON primitive");
    if (typeof current !== "object")
      throw new Error("Goal native read context contains an unsupported value");
    if (inspection.exiting) {
      visiting.delete(current);
      const positions = done.get(current) ?? new Set<Position>();
      positions.add(inspection.position);
      done.set(current, positions);
      continue;
    }
    if (utilTypes.isProxy(current))
      throw new Error("Goal native read context contains a proxy");
    if (visiting.has(current))
      throw new Error("Goal native read context contains a cycle");
    if (done.get(current)?.has(inspection.position)) continue;
    const array = Array.isArray(current);
    const prototype = Object.getPrototypeOf(current);
    if (array ? prototype !== Array.prototype : ![Object.prototype, null].includes(prototype))
      throw new Error("Goal native read context contains a nonplain object");
    const prototypeToJSON = prototype === null ? undefined :
      Object.getOwnPropertyDescriptor(prototype, "toJSON");
    if (prototypeToJSON !== undefined)
      throw new Error("Goal native read context contains inherited toJSON behavior");
    const ownKeys = Reflect.ownKeys(current);
    nodes += 1; keys += ownKeys.length;
    if (nodes > GOAL_NATIVE_CONTEXT_STRUCTURE_LIMIT || keys > GOAL_NATIVE_CONTEXT_STRUCTURE_LIMIT)
      throw new Error("Goal native read context structure exceeds its inspection ceiling");
    const descriptors = Object.getOwnPropertyDescriptors(current);
    if (array) {
      const length = descriptors.length;
      if (!length || !("value" in length) || !Number.isSafeInteger(length.value) ||
          length.value < 0 || length.value > 4_096)
        throw new Error("Goal native read context contains an unbounded array");
    }
    visiting.add(current);
    pending.push({ value: current, position: inspection.position, exiting: true });
    for (let index = ownKeys.length - 1; index >= 0; index--) {
      const key = ownKeys[index];
      if (typeof key !== "string")
        throw new Error("Goal native read context contains a symbol");
      const descriptor = Object.getOwnPropertyDescriptor(descriptors, key)?.value as PropertyDescriptor | undefined;
      if (!descriptor || !("value" in descriptor))
        throw new Error("Goal native read context contains an accessor");
      if (key === "toJSON")
        throw new Error("Goal native read context contains toJSON behavior");
      if (!array || key !== "length") {
        const position: Position =
          inspection.position === "context" && key === "tools" ? "tools" :
          inspection.position === "tools" && /^(0|[1-9][0-9]*)$/.test(key) &&
            Number(key) < (descriptors.length?.value as number) ? "tool" :
          inspection.position === "tool" && key === "execute" ? "execute" : "other";
        pending.push({ value: descriptor.value, position });
      }
    }
  }
}

type NativePayloadContainer = Record<string, unknown> | unknown[];
type NativePayloadAssignment = (value: unknown) => void;

function inspectNativePayloadContainer(value: object, immutable: boolean): {
  array: boolean;
  descriptors: Record<string, PropertyDescriptor>;
  keys: string[];
} {
  if (utilTypes.isProxy(value))
    throw new Error("Goal request payload contains a proxy");
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : ![Object.prototype, null].includes(prototype))
    throw new Error("Goal request payload contains an unsafe prototype");
  if (Object.getPrototypeOf(Object.prototype) !== null ||
      Object.getPrototypeOf(Array.prototype) !== Object.prototype)
    throw new Error("Goal request payload intrinsic prototype chain changed");
  for (const inherited of array ? [Array.prototype, Object.prototype] : prototype === null ? [] : [Object.prototype]) {
    if (Object.getOwnPropertyDescriptor(inherited, "toJSON") !== undefined)
      throw new Error("Goal request payload contains inherited toJSON behavior");
  }
  if (immutable && (!Object.isFrozen(value) || (!array && prototype !== null)))
    throw new Error("Goal request payload snapshot is not recursively immutable plain data");
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some(key => typeof key !== "string"))
    throw new Error("Goal request payload contains a symbol");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = ownKeys as string[];
  if (array) {
    const length = descriptors.length;
    if (!length || !("value" in length) || !Number.isSafeInteger(length.value) ||
        length.value < 0 || length.value > GOAL_NATIVE_CONTEXT_STRUCTURE_LIMIT ||
        keys.length !== length.value + 1)
      throw new Error("Goal request payload contains an invalid or unbounded array");
    for (let index = 0; index < length.value; index++) {
      if (keys[index] !== String(index))
        throw new Error("Goal request payload contains a sparse or decorated array");
    }
    if (keys[keys.length - 1] !== "length")
      throw new Error("Goal request payload contains invalid array metadata");
  }
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor))
      throw new Error("Goal request payload contains an accessor");
    if (key === "toJSON")
      throw new Error("Goal request payload contains toJSON behavior");
    if (key !== "length" && !descriptor.enumerable)
      throw new Error("Goal request payload contains hidden metadata");
    if (immutable && (descriptor.configurable || descriptor.writable))
      throw new Error("Goal request payload snapshot is mutable");
  }
  return { array, descriptors, keys };
}

function assertNativePayloadPrimitive(value: unknown): void {
  if (value === null || value === undefined ||
      typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value === "function")
    throw new Error("Goal request payload contains a function");
  if (typeof value === "symbol")
    throw new Error("Goal request payload contains a symbol");
  if (typeof value === "bigint" || typeof value === "number")
    throw new Error("Goal request payload contains a non-JSON primitive");
  throw new Error("Goal request payload contains an unsupported value");
}

function snapshotGoalNativePayload(value: unknown): NativePayloadContainer {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Goal request payload must be a plain record");
  type Pending = Readonly<{
    source: unknown;
    assign: NativePayloadAssignment;
    exiting?: { source: object; target: NativePayloadContainer };
  }>;
  const state = new WeakMap<object, "visiting" | "done">();
  const clones = new WeakMap<object, NativePayloadContainer>();
  let snapshot: unknown;
  let nodes = 0, keys = 0;
  const pending: Pending[] = [{ source: value, assign: next => { snapshot = next; } }];
  while (pending.length) {
    const item = pending.pop()!;
    if (item.exiting) {
      state.set(item.exiting.source, "done");
      Object.freeze(item.exiting.target);
      continue;
    }
    const current = item.source;
    if (current === null || typeof current !== "object") {
      assertNativePayloadPrimitive(current);
      item.assign(current);
      continue;
    }
    const prior = state.get(current);
    if (prior === "visiting")
      throw new Error("Goal request payload contains a cycle");
    if (prior === "done") {
      item.assign(clones.get(current)!);
      continue;
    }
    const inspected = inspectNativePayloadContainer(current, false);
    nodes += 1; keys += inspected.keys.length;
    if (nodes > GOAL_NATIVE_CONTEXT_STRUCTURE_LIMIT || keys > GOAL_NATIVE_CONTEXT_STRUCTURE_LIMIT)
      throw new Error("Goal request payload structure exceeds its inspection ceiling");
    const target: NativePayloadContainer = inspected.array
      ? new Array(inspected.descriptors.length.value)
      : Object.create(null) as Record<string, unknown>;
    item.assign(target);
    state.set(current, "visiting");
    clones.set(current, target);
    pending.push({ source: current, assign: item.assign, exiting: { source: current, target } });
    for (let index = inspected.keys.length - 1; index >= 0; index--) {
      const key = inspected.keys[index];
      if (inspected.array && key === "length") continue;
      const child = inspected.descriptors[key].value;
      pending.push({ source: child, assign: next => {
        Object.defineProperty(target, key, {
          value: next, enumerable: true, configurable: true, writable: true,
        });
      } });
    }
  }
  return snapshot as NativePayloadContainer;
}

function assertGoalNativePayloadSnapshot(value: unknown): void {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Goal request payload snapshot must be a plain record");
  type Inspection = Readonly<{ value: unknown; exiting?: object }>;
  const state = new WeakMap<object, "visiting" | "done">();
  const pending: Inspection[] = [{ value }];
  let nodes = 0, keys = 0;
  while (pending.length) {
    const inspection = pending.pop()!;
    if (inspection.exiting) {
      state.set(inspection.exiting, "done");
      continue;
    }
    const current = inspection.value;
    if (current === null || typeof current !== "object") {
      assertNativePayloadPrimitive(current);
      continue;
    }
    const prior = state.get(current);
    if (prior === "visiting")
      throw new Error("Goal request payload snapshot contains a cycle");
    if (prior === "done") continue;
    const inspected = inspectNativePayloadContainer(current, true);
    nodes += 1; keys += inspected.keys.length;
    if (nodes > GOAL_NATIVE_CONTEXT_STRUCTURE_LIMIT || keys > GOAL_NATIVE_CONTEXT_STRUCTURE_LIMIT)
      throw new Error("Goal request payload snapshot exceeds its inspection ceiling");
    state.set(current, "visiting");
    pending.push({ value: current, exiting: current });
    for (let index = inspected.keys.length - 1; index >= 0; index--) {
      const key = inspected.keys[index];
      if (!inspected.array || key !== "length")
        pending.push({ value: inspected.descriptors[key].value });
    }
  }
}

function safeNativeRecord(value: unknown, label: string): Record<string, PropertyDescriptor> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new Error(`Goal native read ${label} must be a non-proxy plain record`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== "string") ||
      Object.values(descriptors).some(descriptor => !("value" in descriptor)))
    throw new Error(`Goal native read ${label} contains an accessor or symbol`);
  return descriptors;
}

function safeNativeArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype)
    throw new Error(`Goal native read ${label} must be a non-proxy array`);
  const descriptors = Object.getOwnPropertyDescriptors(value as object);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > 4_096)
    throw new Error(`Goal native read ${label} has an invalid or unbounded length`);
  if (Reflect.ownKeys(value).some(key => typeof key !== "string") ||
      Object.entries(descriptors).some(([key, descriptor]) =>
        key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || !("value" in descriptor))))
    throw new Error(`Goal native read ${label} contains an accessor or invalid index`);
  const captured = Array.from({ length }, (_unused, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor))
      throw new Error(`Goal native read ${label} is sparse or contains an accessor`);
    return descriptor.value;
  });
  return Object.freeze(captured);
}

function nativeData(descriptors: Record<string, PropertyDescriptor>, key: string): unknown {
  return descriptors[key]?.value;
}

function nativeReadParams(value: unknown): Readonly<Record<string, unknown>> {
  const descriptors = safeNativeRecord(value, "tool arguments");
  if (Object.keys(descriptors).some(key => !["path", "cursor", "maxPages"].includes(key)))
    throw new Error("Goal native read tool arguments contain unsupported fields");
  const path = nativeData(descriptors, "path");
  goalWorkspacePathCheck(path);
  const cursor = nativeData(descriptors, "cursor");
  if (cursor !== undefined && (typeof cursor !== "string" || cursor.length > 256))
    throw new Error("Goal native read cursor is invalid");
  const maxPages = nativeData(descriptors, "maxPages");
  if (maxPages !== undefined && (!Number.isSafeInteger(maxPages) || (maxPages as number) < 1 || (maxPages as number) > 32))
    throw new Error("Goal native read page cap is invalid");
  return Object.freeze({ path, ...(cursor === undefined ? {} : { cursor }),
    ...(maxPages === undefined ? {} : { maxPages }) });
}

function nativePageBytes(page: Record<string, unknown>): { bytes: Buffer; sourceChars: number } {
  const encoding = page.encoding, content = page.content;
  if (!["utf8", "base64"].includes(encoding as string) || typeof content !== "string")
    throw new Error("Goal native read page encoding/content is invalid");
  const bytes = Buffer.from(content, encoding as BufferEncoding);
  if (bytes.toString(encoding as BufferEncoding) !== content)
    throw new Error("Goal native read page content is noncanonical");
  let lineBreaks = 0;
  for (const byte of bytes) if (byte === 10) lineBreaks++;
  const lines = bytes.length === 0 ? 0 : lineBreaks + (bytes[bytes.length - 1] === 10 ? 0 : 1);
  if (!Number.isSafeInteger(page.returnedBytes) || page.returnedBytes !== bytes.length ||
      !Number.isSafeInteger(page.returnedLines) || page.returnedLines !== lines ||
      typeof page.eof !== "boolean" ||
      (page.eof ? page.nextCursor !== null :
        typeof page.nextCursor !== "string" || !page.nextCursor.length || page.nextCursor.length > 256))
    throw new Error("Goal native read page census/cursor is invalid");
  return { bytes, sourceChars: content.length };
}

function nativeReadLeaf(input: {
  operationId: unknown; path: unknown; artifact: unknown; expectedDigest: unknown;
  page: unknown; sourceReceipt: unknown; absentCursor?: unknown;
}): NativeReadLeaf {
  if (typeof input.operationId !== "string" || !input.operationId.length || input.operationId.length > 256)
    throw new Error("Goal native read operation identity is invalid");
  goalWorkspacePathCheck(input.path);
  if (typeof input.expectedDigest !== "string" || !GOAL_NATIVE_READ_HASH.test(input.expectedDigest))
    throw new Error("Goal native read expected digest is invalid");
  const pageDescriptors = safeNativeRecord(input.page, "page");
  const page = Object.fromEntries(Object.entries(pageDescriptors).map(([key, descriptor]) => [key, descriptor.value]));
  const { bytes, sourceChars } = nativePageBytes(page);
  const artifactIdentity = goalFileIdentity(input.artifact);
  let receipt: Record<string, unknown> | null;
  if (input.artifact === null) {
    if (input.sourceReceipt !== undefined || input.expectedDigest !== goalHash(null) ||
        input.absentCursor !== undefined && input.absentCursor !== "" ||
        page.encoding !== "utf8" || page.content !== "" || bytes.length !== 0 ||
        page.returnedLines !== 0 || page.nextCursor !== null || page.eof !== true)
      throw new Error("Goal native read absent-source semantics are invalid");
    receipt = null;
  } else {
    const receiptDescriptors = safeNativeRecord(input.sourceReceipt, "source receipt");
    receipt = Object.fromEntries(Object.entries(receiptDescriptors).map(([key, descriptor]) => [key, descriptor.value]));
    if (receipt.path !== input.path || receipt.expectedDigest !== input.expectedDigest ||
        receipt.sourceDigest !== goalHash(artifactIdentity) ||
        typeof receipt.evidenceRef !== "string" || !receipt.evidenceRef.length || receipt.evidenceRef.length > 4_096 ||
        !(receipt.cursor === null || typeof receipt.cursor === "string" && receipt.cursor.length <= 256) ||
        receipt.nextCursor !== page.nextCursor || receipt.eof !== page.eof ||
        receipt.encoding !== page.encoding || receipt.content !== page.content ||
        receipt.returnedBytes !== page.returnedBytes || receipt.returnedLines !== page.returnedLines)
      throw new Error("Goal native read source receipt does not reconstruct the actual page");
  }
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const hash = goalHash({
    domain: "goal-native-read-leaf-v1",
    operationId: input.operationId,
    path: input.path,
    artifact: artifactIdentity,
    expectedDigest: input.expectedDigest,
    sourceReceipt: receipt === null ? null : {
      path: receipt.path, expectedDigest: receipt.expectedDigest, sourceDigest: receipt.sourceDigest,
      evidenceRef: receipt.evidenceRef, cursor: receipt.cursor, nextCursor: receipt.nextCursor,
      eof: receipt.eof, encoding: receipt.encoding, contentHash,
      contentChars: sourceChars, returnedBytes: receipt.returnedBytes, returnedLines: receipt.returnedLines,
    },
    page: { encoding: page.encoding, contentHash, contentChars: sourceChars,
      returnedBytes: page.returnedBytes, returnedLines: page.returnedLines,
      nextCursor: page.nextCursor, eof: page.eof },
  });
  return Object.freeze({ operationId: input.operationId, hash, sourceChars });
}

function nativeReadRoot(leaves: ReadonlyMap<string, NativeReadLeaf>): string {
  const hash = createHash("sha256").update("goal-native-read-root-v1\0");
  for (const operationId of [...leaves.keys()].sort()) {
    const leaf = leaves.get(operationId)!;
    hash.update(String(Buffer.byteLength(operationId))).update(":").update(operationId)
      .update(":").update(leaf.hash).update("\0");
  }
  return hash.update(String(leaves.size)).digest("hex");
}

function immutableNativeReadWitness(value: unknown): GoalNativeReadWitness {
  const descriptors = safeNativeRecord(value, "witness");
  const allowed = ["schema", "attemptRoot", "contextRoot", "readRoot", "coverage", "readOperations",
    "readToolResults", "sourceChars", "retainedToolResultChars"];
  if (Object.keys(descriptors).length !== allowed.length ||
      Object.keys(descriptors).some(key => !allowed.includes(key)) ||
      nativeData(descriptors, "schema") !== GOAL_NATIVE_READ_SCHEMA ||
      !["none", "complete", "incomplete"].includes(nativeData(descriptors, "coverage") as string) ||
      ["attemptRoot", "contextRoot", "readRoot"].some(key =>
        typeof nativeData(descriptors, key) !== "string" ||
        !GOAL_NATIVE_READ_HASH.test(nativeData(descriptors, key) as string)) ||
      ["readOperations", "readToolResults", "sourceChars", "retainedToolResultChars"].some(key =>
        !Number.isSafeInteger(nativeData(descriptors, key)) || (nativeData(descriptors, key) as number) < 0) ||
      (nativeData(descriptors, "retainedToolResultChars") as number) > GOAL_NATIVE_READ_CONTENT_CHARS ||
      (nativeData(descriptors, "sourceChars") as number) >
        (nativeData(descriptors, "retainedToolResultChars") as number) ||
      (nativeData(descriptors, "readToolResults") as number) >
        (nativeData(descriptors, "readOperations") as number) ||
      (nativeData(descriptors, "coverage") === "none" &&
        (nativeData(descriptors, "readOperations") !== 0 || nativeData(descriptors, "readToolResults") !== 0)))
    throw new Error("Goal native read witness is invalid");
  return Object.freeze(Object.fromEntries(allowed.map(key => [key, nativeData(descriptors, key)]))) as GoalNativeReadWitness;
}

/**
 * Observes only authentic native goal_candidate_read call/result linkage and
 * actual tool-result text. It intentionally ignores unrelated SDK/UI metadata;
 * the locked original adapter remains responsible for transforming this exact
 * native Context into the opaque HTTP body committed by the request channel.
 * pi-agent-core carries AgentTool.execute in Context.tools, but each qualified
 * pi-ai OpenAI adapter projects only the Tool definition fields. The validator
 * therefore accepts only that exact runtime callback position after descriptor
 * and intrinsic-prototype inspection; it never invokes or serializes execute.
 * This is ordinary provider-path observation, not G002/G003 qualification and
 * not an independent decoder or claim about compressed body contents.
 */
export function captureGoalNativeReadWitness(context: unknown, attemptKey: string): GoalNativeReadWitness {
  if (typeof attemptKey !== "string" || !attemptKey.length || attemptKey.length > 256)
    throw new Error("Goal native read attempt identity is invalid");
  assertSafeNativeContext(context);
  const contextDescriptors = safeNativeRecord(context, "context");
  const messages = safeNativeArray(nativeData(contextDescriptors, "messages"), "messages");
  const sourceCalls = new Map<string, { params: Readonly<Record<string, unknown>>; result: boolean }>();
  const leaves = new Map<string, NativeReadLeaf>();
  const contextHash = createHash("sha256").update("goal-native-read-context-root-v1\0");
  let readToolResults = 0, sourceChars = 0, retainedToolResultChars = 0;
  const addLeaf = (leaf: NativeReadLeaf) => {
    if (leaves.has(leaf.operationId)) throw new Error("Goal native read operation is duplicated");
    leaves.set(leaf.operationId, leaf); sourceChars += leaf.sourceChars;
  };
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const messageDescriptors = safeNativeRecord(messages[messageIndex], `message ${messageIndex}`);
    const role = nativeData(messageDescriptors, "role");
    if (role === "assistant") {
      const content = safeNativeArray(nativeData(messageDescriptors, "content"), `assistant content ${messageIndex}`);
      for (let contentIndex = 0; contentIndex < content.length; contentIndex++) {
        const itemDescriptors = safeNativeRecord(content[contentIndex], `assistant item ${messageIndex}:${contentIndex}`);
        if (nativeData(itemDescriptors, "type") !== "toolCall" ||
            nativeData(itemDescriptors, "name") !== GOAL_CANDIDATE_TOOLS[0]) continue;
        const id = nativeData(itemDescriptors, "id");
        if (typeof id !== "string" || !id.length || id.length > 256 || sourceCalls.has(id))
          throw new Error("Goal native read tool call identity is invalid or duplicated");
        const params = nativeReadParams(nativeData(itemDescriptors, "arguments"));
        sourceCalls.set(id, { params, result: false });
        contextHash.update(goalHash({ domain: "goal-native-read-call-v1", messageIndex, contentIndex,
          toolCallId: id, toolName: GOAL_CANDIDATE_TOOLS[0], params })).update("\0");
      }
      continue;
    }
    if (role !== "toolResult") continue;
    const toolCallId = nativeData(messageDescriptors, "toolCallId");
    const toolName = nativeData(messageDescriptors, "toolName");
    const content = safeNativeArray(nativeData(messageDescriptors, "content"), `tool result content ${messageIndex}`);
    let retainedText = "";
    for (let contentIndex = 0; contentIndex < content.length; contentIndex++) {
      const itemDescriptors = safeNativeRecord(content[contentIndex], `tool result item ${messageIndex}:${contentIndex}`);
      if (nativeData(itemDescriptors, "type") !== "text" || typeof nativeData(itemDescriptors, "text") !== "string")
        throw new Error("Goal native read requires text-only tool results");
      const text = nativeData(itemDescriptors, "text") as string;
      retainedToolResultChars += text.length;
      if (retainedToolResultChars > GOAL_NATIVE_READ_CONTENT_CHARS)
        throw new Error("Goal native read retained tool-result content exceeds its ceiling");
      retainedText += text;
    }
    if (toolName !== GOAL_CANDIDATE_TOOLS[0] || nativeData(messageDescriptors, "isError") !== false)
      throw new Error("Goal native read coverage requires read-only non-error tool results");
    if (typeof toolCallId !== "string" || !sourceCalls.has(toolCallId))
      throw new Error("Goal native read tool result lacks its original call association");
    const call = sourceCalls.get(toolCallId)!;
    if (call.result || content.length !== 1)
      throw new Error("Goal native read tool result is duplicated or fragmented");
    call.result = true;
    let result: Result;
    try {
      result = JSON.parse(retainedText) as Result;
    } catch {
      throw new Error("Goal native read tool-result text is not actual JSON");
    }
    const maxPages = call.params.maxPages;
    if (result?.schema === "goal-candidate-read-batch-v1") {
      if (!Number.isSafeInteger(maxPages) || (maxPages as number) < 2 ||
          result.requestedPages !== maxPages || result.historicalPages === true ||
          result.inconsistentPages === true ||
          !(result.status === "ok" && result.eof === true && result.stopReason === "eof" ||
            result.status === "partial" && result.partial === true &&
            ["page-limit", "aggregate-limit"].includes(result.stopReason as string)))
        throw new Error("Goal native read batch is blocked, UNKNOWN, historical, or inconsistent");
      const pages = safeNativeArray(result.pages, "batch pages");
      if (!pages.length || pages.length > 32 || result.returnedPages !== pages.length)
        throw new Error("Goal native read batch page census is invalid");
      for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
        const pageDescriptors = safeNativeRecord(pages[pageIndex], `batch page ${pageIndex}`);
        const operationId = nativeData(pageDescriptors, "operationId");
        if (pageIndex === 0 && operationId !== toolCallId)
          throw new Error("Goal native read batch lost its original tool call identity");
        const localPath = nativeData(pageDescriptors, "path");
        const localArtifact = nativeData(pageDescriptors, "artifact");
        const localExpectedDigest = nativeData(pageDescriptors, "expectedDigest");
        const localIdentity = nativeData(pageDescriptors, "sourceReceiptIdentity");
        const sharedIdentity = localIdentity === undefined ? result.sourceReceiptIdentity : localIdentity;
        let reconstructedReceipt: unknown;
        const compactReceipt = nativeData(pageDescriptors, "sourceReceipt");
        if (compactReceipt !== undefined) {
          const identityDescriptors = safeNativeRecord(sharedIdentity, "batch source receipt identity");
          const receiptDescriptors = safeNativeRecord(compactReceipt, "batch source receipt");
          reconstructedReceipt = Object.freeze({
            ...Object.fromEntries(Object.entries(identityDescriptors).map(([key, descriptor]) => [key, descriptor.value])),
            ...Object.fromEntries(Object.entries(receiptDescriptors).map(([key, descriptor]) => [key, descriptor.value])),
            encoding: nativeData(safeNativeRecord(nativeData(pageDescriptors, "page"), "batch page payload"), "encoding"),
            content: nativeData(safeNativeRecord(nativeData(pageDescriptors, "page"), "batch page payload"), "content"),
          });
        }
        addLeaf(nativeReadLeaf({
          operationId,
          path: localPath === undefined ? result.path : localPath,
          artifact: localArtifact === undefined ? result.artifact : localArtifact,
          expectedDigest: localExpectedDigest === undefined ? result.expectedDigest : localExpectedDigest,
          page: nativeData(pageDescriptors, "page"),
          sourceReceipt: reconstructedReceipt,
          absentCursor: call.params.cursor,
        }));
      }
    } else {
      if (maxPages !== undefined && maxPages !== 1 || result?.status !== "ok")
        throw new Error("Goal native read single-page result is invalid");
      const receipt = result.sourceReceipt === undefined ? undefined : {
        ...(result.sourceReceipt as Record<string, unknown>),
        encoding: (result.page as Record<string, unknown>)?.encoding,
        content: (result.page as Record<string, unknown>)?.content,
      };
      addLeaf(nativeReadLeaf({ operationId: toolCallId, path: result.path, artifact: result.artifact,
        expectedDigest: result.expectedDigest, page: result.page, sourceReceipt: receipt,
        absentCursor: call.params.cursor }));
    }
    readToolResults++;
    contextHash.update(goalHash({ domain: "goal-native-read-result-v1", messageIndex, toolCallId,
      toolName, textChars: retainedText.length,
      textHash: createHash("sha256").update(retainedText, "utf8").digest("hex") })).update("\0");
  }
  const missing = [...sourceCalls.values()].some(call => !call.result);
  const coverage = sourceCalls.size === 0 ? "none" : missing ? "incomplete" : "complete";
  return immutableNativeReadWitness({
    schema: GOAL_NATIVE_READ_SCHEMA,
    attemptRoot: nativeReadAttemptRoot(attemptKey),
    contextRoot: contextHash.update(String(sourceCalls.size)).update(":").update(String(readToolResults)).digest("hex"),
    readRoot: nativeReadRoot(leaves),
    coverage,
    readOperations: leaves.size,
    readToolResults,
    sourceChars,
    retainedToolResultChars,
  });
}

/** Restriction transport only; disk evidence never restores original live custody. */
export async function openGoalCandidateToolChannel(input: {
  directory: string; evidenceRoot: string; identity: unknown; attemptKey: string; workspace: GoalWorkspaceHostHandle;
  tools: readonly GoalCandidateTool[];
  sourceProgress?: GoalCandidateSourceReadContinuation;
  assertCurrent(): Promise<string>; assertLive(): void; stopped: AbortSignal;
}) {
  if (!input.tools.length || !input.tools.includes("goal_candidate_read") ||
      new Set(input.tools).size !== input.tools.length || input.tools.some(tool => !GOAL_CANDIDATE_TOOLS.includes(tool)))
    throw new Error("Goal candidate unsupported tool ceiling");
  const tools = Object.freeze([...input.tools]);
  const socketPath = join(input.directory, "tools.sock");
  let channelId = "";
  const operations = new Map<string, Operation>();
  const admitted = new Set<Promise<unknown>>();
  let closed = false, poisoned = false, queue = Promise.resolve();
  let originalAuthority: string | undefined;
  const live = () => {
    if (closed) throw new Error("Goal candidate channel retired");
    input.stopped.throwIfAborted(); input.assertLive();
  };
  const track = <T>(promise: Promise<T>): Promise<T> => {
    admitted.add(promise);
    void promise.then(() => admitted.delete(promise), () => admitted.delete(promise));
    return promise;
  };
  const unknown = async (operation: Operation, cause: unknown): Promise<Result> => {
    poisoned = true; operation.phase = "unknown";
    operation.result = { status: "unknown", message: `Goal candidate outcome UNKNOWN: ${String(cause)}` };
    // Only a positively returned original exclusive creation permits mutation.
    // Collision/uncertain creation retains its exact bytes and in-memory UNKNOWN.
    if (operation.owned)
      await writeJsonAtomicDurable(operation.path, { intent: operation.intent, phase: "unknown", result: operation.result }).catch(() => undefined);
    return operation.result;
  };
  const check = async (operation?: Operation) => {
    live(); const authority = await input.assertCurrent(); live();
    if (originalAuthority !== undefined && originalAuthority !== authority) throw new Error("Goal candidate original backend authority changed");
    originalAuthority = authority;
    if (operation?.authority && operation.authority !== authority) throw new Error("Goal candidate original backend authority changed");
    return authority;
  };
  const request = (data: any, peer: GoalAuthenticatedLocalPeer): Promise<Result> => {
    if (typeof data.toolCallId !== "string" || !data.toolCallId.length || data.toolCallId.length > 256)
      throw new Error("Goal candidate invalid request identity/arguments");
    const params = data.params;
    const validate = () => {
    if (!params || typeof params !== "object" || Array.isArray(params) ||
        Object.keys(data).some(key => !["toolCallId", "tool", "params"].includes(key)))
      throw new Error("Goal candidate invalid request arguments");
    const action = params.operation ?? "replace";
    const writeFields: Record<string, string[]> = {
      replace: ["path", "expectedDigest", "content"],
      begin: ["path", "operation", "expectedDigest", "bytes", "sha256"],
      chunk: ["path", "operation", "uploadId", "offset", "encoding", "content"],
      commit: ["path", "operation", "uploadId"],
    };
    const allowed = data.tool === GOAL_CANDIDATE_TOOLS[0] ? ["path", "cursor", "maxPages"]
      : typeof action === "string" && Object.hasOwn(writeFields, action) ? writeFields[action] : undefined;
    if (!allowed) throw new Error("Goal candidate unsupported replacement operation");
    if (!tools.includes(data.tool) || Object.keys(params).some(key => !allowed.includes(key)))
      throw new Error("Goal candidate unsupported tool/arguments");
    goalWorkspacePathCheck(params.path);
    if (!input.workspace.baseline.scope.includes(params.path)) throw new Error("Goal candidate path outside admitted scope");
    if (data.tool === GOAL_CANDIDATE_TOOLS[0] && params.cursor !== undefined &&
        (typeof params.cursor !== "string" || params.cursor.length > 256))
      throw new Error("Goal candidate invalid source cursor");
    if (data.tool === GOAL_CANDIDATE_TOOLS[0] && params.maxPages !== undefined &&
        (typeof params.maxPages !== "number" || !Number.isSafeInteger(params.maxPages) ||
          params.maxPages < 1 || params.maxPages > 32))
      throw new Error("Goal candidate invalid source page cap");
    if (data.tool === GOAL_CANDIDATE_TOOLS[1]) {
      if ((action === "replace" || action === "begin") &&
          (typeof params.expectedDigest !== "string" || !/^[a-f0-9]{64}$/.test(params.expectedDigest)))
        throw new Error("Goal candidate invalid expected digest");
      if (action === "replace" && (typeof params.content !== "string" || Buffer.byteLength(params.content) > 8192))
        throw new Error("Goal candidate invalid write arguments");
      if (action === "begin" && (!Number.isSafeInteger(params.bytes) || params.bytes < 0 ||
          (params.sha256 !== undefined && (typeof params.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(params.sha256)))))
        throw new Error("Goal candidate invalid replacement census");
      if ((action === "chunk" || action === "commit") &&
          (typeof params.uploadId !== "string" || !params.uploadId.length || params.uploadId.length > 256))
        throw new Error("Goal candidate invalid upload identity");
      if (action === "chunk") {
        if (!Number.isSafeInteger(params.offset) || params.offset < 0 ||
            !["utf8", "base64"].includes(params.encoding) || typeof params.content !== "string" ||
            !params.content.length || params.content.length > 5464)
          throw new Error("Goal candidate invalid replacement chunk");
        const bytes = Buffer.from(params.content, params.encoding);
        if (!bytes.length || bytes.length > 4096 ||
            bytes.toString(params.encoding) !== params.content)
          throw new Error("Goal candidate noncanonical or oversized replacement chunk");
      }
    }
    };
    const fingerprint = goalHash({ tool: data.tool, params });
    const previous = operations.get(data.toolCallId);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        return Promise.resolve({ status: "blocked", denial: true, message: "Goal candidate tool call ID reused with changed request" });
      // An uncertain effect is historical evidence, not a fresh request to
      // validate against authority that may since have changed.
      if (previous.phase === "unknown") return Promise.resolve(previous.result!);
      return track((async () => {
        if (previous.phase === "settled") {
          try { await check(previous); validate(); return previous.result!; }
          catch (error) { return { status: "blocked", denial: true, message: String(error) }; }
        }
        await check(previous);
        validate();
        if (previous.phase === "awaiting-ack") return unknown(previous, "prior response has no settled acknowledgement");
        const result = await previous.promise;
        await check(previous);
        const phaseAfterWait = previous.phase as Operation["phase"];
        if (previous.peer !== peer && phaseAfterWait !== "settled")
          return { status: "unknown", message: "Goal candidate original operation has not been durably acknowledged" };
        return result;
      })());
    }
    if (poisoned) return Promise.resolve({ status: "blocked", denial: true, message: "Goal candidate unresolved UNKNOWN outcome" });
    // Reserve identity synchronously, before any authority/disk/effect await.
    const operation: Operation = { fingerprint, phase: "pending", owned: false, acknowledged: false, promise: Promise.resolve({}),
      peer,
      path: join(input.evidenceRoot, channelId, `${goalHash(data.toolCallId)}.json`),
      intent: { schema: "goal-candidate-operation-v1", channelId, identity: input.identity,
        attemptKey: input.attemptKey, toolCallId: data.toolCallId, tool: data.tool, params, fingerprint } };
    operations.set(data.toolCallId, operation);
    operation.promise = track(queue.then(async () => {
      let creationAttempted = false;
      try {
        operation.authority = await check();
        if (poisoned) throw new Error("Goal candidate unresolved UNKNOWN outcome");
        validate();
        const before = await input.workspace.inspectCandidate();
        await check(operation);
        const file = before.files.find(value => value.path === params.path);
        if (!file) throw new Error("Goal candidate omitted admitted path");
        const action = params.operation ?? "replace";
        if (data.tool === GOAL_CANDIDATE_TOOLS[1] && (action === "replace" || action === "begin") &&
            params.expectedDigest !== goalHash(file.value))
          throw new Error("Goal candidate stale digest");
        if (data.tool === GOAL_CANDIDATE_TOOLS[0] && file.value === null &&
            params.cursor !== undefined && params.cursor !== "")
          throw new Error("Goal candidate cursor belongs to a missing file");
        const sourceCursor = data.tool === GOAL_CANDIDATE_TOOLS[0] && file.value !== null
          ? input.sourceProgress ? input.sourceProgress.resolve(params.path, params.cursor)
            : params.cursor === "" ? undefined : params.cursor : undefined;
        operation.intent = { ...operation.intent as object, authority: operation.authority,
          ...(data.tool === GOAL_CANDIDATE_TOOLS[0] && file.value !== null
            ? { source: { cursor: sourceCursor ?? null } } : {}) };
        creationAttempted = true;
        if (!await writeJsonExclusive(operation.path, { intent: operation.intent, phase: "pending" }))
          throw new Error("Goal candidate existing intent is not live authority");
        operation.owned = true;
        await syncFileAndDirectory(operation.path);
        await check(operation);
        if (poisoned) throw new Error("Goal candidate unresolved UNKNOWN outcome");
        let result: Result;
        let sourceReceipt: GoalCandidateSourceReadReceipt | undefined;
        if (data.tool === GOAL_CANDIDATE_TOOLS[0]) {
          if (file.value === null) {
            if (params.cursor !== undefined && params.cursor !== "")
              throw new Error("Goal candidate cursor belongs to a missing file");
            result = { status: "ok", path: file.path, artifact: null, expectedDigest: goalHash(null),
              page: { encoding: "utf8", content: "", returnedBytes: 0, returnedLines: 0, nextCursor: null, eof: true } };
          } else {
            // The only continuation cursor comes from a prior authenticated
            // host receipt. Worker-supplied locators can select that exact
            // receipt but cannot advance, replace, or mint one.
            const cursor = sourceCursor;
            const expectedDigest = goalHash(file.value);
            const page = await input.workspace.readSourcePage(params.path, cursor);
            await check(operation);
            const after = await input.workspace.inspectCandidate();
            const currentFile = after.files.find(value => value.path === params.path);
            if (!currentFile || goalHash(currentFile.value) !== goalHash(file.value) ||
                !isDeepStrictEqual(goalFileIdentity(page.artifact), goalFileContentIdentity(file.value)))
              throw new Error("Goal candidate source changed during page observation");
            const sourceEvidence = input.sourceProgress?.handoff(params.path, expectedDigest) ?? [];
            result = { ...page, expectedDigest, sourceEvidence };
            sourceReceipt = {
              path: page.path,
              expectedDigest,
              sourceDigest: goalHash(goalFileContentIdentity(page.artifact)),
              evidenceRef: operation.path,
              cursor: cursor ?? null,
              nextCursor: page.page.nextCursor,
              eof: page.page.eof,
              encoding: page.page.encoding,
              content: page.page.content,
              returnedBytes: page.page.returnedBytes,
              returnedLines: page.page.returnedLines,
            };
            const { encoding: _encoding, content: _content, ...receiptEvidence } = sourceReceipt;
            result = { ...result, sourceReceipt: receiptEvidence };
          }
        } else if (action === "begin") {
          result = { status: "ok", ...await input.workspace.beginCandidateReplacement({
            path: params.path, expectedDigest: params.expectedDigest, bytes: params.bytes, sha256: params.sha256,
            attemptKey: input.attemptKey, operationId: data.toolCallId,
          }) };
        } else if (action === "chunk") {
          result = { status: "ok", ...await input.workspace.appendCandidateReplacement({
            path: params.path, uploadId: params.uploadId, offset: params.offset,
            hex: Buffer.from(params.content, params.encoding).toString("hex"),
            attemptKey: input.attemptKey, operationId: data.toolCallId,
          }) };
        } else if (action === "commit") {
          result = { status: "ok", candidate: await input.workspace.commitCandidateReplacement({
            path: params.path, uploadId: params.uploadId,
            attemptKey: input.attemptKey, operationId: data.toolCallId,
          }) };
        } else {
          result = { status: "ok", candidate: await input.workspace.writeCandidate(params.path, params.expectedDigest, params.content) };
        }
        if (data.tool === GOAL_CANDIDATE_TOOLS[1] && (action === "replace" || action === "commit"))
          operation.sourceInvalidation = { path: params.path, expectedDigest: goalHash(file.value) };
        await check(operation);
        await writeJsonAtomicDurable(operation.path, { intent: operation.intent, phase: "awaiting-ack", result });
        await check(operation);
        if (operation.phase === "unknown") return unknown(operation, "response lost during outcome publication");
        operation.phase = "awaiting-ack"; operation.result = result;
        operation.sourceReceipt = sourceReceipt && Object.freeze({ ...sourceReceipt });
        return result;
      } catch (error) {
        if (operation.phase === "unknown") return unknown(operation, error);
        if (creationAttempted) return unknown(operation, error);
        operation.phase = "settled";
        operation.result = { status: "blocked", denial: true, message: String(error) };
        if (operation.authority) {
          try {
            operation.intent = { ...operation.intent as object, authority: operation.authority };
            if (!await writeJsonExclusive(operation.path, { intent: operation.intent, phase: "settled", result: operation.result }))
              throw new Error("Goal candidate denial evidence already exists");
            operation.owned = true;
            await syncFileAndDirectory(operation.path);
          } catch (error) { return unknown(operation, error); }
        }
        return operation.result;
      }
    }));
    queue = operation.promise.then(() => undefined, () => undefined);
    return operation.promise;
  };
  await mkdir(input.directory, { mode: 0o700 });
  // Socket callbacks outlive launch preparation; original Goal checks still authorize every operation.
  const server = await outsideRunLeaseContext(() => openGoalAuthenticatedLocalChannel({
    socketPath, attemptKey: input.attemptKey, stopped: input.stopped, requestLimit: 32_768,
    async onRequest(data, peer) {
      const promise = request(data, peer);
      if (candidateRequestDiagnostics.hasSubscribers && typeof data.toolCallId === "string" &&
          typeof data.tool === "string" && data.params && typeof data.params === "object")
        publishCandidateReceived({ attemptKey: input.attemptKey, channelId, toolCallId: data.toolCallId,
          tool: data.tool, fingerprint: goalHash({ tool: data.tool, params: data.params }) });
      return await promise;
    },
    async onAcknowledged(data: Record<string, unknown>, result, peer) {
      if (typeof data.toolCallId !== "string") throw new Error("Goal candidate acknowledgement identity invalid");
      const operation = operations.get(data.toolCallId);
      const requestFingerprint = goalHash({ tool: data.tool, params: data.params });
      if (result.denial === true && result.status === "blocked") {
        if (operation?.peer === peer && operation.owned && operation.phase === "settled" &&
            operation.fingerprint === requestFingerprint && isDeepStrictEqual(result, operation.result))
          operation.acknowledged = true;
        return { status: "acknowledged" };
      }
      if (!operation) throw new Error("Goal candidate unknown acknowledgement");
      if (operation.phase !== "settled" && operation.peer !== peer)
        throw new Error("Goal candidate acknowledgement belongs to another authenticated connection");
      if (operation.peer !== peer) {
        if (operation.fingerprint !== requestFingerprint || !isDeepStrictEqual(result, operation.result))
          throw new Error("Goal candidate duplicate response identity mismatch");
        return { status: "acknowledged" };
      }
      if (operation.fingerprint !== requestFingerprint) {
        if (result.status !== "blocked") throw new Error("Goal candidate denial settlement mismatch");
        return { status: "acknowledged" };
      }
      await check(operation); await operation.promise; await check(operation);
      if (operation.phase === "settled") return { status: "acknowledged" };
      if (operation.phase === "unknown") return operation.result!;
      if (operation.phase !== "awaiting-ack" || !operation.owned)
        throw new Error("Goal candidate acknowledgement unavailable");
      try {
        await writeJsonAtomicDurable(operation.path, { intent: operation.intent, phase: "settled", result: operation.result });
        await check(operation);
        if (poisoned) return await unknown(operation, "channel became UNKNOWN during acknowledgement");
        if (operation.sourceReceipt) input.sourceProgress?.settle({ ...operation.sourceReceipt });
        if (operation.sourceInvalidation) input.sourceProgress?.invalidate(
          operation.sourceInvalidation.path, operation.sourceInvalidation.expectedDigest);
        if (poisoned) return await unknown(operation, "channel became UNKNOWN during continuation settlement");
        operation.phase = "settled";
        operation.acknowledged = true;
        return { status: "acknowledged" };
      } catch (error) { return await unknown(operation, error); }
    },
    onDisconnect(peer) {
      const detached: Operation[] = [];
      for (const operation of operations.values()) {
        if (operation.peer !== peer || operation.phase === "settled" || operation.phase === "unknown") continue;
        operation.phase = "unknown"; poisoned = true; detached.push(operation);
      }
      return Promise.all(detached.map(async operation => {
        await operation.promise.catch(() => undefined);
        return unknown(operation, "original authenticated connection lost before ACK settlement");
      })).then(() => undefined);
    },
  }));
  const channel = Object.freeze({ socketPath: server.socketPath, attemptKey: server.attemptKey, channelId: server.channelId,
    secret: server.secret, hostKeyPin: server.hostKeyPin, tools });
  channelId = goalHash({ identity: input.identity, attemptKey: input.attemptKey, channelId: channel.channelId });
  let draining: Promise<void> | undefined;
  let drainComplete = false;
  const drain = (): Promise<void> => {
    if (draining) return draining;
    closed = true;
    draining = (async () => {
      await server.drain();
      while (admitted.size) await Promise.allSettled([...admitted]);
      for (const operation of operations.values()) {
        if (operation.phase === "pending" || operation.phase === "awaiting-ack") await unknown(operation, "channel retired without settled acknowledgement");
      }
      input.stopped.removeEventListener("abort", onAbort);
      if (poisoned) throw new Error("Goal candidate drain retains unresolved UNKNOWN outcome");
      drainComplete = true;
    })();
    return draining;
  };
  const onAbort = () => { void drain().catch(() => undefined); };
  input.stopped.addEventListener("abort", onAbort, { once: true });
  if (input.stopped.aborted) await drain();
  const extensionPath = join(input.directory, "tools.mjs");
  const extensionBytes = `import { registerGoalCandidateTools } from ${JSON.stringify(import.meta.url)};\nexport default pi => registerGoalCandidateTools(pi, ${JSON.stringify(channel)});\n`;
  try { await writeFile(extensionPath, extensionBytes, { mode: 0o600 }); }
  catch (error) { await drain(); throw error; }
  // Original-channel ACK observation only, including after successful drain.
  // Callers must separately bind current custody, source identity, and native
  // context retention; this method neither revives transport nor proves judgment.
  const assertCompleteSourceReadCoverage = (expected: readonly GoalWorkspacePath[]): void => {
    if (tools.length !== 1 || tools[0] !== "goal_candidate_read")
      throw new Error("Goal candidate complete source coverage requires a read-only channel");
    const capturedExpected: unknown = JSON.parse(goalJson(expected));
    if (!Array.isArray(capturedExpected) || !capturedExpected.length)
      throw new Error("Goal candidate source coverage requires nonempty expected paths");
    if (poisoned) throw new Error("Goal candidate source coverage retains UNKNOWN outcome");
    if (admitted.size || (draining && !drainComplete))
      throw new Error("Goal candidate source coverage awaits original request/drain settlement");
    const expectedByPath = new Map<string, {
      value: GoalWorkspacePath["value"];
      expectedDigest: string;
      sourceDigest: string;
      identity: ReturnType<typeof goalFileContentIdentity>;
    }>();
    for (const source of capturedExpected) {
      if (!source || typeof source !== "object" || Array.isArray(source) ||
          Object.keys(source).length !== 2 ||
          !Object.hasOwn(source, "path") || !Object.hasOwn(source, "value"))
        throw new Error("Goal candidate invalid expected source coverage path");
      const path = Object.getOwnPropertyDescriptor(source, "path");
      const value = Object.getOwnPropertyDescriptor(source, "value");
      if (!path || !("value" in path) || !value || !("value" in value))
        throw new Error("Goal candidate accessor expected source coverage path");
      goalWorkspacePathCheck(path.value);
      if (!input.workspace.baseline.scope.includes(path.value))
        throw new Error("Goal candidate foreign expected source coverage path");
      if (value.value !== null) goalFileValueCheck(value.value);
      const expectedPath = path.value as string;
      const expectedValue = value.value as GoalWorkspacePath["value"];
      if (expectedByPath.has(expectedPath)) throw new Error("Goal candidate duplicate expected source coverage path");
      const identity = goalFileContentIdentity(expectedValue);
      expectedByPath.set(expectedPath, {
        value: expectedValue,
        expectedDigest: goalHash(expectedValue),
        sourceDigest: goalHash(identity),
        identity,
      });
    }
    for (const operation of operations.values()) {
      if (!operation.owned || !operation.peer || operation.phase !== "settled" || !operation.acknowledged)
        throw new Error("Goal candidate source coverage requires acknowledged settled owned original operations");
    }
    const readOperation = (operation: Operation, path: string): boolean => {
      const intent = operation.intent as { tool?: unknown; params?: { path?: unknown } };
      return intent.tool === "goal_candidate_read" && intent.params?.path === path;
    };
    for (const [path, source] of expectedByPath) {
      const pathReceipts = [...operations.values()].flatMap(operation =>
        operation.sourceReceipt && readOperation(operation, path) ? [operation.sourceReceipt] : []);
      if (source.value === null) {
        if (pathReceipts.length) throw new Error(`Goal candidate source coverage observes a different content epoch for ${path}`);
        const absent = [...operations.values()].some(operation => {
          if (!readOperation(operation, path) || operation.sourceReceipt) return false;
          const result = operation.result as { status?: unknown; path?: unknown; artifact?: unknown;
            expectedDigest?: unknown; page?: { encoding?: unknown; content?: unknown; returnedBytes?: unknown;
              nextCursor?: unknown; eof?: unknown } };
          return result?.status === "ok" && result.path === path && result.artifact === null &&
            result.expectedDigest === source.expectedDigest && result.page?.encoding === "utf8" &&
            result.page.content === "" && result.page.returnedBytes === 0 &&
            result.page.nextCursor === null && result.page.eof === true;
        });
        if (!absent) throw new Error(`Goal candidate source coverage lacks settled absent read for ${path}`);
        continue;
      }
      const absentObservation = [...operations.values()].some(operation => {
        if (!readOperation(operation, path) || operation.sourceReceipt) return false;
        return (operation.result as { status?: unknown; artifact?: unknown } | undefined)?.status === "ok" &&
          (operation.result as { artifact?: unknown }).artifact === null;
      });
      if (absentObservation) throw new Error(`Goal candidate source coverage observes a different content epoch for ${path}`);
      const receipts = pathReceipts.map(receipt => ({ receipt }));
      const matching = receipts.filter(({ receipt }) =>
        receipt.path === path && receipt.expectedDigest === source.expectedDigest && receipt.sourceDigest === source.sourceDigest);
      if (matching.length !== receipts.length)
        throw new Error(`Goal candidate source coverage observes a different content epoch for ${path}`);
      if (!matching.length) throw new Error(`Goal candidate source coverage lacks original read receipt for ${path}`);
      let cursor: string | null = null, bytes = 0, lineBreaks = 0, lastByte: number | undefined;
      const hash = createHash("sha256");
      const seen = new Set<string | null>();
      for (;;) {
        if (seen.has(cursor)) throw new Error(`Goal candidate source coverage cursor cycle for ${path}`);
        seen.add(cursor);
        const pages = matching.filter(({ receipt }) => receipt.cursor === cursor);
        if (!pages.length) throw new Error(`Goal candidate source coverage cursor gap for ${path}`);
        const receipt = pages[0].receipt;
        if (pages.some(({ receipt: other }) => other.nextCursor !== receipt.nextCursor ||
            other.eof !== receipt.eof || other.encoding !== receipt.encoding ||
            other.content !== receipt.content || other.returnedBytes !== receipt.returnedBytes ||
            other.returnedLines !== receipt.returnedLines))
          throw new Error(`Goal candidate conflicting original source receipts for ${path}`);
        let page: Buffer;
        if (receipt.encoding === "utf8") {
          page = Buffer.from(receipt.content, "utf8");
          if (page.toString("utf8") !== receipt.content) throw new Error("Goal candidate noncanonical UTF-8 source receipt");
        } else if (receipt.encoding === "base64") {
          page = Buffer.from(receipt.content, "base64");
          if (page.toString("base64") !== receipt.content) throw new Error("Goal candidate noncanonical base64 source receipt");
        } else throw new Error("Goal candidate invalid source receipt encoding");
        if (!Number.isSafeInteger(receipt.returnedBytes) || receipt.returnedBytes !== page.length)
          throw new Error("Goal candidate source receipt byte census mismatch");
        bytes += page.length;
        for (const byte of page) if (byte === 10) lineBreaks++;
        if (page.length) lastByte = page[page.length - 1];
        hash.update(page);
        if (receipt.eof) {
          if (receipt.nextCursor !== null) throw new Error("Goal candidate source receipt EOF cursor mismatch");
          break;
        }
        if (typeof receipt.nextCursor !== "string" || !receipt.nextCursor.length)
          throw new Error("Goal candidate source coverage lacks EOF receipt");
        cursor = receipt.nextCursor;
      }
      const lines = bytes === 0 ? 0 : lineBreaks + (lastByte === 10 ? 0 : 1);
      if (bytes !== source.identity!.bytes || lines !== source.identity!.lines ||
          hash.digest("hex") !== source.identity!.sha256)
        throw new Error(`Goal candidate source coverage content mismatch for ${path}`);
    }
  };
  const assertNativeReadCoverage = (expected: readonly GoalWorkspacePath[], witness: GoalNativeReadWitness): void => {
    assertCompleteSourceReadCoverage(expected);
    const observed = immutableNativeReadWitness(witness);
    if (observed.attemptRoot !== nativeReadAttemptRoot(input.attemptKey))
      throw new Error("Goal candidate native read witness belongs to another attempt");
    if (observed.coverage !== "complete")
      throw new Error("Goal candidate native read witness is incomplete");
    const leaves = new Map<string, NativeReadLeaf>();
    let sourceChars = 0;
    for (const [operationId, operation] of operations) {
      const intent = operation.intent as { tool?: unknown; params?: Record<string, unknown> };
      const result = operation.result;
      if (intent.tool !== GOAL_CANDIDATE_TOOLS[0] || !intent.params || result?.status !== "ok")
        throw new Error("Goal candidate native read coverage contains a nonqualifying original operation");
      const receipt = operation.sourceReceipt === undefined ? undefined : { ...operation.sourceReceipt };
      const leaf = nativeReadLeaf({
        operationId,
        path: result.path,
        artifact: result.artifact,
        expectedDigest: result.expectedDigest,
        page: result.page,
        sourceReceipt: receipt,
        absentCursor: intent.params.cursor,
      });
      if (leaves.has(operationId)) throw new Error("Goal candidate native read operation is duplicated");
      leaves.set(operationId, leaf);
      sourceChars += leaf.sourceChars;
    }
    if (observed.readOperations !== leaves.size || observed.sourceChars !== sourceChars ||
        observed.readRoot !== nativeReadRoot(leaves))
      throw new Error("Goal candidate native read witness does not match original ACK-settled operations");
  };
  return { channel, server, extensionPath, drain, async assertExtensionCurrent() {
    live(); if (await readFile(extensionPath, "utf8") !== extensionBytes) throw new Error("Goal candidate extension replaced"); live();
  }, assertCompleteSourceReadCoverage, assertNativeReadCoverage };
}

/** Child extension owns no filesystem handle and exposes no raw tool escape. */
function batchAbortSignal(signal: AbortSignal | undefined): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason ?? new Error("Goal candidate batch aborted"));
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Goal candidate batch timed out")),
    GOAL_AUTHENTICATED_ACTIVE_TIMEOUT);
  return { signal: controller.signal, dispose: () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  } };
}

function candidateReadDerivedId(channel: Readonly<Pick<GoalCandidateToolChannel, "channelId" | "attemptKey">>,
  toolCallId: string, params: Readonly<Record<string, unknown>>, pageIndex: number): string {
  return `goal-candidate-read-page-${goalHash({ domain: "goal-candidate-read-page-v1", channelId: channel.channelId,
    attemptKey: channel.attemptKey, toolCallId, params, pageIndex })}`;
}

function goalFileIdentity(value: unknown) {
  if (value === null) return goalFileContentIdentity(null);
  goalFileValueCheck(value);
  return goalFileContentIdentity(value as Parameters<typeof goalFileContentIdentity>[0]);
}

function compactCandidateReadPage(result: Result) {
  const { status: _status, path: _path, artifact: _artifact, expectedDigest: _expectedDigest,
    sourceEvidence: _sourceEvidence, page, sourceReceipt } = result;
  if (sourceReceipt === undefined) return { page };
  const { path: _receiptPath, expectedDigest: _receiptExpectedDigest, sourceDigest: _receiptSourceDigest,
    ...receipt } = sourceReceipt as Record<string, unknown>;
  return { page, sourceReceipt: receipt };
}

function sourceReceiptIdentity(result: Result): Record<string, string> | undefined {
  const receipt = result.sourceReceipt;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return undefined;
  const { path, expectedDigest, sourceDigest } = receipt as Record<string, unknown>;
  return typeof path === "string" && typeof expectedDigest === "string" && typeof sourceDigest === "string"
    ? { path, expectedDigest, sourceDigest } : undefined;
}

function sourceReceiptDigest(result: Result): string | undefined {
  const receipt = result.sourceReceipt;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return undefined;
  const sourceDigest = (receipt as Record<string, unknown>).sourceDigest;
  return typeof sourceDigest === "string" ? sourceDigest : undefined;
}

function boundedBatchTerminal(result: Result): Result {
  const message = typeof result.message === "string" ? result.message : undefined;
  const truncated = message !== undefined && message.length > 1024;
  return {
    status: result.status,
    ...(result.denial === true ? { denial: true } : {}),
    ...(message === undefined ? {} : { message: truncated ? message.slice(0, 1024) : message }),
    ...(truncated ? { diagnosticTruncated: true } : {}),
  };
}

function validBatchPage(page: unknown): page is Record<string, unknown> {
  if (page === null || typeof page !== "object" || Array.isArray(page)) return false;
  const record = page as Record<string, unknown>;
  return typeof record.eof === "boolean" &&
    (record.eof ? record.nextCursor === null :
      typeof record.nextCursor === "string" && record.nextCursor.length > 0 && record.nextCursor.length <= 256);
}

function validSourceReceipt(result: Result, page: Record<string, unknown>, artifactIdentity: unknown): boolean {
  if (result.artifact === null) return result.sourceReceipt === undefined &&
    result.expectedDigest === goalHash(null) && page.content === "" &&
    page.returnedBytes === 0 && page.returnedLines === 0 && page.eof === true;
  const receipt = result.sourceReceipt;
  return receipt !== null && typeof receipt === "object" && !Array.isArray(receipt) &&
    typeof (receipt as Record<string, unknown>).sourceDigest === "string" &&
    (receipt as Record<string, unknown>).sourceDigest === goalHash(artifactIdentity) &&
    (receipt as Record<string, unknown>).path === result.path &&
    (receipt as Record<string, unknown>).expectedDigest === result.expectedDigest &&
    (receipt as Record<string, unknown>).nextCursor === page.nextCursor &&
    (receipt as Record<string, unknown>).eof === page.eof;
}

async function executeGoalCandidateReadBatch(channel: GoalCandidateToolChannel, toolCallId: string,
  input: unknown, signal?: AbortSignal): Promise<Result> {
  const snapshot = JSON.parse(goalJson(input)) as unknown;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot))
    return await callGoalCandidateTool(channel, toolCallId, GOAL_CANDIDATE_TOOLS[0], snapshot, signal);
  const params = Object.freeze({ ...(snapshot as Record<string, unknown>) });
  const maxPages = params.maxPages;
  if (maxPages === undefined || maxPages === 1) {
    const { maxPages: _maxPages, ...singlePageParams } = params;
    return await callGoalCandidateTool(channel, toolCallId, GOAL_CANDIDATE_TOOLS[0], singlePageParams, signal);
  }
  if (typeof maxPages !== "number" || !Number.isSafeInteger(maxPages) || maxPages < 2 || maxPages > 32)
    return await callGoalCandidateTool(channel, toolCallId, GOAL_CANDIDATE_TOOLS[0], params, signal);

  const originalParams = params;
  const originalChannel: GoalCandidateToolChannel = Object.freeze({
    socketPath: channel.socketPath, attemptKey: channel.attemptKey, channelId: channel.channelId,
    secret: channel.secret, hostKeyPin: channel.hostKeyPin, tools: Object.freeze([...channel.tools]),
  });
  const identity = Object.freeze({ channelId: originalChannel.channelId, attemptKey: originalChannel.attemptKey });
  const pages: Array<Record<string, unknown>> = [];
  const batch = batchAbortSignal(signal);
  let cursor = originalParams.cursor;
  let path: unknown, artifact: unknown, expectedDigest: unknown, sourceDigest: string | undefined,
    batchSourceReceiptIdentity: Record<string, string> | undefined, sourceAbsent = false;
  let terminal: Result | undefined;
  let stopReason = "page-limit";
  try {
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
      // Do not start an exchange that could leave no room for its fully
      // authenticated response and its terminal envelope.
      if (pageIndex > 0 && Buffer.byteLength(goalJson({ schema: "goal-candidate-read-batch-v1", status: "ok",
        path, artifact, expectedDigest, ...(batchSourceReceiptIdentity ? { sourceReceiptIdentity: batchSourceReceiptIdentity } : {}),
        pages, nextCursor: cursor ?? null, eof: false, requestedPages: maxPages,
        returnedPages: pages.length, stopReason: "page-limit" })) +
          GOAL_AUTHENTICATED_RESPONSE_LIMIT + 8_192 > GOAL_MAX_BYTES) {
        stopReason = "aggregate-limit";
        break;
      }
      const pageParams = pageIndex === 0 ? originalParams : Object.freeze({ ...originalParams, cursor });
      const operationId = pageIndex === 0 ? toolCallId :
        candidateReadDerivedId(identity, toolCallId, originalParams, pageIndex);
      let result: Result;
      try {
        result = await callGoalCandidateTool(originalChannel, operationId,
          GOAL_CANDIDATE_TOOLS[0], pageParams, batch.signal);
      } catch (error) {
        if (pageIndex === 0) throw error;
        terminal = boundedBatchTerminal({ status: "blocked", denial: true, message: String(error) });
        stopReason = "blocked";
        break;
      }
      if (result.status !== "ok") {
        terminal = boundedBatchTerminal(result);
        stopReason = result.status === "unknown" ? "unknown" : "blocked";
        break;
      }
      const page = result.page;
      if (!validBatchPage(page)) {
        terminal = { status: "blocked", denial: true, message: "Goal candidate invalid source page result" };
        stopReason = "blocked";
        break;
      }
      let artifactIdentity: ReturnType<typeof goalFileIdentity>;
      try { artifactIdentity = goalFileIdentity(result.artifact); }
      catch {
        terminal = { status: "blocked", denial: true, message: "Goal candidate invalid source artifact result" };
        stopReason = "blocked";
        break;
      }
      if (!validSourceReceipt(result, page, artifactIdentity)) {
        terminal = { status: "blocked", denial: true, message: "Goal candidate invalid source page result" };
        stopReason = "blocked";
        break;
      }
      const receiptIdentity = sourceReceiptIdentity(result);
      let identityMismatch = false;
      if (pageIndex === 0) {
        path = result.path; artifact = result.artifact; expectedDigest = result.expectedDigest;
        sourceAbsent = result.artifact === null;
        sourceDigest = sourceReceiptDigest(result);
        batchSourceReceiptIdentity = receiptIdentity;
      } else if (result.path !== path || result.expectedDigest !== expectedDigest ||
          sourceDigest === undefined || sourceReceiptDigest(result) !== sourceDigest ||
          !isDeepStrictEqual(goalFileIdentity(result.artifact), goalFileIdentity(artifact))) {
        identityMismatch = true;
      }
      const compact = { operationId, ...compactCandidateReadPage(result) };
      if (identityMismatch) {
        pages.push({ ...compact, path: result.path, artifact: result.artifact, expectedDigest: result.expectedDigest,
          ...(receiptIdentity ? { sourceReceiptIdentity: receiptIdentity } : {}) });
        cursor = page.nextCursor;
        terminal = { status: "blocked", denial: true, message: "Goal candidate source drifted between acknowledged pages" };
        stopReason = "drift";
        break;
      }
      pages.push(compact);
      cursor = page.nextCursor;
      if (page.eof === true) {
        stopReason = "eof";
        break;
      }
    }
  } finally {
    batch.dispose();
  }
  const last = pages.at(-1)?.page as Record<string, unknown> | undefined;
  const complete = terminal === undefined && stopReason === "eof";
  return {
    ...(terminal ?? { status: complete ? "ok" : "partial" }),
    schema: "goal-candidate-read-batch-v1",
    path, artifact, expectedDigest, pages, nextCursor: last?.nextCursor ?? null, eof: last?.eof === true,
    ...(batchSourceReceiptIdentity ? { sourceReceiptIdentity: batchSourceReceiptIdentity } : {}),
    ...(sourceAbsent ? { sourceAbsent: true } : {}),
    requestedPages: maxPages, returnedPages: pages.length, stopReason,
    ...(complete ? {} : { partial: true }),
    ...(terminal && pages.length ? { historicalPages: true } : {}),
    ...(stopReason === "drift" ? { inconsistentPages: true } : {}),
  };
}

export function registerGoalCandidateTools(pi: ExtensionAPI, channel: GoalCandidateToolChannel): void {
  const tools = Object.freeze([...channel.tools]);
  const shape = (properties: Record<string, unknown>, required: string[]) => ({
    type: "object", additionalProperties: false, properties, required,
  });
  const path = { type: "string" };
  const expectedDigest = { type: "string", pattern: "^[a-f0-9]{64}$" };
  const uploadId = { type: "string", minLength: 1, maxLength: 256 };
  for (const name of tools) pi.registerTool({
    name, label: name, executionMode: "sequential",
    description: name === GOAL_CANDIDATE_TOOLS[0]
      ? "Read admitted candidate-file pages. maxPages is an optional integer from 1 through 32; omit it or use 1 for the exact single-page exchange. Larger values sequentially read only through the last ACKed nextCursor and return complete only at actual EOF; partial results retain the final cursor and stop reason. Omitting cursor can resume the same path from an acknowledged position retained by a prior inspection or attempt; it does not prove a read started at the beginning. Every fresh complete inspection must start each path with cursor:\"\", then pass each returned nextCursor unchanged until eof. EOF alone proves only that the requested position reached the end, not that the full prefix was inspected. Never fabricate cursors or infer hidden pages. After blocked or UNKNOWN, do not reset, replay, or request another page. Encoding is utf8 or byte-preserving base64. Artifact digest/census describes the whole file, not proof that unread pages were inspected. expectedDigest is the current-value CAS token; artifact:null means the path is absent. No raw filesystem access."
      : "Replace an admitted candidate file, never the origin. For up to 8192 UTF-8 bytes use path, expectedDigest and content. Larger replacements use operation:begin with current expectedDigest and exact total bytes, then ordered operation:chunk calls with uploadId, returned receivedBytes as offset, encoding utf8/base64 and at most 4096 decoded bytes of content; finally operation:commit. Begin sha256 is optional and only for an independently known complete-content digest; the host computes the actual digest. Staging does not change the candidate; commit checks the original CAS and publishes atomically. UNKNOWN is not permission to replay.",
    parameters: name === GOAL_CANDIDATE_TOOLS[0]
      ? shape({ path, cursor: { type: "string", maxLength: 256,
          description: "Omitting cursor can resume an acknowledged position retained by a prior inspection or attempt. For a fresh complete inspection, pass cursor:\"\" for each path, then follow returned nextCursor values through eof; EOF alone is not proof that the full prefix was inspected. Never reset or replay after blocked or UNKNOWN." },
        maxPages: { type: "integer", minimum: 1, maximum: 32 } }, ["path"])
      : { type: "object", anyOf: [
        shape({ path, expectedDigest, content: { type: "string" } }, ["path", "expectedDigest", "content"]),
        shape({ path, operation: { const: "begin", type: "string" }, expectedDigest,
          bytes: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
          sha256: { ...expectedDigest, description: "Optional independently known digest; do not guess it." },
        }, ["path", "operation", "expectedDigest", "bytes"]),
        shape({ path, operation: { const: "chunk", type: "string" }, uploadId,
          offset: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
          encoding: { type: "string", enum: ["utf8", "base64"] },
          content: { type: "string", minLength: 1, maxLength: 5464 },
        }, ["path", "operation", "uploadId", "offset", "encoding", "content"]),
        shape({ path, operation: { const: "commit", type: "string" }, uploadId }, ["path", "operation", "uploadId"]),
      ] },
    async execute(toolCallId: string, params: unknown, signal?: AbortSignal) {
      const result = name === GOAL_CANDIDATE_TOOLS[0]
        ? await executeGoalCandidateReadBatch(channel, toolCallId, params, signal)
        : await callGoalCandidateTool(channel, toolCallId, name, params, signal);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  } as any);
  const activate = () => pi.setActiveTools([...tools]);
  pi.on("session_start", activate); pi.on("before_agent_start", activate);
}

export async function callGoalCandidateTool(channel: GoalCandidateToolChannel, toolCallId: string, tool: string, params: unknown, signal?: AbortSignal): Promise<Result> {
  try { return await exchange(channel, { toolCallId, tool, params }, signal); }
  catch (error) {
    if (!goalAuthenticatedRequestWasSent(error)) throw error;
    return { status: "unknown", message: `Goal candidate acknowledgement UNKNOWN: ${String(error)}` };
  }
}
async function exchange(channel: GoalCandidateToolChannel, data: object, signal?: AbortSignal): Promise<Result> {
  return await exchangeGoalAuthenticatedLocalChannel(channel, data as Record<string, unknown>, signal) as Result;
}

/** Live root custody owns this ledger. Disk records are evidence, never a resume issuer. */
export function createGoalRequestBudget(limit: number | undefined) {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) throw new Error("Invalid Goal request cap");
  const records = new Map<string, { commitment: string; authority: string; path: string; peer: GoalAuthenticatedLocalPeer;
    owned: boolean; phase: "reserved" | "released" | "settling" | "settled" | "unknown";
    nativeReadWitness?: GoalNativeReadWitness; nativeSettlementChannel?: symbol }>();
  const disconnected = new WeakSet<GoalAuthenticatedLocalPeer>();
  let poisoned = false, queue: Promise<void> = Promise.resolve(), queueGeneration = 0;
  return {
    assertLaunchCurrent(assertLive: () => void = () => undefined): void {
      assertLive();
      if (poisoned) throw new Error("Goal request outcome UNKNOWN");
      assertLive();
    },
    async assertRequestLaunchAdmissible(assertLive: () => void = () => undefined): Promise<void> {
      // Operations can enter the serialized ledger while an older generation is
      // being observed. Drain through a stable generation without holding the
      // queue across native work.
      for (;;) {
        assertLive();
        const generation = queueGeneration, pending = queue;
        try { await pending; } catch (error) {
          assertLive();
          // A rejected foreign identity never entered the ledger. Only an
          // original reservation's UNKNOWN state can fence other launches.
          if (poisoned) throw error;
        }
        assertLive();
        if (pending !== queue || generation !== queueGeneration) continue;
        if (poisoned) throw new Error("Goal request outcome UNKNOWN");
        return;
      }
    },
    async settledRequestCount(): Promise<number | null> {
      for (;;) {
        const generation = queueGeneration, pending = queue;
        await pending.catch(() => undefined);
        if (pending === queue && generation === queueGeneration) break;
      }
      if (poisoned || [...records.values()].some(record => !record.owned || record.phase !== "settled")) return null;
      return records.size;
    },
    assertSettled(prefix?: string) {
      if (poisoned || [...records.entries()].some(([id, record]) =>
          (!prefix || id.startsWith(`${prefix}:`)) && record.phase !== "settled"))
        throw new Error("Goal requests retain UNKNOWN or unsettled reservations");
    },
    lastSettledNativeReadWitness(prefix: string): GoalNativeReadWitness {
      if (poisoned)
        throw new Error("Goal requests retain UNKNOWN or unsettled reservations");
      const original = [...records.entries()].filter(([id]) => id.startsWith(`${prefix}:`));
      if (!original.length || original.some(([, record]) => !record.owned || record.phase !== "settled"))
        throw new Error("Goal native read witness lacks settled original request custody");
      const witness = original.at(-1)![1].nativeReadWitness;
      if (!witness) throw new Error("Goal native read witness is unavailable on the last settled request");
      return witness;
    },
    disconnect(peer: GoalAuthenticatedLocalPeer) {
      disconnected.add(peer);
      const predecessor = queue;
      const operation = predecessor.catch(() => undefined).then(async () => {
        for (const [id, record] of records) {
          if (record.peer !== peer || record.phase === "settled" || record.phase === "unknown") continue;
          record.phase = "unknown"; poisoned = true;
          if (record.owned) await writeJsonAtomicDurable(record.path, { schema: "goal-request-reservation-v1", id,
            commitment: record.commitment, authority: record.authority, phase: "unknown" });
        }
      });
      queueGeneration += 1; queue = operation; void operation.catch(() => undefined);
      return operation;
    },
    async operate(input: { id: string; commitment: string; action: string; evidenceRoot: string;
      current(): Promise<string>; live(): void; known?: boolean; peer: GoalAuthenticatedLocalPeer;
      nativeReadWitness?: GoalNativeReadWitness; nativeSettlementChannel?: symbol }) {
      if (input.action !== "reserve" && input.nativeReadWitness !== undefined)
        throw new Error("Goal native read witness is immutable after reservation");
      if (input.action === "reserve" && input.nativeSettlementChannel !== undefined &&
          input.nativeReadWitness === undefined)
        throw new Error("Goal source request settlement requires its native read witness");
      const predecessor = queue;
      const operation = predecessor.catch(() => undefined).then(async () => {
        const check = async () => { input.live(); const value = await input.current(); input.live(); return value; };
        let record = records.get(input.id);
        if (input.action === "reserve") {
          if (record) throw new Error("Goal request identity already reserved; no replay");
          if (disconnected.has(input.peer)) throw new Error("Goal request original connection already closed");
          if (poisoned) throw new Error("Goal request budget UNKNOWN");
          if ([...records.values()].some(value => value.phase === "reserved"))
            throw new Error("Goal prior reservation has no release acknowledgement");
          if (limit !== undefined && records.size >= limit) throw new Error("Goal request cap exhausted");
          const authority = await check();
          const nativeReadWitness = input.nativeReadWitness === undefined ? undefined :
            immutableNativeReadWitness(input.nativeReadWitness);
          record = { commitment: input.commitment, authority, peer: input.peer, nativeReadWitness,
            nativeSettlementChannel: input.nativeSettlementChannel,
            path: join(input.evidenceRoot, `${goalHash(input.id)}.json`), owned: false, phase: "reserved" };
          records.set(input.id, record); // No refund, including publication failure.
          try {
            const created = await writeJsonExclusive(record.path, { schema: "goal-request-reservation-v1", id: input.id,
              commitment: record.commitment, authority, phase: record.phase });
            if (!created) throw new Error("Goal request exclusive reservation collision; ownership unavailable");
            record.owned = true; // Only a positive original return proves mutable publication custody.
            await syncFileAndDirectory(record.path);
            if (await check() !== authority) throw new Error("Goal request authority changed after reservation");
            if (disconnected.has(input.peer)) {
              record.phase = "unknown"; poisoned = true;
              await writeJsonAtomicDurable(record.path, { schema: "goal-request-reservation-v1", id: input.id,
                commitment: record.commitment, authority, phase: "unknown" });
              throw new Error("Goal request connection lost during reservation publication");
            }
          } catch (error) { record.phase = "unknown"; poisoned = true; throw error; }
          return;
        }
        if (!record || record.commitment !== input.commitment)
          throw new Error("Goal request original reservation mismatch");
        if (record.peer !== input.peer) throw new Error("Goal request reservation belongs to another authenticated connection");
        if (record.nativeSettlementChannel !== input.nativeSettlementChannel)
          throw new Error("Goal request reservation belongs to another original request channel");
        const poison = async (cause: unknown, publish: boolean): Promise<never> => {
          record!.phase = "unknown"; poisoned = true;
          if (publish && record!.owned) {
            try {
              await writeJsonAtomicDurable(record!.path, { schema: "goal-request-reservation-v1", id: input.id,
                commitment: record!.commitment, authority: record!.authority, phase: "unknown" });
            } catch (publicationError) {
              throw new AggregateError([cause, publicationError],
                "Goal request outcome UNKNOWN and durable UNKNOWN publication failed");
            }
          }
          throw cause;
        };
        let authority: string;
        try { authority = await check(); }
        catch (error) { return poison(error, true); }
        if (record.authority !== authority)
          return poison(new Error("Goal request original reservation mismatch"), true);
        if (!record.owned)
          return poison(new Error("Goal request reservation ownership UNKNOWN"), false);
        if (input.action === "release" && record.phase === "reserved" && !poisoned) record.phase = "released";
        else if (input.action === "settle" && record.phase === "released" && input.known === true && !poisoned)
          record.phase = record.nativeSettlementChannel === undefined ? "settled" : "settling";
        else record.phase = "unknown";
        try {
          await writeJsonAtomicDurable(record.path, { schema: "goal-request-reservation-v1", id: input.id,
            commitment: record.commitment, authority, phase: record.phase === "settling" ? "released" : record.phase });
        } catch (error) {
          // The rename may have committed. Do not rewrite uncertain original
          // receipt bytes merely to improve the diagnostic.
          return poison(error, false);
        }
        let current: string;
        try { current = await check(); }
        catch (error) { return poison(error, true); }
        if (current !== authority)
          return poison(new Error("Goal request authority changed after publication"), true);
        if (record.phase === "unknown")
          return poison(new Error("Goal request outcome UNKNOWN"), false);
      });
      queueGeneration += 1;
      queue = operation;
      void operation.catch(() => undefined);
      return operation;
    },
    async acknowledgeNativeSettlement(input: { id: string; commitment: string; action: string; known?: boolean;
      result: Record<string, unknown>; current(): Promise<string>; live(): void; peer: GoalAuthenticatedLocalPeer;
      nativeSettlementChannel: symbol }) {
      const predecessor = queue;
      const operation = predecessor.catch(() => undefined).then(async () => {
        const record = records.get(input.id);
        if (!record || record.commitment !== input.commitment || record.peer !== input.peer ||
            record.nativeSettlementChannel !== input.nativeSettlementChannel ||
            record.phase !== "settling" || input.action !== "settle" || input.known !== true ||
            Object.keys(input.result).length !== 1 || input.result.status !== "acknowledged")
          throw new Error("Goal request original settlement acknowledgement mismatch");
        const poison = async (cause: unknown, publish: boolean): Promise<never> => {
          record.phase = "unknown"; poisoned = true;
          if (publish && record.owned) {
            try {
              await writeJsonAtomicDurable(record.path, { schema: "goal-request-reservation-v1", id: input.id,
                commitment: record.commitment, authority: record.authority, phase: "unknown" });
            } catch (publicationError) {
              throw new AggregateError([cause, publicationError],
                "Goal request outcome UNKNOWN and durable UNKNOWN publication failed");
            }
          }
          throw cause;
        };
        const check = async () => { input.live(); const value = await input.current(); input.live(); return value; };
        if (!record.owned)
          return poison(new Error("Goal request reservation ownership UNKNOWN"), false);
        if (disconnected.has(input.peer))
          return poison(new Error("Goal request connection lost before settlement acknowledgement"), true);
        let authority: string;
        try { authority = await check(); }
        catch (error) { return poison(error, true); }
        if (authority !== record.authority)
          return poison(new Error("Goal request authority changed before settlement acknowledgement"), true);
        if (disconnected.has(input.peer))
          return poison(new Error("Goal request connection lost during settlement acknowledgement"), true);
        try {
          await writeJsonAtomicDurable(record.path, { schema: "goal-request-reservation-v1", id: input.id,
            commitment: record.commitment, authority, phase: "settled" });
        } catch (error) {
          return poison(error, false);
        }
        let current: string;
        try { current = await check(); }
        catch (error) { return poison(error, true); }
        if (current !== authority)
          return poison(new Error("Goal request authority changed after settlement publication"), true);
        if (disconnected.has(input.peer))
          return poison(new Error("Goal request connection lost during settlement publication"), true);
        record.phase = "settled";
      });
      queueGeneration += 1;
      queue = operation;
      void operation.catch(() => undefined);
      return operation;
    },
  };
}

export async function openGoalRequestBudgetChannel(input: {
  directory: string; evidenceRoot: string; identity: unknown; attemptKey: string; model: string;
  budget: ReturnType<typeof createGoalRequestBudget>; current(): Promise<string>; live(): void; stopped: AbortSignal;
  captureNativeReads?: true;
}) {
  const socketPath = join(input.directory, "requests.sock");
  let prefix = "";
  let requestChannelId = "";
  let closed = false;
  const nativeSettlementChannel = input.captureNativeReads === true
    ? Symbol("goal-native-settlement-channel") : undefined;
  const pending = new Set<Promise<unknown>>();
  const live = () => { if (closed) throw new Error("Goal request channel retired"); input.stopped.throwIfAborted(); input.live(); };
  await mkdir(input.directory, { mode: 0o700 });
  // Detach resource lifetime, not Goal authority or the surrounding preparation writes.
  const server = await outsideRunLeaseContext(() => openGoalAuthenticatedLocalChannel({
    socketPath, attemptKey: input.attemptKey, stopped: input.stopped, requestLimit: 4_096,
    async onRequest(data, peer) {
      if (!["reserve", "release", "settle", "unknown"].includes(data.action as string) ||
          typeof data.id !== "string" || data.id.length > 128 || !/^[a-f0-9]{64}$/.test(data.commitment as string) ||
          Object.keys(data).some(key => !["id", "commitment", "action", "known", "nativeReadWitness"].includes(key)) ||
          (input.captureNativeReads === true
            ? data.action === "reserve" ? data.nativeReadWitness === undefined : data.nativeReadWitness !== undefined
            : data.nativeReadWitness !== undefined))
        throw new Error("Goal request channel binding mismatch");
      const nativeReadWitness = data.nativeReadWitness === undefined ? undefined :
        immutableNativeReadWitness(data.nativeReadWitness);
      if (nativeReadWitness && nativeReadWitness.attemptRoot !== nativeReadAttemptRoot(input.attemptKey))
        throw new Error("Goal request native read witness belongs to another attempt");
      const work = (async () => {
        await input.budget.operate({ id: `${prefix}:${data.id}`, commitment: data.commitment as string, action: data.action as string,
          known: data.known === true, nativeReadWitness,
          evidenceRoot: input.evidenceRoot, current: input.current, live, peer, nativeSettlementChannel });
        live(); return { status: "acknowledged" };
      })();
      pending.add(work); void work.finally(() => pending.delete(work)).catch(() => undefined);
      if (typeof data.id === "string" && typeof data.action === "string")
        publishCandidateReceived({ attemptKey: input.attemptKey, channelId: requestChannelId, toolCallId: data.id,
          tool: `request-budget:${data.action}`,
          fingerprint: goalHash({ id: data.id, commitment: data.commitment, action: data.action }) });
      return await work;
    },
    async onAcknowledged(data, result, peer) {
      if (nativeSettlementChannel !== undefined && data.action === "settle") {
        await input.budget.acknowledgeNativeSettlement({
          id: `${prefix}:${data.id}`, commitment: data.commitment as string, action: data.action as string,
          known: data.known === true, result, current: input.current, live, peer, nativeSettlementChannel,
        });
      }
      return { status: "acknowledged" };
    },
    onDisconnect(peer) { return input.budget.disconnect(peer); },
  }));
  requestChannelId = server.channelId;
  const channel = Object.freeze({ socketPath: server.socketPath, attemptKey: server.attemptKey, channelId: server.channelId,
    secret: server.secret, hostKeyPin: server.hostKeyPin, tools: [] as const });
  prefix = goalHash({ identity: input.identity, attemptKey: input.attemptKey, channelId: channel.channelId });
  let draining: Promise<void> | undefined;
  let drainComplete = false;
  const drain = () => draining ??= (async () => {
    closed = true;
    await server.drain();
    await Promise.allSettled([...pending]);
    input.stopped.removeEventListener("abort", abort);
    input.budget.assertSettled(prefix);
    drainComplete = true;
  })();
  const abort = () => { void drain().catch(() => undefined); };
  input.stopped.addEventListener("abort", abort, { once: true });
  const extensionPath = join(input.directory, "budget.mjs");
  const bytes = `import { registerGoalRequestBudget } from ${JSON.stringify(import.meta.url)};\nexport default pi => registerGoalRequestBudget(pi, ${JSON.stringify(channel)}, ${JSON.stringify(input.model)}${input.captureNativeReads === true ? ", true" : ""});\n`;
  await writeFile(extensionPath, bytes, { mode: 0o600 });
  if (input.stopped.aborted) await drain();
  return { extensionPath, drain, assertLaunchCurrent() {
    live(); input.budget.assertLaunchCurrent(live); live();
  }, async assertExtensionCurrent() {
    live(); if (await readFile(extensionPath, "utf8") !== bytes) throw new Error("Goal request extension replaced"); live();
    await input.budget.assertRequestLaunchAdmissible(live); live();
  }, lastSettledNativeReadWitness(): GoalNativeReadWitness {
    if (input.captureNativeReads !== true)
      throw new Error("Goal native read capture is not enabled for this original request channel");
    if (!drainComplete) throw new Error("Goal native read witness requires successful request channel drain");
    return input.budget.lastSettledNativeReadWitness(prefix);
  } };
}

/** Native registration retains the original auth/catalog and stream producers across SDK recomposition.
 * Only the locked OpenAI HTTP adapters are qualified here; no WebSocket/custom fallback. */
export function registerGoalRequestBudget(pi: ExtensionAPI, channel: GoalCandidateToolChannel, selectedModel: string,
  captureNativeReads = false): void {
  let installed = false, retired = false;
  pi.on("session_shutdown", () => {
    retired = true;
    if (requestDiagnostics.hasSubscribers) requestDiagnostics.publish({
      phase: "facade-retired", attemptKey: channel.attemptKey, reason: "session_shutdown",
    });
  });
  pi.on("session_start", (_event, ctx) => {
    if (installed) throw new Error("Goal request native facade cannot be reissued");
    const model = ctx.model;
    if (!model) throw new Error("Goal request original model unavailable");
    const capturedModel = structuredClone(model);
    const supported = `${model.provider}/${model.id}` === selectedModel &&
        ((model.provider === "openai" && ["openai-responses", "openai-completions"].includes(model.api)) ||
          (model.provider === "openai-codex" && model.api === "openai-codex-responses")) &&
        !ctx.modelRegistry.getRegisteredProviderConfig(model.provider) && !ctx.modelRegistry.getRegisteredNativeProvider(model.provider);
    const original = ctx.modelRegistry.getProvider(model.provider);
    if (!original) throw new Error("Goal request original provider unavailable");
    const wrap = (method: "stream" | "streamSimple"): Provider["streamSimple"] => (actual, context, options) => {
      const output = createAssistantMessageEventStream();
      const id = randomBytes(24).toString("hex");
      const originalOnPayload = options?.onPayload;
      let commitment: string | undefined, sent = false;
      let releaseAttempted = false, observedUsage: unknown;
      let nativeReadWitness: GoalNativeReadWitness | undefined;
      let operation = "facade-check";
      let session: Awaited<ReturnType<typeof openGoalAuthenticatedLocalSession>> | undefined;
      const check = () => {
        if (!supported || retired || options?.signal?.aborted || `${actual.provider}/${actual.id}` !== selectedModel ||
            !isDeepStrictEqual(actual, capturedModel) ||
            !isDeepStrictEqual(ctx.modelRegistry.find(capturedModel.provider, capturedModel.id), capturedModel) ||
            (options?.transport !== undefined && options.transport !== "auto" && options.transport !== "sse"))
          throw new Error("Goal request retired or unsupported transport/model");
      };
      const ack = async (action: string, known?: boolean) => {
        check();
        if (!commitment || !/^[a-f0-9]{64}$/.test(commitment))
          throw new Error("Goal request commitment unavailable before reservation");
        if (typeof id !== "string" || !id.length || id.length > 256)
          throw new Error("Goal request operation identity invalid");
        session ??= await openGoalAuthenticatedLocalSession(channel, options?.signal);
        const value = await session.exchange({ id, commitment, action, known,
          ...(action === "reserve" && nativeReadWitness ? { nativeReadWitness } : {}) },
          { operationId: id, fingerprint: commitment }, options?.signal);
        check(); if (value.status !== "acknowledged") throw new Error("Goal request reservation acknowledgement unavailable");
      };
      const captureProtocolCompleteNativeReadWitness = (): GoalNativeReadWitness => {
        const witness = captureGoalNativeReadWitness(context, channel.attemptKey);
        if (witness.coverage === "incomplete")
          throw new Error("Goal native read protocol is incomplete");
        return witness;
      };
      const guardedOnPayload = captureNativeReads
        ? async (payload: unknown, payloadModel: typeof actual): Promise<unknown> => {
          operation = "payload-check";
          check();
          const snapshot = snapshotGoalNativePayload(payload);
          const observed = originalOnPayload === undefined
            ? undefined : await originalOnPayload(snapshot, payloadModel);
          check();
          assertGoalNativePayloadSnapshot(snapshot);
          if (observed !== undefined && observed !== snapshot)
            throw new Error("Goal request payload replacement denied");
          return snapshot;
        }
        : originalOnPayload;
      const fetch: typeof globalThis.fetch = async (url, init) => {
        operation = "transport-check";
        check();
        if (commitment !== undefined) throw new Error("Goal request transport replay denied");
        const body = init?.body;
        // Copy before asynchronous admission. Never hash decoded/guessed JSON or
        // accept streaming bodies; Codex's original HTTP producer supplies zstd bytes.
        const snapshot = typeof body === "string" ? Buffer.from(body, "utf8") :
          ArrayBuffer.isView(body) ? Buffer.from(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)) :
          body instanceof ArrayBuffer ? Buffer.from(new Uint8Array(body)) : undefined;
        if (!snapshot) throw new Error("Goal request unsupported payload transport");
        const observedNativeReadWitness = captureNativeReads
          ? captureProtocolCompleteNativeReadWitness() : undefined;
        if (captureNativeReads && (!nativeReadWitness ||
            !isDeepStrictEqual(observedNativeReadWitness, nativeReadWitness)))
          throw new Error("Goal native read context changed before request reservation");
        commitment = goalHash({ url: String(url), method: init?.method,
          bodyBytes: snapshot.byteLength, bodyHash: createHash("sha256").update(snapshot).digest("hex"),
          ...(nativeReadWitness ? { nativeReadWitness } : {}) });
        const request = { ...init, body: typeof body === "string" ? body : snapshot };
        const physicalFetch = options?.fetch ?? globalThis.fetch;
        operation = "reserve";
        await ack("reserve"); releaseAttempted = true;
        operation = "release";
        await ack("release"); check();
        if (captureNativeReads && !isDeepStrictEqual(
          captureProtocolCompleteNativeReadWitness(), nativeReadWitness))
          throw new Error("Goal native read context changed before physical request");
        sent = true;
        operation = "send";
        return physicalFetch(url, request);
      };
      void (async () => {
        try {
          check();
          if (captureNativeReads)
            nativeReadWitness = captureProtocolCompleteNativeReadWitness();
          // The real SDK Agent defaults to auto. Constrain it before the original
          // producer runs; auto never authorizes WebSocket or a fallback here.
          operation = "provider-stream";
          const stream = original[method](actual, context, {
            ...options, onPayload: guardedOnPayload, fetch, maxRetries: 0, transport: "sse",
          });
          for await (const event of stream) {
            if (event.type === "done" || event.type === "error") {
              if (!sent || !commitment) throw new Error("Goal request completed without bound HTTP send");
              const message = event.type === "done" ? event.message : event.error;
              // SDK initializes missing usage to zero. Only positive reported usage
              // is evidence after release; retain it even if settlement ACK is lost.
              if (Number.isSafeInteger(message.usage?.totalTokens) && message.usage.totalTokens > 0)
                observedUsage = message.usage;
              const known = event.type === "done" && Number.isSafeInteger(event.message.usage?.totalTokens) &&
                event.message.usage.totalTokens > 0;
              operation = "settle";
              await ack("settle", known);
            }
            output.push(event);
          }
          output.end();
        } catch (cause) {
          if (requestDiagnostics.hasSubscribers) requestDiagnostics.publish({
            phase: "facade-rejected", attemptKey: channel.attemptKey, operation,
            releaseAttempted, sent, commitmentPresent: commitment !== undefined,
            reason: cause instanceof Error && cause.message.startsWith("Goal ") ? cause.message : "provider operation failed",
          });
          if (commitment && session) await session.exchange({ id, commitment, action: "unknown" },
            { operationId: id, fingerprint: commitment }, options?.signal).catch(() => undefined);
          // No release attempt proves no downstream transmission. Otherwise
          // absent usage is UNKNOWN, not the SDK's synthetic zero usage/cost.
          const absent = releaseAttempted ? null : 0;
          const error: any = { role: "assistant", content: [], api: actual.api, provider: actual.provider, model: actual.id,
            usage: observedUsage ?? { input: absent, output: absent, cacheRead: absent, cacheWrite: absent, totalTokens: absent,
              cost: { input: absent, output: absent, cacheRead: absent, cacheWrite: absent, total: absent } },
            stopReason: "error", timestamp: Date.now(), errorMessage: "Goal request denied or UNKNOWN; original reservation retained" };
          output.push({ type: "error", reason: "error", error }); output.end();
        } finally {
          await session?.close().catch(() => undefined);
        }
      })();
      return output;
    };
    // This is the SDK's documented native Provider registration, not mutation of a composed object.
    pi.registerProvider({ ...original, stream: wrap("stream") as Provider["stream"], streamSimple: wrap("streamSimple"),
      fetchDeferred: undefined, cancelDeferred: undefined });
    installed = true;
  });
}
