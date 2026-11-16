import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseIntellijXml } from '../intellij';
import { intellijType, macroPath, runFileName, toIntellijXml } from '../intellijExport';
import { emptyConfig, RunConfig } from '../model';

const P = '/Users/me/proj';
const H = '/Users/me';

/** What survives a trip through IntelliJ's XML: compare on the fields the importer reads. */
function roundTrip(c: RunConfig, all: RunConfig[] = [c]): RunConfig {
  const xml = toIntellijXml(c, all, H);
  const [back] = parseIntellijXml(xml, P, H, true);
  assert.ok(back, `re-imported ${c.kind}: ${xml}`);
  const { projectDir: _p, source: _s, ...rest } = back;
  return { ...rest, folder: P } as RunConfig;
}

const base = (name: string, kind: RunConfig['kind']) => ({ ...emptyConfig(P, name, kind), shared: true });

test('every kind round-trips through an IntelliJ .run.xml', () => {
  const npm = {
    ...base('web dev', 'npm'), packageJson: `${P}/web/package.json`, scripts: 'dev', arguments: '--port 4200', nodeOptions: '--inspect',
    packageManager: 'pnpm', env: { A: '1 & <2>' }, group: 'Front', allowMultiple: true,
    beforeLaunch: [{ type: 'npm' as const, packageJson: `${P}/package.json`, script: 'build' }, { type: 'browser' as const, url: 'http://localhost:4200' }],
  };
  const cases: RunConfig[] = [
    npm,
    { ...base('main.dart', 'flutter'), program: `${P}/lib/main.dart`, runArgs: '--release', attachArgs: '--debug-port 1', flavor: 'dev' },
    { ...base('server', 'node'), program: `${P}/src/server.js`, workingDir: `${P}/src`, arguments: '--port 3000', nodeOptions: '--inspect', env: { X: 'y' } },
    { ...base('Attach', 'attach'), host: '127.0.0.1', port: '9230', reconnect: false },
    { ...base('sum', 'test'), runner: 'vitest', program: `${P}/src/sum.test.ts`, testName: 'adds', workingDir: P, arguments: '--coverage' },
    { ...base('all jest', 'test'), runner: 'jest', workingDir: P },
    { ...base('stack', 'docker'), program: `${P}/docker-compose.yml`, services: 'db api', arguments: '--build' },
    { ...base('greet', 'script'), program: `${P}/tools/greet.sh`, arguments: 'world', workingDir: `${P}/tools` },
    { ...base('etl', 'script'), program: `${P}/etl/main.py`, arguments: '--dry-run', workingDir: `${P}/etl`, interpreter: '/opt/py/bin/python3' },
  ];
  for (const c of cases) {
    assert.deepEqual(roundTrip(c, cases), c, `${c.kind} ${c.name}`);
  }
});

test('compounds and "run another configuration" keep the target types', () => {
  const api = { ...base('api', 'node'), program: `${P}/api.js` };
  const all: RunConfig[] = [
    api,
    { ...base('web', 'npm'), scripts: 'dev', beforeLaunch: [{ type: 'config', name: 'api' }] },
    { ...base('All', 'compound'), members: ['api', 'web'] },
  ];
  assert.match(toIntellijXml(all[1], all, H), /run_configuration_name="api" run_configuration_type="NodeJSConfigurationType"/);
  assert.match(toIntellijXml(all[2], all, H), /<toRun name="api" type="NodeJSConfigurationType" \/>/);
  assert.deepEqual(roundTrip(all[2], all).members, ['api', 'web']);
  assert.deepEqual(roundTrip(all[1], all).beforeLaunch, [{ type: 'config', name: 'api' }]);
});

test('VS Code task steps have no IntelliJ equivalent and are left out', () => {
  const c = { ...base('web', 'npm'), beforeLaunch: [{ type: 'task' as const, name: 'npm: lint' }] };
  assert.doesNotMatch(toIntellijXml(c, [c], H), /lint/);
});

test('paths, types and file names', () => {
  assert.equal(macroPath(`${P}/a/b.js`, P, H), '$PROJECT_DIR$/a/b.js');
  assert.equal(macroPath(P, P, H), '$PROJECT_DIR$');
  assert.equal(macroPath(`${H}/.nvm/node`, P, H), '$USER_HOME$/.nvm/node');
  assert.equal(macroPath('/opt/x', P, H), '/opt/x');
  assert.equal(intellijType({ kind: 'script', program: 'a.PY', runner: '' }), 'PythonConfigurationType');
  assert.equal(runFileName('api: start/dev'), 'api_ start_dev.run.xml');
});
