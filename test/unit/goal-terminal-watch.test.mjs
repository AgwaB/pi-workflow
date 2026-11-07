// Exercise the actual test-local watcher bodies without launching the workflow engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ts = createRequire(join(repo, 'package.json'))('typescript');
const source = readFileSync(join(repo, 'test/unit/goal-public-runtime.test.mjs'), 'utf8');
const sf = ts.createSourceFile('fixture.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function body(name) {
  const matches = [];
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) matches.push(node.getText(sf));
    ts.forEachChild(node, visit);
  }
  visit(sf);
  assert.equal(matches.length, 1);
  return matches[0];
}
for (const name of ['watchOriginalDurableTerminal', 'watchOriginalTerminalAndFeedback']) {
  test(`${name} rechecks an event received during a pending read`, async () => {
    const emitter = new EventEmitter();
    emitter.close = () => emitter.removeAllListeners();
    const controller = new AbortController();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let reads = 0;
    const readRunRecord = async () => {
      if (++reads === 1) { await gate; return { status: 'running' }; }
      return { status: 'completed' };
    };
    const watch = (_path, cb) => { emitter.on('change', cb); return emitter; };
    const fn = new Function('readRunRecord', 'watch', 'join', 'cwd', 't', 'testMs',
      `${body(name)}; return ${name};`)(readRunRecord, watch, join, '/fixture',
        { signal: controller.signal }, () => 200);
    const result = fn('run', Promise.resolve('completed notice'));
    emitter.emit('change');
    release();
    try {
      const observed = await result;
      assert.equal((observed.run ?? observed).status, 'completed');
      assert.ok(reads >= 2);
    } finally { controller.abort(); emitter.close(); }
  });
  // Observed in a retained run: run.json was durably completed 18 s before the
  // watcher timed out, with no later write. Directory events can be lost.
  test(`${name} observes a terminal state written without any watch event`, async () => {
    const emitter = new EventEmitter();
    emitter.close = () => emitter.removeAllListeners();
    const controller = new AbortController();
    let reads = 0;
    // Two non-terminal reads also cover the feedback-triggered recheck.
    const readRunRecord = async () => (++reads <= 2 ? { status: 'running' } : { status: 'completed' });
    const watch = () => emitter; // never emits
    const fn = new Function('readRunRecord', 'watch', 'join', 'cwd', 't', 'testMs',
      `${body(name)}; return ${name};`)(readRunRecord, watch, join, '/fixture',
        { signal: controller.signal }, () => 1000);
    try {
      const observed = await fn('run', Promise.resolve('completed notice'));
      assert.equal((observed.run ?? observed).status, 'completed');
      assert.ok(reads >= 3);
    } finally { controller.abort(); emitter.close(); }
  });
  // Seen on Linux CI: a tamper fixture rewrites run.json in place and the poll
  // read it half-written ("Unexpected end of JSON input").
  test(`${name} retries a half-written run record`, async () => {
    const emitter = new EventEmitter();
    emitter.close = () => emitter.removeAllListeners();
    const controller = new AbortController();
    let reads = 0;
    const readRunRecord = async () => {
      if (++reads === 1) return JSON.parse('{"status":');
      return { status: 'completed' };
    };
    const watch = () => emitter;
    const fn = new Function('readRunRecord', 'watch', 'join', 'cwd', 't', 'testMs',
      `${body(name)}; return ${name};`)(readRunRecord, watch, join, '/fixture',
        { signal: controller.signal }, () => 1000);
    try {
      const observed = await fn('run', Promise.resolve('completed notice'));
      assert.equal((observed.run ?? observed).status, 'completed');
    } finally { controller.abort(); emitter.close(); }
  });
  test(`${name} still fails on a read error that is not a partial record`, async () => {
    const emitter = new EventEmitter();
    emitter.close = () => emitter.removeAllListeners();
    const controller = new AbortController();
    const readRunRecord = async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); };
    const fn = new Function('readRunRecord', 'watch', 'join', 'cwd', 't', 'testMs',
      `${body(name)}; return ${name};`)(readRunRecord, () => emitter, join, '/fixture',
        { signal: controller.signal }, () => 1000);
    try {
      await assert.rejects(fn('run', Promise.resolve('completed notice')), /gone/);
    } finally { controller.abort(); emitter.close(); }
  });
}
