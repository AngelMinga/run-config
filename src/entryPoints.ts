import * as jsonc from 'jsonc-parser';

/** A place in a file that can be run, IntelliJ's gutter ▷ (shown as CodeLens in VS Code). */
export type EntryPoint =
  | { kind: 'npm'; offset: number; script: string }
  | { kind: 'flutter'; offset: number }
  | { kind: 'script'; offset: number }
  /** `name` '' → the whole file. */
  | { kind: 'test'; offset: number; name: string }
  /** `service` '' → the whole compose file. */
  | { kind: 'docker'; offset: number; service: string };

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

/**
 * Jest/Vitest blocks of a test file: `describe`/`it`/`test`/`suite` (with `.only`, `.skip`, `.concurrent`, `.each(…)`)
 * whose title is a plain string; plus one entry for the whole file on its first line.
 */
export function testEntries(text: string): EntryPoint[] {
  const out: EntryPoint[] = [];
  const re = /^[ \t]*(?:describe|it|test|suite)(?:\.(?:only|skip|concurrent|each\([^)]*\)))*\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/gm;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    // Template literals with ${} can't be matched by name.
    if (m[1] === '`' && m[2].includes('${')) { continue; }
    out.push({ kind: 'test', offset: m.index + m[0].length - m[0].trimStart().length, name: m[2].replace(/\\(.)/g, '$1') });
  }
  return out.length ? [{ kind: 'test', offset: 0, name: '' }, ...out] : [];
}

/** `services:` of a compose file (the whole stack) and each service under it. */
export function dockerEntries(text: string): EntryPoint[] {
  const services = /^services:[ \t]*(?:#.*)?$/m.exec(text);
  if (!services) { return []; }
  const out: EntryPoint[] = [{ kind: 'docker', offset: services.index, service: '' }];
  const after = services.index + services[0].length;
  // Up to the next top-level key.
  const rest = text.slice(after);
  const end = /^\S/m.exec(rest.replace(/^\n/, ' '));
  const block = end ? rest.slice(0, end.index) : rest;
  const indent = /^([ \t]+)[A-Za-z0-9._-]+:/m.exec(block)?.[1];
  if (!indent) { return out; }
  const re = new RegExp(`^${indent}([A-Za-z0-9._-]+):`, 'gm');
  for (let m = re.exec(block); m; m = re.exec(block)) {
    out.push({ kind: 'docker', offset: after + m.index + indent.length, service: m[1] });
  }
  return out;
}
