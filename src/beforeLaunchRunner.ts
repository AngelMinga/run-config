import * as path from 'node:path';
import * as vscode from 'vscode';
import { BeforeLaunchStep, describeStep } from './beforeLaunch';
import { configKey, RunConfig } from './model';

const t = vscode.l10n.t;
/** Task type contributed in package.json for the "Run npm script" step. */
export const TASK_TYPE = 'runConfigurations';

export interface BeforeLaunchHost {
  /** Starts a configuration of `folder` without debugging and resolves when it ends; false if it didn't start. */
  runAndWait(folder: string, name: string, token: vscode.CancellationToken): Promise<boolean>;
  /** Package manager executable and environment (chosen node first in PATH) for a package.json. */
  npmCommand(packageJson: string, folder: string): Promise<{ command: string; env: Record<string, string> }>;
}

/** Configurations whose before-launch steps are running: a step that would start one of them again is a cycle. */
const running = new Set<string>();

function waitForTask(execution: vscode.TaskExecution, token: vscode.CancellationToken): Promise<number | undefined> {
  return new Promise(resolve => {
    const subs: vscode.Disposable[] = [];
    const done = (code: number | undefined) => { subs.forEach(d => d.dispose()); resolve(code); };
    subs.push(
      vscode.tasks.onDidEndTaskProcess(e => { if (e.execution === execution) { done(e.exitCode ?? 0); } }),
      // Tasks without a process (custom executions) only report the end of the task.
      vscode.tasks.onDidEndTask(e => { if (e.execution === execution) { done(0); } }),
      token.onCancellationRequested(() => { execution.terminate(); done(-1); }),
    );
  });
}

async function runTask(task: vscode.Task, token: vscode.CancellationToken): Promise<string | undefined> {
  const execution = await vscode.tasks.executeTask(task);
  if (task.isBackground) {
    // Watchers never end: IntelliJ-like "start it and go on" instead of hanging the launch.
    return undefined;
  }
  const code = await waitForTask(execution, token);
  return code === 0 ? undefined : t('"{0}" failed with exit code {1}.', task.name, code ?? '?');
}

async function runStep(c: RunConfig, step: BeforeLaunchStep, host: BeforeLaunchHost, token: vscode.CancellationToken): Promise<string | undefined> {
  const folder = vscode.workspace.workspaceFolders?.find(f => f.uri.fsPath === c.folder);
  switch (step.type) {
    case 'config': {
      if (step.name === c.name || running.has(configKey({ folder: c.folder, name: step.name }))) {
        return t('"{0}" would run itself before launch (cycle).', step.name);
      }
      return await host.runAndWait(c.folder, step.name, token) ? undefined : t('Could not start "{0}".', step.name);
    }
    case 'npm': {
      const { command, env } = await host.npmCommand(step.packageJson, c.folder);
      const task = new vscode.Task(
        { type: TASK_TYPE, script: step.script, packageJson: step.packageJson },
        folder ?? vscode.TaskScope.Workspace,
        step.script,
        'Run Configurations',
        new vscode.ProcessExecution(command, ['run', step.script], { cwd: path.dirname(step.packageJson), env }),
      );
      task.presentationOptions = { reveal: vscode.TaskRevealKind.Silent, clear: true };
      return runTask(task, token);
    }
    case 'task': {
      const tasks = await vscode.tasks.fetchTasks();
      const task = tasks.find(x => x.name === step.name && (!folder || x.scope === folder || typeof x.scope !== 'object'))
        ?? tasks.find(x => `${x.source}: ${x.name}` === step.name || x.name === step.name);
      return task ? runTask(task, token) : t('VS Code task "{0}" not found.', step.name);
    }
    case 'browser':
      await vscode.env.openExternal(vscode.Uri.parse(step.url));
      return undefined;
  }
}

/** Runs the before-launch steps of `c` in order; false (with an error shown) if one fails or is cancelled. */
export async function runBeforeLaunch(c: RunConfig, host: BeforeLaunchHost): Promise<boolean> {
  if (!c.beforeLaunch.length) { return true; }
  const key = configKey(c);
  running.add(key);
  try {
    return await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: t('Before launch: {0}', c.name),
      cancellable: true,
    }, async (progress, token) => {
      for (const [i, step] of c.beforeLaunch.entries()) {
        if (token.isCancellationRequested) { return false; }
        progress.report({ message: `${i + 1}/${c.beforeLaunch.length} · ${describeStep(step)}` });
        const error = await runStep(c, step, host, token);
        if (token.isCancellationRequested) { return false; }
        if (error) {
          void vscode.window.showErrorMessage(t('Before launch of "{0}" stopped: {1}', c.name, error));
          return false;
        }
      }
      return true;
    });
  } finally {
    running.delete(key);
  }
}
