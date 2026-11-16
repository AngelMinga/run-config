# Run Configurations (IntelliJ-style)

IntelliJ / WebStorm-style **run configurations** for VS Code: **npm**, **Flutter**, **Script** (Python, shell, Node…) and **Compound**.

- **Selector in the status bar** with the active configuration and ▷ Run, 🐞 Debug and ■ Stop buttons.
- **Run/Debug Configurations dialog**, in its own floating window like IntelliJ (`runConfigurations.floatingDialog`), with `+` → *npm* / *Flutter*. npm has the same fields as IntelliJ: name, *Allow multiple instances*, *Store as project file*, package.json, command, scripts, arguments, Node runtime, Node options, package manager, environment and *Before launch*.
- **Flutter**: Dart entrypoint, additional `flutter run` / `flutter attach` args, build flavor and environment variables. Runs through the Dart/Flutter extension.
- **Flutter device selector** like IntelliJ's (status bar, selector and editor run menu): connected devices from `flutter devices`, *Open Emulator* for Android emulators / iOS Simulator, or the Dart extension's own device. **Flutter Attach** connects to an app that is already running.
- **Script** configurations (Python, shell, Ruby, Node…): script path, options, interpreter (empty: chosen from the extension, `venv/`/`.venv/` Python for `.py`), working directory and environment.
- **Compound** configurations: start several configurations at once (e.g. API + web), like IntelliJ's Compound. ■ Stop and ▷ Run/🐞 Debug act on all of them; nested compounds work.
- **Services** panel (bottom panel, like IntelliJ's Services + Run tool windows):
  - **Services**: every configuration grouped by type; running ones in green with inline ▷ / 🐞 / ■ and *Edit Configuration…*.
  - **Run**: one tab per run with its output (ANSI colours, stderr in red), ↻ Rerun, 🐞 Debug, ■ Stop, Hot Reload / Hot Restart for Flutter, scroll-to-end, soft-wrap, clear, and an input line for scripts that read stdin. A rerun reuses its tab. npm configurations printing to the integrated terminal (`runConfigurations.npmConsole`) keep their output there.
- **▷ Run | Debug in the editor** (CodeLens, VS Code's take on IntelliJ's gutter icons) above `package.json` scripts, Dart `main()` in Flutter apps, Python `if __name__ == "__main__"` and shell scripts. They reuse an equivalent configuration or create a **temporary** one (the last 5 are kept, shown in italics) that you can **Save** from the selector, Services or the dialog.
- **Before launch** like IntelliJ: an ordered list of steps — *Run Another Configuration* (waits until it ends), *Run npm script*, *Run VS Code Task* and *Launch Web Browser*. A failing or cancelled step cancels the launch; steps are imported from IntelliJ and an old `preLaunchTask` becomes a task step.
- **Env file** per configuration (npm, Flutter, Script): a `.env` in dotenv format loaded before launch; the configuration's own variables override it.
- **Templates** (*Edit configuration templates…* at the bottom of the dialog's list): default values for new npm, Flutter and Script configurations, also used by the ▷ temporaries.
- **Stop and Rerun?** — running a configuration that is already running asks first (*Stop and Rerun* / *Don't Ask Again*), unless it allows multiple instances. Compounds ask once; the Run window's Rerun never asks.
- **Folders and order** in the dialog's list: *Move into New Folder* (rename with a double-click), drag & drop or Alt+↑/↓ to reorder. Order and folders are kept in launch.json (`group`) and shown in Services and the selector.
- **Run Anything** (`⌃⌥⇧R`, or the terminal icon in Services): type any command (`pnpm dev`, `flutter doctor`, `python main.py`…) and it runs in the Run window with the project's node first in PATH; also offers recent commands, configurations and `package.json` scripts. (IntelliJ's double-Ctrl can't be bound in VS Code.)
- **Detected Node.js runtimes and package managers** (nvm, fnm, volta, asdf, mise, Homebrew, PATH) with their versions. *Project* uses `.nvmrc` / `.node-version` and the project's lockfile or `packageManager` field.
- **IntelliJ shortcuts**: `⌃R` run, `⌃D` debug, `⌘F2` stop, `⌃⌥R` choose configuration (macOS); `Shift+F10`, `Shift+F9`, `Ctrl+F2`, `Alt+Shift+F10` on Windows/Linux.
- **Import from IntelliJ** (npm and Flutter): reads `.idea/workspace.xml`, `.idea/runConfigurations/*.xml` and `.run/*.run.xml`.
- Runs through VS Code's JavaScript debugger, so **Debug** stops at breakpoints, including child processes.

## Where configurations are stored

| *Store as project file* | Location |
|---|---|
| off (default) | Private workspace state (not committed), like IntelliJ's `workspace.xml` |
| on | `.vscode/launch.json` of the folder, as an `npm-run` entry (paths become `${workspaceFolder}` / `${userHome}`) |

`npm-run` entries also appear in VS Code's own *Run and Debug* view and start with F5:

```jsonc
{
  "type": "npm-run",
  "request": "launch",
  "name": "bancapersonas start",
  "packageJson": "${workspaceFolder}/bancapersonas/package.json",
  "command": "start",
  "packageManager": "pnpm"
}
```

Other `launch.json` configurations and compounds appear in the selector too, so `⌃R` runs them as well.

## Shortcut notes

On macOS, `⌃D` replaces VS Code's *delete right* in the editor and `⌃R` replaces *Open Recent*, as in IntelliJ. Terminals still receive both keys. To change them, open *Preferences: Open Keyboard Shortcuts* and search for `runConfigurations`.

## Settings

| Setting | Default | |
|---|---|---|
| `runConfigurations.defaultNodeRuntime` | `""` | Node binary for *Project* when there is no `.nvmrc` (empty: `node` on PATH) |
| `runConfigurations.showStatusBar` | `true` | Status bar selector and buttons |
| `runConfigurations.confirmRerun` | `true` | Ask before stopping and rerunning a running configuration |
| `runConfigurations.codeLens` | `true` | ▷ Run / Debug above runnable code |
| `runConfigurations.runWindow` | `true` | Output in the Run window instead of popping the Debug Console |
| `runConfigurations.floatingDialog` | `true` | Open the dialog in its own window (off: editor tab) |
| `runConfigurations.offerIntellijImport` | `true` | Offer the import when a workspace has no configurations |
