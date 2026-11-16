import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dartEntries, packageJsonEntries, pythonEntries, shellEntries } from '../entryPoints';

test('package.json scripts, at their keys', () => {
  const text = '{\n  "name": "x",\n  // comment\n  "scripts": {\n    "dev": "vite",\n    "build": "vite build"\n  }\n}';
  const entries = packageJsonEntries(text);
  assert.deepEqual(entries.map(e => (e.kind === 'npm' ? e.script : '')), ['dev', 'build']);
  assert.equal(text.slice(entries[0].offset, entries[0].offset + 5), '"dev"');
  assert.deepEqual(packageJsonEntries('{ "name": "x" }'), []);
  assert.deepEqual(packageJsonEntries('{ "scripts": [1] }'), []);
});

test('Dart top-level main only', () => {
  assert.equal(dartEntries('import "x";\n\nvoid main() {\n}\n').length, 1);
  assert.equal(dartEntries('Future<void> main(List<String> args) async {}').length, 1);
  assert.equal(dartEntries('class A {\n  void main() {}\n}').length, 0);
});

test('Python __main__ guard and shell scripts', () => {
  assert.equal(pythonEntries("def f(): pass\n\nif __name__ == '__main__':\n    f()\n").length, 1);
  assert.equal(pythonEntries('print(1)\n').length, 0);
  assert.deepEqual(shellEntries('#!/bin/sh\necho hi\n'), [{ kind: 'script', offset: 0 }]);
  assert.deepEqual(shellEntries('  \n'), []);
});
