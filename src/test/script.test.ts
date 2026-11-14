import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { buildScriptLaunch, emptyConfig, fromLaunchEntry, isRunType, normalize, resolveInterpreter, SCRIPT_TYPE, toLaunchEntry } from '../model';
import { DapMessage, ScriptDebugAdapter } from '../scriptAdapter';

const HOME = '/home/u';
const WS = '/home/u/app';

test('script configurations round-trip through launch.json with portable paths', () => {
  const c = {
    ...emptyConfig(WS, 'Aplicar config', 'script'),
    program: `${WS}/settingsApp.py`,
    arguments: '"e"',
    workingDir: WS,
    env: { A: '1' },
    shared: true,
  };
  const entry = toLaunchEntry(c, HOME);
  assert.equal(entry.type, SCRIPT_TYPE);
  assert.equal(entry.script, '${workspaceFolder}/settingsApp.py');
  assert.equal(entry.workingDir, '${workspaceFolder}');
  assert.equal(entry.interpreter, undefined);
  assert.ok(isRunType(entry.type));
  const back = fromLaunchEntry(entry, WS, HOME, true);
  assert.equal(back.kind, 'script');
  assert.equal(back.program, `${WS}/settingsApp.py`);
  assert.equal(back.arguments, '"e"');
  assert.equal(back.workingDir, WS);
  assert.deepEqual(back.env, { A: '1' });
});

test('normalize fills the new script fields of older configurations', () => {
  const old = { kind: 'npm' as const, name: 'x', folder: WS };
  const n = normalize(old);
  assert.equal(n.interpreter, '');
  assert.equal(n.workingDir, '');
});

test('resolveInterpreter: venv python, extension defaults, custom interpreter, executables', () => {
  const venv = path.join(WS, 'venv', 'bin', 'python3');
  const py = { program: `${WS}/settingsApp.py`, interpreter: '', workingDir: '', folder: WS };
  assert.deepEqual(resolveInterpreter(py, p => p === venv), { command: venv, args: [py.program] });
  assert.deepEqual(resolveInterpreter(py, () => false), { command: 'python3', args: [py.program] });
  const dotVenv = path.join(WS, '.venv', 'bin', 'python');
  assert.equal(resolveInterpreter(py, p => p === dotVenv).command, dotVenv);
  assert.deepEqual(resolveInterpreter({ ...py, program: `${WS}/x.sh` }, () => false), { command: 'bash', args: [`${WS}/x.sh`] });
  assert.deepEqual(resolveInterpreter({ ...py, program: `${WS}/x.ts` }, () => false), { command: 'npx', args: ['tsx', `${WS}/x.ts`] });
  assert.deepEqual(resolveInterpreter({ ...py, interpreter: 'python3.12 -X dev' }, () => false),
    { command: 'python3.12', args: ['-X', 'dev', py.program] });
  assert.deepEqual(resolveInterpreter({ ...py, program: `${WS}/tool` }, () => false), { command: `${WS}/tool`, args: [] });
});

test('buildScriptLaunch resolves command, args, cwd and env', () => {
  const c = { ...emptyConfig(WS, 'Binarios', 'script'), program: `${WS}/scripts/settingsStore.py`, arguments: 'apk nolog', env: { X: 'y' } };
  const launch = buildScriptLaunch(c, () => false);
  assert.equal(launch.type, SCRIPT_TYPE);
  assert.equal(launch.command, 'python3');
  assert.deepEqual(launch.args, [`${WS}/scripts/settingsStore.py`, 'apk', 'nolog']);
  assert.equal(launch.cwd, `${WS}/scripts`);
  assert.deepEqual(launch.env, { PYTHONUNBUFFERED: '1', X: 'y' });
  assert.equal(launch.__runConfigKey, `${WS}::Binarios`);
});

// ---------- adapter ----------

function session() {
  const adapter = new ScriptDebugAdapter();
  const messages: DapMessage[] = [];
  let seq = 1;
  adapter.onDidSendMessage(m => messages.push(m));
  const request = (command: string, args: Record<string, unknown> = {}) =>
    adapter.handleMessage({ seq: seq++, type: 'request', command, arguments: args });
  const output = () => messages.filter(m => m.event === 'output').map(m => (m.body as { output: string }).output).join('');
  const waitFor = async (event: string, ms = 5000) => {
    for (let t = 0; t < ms; t += 20) {
      const m = messages.find(x => x.event === event);
      if (m) { return m; }
      await new Promise(r => setTimeout(r, 20));
    }
    throw new Error(`timeout waiting for ${event}\n${output()}`);
  };
  return { adapter, messages, request, output, waitFor };
}

test('adapter runs the command, streams output and reports the exit code', async () => {
  const s = session();
  s.request('initialize');
  assert.ok(s.messages.some(m => m.event === 'initialized'));
  s.request('launch', { command: 'sh', args: ['-c', 'echo hola; echo error 1>&2; exit 3'], env: { FOO: 'bar' } });
  const exited = await s.waitFor('exited');
  await s.waitFor('terminated');
  assert.deepEqual(exited.body, { exitCode: 3 });
  assert.match(s.output(), /hola/);
  assert.match(s.output(), /error/);
  assert.match(s.output(), /Process finished with exit code 3/);
});

test('adapter writes Debug Console input to stdin', async () => {
  const s = session();
  s.request('launch', { command: 'sh', args: ['-c', 'read x; echo "got $x"'] });
  s.request('evaluate', { expression: 'abc', context: 'repl' });
  await s.waitFor('terminated');
  assert.match(s.output(), /got abc/);
});

test('adapter stops the whole process group on terminate', async () => {
  const s = session();
  s.request('launch', { command: 'sh', args: ['-c', 'sleep 30 & sleep 30; echo never'] });
  await new Promise(r => setTimeout(r, 200));
  s.request('terminate');
  await s.waitFor('terminated');
  // The first output line echoes the command (which contains the word); the script itself must not print it.
  assert.doesNotMatch(s.output(), /^never$/m);
  assert.match(s.output(), /Process finished with (signal SIGTERM|exit code)/);
});

test('adapter reports a missing command', async () => {
  const s = session();
  s.request('launch', { command: '/nonexistent/interpreter-xyz', args: [] });
  await s.waitFor('terminated');
  assert.match(s.output(), /ENOENT/);
});
