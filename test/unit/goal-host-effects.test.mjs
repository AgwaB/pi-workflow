import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const build = resolve(process.env.GOAL_HOST_EFFECTS_TEST_BUILD_ROOT ?? ".tmp/unit");
const { GoalHostEffects, inspectGoalHostEffects, parseGoalHostEffectRecord } =
  await import(pathToFileURL(join(build, "goal-host-effects.js")));
const { goalHash } = await import(pathToFileURL(join(build, "goal-json.js")));
const H = "a".repeat(64);
const scope = { goalId: "goal", scopeId: "scope", ownerEpoch: 1, sessionDigest: H };
const opened = { type: "opened", scope };
const producer = { type: "producer-opened", producerId: "worker", kind: "sdk" };
const bound = { type: "producer-bound", producerId: "worker", incarnationDigest: H, channelDigest: H };
const fence = { type: "fenced", reason: "complete" };
const localFence = { type: "producer-fenced", producerId: "worker", reason: "complete" };
const closed = { type: "producer-closed", producerId: "worker", outcome: "closed", observationDigest: H };
const callback = (ordinal, kind = "diagnostic") => ({ type: "callback", producerId: "worker", ordinal, kind, frameDigest: H });
const request = (effectId, operation = "spawn") => ({ type: "requested", effectId, producerId: "worker", operation, requestDigest: H, goalHead: { seq: 1, hash: H } });
const result = (effectId, requestSeq, outcome = "acknowledged") => ({ type: "result", effectId, requestSeq, outcome, resultDigest: H });
function history(records) {
  let head = { seq: 0, hash: "0".repeat(64) };
  const entries = records.map((payload) => {
    const unsigned = { version: 1, seq: head.seq + 1, previousHash: head.hash, payload: structuredClone(payload) };
    const entry = { ...unsigned, hash: goalHash(unsigned) };
    head = { seq: entry.seq, hash: entry.hash };
    return entry;
  });
  return { records: entries, head };
}
function settled() {
  return [opened, producer, request("spawn"), result("spawn", 3), bound, callback(1, "ready"),
    request("release", "release"), result("release", 7), callback(2, "final"), fence, closed];
}
function seal(records) {
  return [...records, { type: "sealed", previousHead: history(records).head, censusDigest: H }];
}
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "goal-host-effects-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "effects");
  return { root, host: await GoalHostEffects.create(root, scope) };
}

test("host control bookkeeping seals only a complete fenced transcript, never Goal drain", () => {
  const view = inspectGoalHostEffects(history(seal(settled())));
  assert.equal(view.bookkeepingComplete, true);
  assert.equal(view.sealed, true);
  assert.equal(view.goalDrain, "not-established");
  assert.deepEqual(view.pendingEffects, []);
  assert.deepEqual(view.openProducers, []);
  assert.throws(() => view.conflicts.push("changed"), TypeError);
});

test("host effect schemas reject unknown fields, getters, invalid epochs and fractional heads", () => {
  assert.throws(() => parseGoalHostEffectRecord({ ...opened, qualified: true }));
  assert.throws(() => parseGoalHostEffectRecord({ type: "opened", scope: { ...scope, ownerEpoch: -1 } }));
  assert.throws(() => parseGoalHostEffectRecord({ ...request("x"), goalHead: { seq: 1.5, hash: H } }));
  for (const invalid of [{ ...localFence, reason: "owner-lost" },
    { ...localFence, unexpected: true }, { ...localFence, producerId: "" }])
    assert.throws(() => parseGoalHostEffectRecord(invalid));
  let calls = 0;
  const value = { get type() { calls += 1; return "fenced"; }, reason: "complete" };
  assert.throws(() => parseGoalHostEffectRecord(value));
  assert.equal(calls, 0);
});

test("consent evidence binds a unique pending effect but never supplies live authority or drain", () => {
  const consent = { type: "consent-bound", effectId: "verify", requestDigest: H,
    consentHash: "b".repeat(64), grantId: "consent-grant-1", stateDigest: H, expiresAt: 1 };
  const records = [opened, producer, request("verify", "verify"), consent];
  // Replay is not today's wall-clock authorization. An expired historical
  // binding remains readable, pending and non-authoritative.
  const census = inspectGoalHostEffects(history(records));
  assert.deepEqual(census.pendingEffects, ["verify"]);
  assert.equal(census.bookkeepingComplete, false);
  assert.equal(census.goalDrain, "not-established");
  for (const invalid of [
    [opened, producer, consent],
    [...records, consent],
    [opened, producer, request("verify", "verify"), fence, consent],
    [opened, producer, request("verify", "verify"), result("verify", 3), consent],
    [opened, producer, request("verify", "verify"), { ...consent, requestDigest: "c".repeat(64) }],
    [...records, request("second", "verify"), { ...consent, effectId: "second" }],
  ]) assert.throws(() => inspectGoalHostEffects(history(invalid)), /unique pending request/);
  const second = [...records, request("second", "verify"), { ...consent, effectId: "second", grantId: "consent-grant-2" }];
  assert.deepEqual(inspectGoalHostEffects(history(second)).pendingEffects, ["second", "verify"]);
});

test("complete replay rejects journal gaps, changed hashes and omitted heads", () => {
  const original = history(settled());
  for (const mutate of [
    (x) => { x.records.splice(3, 1); },
    (x) => { x.records[2].payload.operation = "tool"; },
    (x) => { x.head.seq -= 1; },
    (x) => { x.records[4].previousHash = H; },
  ]) {
    const bad = structuredClone(original);
    mutate(bad);
    assert.throws(() => inspectGoalHostEffects(bad));
  }
});

test("request and exact result lineage is once-only", () => {
  for (const records of [
    [opened, request("x")],
    [opened, producer, request("x"), request("x")],
    [opened, producer, request("x"), result("x", 4)],
    [opened, producer, request("x"), result("x", 3), result("x", 3)],
    [opened, producer, request("release", "release")],
    [opened, producer, bound, bound],
  ]) assert.throws(() => inspectGoalHostEffects(history(records)));
});

test("fencing forbids release/tool/apply/verify/spawn but accounts stop and inspection", () => {
  for (const operation of ["spawn", "release", "tool", "apply", "verify", "remove"]) {
    assert.throws(() => inspectGoalHostEffects(history([opened, producer, bound, fence, request("new", operation)])));
  }
  const view = inspectGoalHostEffects(history([opened, producer, fence, request("stop", "stop"), request("inspect", "inspect")]));
  assert.deepEqual(view.pendingEffects, ["inspect", "stop"]);
});

test("a drained locally fenced producer closes while a sibling opens, runs and completes; only global fence seals", () => {
  const sibling = { type: "producer-opened", producerId: "sibling", kind: "sdk" };
  const siblingBound = { ...bound, producerId: "sibling" };
  const siblingCallback = (ordinal, kind) => ({ ...callback(ordinal, kind), producerId: "sibling" });
  const siblingRequest = (effectId, operation) => ({ ...request(effectId, operation), producerId: "sibling" });
  const records = [opened, producer, bound, callback(1, "ready"), callback(2, "final"),
    localFence, request("stop", "stop"), result("stop", 7),
    request("inspect", "inspect"), result("inspect", 9), closed];
  const first = inspectGoalHostEffects(history(records));
  assert.equal(first.fenced, false);
  assert.deepEqual(first.openProducers, []);
  assert.equal(first.bookkeepingComplete, false);
  records.push(sibling, siblingRequest("spawn"), result("spawn", 13), siblingBound,
    siblingCallback(1, "ready"), siblingRequest("release", "release"),
    result("release", 17), siblingCallback(2, "final"),
    { ...localFence, producerId: "sibling" }, { ...closed, producerId: "sibling" });
  assert.equal(inspectGoalHostEffects(history(records)).bookkeepingComplete, false);
  const complete = inspectGoalHostEffects(history([...records, fence]));
  assert.equal(complete.bookkeepingComplete, true);
  assert.deepEqual(complete.pendingEffects, []);
  assert.deepEqual(complete.openProducers, []);
  assert.equal(inspectGoalHostEffects(history(seal([...records, fence]))).sealed, true);
  assert.throws(() => inspectGoalHostEffects(history(seal(records))));
});

test("local fence forbids new work and reuse without blocking sibling work or cleanup observation", () => {
  const prefix = [opened, producer, bound, callback(1, "final"), localFence];
  for (const operation of ["spawn", "release", "tool", "apply", "verify", "workspace-create", "workspace-write", "workspace-cleanup"])
    assert.throws(() => inspectGoalHostEffects(history([...prefix, request(`new-${operation}`, operation)])));
  for (const record of [localFence, producer, bound, closed, { ...localFence, producerId: "absent" }])
    assert.throws(() => inspectGoalHostEffects(history([...prefix, closed, record])));
  const observation = inspectGoalHostEffects(history([...prefix, request("stop", "stop"), result("stop", 6),
    request("inspect", "inspect"), result("inspect", 8), closed]));
  assert.deepEqual(observation.conflicts, []);
  assert.deepEqual(observation.openProducers, []);
  assert.equal(observation.fenced, false);
  assert.throws(() => inspectGoalHostEffects(history([...prefix, request("inspect", "inspect"), closed])));
  assert.throws(() => inspectGoalHostEffects(history([...prefix, request("inspect", "inspect"),
    result("inspect", 6, "unknown"), closed])));
});

test("late callbacks after local fence poison the entire scope but earlier FINAL remains valid", () => {
  const prefix = [opened, producer, bound, callback(1, "final"), localFence];
  const valid = inspectGoalHostEffects(history([...prefix, closed]));
  assert.deepEqual(valid.conflicts, []);
  for (const records of [[...prefix, callback(2)], [...prefix, closed, callback(2)],
    [opened, producer, bound, localFence, callback(1, "final"), closed]]) {
    const view = inspectGoalHostEffects(history(records));
    assert.equal(view.fenced, true);
    assert.equal(view.bookkeepingComplete, false);
    assert.ok(view.conflicts.some((conflict) => conflict.startsWith("callback:")));
  }
});

test("unknown acknowledgement is sticky; later inspection cannot erase it or authorize sealing", () => {
  const records = [opened, producer, request("spawn"), result("spawn", 3, "unknown"), fence,
    request("inspect", "inspect"), result("inspect", 6)];
  assert.deepEqual(inspectGoalHostEffects(history(records)).unknownEffects, ["spawn"]);
  assert.throws(() => inspectGoalHostEffects(history(seal(records))));
  assert.throws(() => inspectGoalHostEffects(history([...records, result("spawn", 3)])));
});

test("callback holes, duplicate and final contradictions remain durable conflicts", () => {
  for (const callbacks of [
    [callback(2), callback(1)],
    [callback(1), callback(1)],
    [callback(1, "final"), callback(2)],
    [{ ...callback(1), producerId: "absent" }],
  ]) {
    const records = [opened, producer, bound, ...callbacks];
    const view = inspectGoalHostEffects(history(records));
    assert.equal(view.fenced, true);
    assert.ok(view.conflicts.length > 0);
    assert.equal(view.bookkeepingComplete, false);
    assert.throws(() => inspectGoalHostEffects(history(seal(records))));
  }
});

test("missing FINAL, unknown producer and premature close cannot establish completeness", () => {
  assert.throws(() => inspectGoalHostEffects(history([opened, producer, closed])));
  for (const records of [
    [opened, producer, bound, fence, closed],
    [opened, producer, fence, { ...closed, outcome: "unknown" }],
  ]) assert.equal(inspectGoalHostEffects(history(records)).bookkeepingComplete, false);
});

test("never-started requires zero binding/callbacks and no accepted or pending request", () => {
  const never = { ...closed, outcome: "never-started" };
  const records = [opened, producer, request("spawn"), result("spawn", 3, "rejected"), fence, never];
  assert.equal(inspectGoalHostEffects(history(records)).bookkeepingComplete, true);
  for (const prefix of [
    [opened, producer, bound],
    [opened, producer, callback(1)],
    [opened, producer, request("spawn")],
    [opened, producer, request("spawn"), result("spawn", 3)],
  ]) assert.throws(() => inspectGoalHostEffects(history([...prefix, fence, never])));
});

test("seal binds exact current head; late callbacks invalidate a historical seal", () => {
  const records = settled();
  const bad = [...records, { type: "sealed", previousHead: history(records.slice(0, -1)).head, censusDigest: H }];
  assert.throws(() => inspectGoalHostEffects(history(bad)));
  const late = inspectGoalHostEffects(history([...seal(records), callback(3)]));
  assert.equal(late.sealed, false);
  assert.equal(late.bookkeepingComplete, false);
  assert.equal(late.conflicts.length, 1);
  assert.equal(late.goalDrain, "not-established");
});

test("post-seal removal remains an accounted pending effect and unknown result blocks completion", () => {
  const records = [...seal(settled()), request("remove", "remove")];
  const pending = inspectGoalHostEffects(history(records));
  assert.equal(pending.sealed, false);
  const failed = inspectGoalHostEffects(history([...records, result("remove", records.length, "unknown")]));
  assert.equal(failed.bookkeepingComplete, false);
  assert.deepEqual(failed.unknownEffects, ["remove"]);
  assert.equal(inspectGoalHostEffects(history([...records, result("remove", records.length)])).sealed, true);
});

test("physical host ledger persists before promise fulfillment and reopens read-only (not a dispatch gate)", async (t) => {
  const { root, host } = await fixture(t);
  await host.record(producer);
  const pending = await host.record(request("spawn"));
  assert.deepEqual(pending.pendingEffects, ["spawn"]);
  const reopened = await GoalHostEffects.open(root);
  assert.deepEqual(await reopened.inspect(), pending);
  const complete = await host.record(result("spawn", 3));
  assert.deepEqual(complete.pendingEffects, []);
  assert.equal(complete.goalDrain, "not-established");
});

test("physical producer fence survives reopen and leaves a sibling dispatchable", async (t) => {
  const { root, host } = await fixture(t);
  await host.record(producer);
  await host.record(bound);
  await host.record(callback(1, "final"));
  await host.record(localFence);
  await host.record(closed);
  const recovered = await (await GoalHostEffects.open(root)).inspect();
  assert.equal(recovered.fenced, false);
  assert.deepEqual(recovered.openProducers, []);
  await assert.rejects(host.record(request("denied", "spawn")), /fencing/);
  await host.record({ ...producer, producerId: "sibling" });
  const sibling = await host.record({ ...request("sibling-spawn"), producerId: "sibling" });
  assert.deepEqual(sibling.pendingEffects, ["sibling-spawn"]);
  assert.deepEqual((await (await GoalHostEffects.open(root)).inspect()).pendingEffects, ["sibling-spawn"]);
});

test("reopening an effect ledger does not expose mutation or construct a host dispatcher", async (t) => {
  const { root, host } = await fixture(t);
  await host.record(producer);
  const reader = await GoalHostEffects.open(root);
  assert.deepEqual(Object.keys(reader), ["inspect"]);
  assert.equal(reader.record, undefined);
  assert.equal(Object.isFrozen(reader), true);
  assert.throws(() => new GoalHostEffects({}), /private/);
});

test("an unattributed FINAL cannot be retroactively bound and sealed", () => {
  const prefix = [opened, producer, callback(1, "final")];
  assert.equal(inspectGoalHostEffects(history(prefix)).conflicts.length, 1);
  assert.throws(() => inspectGoalHostEffects(history([...prefix, bound, fence, closed])));
});

test("physical host ledger serializes competing IDs and retains only one durable request", async (t) => {
  const { root, host } = await fixture(t);
  await host.record(producer);
  const results = await Promise.allSettled([host.record(request("same")), host.record(request("same"))]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const view = await (await GoalHostEffects.open(root)).inspect();
  assert.equal(view.head.seq, 3);
  assert.deepEqual(view.pendingEffects, ["same"]);
});

test("physical ledger captures mutable inputs before asynchronous publication", async (t) => {
  const { host } = await fixture(t);
  await host.record(producer);
  const mutable = request("captured");
  const pending = host.record(mutable);
  mutable.effectId = "mutated";
  mutable.goalHead.seq = 999;
  assert.deepEqual((await pending).pendingEffects, ["captured"]);
});

test("physical ledger preserves late contradictions across reopen", async (t) => {
  const { root, host } = await fixture(t);
  for (const record of settled().slice(1)) await host.record(record);
  const before = await host.inspect();
  await host.record({ type: "sealed", previousHead: before.head, censusDigest: H });
  await host.record(callback(3));
  const reopened = await (await GoalHostEffects.open(root)).inspect();
  assert.equal(reopened.sealed, false);
  assert.equal(reopened.conflicts.length, 1);
});

test("physical ledger read uncertainty poisons its live handle even after bytes are restored", async (t) => {
  const { root, host } = await fixture(t);
  await host.record(producer);
  const names = await readdir(root);
  // Deliberate foreign residue in this disposable fixture, never a product cleanup.
  const foreign = join(root, "foreign-uncertain");
  await writeFile(foreign, "unknown", { mode: 0o600, flag: "wx" });
  await assert.rejects(host.inspect());
  await rm(foreign);
  await assert.rejects(host.inspect(), /uncertainty|recovery/);
  const reopened = await GoalHostEffects.open(root);
  assert.equal((await reopened.inspect()).head.seq, 2);
  assert.deepEqual(await readdir(root), names);
});
