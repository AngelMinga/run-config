import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { dockerEntries, testEntries } from '../entryPoints';
import {
  buildAttachLaunch, buildDockerLaunch, buildNodeFileLaunch, buildTestLaunch, emptyConfig, escapeTestName, fromLaunchEntry, testArgs, toLaunchEntry,
} from '../model';
import { findTestRunner, nearestPackageDir } from '../project';

const folder = '/w';

test('Node.js, attach, test and docker round-trip through launch.json', () => {
  const configs = [
    { ...emptyConfig(folder, 'server', 'node'), program: '/w/src/server.ts', arguments: '--port 3000', nodeOptions: '--inspect', workingDir: '/w/src', shared: true },
    { ...emptyConfig(folder, 'Attach', 'attach'), host: '127.0.0.1', port: '9230', reconnect: false, shared: true },
    { ...emptyConfig(folder, 'sum', 'test'), runner: 'vitest', program: '/w/pkg/sum.test.ts', testName: 'math adds', workingDir: '/w/pkg', arguments: '--coverage', shared: true },
    { ...emptyConfig(folder, 'stack', 'docker'), program: '/w/docker-compose.yml', services: 'db api', arguments: '--build', shared: true },
  ];
  for (const c of configs) {
    assert.deepEqual(fromLaunchEntry(toLaunchEntry(c, '/h'), folder, '/h', true), c, c.kind);
  }
  assert.equal(toLaunchEntry(configs[3], '/h').composeFile, '${workspaceFolder}/docker-compose.yml');
});

test('Node.js and attach launches', () => {
  const c = { ...emptyConfig(folder, 'server', 'node'), program: '/w/src/server.js', arguments: '--port 3000', nodeOptions: '--inspect --trace-warnings' };
  const launch = buildNodeFileLaunch(c, '/n/v24/bin/node', { PATH: '/usr/bin' }, 'darwin');
  assert.deepEqual([launch.program, launch.args, launch.cwd, launch.runtimeArgs, launch.runtimeExecutable],
    ['/w/src/server.js', ['--port', '3000'], '/w/src', ['--inspect', '--trace-warnings'], '/n/v24/bin/node']);
  assert.equal((launch.env as Record<string, string>).PATH, '/n/v24/bin:/usr/bin');
  const attach = buildAttachLaunch({ ...emptyConfig(folder, 'A', 'attach'), port: '9230' });
  assert.deepEqual([attach.type, attach.request, attach.address, attach.port, attach.restart], ['node', 'attach', 'localhost', 9230, true]);
});

test('test runner arguments', () => {
  const c = { ...emptyConfig(folder, 't', 'test'), program: '/w/pkg/src/sum.test.ts', testName: 'math (adds) 1+1', arguments: '--silent' };
  assert.deepEqual(testArgs(c, 'jest', '/w/pkg', true),
    ['--runTestsByPath', '/w/pkg/src/sum.test.ts', '-t', 'math \\(adds\\) 1\\+1', '--runInBand', '--silent']);
  assert.deepEqual(testArgs(c, 'vitest', '/w/pkg', false), ['run', 'src/sum.test.ts', '-t', 'math \\(adds\\) 1\\+1', '--silent']);
  assert.deepEqual(testArgs({ ...c, program: '', testName: '', arguments: '' }, 'vitest', '/w/pkg', false), ['run']);
  assert.equal(escapeTestName('a.b*c'), 'a\\.b\\*c');
  const launch = buildTestLaunch(c, { name: 'jest', js: '/w/node_modules/jest/bin/jest.js' }, '/w/pkg', undefined, false, {}, 'darwin');
  assert.deepEqual([launch.program, launch.cwd, launch.runtimeExecutable], ['/w/node_modules/jest/bin/jest.js', '/w/pkg', undefined]);
});

test('finds the project runner (hoisted in a monorepo) and the nearest package.json', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runcfg-test-'));
  const pkg = path.join(root, 'packages', 'web');
  fs.mkdirSync(path.join(pkg, 'src'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ devDependencies: { jest: '^30' } }));
  for (const rel of ['node_modules/jest/bin/jest.js', 'node_modules/vitest/vitest.mjs']) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), '');
  }
  assert.equal(nearestPackageDir(path.join(pkg, 'src'), root), pkg);
  assert.deepEqual(findTestRunner(pkg, root, ''), { name: 'jest', js: path.join(root, 'node_modules/jest/bin/jest.js') });
  assert.deepEqual(findTestRunner(pkg, root, 'vitest'), { name: 'vitest', js: path.join(root, 'node_modules/vitest/vitest.mjs') });
  assert.equal(findTestRunner(fs.mkdtempSync(path.join(os.tmpdir(), 'none-')), '/', 'jest'), undefined);
});

test('docker compose launch goes through the script adapter', () => {
  const launch = buildDockerLaunch({ ...emptyConfig(folder, 's', 'docker'), program: '/w/ops/compose.yaml', services: 'db', arguments: '--build' });
  assert.deepEqual([launch.type, launch.command, launch.args, launch.cwd, launch.__resolvedScript],
    ['script-run', 'docker', ['compose', '-f', '/w/ops/compose.yaml', 'up', '--build', 'db'], '/w/ops', true]);
});

test('▷ entries in test files and compose files', () => {
  const src = [
    "import { describe, it } from 'vitest';",
    "describe('math', () => {",
    "  it('adds', () => {});",
    '  it.each([1, 2])(\'n %i\', () => {});',
    '  test.skip("skips \\"quoted\\"", () => {});',
    '  it(`dynamic ${x}`, () => {});',
    '});',
  ].join('\n');
  const entries = testEntries(src).map(e => (e.kind === 'test' ? e.name : ''));
  assert.deepEqual(entries, ['', 'math', 'adds', 'n %i', 'skips "quoted"']);
  assert.equal(src.slice(testEntries(src)[2].offset, testEntries(src)[2].offset + 2), 'it');
  assert.deepEqual(testEntries('const x = 1;'), []);

  const compose = 'version: "3"\nservices:\n  db:\n    image: postgres\n  api:\n    build: .\nvolumes:\n  data:\n';
  assert.deepEqual(dockerEntries(compose).map(e => (e.kind === 'docker' ? e.service : '')), ['', 'db', 'api']);
  assert.deepEqual(dockerEntries('name: x\n'), []);
});
