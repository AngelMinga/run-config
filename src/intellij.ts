import * as fs from 'node:fs';
import * as path from 'node:path';
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

/** Parses every non-template npm and Flutter run configuration in an IntelliJ XML file. */
export function parseIntellijXml(xml: string, projectDir: string, home: string, shared: boolean, source = ''): ImportedConfig[] {
  const macros = (v: string) => v
    .replace(/\$PROJECT_DIR\$/g, projectDir)
    .replace(/\$USER_HOME\$/g, home)
    .replace(/^~(?=$|[\\/])/, home);
  const out: ImportedConfig[] = [];
  for (const m of xml.matchAll(/<configuration\b([^>]*?)(\/>|>([\s\S]*?)<\/configuration>)/g)) {
    const a = attrs(m[1]);
    const flutter = a.type === 'FlutterRunConfigurationType';
    if ((a.type !== 'js.build_tools.npm' && !flutter) || a.default === 'true' || !a.name) {
      continue;
    }
    const body = m[3] ?? '';
    const scripts = [...body.matchAll(/<script\b([^>]*?)\/?>/g)].map(s => attrs(s[1]).value).filter(Boolean);
    const env: Record<string, string> = {};
    for (const e of body.matchAll(/<env\b([^>]*?)\/?>/g)) {
      const ea = attrs(e[1]);
      if (ea.name) { env[ea.name] = ea.value ?? ''; }
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
        env,
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
