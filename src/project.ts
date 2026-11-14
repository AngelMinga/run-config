import * as fs from 'node:fs';
import * as path from 'node:path';
import { compareVersionsDesc, Detection, Executable, findIn, pathDirs } from './detect';
import { RunConfig } from './model';

function read(p: string): string | undefined {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}

/** Walks from `start` up to `stop` (inclusive; filesystem root if `stop` isn't an ancestor). */
export function* ancestors(start: string, stop: string): Generator<string> {
  let dir = path.resolve(start);
  const end = path.resolve(stop);
  const inside = !path.relative(end, dir).startsWith('..');
  for (;;) {
    yield dir;
    if ((inside && dir === end) || path.dirname(dir) === dir) { return; }
    dir = path.dirname(dir);
  }
}

/** Contents of the nearest `.nvmrc` / `.node-version`. */
export function nodeVersionSpec(startDir: string, stopDir: string): string | undefined {
  for (const dir of ancestors(startDir, stopDir)) {
    for (const f of ['.nvmrc', '.node-version']) {
      const text = read(path.join(dir, f))?.split(/\r?\n/)[0]?.trim();
      if (text) { return text; }
    }
  }
  return undefined;
}

/** `24`, `v24.16`, `24.16.0`, `node`, `lts/*` → best matching runtime. */
export function matchNodeVersion(spec: string, nodes: Executable[]): Executable | undefined {
  const s = spec.trim().replace(/^v/, '');
  const sorted = nodes.filter(n => n.version).sort((a, b) => compareVersionsDesc(a.version, b.version));
  if (/^(node|stable|latest|lts\/.*)$/i.test(s)) {
    if (/^lts/i.test(s)) {
      return sorted.find(n => parseInt(n.version!, 10) % 2 === 0) ?? sorted[0];
    }
    return sorted[0];
  }
  if (!/^\d+(\.\d+){0,2}$/.test(s)) {
    return undefined;
  }
  const parts = s.split('.');
  return sorted.find(n => {
    const v = n.version!.split('.');
    return parts.every((p, i) => v[i] === p);
  });
}

/** Package manager the project uses: `packageManager` field, then lockfiles. */
export function projectPackageManager(packageJson: string, stopDir: string): string {
  const pkg = read(packageJson);
  if (pkg) {
    try {
      const field = JSON.parse(pkg).packageManager;
      if (typeof field === 'string') {
        const name = field.split('@')[0];
        if (name) { return name; }
      }
    } catch { /* invalid package.json: fall back to lockfiles */ }
  }
  const locks: [string, string][] = [
    ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['package-lock.json', 'npm'],
  ];
  for (const dir of ancestors(path.dirname(packageJson), stopDir)) {
    for (const [file, name] of locks) {
      if (fs.existsSync(path.join(dir, file))) { return name; }
    }
  }
  return 'npm';
}

export function packageScripts(packageJson: string): string[] {
  try {
    const scripts = JSON.parse(read(packageJson) ?? '{}').scripts;
    return scripts && typeof scripts === 'object' ? Object.keys(scripts) : [];
  } catch {
    return [];
  }
}

export interface ResolveContext {
  detection: Detection;
  /** `runConfigurations.defaultNodeRuntime` setting. */
  defaultNode: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

export interface ProjectNode {
  node?: Executable;
  /** Where it came from: `.nvmrc 24`, `setting`, `PATH`. */
  source?: string;
}

/** What "Project" means for the node runtime of a configuration. */
export function projectNode(c: Pick<RunConfig, 'packageJson' | 'folder'>, ctx: ResolveContext): ProjectNode {
  const spec = nodeVersionSpec(path.dirname(c.packageJson), c.folder);
  if (spec) {
    const node = matchNodeVersion(spec, ctx.detection.nodes);
    if (node) { return { node, source: `.nvmrc ${spec}` }; }
  }
  if (ctx.defaultNode) {
    const known = ctx.detection.nodes.find(n => n.path === ctx.defaultNode);
    return { node: known ?? { path: ctx.defaultNode }, source: 'setting' };
  }
  const onPath = findIn(pathDirs(ctx.env, ctx.platform), 'node', ctx.platform);
  if (onPath) {
    return { node: ctx.detection.nodes.find(n => n.path === onPath) ?? { path: onPath }, source: 'PATH' };
  }
  const first = ctx.detection.nodes[0];
  return first ? { node: first, source: 'detected' } : {};
}

export function resolveNode(c: RunConfig, ctx: ResolveContext): string | undefined {
  return c.nodeRuntime || projectNode(c, ctx).node?.path;
}

/** Package manager name or path → executable to launch, preferring the one next to `node`. */
export function resolvePackageManager(c: RunConfig, node: string | undefined, ctx: ResolveContext): string {
  const value = c.packageManager || projectPackageManager(c.packageJson, c.folder);
  if (value.includes('/') || value.includes('\\')) {
    return value;
  }
  if (node) {
    const sibling = findIn([path.dirname(node)], value, ctx.platform);
    if (sibling) { return sibling; }
  }
  return ctx.detection.packageManagers.find(p => p.name === value)?.path
    ?? findIn(pathDirs(ctx.env, ctx.platform), value, ctx.platform)
    ?? value;
}
