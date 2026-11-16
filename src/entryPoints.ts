import * as jsonc from 'jsonc-parser';

/** A place in a file that can be run, IntelliJ's gutter ▷ (shown as CodeLens in VS Code). */
export type EntryPoint =
  | { kind: 'npm'; offset: number; script: string }
  | { kind: 'flutter'; offset: number }
  | { kind: 'script'; offset: number };

/** `scripts` entries of a package.json, at their key. */
export function packageJsonEntries(text: string): EntryPoint[] {
  const root = jsonc.parseTree(text);
  const scripts = root && jsonc.findNodeAtLocation(root, ['scripts']);
  if (!scripts || scripts.type !== 'object') { return []; }
  const out: EntryPoint[] = [];
  for (const prop of scripts.children ?? []) {
    const key = prop.children?.[0];
    if (key && typeof key.value === 'string') { out.push({ kind: 'npm', offset: key.offset, script: key.value }); }
  }
  return out;
}

/** Top-level `main()` of a Dart file (`void main(`, `Future<void> main(`, `main(`). */
export function dartEntries(text: string): EntryPoint[] {
  const m = /^(?:(?:Future<void>|void)\s+)?main\s*\(/m.exec(text);
  return m ? [{ kind: 'flutter', offset: m.index }] : [];
}

/** `if __name__ == "__main__":` of a Python file. */
export function pythonEntries(text: string): EntryPoint[] {
  const m = /^if\s+__name__\s*==\s*['"]__main__['"]\s*:/m.exec(text);
  return m ? [{ kind: 'script', offset: m.index }] : [];
}

/** Shell scripts run as a whole: one entry on the first line. */
export function shellEntries(text: string): EntryPoint[] {
  return text.trim() ? [{ kind: 'script', offset: 0 }] : [];
}
