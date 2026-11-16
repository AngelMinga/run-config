import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { Span } from './ansi';
import { meta, Run, RunsModel } from './runs';

const t = vscode.l10n.t;

export interface RunViewActions {
  rerun(run: Run, debug: boolean): Promise<void>;
  stop(run: Run): Promise<void>;
  showTerminal(run: Run): void;
}

type Incoming =
  | { type: 'ready' }
  | { type: 'activate'; id: string }
  | { type: 'close'; id: string }
  | { type: 'rerun'; id: string; debug?: boolean }
  | { type: 'stop'; id: string }
  | { type: 'clear'; id: string }
  | { type: 'stdin'; id: string; text: string }
  | { type: 'terminal'; id: string }
  | { type: 'hot'; id: string; restart: boolean };

function strings(): Record<string, string> {
  const keys = [
    'Rerun', 'Debug', 'Stop', 'Clear All', 'Scroll to the End', 'Soft-Wrap', 'Hot Reload', 'Hot Restart', 'Show Terminal',
    'Close', 'Running', 'Finished', 'Exit code {0}', 'Type input for the process and press Enter',
    'Nothing has run yet. Run a configuration with ⌃R, the ▷ button or the Services view.',
    'The output of this configuration is in the integrated terminal.',
  ];
  return Object.fromEntries(keys.map(k => [k, t(k)]));
}

/** IntelliJ's Run tool window: one tab per run with its output, rerun/stop/clear and stdin for scripts. */
export class RunViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'runConfigurations.output';
  private view?: vscode.WebviewView;
  private active?: string;
  private pending = new Map<string, Span[]>();
  private flushTimer?: ReturnType<typeof setTimeout>;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly extensionUri: vscode.Uri, private readonly runs: RunsModel, private readonly actions: RunViewActions) {
    this.disposables.push(
      runs.onDidAppend(({ run, spans }) => this.queue(run.id, spans)),
      runs.onDidChange(run => {
        if (run) {
          // A rerun reusing a tab resets its content: resend it whole.
          this.post({ type: 'meta', run: meta(run) });
        } else {
          this.sendState();
        }
      }),
      runs.onDidStart(run => {
        this.pending.delete(run.id);
        this.active = run.id;
        this.post({ type: 'reset', run: meta(run), spans: run.spans, activate: true });
        if (!run.terminal && vscode.workspace.getConfiguration('runConfigurations').get<boolean>('runWindow', true)) {
          this.reveal();
        }
      }),
    );
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
    if (this.flushTimer) { clearTimeout(this.flushTimer); }
  }

  /** Shows the Run window without taking the focus from the editor. */
  reveal(id?: string): void {
    if (id) {
      this.active = id;
      this.post({ type: 'activate', id });
    }
    if (this.view) {
      this.view.show(true);
    } else {
      void vscode.commands.executeCommand(`${RunViewProvider.viewId}.focus`, { preserveFocus: true });
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.onDidDispose(() => { this.view = undefined; });
    view.webview.onDidReceiveMessage((m: Incoming) => this.onMessage(m).catch(err => {
      void vscode.window.showErrorMessage(String(err instanceof Error ? err.message : err));
    }));
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private queue(id: string, spans: Span[]): void {
    if (!this.view) { return; }
    const list = this.pending.get(id);
    if (list) { list.push(...spans); } else { this.pending.set(id, [...spans]); }
    // Dev servers can print a lot: batch into one message every 50 ms.
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = undefined;
      for (const [runId, batch] of this.pending) { this.post({ type: 'append', id: runId, spans: batch }); }
      this.pending.clear();
    }, 50);
  }

  private sendState(): void {
    this.pending.clear();
    const runs = this.runs.list();
    if (this.active && !runs.some(r => r.id === this.active)) { this.active = runs[runs.length - 1]?.id; }
    this.post({ type: 'state', runs: runs.map(r => ({ ...meta(r), spans: r.spans })), active: this.active });
  }

  private async onMessage(m: Incoming): Promise<void> {
    if (m.type === 'ready') {
      this.post({ type: 'strings', strings: strings() });
      this.sendState();
      return;
    }
    const run = this.runs.get(m.id);
    if (!run) { return; }
    switch (m.type) {
      case 'activate': this.active = m.id; return;
      case 'close': this.runs.remove(m.id); return;
      case 'clear':
        this.runs.clear(m.id);
        this.post({ type: 'reset', run: meta(run), spans: [] });
        return;
      case 'rerun': return this.actions.rerun(run, m.debug ?? run.debug);
      case 'stop': return this.actions.stop(run);
      case 'stdin': return this.runs.sendInput(m.id, m.text);
      case 'terminal': this.actions.showTerminal(run); return;
      case 'hot':
        // Dart-Code's debug adapter takes these as custom requests on the session itself (only this app reloads).
        if (run.session) {
          await run.session.customRequest(m.restart ? 'hotRestart' : 'hotReload', { reason: 'manual' });
        }
        return;
    }
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'run.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'run.css'));
    return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
