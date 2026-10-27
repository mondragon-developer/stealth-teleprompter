import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { captureController } from '../src/capture-controller.js';

const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));

// Run the actual UI transitions against a native capture that completes on demand.
function fixture(ensureModel = async () => true) {
  const calls = [];
  const waiting = [];
  const native = { voice: false, listen: false };
  const elements = new Map();
  const ctx = vm.createContext({
    captureController,
    $: (id) => {
      if (!elements.has(id)) elements.set(id, { classList: { add() {}, remove() {} } });
      return elements.get(id);
    },
    invoke: (command) => {
      calls.push(command);
      const match = command.match(/^(voice|listen)_(start|stop)$/);
      if (!match) return Promise.resolve();
      return new Promise((resolve) => waiting.push(() => {
        native[match[1]] = match[2] === 'start';
        resolve();
      }));
    },
    ensureModel, playing: false, countdownTimer: null,
    showVoiceStatus() {}, showAnswerError() {}, cancelCountdown() {},
    setPlaying(value) { ctx.playing = value; },
    showWord() {}, sendVoiceContextSoon() {}, savePosition() {}, checkModel() {},
  });
  vm.runInContext(`let voiceOn = false, voiceStarting = false, listenOn = false, listenStarting = false;
    let speechOk = true, current = {}, editing = false, wordIdx = 0;
    const settings = { asrModel: 'tiny', asrLang: 'en' };`, ctx);
  vm.runInContext(source.slice(source.indexOf('async function applyListen'), source.indexOf('function toggleAnswers')), ctx);
  vm.runInContext(source.slice(source.indexOf('const voiceControl ='), source.indexOf('function editDistanceAtMost')), ctx);
  vm.runInContext(source.slice(source.indexOf('function requestPlay()'), source.indexOf('// The slider is quadratic')), ctx);
  return { calls, native, waiting, run: (s) => vm.runInContext(s, ctx) };
}

test('Play during the model check is not cancelled by stale Voice startup', async () => {
  let finishModel;
  const f = fixture(() => new Promise((resolve) => { finishModel = resolve; }));
  const start = f.run('setVoice(true)');
  await tick();
  f.run('requestPlay()');
  assert.equal(f.run('playing'), true);
  finishModel(true);
  await start;
  await tick();
  assert.equal(f.run('playing'), true);
  assert.equal(f.calls.includes('voice_start'), false);
  assert.equal(f.calls.at(-1), 'voice_stop');
  f.waiting.shift()();
  await tick();
  assert.equal(f.run('voiceOn'), false);
  assert.equal(f.run('playing'), true);
});

for (const kind of ['voice', 'listen']) {
  const setter = kind === 'voice' ? 'setVoice' : 'setListen';
  test(`${kind}: start-stop-start during startup leaves native capture and UI on`, async () => {
    const f = fixture();
    f.run(`${setter}(true)`);
    await tick();
    f.run(`${setter}(false)`);
    const last = f.run(`${setter}(true)`);
    assert.equal(f.run(`${kind}Control.desired`), true);
    f.waiting.shift()();
    await last;
    assert.equal(f.native[kind], true);
    assert.equal(f.run(`${kind}On`), true);
    assert.equal(f.calls.filter((c) => c === `${kind}_stop`).length, 0);
  });

  test(`${kind}: a pending stop finishes before the next start`, async () => {
    const f = fixture();
    const first = f.run(`${setter}(true)`);
    await tick();
    f.run(`${setter}(false)`);
    f.waiting.shift()();
    await first;
    await tick();
    assert.equal(f.calls.at(-1), `${kind}_stop`);
    const last = f.run(`${setter}(true)`);
    await tick();
    assert.equal(f.calls.filter((c) => c === `${kind}_start`).length, 1);
    f.waiting.shift()();
    await tick();
    assert.equal(f.calls.at(-1), `${kind}_start`);
    f.waiting.shift()();
    await last;
    assert.equal(f.native[kind], true);
    assert.equal(f.run(`${kind}On`), true);
  });
}
