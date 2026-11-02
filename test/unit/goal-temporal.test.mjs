import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, blocker, h, hostActor, user, goalHash } from './helpers/goal-fixture.mjs';
import { reduceGoal } from '../../.tmp/unit/goal-decision.js';
import { GoalStore } from '../../.tmp/unit/goal-store.js';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const fold = (f, events, at = 100) => reduceGoal(f.contract, events, f.obs({ at }));

test('temporal resolution cannot retire a later failure and resurrect an earlier expired PASS', () => {
  const f = fixture(); const old = f.receipt(undefined, { observedAt: 80, validUntil: 150 }); const fail = f.receipt(undefined, { result: 'fail', observedAt: 90 });
  const freshData = f.receipt(undefined, { observedAt: 190, evidenceRefs: [h('fresh-later')] }).data;
  const fresh = f.ingress.event(freshData, { kind: 'verifier', id: 'fixture-verifier' }, { ...f.obsData, at: 200 });
  const resolution = f.event('evidence-resolved', { criterionId: 'objective', bindingHash: goalHash(f.contract.criteria[0].binding), receiptIds: [fail.data.receipt.id], replacementReceiptId: fresh.data.receipt.id, evidenceRefs: [h('resolution')], rationale: 'Resolve current counterevidence at 200' }, { kind: 'verifier', id: 'fixture-verifier' }, { ...f.obsData, at: 200 });
  const events = [f.event('start'), old, fail, fresh, resolution];
  assert.equal(fold(f, events, 200).criteria[0].state, 'met');
  assert.throws(() => fold(f, events, 100), /observation time/);
  assert.throws(() => fold(f, [...events, f.terminal()], 100), /observation time/);
  const terminal = f.event('terminal', { lifecycle: 'achieved', at: 200 }, hostActor, { ...f.obsData, at: 200 });
  assert.equal(fold(f, [...events, terminal], 5000).lifecycle, 'achieved');
});
test('future receipt is rejected at its own ingress time, not banked until the clock catches up', () => {
  const f = fixture(); const future = f.receipt(undefined, { observedAt: 101 });
  assert.throws(() => fold(f, [f.event('start'), future], 100), /future receipt/);
  assert.throws(() => fold(f, [f.event('start'), future], 101), /future receipt/);
});
test('delayed automatic wake cannot clear an identical reopened episode after manual retirement', () => {
  const f = fixture(); const b = blocker(); const creation = f.event('blocker', { blocker: b });
  const wake = f.event('resume', { blockerId: b.id, blockerEventId: creation.data.id, instanceDigest: b.instanceDigest, predicateId: b.predicateId, condition: true, ownerPresent: true });
  const resolved = f.event('blocker-resolved', { blockerId: b.id, blockerEventId: creation.data.id, instanceDigest: b.instanceDigest, authorityHash: f.contract.authorityHash, evidenceRefs: [h('manual')] }, user);
  const reopened = f.event('blocker', { blocker: b }); const base = [f.event('start'), creation, resolved, f.event('reconcile'), reopened];
  assert.throws(() => fold(f, [...base, wake]), /stale blocker/);
  const currentWake = f.event('resume', { ...wake.data, id: 'current-wake', blockerEventId: reopened.data.id });
  const resumed = fold(f, [...base, currentWake]); assert.equal(resumed.blockers.length, 0); assert.equal(resumed.phase, 'reconcile');
  assert.deepEqual(Object.values(resumed.counters.resumes), [1]);
  const duplicateWithFreshInventory = f.ingress.event(wake.data, hostActor, { ...f.obsData, at: 101 });
  assert.throws(() => fold(f, [...base, duplicateWithFreshInventory], 101), /stale blocker/);
});
test('store observes genesis/handoff clock floors and rejects retrograde writes before publishing', async () => {
  const f = fixture(); const parent = join(process.cwd(), '.tmp', 'goal-p1-followup'); await mkdir(parent, { recursive: true });
  const root = join(await mkdtemp(join(parent, 'temporal-')), 'goal'); const store = new GoalStore(root); const first = store.hostOwner('first', 0);
  let snap = await store.create(f.contract, first, f.obs({ at: 200 }));
  const journalNames = () => readdir(join(root, 'journal'));
  await assert.rejects(store.commitEvent(first, snap, f.event('start')), /observation time/);
  assert.equal((await journalNames()).length, 1); assert.equal((await store.load()).status, 'ok');
  assert.equal((await store.load(f.obs({ at: 100 }))).status, 'observation-rejected');
  snap = await store.commitEvent(first, snap, f.event('start', {}, hostActor, { ...f.obsData, at: 200 }));
  snap = await store.handoff(first, snap, 'second', f.obs({ at: 300 })); const second = store.hostOwner('second', 1);
  await assert.rejects(store.handoff(second, snap, 'third', f.obs({ at: 250 })), /observation time/);
  await assert.rejects(store.commitEvent(second, snap, f.event('note', { text: 'old inventory' }, hostActor, { ...f.obsData, at: 250 })), /observation time/);
  assert.equal((await journalNames()).length, 3); assert.equal((await store.load()).hash, snap.hash);
  // Corrupt only this freshly created test fixture, never historical evidence.
  const path = join(root, 'journal', '0000000002.json'); const row = JSON.parse(await readFile(path, 'utf8')); row.payload.observations.at = 150;
  const { hash: _hash, ...body } = row; row.hash = goalHash(body); await writeFile(path, JSON.stringify(row));
  const bad = await store.load(); assert.equal(bad.status, 'corrupt'); assert.match(bad.diagnostic, /observation time/);
});
