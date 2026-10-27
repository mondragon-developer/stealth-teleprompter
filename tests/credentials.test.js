import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const code = main.slice(main.indexOf('let keyStateVersion'), main.indexOf('function loadAiUI'));
function setup(invoke) {
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', disabled: false });
    return elements.get(id);
  };
  const ctx = vm.createContext({ $, invoke, providerCfg: () => ({ id: 'claude' }) });
  vm.runInContext(code, ctx);
  return { $, run: (expression) => vm.runInContext(expression, ctx) };
}

test('delete waits for backend verification, clears input and blocks duplicate actions', async () => {
  let finish;
  let calls = 0;
  const { $, run } = setup((command, args) => {
    assert.equal(command, 'llm_delete_key');
    assert.equal(args.id, 'claude');
    calls++;
    return new Promise((resolve) => { finish = resolve; });
  });
  $('ai-key').value = 'dummy-test-key';
  const pending = run('manageKey(true)');
  assert.equal($('ai-key').value, '');
  assert.equal($('btn-ai-key-delete').disabled, true);
  assert.doesNotMatch($('ai-key-state').textContent, /Deleted and verified/);
  await run('manageKey(false)');
  assert.equal(calls, 1);
  finish();
  await pending;
  assert.match($('ai-key-state').textContent, /Deleted and verified/);
  assert.equal($('btn-ai-key-delete').disabled, false);
});

test('failed deletion does not claim success or display secret-bearing exceptions', async () => {
  const { $, run } = setup(async () => { throw new Error('dummy-secret'); });
  await run('manageKey(true)');
  assert.match($('ai-key-state').textContent, /could not be verified/);
  assert.doesNotMatch($('ai-key-state').textContent, /dummy-secret/);
  assert.equal($('btn-ai-key-delete').disabled, false);
});

test('keychain status errors are not mistaken for an absent key', async () => {
  const { $, run } = setup(async () => { throw new Error('locked'); });
  await run('refreshKeyState()');
  assert.match($('ai-key-state').textContent, /Unable to verify/);
});

test('an old status response cannot overwrite the verified deletion message', async () => {
  let resolveStatus;
  const { $, run } = setup((cmd) => cmd === 'llm_has_key'
    ? new Promise((resolve) => { resolveStatus = resolve; }) : Promise.resolve());
  const stale = run('refreshKeyState()');
  await run('manageKey(true)');
  resolveStatus(true);
  await stale;
  assert.match($('ai-key-state').textContent, /Deleted and verified/);
});

test('saving clears the input even when the keychain rejects the write', async () => {
  const { $, run } = setup(async (cmd, args) => {
    assert.equal(cmd, 'llm_set_key');
    assert.equal(args.key, 'dummy-test-key');
    throw new Error('write denied');
  });
  $('ai-key').value = 'dummy-test-key';
  await run('manageKey(false)');
  assert.equal($('ai-key').value, '');
  assert.match($('ai-key-state').textContent, /Could not save/);
});
