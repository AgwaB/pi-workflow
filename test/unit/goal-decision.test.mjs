import test from 'node:test';
import assert from 'node:assert/strict';
import { reduceGoal, goalBlockerFamily, GOAL_RUNTIME_POLICY } from '../../.tmp/unit/goal-decision.js';
import { fixture, criterion, blocker, h, goalHash, user } from './helpers/goal-fixture.mjs';

function fold(f, events, changes) { return reduceGoal(f.contract, events, f.obs(changes)); }
test('B01 CORE completed/PASS/loop cap/stop response are notes, never achievement', () => {
  const f = fixture();
  for (const text of ['child completed PASS', 'loop cap reached', 'stop returned success', 'user accepted this report']) {
    const es = [f.event('start'), f.event('note', { text })];
    assert.equal(fold(f, es).criteria[0].state, 'unknown');
    assert.throws(() => fold(f, [...es, f.terminal()]), /achievement not established/);
  }
});
test('B02 S01 CORE exact fake deterministic receipt, explicit finalize and stable pure replay', () => {
  const f = fixture(); const es = [f.event('start'), f.receipt()];
  assert.equal(fold(f, es).criteria[0].state, 'met'); assert.equal(fold(f, es).lifecycle, 'running');
  es.push(f.terminal()); const hash = goalHash(fold(f, es));
  for (let n = 0; n < 5; n++) assert.equal(goalHash(fold(f, es)), hash);
  assert.equal(fold(f, es).lifecycle, 'achieved');
  assert.equal(fold(f, es, { at: 999999, bindings: [], effectsKnown: false }).lifecycle, 'achieved'); // Historical, exact terminal scope.
  assert.throws(() => fold(f, [...es, f.event('note', { text: 'new run' })]), /terminal is immutable/);
});
test('DP09 unmet criteria propose plan/admit, then verify only after durable host plan event', () => {
  const f = fixture();
  const start = f.event('start');
  assert.equal(fold(f, [start]).phase, 'plan');
  assert.deepEqual(fold(f, [start]).proposals, [{ type: 'admit', criterionId: 'objective' }]);
  const active = f.event('effect', { effectId: 'child-1', kind: 'child', state: 'active' });
  const plan = f.event('plan', { planId: 'plan-1', effectId: 'child-1', actionKey: h('action'), proposalHash: h('proposal'), criterionIds: ['objective'] });
  const drained = f.event('effect', { effectId: 'child-1', kind: 'child', state: 'drained' });
  assert.equal(fold(f, [start, active, plan, drained]).phase, 'verify');
  assert.deepEqual(fold(f, [start, active, plan, drained]).proposals, [{ type: 'verify', criterionId: 'objective' }]);
  const failedVerification = f.receipt(undefined, { result: 'fail' });
  assert.equal(fold(f, [start, active, plan, drained, failedVerification]).phase, 'plan');
  assert.equal(fold(f, [start, active, plan, drained, failedVerification]).proposals[0].type, 'admit');
  assert.throws(() => f.event('plan', { planId: 'forged-plan', effectId: 'child-1', actionKey: h('action'), proposalHash: h('proposal'), criterionIds: ['objective'] }, user), /host ingress/);
});
test('B03 B04 CORE model-rubric remains typed and cannot offset required deterministic failure', () => {
  const f = fixture({ criteria: [criterion('objective'), criterion('rubric', 'model-rubric')] });
  const es = [f.event('start'), f.receipt(f.contract.criteria[0], { result: 'fail' }), f.receipt(f.contract.criteria[1])];
  const d = fold(f, es); assert.equal(d.criteria[0].state, 'unmet'); assert.equal(d.criteria[1].kind, 'model-rubric'); assert.equal(d.criteria[1].state, 'met');
  assert.throws(() => fold(f, [...es, f.terminal()]));
  const yes = [f.event('start'), ...f.contract.criteria.map(c => f.receipt(c)), f.terminal()];
  assert.equal(fold(f, yes).lifecycle, 'achieved');
});
test('B05 B06 CORE exact fake trusted human response only, absent/wrong target remains waiting', () => {
  const f = fixture({ criteria: [criterion('human', 'human')] }); const start = f.event('start');
  assert.equal(fold(f, [start]).lifecycle, 'waiting_user');
  const wrong = f.receipt(undefined, { humanRequestHash: h('different-pending-request') });
  assert.equal(fold(f, [start, wrong]).criteria[0].state, 'stale');
  assert.equal(fold(f, [start, wrong]).lifecycle, 'waiting_user');
  assert.equal(fold(f, [start, f.receipt(), f.terminal()]).lifecycle, 'achieved');
});
for (const field of ['subjectDigest', 'environmentDigest', 'verifierId', 'codeDigest', 'configDigest', 'target']) {
  test(`B07 CORE exact ${field} drift stales evidence`, () => {
    const f = fixture(); const binding = { ...f.contract.criteria[0].binding, [field]: field === 'verifierId' ? 'other-verifier' : field === 'target' ? 'origin' : h('drift') };
    const es = [f.event('start'), f.receipt()];
    assert.equal(fold(f, es, { bindings: [{ criterionId: 'objective', binding }] }).criteria[0].state, 'stale');
    const wrongReceipt = f.receipt(undefined, { binding });
    assert.equal(fold(f, [es[0], wrongReceipt]).criteria[0].state, 'stale');
  });
}
test('B07 CORE expiry/future observation/max age/model identity/rubric drift never met', () => {
  const f = fixture();
  for (const change of [{ validUntil: 99 }, { acceptanceDigest: h('changed') }, { producer: { id: 'other', lineageDigest: h('lineage') } }]) {
    assert.equal(fold(f, [f.event('start'), f.receipt(undefined, change)]).criteria[0].state, 'stale');
  }
  for (const at of [100, 101]) assert.throws(() => fold(f, [f.event('start'), f.receipt(undefined, { observedAt: 101 })], { at }), /future receipt/);
  assert.equal(fold(f, [f.event('start'), f.receipt(undefined, { observedAt: 0, validUntil: 99999 })], { at: 1001 }).criteria[0].state, 'stale');
  const m = fixture({ criteria: [criterion('rubric', 'model-rubric')] });
  const receipt = m.receipt().data.receipt;
  assert.equal(fold(m, [m.event('start'), m.receipt(undefined, { model: { ...receipt.model, thinking: 'low' } })]).criteria[0].state, 'stale');
});
test('B08 CORE incompatible valid pass/fail stays conflicted; unknown and model counterexamples preserved', () => {
  const f = fixture(); const es = [f.event('start'), f.receipt(), f.receipt(undefined, { result: 'fail' }), f.receipt(), f.receipt()];
  assert.equal(fold(f, es).criteria[0].state, 'conflicted'); assert.throws(() => fold(f, [...es, f.terminal()]));
  assert.equal(fold(f, [es[0], f.receipt(undefined, { result: 'unknown' })]).criteria[0].state, 'unknown');
  assert.equal(fold(f, [es[0], f.receipt(), f.receipt(undefined, { result: 'unknown' })]).criteria[0].state, 'unknown');
  const m = fixture({ criteria: [criterion('rubric', 'model-rubric')] }); const r = m.receipt().data.receipt;
  assert.equal(fold(m, [m.event('start'), m.receipt(undefined, { model: { ...r.model, counterexamples: ['Unresolved contrary evidence'] } })]).criteria[0].state, 'conflicted');
});
for (const kind of ['child', 'probe', 'apply', 'stop', 'verifier', 'helper']) {
  for (const state of ['active', 'unknown']) {
    test(`B10 CORE ${kind}/${state} blocks every terminal until host drain`, () => {
      const f = fixture(); const es = [f.event('start'), f.receipt(), f.event('effect', { effectId: 'effect-1', kind, state })];
      assert.equal(fold(f, es).pendingEffects.length, 1);
      for (const lifecycle of ['achieved', 'failed', 'cancelled']) assert.throws(() => fold(f, [...es, f.terminal(lifecycle)]), /pending/);
      assert.equal(fold(f, [...es, f.event('effect', { effectId: 'effect-1', kind, state: 'drained' }), f.terminal()]).lifecycle, 'achieved');
    });
  }
}
test('B10 CORE unknown inventory, unjournaled probes and stop-return do not establish drain', () => {
  const f = fixture(); const es = [f.event('start'), f.receipt()];
  assert.throws(() => fold(f, [...es, f.terminal('achieved', { effectsKnown: false })]), /pending/);
  assert.throws(() => fold(f, [...es, f.terminal('achieved', { effects: [{ id: 'probe-x', kind: 'probe', state: 'unknown' }] })]), /pending/);
  const cancel = [...es, f.event('effect', { effectId: 'child', kind: 'child', state: 'active' }), f.event('control', { action: 'cancel' }, user), f.event('note', { text: 'stop returned' })];
  assert.equal(fold(f, cancel).lifecycle, 'cancelling');
  assert.throws(() => fold(f, [...cancel, f.event('effect', { effectId: 'new-child', kind: 'child', state: 'active' })]), /fenced/);
  assert.equal(fold(f, [...cancel, f.event('effect', { effectId: 'child', kind: 'child', state: 'drained' }), f.terminal('cancelled')]).lifecycle, 'cancelled');
});
test('B07 B10 CORE origin-required without initial consent blocks apply without a proposal or human prompt', () => {
  const f = fixture({ completionTarget: 'origin', criteria: [criterion('origin', 'deterministic', 'origin')] });
  const applied = (originDigest, state = 'verified') => f.event('apply', {
    intentHash: h(`intent-${originDigest}-${state}`),
    applyJournalHead: { seq: 1, hash: h(`journal-${originDigest}-${state}`) },
    originIdentity: 'fixture-root',
    originDigest,
    at: 85,
    state,
  });
  const start = f.event('start'); const old = f.receipt(undefined, { observedAt: 80 });
  assert.throws(() => fold(f, [start, old, f.terminal()]));
  const unavailable = fold(f, [start, old]);
  assert.equal(unavailable.lifecycle, 'blocked');
  assert.equal(unavailable.phase, 'apply');
  assert.deepEqual(unavailable.reasons, ['origin-application-unverified', 'initial-origin-consent-unavailable']);
  assert.deepEqual(unavailable.proposals, []);
  const apply = applied(h('subject'));
  assert.equal(fold(f, [start, old, apply]).criteria[0].state, 'stale');
  assert.equal(fold(f, [start, apply, f.receipt(), f.terminal()]).lifecycle, 'achieved');
  assert.throws(() => fold(f, [start, applied(h('different-origin')), f.receipt(), f.terminal()]));
  for (const state of ['partial', 'unknown']) assert.throws(() => fold(f, [start, applied(h('subject'), state), f.terminal('failed')]), /pending/);
});
test('R01 R05 CORE nested consumed attempts are cumulative; unknown usage never becomes zero', () => {
  const f = fixture({ limits: { requests: 4, costMicros: 100 } }); const start = f.event('start');
  const a = consumed => f.event('attempt', { operationId: 'same-operation', consumed, usage: { requests: null, costMicros: null } });
  const d = fold(f, [start, a(3), a(1)]);
  assert.equal(d.counters.attempts['same-operation'], 4); assert.equal(d.lifecycle, 'blocked');
  assert.equal(d.counters.requests, null); assert.equal(d.counters.costMicros, null);
  assert.equal(fold(f, [start, a(null), a(1)]).counters.attempts['same-operation'], null);
  assert.deepEqual([GOAL_RUNTIME_POLICY.transientAttempts, GOAL_RUNTIME_POLICY.noProgressReplans, GOAL_RUNTIME_POLICY.familyResumes], [3, 2, 3]);
});
test('R02 R03 R04 CORE typed evidence can progress same gap; text/hash/new strategy never reset lifetime no-progress', () => {
  const f = fixture(); let strategy = 0; const progress = (delta, evidenceRefs = [], confidence = 'deterministic') => f.event('progress', { criterionId: 'objective', strategyDigest: h(`strategy-${++strategy}`), delta, beforeDigest: h('old'), afterDigest: h('new'), evidenceRefs, confidence });
  const es = [f.event('start'), progress('none'), progress('hypothesis_refuted', [h('new-evidence')])];
  const d = fold(f, es); assert.equal(d.counters.progress, 1); assert.equal(d.counters.noProgress, 1); assert.equal(d.lifecycle, 'running');
  const end = fold(f, [...es, progress('candidate_improved'), progress('unknown'), f.event('note', { text: 'new strategy and new hash' })]);
  assert.equal(end.counters.noProgress, 2); assert.equal(end.counters.unknownProgress, 1); assert.equal(end.lifecycle, 'blocked');
});
test('R04 CORE blocker family resume budget survives new IDs/text/instances and stale/manual wake is rejected', () => {
  const f = fixture(); const es = [f.event('start')];
  for (let n = 0; n < 3; n++) {
    const b = blocker(`new-id-${n}`, { diagnosis: `changed words ${n}` });
    const created = f.event('blocker', { blocker: b });
    es.push(created, f.event('resume', { blockerId: b.id, blockerEventId: created.data.id, instanceDigest: b.instanceDigest, predicateId: b.predicateId, condition: true, ownerPresent: true }));
  }
  const b = blocker('new-id-4'); const last = f.event('blocker', { blocker: b }); es.push(last);
  assert.equal(fold(f, es).counters.resumes[goalBlockerFamily(f.contract.goalId, b)], 3);
  assert.throws(() => fold(f, [...es, f.event('resume', { blockerId: b.id, blockerEventId: last.data.id, instanceDigest: b.instanceDigest, predicateId: b.predicateId, condition: true, ownerPresent: true })]), /resume admission/);
  const g = fixture(); const gb = blocker(); const ge = g.event('blocker', { blocker: gb });
  const wake = changes => g.event('resume', { blockerId: gb.id, blockerEventId: ge.data.id, instanceDigest: gb.instanceDigest, predicateId: gb.predicateId, condition: true, ownerPresent: true, ...changes });
  const base = [g.event('start'), ge];
  for (const changes of [{ instanceDigest: h('stale') }, { ownerPresent: false }, { condition: false }, { predicateId: 'unapproved' }]) assert.throws(() => fold(g, [...base, wake(changes)]));
  assert.throws(() => fold(g, [...base, g.event('control', { action: 'pause' }, user), wake({})]));
});
test('R04 CORE accepted wake proposes reconciliation, never direct dispatch/finalize; inventory is event-time bound', () => {
  const f = fixture(); const b = blocker(); const creation = f.event('blocker', { blocker: b });
  const base = [f.event('start'), f.receipt(), creation, f.event('resume', { blockerId: b.id, blockerEventId: creation.data.id, instanceDigest: b.instanceDigest, predicateId: b.predicateId, condition: true, ownerPresent: true })];
  assert.equal(fold(f, base).phase, 'reconcile'); assert.deepEqual(fold(f, base).proposals, [{ type: 'reconcile', criterionId: null }]);
  assert.throws(() => fold(f, [...base, f.terminal()]), /achievement not established/);
  const reconciled = [...base, f.event('reconcile')];
  assert.equal(fold(f, [...reconciled, f.terminal()]).lifecycle, 'achieved');
  // Later inventory adds a blocker but cannot retrospectively invalidate the accepted wake event.
  assert.equal(fold(f, base, { effects: [{ id: 'later-probe', kind: 'probe', state: 'active' }] }).pendingEffects[0], 'later-probe');
});
test('R03 R04 CORE repeated unknown progress is bounded, never a free replan reset', () => {
  const f = fixture(); const es = [f.event('start')];
  for (let n = 0; n < 2; n++) es.push(f.event('progress', { criterionId: 'objective', strategyDigest: h(`unknown-${n}`), delta: 'unknown', beforeDigest: h('old'), afterDigest: h(`changed-${n}`), evidenceRefs: [], confidence: 'unknown' }));
  const d = fold(f, es); assert.equal(d.lifecycle, 'blocked'); assert.equal(d.counters.unknownProgress, 2); assert.equal(d.counters.noProgress, 0);
});
test('B10 CORE pause/cancel/revoke cannot be bypassed by wrong control actor or unknown drain', () => {
  const f = fixture(); const start = f.event('start');
  assert.throws(() => fold(f, [start, f.event('control', { action: 'pause' }, { kind: 'user', id: 'another-user' })]), /actor mismatch/);
  const paused = [start, f.event('control', { action: 'pause' }, user)];
  assert.equal(fold(f, paused).lifecycle, 'paused');
  const resume = f.event('control', { action: 'resume' }, user);
  assert.equal(fold(f, [...paused, resume]).phase, 'reconcile');
  for (const action of ['cancel', 'revoke']) assert.throws(() => fold(f, [start, f.event('control', { action }, user), resume]), /resume fenced/);
  assert.throws(() => fold(f, [start, f.event('effect', { effectId: 'invented', kind: 'child', state: 'drained' })]), /without intent/);
});
test('R05 CORE completed/drained effects without transport accounting retain unknown usage, never zero', () => {
  const f = fixture();
  const es = [f.event('start'), f.event('effect', { effectId: 'child', kind: 'child', state: 'active' }), f.event('effect', { effectId: 'child', kind: 'child', state: 'drained' }), f.receipt(), f.terminal()];
  const d = fold(f, es); assert.equal(d.lifecycle, 'achieved'); assert.equal(d.counters.requests, null); assert.equal(d.counters.costMicros, null);
});
test('measured effect usage resolves only its drained request and includes failed attempts in lifetime budgets', () => {
  const f = fixture({ limits: { requests: 4, costMicros: 100 } });
  const events = [f.event('start')];
  const add = (effectId, usage) => {
    const requested = f.event('effect', { effectId, kind: 'verifier', state: 'active' });
    events.push(requested, f.event('effect', { effectId, kind: 'verifier', state: 'drained' }));
    assert.equal(fold(f, events).counters.requests, null, 'drain cannot fabricate measurement');
    events.push(f.event('effect-usage', { effectId, requestEventHash: goalHash(requested), usage, evidenceRefs: [h(`transport:${effectId}`)] }));
  };
  add('failed-verifier', { requests: 2, costMicros: 40 });
  assert.equal(fold(f, events).counters.requests, 2);
  assert.equal(fold(f, events).counters.costMicros, 40);
  add('corrective-child', { requests: 1, costMicros: 30 });
  assert.equal(fold(f, events).counters.requests, 3);
  assert.equal(fold(f, events).counters.costMicros, 70);
  assert.equal(fold(f, events).lifecycle, 'running');
  add('final-verifier', { requests: 1, costMicros: 30 });
  assert.equal(fold(f, events).counters.requests, 4);
  assert.equal(fold(f, events).counters.costMicros, 100);
  assert.equal(fold(f, events).lifecycle, 'blocked');
  const hash = goalHash(fold(f, events));
  assert.equal(goalHash(fold(f, structuredClone(events).map((e) => f.ingress.event(e.data, e.actor, e.observations)))), hash);
});
test('effect usage rejects foreign, active, duplicate, untrusted and reused evidence without erasing other unknown usage', () => {
  const f = fixture();
  const a = f.event('effect', { effectId: 'a', kind: 'child', state: 'active' });
  const b = f.event('effect', { effectId: 'b', kind: 'verifier', state: 'active' });
  const da = f.event('effect', { effectId: 'a', kind: 'child', state: 'drained' });
  const db = f.event('effect', { effectId: 'b', kind: 'verifier', state: 'drained' });
  const data = { effectId: 'a', requestEventHash: goalHash(a), usage: { requests: 0, costMicros: 0 }, evidenceRefs: [h('measured-local-no-provider')] };
  const usage = (changes = {}) => f.event('effect-usage', { ...data, ...changes });
  for (const events of [
    [f.event('start'), usage()],
    [f.event('start'), a, usage()],
    [f.event('start'), a, da, usage({ requestEventHash: goalHash(b) })],
    [f.event('start'), a, da, usage(), usage()],
    [f.event('start'), a, da, usage({ evidenceRefs: [h('same'), h('same')] })],
    [f.event('start'), a, da, usage(), b, db, usage({ effectId: 'b', requestEventHash: goalHash(b) })],
  ]) assert.throws(() => fold(f, events), /exact drained request/);
  assert.throws(() => f.event('effect-usage', data, user), /host ingress/);
  assert.throws(() => usage({ usage: { requests: null, costMicros: 0 } }));
  assert.throws(() => usage({ usage: { requests: -1, costMicros: 0 } }));
  assert.throws(() => usage({ evidenceRefs: [] }));
  const accounted = [f.event('start'), a, b, da, usage()];
  assert.equal(fold(f, accounted).counters.requests, null, 'another effect remains unaccounted');
  const attempt = f.event('attempt', { operationId: 'unmeasured-attempt', consumed: 1, usage: { requests: null, costMicros: null } });
  assert.equal(fold(f, [f.event('start'), a, da, usage(), attempt]).counters.requests, null);
  const cancelled = [f.event('start'), a, f.event('control', { action: 'cancel' }, user), da, usage()];
  assert.equal(fold(f, cancelled).lifecycle, 'cancelling', 'measurement never clears stop');
});
test('A06 B10 CORE explicit preauthorized origin apply is only a proposal, no repeat approval and no achievement', () => {
  const f = fixture({ completionTarget: 'origin', criteria: [criterion('origin', 'deterministic', 'origin')] });
  const data = structuredClone(f.contract); data.authority.applyMode = 'preauthorized'; data.authorityHash = goalHash(data.authority);
  const contract = f.ingress.contract(data, user);
  const start = f.ingress.event({ ...f.event('start').data, contractHash: goalHash(contract) }, { kind: 'host', id: 'fixture-host' }, f.obsData);
  const d = reduceGoal(contract, [start], f.obs());
  assert.equal(d.lifecycle, 'running'); assert.deepEqual(d.proposals, [{ type: 'apply', criterionId: null }]);
});
