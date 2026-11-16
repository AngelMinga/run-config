import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseIntellijMethod, withoutMethod } from './beforeLaunch';
import { emptyConfig, RunConfig } from './model';

/** Fields of an IntelliJ npm (`js.build_tools.npm`) or Flutter (`FlutterRunConfigurationType`) configuration. */
export type ImportedConfig = Omit<RunConfig, 'folder' | 'shared'> & {
  /** Directory that contains `.idea` / `.run` (IntelliJ's `$PROJECT_DIR$`). */
  projectDir: string;
  /** Stored as a project file in IntelliJ (`.idea/runConfigurations` or `.run`). */
  shared: boolean;
  source: string;
};

function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) {
    out[m[1]] = decode(m[2]);
  }
  return out;
}

function optionValue(body: string, name: string): string {
  for (const m of body.matchAll(/<option\b([^>]*?)\/?>/g)) {
    const a = attrs(m[1]);
    if (a.name === name) { return a.value ?? ''; }
  }
  return '';
}

function childValue(body: string, tag: string): string {
  const m = new RegExp(`<${tag}\\b([^>]*?)/?>`).exec(body);
  return m ? attrs(m[1]).value ?? '' : '';
}

const SUPPORTED = new Set([
  'js.build_tools.npm', 'FlutterRunConfigurationType', 'NodeJSConfigurationType', 'ChromiumRemoteDebugType',
  'JavaScriptTestRunnerJest', 'JavaScriptTestRunnerVitest', 'docker-deploy', 'ShConfigurationType', 'PythonConfigurationType',
]);

/** Node.js, Attach, Jest/Vitest, Docker Compose, Shell Script and Python configurations (undefined for npm/Flutter). */
function parseOtherType(
  a: Record<string, string>, body: string, env: Record<string, string>, macros: (v: string) => string, projectDir: string,
): RunConfig | undefined {
  const path_ = (v: string | undefined) => (v ? macros(v) : '');
  const inProject = (v: string) => (!v || path.isAbsolute(v) || v.startsWith('$') ? path_(v) : path.join(projectDir, v));
  switch (a.type) {
    case 'NodeJSConfigurationType': {
      const dir = path_(a['working-dir']) || projectDir;
      const file = a['path-to-js-file'] ?? '';
      return {
        ...emptyConfig(projectDir, a.name, 'node'), env,
        program: !file ? '' : path.isAbsolute(file) || file.startsWith('$') ? path_(file) : path.join(dir, file),
        workingDir: dir,
        nodeOptions: a['node-parameters'] ?? '',
        arguments: a['application-parameters'] ?? '',
        nodeRuntime: !a['node-interpreter'] || a['node-interpreter'] === 'project' ? '' : path_(a['node-interpreter']),
      };
    }
    case 'ChromiumRemoteDebugType':
      return { ...emptyConfig(projectDir, a.name, 'attach'), host: a.host || 'localhost', port: a.port || '9229', reconnect: a.restartOnDisconnect !== 'false' };
    case 'JavaScriptTestRunnerJest':
    case 'JavaScriptTestRunnerVitest': {
      const runner = a.type === 'JavaScriptTestRunnerVitest' ? 'vitest' : 'jest';
      const node = childValue(body, 'node-interpreter');
      const scope = childValue(body, 'scope-kind') || 'ALL';
      const names = [...body.matchAll(/<test-name\b([^>]*?)\/?>/g)].map(n => attrs(n[1]).value).filter(Boolean);
      return {
        ...emptyConfig(projectDir, a.name, 'test'), env, runner,
        workingDir: path_(childValue(body, 'working-dir')) || projectDir,
        program: scope === 'ALL' ? '' : path_(childValue(body, 'test-file')),
        // IntelliJ stores the suite/test path; -t matches the full name, so the joined path selects the same test.
        testName: scope === 'SUITE' || scope === 'TEST' ? names.join(' ') : '',
        arguments: childValue(body, `${runner}-options`),
        nodeOptions: childValue(body, 'node-options'),
        nodeRuntime: !node || node === 'project' ? '' : path_(node),
      };
    }
    case 'docker-deploy': {
      const services = [...(/<option\s+name="services"[^>]*>([\s\S]*?)<\/option>\s*(?=<option|<\/settings)/.exec(body)?.[1] ?? '')
        .matchAll(/<option\b([^>]*?)\/?>/g)].map(o => attrs(o[1]).value).filter(Boolean);
      return {
        ...emptyConfig(projectDir, a.name, 'docker'), env,
        program: inProject(optionValue(body, 'sourceFilePath') || 'docker-compose.yml'),
        arguments: optionValue(body, 'commandLineOptions'),
        services: services.join(' '),
      };
    }
    case 'ShConfigurationType': {
      const interpreter = optionValue(body, 'INTERPRETER_PATH');
      return {
        ...emptyConfig(projectDir, a.name, 'script'), env,
        program: path_(optionValue(body, 'SCRIPT_PATH')),
        arguments: optionValue(body, 'SCRIPT_OPTIONS'),
        workingDir: path_(optionValue(body, 'SCRIPT_WORKING_DIRECTORY')),
        // IntelliJ always stores an interpreter; the default shells are what the extension picks anyway.
        interpreter: /^(\/bin\/(ba|z)?sh|)$/.test(interpreter) ? '' : interpreter,
      };
    }
    case 'PythonConfigurationType':
      return {
        ...emptyConfig(projectDir, a.name, 'script'), env,
        program: path_(optionValue(body, 'SCRIPT_NAME')),
        arguments: optionValue(body, 'PARAMETERS'),
        workingDir: path_(optionValue(body, 'WORKING_DIRECTORY')),
        interpreter: optionValue(body, 'IS_MODULE_SDK') === 'true' ? '' : path_(optionValue(body, 'SDK_HOME')),
      };
  }
  return undefined;
}

/** Parses every non-template run configuration of a supported type in an IntelliJ XML file. */
export function parseIntellijXml(xml: string, projectDir: string, home: string, shared: boolean, source = ''): ImportedConfig[] {
  const macros = (v: string) => v
    .replace(/\$PROJECT_DIR\$/g, projectDir)
    .replace(/\$USER_HOME\$/g, home)
    .replace(/^~(?=$|[\\/])/, home);
  const out: ImportedConfig[] = [];
  for (const m of xml.matchAll(/<configuration\b([^>]*?)(\/>|>([\s\S]*?)<\/configuration>)/g)) {
    const a = attrs(m[1]);
    if (a.type === 'CompoundRunConfigurationType' && a.name && a.default !== 'true') {
      const members = [...(m[3] ?? '').matchAll(/<toRun\b([^>]*?)\/?>/g)].map(r => attrs(r[1]).name).filter(Boolean);
      out.push({ ...emptyConfig(projectDir, a.name, 'compound'), projectDir, shared, source, members });
      continue;
    }
    const flutter = a.type === 'FlutterRunConfigurationType';
    if (!SUPPORTED.has(a.type) || a.default === 'true' || !a.name) {
      continue;
    }
    const raw = m[3] ?? '';
    const beforeLaunch = parseIntellijMethod(raw, macros);
    // `<script>`/`<package-json>` inside the before-launch block belong to the steps, not to the configuration.
    const body = withoutMethod(raw);
    const scripts = [...body.matchAll(/<script\b([^>]*?)\/?>/g)].map(s => attrs(s[1]).value).filter(Boolean);
    const env: Record<string, string> = {};
    for (const e of body.matchAll(/<env\b([^>]*?)\/?>/g)) {
      const ea = attrs(e[1]);
      if (ea.name) { env[ea.name] = ea.value ?? ''; }
    }
    const meta = { projectDir, shared, source, beforeLaunch, group: a.folderName ?? '', allowMultiple: a.allowRunningInParallel === 'true' };
    const other = parseOtherType(a, body, env, macros, projectDir);
    if (other) {
      out.push({ ...other, ...meta, name: a.name });
      continue;
    }
    if (flutter) {
      out.push({
        ...emptyConfig(projectDir, a.name, 'flutter'),
        projectDir,
        shared,
        source,
        allowMultiple: a.allowRunningInParallel === 'true',
        program: macros(optionValue(body, 'filePath') || '$PROJECT_DIR$/lib/main.dart'),
        runArgs: optionValue(body, 'additionalArgs'),
        flavor: optionValue(body, 'buildFlavor'),
        attachArgs: optionValue(body, 'attachArgs'),
        env,
        beforeLaunch,
        group: a.folderName ?? '',
      });
      continue;
    }
    const node = childValue(body, 'node-interpreter');
    const pm = childValue(body, 'package-manager');
    out.push({
      ...emptyConfig(projectDir, a.name),
      projectDir,
      shared,
      source,
      allowMultiple: a.allowRunningInParallel === 'true' || a.singleton === 'false',
      packageJson: macros(childValue(body, 'package-json') || '$PROJECT_DIR$/package.json'),
      command: childValue(body, 'command') || 'run',
      scripts: scripts.join(' '),
      arguments: childValue(body, 'arguments'),
      nodeRuntime: !node || node === 'project' ? '' : macros(node),
      nodeOptions: childValue(body, 'node-options'),
      packageManager: !pm || pm === 'project' ? '' : macros(pm),
      env,
      preLaunchTask: '',
      beforeLaunch,
      group: a.folderName ?? '',
    });
  }
  return out;
}

function readDirSafe(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** IntelliJ project dirs (containing `.idea` or `.run`) at `root` and up to `depth` levels below. */
export function findIntellijProjects(root: string, depth = 2): string[] {
  const out: string[] = [];
  const walk = (dir: string, level: number) => {
    const entries = readDirSafe(dir);
    if (entries.some(e => e.isDirectory() && (e.name === '.idea' || e.name === '.run'))) {
      out.push(dir);
    }
    if (level >= depth) { return; }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
        walk(path.join(dir, e.name), level + 1);
      }
    }
  };
  walk(root, 0);
  return out;
}

export function readIntellijConfigs(projectDir: string, home: string): ImportedConfig[] {
  const out: ImportedConfig[] = [];
  const load = (file: string, shared: boolean) => {
    try {
      out.push(...parseIntellijXml(fs.readFileSync(file, 'utf8'), projectDir, home, shared, file));
    } catch { /* unreadable: skip */ }
  };
  load(path.join(projectDir, '.idea', 'workspace.xml'), false);
  for (const dir of [path.join(projectDir, '.idea', 'runConfigurations'), path.join(projectDir, '.run')]) {
    for (const e of readDirSafe(dir)) {
      if (e.isFile() && e.name.endsWith('.xml')) { load(path.join(dir, e.name), true); }
    }
  }
  // Same name in workspace.xml and a project file: keep one.
  return out.filter((c, i) => out.findIndex(o => o.name === c.name) === i);
}
