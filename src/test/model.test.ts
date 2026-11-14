import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildFlutterLaunch, buildNodeLaunch, commandLine, emptyConfig, expandVars, fromLaunchEntry, normalize, packageManagerName, parseEnv,
  portablePath, splitArgs, toLaunchEntry,
} from '../model';

const home = '/Users/me';
const folder = '/Users/me/work/app';

test('splitArgs handles quotes and escapes', () => {
  assert.deepEqual(splitArgs(''), []);
  assert.deepEqual(splitArgs('  --port 3000  '), ['--port', '3000']);
  assert.deepEqual(splitArgs(`--name "John Doe" --x 'a b' c\\ d ""`), ['--name', 'John Doe', '--x', 'a b', 'c d', '']);
});

test('parseEnv accepts lines and IntelliJ semicolons', () => {
  assert.deepEqual(parseEnv('A=1\n# c\nB = x=y\n\nbad'), { A: '1', B: ' x=y' });
  assert.deepEqual(parseEnv('A=1;B=2'), { A: '1', B: '2' });
});

test('portablePath and expandVars round-trip', () => {
  assert.equal(portablePath(`${folder}/apps/web/package.json`, folder, home), '${workspaceFolder}/apps/web/package.json');
  assert.equal(portablePath('/Users/me/.nvm/versions/node/v24.16.0/bin/node', folder, home), '${userHome}/.nvm/versions/node/v24.16.0/bin/node');
  assert.equal(portablePath('/opt/homebrew/bin/node', folder, home), '/opt/homebrew/bin/node');
  assert.equal(portablePath('pnpm', folder, home), 'pnpm');
  assert.equal(expandVars('${workspaceFolder}/a/package.json', folder, home), `${folder}/a/package.json`);
  assert.equal(expandVars('~/x', folder, home), '/Users/me/x');
  assert.equal(expandVars('${env:FOO}/y', folder, home, { FOO: '/f' }), '/f/y');
});

test('launch entry round-trip keeps every field', () => {
  const c = {
    ...emptyConfig(folder, 'bancapersonas start'),
    shared: true,
    allowMultiple: true,
    packageJson: `${folder}/bancapersonas/package.json`,
    command: 'start',
    arguments: '--port 3000',
    nodeRuntime: '/Users/me/.nvm/versions/node/v24.16.0/bin/node',
    nodeOptions: '--max-old-space-size=4096',
    packageManager: 'pnpm',
    env: { API: 'http://x' },
    preLaunchTask: 'npm: build',
  };
  const entry = toLaunchEntry(c, home);
  assert.equal(entry.type, 'npm-run');
  assert.equal(entry.packageJson, '${workspaceFolder}/bancapersonas/package.json');
  assert.equal(entry.nodeRuntime, '${userHome}/.nvm/versions/node/v24.16.0/bin/node');
  assert.equal(entry.scripts, undefined, 'empty fields are omitted');
  assert.deepEqual(fromLaunchEntry(entry, folder, home, true), c);
});

test('fromLaunchEntry defaults and arrays', () => {
  const c = fromLaunchEntry({ type: 'npm-run', name: 'x', scripts: ['a', 'b'], arguments: ['--x'] }, folder, home, true);
  assert.equal(c.packageJson, `${folder}/package.json`);
  assert.equal(c.command, 'run');
  assert.equal(c.scripts, 'a b');
  assert.equal(c.arguments, '--x');
});

test('commandLine adds -- only for npm script commands', () => {
  const c = { command: 'run', scripts: 'dev', arguments: '--port 3000' };
  assert.deepEqual(commandLine(c, 'npm'), ['run', 'dev', '--', '--port', '3000']);
  assert.deepEqual(commandLine(c, 'pnpm'), ['run', 'dev', '--port', '3000']);
  assert.deepEqual(commandLine({ command: 'start', scripts: '', arguments: '' }, 'npm'), ['start']);
  assert.deepEqual(commandLine({ command: 'install', scripts: '', arguments: '--force' }, 'npm'), ['install', '--force']);
  assert.deepEqual(commandLine({ command: 'run', scripts: 'dev', arguments: '-- --x' }, 'npm'), ['run', 'dev', '--', '--x']);
});

test('packageManagerName strips paths and extensions', () => {
  assert.equal(packageManagerName('/Users/me/.nvm/versions/node/v24.16.0/bin/pnpm'), 'pnpm');
  assert.equal(packageManagerName('C:\\nvm\\yarn.cmd'), 'yarn');
  assert.equal(packageManagerName('npm'), 'npm');
});

test('buildNodeLaunch prepends node dir to PATH and sets NODE_OPTIONS', () => {
  const c = { ...emptyConfig(folder, 'web'), packageJson: `${folder}/web/package.json`, command: 'run', scripts: 'dev', nodeOptions: '--inspect-brk', env: { A: '1' } };
  const launch = buildNodeLaunch(c, { node: '/n/v24/bin/node', packageManager: '/n/v24/bin/pnpm' }, { PATH: '/usr/bin' }, 'darwin');
  assert.equal(launch.type, 'node');
  assert.equal(launch.cwd, `${folder}/web`);
  assert.equal(launch.runtimeExecutable, '/n/v24/bin/pnpm');
  assert.deepEqual(launch.runtimeArgs, ['run', 'dev']);
  assert.deepEqual(launch.env, { A: '1', PATH: '/n/v24/bin:/usr/bin', NODE_OPTIONS: '--inspect-brk' });
  assert.equal(launch.console, 'integratedTerminal');
  assert.equal(launch.__runConfigKey, `${folder}::web`);
  assert.equal(launch.preLaunchTask, undefined);
});

test('buildNodeLaunch uses the Windows Path key', () => {
  const c = emptyConfig('C:\\app', 'x');
  const launch = buildNodeLaunch(c, { node: 'C:\\nvm\\v24\\node.exe', packageManager: 'npm' }, { Path: 'C:\\Windows' }, 'win32');
  const env = launch.env as Record<string, string>;
  assert.ok(env.Path.endsWith(';C:\\Windows'));
});

test('flutter configurations round-trip and build a Dart-Code launch', () => {
  const c = {
    ...emptyConfig(folder, 'main.dart', 'flutter'),
    shared: true,
    program: `${folder}/mobile/lib/main_dev.dart`,
    runArgs: '--dart-define=ENV=dev',
    flavor: 'dev',
    env: { A: '1' },
  };
  const entry = toLaunchEntry(c, home);
  assert.deepEqual(entry, {
    type: 'flutter-run', request: 'launch', name: 'main.dart',
    program: '${workspaceFolder}/mobile/lib/main_dev.dart', runArgs: '--dart-define=ENV=dev', flavor: 'dev', env: { A: '1' },
  });
  assert.deepEqual(fromLaunchEntry(entry, folder, home, true), c);

  const launch = buildFlutterLaunch(c, `${folder}/mobile`);
  assert.deepEqual(launch, {
    type: 'dart', request: 'launch', name: 'main.dart', cwd: `${folder}/mobile`, program: c.program,
    toolArgs: ['--dart-define=ENV=dev', '--flavor', 'dev'], env: { A: '1' }, __runConfigKey: `${folder}::main.dart`,
  });
});

test('normalize fills fields of configurations saved by older versions', () => {
  const old = { name: 'x', folder, packageJson: `${folder}/package.json`, command: 'start' } as Parameters<typeof normalize>[0];
  const c = normalize(old);
  assert.equal(c.kind, 'npm');
  assert.equal(c.command, 'start');
  assert.equal(c.runArgs, '');
  assert.deepEqual(c.env, {});
});

test('buildNodeLaunch: terminal by default, Debug Console with captured output and colours on request', () => {
  const c = { ...emptyConfig('/w', 'start'), packageJson: '/w/package.json', command: 'start' };
  const term = buildNodeLaunch(c, { packageManager: 'npm' }, {}, 'darwin');
  assert.equal(term.console, 'integratedTerminal');
  assert.equal(term.outputCapture, undefined);
  const dbg = buildNodeLaunch(c, { packageManager: 'npm' }, {}, 'darwin', 'internalConsole');
  assert.equal(dbg.console, 'internalConsole');
  assert.equal(dbg.outputCapture, 'std');
  assert.equal((dbg.env as Record<string, string>).FORCE_COLOR, '1');
  const own = buildNodeLaunch({ ...c, env: { FORCE_COLOR: '0' } }, { packageManager: 'npm' }, {}, 'darwin', 'internalConsole');
  assert.equal((own.env as Record<string, string>).FORCE_COLOR, '0');
});
