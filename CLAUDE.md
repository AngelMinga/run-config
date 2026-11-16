# CLAUDE.md

## What it is

VS Code extension that brings IntelliJ/WebStorm **run configurations** (npm, Flutter and scripts): status bar selector + Run/Debug/Stop, a "Run/Debug Configurations" webview dialog, Node.js runtime/package manager detection, IntelliJ shortcuts (`⌃R`, `⌃D`, `⌘F2`) and import from `.idea`. Published as `angelminga.run-configurations`. **Code, comments and docs are in English. User-facing text is localized**: `vscode.l10n.t` uses the English text as key → add new strings to `l10n/bundle.l10n.es.json`; every `%key%` of `package.json` goes to `package.nls.json` **and** `package.nls.es.json`. Strings used by `media/editor.js` are listed in `strings()` in `src/editor.ts`.

## Structure

```text
src/
├── extension.ts  # activation, `npm-run` DebugConfigurationProvider, sessions, status bar, quick pick, IntelliJ import, commands
├── editor.ts     # Run/Debug Configurations webview panel (messages ↔ media/editor.js)
├── store.ts      # configurations: `.vscode/launch.json` (jsonc-parser edits, comments kept) or workspaceState
├── model.ts      # RunConfig ↔ launch.json entry, arg/env parsing, RunConfig → js-debug `node` launch   (pure)
├── project.ts    # "Project" node (.nvmrc/.node-version) and package manager (packageManager/lockfile)   (pure)
├── detect.ts     # node / npm / pnpm / yarn / bun discovery and `--version`                                (pure)
├── scriptAdapter.ts # inline debug adapter for `script-run`: spawns the script, streams output, stdin from the console, kills the process group (no vscode import, unit tested)
├── beforeLaunch.ts # Before-launch steps (config / npm / task / browser): launch.json + IntelliJ `<method>` parsing, validation (pure)
├── beforeLaunchRunner.ts # runs the steps in order from each resolver (progress, cancel, cycle guard, waits for tasks/sessions)
├── entryPoints.ts # where ▷ CodeLens go: package.json scripts, Dart main, Python __main__, shell        (pure)
├── dotenv.ts     # `.env` parsing (quotes, multi-line, ${VAR}) and env merge                            (pure)
├── runAnything.ts # Run Anything quick pick: typed command → `script-run` through the shell, history in workspaceState
├── runs.ts       # RunsModel: one run per top-level session (key `__runConfigKey`), output captured with a '*' DebugAdapterTracker (child sessions included), 2 MB per run
├── runView.ts    # "Run" webview view (panel container `runConfigurations`): tabs, rerun/stop/clear/hot reload, stdin → `evaluate`; appends batched every 50 ms
├── services.ts   # "Services" tree: configurations by kind, running state, inline actions
├── ansi.ts       # ANSI SGR → spans (text + classes/hex colours) kept across chunks                       (pure)
├── devices.ts    # Flutter device selector: `flutter devices --machine` (≈15 s, cached + background refresh), emulators
├── flutter.ts    # flutter binary lookup, devices/emulators parsing                                        (pure)
├── intellijExport.ts # RunConfig → IntelliJ `.run/<name>.run.xml` (every kind; must round-trip through intellij.ts) (pure)
├── intellij.ts   # `js.build_tools.npm` XML parsing, `.idea` / `.run` discovery                            (pure)
└── test/         # node:test unit tests for the pure modules
media/run.js, run.css         # Run window UI; output is only ever set with textContent
media/editor.js, editor.css   # dialog UI (opened in a floating window via workbench.action.moveEditorToNewWindow), plain DOM, VS Code theme variables
```

## How a configuration runs

`npm-run` is a contributed debug type with no adapter: `resolveDebugConfiguration` turns it into a js-debug `node` launch (`runtimeExecutable` = package manager, `runtimeArgs` = command + scripts + args, chosen node's dir prepended to PATH, `NODE_OPTIONS`, `console: integratedTerminal`). VS Code then resolves the new type. Run = `noDebug`. `flutter-run` works the same way into a Dart-Code `dart` launch (`program`, `cwd` = pubspec.yaml dir, `toolArgs` = run args + `--flavor`); `deviceId` = device picked in `DeviceService` (none → Dart-Code's own). *Flutter Attach* sets `attach: true` → `request: attach` with `attachArgs`; it never stops the running app and uses the key `folder::name::attach`. `script-run` keeps its type: `buildScriptLaunch` resolves interpreter (`resolveInterpreter`: configured, else by extension, `.py` → `venv/`/`.venv/` Python), args, `cwd` (working dir or the script's) and env, and `ScriptDebugAdapter` (registered with `DebugAdapterInlineImplementation`) runs it. `compound-run` has no session of its own: its resolver (and `launch()`) start the members (`expandCompound`: nested compounds flattened, cycles ignored) and return undefined; running/stop of a compound = its members' keys. With `runConfigurations.runWindow`, our launches set `internalConsoleOptions: neverOpen` (except terminal output) and the Run window shows the output. Each resolver (npm, script, Flutter) loads `envFile` into `env` (`loadEnvFile`), asks *Stop and Rerun?* when the key is running (`confirmRerun`, skipped with `__confirmed` from Rerun buttons and compounds), then runs `beforeLaunch` (`runBeforeLaunch`); `preLaunchTask` is migrated to a `task` step on load. CodeLens ▷ call `runConfigurations.runEntry` with a candidate config: an equivalent one (`sameRun`) is reused, else a `temporary` private one is added (5 kept). Templates (`store.templates()`, workspaceState) fill `TEMPLATE_FIELDS` of new configurations (dialog and ▷ temporaries). `group` is the list folder; the dialog's order is written back to launch.json by reusing our entries' slots. `node-run`, `attach-run`, `test-run` and `docker-run` share `registerRunType` (env file, rerun question, before launch, single instance) and build a js-debug `node` launch/attach (`buildNodeFileLaunch`, `buildAttachLaunch`, `buildTestLaunch` with the runner from `findTestRunner`) or a resolved `script-run` (`buildDockerLaunch`). `RunConfig.kind` tells them apart; `normalize()` upgrades configurations saved before a field existed. Without *Allow multiple instances*, running sessions with the same `__runConfigKey` (`folder::name`) are stopped first.

## Commands

```bash
npm install
npm test          # pure modules: tsc -p tsconfig.test.json + node --test
npm run typecheck
npm run build     # esbuild → dist/extension.js (bundles jsonc-parser)
npm run package   # → run-configurations-<version>.vsix
```

F5 opens an Extension Development Host (`.vscode/launch.json`).
