import test from 'node:test';
import assert from 'node:assert/strict';
import { THINKING_LEVELS, WORKFLOW_PROFILE_ROLES } from '../../.tmp/unit/types.js';
import { parseGoalContract, parseGoalProfile, parseGoalReceipt, goalHash } from '../../.tmp/unit/goal-contract.js';
import { contractData, fixture } from './helpers/goal-fixture.mjs';

test('A08 CORE parent regression: Goal capture reuses workflow role/thinking enums', () => {
  const original = contractData();
  assert.deepEqual(new Set(original.profile.roles.map(row => row.role)), new Set(WORKFLOW_PROFILE_ROLES));
  for (const thinking of THINKING_LEVELS) {
    const profile = structuredClone(original.profile);
    profile.roles.forEach(row => { row.thinking = thinking; });
    assert.equal(parseGoalProfile(profile).roles[0].thinking, thinking);
  }
  const bad = structuredClone(original);
  bad.profile.roles[0].thinking = 'invented-thinking';
  bad.profileHash = goalHash(bad.profile);
  assert.throws(() => parseGoalProfile(bad.profile), /enum/);
  assert.throws(() => parseGoalContract(bad), /enum/);
});

test('A08 B07 CORE parent regression: model receipt rejects unknown thinking, no clamping', () => {
  const f = fixture();
  const receipt = structuredClone(f.receipt().data.receipt);
  receipt.kind = 'model-rubric';
  receipt.model = { model: 'fixture/model', thinking: 'invented-thinking', accessDigest: receipt.evidenceRefs[0], judgment: 'fixture', counterexamples: [], limitations: [] };
  assert.throws(() => parseGoalReceipt(receipt), /enum/);
});
