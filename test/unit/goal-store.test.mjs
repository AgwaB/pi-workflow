import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, unlink, chmod, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { fixture, GoalStore, goalHash, h, user } from './helpers/goal-fixture.mjs';
import { GoalHostEffects } from '../../.tmp/unit/goal-host-effects.js';

// Keep disposable corrupt/crash evidence in this worktree; never historical runs.
const fixtureRoot = join(process.cwd(), '.tmp', 'goal-p1-fixtures');
await mkdir(fixtureRoot, { recursive: true });
async function setup() {
  const parent = await mkdtemp(join(fixtureRoot, 'fixture-'));
  const root = join(parent, 'goal'); const f = fixture(); const store = new GoalStore(root);
  const owner = store.hostOwner('owner-a', 0); const snapshot = await store.create(f.contract, owner, f.obs());
  return { root, parent, f, store, owner, snapshot };
}
async function journal(root) {
  const dir = join(root, 'journal'); const names = (await readdir(dir)).filter(n => !n.startsWith('.')).sort();
  return Promise.all(names.map(async n => [n, await readFile(join(dir, n), 'utf8')]));
}
function launch(root, expected, mode = 'none') {
  const child = fork(fileURLToPath(new URL('./helpers/goal-fixture.mjs', import.meta.url)), ['store-writer', root, JSON.stringify({ seq: expected.seq, hash: expected.hash }), mode], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const messages = []; const waiters = [];
  let stderr = ''; child.stderr.on('data', b => { stderr += b; });
  child.on('message', m => { messages.push(m); for (const w of [...waiters]) if (w.type === m.type) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); } });
  const exit = once(child, 'exit');
  const wait = type => {
    const found = messages.find(m => m.type === type); if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => { const w = { type, resolve }; waiters.push(w); exit.then(([code, signal]) => { if (waiters.includes(w)) reject(new Error(`fixture exited before ${type}: ${code}/${signal} ${stderr}`)); }); });
  };
  return { child, wait, exit, messages };
}
test('S01 S02 CORE read-only load/replay and projection corruption rebuild preserve journal/contract', async () => {
  const { root, f, store, owner, snapshot } = await setup();
  const s = await store.commitEvent(owner, snapshot, f.event('start'));
  const bytes = await journal(root); const contract = await readFile(join(root, 'contract.json'));
  const before = (await stat(join(root, 'projection.json'))).mtimeMs;
  for (let n = 0; n < 3; n++) assert.equal(goalHash((await store.load()).decision), goalHash(s.decision));
  assert.equal((await stat(join(root, 'projection.json'))).mtimeMs, before);
  await unlink(join(root, 'projection.json')); await store.rebuildProjection();
  await writeFile(join(root, 'projection.json'), 'CORRUPT PROJECTION'); await store.rebuildProjection();
  assert.ok((await readdir(root)).some(n => n.startsWith('.projection-evidence-')));
  const evidence = await Promise.all((await readdir(root)).filter(n => n.startsWith('.projection-evidence-')).map(n => readFile(join(root, n), 'utf8')));
  assert.ok(evidence.includes('CORRUPT PROJECTION'));
  assert.deepEqual(await journal(root), bytes); assert.deepEqual(await readFile(join(root, 'contract.json')), contract);
});
test('S01 CORE missing status/load creates no namespace and inaccessible is not absent', async () => {
  const parent = await mkdtemp(join(fixtureRoot, 'missing-')); const root = join(parent, 'absent'); const store = new GoalStore(root);
  assert.equal((await store.load()).status, 'missing'); assert.deepEqual(await readdir(parent), []);
  await mkdir(root); await chmod(root, 0);
  try { assert.equal((await store.load()).status, process.getuid?.() === 0 ? 'corrupt' : 'inaccessible'); }
  finally { await chmod(root, 0o700); }
  assert.equal((await store.load()).status, 'corrupt'); // Existing incomplete namespace is not missing.
});
for (const mutation of ['missing-middle', 'hash-mismatch', 'contract-corrupt', 'torn-event', 'unknown-event', 'wrong-owner']) {
  test(`S03 CORE ${mutation} fails closed and preserves bytes`, async () => {
    const { root, f, store, owner, snapshot } = await setup();
    let s = await store.commitEvent(owner, snapshot, f.event('start'));
    s = await store.commitEvent(owner, s, f.event('note', { text: 'next' }));
    const p = join(root, 'journal', '0000000001.json');
    if (mutation === 'missing-middle') await unlink(p);
    if (mutation === 'hash-mismatch') { const r = JSON.parse(await readFile(p, 'utf8')); r.payload.data.id = 'tampered'; await writeFile(p, JSON.stringify(r)); }
    if (mutation === 'contract-corrupt') await writeFile(join(root, 'contract.json'), '{"schemaVersion":99}');
    if (mutation === 'torn-event') await writeFile(p, '{"schemaVersion":1');
    if (mutation === 'unknown-event' || mutation === 'wrong-owner') {
      const r = JSON.parse(await readFile(p, 'utf8'));
      if (mutation === 'unknown-event') r.payload.data.type = 'unknown'; else r.epoch = 90;
      const { hash, ...body } = r; r.hash = goalHash(body); await writeFile(p, JSON.stringify(r));
    }
    const bytes = await journal(root); const contract = await readFile(join(root, 'contract.json'));
    assert.equal((await store.load()).status, 'corrupt');
    await assert.rejects(store.commitEvent(owner, s, f.event('note', { text: 'must not append' })), /corrupt/);
    assert.deepEqual(await journal(root), bytes); assert.deepEqual(await readFile(join(root, 'contract.json')), contract);
  });
}
test('S05 S07 CORE expected hash/sequence and owner epoch checked inside exclusive section; rejection cannot overwrite', async () => {
  const { root, f, store, owner, snapshot } = await setup();
  assert.equal((await store.assertCurrentOwner(owner, f.obs())).hash, snapshot.hash);
  await assert.rejects(store.assertCurrentOwner({ ...owner }, f.obs()), /capability/);
  const releaseActivity = store.bindOwnerActivity(owner);
  await assert.rejects(store.handoff(owner, snapshot, 'owner-b', f.obs()), /drained effects/);
  const secondStore = new GoalStore(root);
  await assert.rejects(secondStore.handoff(owner, snapshot, 'owner-b', f.obs()), /drained effects/);
  releaseActivity();
  releaseActivity();
  const next = await store.handoff(owner, snapshot, 'owner-b', f.obs()); const bytes = await journal(root);
  await assert.rejects(store.assertCurrentOwner(owner, f.obs()), /stale owner epoch/);
  await assert.rejects(store.commitEvent(owner, next, f.event('start')), /stale owner epoch/);
  assert.deepEqual(await journal(root), bytes);
  const successor = store.hostOwner('owner-b', 1);
  await assert.rejects(store.commitEvent(successor, { seq: next.seq, hash: h('wrong') }, f.event('start')), /sequence\/hash/);
  await assert.rejects(store.commitEvent({ ...successor }, next, f.event('start')), /capability/);
  const committed = await store.commitEvent(successor, next, f.event('start'));
  assert.equal(committed.epoch, 1); assert.equal(committed.ownerId, 'owner-b'); assert.equal(committed.seq, next.seq + 1);
  await assert.rejects(store.commitEvent(successor, next, f.event('note', { text: 'stale sequence' })), /sequence\/hash/);
  assert.equal((await store.load()).seq, committed.seq);
});
test('S06 CORE stale heartbeat/PID/dead claim cannot authorize takeover, unknown inventory blocks voluntary handoff', async () => {
  const { root, f, store, owner, snapshot } = await setup();
  for (const state of ['live', 'unknown', 'dead']) for (const expired of [true, false]) assert.throws(() => store.requestTakeover(state, expired), /unavailable/);
  await assert.rejects(store.handoff(owner, snapshot, 'owner-b', f.obs({ effectsKnown: false })), /drained/);
  assert.equal((await store.load()).epoch, 0);
  await mkdir(join(root, '.commit-lock')); // Unknown crashed owner evidence is never swept.
  await assert.rejects(store.commitEvent(owner, snapshot, f.event('start')), /EEXIST/);
  assert.ok((await readdir(root)).includes('.commit-lock'));
});
test('successor verifier journals independently fence cold owner handoff until sealed', async () => {
  const { root, parent, f, store, owner, snapshot } = await setup();
  const handed = await store.handoff(owner, snapshot, 'owner-b', f.obs());
  const successor = store.hostOwner('owner-b', handed.epoch);
  const effects = await GoalHostEffects.create(join(parent, 'successor-verifier-effects', h('generation-one')), {
    goalId: f.contract.goalId, scopeId: 'verifier', ownerEpoch: successor.epoch, sessionDigest: h('successor-session'),
  });
  await effects.record({ type: 'producer-opened', producerId: 'local-verifier', kind: 'verifier' });
  const cold = new GoalStore(root);
  await assert.rejects(cold.handoff(successor, handed, 'owner-c', f.obs()), /drained effects/);
  assert.equal((await store.load()).ownerId, 'owner-b');
  await effects.record({ type: 'fenced', reason: 'complete' });
  const closed = await effects.record({ type: 'producer-closed', producerId: 'local-verifier',
    outcome: 'never-started', observationDigest: h('no-dispatch') });
  await effects.record({ type: 'sealed', previousHead: closed.head, censusDigest: goalHash(closed) });
  const next = await cold.handoff(successor, handed, 'owner-c', f.obs());
  assert.equal(next.epoch, successor.epoch + 1);
  assert.equal(next.ownerId, 'owner-c');
});
test('missing successor verifier journal content is not an absent optional ledger', async () => {
  const { root, parent, f, store, owner, snapshot } = await setup();
  await mkdir(join(parent, 'successor-verifier-effects'), { mode: 0o700 });
  await mkdir(join(parent, 'successor-verifier-effects', h('incomplete-generation')), { mode: 0o700 });
  const before = await journal(root);
  await assert.rejects(store.handoff(owner, snapshot, 'owner-b', f.obs()));
  assert.equal((await store.load()).ownerId, owner.ownerId);
  assert.deepEqual(await journal(root), before);
});
test('S03 S05 CORE preexisting sequence cannot be overwritten even by direct competing publication', async () => {
  const { root, f, store, owner, snapshot } = await setup();
  const path = join(root, 'journal', '0000000001.json');
  const raced = new GoalStore(root, { fault: async point => { if (point === 'file-synced') await writeFile(path, 'FOREIGN WRITER EVIDENCE', { flag: 'wx' }); } });
  await assert.rejects(raced.commitEvent(owner, snapshot, f.event('start')), /EEXIST/);
  assert.equal(await readFile(path, 'utf8'), 'FOREIGN WRITER EVIDENCE');
  assert.equal((await store.load()).status, 'corrupt'); assert.ok((await readdir(join(root, 'journal'))).some(n => n.startsWith('.txn-')));
});
test('S01 S03 CORE durable terminal is immutable across replay and revisions remain journal-bound', async () => {
  const { root, f, store, owner, snapshot } = await setup();
  let s = await store.commitEvent(owner, snapshot, f.event('start'));
  s = await store.commitEvent(owner, s, f.receipt());
  s = await store.commitEvent(owner, s, f.terminal());
  assert.equal((await store.load(f.obs({ at: 999999, bindings: [] }))).decision.lifecycle, 'achieved');
  const bytes = await journal(root);
  await assert.rejects(store.commitEvent(owner, s, f.event('note', { text: 'cannot reopen terminal' })), /terminal immutable/);
  assert.deepEqual(await journal(root), bytes);
});
test('G4 cold replay exposes effective revised background contract without rewriting genesis', async () => {
  const { root, f, store, owner, snapshot } = await setup();
  const genesis = await readFile(join(root, 'contract.json'));
  const next = structuredClone(f.contract);
  next.revision = 2;
  next.previousHash = goalHash(f.contract);
  next.executionMode = 'background';
  next.authority.revision = 2;
  next.authority.backgroundAllowed = true;
  next.authorityHash = goalHash(next.authority);
  const revised = await store.commitEvent(owner, snapshot, f.event('revision', { contract: next }, user));
  for (const loaded of [revised, await new GoalStore(root).load()]) {
    assert.equal(loaded.status, 'ok');
    assert.equal(loaded.contract.executionMode, 'foreground');
    assert.equal(loaded.currentContract.executionMode, 'background');
    assert.equal(loaded.currentContract.authority.backgroundAllowed, true);
    assert.equal(loaded.decision.contractHash, goalHash(next));
  }
  assert.deepEqual(await readFile(join(root, 'contract.json')), genesis);
  assert.equal((await store.load()).lifecycleCustodyIssuances.length, 0);
});
