import * as vscode from 'vscode';
import { AnsiConverter, Span } from './ansi';

const t = vscode.l10n.t;

/** Output kept per run (characters); older output is dropped, like IntelliJ's console cycle buffer. */
const MAX_CHARS = 2_000_000;

export interface RunMeta {
  id: string;
  /** `folder::name` (Flutter attach: `folder::name::attach`). */
  key: string;
  folder: string;
  name: string;
  title: string;
  kind: 'npm' | 'flutter' | 'script' | 'other';
  running: boolean;
  debug: boolean;
  exitCode?: number;
  /** npm in the integrated terminal: the output is there, not in the Run window. */
  terminal: boolean;
  /** The process reads stdin from the Run window (scripts). */
  input: boolean;
  started: number;
}

export interface Run extends RunMeta {
  session?: vscode.DebugSession;
  spans: Span[];
  size: number;
  converters: Map<string, AnsiConverter>;
}

export function splitKey(key: string): { folder: string; name: string; attach: boolean } {
  const i = key.indexOf('::');
  const folder = i >= 0 ? key.slice(0, i) : '';
  let name = i >= 0 ? key.slice(i + 2) : key;
  const attach = name.endsWith('::attach');
  if (attach) { name = name.slice(0, -'::attach'.length); }
  return { folder, name, attach };
}

function rootOf(session: vscode.DebugSession): vscode.DebugSession {
  let s = session;
  while (s.parentSession) { s = s.parentSession; }
  return s;
}

function kindOf(config: vscode.DebugConfiguration): RunMeta['kind'] {
  if (config.type === 'node' || config.type === 'pwa-node') { return 'npm'; }
  if (config.type === 'dart') { return 'flutter'; }
  if (config.type === 'script-run') { return 'script'; }
  return 'other';
}

/**
 * Runs of our configurations (one per top-level debug session) with their captured output, for the Run window
 * and the Services view. Output comes from DAP `output` events of the session and its child sessions.
 */
export class RunsModel implements vscode.Disposable {
  private readonly runs: Run[] = [];
  private readonly bySession = new Map<string, Run>();
  private nextId = 1;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<Run | undefined>();
  /** A run was added/updated (undefined: removed or reordered). */
  readonly onDidChange = this.changed.event;
  private readonly appended = new vscode.EventEmitter<{ run: Run; spans: Span[] }>();
  readonly onDidAppend = this.appended.event;
  private readonly started = new vscode.EventEmitter<Run>();
  readonly onDidStart = this.started.event;

  constructor() {
    this.disposables.push(
      vscode.debug.registerDebugAdapterTrackerFactory('*', {
        createDebugAdapterTracker: session => {
          const root = rootOf(session);
          if (typeof root.configuration.__runConfigKey !== 'string') { return undefined; }
          return {
            onDidSendMessage: (m: { type?: string; event?: string; body?: Record<string, unknown> }) => {
              if (m.type !== 'event' || !m.body) { return; }
              if (m.event === 'output') {
                const category = String(m.body.category ?? 'console');
                const output = m.body.output;
                if (category === 'telemetry' || typeof output !== 'string') { return; }
                this.append(this.ensure(root), output, category);
              } else if (m.event === 'exited' && typeof m.body.exitCode === 'number' && session === root) {
                this.ensure(root).exitCode = m.body.exitCode;
              }
            },
          };
        },
      }),
      vscode.debug.onDidStartDebugSession(s => {
        if (!s.parentSession && typeof s.configuration.__runConfigKey === 'string') { this.ensure(s); }
      }),
      vscode.debug.onDidTerminateDebugSession(s => {
        const run = this.bySession.get(s.id);
        if (!run) { return; }
        this.bySession.delete(s.id);
        run.running = false;
        run.session = undefined;
        // The script adapter prints its own "Process finished…" line.
        if (!run.terminal && run.kind !== 'script') {
          this.appendSystem(run, run.exitCode === undefined
            ? t('Process finished')
            : t('Process finished with exit code {0}', run.exitCode));
        }
        this.changed.fire(run);
      }),
    );
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this.changed.dispose();
    this.appended.dispose();
    this.started.dispose();
  }

  list(): readonly Run[] {
    return this.runs;
  }

  get(id: string): Run | undefined {
    return this.runs.find(r => r.id === id);
  }

  /** Latest run of a configuration key (running first). */
  forKey(key: string): Run | undefined {
    return this.runs.find(r => r.key === key && r.running) ?? [...this.runs].reverse().find(r => r.key === key);
  }

  private ensure(session: vscode.DebugSession): Run {
    const existing = this.bySession.get(session.id);
    if (existing) { return existing; }
    const config = session.configuration;
    const key = String(config.__runConfigKey);
    const { folder, name } = splitKey(key);
    // A rerun reuses the tab of the finished run of the same configuration, like IntelliJ.
    let run = this.runs.find(r => r.key === key && !r.running);
    const meta = {
      key, folder, name,
      title: session.name || name,
      kind: kindOf(config),
      running: true,
      debug: !config.noDebug,
      exitCode: undefined,
      terminal: config.console === 'integratedTerminal',
      input: config.type === 'script-run',
      started: Date.now(),
      session,
    };
    if (run) {
      Object.assign(run, meta, { spans: [], size: 0, converters: new Map() });
    } else {
      run = { id: `run${this.nextId++}`, ...meta, spans: [], size: 0, converters: new Map() };
      this.runs.push(run);
    }
    this.bySession.set(session.id, run);
    if (run.terminal) {
      this.appendSystem(run, t('Running in the integrated terminal.'));
    }
    this.changed.fire(run);
    this.started.fire(run);
    return run;
  }

  private append(run: Run, text: string, category: string): void {
    if (!run.debug) {
      // js-debug attaches to child processes even without debugging (to capture their output); IntelliJ's Run
      // window doesn't show node's attach/detach notices.
      text = text.replace(/^(?:Debugger attached\.|Waiting for the debugger to disconnect\.\.\.)\r?\n/gm, '');
      if (!text) { return; }
    }
    let conv = run.converters.get(category);
    if (!conv) {
      conv = new AnsiConverter();
      run.converters.set(category, conv);
    }
    const spans = conv.convert(text);
    if (category === 'stderr') {
      for (const s of spans) { s.cls = s.cls ? `${s.cls} stderr` : 'stderr'; }
    }
    this.push(run, spans);
  }

  private appendSystem(run: Run, text: string): void {
    this.push(run, [{ text: `\n${text}\n`, cls: 'sys' }]);
  }

  private push(run: Run, spans: Span[]): void {
    if (!spans.length) { return; }
    run.spans.push(...spans);
    run.size += spans.reduce((n, s) => n + s.text.length, 0);
    let dropped = false;
    while (run.size > MAX_CHARS && run.spans.length > 1) {
      run.size -= run.spans.shift()!.text.length;
      dropped = true;
    }
    if (dropped) {
      this.changed.fire(run);
    }
    this.appended.fire({ run, spans });
  }

  clear(id: string): void {
    const run = this.get(id);
    if (!run) { return; }
    run.spans = [];
    run.size = 0;
    this.changed.fire(run);
  }

  /** Closes a finished run's tab. */
  remove(id: string): void {
    const i = this.runs.findIndex(r => r.id === id);
    if (i < 0 || this.runs[i].running) { return; }
    this.runs.splice(i, 1);
    this.changed.fire(undefined);
  }

  /** Text typed in the Run window → the process stdin (script adapter `evaluate`). */
  async sendInput(id: string, text: string): Promise<void> {
    const run = this.get(id);
    if (!run?.session || !run.input) { return; }
    this.push(run, [{ text: text + '\n', cls: 'input' }]);
    await run.session.customRequest('evaluate', { expression: text, context: 'repl' });
  }
}

export function meta(run: Run): RunMeta {
  const { session: _s, spans: _sp, size: _sz, converters: _c, ...m } = run;
  return m;
}
