import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { goalHash } from '../../.tmp/unit/goal-contract.js';
import { parseGoalWorkspaceBaseline, parseGoalOriginObservation, initialGoalCandidate, updateGoalCandidate, goalWorkspaceDelta, goalWorkspaceRequirement, goalFileContentIdentity } from '../../.tmp/unit/goal-workspace.js';

// Only observations of imaginary bytes. No filesystem or Git fixture setup.
const h = value => goalHash({ fixture: value });
const bytes = text => ({ kind: 'file', links: 1, mode: '0644', hex: Buffer.from(text).toString('hex') });
function baseline() {
  return { schemaVersion: 1, workspaceId: 'shared-goal-workspace', mode: 'mutation', scope: ['a', 'b', 'new'], protectedPaths: ['control'], inputManifest: ['a', 'b', 'new'], origin: { schemaVersion: 1, originId: 'fixture-root', repository: 'git', headDigest: h('HEAD'), indexDigest: h('entire-user-index'), files: [
    { path: 'a', head: bytes('HEAD'), index: bytes('user staged'), worktree: bytes('user staged plus unstaged') },
    { path: 'b', head: bytes('untouched'), index: bytes('untouched'), worktree: bytes('untouched') },
    { path: 'new', head: null, index: null, worktree: bytes('user untracked') },
  ] } };
}

test('NONAUTHORITY content identity excludes locator but preserves complete byte and line census', () => {
  for (const [hex, lines] of [['', 0], ['61', 1], ['610a', 1], ['610a62', 2], ['0a', 1], ['0a0a', 2], ['ff000a', 1]]) {
    const buffer = Buffer.from(hex, 'hex');
    const inline = { kind: 'file', links: 1, mode: '0644', hex };
    const artifact = { kind: 'artifact', links: 1, mode: '0644',
      locator: `source/${'a'.repeat(64)}`, sha256: createHash('sha256').update(buffer).digest('hex'),
      bytes: buffer.length, lines };
    const expected = { sha256: artifact.sha256, bytes: buffer.length, lines, mode: '0644', links: 1 };
    assert.deepEqual(goalFileContentIdentity(inline), expected);
    assert.deepEqual(goalFileContentIdentity(artifact), expected);
    assert.deepEqual(goalFileContentIdentity({ ...artifact, locator: `source/${'b'.repeat(64)}` }), expected);
    for (const [field, value] of [['mode', '0755'], ['bytes', buffer.length + 1], ['lines', lines + 1], ['sha256', '0'.repeat(64)]])
      assert.notDeepEqual(goalFileContentIdentity({ ...artifact, [field]: value }), expected);
  }
  assert.notDeepEqual(goalFileContentIdentity(null), goalFileContentIdentity(bytes('')));
});


test('W04 read-only means no-worktree, unchanged candidate only', () => {
  const b = { ...baseline(), mode: 'read-only' };
  assert.equal(goalWorkspaceRequirement(b), 'no-worktree');
  const candidate = initialGoalCandidate(b);
  assert.deepEqual(goalWorkspaceDelta(b, candidate).paths, []);
  assert.throws(() => updateGoalCandidate(b, candidate, candidate.files.map(f => ({ ...f, value: null }))), /read-only/);
});

test('W05/W07 nonGit requires exact explicit manifest, reports staging requirement without fallback', () => {
  const b = baseline(); b.origin.repository = 'nonGit'; b.origin.headDigest = null; b.origin.indexDigest = null;
  b.origin.files = b.origin.files.map(f => ({ ...f, head: null, index: null }));
  assert.equal(goalWorkspaceRequirement(b), 'explicit-manifest-staging-required');
  assert.equal(initialGoalCandidate(b).files[0].value.hex, b.origin.files[0].worktree.hex);
  assert.throws(() => parseGoalWorkspaceBaseline({ ...b, inputManifest: ['a'] }), /manifest/);
  assert.throws(() => parseGoalWorkspaceBaseline({ ...b, inputManifest: undefined }));
  assert.throws(() => parseGoalWorkspaceBaseline({ ...b, origin: { ...b.origin, headDigest: h('not-Git') } }), /semantics/);
  assert.equal(goalWorkspaceRequirement(baseline()), 'managed-git-worktree-required');
});


for (const path of ['../outside', '/absolute', 'a/../b', 'a//b', 'a\\b', '.git/config', '.GiT/config', '.pi/goals', 'a/.git', 'a.', 'CON.txt', 'a:stream', 'é', 'a\u0000b']) {
  test(`W06 metadata-only rejects unsafe path ${JSON.stringify(path)} (not OS protection)`, () => {
    const b = baseline(); b.scope[0] = path; b.inputManifest[0] = path; b.origin.files[0].path = path;
    assert.throws(() => parseGoalWorkspaceBaseline(b));
  });
}
for (const value of [{ ...bytes('x'), kind: 'symlink' }, { ...bytes('x'), links: 2 }, { ...bytes('x'), kind: 'directory' }, { ...bytes('x'), kind: 'socket' }, { ...bytes('x'), mode: '04755' }, { ...bytes('x'), hex: 'FF' }, { ...bytes('x'), hex: 'f' }]) {
  test(`W06 rejects unsupported file metadata ${JSON.stringify(value)}`, () => {
    const b = baseline(); b.origin.files[0].worktree = value;
    assert.throws(() => parseGoalWorkspaceBaseline(b));
  });
}

test('W06 strict shape, bound, prototype/getter and ambiguous manifests fail closed', () => {
  assert.throws(() => parseGoalWorkspaceBaseline({ ...baseline(), safe: true }));
  const getter = baseline(); Object.defineProperty(getter, 'safe', { enumerable: true, get() { assert.fail('getter invoked'); } });
  assert.throws(() => parseGoalWorkspaceBaseline(getter), /accessor/);
  const b = baseline(); b.origin.files[0].worktree.hex = '00'.repeat(8193);
  assert.throws(() => parseGoalWorkspaceBaseline(b));
  for (const files of [[baseline().origin.files[0], baseline().origin.files[0]], [baseline().origin.files[0], { ...baseline().origin.files[1], path: 'A' }], [baseline().origin.files[0], { ...baseline().origin.files[1], path: 'a/child' }]]) {
    assert.throws(() => parseGoalOriginObservation({ ...baseline().origin, files }));
  }
  assert.throws(() => parseGoalWorkspaceBaseline({ ...baseline(), protectedPaths: ['a'] }), /protected/);
});

test('W10 candidate cannot switch scope/workspace/baseline or reset index', () => {
  const b = baseline(); const c = initialGoalCandidate(b);
  for (const changed of [{ ...c, workspaceId: 'other' }, { ...c, baselineHash: h('other') }, { ...c, files: c.files.slice(1) }, { ...c, index: [] }]) {
    assert.throws(() => goalWorkspaceDelta(b, changed));
  }
  assert.deepEqual(b, baseline());
});
