import * as os from 'node:os';
import * as vscode from 'vscode';
import { deviceIcon, devicePlatformKey, findFlutter, FlutterDevice, FlutterEmulator, isDeviceSupported, parseDevices, parseEmulators, projectPlatforms, ProjectPlatform, runFlutter } from './flutter';

const t = vscode.l10n.t;
const SELECTED_KEY = 'runConfigurations.flutterDevice';

export interface SelectedDevice {
  id: string;
  name: string;
  platform: string;
}

/** Device that a Flutter run will actually use. */
export interface EffectiveDevice {
  device?: SelectedDevice;
  /** `own`: picked here · `dart`: the Flutter extension's device · `none`: nothing selected anywhere. */
  source: 'own' | 'dart' | 'none';
  supported: boolean;
}

const DART_POLL_MS = 4000;

/** IntelliJ-style Flutter device selector, backed by `flutter devices --machine` (slow: cached, refreshed in background). */
export class DeviceService implements vscode.Disposable {
  private devices?: FlutterDevice[];
  private emulators?: FlutterEmulator[];
  private refreshing?: Promise<void>;
  private dartDeviceId?: string;
  private dartTimer?: ReturnType<typeof setInterval>;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  /** @param projectRoots Flutter project roots (folders with pubspec.yaml) used to tell supported devices apart. */
  constructor(private readonly state: vscode.Memento, private readonly projectRoots: () => string[] = () => []) {}

  dispose(): void {
    if (this.dartTimer) { clearInterval(this.dartTimer); }
    this.changed.dispose();
  }

  /** Platform folders of the open Flutter projects (`android`, `ios`…); empty when unknown. */
  platforms(): Set<ProjectPlatform> {
    return projectPlatforms(this.projectRoots());
  }

  isSupported(platform: string): boolean {
    return isDeviceSupported(platform, this.platforms());
  }

  /** The device a run will use: ours, else the Flutter extension's one. */
  effective(): EffectiveDevice {
    const own = this.selected();
    if (own) { return { device: own, source: 'own', supported: this.isSupported(own.platform) }; }
    if (this.dartDeviceId) {
      const known = this.devices?.find(d => d.id === this.dartDeviceId);
      const device = known
        ? { id: known.id, name: known.name, platform: known.platform }
        : { id: this.dartDeviceId, name: this.dartDeviceId, platform: '' };
      return { device, source: 'dart', supported: true };
    }
    return { source: 'none', supported: true };
  }

  /** The Flutter extension has no change event: ask it for its device id now and then. */
  private async pollDart(): Promise<void> {
    let id: string | undefined;
    try {
      const value = await vscode.commands.executeCommand<unknown>('flutter.getSelectedDeviceId');
      id = typeof value === 'string' && value ? value : undefined;
    } catch {
      id = undefined; // Flutter extension not installed or not active yet
    }
    if (id !== this.dartDeviceId) {
      this.dartDeviceId = id;
      this.changed.fire();
    }
  }

  selected(): SelectedDevice | undefined {
    return this.state.get<SelectedDevice>(SELECTED_KEY);
  }

  private async setSelected(device: SelectedDevice | undefined): Promise<void> {
    await this.state.update(SELECTED_KEY, device);
    this.changed.fire();
  }

  private flutterBin(): string | undefined {
    return findFlutter(vscode.workspace.getConfiguration('dart').get('flutterSdkPath'), process.env, os.homedir(), process.platform);
  }

  /** Re-reads devices and emulators; concurrent calls share the same run. */
  refresh(): Promise<void> {
    if (this.refreshing) { return this.refreshing; }
    const bin = this.flutterBin();
    if (!bin) {
      this.devices = [];
      this.emulators = [];
      return Promise.resolve();
    }
    this.refreshing = (async () => {
      const [devices, emulators] = await Promise.all([
        runFlutter(bin, ['devices', '--machine'], process.env).then(parseDevices, () => [] as FlutterDevice[]),
        runFlutter(bin, ['emulators'], process.env).then(parseEmulators, () => [] as FlutterEmulator[]),
      ]);
      this.devices = devices;
      this.emulators = emulators;
      // Keep the selection's display name fresh; drop nothing (the device may just be disconnected).
      const sel = this.selected();
      const match = sel && devices.find(d => d.id === sel.id);
      if (match && match.name !== sel.name) {
        await this.setSelected({ id: match.id, name: match.name, platform: match.platform });
      }
      this.changed.fire();
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  /** Warms the cache once, e.g. when a Flutter configuration is selected. */
  warmUp(): void {
    if (!this.devices && !this.refreshing) { void this.refresh(); }
    if (!this.dartTimer) {
      void this.pollDart();
      this.dartTimer = setInterval(() => { void this.pollDart(); }, DART_POLL_MS);
    }
  }

  /** Quick pick like IntelliJ's device combo: devices, emulators to open, refresh. */
  async pick(): Promise<void> {
    if (!this.flutterBin()) {
      void vscode.window.showErrorMessage(t('Flutter SDK not found. Set "dart.flutterSdkPath" or add flutter to PATH.'));
      return;
    }
    interface Item extends vscode.QuickPickItem { device?: FlutterDevice; emulator?: FlutterEmulator; action?: 'refresh' | 'default' }
    const qp = vscode.window.createQuickPick<Item>();
    qp.placeholder = t('Select the device to run Flutter configurations on');
    const build = () => {
      const sel = this.selected();
      const platforms = this.platforms();
      const supported = (p: string) => isDeviceSupported(p, platforms);
      const items: Item[] = [];
      items.push({ label: t('Devices'), kind: vscode.QuickPickItemKind.Separator });
      // Supported devices first; the rest are marked so they are not picked by mistake.
      const sorted = [...(this.devices ?? [])].sort((a, b) => Number(supported(b.platform)) - Number(supported(a.platform)));
      for (const d of sorted) {
        const ok = supported(d.platform);
        const parts = [d.sdk];
        if (!ok) { parts.push(t('not supported by this project')); }
        if (d.id === sel?.id) { parts.push(t('selected')); }
        items.push({
          label: `$(${ok ? deviceIcon(d.platform) : 'warning'}) ${d.name}`,
          description: parts.filter(Boolean).join(' · '),
          device: d,
        });
      }
      if (sel && this.devices && !this.devices.some(d => d.id === sel.id)) {
        items.push({ label: `$(debug-disconnect) ${sel.name}`, description: t('not connected'), device: { ...sel, emulator: false, sdk: '' } });
      }
      if (this.devices && !this.devices.length) {
        items.push({ label: `$(info) ${t('No devices found')}` });
      }
      if (this.emulators?.length) {
        items.push({ label: t('Emulators'), kind: vscode.QuickPickItemKind.Separator });
        for (const e of this.emulators) {
          const ok = supported(e.platform);
          items.push({
            label: `$(${ok ? 'play-circle' : 'warning'}) ${t('Open Emulator: {0}', e.name)}`,
            description: ok ? e.platform : `${e.platform} · ${t('not supported by this project')}`,
            emulator: e,
          });
        }
      }
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
      items.push({ label: `$(refresh) ${t('Refresh')}`, action: 'refresh' });
      const dart = this.dartDeviceId ? (this.devices?.find(d => d.id === this.dartDeviceId)?.name ?? this.dartDeviceId) : t('none');
      items.push({
        label: `$(extensions) ${t("Use the Flutter extension's device")}`,
        description: sel ? dart : `${dart} · ${t('selected')}`,
        action: 'default',
      });
      qp.items = items;
      const active = items.find(i => i.device && i.device.id === sel?.id);
      if (active) { qp.activeItems = [active]; }
    };
    const load = () => {
      qp.busy = true;
      void this.refresh().then(() => { qp.busy = false; build(); });
    };
    build();
    if (!this.devices) { load(); }
    qp.onDidAccept(async () => {
      const item = qp.selectedItems[0];
      if (!item) { return; }
      if (item.action === 'refresh') { load(); return; }
      qp.hide();
      if (item.action === 'default') {
        await this.setSelected(undefined);
      } else if (item.device) {
        if (!(await this.confirmUnsupported(item.device.platform, item.device.name))) { return; }
        await this.setSelected({ id: item.device.id, name: item.device.name, platform: item.device.platform });
      } else if (item.emulator) {
        if (!(await this.confirmUnsupported(item.emulator.platform, item.emulator.name))) { return; }
        await this.launchEmulator(item.emulator);
      }
    });
    qp.onDidHide(() => qp.dispose());
    qp.show();
  }

  /** Warns before picking a device whose platform folder is missing (the run would fail). */
  private async confirmUnsupported(platform: string, name: string): Promise<boolean> {
    if (this.isSupported(platform)) { return true; }
    const key = devicePlatformKey(platform) ?? platform;
    const pick = t('Select Anyway');
    const answer = await vscode.window.showWarningMessage(
      t('{0} is not supported by this project: it has no "{1}" folder, so running on it will fail.', name, key),
      { modal: true, detail: t('To add the platform run: flutter create --platforms={0} .', key) },
      pick,
    );
    return answer === pick;
  }

  private async launchEmulator(e: FlutterEmulator): Promise<void> {
    const bin = this.flutterBin();
    if (!bin) { return; }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('Starting emulator {0}…', e.name) },
      async () => {
        const before = new Set((this.devices ?? []).map(d => d.id));
        await runFlutter(bin, ['emulators', '--launch', e.id], process.env, 120000).catch(() => '');
        // The emulator takes a while to show up in `flutter devices`.
        for (let i = 0; i < 12; i++) {
          await new Promise(r => setTimeout(r, 5000));
          await this.refresh();
          const fresh = (this.devices ?? []).find(d => !before.has(d.id) && d.emulator);
          if (fresh) {
            await this.setSelected({ id: fresh.id, name: fresh.name, platform: fresh.platform });
            return;
          }
        }
        void vscode.window.showWarningMessage(t('The emulator did not appear in the device list yet. Pick it once it has started.'));
      },
    );
  }
}
