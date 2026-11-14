import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface Executable {
  path: string;
  /** Without leading `v`; undefined when it could not be determined. */
  version?: string;
}

export interface PackageManagerExecutable extends Executable {
  name: string;
}

export interface DetectOptions {
  home: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'];

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function listDirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() || d.isSymbolicLink()).map(d => d.name);
  } catch {
    return [];
  }
}

/** Compares `24.16.0`-like versions, descending; unknown versions last. */
export function compareVersionsDesc(a?: string, b?: string): number {
  if (!a || !b) {
    return a ? -1 : b ? 1 : 0;
  }
  const pa = a.split(/[.-]/).map(n => parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d) { return d; }
  }
  return 0;
}

/** Version encoded in a version manager directory (`.../v24.16.0/bin/node`). */
export function versionFromPath(p: string): string | undefined {
  const m = /[\\/]v?(\d+\.\d+\.\d+)(?:[\\/]|$)/.exec(p);
  return m?.[1];
}

export function pathDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const key = platform === 'win32' ? Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'Path' : 'PATH';
  return (env[key] ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
}

function exeNames(name: string, platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, name] : [name];
}

/** First match of `name` in the given directories. */
export function findIn(dirs: string[], name: string, platform: NodeJS.Platform): string | undefined {
  for (const dir of dirs) {
    for (const exe of exeNames(name, platform)) {
      const p = path.join(dir, exe);
      if (isFile(p)) { return p; }
    }
  }
  return undefined;
}

/** Candidate node binaries, PATH first, then version managers and well-known locations. */
export function nodeCandidates(o: DetectOptions): string[] {
  const { home, env, platform } = o;
  const out: string[] = [];
  const add = (p: string | undefined) => {
    if (p && !out.includes(p) && isFile(p)) { out.push(p); }
  };
  add(findIn(pathDirs(env, platform), 'node', platform));

  const versioned = (root: string, binOf: (dir: string) => string) => {
    listDirs(root)
      .sort((a, b) => compareVersionsDesc(a.replace(/^v/, ''), b.replace(/^v/, '')))
      .forEach(v => add(binOf(path.join(root, v))));
  };
  if (platform === 'win32') {
    const nvmHome = env.NVM_HOME ?? path.join(env.APPDATA ?? '', 'nvm');
    versioned(nvmHome, d => path.join(d, 'node.exe'));
    add(path.join(env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node.exe'));
    add(path.join(home, 'AppData', 'Local', 'Volta', 'bin', 'node.exe'));
    return out;
  }
  const nvmDir = env.NVM_DIR ?? path.join(home, '.nvm');
  versioned(path.join(nvmDir, 'versions', 'node'), d => path.join(d, 'bin', 'node'));
  versioned(path.join(home, '.fnm', 'node-versions'), d => path.join(d, 'installation', 'bin', 'node'));
  versioned(path.join(home, 'Library', 'Application Support', 'fnm', 'node-versions'), d => path.join(d, 'installation', 'bin', 'node'));
  versioned(path.join(home, '.local', 'share', 'fnm', 'node-versions'), d => path.join(d, 'installation', 'bin', 'node'));
  versioned(path.join(home, '.asdf', 'installs', 'nodejs'), d => path.join(d, 'bin', 'node'));
  versioned(path.join(home, '.local', 'share', 'mise', 'installs', 'node'), d => path.join(d, 'bin', 'node'));
  versioned(path.join(home, '.volta', 'tools', 'image', 'node'), d => path.join(d, 'bin', 'node'));
  add('/opt/homebrew/bin/node');
  add('/usr/local/bin/node');
  add('/usr/bin/node');
  add(path.join(home, '.volta', 'bin', 'node'));
  return out;
}

/** Candidate package managers: next to every node, on PATH and in standalone install dirs. */
export function packageManagerCandidates(nodes: string[], o: DetectOptions): { name: string; path: string }[] {
  const { home, env, platform } = o;
  const dirs: string[] = [];
  const addDir = (d: string) => { if (!dirs.includes(d)) { dirs.push(d); } };
  pathDirs(env, platform).forEach(addDir);
  nodes.forEach(n => addDir(path.dirname(n)));
  if (platform !== 'win32') {
    ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, 'Library', 'pnpm'), path.join(home, '.local', 'share', 'pnpm'),
      path.join(home, '.bun', 'bin'), path.join(home, '.yarn', 'bin')].forEach(addDir);
  } else {
    [path.join(env.APPDATA ?? '', 'npm'), path.join(env.LOCALAPPDATA ?? '', 'pnpm'), path.join(home, '.bun', 'bin')].forEach(addDir);
  }
  const out: { name: string; path: string }[] = [];
  // PATH matches first (they are what a terminal would run), then per-directory in order.
  for (const name of PACKAGE_MANAGERS) {
    const p = findIn(pathDirs(env, platform), name, platform);
    if (p) { out.push({ name, path: p }); }
  }
  for (const dir of dirs) {
    for (const name of PACKAGE_MANAGERS) {
      const p = findIn([dir], name, platform);
      if (p && !out.some(e => e.path === p)) { out.push({ name, path: p }); }
    }
  }
  return out;
}

export function runVersion(exe: string, env: NodeJS.ProcessEnv, timeoutMs = 5000): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile(exe, ['--version'], { env, timeout: timeoutMs, shell: process.platform === 'win32' && /\.cmd$/i.test(exe) },
      (err, stdout) => {
        const v = /v?(\d+\.\d+\.\d+[^\s]*)/.exec(String(stdout ?? ''));
        resolve(err || !v ? undefined : v[1]);
      });
  });
}

/** PATH with `dir` first, so shims run with a sibling node. */
export function envWithDir(env: NodeJS.ProcessEnv, dir: string, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const key = platform === 'win32' ? Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'Path' : 'PATH';
  return { ...env, [key]: dir + (platform === 'win32' ? ';' : ':') + (env[key] ?? '') };
}

export interface Detection {
  nodes: Executable[];
  packageManagers: PackageManagerExecutable[];
}

export async function detect(o: DetectOptions): Promise<Detection> {
  const nodePaths = nodeCandidates(o);
  const nodes = await Promise.all(nodePaths.map(async p => ({
    path: p,
    version: versionFromPath(p) ?? await runVersion(p, o.env),
  })));
  const pms = await Promise.all(packageManagerCandidates(nodePaths, o).map(async c => ({
    ...c,
    version: await runVersion(c.path, envWithDir(o.env, path.dirname(c.path), o.platform)),
  })));
  return { nodes, packageManagers: pms };
}
