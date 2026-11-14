import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { detect, Detection } from './detect';
import { DeviceService } from './devices';
import { deviceIcon } from './flutter';
import { EditorPanel } from './editor';
import { findIntellijProjects, ImportedConfig, readIntellijConfigs } from './intellij';
import { anchorPath, buildFlutterLaunch, buildNodeLaunch, configKey, DEBUG_TYPE, FLUTTER_TYPE, fromLaunchEntry, RunConfig, toLaunchEntry } from './model';
import { ancestors, flutterRoot, projectNode, ResolveContext, resolveNode, resolvePackageManager } from './project';
import { ConfigStore, launchJsonPath, StoredConfig } from './store';

const home = os.homedir();
const t = vscode.l10n.t;

export type Selection =
  | { kind: 'npm' | 'launch'; folder: string; name: string }
  | { kind: 'currentFile' };

const SELECTED_KEY = 'runConfigurations.selected';
const IMPORT_OFFERED_KEY = 'runConfigurations.importOffered';
const RUNNABLE_FILE = /\.((m|c)?(j|t)s|dart)$/i;
const DART_EXTENSION = 'Dart-Code.dart-code';
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
        for (const [key, set] of this.byKey) {
          if (set.delete(s) && !set.size) { this.byKey.delete(key); }
        }
        this.changed.fire();
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

export function activate(context: vscode.ExtensionContext): void {
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
      if (!c.allowMultiple) {
        await sessions.stop(configKey(c));
      }
      const launch = buildNodeLaunch(c, { node, packageManager: resolvePackageManager(c, node, ctx) }, process.env);
      if (config.noDebug) { launch.noDebug = true; }
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
      if (!c.allowMultiple && !attach) {
        await sessions.stop(configKey(c));
      }
      const deviceId = typeof config.deviceId === 'string' && config.deviceId ? config.deviceId : devices.selected()?.id;
      const launch = buildFlutterLaunch(c, root, { attach, deviceId });
      // Attaching connects to the running app: never stop it, and track it apart from `flutter run`.
      if (attach) { launch.__runConfigKey = `${configKey(c)}::attach`; }
      if (config.noDebug) { launch.noDebug = true; }
      return launch as vscode.DebugConfiguration;
    },
  }));

  const showConfigError = async (message: string, c: RunConfig) => {
    const edit = t('Edit Configuration');
    if (await vscode.window.showErrorMessage(message, edit) === edit) {
      openEditor({ kind: 'npm', folder: c.folder, name: c.name });
    }
  };

  // ---------- running ----------
  const wsFolder = (fsPath: string) => vscode.workspace.workspaceFolders?.find(f => f.uri.fsPath === fsPath);

  const launch = async (sel: Selection | undefined, debug: boolean, attach = false): Promise<void> => {
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
    if (attach && c.kind !== 'flutter') {
      void vscode.window.showWarningMessage(t('Attach is only available for Flutter configurations.'));
      return;
    }
    const entry = { ...toLaunchEntry(c, home), ...(attach ? { attach: true } : {}) };
    // Attach always runs with the debugger: there is nothing to run "without debugging".
    await vscode.debug.startDebugging(wsFolder(c.folder), entry as vscode.DebugConfiguration, attach ? {} : options);
  };

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
      console: 'integratedTerminal',
      skipFiles: ['<node_internals>/**'],
      ...(node ? { runtimeExecutable: node } : {}),
    }, options);
  };

  const stop = async () => {
    const sel = getSelection();
    if (sel?.kind === 'npm') {
      const key = configKey(sel);
      if (sessions.running(key).length) {
        await sessions.stop(key);
        return;
      }
    }
    await vscode.commands.executeCommand('workbench.action.debug.stop');
  };

  // ---------- picker ----------
  interface PickItem extends vscode.QuickPickItem { sel?: Selection; action?: 'edit' | 'import' | 'device' }
  const runButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('play'), tooltip: t('Run') };
  const debugButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('debug-alt'), tooltip: t('Debug') };
  const attachButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('plug'), tooltip: t('Flutter Attach') };

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
    for (const [kind, title] of [['npm', 'npm'], ['flutter', 'Flutter']] as const) {
      const group = all.filter(c => c.kind === kind);
      if (!group.length) { continue; }
      items.push({ label: title, kind: vscode.QuickPickItemKind.Separator });
      for (const c of group) {
        const sel: Selection = { kind: 'npm', folder: c.folder, name: c.name };
        const running = sessions.running(configKey(c)).length > 0;
        items.push({
          label: `$(${running ? 'debug-restart' : kindIcon(c.kind)}) ${c.name}`,
          description: (c.kind === 'flutter' ? path.basename(c.program) : [c.command, c.scripts].filter(Boolean).join(' '))
            + (folderName(c.folder) ? ` · ${folderName(c.folder)}` : ''),
          detail: running ? t('Running') : undefined,
          picked: same(sel),
          sel,
          buttons: c.kind === 'flutter' ? [runButton, debugButton, attachButton] : [runButton, debugButton],
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
          const rel = path.relative(folder, anchorPath(config));
          if (!rel.startsWith('..') && !path.isAbsolute(rel)) { out.push({ folder, config }); }
        }
      }
    }
    return out;
  };

  const sameRun = (a: RunConfig, b: RunConfig) => a.kind === b.kind && a.folder === b.folder && (a.kind === 'flutter'
    ? a.program === b.program && a.runArgs === b.runArgs && a.flavor === b.flavor
    : a.packageJson === b.packageJson && a.command === b.command && a.scripts === b.scripts && a.arguments === b.arguments);

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
    const selectedRunning = sel?.kind === 'npm' && sessions.running(configKey(sel)).length > 0;
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
  void runtimes.get();
  void offerImport();
}

function kindIcon(kind: RunConfig['kind']): string {
  return kind === 'flutter' ? 'device-mobile' : 'package';
}

export function deactivate(): void {
  // Disposables are released through context.subscriptions.
}
