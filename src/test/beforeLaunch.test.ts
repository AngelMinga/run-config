import assert from 'node:assert/strict';
import { test } from 'node:test';
import { invalidStep, parseIntellijMethod, parseSteps, serializeSteps, withoutMethod } from '../beforeLaunch';
import { fromLaunchEntry, normalize, toLaunchEntry } from '../model';
import { parseIntellijXml } from '../intellij';

const folder = '/w';

test('steps round-trip through launch.json with portable paths', () => {
  const entry = {
    type: 'npm-run', request: 'launch', name: 'web', packageJson: '${workspaceFolder}/package.json', command: 'run', scripts: 'dev',
    beforeLaunch: [
      { type: 'config', name: 'api' },
      { type: 'npm', packageJson: '${workspaceFolder}/shared/package.json', script: 'build' },
      { type: 'task', name: 'npm: lint' },
      { type: 'browser', url: 'http://localhost:3000' },
      { type: 'nope' }, { type: 'config' },
    ],
  };
  const c = fromLaunchEntry(entry, folder, '/home', true);
  assert.deepEqual(c.beforeLaunch, [
    { type: 'config', name: 'api' },
    { type: 'npm', packageJson: '/w/shared/package.json', script: 'build' },
    { type: 'task', name: 'npm: lint' },
    { type: 'browser', url: 'http://localhost:3000' },
  ]);
  assert.deepEqual(toLaunchEntry(c, '/home').beforeLaunch, entry.beforeLaunch.slice(0, 4));
});

test('an old preLaunchTask becomes the first task step', () => {
  const c = fromLaunchEntry({ type: 'npm-run', name: 'x', preLaunchTask: 'npm: build', beforeLaunch: [{ type: 'config', name: 'api' }] }, folder, '/h', true);
  assert.equal(c.preLaunchTask, '');
  assert.deepEqual(c.beforeLaunch, [{ type: 'task', name: 'npm: build' }, { type: 'config', name: 'api' }]);
  assert.equal(toLaunchEntry(c, '/h').preLaunchTask, undefined);
  // Private configurations saved by older versions too.
  const old = normalize({ folder, name: 'y', preLaunchTask: 'tsc: watch' } as Parameters<typeof normalize>[0]);
  assert.deepEqual(old.beforeLaunch, [{ type: 'task', name: 'tsc: watch' }]);
  assert.equal(old.temporary, false);
});

test('invalidStep catches empty fields, bad URLs and self references', () => {
  assert.equal(invalidStep([{ type: 'config', name: 'api' }, { type: 'browser', url: 'https://x.dev' }], 'web'), undefined);
  assert.deepEqual(invalidStep([{ type: 'config', name: 'web' }], 'web'), { type: 'config', name: 'web' });
  assert.ok(invalidStep([{ type: 'npm', packageJson: '/p', script: '' }], 'web'));
  assert.ok(invalidStep([{ type: 'browser', url: 'localhost' }], 'web'));
  assert.deepEqual(parseSteps('nope'), []);
  assert.deepEqual(serializeSteps([{ type: 'npm', packageJson: '/w/package.json', script: 'b' }], p => p.replace('/w', '${workspaceFolder}')),
    [{ type: 'npm', packageJson: '${workspaceFolder}/package.json', script: 'b' }]);
});

const METHOD = `<method v="2">
  <option name="RunConfigurationTask" enabled="true" run_configuration_name="api start" run_configuration_type="js.build_tools.npm" />
  <option name="NpmBeforeRunTask" enabled="true">
    <package-json value="$PROJECT_DIR$/shared/package.json" />
    <command value="run" />
    <scripts><script value="build" /></scripts>
    <node-interpreter value="project" />
    <envs><env name="SHOULD_NOT" value="leak" /></envs>
  </option>
  <option name="NpmBeforeRunTask" enabled="false"><scripts><script value="disabled" /></scripts></option>
  <option name="LaunchBrowser.Before.Run" url="http://localhost:4200" />
</method>`;

test('parses IntelliJ before-launch steps', () => {
  assert.deepEqual(parseIntellijMethod(METHOD, v => v.replace('$PROJECT_DIR$', '/p')), [
    { type: 'config', name: 'api start' },
    { type: 'npm', packageJson: '/p/shared/package.json', script: 'build' },
    { type: 'browser', url: 'http://localhost:4200' },
  ]);
  assert.equal(withoutMethod(`<a/>${METHOD}<b/>`), '<a/><b/>');
});

test('imported configurations keep their own scripts/env apart from the steps', () => {
  const xml = `<configuration name="web dev" type="js.build_tools.npm">
    <package-json value="$PROJECT_DIR$/package.json" />
    <command value="run" />
    <scripts><script value="dev" /></scripts>
    <envs><env name="PORT" value="4200" /></envs>
    ${METHOD}
  </configuration>`;
  const [c] = parseIntellijXml(xml, '/p', '/h', false);
  assert.equal(c.scripts, 'dev');
  assert.deepEqual(c.env, { PORT: '4200' });
  assert.equal(c.beforeLaunch.length, 3);
});
