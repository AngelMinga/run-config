import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnsiConverter, stripAnsi } from '../ansi';

test('plain text passes through', () => {
  assert.deepEqual(new AnsiConverter().convert('hello\n'), [{ text: 'hello\n', cls: '' }]);
});

test('basic, bright and reset colours', () => {
  const spans = new AnsiConverter().convert('\x1b[31merror\x1b[0m ok \x1b[1;92mdone\x1b[39m!');
  assert.deepEqual(spans, [
    { text: 'error', cls: 'fg-1' },
    { text: ' ok ', cls: '' },
    { text: 'done', cls: 'fg-10 b' },
    { text: '!', cls: 'b' },
  ]);
});

test('256 and true colour become hex', () => {
  const [a, b] = new AnsiConverter().convert('\x1b[38;5;196mx\x1b[48;2;0;128;255my');
  assert.equal(a.fg, '#ff0000');
  assert.equal(b.bg, '#0080ff');
});

test('style survives chunk boundaries, including a cut escape sequence', () => {
  const c = new AnsiConverter();
  assert.deepEqual(c.convert('\x1b[3'), []);
  assert.deepEqual(c.convert('2mgreen'), [{ text: 'green', cls: 'fg-2' }]);
  assert.deepEqual(c.convert(' still'), [{ text: ' still', cls: 'fg-2' }]);
});

test('cursor/clear sequences, OSC titles and lone carriage returns are dropped', () => {
  const spans = new AnsiConverter().convert('\x1b]0;title\x07\x1b[2K\x1b[1Gprogress 50%\rprogress 100%\r\n');
  assert.equal(spans.map(s => s.text).join(''), 'progress 50%progress 100%\n');
  assert.equal(stripAnsi('\x1b[1mA\x1b[0m'), 'A');
});

test('output text is never interpreted (no HTML)', () => {
  assert.deepEqual(new AnsiConverter().convert('<img src=x onerror=alert(1)>'), [{ text: '<img src=x onerror=alert(1)>', cls: '' }]);
});
