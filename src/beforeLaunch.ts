/**
 * IntelliJ-style "Before launch" steps: an ordered list run before a configuration starts. Pure (no vscode):
 * parsing/serialising for launch.json and the IntelliJ `<method>` block. Execution lives in beforeLaunchRunner.ts.
 */

export type BeforeLaunchStep =
  /** Runs another run configuration (same folder) and waits until it finishes. */
  | { type: 'config'; name: string }
  /** `<package manager> run <script>` in the package.json's directory; waits, fails on a non-zero exit code. */
  | { type: 'npm'; packageJson: string; script: string }
  /** A VS Code task (`label`, or `source: name` such as `npm: build`); waits, fails on a non-zero exit code. */
  | { type: 'task'; name: string }
  /** Opens a URL in the browser (doesn't wait). */
  | { type: 'browser'; url: string };

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Valid steps of a launch.json `beforeLaunch` array; `expand` resolves paths (variables, `~`). */
export function parseSteps(value: unknown, expand: (p: string) => string = p => p): BeforeLaunchStep[] {
  if (!Array.isArray(value)) { return []; }
  const out: BeforeLaunchStep[] = [];
  for (const v of value) {
    if (!v || typeof v !== 'object') { continue; }
    const o = v as Record<string, unknown>;
    switch (o.type) {
      case 'config': if (str(o.name)) { out.push({ type: 'config', name: str(o.name) }); } break;
      case 'npm': if (str(o.script)) { out.push({ type: 'npm', packageJson: expand(str(o.packageJson)), script: str(o.script) }); } break;
      case 'task': if (str(o.name)) { out.push({ type: 'task', name: str(o.name) }); } break;
      case 'browser': if (str(o.url)) { out.push({ type: 'browser', url: str(o.url) }); } break;
    }
  }
  return out;
}

/** Steps for launch.json; `portable` turns absolute paths into `${workspaceFolder}`/`${userHome}` ones. */
export function serializeSteps(steps: BeforeLaunchStep[], portable: (p: string) => string = p => p): Record<string, string>[] {
  return steps.map((s): Record<string, string> => (s.type === 'npm'
    ? { type: 'npm', packageJson: portable(s.packageJson), script: s.script }
    : { ...s }));
}

/** Steps that can't run: empty fields, or a configuration that would run itself. */
export function invalidStep(steps: BeforeLaunchStep[], selfName: string): BeforeLaunchStep | undefined {
  return steps.find(s =>
    (s.type === 'config' && (!s.name || s.name === selfName))
    || (s.type === 'npm' && (!s.packageJson || !s.script))
    || (s.type === 'task' && !s.name)
    || (s.type === 'browser' && !/^https?:\/\/\S+$/i.test(s.url)));
}

/** One-line description, for logs and the progress notification. */
export function describeStep(s: BeforeLaunchStep): string {
  switch (s.type) {
    case 'config': return s.name;
    case 'npm': return `npm run ${s.script}`;
    case 'task': return s.name;
    case 'browser': return s.url;
  }
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) {
    out[m[1]] = m[2].replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }
  return out;
}

/**
 * Before-launch steps of an IntelliJ configuration body (`<method v="2">…</method>`): RunConfigurationTask,
 * NpmBeforeRunTask, LaunchBrowser.Before.Run. `macros` expands `$PROJECT_DIR$` etc. Disabled steps are skipped.
 */
export function parseIntellijMethod(body: string, macros: (v: string) => string): BeforeLaunchStep[] {
  const method = /<method\b[^>]*>([\s\S]*?)<\/method>/.exec(body)?.[1];
  if (!method) { return []; }
  const out: BeforeLaunchStep[] = [];
  for (const m of method.matchAll(/<option\b([^>]*?)(?:\/>|>([\s\S]*?)<\/option>)/g)) {
    const a = attrs(m[1]);
    if (a.enabled === 'false') { continue; }
    const inner = m[2] ?? '';
    if (a.name === 'RunConfigurationTask' && a.run_configuration_name) {
      out.push({ type: 'config', name: a.run_configuration_name });
    } else if (a.name === 'NpmBeforeRunTask') {
      const pkg = /<package-json\b([^>]*?)\/?>/.exec(inner);
      const script = /<script\b([^>]*?)\/?>/.exec(inner);
      const scriptName = script ? attrs(script[1]).value : '';
      if (scriptName) {
        out.push({ type: 'npm', packageJson: macros(pkg ? attrs(pkg[1]).value ?? '' : '$PROJECT_DIR$/package.json'), script: scriptName });
      }
    } else if (a.name === 'LaunchBrowser.Before.Run' && a.url) {
      out.push({ type: 'browser', url: a.url });
    }
  }
  return out;
}

/** The configuration body without its `<method>` block (whose `<script>`/`<env>` tags belong to the steps). */
export function withoutMethod(body: string): string {
  return body.replace(/<method\b[^>]*>[\s\S]*?<\/method>/g, '');
}
