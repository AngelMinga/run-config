import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { detect, Detection } from './detect';
import { DeviceService } from './devices';
import { deviceIcon } from './flutter';
import { EditorPanel } from './editor';
import { findIntellijProjects, ImportedConfig, readIntellijConfigs } from './intellij';
import { ATTACH_TYPE, buildAttachLaunch, buildDockerLaunch, buildNodeFileLaunch, buildTestLaunch, DOCKER_TYPE, NODE_TYPE, TEST_TYPE } from './model';
import { anchorPath, applyTemplate, emptyConfig, buildFlutterLaunch, buildNodeLaunch, buildScriptLaunch, COMPOUND_TYPE, configKey, DEBUG_TYPE, expandCompound, FLUTTER_TYPE, fromLaunchEntry, RunConfig, SCRIPT_TYPE, toLaunchEntry } from './model';
import { RunsModel, splitKey } from './runs';
import { RunAnything } from './runAnything';
import { runBeforeLaunch, BeforeLaunchHost } from './beforeLaunchRunner';
import { mergeEnv, parseDotenv } from './dotenv';
import { runFileName, toIntellijXml } from './intellijExport';
import { dartEntries, dockerEntries, EntryPoint, testEntries, packageJsonEntries, pythonEntries, shellEntries } from './entryPoints';
import { RunViewProvider } from './runView';
import { ConfigNode, ServicesProvider } from './services';
import { ScriptDebugAdapter } from './scriptAdapter';
import { findTestRunner, nearestPackageDir } from './project';
import { ancestors, flutterRoot, projectNode, ResolveContext, resolveNode, resolvePackageManager } from './project';
import { ConfigStore, launchJsonPath, StoredConfig, Templates } from './store';

const home = os.homedir();
const t = vscode.l10n.t;

export type Selection =
  | { kind: 'npm' | 'launch'; folder: string; name: string }
  | { kind: 'currentFile' };

const SELECTED_KEY = 'runConfigurations.selected';
const IMPORT_OFFERED_KEY = 'runConfigurations.importOffered';
const RUNNABLE_FILE = /\.((m|c)?(j|t)s|dart)$/i;
const DART_EXTENSION = 'Dart-Code.dart-code';
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/i;
const COMPOSE_FILE = /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/i;

/** With the Run window on, our sessions don't open the Debug Console: their output is in the Run window. */
function quietConsole(launch: Record<string, unknown>): void {
  if (launch.console !== 'integratedTerminal' && vscode.workspace.getConfiguration('runConfigurations').get<boolean>('runWindow', true)) {
    launch.internalConsoleOptions = 'neverOpen';
  }
}
const FLUTTER_EXTENSION = 'Dart-Code.flutter';

/** Cached node / package manager detection (a few `--version` calls). */
export class Runtimes {
  private pending?: Promise<Detection>;
  get(refresh = false): Promise<Detection> {
    if (refresh || !this.pending) {
      this.pending = detect({ home, env: process.env, platform: process.platform });
    }
    return this.pending;
  }

  async context(): Promise<ResolveContext> {
    return {
      detection: await this.get(),
      defaultNode: vscode.workspace.getConfiguration('runConfigurations').get<string>('defaultNodeRuntime', '').replace(/^~(?=$|[\\/])/, home),
      env: process.env,
      platform: process.platform,
    };
  }
}

/** Tracks the top-level debug sessions started for each npm configuration. */
class Sessions implements vscode.Disposable {
  private readonly byKey = new Map<string, Set<vscode.DebugSession>>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.debug.onDidStartDebugSession(s => {
        const key = s.configuration.__runConfigKey;
        if (typeof key === 'string' && !s.parentSession) {
          if (!this.byKey.has(key)) { this.byKey.set(key, new Set()); }
          this.byKey.get(key)!.add(s);
          this.changed.fire();
        }
      }),
      vscode.debug.onDidTerminateDebugSession(s => {
        let ours = false;
        for (const [key, set] of this.byKey) {
          if (set.delete(s)) {
            ours = true;
            if (!set.size) { this.byKey.delete(key); }
          }
        }
        // Other extensions' sessions don't change the status bar.
        if (ours) { this.changed.fire(); }
      }),
    );
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this.changed.dispose();
  }

  running(key: string): vscode.DebugSession[] {
    return [...(this.byKey.get(key) ?? [])];
  }

  any(): boolean {
    return this.byKey.size > 0;
  }

  /** Stops the sessions of `key` and waits (up to 5 s) until they are gone. */
  async stop(key: string): Promise<void> {
    const sessions = this.running(key);
    if (!sessions.length) { return; }
    await Promise.all(sessions.map(s => vscode.debug.stopDebugging(s)));
    for (let i = 0; i < 50 && this.running(key).length; i++) {
      await new Promise(r => setTimeout(r, 100));
    }
  }
}

/** Read-only view of the extension's state, for end-to-end tests. */
export interface TestApi {
  runs(): { key: string; name: string; running: boolean; exitCode?: number; text: string }[];
  configs(): RunConfig[];
  /** Same paths as the dialog's Apply and Run Anything's Enter. */
  save(configs: StoredConfig[], templates?: Templates): Promise<void>;
  runCommand(command: string): Promise<void>;
}

export function activate(context: vscode.ExtensionContext): TestApi {
  const store = new ConfigStore(context.workspaceState);
  const runtimes = new Runtimes();
  const sessions = new Sessions();
  // Flutter project roots: workspace folders with pubspec.yaml plus the roots of Flutter configurations.
  const flutterProjectRoots = (): string[] => {
    const roots = new Set(store.folders().filter(f => fs.existsSync(path.join(f, 'pubspec.yaml'))));
    for (const c of store.list()) {
      if (c.kind !== 'flutter') { continue; }
      const root = flutterRoot(c.program, c.folder);
      if (root) { roots.add(root); }
    }
    return [...roots];
  };
  const devices = new DeviceService(context.workspaceState, flutterProjectRoots);
  context.subscriptions.push(devices);
  context.subscriptions.push(store, sessions);

  // ---------- selection ----------
  const getSelection = (): Selection | undefined => {
    const sel = context.workspaceState.get<Selection>(SELECTED_KEY);
    if (sel?.kind === 'currentFile') { return sel; }
    if (sel?.kind === 'npm' && store.find(sel.folder, sel.name)) { return sel; }
    if (sel?.kind === 'launch' && store.others().some(o => o.folder === sel.folder && o.name === sel.name)) { return sel; }
    const first = store.list()[0];
    return first ? { kind: 'npm', folder: first.folder, name: first.name } : undefined;
  };
  const setSelection = async (sel: Selection | undefined) => {
    await context.workspaceState.update(SELECTED_KEY, sel);
    refreshUi();
  };

  // ---------- debug type: npm-run → node ----------
  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, {
    provideDebugConfigurations: () => [{
      type: DEBUG_TYPE, request: 'launch', name: 'npm start', packageJson: '${workspaceFolder}/package.json', command: 'start',
    }],
    resolveDebugConfiguration: async (folder, config) => {
      if (config.type !== DEBUG_TYPE) { return config; }
      const folderPath = folder?.uri.fsPath ?? store.folders()[0] ?? home;
      const c = fromLaunchEntry(config, folderPath, home, true);
      if (!c.name) { c.name = config.name || 'npm'; }
      if (!loadEnvFile(c)) { return undefined; }
      if (!fs.existsSync(c.packageJson)) {
        void showConfigError(t('package.json not found: {0}', c.packageJson), c);
        return undefined;
      }
      const ctx = await runtimes.context();
      const node = resolveNode(c, ctx);
      if (c.nodeRuntime && !fs.existsSync(c.nodeRuntime)) {
        void showConfigError(t('Node runtime not found: {0}', c.nodeRuntime), c);
        return undefined;
      }
      if (!(await confirmRerun(c, config))) { return undefined; }
      if (!(await runBeforeLaunch(c, beforeHost))) { return undefined; }
      if (!c.allowMultiple) {
        await sessions.stop(configKey(c));
      }
      const output = vscode.workspace.getConfiguration('runConfigurations').get<string>('npmConsole') === 'internalConsole'
        ? 'internalConsole' : 'integratedTerminal';
      const launch = buildNodeLaunch(c, { node, packageManager: resolvePackageManager(c, node, ctx) }, process.env, process.platform, output);
      if (config.noDebug) { launch.noDebug = true; }
      quietConsole(launch);
      return launch as vscode.DebugConfiguration;
    },
  }));

  // ---------- debug type: flutter-run → dart (Dart-Code) ----------
  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider(FLUTTER_TYPE, {
    provideDebugConfigurations: () => [{
      type: FLUTTER_TYPE, request: 'launch', name: 'main.dart', program: '${workspaceFolder}/lib/main.dart',
    }],
    resolveDebugConfiguration: async (folder, config) => {
      if (config.type !== FLUTTER_TYPE) { return config; }
      const folderPath = folder?.uri.fsPath ?? store.folders()[0] ?? home;
      const c = fromLaunchEntry(config, folderPath, home, true);
      if (!c.name) { c.name = config.name || 'Flutter'; }
      if (!loadEnvFile(c)) { return undefined; }
      if (!vscode.extensions.getExtension(DART_EXTENSION)) {
        const install = t('Install Flutter Extension');
        if (await vscode.window.showErrorMessage(t('Running Flutter configurations needs the Dart and Flutter extensions.'), install) === install) {
          await vscode.commands.executeCommand('workbench.extensions.search', FLUTTER_EXTENSION);
        }
        return undefined;
      }
      if (!fs.existsSync(c.program)) {
        void showConfigError(t('Dart entrypoint not found: {0}', c.program), c);
        return undefined;
      }
      const root = flutterRoot(c.program, c.folder);
      if (!root) {
        void showConfigError(t('No pubspec.yaml found above {0}', c.program), c);
        return undefined;
      }
      const attach = config.request === 'attach' || config.attach === true;
      // Attaching connects to an app that is already running: nothing to prepare.
      if (!attach && !(await confirmRerun(c, config))) { return undefined; }
      if (!attach && !(await runBeforeLaunch(c, beforeHost))) { return undefined; }
      if (!c.allowMultiple && !attach) {
        await sessions.stop(configKey(c));
      }
      const deviceId = typeof config.deviceId === 'string' && config.deviceId ? config.deviceId : devices.selected()?.id;
      const launch = buildFlutterLaunch(c, root, { attach, deviceId });
      // Attaching connects to the running app: never stop it, and track it apart from `flutter run`.
      if (attach) { launch.__runConfigKey = `${configKey(c)}::attach`; }
      if (config.noDebug) { launch.noDebug = true; }
      quietConsole(launch);
      return launch as vscode.DebugConfiguration;
    },
  }));

  // ---------- debug type: script-run → inline adapter (Python, shell…) ----------
  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider(SCRIPT_TYPE, {
    provideDebugConfigurations: () => [{
      type: SCRIPT_TYPE, request: 'launch', name: 'script', script: '${workspaceFolder}/script.py',
    }],
    resolveDebugConfiguration: async (folder, config) => {
      if (config.type !== SCRIPT_TYPE || config.__resolvedScript) { return config; }
      const folderPath = folder?.uri.fsPath ?? store.folders()[0] ?? home;
      const c = fromLaunchEntry(config, folderPath, home, true);
      if (!c.name) { c.name = config.name || 'script'; }
      if (!loadEnvFile(c)) { return undefined; }
      if (!c.program || !fs.existsSync(c.program)) {
        void showConfigError(t('Script not found: {0}', c.program || '—'), c);
        return undefined;
      }
      if (c.workingDir && !fs.existsSync(c.workingDir)) {
        void showConfigError(t('Working directory not found: {0}', c.workingDir), c);
        return undefined;
      }
      if (!(await confirmRerun(c, config))) { return undefined; }
      if (!(await runBeforeLaunch(c, beforeHost))) { return undefined; }
      if (!c.allowMultiple) {
        await sessions.stop(configKey(c));
      }
      const launch = buildScriptLaunch(c, fs.existsSync);
      if (config.noDebug) { launch.noDebug = true; }
      quietConsole(launch);
      return launch as vscode.DebugConfiguration;
    },
  }));
  context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory(SCRIPT_TYPE, {
    createDebugAdapterDescriptor: () => new vscode.DebugAdapterInlineImplementation(new ScriptDebugAdapter()),
  }));

  // ---------- debug type: compound-run → starts its members (IntelliJ's Compound) ----------
  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider(COMPOUND_TYPE, {
    resolveDebugConfiguration: async (folder, config) => {
      if (config.type !== COMPOUND_TYPE) { return config; }
      const folderPath = folder?.uri.fsPath ?? store.folders()[0] ?? home;
      await launchCompound(fromLaunchEntry(config, folderPath, home, true), !config.noDebug);
      // The compound itself has no session: its members do.
      return undefined;
    },
  }));

  /** Loads the configuration's env file into `c.env` (its own variables win). False (error shown) if unreadable. */
  const loadEnvFile = (c: RunConfig): boolean => {
    if (!c.envFile) { return true; }
    let text: string;
    try {
      text = fs.readFileSync(c.envFile, 'utf8');
    } catch {
      void showConfigError(t('Env file not found: {0}', c.envFile), c);
      return false;
    }
    c.env = mergeEnv(parseDotenv(text, process.env), c.env);
    return true;
  };

  /** IntelliJ's "Stop and Rerun?" when the configuration is already running (unless multiple instances are allowed). */
  const askRerun = async (name: string): Promise<boolean> => {
    if (!vscode.workspace.getConfiguration('runConfigurations').get<boolean>('confirmRerun', true)) { return true; }
    const rerun = t('Stop and Rerun');
    const always = t("Stop and Rerun, Don't Ask Again");
    const answer = await vscode.window.showWarningMessage(t('"{0}" is running. Stop it and run it again?', name), { modal: true }, rerun, always);
    if (answer === always) {
      await vscode.workspace.getConfiguration('runConfigurations').update('confirmRerun', false, vscode.ConfigurationTarget.Global);
    }
    return answer === rerun || answer === always;
  };
  const confirmRerun = async (c: RunConfig, config: vscode.DebugConfiguration): Promise<boolean> => {
    if (c.allowMultiple || config.__confirmed || !sessions.running(configKey(c)).length) { return true; }
    return askRerun(c.name);
  };

  /**
   * Resolver shared by Node.js, Attach, Test and Docker: env file, Stop and Rerun?, before launch, single instance,
   * then `build` turns the configuration into the real launch (undefined: error already shown).
   */
  const registerRunType = (type: string, build: (c: RunConfig, config: vscode.DebugConfiguration) => Promise<Record<string, unknown> | undefined>) => {
    context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider(type, {
      resolveDebugConfiguration: async (folder, config) => {
        if (config.type !== type) { return config; }
        const folderPath = folder?.uri.fsPath ?? store.folders()[0] ?? home;
        const c = fromLaunchEntry(config, folderPath, home, true);
        if (!c.name) { c.name = config.name || type; }
        if (!loadEnvFile(c)) { return undefined; }
        if (!(await confirmRerun(c, config))) { return undefined; }
        if (!(await runBeforeLaunch(c, beforeHost))) { return undefined; }
        if (!c.allowMultiple) { await sessions.stop(configKey(c)); }
        const launch = await build(c, config);
        if (!launch) { return undefined; }
        // Attaching is always debugging.
        if (config.noDebug && c.kind !== 'attach') { launch.noDebug = true; }
        quietConsole(launch);
        return launch as vscode.DebugConfiguration;
      },
    }));
  };
  const consoleSetting = () => (vscode.workspace.getConfiguration('runConfigurations').get<string>('npmConsole') === 'internalConsole'
    ? 'internalConsole' as const : 'integratedTerminal' as const);
  const nodeFor = async (c: RunConfig, dir: string) =>
    c.nodeRuntime || projectNode({ packageJson: path.join(dir, 'package.json'), folder: c.folder }, await runtimes.context()).node?.path;

  registerRunType(NODE_TYPE, async c => {
    if (!c.program || !fs.existsSync(c.program)) {
      void showConfigError(t('JavaScript file not found: {0}', c.program || '—'), c);
      return undefined;
    }
    return buildNodeFileLaunch(c, await nodeFor(c, c.workingDir || path.dirname(c.program)), process.env, process.platform, consoleSetting());
  });
  registerRunType(ATTACH_TYPE, async c => buildAttachLaunch(c));
  registerRunType(TEST_TYPE, async (c, config) => {
    if (c.program && !fs.existsSync(c.program)) {
      void showConfigError(t('Test file not found: {0}', c.program), c);
      return undefined;
    }
    const projectDir = c.workingDir || nearestPackageDir(c.program ? path.dirname(c.program) : c.folder, c.folder) || c.folder;
    const runner = findTestRunner(projectDir, c.folder, c.runner);
    if (!runner) {
      void showConfigError(t('Neither Jest nor Vitest was found in the node_modules of {0}.', projectDir), c);
      return undefined;
    }
    return buildTestLaunch(c, runner, projectDir, await nodeFor(c, projectDir), !config.noDebug, process.env, process.platform, consoleSetting());
  });
  registerRunType(DOCKER_TYPE, async c => {
    if (!c.program || !fs.existsSync(c.program)) {
      void showConfigError(t('Compose file not found: {0}', c.program || '—'), c);
      return undefined;
    }
    return buildDockerLaunch(c);
  });

  const showConfigError = async (message: string, c: RunConfig) => {
    const edit = t('Edit Configuration');
    if (await vscode.window.showErrorMessage(message, edit) === edit) {
      openEditor({ kind: 'npm', folder: c.folder, name: c.name });
    }
  };

  // ---------- running ----------
  const wsFolder = (fsPath: string) => vscode.workspace.workspaceFolders?.find(f => f.uri.fsPath === fsPath);

  /** `confirmed`: the user already chose to rerun (Rerun buttons, compounds ask once for all members). */
  const launch = async (sel: Selection | undefined, debug: boolean, attach = false, confirmed = false): Promise<void> => {
    if (!sel) {
      const picked = await pick();
      if (!picked) { return; }
      sel = picked;
    }
    const options: vscode.DebugSessionOptions = { noDebug: !debug };
    if (sel.kind === 'currentFile') {
      return launchCurrentFile(options);
    }
    if (sel.kind === 'launch') {
      await vscode.debug.startDebugging(wsFolder(sel.folder), sel.name, options);
      return;
    }
    const c = store.find(sel.folder, sel.name);
    if (!c) {
      void vscode.window.showWarningMessage(t('Run configuration "{0}" no longer exists.', sel.name));
      return;
    }
    if (c.kind === 'compound') {
      return launchCompound(c, debug, confirmed);
    }
    if (attach && c.kind !== 'flutter') {
      void vscode.window.showWarningMessage(t('Attach is only available for Flutter configurations.'));
      return;
    }
    const entry = { ...toLaunchEntry(c, home), ...(attach ? { attach: true } : {}), ...(confirmed ? { __confirmed: true } : {}) };
    // Attach always runs with the debugger: there is nothing to run "without debugging".
    await vscode.debug.startDebugging(wsFolder(c.folder), entry as vscode.DebugConfiguration, attach ? {} : options);
  };

  /** Members of a compound: stored configurations or other launch.json entries of its folder. */
  const compoundTargets = (c: RunConfig) => {
    const others = store.others().filter(o => o.folder === c.folder);
    return expandCompound(c, name => store.find(c.folder, name) ?? (others.some(o => o.name === name) ? { kind: 'launch' } : undefined));
  };

  const launchCompound = async (c: RunConfig, debug: boolean, confirmed = false) => {
    const { names, missing } = compoundTargets(c);
    // One question for the whole compound, not one per running member.
    const running = names.filter(n => {
      const m = store.find(c.folder, n);
      return m && !m.allowMultiple && sessions.running(configKey(m)).length;
    });
    if (running.length && !confirmed && !(await askRerun(c.name))) { return; }
    if (missing.length) {
      void vscode.window.showWarningMessage(t('Compound "{0}": configurations not found: {1}', c.name, missing.join(', ')));
    }
    if (!names.length) {
      void showConfigError(t('Compound "{0}" has no configurations to run.', c.name), c);
      return;
    }
    // All at once, like IntelliJ.
    await Promise.all(names.map(name => launch(
      store.find(c.folder, name) ? { kind: 'npm', folder: c.folder, name } : { kind: 'launch', folder: c.folder, name }, debug, false, true)));
  };

  /** Keys whose sessions belong to a configuration (a compound: its members'). */
  const sessionKeys = (c: RunConfig): string[] => (c.kind === 'compound'
    ? compoundTargets(c).names.map(name => configKey({ folder: c.folder, name }))
    : [configKey(c)]);
  const isRunning = (c: RunConfig) => sessionKeys(c).some(k => sessions.running(k).length > 0);
  const stopConfig = async (c: RunConfig) => { await Promise.all(sessionKeys(c).map(k => sessions.stop(k))); };

  const launchCurrentFile = async (options: vscode.DebugSessionOptions) => {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || doc.uri.scheme !== 'file' || !RUNNABLE_FILE.test(doc.uri.fsPath)) {
      void vscode.window.showWarningMessage(t('Open a JavaScript, TypeScript or Dart file to run it as "Current File".'));
      return;
    }
    const file = doc.uri.fsPath;
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    if (file.endsWith('.dart')) {
      const root = flutterRoot(file, folder?.uri.fsPath ?? path.dirname(file)) ?? folder?.uri.fsPath ?? path.dirname(file);
      await vscode.debug.startDebugging(folder, { type: 'dart', request: 'launch', name: path.basename(file), program: file, cwd: root }, options);
      return;
    }
    const node = projectNode({ packageJson: path.join(path.dirname(file), 'package.json'), folder: folder?.uri.fsPath ?? path.dirname(file) },
      await runtimes.context()).node?.path;
    await vscode.debug.startDebugging(folder, {
      type: 'node',
      request: 'launch',
      name: path.basename(file),
      program: file,
      cwd: folder?.uri.fsPath ?? path.dirname(file),
      console: vscode.workspace.getConfiguration('runConfigurations').get<string>('npmConsole') === 'internalConsole'
        ? 'internalConsole' : 'integratedTerminal',
      skipFiles: ['<node_internals>/**'],
      ...(node ? { runtimeExecutable: node } : {}),
    }, options);
  };

  const stop = async () => {
    const sel = getSelection();
    const c = sel?.kind === 'npm' ? store.find(sel.folder, sel.name) : undefined;
    if (c && isRunning(c)) {
      await stopConfig(c);
      return;
    }
    await vscode.commands.executeCommand('workbench.action.debug.stop');
  };

  // ---------- picker ----------
  interface PickItem extends vscode.QuickPickItem { sel?: Selection; action?: 'edit' | 'import' | 'device' }
  const runButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('play'), tooltip: t('Run') };
  const debugButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('debug-alt'), tooltip: t('Debug') };
  const attachButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('plug'), tooltip: t('Flutter Attach') };
  const saveButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('save'), tooltip: t('Save Configuration') };

  const pick = (): Promise<Selection | undefined> => new Promise(resolve => {
    const multiRoot = store.folders().length > 1;
    const folderName = (f: string) => (multiRoot ? path.basename(f) : undefined);
    const current = getSelection();
    const same = (s: Selection) => JSON.stringify(s) === JSON.stringify(current);
    const items: PickItem[] = [];
    const all = store.list();
    if (!all.length) {
      const importable = intellijCandidates().length;
      if (importable) {
        items.push({ label: `$(cloud-download) ${t('Import {0} configuration(s) from IntelliJ', importable)}`, action: 'import' });
      }
    }
    for (const [kind, title] of KIND_GROUPS.map(([k, label]) => [k, label()] as const)) {
      const group = all.filter(c => c.kind === kind);
      if (!group.length) { continue; }
      items.push({ label: title, kind: vscode.QuickPickItemKind.Separator });
      for (const c of group) {
        const sel: Selection = { kind: 'npm', folder: c.folder, name: c.name };
        const running = isRunning(c);
        items.push({
          label: `$(${running ? 'debug-restart' : kindIcon(c.kind)}) ${c.name}`,
          description: (c.group ? `${c.group} › ` : '') + (c.temporary ? `${t('temporary')} · ` : '') + describe(c)
            + (folderName(c.folder) ? ` · ${folderName(c.folder)}` : ''),
          detail: running ? t('Running') : undefined,
          picked: same(sel),
          sel,
          buttons: [
            runButton, debugButton,
            ...(c.kind === 'flutter' ? [attachButton] : []),
            ...(c.temporary ? [saveButton] : []),
          ],
        });
      }
    }
    const others = store.others();
    if (others.length) {
      items.push({ label: 'launch.json', kind: vscode.QuickPickItemKind.Separator });
      for (const o of others) {
        const sel: Selection = { kind: 'launch', folder: o.folder, name: o.name };
        items.push({
          label: `$(${o.compound ? 'run-all' : 'debug-alt-small'}) ${o.name}`,
          description: o.type + (folderName(o.folder) ? ` · ${folderName(o.folder)}` : ''),
          sel,
          buttons: [runButton, debugButton],
        });
      }
    }
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: `$(file-code) ${t('Current File')}`, sel: { kind: 'currentFile' }, buttons: [runButton, debugButton] });
    if (all.some(c => c.kind === 'flutter') || isFlutterWorkspace()) {
      const eff = devices.effective();
      items.push({
        label: `$(${eff.device ? deviceIcon(eff.device.platform) : 'device-mobile'}) ${t('Select Flutter Device…')}`,
        description: eff.device
          ? (eff.source === 'dart' ? `${eff.device.name} · ${t("Flutter extension's device")}` : eff.device.name)
          : t('No device'),
        action: 'device',
      });
    }
    items.push({ label: `$(gear) ${t('Edit Configurations…')}`, action: 'edit' });
    items.push({ label: `$(cloud-download) ${t('Import from IntelliJ…')}`, action: 'import' });

    const qp = vscode.window.createQuickPick<PickItem>();
    qp.items = items;
    qp.placeholder = t('Select a run configuration');
    qp.matchOnDescription = true;
    const active = items.find(i => i.sel && same(i.sel));
    if (active) { qp.activeItems = [active]; }
    let done = false;
    const finish = (value: Selection | undefined) => {
      if (!done) { done = true; resolve(value); }
      qp.hide();
    };
    qp.onDidTriggerItemButton(async e => {
      if (!e.item.sel) { return; }
      const sel = e.item.sel;
      if (e.button === saveButton && sel.kind === 'npm') {
        await saveTemporary(sel.folder, sel.name);
        finish(undefined);
        return;
      }
      finish(undefined);
      await setSelection(sel);
      await launch(sel, e.button === debugButton, e.button === attachButton);
    });
    qp.onDidAccept(async () => {
      const item = qp.selectedItems[0];
      if (item?.action === 'edit') { finish(undefined); openEditor(getSelection()); return; }
      if (item?.action === 'import') { finish(undefined); await importIntellij(false); return; }
      if (item?.action === 'device') { finish(undefined); await devices.pick(); return; }
      if (item?.sel) { await setSelection(item.sel); finish(item.sel); }
    });
    qp.onDidHide(() => { finish(undefined); qp.dispose(); });
    qp.show();
  });

  // ---------- IntelliJ import ----------
  const intellijCandidates = (): { folder: string; config: ImportedConfig }[] => {
    const out: { folder: string; config: ImportedConfig }[] = [];
    for (const folder of store.folders()) {
      const projects = new Set(findIntellijProjects(folder));
      // The workspace folder may be a sub-folder of an IntelliJ project.
      for (const dir of ancestors(path.dirname(folder), home)) {
        if (dir !== home && (fs.existsSync(path.join(dir, '.idea')) || fs.existsSync(path.join(dir, '.run')))) {
          projects.add(dir);
          break;
        }
      }
      for (const project of projects) {
        for (const config of readIntellijConfigs(project, home)) {
          const rel = path.relative(folder, anchorPath({ ...config, folder: config.projectDir }));
          if (!rel.startsWith('..') && !path.isAbsolute(rel)) { out.push({ folder, config }); }
        }
      }
    }
    return out;
  };

  /** Two configurations run the same thing (import de-duplication, ▷ reuse). */
  const sameRun = (a: RunConfig, b: RunConfig): boolean => {
    if (a.kind !== b.kind || a.folder !== b.folder) { return false; }
    switch (a.kind) {
      case 'flutter': return a.program === b.program && a.runArgs === b.runArgs && a.flavor === b.flavor;
      case 'script': return a.program === b.program && a.arguments === b.arguments && a.interpreter === b.interpreter;
      case 'node': return a.program === b.program && a.arguments === b.arguments;
      case 'attach': return a.host === b.host && a.port === b.port;
      case 'test': return a.program === b.program && a.testName === b.testName && (a.workingDir || '') === (b.workingDir || '');
      case 'docker': return a.program === b.program && a.services === b.services && a.command === b.command;
      case 'compound': return a.name === b.name;
      default: return a.packageJson === b.packageJson && a.command === b.command && a.scripts === b.scripts && a.arguments === b.arguments;
    }
  };

  const importIntellij = async (fromPrompt: boolean): Promise<number> => {
    const existing = store.list();
    const next: StoredConfig[] = [...existing];
    let added = 0;
    for (const { folder, config } of intellijCandidates()) {
      const { projectDir, source: _source, ...fields } = config;
      const c: StoredConfig = { ...fields, folder };
      if (next.some(o => sameRun(o, c))) { continue; }
      const taken = (n: string) => next.some(o => o.folder === folder && o.name === n);
      if (taken(c.name)) {
        const base = `${c.name} (${path.basename(projectDir)})`;
        c.name = base;
        for (let i = 2; taken(c.name); i++) { c.name = `${base} ${i}`; }
      }
      next.push(c);
      added++;
    }
    if (added) {
      await store.saveAll(next);
      if (!getSelection()) {
        const first = store.list()[0];
        if (first) { await setSelection({ kind: 'npm', folder: first.folder, name: first.name }); }
      }
      void vscode.window.showInformationMessage(t('Imported {0} run configuration(s) from IntelliJ.', added));
    } else if (!fromPrompt) {
      void vscode.window.showInformationMessage(t('No new IntelliJ run configurations found in this workspace.'));
    }
    return added;
  };

  const offerImport = async () => {
    if (!vscode.workspace.getConfiguration('runConfigurations').get<boolean>('offerIntellijImport', true)
      || context.workspaceState.get<boolean>(IMPORT_OFFERED_KEY) || store.list().length) {
      return;
    }
    const count = intellijCandidates().length;
    if (!count) { return; }
    await context.workspaceState.update(IMPORT_OFFERED_KEY, true);
    const yes = t('Import');
    const answer = await vscode.window.showInformationMessage(
      t('Found {0} IntelliJ run configuration(s) in this workspace. Import them?', count), yes, t('Not now'));
    if (answer === yes) { await importIntellij(true); }
  };

  // ---------- editor ----------
  const openEditor = (sel?: Selection) => {
    EditorPanel.show(context, store, runtimes, {
      selected: sel?.kind === 'npm' ? sel : undefined,
      run: async (folder, name, debug) => {
        const s: Selection = { kind: 'npm', folder, name };
        await setSelection(s);
        await launch(s, debug);
      },
      select: async (folder, name) => setSelection({ kind: 'npm', folder, name }),
      openLaunchJson: async (folder, name) => openLaunchJson(folder, name),
    });
  };

  const openLaunchJson = async (folder: string, name?: string) => {
    const uri = vscode.Uri.file(launchJsonPath(folder));
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);
    if (name) {
      const offset = doc.getText().indexOf(JSON.stringify(name));
      if (offset >= 0) {
        const pos = doc.positionAt(offset);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    }
  };

  // ---------- status bar ----------
  const deviceItem = vscode.window.createStatusBarItem('runConfigurations.device', vscode.StatusBarAlignment.Left, 51);
  deviceItem.name = t('Flutter Device');
  deviceItem.command = 'runConfigurations.selectDevice';
  context.subscriptions.push(deviceItem);
  const selector = vscode.window.createStatusBarItem('runConfigurations.selector', vscode.StatusBarAlignment.Left, 50);
  const runItem = vscode.window.createStatusBarItem('runConfigurations.run', vscode.StatusBarAlignment.Left, 49);
  const debugItem = vscode.window.createStatusBarItem('runConfigurations.debug', vscode.StatusBarAlignment.Left, 48);
  const stopItem = vscode.window.createStatusBarItem('runConfigurations.stop', vscode.StatusBarAlignment.Left, 47);
  selector.name = t('Run Configuration');
  runItem.name = t('Run');
  debugItem.name = t('Debug');
  stopItem.name = t('Stop');
  selector.command = 'runConfigurations.select';
  runItem.command = 'runConfigurations.run';
  debugItem.command = 'runConfigurations.debug';
  stopItem.command = 'runConfigurations.stop';
  runItem.text = '$(play)';
  debugItem.text = '$(debug-alt)';
  stopItem.text = '$(debug-stop)';
  context.subscriptions.push(selector, runItem, debugItem, stopItem);

  /** A workspace folder is a Flutter/Dart project (pubspec.yaml at its root) or holds Flutter configurations. */
  const isFlutterWorkspace = () => store.folders().some(f => fs.existsSync(path.join(f, 'pubspec.yaml')))
    || store.list().some(c => c.kind === 'flutter');

  const shortcut = (mac: string, other: string) => (process.platform === 'darwin' ? mac : other);

  function refreshUi(): void {
    const show = vscode.workspace.getConfiguration('runConfigurations').get<boolean>('showStatusBar', true) && store.folders().length > 0;
    const sel = getSelection();
    const selConfig = sel?.kind === 'npm' ? store.find(sel.folder, sel.name) : undefined;
    const selectedRunning = !!selConfig && isRunning(selConfig);
    void vscode.commands.executeCommand('setContext', 'runConfigurations.running', sessions.any());
    void vscode.commands.executeCommand('setContext', 'runConfigurations.hasSelection', !!sel);
    const flutterSelected = sel?.kind === 'npm' && store.find(sel.folder, sel.name)?.kind === 'flutter';
    void vscode.commands.executeCommand('setContext', 'runConfigurations.flutterSelected', flutterSelected);
    const flutter = flutterSelected || isFlutterWorkspace();
    void vscode.commands.executeCommand('setContext', 'runConfigurations.flutter', flutter);
    if (flutter) { devices.warmUp(); }
    if (!show) {
      [deviceItem, selector, runItem, debugItem, stopItem].forEach(i => i.hide());
      return;
    }
    // Show the device a run will really use: ours, else the Flutter extension's one.
    const eff = devices.effective();
    if (!eff.device) {
      deviceItem.text = `$(device-mobile) ${t('No device')}`;
      deviceItem.tooltip = t('No device selected here or in the Flutter extension. Click to pick one.');
    } else {
      const icon = !eff.supported ? 'warning' : eff.device.platform ? deviceIcon(eff.device.platform) : 'device-mobile';
      deviceItem.text = `$(${icon}) ${eff.device.name}`;
      deviceItem.tooltip = !eff.supported
        ? t('{0} is not supported by this project.', eff.device.name)
        : eff.source === 'dart'
          ? t("{0} (Flutter extension's device)", eff.device.name)
          : t('Device for Flutter configurations');
    }
    if (flutter) { deviceItem.show(); } else { deviceItem.hide(); }
    if (!sel) {
      selector.text = `$(gear) ${t('Add Configuration…')}`;
      selector.tooltip = t('No run configurations yet. Create one or import them from IntelliJ.');
    } else if (sel.kind === 'currentFile') {
      selector.text = `$(file-code) ${t('Current File')} $(chevron-down)`;
      selector.tooltip = t('Select run configuration');
    } else {
      const icon = sel.kind === 'npm' ? kindIcon(store.find(sel.folder, sel.name)?.kind ?? 'npm') : 'debug-alt-small';
      selector.text = `$(${icon}) ${sel.name} $(chevron-down)`;
      selector.tooltip = t('Select run configuration');
    }
    runItem.text = selectedRunning ? '$(debug-restart)' : '$(play)';
    runItem.tooltip = selectedRunning
      ? t('Rerun \'{0}\' ({1})', sel?.kind === 'npm' ? sel.name : '', shortcut('⌃R', 'Shift+F10'))
      : t('Run \'{0}\' ({1})', sel && sel.kind !== 'currentFile' ? sel.name : t('Current File'), shortcut('⌃R', 'Shift+F10'));
    debugItem.tooltip = t('Debug \'{0}\' ({1})', sel && sel.kind !== 'currentFile' ? sel.name : t('Current File'), shortcut('⌃D', 'Shift+F9'));
    stopItem.tooltip = t('Stop ({0})', shortcut('⌘F2', 'Ctrl+F2'));
    selector.show();
    runItem.show();
    debugItem.show();
    if (sessions.any()) { stopItem.show(); } else { stopItem.hide(); }
  }

  context.subscriptions.push(
    store.onDidChange(refreshUi),
    devices.onDidChange(refreshUi),
    sessions.onDidChange(refreshUi),
    vscode.workspace.onDidChangeWorkspaceFolders(refreshUi),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('runConfigurations')) { refreshUi(); }
    }),
  );

  // ---------- Run window and Services ----------
  const runs = new RunsModel();
  const runView = new RunViewProvider(context.extensionUri, runs, {
    rerun: async (run, debug) => {
      const { folder, name, attach } = splitKey(run.key);
      if (store.find(folder, name)) {
        await launch({ kind: 'npm', folder, name }, debug, attach, true);
      } else if (run.config) {
        await vscode.debug.startDebugging(wsFolder(folder), run.config, { noDebug: !debug });
      }
    },
    stop: async run => {
      if (run.session) { await vscode.debug.stopDebugging(run.session); }
    },
    showTerminal: run => {
      // js-debug names the terminal after the configuration.
      const term = [...vscode.window.terminals].reverse().find(x => x.name === run.name || x.name.includes(run.name));
      if (term) { term.show(); } else { void vscode.commands.executeCommand('workbench.action.terminal.focus'); }
    },
  });
  const services = new ServicesProvider({
    list: () => store.list(),
    folders: () => store.folders(),
    isRunning,
    isSelected: c => { const sel = getSelection(); return sel?.kind === 'npm' && sel.folder === c.folder && sel.name === c.name; },
    describe,
    icon: kindIcon,
  });
  const servicesView = vscode.window.createTreeView(ServicesProvider.viewId, { treeDataProvider: services, showCollapseAll: true });
  context.subscriptions.push(
    runs, runView, servicesView,
    vscode.window.registerWebviewViewProvider(RunViewProvider.viewId, runView, { webviewOptions: { retainContextWhenHidden: true } }),
    store.onDidChange(() => services.refresh()),
    sessions.onDidChange(() => services.refresh()),
  );
  const nodeConfig = (node?: ConfigNode): RunConfig | undefined => {
    if (node?.config) { return node.config; }
    const sel = getSelection();
    return sel?.kind === 'npm' ? store.find(sel.folder, sel.name) : undefined;
  };
  const showOutput = (c: RunConfig) => {
    const run = runs.forKey(configKey(c));
    if (run) { runView.reveal(run.id); }
  };

  // ---------- before launch ----------
  const beforeHost: BeforeLaunchHost = {
    runAndWait: (folder, name, token) => new Promise<boolean>(resolve => {
      const target = store.find(folder, name);
      const other = target ? undefined : store.others().find(o => o.folder === folder && o.name === name);
      if (!target && !other) {
        void vscode.window.showErrorMessage(t('Run configuration "{0}" no longer exists.', name));
        resolve(false);
        return;
      }
      if (target?.kind === 'compound') {
        void vscode.window.showErrorMessage(t('A compound cannot be a before-launch step: "{0}".', name));
        resolve(false);
        return;
      }
      const key = configKey({ folder, name });
      let root: vscode.DebugSession | undefined;
      const subs: vscode.Disposable[] = [];
      const finish = (ok: boolean) => { subs.forEach(d => d.dispose()); resolve(ok); };
      subs.push(
        vscode.debug.onDidStartDebugSession(s => {
          if (!root && !s.parentSession && (target ? s.configuration.__runConfigKey === key : s.name === name)) { root = s; }
        }),
        vscode.debug.onDidTerminateDebugSession(s => { if (s === root) { finish(true); } }),
        token.onCancellationRequested(() => {
          if (root) { void vscode.debug.stopDebugging(root); }
          finish(false);
        }),
      );
      const config = target ? toLaunchEntry(target, home) as vscode.DebugConfiguration : name;
      Promise.resolve(vscode.debug.startDebugging(wsFolder(folder), config, { noDebug: true }))
        .then(started => { if (!started) { finish(false); } }, () => finish(false));
    }),
    npmCommand: async (packageJson, folder) => {
      const ctx = await runtimes.context();
      const c = { ...emptyConfig(folder, ''), packageJson };
      const node = resolveNode(c, ctx);
      const env: Record<string, string> = {};
      if (node) {
        const key = process.platform === 'win32' ? Object.keys(process.env).find(k => k.toLowerCase() === 'path') ?? 'Path' : 'PATH';
        env[key] = path.dirname(node) + path.delimiter + (process.env[key] ?? '');
      }
      return { command: resolvePackageManager(c, node, ctx), env };
    },
  };

  // ---------- ▷ in the editor (CodeLens) and temporary configurations ----------
  const MAX_TEMPORARY = 5;
  const saveTemporary = async (folder: string, name: string) => {
    const all = store.list();
    const c = all.find(x => x.folder === folder && x.name === name);
    if (!c?.temporary) { return; }
    c.temporary = false;
    await store.saveAll(all);
    void vscode.window.showInformationMessage(t('Configuration "{0}" saved.', name));
  };

  /** What a ▷ runs: an existing configuration that does the same, else a new temporary one (the last 5 are kept). */
  const runEntry = async (candidate: RunConfig, debug: boolean) => {
    let c = store.list().find(o => sameRun(o, candidate));
    if (!c) {
      const all = store.list();
      const taken = (n: string) => all.some(o => o.folder === candidate.folder && o.name === n);
      let name = candidate.name;
      for (let i = 2; taken(name); i++) { name = `${candidate.name} (${i})`; }
      c = { ...applyTemplate(candidate, store.templates()[candidate.kind]), name, temporary: true };
      const next = [...all, c];
      const temps = next.filter(o => o.temporary);
      for (const old of temps.slice(0, Math.max(0, temps.length - MAX_TEMPORARY))) {
        if (!isRunning(old)) { next.splice(next.indexOf(old), 1); }
      }
      await store.saveAll(next);
    }
    const sel: Selection = { kind: 'npm', folder: c.folder, name: c.name };
    await setSelection(sel);
    await launch(sel, debug);
  };

  /** The configuration a ▷ at `entry` would create. */
  const entryConfig = (doc: vscode.TextDocument, entry: EntryPoint): RunConfig => {
    const file = doc.uri.fsPath;
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath ?? path.dirname(file);
    if (entry.kind === 'npm') {
      const dir = path.dirname(file);
      // Same naming as IntelliJ: "dev", or "<package dir> dev" below the workspace root.
      const name = dir === folder ? entry.script : `${path.basename(dir)} ${entry.script}`;
      return { ...emptyConfig(folder, name), packageJson: file, command: 'run', scripts: entry.script };
    }
    if (entry.kind === 'test') {
      const name = entry.name ? `${path.basename(file)} › ${entry.name}` : path.basename(file);
      return { ...emptyConfig(folder, name, 'test'), program: file, testName: entry.name, workingDir: nearestPackageDir(path.dirname(file), folder) ?? folder };
    }
    if (entry.kind === 'docker') {
      const name = entry.service ? `${path.basename(file)} › ${entry.service}` : path.basename(file);
      return { ...emptyConfig(folder, name, 'docker'), program: file, services: entry.service };
    }
    return { ...emptyConfig(folder, path.basename(file), entry.kind), program: file };
  };

  const lensChanged = new vscode.EventEmitter<void>();
  const isFlutterApp = (file: string, folder: string) => {
    const root = flutterRoot(file, folder);
    if (!root) { return false; }
    try { return /sdk:\s*flutter/.test(fs.readFileSync(path.join(root, 'pubspec.yaml'), 'utf8')); } catch { return false; }
  };
  context.subscriptions.push(lensChanged, store.onDidChange(() => lensChanged.fire()), vscode.languages.registerCodeLensProvider(
    [{ pattern: '**/package.json' }, { language: 'dart' }, { language: 'python' }, { language: 'shellscript' },
      { pattern: '**/*.{test,spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}' }, { pattern: '**/*compose*.{yml,yaml}' }],
    {
      onDidChangeCodeLenses: lensChanged.event,
      provideCodeLenses: doc => {
        if (doc.uri.scheme !== 'file' || !vscode.workspace.getConfiguration('runConfigurations').get<boolean>('codeLens', true)) { return []; }
        const file = doc.uri.fsPath;
        const text = doc.getText();
        const folder = vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath ?? path.dirname(file);
        const base = path.basename(file);
        const entries = base === 'package.json' ? packageJsonEntries(text)
          : TEST_FILE.test(base) ? testEntries(text)
          : COMPOSE_FILE.test(base) ? dockerEntries(text)
          : doc.languageId === 'dart' ? (isFlutterApp(file, folder) ? dartEntries(text) : [])
            : doc.languageId === 'python' ? pythonEntries(text)
              : doc.languageId === 'shellscript' ? shellEntries(text) : [];
        const all = store.list();
        return entries.flatMap(entry => {
          const range = doc.lineAt(doc.positionAt(entry.offset).line).range;
          const candidate = entryConfig(doc, entry);
          const existing = all.find(o => sameRun(o, candidate));
          const label = existing ? ` '${existing.name}'` : '';
          return [
            new vscode.CodeLens(range, { title: `$(play) ${t('Run')}${label}`, command: 'runConfigurations.runEntry', arguments: [candidate, false] }),
            new vscode.CodeLens(range, { title: `$(debug-alt) ${t('Debug')}`, command: 'runConfigurations.runEntry', arguments: [candidate, true] }),
          ];
        });
      },
    },
  ));

  // ---------- Run Anything ----------
  const runAnything = new RunAnything(context.workspaceState, {
    configs: () => store.list(),
    run: async (c, debug) => {
      const sel: Selection = { kind: 'npm', folder: c.folder, name: c.name };
      await setSelection(sel);
      await launch(sel, debug);
    },
    nodeDir: async folder => {
      const node = projectNode({ packageJson: path.join(folder, 'package.json'), folder }, await runtimes.context()).node?.path;
      return node ? path.dirname(node) : undefined;
    },
    icon: kindIcon,
  });

  // ---------- Export to IntelliJ ----------
  const exportIntellij = async () => {
    const all = store.list();
    const candidates = all.filter(c => !c.temporary);
    if (!candidates.length) {
      void vscode.window.showInformationMessage(t('There are no configurations to export.'));
      return;
    }
    const picked = await vscode.window.showQuickPick(candidates.map(c => ({
      label: `$(${kindIcon(c.kind)}) ${c.name}`, description: describe(c), picked: true, config: c,
    })), { canPickMany: true, placeHolder: t('Configurations to write as IntelliJ project files (.run/*.run.xml)') });
    if (!picked?.length) { return; }
    const files = picked.map(p => ({
      file: path.join(p.config.folder, '.run', runFileName(p.config.name)),
      xml: toIntellijXml(p.config, all, home),
    }));
    const changed = files.filter(f => fs.existsSync(f.file) && fs.readFileSync(f.file, 'utf8') !== f.xml);
    if (changed.length) {
      const overwrite = t('Overwrite');
      const answer = await vscode.window.showWarningMessage(
        t('{0} file(s) in .run already exist and will be replaced: {1}', changed.length, changed.map(f => path.basename(f.file)).join(', ')),
        { modal: true }, overwrite);
      if (answer !== overwrite) { return; }
    }
    for (const f of files) {
      fs.mkdirSync(path.dirname(f.file), { recursive: true });
      fs.writeFileSync(f.file, f.xml);
    }
    const reveal = t('Show Files');
    const answer = await vscode.window.showInformationMessage(
      t('Exported {0} configuration(s) to .run/ — IntelliJ loads them as project run configurations.', files.length), reveal);
    if (answer === reveal) {
      await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(files[0].file));
    }
  };

  // ---------- commands ----------
  context.subscriptions.push(
    vscode.commands.registerCommand('runConfigurations.exportIntellij', exportIntellij),
    vscode.commands.registerCommand('runConfigurations.runAnything', () => runAnything.show()),
    vscode.commands.registerCommand('runConfigurations.runEntry', (candidate: RunConfig, debug: boolean) => runEntry(candidate, debug)),
    vscode.commands.registerCommand('runConfigurations.saveTemporary', async (node?: ConfigNode) => {
      const c = nodeConfig(node);
      if (c) { await saveTemporary(c.folder, c.name); }
    }),
    vscode.commands.registerCommand('runConfigurations.services.open', async (node?: ConfigNode) => {
      const c = nodeConfig(node);
      if (!c) { return; }
      await setSelection({ kind: 'npm', folder: c.folder, name: c.name });
      showOutput(c);
    }),
    vscode.commands.registerCommand('runConfigurations.services.run', async (node?: ConfigNode) => {
      const c = nodeConfig(node);
      if (c) { await setSelection({ kind: 'npm', folder: c.folder, name: c.name }); await launch({ kind: 'npm', folder: c.folder, name: c.name }, false); }
    }),
    vscode.commands.registerCommand('runConfigurations.services.debug', async (node?: ConfigNode) => {
      const c = nodeConfig(node);
      if (c) { await setSelection({ kind: 'npm', folder: c.folder, name: c.name }); await launch({ kind: 'npm', folder: c.folder, name: c.name }, true); }
    }),
    vscode.commands.registerCommand('runConfigurations.services.stop', async (node?: ConfigNode) => {
      const c = nodeConfig(node);
      if (c) { await stopConfig(c); }
    }),
    vscode.commands.registerCommand('runConfigurations.services.edit', (node?: ConfigNode) => {
      const c = nodeConfig(node);
      openEditor(c ? { kind: 'npm', folder: c.folder, name: c.name } : getSelection());
    }),
    vscode.commands.registerCommand('runConfigurations.stopAll', async () => {
      await Promise.all(store.list().map(c => stopConfig(c)));
    }),
    vscode.commands.registerCommand('runConfigurations.showRunWindow', () => runView.reveal()),
  );

  // ---------- commands ----------
  context.subscriptions.push(
    vscode.commands.registerCommand('runConfigurations.run', () => launch(getSelection(), false)),
    vscode.commands.registerCommand('runConfigurations.debug', () => launch(getSelection(), true)),
    vscode.commands.registerCommand('runConfigurations.attach', () => launch(getSelection(), true, true)),
    vscode.commands.registerCommand('runConfigurations.selectDevice', () => devices.pick()),
    vscode.commands.registerCommand('runConfigurations.stop', stop),
    // Always the selector: even without configurations it offers the import, the Flutter device and the dialog.
    vscode.commands.registerCommand('runConfigurations.select', () => pick()),
    vscode.commands.registerCommand('runConfigurations.edit', () => openEditor(getSelection())),
    vscode.commands.registerCommand('runConfigurations.importIntellij', () => importIntellij(false)),
    vscode.commands.registerCommand('runConfigurations.refreshRuntimes', async () => {
      const d = await runtimes.get(true);
      void vscode.window.showInformationMessage(t('Detected {0} Node.js runtime(s) and {1} package manager(s).', d.nodes.length, d.packageManagers.length));
    }),
  );

  refreshUi();
  // Node detection spawns a `--version` per runtime/package manager: warm it only where npm configurations exist
  // (otherwise it runs on demand when one is launched or the dialog opens).
  if (store.list().some(c => c.kind === 'npm')) { void runtimes.get(); }
  void offerImport();

  return {
    runs: () => runs.list().map(r => ({ key: r.key, name: r.name, running: r.running, exitCode: r.exitCode, text: r.spans.map(x => x.text).join('') })),
    configs: () => store.list(),
    save: async (configs, templates) => {
      if (templates) { await store.saveTemplates(templates); }
      await store.saveAll(configs);
    },
    runCommand: command => runAnything.runCommand(command, vscode.workspace.workspaceFolders?.[0]),
  };
}

/** Selector/Services groups, in display order. */
const KIND_GROUPS: [RunConfig['kind'], () => string][] = [
  ['compound', () => t('Compound')], ['npm', () => 'npm'], ['node', () => 'Node.js'], ['test', () => t('Tests')],
  ['flutter', () => 'Flutter'], ['script', () => t('Scripts')], ['docker', () => 'Docker Compose'], ['attach', () => t('Attach to Node.js')],
];

function kindIcon(kind: RunConfig['kind']): string {
  switch (kind) {
    case 'flutter': return 'device-mobile';
    case 'script': return 'terminal';
    case 'compound': return 'run-all';
    case 'node': return 'file-code';
    case 'attach': return 'plug';
    case 'test': return 'beaker';
    case 'docker': return 'server-process';
    default: return 'package';
  }
}

/** One-line summary of what a configuration runs. */
function describe(c: RunConfig): string {
  switch (c.kind) {
    case 'flutter': return path.basename(c.program);
    case 'script':
    case 'node': return [path.basename(c.program), c.arguments].filter(Boolean).join(' ');
    case 'compound': return c.members.join(', ');
    case 'attach': return `${c.host || 'localhost'}:${c.port || '9229'}`;
    case 'test': return [c.program ? path.basename(c.program) : t('all tests'), c.testName && `› ${c.testName}`].filter(Boolean).join(' ');
    case 'docker': return ['compose', c.command || 'up', c.services].filter(Boolean).join(' ');
    default: return [c.command, c.scripts].filter(Boolean).join(' ');
  }
}

export function deactivate(): void {
  // Disposables are released through context.subscriptions.
}
