import * as path from 'node:path';
import * as vscode from 'vscode';
import { ConfigKind, RunConfig } from './model';

const t = vscode.l10n.t;

export interface ServicesSource {
  list(): RunConfig[];
  folders(): string[];
  /** Running sessions of a configuration (compounds: any member). */
  isRunning(c: RunConfig): boolean;
  isSelected(c: RunConfig): boolean;
  describe(c: RunConfig): string;
  icon(kind: ConfigKind): string;
}

export class GroupNode {
  constructor(readonly kind: ConfigKind, readonly configs: RunConfig[]) {}
}

export class ConfigNode {
  constructor(readonly config: RunConfig) {}
}

type Node = GroupNode | ConfigNode;

const GROUPS: { kind: ConfigKind; label: () => string }[] = [
  { kind: 'compound', label: () => t('Compound') },
  { kind: 'npm', label: () => 'npm' },
  { kind: 'flutter', label: () => 'Flutter' },
  { kind: 'script', label: () => t('Scripts') },
];

/** IntelliJ's Services tool window: every configuration by type, running ones highlighted, with inline actions. */
export class ServicesProvider implements vscode.TreeDataProvider<Node> {
  static readonly viewId = 'runConfigurations.services';
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly source: ServicesSource) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  getChildren(node?: Node): Node[] {
    if (node instanceof GroupNode) {
      return node.configs.map(c => new ConfigNode(c));
    }
    if (node) { return []; }
    const all = this.source.list();
    return GROUPS
      .map(g => new GroupNode(g.kind, all.filter(c => c.kind === g.kind)))
      .filter(g => g.configs.length);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node instanceof GroupNode) {
      const g = GROUPS.find(x => x.kind === node.kind)!;
      const running = node.configs.filter(c => this.source.isRunning(c)).length;
      const item = new vscode.TreeItem(g.label(), vscode.TreeItemCollapsibleState.Expanded);
      item.id = `group:${node.kind}`;
      item.iconPath = new vscode.ThemeIcon(this.source.icon(node.kind));
      item.description = running ? t('{0} running', running) : undefined;
      item.contextValue = 'group';
      return item;
    }
    const c = node.config;
    const running = this.source.isRunning(c);
    const item = new vscode.TreeItem(c.name, vscode.TreeItemCollapsibleState.None);
    item.id = `config:${c.folder}::${c.name}`;
    item.iconPath = new vscode.ThemeIcon(this.source.icon(c.kind),
      running ? new vscode.ThemeColor('debugIcon.startForeground') : undefined);
    const multiRoot = this.source.folders().length > 1;
    const parts = [running ? t('Running') : '', this.source.describe(c), multiRoot ? path.basename(c.folder) : '']
      .filter(Boolean);
    item.description = parts.join(' · ');
    item.tooltip = new vscode.MarkdownString(
      `**${c.name}**${this.source.isSelected(c) ? ` — ${t('selected')}` : ''}\n\n${this.source.describe(c)}`);
    item.contextValue = `config.${running ? 'running' : 'stopped'}.${c.kind}`;
    item.command = { command: 'runConfigurations.services.open', title: t('Show Output'), arguments: [node] };
    return item;
  }
}
