import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { WORKFLOW_PROFILE_ROLES } from '../../.tmp/unit/types.js';
import { WORKFLOW_BUILTIN_PROFILE_IDS, profileRuntimeForRole, createInheritedCustomProfile } from '../../.tmp/unit/workflow-profile-settings.js';
import { workflowDefinitionFingerprint, applyExecutionProfileStageOverrides, collectWorkflowProfileStageSlots } from '../../.tmp/unit/execution-profile.js';
import { h, goalHash } from './helpers/goal-fixture.mjs';

// Dynamic import makes absence of the not-yet-implemented adapter an explicit red test.
const adapterUrl = pathToFileURL(resolve('.tmp/unit/goal-profile.js')).href;
const models = [...new Set(WORKFLOW_BUILTIN_PROFILE_IDS.flatMap(p => WORKFLOW_PROFILE_ROLES.map(r => profileRuntimeForRole(p, r).model)))].map(fullId => ({ fullId, provider: fullId.split('/')[0], id: fullId.split('/').slice(1).join('/'), reasoning: true, thinkingLevelMap: { xhigh: 'xhigh', max: 'max' } }));
const stage = (id, profileRole = 'research-execution') => ({ id, type: 'single', profileRole, prompt: 'Return fixture evidence', output: { analysis: { required: true }, refs: { required: true } } });
const spec = (name = 'child-a', stages = [stage('work')]) => ({ schemaVersion: 1, name, defaults: { agent: 'fixture', readOnly: true, tools: ['read'] }, artifactGraph: { stages } });
const start = (a, selection = {}) => a.captureGoalProfile({ profileId: 'codex', availableModels: models, currentRuntime: {}, environmentDigest: h('env'), ...selection });
const child = (a, profile, definition = spec(), extra = {}) => a.captureGoalChildProfile({ profile, spec: definition, bundleDigest: h('bundle'), availableModels: models, ...extra });

test('standalone child Goal profile binds its definition and every inherited supervisory role', async () => {
  const a = await import(adapterUrl), profile = start(a);
  const definition = {
    schemaVersion: 1, name: 'child-policy',
    goal: {
      objective: 'Return the admitted result',
      criteria: [{ id: 'completion', verifier: {
        kind: 'deterministic', producerId: 'json-exact-value-v1', target: 'artifact',
        subject: { resultSlot: 'result', artifact: 'control', path: '$.result' },
        config: { comparison: 'canonical-json-equality', expected: { ready: true } },
      } }],
      authority: { allowedPaths: [], protectedPaths: [], allowedEffects: ['read', 'verify', 'workflow-create'] },
      nesting: { maxDepth: 3 },
    },
  };
  const context = { profile, spec: definition, bundleDigest: h('bundle'), availableModels: models };
  const before = goalHash(context);
  const captured = a.captureGoalChildProfile(context);
  const slots = collectWorkflowProfileStageSlots(definition);
  assert.deepEqual(new Set(slots.map(slot => slot.profileRole)), new Set(WORKFLOW_PROFILE_ROLES));
  assert.equal(captured.executionProfile.definitionFingerprint, workflowDefinitionFingerprint(definition));
  assert.notEqual(captured.executionProfile.definitionFingerprint, profile.templateFingerprint);
  for (const slot of slots) {
    const inherited = profile.roles.find(role => role.role === slot.profileRole);
    const runtime = { model: inherited.model, thinking: inherited.thinking };
    assert.deepEqual(captured.executionProfile.stageOverrides[slot.id], runtime);
    assert.doesNotThrow(() => a.assertGoalResolvedRuntime(context, captured, slot.id, runtime));
    assert.throws(() => a.assertGoalResolvedRuntime(context, captured, slot.id, { ...runtime, model: 'foreign/model' }), /differs/);
  }
  const changed = structuredClone(context);
  changed.spec.goal.criteria[0].verifier.config.expected.ready = false;
  assert.throws(() => a.assertGoalChildProfile(changed, captured), /mismatch/);
  assert.throws(() => a.captureGoalChildProfile({ ...context, availableModels: [] }), /unavailable/);
  assert.throws(() => a.captureGoalChildProfile({ ...context, runtimeOverrides: { model: 'foreign/model' } }), /conflict/);
  assert.equal(goalHash(context), before);
});

function revisionFixture(profile) {
  const scope = {
    rootRunId: 'workflow_profile_fixture',
    executionRunId: 'workflow_profile_execution',
    goalPath: [{ policySpecId: 'goal.main', definitionFingerprint: h('definition') }],
    template: 'items', role: 'research-execution',
    item: {
      placeholderSpecId: 'items', itemIdentity: 'item-a', itemHash: h('item'),
      sourceGeneration: 1, dispatchDigest: h('dispatch'), materializedTaskId: 'task-2',
      materializedSpecId: 'items.item-a', itemSourceTaskId: 'task-1',
      itemSourceSpecId: 'source.main', itemSourceKind: 'control', itemRef: 'source.main:control:$.items',
    },
  };
  return {
    scope,
    revision: {
      schemaVersion: 1, captureRevision: 1, previousCaptureHash: null,
      rootProfileHash: goalHash(profile), initialBase: {},
      exceptions: [{ scope, runtime: { thinking: 'low' }, reason: 'Explicit fixture field choice' }],
      confirmation: { provenance: 'original-live-tui', previewHash: h('preview'), confirmedAt: '2026-09-11T00:00:00.000Z' },
    },
  };
}

test('profile proposal cannot supply confirmation or be used as an accepted revision', async () => {
  const a = await import(adapterUrl), profile = start(a), { scope, revision } = revisionFixture(profile);
  const proposal = structuredClone(revision); delete proposal.confirmation;
  const before = goalHash({ profile, proposal });
  const parsed = a.parseGoalProfileCaptureRevisionProposal(proposal, profile);
  assert.deepEqual(parsed, proposal);
  assert.notEqual(parsed, proposal);
  assert.equal(Object.isFrozen(parsed.exceptions[0].runtime), true);
  assert.throws(() => { parsed.exceptions[0].runtime.thinking = 'high'; }, TypeError);
  assert.equal(Object.hasOwn(parsed, 'confirmation'), false);
  assert.throws(() => a.parseGoalProfileCaptureRevisionProposal(revision, profile));
  assert.throws(() => a.parseGoalProfileCaptureRevisionProposal({ ...proposal, confirmedAt: revision.confirmation.confirmedAt }, profile));
  assert.throws(() => a.parseGoalProfileCaptureRevision(proposal, profile));
  assert.throws(() => a.assertGoalProfileCaptureRevisionAvailable(proposal, profile, models));
  assert.throws(() => a.resolveGoalProfileRuntime(proposal, profile, scope, models));
  assert.doesNotThrow(() => a.assertGoalProfileCaptureRevisionProposalAvailable(parsed, profile, models));
  const preview = a.resolveGoalProfileProposalRuntime(parsed, profile, scope, models);
  const accepted = a.resolveGoalProfileRuntime(revision, profile, scope, models);
  assert.deepEqual(preview, { model: accepted.model, thinking: accepted.thinking },
    'preview returns only effective fields, without invented confirmation or accepted identity');
  assert.equal(Object.isFrozen(preview), true);
  assert.throws(() => a.resolveGoalProfileProposalRuntime(revision, profile, scope, models),
    /unknown/, 'preview does not silently accept confirmation-shaped input');
  assert.throws(() => a.resolveGoalProfileProposalRuntime(parsed, profile, scope, []),
    /unavailable/, 'preview cannot hide missing original model support');
  assert.equal(goalHash({ profile, proposal }), before);
  assert.deepEqual(a.parseGoalProfileCaptureRevision({ ...parsed, confirmation: revision.confirmation }, profile), revision,
    'confirmation-shaped fixture data is representation only, never proof of live consent');
});

test('profile proposal rejects unbound scopes and executable fields before confirmation', async () => {
  const a = await import(adapterUrl), profile = start(a), { revision } = revisionFixture(profile);
  const proposal = structuredClone(revision); delete proposal.confirmation;
  for (const change of [
    p => { p.rootProfileHash = h('foreign'); },
    p => { p.captureRevision = 0; },
    p => { p.previousCaptureHash = h('unexpected'); },
    p => { p.captureRevision = 2; },
    p => { p.exceptions.push(structuredClone(p.exceptions[0])); },
    p => { p.exceptions[0].runtime = {}; },
  ]) {
    const invalid = structuredClone(proposal); change(invalid);
    assert.throws(() => a.parseGoalProfileCaptureRevisionProposal(invalid, profile));
    assert.throws(() => a.assertGoalProfileCaptureRevisionProposalAvailable(invalid, profile, models));
  }
  let traps = 0;
  const proxy = new Proxy({}, { ownKeys() { traps++; return []; }, get() { traps++; return undefined; } });
  const accessor = { ...proposal };
  Object.defineProperty(accessor, 'exceptions', { enumerable: true, get() { traps++; return []; } });
  for (const invalid of [proxy, accessor]) {
    assert.throws(() => a.parseGoalProfileCaptureRevisionProposal(invalid, profile), /non-data|accessor/);
    assert.throws(() => a.assertGoalProfileCaptureRevisionProposalAvailable(invalid, profile, models), /non-data|accessor/);
  }
  assert.equal(traps, 0);
});

test('profile proposal validates every effective exception and the complete original role inventory', async () => {
  const a = await import(adapterUrl), profile = start(a), { revision } = revisionFixture(profile);
  const proposal = structuredClone(revision); delete proposal.confirmation;
  const inventory = [...models, { fullId: 'fixture/nonreasoning', provider: 'fixture', id: 'nonreasoning', reasoning: false }];
  for (const runtime of [{ model: 'absent/model' }, { model: 'fixture/nonreasoning', thinking: 'high' }]) {
    const invalid = structuredClone(proposal), unmatched = structuredClone(invalid.exceptions[0]);
    unmatched.scope.rootRunId = 'workflow_unmatched'; unmatched.runtime = runtime;
    invalid.exceptions.push(unmatched);
    assert.throws(() => a.assertGoalProfileCaptureRevisionProposalAvailable(invalid, profile, inventory), /unavailable|unsupported/);
  }
  const root = structuredClone(profile); root.roles[0].model = 'absent/root';
  const invalid = structuredClone(proposal);
  invalid.rootProfileHash = goalHash(root);
  invalid.initialBase = { model: models[0].fullId, thinking: 'low' };
  assert.throws(() => a.assertGoalProfileCaptureRevisionProposalAvailable(invalid, root, inventory), /unavailable/);
  assert.doesNotThrow(() => a.assertGoalProfileCaptureRevisionProposalAvailable(proposal, profile, inventory));
});

test('profile successor proposal derives exact predecessor and merges only the selected scope', async () => {
  const a = await import(adapterUrl), profile = start(a), { scope, revision } = revisionFixture(profile);
  const sibling = structuredClone(revision.exceptions[0]);
  sibling.scope.executionRunId = 'workflow_profile_sibling';
  sibling.runtime = { model: profile.roles.find(r => r.role === sibling.scope.role).model };
  sibling.reason = 'Unrelated prior exception';
  revision.exceptions.push(sibling);
  const previousHash = goalHash(revision);
  const previousSnapshot = structuredClone(revision);
  const alternate = models.find(m => m.fullId !== profile.roles.find(r => r.role === scope.role).model);
  assert.ok(alternate);

  const proposal = a.buildGoalProfileCaptureRevisionProposal(
    revision, profile, scope, { model: alternate.fullId }, 'Replace only the selected model', models,
  );
  assert.equal(proposal.captureRevision, 2);
  assert.equal(proposal.previousCaptureHash, previousHash);
  assert.equal(proposal.rootProfileHash, revision.rootProfileHash);
  assert.deepEqual(proposal.initialBase, revision.initialBase);
  assert.deepEqual(proposal.exceptions.map(e => e.scope.executionRunId),
    ['workflow_profile_execution', 'workflow_profile_sibling']);
  assert.deepEqual(proposal.exceptions[0].runtime, { thinking: 'low', model: alternate.fullId },
    'a model-only patch preserves the prior exceptional thinking field');
  assert.equal(proposal.exceptions[0].reason, 'Replace only the selected model');
  assert.deepEqual(proposal.exceptions[1], previousSnapshot.exceptions[1]);
  assert.equal(Object.hasOwn(proposal, 'confirmation'), false);
  assert.equal(Object.isFrozen(proposal), true);
  assert.equal(Object.isFrozen(proposal.exceptions[0]), true);
  assert.equal(Object.isFrozen(proposal.exceptions[1].scope), true);
  assert.throws(() => { proposal.exceptions[1].reason = 'mutated'; }, TypeError);
  assert.deepEqual(revision, previousSnapshot);
  revision.exceptions[0].reason = 'caller mutation after build';
  revision.exceptions[1].scope.executionRunId = 'caller_mutation';
  assert.equal(proposal.exceptions[0].reason, 'Replace only the selected model');
  assert.equal(proposal.exceptions[1].scope.executionRunId, 'workflow_profile_sibling');
});

test('profile successor proposal preserves JSON-looking reasons as literal text', async () => {
  const a = await import(adapterUrl), profile = start(a), { scope, revision } = revisionFixture(profile);
  for (const reason of ['{"reason":"literal"}', '"quoted reason"', 'null', '[1,true]', '이유: {"model":"변경"}']) {
    const proposal = a.buildGoalProfileCaptureRevisionProposal(
      revision, profile, scope, { thinking: 'medium' }, reason, models,
    );
    assert.equal(proposal.exceptions[0].reason, reason);
    assert.deepEqual(Buffer.from(proposal.exceptions[0].reason), Buffer.from(reason));
  }
});

test('profile successor proposal appends an exact new scope without changing prior rows', async () => {
  const a = await import(adapterUrl), profile = start(a), { scope, revision } = revisionFixture(profile);
  const newScope = structuredClone(scope);
  newScope.executionRunId = 'workflow_profile_new_scope';
  const proposal = a.buildGoalProfileCaptureRevisionProposal(
    revision, profile, newScope, { thinking: 'medium' }, 'New execution only', models,
  );
  assert.equal(proposal.exceptions.length, 2);
  assert.deepEqual(proposal.exceptions[0], revision.exceptions[0]);
  assert.deepEqual(proposal.exceptions[1], {
    scope: newScope, runtime: { thinking: 'medium' }, reason: 'New execution only',
  });
  assert.equal(a.resolveGoalProfileRuntime(revision, profile, scope, models).thinking, 'low');
  const accepted = { ...structuredClone(proposal), confirmation: {
    provenance: 'original-live-tui', previewHash: h('new-preview'), confirmedAt: '2026-09-11T00:01:00.000Z',
  } };
  assert.equal(a.resolveGoalProfileRuntime(accepted, profile, scope, models).thinking, 'low');
  assert.equal(a.resolveGoalProfileRuntime(accepted, profile, newScope, models).thinking, 'medium');
});

test('profile successor proposal rejects unsafe, incompatible, or stale source data without traps', async () => {
  const a = await import(adapterUrl), profile = start(a), { scope, revision } = revisionFixture(profile);
  const inventory = [...models, { fullId: 'fixture/nonreasoning', provider: 'fixture', id: 'nonreasoning', reasoning: false }];
  assert.throws(() => a.buildGoalProfileCaptureRevisionProposal(
    revision, profile, scope, {}, 'Empty patch', inventory,
  ), /at least one/);
  assert.throws(() => a.buildGoalProfileCaptureRevisionProposal(
    revision, profile, scope, { thinking: 'low', captureRevision: 9 }, 'Caller revision field', inventory,
  ), /unknown/);
  assert.throws(() => a.buildGoalProfileCaptureRevisionProposal(
    revision, profile, scope, { thinking: 'low', confirmation: {} }, 'Caller confirmation field', inventory,
  ), /unknown/);
  assert.throws(() => a.buildGoalProfileCaptureRevisionProposal(
    revision, profile, scope, { model: 'fixture/nonreasoning', thinking: 'high' }, 'Unsupported pair', inventory,
  ), /unsupported/);
  assert.throws(() => a.buildGoalProfileCaptureRevisionProposal(
    revision, profile, scope, { thinking: 'medium' }, '   ', inventory,
  ), /nonempty/);
  const foreignRoot = structuredClone(profile);
  foreignRoot.environmentDigest = h('foreign-environment');
  assert.throws(() => a.buildGoalProfileCaptureRevisionProposal(
    revision, foreignRoot, scope, { thinking: 'medium' }, 'Foreign root', inventory,
  ), /another root/);
  const stale = structuredClone(revision);
  const unmatched = structuredClone(stale.exceptions[0]);
  unmatched.scope.executionRunId = 'workflow_profile_stale';
  unmatched.runtime = { model: 'absent/model' };
  stale.exceptions.push(unmatched);
  assert.throws(() => a.buildGoalProfileCaptureRevisionProposal(
    stale, profile, scope, { thinking: 'medium' }, 'Cannot hide stale row', inventory,
  ), /unavailable/);

  let traps = 0;
  const proxy = new Proxy({}, { ownKeys() { traps++; return []; }, get() { traps++; return undefined; } });
  const accessorPatch = {};
  Object.defineProperty(accessorPatch, 'model', { enumerable: true, get() { traps++; return models[0].fullId; } });
  assert.throws(() => a.buildGoalProfileCaptureRevisionProposal(
    proxy, profile, scope, { thinking: 'medium' }, 'Proxy previous', inventory,
  ), /non-data/);
  assert.throws(() => a.buildGoalProfileCaptureRevisionProposal(
    revision, profile, scope, accessorPatch, 'Accessor patch', inventory,
  ), /accessor/);
  assert.equal(traps, 0);

  const overflow = structuredClone(revision);
  overflow.captureRevision = Number.MAX_SAFE_INTEGER;
  overflow.previousCaptureHash = h('prior-revision');
  assert.throws(() => a.buildGoalProfileCaptureRevisionProposal(
    overflow, profile, scope, { thinking: 'medium' }, 'Overflow', inventory,
  ), /overflow/);
});

test('accepted profile revision history requires one immutable contiguous predecessor chain', async () => {
  const a = await import(adapterUrl), profile = start(a), { scope, revision: first } = revisionFixture(profile);
  const alternate = models.find(m => m.fullId !== profile.roles.find(r => r.role === scope.role).model);
  assert.ok(alternate);
  const proposal = a.buildGoalProfileCaptureRevisionProposal(
    first, profile, scope, { model: alternate.fullId }, 'Accepted successor data', models,
  );
  const second = { ...structuredClone(proposal), confirmation: {
    provenance: 'original-live-tui', previewHash: h('second-preview'), confirmedAt: '2026-09-11T00:02:00.000Z',
  } };
  const history = a.parseGoalProfileCaptureRevisionHistory([first, second], profile);
  assert.equal(Object.isFrozen(history), true);
  assert.equal(Object.isFrozen(history[0]), true);
  assert.equal(history[1].previousCaptureHash, goalHash(history[0]));
  assert.deepEqual(a.resolveGoalProfileRuntime(history[0], profile, scope, models),
    { model: profile.roles.find(r => r.role === scope.role).model, thinking: 'low',
      modelSource: 'root-role', thinkingSource: 'branch-exception', captureRevision: 1,
      captureHash: goalHash(history[0]), scopeHash: a.goalProfileScopeHash(scope) });
  assert.equal(a.resolveGoalProfileRuntime(history[1], profile, scope, models).model, alternate.fullId);
  assert.equal(a.resolveGoalProfileRuntime(history[1], profile, scope, models).thinking, 'low');

  const transplantedFirst = structuredClone(first);
  transplantedFirst.exceptions[0].reason = 'Different first revision';
  const invalidHistories = [
    [second, first],
    [second],
    [first, first],
    [transplantedFirst, second],
    [first, { ...structuredClone(second), captureRevision: 3 }],
    [first, { ...structuredClone(second), previousCaptureHash: h('wrong-predecessor') }],
    [first, { ...structuredClone(second), rootProfileHash: h('foreign-root') }],
    [first, { ...structuredClone(second), initialBase: { thinking: 'off' } }],
  ];
  for (const invalid of invalidHistories)
    assert.throws(() => a.parseGoalProfileCaptureRevisionHistory(invalid, profile));
  assert.throws(() => a.parseGoalProfileCaptureRevisionHistory([], profile), /cardinality/);
  let traps = 0;
  const proxy = new Proxy([], { ownKeys() { traps++; return []; }, get() { traps++; return undefined; } });
  const accessorHistory = [first, second];
  Object.defineProperty(accessorHistory, '0', { enumerable: true, get() { traps++; return first; } });
  assert.throws(() => a.parseGoalProfileCaptureRevisionHistory(proxy, profile), /non-data/);
  assert.throws(() => a.parseGoalProfileCaptureRevisionHistory(accessorHistory, profile), /accessor/);
  assert.equal(traps, 0);
});

test('profile revision data resolves independently scoped fields without changing original roles', async () => {
  const a = await import(adapterUrl), profile = start(a), { scope, revision } = revisionFixture(profile);
  const role = profile.roles.find(r => r.role === scope.role);
  const before = goalHash({ profile, scope, revision });
  const resolved = a.resolveGoalProfileRuntime(revision, profile, scope, models);
  assert.equal(resolved.model, role.model);
  assert.equal(resolved.thinking, 'low');
  assert.equal(resolved.modelSource, 'root-role');
  assert.equal(resolved.thinkingSource, 'branch-exception');
  assert.equal(resolved.scopeHash, a.goalProfileScopeHash(scope));
  assert.equal(resolved.captureHash, goalHash(revision));
  assert.equal(Object.isFrozen(resolved), true);
  assert.equal(Object.isFrozen(a.parseGoalProfileCaptureRevision(revision, profile).exceptions[0].runtime), true);
  const alternate = models.find(m => m.fullId !== role.model);
  assert.ok(alternate);
  const modelOnly = structuredClone(revision);
  modelOnly.exceptions[0].runtime = { model: alternate.fullId };
  const changed = a.resolveGoalProfileRuntime(modelOnly, profile, scope, models);
  assert.equal(changed.model, alternate.fullId);
  assert.equal(changed.thinking, role.thinking);
  assert.equal(changed.modelSource, 'branch-exception');
  assert.equal(changed.thinkingSource, 'root-role');
  modelOnly.exceptions[0].runtime.thinking = 'low';
  const both = a.resolveGoalProfileRuntime(modelOnly, profile, scope, models);
  assert.equal(both.model, alternate.fullId); assert.equal(both.thinking, 'low');
  assert.equal(both.modelSource, 'branch-exception'); assert.equal(both.thinkingSource, 'branch-exception');
  assert.throws(() => a.resolveGoalProfileRuntime(modelOnly, profile, scope, [...models, alternate]), /ambiguous/);
  const successor = structuredClone(revision);
  successor.captureRevision = 2; successor.previousCaptureHash = goalHash(revision);
  assert.equal(a.parseGoalProfileCaptureRevision(successor, profile).captureRevision, 2,
    'representation parsing alone does not prove publication of either revision');
  successor.initialBase = { model: 'absent/historical-base', thinking: 'off' };
  successor.exceptions = [];
  const unchanged = a.resolveGoalProfileRuntime(successor, profile, scope, models);
  assert.equal(unchanged.model, role.model); assert.equal(unchanged.thinking, role.thinking);
  assert.equal(goalHash({ profile, scope, revision }), before);
});

test('profile data resolution keeps otherwise-identical ordinary sibling executions separate', async () => {
  const a = await import(adapterUrl), profile = start(a), { scope, revision } = revisionFixture(profile);
  const ordinaryScope = structuredClone(scope);
  delete ordinaryScope.item;
  ordinaryScope.executionRunId = 'ordinary_child_reservation_a';
  const ordinaryRevision = structuredClone(revision);
  ordinaryRevision.exceptions[0].scope = ordinaryScope;
  const siblingScope = { ...ordinaryScope, executionRunId: 'ordinary_child_reservation_b' };
  assert.equal(a.resolveGoalProfileRuntime(ordinaryRevision, profile, ordinaryScope, models).thinkingSource, 'branch-exception');
  assert.equal(a.resolveGoalProfileRuntime(ordinaryRevision, profile, siblingScope, models).thinkingSource, 'root-role');
  assert.notEqual(a.goalProfileScopeHash(ordinaryScope), a.goalProfileScopeHash(siblingScope));
});

test('exact foreach item and template data resolution remains bounded to the execution run', async () => {
  const a = await import(adapterUrl), profile = start(a), { scope, revision } = revisionFixture(profile);
  const siblingItemScope = { ...structuredClone(scope), executionRunId: 'foreach_child_reservation_b' };
  assert.equal(a.resolveGoalProfileRuntime(revision, profile, scope, models).thinkingSource, 'branch-exception');
  assert.equal(a.resolveGoalProfileRuntime(revision, profile, siblingItemScope, models).thinkingSource, 'root-role');

  const templateScope = structuredClone(scope);
  delete templateScope.item;
  const templateRevision = structuredClone(revision);
  templateRevision.exceptions[0].scope = templateScope;
  const siblingTemplateScope = { ...templateScope, executionRunId: 'foreach_child_reservation_b' };
  assert.equal(a.resolveGoalProfileRuntime(templateRevision, profile, templateScope, models).thinkingSource, 'branch-exception');
  assert.equal(a.resolveGoalProfileRuntime(templateRevision, profile, siblingTemplateScope, models).thinkingSource, 'root-role');
});

test('profile scope parser requires a valid explicit execution run ID', async () => {
  const a = await import(adapterUrl), profile = start(a), { scope, revision } = revisionFixture(profile);
  const missing = structuredClone(scope);
  delete missing.executionRunId;
  const invalid = { ...structuredClone(scope), executionRunId: 'invalid/run' };
  for (const [candidate, message] of [[missing, 'Goal unknown/missing key'], [invalid, 'Goal invalid ID']]) {
    assert.throws(() => a.parseGoalProfileScope(candidate), { message });
    const invalidRevision = structuredClone(revision);
    invalidRevision.exceptions[0].scope = candidate;
    assert.throws(() => a.parseGoalProfileCaptureRevision(invalidRevision, profile), { message });
  }
});

test('profile revision scope binds complete item proof and never matches sibling or ancestor targets', async () => {
  const a = await import(adapterUrl), profile = start(a), { scope, revision } = revisionFixture(profile);
  for (const change of [
    s => { s.rootRunId = 'workflow_other'; },
    s => { s.executionRunId = 'workflow_other_execution'; },
    s => { s.goalPath[0].policySpecId = 'other.main'; },
    s => { s.goalPath[0].definitionFingerprint = h('other-definition'); },
    s => { s.role = 'verification'; },
    s => { delete s.item; },
    s => { s.item.itemIdentity = 'item-b'; },
    s => { s.item.itemHash = h('other-item'); },
    s => { s.item.sourceGeneration++; },
    s => { s.item.dispatchDigest = h('other-dispatch'); },
    s => { s.item.materializedTaskId = 'task-3'; },
    s => { s.item.materializedSpecId = 'items.other'; },
    s => { s.item.itemSourceTaskId = 'task-4'; },
    s => { s.item.itemSourceSpecId = 'other.main'; },
    s => { s.item.itemSourceKind = 'partial'; },
    s => { s.item.itemRef = 'source.main:control:$.other'; },
    s => { s.goalPath.push({ policySpecId: 'child.main', definitionFingerprint: h('child'), child: {
      generation: 0, slot: 'child', workflowId: 'child-workflow', specHash: h('spec'), requestHash: h('request'),
    } }); },
  ]) {
    const target = structuredClone(scope); change(target);
    const resolved = a.resolveGoalProfileRuntime(revision, profile, target, models);
    const role = profile.roles.find(r => r.role === target.role);
    assert.equal(resolved.model, role.model);
    assert.equal(resolved.thinking, role.thinking);
    assert.equal(resolved.modelSource, 'root-role');
    assert.equal(resolved.thinkingSource, 'root-role');
    assert.notEqual(resolved.scopeHash, a.goalProfileScopeHash(scope));
  }
  const templateScope = structuredClone(scope); delete templateScope.item;
  const templateRevision = structuredClone(revision); templateRevision.exceptions[0].scope = templateScope;
  assert.equal(a.resolveGoalProfileRuntime(templateRevision, profile, { ...templateScope, template: 'other' }, models).thinkingSource, 'root-role');
  const nestedScope = structuredClone(scope);
  nestedScope.goalPath.push({ policySpecId: 'child.main', definitionFingerprint: h('child'), child: {
    generation: 0, slot: 'child', workflowId: 'child-workflow', specHash: h('spec'), requestHash: h('request'),
  } });
  const nestedRevision = structuredClone(revision); nestedRevision.exceptions[0].scope = nestedScope;
  assert.equal(a.resolveGoalProfileRuntime(nestedRevision, profile, nestedScope, models).thinkingSource, 'branch-exception');
  for (const [field, value] of Object.entries({
    generation: 1, slot: 'other', workflowId: 'other-workflow', specHash: h('other-spec'), requestHash: h('other-request'),
  })) {
    const target = structuredClone(nestedScope); target.goalPath[1].child[field] = value;
    assert.equal(a.resolveGoalProfileRuntime(nestedRevision, profile, target, models).thinkingSource, 'root-role', field);
  }
  const otherDefinition = structuredClone(nestedScope); otherDefinition.goalPath[1].definitionFingerprint = h('other-child');
  assert.equal(a.resolveGoalProfileRuntime(nestedRevision, profile, otherDefinition, models).thinkingSource, 'root-role');
});

test('profile revision inventory rejects invalid unmatched exceptions before any scope resolves', async () => {
  const a = await import(adapterUrl), profile = start(a), { scope, revision } = revisionFixture(profile);
  const inventory = [...models, { fullId: 'fixture/nonreasoning', provider: 'fixture', id: 'nonreasoning', reasoning: false }];
  for (const runtime of [{ model: 'absent/model' }, { model: 'fixture/nonreasoning', thinking: 'high' }]) {
    const invalid = structuredClone(revision);
    const unmatched = structuredClone(invalid.exceptions[0]);
    unmatched.scope.item.itemIdentity = 'unmatched'; unmatched.runtime = runtime;
    invalid.exceptions.push(unmatched);
    assert.throws(() => a.assertGoalProfileCaptureRevisionAvailable(invalid, profile, inventory), /unavailable|unsupported/);
    for (const target of [scope, { ...scope, rootRunId: 'workflow_unmatched' }])
      assert.throws(() => a.resolveGoalProfileRuntime(invalid, profile, target, inventory), /unavailable|unsupported/);
  }
  assert.doesNotThrow(() => a.assertGoalProfileCaptureRevisionAvailable(revision, profile, inventory));
});

test('profile revision parser rejects unbound malformed and executable data without repairing roles', async () => {
  const a = await import(adapterUrl), profile = start(a), { scope, revision } = revisionFixture(profile);
  for (const change of [
    r => { r.rootProfileHash = h('foreign'); },
    r => { r.captureRevision = 0; },
    r => { r.previousCaptureHash = h('unexpected'); },
    r => { r.captureRevision = 2; },
    r => { r.exceptions.push(structuredClone(r.exceptions[0])); },
    r => { r.exceptions[0].runtime = {}; },
    r => { r.exceptions[0].runtime = { thinking: 'unsupported' }; },
    r => { r.exceptions[0].reason = ''; },
    r => { r.exceptions[0].scope.template = '*'; },
    r => { r.exceptions[0].scope.item = { itemIdentity: 'item-a' }; },
    r => { r.exceptions[0].scope.item.placeholderSpecId = 'other'; },
    r => { r.exceptions[0].scope.goalPath.push({ policySpecId: 'child', definitionFingerprint: h('child') }); },
    r => { r.confirmation.confirmedAt = 'not-a-timestamp'; },
    r => { r.confirmation.authority = true; },
  ]) {
    const invalid = structuredClone(revision); change(invalid);
    assert.throws(() => a.parseGoalProfileCaptureRevision(invalid, profile));
  }
  let traps = 0;
  assert.throws(() => a.parseGoalProfileCaptureRevision(new Proxy({}, {
    ownKeys() { traps++; return []; }, get() { traps++; return undefined; },
  }), profile), /non-data/);
  assert.equal(traps, 0);
  const accessor = structuredClone(revision);
  Object.defineProperty(accessor, 'exceptions', { enumerable: true, get() { traps++; return []; } });
  assert.throws(() => a.parseGoalProfileCaptureRevision(accessor, profile), /accessor/);
  assert.equal(traps, 0);
  const missing = structuredClone(profile); missing.roles.pop();
  const invalid = structuredClone(revision);
  invalid.rootProfileHash = goalHash(missing);
  invalid.initialBase = { model: models[0].fullId, thinking: 'low' };
  assert.throws(() => a.resolveGoalProfileRuntime(invalid, missing, scope, models), /cardinality/);
  const unavailable = structuredClone(revision);
  unavailable.exceptions[0].runtime = { model: 'absent/model' };
  assert.throws(() => a.resolveGoalProfileRuntime(unavailable, profile, scope, models), /unavailable/);
  const unsupported = structuredClone(revision);
  unsupported.exceptions[0].runtime = { model: 'fixture/nonreasoning', thinking: 'high' };
  assert.throws(() => a.resolveGoalProfileRuntime(unsupported, profile, scope, [
    ...models, { fullId: 'fixture/nonreasoning', provider: 'fixture', id: 'nonreasoning', reasoning: false },
  ]), /unsupported/);
});

test('P01 Goal uses the existing built-in resolver for every role without its own model defaults', async () => {
  const a = await import(adapterUrl);
  for (const profileId of WORKFLOW_BUILTIN_PROFILE_IDS) {
    const p = start(a, { profileId });
    for (const r of p.roles) {
      assert.deepEqual({ model: r.model, thinking: r.thinking }, profileRuntimeForRole(profileId, r.role));
      assert.deepEqual(r.origin, { model: 'fixed', thinking: 'fixed' });
    }
    assert.equal(p.templateFingerprint, workflowDefinitionFingerprint(a.goalProfileTemplate()));
    assert.equal(Object.isFrozen(p.roles[0]), true);
  }
});
test('P02 inherit freezes once and retains fixed/inherit provenance independently per field', async () => {
  const a = await import(adapterUrl); const template = a.goalProfileTemplate(); const custom = createInheritedCustomProfile(template);
  const runtime = { model: models[0].fullId, thinking: 'high' };
  custom.stages.planning.thinking = { kind: 'fixed', value: 'medium' };
  const p = start(a, { profileId: 'custom', custom, currentRuntime: runtime }); const before = goalHash(p);
  const planning = p.roles.find(r => r.role === 'planning'); assert.deepEqual(planning.origin, { model: 'inherit', thinking: 'fixed' });
  runtime.model = 'missing/model'; runtime.thinking = 'off'; custom.stages.planning.thinking.value = 'off';
  assert.equal(planning.thinking, 'medium'); assert.equal(goalHash(p), before); assert.equal(child(a, p).profileHash, before);
  assert.throws(() => start(a, { profileId: 'custom', custom, currentRuntime: {} }), /inherit/);
});
test('P03 P04 P09 children receive definition and bundle bound captures, never the parent capture', async () => {
  const a = await import(adapterUrl); const p = start(a); const sa = spec(); const sb = spec('child-b', [stage('different')]);
  const ca = child(a, p, sa); const cb = child(a, p, sb); assert.notEqual(ca.executionProfile.definitionFingerprint, cb.executionProfile.definitionFingerprint);
  assert.equal(ca.executionProfile.definitionFingerprint, workflowDefinitionFingerprint(sa)); assert.notEqual(ca.executionProfile.definitionFingerprint, p.templateFingerprint);
  assert.deepEqual(ca.executionProfile.stageOverrides.work, cb.executionProfile.stageOverrides.different);
  const context = { profile: p, spec: sa, bundleDigest: h('bundle'), availableModels: models };
  assert.doesNotThrow(() => a.assertGoalChildProfile(context, ca));
  for (const changes of [{ spec: sb }, { bundleDigest: h('changed-helper') }, { profile: { ...p, templateFingerprint: h('stale-template') } }]) assert.throws(() => a.assertGoalChildProfile({ ...context, ...changes }, ca));
  assert.throws(() => a.assertGoalChildProfile(context, { ...ca, executionProfile: { ...ca.executionProfile, definitionFingerprint: p.templateFingerprint } }), /capture/);
});
test('P05 P07 P10 invalid roles, absent models and unsupported thinking block with no fallback', async () => {
  const a = await import(adapterUrl); const p = start(a);
  const invalid = spec(); invalid.artifactGraph.stages[0].profileRole = 'untrusted-role';
  assert.throws(() => child(a, p, invalid), /role/i);
  assert.throws(() => start(a, { availableModels: [] }), /available/);
  assert.throws(() => child(a, p, spec(), { availableModels: [] }), /available/);
  assert.throws(() => start(a, { availableModels: models.map(m => ({ ...m, reasoning: false })) }), /thinking/);
  assert.throws(() => start(a, { availableModels: [...models, models[0]] }), /ambiguous/);
  assert.throws(() => start(a, { profileId: undefined }), /profile/);
});
test('unmarked ordinary tasks inherit the captured worker role without recapturing defaults', async () => {
  const a = await import(adapterUrl); const p = start(a);
  const s = spec('unmarked-workers', [
    { id: 'outer', type: 'dag', stages: [stage('work')] },
    { id: 'items', type: 'foreach', from: { source: 'outer', path: '$.items' }, inputPolicy: { artifactAccess: 'none' }, each: { prompt: 'Read item' }, output: { analysis: { required: true }, refs: { required: true } } },
    stage('plan', 'planning'),
  ]);
  delete s.artifactGraph.stages[0].stages[0].profileRole;
  const before = JSON.stringify(s);
  const capture = child(a, p, s);
  const worker = p.roles.find(role => role.role === 'research-execution');
  const planner = p.roles.find(role => role.role === 'planning');
  for (const id of ['outer.work', 'items']) {
    assert.deepEqual(capture.executionProfile.stageOverrides[id], { model: worker.model, thinking: worker.thinking });
    a.assertGoalResolvedRuntime({ profile: p, spec: s, bundleDigest: h('bundle'), availableModels: models }, capture, id, { model: worker.model, thinking: worker.thinking });
  }
  assert.deepEqual(capture.executionProfile.stageOverrides.plan, { model: planner.model, thinking: planner.thinking });
  assert.equal(JSON.stringify(s), before);
  assert.equal(capture.profileHash, goalHash(p));
  assert.throws(() => child(a, p, s, { runtimeOverrides: { model: 'untrusted/model' } }), /override conflict/);
});
test('P10 resume keeps the old concrete capture, blocks a lost model, and never saves changed preferences', async () => {
  const a = await import(adapterUrl); const custom = createInheritedCustomProfile(a.goalProfileTemplate());
  const runtime = { model: models[0].fullId, thinking: 'high' };
  const p = start(a, { profileId: 'custom', custom, currentRuntime: runtime }); const before = goalHash(p);
  const selected = p.roles.find(r => r.role === 'research-execution');
  runtime.model = 'missing/model'; runtime.thinking = 'off';
  custom.stages['research-execution'].model = { kind: 'fixed', value: 'missing/model' };
  custom.stages['research-execution'].thinking = { kind: 'fixed', value: 'off' };
  const changedPreferences = structuredClone(custom);
  const resumed = child(a, p);
  assert.equal(resumed.executionProfile.stageOverrides.work.model, selected.model);
  assert.equal(resumed.executionProfile.stageOverrides.work.thinking, selected.thinking);
  assert.equal(goalHash(p), before);
  assert.deepEqual(custom, changedPreferences);
  assert.throws(() => a.assertGoalProfileAvailable(p, []), /available/);
  assert.throws(() => child(a, p, spec(), { availableModels: [] }), /available/);
  assert.deepEqual(custom, changedPreferences);
  assert.equal(goalHash(p), before);
});

test('P08 runtime or selected declared profile cannot override Goal; non-model overlays remain', async () => {
  const a = await import(adapterUrl); const p = start(a); const s = spec(); const role = p.roles.find(r => r.role === 'research-execution');
  for (const runtimeOverrides of [{ model: 'other/model' }, { thinking: 'off' }]) assert.throws(() => child(a, p, s, { runtimeOverrides }), /override/);
  assert.doesNotThrow(() => child(a, p, s, { runtimeOverrides: { model: role.model, thinking: role.thinking } }));
  s.defaultExecutionProfile = 'selected'; s.executionProfiles = { selected: { work: { thinking: 'off' } } };
  const before = JSON.stringify(s);
  assert.deepEqual(child(a, p, s).executionProfile.stageOverrides.work, { model: role.model, thinking: role.thinking });
  assert.equal(JSON.stringify(s), before);
  s.executionProfiles.selected.work = { model: role.model, thinking: role.thinking };
  assert.doesNotThrow(() => child(a, p, s));
  assert.equal(child(a, p, s).executionProfile.stageOverrides.work.thinking, role.thinking);
  assert.throws(() => child(a, p, s, { runtimeOverrides: { model: 'other/model' } }), /override/);
});
test('child semantic roles override unavailable authored and saved models without source mutation', async () => {
  const a = await import(adapterUrl); const p = start(a);
  const s = spec('saved-child', [stage('plan', 'planning'), stage('work'), stage('check', 'verification')]);
  delete s.artifactGraph.stages[1].profileRole;
  s.defaults.model = 'unavailable/default';
  s.defaults.thinking = 'off';
  s.defaultExecutionProfile = 'saved';
  s.executionProfiles = { saved: {} };
  for (const slot of s.artifactGraph.stages) {
    slot.model = 'unavailable/authored';
    slot.thinking = 'low';
    s.executionProfiles.saved[slot.id] = { model: 'unavailable/saved', thinking: 'off' };
  }
  const before = JSON.stringify(s); const parentBefore = goalHash(p);
  const capture = child(a, p, s);
  const effective = applyExecutionProfileStageOverrides(s, capture.executionProfile.stageOverrides,
    { foreachRuntimeTarget: 'each' });
  for (const slot of effective.artifactGraph.stages) {
    const expected = p.roles.find(role => role.role === (slot.profileRole ?? 'research-execution'));
    assert.deepEqual(capture.executionProfile.stageOverrides[slot.id], { model: expected.model, thinking: expected.thinking });
    assert.equal(slot.model, expected.model);
    assert.equal(slot.thinking, expected.thinking);
  }
  assert.equal(capture.executionProfile.definitionFingerprint, workflowDefinitionFingerprint(s));
  assert.equal(JSON.stringify(s), before);
  assert.equal(goalHash(p), parentBefore);
  const changed = structuredClone(s); changed.executionProfiles.saved.work.thinking = 'high';
  assert.throws(() => a.assertGoalChildProfile({ profile: p, spec: changed, bundleDigest: h('bundle'), availableModels: models }, capture), /capture/);
});
test('P08 actual resolved runtime must match the exact named slot, not just a valid thinking enum', async () => {
  const a = await import(adapterUrl); const p = start(a); const s = spec(); const c = child(a, p, s);
  const context = { profile: p, spec: s, bundleDigest: h('bundle'), availableModels: models };
  const expected = c.executionProfile.stageOverrides.work;
  assert.doesNotThrow(() => a.assertGoalResolvedRuntime(context, c, 'work', expected));
  for (const runtime of [{ ...expected, thinking: 'off' }, { ...expected, model: 'alias' }, {}]) assert.throws(() => a.assertGoalResolvedRuntime(context, c, 'work', runtime), /resolved/);
  assert.throws(() => a.assertGoalResolvedRuntime(context, c, 'missing', expected), /slot/);
  assert.equal(goalHash(s), goalHash(spec()));
  const overlaid = applyExecutionProfileStageOverrides(s, c.executionProfile.stageOverrides, { foreachRuntimeTarget: 'each' });
  assert.equal(overlaid.artifactGraph.stages[0].model, expected.model);
});
test('P06 all recursive slots get their own capture; foreach preserves non-model batching', async () => {
  const a = await import(adapterUrl); const p = start(a);
  const s = spec('nested-child', [
    { id: 'outer', type: 'dag', stages: [stage('inner', 'planning')] },
    { id: 'repeat', type: 'loop', maxRounds: 2, until: { stage: 'check', path: '$.status', equals: 'pass' }, stages: [stage('fix'), stage('check', 'verification')], onExhausted: stage('fallback', 'final-judgment') },
    { id: 'items', type: 'foreach', profileRole: 'research-execution', from: { source: 'outer', path: '$.items' }, inputPolicy: { artifactAccess: 'none' }, each: { prompt: 'Read item' }, output: { analysis: { required: true }, refs: { required: true } } },
    { id: 'reduce', type: 'reduce', profileRole: 'synthesis', from: 'items', prompt: 'Synthesize', output: { analysis: { required: true }, refs: { required: true } } },
    { id: 'adaptive', type: 'dynamic', profileRole: 'planning', dynamic: { uses: './helpers/controller.mjs', decisionLoop: { planner: { profileRole: 'planning' }, workerDefaults: { profileRole: 'research-execution' }, verifier: { profileRole: 'verification' }, synthesis: { profileRole: 'synthesis' } } } },
  ]);
  s.defaultExecutionProfile = 'batch'; s.executionProfiles = { batch: { items: {
    model: 'unavailable/saved-foreach', thinking: 'off',
    foreachBatch: { maxItems: 2, groupBy: '$.group' },
  } } };
  const before = goalHash(s); const c = child(a, p, s); const slots = collectWorkflowProfileStageSlots(s);
  assert.deepEqual(slots.map(s => s.id), ['outer.inner', 'repeat.fix', 'repeat.check', 'repeat.$onExhausted', 'items', 'reduce', 'adaptive', 'adaptive.$planner', 'adaptive.$workerDefaults', 'adaptive.$verifier', 'adaptive.$synthesis']);
  for (const slot of slots) { const r = p.roles.find(r => r.role === slot.profileRole); assert.equal(c.executionProfile.stageOverrides[slot.id].model, r.model); assert.equal(c.executionProfile.stageOverrides[slot.id].thinking, r.thinking); }
  assert.deepEqual(c.executionProfile.stageOverrides.items.foreachBatch, s.executionProfiles.batch.items.foreachBatch);
  assert.equal(goalHash(s), before);
  const effective = applyExecutionProfileStageOverrides(s, c.executionProfile.stageOverrides, { foreachRuntimeTarget: 'each' });
  assert.equal(effective.artifactGraph.stages[2].each.model, c.executionProfile.stageOverrides.items.model);
  assert.equal(effective.artifactGraph.stages[1].onExhausted.model, c.executionProfile.stageOverrides['repeat.$onExhausted'].model);
  const missing = structuredClone(s);
  for (const value of Object.values(missing.artifactGraph.stages[4].dynamic.decisionLoop)) delete value.profileRole;
  const beforeMissing = JSON.stringify(missing);
  const inherited = child(a, p, missing);
  for (const [slot, role] of Object.entries({ planner: 'planning', workerDefaults: 'research-execution', verifier: 'verification', synthesis: 'synthesis' })) {
    const runtime = p.roles.find(value => value.role === role);
    assert.deepEqual(inherited.executionProfile.stageOverrides[`adaptive.$${slot}`], { model: runtime.model, thinking: runtime.thinking });
  }
  assert.equal(JSON.stringify(missing), beforeMissing);
  assert.equal(inherited.executionProfile.definitionFingerprint, workflowDefinitionFingerprint(missing));
});
test('Goal profile never reads or changes child saved preferences and covers real bundled specs', async () => {
  const a = await import(adapterUrl); const p = start(a);
  for (const name of ['deep-research', 'deep-review', 'spec-review', 'impact-review']) {
    const raw = await readFile(`workflows/${name}/spec.json`, 'utf8'); const s = JSON.parse(raw);
    const c = child(a, p, s); assert.equal(c.executionProfile.definitionFingerprint, workflowDefinitionFingerprint(s));
    assert.ok(collectWorkflowProfileStageSlots(s).length > 0); assert.equal(await readFile(`workflows/${name}/spec.json`, 'utf8'), raw);
  }
});
test('fractional non-model workflow data keeps the existing definition identity', async () => {
  const a = await import(adapterUrl); const p = start(a); const s = spec();
  s.input = { threshold: 0.5, precision: 1e-7, big: 1e30 };
  const before = JSON.stringify(s); const c = child(a, p, s);
  assert.equal(c.executionProfile.definitionFingerprint, workflowDefinitionFingerprint(s));
  assert.equal(JSON.stringify(s), before); assert.equal(s.input.threshold, 0.5);
  assert.throws(() => goalHash({ counter: 0.5 }), /non-data/);
  for (const value of [NaN, Infinity, -Infinity, new Date(), { toJSON() { return 0.5; } }]) {
    const bad = spec(); bad.input = { value }; assert.throws(() => child(a, p, bad));
  }
  let calls = 0; const getter = spec(); getter.input = Object.defineProperty({}, 'threshold', { enumerable: true, get() { calls++; return 0.5; } });
  assert.throws(() => child(a, p, getter)); assert.equal(calls, 0);
});
test('strict Goal profile metadata rejects mixed-field origin erasure and mutation of capture', async () => {
  const a = await import(adapterUrl); const p = start(a); const s = spec(); const context = { profile: p, spec: s, bundleDigest: h('bundle'), availableModels: models };
  const bad = structuredClone(p); bad.roles[0].origin = 'inherit'; assert.throws(() => a.assertGoalProfileAvailable(bad, models));
  assert.throws(() => child(a, p, a.goalProfileTemplate()), /settings template/);
  const c = child(a, p); assert.throws(() => { c.executionProfile.stageOverrides.work.model = 'forged'; }, TypeError);
  assert.throws(() => a.assertGoalChildProfile(context, { ...c, trusted: true }));
  assert.throws(() => child(a, p, spec('nothing', [])));
});
