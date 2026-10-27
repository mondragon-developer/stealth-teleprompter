import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { mdLite, formatSelection } from '../src/formatting.js';

test('pasted headings do not swallow the script; formatting works inside titles', () => {
  assert.equal(mdLite('# **Welcome**\nRead this aloud.\n## Next\nKeep reading.'),
    '<h2><strong>Welcome</strong></h2><p>Read this aloud.</p><h2>Next</h2><p>Keep reading.</p>');
});

test('pasted HTML stays inert, with paragraphs and emphasis preserved', () => {
  assert.equal(mdLite('<script>alert(1)</script>\r\n\r\n**Bold** and *italic* & text'),
    '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p><p><strong>Bold</strong> and <em>italic</em> &amp; text</p>');
});

test('bold and title controls preserve surrounding text and toggle selected markup', () => {
  assert.equal(formatSelection('Hello reader!', 6, 12, 'bold').replacement, '**reader**');
  assert.equal(formatSelection('**reader**', 0, 10, 'bold').replacement, 'reader');
  assert.deepEqual(formatSelection('First\nSecond', 7, 9, 'heading'),
    { start: 6, end: 12, replacement: '## Second', selectStart: 6, selectEnd: 15 });
  assert.equal(formatSelection('## First', 3, 8, 'heading').replacement, 'First');
});

// Exercise the real alignment functions against deterministic recognition output.
const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
function align(script, heard, position = 0) {
  const context = vm.createContext({ normWords: script.split(' '), wordIdx: position,
    showWord() {}, sendVoiceContextSoon() {} });
  vm.runInContext(main.slice(main.indexOf('function normalizeWord'), main.indexOf('// Words are wrapped')), context);
  vm.runInContext(main.slice(main.indexOf('function editDistanceAtMost'), main.indexOf('function onAsr')), context);
  context.heard = heard;
  vm.runInContext('alignHeard(heard)', context);
  return context.wordIdx;
}

test('voice alignment advances on a phrase and holds for unrelated speech', () => {
  assert.equal(align('hello everyone welcome to this presentation', 'hello everyone welcome'), 3);
  assert.equal(align('hello everyone welcome to this presentation', 'please open the window'), 0);
  assert.equal(align('hello everyone welcome to this presentation', 'hello'), 0);
});

test('voice alignment tolerates accents and a missed word', () => {
  assert.equal(align('hola a todos bienvenidos a esta presentacion', 'todos bienvenidos a esta presentación'), 6);
  assert.equal(align('welcome to our new product presentation today', 'welcome to new product'), 5);
});
