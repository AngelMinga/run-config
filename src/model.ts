import * as path from 'node:path';
import { BeforeLaunchStep, parseSteps, serializeSteps } from './beforeLaunch';

/** Debug type contributed in package.json; resolved into a js-debug `node` launch. */
export const DEBUG_TYPE = 'npm-run';
/** Debug type contributed in package.json; resolved into a Dart-Code `dart` launch. */
export const FLUTTER_TYPE = 'flutter-run';
/** Debug type contributed in package.json; runs a script (Python, shell…) through the inline adapter in scriptAdapter.ts. */
export const SCRIPT_TYPE = 'script-run';
/** Debug type contributed in package.json; starts several configurations at once (IntelliJ's Compound). */
export const COMPOUND_TYPE = 'compound-run';

export type ConfigKind = 'npm' | 'flutter' | 'script' | 'compound';

export function isRunType(type: unknown): boolean {
  return type === DEBUG_TYPE || type === FLUTTER_TYPE || type === SCRIPT_TYPE || type === COMPOUND_TYPE;
}

/** npm commands offered in the "Command" combo (same idea as IntelliJ's list). */
export const NPM_COMMANDS = [
  'run', 'start', 'test', 'install', 'ci', 'exec', 'build', 'stop', 'restart',
  'update', 'outdated', 'audit', 'link', 'pack', 'publish', 'rebuild', 'prune', 'uninstall', 'version',
];

/** One IntelliJ-style run configuration (npm or Flutter), as edited in the form (absolute paths). */
export interface RunConfig {
  kind: ConfigKind;
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
  /** Flutter: Dart entrypoint (`lib/main.dart`). */
  program: string;
  /** Flutter: additional arguments to `flutter run`. */
  runArgs: string;
  /** Flutter: Gradle product flavor or Xcode scheme. */
  flavor: string;
  /** Flutter: additional arguments to `flutter attach`. */
  attachArgs: string;
  /** Script: interpreter command with options (`python3 -X dev`); '' → chosen from the script's extension. Script path is `program`. */
  interpreter: string;
  /** Script: working directory; '' → the script's directory. */
  workingDir: string;
  /** Compound: names of the configurations (same workspace folder) started together, in order. */
  members: string[];
  /** IntelliJ's "Before launch" steps, run in order (an old `preLaunchTask` becomes a `task` step). */
  beforeLaunch: BeforeLaunchStep[];
  /** Created from a ▷ in the editor and not saved yet (IntelliJ keeps the last 5); always private. */
  temporary: boolean;
}

export interface LaunchEntry {
  type: string;
  request: string;
  name: string;
  [key: string]: unknown;
}

export function emptyConfig(folder: string, name: string, kind: ConfigKind = 'npm'): RunConfig {
  return {
    kind,
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
    program: kind === 'flutter' ? path.join(folder, 'lib', 'main.dart') : '',
    runArgs: '',
    flavor: '',
    attachArgs: '',
    interpreter: '',
    workingDir: '',
    members: [],
    beforeLaunch: [],
    temporary: false,
  };
}

/** An old single `preLaunchTask` becomes the first "Run VS Code task" step. */
function migratePreLaunchTask(c: RunConfig): RunConfig {
  if (c.preLaunchTask) {
    if (!c.beforeLaunch.some(s => s.type === 'task' && s.name === c.preLaunchTask)) {
      c.beforeLaunch = [{ type: 'task', name: c.preLaunchTask }, ...c.beforeLaunch];
    }
    c.preLaunchTask = '';
  }
  return c;
}

/** Fills fields missing in configurations saved by older versions. */
export function normalize(c: Partial<RunConfig> & { folder: string; name: string }): RunConfig {
  const base = emptyConfig(c.folder, c.name, c.kind ?? 'npm');
  const out = {
    ...base, ...c, env: { ...(c.env ?? {}) }, members: [...(c.members ?? [])], beforeLaunch: (c.beforeLaunch ?? []).map(x => ({ ...x })),
  } as RunConfig;
  for (const k of Object.keys(base) as (keyof RunConfig)[]) {
    if (out[k] === undefined || out[k] === null) { (out as unknown as Record<string, unknown>)[k] = base[k]; }
  }
  return migratePreLaunchTask(out);
}

/** The file that places a configuration in a project (package.json, the Dart entrypoint or the script). */
export function anchorPath(c: Pick<RunConfig, 'kind' | 'packageJson' | 'program' | 'folder'>): string {
  return c.kind === 'npm' ? c.packageJson : c.kind === 'compound' ? c.folder : c.program;
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
  if (c.kind === 'compound') {
    return { type: COMPOUND_TYPE, request: 'launch', name: c.name, configurations: [...c.members] };
  }
  if (c.kind === 'script') {
    const entry: LaunchEntry = {
      type: SCRIPT_TYPE,
      request: 'launch',
      name: c.name,
      script: portablePath(c.program, c.folder, home),
    };
    if (c.arguments) { entry.arguments = c.arguments; }
    if (c.interpreter) { entry.interpreter = portablePath(c.interpreter, c.folder, home); }
    if (c.workingDir) { entry.workingDir = portablePath(c.workingDir, c.folder, home); }
    if (Object.keys(c.env).length) { entry.env = { ...c.env }; }
    if (c.allowMultiple) { entry.allowMultipleInstances = true; }
    if (c.preLaunchTask) { entry.preLaunchTask = c.preLaunchTask; }
    if (c.beforeLaunch.length) { entry.beforeLaunch = serializeSteps(c.beforeLaunch, p => portablePath(p, c.folder, home)); }
    return entry;
  }
  if (c.kind === 'flutter') {
    const entry: LaunchEntry = {
      type: FLUTTER_TYPE,
      request: 'launch',
      name: c.name,
      program: portablePath(c.program, c.folder, home),
    };
    if (c.runArgs) { entry.runArgs = c.runArgs; }
    if (c.flavor) { entry.flavor = c.flavor; }
    if (c.attachArgs) { entry.attachArgs = c.attachArgs; }
    if (Object.keys(c.env).length) { entry.env = { ...c.env }; }
    if (c.allowMultiple) { entry.allowMultipleInstances = true; }
    if (c.preLaunchTask) { entry.preLaunchTask = c.preLaunchTask; }
    if (c.beforeLaunch.length) { entry.beforeLaunch = serializeSteps(c.beforeLaunch, p => portablePath(p, c.folder, home)); }
    return entry;
  }
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
  if (c.beforeLaunch.length) { entry.beforeLaunch = serializeSteps(c.beforeLaunch, p => portablePath(p, c.folder, home)); }
  return entry;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function fromLaunchEntry(e: Record<string, unknown>, folder: string, home: string, shared: boolean): RunConfig {
  const c = fromLaunchFields(e, folder, home, shared);
  c.beforeLaunch = parseSteps(e.beforeLaunch, p => (p ? expandVars(p, folder, home) : p));
  return migratePreLaunchTask(c);
}

function fromLaunchFields(e: Record<string, unknown>, folder: string, home: string, shared: boolean): RunConfig {
  const env: Record<string, string> = {};
  if (e.env && typeof e.env === 'object') {
    for (const [k, v] of Object.entries(e.env as Record<string, unknown>)) {
      if (v !== null && v !== undefined) { env[k] = String(v); }
    }
  }
  const scripts = Array.isArray(e.scripts) ? e.scripts.map(String).join(' ') : str(e.scripts);
  const args = Array.isArray(e.arguments) ? e.arguments.map(String).join(' ') : str(e.arguments);
  const expand = (v: string) => (v ? expandVars(v, folder, home) : v);
  if (e.type === COMPOUND_TYPE) {
    return {
      ...emptyConfig(folder, str(e.name), 'compound'),
      shared,
      members: Array.isArray(e.configurations) ? e.configurations.filter((m): m is string => typeof m === 'string') : [],
    };
  }
  if (e.type === SCRIPT_TYPE) {
    return {
      ...emptyConfig(folder, str(e.name), 'script'),
      shared,
      allowMultiple: e.allowMultipleInstances === true,
      program: expand(str(e.script)),
      arguments: args,
      interpreter: expand(str(e.interpreter)),
      workingDir: expand(str(e.workingDir)),
      env,
      preLaunchTask: str(e.preLaunchTask),
    };
  }
  if (e.type === FLUTTER_TYPE) {
    return {
      ...emptyConfig(folder, str(e.name), 'flutter'),
      shared,
      allowMultiple: e.allowMultipleInstances === true,
      program: expand(str(e.program) || '${workspaceFolder}/lib/main.dart'),
      runArgs: Array.isArray(e.runArgs) ? e.runArgs.map(String).join(' ') : str(e.runArgs),
      flavor: str(e.flavor),
      attachArgs: Array.isArray(e.attachArgs) ? e.attachArgs.map(String).join(' ') : str(e.attachArgs),
      env,
      preLaunchTask: str(e.preLaunchTask),
    };
  }
  return {
    ...emptyConfig(folder, str(e.name)),
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

/** Where npm configurations print: the integrated terminal (default) or the Debug Console, like IntelliJ's Run window. */
export type NpmConsole = 'integratedTerminal' | 'internalConsole';

/** Builds the js-debug launch configuration that actually runs the npm configuration. */
export function buildNodeLaunch(
  c: RunConfig,
  resolved: Resolved,
  baseEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  output: NpmConsole = 'integratedTerminal',
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
    console: output,
    autoAttachChildProcesses: true,
    skipFiles: ['<node_internals>/**'],
    __runConfigKey: configKey(c),
  };
  if (output === 'internalConsole') {
    // Capture stdout/stderr of every process npm starts (not only console.* of the debuggee), and keep
    // colours: without a TTY most tools drop them, and the Debug Console renders ANSI.
    launch.outputCapture = 'std';
    if (!('FORCE_COLOR' in c.env)) { env.FORCE_COLOR = '1'; }
  }
  if (c.preLaunchTask) {
    launch.preLaunchTask = c.preLaunchTask;
  }
  return launch;
}

export interface FlutterLaunchOptions {
  /** `flutter attach` instead of `flutter run`. */
  attach?: boolean;
  /** Target device id (`macos`, `chrome`, `emulator-5554`…); undefined → Dart extension's selected device. */
  deviceId?: string;
}

/** Builds the Dart-Code launch/attach configuration for a Flutter configuration from `projectRoot` (pubspec.yaml dir). */
export function buildFlutterLaunch(c: RunConfig, projectRoot: string, options: FlutterLaunchOptions = {}): Record<string, unknown> {
  const toolArgs = splitArgs(options.attach ? c.attachArgs : c.runArgs);
  if (c.flavor.trim()) {
    toolArgs.push('--flavor', c.flavor.trim());
  }
  const launch: Record<string, unknown> = {
    type: 'dart',
    request: options.attach ? 'attach' : 'launch',
    name: options.attach ? `${c.name} (attach)` : c.name,
    cwd: projectRoot,
    program: c.program,
    __runConfigKey: configKey(c),
  };
  if (options.deviceId) { launch.deviceId = options.deviceId; }
  if (toolArgs.length) { launch.toolArgs = toolArgs; }
  if (Object.keys(c.env).length) { launch.env = { ...c.env }; }
  if (c.preLaunchTask) { launch.preLaunchTask = c.preLaunchTask; }
  return launch;
}

/** Interpreters picked from the script's extension when the configuration leaves it empty. */
const INTERPRETERS: Record<string, string> = {
  '.sh': 'bash', '.bash': 'bash', '.zsh': 'zsh',
  '.js': 'node', '.mjs': 'node', '.cjs': 'node', '.ts': 'npx tsx',
  '.rb': 'ruby', '.pl': 'perl', '.php': 'php',
};

/** Python of a virtual environment (`venv/`, `.venv/`) in one of `dirs`, like IntelliJ's project interpreter. */
export function findVenvPython(dirs: string[], exists: (p: string) => boolean): string | undefined {
  for (const dir of dirs) {
    for (const env of ['venv', '.venv']) {
      for (const exe of ['python3', 'python']) {
        const p = path.join(dir, env, 'bin', exe);
        if (exists(p)) { return p; }
      }
    }
  }
  return undefined;
}

/** Command and leading arguments that run `script`: the configured interpreter, else one chosen by extension. */
export function resolveInterpreter(
  c: Pick<RunConfig, 'program' | 'interpreter' | 'workingDir' | 'folder'>,
  exists: (p: string) => boolean,
): { command: string; args: string[] } {
  const custom = splitArgs(c.interpreter);
  if (custom.length) {
    return { command: custom[0], args: [...custom.slice(1), c.program] };
  }
  const ext = path.extname(c.program).toLowerCase();
  if (ext === '.py') {
    const python = findVenvPython([c.workingDir || path.dirname(c.program), c.folder], exists) ?? 'python3';
    return { command: python, args: [c.program] };
  }
  const known = INTERPRETERS[ext];
  if (known) {
    const [command, ...rest] = known.split(' ');
    return { command, args: [...rest, c.program] };
  }
  return { command: c.program, args: [] };
}

/** Builds the `script-run` launch handled by the inline adapter: command, args, cwd and env already resolved. */
export function buildScriptLaunch(c: RunConfig, exists: (p: string) => boolean): Record<string, unknown> {
  const { command, args } = resolveInterpreter(c, exists);
  const launch: Record<string, unknown> = {
    type: SCRIPT_TYPE,
    request: 'launch',
    name: c.name,
    command,
    args: [...args, ...splitArgs(c.arguments)],
    cwd: c.workingDir || path.dirname(c.program),
    // Unbuffered Python output, so it shows up in the Run console as it is printed.
    env: { PYTHONUNBUFFERED: '1', ...c.env },
    __runConfigKey: configKey(c),
    __resolvedScript: true,
  };
  if (c.preLaunchTask) { launch.preLaunchTask = c.preLaunchTask; }
  return launch;
}

/** Display form of a path: home → `~`. */
export function tildify(p: string, home: string): string {
  if (home && (p === home || p.startsWith(home + path.sep))) {
    return '~' + p.slice(home.length);
  }
  return p;
}

/** Renames compound members after configurations were renamed in a folder (`renames`: old name → new name). */
export function renameMembers(configs: RunConfig[], folder: string, renames: Map<string, string>): void {
  if (!renames.size) { return; }
  for (const c of configs) {
    if (c.kind === 'compound' && c.folder === folder) {
      c.members = c.members.map(m => renames.get(m) ?? m);
    }
  }
}

/**
 * Configurations a compound starts, flattened through nested compounds (each started once, cycles ignored).
 * `lookup` finds a configuration by name in the compound's folder; unknown names are returned in `missing`.
 */
export function expandCompound(
  root: Pick<RunConfig, 'name' | 'members'>,
  lookup: (name: string) => { kind: string; members?: string[] } | undefined,
): { names: string[]; missing: string[] } {
  const names: string[] = [];
  const missing: string[] = [];
  const visiting = new Set<string>([root.name]);
  const walk = (members: string[]) => {
    for (const name of members) {
      if (visiting.has(name) || names.includes(name)) { continue; }
      const c = lookup(name);
      if (!c) {
        if (!missing.includes(name)) { missing.push(name); }
      } else if (c.kind === 'compound') {
        visiting.add(name);
        walk(c.members ?? []);
        visiting.delete(name);
      } else {
        names.push(name);
      }
    }
  };
  walk(root.members);
  return { names, missing };
}
