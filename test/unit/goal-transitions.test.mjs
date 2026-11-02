import test from "node:test";
import assert from "node:assert/strict";
import {
  fixture,
  criterion,
  blocker,
  user,
  hostActor,
  h,
  goalHash,
} from "./helpers/goal-fixture.mjs";
import { reduceGoal } from "../../.tmp/unit/goal-decision.js";
import { GoalStore } from "../../.tmp/unit/goal-store.js";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const fold = (f, events, changes) =>
  reduceGoal(f.contract, events, f.obs(changes));
const verifier = { kind: "verifier", id: "fixture-verifier" };
function update(f, binding, fields = {}, inventory = {}) {
  const c = f.contract.criteria[0];
  return f.event(
    "binding-updated",
    {
      criterionId: c.id,
      previousBindingHash: goalHash(c.binding),
      binding,
      subjectScope: f.contract.subjectScope[0],
      authorityHash: f.contract.authorityHash,
      evidenceRefs: [h("scope-inspection")],
      ...fields,
    },
    hostActor,
    { ...f.obsData, bindings: [{ criterionId: c.id, binding }], ...inventory },
  );
}
function resolveBlocker(f, event, fields = {}, actor = user, inventory = {}) {
  const b = event.data.blocker;
  return f.event(
    "blocker-resolved",
    {
      blockerId: b.id,
      instanceDigest: b.instanceDigest,
      blockerEventId: event.data.id,
      authorityHash: f.contract.authorityHash,
      evidenceRefs: [h("owner-resolution")],
      ...fields,
    },
    actor,
    { ...f.obsData, ...inventory },
  );
}
function resolveEvidence(
  f,
  old,
  replacement,
  fields = {},
  actor = verifier,
  inventory = {},
) {
  return f.event(
    "evidence-resolved",
    {
      criterionId: replacement.data.receipt.criterionId,
      bindingHash: goalHash(replacement.data.receipt.binding),
      receiptIds: old.map((e) => e.data.receipt.id),
      replacementReceiptId: replacement.data.receipt.id,
      evidenceRefs: [h("resolution-report")],
      rationale:
        "Fresh registered check explicitly resolves the cited counterevidence.",
      ...fields,
    },
    actor,
    { ...f.obsData, ...inventory },
  );
}

test("P1 transitions persist, reject stale writes before publication and rebuild without losing old evidence", async () => {
  const f = fixture();
  const parent = join(process.cwd(), ".tmp", "goal-p1-followup");
  await mkdir(parent, { recursive: true });
  const root = join(await mkdtemp(join(parent, "journal-")), "goal");
  const store = new GoalStore(root);
  const owner = store.hostOwner("owner", 0);
  let snapshot = await store.create(f.contract, owner, f.obs());
  const current = {
    ...f.contract.criteria[0].binding,
    subjectDigest: h("next"),
  };
  const inventory = {
    ...f.obsData,
    bindings: [{ criterionId: "objective", binding: current }],
  };
  const fail = f.receipt(undefined, {
    binding: current,
    result: "fail",
    observedAt: 80,
  });
  const pass = f.receipt(undefined, {
    binding: current,
    observedAt: 95,
    evidenceRefs: [h("fresh")],
  });
  const be = f.event(
    "blocker",
    { blocker: blocker("manual", { errorClass: "human" }) },
    hostActor,
    inventory,
  );
  const events = [
    f.event("start"),
    f.receipt(undefined, { result: "fail" }),
    update(f, current),
    fail,
    pass,
    resolveEvidence(f, [fail], pass, {}, verifier, inventory),
    be,
    resolveBlocker(f, be, {}, user, inventory),
    f.event("reconcile", {}, hostActor, inventory),
  ];
  for (const event of events)
    snapshot = await store.commitEvent(owner, snapshot, event);
  const beforeHash = snapshot.hash;
  const contractBytes = await readFile(join(root, "contract.json"));
  await assert.rejects(
    store.commitEvent(
      owner,
      snapshot,
      update(f, { ...current, subjectDigest: h("third") }),
    ),
    /predecessor/,
  );
  assert.equal((await store.load()).hash, beforeHash);
  assert.equal(
    (await readdir(join(root, "journal"))).filter((n) => n.endsWith(".json"))
      .length,
    events.length + 1,
  );
  snapshot = await store.commitEvent(
    owner,
    snapshot,
    f.terminal("achieved", inventory),
  );
  assert.equal(snapshot.decision.lifecycle, "achieved");
  assert.equal(snapshot.events[1].data.receipt.result, "fail");
  assert.equal(snapshot.decision.resolvedBlockers.length, 1);
  assert.deepEqual(snapshot.decision.criteria[0].supersededReceiptIds, [
    fail.data.receipt.id,
  ]);
  await writeFile(join(root, "projection.json"), "BROKEN CACHE");
  const restored = await store.rebuildProjection();
  assert.equal(goalHash(restored.decision), goalHash(snapshot.decision));
  assert.deepEqual(await readFile(join(root, "contract.json")), contractBytes);
  const reopened = await new GoalStore(root).load();
  assert.equal(goalHash(reopened.decision), goalHash(snapshot.decision));
});

// These three tests must first fail on the prior staged draft, not assert the gaps.
test("P1-BINDING fresh scoped candidate can be accepted without criterion revision", () => {
  const f = fixture();
  const current = {
    ...f.contract.criteria[0].binding,
    subjectDigest: h("new-candidate"),
  };
  const before = goalHash(f.contract);
  const old = f.receipt(undefined, { result: "fail" });
  const events = [
    f.event("start"),
    old,
    update(f, current),
    f.receipt(undefined, { binding: current }),
  ];
  const inventory = {
    bindings: [{ criterionId: "objective", binding: current }],
  };
  const d = fold(f, events, inventory);
  assert.equal(d.criteria[0].state, "met");
  assert.equal(d.contractHash, before);
  assert.equal(goalHash(f.contract), before);
  assert.equal(events[1].data.receipt.result, "fail");
  assert.equal(
    fold(f, [...events, f.terminal("achieved", inventory)], inventory)
      .lifecycle,
    "achieved",
  );
});
test("P1-BLOCKER exact manual resolution retires only active instance and requires reconcile", () => {
  const f = fixture();
  const be = f.event("blocker", {
    blocker: blocker("human", { errorClass: "human" }),
  });
  const events = [f.event("start"), be, f.receipt(), resolveBlocker(f, be)];
  const d = fold(f, events);
  assert.equal(d.blockers.length, 0);
  assert.equal(d.phase, "reconcile");
  assert.equal(d.resolvedBlockers[0].blockerEventId, be.data.id);
  assert.throws(() => fold(f, [...events, f.terminal()]), /achievement/);
  assert.equal(
    fold(f, [...events, f.event("reconcile"), f.terminal()]).lifecycle,
    "achieved",
  );
  assert.equal(be.data.blocker.errorClass, "human");
});
test("P1-RESOLUTION exact fresh verifier resolution can retire conflict without deleting receipts", () => {
  const f = fixture();
  const failed = f.receipt(undefined, { result: "fail", observedAt: 80 });
  const fresh = f.receipt(undefined, {
    evidenceRefs: [h("fresh-check")],
    observedAt: 95,
  });
  const events = [f.event("start"), failed, fresh];
  assert.equal(fold(f, events).criteria[0].state, "conflicted");
  events.push(resolveEvidence(f, [failed], fresh));
  const d = fold(f, events);
  assert.equal(d.criteria[0].state, "met");
  assert.deepEqual(d.criteria[0].supersededReceiptIds, [
    failed.data.receipt.id,
  ]);
  assert.deepEqual(d.criteria[0].receiptIds, [fresh.data.receipt.id]);
  assert.equal(failed.data.receipt.result, "fail");
  assert.equal(fold(f, [...events, f.terminal()]).lifecycle, "achieved");
});

for (const field of [
  "environmentDigest",
  "verifierId",
  "producerLineageDigest",
  "codeDigest",
  "configDigest",
  "target",
]) {
  test(`P1-BINDING rejects immutable ${field} drift`, () => {
    const f = fixture();
    const current = {
      ...f.contract.criteria[0].binding,
      subjectDigest: h("next"),
      [field]:
        field === "verifierId"
          ? "other"
          : field === "target"
            ? "origin"
            : h("changed"),
    };
    assert.throws(
      () => fold(f, [f.event("start"), update(f, current)]),
      /policy/,
    );
  });
}
test("P1-BINDING rejects missing scope evidence, stale predecessor, unauthorized scope and unobserved bytes", () => {
  const f = fixture();
  const current = {
    ...f.contract.criteria[0].binding,
    subjectDigest: h("next"),
  };
  for (const fields of [
    { previousBindingHash: h("wrong") },
    { authorityHash: h("wrong") },
    { subjectScope: "outside" },
    { evidenceRefs: [] },
    { criterionId: "unknown" },
  ]) {
    assert.throws(() =>
      fold(f, [f.event("start"), update(f, current, fields)]),
    );
  }
  assert.throws(
    () => fold(f, [f.event("start"), update(f, current, {}, { bindings: [] })]),
    /observation/,
  );
  const accepted = update(f, current);
  assert.throws(
    () => fold(f, [f.event("start"), structuredClone(accepted)]),
    /host ingress/,
  );
  assert.throws(
    () => f.ingress.event(accepted.data, verifier, accepted.observations),
    /host ingress/,
  );
  assert.throws(
    () =>
      fold(f, [f.event("start"), update(f, f.contract.criteria[0].binding)]),
    /no-op/,
  );
});
test("P1-BINDING new subject stales prior receipt; merely changing observation cannot admit a subject", () => {
  const f = fixture();
  const current = {
    ...f.contract.criteria[0].binding,
    subjectDigest: h("next"),
  };
  const inv = { bindings: [{ criterionId: "objective", binding: current }] };
  const old = f.receipt();
  assert.equal(
    fold(f, [f.event("start"), old, update(f, current)], inv).criteria[0].state,
    "stale",
  );
  assert.equal(
    fold(f, [f.event("start"), f.receipt(undefined, { binding: current })], inv)
      .criteria[0].state,
    "stale",
  );
});
test("P1-BINDING round trip to same bytes cannot launder still-valid counterevidence", () => {
  const f = fixture();
  const original = f.contract.criteria[0].binding;
  const next = { ...original, subjectDigest: h("next") };
  const events = [
    f.event("start"),
    f.receipt(undefined, { result: "fail" }),
    update(f, next),
    update(f, original, { previousBindingHash: goalHash(next) }),
    f.receipt(undefined, { observedAt: 95 }),
  ];
  assert.equal(fold(f, events).criteria[0].state, "conflicted");
});
test("P1-BINDING origin update requires new apply and exact post-apply origin receipt", () => {
  const f = fixture({
    completionTarget: "origin",
    criteria: [criterion("origin", "deterministic", "origin")],
  });
  const original = f.contract.criteria[0].binding;
  const current = { ...original, subjectDigest: h("new-origin") };
  const inv = { bindings: [{ criterionId: "origin", binding: current }] };
  const events = [
    f.event("start"),
    f.event("apply", {
      intentHash: h("old-apply-intent"),
      applyJournalHead: { seq: 3, hash: h("old-apply-journal") },
      originIdentity: "fixture-root",
      originDigest: original.subjectDigest,
      at: 80,
      state: "verified",
    }),
    update(f, current),
    f.receipt(undefined, { binding: current, observedAt: 95 }),
  ];
  const unconsented = fold(f, events, inv);
  assert.equal(unconsented.lifecycle, "blocked");
  assert.equal(unconsented.phase, "apply");
  assert.deepEqual(unconsented.reasons, [
    "origin-application-unverified",
    "initial-origin-consent-unavailable",
  ]);
  assert.deepEqual(unconsented.proposals, []);
  assert.throws(() => fold(f, [...events, f.terminal("achieved", inv)], inv));
  const applied = f.event("apply", {
    intentHash: h("current-apply-intent"),
    applyJournalHead: { seq: 7, hash: h("current-apply-journal") },
    originIdentity: "fixture-root",
    originDigest: current.subjectDigest,
    at: 96,
    state: "verified",
  });
  assert.equal(fold(f, [...events, applied], inv).criteria[0].state, "stale");
  const done = [
    ...events,
    applied,
    f.receipt(undefined, { binding: current, observedAt: 98 }),
    f.terminal("achieved", inv),
  ];
  assert.equal(fold(f, done, inv).lifecycle, "achieved");
});
test("P1-BLOCKER stale instance, creation event, authority, wrong actor and duplicate resolution reject", () => {
  const f = fixture();
  const be = f.event("blocker", { blocker: blocker() });
  const base = [f.event("start"), be];
  for (const fields of [
    { instanceDigest: h("wrong") },
    { blockerEventId: "old-event" },
    { authorityHash: h("wrong") },
    { blockerId: "missing" },
    { evidenceRefs: [] },
  ])
    assert.throws(() => fold(f, [...base, resolveBlocker(f, be, fields)]));
  assert.throws(() => resolveBlocker(f, be, {}, hostActor), /user ingress/);
  assert.throws(
    () =>
      fold(f, [
        ...base,
        resolveBlocker(f, be, {}, { kind: "user", id: "wrong-owner" }),
      ]),
    /actor/,
  );
  const resolved = [...base, resolveBlocker(f, be)];
  assert.throws(() => fold(f, [...resolved, resolveBlocker(f, be)]), /stale/);
  const reopened = f.event("blocker", { blocker: be.data.blocker });
  assert.throws(
    () => fold(f, [...resolved, reopened, resolveBlocker(f, be)]),
    /instance/,
  );
  assert.equal(
    fold(f, [...resolved, reopened, resolveBlocker(f, reopened)])
      .resolvedBlockers.length,
    2,
  );
});
test("P1-BLOCKER same-family replacement is exact-instance and duplicate active IDs are ambiguous", () => {
  const f = fixture();
  const old = f.event("blocker", { blocker: blocker("same") });
  const next = f.event("blocker", {
    blocker: blocker("same", { instanceDigest: h("new-instance") }),
  });
  const base = [f.event("start"), old, next];
  assert.throws(() => fold(f, [...base, resolveBlocker(f, old)]), /instance/);
  assert.equal(fold(f, [...base, resolveBlocker(f, next)]).blockers.length, 0);
  const ambiguous = f.event("blocker", {
    blocker: blocker("same", { resource: "another-family" }),
  });
  assert.throws(() => fold(f, [...base, ambiguous]), /duplicate active/);
});
test("P1-BLOCKER manual retirement never resets retry/no-progress/usage/family budgets or grants authority", () => {
  const f = fixture();
  const b = blocker();
  const be = f.event("blocker", { blocker: b });
  const resumed = f.event("resume", {
    blockerId: b.id,
    blockerEventId: be.data.id,
    instanceDigest: b.instanceDigest,
    predicateId: b.predicateId,
    condition: true,
    ownerPresent: true,
  });
  const be2 = f.event("blocker", { blocker: blocker("again") });
  const base = [
    f.event("start"),
    be,
    resumed,
    f.event("attempt", {
      operationId: "op",
      consumed: 3,
      usage: { requests: null, costMicros: null },
    }),
    be2,
  ];
  const before = fold(f, base);
  const after = fold(f, [
    ...base,
    resolveBlocker(f, be2),
    f.event("reconcile"),
  ]);
  assert.deepEqual(after.counters, before.counters);
  assert.equal(after.counters.requests, null);
  assert.equal(after.lifecycle, "blocked");
  assert.equal(after.contractHash, before.contractHash);
});
for (const latch of ["pause", "cancel", "revoke"]) {
  test(`all new transitions reject ${latch} latch and cannot resurrect terminal`, () => {
    const f = fixture();
    const be = f.event("blocker", { blocker: blocker() });
    const failed = f.receipt(undefined, { result: "fail", observedAt: 80 });
    const fresh = f.receipt(undefined, {
      observedAt: 95,
      evidenceRefs: [h("fresh")],
    });
    const base = [
      f.event("start"),
      be,
      failed,
      fresh,
      f.event("control", { action: latch }, user),
    ];
    for (const action of [
      resolveBlocker(f, be),
      resolveEvidence(f, [failed], fresh),
      update(f, {
        ...f.contract.criteria[0].binding,
        subjectDigest: h("next"),
      }),
    ]) {
      assert.throws(() => fold(f, [...base, action]), /latch/);
      const terminal = [f.event("start"), f.receipt(), f.terminal()];
      assert.throws(() => fold(f, [...terminal, action]), /terminal/);
    }
  });
}
test("all new transitions require complete drained journal and event-time host inventory", () => {
  const f = fixture();
  const be = f.event("blocker", { blocker: blocker() });
  const failed = f.receipt(undefined, { result: "fail", observedAt: 80 });
  const fresh = f.receipt(undefined, {
    observedAt: 95,
    evidenceRefs: [h("fresh")],
  });
  const base = [f.event("start"), be, failed, fresh];
  const current = {
    ...f.contract.criteria[0].binding,
    subjectDigest: h("next"),
  };
  for (const inventory of [
    { effectsKnown: false },
    { effects: [{ id: "probe", kind: "probe", state: "unknown" }] },
  ]) {
    for (const action of [
      resolveBlocker(f, be, {}, user, inventory),
      resolveEvidence(f, [failed], fresh, {}, verifier, inventory),
      update(f, current, {}, inventory),
    ])
      assert.throws(() => fold(f, [...base, action]), /drained/);
  }
  const active = f.event("effect", {
    effectId: "child",
    kind: "child",
    state: "active",
  });
  for (const action of [
    resolveBlocker(f, be),
    resolveEvidence(f, [failed], fresh),
    update(f, current),
  ])
    assert.throws(() => fold(f, [...base, active, action]), /drained/);
});
for (const mutant of [
  "unknown",
  "stale",
  "future",
  "not-newer",
  "recycled-evidence",
]) {
  test(`P1-RESOLUTION rejects ${mutant} replacement`, () => {
    const f = fixture();
    const old = f.receipt(undefined, { result: "fail" });
    const changes = {
      observedAt: 95,
      evidenceRefs: [h("fresh")],
      ...{
        unknown: { result: "unknown" },
        stale: { validUntil: 96 },
        future: { observedAt: 101 },
        "not-newer": { observedAt: 90 },
        "recycled-evidence": { evidenceRefs: old.data.receipt.evidenceRefs },
      }[mutant],
    };
    const fresh = f.receipt(undefined, changes);
    assert.throws(() =>
      fold(f, [f.event("start"), old, fresh, resolveEvidence(f, [old], fresh)]),
    );
  });
}
test("P1-RESOLUTION rejects cherry-picking, cross criterion, stale binding, foreign actor and forged provenance", () => {
  const f = fixture();
  const a = f.receipt(undefined, { result: "fail", observedAt: 80 });
  const b = f.receipt(undefined, { result: "unknown", observedAt: 85 });
  const fresh = f.receipt(undefined, {
    observedAt: 95,
    evidenceRefs: [h("fresh")],
  });
  const base = [f.event("start"), a, b, fresh];
  for (const fields of [
    { receiptIds: [a.data.receipt.id] },
    { receiptIds: [a.data.receipt.id, "missing"] },
    { receiptIds: [a.data.receipt.id, a.data.receipt.id] },
    { replacementReceiptId: "missing" },
    { bindingHash: h("wrong") },
    { criterionId: "missing" },
    { evidenceRefs: [] },
    { receiptIds: [fresh.data.receipt.id] },
  ])
    assert.throws(() =>
      fold(f, [...base, resolveEvidence(f, [a, b], fresh, fields)]),
    );
  assert.throws(
    () => fold(f, [...base, resolveEvidence(f, [a, b], fresh, {}, user)]),
    /verifier/,
  );
  assert.throws(
    () =>
      fold(f, [
        ...base,
        resolveEvidence(
          f,
          [a, b],
          fresh,
          {},
          { kind: "verifier", id: "other" },
        ),
      ]),
    /verifier/,
  );
  const accepted = resolveEvidence(f, [a, b], fresh);
  assert.throws(
    () => fold(f, [...base, structuredClone(accepted)]),
    /host ingress/,
  );
  assert.equal(fold(f, [...base, accepted]).criteria[0].state, "met");
});
test("P1-RESOLUTION later counterexample reopens conflict; expired replacement is not achievement", () => {
  const f = fixture();
  const old = f.receipt(undefined, { result: "fail", observedAt: 80 });
  const fresh = f.receipt(undefined, {
    observedAt: 95,
    validUntil: 150,
    evidenceRefs: [h("fresh")],
  });
  const events = [
    f.event("start"),
    old,
    fresh,
    resolveEvidence(f, [old], fresh),
  ];
  assert.equal(fold(f, events, { at: 151 }).criteria[0].state, "stale");
  assert.equal(
    fold(f, [
      ...events,
      f.receipt(undefined, { result: "fail", observedAt: 99 }),
    ]).criteria[0].state,
    "conflicted",
  );
  assert.throws(
    () => fold(f, [...events, resolveEvidence(f, [old], fresh)]),
    /cover/,
  );
  assert.equal(goalHash(fold(f, events)), goalHash(fold(f, events)));
});
for (const kind of ["model-rubric", "human"]) {
  test(`P1-RESOLUTION ${kind} preserves acceptance kind and exact designated actor`, () => {
    const f = fixture({ criteria: [criterion("judgment", kind)] });
    const old = f.receipt(undefined, { result: "fail", observedAt: 80 });
    const fresh = f.receipt(undefined, {
      observedAt: 95,
      evidenceRefs: [h("fresh")],
    });
    const actor = kind === "human" ? user : verifier;
    const events = [
      f.event("start"),
      old,
      fresh,
      resolveEvidence(f, [old], fresh, {}, actor),
    ];
    assert.equal(fold(f, events).criteria[0].state, "met");
    assert.equal(fold(f, events).criteria[0].kind, kind);
    if (kind === "model-rubric") {
      const withCounterexample = f.receipt(undefined, {
        observedAt: 95,
        evidenceRefs: [h("fresh")],
        model: {
          ...fresh.data.receipt.model,
          counterexamples: ["Still unresolved"],
        },
      });
      assert.throws(
        () =>
          fold(f, [
            events[0],
            old,
            withCounterexample,
            resolveEvidence(f, [old], withCounterexample),
          ]),
        /definitive/,
      );
    } else {
      assert.throws(
        () =>
          fold(f, [
            events[0],
            old,
            fresh,
            resolveEvidence(f, [old], fresh, {}, verifier),
          ]),
        /verifier/,
      );
    }
  });
}
