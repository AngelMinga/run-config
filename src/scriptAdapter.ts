import { ChildProcess, spawn } from 'node:child_process';

/** Minimal Debug Adapter Protocol message (enough for this adapter; no `vscode` import so it can be unit tested). */
export interface DapMessage {
  seq: number;
  type: 'request' | 'response' | 'event';
  command?: string;
  event?: string;
  arguments?: Record<string, unknown>;
  [key: string]: unknown;
}

interface Disposable { dispose(): void }
type Listener = (m: DapMessage) => void;

/** Launch arguments built by `buildScriptLaunch` (model.ts). */
export interface ScriptLaunchArgs {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

/** How long a script gets after SIGTERM before SIGKILL, like IntelliJ's graceful stop. */
const KILL_GRACE_MS = 2000;

/**
 * Inline debug adapter for `script-run`: runs the script as a child process and streams its output to the
 * Debug Console (the "Run" window). Typing in the console writes to the script's stdin. Stop kills the whole
 * process group. There is no stepping or breakpoints: Run and Debug behave the same.
 */
export class ScriptDebugAdapter implements Disposable {
  private seq = 1;
  private readonly listeners = new Set<Listener>();
  private child?: ChildProcess;
  private killTimer?: ReturnType<typeof setTimeout>;
  private terminated = false;

  /** `vscode.DebugAdapter.onDidSendMessage` shape: subscribe, get a disposable back. */
  readonly onDidSendMessage = (listener: Listener): Disposable => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  handleMessage(message: DapMessage): void {
    if (message.type !== 'request' || !message.command) { return; }
    const args = (message.arguments ?? {}) as Record<string, unknown>;
    switch (message.command) {
      case 'initialize':
        this.respond(message, { supportsTerminateRequest: true, supportsConfigurationDoneRequest: true });
        this.emit('initialized');
        return;
      case 'launch':
        this.respond(message);
        this.launch(args as unknown as ScriptLaunchArgs);
        return;
      case 'threads':
        this.respond(message, { threads: [] });
        return;
      case 'evaluate':
        // Text typed in the Debug Console goes to the script's stdin (answers to input() prompts, etc.).
        if (this.child?.stdin?.writable && typeof args.expression === 'string') {
          this.child.stdin.write(args.expression + '\n');
        }
        this.respond(message, { result: '', variablesReference: 0 });
        return;
      case 'terminate':
      case 'disconnect':
        this.respond(message);
        this.kill();
        return;
      default:
        this.respond(message);
    }
  }

  dispose(): void {
    this.kill();
    this.listeners.clear();
  }

  private launch(a: ScriptLaunchArgs): void {
    const args = Array.isArray(a.args) ? a.args.map(String) : [];
    this.output('console', `${[a.command, ...args].map(quote).join(' ')}\n`);
    let child: ChildProcess;
    try {
      child = spawn(a.command, args, {
        cwd: a.cwd || undefined,
        env: { ...process.env, ...(a.env ?? {}) },
        // Own process group, so Stop also ends the processes the script starts.
        detached: this.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      this.output('stderr', `${e instanceof Error ? e.message : String(e)}\n`);
      this.finish(1);
      return;
    }
    this.child = child;
    child.stdout?.on('data', (d: Buffer) => this.output('stdout', d.toString()));
    child.stderr?.on('data', (d: Buffer) => this.output('stderr', d.toString()));
    child.on('error', err => {
      this.output('stderr', `${err.message}\n`);
      this.finish(1);
    });
    child.on('close', (code, signal) => {
      this.finish(code ?? (signal ? 130 : 0), signal ?? undefined);
    });
  }

  private finish(code: number, signal?: string): void {
    if (this.terminated) { return; }
    this.terminated = true;
    if (this.killTimer) { clearTimeout(this.killTimer); }
    this.output('console', signal
      ? `\nProcess finished with signal ${signal}\n`
      : `\nProcess finished with exit code ${code}\n`);
    this.emit('exited', { exitCode: code });
    this.emit('terminated');
  }

  private kill(): void {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) {
      if (!this.child) { this.finish(0); }
      return;
    }
    const signal = (sig: NodeJS.Signals) => {
      try {
        if (this.platform !== 'win32') { process.kill(-child.pid!, sig); } else { child.kill(sig); }
      } catch { /* already gone */ }
    };
    signal('SIGTERM');
    this.killTimer = setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS);
    this.killTimer.unref?.();
  }

  private output(category: 'console' | 'stdout' | 'stderr', text: string): void {
    this.emit('output', { category, output: text });
  }

  private respond(request: DapMessage, body: Record<string, unknown> = {}): void {
    this.send({ seq: 0, type: 'response', request_seq: request.seq, success: true, command: request.command, body });
  }

  private emit(event: string, body?: Record<string, unknown>): void {
    this.send({ seq: 0, type: 'event', event, ...(body ? { body } : {}) });
  }

  private send(m: DapMessage): void {
    m.seq = this.seq++;
    for (const l of [...this.listeners]) { l(m); }
  }
}

function quote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}
