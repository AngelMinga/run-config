# Run Configurations (IntelliJ-style)

IntelliJ / WebStorm-style **run configurations** for VS Code: **npm** and **Flutter**.

- **Selector in the status bar** with the active configuration and ▷ Run, 🐞 Debug and ■ Stop buttons.
- **Run/Debug Configurations dialog**, in its own floating window like IntelliJ (`runConfigurations.floatingDialog`), with `+` → *npm* / *Flutter*. npm has the same fields as IntelliJ: name, *Allow multiple instances*, *Store as project file*, package.json, command, scripts, arguments, Node runtime, Node options, package manager, environment and *Before launch*.
- **Flutter**: Dart entrypoint, additional `flutter run` / `flutter attach` args, build flavor and environment variables. Runs through the Dart/Flutter extension.
- **Flutter device selector** like IntelliJ's (status bar, selector and editor run menu): connected devices from `flutter devices`, *Open Emulator* for Android emulators / iOS Simulator, or the Dart extension's own device. **Flutter Attach** connects to an app that is already running.
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
| `runConfigurations.floatingDialog` | `true` | Open the dialog in its own window (off: editor tab) |
| `runConfigurations.offerIntellijImport` | `true` | Offer the import when a workspace has no configurations |
