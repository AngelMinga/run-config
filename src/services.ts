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

/** A folder of the list (RunConfig.group) inside a kind. */
export class FolderNode {
  constructor(readonly kind: ConfigKind, readonly name: string, readonly configs: RunConfig[]) {}
}

type Node = GroupNode | FolderNode | ConfigNode;

const GROUPS: { kind: ConfigKind; label: () => string }[] = [
  { kind: 'compound', label: () => t('Compound') },
  { kind: 'npm', label: () => 'npm' },
  { kind: 'node', label: () => 'Node.js' },
  { kind: 'test', label: () => t('Tests') },
  { kind: 'flutter', label: () => 'Flutter' },
  { kind: 'script', label: () => t('Scripts') },
  { kind: 'docker', label: () => 'Docker Compose' },
  { kind: 'attach', label: () => t('Attach to Node.js') },
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
      // Folders first (in first-use order), then configurations without one, like IntelliJ.
      const folders = [...new Set(node.configs.map(c => c.group).filter(Boolean))];
      return [
        ...folders.map(f => new FolderNode(node.kind, f, node.configs.filter(c => c.group === f))),
        ...node.configs.filter(c => !c.group).map(c => new ConfigNode(c)),
      ];
    }
    if (node instanceof FolderNode) {
      return node.configs.map(c => new ConfigNode(c));
    }
    if (node) { return []; }
    const all = this.source.list();
    return GROUPS
      .map(g => new GroupNode(g.kind, all.filter(c => c.kind === g.kind)))
      .filter(g => g.configs.length);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node instanceof FolderNode) {
      const running = node.configs.filter(c => this.source.isRunning(c)).length;
      const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `folder:${node.kind}:${node.name}`;
      item.iconPath = vscode.ThemeIcon.Folder;
      item.description = running ? t('{0} running', running) : undefined;
      item.contextValue = 'folder';
      return item;
    }
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
    const parts = [running ? t('Running') : '', c.temporary ? t('temporary') : '', this.source.describe(c), multiRoot ? path.basename(c.folder) : '']
      .filter(Boolean);
    item.description = parts.join(' · ');
    item.tooltip = new vscode.MarkdownString(
      `**${c.name}**${this.source.isSelected(c) ? ` — ${t('selected')}` : ''}\n\n${this.source.describe(c)}`);
    item.contextValue = `config.${running ? 'running' : 'stopped'}.${c.kind}${c.temporary ? '.temp' : ''}`;
    item.command = { command: 'runConfigurations.services.open', title: t('Show Output'), arguments: [node] };
    return item;
  }
}
