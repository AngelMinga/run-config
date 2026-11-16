import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as jsonc from 'jsonc-parser';
import * as vscode from 'vscode';
import { fromLaunchEntry, isRunType, normalize, RunConfig, toLaunchEntry } from './model';

const LOCAL_KEY = 'runConfigurations.local';

/** A configuration plus where it was loaded from, so edits/renames/moves can be written back. */
export interface StoredConfig extends RunConfig {
  origin?: { folder: string; name: string; shared: boolean };
}

/** Any other launch.json entry (or compound) — runnable, edited in launch.json itself. */
export interface OtherLaunch {
  folder: string;
  name: string;
  type: string;
  compound: boolean;
}

const FORMAT: jsonc.FormattingOptions = { insertSpaces: true, tabSize: 4, eol: '\n' };

export function launchJsonPath(folder: string): string {
  return path.join(folder, '.vscode', 'launch.json');
}

function readLaunch(folder: string): { text: string; data: { configurations?: unknown[]; compounds?: unknown[] } } {
  let text = '';
  try {
    text = fs.readFileSync(launchJsonPath(folder), 'utf8');
  } catch { /* no launch.json yet */ }
  const data = (text ? jsonc.parse(text, [], { allowTrailingComma: true }) : undefined) ?? {};
  return { text, data: typeof data === 'object' ? data : {} };
}

const isEntry = (e: unknown): e is Record<string, unknown> => !!e && typeof e === 'object' && !Array.isArray(e);

export class ConfigStore implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly watcher: vscode.FileSystemWatcher;
  private readonly home = os.homedir();
  /** Parsed launch.json per folder: the status bar asks for configurations on every refresh. */
  private readonly cache = new Map<string, ReturnType<typeof readLaunch>>();

  constructor(private readonly state: vscode.Memento) {
    this.watcher = vscode.workspace.createFileSystemWatcher('**/.vscode/launch.json');
    const fire = () => { this.cache.clear(); this.changed.fire(); };
    this.watcher.onDidChange(fire);
    this.watcher.onDidCreate(fire);
    this.watcher.onDidDelete(fire);
  }

  dispose(): void {
    this.watcher.dispose();
    this.changed.dispose();
  }

  private launch(folder: string): ReturnType<typeof readLaunch> {
    let entry = this.cache.get(folder);
    if (!entry) {
      entry = readLaunch(folder);
      this.cache.set(folder, entry);
    }
    return entry;
  }

  folders(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath);
  }

  /** Run configurations (npm and Flutter): launch.json ones (per folder, in file order) then private ones. */
  list(): StoredConfig[] {
    const out: StoredConfig[] = [];
    for (const folder of this.folders()) {
      for (const e of this.launch(folder).data.configurations ?? []) {
        if (isEntry(e) && isRunType(e.type) && typeof e.name === 'string') {
          const c = fromLaunchEntry(e, folder, this.home, true);
          out.push({ ...c, origin: { folder, name: c.name, shared: true } });
        }
      }
    }
    const folders = this.folders();
    for (const c of this.state.get<RunConfig[]>(LOCAL_KEY, [])) {
      if (folders.includes(c.folder)) {
        out.push({ ...normalize(c), origin: { folder: c.folder, name: c.name, shared: false } });
      }
    }
    return out;
  }

  others(): OtherLaunch[] {
    const out: OtherLaunch[] = [];
    for (const folder of this.folders()) {
      const { data } = this.launch(folder);
      for (const e of data.configurations ?? []) {
        if (isEntry(e) && !isRunType(e.type) && typeof e.name === 'string') {
          out.push({ folder, name: e.name, type: String(e.type ?? ''), compound: false });
        }
      }
      for (const e of data.compounds ?? []) {
        if (isEntry(e) && typeof e.name === 'string') {
          out.push({ folder, name: e.name, type: 'compound', compound: true });
        }
      }
    }
    return out;
  }

  find(folder: string, name: string): StoredConfig | undefined {
    return this.list().find(c => c.folder === folder && c.name === name);
  }

  /** Replaces the whole set of npm configurations with `next` (as edited in the dialog). */
  async saveAll(next: StoredConfig[]): Promise<void> {
    const previous = this.list();
    const touched = new Set<string>();
    for (const c of [...previous, ...next]) {
      if (c.shared || c.origin?.shared) { touched.add(c.shared ? c.folder : c.origin!.folder); }
    }
    for (const folder of touched) {
      this.writeShared(folder, next);
    }
    const local = next.filter(c => !c.shared).map(({ origin: _origin, ...c }) => c);
    // Keep private configurations of folders that aren't open right now.
    const open = this.folders();
    const hidden = this.state.get<RunConfig[]>(LOCAL_KEY, []).filter(c => !open.includes(c.folder));
    await this.state.update(LOCAL_KEY, [...hidden, ...local]);
    this.changed.fire();
  }

  private writeShared(folder: string, next: StoredConfig[]): void {
    const file = launchJsonPath(folder);
    let { text } = readLaunch(folder);
    if (!text.trim()) {
      text = '{\n    "version": "0.2.0",\n    "configurations": []\n}\n';
    }
    const apply = (p: jsonc.JSONPath, value: unknown, insert = false) => {
      text = jsonc.applyEdits(text, jsonc.modify(text, p, value, { formattingOptions: FORMAT, isArrayInsertion: insert }));
    };
    const entries = () => {
      const list = (jsonc.parse(text, [], { allowTrailingComma: true })?.configurations ?? []) as unknown[];
      return Array.isArray(list) ? list : [];
    };
    if (!Array.isArray(jsonc.parse(text, [], { allowTrailingComma: true })?.configurations)) {
      apply(['configurations'], []);
    }
    const wanted = next.filter(c => c.shared && c.folder === folder);
    const kept = new Set(wanted.filter(c => c.origin?.shared && c.origin.folder === folder).map(c => c.origin!.name));

    // 1. Remove entries that were deleted, renamed away or moved out (from the end, to keep indexes valid).
    const current = entries();
    for (let i = current.length - 1; i >= 0; i--) {
      const e = current[i];
      if (isEntry(e) && isRunType(e.type) && !kept.has(String(e.name))) {
        apply(['configurations', i], undefined);
      }
    }
    // 2. Update the ones that stay, in place (indexes resolved first: renames may swap names), then append new ones.
    const list = entries();
    const placed = wanted.map(c => ({
      c,
      index: c.origin?.shared && c.origin.folder === folder
        ? list.findIndex(e => isEntry(e) && isRunType(e.type) && e.name === c.origin!.name)
        : -1,
    }));
    for (const { c, index } of placed) {
      if (index >= 0) { apply(['configurations', index], toLaunchEntry(c, this.home)); }
    }
    for (const { c, index } of placed) {
      if (index < 0) { apply(['configurations', entries().length], toLaunchEntry(c, this.home), true); }
    }
    if (text !== readLaunch(folder).text) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      this.cache.delete(folder);
    }
  }
}
