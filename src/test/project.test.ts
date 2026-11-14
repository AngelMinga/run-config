import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { compareVersionsDesc, nodeCandidates, packageManagerCandidates, versionFromPath } from '../detect';
import { emptyConfig } from '../model';
import { matchNodeVersion, nodeVersionSpec, packageScripts, projectNode, projectPackageManager, resolvePackageManager } from '../project';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'runcfg-'));
}

function exe(p: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '#!/bin/sh\n');
  fs.chmodSync(p, 0o755);
}

const nodes = [
  { path: '/n/v24.16.0/bin/node', version: '24.16.0' },
  { path: '/n/v24.14.1/bin/node', version: '24.14.1' },
  { path: '/n/v22.19.0/bin/node', version: '22.19.0' },
  { path: '/opt/homebrew/bin/node', version: '26.13.1' },
];

test('versions', () => {
  assert.equal(versionFromPath('/Users/me/.nvm/versions/node/v24.16.0/bin/node'), '24.16.0');
  assert.equal(versionFromPath('/opt/homebrew/bin/node'), undefined);
  assert.deepEqual(['1.2.3', '10.0.0', '9.9.9', undefined as unknown as string].sort(compareVersionsDesc), ['10.0.0', '9.9.9', '1.2.3', undefined]);
});

test('matchNodeVersion follows nvm rules', () => {
  assert.equal(matchNodeVersion('24', nodes)?.version, '24.16.0');
  assert.equal(matchNodeVersion('v24.14', nodes)?.version, '24.14.1');
  assert.equal(matchNodeVersion('22.19.0', nodes)?.version, '22.19.0');
  assert.equal(matchNodeVersion('node', nodes)?.version, '26.13.1');
  assert.equal(matchNodeVersion('lts/*', nodes)?.version, '26.13.1');
  assert.equal(matchNodeVersion('18', nodes), undefined);
  assert.equal(matchNodeVersion('garbage', nodes), undefined);
});

test('project files: .nvmrc, packageManager field, lockfiles, scripts', () => {
  const root = tmp();
  const app = path.join(root, 'apps', 'web');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(root, '.nvmrc'), 'v22\n');
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), '');
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ scripts: { dev: 'vite', build: 'vite build' } }));

  assert.equal(nodeVersionSpec(app, root), 'v22');
  assert.equal(projectPackageManager(path.join(app, 'package.json'), root), 'pnpm');
  assert.deepEqual(packageScripts(path.join(app, 'package.json')), ['dev', 'build']);

  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ packageManager: 'yarn@4.5.0+sha.abc' }));
  assert.equal(projectPackageManager(path.join(app, 'package.json'), root), 'yarn');

  const ctx = { detection: { nodes, packageManagers: [] }, defaultNode: '', env: { PATH: '' }, platform: 'darwin' as const };
  const c = { ...emptyConfig(root, 'x'), packageJson: path.join(app, 'package.json') };
  assert.deepEqual(projectNode(c, ctx), { node: nodes[2], source: '.nvmrc v22' });
});

test('resolvePackageManager prefers the one next to node', () => {
  const root = tmp();
  exe(path.join(root, 'v24', 'bin', 'node'));
  exe(path.join(root, 'v24', 'bin', 'pnpm'));
  const ctx = { detection: { nodes: [], packageManagers: [{ name: 'pnpm', path: '/other/pnpm' }] }, defaultNode: '', env: { PATH: '' }, platform: 'darwin' as const };
  const c = { ...emptyConfig(root, 'x'), packageManager: 'pnpm' };
  assert.equal(resolvePackageManager(c, path.join(root, 'v24', 'bin', 'node'), ctx), path.join(root, 'v24', 'bin', 'pnpm'));
  assert.equal(resolvePackageManager(c, undefined, ctx), '/other/pnpm');
  assert.equal(resolvePackageManager({ ...c, packageManager: '/abs/yarn' }, undefined, ctx), '/abs/yarn');
  assert.equal(resolvePackageManager({ ...c, packageManager: 'bun' }, undefined, ctx), 'bun');
});

test('detection finds nvm versions and sibling package managers', () => {
  const home = tmp();
  exe(path.join(home, '.nvm', 'versions', 'node', 'v20.19.5', 'bin', 'node'));
  exe(path.join(home, '.nvm', 'versions', 'node', 'v24.16.0', 'bin', 'node'));
  exe(path.join(home, '.nvm', 'versions', 'node', 'v24.16.0', 'bin', 'pnpm'));
  const o = { home, env: { PATH: path.join(home, '.nvm', 'versions', 'node', 'v20.19.5', 'bin') }, platform: 'linux' as const };
  const found = nodeCandidates(o).filter(p => p.startsWith(home));
  assert.deepEqual(found, [
    path.join(home, '.nvm', 'versions', 'node', 'v20.19.5', 'bin', 'node'), // PATH first
    path.join(home, '.nvm', 'versions', 'node', 'v24.16.0', 'bin', 'node'),
  ]);
  const pms = packageManagerCandidates(found, o).filter(p => p.path.startsWith(home));
  assert.deepEqual(pms, [{ name: 'pnpm', path: path.join(home, '.nvm', 'versions', 'node', 'v24.16.0', 'bin', 'pnpm') }]);
});
