# Changelog

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
