import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as api from '@agwab/pi-subagent/api';

test('installed bundled engine exposes and arbitrates the v2 local release/revoke API without execution', async () => {
 for (const name of ['runSubagent','getSubagentStatus','interruptSubagent','createDurableLaunchBarrierV2','waitForDurableLaunchBarrierV2Ready','resolveDurableLaunchBarrierV2Release','revokeDurableLaunchBarrierV2','readDurableLaunchBarrierV2State','waitForDurableLaunchBarrierV2Ack']) assert.equal(typeof api[name], 'function', name);
 const root = await mkdtemp(join(tmpdir(), 'piwf-engine-api-'));
 try {
  for (let iteration = 0; iteration < 4; iteration++) {
   const descriptor = await api.createDurableLaunchBarrierV2({ directory: join(root, String(iteration)), subjectSha256: 'a'.repeat(64), authorityBindingSha256: 'b'.repeat(64), timeoutMs: 200, pollIntervalMs: 2 });
   const body = { schema: 'pi-subagent-durable-launch-barrier-ready-v2', barrierIdentitySha256: descriptor.identitySha256, challenge: descriptor.challenge, decisionNonce: descriptor.decisionNonce, subjectSha256: descriptor.subjectSha256, authorityBindingSha256: descriptor.authorityBindingSha256, runId: 'synthetic-backend-run', attemptId: 'synthetic-attempt', workerPid: process.pid, launchPayloadSha256: 'c'.repeat(64), executionPlanSha256: 'd'.repeat(64) };
   const ready = { ...body, readySha256: api.durableLaunchBarrierDigest(body) };
   await writeFile(descriptor.readyPath, JSON.stringify(ready), {mode: 0o600, flag: 'wx'});
   assert.deepEqual(await api.waitForDurableLaunchBarrierV2Ready(descriptor), ready);
   const release = () => api.resolveDurableLaunchBarrierV2Release(descriptor, ready, 'e'.repeat(64));
   const revoke = () => api.revokeDurableLaunchBarrierV2(descriptor, {cancellationId: 'synthetic-cancel', reasonSha256: 'f'.repeat(64)});
   const results = await Promise.all(iteration % 2 ? [revoke(),release(),revoke(),release()] : [release(),revoke(),release(),revoke()]);
   assert.equal(new Set(results.map(result => result.outcome)).size, 1);
   assert.equal(new Set(results.map(result => result.decision.decisionSha256)).size, 1);
   const before = await readFile(descriptor.decisionPath, 'utf8');
   assert.deepEqual((await api.readDurableLaunchBarrierV2State(descriptor)).decision, results[0].decision);
   await assert.rejects(api.readDurableLaunchBarrierV2State({...descriptor, authorityBindingSha256: '0'.repeat(64)}));
   assert.equal(await readFile(descriptor.decisionPath, 'utf8'), before, 'failed authority check does not mutate decision');
  }
 } finally { await rm(root,{recursive:true,force:true}); }
});
