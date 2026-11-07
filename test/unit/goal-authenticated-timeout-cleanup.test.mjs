// Test the actual private timeout helper without opening SSH/socket resources.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ts = createRequire(join(repo, 'package.json'))('typescript');
const source = readFileSync(join(repo, 'src/goal-authenticated-local-channel.ts'), 'utf8');
const sf = ts.createSourceFile('channel.ts', source, ts.ScriptTarget.Latest, true);
const matches = sf.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'timed');
assert.equal(matches.length, 1);
const compiled = ts.transpileModule(matches[0].getText(sf), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;

for (const mode of ['abort', 'timeout', 'success', 'failure', 'sync-throw']) {
  test(`authenticated timeout releases observation resources on ${mode}`, async () => {
    const controller = new AbortController();
    let fireTimeout;
    let cleared = false;
    const timerToken = {};
    const timed = new Function('setTimeout', 'clearTimeout', 'GOAL_AUTHENTICATED_ACTIVE_TIMEOUT',
      `${compiled}; return timed;`)(fn => { fireTimeout = fn; return timerToken; },
        token => { assert.equal(token, timerToken); cleared = true; }, 30_000);
    const expected = new Error('owned failure');
    let workSettled = false;
    const work = mode === 'success' ? () => Promise.resolve('ok') :
      mode === 'failure' ? () => Promise.reject(expected) :
      mode === 'sync-throw' ? () => { throw expected; } :
      () => new Promise(() => {}).then(() => { workSettled = true; });
    const result = timed(work, controller.signal);
    if (mode === 'abort') controller.abort(expected);
    if (mode === 'timeout') fireTimeout();
    if (mode === 'success') assert.equal(await result, 'ok');
    else await assert.rejects(result, mode === 'timeout' ? /exchange timed out/ : error => error === expected);
    // Let the legacy promise chain's finally run before asserting, avoiding
    // falsely flagging normal-operation microtask ordering as a resource leak.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(cleared, true);
    if (mode === 'abort' || mode === 'timeout') assert.equal(workSettled, false,
      'finishing observation must not fabricate completion of the underlying work');
  });
}
