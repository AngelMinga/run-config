import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Runtimes } from './extension';
import { configKey, NPM_COMMANDS, packageManagerName, RunConfig } from './model';
import { packageScripts, projectNode, projectPackageManager, resolvePackageManager } from './project';
import { ConfigStore, StoredConfig } from './store';

const t = vscode.l10n.t;

export interface EditorHooks {
  selected?: { folder: string; name: string };
  run(folder: string, name: string, debug: boolean): Promise<void>;
  select(folder: string, name: string): Promise<void>;
  openLaunchJson(folder: string, name?: string): Promise<void>;
}

type Incoming =
  | { type: 'ready' }
  | { type: 'inspect'; id: string; config: RunConfig }
  | { type: 'browse'; field: 'packageJson' | 'nodeRuntime' | 'packageManager' | 'program'; current: string; folder: string }
  | { type: 'save'; configs: StoredConfig[]; close: boolean; run?: { folder: string; name: string; debug: boolean }; selected?: { folder: string; name: string } }
  | { type: 'cancel' }
  | { type: 'openLaunch'; folder: string; name?: string }
  | { type: 'refresh' };

/** Strings used by media/editor.js, translated here. */
function strings(): Record<string, string> {
  const keys = [
    'Run/Debug Configurations', 'Add New Configuration', 'Remove Configuration', 'Copy Configuration',
    'Name:', 'Allow multiple instances', 'Store as project file', 'Configuration', 'package.json:', 'Command:', 'Scripts:',
    'Arguments:', 'Node runtime:', 'Node options:', 'Package manager:', 'Environment:', 'Before launch:', 'Workspace folder:',
    'Run', 'Debug', 'Cancel', 'Apply', 'OK', 'Project', 'Browse…', 'not found', 'Detecting…', 'Refresh',
    'One KEY=value per line', 'VS Code task to run before launch (preLaunchTask)', 'Other launch.json configurations',
    'Edit in launch.json', 'No run configurations. Click + to add one.', 'Name is required.',
    'A configuration named "{0}" already exists in this folder.', 'Unnamed', 'Saved in .vscode/launch.json (shared with the team).',
    'Saved privately in this workspace (not committed).', 'Scripts from package.json', 'Running',
    'npm', 'Flutter', 'Dart entrypoint:', 'Additional run args:', 'Build flavor:', 'Environment variables:',
    'The entry-point for the application (e.g. lib/main.dart).', "Additional arguments to 'flutter run'.",
    'An optional build flavor; either a Gradle product flavor or an Xcode custom scheme.', 'Additional environment variables.',
    'The Dart and Flutter extensions are needed to run Flutter configurations.',
    'Additional attach args:', "Additional arguments to 'flutter attach'.",
  ];
  return Object.fromEntries(keys.map(k => [k, t(k)]));
}

export class EditorPanel {
  private static current?: EditorPanel;
  private readonly home = os.homedir();

  static show(context: vscode.ExtensionContext, store: ConfigStore, runtimes: Runtimes, hooks: EditorHooks): void {
    if (EditorPanel.current) {
      EditorPanel.current.hooks = hooks;
      EditorPanel.current.panel.reveal();
      void EditorPanel.current.sendInit();
      return;
    }
    EditorPanel.current = new EditorPanel(context, store, runtimes, hooks);
  }

  private readonly panel: vscode.WebviewPanel;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: ConfigStore,
    private readonly runtimes: Runtimes,
    private hooks: EditorHooks,
  ) {
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel('runConfigurations.editor', t('Run/Debug Configurations'),
      vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] });
    this.panel.webview.html = this.html(media);
    this.panel.onDidDispose(() => { EditorPanel.current = undefined; });
    if (vscode.workspace.getConfiguration('runConfigurations').get<boolean>('floatingDialog', true)) {
      // Like IntelliJ's dialog: its own window. The window closes with the panel (OK / Cancel).
      void Promise.resolve(vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow')).catch(() => undefined);
    }
    this.panel.webview.onDidReceiveMessage((m: Incoming) => this.onMessage(m).catch(err => {
      void vscode.window.showErrorMessage(String(err instanceof Error ? err.message : err));
    }));
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  private async sendInit(): Promise<void> {
    const folders = this.store.folders().map(f => ({ path: f, name: path.basename(f) }));
    const exclude = '**/{node_modules,.git,dist,build,out,.dart_tool,ios,android,macos,windows,linux,web}/**';
    const [pkgUris, dartUris] = await Promise.all([
      vscode.workspace.findFiles('**/package.json', exclude, 300),
      vscode.workspace.findFiles('**/lib/main*.dart', exclude, 100),
    ]);
    this.post({
      type: 'init',
      configs: this.store.list(),
      others: this.store.others(),
      folders,
      packageJsons: pkgUris.map(u => u.fsPath).sort(),
      dartEntrypoints: dartUris.map(u => u.fsPath).sort(),
      hasDart: !!vscode.extensions.getExtension('Dart-Code.dart-code'),
      commands: NPM_COMMANDS,
      home: this.home,
      sep: path.sep,
      selected: this.hooks.selected,
      strings: strings(),
    });
    void this.sendDetection(false);
    void vscode.tasks.fetchTasks().then(tasks => {
      const names = [...new Set(tasks.map(task => (task.source && task.source !== 'Workspace' ? `${task.source}: ${task.name}` : task.name)))];
      this.post({ type: 'tasks', tasks: names.sort() });
    }, () => undefined);
  }

  private async sendDetection(refresh: boolean): Promise<void> {
    this.post({ type: 'detection', detection: await this.runtimes.get(refresh) });
  }

  private async onMessage(m: Incoming): Promise<void> {
    switch (m.type) {
      case 'ready':
        return this.sendInit();
      case 'refresh':
        return this.sendDetection(true);
      case 'inspect': {
        const ctx = await this.runtimes.context();
        const c = m.config;
        if (c.kind === 'flutter') { return; }
        const node = projectNode(c, ctx);
        const pmName = projectPackageManager(c.packageJson, c.folder);
        const effectiveNode = c.nodeRuntime || node.node?.path;
        const pmPath = resolvePackageManager({ ...c, packageManager: '' }, effectiveNode, ctx);
        const pmVersion = ctx.detection.packageManagers.find(p => p.path === pmPath)?.version;
        this.post({
          type: 'inspected',
          id: m.id,
          scripts: packageScripts(c.packageJson),
          projectNode: node.node ? { ...node.node, source: node.source } : undefined,
          projectPm: { name: pmName, path: pmPath, version: pmVersion },
        });
        return;
      }
      case 'browse': {
        const defaultUri = m.current
          ? vscode.Uri.file(m.field === 'packageJson' || m.field === 'program' ? path.dirname(m.current) : m.current)
          : vscode.Uri.file(m.folder || this.home);
        const picked = await vscode.window.showOpenDialog({
          defaultUri,
          canSelectMany: false,
          openLabel: t('Select'),
          filters: m.field === 'packageJson' ? { 'package.json': ['json'] } : m.field === 'program' ? { Dart: ['dart'] } : undefined,
        });
        if (picked?.[0]) {
          this.post({ type: 'browsed', field: m.field, value: picked[0].fsPath });
        }
        return;
      }
      case 'openLaunch':
        return this.hooks.openLaunchJson(m.folder, m.name);
      case 'cancel':
        this.panel.dispose();
        return;
      case 'save': {
        const error = this.validate(m.configs);
        if (error) {
          this.post({ type: 'error', message: error });
          return;
        }
        await this.store.saveAll(m.configs);
        if (m.selected && m.configs.some(c => c.folder === m.selected!.folder && c.name === m.selected!.name)) {
          await this.hooks.select(m.selected.folder, m.selected.name);
        }
        if (m.close || m.run) {
          this.panel.dispose();
        } else {
          this.post({ type: 'saved', configs: this.store.list() });
        }
        if (m.run) {
          await this.hooks.run(m.run.folder, m.run.name, m.run.debug);
        }
        return;
      }
    }
  }

  private validate(configs: StoredConfig[]): string | undefined {
    const seen = new Set<string>();
    for (const c of configs) {
      if (!c.name.trim()) { return t('Name is required.'); }
      const key = configKey(c);
      if (seen.has(key)) { return t('A configuration named "{0}" already exists in this folder.', c.name); }
      seen.add(key);
      if (c.kind === 'flutter') {
        if (!c.program.trim()) { return t('Dart entrypoint is required.'); }
        continue;
      }
      if (c.packageManager && !/[\\/]/.test(c.packageManager) && !['npm', 'pnpm', 'yarn', 'bun'].includes(packageManagerName(c.packageManager))) {
        return t('Unknown package manager "{0}".', c.packageManager);
      }
    }
    return undefined;
  }

  private html(media: vscode.Uri): string {
    const webview = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'editor.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'editor.css'));
    return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>${t('Run/Debug Configurations')}</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
