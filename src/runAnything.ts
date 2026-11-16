import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { RunConfig, SCRIPT_TYPE } from './model';
import { projectPackageManager } from './project';

const t = vscode.l10n.t;
const HISTORY_KEY = 'runConfigurations.runAnythingHistory';
const MAX_HISTORY = 30;

export interface RunAnythingHost {
  configs(): RunConfig[];
  run(c: RunConfig, debug: boolean): Promise<void>;
  /** Directory of the project's node, put first in PATH so `npm`, `npx`… use it. */
  nodeDir(folder: string): Promise<string | undefined>;
  icon(kind: RunConfig['kind']): string;
}

interface Item extends vscode.QuickPickItem {
  command?: string;
  config?: RunConfig;
}

/** Shell that runs a typed command line. */
export function shellFor(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): { command: string; args: string[] } {
  return platform === 'win32'
    ? { command: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] }
    : { command: env.SHELL || '/bin/sh', args: ['-c', command] };
}

/** `history` with `command` moved to the front, without duplicates, capped. */
export function pushHistory(history: string[], command: string, max = MAX_HISTORY): string[] {
  return [command, ...history.filter(h => h !== command)].slice(0, max);
}

/** IntelliJ's Run Anything: type a command (or pick a configuration/script/recent command) and run it in the Run window. */
export class RunAnything {
  constructor(private readonly state: vscode.Memento, private readonly host: RunAnythingHost) {}

  private folder(): vscode.WorkspaceFolder | undefined {
    const doc = vscode.window.activeTextEditor?.document;
    return (doc && vscode.workspace.getWorkspaceFolder(doc.uri)) ?? vscode.workspace.workspaceFolders?.[0];
  }

  /** `<pm> run <script>` for the scripts of the folder's package.json. */
  private scriptCommands(folder: string): string[] {
    const pkg = path.join(folder, 'package.json');
    try {
      const scripts = JSON.parse(fs.readFileSync(pkg, 'utf8')).scripts ?? {};
      const pm = projectPackageManager(pkg, folder);
      return Object.keys(scripts).map(s => `${pm} run ${s}`);
    } catch {
      return [];
    }
  }

  async show(): Promise<void> {
    const folder = this.folder();
    const history = this.state.get<string[]>(HISTORY_KEY, []);
    const scripts = folder ? this.scriptCommands(folder.uri.fsPath) : [];
    const configs = this.host.configs();
    const debugButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('debug-alt'), tooltip: t('Debug') };
    const qp = vscode.window.createQuickPick<Item>();
    qp.placeholder = t('Run Anything: type a command (pnpm dev, flutter doctor, python main.py…) or pick a configuration');
    qp.matchOnDescription = true;
    const build = () => {
      const value = qp.value.trim();
      const items: Item[] = [];
      if (value) {
        items.push({ label: `$(terminal) ${value}`, description: t('Run command in {0}', folder?.name ?? '~'), command: value, alwaysShow: true });
      }
      if (history.length) {
        items.push({ label: t('Recent'), kind: vscode.QuickPickItemKind.Separator });
        items.push(...history.map(h => ({ label: `$(history) ${h}`, command: h })));
      }
      if (configs.length) {
        items.push({ label: t('Run Configurations'), kind: vscode.QuickPickItemKind.Separator });
        items.push(...configs.map(c => ({
          label: `$(${this.host.icon(c.kind)}) ${c.name}`,
          description: c.kind,
          config: c,
          buttons: c.kind === 'compound' ? [] : [debugButton],
        })));
      }
      const extra = scripts.filter(s => !history.includes(s));
      if (extra.length) {
        items.push({ label: 'package.json', kind: vscode.QuickPickItemKind.Separator });
        items.push(...extra.map(s => ({ label: `$(package) ${s}`, command: s })));
      }
      qp.items = items;
    };
    qp.onDidChangeValue(build);
    build();
    qp.onDidTriggerItemButton(async e => {
      qp.hide();
      if (e.item.config) { await this.host.run(e.item.config, true); }
    });
    qp.onDidAccept(async () => {
      const item = qp.selectedItems[0];
      const typed = qp.value.trim();
      qp.hide();
      if (item?.config) {
        await this.host.run(item.config, false);
      } else if (item?.command ?? typed) {
        await this.runCommand(item?.command ?? typed, folder);
      }
    });
    qp.onDidHide(() => qp.dispose());
    qp.show();
  }

  async runCommand(command: string, folder: vscode.WorkspaceFolder | undefined): Promise<void> {
    await this.state.update(HISTORY_KEY, pushHistory(this.state.get<string[]>(HISTORY_KEY, []), command));
    const cwd = folder?.uri.fsPath ?? process.cwd();
    const shell = shellFor(command, process.env, process.platform);
    const env: Record<string, string> = {};
    const nodeDir = await this.host.nodeDir(cwd);
    if (nodeDir) {
      const key = process.platform === 'win32' ? Object.keys(process.env).find(k => k.toLowerCase() === 'path') ?? 'Path' : 'PATH';
      env[key] = nodeDir + path.delimiter + (process.env[key] ?? '');
    }
    const name = command.length > 48 ? command.slice(0, 47) + '…' : command;
    // Runs through the script adapter: output in the Run window, stdin from its input line, Stop kills the process group.
    await vscode.debug.startDebugging(folder, {
      type: SCRIPT_TYPE,
      request: 'launch',
      name: `$ ${name}`,
      command: shell.command,
      args: shell.args,
      cwd,
      env,
      internalConsoleOptions: 'neverOpen',
      __runConfigKey: `${cwd}::$ ${command}`,
      __resolvedScript: true,
    }, { noDebug: true });
  }
}
