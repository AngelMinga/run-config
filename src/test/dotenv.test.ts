import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeEnv, parseDotenv } from '../dotenv';

test('dotenv basics: comments, export, quotes, inline comments', () => {
  const env = parseDotenv([
    '# comment',
    'export API_URL=http://localhost:8080/api # inline',
    "SINGLE='literal $HOME \\n'",
    'DOUBLE="line1\\nline2 \\"quoted\\""',
    'EMPTY=',
    'SPACED = value with spaces  ',
    'HASH="value # not a comment"',
    'not a line',
  ].join('\n'));
  assert.deepEqual(env, {
    API_URL: 'http://localhost:8080/api',
    SINGLE: 'literal $HOME \\n',
    DOUBLE: 'line1\nline2 "quoted"',
    EMPTY: '',
    SPACED: 'value with spaces',
    HASH: 'value # not a comment',
  });
});

test('multi-line double-quoted values and CRLF', () => {
  const env = parseDotenv('KEY="-----BEGIN-----\r\nabc\r\n-----END-----"\r\nNEXT=1\r\n');
  assert.deepEqual(env, { KEY: '-----BEGIN-----\nabc\n-----END-----', NEXT: '1' });
});

test('expansion from earlier keys, then the process env, with defaults and escapes', () => {
  const env = parseDotenv('HOST=localhost\nURL=http://${HOST}:${PORT:-3000}/$NAME\nRAW=\\$HOST\nLIT=\'${HOST}\'', { NAME: 'app' });
  assert.equal(env.URL, 'http://localhost:3000/app');
  assert.equal(env.RAW, '$HOST');
  assert.equal(env.LIT, '${HOST}');
});

test('the configuration env overrides the file', () => {
  assert.deepEqual(mergeEnv({ A: 'file', B: 'file' }, { B: 'own' }), { A: 'file', B: 'own' });
});
