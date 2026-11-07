import test from 'node:test';
import assert from 'node:assert/strict';
import { THINKING_LEVELS, WORKFLOW_PROFILE_ROLES } from '../../.tmp/unit/types.js';
import { parseGoalContract, parseGoalProfile, parseGoalReceipt, goalHash } from '../../.tmp/unit/goal-contract.js';
import { contractData, fixture } from './helpers/goal-fixture.mjs';


test('A08 B07 CORE parent regression: model receipt rejects unknown thinking, no clamping', () => {
  const f = fixture();
  const receipt = structuredClone(f.receipt().data.receipt);
  receipt.kind = 'model-rubric';
  receipt.model = { model: 'fixture/model', thinking: 'invented-thinking', accessDigest: receipt.evidenceRefs[0], judgment: 'fixture', counterexamples: [], limitations: [] };
  assert.throws(() => parseGoalReceipt(receipt), /enum/);
});
