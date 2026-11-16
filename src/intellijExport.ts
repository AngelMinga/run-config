import * as path from 'node:path';
import { BeforeLaunchStep } from './beforeLaunch';
import { RunConfig, splitArgs } from './model';

/** IntelliJ configuration type of each kind (scripts depend on the file: Python or Shell Script). */
export function intellijType(c: Pick<RunConfig, 'kind' | 'program' | 'runner'>): string {
  switch (c.kind) {
    case 'npm': return 'js.build_tools.npm';
    case 'flutter': return 'FlutterRunConfigurationType';
    case 'compound': return 'CompoundRunConfigurationType';
    case 'node': return 'NodeJSConfigurationType';
    case 'attach': return 'ChromiumRemoteDebugType';
    case 'test': return c.runner === 'vitest' ? 'JavaScriptTestRunnerVitest' : 'JavaScriptTestRunnerJest';
    case 'docker': return 'docker-deploy';
    case 'script': return c.program.toLowerCase().endsWith('.py') ? 'PythonConfigurationType' : 'ShConfigurationType';
  }
}

function esc(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '&#10;');
}

/** IntelliJ path macros: `$PROJECT_DIR$` (the workspace folder) and `$USER_HOME$`. */
export function macroPath(p: string, projectDir: string, home: string): string {
  if (!p) { return ''; }
  const under = (base: string) => {
    const rel = path.relative(base, p);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)) ? rel.split(path.sep).join('/') : undefined;
  };
  const inProject = under(projectDir);
  if (inProject !== undefined) { return inProject ? `$PROJECT_DIR$/${inProject}` : '$PROJECT_DIR$'; }
  const inHome = under(home);
  if (inHome !== undefined) { return inHome ? `$USER_HOME$/${inHome}` : '$USER_HOME$'; }
  return p;
}

/** File name IntelliJ would use for a configuration in `.run/`. */
export function runFileName(name: string): string {
  return `${name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'configuration'}.run.xml`;
}

/**
 * IntelliJ `.run/<name>.run.xml` content for a configuration (what *Store as project file* writes).
 * `all` resolves the type of "Run another configuration" steps. VS Code task steps have no IntelliJ equivalent and are left out.
 */
export function toIntellijXml(c: RunConfig, all: RunConfig[], home: string): string {
  const m = (p: string) => esc(macroPath(p, c.folder, home));
  const v = (tag: string, value: string) => `    <${tag} value="${esc(value)}" />`;
  const opt = (name: string, value: string) => `    <option name="${name}" value="${esc(value)}" />`;
  const envs = () => {
    const entries = Object.entries(c.env);
    return entries.length
      ? ['    <envs>', ...entries.map(([k, val]) => `      <env name="${esc(k)}" value="${esc(val)}" />`), '    </envs>']
      : ['    <envs />'];
  };
  const node = () => v('node-interpreter', c.nodeRuntime ? macroPath(c.nodeRuntime, c.folder, home) : 'project');
  const lines: string[] = [];
  const attrs: string[] = [`name="${esc(c.name)}"`, `type="${intellijType(c)}"`];
  if (c.allowMultiple) { attrs.push('allowRunningInParallel="true"'); }
  if (c.group) { attrs.push(`folderName="${esc(c.group)}"`); }

  switch (c.kind) {
    case 'npm':
      lines.push(v('package-json', macroPath(c.packageJson, c.folder, home)), v('command', c.command || 'run'));
      if (c.scripts) { lines.push('    <scripts>', ...splitArgs(c.scripts).map(s => `      <script value="${esc(s)}" />`), '    </scripts>'); }
      if (c.arguments) { lines.push(v('arguments', c.arguments)); }
      lines.push(node());
      if (c.nodeOptions) { lines.push(v('node-options', c.nodeOptions)); }
      lines.push(v('package-manager', c.packageManager ? macroPath(c.packageManager, c.folder, home) : 'project'), ...envs());
      break;
    case 'flutter':
      attrs.push('factoryName="Flutter"');
      lines.push(opt('filePath', macroPath(c.program, c.folder, home)));
      if (c.runArgs) { lines.push(opt('additionalArgs', c.runArgs)); }
      if (c.attachArgs) { lines.push(opt('attachArgs', c.attachArgs)); }
      if (c.flavor) { lines.push(opt('buildFlavor', c.flavor)); }
      if (Object.keys(c.env).length) { lines.push(...envs()); }
      break;
    case 'compound':
      for (const name of c.members) {
        const target = all.find(o => o.folder === c.folder && o.name === name);
        lines.push(`    <toRun name="${esc(name)}" type="${target ? intellijType(target) : 'js.build_tools.npm'}" />`);
      }
      break;
    case 'node':
      attrs.push(`path-to-js-file="${m(c.program)}"`, `working-dir="${m(c.workingDir || path.dirname(c.program))}"`);
      if (c.nodeOptions) { attrs.push(`node-parameters="${esc(c.nodeOptions)}"`); }
      if (c.arguments) { attrs.push(`application-parameters="${esc(c.arguments)}"`); }
      attrs.push(`node-interpreter="${c.nodeRuntime ? m(c.nodeRuntime) : 'project'}"`);
      lines.push(...envs());
      break;
    case 'attach':
      attrs.push('factoryName="Chromium Remote"', `host="${esc(c.host || 'localhost')}"`, `port="${esc(c.port || '9229')}"`,
        `restartOnDisconnect="${c.reconnect ? 'true' : 'false'}"`);
      break;
    case 'test': {
      const runner = c.runner === 'vitest' ? 'vitest' : 'jest';
      const dir = c.workingDir || c.folder;
      const names = c.testName ? [c.testName] : [];
      lines.push(node());
      if (c.nodeOptions) { lines.push(v('node-options', c.nodeOptions)); }
      lines.push(v(`${runner}-package`, macroPath(path.join(dir, 'node_modules', runner), c.folder, home)), v('working-dir', macroPath(dir, c.folder, home)));
      if (c.arguments) { lines.push(v(`${runner}-options`, c.arguments)); }
      lines.push(...envs(), v('scope-kind', !c.program ? 'ALL' : names.length ? 'TEST' : 'TEST_FILE'));
      if (c.program) { lines.push(v('test-file', macroPath(c.program, c.folder, home))); }
      if (names.length) { lines.push('    <test-names>', ...names.map(n => `      <test-name value="${esc(n)}" />`), '    </test-names>'); }
      break;
    }
    case 'docker': {
      attrs.push('factoryName="docker-compose.yml"', 'server-name="Docker"');
      const rel = path.relative(c.folder, c.program).split(path.sep).join('/');
      lines.push('    <deployment type="docker-compose.yml">', '      <settings>');
      if (c.arguments) { lines.push(`        <option name="commandLineOptions" value="${esc(c.arguments)}" />`); }
      const services = splitArgs(c.services);
      if (services.length) {
        lines.push('        <option name="services">', '          <list>', ...services.map(s => `            <option value="${esc(s)}" />`), '          </list>', '        </option>');
      }
      lines.push(`        <option name="sourceFilePath" value="${esc(rel.startsWith('..') ? c.program : rel)}" />`, '      </settings>', '    </deployment>');
      break;
    }
    case 'script':
      if (intellijType(c) === 'PythonConfigurationType') {
        attrs.push('factoryName="Python"');
        lines.push(opt('INTERPRETER_OPTIONS', ''), opt('PARENT_ENVS', 'true'), ...envs(),
          opt('SDK_HOME', c.interpreter ? macroPath(c.interpreter, c.folder, home) : ''),
          opt('WORKING_DIRECTORY', macroPath(c.workingDir || path.dirname(c.program), c.folder, home)),
          opt('IS_MODULE_SDK', c.interpreter ? 'false' : 'true'),
          opt('SCRIPT_NAME', macroPath(c.program, c.folder, home)), opt('PARAMETERS', c.arguments),
          opt('MODULE_MODE', 'false'), opt('EMULATE_TERMINAL', 'false'));
      } else {
        lines.push(opt('SCRIPT_TEXT', ''), opt('INDEPENDENT_SCRIPT_PATH', 'true'), opt('SCRIPT_PATH', macroPath(c.program, c.folder, home)),
          opt('SCRIPT_OPTIONS', c.arguments), opt('INDEPENDENT_SCRIPT_WORKING_DIRECTORY', 'true'),
          opt('SCRIPT_WORKING_DIRECTORY', macroPath(c.workingDir || path.dirname(c.program), c.folder, home)),
          opt('INDEPENDENT_INTERPRETER_PATH', 'true'), opt('INTERPRETER_PATH', c.interpreter || '/bin/bash'),
          opt('INTERPRETER_OPTIONS', ''), opt('EXECUTE_IN_TERMINAL', 'false'), opt('EXECUTE_SCRIPT_FILE', 'true'), ...envs());
      }
      break;
  }
  const steps = c.beforeLaunch.map(s => stepXml(s, c, all, home)).filter((x): x is string => !!x);
  lines.push(steps.length ? ['    <method v="2">', ...steps, '    </method>'].join('\n') : '    <method v="2" />');
  return [
    '<component name="ProjectRunConfigurationManager">',
    `  <configuration default="false" ${attrs.join(' ')}>`,
    ...lines,
    '  </configuration>',
    '</component>',
    '',
  ].join('\n');
}

function stepXml(s: BeforeLaunchStep, c: RunConfig, all: RunConfig[], home: string): string | undefined {
  switch (s.type) {
    case 'config': {
      const target = all.find(o => o.folder === c.folder && o.name === s.name);
      const type = target ? intellijType(target) : 'js.build_tools.npm';
      return `      <option name="RunConfigurationTask" enabled="true" run_configuration_name="${esc(s.name)}" run_configuration_type="${type}" />`;
    }
    case 'npm':
      return [
        '      <option name="NpmBeforeRunTask" enabled="true">',
        `        <package-json value="${esc(macroPath(s.packageJson, c.folder, home))}" />`,
        '        <command value="run" />',
        `        <scripts>\n          <script value="${esc(s.script)}" />\n        </scripts>`,
        '        <node-interpreter value="project" />',
        '        <envs />',
        '      </option>',
      ].join('\n');
    case 'browser':
      return `      <option name="LaunchBrowser.Before.Run" url="${esc(s.url)}" />`;
    case 'task':
      return undefined;
  }
}
