import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyTemplate, emptyConfig, fromLaunchEntry, toLaunchEntry } from '../model';

test('templates set only their fields, as copies', () => {
  const template = {
    ...emptyConfig('', '', 'npm'),
    packageManager: 'pnpm', nodeOptions: '--max-old-space-size=4096', env: { NODE_ENV: 'development' }, envFile: '/w/.env',
    beforeLaunch: [{ type: 'task' as const, name: 'npm: build' }],
    packageJson: '/ignored/package.json', name: 'ignored',
  };
  const c = applyTemplate({ ...emptyConfig('/w', 'web'), scripts: 'dev' }, template);
  assert.equal(c.name, 'web');
  assert.equal(c.packageJson, '/w/package.json');
  assert.equal(c.scripts, 'dev');
  assert.equal(c.packageManager, 'pnpm');
  assert.equal(c.envFile, '/w/.env');
  c.env.X = '1';
  c.beforeLaunch.push({ type: 'browser', url: 'http://x' });
  assert.deepEqual(template.env, { NODE_ENV: 'development' });
  assert.equal(template.beforeLaunch.length, 1);
  assert.equal(applyTemplate(emptyConfig('/w', 'a', 'compound'), template).packageManager, '');
});

test('envFile and group round-trip through launch.json', () => {
  const c = { ...emptyConfig('/w', 'api', 'script'), program: '/w/api.py', envFile: '/w/config/.env', group: 'Backend', shared: true };
  const entry = toLaunchEntry(c, '/home');
  assert.equal(entry.envFile, '${workspaceFolder}/config/.env');
  assert.equal(entry.group, 'Backend');
  assert.deepEqual(fromLaunchEntry(entry, '/w', '/home', true), c);
  const compound = toLaunchEntry({ ...emptyConfig('/w', 'All', 'compound'), members: ['api'], group: 'G', envFile: '/w/.env' }, '/home');
  assert.equal(compound.envFile, undefined);
  assert.equal(compound.group, 'G');
});
