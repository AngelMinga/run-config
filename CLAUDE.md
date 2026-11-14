# CLAUDE.md

## What it is

VS Code extension that brings IntelliJ/WebStorm **run configurations** (npm and Flutter): status bar selector + Run/Debug/Stop, a "Run/Debug Configurations" webview dialog, Node.js runtime/package manager detection, IntelliJ shortcuts (`⌃R`, `⌃D`, `⌘F2`) and import from `.idea`. Published as `angelminga.run-configurations`. **Code, comments and docs are in English. User-facing text is localized**: `vscode.l10n.t` uses the English text as key → add new strings to `l10n/bundle.l10n.es.json`; every `%key%` of `package.json` goes to `package.nls.json` **and** `package.nls.es.json`. Strings used by `media/editor.js` are listed in `strings()` in `src/editor.ts`.

## Structure

```text
src/
├── extension.ts  # activation, `npm-run` DebugConfigurationProvider, sessions, status bar, quick pick, IntelliJ import, commands
├── editor.ts     # Run/Debug Configurations webview panel (messages ↔ media/editor.js)
├── store.ts      # configurations: `.vscode/launch.json` (jsonc-parser edits, comments kept) or workspaceState
├── model.ts      # RunConfig ↔ launch.json entry, arg/env parsing, RunConfig → js-debug `node` launch   (pure)
├── project.ts    # "Project" node (.nvmrc/.node-version) and package manager (packageManager/lockfile)   (pure)
├── detect.ts     # node / npm / pnpm / yarn / bun discovery and `--version`                                (pure)
├── devices.ts    # Flutter device selector: `flutter devices --machine` (≈15 s, cached + background refresh), emulators
├── flutter.ts    # flutter binary lookup, devices/emulators parsing                                        (pure)
├── intellij.ts   # `js.build_tools.npm` XML parsing, `.idea` / `.run` discovery                            (pure)
└── test/         # node:test unit tests for the pure modules
media/editor.js, editor.css   # dialog UI (opened in a floating window via workbench.action.moveEditorToNewWindow), plain DOM, VS Code theme variables
```

## How a configuration runs

`npm-run` is a contributed debug type with no adapter: `resolveDebugConfiguration` turns it into a js-debug `node` launch (`runtimeExecutable` = package manager, `runtimeArgs` = command + scripts + args, chosen node's dir prepended to PATH, `NODE_OPTIONS`, `console: integratedTerminal`). VS Code then resolves the new type. Run = `noDebug`. `flutter-run` works the same way into a Dart-Code `dart` launch (`program`, `cwd` = pubspec.yaml dir, `toolArgs` = run args + `--flavor`); `deviceId` = device picked in `DeviceService` (none → Dart-Code's own). *Flutter Attach* sets `attach: true` → `request: attach` with `attachArgs`; it never stops the running app and uses the key `folder::name::attach`. `RunConfig.kind` tells them apart; `normalize()` upgrades configurations saved before a field existed. Without *Allow multiple instances*, running sessions with the same `__runConfigKey` (`folder::name`) are stopped first.

## Commands

```bash
npm install
npm test          # pure modules: tsc -p tsconfig.test.json + node --test
npm run typecheck
npm run build     # esbuild → dist/extension.js (bundles jsonc-parser)
npm run package   # → run-configurations-<version>.vsix
```

F5 opens an Extension Development Host (`.vscode/launch.json`).
