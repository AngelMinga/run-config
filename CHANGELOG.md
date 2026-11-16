# Changelog

## 0.5.0

- **Services panel** like IntelliJ: a *Services* tree with every configuration by type (running ones highlighted, inline Run/Debug/Stop/Edit, Stop All) and a *Run* window with one tab per run: captured output with ANSI colours, Rerun, Debug, Stop, Hot Reload/Restart (Flutter), scroll-to-end, soft-wrap, clear and stdin for scripts.
- **Compound** configurations: start several configurations at once; Stop and Run/Debug act on all of them, nested compounds are flattened. `compound-run` launch type, IntelliJ `CompoundRunConfigurationType` import, and renames update the compounds that reference them.
- New setting `runConfigurations.runWindow`.

## 0.4.2

- Performance: launch.json is parsed once and cached (invalidated by the file watcher and on save) instead of on every status bar refresh.
- The status bar only refreshes when one of its own debug sessions ends.
- Node.js runtime detection runs at startup only in workspaces with npm configurations; elsewhere on demand.

## 0.4.1

- `runConfigurations.npmConsole`: npm configurations (and *Current File* for JavaScript) can print to the Debug Console, like IntelliJ's Run window, instead of the integrated terminal. In the Debug Console the output of every process is captured (`outputCapture: "std"`) and colours are kept (`FORCE_COLOR=1`). Default stays the terminal.

## 0.4.0

- **Script configurations** (like IntelliJ's Python / Shell Script): script path, options, interpreter, working directory and environment. Empty interpreter → chosen from the extension (`.py` → `venv/` or `.venv/` Python, else `python3`; `.sh` → `bash`; `.js` → `node`).
- They run through an inline debug adapter (`script-run`): output in the Run window (Debug Console), typing there writes to the script's stdin, Stop ends the whole process group, and ▶ / ⌃R / Rerun / ⌘F2 work as for the other kinds.

## 0.3.2

- The device button shows the device a run will really use: the one picked here, else the Flutter extension's device (polled, it has no change event), else *No device*.
- Devices and emulators whose platform folder is missing in the project (e.g. `macos/`, `web/`) are listed last, marked *not supported by this project*, and ask for confirmation before being picked.

## 0.3.1

- The Flutter device selector shows in any Flutter project (pubspec.yaml), even before a configuration exists.
- The status bar selector always opens the picker; with no configurations it offers the IntelliJ import first.

## 0.3.0

- Flutter device selector (status bar, selector, editor run menu) from `flutter devices`, with *Open Emulator* and refresh; the chosen device is passed as `deviceId`.
- *Flutter Attach* and *Additional attach args*, also imported from IntelliJ.

## 0.2.0

- Flutter run configurations (Dart entrypoint, run args, build flavor, environment), run through the Dart extension; `flutter-run` launch type and import from IntelliJ.
- The Run/Debug Configurations dialog opens in its own floating window (`runConfigurations.floatingDialog`).
- `+` opens an *Add New Configuration* menu (npm / Flutter).
- *Select Flutter Device…* in the selector; *Current File* also runs `.dart` files.

## 0.1.1

- Run, Debug and Edit Configurations always available in the editor title run menu.
- Run configuration selector button in the Explorer title bar, so it can be found with the status bar hidden.

## 0.1.0

- First version: status bar selector, Run/Debug Configurations dialog, Node.js runtime and package manager detection, IntelliJ shortcuts, `npm-run` launch type and import from IntelliJ.
