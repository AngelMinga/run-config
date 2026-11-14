import * as path from 'node:path';

/** Debug type contributed in package.json; resolved into a js-debug `node` launch. */
export const DEBUG_TYPE = 'npm-run';

/** npm commands offered in the "Command" combo (same idea as IntelliJ's list). */
export const NPM_COMMANDS = [
  'run', 'start', 'test', 'install', 'ci', 'exec', 'build', 'stop', 'restart',
  'update', 'outdated', 'audit', 'link', 'pack', 'publish', 'rebuild', 'prune', 'uninstall', 'version',
];

/** One IntelliJ-style npm run configuration, as edited in the form (absolute paths). */
export interface RunConfig {
  name: string;
  /** Workspace folder (fsPath) the configuration belongs to. */
  folder: string;
  /** "Store as project file": true → `.vscode/launch.json`, false → private workspace state. */
  shared: boolean;
  allowMultiple: boolean;
  packageJson: string;
  command: string;
  scripts: string;
  arguments: string;
  /** '' → project default (.nvmrc / setting / PATH). */
  nodeRuntime: string;
  nodeOptions: string;
  /** '' → project default (packageManager field / lockfile). Name (`pnpm`) or path. */
  packageManager: string;
  env: Record<string, string>;
  preLaunchTask: string;
}

export interface LaunchEntry {
  type: string;
  request: string;
  name: string;
  [key: string]: unknown;
}

export function emptyConfig(folder: string, name: string): RunConfig {
  return {
    name,
    folder,
    shared: false,
    allowMultiple: false,
    packageJson: path.join(folder, 'package.json'),
    command: 'run',
    scripts: '',
    arguments: '',
    nodeRuntime: '',
    nodeOptions: '',
    packageManager: '',
    env: {},
    preLaunchTask: '',
  };
}

export function configKey(c: { folder: string; name: string }): string {
  return `${c.folder}::${c.name}`;
}

/** Expands the variables VS Code would, as far as we need them to locate files. */
export function expandVars(value: string, folder: string, home: string, env: NodeJS.ProcessEnv = process.env): string {
  return value
    .replace(/\$\{workspaceFolder\}/g, folder)
    .replace(/\$\{workspaceRoot\}/g, folder)
    .replace(/\$\{userHome\}/g, home)
    .replace(/\$\{env:([^}]+)\}/g, (_, name: string) => env[name] ?? '')
    .replace(/^~(?=$|[\\/])/, home);
}

/** Turns an absolute path into a portable one for a shared launch.json. */
export function portablePath(value: string, folder: string, home: string): string {
  if (!value || !path.isAbsolute(value)) {
    return value;
  }
  const inside = (base: string) => {
    const rel = path.relative(base, value);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)) ? rel : undefined;
  };
  const relFolder = inside(folder);
  if (relFolder !== undefined) {
    return relFolder ? `\${workspaceFolder}/${relFolder.split(path.sep).join('/')}` : '${workspaceFolder}';
  }
  const relHome = inside(home);
  if (relHome !== undefined) {
    return relHome ? `\${userHome}/${relHome.split(path.sep).join('/')}` : '${userHome}';
  }
  return value;
}

export function toLaunchEntry(c: RunConfig, home: string): LaunchEntry {
  const entry: LaunchEntry = {
    type: DEBUG_TYPE,
    request: 'launch',
    name: c.name,
    packageJson: portablePath(c.packageJson, c.folder, home),
    command: c.command || 'run',
  };
  if (c.scripts) { entry.scripts = c.scripts; }
  if (c.arguments) { entry.arguments = c.arguments; }
  if (c.nodeRuntime) { entry.nodeRuntime = portablePath(c.nodeRuntime, c.folder, home); }
  if (c.nodeOptions) { entry.nodeOptions = c.nodeOptions; }
  if (c.packageManager) { entry.packageManager = portablePath(c.packageManager, c.folder, home); }
  if (Object.keys(c.env).length) { entry.env = { ...c.env }; }
  if (c.allowMultiple) { entry.allowMultipleInstances = true; }
  if (c.preLaunchTask) { entry.preLaunchTask = c.preLaunchTask; }
  return entry;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function fromLaunchEntry(e: Record<string, unknown>, folder: string, home: string, shared: boolean): RunConfig {
  const env: Record<string, string> = {};
  if (e.env && typeof e.env === 'object') {
    for (const [k, v] of Object.entries(e.env as Record<string, unknown>)) {
      if (v !== null && v !== undefined) { env[k] = String(v); }
    }
  }
  const scripts = Array.isArray(e.scripts) ? e.scripts.map(String).join(' ') : str(e.scripts);
  const args = Array.isArray(e.arguments) ? e.arguments.map(String).join(' ') : str(e.arguments);
  const expand = (v: string) => (v ? expandVars(v, folder, home) : v);
  return {
    name: str(e.name),
    folder,
    shared,
    allowMultiple: e.allowMultipleInstances === true,
    packageJson: expand(str(e.packageJson) || '${workspaceFolder}/package.json'),
    command: str(e.command) || 'run',
    scripts,
    arguments: args,
    nodeRuntime: expand(str(e.nodeRuntime)),
    nodeOptions: str(e.nodeOptions),
    packageManager: expand(str(e.packageManager)),
    env,
    preLaunchTask: str(e.preLaunchTask),
  };
}

/** Shell-like split: whitespace separated, single/double quotes and backslash escapes. */
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | undefined;
  let has = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) { quote = undefined; }
      else if (ch === '\\' && quote === '"' && i + 1 < input.length) { cur += input[++i]; }
      else { cur += ch; }
    } else if (ch === '"' || ch === "'") {
      quote = ch; has = true;
    } else if (ch === '\\' && i + 1 < input.length) {
      cur += input[++i]; has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) { out.push(cur); cur = ''; has = false; }
    } else {
      cur += ch;
    }
  }
  if (has || cur) { out.push(cur); }
  return out;
}

/** `KEY=value` lines (or `;`-separated, like IntelliJ's single-line field) → map. */
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split(/\r?\n|;/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) { continue; }
    const eq = line.indexOf('=');
    if (eq <= 0) { continue; }
    env[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return env;
}

export function formatEnv(env: Record<string, string>): string {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n');
}

/** `pnpm`, `/x/bin/pnpm.cmd` → `pnpm`. */
export function packageManagerName(pm: string): string {
  // Split on both separators: a shared launch.json may hold a path from another OS.
  return (pm.split(/[\\/]/).pop() ?? pm).replace(/\.(cmd|exe|ps1|js|cjs)$/i, '').toLowerCase();
}

/** Commands for which npm treats extra flags as its own unless preceded by `--`. */
const NPM_SCRIPT_COMMANDS = new Set(['run', 'run-script', 'rum', 'urn', 'start', 'test', 't', 'stop', 'restart']);

export function commandLine(c: Pick<RunConfig, 'command' | 'scripts' | 'arguments'>, pmName: string): string[] {
  const command = c.command.trim() || 'run';
  const out = [...splitArgs(command), ...splitArgs(c.scripts)];
  const args = splitArgs(c.arguments);
  if (args.length) {
    if (pmName === 'npm' && NPM_SCRIPT_COMMANDS.has(command) && args[0] !== '--') {
      out.push('--');
    }
    out.push(...args);
  }
  return out;
}

export interface Resolved {
  /** Absolute node binary, if one could be determined. */
  node?: string;
  /** Package manager executable (absolute path or bare name). */
  packageManager: string;
}

/** Builds the js-debug launch configuration that actually runs the npm configuration. */
export function buildNodeLaunch(
  c: RunConfig,
  resolved: Resolved,
  baseEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Record<string, unknown> {
  const env: Record<string, string | null> = { ...c.env };
  if (resolved.node) {
    // Put the chosen node first so `#!/usr/bin/env node` shims (pnpm, yarn, npm) use it.
    const pathKey = platform === 'win32'
      ? Object.keys(baseEnv).find(k => k.toLowerCase() === 'path') ?? 'Path'
      : 'PATH';
    const current = c.env[pathKey] ?? baseEnv[pathKey] ?? '';
    const delimiter = platform === 'win32' ? ';' : ':';
    env[pathKey] = path.dirname(resolved.node) + (current ? delimiter + current : '');
  }
  if (c.nodeOptions.trim()) {
    const existing = c.env.NODE_OPTIONS ?? '';
    env.NODE_OPTIONS = (existing ? existing + ' ' : '') + c.nodeOptions.trim();
  }
  const launch: Record<string, unknown> = {
    type: 'node',
    request: 'launch',
    name: c.name,
    cwd: path.dirname(c.packageJson),
    runtimeExecutable: resolved.packageManager,
    runtimeArgs: commandLine(c, packageManagerName(resolved.packageManager)),
    env,
    console: 'integratedTerminal',
    autoAttachChildProcesses: true,
    skipFiles: ['<node_internals>/**'],
    __runConfigKey: configKey(c),
  };
  if (c.preLaunchTask) {
    launch.preLaunchTask = c.preLaunchTask;
  }
  return launch;
}

/** Display form of a path: home → `~`. */
export function tildify(p: string, home: string): string {
  if (home && (p === home || p.startsWith(home + path.sep))) {
    return '~' + p.slice(home.length);
  }
  return p;
}
